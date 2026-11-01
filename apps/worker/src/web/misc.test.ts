/**
 * The routers/web/misc family suites (src/web/misc.ts — web.go:544-547):
 * the theme list's JSON shape over the REAL built assets (the 9-theme
 * sorted order, the RenderThemeItem bytes, the current-theme selection
 * through both preference surfaces), the apply round-trip (signed-in
 * store write + anonymous cookie), the CrossOriginProtection deny table,
 * the banner-dismiss cookie + JSONOK, and the markup endpoint's bind
 * arms (json/multipart/urlencoded/unsupported) with the sniffed
 * Content-Type, the CSP, and the 422/500 error arms — plus the chi 405
 * method arms every route carries.
 *
 * Driven standalone like the landed sub-app suites (well-known.test.ts,
 * avatar-serving.test.ts) — NO src/index.ts dependency. D1 arms run on
 * the real local D1 with the generated migrations (the Drizzle
 * user_settings store behind the apply round-trip).
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { userSettings, users } from "../db/schema";
import { mintSession, SESSION_COOKIE_NAME } from "../ui/session";
import { resetManifestCache } from "../ui/manifest";
import { loadUserSettings, saveUserSettings } from "../api/services/user-settings";
import { PAGE_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "./security-headers";
import {
  COOKIE_THEME,
  COOKIE_WEB_BANNER_DISMISSED,
  DEFAULT_WEB_THEME,
  parseThemeCssMeta,
  resetWebThemeCollectionCache,
  webBannerDismissResponse,
  webMiscRouter,
} from "./misc";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM users").run();
  // The manifest + theme-collection caches hold per-isolate data; the
  // stub-asset cases below swap the fetcher, so every test starts from an
  // empty cache (the manifest.test.ts reset-at-use contract).
  resetManifestCache();
  resetWebThemeCollectionCache();
});

const ORIGIN = "https://test.local";

/** Route-level request against the bare sub-app (the well-known.test.ts
 *  posture), the real bindings by default. */
async function call(path: string, init?: RequestInit): Promise<Response> {
  return webMiscRouter.request(`${ORIGIN}${path}`, init, env);
}

// --- fixtures -------------------------------------------------------------------

async function seedUser(username = "Alice"): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      visibility: "public",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return { id: row.id, username: row.username };
}

/** A valid `gitea_session` cookie value for the user (the landed mint —
 *  the sha256-at-rest row, exactly what a PAT login would leave).
 *  `backdated` mints past the 24h rotation interval with `remember` (the
 *  31-day idle TTL keeps the row alive past the rotation point — a
 *  non-remembered row would idle-expire before rotation fires). */
async function seedSession(userId: number, backdated = false): Promise<string> {
  if (!backdated) return mintSession(env.DB, userId);
  return mintSession(env.DB, userId, { now: new Date(Date.now() - 25 * 60 * 60 * 1000), remember: true });
}

const withSession = (value: string, extraHeaders: Record<string, string> = {}): Record<string, string> => ({
  cookie: `${SESSION_COOKIE_NAME}=${value}`,
  ...extraHeaders,
});

const setCookieHeader = (response: Response): string => response.headers.get("set-cookie") ?? "";

const selectedValues = async (response: Response): Promise<string[]> => {
  const body = await response.json<{ results: Array<{ value: string; class: string }> }>();
  return body.results.filter((item) => item.class.endsWith(" selected")).map((item) => item.value);
};

// --------------------------------------------------------------------------------
// GET /-/web-theme/list (webtheme.go:18-32)
// --------------------------------------------------------------------------------

describe("GET /-/web-theme/list (the real built assets)", () => {
  it("lists the 9 vendored themes in upstream's sorted order with the default selected", async () => {
    const response = await call("/-/web-theme/list");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const body = await response.json<{ results: Array<{ name: string; value: string; class: string }> }>();
    expect(body.results.map((item) => item.value)).toEqual([
      "gitea-auto", // the default theme claims the first slot (webtheme.go:181-183)
      "gitea-dark",
      "gitea-light",
      // the colorblind groups follow ("" < "blue-yellow" < "red-green" —
      // Go byte order), display-name ordered within each
      "gitea-auto-tritanopia",
      "gitea-dark-tritanopia",
      "gitea-light-tritanopia",
      "gitea-auto-protanopia-deuteranopia",
      "gitea-dark-protanopia-deuteranopia",
      "gitea-light-protanopia-deuteranopia",
    ]);
    // The default theme is the anonymous current → its item is marked.
    expect(body.results[0]?.class).toBe("item js-aria-clickable selected");
    for (const item of body.results.slice(1)) {
      expect(item.class).toBe("item js-aria-clickable");
    }
  });

  it("renders RenderThemeItem's HTML: the scheme icon at 14, the display name, the colorblind extra", async () => {
    const response = await call("/-/web-theme/list");
    // ONE body read — the parsed results answer every lookup below.
    const body = await response.json<{ results: Array<{ name: string; value: string }> }>();
    const nameOf = (value: string): string => {
      const item = body.results.find((candidate) => candidate.value === value);
      if (item === undefined) throw new Error(`missing theme ${value}`);
      return item.name;
    };
    // Auto: the eclipse icon, tooltipless, display name "Auto", and the
    // literal's trailing space before </div> (the empty extra %s).
    expect(nameOf("gitea-auto")).toBe(
      `<div class="theme-menu-item" data-tooltip-content="">` +
        `<svg viewBox="490 490 820 820" class="svg gitea-eclipse" xmlns="http://www.w3.org/2000/svg" width="14" height="14" aria-hidden="true">` +
        `<path d="M866.7 582.1A321.3 321.3 0 0 0 738.6 623a317.3 317.3 0 0 0-109.1 108.5A418 418 0 0 0 609 772a335.3 335.3 0 0 0-19.6 71.5 205.2 205.2 0 0 0-2.8 45c0 25.8.2 29.3 2.8 45 4.1 25.4 9.9 46.4 19.6 71.5a314.2 314.2 0 0 0 111.6 137.3A306.8 306.8 0 0 0 893 1196a308.6 308.6 0 0 0 303.6-262.5c2.6-15.7 2.8-19.2 2.8-45s-.2-29.3-2.8-45A335.3 335.3 0 0 0 1177 772a314.2 314.2 0 0 0-111.6-137.3A308.3 308.3 0 0 0 918 582c-13-1.1-38.2-1.1-51.3.1M747 663.5l-2.4 16.7c-4 26.4-4.9 41.1-4.3 65.3a323.7 323.7 0 0 0 37.2 145c18.2 36 41.3 66.6 72 95.5a346.4 346.4 0 0 0 208.5 93.1l18 1.6 4.5.5-8.5 8a259.3 259.3 0 0 1-141.5 65.8 281 281 0 0 1-123.9-11.4 267.2 267.2 0 0 1-181.7-269.9c2-27.6 5.7-47.6 13.3-70.7a281.2 281.2 0 0 1 46.4-85c8-10.1 28-30.2 37.9-38.1 13.8-11.1 24.5-18.3 24.5-16.4"/></svg>` +
        ` Auto </div>`,
    );
    // Dark/Light: moon/sun, plain tooltip.
    const dark = nameOf("gitea-dark");
    expect(dark).toContain('class="svg octicon-moon" width="14" height="14"');
    expect(dark).toContain('data-tooltip-content="">');
    expect(nameOf("gitea-light")).toContain('class="svg octicon-sun" width="14" height="14"');
    // The colorblind entries: the tooltip + the extra icon svg.
    const protanopia = nameOf("gitea-light-protanopia-deuteranopia");
    expect(protanopia).toContain('data-tooltip-content="Red-green colorblind friendly"');
    expect(protanopia).toContain('class="svg gitea-colorblind-redgreen" width="14" height="14"');
    const tritanopia = nameOf("gitea-light-tritanopia");
    expect(tritanopia).toContain('data-tooltip-content="Blue-yellow colorblind friendly"');
    expect(tritanopia).toContain('class="svg gitea-colorblind-blueyellow" width="14" height="14"');
  });

  it("marks the anonymous cookie theme selected (gitea_theme, QueryEscape read)", async () => {
    const response = await call("/-/web-theme/list", {
      headers: { cookie: `${COOKIE_THEME}=gitea-dark` },
    });
    expect(await selectedValues(response)).toEqual(["gitea-dark"]);
  });

  it("falls back to the default item for an unknown stored name (GuaranteeGetThemeMetaInfo)", async () => {
    const response = await call("/-/web-theme/list", {
      headers: { cookie: `${COOKIE_THEME}=does-not-exist` },
    });
    expect(await selectedValues(response)).toEqual([DEFAULT_WEB_THEME]);
  });

  it("marks the signed-in doer's stored theme selected (the user_settings preference surface)", async () => {
    const user = await seedUser();
    await saveUserSettings(env.DB, user.id, { theme: "gitea-light" });
    const cookie = await seedSession(user.id);
    const response = await call("/-/web-theme/list", { headers: withSession(cookie) });
    expect(await selectedValues(response)).toEqual(["gitea-light"]);
    // A FRESH session is under the 24h rotation interval — no directive
    // (the response stays header-free; the rotated arm is the markup
    // suite's backdated mint below).
    expect(setCookieHeader(response)).toBe("");
  });

  it("attaches the session rotation directive once the interval is past (§2.4)", async () => {
    const user = await seedUser();
    const cookie = await seedSession(user.id, true); // minted 25h ago
    const response = await call("/-/web-theme/list", { headers: withSession(cookie) });
    expect(response.status).toBe(200);
    expect(setCookieHeader(response)).toContain(`${SESSION_COOKIE_NAME}=`);
  });
});

describe("GET /-/web-theme/list (synthetic asset store)", () => {
  /**
   * The stub fetcher: a manifest + the CSS bytes it names (the
   * manifest.test.ts synthetic posture). `connect` is never called — the
   * binding type carries it, so the stub satisfies the Fetcher shape
   * cast-free.
   */
  const withRequired = (
    entries: Record<string, { file: string }>,
  ): Record<string, { file: string }> => ({
    "web_src/js/iife.ts": { file: "js/iife.stub.js" },
    "web_src/js/index.ts": { file: "js/index.stub.js" },
    "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.stub.css" },
    "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.stub.js" },
    ...entries,
  });
  function stubAssets(manifest: Record<string, { file: string }>, files: Record<string, string>): Env["ASSETS"] {
    return {
      fetch: (input: RequestInfo | URL): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/assets/.vite/manifest.json")) {
          return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
        }
        for (const [file, css] of Object.entries(files)) {
          if (url.endsWith(`/assets/${file}`)) return Promise.resolve(new Response(css, { status: 200 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
      connect: (): never => {
        throw new Error("stub fetcher: no connect");
      },
    };
  }

  const callWithAssets = async (
    assets: Env["ASSETS"],
    path = "/-/web-theme/list",
    init?: RequestInit,
  ): Promise<Response> => webMiscRouter.request(`${ORIGIN}${path}`, init, { ...env, ASSETS: assets });

  it("parses the meta block: display name, colorblind type, color scheme", async () => {
    const assets = stubAssets(
      withRequired({ "web_src/css/themes/theme-test-a.css": { file: "css/theme-test-a.h1.css" } }),
      {
        "css/theme-test-a.h1.css": [
          ":root { --color-primary: #fff; }",
          "gitea-theme-meta-info {",
          '  --theme-display-name: "Test A";',
          '  --theme-colorblind-type: "red-green";',
          '  --theme-color-scheme: "dark";',
          "}",
        ].join("\n"),
      },
    );
    // The stub collection carries only test-a (the required light entry's
    // stub file is intentionally unserved → the skip arm), so the selection
    // probe rides the cookie — the anonymous default name ("gitea-auto")
    // resolves to NOTHING here, upstream's GuaranteeGetThemeMetaInfo
    // "unavailable" chain, and no item is marked.
    const unmarked = await callWithAssets(assets);
    const plain = await unmarked.json<{ results: Array<{ value: string; class: string }> }>();
    expect(plain.results).toHaveLength(1);
    expect(plain.results[0]?.class).toBe("item js-aria-clickable");
    const response = await callWithAssets(assets, "/-/web-theme/list", {
      headers: { cookie: `${COOKIE_THEME}=test-a` },
    });
    const body = await response.json<{ results: Array<{ name: string; value: string; class: string }> }>();
    const item = body.results[0];
    expect(item?.value).toBe("test-a");
    expect(item?.class).toBe("item js-aria-clickable selected");
    expect(item?.name).toContain('data-tooltip-content="Red-green colorblind friendly"');
    expect(item?.name).toContain('class="svg octicon-moon" width="14" height="14"');
    expect(item?.name).toContain('class="svg gitea-colorblind-redgreen" width="14" height="14"');
    expect(item?.name).toContain(" Test A ");
  });

  it("degrades a meta-less theme to displayName = internalName (webtheme.go:119-127)", async () => {
    const assets = stubAssets(
      withRequired({ "web_src/css/themes/theme-bare.css": { file: "css/theme-bare.h2.css" } }),
      { "css/theme-bare.h2.css": ":root { --is-dark-theme: true; }" },
    );
    const response = await callWithAssets(assets);
    const body = await response.json<{ results: Array<{ name: string; value: string }> }>();
    expect(body.results[0]?.value).toBe("bare");
    expect(body.results[0]?.name).toContain(" bare </div>");
    expect(body.results[0]?.name).toContain("octicon-paintbrush"); // no scheme → the default icon
  });

  it("skips a theme whose CSS fetch fails and falls back when none survive", async () => {
    // The manifest names a file the store does not serve → the skip arm
    // leaves the list empty → the single default entry (webtheme.go:233).
    const assets = stubAssets(
      withRequired({ "web_src/css/themes/theme-gone.css": { file: "css/theme-gone.dead.css" } }),
      {},
    );
    const response = await callWithAssets(assets);
    const body = await response.json<{ results: Array<{ value: string; class: string }> }>();
    expect(body.results.map((item) => item.value)).toEqual([DEFAULT_WEB_THEME]);
    expect(body.results[0]?.class).toBe("item js-aria-clickable selected");
  });

  it("takes the default fallback when the manifest is missing (the 503 build posture)", async () => {
    const missing = {
      fetch: (): Promise<Response> => Promise.resolve(new Response("not found", { status: 404 })),
      connect: (): never => {
        throw new Error("stub fetcher: no connect");
      },
    };
    const response = await callWithAssets(missing);
    const body = await response.json<{ results: Array<{ value: string }> }>();
    expect(body.results.map((item) => item.value)).toEqual([DEFAULT_WEB_THEME]);
  });

  it("excludes non-theme manifest keys (the prefix/suffix filter)", async () => {
    const assets = stubAssets(
      withRequired({
        "web_src/css/base.css": { file: "css/base.h5.css" },
        "web_src/css/themes/theme-real.css": { file: "css/theme-real.h6.css" },
      }),
      { "css/theme-real.h6.css": 'gitea-theme-meta-info { --theme-display-name: "Real"; --theme-color-scheme: "light"; }' },
    );
    const response = await callWithAssets(assets);
    const body = await response.json<{ results: Array<{ value: string; name: string }> }>();
    expect(body.results.map((item) => item.value)).toEqual(["real"]);
    expect(body.results[0]?.name).toContain('class="svg octicon-sun" width="14" height="14"');
  });
});

describe("parseThemeCssMeta (the webtheme.go:38-80 port)", () => {
  it("finds the block anywhere in the file and reads quoted and bare values", () => {
    const meta = parseThemeCssMeta('a{b:c}\ngitea-theme-meta-info{--x: "quoted"; --y: \'sq\'; --z: bare;}');
    expect(meta).toEqual({ "--x": "quoted", "--y": "sq", "--z": "bare" });
  });

  it("returns null without a block", () => {
    expect(parseThemeCssMeta(":root{--x:1}")).toBeNull();
  });

  it("unescapes embedded quotes in double-quoted values", () => {
    const meta = parseThemeCssMeta('gitea-theme-meta-info { --name: "a \\"b\\" c"; }');
    expect(meta?.["--name"]).toBe('a "b" c');
  });
});

// --------------------------------------------------------------------------------
// POST /-/web-theme/apply (webtheme.go:34-42)
// --------------------------------------------------------------------------------

describe("POST /-/web-theme/apply", () => {
  it("stores the theme for a signed-in doer in user_settings (the round trip)", async () => {
    const user = await seedUser();
    const cookie = await seedSession(user.id);
    const response = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: withSession(cookie),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect((await loadUserSettings(env.DB, user.id)).theme).toBe("gitea-dark");
    // ...and the same read the list does now marks the stored theme.
    const list = await call("/-/web-theme/list", { headers: withSession(cookie) });
    expect(await selectedValues(list)).toEqual(["gitea-dark"]);
  });

  it("sets the gitea_theme SESSION cookie for an anonymous visitor (SetSiteCookie, maxAge 0)", async () => {
    const response = await call("/-/web-theme/apply?theme=gitea-dark", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(setCookieHeader(response)).toBe(`${COOKIE_THEME}=gitea-dark; Path=/; HttpOnly; Secure; SameSite=Lax`);
  });

  it("QueryEscapes the cookie value (the url.QueryEscape port)", async () => {
    const response = await call("/-/web-theme/apply?theme=a%20b%2Fc", { method: "POST" });
    expect(setCookieHeader(response)).toBe(`${COOKIE_THEME}=a+b%2Fc; Path=/; HttpOnly; Secure; SameSite=Lax`);
    // ...and GetSiteCookie unescapes it back for the list's selection.
    const list = await call("/-/web-theme/list", {
      headers: { cookie: `${COOKIE_THEME}=a+b%2Fc` },
    });
    // "a b/c" matches no theme → the default stays selected (no crash).
    expect(await selectedValues(list)).toEqual([DEFAULT_WEB_THEME]);
  });

  it("accepts an urlencoded body field (Go ParseForm: query wins over body)", async () => {
    const response = await call("/-/web-theme/apply", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ theme: "gitea-light" }).toString(),
    });
    expect(setCookieHeader(response)).toBe(`${COOKIE_THEME}=gitea-light; Path=/; HttpOnly; Secure; SameSite=Lax`);
    const withQuery = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ theme: "gitea-light" }).toString(),
    });
    expect(setCookieHeader(withQuery)).toContain("gitea-dark");
  });

  it("stores an empty theme verbatim — upstream validates nothing (webtheme.go:35-41)", async () => {
    const user = await seedUser();
    const cookie = await seedSession(user.id);
    const response = await call("/-/web-theme/apply", { method: "POST", headers: withSession(cookie) });
    expect(response.status).toBe(200);
    const row = await drizzle(env.DB).select().from(userSettings).all();
    expect(row).toHaveLength(1);
    expect(row[0]?.theme).toBe("");
  });

  it.each([
    ["cross-site"],
    ["same-site"],
    ["garbage"],
  ])("denies Sec-Fetch-Site %s with the Go csrf.go message", async (site) => {
    const response = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { "sec-fetch-site": site },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("cross-origin request detected from Sec-Fetch-Site header\n");
  });

  it("denies an old-browser cross-origin POST (missing Sec-Fetch-Site, mismatched Origin)", async () => {
    const response = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "test.local" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      "cross-origin request detected, and/or browser is out of date: Sec-Fetch-Site is missing, and Origin does not match Host\n",
    );
  });

  it("passes same-origin requests: Sec-Fetch-Site arms, matching Origin, and header-less clients", async () => {
    const sameOrigin = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.status).toBe(200);
    const none = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { "sec-fetch-site": "none" },
    });
    expect(none.status).toBe(200);
    const matchingOrigin = await call("/-/web-theme/apply?theme=gitea-dark", {
      method: "POST",
      headers: { origin: ORIGIN, host: "test.local" },
    });
    expect(matchingOrigin.status).toBe(200);
    const noHeaders = await call("/-/web-theme/apply?theme=gitea-dark", { method: "POST" });
    expect(noHeaders.status).toBe(200);
  });

  it("carries the 405 method arms (chi's default handler shape)", async () => {
    const get = await call("/-/web-theme/apply", { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(await get.text()).toBe("");
    const head = await call("/-/web-theme/apply", { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("POST");
    // The chi unknown-method arm (405 with NO Allow) is unreachable
    // through Hono.request — workerd's Request constructor rejects any
    // method outside the fetch standard before the router sees it; the
    // pure chiMethodNotAllowed arm stays covered by its known-method
    // wire shape here.
  });
});

// --------------------------------------------------------------------------------
// POST /-/web-banner/dismiss (misc.go:82-86)
// --------------------------------------------------------------------------------

describe("POST /-/web-banner/dismiss", () => {
  it("answers JSONOK with the 48h revision cookie", async () => {
    const response = await call("/-/web-banner/dismiss", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await response.text()).toBe('{"ok":true}');
    expect(setCookieHeader(response)).toBe(
      `${COOKIE_WEB_BANNER_DISMISSED}=0; Path=/; Max-Age=172800; HttpOnly; Secure; SameSite=Lax`,
    );
  });

  it("matches the pure handler (the uiRouter-fold shape)", () => {
    const direct = webBannerDismissResponse();
    expect(direct.status).toBe(200);
    expect(setCookieHeader(direct)).toContain(`${COOKIE_WEB_BANNER_DISMISSED}=0`);
  });

  it("carries the 405 method arms", async () => {
    const get = await call("/-/web-banner/dismiss", { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});

// --------------------------------------------------------------------------------
// POST /-/markup (markup.go:16-20 + common/markup.go RenderMarkup)
// --------------------------------------------------------------------------------

describe("POST /-/markup — the reqSignIn gate", () => {
  it("303s an anonymous visitor onto the login round trip", async () => {
    const response = await call("/-/markup", { method: "POST" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/markup")}`);
  });

  it("carries the query string in redirect_to (Go RequestURI)", async () => {
    const response = await call("/-/markup?x=1", { method: "POST" });
    expect(response.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/markup?x=1")}`);
  });

  it("answers the fetch-action probe with the 401 JSON arm (base.go:161-169)", async () => {
    const response = await call("/-/markup", {
      method: "POST",
      headers: { "x-gitea-fetch-action": "1" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await response.text()).toBe(
      JSON.stringify({ redirect: `/login?redirect_to=${encodeURIComponent("/-/markup")}` }),
    );
  });

  it("renders for a signed-in doer (the session rotation cookie rides)", async () => {
    const user = await seedUser();
    // Backdated past the 24h rotation interval — the response must carry
    // the viewer resolution's Set-Cookie directive alongside the render.
    const cookie = await seedSession(user.id, true);
    const response = await call("/-/markup", {
      method: "POST",
      headers: { ...withSession(cookie), "content-type": "application/json" },
      body: JSON.stringify({ Text: "# Title", Mode: "markdown" }),
    });
    expect(response.status).toBe(200);
    expect(setCookieHeader(response)).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(await response.text()).toBe('<h1 id="user-content-title">Title</h1>\n');
  });
});

describe("POST /-/markup — the bind + render arms", () => {
  let markupCookie = "";

  beforeEach(async () => {
    const user = await seedUser();
    // FRESH mint — these arms make MULTIPLE calls, and a backdated session
    // would rotate on the first (leaving the later calls on a stale cookie,
    // the §2.4 stale branch that authenticates nothing). The rotation-
    // directive proof lives in the single-call arms above.
    markupCookie = await seedSession(user.id);
  });

  /** POST with the session cookie MERGED into the arm's headers (a plain
   *  spread would let init.headers REPLACE the cookie header — the
   *  anonymous 303 the gate arms exist to prevent). */
  const postMarkup = async (init: RequestInit): Promise<Response> => {
    const headers = new Headers(withSession(markupCookie));
    if (init.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    return call("/-/markup", { ...init, method: "POST", headers });
  };

  it("binds a JSON body case-insensitively and renders markdown (sniffed text/html)", async () => {
    const response = await postMarkup({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "# Title", mode: "markdown" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("x-frame-options")).toBe(X_FRAME_OPTIONS);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe('<h1 id="user-content-title">Title</h1>\n');
  });

  it("binds the ComboMarkdownEditor's FormData body (multipart, snake_case fields)", async () => {
    const form = new FormData();
    form.append("mode", "comment");
    form.append("context", "/user2/repo1/src/branch/main/doc");
    form.append("text", "[up](../other.md#section)");
    const response = await postMarkup({ body: form });
    const html = await response.text();
    expect(html).toContain(`href="${ORIGIN}/user2/repo1/src/branch/main/other.md#section"`);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("binds an urlencoded body and keeps [[wiki-syntax]] literal in raw markdown", async () => {
    const response = await postMarkup({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text: "[[special|syntax]]", context: "/user2/repo1" }).toString(),
    });
    expect(await response.text()).toBe("<p>[[special|syntax]]</p>\n");
  });

  it("lets the deprecated Wiki flag force wiki mode (form 'on' and JSON booleans)", async () => {
    const form = new FormData();
    form.append("text", "[[Tips]]");
    form.append("context", "user2/repo1");
    form.append("wiki", "on");
    const formResponse = await postMarkup({ body: form });
    expect(await formResponse.text()).toContain(`href="${ORIGIN}/user2/repo1/wiki/Tips"`);

    const jsonResponse = await postMarkup({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Text: "[[Name|Link]]", Context: "user2/repo1", Wiki: true }),
    });
    expect(await jsonResponse.text()).toContain(`href="${ORIGIN}/user2/repo1/wiki/Link"`);
  });

  it("aborts the JSON bind at a type mismatch keeping earlier fields (Go's streaming decode)", async () => {
    const response = await postMarkup({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Text: "# Kept", Mode: 5 }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1 id="user-content-kept">Kept</h1>\n');
  });

  it("renders the ZERO form for unsupported content types and broken bodies (bind never short-circuits)", async () => {
    const plainText = await postMarkup({
      headers: { "content-type": "text/plain" },
      body: "# not bound",
    });
    expect(plainText.status).toBe(200);
    expect(await plainText.text()).toBe("");
    expect(plainText.headers.get("content-type")).toBe("application/octet-stream");

    const noType = await postMarkup({ body: "anything" });
    expect(noType.status).toBe(200);
    expect(await noType.text()).toBe("");
    expect(noType.headers.get("content-type")).toBe("application/octet-stream");

    const brokenJson = await postMarkup({
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(brokenJson.status).toBe(200);
    expect(await brokenJson.text()).toBe("");
  });

  it("answers an empty JSON body (io.EOF arm) and an empty object with an empty octet-stream render", async () => {
    for (const body of ["", "{}"]) {
      const response = await postMarkup({
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
    }
  });

  it("422s an unsupported mode with the exact upstream message (markup.go default branch)", async () => {
    const response = await postMarkup({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Text: "x", Mode: "nope" }),
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
    expect(await response.text()).toBe("unsupported render mode: nope\n");
  });

  it("carries the 405 method arms", async () => {
    const get = await call("/-/markup", { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });
});

// --------------------------------------------------------------------------------
// The theme collection cache
// --------------------------------------------------------------------------------

describe("the theme collection cache", () => {
  it("serves the same collection across calls until reset", async () => {
    const first = await call("/-/web-theme/list");
    const second = await call("/-/web-theme/list");
    expect(await second.text()).toBe(await first.text());
    resetWebThemeCollectionCache();
  });
});
