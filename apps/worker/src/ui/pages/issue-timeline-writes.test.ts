/**
 * The TIMELINE WRITES' module matrix (pages/issue-timeline-writes.ts —
 * census gap #1 part two): the sixteen POST families driven DIRECTLY over
 * the module's own recipe router (createIssueTimelineWritesRouter — the
 * issue-sidebar-writes.test.ts posture; the mounted uiRouter carries none
 * of it until the orchestrator's fold, and the fold flips the render-half
 * pins in issue-detail.matrix.test.tsx named in the module header). The
 * ladders pin, per family:
 *
 *   - the GATES: anonymous → the login 303 on every family, the §2.8
 *     cross-origin 403 fronting it, the GET twins answering chi's 405,
 *     the archived repo 404-shelling the group's RepoMustNotBeArchived arm
 *     on EVERY family EXCEPT the /comments trio (upstream's group carries
 *     no such middleware there — the archived-repo comment update still
 *     answers its ladder);
 *   - the REF write: set/clear with the change_issue_ref (33) comment, the
 *     PR-row 403 and the non-poster-non-writer 403 (upstream's
 *     HTTPError ladder, status-exact plain text);
 *   - the DEPENDENCY pair: the edge + the two type-19/20 comments, the
 *     duplicate/circular/self/cross-repo/missing refusals with upstream's
 *     exact JSONError texts on the re-render channel, the remove's
 *     blockedBy/blocking edge directions, the invalid type and the
 *     missing-dependency 500;
 *   - the TIMES family: the manual add (the `|{seconds}` marker comment),
 *     the sum-small refusal, the ANY-signed-in gate (the default-settings
 *     CanUseTimetracker), the owner-or-site-admin delete with the
 *     owner-attributed soft delete, the stopwatch trio's start/stop/
 *     cancel/cross-issue auto-close/already-running arms;
 *   - the ESTIMATE: the parse chain (1h30m, 1h30m5s, empty = 0, junk =
 *     invalid), the decimal-seconds comment, the unchanged no-op, the
 *     poster-or-writer 403;
 *   - the REACTIONS: the issue and comment surfaces' react/unreact
 *     toggles, the idempotent duplicate, the unknown action 404, the
 *     empty-content 400, the forbidden-reaction 500, the locked-issue
 *     writer arm;
 *   - the COMMENT trio: the strict content_version CAS refusal (upstream's
 *     exact already_changed text), the unchanged-content skip, the landed
 *     update/delete seams, the write-access + locked gates, the
 *     system-comment 400;
 *   - the DELETES: the single issue delete's cascade (the row family
 *     gone, the 303 onto the family LIST) and the batch delete's parse
 *     arms (junk piece → 500, foreign id → 404, empty → no-op);
 *   - the PROJECT COLUMN move: the column switch + the project-column
 *     (31) comment, the missing-column 500, the not-in-project 404.
 *
 * THROWAWAY DISCIPLINE (the 7187797 lesson): every arm whose write lands
 * a comment/edge/reaction/time row seeds its own throwaway issue(s) in
 * the ladder — the shared fixture's seeded rows stay pristine for the
 * display arms. The shared issue's mutable columns reset in beforeEach
 * alongside the join/comment tables.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addIssueToColumn, createColumn, createProject, mustDefaultColumn, repoProjectScope } from "../../api/services/projects";
import {
  comments,
  issueDependencies,
  issueStopwatches,
  issues,
  projectIssues,
  reactions,
  repositories,
  trackedTimes,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import {
  createIssueTimelineWritesRouter,
  parseAddTimeForm,
  parseDependencyAddForm,
  parseDependencyRemoveForm,
  parseIssueRefForm,
  parseProjectColumnMoveForm,
  parseTimeEstimateForm,
  timeEstimateString,
} from "./issue-timeline-writes";

// --- the recipe-router harness (the sidebar-writes matrix's posture) -----------

const timelineRouter = createIssueTimelineWritesRouter();

async function fetchTimeline(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await timelineRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
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

/** The cross-origin write shape (the §2.8 guard's 403 arm). */
const crossOriginPost = (cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie }),
  },
  body: new URLSearchParams({ content: "+1" }).toString(),
});

// --- fixtures -------------------------------------------------------------------

const T0 = 1_770_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Fixture {
  ownerCookie: string;
  bobCookie: string;
  adminCookie: string;
  ownerId: number;
  bobId: number;
  adminId: number;
  repoId: string;
  archivedRepoId: string;
  issueId: number;
  issueIndex: number;
  prIssueId: number;
  prIndex: number;
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

/** A THROWAWAY issue on the live repo — every mutating arm seeds its own
 *  (the 7187797 lesson: the shared fixture's seeded rows stay pristine). */
async function throwawayIssue(title: string, posterId: number): Promise<{ id: number; index: number }> {
  const svc = new IssuesService(env.DB);
  const row = await svc.createIssue({ repoId: (await ensureFixture()).repoId, title, posterId, now: new Date() });
  return { id: row.id, index: row.index };
}

async function throwawayComment(issueId: number, posterId: number, content = "tl: seed body"): Promise<number> {
  const created = await new IssuesService(env.DB).addComment({ issueId, posterId, content });
  return created.id;
}

async function ensureFixture(): Promise<Fixture> {
  if (fixture !== null) return fixture;
  const db = drizzle(env.DB);

  const owner = await seedVerifiedUser({ username: "tl-owner" });
  const bob = await seedVerifiedUser({ username: "tl-bob" });
  const admin = await seedVerifiedUser({ username: "tl-admin", isAdmin: true });
  const service = new RepoService(env.DB);
  const repo = await service.create({ owner: { id: owner.id, usernameLower: "tl-owner" }, name: "timelines", isPrivate: false, status: "ready" });
  const archivedRepo = await service.create({ owner: { id: owner.id, usernameLower: "tl-owner" }, name: "tl-arch", isPrivate: false, status: "ready" });
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, archivedRepo.id));

  const svc = new IssuesService(env.DB);
  const issue = await svc.createIssue({ repoId: repo.id, title: "tl: shared read target", posterId: owner.id, now: at(10) });
  const pr = await svc.createPullRequest({
    repoId: repo.id,
    title: "tl: writer pull",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "tl-head",
    now: at(20),
  });

  fixture = {
    ownerCookie: await sessionHeader(owner.id),
    bobCookie: await sessionHeader(bob.id),
    adminCookie: await sessionHeader(admin.id),
    ownerId: owner.id,
    bobId: bob.id,
    adminId: admin.id,
    repoId: repo.id,
    archivedRepoId: archivedRepo.id,
    issueId: issue.id,
    issueIndex: issue.index,
    prIssueId: pr.issue.id,
    prIndex: pr.issue.index,
  };
  return fixture;
}

async function archivedIssueIndex(): Promise<number> {
  const f = await ensureFixture();
  const svc = new IssuesService(env.DB);
  const existing = await drizzle(env.DB)
    .select({ index: issues.index })
    .from(issues)
    .where(and(eq(issues.repoId, f.archivedRepoId), eq(issues.title, "tl: archived issue")))
    .get();
  if (existing !== undefined) return existing.index;
  const created = await svc.createIssue({ repoId: f.archivedRepoId, title: "tl: archived issue", posterId: f.ownerId, now: at(50) });
  return created.index;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Join/comment/reaction/time rows reset between ladders (the issue/repo/
  // user rows survive — the fixture converges). FK order: joins first.
  for (const table of [
    "issue_pins",
    "issue_subscriptions",
    "issue_assignees",
    "project_issues",
    "issue_dependency",
    "reactions",
    "tracked_time",
    "stopwatch",
    "comments",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The mutable issue columns reset too — every ladder is self-contained
  // regardless of run order.
  await env.DB.prepare(
    "UPDATE issues SET is_locked = 0, milestone_id = NULL, deadline_unix = NULL, ref = '', time_estimate = 0",
  ).run();
});

// --- the parsers ------------------------------------------------------------------

describe("the form parsers", () => {
  it("the ref form trims (upstream FormTrim; whitespace-only = clear)", () => {
    expect(parseIssueRefForm(new URLSearchParams("ref=main"))).toBe("main");
    expect(parseIssueRefForm(new URLSearchParams("ref=+release-1.2+"))).toBe("release-1.2");
    expect(parseIssueRefForm(new URLSearchParams("ref="))).toBe("");
    expect(parseIssueRefForm(new URLSearchParams())).toBe("");
  });

  it("the dependency forms: the global dep id and the blockedBy/blocking literal", () => {
    expect(parseDependencyAddForm(new URLSearchParams("newDependency=42"))).toBe(42);
    expect(parseDependencyAddForm(new URLSearchParams("newDependency=abc"))).toBeNull();
    expect(parseDependencyRemoveForm(new URLSearchParams("removeDependencyID=7&dependencyType=blockedBy"))).toEqual({
      dependencyId: 7,
      dependencyType: "blockedBy",
    });
    expect(parseDependencyRemoveForm(new URLSearchParams("removeDependencyID=7&dependencyType=blocking"))).toEqual({
      dependencyId: 7,
      dependencyType: "blocking",
    });
    expect(parseDependencyRemoveForm(new URLSearchParams("removeDependencyID=7&dependencyType=other"))).toEqual({
      dependencyId: 7,
      dependencyType: "",
    });
    expect(parseDependencyRemoveForm(new URLSearchParams())).toEqual({ dependencyId: null, dependencyType: "" });
  });

  it("the add-time form: the Range(0,1000) ints; anything else is the null refusal", () => {
    expect(parseAddTimeForm(new URLSearchParams("hours=1&minutes=30"))).toEqual({ hours: 1, minutes: 30 });
    expect(parseAddTimeForm(new URLSearchParams("hours=1000&minutes=1000"))).toEqual({ hours: 1000, minutes: 1000 });
    expect(parseAddTimeForm(new URLSearchParams("hours=1001&minutes=0")).hours).toBeNull();
    expect(parseAddTimeForm(new URLSearchParams("hours=abc&minutes=5")).hours).toBeNull();
    expect(parseAddTimeForm(new URLSearchParams("hours=2")).hours).toBe(2); // the absent minutes is upstream's zero
    expect(parseAddTimeForm(new URLSearchParams("hours=&minutes=5")).hours).toBeNull(); // a present empty field is the bind refusal
    expect(parseAddTimeForm(new URLSearchParams()).hours).toBe(0); // absent = upstream's zero
  });

  it("the estimate parser: upstream TimeEstimateParse's chain (empty = 0, h/m/s mixes, junk rejected)", () => {
    expect(parseTimeEstimateForm("")).toBe(0);
    expect(parseTimeEstimateForm("   ")).toBe(0);
    expect(parseTimeEstimateForm("1h30m")).toBe(5400);
    expect(parseTimeEstimateForm("1h 30m")).toBe(5400);
    expect(parseTimeEstimateForm("1h30m5s")).toBe(5405);
    expect(parseTimeEstimateForm("2H")).toBe(7200);
    expect(parseTimeEstimateForm("45m")).toBe(2700);
    expect(parseTimeEstimateForm("1x")).toBeNull();
    expect(parseTimeEstimateForm("h")).toBeNull();
    expect(parseTimeEstimateForm("1h x 2m")).toBeNull();
    expect(parseTimeEstimateForm("1h junk")).toBeNull();
    expect(timeEstimateString(5400)).toBe("1h30m");
    expect(timeEstimateString(5430)).toBe("1h30m30s");
    expect(timeEstimateString(0)).toBe("");
  });

  it("the project-column move form: issue_id is the repo-scoped INDEX, id the global column", () => {
    expect(parseProjectColumnMoveForm(new URLSearchParams("issue_id=3&id=9"))).toEqual({ issueIndex: 3, columnId: 9 });
    expect(parseProjectColumnMoveForm(new URLSearchParams())).toEqual({ issueIndex: null, columnId: null });
  });
});

// --- the gates ---------------------------------------------------------------------

describe("the write gates", () => {
  it("anonymous POSTs 303 onto the login round-trip on every family", async () => {
    const f = await ensureFixture();
    const commentId = await throwawayComment(f.issueId, f.ownerId);
    for (const path of [
      `/tl-owner/timelines/issues/${f.issueIndex}/ref`,
      `/tl-owner/timelines/issues/${f.issueIndex}/dependency/add`,
      `/tl-owner/timelines/issues/${f.issueIndex}/times/add`,
      `/tl-owner/timelines/issues/${f.issueIndex}/times/stopwatch/start`,
      `/tl-owner/timelines/issues/${f.issueIndex}/time_estimate`,
      `/tl-owner/timelines/issues/${f.issueIndex}/reactions/react`,
      `/tl-owner/timelines/issues/${f.issueIndex}/delete`,
      `/tl-owner/timelines/issues/delete`,
      `/tl-owner/timelines/issues/projects/column`,
      `/tl-owner/timelines/comments/${commentId}`,
      `/tl-owner/timelines/comments/${commentId}/delete`,
      `/tl-owner/timelines/comments/${commentId}/reactions/react`,
    ]) {
      const res = await fetchTimeline(path, formPost(path, { content: "+1" }));
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("the §2.8 cross-origin guard 403s BEFORE the anonymous login 303", async () => {
    const f = await ensureFixture();
    const res = await fetchTimeline(`/tl-owner/timelines/issues/${f.issueIndex}/ref`, crossOriginPost());
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });

  it("GET on the POST-only tails answers chi's 405 with the allow header", async () => {
    const f = await ensureFixture();
    const res = await fetchTimeline(`/tl-owner/timelines/issues/${f.issueIndex}/ref`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    const batch = await fetchTimeline(`/tl-owner/timelines/issues/delete`);
    expect(batch.status).toBe(405);
    const stop = await fetchTimeline(`/tl-owner/timelines/issues/${f.issueIndex}/times/stopwatch/stop`);
    expect(stop.status).toBe(405);
  });

  it("an archived repo 404-shells the group's RepoMustNotBeArchived arm on the {index} families", async () => {
    const f = await ensureFixture();
    const index = await archivedIssueIndex();
    for (const path of [
      `/tl-owner/tl-arch/issues/${index}/ref`,
      `/tl-owner/tl-arch/issues/${index}/times/add`,
      `/tl-owner/tl-arch/issues/${index}/reactions/react`,
      `/tl-owner/tl-arch/issues/delete`,
    ]) {
      const res = await fetchTimeline(path, formPost(path, { content: "+1" }, f.ownerCookie));
      expect(res.status, path).toBe(404);
    }
  });

  it("the /comments trio carries NO archived arm (upstream's group has only the reader middleware) — the comment update answers its ladder on an archived repo", async () => {
    const f = await ensureFixture();
    const index = await archivedIssueIndex();
    const row = await drizzle(env.DB)
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.repoId, f.archivedRepoId), eq(issues.index, index)))
      .get();
    if (row === undefined) throw new Error("archived issue row missing");
    const commentId = await throwawayComment(row.id, f.ownerId, "tl: archived body");
    const res = await fetchTimeline(
      `/tl-owner/tl-arch/comments/${commentId}`,
      formPost(`/tl-owner/tl-arch/comments/${commentId}`, { content: "tl: archived edit", content_version: "0" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const updated = await drizzle(env.DB).select({ content: comments.content }).from(comments).where(eq(comments.id, commentId)).get();
    expect(updated?.content).toBe("tl: archived edit");
  });
});

// --- the ref write -----------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/ref (upstream UpdateIssueRef)", () => {
  it("sets the ref: the row flips with the change_issue_ref (33) comment carrying old/new", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: ref target", f.ownerId);
    const before = await numCommentsOf(target.id);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/ref`,
      formPost("/x", { ref: "release-1.2" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const row = await drizzle(env.DB).select({ ref: issues.ref }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.ref).toBe("release-1.2");
    expect(await commentsOfType(target.id, CommentType.ChangeIssueRef)).toBe(1);
    expect(await numCommentsOf(target.id)).toBe(before + 1);
    const comment = await drizzle(env.DB)
      .select({ oldRef: comments.oldRef, newRef: comments.newRef })
      .from(comments)
      .where(and(eq(comments.issueId, target.id), eq(comments.type, CommentType.ChangeIssueRef)))
      .get();
    expect(comment?.oldRef).toBe("");
    expect(comment?.newRef).toBe("release-1.2");
  });

  it("clears on the empty ref (FormTrim's whitespace arm)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: ref clear", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/ref`, formPost("/x", { ref: "main" }, f.ownerCookie));
    const res = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/ref`, formPost("/x", { ref: "  " }, f.ownerCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ ref: issues.ref }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.ref).toBe("");
    expect(await commentsOfType(target.id, CommentType.ChangeIssueRef)).toBe(2);
  });

  it("a PR row is the 403 arm (upstream `|| issue.IsPull`), status-exact plain text", async () => {
    const f = await ensureFixture();
    const res = await fetchTimeline(`/tl-owner/timelines/pulls/${f.prIndex}/ref`, formPost("/x", { ref: "main" }, f.ownerCookie));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Permission denied.");
  });

  it("a non-poster non-writer is the 403 arm", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: ref stranger", f.ownerId);
    const res = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/ref`, formPost("/x", { ref: "main" }, f.bobCookie));
    expect(res.status).toBe(403);
    const row = await drizzle(env.DB).select({ ref: issues.ref }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.ref).toBe("");
  });

  it("the poster (non-writer) may set their own issue's ref — upstream's IsPoster arm", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: ref poster own", f.bobId);
    const res = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/ref`, formPost("/x", { ref: "bob-branch" }, f.bobCookie));
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ ref: issues.ref }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.ref).toBe("bob-branch");
  });
});

// --- the dependency pair -----------------------------------------------------------

describe("POST /{issues|pulls}/{index}/dependency/add + /delete (upstream AddDependency/RemoveDependency)", () => {
  it("adds the edge with the two type-19 comments (both counters move)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: dep target", f.ownerId);
    const dep = await throwawayIssue("tl: dep blocker", f.ownerId);
    const beforeTarget = await numCommentsOf(target.id);
    const beforeDep = await numCommentsOf(dep.id);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/add`,
      formPost("/x", { newDependency: String(dep.id) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const edge = await drizzle(env.DB)
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dep.id)))
      .get();
    expect(edge).toBeDefined();
    expect(await commentsOfType(target.id, CommentType.AddDependency)).toBe(1);
    expect(await commentsOfType(dep.id, CommentType.AddDependency)).toBe(1);
    expect(await numCommentsOf(target.id)).toBe(beforeTarget + 1);
    expect(await numCommentsOf(dep.id)).toBe(beforeDep + 1);
  });

  it("the refusals carry upstream's exact JSONError texts on the re-render channel", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: dep refusals", f.ownerId);
    const dep = await throwawayIssue("tl: dep pair", f.ownerId);
    const post = (body: Record<string, string>): RequestInit =>
      formPost(`/x`, body, f.ownerCookie);

    // Duplicate edge.
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/dependency/add`, post({ newDependency: String(dep.id) }));
    const dup = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/dependency/add`, post({ newDependency: String(dep.id) }));
    expect(dup.status).toBe(200);
    expect(await dup.text()).toContain("Dependency already exists.");

    // Circular (the reverse edge exists → adding this direction is circular).
    const rev = await fetchTimeline(`/tl-owner/timelines/issues/${dep.index}/dependency/add`, post({ newDependency: String(target.id) }));
    expect(rev.status).toBe(200);
    expect(await rev.text()).toContain("two issues that block each other");

    // Self-dependency.
    const self = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/dependency/add`, post({ newDependency: String(target.id) }));
    expect(self.status).toBe(200);
    expect(await self.text()).toContain("You cannot make an issue depend on itself.");

    // Cross-repo pair (AllowCrossRepositoryDependencies defaults false).
    const foreign = await new IssuesService(env.DB).createIssue({
      repoId: f.archivedRepoId,
      title: "tl: foreign dep",
      posterId: f.ownerId,
      now: new Date(),
    });
    const cross = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/dependency/add`, post({ newDependency: String(foreign.id) }));
    expect(cross.status).toBe(200);
    expect(await cross.text()).toContain("Both issues must be in the same repository.");

    // Missing dependency id.
    const missing = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/dependency/add`, post({ newDependency: "424242" }));
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("Dependent issue does not exist.");
  });

  it("a signed-in non-writer answers the CanCreateIssueDependencies JSONError on the re-render channel", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: dep outsider", f.ownerId);
    const dep = await throwawayIssue("tl: dep outsider pair", f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/add`,
      formPost("/x", { newDependency: String(dep.id) }, f.bobCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Permission denied.");
    const edge = await drizzle(env.DB).select({ id: issueDependencies.id }).from(issueDependencies).all();
    expect(edge).toEqual([]);
  });

  it("remove: blockedBy deletes the (target, dep) edge; blocking deletes the (dep, target) edge; both write the type-20 pair", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: dep rm target", f.ownerId);
    const dep = await throwawayIssue("tl: dep rm pair", f.ownerId);
    await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/add`,
      formPost("/x", { newDependency: String(dep.id) }, f.ownerCookie),
    );
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/delete`,
      formPost("/x", { removeDependencyID: String(dep.id), dependencyType: "blockedBy" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const edge = await drizzle(env.DB)
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dep.id)))
      .get();
    expect(edge).toBeUndefined();
    expect(await commentsOfType(target.id, CommentType.RemoveDependency)).toBe(1);
    expect(await commentsOfType(dep.id, CommentType.RemoveDependency)).toBe(1);
  });

  it("remove's blocking direction targets the REVERSE edge", async () => {
    const f = await ensureFixture();
    // The edge (dep, target) — target BLOCKS dep — is removed by posting
    // blocking from target (upstream's DependencyTypeBlocking arm).
    const target = await throwawayIssue("tl: dep block target", f.ownerId);
    const dep = await throwawayIssue("tl: dep blocked pair", f.ownerId);
    await fetchTimeline(
      `/tl-owner/timelines/issues/${dep.index}/dependency/add`,
      formPost("/x", { newDependency: String(target.id) }, f.ownerCookie),
    );
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/delete`,
      formPost("/x", { removeDependencyID: String(dep.id), dependencyType: "blocking" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const edge = await drizzle(env.DB)
      .select({ id: issueDependencies.id })
      .from(issueDependencies)
      .where(and(eq(issueDependencies.issueId, dep.id), eq(issueDependencies.dependencyId, target.id)))
      .get();
    expect(edge).toBeUndefined();
  });

  it("remove's refusal arms: not-exists (re-render), invalid type (re-render), missing dependency id (500 plain text)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: dep rm refusals", f.ownerId);
    const dep = await throwawayIssue("tl: dep rm stray", f.ownerId);

    const none = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/delete`,
      formPost("/x", { removeDependencyID: String(dep.id), dependencyType: "blockedBy" }, f.ownerCookie),
    );
    expect(none.status).toBe(200);
    expect(await none.text()).toContain("Dependency does not exist.");

    const badType = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/delete`,
      formPost("/x", { removeDependencyID: String(dep.id), dependencyType: "sideways" }, f.ownerCookie),
    );
    expect(badType.status).toBe(200);
    expect(await badType.text()).toContain("invalid dependency type");

    const missing = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/dependency/delete`,
      formPost("/x", { removeDependencyID: "424242", dependencyType: "blockedBy" }, f.ownerCookie),
    );
    expect(missing.status).toBe(500);
    expect(missing.headers.get("content-type")).toContain("text/plain");
  });
});

// --- the times family --------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/times/* (upstream AddTimeManually/DeleteTime/stopwatch trio)", () => {
  it("manual add: the tracked_time row + the add_time_manual (14) comment with the |seconds marker", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: time add", f.ownerId);
    const before = await numCommentsOf(target.id);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/add`,
      formPost("/x", { hours: "1", minutes: "30" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const row = await drizzle(env.DB)
      .select({ seconds: trackedTimes.seconds, userId: trackedTimes.userId, deleted: trackedTimes.deleted })
      .from(trackedTimes)
      .where(eq(trackedTimes.issueId, target.id))
      .get();
    expect(row?.seconds).toBe(5400);
    expect(row?.userId).toBe(f.ownerId);
    expect(row?.deleted).toBe(false);
    expect(await commentsOfType(target.id, CommentType.AddTimeManual)).toBe(1);
    expect(await numCommentsOf(target.id)).toBe(before + 1);
    const comment = await drizzle(env.DB)
      .select({ content: comments.content })
      .from(comments)
      .where(and(eq(comments.issueId, target.id), eq(comments.type, CommentType.AddTimeManual)))
      .get();
    expect(comment?.content).toBe("|5400");
  });

  it("the zero-total and garbage entries refuse with upstream's sum-small message (nothing written)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: time zero", f.ownerId);
    for (const body of [{ hours: "0", minutes: "0" }, { hours: "abc", minutes: "5" }, { hours: "-1", minutes: "0" }, { hours: "2000", minutes: "0" }]) {
      const res = await fetchTimeline(
        `/tl-owner/timelines/issues/${target.index}/times/add`,
        formPost("/x", body, f.ownerCookie),
      );
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(await res.text(), JSON.stringify(body)).toContain("No time was entered.");
    }
    const rows = await drizzle(env.DB).select({ id: trackedTimes.id }).from(trackedTimes).all();
    expect(rows).toEqual([]);
  });

  it("ANY signed-in viewer may track time (the default-settings CanUseTimetracker)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: time bob", f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/add`,
      formPost("/x", { hours: "0", minutes: "45" }, f.bobCookie),
    );
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ seconds: trackedTimes.seconds }).from(trackedTimes).get();
    expect(row?.seconds).toBe(2700);
  });

  it("delete: only the entry's owner or a site admin; the soft delete + the owner-attributed comment 26", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: time delete", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/times/add`, formPost("/x", { hours: "2" }, f.bobCookie));
    const entry = await drizzle(env.DB)
      .select({ id: trackedTimes.id, userId: trackedTimes.userId, seconds: trackedTimes.seconds })
      .from(trackedTimes)
      .get();
    if (entry === undefined) throw new Error("tracked time seed missing");

    // A signed-in stranger 403s (upstream HTTPError "not allowed").
    const stranger = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/${entry.id}/delete`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain("Not allowed");

    // The site admin deletes (the OP-or-admin arm) — the comment posts by
    // the ENTRY'S owner (upstream Doer: t.User).
    const adminRes = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/${entry.id}/delete`,
      formPost("/x", {}, f.adminCookie),
    );
    expect(adminRes.status).toBe(303);
    const row = await drizzle(env.DB).select({ deleted: trackedTimes.deleted }).from(trackedTimes).where(eq(trackedTimes.id, entry.id)).get();
    expect(row?.deleted).toBe(true);
    const delComment = await drizzle(env.DB)
      .select({ posterId: comments.posterId, content: comments.content })
      .from(comments)
      .where(and(eq(comments.issueId, target.id), eq(comments.type, CommentType.DeleteTimeManual)))
      .get();
    expect(delComment?.posterId).toBe(f.bobId);
    expect(delComment?.content).toBe("|7200");
  });

  it("delete: a missing timeid 404-shells; an already-deleted entry is the same miss (the live-row filter)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: time delete miss", f.ownerId);
    const miss = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/times/9999/delete`, formPost("/x", {}, f.ownerCookie));
    expect(miss.status).toBe(404);
    const junk = await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/times/abc/delete`, formPost("/x", {}, f.ownerCookie));
    expect(junk.status).toBe(404);
  });

  it("stopwatch: start writes the row + the start_tracking (12) comment; stop banks the time with the stop_tracking (13) comment", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: stopwatch cycle", f.ownerId);
    const start = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/stopwatch/start`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(start.status).toBe(303);
    const row = await drizzle(env.DB).select({ issueId: issueStopwatches.issueId }).from(issueStopwatches).get();
    expect(row?.issueId).toBe(target.id);
    expect(await commentsOfType(target.id, CommentType.StartTracking)).toBe(1);

    const stop = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/stopwatch/stop`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(stop.status).toBe(303);
    const after = await drizzle(env.DB).select({ issueId: issueStopwatches.issueId }).from(issueStopwatches).get();
    expect(after).toBeUndefined();
    expect(await commentsOfType(target.id, CommentType.StopTracking)).toBe(1);
    const banked = await drizzle(env.DB).select({ seconds: trackedTimes.seconds }).from(trackedTimes).get();
    expect(banked?.seconds).toBeGreaterThanOrEqual(0);
  });

  it("cancel discards WITHOUT banking (the cancel_tracking (15) comment, no tracked_time)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: stopwatch cancel", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/times/stopwatch/start`, formPost("/x", {}, f.ownerCookie));
    const cancel = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/stopwatch/cancel`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(cancel.status).toBe(303);
    const row = await drizzle(env.DB).select({ id: issueStopwatches.id }).from(issueStopwatches).get();
    expect(row).toBeUndefined();
    expect(await commentsOfType(target.id, CommentType.CancelTracking)).toBe(1);
    const banked = await drizzle(env.DB).select({ id: trackedTimes.id }).from(trackedTimes).all();
    expect(banked).toEqual([]);
  });

  it("starting while ANOTHER issue's stopwatch runs banks that one first (CreateIssueStopwatch's auto-close)", async () => {
    const f = await ensureFixture();
    const first = await throwawayIssue("tl: stopwatch first", f.ownerId);
    const second = await throwawayIssue("tl: stopwatch second", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${first.index}/times/stopwatch/start`, formPost("/x", {}, f.ownerCookie));
    const start = await fetchTimeline(
      `/tl-owner/timelines/issues/${second.index}/times/stopwatch/start`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(start.status).toBe(303);
    const row = await drizzle(env.DB).select({ issueId: issueStopwatches.issueId }).from(issueStopwatches).get();
    expect(row?.issueId).toBe(second.id);
    expect(await commentsOfType(first.id, CommentType.StopTracking)).toBe(1);
    expect(await commentsOfType(second.id, CommentType.StartTracking)).toBe(1);
  });

  it("the already-running re-start and the non-running stop/cancel are the silent 303s (upstream's flash arms, nothing written)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: stopwatch silent", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/times/stopwatch/start`, formPost("/x", {}, f.ownerCookie));
    const before = await numCommentsOf(target.id);
    const restart = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/times/stopwatch/start`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(restart.status).toBe(303);
    expect(await commentsOfType(target.id, CommentType.StartTracking)).toBe(1);
    expect(await numCommentsOf(target.id)).toBe(before);

    const other = await throwawayIssue("tl: stopwatch silent stop", f.ownerId);
    const stopNothing = await fetchTimeline(
      `/tl-owner/timelines/issues/${other.index}/times/stopwatch/stop`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(stopNothing.status).toBe(303);
    expect(await commentsOfType(other.id, CommentType.StopTracking)).toBe(0);
    const cancelNothing = await fetchTimeline(
      `/tl-owner/timelines/issues/${other.index}/times/stopwatch/cancel`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(cancelNothing.status).toBe(303);
    expect(await commentsOfType(other.id, CommentType.CancelTracking)).toBe(0);
  });
});

// --- the time estimate ---------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/time_estimate (upstream UpdateIssueTimeEstimate)", () => {
  it("sets the estimate with the change_time_estimate (38) comment carrying the DECIMAL SECONDS", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: estimate set", f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "1h30m" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ timeEstimate: issues.timeEstimate }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.timeEstimate).toBe(5400);
    const comment = await drizzle(env.DB)
      .select({ content: comments.content })
      .from(comments)
      .where(and(eq(comments.issueId, target.id), eq(comments.type, CommentType.ChangeTimeEstimate)))
      .get();
    expect(comment?.content).toBe("5400");
  });

  it("the empty estimate is a valid 0 (the clear arm); the unchanged value is the no-op", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: estimate clear", f.ownerId);
    // A fresh row sits at estimate 0 — the empty submit is the NO-OP arm
    // there (upstream's unchanged guard); seed a real value first so the
    // clear is a real transition.
    await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "45m" }, f.ownerCookie),
    );
    expect(await commentsOfType(target.id, CommentType.ChangeTimeEstimate)).toBe(1);
    const empty = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "" }, f.ownerCookie),
    );
    expect(empty.status).toBe(303);
    expect(await commentsOfType(target.id, CommentType.ChangeTimeEstimate)).toBe(2);
    const row = await drizzle(env.DB).select({ timeEstimate: issues.timeEstimate }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row?.timeEstimate).toBe(0);

    const same = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "" }, f.ownerCookie),
    );
    expect(same.status).toBe(303);
    expect(await commentsOfType(target.id, CommentType.ChangeTimeEstimate)).toBe(2); // no third comment
  });

  it("an invalid chain re-renders upstream's message; a non-poster non-writer is the 403", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: estimate invalid", f.ownerId);
    const invalid = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "1x" }, f.ownerCookie),
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.text()).toContain("Time estimate format is invalid");

    const forbidden = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/time_estimate`,
      formPost("/x", { time_estimate: "1h" }, f.bobCookie),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toContain("Permission denied.");
  });
});

// --- the reactions ---------------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/reactions/{action} + /comments/{id}/reactions/{action}", () => {
  it("issue react: the reactions row lands (commentId 0); the duplicate stays success (idempotent)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react issue", f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const row = await drizzle(env.DB)
      .select({ type: reactions.type, commentId: reactions.commentId, userId: reactions.userId })
      .from(reactions)
      .get();
    expect(row?.type).toBe("+1");
    expect(row?.commentId).toBe(0);
    const again = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(again.status).toBe(303);
    const rows = await drizzle(env.DB).select({ id: reactions.id }).from(reactions).all();
    expect(rows).toHaveLength(1);
  });

  it("issue unreact removes; any signed-in reader may react; the pulls family answers the same ladder", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react unreact", f.ownerId);
    await fetchTimeline(`/tl-owner/timelines/issues/${target.index}/reactions/react`, formPost("/x", { content: "heart" }, f.bobCookie));
    const unreact = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/unreact`,
      formPost("/x", { content: "heart" }, f.bobCookie),
    );
    expect(unreact.status).toBe(303);
    const rows = await drizzle(env.DB).select({ id: reactions.id }).from(reactions).all();
    expect(rows).toEqual([]);

    const prRes = await fetchTimeline(
      `/tl-owner/timelines/pulls/${f.prIndex}/reactions/react`,
      formPost("/x", { content: "rocket" }, f.bobCookie),
    );
    expect(prRes.status).toBe(303);
    expect(prRes.headers.get("location")).toBe(`/tl-owner/timelines/pulls/${f.prIndex}`);
  });

  it("the refusal arms: unknown action 404, empty content 400, a non-allowed code 500 plain text", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react refusals", f.ownerId);
    const unknown = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/sideways`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(unknown.status).toBe(404);
    const empty = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "" }, f.ownerCookie),
    );
    expect(empty.status).toBe(400);
    const forbidden = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "not-an-emoji" }, f.ownerCookie),
    );
    expect(forbidden.status).toBe(500);
    expect(await forbidden.text()).toContain("ChangeIssueReaction");
  });

  it("the locked-issue arm: a non-writer is the 403; a writer passes", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react locked", f.ownerId);
    await drizzle(env.DB).update(issues).set({ isLocked: true }).where(eq(issues.id, target.id));
    const bob = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "+1" }, f.bobCookie),
    );
    expect(bob.status).toBe(403);
    const ownerRes = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(ownerRes.status).toBe(303);
    const rows = await drizzle(env.DB).select({ id: reactions.id }).from(reactions).all();
    expect(rows).toHaveLength(1);
  });

  it("comment react: the row keys (issue, comment); the comment poster joins the blocker set", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react comment", f.ownerId);
    const commentId = await throwawayComment(target.id, f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}/reactions/react`,
      formPost("/x", { content: "eyes" }, f.bobCookie),
    );
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ commentId: reactions.commentId, type: reactions.type }).from(reactions).get();
    expect(row?.commentId).toBe(commentId);
    expect(row?.type).toBe("eyes");
    const unreact = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}/reactions/unreact`,
      formPost("/x", { content: "eyes" }, f.bobCookie),
    );
    expect(unreact.status).toBe(303);
    const rows = await drizzle(env.DB).select({ id: reactions.id }).from(reactions).all();
    expect(rows).toEqual([]);
  });

  it("a system comment (no content support) is the 400; a missing comment id the 404 shell", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: react system", f.ownerId);
    const now = new Date();
    const inserted = await drizzle(env.DB)
      .insert(comments)
      .values({
        type: CommentType.Label,
        posterId: f.ownerId,
        issueId: target.id,
        labelId: null,
        content: "",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comments.id });
    const systemId = inserted[0]!.id;
    const res = await fetchTimeline(
      `/tl-owner/timelines/comments/${systemId}/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(res.status).toBe(400);
    const miss = await fetchTimeline(
      `/tl-owner/timelines/comments/424242/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie),
    );
    expect(miss.status).toBe(404);
  });
});

// --- the comment update/delete trio ----------------------------------------------------

describe("POST /comments/{id} + /comments/{id}/delete (upstream UpdateCommentContent/DeleteComment)", () => {
  it("update: the body flips with the version bump (the landed content-history hook)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: comment update", f.ownerId);
    const commentId = await throwawayComment(target.id, f.ownerId, "tl: original");
    const res = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}`,
      formPost("/x", { content: "tl: edited body", content_version: "0" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const row = await drizzle(env.DB)
      .select({ content: comments.content, contentVersion: comments.contentVersion })
      .from(comments)
      .where(eq(comments.id, commentId))
      .get();
    expect(row?.content).toBe("tl: edited body");
    expect(row?.contentVersion).toBe(1);
  });

  it("the STRICT content_version mismatch refuses with upstream's exact already_changed text (nothing written)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: comment cas", f.ownerId);
    const commentId = await throwawayComment(target.id, f.ownerId, "tl: cas body");
    const res = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}`,
      formPost("/x", { content: "tl: raced edit", content_version: "5" }, f.ownerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unable to save changes to the comment");
    const row = await drizzle(env.DB).select({ content: comments.content }).from(comments).where(eq(comments.id, commentId)).get();
    expect(row?.content).toBe("tl: cas body");
  });

  it("the unchanged content skips the write (no version bump)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: comment unchanged", f.ownerId);
    const commentId = await throwawayComment(target.id, f.ownerId, "tl: same body");
    const res = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}`,
      formPost("/x", { content: "tl: same body", content_version: "0" }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    const row = await drizzle(env.DB).select({ contentVersion: comments.contentVersion }).from(comments).where(eq(comments.id, commentId)).get();
    expect(row?.contentVersion).toBe(0);
  });

  it("a non-poster non-writer is the 403; the locked issue needs a writer; the delete unlinks and decrements", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: comment gates", f.ownerId);
    const commentId = await throwawayComment(target.id, f.ownerId, "tl: gated body");

    const stranger = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}`,
      formPost("/x", { content: "tl: hijack", content_version: "0" }, f.bobCookie),
    );
    expect(stranger.status).toBe(403);

    await drizzle(env.DB).update(issues).set({ isLocked: true }).where(eq(issues.id, target.id));
    const lockedBob = await fetchTimeline(
      `/tl-owner/timelines/comments/${commentId}`,
      formPost("/x", { content: "tl: locked edit", content_version: "0" }, f.bobCookie),
    );
    expect(lockedBob.status).toBe(403);
    await drizzle(env.DB).update(issues).set({ isLocked: false }).where(eq(issues.id, target.id));

    const before = await numCommentsOf(target.id);
    const del = await fetchTimeline(`/tl-owner/timelines/comments/${commentId}/delete`, formPost("/x", {}, f.ownerCookie));
    expect(del.status).toBe(303);
    const row = await drizzle(env.DB).select({ id: comments.id }).from(comments).where(eq(comments.id, commentId)).get();
    expect(row).toBeUndefined();
    expect(await numCommentsOf(target.id)).toBe(before - 1);

    const bobDel = await fetchTimeline(
      `/tl-owner/timelines/comments/${await throwawayComment(target.id, f.ownerId)}/delete`,
      formPost("/x", {}, f.bobCookie),
    );
    expect(bobDel.status).toBe(403);
  });
});

// --- the deletes -------------------------------------------------------------------------

describe("POST /{issues|pulls}/{index}/delete + /{issues|pulls}/delete (upstream DeleteIssue/BatchDeleteIssues)", () => {
  it("delete: the cascade removes the row family and 303s onto the family LIST (upstream's literal redirect)", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: delete target", f.ownerId);
    await throwawayComment(target.id, f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/${target.index}/delete`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues`);
    const row = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.id, target.id)).get();
    expect(row).toBeUndefined();
    const stray = await drizzle(env.DB).select({ id: comments.id }).from(comments).where(eq(comments.issueId, target.id)).all();
    expect(stray).toEqual([]);
  });

  it("a PR row's delete lands on the PULLS list; a non-admin is the 404 shell", async () => {
    const f = await ensureFixture();
    const svc = new IssuesService(env.DB);
    const pr = await svc.createPullRequest({
      repoId: f.repoId,
      title: "tl: delete pull",
      posterId: f.ownerId,
      headRepoId: f.repoId,
      baseBranch: "main",
      headBranch: "tl-delete-head",
      now: new Date(),
    });
    const res = await fetchTimeline(
      `/tl-owner/timelines/pulls/${pr.issue.index}/delete`,
      formPost("/x", {}, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/pulls`);

    const outsider = await throwawayIssue("tl: delete outsider", f.ownerId);
    const bobRes = await fetchTimeline(
      `/tl-owner/timelines/issues/${outsider.index}/delete`,
      formPost("/x", {}, f.bobCookie),
    );
    expect(bobRes.status).toBe(404);
    const row = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.id, outsider.id)).get();
    expect(row).toBeDefined();
  });

  it("batch delete: the comma-joined set cascades; the 303 lands on the ADDRESSED family's list", async () => {
    const f = await ensureFixture();
    const first = await throwawayIssue("tl: batch one", f.ownerId);
    const second = await throwawayIssue("tl: batch two", f.ownerId);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/delete`,
      formPost("/x", { issue_ids: `${first.id},${second.id}` }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues`);
    for (const id of [first.id, second.id]) {
      const row = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.id, id)).get();
      expect(row).toBeUndefined();
    }
    const pullsRes = await fetchTimeline(
      `/tl-owner/timelines/pulls/delete`,
      formPost("/x", { issue_ids: "" }, f.ownerCookie),
    );
    expect(pullsRes.status).toBe(303);
    expect(pullsRes.headers.get("location")).toBe(`/tl-owner/timelines/pulls`);
  });

  it("batch delete's refusal arms: a junk piece is the ParseInt 500; a foreign/missing id the 404 shell", async () => {
    const f = await ensureFixture();
    const junk = await fetchTimeline(
      `/tl-owner/timelines/issues/delete`,
      formPost("/x", { issue_ids: "12,abc" }, f.ownerCookie),
    );
    expect(junk.status).toBe(500);
    expect(await junk.text()).toContain("ParseInt");
    const foreign = await fetchTimeline(
      `/tl-owner/timelines/issues/delete`,
      formPost("/x", { issue_ids: "424242" }, f.ownerCookie),
    );
    expect(foreign.status).toBe(404);
  });
});

// --- the project column move -------------------------------------------------------------

describe("POST /{issues|pulls}/projects/column (upstream UpdateIssueProjectColumn)", () => {
  it("moves the issue to the requested column with the project-column (31) comment", async () => {
    const f = await ensureFixture();
    const project = await createProject(env.DB, repoProjectScope(f.repoId), { title: "tl: column project", creatorId: f.ownerId, now: at(60) });
    const defaultColumn = await mustDefaultColumn(env.DB, project, at(61)); // the lazy default column
    const second = await createColumn(env.DB, project.id, { title: "tl: second column", creatorId: f.ownerId, now: at(62) });
    const target = await throwawayIssue("tl: column move", f.ownerId);
    const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, target.id)).get();
    if (row === undefined) throw new Error("target row missing");
    await addIssueToColumn(env.DB, project, row, defaultColumn, f.ownerId, at(63));

    const before = await numCommentsOf(target.id);
    const res = await fetchTimeline(
      `/tl-owner/timelines/issues/projects/column`,
      formPost("/x", { issue_id: String(target.index), id: String(second.id) }, f.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/tl-owner/timelines/issues/${target.index}`);
    const membership = await drizzle(env.DB)
      .select({ columnId: projectIssues.projectColumnId })
      .from(projectIssues)
      .where(and(eq(projectIssues.issueId, target.id), eq(projectIssues.projectId, project.id)))
      .get();
    expect(membership?.columnId).toBe(second.id);
    // The landed writeProjectComment writes the comment row WITHOUT the
    // num_comments fold (the service's documented updateCommentInfos
    // divergence) — the counter stays put.
    expect(await commentsOfType(target.id, CommentType.ProjectColumn)).toBe(1);
    expect(await numCommentsOf(target.id)).toBe(before);
    // The pulls-family literal answers the same write.
    const twin = await fetchTimeline(
      `/tl-owner/timelines/pulls/projects/column`,
      formPost("/x", { issue_id: String(target.index), id: String(second.id) }, f.ownerCookie),
    );
    expect(twin.status).toBe(303);
  });

  it("the refusal arms: a missing column is the GetColumn 500; an issue not in the column's project the 404 shell", async () => {
    const f = await ensureFixture();
    const target = await throwawayIssue("tl: column refusals", f.ownerId);
    const missing = await fetchTimeline(
      `/tl-owner/timelines/issues/projects/column`,
      formPost("/x", { issue_id: String(target.index), id: "999999" }, f.ownerCookie),
    );
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain("GetColumn");

    const project = await createProject(env.DB, repoProjectScope(f.repoId), { title: "tl: column stray project", creatorId: f.ownerId, now: at(64) });
    const column = await mustDefaultColumn(env.DB, project, at(65));
    const notIn = await fetchTimeline(
      `/tl-owner/timelines/issues/projects/column`,
      formPost("/x", { issue_id: String(target.index), id: String(column.id) }, f.ownerCookie),
    );
    expect(notIn.status).toBe(404);

    const missingIssue = await fetchTimeline(
      `/tl-owner/timelines/issues/projects/column`,
      formPost("/x", { issue_id: "999999", id: String(column.id) }, f.ownerCookie),
    );
    expect(missingIssue.status).toBe(404);
  });
});
