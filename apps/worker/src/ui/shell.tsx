/**
 * The Tier-2 shell (SPEC-0008 §2.4.1 DOM contract): BaseLayout (head order,
 * config JSON, scripts), Navbar, RepoHeader + tab strip, Footer — the exact
 * DOM the unmodified official Gitea bundles enhance. Verified against the
 * pinned upstream templates: base/head.tmpl, head_script.tmpl, head_style.tmpl,
 * head_navbar.tmpl, repo/header.tmpl, base/footer.tmpl, status/404.tmpl.
 * SPEC-0014 §4.4 (M2): the DEMO_MODE-gated demo banner rides BaseLayout —
 * gate off it renders no DOM node at all (§2 invariant).
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
  /** Upstream `Context.PageData` (services/context/context.go:53 — "it is
   *  `window.config.pageData`"), carried into the config JSON by
   *  WindowConfig()'s `"pageData": c.parentContext().GetData()["PageData"]`
   *  (context_template.go:162). Pages that arm none serve null (Go's nil);
   *  the bundle's bootstrap normalizes null to {} client-side
   *  (web_src/js/bootstrap.ts:7), so unarmed pages never see a null access. */
  pageData: Record<string, unknown> | null;
  mermaidMaxSourceCharacters: number;
  sharedWorkerUri: string;
  notificationSettings: { MinTimeout: number; TimeoutStep: number; MaxTimeout: number };
  i18n: typeof configI18n;
}

/** Build the per-request window.config from the render context. `pageData`
 *  threads the page's Context.PageData payload (the chart pages' repoLink —
 *  code_frequency.go:25, recent_commits.go:23); absent → null, the
 *  byte-identical unarmed render every golden pins. */
export function buildWindowConfig(ctx: UiContext, pageData?: Record<string, unknown>): WindowConfig {
  return {
    appUrl: `${ctx.origin}/`,
    appSubUrl: "",
    assetUrlPrefix: "/assets",
    runModeIsProd: true,
    customEmojis: {},
    pageData: pageData ?? null,
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

function Head(props: { ctx: UiContext; title: string; pageData?: Record<string, unknown> }) {
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
        dangerouslySetInnerHTML={{ __html: serializeWindowConfig(buildWindowConfig(ctx, props.pageData)) }}
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
 *  Upstream order is Code → Issues → Pulls → Packages → Projects → Releases
 *  → Activity (header.tmpl:157, the wave-20 addition; header.tmpl:177, the
 *  activity page's tab — the releases family and the /activity route resolve
 *  both tabs' 404s); Commits is the cf-gitea addition (SPEC-0008 §2.4.1 —
 *  /commits is a slice-1 page) and keeps last so the upstream relative
 *  order stays intact. SPEC-0016 M2 inserts "packages" at upstream's
 *  header.tmpl:140-144 slot (between Pulls and Projects). The upstream
 *  `{{if .NumReleases}}` count label is unrendered: D1 keeps no maintained
 *  num_releases counter and the shared shell would pay a COUNT on every
 *  repo-scoped render for a label most repos never show (pages/releases.tsx
 *  header) — the releases PAGES render the real count in their header
 *  menu. The wiki tab (header.tmpl:162-166, between Releases and Activity)
 *  is the ratified divergence: upstream gates it on the wiki unit read
 *  permission; ours renders UNCONDITIONALLY (the wiki pages family is
 *  landed and serving; the route-level hasWiki 404 shell stays in the
 *  family's own prologue — ui/index.ts wikiPrologue's MustEnableWiki arm),
 *  so a settings-disabled wiki shows the tab over its 404 shell. */
export type RepoTab = "code" | "issues" | "pulls" | "actions" | "packages" | "projects" | "releases" | "wiki" | "activity" | "commits";

/** Tab chrome text for the wave-3 tabs (the components/commit-list.tsx
 *  component-local pattern — locale.ts is shared and not this wave's file). */
const tabLocale = {
  repo_issues: "Issues", // "repo.issues"
  repo_pulls: "Pull Requests", // "repo.pulls"
  repo_actions: "Actions", // "actions.actions" (header.tmpl:130-139 — SPEC-0012 M1c C1)
  repo_packages: "Packages", // "packages.title" (header.tmpl:140-144 — SPEC-0016 M2)
  repo_projects: "Projects", // "repo.projects" (wave 45 — the projects tab)
  repo_releases: "Releases", // "repo.releases"
  repo_wiki: "Wiki", // "repo.wiki" (header.tmpl:165 — the tab's label)
  repo_activity: "Activity", // "repo.activity" (the pulse tab)
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

// ---------------------------------------------------------------------------
// Repo header right side — the Watch/Star/Fork trio (templates/repo/header/
// watch.tmpl, star.tmpl, fork.tmpl at the pin; usability B-4)
// ---------------------------------------------------------------------------

/** The trio's chrome text (options/locale locale_en-US.json `repo.*` keys —
 *  the component-local pattern; locale.ts is shared and not this wave's
 *  file). The watch MODE strings carry the watch.tmpl menu's exact values. */
const repoActionsLocale = {
  watch: "Watch", // "repo.watch"
  watching: "Watching", // "repo.watching"
  unstar: "Unstar", // "repo.unstar"
  star: "Star", // "repo.star"
  fork: "Fork", // "repo.fork"
  watch_guest_user: "Sign in to watch this repository.", // "repo.watch_guest_user"
  star_guest_user: "Sign in to star this repository.", // "repo.star_guest_user"
  fork_guest_user: "Sign in to fork this repository.", // "repo.fork_guest_user"
  fork_from_self: "You cannot fork a repository you own.", // "repo.fork_from_self"
  mode_participating: "Participating and mentions", // "repo.watch.mode.participating"
  mode_participating_desc: "Receive notifications from this repository when participating or mentioned.",
  mode_all: "All activity", // "repo.watch.mode.all"
  mode_all_desc: "Receive notifications for all events.",
} as const;

/**
 * The Watch button group, `div#repo-header-watch` (repo/header/watch.tmpl
 * verbatim, reduced to the landed watch substrate). Upstream's four-mode menu
 * (participating / all / ignore / custom) reduces to the TWO arms the binary
 * `repo_watchers` edge can represent: "All activity" (POST /action/watch —
 * the row insert, WatchModeNormal) and "Participating and mentions" (POST
 * /action/participate — WatchModeNone, which upstream itself models as the
 * ROW'S ABSENCE: GetWatch's no-row dummy carries Mode None, watch.go:61-64).
 * The ignore (WatchModeDont) and custom (WatchModeCustom) modes need the
 * `watch.mode` column the landed schema does not carry — their menu items and
 * the watch_options_modal (header.tmpl:93) are NOT rendered (the dead-link
 * rule: never emit controls the backend cannot answer). The button text and
 * the active check-mark track the edge: watching → "Watching" + the all item
 * checked; not watching → "Watch" + the participating item checked (upstream
 * SelectedMode's binary reduction).
 *
 * Signed-in items carry the fetch-action wiring the official bundle drives
 * (fetch-action.ts: `data-fetch-method="post"` + `data-fetch-url` + the
 * `$body #repo-header-watch` sync that swaps this very div with the POST's
 * fragment response); anonymous viewers get upstream's login-link variant
 * (the login route is ours: /login, the navbar's Sign in arm — upstream's
 * AppSubUrl + /user/login). The count is the maintained `repositories.
 * num_watches` column (upstream `.Repository.NumWatches`, plain digits —
 * CountFmt's k-formatting starts far above the D1-counter scale).
 */
export function RepoHeaderWatch(props: { repoLink: string; count: number; viewer: Viewer; watching?: boolean }) {
  const signed = props.viewer.kind === "user";
  const buttonLabel = signed && props.watching ? repoActionsLocale.watching : repoActionsLocale.watch;
  return (
    <div id="repo-header-watch" class="flex-text-block">
      {signed ? (
        <>
          <button type="button" class="ui dropdown custom compact small basic button" data-global-init="initRepoWatchMenu" aria-label={buttonLabel}>
            <Icon name="octicon-eye" />
            <span class="not-mobile" aria-hidden="true">
              {buttonLabel}
            </span>
            <span class="ui small label">{props.count}</span>
            <Icon name="octicon-triangle-down" size={14} class="dropdown icon" />
          </button>
          <div class="tippy-target">
            <a
              class={props.watching ? "item" : "item active"}
              role="menuitem"
              aria-label={repoActionsLocale.mode_participating}
              data-fetch-method="post"
              data-fetch-url={`${props.repoLink}/action/participate`}
              data-fetch-sync="$body #repo-header-watch"
            >
              <Icon name="octicon-check" size={16} class={props.watching ? "tw-invisible" : undefined} />
              <div>
                {repoActionsLocale.mode_participating}
                <div class="tw-text-12 tw-text-text-light-2">{repoActionsLocale.mode_participating_desc}</div>
              </div>
            </a>
            <a
              class={props.watching ? "item active" : "item"}
              role="menuitem"
              aria-label={repoActionsLocale.mode_all}
              data-fetch-method="post"
              data-fetch-url={`${props.repoLink}/action/watch`}
              data-fetch-sync="$body #repo-header-watch"
            >
              <Icon name="octicon-check" size={16} class={props.watching ? undefined : "tw-invisible"} />
              <div>
                {repoActionsLocale.mode_all}
                <div class="tw-text-12 tw-text-text-light-2">{repoActionsLocale.mode_all_desc}</div>
              </div>
            </a>
          </div>
        </>
      ) : (
        <a
          role="button"
          class="ui compact small basic button"
          href="/login"
          aria-label={repoActionsLocale.watch}
          data-tooltip-content={repoActionsLocale.watch_guest_user}
        >
          <Icon name="octicon-eye" />
          <span class="not-mobile" aria-hidden="true">
            {repoActionsLocale.watch}
          </span>
          <span class="ui small label">{props.count}</span>
        </a>
      )}
    </div>
  );
}

/**
 * The Star button (repo/header/star.tmpl verbatim): signed-in it POSTs
 * /action/{star|unstar} and the bundle's default `$this` sync swaps the
 * anchor with the POST's fragment response; anonymous it is upstream's login
 * link (data-tooltip-content = repo.star_guest_user). The icon flips
 * octicon-star → octicon-star-fill on the starring state (star.tmpl's Iif),
 * the label flips Star/Unstar, and the count is the maintained
 * `repositories.num_stars` column (.Repository.NumStars).
 */
export function RepoHeaderStar(props: { repoLink: string; count: number; viewer: Viewer; starring?: boolean }) {
  const signed = props.viewer.kind === "user";
  const buttonLabel = props.starring ? repoActionsLocale.unstar : repoActionsLocale.star;
  return (
    <a
      role="button"
      class="ui compact small basic button"
      aria-label={buttonLabel}
      {...(signed
        ? { "data-fetch-method": "post", "data-fetch-url": `${props.repoLink}/action/${props.starring ? "unstar" : "star"}` }
        : { href: "/login", "data-tooltip-content": repoActionsLocale.star_guest_user })}
    >
      <Icon name={props.starring ? "octicon-star-fill" : "octicon-star"} />
      <span class="not-mobile" aria-hidden="true">
        {buttonLabel}
      </span>
      <span class="ui small label">{props.count}</span>
    </a>
  );
}

/**
 * The Fork button (repo/header/fork.tmpl verbatim, reduced): the count is the
 * maintained `repositories.num_forks` column (.Repository.NumForks) and the
 * href walks upstream's ladder as far as the landed fork substrate reaches —
 *   - anonymous: the /login link + repo.fork_guest_user tooltip;
 *   - a viewer who ALREADY HOLDS a fork of this repo (fork.tmpl's
 *     `len $.UserAndOrgForks == 1` arm, ours the doer's own fork via
 *     findForkByOwner): a direct link onto that fork;
 *   - the repo's owner with no fork (fork.tmpl's `$canNotForkOwn` arm —
 *     CanUserForkBetweenOwners fails for the owner): the "#" link + the
 *     repo.fork_from_self tooltip;
 *   - everyone else: the landed /fork create form (upstream's
 *     `{{$.RepoLink}}/fork` default).
 *   The modal arm (`ShowForkModal` — forks under MULTIPLE owners, user AND
 *   orgs) is unrendered: the landed probe reads the doer's fork only and the
 *   fork-repo-modal needs the multi-owner fork enumeration (documented
 *   divergence, the one-fork reduction).
 */
export function RepoHeaderFork(props: {
  repoLink: string;
  count: number;
  viewer: Viewer;
  isOwnRepo?: boolean;
  viewerFork?: { ownerNamespace: string; slug: string } | null;
}) {
  let forkHref = `${props.repoLink}/fork`;
  let tooltip: string | undefined;
  if (props.viewer.kind === "anonymous") {
    forkHref = "/login";
    tooltip = repoActionsLocale.fork_guest_user;
  } else if (props.viewerFork !== undefined && props.viewerFork !== null) {
    forkHref = `/${props.viewerFork.ownerNamespace}/${props.viewerFork.slug}`;
  } else if (props.isOwnRepo === true && props.viewerFork === null) {
    forkHref = "#";
    tooltip = repoActionsLocale.fork_from_self;
  }
  return (
    <a
      role="button"
      class="ui compact small basic button"
      href={forkHref}
      {...(tooltip !== undefined ? { "data-tooltip-content": tooltip } : {})}
    >
      <Icon name="octicon-repo-forked" />
      <span class="not-mobile">{repoActionsLocale.fork}</span>
      <span class="ui small label">{props.count}</span>
    </a>
  );
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
          {/* Right side — the Watch/Star/Fork trio (header.tmpl:49-78's
              `{{if not (or .IsBeingCreated .IsBroken)}}` gate → the row's
              ready status; upstream's transfer/RSS arms ahead of the trio are
              unrendered — no transfer flow and the RSS feed arm needs the
              feed surface). Star renders unconditionally (upstream's only
              gate is the DisableStars setting we do not carry); fork keeps
              upstream's `{{if and (not .IsEmpty) (CanRead TypeCode)}}` empty
              arm — nothing to fork on an unborn HEAD (the code-read half is
              the §2.5 grant every resolved repo already satisfies). The
              trio's per-viewer state rides the ctx fields the repo-scoped
              prologue arms (viewerWatchsRepo/viewerStarsRepo/viewerForkOfRepo
              — anonymous viewers render the login-link variants, which is
              upstream's own anonymous posture). */}
          {repo.status === "ready" ? (
            <div class="flex-text-block tw-flex-wrap">
              <RepoHeaderWatch repoLink={repoLink} count={repo.numWatches} viewer={props.ctx.viewer} watching={props.ctx.viewerWatchsRepo} />
              <RepoHeaderStar repoLink={repoLink} count={repo.numStars} viewer={props.ctx.viewer} starring={props.ctx.viewerStarsRepo} />
              {!repo.isEmpty ? (
                <RepoHeaderFork
                  repoLink={repoLink}
                  count={repo.numForks}
                  viewer={props.ctx.viewer}
                  isOwnRepo={props.ctx.viewer.kind === "user" && props.ctx.viewer.id === repo.ownerId}
                  viewerFork={props.ctx.viewerForkOfRepo}
                />
              ) : null}
            </div>
          ) : null}
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
            {/* header.tmpl:130-139 — the Actions tab (SPEC-0012 M1c C1, the
                census C1's navbar arm), gated on the SAME unit condition as
                upstream (EnableActions ∧ CanRead(TypeActions) → the loaded
                repoHasActions toggle, the packages tab's reduction) plus the
                ¬IsEmptyRepo arm upstream carries verbatim (the empty repo
                404s the whole /actions group — MustBeNotEmpty). Upstream
                order: Actions sits between Pulls and Packages. The
                NumOpenActionRuns count label is the documented reduction
                (no maintained open-runs counter in D1 — the releases tab's
                precedent); the icon is the allowlist's octicon-play
                (upstream's own). */}
            {props.ctx.repoHasActions && !repo.isEmpty ? (
              <a class={activeTab === "actions" ? "active item" : "item"} href={`${repoLink}/actions`} data-shortcut-keys="g a">
                <Icon name="octicon-play" /> {tabLocale.repo_actions}
              </a>
            ) : null}
            {/* header.tmpl:140-144 — the packages tab (SPEC-0016 M2), gated
                on the landed unit-flag reduction (repo_settings.has_packages
                via the ctx repoHasPackages member — the projects tab's
                MustEnableRepoProjects reduction twin; upstream's
                CanRead(TypePackages)). The count label upstream never arms
                and no data-shortcut-keys ride it (the activity tab's
                precedent); the icon IS in the landed set
                (octicon-package). */}
            {props.ctx.repoHasPackages ? (
              <a class={activeTab === "packages" ? "active item" : "item"} href={`${repoLink}/packages`}>
                <Icon name="octicon-package" /> {tabLocale.repo_packages}
              </a>
            ) : null}
            {/* header.tmpl:146-154 — the projects tab (wave 45), gated on the
                SAME unit condition as upstream (MustEnableRepoProjects → the
                loaded repoHasProjects toggle). The count label is the
                documented reduction (the repositories table carries no
                project counters — the projects store's DEVIATION note; the
                releases tab's precedent), and the icon is the landed set's
                octicon-project-symlink (the org tab precedent — upstream's
                octicon-project is not in the generated set). */}
            {props.ctx.repoHasProjects ? (
              <a
                class={activeTab === "projects" ? "active item" : "item"}
                href={`${repoLink}/projects`}
                data-shortcut-keys="g b"
              >
                <Icon name="octicon-project-symlink" /> {tabLocale.repo_projects}
              </a>
            ) : null}
            {/* header.tmpl:157-161 — the releases tab (wave 20); the count
                label is the documented reduction (RepoTab note). */}
            <a class={activeTab === "releases" ? "active item" : "item"} href={`${repoLink}/releases`} data-shortcut-keys="g r">
              <Icon name="octicon-tag" /> {tabLocale.repo_releases}
            </a>
            {/* header.tmpl:162-166 — the wiki tab (the landed wiki pages
                family, pages/repo-wiki.tsx, unlocks it; upstream's exact
                shape: octicon-book, the g w shortcut, active on PageIsWiki
                which the family's five renders carry as activeTab="wiki").
                Rendered UNCONDITIONALLY — the ratified divergence (RepoTab
                note): upstream's CanRead(TypeWiki) unit gate reduces to
                "wiki enabled" only through the unit table this shell does
                not carry; the family's route-level hasWiki 404 shell keeps
                the disabled-wiki posture honest. */}
            <a class={activeTab === "wiki" ? "active item" : "item"} href={`${repoLink}/wiki`} data-shortcut-keys="g w">
              <Icon name="octicon-book" /> {tabLocale.repo_wiki}
            </a>
            {/* header.tmpl:177-181 — the activity/pulse tab (the R14 activity
                page unlocks it, pages/repo-activity.tsx). Upstream gates it on
                CanReadAny(PullRequests, Issues, Releases, Code) ∧
                ¬IsEmptyRepo — reading ANY of the four units admits the whole
                /activity group (web.go:1628-1646's RequireUnitReader), which
                every page this strip renders on already satisfies, so the
                landed strip keeps its unit-ungated shape (the releases tab's
                precedent). Upstream arms no data-shortcut-keys here, and the
                active state rides .PageIsActivity — the shell derives it from
                the activity page's discriminator class (BaseLayout's
                pageClass note below). */}
            <a class={activeTab === "activity" ? "active item" : "item"} href={`${repoLink}/activity`}>
              <Icon name="octicon-pulse" /> {tabLocale.repo_activity}
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
// The demo banner (SPEC-0014 §4.4, M2)
// ---------------------------------------------------------------------------

/** Chrome text for the demo banner — the component-local pattern (the
 *  tabLocale/createLocale precedent above; locale.ts is shared and not this
 *  wave's file). cf-gitea addition: upstream has NO in-tree demo banner at
 *  the pin — the practice is an ops convention (SPEC-0014 §1: Gitea's own
 *  demo at demo.gitea.com carries a "test instance, data is cleaned" notice
 *  injected outside the tree), so there is no upstream locale key to cite.
 *  The text is the approved parameter's ("data on this instance is
 *  periodically cleaned") with the minimal demo context prefix. */
const demoBannerLocale = {
  text: "This is a demo instance: data on this instance is periodically cleaned.",
  dismiss_aria: "Dismiss notice",
} as const;

/** The per-session dismissal key (sessionStorage — §4.4: the dismissal
 *  never round-trips the server: no endpoint, no D1, and it dies with the
 *  browser session, which is the "per session" semantic). */
export const DEMO_BANNER_STORAGE_KEY = "cf-gitea-demo-banner-dismissed";

/**
 * The dismissal script (§4.4 — "an inline script flips a sessionStorage key
 * and hides the node"). Static bytes, evaluated in place right after the
 * banner node (parser order, the ERROR_COLLECTOR/FRONTEND_INITED_CANARY
 * convention): already-dismissed sessions hide the node before first paint;
 * otherwise the close control gets click + keyboard (Enter/Space) arms that
 * set the key, then hide. Every storage touch is try/caught — private-mode
 * sessionStorage throws must never break the page (the dismissal simply
 * degrades to per-pageload). The node keeps rendering server-side on every
 * armed request; only the client hides it, so a fresh session sees the
 * banner again (dismissable-per-SESSION, not forever).
 */
export const DEMO_BANNER_DISMISS_SCRIPT = [
  `(function(){`,
  `var b=document.getElementById("demo-banner");`,
  `if(!b)return;`,
  `var hide=function(){b.style.display="none"};`,
  `try{if(sessionStorage.getItem("${DEMO_BANNER_STORAGE_KEY}")==="1"){hide();return}}catch(e){}`,
  `var x=document.getElementById("demo-banner-dismiss");`,
  `if(!x)return;`,
  `var dismiss=function(){try{sessionStorage.setItem("${DEMO_BANNER_STORAGE_KEY}","1")}catch(e){}hide()};`,
  `x.addEventListener("click",dismiss);`,
  `x.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();dismiss()}});`,
  `})();`,
].join("");

/**
 * The banner node (§4.4): "a fixed-height notice above the role="main" div".
 * The markup is upstream's flash-message bar at the pin — RenderFlashMessage
 * emits `<div class="ui {cls} message flash-message flash-{typ}">` wrapping a
 * `tw-text-center` line (gitea/modules/templates/util_render.go:263-292,
 * base/alert.tmpl), so the vendored bundle styles this notice with zero
 * custom CSS; the close control is Fomantic's message-close shape
 * (`i.close.icon`, a direct child of the message). `role="note"` + the
 * labelled, focusable close (upstream's `<i>` has no semantics of its own)
 * keep the a11y smoke honest.
 */
function DemoBanner() {
  return (
    <>
      <div class="ui info message flash-message flash-info" id="demo-banner" role="note">
        <i class="close icon" id="demo-banner-dismiss" role="button" tabindex={0} aria-label={demoBannerLocale.dismiss_aria} />
        <div class="tw-text-center">{demoBannerLocale.text}</div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DEMO_BANNER_DISMISS_SCRIPT }} />
    </>
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
  /** Upstream `ctx.PageData` — the page's per-page JS payload, serialized
   *  inside the head's `#global-window-config` JSON (context.go:53;
   *  context_template.go:162's `"pageData"` arm). Absent → null: the config
   *  JSON is byte-identical to every unarmed page's (the goldens pin it),
   *  and the escaping is serializeWindowConfig's (the `</script>`
   *  guarantee). */
  pageData?: Record<string, unknown>;
}) {
  const { ctx } = props;
  const pageTitle = ctx.repo ? `${ctx.repo.ownerNamespace}/${ctx.repo.slug}` : locale.app_name;
  const fullTitle = props.title === undefined ? pageTitle : `${props.title} - ${pageTitle}`;
  // The activity page's tab track — upstream arms the pulse tab on
  // `.PageIsActivity` (header.tmpl:178), template data this shell does not
  // carry; the activity page's discriminator class stands in instead. The
  // landed pages/repo-activity.tsx renders `page-content repository commits`
  // (activity.tmpl:2) with NO activeTab of its own, while the commits LIST
  // page shares that class and sets activeTab="commits" explicitly — so an
  // explicit tab always wins and the bare commits page-class resolves to the
  // activity page (the only page that renders it without one).
  const activeTab =
    props.activeTab ?? (props.pageClass === "repository commits" ? "activity" : undefined);
  return (
    <html lang="en" data-theme="gitea-light">
      <Head ctx={ctx} title={fullTitle} pageData={props.pageData} />
      <body>
        <div class="full height">
          <noscript>{locale.enable_javascript}</noscript>
          <Navbar viewer={ctx.viewer} activeNav={props.activeNav} notificationCount={ctx.notificationCount} />
          {/* SPEC-0014 §4.4 (M2): the demo banner rides the ctx flag — armed
              ONLY when the assembler set `demoMode` from the §2 gate. Gate
              off (absent/false — every default deployment) this branch emits
              NOTHING: no node, no script, byte-identical pages (the goldens
              pin it).
              MOUNTED at cada11c: the three ctx assemblers — ui/index.ts's
              resolveUiSession, session.ts's pageContext (/login),
              first-run.ts's pageContext (/install, /user/sign_up) — each
              carry `demoMode: demoModeEnabled(c.env)` in their ctx
              literal. */}
          {ctx.demoMode === true ? <DemoBanner /> : null}
          <div
            role="main"
            aria-label={props.title ?? pageTitle}
            class={props.pageClass === undefined ? "page-content" : `page-content ${props.pageClass}`}
            id={props.mainId}
            data-sequence-number={props.mainDataSequence}
          >
            {ctx.repo ? <RepoHeader ctx={ctx} activeTab={activeTab} /> : null}
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
