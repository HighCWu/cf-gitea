/**
 * The Actions webhook emissions suite (GAPS #7): the status vocabulary
 * ports, the announce-once filter, the WorkflowRunPayload /
 * WorkflowJobPayload byte shapes (hook.go field order pinned via
 * Object.keys), the workflow-definition resolution (the gone-file silence
 * arm, the disabled-manually state, the yaml-name rule, the org block), the
 * subscription/branch-filter delivery conditions, and the batch emitter's
 * run-then-jobs order. Real local D1 (the rerun.test.ts fixture pattern) +
 * an in-memory engine-cell read fake for the definition resolution.
 *
 * The schedule arm's disposition rides the module header: HookEventSchedule
 * is not a wire event upstream (no PrepareWebhooks caller, AllEvents()
 * excludes it), so a scheduled run's webhook surface is exactly the
 * creation batch these units pin — workflow_run + workflow_job with the
 * run's event field spelling "schedule" (asserted in Unit F).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { TextEncoder } from "node:util";

import { actionRunAttempts, actionRunJobs, actionRuns, actionTaskSteps, actionTasks, webhookDeliveries, webhooks, users, repositories, repoUnits } from "../../db/schema";
import { parseRepoActionsConfig, saveRepoActionsConfig } from "./config";
import { findRepositoryById } from "../../api/services/repository";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  insertActionRun,
} from "./model";
import {
  emitWorkflowJobStatus,
  emitWorkflowJobsAndRunStatus,
  emitWorkflowRunStatus,
  resolveWorkflowForRun,
  toActionsStatus,
  toRunActionsStatus,
  toWorkflowRunAction,
  type ActionsWebhookBindings,
  type WorkflowDefinitionReads,
} from "./webhook-events";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "webhook_deliveries",
  "webhooks",
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_task_steps",
  "action_tasks_versions",
  "repo_units",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);
const T0 = new Date("2026-01-01T00:00:00Z");
const USER_ID = 42;
const ORG_ID = 77;
const REPO_ID = "repo-hex-1";
const REPO_ORG = "repo-hex-2";
const WORKFLOW_ID = "ci.yml";
const COMMIT = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode(
  JSON.stringify({ name: "build", "job-id": "build", data: { job: "build" }, needs: [], "runs-on": [], requires: [] }),
);

async function seedUser(id: number, username: string, type: "user" | "org" = "user"): Promise<void> {
  await db().insert(users).values({
    id,
    username,
    usernameLower: username,
    type,
    status: "active",
    createdAt: T0,
  });
}

async function seedRepo(repoId: string, ownerId: number, namespace: string): Promise<void> {
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: namespace,
    ownerId,
    slug: "demo",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId, type: "actions" });
}

async function seedRepoHooks(): Promise<void> {
  await seedUser(USER_ID, "alice");
  await seedUser(ORG_ID, "acme", "org");
  await seedRepo(REPO_ID, USER_ID, "alice");
  await seedRepo(REPO_ORG, ORG_ID, "acme");
}

/** A repo hook with a raw HookEvent JSON blob. */
async function seedHook(repoId: string, events: string): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({ repoId, url: "https://hooks.example/run", events, isActive: true })
    .returning({ id: webhooks.id });
  return rows[0]!.id;
}

interface SeedRunInput {
  repoId?: string;
  ownerId?: number;
  workflowId?: string;
  index?: number;
  triggerUserId?: number;
  ref?: string;
  commitSha?: string;
  event?: string;
  eventPayload?: string;
  triggerEvent?: string;
  latestAttemptId?: number;
  jobs?: Array<{ jobId: string; needs?: string[]; runsOn?: string[] }>;
}

async function seedRun(input: SeedRunInput = {}) {
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: input.repoId ?? REPO_ID,
      ownerId: input.ownerId ?? USER_ID,
      workflowId: input.workflowId ?? WORKFLOW_ID,
      index: input.index ?? 1,
      triggerUserId: input.triggerUserId ?? USER_ID,
      ref: input.ref ?? "refs/heads/main",
      commitSha: input.commitSha ?? COMMIT,
      event: input.event ?? "push",
      eventPayload: input.eventPayload ?? "{}",
      triggerEvent: input.triggerEvent ?? "push",
      ...(input.latestAttemptId !== undefined ? { latestAttemptId: input.latestAttemptId } : {}),
    },
    (input.jobs ?? [{ jobId: "build", runsOn: ["ubuntu-latest"] }]).map((j) => ({ workflowPayload: PAYLOAD, runsOn: ["ubuntu-latest"], ...j })),
  );
  return { run, attempt, jobRows };
}

/** The deliveries of one event type, payloads parsed. */
async function deliveriesOf(eventType: "workflow_run" | "workflow_job"): Promise<Array<Record<string, unknown>>> {
  const rows = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.eventType, eventType)).all();
  return rows.map((r) => JSON.parse(r.payloadContent) as Record<string, unknown>);
}

async function deliveryCount(eventType: "workflow_run" | "workflow_job"): Promise<number> {
  const rows = await db().select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.eventType, eventType)).all();
  return rows.length;
}

/** The in-memory engine-cell read fake: `.gitea/workflows/ci.yml` exists,
 *  the listing commit's author time is fixed. */
function fakeReads(options: { content?: string; entryName?: string; authorTime?: number; noTree?: boolean } = {}): WorkflowDefinitionReads {
  const entryName = options.entryName ?? WORKFLOW_ID;
  const content = options.content ?? "name: Demo CI\njobs:\n  build:\n    steps: []\n";
  const authorTime = options.authorTime ?? 1767225600; // 2026-01-01T00:00:00Z
  return {
    listTree(_ref: string, path: string) {
      if (options.noTree) return Promise.resolve(null);
      if (path !== ".gitea/workflows" && path !== ".gitea/scoped_workflows") return Promise.resolve(null);
      return Promise.resolve({ entries: [{ name: entryName, type: "blob" as const }] });
    },
    readBlob(_ref: string, path: string) {
      if (path !== `.gitea/workflows/${entryName}` && path !== `.gitea/scoped_workflows/${entryName}`) return Promise.resolve(null);
      return Promise.resolve({ data: new TextEncoder().encode(content) });
    },
    readCommit(_id: string) {
      return Promise.resolve({ oid: COMMIT, author: { name: "alice", email: "a@example", time: authorTime, tz: "+0000" } });
    },
  };
}

/** A bindings view over the fake: REPO present when `reads` is, the cell
 *  serving every full name. */
function bindingsWith(reads: WorkflowDefinitionReads | null): ActionsWebhookBindings {
  return {
    DB: env.DB,
    REPO:
      reads === null
        ? undefined
        : {
            getByName(_id: string) {
              return reads;
            },
          },
  };
}

// ---------------------------------------------------------------------------
// Unit A — the status vocabulary (convert.go:435-486)
// ---------------------------------------------------------------------------

describe("the status vocabulary ports", () => {
  it("toActionsStatus: queued/pending/requested/in_progress and the four conclusions", () => {
    expect(toActionsStatus(ACTION_STATUS_WAITING)).toEqual({ action: "queued", conclusion: "" });
    expect(toActionsStatus(ACTION_STATUS_BLOCKED)).toEqual({ action: "pending", conclusion: "" });
    expect(toActionsStatus(ACTION_STATUS_PENDING)).toEqual({ action: "requested", conclusion: "" });
    expect(toActionsStatus(ACTION_STATUS_RUNNING)).toEqual({ action: "in_progress", conclusion: "" });
    expect(toActionsStatus(ACTION_STATUS_CANCELLING)).toEqual({ action: "in_progress", conclusion: "" }); // CANCELLING runs the runner handshake — still in progress
    expect(toActionsStatus(ACTION_STATUS_SUCCESS)).toEqual({ action: "completed", conclusion: "success" });
    expect(toActionsStatus(ACTION_STATUS_FAILURE)).toEqual({ action: "completed", conclusion: "failure" });
    expect(toActionsStatus(ACTION_STATUS_CANCELLED)).toEqual({ action: "completed", conclusion: "cancelled" });
    expect(toActionsStatus(ACTION_STATUS_SKIPPED)).toEqual({ action: "completed", conclusion: "skipped" });
  });

  it("toRunActionsStatus: the approval-gated blocked job renders waiting (convert.go:451-454)", () => {
    expect(toRunActionsStatus({ needApproval: true }, ACTION_STATUS_BLOCKED)).toEqual({ action: "waiting", conclusion: "" });
    expect(toRunActionsStatus({ needApproval: false }, ACTION_STATUS_BLOCKED)).toEqual({ action: "pending", conclusion: "" });
    expect(toRunActionsStatus({ needApproval: false }, ACTION_STATUS_SUCCESS)).toEqual({ action: "completed", conclusion: "success" });
  });

  it("toWorkflowRunAction: requested/in_progress/completed (convert.go:435-448)", () => {
    expect(toWorkflowRunAction(ACTION_STATUS_WAITING)).toBe("requested");
    expect(toWorkflowRunAction(ACTION_STATUS_BLOCKED)).toBe("requested");
    expect(toWorkflowRunAction(ACTION_STATUS_RUNNING)).toBe("in_progress");
    expect(toWorkflowRunAction(ACTION_STATUS_SUCCESS)).toBe("completed");
    expect(toWorkflowRunAction(ACTION_STATUS_FAILURE)).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Unit B — the announce-once filter + the workflow_job payload shape
// ---------------------------------------------------------------------------

describe("emitWorkflowJobStatus (the announce filter + WorkflowJobPayload)", () => {
  it("a queued job announces with the exact field order and shape", async () => {
    await seedRepoHooks();
    const hookId = await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { run, jobRows } = await seedRun();
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test/" }, REPO_ID, jobRows[0]!.id);

    const rows = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe("workflow_job");
    expect(rows[0]!.eventGroup).toBe("workflow_job"); // Event() default case — the type itself
    const payload = JSON.parse(rows[0]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["action", "workflow_job", "repository", "sender"]);
    expect(payload.action).toBe("queued");

    const job = payload.workflow_job as Record<string, unknown>;
    expect(Object.keys(job)).toEqual([
      "id",
      "url",
      "html_url",
      "run_id",
      "run_url",
      "name",
      "labels",
      "run_attempt",
      "head_sha",
      "head_branch",
      "status",
      "steps",
      "created_at",
      "started_at",
      "completed_at",
    ]);
    expect(job.id).toBe(jobRows[0]!.id);
    expect(job.name).toBe("build");
    expect(job.labels).toEqual(["ubuntu-latest"]);
    expect(job.run_attempt).toBe(1);
    expect(job.head_sha).toBe(COMMIT);
    expect(job.head_branch).toBe("main");
    expect(job.status).toBe("queued");
    expect(job.steps).toEqual([]);
    expect(job.url).toBe(`https://forge.test/api/v1/repos/alice/demo/actions/jobs/${jobRows[0]!.id}`);
    expect(job.run_url).toBe(`https://forge.test/api/v1/repos/alice/demo/actions/runs/${run.id}`);
    expect(job.html_url).toBe(`https://forge.test/alice/demo/actions/runs/${run.id}/jobs/${jobRows[0]!.id}`);

    const sender = payload.sender as Record<string, unknown>;
    expect(sender.login).toBe("alice");
    expect(payload.repository).toMatchObject({ full_name: "alice/demo" });
  });

  it("a pending-needs job and an approval-blocked job stay silent; the 'waiting' blocked spelling delivers", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { jobRows } = await seedRun({ jobs: [{ jobId: "build" }, { jobId: "test", needs: ["build"] }] });
    // flip the needs-job to PENDING (insertActionRun leaves it WAITING)
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_PENDING }).where(eq(actionRunJobs.jobId, "test"));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[1]!.id);
    expect(await deliveryCount("workflow_job")).toBe(0);

    // approval-gated: the run carries needApproval and the job is BLOCKED →
    // "waiting" is NOT in the announce filter (notifier.go:1033-1035 drops
    // only requested/pending)
    const gated = await seedRun({ index: 2 });
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunJobs.id, gated.jobRows[0]!.id));
    await db().update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, gated.run.id));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, gated.jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(1);
    const payload = (await deliveriesOf("workflow_job"))[0]!;
    expect(payload.action).toBe("waiting");

    // plain blocked (no approval) → "pending" → silent
    const plain = await seedRun({ index: 3 });
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_BLOCKED }).where(eq(actionRunJobs.id, plain.jobRows[0]!.id));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, plain.jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(1);
  });

  it("a finished job carries the conclusion and the task's runner + steps", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { jobRows } = await seedRun();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_CANCELLED }).where(eq(actionRunJobs.id, jobRows[0]!.id));

    const taskRows = await db()
      .insert(actionTasks)
      .values({
        jobId: jobRows[0]!.id,
        runnerId: 9,
        status: ACTION_STATUS_CANCELLED,
        started: T0,
        stopped: T0,
        repoId: REPO_ID,
        ownerId: USER_ID,
        commitSha: COMMIT,
        tokenHash: "hash-webhook-events-1",
        created: T0,
        updated: T0,
      })
      .returning({ id: actionTasks.id });
    const taskId = taskRows[0]!.id;
    await db().update(actionRunJobs).set({ taskId }).where(eq(actionRunJobs.id, jobRows[0]!.id));
    await db().insert(actionTaskSteps).values([
      { name: "checkout", taskId, index: 0, repoId: REPO_ID, status: ACTION_STATUS_SUCCESS, stage: 4, number: 0, started: T0, stopped: T0, created: T0, updated: T0 },
      { name: "build", taskId, index: 1, repoId: REPO_ID, status: ACTION_STATUS_CANCELLED, stage: 4, number: 1, started: T0, stopped: T0, created: T0, updated: T0 },
    ]);

    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[0]!.id);
    const payload = (await deliveriesOf("workflow_job"))[0]!;
    expect(payload.action).toBe("completed");
    const job = payload.workflow_job as Record<string, unknown>;
    expect(job.status).toBe("completed");
    expect(job.conclusion).toBe("cancelled");
    expect(job.runner_id).toBe(9);
    // Number is the slice index (convert.go:568), the steps render per-step
    // status/conclusion.
    expect(job.steps).toEqual([
      { name: "checkout", number: 0, status: "completed", conclusion: "success", started_at: T0.toISOString(), completed_at: T0.toISOString() },
      { name: "build", number: 1, status: "completed", conclusion: "cancelled", started_at: T0.toISOString(), completed_at: T0.toISOString() },
    ]);
  });

  it("no subscription match (inactive hook, event not checked, push_only) stays silent", async () => {
    await seedRepoHooks();
    const { jobRows } = await seedRun();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true, }));
    await db().update(webhooks).set({ isActive: false }).where(eq(webhooks.repoId, REPO_ID));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(0);

    await db().update(webhooks).set({ isActive: true, events: JSON.stringify({ choose_events: true, events: { push: true } }) }).where(eq(webhooks.repoId, REPO_ID));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(0); // workflow_job not checked

    await db().update(webhooks).set({ events: JSON.stringify({ push_only: true }) }).where(eq(webhooks.repoId, REPO_ID));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(0);

    await db().update(webhooks).set({ events: JSON.stringify({ choose_events: true, events: { workflow_job: true } }) }).where(eq(webhooks.repoId, REPO_ID));
    await emitWorkflowJobStatus(bindingsWith(null), { origin: "https://forge.test" }, REPO_ID, jobRows[0]!.id);
    expect(await deliveryCount("workflow_job")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit C — the workflow_run payload + the definition resolution
// ---------------------------------------------------------------------------

describe("emitWorkflowRunStatus (WorkflowRunPayload + the resolution silence arms)", () => {
  it("a created (waiting) run announces requested with the exact field order and the workflow object", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { run } = await seedRun();
    await emitWorkflowRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test/" }, REPO_ID, run.id);

    const payload = (await deliveriesOf("workflow_run"))[0]!;
    expect(Object.keys(payload)).toEqual(["action", "workflow", "workflow_run", "repository", "sender"]);
    expect(payload.action).toBe("requested");

    const workflow = payload.workflow as Record<string, unknown>;
    expect(Object.keys(workflow)).toEqual([
      "id",
      "name",
      "path",
      "state",
      "created_at",
      "updated_at",
      "url",
      "html_url",
      "badge_url",
      "deleted_at",
    ]);
    expect(workflow.id).toBe(WORKFLOW_ID);
    expect(workflow.name).toBe("Demo CI"); // the yaml name rule
    expect(workflow.path).toBe(".gitea/workflows/ci.yml");
    expect(workflow.state).toBe("active");
    expect(workflow.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(workflow.updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(workflow.url).toBe("https://forge.test/api/v1/repos/alice/demo/actions/workflows/ci.yml");
    expect(workflow.html_url).toBe("https://forge.test/alice/demo/src/branch/main/.gitea/workflows/ci.yml");
    expect(workflow.badge_url).toBe("https://forge.test/alice/demo/actions/workflows/ci.yml/badge.svg?branch=main");
    expect(workflow.deleted_at).toBe("0001-01-01T00:00:00Z");

    const runObject = payload.workflow_run as Record<string, unknown>;
    expect(Object.keys(runObject)).toEqual([
      "id",
      "url",
      "previous_attempt_url",
      "html_url",
      "jobs_url",
      "logs_url",
      "artifacts_url",
      "cancel_url",
      "rerun_url",
      "display_title",
      "path",
      "event",
      "run_attempt",
      "run_number",
      "head_sha",
      "head_branch",
      "status",
      "actor",
      "trigger_actor",
      "repository",
      "pull_requests",
      "created_at",
      "updated_at",
      "started_at",
      "completed_at",
    ]);
    expect(runObject.id).toBe(run.id);
    expect(runObject.previous_attempt_url).toBeNull(); // the nil-pointer null
    expect(runObject.path).toBe(`${WORKFLOW_ID}@refs/heads/main`);
    expect(runObject.event).toBe("push");
    expect(runObject.run_attempt).toBe(1);
    expect(runObject.status).toBe("queued"); // ToRunActionsStatus, not the event action
    expect(runObject.conclusion).toBeUndefined(); // omitempty until done
    expect(runObject.actor).toMatchObject({ login: "alice" });
    expect(runObject.trigger_actor).toMatchObject({ login: "alice" });
    expect(runObject.pull_requests).toEqual([]);
    expect(runObject.started_at).toBe("0001-01-01T00:00:00Z");
  });

  it("the disabled workflow renders disabled_manually; a missing yaml name keeps the entry name", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    await saveRepoActionsConfig(env.DB, REPO_ID, { ...parseRepoActionsConfig(null), disabledWorkflows: [WORKFLOW_ID] });
    const seeded = await seedRun();
    await emitWorkflowRunStatus(bindingsWith(fakeReads({ content: "jobs:\n  build:\n    steps: []\n" })), { origin: "https://forge.test" }, REPO_ID, seeded.run.id);
    const payload = (await deliveriesOf("workflow_run"))[0]!;
    const workflow = payload.workflow as Record<string, unknown>;
    expect(workflow.state).toBe("disabled_manually");
    expect(workflow.name).toBe(WORKFLOW_ID);
  });

  it("a finished run carries the conclusion; a running run is in_progress", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const done = await seedRun({ index: 1 });
    await db().update(actionRunAttempts).set({ status: ACTION_STATUS_SUCCESS }).where(eq(actionRunAttempts.id, done.attempt.id));
    await db().update(actionRuns).set({ status: ACTION_STATUS_SUCCESS }).where(eq(actionRuns.id, done.run.id));
    await emitWorkflowRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test" }, REPO_ID, done.run.id);
    let payload = (await deliveriesOf("workflow_run"))[0]!;
    expect(payload.action).toBe("completed");
    expect((payload.workflow_run as Record<string, unknown>).conclusion).toBe("success");

    const running = await seedRun({ index: 2 });
    await db().update(actionRunAttempts).set({ status: ACTION_STATUS_RUNNING, started: T0 }).where(eq(actionRunAttempts.id, running.attempt.id));
    await db().update(actionRuns).set({ status: ACTION_STATUS_RUNNING, started: T0 }).where(eq(actionRuns.id, running.run.id));
    await emitWorkflowRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test" }, REPO_ID, running.run.id);
    payload = (await deliveriesOf("workflow_run"))[1]!;
    expect(payload.action).toBe("in_progress");
  });

  it("silence arms: no REPO binding, gone workflow file, no hooks, gone run", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { run } = await seedRun();

    // reads unavailable → the definition cannot resolve → silent (the
    // module-header posture; upstream's gone-definition skip)
    await emitWorkflowRunStatus({ DB: env.DB }, { origin: "https://forge.test" }, REPO_ID, run.id);
    expect(await deliveryCount("workflow_run")).toBe(0);

    // the workflow file gone (the tree miss → the first-dir-wins probe fails)
    await emitWorkflowRunStatus(bindingsWith(fakeReads({ noTree: true })), { origin: "https://forge.test" }, REPO_ID, run.id);
    expect(await deliveryCount("workflow_run")).toBe(0);

    // a different entry name in the tree → the entry match misses
    await emitWorkflowRunStatus(bindingsWith(fakeReads({ entryName: "other.yml" })), { origin: "https://forge.test" }, REPO_ID, run.id);
    expect(await deliveryCount("workflow_run")).toBe(0);

    // the run row gone
    await emitWorkflowRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test" }, REPO_ID, 99999);
    expect(await deliveryCount("workflow_run")).toBe(0);
  });

  it("the branch filter has no effect (getPayloadRef's empty-ref arm) and org owners add the organization block", async () => {
    await seedRepoHooks();
    // a narrow branch filter that does NOT match the run ref — still delivers
    const hookId = await seedHook(REPO_ORG, JSON.stringify({ send_everything: true, branch_filter: "nomatch-*" }));
    const { run } = await seedRun({ repoId: REPO_ORG, ownerId: ORG_ID });
    await emitWorkflowRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test" }, REPO_ORG, run.id);

    const rows = await db().select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payloadContent) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["action", "workflow", "workflow_run", "organization", "repository", "sender"]);
    const org = payload.organization as Record<string, unknown>;
    expect(org.name).toBe("acme");
    expect(org.full_name).toBe("");
    expect(payload.sender).toMatchObject({ login: "alice" });
  });
});

// ---------------------------------------------------------------------------
// Unit D — the resolution unit (resolveWorkflowForRun direct)
// ---------------------------------------------------------------------------

describe("resolveWorkflowForRun", () => {
  it("resolves at the run ref and renders the commit-author-time fields", async () => {
    await seedRepoHooks();
    const { run } = await seedRun();
    const pair = await findRepositoryById(env.DB, REPO_ID);
    if (pair === null) throw new Error("repo fixture missing");
    const workflow = await resolveWorkflowForRun({
      d1: env.DB,
      reads: fakeReads({ authorTime: 1767229200 }),
      pair,
      run,
      origin: "https://forge.test",
    });
    expect(workflow).not.toBeNull();
    expect(workflow!.created_at).toBe("2026-01-01T01:00:00.000Z");
    expect(workflow!.html_url).toBe("https://forge.test/alice/demo/src/branch/main/.gitea/workflows/ci.yml");
  });

  it("a scoped run resolves from the source repo at the recorded commit (GetScopedActionWorkflow)", async () => {
    await seedRepoHooks();
    const { run } = await seedRun();
    const scoped = { ...run, isScopedRun: true, workflowRepoId: REPO_ORG, workflowCommitSha: COMMIT, ref: "refs/heads/main" };
    const pair = await findRepositoryById(env.DB, REPO_ID);
    if (pair === null) throw new Error("repo fixture missing");
    const workflow = await resolveWorkflowForRun({
      d1: env.DB,
      reads: fakeReads(),
      pair,
      run: scoped,
      origin: "https://forge.test",
    });
    // The fake serves the same tree for every dir, so the scoped resolution
    // walks the SCOPED dir set at the recorded commit and finds the entry;
    // the web url falls back to the commit form (a scoped run's ref carries
    // no web-link segment in the resolution).
    expect(workflow).not.toBeNull();
    expect(workflow!.path).toBe(".gitea/scoped_workflows/ci.yml");
    expect(workflow!.html_url).toBe(`https://forge.test/acme/demo/src/commit/${COMMIT}/.gitea/scoped_workflows/ci.yml`);
  });
});

// ---------------------------------------------------------------------------
// Unit E — the batch emitter (NotifyWorkflowJobsAndRunsStatusUpdate's shape)
// ---------------------------------------------------------------------------

describe("emitWorkflowJobsAndRunStatus (run-then-jobs order)", () => {
  it("emits the run first, then each job; the schedule triggerEvent rides the run's event field", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { run, jobRows } = await seedRun({ jobs: [{ jobId: "build" }, { jobId: "lint" }], triggerEvent: "schedule", event: "push" });
    await emitWorkflowJobsAndRunStatus(
      bindingsWith(fakeReads()),
      { origin: "https://forge.test" },
      REPO_ID,
      run.id,
      jobRows.map((j) => j.id),
    );

    // Insertion order: run rows first, then the jobs (notify.go:22-41's
    // runs-loop before the jobs-loop).
    const rows = await db().select().from(webhookDeliveries).all();
    const ordered = rows.sort((a, b) => a.id - b.id).map((r) => r.eventType);
    expect(ordered).toEqual(["workflow_run", "workflow_job", "workflow_job"]);
    const runPayload = JSON.parse(rows[0]!.payloadContent) as Record<string, unknown>;
    expect((runPayload.workflow_run as Record<string, unknown>).event).toBe("schedule");
    expect(runPayload.action).toBe("requested");
  });

  it("a job whose sender row is gone stays silent without failing the batch", async () => {
    await seedRepoHooks();
    await seedHook(REPO_ID, JSON.stringify({ send_everything: true }));
    const { run, jobRows } = await seedRun({ triggerUserId: 424242 });
    await emitWorkflowJobsAndRunStatus(bindingsWith(fakeReads()), { origin: "https://forge.test" }, REPO_ID, run.id, jobRows.map((j) => j.id));
    // the run leg resolves the same missing sender → both silent, no throw
    expect(await deliveryCount("workflow_run")).toBe(0);
    expect(await deliveryCount("workflow_job")).toBe(0);
  });
});
