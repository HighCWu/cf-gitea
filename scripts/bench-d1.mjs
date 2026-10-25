#!/usr/bin/env node
/**
 * bench-d1.mjs — D1 metadata-plane benchmark runner (the sibling of
 * bench-run.mjs, which benchmarks the git plane). Closes an acknowledged
 * gap: "D1 under high-concurrency QPS was never stress-tested".
 *
 * SYNOPSIS
 *   node scripts/bench-d1.mjs [options]                     # LOCAL (default)
 *   node scripts/bench-d1.mjs --ops 100                     # LOCAL, fewer ops
 *   node scripts/bench-d1.mjs --base-url <url> --remote \
 *        --user <name> --token <PAT> [options]              # PRODUCTION
 *
 *   Options:
 *     --ops <n>             ops per phase (default 200; range 10-1000). Each
 *                           workload runs three phases (seq, p=8, p=32), so
 *                           N triples per workload.
 *     --base-url <url>      HTTP target for the remote driver (a dev server
 *                           or a production deployment). WITHOUT it the
 *                           runner drives the local vitest/workerd harness
 *                           (apps/worker/src/bench-d1.test.ts) — that is the
 *                           default mode and the only one that reports
 *                           rows_read/rows_written.
 *     --remote              REQUIRED for a non-local --base-url: acknowledges
 *                           the run meters real production quota. Prints the
 *                           request-count estimate and honors a 5s Ctrl-C
 *                           grace unless --yes.
 *     --yes                 skip the --remote 5s grace window
 *     --user <name>         HTTP-mode fixture namespace (the token's own
 *                           user, deploy-smoke conventions). Required for
 *                           every HTTP run together with --token.
 *     --token <PAT>         the authenticated credential for all HTTP legs.
 *     --member-token <PAT>  HTTP mode, workload `team` only: a second PAT
 *                           whose user is (or will be made) a MEMBER of the
 *                           bench team on the bench org. The team-access
 *                           predicate only runs for a doer that is NOT the
 *                           org owner — an owner GET short-circuits on
 *                           isOrgOwner — so without this token the team
 *                           phase is SKIPPED with a notice rather than
 *                           measuring the wrong thing (bench-run's "an
 *                           anonymous read of a private repo is a 401, not
 *                           a number" rule, applied to predicates).
 *     --results-dir <dir>   transient results dir (default .bench-results)
 *
 * WORKLOADS (mirroring the real schemas; local mode drives the REAL services
 * through apps/worker/src/bench-d1.test.ts — RepoService / IssuesService /
 * TokenService / OrgService / the exported api services; see that file's
 * header for the statement-level detail):
 *   settle  repo-create settle CAS: insert the repositories row (status
 *           'creating') + the conditional settle UPDATE (status='creating'
 *           AND is_empty) — the push-create shape. The remote driver measures
 *           POST /api/v1/user/repos (the API create write path); the CAS
 *           settle leg only exists on the push-create path, so it is
 *           LOCAL-ONLY (remote has no git push in this bench).
 *   issues  issue create + comment + the issue_events fan-out row
 *           (webhook_deliveries through the real emitter, one seeded
 *           send-everything hook). Remote: POST issues + POST comments; the
 *           fan-out row is local-only (creating a production hook would
 *           enqueue REAL deliveries to its URL).
 *   token   token verify read — prefix lookup + users join + digest compare,
 *           the auth hot path. Remote: every measured leg authenticates;
 *           this workload is GET /api/v1/user.
 *   list    joined list-page read: the notifications derived-thread page
 *           (repo_watchers / issue_subscriptions / notification_states
 *           joins, page + count) plus the labels join per page item, exactly
 *           as the list routes render. Remote: GET
 *           /api/v1/repos/{owner}/{repo}/issues?limit=20&page=1 (the
 *           listRepoIssues + embedded-labels surface).
 *   team    the team-access predicate read (teams ⋈ team_members +
 *           team_repo_access probes). Local: OrgService.teamRepoAccessMode.
 *           Remote: GET /api/v1/repos/{org}/{repo} as the --member-token
 *           user (skipped without it — see above).
 *
 * PHASES per workload: seq (p=1), p=8, p=32 — Promise.all batches.
 * METRICS: per-phase ops/s, p50/p95 latency; local mode additionally
 * accumulates D1 rows_read/rows_written through a metering D1 binding
 * wrapper (production telemetry is not queryable from outside, so the HTTP
 * driver reports timing only).
 *
 * REFERENCE NUMBERS — first run 2026-10-25, LOCAL workerd (vitest harness,
 * default ops=200 per phase, dev-scratch D1, real services). Recorded for
 * orientation ONLY — NOT a CI gate:
 *
 *   workload  phase  ops/s     p50 ms   p95 ms   rows_read rows_written
 *   settle    seq     46.77       19       30         600         1600
 *   settle    p8      53.42      148      169         600         1600
 *   settle    p32     47.18      651      734         600         1600
 *   issues    seq     34.10       27       41        5000         2200
 *   issues    p8      36.17      202      329        5000         2200
 *   issues    p32     36.75      841      957        5000         2200
 *   token     seq    199.40        5        6         400            0
 *   token     p8     217.16       35       44         400            0
 *   token     p32    194.74      148      237         400            0
 *   list      seq      8.32      120      154     2118400            0
 *   list      p8       8.79      851     1391     2118400            0
 *   list      p32      9.79     3148     3555     2118400            0
 *   team      seq    105.37        9       11        1400            0
 *   team      p8     104.66       72      108        1400            0
 *   team      p32    104.17      295      349        1400            0
 *
 *   Honest readings from the first run: local D1 serializes writers, so
 *   parallelism (p8/p32) buys ~nothing in throughput for the write workloads
 *   (settle/issues) — it only pools per-op latency. The heavy finding is the
 *   list page: ~10.6k rows_read per op (the derived-thread lastActivity
 *   correlated subquery over every candidate issue) — ~2.1M rows per 200-op
 *   phase, and per-op p50 at concurrency grows into the seconds locally.
 *   rows_read/rows_written are per-phase totals: writes/batches captured
 *   live, SELECTs via the untimed post-phase replay (see the harness's
 *   metering notes); phases are deterministic enough that both phase arms of
 *   a workload report identical totals.
 *
 * NO BASELINE GATE: unlike bench-run.mjs there is deliberately no
 * --record/--compare pair yet. The first numbers live in the header above
 * (and in every local run's output) so a follow-up can baseline the suite
 * once a couple of runs establish the variance band — recording a gate
 * before that would churn. A remote run is report-only by construction.
 *
 * PRODUCTION MODE (non-local --base-url)
 *   Remote runs consume real quota (Worker requests + D1 row operations), so
 *   bench-run's guard conventions hold, enforced before any network I/O:
 *     (1) --remote must be passed explicitly; the run prints a request-count
 *         estimate and waits 5s unless --yes.
 *     (2) --user <name> + --token <PAT> are required (every measured leg is
 *         authenticated — the token verify read IS one of the workloads).
 *         Fixture names are unique per run (d1bench-<hex>-*) so repeat runs
 *         never collide with leftovers.
 *     (3) Fixture cleanup: the created repos are DELETEd and the org is
 *         deleted at the end (best-effort; failures are reported, the run
 *         still exits 0). Team rows that cascaded from the org die with it;
 *         anything left after a mid-run crash carries the d1bench- prefix
 *         for manual cleanup.
 *
 * OUTPUT
 *   Full results JSON -> <results-dir>/bench-d1-<local|remote>-<ts>.json
 *   (gitignored transient dir). The local vitest harness additionally prints
 *   a machine-readable `##D1_BENCH_JSON## {...}` line, which this runner
 *   parses into the results document.
 *
 * REQUIREMENTS: Node >= 22 (global fetch), pnpm (spawns the vitest harness
 * in local mode), zero npm deps.
 */
/* global fetch, AbortSignal, URL -- Web globals provided by Node >= 22 (no node: module exports them) */
import { spawn } from "node:child_process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as sleep } from "node:timers";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = path.join(repoRoot, "apps", "worker");
const BENCH_TEST_FILE = "src/bench-d1.test.ts";
const RESULTS_SCHEMA_VERSION = 1;
const REMOTE_GRACE_MS = 5_000;
const PAGE_LIMIT = 20;
const SEED_ISSUES = 30;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const usageExit = (msg) => {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/bench-d1.mjs [--ops <n>] [--results-dir <dir>]\n" +
      "       node scripts/bench-d1.mjs --base-url <url> --user <name> --token <PAT>\n" +
      "         [--remote --yes] [--member-token <PAT>] [--ops <n>]",
  );
  process.exit(2);
};

function parseArgs(argv) {
  const opts = {
    ops: 200,
    baseUrl: null,
    remote: false,
    yes: false,
    user: null,
    token: null,
    memberToken: null,
    resultsDir: path.join(repoRoot, ".bench-results"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) usageExit(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--ops") opts.ops = Number(next());
    else if (a === "--base-url") opts.baseUrl = next().replace(/\/+$/, "");
    else if (a === "--remote") opts.remote = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--user") opts.user = next();
    else if (a === "--token") opts.token = next();
    else if (a === "--member-token") opts.memberToken = next();
    else if (a === "--results-dir") opts.resultsDir = path.resolve(next());
    else if (a === "-h" || a === "--help") usageExit();
    else usageExit(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.ops) || opts.ops < 10 || opts.ops > 1000) {
    usageExit("--ops must be an integer in [10, 1000]");
  }
  const remoteTarget = opts.baseUrl !== null && !isLocalTarget(opts.baseUrl);
  if (opts.baseUrl === null && (opts.user !== null || opts.token !== null || opts.memberToken !== null)) {
    usageExit("--user/--token/--member-token only apply to HTTP mode (--base-url)");
  }
  if (remoteTarget && !opts.remote) {
    usageExit(
      `--base-url ${opts.baseUrl} is a non-local target: a production run meters real quota ` +
        `(Worker requests + D1 row operations — roughly ${(18 * opts.ops).toLocaleString()} measured ` +
        `requests plus fixtures and cleanup at the default ops). Re-run with --remote to acknowledge, ` +
        "--yes to skip the 5s grace.",
    );
  }
  if (opts.baseUrl !== null && (!opts.user || !opts.token)) {
    usageExit("HTTP mode (--base-url) requires --user <name> and --token <PAT>: every measured leg authenticates");
  }
  if (opts.memberToken !== null && opts.baseUrl === null) {
    usageExit("--member-token only applies to HTTP mode (--base-url)");
  }
  opts.remote = remoteTarget;
  return opts;
}

function isLocalTarget(baseUrl) {
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ---------- shared metrics ----------

function percentile(sorted, p) {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

async function runPhase(workload, phase, n, parallelism, op) {
  const latencies = [];
  const t0 = performance.now();
  if (parallelism === 1) {
    for (let i = 0; i < n; i++) {
      const s = performance.now();
      await op(i);
      latencies.push(performance.now() - s);
    }
  } else {
    for (let done = 0; done < n; done += parallelism) {
      const batch = Array.from({ length: Math.min(parallelism, n - done) }, (_, k) => done + k);
      await Promise.all(
        batch.map(async (i) => {
          const s = performance.now();
          await op(i);
          latencies.push(performance.now() - s);
        }),
      );
    }
  }
  const wallMs = performance.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    workload,
    phase,
    ops: n,
    parallelism,
    wallMs: Math.round(wallMs),
    opsPerSec: Math.round((n / (wallMs / 1000)) * 100) / 100,
    p50Ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
    rowsRead: null,
    rowsWritten: null,
  };
}

function printPhase(m) {
  const rows =
    m.rowsRead === null ? "" : ` rows_read=${m.rowsRead} rows_written=${m.rowsWritten}`;
  console.log(
    `[d1-bench] ${m.workload.padEnd(7)} ${m.phase.padEnd(4)} ` +
      `ops/s=${String(m.opsPerSec).padStart(8)} p50=${String(m.p50Ms).padStart(8)}ms ` +
      `p95=${String(m.p95Ms).padStart(8)}ms wall=${m.wallMs}ms${rows}`,
  );
}

function writeResults(resultsDir, doc) {
  const file = path.join(resultsDir, `bench-d1-${doc.target}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
  return fsp.writeFile(file, JSON.stringify(doc, null, 2) + "\n").then(() => file);
}

// ---------- local mode: the vitest/workerd harness ----------

/** Generate the transient vitest config (gitignored .bench-results/) that
 *  enables the bench file via D1_BENCH bindings. The config lives outside
 *  the worker tree so no owned file is touched; it imports the plugin
 *  through the worker's own node_modules (symlink-resolved, exports-map
 *  aware) so resolution matches the repo's vitest.config.ts. */
async function writeTransientVitestConfig(resultsDir, ops) {
  const cfgPath = path.join(resultsDir, "d1-bench.vitest.config.mjs");
  const pkgDir = path.join(workerRoot, "node_modules", "@cloudflare", "vitest-plugin");
  const cfg = `import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// Generated by scripts/bench-d1.mjs — transient, gitignored (.bench-results/).
// The plugin's exports map has no require condition, so resolve its ESM entry
// through the package.json by hand (realpath: pnpm links it as a symlink).
const pkgDir = realpathSync(${JSON.stringify(pkgDir)});
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const pluginEntry = pkg.exports?.["."]?.import ?? pkg.main;
const plugin = await import(pathToFileURL(join(pkgDir, pluginEntry)).href);
const migrations = await plugin.readD1Migrations(${JSON.stringify(path.join(workerRoot, "src/db/migrations"))});
export default {
  root: ${JSON.stringify(workerRoot)},
  test: { testTimeout: 600000, hookTimeout: 300000 },
  plugins: [
    plugin.cloudflareTest({
      wrangler: { configPath: ${JSON.stringify(path.join(workerRoot, "wrangler.jsonc"))} },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          D1_BENCH: "1",
          D1_BENCH_OPS: ${JSON.stringify(String(ops))},
        },
      },
    }),
  ],
};
`;
  await fsp.writeFile(cfgPath, cfg);
  return cfgPath;
}

async function runLocalHarness(opts) {
  await fsp.mkdir(opts.resultsDir, { recursive: true });
  const cfgPath = await writeTransientVitestConfig(opts.resultsDir, opts.ops);
  console.log(`target: local workerd (vitest harness ${BENCH_TEST_FILE}, ops=${opts.ops})`);
  const args = ["exec", "vitest", "run", "--config", cfgPath, BENCH_TEST_FILE];
  const child = spawn("pnpm", args, { cwd: workerRoot, stdio: ["ignore", "pipe", "pipe"] });
  let captured = "";
  let stderrTail = "";
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    captured += text;
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    if (stderrTail.length < 8000) stderrTail += text;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`vitest harness exited ${code} — see output above\n${stderrTail.slice(-4000)}`);
  }
  const line = captured.split("\n").find((l) => l.includes("##D1_BENCH_JSON##"));
  if (line === undefined) {
    throw new Error("harness output carried no ##D1_BENCH_JSON## line — did the bench actually run?");
  }
  const doc = JSON.parse(line.slice(line.indexOf("##D1_BENCH_JSON##") + "##D1_BENCH_JSON##".length));
  return doc;
}

// ---------- HTTP mode: remote/dev-server driver ----------

function makeHttpClient(baseUrl, user, token) {
  const basic = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  return async function request(method, pathname, body, { auth = basic, expect = [200] } = {}) {
    const res = await fetch(`${baseUrl}/api/v1${pathname}`, {
      method,
      headers: {
        Authorization: auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!expect.includes(res.status)) {
      let snippet = text.slice(0, 300);
      try {
        snippet = JSON.stringify(JSON.parse(text)).slice(0, 300);
      } catch { /* raw text */ }
      throw new Error(`${method} ${pathname} -> ${res.status}, expected ${expect.join("/")}: ${snippet}`);
    }
    return res.status === 204 ? null : (JSON.parse(text) ?? null);
  };
}

async function seedHttpFixtures(request, opts, tag) {
  const owner = opts.user;
  const dataRepo = `d1bench-${tag}-data`;
  const orgName = `d1benchorg${tag}`;
  const orgRepo = `d1bench-${tag}-orgrepo`;

  const me = await request("GET", "/user");
  if (me.login !== owner) {
    throw new Error(`token user is ${me.login}, but --user is ${owner} — the token must belong to the fixture namespace`);
  }
  console.log(`  fixtures: repo ${owner}/${dataRepo}, org ${orgName} (+repo/${orgRepo})`);

  await request("POST", "/user/repos", { name: dataRepo, private: false, auto_init: false, default_branch: "main" }, { expect: [201, 409] });
  // List-page seed: enough issues/comments/labels for a non-trivial page.
  for (let i = 1; i <= SEED_ISSUES; i++) {
    await request("POST", `/repos/${owner}/${dataRepo}/issues`, { title: `bench seed issue ${i}`, body: `seed ${i}` }, { expect: [201] });
  }
  for (let i = 1; i <= 10; i++) {
    await request("POST", `/repos/${owner}/${dataRepo}/issues/${i}/comments`, { body: `seed comment ${i}` }, { expect: [201] });
  }
  for (let i = 0; i < 3; i++) {
    await request("POST", `/repos/${owner}/${dataRepo}/labels`, { name: `bench-${i}`, color: "#00aabb" }, { expect: [201] });
  }
  await request("PUT", `/repos/${owner}/${dataRepo}/subscription`, {}, { expect: [200, 201] });

  // Org + team + org repo (the team-access predicate's fixture).
  await request("POST", "/orgs", { username: orgName }, { expect: [201] });
  await request("POST", `/orgs/${orgName}/repos`, { name: orgRepo, private: false, auto_init: false }, { expect: [201, 409] });
  const team = await request("POST", `/orgs/${orgName}/teams`, { name: "write", permission: "write" }, { expect: [201] });
  if (team?.id === undefined) throw new Error("team create returned no id");
  await request("PUT", `/teams/${team.id}/repos/${orgName}/${orgRepo}`, undefined, { expect: [204] });

  let memberLogin = null;
  if (opts.memberToken !== null) {
    const member = await makeHttpClient(opts.baseUrl, opts.user, opts.memberToken)("GET", "/user");
    memberLogin = member.login;
    await request("PUT", `/teams/${team.id}/members/${memberLogin}`, undefined, { expect: [204] });
    console.log(`  fixtures: team member ${memberLogin} added (--member-token user)`);
  }
  return { owner, dataRepo, orgName, orgRepo, teamId: team.id, memberLogin };
}

async function deleteQuietly(request, method, pathname) {
  try {
    await request(method, pathname, undefined, { expect: [200, 202, 204, 404] });
  } catch (error) {
    console.error(`  cleanup ${method} ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runHttpBench(opts) {
  const { ops } = opts;
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const request = makeHttpClient(opts.baseUrl, opts.user, opts.token);
  const memberRequest =
    opts.memberToken !== null ? makeHttpClient(opts.baseUrl, opts.user, opts.memberToken) : null;
  const fixtures = await seedHttpFixtures(request, opts, tag);
  const phases = [];
  const settleNames = [];
  let issueCounter = 0;

  // ---- workload drivers (one op each; every leg authenticated) ----
  const drivers = {
    // POST /user/repos: the repo-create write path (insert + storage_key
    // derivation + counters seed + engine registry mirror). The settle CAS
    // UPDATE leg is push-create-only — LOCAL-ONLY (see header).
    settle: async () => {
      const name = `d1b${tag}r${settleNames.length}`;
      settleNames.push(name);
      await request("POST", "/user/repos", { name, private: false, auto_init: false }, { expect: [201] });
    },
    // POST issue + POST comment on it.
    issues: async () => {
      issueCounter += 1;
      const issue = await request(
        "POST",
        `/repos/${fixtures.owner}/${fixtures.dataRepo}/issues`,
        { title: `bench issue ${issueCounter}`, body: `bench body ${issueCounter}` },
        { expect: [201] },
      );
      await request(
        "POST",
        `/repos/${fixtures.owner}/${fixtures.dataRepo}/issues/${issue.number}/comments`,
        { body: `bench comment ${issueCounter}` },
        { expect: [201] },
      );
    },
    // GET /user: every leg authenticates, so this IS the token verify hot path.
    token: async () => {
      await request("GET", "/user");
    },
    // GET the issues list page (listRepoIssues + embedded labels).
    list: async () => {
      const page = await request(
        "GET",
        `/repos/${fixtures.owner}/${fixtures.dataRepo}/issues?state=open&type=issues&limit=${PAGE_LIMIT}&page=1`,
      );
      if (!Array.isArray(page) || page.length > PAGE_LIMIT) throw new Error("list page shape broken");
    },
    // GET the org repo as a TEAM MEMBER: the repo-GET guard resolves the
    // doer's access through teamRepoAccessMode (an org owner would
    // short-circuit on isOrgOwner — see --member-token in the header).
    team: async () => {
      if (memberRequest === null) return; // skipped; recorded as such
      const repo = await memberRequest("GET", `/repos/${fixtures.orgName}/${fixtures.orgRepo}`);
      if (repo?.full_name === undefined) throw new Error("org repo GET broken");
    },
  };

  for (const [workload, op] of Object.entries(drivers)) {
    if (workload === "team" && memberRequest === null) {
      console.log(
        `[d1-bench] team    SKIP   — no --member-token: an owner/creator GET short-circuits on ` +
          "isOrgOwner before the team predicate; a faked number is worse than a gap",
      );
      continue;
    }
    // Warmup (untimed).
    for (let i = 0; i < 3; i++) await op();
    phases.push(await runPhase(workload, "seq", ops, 1, op));
    for (const p of [8, 32]) {
      phases.push(await runPhase(workload, `p${p}`, ops, p, op));
    }
    for (const m of phases.slice(-3)) printPhase(m);
    // Settle cleanup, per workload (untimed): the created repos go away so
    // the fixture namespace stays small and repeat phases start clean.
    if (workload === "settle") {
      for (const name of settleNames.splice(0)) {
        await deleteQuietly(request, "DELETE", `/repos/${fixtures.owner}/${name}`);
      }
    }
  }

  // ---- cleanup (untimed, best-effort) ----
  console.log("cleanup: deleting fixture repos + org");
  await deleteQuietly(request, "DELETE", `/repos/${fixtures.owner}/${fixtures.dataRepo}`);
  await deleteQuietly(request, "DELETE", `/repos/${fixtures.orgName}/${fixtures.orgRepo}`);
  await deleteQuietly(request, "DELETE", `/orgs/${fixtures.orgName}`);

  return {
    schema_version: RESULTS_SCHEMA_VERSION,
    target: "remote",
    base_url: opts.baseUrl,
    ops_per_phase: ops,
    fixtures: { data_repo: `${fixtures.owner}/${fixtures.dataRepo}`, org: fixtures.orgName },
    member_token: opts.memberToken !== null,
    runtime: `http ${new Date().toISOString()}`,
    phases: phases.map((m) => ({ ...m, rowsRead: null, rowsWritten: null })),
  };
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.remote && !opts.yes) {
    console.error(`remote run against ${opts.baseUrl} — this WILL meter real production quota:`);
    console.error(`  ~${(18 * opts.ops).toLocaleString()} measured requests (5 workloads x 3 phases x ${opts.ops} ops;` +
      " issues is 2 requests/op, the rest 1; the team phase only with --member-token), plus ~45 fixture " +
      "calls and per-phase repo deletes.");
    console.error(`starting in ${REMOTE_GRACE_MS / 1000}s — Ctrl-C to abort (pass --yes to skip this grace)`);
    for (let i = REMOTE_GRACE_MS / 1000; i >= 1; i--) {
      console.error(`  ${i}...`);
      await sleep(1000);
    }
  }

  await fsp.mkdir(opts.resultsDir, { recursive: true });
  const doc =
    opts.baseUrl === null
      ? await runLocalHarness(opts)
      : await runHttpBench(opts);

  if (doc.target === "local") {
    console.log(
      "\nREFERENCE ONLY — no baseline gate: these local workerd numbers are recorded for orientation " +
        "(see the scripts/bench-d1.mjs header). A follow-up can baseline the suite bench-run-style " +
        "once the variance band is known.",
    );
  } else {
    console.log(
      `\nremote run against ${doc.base_url} — report-only (exit 0): no baseline is read or written, ` +
        "remote numbers are not baseline-comparable (network variance), rows_read/rows_written are " +
        "not observable over HTTP.",
    );
  }
  const file = await writeResults(opts.resultsDir, doc);
  console.log(`results written to ${path.relative(repoRoot, file)}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[fatal] ${err.message}`);
      process.exit(1);
    });
}
