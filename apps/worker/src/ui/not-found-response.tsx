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
import { renderPage } from "./shell";
import { NotFoundPage } from "./pages/not-found";
import { countUnreadNotifications } from "./pages/notifications";
import { resolveViewer } from "./viewer";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";
import { demoModeEnabled } from "../services/demo-sweep";

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
