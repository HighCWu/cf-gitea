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
  /** The repo's Projects unit toggle (wave 45 — `repo_settings.has_projects`,
   *  the landed store's MustEnableRepoProjects reduction; upstream keeps the
   *  flag on the repository row itself). Set by the repo-scoped prologue
   *  alongside `repo`; the shell's Projects tab (repo/header.tmpl:146-154
   *  gates the tab on the same unit condition) and the `/projects` group's
   *  handlers both read it. Absent = not loaded (non-repo requests). */
  repoHasProjects?: boolean;
  /** The repo's Packages unit toggle (SPEC-0016 M2 — `repo_settings.
   *  has_packages`, the repoHasProjects twin for the R16 tab/route;
   *  repo/header.tmpl:140-144 gates the tab on CanRead(TypePackages), our
   *  landed reduction carries the flag). Set by the repo-scoped prologue
   *  from the SAME loadRepoSettings read; the shell's Packages tab and the
   *  `/packages` handler both read it (pages/packages.tsx
   *  `repoPackagesEnabled` is the loader-side twin). Absent/false = the tab
   *  renders nothing and the route 404-shells (upstream DefaultRepoUnits
   *  ships packages disabled). */
  repoHasPackages?: boolean;
  /** The repo's Actions unit toggle (SPEC-0012 M1c C1 — `repo_settings.
   *  has_actions`, the repoHasPackages twin for the Actions tab/route;
   *  repo/header.tmpl:130-139 gates the tab on `EnableActions ∧
   *  CanRead(TypeActions) ∧ ¬IsEmptyRepo`, our landed reduction carries the
   *  unit flag from the SAME loadRepoSettings read). The shell's Actions
   *  tab reads it alongside the row's isEmpty; the `/actions` handler
   *  re-reads the store for its MustEnableActions 404 arm (the C8 gate's
   *  polarity). Absent/false = the tab renders nothing and the route
   *  404-shells (the store default — the unit starts disabled). */
  repoHasActions?: boolean;
  /** The global PACKAGES_ENABLED gate (SPEC-0016 M2 — the strict-polarity
   *  var; absent/true = enabled, only the exact "false" disables — the
   *  DEMO_MODE discipline). Gates the R04 tab anchors (the profile's
   *  overview strip, the org menu) exactly like upstream's
   *  `if setting.Packages.Enabled` registration wrap (web.go:1106);
   *  the handlers read the env directly for their 404 shells. */
  packagesEnabled?: boolean;
  /** Signed-in viewers only: the unread-notification count for the navbar
   *  bell (pages wave 10 — head_navbar_icons.tmpl's `.notification_count`
   *  badge; upstream PageGlobalData.GetNotificationUnreadCount parity, one
   *  COUNT per signed-in request). Absent/null = anonymous or a degraded
   *  count — the badge renders hidden (upstream's tw-hidden-at-0 shape). */
  notificationCount?: number | null;
  /** SPEC-0014 §4.4 (M2 demo wave): the DEMO_MODE render gate for the
   *  shell's dismissible demo banner (shell.tsx). Set per-request from the
   *  env by the context assemblers — `demoModeEnabled(c.env)`
   *  (services/demo-sweep.ts, the ONE §2 gate function). Absent/false =
   *  gate off: the banner branch renders NO DOM node and pages stay
   *  byte-identical (the §2 invariant — the goldens pin it). */
  demoMode?: boolean;
  assets: ShellAssets;
}
