/**
 * Component-level shell tests (SPEC-0008 §5.1, U2 gate): render with
 * hono/jsx `renderToString` — no server, no bindings — and assert the exact
 * load-bearing DOM contract of §2.4.1. Asset URIs come from a synthetic
 * manifest fixture (same shape as manifest.test.ts; the real build output is
 * gitignored, so tests never depend on `pnpm build:assets`).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { assetURI, type UiManifest } from "./manifest";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "./ui-context";
import type { Viewer } from "./viewer";
import { WatchMode, type RepoWatch } from "../api/services/repo-watchers";
import { configI18n } from "./locale";
import {
  BaseLayout,
  DEMO_BANNER_DISMISS_SCRIPT,
  DEMO_BANNER_STORAGE_KEY,
  buildWindowConfig,
  renderPage,
  serializeWindowConfig,
} from "./shell";
import { NotFoundPage } from "./pages/not-found";
import { runA11y } from "./__tests__/a11y";

// --- fixtures ---------------------------------------------------------------

/** Synthetic manifest shaped like the real Vite output (deterministic). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": {
    file: "js/secondary.2222bbbb.js",
    css: ["css/secondary.3333cccc.css"],
  },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const assets = shellAssetsFromManifest(manifest);
const origin = "https://test.local";

function makeRepoRow(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "r_1",
    storageKey: "r_1",
    ownerNamespace: "octocat",
    ownerId: 1,
    slug: "hello",
    visibility: "public",
    defaultBranch: "main",
    isEmpty: false,
    isArchived: false,
    status: "ready",
    refsVersion: 1,
    backend: "self-hosted",
    numIssues: 0,
    numClosedIssues: 0,
    numPulls: 0,
    numClosedPulls: 0,
    numMilestones: 0,
    closeIssuesViaCommitInAnyBranch: false,
    createdAt: new Date(1700000000 * 1000),
    updatedAt: null,
    forkParent: null,
    isMirror: false,
    originalUrl: null,
    isTemplate: false,
    sizeKb: 0,
    numStars: 0,
    numWatches: 0,
    numForks: 0,
    ...overrides,
  };
}

const anonymousCtx: UiContext = { viewer: { kind: "anonymous" } satisfies Viewer, origin, assets };
const repoCtx: UiContext = { ...anonymousCtx, repo: makeRepoRow() };

function page(props: { ctx?: UiContext; title?: string; pageClass?: string } = {}): string {
  return renderPage(
    <BaseLayout ctx={props.ctx ?? anonymousCtx} title={props.title} pageClass={props.pageClass}>
      <p>page body</p>
    </BaseLayout>,
  );
}

function head(html: string): string {
  const start = html.indexOf("<head>");
  const end = html.indexOf("</head>");
  if (start < 0 || end < 0) throw new Error(`no head in:\n${html}`);
  return html.slice(start, end);
}

function configJson(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="global-window-config">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error(`no config tag in:\n${html}`);
  return JSON.parse(match[1] ?? "") as Record<string, unknown>;
}

// --- shell: html attrs, head order, assets -----------------------------------

describe("BaseLayout DOM contract (§2.4.1)", () => {
  it("emits <html lang=en data-theme=gitea-light> and resolves theme CSS via the manifest", () => {
    const html = page();
    expect(html.startsWith('<!DOCTYPE html><html lang="en" data-theme="gitea-light">')).toBe(true);
    expect(html.match(/id="global-window-config"/g)).toHaveLength(1);
    // head_style.tmpl order: index entry CSS (transitive via imports) then theme.
    expect(html).toContain('<link rel="stylesheet" href="/assets/css/index.1111aaaa.css"/>');
    expect(html).toContain('<link rel="stylesheet" href="/assets/css/secondary.3333cccc.css"/>');
    expect(html).toContain(
      `<link rel="stylesheet" href="${assetURI(manifest, "web_src/css/themes/theme-gitea-light.css")}"/>`,
    );
    // favicon per the spike §4.1 skeleton.
    expect(html).toContain('<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml"/>');
  });

  it("orders the head: css links, then error collector, config JSON, blocking iife", () => {
    const h = head(page());
    const indexCss = h.indexOf("/assets/css/index.1111aaaa.css");
    const themeCss = h.indexOf("/assets/css/theme-gitea-light.4444dddd.css");
    const collector = h.indexOf("_globalHandlerErrors");
    const config = h.indexOf('id="global-window-config"');
    const iife = h.indexOf("/assets/js/iife.abcd1234.js");
    for (const idx of [indexCss, themeCss, collector, config, iife]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(indexCss).toBeLessThan(themeCss);
    expect(themeCss).toBeLessThan(collector);
    expect(collector).toBeLessThan(config);
    expect(config).toBeLessThan(iife);
    // The iife is the last head element and is a blocking (non-module) script.
    expect(h.slice(iife)).toBe('/assets/js/iife.abcd1234.js"></script>');
    expect(h).not.toContain('type="module"');
  });

  it("closes the body with the index module script, then the frontendInited canary", () => {
    const html = page();
    const footer = html.indexOf("<footer");
    const indexModule = html.indexOf('<script type="module" src="/assets/js/index.deadbeef.js"></script>');
    const canary = html.indexOf("frontendInited");
    expect(footer).toBeGreaterThanOrEqual(0);
    expect(footer).toBeLessThan(indexModule);
    expect(indexModule).toBeLessThan(canary);
    // Upstream footer.tmpl:16 canary, verbatim, evaluating AFTER the module
    // (module scripts execute in document order).
    expect(html.endsWith(
      '</script><script type="module">if (!window.config?.frontendInited && window.config?.runModeIsProd) ' +
        'alert("Frontend is not initialized, check console errors or asset files.");</script></body></html>',
    )).toBe(true);
  });
});

// --- window.config -----------------------------------------------------------

describe("window.config (§2.4.1)", () => {
  it("serializes with the exact contract key set, recursively", () => {
    const config = configJson(page());
    expect(Object.keys(config).sort()).toEqual(
      [
        "appUrl",
        "appSubUrl",
        "assetUrlPrefix",
        "runModeIsProd",
        "customEmojis",
        "pageData",
        "mermaidMaxSourceCharacters",
        "sharedWorkerUri",
        "notificationSettings",
        "i18n",
      ].sort(),
    );
    expect(config.appUrl).toBe("https://test.local/");
    expect(config.appSubUrl).toBe("");
    expect(config.assetUrlPrefix).toBe("/assets");
    expect(config.runModeIsProd).toBe(true);
    expect(config.customEmojis).toEqual({});
    expect(config.mermaidMaxSourceCharacters).toBe(50000);
  });

  it("carries pageData null, the notificationSettings triple, and the sharedWorkerUri from the manifest", () => {
    const config = configJson(page());
    // The absent arm (every page that passes no pageData): upstream's Go nil
    // marshal — `"pageData":null` raw in the config JSON.
    expect(config.pageData).toBeNull();
    expect(page()).toContain('"pageData":null');
    expect(Object.keys(config.notificationSettings as object).sort()).toEqual([
      "MaxTimeout",
      "MinTimeout",
      "TimeoutStep",
    ]);
    expect(config.notificationSettings).toEqual({ MinTimeout: 10000, TimeoutStep: 10000, MaxTimeout: 60000 });
    expect(config.sharedWorkerUri).toBe(assetURI(manifest, "web_src/js/user-events.sharedworker.ts"));
    expect(config.sharedWorkerUri).toBe("/assets/js/user-events.5555eeee.js");
  });

  it("threads a per-page pageData payload through the head config JSON (upstream ctx.PageData — the chart pages' repoLink channel)", () => {
    // BaseLayout's pageData prop rides WindowConfig's `"pageData"` arm
    // (context_template.go:162) — the R15 issue-2 channel that replaced the
    // page-body inline `window.config.pageData = …` assignment.
    const armed = renderPage(
      <BaseLayout ctx={anonymousCtx} pageData={{ repoLink: "/octocat/hello" }}>
        <p>armed</p>
      </BaseLayout>,
    );
    expect(configJson(armed).pageData).toEqual({ repoLink: "/octocat/hello" });
    // The raw emission is upstream's Go-marshal shape: the payload object in
    // the config JSON, exactly where null served on the unarmed page.
    expect(armed).toContain('"pageData":{"repoLink":"/octocat/hello"}');
    expect(armed).not.toContain('"pageData":null');
    expect(armed).not.toContain("window.config.pageData ="); // no body script — the JSON is the only channel
    // The payload rides serializeWindowConfig's escaping — a hostile value
    // cannot close the config tag (the same guarantee the retired inline
    // serializer gave), and it round-trips intact for the bundle's bootstrap
    // parse (web_src/js/bootstrap.ts:5).
    const hostile = renderPage(
      <BaseLayout ctx={anonymousCtx} pageData={{ repoLink: "/a</script>b&c<d>e" }}>
        <p>hostile</p>
      </BaseLayout>,
    );
    expect(hostile.match(/<\/script>/g)).toHaveLength(5); // collector, config, iife, index module, canary only
    expect(hostile).toContain('"pageData":{"repoLink":"/a\\u003c/script\\u003eb\\u0026c\\u003cd\\u003ee"}');
    expect(configJson(hostile).pageData).toEqual({ repoLink: "/a</script>b&c<d>e" });
  });

  it("carries exactly the 7 client i18n keys", () => {
    const i18n = configJson(page()).i18n as Record<string, string>;
    expect(Object.keys(i18n).sort()).toEqual(
      ["error_occurred", "remove_label_str", "modal_confirm", "modal_cancel", "more_items", "copy_success", "copy_error"].sort(),
    );
    expect(i18n).toEqual({ ...configI18n });
  });

  it("escapes <, >, & so a hostile value cannot close the config tag", () => {
    const hostile = buildWindowConfig(anonymousCtx);
    hostile.appUrl = "https://evil</script>.example/?a=1&b=<2>";
    const serialized = serializeWindowConfig(hostile);
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c");
    expect(serialized).toContain("\\u003e");
    expect(serialized).toContain("\\u0026");
    const round = JSON.parse(serialized) as typeof hostile;
    expect(round.appUrl).toBe(hostile.appUrl);
  });

  it("keeps the document's script structure intact when the repo name contains </script>", () => {
    const hostileCtx: UiContext = { ...repoCtx, repo: makeRepoRow({ slug: "evil</script>repo" }) };
    const html = renderPage(<NotFoundPage ctx={hostileCtx} />);
    // Exactly the five legitimate script closers (collector, config, iife,
    // index module, canary) — the injected "</script>" never lands raw.
    expect(html.match(/<\/script>/g)).toHaveLength(5);
    // The config tag still parses and holds the contract shape.
    const config = configJson(html);
    expect(Object.keys(config)).toHaveLength(10);
    // JSX auto-escaping carries the hostile name in <title> and the header.
    expect(html).toContain("&lt;/script&gt;");
    expect(html).not.toContain("evil</script>");
  });
});

// --- navbar / repo header / tab strip / footer -------------------------------

describe("Navbar", () => {
  it("renders the anonymous navbar landmark with the Sign in link and no other dead links", () => {
    const html = page();
    expect(html).toContain('<nav id="navbar" aria-label="Navigation Bar">');
    expect(html).toContain('id="navbar-logo"');
    expect(html).toContain('<img width="30" height="30" src="/assets/img/logo.svg"');
    expect(html).toContain('href="https://docs.gitea.com"');
    // SPEC-0010 §2.5: the anonymous chrome gains exactly the Sign in link
    // (the /login route exists now); wave 9: the Explore item anchors the
    // live /explore/repos page for BOTH viewer kinds (head_navbar.tmpl:31) —
    // the logo's aria-label stays "Home" anonymous (head_navbar.tmpl:2).
    expect(html).toContain('<a class="item" href="/login">Sign In</a>');
    expect(html).toContain('<a class="item" href="/explore/repos">Explore</a>');
    expect(html).toContain('id="navbar-logo" href="/" aria-label="Home"');
    expect(html).not.toContain("/user/login");
    // No signed-in chrome leaks for an anonymous viewer.
    expect(html).not.toContain('id="navbar-username"');
    expect(html).not.toContain('action="/logout"');
  });

  it("renders the signed-in chrome reduced to the create links + username + sign-out POST button (SPEC-0010 §2.5)", () => {
    const viewer: Viewer = { kind: "user", id: 7, username: "octocat", isAdmin: false };
    const html = renderPage(
      <BaseLayout ctx={{ ...anonymousCtx, viewer }}>
        <p>page body</p>
      </BaseLayout>,
    );
    expect(html).toContain('<a class="item" id="navbar-username" href="/octocat">octocat</a>');
    // POST-only logout (§2.7) — a plain form button, no GET logout link.
    expect(html).toContain('<form class="item" method="post" action="/logout">');
    expect(html).toContain(">Sign Out</button>");
    expect(html).not.toContain('href="/logout"');
    // No Sign in link, no dead upstream chrome (bell-less for a zero count,
    // avatar-less). Wave 19: the `+` dropdown renders as its two landed
    // targets (the creation pages unlock it — the Navbar comment).
    expect(html).not.toContain('href="/login"');
    expect(html).toContain('<a class="item" href="/repo/create" data-tooltip-content="New Repository" aria-label="New Repository">');
    expect(html).toContain('<a class="item" href="/org/create" data-tooltip-content="New Organization" aria-label="New Organization">');
    expect(html).toContain("octicon-plus");
    // Wave 9: the logo's aria-label is the dashboard label signed in
    // (head_navbar.tmpl:2) and the Explore item renders untracked by default.
    expect(html).toContain('id="navbar-logo" href="/" aria-label="Dashboard"');
    expect(html).toContain('<a class="item" href="/explore/repos">Explore</a>');
    // The active track renders only on the explore pages (BaseLayout's
    // activeNav passthrough — upstream PageIsExplore).
    const exploreHtml = renderPage(
      <BaseLayout ctx={{ ...anonymousCtx, viewer }} activeNav="explore">
        <p>explore</p>
      </BaseLayout>,
    );
    expect(exploreHtml).toContain('<a class="active item" href="/explore/repos">Explore</a>');
  });
});

describe("RepoHeader tab strip", () => {
  function tabStrip(html: string): string {
    const start = html.indexOf('<overflow-menu class="ui secondary pointing menu">');
    const end = html.indexOf("</overflow-menu>");
    if (start < 0 || end < 0) throw new Error(`no tab strip in:\n${html}`);
    return html.slice(start, end);
  }

  it("renders exactly the Code, Issues, Pulls, Releases, Wiki, Activity, Commits tabs, in order, with active tracking", () => {
    const strip = tabStrip(page({ ctx: repoCtx }));
    expect(strip.match(/<a class="(?:active )?item"/g)).toHaveLength(7);
    expect(strip).toContain('<a class="active item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(strip).toContain('<a class="item" href="/octocat/hello/issues" data-shortcut-keys="g i">');
    expect(strip).toContain('<a class="item" href="/octocat/hello/pulls" data-shortcut-keys="g p">');
    // Wave 20: the Releases tab (header.tmpl:157's shape) resolves — it was
    // the dead-tab 404 this test previously refused to render.
    expect(strip).toContain('<a class="item" href="/octocat/hello/releases" data-shortcut-keys="g r">');
    // The wiki tab (header.tmpl:162-166's shape): upstream's g w shortcut
    // and octicon-book glyph, rendered on the DEFAULT posture — repoCtx
    // carries no repoHasWiki (absent = not loaded) and the wiki unit ships
    // enabled (unit.DefaultRepoUnits, models/unit/unit.go:68-77; the store
    // default has_wiki=1), so absent renders (the `!== false` polarity —
    // shell.tsx's RepoTab note). The explicit-false hide arm is the
    // dedicated gate test below.
    expect(strip).toContain('<a class="item" href="/octocat/hello/wiki" data-shortcut-keys="g w">');
    // The activity/pulse tab (header.tmpl:177's shape) — unlocked by the
    // landed /activity page family, no data-shortcut-keys (upstream arms
    // none on it, unlike its strip neighbors).
    expect(strip).toContain('<a class="item" href="/octocat/hello/activity">');
    expect(strip).toContain('<a class="item" href="/octocat/hello/commits">');
    // Inline octicon SVGs, upstream {{svg}} shape. The Issues tab carries its
    // octicon-issue-opened (header.tmpl:105 — the webui-parity Top-10 #10 fix;
    // the glyph degraded to text while the Icon was single-path, retired with
    // the wave-4 multi-path batch that granted it).
    expect(strip).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="svg octicon-code"');
    expect(strip).toContain('class="svg octicon-issue-opened"');
    expect(strip).toContain('class="svg octicon-git-pull-request"');
    expect(strip).toContain('class="svg octicon-tag"');
    expect(strip).toContain('class="svg octicon-book"');
    expect(strip).toContain('class="svg octicon-pulse"');
    expect(strip).toContain('class="svg octicon-history"');
    expect(strip.indexOf("> Code</a>")).toBeGreaterThan(0);
    expect(strip.indexOf("> Issues</a>")).toBeGreaterThan(strip.indexOf("> Code</a>"));
    expect(strip.indexOf("> Pull Requests</a>")).toBeGreaterThan(strip.indexOf("> Issues</a>"));
    expect(strip.indexOf("> Releases</a>")).toBeGreaterThan(strip.indexOf("> Pull Requests</a>"));
    // Upstream strip order: Wiki sits between Releases and Activity
    // (header.tmpl:162-166).
    expect(strip.indexOf("> Wiki</a>")).toBeGreaterThan(strip.indexOf("> Releases</a>"));
    expect(strip.indexOf("> Activity</a>")).toBeGreaterThan(strip.indexOf("> Wiki</a>"));
    expect(strip).toContain("> Commits</a>");
    expect(strip.indexOf("> Commits</a>")).toBeGreaterThan(strip.indexOf("> Activity</a>"));
    // The admin Settings tab (header.tmpl:184-190): anonymous viewers are
    // refused (`.Permission.IsAdmin`'s static arms — site admin + the
    // case-folded owner — both need a user viewer); the tab's dead-link
    // refusal predates the settings pages family's landing.
    expect(strip).not.toContain("Settings");

    // The signed-in OWNER sees the admin Settings tab after the
    // `item-flex-space` spacer (header.tmpl:184-190's shape: octicon-tools +
    // "repo.settings"), and a signed-in NON-admin stranger does not.
    const ownerViewer: Viewer = { kind: "user", id: 1, username: "octocat", isAdmin: false };
    const ownerStrip = tabStrip(page({ ctx: { ...repoCtx, viewer: ownerViewer } }));
    expect(ownerStrip).toContain('<span class="item-flex-space"></span>');
    expect(ownerStrip).toContain('<a class="item" href="/octocat/hello/settings">');
    expect(ownerStrip).toContain('class="svg octicon-tools"');
    expect(ownerStrip.indexOf("> Settings</a>")).toBeGreaterThan(ownerStrip.indexOf("> Commits</a>"));
    const strangerViewer: Viewer = { kind: "user", id: 42, username: "stranger", isAdmin: false };
    expect(tabStrip(page({ ctx: { ...repoCtx, viewer: strangerViewer } }))).not.toContain("Settings");
    // The site-admin arm admits a non-owner too (the predicate's static
    // is_admin arm).
    const adminViewer: Viewer = { kind: "user", id: 42, username: "stranger", isAdmin: true };
    expect(tabStrip(page({ ctx: { ...repoCtx, viewer: adminViewer } }))).toContain('href="/octocat/hello/settings"');

    // The active arm rides the settings pages' shared `repository settings…`
    // pageClass (BaseLayout's discriminator — upstream .PageIsRepoSettings,
    // header.tmpl:187): an explicit activeTab still wins.
    const stripOnSettings = tabStrip(
      renderPage(
        <BaseLayout ctx={{ ...repoCtx, viewer: ownerViewer }} pageClass="repository settings">
          <p>settings</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnSettings).toContain('<a class="active item" href="/octocat/hello/settings">');
    expect(stripOnSettings).not.toContain('<a class="active item" href="/octocat/hello" data-shortcut-keys="g c">');

    const stripOnIssues = tabStrip(
      renderPage(
        <BaseLayout ctx={repoCtx} title="Issues" activeTab="issues">
          <p>issues</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnIssues).toContain('<a class="item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(stripOnIssues).toContain('<a class="active item" href="/octocat/hello/issues" data-shortcut-keys="g i">');

    const stripOnCommits = tabStrip(
      renderPage(
        <BaseLayout ctx={repoCtx} title="Commits" activeTab="commits">
          <p>commits</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnCommits).toContain('<a class="item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(stripOnCommits).toContain('<a class="active item" href="/octocat/hello/commits">');
    // The commits list shares the activity page's discriminator class but
    // wins via its explicit activeTab — no double-active pulse tab.
    expect(stripOnCommits).not.toContain('<a class="active item" href="/octocat/hello/activity">');

    // The wiki pages arm the tab through activeTab="wiki" (upstream arms
    // .PageIsWiki on the whole /wiki group, web.go:1623).
    const stripOnWiki = tabStrip(
      renderPage(
        <BaseLayout ctx={repoCtx} title="Home" activeTab="wiki">
          <p>wiki</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnWiki).toContain('<a class="item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(stripOnWiki).toContain('<a class="active item" href="/octocat/hello/wiki" data-shortcut-keys="g w">');

    // The projects tab carries upstream's octicon-project (header.tmpl:150 —
    // the webui-parity Top-10 #10 fix; the symlink glyph was the allowlist's
    // stopgap and stays on the org/projects PAGES, project.go:161-166's own
    // choice). No golden arms the tab (the fixture repos' unit is off), so
    // the suite pins it here.
    const stripOnProjects = tabStrip(
      renderPage(
        <BaseLayout ctx={{ ...repoCtx, repoHasProjects: true }} title="Projects">
          <p>projects</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnProjects).toContain('class="svg octicon-project"');
    expect(stripOnProjects).not.toContain("octicon-project-symlink");
    expect(stripOnProjects).toContain('<a class="item" href="/octocat/hello/projects" data-shortcut-keys="g b">');

    // The activity page renders `page-content repository commits` (upstream
    // activity.tmpl:2) WITHOUT an explicit activeTab — upstream tracks its
    // pulse tab through .PageIsActivity (header.tmpl:178), which the shell
    // derives from that shared discriminator (BaseLayout's activeTab note):
    // the pulse tab goes active, the commits tab stays inert.
    const stripOnActivity = tabStrip(
      renderPage(
        <BaseLayout ctx={repoCtx} title="Activity" pageClass="repository commits">
          <p>activity</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnActivity).toContain('<a class="active item" href="/octocat/hello/activity">');
    expect(stripOnActivity).toContain('<a class="item" href="/octocat/hello/commits">');
    expect(stripOnActivity).not.toContain('<a class="active item" href="/octocat/hello/commits">');
  });

  it("gates the wiki tab on the loaded repoHasWiki unit toggle (header.tmpl:165's CanRead(TypeWiki))", () => {
    // The v1.3.2 residuals P2-4 gate: the strip renders the tab with the
    // ctx flag ABSENT (the not-loaded/pre-wiring window — repoCtx above)
    // or EXPLICITLY true, and hides it on the loaded `false` — the state
    // whose /wiki routes the wikiPrologue 404-shells anyway (MustEnableWiki,
    // web.go:1614), so the disabled-wiki strip stops advertising the dead
    // tab. Upstream arms the same condition at header.tmpl:165.
    const stripAbsent = tabStrip(page({ ctx: repoCtx }));
    expect(stripAbsent).toContain('href="/octocat/hello/wiki"');
    const stripEnabled = tabStrip(page({ ctx: { ...repoCtx, repoHasWiki: true } }));
    expect(stripEnabled).toContain('<a class="item" href="/octocat/hello/wiki" data-shortcut-keys="g w">');
    const stripDisabled = tabStrip(page({ ctx: { ...repoCtx, repoHasWiki: false } }));
    expect(stripDisabled).not.toContain('href="/octocat/hello/wiki"');
    expect(stripDisabled).not.toContain("octicon-book");
    // The hidden tab does not disturb the strip's other members (the count
    // folds from 7 to 6 — the sibling toggles' shared shape).
    expect(stripDisabled.match(/<a class="(?:active )?item"/g)).toHaveLength(6);
  });

  it("shows the open-issue/pull count labels from the D1 counters (upstream NumOpenIssues shape)", () => {
    // D1 keeps lifetime + closed counters; the open count is the difference.
    const counted = makeRepoRow({ numIssues: 5, numClosedIssues: 2, numPulls: 3, numClosedPulls: 0 });
    const strip = tabStrip(renderPage(
      <BaseLayout ctx={{ ...anonymousCtx, repo: counted }}>
        <p>counts</p>
      </BaseLayout>,
    ));
    expect(strip).toContain('> Issues<span class="ui small label">3</span></a>');
    expect(strip).toContain('> Pull Requests<span class="ui small label">3</span></a>');
    // Zero open pulls render no label (upstream `{{if .Repository.NumOpenPulls}}`).
    const zeroed = tabStrip(page({ ctx: repoCtx }));
    expect(zeroed).not.toContain('class="ui small label"');
  });

  it("renders the repo header shell and closes with .ui.tabs.divider", () => {
    const html = page({ ctx: repoCtx });
    expect(html).toContain('<div class="secondary-nav"><div class="ui container"><div class="repo-header flex-left-right">');
    expect(html).toContain('class="svg octicon-repo"');
    expect(html).toContain('<span class="ui basic orange label">Public Access</span>');
    // The cf-gitea "Created <date>" secondary-info is RETIRED (the webui-parity
    // Top-10 #10 sync: the line had no upstream analog at any pin —
    // header.tmpl renders no created stamp under the title row).
    expect(html).not.toContain("Created <relative-time");
    expect(html).not.toContain('class="secondary-info"');
    expect(html).toContain('<div class="ui tabs divider"></div>');
  });
});

// --- the repo header action trio (usability B-4) -------------------------------

/**
 * The Watch/Star/Fork right side (header.tmpl:49-78 + :93 → repo/header/
 * {watch,star,fork}.tmpl + watch_options_modal.tmpl at the pin). Upstream
 * renders the trio for EVERY viewer — anonymous viewers get the login-link
 * variants — so the anon arm is the default render, and the signed-in arms
 * carry the fetch-action wiring the official bundle drives. The per-viewer
 * state rides the ctx fields the repo-scoped prologue arms (ui-context.ts's
 * trio doc); the watch menu renders the FULL four-mode state over
 * viewerRepoWatch (absent = the GetWatch no-row dummy — mode None).
 */
describe("RepoHeader action trio (usability B-4)", () => {
  const userViewer: Viewer = { kind: "user", id: 42, username: "octocat", isAdmin: false };

  /** GetWatch's plain-watching row (watchRepoByMode's Normal + reset
   *  includes) — the fixture the watching arms render from. */
  const NORMAL_WATCH: RepoWatch = {
    repoId: "r",
    userId: 42,
    mode: WatchMode.Normal,
    watchPullRequests: true,
    watchIssues: true,
    watchReleases: true,
  };

  function repoPage(ctx: UiContext): string {
    return renderPage(
      <BaseLayout ctx={ctx}>
        <p>page body</p>
      </BaseLayout>,
    );
  }

  it("renders the anonymous login-link variants with the D1 counts, and no write arms", () => {
    const html = repoPage({ ...anonymousCtx, repo: makeRepoRow({ numStars: 3, numWatches: 5, numForks: 7 }) });
    // Watch: the login anchor inside div#repo-header-watch (watch.tmpl's
    // else arm — aria-label, tooltip, eye glyph, count).
    expect(html).toContain(
      '<div id="repo-header-watch" class="flex-text-block"><a role="button" class="ui compact small basic button" href="/login" aria-label="Watch" data-tooltip-content="Sign in to watch this repository.">',
    );
    expect(html).toContain('class="svg octicon-eye"');
    expect(html).toContain('<span class="not-mobile" aria-hidden="true">Watch</span><span class="ui small label">5</span>');
    // Star: the login anchor, the hollow glyph, the count.
    expect(html).toContain(
      '<a role="button" class="ui compact small basic button" aria-label="Star" href="/login" data-tooltip-content="Sign in to star this repository.">',
    );
    expect(html).toContain('class="svg octicon-star"');
    expect(html).toContain('<span class="not-mobile" aria-hidden="true">Star</span><span class="ui small label">3</span>');
    // Fork: the anonymous login link (fork.tmpl's guest arm) with its
    // tooltip, the glyph, the count.
    expect(html).toContain(
      '<a role="button" class="ui compact small basic button" href="/login" data-tooltip-content="Sign in to fork this repository.">',
    );
    expect(html).toContain('class="svg octicon-repo-forked"');
    expect(html).toContain('<span class="not-mobile">Fork</span><span class="ui small label">7</span>');
    // No session, no write surface: no fetch-action wiring, no dropdown, no
    // watch-options modal (header.tmpl:93's IsSigned gate).
    expect(html).not.toContain("data-fetch-url");
    expect(html).not.toContain("initRepoWatchMenu");
    expect(html).not.toContain("repo-watch-options-modal");
    // The login links use the landed /login route (the navbar's convention),
    // never upstream's /user/login literal.
    expect(html).not.toContain("/user/login");
  });

  it("hides the fork on an empty repo (upstream's `and (not .IsEmpty) CanReadCode` gate) and the whole trio off-ready rows", () => {
    const emptyHtml = repoPage({ ...anonymousCtx, repo: makeRepoRow({ isEmpty: true }) });
    expect(emptyHtml).not.toContain("octicon-repo-forked");
    expect(emptyHtml).toContain("repo-header-watch"); // watch/star still render
    // Upstream gates the whole right side on `not (or .IsBeingCreated .IsBroken)`
    // — the row's non-ready statuses.
    const creatingHtml = repoPage({ ...anonymousCtx, repo: makeRepoRow({ status: "creating" }) });
    expect(creatingHtml).not.toContain("repo-header-watch");
    expect(creatingHtml).not.toContain("octicon-star");
  });

  it("signed-in viewers get the dropdown posture; the arms and glyphs flip with the ctx state", () => {
    const watchingHtml = repoPage({
      ...anonymousCtx,
      viewer: userViewer,
      repo: makeRepoRow({ numWatches: 2, numStars: 1 }),
      viewerRepoWatch: NORMAL_WATCH,
      viewerStarsRepo: true,
    });
    // The watch button: the dropdown posture + init hook + "Watching".
    expect(watchingHtml).toContain(
      '<button type="button" class="ui dropdown custom compact small basic button" data-global-init="initRepoWatchMenu" aria-label="Watching">',
    );
    expect(watchingHtml).toContain('<span class="not-mobile" aria-hidden="true">Watching</span><span class="ui small label">2</span>');
    // The tippy menu: the FULL four-mode arm set (watch.tmpl:15-41), each
    // POSTing with the #repo-header-watch sync; "All activity" carries the
    // check (SelectedMode "all" — Normal + every include true).
    expect(watchingHtml).toContain('<div class="tippy-target">');
    expect(watchingHtml).toContain('<a class="item" role="menuitem" aria-label="Participating and mentions" data-fetch-method="post" data-fetch-url="/octocat/hello/action/participate" data-fetch-sync="$body #repo-header-watch">');
    expect(watchingHtml).toContain('<a class="item active" role="menuitem" aria-label="All activity" data-fetch-method="post" data-fetch-url="/octocat/hello/action/watch" data-fetch-sync="$body #repo-header-watch">');
    expect(watchingHtml).toContain('<a class="item" role="menuitem" aria-label="Ignore" data-fetch-method="post" data-fetch-url="/octocat/hello/action/ignore" data-fetch-sync="$body #repo-header-watch">');
    expect((watchingHtml.match(/class="svg octicon-check"/g) ?? []).length).toBe(2); // one menu check + the modal's confirm button
    expect((watchingHtml.match(/class="svg octicon-check tw-invisible"/g) ?? []).length).toBe(3);
    // The custom item: the show-modal wiring — the dialog selector, the form
    // URL (the dotted attribute, common-button.ts's action setter), the
    // include fills ("true" — every include on).
    expect(watchingHtml).toContain('<a class="item show-modal" role="menuitem" aria-label="Custom" data-modal="#repo-watch-options-modal"');
    expect(watchingHtml).toContain('data-modal-form.url="/octocat/hello/action/watch/options"');
    expect(watchingHtml).toContain('data-modal-issues="true" data-modal-pull_requests="true" data-modal-releases="true"');
    // The watch_options_modal rides the header's close (header.tmpl:93),
    // signed viewers only.
    expect(watchingHtml).toContain('<dialog class="modal-dialog" id="repo-watch-options-modal">');
    expect(watchingHtml).toContain('<form class="ui form form-fetch-action" method="post">');
    expect(watchingHtml).toContain('<input name="issues" type="checkbox"/>');
    expect(watchingHtml).toContain('<input name="pull_requests" type="checkbox"/>');
    expect(watchingHtml).toContain('<input name="releases" type="checkbox"/>');
    // The star anchor: POST arms + the filled glyph + "Unstar".
    expect(watchingHtml).toContain(
      '<a role="button" class="ui compact small basic button" aria-label="Unstar" data-fetch-method="post" data-fetch-url="/octocat/hello/action/unstar">',
    );
    expect(watchingHtml).toContain('class="svg octicon-star-fill"');
    expect(watchingHtml).toContain('<span class="not-mobile" aria-hidden="true">Unstar</span><span class="ui small label">1</span>');

    // The not-watching / not-starring defaults: "Watch" button, participating
    // item checked (the GetWatch no-row dummy — viewerRepoWatch absent),
    // hollow star POSTing /action/star.
    const plainHtml = repoPage({ ...anonymousCtx, viewer: userViewer, repo: makeRepoRow({ numWatches: 0, numStars: 0 }) });
    expect(plainHtml).toContain('data-global-init="initRepoWatchMenu" aria-label="Watch">');
    expect(plainHtml).toContain('<a class="item active" role="menuitem" aria-label="Participating and mentions"');
    expect(plainHtml).toContain('<a class="item" role="menuitem" aria-label="All activity"');
    expect(plainHtml).toContain('<a class="item show-modal" role="menuitem" aria-label="Custom"');
    expect(plainHtml).toContain('data-modal-issues="true" data-modal-pull_requests="true" data-modal-releases="true"');
    expect(plainHtml).toContain(
      '<a role="button" class="ui compact small basic button" aria-label="Star" data-fetch-method="post" data-fetch-url="/octocat/hello/action/star">',
    );
    expect(plainHtml).toContain('class="svg octicon-star"');
  });

  it("renders the ignoring posture (the eye-closed button + the checked Ignore item) and the custom mode's checked item + include fills", () => {
    // The persisted Dont row (the Auto-unwatch landing or the menu's Ignore
    // POST): button text "Ignoring", the eye-closed glyph, Ignore checked —
    // watch.tmpl:3's Iif + :10's glyph Iif + the isIgnoring active arm.
    const ignoringHtml = repoPage({
      ...anonymousCtx,
      viewer: userViewer,
      repo: makeRepoRow({ numWatches: 4 }),
      viewerRepoWatch: {
        repoId: "r",
        userId: 42,
        mode: WatchMode.Dont,
        watchPullRequests: false,
        watchIssues: false,
        watchReleases: false,
      },
    });
    expect(ignoringHtml).toContain(
      '<button type="button" class="ui dropdown custom compact small basic button" data-global-init="initRepoWatchMenu" aria-label="Ignoring">',
    );
    expect(ignoringHtml).toContain('class="svg octicon-eye-closed"');
    expect(ignoringHtml).toContain('<span class="not-mobile" aria-hidden="true">Ignoring</span><span class="ui small label">4</span>');
    expect(ignoringHtml).toContain('<a class="item active" role="menuitem" aria-label="Ignore" data-fetch-method="post" data-fetch-url="/octocat/hello/action/ignore" data-fetch-sync="$body #repo-header-watch">');
    expect(ignoringHtml).toContain('<a class="item" role="menuitem" aria-label="Participating and mentions" data-fetch-method="post"');

    // A Custom row with a partial event selection (SelectedMode's fallthrough
    // — not watching-all, watching-any): the Custom item checks AND the
    // modal fills carry the picked set (data-modal-issues="false" — the
    // common-button.ts checked = value==='true' contract).
    const customHtml = repoPage({
      ...anonymousCtx,
      viewer: userViewer,
      repo: makeRepoRow({ numWatches: 1 }),
      viewerRepoWatch: {
        repoId: "r",
        userId: 42,
        mode: WatchMode.Custom,
        watchPullRequests: true,
        watchIssues: false,
        watchReleases: false,
      },
    });
    expect(customHtml).toContain('data-global-init="initRepoWatchMenu" aria-label="Watching">');
    expect(customHtml).toContain('<a class="item active show-modal" role="menuitem" aria-label="Custom" data-modal="#repo-watch-options-modal"');
    expect(customHtml).toContain('data-modal-issues="false" data-modal-pull_requests="true" data-modal-releases="false"');
    // A Custom row with NO event selected still reads "participating"
    // (SelectedMode's !IsWatchingAny arm) — the state watch.go:50-54's
    // "clearing every event leaves the participating state" comment names.
    const customEmptyHtml = repoPage({
      ...anonymousCtx,
      viewer: userViewer,
      repo: makeRepoRow({ numWatches: 1 }),
      viewerRepoWatch: {
        repoId: "r",
        userId: 42,
        mode: WatchMode.Custom,
        watchPullRequests: false,
        watchIssues: false,
        watchReleases: false,
      },
    });
    expect(customEmptyHtml).toContain('<a class="item active" role="menuitem" aria-label="Participating and mentions"');
    expect(customEmptyHtml).toContain('<a class="item show-modal" role="menuitem" aria-label="Custom"');
  });

  it("the fork href walks upstream's ladder: existing fork → it; own repo without a fork → the '#' tooltip arm", () => {
    // The doer's own repo, no fork (the probed-null arm): fork.tmpl's
    // $canNotForkOwn posture — "#" + repo.fork_from_self.
    const ownHtml = repoPage({
      ...anonymousCtx,
      viewer: { kind: "user", id: 1, username: "octocat", isAdmin: false },
      repo: makeRepoRow({ ownerId: 1, numForks: 0 }),
      viewerForkOfRepo: null,
    });
    expect(ownHtml).toContain('<a role="button" class="ui compact small basic button" href="#" data-tooltip-content="You cannot fork a repository you own.">');
    // An existing fork (fork.tmpl's `len $.UserAndOrgForks == 1` arm): the
    // direct link, no tooltip.
    const forkedHtml = repoPage({
      ...anonymousCtx,
      viewer: { kind: "user", id: 9, username: "pal", isAdmin: false },
      repo: makeRepoRow({ ownerId: 1 }),
      viewerForkOfRepo: { ownerNamespace: "pal", slug: "hello" },
    });
    expect(forkedHtml).toContain('<a role="button" class="ui compact small basic button" href="/pal/hello">');
    // An unprobed signed-in viewer (the loader not armed — the degraded
    // interim) falls through to the create-form href.
    const unprobedHtml = repoPage({
      ...anonymousCtx,
      viewer: { kind: "user", id: 9, username: "pal", isAdmin: false },
      repo: makeRepoRow({ ownerId: 1 }),
    });
    expect(unprobedHtml).toContain('href="/octocat/hello/fork"');
  });
});

describe("Footer", () => {
  it("renders the page-footer landmarks", () => {
    const html = page();
    expect(html).toContain('<footer class="page-footer" role="group" aria-label="Footer">');
    expect(html).toContain('aria-label="About Software"');
    expect(html).toContain('aria-label="Links"');
    expect(html).toContain('<a href="/assets/licenses.txt">Licenses</a>');
  });
});

// --- 404 page ----------------------------------------------------------------

// --- demo banner (SPEC-0014 §4.4, M2) -----------------------------------------

/**
 * The banner arm battery. The gate-off arm is the §2 invariant in its UI
 * form: NO DOM NODE AT ALL — the page is byte-identical to the pre-M2 shell,
 * which is what keeps the committed goldens (session-goldens/, rendered with
 * no demoMode in ctx) the unchanged byte-proof. The gate-on arm is the
 * golden: the banner node + the dismissal script, inserted between </nav>
 * and the role="main" div, everything else byte-identical.
 */
describe("the demo banner (SPEC-0014 §4.4)", () => {
  const armedCtx: UiContext = { ...anonymousCtx, demoMode: true };
  const armedPage = (props: { title?: string } = {}): string =>
    renderPage(
      <BaseLayout ctx={armedCtx} title={props.title}>
        <p>page body</p>
      </BaseLayout>,
    );

  it("gate OFF (§2 invariant): no DOM node at all — no banner id, no dismissal script, byte-identical shell", () => {
    // Absent flag (every default deployment and every committed golden) AND
    // an explicit false: both arms render nothing.
    for (const ctx of [anonymousCtx, { ...anonymousCtx, demoMode: false }]) {
      const html = renderPage(
        <BaseLayout ctx={ctx}>
          <p>page body</p>
        </BaseLayout>,
      );
      expect(html).not.toContain("demo-banner");
      expect(html).not.toContain("sessionStorage");
      expect(html).not.toContain("flash-info");
    }
    // The page structurally unchanged: role="main" follows the navbar
    // directly — no interstitial node between them.
    expect(page()).toContain('</nav><div role="main"');
  });

  it("gate ON: exactly the banner node + dismissal script inserted above role=main, everything else byte-identical", () => {
    const on = armedPage();
    const off = page();
    // Split both renders at the navbar close: head and tail must be
    // byte-identical; the ONLY difference is the insertion between them.
    const marker = "</nav>";
    expect(on.startsWith(off.slice(0, off.indexOf(marker)) + marker)).toBe(true);
    const tailOf = (html: string): string => html.slice(html.indexOf('<div role="main"'));
    expect(tailOf(on)).toBe(tailOf(off));
    const inserted = on.slice(off.indexOf(marker) + marker.length, on.indexOf('<div role="main"'));
    // The node: upstream's flash-message bar at the pin (RenderFlashMessage,
    // util_render.go:263-292) with Fomantic's close shape and a11y semantics.
    expect(inserted.startsWith('<div class="ui info message flash-message flash-info" id="demo-banner" role="note">')).toBe(true);
    expect(inserted).toContain(
      '<i class="close icon" id="demo-banner-dismiss" role="button" tabindex="0" aria-label="Dismiss notice"></i>',
    );
    expect(inserted).toContain(
      "<div class=\"tw-text-center\">This is a demo instance: data on this instance is periodically cleaned.</div>",
    );
    // The dismissal script rides verbatim, right after the node.
    expect(inserted).toContain(`<script>${DEMO_BANNER_DISMISS_SCRIPT}</script>`);
    expect(inserted.endsWith("</script>")).toBe(true);
    // The armed page still passes the a11y smoke (the note + labelled,
    // focusable close control).
    expect(runA11y(on)).toEqual([]);
  });

  it("dismissal is per-SESSION (sessionStorage, never localStorage) and never round-trips the server", () => {
    // The script's whole storage surface is sessionStorage under the one
    // exported key — the §4.4 semantic (dies with the browser session, so a
    // fresh session sees the banner again; a navigation within the session
    // stays dismissed). No endpoint, no D1 — the script is static bytes and
    // the node re-renders on every armed request.
    expect(DEMO_BANNER_DISMISS_SCRIPT).toContain(`sessionStorage.getItem("${DEMO_BANNER_STORAGE_KEY}")==="1"`);
    expect(DEMO_BANNER_DISMISS_SCRIPT).toContain(`sessionStorage.setItem("${DEMO_BANNER_STORAGE_KEY}","1")`);
    expect(DEMO_BANNER_DISMISS_SCRIPT).not.toContain("localStorage");
    expect(DEMO_BANNER_DISMISS_SCRIPT).not.toContain("fetch(");
    // Already-dismissed: hide before anything else (first-paint suppression).
    const hideIndex = DEMO_BANNER_DISMISS_SCRIPT.indexOf('b.style.display="none"');
    expect(hideIndex).toBeGreaterThan(0);
    expect(DEMO_BANNER_DISMISS_SCRIPT.indexOf("getItem")).toBeLessThan(DEMO_BANNER_DISMISS_SCRIPT.indexOf("setItem"));
    // Both storage touches are try/caught (private-mode throws degrade the
    // dismissal to per-pageload, never break the page).
    expect(DEMO_BANNER_DISMISS_SCRIPT).toMatch(/try\{if\(sessionStorage\.getItem/);
    expect(DEMO_BANNER_DISMISS_SCRIPT).toMatch(/try\{sessionStorage\.setItem/);
    // Dismiss arms: click AND keyboard (Enter/Space — the control is a
    // focusable role=button).
    expect(DEMO_BANNER_DISMISS_SCRIPT).toContain('x.addEventListener("click",dismiss)');
    expect(DEMO_BANNER_DISMISS_SCRIPT).toContain('if(ev.key==="Enter"||ev.key===" ")');
    // Renders are deterministic (no request-state bleed into the script).
    expect(armedPage()).toBe(armedPage());
  });
});

// --- 404 page ----------------------------------------------------------------

describe("not-found page", () => {
  it("renders the 404 content inside the full shell for a repo-less context", () => {
    const html = renderPage(<NotFoundPage ctx={anonymousCtx} />);
    expect(html).toContain('<nav id="navbar"');
    expect(html).toContain('<footer class="page-footer"');
    expect(html).toContain('role="main" aria-label="Page Not Found"');
    // No repo resolved: plain page-content, no repository discriminator class.
    expect(html).toContain('class="page-content">');
    expect(html).toContain('<div class="status-page-error-title">404 Not Found</div>');
    expect(html).toContain("<strong>does not exist</strong>");
    expect(html).toContain("<strong>you are not authorized</strong>");
    // No back target this slice.
    expect(html).not.toContain(">Go Back<");
  });

  it("renders the repo header for a resolved repo and never a file list", () => {
    const html = renderPage(<NotFoundPage ctx={repoCtx} />);
    expect(html).toContain('class="page-content repository"');
    expect(html).toContain('href="/octocat/hello"');
    expect(html).toContain("404 Not Found");
    // The load-bearing file-list ID belongs to the home page only (§5.1).
    expect(html).not.toContain("repo-files-table");
    expect(renderToString(<NotFoundPage ctx={repoCtx} />)).not.toContain("repo-files-table");
  });
});
