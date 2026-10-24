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
import { resolveViewer } from "./viewer";
import { configI18n } from "./locale";
import { BaseLayout, buildWindowConfig, renderPage, serializeWindowConfig } from "./shell";
import { NotFoundPage } from "./pages/not-found";

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
    ...overrides,
  };
}

const anonymousCtx: UiContext = { viewer: resolveViewer(), origin, assets };
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
    expect(config.pageData).toBeNull();
    expect(Object.keys(config.notificationSettings as object).sort()).toEqual([
      "MaxTimeout",
      "MinTimeout",
      "TimeoutStep",
    ]);
    expect(config.notificationSettings).toEqual({ MinTimeout: 10000, TimeoutStep: 10000, MaxTimeout: 60000 });
    expect(config.sharedWorkerUri).toBe(assetURI(manifest, "web_src/js/user-events.sharedworker.ts"));
    expect(config.sharedWorkerUri).toBe("/assets/js/user-events.5555eeee.js");
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
  it("renders the anonymous navbar landmark without dead links", () => {
    const html = page();
    expect(html).toContain('<nav id="navbar" aria-label="Navigation Bar">');
    expect(html).toContain('id="navbar-logo"');
    expect(html).toContain('<img width="30" height="30" src="/assets/img/logo.svg"');
    expect(html).toContain('href="https://docs.gitea.com"');
    // No login route (§2.5) and no explore page this slice — no dead links.
    expect(html).not.toContain("/user/login");
    expect(html).not.toContain("/explore/");
  });
});

describe("RepoHeader tab strip", () => {
  function tabStrip(html: string): string {
    const start = html.indexOf('<overflow-menu class="ui secondary pointing menu">');
    const end = html.indexOf("</overflow-menu>");
    if (start < 0 || end < 0) throw new Error(`no tab strip in:\n${html}`);
    return html.slice(start, end);
  }

  it("renders exactly the Code and Commits tabs, in order, with active tracking", () => {
    const strip = tabStrip(page({ ctx: repoCtx }));
    expect(strip.match(/<a class="(?:active )?item"/g)).toHaveLength(2);
    expect(strip).toContain('<a class="active item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(strip).toContain('<a class="item" href="/octocat/hello/commits">');
    // Inline octicon SVGs, upstream {{svg}} shape.
    expect(strip).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="svg octicon-code"');
    expect(strip).toContain('class="svg octicon-history"');
    expect(strip.indexOf("> Code</a>")).toBeGreaterThan(0);
    expect(strip).toContain("> Commits</a>");
    // Only existing pages: no Issues/Pulls/Releases/Wiki/Settings dead tabs.
    for (const dead of ["Issues", "Pulls", "Releases", "Wiki", "Settings"]) {
      expect(strip).not.toContain(dead);
    }

    const stripOnCommits = tabStrip(
      renderPage(
        <BaseLayout ctx={repoCtx} title="Commits" activeTab="commits">
          <p>commits</p>
        </BaseLayout>,
      ),
    );
    expect(stripOnCommits).toContain('<a class="item" href="/octocat/hello" data-shortcut-keys="g c">');
    expect(stripOnCommits).toContain('<a class="active item" href="/octocat/hello/commits">');
  });

  it("renders the repo header shell and closes with .ui.tabs.divider", () => {
    const html = page({ ctx: repoCtx });
    expect(html).toContain('<div class="secondary-nav"><div class="ui container"><div class="repo-header flex-left-right">');
    expect(html).toContain('class="svg octicon-repo"');
    expect(html).toContain('<span class="ui basic orange label">Public Access</span>');
    expect(html).toContain('Created <relative-time datetime="2023-11-14T22:13:20.000Z">');
    expect(html).toContain('<div class="ui tabs divider"></div>');
    // No star/watch/fork chrome (no write actions without auth, §2.5).
    expect(html).not.toContain("octicon-star");
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
