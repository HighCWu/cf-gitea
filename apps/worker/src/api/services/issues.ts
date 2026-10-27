import { and, asc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import {
  comments,
  issueContentHistory,
  issueLabels,
  issuePins,
  issueSubscriptions,
  issues,
  labels,
  milestones,
  pullRequests,
  reactions,
  repositories,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueError } from "../../issues/errors";
import type { CommentRow, IssueRow, LabelRow } from "../../issues/service";
import { ApiError } from "../errors";
import type { Comment, Issue, TimelineComment } from "../models/issue";
import type { User } from "../models/user";
import { toApiMilestone } from "./milestones";
import {
  apiRepositoryUrl,
  apiUserFromRow,
  findUserByName,
  GO_ZERO_TIME,
  type RepositoryWithOwner,
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
 *     NumComments, PinOrder -1→0, TimeEstimate, ContentVersion);
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
 *     cascade + DecrRepoIssueNumbers; the index counter is never rewound).
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

/** The PullRequestMeta block for PR issues (convert `issue.LoadPullRequest`). */
async function pullRequestMetaOf(
  d1: D1Database,
  pair: RepositoryWithOwner,
  origin: string,
  issue: IssueRow,
): Promise<{ merged: boolean; merged_at: string | null; draft: boolean; html_url: string } | null> {
  if (!issue.isPull) {
    return null;
  }
  const pr = await drizzle(d1)
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.issueId, issue.id))
    .limit(1)
    .then((rows) => rows[0]);
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
 * `convert.ToIssue` → the contract `Issue`. Enrichment reads per render:
 * poster row, label join, milestone row, PR row (PRs only) — the same loads
 * upstream's toIssue performs (LoadPoster/LoadLabels/LoadMilestone/
 * LoadPullRequest).
 */
export async function toApiIssue(d1: D1Database, viewer: Viewer, pair: RepositoryWithOwner, issue: IssueRow): Promise<Issue> {
  const poster = await toPoster(d1, viewer, issue.posterId);
  const labelRows = await issueLabelRows(d1, issue.id);
  const milestoneRow =
    issue.milestoneId === null
      ? null
      : await drizzle(d1)
          .select()
          .from(milestones)
          .where(eq(milestones.id, issue.milestoneId))
          .limit(1)
          .then((rows) => (rows[0] === undefined ? null : rows[0]));
  const pullRequest = await pullRequestMetaOf(d1, pair, viewer.origin, issue);

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
    assignee: null, // TODO(SPEC-0005 tier 2): issue_assignees table
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
    pin_order: 0, // issue_pins is tier 2 (SPEC-0005 §3.2); upstream -1 → 0
    content_version: issue.contentVersion,
  };
}

/**
 * `convert.ToAPIComment` → the contract `Comment`. `issue_url` is the issue
 * page for issues and the EMPTY STRING for PRs; `pull_request_url` the
 * mirror image (models/issues/comment.go IssueURL/PRURL). The poster row is
 * fetched per render (upstream `comments.LoadPosters`).
 */
export async function toApiComment(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  comment: CommentRow,
): Promise<Comment> {
  const poster = await toPoster(d1, viewer, comment.posterId);
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
 */
export async function toTimelineComment(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  comment: CommentRow,
): Promise<TimelineComment> {
  const poster = await toPoster(d1, viewer, comment.posterId);
  const issuePageUrl = issueHtmlUrl(pair, viewer.origin, issue.index);
  const htmlUrl = commentHtmlUrl(pair, viewer.origin, issue.index, issue.isPull, comment.id);

  const [oldMilestoneRow, milestoneRow, labelRow, assigneeRow] = await Promise.all([
    comment.oldMilestoneId === null || comment.oldMilestoneId === undefined
      ? Promise.resolve(null)
      : drizzle(d1)
          .select()
          .from(milestones)
          .where(eq(milestones.id, comment.oldMilestoneId))
          .limit(1)
          .then((rows) => (rows[0] === undefined ? null : rows[0])),
    comment.milestoneId === null || comment.milestoneId === undefined
      ? Promise.resolve(null)
      : drizzle(d1)
          .select()
          .from(milestones)
          .where(eq(milestones.id, comment.milestoneId))
          .limit(1)
          .then((rows) => (rows[0] === undefined ? null : rows[0])),
    comment.labelId === null || comment.labelId === undefined
      ? Promise.resolve(null)
      : drizzle(d1)
          .select()
          .from(labels)
          .where(eq(labels.id, comment.labelId))
          .limit(1)
          .then((rows) => (rows[0] === undefined ? null : rows[0])),
    comment.assigneeId === null || comment.assigneeId === undefined
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
// Issue delete (§4.12 — services/issue/issue.go deleteIssue cascade)
// ---------------------------------------------------------------------------

/**
 * The §4.12 delete cascade in ONE D1 batch: comments (own rows + xref rows
 * pointing here + dependency rows), issue_labels, reactions, subscriptions,
 * pins, the PR row, the issue row, the label open-counter decrements, and
 * the repo open-counter decrements (`DecrRepoIssueNumbers`). The milestone
 * counters move like upstream's `UpdateMilestoneCounters`. The index counter
 * is NOT rewound (§2.2). DEVIATION: upstream also removes
 * `refs/pull/N/head` from the engine (services/issue/issue.go:174–181) — the
 * engine ref write lands with the PR routes (SPEC-0005 §3.4) and is
 * deferred with them.
 */
export async function deleteIssueCascade(d1: D1Database, issue: IssueRow): Promise<void> {
  const statements: [BatchStatement, ...BatchStatement[]] = [
    drizzle(d1).delete(comments).where(eq(comments.issueId, issue.id)),
    drizzle(d1).delete(comments).where(eq(comments.refIssueId, issue.id)),
    drizzle(d1).delete(comments).where(eq(comments.dependentIssueId, issue.id)),
    drizzle(d1).delete(issueLabels).where(eq(issueLabels.issueId, issue.id)),
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

/** `user does not exist` — APIErrorAuto's 422 rendering of ErrUserNotExist. */
export function userNotExistError(name: string): ApiError {
  return new ApiError(422, `user does not exist [name: ${name}]`);
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
