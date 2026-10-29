/**
 * The dispatcher-served 404 shell (the usability-sweep carve, 2026-10-29):
 * repository-scoped paths NO router claims used to fall to the headless
 * engine, whose `classify` (packages/git-engine mod.ts) bare-404s everything
 * that is not git-protocol/LFS/engine-JSON — a browser navigating a mistyped
 * repo URL got naked `not found` text. Upstream answers every such path from
 * the web router's NotFound (routers/web/web.go:1819) with the FULL 404
 * chrome (services/context/context_response.go:129-151): the status/404.tmpl
 * shell when the request's Accept includes text/html, a plain `Not found.`
 * line otherwise. The dispatcher keeps the plain arm (the engine's answer)
 * and hands the text/html arm here.
 *
 * This file also carries the 500 twin (`renderServerErrorShellResponse`
 * below): upstream's GLOBAL recovery answers every unhandled handler error
 * with status/500 the same way (routers/common/errpage.go renderPanicErrorPage,
 * invoked from RequestContextHandler's recover — routers/common/middleware.go:84
 * — mounted tree-wide through ProtocolMiddlewares at routers/init.go:178; the
 * handler-invoked ServerError twin is context_response.go:173-192). The
 * worker's `app.onError` (src/index.ts) owns the Accept negotiation; this is
 * the HTML arm.
 *
 * The shell mirrors `renderNotFound` exactly, plus the context assembly
 * resolveUiSession does for real pages: the session-aware viewer (SPEC-0010
 * §2.5), the manifest-driven assets, the demo gate, the unread-notification
 * badge, and the repo header when the repository itself resolves for the
 * viewer (upstream's `IsRepo = ctx.Repo.Repository != nil` — an invisible
 * repo stays headerless, existence never leaks through the 404). The
 * Projects/Packages unit toggles stay unloaded (the shell's tab strip hides
 * those tabs) — an error page does not pay the two settings reads.
 */

import { AssetBuildError, loadManifest } from "./manifest";
import { assetsBinding, assetsNotBuilt } from "./index";
import { resolveRepositoryForViewer } from "./repo-view";
import { BaseLayout, renderPage } from "./shell";
import { NotFoundPage } from "./pages/not-found";
import { countUnreadNotifications } from "./pages/notifications";
import { resolveViewer, type Viewer } from "./viewer";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";
import { demoModeEnabled } from "../services/demo-sweep";
import { SERVER_VERSION } from "../api/config";

/** Decode one path segment the route parser's way (`decodeURIComponent` with
 *  a catch → null — a malformed escape renders the headerless shell). */
function safeDecodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Render the full 404 shell for an unclaimed path. `request` supplies the
 * session cookie and the origin; `waitUntil` rides the caller's execution
 * context (omitted under direct `router.fetch` test invocations — the
 * resolver settles its background work inline, never dropped).
 */
export async function renderNotFoundShellResponse(
  env: Env,
  request: Request,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response> {
  const url = new URL(request.url);
  let manifest;
  try {
    manifest = await loadManifest(assetsBinding(env), url.origin);
  } catch (error) {
    if (error instanceof AssetBuildError) return assetsNotBuilt(error);
    throw error;
  }
  const resolution = await resolveViewer(env, request, { waitUntil: options?.waitUntil });
  const viewer = resolution.viewer;
  let notificationCount: number | null = null;
  if (viewer.kind === "user") {
    try {
      notificationCount = await countUnreadNotifications(env.DB, viewer.id);
    } catch {
      notificationCount = null;
    }
  }
  const ctx: UiContext = {
    viewer,
    origin: url.origin,
    notificationCount,
    demoMode: demoModeEnabled(env),
    assets: shellAssetsFromManifest(manifest),
  };
  // The repo header rides the same grant the page prologue uses
  // (resolveRepositoryForViewer): request-cased owner, one trailing `.git`
  // trimmed from the decoded repo segment (§4.4). A reserved owner name
  // (`/explore/...`, `/api/...`) simply resolves null — those rows cannot
  // exist in D1 — so no separate refusal arm is needed.
  const segments = url.pathname.slice(1).split("/");
  if (segments.length >= 2 && segments[1] !== "") {
    const owner = safeDecodeSegment(segments[0] as string);
    let repoSegment = safeDecodeSegment(segments[1] as string);
    if (owner !== null && repoSegment !== null && repoSegment !== "") {
      if (repoSegment.endsWith(".git")) repoSegment = repoSegment.slice(0, -4);
      const repo =
        repoSegment === "" ? null : await resolveRepositoryForViewer(env, viewer, owner, repoSegment);
      if (repo !== null) ctx.repo = repo;
    }
  }
  const headers = new Headers({
    "content-type": "text/html; charset=UTF-8",
    "cache-control": "max-age=0, private, must-revalidate",
  });
  if (resolution.setCookie !== null) headers.append("set-cookie", resolution.setCookie);
  return new Response(renderPage(<NotFoundPage ctx={ctx} />), { status: 404, headers });
}

/**
 * The 500 shell page — gitea/templates/status/500.tmpl at the pin, mapped
 * onto the standard shell. The template hardcodes its English error strings
 * (its header comment names the only template functions it may touch, "to
 * avoid triggering new panics"), so this component does the same rather than
 * adding locale-module keys.
 */
function InternalServerErrorPage(props: { ctx: UiContext; showAdminReport: boolean }) {
  return (
    <BaseLayout
      ctx={props.ctx}
      // 500.tmpl <title>: "Internal Server Error - {{AppName}}".
      title="Internal Server Error"
      // errpage.go:27 PageInternalServerErrorMark — the role=main class the
      // template's partial-render recovery script keys on.
      pageClass="status-page-500"
    >
      <div class="ui container">
        <div class="status-page-error">
          {/* 500.tmpl hardcodes this title (not a locale key). The `.ErrorMsg`
              block is skipped: errpage.go:118-122 fills it only OUTSIDE the
              prod posture, and the worker keeps prod posture unconditionally —
              the thrown error and its stack go to the log, never the body. */}
          <div class="status-page-error-title">500 Internal Server Error</div>
          <div class="tw-mt-8 tw-text-center">
            {/* `{{if or .SignedUser.IsAdmin .ShowFooterVersion}}` —
                ShowFooterVersion defaults true (modules/setting/other.go:17),
                so the version line shows to every viewer;
                `ctx.Locale.Tr "admin.config.app_ver"` = "Gitea Version". */}
            <p>Gitea Version: {SERVER_VERSION}</p>
            {props.showAdminReport ? (
              <p>
                {/* `{{ctx.Locale.Tr "error.report_message" …}}` with the
                    template's fixed URL — composed as an anchor instead of a
                    locale-HTML sink (the repo's no-raw-HTML rule); rel is
                    hardened per the pages' target=_blank precedent
                    (pages/dashboard.tsx). */}
                If you believe that this is a Gitea bug, please search for issues on{" "}
                <a href="https://github.com/go-gitea/gitea/issues" target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>{" "}
                or open a new issue if necessary.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/**
 * Render the full 500 shell for a thrown handler error. The caller (the
 * worker's `app.onError`, src/index.ts) owns the Accept negotiation and the
 * plain arms — this builder is the text/html arm only, the analog of
 * errpage.go's renderServerErrorPage template branch (renderPanicErrorPage
 * and ServerError both feed it). Manifest load failures mirror the 404
 * builder (AssetBuildError → the 503 not-built answer); any other throw
 * propagates to the caller's render-failure fallback (errpage.go:98-101's
 * log-and-plain-line branch).
 *
 * Assembly follows 500.tmpl's minimal-deps rule: viewer resolution is
 * best-effort (`.SignedUser` is optional — upstream pulls it from
 * already-resolved context data, never a fresh failure surface; here a failed
 * session read logs and renders anonymous), the repo header never resolves
 * (500.tmpl has no IsRepo arm), the unread-badge read is skipped (the
 * template's minimal navbar carries no badge), and the session-cookie
 * directive is NOT carried (recovery runs outside the session flow — unlike
 * the 404 builder, no rotation/clear value rides the response).
 */
export async function renderServerErrorShellResponse(
  env: Env,
  request: Request,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<Response> {
  const url = new URL(request.url);
  let manifest;
  try {
    manifest = await loadManifest(assetsBinding(env), url.origin);
  } catch (error) {
    if (error instanceof AssetBuildError) return assetsNotBuilt(error);
    throw error;
  }
  let viewer: Viewer = { kind: "anonymous" };
  try {
    viewer = (await resolveViewer(env, request, { waitUntil: options?.waitUntil })).viewer;
  } catch (error) {
    console.error("500 shell: viewer resolution failed; rendering anonymous", error);
  }
  const ctx: UiContext = {
    viewer,
    origin: url.origin,
    notificationCount: null,
    demoMode: demoModeEnabled(env),
    assets: shellAssetsFromManifest(manifest),
  };
  const headers = new Headers({
    "content-type": "text/html; charset=UTF-8",
    // SetCacheControlInHeader zero-options (errpage.go:87 → httpcache.go:29-31
    // — the SERVE_CACHE_CONTROL wire form).
    "cache-control": "max-age=0, private, must-revalidate",
  });
  return new Response(
    renderPage(<InternalServerErrorPage ctx={ctx} showAdminReport={viewer.kind === "user" && viewer.isAdmin} />),
    { status: 500, headers },
  );
}
