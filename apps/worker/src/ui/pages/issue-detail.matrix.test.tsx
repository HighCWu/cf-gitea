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
 *     sidebar (label badges into the live filters, plain-text milestone),
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
  issueLabels,
  issues,
  pullRequests,
  pullReviews,
  repositories,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
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
    expect(html).toContain("This pull request cannot be merged because it is marked as being a work in progress.");
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
