/**
 * The PR code-comment conversation routes — census gap #3 (the
 * `/files/reviews` group's two unclaimed siblings + the resolve toggle),
 * the wave-11 review-write family's follow-on over the LANDED review
 * pipeline:
 *
 *   GET  /{owner}/{repo}/pulls/{index}/files/reviews/new_comment
 *        upstream web.go:1674 `m.Get("/new_comment",
 *        repo.RenderNewCodeCommentForm)` (routers/web/repo/pull_review.go
 *        :36-57) — the reply-box fragment the diff view's `+` button
 *        fetches (box.tmpl:194's `data-new-comment-url`), tplNewComment =
 *        repo/diff/new_comment.tmpl wrapping repo/diff/comment_form.tmpl.
 *   POST /{owner}/{repo}/pulls/{index}/files/reviews/comments
 *        upstream web.go:1675 `m.Post("/comments", web.Bind[*forms.
 *        CodeCommentForm](), repo.SetShowOutdatedComments,
 *        repo.CreateCodeComment)` (pull_review.go:63-115) — the
 *        code-comment write; the answer is the rendered conversation
 *        fragment (renderConversation, :168-221), never a page.
 *   POST /{owner}/{repo}/issues/resolve_conversation
 *        upstream web.go:1437 `m.Post("/resolve_conversation",
 *        repo.SetShowOutdatedComments, repo.UpdateResolveConversation)`
 *        (pull_review.go:118-165) — the resolve/unresolve toggle; the
 *        answer is the same conversation fragment.
 *
 * The route-level conventions are index-owned (this module is UNMOUNTED —
 * its mount recipes live in the header tail + the handoff): the GET runs
 * the repo prologue then the reqSignIn 303 (upstream wraps the reviews
 * group in reqSignIn, web.go:1679 — the login 303 convention); the POSTs
 * run sameOriginGuard → repo prologue → login 303 → archived 404 shell
 * (web.go:1419-1421 wraps the issues group, :1677 the reviews group), the
 * wave-11 pull-reviews.tsx sequence verbatim. GET → 405 elsewhere, the
 * chi posture the wave-11 tests pin.
 *
 * ## Upstream behavior, knob by knob
 *
 * - CodeCommentForm (services/forms/repo_form.go:468-479): `origin`
 *   Required In(timeline,diff), `content` Required, `side` Required
 *   In(previous,proposed), `line` int64, `path` (TreePath) Required,
 *   `single_review` bool, `reply` int64, `latest_commit_id` string. The
 *   web handler signs the line (:74-76): `side=previous` stores NEGATIVE
 *   (the OLD-side convention the API converters read back — position vs
 *   original_position). A binding error is upstream's HasError arm
 *   (:80-87): flash + 303 onto `pulls/{index}/files` — ours redirects
 *   without the flash row.
 * - CreateCodeComment (services/pull/review.go:92-176): `pendingReview`
 *   = !single_review; a reply (`reply` set, !pendingReview) attaches ONLY
 *   when a code comment already exists at that line/path (ReviewExists,
 *   models/issues/review.go:449-451) — else it falls through to the
 *   pending-review arm (GetCurrentReview or a fresh PENDING row + the
 *   comment). The comment row carries the FIRST same-review/line/path
 *   comment's commit/patch/invalidated when one exists (createCodeComment
 *   :187-206, FindComments created_unix/id ASC — the WARNING comment at
 *   :1166 pins the order); the patch capture is the GetCodeCommentPatch
 *   port (gitdiff.go:1600-1615) re-issued below from the landed API create
 *   arm (routes/pull-reviews.ts:638-705 — cutDiffAroundLine +
 *   syntheticPatchForUnchangedLine, the pages-module re-issue precedent).
 *   A degenerate diff range (missing base/head refs) stores NO patch and
 *   never fails the write — the landed arm's posture (:983-1007).
 * - !pendingReview (the single-comment button) submits the pending review
 *   as a COMMENT review afterwards (:166-172) — the LANDED pages seam
 *   submitReviewFromForm (pages/pull-reviews.tsx) rides with type
 *   "comment" and an empty body: the pending-row conversion, the type-22
 *   system comment, the num_comments bump and the
 *   pull_request_review_comment webhook all fire from there (its
 *   blank-body action-row skip matches notifier.go:244-246).
 * - UpdateResolveConversation (:118-165): origin/action/comment_id form;
 *   the comment must exist, belong to THIS repo, be on a pull, and the
 *   doer passes CanMarkConversation (models/issues/review.go:961-990 —
 *   the issue poster or write access); the action is Resolve|UnResolve
 *   (else 400); MarkConversation (:933-959) is IDEMPOTENT — same-state
 *   rows stay untouched — and writes ONLY `comment.resolve_doer_id`
 *   (set/clear). The SAME store the landed API resolve pair uses
 *   (routes/repo-extras-t2.ts:1367-1396 — comments.resolveDoerId null vs
 *   the doer id); no duplicated state, the D1 column is nullable integer
 *   (db/schema.ts:708) against upstream's 0-sentinel.
 * - renderConversation (:168-221): FetchCodeCommentsByLine
 *   (models/issues/comment_code.go:130-138 → findCodeComments :47-127)
 *   — type-Code rows of the issue at treePath+line, created_unix/id ASC,
 *   `invalidated=false` unless outdated comments are shown
 *   (origin=timeline or the show_outdated boolean), and the PENDING-review
 *   privacy filter (comments on a pending review are visible to that
 *   reviewer only, :104-107). EMPTY → the conversation_outdated fragment
 *   ("Content has changed since this comment was made" segment, the
 *   outdated placeholder — upstream's empty/deleted posture). CanMark
 *   gates the resolve button; the JS contract (web_src/js/features/
 *   repo-issue.ts:88-107) replaces `.conversation-holder` with the
 *   response, so the holder div carries data-path/data-side/data-idx.
 *
 * ## Auth + gates (§2.8)
 *
 * The reviews group is reqSignIn + RepoMustNotBeArchived (web.go:1677,
 * :1679); resolve_conversation sits in the issues group's
 * reqUnitPullsReader + RepoMustNotBeArchived (web.go:1419-1421/:1437).
 * So: sameOriginGuard first on the POSTs (the §2.8 order), repo
 * resolution (invisible → 404 shell), anonymous → the login 303
 * (loginRedirect — the full pathname+search round trip), archived → the
 * 404 shell. The GET is a fragment but still reqSignIn'd upstream — the
 * same 303. Unknown index → the 404 shell (the wave-11 posture; upstream
 * answers its ServerError class).
 *
 * ## Documented degradations (§6 method)
 *
 * - The reply form is ALWAYS OPEN, not hidden: upstream hides the reply
 *   form behind the `.comment-form-reply` button whose click handler
 *   initializes the combo markdown editor (initComboMarkdownEditor throws
 *   on the missing `.combo-markdown-editor` container — the plain-textarea
 *   reduction would break the toggle). The always-open form is the wave-11
 *   verdict-form reduction (pages/pull-reviews.tsx's "always-open panel"
 *   precedent); the submit intercepts fine — the conversation-form JS
 *   needs only a non-empty textarea.
 * - Upstream renders TWO conversation templates (tplDiffConversation for
 *   origin=diff, tplTimelineConversation for origin=timeline) — one
 *   fragment shape renders for both here: the timeline twin's extra
 *   chrome (CommentMustAsDiff code preview, show-role labels) is not
 *   modeled, and NO landed timeline mount carries `.conversation-holder`
 *   (the issue-detail timeline covers type-0/22 rows only), so the
 *   timeline-origin arm exists for upstream-client parity alone. The
 *   unknown-origin arm keeps upstream's 400 (the gate's plain-text shape).
 * - The resolve predicate is the LANDED API twin's posture
 *   (repo-extras-t2.ts:1379-1384): the issue poster or repo write access
 *   — upstream's IsOfficialReviewer term (review.go:973-979) stays
 *   folded, matching the API pair so both resolve surfaces decide alike;
 *   the UI columns are the site-admin/owner-row/collaborator trio the
 *   wave-11 module documents (isOfficialReviewerUi).
 * - Per-comment notify: upstream's reply arm fires CreateIssueComment
 *   (services/pull/review.go:132-136); the landed API twins (the create
 *   arm's comment loop, the replies route repo-extras-t2.ts:1476-1508)
 *   stay silent per comment with the num_comments bump — the same silence
 *   here; the submit path's webhook rides submitReviewFromForm.
 * - Line-blame attribution (createCodeComment's LineBlameCommitID,
 *   :210-232) is not ported — the landed API create arm stores the FORM's
 *   latest_commit_id (the head-commit posture, routes/pull-reviews.ts
 *   :1096-1102); a missing value resolves the head-ref tip.
 * - Icons: only octicon-check is inside the generated allowlist — the
 *   reply/prev/next/unfold/fold glyphs render as text-only buttons with
 *   the upstream classes intact (the wave-11 glyph degradations).
 * - Attachments, reactions, the context/edit menu and the mentions
 *   resolution are the landed JS-island/write-surface reductions — the
 *   comment rows render their markdown body only (the wave-11 posture).
 * - Upstream's ServerError on an unknown comment_id in resolve_conversation
 *   (pull_review.go:123-127) is a 500 for a user-input miss — the landed
 *   API twin answers 404 "not found" and this arm matches it.
 *
 * ## index.ts mount recipe (the handoff — index is sibling-owned at write
 *  time; the fold follows the wave-11 positions exactly)
 *
 * 1. INTERFACE — a `PullCommentRoute` interface beside `PullReviewRoute`
 *    (index.ts ~2690), and `| PullCommentRoute` into the UiRoute union
 *    beside `| PullReviewRoute` (index.ts:3502):
 *
 *    ```ts
 *    // The code-comment conversation families (pages/
 *    // pull-review-comments.tsx): upstream's GET
 *    // `/pulls/{index}/files/reviews/new_comment` + POST
 *    // `/pulls/{index}/files/reviews/comments` (web.go:1674-1675, the
 *    // index rides the URL) and the repo-scoped POST
 *    // `/issues/resolve_conversation` (web.go:1437, the ids ride the
 *    // form). GET on the fragment + POSTs.
 *    export interface PullCommentRoute {
 *      family: "pull-review-new-comment" | "pull-review-code-comment" | "issue-resolve-conversation";
 *      owner: string;
 *      repo: string;
 *      // The PR index (the two /files/reviews families only).
 *      index?: number;
 *    }
 *    ```
 *
 * 2. PARSE CLAIMS — the resolve literal beside the wave-11 literals
 *    (index.ts:4868-4869, inside the issues head):
 *    `if (head === "issues" && rest[0] === "resolve_conversation")
 *    return { family: "issue-resolve-conversation", owner, repo };`
 *    The two reviews tails beside the submit claim (index.ts:4934-4943 —
 *    the same 4-segment shape, `rest[3] === "new_comment"` /
 *    `rest[3] === "comments"`), replacing the "code-comment siblings stay
 *    unclaimed" comment above it.
 *
 * 3. IMPORTS — beside the pull-reviews import block (index.ts ends ~826):
 *    `conversationFragmentResponse, conversationOutdatedFragmentHtml,
 *    createCodeCommentFromForm, loadNewCodeCommentData,
 *    newCommentFragmentHtml, parseCodeCommentForm,
 *    parseResolveConversationForm, resolveConversationFromForm,
 *    PullCommentError` from "./pages/pull-review-comments".
 *
 * 4. HANDLERS — the three functions beside pullReviewSubmit (index.ts
 *    ~12547), the wave-11 glue verbatim (sameOriginGuard → resolveUiRequest
 *    → family drift guard → anonymous login 303 → archived 404 shell), see
 *    the recipe in the PR wave's report for the exact bodies:
 *    pullReviewNewComment (GET: the loader nulls 404-shell, then
 *    newCommentFragmentHtml + conversationFragmentResponse), the POST
 *    comments (parseCodeCommentForm null → 303 onto pulls/{index}/files —
 *    upstream's HasError arm; issue/pr/pair resolved + 404-shelled, then
 *    createCodeCommentFromForm → the conversation data reload at
 *    treePath/signedLine → the fragment or the outdated fragment), the
 *    POST resolve (resolveConversationFromForm's result map: !ok →
 *    pullReviewStatusError(status, message) — the wave-11 gate shape at
 *    index.ts ~12660; ok → the conversation fragment, null conversation →
 *    the outdated fragment). `showOutdated` reads the request URL's
 *    `show_outdated` boolean the way upstream's SetShowOutdatedComments
 *    middleware does (diff origin), forced true on timeline.
 *
 * 5. REGISTRATIONS — the resolve POST beside the wave-11 literals
 *    (index.ts:16080-16081, BEFORE the /issues/:index GET catch at :16082
 *    — the static-before-dynamic rule):
 *    `uiRouter.post("/:owner/:repo/issues/resolve_conversation", (c) =>
 *    pullReviewResolveSubmit(c));` +
 *    `uiRouter.get("/:owner/:repo/issues/resolve_conversation", () =>
 *    methodNotAllowed("POST"));`
 *    The reviews tails beside the submit pair (index.ts:16106-16107):
 *    `uiRouter.get(".../files/reviews/new_comment", (c) =>
 *    pullReviewNewComment(c));` (GET-only fragment — upstream registers it
 *    GET; a POST answers 405) and
 *    `uiRouter.post(".../files/reviews/comments", (c) =>
 *    pullReviewCodeComment(c));` + the twin GET 405.
 *
 * 6. NULL PINS THAT FLIP — apps/worker/src/ui/__tests__/pages-wave11.test.ts
 *    :197 (`/alice/wave11/pulls/1/files/reviews/comments` toBeNull) and
 *    :198 (`.../reviews/new_comment` toBeNull) turn into their family
 *    toEqual pins at the fold; :196 (the bare `/files/reviews` tail) stays
 *    null (upstream's group has no bare handler). No
 *    resolve_conversation pins exist anywhere in the worker tree.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DiffFileJson } from "@cf-gitea/git-engine";
import { renderToString } from "hono/jsx/dom/server";

import { engineReads } from "../../api/services/engine";
import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { pullRequestDiffForEnv } from "../../api/services/pull-engine";
import { pullHeadRefName } from "../../api/services/pulls";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { currentPendingReview } from "../../api/services/pull-reviews";
import { renderIssueMarkdown } from "./issue-detail";
import { submitReviewFromForm } from "./pull-reviews";
import { CommentType } from "../../issues/comment-types";
import type { CommentRow, IssueRow, PullRequestRow } from "../../issues/service";
import type { IssueEventRequest } from "../../services/issue-events";
import { comments, issues, pullReviews, ReviewType, users } from "../../db/schema";
import { userLink } from "../links";
import { Icon } from "../shell";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";
import { TimeSince } from "../components/file-list";

/** Page chrome text (component-local, the issueDetailLocale pattern —
 *  every string cites its upstream locale key or template). */
export const pullCommentLocale = {
  placeholder: "Leave a comment", // "repo.diff.comment.placeholder"
  reply: "Reply", // "repo.diff.comment.reply"
  add_review_comment: "Add comment", // "repo.diff.comment.add_review_comment"
  start_review: "Start review", // "repo.diff.comment.start_review"
  add_single_comment: "Add single comment", // "repo.diff.comment.add_single_comment"
  add_line_comment: "Add line comment", // "repo.diff.comment.add_line_comment" (the + button's aria-label)
  cancel: "Cancel", // "cancel"
  resolved_by: "marked this conversation as resolved", // "repo.issues.review.resolved_by"
  outdated: "Outdated", // "repo.issues.review.outdated"
  outdated_description: "Content has changed since this comment was made", // "repo.issues.review.outdated_description"
  show_resolved: "Show resolved", // "repo.issues.review.show_resolved"
  hide_resolved: "Hide resolved", // "repo.issues.review.hide_resolved"
  resolve_conversation: "Resolve conversation", // "repo.issues.review.resolve_conversation"
  un_resolve_conversation: "Unresolve conversation", // "repo.issues.review.un_resolve_conversation"
  pending: "Pending", // "repo.issues.review.pending"
  review: "Review", // "repo.issues.review.review"
  previous: "Previous", // "repo.issues.previous"
  next: "Next", // "repo.issues.next"
  no_content: "No description provided.", // "repo.issues.no_content"
  commented_at: "commented", // "repo.issues.commented_at"'s text half (the anchor rides the HashTag id)
} as const;

// ---------------------------------------------------------------------------
// Form parsers (the wave-11 parseXxxForm pattern — the upstream field names)
// ---------------------------------------------------------------------------

/** The parsed CodeCommentForm (services/forms/repo_form.go:468-479). */
export interface CodeCommentForm {
  /** Required In(timeline,diff) — the answer's render origin. */
  origin: "diff" | "timeline";
  content: string;
  /** Required In(previous,proposed) — previous stores the NEGATIVE line. */
  side: "previous" | "proposed";
  line: number;
  /** The `path` field (upstream TreePath). */
  path: string;
  singleReview: boolean;
  reply: number;
  latestCommitId: string;
}

/** Go's middleware bool parse (StrToBool's truthy set, reduced to the
 *  values a form can carry: "true"/"1"/"on"). */
function formBool(params: URLSearchParams, key: string): boolean {
  const value = params.get(key);
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "on";
}

/** Numeric form field (FormInt64 — a missing/malformed value is 0). */
export function formInt64(params: URLSearchParams, key: string): number {
  const raw = (params.get(key) ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/**
 * Parse the urlencoded `/files/reviews/comments` POST. Returns null on the
 * binding-error class (Required misses + the two In() enum guards) — the
 * caller answers upstream's HasError arm (303 onto the files page).
 */
export function parseCodeCommentForm(params: URLSearchParams): CodeCommentForm | null {
  const origin = params.get("origin");
  if (origin !== "timeline" && origin !== "diff") return null; // Required; In(timeline,diff)
  const content = params.get("content") ?? "";
  if (content === "") return null; // Required
  const side = params.get("side");
  if (side !== "previous" && side !== "proposed") return null; // Required; In(previous,proposed)
  const path = (params.get("path") ?? "").trim();
  if (path === "") return null; // Required (TreePath)
  return {
    origin,
    content,
    side,
    line: formInt64(params, "line"),
    path,
    singleReview: formBool(params, "single_review"),
    reply: formInt64(params, "reply"),
    latestCommitId: params.get("latest_commit_id") ?? "",
  };
}

/** The parsed resolve_conversation POST (FormString/FormInt64 reads,
 *  pull_review.go:119-121 — an unparsed origin stays "" (the 400 arm)). */
export interface ResolveConversationForm {
  origin: string;
  action: string;
  commentId: number;
}

export function parseResolveConversationForm(params: URLSearchParams): ResolveConversationForm {
  return {
    origin: params.get("origin") ?? "",
    action: params.get("action") ?? "",
    commentId: formInt64(params, "comment_id"),
  };
}

// ---------------------------------------------------------------------------
// The gates + lookups
// ---------------------------------------------------------------------------

/**
 * CanMarkConversation (models/issues/review.go:961-990) at the landed API
 * twin's posture (repo-extras-t2.ts:1379-1384): the issue poster, else
 * repo write access — the UI columns (site admin, owner row, write/admin
 * collaborator; the wave-11 isOfficialReviewerUi trio). Upstream's
 * IsOfficialReviewer term stays folded so the web and API resolve
 * surfaces decide alike (the header's degradation note).
 */
export async function canMarkConversation(d1: D1Database, repo: RepoRow, issue: IssueRow, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  if (issue.posterId !== null && viewer.id === issue.posterId) return true;
  if (viewer.isAdmin) return true;
  if (repo.ownerId !== null && viewer.id === repo.ownerId) return true;
  const mode = await collaboratorModeOf(d1, repo.id, viewer.id);
  return mode === "write" || mode === "admin";
}

/** The head-ref tip (upstream GetRefCommitID(GetGitHeadRefName)) — null
 *  degrades to "" at the callers (the landed arm's `head?.oid ?? ""`). */
export async function afterCommitIdOf(env: Env, repo: RepoRow, index: number): Promise<string> {
  const head = await engineReads(env, { ownerNamespace: repo.ownerNamespace, slug: repo.slug }).readCommit(
    pullHeadRefName(index),
  );
  return head?.oid ?? "";
}

/**
 * GET /files/reviews/new_comment's data (RenderNewCodeCommentForm,
 * pull_review.go:36-57): the pull issue row (null = the 404 shell —
 * upstream's ServerError/non-PR arms), the doer's pending-review
 * existence (GetCurrentReview — decides the one-button vs two-button
 * form), and the head-ref tip (AfterCommitID). Anonymous never reaches
 * here (reqSignIn).
 */
export interface NewCodeCommentData {
  issue: IssueRow;
  /** CurrentReview !== nil (repo/diff/comment_form.tmpl:35-43). */
  hasPendingReview: boolean;
  afterCommitId: string;
}

export async function loadNewCodeCommentData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  index: number,
  viewer: Viewer,
): Promise<NewCodeCommentData | null> {
  const rows = await drizzle(d1)
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), eq(issues.index, index)))
    .limit(1)
    .all();
  const issue = rows[0];
  if (issue === undefined || !issue.isPull) return null;
  const pending =
    viewer.kind === "user" ? await currentPendingReview(d1, issue.id, viewer.id) : null;
  return {
    issue,
    hasPendingReview: pending !== null,
    afterCommitId: await afterCommitIdOf(env, repo, index),
  };
}

// ---------------------------------------------------------------------------
// The new_comment fragment (repo/diff/new_comment.tmpl + comment_form.tmpl)
// ---------------------------------------------------------------------------

/**
 * The tplNewComment bytes: `.conversation-holder > .field.comment-code-cloud`
 * wrapping the comment_form — the form posts the code-comment route with
 * the upstream field set; `side`/`line`/`path`/`diff_*` render EMPTY (the
 * + button's JS fills side/line/path from the clicked row, repo-issue.ts
 * :287-290). The button set branches on CurrentReview (comment_form.tmpl
 * :35-43): with a pending review only "Add comment" (pending_review);
 * without it "Start review" (pending_review) + "Add single comment"
 * (single_review=true) — plus the cancel button whose
 * `data-global-click="onCancelCodeComment"` removes the box (the official
 * bundle's handler).
 */
export function newCommentFragmentHtml(data: NewCodeCommentData, repoLink: string): string {
  const action = `${repoLink}/pulls/${data.issue.index}/files/reviews/comments`;
  return renderToString(
    <div class="conversation-holder">
      <div class="field comment-code-cloud">
        <form class="ui form" action={action} method="post">
          <input type="hidden" name="origin" value="diff" />
          <input type="hidden" name="latest_commit_id" value={data.afterCommitId} />
          <input type="hidden" name="side" value="" />
          <input type="hidden" name="line" value="" />
          <input type="hidden" name="path" value="" />
          <input type="hidden" name="diff_start_cid" />
          <input type="hidden" name="diff_end_cid" />
          <input type="hidden" name="diff_base_cid" />
          <div class="field">
            <textarea name="content" placeholder={pullCommentLocale.placeholder} />
          </div>
          <div class="field footer">
            <div class="flex-text-block tw-justify-end">
              {data.hasPendingReview ? (
                <button name="pending_review" type="submit" class="ui submit primary tiny button">
                  {pullCommentLocale.add_review_comment}
                </button>
              ) : (
                <>
                  <button name="pending_review" type="submit" class="ui submit primary tiny button">
                    {pullCommentLocale.start_review}
                  </button>
                  <button name="single_review" value="true" type="submit" class="ui submit tiny basic button">
                    {pullCommentLocale.add_single_comment}
                  </button>
                </>
              )}
              <button type="button" class="ui submit tiny basic button" data-global-click="onCancelCodeComment">
                {pullCommentLocale.cancel}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
  );
}

/**
 * The fragment Response — ctx.HTML's `text/html; charset=utf-8`
 * (context_response.go:99) plus the zero-option prod Cache-Control (the
 * blob-excerpt-fragment twin).
 */
export function newCommentFragmentResponse(html: string): Response {
  return conversationFragmentResponse(html);
}

/** The shared fragment Response builder (one shape for both routes). */
export function conversationFragmentResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

// ---------------------------------------------------------------------------
// The code-comment write (CreateCodeComment, services/pull/review.go:92-176)
// ---------------------------------------------------------------------------

/** The ported arms' typed failure (the PullReviewError shape). */
export class PullCommentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** ReviewExists (models/issues/review.go:449-451): a code comment at the
 *  issue/path/line — the reply arm's fall-through predicate. */
async function reviewExistsAt(d1: D1Database, issueId: number, treePath: string, line: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.treePath, treePath), eq(comments.line, line), eq(comments.type, CommentType.Code)))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** The first same-review/line/path code comment (FindComments created_unix
 *  ASC, id ASC — the order createCodeComment's reuse read depends on,
 *  comment.go:1166-1171). */
async function firstCommentOfReview(
  d1: D1Database,
  reviewId: number,
  treePath: string,
  line: number,
): Promise<CommentRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.reviewId, reviewId),
        eq(comments.treePath, treePath),
        eq(comments.line, line),
        eq(comments.type, CommentType.Code),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

// The diff-hunk capture — the landed GetCodeCommentPatch port re-issued
// verbatim (api/routes/pull-reviews.ts:509-705, the pages-module re-issue
// precedent; upstream services/gitdiff/gitdiff.go:1600-1668).

/** `setting.UI.CodeCommentLines` default (modules/setting/ui.go:96). */
const CODE_COMMENT_LINES = 4;

/** The three-dot diff range the cuts run over (pullRequestDiffForEnv's shape). */
interface CodeCommentRange {
  files: DiffFileJson[];
  mergeBase: string | null;
  head: string;
}

function cutDiffAroundLine(file: DiffFileJson, line: number): string | null {
  if (line === 0) return null;
  const old = line < 0;
  const target = Math.abs(line);
  const hunk = file.hunks.find((h) => {
    const begin = old ? h.aStart : h.bStart;
    const len = old ? h.aLen : h.bLen;
    return len > 0 && begin <= target && target < begin + len;
  });
  if (hunk === undefined) return null;

  const header = [
    `diff --git a/${file.path} b/${file.path}`,
    file.old === null ? "--- /dev/null" : `--- a/${file.path}`,
    file.new === null ? "+++ /dev/null" : `+++ b/${file.path}`,
  ];
  const opLine = (op: { tag: "eq" | "del" | "add"; line: string }): string =>
    op.tag === "eq" ? ` ${op.line}` : op.tag === "add" ? `+${op.line}` : `-${op.line}`;

  let oldLine = hunk.aStart;
  let newLine = hunk.bStart;
  const kept: Array<{ tag: "eq" | "del" | "add"; line: string }> = [];
  let hit = false;
  for (const op of hunk.ops) {
    const opOld = oldLine;
    const opNew = newLine;
    if (op.tag !== "add") oldLine += 1;
    if (op.tag !== "del") newLine += 1;
    kept.push(op);
    if ((old ? op.tag !== "add" : op.tag !== "del") && (old ? opOld : opNew) === target) hit = true;
    if (hit) break;
  }
  if (!hit) return null;

  if (kept.length <= CODE_COMMENT_LINES) {
    return [...header, `@@ -${hunk.aStart},${hunk.aLen} +${hunk.bStart},${hunk.bLen} @@`, ...kept.map(opLine)].join("\n");
  }

  const window = kept.slice(-CODE_COMMENT_LINES);
  let wOld = hunk.aStart;
  let wNew = hunk.bStart;
  for (const op of kept.slice(0, kept.length - window.length)) {
    if (op.tag !== "add") wOld += 1;
    if (op.tag !== "del") wNew += 1;
  }
  let oldLen = 0;
  let newLen = 0;
  for (const op of window) {
    if (op.tag !== "add") oldLen += 1;
    if (op.tag !== "del") newLen += 1;
  }
  return [...header, `@@ -${wOld},${oldLen} +${wNew},${newLen} @@`, ...window.map(opLine)].join("\n");
}

function syntheticPatchForUnchangedLine(blobText: string, treePath: string, line: number): string | null {
  const target = Math.abs(line);
  if (target < 1) return null;
  const startLine = Math.max(target - CODE_COMMENT_LINES, 1);
  const allLines = blobText.split("\n");
  const lines: string[] = [];
  for (let n = startLine; n <= target; n++) {
    const value = allLines[n - 1];
    if (value === undefined) break;
    lines.push(value);
  }
  if (lines.length === 0) return null;
  return (
    [
      `diff --git a/${treePath} b/${treePath}`,
      `--- a/${treePath}`,
      `+++ b/${treePath}`,
      `@@ -${startLine},${lines.length} +${startLine},${lines.length} @@`,
      ...lines.map((content) => ` ${content}`),
    ].join("\n") + "\n"
  );
}

/**
 * GetCodeCommentPatch for one created code comment — the landed arm's
 * posture (routes/pull-reviews.ts:651-705): the diff cut around the line,
 * else the unchanged-line synthetic patch at the side's context commit;
 * a degenerate range (missing refs / no merge base / unreadable blob)
 * returns null — the row stores no patch, never failing the write.
 */
async function codeCommentPatch(
  env: Env,
  pair: RepositoryWithOwner,
  range: CodeCommentRange,
  treePath: string,
  line: number,
): Promise<string | null> {
  const file = range.files.find((f) => f.path === treePath);
  if (file !== undefined) {
    const cut = cutDiffAroundLine(file, line);
    if (cut !== null) return cut;
  }
  const contextCommit = line < 0 ? range.mergeBase : range.head;
  if (contextCommit === null) return null;
  const blob = await engineReads(env, pair.repo).readBlob(contextCommit, treePath);
  if (blob === null) return null;
  return syntheticPatchForUnchangedLine(new TextDecoder().decode(blob.data), treePath, line);
}

/** The created-comment outcome (the web handler's `comment == nil`
 *  defensive arm stays typed: `created: false` is unreachable today —
 *  every ported arm inserts). */
export type CreateCodeCommentResult = { created: true; commentId: number } | { created: false };

/**
 * The web code-comment write (CreateCodeComment web handler :63-115 over
 * services/pull/review.go:92-176): `side=previous` signs the line
 * negative (:74-76); the reply arm attaches to the posted review ONLY
 * when ReviewExists holds (else the pending arm); the pending arm folds
 * onto the doer's pending review (creating it when absent — the
 * GetCurrentReview/Insert arm); !single_review submits the review
 * afterwards through the LANDED submitReviewFromForm ("comment", empty
 * body — :166-172's SubmitReview(ReviewTypeComment) call).
 *
 * The insert shape is the landed create arm's (routes/pull-reviews.ts
 * :986-999): type 21, the signed line, treePath, commitSha = the first
 * same-review comment's (reuse) else the form's latest_commit_id (the
 * head-commit posture — the blame reduction), oldRef = commitSha (the
 * original_commit_id twin), the captured patch, reviewId; the
 * num_comments bump rides the same batch.
 *
 * `pair` feeds the patch capture's engine reads (the handler 404-shells
 * its miss — upstream's gitRepo is always at hand there).
 */
export async function createCodeCommentFromForm(input: {
  /** The hono-shaped request source the submit seam hands over (the
   *  IssueEventRequest structural pair — the handler passes `c`). */
  request: IssueEventRequest;
  origin: string;
  env: Env;
  d1: D1Database;
  /** The owner-joined pair the patch capture reads (the handler 404-shells
   *  its miss — upstream's gitRepo is always at hand there). */
  pair: RepositoryWithOwner;
  repo: RepoRow;
  issue: IssueRow;
  pr: PullRequestRow;
  doerId: number;
  form: CodeCommentForm;
}): Promise<CreateCodeCommentResult> {
  const { request, origin, env, d1, pair, repo, issue, pr, doerId, form } = input;
  const db = drizzle(d1);
  const now = new Date();
  const signedLine = form.side === "previous" ? -form.line : form.line;
  const pendingReview = !form.singleReview;

  let replyToSubmittedReview = !pendingReview && form.reply !== 0;
  if (replyToSubmittedReview) {
    replyToSubmittedReview = await reviewExistsAt(d1, issue.id, form.path, signedLine);
  }

  let reviewId: number;
  let reuse: CommentRow | null = null;
  if (replyToSubmittedReview) {
    // The reply arm (:111-136): the comment attaches to the posted review
    // — its patch/commit come from the review's FIRST comment at the line
    // when one exists (createCodeComment :187-206).
    reviewId = form.reply;
    reuse = await firstCommentOfReview(d1, reviewId, form.path, signedLine);
  } else {
    // The pending arm (:139-164): the doer's pending review, created when
    // absent (GetCurrentReview/Insert, one batch — upstream's tx guard
    // reduces to the sequential pair, the landed create arm's posture).
    const pending = await currentPendingReview(d1, issue.id, doerId);
    if (pending === null) {
      const inserted = await db
        .insert(pullReviews)
        .values({
          type: ReviewType.Pending,
          reviewerId: doerId,
          issueId: issue.id,
          content: "",
          commitId: form.latestCommitId === "" ? null : form.latestCommitId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all();
      reviewId = inserted[0]!.id;
    } else {
      reviewId = pending.id;
    }
    if (signedLine > 0) {
      reuse = await firstCommentOfReview(d1, reviewId, form.path, signedLine);
    }
  }

  // commitSha: the reused comment's wins; else the form's latest_commit_id
  // (empty → the head-ref tip — the landed arm's empty-commit read).
  let commitSha = reuse?.commitSha ?? "";
  if (commitSha === "") {
    commitSha = form.latestCommitId;
    if (commitSha === "") {
      commitSha = await afterCommitIdOf(env, repo, issue.index);
    }
  }

  // The patch: the reused row's wins; else ONE three-dot range read, the
  // cut around the line, else the synthetic unchanged-line patch (the
  // degenerate range degrades to null — never fails the write).
  let patch = reuse?.patch ?? null;
  if (patch === null || patch === "") {
    patch = null;
    try {
      const pulled = await pullRequestDiffForEnv(env, pair, pr);
      if (pulled.mergeBase !== null) {
        patch = await codeCommentPatch(env, pair, pulled, form.path, signedLine);
      }
    } catch {
      patch = null; // no servable range — no hunks (the landed arm's arm)
    }
  }
  const invalidated = reuse?.invalidated ?? false;

  const batch = await db.batch([
    db
      .insert(comments)
      .values({
        type: CommentType.Code,
        posterId: doerId,
        issueId: issue.id,
        line: signedLine,
        treePath: form.path,
        content: form.content,
        commitSha,
        oldRef: commitSha,
        patch,
        reviewId,
        invalidated,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comments.id }),
    db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
  ] as const);
  const commentId = batch[0][0]?.id ?? 0;

  if (!pendingReview && !replyToSubmittedReview) {
    // The single-comment arm (:166-172): submit the review as a COMMENT —
    // the landed seam converts the pending row, lands the type-22 system
    // comment and fires the review webhook. The reply arm RETURNED before
    // this point upstream (:111-136's early return — a reply never
    // submits).
    await submitReviewFromForm({
      request,
      origin,
      pair,
      repo,
      issue,
      pr,
      doerId,
      form: { type: "comment", content: "" },
    });
  }

  return { created: true, commentId };
}

// ---------------------------------------------------------------------------
// The conversation read + fragment (renderConversation, pull_review.go:168-221)
// ---------------------------------------------------------------------------

/** One rendered conversation comment (comments.tmpl reduced). */
export interface ConversationCommentView {
  id: number;
  posterName: string | null;
  content: string;
  /** The §3.4 markdown render ("" degrades to the no-content span). */
  contentHtml: string;
  createdAt: Date | null;
  reviewId: number;
  /** The attached review's type (null = review row gone — no label). */
  reviewType: number | null;
  invalidated: boolean;
}

/** The conversation fragment's render inputs. */
export interface ConversationData {
  origin: "diff" | "timeline";
  issue: IssueRow;
  repo: RepoRow;
  afterCommitId: string;
  canMark: boolean;
  /** Signed-in + non-archived (comment_form's canAddComment). */
  canReply: boolean;
  treePath: string;
  /** The FIRST comment's signed line (negative = the previous side). */
  line: number;
  firstCommentId: number;
  firstReviewId: number;
  resolved: boolean;
  resolveDoerName: string | null;
  comments: ConversationCommentView[];
}

/**
 * FetchCodeCommentsByLine (comment_code.go:130-138) + the render inputs:
 * type-Code rows of the issue at treePath+line (created_unix/id ASC),
 * `invalidated=false` unless outdated comments show (origin=timeline or
 * the show_outdated boolean), the pending-review privacy filter (a
 * pending review's comments are visible to that reviewer only — findCode
 * Comments :104-107), the poster names, the resolve-doer name and the
 * head-ref tip. Returns null when NOTHING is visible — the caller renders
 * the conversation_outdated fragment (renderConversation's empty arm).
 */
export async function loadConversationData(input: {
  env: Env;
  d1: D1Database;
  repo: RepoRow;
  issue: IssueRow;
  treePath: string;
  line: number;
  viewer: Viewer;
  origin: "diff" | "timeline";
  /** The request origin — the §3.4 markdown link rewriting base. */
  urlOrigin: string;
  showOutdated: boolean;
}): Promise<ConversationData | null> {
  const { env, d1, repo, issue, treePath, line, viewer, origin, urlOrigin, showOutdated } = input;
  const db = drizzle(d1);
  const doerId = viewer.kind === "user" ? viewer.id : -1;

  const rows = await db
    .select({ comment: comments, review: pullReviews, posterName: users.username })
    .from(comments)
    .leftJoin(pullReviews, eq(pullReviews.id, comments.reviewId))
    .leftJoin(users, eq(users.id, comments.posterId))
    .where(
      and(
        eq(comments.issueId, issue.id),
        eq(comments.treePath, treePath),
        eq(comments.line, line),
        eq(comments.type, CommentType.Code),
        ...(showOutdated ? [] : [eq(comments.invalidated, false)]),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();

  const views: ConversationCommentView[] = [];
  for (const row of rows) {
    // The pending-review privacy filter (:104-107): a PENDING review's
    // comments are visible to that reviewer only (site admins too —
    // upstream's currentUser check is reviewer-only, but the landed list
    // arm's admin override is the house posture; the sidebar reads it the
    // same way). A missing review row renders (the join's null).
    if (row.review !== null && row.review.type === ReviewType.Pending) {
      const isReviewer = row.review.reviewerId === doerId;
      const isAdmin = viewer.kind === "user" && viewer.isAdmin;
      if (!isReviewer && !isAdmin) continue;
    }
    views.push({
      id: row.comment.id,
      posterName: row.posterName ?? null,
      content: row.comment.content ?? "",
      contentHtml: renderIssueMarkdown({ text: row.comment.content ?? "", repo, origin: urlOrigin }),
      createdAt: row.comment.createdAt,
      reviewId: row.comment.reviewId ?? 0,
      reviewType: row.review === null ? null : row.review.type,
      invalidated: row.comment.invalidated,
    });
  }
  if (views.length === 0) return null;

  // The FIRST comment's row decides resolved state + the holder attrs
  // (conversation.tmpl:6-19). The resolve-doer name joins by id.
  const firstRow = rows.find((row) => row.comment.id === views[0]!.id)!;
  const resolved = (firstRow.comment.resolveDoerId ?? 0) !== 0;
  let resolveDoerName: string | null = null;
  if (resolved && firstRow.comment.resolveDoerId !== null) {
    const doerRows = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, firstRow.comment.resolveDoerId))
      .limit(1)
      .all();
    resolveDoerName = doerRows[0]?.username ?? null;
  }

  return {
    origin,
    issue,
    repo,
    afterCommitId: await afterCommitIdOf(env, repo, issue.index),
    canMark: await canMarkConversation(d1, repo, issue, viewer),
    canReply: viewer.kind === "user" && !repo.isArchived,
    treePath,
    line,
    firstCommentId: views[0]!.id,
    firstReviewId: views[0]!.reviewId,
    resolved,
    resolveDoerName,
    comments: views,
  };
}

/** One comment body (comments.tmpl:51-68 reduced): the markdown body or
 *  the no-content span. */
function ConversationCommentBody(props: { view: ConversationCommentView }) {
  return (
    <div class="ui attached segment comment-body">
      {props.view.contentHtml !== "" ? (
        // The markdown pipeline returns trusted repo-context HTML (the
        // issue-detail render-content posture).
        <div class="render-content markup" dangerouslySetInnerHTML={{ __html: props.view.contentHtml }} />
      ) : (
        <div class="render-content markup">
          <span class="no-content">{pullCommentLocale.no_content}</span>
        </div>
      )}
    </div>
  );
}

/** One comment row (comments.tmpl:12-70 reduced): the poster/time header,
 *  the pending/review + outdated labels, the body. */
function ConversationComment(props: { view: ConversationCommentView }) {
  const { view } = props;
  return (
    <div class="comment" id={`issuecomment-${view.id}`}>
      <div class="content comment-container">
        <div class="comment-header">
          <div class="comment-header-left">
            <span class="tw-text-text-light muted-links">
              {view.posterName !== null ? (
                <a href={userLink(view.posterName)}>{view.posterName}</a>
              ) : (
                <span>{String(view.posterName ?? "")}</span>
              )}{" "}
              {pullCommentLocale.commented_at}{" "}
              {view.createdAt !== null ? (
                <TimeSince unixSeconds={Math.floor(view.createdAt.getTime() / 1000)} tz="+0000" />
              ) : null}
            </span>
          </div>
          <div class="comment-header-right">
            {view.invalidated ? (
              <a
                href={`#issuecomment-${view.id}`}
                class="ui label basic small"
                data-tooltip-content={pullCommentLocale.outdated_description}
              >
                {pullCommentLocale.outdated}
              </a>
            ) : null}
            {view.reviewType !== null ? (
              view.reviewType === ReviewType.Pending ? (
                <div class="ui label basic small yellow pending-label">{pullCommentLocale.pending}</div>
              ) : (
                <div class="ui label basic small">{pullCommentLocale.review}</div>
              )
            ) : null}
          </div>
        </div>
        <ConversationCommentBody view={view} />
      </div>
    </div>
  );
}

/** The always-open reply form (repo/diff/comment_form.tmpl in the
 *  ReplyReviewComment mode — the fields ride the FIRST comment's
 *  side/line/path/review; the always-open reduction is the header's
 *  documented degradation). */
function ReplyForm(props: { data: ConversationData; repoLink: string }) {
  const { data } = props;
  const side = data.line < 0 ? "previous" : "proposed";
  return (
    <form
      class="ui form comment-form"
      action={`${props.repoLink}/pulls/${data.issue.index}/files/reviews/comments`}
      method="post"
    >
      <input type="hidden" name="origin" value={data.origin} />
      <input type="hidden" name="latest_commit_id" value={data.afterCommitId} />
      <input type="hidden" name="side" value={side} />
      <input type="hidden" name="line" value={String(Math.abs(data.line))} />
      <input type="hidden" name="path" value={data.treePath} />
      <input type="hidden" name="reply" value={String(data.firstReviewId)} />
      <input type="hidden" name="single_review" value="true" />
      <div class="field">
        <textarea name="content" placeholder={pullCommentLocale.placeholder} />
      </div>
      <div class="field footer">
        <div class="flex-text-block tw-justify-end">
          <button class="ui submit primary tiny button" type="submit">
            {pullCommentLocale.reply}
          </button>
          <button type="button" class="ui submit tiny basic button" data-global-click="onCancelCodeComment">
            {pullCommentLocale.cancel}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * The conversation fragment (tplDiffConversation, repo/diff/conversation
 * .tmpl reduced — BOTH origins render this shape, the header's note):
 * `.conversation-holder` with data-path/data-side/data-idx (the JS
 * replace contract), the resolved placeholder (check glyph + resolver
 * name + the show/hide buttons), the comment list, the prev/next nav,
 * the resolve toggle (canMark && hasReview && not pending — conversation
 * .tmpl:17) and the reply form (canReply).
 */
export function conversationFragmentHtml(data: ConversationData, repoLink: string): string {
  const first = data.comments[0]!;
  const isReviewPending = first.reviewType === ReviewType.Pending;
  const canMarkAsResolved = data.canMark && data.firstReviewId !== 0 && !isReviewPending;
  const side = data.line < 0 ? "left" : "right";
  const referenceUrl = `${repoLink}/pulls/${data.issue.index}#issuecomment-${data.firstCommentId}`;
  return renderToString(
    <div class="conversation-holder" data-path={data.treePath} data-side={side} data-idx={String(Math.abs(data.line))}>
      {data.resolved ? (
        <div class="resolved-placeholder">
          <div class="flex-text-block tw-flex-wrap tw-text-text-light">
            <Icon name="octicon-check" />
            <b>{data.resolveDoerName ?? ""}</b> {pullCommentLocale.resolved_by}
            {first.invalidated ? (
              <a href={referenceUrl} class="ui label basic small tw-ml-2" data-tooltip-content={pullCommentLocale.outdated_description}>
                {pullCommentLocale.outdated}
              </a>
            ) : null}
          </div>
          <div class="flex-text-block">
            <button type="button" id={`show-outdated-${data.firstCommentId}`} data-comment={String(data.firstCommentId)} class="btn tiny show-outdated">
              {pullCommentLocale.show_resolved}
            </button>
            <button
              type="button"
              id={`hide-outdated-${data.firstCommentId}`}
              data-comment={String(data.firstCommentId)}
              class="btn tiny hide-outdated tw-hidden"
            >
              {pullCommentLocale.hide_resolved}
            </button>
          </div>
        </div>
      ) : null}
      <div id={`code-comments-${data.firstCommentId}`} class={`field comment-code-cloud${data.resolved ? " tw-hidden" : ""}`}>
        <div class="comment-list">
          <div class="ui comments">
            {data.comments.map((view) => (
              <ConversationComment view={view} />
            ))}
          </div>
        </div>
        <div class="flex-text-block tw-mt-2 tw-flex-wrap tw-justify-end">
          <div class="ui buttons">
            <button type="button" class="ui icon tiny basic button previous-conversation">
              {pullCommentLocale.previous}
            </button>
            <button type="button" class="ui icon tiny basic button next-conversation">
              {pullCommentLocale.next}
            </button>
          </div>
          {canMarkAsResolved ? (
            <button
              type="button"
              class="ui icon tiny basic button resolve-conversation"
              data-origin={data.origin}
              data-action={data.resolved ? "UnResolve" : "Resolve"}
              data-comment-id={String(data.firstCommentId)}
              data-update-url={`${repoLink}/issues/resolve_conversation`}
            >
              {data.resolved ? pullCommentLocale.un_resolve_conversation : pullCommentLocale.resolve_conversation}
            </button>
          ) : null}
          {data.canReply ? (
            <button type="button" class="comment-form-reply ui primary icon tiny button">
              {pullCommentLocale.reply}
            </button>
          ) : null}
        </div>
        {data.canReply ? <ReplyForm data={data} repoLink={repoLink} /> : null}
      </div>
    </div>,
  );
}

/** The conversation_outdated fragment (repo/diff/conversation_outdated
 *  .tmpl verbatim — the empty/deleted/outdated arm). */
export function conversationOutdatedFragmentHtml(): string {
  return renderToString(
    <div class="ui segment conversation-holder conversation-not-existing">{pullCommentLocale.outdated_description}</div>,
  );
}

// ---------------------------------------------------------------------------
// The resolve toggle (UpdateResolveConversation + MarkConversation)
// ---------------------------------------------------------------------------

/** The resolve arm's outcome: the gate statuses (the landed API twin's
 *  map — 404 unknown/foreign, 403 forbidden, 400 non-PR/bad action/
 *  unknown origin) or the reloaded conversation (null = the outdated
 *  fragment arm). */
export type ResolveConversationResult =
  | { ok: true; conversation: ConversationData | null; resolvedNow: boolean }
  | { ok: false; status: number; message: string };

/**
 * UpdateResolveConversation (pull_review.go:118-165) + MarkConversation
 * (models/issues/review.go:933-959): the comment resolved repo-scoped
 * (the landed API twin's joined read), the CanMarkConversation gate, the
 * pull-only guard, then the IDEMPOTENT `comments.resolve_doer_id` flip —
 * the SAME store the API pair writes (null vs the doer id; upstream's
 * 0-sentinel maps to null, db/schema.ts:708). Same-state rows stay
 * untouched (MarkConversation's early returns).
 *
 * The conversation data reloads AFTER the flip (renderConversation's
 * read) — null when the line's visible comments vanished (the outdated
 * fragment arm).
 */
export async function resolveConversationFromForm(input: {
  env: Env;
  d1: D1Database;
  repo: RepoRow;
  viewer: Viewer;
  /** The request origin — the markdown rewrite base on the reload. */
  urlOrigin: string;
  form: ResolveConversationForm;
}): Promise<ResolveConversationResult> {
  const { env, d1, repo, viewer, urlOrigin, form } = input;

  // Unknown origin answers upstream's 400 before any read (the switch is
  // at render time upstream, but the fragment shape needs the enum).
  if (form.origin !== "diff" && form.origin !== "timeline") {
    return { ok: false, status: 400, message: `Unknown origin: ${form.origin}` };
  }
  if (form.action !== "Resolve" && form.action !== "UnResolve") {
    return { ok: false, status: 400, message: "unknown action" }; // :153-157
  }

  const rows = await drizzle(d1)
    .select({ comment: comments, issue: issues })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(and(eq(comments.id, form.commentId), eq(issues.repoId, repo.id)))
    .limit(1)
    .all();
  const target = rows[0];
  if (target === undefined) {
    // Upstream ServerError 500s the unknown id (:123-127) — the landed API
    // twin's 404 (the header's note).
    return { ok: false, status: 404, message: "not found" };
  }
  if (!target.issue.isPull) {
    return { ok: false, status: 400, message: "comment does not belong to a pull request" }; // :147-150
  }
  if (!(await canMarkConversation(d1, repo, target.issue, viewer))) {
    return { ok: false, status: 403, message: "user should have permission to resolve comment" }; // :139-146
  }

  // MarkConversation: idempotent — same-state rows stay untouched.
  const isResolve = form.action === "Resolve";
  const resolved = (target.comment.resolveDoerId ?? 0) !== 0;
  if (isResolve !== resolved) {
    await drizzle(d1)
      .update(comments)
      .set({ resolveDoerId: isResolve ? (viewer.kind === "user" ? viewer.id : null) : null })
      .where(eq(comments.id, target.comment.id));
  }

  const conversation =
    target.comment.treePath === null || target.comment.line === null
      ? null
      : await loadConversationData({
          env,
          d1,
          repo,
          issue: target.issue,
          treePath: target.comment.treePath,
          line: target.comment.line,
          viewer,
          origin: form.origin,
          urlOrigin,
          showOutdated: form.origin === "timeline",
        });
  return { ok: true, conversation, resolvedNow: isResolve };
}
