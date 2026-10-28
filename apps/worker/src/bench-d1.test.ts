/**
 * bench-d1.test.ts — D1 metadata-plane benchmark, LOCAL workerd harness.
 *
 * The sibling of scripts/bench-run.mjs (the git-plane bench): that runner
 * stress-tested pack transfer and never answered "D1 under high-concurrency
 * QPS" — the orchestrator's acknowledged honest-unknown. This file measures
 * the write/read paths D1 actually carries in this product, driven through
 * the REAL services (RepoService / IssuesService / TokenService / OrgService /
 * the exported api services) plus the two statement shapes that are
 * route-local (the push-create settle CAS from src/git-http/gate.ts and the
 * derived-thread page join from src/api/routes/notifications.ts) copied
 * verbatim.
 *
 * RUN IT VIA: `node scripts/bench-d1.mjs` (default local mode). The runner
 * generates a transient vitest config (gitignored .bench-results/) that
 * injects the D1_BENCH=1 / D1_BENCH_OPS=<n> bindings below and runs only
 * this file. WITHOUT those bindings the file is skipped in one check, so a
 * plain `pnpm test` stays a no-op here — a benchmark must never gate CI and
 * must never sit in the suite's critical path.
 *
 * WORKLOADS (fixed N ops per phase, default 200; `--ops` overrides):
 *   settle — push-create settle: real RepoService.create({status:"creating"})
 *            (insert + same-batch storage_key derivation + counters seed)
 *            followed by gate.ts settleCreatingRepo's winning conditional
 *            UPDATE (status='creating' AND is_empty) — the settle CAS. The
 *            real settle function is NOT called: without an engine-pushed
 *            ref it would take its undo arm (row delete), which measures the
 *            wrong branch; the statement below is its exact winning-arm shape.
 *   issues — real IssuesService.createIssue (the §3.1 counter-allocation
 *            batch) + addComment (comment row + num_comments increment) +
 *            one webhook_deliveries row through the real emitWebhookDeliveries
 *            (the issue_events fan-out; one active send-everything hook is
 *            seeded so the delivery row actually lands).
 *   token  — real TokenService.verify: the auth hot path (prefix unique-index
 *            lookup + users join + timing-safe digest compare).
 *   list   — a joined list-page read, both real shapes on one page:
 *            (a) the notifications derived-thread page (issues ⋈ repositories
 *                ⋈ users ⋈ pull_requests, left joins to repo_watchers /
 *                issue_subscriptions / notification_states, page + count —
 *                the threadRowQuery/threadCountQuery shape); (b) the
 *                issue_labels ⋈ labels join per page item, run concurrently
 *                exactly as the issues-list route renders embedded labels.
 *                22 queries per op at the default page size of 20.
 *   team   — real OrgService.teamRepoAccessMode: teams ⋈ team_members by
 *            (org, user) + the per-team team_repo_access coverage probes
 *            (the doer-repo grant predicate on the org-repo hot path).
 *
 * PHASES per workload: seq (p=1), p=8, p=32 — Promise.all batches of p ops.
 * METRICS: per-op latency p50/p95, ops/s per phase, and D1
 * rows_read/rows_written accumulated through a metering D1 wrapper —
 * writes/batches live from their D1Result meta, SELECTs via an untimed
 * post-phase replay (drizzle's SELECT path executes through raw(), which
 * drops the meta; see the metering notes at the wrapper). Production
 * telemetry is not queryable from a test, so the remote HTTP driver in
 * scripts/bench-d1.mjs reports timing only.
 *
 * Every op carries a correctness assertion (this is a test-only file): the
 * settle CAS must change exactly 1 row, issue indexes must be positive,
 * verify() must resolve the seeded user, the page must be bounded, the team
 * predicate must return the seeded mode. A bench that silently measures
 * garbage is worse than no bench.
 *
 * NO BASELINE GATE: the first observed numbers are recorded as REFERENCE in
 * the scripts/bench-d1.mjs header. They are explicitly NOT CI-enforced — a
 * follow-up can turn them into a regression gate (bench-run's --compare
 * pattern) once a couple of runs confirm the variance band.
 *
 * INDEX WITNESS (migration 0036 — the perf audit's P0+P1 wave): the second
 * describe below is the OPPOSITE of bench-gated — it RUNS IN PLAIN
 * `pnpm test` (no D1_BENCH binding needed). It is the migration's witness:
 * a small fixed corpus, then per audited query shape an EXPLAIN QUERY PLAN
 * assertion (must name the new index with it present, must not without it —
 * deterministic, no wall-clock noise) plus a short timed loop with D1's
 * rows_read meta as the cost anchor. The gate is the plan assertions; the
 * timings are informational (##INDEX_WITNESS_JSON## line, like the bench).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { env } from "cloudflare:workers";

import { applyAuthD1Migrations } from "./auth/testing/apply-d1-migrations";
import { TokenService } from "./auth/token-service";
import {
  actions,
  comments,
  issueLabels,
  issueSubscriptions,
  issues,
  labels,
  milestones,
  notificationStates,
  personalAccessTokens,
  pullRequests,
  reactions,
  repoCounters,
  repoWatchers,
  repositories,
  teamMembers,
  teamRepoAccess,
  teams,
  users,
  webhooks,
} from "./db/schema";
import { IssuesService } from "./issues/service";
import { emitWebhookDeliveries } from "./issues/webhooks";
import { issueLabelRows } from "./api/services/issues";
import { OrgService } from "./services/orgs/orgs";
import { RepoService } from "./repos/service";

// ---------------------------------------------------------------------------
// Bench configuration (bindings injected by the scripts/bench-d1.mjs runner)
// ---------------------------------------------------------------------------

const BENCH_ENV = env as Env & { D1_BENCH?: string; D1_BENCH_OPS?: string };
/** The runner's generated vitest config sets this; plain `pnpm test` does not. */
const BENCH_ENABLED = BENCH_ENV.D1_BENCH === "1";
const OPS = Number(BENCH_ENV.D1_BENCH_OPS ?? "") || 200;
const WARMUP_OPS = 3;
/** Concurrency levels: sequential plus the two batched-parallelism phases. */
const PARALLELISM = [8, 32] as const;

/** Fixture identity — unique per process so reruns never collide with any
 *  persisted local D1 state; the `d1bench` prefix drives afterAll cleanup. */
const RUN_TAG = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const OWNER_NAME = `d1bench${RUN_TAG}own`;
const ORG_NAME = `d1bench${RUN_TAG}org`;
const MEMBER_NAME = `d1bench${RUN_TAG}mbr`;
const FIXTURE_REPO = `bench${RUN_TAG}data`;
/** Settle-workload repo names (cleanup scoped to this prefix, NOT the whole
 *  owner namespace — the fixture repo lives under the same owner). */
const SETTLE_PREFIX = `stl${RUN_TAG.slice(0, 6)}`;

/** Regression bound for the list phase, in metered rows_read per CANDIDATE
 *  issue (bench-only — see the assertion in the list test). Measured shape,
 *  2026-10-25 at the default ops: ~14.5 rows/candidate (page pipeline ~8.7 —
 *  join probes + the full-candidate ORDER BY enumeration — plus the count's
 *  ~5.8 re-enumeration). A candidate-replacing rewrite must beat this, not
 *  regress it (the GROUP BY derived-join variant measured ~16.3 — worse:
 *  D1 meters the per-statement comments materialization, and correlated
 *  subquery reads are invisible to the meter either way). 15.5 sits ~7%
 *  above the measured band with rows_read deterministic run-to-run. */
const LIST_ROWS_READ_PER_CANDIDATE_BOUND = 15.5;
/** The candidate set at list time: the fixture repo's issues plus every
 *  issue the `issues` workload created before this phase runs (its warmup
 *  plus one op per phase: seq + the two parallelism levels). */
const LIST_CANDIDATES = 120 + WARMUP_OPS + OPS * (PARALLELISM.length + 1);

// ---------------------------------------------------------------------------
// Metering D1 wrapper — accumulates rows_read/rows_written across the phase's
// statements. Two paths, because drizzle's driver splits them:
//   - writes/batches go through run()/batch(), whose D1Result carries meta —
//     captured live;
//   - drizzle's mapped SELECT path (all()/get() with field mapping) executes
//     through raw(), which returns bare row arrays and DROPS the meta. The
//     statements are recorded and REPLAYED (all()) after the phase, untimed:
//     meta is server-side, so the replay reports the same per-statement
//     reads against the end-of-phase state (documented approximation — a
//     SELECT replayed after the phase sees the phase's own writes).
// Statement proxies are unwrapped before they reach the native batch():
// workerd's native methods check the receiver's internal slots, which a
// Proxy does not forward. raw() must NOT be substituted with all() live:
// joined rows lose duplicate column names through all()'s row objects and
// drizzle's positional mapping breaks (verified: token verify + the team
// predicate fail).
// ---------------------------------------------------------------------------

interface D1Meter {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  /** Bound SELECT statements awaiting the post-phase meta replay. */
  pendingRaw: D1PreparedStatement[];
}

function createMeteredD1(inner: D1Database, meter: D1Meter): D1Database {
  const capture = (result: { meta?: { rows_read?: number; rows_written?: number } }): void => {
    meter.rowsRead += result.meta?.rows_read ?? 0;
    meter.rowsWritten += result.meta?.rows_written ?? 0;
    meter.statements += 1;
  };
  const rawOf = new WeakMap<object, D1PreparedStatement>();
  const wrapStmt = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    // Only genuine reads go to the replay: drizzle routes INSERT..RETURNING
    // through raw() as well, and replaying a write would double-apply it
    // (observed: webhook_deliveries uuid UNIQUE violations).
    const isSelect = /^\s*select\b/i.test(sql);
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            const bound = target.bind(...args);
            const wrapped = wrapStmt(bound, sql);
            rawOf.set(wrapped, bound);
            return wrapped;
          };
        }
        if (prop === "all") {
          return () =>
            target.all().then((result) => {
              capture(result);
              return result;
            });
        }
        if (prop === "run") {
          return () =>
            target.run().then((result) => {
              capture(result);
              return result;
            });
        }
        if (prop === "raw") {
          return () => {
            if (isSelect) meter.pendingRaw.push(target);
            return target.raw();
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    rawOf.set(proxy, stmt);
    return proxy;
  };
  // Prototype delegation: anything not overridden (dump, future methods)
  // falls through to the real binding.
  const wrapper = Object.create(inner) as D1Database;
  wrapper.prepare = (query: string) => wrapStmt(inner.prepare(query), query);
  wrapper.batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const unwrapped = statements.map((statement) => rawOf.get(statement) ?? statement);
    const results = await inner.batch<T>(unwrapped);
    for (const result of results) capture(result);
    return results;
  };
  wrapper.exec = (query: string) => inner.exec(query);
  wrapper.withSession = (constraint) => inner.withSession(constraint);
  return wrapper;
}

/** Post-phase meta replay for the recorded SELECT statements (untimed; see
 *  the metering notes above). Runs in small concurrent batches. */
async function replaySelectsForMeter(meter: D1Meter): Promise<void> {
  const pending = meter.pendingRaw;
  meter.pendingRaw = [];
  for (let done = 0; done < pending.length; done += 32) {
    await Promise.all(
      pending.slice(done, done + 32).map(async (statement) => {
        const result = await statement.all();
        captureFrom(result, meter);
      }),
    );
  }
}

function captureFrom(result: { meta?: { rows_read?: number; rows_written?: number } }, meter: D1Meter): void {
  meter.rowsRead += result.meta?.rows_read ?? 0;
  meter.rowsWritten += result.meta?.rows_written ?? 0;
  meter.statements += 1;
}

// ---------------------------------------------------------------------------
// Phase runner — warmup happens outside; per-op timing + metering per phase
// ---------------------------------------------------------------------------

interface PhaseMetrics {
  workload: string;
  phase: string;
  ops: number;
  parallelism: number;
  wallMs: number;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  rowsRead: number;
  rowsWritten: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

/** D1 binds at most 100 variables per statement — seed inserts and id-list
 *  deletes go through this (the 120-issue seed at ops=200 blew the cap). */
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function runPhase(
  workload: string,
  phase: string,
  n: number,
  parallelism: number,
  op: (i: number) => Promise<void>,
  meter: D1Meter,
): Promise<PhaseMetrics> {
  const latencies: number[] = [];
  meter.rowsRead = 0;
  meter.rowsWritten = 0;
  meter.statements = 0;
  meter.pendingRaw = [];
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
  // Untimed post-phase meta replay for the SELECT statements (see the
  // metering notes above) — the reported rows_* cover writes/batches live
  // plus the SELECT replay.
  await replaySelectsForMeter(meter);
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
    rowsRead: meter.rowsRead,
    rowsWritten: meter.rowsWritten,
  };
}

/** The bench result document the .mjs runner parses (##D1_BENCH_JSON## line). */
interface BenchDocument {
  schema_version: 1;
  target: "local";
  ops_per_phase: number;
  runtime: string;
  phases: PhaseMetrics[];
}

const RESULTS: PhaseMetrics[] = [];

function printPhase(m: PhaseMetrics): void {
  console.log(
    `[d1-bench] ${m.workload.padEnd(7)} ${m.phase.padEnd(4)} ` +
      `ops/s=${String(m.opsPerSec).padStart(8)} p50=${String(m.p50Ms).padStart(8)}ms ` +
      `p95=${String(m.p95Ms).padStart(8)}ms wall=${m.wallMs}ms ` +
      `rows_read=${m.rowsRead} rows_written=${m.rowsWritten}`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures (untimed) — users/org/teams, the list-page repo with issues,
// comments, labels, watchers, subscriptions, read markers, one PR row, one
// active webhook; the verified token. Seeded with raw drizzle for tables the
// services only read, and through the real services where the shape matters
// (the token mint).
// ---------------------------------------------------------------------------

interface Fixtures {
  ownerId: number;
  orgId: number;
  memberId: number;
  repoId: string;
  orgRepoId: string;
  tokenPlaintext: string;
}

async function seedFixtures(db: DrizzleD1Database): Promise<Fixtures> {
  const now = new Date();
  const insertUser = async (username: string, isOrg: boolean): Promise<number> => {
    const rows = await db
      .insert(users)
      .values({
        username,
        usernameLower: username.toLowerCase(),
        type: isOrg ? "org" : "user",
        createdAt: now,
      })
      .returning({ id: users.id })
      .all();
    const user = rows[0];
    if (user === undefined) throw new Error(`seed user ${username} failed`);
    return user.id;
  };
  const ownerId = await insertUser(OWNER_NAME, false);
  const orgId = await insertUser(ORG_NAME, true);
  const memberId = await insertUser(MEMBER_NAME, false);
  // The watcher side-tables want a few extra watcher users.
  const watcherIds: number[] = [];
  for (let i = 0; i < 4; i++) watcherIds.push(await insertUser(`${MEMBER_NAME}w${i}`, false));

  const mkRepo = async (ownerNamespace: string, repoOwnerId: number, slug: string): Promise<string> => {
    const id = crypto.randomUUID();
    await db.batch([
      db.insert(repositories).values({
        id,
        storageKey: `r_${id.slice(0, 8)}`,
        ownerNamespace,
        ownerId: repoOwnerId,
        slug,
        visibility: "public",
        createdAt: now,
      }),
      db.insert(repoCounters).values({ repoId: id, issueIndex: 0 }).onConflictDoNothing(),
    ]);
    return id;
  };
  const repoId = await mkRepo(OWNER_NAME.toLowerCase(), ownerId, FIXTURE_REPO);
  const orgRepoId = await mkRepo(ORG_NAME.toLowerCase(), orgId, FIXTURE_REPO);

  // Teams: a write team with an explicit grant, a read team whose effective
  // mode comes from the unitsMap collapse, and a 'none' team — the member is
  // in all three; the predicate must resolve write > read and skip 'none'.
  const teamBatches = await db.batch([
    db
      .insert(teams)
      .values({ orgId, lowerName: "write", name: "write", authorize: "write", numMembers: 1, numRepos: 1 })
      .returning({ id: teams.id }),
    db
      .insert(teams)
      .values({
        orgId,
        lowerName: "readers",
        name: "readers",
        authorize: "none",
        unitsMap: JSON.stringify({ "repo.code": "read" }),
        numMembers: 1,
        numRepos: 1,
      })
      .returning({ id: teams.id }),
    db.insert(teams).values({ orgId, lowerName: "idle", name: "idle", authorize: "none" }).returning({ id: teams.id }),
  ]);
  const teamId = (index: number): number => {
    const rows: unknown = teamBatches[index];
    const first = (rows as { id: number }[] | undefined)?.[0];
    if (first === undefined) throw new Error(`seed team ${index} failed`);
    return first.id;
  };
  const writeTeamId = teamId(0);
  const readersTeamId = teamId(1);
  const idleTeamId = teamId(2);
  await db.batch([
    db.insert(teamMembers).values([
      { orgId, teamId: writeTeamId, userId: memberId },
      { orgId, teamId: readersTeamId, userId: memberId },
      { orgId, teamId: idleTeamId, userId: memberId },
    ]),
    db.insert(teamRepoAccess).values([
      { orgId, teamId: writeTeamId, repoId: orgRepoId },
      { orgId, teamId: readersTeamId, repoId: orgRepoId },
    ]),
  ]);

  // The list-page fixture: 120 issues (+ 1 PR pair), 6 labels attached to
  // every other issue, 60 comments, the member watching the repo and
  // subscribed to every 4th issue, read markers on every 10th.
  const SEED_ISSUES = 120;
  const issueValues = Array.from({ length: SEED_ISSUES }, (_, i) => ({
    repoId,
    index: i + 1,
    posterId: ownerId,
    title: `bench issue ${i + 1}`,
    content: `bench body ${i + 1}`,
    isPull: i === SEED_ISSUES - 1,
    numComments: i < 60 ? 1 : 0,
    createdAt: new Date(now.getTime() - (SEED_ISSUES - i) * 60_000),
    updatedAt: new Date(now.getTime() - (SEED_ISSUES - i) * 30_000),
  }));
  for (const part of chunks(issueValues, 5)) {
    await db.insert(issues).values(part);
  }
  const seededIssues = await db
    .select({ id: issues.id, index: issues.index })
    .from(issues)
    .where(eq(issues.repoId, repoId))
    .orderBy(asc(issues.index))
    .all();
  const insertedIssues = seededIssues;
  const prIssue = insertedIssues[insertedIssues.length - 1];
  if (prIssue === undefined) throw new Error("seed issues failed");
  await db.insert(pullRequests).values({
    issueId: prIssue.id,
    index: prIssue.index,
    status: 1,
    headRepoId: repoId,
    baseRepoId: repoId,
    headBranch: "bench",
    baseBranch: "main",
  });
  await db.batch([
    db.update(repositories).set({ numIssues: SEED_ISSUES - 1, numPulls: 1 }).where(eq(repositories.id, repoId)),
    db.update(repoCounters).set({ issueIndex: SEED_ISSUES }).where(eq(repoCounters.repoId, repoId)),
  ]);

  const commentValues = insertedIssues.slice(0, 60).map((issue, i) => ({
    type: 0,
    posterId: i % 2 === 0 ? memberId : ownerId,
    issueId: issue.id,
    content: `bench comment ${i}`,
    createdAt: now,
    updatedAt: now,
  }));
  // The comments table carries ~29 columns (the full upstream shape), so the
  // chunk bound is the D1 100-variable cap divided by the column count.
  for (const part of chunks(commentValues, 3)) {
    await db.insert(comments).values(part);
  }

  const labelRows = await db
    .insert(labels)
    .values(
      Array.from({ length: 6 }, (_, i) => ({
        repoId,
        name: `bench-label-${i}`,
        color: "#00aabb",
        numIssues: 0,
      })),
    )
    .returning({ id: labels.id })
    .all();
  const labelIds = labelRows.map((row) => row.id);
  if (labelIds.length !== 6) throw new Error("seed labels failed");
  const attach = insertedIssues.filter((_, i) => i % 2 === 0);
  const attachValues = attach.map((issue, i) => {
    const labelId = labelIds[i % labelIds.length];
    if (labelId === undefined) throw new Error("seed label attach failed");
    return { issueId: issue.id, labelId };
  });
  for (const part of chunks(attachValues, 40)) {
    await db.insert(issueLabels).values(part);
  }
  await db.update(labels).set({ numIssues: attach.length }).where(inArray(labels.id, labelIds));

  await db.insert(repoWatchers).values([
    { repoId, userId: memberId, createdAt: now },
    ...watcherIds.map((id) => ({ repoId, userId: id, createdAt: now })),
  ]);
  const subscriptionValues = insertedIssues
    .filter((_, i) => i % 4 === 0)
    .map((issue) => ({ userId: memberId, issueId: issue.id, isWatching: true }));
  for (const part of chunks(subscriptionValues, 30)) {
    await db.insert(issueSubscriptions).values(part);
  }
  const stateValues = insertedIssues
    .filter((_, i) => i % 10 === 0)
    .map((issue) => ({ userId: memberId, issueId: issue.id, readAtUnix: Math.floor(now.getTime() / 1000) - 3600 }));
  for (const part of chunks(stateValues, 30)) {
    await db.insert(notificationStates).values(part);
  }

  // One active send-everything hook so the issue_events fan-out row lands.
  await db.insert(webhooks).values({
    repoId,
    url: "http://127.0.0.1:9/hook",
    events: JSON.stringify({ send_everything: true }),
    isActive: true,
  });

  // The verified credential (the real mint path).
  const minted = await new TokenService(env.DB).mint({
    userId: ownerId,
    name: `bench-${RUN_TAG}`,
    scopes: "all",
  });
  return { ownerId, orgId, memberId, repoId, orgRepoId, tokenPlaintext: minted.plaintext };
}

// ---------------------------------------------------------------------------
// The bench (skipped in one check without the D1_BENCH binding)
// ---------------------------------------------------------------------------

describe.skipIf(!BENCH_ENABLED)("D1 metadata-plane bench", () => {
  let meteredDb!: D1Database;
  let meter!: D1Meter;
  let db!: DrizzleD1Database;
  let fixtures!: Fixtures;
  let repoSvc!: RepoService;
  let issueSvc!: IssuesService;
  let orgSvc!: OrgService;
  let tokenSvc!: TokenService;

  beforeAll(async () => {
    await applyAuthD1Migrations();
    meter = { rowsRead: 0, rowsWritten: 0, statements: 0, pendingRaw: [] };
    meteredDb = createMeteredD1(env.DB, meter);
    db = drizzle(meteredDb);
    fixtures = await seedFixtures(db);
    repoSvc = new RepoService(meteredDb);
    issueSvc = new IssuesService(meteredDb);
    orgSvc = new OrgService(meteredDb);
    tokenSvc = new TokenService(meteredDb);
  }, 300_000);

  afterAll(async () => {
    // Best-effort scratch cleanup (the d1bench prefix scopes every row this
    // file created; per-file isolated storage may discard it anyway).
    try {
      const seededIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(inArray(issues.repoId, [fixtures.repoId, fixtures.orgRepoId]))
        .all();
      const issueIds = seededIssues.map((row) => row.id);
      for (const repoId of [fixtures.repoId, fixtures.orgRepoId]) {
        await db.delete(webhooks).where(eq(webhooks.repoId, repoId));
        await db.delete(teamRepoAccess).where(eq(teamRepoAccess.repoId, repoId));
        await db.delete(repoCounters).where(eq(repoCounters.repoId, repoId));
        await db.delete(repositories).where(eq(repositories.id, repoId));
      }
      for (const part of chunks(issueIds, 50)) {
        await db.delete(comments).where(inArray(comments.issueId, part));
        await db.delete(issueLabels).where(inArray(issueLabels.issueId, part));
        await db.delete(issueSubscriptions).where(inArray(issueSubscriptions.issueId, part));
        await db.delete(notificationStates).where(inArray(notificationStates.issueId, part));
        await db.delete(pullRequests).where(inArray(pullRequests.issueId, part));
      }
      // Settle-workload leftovers, scoped to the settle-name prefix.
      await db.delete(repositories).where(sql`${repositories.slug} like ${`${SETTLE_PREFIX}%`}`);
      await db.delete(personalAccessTokens).where(eq(personalAccessTokens.userId, fixtures.ownerId));
      await db.delete(users).where(sql`username_lower like ${`d1bench${RUN_TAG}%`}`);
    } catch (error) {
      console.error(
        `[d1-bench] cleanup failed (dev-scratch only): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // -- (a) push-create settle ------------------------------------------------

  test("settle: repo-create settle CAS", async () => {
    const createdIds: string[] = [];
    const op = async (tag: string, i: number): Promise<void> => {
      const name = `${SETTLE_PREFIX}${tag}${i}`;
      const created = await repoSvc.create({
        owner: { id: fixtures.ownerId, usernameLower: OWNER_NAME.toLowerCase() },
        name,
        isPrivate: true,
        status: "creating",
      });
      createdIds.push(created.id);
      if (created.status !== "creating" || !created.isEmpty) throw new Error(`create ${name} not in creating state`);
      // The winning arm of gate.ts settleCreatingRepo — the exact statement
      // shape (conditional on status='creating' AND is_empty).
      const settled = await db
        .update(repositories)
        .set({ status: "ready", isEmpty: false, defaultBranch: "main", updatedAt: new Date() })
        .where(
          and(
            eq(repositories.id, created.id),
            eq(repositories.status, "creating"),
            eq(repositories.isEmpty, true),
          ),
        )
        .run();
      if ((settled.meta.changes ?? 0) !== 1) throw new Error(`settle CAS lost for ${name}`);
    };

    for (let i = 0; i < WARMUP_OPS; i++) await op("w", i);
    RESULTS.push(await runPhase("settle", "seq", OPS, 1, (i) => op("s", i), meter));
    for (const p of PARALLELISM) {
      RESULTS.push(await runPhase("settle", `p${p}`, OPS, p, (i) => op(`p${p}`, i), meter));
    }
    for (const m of RESULTS.slice(-3)) printPhase(m);
    // The settle rows are deleted here (untimed) so the later workloads scan
    // small tables — the bench measures the write path, not table bloat.
    for (const part of chunks(createdIds, 50)) {
      await db.delete(repoCounters).where(inArray(repoCounters.repoId, part));
      await db.delete(repositories).where(inArray(repositories.id, part));
    }
  }, 600_000);

  // -- (b) issue create + comment + fan-out row ------------------------------

  test("issues: create + comment + webhook fan-out", async () => {
    const op = async (i: number): Promise<void> => {
      const issue = await issueSvc.createIssue({
        repoId: fixtures.repoId,
        posterId: fixtures.ownerId,
        title: `bench issue op ${i}`,
        content: `bench body op ${i}`,
      });
      if (issue.index <= 0) throw new Error(`issue index not allocated: ${issue.index}`);
      const comment = await issueSvc.addComment({
        issueId: issue.id,
        posterId: fixtures.ownerId,
        content: `bench comment op ${i}`,
      });
      if (comment.id <= 0) throw new Error("comment row missing");
      // The issue_events fan-out row (the real emitter; the seeded hook
      // matches everything, so exactly one delivery row lands).
      const emit = await emitWebhookDeliveries(meteredDb, {
        repoId: fixtures.repoId,
        ownerId: fixtures.ownerId,
        eventType: "issues",
        payload: { action: "opened", number: issue.index, sender: { login: OWNER_NAME } },
      });
      if (emit.deliveryIds.length !== 1) throw new Error(`fan-out row count ${emit.deliveryIds.length}`);
    };

    for (let i = 0; i < WARMUP_OPS; i++) await op(-1 - i);
    RESULTS.push(await runPhase("issues", "seq", OPS, 1, op, meter));
    for (const p of PARALLELISM) {
      RESULTS.push(await runPhase("issues", `p${p}`, OPS, p, op, meter));
    }
    for (const m of RESULTS.slice(-3)) printPhase(m);
  }, 600_000);

  // -- (c) token verify (auth hot path) --------------------------------------

  test("token: verify read", async () => {
    const op = async (): Promise<void> => {
      const auth = await tokenSvc.verify(fixtures.tokenPlaintext);
      if (auth === null || auth.user.id !== fixtures.ownerId) throw new Error("token verify failed");
    };
    for (let i = 0; i < WARMUP_OPS; i++) await op();
    RESULTS.push(await runPhase("token", "seq", OPS, 1, op, meter));
    for (const p of PARALLELISM) {
      RESULTS.push(await runPhase("token", `p${p}`, OPS, p, op, meter));
    }
    for (const m of RESULTS.slice(-3)) printPhase(m);
  }, 600_000);

  // -- (d) joined list-page read (watchers-family joins + labels join) -------

  test("list: thread page + labels join", async () => {
    const userId = fixtures.memberId;
    // lastActivityExpr / threadRowQuery / threadCountQuery shapes from
    // src/api/routes/notifications.ts (route-local; copied verbatim here).
    const lastActivity = sql`max(
      coalesce((select max(coalesce(c.updated_unix, c.created_unix)) from comments c
        where c.issue_id = ${issues.id} and (c.poster_id is null or c.poster_id <> ${userId})), 0),
      case when ${issues.posterId} is not null and ${issues.posterId} <> ${userId}
        then coalesce(${issues.createdAt}, 0) else 0 end
    )`;
    const unread = sql`(${notificationStates.userId} is null or (${notificationStates.pinned} = 0 and coalesce(${notificationStates.readAtUnix}, 0) < (${lastActivity})))`;
    const recipient = sql`(
      ${repoWatchers.userId} is not null
      or ${repositories.ownerId} = ${userId}
      or ${issues.posterId} = ${userId}
      or ${issueSubscriptions.userId} is not null
      or exists (select 1 from comments pc where pc.issue_id = ${issues.id} and pc.poster_id = ${userId})
    )`;
    const pageQuery = () =>
      db
        .select({ issue: issues, repo: repositories, owner: users, pull: pullRequests })
        .from(issues)
        .innerJoin(repositories, eq(repositories.id, issues.repoId))
        .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
        .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id))
        .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
        .leftJoin(
          issueSubscriptions,
          and(
            eq(issueSubscriptions.issueId, issues.id),
            eq(issueSubscriptions.userId, userId),
            eq(issueSubscriptions.isWatching, true),
          ),
        )
        .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)));
    const countQuery = () =>
      db
        .select({ value: sql<number>`count(*)` })
        .from(issues)
        .innerJoin(repositories, eq(repositories.id, issues.repoId))
        .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
        .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
        .leftJoin(
          issueSubscriptions,
          and(
            eq(issueSubscriptions.issueId, issues.id),
            eq(issueSubscriptions.userId, userId),
            eq(issueSubscriptions.isWatching, true),
          ),
        )
        .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)));
    const conditions = [sql`(${lastActivity}) > 0`, recipient, unread];

    const op = async (): Promise<void> => {
      const rows = await pageQuery()
        .where(and(...conditions))
        .orderBy(sql`(${lastActivity}) DESC, ${issues.id} DESC`)
        .limit(20)
        .all();
      const totalRows = await countQuery().where(and(...conditions)).all();
      const total = Number(totalRows[0]?.value ?? 0);
      if (rows.length > 20 || total < rows.length) throw new Error(`list page shape broken: ${rows.length}/${total}`);
      // The labels half: the issueLabelRows join shape per page item, run
      // concurrently exactly as the issues-list route renders labels
      // (api/routes/issues.ts: Promise.all(items.map(toApiIssue))).
      await Promise.all(rows.map((row) => issueLabelRows(meteredDb, row.issue.id)));
    };
    for (let i = 0; i < WARMUP_OPS; i++) await op();
    RESULTS.push(await runPhase("list", "seq", OPS, 1, op, meter));
    for (const p of PARALLELISM) {
      RESULTS.push(await runPhase("list", `p${p}`, OPS, p, op, meter));
    }
    for (const m of RESULTS.slice(-3)) printPhase(m);
    // Regression bound (bench-only — plain `pnpm test` never executes this
    // file): metered rows_read must stay within the measured per-candidate
    // band for the derived-thread page+count pair. The correlated comments
    // probes are meter-blind (they run against comments_issue_covering_idx,
    // migration 0017), so this bounds the JOIN pipeline: a rewrite that
    // inflates it (e.g. a derived-table materialization per statement) trips.
    for (const m of RESULTS.filter((phase) => phase.workload === "list")) {
      expect(m.rowsRead / m.ops).toBeLessThan(LIST_CANDIDATES * LIST_ROWS_READ_PER_CANDIDATE_BOUND);
    }
  }, 600_000);

  // -- (e) team-access predicate read ----------------------------------------

  test("team: teamRepoAccessMode predicate", async () => {
    const repo = { id: fixtures.orgRepoId, ownerId: fixtures.orgId };
    const op = async (): Promise<void> => {
      const mode = await orgSvc.teamRepoAccessMode(repo, fixtures.memberId);
      if (mode !== "write") throw new Error(`team predicate returned ${mode}, expected write`);
    };
    for (let i = 0; i < WARMUP_OPS; i++) await op();
    RESULTS.push(await runPhase("team", "seq", OPS, 1, op, meter));
    for (const p of PARALLELISM) {
      RESULTS.push(await runPhase("team", `p${p}`, OPS, p, op, meter));
    }
    for (const m of RESULTS.slice(-3)) printPhase(m);

    expect(RESULTS).toHaveLength(15);
    const doc: BenchDocument = {
      schema_version: 1,
      target: "local",
      ops_per_phase: OPS,
      runtime: `workerd vitest ${new Date().toISOString()}`,
      phases: RESULTS,
    };
    console.log(`##D1_BENCH_JSON## ${JSON.stringify(doc)}`);
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Index witness (migration 0036 — the D1 index audit's P0+P1 wave).
//
// Always-on (the block above stays bench-gated; this one is the migration's
// test-visible witness). Protocol per audited query shape:
//   1. with the migrated indexes: EXPLAIN QUERY PLAN must name the new index;
//   2. after dropping all ten (the honest pre-migration state): the same
//      EXPLAIN must NOT name it;
//   3. both states timed over a fixed loop; D1's rows_read meta is the
//      deterministic cost anchor (wall ms in local workerd is noisy);
//   4. the ten CREATE INDEX statements are replayed VERBATIM (they are the
//      migration's exact DDL) and sqlite_master is re-checked, so the file
//      leaves the schema exactly as migrated.
// D1 supports EXPLAIN QUERY PLAN through prepare() (plain SQLite; verified
// by this very test — a rejection would fail the plan step).
// ---------------------------------------------------------------------------

/** The ten audited indexes: [name, exact migration-0036 DDL]. Keep in lockstep
 *  with src/db/migrations/0036_fantastic_whirlwind.sql — the drop/recreate
 *  protocol depends on the replay restoring the migrated schema byte-for-byte. */
const WITNESS_INDEXES: readonly [name: string, ddl: string][] = [
  [
    "labels_repo_id_idx",
    "CREATE INDEX `labels_repo_id_idx` ON `labels` (`repo_id`)",
  ],
  [
    "labels_org_id_idx",
    "CREATE INDEX `labels_org_id_idx` ON `labels` (`org_id`)",
  ],
  [
    "reactions_issue_comment_release_idx",
    "CREATE INDEX `reactions_issue_comment_release_idx` ON `reactions` (`issue_id`,`comment_id`,`release_id`)",
  ],
  [
    "issues_repo_pull_closed_created_idx",
    "CREATE INDEX `issues_repo_pull_closed_created_idx` ON `issues` (`repo_id`,`is_pull`,`is_closed`,`created_unix`)",
  ],
  [
    "milestones_repo_id_idx",
    "CREATE INDEX `milestones_repo_id_idx` ON `milestones` (`repo_id`)",
  ],
  [
    "repositories_owner_id_idx",
    "CREATE INDEX `repositories_owner_id_idx` ON `repositories` (`owner_id`)",
  ],
  [
    "issues_poster_created_idx",
    "CREATE INDEX `issues_poster_created_idx` ON `issues` (`poster_id`,`created_unix`)",
  ],
  [
    "comments_poster_created_idx",
    "CREATE INDEX `comments_poster_created_idx` ON `comments` (`poster_id`,`created_unix`)",
  ],
  [
    "action_repo_deleted_created_idx",
    "CREATE INDEX `action_repo_deleted_created_idx` ON `action` (`repo_id`,`is_deleted`,`created_unix`)",
  ],
  [
    "issue_subscriptions_issue_idx",
    "CREATE INDEX `issue_subscriptions_issue_idx` ON `issue_subscriptions` (`issue_id`)",
  ],
];

/** One audited query shape: the verbatim statement the named service issues
 *  (binds filled from the witness fixtures), mapped to the index the audit
 *  says must serve it. */
interface WitnessShape {
  name: string;
  index: string;
  sql: string;
  binds: (f: WitnessFixtures) => unknown[];
}

interface WitnessFixtures {
  ownerId: number;
  otherId: number;
  /** The corpus repo every target scan filters on. */
  targetRepo: string;
  /** The distractor repo (another owner's) that fills the scanned tables. */
  otherRepo: string;
  /** An issue id in the target repo (reactions/subscriptions probes). */
  firstTargetIssue: number;
}

/** The ten shapes: caller cites are the schema.ts index comments. */
function witnessShapes(f: WitnessFixtures): WitnessShape[] {
  return [
    {
      name: "labels.repo list",
      index: "labels_repo_id_idx",
      // api/services/labels.ts:101 (listRepoLabels).
      sql: "SELECT id, name, color FROM labels WHERE repo_id = ?",
      binds: () => [f.targetRepo],
    },
    {
      name: "labels.org list",
      index: "labels_org_id_idx",
      // api/services/labels-t2.ts:69 (listOrgLabels).
      sql: "SELECT id, name, color FROM labels WHERE org_id = ?",
      binds: () => [f.ownerId],
    },
    {
      name: "reactions target scan",
      index: "reactions_issue_comment_release_idx",
      // api/services/issue-extras.ts:59-62 (listReactions; the delete twin
      // at :118-126 binds the same three).
      sql: "SELECT id, user_id, type, created_unix FROM reactions WHERE issue_id = ? AND comment_id = ? AND release_id = 0 ORDER BY id",
      binds: () => [f.firstTargetIssue, 0],
    },
    {
      name: "issues repo list page",
      index: "issues_repo_pull_closed_created_idx",
      // api/services/issues.ts issueFilterConditions + the page ORDER BY
      // (:693/:714) — the repo-scoped shape with both state filters bound.
      sql: "SELECT * FROM issues WHERE repo_id = ? AND is_pull = ? AND is_closed = ? ORDER BY created_unix DESC, id DESC LIMIT 30",
      binds: () => [f.targetRepo, 0, 0],
    },
    {
      name: "milestones repo list",
      index: "milestones_repo_id_idx",
      // api/services/milestones.ts:133 (listRepoMilestones).
      sql: "SELECT * FROM milestones WHERE repo_id = ?",
      binds: () => [f.targetRepo],
    },
    {
      name: "repositories owner scan",
      index: "repositories_owner_id_idx",
      // services/orgs/orgs.ts:619-620 (org repo listing).
      sql: "SELECT id, slug, visibility FROM repositories WHERE owner_id = ?",
      binds: () => [f.ownerId],
    },
    {
      name: "issues poster heatmap",
      index: "issues_poster_created_idx",
      // api/routes/user-read-t2.ts:150-160 (activity heatmap, issues half).
      sql: "SELECT created_unix FROM issues WHERE poster_id = ? AND created_unix > ?",
      binds: () => [f.ownerId, 0],
    },
    {
      name: "comments poster heatmap",
      index: "comments_poster_created_idx",
      // api/routes/user-read-t2.ts:163-171 (activity heatmap, comments half).
      sql: "SELECT created_unix FROM comments WHERE poster_id = ? AND created_unix > ?",
      binds: () => [f.ownerId, 0],
    },
    {
      name: "action repo feed page",
      index: "action_repo_deleted_created_idx",
      // api/services/activity-feeds.ts feedCondition (kind=repo) + getFeedRows
      // ORDER BY (:388) — user_id = act_user_id is the column-to-column
      // parity arm the index cannot serve; it filters the ordered range.
      sql: 'SELECT * FROM "action" WHERE repo_id = ? AND is_deleted = 0 AND user_id = act_user_id ORDER BY created_unix DESC, id DESC LIMIT 20',
      binds: () => [f.targetRepo],
    },
    {
      name: "issue_subscribers probe",
      index: "issue_subscriptions_issue_idx",
      // api/services/issue-extras.ts:175 (getIssueWatchers subscribers).
      sql: "SELECT user_id, is_watching FROM issue_subscriptions WHERE issue_id = ? AND is_watching = 1",
      binds: () => [f.firstTargetIssue],
    },
  ];
}

/** Corpus size (kept small — this block runs in the plain suite): target-repo
 *  issues + distractor-repo issues, then the derived child rows. */
const WITNESS_TARGET_ISSUES = 300;
const WITNESS_OTHER_ISSUES = 250;
const WITNESS_TIMED_RUNS = 30;

interface WitnessNumber {
  shape: string;
  index: string;
  rowsReadWith: number;
  rowsReadWithout: number;
  meanMsWith: number;
  meanMsWithout: number;
}

let explainSeq = 0;

/** EXPLAIN QUERY PLAN through a raw prepare (the D1-support verification).
 *  A unique comment tag is appended per call: the D1 session serves cached
 *  compiled plans keyed on the SQL string, so a re-explained statement after
 *  a DROP must look like a different statement or it reports the stale plan
 *  (observed: post-drop EXPLAIN still named the dropped index). */
async function explainPlan(raw: D1Database, sql: string, binds: unknown[]): Promise<string> {
  explainSeq += 1;
  const result = await raw
    .prepare(`EXPLAIN QUERY PLAN ${sql} /* witness-${explainSeq} */`)
    .bind(...binds)
    .all<{ detail: string }>();
  return result.results.map((row) => row.detail).join("\n");
}

/** Timed loop + the deterministic rows_read anchor (one metered call). The
 *  comment tag defeats the D1 statement cache the same way explainPlan does —
 *  without it the "without indexes" state would time the cached indexed plan. */
async function measureShape(
  raw: D1Database,
  shape: WitnessShape,
  binds: unknown[],
  tag: string,
): Promise<{ meanMs: number; rowsRead: number }> {
  const stmt = raw.prepare(`${shape.sql} /* ${tag} */`);
  for (let i = 0; i < 3; i++) await stmt.bind(...binds).all(); // warmup
  const metered = await stmt.bind(...binds).all();
  const t0 = performance.now();
  for (let i = 0; i < WITNESS_TIMED_RUNS; i++) await stmt.bind(...binds).all();
  return { meanMs: (performance.now() - t0) / WITNESS_TIMED_RUNS, rowsRead: metered.meta?.rows_read ?? 0 };
}

describe("index witness (migration 0036 — the audit's P0+P1 wave)", () => {
  const RUN_TAG = `idxw${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  let db!: DrizzleD1Database;
  let raw!: D1Database;
  let fixtures!: WitnessFixtures;

  beforeAll(async () => {
    await applyAuthD1Migrations();
    raw = env.DB;
    db = drizzle(raw);
  });

  afterAll(async () => {
    // Best-effort scratch cleanup (per-file isolated storage discards it
    // anyway; the prefix scopes every row the witness created).
    try {
      const repoIds = [fixtures.targetRepo, fixtures.otherRepo];
      const seededIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(inArray(issues.repoId, repoIds))
        .all();
      const issueIds = seededIssues.map((row) => row.id);
      for (const part of chunks(issueIds, 50)) {
        await db.delete(reactions).where(inArray(reactions.issueId, part));
        await db.delete(comments).where(inArray(comments.issueId, part));
        await db.delete(issueSubscriptions).where(inArray(issueSubscriptions.issueId, part));
      }
      for (const repoId of repoIds) {
        await db.delete(labels).where(eq(labels.repoId, repoId));
        await db.delete(milestones).where(eq(milestones.repoId, repoId));
        await db.delete(actions).where(eq(actions.repoId, repoId));
        await db.delete(repositories).where(eq(repositories.id, repoId));
      }
      await db.delete(labels).where(eq(labels.orgId, fixtures.ownerId));
      await db.delete(users).where(sql`username_lower like ${`${RUN_TAG}%`}`);
    } catch (error) {
      console.error(
        `[index-witness] cleanup failed (dev-scratch only): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  test("seeds the corpus, witnesses the plans, times both states, restores the schema", async () => {
    // -- seed (untimed) -------------------------------------------------------
    const now = Math.floor(Date.now() / 1000);
    const insertUser = async (name: string): Promise<number> => {
      const rows = await db
        .insert(users)
        .values({ username: name, usernameLower: name, type: "user", createdAt: new Date() })
        .returning({ id: users.id })
        .all();
      const user = rows[0];
      if (user === undefined) throw new Error(`witness seed user ${name} failed`);
      return user.id;
    };
    const ownerId = await insertUser(`${RUN_TAG}owner`);
    const otherId = await insertUser(`${RUN_TAG}other`);
    const watchers: number[] = [ownerId, otherId];
    for (let i = 0; i < 3; i++) watchers.push(await insertUser(`${RUN_TAG}watch${i}`));
    const watcherAt = (i: number): number => {
      const id = watchers[i % watchers.length];
      if (id === undefined) throw new Error("witness seed watchers failed");
      return id;
    };

    const mkRepo = async (slug: string, repoOwnerId: number): Promise<string> => {
      const id = crypto.randomUUID();
      await db.insert(repositories).values({
        id,
        storageKey: `r_${id.slice(0, 8)}`,
        ownerNamespace: RUN_TAG,
        ownerId: repoOwnerId,
        slug,
        visibility: "public",
        createdAt: new Date(),
      });
      return id;
    };
    const targetRepo = await mkRepo(`wit-target-${RUN_TAG}`, ownerId);
    const otherRepo = await mkRepo(`wit-other-${RUN_TAG}`, otherId);
    // Two extra owner rows so the owner_id scan has sibling rows to skip.
    await mkRepo(`wit-extra1-${RUN_TAG}`, ownerId);
    await mkRepo(`wit-extra2-${RUN_TAG}`, otherId);

    const issueValues = (repoId: string, n: number): (typeof issues.$inferInsert)[] =>
      Array.from({ length: n }, (_, i) => ({
        repoId,
        index: i + 1,
        posterId: i % 5 === 0 ? otherId : ownerId,
        title: `witness issue ${i + 1}`,
        isPull: i % 10 === 0,
        isClosed: i % 3 === 0,
        createdAt: new Date((now - (n - i) * 60) * 1000),
        updatedAt: new Date((now - (n - i) * 30) * 1000),
      }));
    const targetValues = issueValues(targetRepo, WITNESS_TARGET_ISSUES);
    // Chunk sizes are the D1 100-variable cap divided by the table's column
    // count (drizzle's insert lists every column — see `chunks` above).
    for (const part of chunks(targetValues, 4)) await db.insert(issues).values(part);
    for (const part of chunks(issueValues(otherRepo, WITNESS_OTHER_ISSUES), 4)) await db.insert(issues).values(part);
    const seededTargetIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.repoId, targetRepo))
      .orderBy(asc(issues.id))
      .all();
    const targetIssueIds = seededTargetIssues.map((row) => row.id);
    const firstTargetIssue = targetIssueIds[0];
    if (firstTargetIssue === undefined) throw new Error("witness seed issues failed");

    const repoLabelValues = Array.from({ length: 30 }, (_, i) => ({
      repoId: targetRepo,
      name: `wit-label-${i}`,
      color: "#00aabb",
    }));
    for (const part of chunks(repoLabelValues, 8)) await db.insert(labels).values(part);
    const orgLabelValues = Array.from({ length: 15 }, (_, i) => ({
      orgId: ownerId,
      name: `wit-org-label-${i}`,
      color: "#00aabb",
    }));
    for (const part of chunks(orgLabelValues, 8)) await db.insert(labels).values(part);
    const otherLabelValues = Array.from({ length: 10 }, (_, i) => ({
      repoId: otherRepo,
      name: `wit-other-label-${i}`,
      color: "#00aabb",
    }));
    for (const part of chunks(otherLabelValues, 8)) await db.insert(labels).values(part);
    const milestoneValues = Array.from({ length: 20 }, (_, i) => ({
      repoId: targetRepo,
      name: `wit-milestone-${i}`,
      createdAt: new Date(),
    }));
    for (const part of chunks(milestoneValues, 8)) await db.insert(milestones).values(part);
    const otherMilestoneValues = Array.from({ length: 10 }, (_, i) => ({
      repoId: otherRepo,
      name: `wit-other-milestone-${i}`,
      createdAt: new Date(),
    }));
    for (const part of chunks(otherMilestoneValues, 8)) await db.insert(milestones).values(part);
    // Six reactions on each of the first 50 target issues (300 rows).
    for (const issueId of targetIssueIds.slice(0, 50)) {
      await db.insert(reactions).values(
        watchers.map((userId) => ({ userId, issueId, commentId: 0, releaseId: 0, type: "+1" })),
      );
    }
    const commentValues = targetIssueIds.slice(0, 60).map((issueId, i) => ({
      type: 0,
      posterId: watcherAt(i),
      issueId,
      content: `witness comment ${i}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    // ~29 columns → chunk 3 (the cap math in the sibling seed above).
    for (const part of chunks(commentValues, 3)) await db.insert(comments).values(part);
    const subscriptionValues = targetIssueIds
      .slice(0, 100)
      .flatMap((issueId) => watchers.slice(0, 2).map((userId) => ({ userId, issueId, isWatching: true })));
    for (const part of chunks(subscriptionValues, 18)) await db.insert(issueSubscriptions).values(part);
    const targetActionValues = Array.from({ length: 120 }, (_, i) => ({
      userId: watcherAt(i),
      opType: 1,
      actUserId: ownerId,
      repoId: targetRepo,
      content: `${i}|witness`,
      createdAt: new Date((now - i * 60) * 1000),
    }));
    for (const part of chunks(targetActionValues, 8)) await db.insert(actions).values(part);
    const otherActionValues = Array.from({ length: 40 }, (_, i) => ({
      userId: otherId,
      opType: 1,
      actUserId: otherId,
      repoId: otherRepo,
      content: `${i}|witness-other`,
      createdAt: new Date((now - i * 60) * 1000),
    }));
    for (const part of chunks(otherActionValues, 8)) await db.insert(actions).values(part);
    fixtures = { ownerId, otherId, targetRepo, otherRepo, firstTargetIssue };

    // -- state A: migrated (indexes present) ---------------------------------
    const shapes = witnessShapes(fixtures);
    for (const shape of shapes) {
      const plan = await explainPlan(raw, shape.sql, shape.binds(fixtures));
      expect(plan, `${shape.name}: plan must use ${shape.index} (with indexes)`).toMatch(
        new RegExp(`USING (COVERING )?INDEX ${shape.index}`),
      );
    }
    const withNumbers = new Map<string, { meanMs: number; rowsRead: number }>();
    for (const shape of shapes) {
      withNumbers.set(shape.name, await measureShape(raw, shape, shape.binds(fixtures), "witness-with"));
    }

    // -- state B: pre-migration (all ten dropped) ----------------------------
    // DDL goes through D1's exec() (the documented migration/setup path); the
    // sqlite_master re-check below turns a silent no-op drop into a failure.
    for (const [name] of WITNESS_INDEXES) {
      await raw.exec(`DROP INDEX IF EXISTS "${name}";`);
    }
    const droppedLeft = await raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${WITNESS_INDEXES.map(() => "?").join(",")})`,
      )
      .bind(...WITNESS_INDEXES.map(([name]) => name))
      .all<{ name: string }>();
    expect(droppedLeft.results, "witness drop must remove all ten indexes").toHaveLength(0);
    for (const shape of shapes) {
      const plan = await explainPlan(raw, shape.sql, shape.binds(fixtures));
      expect(plan, `${shape.name}: plan must NOT use ${shape.index} (indexes dropped)`).not.toMatch(
        new RegExp(`USING (COVERING )?INDEX ${shape.index}`),
      );
    }
    const withoutNumbers = new Map<string, { meanMs: number; rowsRead: number }>();
    for (const shape of shapes) {
      withoutNumbers.set(shape.name, await measureShape(raw, shape, shape.binds(fixtures), "witness-without"));
    }

    // -- restore: replay the migration DDL verbatim, re-check sqlite_master --
    for (const [, ddl] of WITNESS_INDEXES) await raw.exec(`${ddl};`);
    const restored = await raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${WITNESS_INDEXES.map(() => "?").join(",")})`,
      )
      .bind(...WITNESS_INDEXES.map(([name]) => name))
      .all<{ name: string }>();
    expect(restored.results.map((row) => row.name).sort(), "witness restore must leave all ten indexes").toEqual(
      WITNESS_INDEXES.map(([name]) => name).sort(),
    );

    // -- the numbers (informational; the gate was the plan assertions) --------
    const numbers: WitnessNumber[] = shapes.map((shape) => {
      const withN = withNumbers.get(shape.name);
      const withoutN = withoutNumbers.get(shape.name);
      if (withN === undefined || withoutN === undefined) throw new Error(`missing measurement for ${shape.name}`);
      return {
        shape: shape.name,
        index: shape.index,
        rowsReadWith: withN.rowsRead,
        rowsReadWithout: withoutN.rowsRead,
        meanMsWith: Math.round(withN.meanMs * 100) / 100,
        meanMsWithout: Math.round(withoutN.meanMs * 100) / 100,
      };
    });
    for (const n of numbers) {
      console.log(
        `[index-witness] ${n.shape.padEnd(26)} rows_read ${String(n.rowsReadWithout).padStart(6)} -> ` +
          `${String(n.rowsReadWith).padStart(6)}   mean ms ${String(n.meanMsWithout).padStart(8)} -> ` +
          `${String(n.meanMsWith).padStart(8)}   (${n.index})`,
      );
    }
    console.log(
      `##INDEX_WITNESS_JSON## ${JSON.stringify({
        schema_version: 1,
        target: "local",
        corpus: {
          target_issues: WITNESS_TARGET_ISSUES,
          other_issues: WITNESS_OTHER_ISSUES,
          labels: 55,
          milestones: 30,
          reactions: 300,
          comments: 60,
          subscriptions: 200,
          actions: 160,
          repositories: 4,
        },
        timed_runs_per_shape: WITNESS_TIMED_RUNS,
        shapes: numbers,
      })}`,
    );
  }, 300_000);
});
