/**
 * PR review family (the reviews-block contract rows): repoListPullReviews /
 * repoCreatePullReview / repoGetPullReview / repoSubmitPullReview /
 * repoDeletePullReview / repoGetPullReviewComments / repoDismissPullReview /
 * repoUnDismissPullReview / repoCreatePullReviewRequests /
 * repoDeletePullReviewRequests — 4 paths, 10 operations, over migration
 * 0018's `pull_reviews` table.
 *
 * Model (upstream `Review`, gitea/models/issues/review.go:96–141): ONE table
 * carries submitted/pending reviews AND reviewer requests — a request is a
 * review row of `ReviewTypeRequest` (models/issues/review.go:697–770
 * AddReviewRequest / RemoveReviewRequest), so cf-gitea needs no separate
 * review_request table. Wire states map
 * (services/convert/pull_review.go:75–84): Pending→PENDING, Approve→APPROVED,
 * Comment→COMMENT, Reject→REQUEST_CHANGES, Request→REQUEST_REVIEW.
 *
 * Semantics ported (each arm cites its upstream line):
 *   - create/submit share the SubmitReview pipeline
 *     (services/pull/review.go:282–308 over models/issues/review.go:467–584):
 *     approve/reject on a closed or merged PR 422 "can't submit review for a
 *     closed or merged PR" (ErrSubmitReviewOnClosedPR :46–47/:289–294), the
 *     doer's latest PENDING review is
 *     converted (or a fresh row created), an approve/reject clears the
 *     reviewer's other official flags first and computes `official` fresh
 *     (IsOfficialReviewer :276 — the SPEC-0013 whitelist arm: the base
 *     branch's protection rule decides; without a rule or without the
 *     approvals whitelist, write access on the base repo decides), a
 *     non-pending submit deletes the reviewer's outstanding REQUEST rows
 *     (:540, CreateReview :403), an approve/reject dismisses the reviewer's
 *     previous approve/reject rows (CreateReview :408–412), a
 *     `CommentTypeReview` (22) system comment lands with the row
 *     (:551–563 + :575), and on an org-owned repo approve/reject clears the
 *     team REQUEST rows whose team the doer belongs to (:563–584).
 *   - create arm (routers/api/v1/repo/pull_review.go:466–580): self-approval
 *     and self-rejection 422 (:684/:692), REQUEST_CHANGES requires a body
 *     (:696), an empty commit_id defaults to the head ref tip (:521–536),
 *     comment bodies land as pending `CommentTypeCode` (21) rows attached to
 *     the doer's pending review (CreateCodeComment loop :539–560), empty
 *     body+comments → "review requires a body or a comment" (ContentEmptyErr,
 *     review.go:455–465). A PENDING event creates/keeps a pending review —
 *     upstream accepts any event string and defaults unknown ones to pending
 *     (:704–706); unknown strings fail our zod enum bind instead (422,
 *     declared) — documented bind divergence.
 *   - submit arm (:583–672): only a pending review can be submitted (:631),
 *     a PENDING event stays pending (:643), the pending review is looked up
 *     by DOER (GetCurrentReview, review.go:430) not by path id — the path id
 *     is the ownership guard (prepareSingleReview :709–741).
 *   - delete arm (:406–463): reviewer-or-site-admin 403 (:452), and a
 *     REQUEST row refuses deletion (DeleteReview review.go:994–1000 —
 *     upstream answers 500; undeclared runtime-only response, the
 *     RUNTIME_ONLY_RESPONSES tables are NOT extended here). Cascade: the
 *     review's code/review/dismissal comments die with it (:999–1041) and an
 *     official review restores the reviewer's latest row's flag
 *     (restoreLatestOfficialReview :806–820, quirk faithful). Silence arm:
 *     no webhook (upstream has no notifier call).
 *   - dismissal arms (:1048–1085 + services/pull/review.go:383–460): repo
 *     admin only ("Must be repo admin"), approve/reject rows only, closed or
 *     merged PR → 403 "can't dismiss a review associated to a closed or
 *     merged PR" (ErrDismissRequestOnClosedPR, review.go:29–44), `priors`
 *     dismisses the reviewer's other undismissed approve/reject rows
 *     (services/pull/review.go:423–436), the dismiss (not undismiss) lands a
 *     `CommentTypeDismissReview` (32) comment with the message (:443–456).
 *     Silence arm: no webhook (mailer/feed only upstream).
 *   - request arms (:744–956 + services/issue/review_request.go): reviewers
 *     resolve by name or email (404 "user doesn't exist: X"), team reviewers
 *     only on org-owned repos (404 "team doesn't exist: X"); a REQUEST row
 *     already present skips silently (AddReviewRequest :706–710), a closed
 *     or merged PR 403s (ErrReviewRequestOnClosedPR :70–86), the poster
 *     can't be requested ("poster of pr can't be reviewer"), the doer needs
 *     CanDoerChangeReviewRequests — ported as poster / repo owner / site
 *     admin / collaborator (the org-team arm of review_request.go:186–205
 *     has no cf-gitea unit ACL to consult; documented deviation) with
 *     upstream's two escapes (poster re-request after a review, reviewer
 *     self-request after their own approval); the reviewer must be able to
 *     read the repo. USER-request removal restores the reviewer's latest
 *     official flag (RemoveReviewRequest :770–804). NOTIFICATION SPLIT:
 *     user-request add AND remove notify (services/issue/review_request.go
 *     ReviewRequest — `comment != nil` → notifier); TEAM-request add
 *     notifies, TEAM-request removal is SILENT (:44–47 — `!isAdd` returns
 *     before the notifier).
 *
 * Webhook events (services/webhook/notifier.go): submitted reviews fire
 * `pull_request_review_approved` / `_rejected` / `_comment` per type —
 * PENDING stays silent (notifier.go:755–766) — with action "reviewed",
 * `requested_reviewer` = the reviewer (the doer here), `sender` = the
 * REVIEWER (notifier.go:773), and `review` {type: <wire event>, content}
 * (:768–772). Review requests fire `pull_request_review_request` with action
 * "review_requested" / "review_request_removed" (notifier.go:793–815) — per
 * actually-created/removed USER request. Team requests fire ONE event with
 * `requested_reviewer` omitted (upstream fans out per team MEMBER —
 * review_request.go teamReviewRequestNotify — which has no single-user
 * rendering; documented deviation).
 *
 * The GET arms' pending-review privacy (prepareSingleReview :730, the
 * ToPullReviewList filter convert/pull_review.go:69–73): pending rows are
 * visible to their reviewer and site admins only, 404/list-skipped for
 * everyone else. `comments_count` counts the review's code comments
 * (GetCodeCommentsCount review.go:1048). `html_url` renders only for
 * submitted reviews (review.go:1073–1076).
 *
 * Diff hunks (the GetCodeCommentPatch port, gitdiff.go:1600–1615): created
 * code comments store the hunk cut around their line over the PR's
 * three-dot range (CutDiffAroundLine over the engine's structured hunks)
 * with the unchanged-line synthetic-patch fallback, so `diff_hunk` renders
 * upstream's real context. Known limits, documented at the helpers: the cut
 * runs off DiffFileJson hunks (upstream's `\ No newline` marker arm — a
 * FIXME upstream too — is unreachable), the stored patch omits the `index`
 * header line, and a degenerate range (no head/base ref, no merge base)
 * captures nothing rather than fabricating a hunk.
 *
 * Deviations (documented): the review `team` field renders null
 * (team REQUEST rows carry reviewer_team_id; the full upstream Team render
 * lives in the org-teams converter); a missing reviewer row renders
 * `user: null` (upstream renders a Ghost user); `num_comments` bumps on
 * EVERY inserted system comment (the landed issue-tables-t2/repo-extras-t2
 * discipline — upstream's UpdateIssueNumComments counts only types {0,22},
 * models/issues/comment.go:209–211); ErrNotValidReviewRequest messages
 * render our TEXT repo id verbatim in upstream's ` [user_id: N, repo_id: R]`
 * suffix format.
 *
 * The WRITE CORES live in services/pull-reviews.ts — `submitReview` +
 * `addReviewRequest`/`removeReviewRequest`, the §14.6 extraction
 * (specs/email-outbound.md): the handlers below stay parse+validate+respond
 * and construct `new PullReviewsService(c.env.DB, c.env)` at the write arms
 * (the IssuesService(d1, mailEnv) mail seam — the review family's receivers
 * fire from the service in the NEXT wave; this wave emits no mail).
 *
 * Auth (routers/api/v1/api.go:1457–1474): the GET arms ride the group's
 * reqRepoReader (anonymous-capable on public repos → optionalAuth); every
 * write arm carries reqToken → requireAuth. Repo resolution follows the
 * anti-enumeration 404. Registration order (orchestrator's one-liner):
 * AFTER registerPullRoutes like every deeper `/pulls/{index}/…` family.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { DiffFileJson } from "@cf-gitea/git-engine";

import { ReviewType, comments, issues, pullReviews, teams, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { emitIssueEvent } from "../../services/issue-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { embeddedUserSchema } from "../models/issue";
import { parseListOptions } from "../pagination";
import { assertPullsUnit } from "../services/issue-unit-gates";
import { collaboratorModeOf } from "../services/repo-collaborators";
import {
  findPullRequestByIndex,
  pullRequestNotExistError,
  pullHeadRefName,
  toApiPullRequest,
} from "../services/pulls";
import {
  apiUserFromRow,
  canViewRepository,
  canViewRepositoryWithTeams,
  doerRepoAccessMode,
  findRepositoryByPath,
  repositoryPermissions,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../services/repository";
import { engineReads } from "../services/engine";
import { pullRequestDiff, pullRequestDiffShortStat } from "../services/pull-engine";
// The write cores (§14.6's extraction — specs/email-outbound.md): submitReview
// + the reviewer-request pair live in the service (the IssuesService(d1,
// mailEnv) seam; this route passes `c.env` at the write arms). The read
// consults stay local imports — the route's handlers + arms still look up
// pending/decision rows for their own gates.
import { PullReviewsService, currentPendingReview, latestDecisionReview, type ReviewRow } from "../services/pull-reviews";

// ---------------------------------------------------------------------------
// Contract models (vendored definitions rendered inline, misc-t2 convention;
// gitea/modules/structs/pull_review.go + the PullReview/PullReviewComment
// swagger definitions).
// ---------------------------------------------------------------------------

/** `#/definitions/User` (the embedded projection models/issue.ts declares). */
const reviewUserSchema = embeddedUserSchema.nullable().openapi({ description: "Reviewer user" });

/** `ReviewStateType` (modules/structs/pull_review.go:15–30). */
const reviewStateSchema = z
  .enum(["APPROVED", "PENDING", "COMMENT", "REQUEST_CHANGES", "REQUEST_REVIEW"])
  .openapi({ description: "ReviewStateType review state type" });

/** `#/definitions/PullReview` (modules/structs/pull_review.go:33–52). */
const pullReviewSchema = z.object({
  id: z.number(),
  user: reviewUserSchema,
  team: z
    .unknown()
    .nullable()
    .openapi({ description: "Reviewer team (null — cf-gitea renders no Team block; deviation documented in the module header)" }),
  state: reviewStateSchema,
  body: z.string(),
  commit_id: z.string(),
  stale: z.boolean(),
  official: z.boolean(),
  dismissed: z.boolean(),
  comments_count: z.number(),
  submitted_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
  pull_request_url: z.string(),
});

/** `CreatePullReviewOptions` (modules/structs/pull_review.go:96–101). */
const createPullReviewOptionsSchema = z.object({
  event: reviewStateSchema.optional(),
  body: z.string().optional(),
  commit_id: z.string().optional(),
  comments: z
    .array(
      z.object({
        path: z.string(),
        body: z.string(),
        old_position: z.number().optional(),
        new_position: z.number().optional(),
      }),
    )
    .optional(),
});

/** `SubmitPullReviewOptions` (modules/structs/pull_review.go:118–121). */
const submitPullReviewOptionsSchema = z.object({
  event: reviewStateSchema.optional(),
  body: z.string().optional(),
});

/** `DismissPullReviewOptions` (modules/structs/pull_review.go:124–127). */
const dismissPullReviewOptionsSchema = z.object({
  message: z.string().optional(),
  priors: z.boolean().optional(),
});

/** `PullReviewRequestOptions` (modules/structs/pull_review.go:130–133). */
const pullReviewRequestOptionsSchema = z.object({
  reviewers: z.array(z.string()).optional(),
  team_reviewers: z.array(z.string()).optional(),
});

/** `#/definitions/PullReviewComment` (modules/structs/pull_review.go:55–77). */
const pullReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: reviewUserSchema,
  resolver: reviewUserSchema,
  pull_request_review_id: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  path: z.string(),
  commit_id: z.string(),
  original_commit_id: z.string(),
  diff_hunk: z.string(),
  position: z.number().nullable(),
  original_position: z.number().nullable(),
  html_url: z.string(),
  pull_request_url: z.string(),
});

// ---------------------------------------------------------------------------
// Shared response shapes + params (the pulls.ts conventions).
// ---------------------------------------------------------------------------

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;
const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const pullIndexParams = {
  ...ownerRepoParams,
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request" }),
} as const;

const reviewIdParams = {
  ...pullIndexParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the review" }),
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Guards + lookups
// ---------------------------------------------------------------------------

/** Shared repo resolution — the anti-enumeration 404 (SPEC-0004 §2.4). */
/** Repo resolution + visibility (the anti-enumeration 404; the review
 *  family's local copy of the issues/pulls guard), closed by the pulls-group
 *  UNIT gate at upstream's chain position — the `/pulls` subtree registers
 *  `mustAllowPulls` after repoAssignment (api.go:1478, api.go:697-722), so a
 *  mirror, an archived repo, or a pulls-disabled repo 404s these review
 *  routes before any handler body (services/issue-unit-gates.ts). */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  await assertPullsUnit(c.env.DB, found);
  return { viewer, found };
}

/** PR-by-index lookup answering the upstream ErrPullRequestNotExist 404. */
async function requirePullRequest(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  rawIndex: string,
): Promise<{ issue: IssueRow; pullRequest: PullRequestRow }> {
  const index = pathId(rawIndex);
  const row = await findPullRequestByIndex(c.env.DB, found.repo.id, index);
  if (row === null) {
    throw pullRequestNotExistError(found.repo.id, index);
  }
  return row;
}

/** GetReviewByID (models/issues/review.go:253–261) → its 404 message verbatim. */
async function requireReview(c: Context<ApiEnv>, rawId: string): Promise<ReviewRow> {
  const id = pathId(rawId);
  const rows = await drizzle(c.env.DB).select().from(pullReviews).where(eq(pullReviews.id, id)).limit(1).all();
  const row = rows[0];
  if (row === undefined) {
    throw new ApiError(404, `review does not exist [id: ${id}]`);
  }
  return row;
}

/**
 * prepareSingleReview (pull_review.go:709–741): the review must belong to
 * the path's PR (404) and a PENDING review is visible to its reviewer and
 * site admins only (404).
 */
async function prepareSingleReview(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  params: { index: string; id: string },
): Promise<{ review: ReviewRow; issue: IssueRow; pullRequest: PullRequestRow }> {
  const { pullRequest, issue } = await requirePullRequest(c, found, params.index);
  const review = await requireReview(c, params.id);
  if (review.issueId !== issue.id) {
    // pull_review.go:724–727 — a review of another PR is a plain 404.
    throw new ApiError(404, "not found");
  }
  const doer = c.get("authUser");
  if (review.type === ReviewType.Pending && review.reviewerId !== (doer?.id ?? null) && doer?.is_admin !== true) {
    // pull_review.go:730–733 — pending reviews are private to their reviewer.
    throw new ApiError(404, "not found");
  }
  return { review, issue, pullRequest };
}

/** The doer's full user row (requireAuth guarantees presence on write arms). */
async function doerRowOf(c: Context<ApiEnv>, doerId: number): Promise<UserRow | null> {
  const rows = await drizzle(c.env.DB).select().from(users).where(eq(users.id, doerId)).limit(1).all();
  return rows[0] ?? null;
}

/**
 * CanDoerChangeReviewRequests (services/issue/review_request.go:186–226)
 * minus the org-team arm (no unit ACL to consult — documented deviation):
 * not archived, and poster / repo owner / site admin / collaborator.
 */
async function canDoerChangeReviewRequests(c: Context<ApiEnv>, found: RepositoryWithOwner, issue: IssueRow): Promise<boolean> {
  if (found.repo.isArchived) return false;
  const doer = c.get("authUser");
  if (doer === undefined) return false;
  if (doer.is_admin === true) return true;
  if (issue.posterId !== null && doer.id === issue.posterId) return true;
  if (doer.id === found.repo.ownerId) return true;
  return (await collaboratorModeOf(c.env.DB, found.repo.id, doer.id ?? 0)) !== "none";
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** 0001-01-01T00:00:00Z for null timestamps — the Go zero-time wire value. */
function iso(value: Date | null | undefined): string {
  return value === null || value === undefined ? "0001-01-01T00:00:00Z" : value.toISOString();
}

const SUBMITTED_TYPES: readonly number[] = [ReviewType.Approve, ReviewType.Comment, ReviewType.Reject];

/** Map `ReviewType` → the wire `ReviewStateType` (convert/pull_review.go:75–84). */
function reviewStateOf(type: number): "APPROVED" | "PENDING" | "COMMENT" | "REQUEST_CHANGES" | "REQUEST_REVIEW" {
  switch (type) {
    case ReviewType.Approve:
      return "APPROVED";
    case ReviewType.Reject:
      return "REQUEST_CHANGES";
    case ReviewType.Comment:
      return "COMMENT";
    case ReviewType.Request:
      return "REQUEST_REVIEW";
    default:
      return "PENDING";
  }
}

/** The review's code-comment count (GetCodeCommentsCount, review.go:1048–1065). */
async function codeCommentsCount(d1: D1Database, issueId: number, reviewId: number): Promise<number> {
  const rows = await drizzle(d1)
    .select({ value: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.reviewId, reviewId), eq(comments.type, CommentType.Code)))
    .all();
  return Number(rows[0]?.value ?? 0);
}

/**
 * ToPullReview (services/convert/pull_review.go:19–68). The reviewer renders
 * through the embedded-user projection (null when the row is gone —
 * upstream renders a Ghost user; documented deviation).
 */
async function toApiReview(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  review: ReviewRow,
  viewer: Viewer,
): Promise<z.infer<typeof pullReviewSchema>> {
  const origin = viewer.origin;
  const owner = encodeURIComponent(found.repo.ownerNamespace);
  const slug = encodeURIComponent(found.repo.slug);
  const pullUrl = `${origin}/${owner}/${slug}/pulls/${issue.index}`;

  let user: z.infer<typeof embeddedUserSchema> | null = null;
  if (review.reviewerId !== 0) {
    const rows = await drizzle(c.env.DB).select().from(users).where(eq(users.id, review.reviewerId)).limit(1).all();
    user = rows[0] === undefined ? null : apiUserFromRow(rows[0], viewer);
  }

  return {
    id: review.id,
    user,
    team: null,
    state: reviewStateOf(review.type),
    body: review.content ?? "",
    commit_id: review.commitId ?? "",
    stale: review.stale,
    official: review.official,
    dismissed: review.dismissed,
    comments_count: await codeCommentsCount(c.env.DB, issue.id, review.id),
    submitted_at: iso(review.createdAt),
    updated_at: iso(review.updatedAt),
    // HTMLURL (models/issues/review.go:1073–1076) — only submitted reviews
    // get a timeline anchor; pending/request rows render "".
    html_url: SUBMITTED_TYPES.includes(review.type) ? `${pullUrl}#pullrequestreview-${review.id}` : "",
    pull_request_url: pullUrl,
  };
}

/**
 * patch2diff (services/convert/pull_review.go:129–135): the stored hunks
 * render as their LAST hunk only. Created code comments carry the
 * GetCodeCommentPatch port below (a single-hunk cut); patch null on
 * degenerate rows renders "" as before.
 */
function patchToDiffHunk(patch: string | null): string {
  if (patch === null) return "";
  const split = patch.split("\n@@");
  return split.length === 2 ? `@@${split[1]}` : "";
}

// ---------------------------------------------------------------------------
// The diff-hunk capture at code-comment creation — the GetCodeCommentPatch
// port (services/gitdiff/gitdiff.go:1600–1615): upstream stores, with every
// code comment, the cut of the file's diff around the commented line
// (modules/git/diff.go CutDiffAroundLine), and falls back to a synthetic
// context patch read from the file content when the line is unchanged
// (gitdiff.go:1621–1668 GeneratePatchForUnchangedLine). The wire renders it
// through patch2diff → `diff_hunk` (convert/pull_review.go:115).
// ---------------------------------------------------------------------------

/** `setting.UI.CodeCommentLines` default (modules/setting/ui.go:96) — the
 *  context window upstream keeps around the commented line. */
const CODE_COMMENT_LINES = 4;

/** The three-dot diff range the cuts run over (pullRequestDiff's shape). */
interface CodeCommentRange {
  files: DiffFileJson[];
  mergeBase: string | null;
  head: string;
}

/**
 * CutDiffAroundLine (modules/git/diff.go:160–268) over the engine's
 * structured hunks: the first hunk whose target-side range contains the
 * line, kept only down to the CODE_COMMENT_LINES lines ENDING at the
 * commented line (upstream's scan breaks at the target and cuts the
 * trailing window), with the @@ header recomputed for the cut window —
 * or returned as-is when the kept prefix still fits (upstream's no-cut
 * arm, original @@ header). Returns null when no hunk contains the line
 * (the caller falls to the unchanged-line patch).
 *
 * Documented divergences: upstream cuts raw `git diff` text and carries a
 * `\ No newline at end of file` case (a FIXME upstream too — the engine's
 * DiffOp stream has no such markers, so that arm is unreachable here), and
 * the stored patch's `index` header line is omitted (DiffFileJson carries
 * no abbreviated oid pair; every wire consumer renders from the "@@" tail).
 */
function cutDiffAroundLine(file: DiffFileJson, line: number): string | null {
  if (line === 0) return null; // CutDiffAroundLine: "no line or num of lines => no diff"
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

  // Walk the ops keeping everything up to and including the first op that
  // COUNTS on the target side and carries the target's line number —
  // upstream's scan appends it, bumps currentLine past `line`, and breaks.
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
  if (!hit) return null; // defensive: the containment check above already excludes it

  if (kept.length <= CODE_COMMENT_LINES) {
    // No-cut arm: the kept prefix fits — upstream returns the hunk with its
    // ORIGINAL header.
    return [...header, `@@ -${hunk.aStart},${hunk.aLen} +${hunk.bStart},${hunk.bLen} @@`, ...kept.map(opLine)].join("\n");
  }

  // Cut arm: the trailing window of CODE_COMMENT_LINES kept ops, with the
  // begins re-walked from the hunk start (upstream's backward count) and
  // the per-side lengths summed over the window.
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

/**
 * GeneratePatchForUnchangedLine's core (gitdiff.go:1651–1680
 * generatePatchForUnchangedLineFromReader): a synthetic single-file patch of
 * the CODE_COMMENT_LINES lines ending at `line`, every line context-prefixed
 * and the old/new ranges identical. Upstream writes a trailing "\n" after
 * each line (unlike the cut path's plain join — mirrored). Returns null when
 * the line is beyond the content (upstream errors the range read and stores
 * "" — `diff_hunk` renders empty).
 */
function syntheticPatchForUnchangedLine(blobText: string, treePath: string, line: number): string | null {
  const target = Math.abs(line);
  if (target < 1) return null;
  const startLine = Math.max(target - CODE_COMMENT_LINES, 1);
  const allLines = blobText.split("\n");
  const lines: string[] = [];
  for (let n = startLine; n <= target; n++) {
    const value = allLines[n - 1];
    if (value === undefined) break; // scanner hit EOF — shorter range, upstream's posture
    lines.push(value);
  }
  if (lines.length === 0) return null;
  return [
    `diff --git a/${treePath} b/${treePath}`,
    `--- a/${treePath}`,
    `+++ b/${treePath}`,
    `@@ -${startLine},${lines.length} +${startLine},${lines.length} @@`,
    ...lines.map((content) => ` ${content}`),
  ].join("\n") + "\n";
}

/**
 * GetCodeCommentPatch (gitdiff.go:1600–1615) for one created code comment:
 * the diff cut around the line, else the unchanged-line synthetic patch read
 * at the side's context commit — mergeBase for an old-side line (negative),
 * the head-ref tip for a new-side one. Null = nothing derivable (no hunk,
 * no readable blob): the row stores no patch and `diff_hunk` renders "".
 */
async function codeCommentPatch(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
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
  const blob = await engineReads(c.env, found.repo).readBlob(contextCommit, treePath);
  if (blob === null) return null;
  return syntheticPatchForUnchangedLine(new TextDecoder().decode(blob.data), treePath, line);
}

/** ToPullReviewComment (services/convert/pull_review.go:103–127) wire shape. */
async function toApiReviewComment(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  comment: typeof comments.$inferSelect,
  viewer: Viewer,
): Promise<z.infer<typeof pullReviewCommentSchema>> {
  const origin = viewer.origin;
  const owner = encodeURIComponent(found.repo.ownerNamespace);
  const slug = encodeURIComponent(found.repo.slug);
  const pullUrl = `${origin}/${owner}/${slug}/pulls/${issue.index}`;
  const line = Math.abs(comment.line ?? 0);
  const negative = comment.line !== null && comment.line !== undefined && comment.line < 0;

  const userOf = async (userId: number | null): Promise<z.infer<typeof embeddedUserSchema> | null> => {
    if (userId === null || userId === 0) return null;
    const rows = await drizzle(c.env.DB).select().from(users).where(eq(users.id, userId)).limit(1).all();
    return rows[0] === undefined ? null : apiUserFromRow(rows[0], viewer);
  };

  return {
    id: comment.id,
    body: comment.content ?? "",
    user: await userOf(comment.posterId),
    resolver: await userOf(comment.resolveDoerId),
    pull_request_review_id: comment.reviewId ?? 0,
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    path: comment.treePath ?? "",
    commit_id: comment.commitSha ?? "",
    original_commit_id: comment.oldRef ?? (comment.commitSha ?? ""),
    diff_hunk: patchToDiffHunk(comment.patch),
    position: negative ? null : line,
    original_position: negative ? line : null,
    pull_request_url: pullUrl,
    html_url: `${pullUrl}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------------------
// Webhook events — the emitIssueEvent seam (services/issue-events.ts), the
// same guarded waitUntil mechanic every issue-family route rides.
// ---------------------------------------------------------------------------

/**
 * The PullRequestPayload of the review family (modules/structs/hook.go:484
 * + notifier.go:755–777 / :793–815): action, number, pull_request,
 * requested_reviewer, repository, sender, commit_id ("") and — review
 * submissions only — `review` {type: <wire event>, content}.
 */
function reviewEventPayload(options: {
  action: string;
  index: number;
  apiPullRequest: Awaited<ReturnType<typeof toApiPullRequest>>;
  repository: unknown;
  sender: unknown;
  requestedReviewer?: unknown;
  review?: { type: string; content: string };
}): Record<string, unknown> {
  return {
    action: options.action,
    number: options.index,
    pull_request: options.apiPullRequest,
    ...(options.requestedReviewer === undefined ? {} : { requested_reviewer: options.requestedReviewer }),
    repository: options.repository,
    sender: options.sender,
    commit_id: "",
    ...(options.review === undefined ? {} : { review: options.review }),
  };
}

/** The wire event + ReviewPayload.type a submitted review type maps to (notifier.go:755–762). */
function reviewEventTypeOf(
  type: number,
): "pull_request_review_approved" | "pull_request_review_rejected" | "pull_request_review_comment" | null {
  switch (type) {
    case ReviewType.Approve:
      return "pull_request_review_approved";
    case ReviewType.Reject:
      return "pull_request_review_rejected";
    case ReviewType.Comment:
      return "pull_request_review_comment";
    default:
      return null; // PENDING stays silent (notifier.go:763–766)
  }
}

/** One review-submission fan-out (the two write arms share the shape). */
async function emitReviewSubmitted(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  issue: IssueRow,
  pullRequest: PullRequestRow,
  review: ReviewRow,
  viewer: Viewer,
): Promise<void> {
  const eventType = reviewEventTypeOf(review.type);
  if (eventType === null) {
    return; // PENDING stays silent (notifier.go:763–766)
  }
  // The diff-stat trio rides the same conversion (the single converter's
  // GetDiffShortStat block runs on EVERY single AND payload render,
  // convert/pull.go:230-254; the omit arms — no merge base, truncated walk,
  // engine failure :247-250 — stay omitted).
  const diffStats = await pullRequestDiffShortStat(c, found, pullRequest);
  await emitIssueEvent(c, {
    repoId: found.repo.id,
    ownerId: found.repo.ownerId,
    eventType,
    payload: reviewEventPayload({
      action: "reviewed",
      index: issue.index,
      // ToPayloadPullRequest (pull.go:30-37) — the webhook payload renders
      // the head repo regardless of the doer's visibility.
      apiPullRequest: await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", diffStats === null ? undefined : { diffStats }),
      repository: toApiRepository(viewer, found),
      sender: c.get("authUser"),
      requestedReviewer: c.get("authUser"),
      review: { type: eventType, content: review.content ?? "" },
    }),
  });
}

// ---------------------------------------------------------------------------
// The write cores — `submitReview` + the reviewer-request pair — moved to
// api/services/pull-reviews.ts (the §14.6 extraction, specs/email-outbound.md;
// the IssuesService(d1, mailEnv) mail seam threads `c.env` at the call
// sites below). This file keeps the route surface: guards, renderers, and
// the read consults (`latestDecisionReview` / `currentPendingReview` are
// the service module's exports now).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Read consult for routes/pulls.ts: the PR's requested reviewers
// (convert/pull.go:124 LoadRequestedReviewers — the user REQUEST rows).
// ---------------------------------------------------------------------------

export async function requestedReviewersOf(
  d1: D1Database,
  issueId: number,
  viewer: Viewer,
): Promise<z.infer<typeof embeddedUserSchema>[]> {
  const rows = await drizzle(d1)
    .select({ user: users })
    .from(pullReviews)
    .innerJoin(users, eq(users.id, pullReviews.reviewerId))
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.type, ReviewType.Request), sql`${pullReviews.reviewerId} > 0`))
    .orderBy(asc(pullReviews.id))
    .all();
  return rows.map((row) => apiUserFromRow(row.user, viewer));
}

/**
 * preparePullReviewType (pull_review.go:675–707): the wire event →
 * `ReviewType`, with the self-approval/self-rejection 422s and the
 * REQUEST_CHANGES body requirement.
 */
function preparePullReviewType(event: string, body: string, isPoster: boolean): number {
  switch (event) {
    case "APPROVED":
      if (isPoster) {
        throw new ApiError(422, "approve your own pull is not allowed");
      }
      return ReviewType.Approve;
    case "REQUEST_CHANGES":
      if (isPoster) {
        throw new ApiError(422, "reject your own pull is not allowed");
      }
      if (body.trim() === "") {
        throw new ApiError(422, "review event REQUEST_CHANGES requires a body");
      }
      return ReviewType.Reject;
    case "COMMENT":
      return ReviewType.Comment;
    default:
      // PENDING (upstream's default arm, :704–706).
      return ReviewType.Pending;
  }
}

/** pull_review.go:540–543 — the new line wins unless the old one is set. */
function lineOf(comment: { old_position?: number; new_position?: number }): number {
  const oldPosition = comment.old_position ?? 0;
  const newPosition = comment.new_position ?? 0;
  return oldPosition > 0 ? -oldPosition : newPosition;
}

/** The num_comments bump that rides every inserted system comment. */
function numCommentsBump(db: ReturnType<typeof drizzle>, issueId: number, now: Date) {
  return db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issueId));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPullReviewRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/reviews (repoListPullReviews) —
  // FindReviews order (created_unix ASC, id ASC, review_list.go:120–137),
  // pending rows filtered for non-reviewer viewers
  // (convert/pull_review.go:69–73). Headers: upstream's handler calls ONLY
  // SetTotalCountHeader (pull_review.go:102) — X-Total-Count +
  // Access-Control-Expose-Headers append (services/context/base.go:73–77),
  // no SetLinkHeader — so the exact pair is set here, over the VISIBLE set
  // (upstream counts unfiltered; the header divergence is the privacy
  // filter's cost — a hidden pending row would otherwise leak its count).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "List all reviews for a pull request",
      operationId: "repoListPullReviews",
      request: {
        params: z.object(pullIndexParams),
        query: z.object(pageLimitQuery),
      },
      responses: {
        200: { description: "PullReviewList", content: { "application/json": { schema: z.array(pullReviewSchema) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { issue } = await requirePullRequest(c, found, c.req.valid("param").index);
      const opts = parseListOptions(new URL(c.req.url));
      const doer = c.get("authUser");
      const doerId = doer?.id ?? -1;
      const canSeePending = doer?.is_admin === true;

      const allRows = await drizzle(c.env.DB)
        .select()
        .from(pullReviews)
        .where(eq(pullReviews.issueId, issue.id))
        .orderBy(asc(pullReviews.createdAt), asc(pullReviews.id))
        .all();
      const visible = allRows.filter((row) => row.type !== ReviewType.Pending || canSeePending || row.reviewerId === doerId);
      const page = visible.slice((opts.page - 1) * opts.limit, (opts.page - 1) * opts.limit + opts.limit);
      // SetTotalCountHeader verbatim (base.go:73-77): the count header plus
      // the CORS expose append — and NO Link header, upstream's
      // ListPullReviews calls no SetLinkHeader (pull_review.go:98-103).
      c.header("X-Total-Count", String(visible.length));
      c.header("Access-Control-Expose-Headers", "X-Total-Count");
      const rendered = [];
      for (const row of page) {
        rendered.push(await toApiReview(c, found, issue, row, viewer));
      }
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/{index}/reviews (repoCreatePullReview).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a review to a pull request",
      operationId: "repoCreatePullReview",
      request: {
        params: z.object(pullIndexParams),
        body: { content: { "application/json": { schema: createPullReviewOptionsSchema } } },
      },
      responses: {
        200: { description: "PullReview", content: { "application/json": { schema: pullReviewSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { issue, pullRequest } = await requirePullRequest(c, found, c.req.valid("param").index);
      const form = c.req.valid("json");
      const doer = c.get("authUser");
      const doerId = doer.id ?? 0; // requireAuth guarantees the id
      const isPoster = issue.posterId !== null && issue.posterId === doerId;

      const reviewType = preparePullReviewType(form.event ?? "", form.body ?? "", isPoster);

      // Empty commit_id defaults to the head ref tip (pull_review.go:521–536).
      let commitId = form.commit_id ?? "";
      if (commitId === "") {
        const head = await engineReads(c.env, found.repo).readCommit(pullHeadRefName(issue.index));
        commitId = head?.oid ?? "";
      }

      // The comments land as pending code comments on the doer's pending
      // review first (CreateCodeComment loop, pull_review.go:539–560); the
      // submit then converts that very review (GetCurrentReview arm).
      const comments_ = form.comments ?? [];
      if (comments_.length > 0) {
        const now = new Date();
        let pending = await currentPendingReview(c.env.DB, issue.id, doerId);
        if (pending === null) {
          const inserted = await drizzle(c.env.DB)
            .insert(pullReviews)
            .values({ type: ReviewType.Pending, reviewerId: doerId, issueId: issue.id, content: "", createdAt: now, updatedAt: now })
            .returning()
            .all();
          pending = inserted[0]!;
        }
        const pendingId = pending.id;
        // The diff-hunk capture (GetCodeCommentPatch, gitdiff.go:1600–1615):
        // ONE three-dot range read per create request, each comment cut
        // around its line. The range's end is the HEAD REF TIP even when the
        // form carries an explicit commit_id (upstream's patch reads
        // pr.GetGitHeadRefName, review.go:265–273 — only CommitSHA follows
        // the form). A degenerate range (no servable head/base ref, no
        // merge base) captures nothing — rows store no patch and diff_hunk
        // renders "" as before; never a fabricated hunk.
        let range: CodeCommentRange | null = null;
        if (commitId !== "") {
          try {
            const pulled = await pullRequestDiff(c, found, pullRequest);
            if (pulled.mergeBase !== null) range = pulled;
          } catch {
            range = null; // no servable diff range (missing head/base ref) — no hunks
          }
        }
        const patches: Array<string | null> = [];
        for (const comment of comments_) {
          patches.push(range === null ? null : await codeCommentPatch(c, found, range, comment.path, lineOf(comment)));
        }
        const codeCommentInserts = comments_.map((comment, index) =>
          drizzle(c.env.DB).insert(comments).values({
              type: CommentType.Code,
              posterId: doerId,
              issueId: issue.id,
              // pull_review.go:540–543: the new line wins unless the old
              // one is set (stored NEGATIVE, the upstream line convention).
              line: lineOf(comment),
              treePath: comment.path,
              content: comment.body,
              commitSha: commitId,
              oldRef: commitId,
              patch: patches[index] ?? null,
              reviewId: pendingId,
              createdAt: now,
              updatedAt: now,
          }),
        );
        // The leading insert makes the spread a tuple for drizzle's batch.
        await drizzle(c.env.DB).batch([
          codeCommentInserts[0]!,
          ...codeCommentInserts.slice(1),
          numCommentsBump(drizzle(c.env.DB), issue.id, now),
        ]);
      }

      const review = await new PullReviewsService(c.env.DB, c.env).submitReview(found, {
        doerId,
        doerRow: await doerRowOf(c, doerId),
        issue,
        baseBranch: pullRequest.baseBranch,
        reviewType,
        content: form.body ?? "",
        commitId,
      });

      const rendered = await toApiReview(c, found, issue, review, viewer);
      // The PullRequestReview event (notifier.go:751–777) — PENDING silent.
      await emitReviewSubmitted(c, found, issue, pullRequest, review, viewer);
      return c.json(rendered, 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id} (repoGetPullReview).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a specific review for a pull request",
      operationId: "repoGetPullReview",
      request: { params: z.object(reviewIdParams) },
      responses: {
        200: { description: "PullReview", content: { "application/json": { schema: pullReviewSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { review, issue } = await prepareSingleReview(c, found, c.req.valid("param"));
      return c.json(await toApiReview(c, found, issue, review, viewer), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}
  // (repoSubmitPullReview).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Submit a pending review to a pull request",
      operationId: "repoSubmitPullReview",
      request: {
        params: z.object(reviewIdParams),
        body: { content: { "application/json": { schema: submitPullReviewOptionsSchema } } },
      },
      responses: {
        200: { description: "PullReview", content: { "application/json": { schema: pullReviewSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { review, issue, pullRequest } = await prepareSingleReview(c, found, c.req.valid("param"));
      const form = c.req.valid("json");
      const doer = c.get("authUser");
      const doerId = doer.id ?? 0; // requireAuth guarantees the id

      if (review.type !== ReviewType.Pending) {
        // pull_review.go:631–634.
        throw new ApiError(422, "only a pending review can be submitted");
      }
      const isPoster = issue.posterId !== null && issue.posterId === doerId;
      const reviewType = preparePullReviewType(form.event ?? "", form.body ?? "", isPoster);
      if (reviewType === ReviewType.Pending) {
        // pull_review.go:643–646.
        throw new ApiError(422, "review stay pending");
      }

      const head = await engineReads(c.env, found.repo).readCommit(pullHeadRefName(issue.index));
      const submitted = await new PullReviewsService(c.env.DB, c.env).submitReview(found, {
        doerId,
        doerRow: await doerRowOf(c, doerId),
        issue,
        baseBranch: pullRequest.baseBranch,
        reviewType,
        content: form.body ?? "",
        commitId: head?.oid ?? "",
      });

      const rendered = await toApiReview(c, found, issue, submitted, viewer);
      await emitReviewSubmitted(c, found, issue, pullRequest, submitted, viewer);
      return c.json(rendered, 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id}
  // (repoDeletePullReview).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a specific review from a pull request",
      operationId: "repoDeletePullReview",
      request: { params: z.object(reviewIdParams) },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { review, issue } = await prepareSingleReview(c, found, c.req.valid("param"));
      const doer = c.get("authUser");

      // pull_review.go:448–455 — reviewer or site admin.
      if (!doer.is_admin && doer.id !== review.reviewerId) {
        throw new ApiError(403, "no permission to delete comment");
      }
      if (review.type === ReviewType.Request) {
        // DeleteReview refuses request rows (models/issues/review.go:1000–1002);
        // upstream surfaces the wrapper as a 500 — an UNDECLARED runtime-only
        // response (the RUNTIME_ONLY_RESPONSES tables are not extended here).
        throw new ApiError(500, `can not delete ReviewID: ${review.id}`);
      }

      // DeleteReview cascade (:1003–1047): the review's code/review/dismissal
      // comments, the row, then the official-flag restore quirk.
      const db = drizzle(c.env.DB);
      await db.batch([
        db.delete(comments).where(
          and(
            eq(comments.issueId, issue.id),
            eq(comments.reviewId, review.id),
            inArray(comments.type, [CommentType.Code, CommentType.Review, CommentType.DismissReview]),
          ),
        ),
        db.delete(pullReviews).where(eq(pullReviews.id, review.id)),
      ]);
      if (review.official && review.reviewerId !== 0) {
        const restored = await latestDecisionReview(c.env.DB, issue.id, review.reviewerId);
        if (restored !== null) {
          await db.update(pullReviews).set({ official: true }).where(eq(pullReviews.id, restored.id)).run();
        }
      }
      // Silence arm: no webhook on review deletion.
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments
  // (repoGetPullReviewComments).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a specific review for a pull request",
      operationId: "repoGetPullReviewComments",
      request: { params: z.object(reviewIdParams) },
      responses: {
        200: { description: "PullReviewCommentList", content: { "application/json": { schema: z.array(pullReviewCommentSchema) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { review, issue } = await prepareSingleReview(c, found, c.req.valid("param"));
      const rows = await drizzle(c.env.DB)
        .select()
        .from(comments)
        .where(and(eq(comments.issueId, issue.id), eq(comments.reviewId, review.id), eq(comments.type, CommentType.Code)))
        .orderBy(asc(comments.id))
        .all();
      const rendered = [];
      for (const row of rows) {
        rendered.push(await toApiReviewComment(c, found, issue, row, viewer));
      }
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST …/reviews/{id}/dismissals + …/undismissals
  // (repoDismissPullReview / repoUnDismissPullReview) — dismissReview
  // (pull_review.go:1048–1085) over the service port
  // (services/pull/review.go:383–460).
  // -------------------------------------------------------------------------
  const dismissalsRoute = createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/dismissals",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Dismiss a review for a pull request",
    operationId: "repoDismissPullReview",
    request: {
      params: z.object(reviewIdParams),
      body: { content: { "application/json": { schema: dismissPullReviewOptionsSchema } } },
    },
    responses: {
      200: { description: "PullReview", content: { "application/json": { schema: pullReviewSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });
  const undismissalsRoute = createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/undismissals",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Cancel to dismiss a review for a pull request",
    operationId: "repoUnDismissPullReview",
    request: { params: z.object(reviewIdParams) },
    responses: {
      200: { description: "PullReview", content: { "application/json": { schema: pullReviewSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

  const dismissReviewArm = async (
    c: Context<ApiEnv>,
    viewer: Viewer,
    found: RepositoryWithOwner,
    params: { index: string; id: string },
    isDismiss: boolean,
    form: { message?: string; priors?: boolean },
  ): Promise<z.infer<typeof pullReviewSchema>> => {
    // pull_review.go:1049–1052 — repo admin only (the reduced matrix's admin
    // grant or a collaborator-admin row).
    const doer = c.get("authUser");
    const doerId = doer.id ?? 0; // requireAuth guarantees the id
    let isAdmin = repositoryPermissions(viewer, found.repo).admin === true;
    if (!isAdmin) {
      isAdmin = (await collaboratorModeOf(c.env.DB, found.repo.id, doerId)) === "admin";
    }
    if (!isAdmin) {
      throw new ApiError(403, "Must be repo admin");
    }
    const { review, issue, pullRequest } = await prepareSingleReview(c, found, params);

    // pull_review.go:1058–1061 — approve/reject rows only.
    if (review.type !== ReviewType.Approve && review.type !== ReviewType.Reject) {
      throw new ApiError(403, "not need to dismiss this review because it's type is not Approve or change request");
    }
    // ErrDismissRequestOnClosedPR (services/pull/review.go:404–417).
    if (issue.isClosed || pullRequest.hasMerged) {
      throw new ApiError(403, "can't dismiss a review associated to a closed or merged PR");
    }

    const db = drizzle(c.env.DB);
    const now = new Date();
    if (review.dismissed !== isDismiss) {
      // DismissReview (models/issues/review.go:638–652) — flip the flag.
      await db.update(pullReviews).set({ dismissed: isDismiss, updatedAt: now }).where(eq(pullReviews.id, review.id)).run();
    }
    if (isDismiss && (form.priors ?? false)) {
      // services/pull/review.go:423–436 — the reviewer's other undismissed
      // decision rows (scoped to the decision types; DismissReview's own
      // type guard keeps everything else untouched upstream too).
      await db
        .update(pullReviews)
        .set({ dismissed: true, updatedAt: now })
        .where(
          and(
            eq(pullReviews.issueId, issue.id),
            eq(pullReviews.reviewerId, review.reviewerId),
            inArray(pullReviews.type, [ReviewType.Approve, ReviewType.Reject]),
            eq(pullReviews.dismissed, false),
            sql`id != ${review.id}`,
          ),
        )
        .run();
    }
    if (isDismiss) {
      // The CommentTypeDismissReview (32) comment (services/pull/review.go:443–456).
      await db.batch([
        db.insert(comments).values({
          type: CommentType.DismissReview,
          posterId: doerId,
          issueId: issue.id,
          content: form.message ?? "",
          reviewId: review.id,
          createdAt: now,
          updatedAt: now,
        }),
        numCommentsBump(db, issue.id, now),
      ]);
    }

    // Silence arm: upstream has NO webhook on dismissal (mailer/feed only).
    const refreshed = await requireReview(c, params.id);
    return await toApiReview(c, found, issue, refreshed, viewer);
  };

  app.openapi(
    dismissalsRoute,
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const rendered = await dismissReviewArm(c, viewer, found, c.req.valid("param"), true, c.req.valid("json"));
      return c.json(rendered, 200);
    },
    bindValidationHook,
  );
  app.openapi(undismissalsRoute, async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const rendered = await dismissReviewArm(c, viewer, found, c.req.valid("param"), false, { message: "", priors: false });
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST/DELETE …/requested_reviewers (repoCreatePullReviewRequests /
  // repoDeletePullReviewRequests) — apiReviewRequest (pull_review.go:867–956)
  // over the request model arms above.
  // -------------------------------------------------------------------------
  const requestRoute = (method: "post" | "delete") =>
    createRoute({
      method,
      path: "/repos/{owner}/{repo}/pulls/{index}/requested_reviewers",
      middleware: [requireAuth],
      tags: ["repository"],
      summary:
        method === "post" ? "create review requests for a pull request" : "cancel review requests for a pull request",
      operationId: method === "post" ? "repoCreatePullReviewRequests" : "repoDeletePullReviewRequests",
      request: {
        params: z.object(pullIndexParams),
        body: { content: { "application/json": { schema: pullReviewRequestOptionsSchema } } },
      },
      responses: {
        ...(method === "post"
          ? {
              201: { description: "PullReviewList", content: { "application/json": { schema: z.array(pullReviewSchema) } } },
              // The contract's create arm has NO 403 (its runtime writer-gate
              // 403 is the documented runtime-only class); only the DELETE
              // arm declares 403 per the frozen swagger.
            }
          : { 204: { description: "empty" }, 403: forbiddenResponse }),
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    });

  const reviewRequestArm = async (
    c: Context<ApiEnv>,
    viewer: Viewer,
    found: RepositoryWithOwner,
    params: { index: string },
    isAdd: boolean,
    form: { reviewers?: string[]; team_reviewers?: string[] },
  ): Promise<{ created: z.infer<typeof pullReviewSchema>[] } | null> => {
    const { issue, pullRequest } = await requirePullRequest(c, found, params.index);

    // parseReviewersByNames (pull_review.go:826–865): names or emails; the
    // team arm only on org-owned repos. Resolved ONCE, before any mutation
    // (upstream aborts the whole request on the first failure too).
    const resolveReviewer = async (name: string): Promise<UserRow> => {
      const row = name.includes("@")
        ? (await drizzle(c.env.DB).select().from(users).where(eq(users.email, name)).limit(1).all())[0]
        : (await drizzle(c.env.DB).select().from(users).where(eq(users.usernameLower, name.toLowerCase())).limit(1).all())[0];
      if (row === undefined) {
        throw new ApiError(404, `user doesn't exist: ${name}`);
      }
      return row;
    };
    const reviewers: UserRow[] = [];
    for (const name of form.reviewers ?? []) {
      reviewers.push(await resolveReviewer(name));
    }

    const ownerRow = found.owner;
    const teamReviewers: Array<typeof teams.$inferSelect> = [];
    if (ownerRow.type === "org") {
      for (const name of form.team_reviewers ?? []) {
        const team = (
          await drizzle(c.env.DB)
            .select()
            .from(teams)
            .where(and(eq(teams.orgId, ownerRow.id), eq(teams.lowerName, name.toLowerCase())))
            .limit(1)
            .all()
        )[0];
        if (team === undefined) {
          throw new ApiError(404, `team doesn't exist: ${name}`);
        }
        teamReviewers.push(team);
      }
    }

    // isValidReviewRequest (services/issue/review_request.go:41–129).
    const doer = c.get("authUser");
    const doerId = doer.id ?? 0; // requireAuth guarantees the id
    // The USER-request write cores (§14.6's service extraction) — one
    // instance carries both loops' writes; `c.env` threads the mail seam
    // (the PullRequestReviewRequest arm rides the service, next wave).
    const reviews = new PullReviewsService(c.env.DB, c.env);
    const canDoerChange = await canDoerChangeReviewRequests(c, found, issue);
    for (const reviewer of reviewers) {
      if (reviewer.type === "org") {
        throw new ApiError(422, `Organization can't be added as reviewer [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
      }
      if (isAdd) {
        const reviewerViewer: Viewer = { origin: viewer.origin, requester: apiUserFromRow(reviewer, viewer) };
        // The reviewer's read arm rides the same team-aware predicate
        // (SPEC-0007 §3.5) — a team grant admits the reviewer upstream-style.
        const canRead =
          canViewRepository(reviewerViewer, found.repo) ||
          (await doerRepoAccessMode(c.env.DB, found.repo, reviewer.id)) !== "none" ||
          (await collaboratorModeOf(c.env.DB, found.repo.id, reviewer.id)) !== "none";
        if (!canRead) {
          throw new ApiError(422, `Reviewer can't read [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
        }
        if (issue.posterId !== null && reviewer.id === issue.posterId) {
          throw new ApiError(422, `poster of pr can't be reviewer [user_id: ${doerId}, repo_id: ${found.repo.id}]`);
        }
        const lastReview = await latestDecisionReview(c.env.DB, issue.id, reviewer.id);
        const posterReRequest =
          issue.posterId !== null && doerId === issue.posterId && lastReview !== null && lastReview.type !== ReviewType.Request;
        const selfReRequest =
          !found.repo.isArchived && doerId === reviewer.id && lastReview !== null && lastReview.type === ReviewType.Approve;
        if (!canDoerChange && !posterReRequest && !selfReRequest) {
          throw new ApiError(422, `Doer can't choose reviewer [user_id: ${doer.id}, repo_id: ${found.repo.id}]`);
        }
      } else if (!canDoerChange) {
        const lastReview = await latestDecisionReview(c.env.DB, issue.id, reviewer.id);
        const selfDecline = lastReview !== null && lastReview.type === ReviewType.Request && lastReview.reviewerId === doerId;
        if (!selfDecline) {
          throw new ApiError(422, `Doer can't remove reviewer [user_id: ${doer.id}, repo_id: ${found.repo.id}]`);
        }
      }
    }

    // ToPayloadPullRequest (pull.go:30-37) — the review_request webhook
    // payloads (add user/team, remove user) render the head repo regardless
    // of the doer's visibility. The diff-stat trio rides the same conversion
    // (the single converter's GetDiffShortStat block runs on EVERY single
    // AND payload render, convert/pull.go:230-254; the omit arms — no merge
    // base, truncated walk, engine failure :247-250 — stay omitted); the one
    // resolution feeds every payload below (upstream recomputes per
    // conversion — the shared render is the cheaper adapter).
    const diffStats = await pullRequestDiffShortStat(c, found, pullRequest);
    const apiPullRequest = await toApiPullRequest(c.env.DB, viewer, found, issue, pullRequest, "payload", diffStats === null ? undefined : { diffStats });
    const repository = toApiRepository(viewer, found);

    if (isAdd) {
      const created: ReviewRow[] = [];
      for (const reviewer of reviewers) {
        const result = await reviews.addReviewRequest(found, issue, pullRequest, reviewer, doerId);
        if (result !== null) {
          created.push(result);
          // The PullRequestReviewRequest event (notifier.go:793–815) — per
          // actually-created request, action "review_requested".
          await emitIssueEvent(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "pull_request_review_request",
            payload: reviewEventPayload({
              action: "review_requested",
              index: issue.index,
              apiPullRequest,
              repository,
              sender: doer,
              requestedReviewer: apiUserFromRow(reviewer, viewer),
            }),
          });
        }
      }
      // Team arms (AddTeamReviewRequest, review.go:822–876): rows land; one
      // webhook per request with requested_reviewer omitted (deviation
      // documented in the module header).
      // SEAM (next wave): upstream's TEAM-request add notifies too
      // (teamReviewRequestNotify, review_request.go:233) — its mail arm
      // folds HERE beside the webhook emit; TEAM-request REMOVAL is silent
      // (:44–47), so the team block below stays mail-off.
      for (const team of teamReviewers) {
        const existing = (
          await drizzle(c.env.DB)
            .select()
            .from(pullReviews)
            .where(
              and(
                eq(pullReviews.issueId, issue.id),
                eq(pullReviews.type, ReviewType.Request),
                eq(pullReviews.reviewerTeamId, team.id),
              ),
            )
            .limit(1)
            .all()
        )[0];
        if (existing !== undefined) {
          continue; // already requested — silent skip
        }
        if (issue.isClosed || pullRequest.hasMerged) {
          throw new ApiError(403, "cannot request a re-review on a closed or merged PR");
        }
        const now = new Date();
        const db = drizzle(c.env.DB);
        const inserted = await db
          .insert(pullReviews)
          .values({ type: ReviewType.Request, reviewerTeamId: team.id, issueId: issue.id, content: "", createdAt: now, updatedAt: now })
          .returning()
          .all();
        const review = inserted[0]!;
        await db.batch([
          db.insert(comments).values({
            type: CommentType.ReviewRequest,
            posterId: doerId,
            issueId: issue.id,
            reviewId: review.id,
            createdAt: now,
            updatedAt: now,
          }),
          numCommentsBump(db, issue.id, now),
        ]);
        created.push(review);
        await emitIssueEvent(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request_review_request",
          payload: reviewEventPayload({
            action: "review_requested",
            index: issue.index,
            apiPullRequest,
            repository,
            sender: doer,
          }),
        });
      }
      const rendered = [];
      for (const review of created) {
        rendered.push(await toApiReview(c, found, issue, review, viewer));
      }
      return { created: rendered };
    }

    // The remove arm: user requests notify (services/issue/review_request.go
    // ReviewRequest — comment != nil → notifier); TEAM-request removal is
    // SILENT (:44–47 — `!isAdd` returns before the notifier). Silence on
    // no-ops (nothing removed → no event, upstream comment == nil).
    for (const reviewer of reviewers) {
      const removed = await reviews.removeReviewRequest(found, issue, pullRequest.baseBranch, reviewer, doerId);
      if (removed) {
        await emitIssueEvent(c, {
          repoId: found.repo.id,
          ownerId: found.repo.ownerId,
          eventType: "pull_request_review_request",
          payload: reviewEventPayload({
            action: "review_request_removed",
            index: issue.index,
            apiPullRequest,
            repository,
            sender: doer,
            requestedReviewer: apiUserFromRow(reviewer, viewer),
          }),
        });
      }
    }
    for (const team of teamReviewers) {
      const row = (
        await drizzle(c.env.DB)
          .select()
          .from(pullReviews)
          .where(
            and(eq(pullReviews.issueId, issue.id), eq(pullReviews.type, ReviewType.Request), eq(pullReviews.reviewerTeamId, team.id)),
          )
          .limit(1)
          .all()
      )[0];
      if (row === undefined) {
        continue;
      }
      const now = new Date();
      const db = drizzle(c.env.DB);
      await db.batch([
        db.delete(pullReviews).where(eq(pullReviews.id, row.id)),
        db.insert(comments).values({
          type: CommentType.ReviewRequest,
          posterId: doerId,
          issueId: issue.id,
          removedAssignee: 1,
          createdAt: now,
          updatedAt: now,
        }),
        numCommentsBump(db, issue.id, now),
      ]);
      // No webhook — upstream's TeamReviewRequest never notifies on removal.
    }
    return null;
  };

  app.openapi(
    requestRoute("post"),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const result = await reviewRequestArm(c, viewer, found, c.req.valid("param"), true, c.req.valid("json"));
      return c.json(result?.created ?? [], 201);
    },
    bindValidationHook,
  );
  app.openapi(
    requestRoute("delete"),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      await reviewRequestArm(c, viewer, found, c.req.valid("param"), false, c.req.valid("json"));
      return c.body(null, 204);
    },
    bindValidationHook,
  );
}
