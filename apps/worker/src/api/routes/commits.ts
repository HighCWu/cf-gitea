import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issues, pullRequests } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  branchRef,
  engineReads,
  isFullObjectId,
  refTipMap,
  resolveListStartRef,
  resolveNamedRef,
  tagRef,
  type EngineReads,
  type RefTip,
} from "../services/engine";
import { renderPatch, renderUnifiedDiff, toApiCommit, userRowsByEmail } from "../services/git-models";
import { resolveHeadRepo, toApiPullRequest } from "../services/pulls";
import { canViewRepositoryWithTeams, findRepositoryById, type RepositoryWithOwner } from "../services/repository";
import { compareSchema, commitListSchema, commitSchema } from "../models/git";
import { pullRequestSchema } from "../models/pull";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { requireVisibleRepo } from "../services/repo-access";
import { viewerOf } from "../services/repository";

/**
 * Tier-1 commit-family routes (SPEC-0004 §2.4 rows repoGetAllCommits /
 * repoGetSingleCommit / repoDownloadCommitDiffOrPatch / repoGetCommitPullRequest /
 * repoCompareDiff — 5 paths, 5 operations). All reads compose the engine's
 * public content RPCs (listLog / listCommitsRange / readDiff / readCommit);
 * `repoGetCommitPullRequest` is the D1 join on `pull_requests.head_sha`
 * (SPEC-0005 §3.2 — the denormalized refs/pull/N/head cache).
 *
 * Upstream behavior mirrored (routers/api/v1/repo/commits.go + compare.go):
 *   - GET /commits on an EMPTY repo → **409** with the APIError body
 *     (EmptyRepository — the §2.5 status semantics);
 *   - `stat`/`verification`/`files` default TRUE (the expensive enrichment);
 *     `path` filters the walk engine-side; `since`/`until` filter the commit
 *     date over a bounded window (COMMIT_WALK_BOUND — the engine walk RPC
 *     carries no date filter; documented approximation);
 *   - `git/commits/{sha}` accepts a ref, not only a sha (the param contract);
 *   - `compare/{basehead}`: the full ParseCompareRouterParam grammar
 *     (routers/common/compare.go:63-105) — `base...head` (three-dot,
 *     merge-base), `base..head` (two-dot), a separator-less head form
 *     against the default branch (pull.go:1109's IfZero), the
 *     `owner:branch` / `owner/name:branch` fork forms through the landed
 *     shared resolver (services/pulls.ts resolveHeadRepo), and per-side
 *     ^/~N revision suffixes (ResolveRefWithSuffix, compare.go:110-132);
 *     `output=diff|patch` answers raw text; the JSON commit list is served
 *     NEWEST-first (upstream's git-log order, compare.go) — the engine walk
 *     is oldest-first and the render reverses it; a null merge base
 *     (unrelated histories) answers EARLY EMPTY like compare.go:91-93.
 *
 * X-Total-Count approximation: the engine's listLog carries no total, so the
 * header counts the walked window (COMMIT_WALK_BOUND) — documented divergence
 * for repos deeper than the bound.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const COMMIT_WALK_BOUND = 500;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** The stat/files boolean query flags (default TRUE — ParseCommitOptions). */
function formBoolDefault(url: URL, key: string): boolean {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return true;
  return ["1", "t", "T", "true", "TRUE", "True", "on"].includes(raw);
}

function rfc3339(url: URL, key: string): Date | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The X-* header family (CommitList — see routes/pulls.ts setCommitListHeaders). */
function setCommitListHeaders(c: Context<ApiEnv>, opts: { page: number; limit: number }, countSoFar: number, hasMore: boolean): void {
  c.header("X-Total-Count", String(countSoFar));
  c.header("X-Page", String(opts.page));
  c.header("X-PerPage", String(opts.limit));
  c.header("X-PageCount", String(Math.max(Math.ceil(countSoFar / opts.limit), opts.page > 1 ? opts.page : 1)));
  c.header("X-HasMore", hasMore ? "true" : "false");
}

/** Resolve the {sha} param (a ref or a commit sha) to a commit. */
async function resolveCommit(c: Context<ApiEnv>, owner: string, repo: string, sha: string) {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const reads = engineReads(c.env, pair.repo);
  // STRICT ref resolution (no default-branch fallback): upstream getCommit
  // 404s an unresolvable identifier (commits.go:78-84), and the fallback
  // below would fabricate the default tip for /commits?sha=bogus.
  const resolved = resolveNamedRef(refTipMap(await reads.listRefs()), sha);
  const commit = resolved === null ? await reads.readCommit(sha) : await reads.readCommit(resolved.target);
  return { pair, reads, commit };
}

export function registerCommitRoutes(
  app: OpenAPIHono<ApiEnv>,
  _requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/commits/{sha}.{diffType}
  // (repoDownloadCommitDiffOrPatch) — the dot-suffix treatment of the pulls
  // route: doc-only registration + a plain pre-handler on the one-segment
  // git/commits path (hono's `:a.:b` segment does not bind params).
  // -------------------------------------------------------------------------
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/commits/{sha}.{diffType}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get the commit's diff",
      operationId: "repoDownloadCommitDiffOrPatch",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "a git ref or commit sha" }),
          diffType: z.string().min(1).openapi({ type: "string", enum: ["diff", "patch"], description: "type of diff" }),
        }),
      },
      responses: {
        200: { description: "string", content: { "text/plain": { schema: z.string() } } },
        404: notFoundResponse,
      },
    }),
  );

  const handleCommitDiff = async (c: Context<ApiEnv>, owner: string, repo: string, sha: string, diffType: string): Promise<Response> => {
    const { reads, commit } = await resolveCommit(c, owner, repo, sha);
    if (commit === null) {
      throw new ApiError(404, "not found");
    }
    const diff = await reads.readDiff(commit.oid);
    if (diff === null) {
      throw new ApiError(404, "not found");
    }
    // The commit download strips the format-patch signature (upstream's
    // RawDiffPatch arm runs `format-patch --no-signature`, diff.go:99 — the
    // PR/compare downloads keep git's default tail, patch.go:74).
    return c.text(diffType === "patch" ? renderPatch(commit, diff.files, { signature: null }) : renderUnifiedDiff(diff.files), 200);
  };

  app.get("/repos/:owner/:repo/git/commits/:segment", async (c, next) => {
    const match = /^(.{40})\.(diff|patch)$/.exec(c.req.param("segment") ?? "");
    if (match === null) {
      return next();
    }
    const { owner, repo } = c.req.param();
    return handleCommitDiff(c, owner, repo, match[1] as string, match[2] as string);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/commits (repoGetAllCommits) — the empty-repo
  // 409 EmptyRepository quirk included.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/commits",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a list of all commits from a repository",
      operationId: "repoGetAllCommits",
      request: {
        params: z.object(ownerRepoParams),
        query: z.object({
          sha: z.string().optional().openapi({ description: "SHA or branch to start listing commits from (usually it's going to be master)" }),
          path: z.string().optional().openapi({ description: "filepath of the file or directory to list commits for" }),
          since: z.string().optional().openapi({ format: "date-time", description: "if provided, only commits updated since the specified time are included" }),
          until: z.string().optional().openapi({ format: "date-time", description: "if provided, only commits updated until the specified time are included" }),
          stat: z.string().optional().openapi({ type: "boolean", description: "include diffstats (default true)" }),
          verification: z.string().optional().openapi({ type: "boolean", description: "include verification for every commit (default true)" }),
          files: z.string().optional().openapi({ type: "boolean", description: "include a list of affected files for every commit (default true)" }),
          not: z.string().optional().openapi({ description: "commits excluding those reachable from the given ref (not modeled)" }),
          page: pageLimitQuery.page,
          limit: pageLimitQuery.limit,
        }),
      },
      responses: {
        200: { description: "CommitList", content: { "application/json": { schema: commitListSchema } } },
        404: notFoundResponse,
        409: errorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      if (pair.repo.isEmpty) {
        throw new ApiError(409, "Git Repository is empty.");
      }
      const listOptions = parseListOptions(new URL(c.req.url));
      const url = new URL(c.req.url);
      const path = url.searchParams.get("path") ?? undefined;
      const since = rfc3339(url, "since");
      const until = rfc3339(url, "until");
      const statFlag = formBoolDefault(url, "stat");
      const filesFlag = formBoolDefault(url, "files");

      const reads = engineReads(c.env, pair.repo);
      const shaParam = url.searchParams.get("sha") ?? "";
      // Upstream GetAllCommits: a non-empty sha that GetCommit cannot resolve
      // is the APIErrorAuto 404 (commits.go:211-216) — never the default
      // branch's tip. The absent-sha arm (start = undefined) is the only
      // default-branch walk. The resolver is the existence-probed variant:
      // the sync oid arm passes 40-hex through on FORMAT alone, so an
      // unknown oid used to reach the walk and answer 200 [] (the review's
      // unknown-40-hex residual).
      const startRef = await resolveListStartRef(reads, shaParam);
      if (startRef === null && shaParam !== "") {
        throw new ApiError(404, "not found");
      }
      const start = shaParam === "" ? undefined : startRef?.target;

      let commits: import("@cf-gitea/git-engine").CommitJson[];
      let hasMore: boolean;
      if (since !== null || until !== null) {
        // bounded full walk, filtered by committer date (git log --since/--until)
        const walked = await reads.listLog(start, { path, ofs: 0, n: COMMIT_WALK_BOUND });
        const all = walked?.commits ?? [];
        const filtered = all.filter((commit) => {
          const time = commit.committer.time * 1000;
          return (since === null || time >= since.getTime()) && (until === null || time <= until.getTime());
        });
        hasMore = false;
        setCommitListHeaders(c, listOptions, filtered.length, false);
        const start2 = (listOptions.page - 1) * listOptions.limit;
        commits = filtered.slice(start2, start2 + listOptions.limit);
      } else {
        const walked = await reads.listLog(start, { path, ofs: (listOptions.page - 1) * listOptions.limit, n: listOptions.limit + 1 });
        const all = walked?.commits ?? [];
        hasMore = all.length > listOptions.limit;
        commits = all.slice(0, listOptions.limit);
        setCommitListHeaders(c, listOptions, (listOptions.page - 1) * listOptions.limit + commits.length, hasMore);
      }
      // the walked window is the total approximation (module doc); the +1
      // keeps a next Link relation when the walk reports more
      setPaginationHeaders(c, (listOptions.page - 1) * listOptions.limit + commits.length + (hasMore ? 1 : 0), listOptions);

      // One batched author/committer row read for the page (userRowsByEmail
      // — the audit A4 fix; the per-commit findUserRowByEmail pair and the
      // dead usernames select are gone — `undefined` slots the retired
      // usernames param kept for the un-batched sibling callers).
      const userRows = await userRowsByEmail(c.env.DB, commits);
      const rendered = await Promise.all(
        commits.map((commit) =>
          toApiCommit(c.env.DB, reads, viewerOf(c), pair, commit, undefined, { stat: statFlag, files: filesFlag, userRows }),
        ),
      );
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/commits/{sha} (repoGetSingleCommit)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/commits/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a single commit",
      operationId: "repoGetSingleCommit",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "a git ref or commit sha" }),
        }),
        query: z.object({
          stat: z.string().optional().openapi({ type: "boolean", description: "include diffstats (default true)" }),
          verification: z.string().optional().openapi({ type: "boolean", description: "include verification for every commit (default true)" }),
          files: z.string().optional().openapi({ type: "boolean", description: "include a list of affected files for every commit (default true)" }),
        }),
      },
      responses: {
        200: { description: "Commit", content: { "application/json": { schema: commitSchema } } },
        404: notFoundResponse,
        422: errorResponse,
      },
    }),
    async (c) => {
      const { owner, repo, sha } = c.req.valid("param");
      const { pair, reads, commit } = await resolveCommit(c, owner, repo, sha);
      if (commit === null) {
        throw new ApiError(404, "not found");
      }
      const url = new URL(c.req.url);
      const userRows = await userRowsByEmail(c.env.DB, [commit]);
      return c.json(
        await toApiCommit(c.env.DB, reads, viewerOf(c), pair, commit, undefined, {
          stat: formBoolDefault(url, "stat"),
          files: formBoolDefault(url, "files"),
          userRows,
        }),
        200,
      );
    },
  );


  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/commits/{sha}/pull (repoGetCommitPullRequest)
  // — the D1 join on the head_sha cache (SPEC-0005 §3.2).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/commits/{sha}/pull",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get matching pull requests for commit",
      operationId: "repoGetCommitPullRequest",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "SHA of the commit to get" }),
        }),
      },
      responses: {
        200: { description: "PullRequest", content: { "application/json": { schema: pullRequestSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, sha } = c.req.valid("param");
      const { pair, commit } = await resolveCommit(c, owner, repo, sha);
      if (commit === null) {
        throw new ApiError(404, "not found");
      }
      const row = await drizzle(c.env.DB)
        .select({ issue: issues, pullRequest: pullRequests })
        .from(pullRequests)
        .innerJoin(issues, eq(issues.id, pullRequests.issueId))
        .where(and(eq(pullRequests.baseRepoId, pair.repo.id), eq(pullRequests.headSha, commit.oid)))
        .limit(1)
        .then((rows) => rows[0]);
      if (row === undefined) {
        throw new ApiError(404, "not found");
      }
      return c.json(await toApiPullRequest(c.env.DB, viewerOf(c), pair, row.issue, row.pullRequest, "single"), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/compare/{basehead} (repoCompareDiff) —
  // `base...head` / `base..head`; output=diff|patch answers raw text.
  //
  // Upstream registers the chi WILDCARD `/compare/*` (api.go:1240), so the
  // tail matches SLASHED ref names — the swagger's own "including branch
  // names that contain slashes". Hono's single-segment `{basehead}` cannot,
  // so the doc stays doc-only (the git/commits dot-suffix idiom) and TWO
  // plain arms share the handler: the single-segment param route (wins the
  // shared prefix — the branch_protections probe) and a catch-all twin for
  // the multi-segment tails (the contents raw/media pair).
  //
  // The tail grammar is ParseCompareRouterParam (routers/common/compare.go:
  // 63-105), ported below — the three 063db9b divergences RECONCILED here:
  //   - a separator-less tail is a HEAD form (compare.go:78-86): the base
  //     falls to the PR target branch (pull.go:1109's IfZero over
  //     GetPullRequestTargetBranch — pull_request_default.go:13-16; no
  //     PR-unit config table exists here, so repo.default_branch) and an
  //     empty head side falls to the head repo's default branch
  //     (pull.go:1114's IfZero);
  //   - the head side carries the fork grammar (`owner:branch` bare form —
  //     the fork edge; `owner/name:branch` explicit) through the LANDED
  //     shared resolver (services/pulls.ts resolveHeadRepo — the PR twin's
  //     FindHeadRepo port); the resolver's recorded deviations (the flat
  //     anti-enumeration 404s) are the compare route's too;
  //   - each side's ref carries an optional ^/~N revision suffix
  //     (ResolveRefWithSuffix, compare.go:110-132): a valid suffix walks
  //     the parsed commit's parents (upstream runs
  //     GetCommit(oriRef+suffix) — git rev-parse ancestry), an unsupported
  //     suffix shape is the 400 (`unsupported ref suffix %q`), an
  //     unresolvable one the 404 (`ref %q does not exist`).
  // Cross-repo heads resolve refs and read the head commit against the
  // HEAD cell (upstream opens headGitRepo, pull.go:1078-1089); the
  // merge-base/range pipeline stays on the base engine — head objects the
  // base cell lacks (a fork with divergent history) collapse into the
  // documented null merge-base EARLY EMPTY (compare.go:91-93), where
  // upstream fetches the head tip (FetchRemoteTempCommit) — recorded
  // limitation, not a status divergence.
  // -------------------------------------------------------------------------
  const handleCompare = async (c: Context<ApiEnv>, owner: string, repo: string, basehead: string): Promise<Response> => {
    const pair = await requireVisibleRepo(c, { owner, repo });
    const url = new URL(c.req.url);
    const req = parseCompareRouterParam(basehead);

    // GetHeadOwnerAndRepo (compare.go:152-192) through the landed shared
    // resolver: the plain form is a branch here, the bare `owner:branch`
    // form searches the fork edge, `owner/name:branch` is the direct path
    // lookup (compare.go:181-189).
    const head = await resolveHeadRepo(c.env.DB, pair, req.headParam);
    const headPair = head.headRepoId === pair.repo.id ? pair : await requireReadableHeadRepo(c, head.headRepoId);

    const reads = engineReads(c.env, pair.repo);
    const tips = refTipMap(await reads.listRefs());
    const headReads = headPair.repo.id === pair.repo.id ? reads : engineReads(c.env, headPair.repo);
    const headTips = headPair.repo.id === pair.repo.id ? tips : refTipMap(await headReads.listRefs());

    // The IfZero arms (pull.go:1109/1114): an empty side falls to the PR
    // target branch — repo.default_branch here, no PR-unit config table —
    // and to the resolved HEAD repo's default branch. The head's ref
    // suffix splits AFTER the repo grammar (upstream parses the suffix
    // after parseHead, compare.go:103-104).
    const headRef = parseRefSuffix(head.headBranch);
    const baseOriRef = req.baseOriRef === "" ? pair.repo.defaultBranch : req.baseOriRef;
    const headOriRef = headRef.refName === "" ? headPair.repo.defaultBranch : headRef.refName;

    const baseTarget = await resolveSideWithSuffix(reads, tips, baseOriRef, req.baseOriRefSuffix);
    const headTarget = await resolveSideWithSuffix(headReads, headTips, headOriRef, headRef.refSuffix);
    const baseCommit = await reads.readCommit(baseTarget);
    const headCommit = await headReads.readCommit(headTarget);
    if (baseCommit === null || headCommit === null) {
      throw new ApiError(404, "not found");
    }
    // three-dot diffs/commits from the merge base; two-dot from base itself.
    // Upstream GetCompareInfo returns EARLY EMPTY on a null merge base
    // (unrelated histories — compare.go:91-93 `CompareBase == ""` return):
    // zero commits and an empty raw diff/patch (git's `base...head` has no
    // merge-base side). The PR twin already honors this (pull-engine.ts
    // pullRequestDiff). The engine's budget-exhausted merge-base walk also
    // reports base=null — the same EMPTY shape, our documented exhaustion
    // posture (SPEC-0001b §6).
    let rangeStart: string | null = baseCommit.oid;
    if (req.separator === "...") {
      const base = await reads.mergeBase(baseCommit.oid, headCommit.oid);
      rangeStart = base !== null && base.tag === "ok" ? base.base : null;
    }
    if (rangeStart === null) {
      const output = url.searchParams.get("output") ?? "";
      if (output === "diff") {
        return c.text("", 200);
      }
      if (output === "patch") {
        // The route's landed empty-range patch shape (the header-only mail,
        // the /pulls/{index}.patch twin) — upstream's format-patch prints
        // nothing; kept for render consistency, documented divergence.
        return c.text(renderPatch(headCommit, []), 200);
      }
      return c.json({ total_commits: 0, commits: [] }, 200);
    }

    const output = url.searchParams.get("output") ?? "";
    if (output === "diff" || output === "patch") {
      const diff = await reads.readDiff(headCommit.oid, rangeStart);
      const files = diff?.files ?? [];
      if (output === "patch") {
        const headJson = headCommit;
        return c.text(renderPatch(headJson, files), 200);
      }
      return c.text(renderUnifiedDiff(files), 200);
    }

    const walked = (await reads.listCommitsRange(rangeStart, headCommit.oid, COMPARE_COMMIT_BOUND)) ?? { commits: [], more: false };
    const statFlag = formBoolDefault(url, "stat");
    const filesFlag = formBoolDefault(url, "files");
    const userRows = await userRowsByEmail(c.env.DB, walked.commits);
    // Upstream serves the compare commit list in git-log order (newest
    // first — compare.go's ShowPrettyFormatLogToList); the engine's
    // listCommitsRange is oldest-first (SPEC-0001b §4.1), so the render
    // reverses the walk (the push-payload precedent, webhooks-push.ts).
    const newestFirst = [...walked.commits].reverse();
    const rendered = await Promise.all(
      newestFirst.map((commit) =>
        toApiCommit(c.env.DB, reads, viewerOf(c), pair, commit, undefined, { stat: statFlag, files: filesFlag, userRows }),
      ),
    );
    return c.json({ total_commits: walked.commits.length, commits: rendered }, 200);
  };

  // Doc-only registration (the git/commits dot-suffix idiom — a zod-openapi
  // typed handler cannot share the Promise<Response> helper with the plain
  // arms); the two wire arms below serve the path.
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/compare/{basehead}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get compare of two commits or branches",
      operationId: "repoCompareDiff",
      request: {
        params: z.object({
          ...ownerRepoParams,
          basehead: z.string().min(1).openapi({ description: "the base and head, formatted as base...head (three-dot) or base..head (two-dot); a separator-less value is the head against the default branch; the head may name a fork as owner or owner/repo; refs may be branch names that contain slashes and carry a ^/~N revision suffix" }),
        }),
        query: z.object({
          output: z.string().optional().openapi({ type: "string", enum: ["diff", "patch", ""], description: "output format; diff or patch answers raw text" }),
          verification: z.string().optional().openapi({ type: "boolean", description: "include verification for every commit (default true)" }),
          files: z.string().optional().openapi({ type: "boolean", description: "include a list of affected files for every commit (default true)" }),
        }),
      },
      responses: {
        200: { description: "Compare", content: { "application/json": { schema: compareSchema }, "text/plain": { schema: z.string() } } },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
  );

  // The single-segment arm (kept first: the param route wins the shared
  // prefix — the branch_protections probe) and the slashed-tail twin that
  // answers everything it cannot bind (multi-segment baseheads) — the
  // contents raw/media pair, both on the SAME handler.
  app.get("/repos/:owner/:repo/compare/:basehead", optionalAuth, (c) => {
    const { owner, repo, basehead } = c.req.param();
    return handleCompare(c, owner, repo, basehead);
  });

  app.get("/repos/:owner/:repo/compare/*", optionalAuth, async (c, next) => {
    // chi's wildcard claims "/compare/…" INCLUDING the empty tail
    // ("/compare/"), but the bare "/compare" has no static leaf in the
    // upstream tree — it falls to the mux's native 404 there.
    if (c.req.path.endsWith("/compare")) {
      return next();
    }
    const { owner, repo } = c.req.param();
    return handleCompare(c, owner, repo, tailAfter(c, `/${owner}/${repo}/compare/`));
  });
}

/** The repo-relative tail of a plain catchall path (the contents.ts raw/media
 *  idiom — owner/repo may carry case; the tail decodes %-escapes). */
function tailAfter(c: Context<ApiEnv>, prefix: string): string {
  const index = c.req.path.indexOf(prefix);
  return decodeURIComponent(index < 0 ? "" : c.req.path.slice(index + prefix.length));
}

/** git.ParseRefSuffix (modules/git/ref.go:246-258): the EARLIEST of
 *  "@{", "^", "~" splits the revision suffix off — so a combined suffix
 *  like "main~2^" stays intact; no mark → no suffix. */
function parseRefSuffix(ref: string): { refName: string; refSuffix: string } {
  let suffixIdx = -1;
  for (const mark of ["@{", "^", "~"]) {
    const idx = ref.indexOf(mark);
    if (idx !== -1 && (suffixIdx === -1 || idx < suffixIdx)) suffixIdx = idx;
  }
  return suffixIdx === -1
    ? { refName: ref, refSuffix: "" }
    : { refName: ref.slice(0, suffixIdx), refSuffix: ref.slice(suffixIdx) };
}

/** `validRefSuffix` (routers/common/compare.go:136-137): only ^/~ ancestry
 *  navigation — the ^{...}, @{...} and :path forms address other objects
 *  (trees, blobs) or reflog state that compare does not resolve, so they
 *  are rejected (the 400 unsupported-suffix arm). */
const VALID_REF_SUFFIX = /^(?:[~^][0-9]*)+$/;

/** ParseCompareRouterParam (routers/common/compare.go:63-105): try "..."
 *  (three-dot, merge-base), then ".." (two-dot, direct); a separator-less
 *  tail is a HEAD form — the base stays empty and falls to the repo's
 *  default branch at the IfZero arms (pull.go:1109), exactly the
 *  `compare/{head}` route shapes 4/5/6. The base part carries its own ref
 *  suffix (compare.go:101); the head part keeps the raw
 *  `owner[:repo]:ref` grammar for resolveHeadRepo, whose branch then takes
 *  the suffix split (upstream parses the suffix AFTER parseHead,
 *  compare.go:103-104). */
function parseCompareRouterParam(routerParam: string): {
  baseOriRef: string;
  baseOriRefSuffix: string;
  separator: "..." | "..";
  headParam: string;
} {
  if (routerParam === "") {
    // The chi wildcard's empty tail (upstream `CompareRouterReq{}`): both
    // sides fall to their default branches at the IfZero arms.
    return { baseOriRef: "", baseOriRefSuffix: "", separator: "...", headParam: "" };
  }
  const triple = routerParam.indexOf("...");
  if (triple !== -1) {
    const base = parseRefSuffix(routerParam.slice(0, triple));
    return {
      baseOriRef: base.refName,
      baseOriRefSuffix: base.refSuffix,
      separator: "...",
      headParam: routerParam.slice(triple + 3),
    };
  }
  const double = routerParam.indexOf("..");
  if (double !== -1) {
    const base = parseRefSuffix(routerParam.slice(0, double));
    return {
      baseOriRef: base.refName,
      baseOriRefSuffix: base.refSuffix,
      separator: "..",
      headParam: routerParam.slice(double + 2),
    };
  }
  return { baseOriRef: "", baseOriRefSuffix: "", separator: "...", headParam: routerParam };
}

/**
 * ResolveRefWithSuffix (routers/common/compare.go:110-132) over one repo's
 * tips. Suffix-less, the landed guess ladder: branch → tag → raw ref →
 * format-valid oid (UnstableGuessRefByShortName's reduction). With a valid
 * ^/~N suffix, the ref resolves the same way and the suffix walks the
 * commit ancestry (`~N` N first-parent generations, `^N` the N-th parent
 * with 0 = the commit itself, bare marks = 1 — git rev-parse semantics;
 * upstream runs GetCommit(oriRef+suffix) in one git step, ours steps the
 * parsed commit's parents). An unsupported suffix shape throws the 400
 * (`unsupported ref suffix %q`), an unresolvable ref the 404 (`ref %q does
 * not exist`) — the two APIErrorAuto arms; the walk 404s at the first
 * missing parent, so an oversized `~N` costs no more reads than the
 * history is deep.
 */
async function resolveSideWithSuffix(
  reads: EngineReads,
  tips: Map<string, RefTip>,
  oriRef: string,
  refSuffix: string,
): Promise<string> {
  const guess = (): string | null => {
    const direct = tips.get(branchRef(oriRef)) ?? tips.get(tagRef(oriRef)) ?? tips.get(oriRef);
    if (direct !== undefined) return direct.target;
    return isFullObjectId(oriRef) ? oriRef : null;
  };
  if (refSuffix === "") {
    const resolved = guess();
    if (resolved === null) {
      throw new ApiError(404, `ref "${oriRef}" does not exist`);
    }
    return resolved;
  }
  if (!VALID_REF_SUFFIX.test(refSuffix)) {
    throw new ApiError(400, `unsupported ref suffix "${refSuffix}"`);
  }
  let oid = guess();
  if (oid === null) {
    throw new ApiError(404, `ref "${oriRef}${refSuffix}" does not exist`);
  }
  for (const token of refSuffix.match(/[~^][0-9]*/g) ?? []) {
    const count = token.slice(1) === "" ? 1 : Number.parseInt(token.slice(1), 10);
    if (token[0] === "^") {
      if (count === 0) continue; // `^0` IS the commit itself (git rev-parse)
      const commit = await reads.readCommit(oid);
      const parent = commit === null ? undefined : commit.parents[count - 1];
      if (parent === undefined) {
        throw new ApiError(404, `ref "${oriRef}${refSuffix}" does not exist`);
      }
      oid = parent;
      continue;
    }
    for (let step = 0; step < count; step += 1) {
      const commit = await reads.readCommit(oid);
      const parent = commit === null ? undefined : commit.parents[0];
      if (parent === undefined) {
        throw new ApiError(404, `ref "${oriRef}${refSuffix}" does not exist`);
      }
      oid = parent;
    }
  }
  return oid;
}

/** parseCompareInfo's head-repo READ gate (routers/api/v1/repo/pull.go:
 * 1063-1074): `GetDoerRepoPermission(...).CanRead(unit.TypeCode)` — a head
 * repo the viewer cannot read answers APIErrorNotFound, the same
 * anti-enumeration 404 as an absent row (both collapse here). The landed
 * team-aware visibility predicate is the CanRead port (the routes/pulls.ts
 * local-copy shape). */
async function requireReadableHeadRepo(c: Context<ApiEnv>, headRepoId: string): Promise<RepositoryWithOwner> {
  const headPair = await findRepositoryById(c.env.DB, headRepoId);
  if (headPair === null || !(await canViewRepositoryWithTeams(c.env.DB, viewerOf(c), headPair.repo))) {
    throw new ApiError(404, "not found");
  }
  return headPair;
}

/** Compare renders at most this many commits (upstream's own page cap). */
const COMPARE_COMMIT_BOUND = 250;


