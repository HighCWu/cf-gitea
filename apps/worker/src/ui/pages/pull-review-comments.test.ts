/**
 * The pull-review-comments module's test (the issue-content-fragments
 * smoke pattern): the module is UNMOUNTED — every handler is index-owned
 * (the module header carries the mount recipes + the handoff) — so the
 * tests drive the loaders, the write ports and the fragment builders
 * DIRECTLY on real D1 (workerd, @cloudflare/vitest-plugin) over a row-only
 * repo + a createPullRequest PR (no engine refs: the patch capture's
 * degenerate-range arm is the posture under test — null patches, the head
 * tip resolving "").
 *
 * - parseCodeCommentForm: the binding guards (the two Required arms, the
 *   In(timeline,diff) / In(previous,proposed) enums, the bool/int parses)
 *   and the signed-line convention (previous → negative).
 * - new_comment: the loader's 404 family (unknown index, non-pull row) +
 *   the pending-review branch of the fragment (one button vs two) and the
 *   upstream field set (the JS fills side/line/path — they render empty).
 * - the code-comment write: the pending arm (fresh PENDING row + the
 *   type-21 comment + the num_comments bump), the attach arm (a second
 *   comment joins the SAME pending review), the signed line (previous
 *   stores negative), the single-comment arm (submitReviewFromForm
 *   converts the pending row to a COMMENT review + the type-22 system
 *   comment) and the reply arm (ReviewExists gate, the reuse of the
 *   first comment's commitSha, no new pending row, no submit).
 * - resolve_conversation: the gate statuses (400 origin/action, 404
 *   unknown + foreign-repo, 400 non-PR, 403 non-marker) and the IDEMPOTENT
 *   resolve_doer_id flip through the SAME store the API pair writes (set →
 *   the doer id, clear → null, same-state rows untouched), then the
 *   reloaded conversation's resolved state + the flipped button label.
 * - the conversation read + fragment: the pending-review privacy filter
 *   (a pending review's comments are visible to its reviewer + site admin
 *   only — hidden from the public viewer), the outdated filter
 *   (invalidated rows ride showOutdated only), the created order, the
 *   markdown body render, the holder attrs (data-side left for a negative
 *   line) and the empty arm (the conversation_outdated fragment).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { comments, issues, pullReviews, repoCollaborators, repositories, users, ReviewType } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import type { RepositoryWithOwner } from "../../api/services/repository";
import {
  canMarkConversation,
  conversationFragmentHtml,
  conversationOutdatedFragmentHtml,
  createCodeCommentFromForm,
  loadConversationData,
  loadNewCodeCommentData,
  newCommentFragmentHtml,
  parseCodeCommentForm,
  parseResolveConversationForm,
  resolveConversationFromForm,
  type CodeCommentForm,
} from "./pull-review-comments";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_200_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";
const ANONYMOUS: Viewer = { kind: "anonymous" };

interface Seeded {
  repo: RepoRow;
  pair: RepositoryWithOwner;
  repoLink: string;
  issue: IssueRow;
  pr: PullRequestRow;
  ownerId: number;
  /** Write collaborator — the resolve/write predicate's collaborator arm. */
  coderId: number;
  /** Plain viewer — no rights on the repo. */
  viewerId: number;
  adminId: number;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  await applyAuthD1Migrations();
  const owner = await seedVerifiedUser({ username: "cmtowner" });
  const coder = await seedVerifiedUser({ username: "cmtcoder" });
  const viewer = await seedVerifiedUser({ username: "cmtviewer" });
  const admin = await seedVerifiedUser({ username: "cmtadmin", isAdmin: true });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cmtowner" },
    name: "cmtrepo",
    isPrivate: false,
    status: "ready",
  });
  const svc = new IssuesService(env.DB);
  const created = await svc.createPullRequest({
    repoId: repo.id,
    title: "cmt: the code-comment PR",
    content: "Seed PR for the code-comment conversation routes.",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "feature-line",
    now: at(10),
  });
  // coder is a WRITE collaborator (the resolve predicate's collaborator arm).
  await drizzle(env.DB)
    .insert(repoCollaborators)
    .values({ repoId: repo.id, userId: coder.id, mode: "write", createdAt: at(0), updatedAt: at(0) });
  const repoRow = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repo.id)).get();
  const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.id, owner.id)).get();
  if (repoRow === undefined || ownerRow === undefined) throw new Error("fixture rows missing");
  seeded = {
    repo: repoRow,
    pair: { repo: repoRow, owner: ownerRow },
    repoLink: `/${repoRow.ownerNamespace}/${repoRow.slug}`,
    issue: created.issue,
    pr: created.pullRequest,
    ownerId: owner.id,
    coderId: coder.id,
    viewerId: viewer.id,
    adminId: admin.id,
  };
  return seeded;
}

const user = (id: number, username: string, isAdmin = false): Viewer => ({ kind: "user", id, username, isAdmin });

/** Narrow the write result (the `created: false` arm is the unreachable
 *  defensive twin — the tests treat it as a failure). */
function createdId(result: Awaited<ReturnType<typeof createCodeCommentFromForm>>): number {
  if (!result.created) throw new Error("the code-comment write did not create");
  return result.commentId;
}

/** The module's request stub — emitIssueEvent reads executionCtx lazily
 *  (in-process callers settle inline), env carries the bindings. */
const requestStub = { env, executionCtx: { waitUntil: () => {} } };

async function commentRows(issueId: number) {
  return drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).orderBy(comments.id).all();
}

function codeForm(overrides: Partial<Record<string, unknown>>): CodeCommentForm {
  const form = parseCodeCommentForm(
    new URLSearchParams({
      origin: "diff",
      content: "the comment body",
      side: "proposed",
      line: "3",
      path: "src/app.ts",
      latest_commit_id: "1234567890abcdef1234567890abcdef12345678",
      ...(overrides as Record<string, string>),
    }),
  );
  if (form === null) throw new Error("fixture form failed to parse");
  return form;
}

beforeAll(async () => {
  await seed();
});

// --- the form parser -----------------------------------------------------------

describe("parseCodeCommentForm (the CodeCommentForm binding)", () => {
  it("parses the upstream field set", () => {
    const form = parseCodeCommentForm(
      new URLSearchParams({
        origin: "timeline",
        content: "hello",
        side: "previous",
        line: "7",
        path: "a/b.ts",
        single_review: "true",
        reply: "42",
        latest_commit_id: "cafe",
      }),
    );
    expect(form).toEqual({
      origin: "timeline",
      content: "hello",
      side: "previous",
      line: 7,
      path: "a/b.ts",
      singleReview: true,
      reply: 42,
      latestCommitId: "cafe",
    });
  });

  it("nulls the binding-error class (Required misses + the In() enums)", () => {
    expect(parseCodeCommentForm(new URLSearchParams("origin=diff&content=x&side=previous&path=p"))).not.toBeNull();
    expect(parseCodeCommentForm(new URLSearchParams("origin=elsewhere&content=x&side=previous&path=p"))).toBeNull();
    expect(parseCodeCommentForm(new URLSearchParams("origin=diff&content=&side=previous&path=p"))).toBeNull();
    expect(parseCodeCommentForm(new URLSearchParams("origin=diff&content=x&side=left&path=p"))).toBeNull();
    expect(parseCodeCommentForm(new URLSearchParams("origin=diff&content=x&side=previous&path="))).toBeNull();
  });

  it("parses the line/sign/bool edges (FormInt64 + StrToBool)", () => {
    const form = parseCodeCommentForm(new URLSearchParams("origin=diff&content=x&side=proposed&path=p"));
    expect(form?.line).toBe(0); // FormInt64: missing is 0
    expect(form?.singleReview).toBe(false);
    expect(form?.reply).toBe(0);
    const junk = parseCodeCommentForm(new URLSearchParams("origin=diff&content=x&side=proposed&path=p&line=junk"));
    expect(junk?.line).toBe(0);
  });

  it("parses the resolve form's plain reads", () => {
    expect(parseResolveConversationForm(new URLSearchParams("origin=diff&action=Resolve&comment_id=9"))).toEqual({
      origin: "diff",
      action: "Resolve",
      commentId: 9,
    });
    expect(parseResolveConversationForm(new URLSearchParams(""))).toEqual({ origin: "", action: "", commentId: 0 });
  });
});

// --- the new_comment fragment ---------------------------------------------------

describe("GET new_comment (RenderNewCodeCommentForm's loader + fragment)", () => {
  it("nulls the 404 family (unknown index, non-pull row)", async () => {
    const fx = await seed();
    const svc = new IssuesService(env.DB);
    const plain = await svc.createIssue({
      repoId: fx.repo.id,
      title: "a plain issue",
      content: "",
      posterId: fx.ownerId,
      now: at(30),
    });
    expect(await loadNewCodeCommentData(env, env.DB, fx.repo, 999, ANONYMOUS)).toBeNull();
    expect(await loadNewCodeCommentData(env, env.DB, fx.repo, plain.index, ANONYMOUS)).toBeNull();
  });

  it("renders the two-button form without a pending review, one-button with", async () => {
    const fx = await seed();
    const viewer = user(fx.ownerId, "cmtowner");
    const none = await loadNewCodeCommentData(env, env.DB, fx.repo, fx.issue.index, viewer);
    expect(none).not.toBeNull();
    expect(none!.hasPendingReview).toBe(false);
    expect(none!.afterCommitId).toBe(""); // no engine refs — the degenerate arm
    const html = newCommentFragmentHtml(none!, fx.repoLink);
    expect(html).toContain(`action="${fx.repoLink}/pulls/${fx.issue.index}/files/reviews/comments"`);
    expect(html).toContain('name="origin" value="diff"');
    expect(html).toContain(`name="latest_commit_id" value=""`);
    expect(html).toContain('name="side" value=""'); // the JS fills side/line/path
    expect(html).toContain('name="path" value=""');
    expect(html).toContain('name="diff_start_cid"');
    expect(html).toContain("<textarea"); // the plain-textarea reduction
    expect(html).toContain("Start review");
    expect(html).toContain("Add single comment");
    expect(html).toContain('name="single_review" value="true"');
    expect(html).toContain('data-global-click="onCancelCodeComment"');

    // A pending review flips the button set (comment_form.tmpl:35-40) —
    // the ADMIN carries it (the later tests count owner/coder rows).
    await drizzle(env.DB)
      .insert(pullReviews)
      .values({
        type: ReviewType.Pending,
        reviewerId: fx.adminId,
        issueId: fx.issue.id,
        content: "",
        createdAt: at(40),
        updatedAt: at(40),
      })
      .returning()
      .all();
    // The pending review belongs to the ADMIN — the loader consults ITS
    // viewer (GetCurrentReview is per-reviewer).
    const withPending = await loadNewCodeCommentData(env, env.DB, fx.repo, fx.issue.index, user(fx.adminId, "cmtadmin", true));
    expect(withPending!.hasPendingReview).toBe(true);
    const pendingHtml = newCommentFragmentHtml(withPending!, fx.repoLink);
    expect(pendingHtml).toContain("Add comment");
    expect(pendingHtml).not.toContain("Start review");
    expect(pendingHtml).not.toContain("Add single comment");
  });
});

// --- the code-comment write ------------------------------------------------------

describe("POST comments (CreateCodeComment's port)", () => {
  it("lands a pending-review code comment with the signed line, commit, bump", async () => {
    const fx = await seed();
    const before = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fx.issue.id)).get();
    const result = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({}),
    });
    expect(result.created).toBe(true);
    const rows = await commentRows(fx.issue.id);
    const codeRows = rows.filter((row) => row.type === CommentType.Code);
    expect(codeRows).toHaveLength(1);
    const row = codeRows[0]!;
    expect(row.line).toBe(3); // proposed side stores positive
    expect(row.treePath).toBe("src/app.ts");
    expect(row.content).toBe("the comment body");
    expect(row.commitSha).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(row.oldRef).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(row.patch).toBeNull(); // no engine refs — the degenerate range arm
    expect(row.posterId).toBe(fx.coderId);
    const pendingRows = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId), eq(pullReviews.type, ReviewType.Pending)))
      .all();
    expect(pendingRows).toHaveLength(1);
    expect(row.reviewId).toBe(pendingRows[0]!.id);
    expect(pendingRows[0]!.commitId).toBe("1234567890abcdef1234567890abcdef12345678");
    const after = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fx.issue.id)).get();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);

    // A second comment on the same line attaches to the SAME pending review
    // (GetCurrentReview's fold — no second row).
    await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ content: "second note" }),
    });
    const pendingAgain = await drizzle(env.DB)
      .select({ id: pullReviews.id })
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId), eq(pullReviews.type, ReviewType.Pending)))
      .all();
    expect(pendingAgain).toHaveLength(1);
    const rowsAgain = (await commentRows(fx.issue.id)).filter((row) => row.type === CommentType.Code);
    expect(rowsAgain).toHaveLength(2);
    expect(rowsAgain[1]!.reviewId).toBe(pendingRows[0]!.id);
  });

  it("stores the previous side negative (the signed-line convention)", async () => {
    const fx = await seed();
    const result = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ side: "previous", line: "12" }),
    });
    expect(result.created).toBe(true);
    const row = (await commentRows(fx.issue.id)).filter((r) => r.type === CommentType.Code).at(-1)!;
    expect(row.line).toBe(-12);
  });

  it("the single-comment arm submits the pending review as a COMMENT", async () => {
    const fx = await seed();
    const result = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ single_review: "true" }),
    });
    expect(result.created).toBe(true);
    // The pending row converted in place; the type-22 system comment landed.
    const reviewRows = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId)))
      .all();
    expect(reviewRows.some((row) => row.type === ReviewType.Comment)).toBe(true);
    const rows = await commentRows(fx.issue.id);
    expect(rows.some((row) => row.type === CommentType.Review && row.reviewId === reviewRows.find((r) => r.type === ReviewType.Comment)?.id)).toBe(
      true,
    );
  });

  it("the reply arm attaches to the posted review with the first comment's commit", async () => {
    const fx = await seed();
    // The first comment lands on a pending review (the pending arm).
    await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "5" }),
    });
    const pendingRow = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId), eq(pullReviews.type, ReviewType.Pending)))
      .get();
    expect(pendingRow).toBeDefined();

    // A DIFFERENT doer replies (single_review + reply=<review id>): the
    // ReviewExists gate holds (a code comment exists at the line), the
    // comment attaches to that review with the first comment's commitSha —
    // no new pending review, no submit.
    const reply = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.ownerId,
      form: codeForm({ single_review: "true", reply: String(pendingRow!.id), line: "5" }),
    });
    expect(reply.created).toBe(true);
    const rows = (await commentRows(fx.issue.id)).filter((row) => row.type === CommentType.Code);
    const replyRow = rows.at(-1)!;
    expect(replyRow.reviewId).toBe(pendingRow!.id);
    expect(replyRow.posterId).toBe(fx.ownerId);
    expect(replyRow.commitSha).toBe(rows[0]!.commitSha); // the reuse read
    const pendings = await drizzle(env.DB)
      .select({ id: pullReviews.id })
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId), eq(pullReviews.type, ReviewType.Pending)))
      .all();
    expect(pendings).toHaveLength(1); // no pending review created for the reply
    // And the reply arm never submits: no COMMENT review for the reply's doer.
    const ownerReviewsBefore = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.ownerId)))
      .all();
    expect(ownerReviewsBefore.some((row) => row.type === ReviewType.Comment)).toBe(false);

    // A reply whose line has NO code comment falls through to the pending
    // arm (ReviewExists false → the doer's pending review created, then
    // the single-comment submit CONVERTS it — the review ends a COMMENT
    // row carrying the code comment, upstream's own end state).
    const fallback = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.ownerId,
      form: codeForm({ single_review: "true", reply: String(pendingRow!.id), line: "77" }),
    });
    expect(fallback.created).toBe(true);
    const fallbackRow = (await commentRows(fx.issue.id)).filter((row) => row.type === CommentType.Code).at(-1)!;
    const ownerReviews = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.ownerId)))
      .all();
    expect(ownerReviews).toHaveLength(1); // created + converted, one row
    expect(ownerReviews[0]!.type).toBe(ReviewType.Comment);
    expect(fallbackRow.reviewId).toBe(ownerReviews[0]!.id);
    expect(fallbackRow.line).toBe(77);
  });
});

// --- the resolve toggle ------------------------------------------------------------

describe("POST resolve_conversation (UpdateResolveConversation's port)", () => {
  it("resolves, stays idempotent, then unresolves — through resolve_doer_id", async () => {
    const fx = await seed();
    const created = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "9", single_review: "true", content: "resolve me" }),
    });
    const target = (await commentRows(fx.issue.id)).find((row) => row.id === createdId(created))!;

    // The write collaborator resolves (the CanMarkConversation arm).
    const coder = user(fx.coderId, "cmtcoder");
    const resolve = await resolveConversationFromForm({
      env,
      d1: env.DB,
      repo: fx.repo,
      viewer: coder,
      urlOrigin: ORIGIN,
      form: { origin: "diff", action: "Resolve", commentId: target.id },
    });
    expect(resolve.ok).toBe(true);
    expect(resolve.ok && resolve.conversation?.resolved).toBe(true);
    expect(resolve.ok && resolve.conversation?.resolveDoerName).toBe("cmtcoder");
    const stored = await drizzle(env.DB).select().from(comments).where(eq(comments.id, target.id)).get();
    expect(stored?.resolveDoerId).toBe(fx.coderId);
    // The fragment flips the button (UnResolve + the upstream attrs).
    const html = conversationFragmentHtml(resolve.ok ? resolve.conversation! : null!, fx.repoLink);
    expect(html).toContain('class="ui icon tiny basic button resolve-conversation"');
    expect(html).toContain('data-action="UnResolve"');
    expect(html).toContain(`data-comment-id="${target.id}"`);
    expect(html).toContain(`data-update-url="${fx.repoLink}/issues/resolve_conversation"`);
    expect(html).toContain("Unresolve conversation");

    // Idempotent: a re-resolve leaves the row untouched (same value).
    const again = await resolveConversationFromForm({
      env,
      d1: env.DB,
      repo: fx.repo,
      viewer: coder,
      urlOrigin: ORIGIN,
      form: { origin: "diff", action: "Resolve", commentId: target.id },
    });
    expect(again.ok).toBe(true);
    const storedAgain = await drizzle(env.DB).select().from(comments).where(eq(comments.id, target.id)).get();
    expect(storedAgain?.resolveDoerId).toBe(fx.coderId);

    // Unresolve clears to null (the API pair's stored shape).
    const unresolve = await resolveConversationFromForm({
      env,
      d1: env.DB,
      repo: fx.repo,
      viewer: coder,
      urlOrigin: ORIGIN,
      form: { origin: "diff", action: "UnResolve", commentId: target.id },
    });
    expect(unresolve.ok).toBe(true);
    expect(unresolve.ok && unresolve.conversation?.resolved).toBe(false);
    const cleared = await drizzle(env.DB).select().from(comments).where(eq(comments.id, target.id)).get();
    expect(cleared?.resolveDoerId).toBeNull();
    const unresolvedHtml = conversationFragmentHtml(unresolve.ok ? unresolve.conversation! : null!, fx.repoLink);
    expect(unresolvedHtml).toContain('data-action="Resolve"');
    expect(unresolvedHtml).toContain("Resolve conversation");
  });

  it("maps the gate statuses (400 origin/action, 404 unknown, 400 non-PR, 403 non-marker)", async () => {
    const fx = await seed();
    const created = await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "11", content: "gate bait" }),
    });
    const coder = user(fx.coderId, "cmtcoder");
    const outsider = user(fx.viewerId, "cmtviewer");

    expect(
      await resolveConversationFromForm({
        env,
        d1: env.DB,
        repo: fx.repo,
        viewer: coder,
        urlOrigin: ORIGIN,
        form: { origin: "", action: "Resolve", commentId: createdId(created) },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await resolveConversationFromForm({
        env,
        d1: env.DB,
        repo: fx.repo,
        viewer: coder,
        urlOrigin: ORIGIN,
        form: { origin: "diff", action: "Close", commentId: createdId(created) },
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await resolveConversationFromForm({
        env,
        d1: env.DB,
        repo: fx.repo,
        viewer: coder,
        urlOrigin: ORIGIN,
        form: { origin: "diff", action: "Resolve", commentId: 0 },
      }),
    ).toMatchObject({ ok: false, status: 404 });

    // A plain issue's comment answers the non-PR 400 (the poster's own).
    const svc = new IssuesService(env.DB);
    const plain = await svc.createIssue({ repoId: fx.repo.id, title: "plain", content: "", posterId: fx.ownerId, now: at(50) });
    const plainComment = await svc.addComment({ issueId: plain.id, posterId: fx.ownerId, content: "not a pr" });
    expect(
      await resolveConversationFromForm({
        env,
        d1: env.DB,
        repo: fx.repo,
        viewer: user(fx.ownerId, "cmtowner"),
        urlOrigin: ORIGIN,
        form: { origin: "diff", action: "Resolve", commentId: plainComment.id },
      }),
    ).toMatchObject({ ok: false, status: 400 });

    // A rights-less viewer on a real PR comment 403s; the POSTER passes.
    expect(
      await resolveConversationFromForm({
        env,
        d1: env.DB,
        repo: fx.repo,
        viewer: outsider,
        urlOrigin: ORIGIN,
        form: { origin: "diff", action: "Resolve", commentId: createdId(created) },
      }),
    ).toMatchObject({ ok: false, status: 403 });
    const poster = user(fx.ownerId, "cmtowner");
    const posterResolve = await resolveConversationFromForm({
      env,
      d1: env.DB,
      repo: fx.repo,
      viewer: poster,
      urlOrigin: ORIGIN,
      form: { origin: "diff", action: "Resolve", commentId: createdId(created) },
    });
    expect(posterResolve.ok).toBe(true);
    // The site admin passes too (the predicate's admin arm).
    expect(
      await canMarkConversation(env.DB, fx.repo, fx.issue, user(fx.adminId, "cmtadmin", true)),
    ).toBe(true);
  });
});

// --- the conversation read + fragments ---------------------------------------------

describe("loadConversationData + the conversation fragments", () => {
  it("orders by creation, renders markdown bodies and the holder attrs", async () => {
    const fx = await seed();
    await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "20", content: "first **bold** note" }),
    });
    const pending = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fx.issue.id), eq(pullReviews.reviewerId, fx.coderId), eq(pullReviews.type, ReviewType.Pending)))
      .get();
    const data = await loadConversationData({
      env,
      d1: env.DB,
      repo: fx.repo,
      issue: fx.issue,
      treePath: "src/app.ts",
      line: 20,
      viewer: user(fx.coderId, "cmtcoder"),
      origin: "diff",
      urlOrigin: ORIGIN,
      showOutdated: false,
    });
    expect(data).not.toBeNull();
    expect(data!.comments).toHaveLength(1);
    expect(data!.comments[0]!.contentHtml).toContain("<strong>bold</strong>");
    expect(data!.line).toBe(20);
    expect(data!.canMark).toBe(true); // the doer's own pending review's comment — coder has write
    const html = conversationFragmentHtml(data!, fx.repoLink);
    expect(html).toContain('data-path="src/app.ts"');
    expect(html).toContain('data-side="right"');
    expect(html).toContain('data-idx="20"');
    expect(html).toContain(`id="issuecomment-${data!.firstCommentId}"`);
    expect(html).toContain('class="ui form comment-form"'); // the always-open reply form
    expect(html).toContain(`name="reply" value="${pending!.id}"`);
    expect(html).toContain('name="single_review" value="true"');
    expect(html).toContain('name="side" value="proposed"');
    expect(html).not.toContain("conversation-not-existing");

    // The previous side flips the holder's side attr (negative line).
    const leftData = await loadConversationData({
      env,
      d1: env.DB,
      repo: fx.repo,
      issue: fx.issue,
      treePath: "src/app.ts",
      line: -12,
      viewer: user(fx.coderId, "cmtcoder"),
      origin: "diff",
      urlOrigin: ORIGIN,
      showOutdated: false,
    });
    expect(leftData).not.toBeNull();
    expect(conversationFragmentHtml(leftData!, fx.repoLink)).toContain('data-side="left"');
  });

  it("hides pending-review comments from the public viewer; admins and the reviewer see them", async () => {
    const fx = await seed();
    await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "31", content: "pending-only draft" }),
    });
    const common = {
      env,
      d1: env.DB,
      repo: fx.repo,
      issue: fx.issue,
      treePath: "src/app.ts",
      line: 31,
      origin: "diff" as const,
      urlOrigin: ORIGIN,
      showOutdated: false,
    };
    // The public viewer: nothing visible → null (the outdated arm).
    expect(await loadConversationData({ ...common, viewer: ANONYMOUS })).toBeNull();
    // The reviewer sees their own pending thread.
    const own = await loadConversationData({ ...common, viewer: user(fx.coderId, "cmtcoder") });
    expect(own?.comments).toHaveLength(1);
    expect(own?.comments[0]!.reviewType).toBe(ReviewType.Pending);
    // The site admin overrides (the landed list arm's posture).
    const admin = await loadConversationData({ ...common, viewer: user(fx.adminId, "cmtadmin", true) });
    expect(admin?.comments).toHaveLength(1);
    // The reviewer's fragment renders no resolve button (pending review),
    // per conversation.tmpl:17's not-pending term.
    const html = conversationFragmentHtml(own!, fx.repoLink);
    expect(html).not.toContain("resolve-conversation");
    expect(html).toContain("Pending");
  });

  it("answers the outdated filter + the empty arm", async () => {
    const fx = await seed();
    // An INVALIDATED comment at a fresh line: hidden by default…
    await createCodeCommentFromForm({
      request: requestStub,
      origin: ORIGIN,
      env,
      d1: env.DB,
      pair: fx.pair,
      repo: fx.repo,
      issue: fx.issue,
      pr: fx.pr,
      doerId: fx.coderId,
      form: codeForm({ line: "44", content: "stale thread" }),
    });
    const row = (await commentRows(fx.issue.id)).filter((r) => r.type === CommentType.Code).at(-1)!;
    await drizzle(env.DB).update(comments).set({ invalidated: true }).where(eq(comments.id, row.id));
    const common = {
      env,
      d1: env.DB,
      repo: fx.repo,
      issue: fx.issue,
      treePath: "src/app.ts",
      line: 44,
      origin: "diff" as const,
      urlOrigin: ORIGIN,
    };
    expect(await loadConversationData({ ...common, viewer: user(fx.coderId, "cmtcoder"), showOutdated: false })).toBeNull();
    // …shown with showOutdated (the timeline origin forces it).
    const shown = await loadConversationData({
      ...common,
      viewer: user(fx.coderId, "cmtcoder"),
      origin: "timeline",
      showOutdated: true,
    });
    expect(shown?.comments).toHaveLength(1);
    expect(shown!.comments[0]!.invalidated).toBe(true);
    // The outdated fragment's exact segment.
    expect(conversationOutdatedFragmentHtml()).toContain("conversation-not-existing");
    expect(conversationOutdatedFragmentHtml()).toContain("Content has changed since this comment was made");
    // A line with no comments at all → null.
    expect(
      await loadConversationData({
        ...common,
        line: 999,
        viewer: user(fx.coderId, "cmtcoder"),
        showOutdated: false,
      }),
    ).toBeNull();
  });
});
