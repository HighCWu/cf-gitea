/**
 * The Actions webhook emissions (GAPS #7) — the `workflow_run` /
 * `workflow_job` payload builders and the fan-out family, the
 * `services/repo-events.ts` pattern (delivery mechanics moved verbatim; the
 * §2.7 identity renders through the same api/services converters the REST
 * bodies use; api/services imports stay OUT of issues/webhooks.ts to keep
 * that module's import surface cycle-free).
 *
 * UPSTREAM DERIVATION (pin fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - workflow_run — the webhookNotifier's WorkflowRunStatusUpdate
 *     (services/webhook/notifier.go:1039-1081): fired through
 *     notify_service.WorkflowRunStatusUpdate on every run STATUS change,
 *     whose callers are the notify wrappers in services/actions/notify.go
 *     (:68 NotifyWorkflowRunStatusUpdate, :57 WithReload) reached from:
 *     run creation (services/actions/run.go:56 —
 *     NotifyWorkflowJobsAndRunsStatusUpdate after PrepareRunAndInsert's
 *     inserts), the first job claim (services/actions/task.go:120-126 — the
 *     run leg only when run.Started was zero), the completion cascade
 *     (services/actions/job_emitter.go:131 — when a run's last job settles),
 *     cancellation (services/actions/cancel.go:54), the invalid-workflow
 *     record (services/actions/invalid_workflow.go:75) and the runner's
 *     UpdateTask tail (routers/api/actions/runner/runner.go:274). The
 *     payload is WorkflowRunPayload (modules/structs/hook.go:681): action =
 *     convert.ToWorkflowRunAction(run.Status) (convert.go:435-448 —
 *     waiting/blocked→"requested", running/cancelling→"in_progress",
 *     done→"completed"), workflow = ResolveActionWorkflowForRun
 *     (convert.go:744) — a NOT-EXIST resolution SKIPS the whole webhook
 *     (notifier.go:1055-1063: the definition is gone, deliver nothing),
 *     workflow_run = ToActionWorkflowRun(run, nil, false)
 *     (convert.go:276-348 — the LATEST attempt's status/times and the full
 *     pull_requests render), organization only for org owners
 *     (notifier.go:1045-1047), repository at owner permission
 *     (notifier.go:1075), sender = the run's LATEST-ATTEMPT trigger user
 *     (services/actions/notify.go:71-86).
 *
 *   - workflow_job — the webhookNotifier's WorkflowJobStatusUpdate
 *     (services/webhook/notifier.go:1003-1037): fired per job status change
 *     (task.go:120 claim, runner.go:266 finish, job_emitter.go's cascade via
 *     notify.go:111/:126, cancel.go:52) with WorkflowJobPayload
 *     (hook.go:704): action = ToRunActionsStatus(run, job.Status).action
 *     (convert.go:451-454 — the needApproval "waiting" arm included), with
 *     the ANNOUNCE-ONCE filter upstream applies before building anything
 *     (notifier.go:1033-1035): "requested"/"pending" jobs are SILENT (a job
 *     is announced only once queued), so pending-needs and
 *     approval-blocked-with-needApproval jobs deliver nothing. The job
 *     object is ToActionWorkflowJob (convert.go:488-511 → :545-590 — the
 *     effective task's runner + steps). NO workflow object rides this
 *     payload — job emissions never resolve the definition.
 *
 *   - schedule — NOT A WEBHOOK: HookEventSchedule sits outside AllEvents()
 *     (modules/webhook/type.go:44) and NO PrepareWebhooks caller ever passes
 *     it; it is Actions-trigger vocabulary (the detection notify input,
 *     services/actions/notifier_helper.go:84 newNotifyInputForSchedules, and
 *     the run's TriggerEvent, schedule_tasks.go:140). Scheduled runs reach
 *     the webhook surface exactly like every other run: their creation rides
 *     PrepareRunAndInsert's notify, so a scheduled run's emissions are this
 *     family's workflow_run ("requested") + workflow_job ("queued") pair
 *     with the run's TriggerEvent spelling "schedule" in the payload's
 *     event field. Recorded as declared-but-not-upstream in
 *     docs/compat/webhook-event-coverage.md's schedule row; our webhook
 *     union deliberately omits the type, matching AllEvents().
 *
 * Delivery mechanics: the OFF-REQUEST inline variant (emitRepoEventInline /
 * emitWikiPageEvent posture — a service seam has no hono executionCtx to
 * offload onto): delivery rows awaited inline, the Queue producer batch
 * awaited when the binding exists, rows stay `pending` without it (the
 * consumer's idempotent CAS replays a later enqueue). Never throws: the
 * statuses already landed and a webhook failure must never fail them
 * (upstream logs PrepareWebhooks errors the same way). Branch filters have
 * no effect on either event upstream (services/webhook/webhook.go:49-69
 * getPayloadRef handles Create/Delete/Push payloads only), so refName is
 * always null here.
 *
 * The live workflow resolution needs the engine cell (env.REPO); sites that
 * hold it thread {@link ActionsWebhookBindings} through. Run-level emissions
 * WITHOUT bindings stay silent (the definition cannot resolve — upstream's
 * own failure mode for a gone definition is silence); job-level emissions
 * need no reads and fire regardless.
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { parse as yamlParse } from "yaml";

import {
  actionRunAttempts,
  actionRunJobs,
  actionRunners,
  actionRuns,
  actionTaskSteps,
  actionTasks,
  issues,
  pullRequests,
  repositories,
  users,
} from "../../db/schema";
import {
  GO_ZERO_TIME,
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
} from "../../api/services/repository";
import { pathEscapeSegments } from "../../api/services/releases";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { toApiOrganization } from "../../api/services/org-repos";
import { OrgService } from "../orgs/orgs";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import { loadRepoActionsConfig } from "./config";
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
  type RunJobRow,
  type RunRow,
} from "./model";

/** The engine cell source (env.REPO) — structural, the trigger env's shape. */
export interface ActionsWebhookBindings {
  DB: D1Database;
  /** The git-engine cell source. Absent → live workflow resolution is
   *  impossible and run-level emissions stay silent (the module header's
   *  posture); job-level emissions are unaffected. */
  REPO?: {
    getByName(id: string): unknown;
  };
}

/** The engine cell's read slice the resolution needs — structurally
 *  satisfied by the cell every TriggerCellReads consumer already holds
 *  (CommitJson's Person carries the unix author time the definition's
 *  created_at/updated_at render). */
export interface WorkflowDefinitionReads {
  listTree(
    ref: string,
    path: string,
  ): Promise<{ entries: Array<{ name: string; type: "tree" | "blob" | "commit" }> } | null>;
  readBlob(ref: string, path: string): Promise<{ data: Uint8Array } | null>;
  readCommit(id: string): Promise<{
    oid: string;
    author: { name: string; email: string; time: number; tz: string };
  } | null>;
}

/** The emission context the transition sites thread: bindings (DB, optional
 *  REPO) + the origin (the appUrl convention — "" when no origin is at
 *  hand, the commit-status seam's documented degraded posture). */
export interface ActionsWebhookContext {
  bindings: ActionsWebhookBindings;
  origin: string;
}

/** Structural probe of the cell (the engineName'd id → cell with the three
 *  reads). Null when the binding is absent — callers stay silent. */
export function workflowDefinitionReads(bindings: ActionsWebhookBindings | null, repoFullName: string): WorkflowDefinitionReads | null {
  if (bindings === undefined || bindings === null || bindings.REPO === undefined || bindings.REPO === null) {
    return null;
  }
  const candidate: unknown = bindings.REPO;
  const source = candidate as { getByName?: (id: string) => unknown };
  if (typeof source.getByName !== "function") return null;
  const cell = source.getByName(repoFullName.toLowerCase());
  if (cell === null || cell === undefined) return null;
  const reads = cell as {
    listTree?: unknown;
    readBlob?: unknown;
    readCommit?: unknown;
  };
  if (
    typeof reads.listTree !== "function" ||
    typeof reads.readBlob !== "function" ||
    typeof reads.readCommit !== "function"
  ) {
    return null;
  }
  // Direct method references — `.bind` forwards to the RPC receiver
  // (the trigger harness's cell stubs) and it does not implement it; the
  // stubs are self-contained functions.
  return {
    listTree: reads.listTree as WorkflowDefinitionReads["listTree"],
    readBlob: reads.readBlob as WorkflowDefinitionReads["readBlob"],
    readCommit: reads.readCommit as WorkflowDefinitionReads["readCommit"],
  };
}

// ---------------------------------------------------------------------------
// Status vocabulary (convert.ToActionsStatus / ToRunActionsStatus /
// ToWorkflowRunAction, services/convert/convert.go:435-486)
// ---------------------------------------------------------------------------

/** ToActionsStatus (convert.go:456-486): the wire status/conclusion pair. */
export function toActionsStatus(status: number): { action: string; conclusion: string } {
  switch (status) {
    case ACTION_STATUS_WAITING:
      return { action: "queued", conclusion: "" };
    case ACTION_STATUS_BLOCKED:
      return { action: "pending", conclusion: "" };
    case ACTION_STATUS_PENDING:
      return { action: "requested", conclusion: "" };
    case ACTION_STATUS_RUNNING:
    case ACTION_STATUS_CANCELLING:
      return { action: "in_progress", conclusion: "" };
    default: {
      // the done arm: IsDone falls through to conclusion mapping; an unknown
      // status is upstream's PanicInDevOrTesting — rendered as completed ""
      // here (the payload family never panics).
      switch (status) {
        case ACTION_STATUS_SUCCESS:
          return { action: "completed", conclusion: "success" };
        case ACTION_STATUS_CANCELLED:
          return { action: "completed", conclusion: "cancelled" };
        case ACTION_STATUS_FAILURE:
          return { action: "completed", conclusion: "failure" };
        case ACTION_STATUS_SKIPPED:
          return { action: "completed", conclusion: "skipped" };
        default:
          return { action: "completed", conclusion: "" };
      }
    }
  }
}

/** ToRunActionsStatus (convert.go:451-454): a job blocked under an
 *  approval-gated run renders "waiting" (announced — the announce filter
 *  only drops "requested"/"pending"). */
export function toRunActionsStatus(run: Pick<RunRow, "needApproval">, status: number): { action: string; conclusion: string } {
  if (status === ACTION_STATUS_BLOCKED && run.needApproval) {
    return { action: "waiting", conclusion: "" };
  }
  return toActionsStatus(status);
}

/** ToWorkflowRunAction (convert.go:435-448): the workflow_run event's
 *  action. waiting/blocked → "requested"; running/cancelling →
 *  "in_progress"; every done status → "completed". */
export function toWorkflowRunAction(status: number): string {
  switch (status) {
    case ACTION_STATUS_WAITING:
    case ACTION_STATUS_BLOCKED:
      return "requested";
    case ACTION_STATUS_RUNNING:
    case ACTION_STATUS_CANCELLING:
      return "in_progress";
    default:
      return "completed";
  }
}

/** The announce filter (notifier.go:1033-1035): a job is announced only
 *  once queued — "requested" (pending-needs) and "pending"
 *  (approval-blocked) jobs deliver nothing. The "waiting" spelling of an
 *  approval-gated blocked job is NOT in the filter and delivers. */
function jobAnnounces(run: Pick<RunRow, "needApproval">, jobStatus: number): boolean {
  const status = toRunActionsStatus(run, jobStatus).action;
  return status !== "requested" && status !== "pending";
}

// ---------------------------------------------------------------------------
// Payload wrappers — hook.go field order IS the byte order (§2.7)
// ---------------------------------------------------------------------------

/** WorkflowRunPayload (hook.go:681-694): action, workflow, workflow_run,
 *  pull_request (omitempty — never set by the notifier), organization
 *  (omitempty), repository, sender. */
export function workflowRunEventPayload(input: {
  action: string;
  workflow: unknown;
  workflowRun: unknown;
  organization: unknown;
  repository: unknown;
  sender: unknown;
}): Record<string, unknown> {
  return {
    action: input.action,
    workflow: input.workflow,
    workflow_run: input.workflowRun,
    ...(input.organization === undefined ? {} : { organization: input.organization }),
    repository: input.repository,
    sender: input.sender,
  };
}

/** WorkflowJobPayload (hook.go:704-717): action, workflow_job,
 *  pull_request (omitempty — never set), organization (omitempty),
 *  repository, sender. */
export function workflowJobEventPayload(input: {
  action: string;
  workflowJob: unknown;
  organization: unknown;
  repository: unknown;
  sender: unknown;
}): Record<string, unknown> {
  return {
    action: input.action,
    workflow_job: input.workflowJob,
    ...(input.organization === undefined ? {} : { organization: input.organization }),
    repository: input.repository,
    sender: input.sender,
  };
}

// ---------------------------------------------------------------------------
// The workflow definition object — ResolveActionWorkflowForRun +
// getActionWorkflowEntry (convert.go:593-651, :744-766)
// ---------------------------------------------------------------------------

/** Upstream defaults (modules/setting/actions.go:52-53). Local copies with
 *  the cite — trigger.ts holds the WORKFLOW_DIRS twin and scoped-workflows.ts
 *  the SCOPED twin; this module must not import either (it is imported BY
 *  them — the update.ts↔trigger.ts cycle is precedent enough for one hop,
 *  not two). */
const WORKFLOW_DIRS: readonly string[] = [".gitea/workflows", ".github/workflows"];
const SCOPED_WORKFLOW_DIRS: readonly string[] = [".gitea/scoped_workflows"];

/** git.RefName.RefWebLinkPath (modules/git/ref.go:238-245): the web-link
 *  segment of the run's ref — branch/<short>, tag/<short>, "" otherwise
 *  (pull refs included — their web url falls back to the commit form). */
function refWebLinkPath(ref: string): { kind: "branch" | "tag" | null; shortName: string } {
  if (ref.startsWith("refs/heads/")) return { kind: "branch", shortName: ref.slice("refs/heads/".length) };
  if (ref.startsWith("refs/tags/")) return { kind: "tag", shortName: ref.slice("refs/tags/".length) };
  return { kind: null, shortName: "" };
}

/** The name rule (convert.go:629-635): the yaml `name:` key when a non-empty
 *  string parses; the entry name stays on parse failure. The same rule
 *  workflowWire renders with. */
function workflowDisplayName(content: string | null, entryName: string): string {
  if (content === null) return entryName;
  try {
    const parsed: unknown = yamlParse(content);
    if (parsed !== null && typeof parsed === "object" && !(parsed instanceof Map)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.name === "string" && record.name !== "") return record.name;
    }
  } catch {
    // the parse-fail log arm (convert.go:633-635) — the file name stays
  }
  return entryName;
}

/**
 * ResolveActionWorkflowForRun (convert.go:744-766) + GetActionWorkflowByRef
 * (:681-697) + getActionWorkflowFromCommit (:699-712) over the engine cell:
 * the listing runs at the RUN's ref (upstream GetRefCommitID — ours passes
 * the ref straight to the reads, which resolve refs), the FIRST dir of
 * WORKFLOW_DIRS that exists wins (workflows.go:79-108's break), the entry
 * matches by the dir-relative name, and a miss answers null — the caller's
 * SILENCE (notifier.go:1055-1063). Scoped runs resolve from the SOURCE repo
 * at the recorded commit under SCOPED_WORKFLOW_DIRS (GetScopedActionWorkflow,
 * convert.go:714-727). created_at/updated_at are the LISTING commit's author
 * time (convert.go:616-622's documented arm).
 */
export async function resolveWorkflowForRun(input: {
  d1: D1Database;
  reads: WorkflowDefinitionReads;
  pair: RepositoryWithOwner;
  run: RunRow;
  origin: string;
}): Promise<Record<string, unknown> | null> {
  const { d1, reads, pair, run, origin } = input;

  // The resolution repo + listing ref (scoped: the source repo at the
  // recorded commit; repo-level: this repo at the run's ref).
  let resolutionPair = pair;
  let listingRef = run.ref;
  let dirs = WORKFLOW_DIRS;
  if (run.isScopedRun) {
    const source = run.workflowRepoId !== "" ? await findRepositoryById(d1, run.workflowRepoId) : null;
    if (source === null) return null;
    resolutionPair = source;
    listingRef = run.workflowCommitSha;
    dirs = SCOPED_WORKFLOW_DIRS;
  }

  const commit = await reads.readCommit(listingRef);
  if (commit === null) return null; // GetRefCommitID miss → not-found class
  const authorWhen = new Date(commit.author.time * 1000);

  // listWorkflowsInDirs: the first dir that EXISTS wins entirely.
  let base: string | null = null;
  for (const dir of dirs) {
    const tree = await reads.listTree(listingRef, dir);
    if (tree !== null) {
      base = dir;
      break;
    }
  }
  if (base === null) return null;

  // getActionWorkflowFromCommit: the entry by EXACT dir-relative name.
  const entryName = run.workflowId;
  const entryPath = `${base}/${entryName}`;
  const blob = await reads.readBlob(listingRef, entryPath);
  if (blob === null) return null; // workflow %q not found
  const content = new TextDecoder().decode(blob.data);

  const cfg = await loadRepoActionsConfig(d1, resolutionPair.repo.id);
  const ownerNamespace = encodeURIComponent(resolutionPair.repo.ownerNamespace);
  const slug = encodeURIComponent(resolutionPair.repo.slug);
  const htmlUrl = `${origin}/${ownerNamespace}/${slug}`;
  const apiUrl = `${origin}/api/v1/repos/${ownerNamespace}/${slug}`;

  // The web url: the ref's web-link segment when it has one (branch/tag),
  // else the commit form (convert.go:604-608).
  const link = refWebLinkPath(run.isScopedRun ? "" : run.ref);
  const webPath =
    link.kind !== null
      ? `src/${link.kind}/${pathEscapeSegments(link.shortName)}/${pathEscapeSegments(base)}/${pathEscapeSegments(entryName)}`
      : `src/commit/${commit.oid}/${pathEscapeSegments(base)}/${pathEscapeSegments(entryName)}`;

  const when = authorWhen.toISOString();
  // ActionWorkflow (modules/structs/repo_actions.go:59-80) field order.
  return {
    id: entryName,
    name: workflowDisplayName(content, entryName),
    path: `${base}/${entryName}`,
    state: cfg.disabledWorkflows.includes(entryName) ? "disabled_manually" : "active",
    created_at: when,
    updated_at: when,
    url: `${apiUrl}/actions/workflows/${pathEscapeSegments(entryName)}`,
    html_url: `${htmlUrl}/${webPath}`,
    badge_url: `${htmlUrl}/actions/workflows/${pathEscapeSegments(entryName)}/badge.svg?branch=${encodeURIComponent(resolutionPair.repo.defaultBranch)}`,
    deleted_at: GO_ZERO_TIME,
  };
}

// ---------------------------------------------------------------------------
// The workflow_run object — ToActionWorkflowRun (convert.go:276-348)
// ---------------------------------------------------------------------------

/** git.RefName.BranchName (ref.go:126-141) — the refs/heads/ prefix
 *  stripped, anything else "" (head_branch is omitempty). */
function branchNameOf(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

function isoOrNull(value: Date | null | undefined): string {
  return value === null || value === undefined ? GO_ZERO_TIME : value.toISOString();
}

async function userRowOrNull(d1: D1Database, userId: number): Promise<{ id: number } & Record<string, unknown> | null> {
  if (userId <= 0) return null;
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** The anonymous §2.7 payload render (the push family's viewer posture). */
function payloadViewer(origin: string): { origin: string; requester: null } {
  return { origin, requester: null };
}

/**
 * loadPullRequestsForRun (convert.go:351-396) over the landed tables — the
 * same resolution the REST run wire renders with: pull_request-family events
 * resolve the PR by the ref's index, push resolves open PRs on the pushed
 * branch (GetUnmergedPullRequestsByHeadInfo's four conditions), other events
 * render `[]` (always present — the field has no omitempty).
 */
async function pullRequestsForRun(
  d1: D1Database,
  run: RunRow,
  origin: string,
  repoApiUrlValue: string,
): Promise<unknown[]> {
  const db = drizzle(d1);
  const event = run.event;
  const isPrEvent = event === "pull_request" || event === "pull_request_comment";
  const isPrReviewEvent =
    event === "pull_request_review" ||
    event === "pull_request_approved" ||
    event === "pull_request_rejected" ||
    event === "pull_request_review_comment";
  const byIndex = /^refs\/pull\/(\d+)\/head$/.exec(run.ref);
  let rows: Array<typeof pullRequests.$inferSelect>;
  if ((isPrEvent || isPrReviewEvent) && byIndex !== null) {
    rows = await db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.baseRepoId, run.repoId), eq(pullRequests.index, Number(byIndex[1]))))
      .all();
  } else if (event === "push") {
    const branch = branchNameOf(run.ref);
    if (branch === "") return [];
    const joined = await db
      .select({ pr: pullRequests })
      .from(pullRequests)
      .innerJoin(issues, eq(issues.id, pullRequests.issueId))
      .where(
        and(
          eq(pullRequests.headRepoId, run.repoId),
          eq(pullRequests.headBranch, branch),
          eq(pullRequests.hasMerged, false),
          eq(pullRequests.flow, 1), // PullRequestFlowGithub
          eq(issues.isClosed, false),
        ),
      )
      .all();
    rows = joined.map((j) => j.pr);
  } else {
    return [];
  }

  const result: unknown[] = [];
  for (const pr of rows) {
    const baseRepoRows = await drizzle(d1).select().from(repositories).where(eq(repositories.id, pr.baseRepoId)).limit(1);
    const baseRepo = baseRepoRows[0];
    const headRepoRows = await drizzle(d1).select().from(repositories).where(eq(repositories.id, pr.headRepoId)).limit(1);
    // headRepo nil falls back to the base repo (convert.go:406-408).
    const headRepo = headRepoRows[0] ?? baseRepo;
    if (baseRepo === undefined || headRepo === undefined) continue;
    const repoUrl = (repo: typeof baseRepo) =>
      `${origin}/api/v1/repos/${encodeURIComponent(repo.ownerNamespace)}/${encodeURIComponent(repo.slug)}`;
    result.push({
      id: pr.id,
      number: pr.index,
      url: `${repoApiUrlValue}/pulls/${pr.index}`,
      head: {
        ref: pr.headBranch,
        sha: pr.headSha ?? run.commitSha,
        repo: {
          id: repoIdNumber(headRepo.id),
          url: repoUrl(headRepo),
          name: headRepo.slug,
        },
      },
      base: {
        ref: pr.baseBranch,
        sha: pr.mergeBase ?? "",
        repo: {
          id: repoIdNumber(baseRepo.id),
          url: repoUrl(baseRepo),
          name: baseRepo.slug,
        },
      },
    });
  }
  return result;
}

/** The repo-id string → number parse (the route wire's repoIdNumber). */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** The run wire over the latest attempt — the webhook's workflow_run object.
 *  Returns null when the run's user rows cannot resolve (upstream would
 *  render a nil-user panic class; we silence — never emits half payloads). */
export async function workflowRunObject(input: {
  d1: D1Database;
  origin: string;
  pair: RepositoryWithOwner;
  run: RunRow;
}): Promise<Record<string, unknown> | null> {
  const { d1, origin, pair, run } = input;
  const apiUrl = `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const runUrl = `${apiUrl}/actions/runs/${run.id}`;

  // ToActionWorkflowRun(run, nil, false): the LATEST attempt when one exists.
  let attempt: typeof actionRunAttempts.$inferSelect | null = null;
  if (run.latestAttemptId > 0) {
    const rows = await drizzle(d1)
      .select()
      .from(actionRunAttempts)
      .where(eq(actionRunAttempts.id, run.latestAttemptId))
      .limit(1);
    attempt = rows[0] ?? null;
  }

  let runAttempt = 0;
  let status = run.status;
  let startedAt = isoOrNull(run.started);
  let completedAt = isoOrNull(run.stopped);
  let triggerUserId = run.triggerUserId;
  let previousAttemptUrl: string | null = null;
  if (attempt !== null) {
    runAttempt = attempt.attempt;
    status = attempt.status;
    startedAt = isoOrNull(attempt.started);
    completedAt = isoOrNull(attempt.stopped);
    triggerUserId = attempt.triggerUserId;
    if (attempt.attempt > 1) {
      previousAttemptUrl = `${runUrl}/attempts/${attempt.attempt - 1}`;
    }
  }
  const { action, conclusion } = toRunActionsStatus(run, status);

  const pullRequestsValue = await pullRequestsForRun(d1, run, origin, apiUrl);

  const actorRow = await userRowOrNull(d1, run.triggerUserId);
  const triggerRow = triggerUserId === run.triggerUserId ? actorRow : await userRowOrNull(d1, triggerUserId);
  if (actorRow === null) return null; // the sender/actor render needs the row
  const viewer = payloadViewer(origin);
  const actor = apiUserFromRow(actorRow as Parameters<typeof apiUserFromRow>[0], viewer);
  const triggerActor =
    triggerRow === null ? actor : apiUserFromRow(triggerRow as Parameters<typeof apiUserFromRow>[0], viewer);

  const settings = await loadRepoSettings(d1, pair.repo.id);
  const repository = toApiRepository(viewer, pair, settings);

  const headBranch = branchNameOf(run.ref);
  // ActionWorkflowRun (repo_actions.go:107-148) field order.
  return {
    id: run.id,
    url: runUrl,
    previous_attempt_url: previousAttemptUrl,
    html_url: `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}/actions/runs/${run.id}`,
    jobs_url: `${runUrl}/jobs`,
    logs_url: `${runUrl}/logs`,
    artifacts_url: `${runUrl}/artifacts`,
    cancel_url: `${runUrl}/cancel`,
    rerun_url: `${runUrl}/rerun`,
    display_title: run.title,
    path: `${run.workflowId}@${run.ref}`,
    event: run.triggerEvent,
    run_attempt: runAttempt,
    run_number: run.index,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: action,
    actor,
    trigger_actor: triggerActor,
    repository,
    ...(conclusion !== "" ? { conclusion } : {}),
    pull_requests: pullRequestsValue,
    created_at: run.created.toISOString(),
    updated_at: run.updated.toISOString(),
    started_at: startedAt,
    completed_at: completedAt,
  };
}

// ---------------------------------------------------------------------------
// The workflow_job object — ToActionWorkflowJob (convert.go:488-511 → :545-590)
// ---------------------------------------------------------------------------

/** The job's effective task (job.EffectiveTaskID): the live claim, else the
 *  source task of a re-run attempt. */
function effectiveTaskId(job: RunJobRow): number {
  return job.taskId > 0 ? job.taskId : job.sourceTaskId;
}

/** The job wire — the webhook's workflow_job object. */
export async function workflowJobObject(input: {
  d1: D1Database;
  origin: string;
  pair: RepositoryWithOwner;
  run: RunRow;
  job: RunJobRow;
}): Promise<Record<string, unknown>> {
  const { d1, origin, pair, run, job } = input;
  const apiUrl = `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const { action, conclusion } = toRunActionsStatus(run, job.status);

  let runnerId = 0;
  let runnerName = "";
  const steps: unknown[] = [];
  const taskID = effectiveTaskId(job);
  if (taskID !== 0) {
    const taskRows = await drizzle(d1).select().from(actionTasks).where(eq(actionTasks.id, taskID)).limit(1);
    const task = taskRows[0];
    if (task !== undefined) {
      runnerId = task.runnerId;
      if (runnerId > 0) {
        const runnerRows = await drizzle(d1)
          .select({ name: actionRunners.name })
          .from(actionRunners)
          .where(eq(actionRunners.id, runnerId))
          .limit(1);
        runnerName = runnerRows[0]?.name ?? "";
      }
      const stepRows = await drizzle(d1)
        .select()
        .from(actionTaskSteps)
        .where(eq(actionTaskSteps.taskId, task.id))
        .orderBy(asc(actionTaskSteps.index))
        .all();
      // Number is the SLICE index (convert.go:568 — Number: int64(i)).
      for (let i = 0; i < stepRows.length; i += 1) {
        const step = stepRows[i]!;
        const stepStatus = toActionsStatus(step.status);
        steps.push({
          name: step.name,
          number: i,
          status: stepStatus.action,
          ...(stepStatus.conclusion !== "" ? { conclusion: stepStatus.conclusion } : {}),
          started_at: isoOrNull(step.started),
          completed_at: isoOrNull(step.stopped),
        });
      }
    }
  }

  const headBranch = branchNameOf(run.ref);
  // runs_on is a JSON string array column — narrow by inspection (the
  // dispatch.ts idiom), never an empty-shape assertion.
  let labels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(job.runsOn);
    if (Array.isArray(parsed)) labels = parsed.map(String);
  } catch {
    labels = [];
  }
  // ActionWorkflowJob (repo_actions.go:202-224) field order.
  return {
    id: job.id,
    url: `${apiUrl}/actions/jobs/${job.id}`,
    html_url: `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}/actions/runs/${run.id}/jobs/${job.id}`,
    run_id: job.runId,
    run_url: `${apiUrl}/actions/runs/${job.runId}`,
    name: job.name,
    labels,
    run_attempt: job.attempt,
    head_sha: run.commitSha,
    ...(headBranch !== "" ? { head_branch: headBranch } : {}),
    status: action,
    ...(conclusion !== "" ? { conclusion: conclusion } : {}),
    ...(runnerId > 0 ? { runner_id: runnerId } : {}),
    ...(runnerName !== "" ? { runner_name: runnerName } : {}),
    steps,
    created_at: job.created.toISOString(),
    started_at: isoOrNull(job.started),
    completed_at: isoOrNull(job.stopped),
  };
}

// ---------------------------------------------------------------------------
// The fan-out — the notify wrappers' payload halves
// ---------------------------------------------------------------------------

/** Structural `WEBHOOK_DELIVERY` queue probe — the repo-events.ts shape,
 *  minus the `.bind` (the trigger harness's env carries RPC-proxied
 *  bindings whose methods reject `Function.prototype.bind`; a closure
 *  wrapper is the same semantics without the proxy trip). */
function webhookDeliveryQueue(bindings: ActionsWebhookBindings): {
  sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown>;
} | null {
  const candidate: unknown = (bindings as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> };
  if (typeof queue.sendBatch !== "function") return null;
  // Direct invocation — `.call`/`.bind` forward to the RPC receiver and it
  // implements neither; the stub method is self-contained.
  return { sendBatch: (messages) => queue.sendBatch!(messages) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The shared org block: `organization` only for org owners
 *  (notifier.go:1045-1047 / :1037-1041 — ToOrganization of the owner row;
 *  the webhook render carries the org's own email, the ToOrganization
 *  posture, not the visibility-filtered one). */
async function organizationBlock(d1: D1Database, pair: RepositoryWithOwner, origin: string): Promise<unknown> {
  const org = await new OrgService(d1).getOrgById(Number(pair.repo.ownerId));
  if (org === null) return undefined;
  return toApiOrganization(org, { origin, includeEmail: true });
}

/** The appUrl convention's normalizer: the routes' appUrlOf carries a
 *  trailing slash (origin + "/"), the payload URL builders join bare —
 *  strip once at the fan-out boundary. */
function bareOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** The run-level emission — notify.go's NotifyWorkflowRunStatusUpdate
 *  payload half (WorkflowRunStatusUpdate, notifier.go:1039-1081). Silent
 *  when: the run/repo row is gone, the sender user row is gone, or the
 *  workflow definition cannot resolve (reads unavailable count as
 *  unresolvable — the module header's posture; upstream's gone-definition
 *  skip is the shape this mirrors). */
export async function emitWorkflowRunStatus(bindings: ActionsWebhookBindings, ctx: { origin: string }, repoId: string, runId: number): Promise<void> {
  const d1 = bindings.DB;
  const origin = bareOrigin(ctx.origin);
  try {
    const runRows = await drizzle(d1).select().from(actionRuns).where(eq(actionRuns.id, runId)).limit(1);
    const run = runRows[0];
    if (run === undefined || run.repoId !== repoId) return;
    const pair = await findRepositoryById(d1, repoId);
    if (pair === null) return;

    // sender = the LATEST ATTEMPT's trigger user when present
    // (services/actions/notify.go:71-86).
    let senderUserId = run.triggerUserId;
    if (run.latestAttemptId > 0) {
      const attemptRows = await drizzle(d1)
        .select({ triggerUserId: actionRunAttempts.triggerUserId })
        .from(actionRunAttempts)
        .where(eq(actionRunAttempts.id, run.latestAttemptId))
        .limit(1);
      const attemptTrigger = attemptRows[0]?.triggerUserId;
      if (attemptTrigger !== undefined && attemptTrigger > 0) senderUserId = attemptTrigger;
    }
    const senderRow = await userRowOrNull(d1, senderUserId);
    if (senderRow === null) return;

    const reads = workflowDefinitionReads(bindings, `${pair.repo.ownerNamespace}/${pair.repo.slug}`);
    let workflow: Record<string, unknown> | null = null;
    if (reads !== null) {
      workflow = await resolveWorkflowForRun({ d1, reads, pair, run, origin });
    }
    if (workflow === null) return; // the gone-definition skip (notifier.go:1055-1063)

    const workflowRun = await workflowRunObject({ d1, origin, pair, run });
    if (workflowRun === null) return;

    const organization = await organizationBlock(d1, pair, origin);
    const payload = workflowRunEventPayload({
      action: toWorkflowRunAction(run.status),
      workflow,
      workflowRun,
      organization,
      repository: toApiRepository(payloadViewer(origin), pair),
      sender: apiUserFromRow(senderRow as Parameters<typeof apiUserFromRow>[0], payloadViewer(origin)),
    });

    const queue = webhookDeliveryQueue(bindings);
    await emitWebhookDeliveries(
      d1,
      { repoId, ownerId: pair.repo.ownerId, eventType: "workflow_run", payload, refName: null },
      {
        enqueue:
          queue !== null
            ? (deliveryIds) => queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(() => undefined)
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[actions-webhook] workflow_run fan-out failed (run ${runId}): ${errorMessage(error)}`);
  }
}

/** The job-level emission — notify.go's per-job payload half
 *  (WorkflowJobStatusUpdate, notifier.go:1003-1037) with the announce-once
 *  filter. Silent when: the job/run/repo/sender rows are gone, or the
 *  filtered status. Does NOT need the engine reads (no workflow object). */
export async function emitWorkflowJobStatus(bindings: ActionsWebhookBindings, ctx: { origin: string }, repoId: string, jobId: number): Promise<void> {
  const d1 = bindings.DB;
  const origin = bareOrigin(ctx.origin);
  try {
    const jobRows = await drizzle(d1).select().from(actionRunJobs).where(eq(actionRunJobs.id, jobId)).limit(1);
    const job = jobRows[0];
    if (job === undefined || job.repoId !== repoId) return;
    const runRows = await drizzle(d1).select().from(actionRuns).where(eq(actionRuns.id, job.runId)).limit(1);
    const run = runRows[0];
    if (run === undefined) return;
    if (!jobAnnounces(run, job.status)) return;
    const pair = await findRepositoryById(d1, repoId);
    if (pair === null) return;

    // sender: the attempt's trigger user when the job rides one
    // (notify.go:113-130's attempt grouping), else the run's.
    let senderUserId = run.triggerUserId;
    if (job.runAttemptId > 0) {
      const attemptRows = await drizzle(d1)
        .select({ triggerUserId: actionRunAttempts.triggerUserId })
        .from(actionRunAttempts)
        .where(eq(actionRunAttempts.id, job.runAttemptId))
        .limit(1);
      const attemptTrigger = attemptRows[0]?.triggerUserId;
      if (attemptTrigger !== undefined && attemptTrigger > 0) senderUserId = attemptTrigger;
    }
    const senderRow = await userRowOrNull(d1, senderUserId);
    if (senderRow === null) return;

    const workflowJob = await workflowJobObject({ d1, origin, pair, run, job });
    const organization = await organizationBlock(d1, pair, origin);
    const payload = workflowJobEventPayload({
      action: toRunActionsStatus(run, job.status).action,
      workflowJob,
      organization,
      repository: toApiRepository(payloadViewer(origin), pair),
      sender: apiUserFromRow(senderRow as Parameters<typeof apiUserFromRow>[0], payloadViewer(origin)),
    });

    const queue = webhookDeliveryQueue(bindings);
    await emitWebhookDeliveries(
      d1,
      { repoId, ownerId: pair.repo.ownerId, eventType: "workflow_job", payload, refName: null },
      {
        enqueue:
          queue !== null
            ? (deliveryIds) => queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(() => undefined)
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[actions-webhook] workflow_job fan-out failed (job ${jobId}): ${errorMessage(error)}`);
  }
}

/**
 * The NotifyWorkflowJobsAndRunsStatusUpdate shape (services/actions/notify.go
 * :22-41): the affected RUNS first, then the jobs. The creation tails and
 * the emitter passes call this with one run and its fresh job rows —
 * upstream's creation notify is exactly this batch over PrepareRunAndInsert's
 * reloaded jobs (run.go:50-56).
 */
export async function emitWorkflowJobsAndRunStatus(
  bindings: ActionsWebhookBindings,
  ctx: { origin: string },
  repoId: string,
  runId: number,
  jobIds: number[],
): Promise<void> {
  await emitWorkflowRunStatus(bindings, ctx, repoId, runId);
  for (const jobId of jobIds) {
    await emitWorkflowJobStatus(bindings, ctx, repoId, jobId);
  }
}
