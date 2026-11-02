/**
 * The project workflow execution reducer's tests (services/
 * projects-workflow.ts — the upstream services/projects/workflow_notifier.go
 * port): the FindEnabledWorkflows predicate (enabled + event + open project
 * + holds-repo), matchWorkflowFilters (issue_type / source-target column /
 * label_ids ALL-present / the unsupported-rule no-match), the once-per-event
 * issue snapshot, the action set (move no-ops and the vanished column,
 * add-remove labels, close, reopen gated to non-PRs), the guards (archived
 * repo, no projects, the WithProjectWorkflow re-entrancy mark, the merge
 * close's silence), the review port's official approve/reject gate, and the
 * landed trigger seams (the project-coupling diff writer + the close/reopen
 * transition funnel).
 *
 * Driven directly over real D1 (the pull-automerge.test.ts harness shape):
 * seeds are plain inserts, the emissions run through the service functions,
 * and every observable is a committed row (label attach, system comment,
 * membership column, is_closed state, counters).
 */

import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  comments,
  issueLabels,
  issues,
  labels,
  projectColumns,
  projectIssues,
  projectWorkflows,
  projects,
  repositories,
  ReviewType,
  users,
} from "../db/schema";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { addIssueToColumn, moveIssueToColumn } from "../api/services/projects";
import { assignOrRemoveIssueProjects } from "../api/services/issues";
import { IssuesService, type IssueRow } from "../issues/service";
import { CommentType } from "../issues/comment-types";
import {
  notifyIssueChangeProjects,
  notifyIssueChangeStatus,
  notifyMergePullRequest,
  notifyPullRequestReview,
} from "./projects-workflow";

// --- harness -----------------------------------------------------------------

const NOW = new Date("2026-01-05T00:00:00Z");
const ALICE_ID = 4201;
const REPO_ID = "wfrepo";
const OTHER_REPO_ID = "wfother";

const db = () => drizzle(env.DB);

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  for (const table of [
    "comments",
    "project_workflows",
    "project_issues",
    "project_columns",
    "projects",
    "issue_labels",
    "issues",
    "labels",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await db()
    .insert(users)
    .values({ id: ALICE_ID, username: "wfa", usernameLower: "wfa", createdAt: NOW });
  await db().insert(repositories).values([
    {
      id: REPO_ID,
      storageKey: `r_${REPO_ID}`,
      ownerNamespace: "wfa",
      ownerId: ALICE_ID,
      slug: REPO_ID,
      visibility: "public",
      createdAt: NOW,
    },
    {
      id: OTHER_REPO_ID,
      storageKey: `r_${OTHER_REPO_ID}`,
      ownerNamespace: "wfa",
      ownerId: ALICE_ID,
      slug: OTHER_REPO_ID,
      visibility: "public",
      createdAt: NOW,
    },
  ]);
});

// --- seeds -------------------------------------------------------------------

async function seedProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
  const rows = await db()
    .insert(projects)
    .values({
      title: "Board",
      repoId: REPO_ID,
      ownerId: 0,
      creatorId: ALICE_ID,
      type: 2,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("project seed failed");
  return row;
}

async function seedColumn(projectId: number, overrides: Partial<typeof projectColumns.$inferInsert> = {}) {
  const rows = await db()
    .insert(projectColumns)
    .values({
      title: "Column",
      projectId,
      creatorId: ALICE_ID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("column seed failed");
  return row;
}

async function seedWorkflow(
  projectId: number,
  event: string,
  filters: Record<string, unknown>,
  actions: Record<string, unknown>,
  overrides: Partial<typeof projectWorkflows.$inferInsert> = {},
) {
  const rows = await db()
    .insert(projectWorkflows)
    .values({
      projectId,
      event,
      filters: JSON.stringify(filters),
      actions: JSON.stringify(actions),
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("workflow seed failed");
  return row;
}

async function seedLabel(repoId: string, name: string) {
  const rows = await db()
    .insert(labels)
    .values({ repoId, name, orgId: 0 })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row;
}

async function seedIssue(index: number, overrides: Partial<typeof issues.$inferInsert> = {}) {
  const rows = await db()
    .insert(issues)
    .values({
      repoId: REPO_ID,
      index,
      title: `Issue ${index}`,
      posterId: ALICE_ID,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue seed failed");
  return row;
}

async function seedMembership(issueId: number, projectId: number, columnId: number, sorting = 0) {
  await db().insert(projectIssues).values({ issueId, projectId, projectColumnId: columnId, sorting });
}

async function attach(issueId: number, labelId: number) {
  await db().insert(issueLabels).values({ issueId, labelId });
}

async function issueRow(issueId: number): Promise<IssueRow> {
  const rows = await db().select().from(issues).where(eq(issues.id, issueId)).all();
  const row = rows[0];
  if (row === undefined) throw new Error("issue reload failed");
  return row;
}

async function attachedIds(issueId: number): Promise<number[]> {
  const rows = await db().select({ id: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId)).all();
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

async function commentCount(issueId: number, type: number): Promise<number> {
  const rows = await db()
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.type, type)))
    .all();
  return rows.length;
}

async function membershipColumn(issueId: number, projectId: number): Promise<number | null> {
  const rows = await db()
    .select({ columnId: projectIssues.projectColumnId })
    .from(projectIssues)
    .where(and(eq(projectIssues.issueId, issueId), eq(projectIssues.projectId, projectId)))
    .all();
  return rows[0]?.columnId ?? null;
}

// ---------------------------------------------------------------------------
// The FindEnabledWorkflows predicate
// ---------------------------------------------------------------------------

describe("FindEnabledWorkflows (enabled + event + open project + holds-repo)", () => {
  it("runs the touched projects' enabled workflows for the event only", async () => {
    const p1 = await seedProject({ title: "repo board" });
    const p2 = await seedProject({ title: "owner board", repoId: "", ownerId: ALICE_ID }); // owner-scope holds the repo's items
    const p3 = await seedProject({ title: "foreign owner board", repoId: "", ownerId: 99999 }); // another owner's
    const p4 = await seedProject({ title: "other repo board", repoId: OTHER_REPO_ID }); // another repo's
    const p5 = await seedProject({ title: "closed board", isClosed: true });
    const l1 = await seedLabel(REPO_ID, "l1");
    const l2 = await seedLabel(REPO_ID, "l2");
    const l3 = await seedLabel(REPO_ID, "l3");
    const l4 = await seedLabel(REPO_ID, "l4");
    const l5 = await seedLabel(REPO_ID, "l5");
    await seedWorkflow(p1.id, "item_added_to_project", {}, { add_label_ids: [l1.id] });
    await seedWorkflow(p2.id, "item_added_to_project", {}, { add_label_ids: [l2.id] });
    await seedWorkflow(p3.id, "item_added_to_project", {}, { add_label_ids: [l3.id] });
    await seedWorkflow(p4.id, "item_added_to_project", {}, { add_label_ids: [l4.id] });
    await seedWorkflow(p5.id, "item_added_to_project", {}, { add_label_ids: [l5.id] });
    // A disabled row and an other-event row on the same project stay dormant.
    await seedWorkflow(p1.id, "item_added_to_project", {}, { add_label_ids: [l3.id] }, { enabled: false });
    await seedWorkflow(p1.id, "item_closed", {}, { add_label_ids: [l4.id] });
    const issue = await seedIssue(1);

    await notifyIssueChangeProjects(env.DB, {
      issue: await issueRow(issue.id),
      doerId: ALICE_ID,
      addedProjectIds: [p1.id, p2.id, p3.id, p4.id, p5.id],
      removedProjectIds: [],
      now: NOW,
    });

    // P1 (repo scope) and P2 (the owner-scope board, repo_id = '') fire; the
    // foreign-owner board, the other repo's board, the closed board, the
    // disabled row and the other-event row all stay dormant.
    expect(await attachedIds(issue.id)).toEqual([l1.id, l2.id].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// matchWorkflowFilters
// ---------------------------------------------------------------------------

describe("matchWorkflowFilters", () => {
  it("issue_type filters compare against what the item is", async () => {
    const p1 = await seedProject();
    const l1 = await seedLabel(REPO_ID, "pr-only");
    await seedWorkflow(p1.id, "item_closed", { issue_type: "pull_request" }, { add_label_ids: [l1.id] });
    const prIssue = await seedIssue(1, { isPull: true });
    const plainIssue = await seedIssue(2);
    await seedMembership(prIssue.id, p1.id, (await seedColumn(p1.id, { title: "A", isDefault: true })).id);
    await seedMembership(plainIssue.id, p1.id, (await seedColumn(p1.id, { title: "B" })).id);
    const service = new IssuesService(env.DB);

    await service.closeIssue(prIssue.id, { actorId: ALICE_ID, now: NOW });
    await service.closeIssue(plainIssue.id, { actorId: ALICE_ID, now: NOW });

    expect(await attachedIds(prIssue.id)).toEqual([l1.id]);
    expect(await attachedIds(plainIssue.id)).toEqual([]);
  });

  it("source/target column filters compare against the trigger payload", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    const colC = await seedColumn(p1.id, { title: "C" });
    const lAtoB = await seedLabel(REPO_ID, "a-to-b");
    const lToC = await seedLabel(REPO_ID, "to-c");
    await seedWorkflow(p1.id, "item_column_changed", { source_column_id: colA.id, target_column_id: colB.id }, { add_label_ids: [lAtoB.id] });
    await seedWorkflow(p1.id, "item_column_changed", { target_column_id: colC.id }, { add_label_ids: [lToC.id] });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colA.id);

    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colB, null, ALICE_ID, NOW);

    expect(await attachedIds(issue.id)).toEqual([lAtoB.id]);
    // The trigger into colC (same workflow set, different payload) hits the
    // target-only filter, not the A→B pair.
    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colC, null, ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([lAtoB.id, lToC.id].sort((a, b) => a - b));
  });

  it("label_ids filters require ALL present", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "one");
    const l2 = await seedLabel(REPO_ID, "two");
    const l3 = await seedLabel(REPO_ID, "hit");
    await seedWorkflow(p1.id, "item_added_to_project", { label_ids: [l1.id, l2.id] }, { add_label_ids: [l3.id] });
    const issue = await seedIssue(1);
    await attach(issue.id, l1.id);

    // Only l1 present — no match.
    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([l1.id]);

    // Both present — the filter matches and the action lands.
    await attach(issue.id, l2.id);
    await db().delete(projectIssues).where(and(eq(projectIssues.issueId, issue.id), eq(projectIssues.projectId, p1.id)));
    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([l1.id, l2.id, l3.id].sort((a, b) => a - b));
  });

  it("an unsupported rule never matches (the capability guard)", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "never");
    // item_closed's filter set carries issue_type + labels only — a
    // source_column rule is unsupported and silences the whole workflow.
    await seedWorkflow(p1.id, "item_closed", { source_column_id: colA.id }, { add_label_ids: [l1.id] });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colA.id);
    const service = new IssuesService(env.DB);

    await service.closeIssue(issue.id, { actorId: ALICE_ID, now: NOW });

    expect(await attachedIds(issue.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The once-per-event snapshot
// ---------------------------------------------------------------------------

describe("the once-per-event issue snapshot", () => {
  it("filters see the item as the event left it, not as earlier workflows changed it", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "witness");
    const l2 = await seedLabel(REPO_ID, "payload");
    // W1 (lower id) strips the witness; W2 filters on it. Both match the ONE
    // snapshot taken before any action ran.
    await seedWorkflow(p1.id, "item_added_to_project", {}, { remove_label_ids: [l1.id] });
    await seedWorkflow(p1.id, "item_added_to_project", { label_ids: [l1.id] }, { add_label_ids: [l2.id] });
    const issue = await seedIssue(1);
    await attach(issue.id, l1.id);

    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);

    expect(await attachedIds(issue.id)).toEqual([l2.id]);
  });
});

// ---------------------------------------------------------------------------
// The action set
// ---------------------------------------------------------------------------

describe("executeWorkflowActions", () => {
  it("move-to-column relocates the attach from the default landing column", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    await seedWorkflow(p1.id, "item_added_to_project", {}, { column_id: colB.id });
    const issue = await seedIssue(1);

    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);

    expect(await membershipColumn(issue.id, p1.id)).toBe(colB.id);
    // The workflow's own move writes the type-31 comment as the doer (audit
    // parity with the human arm's write).
    expect(await commentCount(issue.id, CommentType.ProjectColumn)).toBe(1);
  });

  it("move-to-column is a no-op when the item already sits in the target", async () => {
    const p1 = await seedProject();
    const colB = await seedColumn(p1.id, { title: "B" });
    const l1 = await seedLabel(REPO_ID, "sibling-proof");
    // The column action lives on item_added (item_column_changed cannot carry
    // it — the capability matrix). The item is pre-seated in colB.
    await seedWorkflow(p1.id, "item_added_to_project", {}, { column_id: colB.id, add_label_ids: [l1.id] });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colB.id);

    await notifyIssueChangeProjects(env.DB, {
      issue: await issueRow(issue.id),
      doerId: ALICE_ID,
      addedProjectIds: [p1.id],
      removedProjectIds: [],
      now: NOW,
    });

    expect(await membershipColumn(issue.id, p1.id)).toBe(colB.id);
    expect(await attachedIds(issue.id)).toEqual([l1.id]);
    expect(await commentCount(issue.id, CommentType.ProjectColumn)).toBe(0);
  });

  it("a vanished target column warns and the sibling actions continue", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "after-vanish");
    await seedWorkflow(p1.id, "item_added_to_project", {}, { column_id: 4_000_999, add_label_ids: [l1.id] });
    const issue = await seedIssue(1);

    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);

    expect(await membershipColumn(issue.id, p1.id)).toBe(colA.id);
    expect(await attachedIds(issue.id)).toEqual([l1.id]);
  });

  it("add/remove labels ride the human write (type-7 trail, counters)", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "keep");
    const l2 = await seedLabel(REPO_ID, "drop");
    const l3 = await seedLabel(REPO_ID, "add");
    await seedWorkflow(p1.id, "item_added_to_project", {}, { add_label_ids: [l3.id], remove_label_ids: [l2.id] });
    const issue = await seedIssue(1);
    await attach(issue.id, l1.id);
    await attach(issue.id, l2.id);

    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);

    expect(await attachedIds(issue.id)).toEqual([l1.id, l3.id].sort((a, b) => a - b));
    // The human write's trail: the add comment ("1") and the removal
    // comment ("") — poster = the workflow's doer.
    const trail = await db()
      .select({ content: comments.content, labelId: comments.labelId })
      .from(comments)
      .where(and(eq(comments.issueId, issue.id), eq(comments.type, CommentType.Label)))
      .all();
    // Upstream replace order — additions first, then removals
    // (models/issues/issue_label.go:396-414 via replaceLabels).
    expect(trail.map((row) => [row.labelId ?? 0, row.content ?? ""])).toEqual([
      [l3.id, "1"],
      [l2.id, ""],
    ]);
  });

  it("issue_state close closes the item with the close comment and counter", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    await seedWorkflow(p1.id, "item_column_changed", {}, { issue_state: "close" });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colA.id);
    const before = await db().select({ closed: repositories.numClosedIssues }).from(repositories).where(eq(repositories.id, REPO_ID)).all();

    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colB, null, ALICE_ID, NOW);

    const after = await issueRow(issue.id);
    expect(after.isClosed).toBe(true);
    expect(await commentCount(issue.id, CommentType.Close)).toBe(1);
    const repoCounter = await db().select({ closed: repositories.numClosedIssues }).from(repositories).where(eq(repositories.id, REPO_ID)).all();
    expect((repoCounter[0]?.closed ?? 0) - (before[0]?.closed ?? 0)).toBe(1);
  });

  it("issue_state reopen reopens a closed item moved into a column", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    // The state action lives on the column event (item_closed/item_reopened
    // cannot carry it — the capability matrix, workflows.go:123-124).
    await seedWorkflow(p1.id, "item_column_changed", {}, { issue_state: "reopen" });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colA.id);
    const service = new IssuesService(env.DB);
    await service.closeIssue(issue.id, { actorId: ALICE_ID, now: NOW });
    expect((await issueRow(issue.id)).isClosed).toBe(true);

    // The event-left snapshot is CLOSED, so the reopen gate passes and the
    // move pulls the item back open.
    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colB, null, ALICE_ID, NOW);

    expect((await issueRow(issue.id)).isClosed).toBe(false);
    expect(await commentCount(issue.id, CommentType.Reopen)).toBe(1);
  });

  it("issue_state reopen skips pull requests (they need the pull handlers' checks)", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    await seedWorkflow(p1.id, "item_column_changed", {}, { issue_state: "reopen" });
    const prIssue = await seedIssue(1, { isPull: true });
    await seedMembership(prIssue.id, p1.id, colA.id);
    const service = new IssuesService(env.DB);
    await service.closeIssue(prIssue.id, { actorId: ALICE_ID, now: NOW });

    // The snapshot isPull blocks the reopen — pull requests need the pull
    // handlers' reopen checks (workflow_notifier.go:163).
    await moveIssueToColumn(env.DB, p1, await issueRow(prIssue.id), colB, null, ALICE_ID, NOW);

    expect((await issueRow(prIssue.id)).isClosed).toBe(true);
    expect(await commentCount(prIssue.id, CommentType.Reopen)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

describe("the reducer's guards", () => {
  it("skips archived repositories entirely", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const l1 = await seedLabel(REPO_ID, "archived-dormant");
    await seedWorkflow(p1.id, "item_added_to_project", {}, { add_label_ids: [l1.id] });
    const issue = await seedIssue(1);
    await db().update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));

    await addIssueToColumn(env.DB, p1, await issueRow(issue.id), colA, ALICE_ID, NOW);

    // The attach itself stays (the mutation committed); only the workflow
    // emission is silent.
    expect(await membershipColumn(issue.id, p1.id)).toBe(colA.id);
    expect(await attachedIds(issue.id)).toEqual([]);
  });

  it("skips items with no projects without touching anything", async () => {
    const issue = await seedIssue(1);

    await notifyIssueChangeStatus(env.DB, { issue: await issueRow(issue.id), doerId: ALICE_ID, isClosed: true, now: NOW });
    await notifyMergePullRequest(env.DB, { issue: await issueRow(issue.id), doerId: ALICE_ID, now: NOW });

    expect(await attachedIds(issue.id)).toEqual([]);
  });

  it("the re-entrancy mark suppresses the close seam's own emission", async () => {
    const p1 = await seedProject();
    const l1 = await seedLabel(REPO_ID, "once");
    await seedWorkflow(p1.id, "item_closed", {}, { add_label_ids: [l1.id] });
    const p1MembershipIssue = await seedIssue(1);
    await seedMembership(p1MembershipIssue.id, p1.id, (await seedColumn(p1.id, { title: "A", isDefault: true })).id);
    const service = new IssuesService(env.DB);

    // Human close → the workflow fires once.
    await service.closeIssue(p1MembershipIssue.id, { actorId: ALICE_ID, now: NOW });
    expect(await attachedIds(p1MembershipIssue.id)).toEqual([l1.id]);

    // A workflow's own close (the mark) → suppressed: no second workflow run
    // (l1 stays attached from the human run, and a fresh workflow would
    // re-attach; the observable is the close NOT re-entering).
    const reentrant = await seedIssue(2);
    await seedMembership(reentrant.id, p1.id, (await seedColumn(p1.id, { title: "B" })).id);
    await db().delete(labels).where(eq(labels.id, l1.id));
    const l2 = await seedLabel(REPO_ID, "never");
    await seedWorkflow(p1.id, "item_closed", {}, { add_label_ids: [l2.id] });
    await service.closeIssue(reentrant.id, { actorId: ALICE_ID, now: NOW, viaWorkflow: "item_added_to_project" });
    expect(await attachedIds(reentrant.id)).toEqual([]);
  });

  it("the re-entrancy mark suppresses the move seam's own emission", async () => {
    const p1 = await seedProject();
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const colB = await seedColumn(p1.id, { title: "B" });
    const colC = await seedColumn(p1.id, { title: "C" });
    const l1 = await seedLabel(REPO_ID, "move-once");
    await seedWorkflow(p1.id, "item_column_changed", {}, { add_label_ids: [l1.id] });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, colA.id);

    // Human move fires; the marked (workflow's own) move does not.
    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colB, null, ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([l1.id]);

    // Fresh witness: wipe the first run's attach (link + label rows — D1
    // leaves the link behind when only the label row goes) and arm a second
    // workflow a marked move must NOT run.
    await db().delete(issueLabels).where(and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, l1.id)));
    await db().delete(labels).where(eq(labels.id, l1.id));
    const l2 = await seedLabel(REPO_ID, "never-again");
    await seedWorkflow(p1.id, "item_column_changed", {}, { add_label_ids: [l2.id] });
    await moveIssueToColumn(env.DB, p1, await issueRow(issue.id), colC, null, ALICE_ID, NOW, { viaWorkflow: "item_column_changed" });
    expect(await attachedIds(issue.id)).toEqual([]);
  });

  it("the merge close does not emit item_closed (merge.go:838's model-level silence)", async () => {
    const p1 = await seedProject();
    const l1 = await seedLabel(REPO_ID, "merge-silent");
    await seedWorkflow(p1.id, "item_closed", {}, { add_label_ids: [l1.id] });
    const issue = await seedIssue(1);
    await seedMembership(issue.id, p1.id, (await seedColumn(p1.id, { title: "A", isDefault: true })).id);
    const service = new IssuesService(env.DB);

    await service.closeIssue(issue.id, { actorId: ALICE_ID, now: NOW, commentType: CommentType.MergePull });

    expect(await attachedIds(issue.id)).toEqual([]);
    // ...and the merge event's port is what carries the workflows instead.
    const l2 = await seedLabel(REPO_ID, "merged");
    await seedWorkflow(p1.id, "pull_request_merged", {}, { add_label_ids: [l2.id] });
    await notifyMergePullRequest(env.DB, { issue: await issueRow(issue.id), doerId: ALICE_ID, now: NOW });
    expect(await attachedIds(issue.id)).toEqual([l2.id]);
  });
});

// ---------------------------------------------------------------------------
// The review port
// ---------------------------------------------------------------------------

describe("notifyPullRequestReview (the official approve/reject gate)", () => {
  it("fires code_review_approved for an official approve only", async () => {
    const p1 = await seedProject();
    const lApprove = await seedLabel(REPO_ID, "approved");
    const lReject = await seedLabel(REPO_ID, "changes-requested");
    await seedWorkflow(p1.id, "code_review_approved", {}, { add_label_ids: [lApprove.id] });
    await seedWorkflow(p1.id, "code_changes_requested", {}, { add_label_ids: [lReject.id] });
    const issue = await seedIssue(1, { isPull: true });
    await seedMembership(issue.id, p1.id, (await seedColumn(p1.id, { title: "A", isDefault: true })).id);

    // Non-official approve — silent.
    await notifyPullRequestReview(env.DB, {
      issue: await issueRow(issue.id),
      doerId: ALICE_ID,
      official: false,
      reviewType: ReviewType.Approve,
      now: NOW,
    });
    expect(await attachedIds(issue.id)).toEqual([]);

    await notifyPullRequestReview(env.DB, {
      issue: await issueRow(issue.id),
      doerId: ALICE_ID,
      official: true,
      reviewType: ReviewType.Approve,
      now: NOW,
    });
    expect(await attachedIds(issue.id)).toEqual([lApprove.id]);

    // An official reject flips to code_changes_requested.
    await db().delete(issueLabels).where(eq(issueLabels.issueId, issue.id));
    await notifyPullRequestReview(env.DB, {
      issue: await issueRow(issue.id),
      doerId: ALICE_ID,
      official: true,
      reviewType: ReviewType.Reject,
      now: NOW,
    });
    expect(await attachedIds(issue.id)).toEqual([lReject.id]);
  });
});

// ---------------------------------------------------------------------------
// The landed trigger seams
// ---------------------------------------------------------------------------

describe("the project-coupling diff writer seam", () => {
  it("the PATCH diff fires removed-first then the adds' attach emissions", async () => {
    const p1 = await seedProject({ title: "board" });
    const colA = await seedColumn(p1.id, { title: "A", isDefault: true });
    const lAdd = await seedLabel(REPO_ID, "added");
    const lRemove = await seedLabel(REPO_ID, "removed");
    await seedWorkflow(p1.id, "item_added_to_project", {}, { add_label_ids: [lAdd.id] });
    await seedWorkflow(p1.id, "item_removed_from_project", {}, { add_label_ids: [lRemove.id] });
    const issue = await seedIssue(1);
    const pair = { repo: (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).all())[0]!, owner: (await db().select().from(users).where(eq(users.id, ALICE_ID)).all())[0]! };

    await assignOrRemoveIssueProjects(env.DB, pair, await issueRow(issue.id), [p1.id], ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([lAdd.id]);
    expect(await membershipColumn(issue.id, p1.id)).toBe(colA.id);

    // The clear fires the removed event — the workflow runs even though the
    // membership is gone (upstream notifies the removed ids the same way).
    await assignOrRemoveIssueProjects(env.DB, pair, await issueRow(issue.id), [], ALICE_ID, NOW);
    expect(await attachedIds(issue.id)).toEqual([lAdd.id, lRemove.id].sort((a, b) => a - b));
  });
});
