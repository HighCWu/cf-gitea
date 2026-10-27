/**
 * The comment-attachments fragment's seam suite (PORT-FIRST: the loader
 * arms — the visibility ladder, the comment-miss arm, the type gate, the
 * empty list — plus the wire arm; the route matrix rides the mount, the
 * module header's HANDOFF recipe).
 *
 * Fixture discipline (the issue-content-fragments D1-only pattern): the
 * module is UNMOUNTED — the loader and Response builder are driven
 * DIRECTLY on real D1 (workerd, @cloudflare/vitest-plugin) over a seeded
 * user/two repos/issue with comments across the HasAttachmentSupport type
 * arms and attachment rows on both the comment and the direct-issue
 * namespaces.
 *
 * Upstream citations (at the pin): web.go:1337/1342 (route + group gates),
 * issue_comment.go:150-161 (getRepoIssueComment) and :306-326
 * (GetCommentAttachments), models/issues/comment.go:1082-1093
 * (GetCommentWithRepoID's repo cross-check) and :188-196
 * (HasAttachmentSupport), models/repo/attachment.go:158-162
 * (GetAttachmentsByCommentID), services/convert/attachment.go:23-51
 * (ToAttachment, the WebAssetDownloadURL arm).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueAttachments, repositories } from "../../db/schema";
import {
  commentAttachmentsFragmentResponse,
  commentHasAttachmentSupport,
  loadCommentAttachmentsFragment,
  pathParamInt64,
} from "./comment-attachments-fragment";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_200_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";

interface Seeded {
  ownerId: number;
  repoId: string;
  otherRepoId: string;
  issueId: number;
  /** The plain comment (type 0) carrying two attachments. */
  fedCommentId: number;
  /** The plain comment with no attachments. */
  emptyCommentId: number;
  /** The system comment (Label, type 7) — the type gate's 500 arm. */
  labelCommentId: number;
  /** The DismissReview comment (type 32) — content support WITHOUT
   *  attachment support (the HasAttachmentSupport asymmetry). */
  dismissCommentId: number;
  /** The code-comment (type 21) and review (type 22) — the gate's pass arms. */
  codeCommentId: number;
  reviewCommentId: number;
  /** A comment of the OTHER repo — the foreign-repo id arm. */
  foreignCommentId: number;
  /** The direct-issue attachment row (comment_id = 0) that must stay out. */
  directAttachmentUuid: string;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const owner = await seedVerifiedUser({ username: "cattachowner" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cattachowner" },
    name: "cattachrepo",
    isPrivate: false,
    status: "ready",
  });
  const otherRepo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cattachowner" },
    name: "cattachother",
    isPrivate: false,
    status: "ready",
  });
  const svc = new IssuesService(env.DB);
  const issue = await svc.createIssue({
    repoId: repo.id,
    title: "comment attachments seam issue",
    content: "the body",
    posterId: owner.id,
    now: at(10),
  });

  const fed = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "has files", now: at(20) });
  const empty = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "no files", now: at(21) });
  const label = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "changed labels", type: CommentType.Label, now: at(22) });
  const dismiss = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "dismissed", type: CommentType.DismissReview, now: at(23) });
  const code = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "code comment", type: CommentType.Code, now: at(24) });
  const review = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "review", type: CommentType.Review, now: at(25) });

  // The OTHER repo's comment: the same GLOBAL-id namespace, out of scope.
  const otherIssue = await svc.createIssue({
    repoId: otherRepo.id,
    title: "foreign issue",
    content: "elsewhere",
    posterId: owner.id,
    now: at(30),
  });
  const foreign = await svc.addComment({ issueId: otherIssue.id, posterId: owner.id, content: "foreign", now: at(31) });

  // Two attachments on the fed comment, one DIRECT on the issue (comment_id
  // = 0 — must NOT ride the comment arm, attachment.go:158-162's predicate).
  await drizzle(env.DB).insert(issueAttachments).values([
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a1", issueId: issue.id, commentId: fed.id, uploaderId: owner.id, name: "spec-a.pdf", size: 2048, downloadCount: 7, createdAt: at(60) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a2", issueId: issue.id, commentId: fed.id, uploaderId: owner.id, name: "log-a.txt", size: 16, createdAt: at(61) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a9", issueId: issue.id, commentId: 0, uploaderId: owner.id, name: "direct.bin", size: 1, createdAt: at(62) },
  ]);

  seeded = {
    ownerId: owner.id,
    repoId: repo.id,
    otherRepoId: otherRepo.id,
    issueId: issue.id,
    fedCommentId: fed.id,
    emptyCommentId: empty.id,
    labelCommentId: label.id,
    dismissCommentId: dismiss.id,
    codeCommentId: code.id,
    reviewCommentId: review.id,
    foreignCommentId: foreign.id,
    directAttachmentUuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a9",
  };
  return seeded;
}

async function repoRow(repoId: string) {
  const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!;
  return row;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_attachments",
    "issue_content_history",
    "issue_labels",
    "labels",
    "issue_subscriptions",
    "comments",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the loader arms -------------------------------------------------------------

describe("loadCommentAttachmentsFragment (issue_comment.go:306-326)", () => {
  it("ok: the comment's attachments in pk order, the direct-issue attachment stays out", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.fedCommentId));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // GetAttachmentsByCommentID's predicate (attachment.go:158-162): ONLY
    // this comment's rows — the direct issue attachment (comment_id = 0)
    // and the sibling comments' rows stay out; pk order pinned.
    expect(outcome.attachments.map((row) => row.name)).toEqual(["spec-a.pdf", "log-a.txt"]);
    expect(outcome.attachments.some((row) => row.uuid === s.directAttachmentUuid)).toBe(false);
  });

  it("empty list: the ok outcome carries no rows and the wire arm marshals [] (never null)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.emptyCommentId));
    expect(outcome).toEqual({ kind: "ok", attachments: [] });

    // upstream's make([]*api.Attachment, 0) seed (issue_comment.go:318).
    const response = commentAttachmentsFragmentResponse(ORIGIN, outcome);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("[]");
  });

  it("comment-miss arm: a nonexistent id, a garbage id, and a negative id all fold to notFound", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);

    // The plain miss (ErrCommentNotExist → upstream ServerError, folded to
    // the 404 class — the tree-list/tree-view lookup-miss convention).
    const missing = await loadCommentAttachmentsFragment(env.DB, repo, "999999");
    expect(missing).toEqual({ kind: "notFound" });

    // PathParamInt64's garbage → 0 (base_path.go:35-38) → guaranteed miss.
    const garbage = await loadCommentAttachmentsFragment(env.DB, repo, "abc");
    expect(garbage).toEqual({ kind: "notFound" });

    const negative = await loadCommentAttachmentsFragment(env.DB, repo, "-5");
    expect(negative).toEqual({ kind: "notFound" });

    // The folded 404 renders the not-found shell the mount passes.
    const response = commentAttachmentsFragmentResponse(ORIGIN, missing, "<html>404 shell</html>");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<html>404 shell</html>");
  });

  it("visibility ladder: a foreign repo's comment id answers notFound (GetCommentWithRepoID's repo cross-check)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    // Same global id namespace, different repo — upstream's
    // `c.Issue.RepoID != repoID` arm (comment.go:1090-1092).
    const foreign = await loadCommentAttachmentsFragment(env.DB, repo, String(s.foreignCommentId));
    expect(foreign).toEqual({ kind: "notFound" });

    // The owning repo answers ok — the scope, not the id, decided.
    const otherRepo = await repoRow(s.otherRepoId);
    const owned = await loadCommentAttachmentsFragment(env.DB, otherRepo, String(s.foreignCommentId));
    expect(owned.kind).toBe("ok");
  });

  it("type gate: system comments 500; DismissReview is excluded; Code and Review pass", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);

    // Label (type 7) has no attachment support → upstream's ServerError
    // (issue_comment.go:312-316), kept upstream-faithful as the plain 500.
    const label = await loadCommentAttachmentsFragment(env.DB, repo, String(s.labelCommentId));
    expect(label).toEqual({ kind: "unsupportedType", commentType: CommentType.Label });
    const labelResponse = commentAttachmentsFragmentResponse(ORIGIN, label);
    expect(labelResponse.status).toBe(500);
    expect(await labelResponse.text()).toBe(
      `GetCommentAttachments: comment type ${CommentType.Label} does not support attachments`,
    );

    // The HasContentSupport/HasAttachmentSupport asymmetry
    // (comment.go:180-196): DismissReview has content support but NO
    // attachment support — it must 500 like the system comments.
    const dismiss = await loadCommentAttachmentsFragment(env.DB, repo, String(s.dismissCommentId));
    expect(dismiss).toEqual({ kind: "unsupportedType", commentType: CommentType.DismissReview });

    // The pass arms: Code (21) and Review (22) load (empty) lists.
    const code = await loadCommentAttachmentsFragment(env.DB, repo, String(s.codeCommentId));
    expect(code).toEqual({ kind: "ok", attachments: [] });
    const review = await loadCommentAttachmentsFragment(env.DB, repo, String(s.reviewCommentId));
    expect(review).toEqual({ kind: "ok", attachments: [] });
  });
});

// --- the wire arm ------------------------------------------------------------------

describe("commentAttachmentsFragmentResponse (issue_comment.go:318-325)", () => {
  it("the structs.Attachment wire shape over the ok rows (the ToAttachment twin)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.fedCommentId));
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);

    const response = commentAttachmentsFragmentResponse(ORIGIN, outcome);
    expect(response.status).toBe(200);
    // ctx.JSON's content-type + the web middleware's zero-option prod
    // Cache-Control (the fragments-family header set).
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    const payload = await response.json<Array<{ id: number; name: string; created_at: string; download_count: number; size: number; uuid: string; browser_download_url: string }>>();
    expect(payload).toHaveLength(2);
    expect(payload[0]).toEqual({
      id: outcome.attachments[0]?.id,
      name: "spec-a.pdf",
      created_at: at(60).toISOString(),
      download_count: 7,
      size: 2048,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a1",
      browser_download_url: `${ORIGIN}/attachments/aaaaaaaa-bbbb-cccc-dddd-0000000000a1`,
    });
  });
});

// --- the parse + gate pins ---------------------------------------------------------

describe("pathParamInt64 + commentHasAttachmentSupport pins", () => {
  it("pathParamInt64: the PathParamInt64 port (garbage → 0, negatives pass, unsafe magnitudes → 0)", () => {
    expect(pathParamInt64("123")).toBe(123);
    expect(pathParamInt64("-5")).toBe(-5);
    expect(pathParamInt64("abc")).toBe(0);
    expect(pathParamInt64("")).toBe(0);
    expect(pathParamInt64("12abc")).toBe(0);
    expect(pathParamInt64("+5")).toBe(0); // the landed pathId twin's convention
    expect(pathParamInt64("99999999999999999999")).toBe(0); // not a safe integer
  });

  it("commentHasAttachmentSupport: exactly Comment/Code/Review (comment.go:188-196)", () => {
    expect(commentHasAttachmentSupport(CommentType.Comment)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.Code)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.Review)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.DismissReview)).toBe(false);
    expect(commentHasAttachmentSupport(CommentType.Reopen)).toBe(false);
    expect(commentHasAttachmentSupport(CommentType.Label)).toBe(false);
  });
});
