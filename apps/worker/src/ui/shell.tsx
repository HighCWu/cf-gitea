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
 * change sessions make). Anonymous viewers keep the Sign in link (`/login`,
 * navbar-right) and the Help item; user viewers gain the upstream signed-in
 * chrome REDUCED to the create links + the username + a sign-out POST button
 * (head_navbar.tmpl at the pin, minus everything that needs services we have
 * not built: no notification bell until wave 10 landed it, no avatar image —
 * the avatar pipeline does not exist). Wave 19 (the creation unlock): the
 * `+` dropdown renders as its two landed targets (Navbar's comment — the
 * wave-19 block). Wave 7 (the dead-link unlock): the username anchors the
 * `/{username}` profile (head_navbar.tmpl:98's `HomeLink()` shape, via the
 * shared `userLink` helper) — before the profile page existed it was plain
 * text (§2.4.1: dead links are not emitted). Wave 9 (the explore unlock):
 * the Explore item anchors `/explore/repos` at the head of navbar-left for
 * BOTH viewer kinds (head_navbar.tmpl:31 — upstream renders it for anonymous
 * viewers too), active-tracked through `activeNav`; before the explore
 * pages existed the link was unrendered (the same dead-link rule in
 * reverse). The logo's aria-label follows upstream head_navbar.tmpl:2:
 * "dashboard" signed in, "home_title" anonymous. The signed-in Issues/Pull
 * Requests items (head_navbar.tmpl:11-18) stay unrendered — their dashboard
 * pages do not exist. The Help item keeps its landed placement (navbar-left,
 * both viewer kinds — upstream moves it into the signed-in user dropdown,
 * which is degraded away). Wave 10 (the notifications unlock): the
 * notifications bell anchors `/notifications` at upstream's head_navbar_icons
 * position (between the two navbar lists) for signed-in viewers —
 * `octicon-bell` + the `.notification_count` badge, hidden at 0
 * (head_navbar_icons.tmpl:41-48; the badge is the bundle's live-count hook —
 * initNotificationCount targets `.notification_count`). The count comes in
 * through UiContext (`notificationCount` — null/absent renders it hidden;
 * the aria-label is additive, the upstream anchor's only name is its
 * tooltip).
 */
export function Navbar(props: { viewer: Viewer; activeNav?: "explore"; notificationCount?: number | null }) {
  const logoLabel = props.viewer.kind === "user" ? locale.dashboard : locale.home_title;
  return (
    <nav id="navbar" aria-label={locale.navbar_aria}>
      <a class="item" id="navbar-logo" href="/" aria-label={logoLabel}>
        <img width="30" height="30" src="/assets/img/logo.svg" alt={locale.logo} aria-hidden="true" />
      </a>
      <button type="button" class="item btn only-mobile" id="navbar-expand-toggle" aria-label={locale.nav_menu}>
        <Icon name="octicon-three-bars" />
      </button>
      <div class="navbar-list navbar-left">
        <a class={props.activeNav === "explore" ? "active item" : "item"} href="/explore/repos">
          {locale.explore}
        </a>
        <a class="item" target="_blank" href="https://docs.gitea.com">
          {locale.help}
        </a>
      </div>
      {props.viewer.kind === "user" ? (
        <a class="item" href="/notifications" data-tooltip-content={locale.notifications} data-shortcut-keys="g n" aria-label={locale.notifications}>
          <div class="tw-relative flex-text-block">
            <Icon name="octicon-bell" />
            <span class={props.notificationCount ? "notification_count" : "notification_count tw-hidden"}>
              {props.notificationCount ?? 0}
            </span>
          </div>
        </a>
      ) : null}
      <div class="navbar-list navbar-right">
        {props.viewer.kind === "anonymous" ? (
          <a class="item" href="/login">
            {locale.sign_in}
          </a>
        ) : (
          <>
            {/* The create menu (head_navbar.tmpl's signed-in `+` dropdown —
                wave 19, the creation pages unlock it) reduced to its two
                LANDED targets as plain items: the Fomantic dropdown needs the
                client bundle's JS, and the Migration item has no landed
                surface. Icon-only anchors keep the aria-labels (the
                head_navbar_icons bell precedent); New Organization is
                upstream-gated on SignedUser.CanCreateOrganization — always
                true at the landed tier (no DISABLED surface exists, the
                POST /orgs route header). */}
            <a class="item" href="/repo/create" data-tooltip-content={createLocale.new_repo} aria-label={createLocale.new_repo}>
              <Icon name="octicon-plus" />
            </a>
            <a class="item" href="/org/create" data-tooltip-content={createLocale.new_org} aria-label={createLocale.new_org}>
              <Icon name="octicon-organization" />
            </a>
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
 *  Upstream order is Code → Issues → Pulls → Releases (header.tmpl:157, the
 *  wave-20 addition — the releases family resolves the tab's 404); Commits
 *  is the cf-gitea addition (SPEC-0008 §2.4.1 — /commits is a slice-1 page)
 *  and keeps last so the upstream relative order stays intact. The upstream
 *  `{{if .NumReleases}}` count label is unrendered: D1 keeps no maintained
 *  num_releases counter and the shared shell would pay a COUNT on every
 *  repo-scoped render for a label most repos never show (pages/releases.tsx
 *  header) — the releases PAGES render the real count in their header menu. */
export type RepoTab = "code" | "issues" | "pulls" | "releases" | "commits";

/** Tab chrome text for the wave-3 tabs (the components/commit-list.tsx
 *  component-local pattern — locale.ts is shared and not this wave's file). */
const tabLocale = {
  repo_issues: "Issues", // "repo.issues"
  repo_pulls: "Pull Requests", // "repo.pulls"
  repo_releases: "Releases", // "repo.releases"
} as const;

/** Create-menu chrome text (the same component-local pattern — wave 19's
 *  navbar `+` reduction; upstream head_navbar.tmpl's dropdown labels). */
const createLocale = {
  new_repo: "New Repository", // "new_repo"
  new_org: "New Organization", // "new_org"
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
            {/* header.tmpl:157-161 — the releases tab (wave 20); the count
                label is the documented reduction (RepoTab note). */}
            <a class={activeTab === "releases" ? "active item" : "item"} href={`${repoLink}/releases`} data-shortcut-keys="g r">
              <Icon name="octicon-tag" /> {tabLocale.repo_releases}
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
  /** Active navbar item (wave 9: the explore pages — upstream
   *  `.PageIsExplore`). */
  activeNav?: "explore";
  children?: Child;
  /** Upstream `#notification_div` (wave 10 — the notifications page's
   *  role=main div IS `notification_div`, notification.tmpl's root; the
   *  bundle's live-update morph targets the id). Absent on every other
   *  page — the attribute is omitted, byte-identical DOM. */
  mainId?: string;
  /** The div's `data-sequence-number` (upstream FormString
   *  "sequence-number" passthrough — the JS discards stale fragments). */
  mainDataSequence?: string;
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
          <Navbar viewer={ctx.viewer} activeNav={props.activeNav} notificationCount={ctx.notificationCount} />
          <div
            role="main"
            aria-label={props.title ?? pageTitle}
            class={props.pageClass === undefined ? "page-content" : `page-content ${props.pageClass}`}
            id={props.mainId}
            data-sequence-number={props.mainDataSequence}
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
