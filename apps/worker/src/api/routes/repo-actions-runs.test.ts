/**
 * The runs deep family (routes/repo-actions.ts's P1-11 section — the board's
 * row 11, P1-7's remainder slice 4 of 5) on real D1: all 14 contract ops of
 * the `/actions/tasks` + `/actions/runs/{run}[…]` group (api.go:1348-1379).
 * Standalone mount beside the landed repo-actions.test.ts rig — with the
 * OPTIONAL-AUTH argument passed, so the group's anonymous-capable reads and
 * the reader-403-before-token-401 ladder are exercised exactly as upstream
 * mounts them (the HANDOFF arg the header documents).
 *
 * Per-op pins, upstream-exact at fc493688:
 *   - ListActionTasks (action.go:786-858): the ActionTask wire (ToActionTask
 *     convert.go:248-274 — the raw Status.String name, PrettyRef head_branch,
 *     the job's commit sha, MakeAbsoluteURL(run.Link()) url, the Go-zero
 *     run_started_at), the `workflow_runs` envelope key (ActionTaskResponse's
 *     own struct, :41-46), the Link/X-Total-Count headers, the reader 403
 *     with the admin bypass.
 *   - GetWorkflowRun (action.go:1283-1306): the run wire over the latest
 *     attempt (explicit-null previous_attempt_url at attempt 1), the 404
 *     `run with id N: resource does not exist` (GetRunByRepoAndID's wrap,
 *     run.go:293 + APIErrorAuto), junk-id → the same 404.
 *   - getWorkflowRunAttempt (action.go:1308-1342): the wire over the GIVEN
 *     attempt (its status/times, its previous_attempt_url pointer), the 404
 *     `run attempt N for run M: resource does not exist` (run_attempt.go:95).
 *   - listWorkflowRunAttemptJobs (action.go:1652-1700): only THAT attempt's
 *     jobs; the sort/order 422 texts (the contract omits them — the landed
 *     org-jobs deviation, runtime-only) and the invalid-status 400.
 *   - deleteActionRun (action.go:1812-1849 + cleanup.go:168-256): the 204,
 *     the row cascade (run/attempts/jobs/tasks/steps/outputs/summaries/
 *     artifacts gone) + the storage deletions (sealed log + artifact object
 *     gone from R2), the not-done 400 text, the ladder (anonymous 401 AFTER
 *     the reader gates, plain-reader 403, the miss 404).
 *   - rerunWorkflowRun / rerunFailedWorkflowRun / rerunWorkflowJob
 *     (action.go:1344-1556) over the LANDED rerun service: the 201 run wire
 *     at run_attempt=2, the not-done 400, the disabled-workflow 400 text,
 *     the failed/cancelled filter with the pass-through split, the
 *     no-failed-jobs 400 text, the single-job 404 "workflow job not found",
 *     the new attempt's job wire (the attempt_job_id backfill arm).
 *   - cancelWorkflowRun / forceCancelWorkflowRun (actions_run.go:57-131 over
 *     cancel.go:26-90 + run_job.go:769-829): the done-run 409 text, the
 *     unclaimed CAS arm, the StopTask handshake (a cancelling-capable runner
 *     holds CANCELLING under cancel, force marks CANCELLED at once), the
 *     rendered post-cancellation run wire.
 *   - approveWorkflowRun (actions_run.go:160-205 over approve.go:25-140):
 *     the awaiting run's release (needs-less blocked job → waiting, the flag
 *     flip + approver stamp), the idempotent double-approve 200, the
 *     never-awaiting 409 text.
 *   - listWorkflowRunJobs (action.go:1598-1650): the junk-run 400 "runID
 *     must be a positive integer" (the binder arm, :1609-1612), the 422
 *     sort/order texts (utils/sort.go:31-39), the invalid-status 400, the
 *     latest-attempt scoping + desc order.
 *   - getWorkflowRunLogs (actions_run.go:218-268 over common/actions.go:
 *     42-96): the run archive zip (FileNameJoinFields name, per-job log
 *     entries, byte parity), the expired/absent skip arm, the empty-archive
 *     404 "logs not found", the reqToken 401 (api.go:1367 — token only, no
 *     writer).
 *   - getArtifactsOfRun (action.go:1755-1812): the ToActionArtifact render,
 *     the name filter, the NO-run-resolution quirk (an unknown run id answers
 *     200/0), the repo scoping over the rows, the silent page clamp with NO
 *     pagination headers.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actionArtifacts,
  actionLogChunks,
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  actionRunners,
  actionTaskOutputs,
  actionRunJobSummaries,
  actionTaskSteps,
  actionTasks,
  repoCollaborators,
  repoSettings,
  repoUnits,
  repositories,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  insertActionRun,
  type RunRow,
} from "../../services/actions/model";
import { saveRepoActionsConfig } from "../../services/actions/config";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerRepoActionsRoutes } from "./repo-actions";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "action_artifacts",
    "action_log_chunks",
    "action_tasks_versions",
    "action_task_steps",
    "action_task_outputs",
    "action_run_job_summaries",
    "action_tasks",
    "action_run_attempts",
    "action_run_jobs",
    "action_runs",
    "action_runners",
    "repo_units",
    "repo_settings",
    "repo_collaborators",
    "repositories",
    "user_redirects",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (the admin-actions.test.ts pattern):
// the optionalAuth mount is the HANDOFF shape (header note), so anonymous
// requests exercise the group's anonymous-capable reads and the exact
// reader-403-before-token-401 ladder.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username, isAdmin };
}

function apiUser(user: SeededUser): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoActionsRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const post = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "POST", headers: userId === undefined ? {} : authHeaders(userId) });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: userId === undefined ? {} : authHeaders(userId) });

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

const messageOf = async (res: Response): Promise<string> => (await jsonBody<{ message: string }>(res)).message;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

const WORKFLOW_ID = ".gitea/workflows/ci.yml";
const sha40 = (n: number): string => n.toString(16).padStart(40, "0");
const T0 = new Date(1_760_000_000 * 1000);

let repoSeq = 9700;

async function seedRepo(owner: SeededUser, opts: { actionsEnabled?: boolean; visibility?: "public" | "private" } = {}): Promise<string> {
  const repoId = String(repoSeq++);
  const actionsEnabled = opts.actionsEnabled ?? true;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: owner.username,
    ownerId: owner.id,
    slug: `repo${repoId}`,
    visibility: opts.visibility ?? "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: T0,
  });
  if (actionsEnabled) {
    await db().insert(repoSettings).values({ repoId, hasActions: true }).onConflictDoNothing();
    await db().insert(repoUnits).values({ repoId, type: "actions" }).onConflictDoNothing();
  } else {
    await db().insert(repoSettings).values({ repoId, hasActions: false }).onConflictDoNothing();
  }
  return repoId;
}

const WORKFLOW_PAYLOAD = new TextEncoder().encode(
  "name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
);

interface JobSeed {
  jobId: string;
  name?: string;
  needs?: string[];
  status?: number;
  started?: Date | null;
  stopped?: Date | null;
}

interface RunSeed {
  index?: number;
  ref?: string;
  event?: string;
  triggerEvent?: string;
  title?: string;
  runStatus?: number;
  needApproval?: boolean;
  approvedBy?: number;
  commitSha?: string;
  jobs?: JobSeed[];
}

async function seedRun(repoId: string, ownerId: number, seed: RunSeed = {}): Promise<{ run: RunRow; attemptId: number; jobIds: number[] }> {
  const seq = (await db().select({ id: actionRuns.id }).from(actionRuns).all()).length + 1;
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId,
      ownerId,
      workflowId: WORKFLOW_ID,
      index: seed.index ?? seq,
      triggerUserId: ownerId,
      ref: seed.ref ?? "refs/heads/main",
      commitSha: seed.commitSha ?? sha40(0xb000 + seq),
      event: seed.event ?? "push",
      eventPayload: "{}",
      triggerEvent: seed.triggerEvent ?? "push",
      title: seed.title,
    },
    (seed.jobs ?? [{ jobId: "build" }]).map((job) => ({
      jobId: job.jobId,
      name: job.name,
      needs: job.needs,
      workflowPayload: WORKFLOW_PAYLOAD,
    })),
  );
  const runCols: Record<string, unknown> = {};
  if (seed.runStatus !== undefined) runCols.status = seed.runStatus;
  if (seed.needApproval !== undefined) runCols.needApproval = seed.needApproval;
  if (seed.approvedBy !== undefined) runCols.approvedBy = seed.approvedBy;
  if (Object.keys(runCols).length > 0) {
    await db().update(actionRuns).set(runCols).where(eq(actionRuns.id, run.id));
    await db().update(actionRunAttempts).set({ status: seed.runStatus ?? attempt.status }).where(eq(actionRunAttempts.id, attempt.id));
  }
  for (const job of seed.jobs ?? []) {
    if (job.status === undefined) continue;
    const row = jobRows.find((r) => r.jobId === job.jobId);
    if (row === undefined) throw new Error(`job seed ${job.jobId} missing`);
    await db()
      .update(actionRunJobs)
      .set({ status: job.status, started: job.started ?? null, stopped: job.stopped ?? null })
      .where(eq(actionRunJobs.id, row.id));
  }
  return { run, attemptId: attempt.id, jobIds: jobRows.map((j) => j.id) };
}

let taskSeq = 8800;

interface TaskSeed {
  jobId: number;
  status?: number;
  runnerId?: number;
  logFilename?: string;
  logInStorage?: boolean;
  logExpired?: boolean;
  logContent?: string;
  started?: Date | null;
  stopped?: Date | null;
  updated?: Date;
}

async function seedTask(repoId: string, ownerId: number, seed: TaskSeed): Promise<number> {
  const id = taskSeq++;
  const content = seed.logContent ?? "line-1\nline-2\n";
  const bytes = new TextEncoder().encode(content);
  await db().insert(actionTasks).values({
    id,
    jobId: seed.jobId,
    attempt: 1,
    runnerId: seed.runnerId ?? 0,
    status: seed.status ?? ACTION_STATUS_RUNNING,
    started: seed.started ?? null,
    stopped: seed.stopped ?? null,
    repoId,
    ownerId,
    tokenHash: `hash-${id}`,
    tokenSalt: "salt",
    logFilename: seed.logFilename ?? `log-${id}.log`,
    logInStorage: seed.logInStorage ?? false,
    logLength: 2,
    logSize: bytes.length,
    logExpired: seed.logExpired ?? false,
    created: T0,
    updated: seed.updated ?? T0,
  });
  if ((seed.logInStorage ?? false) && seed.logFilename !== undefined) {
    await env.REPO_PACKS.put(`actions/logs/${seed.logFilename}`, bytes);
  } else {
    // The live-log arm: the chunk rows the readTaskLogRawBytes concatenation reads.
    await db().insert(actionLogChunks).values({ taskId: id, seq: 1, bytes });
  }
  return id;
}

let artifactSeq = 6100;

async function seedArtifact(
  repoId: string,
  runId: number,
  runAttemptId: number,
  name: string,
  opts: { status?: number; contentType?: string; size?: number; commitSha?: string } = {},
): Promise<{ id: number; storagePath: string }> {
  const id = artifactSeq++;
  const storagePath = `artifacts/${id}.zip`;
  await db().insert(actionArtifacts).values({
    id,
    repoId,
    runId,
    runAttemptId,
    artifactName: name,
    artifactPath: `dist/${name}.zip`,
    storagePath,
    commitSha: opts.commitSha ?? "",
    fileSize: opts.size ?? 42,
    fileCompressedSize: opts.size ?? 42,
    contentEncodingOrType: opts.contentType ?? "application/zip",
    status: opts.status ?? 2, // UploadConfirmed
    expiredUnix: 0,
    created: T0,
    updated: T0,
  });
  return { id, storagePath };
}

async function seedRunner(repoId: string, ownerId: number, hasCancellingSupport: boolean): Promise<number> {
  const rows = await db()
    .insert(actionRunners)
    .values({
      uuid: crypto.randomUUID(),
      name: `runner-${hasCancellingSupport ? "capable" : "plain"}`,
      version: "1.0.0",
      ownerId,
      repoId,
      agentLabels: "[]",
      ephemeral: false,
      isDisabled: false,
      hasCancellingSupport,
      tokenHash: `rhash-${crypto.randomUUID()}`,
      tokenSalt: "salt",
      lastOnline: new Date(),
      lastActive: new Date(),
      created: T0,
      updated: T0,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("runner seed failed");
  return row.id;
}

// ---------------------------------------------------------------------------
// Wire shapes (the assertions' projections)
// ---------------------------------------------------------------------------

interface WorkflowRunWire {
  id: number;
  url: string;
  previous_attempt_url: string | null;
  html_url: string;
  jobs_url: string;
  logs_url: string;
  artifacts_url: string;
  cancel_url: string;
  rerun_url: string;
  display_title: string;
  path: string;
  event: string;
  run_attempt: number;
  run_number: number;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  actor?: { login: string };
  trigger_actor?: { login: string };
  repository?: Record<string, unknown>;
  pull_requests: unknown[];
  created_at: string;
  updated_at: string;
  started_at: string;
  completed_at: string;
}

interface WorkflowJobWire {
  id: number;
  run_id: number;
  run_attempt: number;
  name: string;
  status: string;
  conclusion?: string;
  steps: unknown[];
  started_at: string;
  completed_at: string;
}

interface WorkflowTaskWire {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  display_title: string;
  status: string;
  workflow_id: string;
  url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string;
}

interface ArtifactWire {
  id: number;
  name: string;
  size_in_bytes: number;
  url: string;
  archive_download_url: string;
  expired: boolean;
  workflow_run: { id: number; repository_id: number; head_sha: string; run_attempt: number; status: string };
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** A minimal zip reader for the log-archive pins: walks the local headers
 *  (the writer emits flag-0 STORE entries with in-header sizes). */
async function zipEntriesOf(res: Response): Promise<Array<{ name: string; data: string }>> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries: Array<{ name: string; data: string }> = [];
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const size = view.getUint32(at + 18, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const dataStart = at + 30 + nameLen + extraLen;
    entries.push({ name, data: new TextDecoder().decode(bytes.subarray(dataStart, dataStart + size)) });
    at = dataStart + size;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ListActionTasks (action.go:786-858)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/tasks (ListActionTasks)", () => {
  it("renders the ActionTask wire over the repo's tasks with the pagination headers (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, { title: "the title", jobs: [{ jobId: "build", status: ACTION_STATUS_WAITING }] });
    const taskId = await seedTask(repoId, alice.id, {
      jobId: jobIds[0]!,
      status: ACTION_STATUS_RUNNING,
      logContent: "x\n",
    });
    await db().update(actionRunJobs).set({ taskId }).where(eq(actionRunJobs.id, jobIds[0]!));

    const res = await get(`/repos/alice/repo${repoId}/actions/tasks`, alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("1");
    const body = await jsonBody<{ workflow_runs: WorkflowTaskWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(1);
    const task = body.workflow_runs[0]!;
    expect(task.id).toBe(taskId);
    expect(task.name).toBe("build"); // t.Job.Name (convert.go:261)
    expect(task.head_branch).toBe("main"); // PrettyRef of refs/heads/main
    expect(task.head_sha).toBe(sha40(0xb000 + 1)); // the JOB's commit sha (convert.go:263)
    expect(task.run_number).toBe(run.index);
    expect(task.event).toBe("push"); // run.TriggerEvent (convert.go:265)
    expect(task.display_title).toBe("the title");
    expect(task.status).toBe("running"); // the raw Status.String name (convert.go:267)
    expect(task.workflow_id).toBe(WORKFLOW_ID);
    expect(task.url).toBe(`https://example.com/alice/repo${repoId}/actions/runs/${run.id}`); // MakeAbsoluteURL(run.Link())
    expect(task.run_started_at).toBe("0001-01-01T00:00:00Z"); // never started → Go zero
  });

  it("renders pull refs as #N and paginates with Link headers (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    await seedRun(repoId, alice.id, { ref: "refs/pull/7/head", jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS, started: T0, stopped: T0 }] });
    await seedRun(repoId, alice.id, { jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }] });
    await seedTask(repoId, alice.id, { jobId: (await db().select().from(actionRunJobs).orderBy(asc(actionRunJobs.id)).all())[0]!.id, status: ACTION_STATUS_SUCCESS });
    await seedTask(repoId, alice.id, { jobId: (await db().select().from(actionRunJobs).orderBy(asc(actionRunJobs.id)).all())[1]!.id, status: ACTION_STATUS_SUCCESS });

    const res = await get(`/repos/alice/repo${repoId}/actions/tasks?limit=1&page=1`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ workflow_runs: WorkflowTaskWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(2);
    expect(body.workflow_runs).toHaveLength(1);
    expect(body.workflow_runs[0]!.head_branch).toBe("#7"); // PrettyRef's pull arm
    expect(body.workflow_runs[0]!.status).toBe("success");
    const link = res.headers.get("link") ?? "";
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="last"');
  });

  it("403s a plain reader on a unit-disabled repo with upstream's text; the site admin passes", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const admin = await seedUser("site-admin", true);
    const repoId = await seedRepo(alice, { actionsEnabled: false });
    const res = await get(`/repos/alice/repo${repoId}/actions/tasks`, bob.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("user should have specific read permission or be a repo admin or a site admin");
    const adminRes = await get(`/repos/alice/repo${repoId}/actions/tasks`, admin.id);
    expect(adminRes.status).toBe(200);
  });

  it("reads anonymously on a public enabled repo (the group carries NO reqToken)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const res = await get(`/repos/alice/repo${repoId}/actions/tasks`);
    expect(res.status).toBe(200);
    expect((await jsonBody<{ total_count: number }>(res)).total_count).toBe(0);
  });

  it("404s an unknown repo", async () => {
    const alice = await seedUser("alice");
    const res = await get(`/repos/alice/missing-repo/actions/tasks`, alice.id);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GetWorkflowRun / getWorkflowRunAttempt (action.go:1283-1342)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/runs/{run} (GetWorkflowRun)", () => {
  it("renders the run wire over the latest attempt with the explicit-null previous_attempt_url (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { title: "seed: docs", runStatus: ACTION_STATUS_WAITING });

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<WorkflowRunWire>(res);
    expect(body.id).toBe(run.id);
    expect(body.url).toBe(`https://example.com/api/v1/repos/alice/repo${repoId}/actions/runs/${run.id}`);
    expect(body.html_url).toBe(`https://example.com/alice/repo${repoId}/actions/runs/${run.id}`);
    expect(body.jobs_url).toBe(`${body.url}/jobs`);
    expect(body.logs_url).toBe(`${body.url}/logs`);
    expect(body.artifacts_url).toBe(`${body.url}/artifacts`);
    expect(body.cancel_url).toBe(`${body.url}/cancel`);
    expect(body.rerun_url).toBe(`${body.url}/rerun`);
    expect(body.previous_attempt_url).toBeNull(); // attempt 1 renders null, not omitted
    expect(body.run_attempt).toBe(1);
    expect(body.run_number).toBe(run.index);
    expect(body.path).toBe(`${WORKFLOW_ID}@refs/heads/main`);
    expect(body.status).toBe("queued"); // ToRunActionsStatus(WAITING)
    expect(body.conclusion).toBeUndefined();
    expect(body.head_branch).toBe("main");
    expect(body.head_sha).toBe(run.commitSha);
    expect(body.actor?.login).toBe("alice");
    expect(body.trigger_actor?.login).toBe("alice");
    expect(body.pull_requests).toEqual([]);
  });

  it("404s an unknown run with the wrapped not-exist text — and a foreign repo's run id", async () => {
    const alice = await seedUser("alice");
    const other = await seedUser("other");
    const repoId = await seedRepo(alice);
    const otherRepoId = await seedRepo(other);
    const foreign = await seedRun(otherRepoId, other.id);

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/9999`, alice.id);
    expect(res.status).toBe(404);
    expect(await messageOf(res)).toBe("run with id 9999: resource does not exist");

    const foreignRes = await get(`/repos/alice/repo${repoId}/actions/runs/${foreign.run.id}`, alice.id);
    expect(foreignRes.status).toBe(404); // the repo-scoped lookup misses cross-repo
    expect(await messageOf(foreignRes)).toBe(`run with id ${foreign.run.id}: resource does not exist`);
  });

  it("404s a junk run segment (PathParamInt64 junk parses to 0)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/not-a-number`, alice.id);
    expect(res.status).toBe(404);
  });

  it("403s a plain reader on a unit-disabled repo", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repoId = await seedRepo(alice, { actionsEnabled: false });
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/1`, bob.id);
    expect(res.status).toBe(403);
    expect(await messageOf(res)).toBe("user should have specific read permission or be a repo admin or a site admin");
  });
});

describe("GET …/runs/{run}/attempts/{attempt} (getWorkflowRunAttempt)", () => {
  it("renders the GIVEN attempt's status/timing and its previous_attempt_url pointer (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, attemptId } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_FAILURE });
    // A second attempt (the rerun shape): succeeded, newer.
    const attempt2Rows = await db()
      .insert(actionRunAttempts)
      .values({ repoId, runId: run.id, attempt: 2, triggerUserId: alice.id, status: ACTION_STATUS_SUCCESS, created: T0, updated: T0 })
      .returning()
      .all();
    const attempt2 = attempt2Rows[0]!;
    await db().update(actionRuns).set({ latestAttemptId: attempt2.id }).where(eq(actionRuns.id, run.id));
    void attemptId;

    const res1 = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/1`, alice.id);
    expect(res1.status).toBe(200);
    const body1 = await jsonBody<WorkflowRunWire>(res1);
    expect(body1.run_attempt).toBe(1);
    expect(body1.status).toBe("completed");
    expect(body1.conclusion).toBe("failure"); // attempt 1's own status, not the latest
    expect(body1.previous_attempt_url).toBeNull();

    const res2 = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/2`, alice.id);
    expect(res2.status).toBe(200);
    const body2 = await jsonBody<WorkflowRunWire>(res2);
    expect(body2.run_attempt).toBe(2);
    expect(body2.conclusion).toBe("success");
    expect(body2.previous_attempt_url).toBe(`${body2.url}/attempts/1`); // convert.go:289-306
  });

  it("404s an unknown attempt number with the wrapped text", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id);
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/3`, alice.id);
    expect(res.status).toBe(404);
    expect(await messageOf(res)).toBe(`run attempt 3 for run ${run.id}: resource does not exist`);
  });
});

describe("GET …/runs/{run}/attempts/{attempt}/jobs (listWorkflowRunAttemptJobs)", () => {
  it("lists only the GIVEN attempt's jobs; the sort/order 422s resolve (runtime-only codes)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, { jobs: [{ jobId: "build", status: ACTION_STATUS_FAILURE }, { jobId: "lint", status: ACTION_STATUS_SUCCESS }] });
    // Attempt 2 with fresh rows (the rerun shape).
    const attempt2Rows = await db()
      .insert(actionRunAttempts)
      .values({ repoId, runId: run.id, attempt: 2, triggerUserId: alice.id, status: ACTION_STATUS_RUNNING, created: T0, updated: T0 })
      .returning()
      .all();
    const attempt2 = attempt2Rows[0]!;
    await db().insert(actionRunJobs).values({
      runId: run.id,
      repoId,
      ownerId: alice.id,
      commitSha: run.commitSha,
      name: "build",
      attempt: 2,
      workflowPayload: WORKFLOW_PAYLOAD,
      jobId: "build",
      needs: "[]",
      runsOn: "[]",
      status: ACTION_STATUS_RUNNING,
      runAttemptId: attempt2.id,
      created: T0,
      updated: T0,
    });

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/2/jobs`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ jobs: WorkflowJobWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(1); // attempt 2's rows only
    expect(body.jobs[0]!.run_attempt).toBe(2);

    const attempt1Res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/1/jobs`, alice.id);
    const body1 = await jsonBody<{ jobs: WorkflowJobWire[]; total_count: number }>(attempt1Res);
    expect(body1.total_count).toBe(2);
    expect(body1.jobs.map((j) => j.id)).toEqual(jobIds); // id ASC

    const badOrder = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/1/jobs?sort=id&order=sideways`, alice.id);
    expect(badOrder.status).toBe(422); // runtime-only — the attempt-jobs contract omits 422
    expect(await messageOf(badOrder)).toBe('Invalid sort order: "sideways"');
    const badSort = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/1/jobs?sort=bogus`, alice.id);
    expect(badSort.status).toBe(422);
    expect(await messageOf(badSort)).toBe('Invalid sort mode: "bogus"');
    const badStatus = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/attempts/1/jobs?status=bogus`, alice.id);
    expect(badStatus.status).toBe(400);
    expect(await messageOf(badStatus)).toBe("invalid status bogus");
  });
});

// ---------------------------------------------------------------------------
// deleteActionRun (action.go:1812-1849 + cleanup.go:168-256)
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/actions/runs/{run} (deleteActionRun)", () => {
  it("deletes a done run with its whole cascade — rows and storage — and answers 204", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS, jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }] });
    const logFilename = `sealed-${jobIds[0]}.log`;
    const taskId = await seedTask(repoId, alice.id, { jobId: jobIds[0]!, status: ACTION_STATUS_SUCCESS, logFilename, logInStorage: true, stopped: T0 });
    // The cascade's finer rows: a step, a task output, a job summary.
    await db().insert(actionTaskSteps).values({ name: "step", taskId, index: 1, repoId, created: T0, updated: T0 });
    await db().insert(actionTaskOutputs).values({ taskId, outputKey: "out", outputValue: "v" });
    await db().insert(actionRunJobSummaries).values({ repoId, runId: run.id, runAttemptId: run.latestAttemptId, jobId: jobIds[0]!, stepIndex: 0, created: T0, updated: T0 });
    const art = await seedArtifact(repoId, run.id, run.latestAttemptId, "dist");
    await env.REPO_PACKS.put(art.storagePath, new TextEncoder().encode("artifact-bytes"));

    const res = await del(`/repos/alice/repo${repoId}/actions/runs/${run.id}`, alice.id);
    expect(res.status).toBe(204);
    expect(await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)).all()).toHaveLength(0);
    expect(await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id)).all()).toHaveLength(0);
    expect(await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, run.id)).all()).toHaveLength(0);
    expect(await db().select().from(actionTasks).where(eq(actionTasks.id, taskId)).all()).toHaveLength(0);
    expect(await db().select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, taskId)).all()).toHaveLength(0);
    expect(await db().select().from(actionTaskOutputs).where(eq(actionTaskOutputs.taskId, taskId)).all()).toHaveLength(0);
    expect(await db().select().from(actionRunJobSummaries).where(eq(actionRunJobSummaries.runId, run.id)).all()).toHaveLength(0);
    expect(await db().select().from(actionArtifacts).where(eq(actionArtifacts.runId, run.id)).all()).toHaveLength(0);
    expect(await env.REPO_PACKS.get(`actions/logs/${logFilename}`)).toBeNull(); // removeTaskLog
    expect(await env.REPO_PACKS.get(art.storagePath)).toBeNull(); // the artifact object
  });

  it("400s a not-done run with upstream's text", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_WAITING });
    const res = await del(`/repos/alice/repo${repoId}/actions/runs/${run.id}`, alice.id);
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe("this workflow run is not done");
    expect(await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)).all()).toHaveLength(1);
  });

  it("ladder: anonymous 401 AFTER the reader gates (public+enabled passes the reader); plain-reader 403; 404 miss", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS });

    const anon = await del(`/repos/alice/repo${repoId}/actions/runs/${run.id}`);
    expect(anon.status).toBe(401); // the group ladder passed, then reqToken answered
    expect(await messageOf(anon)).toBe("token is required");

    const reader = await del(`/repos/alice/repo${repoId}/actions/runs/${run.id}`, bob.id);
    expect(reader.status).toBe(403); // visible + readable, but not a writer
    expect(await messageOf(reader)).toBe("user should have a permission to write to a repo");

    const miss = await del(`/repos/alice/repo${repoId}/actions/runs/424242`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("run with id 424242: resource does not exist");
  });
});

// ---------------------------------------------------------------------------
// The rerun trio (action.go:1344-1556 over services/actions/rerun.ts)
// ---------------------------------------------------------------------------

describe("POST …/runs/{run}/rerun (rerunWorkflowRun)", () => {
  it("creates attempt 2 with every job reset and answers the run wire at run_attempt=2 (201)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, {
      runStatus: ACTION_STATUS_FAILURE,
      jobs: [
        { jobId: "build", status: ACTION_STATUS_FAILURE, started: T0, stopped: T0 },
        { jobId: "lint", status: ACTION_STATUS_SUCCESS, started: T0, stopped: T0 },
      ],
    });

    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/rerun`, alice.id);
    expect(res.status).toBe(201);
    const body = await jsonBody<WorkflowRunWire>(res);
    expect(body.run_attempt).toBe(2);
    expect(body.status).toBe("queued"); // the rerun jobs wait again
    expect(body.previous_attempt_url).toBe(`${body.url}/attempts/1`);

    const attempts = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id)).all();
    expect(attempts).toHaveLength(2);
    const jobs2 = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, attempts[1]!.id)).all();
    expect(jobs2).toHaveLength(2);
    expect(jobs2.every((j) => j.status === ACTION_STATUS_WAITING)).toBe(true);
  });

  it("400s a not-done run (`this workflow run is not done`) and a disabled workflow", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run: live } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_RUNNING });
    const notDone = await post(`/repos/alice/repo${repoId}/actions/runs/${live.id}/rerun`, alice.id);
    expect(notDone.status).toBe(400);
    expect(await messageOf(notDone)).toBe("this workflow run is not done");

    await saveRepoActionsConfig(env.DB, repoId, {
      disabledWorkflows: [WORKFLOW_ID],
      disabledScopedWorkflows: {},
      collaborativeOwnerIds: [],
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      overrideOwnerConfig: false,
    });
    const { run: done } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS, index: 99 });
    const disabled = await post(`/repos/alice/repo${repoId}/actions/runs/${done.id}/rerun`, alice.id);
    expect(disabled.status).toBe(400);
    expect(await messageOf(disabled)).toBe(`workflow ${WORKFLOW_ID} is disabled`);
  });

  it("ladder: anonymous 401 after the reader; plain-reader 403; 404 miss", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS });

    const anon = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/rerun`);
    expect(anon.status).toBe(401);
    expect(await messageOf(anon)).toBe("token is required");

    const reader = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/rerun`, bob.id);
    expect(reader.status).toBe(403);
    expect(await messageOf(reader)).toBe("user should have a permission to write to a repo");

    const miss = await post(`/repos/alice/repo${repoId}/actions/runs/555555/rerun`, alice.id);
    expect(miss.status).toBe(404);
  });
});

describe("POST …/runs/{run}/rerun-failed-jobs (rerunFailedWorkflowRun)", () => {
  it("reruns only the failed/cancelled jobs — the succeeded one passes through — and answers a bare 201", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, {
      runStatus: ACTION_STATUS_FAILURE,
      jobs: [
        { jobId: "build", status: ACTION_STATUS_FAILURE, started: T0, stopped: T0 },
        { jobId: "ok", status: ACTION_STATUS_SUCCESS, started: T0, stopped: T0 },
      ],
    });

    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/rerun-failed-jobs`, alice.id);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe(""); // ctx.Status(http.StatusCreated) — empty body

    const attempts = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id)).orderBy(asc(actionRunAttempts.attempt)).all();
    expect(attempts).toHaveLength(2);
    const jobs2 = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runAttemptId, attempts[1]!.id)).orderBy(asc(actionRunJobs.id)).all();
    expect(jobs2).toHaveLength(2);
    const byName = new Map(jobs2.map((j) => [j.jobId, j]));
    expect(byName.get("build")!.status).toBe(ACTION_STATUS_WAITING); // reset
    expect(byName.get("ok")!.status).toBe(ACTION_STATUS_SUCCESS); // pass-through keeps the terminal status
    expect(byName.get("ok")!.sourceTaskId).toBe(0); // nothing claimed — the pass-through pointer stays empty
  });

  it("400s when the run has no failed jobs", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, {
      runStatus: ACTION_STATUS_SUCCESS,
      jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }],
    });
    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/rerun-failed-jobs`, alice.id);
    expect(res.status).toBe(400);
    expect(await messageOf(res)).toBe("this workflow run has no failed jobs to re-run");
  });
});

describe("POST …/runs/{run}/jobs/{job_id}/rerun (rerunWorkflowJob)", () => {
  it("reruns one job and answers the NEW attempt's job wire (201)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, {
      runStatus: ACTION_STATUS_FAILURE,
      jobs: [
        { jobId: "build", status: ACTION_STATUS_FAILURE, started: T0, stopped: T0 },
        { jobId: "lint", status: ACTION_STATUS_SUCCESS, started: T0, stopped: T0 },
      ],
    });

    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs/${jobIds[0]}/rerun`, alice.id);
    expect(res.status).toBe(201);
    const body = await jsonBody<WorkflowJobWire>(res);
    expect(body.run_attempt).toBe(2); // the new attempt's row
    expect(body.status).toBe("queued");
    expect(body.run_id).toBe(run.id);

    const attempts = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id)).orderBy(asc(actionRunAttempts.attempt)).all();
    expect(attempts).toHaveLength(2);
  });

  it("404s a job outside the run's latest attempt with APIErrorNotFound's text", async () => {
    const alice = await seedUser("alice");
    const other = await seedUser("other");
    const repoId = await seedRepo(alice);
    const otherRepoId = await seedRepo(other);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_FAILURE, jobs: [{ jobId: "build", status: ACTION_STATUS_FAILURE }] });
    const foreign = await seedRun(otherRepoId, other.id, { jobs: [{ jobId: "foreign", status: ACTION_STATUS_FAILURE }] });

    const foreignJob = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, foreign.run.id)).all())[0]!;
    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs/${foreignJob.id}/rerun`, alice.id);
    expect(res.status).toBe(404);
    expect(await messageOf(res)).toBe("workflow job not found");

    const junk = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs/999999/rerun`, alice.id);
    expect(junk.status).toBe(404);
    expect(await messageOf(junk)).toBe("workflow job not found");
  });
});

// ---------------------------------------------------------------------------
// cancel / force-cancel (actions_run.go:57-131 over cancel.go:26-90)
// ---------------------------------------------------------------------------

describe("POST …/runs/{run}/cancel + /force-cancel", () => {
  it("cancels an unclaimed waiting run: the job CAS-arm cancels and the wire renders completed/cancelled (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_WAITING, jobs: [{ jobId: "build", status: ACTION_STATUS_WAITING }] });

    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/cancel`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<WorkflowRunWire>(res);
    expect(body.status).toBe("completed");
    expect(body.conclusion).toBe("cancelled");

    const job = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, run.id)).all())[0]!;
    expect(job.status).toBe(ACTION_STATUS_CANCELLED);
    expect(job.stopped).not.toBeNull();
    const reloaded = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)).all())[0]!;
    expect(reloaded.status).toBe(ACTION_STATUS_CANCELLED);
  });

  it("409s a done run with upstream's text — before any mutation", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS, jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }] });
    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/cancel`, alice.id);
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toBe("run is already completed");
  });

  it("handshake: a cancelling-capable runner holds CANCELLING under cancel; force marks CANCELLED at once", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const runnerId = await seedRunner(repoId, alice.id, true);
    const { run, jobIds } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_RUNNING, jobs: [{ jobId: "build", status: ACTION_STATUS_RUNNING, started: T0 }] });
    await seedTask(repoId, alice.id, { jobId: jobIds[0]!, status: ACTION_STATUS_RUNNING, runnerId, updated: new Date() }); // fresh — inside the report timeout
    await db().update(actionRunJobs).set({ taskId: taskSeq - 1 }).where(eq(actionRunJobs.id, jobIds[0]!));

    const soft = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/cancel`, alice.id);
    expect(soft.status).toBe(200);
    expect((await jsonBody<WorkflowRunWire>(soft)).status).toBe("in_progress"); // cancelling renders in_progress
    const softJob = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, jobIds[0]!)).all())[0]!;
    expect(softJob.status).toBe(ACTION_STATUS_CANCELLING);

    // Re-cancel with force: no handshake — the task+job stop outright.
    const hard = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/force-cancel`, alice.id);
    expect(hard.status).toBe(200);
    const hardBody = await jsonBody<WorkflowRunWire>(hard);
    expect(hardBody.status).toBe("completed");
    expect(hardBody.conclusion).toBe("cancelled");
    const hardJob = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, jobIds[0]!)).all())[0]!;
    expect(hardJob.status).toBe(ACTION_STATUS_CANCELLED);
  });
});

// ---------------------------------------------------------------------------
// approveWorkflowRun (actions_run.go:160-205 over approve.go:25-140)
// ---------------------------------------------------------------------------

describe("POST …/runs/{run}/approve (approveWorkflowRun)", () => {
  it("approves an awaiting run: the flag flips, the approver stamps, the needs-less blocked job releases (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, {
      runStatus: ACTION_STATUS_BLOCKED,
      needApproval: true,
      jobs: [{ jobId: "build", status: ACTION_STATUS_BLOCKED }],
    });

    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/approve`, alice.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<WorkflowRunWire>(res);
    expect(body.status).toBe("queued"); // the released job re-aggregates to waiting

    const reloaded = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)).all())[0]!;
    expect(reloaded.needApproval).toBe(false);
    expect(reloaded.approvedBy).toBe(alice.id);
    const job = (await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, jobIds[0]!)).all())[0]!;
    expect(job.status).toBe(ACTION_STATUS_WAITING); // the release arm
  });

  it("is idempotent for an already-approved run (200) and 409s a run that never awaited", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_WAITING });
    await db().update(actionRuns).set({ needApproval: false, approvedBy: alice.id }).where(eq(actionRuns.id, run.id));

    const again = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/approve`, alice.id);
    expect(again.status).toBe(200); // the approvedBy != 0 arm renders the run

    const { run: never } = await seedRun(repoId, alice.id, { index: 42, runStatus: ACTION_STATUS_WAITING });
    const neverRes = await post(`/repos/alice/repo${repoId}/actions/runs/${never.id}/approve`, alice.id);
    expect(neverRes.status).toBe(409);
    expect(await messageOf(neverRes)).toBe("run is not waiting for approval");
  });
});

// ---------------------------------------------------------------------------
// listWorkflowRunJobs (action.go:1598-1650)
// ---------------------------------------------------------------------------

describe("GET …/runs/{run}/jobs (listWorkflowRunJobs)", () => {
  it("lists the latest attempt's jobs with the headers; the junk run 400s the binder text", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, {
      jobs: [
        { jobId: "build", status: ACTION_STATUS_SUCCESS, started: T0, stopped: T0 },
        { jobId: "lint", status: ACTION_STATUS_FAILURE, started: T0, stopped: T0 },
      ],
    });

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs`, alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await jsonBody<{ jobs: WorkflowJobWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(2);
    expect(body.jobs.map((j) => j.id)).toEqual(jobIds); // id ASC default
    expect(body.jobs[0]!.status).toBe("completed");
    expect(body.jobs[0]!.conclusion).toBe("success");

    const desc = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs?sort=id&order=desc`, alice.id);
    const descBody = await jsonBody<{ jobs: WorkflowJobWire[] }>(desc);
    expect(descBody.jobs.map((j) => j.id)).toEqual([...jobIds].reverse());

    const filtered = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs?status=failure`, alice.id);
    const filteredBody = await jsonBody<{ jobs: WorkflowJobWire[]; total_count: number }>(filtered);
    expect(filteredBody.total_count).toBe(1);
    expect(filteredBody.jobs[0]!.conclusion).toBe("failure");

    const junk = await get(`/repos/alice/repo${repoId}/actions/runs/not-a-number/jobs`, alice.id);
    expect(junk.status).toBe(400); // the junk parse lands 0 → the binder arm
    expect(await messageOf(junk)).toBe("runID must be a positive integer");

    const badOrder = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs?sort=id&order=sideways`, alice.id);
    expect(badOrder.status).toBe(422);
    expect(await messageOf(badOrder)).toBe('Invalid sort order: "sideways"');
    // A bare order with NO sort is IGNORED upstream (ResolveSortOrder's
    // absent-sort early return) — the 200 arm.
    const bareOrder = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/jobs?order=desc`, alice.id);
    expect(bareOrder.status).toBe(200);
  });

  it("404s an unknown run", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/777777/jobs`, alice.id);
    expect(res.status).toBe(404);
    expect(await messageOf(res)).toBe("run with id 777777: resource does not exist");
  });
});

// ---------------------------------------------------------------------------
// getWorkflowRunLogs (actions_run.go:218-268 over common/actions.go:42-96)
// ---------------------------------------------------------------------------

describe("GET …/runs/{run}/logs (getWorkflowRunLogs)", () => {
  it("streams the run archive: per-job entries, byte parity, the FileNameJoinFields name (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, { jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }, { jobId: "lint", status: ACTION_STATUS_SUCCESS }] });
    await seedTask(repoId, alice.id, { jobId: jobIds[0]!, status: ACTION_STATUS_SUCCESS, logContent: "build-log-a\nbuild-log-b\n" });
    const sealedName = `sealed-${jobIds[1]}.log`;
    await seedTask(repoId, alice.id, { jobId: jobIds[1]!, status: ACTION_STATUS_SUCCESS, logFilename: sealedName, logInStorage: true, logContent: "lint-log\n" });
    await db().update(actionRunJobs).set({ taskId: taskSeq - 2 }).where(eq(actionRunJobs.id, jobIds[0]!));
    await db().update(actionRunJobs).set({ taskId: taskSeq - 1 }).where(eq(actionRunJobs.id, jobIds[1]!));

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/logs`, alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(`ci-run-${run.id}-logs.zip`); // PathBaseStem(workflowId) + run + id + logs
    const entries = await zipEntriesOf(res);
    expect(entries).toHaveLength(2);
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    expect(byName.get(`ci-build-${taskSeq - 2}.log`)).toBe("build-log-a\nbuild-log-b\n");
    expect(byName.get(`ci-lint-${taskSeq - 1}.log`)).toBe("lint-log\n");
  });

  it("skips expired-log jobs; answers 404 `logs not found` when nothing composes", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run, jobIds } = await seedRun(repoId, alice.id, { jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }] });
    await seedTask(repoId, alice.id, { jobId: jobIds[0]!, status: ACTION_STATUS_SUCCESS, logExpired: true });

    const empty = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/logs`, alice.id);
    expect(empty.status).toBe(404);
    expect(await messageOf(empty)).toBe("logs not found");
  });

  it("carries reqToken ONLY (api.go:1367): anonymous 401 after the reader gates; 404 run miss", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { jobs: [{ jobId: "build", status: ACTION_STATUS_SUCCESS }] });

    const anon = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/logs`);
    expect(anon.status).toBe(401);
    expect(await messageOf(anon)).toBe("token is required");

    const miss = await get(`/repos/alice/repo${repoId}/actions/runs/888888/logs`, alice.id);
    expect(miss.status).toBe(404);
    expect(await messageOf(miss)).toBe("run with id 888888: resource does not exist");
  });
});

// ---------------------------------------------------------------------------
// getArtifactsOfRun (action.go:1755-1812)
// ---------------------------------------------------------------------------

describe("GET …/runs/{run}/artifacts (getArtifactsOfRun)", () => {
  it("renders the run's finalized artifacts with the ToActionArtifact wire and NO pagination headers (200)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_SUCCESS, commitSha: sha40(0xfeed) });
    await seedArtifact(repoId, run.id, run.latestAttemptId, "dist", { size: 42, commitSha: run.commitSha });
    await seedArtifact(repoId, run.id, run.latestAttemptId, "reports", { size: 7, commitSha: run.commitSha });

    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/artifacts`, alice.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBeNull(); // the handler only ctx.JSONes the body
    const body = await jsonBody<{ artifacts: ArtifactWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(2);
    const art = body.artifacts.find((a) => a.name === "dist")!;
    expect(art.size_in_bytes).toBe(42);
    expect(art.url).toBe(`https://example.com/api/v1/repos/alice/repo${repoId}/actions/artifacts/${art.id}`);
    expect(art.archive_download_url).toBe(`${art.url}/zip`);
    expect(art.expired).toBe(false);
    expect(art.workflow_run.id).toBe(run.id); // ONLY {id, repository_id, head_sha} carry values
    expect(art.workflow_run.repository_id).toBe(Number(repoId));
    expect(art.workflow_run.head_sha).toBe(sha40(0xfeed));
    expect(art.workflow_run.run_attempt).toBe(0); // the zero-valued embed

    const filtered = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/artifacts?name=reports`, alice.id);
    const filteredBody = await jsonBody<{ artifacts: ArtifactWire[]; total_count: number }>(filtered);
    expect(filteredBody.total_count).toBe(1);
    expect(filteredBody.artifacts[0]!.name).toBe("reports");
  });

  it("answers an unknown run id with 200/0 (upstream resolves NO run row) and never lists a foreign repo's rows", async () => {
    const alice = await seedUser("alice");
    const other = await seedUser("other");
    const repoId = await seedRepo(alice);
    const otherRepoId = await seedRepo(other);
    const { run } = await seedRun(repoId, alice.id);

    const unknown = await get(`/repos/alice/repo${repoId}/actions/runs/31337/artifacts`, alice.id);
    expect(unknown.status).toBe(200);
    expect(await jsonBody<{ total_count: number }>(unknown)).toEqual({ artifacts: [], total_count: 0 });

    // An artifact row planted under the visible run's id but a FOREIGN repo
    // id stays unlisted (upstream ANDs RepoID — the row-level scoping).
    await seedArtifact(otherRepoId, run.id, run.latestAttemptId, "planted");
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/artifacts`, alice.id);
    expect((await jsonBody<{ total_count: number }>(res)).total_count).toBe(0);
  });

  it("clamps the page silently (the default 30-cap semantics)", async () => {
    const alice = await seedUser("alice");
    const repoId = await seedRepo(alice);
    const { run } = await seedRun(repoId, alice.id);
    for (let i = 0; i < 3; i++) {
      await seedArtifact(repoId, run.id, run.latestAttemptId, `art-${i}`);
    }
    const res = await get(`/repos/alice/repo${repoId}/actions/runs/${run.id}/artifacts?limit=2&page=2`, alice.id);
    const body = await jsonBody<{ artifacts: ArtifactWire[]; total_count: number }>(res);
    expect(body.total_count).toBe(3); // the count is the full filter, the page slices
    expect(body.artifacts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The scope-gate sanity: the write sextet's 401/403 arms never fire for the
// repo admin (the bypass arm) — one representative pin.
// ---------------------------------------------------------------------------

describe("gate bypass (the repo-admin arms)", () => {
  it("a plain collaborator write grant passes the writer gate (cancel)", async () => {
    const alice = await seedUser("alice");
    const writer = await seedUser("writer");
    const repoId = await seedRepo(alice);
    await db().insert(repoCollaborators).values({
      repoId,
      userId: writer.id,
      mode: "write",
      createdAt: T0,
    });
    const { run } = await seedRun(repoId, alice.id, { runStatus: ACTION_STATUS_WAITING });
    const res = await post(`/repos/alice/repo${repoId}/actions/runs/${run.id}/cancel`, writer.id);
    expect(res.status).toBe(200); // canWriteRepository's write grant passes reqRepoWriter
  });
});
