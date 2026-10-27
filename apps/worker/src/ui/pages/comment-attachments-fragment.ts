/**
 * The comment-attachments fragment — census class-(a) slice 1, upstream
 * (web.go:1337 at the pin, inside the `/{username}/{reponame}` group whose
 * gates are `optSignIn + context.RepoAssignment +
 * reqRepoIssuesOrPullsReader` — web.go:1342, the reader being
 * `RequireUnitReader(TypeIssues, TypePullRequests)`, web.go:922):
 *
 *   GET /{username}/{reponame}/comments/{id}/attachments   repo.GetCommentAttachments
 *
 * VERIFIED AT THE PIN: this is NOT an HTML template — the handler answers a
 * JSON array of `structs.Attachment`, the same wire shape the issue arm of
 * the fragments family serves (pages/issue-content-fragments.ts arm 2); the
 * official bundle fetches it around an issue/PR page for the comment
 * attachment rows it just edited (web_src/js(repo-editor) attachments
 * dropzone). The sibling per-issue arms live in issue-content-fragments.ts;
 * THIS route is repo-level (no `{type}/{index}` prefix — upstream groups it
 * with labels/milestones, web.go:1336-1342), so it does NOT ride the
 * issues/pulls tail parse.
 *
 * ## The handler arm-by-arm (routers/web/repo/issue_comment.go:306-326)
 *
 * 1. LOOKUP — `getRepoIssueComment` (:150-161): `GetCommentWithRepoID`
 *    (models/issues/comment.go:1082-1093) resolves the GLOBAL comment id
 *    and cross-checks `Issue.RepoID == repoID` — a nonexistent id AND a
 *    foreign repo's id are the SAME `ErrCommentNotExist`. Upstream feeds
 *    ANY error to `ctx.ServerError` (the 500 page — even the plain miss;
 *    the API twin of this lookup answers 404, issue_comment_attachment.go).
 *    The landed lookup-miss convention (pages/tree-list-aux.ts /
 *    tree-view-aux.ts: upstream's NotFound/ServerError lookup pair both
 *    answered 404) folds this arm into `{ kind: "notFound" }` — the one
 *    deliberate divergence of this module, disclosed here.
 * 2. VISIBILITY — `!CanReadIssuesOrPulls(comment.Issue.IsPull)` → 404
 *    (models/perm/access/repo_permission.go:145). Our fold: the comment was
 *    resolved THROUGH this repo (the repo-scope join in
 *    `findRepoCommentById`, the landed API-family answer to the same
 *    ladder), and the unit-reader gates have no landed unit-toggle
 *    consumer — the group's gate reduces to the mount's repo-visibility
 *    grant (the aux siblings' convention, issue-content-fragments.ts
 *    header). So this arm collapses into the repo-scope miss of step 1.
 * 3. TYPE GATE — `!comment.Type.HasAttachmentSupport()` →
 *    `ctx.ServerError` 500 (models/issues/comment.go:188-196 — Comment 0,
 *    Code 21, Review 22; deliberately NOT DismissReview 32, unlike
 *    HasContentSupport). Kept upstream-faithful as the plain-500 outcome
 *    (the release-downloads.ts posture — a deterministic ServerError class
 *    is never fabricated into a 4xx).
 * 4. LOAD — `comment.LoadAttachments` → `GetAttachmentsByCommentID`
 *    (models/repo/attachment.go:158-162): `WHERE comment_id = ?`, no ORDER
 *    BY (xorm emits pk order on SQLite; ours pins `id ASC`, the family
 *    convention).
 * 5. WIRE — `convert.ToAttachment` (services/convert/attachment.go:23-51,
 *    the WebAssetDownloadURL arm: `/attachments/{uuid}`) over the array,
 *    `ctx.JSON(http.StatusOK, attachments)` — the `make(…, 0)` seed
 *    marshals an empty list as `[]`, never null.
 *
 * The wire shape is the landed `toApiAttachment` twin
 * (routes/issue-attachments.ts:618-630, module-private) re-declared
 * byte-identical: the attachments-twin re-declaration convention
 * (issue-content-fragments.ts:54-56).
 *
 * ## The mount recipe (HANDOFF — this module is UNMOUNTED, index-owned)
 *
 * The repo tail parse owns the claim (ui/index.ts's repo dispatcher, where
 * the `activity_author_data` aux heads live): the `comments` head is
 * currently UNCLAIMED (the only landed `comments` arm is the issue-level
 * comment-write POST under `{type}/{index}`, index.ts:3166 — a different
 * namespace), so `GET …/comments/{anything}` hits the engine's 404 until
 * the mount lands.
 *
 * - `head === "comments" && rest.length === 2 && rest[1] ===
 *   "attachments"` → extend the `IssueAuxRoute` family union with
 *   `"comment-attachments"` (the raw id rides the union's `segment`
 *   field), resolve the dispatcher's `RepoRow`, then
 *   `loadCommentAttachmentsFragment(d1, repoRow, segment)` +
 *   `commentAttachmentsFragmentResponse(origin, outcome,
 *   renderNotFound(ctx))`.
 *   GET only; every other method stays unclaimed (upstream registers GET
 *   only — a POST hits chi's 405 there and the engine's 404 here).
 * - Group gates ride the mount (the aux convention): `optSignIn` → the
 *   mount's anonymous-allowed visibility grant (resolveUiRequest's),
 *   `reqRepoIssuesOrPullsReader` → no landed unit-toggle consumer (the
 *   family note above), `RepoAssignment` → the resolved `RepoRow`.
 * - The id parse rides the loader (`pathParamInt64`, the landed
 *   PathParamInt64 port — garbage → 0 → guaranteed miss), so the mount
 *   passes the RAW segment; do not pre-parse.
 */

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findRepoCommentById } from "../../api/services/issues";
import { issueAttachments } from "../../db/schema";
import type { RepoRow } from "../ui-context";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The attachment row shape (`issue_attachments`, the split store's
 *  comment half — SPEC-0005 §3.3). */
type IssueAttachmentRow = typeof issueAttachments.$inferSelect;

/**
 * The loader outcome: `notFound` is the folded lookup arm (the module
 * header's step 1-2 — the miss, the foreign-repo id, and the garbage-id
 * parse are ONE outcome; the mount renders the 404 shell),
 * `unsupportedType` is upstream's deterministic 500 (step 3), `ok` the
 * JSON-200 array payload (possibly empty — `[]`, never null).
 */
export type CommentAttachmentsFragmentOutcome =
  | { readonly kind: "ok"; readonly attachments: IssueAttachmentRow[] }
  | { readonly kind: "notFound" }
  | { readonly kind: "unsupportedType"; readonly commentType: number };

/** ctx.JSON's content-type (services/context/base.go:114-116) plus the web
 *  middleware's zero-option prod Cache-Control (the issues-search-aux
 *  sibling's exact header set). */
function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
  };
}

// ---------------------------------------------------------------------------
// The parse + type gate
// ---------------------------------------------------------------------------

/**
 * Go `PathParamInt64` (services/context/base_path.go:35-38): ParseInt with
 * the error discarded — garbage becomes 0, a guaranteed lookup miss. The
 * sign convention is the landed `pathId` twin
 * (routes/issue-attachments.ts:212-217): an optional leading `-` passes,
 * `+` does not (upstream's ParseInt would take "+5"; the twin's convention
 * is kept — a path segment with a raw "+" is pathological).
 */
export function pathParamInt64(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * `CommentType.HasAttachmentSupport` (models/issues/comment.go:188-196):
 * the plain comment, the code-comment, and the review — deliberately NOT
 * DismissReview (32), which HAS content support but no attachment support
 * (the :180 HasContentSupport asymmetry). The raw column is a plain
 * integer; the membership check needs no narrowing.
 */
export function commentHasAttachmentSupport(type: number): boolean {
  return type === 0 /* CommentType.Comment */ || type === 21 /* CommentType.Code */ || type === 22 /* CommentType.Review */;
}

// ---------------------------------------------------------------------------
// The loader (issue_comment.go:306-326's arms 1-4)
// ---------------------------------------------------------------------------

/**
 * The comment-attachments loader: the global-id comment scoped through
 * this repo (`findRepoCommentById` — the `GetCommentWithRepoID` fold:
 * nonexistent id, foreign-repo id, and the garbage-id parse all land in
 * `notFound`), the HasAttachmentSupport gate, then the comment's
 * attachments in pk order.
 */
export async function loadCommentAttachmentsFragment(
  d1: D1Database,
  repo: RepoRow,
  rawId: string,
): Promise<CommentAttachmentsFragmentOutcome> {
  const commentId = pathParamInt64(rawId);
  const target = await findRepoCommentById(d1, repo.id, commentId);
  if (target === null) return { kind: "notFound" };

  if (!commentHasAttachmentSupport(target.comment.type)) {
    return { kind: "unsupportedType", commentType: target.comment.type };
  }

  const attachments = await drizzle(d1)
    .select()
    .from(issueAttachments)
    .where(eq(issueAttachments.commentId, target.comment.id))
    .orderBy(asc(issueAttachments.id))
    .all();
  return { kind: "ok", attachments };
}

// ---------------------------------------------------------------------------
// The wire arm (issue_comment.go:318-325)
// ---------------------------------------------------------------------------

/**
 * `convert.ToAttachment` (services/convert/attachment.go:23-51, the
 * WebAssetDownloadURL arm) — the landed `toApiAttachment`
 * (routes/issue-attachments.ts:618-630) re-declared byte-identical: that
 * twin is module-private to the API route file, and this fragment serves
 * the SAME structs.Attachment JSON (id/name/created_at/download_count/
 * size/uuid/browser_download_url — no omitempty on the numbers,
 * CreatedAt's zero value degrades to a missing key exactly as the twin's
 * undefined does).
 */
function toApiAttachment(origin: string, row: IssueAttachmentRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt === null || row.createdAt === undefined ? undefined : row.createdAt.toISOString(),
    download_count: row.downloadCount,
    size: row.size,
    uuid: row.uuid,
    browser_download_url: `${origin}/attachments/${encodeURIComponent(row.uuid)}`,
  };
}

/**
 * The wire arm: `ctx.JSON(http.StatusOK, attachments)` over the array —
 * the empty list marshals `[]` (upstream's `make([]*api.Attachment, 0)`
 * seed, issue_comment.go:318). The folded 404 renders the not-found shell
 * the mount passes (`renderNotFound(ctx)`, the issue-info sibling's
 * contract); the type-gate 500 carries upstream's ServerError log line as
 * a plain body (upstream renders the themed 500 page — the status is the
 * contract, the body is the mount's to theme).
 */
export function commentAttachmentsFragmentResponse(
  origin: string,
  outcome: CommentAttachmentsFragmentOutcome,
  notFoundHtml = "",
): Response {
  if (outcome.kind === "notFound") {
    return new Response(notFoundHtml, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (outcome.kind === "unsupportedType") {
    return new Response(`GetCommentAttachments: comment type ${outcome.commentType} does not support attachments`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(outcome.attachments.map((row) => toApiAttachment(origin, row))), {
    status: 200,
    headers: jsonHeaders(),
  });
}
