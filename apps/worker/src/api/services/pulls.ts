import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueLabels, labels, issues, pullRequests, users, PRFlow } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { ApiError } from "../errors";
import type { PullRequest, PRBranchInfo } from "../models/pull";
import { hasWorkInProgressPrefix, toApiIssue } from "./issues";
import { apiUserFromRow, findRepositoryByPath, toApiRepository, type RepositoryWithOwner, type Viewer } from "./repository";

/**
 * PR-block reads/converters backing the tier-1 `pull` routes (SPEC-0004 §2.4
 * rows repoListPullRequests / repoCreatePullRequest / repoGetPullRequest /
 * repoEditPullRequest / repoGetPullRequestByBaseHead; behavior per SPEC-0005
 * §2.4). Mutations ride the landed IssuesService (`createPullRequest` — the
 * shared per-repo counter; close/reopen CAS) plus the issue-edit helpers of
 * services/issues.ts; this module adds what those do not model: the wire
 * converter (upstream `services/convert/pull.go toAPIPullRequest`), the
 * filtered PR list (models/issues/pull_list.go PullRequests), the
 * duplicate-PR check (GetUnmergedPullRequest), and the base/head lookup.
 *
 * Engine boundary (this wave): everything here is D1-only. Upstream resolves
 * `Base.Sha`/`Head.Sha` through the git repo and computes mergeability
 * asynchronously (services/convert/pull.go:151–273); those are engine reads
 * (SPEC-0005 §3.4, specs/0001b). Until the engine RPCs land:
 *   - `mergeable` renders **null** (unknown — the create-time check has not
 *     run; upstream's checking status renders not-mergeable through
 *     `pr.Mergeable(ctx)` gating), the documented deviation from the
 *     contract's boolean type,
 *   - `base.sha` renders "" (branch-tip engine read) and `head.sha` from the
 *     `pull_requests.head_sha` cache ("" when the ref has not landed),
 *   - `additions`/`deletions`/`changed_files`/`review_comments` stay omitted
 *     (upstream omits them in lists too: services/convert/pull.go:488–492),
 *   - POST /pulls accepts the create per upstream shape without the
 *     base/head branch-existence check (engine read) — validated at the
 *     mergeability wave.
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - converter: services/convert/pull.go toAPIPullRequest / ToAPIPullRequests
 *     (`url` = Issue.HTMLURL — the HTML-form path `/pulls/{index}`, the
 *     upstream quirk; head.ref = refs/pull/{index}/head via
 *     GetGitHeadRefName; the `merged*` trio set only when HasMerged;
 *     requested_reviewers "[]" not null; `assignees` SliceNilAsEmpty in the
 *     single converter, raw (null) in the list one);
 *   - list: models/issues/pull_list.go listPullRequestStatement + applySorts
 *     (state matches ONLY "open"/"closed" — absent/all/garbage list BOTH
 *     states; default order created_unix DESC, id DESC; invalid sort values
 *     fall back to the default, never a 422);
 *   - duplicate check: models/issues/pull.go GetUnmergedPullRequest +
 *     ErrPullRequestAlreadyExists.Error (issue_id carries the INDEX);
 *   - base/head lookup: routers/api/v1/repo/pull.go GetPullRequestByBaseHead
 *     (the `owner:branch` / `owner/name:branch` fork form resolves the head
 *     repo — forks cannot exist yet, so the fork form 404s);
 *   - WIP draft: models/issues/pull.go HasWorkInProgressPrefix.
 */

/** The joined PR view every read returns (a PR *is* an issue, §2.4). */
export interface PullRequestWithIssue {
  issue: IssueRow;
  pullRequest: PullRequestRow;
}

// ---------------------------------------------------------------------------
// Lookups (models/issues/pull.go)
// ---------------------------------------------------------------------------

function pullRequestJoinedQuery(d1: D1Database) {
  return drizzle(d1)
    .select({ issue: issues, pullRequest: pullRequests })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId));
}

/** `GetPullRequestByIndex` — the per-repo index into the shared sequence. */
export async function findPullRequestByIndex(d1: D1Database, repoId: string, index: number): Promise<PullRequestWithIssue | null> {
  const rows = await pullRequestJoinedQuery(d1)
    .where(and(eq(pullRequests.baseRepoId, repoId), eq(pullRequests.index, index)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `GetPullRequestByBaseHeadInfo` — pure D1 lookup on the base/head columns.
 * `headRepoId` resolves from the fork-form `owner[:name]:branch` head (the
 * route's job); same-repo lookups pass the base repo id.
 */
export async function findPullRequestByBaseHeadInfo(
  d1: D1Database,
  baseRepoId: string,
  headRepoId: string,
  baseBranch: string,
  headBranch: string,
): Promise<PullRequestWithIssue | null> {
  const rows = await pullRequestJoinedQuery(d1)
    .where(
      and(
        eq(pullRequests.baseRepoId, baseRepoId),
        eq(pullRequests.headRepoId, headRepoId),
        eq(pullRequests.baseBranch, baseBranch),
        eq(pullRequests.headBranch, headBranch),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `GetUnmergedPullRequest` — the open, unmerged PR with these exact targets
 * (github flow); the POST duplicate check.
 */
export async function findUnmergedPullRequest(
  d1: D1Database,
  headRepoId: string,
  baseRepoId: string,
  headBranch: string,
  baseBranch: string,
): Promise<PullRequestWithIssue | null> {
  const rows = await pullRequestJoinedQuery(d1)
    .where(
      and(
        eq(pullRequests.headRepoId, headRepoId),
        eq(pullRequests.baseRepoId, baseRepoId),
        eq(pullRequests.headBranch, headBranch),
        eq(pullRequests.baseBranch, baseBranch),
        eq(pullRequests.hasMerged, false),
        eq(pullRequests.flow, PRFlow.Github),
        eq(issues.isClosed, false),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** `ErrPullRequestAlreadyExists.Error()` — `issue_id` carries the INDEX (upstream quirk). */
export function pullRequestAlreadyExistsError(pr: PullRequestWithIssue): ApiError {
  const { pullRequest } = pr;
  return new ApiError(
    409,
    "pull request already exists for these targets " +
      `[id: ${pullRequest.id}, issue_id: ${pullRequest.index}, head_repo_id: ${pullRequest.headRepoId}, ` +
      `base_repo_id: ${pullRequest.baseRepoId}, head_branch: ${pullRequest.headBranch}, base_branch: ${pullRequest.baseBranch}]`,
  );
}

/** `ErrPullRequestNotExist` (models/issues/pull.go:388) — the 404 message. */
export function pullRequestNotExistError(repoId: string, index: number): ApiError {
  return new ApiError(404, `pull request does not exist [id: 0, repo_id: ${repoId}, index: ${index}]`);
}

// ---------------------------------------------------------------------------
// List (models/issues/pull_list.go PullRequests + applySorts)
// ---------------------------------------------------------------------------

export interface PullRequestListFilters {
  /** "open"/"closed" filter; ANY other value (absent/all/garbage) lists both states. */
  state: string;
  /** Sort enum of the contract; invalid values fall back to the default order. */
  sort: string;
  /** Label ids (any-of); non-integer entries answered by the route. */
  labelIds: number[];
  /** Milestone id (FormInt64 — 0 = no filter). */
  milestoneId: number;
  /** Poster id (resolved from the `poster` username filter); 0 = none. */
  posterId: number;
  /** `base_branch` exact-match filter, "" = none. */
  baseBranch: string;
  page: number;
  limit: number;
}

/** `applySorts` (models/issues/issue_search.go:74) — the PR-list subset. The
 *  columns are qualified because the list reads over the pull_requests ⋈
 *  issues join (upstream orders on the same `issue.*` columns). */
function pullRequestOrderBy(sort: string): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(issues.createdAt), asc(issues.id)];
    case "recentupdate":
      return [desc(issues.updatedAt), desc(issues.createdAt), desc(issues.id)];
    case "recentclose":
      return [desc(issues.closedAt), desc(issues.createdAt), desc(issues.id)];
    case "leastupdate":
      return [asc(issues.updatedAt), asc(issues.createdAt), asc(issues.id)];
    case "mostcomment":
      return [desc(issues.numComments), desc(issues.createdAt), desc(issues.id)];
    case "leastcomment":
      return [asc(issues.numComments), desc(issues.createdAt), desc(issues.id)];
    case "priority":
      return [desc(issues.priority), desc(issues.createdAt), asc(issues.id)];
    default:
      return [desc(issues.createdAt), desc(issues.id)];
  }
}

function pullRequestListConditions(d1: D1Database, repoId: string, filters: PullRequestListFilters): SQL[] {
  const conditions: SQL[] = [eq(pullRequests.baseRepoId, repoId)];
  if (filters.state === "open" || filters.state === "closed") {
    conditions.push(eq(issues.isClosed, filters.state === "closed"));
  }
  if (filters.labelIds.length > 0) {
    // INNER JOIN issue_label … IN — any-of semantics (pull_list.go:44–48).
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
  if (filters.milestoneId > 0) {
    conditions.push(eq(issues.milestoneId, filters.milestoneId));
  }
  if (filters.posterId > 0) {
    conditions.push(eq(issues.posterId, filters.posterId));
  }
  if (filters.baseBranch !== "") {
    conditions.push(eq(pullRequests.baseBranch, filters.baseBranch));
  }
  return conditions;
}

/** The filtered, sorted, paginated PR list with its total count. */
export async function listRepoPullRequests(
  d1: D1Database,
  repoId: string,
  filters: PullRequestListFilters,
): Promise<{ items: PullRequestWithIssue[]; total: number }> {
  const where = and(...pullRequestListConditions(d1, repoId, filters));
  const db = drizzle(d1);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(where);
  const items = await db
    .select({ issue: issues, pullRequest: pullRequests })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(where)
    .orderBy(...pullRequestOrderBy(filters.sort))
    .limit(filters.limit)
    .offset((filters.page - 1) * filters.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

// ---------------------------------------------------------------------------
// Converter — services/convert/pull.go toAPIPullRequest / ToAPIPullRequests
// ---------------------------------------------------------------------------

/** `GetGitHeadRefName` — the base-repo PR head ref (models/issues/pull.go:406). */
export function pullHeadRefName(index: number): string {
  return `refs/pull/${index}/head`;
}

/** Numeric rendering of the registry's text id (services/repository.ts rule). */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** `PRBranchInfo` for the BASE side (upstream renders the base repo + doer permission view). */
function baseBranchInfo(viewer: Viewer, pair: RepositoryWithOwner, pr: PullRequestRow): PRBranchInfo {
  return {
    label: pr.baseBranch,
    ref: pr.baseBranch,
    // Base branch tip — an engine read this wave (services/convert/pull.go
    // resolves it through the git repo; "" upstream when the branch is gone).
    sha: "",
    repo_id: repoIdNumber(pr.baseRepoId),
    repo: toApiRepository(viewer, pair),
  };
}

/**
 * The HEAD side `PRBranchInfo`: `ref` is `refs/pull/{index}/head` — the exact
 * fallback upstream takes when the head branch no longer exists (branch
 * existence is an engine read, deferred with the mergeability wave);
 * `repo`/`repo_id` render only for same-repo PRs (forks cannot exist yet),
 * mirroring upstream's hidden-head-repo rule (services/convert/pull.go:197 —
 * a head repo the doer cannot see stays `repo_id: -1`, `repo: null`).
 */
function headBranchInfo(viewer: Viewer, pair: RepositoryWithOwner, pr: PullRequestRow): PRBranchInfo {
  const sameRepo = pr.headRepoId === pair.repo.id;
  return {
    label: pr.headBranch,
    ref: pullHeadRefName(pr.index),
    sha: pr.headSha ?? "",
    repo_id: sameRepo ? repoIdNumber(pr.headRepoId) : -1,
    repo: sameRepo ? toApiRepository(viewer, pair) : undefined,
  };
}

/**
 * `convert.toAPIPullRequest` → the contract `PullRequest`. Composes the
 * `ToAPIIssue` render (poster/labels/milestone/counts) exactly like upstream
 * and overrides the issue URLs with the pull ones (`Issue.HTMLURL` picks the
 * `pulls` path for `is_pull` rows). `mode` mirrors the single-vs-list
 * converter split: the single converter empties `assignees`
 * (`util.SliceNilAsEmpty`), the list one passes the raw null through.
 */
export async function toApiPullRequest(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  mode: "single" | "list",
): Promise<PullRequest> {
  const apiIssue = await toApiIssue(d1, viewer, pair, issue);
  const htmlUrl =
    `${viewer.origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/` +
    `${encodeURIComponent(pair.repo.slug)}/pulls/${issue.index}`;

  let mergedBy: PullRequest["merged_by"] = null;
  let mergedAt: string | null = null;
  let mergeCommitSha: string | null = null;
  if (pr.hasMerged) {
    mergedAt = pr.mergedAt === null || pr.mergedAt === undefined ? null : pr.mergedAt.toISOString();
    mergeCommitSha = pr.mergedCommitId ?? "";
    if (pr.mergerId !== null && pr.mergerId !== undefined) {
      const merger = await drizzle(d1)
        .select()
        .from(users)
        .where(eq(users.id, pr.mergerId))
        .limit(1)
        .then((rows) => rows[0]);
      mergedBy = merger === undefined ? null : apiUserFromRow(merger, viewer);
    }
  }

  return {
    id: pr.id,
    url: htmlUrl,
    number: pr.index,
    user: apiIssue.user,
    title: issue.title,
    body: issue.content ?? "",
    labels: apiIssue.labels ?? [],
    milestone: apiIssue.milestone,
    assignee: apiIssue.assignee,
    assignees: mode === "single" ? apiIssue.assignees ?? [] : apiIssue.assignees,
    requested_reviewers: [],
    requested_reviewers_teams: [],
    state: issue.isClosed ? "closed" : "open",
    draft: hasWorkInProgressPrefix(issue.title),
    is_locked: issue.isLocked,
    comments: issue.numComments,
    html_url: htmlUrl,
    diff_url: `${htmlUrl}.diff`,
    patch_url: `${htmlUrl}.patch`,
    // Mergeability state machine — engine wave (SPEC-0005 §3.4). Null = unknown.
    mergeable: null,
    merged: pr.hasMerged,
    merged_at: mergedAt,
    merge_commit_sha: mergeCommitSha,
    merged_by: mergedBy,
    allow_maintainer_edit: pr.allowMaintainerEdit,
    base: baseBranchInfo(viewer, pair, pr),
    head: headBranchInfo(viewer, pair, pr),
    merge_base: pr.mergeBase ?? "",
    due_date: apiIssue.due_date,
    created_at: apiIssue.created_at,
    updated_at: apiIssue.updated_at,
    closed_at: issue.closedAt === null ? null : issue.closedAt.toISOString(),
    pin_order: apiIssue.pin_order ?? 0,
    content_version: issue.contentVersion,
  };
}

// ---------------------------------------------------------------------------
// `{base}/{head}` route support
// (routers/api/v1/repo/pull.go GetPullRequestByBaseHead)
// ---------------------------------------------------------------------------

/**
 * The `head` path parameter parse: `owner:branch` / `owner/name:branch` fork
 * forms resolve the head repo (404 when the repo does not exist — forks
 * cannot exist yet); the plain form is a branch of the base repo.
 */
export async function resolveHeadRepo(
  d1: D1Database,
  baseRepo: RepositoryWithOwner,
  headParam: string,
): Promise<{ headRepoId: string; headBranch: string }> {
  if (!headParam.includes(":")) {
    return { headRepoId: baseRepo.repo.id, headBranch: headParam };
  }
  const colon = headParam.indexOf(":");
  const repoPart = headParam.slice(0, colon);
  const headBranch = headParam.slice(colon + 1);
  const slash = repoPart.indexOf("/");
  const owner = slash > 0 ? repoPart.slice(0, slash) : repoPart;
  const name = slash > 0 ? repoPart.slice(slash + 1) : baseRepo.repo.slug;
  const repo = await findRepositoryByPath(d1, owner, name);
  if (repo === null) {
    throw new ApiError(404, "not found");
  }
  return { headRepoId: repo.repo.id, headBranch };
}

/**
 * Label ids actually attached to this repo — the POST/PATCH label pre-filter
 * (upstream `GetLabelsInRepoByIDs`: unknown ids are silently dropped, unlike
 * POST /issues which 404s them).
 */
export async function existingRepoLabelIds(d1: D1Database, repoId: string, labelIds: number[]): Promise<number[]> {
  if (labelIds.length === 0) return [];
  const unique = [...new Set(labelIds)];
  const rows = await drizzle(d1)
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.repoId, repoId), inArray(labels.id, unique)))
    .orderBy(asc(labels.id))
    .all();
  return rows.map((row) => row.id);
}
