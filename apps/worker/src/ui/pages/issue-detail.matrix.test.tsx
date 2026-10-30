/**
 * The ISSUE-DETAIL family's DEFERRED route-level matrix (pages/
 * issue-detail.tsx — `/issues/{index}` + `/pulls/{index}` and their
 * comment/label/review arms). Additive over the suites that own the base
 * arms — this file adds ONLY the gaps they leave; it re-pins nothing:
 *
 *   - ui/__tests__/pages-wave2.test.ts owns the parser family (integer
 *     index, the cross-family 303 shapes at parse level, the non-numeric
 *     and deeper-tail engine handoffs);
 *   - ui/__tests__/pages-wave3.test.ts owns the GET reads: title bar,
 *     markdown pipeline bodies, comment/close/reopen timeline, reduced
 *     sidebar (label badges into the live filters, the milestone's live
 *     `/milestone/{id}` link — w129 batch-14), the open/closed PR badges,
 *     the open/closed PR badges, the no-content variant, the mirrored-
 *     import poster, the cross-family redirects route-level and the 404
 *     shells;
 *   - ui/__tests__/pages-wave5.test.ts owns the write arms it landed: the
 *     comment POST (+ status close/reopen riders, both families), the
 *     cross-origin 403s on `/issues/{n}/comments` and `/issues/labels`,
 *     the anonymous 303s, the empty-comment re-render, the merged-PR
 *     badge/toggle render, the labels replace round-trip (issues family)
 *     and the files page;
 *   - ui/__tests__/pages-wave11.test.ts owns the review interactions: the
 *     Reviewers sidebar's privacy filter and grants, the verdict POST's
 *     422s/pending-conversion/redirect hashtags, the request add/detach
 *     arms and the admin dismissal;
 *   - ui/__tests__/pages-pull-commits.test.ts + pages-wave29-diffpatch-
 *     files.test.ts + pull-merge-box.test.tsx own the tab pages, the
 *     .diff/.patch downloads and the merge-box module;
 *   - pages/issues-list.matrix.test.tsx owns the LIST row state machine
 *     (open/WIP/closed/merged glyphs on rows — not the detail page).
 *
 * THIS FILE adds the arms none of those carry, driven over the mounted
 * uiRouter on the labels/projects matrix minted-session pattern (d23ad32
 * is the freshest reference; every form POST carries the browser's
 * same-origin Origin header so the §2.8 guard's happy path rides each
 * write):
 *
 *   - the §2.8 cross-origin 403s the earlier waves left unpinned: the
 *     pulls-family comment POST (wave 5 pinned the issues twin only) and
 *     ALL THREE review POSTs (`/pulls/{n}/files/reviews/submit`,
 *     `/issues/request_review`, `/issues/dismiss_review` — wave 11 pinned
 *     their anonymous-303/405/422 arms but never the guard): a valid
 *     cookie still 403s and nothing is written (D1 read-backs), and the
 *     cookie-less cross-origin POST 403s BEFORE the anonymous login 303;
 *   - the comment arms' remaining gates: the LOCKED issue (no suite seeds
 *     one — `is_locked` is unpinned end to end) and the ARCHIVED repo on
 *     the detail pages (the suites never seed an archived repo with
 *     issues);
 *   - the sidebar write arms: the admin label form's GET render (the
 *     hidden `issue_ids`, the pre-checked current label, Save — wave 5
 *     pinned only the POST round-trip), the non-admin's form-less GET,
 *     the labels POST's canonical `/pulls/{n}` redirect twin, the junk
 *     `issue_ids` parse miss, and upstream's milestone/assignee/status
 *     sidebar POSTs staying unclaimed (plain non-page 404);
 *   - the state machine through the DETAIL route: the WIP draft badge
 *     (grey label + `octicon-git-pull-request-draft` — the list matrix
 *     pins the row glyph, no suite pins the page badge) with the merge
 *     box's WIP line, the MERGED meta line (`{merger} merged <code>…
 *     </code> into <code>…</code>`) and the merge EVENT line (`merged
 *     commit {sha10} into {base}` with the purple badge — wave 5 pinned
 *     the purple badge alone), the closed-ISSUE badge glyph pair, the
 *     reopen button's degraded icon, and the merged-PR status-rider
 *     no-op at write level (wave 5 pinned the render half);
 *   - the claim pins: POST on the detail shapes themselves, the upstream
 *     `/issues|pulls/{n}/title` edit tails, GET `/pulls/{n}/comments`
 *     (the 405 twin wave 5 pinned for the issues family only).
 *
 * ESCALATED RED (real bugs, one root cause, shared file — NOT this file
 * to fix): `IssueDetailPage`'s render gate
 * `showForm = user && !repo.isArchived && (!issue.isLocked ||
 * access.canChangeState)` excludes exactly the viewers whose refusal
 * messages `CommentFormBlock` owns, so:
 *
 *   (1) a signed-in viewer on an ARCHIVED repo gets NO comment-area
 *       message at all, where upstream view_content.tmpl:114-121 renders
 *       `repo.archive.{issue,pull}.nocomment` for exactly this arm (the
 *       module header promises the message; the archived branch is
 *       unreachable dead UI — the §2.4.1 dead-UI rule);
 *   (2) an ANONYMOUS viewer on an ARCHIVED repo gets the sign-in
 *       warning, where upstream view_content.tmpl:123-133 renders the
 *       archive message for both viewer kinds and reserves the sign-in
 *       warning for non-archived repos (CommentFormBlock checks
 *       anonymous BEFORE archived);
 *   (3) the locked-POST refusal message
 *       ("You cannot comment on a locked issue.", upstream MustAllowUser
 *       Comment's flash, routers/web/repo/issue.go:80-92) is computed by
 *       createCommentFromForm and then DROPPED by the same gate — the
 *       landed re-render convention (issueCommentSubmit's own docstring:
 *       "validation failures re-render the detail page at 200 with the
 *       message and the kept draft") is violated for the locked arm the
 *       same way the archived POST refusal is.
 *   Fix sketch (issue-detail.tsx): render CommentFormBlock for archived
 *   repos too (its archived branch already carries the upstream
 *   `tw-text-center` markup), hoist the archived check ahead of the
 *   anonymous one, and let a re-render's error message surface even when
 *   the form controls stay gated (the locked arm). The three tests below
 *   assert the upstream/landed behavior and are left RED for the
 *   orchestrator to flip green.
 *
 * Rerun posture: D1-only fixtures (the detail page never reads the
 * engine), every row existence-checked before insert, the one label-
 * attaching write is a replaceLabels diff (re-running converges on the
 * same set), and every other write either 403s/404s or is a documented
 * no-op on a merged/locked/archived row — reruns converge.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoLabel } from "../../api/services/labels";
import {
  comments,
  issueAssignees,
  issueLabels,
  issueSubscriptions,
  issues,
  milestones,
  pullRequests,
  pullReviews,
  repositories,
  users,
} from "../../db/schema";
import { CommentType, type CommentTypeValue } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv, T0 } from "../__tests__/harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's
 *  happy path — the router fixture origin). */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

/** The cross-origin write shape (the guard's 403 arm). */
const crossOriginPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures (D1-only: the detail page is a pure-D1 render) ----------------------

const OWNER_NAME = "mxissue-owner";
const BOB_NAME = "mxissue-bob";
const REPO_SLUG = "mxissue-lab";
const ARCHIVED_SLUG = "mxissue-arch";
/** The seeded merge event's sha (the event line pins its 10-char short form). */
const MERGE_SHA = "3bf1c8e2a0d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9";
/** w129 batch-10: the sidebar populate arm's milestone name (the fixture
 *  converges on it by repo+name, so the constant is the lookup key). */
const SIDEBAR_MILESTONE_NAME = "mx: sidebar milestone";

interface IssueDetailFixture {
  ownerCookie: string;
  bobCookie: string;
  labelId: number;
  /** #1 — the locked issue (the lock gate's target). */
  lockedIssueIndex: number;
  /** #2 — the open PR (the cross-origin review/labels target). */
  openPrIssueId: number;
  /** #3 — the merged PR (badge/meta/event/rider arms). */
  mergedPrIndex: number;
  /** #4 — the WIP-prefixed open PR (draft badge + merge-box WIP line). */
  wipPrIndex: number;
  /** #5 — the closed, labeled issue (badge glyph + admin label form). */
  closedIssueIndex: number;
}

let issueDetailFixture: IssueDetailFixture | null = null;

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

async function numCommentsOf(issueId: number): Promise<number> {
  const db = drizzle(env.DB);
  const row = await db.select({ num: issues.numComments }).from(issues).where(eq(issues.id, issueId)).get();
  return Number(row?.num ?? 0);
}

async function reviewCountOf(issueId: number): Promise<number> {
  const db = drizzle(env.DB);
  const rows = await db.select({ id: pullReviews.id }).from(pullReviews).where(eq(pullReviews.issueId, issueId)).all();
  return rows.length;
}

async function ensureIssueDetailFixtures(): Promise<IssueDetailFixture> {
  if (issueDetailFixture !== null) return issueDetailFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The principals: the repo owner and a plain outsider (no grant, no
  // posterhood — the reduced-grant arms).
  for (const principal of [
    { username: OWNER_NAME, isAdmin: false },
    { username: BOB_NAME, isAdmin: false },
  ]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, principal.username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: principal.username,
        usernameLower: principal.username,
        isAdmin: principal.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const owner = await db.select().from(users).where(eq(users.usernameLower, OWNER_NAME)).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, BOB_NAME)).get();
  if (owner === undefined || bob === undefined) throw new Error("issue-detail matrix identity rows missing");
  const ownerId = owner.id;

  // The live lab and the archived twin (both row-only — the detail page is
  // a pure-D1 render; the archived flip is the render-relevant bit).
  const service = new RepoService(env.DB);
  async function ensureRepo(slug: string): Promise<string> {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER_NAME), eq(repositories.slug, slug)))
      .get();
    return existing?.id ?? (await service.create({ owner: { id: ownerId, usernameLower: OWNER_NAME }, name: slug, isPrivate: false, status: "ready" })).id;
  }
  const labRepoId = await ensureRepo(REPO_SLUG);
  const archivedRepoId = await ensureRepo(ARCHIVED_SLUG);
  const archivedRow = await db.select({ isArchived: repositories.isArchived }).from(repositories).where(eq(repositories.id, archivedRepoId)).get();
  if (archivedRow !== undefined && !archivedRow.isArchived) {
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, archivedRepoId));
  }

  // The D1 issue block (existence-checked as one unit, the wave-2 posture:
  // any issue row in the lab skips the whole seed).
  const svc = new IssuesService(env.DB);
  const existingIssue = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, labRepoId)).limit(1).get();
  let labelId: number;
  let openPrIssueId: number;
  let mergedPrIndex: number;
  let wipPrIndex: number;
  let closedIssueIndex: number;
  const lockedIssueIndex = 1;
  if (existingIssue === undefined) {
    const label = await createRepoLabel(env.DB, labRepoId, {
      name: "mxbug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: t(0),
    });
    labelId = label.id;

    // #1: the LOCKED issue (no suite seeds is_locked — the gate arms below).
    const locked = await svc.createIssue({ repoId: labRepoId, title: "mx: locked gate", posterId: owner.id, now: t(10) });
    await db.update(issues).set({ isLocked: true }).where(eq(issues.id, locked.id));

    // #2: the open PR — the cross-origin review/labels target.
    const openPr = await svc.createPullRequest({
      repoId: labRepoId,
      title: "mx: open pull",
      posterId: owner.id,
      headRepoId: labRepoId,
      baseBranch: "main",
      headBranch: "mx-head",
      now: t(20),
    });
    openPrIssueId = openPr.issue.id;

    // #3: the MERGED PR — the merged badge/meta/event/rider arms. The cached
    // merged flag rides the same columns the landed merge writes (wave 5's
    // direct-update posture), and the MergePull timeline event carries the
    // merge sha the event line shortens.
    const merged = await svc.createPullRequest({
      repoId: labRepoId,
      title: "mx: merged pull",
      posterId: owner.id,
      headRepoId: labRepoId,
      baseBranch: "main",
      headBranch: "mx-done",
      now: t(30),
    });
    mergedPrIndex = merged.issue.index;
    await db
      .update(pullRequests)
      .set({ hasMerged: true, mergedAt: t(880), mergerId: owner.id })
      .where(eq(pullRequests.issueId, merged.issue.id));
    const mergeEvent = await svc.addComment({
      issueId: merged.issue.id,
      posterId: owner.id,
      content: "",
      type: CommentType.MergePull,
      now: t(890),
    });
    await db.update(comments).set({ commitSha: MERGE_SHA }).where(eq(comments.id, mergeEvent.id));

    // #4: the WIP-prefixed open PR — the draft badge + the merge-box WIP line.
    const wip = await svc.createPullRequest({
      repoId: labRepoId,
      title: "WIP: mx draft",
      posterId: owner.id,
      headRepoId: labRepoId,
      baseBranch: "main",
      headBranch: "mx-wip",
      now: t(40),
    });
    wipPrIndex = wip.issue.index;

    // #5: the closed, labeled issue — the closed badge glyph pair, the
    // reopen button's degraded icon and the admin label form's checked box.
    const closed = await svc.createIssue({
      repoId: labRepoId,
      title: "mx: closed issue",
      posterId: owner.id,
      labelIds: [label.id],
      now: t(50),
    });
    closedIssueIndex = closed.index;
    await svc.closeIssue(closed.id, { actorId: owner.id, now: t(60) });

    // w129 batch-10 (wave-polish-matrix-10): the sidebar's MILESTONE
    // populate arm and the assignee-absence differential need rows no suite
    // had seeded on this repo — one milestone bound to the closed issue and
    // one issue_assignees edge on the open PR (the direct-update posture the
    // locked flag above uses; the upstream sidebar writes that would attach
    // these stay unclaimed, the 404 pin in "the sidebar write arms").
    const sidebarMilestone = await svc.createMilestone({
      repoId: labRepoId,
      name: SIDEBAR_MILESTONE_NAME,
      now: t(55),
    });
    await db.update(issues).set({ milestoneId: sidebarMilestone.id }).where(eq(issues.id, closed.id));
    await db.insert(issueAssignees).values({ issueId: openPr.issue.id, assigneeId: bob.id }).onConflictDoNothing();
  } else {
    // Rehydrate (the seeded block never mutates after landing except the
    // converging labels diff below): the label id rides the first
    // issue_labels row in the repo, the PR indexes off the seeded titles.
    const repoLabels = await db
      .select({ id: issueLabels.labelId })
      .from(issueLabels)
      .innerJoin(issues, eq(issues.id, issueLabels.issueId))
      .where(eq(issues.repoId, labRepoId))
      .all();
    if (repoLabels.length === 0) throw new Error("issue-detail matrix labels missing on rehydrate");
    labelId = repoLabels[0]!.id;
    const prRows = await db
      .select({ issueId: issues.id, index: issues.index, title: issues.title })
      .from(issues)
      .where(and(eq(issues.repoId, labRepoId), eq(issues.isPull, true)))
      .all();
    const open = prRows.find((row) => row.title === "mx: open pull");
    const merged = prRows.find((row) => row.title === "mx: merged pull");
    const wip = prRows.find((row) => row.title === "WIP: mx draft");
    const closed = await db
      .select({ index: issues.index })
      .from(issues)
      .where(and(eq(issues.repoId, labRepoId), eq(issues.title, "mx: closed issue")))
      .get();
    if (open === undefined || merged === undefined || wip === undefined || closed === undefined) {
      throw new Error("issue-detail matrix rows missing on rehydrate");
    }
    openPrIssueId = open.issueId;
    mergedPrIndex = merged.index;
    wipPrIndex = wip.index;
    closedIssueIndex = closed.index;

    // w129 batch-10 convergence: the sidebar milestone + assignee rows (a
    // pre-batch tree rehydrates without them — converge, never duplicate).
    const existingMilestone = await db
      .select({ id: milestones.id })
      .from(milestones)
      .where(and(eq(milestones.repoId, labRepoId), eq(milestones.name, SIDEBAR_MILESTONE_NAME)))
      .get();
    const sidebarMilestoneId =
      existingMilestone?.id ??
      (await svc.createMilestone({ repoId: labRepoId, name: SIDEBAR_MILESTONE_NAME, now: t(55) })).id;
    const closedRowFull = await db
      .select({ id: issues.id, milestoneId: issues.milestoneId })
      .from(issues)
      .where(and(eq(issues.repoId, labRepoId), eq(issues.title, "mx: closed issue")))
      .get();
    if (closedRowFull === undefined) throw new Error("issue-detail matrix closed issue missing on rehydrate");
    if (closedRowFull.milestoneId === null) {
      await db.update(issues).set({ milestoneId: sidebarMilestoneId }).where(eq(issues.id, closedRowFull.id));
    }
    const assigneeEdge = await db
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(and(eq(issueAssignees.issueId, open.issueId), eq(issueAssignees.assigneeId, bob.id)))
      .get();
    if (assigneeEdge === undefined) {
      await db.insert(issueAssignees).values({ issueId: open.issueId, assigneeId: bob.id }).onConflictDoNothing();
    }
  }

  // The archived twin: one issue + one PR so both nocomment message arms
  // have rows (creation order fixes the indexes).
  const existingArchived = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, archivedRepoId)).limit(1).get();
  if (existingArchived === undefined) {
    await svc.createIssue({ repoId: archivedRepoId, title: "mx: archived issue", posterId: owner.id, now: t(70) });
    await svc.createPullRequest({
      repoId: archivedRepoId,
      title: "mx: archived pull",
      posterId: owner.id,
      headRepoId: archivedRepoId,
      baseBranch: "main",
      headBranch: "mx-arch",
      now: t(80),
    });
  }

  issueDetailFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    bobCookie: await mintSession(env.DB, bob.id),
    labelId,
    lockedIssueIndex,
    openPrIssueId,
    mergedPrIndex,
    wipPrIndex,
    closedIssueIndex,
  };
  return issueDetailFixture;
}

beforeAll(async () => {
  await ensureIssueDetailFixtures();
});

// --- the §2.8 cross-origin 403s the earlier waves left unpinned --------------------

describe("cross-origin 403s on the unpinned comment/review POSTs", () => {
  it("the pulls-family comment POST 403s with a valid cookie and writes nothing; the cookie-less POST 403s before the anonymous login 303 (wave 5 pinned the issues twin only)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const before = await numCommentsOf(fixture.openPrIssueId);
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/2/comments`,
      crossOriginPost({ content: "evil comment" }, fixture.ownerCookie),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await numCommentsOf(fixture.openPrIssueId)).toBe(before);

    // The guard fronts reqSignIn on the pulls family too: no cookie, no 303.
    const anon = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/2/comments`, crossOriginPost({ content: "evil comment" }));
    expect(anon.status).toBe(403);
    expect(await anon.text()).toContain("cross-origin request rejected");
  });

  it("the three review POSTs 403 cross-origin even with a valid cookie — no verdict, no request row, no dismissal (wave 11 pinned their other arms, never the guard)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const verdictsBefore = await reviewCountOf(fixture.openPrIssueId);
    const commentsBefore = await numCommentsOf(fixture.openPrIssueId);

    const verdict = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/2/files/reviews/submit`,
      crossOriginPost({ type: "comment", content: "evil verdict" }, fixture.ownerCookie),
    );
    expect(verdict.status).toBe(403);
    expect(await verdict.text()).toContain("cross-origin request rejected");

    const request = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/issues/request_review`,
      crossOriginPost({ issue_ids: String(fixture.openPrIssueId), reviewer: BOB_NAME }, fixture.ownerCookie),
    );
    expect(request.status).toBe(403);

    const dismiss = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/issues/dismiss_review`,
      crossOriginPost({ review_id: "1", message: "evil" }, fixture.ownerCookie),
    );
    expect(dismiss.status).toBe(403);

    expect(await reviewCountOf(fixture.openPrIssueId)).toBe(verdictsBefore);
    expect(await numCommentsOf(fixture.openPrIssueId)).toBe(commentsBefore);
  });
});

// --- the comment arms' remaining gates: the LOCKED issue and the ARCHIVED repo -----

describe("the locked issue (no suite seeds is_locked — the gate is unpinned end to end)", () => {
  it("a non-state-capable viewer gets the page without any comment form (upstream renders nothing in the comment area either)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.bobCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>mx: locked gate");
    expect(html).not.toContain('id="comment-form"');
    expect(html).not.toContain('id="status-button"');
    // The GET arm renders no message (upstream's else-if chain falls through
    // to nothing for locked non-writers on a live repo — parity).
    expect(html).not.toContain("You cannot comment on a locked issue.");
  });

  it("a state-capable viewer (the owner) keeps the form AND the status toggle on a locked issue (upstream view_content.tmpl:74's disjunction)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="comment-form"');
    expect(html).toContain('id="status-button"');
  });

  it("ESCALATED RED: the locked-POST refusal must re-render at 200 with the landed message (issueCommentSubmit's own re-render convention; upstream MustAllowUserComment flashes issue.go:80-92) — the showForm gate drops the computed message", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const lockedIssueId = await dbIssueId(fixture.lockedIssueIndex);
    const before = await numCommentsOf(lockedIssueId);
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}/comments`,
      withCookie(formPost({ content: "bob cannot comment" }), fixture.bobCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // The refusal happened (no write) — verified before the RED arm below.
    expect(await numCommentsOf(lockedIssueId)).toBe(before);
    expect(
      html,
      [
        "REAL BUG (escalated to the orchestrator — see the file header, arm 3):",
        `POST /${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}/comments as a locked,`,
        "non-state-capable viewer answered a 200 re-render WITHOUT the refusal message —",
        "createCommentFromForm computes 'You cannot comment on a locked issue.' and the",
        "IssueDetailPage showForm gate (user && !archived && (!locked || canChangeState))",
        "gates the whole CommentFormBlock (which owns the message slot) off. The landed",
        "convention is the wave-5 empty-comment shape: 200 + '<div class=\"ui negative",
        "message\">…</div>' + kept draft. Fix in issue-detail.tsx (surface the error",
        "message even when the form controls stay gated).",
      ].join(" "),
    ).toContain("You cannot comment on a locked issue.");
  });
});

describe("the archived repo on the detail pages (no suite seeds an archived repo with issues)", () => {
  it("ESCALATED RED: a signed-in viewer on an archived repo must see the upstream no-comment message (view_content.tmpl:114-121 — the module header promises it) for BOTH families; nothing renders today", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const issueRes = await fetchUi(`/${OWNER_NAME}/${ARCHIVED_SLUG}/issues/1`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(issueRes.status).toBe(200);
    const issueHtml = await issueRes.text();
    // The form is gated off (that half holds) — verified before the RED arm.
    expect(issueHtml).not.toContain('id="comment-form"');
    expect(
      issueHtml,
      [
        "REAL BUG (escalated to the orchestrator — see the file header, arm 1):",
        `GET /${OWNER_NAME}/${ARCHIVED_SLUG}/issues/1 as a signed-in viewer renders NO`,
        "comment-area message — upstream view_content.tmpl:114-121 renders",
        "repo.archive.issue.nocomment for exactly this arm (signed-in + archived), the",
        "issue-detail.tsx header promises it, and the CommentFormBlock archived branch",
        "carries the exact markup — but the IssueDetailPage showForm gate",
        "(!repo.isArchived) makes the branch unreachable dead UI. Fix in issue-detail.tsx.",
      ].join(" "),
    ).toContain('<div class="ui warning message tw-text-center">This repo is archived. You cannot comment on issues.</div>');

    const pullRes = await fetchUi(`/${OWNER_NAME}/${ARCHIVED_SLUG}/pulls/2`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(pullRes.status).toBe(200);
    expect(
      await pullRes.text(),
      "the pull twin carries repo.archive.pull.nocomment upstream (view_content.tmpl:116-118)",
    ).toContain('<div class="ui warning message tw-text-center">This repo is archived. You cannot comment on pull requests.</div>');
  });

  it("ESCALATED RED: an ANONYMOUS viewer on an archived repo must see the archive message too (view_content.tmpl:123-133 — the sign-in warning is the non-archived arm) — the sign-in warning renders today", async () => {
    const res = await fetchUi(`/${OWNER_NAME}/${ARCHIVED_SLUG}/issues/1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(
      html,
      [
        "REAL BUG (escalated to the orchestrator — see the file header, arm 2):",
        `GET /${OWNER_NAME}/${ARCHIVED_SLUG}/issues/1 anonymous renders the sign-in`,
        "warning where upstream view_content.tmpl:124-133 renders the archive message",
        "for BOTH viewer kinds on an archived repo (the sign-in warning is the",
        "non-archived anonymous arm, :134). CommentFormBlock checks anonymous BEFORE",
        "archived. Fix in issue-detail.tsx (hoist the archived check).",
      ].join(" "),
    ).toContain('<div class="ui warning message tw-text-center">This repo is archived. You cannot comment on issues.</div>');
    expect(html).not.toContain("to join this conversation");
  });

  it("the archived POST refusal writes nothing and answers the landed 200 re-render (upstream's RepoMustNotBeArchived group answers 404 — the softer landed posture, pinned as-is)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const archivedIssue = await drizzle(env.DB)
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.repoId, await repoIdOf(ARCHIVED_SLUG)), eq(issues.index, 1)))
      .get();
    if (archivedIssue === undefined) throw new Error("archived issue row missing");
    const before = await numCommentsOf(archivedIssue.id);
    const res = await fetchUi(
      `/${OWNER_NAME}/${ARCHIVED_SLUG}/issues/1/comments`,
      withCookie(formPost({ content: "cannot land" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    expect(await numCommentsOf(archivedIssue.id)).toBe(before);
  });
});

// --- the sidebar write arms -----------------------------------------------------------

describe("the sidebar write arms", () => {
  it("the admin GET renders the no-JS label form: the hidden issue_ids, the current label pre-checked, Save (wave 5 pinned only the POST round-trip)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<form class="ui form" action="/${OWNER_NAME}/${REPO_SLUG}/issues/labels" method="post">`);
    expect(html).toMatch(/<input type="hidden" name="issue_ids" value="\d+"\/?>/);
    expect(html).toContain(`id="issue-label-${fixture.labelId}"`);
    expect(html).toContain(`<label for="issue-label-${fixture.labelId}">`);
    // The attached label's checkbox rides checked (the replaceLabels diff's
    // un-checked submit is the detach arm wave 5 pinned).
    expect(html).toMatch(new RegExp(`name="label_ids" type="checkbox" value="${fixture.labelId}" checked`));
    expect(html).toContain('class="ui tiny primary button"');
    expect(html).toContain(">Save</button>");
  });

  it("a signed-in non-admin gets no label form either (wave 5 pinned the anonymous arm only)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.bobCookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('name="label_ids"');
  });

  it("the labels POST onto a PR row 303s onto the PULLS canonical page (the family twin — wave 5 pinned the issues redirect only); the diff re-runs converge", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/issues/labels`,
      withCookie(formPost({ issue_ids: String(fixture.openPrIssueId), label_ids: String(fixture.labelId) }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER_NAME}/${REPO_SLUG}/pulls/2`);
  });

  it("a non-numeric issue_ids parse miss 404-shells (parseIssueLabelForm's null arm — wave 5 pinned the foreign-id miss only)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/issues/labels`,
      withCookie(formPost({ issue_ids: "not-a-number" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(404);
  });

  it("upstream's milestone/assignee/status sidebar write POSTs stay unclaimed (plain non-page 404 — the no-JS reduction's documented shape; web.go:1400-1404)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    for (const tail of ["milestone", "assignee", "status"]) {
      const res = await fetchUi(
        `/${OWNER_NAME}/${REPO_SLUG}/issues/${tail}`,
        withCookie(formPost({ issue_ids: String(fixture.openPrIssueId) }), fixture.ownerCookie),
      );
      expect(res.status, `POST /issues/${tail}`).toBe(404);
      expect(await res.text(), `POST /issues/${tail}`).not.toContain("page-content");
    }
  });
});

// --- w129 batch-10 additions (wave-polish-matrix-10): the sidebar's ?div-only ------
// shapes and the unlanded seams. The upstream sidebar's edit dropdowns are JS
// islands; the landed reduction keeps only the combo DIVS with their upstream
// data attributes (sidebar.tmpl's #label-list/#milestone-list shapes) — the
// arms below pin those shells, the milestone POPULATE arm (the suites had no
// bound milestone), and the three sections/upstream POST tails that stay
// unlanded (assignee, participants, the subscribe button's watch POST).

describe("the sidebar combo divs (w129 batch-10: the ?div-only edit fragments)", () => {
  it("the labels combo carries upstream's multiple/diff data shape on BOTH families, form or not", async () => {
    // Provenance: wave-polish-matrix-10. Wave 5 pinned the admin edit FORM's
    // internals; the combo DIV shell itself — sidebar.tmpl's
    // `data-selection-mode="multiple" data-update-algo="diff"` — was
    // unpinned, as was its presence on the PR twin and for a non-admin
    // viewer (labelOptions === null renders the div, never the form).
    const fixture = await ensureIssueDetailFixtures();
    for (const [path, family] of [
      [`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`, "issues"],
      [`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.wipPrIndex}`, "pulls"],
    ] as const) {
      const res = await fetchUi(path);
      expect(res.status, family).toBe(200);
      const html = await res.text();
      expect(html, family).toContain('<div class="issue-sidebar-combo" data-selection-mode="multiple" data-update-algo="diff">');
      // The combo outlives the admin grant: the anonymous viewer gets the
      // badge list inside the same div (and no edit form).
      expect(html, family).toContain('<div class="ui list labels-list">');
      expect(html, family).not.toContain('name="label_ids"');
    }
  });

  it("the milestone combo carries upstream's single/all data shape; the unbound arm renders the empty-list span", async () => {
    // Provenance: wave-polish-matrix-10 — wave 3 pinned "plain-text
    // milestone" prose but never the combo div's
    // `data-selection-mode="single" data-update-algo="all"` shell nor the
    // No-Milestone empty arm's exact span shape (sidebar.tmpl's
    // #milestone-list reduction).
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="issue-sidebar-combo" data-selection-mode="single" data-update-algo="all">');
    expect(html).toContain('<span class="item empty-list">No Milestone</span>');
    expect(html).not.toContain("octicon-milestone"); // nothing bound → no icon arm
  });

  it("the POPULATED milestone renders the octicon + name inside the single-mode combo, anchored to the live milestone page", async () => {
    // Provenance: wave-polish-matrix-10 (the populated arm itself) FLIPPED by
    // w129 batch-14 (the census's gap a1 + ca4eb58): batch-10 pinned the
    // no-link shape ("never a link — the §2.4.1 dead-link rule") while the
    // milestone detail page was absent; the page landed ui-parity-5
    // (ca4eb58) and pages/issue-detail.tsx now emits upstream's
    // milestone_list.tmpl:49 anchor, so the pin flips to the link shape.
    // The exact id is fixture-assigned (global autoincrement), so the href
    // prefix + the integer tail are matched, and the name span must sit
    // INSIDE the anchor.
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="issue-sidebar-combo" data-selection-mode="single" data-update-algo="all">');
    expect(html).toContain("octicon-milestone");
    const href = new RegExp(`<a class="item" href="/${OWNER_NAME}/${REPO_SLUG}/milestone/\\d+">`).exec(html);
    expect(href).not.toBeNull();
    // The name span rides inside the anchored item (upstream's flex shape).
    expect(html).toContain(
      `>${SIDEBAR_MILESTONE_NAME}</span></a>`,
    );
    expect(html.indexOf(href![0])).toBeLessThan(html.indexOf(`>${SIDEBAR_MILESTONE_NAME}</span></a>`));
    expect(html).not.toContain('<span class="item empty-list">No Milestone</span>'); // the empty arm yielded
  });

  it("the assignee/participant/subscribe sections render nothing — even with an assignee row bound (the unlanded seam, reported)", async () => {
    // Provenance: wave-polish-matrix-10. Upstream's sidebar carries
    // Assignees + Participants + a Subscribe button (sidebar.tmpl's
    // assignee_list/participant_list/watch block); this repo lands none of
    // them — and the arm proves the absence is the RENDER's posture, not
    // missing data: the fixture above binds a real issue_assignees edge to
    // the open PR, and the page still renders no assignee section. The
    // sections (and the subscribe button) are REPORTED unlanded, not built.
    const fixture = await ensureIssueDetailFixtures();
    for (const path of [
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.wipPrIndex}`, // same repo, live PR render
      `/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`,
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain("Assignees");
      expect(html, path).not.toContain("Participants");
      expect(html, path).not.toContain(">Subscribe<");
      expect(html, path).not.toContain(">Unsubscribe<");
    }
    // The bound edge exists (the differential's data half).
    const prIssueId = fixture.openPrIssueId;
    const edge = await drizzle(env.DB)
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(eq(issueAssignees.issueId, prIssueId))
      .all();
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });

  it("the subscribe seam's upstream POST tails stay unclaimed: /{issues,pulls}/{n}/watch 404 (web.go:1368) and issue_subscriptions is untouched", async () => {
    // Provenance: wave-polish-matrix-10. The subscribe button's write —
    // upstream `m.Post("/watch", repo.IssueWatch)` under BOTH the issues and
    // pulls groups (web.go:1368) — never landed; the sidebar-write 404 pin
    // above covers only the /issues/{tail} literal shapes. A valid
    // same-origin POST writes no issue_subscriptions row.
    const fixture = await ensureIssueDetailFixtures();
    for (const path of [
      `/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.openPrIssueId}/watch`,
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.openPrIssueId}/watch`,
    ]) {
      const res = await fetchUi(path, withCookie(formPost({}), fixture.ownerCookie));
      expect(res.status, `POST ${path}`).toBe(404);
      expect(await res.text(), `POST ${path}`).not.toContain("page-content");
    }
    expect(
      await drizzle(env.DB)
        .select({ id: issueSubscriptions.id })
        .from(issueSubscriptions)
        .where(eq(issueSubscriptions.issueId, fixture.openPrIssueId))
        .all(),
    ).toEqual([]);
  });
});

// --- the state machine through the DETAIL route ---------------------------------------

describe("the state machine through the detail route", () => {
  it("the WIP-prefixed open PR renders the grey DRAFT badge and the merge box's WIP line (the list matrix pins the row glyph — the page badge was unpinned)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.wipPrIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui grey label issue-state-label">');
    expect(html).toContain('class="svg octicon-git-pull-request-draft"');
    expect(html).toContain(" Draft</div>");
    // The merge box's WIP item — the full upstream card's
    // "repo.pulls.cannot_merge_work_in_progress" line (the wave-3 reduced
    // box's "no_merge_wip" sentence is retired with the webui-parity
    // top-drift 5 mount).
    expect(html).toContain("This pull request is marked as a work in progress.");
  });

  it("the MERGED PR renders the merger meta line and the merge EVENT line with the purple badge and the short sha (wave 5 pinned the purple badge alone)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.mergedPrIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The merged pull-desc: "{merger} merged <code>head</code> into <code>base</code>".
    expect(html).toContain(
      `<span id="pull-desc-display" class="pull-desc"><a class="tw-font-semibold" href="/${OWNER_NAME}">${OWNER_NAME}</a> merged <code>mx-done</code> into <code>main</code>`,
    );
    // The merge event: the purple badge, the git-merge glyph and the
    // upstream merged_commit fragment with the 10-char sha.
    expect(html).toContain('<span class="badge tw-bg-purple tw-text-white">');
    expect(html).toContain('class="svg octicon-git-merge"');
    expect(html).toContain(`merged commit <b>${MERGE_SHA.slice(0, 10)}</b> into <b>main</b>`);
    expect(html).toContain(`href="/${OWNER_NAME}">${OWNER_NAME}</a> merged commit`);
  });

  it("the closed ISSUE renders the red badge with the closed-issue glyph, and the reopen button degrades to the allowlisted issue-opened icon (the wave-5 header's documented degrade — unpinned)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const anon = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`);
    expect(anon.status).toBe(200);
    const html = await anon.text();
    expect(html).toContain('<div class="ui red label issue-state-label">');
    expect(html).toContain('class="svg octicon-issue-closed"');
    expect(html).toContain(" Closed</div>");

    const ownerRes = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    const ownerHtml = await ownerRes.text();
    expect(ownerHtml).toContain('<span class="status-button-icon tw-text-green">');
    expect(ownerHtml).toContain('class="svg octicon-issue-opened"');
    expect(ownerHtml).toContain('<span class="status-button-text">Reopen Issue</span>');
  });

  it("the status rider is a write-level no-op on a MERGED PR (the twin of wave 5's render pin): 303 canonical, state untouched, no comment row", async () => {
    const fixture = await ensureIssueDetailFixtures();
    const mergedIssue = await drizzle(env.DB)
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.repoId, await repoIdOf(REPO_SLUG)), eq(issues.index, fixture.mergedPrIndex)))
      .get();
    if (mergedIssue === undefined) throw new Error("merged PR row missing");
    const before = await numCommentsOf(mergedIssue.id);
    const res = await fetchUi(
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.mergedPrIndex}/comments`,
      withCookie(formPost({ content: "", status: "close" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.mergedPrIndex}`);
    expect(await numCommentsOf(mergedIssue.id)).toBe(before);
    const row = await drizzle(env.DB).select({ isClosed: issues.isClosed }).from(issues).where(eq(issues.id, mergedIssue.id)).get();
    expect(row?.isClosed).toBe(false);
  });
});

// --- the claim pins ---------------------------------------------------------------------

describe("claim pins (route-level answers the parse pins leave open)", () => {
  it("POST on the detail shapes themselves stays unclaimed (the GET-only surface posture, §2.1 — the same class as the intentional HEAD omission; upstream chi answers 405, the landed divergence)", async () => {
    for (const path of [`/${OWNER_NAME}/${REPO_SLUG}/issues/2`, `/${OWNER_NAME}/${REPO_SLUG}/pulls/2`]) {
      const res = await fetchUi(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
        body: new URLSearchParams({ title: "evil" }).toString(),
      });
      expect(res.status, `POST ${path}`).toBe(404);
      expect(await res.text(), `POST ${path}`).not.toContain("page-content");
    }
  });

  it("the upstream /{issues|pulls}/{index}/title edit tails stay engine-owned (plain non-page 404; web.go:1366)", async () => {
    const fixture = await ensureIssueDetailFixtures();
    for (const path of [
      `/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.lockedIssueIndex}/title`,
      `/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.mergedPrIndex}/title`,
    ]) {
      const res = await fetchUi(path, withCookie(formPost({ title: "evil rename" }), fixture.ownerCookie));
      expect(res.status, `POST ${path}`).toBe(404);
      expect(await res.text(), `POST ${path}`).not.toContain("page-content");
    }
    const row = await drizzle(env.DB)
      .select({ title: issues.title })
      .from(issues)
      .where(and(eq(issues.repoId, await repoIdOf(REPO_SLUG)), eq(issues.index, fixture.lockedIssueIndex)))
      .get();
    expect(row?.title).toBe("mx: locked gate"); // nothing touched
  });

  it("GET /pulls/{index}/comments answers chi's 405 (the pulls twin — wave 5 pinned the issues family only)", async () => {
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/2/comments`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

// --- helpers ------------------------------------------------------------------------------

/** A repo's id by slug (the fixtures hold slugs for stability). */
async function repoIdOf(slug: string): Promise<string> {
  const db = drizzle(env.DB);
  const row = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, slug)).get();
  if (row === undefined) throw new Error(`repo ${slug} not seeded`);
  return row.id;
}

/** An issue's row id by its per-repo index. */
async function dbIssueId(index: number): Promise<number> {
  const db = drizzle(env.DB);
  const row = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, await repoIdOf(REPO_SLUG)), eq(issues.index, index)))
    .get();
  if (row === undefined) throw new Error(`issue #${index} not seeded`);
  return row.id;
}

// --- w129 batch-13 additions (wave-polish-matrix-13): the timeline's event arms ------
// The loader renders exactly four comment types as timeline entries (Comment
// 0, Reopen 1, Close 2, MergePull 28 — loadIssueDetailData's filter); every
// other system-event row "stays unrendered" (the module header's documented
// posture, upstream comments.tmpl's unported arms). The suites above never
// SEED any of those rows, so the unrendered arms had no proof, and the
// reopened-PULL verb variant (`repo.pulls.reopened_at` — wave 3 pinned
// "reopened this issue" and "closed this pull request" only) plus the merge
// event's time-anchor anatomy rode unpinned. The arms below seed the rows
// directly (the addComment posture the merge event uses) and pin the render.

interface TimelineEventRows {
  lock: number;
  unlock: number;
  issueRef: number;
  commitRef: number;
  commentRef: number;
  pullRef: number;
  /** The reopen row ON THE WIP PR — the `reopened_pull` verb arm. */
  reopenPull: number;
  /** The PR-side review-event rows (22/27/32) — the review events render
   *  through the wave-11 SIDEBAR, never the timeline. */
  review: number;
  reviewRequest: number;
  dismissReview: number;
}

let timelineEventRows: TimelineEventRows | null = null;

/** Seed (once, per-type existence-checked so reruns converge) the unrendered
 *  system-event rows on the closed issue and the reopen row on the WIP PR. */
async function ensureTimelineEventRows(): Promise<TimelineEventRows> {
  if (timelineEventRows !== null) return timelineEventRows;
  const fixture = await ensureIssueDetailFixtures();
  const db = drizzle(env.DB);
  const svc = new IssuesService(env.DB);
  const closedId = await dbIssueId(fixture.closedIssueIndex);
  const wipId = await dbIssueId(fixture.wipPrIndex);
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER_NAME)).get();
  if (owner === undefined) throw new Error("timeline-event seed: owner row missing");
  const plan: Array<{
    key: keyof TimelineEventRows;
    issueId: number;
    type: CommentTypeValue;
    /** Upstream CrossReference rows carry the base64 references payload
     *  (models/issues/comments.go) — the render never reads it; kept
     *  realistic anyway. */
    content: string;
    offset: number;
  }> = [
    { key: "lock", issueId: closedId, type: CommentType.Lock, content: "", offset: 120 },
    { key: "unlock", issueId: closedId, type: CommentType.Unlock, content: "", offset: 130 },
    { key: "issueRef", issueId: closedId, type: CommentType.IssueRef, content: "b64:eyJSZWYiOiIxIiwiQWN0aW9uIjoxfQ==", offset: 140 },
    { key: "commitRef", issueId: closedId, type: CommentType.CommitRef, content: "b64: commit-ref payload", offset: 150 },
    { key: "commentRef", issueId: closedId, type: CommentType.CommentRef, content: "b64: comment-ref payload", offset: 160 },
    { key: "pullRef", issueId: closedId, type: CommentType.PullRef, content: "b64: pull-ref payload", offset: 170 },
    { key: "reopenPull", issueId: wipId, type: CommentType.Reopen, content: "", offset: 180 },
    { key: "review", issueId: wipId, type: CommentType.Review, content: "review body", offset: 190 },
    { key: "reviewRequest", issueId: wipId, type: CommentType.ReviewRequest, content: "b64: reviewer payload", offset: 200 },
    { key: "dismissReview", issueId: wipId, type: CommentType.DismissReview, content: "b64: dismissal payload", offset: 210 },
  ];
  const rows = {} as TimelineEventRows;
  for (const entry of plan) {
    const existing = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, entry.issueId), eq(comments.type, entry.type)))
      .get();
    if (existing !== undefined) {
      rows[entry.key] = existing.id;
      continue;
    }
    const created = await svc.addComment({
      issueId: entry.issueId,
      posterId: owner.id,
      content: entry.content,
      type: entry.type,
      now: t(entry.offset),
    });
    rows[entry.key] = created.id;
  }
  timelineEventRows = rows;
  return rows;
}

describe("the timeline's unrendered system-event arms (w129 batch-13)", () => {
  it("lock/unlock rows stay off the timeline (the unrendered reduction) while numComments still folds them into the meta count", async () => {
    // Provenance: wave-polish-matrix-13. loadIssueDetailData renders types
    // 0/1/2/28 only (the module header: "Every other system-event type stays
    // unrendered this wave"); no earlier suite SEEDS a Lock/Unlock row, so
    // the omission was unproven. The fold half pins the wave-3 note
    // ("numComments folds every system comment in") at the meta line: the
    // closed issue holds the close event (1) + lock + unlock + four refs = 7.
    const fixture = await ensureIssueDetailFixtures();
    const events = await ensureTimelineEventRows();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of [events.lock, events.unlock]) {
      expect(html).not.toContain(`id="event-${id}"`); // neither the event div nor its anchor
      expect(html).not.toContain(`id="issuecomment-${id}"`);
    }
    // The would-be verbs (upstream's repo.issues.lock/unlock list shapes)
    // render nowhere on the page.
    expect(html).not.toContain("locked this issue");
    expect(html).not.toContain("unlocked this issue");
    // The fold: 1 (the close event) + 2 (lock/unlock) + 4 (the refs) = 7.
    expect(html).toContain("· 7 comments");
  });

  it("cross-referenced rows (issue/commit/comment/pull refs) render no timeline items either", async () => {
    // Provenance: wave-polish-matrix-13. The four reference families
    // (CommentType 3/4/5/6 — the §2.2 cross-reference arms) are the other
    // landed-row-shape the suites never seed; the same unrendered posture
    // applies, pinned by row id and by the absence of upstream's verb.
    const fixture = await ensureIssueDetailFixtures();
    const events = await ensureTimelineEventRows();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/issues/${fixture.closedIssueIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of [events.issueRef, events.commitRef, events.commentRef, events.pullRef]) {
      expect(html).not.toContain(`id="event-${id}"`);
      expect(html).not.toContain(`id="issuecomment-${id}"`);
    }
    expect(html).not.toContain("referenced this issue");
    expect(html).not.toContain("mentioned this issue");
  });

  it("a PR's reopen event renders the reopened-PULL verb variant with the green badge and the dot glyph (the twin wave 3 never pinned)", async () => {
    // Provenance: wave-polish-matrix-13. Wave 3 pinned "reopened this
    // issue" (the issues variant) and "closed this pull request"; the
    // `reopened_pull` verb (`repo.pulls.reopened_at`) had no seeded row
    // anywhere. TimelineEvent's isPull branch picks it, with the
    // tw-bg-green badge and the octicon-dot-fill glyph (the reopen pair).
    const fixture = await ensureIssueDetailFixtures();
    const events = await ensureTimelineEventRows();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.wipPrIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `reopened this pull request <a id="event-${events.reopenPull}" href="#event-${events.reopenPull}"`,
    );
    expect(html).toContain(`href="/${OWNER_NAME}">${OWNER_NAME}</a> reopened this pull request`);
    expect(html).toContain('<div id="event-' + events.reopenPull + '" class="timeline-item event">');
    expect(html).toContain('<span class="badge tw-bg-green tw-text-white">');
    expect(html).toContain('class="svg octicon-dot-fill"');
    // The issues-variant verb must NOT render on the pulls page.
    expect(html).not.toContain("reopened this issue");
  });

  it("the review-event rows (review 22, review-request 27, dismiss 32) stay off the timeline — reviews render in the wave-11 sidebar instead", async () => {
    // Provenance: wave-polish-matrix-13. The landed review WRITE paths
    // (pages/pull-reviews.tsx) emit exactly these system comments (its
    // header: the type-22 review, the type-27 request pair, the type-32
    // dismissal) — but the timeline renders none of them: upstream's
    // comments.tmpl review-event arms are unported, and the visible review
    // anatomy lives in the Reviewers sidebar (wave 11's matrix). No suite
    // had seeded the rows, so the omission was unproven; the same row-id
    // proof as the lock/unlock and xref arms.
    const fixture = await ensureIssueDetailFixtures();
    const events = await ensureTimelineEventRows();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.wipPrIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of [events.review, events.reviewRequest, events.dismissReview]) {
      expect(html).not.toContain(`id="event-${id}"`);
      expect(html).not.toContain(`id="issuecomment-${id}"`);
    }
    // The would-be verbs (upstream's comments.tmpl review arms) render nowhere.
    expect(html).not.toContain("requested review from");
    expect(html).not.toContain("dismissed review");
    // The sidebar's review anatomy is unaffected by the stray rows (it
    // reads pull_reviews, not comments).
    expect(html).toContain("Reviewers");
  });

  it("the merge event's line carries the upstream #event time anchor (the anatomy the purple-badge pin left open)", async () => {
    // Provenance: wave-polish-matrix-13. The merged-PR arm above pins the
    // badge, the short sha and the merger link; the event line's time
    // anchor — comments.tmpl's `#event-{id}` + relative-time pair, the same
    // shape wave 3 pinned for close/reopen — was unpinned for the merge arm.
    const fixture = await ensureIssueDetailFixtures();
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/${fixture.mergedPrIndex}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const anchored = new RegExp(
      `merged commit <b>${MERGE_SHA.slice(0, 10)}</b> into <b>main</b> ` +
        `<a id="event-\\d+" href="#event-\\d+"><relative-time`,
    );
    expect(html).toMatch(anchored);
    // The event card keeps the id'd div + the purple badge.
    expect(html).toMatch(/<div id="event-\d+" class="timeline-item event"><span class="badge tw-bg-purple tw-text-white">/);
  });

  it("the pulls family's unknown-index miss 404-shells with the repo context kept (the wave-3 negative-path twin)", async () => {
    // Provenance: wave-polish-matrix-13. Wave 3 pinned the 404 shell on the
    // issues family only; the pulls family answers the same row-lookup-first
    // shell (the loadIssueDetailData null arm — §4.5), never a redirect.
    const res = await fetchUi(`/${OWNER_NAME}/${REPO_SLUG}/pulls/999`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain("repo-header");
  });
});
