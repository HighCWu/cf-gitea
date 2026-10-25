/**
 * The Tier-2 UI router (SPEC-0008 §2.4 module layout): `uiRouter` +
 * `handlesUiRoute` + the route parsers (ref-suffix resolution). This module
 * is the single owner of UI route knowledge (§2.2).
 *
 * UI route inventory (§2.1 + the wave-2 extension — all GET; the slice-1
 * families render through the shell, /tree is upstream's redirect):
 *
 *   /:owner/:repo                          repo home (pages/home.tsx)
 *   /:owner/:repo/commits[/{ref-suffix}]   commit log (pages/commits.tsx)
 *   /:owner/:repo/src[/{ref-suffix}]       file view (pages/file-view.tsx;
 *                                          §3.3 requires the
 *                                          `branch|tag|commit` prefix)
 *   /:owner/:repo/tree[/{raw-suffix}]      code-tree URL family
 *                                          (pages/repo-home.tsx — upstream
 *                                          RedirectRepoTreeToSrc: 303 onto
 *                                          /src/{raw-suffix}, query kept)
 *   /:owner/:repo/issues                   issues list (pages/issues-list.tsx)
 *   /:owner/:repo/pulls                    pulls list (same component over
 *                                          is_pull rows — issues-list.tsx)
 *   /:owner/:repo/issues/{index}           issue detail (pages/issue-detail.tsx)
 *   /:owner/:repo/pulls/{index}            PR detail (same component over
 *                                          is_pull rows — issue-detail.tsx;
 *                                          upstream's type/URL match 303s the
 *                                          mismatched family onto the right
 *                                          one, issue_view.go:347-352)
 *
 * The wave-2 families dispatch INSIDE this router (uiPage); render.tsx's
 * page switch stays the slice-1 three — which is why they parse into the
 * separate TreeRoute/IssuesListRoute/IssueDetailRoute types below instead of
 * new UiFamily members. The rest of the suffixed /issues//pulls space
 * (`/issues/new`, `/issues/{index}/comments`, non-numeric or deeper tails)
 * and every other repo-scoped path stay with the engine — the four
 * git-protocol routes, the LFS family, and the engine JSON API/admin
 * surface. The parser claims families by shape and never protocol or engine
 * paths, and the reserved owner names (`api`, `assets` — SPEC-0003 §3) are
 * refused outright, so `/api/v1` and the edge-served `/assets/*` tree are
 * out of reach by construction.
 *
 * ## Dispatcher integration (orchestrator-owned `src/index.ts`, §2.2)
 *
 * Branch order: api → ui (`handlesUiRoute`) → gitHttpGate → engine. Exact
 * insertion:
 *
 * ```ts
 * import { uiRouter, handlesUiRoute } from "./ui";
 *
 * const app = new Hono<{ Bindings: Env }>();
 * // ... the existing /healthz + /api/v1 registrations stay first ...
 * app.route("/", uiRouter); // uiRouter claims only handlesUiRoute families
 *
 * // inside `fetch`, replacing the current unconditional repo-scoped branch
 * // (`segments[0] !== "api"` already keeps /api/v1 in Hono-land):
 * if (isRepoScoped) {
 *   // UI page families — src/ui is the single source of truth:
 *   if (handlesUiRoute(pathname)) return app.fetch(req, env, ctx);
 *   // git-protocol routes + engine passthrough: unchanged.
 *   return gitHttpGate(req, env, ctx, gitHttp);
 * }
 * return app.fetch(req, env, ctx);
 * ```
 *
 * `handlesUiRoute` is consulted BEFORE Hono is asked to route (§2.2), so the
 * sub-app only ever sees families it claims and its miss path can never
 * swallow an engine route.
 *
 * U3 note: the three pages render for real (home / commits / src, wired in
 * render.tsx's page switch). Every claimed route answers from the same
 * pipeline: parse → public-repo read (§2.5) → page data via direct service
 * calls (§3.2) → shell render; anything unresolved 404-shells. The parsers
 * below (`parseUiRoute`, `splitRefSuffix`, `resolveRefSuffix`) are the
 * pages' URL contract and ship with their semantics tests.
 */

import { Hono, type Context } from "hono";
import { trimTrailingSlash } from "hono/trailing-slash";

import { isReservedOwnerName } from "../repos/service";
import { AssetBuildError, loadManifest } from "./manifest";
import { resolveRepositoryForViewer } from "./repo-view";
import { renderNotFound, renderUiPage } from "./render";
import { treeRedirectResponse } from "./pages/repo-home";
import { crossFamilyRedirect, loadIssueDetailData, renderIssueDetailPage } from "./pages/issue-detail";
import { loadIssuesListData, renderIssuesListPage } from "./pages/issues-list";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";
import { resolveViewer, type Viewer } from "./viewer";

// ---------------------------------------------------------------------------
// Route parsers (the single source of truth — handlesUiRoute and uiRouter
// both read them; §2.2 "route knowledge has exactly one owner")
// ---------------------------------------------------------------------------

/** The claimed UI page families (§2.1 inventory). */
export type UiFamily = "home" | "commits" | "src";

/** A repo-scoped path the UI router owns, fully decoded. */
export interface UiRoute {
  family: UiFamily;
  /** Decoded owner segment, request casing preserved (D1 lookup folds). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed (§4.4
   *  gate convention; repo names ending `.git` are reserved, so the trim is
   *  unambiguous). */
  repo: string;
  /** Decoded remainder after the family literal, "/"-joined; `null` = the
   *  bare family URL (`/commits`, `/src`). */
  refSuffix: string | null;
}

// ---------------------------------------------------------------------------
// Wave-2 families (SPEC-0008 U3 extension: the code-tree redirect + the
// issues/pulls lists). A separate union, NOT extra members of `UiRoute`:
// `render.tsx`'s page switch stays exhaustive over the slice-1 three (the
// strictNullChecks fall-off-the-switch check), and the wave-2 dispatch lives
// entirely in this router — render.tsx never sees these routes.
// ---------------------------------------------------------------------------

/** The `/tree` family (pages/repo-home.tsx): upstream RedirectRepoTreeToSrc —
 *  the RAW (still-encoded) suffix swaps verbatim onto `/src/`. */
export interface TreeRoute {
  family: "tree";
  owner: string;
  repo: string;
  /** The still-encoded path tail after `/tree`, "/"-joined segments
   *  (`ctx.PathParamRaw("*")` parity); "" = the bare `/tree` (no upstream
   *  route → the §4.5 404 shell). */
  rawSuffix: string;
}

/** The `/issues` and `/pulls` list families (pages/issues-list.tsx): the
 *  bare URLs — the wave-3 detail routes below own the single-index tails. */
export interface IssuesListRoute {
  family: "issues" | "pulls";
  owner: string;
  repo: string;
}

/** The wave-3 detail family (pages/issue-detail.tsx): `/issues/{index}` and
 *  `/pulls/{index}` — one component over the shared issue rows; `urlKind`
 *  records which literal addressed it (upstream ViewIssue redirects the
 *  mismatched family onto `Issue.Link()`, issue_view.go:347-352). */
export interface IssueDetailRoute {
  family: "issue-detail";
  owner: string;
  repo: string;
  urlKind: "issues" | "pulls";
  index: number;
}

/** Everything `parseUiRoute` can return; `UiRoute` remains the slice-1 view
 *  render.tsx consumes. */
export type ParsedUiRoute = UiRoute | TreeRoute | IssuesListRoute | IssueDetailRoute;


/**
 * Parse a repo-scoped pathname into a UI route, or `null` when the path is
 * not a UI family (→ the dispatcher keeps the engine/gate ownership).
 *
 * Segment handling mirrors `parseGitHttpRoute` (src/git-http/parse.ts):
 * percent-decoding per segment (undecodable → not ours; the engine 404s
 * those), exactly one trailing `.git` trimmed after decoding, and a
 * structural pre-filter — an empty segment anywhere (double slashes,
 * including the never-emitted `//` tails) makes the path not ours.
 */
export function parseUiRoute(pathname: string): ParsedUiRoute | null {
  if (pathname === "/" || !pathname.startsWith("/")) return null;
  // §4.13: the router 301s trailing-slash URLs to the canonical form; the
  // parser classifies the trimmed shape so the dispatcher admits them.
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const raw = trimmed.split("/");
  if (raw.length < 3) return null; // need /owner/repo at minimum
  if (raw.slice(1).some((segment) => segment === "")) return null;

  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(raw[1] as string);
    repo = decodeURIComponent(raw[2] as string);
  } catch {
    return null;
  }
  // Reserved owner names can never exist in D1 (SPEC-0003 §3); refusing them
  // here keeps `/api/*` and the edge-served `/assets/*` tree engine-owned.
  if (isReservedOwnerName(owner)) return null;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (repo === "") return null;

  const tail = raw.slice(3);
  if (tail.length === 0) return { family: "home", owner, repo, refSuffix: null };

  // Family literals are lowercase-exact, like upstream's chi patterns
  // (`{type:branch|tag|commit}` routes; `gitea/routers/web/web.go:1749`).
  const [head, ...rest] = tail;
  // Wave-2 families: /tree re-emits its suffix RAW (RedirectRepoTreeToSrc
  // swaps the still-encoded text, view_home.go:521). /issues and /pulls
  // claim the bare list URLs plus the wave-3 single-integer detail tail
  // (upstream chi `/{index}` + PathParamInt64: "007" is 7, a negative is
  // admitted here and 404-shells on the row lookup); anything else in the
  // space (`/issues/new`, `/issues/1/comments`, non-numeric) stays
  // engine-owned, the same posture as `/commit/{sha}` (§1.2, open question 1).
  if (head === "tree") return { family: "tree", owner, repo, rawSuffix: rest.join("/") };
  if (head === "issues" || head === "pulls") {
    if (rest.length === 0) return { family: head, owner, repo };
    if (rest.length === 1 && /^-?\d+$/.test(rest[0] as string)) {
      return { family: "issue-detail", owner, repo, urlKind: head, index: Number.parseInt(rest[0] as string, 10) };
    }
    return null;
  }
  let suffix: string;
  try {
    suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
  if (head === "commits") return { family: "commits", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  if (head === "src") return { family: "src", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  return null;
}

/** The dispatcher gate (§2.2): `true` = the request belongs to a UI page
 *  family and must be answered by `uiRouter`, never the engine. */
export function handlesUiRoute(pathname: string): boolean {
  return parseUiRoute(pathname) !== null;
}

// ---------------------------------------------------------------------------
// Ref-suffix resolution (§3.3) — upstream's URL-path ref rules, ported
// from `RepoRefByType`/`getRefName` (gitea/services/context/repo.go:833-935).
// Pure functions: U3's page-data layer supplies `listRefs()` output.
// ---------------------------------------------------------------------------

/** The ref-type prefix `/{src,commits}/` URLs carry (§3.3: required, as
 *  upstream's explicit `/branch|tag|commit/*` routes; the legacy no-prefix
 *  form is not claimed — it 404-shells instead). */
export type RefType = "branch" | "tag" | "commit";

/** Split the family suffix into its ref-type prefix and the ref+path rest.
 *  `null` = no (or a non-exact) prefix → 404 shell (§3.3). */
export function splitRefSuffix(suffix: string): { refType: RefType; rest: string } | null {
  for (const refType of ["branch", "tag", "commit"] as const) {
    if (suffix === refType) return { refType, rest: "" };
    if (suffix.startsWith(`${refType}/`)) return { refType, rest: suffix.slice(refType.length + 1) };
  }
  return null;
}

/** The ref name universe of one repository — `listRefs()` output plus the D1
 *  default branch (§4.9: unborn/broken HEAD falls back to that convention). */
export interface RefSuffixRefs {
  branches: readonly string[];
  tags: readonly string[];
  defaultBranch: string;
}

/** A resolved ref suffix: how the URL labeled it, the ref (branch/tag name,
 *  or the request's own sha prefix for `commit`), and the tree path under it. */
export interface ResolvedRefSuffix {
  refType: RefType;
  ref: string;
  treePath: string;
}

/** Upstream `getRefName` commit branch: `IsStringValidObjectID(fmt, part, 7)`
 *  — 7..64 hex, no existence check at parse time (upstream FIXME preserved;
 *  the engine readCommit resolves it in U3). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The default branch to use when the URL carries no ref: the D1 default
 *  branch when it exists, else the first branch — upstream
 *  `RepoRefByType`'s `GetBranchNames(0, 1)` fallback (repo.go:964-971). */
function defaultBranchOf(refs: RefSuffixRefs): string | null {
  if (refs.branches.includes(refs.defaultBranch)) return refs.defaultBranch;
  return refs.branches[0] ?? null;
}

/**
 * Resolve a decoded ref+path suffix against a repository's refs. Semantics
 * (upstream `getRefNameFromPath`, repo.go:833-845):
 *
 * - The ref may bear slashes; the SHORTEST existing cumulative prefix wins
 *   (first match walking left to right) and the remainder is the tree path —
 *   so `feature/foo/README.md` with branch `feature/foo` is (ref
 *   `feature/foo`, tree `README.md`), and with branches `feature` AND
 *   `feature/foo` the shorter one wins, exactly upstream.
 * - An empty rest resolves to the default branch regardless of the declared
 *   prefix (upstream's `reqPath == ""` branch, repo.go:962-980).
 * - `branch` + literal `HEAD` → the default branch (repo.go:875-881). A
 *   branch actually named `HEAD` wins first via the walk.
 * - `commit` + literal `HEAD` → null here: upstream swaps in the default
 *   branch's commit id, which needs an engine round-trip — U3's page-data
 *   layer owns that resolution, and until then the caller 404-shells it.
 * - Anything unresolvable → null → 404 shell (§3.3, §4.5).
 */
export function resolveRefSuffix(refType: RefType, rest: string, refs: RefSuffixRefs): ResolvedRefSuffix | null {
  const parts = rest === "" ? [] : rest.split("/");

  if (parts.length === 0) {
    const fallback = defaultBranchOf(refs);
    return fallback === null ? null : { refType: "branch", ref: fallback, treePath: "" };
  }

  const walk = (names: readonly string[]): ResolvedRefSuffix | null => {
    const set = new Set(names);
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join("/");
      if (set.has(candidate)) {
        return { refType, ref: candidate, treePath: parts.slice(i + 1).join("/") };
      }
    }
    return null;
  };

  switch (refType) {
    case "branch": {
      const hit = walk(refs.branches);
      if (hit !== null) return hit;
      if (parts[0] === "HEAD") {
        const fallback = defaultBranchOf(refs);
        if (fallback !== null) return { refType: "branch", ref: fallback, treePath: parts.slice(1).join("/") };
      }
      return null;
    }
    case "tag":
      return walk(refs.tags);
    case "commit": {
      const sha = parts[0] as string;
      if (COMMIT_SHA.test(sha)) return { refType: "commit", ref: sha, treePath: parts.slice(1).join("/") };
      return null; // incl. HEAD — needs the engine (see doc comment)
    }
  }
}

// ---------------------------------------------------------------------------
// Assets seam (§2.3.4)
// ---------------------------------------------------------------------------

/** Structural type of the Workers static-assets fetcher binding, as read by
 *  `loadManifest`. Declared here (not taken from the generated Env) because
 *  the wrangler.jsonc `assets` block is the orchestrator's U1 wiring — until
 *  it lands, `Env` legitimately has no ASSETS member and the binding is
 *  absent at runtime, which is exactly the 503 path below. */
export interface UiAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function isAssetsFetcher(value: unknown): value is UiAssetsFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

/** Read `env.ASSETS` without assuming the U1 wrangler wiring: the generated
 *  Env gains the member when the assets block lands (then `wrangler types`);
 *  until then this returns `undefined` → `AssetBuildError` → the 503. The
 *  `in` check narrows the unlisted member to `unknown` (TS 4.9+); the shape
 *  guard keeps a stray non-fetcher binding from reaching loadManifest. */
export function assetsBinding(env: Env): UiAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (isAssetsFetcher(binding)) return binding;
  }
  return undefined;
}

/**
 * The §2.3.4 failure mode: a missing manifest, missing required entry, or
 * absent binding fails fast with 503 plain text instead of a broken page.
 * Git and API routes never pass through the shell (the assets config and the
 * dispatcher own those paths), so they are unaffected. Same plain-text shape
 * as the gate's error responses (`plainTextInternal`).
 */
export function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// uiRouter (§2.2 — the orchestrator mounts this at the dispatcher)
// ---------------------------------------------------------------------------

/** Narrow the parsed union back to the slice-1 route `renderUiPage` consumes
 *  (the two wave-2 dispatch branches above returned for every other member). */
function isSliceOneRoute(route: ParsedUiRoute): route is UiRoute {
  return route.family === "home" || route.family === "commits" || route.family === "src";
}

/**
 * One handler for every claimed family: the parser re-reads the pathname
 * (the route registrations below exist so the sub-app never claims beyond
 * the parser's families), the repo resolves through the §2.5 public-repo
 * read, and the page switch renders (render.tsx delegates per family).
 * All routes are GET-only (§2.1); every unresolved repo/ref/path answers the
 * §4.5 404 shell, and a missing/unreadable manifest answers the §2.3.4 503
 * before any page work happens.
 */
async function uiPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  const route = parseUiRoute(url.pathname);
  // Only reachable through registration/parser drift or a trailing slash
  // (the middleware below turns the trailing-slash 404 into the canonical
  // 301) — never render the shell for a path the parser does not claim.
  if (route === null) return c.notFound();

  // SPEC-0010 §2.5 viewer resolution (the session wave's transition note in
  // viewer.ts): the session cookie is verified per request and every
  // response carries the rotation Set-Cookie when one is directed.
  // `c.executionCtx` is unavailable under direct `router.fetch` invocations
  // (the tests) — the resolver then settles its background work inline.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    const resolution = await resolveViewer(c.env, c.req.raw, { waitUntil });
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    ctx = { viewer: resolution.viewer, origin: url.origin, assets: shellAssetsFromManifest(manifest) };
  } catch (error) {
    if (error instanceof AssetBuildError) return assetsNotBuilt(error);
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  // SPEC-0010 §2.6: the §2.5 repo read widens through the gate's own grant
  // lines (shared readGrant predicate) — anonymous keeps the row-1 collapse
  // verbatim, a session viewer gains the authenticated read paths; anything
  // without a grant 404-shells exactly as before (existence stays hidden).
  const repo = await resolveRepositoryForViewer(c.env, viewer, route.owner, route.repo);
  if (repo === null) return respond(c.html(renderNotFound(ctx), 404));
  ctx.repo = repo;

  // Wave-2 dispatch (render.tsx never sees these families). The redirect
  // and the list page run AFTER the same §2.5 repo resolution as the
  // slice-1 pages: unknown/private repos 404-shell, never redirect.
  if (route.family === "tree") {
    // Bare /tree has no upstream route (chi needs the slash) → §4.5 shell.
    if (route.rawSuffix === "") return respond(c.html(renderNotFound(ctx), 404));
    // The target prefix is the RESOLVED row's canonical link (upstream
    // ctx.Repo.RepoLink); the suffix and query travel verbatim.
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    return respond(treeRedirectResponse(repoLink, route.rawSuffix, url.search));
  }
  if (route.family === "issues" || route.family === "pulls") {
    const data = await loadIssuesListData(c.env.DB, repo.id, route.family, url.searchParams);
    return respond(c.html(renderIssuesListPage(ctx, data), 200));
  }
  // Wave-3 dispatch: the issue/PR detail page (render.tsx never sees this
  // family). Upstream's type/URL match runs after the row lookup
  // (issue_view.go:347-352) — a mismatched family 303s onto Issue.Link(),
  // an unknown index 404-shells with the repo context (§4.5).
  if (route.family === "issue-detail") {
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    const data = await loadIssueDetailData(c.env.DB, repo, route.urlKind, route.index, url.origin);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const redirect = crossFamilyRedirect(route.urlKind, repoLink, data.issue.index, data.issue.isPull);
    if (redirect !== null) return respond(new Response(null, { status: 303, headers: { location: redirect } }));
    return respond(c.html(renderIssueDetailPage(ctx, data), 200));
  }

  // U3 page switch (render.tsx — home | commits | src), with the 404 shell
  // for unresolvable refs/paths (§4.5).
  if (!isSliceOneRoute(route)) return respond(await c.notFound()); // registration/parser drift guard
  const { status, html } = await renderUiPage({ env: c.env, ctx, route, url });
  return respond(c.html(html, status));
}

export const uiRouter = new Hono<{ Bindings: Env }>();

// §4.13: trailing-slash URLs redirect to the canonical form (we never emit
// them). Default mode rewrites only when the trimmed path matched a claimed
// route (the response was a 404), so it cannot launder unclaimed paths.
uiRouter.use(trimTrailingSlash());

// The claimed families (§2.1), registered exactly as parseUiRoute classifies
// them so the sub-app's reach equals handlesUiRoute's. HEAD is intentionally
// unregistered (GET-only surface, §2.1): a HEAD request misses into the
// parent app's plain 404 — identical to today's engine answer for these
// paths.
uiRouter.get("/:owner/:repo", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/src", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/src/*", (c) => uiPage(c));
// Wave-2 families (parseUiRoute claims exactly these shapes).
uiRouter.get("/:owner/:repo/tree", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/tree/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/issues", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/issues/:index", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/pulls", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/pulls/:index", (c) => uiPage(c));
