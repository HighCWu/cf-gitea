/**
 * The API documentation viewer (findings-links A2 — the settings
 * applications "API docs" hint linked `/api/swagger`, which nothing mounted):
 *
 *   GET /api/swagger         the standalone swagger-ui viewer page
 *                            (upstream misc.Swagger → "swagger/openapi-viewer",
 *                            routers/web/misc/swagger.go; mounted web.go:303-305
 *                            — at this pin the template lives at
 *                            templates/swagger/openapi-viewer.tmpl, the old
 *                            swagger.tmpl was split into this standalone
 *                            viewer + the OpenAPI3 copy)
 *   GET /swagger.v1.json     the OpenAPI document (upstream SwaggerV1Json,
 *                            routers/web/swagger_json.go, mounted
 *                            web.go:1795)
 *   GET /openapi3.v1.json    the twin document arm (upstream OpenAPI3Json,
 *                            mounted web.go:1796 beside the swagger arm in
 *                            the SAME `setting.API.EnableSwagger` block)
 *
 * ## The page IS the bundle's chunk — no CDN fallback
 *
 * The vendored official build already carries the viewer as a real entry:
 * manifest key `web_src/js/swagger.ts` → `js/swagger.<h8>.js` (isEntry) with
 * `css/swagger.<h8>.css` riding the entry's css list (the standalone CSS the
 * template's AssetCSSLinks names — `web_src/css/swagger-standalone.css` — is
 * folded INTO that list by the pinned build, the key itself is absent from
 * the manifest, verified 2026-10-30). The chunk embeds swagger-ui-dist
 * 5.33.2 (gitea/package.json at the pin) and needs NO main-site modules (its
 * header: "standalone entry, it must not pull in main site modules") — the
 * page only has to emit the exact DOM the entry expects:
 *
 *   - `#swagger-ui` with `data-source` (the entry fetches THAT url and
 *     inits SwaggerUI({spec, domNode, deepLinking, docExpansion: "none",
 *     defaultModelRendering: "model"}) — web_src/js/render/swagger.ts at the
 *     pin; the older url/dom_id config shape is gone at this pin),
 *   - the theme stylesheet (upstream ctx.CurrentWebTheme.PublicAssetURI →
 *     AssetURI("web_src/css/themes/theme-<name>.css"),
 *     services/webtheme/webtheme.go:47-49; the landed shell posture serves
 *     theme-gitea-light unconditionally — the same reduction every page
 *     carries, shell.tsx's themeCssUri),
 *   - the `.swagger-page-links` row (OpenAPI JSON / Swagger JSON / the
 *     return link — locale en-US `return_to_gitea` = "Return to Gitea",
 *     AppSubUrl "" folded into the hrefs), and
 *   - the `type="module"` script for the entry (upstream ScriptImport,
 *     context_template.go:102-110, minus the CSP nonce — the landed §4.14
 *     nonce adaptation every shell script already carries).
 *
 * Upstream renders this as a STANDALONE document — no BaseLayout, no
 * navbar, no window.config (the template has none and the entry must not
 * read one) — so this module does not go through the shell; it mirrors
 * openapi-viewer.tmpl element-for-element and renders through the shared
 * renderPage doctype wrapper. HeadMetaContentSecurityPolicy renders NOTHING
 * at the pin (WebContentSecurityPolicy returns "" while
 * ContentSecurityPolicyGeneral keeps its "unset" default,
 * context_template.go:116-151); the response-header CSP for HTML still rides
 * the dispatcher's securityHeaders() stamp, upstream's SecurityHeadersHandler
 * posture.
 *
 * ## The spec document — the runtime-generated registry, not the frozen copy
 *
 * Upstream serves its embedded generated swagger (swaggerJsonServe's
 * template-asset read + the AppVer/AppSubURL placeholder substitution). The
 * upstream-faithful adaptation serves OUR generated document:
 * `getGeneratedSpec()` (src/api/openapi.ts) emits the zod-openapi registry's
 * OpenAPI 3.0.3 document — the exact surface `/api/v1` actually answers
 * (500 operations across 306 paths at the time of writing, contract-checked
 * against the vendored swagger by `pnpm check:api`). Serving the FROZEN
 * contract copy instead would advertise upstream's 78 tier-1 paths we have
 * not landed — a spec pointing at 404s, the same dishonesty class as A2
 * itself. Documented divergence: upstream serves a Swagger-2.0 doc at
 * /swagger.v1.json and an OpenAPI-3 doc at /openapi3.v1.json; our registry
 * generates ONE OpenAPI 3.0.3 document and both names serve it verbatim
 * (swagger-ui reads both formats; the page's data-source is the openapi3
 * name exactly like the pinned template). The AppVer substitution needs no
 * analog: the registry bakes SERVER_VERSION into info.version at generation.
 *
 * The document is deploy-immutable (the registry is compiled in), so the
 * serialized body is cached for the isolate lifetime — the manifest-cache
 * posture (manifest.ts's header note: per-deploy data, never per-request
 * state).
 *
 * ## Posture — public
 *
 * Upstream's chain carries the session middleware but NO auth gate
 * (web.go:303-305 mounts misc.Swagger on the logged-out-capable mid stack;
 * web.go:1794-1797 registers both JSON arms bare) — the viewer renders for
 * anonymous visitors, the theme is simply the default one. No session read,
 * no viewer resolution, no Set-Cookie here. Both names are ALREADY reserved
 * usernames (services/orgs/orgs.ts's RESERVED_USERNAMES — upstream
 * user.go:655's list) and the API's error bodies already point at
 * /api/swagger (api/config.ts SWAGGER_DOC_PATH), so this module closes the
 * loop those promises made.
 *
 * Failure mode mirrors the shell's assets seam: a missing/absent ASSETS
 * binding or manifest entry answers the 503 plain-text (index.ts's
 * assetsNotBuilt shape, replicated locally — index.ts is not importable from
 * a page module without a cycle).
 *
 * MOUNT RECORD (the orchestrator owns ui/index.ts): the three GETs register
 * in the STATIC block (beside /explore, BEFORE the dynamic /:owner/:repo
 * pair at index.ts:14709 — this Hono pin's RegExpRouter lets a later static
 * LOSE to that pair, and /api/swagger would otherwise parse as owner `api`):
 *
 *   import { apiSwaggerPage, swaggerV1Json } from "./pages/api-swagger";
 *   uiRouter.get("/api/swagger", (c) => apiSwaggerPage(c));
 *   uiRouter.get("/swagger.v1.json", () => swaggerV1Json());
 *   uiRouter.get("/openapi3.v1.json", () => swaggerV1Json());
 *
 * No parseUiRoute family: neither path is repo-scoped (src/index.ts's
 * dispatcher excludes `segments[0] === "api"` from the gate branch and
 * single-segment paths from repo scoping), so the registrations are reached
 * directly through the mounted uiRouter and the parser never sees them.
 * GET-only like every §2.1 family (other methods 404 the parent app, chi's
 * posture; trailing slashes 301 through uiRouter's trimTrailingSlash).
 */

import type { Context } from "hono";

import { getGeneratedSpec } from "../../api/openapi";
import { AssetBuildError, assetURI, cssLinks, loadManifest, type UiManifest } from "../manifest";
import { renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Manifest view
// ---------------------------------------------------------------------------

/** The three URIs the standalone page renders, resolved from the manifest. */
export interface ApiSwaggerView {
  /** The theme stylesheet (upstream CurrentWebTheme.PublicAssetURI). */
  themeCssUri: string;
  /** The viewer entry's CSS chain (AssetCSSLinks expansion). */
  swaggerCssUris: string[];
  /** The `type="module"` entry (upstream ScriptImport). */
  swaggerEntryUri: string;
}

/** Manifest keys this page resolves — the viewer entry + the default theme.
 *  `web_src/css/swagger-standalone.css` (the template's second AssetCSSLinks
 *  key) is deliberately absent: the pinned build folds it into the entry's
 *  own css list, the standalone key is not a manifest entry (verified
 *  2026-10-30 against apps/worker/public/assets/.vite/manifest.json). */
const SWAGGER_ENTRY_KEY = "web_src/js/swagger.ts";
const THEME_KEY = "web_src/css/themes/theme-gitea-light.css";

/** Resolve the page's asset URIs from a loaded manifest (pure — no binding). */
export function apiSwaggerViewFromManifest(manifest: UiManifest): ApiSwaggerView {
  return {
    themeCssUri: assetURI(manifest, THEME_KEY),
    swaggerCssUris: cssLinks(manifest, SWAGGER_ENTRY_KEY),
    swaggerEntryUri: assetURI(manifest, SWAGGER_ENTRY_KEY),
  };
}

// ---------------------------------------------------------------------------
// Assets-binding seam (index.ts's assetsBinding twin — page modules cannot
// import index.ts without a cycle; same guard, same 503 shape below)
// ---------------------------------------------------------------------------

/** Structural type of the Workers static-assets fetcher binding. */
interface AssetsFetcherLike {
  fetch(input: RequestInfo): Promise<Response>;
}

function isAssetsFetcher(value: unknown): value is AssetsFetcherLike {
  return typeof value === "object" && value !== null && "fetch" in value;
}

/** Read `env.ASSETS` without assuming the wiring: absent or misshapen →
 *  undefined → loadManifest's AssetBuildError → the 503 below. */
function assetsFetcherOf(env: Env): AssetsFetcherLike | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (isAssetsFetcher(binding)) return binding;
  }
  return undefined;
}

/** index.ts `assetsNotBuilt` verbatim (the 503 plain-text shape). */
export function assetsNotBuiltResponse(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The page (openapi-viewer.tmpl element-for-element)
// ---------------------------------------------------------------------------

/** Upstream `{{svg "octicon-file-code"}}` — the pinned body inlined (the
 *  shared Icon component's allowlist lives in scripts/gen-ui-icons.mjs, a
 *  file this module does not own; moving these two in is the follow-up).
 *  Attribute order mirrors gitea/public/assets/img/svg/octicon-file-code.svg
 *  so the DOM contract is the upstream helper's verbatim. */
function OcticonFileCode() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      class="svg octicon-file-code"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d="M4 1.75C4 .784 4.784 0 5.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 14.25 15h-9a.75.75 0 0 1 0-1.5h9a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5H5.75a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Zm1.72 4.97a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.75.75 0 0 1 .215-.734l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06M3.28 7.78 1.81 9.25l1.47 1.47a.75.75 0 0 1-.018 1.042.75.75 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.042.018.75.75 0 0 1 .018 1.042m8.22-6.218V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914z" />
    </svg>
  );
}

/** Upstream `{{svg "octicon-reply"}}` — same inline posture as above. */
function OcticonReply() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      class="svg octicon-reply"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.75.75 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0" />
    </svg>
  );
}

/** Locale en-US `return_to_gitea` at the pin ("Return to Gitea"). The
 *  standalone page carries no window.config, so the string renders
 *  server-side — it cannot ride ui/locale.ts's configI18n surface. */
const RETURN_TO_GITEA = "Return to Gitea";

/**
 * The `swagger/openapi-viewer` document — standalone HTML, the template's
 * exact element set: the theme link, the viewer CSS chain, the page-links
 * row (each `target="_blank"` like upstream; AppSubUrl "" folded in),
 * `#swagger-ui` with the openapi3 data-source the bundled entry fetches, the
 * bare page footer, and the module script — no BaseLayout, no navbar, no
 * window.config, no nonce (the §4.14 adaptation).
 */
export function renderApiSwaggerPage(view: ApiSwaggerView): string {
  return renderPage(
    <html lang="en">
      <head>
        <title>Gitea API</title>
        <link rel="stylesheet" href={view.themeCssUri} />
        {view.swaggerCssUris.map((uri) => (
          <link rel="stylesheet" href={uri} />
        ))}
      </head>
      <body>
        <div class="swagger-page-links">
          <a href="/openapi3.v1.json" target="_blank">
            <OcticonFileCode />
            OpenAPI JSON
          </a>
          <a href="/swagger.v1.json" target="_blank">
            <OcticonFileCode />
            Swagger JSON
          </a>
          <a href="/">
            <OcticonReply />
            {RETURN_TO_GITEA}
          </a>
        </div>
        <div id="swagger-ui" data-source="/openapi3.v1.json" />
        <footer class="page-footer" />
        <script type="module" src={view.swaggerEntryUri} />
      </body>
    </html>,
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `GET /api/swagger` (misc.Swagger): resolve the viewer's assets from the
 *  manifest and answer the standalone page. Public — no session gate
 *  (upstream web.go:303-305 carries the session middleware but no
 *  reqSignIn; the anonymous theme is the default). */
export async function apiSwaggerPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  let view: ApiSwaggerView;
  try {
    const manifest = await loadManifest(assetsFetcherOf(c.env), new URL(c.req.url).origin);
    view = apiSwaggerViewFromManifest(manifest);
  } catch (error) {
    if (error instanceof AssetBuildError) return assetsNotBuiltResponse(error);
    throw error;
  }
  return c.html(renderApiSwaggerPage(view));
}

// ---------------------------------------------------------------------------
// The spec documents (swagger_json.go's arms over the generated registry)
// ---------------------------------------------------------------------------

/** The serialized generated document, cached for the isolate lifetime (the
 *  manifest-cache posture — deploy-immutable data, never request state). */
let cachedSpecJson: string | null = null;

/** Drop the isolate cache (tests / explicit re-pin reload). */
export function resetSwaggerSpecCache(): void {
  cachedSpecJson = null;
}

/** The `/swagger.v1.json` + `/openapi3.v1.json` body — the registry's
 *  OpenAPI document serialized once per isolate (module doc: the single-doc
 *  divergence note). Generation failures propagate to the app onError arm
 *  (upstream swaggerJsonServe's HTTPError posture for an unreadable doc). */
export function swaggerV1JsonBody(): string {
  cachedSpecJson ??= JSON.stringify(getGeneratedSpec());
  return cachedSpecJson;
}

/** The spec Response — Content-Type `application/json` EXACTLY (Go's
 *  swaggerJsonServe sets it without a charset; Hono's c.json would append
 *  one). The uiRouter's RD20 cache-control middleware stamps the zero-option
 *  prod value onto this response (upstream's web-context posture). */
export function swaggerJsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `GET /swagger.v1.json` + `GET /openapi3.v1.json` (SwaggerV1Json /
 *  OpenAPI3Json): the generated document. Public — upstream registers both
 *  arms bare (web.go:1794-1797). */
export function swaggerV1Json(): Response {
  return swaggerJsonResponse(swaggerV1JsonBody());
}
