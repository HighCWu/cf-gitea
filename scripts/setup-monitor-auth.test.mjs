#!/usr/bin/env node
/* global setTimeout -- Node global (repo lint convention: no node env in the flat config); Buffer/console/process ride their node: imports */
/**
 * Self-tests for the monitor-platform auth/taxonomy/restore stack:
 * scripts/setup-monitor-auth.mjs (the one-time authorization tool) and the
 * monitor-platform battery's arms in scripts/deploy-probes.mjs (the four-way
 * taxonomy + the PERSISTED-RESTORE loop), per the scripts/verify-commit.test.mjs
 * convention (plain node runner, PASS/FAIL counters, exit non-zero on any
 * failure). Run: `node scripts/setup-monitor-auth.test.mjs`.
 *
 * Both tools are driven as child processes against a LOCAL STUB of the
 * Cloudflare API (a node:http server on 127.0.0.1; the MONITOR_CF_API_BASE /
 * MONITOR_AUTH_FILE seams) — NO real api.cloudflare.com traffic, NO real
 * credentials. The battery invocations deliberately pass NO --base-url /
 * --token-file: monitor-platform is the CF-API-only battery (its HTTP goes
 * to MONITOR_CF_API_BASE with the env/store auth, SPEC-0021 §4), so the
 * monitor-only CLI contract makes the pair optional and skips the PAT
 * preflight (nothing in that battery addresses the deployment) — scenarios
 * 5-13 double as the green/no-pair proof. The stub records every request
 * (method, path, bearer, body) so the asserts pin what actually crossed the
 * wire. The children are spawned ASYNC: the stub lives in THIS process, and
 * a synchronous spawn would block the parent event loop so the stub could
 * never answer.
 *
 *   1.  setup --help exits 0 offline;
 *   2.  setup --check with no store and no env → exit 3, "missing-auth";
 *   3.  setup --from-env against the stub validates both scopes (the dry
 *       write's 404-at-the-nil-uuid = the provisional write pass), persists
 *       the store at mode 0600, and NEVER echoes the tokens;
 *   4.  setup --check against the persisted store → exit 0; the failure
 *       classes are distinct: permission-denied (403) / api-unsupported
 *       (405) / failure (network) each exit 1 with their class word;
 *   5.  the battery with NO credentials — and NO --base-url/--token-file —
 *       reports missing-auth [warn] on all six checks and exits 0 (warn
 *       never fails — the battery convention);
 *   6.  the battery's GREEN /set loop via env auth: 6 pass, exit 0, the wire
 *       carries exactly TWO consumer PUTs — modify (saved−1) then restore
 *       (the saved value verbatim, preserved fields intact) — and the
 *       bearers match the env tokens;
 *   7.  the same green loop with credentials ONLY in the 0600 store (the
 *       battery's persisted-auth fallback);
 *   8.  a 500 on the modify PUT: the battery exits 1 AND the restore PUT
 *       still carries the saved value (a failed PUT may have landed);
 *   9.  SIGINT mid-loop: the guard performs the restore PUT before exiting
 *       130 (the one-shot held verify GET keeps the window open), and the
 *       snapshot is cleared after the verified restore;
 *  10.  SIGKILL mid-loop: nothing can run, so the PERSISTED-RESTORE snapshot
 *       SURVIVES on disk with the saved config + hand-restore recipe
 *       (no secrets in it) — the honest hard-death story;
 *  11.  permission-denied (403) on the consumer read → exit 1, the four
 *       downstream /set steps skip, the pprof arm still passes;
 *  12.  api-unsupported (405) on the consumer read → the honest [warn],
 *       exit 0 (warn never fails);
 *  13.  a dead API origin → the failure class, exit 1;
 *  14.  the CLI contract's other edge: a Worker-hitting battery (p0)
 *       WITHOUT the pair still exits 2 with the pointed usage error;
 *  15.  the pair stays ACCEPTED for monitor-only: a supplied token file is
 *       still validated (a 0644 file is refused, exit 2, value never
 *       echoed).
 *
 * The SIGKILL scenario intentionally leaves the battery's scratch dir (the
 * whole point is that its cleanup never ran); only the snapshot file is
 * removed. Run: `node scripts/setup-monitor-auth.test.mjs`.
 */

import { spawn } from "node:child_process";
import console from "node:console";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETUP = path.join(REPO, "scripts", "setup-monitor-auth.mjs");
const PROBES = path.join(REPO, "scripts", "deploy-probes.mjs");

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`PASS ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "setup-monitor-auth-selftest-"));
const PAT_FILE = path.join(scratchRoot, "pat-0600");
const ABSENT_STORE = path.join(scratchRoot, "absent-auth.json");
const STORE = path.join(scratchRoot, "monitor-auth.json");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const QUEUES_TOKEN = "queues-token-selftest-0123456789abcdef";
const PROFILE_TOKEN = "profile-token-selftest-0123456789abcdef";
const WORKER_NAME = "cf-gitea";
const CONSUMERS = JSON.stringify({ "repo-tasks": { queue_id: "repo-tasks", consumer_id: "deadbeefdeadbeefdeadbeefdeadbeef", declared_max_concurrency: 1 } });
const NIL = "00000000-0000-0000-0000-000000000000";

fs.writeFileSync(PAT_FILE, "cfg_01234567_ABCDEFGHJKLMNPQRSTUVWXYZ23456789\n", { mode: 0o600 });

/** The saved consumer config the stub starts from (max_concurrency 4 → the
 *  SAFE modify target is 3; the restore puts 4 back verbatim). */
const SAVED = {
  script_name: WORKER_NAME,
  type: "worker",
  dead_letter_queue: "repo-tasks-dlq",
  settings: { batch_size: 5, max_concurrency: 4, max_retries: 3, max_wait_time_ms: 500, retry_delay: 10 },
};

// ---------- the stub Cloudflare API ----------

/** A minimal gzipped pprof (perftools.profiles.Profile): string_table
 *  ["", "samples", "count"], sample_type ValueType→(samples, count),
 *  time_nanos + duration_nanos positive — exactly what the battery's
 *  analyzer pins. */
const varint = (n) => {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return bytes;
};
const varintField = (field, n) => [...varint(BigInt((field << 3) | 0)), ...varint(n)];
const lenDelim = (field, payload) => [...varint(BigInt((field << 3) | 2)), ...varint(payload.length), ...payload];
const buildPprofGzip = () => {
  const msg = [
    ...lenDelim(6, []), // string_table[0] = ""
    ...lenDelim(6, [...Buffer.from("samples")]),
    ...lenDelim(6, [...Buffer.from("count")]),
    ...lenDelim(1, [...varintField(1, 1), ...varintField(2, 2)]), // sample_type → samples/count
    ...varintField(9, 1_690_000_000_000), // time_nanos
    ...varintField(10, 1_000_000_000), // duration_nanos → ≈ 1000 ms
  ];
  return gzipSync(Buffer.from(msg));
};
const PPROF_GZ = buildPprofGzip();

const CONSUMER_RE = /^\/client\/v4\/accounts\/[^/]+\/queues\/[^/]+\/consumers\/[^/]+$/;

const startStub = () => new Promise((resolve) => {
  const state = {
    consumerGetStatus: 200,
    scriptsStatus: 200,
    modifyPutStatus: 200,
    holdAfterFirstPut: false, // the signal scenarios: hold ONE GET after the modify PUT (the SIGINT window)
    holdOneGet: false, // armed by the accepted first PUT when holdAfterFirstPut is set
    current: JSON.parse(JSON.stringify(SAVED)),
    requests: [], // { method, path, auth, body }
  };
  const respondJson = (res, status, obj) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const envelope = (result) => ({ success: true, errors: [], messages: [], result });
  const errorEnvelope = (code, message) => ({ success: false, errors: [{ code, message }], messages: [] });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const record = { method: req.method, path: req.url, auth: req.headers.authorization ?? null, body };
      state.requests.push(record);
      // NOTE: no /api/v1/user route — the monitor-only contract skips the PAT
      // preflight (nothing in the battery addresses the deployment), so the
      // stub never sees a Worker-origin request.
      if (CONSUMER_RE.test(req.url) && req.url.includes(NIL)) {
        // the setup tool's dry-write target: authz ran, nothing exists there
        respondJson(res, 404, errorEnvelope(10001, "queue not found"));
        return;
      }
      if (CONSUMER_RE.test(req.url) && req.method === "GET") {
        const respond = () => {
          if (state.consumerGetStatus !== 200) respondJson(res, state.consumerGetStatus, errorEnvelope(9106, "unauthorized to access requested resource"));
          else respondJson(res, 200, envelope(state.current));
        };
        if (state.holdOneGet) {
          // one-shot: keep the verify read in flight so the signal lands
          // mid-loop (the window the guard exists for)
          state.holdOneGet = false;
          setTimeout(respond, 5_000);
          return;
        }
        respond();
        return;
      }
      if (CONSUMER_RE.test(req.url) && req.method === "PUT") {
        const consumerPuts = state.requests.filter((r) => r.method === "PUT" && CONSUMER_RE.test(r.path) && !r.path.includes(NIL));
        if (consumerPuts.length === 1 && state.modifyPutStatus !== 200) {
          respondJson(res, state.modifyPutStatus, errorEnvelope(1000, "modify rejected by the scenario"));
          return;
        }
        if (consumerPuts.length === 1 && state.holdAfterFirstPut) state.holdOneGet = true; // open the signal window
        state.current = JSON.parse(body); // the accepted PUT becomes the effective config
        respondJson(res, 200, envelope(state.current));
        return;
      }
      if (/^\/client\/v4\/accounts\/[^/]+\/workers\/scripts$/.test(req.url)) {
        if (state.scriptsStatus !== 200) respondJson(res, state.scriptsStatus, errorEnvelope(9106, "unauthorized to access requested resource"));
        else respondJson(res, 200, envelope([{ id: WORKER_NAME, name: WORKER_NAME, created_on: "2026-01-01T00:00:00Z" }]));
        return;
      }
      if (/^\/client\/v4\/accounts\/[^/]+\/workers\/workers\/[^/]+\/versions\/[^/]+\/profile$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": PPROF_GZ.length });
        res.end(PPROF_GZ);
        return;
      }
      respondJson(res, 404, errorEnvelope(1000, "stub has no route for this path"));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}` }));
});

// ---------- runners (ASYNC spawn — the stub shares this process's loop) ----------

const cleanEnv = (over = {}) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  LANG: "C",
  LC_ALL: "C",
  CLOUDFLARE_ACCOUNT_ID: "",
  CLOUDFLARE_QUEUES_TOKEN: "",
  CLOUDFLARE_PROFILE_TOKEN: "",
  MONITOR_QUEUE_CONSUMERS: "",
  MONITOR_WORKER_NAME: "",
  MONITOR_AUTH_FILE: ABSENT_STORE,
  ...over,
});

const runNode = (scriptPath, args, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [scriptPath, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  child.on("error", (err) => resolve({ status: -1, stdout, stderr: `${stderr}${err.message}` }));
  child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
});

const runSetup = async (args, over = {}) => runNode(SETUP, args, cleanEnv(over));

/** The battery args carry NO --base-url/--token-file: the monitor-only CLI
 *  contract makes the pair optional (the battery's HTTP is the platform API
 *  via MONITOR_CF_API_BASE; the PAT preflight is skipped). --user stays to
 *  pin that the arg keeps parsing for a monitor-only run. */
const batteryArgs = () => ["monitor-platform", "--user", "p0probe", "--json"];
const runBattery = async (stub, over = {}) =>
  runNode(PROBES, batteryArgs(), cleanEnv({ MONITOR_CF_API_BASE: stub.origin, ...over }));

const batteryEnvAuth = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_QUEUES_TOKEN: QUEUES_TOKEN,
  CLOUDFLARE_PROFILE_TOKEN: PROFILE_TOKEN,
  MONITOR_QUEUE_CONSUMERS: CONSUMERS,
  MONITOR_WORKER_NAME: WORKER_NAME,
};

const writeStore = (mode = 0o600) => {
  fs.writeFileSync(STORE, `${JSON.stringify({
    version: 1,
    account_id: ACCOUNT,
    queues_token: QUEUES_TOKEN,
    profile_token: PROFILE_TOKEN,
    worker_name: WORKER_NAME,
    queue_consumers: JSON.parse(CONSUMERS),
  }, null, 2)}\n`, { mode });
};

const consumerRequests = (stub, method) =>
  stub.state.requests.filter((r) => r.method === method && CONSUMER_RE.test(r.path) && !r.path.includes(NIL));

const putBodies = (stub) => consumerRequests(stub, "PUT").map((r) => JSON.parse(r.body));

// ---------- 1-4: the setup tool ----------

const help = await runSetup(["--help"]);
check("setup --help exits 0 offline", help.status === 0, `exit ${help.status}: ${(help.stderr || "").slice(0, 200)}`);

const missingAuth = await runSetup(["--check"]);
check(
  "setup --check without any credential reports missing-auth with exit 3 (the distinct class)",
  missingAuth.status === 3 && missingAuth.stdout.includes("missing-auth"),
  `exit ${missingAuth.status}: ${missingAuth.stdout.slice(0, 200)}`,
);

const stub1 = await startStub();
const fromEnv = await runSetup(["--from-env", "--file", STORE], {
  MONITOR_CF_API_BASE: stub1.origin,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  CLOUDFLARE_QUEUES_TOKEN: QUEUES_TOKEN,
  CLOUDFLARE_PROFILE_TOKEN: PROFILE_TOKEN,
  MONITOR_QUEUE_CONSUMERS: CONSUMERS,
  MONITOR_WORKER_NAME: WORKER_NAME,
});
const storeMode = fs.existsSync(STORE) ? fs.statSync(STORE).mode & 0o777 : null;
const storeDoc = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, "utf8")) : null;
check("setup --from-env exits 0 with both scopes ok", fromEnv.status === 0, `exit ${fromEnv.status}: ${(fromEnv.stdout + fromEnv.stderr).slice(0, 300)}`);
check("setup --from-env persists the store at mode 0600", storeMode === 0o600, `mode ${storeMode === null ? "<absent>" : storeMode.toString(8)}`);
check(
  "the store carries the tokens + the parsed allowlist",
  storeDoc !== null && storeDoc.queues_token === QUEUES_TOKEN && storeDoc.profile_token === PROFILE_TOKEN && storeDoc.account_id === ACCOUNT
    && storeDoc.queue_consumers["repo-tasks"].queue_id === "repo-tasks" && storeDoc.worker_name === WORKER_NAME,
  JSON.stringify(storeDoc ?? {}).slice(0, 200),
);
check(
  "the dry-write probe hit the nil-uuid queue and nothing else was written",
  stub1.state.requests.some((r) => r.method === "PUT" && r.path.includes(NIL)) && consumerRequests(stub1, "PUT").length === 0,
  `nil-uuid PUTs: ${stub1.state.requests.filter((r) => r.method === "PUT").length}`,
);
check(
  "the setup output never echoes a token",
  !fromEnv.stdout.includes(QUEUES_TOKEN) && !fromEnv.stdout.includes(PROFILE_TOKEN) && !fromEnv.stderr.includes(QUEUES_TOKEN),
  "a token leaked into the output",
);
check(
  "the provisional write pass is labeled as such",
  fromEnv.stdout.includes("PROVISIONAL") || fromEnv.stdout.includes("provisional"),
  fromEnv.stdout.slice(0, 400),
);

const checkOk = await runSetup(["--check", "--file", STORE], { MONITOR_CF_API_BASE: stub1.origin });
check("setup --check against the persisted store exits 0", checkOk.status === 0, `exit ${checkOk.status}: ${(checkOk.stdout + checkOk.stderr).slice(0, 300)}`);

stub1.state.consumerGetStatus = 403;
const checkDenied = await runSetup(["--check", "--file", STORE], { MONITOR_CF_API_BASE: stub1.origin });
check(
  "a 403 read answers the permission-denied class (exit 1, never api-unsupported wording)",
  checkDenied.status === 1 && checkDenied.stdout.includes("permission-denied") && !checkDenied.stdout.includes("api-unsupported"),
  `exit ${checkDenied.status}: ${checkDenied.stdout.slice(0, 300)}`,
);

stub1.state.consumerGetStatus = 200;
stub1.state.scriptsStatus = 405;
const checkUnsupported = await runSetup(["--check", "--file", STORE], { MONITOR_CF_API_BASE: stub1.origin });
check(
  "a 405 scripts list answers the api-unsupported class (exit 1)",
  checkUnsupported.status === 1 && checkUnsupported.stdout.includes("api-unsupported"),
  `exit ${checkUnsupported.status}: ${checkUnsupported.stdout.slice(0, 300)}`,
);
await new Promise((resolve) => stub1.server.close(resolve));

const deadOrigin = await startStub();
await new Promise((resolve) => deadOrigin.server.close(resolve)); // the ORIGIN existed; nothing listens now
const checkNetwork = await runSetup(["--check", "--file", STORE], { MONITOR_CF_API_BASE: deadOrigin.origin });
check(
  "a dead origin answers the failure class (exit 1, distinct from permission-denied)",
  checkNetwork.status === 1 && checkNetwork.stdout.includes("failure") && !checkNetwork.stdout.includes("permission-denied"),
  `exit ${checkNetwork.status}: ${checkNetwork.stdout.slice(0, 300)}`,
);

// ---------- 5: missing-auth battery ----------

const stub2 = await startStub();
const bMissing = await runBattery(stub2);
const sMissing = JSON.parse(bMissing.stdout || "{}");
check(
  "battery with no credentials: all six checks warn missing-auth and the run exits 0 (warn never fails)",
  bMissing.status === 0 && sMissing.summary?.warn === 6 && sMissing.summary?.fail === 0
    && (sMissing.checks ?? []).every((c) => c.detail.startsWith("missing-auth")),
  `exit ${bMissing.status} summary ${JSON.stringify(sMissing.summary ?? {})}`,
);
await new Promise((resolve) => stub2.server.close(resolve));

// ---------- 6: the green /set loop via env auth ----------

const stub3 = await startStub();
const bGreen = await runBattery(stub3, batteryEnvAuth);
const sGreen = JSON.parse(bGreen.stdout || "{}");
const greenPuts = putBodies(stub3);
check(
  "green battery: 6 pass, exit 0",
  bGreen.status === 0 && sGreen.summary?.pass === 6 && sGreen.summary?.fail === 0,
  `exit ${bGreen.status} summary ${JSON.stringify(sGreen.summary ?? {})} stderr ${bGreen.stderr.slice(-300)}`,
);
check(
  "the wire carried exactly TWO consumer PUTs: modify (saved−1) then restore (the saved value verbatim)",
  greenPuts.length === 2 && greenPuts[0]?.settings.max_concurrency === 3 && greenPuts[1]?.settings.max_concurrency === 4,
  `PUT bodies: ${JSON.stringify(greenPuts.map((b) => b.settings))}`,
);
check(
  "the restore PUT preserved the untouched fields verbatim (the wholesale-PUT rule)",
  greenPuts[1] !== undefined && greenPuts[1].script_name === SAVED.script_name && greenPuts[1].dead_letter_queue === SAVED.dead_letter_queue
    && greenPuts[1].settings.batch_size === 5 && greenPuts[1].settings.max_retries === 3 && greenPuts[1].settings.max_wait_time_ms === 500 && greenPuts[1].settings.retry_delay === 10,
  JSON.stringify(greenPuts[1] ?? {}),
);
check(
  "the consumer bearer is the Queues token and the profile bearer the Profile token",
  consumerRequests(stub3, "GET").every((r) => r.auth === `Bearer ${QUEUES_TOKEN}`)
    && stub3.state.requests.some((r) => r.path.includes("/profile") && r.auth === `Bearer ${PROFILE_TOKEN}`),
  consumerRequests(stub3, "GET").map((r) => r.auth).join(","),
);
await new Promise((resolve) => stub3.server.close(resolve));

// ---------- 7: the green loop via the persisted 0600 store ----------

writeStore(0o600);
const stub4 = await startStub();
const bFile = await runBattery(stub4, { MONITOR_AUTH_FILE: STORE });
const sFile = JSON.parse(bFile.stdout || "{}");
check(
  "green battery on the persisted store: 6 pass, exit 0, the restore PUT carries the saved value",
  bFile.status === 0 && sFile.summary?.pass === 6 && putBodies(stub4).at(-1)?.settings.max_concurrency === 4,
  `exit ${bFile.status} summary ${JSON.stringify(sFile.summary ?? {})} stderr ${bFile.stderr.slice(-300)}`,
);
check(
  "the battery's bearers come from the STORE tokens (env absent)",
  consumerRequests(stub4, "GET").every((r) => r.auth === `Bearer ${QUEUES_TOKEN}`),
  consumerRequests(stub4, "GET").map((r) => r.auth).join(","),
);
await new Promise((resolve) => stub4.server.close(resolve));
fs.rmSync(STORE, { force: true });

// ---------- 8: modify PUT 500 — the restore still runs ----------

const stub5 = await startStub();
stub5.state.modifyPutStatus = 500;
const bRed = await runBattery(stub5, batteryEnvAuth);
const sRed = JSON.parse(bRed.stdout || "{}");
const redPuts = putBodies(stub5);
const redChecks = Object.fromEntries((sRed.checks ?? []).map((c) => [c.id, c.status]));
check(
  "a 500 modify: the battery exits 1 with the modify + verify-effective reds",
  bRed.status === 1 && sRed.summary?.fail === 2 && redChecks["mon-qset-modify-put"] === "fail" && redChecks["mon-qset-verify-effective"] === "fail",
  `exit ${bRed.status} summary ${JSON.stringify(sRed.summary ?? {})}`,
);
check(
  "a 500 modify: the restore PUT STILL carried the saved value (a failed PUT may have landed)",
  redPuts.length === 2 && redPuts[1]?.settings.max_concurrency === 4 && redChecks["mon-qset-restore-put"] === "pass",
  `PUT bodies: ${JSON.stringify(redPuts.map((b) => b.settings))}`,
);
await new Promise((resolve) => stub5.server.close(resolve));

// ---------- 9-10: the signal paths (the one-shot held verify GET opens the window) ----------

const runSigScenario = async (signal) => {
  const stub = await startStub();
  stub.state.holdAfterFirstPut = true;
  const child = spawn(process.execPath, [PROBES, ...batteryArgs()], {
    env: cleanEnv({ MONITOR_CF_API_BASE: stub.origin, ...batteryEnvAuth }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  // the modify PUT completing is the earliest point where the guard is
  // installed and a mutation may be outstanding; the stub holds the NEXT
  // verify GET for 5 s, so this wait is deterministic
  const deadline = Date.now() + 20_000;
  while (!err.includes("mon-qset-modify-put") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  child.kill(signal);
  const exit = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve({ code: null, sig: null, timeout: true }), 30_000))]);
  return { stub, exit, out, err };
};

{
  const { stub, exit, err } = await runSigScenario("SIGINT");
  const puts = putBodies(stub);
  check(
    "SIGINT mid-loop: the guard restores the saved config and exits 130",
    exit.code === 130 && puts.length === 2 && puts[1]?.settings.max_concurrency === 4,
    `exit ${JSON.stringify(exit)} PUT bodies: ${JSON.stringify(puts.map((b) => b.settings))}`,
  );
  check(
    "SIGINT mid-loop: the guard line names PERSISTED-RESTORE",
    err.includes("monitor-restore-guard"),
    err.slice(-300),
  );
  await new Promise((resolve) => stub.server.close(resolve));
}

{
  const { stub, exit, err } = await runSigScenario("SIGKILL");
  const puts = putBodies(stub);
  const snapMatch = err.match(/PERSISTED-RESTORE snapshot: (\S+\.json)/);
  const snapPath = snapMatch?.[1] ?? null;
  const snap = snapPath !== null && fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, "utf8")) : null;
  check(
    "SIGKILL mid-loop: nothing ran after the kill (exactly ONE consumer PUT, killed by the signal)",
    exit.code === null && exit.sig === "SIGKILL" && puts.length === 1,
    `exit ${JSON.stringify(exit)} PUTs ${puts.length}`,
  );
  check(
    "SIGKILL mid-loop: the snapshot SURVIVES on disk with the saved config (hand-restore record, no secrets)",
    snap !== null && snap.saved_consumer?.settings?.max_concurrency === 4 && snap.restored === false
      && typeof snap.restore_recipe === "string" && snap.restore_recipe.startsWith("PUT ")
      && !JSON.stringify(snap).includes(QUEUES_TOKEN) && !JSON.stringify(snap).includes(PROFILE_TOKEN),
    `snapshot: ${JSON.stringify(snap)?.slice(0, 200)}`,
  );
  if (snapPath !== null) fs.rmSync(snapPath, { force: true });
  await new Promise((resolve) => stub.server.close(resolve));
}

// ---------- 11-13: the remaining taxonomy classes on the battery ----------

{
  const stub = await startStub();
  stub.state.consumerGetStatus = 403;
  const res = await runBattery(stub, batteryEnvAuth);
  const summary = JSON.parse(res.stdout || "{}");
  const byId = Object.fromEntries((summary.checks ?? []).map((c) => [c.id, c]));
  check(
    "battery permission-denied: read fails, the four downstream steps skip, pprof still passes, exit 1",
    res.status === 1 && summary.summary?.fail === 1 && summary.summary?.skip === 4 && summary.summary?.pass === 1
      && byId["mon-qset-consumer-read"]?.detail.includes("permission-denied") && !byId["mon-qset-consumer-read"]?.detail.includes("api-unsupported"),
    `exit ${res.status} summary ${JSON.stringify(summary.summary ?? {})}`,
  );
  await new Promise((resolve) => stub.server.close(resolve));
}
{
  const stub = await startStub();
  stub.state.consumerGetStatus = 405;
  const res = await runBattery(stub, batteryEnvAuth);
  const summary = JSON.parse(res.stdout || "{}");
  const byId = Object.fromEntries((summary.checks ?? []).map((c) => [c.id, c]));
  check(
    "battery api-unsupported: the read warns honestly (never a pass), the loop never opened, exit 0",
    res.status === 0 && summary.summary?.warn === 1 && summary.summary?.skip === 4 && summary.summary?.pass === 1
      && byId["mon-qset-consumer-read"]?.detail.includes("api-unsupported"),
    `exit ${res.status} summary ${JSON.stringify(summary.summary ?? {})}`,
  );
  await new Promise((resolve) => stub.server.close(resolve));
}
{
  // NO --base-url at all (the monitor-only contract — the PAT preflight is
  // skipped, so nothing dials a Worker origin) and the PLATFORM origin is
  // dead (nothing listens on :9), which is the class under test
  const res = await runNode(PROBES, batteryArgs(), cleanEnv({ MONITOR_CF_API_BASE: "http://127.0.0.1:9", ...batteryEnvAuth }));
  const summary = JSON.parse(res.stdout || "{}");
  const byId = Object.fromEntries((summary.checks ?? []).map((c) => [c.id, c]));
  check(
    "battery network failure: the failure class fails both arms, exit 1",
    res.status === 1 && summary.summary?.fail === 2 && byId["mon-qset-consumer-read"]?.detail.startsWith("reading the consumer: failure"),
    `exit ${res.status} summary ${JSON.stringify(summary.summary ?? {})}`,
  );
}

// ---------- 14-15: the CLI contract (the CF-API-only monitor-only selection) ----------

{
  // a Worker-hitting battery without the pair still exits 2 with the pointed
  // usage error BEFORE any request fires
  const res = await runNode(PROBES, ["p0", "--json"], cleanEnv());
  check(
    "a Worker-hitting battery (p0) without --base-url/--token-file exits 2 with the pointed usage error",
    res.status === 2 && res.stderr.includes("--base-url is required") && res.stderr.includes("monitor-only monitor-platform"),
    `exit ${res.status}: ${res.stderr.slice(0, 200)}`,
  );
}
{
  // the pair stays ACCEPTED for monitor-only: a supplied token file is
  // validated (0600, mint shape) + scrubbed and the run still goes green
  const stub = await startStub();
  const res = await runNode(PROBES, [...batteryArgs(), "--token-file", PAT_FILE], cleanEnv({ MONITOR_CF_API_BASE: stub.origin, ...batteryEnvAuth }));
  const summary = JSON.parse(res.stdout || "{}");
  check(
    "monitor-only with a SUPPLIED valid token file: validated + accepted, the run stays green",
    res.status === 0 && summary.summary?.pass === 6 && summary.summary?.fail === 0,
    `exit ${res.status} summary ${JSON.stringify(summary.summary ?? {})} stderr ${res.stderr.slice(-200)}`,
  );
  await new Promise((resolve) => stub.server.close(resolve));
}
{
  // ...and a LOOSE supplied file is still refused before any request (the
  // 0600 convention holds even where the file is optional)
  const loosePat = path.join(scratchRoot, "pat-0644");
  fs.writeFileSync(loosePat, "cfg_01234567_ABCDEFGHJKLMNPQRSTUVWXYZ23456789\n", { mode: 0o644 });
  const res = await runNode(PROBES, [...batteryArgs(), "--token-file", loosePat], cleanEnv());
  check(
    "monitor-only with a SUPPLIED loose-mode token file: refused exit 2 (0600 convention), value never echoed",
    res.status === 2 && res.stderr.includes("must be 0600") && !res.stderr.includes("cfg_"),
    `exit ${res.status}: ${res.stderr.slice(0, 200)}`,
  );
}

// ---------- summary ----------

fs.rmSync(scratchRoot, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
