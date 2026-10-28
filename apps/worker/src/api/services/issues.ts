import { and, asc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Context } from "hono";

import {
  comments,
  issueAssignees,
  issueAttachments,
  issueContentHistory,
  issueDependencies,
  issueLabels,
  issuePins,
  issueStopwatches,
  issueSubscriptions,
  issues,
  labels,
  milestones,
  notificationStates,
  projectIssues,
  pullRequests,
  reactions,
  repositories,
  trackedTimes,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueError } from "../../issues/errors";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { CommentRow, IssueRow, LabelRow, MilestoneRow, PullRequestRow } from "../../issues/service";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";
import type { Comment, Issue, TimelineComment } from "../models/issue";
import type { User } from "../models/user";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "./blocks";
import { findCollaborator } from "./repo-collaborators";
import { toApiPullRequest } from "./pulls";
import { toApiMilestone } from "./milestones";
import {
  apiRepositoryUrl,
  apiUserFromRow,
  findRepositoryById,
  findUserByName,
  GO_ZERO_TIME,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "./repository";

/**
 * Issue-block reads/converters backing the tier-1 `issue` routes (SPEC-0004
 * §2.4 rows issueListIssues … issueSearchIssues; behavior per SPEC-0005
 * §2.2). Mutations ride the landed SPEC-0005 IssuesService (create, close/
 * reopen, comment add, label set/replace/clear); this module adds what the
 * data layer deliberately does not model: the wire converters (upstream
 * `services/convert`), the filtered list/search reads, the comment edit/
 * delete, the issue-edit field writes upstream owns in services/issue, and
 * the issue-delete cascade.
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - Issue converter: `services/convert/issue.go toIssue` (URL/HTMLURL from
 *     Issue.APIURL/HTMLURL, ToAuthor poster, ToAPIMilestone milestone,
 *     SliceNilAsEmpty labels, PullRequestMeta, deadline/closed pointers,
 *     NumComments, PinOrder -1→0 (LoadPinOrder, models/issues/issue.go:272),
 *     TimeEstimate, ContentVersion);
 *   - Comment converter: `services/convert/issue_comment.go ToAPIComment`
 *     (HTMLURL = issue HTMLURL + `#issuecomment-<id>`, IssueURL "" for PRs,
 *     PRURL "" for issues);
 *   - Timeline converter: `services/convert/issue_comment.go
 *     ToTimelineComment` + `CommentType.String()` (models/issues/comment.go
 *     commentStrings);
 *   - list/search filters: `routers/api/v1/repo/issue.go ListIssues/
 *     SearchIssues` + `routers/common/issue_filter.go` (state/type parse);
 *     `GetQueryBeforeSince` (services/context/utils.go) RFC3339 → 422;
 *   - comment edit/delete: `routers/api/v1/repo/issue_comment.go
 *     editIssueComment/deleteIssueComment` (HasContentSupport gate);
 *   - issue delete: `services/issue/issue.go deleteIssue` (the DeleteBeans
 *     cascade + DecrRepoIssueNumbers; the index counter is never rewound)
 *     plus its webhook pair — `services/webhook/notifier.go DeleteIssue:313`
 *     fires the `action=deleted` Issue/PullRequest payload from exactly the
 *     v1 DELETE route (`routers/api/v1/repo/issue.go:851`→`:886` →
 *     `services/issue/issue.go:155`→`:183`); ours emits from the same
 *     `deleteIssueCascade` funnel so API and any UI delete path emit
 *     identically.
 */

// ---------------------------------------------------------------------------
// URL helpers (upstream Issue/Comment URL methods, models/issues)
// ---------------------------------------------------------------------------

/** `Issue.APIURL` — `{repo APIURL}/issues/{index}`. */
export function issueApiUrl(pair: RepositoryWithOwner, origin: string, index: number): string {
  return `${apiRepositoryUrl(pair, origin)}/issues/${index}`;
}

/** `Issue.HTMLURL` — `{origin}/{owner}/{repo}/issues/{index}`. */
export function issueHtmlUrl(pair: RepositoryWithOwner, origin: string, index: number): string {
  return `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}/issues/${index}`;
}

/** `Comment.HTMLURL` — the issue page anchor (`Comment.hashLink` + `HashTag`).
 *  Upstream Issue.HTMLURL branches on IsPull (issue.go:386-394 — path
 *  "pulls"); the callers pass the row's kind so a PR comment anchors under
 *  /pulls/ (the activity matrix's escalated divergence). */
export function commentHtmlUrl(
  pair: RepositoryWithOwner,
  origin: string,
  issueIndex: number,
  isPull: boolean,
  commentId: number,
): string {
  const base = `${origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}/${isPull ? "pulls" : "issues"}/${issueIndex}`;
  return `${base}#issuecomment-${commentId}`;
}

// ---------------------------------------------------------------------------
// Row → wire converters
// ---------------------------------------------------------------------------

/** Go's zero time for unset timestamp mirrors (nullable schema columns). */
function isoOrZero(date: Date | null): string {
  return date === null ? GO_ZERO_TIME : date.toISOString();
}

/** Numeric rendering of the text registry id (services/repository.ts rule). */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** WIP prefixes (setting.Repository.PullRequest.WorkInProgressPrefixes default). */
const WIP_PREFIXES: readonly string[] = ["WIP:", "[WIP]", "WIP]", "Draft"];

/** `HasWorkInProgressPrefix` — ASCII case-insensitive prefix match. */
export function hasWorkInProgressPrefix(title: string): boolean {
  return WIP_PREFIXES.some((prefix) => title.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase());
}

/** The embedded `RepositoryMeta` block (convert.ToAPIIssue issue.Repo). */
export function toRepositoryMeta(pair: RepositoryWithOwner): { id: number; name: string; owner: string; full_name: string } {
  return {
    id: repoIdNumber(pair.repo.id),
    name: pair.repo.slug,
    owner: pair.repo.ownerNamespace,
    full_name: `${pair.repo.ownerNamespace}/${pair.repo.slug}`,
  };
}

/** Issue labels join read (convert `issue.LoadLabels`), id order. */
export async function issueLabelRows(d1: D1Database, issueId: number): Promise<LabelRow[]> {
  const rows = await drizzle(d1)
    .select({ label: labels })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(eq(issueLabels.issueId, issueId))
    .orderBy(asc(labels.id))
    .all();
  return rows.map((row) => row.label);
}

/**
 * The wire Label for issue embedding — same shape the repo-label routes
 * render (`convert.ToLabel`): hash-less lowercase color, `{repo APIURL}/labels/{id}` URL.
 */
export function toEmbeddedLabel(row: LabelRow, pair: RepositoryWithOwner, origin: string): {
  id: number;
  name: string;
  exclusive: boolean;
  color: string;
  description: string;
  is_archived: boolean;
  url: string;
} {
  return {
    id: row.id,
    name: row.name,
    exclusive: row.exclusive,
    color: (row.color ?? "").replace(/^#+/, "").toLowerCase(),
    description: row.description ?? "",
    is_archived: row.archivedAt !== null,
    url: `${issueLabelApiUrlBase(row, pair, origin)}/labels/${row.id}`,
  };
}

/**
 * `convert.ToLabel`'s URL branch (services/convert/issue.go:269-280) for a
 * label rendered in a repo/issue context: repo rows use the repo API URL,
 * ORG rows (`repo_id` NULL, `org_id` set — labels an org-owned repo's issues
 * carry alongside repo labels) use `{origin}/api/v1/orgs/{owner}/labels/{id}`
 * when the repo's owner is that org (url.PathEscape → encodeURIComponent).
 */
export function issueLabelApiUrlBase(row: LabelRow, pair: RepositoryWithOwner, origin: string): string {
  if (row.repoId === null && row.orgId !== null && pair.owner.type === "org") {
    return `${origin}/api/v1/orgs/${encodeURIComponent(pair.owner.username)}`;
  }
  return apiRepositoryUrl(pair, origin);
}

/** Poster → `convert.ToAuthor` (unknown/absent poster → null). */
async function toPoster(d1: D1Database, viewer: Viewer, posterId: number | null): Promise<User | null> {
  if (posterId === null) {
    return null;
  }
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.id, posterId))
    .limit(1)
    .then((rows) => rows[0]);
  return row === undefined ? null : apiUserFromRow(row, viewer);
}

/** The PullRequestMeta block for PR issues (convert `issue.LoadPullRequest`).
 *  `preloadedRow` is the caller-held pull_requests row (toApiPullRequest's B1
 *  pass-through — the audit's redundant re-select) or the page batch's row;
 *  omitted keeps the per-row select for the single-item routes. */
async function pullRequestMetaOf(
  d1: D1Database,
  pair: RepositoryWithOwner,
  origin: string,
  issue: IssueRow,
  preloadedRow?: PullRequestRow,
): Promise<{ merged: boolean; merged_at: string | null; draft: boolean; html_url: string } | null> {
  if (!issue.isPull) {
    return null;
  }
  const pr =
    preloadedRow ??
    (await drizzle(d1)
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.issueId, issue.id))
      .limit(1)
      .then((rows) => rows[0]));
  const merged = pr?.hasMerged ?? false;
  return {
    merged,
    merged_at: merged && pr?.mergedAt ? pr.mergedAt.toISOString() : null,
    // IsWorkInProgress: the PR title prefix check (models/issues/pull.go:661).
    draft: hasWorkInProgressPrefix(issue.title),
    html_url: issueHtmlUrl(pair, origin, issue.index),
  };
}

/**
 * `issue.LoadPinOrder` (models/issues/issue.go:272-284) — the pinned row's
 * pin_order, or the unpinned sentinel -1 (mapped to 0 by the converter).
 */
async function pinOrderOf(d1: D1Database, issueId: number): Promise<number> {
  const row = await drizzle(d1)
    .select({ pinOrder: issuePins.pinOrder })
    .from(issuePins)
    .where(eq(issuePins.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0]);
  return row === undefined ? -1 : row.pinOrder;
}

// ---------------------------------------------------------------------------
// Page-scoped render prefetch (the list routes' N+1 collapse)
//
// The query-shape audit (docs/research/query-shape-audit.md A2/A3): a list
// page rendered one poster/label/pin/milestone/PR-row select PER ROW —
// `2 + N×3..5` D1 roundtrips on the default /repos/{owner}/{repo}/issues page
// (N=30) and more on /pulls. `prefetchIssueRenderContext` batches each arm
// across the page into ONE inArray select per entity kind; the list routes
// hand the maps to `toApiIssue` through its optional `preload`. Behavior
// parity: a map miss renders exactly what the per-row select miss renders
// (null poster, empty labels, the -1 pin sentinel, null milestone, no PR
// meta) — the single-item routes keep the unbatched per-row path verbatim.
// ---------------------------------------------------------------------------

/** Per-entity page rows backing `toApiIssue`'s batched render. */
export interface IssueRenderContext {
  /** Poster rows by user id (a missing id renders the per-row null). */
  posters: Map<number, UserRow>;
  /** Label rows per issue id, each bucket in label-id order (the per-row
   *  `issueLabelRows` orderBy, preserved by grouping the globally ordered
   *  join rows). */
  labelsByIssue: Map<number, LabelRow[]>;
  /** Pin order per issue id; a missing issue renders the -1 sentinel. */
  pinOrders: Map<number, number>;
  /** Milestone rows by id; a deleted milestone row stays absent (null). */
  milestones: Map<number, MilestoneRow>;
  /** PR rows by issue id (PR issues only). */
  pullRequestsByIssue: Map<number, PullRequestRow>;
}

/** Optional preloaded reads for `toApiIssue` — the list routes' batch
 *  plumbing; omitted keeps the per-row selects (single-item routes). */
export interface IssueRenderPreload {
  /** The page context from `prefetchIssueRenderContext`. */
  context?: IssueRenderContext;
  /** The PR row the caller already holds (toApiPullRequest — the audit's B1
   *  redundant-re-select fix). Takes precedence over the context map. */
  prRow?: PullRequestRow;
}

/**
 * One batched read per entity kind for the page's rows (posters, the label
 * join, pin orders, milestones, PR rows), fanned with Promise.all. Empty or
 * homogeneous pages skip their arms entirely — 0 statements there, exactly
 * like the per-row path. The id lists stay far under the D1 100-variable
 * cap: the API paging clamps at 50 rows (pagination.ts MAX_RESPONSE_ITEMS).
 */
export async function prefetchIssueRenderContext(d1: D1Database, pageRows: IssueRow[]): Promise<IssueRenderContext> {
  const issueIds = pageRows.map((row) => row.id);
  const posterIds = [...new Set(pageRows.flatMap((row) => (row.posterId === null ? [] : [row.posterId])))];
  const milestoneIds = [...new Set(pageRows.flatMap((row) => (row.milestoneId === null ? [] : [row.milestoneId])))];
  const prIssueIds = pageRows.flatMap((row) => (row.isPull ? [row.id] : []));
  const db = drizzle(d1);
  const [posterRows, labelRows, pinRows, milestoneRows, prRows] = await Promise.all([
    posterIds.length > 0 ? db.select().from(users).where(inArray(users.id, posterIds)).all() : Promise.resolve([]),
    issueIds.length > 0
      ? db
          .select({ issueId: issueLabels.issueId, label: labels })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(inArray(issueLabels.issueId, issueIds))
          .orderBy(asc(labels.id))
          .all()
      : Promise.resolve([]),
    issueIds.length > 0
      ? db
          .select({ issueId: issuePins.issueId, pinOrder: issuePins.pinOrder })
          .from(issuePins)
          .where(inArray(issuePins.issueId, issueIds))
          .all()
      : Promise.resolve([]),
    milestoneIds.length > 0 ? db.select().from(milestones).where(inArray(milestones.id, milestoneIds)).all() : Promise.resolve([]),
    prIssueIds.length > 0 ? db.select().from(pullRequests).where(inArray(pullRequests.issueId, prIssueIds)).all() : Promise.resolve([]),
  ]);
  const labelsByIssue = new Map<number, LabelRow[]>();
  for (const row of labelRows) {
    const bucket = labelsByIssue.get(row.issueId);
    if (bucket === undefined) {
      labelsByIssue.set(row.issueId, [row.label]);
    } else {
      bucket.push(row.label);
    }
  }
  return {
    posters: new Map(posterRows.map((row) => [row.id, row])),
    labelsByIssue,
    pinOrders: new Map(pinRows.map((row) => [row.issueId, row.pinOrder])),
    milestones: new Map(milestoneRows.map((row) => [row.id, row])),
    pullRequestsByIssue: new Map(prRows.map((row) => [row.issueId, row])),
  };
}

/** The context twin of `toPoster` — identical null semantics, 0 reads. */
function posterFromContext(context: IssueRenderContext, viewer: Viewer, posterId: number | null): User | null {
  if (posterId === null) {
    return null;
  }
  const row = context.posters.get(posterId);
  return row === undefined ? null : apiUserFromRow(row, viewer);
}

/**
 * `convert.ToIssue` → the contract `Issue`. Enrichment reads per render:
 * poster row, label join, milestone row, PR row (PRs only) — the same loads
 * upstream's toIssue performs (LoadPoster/LoadLabels/LoadMilestone/
 * LoadPullRequest). LIST routes pass `preload` (the page-scoped
 * `prefetchIssueRenderContext` maps + the caller-held PR row) so the reads
 * collapse to 0 per row; without it the per-row selects run exactly as
 * before — the single-item routes' unchanged path.
 */
export async function toApiIssue(d1: D1Database, viewer: Viewer, pair: RepositoryWithOwner, issue: IssueRow, preload?: IssueRenderPreload): Promise<Issue> {
  const context = preload?.context;
  const poster = context === undefined ? await toPoster(d1, viewer, issue.posterId) : posterFromContext(context, viewer, issue.posterId);
  const labelRows = context === undefined ? await issueLabelRows(d1, issue.id) : (context.labelsByIssue.get(issue.id) ?? []);
  const pinOrder = context === undefined ? await pinOrderOf(d1, issue.id) : (context.pinOrders.get(issue.id) ?? -1);
  const milestoneRow =
    issue.milestoneId === null
      ? null
      : context === undefined
        ? await drizzle(d1)
            .select()
            .from(milestones)
            .where(eq(milestones.id, issue.milestoneId))
            .limit(1)
            .then((rows) => (rows[0] === undefined ? null : rows[0]))
        : (context.milestones.get(issue.milestoneId) ?? null);
  const pullRequest = await pullRequestMetaOf(d1, pair, viewer.origin, issue, preload?.prRow ?? context?.pullRequestsByIssue.get(issue.id));

  return {
    id: issue.id,
    url: issueApiUrl(pair, viewer.origin, issue.index),
    html_url: issueHtmlUrl(pair, viewer.origin, issue.index),
    number: issue.index,
    user: poster,
    title: issue.title,
    body: issue.content ?? "",
    ref: issue.ref ?? "",
    assets: [],
    labels: labelRows.map((row) => toEmbeddedLabel(row, pair, viewer.origin)),
    milestone: milestoneRow === null ? null : toApiMilestone(milestoneRow),
    projects: null, // projects are tier 3 (SPEC-0004 §2.6)
    // The issue_assignees TABLE landed (migration 0012) but the shared
    // converter still renders the un-enriched shape — the assignee/assignees
    // fill is carried per-family (the assign emissions and the t2 responses
    // render it via the toApiIssueWithAssignees-style overlays) until a
    // dedicated fold-in wave flips every issue response at once.
    assignee: null,
    assignees: null,
    state: issue.isClosed ? "closed" : "open",
    is_locked: issue.isLocked,
    comments: issue.numComments,
    created_at: isoOrZero(issue.createdAt),
    updated_at: isoOrZero(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : issue.closedAt.toISOString(),
    due_date: issue.deadlineAt === null ? null : issue.deadlineAt.toISOString(),
    time_estimate: issue.timeEstimate,
    pull_request: pullRequest,
    repository: toRepositoryMeta(pair),
    pin_order: pinOrder === -1 ? 0 : pinOrder, // LoadPinOrder -1 (unpinned) → 0
    content_version: issue.contentVersion,
  };
}

/**
 * One batched poster read for a comment page (the query-shape audit's A7 —
 * upstream `comments.LoadPosters` is the same fix): one inArray select over
 * the distinct poster ids; a no-comment or all-null-poster page skips to
 * zero statements, exactly like the per-row path.
 */
export async function prefetchCommentPosters(d1: D1Database, commentRows: CommentRow[]): Promise<Map<number, UserRow>> {
  const posterIds = [...new Set(commentRows.flatMap((row) => (row.posterId === null ? [] : [row.posterId])))];
  if (posterIds.length === 0) {
    return new Map();
  }
  const rows = await drizzle(d1).select().from(users).where(inArray(users.id, posterIds)).all();
  return new Map(rows.map((row) => [row.id, row]));
}

/** The context twin of `toPoster` for the comment pages — identical null
 *  semantics, 0 reads. */
function posterFromMap(posters: Map<number, UserRow>, viewer: Viewer, posterId: number | null): User | null {
  if (posterId === null) {
    return null;
  }
  const row = posters.get(posterId);
  return row === undefined ? null : apiUserFromRow(row, viewer);
}

/**
 * `convert.ToAPIComment` → the contract `Comment`. `issue_url` is the issue
 * page for issues and the EMPTY STRING for PRs; `pull_request_url` the
 * mirror image (models/issues/comment.go IssueURL/PRURL). The poster row is
 * fetched per render (upstream `comments.LoadPosters`); the comment-LIST
 * routes pass `preload.posters` (the page-scoped `prefetchCommentPosters`
 * map) so the read collapses to a lookup — a map miss renders the per-row
 * null verbatim. Omitted keeps the per-row select (single-item routes).
 */
export async function toApiComment(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  comment: CommentRow,
  preload?: { posters?: Map<number, UserRow> },
): Promise<Comment> {
  const poster = preload?.posters === undefined ? await toPoster(d1, viewer, comment.posterId) : posterFromMap(preload.posters, viewer, comment.posterId);
  const htmlUrl = commentHtmlUrl(pair, viewer.origin, issue.index, issue.isPull, comment.id);
  const issuePageUrl = issueHtmlUrl(pair, viewer.origin, issue.index);
  return {
    id: comment.id,
    html_url: htmlUrl,
    pull_request_url: issue.isPull ? issuePageUrl : "",
    issue_url: issue.isPull ? "" : issuePageUrl,
    user: poster,
    body: comment.content ?? "",
    assets: [],
    created_at: isoOrZero(comment.createdAt),
    updated_at: isoOrZero(comment.updatedAt),
  };
}

/** `CommentType.String()` — the commentStrings table (models/issues/comment.go). */
export const COMMENT_TYPE_NAMES: readonly string[] = [
  "comment",
  "reopen",
  "close",
  "issue_ref",
  "commit_ref",
  "comment_ref",
  "pull_ref",
  "label",
  "milestone",
  "assignees",
  "change_title",
  "delete_branch",
  "start_tracking",
  "stop_tracking",
  "add_time_manual",
  "cancel_tracking",
  "added_deadline",
  "modified_deadline",
  "removed_deadline",
  "add_dependency",
  "remove_dependency",
  "code",
  "review",
  "lock",
  "unlock",
  "change_target_branch",
  "delete_time_manual",
  "review_request",
  "merge_pull",
  "pull_push",
  "project",
  "project_board", // FIXME upstream: the name should be project_column
  "dismiss_review",
  "change_issue_ref",
  "pull_scheduled_merge",
  "pull_cancel_scheduled_merge",
  "pin",
  "unpin",
  "change_time_estimate",
];

/** `RefAction.String()` (modules/references/references.go:66–76). */
function refActionName(action: number | null): string {
  switch (action) {
    case 1:
      return "closes";
    case 2:
      return "reopens";
    case 3:
      return "neutered";
    default:
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Timeline render prefetch (the query-shape audit's A5)
//
// The timeline route rendered each row with 1..5 serial selects — the poster
// plus up to four metadata rows the timeline's entity kinds carry and the
// issue-list context does not: the OLD milestone, the new milestone, the
// per-comment label, the assignee. `prefetchTimelineContext` batches each
// arm across the page into ONE inArray select per entity kind; the route
// hands the maps to `toTimelineComment` through its optional `preload`.
// Behavior parity: a map miss renders exactly what the per-row select miss
// renders (null poster, null old/new milestone, null label, null assignee)
// — omitted preload keeps the per-row selects verbatim.
// ---------------------------------------------------------------------------

/** Per-entity page rows backing `toTimelineComment`'s batched render. */
export interface TimelineRenderContext {
  /** Comment poster rows by user id (a missing id renders the per-row null). */
  posters: Map<number, UserRow>;
  /** Milestone rows by id — the union of the rows' old AND new milestone
   *  ids; a deleted (dangling) milestone row stays absent → the per-row null. */
  milestones: Map<number, MilestoneRow>;
  /** Label rows by id (the per-comment `label` arm); a dangling id → null. */
  labels: Map<number, LabelRow>;
  /** Assignee rows by user id (the per-comment `assignee` arm). */
  assignees: Map<number, UserRow>;
}

/**
 * One batched read per entity kind for the timeline page's rows (posters,
 * milestones, labels, assignees), fanned with Promise.all. Empty pages skip
 * every arm entirely — 0 statements there, exactly like the per-row path
 * (whose empty page also fans nothing). The id lists stay far under the D1
 * 100-variable cap: the API paging clamps at 50 rows
 * (pagination.ts MAX_RESPONSE_ITEMS).
 */
export async function prefetchTimelineContext(d1: D1Database, commentRows: CommentRow[]): Promise<TimelineRenderContext> {
  const posterIds = [...new Set(commentRows.flatMap((row) => (row.posterId === null ? [] : [row.posterId])))];
  const milestoneIds = [
    ...new Set(
      commentRows.flatMap((row) => [
        ...(row.oldMilestoneId === null || row.oldMilestoneId === undefined ? [] : [row.oldMilestoneId]),
        ...(row.milestoneId === null || row.milestoneId === undefined ? [] : [row.milestoneId]),
      ]),
    ),
  ];
  const labelIds = [...new Set(commentRows.flatMap((row) => (row.labelId === null || row.labelId === undefined ? [] : [row.labelId])))];
  const assigneeIds = [...new Set(commentRows.flatMap((row) => (row.assigneeId === null || row.assigneeId === undefined ? [] : [row.assigneeId])))];
  const db = drizzle(d1);
  const [posterRows, milestoneRows, labelRows, assigneeRows] = await Promise.all([
    posterIds.length > 0 ? db.select().from(users).where(inArray(users.id, posterIds)).all() : Promise.resolve([]),
    milestoneIds.length > 0 ? db.select().from(milestones).where(inArray(milestones.id, milestoneIds)).all() : Promise.resolve([]),
    labelIds.length > 0 ? db.select().from(labels).where(inArray(labels.id, labelIds)).all() : Promise.resolve([]),
    assigneeIds.length > 0 ? db.select().from(users).where(inArray(users.id, assigneeIds)).all() : Promise.resolve([]),
  ]);
  return {
    posters: new Map(posterRows.map((row) => [row.id, row])),
    milestones: new Map(milestoneRows.map((row) => [row.id, row])),
    labels: new Map(labelRows.map((row) => [row.id, row])),
    assignees: new Map(assigneeRows.map((row) => [row.id, row])),
  };
}

/** The context twin of the per-row milestone select — identical null
 *  semantics (null id or a deleted row → null), 0 reads. */
function milestoneFromMap(rows: Map<number, MilestoneRow>, id: number | null | undefined): MilestoneRow | null {
  return id === null || id === undefined ? null : (rows.get(id) ?? null);
}

/** The context twin of the per-row label select — identical null semantics,
 *  0 reads. */
function labelFromMap(rows: Map<number, LabelRow>, id: number | null | undefined): LabelRow | null {
  return id === null || id === undefined ? null : (rows.get(id) ?? null);
}

/** The context twin of the per-row assignee select — returns the RAW row
 *  (the render's `apiUserFromRow` call is shared with the per-row arm);
 *  identical null semantics, 0 reads. */
function assigneeRowFromMap(rows: Map<number, UserRow>, id: number | null | undefined): UserRow | null {
  return id === null || id === undefined ? null : (rows.get(id) ?? null);
}

/**
 * Timeline renderability — upstream drops `CommentTypeCode` rows from the
 * timeline (ListIssueCommentsAndTimeline) and xref rows whose reference
 * repo is unreadable (isXRefCommentAccessible). Reviews/code comments are
 * tier 2 (no rows exist yet) and xrefs are same-repo only, so nothing is
 * filtered in practice today; the predicates stay for parity.
 */
/**
 * `convert.ToTimelineComment` → the contract `TimelineComment`. Emits the
 * metadata subset our comment rows carry: old/new title (type 10), label
 * (type 7), old/milestone (type 8), old/new ref (types 3–6/33), assignee +
 * removed flag (type 9), ref commit sha + action. Deferred metadata renders
 * the Go zero exactly like upstream's empty columns: projects, tracked
 * times, reviews, teams (tier 2/3 surfaces), and the xref/dependency issue
 * enrichment (the xref writers land with the push pipeline).
 *
 * The poster plus up to four metadata rows (old/new milestone, label,
 * assignee) are fetched per render; the timeline ROUTE passes `preload` (the
 * page-scoped `prefetchTimelineContext` maps — the query-shape audit's A5)
 * so the reads collapse to lookups — a map miss renders the per-row null
 * verbatim. Omitted keeps the per-row selects (single-item and fallback
 * callers).
 */
export async function toTimelineComment(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  comment: CommentRow,
  preload?: TimelineRenderContext,
): Promise<TimelineComment> {
  const poster = preload === undefined ? await toPoster(d1, viewer, comment.posterId) : posterFromMap(preload.posters, viewer, comment.posterId);
  const issuePageUrl = issueHtmlUrl(pair, viewer.origin, issue.index);
  const htmlUrl = commentHtmlUrl(pair, viewer.origin, issue.index, issue.isPull, comment.id);

  const [oldMilestoneRow, milestoneRow, labelRow, assigneeRow] = await Promise.all([
    preload !== undefined
      ? milestoneFromMap(preload.milestones, comment.oldMilestoneId)
      : comment.oldMilestoneId === null || comment.oldMilestoneId === undefined
        ? Promise.resolve(null)
        : drizzle(d1)
            .select()
            .from(milestones)
            .where(eq(milestones.id, comment.oldMilestoneId))
            .limit(1)
            .then((rows) => (rows[0] === undefined ? null : rows[0])),
    preload !== undefined
      ? milestoneFromMap(preload.milestones, comment.milestoneId)
      : comment.milestoneId === null || comment.milestoneId === undefined
        ? Promise.resolve(null)
        : drizzle(d1)
            .select()
            .from(milestones)
            .where(eq(milestones.id, comment.milestoneId))
            .limit(1)
            .then((rows) => (rows[0] === undefined ? null : rows[0])),
    preload !== undefined
      ? labelFromMap(preload.labels, comment.labelId)
      : comment.labelId === null || comment.labelId === undefined
        ? Promise.resolve(null)
        : drizzle(d1)
            .select()
            .from(labels)
            .where(eq(labels.id, comment.labelId))
            .limit(1)
            .then((rows) => (rows[0] === undefined ? null : rows[0])),
    preload !== undefined
      ? assigneeRowFromMap(preload.assignees, comment.assigneeId)
      : comment.assigneeId === null || comment.assigneeId === undefined
        ? Promise.resolve(null)
        : drizzle(d1)
            .select()
            .from(users)
            .where(eq(users.id, comment.assigneeId))
            .limit(1)
            .then((rows) => (rows[0] === undefined ? null : rows[0])),
  ]);

  return {
    id: comment.id,
    type: COMMENT_TYPE_NAMES[comment.type] ?? "comment",
    html_url: htmlUrl,
    pull_request_url: issue.isPull ? issuePageUrl : "",
    issue_url: issue.isPull ? "" : issuePageUrl,
    user: poster,
    body: comment.content ?? "",
    created_at: isoOrZero(comment.createdAt),
    updated_at: isoOrZero(comment.updatedAt),
    old_project_id: 0, // projects tier 3
    project_id: 0,
    old_milestone: oldMilestoneRow === null ? null : toApiMilestone(oldMilestoneRow),
    milestone: milestoneRow === null ? null : toApiMilestone(milestoneRow),
    tracked_time: null, // times/stopwatches tier 2
    old_title: comment.oldTitle ?? "",
    new_title: comment.newTitle ?? "",
    old_ref: comment.oldRef ?? "",
    new_ref: comment.newRef ?? "",
    ref_issue: null, // xref enrichment (RefIssueID join) lands with the xref writers
    ref_comment: null,
    ref_action: refActionName(comment.refAction),
    ref_commit_sha: comment.commitSha ?? "",
    review_id: comment.reviewId ?? 0,
    label: labelRow === null ? null : toEmbeddedLabel(labelRow, pair, viewer.origin),
    assignee: assigneeRow === null ? null : apiUserFromRow(assigneeRow, viewer),
    assignee_team: null, // teams tier 2
    removed_assignee: (comment.removedAssignee ?? 0) !== 0,
    resolve_doer: null, // review threads tier 2
    dependent_issue: null, // dependency enrichment (tier 2)
  };
}

// ---------------------------------------------------------------------------
// RFC3339 query filters (GetQueryBeforeSince, services/context/utils.go)
// ---------------------------------------------------------------------------

/** Go `time.Parse(RFC3339, …)` failure text — upstream's exact 422 message. */
export function goRfc3339ParseError(value: string): string {
  return `parsing time "${value}" as "2006-01-02T15:04:05Z07:00": cannot parse "${value}" as "2006"`;
}

/** RFC3339-only query-time parse (parseFormTime); ""/absent → null; bad → 422. */
export function parseQueryTime(raw: string | null): number | null {
  const value = (raw ?? "").trim();
  if (value === "") {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ApiError(422, goRfc3339ParseError(value));
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    throw new ApiError(422, goRfc3339ParseError(value));
  }
  return Math.floor(date.getTime() / 1000);
}

/** `state` filter (common.ParseIssueFilterStateIsClosed): null = all. */
export function parseStateFilter(state: string | null): boolean | null {
  switch (state ?? "") {
    case "all":
      return null;
    case "closed":
      return true;
    default:
      return false; // "open", "" and unknown values all mean open
  }
}

/** `type` filter (common.ParseIssueFilterTypeIsPull): null = both. */
export function parseTypeFilter(type: string | null): boolean | null {
  if (type === "pulls") return true;
  if (type === "issues") return false;
  return null;
}

// ---------------------------------------------------------------------------
// Issue list / search reads
// ---------------------------------------------------------------------------

export interface IssueListFilters {
  /** null = open+closed. */
  isClosed: boolean | null;
  /** null = issues+pulls. */
  isPull: boolean | null;
  keyword: string;
  /** Label ids, pre-resolved by the caller (repo-scoped for ListIssues,
   *  global for SearchIssues — upstream resolves the two differently). */
  labelIds: number[];
  /** Milestone ids, pre-resolved by the caller (same scoping split). */
  milestoneIds: number[];
  /** Only issues updated at/after (unix seconds). */
  since: number | null;
  /** Only issues updated before (unix seconds). */
  before: number | null;
  /** Poster id filter (created_by). */
  posterId?: number | null;
  page: number;
  limit: number;
}

/** `GetLabelIDsInRepoByNames` — repo-scoped, silently ignores misses. */
export async function labelIdsByRepoNames(d1: D1Database, repoId: string, names: string[]): Promise<number[]> {
  if (names.length === 0) return [];
  const rows = await drizzle(d1)
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.repoId, repoId), inArray(labels.name, names)))
    .orderBy(asc(labels.name))
    .all();
  return rows.map((row) => row.id);
}

/** `GetLabelIDsInOrgByNames` (models/issues/label.go:384-393) — org-scoped,
 * silently ignores misses; the owner-org fallthrough of the issue
 * attach/replace name branch (prepareForReplaceOrAdd,
 * routers/api/v1/repo/issue_label.go:342-359). */
export async function labelIdsByOrgNames(d1: D1Database, orgId: number, names: string[]): Promise<number[]> {
  if (names.length === 0 || orgId <= 0) return [];
  const rows = await drizzle(d1)
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.orgId, orgId), inArray(labels.name, names)))
    .orderBy(asc(labels.name))
    .all();
  return rows.map((row) => row.id);
}

/** The names of the given label rows — prepareForReplaceOrAdd's re-read of
 * the repo-matched labels (`GetLabelsByIDs(ctx, repoLabelIDs, "name")`,
 * routers/api/v1/repo/issue_label.go:343); drives which requested names fall
 * through to the owner org (issue_label.go:348-359). */
export async function labelNamesByIds(d1: D1Database, labelIds: number[]): Promise<Set<string>> {
  if (labelIds.length === 0) return new Set();
  const rows = await drizzle(d1)
    .select({ name: labels.name })
    .from(labels)
    .where(inArray(labels.id, labelIds))
    .all();
  return new Set(rows.map((row) => row.name));
}

/** `GetLabelIDsByNames` — GLOBAL by name (SearchIssues), misses discarded. */
export async function labelIdsByGlobalNames(d1: D1Database, names: string[]): Promise<number[]> {
  if (names.length === 0) return [];
  const rows = await drizzle(d1).select({ id: labels.id }).from(labels).where(inArray(labels.name, names)).all();
  return rows.map((row) => row.id);
}

/**
 * ListIssues milestone filter (`GetMilestoneByRepoIDANDName`): names first,
 * numeric fallback to ids; non-existent entries are discarded.
 */
export async function milestoneIdsByRepoEntries(d1: D1Database, repoId: string, entries: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const entry of entries) {
    const byName = await drizzle(d1)
      .select({ id: milestones.id })
      .from(milestones)
      .where(and(eq(milestones.repoId, repoId), eq(milestones.name, entry)))
      .limit(1);
    if (byName[0] !== undefined) {
      ids.push(byName[0].id);
      continue;
    }
    if (/^-?\d+$/.test(entry)) {
      const numeric = Number.parseInt(entry, 10);
      const byId = await drizzle(d1)
        .select({ id: milestones.id })
        .from(milestones)
        .where(and(eq(milestones.repoId, repoId), eq(milestones.id, numeric)))
        .limit(1);
      if (byId[0] !== undefined) {
        ids.push(byId[0].id);
      }
    }
  }
  return ids;
}

/** SearchIssues milestone filter — `GetMilestoneIDsByNames`, GLOBAL by name. */
export async function milestoneIdsByGlobalNames(d1: D1Database, names: string[]): Promise<number[]> {
  if (names.length === 0) return [];
  const rows = await drizzle(d1).select({ id: milestones.id }).from(milestones).where(inArray(milestones.name, names)).all();
  return rows.map((row) => row.id);
}

export interface IssueListPage {
  items: IssueRow[];
  total: number;
}

/** Shared WHERE builder (upstream indexer SearchOptions on D1). */
function issueFilterConditions(d1: D1Database, repoIds: string[], filters: IssueListFilters): SQL {
  const conditions: SQL[] = [inArray(issues.repoId, repoIds)];
  if (filters.isClosed !== null) {
    conditions.push(eq(issues.isClosed, filters.isClosed));
  }
  if (filters.isPull !== null) {
    conditions.push(eq(issues.isPull, filters.isPull));
  }
  if (filters.keyword !== "") {
    // NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long `?q=` needle
    // threw D1_ERROR and the route answered a plain 500. The substring goes
    // through instr() instead — the documented user-search precedent
    // (services/user.ts:81-97, the org-members 943e1e9 shape). The needle
    // pre-lowers for the case-insensitive pair (the columns lower() in SQL,
    // exactly what the LIKE wrapped).
    const needle = filters.keyword.toLowerCase();
    conditions.push(
      or(
        sql`instr(lower(${issues.title}), ${needle}) > 0`,
        sql`instr(lower(coalesce(${issues.content}, '')), ${needle}) > 0`,
      ) as SQL,
    );
  }
  if (filters.since !== null) {
    conditions.push(gte(issues.updatedAt, new Date(filters.since * 1000)));
  }
  if (filters.before !== null) {
    conditions.push(lt(issues.updatedAt, new Date(filters.before * 1000)));
  }
  if (filters.posterId !== undefined && filters.posterId !== null) {
    conditions.push(eq(issues.posterId, filters.posterId));
  }
  if (filters.labelIds.length > 0) {
    // Any-of semantics (indexer IncludedLabelIDs → OR-join).
    conditions.push(
      inArray(
        issues.id,
        drizzle(d1)
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(inArray(issueLabels.labelId, filters.labelIds)),
      ),
    );
  }
  if (filters.milestoneIds.length > 0) {
    conditions.push(inArray(issues.milestoneId, filters.milestoneIds));
  }
  return and(...conditions) as SQL;
}

/**
 * Repo-scoped issue list (ListIssues): upstream `SortByCreatedDesc`, page/
 * limit clamped by the caller.
 */
export async function listRepoIssues(d1: D1Database, repoId: string, filters: IssueListFilters): Promise<IssueListPage> {
  const where = issueFilterConditions(d1, [repoId], filters);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(issues).where(where);
  const items = await db
    .select()
    .from(issues)
    .where(where)
    .orderBy(sql`created_unix DESC, id DESC`)
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `/repos/issues/search` — cross-repo. `repoIds` comes from the route's
 * visibility filter (public repos for anonymous; + own private when signed).
 */
export async function searchIssuesGlobally(d1: D1Database, repoIds: string[], filters: IssueListFilters): Promise<IssueListPage> {
  if (repoIds.length === 0) {
    return { items: [], total: 0 };
  }
  const where = issueFilterConditions(d1, repoIds, filters);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(issues).where(where);
  const items = await db
    .select()
    .from(issues)
    .where(where)
    .orderBy(sql`created_unix DESC, id DESC`)
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

// ---------------------------------------------------------------------------
// Comment reads / writes (route-level — the service layer owns create only)
// ---------------------------------------------------------------------------

function commentTimeConditions(since: number | null, before: number | null): SQL[] {
  const conditions: SQL[] = [];
  if (since !== null) {
    conditions.push(gte(comments.updatedAt, new Date(since * 1000)));
  }
  if (before !== null) {
    conditions.push(lt(comments.updatedAt, new Date(before * 1000)));
  }
  return conditions;
}

/** `FindComments{IssueID, Type: CommentTypeComment}` — plain comments, id ASC. */
export async function listIssueComments(
  d1: D1Database,
  issueId: number,
  since: number | null,
  before: number | null,
): Promise<CommentRow[]> {
  return drizzle(d1)
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.Comment), ...commentTimeConditions(since, before)))
    .orderBy(asc(comments.id))
    .all();
}

/** Repo-wide comment feed (`ListRepoIssueComments`), paginated + counted. */
export async function listRepoComments(
  d1: D1Database,
  repoId: string,
  since: number | null,
  before: number | null,
  page: number,
  limit: number,
): Promise<{ items: Array<{ comment: CommentRow; issue: IssueRow }>; total: number }> {
  const where = and(eq(issues.repoId, repoId), eq(comments.type, CommentType.Comment), ...commentTimeConditions(since, before));
  const db = drizzle(d1);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(where);
  const items = await db
    .select({ comment: comments, issue: issues })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(where)
    .orderBy(asc(comments.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `FindComments{IssueID, Type: undefined}` — the full mixed timeline, id ASC. */
export async function listIssueTimeline(
  d1: D1Database,
  issueId: number,
  since: number | null,
  before: number | null,
  page: number,
  limit: number,
): Promise<CommentRow[]> {
  return drizzle(d1)
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueId), ...commentTimeConditions(since, before)))
    .orderBy(asc(comments.id))
    .limit(limit)
    .offset((page - 1) * limit);
}

/** `GetCommentWithRepoID` — the GLOBAL comment id scoped through this repo's issues. */
export async function findRepoCommentById(d1: D1Database, repoId: string, commentId: number): Promise<{ comment: CommentRow; issue: IssueRow } | null> {
  const rows = await drizzle(d1)
    .select({ comment: comments, issue: issues })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(and(eq(comments.id, commentId), eq(issues.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** `comment.Type.HasContentSupport()` (models/issues/comment.go:180). The
 *  raw column is a plain integer; the membership check needs no narrowing. */
export function commentHasContentSupport(type: number): boolean {
  return type === CommentType.Comment || type === CommentType.Code || type === CommentType.Review || type === CommentType.DismissReview;
}

// ---------------------------------------------------------------------------
// Issue content history write paths (specs/issue-content-history.md —
// upstream models/issues/content_history.go SaveIssueContentHistory /
// KeepLimitedContentHistory, consumed by the edit hooks above/below)
// ---------------------------------------------------------------------------

/** `HasIssueContentHistory` (content_history.go:174-180) — the lazy
 *  back-fill gate. */
async function hasIssueContentHistory(d1: D1Database, issueId: number, commentId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: issueContentHistory.id })
    .from(issueContentHistory)
    .where(and(eq(issueContentHistory.issueId, issueId), eq(issueContentHistory.commentId, commentId)))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** `SaveIssueContentHistory`'s INSERT arm — a batch statement, so a snapshot
 *  commits or rolls back together with the edit that produced it. */
function insertIssueContentHistory(
  d1: D1Database,
  issueId: number,
  commentId: number,
  revision: { posterId: number | null; editedAt: Date; contentText: string; isFirstCreated: boolean },
) {
  return drizzle(d1).insert(issueContentHistory).values({
    issueId,
    commentId,
    posterId: revision.posterId,
    editedAt: revision.editedAt,
    contentText: revision.contentText,
    isFirstCreated: revision.isFirstCreated,
  });
}

/** The per-revision retention cap (upstream keeps at most 20). */
export const ISSUE_CONTENT_HISTORY_LIMIT = 20;

/**
 * `KeepLimitedContentHistory` (content_history.go:56-106): keep at most
 * `limit` revisions of (issueId, commentId), hard-deleting surplus MIDDLE
 * revisions — the first and the last are never deleted, and each pass
 * deletes the revision with the smallest interval to its predecessor
 * (preserves the sparsest edit history). Errors here never fail the edit
 * (upstream only logs).
 */
export async function keepLimitedIssueContentHistory(d1: D1Database, issueId: number, commentId: number): Promise<void> {
  try {
    const ordered = await drizzle(d1)
      .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .where(and(eq(issueContentHistory.issueId, issueId), eq(issueContentHistory.commentId, commentId)))
      .orderBy(asc(issueContentHistory.editedAt))
      .all();
    if (ordered.length <= 2 || ordered.length <= ISSUE_CONTENT_HISTORY_LIMIT) return;

    let outDatedCount = ordered.length - ISSUE_CONTENT_HISTORY_LIMIT;
    const res = ordered.slice();
    while (outDatedCount > 0) {
      let indexToDelete = -1;
      let minEditedInterval = -1;
      for (let i = 1; i < res.length - 1; i++) {
        const current = res[i];
        const predecessor = res[i - 1];
        if (current === undefined || predecessor === undefined) break;
        const editedInterval = current.editedAt.getTime() - predecessor.editedAt.getTime();
        if (minEditedInterval === -1 || editedInterval < minEditedInterval) {
          minEditedInterval = editedInterval;
          indexToDelete = i;
        }
      }
      if (indexToDelete <= 0) break;
      const doomed = res[indexToDelete];
      if (doomed === undefined) break;
      await drizzle(d1).delete(issueContentHistory).where(eq(issueContentHistory.id, doomed.id));
      res.splice(indexToDelete, 1);
      outDatedCount--;
    }
  } catch {
    // upstream logs and continues (content_history.go:61 "we can ignore all
    // errors in this function") — a missed retention pass is invisible.
  }
}

/** PATCH comment: body + content_version bump + updated stamp, riding the
 *  content-history write hook (specs/issue-content-history.md §3 — upstream
 *  services/issue/comments.go UpdateComment). */
export async function updateCommentBody(d1: D1Database, commentId: number, body: string, now: Date, actorId?: number | null): Promise<CommentRow | null> {
  // The gate reads the PRIOR row (old content, poster, created stamp, type)
  // — upstream's c.Content != oldContent && c.Type.HasContentSupport()
  // (comments.go:112).
  const priorRows = await drizzle(d1).select().from(comments).where(eq(comments.id, commentId)).limit(1).all();
  const prior = priorRows[0];
  if (prior === undefined) return null;
  const needsHistory = prior.content !== body && commentHasContentSupport(prior.type);
  const backfill = needsHistory && !(await hasIssueContentHistory(d1, prior.issueId, commentId))
    ? { posterId: prior.posterId, editedAt: prior.createdAt ?? now, contentText: prior.content ?? "" }
    : null;

  const updateStatement = drizzle(d1)
    .update(comments)
    .set({ content: body, contentVersion: sql`content_version + 1`, updatedAt: now })
    .where(eq(comments.id, commentId))
    .returning();
  const newRevision = { posterId: actorId ?? prior.posterId, editedAt: now, contentText: body };

  if (backfill !== null) {
    // The lazy first-revision back-fill rides the same batch as the update
    // (upstream's tx; a failed update rolls the snapshot back with it).
    const results = await drizzle(d1).batch([
      insertIssueContentHistory(d1, prior.issueId, commentId, { ...backfill, isFirstCreated: true }),
      updateStatement,
      insertIssueContentHistory(d1, prior.issueId, commentId, { ...newRevision, isFirstCreated: false }),
    ] as const);
    await keepLimitedIssueContentHistory(d1, prior.issueId, commentId);
    return results[1][0] ?? null;
  }
  if (!needsHistory) {
    const rows = await updateStatement;
    return rows[0] ?? null;
  }
  const results = await drizzle(d1).batch([
    updateStatement,
    insertIssueContentHistory(d1, prior.issueId, commentId, { ...newRevision, isFirstCreated: false }),
  ] as const);
  await keepLimitedIssueContentHistory(d1, prior.issueId, commentId);
  return results[0][0] ?? null;
}

/**
 * DELETE comment (`issue_service.DeleteComment` reduced): unlink + the
 * num_comments decrement + the content-history hard-delete in one batch
 * (upstream models/issues/comment.go:1215-1219 deletes the comment's
 * ContentHistory rows in the same tx — a comment's revisions never outlive
 * it). False when the row is already gone.
 */
export async function deleteComment(d1: D1Database, comment: CommentRow, now: Date): Promise<boolean> {
  const results = await drizzle(d1).batch([
    drizzle(d1).delete(comments).where(eq(comments.id, comment.id)).returning({ id: comments.id }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`MAX(num_comments - 1, 0)`, updatedAt: now })
      .where(eq(issues.id, comment.issueId)),
    drizzle(d1).delete(issueContentHistory).where(eq(issueContentHistory.commentId, comment.id)),
  ] as const);
  const removed = results[0] as Array<{ id: number }>;
  return removed.length > 0;
}

// ---------------------------------------------------------------------------
// Edit-issue field writes the data layer does not model
// ---------------------------------------------------------------------------

/** Statement type accepted by drizzle's D1 `batch` (the service-layer pattern). */
type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];

/**
 * `issue_service.ChangeTitle` — title update + `change_title` (10) comment +
 * the num_comments fold, one batch.
 */
export async function changeIssueTitle(d1: D1Database, issue: IssueRow, title: string, actorId: number | null, now: Date): Promise<IssueRow | null> {
  const oldTitle = issue.title;
  const results = await drizzle(d1).batch([
    drizzle(d1)
      .update(issues)
      .set({ title, updatedAt: now })
      .where(eq(issues.id, issue.id))
      .returning(),
    drizzle(d1).insert(comments).values({
      type: CommentType.ChangeTitle,
      posterId: actorId,
      issueId: issue.id,
      oldTitle,
      newTitle: title,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
  return results[0][0] ?? null;
}

/**
 * `issue_service.ChangeContent` — body update with the optimistic
 * content_version CAS (WHERE content_version = expected): 0 rows ⇒ the
 * stale-version 409 (upstream ErrIssueAlreadyChanged) with NOTHING written.
 * Rides the content-history write hook (specs/issue-content-history.md §3 —
 * upstream models/issues/issue_update.go ChangeIssueContent): the lazy
 * first-revision back-fill, the edited-revision snapshot, and the retention
 * limiter. The CAS UPDATE runs FIRST because a D1 batch has no
 * conditional-abort — history rows follow the successful update (upstream
 * keeps all four statements in one tx; the crash-window divergence is SPEC
 * §4). `actorId` attributes the edited revision (upstream doer.ID); omitted
 * → the issue poster (§5.1 of the SPEC, route threading follow-up).
 */
export async function changeIssueBody(d1: D1Database, issue: IssueRow, body: string, expectedVersion: number, now: Date, actorId?: number | null): Promise<IssueRow | null> {
  const updated = await drizzle(d1)
    .update(issues)
    .set({ content: body, contentVersion: sql`content_version + 1`, updatedAt: now })
    .where(and(eq(issues.id, issue.id), eq(issues.contentVersion, expectedVersion)))
    .returning();
  const row = updated[0] ?? null;
  if (row === null) return null;

  const backfill = (await hasIssueContentHistory(d1, issue.id, 0))
    ? null
    : { posterId: issue.posterId, editedAt: issue.createdAt ?? now, contentText: issue.content ?? "" };
  const newRevision = { posterId: actorId ?? issue.posterId, editedAt: now, contentText: body };
  if (backfill !== null) {
    // The lazy first-revision back-fill + the edited revision commit as one
    // atomic batch (ordering by edited_unix puts the back-fill first).
    await drizzle(d1).batch([
      insertIssueContentHistory(d1, issue.id, 0, { ...backfill, isFirstCreated: true }),
      insertIssueContentHistory(d1, issue.id, 0, { ...newRevision, isFirstCreated: false }),
    ] as const);
  } else {
    await insertIssueContentHistory(d1, issue.id, 0, { ...newRevision, isFirstCreated: false });
  }
  await keepLimitedIssueContentHistory(d1, issue.id, 0);
  return row;
}

/** `issue_service.ChangeIssueRef` — ref update + change_issue_ref (33) comment. */
export async function changeIssueRef(d1: D1Database, issue: IssueRow, ref: string, actorId: number | null, now: Date): Promise<void> {
  const oldRef = issue.ref ?? "";
  await drizzle(d1).batch([
    drizzle(d1).update(issues).set({ ref, updatedAt: now }).where(eq(issues.id, issue.id)),
    drizzle(d1).insert(comments).values({
      type: CommentType.ChangeIssueRef,
      posterId: actorId,
      issueId: issue.id,
      oldRef,
      newRef: ref,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
}

/**
 * Deadline write mirroring `UpdateIssueDeadline` + its system comment
 * (added/modified/removed = types 16/17/18).
 */
export async function changeIssueDeadline(
  d1: D1Database,
  issue: IssueRow,
  deadline: Date | null,
  previous: Date | null,
  actorId: number | null,
  now: Date,
): Promise<void> {
  const commentType = previous === null ? CommentType.AddedDeadline : deadline === null ? CommentType.RemovedDeadline : CommentType.ModifiedDeadline;
  await drizzle(d1).batch([
    drizzle(d1).update(issues).set({ deadlineAt: deadline, updatedAt: now }).where(eq(issues.id, issue.id)),
    drizzle(d1).insert(comments).values({
      type: commentType,
      posterId: actorId,
      issueId: issue.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
}

/**
 * `issue_service.ChangeMilestoneAssign` — milestone set/unset with the
 * old/new counter moves and the milestone (8) comment, one batch. SQLite
 * evaluates SET expressions against the OLD row values, so the completeness
 * recompute references the explicit post-update operands.
 */
export async function changeIssueMilestone(
  d1: D1Database,
  issue: IssueRow,
  milestoneId: number | null,
  oldMilestoneId: number | null,
  actorId: number | null,
  now: Date,
): Promise<void> {
  const statements: [BatchStatement, ...BatchStatement[]] = [
    drizzle(d1).update(issues).set({ milestoneId, updatedAt: now }).where(eq(issues.id, issue.id)),
    drizzle(d1).insert(comments).values({
      type: CommentType.Milestone,
      posterId: actorId,
      issueId: issue.id,
      oldMilestoneId,
      milestoneId,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ];
  const closedAfterDecrement = issue.isClosed ? sql`MAX(num_closed_issues - 1, 0)` : sql`num_closed_issues`;
  if (oldMilestoneId !== null) {
    statements.push(
      drizzle(d1)
        .update(milestones)
        .set({
          numIssues: sql`MAX(num_issues - 1, 0)`,
          numClosedIssues: closedAfterDecrement,
          completeness: sql`CASE WHEN num_issues > 1 THEN ${closedAfterDecrement} * 100 / (num_issues - 1) WHEN is_closed = 1 THEN 100 ELSE 0 END`,
        })
        .where(eq(milestones.id, oldMilestoneId)),
    );
  }
  if (milestoneId !== null) {
    statements.push(
      drizzle(d1)
        .update(milestones)
        .set({
          numIssues: sql`num_issues + 1`,
          completeness: sql`CASE WHEN num_issues + 1 > 0 THEN num_closed_issues * 100 / (num_issues + 1) WHEN is_closed = 1 THEN 100 ELSE 0 END`,
        })
        .where(eq(milestones.id, milestoneId)),
    );
  }
  await drizzle(d1).batch(statements);
}

// ---------------------------------------------------------------------------
// Assignee write core — `issue_service` (services/issue/assignee.go, pin
// fc493688). The shared write half of BOTH PATCH assignee arms (issues
// EditIssue issue.go:772-779, pulls EditPullRequest pull.go:679-694 call
// UpdateAssignees:94-166 — replaceIssueAssignees below) AND of the /assignees
// trio (issue_assignee.go AddIssueAssignees:23 / DeleteIssueAssignees:70 call
// AddAssignees:206 / RemoveAssignees:249 — addIssueAssignees/
// removeIssueAssignees below); landed here from the pulls.ts port so every
// assignee route shares ONE implementation (the emissions stay with the
// routes: the pulls side its pull_request_assign emitter, the issues PATCH
// and the trio their IsPull-discriminant assign emitter — the write core
// below is event-agnostic).
// ---------------------------------------------------------------------------

/** Assignee rows joined with their user rows, insertion (rowid) order —
 *  upstream LoadAssignees' natural-order user join (models/issues/
 *  assignees.go:36-46). */
export async function listIssueAssignees(d1: D1Database, issueId: number): Promise<UserRow[]> {
  const rows = await drizzle(d1)
    .select({ user: users })
    .from(issueAssignees)
    .innerJoin(users, eq(users.id, issueAssignees.assigneeId))
    .where(eq(issueAssignees.issueId, issueId))
    .orderBy(asc(issueAssignees.id))
    .all();
  return rows.map((row) => row.user);
}

/**
 * CanBeAssigned (models/perm/access/repo_permission.go:588-598) collapsed
 * onto the landed ACL: write access to any unit, or read on the pulls unit
 * — a public repo grants every real user read; a private repo grants the
 * owner, site admins and collaborators (any mode — upstream pulls-unit
 * read covers read-mode collaborators too). Org rows are refused by the
 * callers (requireAssignable). Shared by validateAssignee (the PATCH arm)
 * and the /assignees trio.
 */
export async function canBeAssigned(d1: D1Database, found: RepositoryWithOwner, user: { id: number; isAdmin: boolean }): Promise<boolean> {
  if (found.repo.visibility === "public") {
    return true;
  }
  if (user.isAdmin) {
    return true;
  }
  if (found.repo.ownerId !== null && found.repo.ownerId === user.id) {
    return true;
  }
  return (await findCollaborator(d1, found.repo.id, user.id)) !== null;
}

/**
 * validateAssignee minus the blocked arm — the /assignees trio's shape
 * (services/issue/assignee.go:172-183): an org row is CanBeAssigned's
 * InvalidArgument → 400; the rest is the access error → 403
 * (ErrUserDoesNotHaveAccessToRepo via APIErrorAuto, ErrPermissionDenied).
 * The org message renders the numeric registry id (the landed
 * issue-tables-t2 rendering, repoIdNumber of the text id); the PATCH arm's
 * validateAssignee below answers the same 400 with the raw id — each suite
 * pins its own text.
 */
export async function requireAssignable(d1: D1Database, found: RepositoryWithOwner, user: { id: number; isAdmin: boolean; type: string }): Promise<void> {
  if (user.type === "org") {
    throw new ApiError(400, `organization can't be added as assignee [user_id: ${user.id}, repo_id: ${repoIdNumber(found.repo.id)}]`);
  }
  if (!(await canBeAssigned(d1, found, user))) {
    throw new ApiError(403, `user doesn't have access to repo [user_id: ${user.id}, repo_name: ${found.repo.slug}]`);
  }
}

/**
 * `GetDoerUserIDsByNames` (user.go:1237) reduced to the /assignees trio:
 * resolve the login list case-insensitively in order; the FIRST miss aborts
 * with the bare ErrUserNotExist 422 (updateIssueAssignees:201-209 answers
 * the ErrNotExist text explicitly) — the PATCH arm's resolveAssigneeNames
 * below answers pull.go:688's wrapper text instead (two upstream mappings
 * of the same lookup).
 */
export async function resolveAssigneesByName(d1: D1Database, names: string[]): Promise<UserRow[]> {
  const resolved: UserRow[] = [];
  for (const name of names) {
    const user = await findUserByName(d1, name);
    if (user === null) {
      throw new ApiError(422, `user does not exist [uid: 0, name: ${name}]`);
    }
    resolved.push(user);
  }
  return resolved;
}

/** `GetDoerUserIDsByNames` reduced to the PATCH arm (user.go:1237): resolve
 *  case-insensitively; the FIRST miss aborts with pull.go:688's exact 422 —
 *  `fmt.Sprintf("Assignee does not exist: [name: %s]", err)` renders the
 *  ErrUserNotExist text INSIDE the wrapper. Upstream's issues-PATCH arm maps
 *  neither this nor the access error (they fall into APIErrorInternal,
 *  issue.go:780-783 — a 500); we keep the pulls-side mapping, the same 422
 *  the landed /assignees routes answer (documented divergence). */
async function resolveAssigneeNames(d1: D1Database, names: string[]): Promise<UserRow[]> {
  const resolved: UserRow[] = [];
  const seen = new Set<number>();
  for (const name of new Set(names)) {
    const user = await findUserByName(d1, name);
    if (user === null) {
      throw new ApiError(422, `Assignee does not exist: [name: user does not exist [uid: 0, name: ${name}]]`);
    }
    if (!seen.has(user.id)) {
      seen.add(user.id);
      resolved.push(user);
    }
  }
  return resolved;
}

/** validateAssignee (services/issue/assignee.go:168-183): the blocked arm
 *  FIRST (the blocks-enforcement wiring), then CanBeAssigned collapsed onto
 *  the landed ACL (the issue-tables-t2 port: a public repo grants every real
 *  user; otherwise owner / site admin / collaborator). The org row and the
 *  access miss answer the landed family's 400/403 — upstream's PATCH routes
 *  map neither (they fall into APIErrorInternal, issue.go:780-783 /
 *  pull.go:691-692); the landed issue-tables-t2 arm's statuses stand here
 *  too (documented divergence). */
async function validateAssignee(d1: D1Database, found: RepositoryWithOwner, doer: { id: number; isAdmin: boolean }, user: UserRow): Promise<void> {
  if (user.type === "org") {
    throw new ApiError(400, `organization can't be added as assignee [user_id: ${user.id}, repo_id: ${found.repo.id}]`);
  }
  if (await isUserBlockedBy(d1, { id: doer.id, isAdmin: doer.isAdmin }, user.id)) {
    throw new ApiError(403, BLOCKED_USER_MESSAGE);
  }
  if (!(await canBeAssigned(d1, found, user))) {
    throw new ApiError(403, `user doesn't have access to repo [user_id: ${user.id}, repo_name: ${found.repo.slug}]`);
  }
}

/** The type-9 (assignees) comment + the num_comments fold — the
 *  issue-tables-t2 writeAssigneeComment port (toggleIssueAssignee,
 *  models/issues/assignees.go:107-140). */
async function writeAssigneeComment(d1: D1Database, issue: IssueRow, assigneeId: number, removed: boolean, actorId: number, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.Assignees,
      posterId: actorId,
      issueId: issue.id,
      assigneeId,
      removedAssignee: removed ? 1 : 0,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ]);
}

/**
 * AddAssignees (services/issue/assignee.go:206-247) reduced — the /assignees
 * trio's POST arm: per NEW assignee — the guarded insert
 * (AddAssigneeIfNotAssigned) + the type-9 comment. Already-assigned users
 * produce NO comment; a non-assignable user aborts with the upstream 400/403
 * (requireAssignable) before its own insert — earlier inserts of the same
 * call stand (upstream's tx rolls the whole add back; the landed API keeps
 * the committed prefix, the issue-tables-t2 header deviation). Returns the
 * assignees actually added — the caller notifies per changed assignee after
 * the writes (assignee.go:236-247, the trio's emitAssignEvent loop).
 *
 * `doer` feeds the validateAssignee blocked arm (assignee.go:169-170, wired
 * by the blocks-enforcement batch): the doer blocked by a NEW assignee
 * answers 403 "user is blocked". Upstream runs the arm inside
 * validateAssignee — after AddAssignees' already-assigned skip (:216-222)
 * and before CanBeAssigned; this loop validates assignability BEFORE the
 * skip (the landed deviation), so the arm sits after the skip and its only
 * precedence divergence is a blocked AND non-assignable name answering the
 * access 403 instead of this one.
 */
export async function addIssueAssignees(
  d1: D1Database,
  found: RepositoryWithOwner,
  issue: IssueRow,
  assignees: UserRow[],
  doer: { id: number; isAdmin: boolean },
): Promise<UserRow[]> {
  const actorId = doer.id;
  const now = new Date();
  const added: UserRow[] = [];
  for (const user of assignees) {
    await requireAssignable(d1, found, user);
    const existing = await drizzle(d1)
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing !== undefined) {
      continue; // AddAssigneeIfNotAssigned: already assigned, nothing to do
    }
    if (await isUserBlockedBy(d1, { id: actorId, isAdmin: doer.isAdmin }, user.id)) {
      throw new ApiError(403, BLOCKED_USER_MESSAGE);
    }
    const inserted = await drizzle(d1)
      .insert(issueAssignees)
      .values({ issueId: issue.id, assigneeId: user.id })
      .onConflictDoNothing()
      .returning({ id: issueAssignees.id });
    if (inserted.length === 0) {
      continue; // a concurrent add won the unique index — same skip
    }
    added.push(user);
    await writeAssigneeComment(d1, issue, user.id, false, actorId, now);
  }
  return added;
}

/**
 * RemoveAssignees (services/issue/assignee.go:249-286) reduced — the
 * /assignees trio's DELETE arm: per assigned user — the delete + the type-9
 * removal comment. Users not assigned are skipped silently (isAssigned →
 * continue). Returns the assignees actually removed — the caller notifies
 * per changed assignee after the writes (assignee.go:274-286).
 */
export async function removeIssueAssignees(d1: D1Database, issue: IssueRow, assignees: UserRow[], actorId: number): Promise<UserRow[]> {
  const now = new Date();
  const removed: UserRow[] = [];
  for (const user of assignees) {
    const deleted = await drizzle(d1)
      .delete(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .returning({ id: issueAssignees.id });
    if (deleted.length === 0) {
      continue;
    }
    removed.push(user);
    await writeAssigneeComment(d1, issue, user.id, true, actorId, now);
  }
  return removed;
}

/**
 * UpdateAssignees (services/issue/assignee.go:94-166) over the landed
 * issue_assignees table: resolve + validate EVERY unique name first (the
 * blocked/access arms fire before any write, upstream's pre-tx
 * validateAssignee loop), then the removals (toBeRemovedAssignees —
 * assignee.go:18-31, the current set minus the requested one, each with its
 * removal comment), then the adds (AddAssigneeIfNotAssigned — assignee.go:
 * 186-204, the already-assigned skip, the guarded insert, the add comment).
 * Invokes `onAssignee` once per ACTUALLY-changed assignee after the writes
 * — removals first, then adds, upstream's post-tx notify order
 * (assignee.go:155-166) feeding IssueChangeAssignee (services/webhook/
 * notifier.go:161-202). No-op when the requested set equals the current
 * one: nothing removed, every add skipped, no comment, no notification.
 *
 * `doer` feeds the validateAssignee blocked arm; `now` stamps the type-9
 * comments. Emits nothing itself — the route passes its emitter (the pulls
 * PATCH's pull_request_assign delivery, the issues PATCH's IsPull
 * discriminant assign event).
 */
export async function replaceIssueAssignees(
  d1: D1Database,
  found: RepositoryWithOwner,
  issue: IssueRow,
  names: string[],
  doer: { id: number; isAdmin: boolean },
  onAssignee: (user: UserRow, removed: boolean) => Promise<void>,
): Promise<void> {
  const actorId = doer.id;
  const now = new Date();
  const requested = await resolveAssigneeNames(d1, names);
  for (const user of requested) {
    await validateAssignee(d1, found, doer, user);
  }

  const current = await listIssueAssignees(d1, issue.id);
  const requestedIds = new Set(requested.map((user) => user.id));

  const added: UserRow[] = [];
  const removed: UserRow[] = [];
  // Removals first (upstream's tx order), then adds with the skip.
  for (const user of current) {
    if (requestedIds.has(user.id)) continue;
    const deleted = await drizzle(d1)
      .delete(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .returning({ id: issueAssignees.id });
    if (deleted.length === 0) continue;
    removed.push(user);
    await writeAssigneeComment(d1, issue, user.id, true, actorId, now);
  }
  for (const user of requested) {
    const existing = await drizzle(d1)
      .select({ id: issueAssignees.id })
      .from(issueAssignees)
      .where(and(eq(issueAssignees.issueId, issue.id), eq(issueAssignees.assigneeId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing !== undefined) continue; // AddAssigneeIfNotAssigned: already assigned, nothing to do
    const inserted = await drizzle(d1)
      .insert(issueAssignees)
      .values({ issueId: issue.id, assigneeId: user.id })
      .onConflictDoNothing()
      .returning({ id: issueAssignees.id });
    if (inserted.length === 0) continue; // a concurrent add won the unique index
    added.push(user);
    await writeAssigneeComment(d1, issue, user.id, false, actorId, now);
  }

  for (const user of removed) {
    await onAssignee(user, true);
  }
  for (const user of added) {
    await onAssignee(user, false);
  }
}

/**
 * The issue wire with the assignee/assignees block filled (convert.ToIssue
 * issue.go:105-113 — the first assignee duplicated into `assignee`; empty →
 * both null). The shared toApiIssue still renders the un-enriched shape
 * (its TODO); the /assignees trio's responses and the assign emissions
 * carry the fill until the API-surface fold wave flips every issue response
 * at once (routes/issues.ts keeps its private twin until that wave).
 */
export async function toApiIssueWithAssignees(d1: D1Database, viewer: Viewer, found: RepositoryWithOwner, issue: IssueRow): Promise<Issue> {
  const [base, assigneeRows] = await Promise.all([toApiIssue(d1, viewer, found, issue), listIssueAssignees(d1, issue.id)]);
  if (assigneeRows.length === 0) {
    return base;
  }
  const rendered = assigneeRows.map((row) => apiUserFromRow(row, viewer));
  return { ...base, assignee: rendered[0] ?? null, assignees: rendered };
}

// ---------------------------------------------------------------------------
// Issue delete (§4.12 — services/issue/issue.go deleteIssue cascade)
// ---------------------------------------------------------------------------

/**
 * Request-scoped emission context for the delete arms — the delete funnel's
 * optional webhook half (upstream DeleteIssue, notifier.go:313-341, reached
 * from the v1 DELETE route, routers/api/v1/repo/issue.go:851→:886). Every
 * caller that holds a request threads it (`issueDeleteEmission`), so the API
 * route and any future UI delete funnel emit identically through ONE seam
 * (the house rule — the same funnel posture as the wiki family's service
 * seam). Omitted → the bare cascade stays webhook-silent (callers with no
 * request; today's pre-wiring behavior).
 */
export interface IssueDeleteEmission {
  /** The hono request source structurally: the bindings (D1 for the fan-out,
   *  the optional WEBHOOK_DELIVERY queue) and hono's `executionCtx` GETTER as
   *  a thunk — read lazily inside the emit guard, because reading it throws
   *  for in-process callers (tests via router.fetch) that have no execution
   *  context. */
  readonly env: { readonly DB: D1Database; readonly WEBHOOK_DELIVERY?: unknown };
  readonly executionCtx?: () => { waitUntil(promise: Promise<unknown>): void };
  /** The §2.7 viewer the payload renders against (the route's viewerOf(c)). */
  readonly viewer: Viewer;
  /** The doer — the payload's sender (the route's authUser). */
  readonly sender: unknown;
}

/** The emission context of one API request (the route's one-line thread:
 *  `deleteIssueCascade(c.env.DB, c.env.REPO_PACKS, issue, issueDeleteEmission(c))`). */
export function issueDeleteEmission(c: Context<ApiEnv>): IssueDeleteEmission {
  return {
    env: c.env,
    executionCtx: () => c.executionCtx,
    viewer: viewerOf(c),
    sender: c.get("authUser"),
  };
}

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired — the
 *  structural probe the routes/issue-events/push modules share (the generated
 *  Env types the binding as required, this only defends the runtime). */
function deleteEmissionQueue(env: IssueDeleteEmission["env"]): {
  sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown>;
} | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

/** One resolved delete event: where it routes and what it carries. */
interface IssueDeletedEvent {
  repoId: string;
  ownerId: number | null;
  eventType: HookEventType;
  payload: Record<string, unknown>;
}

/**
 * The PRE-delete payload render of upstream DeleteIssue's webhook pair
 * (notifier.go:313-341): the issue arm renders IssuePayload (ToAPIIssue),
 * the PR arm PullRequestPayload (ToPayloadPullRequest), both `action=deleted`
 * with `commit_id` "" (upstream sets no commit) and NO `changes` block. The
 * identity render is the doer-viewer §2.7 converters — every other emission's
 * render (upstream's issue-arm poster-viewer quirk is sub-visible; the house
 * render passes the doer viewer throughout). Upstream loads the payload's
 * attributes BEFORE deleting (issue.go:157-162) and notifies AFTER (:183),
 * so this render runs on the live rows and the fan-out follows the cascade.
 * Null = an unresolvable identity (orphaned repo row / missing PR row) — the
 * push wave's log-and-skip degradation.
 */
async function renderIssueDeletedEvent(d1: D1Database, issue: IssueRow, emission: IssueDeleteEmission): Promise<IssueDeletedEvent | null> {
  const pair = await findRepositoryById(d1, issue.repoId);
  if (pair === null) {
    console.error(`[issues] delete webhook skipped (deleted): repository row missing [id: ${issue.repoId}]`);
    return null;
  }
  const repository = toApiRepository(emission.viewer, pair);
  if (issue.isPull) {
    const pr = (await drizzle(d1).select().from(pullRequests).where(eq(pullRequests.issueId, issue.id)).limit(1).all())[0] ?? null;
    if (pr === null) {
      console.error(`[issues] delete webhook skipped (deleted): PR row missing [issue: ${issue.id}]`);
      return null;
    }
    return {
      repoId: pair.repo.id,
      ownerId: pair.repo.ownerId,
      eventType: "pull_request",
      payload: {
        action: "deleted",
        number: issue.index,
        pull_request: await toApiPullRequest(d1, emission.viewer, pair, issue, pr, "payload"),
        repository,
        sender: emission.sender,
        commit_id: "",
      },
    };
  }
  return {
    repoId: pair.repo.id,
    ownerId: pair.repo.ownerId,
    eventType: "issues",
    payload: {
      action: "deleted",
      number: issue.index,
      issue: await toApiIssue(d1, emission.viewer, pair, issue),
      repository,
      sender: emission.sender,
      commit_id: "",
    },
  };
}

/**
 * Fire the delete event. The delivery-row insert is AWAITED inline after the
 * cascade committed (the emitIssueEvent posture — upstream CreateHookTask is
 * synchronous too); failures are caught and logged, never propagated into the
 * delete. Only the Queue producer ({deliveryId} batch) hangs off the
 * executionCtx-guarded waitUntil — in-process callers (tests via
 * router.fetch) have no execution context, skip the enqueue, and leave the
 * rows `pending` (the durable source of truth; the consumer's idempotent CAS
 * makes a later enqueue a safe replay). NO activity-feed row: the upstream
 * actionNotifier has no DeleteIssue method (feed/notifier.go) — the feed
 * stays silent upstream-faithfully.
 */
async function emitIssueDeletedEvent(d1: D1Database, event: IssueDeletedEvent, emission: IssueDeleteEmission): Promise<void> {
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  if (emission.executionCtx !== undefined) {
    try {
      execCtx = emission.executionCtx();
    } catch {
      execCtx = undefined; // in-process caller (tests): no execution context
    }
  }
  const queue = deleteEmissionQueue(emission.env);
  const ctx = execCtx;
  try {
    await emitWebhookDeliveries(
      d1,
      { repoId: event.repoId, ownerId: event.ownerId, eventType: event.eventType, payload: event.payload, refName: null },
      {
        enqueue:
          queue !== null && ctx !== undefined
            ? (deliveryIds: number[]): void => {
                ctx.waitUntil(
                  queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                    console.error(`[issues] delivery enqueue failed (${event.eventType}): ${error instanceof Error ? error.message : String(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[issues] webhook fan-out failed (${event.eventType}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The §4.12 delete cascade in ONE D1 batch: comments (own rows + xref rows
 * pointing here + dependency rows), issue_labels, the tier-2 children
 * (content history, assignees, dependencies in BOTH directions, notification
 * states, stopwatches, tracked times, attachments), reactions,
 * subscriptions, pins, the PR row, the issue row, the label open-counter
 * decrements, and the repo open-counter decrements (`DecrRepoIssueNumbers`).
 * The milestone counters move like upstream's `UpdateMilestoneCounters`. The
 * index counter is NOT rewound (§2.2).
 *
 * The tier-2 arms are the upstream `db.DeleteBeans` set
 * (services/issue/issue.go:234–252) minus one accepted delta: upstream's
 * `IssueUser` bean is not modeled (the derived read-state design — schema's
 * notification_states comment). The `ProjectIssue` detach (issue.go:246)
 * rides this sweep too — the review-wave closure: without it a deleted issue
 * left a ghost `project_issues` membership row behind. DEVIATION (kept):
 * upstream also removes `refs/pull/N/head` from the engine
 * (services/issue/issue.go:174–181) — the engine ref write lands with the PR
 * routes (SPEC-0005 §3.4) and is deferred with them.
 *
 * Attachment STORAGE is deleted first (the landed single-attachment delete's
 * storage-first contract — routes/issue-attachments.ts:986-991: a failed R2
 * delete leaves the D1 rows intact and the request retryable; upstream's
 * cascade removes the files after commit, services/issue/issue.go:166–172).
 * The row sweep rides the batch; a NULL `r2_key` (row-first landing, upload
 * not completed) has no object to delete. R2 delete of a missing key is a
 * no-op, so a retry after a partial storage pass is safe.
 *
 * WEBHOOKS (upstream DeleteIssue, notifier.go:313-341): with an emission
 * context threaded, the cascade renders the `action=deleted` payload from the
 * live rows BEFORE the sweep (upstream's LoadAttributes-before-delete) and
 * fans out AFTER the batch commits — the issue arm one `issues` event, the
 * PR arm one `pull_request` event, exactly once per delete (the route 404s
 * the second attempt; the IsPull discriminant picks the arm, so a delete
 * never emits both).
 */
export async function deleteIssueCascade(d1: D1Database, bucket: R2Bucket, issue: IssueRow, emission?: IssueDeleteEmission): Promise<void> {
  let event: IssueDeletedEvent | null = null;
  if (emission !== undefined) {
    try {
      event = await renderIssueDeletedEvent(d1, issue, emission);
    } catch (error) {
      console.error(`[issues] delete webhook render failed (deleted): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const attachmentKeys = (
    await drizzle(d1)
      .select({ r2Key: issueAttachments.r2Key })
      .from(issueAttachments)
      .where(eq(issueAttachments.issueId, issue.id))
      .all()
  ).map((row) => row.r2Key);
  for (const key of attachmentKeys) {
    if (key !== null) await bucket.delete(key);
  }

  const statements: [BatchStatement, ...BatchStatement[]] = [
    drizzle(d1).delete(comments).where(eq(comments.issueId, issue.id)),
    drizzle(d1).delete(comments).where(eq(comments.refIssueId, issue.id)),
    drizzle(d1).delete(comments).where(eq(comments.dependentIssueId, issue.id)),
    drizzle(d1).delete(issueLabels).where(eq(issueLabels.issueId, issue.id)),
    // Tier-2 children — the upstream DeleteBeans sweep (issue.go:234–252).
    drizzle(d1).delete(issueContentHistory).where(eq(issueContentHistory.issueId, issue.id)),
    drizzle(d1).delete(issueAssignees).where(eq(issueAssignees.issueId, issue.id)),
    drizzle(d1).delete(issueDependencies).where(eq(issueDependencies.issueId, issue.id)),
    drizzle(d1).delete(issueDependencies).where(eq(issueDependencies.dependencyId, issue.id)),
    drizzle(d1).delete(notificationStates).where(eq(notificationStates.issueId, issue.id)),
    drizzle(d1).delete(issueStopwatches).where(eq(issueStopwatches.issueId, issue.id)),
    drizzle(d1).delete(trackedTimes).where(eq(trackedTimes.issueId, issue.id)),
    // The ProjectIssue detach (issue.go:246) — the review-wave closure of the
    // orphaned-membership gap: a deleted issue must not survive as a ghost
    // card on project columns (the projects service joins project_issues to
    // issues, so the orphan row never rendered, but it stayed in D1).
    drizzle(d1).delete(projectIssues).where(eq(projectIssues.issueId, issue.id)),
    drizzle(d1).delete(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
    drizzle(d1).delete(reactions).where(eq(reactions.issueId, issue.id)),
    drizzle(d1).delete(issueSubscriptions).where(eq(issueSubscriptions.issueId, issue.id)),
    drizzle(d1).delete(issuePins).where(eq(issuePins.issueId, issue.id)),
    drizzle(d1).delete(pullRequests).where(eq(pullRequests.issueId, issue.id)),
    drizzle(d1).delete(issues).where(eq(issues.id, issue.id)),
    drizzle(d1)
      .update(repositories)
      .set(
        issue.isPull
          ? {
              numPulls: sql`MAX(num_pulls - 1, 0)`,
              ...(issue.isClosed ? { numClosedPulls: sql`MAX(num_closed_pulls - 1, 0)` } : {}),
            }
          : {
              numIssues: sql`MAX(num_issues - 1, 0)`,
              ...(issue.isClosed ? { numClosedIssues: sql`MAX(num_closed_issues - 1, 0)` } : {}),
            },
      )
      .where(eq(repositories.id, issue.repoId)),
  ];
  // Label counters: decrement on every attached label (closed-state aware),
  // mirroring the updateIssueNumbers maintenance the rest of the writes do.
  const attached = await drizzle(d1)
    .select({ labelId: issueLabels.labelId })
    .from(issueLabels)
    .where(eq(issueLabels.issueId, issue.id))
    .all();
  for (const { labelId } of attached) {
    statements.push(
      drizzle(d1)
        .update(labels)
        .set(
          issue.isClosed
            ? { numIssues: sql`MAX(num_issues - 1, 0)`, numClosedIssues: sql`MAX(num_closed_issues - 1, 0)` }
            : { numIssues: sql`MAX(num_issues - 1, 0)` },
        )
        .where(eq(labels.id, labelId)),
    );
  }
  // Milestone counters (upstream UpdateMilestoneCounters on the delete path).
  if (issue.milestoneId !== null) {
    const closedAfterDecrement = issue.isClosed ? sql`MAX(num_closed_issues - 1, 0)` : sql`num_closed_issues`;
    statements.push(
      drizzle(d1)
        .update(milestones)
        .set({
          numIssues: sql`MAX(num_issues - 1, 0)`,
          numClosedIssues: closedAfterDecrement,
          completeness: sql`CASE WHEN num_issues > 1 THEN ${closedAfterDecrement} * 100 / (num_issues - 1) WHEN is_closed = 1 THEN 100 ELSE 0 END`,
        })
        .where(eq(milestones.id, issue.milestoneId)),
    );
  }
  await drizzle(d1).batch(statements);
  // The delete event fans out AFTER the sweep committed (upstream notify
  // order, issue.go:183) — from the pre-delete render taken above.
  if (event !== null && emission !== undefined) {
    await emitIssueDeletedEvent(d1, event, emission);
  }
}

// ---------------------------------------------------------------------------
// Shared lookups + error plumbing
// ---------------------------------------------------------------------------

/** Issue lookup within an already-resolved repo; null when the index misses. */
export async function findIssueByRepoAndIndex(d1: D1Database, repoId: string, index: number): Promise<IssueRow | null> {
  const row = await drizzle(d1)
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.index, index)))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** The data layer's typed errors → ApiError with the pinned status/message. */
export function issueErrorToApiError(error: IssueError): ApiError {
  return new ApiError(error.status, error.message);
}

/** Poster-name → id for the list filters (getUserIDForFilter). */
export async function userIdForFilter(d1: D1Database, name: string): Promise<number | null> {
  const user = await findUserByName(d1, name);
  return user === null ? null : user.id;
}

/**
 * `user does not exist` — the getUserIDForFilter arm (routers/api/v1/repo/
 * issue.go:469-479): APIErrorAuto(ErrUserNotExist) unwraps to the ErrNotExist
 * family → 404 with the ErrUserNotExist text (models/user/error.go:46-58,
 * UID unset = 0).
 */
export function userNotExistError(name: string): ApiError {
  return new ApiError(404, `user does not exist [uid: 0, name: ${name}]`);
}

/**
 * `ErrCommentNotExist` (models/issues/comment.go:51) — the 404 message for
 * the global-id comment routes (`comment does not exist [id: X, issue_id: 0]`).
 */
export function commentNotExistError(commentId: number): ApiError {
  return new ApiError(404, `comment does not exist [id: ${commentId}, issue_id: 0]`);
}

/** Users-row lookup by id (comment/issue poster enrichment). */
export async function userRowById(d1: D1Database, id: number) {
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** Users-row lookup by case-insensitive name (search owner filter). */
export async function userRowByName(d1: D1Database, name: string) {
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.usernameLower, name.toLowerCase()))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** Visible repository ids for the search endpoint's repo filter. */
export async function visibleRepoIds(d1: D1Database, viewer: Viewer, ownerLower: string | null): Promise<string[]> {
  const db = drizzle(d1);
  const conditions: SQL[] = [];
  if (ownerLower !== null) {
    conditions.push(eq(repositories.ownerNamespace, ownerLower));
  }
  // Public for anonymous; + the requester's own private when signed (the
  // reduced visibility matrix of canViewRepository).
  if (viewer.requester === null) {
    conditions.push(eq(repositories.visibility, "public"));
  } else if (viewer.requester.is_admin !== true) {
    conditions.push(
      or(eq(repositories.visibility, "public"), eq(repositories.ownerNamespace, (viewer.requester.login ?? "").toLowerCase())) as SQL,
    );
  }
  const rows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();
  return rows.map((row) => row.id);
}
