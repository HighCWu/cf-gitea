/**
 * The API documentation viewer module's tests (findings-links A2 — the
 * settings-applications "API docs" hint's `/api/swagger` target; census
 * B-80's byte-exact docs arms): the standalone openapi-viewer page's DOM
 * contract (the pinned templates/swagger/openapi-viewer.tmpl element set,
 * byte-pinned over a synthetic manifest), the two spec-document arms
 * byte-exact against the vendored documents (the frozen contract copy and
 * the pinned templates tree, with swagger_json.go's AppVer/AppSubURL
 * substitution applied independently in this file), the substitution
 * helper's probed Go semantics, the exact `application/json` content-type,
 * the PUBLIC login-gate posture (upstream web.go:303-305 carries the
 * session middleware but NO reqSignIn — anonymous renders, no Set-Cookie),
 * the manifest-seam failure arms (the assetsNotBuilt 503 shape), and the
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
import contractV1SwaggerRaw from "../../compat/contract/v1-swagger.generated.json?raw";
import v1Openapi3Raw from "../../../../../gitea/templates/swagger/v1-openapi3.generated.json?raw";
import { AssetBuildError, resetManifestCache, type UiManifest } from "../manifest";
import {
  apiSwaggerPage,
  apiSwaggerViewFromManifest,
  assetsNotBuiltResponse,
  jsEscapeString,
  openapi3V1Json,
  openapi3V1JsonBody,
  renderApiSwaggerPage,
  resetSwaggerSpecCache,
  substituteSwaggerPlaceholders,
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
app.get("/openapi3.v1.json", () => openapi3V1Json());

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

// --- GET /swagger.v1.json + /openapi3.v1.json — the vendored documents -------
//
// The census B-80 arms: byte-exact serves of the vendored generated docs
// with swagger_json.go's AppVer/AppSubURL substitution. The EXPECTED bytes
// here are derived INDEPENDENTLY of the module — this file imports the same
// raw sources and applies the two plain string replaces itself, so body
// equality proves the module's replacer port + caches didn't perturb the
// vendored bytes.

interface Swagger2DocSmoke {
  swagger: string;
  info: { title: string; version: string };
  basePath: string;
  paths: Record<string, unknown>;
}

interface Openapi3DocSmoke {
  openapi: string;
  info: { title: string; version: string };
  servers: { url: string }[];
  paths: Record<string, unknown>;
}

/** The two string replaces of routers/web/swagger_json.go:27-37, applied
 *  independently of the module's helper (AppVer = SERVER_VERSION, AppSubURL
 *  = "" — the escape of both is identity, probed). */
const expectedV1 = contractV1SwaggerRaw
  .replaceAll("0.0.0+GITEA-API-APP-VERSION", SERVER_VERSION)
  .replaceAll("/GITEA-API-APP-SUBURL/", "/");
const expectedOpenapi3 = v1Openapi3Raw
  .replaceAll("0.0.0+GITEA-API-APP-VERSION", SERVER_VERSION)
  .replaceAll("/GITEA-API-APP-SUBURL/", "/");

describe("GET /swagger.v1.json (SwaggerV1Json over the vendored docs)", () => {
  it("serves the frozen contract copy byte-exact with the substitution applied", async () => {
    const res = await app.fetch(new Request("https://test.local/swagger.v1.json"), envWithAssets);
    expect(res.status).toBe(200);
    // swaggerJsonServe sets Content-Type "application/json" WITHOUT a
    // charset (routers/web/swagger_json.go) — Hono's c.json would append
    // one, so the module sets the header explicitly.
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(expectedV1);
  });

  it("parses as the upstream Swagger-2.0 document with the substituted version and basePath", () => {
    const doc = JSON.parse(swaggerV1JsonBody()) as Swagger2DocSmoke;
    expect(doc.swagger).toBe("2.0");
    expect(doc.info.title).toBe("Gitea API");
    // The AppVer arm: the version every other instance arm reports.
    expect(doc.info.version).toBe(SERVER_VERSION);
    // The AppSubURL arm: "" + "/" folds the placeholder away.
    expect(doc.basePath).toBe("/api/v1");
    // The docs describe the upstream surface (a non-empty path registry).
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.paths["/repos/{owner}/{repo}"]).toBeDefined();
    // No placeholder survives either substitution.
    expect(swaggerV1JsonBody()).not.toContain("GITEA-API-APP");
  });

  it("serves the twin OpenAPI-3 document byte-exact at /openapi3.v1.json", async () => {
    const res = await app.fetch(new Request("https://test.local/openapi3.v1.json"), envWithAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(expectedOpenapi3);
  });

  it("parses as the upstream OpenAPI-3 twin — a DIFFERENT document from the swagger arm, like upstream", () => {
    // Upstream serves Swagger-2.0 at the swagger name and OpenAPI-3 at the
    // openapi3 name (two formats of the same surface); the vendored twins
    // differ — the page's data-source reads the openapi3 one.
    const doc = JSON.parse(openapi3V1JsonBody()) as Openapi3DocSmoke;
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.info.title).toBe("Gitea API");
    expect(doc.info.version).toBe(SERVER_VERSION);
    expect(doc.servers[0]?.url).toBe("/api/v1");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    // The two arms are the two vendored documents, not one body twice.
    expect(openapi3V1JsonBody()).not.toBe(swaggerV1JsonBody());
    expect(openapi3V1JsonBody()).not.toContain("GITEA-API-APP");
  });

  it("caches both substituted bodies for the isolate lifetime and resets on demand", () => {
    const first = swaggerV1JsonBody();
    const first3 = openapi3V1JsonBody();
    expect(swaggerV1JsonBody()).toBe(first); // the cache, not a re-substitution
    expect(openapi3V1JsonBody()).toBe(first3);
    resetSwaggerSpecCache();
    expect(swaggerV1JsonBody()).toBe(first); // deploy-immutable bytes → same
    expect(openapi3V1JsonBody()).toBe(first3);
    expect(JSON.parse(swaggerV1JsonBody())).toBeInstanceOf(Object);
    expect(JSON.parse(openapi3V1JsonBody())).toBeInstanceOf(Object);
  });

  it("shapes swaggerJsonResponse with the exact headers and status", () => {
    const res = swaggerJsonResponse('{"openapi":"3.0.3"}');
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

// --- the substitution helper (swagger_json.go's replacer, probed) ------------

describe("jsEscapeString (text/template JSEscapeString, probed against Go 1.25.1)", () => {
  it("is identity over the substitution values at this posture", () => {
    expect(jsEscapeString(SERVER_VERSION)).toBe(SERVER_VERSION);
    expect(jsEscapeString("")).toBe("");
    expect(jsEscapeString("/sub/path")).toBe("/sub/path");
  });

  it("escapes the specials byte-exact (uppercase \\u00XX, per the Go probe)", () => {
    expect(jsEscapeString(`a<b>c&d"e'f\\g=h`)).toBe(`a\\u003Cb\\u003Ec\\u0026d\\"e\\'f\\\\g\\u003Dh`);
  });

  it("escapes control chars as \\u00XX", () => {
    expect(jsEscapeString("\t\n\r\x00\x1f")).toBe("\\u0009\\u000A\\u000D\\u0000\\u001F");
  });
});

describe("substituteSwaggerPlaceholders (swagger_json.go's replacer)", () => {
  it("swaps both placeholders the way the Go replacer does", () => {
    const raw = '{"version":"0.0.0+GITEA-API-APP-VERSION","basePath":"/GITEA-API-APP-SUBURL/api/v1"}';
    expect(substituteSwaggerPlaceholders(raw)).toBe(
      `{"version":"${SERVER_VERSION}","basePath":"/api/v1"}`,
    );
  });

  it("leaves placeholder-free bytes untouched (byte-exact serves)", () => {
    expect(substituteSwaggerPlaceholders('{"swagger":"2.0"}')).toBe('{"swagger":"2.0"}');
  });
});
