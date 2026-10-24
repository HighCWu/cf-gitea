#!/usr/bin/env node
/**
 * bench-run.mjs — external benchmark runner + baseline regression gate.
 * SPEC-0001 §9 / milestone M5 (the required CI benchmark stage, ADR-0001 annex).
 *
 * SYNOPSIS
 *   node scripts/bench-run.mjs --record <milestone> [options]
 *   node scripts/bench-run.mjs --compare <milestone> [options]
 *
 *   Options:
 *     --sizes 5m[,42m,500m]   fixture sizes to run (default "5m"; 42m/500m opt-in)
 *     --base-url <url>        external target (e.g. a dev server CI already
 *                             started). Without it the runner spawns its own
 *                             `pnpm dev` (vite, 127.0.0.1:5173), waits for
 *                             /healthz, and kills it when done.
 *     --token <t>             push/delete auth token (default "devtoken", the
 *                             .dev.vars.example value; reads are public)
 *     --runs <n>              info/refs sample count (default 50)
 *     --baseline-dir <dir>    baseline location (default scripts/bench-baselines)
 *     --results-dir <dir>     transient results dir (default .bench-results)
 *     --fixtures-dir <dir>    fixture location (default .bench-fixtures)
 *     --force                 --record: overwrite an existing baseline
 *
 * MODES
 *   --record <milestone>  runs the suite and writes
 *                         <baseline-dir>/<milestone>.json. Refuses to overwrite
 *                         an existing baseline without --force.
 *   --compare <milestone> runs the suite and compares every recorded metric
 *                         against the baseline; exits 1 if any metric regressed
 *                         by more than 10% (direction-aware: wall times/latencies
 *                        /byte counts are lower-is-better, clone MB/s is
 *                         higher-is-better). A missing baseline file is NOT an
 *                         error: the run is report-only and exits 0 with a clear
 *                         notice — this is the intended state until the first
 *                         real baseline records when SPEC-0001a M2 Step 2 lands
 *                         (the receive path is being rewritten; recording a
 *                         baseline before that would churn).
 *
 * WHAT IS MEASURED (per fixture size; everything from OUTSIDE the worker —
 * stock git client + plain HTTP, no engine instrumentation):
 *   clone_wall_ms / clone_effective_mib_per_s
 *       full `git clone` wall time (incl. working-tree checkout); effective
 *       throughput = fixture pack bytes / wall seconds.
 *   clone_received_bytes / push_bytes / fetch_incremental_bytes
 *       exact wire bytes seen by a local byte-counting forward proxy all
 *       measured git traffic goes through (one localhost hop, constant
 *       across runs — wall times stay comparable; a counting proxy is needed
 *       because git's fetch progress is delay-suppressed and never prints
 *       byte counts for thin fetches).
 *   fetch_incremental_ratio / fetch_incremental_wall_ms
 *       after a one-commit upstream push, `git fetch` in a stale full clone;
 *       ratio = fetched bytes / cloned bytes (thin-negotiation sanity: this
 *       must stay tiny — a jump towards 1.0 means the serve path re-sends
 *       the world).
 *   push_wall_ms
 *       fresh clone -> fixed-content commit -> `git push`, timed on the push
 *       only; push_bytes is the exact request-body byte count sent.
 *   inforefs_p50_ms / inforefs_p95_ms (N = --runs, 3 warmups)
 *       GET /<owner>/<repo>.git/info/refs?service=git-upload-pack (protocol v2
 *       advertisement) latency, sequential direct requests (no proxy hop).
 *   internal.*
 *       push/clone cpu_ms, peak memory, subrequest counts — NOT observable
 *       from outside the worker. Present as null placeholders so the baseline
 *       schema is stable; TODO(M2 instrumentation): SPEC-0001a Step 2's T3
 *       counter (per-push DO-call/subrequest metering, T1/T2 peak-memory
 *       capture) fills these in; the compare gate skips nulls until then.
 *
 * FIXTURES
 *   Reuses .bench-fixtures/<size>/ when manifest.json exists (determinism:
 *   never regenerates). Only a missing manifest invokes
 *   scripts/gen-bench-fixtures.mjs for that size. Repos are exercised as
 *   `bench/bench-<size>` on the target (create-by-push, wiped with a DELETE
 *   first for a clean slate).
 *
 * OUTPUT
 *   Full results JSON -> <results-dir>/bench-<mode>-<milestone|run>-<ts>.json
 *   (gitignored transient dir; CI uploads it as an artifact on failure). The
 *   baseline file is the same document, written into <baseline-dir>/.
 *
 * REQUIREMENTS: Node >= 22 (global fetch), system git >= 2.22, zero npm deps.
 */
/* global fetch, AbortSignal -- Web globals provided by Node >= 22 (no node: module exports them) */
import { spawn } from "node:child_process";
import console from "node:console";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA_VERSION = 1;
const REGRESSION_THRESHOLD = 0.1; // >10% delta counts as a regression (SPEC-0001 §9)
const INFOREFS_WARMUPS = 3;
const SERVER_WAIT_MS = 90_000;
const OWNER = "bench";
// Metrics where "higher is better"; everything else recorded here is gated as
// lower-is-better. Unknown future keys (e.g. filled internal.* counters) fall
// through to lower-is-better, which is right for cpu/memory/subrequest counts.
const HIGHER_IS_BETTER = new Set(["clone_effective_mib_per_s"]);
// Pure bookkeeping keys that never gate.
const INFORMATIONAL = new Set(["inforefs_n"]);

const usageExit = (msg) => {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node scripts/bench-run.mjs --record <milestone> | --compare <milestone> [options]\n" +
    "  --sizes 5m[,42m,500m]  --base-url <url>  --token <t>  --runs <n>\n" +
    "  --baseline-dir <dir>  --results-dir <dir>  --fixtures-dir <dir>  --force");
  process.exit(2);
};

function parseArgs(argv) {
  const opts = {
    mode: null,
    milestone: null,
    sizes: ["5m"],
    baseUrl: null,
    token: "devtoken",
    runs: 50,
    baselineDir: path.join(repoRoot, "scripts", "bench-baselines"),
    resultsDir: path.join(repoRoot, ".bench-results"),
    fixturesDir: path.join(repoRoot, ".bench-fixtures"),
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usageExit(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--record" || a === "--compare") {
      opts.mode = a.slice(2);
      opts.milestone = next();
    } else if (a === "--sizes") opts.sizes = next().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === "--base-url") opts.baseUrl = next().replace(/\/+$/, "");
    else if (a === "--token") opts.token = next();
    else if (a === "--runs") opts.runs = Number(next());
    else if (a === "--baseline-dir") opts.baselineDir = path.resolve(next());
    else if (a === "--results-dir") opts.resultsDir = path.resolve(next());
    else if (a === "--fixtures-dir") opts.fixturesDir = path.resolve(next());
    else if (a === "--force") opts.force = true;
    else if (a === "-h" || a === "--help") usageExit();
    else usageExit(`unknown argument: ${a}`);
  }
  if (!opts.mode) usageExit("exactly one of --record / --compare is required");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(opts.milestone)) {
    usageExit(`bad milestone name "${opts.milestone}" (letters, digits, dot, dash, underscore)`);
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 10 || opts.runs > 1000) {
    usageExit("--runs must be an integer in [10, 1000]");
  }
  for (const s of opts.sizes) {
    if (!/^(\d+)(k|m|g)$/.test(s)) usageExit(`bad size "${s}" (expected forms like 5m, 42m, 500m)`);
  }
  if (opts.sizes.length === 0) usageExit("--sizes resolved to nothing");
  return opts;
}

// ---------- small helpers ----------

const fmtMiB = (b) => `${(b / 2 ** 20).toFixed(2)} MiB`;
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

function runProcess(cmd, args, { cwd, env = process.env, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${timeoutMs} ms\n${stderr.slice(-2000)}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Git client env: no prompts, no local config surprises (system + global config
 * ignored — same isolation the fixture generator applies), so measured bytes and
 * times depend on the server and the fixture, not on the host's ~/.gitconfig.
 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    LC_ALL: "C",
    LANG: "C",
  };
}

async function git(args, { cwd, timeoutMs } = {}) {
  const r = await runProcess("git", args, { cwd, env: gitEnv(), timeoutMs });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.code})\n${r.stderr.trim().slice(-4000)}`);
  }
  return r;
}

/**
 * Local byte-counting forward proxy. All measured git traffic goes through it
 * so clone/push/fetch byte counts are exact wire bytes on one consistent basis
 * (git's own progress output can't provide them: fetch progress is delayed and
 * never prints for thin fetches). Adds one localhost hop — constant across
 * runs, so wall-time comparisons stay valid. Ops run sequentially; reset()
 * before an op, read() after.
 */
function startByteProxy(targetBase) {
  const target = new URL(targetBase);
  const mod = target.protocol === "https:" ? https : http;
  let sent = 0;
  let recv = 0;
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host };
    const preq = mod.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.on("data", (chunk) => {
          recv += chunk.length;
        });
        pres.pipe(res);
      },
    );
    preq.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`bench proxy upstream error: ${err.message}`);
    });
    req.on("data", (chunk) => {
      sent += chunk.length;
    });
    req.pipe(preq);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        reset: () => {
          sent = 0;
          recv = 0;
        },
        read: () => ({ sent, recv }),
        stop: () =>
          new Promise((resolveStop) => server.close(() => resolveStop())),
      });
    });
  });
}

function percentile(sorted, p) {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

// ---------- dev server (default mode) ----------

/** Spawns `pnpm dev` (vite serves the Worker on 127.0.0.1:5173 — see
 * packages/git-engine/e2e/README.md), polling /healthz until it answers.
 * Returns { baseUrl, stop() }; stop() kills the whole process group. */
async function startDevServer(resultsDir) {
  const baseUrl = "http://127.0.0.1:5173";
  const logPath = path.join(resultsDir, "dev-server.log");
  const log = fs.openSync(logPath, "a");
  // detached + negative-pid kill: pnpm wraps vite which wraps workerd — kill
  // the group so nothing is orphaned (POSIX; CI and dev hosts are linux).
  const child = spawn("pnpm", ["dev"], { cwd: repoRoot, stdio: ["ignore", log, log], detached: true });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const sig = process.platform === "win32" ? child.pid : -child.pid;
    try {
      process.kill(sig, "SIGTERM");
    } catch { /* already gone */ }
    const exited = new Promise((resolve) => child.once("close", resolve));
    const timer = new Promise((resolve) => setTimeout(resolve, 5000));
    await Promise.race([exited, timer]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(sig, "SIGKILL");
      } catch { /* already gone */ }
    }
    fs.closeSync(log);
  };
  const t0 = performance.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dev server exited early (code ${child.exitCode}) — see ${logPath}`);
    }
    if (performance.now() - t0 > SERVER_WAIT_MS) {
      await stop();
      throw new Error(`dev server did not answer /healthz within ${SERVER_WAIT_MS / 1000}s — see ${logPath}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { baseUrl, stop };
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------- fixtures ----------

/** Reuse .bench-fixtures/<size>/ when the manifest exists (determinism —
 * never regenerate); otherwise invoke the landed generator for that size. */
async function ensureFixture(size, fixturesDir) {
  const sizeDir = path.join(fixturesDir, size);
  const manifestPath = path.join(sizeDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    console.log(`  fixture ${size}: reusing ${path.relative(repoRoot, sizeDir)} (pack ${fmtMiB(manifest.actual_pack_bytes)}, sha1 ${manifest.pack_sha1.slice(0, 12)}..., ${manifest.commits} commits, ${manifest.files} files)`);
    return { size, manifest, repoPath: path.join(sizeDir, "repo.git") };
  }
  console.log(`  fixture ${size}: no manifest at ${path.relative(repoRoot, manifestPath)} — running gen-bench-fixtures for this size only`);
  const r = await runProcess(process.execPath, [path.join(repoRoot, "scripts", "gen-bench-fixtures.mjs"), "--sizes", size, "--out", fixturesDir], {
    cwd: repoRoot,
    timeoutMs: 600_000,
  });
  if (r.code !== 0) {
    throw new Error(`gen-bench-fixtures failed for ${size} (exit ${r.code})\n${r.stderr.trim().slice(-4000)}`);
  }
  process.stderr.write(r.stderr); // generator logs on stderr
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`gen-bench-fixtures reported success but ${manifestPath} is missing`);
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  return { size, manifest, repoPath: path.join(sizeDir, "repo.git") };
}

// ---------- measured operations ----------

async function timeGit(args, cwd) {
  const t0 = performance.now();
  const r = await git(args, { cwd });
  return { wallMs: r2(performance.now() - t0), stderr: r.stderr };
}

/** Measured clone with one retry: a "repository not found" right after the
 * clean-slate DELETE means the clone raced the engine's 2s negative-lookup
 * memo (an isolate-local artifact, not a real failure) — settle past the TTL
 * and retry once; only the successful attempt is timed. */
async function cloneMeasured(args, cwd, cloneDir) {
  try {
    return await timeGit(args, cwd);
  } catch (err) {
    if (!/repository not found/.test(err.message)) throw err;
    console.log("  clone raced the negative-lookup memo window — retrying once after 2s");
    await fsp.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return await timeGit(args, cwd);
  }
}

/** Anonymous protocol-v2 advertisement latency over the pushed fixture repo. */
async function measureInfoRefs(baseUrl, token, size, runs) {
  const url = `${baseUrl}/${OWNER}/bench-${size}.git/info/refs?service=git-upload-pack`;
  const headers = { "Git-Protocol": "version=2" };
  if (token) headers.Authorization = `Basic ${Buffer.from(`x:${token}`).toString("base64")}`;
  for (let i = 0; i < INFOREFS_WARMUPS; i++) await fetch(url, { headers });
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers });
    const body = await res.arrayBuffer();
    samples.push(performance.now() - t0);
    if (res.status !== 200 || !String(res.headers.get("content-type") ?? "").includes("x-git-upload-pack-advertisement")) {
      throw new Error(`info/refs returned ${res.status} ${res.headers.get("content-type")} — body: ${Buffer.from(body).toString("utf8", 0, 200)}`);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    inforefs_p50_ms: r2(percentile(samples, 0.5)),
    inforefs_p95_ms: r2(percentile(samples, 0.95)),
    inforefs_n: runs,
  };
}

// ---------- one size ----------

async function benchSize({ size, manifest, repoPath }, ctx) {
  const name = `bench-${size}`;
  const anonBase = ctx.baseUrl;
  const authBase = ctx.token
    ? ctx.baseUrl.replace("://", `://x:${encodeURIComponent(ctx.token)}@`)
    : ctx.baseUrl;
  // Measured traffic goes through the byte-counting proxy; the initial
  // fixture push and the info/refs latency probe stay direct.
  const anonUrl = `${ctx.proxy.url}/${OWNER}/${name}.git`;
  const proxyAuthBase = ctx.token
    ? ctx.proxy.url.replace("://", `://x:${encodeURIComponent(ctx.token)}@`)
    : ctx.proxy.url;
  const authPushUrl = `${proxyAuthBase}/${OWNER}/${name}.git`;
  // Same client flags as the e2e suite: no credential helper, no detach advice
  // noise on clone.
  const GITC = ["-c", "credential.helper=", "-c", "advice.detachedHead=false"];
  const metrics = {};
  const notes = [];

  // Clean slate: create-by-push below needs the repo absent (repeat runs).
  await fetch(`${anonBase}/${OWNER}/${name}`, {
    method: "DELETE",
    headers: ctx.token ? { Authorization: `Basic ${Buffer.from(`x:${ctx.token}`).toString("base64")}` } : {},
  }).catch(() => {}); // 404 on first ever run is fine
  // The engine memoizes negative repo lookups for 2s per isolate
  // (INFO_NEG_TTL_MS, packages/git-engine/src/mod.ts): without this settle
  // delay a clone that lands on the DELETE's isolate within the window 404s
  // with "repository not found" even though the push below just recreated it.
  // (The e2e suite out-runs the window by accident: its repo setup takes >2s.)
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Initial upload of the fixture history (setup, untimed).
  console.log(`  pushing fixture -> ${OWNER}/${name} (create-by-push)`);
  await git([...GITC, "push", "-q", authBase + `/${OWNER}/${name}.git`, "main"], { cwd: repoPath });

  // 1. Full clone: wall time + exact received bytes + effective MB/s.
  const cloneDir = path.join(ctx.workDir, `clone-${size}`);
  console.log("  measuring full clone");
  ctx.proxy.reset();
  const clone = await cloneMeasured([...GITC, "clone", anonUrl, cloneDir], ctx.workDir, cloneDir);
  metrics.clone_wall_ms = clone.wallMs;
  metrics.clone_received_bytes = ctx.proxy.read().recv;
  metrics.clone_effective_mib_per_s = r2((manifest.actual_pack_bytes / 2 ** 20) / (clone.wallMs / 1000));

  // 2. info/refs advertisement latency (p50/p95 over --runs; direct, no proxy).
  console.log(`  measuring info/refs latency (N=${ctx.runs})`);
  Object.assign(metrics, await measureInfoRefs(anonBase, ctx.token, size, ctx.runs));

  // 3. Push wall time: fresh clone -> fixed-content commit -> push.
  //    Fixed file name/content/message keep the pushed pack byte-stable.
  const pushDir = path.join(ctx.workDir, `push-${size}`);
  console.log("  measuring push (fresh clone -> commit -> push)");
  await cloneMeasured([...GITC, "clone", anonUrl, pushDir], ctx.workDir, pushDir);
  await fsp.writeFile(path.join(pushDir, "bench-push.txt"), `bench push marker for ${name}\n`);
  const ident = ["-c", "user.name=Bench Runner", "-c", "user.email=bench@example.invalid"];
  await git(["add", "bench-push.txt"], { cwd: pushDir });
  await git([...ident, "commit", "-qm", `bench: push sample (${name})`], { cwd: pushDir });
  ctx.proxy.reset();
  const push = await timeGit([...GITC, ...ident, "push", authPushUrl, "main"], pushDir);
  metrics.push_wall_ms = push.wallMs;
  metrics.push_bytes = ctx.proxy.read().sent;

  // 4. Incremental fetch from the now-stale first clone (thin negotiation).
  console.log("  measuring incremental fetch (stale clone)");
  ctx.proxy.reset();
  const inc = await timeGit([...GITC, "fetch", "origin"], cloneDir);
  metrics.fetch_incremental_wall_ms = inc.wallMs;
  metrics.fetch_incremental_bytes = ctx.proxy.read().recv;
  metrics.fetch_incremental_ratio = r6(metrics.fetch_incremental_bytes / metrics.clone_received_bytes);
  if (metrics.fetch_incremental_ratio > 0.5) {
    notes.push(`incremental fetch received ${metrics.fetch_incremental_bytes} B of ${metrics.clone_received_bytes} B — thin negotiation looks broken (ratio ${metrics.fetch_incremental_ratio}); the gate will flag this at compare time`);
  }

  // Internal placeholders: not observable from outside the worker. Filled by
  // the M2 Step 2 T3 counter (SPEC-0001a) — see header comment.
  metrics.internal = {
    push_cpu_ms: null, // TODO(M2 instrumentation): SPEC-0001a Step 2 T3 counter
    push_peak_memory_bytes: null, // TODO(M2 instrumentation): T2 capture
    push_subrequests: null, // TODO(M2 instrumentation): SPEC-0001a Step 2 T3 counter
    clone_cpu_ms: null, // TODO(M2 instrumentation)
    clone_peak_memory_bytes: null, // TODO(M2 instrumentation)
    clone_subrequests: null, // TODO(M2 instrumentation)
  };

  return { metrics, notes };
}

// ---------- results / baseline ----------

async function gitVersion() {
  const r = await runProcess("git", ["--version"]);
  return r.stdout.trim() || "git (version unknown)";
}

async function runSuite(opts) {
  await fsp.mkdir(opts.resultsDir, { recursive: true });
  const results = {
    schema_version: SCHEMA_VERSION,
    mode: opts.mode,
    milestone: opts.milestone,
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      git: await gitVersion(),
      platform: `${process.platform} ${os.arch()}`,
      base_url: opts.baseUrl,
      note: "internal.* metrics are null placeholders — filled by TODO(M2 instrumentation) (SPEC-0001a Step 2 T3 counter)",
    },
    sizes: {},
  };

  let ownServer = null;
  let proxy = null;
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `cgit-bench-${runId}-`));
  try {
    if (opts.baseUrl) {
      console.log(`target: external server at ${opts.baseUrl}`);
      // Tolerate a target that is mid-restart (vite restarts workerd on file
      // changes): poll /healthz for up to 15s instead of failing instantly.
      const t0 = performance.now();
      for (;;) {
        try {
          const res = await fetch(`${opts.baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) break;
        } catch { /* retry until the budget runs out */ }
        if (performance.now() - t0 > 15_000) {
          throw new Error(`--base-url target ${opts.baseUrl} never answered /healthz`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } else {
      console.log("target: spawning dev server (pnpm dev -> vite 127.0.0.1:5173)");
      ownServer = await startDevServer(opts.resultsDir);
      opts.baseUrl = ownServer.baseUrl;
      results.environment.base_url = opts.baseUrl;
    }
    proxy = await startByteProxy(opts.baseUrl);

    for (const size of opts.sizes) {
      console.log(`[size ${size}]`);
      const fixture = await ensureFixture(size, opts.fixturesDir);
      const { metrics, notes } = await benchSize(fixture, {
        baseUrl: opts.baseUrl,
        proxy,
        token: opts.token,
        runs: opts.runs,
        workDir,
      });
      results.sizes[size] = { fixture: { ...fixture.manifest, repo: path.relative(repoRoot, fixture.repoPath) }, metrics, notes };
      const m = metrics;
      console.log(
        `  clone ${m.clone_wall_ms} ms (${m.clone_effective_mib_per_s} MiB/s)` +
        ` | push ${m.push_wall_ms} ms | fetch ${m.fetch_incremental_bytes ?? "?"} B (ratio ${m.fetch_incremental_ratio ?? "?"})` +
        ` | info/refs p50 ${m.inforefs_p50_ms} ms / p95 ${m.inforefs_p95_ms} ms`,
      );
    }
  } finally {
    if (proxy) await proxy.stop();
    if (ownServer) {
      console.log("stopping spawned dev server");
      await ownServer.stop();
    }
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  return results;
}

const FMT = {
  clone_effective_mib_per_s: (v) => `${v} MiB/s`,
  fetch_incremental_ratio: (v) => String(v),
};

function compareAgainstBaseline(results, baseline, sizes) {
  // Returns { failures: [string], checked: n, skipped: [string] }.
  const failures = [];
  const skipped = [];
  let checked = 0;
  for (const size of sizes) {
    const base = baseline?.sizes?.[size]?.metrics;
    const cur = results.sizes[size]?.metrics;
    if (!base || !cur) {
      skipped.push(`${size}: no baseline metrics — report-only`);
      continue;
    }
    const flatBase = flatten(base);
    for (const [key, curVal] of Object.entries(flatten(cur))) {
      if (INFORMATIONAL.has(key)) continue;
      const baseVal = flatBase[key];
      if (typeof baseVal !== "number" || typeof curVal !== "number") {
        if (baseVal === null || curVal === null) skipped.push(`${size}.${key}: null (not instrumented yet)`);
        continue;
      }
      checked++;
      const higher = HIGHER_IS_BETTER.has(key);
      // worse = bigger for lower-is-better metrics, smaller for higher-is-better
      const worseDelta = higher ? baseVal - curVal : curVal - baseVal;
      const pct = baseVal === 0 ? (worseDelta > 0 ? Infinity : 0) : worseDelta / Math.abs(baseVal);
      if (pct > REGRESSION_THRESHOLD) {
        const fmt = FMT[key] ?? String;
        failures.push(
          `${size}.${key}: baseline ${fmt(baseVal)} -> now ${fmt(curVal)} ` +
          `(${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}% vs allowed -${REGRESSION_THRESHOLD * 100}%)`,
        );
      }
    }
  }
  return { failures, checked, skipped };
}

/** metrics object -> flat map with dotted keys (internal.* included). */
function flatten(metrics, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(metrics)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

function printCompare(results, { failures, checked, skipped }) {
  console.log("\ncomparison vs baseline (gate: >10% worse on any recorded metric):");
  for (const size of Object.keys(results.sizes)) {
    for (const [key, val] of Object.entries(flatten(results.sizes[size].metrics))) {
      if (INFORMATIONAL.has(key)) continue;
      console.log(`  ${`${size}.${key}`.padEnd(36)} ${FMT[key] ? FMT[key](val) : String(val)}`);
    }
  }
  for (const s of skipped) console.log(`  [skip] ${s}`);
  console.log(`  checked ${checked} metric(s)`);
  if (failures.length > 0) {
    console.error("\nREGRESSIONS:");
    for (const f of failures) console.error(`  ${f}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baselinePath = path.join(opts.baselineDir, `${opts.milestone}.json`);

  if (opts.mode === "record") {
    if (!opts.force && fs.existsSync(baselinePath)) {
      usageExit(`baseline ${baselinePath} already exists — pass --force to overwrite`);
    }
  }

  const results = await runSuite(opts);
  const resultsFile = path.join(
    opts.resultsDir,
    `bench-${opts.mode}-${opts.milestone}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`,
  );
  await fsp.writeFile(resultsFile, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nresults written to ${path.relative(repoRoot, resultsFile)}`);

  if (opts.mode === "record") {
    await fsp.mkdir(opts.baselineDir, { recursive: true });
    await fsp.writeFile(baselinePath, JSON.stringify(results, null, 2) + "\n");
    console.log(`baseline recorded: ${path.relative(repoRoot, baselinePath)}`);
    return 0;
  }

  // compare mode
  if (!fs.existsSync(baselinePath)) {
    console.log(
      `\nNOTICE: no baseline at ${path.relative(repoRoot, baselinePath)} — ` +
      "report-only run, regression gate inactive (exit 0). " +
      "Per the deferred-baseline policy the first real baseline records when " +
      "SPEC-0001a M2 Step 2 (receive data plane) lands; until then CI stays green.",
    );
    return 0;
  }
  const baseline = JSON.parse(await fsp.readFile(baselinePath, "utf8"));
  if (baseline.schema_version !== SCHEMA_VERSION) {
    throw new Error(`baseline schema_version ${baseline.schema_version} != runner ${SCHEMA_VERSION} — re-record the baseline`);
  }
  const cmp = compareAgainstBaseline(results, baseline, opts.sizes);
  printCompare(results, cmp);
  if (cmp.failures.length > 0) {
    console.error(`\nbenchmark regression gate FAILED (${cmp.failures.length} metric(s) worse than +${REGRESSION_THRESHOLD * 100}%)`);
    return 1;
  }
  console.log("benchmark regression gate PASSED");
  return 0;
}

// main-guard so verification harnesses can import the helpers (startDevServer).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[fatal] ${err.message}`);
      process.exit(1);
    });
}
