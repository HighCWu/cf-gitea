#!/usr/bin/env node
/**
 * deploy-probes.mjs — the REDEPLOY probe battery toolkit (zero npm deps, Node >= 22).
 *
 *   node scripts/deploy-probes.mjs <battery> --base-url <url> --token-file <path> [options]
 *   node scripts/deploy-probes.mjs <battery> --dry-run
 *   node scripts/deploy-probes.mjs --help
 *
 * One committed home for the RECURRING REDEPLOY verification probes, so every
 * redeploy wave runs the same probes with less drift instead of hand-rolling
 * them per deploy. Batteries (all take --base-url + a PAT file, except the
 * D1-only cleanup-audit, which takes neither — REDEPLOY15 friction (a)):
 *
 *   p0             The P0 shallow trio + privacy tail against the standing
 *                  fixture repo (`<user>/p0-shallow` by default).
 *   registry       The tombstone / registry sweep: create -> immediate
 *                  anonymous advert -> rename -> carry -> delete -> the very
 *                  next anonymous ls-remote must be dead at t+0.
 *   generate-e2e   Template -> real push -> PATCH template -> generate -> 201
 *                  + empty:false -> refs carried at the identical tip ->
 *                  contents API round-trip.
 *   forkpr-e2e     Base -> fork (202) -> push a fork branch -> PR with the
 *                  cross-repo head `owner:branch` -> 201 + head chain.
 *   mirror         The push-mirror credential-free arms: the registration-time
 *                  SSRF egress gate refusing a loopback target at the door,
 *                  then the .invalid lifecycle — gate-passing unreachable
 *                  target -> 200 -> sync trigger -> the failed sync's settle
 *                  shape -> DELETE 204.
 *   ui-login       The login-cookie methodology probe: anonymous labels page
 *                  hides the writer form, POST /login 303 + gitea_session,
 *                  cookie view renders the owner form.
 *   cleanup-audit  The post-run D1 count shapes (wrangler d1 execute; see the
 *                  audit SQL below for the exact tables).
 *   all            Every battery in the order above (audit last).
 *
 * Conventions (mirroring scripts/deploy-smoke.mjs):
 *   - PAT handling: the token is MINTED PER RUN by the operator (e.g.
 *     scripts/bootstrap-admin.mjs --remote) into a temp file with mode 0600;
 *     --token-file points at it. The file mode is enforced (a looser file is
 *     refused before any request) and the token is never echoed — every
 *     progress line, detail, and the JSON summary are scrubbed against it
 *     (and against the login session cookie).
 *   - Output: `  [pass] <id> (<ms> ms) — <detail>` progress lines (the same
 *     shape the evidence blocks quote) + a final JSON summary on stdout;
 *     exit code is non-zero iff any check FAILS (warn/skip never fail).
 *
 * Canonical expectations ported from the latest evidence block
 * (docs/design/p0-evidence.md, REDEPLOY13 2026-10-26, ~lines 1507-1697;
 * tombstone/registry arms from the REDEPLOY12 t+0 proof ~1395-1417 and the
 * REDEPLOY10 registry re-probe ~991-1030):
 *   - shallow-since / shallow-exclude clones exit 128 with the server text
 *     naming 'deepen-since' / 'deepen-not'; depth=1 clones exit 0 with
 *     .git/shallow == the HEAD tip, 1 commit, fsck clean (fixture tip
 *     502abd2d… on the standing production repo; pin with --fixture-oid).
 *   - the standing fixture is PRIVATE: anonymous API GET 404, anonymous
 *     info/refs 401 Basic challenge, anonymous web page 404.
 *   - after a registry tombstone delete, the VERY NEXT anonymous ls-remote on
 *     the renamed name answers 128 `repository not found` — no sleep.
 *   - generate answers 201 with "empty":false in the response body; both
 *     carried refs sit at the identical tip; contents API decodes verbatim.
 *     The generated repo's GIT WIRE is a carried OPEN ISSUE (clone 500 /
 *     push `missing necessary objects`): gen-generated-clone is reported as
 *     a warn until the engine read path lands — pass
 *     --strict-generated-clone to promote it to a hard assert.
 *   - push mirror (REDEPLOY13 ~1600-1610, credential-free arms): registering
 *     the loopback target https://127.0.0.1:9/dummy-unreachable.git answers
 *     401 "Permission denied" AT THE DOOR (the egress screen; lax/strict
 *     MIRROR_ALLOWED_HOST_LIST) and writes nothing; the gate-passing
 *     https://pmir-<hex>.invalid target answers 200 with the fresh-row wire
 *     (last_error "", last_update null, interval 8h0m0s, sync_on_commit
 *     false, remote_name remote_mirror_<10 alnum>) -> push_mirrors-sync 200
 *     enqueues -> the consumer's failed attempt settles last_error naming
 *     the target's info/refs advertisement URL (canonical production text:
 *     "mirror target responded 530 for info/refs advertisement
 *     [<addr>/info/refs?service=git-receive-pack]"; local dev's fetch
 *     failure reads "request failed" with the same bracketed URL) with
 *     sync_state back to 'idle' and next_sync_at=0 (row re-read via wrangler
 *     d1, --d1-scope) -> DELETE 204 and the list back to [].
 *   - login: POST /login form-urlencoded user_name + password=<PAT> answers
 *     303 with a gitea_session cookie; the labels page then shows the
 *     writer's "New Label" form (3 occurrences canonically, +the
 *     small-menu-items nav) where the anonymous render shows none.
 *   - cleanup audit: repositories of the probe user == 1 (p0-shallow,
 *     intentionally live), status='creating' == 0, "action" == 0 (the
 *     389da18 delete sweep — no hand-sweep), stars == 0, push_mirrors == 0,
 *     protected_branches == 0, repo_redirects == 0, user_blocking == 0,
 *     personal_access_tokens == 1 (the standing bootstrap PAT).
 *
 * This file deliberately does NOT touch docs/design/p0-evidence.md (it is
 * REDEPLOY14's in-flight document); the conventions note lives here.
 */
/* global fetch, AbortSignal, URLSearchParams -- Web globals provided by Node >= 22 (no node: module exports them) */
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const DEFAULT_USER = "p0probe";
const BATTERY_NAMES = ["p0", "registry", "generate-e2e", "forkpr-e2e", "mirror", "ui-login", "cleanup-audit", "all"];
/** Batteries that make NO HTTP calls (they read D1 via wrangler only):
 *  --base-url and --token-file are OPTIONAL for these (REDEPLOY15 friction
 *  (a): the D1-only audit still demanded a PAT, forcing a scratch-mint +
 *  delete dance). A missing token errors only when a selected battery
 *  actually needs one; a SUPPLIED token file is still validated + scrubbed. */
const D1_ONLY_BATTERIES = new Set(["cleanup-audit"]);

/** Canonical fixture tip on the standing production repo (p0probe/p0-shallow). */
const CANONICAL_FIXTURE_OID = "502abd2d5561536873088528a9f57f02cd1633e1";

// ---------- CLI ----------

const parseArgs = (argv) => {
  const opts = {
    battery: null, baseUrl: null, tokenFile: null, user: DEFAULT_USER,
    json: false, dryRun: false, help: false, timeoutMs: 20_000,
    trials: 3, fixtureRepo: "p0-shallow", fixtureOid: null, newLabelCount: 3,
    strictGeneratedClone: false, d1Scope: "remote", expectOwnerRepos: 1, expectTokens: 1,
    mirrorSettleMs: 30_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--token-file") opts.tokenFile = argv[++i];
    else if (a === "--user") opts.user = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--trials") opts.trials = Number(argv[++i]);
    else if (a === "--fixture-repo") opts.fixtureRepo = argv[++i];
    else if (a === "--fixture-oid") opts.fixtureOid = argv[++i];
    else if (a === "--new-label-count") opts.newLabelCount = Number(argv[++i]);
    else if (a === "--strict-generated-clone") opts.strictGeneratedClone = true;
    else if (a === "--d1-scope") opts.d1Scope = argv[++i];
    else if (a === "--mirror-settle-ms") opts.mirrorSettleMs = Number(argv[++i]);
    else if (a === "--expect-owner-repos") opts.expectOwnerRepos = Number(argv[++i]);
    else if (a === "--expect-tokens") opts.expectTokens = Number(argv[++i]);
    else if (opts.battery === null && !a.startsWith("--")) {
      if (!BATTERY_NAMES.includes(a)) throw new Error(`unknown battery: ${a} (known: ${BATTERY_NAMES.join(", ")})`);
      opts.battery = a;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (opts.battery === null && opts.dryRun) opts.battery = "all"; // a bare --dry-run plans every battery
  if (opts.battery === null) throw new Error(`a battery is required (one of: ${BATTERY_NAMES.join(", ")})`);
  // REDEPLOY15 friction (a): the D1-only batteries take neither --base-url nor
  // --token-file; a missing token errors only when the run makes HTTP calls.
  const needsHttp = opts.battery === "all" || !D1_ONLY_BATTERIES.has(opts.battery);
  if (!opts.dryRun && needsHttp) {
    if (!opts.baseUrl) throw new Error("--base-url is required (the selected battery makes HTTP calls; the D1-only cleanup-audit takes none)");
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error(`--base-url must be an http(s) URL: ${opts.baseUrl}`);
    if (!opts.tokenFile) throw new Error("--token-file is required (mint a per-run PAT into a 0600 temp file; the D1-only cleanup-audit runs without one)");
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(opts.user)) throw new Error("--user must be 1-64 chars of [a-zA-Z0-9_.-]");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isInteger(opts.trials) || opts.trials < 1 || opts.trials > 10) throw new Error("--trials must be 1-10");
  if (opts.d1Scope !== "remote" && opts.d1Scope !== "local") throw new Error("--d1-scope must be remote or local");
  if (!Number.isFinite(opts.mirrorSettleMs) || opts.mirrorSettleMs <= 0) throw new Error("--mirror-settle-ms must be a positive number of milliseconds");
  opts.baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, "") : null;
  return opts;
};

const usage = () =>
  "usage: node scripts/deploy-probes.mjs <battery> --base-url <url> --token-file <path>\n" +
  "                                     [--user p0probe] [--timeout-ms <n>] [--json]\n" +
  "                                     (D1-only cleanup-audit: --base-url/--token-file optional)\n" +
  "       node scripts/deploy-probes.mjs <battery> --dry-run   (prints every probe + its canonical expectation)\n" +
  "\n" +
  `batteries: ${BATTERY_NAMES.join(", ")}\n` +
  "battery options:\n" +
  "  p0:            --fixture-repo p0-shallow  --fixture-oid <sha> (pin the standing tip)\n" +
  "  registry:      --trials <1-10>            (default 3, one tombstone lifecycle each)\n" +
  "  generate-e2e:  --strict-generated-clone   (promote the carried git-wire warn to a hard assert)\n" +
  "  forkpr-e2e:    (no extra options)\n" +
  "  mirror:        --mirror-settle-ms <ms>    (sync-settle budget, default 30000; the row-settle arm reuses --d1-scope)\n" +
  "  ui-login:      --new-label-count <n>      (canonical 3 writer-form occurrences)\n" +
  "  cleanup-audit: --d1-scope remote|local  --expect-owner-repos <n> (1)  --expect-tokens <n> (1)";

// ---------- plumbing ----------

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // CLI errors exit 2 with a one-line message (no stack) — the documented shape.
  console.error(`deploy-probes: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (opts.help) {
  console.log(usage());
  process.exit(0);
}
const jsonMode = opts.json;
const log = (...args) => (jsonMode ? console.error(...args) : console.log(...args));
const startedAt = new Date();

/** The per-run PAT, assigned by loadToken() before any request is made. */
let TOKEN = "";

const results = [];
const leftBehind = [];
const secrets = []; // the PAT + the login session cookie — scrubbed from every line
const scrub = (text) => {
  let s = text;
  for (const sec of secrets) s = s.split(sec).join("***");
  return s;
};

/** Every fetch is timeout-guarded (AbortSignal); redirects are surfaced, not followed. */
const fetchT = (url, init = {}) =>
  fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(opts.timeoutMs) });

/** Authenticated JSON call against the /api/v1 surface (`Authorization: token <PAT>`). */
const api = async (apiPath, { method = "GET", body, auth = true, cookie } = {}) => {
  const headers = {};
  if (auth) headers.authorization = `token ${TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetchT(`${opts.baseUrl}/api/v1${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body — the caller asserts on status */ }
  return { status: res.status, text, json, headers: res.headers };
};

/** execFile as a promise; never throws — the caller decides what failure means. */
const run = (cmd, args, { cwd, timeoutMs = 120_000, env } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "", killed: Boolean(err?.killed) });
    });
  });

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C", LANG: "C" };
/** git with the credential out of the URL — auth rides `http.extraHeader` (the
 *  evidence methodology; execFile argv needs no shell quoting for the space). */
const git = (args, cwd, { auth = false } = {}) =>
  run("git", [
    "-c", "credential.helper=",
    ...(auth ? ["-c", `http.extraHeader=Authorization: token ${TOKEN}`] : []),
    ...args,
  ], { cwd, env: GIT_ENV });

const gitUrl = (owner, repo) => `${opts.baseUrl}/${owner}/${repo}.git`;

/** ls-remote → {ok, code, stderr, refs: Map(ref → oid)}. */
const lsRemote = async (url, { auth = false } = {}) => {
  const r = await git(["ls-remote", url], undefined, { auth });
  const refs = new Map(r.stdout.trim().split("\n").filter(Boolean)
    .map((line) => { const [oid, ref] = line.split("\t"); return [ref, oid]; }));
  return { ...r, refs };
};

/** Poll fn() until truthy or the budget expires; returns the last value. */
const poll = async (budgetMs, fn) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(500);
  }
};

const hexId = (n = 8) => randomUUID().replaceAll("-", "").slice(0, n);

/**
 * Run one check, record {id, status, detail, ms}, print the evidence-block
 * progress line. The checked fn returns a detail string (pass) or
 * {status: "warn"|"info", detail} for outcomes that never fail the battery;
 * throwing = fail.
 */
async function check(id, fn) {
  const t0 = performance.now();
  let status = "pass";
  let detail;
  try {
    const out = await fn();
    if (typeof out === "string") detail = out;
    else {
      status = out.status;
      detail = out.detail;
    }
  } catch (err) {
    status = "fail";
    detail = err instanceof Error ? err.message : String(err);
  }
  detail = scrub(detail);
  const ms = Math.round(performance.now() - t0);
  results.push({ id, status, detail, ms });
  log(`  [${status}] ${id} (${ms} ms)${detail ? ` — ${detail}` : ""}`);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Chained steps: once one fails the rest record [skip] (deploy-smoke's chain). */
async function chain(steps) {
  let failed = false;
  for (const step of steps) {
    if (failed) {
      results.push({ id: step.id, status: "skip", detail: "prior step failed", ms: 0 });
      log(`  [skip] ${step.id} — prior step failed`);
      continue;
    }
    const idx = results.length;
    await check(step.id, step.run);
    if (results[idx].status === "fail") failed = true;
  }
}

/** Best-effort repo DELETE via the API (204). Non-204 = warn + leftBehind, never fatal. */
const deleteRepo = async (owner, repo) => {
  const res = await api(`/repos/${owner}/${repo}`, { method: "DELETE" });
  if (res.status === 204) return `repo ${owner}/${repo} deleted`;
  leftBehind.push(`repo ${owner}/${repo} (DELETE returned ${res.status})`);
  return { status: "warn", detail: `repo ${owner}/${repo} LEFT BEHIND — DELETE returned ${res.status} ${res.text.slice(0, 80)}` };
};

/** Settle budgets (§2.5.2: pushes settle in waitUntil after the response; the
 *  evidence polls create-settle green on poll 1 at 2.5-3.4 s). Single-shot
 *  probes (rename carry, tombstone t+0) deliberately do NOT poll. */
const SETTLE_MS = 15_000;
const FORK_SETTLE_MS = 30_000;
/** The .invalid sync settle (the queue consumer's failed attempt — the
 *  evidence's first poll landed ~3 s). REDEPLOY15 observed a PRODUCTION settle
 *  at 12 s (queue-latency variance; the re-run settled at 1.3 s), red-spinning
 *  the debut 10 s budget — the default is now 30 s (~2.5x the observed worst);
 *  tighten for quick local runs with --mirror-settle-ms. */
const MIRROR_SETTLE_MS = opts.mirrorSettleMs;

// ---------- battery: p0 (shallow trio + privacy tail) ----------

const p0Context = () => ({
  user: opts.user,
  repo: opts.fixtureRepo,
  url: gitUrl(opts.user, opts.fixtureRepo),
  tmp: null,
});

const probeShallowSince = async (ctx) => {
  const dir = path.join(ctx.tmp, "shallow-since");
  const r = await git(["clone", "--shallow-since=2026-10-20 00:00:00 +0000", ctx.url, dir], undefined, { auth: true });
  expect(r.code === 128, `exit ${r.code} (expected 128): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  expect(!existsSync(dir), "clone dir exists after the failed clone (expected: no repo dir)");
  expect(r.stderr.includes("deepen-since") && r.stderr.includes("unsupported fetch argument"),
    `stderr does not name 'deepen-since' as an unsupported fetch argument: ${r.stderr.trim().slice(0, 200)}`);
  return `exit 128 — unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)`;
};

const probeShallowExclude = async (ctx) => {
  const dir = path.join(ctx.tmp, "shallow-exclude");
  const r = await git(["clone", "--shallow-exclude=old-base", ctx.url, dir], undefined, { auth: true });
  expect(r.code === 128, `exit ${r.code} (expected 128): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  expect(!existsSync(dir), "clone dir exists after the failed clone (expected: no repo dir)");
  expect(r.stderr.includes("deepen-not") && r.stderr.includes("unsupported fetch argument"),
    `stderr does not name 'deepen-not' as an unsupported fetch argument: ${r.stderr.trim().slice(0, 200)}`);
  return `exit 128 — same shape naming 'deepen-not'`;
};

const probeDepth1 = async (ctx) => {
  const dir = path.join(ctx.tmp, "depth-1");
  const r = await git(["clone", "--depth=1", ctx.url, dir], undefined, { auth: true });
  expect(r.ok, `clone --depth=1 failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const rev = await git(["rev-parse", "HEAD"], dir);
  expect(rev.ok, `rev-parse HEAD failed: ${rev.stderr.trim().slice(0, 200)}`);
  const tip = rev.stdout.trim();
  expect(/^[0-9a-f]{40}$/.test(tip), `HEAD is not an oid: ${tip}`);
  const shallow = (await readFile(path.join(dir, ".git", "shallow"), "utf8")).trim().split("\n");
  expect(shallow.length === 1 && shallow[0] === tip,
    `.git/shallow should be exactly the HEAD tip ${tip.slice(0, 10)}…, got ${JSON.stringify(shallow)}`);
  if (opts.fixtureOid) {
    expect(tip === opts.fixtureOid, `tip ${tip} != the pinned fixture oid ${opts.fixtureOid}`);
  }
  const count = await git(["rev-list", "--count", "HEAD"], dir);
  expect(count.stdout.trim() === "1", `commit count ${count.stdout.trim()} (expected 1)`);
  const isShallow = await git(["rev-parse", "--is-shallow-repository"], dir);
  expect(isShallow.stdout.trim() === "true", `is-shallow-repository = ${isShallow.stdout.trim()} (expected true)`);
  const fsck = await git(["fsck"], dir);
  expect(fsck.ok, `fsck failed: ${(fsck.stderr || fsck.stdout).trim().slice(0, 200)}`);
  const pin = opts.fixtureOid ? "" : ` (canonical pin ${CANONICAL_FIXTURE_OID.slice(0, 10)}… — pass --fixture-oid to enforce)`;
  return `exit 0 — .git/shallow = ${tip.slice(0, 10)}… (identical tip); depth 1; fsck clean${pin}`;
};

const probePrivacyTail = async (ctx) => {
  const res = await api(`/repos/${ctx.user}/${ctx.repo}`, { auth: false });
  expect(res.status === 404, `anonymous API GET status ${res.status} (expected 404)`);
  expect(res.text.includes("not found"), `anonymous API GET body ${res.text.slice(0, 120)} (expected the not-found report)`);
  const refs = await fetchT(`${ctx.url}/info/refs?service=git-upload-pack`);
  await refs.text();
  expect(refs.status === 401, `anonymous info/refs status ${refs.status} (expected 401 — the fixture is private)`);
  const wwwAuth = String(refs.headers.get("www-authenticate") ?? "");
  expect(wwwAuth.includes("Basic"), `anonymous info/refs www-authenticate ${wwwAuth} (expected a Basic challenge)`);
  const page = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}`);
  await page.text();
  expect(page.status === 404, `anonymous web page status ${page.status} (expected 404)`);
  return `anonymous API GET 404, info/refs 401 (${wwwAuth}), web page 404 — the fixture stays private`;
};

const p0Steps = (ctx) => [
  { id: "p0-shallow-since", expect: `git clone --shallow-since="2026-10-20 00:00:00 +0000" (authenticated via http.extraHeader) → exit 128, no repo dir; stderr names 'deepen-since' (unsupported fetch argument)`, run: () => probeShallowSince(ctx) },
  { id: "p0-shallow-exclude", expect: `git clone --shallow-exclude=old-base (authenticated) → exit 128, no repo dir; same shape naming 'deepen-not'`, run: () => probeShallowExclude(ctx) },
  { id: "p0-depth-1", expect: `git clone --depth=1 (authenticated) → exit 0; .git/shallow = the HEAD tip${opts.fixtureOid ? ` == ${opts.fixtureOid}` : ` (canonical pin ${CANONICAL_FIXTURE_OID.slice(0, 10)}…)`}; 1 commit; is-shallow true; fsck clean`, run: () => probeDepth1(ctx) },
  { id: "p0-privacy-anon", expect: `the standing fixture stays private: anonymous API GET 404, anonymous info/refs 401 Basic challenge, anonymous web page 404`, run: () => probePrivacyTail(ctx) },
];

// ---------- battery: registry (tombstone sweep, carry + t+0) ----------

const registryTrialSteps = (t) => {
  const name = `reg-${hexId()}`;
  const renamed = `${name}-r2`;
  const oldUrl = gitUrl(opts.user, name);
  const newUrl = gitUrl(opts.user, renamed);
  return [
    {
      id: `t${t}-create-201`,
      expect: `POST /api/v1/user/repos {"name":"${name}","private":false,"auto_init":true} → 201`,
      run: async () => {
        const res = await api("/user/repos", { method: "POST", body: { name, private: false, auto_init: true } });
        expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
        return `created ${res.json?.full_name ?? `${opts.user}/${name}`} (public, auto_init)`;
      },
    },
    {
      id: `t${t}-advert-settle`,
      expect: `anonymous ls-remote on the new repo (settle-polled, budget ${SETTLE_MS / 1000}s) → exit 0 listing HEAD + refs/heads/main — the create half holds`,
      run: async () => {
        const done = await poll(SETTLE_MS, async () => {
          const r = await lsRemote(oldUrl);
          return r.ok && r.refs.has("refs/heads/main") ? r : null;
        });
        expect(done !== null, `anonymous advert never came up within ${SETTLE_MS} ms`);
        return `exit 0 — ${[...done.refs.keys()].join(", ")}`;
      },
    },
    {
      id: `t${t}-rename-200`,
      expect: `PATCH /api/v1/repos/${opts.user}/${name} {"name":"${renamed}"} → 200 with the new full_name`,
      run: async () => {
        const res = await api(`/repos/${opts.user}/${name}`, { method: "PATCH", body: { name: renamed } });
        expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
        expect(String(res.json?.full_name ?? "").endsWith(renamed), `full_name ${res.json?.full_name} (expected …/${renamed})`);
        return `renamed to ${res.json?.full_name}`;
      },
    },
    {
      id: `t${t}-rename-carry`,
      expect: `IMMEDIATE anonymous ls-remote on the NEW name (single-shot, no sleep) → exit 0 listing ALL refs (incl. refs/heads/main) — the carry holds`,
      run: async () => {
        const r = await lsRemote(newUrl);
        expect(r.ok, `ls-remote on the new name failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
        expect(r.refs.has("refs/heads/main"), `the new-name advert lost refs/heads/main: ${[...r.refs.keys()].join(", ")}`);
        return `the carry holds — ${[...r.refs.keys()].join(", ")}`;
      },
    },
    {
      id: `t${t}-delete-204`,
      expect: `DELETE /api/v1/repos/${opts.user}/${renamed} → 204`,
      run: async () => {
        const res = await api(`/repos/${opts.user}/${renamed}`, { method: "DELETE" });
        expect(res.status === 204, `status ${res.status} (expected 204)`);
        return "204";
      },
    },
    {
      id: `t${t}-tombstone-t0`,
      expect: `THE VERY NEXT anonymous ls-remote on the renamed name (single-shot, NO sleep) → exit 128, stderr 'repository not found' — T+0 CLEAN (the closed read-after-delete window stays closed)`,
      run: async () => {
        const r = await lsRemote(newUrl);
        expect(r.code === 128, `exit ${r.code} (expected 128 — a 0 here means the tombstone window re-opened)`);
        expect(r.stderr.includes("repository not found"), `stderr ${r.stderr.trim().slice(0, 200)} (expected 'repository not found')`);
        return `exit 128 at t+0 — remote: repository not found`;
      },
    },
    {
      id: `t${t}-old-name-dead`,
      expect: `old (pre-rename) name post-delete: anonymous ls-remote → 128 not-found AND anonymous API GET → 404 {"message":"not found"}`,
      run: async () => {
        const r = await lsRemote(oldUrl);
        expect(r.code === 128 && r.stderr.includes("repository not found"),
          `old-name ls-remote exit ${r.code} (expected 128 not-found): ${r.stderr.trim().slice(0, 120)}`);
        const res = await api(`/repos/${opts.user}/${name}`, { auth: false });
        expect(res.status === 404 && res.text.includes("not found"),
          `old-name API GET ${res.status} (expected 404 not-found)`);
        return `old name dead on both paths (git 128, API 404)`;
      },
    },
  ];
};

// ---------- battery: generate-e2e ----------

const GENERATED_CLONE_CARRIED =
  "carried OPEN ISSUE (REDEPLOY13): the generated repo's git wire is not yet usable " +
  "(clone/fetch 500s in the DO's uploadPack walk; push refused 'missing necessary objects') — " +
  "expected to fail until the engine read path lands; pass --strict-generated-clone to assert it";

const LICENSE_TEXT = "MIT License\n\ncf-gitea deploy-probes generate-e2e battery\n";

const generateContext = () => ({ user: opts.user, tmpl: `tmpl-${hexId()}`, gen: `gen-${hexId()}`, tip: null, tmp: null });

const pushTemplateContent = async (ctx) => {
  const tmp = ctx.tmp; // main() owns the battery scratch dir (created + removed there)
  const tmplUrl = gitUrl(ctx.user, ctx.tmpl);
  // Clone-based (the auto_init main already carries a commit — the evidence
  // flow pushes the LICENSE commit ON it, which an unrelated init history
  // cannot fast-forward to).
  const work = path.join(tmp, "tmpl");
  let r = await git(["clone", tmplUrl, "tmpl"], tmp, { auth: true });
  expect(r.ok, `clone template failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  await writeFile(path.join(work, "LICENSE"), LICENSE_TEXT);
  r = await git(["add", "-A"], work);
  expect(r.ok, `git add failed: ${r.stderr.trim()}`);
  r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
    "commit", "-m", "deploy-probes: generate battery content"], work);
  expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
  r = await git(["push", "origin", "HEAD:refs/heads/main"], work, { auth: true });
  expect(r.ok, `push main failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  r = await git(["push", "origin", "HEAD:refs/heads/dev"], work, { auth: true });
  expect(r.ok, `push dev failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const lr = await lsRemote(tmplUrl, { auth: true });
  expect(lr.ok && lr.refs.has("refs/heads/main") && lr.refs.has("refs/heads/dev"),
    `template ls-remote missing refs: ${[...lr.refs.keys()].join(", ")}`);
  ctx.tip = lr.refs.get("refs/heads/main");
  expect(ctx.tip === lr.refs.get("refs/heads/dev"), "main and dev differ before generate (expected the same tip)");
  return `pushed LICENSE on main + second ref refs/heads/dev, both at ${ctx.tip.slice(0, 10)}…`;
};

const generateSteps = (ctx) => [
  {
    id: "gen-create-template-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.tmpl}","auto_init":true} → 201`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.tmpl, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "gen-template-push",
    expect: `REAL PUSH content: LICENSE commit on main via git push + second ref refs/heads/dev; ls-remote lists both at one tip`,
    run: () => pushTemplateContent(ctx),
  },
  {
    id: "gen-patch-template-200",
    expect: `PATCH {"template":true} → 200 with "template":true IN THE RESPONSE BODY`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}`, { method: "PATCH", body: { template: true } });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
      expect(res.json?.template === true, `template flag not in the body: ${res.text.slice(0, 120)}`);
      return `200 with "template":true`;
    },
  },
  {
    id: "gen-template-persisted",
    expect: `follow-up GET → 200 with template:true PERSISTED`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}`);
      expect(res.status === 200 && res.json?.template === true,
        `status ${res.status}, template ${res.json?.template} (expected persisted true)`);
      return "template:true persisted";
    },
  },
  {
    id: "gen-generate-201-empty-false",
    expect: `POST /repos/${ctx.user}/${ctx.tmpl}/generate {"name":"${ctx.gen}","git_content":true} → 201 with "empty":false IN THE RESPONSE BODY`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}/generate`, { method: "POST", body: { name: ctx.gen, git_content: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(res.json?.empty === false, `empty ${res.json?.empty} (expected false in the body)`);
      return `201 with "empty":false (${res.json?.full_name})`;
    },
  },
  {
    id: "gen-generated-empty-get",
    expect: `follow-up GET on the generated repo → "empty":false`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.gen}`);
      expect(res.status === 200 && res.json?.empty === false,
        `status ${res.status}, empty ${res.json?.empty} (expected false)`);
      return `"empty":false`;
    },
  },
  {
    id: "gen-generated-refs",
    expect: `generated repo ls-remote lists refs/heads/main + refs/heads/dev at the IDENTICAL tip {{tip}} (settle-polled, budget 10s)`,
    run: async () => {
      const lr = await poll(10_000, async () => {
        const r = await lsRemote(gitUrl(ctx.user, ctx.gen), { auth: true });
        return r.ok && r.refs.has("refs/heads/main") && r.refs.has("refs/heads/dev") ? r : null;
      });
      expect(lr !== null, "the generated repo never listed main+dev via ls-remote");
      expect(lr.refs.get("refs/heads/main") === ctx.tip && lr.refs.get("refs/heads/dev") === ctx.tip,
        `generated tips ${lr.refs.get("refs/heads/main")?.slice(0, 10)}…/${lr.refs.get("refs/heads/dev")?.slice(0, 10)}… != the carried tip ${ctx.tip.slice(0, 10)}…`);
      return `both carried refs at the identical tip ${ctx.tip.slice(0, 10)}…`;
    },
  },
  {
    id: "gen-generated-contents",
    expect: `contents API on the generated repo → 200: LICENSE base64 decodes VERBATIM; last_commit_sha = the carried tip`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.gen}/contents/LICENSE`);
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
      const decoded = Buffer.from(String(res.json?.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
      expect(decoded === LICENSE_TEXT, `LICENSE decoded != the pushed bytes (${decoded.slice(0, 60)})`);
      expect(res.json?.last_commit_sha === ctx.tip,
        `last_commit_sha ${res.json?.last_commit_sha} != the carried tip ${ctx.tip}`);
      return `LICENSE round-trips verbatim; last_commit_sha = the carried tip`;
    },
  },
  {
    id: "gen-generated-clone",
    expect: opts.strictGeneratedClone
      ? `git clone --depth=1 of the GENERATED repo → exit 0 (hard assert; --strict-generated-clone)`
      : `git clone --depth=1 of the GENERATED repo → WARN while the carried git-wire issue is open (hard assert via --strict-generated-clone)`,
    run: async () => {
      const dir = path.join(ctx.tmp, "gen-clone");
      const r = await git(["clone", "--depth=1", gitUrl(ctx.user, ctx.gen), dir], undefined, { auth: true });
      if (r.ok) {
        return opts.strictGeneratedClone
          ? "clone succeeded (exit 0)"
          : { status: "info", detail: "clone SUCCEEDED — the carried git-wire issue looks fixed; re-run with --strict-generated-clone to pin it" };
      }
      if (opts.strictGeneratedClone) {
        throw new Error(`clone failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      }
      return { status: "warn", detail: `${GENERATED_CLONE_CARRIED}; this run: exit ${r.code} ${(r.stderr || "").trim().slice(0, 120)}` };
    },
  },
  {
    id: "gen-cleanup",
    expect: `both probe repos DELETEd → 204 (a failed cleanup is documented, not fatal)`,
    run: async () => {
      const a = await deleteRepo(ctx.user, ctx.gen);
      const b = await deleteRepo(ctx.user, ctx.tmpl);
      await rm(ctx.tmp, { recursive: true, force: true });
      if (typeof a === "string" && typeof b === "string") return `${ctx.gen} + ${ctx.tmpl} deleted`;
      return { status: "warn", detail: `${a.detail ?? a}; ${b.detail ?? b}` };
    },
  },
];

// ---------- battery: forkpr-e2e ----------

const forkprContext = () => ({ user: opts.user, base: `prbase-${hexId()}`, org: `prorg-${hexId()}`, branch: `prbr-${hexId()}`, tip: null, number: null, tmp: null });

const forkprSteps = (ctx) => [
  {
    id: "forkpr-create-base-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.base}","auto_init":true} → 201`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.base, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "forkpr-create-org-201",
    expect: `POST /api/v1/orgs {"username":"${ctx.org}"} → 201 (the doer-owned fork namespace — one PAT, no admin)`,
    run: async () => {
      const res = await api("/orgs", { method: "POST", body: { username: ctx.org } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `org ${ctx.org} created`;
    },
  },
  {
    id: "forkpr-fork-202",
    expect: `POST /repos/${ctx.user}/${ctx.base}/forks {"organization":"${ctx.org}"} → 202 (upstream's CreateFork accepted code) with the fork at ${ctx.org}/${ctx.base} — the DEFAULT slug kept, so the bare owner:branch head form resolves the fork`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.base}/forks`, { method: "POST", body: { organization: ctx.org } });
      expect(res.status === 202, `status ${res.status} (expected 202): ${res.text.slice(0, 200)}`);
      expect(res.json?.full_name === `${ctx.org}/${ctx.base}`,
        `full_name ${res.json?.full_name} (expected ${ctx.org}/${ctx.base} — the default-slug fork shape)`);
      return `202 — fork ${res.json?.full_name} accepted (async copy)`;
    },
  },
  {
    id: "forkpr-fork-settle",
    expect: `the fork's refs appear via authenticated ls-remote (settle-polled, budget ${FORK_SETTLE_MS / 1000}s — the async copy)`,
    run: async () => {
      const done = await poll(FORK_SETTLE_MS, async () => {
        const r = await lsRemote(gitUrl(ctx.org, ctx.base), { auth: true });
        return r.ok && r.refs.has("refs/heads/main") ? r : null;
      });
      expect(done !== null, `the fork never listed refs/heads/main within ${FORK_SETTLE_MS} ms`);
      return `fork advertises ${[...done.refs.keys()].filter((r) => r !== "HEAD").join(", ")}`;
    },
  },
  {
    id: "forkpr-fork-push",
    expect: `push a branch ${ctx.branch} to the FORK (clone the base, one commit, git push to the fork URL)`,
    run: async () => {
      const tmp = ctx.tmp; // main() owns the battery scratch dir (created + removed there)
      const work = path.join(tmp, "work");
      let r = await git(["clone", gitUrl(ctx.user, ctx.base), "work"], tmp, { auth: true });
      expect(r.ok, `clone base failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      r = await git(["checkout", "-b", ctx.branch], work);
      expect(r.ok, `checkout -b failed: ${r.stderr.trim()}`);
      await writeFile(path.join(work, "fork-pr.txt"), `deploy-probes forkpr-e2e ${ctx.branch}\n`);
      r = await git(["add", "-A"], work);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: fork PR head"], work);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["push", gitUrl(ctx.org, ctx.base), `HEAD:refs/heads/${ctx.branch}`], work, { auth: true });
      expect(r.ok, `push to fork failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      const lr = await lsRemote(gitUrl(ctx.org, ctx.base), { auth: true });
      expect(lr.ok && lr.refs.has(`refs/heads/${ctx.branch}`), `fork ls-remote missing ${ctx.branch}`);
      ctx.tip = lr.refs.get(`refs/heads/${ctx.branch}`);
      return `fork branch ${ctx.branch} at ${ctx.tip.slice(0, 10)}…`;
    },
  },
  {
    id: "forkpr-create-201",
    expect: `POST /repos/${ctx.user}/${ctx.base}/pulls {"head":"${ctx.org}:${ctx.branch}","base":"main"} → 201 (the cross-repo owner:branch fork-edge grammar — upstream's default form, the head branch read runs in the FORK cell)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.base}/pulls`, {
        method: "POST",
        body: { title: `deploy-probes fork-PR chain ${ctx.branch}`, head: `${ctx.org}:${ctx.branch}`, base: "main" },
      });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(Number.isInteger(res.json?.number) && res.json.number > 0, `no PR number in the body: ${res.text.slice(0, 120)}`);
      ctx.number = res.json.number;
      return `PR #${ctx.number} created from head ${ctx.org}:${ctx.branch}`;
    },
  },
  {
    id: "forkpr-head-chain",
    expect: `GET the PR (settle-polled until mergeable leaves null, budget 15s) → head.label = "${ctx.branch}", head.sha = the fork tip, head.repo.full_name = ${ctx.org}/${ctx.base}, base = main`,
    run: async () => {
      const pr = await poll(15_000, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.base}/pulls/${ctx.number}`);
        return res.status === 200 && res.json?.mergeable !== null && res.json?.mergeable !== undefined ? res.json : null;
      });
      expect(pr !== null, `the PR never resolved with a non-null mergeable within 15 s`);
      expect(pr.head?.label === ctx.branch, `head.label ${pr.head?.label} (expected ${ctx.branch})`);
      expect(pr.head?.sha === ctx.tip, `head.sha ${pr.head?.sha} != the fork tip ${ctx.tip}`);
      expect(pr.head?.repo?.full_name === `${ctx.org}/${ctx.base}`,
        `head.repo.full_name ${pr.head?.repo?.full_name} (expected ${ctx.org}/${ctx.base})`);
      expect(pr.base?.label === "main", `base.label ${pr.base?.label} (expected main)`);
      expect(typeof pr.mergeable === "boolean", `mergeable ${pr.mergeable} (expected a boolean — never a stuck null)`);
      return `head chain ok: ${pr.head?.repo?.full_name}#${pr.head?.label}@${pr.head?.sha?.slice(0, 10)}… → base main (mergeable ${pr.mergeable}, head.ref ${pr.head?.ref})`;
    },
  },
  {
    id: "forkpr-cleanup",
    expect: `fork + base DELETEd (204 each) and the org DELETEd (204) — a failed cleanup is documented, not fatal`,
    run: async () => {
      const a = await deleteRepo(ctx.org, ctx.base);
      const b = await deleteRepo(ctx.user, ctx.base);
      const org = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
      let orgOut;
      if (org.status === 204) orgOut = `org ${ctx.org} deleted`;
      else {
        leftBehind.push(`org ${ctx.org} (DELETE returned ${org.status})`);
        orgOut = { status: "warn", detail: `org ${ctx.org} LEFT BEHIND — DELETE returned ${org.status}` };
      }
      await rm(ctx.tmp, { recursive: true, force: true });
      const parts = [a, b, orgOut];
      if (parts.every((p) => typeof p === "string")) return parts.join("; ");
      return { status: "warn", detail: parts.map((p) => (typeof p === "string" ? p : p.detail)).join("; ") };
    },
  },
];

// ---------- battery: mirror (push-mirror credential-free arms) ----------

/** REDEPLOY13's exact loopback probe target (docs/design/p0-evidence.md
 *  ~1600-1610): HTTPS is required to reach the egress gate at all (a plain
 *  http:// URL lands in the 400 "Invalid mirror protocol" bucket first), and
 *  port 9 stays refused under BOTH postures — the production lax default and
 *  local dev's explicit `127.0.0.1:8443` allow entry. */
const MIRROR_LOOPBACK_TARGET = "https://127.0.0.1:9/dummy-unreachable.git";

/** The gate-passing unreachable dummy host, random per run (the hygiene
 *  convention; the RFC 2606 `.invalid` TLD never resolves — no credentials,
 *  no real egress). */
const mirrorInvalidTarget = () => `https://pmir-${hexId()}.invalid/dummy-unreachable.git`;

/** `repoCreated`/`repoGone`/`repoFullName` drive the failure-cleanup tail (see
 *  mirrorFailureCleanup): REDEPLOY15 friction (c) — a mid-battery red used to
 *  strand the mirror row + repo behind [skip] lines for a hand-clean.
 *  repoFullName is what the CREATE actually returned (the doer's namespace),
 *  so the tail deletes the right owner/slug even when --user drifts from the
 *  PAT's user. */
const mirrorContext = () => ({ user: opts.user, repo: `pmir-${hexId()}`, remoteName: null, remoteAddress: null, repoCreated: false, repoGone: false, repoFullName: null, tmp: null });

const mirrorSteps = (ctx) => [
  {
    id: "mir-create-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","auto_init":true} → 201 (the mirror source — one auto_init commit to push)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, private: true, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.repoCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.repoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      return `created ${res.json?.full_name} (private, auto_init)`;
    },
  },
  {
    id: "mir-ssrf-loopback-refused",
    expect: `ARM 1 — SSRF egress gate AT REGISTRATION: POST …/push_mirrors {"remote_address":"${MIRROR_LOOPBACK_TARGET}","interval":"8h"} → 401 "Permission denied" (the REDEPLOY13 refusal verbatim — the egress screen refusing the loopback target at the door; lax/strict MIRROR_ALLOWED_HOST_LIST) and the list stays empty (nothing written)`,
    run: async () => {
      // Settle-polled (SETTLE_MS): the create finalizes in waitUntil after
      // the 201 (the §2.5.2 window), so the FIRST registration attempt can
      // still 404 on requireVisibleRepo — poll the 404 arm out, then hold
      // the 401 line (a 200 here would mean the SSRF gate is OPEN).
      const res = await poll(SETTLE_MS, async () => {
        const r = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`, {
          method: "POST",
          body: { remote_address: MIRROR_LOOPBACK_TARGET, interval: "8h" },
        });
        return r.status === 404 ? null : r;
      });
      expect(res !== null, `the probe repo never became visible within ${SETTLE_MS} ms (every registration attempt 404'd)`);
      expect(res.status === 401, `status ${res.status} (expected 401 — a 200 here means the SSRF gate is OPEN): ${res.text.slice(0, 160)}`);
      expect(res.json?.message === "Permission denied", `message ${JSON.stringify(res.json?.message)} (expected "Permission denied")`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`);
      expect(Array.isArray(list.json) && list.json.length === 0,
        `list after the refusal: ${list.text.slice(0, 120)} (expected [] — the refusal wrote nothing)`);
      return `401 "Permission denied" — the loopback target refused at the door; list still empty`;
    },
  },
  {
    id: "mir-create-200",
    expect: `ARM 2 — the gate-passing unreachable target: POST …/push_mirrors {"remote_address":"<pmir-*.invalid>/dummy-unreachable.git","interval":"8h"} → 200 with the fresh-row wire: last_error "", last_update null, interval "8h0m0s", sync_on_commit false, remote_name remote_mirror_<10 alnum>`,
    run: async () => {
      ctx.remoteAddress = mirrorInvalidTarget();
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`, {
        method: "POST",
        body: { remote_address: ctx.remoteAddress, interval: "8h" },
      });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 200)}`);
      ctx.remoteName = String(res.json?.remote_name ?? "");
      expect(/^remote_mirror_[A-Za-z0-9]{10}$/.test(ctx.remoteName), `remote_name ${ctx.remoteName} (expected remote_mirror_<10 alnum>)`);
      expect(res.json?.last_error === "", `last_error ${JSON.stringify(res.json?.last_error)} (expected "" on the fresh row)`);
      expect(res.json?.last_update === null, `last_update ${res.json?.last_update} (expected null until the first sync)`);
      expect(res.json?.interval === "8h0m0s", `interval ${res.json?.interval} (expected "8h0m0s")`);
      expect(res.json?.sync_on_commit === false, `sync_on_commit ${res.json?.sync_on_commit} (expected false)`);
      expect(res.json?.remote_address === ctx.remoteAddress, `remote_address ${res.json?.remote_address} != the registered target`);
      return `200 — ${ctx.remoteName} → ${ctx.remoteAddress} (fresh-row wire)`;
    },
  },
  {
    id: "mir-sync-trigger-200",
    expect: `POST …/push_mirrors-sync → 200 (the enqueue; the outbound push runs on the MIRROR_SYNC_QUEUE consumer)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors-sync`, { method: "POST" });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      return "200 — sync enqueued";
    },
  },
  {
    id: "mir-sync-settle",
    expect: `poll GET …/push_mirrors/${"{name}"} (budget ${MIRROR_SETTLE_MS / 1000}s) until the failed sync settles: last_error NON-EMPTY and naming the target advertisement URL — canonical production text "mirror target responded 530 for info/refs advertisement [<addr>/info/refs?service=git-receive-pack]" (REDEPLOY13 verbatim; local dev's fetch failure reads "request failed" with the same bracketed URL)`,
    run: async () => {
      const row = await poll(MIRROR_SETTLE_MS, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors/${ctx.remoteName}`);
        if (res.status !== 200) throw new Error(`GET push_mirrors/${ctx.remoteName} status ${res.status} (expected 200)`);
        return res.json?.last_error ? res.json : null;
      });
      expect(row !== null, `last_error never went non-empty within ${MIRROR_SETTLE_MS} ms (the consumer never attempted the .invalid sync)`);
      const errText = String(row.last_error);
      expect(errText.includes("mirror target") && errText.includes("info/refs advertisement"),
        `last_error does not name the info/refs advertisement attempt: ${errText.slice(0, 200)}`);
      expect(errText.includes(`[${ctx.remoteAddress}/info/refs?service=git-receive-pack]`),
        `last_error does not name the target advertisement URL: ${errText.slice(0, 200)}`);
      const verbatim = errText.includes("mirror target responded 530 for info/refs advertisement");
      // The failure settle (settlePushMirrorFailure) writes last_error and
      // sync_state='idle' in the SAME update — observing last_error via the
      // API already proves the row is out of 'syncing'; the next check reads
      // the row directly.
      return `last_error names the target${verbatim ? " — the REDEPLOY13 verbatim 530 shape" : " (local fetch-failure shape; production records 'responded 530')"}: ${errText.slice(0, 140)}`;
    },
  },
  {
    id: "mir-row-settled",
    expect: `the mirror ROW settled clean (wrangler d1 execute, --${opts.d1Scope}): sync_state='idle' (back from syncing, no stuck state), next_sync_at=0 (the failure left the fresh row unscheduled)`,
    run: async () => {
      const row = await d1Row(`SELECT sync_state, next_sync_at FROM push_mirrors WHERE remote_name = '${ctx.remoteName}'`);
      expect(row.sync_state === "idle", `sync_state ${JSON.stringify(row.sync_state)} (expected 'idle' — no stuck state)`);
      expect(Number(row.next_sync_at) === 0, `next_sync_at ${row.next_sync_at} (expected 0 — the failure left it unscheduled)`);
      return `sync_state='idle', next_sync_at=0 (--${opts.d1Scope})`;
    },
  },
  {
    id: "mir-delete-204",
    expect: `DELETE …/push_mirrors/${"{name}"} → 204 and the very next GET …/push_mirrors → [] (the row and its sealed credentials are gone; the audit battery's push_mirrors==0 expectation stays true)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors/${ctx.remoteName}`, { method: "DELETE" });
      expect(res.status === 204, `status ${res.status} (expected 204)`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`);
      expect(Array.isArray(list.json) && list.json.length === 0,
        `list after the delete: ${list.text.slice(0, 120)} (expected [])`);
      return "204 — the row (and its sealed credentials) is gone; list back to []";
    },
  },
  {
    id: "mir-cleanup",
    expect: `probe repo DELETEd → 204 (a failed cleanup is documented, not fatal; the failure-cleanup tail re-sweeps anything left)`,
    run: async () => {
      const out = await deleteRepo(ctx.user, ctx.repo);
      if (typeof out === "string") ctx.repoGone = true; // the tail no-ops on a green sweep
      await rm(ctx.tmp, { recursive: true, force: true });
      if (typeof out === "string") return out;
      return { status: "warn", detail: out.detail };
    },
  },
];

/** REDEPLOY15 friction (c): a mid-battery red (e.g. mir-sync-settle timing
 *  out) used to chain-skip the delete/cleanup arms and strand the mirror row
 *  AND repo behind [skip] lines — the row then breaks the audit battery's
 *  push_mirrors==0 until a hand-clean. This finally-style tail runs after
 *  EVERY mirror battery run (green ones no-op silently: the battery's own
 *  delete arms emptied the list and removed the repo) and best-effort deletes
 *  exactly what the run created and has not already deleted. Every action is
 *  logged on one [tail] line; failures feed left_behind and are never fatal;
 *  it never throws (main's finally depends on it). */
const mirrorFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    if (ctx.repoCreated === true) {
      const [owner, repo] = String(ctx.repoFullName ?? `${ctx.user}/${ctx.repo}`).split("/");
      // Mirror rows first: the list sweep covers the named row AND the
      // edge where the row exists but the creating check reded before
      // ctx.remoteName was captured.
      try {
        const list = await api(`/repos/${owner}/${repo}/push_mirrors`);
        const rows = Array.isArray(list.json) ? list.json : [];
        for (const row of rows) {
          const name = String(row?.remote_name ?? "");
          if (!name) continue;
          try {
            const res = await api(`/repos/${owner}/${repo}/push_mirrors/${name}`, { method: "DELETE" });
            if (res.status === 204) acts.push(`mirror row ${name} deleted (204)`);
            else noteLeftBehind(`mirror row ${name}`, `DELETE returned ${res.status}`);
          } catch (err) {
            noteLeftBehind(`mirror row ${name}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        noteLeftBehind(`mirror rows of ${owner}/${repo}`, `list failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (ctx.repoGone !== true) {
        try {
          const out = await deleteRepo(owner, repo);
          acts.push(typeof out === "string" ? out : out.detail);
        } catch (err) {
          noteLeftBehind(`repo ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] mir-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: ui-login ----------

const uiContext = () => ({ user: opts.user, repo: `ui-${hexId()}`, cookie: null, tmp: null });

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const uiSteps = (ctx) => [
  {
    id: "ui-create-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","auto_init":true} → 201 (any repo has a labels page)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "ui-labels-anonymous-0",
    expect: `anonymous GET /${ctx.user}/${ctx.repo}/labels → 200 with 0 "New Label" occurrences (the anonymous render — what a PAT header measures)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/labels`);
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      const n = countOccurrences(body, "New Label");
      expect(n === 0, `${n} "New Label" occurrences on the ANONYMOUS page (expected 0)`);
      return `200 with 0 "New Label" occurrences`;
    },
  },
  {
    id: "ui-login-303",
    expect: `POST /login (form-urlencoded user_name + password=<PAT>) → 303 + gitea_session cookie (the value is scrubbed from all output)`,
    run: async () => {
      const form = new URLSearchParams({ user_name: ctx.user, password: TOKEN });
      const res = await fetchT(`${opts.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 See Other)`);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(setCookie !== undefined, `no gitea_session cookie in Set-Cookie (got ${res.headers.getSetCookie().length} cookies)`);
      ctx.cookie = setCookie.split(";")[0];
      secrets.push(ctx.cookie.split("=")[1] ?? "");
      return `303 + gitea_session cookie`;
    },
  },
  {
    id: "ui-labels-cookie-owner",
    expect: `labels page WITH the cookie → 200 with ${opts.newLabelCount} "New Label" occurrences (canonical 3) + small-menu-items — the writer-gate owner arm renders`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/labels`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      const n = countOccurrences(body, "New Label");
      expect(n === opts.newLabelCount, `${n} "New Label" occurrences (expected ${opts.newLabelCount})`);
      expect(body.includes("small-menu-items"), "the small-menu-items nav shell is missing");
      return `200 with ${n} "New Label" occurrences + small-menu-items — the owner arm renders`;
    },
  },
  {
    id: "ui-cleanup",
    expect: `probe repo DELETEd → 204 (a failed cleanup is documented, not fatal)`,
    run: async () => {
      const out = await deleteRepo(ctx.user, ctx.repo);
      if (typeof out === "string") return out;
      return { status: "warn", detail: out.detail };
    },
  },
];

// ---------- battery: cleanup-audit (the D1 count shapes) ----------

const AUDIT_TABLES = [
  { key: "creating_rows", sql: `(SELECT COUNT(*) FROM "repositories" WHERE "status" = 'creating')`, want: () => 0, label: `repositories WHERE status='creating' (whole table)` },
  { key: "action_rows", sql: `(SELECT COUNT(*) FROM "action")`, want: () => 0, label: `"action" (whole table — the 389da18 delete sweep means NO hand-sweep)` },
  { key: "stars", sql: `(SELECT COUNT(*) FROM "stars")`, want: () => 0, label: `stars` },
  { key: "push_mirrors", sql: `(SELECT COUNT(*) FROM "push_mirrors")`, want: () => 0, label: `push_mirrors` },
  { key: "protected_branches", sql: `(SELECT COUNT(*) FROM "protected_branches")`, want: () => 0, label: `protected_branches` },
  { key: "repo_redirects", sql: `(SELECT COUNT(*) FROM "repo_redirects")`, want: () => 0, label: `repo_redirects` },
  { key: "user_blocking", sql: `(SELECT COUNT(*) FROM "user_blocking")`, want: () => 0, label: `user_blocking` },
];

/** One wrangler d1 execute (--json, --${opts.d1Scope}) → the first row of
 *  the last statement's results (the cleanup-audit + mirror row-settle reads). */
const d1Row = async (sql) => {
  const r = await run("pnpm", ["exec", "wrangler", "d1", "execute", "cf-gitea", `--${opts.d1Scope}`, "--json", "--command", sql],
    { cwd: workerDir, timeoutMs: 120_000 });
  expect(r.ok, `wrangler d1 execute failed (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`wrangler --json output is not JSON: ${r.stdout.slice(0, 200)}`);
  }
  const row = parsed.at(-1)?.results?.[0];
  expect(row !== undefined, `no result row from the d1 query (raw: ${r.stdout.slice(0, 200)})`);
  return row;
};

const auditCounts = async () => {
  const sql = `SELECT (SELECT COUNT(*) FROM "repositories" WHERE "owner_namespace" = '${opts.user}') AS owner_repos, ` +
    AUDIT_TABLES.map((t) => `${t.sql} AS ${t.key}`).join(", ") +
    `, (SELECT COUNT(*) FROM "personal_access_tokens") AS personal_access_tokens`;
  return d1Row(sql);
};

const auditSteps = (ctx) => [
  {
    id: "audit-query",
    expect: `one wrangler d1 execute (--${opts.d1Scope}) runs the whole count shape`,
    run: async () => {
      ctx.counts = await auditCounts();
      return `owner_repos=${ctx.counts.owner_repos} creating=${ctx.counts.creating_rows} action=${ctx.counts.action_rows} ` +
        `stars=${ctx.counts.stars} push_mirrors=${ctx.counts.push_mirrors} protected_branches=${ctx.counts.protected_branches} ` +
        `repo_redirects=${ctx.counts.repo_redirects} user_blocking=${ctx.counts.user_blocking} tokens=${ctx.counts.personal_access_tokens}`;
    },
  },
  {
    id: "audit-owner-repos",
    expect: `repositories WHERE owner_namespace='${opts.user}' = ${opts.expectOwnerRepos} (the standing p0-shallow fixture, intentionally live)`,
    run: () => {
      const n = ctx.counts.owner_repos;
      expect(n === opts.expectOwnerRepos, `${n} repos for ${opts.user} (expected ${opts.expectOwnerRepos})`);
      return `${n} (the standing fixture)`;
    },
  },
  ...AUDIT_TABLES.map((t) => ({
    id: `audit-${t.key.replaceAll("_", "-")}`,
    expect: `${t.label} = 0`,
    run: () => {
      const n = ctx.counts[t.key];
      expect(n === 0, `${t.label} = ${n} (expected 0)`);
      return `${t.label} = 0`;
    },
  })),
  {
    id: "audit-personal-access-tokens",
    expect: `personal_access_tokens (whole table) = ${opts.expectTokens} (the standing bootstrap PAT; per-run PATs DELETEd by the operator)`,
    run: () => {
      const n = ctx.counts.personal_access_tokens;
      expect(n === opts.expectTokens, `${n} tokens (expected ${opts.expectTokens})`);
      return `${n} (the standing bootstrap PAT)`;
    },
  },
];

// ---------- battery registry ----------

const BATTERIES = {
  "p0": { title: "P0 shallow trio + privacy tail", context: p0Context, steps: p0Steps },
  "registry": { title: "registry tombstone sweep (carry + t+0 delete)", context: () => ({}), steps: () => Array.from({ length: opts.trials }, (_, i) => registryTrialSteps(i + 1)).flat() },
  "generate-e2e": { title: "template → generate → carried refs + contents", context: generateContext, steps: generateSteps },
  "forkpr-e2e": { title: "fork → owner:branch PR chain", context: forkprContext, steps: forkprSteps },
  "mirror": { title: "push-mirror credential-free arms (SSRF gate + .invalid lifecycle)", context: mirrorContext, steps: mirrorSteps, failureTail: mirrorFailureCleanup },
  "ui-login": { title: "login-cookie labels owner view", context: uiContext, steps: uiSteps },
  // Independent counts — one red count never hides the rest of the shape.
  "cleanup-audit": { title: "post-run D1 count shapes", context: () => ({}), steps: auditSteps, independent: true },
};

const batteryList = opts.battery === "all" ? ["p0", "registry", "generate-e2e", "forkpr-e2e", "mirror", "ui-login", "cleanup-audit"] : [opts.battery];

// ---------- dry-run ----------

const dryRun = () => {
  log(`cf-gitea deploy probes — DRY RUN (no requests will be made; no token needed)`);
  log(`base URL: ${opts.baseUrl ?? "<supplied at run time>"}  user: ${opts.user}`);
  for (const name of batteryList) {
    const battery = BATTERIES[name];
    const ctx = battery.context();
    log(``);
    log(`battery ${name} — ${battery.title}`);
    for (const step of battery.steps(ctx)) {
      log(`  would run: ${step.id}`);
      log(`    expect: ${scrub(step.expect.replaceAll("{{tip}}", ctx.tip ?? "<the pushed tip>"))}`);
    }
  }
  log(``);
  log(`${batteryList.length} battery/batteries planned — run with --base-url <url> --token-file <0600 path> to execute (the D1-only cleanup-audit needs neither).`);
};

// ---------- main ----------

if (opts.dryRun) {
  dryRun();
  process.exit(0);
}

/** Load the per-run PAT: 0600 file, mint-per-run shape, never echoed. Only
 *  invoked when a selected battery makes HTTP calls — or when the operator
 *  supplied a token file anyway (it is validated + scrubbed regardless). */
const loadToken = async () => {
  const st = await stat(opts.tokenFile);
  expect(st.isFile(), `--token-file is not a regular file: ${opts.tokenFile}`);
  const mode = st.mode & 0o777;
  expect(mode === 0o600,
    `--token-file must be 0600 (mint-per-run convention, e.g. scripts/bootstrap-admin.mjs --remote > /tmp/pat && chmod 600 /tmp/pat); got mode ${mode.toString(8).padStart(3, "0")}`);
  const token = (await readFile(opts.tokenFile, "utf8")).trim();
  expect(token.length > 0, "--token-file is empty");
  expect(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/.test(token),
    "--token-file does not carry a cf-gitea PAT (cfg_<8hex>_<32base32>); refusing (value not logged)");
  secrets.push(token);
  return token;
};

const main = async () => {
  // REDEPLOY15 friction (a): the D1-only cleanup-audit runs WITHOUT a PAT —
  // loadToken fires only when the run actually makes HTTP calls.
  if (batteryList.some((name) => !D1_ONLY_BATTERIES.has(name)) || opts.tokenFile) {
    TOKEN = await loadToken();
  }
  log(`cf-gitea deploy probes — ${batteryList.join(" + ")} — ${opts.baseUrl ?? "(no --base-url: D1-only battery)"} (user ${opts.user})`);
  for (const name of batteryList) {
    const battery = BATTERIES[name];
    const ctx = battery.context();
    if (!ctx.tmp) ctx.tmp = await mkdtemp(path.join(os.tmpdir(), "cf-gitea-probes-"));
    log(``);
    log(`battery ${name} — ${battery.title}`);
    try {
      if (battery.independent) {
        for (const step of battery.steps(ctx)) await check(step.id, step.run);
      } else {
        await chain(battery.steps(ctx));
      }
    } finally {
      // REDEPLOY15 friction (c): a red run sweeps its own creations (the
      // mirror battery's tail; best-effort, logged, never throws).
      if (battery.failureTail) await battery.failureTail(ctx);
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  }
};

main()
  .then(() => {
    TOKEN = ""; // drop the plaintext before the summary prints
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const summary = {
      tool: "deploy-probes",
      batteries: batteryList,
      base_url: opts.baseUrl,
      user: opts.user,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      ok: counts.fail === 0,
      summary: counts,
      checks: results.map(({ id, status, detail, ms }) => ({ id, status, detail, ms })),
      ...(leftBehind.length ? { left_behind: leftBehind } : {}),
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = counts.fail === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`deploy-probes: ${scrub(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 2;
  });
