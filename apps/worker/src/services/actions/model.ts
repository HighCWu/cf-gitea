/**
 * The Actions control-plane model (SPEC-0012 M1a) — D1 operations over the
 * twelve §4.1 tables, ported from gitea/models/actions/*.go at the pin.
 *
 * Every function takes the D1Database explicitly (the secrets-variables
 * service convention) and stays route-agnostic. Time columns are unix
 * seconds written through drizzle's timestamp mode; the upstream
 * `timeutil.TimeStamp` zero sentinels map to NULL on the nullable columns
 * (started/stopped/deleted/last_online/last_active) and to the 0-sentinel on
 * expired_unix (the retention arithmetic reads it as a number).
 *
 * Sentinel adaptation (schema.ts SPEC-0012 block): repo scoping is
 * `{ownerId, repoId: ""}` for owner/global rows and `{ownerId: 0, repoId}`
 * for repo rows — upstream's 0-repo-id sentinel, with the secrets-table ''
 * spelling.
 */

import { and, desc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunAttempts,
  actionRunnerTokens,
  actionRunners,
  actionRuns,
  actionRunJobs,
  actionTaskSteps,
  actionTasks,
  actionTasksVersions,
  repositories,
  users,
} from "../../db/schema";
import { sha256Hex, timingSafeDigestEqual } from "../../auth/digest";

/** A drizzle handle over the raw D1 binding (per-call, never stored). */
export type D1 = D1Database;

// ---------------------------------------------------------------------------
// Status + result enums (models/actions/status.go:15-25)
// ---------------------------------------------------------------------------

export const ACTION_STATUS_UNKNOWN = 0;
export const ACTION_STATUS_SUCCESS = 1;
export const ACTION_STATUS_FAILURE = 2;
export const ACTION_STATUS_CANCELLED = 3;
export const ACTION_STATUS_SKIPPED = 4;
export const ACTION_STATUS_WAITING = 5;
export const ACTION_STATUS_RUNNING = 6;
export const ACTION_STATUS_BLOCKED = 7;
export const ACTION_STATUS_CANCELLING = 8;
export const ACTION_STATUS_PENDING = 9;

/** runnerv1.Result values (wire.ts mirrors the proto enum). */
export const RUNNERV1_RESULT = {
  UNSPECIFIED: 0,
  SUCCESS: 1,
  FAILURE: 2,
  CANCELLED: 3,
  SKIPPED: 4,
} as const;

/**
 * Terminal-status → runnerv1.Result (Status.AsResult, status.go:103-116):
 * the four terminal statuses map, and CANCELLING maps to RESULT_CANCELLED
 * alongside CANCELLED — a task in its post-cancel cleanup phase reports
 * "you were cancelled" on the UpdateTask echo (runner.go:278-284 spells the
 * response as task.Status.AsResult()) and to `needs`-result consumers
 * through the same mapping. Everything else (waiting/running/blocked/…) is
 * RESULT_UNSPECIFIED.
 */
export function statusToResult(status: number): number {
  switch (status) {
    case ACTION_STATUS_SUCCESS:
      return RUNNERV1_RESULT.SUCCESS;
    case ACTION_STATUS_FAILURE:
      return RUNNERV1_RESULT.FAILURE;
    case ACTION_STATUS_CANCELLED:
    case ACTION_STATUS_CANCELLING:
      return RUNNERV1_RESULT.CANCELLED;
    case ACTION_STATUS_SKIPPED:
      return RUNNERV1_RESULT.SKIPPED;
    default:
      return RUNNERV1_RESULT.UNSPECIFIED;
  }
}

/** The statuses an ephemeral runner's live task may hold (task.go:84-88). */
export function isLiveTaskStatus(status: number): boolean {
  return (
    status === ACTION_STATUS_WAITING ||
    status === ACTION_STATUS_RUNNING ||
    status === ACTION_STATUS_BLOCKED ||
    status === ACTION_STATUS_CANCELLING
  );
}

// ---------------------------------------------------------------------------
// Token digests — the SPEC-0002 sha256-hex-at-rest model, salted (SPEC-0012
// §4.4: "salted sha256, the SPEC-0002 digest model verbatim"). Upstream uses
// salted-pbkdf2 at auth_model.HashToken; the at-rest digest is our platform
// model. Comparison is constant-time on the raw digests (auth/digest.ts).
// ---------------------------------------------------------------------------

export function hashRunnerToken(token: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${token}`);
}

export async function verifyRunnerToken(
  tokenHash: string,
  salt: string,
  presented: string,
): Promise<boolean> {
  const digest = await hashRunnerToken(presented, salt);
  return timingSafeDigestEqual(tokenHash, digest);
}

const HEX = "0123456789abcdef";

/** util.CryptoRandomString(40): 20 random bytes, hex-spelled. */
export function cryptoRandomToken(byteLen = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  let out = "";
  for (const b of bytes) {
    out += (HEX[b >> 4] ?? "") + (HEX[b & 0x0f] ?? "");
  }
  return out;
}

/** util.CryptoRandomString(10) — the token salt. */
export function cryptoRandomSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const b of bytes) {
    out += (HEX[b >> 4] ?? "") + (HEX[b & 0x0f] ?? "");
  }
  return out;
}

/** The generateSaltedToken quadruple (models/actions/utils.go:21-27). */
export interface SaltedToken {
  token: string;
  salt: string;
  hash: string;
  lastEight: string;
}

export async function generateSaltedToken(): Promise<SaltedToken> {
  const token = cryptoRandomToken(20);
  const salt = cryptoRandomSalt();
  const hash = await hashRunnerToken(token, salt);
  return { token, salt, hash, lastEight: token.slice(-8) };
}

/** util.EllipsisDisplayString(s, 255) — truncate to the limit runes with a
 *  trailing ellipsis (never splitting a surrogate pair). */
export function ellipsisDisplayString(s: string, limit: number): string {
  const runes = Array.from(s);
  if (runes.length <= limit) {
    return s;
  }
  return runes.slice(0, Math.max(0, limit - 1)).join("") + "…";
}

// ---------------------------------------------------------------------------
// Registration tokens (models/actions/runner_token.go)
// ---------------------------------------------------------------------------

export type RunnerTokenRow = typeof actionRunnerTokens.$inferSelect;

/** The three-scope normalization (runner_token.go:69-74): a repo-scoped
 *  token never carries an owner. */
export function normalizeTokenScope(
  ownerId: number,
  repoId: string,
): { ownerId: number; repoId: string } {
  if (repoId !== "") {
    return { ownerId: 0, repoId };
  }
  return { ownerId, repoId: "" };
}

/**
 * NewRunnerTokenWithValue (runner_token.go:74-98): deactivate every
 * same-scope ACTIVE token, then insert the new active one — one D1 batch,
 * one SQLite transaction (the reset semantics: the fresh token is the only
 * active one of its scope; other scopes are untouched).
 */
export async function newRunnerTokenWithValue(
  d1: D1,
  ownerId: number,
  repoId: string,
  token: string,
): Promise<RunnerTokenRow> {
  const scope = normalizeTokenScope(ownerId, repoId);
  const now = new Date();
  const db = drizzle(d1);
  const [, insert] = await db.batch([
    db
      .update(actionRunnerTokens)
      .set({ isActive: false, updated: now })
      .where(
        and(
          eq(actionRunnerTokens.ownerId, scope.ownerId),
          eq(actionRunnerTokens.repoId, scope.repoId),
          eq(actionRunnerTokens.isActive, true),
        ),
      ),
    db
      .insert(actionRunnerTokens)
      .values({
        token,
        ownerId: scope.ownerId,
        repoId: scope.repoId,
        isActive: true,
        created: now,
        updated: now,
      })
      .returning(),
  ]);
  const row = insert[0];
  if (row === undefined) {
    throw new Error("actions: runner token insert returned no row");
  }
  return row;
}

/** NewRunnerToken (runner_token.go:100-103). */
export function newRunnerToken(d1: D1, ownerId: number, repoId: string): Promise<RunnerTokenRow> {
  return newRunnerTokenWithValue(d1, ownerId, repoId, cryptoRandomToken(20));
}

/** GetRunnerToken (runner_token.go:50-58) — lookup by the RAW string. */
export async function getRunnerTokenByValue(d1: D1, token: string): Promise<RunnerTokenRow | null> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionRunnerTokens).where(eq(actionRunnerTokens.token, token)).limit(1);
  return rows[0] ?? null;
}

/** GetLatestRunnerToken (runner_token.go:105-125) — newest row of a scope. */
export async function getLatestRunnerToken(
  d1: D1,
  ownerId: number,
  repoId: string,
): Promise<RunnerTokenRow | null> {
  const scope = normalizeTokenScope(ownerId, repoId);
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(actionRunnerTokens)
    .where(and(eq(actionRunnerTokens.ownerId, scope.ownerId), eq(actionRunnerTokens.repoId, scope.repoId)))
    .orderBy(desc(actionRunnerTokens.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * GetOrCreateActiveRunnerToken (runner_token.go:127-134): reuse the latest
 * token while it is active; a reset (inactive latest) mints a fresh one —
 * which ALSO deactivates any other stragglers of the scope via
 * newRunnerTokenWithValue's sweep.
 */
export async function getOrCreateActiveRunnerToken(
  d1: D1,
  ownerId: number,
  repoId: string,
): Promise<RunnerTokenRow> {
  const latest = await getLatestRunnerToken(d1, ownerId, repoId);
  if (latest !== null && latest.isActive) {
    return latest;
  }
  return newRunnerToken(d1, ownerId, repoId);
}

// ---------------------------------------------------------------------------
// Runners (models/actions/runner.go)
// ---------------------------------------------------------------------------

export type RunnerRow = typeof actionRunners.$inferSelect;

export interface NewRunner {
  uuid: string;
  name: string;
  version: string;
  ownerId: number;
  repoId: string;
  agentLabels: string[];
  ephemeral: boolean;
  hasCancellingSupport: boolean;
}

export async function createRunner(d1: D1, runner: NewRunner): Promise<RunnerRow & { token: string }> {
  const db = drizzle(d1);
  const salted = await generateSaltedToken();
  const now = new Date();
  const rows = await db
    .insert(actionRunners)
    .values({
      uuid: runner.uuid,
      name: runner.name,
      version: runner.version,
      ownerId: runner.ownerId,
      repoId: runner.repoId,
      agentLabels: JSON.stringify(runner.agentLabels),
      ephemeral: runner.ephemeral,
      hasCancellingSupport: runner.hasCancellingSupport,
      tokenHash: salted.hash,
      tokenSalt: salted.salt,
      lastOnline: now,
      lastActive: now,
      created: now,
      updated: now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("actions: runner insert returned no row");
  }
  // The plaintext token is returned EXACTLY once (the Register response);
  // only the salted digest persists.
  return { ...row, token: salted.token };
}

export async function getRunnerByUUID(d1: D1, uuid: string): Promise<RunnerRow | null> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionRunners).where(eq(actionRunners.uuid, uuid)).limit(1);
  return rows[0] ?? null;
}

export async function getRunnerById(d1: D1, id: number): Promise<RunnerRow | null> {
  const db = drizzle(d1);
  const rows = await db.select().from(actionRunners).where(eq(actionRunners.id, id)).limit(1);
  return rows[0] ?? null;
}

/** UpdateRunner(ctx, runner, cols...) — the cols spelling as a partial. */
export async function updateRunner(
  d1: D1,
  id: number,
  cols: Partial<Pick<RunnerRow, "agentLabels" | "version" | "hasCancellingSupport" | "lastOnline" | "lastActive" | "isDisabled">>,
): Promise<void> {
  const db = drizzle(d1);
  await db
    .update(actionRunners)
    .set({ ...cols, updated: new Date() })
    .where(eq(actionRunners.id, id));
}

export async function deleteRunner(d1: D1, id: number): Promise<void> {
  const db = drizzle(d1);
  await db.delete(actionRunners).where(eq(actionRunners.id, id));
}

/** RunnerHeartbeatInterval (runner.go:64) — the last_online debounce. */
const RUNNER_HEARTBEAT_INTERVAL_MS = 30_000;
/** RunnerActiveInterval (runner.go:66) — the last_active debounce. */
const RUNNER_ACTIVE_INTERVAL_MS = 5_000;

/** ShouldPersistLastOnline (runner.go:89-92): true when stale enough to
 *  write — polls must NOT touch the DB per-request. */
export function shouldPersistLastOnline(last: Date | null, now: Date): boolean {
  if (last === null) {
    return true;
  }
  return now.getTime() - last.getTime() >= RUNNER_HEARTBEAT_INTERVAL_MS;
}

/** ShouldPersistLastActive (runner.go:94-99): the UpdateTask/UpdateLog
 *  streaming debounce. */
export function shouldPersistLastActive(last: Date | null, now: Date): boolean {
  if (last === null) {
    return true;
  }
  return now.getTime() - last.getTime() >= RUNNER_ACTIVE_INTERVAL_MS;
}

/** CanMatchLabels (runner.go:203-205): the job's runs-on is satisfiable iff
 *  it is non-empty and every label is in the runner's set (case-insensitive). */
export function canMatchLabels(agentLabels: string[], jobRunsOn: string[]): boolean {
  if (jobRunsOn.length === 0) {
    return false;
  }
  const lower = new Set(agentLabels.map((l) => l.toLowerCase()));
  return jobRunsOn.every((label) => lower.has(label.toLowerCase()));
}

// ---------------------------------------------------------------------------
// tasks_version (models/actions/tasks_version.go)
// ---------------------------------------------------------------------------

export type TasksVersionRow = typeof actionTasksVersions.$inferSelect;

/** GetTasksVersionByScope (tasks_version.go:28-44) — 0 when the scope row is
 *  missing (FetchTask bootstraps it, runner.go:179-187). */
export async function getTasksVersionByScope(
  d1: D1,
  ownerId: number,
  repoId: string,
): Promise<number> {
  const db = drizzle(d1);
  const rows = await db
    .select()
    .from(actionTasksVersions)
    .where(and(eq(actionTasksVersions.ownerId, ownerId), eq(actionTasksVersions.repoId, repoId)))
    .limit(1);
  return rows[0]?.version ?? 0;
}

/**
 * IncreaseTaskVersion (tasks_version.go:66-86): bump global → owner → repo
 * in cascade; a scope whose UPDATE affected zero rows self-heals by
 * inserting the row at version 1 (tasks_version.go:49-59). Upstream runs
 * this in one transaction; D1 gets update-then-conditional-insert per scope
 * (the counter is monotonic and the INSERT ... ON CONFLICT DO NOTHING keeps
 * concurrent bumps lossy-free at the row level — a bumped row is never
 * reset, so a lost race only means the next bump carries the change).
 */
export async function increaseTaskVersion(d1: D1, ownerId: number, repoId: string): Promise<void> {
  const db = drizzle(d1);
  const now = new Date();
  const scopes: Array<{ ownerId: number; repoId: string }> = [{ ownerId: 0, repoId: "" }];
  if (ownerId > 0) {
    scopes.push({ ownerId, repoId: "" });
  }
  if (repoId !== "") {
    scopes.push({ ownerId: 0, repoId });
  }
  for (const scope of scopes) {
    const updated = await db
      .update(actionTasksVersions)
      .set({ version: sql`${actionTasksVersions.version} + 1`, updated: now })
      .where(
        and(
          eq(actionTasksVersions.ownerId, scope.ownerId),
          eq(actionTasksVersions.repoId, scope.repoId),
        ),
      )
      .returning({ version: actionTasksVersions.version });
    if (updated.length === 0) {
      // The self-heal re-insert (version 1, exactly upstream's shape).
      await db
        .insert(actionTasksVersions)
        .values({
          ownerId: scope.ownerId,
          repoId: scope.repoId,
          version: 1,
          created: now,
          updated: now,
        })
        .onConflictDoNothing();
    }
  }
}

// ---------------------------------------------------------------------------
// Runs, attempts, jobs — the staged insert seam (the M3 trigger chain will
// replace the callers; the model is live now, SPEC §3 "jobs arrive via the
// test harness/fixtures").
// ---------------------------------------------------------------------------

export type RunRow = typeof actionRuns.$inferSelect;
export type RunAttemptRow = typeof actionRunAttempts.$inferSelect;
export type RunJobRow = typeof actionRunJobs.$inferSelect;

export interface InsertActionRunInput {
  repoId: string;
  ownerId: number;
  /** The workflow file path. */
  workflowId: string;
  /** The per-repo run number. M1a's caller supplies it (the repo_counters
   *  run_index sequence is M3, SPEC §4.5); UNIQUE(repo_id, index)
   *  arbitrates. */
  index: number;
  triggerUserId: number;
  ref: string;
  commitSha: string;
  event: string;
  eventPayload: string;
  triggerEvent: string;
  title?: string;
}

export interface InsertActionJobInput {
  jobId: string;
  name?: string;
  needs?: string[];
  runsOn?: string[];
  workflowPayload: Uint8Array;
  /** The ActionsTokenPermissions JSON (the OIDC id-token gate's row). */
  tokenPermissions?: string | null;
}

/**
 * The M1a staged InsertRun (services/actions/run.go:63-…, minus the
 * expression/concurrency machinery that is M3): run (waiting) + attempt-1
 * row + waiting jobs, then the tasks_version bump when a dispatchable
 * (waiting, non-reusable-caller) job exists — run.go:159-165 exactly.
 */
export async function insertActionRun(
  d1: D1,
  run: InsertActionRunInput,
  jobs: InsertActionJobInput[],
): Promise<{ run: RunRow; attempt: RunAttemptRow; jobRows: RunJobRow[] }> {
  const db = drizzle(d1);
  const now = new Date();

  const runRows = await db
    .insert(actionRuns)
    .values({
      title: ellipsisDisplayString(run.title ?? "", 255),
      repoId: run.repoId,
      ownerId: run.ownerId,
      workflowId: run.workflowId,
      index: run.index,
      triggerUserId: run.triggerUserId,
      ref: run.ref,
      commitSha: run.commitSha,
      event: run.event,
      eventPayload: run.eventPayload,
      triggerEvent: run.triggerEvent,
      status: ACTION_STATUS_WAITING,
      created: now,
      updated: now,
    })
    .returning();
  const runRow = runRows[0];
  if (runRow === undefined) {
    throw new Error("actions: run insert returned no row");
  }

  const attemptRows = await db
    .insert(actionRunAttempts)
    .values({
      repoId: run.repoId,
      runId: runRow.id,
      attempt: 1,
      triggerUserId: run.triggerUserId,
      status: ACTION_STATUS_WAITING,
      created: now,
      updated: now,
    })
    .returning();
  const attemptRow = attemptRows[0];
  if (attemptRow === undefined) {
    throw new Error("actions: run attempt insert returned no row");
  }
  await db
    .update(actionRuns)
    .set({ latestAttemptId: attemptRow.id, updated: now })
    .where(eq(actionRuns.id, runRow.id));

  // The job rows are ~40 columns — D1's 100-bind-per-query cap fits TWO
  // rows per statement (the repo's chunking idiom), so multi-job inserts
  // chunk (a lone-job insert — the M1a/M1b hot path — stays one statement).
  const jobValues = jobs.map((j) => ({
    runId: runRow.id,
    repoId: run.repoId,
    ownerId: run.ownerId,
    commitSha: run.commitSha,
    name: j.name ?? j.jobId,
    attempt: 1,
    workflowPayload: j.workflowPayload,
    jobId: j.jobId,
    needs: JSON.stringify(j.needs ?? []),
    runsOn: JSON.stringify(j.runsOn ?? []),
    tokenPermissions: j.tokenPermissions ?? null,
    status: ACTION_STATUS_WAITING,
    runAttemptId: attemptRow.id,
    created: now,
    updated: now,
  }));
  const JOB_CHUNK = 2;
  const jobRows: RunJobRow[] = [];
  for (let i = 0; i < jobValues.length; i += JOB_CHUNK) {
    const chunk = jobValues.slice(i, i + JOB_CHUNK);
    if (chunk.length === 0) continue;
    const rows = await db.insert(actionRunJobs).values(chunk).returning();
    jobRows.push(...rows);
  }

  const hasDispatchableWaiting = jobRows.some((j) => !j.isReusableCaller);
  if (hasDispatchableWaiting) {
    await increaseTaskVersion(d1, run.ownerId, run.repoId);
  }

  return { run: runRow, attempt: attemptRow, jobRows };
}

/** The repositories row the dispatch joins through (full name, owner,
 *  visibility — the OIDC claim's repository_visibility leg). */
export interface RepoRecord {
  id: string;
  ownerNamespace: string;
  ownerId: number | null;
  slug: string;
  visibility: string;
}

export async function getRepoById(d1: D1, id: string): Promise<RepoRecord | null> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      id: repositories.id,
      ownerNamespace: repositories.ownerNamespace,
      ownerId: repositories.ownerId,
      slug: repositories.slug,
      visibility: repositories.visibility,
    })
    .from(repositories)
    .where(eq(repositories.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUserById(d1: D1, id: number): Promise<{ id: number; username: string } | null> {
  const db = drizzle(d1);
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The dispatch scan + claim (models/actions/task.go:265-414)
// ---------------------------------------------------------------------------

export type TaskRow = typeof actionTasks.$inferSelect;

export interface TaskWithToken extends TaskRow {
  /** The plaintext polling token — generated at claim, returned to the
   *  runner, NEVER stored (the model keeps only the salted digest). */
  token: string;
}

const PICK_TASK_BATCH_SIZE = 100;

/**
 * The scope's candidate repositories for the dispatch scan (CreateTaskForRunner's
 * jobCond, task.go:279-286): a repo runner sees its repo; an owner runner
 * sees the owner's repos with the Actions unit enabled (upstream's
 * repo_unit type-10 join); null = a global runner sees everything.
 * The materialized read — the scan itself filters through
 * {@link scopeRepoCondition}, the same join as a subquery (see there for
 * why the scan must not consume this list directly).
 */
export async function scopeRepoIds(d1: D1, runner: RunnerRow): Promise<string[] | null> {
  const db = drizzle(d1);
  if (runner.repoId !== "") {
    return [runner.repoId];
  }
  if (runner.ownerId !== 0) {
    const rows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .innerJoin(sql`repo_units`, sql`repo_units.repo_id = repositories.id`)
      .where(and(sql`repositories.owner_id = ${runner.ownerId}`, sql`repo_units.type = 'actions'`));
    return rows.map((r) => r.id);
  }
  return null;
}

/**
 * The scan's scope filter (CreateTaskForRunner's jobCond, task.go:279-286):
 * a repo runner sees its repo; an owner runner sees the owner's repos with
 * the Actions unit enabled; a global runner gets undefined (no scope leg).
 * The owner branch keeps upstream's `builder.In("repo_id", subquery)` shape
 * (task.go:280-283) — an IN over the repo_unit JOIN SUBQUERY, not over
 * materialized ids: D1 caps a statement at 100 bound parameters, so the
 * materialized list (one bind per repo + the scan's three eq legs) 500s
 * every FetchTask once an owner passes ~95 actions-enabled repos, while the
 * subquery carries a single bind (the owner id) at any repo count. An empty
 * scope set needs no special case — the subquery matches nothing, which is
 * exactly an empty IN.
 */
export function scopeRepoCondition(d1: D1, runner: RunnerRow): SQL<unknown> | undefined {
  const db = drizzle(d1);
  if (runner.repoId !== "") {
    return eq(actionRunJobs.repoId, runner.repoId);
  }
  if (runner.ownerId !== 0) {
    return inArray(
      actionRunJobs.repoId,
      db
        .select({ id: repositories.id })
        .from(repositories)
        .innerJoin(sql`repo_units`, sql`repo_units.repo_id = repositories.id`)
        .where(and(sql`repositories.owner_id = ${runner.ownerId}`, sql`repo_units.type = 'actions'`)),
    );
  }
  return undefined;
}

/** Scan candidates for an idle runner (CreateTaskForRunner,
 *  task.go:265-331): keyset-paginated oldest-first over waiting, unclaimed,
 *  non-reusable-caller jobs within the runner's scope. Each label-matched
 *  candidate goes to `claim`; a lost race (null) moves to the next
 *  candidate — the CAS decides, the scan never errors on contention. */
export async function scanAndClaimWaitingJobs<T>(
  d1: D1,
  runner: RunnerRow,
  claim: (job: RunJobRow) => Promise<T | null>,
): Promise<T | null> {
  const db = drizzle(d1);
  const base: SQL<unknown>[] = [
    eq(actionRunJobs.taskId, 0),
    eq(actionRunJobs.status, ACTION_STATUS_WAITING),
    eq(actionRunJobs.isReusableCaller, false),
  ];
  const scope = scopeRepoCondition(d1, runner);
  if (scope !== undefined) {
    base.push(scope);
  }

  let cursorUpdated: Date | null = null;
  let cursorId = 0;
  for (;;) {
    const conds = [...base];
    if (cursorId > 0 && cursorUpdated !== null) {
      const afterCursor = or(
        gt(actionRunJobs.updated, cursorUpdated),
        and(eq(actionRunJobs.updated, cursorUpdated), gt(actionRunJobs.id, cursorId)),
      );
      if (afterCursor !== undefined) {
        conds.push(afterCursor);
      }
    }
    const page = await db
      .select()
      .from(actionRunJobs)
      .where(and(...conds))
      .orderBy(actionRunJobs.updated, actionRunJobs.id)
      .limit(PICK_TASK_BATCH_SIZE);

    const isLastPage = page.length < PICK_TASK_BATCH_SIZE;
    if (!isLastPage) {
      const last = page[page.length - 1];
      if (last !== undefined) {
        cursorUpdated = last.updated;
        cursorId = last.id;
      }
    }

    for (const job of page) {
      const jobRunsOn = JSON.parse(job.runsOn) as string[];
      if (!canMatchLabels(JSON.parse(runner.agentLabels) as string[], jobRunsOn)) {
        continue;
      }
      const task = await claim(job);
      if (task !== null) {
        return task;
      }
      // Another runner claimed this job concurrently; try the next one.
    }

    if (isLastPage) {
      return null;
    }
  }
}

/**
 * ReleaseTaskForRunner (task.go:420-437): delete the fresh task (and its
 * steps) and return the job to the waiting queue — used when the claim won
 * but payload assembly failed, so the job is not stranded in running.
 */
export async function releaseTaskForRunner(d1: D1, task: TaskRow, job: RunJobRow): Promise<void> {
  const db = drizzle(d1);
  const now = new Date();
  await db.batch([
    db.delete(actionTaskSteps).where(eq(actionTaskSteps.taskId, task.id)),
    db.delete(actionTasks).where(eq(actionTasks.id, task.id)),
    db
      .update(actionRunJobs)
      .set({ taskId: 0, status: ACTION_STATUS_WAITING, started: null, updated: now })
      .where(eq(actionRunJobs.id, job.id)),
  ]);
}
