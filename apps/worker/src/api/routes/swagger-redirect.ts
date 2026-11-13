/**
 * `GET /api/v1/swagger` — the API-docs redirect arm (census B-80, module 16
 * MS11's first surface). Upstream registers it in the API router's
 * "Miscellaneous (no scope required)" group:
 *
 *   m.Get("/swagger", func(ctx *context.APIContext) {
 *       ctx.Redirect(setting.AppSubURL + "/api/swagger")
 *   })
 *
 * (routers/api/v1/api.go:1001-1005, behind `setting.API.EnableSwagger` —
 * default true, modules/setting/api.go:16; the docs surface IS the pin's
 * default posture, so the gate carries no env arm here.)
 *
 * ## Plain registration, outside the generated document
 *
 * Upstream's own comment: "Note: The route is here but no in API routes
 * because it renders a web page" — the redirect is NOT in the vendored
 * swagger (nor in upstream's), so this file registers a PLAIN Hono route on
 * the OpenAPIHono app, the registerFederationApiRoutes precedent: the path
 * never enters the generated OpenAPI document and the check:api surface
 * never sees it.
 *
 * ## ctx.Redirect = Base.Redirect (services/context/base.go:150-159)
 *
 *   - Fetch-action arm: a non-empty `X-Gitea-Fetch-Action` header
 *     (modules/httplib/server_request.go:246-248 — the web bundle's
 *     fetch-action module sends it on every POST it proxies) answers
 *     `200 {"redirect": location}` so the JS follows the pointer instead of
 *     embedding a redirected body. Content-Type is Base.JSON's exact
 *     "application/json;charset=utf-8" (base.go:114-116 — set explicitly,
 *     Hono's c.json would write "application/json; charset=UTF-8").
 *   - Otherwise Go's http.Redirect with the default 303 See Other:
 *     Location header plus, for GET requests, the anchor body
 *     `<a href="/api/swagger">See Other</a>.\n` with
 *     "text/html; charset=utf-8" (net/http's exact GET body; the
 *     goRedirectBody twin in services/actions-artifacts.ts carries 302's
 *     "Found" text — 303's status text differs, so the body is written
 *     here).
 *
 * The target is `setting.AppSubURL + "/api/swagger"` with AppSubURL "" (the
 * instance serves at the origin root — the same folded value the viewer
 * page's hrefs carry, ui/pages/api-swagger.tsx), i.e. the landed viewer
 * page uiRouter.get("/api/swagger") (census B-80's second surface). No auth
 * and no scope gate arm: upstream's group comment says "no scope required",
 * and the scope-gate table carries no row for /swagger (scope-gate.ts's
 * convention — rows exist only where the vendored swagger declares ops).
 */

import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { chiMethodNotAllowed } from "./federation";

/** `setting.AppSubURL + "/api/swagger"` — AppSubURL folded to "" (module
 *  doc). */
export const SWAGGER_REDIRECT_LOCATION = "/api/swagger";

/** modules/httplib/server_request.go:246-248 — the header's mere presence
 *  (any non-empty value) flips the arm. */
export function isFetchActionRequest(c: Context<ApiEnv>): boolean {
  return (c.req.header("X-Gitea-Fetch-Action") ?? "") !== "";
}

/** Go http.Redirect's GET anchor body (net/http, the goRedirectBody twin
 *  with 303's status text): the HTML-escaped location inside the anchor.
 *  "/api/swagger" carries no escapable bytes; the escape mirrors
 *  html.EscapeString (& ' < > ") for target fidelity. */
export function seeOtherRedirectBody(location: string): string {
  const escaped = location
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&#34;");
  return `<a href="${escaped}">See Other</a>.\n`;
}

/** Base.Redirect over `/api/swagger` for GET requests (the only method the
 *  registration hands here — every other method 405s at the tree, see the
 *  register function): the fetch-action JSON flip, else the 303 with
 *  Location + Go's GET anchor body. */
export function swaggerRedirectResponse(c: Context<ApiEnv>): Response {
  if (isFetchActionRequest(c)) {
    return new Response(JSON.stringify({ redirect: SWAGGER_REDIRECT_LOCATION }), {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  }
  return new Response(seeOtherRedirectBody(SWAGGER_REDIRECT_LOCATION), {
    status: 303,
    headers: {
      location: SWAGGER_REDIRECT_LOCATION,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** Register `GET /swagger` on the API router (api.go:1001-1005's misc-group
 *  position — beside /version's miscellaneous family). Plain registration,
 *  outside the generated OpenAPI document (module doc). Method posture: chi
 *  registers ONE method per `m.Get`, and every other method — HEAD included,
 *  chi's tree has NO HEAD→GET fallback (the 7538a40 adjudication) — falls to
 *  the default methodNotAllowedHandler (mux.go:532-540): 405 + `Allow: GET`,
 *  empty body, gate-independent. chiMethodNotAllowed is the federation
 *  family's exported byte-shape twin (federation.ts:229-243). */
export function registerSwaggerRedirectRoute(app: OpenAPIHono<ApiEnv>): void {
  app.all("/swagger", (c) =>
    c.req.method === "GET" ? swaggerRedirectResponse(c) : chiMethodNotAllowed(c.req.method, ["GET"]),
  );
}
