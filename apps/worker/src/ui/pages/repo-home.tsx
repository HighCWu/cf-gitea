/**
 * The code-tree URL family, `/{owner}/{repo}/tree/{...}` (pages wave 2).
 *
 * ## What this module owns — and what it deliberately does not
 *
 * At the pinned upstream (`gitea/routers/web/web.go:1756`,
 * `routers/web/repo/view_home.go:511-526`) there is NO tree listing page:
 * `/owner/repo/tree/*` is answered by `RedirectRepoTreeToSrc`, a verbatim
 * prefix swap onto `/src/*` ("so that Gitea's repo URL structure matches
 * other forges (GitHub/GitLab) provide, allowing us to construct submodule
 * URLs across forges easily" — the module comment upstream). The directory
 * LISTING and README rendering of the repo home therefore live with the
 * landed slice-1 pages, which already implement the full §2.4.1 DOM contract
 * for the code-tree surface:
 *
 * - `/{owner}/{repo}` (pages/home.tsx): repo header + branch selector +
 *   `#repo-files-table` root listing WITH the §3.5 per-entry commit subjects
 *   (the §6.1 ⚠ degradation — rows without subjects — is NOT needed; the
 *   landed `enrichTreeCommits` fallback resolves them) + the README through
 *   the §3.4 markdown pipeline (the §6.1 relative-links ⚠: degraded links
 *   accepted v1 — the pipeline rewrites what it can and never breaks the
 *   page, `page-data.renderRepoMarkdown` catches its own failures);
 * - `/{owner}/{repo}/src/{branch|tag|commit}/{ref}/{path}` (pages/
 *   file-view.tsx): the tree browser for sub-directories and the blob views.
 *
 * The wave-2 gap was ROUTING, not rendering: `/tree/*` previously fell
 * through `handlesUiRoute` to the repo-scoped engine dispatch, which answers
 * a bare engine 404 — exactly the failure §4.5 forbids for UI-shaped URL
 * families. This module claims the family with upstream's semantics:
 *
 * - `Location: {repoLink}/src/{RAW suffix}` — the still-encoded suffix is
 *   re-emitted verbatim (`ctx.PathParamRaw("*")` parity), so the target
 *   parser re-decodes it with the landed `/src` rules and every existing
 *   ref/path behavior (404 shells included) is inherited, not duplicated;
 * - the query string is preserved (`view_home.go:522-524`);
 * - status 303 See Other (upstream `Base.Redirect`,
 *   `services/context/base.go:157` — `http.StatusSeeOther` default);
 * - the redirect happens only AFTER the repository resolves (upstream's
 *   RepoAssignment ordering): unknown/private repos 404-shell first (§2.5);
 * - the bare `/{owner}/{repo}/tree` has no upstream route (chi's `/tree/*`
 *   needs the slash) → the §4.5 404 shell, like upstream's not-found.
 */

/** Build the redirect target for one `/tree` request (pure — testable): the
 *  repo link, the RAW (still-encoded) suffix swapped onto `/src/`, and the
 *  request's query preserved verbatim (`url.search`, "" or "?…"). */
export function treeRedirectTarget(repoLink: string, rawSuffix: string, search: string): string {
  return `${repoLink}/src/${rawSuffix}${search}`;
}

/** The wave-41 fetch-action arm of ctx.Redirect — upstream
 *  `IsGiteaFetchActionRequest` (modules/httplib/server_request.go:246-248):
 *  a non-empty `X-Gitea-Fetch-Action` header. The official bundle's
 *  fetch-action module tags its own form/fetch submissions so a REDIRECT
 *  answer can travel as JSON the JS follows itself ("otherwise, the JS fetch
 *  will follow the redirection and read a login page, embed it to the
 *  current page, which is not expected" — base.go:154-156's comment). */
export function isFetchActionRequest(request: Request): boolean {
  return (request.headers.get("x-gitea-fetch-action") ?? "") !== "";
}

/** The fetch-action answer of ctx.Redirect (services/context/base.go:153-156):
 *  200 `{"redirect": …}` through ctx.JSON's
 *  `application/json;charset=utf-8` (base.go:115-122). */
export function fetchActionRedirectResponse(location: string): Response {
  return new Response(JSON.stringify({ redirect: location }), {
    status: 200,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

/** The 303 response for one resolved `/tree/...` route (upstream
 *  `RedirectRepoTreeToSrc` via ctx.Redirect). `rawSuffix` is the request's
 *  own still-encoded path tail (never decoded, never re-escaped — the swap
 *  is textual, exactly upstream); `search` is `URL.search` ("?…" or "");
 *  `fetchAction` selects the 200 JSON arm over the 303 (the shared
 *  ctx.Redirect divergence below). */
export function treeRedirectResponse(repoLink: string, rawSuffix: string, search: string, fetchAction: boolean): Response {
  if (fetchAction) return fetchActionRedirectResponse(treeRedirectTarget(repoLink, rawSuffix, search));
  return new Response(null, {
    status: 303,
    headers: { location: treeRedirectTarget(repoLink, rawSuffix, search) },
  });
}

/** Build the redirect target for one `/blob` request (pure — testable): the
 *  wave-39 sibling of `treeRedirectTarget` — upstream `RedirectRepoBlobToCommit`
 *  (view_home.go:528-536) swaps the RAW suffix onto `/src/commit/` verbatim
 *  ("just like GitHub: browse files of a commit by
 *  `https://github/owner/repo/blob/{CommitID}`"), query preserved. */
export function blobRedirectTarget(repoLink: string, rawSuffix: string, search: string): string {
  return `${repoLink}/src/commit/${rawSuffix}${search}`;
}

/** The 303 response for one resolved `/blob/...` route (upstream
 *  `RedirectRepoBlobToCommit`, web.go:1757 — the `treeRedirectResponse`
 *  sibling: raw suffix verbatim, ctx.Redirect's `http.StatusSeeOther`
 *  default, post-resolution). Shared ctx.Redirect divergence, ported in
 *  wave 41 for BOTH siblings: upstream's fetch-action requests (a non-empty
 *  `X-Gitea-Fetch-Action` header, `modules/httplib/server_request.go:246-248`)
 *  get a 200 `{"redirect": …}` JSON body instead of the 303
 *  (services/context/base.go:153-156) — `fetchAction` selects the arm. */
export function blobRedirectResponse(repoLink: string, rawSuffix: string, search: string, fetchAction: boolean): Response {
  if (fetchAction) return fetchActionRedirectResponse(blobRedirectTarget(repoLink, rawSuffix, search));
  return new Response(null, {
    status: 303,
    headers: { location: blobRedirectTarget(repoLink, rawSuffix, search) },
  });
}
