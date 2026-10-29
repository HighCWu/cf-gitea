/**
 * FetchTask dispatch (SPEC-0012 §2.2 + §2.3, M1a): the answer-immediately
 * poll, the tasks_version semantics, and the claim CAS — ported from
 * routers/api/actions/runner/runner.go:168-217 and services/actions/task.go.
 *
 * THE STAGED SHAPE (SPEC §3, mission brief): the trigger chain is M3, so
 * runs/jobs arrive through the model's insertActionRun seam (tests, the
 * fake-runner harness, and M3's future producer). buildRunnerTask assembles
 * the full claim payload (context, secrets/vars reads, needs) except where a
 * stage is explicitly deferred:
 *   - workflow_payload: the stored single-job bytes VERBATIM — the
 *     `if: always()` claim-time rewrite needs the actionslib YAML model
 *     (M3's port; the server-side decision still stands, the runner just
 *     receives the raw stored job until the parser lands);
 *   - gitea_runtime_token / actions_id_token_request_*: omitted — they ride
 *     M1b's HS256 signer (§4.4's token-signing secret);
 *   - ref_protected: false — the SPEC-0013 protected-branch match service
 *     is wired at M3 with the commit-status family;
 *   - step rows: none inserted at claim (upstream parses them from the
 *     workflow payload via actionslib — M3); runner-REPORTED steps arrive
 *     through M1b's UpdateTask.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionRunners,
  actionRuns,
  actionRunJobs,
  actionTaskOutputs,
  actionTasks,
  actionVariables,
  secrets as actionSecrets,
} from "../../db/schema";
import {
  generateSaltedToken,
  getRepoById,
  getUserById,
  getTasksVersionByScope,
  increaseTaskVersion,
  isLiveTaskStatus,
  releaseTaskForRunner,
  scanAndClaimWaitingJobs,
  statusToResult,
  type RunJobRow,
  type RunnerRow,
  type RunRow,
  type RepoRecord,
  type TaskRow,
  type TaskWithToken,
} from "./model";
import type { Task, TaskNeed } from "./wire";

/** The D1/database binding spelling shared by the service functions. */
type D1 = D1Database;

/**
 * The blob columns store raw bytes; drizzle's default blob mode types them
 * `unknown` (its JSON builder) — every read narrows HERE, by inspection,
 * never by assertion.
 */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error("actions: blob column did not return bytes");
}

// ---------------------------------------------------------------------------
// The pick limiter (services/actions/task.go:31-53)
// ---------------------------------------------------------------------------

/** MAX_CONCURRENT_TASK_PICKS (modules/setting/actions.go:18,45,55). */
const MAX_CONCURRENT_TASK_PICKS = 16;

/**
 * Upstream's semaphore is per-process; on Workers each isolate carries its
 * own — the documented per-isolate divergence (SPEC §4.5 item 3). The CAS
 * remains the correctness mechanism; this only damps herd load.
 */
let taskPicksInFlight = 0;
const waiters: Array<() => void> = [];

function acquirePickSlot(): boolean {
  if (taskPicksInFlight >= MAX_CONCURRENT_TASK_PICKS) {
    return false;
  }
  taskPicksInFlight += 1;
  return true;
}

function releasePickSlot(): void {
  taskPicksInFlight -= 1;
  const next = waiters.shift();
  if (next !== undefined) {
    taskPicksInFlight += 1;
    next();
  }
}

/**
 * TryPickTask (task.go:41-53): bounded pick; throttled=true answers WITHOUT
 * touching the DB so the caller echoes the runner's stale tasks_version and
 * the runner retries on its next poll (runner.go:202-207).
 */
export async function tryPickTask(
  d1: D1,
  runner: RunnerRow,
  appUrl = "",
): Promise<{ task: Task | null; throttled: boolean }> {
  if (!acquirePickSlot()) {
    return { task: null, throttled: true };
  }
  try {
    const task = await pickTask(d1, runner, appUrl);
    return { task, throttled: false };
  } finally {
    releasePickSlot();
  }
}

/**
 * FetchTask (runner.go:168-217) minus the wire codec: returns the response
 * message's contents. The runner's served tasksVersion is advisory — the
 * server always attempts a pick on mismatch.
 */
export async function fetchTask(
  d1: D1,
  runner: RunnerRow,
  runnerTasksVersion: number,
  appUrl = "",
): Promise<{ task: Task | undefined; tasksVersion: number }> {
  let latestVersion = await getTasksVersionByScope(d1, runner.ownerId, runner.repoId);
  if (latestVersion === 0) {
    // Bootstrap 0→1 so the runner never sees version 0 ("would treat it as
    // an old version of Gitea", runner.go:179-187).
    await increaseTaskVersion(d1, runner.ownerId, runner.repoId);
    latestVersion = 1;
  }

  let task: Task | undefined;
  if (runnerTasksVersion !== latestVersion) {
    // Re-load fresh: a disable-while-polling race (runner.go:190-195).
    const db = drizzle(d1);
    const fresh = await db.select().from(actionRunners).where(eq(actionRunners.id, runner.id)).limit(1);
    const freshRunner = fresh[0];
    if (freshRunner === undefined) {
      return { task: undefined, tasksVersion: latestVersion };
    }
    const picked = await tryPickTask(d1, freshRunner, appUrl);
    if (picked.throttled) {
      // Keep the runner's STALE version so it retries on its next poll
      // instead of sleeping to the next bump (runner.go:202-207).
      latestVersion = runnerTasksVersion;
    } else if (picked.task !== null) {
      task = picked.task;
    }
  }
  return { task, tasksVersion: latestVersion };
}

// ---------------------------------------------------------------------------
// PickTask (services/actions/task.go:66-131)
// ---------------------------------------------------------------------------

async function pickTask(d1: D1, runner: RunnerRow, appUrl: string): Promise<Task | null> {
  if (runner.isDisabled) {
    return null;
  }

  if (runner.ephemeral) {
    const db = drizzle(d1);
    const existing = await db
      .select()
      .from(actionTasks)
      .where(eq(actionTasks.runnerId, runner.id))
      .limit(1);
    const prior = existing[0];
    if (prior !== undefined) {
      if (isLiveTaskStatus(prior.status)) {
        // One task per lifetime; the runner retries silently.
        return null;
      }
      // The task finished — remove the runner; the NEXT poll errors
      // ("runner has been removed", task.go:77-95).
      await db.delete(actionRunners).where(eq(actionRunners.id, runner.id));
      throw new Error("runner has been removed");
    }
  }

  const claimed = await createTaskForRunner(d1, runner);
  if (claimed === null) {
    return null;
  }

  try {
    return await buildRunnerTask(d1, claimed, appUrl);
  } catch (err) {
    // The job was claimed but the payload failed: release the claim so the
    // job returns to the waiting queue (task.go:108-112, ReleaseTaskForRunner).
    await releaseTaskForRunner(d1, claimed, claimed.job);
    throw err;
  }
}

/** The claim result carried through payload assembly (the in-memory
 *  plaintext token never persists). */
interface ClaimedTask extends TaskWithToken {
  job: RunJobRow;
}

/**
 * CreateTaskForRunner (task.go:265-331 + claimJobForRunner task.go:333-414):
 * scan waiting jobs oldest-first, label-match, then claim via the
 * conditional UPDATE — `task_id = 0 AND status = waiting` — one row or move
 * on (errJobAlreadyClaimed).
 */
async function createTaskForRunner(d1: D1, runner: RunnerRow): Promise<ClaimedTask | null> {
  return scanAndClaimWaitingJobs(d1, runner, (job) => claimJobForRunner(d1, runner, job));
}

async function claimJobForRunner(
  d1: D1,
  runner: RunnerRow,
  job: RunJobRow,
): Promise<ClaimedTask | null> {
  const db = drizzle(d1);
  const now = new Date();
  const salted = await generateSaltedToken();

  const taskRows = await db
    .insert(actionTasks)
    .values({
      jobId: job.id,
      attempt: job.attempt,
      runnerId: runner.id,
      status: 6, // ACTION_STATUS_RUNNING
      started: now,
      repoId: job.repoId,
      ownerId: job.ownerId,
      commitSha: job.commitSha,
      isForkPullRequest: job.isForkPullRequest,
      tokenHash: salted.hash,
      tokenSalt: salted.salt,
      tokenLastEight: salted.token.slice(-8),
      created: now,
      updated: now,
    })
    .returning();
  const task = taskRows[0];
  if (task === undefined) {
    throw new Error("actions: task insert returned no row");
  }

  // The claim CAS: exactly one row or the race is lost (task.go:392-400).
  const claimed = await db
    .update(actionRunJobs)
    .set({ taskId: task.id, status: 6, started: now, updated: now })
    .where(
      and(
        eq(actionRunJobs.id, job.id),
        eq(actionRunJobs.taskId, 0),
        eq(actionRunJobs.status, 5), // ACTION_STATUS_WAITING
      ),
    )
    .returning({ id: actionRunJobs.id });

  if (claimed.length !== 1) {
    // Another runner won between our scan and this update — undo the task
    // insert (the batch-atomicity upstream gets from its transaction) and
    // let the scan advance.
    await db.delete(actionTasks).where(eq(actionTasks.id, task.id));
    return null;
  }

  // logFileName(repoFullName, taskID) (task.go:657-665) — needs the repo's
  // full name; set post-insert (upstream does it inside the same
  // transaction; the M1a window between claim and filename is documented in
  // the module header).
  const repo = await getRepoById(d1, job.repoId);
  const fullName = repo !== null ? `${repo.ownerNamespace}/${repo.slug}` : "";
  const logFilename = `${fullName}/${(task.id % 256).toString(16).padStart(2, "0")}/${task.id}.log`;
  await db
    .update(actionTasks)
    .set({ logFilename, updated: new Date() })
    .where(eq(actionTasks.id, task.id));

  return {
    ...task,
    logFilename,
    token: salted.token,
    job,
  };
}

// ---------------------------------------------------------------------------
// buildRunnerTask (services/actions/task.go:135-260)
// ---------------------------------------------------------------------------

interface ClaimContext {
  task: TaskRow & { token: string };
  job: RunJobRow;
  run: RunRow;
  repo: RepoRecord | null;
}

/**
 * The full claim payload (buildRunnerTask): Task{id, workflow_payload,
 * context, secrets, vars, needs}. Assembly failures propagate so the caller
 * releases the claim.
 */
async function buildRunnerTask(d1: D1, claimed: ClaimedTask, appUrl: string): Promise<Task> {
  const db = drizzle(d1);
  const jobRows = await db.select().from(actionRunJobs).where(eq(actionRunJobs.id, claimed.jobId)).limit(1);
  const job = jobRows[0];
  if (job === undefined) {
    throw new Error(`actions: claimed job ${claimed.jobId} vanished`);
  }
  const runRows = await db.select().from(actionRuns).where(eq(actionRuns.id, job.runId)).limit(1);
  const run = runRows[0];
  if (run === undefined) {
    throw new Error(`actions: run ${job.runId} vanished`);
  }
  const repo = await getRepoById(d1, run.repoId);

  const ctx: ClaimContext = { task: claimed, job, run, repo };

  const [secrets, vars, needs, context] = await Promise.all([
    getSecretsOfTask(d1, ctx),
    getVariablesOfRun(d1, ctx),
    findTaskNeeds(d1, job),
    generateTaskContext(d1, appUrl, ctx),
  ]);

  return {
    id: claimed.id,
    // STAGED: the stored bytes verbatim — the `if: always()` rewrite is the
    // M3 parser's (see the module header).
    workflowPayload: asBytes(job.workflowPayload),
    context,
    secrets,
    machine: "",
    needs,
    vars,
  };
}

/** git.RefName ShortName/RefType (context.go:60-64). */
function refParts(ref: string): { shortName: string; refType: string } {
  if (ref.startsWith("refs/heads/")) {
    return { shortName: ref.slice("refs/heads/".length), refType: "branch" };
  }
  if (ref.startsWith("refs/tags/")) {
    return { shortName: ref.slice("refs/tags/".length), refType: "tag" };
  }
  if (ref.startsWith("refs/pull/")) {
    // GitHub reports pull-request refs as branches; ShortName is the number.
    const rest = ref.slice("refs/pull/".length);
    return { shortName: rest.replace(/\/(merge|head)$/, ""), refType: "branch" };
  }
  return { shortName: ref, refType: "" };
}

async function generateTaskContext(d1: D1, appUrl: string, ctx: ClaimContext): Promise<Record<string, unknown>> {
  const { task, job, run, repo } = ctx;
  const ownerNamespace = repo?.ownerNamespace ?? "";
  const slug = repo?.slug ?? "";
  const fullName = `${ownerNamespace}/${slug}`;

  let event: unknown;
  try {
    event = JSON.parse(run.eventPayload);
  } catch {
    event = {};
  }

  // The pull-request base/head refs (context.go:43-58) — the payload-driven
  // slice of the port; pull_request_target's ref rewrite included.
  let baseRef = "";
  let headRef = "";
  let ref = run.ref;
  let sha = run.commitSha;
  const payload = (event ?? {}) as {
    pull_request?: {
      base?: { ref?: string; sha?: string };
      head?: { ref?: string };
    };
  };
  if (payload.pull_request?.base?.ref !== undefined) {
    baseRef = payload.pull_request.base.ref;
    headRef = payload.pull_request.head?.ref ?? "";
    if (run.triggerEvent === "pull_request_target") {
      ref = `refs/heads/${baseRef}`;
      sha = payload.pull_request.base.sha ?? sha;
    }
  }

  const { shortName, refType } = refParts(ref);
  const triggerUser =
    run.triggerUserId > 0 ? await getUserById(d1, run.triggerUserId) : null;

  return {
    // standard contexts (context.go:76-110)
    action: "",
    action_path: "",
    action_ref: "",
    action_repository: "",
    action_status: "",
    actor: triggerUser?.username ?? "",
    api_url: `${appUrl}api/v1`,
    base_ref: baseRef,
    env: "",
    event,
    event_name: run.triggerEvent,
    event_path: "",
    graphql_url: "",
    head_ref: headRef,
    job: job.jobId,
    ref,
    ref_name: shortName,
    // STAGED (module header): the SPEC-0013 protected-ref match lands at M3.
    ref_protected: false,
    ref_type: refType,
    path: "",
    repository: fullName,
    repository_owner: ownerNamespace,
    repositoryUrl: `${appUrl}${fullName}`,
    retention_days: "",
    run_id: String(run.id),
    run_number: String(run.index),
    run_attempt: String(job.attempt),
    secret_source: "Actions",
    server_url: appUrl,
    sha,
    triggering_actor: "",
    workflow: run.workflowId,
    workspace: "",

    actor_id: String(run.triggerUserId),
    repository_id: String(run.repoId),
    repository_owner_id: String(run.ownerId),
    workflow_sha: run.workflowCommitSha,

    // additional contexts (context.go:118)
    gitea_default_actions_url: appUrl,

    // task-scoped additions (task.go:199-212)
    token: task.token,
    // STAGED: gitea_runtime_token + actions_id_token_request_* ride M1b's
    // HS256 signer (§4.4).
  };
}

/**
 * GetSecretsOfTask (models/secret/secret.go:155-190): GITHUB_TOKEN /
 * GITEA_TOKEN always; fork-PR runs (except pull_request_target) get nothing
 * else; then owner secrets overlaid by repo secrets (repo wins). Our
 * `secrets` table stores plaintext (the documented at-rest divergence,
 * schema.ts) — the read serves the stored value.
 */
export async function getSecretsOfTask(d1: D1, ctx: ClaimContext): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    GITHUB_TOKEN: ctx.task.token,
    GITEA_TOKEN: ctx.task.token,
  };

  if (ctx.run.isForkPullRequest && ctx.run.triggerEvent !== "pull_request_target") {
    return base;
  }

  const db = drizzle(d1);
  const ownerSecrets = await db
    .select()
    .from(actionSecrets)
    .where(and(eq(actionSecrets.ownerId, ctx.run.ownerId), eq(actionSecrets.repoId, "")));
  const repoSecrets = await db
    .select()
    .from(actionSecrets)
    .where(and(eq(actionSecrets.ownerId, 0), eq(actionSecrets.repoId, ctx.run.repoId)));

  for (const secret of [...ownerSecrets, ...repoSecrets]) {
    base[secret.name] = secret.data;
  }
  return base;
}

/**
 * GetVariablesOfRun (models/actions/variable.go:134-168): global → owner →
 * repo, later scope wins (Level precedence: Repo > Org / User > Global).
 */
export async function getVariablesOfRun(d1: D1, ctx: ClaimContext): Promise<Record<string, string>> {
  const db = drizzle(d1);
  const out: Record<string, string> = {};
  const globalVars = await db
    .select()
    .from(actionVariables)
    .where(and(eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, "")));
  const ownerVars = await db
    .select()
    .from(actionVariables)
    .where(and(eq(actionVariables.ownerId, ctx.run.ownerId), eq(actionVariables.repoId, "")));
  const repoVars = await db
    .select()
    .from(actionVariables)
    .where(and(eq(actionVariables.ownerId, 0), eq(actionVariables.repoId, ctx.run.repoId)));

  for (const v of [...globalVars, ...ownerVars, ...repoVars]) {
    out[v.name] = v.data;
  }
  return out;
}

/**
 * findTaskNeeds (services/actions/task.go:217-230 → models FindTaskNeeds):
 * for each YAML need of the claimed job, resolve the sibling job's task and
 * report its outputs + terminal result. Output rows read the
 * `action_task_outputs` table (M1b writes them; the read is live now).
 */
export async function findTaskNeeds(d1: D1, job: RunJobRow): Promise<Record<string, TaskNeed>> {
  const db = drizzle(d1);
  const needs: Record<string, TaskNeed> = {};
  const needIds = JSON.parse(job.needs) as string[];
  for (const needId of needIds) {
    const siblingRows = await db
      .select()
      .from(actionRunJobs)
      .where(and(eq(actionRunJobs.runId, job.runId), eq(actionRunJobs.jobId, needId)))
      .limit(1);
    const sibling = siblingRows[0];
    if (sibling === undefined || sibling.taskId === 0) {
      continue;
    }
    const taskRows = await db.select().from(actionTasks).where(eq(actionTasks.id, sibling.taskId)).limit(1);
    const neededTask = taskRows[0];
    if (neededTask === undefined) {
      continue;
    }
    const outputRows = await db
      .select({ key: actionTaskOutputs.outputKey, value: actionTaskOutputs.outputValue })
      .from(actionTaskOutputs)
      .where(eq(actionTaskOutputs.taskId, neededTask.id));
    const outputs: Record<string, string> = {};
    for (const row of outputRows) {
      outputs[row.key] = row.value;
    }
    needs[needId] = { outputs, result: statusToResult(neededTask.status) };
  }
  return needs;
}
