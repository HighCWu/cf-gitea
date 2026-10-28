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
 *     --token <t>             push/delete auth credential (default "devtoken",
 *                             the .dev.vars.example GIT_TOKEN; local reads are
 *                             public so only the push needs it)
 *     --user <name>           PRODUCTION MODE: create-by-push the fixtures
 *                             into this user's namespace (the token's own
 *                             user, deploy-smoke conventions). Requires an
 *                             explicit --token. Repo names become
 *                             bench-<size>-<hex> (unique per run, like the
 *                             smoke's). Measured read legs authenticate with
 *                             the same credential — push-created repos are
 *                             PRIVATE by default (DefaultPushCreatePrivate).
 *     --public-fixtures       with --user: flip each fixture repo public via
 *                             PATCH /api/v1/repos/<owner>/<repo> right after
 *                             the push; the measured clone/fetch/info-refs
 *                             legs then run ANONYMOUS (same traffic shape as
 *                             the local baseline). The push stays
 *                             authenticated. Minimal honest trade-off: either
 *                             you measure the real private-repo auth path
 *                             (default) or the public-read path this flag
 *                             selects — never an anonymous read of a private
 *                             repo (that is a 401, not a number).
 *     --remote                REQUIRED for a non-localhost --base-url:
 *                             acknowledges the run meters real production
 *                             quota. Prints the estimated fixture size and
 *                             honors a 5s Ctrl-C grace before starting
 *                             unless --yes is passed.
 *     --yes                   skip the --remote 5s grace window
 *     --runs <n>              info/refs sample count (default 50)
 *     --baseline-dir <dir>    baseline location (default scripts/bench-baselines)
 *     --results-dir <dir>     transient results dir (default .bench-results)
 *     --fixtures-dir <dir>    fixture location (default .bench-fixtures)
 *     --force                 --record: overwrite an existing baseline
 *
 * PRODUCTION MODE (non-local --base-url targets)
 *   Remote runs consume real quota (Worker requests, D1 writes, R2 storage),
 *   so three guards hold, enforced before any network I/O:
 *     (1) --remote must be passed explicitly; the run then prints a fixture
 *         size estimate (manifests when present, nominal targets otherwise)
 *         and waits 5s unless --yes.
 *     (2) --user <name> is required: fixtures create-by-push into the token's
 *         own user namespace. The historical fixed `bench` namespace does not
 *         exist in production and 404s (recorded 2026-10-25, p0-evidence), so
 *         it is local-only. Names are unique per run (bench-<size>-<hex>) so
 *         repeat runs never collide with leftovers. Fixtures are LEFT BEHIND
 *         on the target by design (same as the smoke's failure path) — see
 *         sizes.*.remote_repo in the results JSON; DELETE them when desired.
 *     (3) --record is refused outright: BASELINES ARE LOCAL-ONLY.
 *
 * BASELINE POLICY
 *   scripts/bench-baselines/ holds LOCAL workerd numbers only (CI and the m2
 *   gate compare local vs local). Any non-localhost --base-url run is NOT
 *   baseline-comparable — network variance (RTT, TLS, CDN) dwarfs the
 *   regressions this gate exists to catch — so a remote run never reads a
 *   baseline, never writes one, never gates: --compare is report-only (exit 0)
 *   with a clear "not baseline-comparable" banner, --record exits 2.
 *
 * MODES
 *   --record <milestone>  runs the suite and writes
 *                         <baseline-dir>/<milestone>.json. Refuses to overwrite
 *                         an existing baseline without --force.
 *   --compare <milestone> runs the suite and compares every recorded metric
 *                         against the baseline; exits 1 if any metric regressed
 *                         past its tolerance class (direction-aware: wall
 *                         times/latencies/byte counts are lower-is-better,
 *                         clone MB/s is higher-is-better). A missing baseline file is NOT an
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
 *       fresh clone -> fixed-shape commit -> `git push`, timed on the push
 *       only; push_bytes is the exact request-body byte count sent. Both
 *       push_wall_ms and fetch_incremental_wall_ms are MEDIANS over 3
 *       independent push->fetch cycles (see TOLERANCE CLASSES — single-shot
 *       wall times at the ~100 ms scale are fixed-overhead noise); bytes and
 *       ratio come from the median-wall sample so reported numbers stay a
 *       coherent pair. The cycles are byte-pinned: every cycle commits the
 *       same-named marker file with a same-length body and a same-length
 *       message, so each pushed pack has the same object shape and the
 *       median-sample byte selection cannot swing the metric (pre-pin it
 *       did: 458-506 B purely by which cycle won the median wall time).
 *   inforefs_p50_ms / inforefs_p95_ms (N = --runs, 3 warmups)
 *       GET /<owner>/<repo>.git/info/refs?service=git-upload-pack (protocol v2
 *       advertisement) latency, sequential direct requests (no proxy hop).
 *
 * TOLERANCE CLASSES (why the gate has three bands: overhead wall metrics
 *   2026-10-28, byte-overhead push_bytes 2026-10-29)
 *   On identical code, wall times of sub-second fixed-overhead operations
 *   swing far beyond the 10% band across hosts. Recorded evidence, same
 *   commit, one day: CI run 40710895496 (compare on a different 2-core runner
 *   instance than the one that recorded the ci.json baseline ~1 h earlier)
 *   moved inforefs p50 14.52 -> 48.04 ms (+231%) and p95 16.75 -> 148 ms
 *   (+784%); a local dev-box run of the same commit moved
 *   fetch_incremental 96.18 -> 201.98 ms (+110%) and push 109.81 -> 179.2 ms
 *   (+63%) — while clone, the one metric with real work (a 5.7 MiB transfer),
 *   stayed in band everywhere (783 -> 731 ms on CI, 783 -> 411 ms local).
 *   Within a single dev-box run clone was 2x FASTER than baseline while fetch
 *   was 2x SLOWER — a machine-speed level shift moves everything one way;
 *   these micro wall times just jitter, because they are dominated by fixed
 *   overhead (process spawn, a handful of HTTP round trips, workerd
 *   event-loop state, host scheduling) that does not scale with the code
 *   under test. Class "overhead" (push_wall_ms, fetch_incremental_wall_ms,
 *   inforefs_p50_ms, inforefs_p95_ms) therefore fails only when the
 *   worse-delta exceeds BOTH the 10% band AND 150 ms absolute (calibrated:
 *   the largest observed identical-code noise delta was 131 ms — CI p95).
 *   Byte metrics: clone_received_bytes and fetch_incremental_bytes stay
 *   percentage-only on purpose — they are byte-exact across hosts for a fixed
 *   fixture (identical 5,694,904-byte clones) and carry the gate's real teeth
 *   — a thin-negotiation collapse shows up as fetch_incremental_bytes/ratio
 *   exploding, not as its wall time.
 *   push_bytes used to sit in that class and was the loaded trigger the
 *   calibration unit flagged (drift 459-511 across runs on identical code,
 *   pct-gated lower-is-better). Measured 2026-10-29 through a body-dumping
 *   forward proxy (scratch dissect run): the receive-pack request splits into
 *   a pkt-line command section and the pack stream — the command section was
 *   CONSTANT at 151 B (a single capability echo string, so protocol framing
 *   was NOT the drift), while the pushed pack itself differed per marker
 *   cycle: the old cycles were content-asymmetric (cycle 0 added a new file
 *   on the fixture tip; cycles 1-2 stacked commits whose root trees
 *   accumulated differently-named marker entries), packing 354-355 B vs
 *   307-313 B respectively — the whole 458-506 B observed spread was the
 *   pushed pack, and which of those bytes got reported was decided by which
 *   cycle won the median WALL time. Fix, same date, two halves: (1) pin the
 *   cycles — every cycle commits the same-named marker file with a
 *   same-length body and a same-length message, and never interpolates the
 *   repo name (the production name carries a per-run hex tag), collapsing the
 *   spread to 3 B over 9 pinned pushes (zlib's compressed-length wobble on
 *   the commit timestamp digits); (2) move push_bytes to the "byte-overhead"
 *   class — fails only when the worse-delta exceeds BOTH the 10% band AND
 *   OVERHEAD_ABS_FLOOR_BYTES (64 B) absolute — so that residual wobble and
 *   git-version framing drift (capability echoes grow with agent=git/x.y.z
 *   version digits) can never false-fire, while any real receive-path
 *   regression still moves pack-sized counts that clear it easily.
 *   BASELINE NOTE: ci.json (511) was recorded pre-pin with the asymmetric
 *   shape; the pinned shape sits lower by construction, which the
 *   direction-aware gate reads as an improvement, not a failure — no
 *   re-record needed, the metric schema is unchanged.
 *   Methodology pairing: the overhead wall
 *   metrics are medians over 3 independent push->fetch cycles — median kills
 *   the within-host per-attempt outliers; the absolute floor absorbs the
 *   cross-host level shift that no amount of sampling can remove.
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
 *   scripts/gen-bench-fixtures.mjs for that size. Locally (no --user) repos
 *   are exercised as `bench/bench-<size>` (create-by-push, wiped with a DELETE
 *   first for a clean slate); in production mode they are
 *   `<--user>/bench-<size>-<hex>` — see PRODUCTION MODE above.
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
import { randomUUID } from "node:crypto";
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
// Overhead-class metrics fail only when the worse-delta exceeds BOTH the
// percentage band AND this absolute floor (see TOLERANCE CLASSES in the
// header; calibrated above the 131 ms largest observed identical-code noise
// delta — CI run 40710895496, inforefs p95).
const OVERHEAD_ABS_FLOOR_MS = 150;
// Byte-overhead class: push_bytes' residual variance is framing-level, not
// content-level. The pinned cycles (see benchSize) make every pushed pack
// structurally identical, leaving only zlib's compressed-length wobble on the
// commit timestamp digits (measured 2026-10-29: 3 B spread over 9 pinned
// pushes) plus client-side framing drift across
// git versions (the echoed capability list grows with agent=git/x.y.z version
// digits). A percentage-only gate on a ~0.5 kB metric false-fires on those
// (pre-pin the median-wall sample selection alone swung push_bytes 458-506 B
// across cycles), so push_bytes fails only when the worse-delta exceeds BOTH
// the 10% band AND this absolute floor — calibrated far above the 3 B wobble,
// far below any real receive-path regression (which moves pack-sized counts).
const OVERHEAD_BYTES = new Set(["push_bytes"]);
const OVERHEAD_ABS_FLOOR_BYTES = 64;
// Sub-second fixed-overhead wall metrics (< ~250 ms ops): percentage-only
// gating false-fires on cross-host jitter (2-8x swings on identical code).
const OVERHEAD_METRICS = new Set([
  "push_wall_ms",
  "fetch_incremental_wall_ms",
  "inforefs_p50_ms",
  "inforefs_p95_ms",
]);
// Independent push->fetch cycles behind the median for the two overhead wall
// metrics (single-shot samples at the ~100 ms scale swing 2x within a host).
const PUSH_FETCH_SAMPLES = 3;
const INFOREFS_WARMUPS = 3;
const SERVER_WAIT_MS = 90_000;
const OWNER = "bench"; // LOCAL-dev namespace only (engine GIT_TOKEN path — no D1 user needed); production requires --user (see PRODUCTION MODE)
// Targets whose numbers are baseline-eligible: same-host workerd, no network hop.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SIZE_MULT = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const REMOTE_GRACE_MS = 5_000;
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
    "  --baseline-dir <dir>  --results-dir <dir>  --fixtures-dir <dir>  --force\n" +
    "  production mode: --user <name>  [--public-fixtures]  --remote  --yes");
  process.exit(2);
};

function isLocalTarget(baseUrl) {
  if (!baseUrl) return true; // no --base-url: the runner spawns its own local dev server
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Nominal byte target of a size label (5m -> 5 MiB); 0 when unparseable. */
function sizeTargetBytes(label) {
  const m = /^(\d+)(k|m|g)$/.exec(label);
  return m === null ? 0 : Number(m[1]) * SIZE_MULT[m[2]];
}

/** Best-effort per-size fixture pack estimate for the --remote guard message:
 *  the manifest's actual pack size when the fixture was already generated,
 *  otherwise the nominal target. Synchronous on purpose — it runs in argument
 *  validation, before any network I/O. */
function estimateFixtureBytes(sizes, fixturesDir) {
  const per = [];
  let total = 0;
  for (const size of sizes) {
    let bytes = sizeTargetBytes(size);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, size, "manifest.json"), "utf8"));
      if (typeof manifest.actual_pack_bytes === "number") bytes = manifest.actual_pack_bytes;
    } catch { /* nominal target */ }
    per.push([size, bytes]);
    total += bytes;
  }
  return { per, total };
}

function parseArgs(argv) {
  const opts = {
    mode: null,
    milestone: null,
    sizes: ["5m"],
    baseUrl: null,
    token: "devtoken",
    tokenGiven: false,
    user: null,
    publicFixtures: false,
    remote: false,
    yes: false,
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
    else if (a === "--token") {
      opts.token = next();
      opts.tokenGiven = true;
    } else if (a === "--user") opts.user = next();
    else if (a === "--public-fixtures") opts.publicFixtures = true;
    else if (a === "--remote") opts.remote = true;
    else if (a === "--yes") opts.yes = true;
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
  if (opts.user !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,38}$/.test(opts.user)) {
    usageExit(`bad --user "${opts.user}" (letters, digits, dot, dash, underscore; <= 39 chars)`);
  }

  // ---- production-mode guards (before ANY network I/O; see header) ----
  const remoteTarget = !isLocalTarget(opts.baseUrl);
  if (remoteTarget && !opts.remote) {
    const est = estimateFixtureBytes(opts.sizes, opts.fixturesDir);
    usageExit(
      `--base-url ${opts.baseUrl} is a non-local target: a production run meters real quota ` +
      `(Worker requests, D1 writes, R2 storage — fixture packs ~${fmtMiB(est.total)} for the requested ` +
      `size(s), roughly 3-4x that on the wire across the push/clone/fetch legs, plus ` +
      `${opts.runs + INFOREFS_WARMUPS} info/refs request(s) per size). ` +
      "Re-run with --remote to acknowledge, --yes to skip the 5s grace, and --user <name> for the fixture namespace.",
    );
  }
  if (remoteTarget && !opts.user) {
    usageExit(
      "--user <name> is required for remote targets: fixtures create-by-push into the token's own user " +
      "namespace. The local 'bench' namespace does not exist in production and its pushes 404 " +
      "(recorded 2026-10-25 in docs/design/p0-evidence.md).",
    );
  }
  if (opts.user !== null && !opts.tokenGiven) {
    usageExit("--user requires an explicit --token <PAT>: the namespace owner is the token's user");
  }
  if (opts.publicFixtures && !opts.user) {
    usageExit("--public-fixtures requires --user <name>: the visibility flip authenticates with the token");
  }
  if (remoteTarget && opts.mode === "record") {
    usageExit(
      "--record is local-only: baselines are recorded from local workerd runs and remote numbers are " +
      "not baseline-comparable (network variance). Use --compare for a report-only remote run.",
    );
  }
  opts.remote = remoteTarget;
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

/** Median of an odd-length array of { wallMs, ... } samples, by wallMs.
 *  Only ever called with PUSH_FETCH_SAMPLES (odd) — exact middle element. */
function medianSample(samples) {
  return [...samples].sort((a, b) => a.wallMs - b.wallMs)[Math.floor(samples.length / 2)];
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

/** Protocol-v2 advertisement latency over the pushed fixture repo. The request
 *  is authenticated unless the fixture repo is deliberately public
 *  (--public-fixtures): push-created repos are private-by-default and an
 *  anonymous read of a private repo is a 401, not a number. */
async function measureInfoRefs(url, auth, runs) {
  const headers = { "Git-Protocol": "version=2" };
  if (auth) headers.Authorization = auth;
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
  const name = ctx.repoName;
  const owner = ctx.owner;
  // Credential shape: deploy-smoke conventions — pushes authenticate as
  // `<user>:<token>` in production (create-by-push under the token's own
  // user), `x:devtoken` against the local engine GIT_TOKEN path.
  const basicUser = ctx.user ?? "x";
  const basicHeader = `Basic ${Buffer.from(`${basicUser}:${ctx.token}`).toString("base64")}`;
  const creds = `${encodeURIComponent(basicUser)}:${encodeURIComponent(ctx.token)}`;
  const withCreds = (base) => base.replace("://", `://${creds}@`);
  // Measured read legs: anonymous ONLY when the fixture repo is deliberately
  // public (--public-fixtures). Production default is fully authenticated
  // (push-created repos are private, DefaultPushCreatePrivate); local reads
  // of engine-path repos are public, so local keeps the anonymous shape.
  const readWithCreds = ctx.user !== null && !ctx.publicFixtures;
  const pushUrl = withCreds(`${ctx.baseUrl}/${owner}/${name}.git`);
  const proxyPushUrl = withCreds(`${ctx.proxy.url}/${owner}/${name}.git`);
  const cloneUrl = readWithCreds
    ? withCreds(`${ctx.proxy.url}/${owner}/${name}.git`)
    : `${ctx.proxy.url}/${owner}/${name}.git`;
  // Same client flags as the e2e suite: no credential helper, no detach advice
  // noise on clone.
  const GITC = ["-c", "credential.helper=", "-c", "advice.detachedHead=false"];
  const metrics = {};
  const notes = [];

  // Clean slate: create-by-push below needs the repo absent (defensive — the
  // production names are unique per run, so this DELETE is a 404 no-op unless
  // a previous attempt with the same tag crashed mid-run).
  await fetch(`${ctx.baseUrl}/${owner}/${name}`, {
    method: "DELETE",
    headers: ctx.token ? { Authorization: basicHeader } : {},
  }).catch(() => {}); // 404 on first ever run is fine
  // The engine memoizes negative repo lookups for 2s per isolate
  // (INFO_NEG_TTL_MS, packages/git-engine/src/mod.ts): without this settle
  // delay a clone that lands on the DELETE's isolate within the window 404s
  // with "repository not found" even though the push below just recreated it.
  // (The e2e suite out-runs the window by accident: its repo setup takes >2s.)
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Initial upload of the fixture history (setup, untimed).
  console.log(`  pushing fixture -> ${owner}/${name} (create-by-push)`);
  await git([...GITC, "push", "-q", pushUrl, "main"], { cwd: repoPath });

  // --public-fixtures: flip the repo public so the measured read legs run
  // anonymous (same traffic shape as the local baseline). Authenticated API
  // PATCH, mirroring upstream PATCH /repos/{owner}/{repo} `private` handling.
  if (ctx.publicFixtures) {
    const res = await fetch(`${ctx.baseUrl}/api/v1/repos/${owner}/${name}`, {
      method: "PATCH",
      headers: { Authorization: basicHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ private: false }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(`--public-fixtures: PATCH /api/v1/repos/${owner}/${name} returned ${res.status}: ${body.slice(0, 200)}`);
    }
    notes.push("repo flipped public via PATCH — clone/fetch/info-refs legs measure the anonymous public path");
  }

  // 1. Full clone: wall time + exact received bytes + effective MB/s.
  const cloneDir = path.join(ctx.workDir, `clone-${size}`);
  console.log(`  measuring full clone (${readWithCreds ? "authenticated" : "anonymous"} read)`);
  ctx.proxy.reset();
  const clone = await cloneMeasured([...GITC, "clone", cloneUrl, cloneDir], ctx.workDir, cloneDir);
  metrics.clone_wall_ms = clone.wallMs;
  metrics.clone_received_bytes = ctx.proxy.read().recv;
  metrics.clone_effective_mib_per_s = r2((manifest.actual_pack_bytes / 2 ** 20) / (clone.wallMs / 1000));

  // 2. info/refs advertisement latency (p50/p95 over --runs; direct, no proxy).
  console.log(`  measuring info/refs latency (N=${ctx.runs})`);
  const inforefsUrl = `${ctx.baseUrl}/${owner}/${name}.git/info/refs?service=git-upload-pack`;
  const inforefsAuth = ctx.publicFixtures ? null : (ctx.token ? basicHeader : null);
  Object.assign(metrics, await measureInfoRefs(inforefsUrl, inforefsAuth, ctx.runs));

  // 3. Push + incremental fetch, median over PUSH_FETCH_SAMPLES independent
  //    cycles. The cycle content is BYTE-PINNED (see TOLERANCE CLASSES in the
  //    header): every cycle modifies the same-named marker file with a
  //    same-length body and a same-length message, so each pushed pack has the
  //    same object shape and the bytes reported with the median wall sample
  //    cannot swing across cycles (pre-pin: 458-506 B, purely median-sample
  //    selection). Never interpolate ${name} into the pinned strings — the
  //    production repo name carries a per-run hex tag and would re-introduce
  //    cross-run variance. Cycle 0 is the historical metric shape: fresh
  //    clone -> pinned commit -> timed push, then a timed fetch of that
  //    commit in the stale step-1 clone (thin negotiation). Cycles 1+ add one
  //    pinned marker commit each (untimed) and time the same push->fetch
  //    pair; every cycle pushes exactly one new commit and fetches exactly
  //    that commit, so all samples measure the same server operation.
  //    Deviation from single-shot: cycles 1+ push from the warmed workdir
  //    (not a fresh clone) — the timed push moves the same one-commit pack
  //    through the same receive path; what differs is untimed client-side
  //    setup, which the median deliberately smooths out (see TOLERANCE
  //    CLASSES in the header).
  const pushDir = path.join(ctx.workDir, `push-${size}`);
  console.log(`  measuring push + incremental fetch (median of ${PUSH_FETCH_SAMPLES} cycles)`);
  await cloneMeasured([...GITC, "clone", cloneUrl, pushDir], ctx.workDir, pushDir);
  const ident = ["-c", "user.name=Bench Runner", "-c", "user.email=bench@example.invalid"];
  const pushSamples = [];
  const fetchSamples = [];
  for (let i = 0; i < PUSH_FETCH_SAMPLES; i++) {
    await fsp.writeFile(path.join(pushDir, "bench-push.txt"), `bench push marker ${i}\n`);
    await git(["add", "bench-push.txt"], { cwd: pushDir });
    await git([...ident, "commit", "-qm", `bench: push sample ${i}`], { cwd: pushDir });
    ctx.proxy.reset();
    const push = await timeGit([...GITC, ...ident, "push", proxyPushUrl, "main"], pushDir);
    const pushBytes = ctx.proxy.read().sent;
    ctx.proxy.reset();
    const inc = await timeGit([...GITC, "fetch", "origin"], cloneDir);
    pushSamples.push({ wallMs: push.wallMs, bytes: pushBytes });
    fetchSamples.push({ wallMs: inc.wallMs, bytes: ctx.proxy.read().recv });
  }
  const pushMid = medianSample(pushSamples);
  const fetchMid = medianSample(fetchSamples);
  metrics.push_wall_ms = pushMid.wallMs;
  metrics.push_bytes = pushMid.bytes;
  metrics.fetch_incremental_wall_ms = fetchMid.wallMs;
  metrics.fetch_incremental_bytes = fetchMid.bytes;
  metrics.fetch_incremental_ratio = r6(metrics.fetch_incremental_bytes / metrics.clone_received_bytes);
  notes.push(
    `push_wall_ms/fetch_incremental_wall_ms are medians of ${PUSH_FETCH_SAMPLES} cycles ` +
    `(push [${pushSamples.map((s) => s.wallMs).join(", ")}] ms, fetch [${fetchSamples.map((s) => s.wallMs).join(", ")}] ms)`,
  );
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
  // Production fixture identity: the token's own user namespace, names unique
  // per run (smoke conventions) so repeat runs never collide with leftovers.
  // Local keeps the historical `bench/bench-<size>` shape.
  const runTag = opts.user ? randomUUID().replaceAll("-", "").slice(0, 8) : null;
  const owner = opts.user ?? OWNER;
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
      target: opts.remote ? "remote" : "local",
      baseline_comparable: !opts.remote,
      note: opts.remote
        ? "remote run — NOT baseline-comparable (network variance); baselines are recorded from local workerd runs only"
        : "internal.* metrics are null placeholders — filled by TODO(M2 instrumentation) (SPEC-0001a Step 2 T3 counter)",
    },
    sizes: {},
  };

  let ownServer = null;
  let proxy = null;
  const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `cgit-bench-${runId}-`));
  try {
    if (opts.baseUrl) {
      console.log(`target: external server at ${opts.baseUrl}${opts.remote ? " (REMOTE — not baseline-comparable)" : ""}`);
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
      const repoName = `bench-${size}${runTag ? `-${runTag}` : ""}`;
      console.log(
        `  fixture repo ${owner}/${repoName} — ` +
        (opts.user
          ? (opts.publicFixtures ? "public fixtures: anonymous read legs (auth push only)" : "private: authenticated read legs")
          : "local dev namespace (public reads)"),
      );
      const { metrics, notes } = await benchSize(fixture, {
        baseUrl: opts.baseUrl,
        proxy,
        token: opts.token,
        runs: opts.runs,
        workDir,
        owner,
        repoName,
        user: opts.user,
        publicFixtures: opts.publicFixtures,
      });
      results.sizes[size] = {
        fixture: { ...fixture.manifest, repo: path.relative(repoRoot, fixture.repoPath) },
        ...(opts.user ? { remote_repo: `${owner}/${repoName}` } : {}),
        metrics,
        notes,
      };
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
      // Tolerance class (see TOLERANCE CLASSES in the header): overhead wall
      // metrics must exceed BOTH the percentage band and the ms floor;
      // byte-overhead metrics (push_bytes) BOTH the band and the byte floor;
      // the default class is percentage-only.
      const cls = OVERHEAD_METRICS.has(key) ? "overhead" : OVERHEAD_BYTES.has(key) ? "byte-overhead" : "default";
      const absFloor = cls === "overhead" ? OVERHEAD_ABS_FLOOR_MS : cls === "byte-overhead" ? OVERHEAD_ABS_FLOOR_BYTES : 0;
      const absUnit = key.endsWith("_ms") ? " ms" : key.endsWith("_bytes") ? " B" : "";
      const absWorse = Math.max(0, worseDelta);
      if (pct > REGRESSION_THRESHOLD && (absFloor === 0 || absWorse > absFloor)) {
        const fmt = FMT[key] ?? String;
        failures.push(
          `${size}.${key}: baseline ${fmt(baseVal)} -> now ${fmt(curVal)} ` +
          `(${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}% worse, ${r2(absWorse)}${absUnit} absolute worse; ` +
          `${cls} class: fail needs >${REGRESSION_THRESHOLD * 100}% AND >${absFloor}${absFloor === 0 ? "" : absUnit} absolute)`,
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
  console.log(
    `\ncomparison vs baseline (gate: >${REGRESSION_THRESHOLD * 100}% worse on any recorded metric; ` +
    `overhead wall metrics — push/fetch/inforefs — must ALSO exceed ${OVERHEAD_ABS_FLOOR_MS} ms absolute worse, ` +
    `and push_bytes must exceed ${OVERHEAD_ABS_FLOOR_BYTES} B absolute worse: ` +
    "sub-second fixed-overhead ops swing 2-8x across hosts on identical code and pinned push bytes still wobble a few B, see TOLERANCE CLASSES in scripts/bench-run.mjs):",
  );
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

/** Flat metric table used by both the compare gate and the report-only
 *  remote path. */
function printMetrics(results) {
  for (const size of Object.keys(results.sizes)) {
    for (const [key, val] of Object.entries(flatten(results.sizes[size].metrics))) {
      if (INFORMATIONAL.has(key)) continue;
      console.log(`  ${`${size}.${key}`.padEnd(36)} ${FMT[key] ? FMT[key](val) : String(val)}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Remote cost guard, stage 2: parse-time validation already refused an
  // unacknowledged non-local target; here an acknowledged (--remote) run
  // prints its quota estimate and honors a 5s Ctrl-C grace unless --yes.
  if (opts.remote && !opts.yes) {
    const est = estimateFixtureBytes(opts.sizes, opts.fixturesDir);
    console.error(`remote run against ${opts.baseUrl} — estimated fixture upload per size:`);
    for (const [size, bytes] of est.per) {
      console.error(`  ${size.padEnd(5)} ~${fmtMiB(bytes)} pack (push + clone + fresh-clone + fetch ≈ 3-4x on the wire)`);
    }
    console.error(
      `  total fixture pack ~${fmtMiB(est.total)}; plus ${opts.runs + INFOREFS_WARMUPS} info/refs request(s) ` +
      "per size and a DELETE per fixture repo. Repos are left behind on the target.",
    );
    console.error(`starting in ${REMOTE_GRACE_MS / 1000}s — Ctrl-C to abort (pass --yes to skip this grace)`);
    for (let i = REMOTE_GRACE_MS / 1000; i >= 1; i--) {
      console.error(`  ${i}...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const baselinePath = path.join(opts.baselineDir, `${opts.milestone}.json`);

  if (opts.mode === "record") {
    // Remote --record is refused at parse time (baselines are local-only);
    // this overwrite guard only ever sees local targets.
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

  // compare mode, remote target: report-only by construction. Remote numbers
  // carry network variance, so the baseline file is never read, the gate
  // never runs, and no baseline is ever written (see BASELINE POLICY).
  if (opts.remote) {
    console.log(
      `\nNOT BASELINE-COMPARABLE: this run targeted the remote deployment ${opts.baseUrl}. ` +
      "Remote numbers include network variance (RTT, TLS, CDN); baselines are recorded from local " +
      "workerd runs only. Regression gate SKIPPED — report-only (exit 0), no baseline file read or written.",
    );
    printMetrics(results);
    return 0;
  }

  // compare mode, local target
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
    console.error(`\nbenchmark regression gate FAILED (${cmp.failures.length} metric(s) over tolerance: >${REGRESSION_THRESHOLD * 100}%, wall overhead also >${OVERHEAD_ABS_FLOOR_MS} ms / push_bytes also >${OVERHEAD_ABS_FLOOR_BYTES} B absolute)`);
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
