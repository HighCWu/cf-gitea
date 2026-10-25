/**
 * The Tier-2 shell (SPEC-0008 §2.4.1 DOM contract): BaseLayout (head order,
 * config JSON, scripts), Navbar, RepoHeader + tab strip, Footer — the exact
 * DOM the unmodified official Gitea bundles enhance. Verified against the
 * pinned upstream templates: base/head.tmpl, head_script.tmpl, head_style.tmpl,
 * head_navbar.tmpl, repo/header.tmpl, base/footer.tmpl, status/404.tmpl.
 */

import { renderToString } from "hono/jsx/dom/server";
import type { Child } from "hono/jsx";

import { locale, configI18n } from "./locale";
import { userLink } from "./links";
import { ICON_PATHS, type IconName } from "./icons";
import type { Viewer } from "./viewer";
import type { UiContext } from "./ui-context";

// ---------------------------------------------------------------------------
// Icons (§2.4.1 icons row — inline SVG like upstream {{svg}})
// ---------------------------------------------------------------------------

/** Upstream `{{svg "octicon-x" size class}}` analog: an inline SVG with the
 *  exact `svg octicon-x` classes the Gitea CSS targets. Bodies come from the
 *  allowlist in icons.ts (TODO there: generated module wiring). Multi-path
 *  octicons (pages wave 4: octicon-issue-opened/-closed) render one `<path>`
 *  per stored body — single-path icons keep their exact prior DOM. */
export function Icon(props: { name: IconName; size?: number; class?: string }) {
  const classes = props.class === undefined ? `svg ${props.name}` : `svg ${props.name} ${props.class}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={classes}
      aria-hidden="true"
    >
      {ICON_PATHS[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// window.config (§2.4.1 — exact upstream WindowConfig() shape)
// ---------------------------------------------------------------------------

/** Exact upstream `WindowConfig()` shape
 *  (gitea/services/context/context_template.go:154-187) with slice-1 values
 *  (defaults from modules/setting/ui.go:116-118, markup.go:138). */
export interface WindowConfig {
  appUrl: string;
  appSubUrl: string;
  assetUrlPrefix: string;
  runModeIsProd: boolean;
  customEmojis: Record<string, never>;
  /** Per-page Vue-island payloads arrive later; every slice-1 page is null. */
  pageData: null;
  mermaidMaxSourceCharacters: number;
  sharedWorkerUri: string;
  notificationSettings: { MinTimeout: number; TimeoutStep: number; MaxTimeout: number };
  i18n: typeof configI18n;
}

/** Build the per-request window.config from the render context. */
export function buildWindowConfig(ctx: UiContext): WindowConfig {
  return {
    appUrl: `${ctx.origin}/`,
    appSubUrl: "",
    assetUrlPrefix: "/assets",
    runModeIsProd: true,
    customEmojis: {},
    pageData: null,
    mermaidMaxSourceCharacters: 50000,
    sharedWorkerUri: ctx.assets.sharedWorkerUri,
    notificationSettings: { MinTimeout: 10000, TimeoutStep: 10000, MaxTimeout: 60000 },
    i18n: { ...configI18n },
  };
}

/** Serialize window.config like Go's `encoding/json` (HTML-escapes `<`, `>`,
 *  `&`): a repo-name- or origin-borne `</script>` becomes `\u003c/script>`
 *  and can never close the config tag (§2.4.1). `<` first — the replacements
 *  introduce no new `<`, `>`, or `&`. */
export function serializeWindowConfig(config: WindowConfig): string {
  return JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

// ---------------------------------------------------------------------------
// Head (§2.4.1 script order)
// ---------------------------------------------------------------------------

/** Verbatim `templates/base/head_script.tmpl:5-9` (minus the nonce, §4.14):
 *  errors are buffered into arrays the bundle later switches to its handler. */
const ERROR_COLLECTOR = [
  "window.addEventListener('error', function(e) {window._globalHandlerErrors=window._globalHandlerErrors||[]; window._globalHandlerErrors.push(e);});",
  "window.addEventListener('unhandledrejection', function(e) {window._globalHandlerErrors=window._globalHandlerErrors||[]; window._globalHandlerErrors.push(e);});",
].join("\n");

function Head(props: { ctx: UiContext; title: string }) {
  const { ctx } = props;
  return (
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <meta name="referrer" content="same-origin" />
      <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml" />
      {/* head_style.tmpl: AssetCSSLinks("web_src/js/index.ts") then the theme
          link, both resolved through the manifest (§2.4.1). */}
      {ctx.assets.indexCssUris.map((uri) => (
        <link rel="stylesheet" href={uri} />
      ))}
      <link rel="stylesheet" href={ctx.assets.themeCssUri} />
      {/* head_script.tmpl order: error collector, config JSON, blocking iife
          (defines window.$/jQuery) — §2.4.1 script order. */}
      <script dangerouslySetInnerHTML={{ __html: ERROR_COLLECTOR }} />
      <script
        type="application/json"
        id="global-window-config"
        dangerouslySetInnerHTML={{ __html: serializeWindowConfig(buildWindowConfig(ctx)) }}
      />
      <script src={ctx.assets.iifeUri} />
    </head>
  );
}

// ---------------------------------------------------------------------------
// Navbar (templates/base/head_navbar.tmpl)
// ---------------------------------------------------------------------------

/**
 * The navbar for both viewer kinds (SPEC-0010 §2.5 — the only component
 * change sessions make). Anonymous viewers gain the Sign in link (`/login` —
 * deliberately absent before SPEC-0010; Explore stays unrendered: no explore
 * page exists). User viewers gain the upstream signed-in chrome REDUCED to
 * the username + a sign-out POST button (head_navbar.tmpl at the pin, minus
 * everything that needs services we have not built: no `+` create menu, no
 * notification bell, no avatar image — the avatar pipeline does not exist).
 * Wave 7 (the dead-link unlock): the username anchors the `/{username}`
 * profile (head_navbar.tmpl:98's `HomeLink()` shape, via the shared
 * `userLink` helper) — before the profile page existed it was plain text
 * (§2.4.1: dead links are not emitted).
 */
export function Navbar(props: { viewer: Viewer }) {
  return (
    <nav id="navbar" aria-label={locale.navbar_aria}>
      <a class="item" id="navbar-logo" href="/" aria-label={locale.home_title}>
        <img width="30" height="30" src="/assets/img/logo.svg" alt={locale.logo} aria-hidden="true" />
      </a>
      <button type="button" class="item btn only-mobile" id="navbar-expand-toggle" aria-label={locale.nav_menu}>
        <Icon name="octicon-three-bars" />
      </button>
      <div class="navbar-list navbar-left">
        <a class="item" target="_blank" href="https://docs.gitea.com">
          {locale.help}
        </a>
      </div>
      <div class="navbar-list navbar-right">
        {props.viewer.kind === "anonymous" ? (
          <a class="item" href="/login">
            {locale.sign_in}
          </a>
        ) : (
          <>
            <a class="item" id="navbar-username" href={userLink(props.viewer.username)}>
              {props.viewer.username}
            </a>
            <form class="item" method="post" action="/logout">
              <button type="submit" class="button">
                {locale.sign_out}
              </button>
            </form>
          </>
        )}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Repo header + tab strip (templates/repo/header.tmpl)
// ---------------------------------------------------------------------------

/** Tabs that back real pages this slice — the strip shows only these.
 *  Upstream order is Code → Issues → Pulls (header.tmpl); Commits is the
 *  cf-gitea addition (SPEC-0008 §2.4.1 — /commits is a slice-1 page) and
 *  keeps last so the upstream relative order stays intact. */
export type RepoTab = "code" | "issues" | "pulls" | "commits";

/** Tab chrome text for the wave-3 tabs (the components/commit-list.tsx
 *  component-local pattern — locale.ts is shared and not this wave's file). */
const tabLocale = {
  repo_issues: "Issues", // "repo.issues"
  repo_pulls: "Pull Requests", // "repo.pulls"
} as const;

/** Upstream shows `{{if .Repository.NumOpenIssues}}` count labels; D1 keeps
 *  lifetime (num_issues) + closed (num_closed_issues) counters, so the open
 *  count is the difference (close/reopen moves only the closed counter). */
function openCountOf(total: number, closed: number): number {
  return Math.max(total - closed, 0);
}

export function RepoHeader(props: { ctx: UiContext; activeTab?: RepoTab }) {
  const activeTab = props.activeTab ?? "code";
  const repo = props.ctx.repo;
  if (repo === undefined) {
    throw new Error("RepoHeader requires ctx.repo (BaseLayout renders it only when resolved)");
  }
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const openIssues = openCountOf(repo.numIssues, repo.numClosedIssues);
  const openPulls = openCountOf(repo.numPulls, repo.numClosedPulls);
  return (
    <div class="secondary-nav">
      <div class="ui container">
        <div class="repo-header flex-left-right">
          <div class="flex-text-block">
            <Icon name="octicon-repo" />
            <div class="flex-text-block tw-flex-wrap tw-text-18">
              <a class="muted tw-font-normal" href={`/${repo.ownerNamespace}`}>
                {repo.ownerNamespace}
              </a>
              /<a class="muted" href={repoLink}>
                {repo.slug}
              </a>
            </div>
            <div class="flex-text-block tw-flex-wrap">
              {/* Visibility badge; the D1 row has no description/fork/archived
                  flags yet — rendered when those columns land (§3.1). */}
              {repo.visibility === "public" ? (
                <span class="ui basic orange label">{locale.repo_desc_public_access}</span>
              ) : (
                <span class="ui basic label">{locale.repo_desc_private}</span>
              )}
            </div>
          </div>
          {/* Right side deliberately empty: star/watch/fork need write actions
              (none without auth, §2.5) and counters (not in D1 yet, §3.1). */}
        </div>
        <div class="secondary-info">
          Created{" "}
          <relative-time datetime={repo.createdAt.toISOString()}>
            {repo.createdAt.toISOString().slice(0, 10)}
          </relative-time>
        </div>
      </div>
      <div class="ui container">
        <overflow-menu class="ui secondary pointing menu">
          <div class="overflow-menu-items">
            <a class={activeTab === "code" ? "active item" : "item"} href={repoLink} data-shortcut-keys="g c">
              <Icon name="octicon-code" /> {locale.repo_code}
            </a>
            <a class={activeTab === "issues" ? "active item" : "item"} href={`${repoLink}/issues`} data-shortcut-keys="g i">
              {tabLocale.repo_issues}
              {openIssues > 0 ? <span class="ui small label">{openIssues}</span> : null}
            </a>
            <a class={activeTab === "pulls" ? "active item" : "item"} href={`${repoLink}/pulls`} data-shortcut-keys="g p">
              <Icon name="octicon-git-pull-request" /> {tabLocale.repo_pulls}
              {openPulls > 0 ? <span class="ui small label">{openPulls}</span> : null}
            </a>
            <a class={activeTab === "commits" ? "active item" : "item"} href={`${repoLink}/commits`}>
              <Icon name="octicon-history" /> {locale.repo_commits}
            </a>
          </div>
        </overflow-menu>
      </div>
      <div class="ui tabs divider" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer (templates/base/footer_content.tmpl)
// ---------------------------------------------------------------------------

export function Footer() {
  return (
    <footer class="page-footer" role="group" aria-label={locale.footer_aria}>
      <div class="left-links" role="contentinfo" aria-label={locale.footer_software_aria}>
        <a target="_blank" href="https://about.gitea.com">
          {locale.powered_by_gitea}
        </a>
      </div>
      <div class="right-links" role="group" aria-label={locale.footer_links_aria}>
        {/* Theme selector and language dropdown are not rendered: theme
            switching is fixed this slice (§1.2) and slice 1 is English-only. */}
        <a href="/assets/licenses.txt">{locale.licenses}</a>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// BaseLayout
// ---------------------------------------------------------------------------

/** Verbatim `templates/base/footer.tmpl:16` canary: the module script above
 *  sets `window.config.frontendInited` (web_src/js/index.ts:184) at the end
 *  of init; if it did not run, alert in prod. Kept as an inline **module** so
 *  it evaluates in script insertion order — AFTER the index module (ES
 *  modules defer and execute in document order), exactly like upstream. */
const FRONTEND_INITED_CANARY =
  'if (!window.config?.frontendInited && window.config?.runModeIsProd) alert("Frontend is not initialized, check console errors or asset files.");';

export function BaseLayout(props: {
  ctx: UiContext;
  /** Page-specific title part; rendered as `{title} - {pageTitle}` like
   *  upstream's `<title>` (base/head.tmpl:6) and used as the role=main
   *  aria-label. */
  title?: string;
  /** page-content discriminator classes, e.g. "repository file list" (§2.4.1). */
  pageClass?: string;
  /** Active repo tab when a repo header is rendered. */
  activeTab?: RepoTab;
  children?: Child;
}) {
  const { ctx } = props;
  const pageTitle = ctx.repo ? `${ctx.repo.ownerNamespace}/${ctx.repo.slug}` : locale.app_name;
  const fullTitle = props.title === undefined ? pageTitle : `${props.title} - ${pageTitle}`;
  return (
    <html lang="en" data-theme="gitea-light">
      <Head ctx={ctx} title={fullTitle} />
      <body>
        <div class="full height">
          <noscript>{locale.enable_javascript}</noscript>
          <Navbar viewer={ctx.viewer} />
          <div
            role="main"
            aria-label={props.title ?? pageTitle}
            class={props.pageClass === undefined ? "page-content" : `page-content ${props.pageClass}`}
          >
            {ctx.repo ? <RepoHeader ctx={ctx} activeTab={props.activeTab} /> : null}
            {props.children}
          </div>
        </div>
        <Footer />
        {/* Body tail, upstream footer.tmpl order: index module script (init is
            module-execution-driven, not DOMContentLoaded, §2.4.1), then the
            frontendInited canary — the canary MUST evaluate after the module
            or it would false-positive on every prod page. */}
        <script type="module" src={ctx.assets.indexUri} />
        <script type="module" dangerouslySetInnerHTML={{ __html: FRONTEND_INITED_CANARY }} />
      </body>
    </html>
  );
}

/** Full-document render: `renderToString` emits no doctype, pages prepend it.
 *  The UI router (U2/U3 wiring) renders every page through this. */
export function renderPage(element: Child): string {
  return `<!DOCTYPE html>${renderToString(element)}`;
}
