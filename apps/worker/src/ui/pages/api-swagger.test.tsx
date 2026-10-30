/**
 * The API documentation viewer module's tests (findings-links A2 — the
 * settings-applications "API docs" hint's `/api/swagger` target): the
 * standalone openapi-viewer page's DOM contract (the pinned
 * templates/swagger/openapi-viewer.tmpl element set, byte-pinned over a
 * synthetic manifest), the two spec-document arms (upstream
 * swaggerJsonServe's exact `application/json` content-type + a smoke
 * OpenAPI-parse of the runtime-generated registry document), the PUBLIC
 * login-gate posture (upstream web.go:303-305 carries the session
 * middleware but NO reqSignIn — anonymous renders, no Set-Cookie), the
 * manifest-seam failure arms (the assetsNotBuilt 503 shape), and the
 * upstream-faithful inline icon bodies (octicon-file-code / octicon-reply
 * at the pinned gitea/public/assets/img/svg bodies).
 *
 * Harness posture: the module's handlers driven through a local Hono app
 * registered with the EXACT mount lines the module doc hands off (the
 * routes are uiRouter registrations the orchestrator owns; this file never
 * imports index.ts), against the synthetic-manifest fetcher convention
 * (manifest.test.ts / harness.ts) — no dependence on the gitignored
 * `pnpm build:assets` tree. The RD20 cache-control stamp is intentionally
 * not asserted here: it is index-owned uiRouter middleware applied at the
 * real mount, not reproducible in this local driver without duplicating it.
 */

import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../../api/config";
import { AssetBuildError, resetManifestCache, type UiManifest } from "../manifest";
import {
  apiSwaggerPage,
  apiSwaggerViewFromManifest,
  assetsNotBuiltResponse,
  renderApiSwaggerPage,
  resetSwaggerSpecCache,
  swaggerJsonResponse,
  swaggerV1Json,
  swaggerV1JsonBody,
} from "./api-swagger";

// --- fixtures ----------------------------------------------------------------

/** Synthetic manifest shaped like the real Vite output (the harness
 *  convention) PLUS the keys this module resolves: the viewer entry (the
 *  pinned build carries `web_src/js/swagger.ts` as a real isEntry manifest
 *  key — `js/swagger.<h8>.js` + its folded css list) and the default theme.
 *  The standalone-css key the upstream template names
 *  (`web_src/css/swagger-standalone.css`) is deliberately ABSENT — the
 *  pinned build folds it into the entry's css list (module doc). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js" },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
  "web_src/js/swagger.ts": { file: "js/swagger.bbbb2222.js", css: ["css/swagger.cccc3333.css"] },
};

const okAssets = { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) };
const notBuiltAssets = { fetch: () => Promise.resolve(new Response("gone", { status: 404 })) };

type SwaggerTestEnv = Omit<Env, "ASSETS"> & {
  ASSETS?: { fetch: (input: RequestInfo) => Promise<Response> } | undefined;
};

const envWithAssets: SwaggerTestEnv = { ...env, ASSETS: okAssets };
const envWithoutAssets: SwaggerTestEnv = { ...env, ASSETS: undefined };
const envUnbuiltAssets: SwaggerTestEnv = { ...env, ASSETS: notBuiltAssets };

/** The local driver mounts the module's handlers EXACTLY as the handoff
 *  lines will register them on uiRouter (module doc's mount record). */
const app = new Hono<{ Bindings: Env }>();
app.get("/api/swagger", (c) => apiSwaggerPage(c));
app.get("/swagger.v1.json", () => swaggerV1Json());
app.get("/openapi3.v1.json", () => swaggerV1Json());

beforeEach(() => {
  // Both isolate caches: the manifest promise and the serialized spec would
  // otherwise leak arms across tests (a 503 probe after a 200 load would
  // silently hit the cached manifest).
  resetManifestCache();
  resetSwaggerSpecCache();
});

// --- the view (manifest → URIs) ----------------------------------------------

describe("apiSwaggerViewFromManifest", () => {
  it("resolves the theme, the entry's CSS chain and the module entry", () => {
    expect(apiSwaggerViewFromManifest(manifest)).toEqual({
      themeCssUri: "/assets/css/theme-gitea-light.4444dddd.css",
      swaggerCssUris: ["/assets/css/swagger.cccc3333.css"],
      swaggerEntryUri: "/assets/js/swagger.bbbb2222.js",
    });
  });

  it("throws AssetBuildError when the swagger entry is missing from the manifest", () => {
    const stale: UiManifest = { ...manifest };
    delete stale["web_src/js/swagger.ts"];
    expect(() => apiSwaggerViewFromManifest(stale)).toThrow(AssetBuildError);
  });
});

// --- GET /api/swagger — the standalone page -----------------------------------

describe("GET /api/swagger (misc.Swagger → openapi-viewer)", () => {
  it("answers the standalone document byte-pinned over the synthetic manifest", async () => {
    const res = await app.fetch(new Request("https://test.local/api/swagger"), envWithAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toBe(
      "<!DOCTYPE html><html lang=\"en\"><head><title>Gitea API</title>" +
        '<link rel="stylesheet" href="/assets/css/theme-gitea-light.4444dddd.css"/>' +
        '<link rel="stylesheet" href="/assets/css/swagger.cccc3333.css"/>' +
        "</head><body>" +
        '<div class="swagger-page-links">' +
        '<a href="/openapi3.v1.json" target="_blank">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-file-code" width="16" height="16" aria-hidden="true">' +
        '<path d="M4 1.75C4 .784 4.784 0 5.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 14.25 15h-9a.75.75 0 0 1 0-1.5h9a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5H5.75a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Zm1.72 4.97a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06M3.28 7.78 1.81 9.25l1.47 1.47a.75.75 0 0 1-.018 1.042.75.75 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.042.018.75.75 0 0 1 .018 1.042m8.22-6.218V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914z"></path>' +
        "</svg>OpenAPI JSON</a>" +
        '<a href="/swagger.v1.json" target="_blank">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-file-code" width="16" height="16" aria-hidden="true">' +
        '<path d="M4 1.75C4 .784 4.784 0 5.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 14.25 15h-9a.75.75 0 0 1 0-1.5h9a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5H5.75a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Zm1.72 4.97a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06M3.28 7.78 1.81 9.25l1.47 1.47a.75.75 0 0 1-.018 1.042.75.75 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.042.018.75.75 0 0 1 .018 1.042m8.22-6.218V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914z"></path>' +
        "</svg>Swagger JSON</a>" +
        '<a href="/">' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="svg octicon-reply" width="16" height="16" aria-hidden="true">' +
        '<path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.75.75 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0"></path>' +
        "</svg>Return to Gitea</a>" +
        "</div>" +
        '<div id="swagger-ui" data-source="/openapi3.v1.json"></div>' +
        "<footer class=\"page-footer\"></footer>" +
        '<script type="module" src="/assets/js/swagger.bbbb2222.js"></script>' +
        "</body></html>",
    );
  });

  it("renders the bundled-entry DOM contract the viewer chunk expects", () => {
    // The element set web_src/js/swagger.ts needs: the #swagger-ui node with
    // the openapi3 data-source it fetches (the pinned init reads
    // data-source, not a url config param), fed by the page-links row and
    // the module script. Assertion over the RENDERED page (the full render,
    // not the handler) keeps this pin honest even if the byte pin above is
    // regoldened.
    const html = renderApiSwaggerPage(apiSwaggerViewFromManifest(manifest));
    expect(html).toContain('<div id="swagger-ui" data-source="/openapi3.v1.json"></div>');
    expect(html).toContain('<script type="module" src="/assets/js/swagger.bbbb2222.js"></script>');
    // STANDALONE: no shell, no window.config, no navbar (the template has
    // none and the entry must not read one — module doc).
    expect(html).not.toContain("global-window-config");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("page-content");
    // The pinned CSP posture: no meta tag at the default "unset" setting
    // (context_template.go:145-152 renders nothing) — the response-header
    // CSP rides the dispatcher's securityHeaders() at the real mount.
    expect(html).not.toContain("Content-Security-Policy");
    // No nonce on the module script (the landed §4.14 adaptation).
    expect(html).not.toContain("nonce=");
  });

  it("is PUBLIC — anonymous renders with no session gate and no Set-Cookie", async () => {
    // Upstream web.go:303-305 mounts misc.Swagger on the session-capable mid
    // stack with NO reqSignIn (module doc); a cookie-less request renders,
    // and the handler attaches no Set-Cookie of its own.
    const res = await app.fetch(new Request("https://test.local/api/swagger"), envWithAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers the 503 plain-text when the ASSETS binding is absent", async () => {
    const res = await app.fetch(new Request("https://test.local/api/swagger"), envWithoutAssets);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("UI assets binding not configured (wrangler.jsonc assets block)\n");
  });

  it("answers the same 503 when the manifest itself is missing (the build arm)", async () => {
    const res = await app.fetch(new Request("https://test.local/api/swagger"), envUnbuiltAssets);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("UI assets not built — run `pnpm build:assets` (manifest 404)\n");
  });

  it("shapes the 503 through assetsNotBuiltResponse for a thrown AssetBuildError", async () => {
    const res = assetsNotBuiltResponse(new AssetBuildError("manifest missing required entry: x"));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await new Response(res.body).text()).toBe("manifest missing required entry: x\n");
  });
});

// --- GET /swagger.v1.json + /openapi3.v1.json — the generated document -------

interface GeneratedSpecSmoke {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
}

describe("GET /swagger.v1.json (SwaggerV1Json over the generated registry)", () => {
  it("serves the runtime-generated document with the exact upstream content-type", async () => {
    const res = await app.fetch(new Request("https://test.local/swagger.v1.json"), envWithAssets);
    expect(res.status).toBe(200);
    // swaggerJsonServe sets Content-Type "application/json" WITHOUT a
    // charset (routers/web/swagger_json.go) — Hono's c.json would append
    // one, so the module sets the header explicitly.
    expect(res.headers.get("content-type")).toBe("application/json");
    const doc = JSON.parse(await res.text()) as GeneratedSpecSmoke;
    // Smoke OpenAPI-parse (the A2 acceptance gates): a real parseable
    // document with a non-empty path registry and the repo surface present.
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.title).toBe("Gitea API");
    expect(doc.info.version).toBe(SERVER_VERSION);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.paths["/repos/{owner}/{repo}"]).toBeDefined();
  });

  it("serves the identical document at /openapi3.v1.json (the single-doc divergence)", async () => {
    // Our registry generates ONE OpenAPI 3.0.3 document; upstream serves a
    // Swagger-2.0 doc at the swagger name and an OpenAPI-3 doc at the
    // openapi3 name (module doc). Both names answer the same bytes here.
    const swagger = await app.fetch(new Request("https://test.local/swagger.v1.json"), envWithAssets);
    const openapi3 = await app.fetch(new Request("https://test.local/openapi3.v1.json"), envWithAssets);
    expect(openapi3.status).toBe(200);
    expect(openapi3.headers.get("content-type")).toBe("application/json");
    expect(await openapi3.text()).toBe(await swagger.text());
  });

  it("caches the serialized body for the isolate lifetime and resets on demand", () => {
    const first = swaggerV1JsonBody();
    expect(swaggerV1JsonBody()).toBe(first); // the cache, not a re-generation
    resetSwaggerSpecCache();
    expect(swaggerV1JsonBody()).toBe(first); // deterministic registry → same bytes
    const reparsed: unknown = JSON.parse(swaggerV1JsonBody());
    expect(reparsed).toBeInstanceOf(Object);
  });

  it("shapes swaggerJsonResponse with the exact headers and status", () => {
    const res = swaggerJsonResponse('{"openapi":"3.0.3"}');
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
