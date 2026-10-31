/**
 * The `/.well-known/*` web group's unclaimed endpoints (census gap #16 —
 * the pin's group at `routers/web/web.go:531-542`, wrapped in
 * `optionsCorsHandler()` at :542). The census found three of the group's
 * five registrations ALREADY LANDED — this module owns only the remainder,
 * so no endpoint is implemented twice:
 *
 *   GET /.well-known/openid-configuration   web.go:532 → LANDED
 *       (src/web/oauth2-wellknown.ts, mounted src/index.ts:295)
 *   GET /.well-known/nodeinfo               web.go:534 → LANDED
 *       (src/api/routes/federation.ts wellKnownRouter, mounted
 *       src/index.ts:291 — the federation Tier A family)
 *   GET /.well-known/webfinger              web.go:535 → LANDED (same)
 *   GET /.well-known/change-password        web.go:537-539 → THIS MODULE
 *   GET /.well-known/passkey-endpoints      web.go:540 → THIS MODULE
 *   GET,HEAD /.well-known/*                 web.go:541 → THIS MODULE
 *       (public.FileHandlerFunc's static fallback)
 *
 * ## change-password (web.go:537-539)
 *
 * A route-level lambda: `ctx.Redirect(setting.AppSubURL + "/user/settings/
 * account")`. Base.Redirect (services/context/base.go:150-159) has two
 * arms: the `X-Gitea-Fetch-Action` header (non-empty —
 * httplib.IsGiteaFetchActionRequest, server_request.go:246-248) short-
 * circuits to a 200 `{"redirect": …}` ctx.JSON body (base.go:151-156 — the
 * fetch-action module must not follow a 303 into an embedded page); every
 * other request takes `http.Redirect(w, r, location, 303)`
 * (util.OptionalArg default StatusSeeOther, base.go:157-158). Go's
 * http.Redirect (net/http/server.go) then emits, for the always-absolute
 * `/{AppSubURL}/user/settings/account` target: the `Location` header
 * (hexEscapeNonASCII — a no-op for this ASCII path), `Content-Type:
 * text/html; charset=utf-8` (GET/HEAD only, never pre-set here) and a GET
 * body of `"<a href=\"" + htmlEscape(url) + "\">" + StatusText(303) +
 * "</a>.\n"` through fmt.Fprintln — the literal's "\n" PLUS Fprintln's own
 * = the body ends `</a>.\n\n`.
 *
 * AppSubURL = strings.TrimSuffix(appURL.Path, "/") (modules/setting/
 * server.go:140 — `""` at the root, `/sub` under a subpath); appURL here is
 * the SAME normalized source the landed seams share (federationAppUrl —
 * upstream AppURL is TrimRight("/" ) + "/", server.go:137).
 *
 * ## passkey-endpoints (passkey.go:13-24)
 *
 * A static document: `{"enroll":"<AppURL>user/settings/security",
 * "manage":"…"}` — the struct declares Enroll then Manage, Go's compact
 * struct marshal keeps that member order, and ctx.JSON stamps
 * `application/json;charset=utf-8` with NO trailing newline
 * (base.go:114-120). NOT gated by federationEnabled (:540 sits outside the
 * gate group) and not auth-gated — public upstream, public here.
 *
 * ## The static fallback (web.go:541)
 *
 * `m.Methods("GET, HEAD", "/*", public.FileHandlerFunc())` — Gitea's
 * Methods wrapper splits the comma list into two chi registrations
 * (modules/web/router.go:177-190). FileHandlerFunc (modules/public/
 * public.go:58-70) answers non-GET/HEAD with a bare 405, and handleRequest
 * (:86-114) answers a missing file with a bare 404 — `WriteHeader` only:
 * empty body, no Content-Type. A Workers deployment carries no custom
 * `public/.well-known` store (the admin-dropped ACME/security.txt files
 * upstream serves), so EVERY tail lands on that missing-file 404 — the
 * store's shape, not a behavioral divergence; a future store plugs in here.
 *
 * ## The 405 method arms — chi's default handler, byte-shaped
 *
 * chi v5.4.0 registers NO HEAD fallback: a HEAD (or POST/OPTIONS/…) to a
 * GET-only path misses the method map, sets methodNotAllowed (tree.go
 * :478-486) and routeHTTP (mux.go) serves the DEFAULT
 * methodNotAllowedHandler — `Allow` ADDED PER ALLOWED METHOD (one wire line
 * per method; the endpoint iteration is a Go MAP RANGE, so upstream's line
 * ORDER is unspecified) and an EMPTY body (`w.WriteHeader(405); w.Write(
 * nil)`). The static routes carry `Allow: GET`; the wildcard carries GET
 * and HEAD (both registered at :541); an UNKNOWN method (outside chi's
 * methodMap) 405s with NO Allow at all (mux.go's early `if !ok` arm).
 * Hono would auto-HEAD every GET route (dispatch-as-GET, body stripped —
 * hono-base.js #dispatch) which upstream does NOT do, so every route here
 * is registered via `.all` and dispatches on `c.req.method` itself.
 *
 * The group's `optionsCorsHandler` (web.go:62-93) never produces the
 * OPTIONS-deny 405 here: chi group middleware wraps the ENDPOINT handlers
 * (mux.go's inline Chain), and OPTIONS resolves no endpoint — the default
 * 405 above answers first. (The landed federation module's header records
 * a different reading for its pair — that module's surface, not edited
 * here.)
 *
 * ## The bare `/.well-known` path
 *
 * No pattern matches it (the wildcard needs a tail), so chi falls to the
 * web router's NotFound (web.go:1819-1823 → Context.NotFound,
 * context_response.go:129-151): the HTML 404 chrome for Accept: text/html,
 * else the plain `Not found.\n` line (Gitea's PlainText spelling —
 * `text/plain;charset=utf-8`, no space, + nosniff). The plain arm answers
 * BOTH accepts here; the chrome arm is a RECORDED divergence —
 * renderNotFoundShellResponse requires the un-widened `Env` and this
 * module's APP_URL-aliased env slice cannot call it cast-free, so the HTML
 * not-found chrome stays the global web surface (the dispatcher/ui shell
 * machinery), not this module's.
 *
 * ## MOUNT HANDOFF (src/index.ts, orchestrator-owned — this module does
 * not touch the shared index; the oauth2-wellknown.ts handoff is the
 * pattern):
 *
 *     import { webWellKnownRouter } from "./web/well-known";
 *     app.route("/", webWellKnownRouter);
 *
 * — in the same block as the federation `wellKnownRouter` mount
 * (src/index.ts:291) and `oauth2WellKnownRouter` (:295), BEFORE uiRouter
 * (:323). Hono merges the sub-apps into one routing table where static
 * routes beat wildcards, so the landed `/.well-known/{nodeinfo,webfinger,
 * openid-configuration}` GETs keep winning over this module's `/*`
 * fallback regardless of order; the fallback only claims what they
 * disown — upstream's own shape (static-beats-catch-all in chi too). No
 * API-contract operation: the frozen OpenAPI surface gains nothing (a web
 * route family like the federation pair; `pnpm check:api` stays PASS).
 */

import { Hono } from "hono";

import { federationAppUrl } from "../services/federation/webfinger";

/**
 * The env slice the routes read (the FederationEnv posture): APP_URL rides
 * wrangler `vars` — the generated Env types it as the config literal, the
 * alias widens it back to `string | undefined` so tests and any config
 * shape stay assignable. No binding is read — this family is D1-free.
 */
export type WellKnownEnv = Omit<Env, "APP_URL"> & {
  /** Upstream `setting.AppURL` — unset falls back to the request origin. */
  APP_URL?: string;
};

// ---------------------------------------------------------------------------
// Go byte-shape helpers (the federation.ts / oauth2-wellknown.ts shapes)
// ---------------------------------------------------------------------------

/** chi v5.4.0's methodMap (mux.go): the methods whose 405 carries the
 *  `Allow` header. An unknown method misses the map and 405s bare. */
const CHI_KNOWN_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
  "QUERY",
]);

/** Go's htmlEscape (net/http/server.go) — the template replacement table
 *  the redirect BODY link text goes through. */
function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}

/** Go `http.Redirect` at 303 for a GET request (net/http/server.go): the
 *  Location header, Go's own Content-Type spelling (WITH the space — the
 *  plainText family omits it), and the Fprintln'd anchor body ending
 *  `</a>.\n\n`. */
function goRedirect(location: string): Response {
  const body = `<a href="${htmlEscape(location)}">See Other</a>.\n\n`;
  return new Response(body, {
    status: 303,
    headers: { location, "content-type": "text/html; charset=utf-8" },
  });
}

/** chi's default methodNotAllowedHandler (mux.go): empty body, `Allow`
 *  ADDED PER method (two wire lines for two methods — Headers.append, not
 *  one joined value). Line order: upstream's endpoint iteration is a Go
 *  map range (unspecified order); ours is the deterministic declaration
 *  order passed here. Unknown methods 405 with NO Allow (the mux.go early
 *  arm). */
function chiMethodNotAllowed(method: string, allow: string[]): Response {
  const response = new Response(null, { status: 405 });
  if (CHI_KNOWN_METHODS.has(method)) {
    for (const value of allow) response.headers.append("allow", value);
  }
  return response;
}

/** ctx.JSON's compact marshal (base.go:114-120): compact, no trailing
 *  newline, `application/json;charset=utf-8`. Struct order = object
 *  literal order (Go jsonv2 keeps struct field declaration order; the
 *  single-key redirect map is order-free). */
function goJson(status: number, content: Record<string, string>): Response {
  return new Response(JSON.stringify(content), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

/** The web router's NotFound plain arm (context_response.go:139-141 →
 *  plainTextInternal :128-136): `Not found.\n`, Gitea's PlainText
 *  spelling — NO space in the type, + nosniff. */
function goWebNotFoundPlain(): Response {
  return new Response("Not found.\n", {
    status: 404,
    headers: {
      "content-type": "text/plain;charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The shared AppURL source (federationAppUrl — upstream AppURL is
 *  normalized to exactly one trailing slash, server.go:137). */
function appUrlOf(env: WellKnownEnv, requestUrl: string): string {
  return federationAppUrl(env.APP_URL, new URL(requestUrl).origin);
}

/** AppSubURL (server.go:140): TrimSuffix(appURL.Path, "/") — `""` at the
 *  root, `/sub` under a subpath. Strict like the landed webfinger seam:
 *  a garbage APP_URL throws (upstream log.Fatal's at boot — the runtime
 *  surface has no softer arm to mirror). */
function appSubUrlOf(appUrl: string): string {
  return new URL(appUrl).pathname.replace(/\/$/, "");
}

/** The fetch-action probe (server_request.go:246-248): the header being
 *  NON-EMPTY — any value — flips the redirect arm. */
function isFetchActionRequest(request: Request): boolean {
  return (request.headers.get("x-gitea-fetch-action") ?? "") !== "";
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/** web.go:537-539's lambda: Base.Redirect(AppSubURL + "/user/settings/
 *  account") — the fetch-action JSON arm or Go's 303 redirect bytes. */
function changePassword(env: WellKnownEnv, request: Request): Response {
  const location = `${appSubUrlOf(appUrlOf(env, request.url))}/user/settings/account`;
  if (isFetchActionRequest(request)) {
    // base.go:151-156 — ctx.JSON(StatusOK, map{"redirect": location}).
    return goJson(200, { redirect: location });
  }
  return goRedirect(location);
}

/** passkey.go:13-24: the static document — Enroll before Manage (struct
 *  declaration order), both the same security-page URL. */
function passkeyEndpoints(env: WellKnownEnv, requestUrl: string): Response {
  const url = `${appUrlOf(env, requestUrl)}user/settings/security`;
  return goJson(200, { enroll: url, manage: url });
}

// ---------------------------------------------------------------------------
// The sub-app — a plain Hono seam (the oauth2-wellknown shape; the frozen
// OpenAPI contract has no operation here)
//
// Every route rides `.all` + an in-handler method dispatch: Hono would
// auto-HEAD the GET registrations (dispatch-as-GET, body stripped) but
// chi v5.4.0 has NO HEAD fallback — HEAD is a 405 + Allow: GET upstream,
// and the auto-HEAD wrapper would strip the deliberate 405 shape's (empty)
// body and keep the status, silently turning the arm into a wrong-method
// success. The explicit dispatch keeps every arm honest.
// ---------------------------------------------------------------------------

export const webWellKnownRouter = new Hono<{ Bindings: WellKnownEnv }>();

// The bare group path (web.go:1819-1823's web NotFound — no pattern claims
// it upstream). Registered BEFORE the wildcard so Hono's first-match rule
// lands it deterministically.
webWellKnownRouter.all("/.well-known", () => goWebNotFoundPlain());

// GET /.well-known/change-password (web.go:537-539).
webWellKnownRouter.all("/.well-known/change-password", (c) => {
  if (c.req.method === "GET") return changePassword(c.env, c.req.raw);
  return chiMethodNotAllowed(c.req.method, ["GET"]);
});

// GET /.well-known/passkey-endpoints (web.go:540 — outside the federation
// gate group: public, ungated).
webWellKnownRouter.all("/.well-known/passkey-endpoints", (c) => {
  if (c.req.method === "GET") return passkeyEndpoints(c.env, c.req.url);
  return chiMethodNotAllowed(c.req.method, ["GET"]);
});

// The static fallback (web.go:541 — public.FileHandlerFunc over an empty
// well-known store): GET and HEAD land on the bare missing-file 404, the
// known other methods 405 with Allow: GET + Allow: HEAD (both registered
// on the wildcard node), unknown methods bare-405. The trailing-slash and
// junk-tail shapes route here naturally — FileHandlerFunc's PathJoinRelX
// cleanup ends in the same missing-file arm upstream.
webWellKnownRouter.all("/.well-known/*", (c) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD") return new Response(null, { status: 404 });
  return chiMethodNotAllowed(method, ["GET", "HEAD"]);
});
