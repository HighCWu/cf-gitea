/**
 * The SIDEBAR COMBO WRITES' module matrix (pages/issue-sidebar-writes.ts —
 * census gap #1 part one, the L cluster split): the ten POST/DELETE
 * handlers driven DIRECTLY over the module's own recipe router
 * (createIssueSidebarWritesRouter — the b91dd1c posture; the mounted
 * uiRouter carries none of it until the orchestrator's fold, and the fold
 * flips the unclaimed-write pins in issue-detail.matrix.test.tsx named in
 * the module header). The write ladders pin, per arm:
 *
 *   - the GATES: anonymous → the login 303 (the writer/admin/watch ladders
 *     share it), a non-writer → the 404 shell, an archived repo → the 404
 *     shell (the writer gate carries the RepoMustNotBeArchived arm; watch
 *     keeps its own), the §2.8 cross-origin 403 fronting EVERY ladder, and
 *     the GET twins answering chi's 405;
 *   - the MILESTONE write: set (the milestone(8) comment + the counter
 *     move), the same-id no-op (NO comment), clear (empty id), a foreign
 *     milestone id → the 404 shell, the pulls-family URL landing the
 *     issues-canonical 303;
 *   - the PROJECT write: attach (the project_issues row in the default
 *     column + the project(30) comment), detach (row gone + comment), the
 *     clear selection, a missing project id → the plain-text 500, an
 *     inaccessible (foreign-repo) project → the SKIP arm (303, untouched);
 *   - the ASSIGNEE write: attach/detach through the checkbox diff (the
 *     type-9 comments), action=clear, the org-row refusal re-rendering
 *     upstream's "User N cannot be assigned to this issue" at 200, the
 *     stale-id skip (303), the out-of-band assignee STAYING put when the
 *     posted set still carries them;
 *   - the DEADLINE write: yyyy-mm-dd → END-OF-DAY UTC, the modified
 *     comment on change, the empty submit CLEARING (removed comment), an
 *     unparseable value clearing (upstream's ignored-parse-error posture),
 *     the same deadline the no-op arm (no comment);
 *   - the WATCH write: the query-string bool through issue_subscriptions
 *     (true and false arms, both URL families);
 *   - the LOCK/UNLOCK writes: the flip + the system comments, the
 *     duplicate-lock and unlock-not-locked re-renders with upstream's
 *     exact messages (200, nothing written twice), the reason field
 *     accepted-but-unstored;
 *   - the PIN writes: the toggle (pin row at max+1 + the pin(36) comment,
 *     then unpin + the unpin(37) comment), the cap arm re-rendering "You
 *     can't pin more issues" (3 seeded pins), the DELETE /unpin/{index}
 *     ladder (204, the unpinned silent no-op, the miss 404), the move_pin
 *     JSON ladder (204 + the neighbour shift, position < 1 → 500, missing
 *     pin → 500, repo mismatch → 404, anonymous → the 403 JSON, a garbage
 *     body → 500);
 *   - the re-render channel: the failure messages land in the comment
 *     form's error slot at 200 (the landed issueLabelsSubmit convention).
 *
 * Rerun posture: every row existence-checked or diff-converged; the clock
 * rides the seeded offsets so comment rows converge by (issue, type).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { createProject, repoProjectScope } from "../../api/services/projects";
import { comments, issueAssignees, issuePins, issueSubscriptions, issues, projectIssues, repositories, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { createIssueSidebarWritesRouter, parseIssueDeadlineForm, parseIssueMilestoneForm, parseMovePinBody } from "./issue-sidebar-writes";

// --- the recipe-router harness (the issue-write-tails matrix's posture) ---------

const tailsRouter = createIssueSidebarWritesRouter();

async function fetchTail(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await tailsRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The synthetic-manifest env (the milestones.matrix fixture shape). */
const manifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: { fetch(input: RequestInfo): Promise<Response> } };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A same-origin urlencoded form POST (the §2.8 layer-2 guard's happy path). */
function formPost(path: string, body: Record<string, string>, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(body).toString(),
  };
}

/** A same-origin JSON POST (the move_pin shape). */
function jsonPost(path: string, body: unknown, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://test.local",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  };
}

/** The cross-origin write shape (the §2.8 guard's 403 arm). */
const crossOriginPost = (cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie }),
  },
  body: new URLSearchParams({ id: "1" }).toString(),
});

// --- fixtures -------------------------------------------------------------------

const T0 = 1_770_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Fixture {
  ownerCookie: string;
  bobCookie: string;
  ownerId: number;
  bobId: number;
  repoId: string;
  archivedRepoId: string;
  issueId: number;
  issueIndex: number;
  prIssueId: number;
  prIndex: number;
  milestoneId: number;
  projectId: number;
}

let fixture: Fixture | null = null;

async function numCommentsOf(issueId: number): Promise<number> {
  const row = await drizzle(env.DB).select({ num: issues.numComments }).from(issues).where(eq(issues.id, issueId)).get();
  return Number(row?.num ?? 0);
}

async function commentsOfType(issueId: number, type: (typeof CommentType)[keyof typeof CommentType]): Promise<number> {
  const rows = await drizzle(env.DB)
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.type, type)))
    .all();
  return rows.length;
}

async function ensureFixture(): Promise<Fixture> {
  if (fixture !== null) return fixture;
  const db = drizzle(env.DB);

  const owner = await seedVerifiedUser({ username: "sb-owner" });
  const bob = await seedVerifiedUser({ username: "sb-bob" });
  const service = new RepoService(env.DB);
  const repo = await service.create({ owner: { id: owner.id, usernameLower: "sb-owner" }, name: "writes", isPrivate: false, status: "ready" });
  const archivedRepo = await service.create({ owner: { id: owner.id, usernameLower: "sb-owner" }, name: "archived", isPrivate: false, status: "ready" });
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, archivedRepo.id));

  const svc = new IssuesService(env.DB);
  const issue = await svc.createIssue({ repoId: repo.id, title: "sb: writer issue", posterId: owner.id, now: at(10) });
  const pr = await svc.createPullRequest({
    repoId: repo.id,
    title: "sb: writer pull",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "sb-head",
    now: at(20),
  });
  const milestone = await svc.createMilestone({ repoId: repo.id, name: "sb: milestone", now: at(30) });
  const project = await createProject(env.DB, repoProjectScope(repo.id), { title: "sb: project", creatorId: owner.id, now: at(40) });

  fixture = {
    ownerCookie: await sessionHeader(owner.id),
    bobCookie: await sessionHeader(bob.id),
    ownerId: owner.id,
    bobId: bob.id,
    repoId: repo.id,
    archivedRepoId: archivedRepo.id,
    issueId: issue.id,
    issueIndex: issue.index,
    prIssueId: pr.issue.id,
    prIndex: pr.issue.index,
    milestoneId: milestone.id,
    projectId: project.id,
  };
  return fixture;
}

async function archivedIssueIndex(): Promise<number> {
  const f = await ensureFixture();
  const svc = new IssuesService(env.DB);
  const existing = await drizzle(env.DB)
    .select({ index: issues.index })
    .from(issues)
    .where(and(eq(issues.repoId, f.archivedRepoId), eq(issues.title, "sb: archived issue")))
    .get();
  if (existing !== undefined) return existing.index;
  const created = await svc.createIssue({ repoId: f.archivedRepoId, title: "sb: archived issue", posterId: f.ownerId, now: at(50) });
  return created.index;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Comment rows and join rows reset between ladders (the issue/milestone/
  // project/repo/user rows survive — the fixture converges). FK order:
  // joins first, then comments, then the pin rows.
  for (const table of ["issue_pins", "issue_subscriptions", "issue_assignees", "project_issues", "comments"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The mutable issue columns reset too — every ladder is self-contained
  // regardless of run order (the fixture rows survive).
  await env.DB.prepare("UPDATE issues SET is_locked = 0, milestone_id = NULL, deadline_unix = NULL").run();
});

// --- the parsers ------------------------------------------------------------------

describe("the form parsers", () => {
  it("the milestone form: the empty/zero/garbage id is the clear arm; the positive id sets", () => {
    expect(parseIssueMilestoneForm(new URLSearchParams("issue_ids=7&id=12"))).toEqual({ issueId: 7, milestoneId: 12 });
    expect(parseIssueMilestoneForm(new URLSearchParams("issue_ids=7&id="))).toEqual({ issueId: 7, milestoneId: null });
    expect(parseIssueMilestoneForm(new URLSearchParams("issue_ids=7&id=abc"))).toEqual({ issueId: 7, milestoneId: null });
    expect(parseIssueMilestoneForm(new URLSearchParams("issue_ids=x"))).toEqual({ issueId: null, milestoneId: null });
  });

  it("the deadline form: yyyy-mm-dd lands END-OF-DAY UTC; empty and unparseable clear (upstream's ignored parse error)", () => {
    const { deadline } = parseIssueDeadlineForm(new URLSearchParams("deadline=2030-01-31"));
    expect(deadline).not.toBeNull();
    expect(deadline!.getUTCFullYear()).toBe(2030);
    expect(deadline!.getUTCMonth()).toBe(0);
    expect(deadline!.getUTCDate()).toBe(31);
    expect(deadline!.getUTCHours()).toBe(23);
    expect(deadline!.getUTCMinutes()).toBe(59);
    expect(parseIssueDeadlineForm(new URLSearchParams("deadline=")).deadline).toBeNull();
    expect(parseIssueDeadlineForm(new URLSearchParams("deadline=nonsense")).deadline).toBeNull();
    // The rollover guard: month 13 / day 32 reject (upstream time.Parse).
    expect(parseIssueDeadlineForm(new URLSearchParams("deadline=2030-13-40")).deadline).toBeNull();
  });

  it("the move_pin JSON body: integers pass, everything else is the never-matching null", () => {
    expect(parseMovePinBody({ id: 5, position: 2 })).toEqual({ id: 5, position: 2 });
    expect(parseMovePinBody({ id: "5", position: "2" })).toEqual({ id: null, position: null });
    expect(parseMovePinBody({})).toEqual({ id: null, position: null });
    expect(parseMovePinBody(null)).toEqual({ id: null, position: null });
    expect(parseMovePinBody({ id: 5, position: 0 })).toEqual({ id: 5, position: 0 });
  });
});

// --- the gates ---------------------------------------------------------------------

describe("the write gates (the labels-write ladder, shared by every arm)", () => {
  it("anonymous POSTs 303 onto the login round-trip on every family", async () => {
    const f = await ensureFixture();
    for (const path of [
      `/sb-owner/writes/issues/milestone`,
      `/sb-owner/writes/issues/${f.issueIndex}/deadline`,
      `/sb-owner/writes/issues/${f.issueIndex}/watch`,
      `/sb-owner/writes/issues/${f.issueIndex}/lock`,
      `/sb-owner/writes/issues/${f.issueIndex}/pin`,
    ]) {
      const res = await fetchTail(path, formPost(path, { id: "1" }));
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("the §2.8 cross-origin guard 403s BEFORE the anonymous login 303", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/deadline`, crossOriginPost());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });

  it("GET on the POST-only twins answers chi's 405; the DELETE unpin answers 405 with allow: DELETE", async () => {
    const f = await ensureFixture();
    const get = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/watch`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const unpin = await fetchTail(`/sb-owner/writes/issues/unpin/${f.issueIndex}`);
    expect(unpin.status).toBe(405);
    expect(unpin.headers.get("allow")).toBe("DELETE");
  });

  it("an archived repo 404-shells the writer gate (the group's RepoMustNotBeArchived arm)", async () => {
    const f = await ensureFixture();
    const index = await archivedIssueIndex();
    const res = await fetchTail(
      `/sb-owner/archived/issues/${index}/deadline`,
      formPost(`/sb-owner/archived/issues/${index}/deadline`, { deadline: "2030-01-01" }, f.ownerCookie),
    );
    expect(res.status).toBe(404);
    const row = await drizzle(env.DB)
      .select({ deadlineAt: issues.deadlineAt })
      .from(issues)
      .where(and(eq(issues.repoId, f.archivedRepoId), eq(issues.index, index)))
      .get();
    expect(row?.deadlineAt ?? null).toBeNull();
  });
});

// --- the milestone write ---------------------------------------------------------------

describe("POST /{issues|pulls}/milestone (upstream UpdateIssueMilestone)", () => {
  it("sets the milestone: the row flips, the milestone(8) comment lands, the counter moves", async () => {
    const f = await ensureFixture();
    const before = await numCommentsOf(f.issueId);
    const res = await fetchTail(
      `/sb-owner/writes/issues/milestone`,
      formPost("/sb-owner/writes/issues/milestone", { issue_ids: String(f.issueId), id: String(f.milestoneId) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sb-owner/writes/issues/${f.issueIndex}`);
    const row = await drizzle(env.DB).select({ milestoneId: issues.milestoneId }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.milestoneId).toBe(f.milestoneId);
    expect(await commentsOfType(f.issueId, CommentType.Milestone)).toBe(1);
    expect(await numCommentsOf(f.issueId)).toBe(before + 1);
  });

  it("the same-id resubmit is the no-op arm: no comment, no num_comments move", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: String(f.milestoneId) }, f.ownerCookie));
    const after = await numCommentsOf(f.issueId);
    const res = await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: String(f.milestoneId) }, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(await numCommentsOf(f.issueId)).toBe(after);
    expect(await commentsOfType(f.issueId, CommentType.Milestone)).toBe(1);
  });

  it("clears on the empty id (the combo's clear-selection value)", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: String(f.milestoneId) }, f.ownerCookie));
    const res = await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: "" }, f.ownerCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ milestoneId: issues.milestoneId }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.milestoneId ?? null).toBeNull();
  });

  it("a foreign repo's milestone id 404-shells (the repo-scoped resolve; upstream's ServerError arm reduced)", async () => {
    const f = await ensureFixture();
    const other = await new RepoService(env.DB).create({ owner: { id: f.ownerId, usernameLower: "sb-owner" }, name: "other", isPrivate: false, status: "ready" });
    const foreign = await new IssuesService(env.DB).createMilestone({ repoId: other.id, name: "foreign", now: at(60) });
    const before = await numCommentsOf(f.issueId);
    const res = await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: String(foreign.id) }, f.ownerCookie));
    expect(res.status).toBe(404);
    const row = await drizzle(env.DB).select({ milestoneId: issues.milestoneId }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.milestoneId ?? null).toBeNull();
    expect(await numCommentsOf(f.issueId)).toBe(before);
  });

  it("the pulls-family URL writes the same row and 303s onto the ISSUES canonical page (a PR row's twin)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(
      `/sb-owner/writes/pulls/milestone`,
      formPost("/x", { issue_ids: String(f.prIssueId), id: String(f.milestoneId) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    // The canonical target is the ROW'S OWN family — a PR row's Issue.Link()
    // is the pulls page (the issueCommentSubmit rule).
    expect(res.headers.get("location")).toBe(`/sb-owner/writes/pulls/${f.prIndex}`);
    const row = await drizzle(env.DB).select({ milestoneId: issues.milestoneId }).from(issues).where(eq(issues.id, f.prIssueId)).get();
    expect(row?.milestoneId).toBe(f.milestoneId);
  });

  it("a non-writer (signed-in outsider) 404-shells and writes nothing", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/milestone`, formPost("/x", { issue_ids: String(f.issueId), id: String(f.milestoneId) }, f.bobCookie));
    expect(res.status).toBe(404);
    const row = await drizzle(env.DB).select({ milestoneId: issues.milestoneId }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.milestoneId ?? null).toBeNull();
  });
});

// --- the project write -----------------------------------------------------------------

describe("POST /{issues|pulls}/projects (upstream UpdateIssueProject)", () => {
  it("attaches: the membership row lands in the default column with the project(30) comment", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(
      `/sb-owner/writes/issues/projects`,
      formPost("/x", { issue_ids: String(f.issueId), id: String(f.projectId) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const membership = await drizzle(env.DB)
      .select({ columnId: projectIssues.projectColumnId })
      .from(projectIssues)
      .where(and(eq(projectIssues.issueId, f.issueId), eq(projectIssues.projectId, f.projectId)))
      .get();
    expect(membership).toBeDefined();
    expect(await commentsOfType(f.issueId, CommentType.Project)).toBe(1);
  });

  it("detaches on the empty set (the clear-selection): the row goes with the removal comment", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/projects`, formPost("/x", { issue_ids: String(f.issueId), id: String(f.projectId) }, f.ownerCookie));
    const res = await fetchTail(`/sb-owner/writes/issues/projects`, formPost("/x", { issue_ids: String(f.issueId) }, f.ownerCookie));
    expect(res.status).toBe(303);
    const membership = await drizzle(env.DB)
      .select({ id: projectIssues.id })
      .from(projectIssues)
      .where(and(eq(projectIssues.issueId, f.issueId), eq(projectIssues.projectId, f.projectId)))
      .get();
    expect(membership).toBeUndefined();
    // The removal is the second project(30) comment (the attach wrote the first).
    expect(await commentsOfType(f.issueId, CommentType.Project)).toBe(2);
  });

  it("a missing project id is the plain-text 500 (upstream's ServerError arm)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/projects`, formPost("/x", { issue_ids: String(f.issueId), id: "999999" }, f.ownerCookie));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("a foreign-repo project is the SKIP arm: 303, nothing written (upstream's permission-denied log-and-continue)", async () => {
    const f = await ensureFixture();
    const other = await new RepoService(env.DB).create({ owner: { id: f.ownerId, usernameLower: "sb-owner" }, name: "other2", isPrivate: false, status: "ready" });
    const foreign = await createProject(env.DB, repoProjectScope(other.id), { title: "foreign project", creatorId: f.ownerId, now: at(70) });
    const res = await fetchTail(`/sb-owner/writes/issues/projects`, formPost("/x", { issue_ids: String(f.issueId), id: String(foreign.id) }, f.ownerCookie));
    expect(res.status).toBe(303);
    const membership = await drizzle(env.DB)
      .select({ id: projectIssues.id })
      .from(projectIssues)
      .where(eq(projectIssues.issueId, f.issueId))
      .all();
    expect(membership).toEqual([]);
    expect(await commentsOfType(f.issueId, CommentType.Project)).toBe(0);
  });
});

// --- the assignee write -----------------------------------------------------------------

describe("POST /{issues|pulls}/assignee (upstream UpdateIssueAssignee)", () => {
  it("attaches and detaches through the checkbox diff (the type-9 comments ride the landed seams)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(
      `/sb-owner/writes/issues/assignee`,
      formPost("/x", { issue_ids: String(f.issueId), id: String(f.bobId) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    let edges = await drizzle(env.DB).select({ assigneeId: issueAssignees.assigneeId }).from(issueAssignees).where(eq(issueAssignees.issueId, f.issueId)).all();
    expect(edges.map((row) => row.assigneeId)).toEqual([f.bobId]);
    expect(await commentsOfType(f.issueId, CommentType.Assignees)).toBe(1);

    const clear = await fetchTail(`/sb-owner/writes/issues/assignee`, formPost("/x", { issue_ids: String(f.issueId) }, f.ownerCookie));
    expect(clear.status).toBe(303);
    edges = await drizzle(env.DB).select({ assigneeId: issueAssignees.assigneeId }).from(issueAssignees).where(eq(issueAssignees.issueId, f.issueId)).all();
    expect(edges).toEqual([]);
    expect(await commentsOfType(f.issueId, CommentType.Assignees)).toBe(2);
  });

  it("action=clear strips every assignee (upstream's DeleteNotPassedAssignee arm)", async () => {
    const f = await ensureFixture();
    await drizzle(env.DB).insert(issueAssignees).values({ issueId: f.issueId, assigneeId: f.bobId }).onConflictDoNothing();
    const res = await fetchTail(
      `/sb-owner/writes/issues/assignee`,
      formPost("/x", { issue_ids: String(f.issueId), action: "clear" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const edges = await drizzle(env.DB).select({ id: issueAssignees.id }).from(issueAssignees).where(eq(issueAssignees.issueId, f.issueId)).all();
    expect(edges).toEqual([]);
  });

  it("an org row refusal re-renders at 200 with upstream's exact message (the re-render channel)", async () => {
    const f = await ensureFixture();
    // An org row (users.type = org) — upstream's CanBeAssigned refusal.
    await drizzle(env.DB).insert(users).values({
      username: "sb-org",
      usernameLower: "sb-org",
      isAdmin: false,
      status: "active",
      visibility: "public",
      type: "org",
      createdAt: new Date(),
    });
    const orgRow = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "sb-org")).get();
    expect(orgRow).toBeDefined();
    const res = await fetchTail(
      `/sb-owner/writes/issues/assignee`,
      formPost("/x", { issue_ids: String(f.issueId), id: String(orgRow!.id) }, f.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`User ${orgRow!.id} cannot be assigned to this issue`);
    const edges = await drizzle(env.DB).select({ id: issueAssignees.id }).from(issueAssignees).where(eq(issueAssignees.issueId, f.issueId)).all();
    expect(edges).toEqual([]);
  });

  it("a stale user id skips silently (the stale-checkbox degradation of upstream's ServerError)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/assignee`, formPost("/x", { issue_ids: String(f.issueId), id: "424242" }, f.ownerCookie));
    expect(res.status).toBe(303);
    const edges = await drizzle(env.DB).select({ id: issueAssignees.id }).from(issueAssignees).where(eq(issueAssignees.issueId, f.issueId)).all();
    expect(edges).toEqual([]);
  });
});

// --- the deadline write ------------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/deadline (upstream UpdateIssueDeadline)", () => {
  it("sets the end-of-day deadline with the added(16) comment", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(
      `/sb-owner/writes/issues/${f.issueIndex}/deadline`,
      formPost("/x", { deadline: "2030-01-31" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sb-owner/writes/issues/${f.issueIndex}`);
    const row = await drizzle(env.DB).select({ deadlineAt: issues.deadlineAt }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.deadlineAt).not.toBeNull();
    expect(row!.deadlineAt!.getUTCHours()).toBe(23);
    expect(await commentsOfType(f.issueId, CommentType.AddedDeadline)).toBe(1);
  });

  it("the empty submit CLEARS (the no-JS remove affordance) with the removed(18) comment", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/deadline`, formPost("/x", { deadline: "2030-01-31" }, f.ownerCookie));
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/deadline`, formPost("/x", { deadline: "" }, f.ownerCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ deadlineAt: issues.deadlineAt }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.deadlineAt ?? null).toBeNull();
    expect(await commentsOfType(f.issueId, CommentType.RemovedDeadline)).toBe(1);
  });

  it("the same deadline is the no-op arm (no comment — upstream's unchanged guard)", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/deadline`, formPost("/x", { deadline: "2030-01-31" }, f.ownerCookie));
    const after = await numCommentsOf(f.issueId);
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/deadline`, formPost("/x", { deadline: "2030-01-31" }, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(await numCommentsOf(f.issueId)).toBe(after);
  });

  it("the pulls-family twin URL writes the same row (the group mounts on both families)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/pulls/${f.prIndex}/deadline`, formPost("/x", { deadline: "2031-02-14" }, f.ownerCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ deadlineAt: issues.deadlineAt }).from(issues).where(eq(issues.id, f.prIssueId)).get();
    expect(row?.deadlineAt).not.toBeNull();
  });
});

// --- the watch write -----------------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/watch (upstream IssueWatch)", () => {
  it("subscribes via the query-string bool: the issue_subscriptions row lands is_watching", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/watch?watch=true`, formPost("/x", {}, f.bobCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sb-owner/writes/issues/${f.issueIndex}`);
    const row = await drizzle(env.DB)
      .select({ isWatching: issueSubscriptions.isWatching })
      .from(issueSubscriptions)
      .where(and(eq(issueSubscriptions.issueId, f.issueId), eq(issueSubscriptions.userId, f.bobId)))
      .get();
    expect(row?.isWatching).toBe(true);
  });

  it("unsubscribes (watch=false upserts the explicit not-watching row)", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/watch?watch=true`, formPost("/x", {}, f.bobCookie));
    const res = await fetchTail(`/sb-owner/writes/pulls/${f.prIndex}/watch?watch=false`, formPost("/x", {}, f.ownerCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB)
      .select({ isWatching: issueSubscriptions.isWatching })
      .from(issueSubscriptions)
      .where(and(eq(issueSubscriptions.issueId, f.issueId), eq(issueSubscriptions.userId, f.bobId)))
      .get();
    expect(row?.isWatching).toBe(true); // bob's row untouched by the owner's PR write
    const ownerRow = await drizzle(env.DB)
      .select({ isWatching: issueSubscriptions.isWatching })
      .from(issueSubscriptions)
      .where(and(eq(issueSubscriptions.issueId, f.prIssueId), eq(issueSubscriptions.userId, f.ownerId)))
      .get();
    expect(ownerRow?.isWatching).toBe(false);
  });
});

// --- the lock/unlock writes -------------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/lock + /unlock (upstream LockIssue/UnlockIssue)", () => {
  it("locks: the flip + the Lock(23) comment; the reason is accepted but not stored (the issue-extras divergence)", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(
      `/sb-owner/writes/issues/${f.issueIndex}/lock`,
      formPost("/x", { reason: "Too heated" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ isLocked: issues.isLocked }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.isLocked).toBe(true);
    expect(await commentsOfType(f.issueId, CommentType.Lock)).toBe(1);
  });

  it("the duplicate lock re-renders at 200 with upstream's exact message and writes nothing more", async () => {
    const f = await ensureFixture();
    await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/lock`, formPost("/x", {}, f.ownerCookie));
    const before = await numCommentsOf(f.issueId);
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/lock`, formPost("/x", {}, f.ownerCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("An issue cannot be locked twice.");
    expect(await numCommentsOf(f.issueId)).toBe(before);
    expect(await commentsOfType(f.issueId, CommentType.Lock)).toBe(1);
  });

  it("unlocks with the Unlock(24) comment; the not-locked arm re-renders its upstream message", async () => {
    const f = await ensureFixture();
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/unlock`, formPost("/x", {}, f.ownerCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cannot unlock an issue that is not locked.");

    await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/lock`, formPost("/x", {}, f.ownerCookie));
    const unlock = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/unlock`, formPost("/x", {}, f.ownerCookie));
    expect(unlock.status).toBe(303);
    const row = await drizzle(env.DB).select({ isLocked: issues.isLocked }).from(issues).where(eq(issues.id, f.issueId)).get();
    expect(row?.isLocked).toBe(false);
    expect(await commentsOfType(f.issueId, CommentType.Unlock)).toBe(1);
  });
});

// --- the pin writes ---------------------------------------------------------------------------

async function seedPin(issueId: number, repoId: string, order: number): Promise<void> {
  await drizzle(env.DB).insert(issuePins).values({ issueId, repoId, pinOrder: order }).onConflictDoNothing();
}

describe("POST /{issues|pulls}/{index}/pin (upstream IssuePinOrUnpin) + DELETE /unpin/{index} + POST /move_pin", () => {
  it("pins: the row at max+1 + the pin(36) comment; toggling again unpins with the unpin(37) comment", async () => {
    const f = await ensureFixture();
    const before = await numCommentsOf(f.issueId);
    const pin = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/pin`, formPost("/x", {}, f.ownerCookie));
    expect(pin.status).toBe(303);
    let row = await drizzle(env.DB).select({ pinOrder: issuePins.pinOrder }).from(issuePins).where(eq(issuePins.issueId, f.issueId)).get();
    expect(row?.pinOrder).toBe(1);
    expect(await commentsOfType(f.issueId, CommentType.Pin)).toBe(1);
    expect(await numCommentsOf(f.issueId)).toBe(before + 1);

    const unpin = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/pin`, formPost("/x", {}, f.ownerCookie));
    expect(unpin.status).toBe(303);
    row = await drizzle(env.DB).select({ pinOrder: issuePins.pinOrder }).from(issuePins).where(eq(issuePins.issueId, f.issueId)).get();
    expect(row).toBeUndefined();
    expect(await commentsOfType(f.issueId, CommentType.Unpin)).toBe(1);
  });

  it("the cap arm re-renders upstream's message at 200 (3 pinned siblings)", async () => {
    const f = await ensureFixture();
    const svc = new IssuesService(env.DB);
    for (const offset of [0, 1, 2]) {
      const sibling = await svc.createIssue({ repoId: f.repoId, title: `sb: pinned ${offset}`, posterId: f.ownerId, now: at(100 + offset) });
      await seedPin(sibling.id, f.repoId, offset + 1);
    }
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/pin`, formPost("/x", {}, f.ownerCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pin more issues");
    const row = await drizzle(env.DB).select({ id: issuePins.issueId }).from(issuePins).where(eq(issuePins.issueId, f.issueId)).get();
    expect(row).toBeUndefined();
  });

  it("DELETE /unpin/{index}: 204, the unpinned silent no-op, a missing index the 404 shell", async () => {
    const f = await ensureFixture();
    await seedPin(f.issueId, f.repoId, 1);
    const res = await fetchTail(`/sb-owner/writes/issues/unpin/${f.issueIndex}`, { method: "DELETE", headers: { origin: "https://test.local", cookie: f.ownerCookie } });
    expect(res.status).toBe(204);
    const row = await drizzle(env.DB).select({ id: issuePins.issueId }).from(issuePins).where(eq(issuePins.issueId, f.issueId)).get();
    expect(row).toBeUndefined();

    const noop = await fetchTail(`/sb-owner/writes/issues/unpin/${f.issueIndex}`, { method: "DELETE", headers: { origin: "https://test.local", cookie: f.ownerCookie } });
    expect(noop.status).toBe(204);

    const miss = await fetchTail(`/sb-owner/writes/issues/unpin/999`, { method: "DELETE", headers: { origin: "https://test.local", cookie: f.ownerCookie } });
    expect(miss.status).toBe(404);
  });

  it("move_pin: the neighbour shift lands the pin at the requested position (204)", async () => {
    const f = await ensureFixture();
    const svc = new IssuesService(env.DB);
    const first = await svc.createIssue({ repoId: f.repoId, title: "sb: first", posterId: f.ownerId, now: at(110) });
    const second = await svc.createIssue({ repoId: f.repoId, title: "sb: second", posterId: f.ownerId, now: at(111) });
    await seedPin(first.id, f.repoId, 1);
    await seedPin(second.id, f.repoId, 2);
    const res = await fetchTail(`/sb-owner/writes/issues/move_pin`, jsonPost("/x", { id: second.id, position: 1 }, f.ownerCookie));
    expect(res.status).toBe(204);
    const moved = await drizzle(env.DB).select({ pinOrder: issuePins.pinOrder }).from(issuePins).where(eq(issuePins.issueId, second.id)).get();
    expect(moved?.pinOrder).toBe(1);
    const shifted = await drizzle(env.DB).select({ pinOrder: issuePins.pinOrder }).from(issuePins).where(eq(issuePins.issueId, first.id)).get();
    expect(shifted?.pinOrder).toBe(2);
  });

  it("move_pin's refusals: position < 1 → 500, missing pin → 500, repo mismatch → 404, anonymous → the 403 JSON, garbage body → 500", async () => {
    const f = await ensureFixture();
    const badPosition = await fetchTail(`/sb-owner/writes/issues/move_pin`, jsonPost("/x", { id: f.issueId, position: 0 }, f.ownerCookie));
    expect(badPosition.status).toBe(500);
    expect(await badPosition.text()).toContain("The Position can't be lower than 1");

    const noPin = await fetchTail(`/sb-owner/writes/issues/move_pin`, jsonPost("/x", { id: f.issueId, position: 1 }, f.ownerCookie));
    expect(noPin.status).toBe(500);
    expect(await noPin.text()).toContain("pin for the issue does not exist");

    const foreignIssue = await new IssuesService(env.DB).createIssue({ repoId: f.archivedRepoId, title: "sb: foreign", posterId: f.ownerId, now: at(120) });
    const mismatch = await fetchTail(`/sb-owner/writes/issues/move_pin`, jsonPost("/x", { id: foreignIssue.id, position: 1 }, f.ownerCookie));
    expect(mismatch.status).toBe(404);

    const anon = await fetchTail(`/sb-owner/writes/issues/move_pin`, jsonPost("/x", { id: f.issueId, position: 1 }));
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain("Only signed in users are allowed to perform this action");

    const garbage = await fetchTail(`/sb-owner/writes/issues/move_pin`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://test.local", cookie: f.ownerCookie },
      body: "not json",
    });
    expect(garbage.status).toBe(500);
  });

  it("a non-admin signed-in viewer 404-shells the pin ladder (the reqRepoAdmin gate)", async () => {
    const f = await ensureFixture();
    await addOrUpdateCollaborator(env.DB, f.repoId, f.bobId, "write", at(200));
    const res = await fetchTail(`/sb-owner/writes/issues/${f.issueIndex}/pin`, formPost("/x", {}, f.bobCookie));
    expect(res.status).toBe(404);
    const row = await drizzle(env.DB).select({ id: issuePins.issueId }).from(issuePins).where(eq(issuePins.issueId, f.issueId)).get();
    expect(row).toBeUndefined();
  });
});
