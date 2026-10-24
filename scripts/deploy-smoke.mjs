#!/usr/bin/env node
/**
 * deploy-smoke.mjs — production smoke-test automation (zero npm deps, Node >= 22).
 *
 *   node scripts/deploy-smoke.mjs --base-url https://<worker>.workers.dev [options]
 *
 * Options:
 *   --base-url <url>     target Worker origin (required)
 *   --token <PAT>        personal access token for the write path (Basic password)
 *   --user <name>        owner namespace for the smoke repo (default "smoke-bot")
 *   --migrate-check      verify the remote D1 schema (wrangler auth required)
 *   --bench-report       run scripts/bench-run.mjs --compare m2-pre --sizes 5m
 *                        against --base-url (report-only, never fails the smoke;
 *                        bench-run manages its own bench/bench-5m repo on the
 *                        target — create-by-push, left behind on success)
 *   --timeout-ms <n>     per-request HTTP timeout (default 20000)
 *   --json               stdout carries ONLY the final JSON summary (progress
 *                        goes to stderr); without it, human progress + the same
 *                        JSON summary both print to stdout
 *   --help
 *
 * Checks (each reported pass/fail; exit 1 iff any check FAILS):
 *   a. GET /healthz -> 200 {"ok":true}.
 *   b. anonymous info/refs on a random nonexistent repo: upload-pack answers
 *      404 (text/plain, "repository not found") or 401 Basic challenge, and
 *      receive-pack answers 401 (www-authenticate: Basic) or 404 — either
 *      proves the git smart-HTTP surface answers; headers asserted sane.
 *   c. with --token: authenticated receive advert on a fresh random repo
 *      (200 + pkt-line `# service=git-receive-pack` + `capabilities^{}`),
 *      then a REAL tiny push (temp dir, one commit, `git push`), then
 *      `git ls-remote` asserting the ref, then best-effort cleanup via the
 *      engine's DELETE endpoint (a failed cleanup is documented, not fatal).
 *   d. --migrate-check: `wrangler d1 execute cf-gitea --remote --json` over
 *      sqlite_master — every expected table must exist (missing ones are
 *      reported by name).
 *   e. --bench-report: never affects the exit code.
 *
 * Leftovers in production: with --token the script deletes the smoke repo it
 * pushed; if the DELETE endpoint is unreachable the repo `<user>/smoke-<hex>`
 * stays behind and is reported (check detail + "left_behind" in the summary).
 */
/* global fetch, AbortSignal -- Web globals provided by Node >= 22 (no node: module exports them) */
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const BENCH_RUN = path.join(repoRoot, "scripts", "bench-run.mjs");
const DEFAULT_USER = "smoke-bot";

/** Tables the three committed migrations must have created (0000-0002). */
const EXPECTED_TABLES = [
  // 0000_spotty_toad
  "repositories",
  // 0001_cool_secret_warriors
  "auth_failures", "personal_access_tokens", "users",
  // 0002_tearful_kulan_gath (issues/PRs tier)
  "comments", "commit_statuses", "issue_labels", "issue_pins",
  "issue_subscriptions", "issues", "labels", "milestones", "pull_requests",
  "reactions", "release_assets", "releases", "repo_counters",
  "webhook_deliveries", "webhooks",
];

// ---------- CLI ----------

const parseArgs = (argv) => {
  const opts = {
    baseUrl: null, token: null, user: DEFAULT_USER,
    migrateCheck: false, benchReport: false, json: false, timeoutMs: 20_000, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") opts.help = true;
    else if (a === "--migrate-check") opts.migrateCheck = true;
    else if (a === "--bench-report") opts.benchReport = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--user") opts.user = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.help) {
    if (!opts.baseUrl) throw new Error("--base-url is required");
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error(`--base-url must be an http(s) URL: ${opts.baseUrl}`);
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
    opts.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }
  return opts;
};

const usage = () =>
  "usage: node scripts/deploy-smoke.mjs --base-url <url> [--token <PAT>] [--user <name>]\n" +
  "                [--migrate-check] [--bench-report] [--timeout-ms <n>] [--json]";

// ---------- plumbing ----------

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(usage());
  process.exit(0);
}
const jsonMode = opts.json;
const log = (...args) => (jsonMode ? console.error(...args) : console.log(...args));
const startedAt = new Date();

const results = [];
const leftBehind = [];

/** Every fetch is timeout-guarded (AbortSignal); redirects are surfaced, not followed. */
const fetchT = (url, init = {}) =>
  fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(opts.timeoutMs) });

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

/** execFile as a promise; never throws — the caller decides what failure means. */
const run = (cmd, args, { cwd, timeoutMs = 90_000, env } = {}) =>
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

const hexId = (n = 8) => randomUUID().replaceAll("-", "").slice(0, n);

/** git pkt-line framing (smart-HTTP advertisement): 4 hex length chars + payload. */
const pktLine = (s) => {
  const payload = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0"), "latin1"), payload]);
};

/**
 * Run one check, record {id, status, detail, ms}, print a progress line. The
 * checked fn returns a detail string (pass) or {status: "warn"|"info", detail}
 * for outcomes that never fail the smoke; throwing = fail.
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
  // The PAT must never leak into logs/summaries (git redacts credentials in
  // its own messages; this catches anything else that embeds the URL/token).
  if (opts.token) detail = detail.split(opts.token).join("***");
  const ms = Math.round(performance.now() - t0);
  results.push({ id, status, detail, ms });
  log(`  [${status}] ${id} (${ms} ms)${detail ? ` — ${detail}` : ""}`);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------- checks ----------

/** a. /healthz -> {"ok":true} */
const checkHealthz = async () => {
  const res = await fetchT(`${opts.baseUrl}/healthz`);
  const body = await res.text();
  expect(res.status === 200, `status ${res.status} ${res.statusText} (expected 200)`);
  expect(String(res.headers.get("content-type") ?? "").includes("application/json"),
    `content-type ${res.headers.get("content-type")} (expected application/json)`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`body is not JSON: ${body.slice(0, 120)}`);
  }
  expect(parsed.ok === true, `body ${body.slice(0, 120)} (expected {"ok":true})`);
  return `{"ok":true}`;
};

/**
 * b. anonymous info/refs on a random nonexistent repo. Accept 404 (engine's
 * "repository not found") or 401 (Basic challenge) per probe — both prove the
 * git surface answers; anything else (an advert for a repo that does not
 * exist, a 5xx, an HTML error page) fails.
 */
const checkAnonSurface = async () => {
  const owner = `probe-${hexId()}`;
  const repo = `probe-${hexId()}`;
  const notes = [];
  for (const service of ["git-upload-pack", "git-receive-pack"]) {
    const res = await fetchT(`${opts.baseUrl}/${owner}/${repo}.git/info/refs?service=${service}`);
    const ct = String(res.headers.get("content-type") ?? "");
    const body = (await res.text()).slice(0, 200);
    expect(res.status === 404 || res.status === 401,
      `${service}: status ${res.status} content-type ${ct} body ${body} (expected 404 or 401 challenge)`);
    if (res.status === 401) {
      expect(String(res.headers.get("www-authenticate") ?? "").includes("Basic"),
        `${service}: 401 without a www-authenticate: Basic challenge`);
      notes.push(`${service} 401 Basic challenge`);
    } else {
      expect(ct.startsWith("text/plain"), `${service}: 404 with content-type ${ct} (expected text/plain)`);
      expect(body.includes("not found"), `${service}: 404 body ${body} (expected a not-found report)`);
      notes.push(`${service} 404 not-found`);
    }
  }
  return `${owner}/${repo}.git: ${notes.join(", ")}`;
};

/**
 * c. token path: receive advert on a fresh random repo, real push, ls-remote,
 * best-effort DELETE cleanup. Only invoked with --token.
 */
const smokeRepo = () => `smoke-${hexId()}`;

const checkReceiveAdvert = async (user, repo) => {
  const res = await fetchT(`${opts.baseUrl}/${user}/${repo}.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: basic(user, opts.token) },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("latin1");
  const serviceLine = pktLine("# service=git-receive-pack\n").toString("latin1");
  expect(res.status === 200, `status ${res.status} (expected 200): ${text.slice(0, 120)}`);
  expect(String(res.headers.get("content-type") ?? "") === "application/x-git-receive-pack-advertisement",
    `content-type ${res.headers.get("content-type")} (expected application/x-git-receive-pack-advertisement)`);
  expect(text.startsWith(serviceLine), `body does not open with the pkt-line service header: ${text.slice(0, 120)}`);
  expect(text.slice(serviceLine.length, serviceLine.length + 4) === "0000", "no flush pkt after the service header");
  expect(text.includes("capabilities^{}"), `no capabilities^{} ref in the advert: ${text.slice(0, 200)}`);
  return `advert ok (${buf.length} bytes)`;
};

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" };
const git = (args, cwd) => run("git", ["-c", "credential.helper=", ...args], { cwd, env: GIT_ENV });

const checkPushAndLsRemote = async (user, repo) => {
  const target = new URL(opts.baseUrl);
  const basePath = target.pathname.replace(/\/+$/, "");
  const pushUrl =
    `${target.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(opts.token)}@${target.host}` +
    `${basePath}/${user}/${repo}.git`;
  const anonUrl = `${opts.baseUrl}/${user}/${repo}.git`;

  const tmp = await mkdtemp(path.join(os.tmpdir(), "cf-gitea-smoke-"));
  try {
    let r = await git(["init"], tmp);
    expect(r.ok, `git init failed: ${r.stderr.trim()}`);
    await writeFile(path.join(tmp, "README.md"),
      `# cf-gitea deploy smoke\n\nThrowaway repo created by scripts/deploy-smoke.mjs at ${startedAt.toISOString()}.\n`);
    r = await git(["add", "-A"], tmp);
    expect(r.ok, `git add failed: ${r.stderr.trim()}`);
    r = await git(["-c", "user.name=cf-gitea-smoke", "-c", "user.email=smoke@cf-gitea.invalid",
      "commit", "-m", "deploy-smoke: tiny push"], tmp);
    expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
    r = await git(["push", pushUrl, "HEAD:refs/heads/main"], tmp);
    expect(r.ok, `git push failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);

    r = await git(["ls-remote", anonUrl, "refs/heads/main"]);
    expect(r.ok, `git ls-remote failed: ${r.stderr.trim()}`);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length === 1, `ls-remote returned ${lines.length} refs (expected exactly refs/heads/main): ${r.stdout.trim()}`);
    const [oid, ref] = lines[0].split("\t");
    expect(/^[0-9a-f]{40}$/.test(oid) && !/^0+$/.test(oid), `ls-remote returned a non-oid: ${lines[0]}`);
    expect(ref === "refs/heads/main", `ls-remote returned ${ref} (expected refs/heads/main)`);
    return `pushed ${oid.slice(0, 10)}…, ls-remote sees ${ref}`;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

const checkCleanup = async (user, repo) => {
  const res = await fetchT(`${opts.baseUrl}/${user}/${repo}`, {
    method: "DELETE",
    headers: { Authorization: basic("x", opts.token) },
  });
  const body = (await res.text()).trim();
  if (res.status === 200 && body === "deleted") return `repo ${user}/${repo} deleted`;
  leftBehind.push(`repo ${user}/${repo} (DELETE returned ${res.status} ${body.slice(0, 80)})`);
  return {
    status: "warn",
    detail: `repo ${user}/${repo} LEFT BEHIND — DELETE returned ${res.status} ${body.slice(0, 80)}`,
  };
};

/**
 * d. remote D1 schema via wrangler (same invocation pattern as
 * scripts/setup-deploy.mjs / bootstrap-admin.mjs).
 */
const checkMigrations = async () => {
  const r = await run("pnpm",
    ["exec", "wrangler", "d1", "execute", "cf-gitea", "--remote", "--json",
      "--command", "SELECT name FROM sqlite_master WHERE type = 'table'"],
    { cwd: workerDir, timeoutMs: 120_000 });
  expect(r.ok, `wrangler d1 execute failed (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`wrangler --json output is not JSON: ${r.stdout.slice(0, 200)}`);
  }
  const tables = (parsed.at(-1)?.results ?? []).map((row) => row.name);
  expect(tables.length > 0, `no tables reported by sqlite_master (raw: ${r.stdout.slice(0, 200)})`);
  const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
  expect(missing.length === 0, `missing tables: ${missing.join(", ")} (present: ${tables.slice().sort().join(", ")})`);
  const extra = tables.filter((t) => !EXPECTED_TABLES.includes(t));
  return `all ${EXPECTED_TABLES.length} expected tables present` +
    (extra.length ? ` (+${extra.length} system/aux: ${extra.join(", ")})` : "");
};

/**
 * e. bench-run report-only pass-through — its outcome NEVER affects the exit
 * code (recorded as "info").
 */
const checkBenchReport = async () => {
  let benchStat;
  try {
    benchStat = await stat(BENCH_RUN);
  } catch {
    return { status: "skip", detail: "scripts/bench-run.mjs not found" };
  }
  expect(benchStat.isFile(), `${BENCH_RUN} is not a file`);
  log("  bench-run starting (report-only; its own output follows)...");
  const r = await run(process.execPath,
    [BENCH_RUN, "--compare", "m2-pre", "--sizes", "5m", "--base-url", opts.baseUrl,
      ...(opts.token ? ["--token", opts.token] : [])],
    { timeoutMs: 600_000 });
  const out = `${r.stdout}${r.stderr}`.trim();
  if (out) log(out.split("\n").map((l) => `    ${l}`).join("\n"));
  return {
    status: "info",
    detail: `bench-run exited ${r.code}${r.killed ? " (timed out)" : ""} — report-only, not counted`,
  };
};

// ---------- main ----------

log(`cf-gitea deploy smoke — ${opts.baseUrl}`);

await check("healthz", checkHealthz);
await check("anon-git-surface", checkAnonSurface);

if (opts.token) {
  const user = opts.user;
  const repo = smokeRepo();
  const ran = new Map();
  await check("receive-advert", () => checkReceiveAdvert(user, repo));
  ran.set("receive-advert", results.at(-1).status);
  if (ran.get("receive-advert") === "pass") {
    await check("push-lsremote", () => checkPushAndLsRemote(user, repo));
  } else {
    results.push({ id: "push-lsremote", status: "skip", detail: "receive advert failed", ms: 0 });
    log("  [skip] push-lsremote — receive advert failed");
  }
  if (results.find((r) => r.id === "push-lsremote").status === "pass") {
    await check("cleanup", () => checkCleanup(user, repo));
  } else {
    results.push({ id: "cleanup", status: "skip", detail: "push did not pass", ms: 0 });
    log("  [skip] cleanup — push did not pass");
  }
} else {
  results.push(
    { id: "receive-advert", status: "skip", detail: "no --token", ms: 0 },
    { id: "push-lsremote", status: "skip", detail: "no --token", ms: 0 },
    { id: "cleanup", status: "skip", detail: "no --token", ms: 0 },
  );
  log("  [skip] token checks — no --token given (healthz + anonymous surface only)");
}

if (opts.migrateCheck) {
  await check("migrate-check", checkMigrations);
} else {
  results.push({ id: "migrate-check", status: "skip", detail: "no --migrate-check", ms: 0 });
  log("  [skip] migrate-check — not requested");
}

if (opts.benchReport) {
  await check("bench-report", checkBenchReport);
} else {
  results.push({ id: "bench-report", status: "skip", detail: "no --bench-report", ms: 0 });
  log("  [skip] bench-report — not requested");
}

const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
const summary = {
  tool: "deploy-smoke",
  base_url: opts.baseUrl,
  started_at: startedAt.toISOString(),
  duration_ms: Date.now() - startedAt.getTime(),
  ok: counts.fail === 0,
  summary: counts,
  checks: results.map(({ id, status, detail, ms }) => ({ id, status, detail, ms })),
  ...(leftBehind.length ? { left_behind: leftBehind } : {}),
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = counts.fail === 0 ? 0 : 1;
