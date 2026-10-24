/**
 * Per-request render context for the shell and pages (SPEC-0008 §2.4 module
 * layout). The UI router assembles this once per request: the viewer seam
 * (§2.5), the request origin (feeds `window.config.appUrl`), the optional
 * resolved repository row, and the asset URIs preloaded from the manifest
 * module — components never touch `env.ASSETS` themselves.
 */

import { assetURI, cssLinks, type UiManifest } from "./manifest";
import type { repositories } from "../db/schema";
import type { Viewer } from "./viewer";

/** The resolved `repositories` row (Drizzle `$inferSelect`), as produced by
 *  the same `resolveRepository()` join the git gate uses (SPEC-0008 §2.5). */
export type RepoRow = typeof repositories.$inferSelect;

/** The four core chunks every slice-1 page needs (SPEC-0008 §2.1 "core
 *  chunks"), resolved once from the Vite manifest. */
export interface ShellAssets {
  /** Blocking head script defining `window.$`/`jQuery` (`web_src/js/iife.ts`). */
  iifeUri: string;
  /** Body-tail ES module running page init (`web_src/js/index.ts`). */
  indexUri: string;
  /** Theme stylesheet (`web_src/css/themes/theme-gitea-light.css`). */
  themeCssUri: string;
  /** `window.config.sharedWorkerUri` (user-events shared worker). */
  sharedWorkerUri: string;
  /** AssetCSSLinks expansion for `web_src/js/index.ts`: the entry's CSS plus
   *  the CSS of every statically-imported chunk, deduplicated (§2.3.4). */
  indexCssUris: readonly string[];
}

/** Resolve the shell asset URIs from a loaded manifest (pure — no binding). */
export function shellAssetsFromManifest(manifest: UiManifest): ShellAssets {
  return {
    iifeUri: assetURI(manifest, "web_src/js/iife.ts"),
    indexUri: assetURI(manifest, "web_src/js/index.ts"),
    themeCssUri: assetURI(manifest, "web_src/css/themes/theme-gitea-light.css"),
    sharedWorkerUri: assetURI(manifest, "web_src/js/user-events.sharedworker.ts"),
    indexCssUris: cssLinks(manifest, "web_src/js/index.ts"),
  };
}

/** Everything the shell and page components need to render one request. */
export interface UiContext {
  viewer: Viewer;
  /** Request origin without trailing slash ("https://git.example.com");
   *  rendered as `appUrl` = `${origin}/`. */
  origin: string;
  /** Resolved repository row; absent on pages without a repo context (e.g.
   *  the unknown-owner 404). When present, BaseLayout renders the repo
   *  header + tab strip, mirroring upstream's `{{if .IsRepo}}` in the 404
   *  and page templates. */
  repo?: RepoRow;
  assets: ShellAssets;
}
