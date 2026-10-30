/**
 * The JSX render entry of the UI router (SPEC-0008 §2.4 module layout keeps
 * `index.ts` the router/parser module, so the hono/jsx invocations live
 * here). U3: the body of `renderUiPage` is the real page switch on the
 * parsed route — the router and parsers stay untouched. `index.ts`'s
 * `uiPage` resolves the D1 repo row first (the 404 shells keep their repo
 * context, §4.5), then delegates here; every engine failure inside a page
 * loader degrades per the page (empty repo render / 404 shell), never a
 * thrown RPC.
 */

import { engineClient } from "./engine";
import { renderPage } from "./shell";
import { canWriteRepo } from "./pages/file-editor";
import { CommitsPage, loadCommitsData } from "./pages/commits";
import { FileViewPage, loadFileViewData } from "./pages/file-view";
import { HomePage, loadHomeData } from "./pages/home";
import { NotFoundPage } from "./pages/not-found";
import type { UiRoute } from "./index";
import type { UiContext } from "./ui-context";

/** The 404-in-shell response body: full BaseLayout, repo header included
 *  exactly when `ctx.repo` resolved (upstream `{{if .IsRepo}}`). */
export function renderNotFound(ctx: UiContext): string {
  return renderPage(<NotFoundPage ctx={ctx} />);
}

/** A rendered page: the HTML body and the status the router answers with. */
export interface RenderedUiPage {
  status: 200 | 404;
  html: string;
}

/**
 * The page switch (§2.1 inventory). Requires `ctx.repo` to be resolved —
 * `index.ts` renders the 404 shell itself when the row does not resolve.
 * Query surface: `commits` reads `?page` + `?path` (§3.3).
 */
export async function renderUiPage(options: {
  env: Env;
  ctx: UiContext;
  route: UiRoute;
  url: URL;
}): Promise<RenderedUiPage> {
  const { env, ctx, route, url } = options;
  const repo = ctx.repo;
  if (repo === undefined) return { status: 404, html: renderNotFound(ctx) };
  const notFound = (): RenderedUiPage => ({ status: 404, html: renderNotFound(ctx) });
  // The engine cell keyed by the RESOLVED row's combined name (engine.ts).
  const engine = engineClient(env, `${repo.ownerNamespace}/${repo.slug}`);

  switch (route.family) {
    case "home": {
      const data = await loadHomeData(engine, repo, url.origin);
      // The empty-repo arm's CanWriteCode fold gets the true D1 grant
      // (collaborator/team arms — the same predicate the file view rides at
      // the src arm); archived repos are read-only, so the grant folds false.
      data.canWriteCode = repo.isArchived ? false : await canWriteRepo(env, repo, ctx.viewer);
      return { status: 200, html: renderPage(<HomePage ctx={ctx} data={data} />) };
    }
    case "commits": {
      const data = await loadCommitsData(engine, repo, {
        refSuffix: route.refSuffix,
        page: url.searchParams.get("page"),
        path: url.searchParams.get("path"),
      });
      if ("notFound" in data) return notFound();
      return { status: 200, html: renderPage(<CommitsPage ctx={ctx} data={data} />) };
    }
    case "src": {
      if (route.refSuffix === null) return notFound(); // §3.3: prefix required
      const data = await loadFileViewData(engine, repo, url.origin, route.refSuffix);
      if ("notFound" in data) return notFound();
      // Wave 8: the file view's write chrome (Edit/Delete actions + the New
      // File link) rides the editor's write predicate — the LANDED
      // canWriteRepository through ../repo-grants.ts (team grants included);
      // anonymous resolves false with zero D1 reads, so the golden renders
      // stay byte-stable.
      const canWrite = repo.isArchived ? false : await canWriteRepo(env, repo, ctx.viewer);
      return { status: 200, html: renderPage(<FileViewPage ctx={ctx} data={data} canWrite={canWrite} />) };
    }
  }
}
