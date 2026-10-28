import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueLabels, labels, issues, pullRequests, repositories, users, PRFlow, type TeamAccessMode } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { ApiError } from "../errors";
import type { PullRequest, PRBranchInfo } from "../models/pull";
import { findForkByOwner } from "./forks";
import { hasWorkInProgressPrefix, prefetchIssueRenderContext, toApiIssue, type IssueRenderContext } from "./issues";
import { mergeableOfRow } from "./pull-engine";
import {
  apiUserFromRow,
  canViewRepository,
  findRepositoriesByIds,
  findRepositoryById,
  findRepositoryByPath,
  findUserByName,
  toApiRepository,
  viewerTeamAccessMode,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "./repository";

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
 * Engine boundary (the mergeability wave, SPEC-0005 §3.4): the converter
 * renders from the D1 row's cached state machine; the ENGINE reads (base
 * branch tip, mergeability, diffs, merges) live in services/pull-engine.ts
 * and flow in through `extras`. Upstream resolves `Base.Sha`/`Head.Sha`
 * through the git repo and computes mergeability asynchronously
 * (services/convert/pull.go:151–273):
 *   - `mergeable` renders from the row's status (checking → **null** —
 *     unknown; mergeable → true; otherwise false — upstream's checking
 *     status renders not-mergeable through `pr.Mergeable(ctx)` gating), the
 *     documented deviation from the contract's boolean type,
 *   - `base.sha` renders "" unless the caller supplies `extras.baseSha`
 *     (the single-GET route resolves the engine tip),
 *   - `head.sha` renders from the `pull_requests.head_sha` cache ("" when
 *     the ref has not landed),
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
 *     and parseCompareInfo's `GetHeadOwnerAndRepo` — the bare `owner:branch`
 *     form resolves the head repo through the FORK EDGE (FindHeadRepo →
 *     GetUserFork, rename-immune; resolveHeadRepo below), the full
 *     `owner/name:branch` form by path — the anti-enumeration CanRead 404 is
 *     the route's guard, landed with the a16f60e fork edge;
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
 * The batch twin of `findPullRequestByIndex` for the pinned-pulls list (the
 * M-grade list batching's one genuinely new read): ONE select for the page's
 * PR rows on the exact per-row predicate (`base_repo_id` + `index IN …`),
 * keyed by index — an index with no PR row is absent from the map, rendering
 * exactly like the per-row null (the route's missing-pair skip). An empty
 * page skips to zero statements.
 */
export async function findPullRequestsByIndices(d1: D1Database, repoId: string, indices: number[]): Promise<Map<number, PullRequestRow>> {
  if (indices.length === 0) {
    return new Map();
  }
  const rows = await drizzle(d1)
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.baseRepoId, repoId), inArray(pullRequests.index, indices)))
    .all();
  return new Map(rows.map((row) => [row.index, row]));
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

/** The page-scoped batch behind the list route's `toApiPullRequest` renders
 *  (the query-shape audit's A3): the issue-side rows (A2's maps, feeding
 *  toApiIssue through the B1 pass-through), the merger rows of the page's
 *  merged PRs, and the FORK head-repo pairs with ONE resolved grant per
 *  distinct head repo (the same-repo heads never enter the map — they were
 *  already free). */
export interface PullRequestRenderContext {
  issue: IssueRenderContext;
  /** Merger user rows by id (merged PRs only; a missing id renders the
   *  per-row null `merged_by`). */
  mergers: Map<number, UserRow>;
  /** Head-repo pairs by repo id (a missing id renders the hidden-head
   *  defaults, exactly like the per-row `findRepositoryById` null). */
  headRepos: Map<string, RepositoryWithOwner>;
  /** One `viewerTeamAccessMode` resolution per `headRepos` entry (null =
   *  the pure matrix decides — anonymous/admin/owner resolve without D1). */
  headRepoModes: Map<string, TeamAccessMode | null>;
}

/**
 * One batched read per entity kind for the page's PR rows, plus one grant
 * resolution per DISTINCT fork head repo. Id lists stay far under the D1
 * 100-variable cap (the paging clamps at 50 rows).
 */
export async function prefetchPullRequestRenderContext(
  d1: D1Database,
  viewer: Viewer,
  basePair: RepositoryWithOwner,
  rows: PullRequestWithIssue[],
): Promise<PullRequestRenderContext> {
  const mergerIds = [
    ...new Set(
      rows.flatMap(({ pullRequest }) =>
        pullRequest.hasMerged && pullRequest.mergerId !== null && pullRequest.mergerId !== undefined
          ? [pullRequest.mergerId]
          : [],
      ),
    ),
  ];
  const headRepoIds = [
    ...new Set(rows.flatMap(({ pullRequest }) => (pullRequest.headRepoId === basePair.repo.id ? [] : [pullRequest.headRepoId]))),
  ];
  const [mergerRows, headRepos, issue] = await Promise.all([
    mergerIds.length > 0 ? drizzle(d1).select().from(users).where(inArray(users.id, mergerIds)).all() : Promise.resolve([]),
    findRepositoriesByIds(d1, headRepoIds),
    prefetchIssueRenderContext(d1, rows.map((row) => row.issue)),
  ]);
  const headRepoModes = new Map<string, TeamAccessMode | null>();
  await Promise.all(
    [...headRepos.values()].map(async (headPair) => {
      headRepoModes.set(headPair.repo.id, await viewerTeamAccessMode(d1, viewer, headPair.repo));
    }),
  );
  return {
    issue,
    mergers: new Map(mergerRows.map((row) => [row.id, row])),
    headRepos,
    headRepoModes,
  };
}

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
    // Base branch tip — an engine read; the single-GET route supplies it via
    // extras.baseSha (services/pull-engine.ts), lists render "".
    sha: "",
    repo_id: repoIdNumber(pr.baseRepoId),
    repo: toApiRepository(viewer, pair),
  };
}

/**
 * The HEAD side `PRBranchInfo`: `ref` is `refs/pull/{index}/head` — the exact
 * fallback upstream takes when the head branch no longer exists (branch
 * existence is an engine read, deferred with the mergeability wave).
 *
 * The `repo`/`repo_id` pair ports upstream's hidden-head-repo rule
 * (services/convert/pull.go:187-199 single, :435-450 list — both apply the
 * same gate): for a Github-flow PR whose head repo differs from the base,
 * the doer's permission is resolved ON THE HEAD REPO and the fork renders
 * (`Head.RepoID` + `ToRepo(head, p)`) only when
 * `p.HasAnyUnitAccessOrPublicAccess()` (models/perm/access/repo_permission.go:77)
 * — a hidden head repo keeps the struct-literal defaults `repo_id: -1`,
 * `repo: null` (pull.go:120) while `label`/`ref`/`sha` stay set. The gate
 * folds onto the landed visibility matrix: upstream grants an anonymous doer
 * AccessModeRead on a PUBLIC repo (repo_permission.go:468-472) and None on a
 * private one (:442-446), so `canViewRepository` + the org/team grant
 * (`viewerTeamAccessMode`) is the exact predicate — a public fork renders
 * for everyone (anonymous included, pull-only permissions block), a private
 * fork only for its owner / site admin / org-granted doers. Same-repo heads
 * short-circuit like upstream's `HeadRepoID == BaseRepoID` arm (pull.go:197,
 * no permission read, the base pair renders).
 *
 * `isPayload` ports upstream's `ToPayloadPullRequest` arm (pull.go:33-37 —
 * "keeps the head repository regardless of the doer, for webhook and Actions
 * payloads"; the disjunction at :197 `isPayload || HeadRepoID == BaseRepoID ||
 * HasAnyUnitAccessOrPublicAccess()`): a payload emitter renders the fork
 * UNCONDITIONALLY — receivers are configured destinations, not the requesting
 * doer, so the visibility gate has no one to protect — while the permission
 * resolution stays (upstream still feeds the doer's `p` to `ToRepo`, so the
 * embedded repo object carries the doer's view; ours passes the resolved
 * `teamMode` through unchanged).
 *
 * Deviations: a deleted head-repo row hides like an unreadable one (upstream
 * `LoadHeadRepo` errors out the whole converter — impossible there, the row
 * is NOT NULL); the AGit-flow arm (pull.go:156-161: head = the base repo,
 * name = "") has no D1 producer (every row is Github flow).
 *
 * `context` (optional) is the page-scoped `prefetchPullRequestRenderContext`
 * result — the fork head pairs and their per-distinct-repo grant modes are
 * then map reads; without it the per-row lookups run (single-item routes).
 * A mode-map miss falls back to null (the pure matrix), which renders
 * identically for the prefetch-filled maps the routes pass.
 */
async function headBranchInfo(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  pr: PullRequestRow,
  isPayload: boolean,
  context?: PullRequestRenderContext,
): Promise<PRBranchInfo> {
  const sameRepo = pr.headRepoId === pair.repo.id;
  if (sameRepo) {
    return {
      label: pr.headBranch,
      ref: pullHeadRefName(pr.index),
      sha: pr.headSha ?? "",
      repo_id: repoIdNumber(pr.headRepoId),
      repo: toApiRepository(viewer, pair),
    };
  }
  const headPair = context === undefined ? await findRepositoryById(d1, pr.headRepoId) : (context.headRepos.get(pr.headRepoId) ?? null);
  if (headPair !== null) {
    const teamMode =
      context === undefined
        ? await viewerTeamAccessMode(d1, viewer, headPair.repo)
        : (context.headRepoModes.get(headPair.repo.id) ?? null);
    // Upstream's :197 disjunction minus the same-repo arm (handled above):
    // payload mode renders the fork regardless of the doer's permission.
    if (isPayload || canViewRepository(viewer, headPair.repo, teamMode)) {
      return {
        label: pr.headBranch,
        ref: pullHeadRefName(pr.index),
        sha: pr.headSha ?? "",
        repo_id: repoIdNumber(headPair.repo.id),
        repo: toApiRepository(viewer, headPair, undefined, teamMode),
      };
    }
  }
  // Hidden head (unreadable fork, or the row vanished): the -1/nil defaults
  // upstream starts from (pull.go:120), branch fields intact. The JSON writer
  // drops `undefined`, so the emitted body omits `repo` where Go marshals a
  // literal null — key-absence on the wire, the schema stays optional.
  return {
    label: pr.headBranch,
    ref: pullHeadRefName(pr.index),
    sha: pr.headSha ?? "",
    repo_id: -1,
    repo: undefined,
  };
}

/**
 * `convert.toAPIPullRequest` → the contract `PullRequest`. Composes the
 * `ToAPIIssue` render (poster/labels/milestone/counts) exactly like upstream
 * and overrides the issue URLs with the pull ones (`Issue.HTMLURL` picks the
 * `pulls` path for `is_pull` rows). `mode` mirrors the upstream converter
 * split: the single converter empties `assignees` (`util.SliceNilAsEmpty`),
 * the list one passes the raw null through, and `"payload"` is
 * `ToPayloadPullRequest` (pull.go:30-34 — the SINGLE converter with
 * `isPayload=true`): single-shape `assignees` PLUS the unconditional head-repo
 * render (`headBranchInfo`'s payload arm, pull.go:197) for the webhook and
 * Actions emitters — payloads go to configured receivers, so the doer's
 * visibility must not hide the head repo upstream shows.
 *
 * `extras` carries the engine-derived fields the routes resolve (the
 * mergeability wave, SPEC-0005 §3.4): `mergeable` renders from the row's
 * status machine (checking → null, mergeable → true, else false; a merged
 * PR → false) and `base.sha` from the base branch tip — list rendering keeps
 * the null/"" defaults to stay D1-only.
 *
 * `preloaded` (optional) is the list route's page-scoped
 * `prefetchPullRequestRenderContext` — the enrichment reads then collapse to
 * map lookups (and the caller-held PR row rides toApiIssue's B1 pass-through
 * in BOTH modes, so the redundant pull_requests re-select never runs on a PR
 * render). Without it the per-row reads run exactly as before.
 */
export async function toApiPullRequest(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  pr: PullRequestRow,
  mode: "single" | "list" | "payload",
  extras?: { mergeable?: boolean | null; baseSha?: string },
  preloaded?: { context?: PullRequestRenderContext },
): Promise<PullRequest> {
  const context = preloaded?.context;
  // B1 (query-shape audit): the PR row is in hand — never re-select it.
  const apiIssue = await toApiIssue(d1, viewer, pair, issue, { prRow: pr, context: context?.issue });
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
      const merger =
        context === undefined
          ? await drizzle(d1)
              .select()
              .from(users)
              .where(eq(users.id, pr.mergerId))
              .limit(1)
              .then((rows) => rows[0])
          : context.mergers.get(pr.mergerId);
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
    // "payload" renders the single converter's shape (upstream's payload
    // converter IS toAPIPullRequest — pull.go:31-34); only "list" keeps the
    // raw null (ToAPIPullRequests vs SliceNilAsEmpty).
    assignees: mode === "list" ? apiIssue.assignees : apiIssue.assignees ?? [],
    requested_reviewers: [],
    requested_reviewers_teams: [],
    state: issue.isClosed ? "closed" : "open",
    draft: hasWorkInProgressPrefix(issue.title),
    is_locked: issue.isLocked,
    comments: issue.numComments,
    html_url: htmlUrl,
    diff_url: `${htmlUrl}.diff`,
    patch_url: `${htmlUrl}.patch`,
    // Mergeability state machine (SPEC-0005 §3.4): checking → null (unknown),
    // mergeable → true, conflict/empty/ancestor/error → false. The single
    // route resolves it lazily (ensurePullRequestChecked) and passes the
    // value through `extras`; the list renders from the cached row.
    mergeable: extras?.mergeable !== undefined ? extras.mergeable : mergeableOfRow(pr),
    merged: pr.hasMerged,
    merged_at: mergedAt,
    merge_commit_sha: mergeCommitSha,
    merged_by: mergedBy,
    allow_maintainer_edit: pr.allowMaintainerEdit,
    base: { ...baseBranchInfo(viewer, pair, pr), ...(extras?.baseSha === undefined ? {} : { sha: extras.baseSha }) },
    head: await headBranchInfo(d1, viewer, pair, pr, mode === "payload", context),
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
 * The `head` path parameter parse. The plain form is a branch of the base
 * repo; the fork forms resolve the head repo (the doer's READ gate on the
 * result is the route's CanRead guard — parseCompareInfo pull.go:1063-1074).
 *
 * The bare `owner:branch` form ports `GetHeadOwnerAndRepo`'s no-repo-name arm
 * (routers/common/compare.go:152-192): the base owner's own name IS the base
 * repo (:161-163 + :170-171); any other owner resolves through the FORK EDGE
 * — `FindHeadRepo` (compare.go:134-150) → `findHeadRepoFromRootBase`
 * (:194-225) → `GetUserFork` (`fork_id = ? AND owner_id = ?`,
 * models/repo/fork.go:45-55). The edge never touches the repo's NAME, so a
 * RENAMED fork keeps resolving — the wave-renamed-fork-head fix (the old
 * direct `(owner, base slug)` path lookup 404'd it). Upstream's
 * `LookupRedirect` (models/repo/redirect.go:55-64) plays NO part in this
 * resolution — the bare grammar carries no repo name to redirect; redirects
 * serve repo-PATH lookups (routers/api/v1/api.go:185,
 * services/context/repo.go:591). A head owner the fork edge cannot place
 * falls back to the landed path acceptance — the head owner's repo at the
 * base's slug (the documented acceptance of a NON-fork head, where upstream's
 * bare form would refuse; the routes/pulls.ts divergence note) — checked
 * AFTER the fork edge so a renamed fork wins over a coincidental same-named
 * non-fork, the upstream-true winner. The full `owner/name:branch` form
 * stays the direct path lookup, exactly upstream's `GetRepositoryByName` arm
 * (compare.go:181-189).
 *
 * Misses answer the landed anti-enumeration 404 "not found" (a16f60e).
 * Upstream splits them: an unknown head owner is 404 (GetUserByName →
 * util.ErrNotExist → APIErrorNotFound, pull.go:1056-1058) while a KNOWN owner
 * without a fork of the base is 400 "the user %s does not have a fork of the
 * base repository" (compare.go:178 → pull.go:1053-1055 ErrInvalidArgument) —
 * the flat 404 is a deliberate deviation (the 400 would enumerate fork
 * existence per owner name).
 *
 * Deviation vs upstream's GET arm: repoGetPullRequestByBaseHead resolves the
 * head repo through THIS shared resolver, so its bare form is fork-edge
 * rename-immune too, where upstream's GET lookup is the name-only
 * `GetRepositoryByOwnerAndName` (pull.go:263 — a renamed fork's old name 404s
 * there); the POST arm (parseCompareInfo, pull.go:1051 → GetHeadOwnerAndRepo)
 * is the upstream shape being ported.
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
  if (slash < 1) {
    // Bare `owner:branch` — the fork-edge grammar (compare.go:161-180).
    const ownerLower = owner.toLowerCase();
    if (ownerLower === baseRepo.repo.ownerNamespace) {
      return { headRepoId: baseRepo.repo.id, headBranch };
    }
    const headOwner = await findUserByName(d1, ownerLower);
    if (headOwner !== null) {
      const forkId = await findHeadRepoByForkEdge(d1, baseRepo, headOwner.id);
      if (forkId !== null) {
        return { headRepoId: forkId, headBranch };
      }
    }
    // The landed path acceptance: the head owner's repo at the base's slug
    // (non-fork heads; upstream's bare form would 400 them — see above).
    const repo = await findRepositoryByPath(d1, ownerLower, baseRepo.repo.slug);
    if (repo !== null) {
      return { headRepoId: repo.repo.id, headBranch };
    }
    throw new ApiError(404, "not found");
  }
  const name = repoPart.slice(slash + 1);
  const repo = await findRepositoryByPath(d1, owner, name);
  if (repo === null) {
    throw new ApiError(404, "not found");
  }
  return { headRepoId: repo.repo.id, headBranch };
}

/** `maxForkTraverseLevel` (routers/common/compare.go:131) — the fork-graph
 *  descent cap. */
const MAX_FORK_TRAVERSE_LEVEL = 10;

/** The columns the `FindHeadRepo` walk steps through. */
interface ForkWalkRepo {
  id: string;
  ownerId: number | null;
  forkParent: string | null;
}

/** One fork-edge row by id (`GetBaseRepo`'s read, compare.go:138). */
async function forkWalkRow(d1: D1Database, repoId: string): Promise<ForkWalkRepo | null> {
  const row = await drizzle(d1)
    .select({ id: repositories.id, ownerId: repositories.ownerId, forkParent: repositories.forkParent })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1)
    .get();
  return row ?? null;
}

/** `GetRepositoriesByForkID` (models/repo/fork.go:16-21) — the first-level
 *  fork ids of one repo. */
async function firstLevelForkIds(d1: D1Database, repoId: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.forkParent, repoId))
    .all();
  return rows.map((row) => row.id);
}

/**
 * `findHeadRepoFromRootBase` (routers/common/compare.go:194-225): the head
 * user's direct fork of this repo (`GetUserFork` via findForkByOwner), else
 * the same question over every first-level fork's own subtree (the "base and
 * head are forks of the same root" arm, compare.go:69) with the depth cap.
 */
async function findHeadRepoFromRootBase(d1: D1Database, repoId: string, headUserId: number, level: number): Promise<string | null> {
  if (level === 0) return null;
  const direct = await findForkByOwner(d1, repoId, headUserId);
  if (direct !== null) return direct.id;
  for (const forkId of await firstLevelForkIds(d1, repoId)) {
    const found = await findHeadRepoFromRootBase(d1, forkId, headUserId, level - 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * `FindHeadRepo` (routers/common/compare.go:134-150): climb the fork_parent
 * chain — an ancestor owned by the head user IS the head repo (the loop
 * returns it, :146) — otherwise, when the chain tops out (the base is no
 * fork, or its parent row is gone), descend from the topmost reached repo
 * (:142). Returns the head repo's ID, null when no fork edge places the user.
 */
async function findHeadRepoByForkEdge(d1: D1Database, baseRepo: RepositoryWithOwner, headUserId: number): Promise<string | null> {
  let cur: ForkWalkRepo = {
    id: baseRepo.repo.id,
    ownerId: baseRepo.repo.ownerId,
    forkParent: baseRepo.repo.forkParent,
  };
  while (cur.ownerId !== headUserId) {
    if (cur.forkParent === null) {
      return findHeadRepoFromRootBase(d1, cur.id, headUserId, MAX_FORK_TRAVERSE_LEVEL);
    }
    const parent = await forkWalkRow(d1, cur.forkParent);
    if (parent === null) {
      return findHeadRepoFromRootBase(d1, cur.id, headUserId, MAX_FORK_TRAVERSE_LEVEL);
    }
    cur = parent;
  }
  return cur.id;
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
