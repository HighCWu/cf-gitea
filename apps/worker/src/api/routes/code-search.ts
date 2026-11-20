import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { branchRef, engineReads, refTipMap, resolveNamedRef } from "../services/engine";
import {
  buildResultFragments,
  CODE_SEARCH_RESULT_WINDOW,
  FileMatcher,
  paginateHits,
  parseCodeSearchQuery,
  scanRepoCode,
  toWireIndices,
  type CodeSearchHit,
} from "../services/code-search";
import { apiRepositoryUrl, toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import { pathEscapeSegments } from "../services/releases";
import { requireVisibleRepo } from "../services/repo-access";
import { refMissError } from "./contents";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  codeSearchResultsSchema,
  codeSearchResultItemSchema,
  codeSearchTextMatchTermSchema,
} from "../models/code-search";

/**
 * The 38389f00be code-search API pair at the 099abf5db4 pin:
 *
 *   GET /repos/{owner}/{repo}/code/search — repoSearchCode
 *   (routers/api/v1/repo/code_search.go:78, api.go:1331 — mounted inside the
 *   repo-scoped group with `reqRepoReader(unit.TypeCode)` +
 *   `context.ReferencesGitRepo(true)`; the scope-gate's `/^\/repos/`
 *   repository row already covers the family)
 *
 *   GET /search/code — codeSearch
 *   (code_search.go:131, api.go:1897 — `tokenRequiresScopes(repository)`,
 *   reqToken(), reqCodeSearchEnabled() at the sudo-group tail)
 *
 * The repo-scoped arm is REAL-READ on purpose: upstream's git-grep engine
 * needs no code indexer (it walks the git data live — the 38389f00be commit
 * message says exactly that), and the port of that engine over plain
 * tree/blob reads lives in services/code-search.ts (the query grammar, the
 * FileMatcher, IsSearchable/vendored rules, the fragment builder, the
 * 50-file cap and the scan budgets, each with its recorded divergence).
 *
 * The global arm is the UN-WARMED INDEXER POSTURE, faithfully:
 * `reqCodeSearchEnabled` (api.go:337-341) answers `ctx.APIErrorNotFound()`
 * unless the code indexer is enabled — `setting.Indexer.RepoIndexerEnabled`
 * is permanently false on this instance (no code indexer exists), so the
 * route 404s exactly as upstream does with the indexer disabled. The arm
 * ordering is upstream's: reqToken's anonymous 401 fires BEFORE the feature
 * 404, and the tokenRequiresScopes(repository) 403 sits before both — that
 * scope-gate row (`/^\/search\/code/`, api.go:1897) is the scope-gate
 * owner's HANDOFF (scope-gate.ts is another unit's file); until it lands a
 * wrongly-scoped token answers the 404 instead of upstream's 403.
 *
 * Error mapping (code_search.go:24-32): a SearchQueryError renders 422 with
 * its message; every other engine failure is APIErrorInternal (500, the
 * message hidden in prod — the ApiError render is {message, url} either way).
 * The indexer arm's 503 (ErrIndexerUnavailable) is unreachable behind the
 * feature gate.
 */

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

const unauthorizedResponse = {
  description: "unauthorized",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const pageQuery = {
  // String-declared so a non-numeric ?page never validation-400s — upstream's
  // FormInt treats garbage as 0 and the clamp absorbs it (branches.ts's
  // pageLimitQuery convention; the numeric parse is parseListOptions').
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** The ToCodeSearchResultItem render (services/convert/code_search.go) for
 *  one hit. `language` is upstream-omitempty and the git-grep engine never
 *  sets it — the key is absent, not empty. The repository object is the full
 *  convert.ToRepo render (respondCodeSearch:59-61). */
function toCodeSearchResultItem(c: Context<ApiEnv>, pair: RepositoryWithOwner, hit: CodeSearchHit) {
  const viewer = viewerOf(c);
  const contentsUrl = `${apiRepositoryUrl(pair, viewer.origin)}/contents/${pathEscapeSegments(hit.path)}?ref=${encodeURIComponent(hit.commitId)}`;
  const item = {
    name: hit.path.slice(hit.path.lastIndexOf("/") + 1),
    path: hit.path,
    url: contentsUrl,
    html_url: `${viewer.origin}/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}/src/commit/${hit.commitId}/${pathEscapeSegments(hit.path)}`,
    repository: toApiRepository(viewer, pair),
    text_matches: buildResultFragments(hit.content, hit.matches).map((fragment) => ({
      object_url: contentsUrl,
      object_type: "FileContent",
      property: "content",
      fragment: fragment.content,
      matches: fragment.matches.map((range) => {
        const text = fragment.content.slice(range.start, range.end);
        const indices = toWireIndices(fragment.content, range);
        return { text, indices } satisfies z.infer<typeof codeSearchTextMatchTermSchema>;
      }),
    })),
  };
  return item satisfies z.infer<typeof codeSearchResultItemSchema>;
}

/** The respondCodeSearch envelope for a repo-scoped scan — the window guard
 *  (422 "page * limit must not exceed 1000"), the page slice, the headers and
 *  the 200 body (code_search.go:34-76). Upstream clamps the LINK header's
 *  total to the window (`min(result.Total, window/limit*limit)`) while
 *  X-Total-Count carries the raw total; both are the raw total here because
 *  the git-grep total never exceeds the 50-file cap. */
async function respondRepoCodeSearch(c: Context<ApiEnv>, owner: string, repo: string, refParam: string | null) {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const reads = engineReads(c.env, pair.repo);

  // SearchRepoCode's ref arm (code_search.go:120-127): the trimmed ref, the
  // default branch for the ABSENT/empty param (util.IfZero inside
  // resolveRefCommit), resolution SKIPPED only for an empty repo with no ref
  // (an empty repo with an explicit ref still resolves — and 404s — exactly
  // like upstream). The scan target is the resolved COMMIT (upstream pins
  // opts.Ref = RefNameFromCommit(CommitID) — annotated tags peel).
  const refTrim = (refParam ?? "").trim();
  let scanTarget: string | null = null;
  if (!pair.repo.isEmpty || refTrim !== "") {
    const tips = refTipMap(await reads.listRefs());
    const resolved = refTrim === "" ? tips.get(branchRef(pair.repo.defaultBranch)) : resolveNamedRef(tips, refTrim);
    if (resolved === undefined || resolved === null) {
      throw refMissError(pair.repo.defaultBranch, refTrim);
    }
    scanTarget = resolved.peeled ?? resolved.target;
  }

  // The window guard runs BEFORE the query parse (respondCodeSearch:35-39 —
  // GetListOptions, then the 1000-window check, then Search).
  const listOptions = parseListOptions(new URL(c.req.url));
  if (listOptions.page > Math.floor(CODE_SEARCH_RESULT_WINDOW / listOptions.limit)) {
    throw new ApiError(422, "page * limit must not exceed 1000");
  }

  // ctx.FormTrim("q") — absent q parses as empty and answers the
  // "Query must contain a search term" 422, never a 400 (Go drops nothing:
  // the param is read from the form, empty is empty).
  const q = c.req.query("q") ?? "";
  const query = parseCodeSearchQuery(q.trim());

  // codesearch.Search's engine rejections (services/codesearch/codesearch.go:
  // 60-67) in upstream order; the indexer-regexp arm is Indexer-only.
  if (query.language !== "") {
    throw new ApiError(422, "Language qualifiers are not supported by git grep");
  }
  if (query.repos.length + query.owners.length > 0) {
    throw new ApiError(422, "Repository and owner qualifiers are only supported in global code search");
  }

  // The skipped resolution (empty repo, no ref) is upstream's PerformSearch
  // IsEmpty arm: GetCommit fails, IsEmpty() true → zero results, no error
  // (code_search.go's engine arm) — the 200 empty envelope.
  const scan =
    scanTarget === null
      ? { hits: [], total: 0, incomplete: false }
      : await scanRepoCode(reads, scanTarget, query, new FileMatcher(query.terms));
  const page = paginateHits(scan.hits, listOptions.page, listOptions.limit);
  const items = page.map((hit) => toCodeSearchResultItem(c, pair, hit));
  setPaginationHeaders(c, scan.total, listOptions);
  return c.json(
    {
      total_count: scan.total,
      incomplete_results: scan.incomplete,
      items,
    } satisfies z.infer<typeof codeSearchResultsSchema>,
    200,
  );
}

export function registerCodeSearchRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>, optionalAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/code/search (repoSearchCode) — the git-grep
  // real-read. Reads ride optionalAuth: upstream carries no reqToken here
  // (api.go:1331), and the Code-unit reader gate (reqRepoReader(TypeCode))
  // is vacuous at this pin — every repo carries a seeded code unit row and
  // the visibility predicate IS the code-unit read (services/
  // issue-unit-gates.ts's recorded reduction), so requireVisibleRepo's 404 is
  // the whole gate ladder.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/code/search",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Search the code of a repository",
      description:
        "The files of the ref are searched with git grep, which returns at most 50 files. The result window is limited to 1000 files (page * limit).",
      operationId: "repoSearchCode",
      request: {
        params: z.object(ownerRepoParams),
        // `q` is contract-required but Go reads it as an empty string when
        // absent — the parser's "Query must contain a search term" 422 is the
        // absent-param answer, never a validation 400.
        query: z.object({
          q: z.string().optional().openapi({
            description:
              'Terms must all occur in a file. Supports "exact phrases", /regexp/ and path:DIR. Language and repository qualifiers are not supported.',
          }),
          ref: z.string().optional().openapi({
            description: "The name of the commit/branch/tag. Default to the repository’s default branch",
          }),
          ...pageQuery,
        }),
      },
      responses: {
        200: { description: "CodeSearchResults", content: { "application/json": { schema: codeSearchResultsSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      return respondRepoCodeSearch(c, owner, repo, c.req.valid("query").ref ?? null);
    },
  );

  // -------------------------------------------------------------------------
  // GET /search/code (codeSearch) — the global indexer arm, at the un-warmed
  // posture: reqToken's 401 first (requireAuth), then the feature gate's 404
  // (no code indexer on this instance — api.go:337-341's first clause). The
  // declared 200 (CodeSearchResults) is the contract shape upstream serves
  // with an enabled indexer; it is unreachable here by design, not ignored.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/search/code",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Search the code of all repositories",
      description:
        "Authentication is required. The default branches are searched with the code indexer. Regular expressions are not supported. The result window is limited to 1000 files (page * limit).",
      operationId: "codeSearch",
      request: {
        query: z.object({
          q: z.string().optional().openapi({
            description:
              'Literal terms and "exact phrases" must all occur in a file, with optional qualifiers:\n"repo:OWNER/NAME", "user:NAME" and "org:NAME" to only search these repositories (each can be repeated),\n"path:DIR" to only search the files in a directory, "language:NAME" to only search the files of a language',
          }),
          ...pageQuery,
        }),
      },
      responses: {
        200: { description: "CodeSearchResults", content: { "application/json": { schema: codeSearchResultsSchema } } },
        401: unauthorizedResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    (c) => {
      // reqCodeSearchEnabled (api.go:337-341): !RepoIndexerEnabled → the
      // APIErrorNotFound 404, our permanent posture. The handler body's
      // parameters (q/page/limit) are consumed by nothing — upstream never
      // reaches Search with the indexer disabled.
      void c.req.valid("query");
      throw new ApiError(404, "not found");
    },
  );
}
