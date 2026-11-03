#!/usr/bin/env node
/* global fetch, AbortSignal -- Web globals provided by Node >= 18 (repo lint convention: no node env in the flat config) */
/**
 * setup-monitor-auth — the ONE-TIME authorization for the monitor-platform
 * deploy-probe battery (SPEC-0021 §4 as-built).
 *
 * The architecture (user-ruled, 2026-11-03): 一次授权、自动配置、集中管理、
 * 后续无人工干预 — the operator pastes two minimal Cloudflare API tokens
 * exactly once; this script validates them with DRY-RUN API calls (every
 * verdict naming one taxonomy class), persists them to a 0600 JSON file,
 * and every later `deploy-probes.mjs monitor-platform` run loads them
 * unattended. The deployed Worker's own secrets are SEPARATE (wrangler
 * secret put) — this tool arms the PROBE side only.
 *
 * The four-way taxonomy (the honest replacement for the blanket warn-skip —
 * SPEC-0021 §5 as-built):
 *   ok                — the probe answered within expectations for the scope
 *   permission-denied — 401/403: the token lacks the scope (or is dead);
 *                       NEVER relabeled "platform unsupported"
 *   api-unsupported   — the endpoint/capability itself is absent for this
 *                       account: 405/415/410/451/501, or a 403 whose envelope
 *                       names entitlement/availability rather than scope
 *   failure           — network unreachable, an unexpected status, or a
 *                       configured id that does not resolve; fix and re-run
 *   (missing-auth is the pre-authorization state — no credentials at all)
 *
 * What is validated (dry-run: nothing is created, nothing is mutated):
 *   QUEUES    (the /set loop needs Queues READ + WRITE):
 *     read  — GET the configured consumer (or GET /accounts/{a}/queues when
 *             no consumer allowlist is configured yet)
 *     write — PUT against a NIL UUID queue id: authorization is evaluated
 *             before resource existence, so 403 = scope missing while
 *             404 = "resource not found" = the scope passed. Nothing can
 *             exist at the nil id, so the call cannot mutate anything; the
 *             pass is labeled PROVISIONAL and the battery's real PUT still
 *             re-proves it (403 → the permission-denied FAIL).
 *   PROFILER  (Workers Scripts Read — and ONLY that; the profiler API does
 *     NOT need account-scoped read):
 *     read  — GET /accounts/{a}/workers/scripts, plus an informational
 *             check that MONITOR_WORKER_NAME is in the list
 *
 * What is NOT relied on: the wrangler OAuth flow's ability to mint a scoped
 * API token is UNVERIFIED (never exercised while authoring this — no
 * Cloudflare account credentials were available), so this tool offers NO
 * such path: the only intake is the operator's pasted token (interactive,
 * echo suppressed) or --from-env for scripted bootstrap. If that flow is
 * ever empirically verified it may join as an ADDITIONAL intake.
 *
 * Evaluated and DECLINED (the adjudication): Cloudflare Secrets Store
 * (secrets_store_secrets) — overkill for a single-worker deployment holding
 * two probe tokens. See SPEC-0021 §4.
 *
 * Persistence: <repoRoot>/.monitor-auth.json (or --file / $MONITOR_AUTH_FILE),
 * written with mode 0600 (verified after the write), GITIGNORED — runtime
 * state, never committed. The file carries NO claim about the release
 * verdict; --check re-validates against the live API.
 *
 * Usage:
 *   node scripts/setup-monitor-auth.mjs                 # first-run interactive setup
 *   node scripts/setup-monitor-auth.mjs --check         # re-validate non-interactively (no writes)
 *   node scripts/setup-monitor-auth.mjs --from-env      # non-interactive collect from the env names
 *   node scripts/setup-monitor-auth.mjs --force         # re-collect over an existing file
 *   node scripts/setup-monitor-auth.mjs --file <path>   # relocate the store (default repo root)
 *   node scripts/setup-monitor-auth.mjs --help
 *
 * Exit codes: 0 every scope ok · 1 a validation verdict is not ok ·
 * 2 usage/CLI error · 3 missing-auth (--check found neither the store nor
 * env credentials). Ctrl-C during a hidden read exits 130 without writing.
 *
 * Node >= 22 (runs on >= 24); node: builtins + global fetch only — zero npm
 * deps, the scripts/ convention.
 */

import console from "node:console";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_AUTH_FILE = path.join(repoRoot, ".monitor-auth.json");

/** Test/stub seam (scripts/deploy-probes.mjs shares the name): both tools
 *  send their BEARER tokens to this origin. Default the real platform; point
 *  it ONLY at a stub you own — scripts/setup-monitor-auth.test.mjs does
 *  exactly that. */
const CF_API_ORIGIN = (process.env.MONITOR_CF_API_BASE ?? "").trim().replace(/\/+$/, "") || "https://api.cloudflare.com";
const CF_API_TIMEOUT_MS = 15_000;
const CF_429_RETRIES = 1;
const CF_429_BACKOFF_CAP_MS = 5_000;
/** The nil-uuid queue/consumer id the dry-write probe aims at. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** 403 envelopes that name entitlement/availability rather than token scope
 *  (best-effort text match — the attribution rule is documented in
 *  SPEC-0021 §4/§5 and mirrors the battery's classifier). */
const ENTITLEMENT_RE = /not\s+entitled|entitlement|not\s+available|not\s+been\s+enabled|not\s+enabled|upgrade|only\s+available|enterprise/i;

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const WORKER_NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

// ---------- scrub (the deploy-probes convention: secrets never echoed) ----------

const secrets = [];
const scrub = (text) => {
  let s = text;
  for (const sec of secrets) s = s.split(sec).join("***");
  return s;
};

// ---------- the allowlist parser (parseMonitorAllowlist's mirror — the same
//  no-partial-trust validation the battery and the Worker adapter run) ----------

/** @returns {{ targets: Map<string, {key, queueId, consumerId, declaredMaxConcurrency}>, error: string | null }} */
export const parseAllowlist = (raw) => {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { targets: new Map(), error: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { targets: new Map(), error: "MONITOR_QUEUE_CONSUMERS must be a JSON object keyed by queue name" };
  }
  const targets = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) {
      return { targets: new Map(), error: "MONITOR_QUEUE_CONSUMERS carries a key that is not a queue-name shape" };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}] must be an object` };
    }
    const entry = value;
    if (typeof entry.queue_id !== "string" || entry.queue_id === "") {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].queue_id must be a non-empty string` };
    }
    if (typeof entry.consumer_id !== "string" || entry.consumer_id === "") {
      return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].consumer_id must be a non-empty string` };
    }
    let declared = null;
    if (entry.declared_max_concurrency !== undefined && entry.declared_max_concurrency !== null) {
      if (typeof entry.declared_max_concurrency !== "number" || !Number.isInteger(entry.declared_max_concurrency) || entry.declared_max_concurrency < 0) {
        return { targets: new Map(), error: `MONITOR_QUEUE_CONSUMERS[${key}].declared_max_concurrency must be a non-negative integer or null` };
      }
      declared = entry.declared_max_concurrency;
    }
    targets.set(key, { key, queueId: entry.queue_id, consumerId: entry.consumer_id, declaredMaxConcurrency: declared });
  }
  return { targets, error: null };
};

// ---------- auth shapes ----------

/** The env names the Worker carries as secrets (and the probe env may
 *  override the store with). Returns nulls for absent/blank fields. */
export const authFromEnv = () => {
  const env = process.env;
  const str = (name) => env[name]?.trim() || null;
  return {
    accountId: str("CLOUDFLARE_ACCOUNT_ID"),
    queuesToken: str("CLOUDFLARE_QUEUES_TOKEN"),
    profileToken: str("CLOUDFLARE_PROFILE_TOKEN"),
    workerName: str("MONITOR_WORKER_NAME"),
    consumers: str("MONITOR_QUEUE_CONSUMERS"),
  };
};

/** Load the persisted store (read-only). Absent → { absent: true }; unusable
 *  (mode, JSON) → { error }; good → { auth, savedAt, lastValidation }. */
export const loadAuthFile = async (filePath) => {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return { absent: true };
  }
  if (!st.isFile()) return { error: `${filePath} is not a regular file` };
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    return { error: `${filePath} must be 0600 (the setup tool writes it so) — got mode ${mode.toString(8).padStart(3, "0")}; fix with chmod 600` };
  }
  let doc;
  try {
    doc = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (err) {
    return { error: `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return {
    auth: {
      accountId: str(doc.account_id),
      queuesToken: str(doc.queues_token),
      profileToken: str(doc.profile_token),
      workerName: str(doc.worker_name),
      consumers: doc.queue_consumers === undefined || doc.queue_consumers === null
        ? null
        : typeof doc.queue_consumers === "string" ? doc.queue_consumers : JSON.stringify(doc.queue_consumers),
    },
    savedAt: str(doc.saved_at),
    lastValidation: doc.last_validation ?? null,
  };
};

/** env wins field-by-field over the store (the battery's precedence). */
export const mergeAuth = (envAuth, fileAuth) => {
  const pick = (envValue, fileValue) => envValue || fileValue || null;
  return {
    accountId: pick(envAuth.accountId, fileAuth?.accountId),
    queuesToken: pick(envAuth.queuesToken, fileAuth?.queuesToken),
    profileToken: pick(envAuth.profileToken, fileAuth?.profileToken),
    workerName: pick(envAuth.workerName, fileAuth?.workerName) ?? "cf-gitea",
    consumers: pick(envAuth.consumers, fileAuth?.consumers),
  };
};

// ---------- the Cloudflare API call core ----------

/** One JSON-envelope API call with the bounded 429 posture (one retry,
 *  Retry-After honored and capped). A network throw comes back as
 *  { networkError } — the failure class, never an application crash. */
const cfCall = async ({ method, urlPath, token, body }) => {
  const url = `${CF_API_ORIGIN}${urlPath}`;
  let attempts = 0;
  for (;;) {
    attempts++;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
      });
    } catch (err) {
      return { networkError: err instanceof Error ? err.message : String(err), attempts };
    }
    if (res.status === 429 && attempts <= CF_429_RETRIES) {
      const raw = res.headers.get("retry-after");
      const seconds = raw === null ? NaN : Number.parseFloat(raw);
      const delayMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, CF_429_BACKOFF_CAP_MS) : 1_000;
      await sleep(delayMs);
      continue;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON — the caller classifies on status */ }
    return { status: res.status, ok: res.ok, json, text, attempts };
  }
};

const cfErrText = (r) => {
  const arr = r.json?.errors;
  if (Array.isArray(arr)) {
    return arr.map((e) => {
      const entry = e ?? {};
      return typeof entry.code === "number" ? `${entry.code}: ${entry.message ?? ""}` : (entry.message ?? "");
    }).filter(Boolean).join("; ").slice(0, 200);
  }
  return (r.text ?? "").slice(0, 200);
};

/** The shared classifier for the UNAMBIGUOUS statuses; each probe adds its
 *  own 404 semantics (a 404 is config-resolves-false for the consumer read,
 *  capability-absent for the scripts list, and THE pass signal for the
 *  dry-write). 2xx → ok with an empty detail — the caller narrates. */
const classifyShared = (r) => {
  const errText = cfErrText(r);
  if (r.status >= 200 && r.status < 300) return { cls: "ok", detail: "" };
  if (r.status === 401) return { cls: "permission-denied", detail: `401 — the token is invalid or expired${errText ? ` (${errText})` : ""}` };
  if (r.status === 403) {
    if (ENTITLEMENT_RE.test(errText)) return { cls: "api-unsupported", detail: `403 naming entitlement/availability, not token scope (${errText || "no error detail"})` };
    return { cls: "permission-denied", detail: `403 — the token lacks the required scope${errText ? ` (${errText})` : ""}` };
  }
  if (r.status === 405 || r.status === 415 || r.status === 410 || r.status === 451 || r.status === 501) {
    return { cls: "api-unsupported", detail: `${r.status} on the documented endpoint (${errText || "no error detail"}) — the capability/route is not usable as designed` };
  }
  if (r.status === 429) return { cls: "failure", detail: `429 after its bounded retry — rate limited (${errText || "no error detail"})` };
  return { cls: "failure", detail: `${r.status}: ${errText || "(non-JSON or empty body)"}` };
};

// ---------- the per-scope dry-run probes ----------

/** QUEUES scope: read (the configured consumer, or the queues list when no
 *  consumer allowlist exists yet) + the dry write (nil-uuid PUT). */
const validateQueues = async ({ accountId, token, target }) => {
  // -- READ --
  const readUrl = target
    ? `/client/v4/accounts/${accountId}/queues/${encodeURIComponent(target.queueId)}/consumers/${encodeURIComponent(target.consumerId)}`
    : `/client/v4/accounts/${accountId}/queues`;
  const read = await cfCall({ method: "GET", urlPath: readUrl, token });
  if (read.networkError !== undefined) {
    return { verdict: "failure", detail: `network failure on the read probe (${readUrl}): ${read.networkError}` };
  }
  if (read.status === 404 && target) {
    return { verdict: "failure", detail: `the configured consumer does not resolve (404 at ${readUrl}) — fix the allowlist entry's queue_id/consumer_id (the token's scope was never asked)` };
  }
  const readClass = classifyShared(read);
  if (readClass.cls !== "ok") {
    return { verdict: readClass.cls, detail: `read probe (${target ? "GET the configured consumer" : "GET the queues list"}): ${readClass.detail}` };
  }
  let readSummary;
  if (target) {
    const settings = read.json?.result?.settings ?? null;
    const mc = settings && typeof settings.max_concurrency === "number" ? settings.max_concurrency : null;
    readSummary = `consumer read 200 — max_concurrency ${mc === null ? "auto" : mc}`;
  } else {
    const n = Array.isArray(read.json?.result) ? read.json.result.length : null;
    readSummary = `queues list 200${n === null ? "" : ` (${n} queues)`}`;
  }

  // -- WRITE (dry: the nil-uuid target can never exist, so nothing is
  //    mutated; authz-before-existence makes the answer a scope oracle) --
  const write = await cfCall({
    method: "PUT",
    urlPath: `/client/v4/accounts/${accountId}/queues/${NIL_UUID}/consumers/${NIL_UUID}`,
    token,
    body: JSON.stringify({ type: "worker", script_name: "cf-gitea-monitor-auth-validation", settings: { max_concurrency: 1 } }),
  });
  if (write.networkError !== undefined) {
    return { verdict: "failure", detail: `network failure on the dry-write probe (the read probe had already passed): ${write.networkError}` };
  }
  if (write.status === 404) {
    return {
      verdict: "ok",
      detail: `${readSummary}; dry-write answered 404 at the nil-uuid queue — resource-level not-found (nothing exists there, NOTHING was mutated), authz ran first, so Queues Write is treated as PRESENT (provisional — the battery's real PUT re-proves it)`,
    };
  }
  if (write.status >= 200 && write.status < 300) {
    return { verdict: "failure", detail: `dry-write unexpectedly SUCCEEDED (${write.status}) at the nil-uuid queue — pathological; nothing should exist there. Investigate before running the battery` };
  }
  const writeClass = classifyShared(write);
  return { verdict: writeClass.cls, detail: `read probe passed (${readSummary}); write probe (dry PUT): ${writeClass.detail}` };
};

/** PROFILER scope: the scripts list (Workers Scripts Read — correction 2:
 *  account-scoped read is NOT needed) + the worker-name membership note. */
const validateProfiler = async ({ accountId, token, workerName }) => {
  const urlPath = `/client/v4/accounts/${accountId}/workers/scripts`;
  const r = await cfCall({ method: "GET", urlPath, token });
  if (r.networkError !== undefined) {
    return { verdict: "failure", detail: `network failure on the scripts-list probe: ${r.networkError}` };
  }
  if (r.status === 404) {
    return { verdict: "api-unsupported", detail: "the Workers scripts endpoint answered 404 — the Workers API surface is absent/unavailable for this account" };
  }
  const cls = classifyShared(r);
  if (cls.cls !== "ok") return { verdict: cls.cls, detail: `scripts-list probe: ${cls.detail}` };
  const list = Array.isArray(r.json?.result) ? r.json.result : [];
  const present = list.some((entry) => entry && (entry.id === workerName || entry.name === workerName));
  const note = present
    ? `'${workerName}' is in the account's scripts`
    : `'${workerName}' is NOT in the account's scripts (${list.length} listed) — check MONITOR_WORKER_NAME; the battery's profile probe would answer 404`;
  return { verdict: "ok", detail: `scripts list 200 — Workers Scripts Read present; ${note}` };
};

/** Run both scope probes. Missing tokens → the missing-auth verdict for that
 *  scope (the pre-authorization state, distinct from every failure class). */
const runValidation = async (auth) => {
  const allow = parseAllowlist(auth.consumers ?? "");
  const target = allow.error === null && allow.targets.size > 0 ? [...allow.targets.values()][0] : null;
  const notes = [];
  if (allow.error !== null) notes.push(`MONITOR_QUEUE_CONSUMERS: ${allow.error}`);
  else if (allow.targets.size === 0) notes.push("no queue-consumer allowlist configured — the /set arm stays missing-auth until MONITOR_QUEUE_CONSUMERS (or the store's queue_consumers) carries an entry");

  const noAccount = auth.accountId === null;
  const queuesVerdict = auth.queuesToken === null
    ? { verdict: "missing-auth", detail: "CLOUDFLARE_QUEUES_TOKEN is not set (the /set loop needs Queues Read + Write)" }
    : noAccount
      ? { verdict: "failure", detail: "CLOUDFLARE_ACCOUNT_ID is not set — the API paths cannot be built" }
      : await validateQueues({ accountId: auth.accountId, token: auth.queuesToken, target });
  const profilerVerdict = auth.profileToken === null
    ? { verdict: "missing-auth", detail: "CLOUDFLARE_PROFILE_TOKEN is not set (the profiler needs Workers Scripts Read)" }
    : noAccount
      ? { verdict: "failure", detail: "CLOUDFLARE_ACCOUNT_ID is not set — the API paths cannot be built" }
      : await validateProfiler({ accountId: auth.accountId, token: auth.profileToken, workerName: auth.workerName });
  if (noAccount && (auth.queuesToken !== null || auth.profileToken !== null)) {
    notes.push("CLOUDFLARE_ACCOUNT_ID is not set — collect it (a 32-hex id) before the scopes can validate");
  }
  return { queuesVerdict, profilerVerdict, notes };
};

// ---------- persistence ----------

const persistAuth = async (filePath, auth, verdicts) => {
  const doc = {
    version: 1,
    kind: "cf-gitea monitor-platform probe auth (SPEC-0021 §4) — runtime state, GITIGNORED, never commit",
    saved_at: new Date().toISOString(),
    account_id: auth.accountId,
    queues_token: auth.queuesToken,
    profile_token: auth.profileToken,
    worker_name: auth.workerName,
    queue_consumers: auth.consumers && auth.consumers.trim() !== "" ? JSON.parse(auth.consumers) : {},
    last_validation: {
      at: new Date().toISOString(),
      queues: verdicts.queuesVerdict.verdict,
      profiler: verdicts.profilerVerdict.verdict,
      notes: verdicts.notes,
    },
  };
  const data = `${JSON.stringify(doc, null, 2)}\n`;
  await fsp.writeFile(filePath, data, { mode: 0o600 });
  await fsp.chmod(filePath, 0o600); // enforce even when the file pre-existed with a looser mode
  const st = await fsp.stat(filePath);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    console.error(`setup-monitor-auth: warning: the store's mode is ${mode.toString(8).padStart(3, "0")} after write (expected 600) — fix with chmod 600 ${filePath}`);
  }
};

// ---------- interactive intake ----------

const readLineVisible = async (prompt, { def = "" } = {}) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return (answer.trim() || def);
  } finally {
    rl.close();
  }
};

/** A paste with the terminal echo suppressed (raw mode). Falls back to a
 *  visible line read when stdin is not a TTY (piped input — the pipe author
 *  owns the echo; this tool never prints the value either way). */
const readHidden = (prompt) => new Promise((resolve) => {
  if (!process.stdin.isTTY) {
    readLineVisible(prompt).then(resolve);
    return;
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let buf = "";
  let finished = false;
  const done = (value) => {
    if (finished) return;
    finished = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeListener("data", onData);
    process.stdout.write("\n");
    resolve(value);
  };
  const onData = (chunk) => {
    for (const ch of String(chunk)) {
      if (ch === "\r" || ch === "\n") done(buf);
      else if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); } // Ctrl-C: nothing written yet
      else if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
      else if (ch >= " ") buf += ch;
    }
  };
  process.stdin.on("data", onData);
});

const promptAccountId = async (envAuth) => {
  for (;;) {
    const def = envAuth.accountId && ACCOUNT_ID_RE.test(envAuth.accountId) ? envAuth.accountId : "";
    const raw = await readLineVisible(`Cloudflare account id (32-hex${def ? ", Enter keeps the env value" : ""}): `, { def });
    if (ACCOUNT_ID_RE.test(raw)) return raw;
    console.log(`  not a 32-hex account id (${raw.length} chars) — paste the ACCOUNT ID from the Cloudflare dashboard URL`);
  }
};

const promptToken = async (label, envValue) => {
  for (;;) {
    const hint = envValue ? " (Enter keeps the env value)" : "";
    const raw = await readHidden(`${label} (paste, echo suppressed${hint}): `);
    if (raw === "" && envValue && TOKEN_RE.test(envValue)) return envValue;
    if (TOKEN_RE.test(raw)) return raw;
    console.log(`  not a Cloudflare API token shape (expect 20-128 chars of [A-Za-z0-9_-])${raw === "" ? " — empty paste" : ""}; re-paste`);
  }
};

const promptWorkerName = async (envAuth) => {
  for (;;) {
    const def = envAuth.workerName && WORKER_NAME_RE.test(envAuth.workerName) ? envAuth.workerName : "cf-gitea";
    const raw = await readLineVisible(`Worker script name for the profiler (Enter = ${def}): `, { def });
    if (WORKER_NAME_RE.test(raw)) return raw;
    console.log("  not a Worker-name shape (1-64 chars of [a-zA-Z0-9_.-])");
  }
};

const promptConsumers = async (envAuth) => {
  for (;;) {
    const def = envAuth.consumers && parseAllowlist(envAuth.consumers).error === null ? envAuth.consumers : "{}";
    const raw = await readLineVisible(`MONITOR_QUEUE_CONSUMERS allowlist JSON (Enter = ${def === "{}" ? "skip — the /set arm then stays unconfigured" : "keep the env value"}): `, { def });
    const parsed = parseAllowlist(raw);
    if (parsed.error === null) return raw;
    console.log(`  ${parsed.error}`);
  }
};

const collectInteractively = async (envAuth) => ({
  accountId: await promptAccountId(envAuth),
  queuesToken: await promptToken("CLOUDFLARE_QUEUES_TOKEN (Queues Read + Write — the /set loop)", envAuth.queuesToken),
  profileToken: await promptToken("CLOUDFLARE_PROFILE_TOKEN (Workers Scripts Read — the profiler; NOT account-scoped read)", envAuth.profileToken),
  workerName: await promptWorkerName(envAuth),
  consumers: await promptConsumers(envAuth),
});

const collectFromEnv = (envAuth) => {
  const problems = [];
  if (!envAuth.accountId || !ACCOUNT_ID_RE.test(envAuth.accountId)) problems.push("CLOUDFLARE_ACCOUNT_ID must be a 32-hex id");
  if (!envAuth.queuesToken && !envAuth.profileToken) problems.push("set at least one of CLOUDFLARE_QUEUES_TOKEN / CLOUDFLARE_PROFILE_TOKEN");
  for (const name of ["CLOUDFLARE_QUEUES_TOKEN", "CLOUDFLARE_PROFILE_TOKEN"]) {
    const v = envAuth[name === "CLOUDFLARE_QUEUES_TOKEN" ? "queuesToken" : "profileToken"];
    if (v !== null && !TOKEN_RE.test(v)) problems.push(`${name} is not a Cloudflare API token shape`);
  }
  if (problems.length > 0) {
    throw Object.assign(new Error(`--from-env: ${problems.join("; ")}`), { usage: true });
  }
  return {
    accountId: envAuth.accountId,
    queuesToken: envAuth.queuesToken,
    profileToken: envAuth.profileToken,
    workerName: envAuth.workerName && WORKER_NAME_RE.test(envAuth.workerName) ? envAuth.workerName : "cf-gitea",
    consumers: envAuth.consumers ?? "{}",
  };
};

// ---------- reporting ----------

const SCOPE_LABELS = [
  ["queues", "queues  ", "the /set loop — needs Queues Read + Write"],
  ["profiler", "profiler", "the pprof probe — needs Workers Scripts Read ONLY (NOT account-scoped read)"],
];

const printVerdicts = (verdicts, authSourceLine) => {
  console.log("");
  if (authSourceLine) console.log(scrub(authSourceLine));
  for (const [key, label, purpose] of SCOPE_LABELS) {
    const v = verdicts[key === "queues" ? "queuesVerdict" : "profilerVerdict"];
    console.log(`  ${label} (${purpose})`);
    console.log(`    → ${v.verdict}${v.verdict === "ok" ? "" : v.verdict === "missing-auth" ? " — the pre-authorization state" : ""}: ${scrub(v.detail)}`);
  }
  for (const note of verdicts.notes) console.log(`  note: ${scrub(note)}`);
};

const printNextSteps = (verdicts) => {
  console.log(`
NEXT (the store arms the PROBE battery only — the deployed Worker's secrets are separate):
  1. keep the same two tokens OUT of the repo: they live in the 0600 store just written;
  2. arm the Worker-side adapters when you deploy the monitor arms:
       wrangler secret put CLOUDFLARE_QUEUES_TOKEN
       wrangler secret put CLOUDFLARE_PROFILE_TOKEN
  3. re-validate any time (non-interactive): node scripts/setup-monitor-auth.mjs --check
  4. run the battery: node scripts/deploy-probes.mjs monitor-platform`);
  if (verdicts.queuesVerdict.verdict !== "ok" || verdicts.profilerVerdict.verdict !== "ok") {
    console.log("The store was written with these verdicts recorded — fix the failing scope (its class above says whether the token, the account, or the network is at fault) and re-run --check until both scopes answer ok.");
  }
};

// ---------- CLI ----------

const usage = () =>
  "usage: node scripts/setup-monitor-auth.mjs [mode] [options]\n" +
  "\n" +
  "modes:\n" +
  "  (default)       first-run interactive setup: paste the two tokens, validate, persist\n" +
  "  --check         re-validate the persisted store / env non-interactively (NO writes)\n" +
  "  --from-env      non-interactive collect from the CLOUDFLARE_* env names, validate, persist\n" +
  "  --force         with the default mode: re-collect and overwrite an existing store\n" +
  "options:\n" +
  "  --file <path>   the store path (default <repoRoot>/.monitor-auth.json;\n" +
  "                  $MONITOR_AUTH_FILE overrides the default, this flag overrides both)\n" +
  "  --help          this text\n" +
  "\n" +
  "The two tokens (minimal privilege, SEPARATE — SPEC-0021 §4):\n" +
  "  CLOUDFLARE_QUEUES_TOKEN   Queues Read + Write  — the /set closed loop\n" +
  "  CLOUDFLARE_PROFILE_TOKEN  Workers Scripts Read — the pprof probe (account-scoped read NOT needed)\n" +
  "\n" +
  "Validation is DRY-RUN and classifies per scope: ok / permission-denied /\n" +
  "api-unsupported / failure (+ missing-auth before any credential exists).\n" +
  "The wrangler-OAuth token-mint path is UNVERIFIED and intentionally absent —\n" +
  "intake is the pasted token or the env.\n" +
  "\n" +
  "Exit codes: 0 all scopes ok · 1 a verdict is not ok · 2 usage error ·\n" +
  "3 missing-auth (--check, no store and no env credentials).\n" +
  "Test seams: MONITOR_CF_API_BASE (the API origin) and MONITOR_AUTH_FILE —\n" +
  "point them ONLY at a stub/path you own.";

const parseArgs = (argv) => {
  const opts = { check: false, fromEnv: false, force: false, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--from-env") opts.fromEnv = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--file") {
      opts.file = argv[++i];
      if (!opts.file) throw Object.assign(new Error("--file needs a path"), { usage: true });
    } else throw Object.assign(new Error(`unknown argument: ${a} (try --help)`), { usage: true });
  }
  if (opts.check && opts.fromEnv) {
    throw Object.assign(new Error("--check and --from-env are mutually exclusive (--check only validates; --from-env collects)"), { usage: true });
  }
  if (opts.check && opts.force) {
    throw Object.assign(new Error("--check never writes — drop --force"), { usage: true });
  }
  return opts;
};

const authFilePathFor = (opts) => opts.file ?? ((process.env.MONITOR_AUTH_FILE ?? "").trim() || DEFAULT_AUTH_FILE);

/** The --check flow: load store + env, merge (env wins), validate LIVE, print,
 *  exit. Missing credentials entirely → the missing-auth exit (3) BEFORE any
 *  network call — the distinct class the release verdict reads. */
const checkMain = async (filePath) => {
  const fileAuth = await loadAuthFile(filePath);
  if (fileAuth.absent) {
    console.log(`missing-auth: no store at ${filePath} and the fallback is the env names`);
  } else if (fileAuth.error) {
    console.log(`missing-auth: the store is unusable — ${fileAuth.error}`);
  }
  const envAuth = authFromEnv();
  const auth = mergeAuth(envAuth, fileAuth.auth ?? null);
  const hasAny = auth.accountId !== null || auth.queuesToken !== null || auth.profileToken !== null;
  if (!hasAny) {
    console.log("missing-auth: no .monitor-auth.json store and no CLOUDFLARE_* env credentials — run: node scripts/setup-monitor-auth.mjs");
    return 3;
  }
  if (auth.queuesToken !== null) secrets.push(auth.queuesToken);
  if (auth.profileToken !== null) secrets.push(auth.profileToken);
  const source = envAuth.queuesToken || envAuth.profileToken || envAuth.accountId
    ? "env names (they win over the store field-by-field)"
    : `store ${filePath}${fileAuth.savedAt ? ` (saved ${fileAuth.savedAt})` : ""}`;
  const verdicts = await runValidation(auth);
  printVerdicts(verdicts, `validating — source: ${source}`);
  const allOk = verdicts.queuesVerdict.verdict === "ok" && verdicts.profilerVerdict.verdict === "ok";
  console.log(allOk ? "check verdict: ALL SCOPES OK" : "check verdict: NOT ALL SCOPES OK (fix the failing class above, then re-run)");
  return allOk ? 0 : 1;
};

/** The default (interactive) flow — refuses to silently overwrite an existing
 *  store; --force re-collects, a declined prompt falls through to --check. */
const interactiveMain = async (filePath, opts) => {
  const existing = await loadAuthFile(filePath);
  if (existing && !existing.absent && !existing.error && !opts.force) {
    console.log(`an auth store already exists: ${filePath} (saved ${existing.savedAt ?? "unknown"}, last validation: ${JSON.stringify(existing.lastValidation ?? "none")})`);
    if (!process.stdin.isTTY) {
      throw Object.assign(new Error("refusing to overwrite non-interactively — pass --force to re-collect, --check to validate only, or --file to relocate"), { usage: true });
    }
    const answer = await readLineVisible("Re-collect and OVERWRITE it? [y/N] ");
    if (!/^y(es)?$/i.test(answer)) return checkMain(filePath);
  } else if (existing && existing.error) {
    console.log(`the existing store is unusable and will be rewritten: ${existing.error}`);
  }
  const envAuth = authFromEnv();
  console.log(`setup-monitor-auth — the ONE-TIME authorization (SPEC-0021 §4). Tokens: never printed, never committed; the store is written 0600 and gitignored. API origin: ${CF_API_ORIGIN === "https://api.cloudflare.com" ? "the real platform" : CF_API_ORIGIN} (test seam MONITOR_CF_API_BASE).`);
  const auth = await collectInteractively(envAuth);
  secrets.push(auth.queuesToken, auth.profileToken);
  const verdicts = await runValidation(auth);
  printVerdicts(verdicts, null);
  await persistAuth(filePath, auth, verdicts);
  console.log(`\nwrote ${filePath} (0600) — the battery loads it unattended from now on`);
  printNextSteps(verdicts);
  return verdicts.queuesVerdict.verdict === "ok" && verdicts.profilerVerdict.verdict === "ok" ? 0 : 1;
};

/** The scripted-bootstrap flow: collect from the env names, validate, persist. */
const fromEnvMain = async (filePath) => {
  const envAuth = authFromEnv();
  const auth = collectFromEnv(envAuth);
  secrets.push(...[auth.queuesToken, auth.profileToken].filter((t) => t !== null));
  console.log(`setup-monitor-auth --from-env — validating the env credentials before persisting (API origin: ${CF_API_ORIGIN === "https://api.cloudflare.com" ? "the real platform" : CF_API_ORIGIN})`);
  const verdicts = await runValidation(auth);
  printVerdicts(verdicts, null);
  await persistAuth(filePath, auth, verdicts);
  console.log(`\nwrote ${filePath} (0600)`);
  printNextSteps(verdicts);
  return verdicts.queuesVerdict.verdict === "ok" && verdicts.profilerVerdict.verdict === "ok" ? 0 : 1;
};

const main = async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`setup-monitor-auth: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  const filePath = authFilePathFor(opts);
  if (opts.check) return checkMain(filePath);
  if (opts.fromEnv) return fromEnvMain(filePath);
  return interactiveMain(filePath, opts);
};

/** Importable (the test file drives the CLI via spawnSync, but the pure
 *  helpers are exported); the flow runs only when invoked directly. */
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .then((code) => {
      process.exit(code ?? 0);
    })
    .catch((err) => {
      console.error(`setup-monitor-auth: ${scrub(err instanceof Error ? err.message : String(err))}`);
      process.exit(err?.usage ? 2 : 1);
    });
}
