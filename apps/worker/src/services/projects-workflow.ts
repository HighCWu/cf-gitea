/**
 * The project workflow execution reducer — the deferred upstream surface
 * (SPEC: specs/projects-workflow-notifier.md), ported from
 * services/projects/workflow_notifier.go at the pinned commit.
 *
 * Upstream shape: a `workflowNotifier` (NullNotifier) registered against the
 * notify hub reacts to 8 WorkflowEvent values by running each touched
 * project's enabled workflows for that event through `matchWorkflowFilters`
 * and executing their column-move / add-remove-label / close-reopen actions
 * (workflow_notifier.go:20-197; the event set,
 * models/project/workflows.go:21-29). There is no ambient context on the
 * Workers runtime, so the notifier's ports are plain async functions the
 * landed mutation seams call after their writes commit:
 *
 *   - `notifyIssueChangeProjects`   — the IssueChangeProjects port; the
 *     issues service's project-coupling diff writer (`assignOrRemoveIssueProjects`,
 *     the create-with-projects + PATCH projects arms — upstream services/issue/
 *     project.go:13-18 and services/issue/issue.go:88) and the column add /
 *     remove arms of api/services/projects.ts (services/projects/issue.go:46/:97);
 *   - `notifyIssueChangeStatus`     — the IssueChangeStatus port; the issues
 *     service's close/reopen transition (upstream services/issue/status.go:43/:56
 *     — the merge close is model-level and stays silent, merge.go:838);
 *   - `notifyIssueChangeProjectColumn` — the IssueChangeProjectColumn port;
 *     the column add/move arms of api/services/projects.ts
 *     (services/projects/issue.go:120, real column changes only);
 *   - `notifyMergePullRequest`      — the MergePullRequest port; the merge
 *     family's winning arm (upstream merge.go:406; AutoMerge delegates,
 *     workflow_notifier.go:52-54);
 *   - `notifyPullRequestReview`     — the PullRequestReview port; official
 *     approve/reject reviews only (upstream workflow_notifier.go:56-59).
 *
 * THE RE-ENTRANCY GUARD. Upstream threads Go's context: workflow actions run
 * under `issues_model.WithProjectWorkflow(ctx, event)` and every notifier
 * entry short-circuits on `IsProjectWorkflowContext` (comment.go:259-270,
 * workflow_notifier.go:73/:85). The landed equivalent is the explicit
 * `ProjectWorkflowMark` threaded through the action writes: a seam that
 * receives a mark skips its own emission, so a workflow's close can never
 * re-trigger `item_closed`, a workflow's move can never re-trigger
 * `item_column_changed`. (Upstream double-checks the context in both
 * `runIssueProjectsWorkflows` and `runWorkflows`; ours checks at the seam —
 * the only writes an action performs are the marked ones below.)
 *
 * Actions reuse the SAME service writes as the human arms (moveIssueToColumn,
 * IssuesService.replaceLabels / closeIssue / reopenIssue) so the audit
 * comment trail and the counters are inherited; the mail env rides the mark
 * where the trigger has one (the close/reopen mail arm is the only mail a
 * workflow action can fire).
 */

import { and, asc, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  issueLabels,
  issues,
  labels,
  projectIssues,
  projectWorkflows,
  projects,
  ReviewType,
} from "../db/schema";
import type { IssueRow } from "../issues/service";
import { IssuesService } from "../issues/service";
import type { MailNotifyEnv } from "./mail/notify";
import {
  findColumnByIdAndProject,
  moveIssueToColumn,
  parseWorkflowActions,
  parseWorkflowFilters,
  unsupportedWorkflowRule,
  type ProjectColumnRow,
  type ProjectRow,
  type ProjectWorkflowRow,
} from "../api/services/projects";
import { findRepositoryById, type RepositoryRow } from "../api/services/repository";

// ---------------------------------------------------------------------------
// The re-entrancy mark (issues_model.WithProjectWorkflow)
// ---------------------------------------------------------------------------

/**
 * The explicit re-entrancy context threaded through workflow-driven writes —
 * upstream `WithProjectWorkflow(ctx, event)` (models/issues/comment.go:261-266)
 * reduced to a value passed where Go passed the request context. A mutation
 * seam that receives a mark IS a workflow's own mutation: it skips its
 * workflow emission and carries the mark's mail env into its writes.
 */
export interface ProjectWorkflowMark {
  /** The event of the workflow whose action is executing. */
  viaWorkflow: string;
  /** The trigger's mail env when the trigger site has one (the close/reopen
   *  action's mail arm rides IssuesService's env). */
  mailEnv?: MailNotifyEnv;
}

/** `workflowTrigger` (workflow_notifier.go:67-70) — the column-change carrier. */
interface WorkflowTrigger {
  sourceColumnId: number;
  targetColumnId: number;
}

/**
 * The mutation seams' options (api/services/projects.ts columns arms): the
 * executing workflow's mark suppresses the seam's own emission (the
 * re-entrancy guard), while a human arm's mail env — where the caller has
 * one — rides into the emission's workflow actions.
 */
export interface WorkflowSeamOptions {
  /** The executing workflow's event; presence = skip the emission. */
  viaWorkflow?: string;
  /** The caller's mail env for the workflows the emission runs. */
  mailEnv?: MailNotifyEnv;
}

/** `WorkflowEvent` string values (workflows.go:21-29). */
export const WORKFLOW_EVENT = {
  item_added_to_project: "item_added_to_project",
  item_removed_from_project: "item_removed_from_project",
  item_reopened: "item_reopened",
  item_closed: "item_closed",
  item_column_changed: "item_column_changed",
  code_changes_requested: "code_changes_requested",
  code_review_approved: "code_review_approved",
  pull_request_merged: "pull_request_merged",
} as const;

// ---------------------------------------------------------------------------
// The notifier ports — the trigger sites call these after their writes commit
// ---------------------------------------------------------------------------

export interface IssueChangeProjectsInput {
  issue: IssueRow;
  doerId: number;
  /** Memberships created by the triggering write (request order). */
  addedProjectIds: number[];
  /** Memberships removed by the triggering write (stored order). */
  removedProjectIds: number[];
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/**
 * The IssueChangeProjects port (workflow_notifier.go:32-35) — removed first,
 * then added, exactly upstream's two `runWorkflows` calls.
 */
export async function notifyIssueChangeProjects(d1: D1Database, input: IssueChangeProjectsInput): Promise<void> {
  await runWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    projectIds: input.removedProjectIds,
    event: WORKFLOW_EVENT.item_removed_from_project,
    trigger: { sourceColumnId: 0, targetColumnId: 0 },
    now: input.now,
    mailEnv: input.mailEnv,
  });
  await runWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    projectIds: input.addedProjectIds,
    event: WORKFLOW_EVENT.item_added_to_project,
    trigger: { sourceColumnId: 0, targetColumnId: 0 },
    now: input.now,
    mailEnv: input.mailEnv,
  });
}

export interface IssueChangeStatusInput {
  issue: IssueRow;
  doerId: number;
  isClosed: boolean;
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/**
 * The IssueChangeStatus port (workflow_notifier.go:28-30): the event flips on
 * the transition's target state (`util.Iif(isClosed, ItemClosed, ItemReopened)`).
 * The MERGE close never reaches here — the merge family emits
 * `pull_request_merged` instead, mirroring upstream where the merge close is
 * the model-level SetIssueAsClosed (no IssueChangeStatus notify, merge.go:838)
 * and the merge's own MergePullRequest notification carries the workflow arm.
 */
export async function notifyIssueChangeStatus(d1: D1Database, input: IssueChangeStatusInput): Promise<void> {
  await runIssueProjectsWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    event: input.isClosed ? WORKFLOW_EVENT.item_closed : WORKFLOW_EVENT.item_reopened,
    now: input.now,
    mailEnv: input.mailEnv,
  });
}

export interface IssueChangeProjectColumnInput {
  issue: IssueRow;
  doerId: number;
  /** The membership's column before the move (legacy 0 resolved by the caller —
   *  upstream resolves it the same way before collecting the move). */
  oldColumnId: number;
  newColumn: ProjectColumnRow;
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/** The IssueChangeProjectColumn port (workflow_notifier.go:37-42). */
export async function notifyIssueChangeProjectColumn(d1: D1Database, input: IssueChangeProjectColumnInput): Promise<void> {
  await runWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    projectIds: [input.newColumn.projectId],
    event: WORKFLOW_EVENT.item_column_changed,
    trigger: { sourceColumnId: input.oldColumnId, targetColumnId: input.newColumn.id },
    now: input.now,
    mailEnv: input.mailEnv,
  });
}

export interface MergePullRequestInput {
  issue: IssueRow;
  doerId: number;
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/**
 * The MergePullRequest port (workflow_notifier.go:44-50): LoadIssue, then the
 * issue's projects against `pull_request_merged`. Call it from the WINNING
 * merge arm only (upstream markAsMergedPostProcess fires past the CAS count
 * guard, merge.go:406 inside :385-412) — a losing racer must not run
 * workflows. The scheduled automerge inherits this through the same entry
 * (upstream AutoMergePullRequest delegates, workflow_notifier.go:52-54).
 */
export async function notifyMergePullRequest(d1: D1Database, input: MergePullRequestInput): Promise<void> {
  await runIssueProjectsWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    event: WORKFLOW_EVENT.pull_request_merged,
    now: input.now,
    mailEnv: input.mailEnv,
  });
}

export interface PullRequestReviewInput {
  issue: IssueRow;
  doerId: number;
  /** The review's official flag (upstream `review.Official`). */
  official: boolean;
  /** The review type (upstream `review.Type`). */
  reviewType: number;
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/**
 * The PullRequestReview port (workflow_notifier.go:56-65): OFFICIAL
 * approve/reject reviews only — comment/request/pending reviews never fire —
 * mapped `Approve → code_review_approved`, `Reject → code_changes_requested`.
 */
export async function notifyPullRequestReview(d1: D1Database, input: PullRequestReviewInput): Promise<void> {
  if (!input.official || (input.reviewType !== ReviewType.Approve && input.reviewType !== ReviewType.Reject)) {
    return;
  }
  await runIssueProjectsWorkflows(d1, {
    issue: input.issue,
    doerId: input.doerId,
    event:
      input.reviewType === ReviewType.Approve
        ? WORKFLOW_EVENT.code_review_approved
        : WORKFLOW_EVENT.code_changes_requested,
    now: input.now,
    mailEnv: input.mailEnv,
  });
}

// ---------------------------------------------------------------------------
// The reducer (runIssueProjectsWorkflows / runWorkflows, :72-120)
// ---------------------------------------------------------------------------

interface RunWorkflowsInput {
  issue: IssueRow;
  doerId: number;
  projectIds: number[];
  event: string;
  trigger: WorkflowTrigger;
  now: Date;
  mailEnv?: MailNotifyEnv;
}

/** `runIssueProjectsWorkflows` (:72-82): the issue's CURRENT project ids. */
async function runIssueProjectsWorkflows(
  d1: D1Database,
  input: Omit<RunWorkflowsInput, "projectIds" | "trigger">,
): Promise<void> {
  const membershipRows = await drizzle(d1)
    .select({ projectId: projectIssues.projectId })
    .from(projectIssues)
    .where(eq(projectIssues.issueId, input.issue.id));
  await runWorkflows(d1, {
    ...input,
    projectIds: membershipRows.map((row) => row.projectId),
    trigger: { sourceColumnId: 0, targetColumnId: 0 },
  });
}

/**
 * `runWorkflows` (:84-120). The re-entrancy check upstream runs here
 * (`IsProjectWorkflowContext`, :85) lives at the mutation seams in the landed
 * shape — the only writes an action performs carry the mark, and a marked
 * seam never calls into this module. Every failure logs and returns; nothing
 * in this module throws past the triggering write.
 */
async function runWorkflows(d1: D1Database, input: RunWorkflowsInput): Promise<void> {
  if (input.projectIds.length === 0) {
    return;
  }
  // `issue.LoadRepo` + the archived skip (:88-94): the repo row drives both
  // FindEnabledWorkflows' holds-repo predicate and the IsArchived arm.
  const pair = await findRepositoryById(d1, input.issue.repoId);
  if (pair === null) {
    console.error(`Project workflows: repo row missing [id: ${input.issue.repoId}]`);
    return;
  }
  if (pair.repo.isArchived) {
    return;
  }
  const workflows = await findEnabledWorkflows(d1, pair.repo, input.projectIds, input.event);
  if (workflows.length === 0) {
    return;
  }
  // The once-per-event re-fetch (:100-110): the caller and any notifier after
  // this one keep their issue; filters see the item AS THE EVENT LEFT IT, not
  // as earlier workflows change it — every matched workflow evaluates against
  // this one snapshot.
  const snapshotRows = await drizzle(d1).select().from(issues).where(eq(issues.id, input.issue.id)).limit(1);
  const snapshot = snapshotRows[0];
  if (snapshot === undefined) {
    console.error(`Project workflows: issue row missing [id: ${input.issue.id}]`);
    return;
  }
  const labelRows = await drizzle(d1)
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, snapshot.id));
  const labelIds = labelRows.map((row) => row.labelId);
  const matched = workflows.filter(({ workflow }) => matchWorkflowFilters(workflow, snapshot, labelIds, input.trigger));
  // The org-label rule matches the route arms' ownerOrgIdOf (null on
  // user-owned repos, the owner id on org-owned ones).
  const ownerOrgId = pair.owner.type === "org" ? pair.owner.id : null;
  for (const entry of matched) {
    await executeWorkflowActions(d1, entry.workflow, entry.project, snapshot, ownerOrgId, input);
  }
}

/** `FindEnabledWorkflows` (workflows.go:220-231) joined with the project row
 *  (the move action needs it for the landed moveIssueToColumn signature).
 *  Enabled only, event-matched, OPEN projects that hold this repo's items
 *  (`repo_id = ? OR (owner_id = ? AND repo_id = '')` — the landed '' encodes
 *  upstream's repo_id = 0 owner-scope marker), ordered `project_id ASC,
 *  id ASC` to keep execution stable across engines (workflows.go:216). */
interface EnabledWorkflow {
  workflow: ProjectWorkflowRow;
  project: ProjectRow;
}

async function findEnabledWorkflows(
  d1: D1Database,
  repo: RepositoryRow,
  projectIds: number[],
  event: string,
): Promise<EnabledWorkflow[]> {
  return drizzle(d1)
    .select({ workflow: projectWorkflows, project: projects })
    .from(projectWorkflows)
    .innerJoin(projects, eq(projects.id, projectWorkflows.projectId))
    .where(
      and(
        inArray(projectWorkflows.projectId, projectIds),
        eq(projectWorkflows.event, event),
        eq(projectWorkflows.enabled, true),
        eq(projects.isClosed, false),
        or(eq(projects.repoId, repo.id), and(eq(projects.ownerId, repo.ownerId ?? 0), eq(projects.repoId, ""))),
      ),
    )
    .orderBy(asc(projects.id), asc(projectWorkflows.id));
}

/**
 * `matchWorkflowFilters` (:122-142): an unsupported rule (the capability
 * check — an old row written before a capability change, or hand-edited data)
 * never matches; `issue_type` compares against what the snapshot IS;
 * source/target column ids compare against the TRIGGER payload (a non-column
 * event carries 0/0, so a column-filtered workflow of another event simply
 * never matches — the create-time capability validation prevents writing
 * that row through the API); `label_ids` require ALL present.
 */
function matchWorkflowFilters(
  wf: ProjectWorkflowRow,
  issue: IssueRow,
  labelIds: number[],
  trigger: WorkflowTrigger,
): boolean {
  const filters = parseWorkflowFilters(wf.filters);
  const actions = parseWorkflowActions(wf.actions);
  if (unsupportedWorkflowRule(wf.event, filters, actions) !== "") {
    return false;
  }
  if (filters.issue_type !== "" && filters.issue_type !== (issue.isPull ? "pull_request" : "issue")) {
    return false;
  }
  if (filters.source_column_id !== 0 && filters.source_column_id !== trigger.sourceColumnId) {
    return false;
  }
  if (filters.target_column_id !== 0 && filters.target_column_id !== trigger.targetColumnId) {
    return false;
  }
  for (const labelId of filters.label_ids ?? []) {
    if (!labelIds.includes(labelId)) {
      return false;
    }
  }
  return true;
}

/**
 * `executeWorkflowActions` (:144-169): each action runs under the mark and
 * each failure logs-and-continues — a failing action never blocks its
 * siblings, and a failing workflow never blocks the next matched one.
 */
async function executeWorkflowActions(
  d1: D1Database,
  wf: ProjectWorkflowRow,
  project: ProjectRow,
  issue: IssueRow,
  ownerOrgId: number | null,
  input: RunWorkflowsInput,
): Promise<void> {
  const mark: ProjectWorkflowMark = { viaWorkflow: wf.event, mailEnv: input.mailEnv };
  const parsed = parseWorkflowActions(wf.actions);
  const now = input.now;

  if (parsed.column_id !== 0 && parsed.column_id !== undefined) {
    try {
      await moveIssueByWorkflow(d1, wf, project, issue, parsed.column_id, input.doerId, now, mark);
    } catch (error) {
      console.error(`Project workflow ${wf.id}: move issue ${issue.id}: ${errorMessage(error)}`);
    }
  }

  const addLabelIds = parsed.add_label_ids ?? [];
  const removeLabelIds = parsed.remove_label_ids ?? [];
  if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
    try {
      await changeLabelsByWorkflow(d1, wf, issue, addLabelIds, removeLabelIds, ownerOrgId, input.doerId, now, mark);
    } catch (error) {
      console.error(`Project workflow ${wf.id}: change labels of issue ${issue.id}: ${errorMessage(error)}`);
    }
  }

  // The state gate reads the SNAPSHOT (:161-165): close only an open item;
  // reopen only a closed NON-PR item (pull requests need the pull handlers'
  // reopen checks). The service re-reads under its own CAS, so a stale
  // snapshot can only skip, never double-write.
  const service = new IssuesService(d1, mark.mailEnv);
  if (parsed.issue_state === "close" && !issue.isClosed) {
    try {
      await service.closeIssue(issue.id, { actorId: input.doerId, now, viaWorkflow: wf.event });
    } catch (error) {
      console.error(`Project workflow ${wf.id}: change state of issue ${issue.id}: ${errorMessage(error)}`);
    }
  } else if (parsed.issue_state === "reopen" && issue.isClosed && !issue.isPull) {
    try {
      await service.reopenIssue(issue.id, { actorId: input.doerId, now, viaWorkflow: wf.event });
    } catch (error) {
      console.error(`Project workflow ${wf.id}: change state of issue ${issue.id}: ${errorMessage(error)}`);
    }
  }
}

/** `moveIssueByWorkflow` (:171-187): the target column must still exist in
 *  the workflow's project (a vanished column warns and no-ops), and an item
 *  already sitting in it is a no-op — the raw membership column id compares
 *  against the target exactly like upstream's ProjectColumnMap read (a legacy
 *  0 row reads as 0, not as the default column, so the move proceeds and the
 *  landed moveIssueToColumn resolves the legacy encoding for the comment). */
async function moveIssueByWorkflow(
  d1: D1Database,
  wf: ProjectWorkflowRow,
  project: ProjectRow,
  issue: IssueRow,
  targetColumnId: number,
  doerId: number,
  now: Date,
  mark: ProjectWorkflowMark,
): Promise<void> {
  const column = await findColumnByIdAndProject(d1, targetColumnId, wf.projectId);
  if (column === null) {
    console.warn(`Project workflow ${wf.id}: column ${targetColumnId} no longer exists`);
    return;
  }
  const membershipRows = await drizzle(d1)
    .select({ columnId: projectIssues.projectColumnId })
    .from(projectIssues)
    .where(and(eq(projectIssues.issueId, issue.id), eq(projectIssues.projectId, wf.projectId)))
    .limit(1);
  const currentColumnId = membershipRows[0]?.columnId;
  if (currentColumnId !== undefined && currentColumnId === targetColumnId) {
    return;
  }
  await moveIssueToColumn(d1, project, issue, column, null, doerId, now, mark);
}

/**
 * `changeLabelsByWorkflow` (:189-197) over the landed human PUT write: ids
 * resolve against the label store with the missing silently dropped
 * (`GetLabelsByIDs`, models/issues/label.go:317-330), then the target set
 * mirrors upstream's ADD-THEN-REMOVE sequence (AddRemoveLabels —
 * services/issue/label.go:96-105: `NewIssueLabels(ctx, issue, toAdd)`
 * first — a no-op for already-attached labels — then a DeleteIssueLabel
 * loop over toRemove), so a label in the add∩remove overlap ends REMOVED
 * no matter its starting state. As a target list: `[current + add] −
 * remove`, adds positioned after the current rows so the exclusive-scope
 * dedupe — ReplaceIssueLabels' RemoveDuplicateExclusiveLabels positional
 * rule — still lets a surviving add evict its scope's occupant (the human
 * PUT arm's behavior). A target equal to the current set writes nothing.
 */
async function changeLabelsByWorkflow(
  d1: D1Database,
  wf: ProjectWorkflowRow,
  issue: IssueRow,
  addLabelIds: number[],
  removeLabelIds: number[],
  ownerOrgId: number | null,
  doerId: number,
  now: Date,
  mark: ProjectWorkflowMark,
): Promise<void> {
  const wanted = [...new Set([...addLabelIds, ...removeLabelIds])];
  const resolved =
    wanted.length === 0 ? [] : await drizzle(d1).select({ id: labels.id }).from(labels).where(inArray(labels.id, wanted));
  const addSet = new Set(addLabelIds);
  const removeSet = new Set(removeLabelIds);
  const addIds: number[] = [];
  const removeIds: number[] = [];
  for (const row of resolved) {
    if (addSet.has(row.id)) {
      addIds.push(row.id);
    }
    if (removeSet.has(row.id)) {
      removeIds.push(row.id);
    }
  }
  if (addIds.length === 0 && removeIds.length === 0) {
    return;
  }
  const currentRows = await drizzle(d1)
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, issue.id));
  const current = currentRows.map((row) => row.labelId);
  // `[current + add] − remove`: the add pass appends (deduped —
  // NewIssueLabels skips already-attached labels), the remove pass then
  // drops — the overlap therefore ends REMOVED (removals win), upstream's
  // add-then-remove net (label.go:96-105).
  const merged: number[] = [];
  const seen = new Set<number>();
  for (const labelId of [...current, ...addIds]) {
    if (!seen.has(labelId)) {
      seen.add(labelId);
      merged.push(labelId);
    }
  }
  const target = merged.filter((labelId) => !removeSet.has(labelId));
  const unchanged = target.length === current.length && current.every((id, index) => target[index] === id);
  if (unchanged) {
    return;
  }
  await new IssuesService(d1, mark.mailEnv).replaceLabels(issue.id, target, {
    actorId: doerId,
    ownerOrgId,
    now,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
