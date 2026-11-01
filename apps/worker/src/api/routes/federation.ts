/**
 * The federation Tier A family (SPEC specs/federation.md §6.1, W-A1) — the
 * discovery pair + the gated 501 stubs, fail-closed behind
 * `FEDERATION_ENABLED` (default "false"; upstream `setting.Federation.Enabled`
 * default false, modules/setting/federation.go:23):
 *
 *   GET /.well-known/nodeinfo      web.go:531-536 → NodeInfoLinks
 *                                  (routers/web/nodeinfo.go:23-31) — the
 *                                  single link to /api/v1/nodeinfo, whose
 *                                  rel names schema 2.1.
 *   GET /.well-known/webfinger     web.go:531-536 → WebfingerQuery
 *                                  (routers/web/webfinger.go:38-122) — the
 *                                  resolution lives in services/federation/
 *                                  webfinger.ts; this file maps outcomes to
 *                                  bytes and resolves the session viewer.
 *   GET /api/v1/nodeinfo           api.go:1007-1010 → activitypub.NotImplemented
 *   ANY /api/v1/activitypub/*      api.go:1009 — the stub carries upstream's
 *                                  tokenRequiresScopes(ActivityPub) gate
 *                                  INLINE, exactly where upstream hangs it
 *                                  (the routes/packages.ts inline-gate
 *                                  precedent: the central scope table's row
 *                                  stays absent so the check never runs
 *                                  twice — scope-gate.ts's recorded gap note).
 *
 * Gate arms (upstream's disabled posture, byte-shaped per surface):
 *   - the web pair: `federationEnabled` (web.go:409-414) →
 *     `ctx.HTTPError(http.StatusNotFound)` → Go `http.Error` — the plain
 *     `Not Found\n` text line with `text/plain; charset=utf-8` + nosniff
 *     (services/context/base.go:105-111), NOT the HTML 404 page.
 *   - the API arms: upstream REGISTERS the routes only when enabled
 *     (api.go:1007) — a disabled request is an UNREGISTERED path, answered
 *     by the mux's global not-found (routers/init.go:209-212). Ours answers
 *     the router's native not-found bytes (`404 Not Found`, Hono's default
 *     handler) — "404 from the router", the SPEC §7 wording; the house API
 *     tree's unregistered-path 404 is that same response everywhere.
 *   - the stubs (enabled): Go `http.Error(w, "Not implemented", 501)` —
 *     body `Not implemented\n`, `text/plain; charset=utf-8`, nosniff
 *     (routers/api/v1/activitypub/person.go:12-14 — the package's entire
 *     content at the pin; upstream retracted the data plane, PR #36789).
 *
 * The method arms are chi-exact (the 7538a40 adjudication; the well-known
 * census's citations re-verified against chi v5.4.0 mux.go/tree.go and
 * modules/web/router.go at this review — the earlier "OPTIONS falls through
 * to the router's native 404" reading here is SUPERSEDED):
 *   - Gitea's Group folds group middleware into each ENDPOINT registration
 *     (modules/web/router.go Group → curMiddlewares →
 *     wrapMiddlewareAndHandler → chiRouter.With(...).Method(...)), so
 *     optionsCorsHandler (web.go:542) runs only when the GET endpoint
 *     resolves. HEAD/OPTIONS resolve no endpoint and never reach it — the
 *     mux's DEFAULT methodNotAllowedHandler answers first (routeHTTP's
 *     methodNotAllowed arm): empty body, `Allow` added PER allowed method
 *     (the endpoint iteration is a Go map range, so upstream's wire line
 *     order is unspecified), and NO Allow for methods outside chi's
 *     methodMap (the pre-tree early arm).
 *   - chi registers NO HEAD→GET fallback (tree.go's endpoint map is
 *     method-keyed; routeHTTP has none — HEAD is only its own methodMap
 *     entry): a HEAD on a GET-only path is the same 405 + Allow: GET.
 *   - The web pair registers UNCONDITIONALLY (web.go:534-535 — the gate is
 *     per-endpoint middleware), so the tree 405s are gate-INDEPENDENT.
 *   - The API arms differ: api.go:1007's registration CONDITIONAL leaves
 *     the paths unregistered when disabled (known methods → the mux's
 *     native not-found; only the pre-tree unknown-method 405 still fires),
 *     while /activitypub/* is Gitea's Any → chi Handle → mALL (mux.go) —
 *     setEndpoint registers EVERY methodMap method (tree.go's loop), so
 *     all known methods ride the scope gate to the stub.
 * Hono would auto-HEAD every GET route (dispatch-as-GET at the router
 * match, body stripped — hono-base.js #dispatch), which upstream does not
 * do, so every arm here rides `.all` and dispatches on `c.req.method`
 * itself (the well-known module's pattern; the wrapper's
 * `new Response(null, res)` keeps a deliberate 405's status + Allow).
 * webfinger stamps its own `Access-Control-Allow-Origin: *` in-handler
 * (webfinger.go:116), gate-open only — the discovery tier is the gate's
 * payload, disabled = absent.
 *
 * TIER B (SPEC §6.2, W-B2/W-B3/W-B4 as-built 2026-11-01 — the user's
 * completion directive un-parked OQ-1's data plane within this SPEC's
 * staged posture): the activitypub wildcard 501 RETIRES into the pre-stub
 * (`1592576fa5^`) registration shape — the ONLY endpoints upstream's
 * deleted tree ever carried:
 *
 *   GET  /api/v1/activitypub/user-id/{id}         → the Person actor
 *          (person.go:20-79; services/federation/activitypub.ts builds it,
 *          the RSA-3072 keypair lazily generated in user_settings_kv).
 *   POST /api/v1/activitypub/user-id/{id}/inbox   → ReqHTTPSignature
 *          (reqsignature.go, ported in services/federation/httpsig.ts) →
 *          PersonInbox: a verified Follow answers 200 with an inline
 *          Accept activity (the user's completion directive — NO follower
 *          store: no sanctioned table exists and no migration is granted,
 *          so the acceptance is NOT persisted; see SPEC §6.2 as-built);
 *          every other verified activity keeps upstream's 204 black hole
 *          (PersonInbox's entire body, person.go:81-96).
 *
 * chi-exact dispatch per armed path (the Group-folds-middleware mechanics
 * from the Tier A header): chiUnknownMethodGuard (the pre-tree bare 405) →
 * federationApiGate (disabled = the whole group unregistered → the router's
 * native 404 for every known method) → the method guard (a known method the
 * endpoint doesn't register → chi's methodNotAllowedHandler: empty body +
 * Allow, NO further middleware — the gate never runs for an unresolved
 * method) → the inline activitypub scope gate (api.go:1009's
 * tokenRequiresScopes, folded into the endpoint) → the handler. Every
 * UNREGISTERED /activitypub/* sub-path (incl. the deprecated pre-stub
 * `/user/{username}` form — upstream's own "remove in 1.20" note at
 * api.go:941-945, a removal completed at birth here) falls to the router's
 * native not-found, upstream's unregistered-path posture (init.go's
 * GlobalNotFound; the house-native 404 equivalence Tier A recorded).
 * `/api/v1/nodeinfo` stays the W-B1 501 stub (that wave was not in this
 * dispatch's scope).
 *
 * INTEGRATION (orchestrator-owned — src/index.ts + api/router.ts, untouched
 * here; the HANDOFF lines live in specs/federation.md §6.1): the dispatcher's
 * repo-scoped branch (segments.length >= 2) currently hands /.well-known/*
 * to gitHttpGate (the headless-engine 404); the mount needs the same carve
 * the avatar-serving seam got (src/index.ts `segments[0] !== ".well-known"`)
 * plus `app.route("/", wellKnownRouter)` before uiRouter, and
 * `registerFederationApiRoutes(app)` beside the other route families in
 * api/router.ts. The suite drives BOTH routers standalone, so it is green
 * before the mounts land.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import type { AuthInfo } from "../../auth/auth-context";
import { requiredScopeNames, type ScopeLevel } from "../../auth/scopes";
import {
  clearSessionSetCookie,
  sessionCookieValue,
  sessionSetCookie,
  verifySession,
} from "../../ui/session";
import type { UserVisibilityDoer } from "../services/user";
import { federationAppUrl, resolveWebfinger } from "../../services/federation/webfinger";
import {
  findActorUserById,
  parseActorIdParam,
  resolvePersonDocument,
} from "../../services/federation/activitypub";
import {
  ACTIVITY_STREAMS_CONTENT_TYPE,
  FEDERATION_MAX_BODY_BYTES,
  readBodyBounded,
  verifyHttpSignature,
} from "../../services/federation/httpsig";

/**
 * The env slice the family reads. `FEDERATION_ENABLED` rides wrangler `vars`
 * — BOTH configs declare it (default `"false"`), and the generated Env may
 * type it as that literal; this alias widens it back to `string | undefined`
 * so tests and any config shape stay assignable (the `FirstRunEnv` posture,
 * services/user-accounts.ts:108). `APP_URL` widens the same way (the
 * WebhookPushEnv posture, services/webhooks-push.ts:172).
 */
export type FederationEnv = Omit<Env, "FEDERATION_ENABLED" | "APP_URL"> & {
  /** `"true"` mounts the discovery pair + the activitypub arms; absent or
   *  any other value keeps the surface fail-closed at upstream's disabled
   *  bytes (web 404 `Not Found\n`, API router-native 404). */
  FEDERATION_ENABLED?: string;
  /** Upstream `setting.AppURL` — unset falls back to the request origin. */
  APP_URL?: string;
};

/**
 * The gate — ONLY the exact string `"true"` arms the family (the
 * strict-polarity class: DEMO_MODE, MAIL_ENABLED); absent, empty, or any
 * other value stays disabled. Upstream's bool default is false
 * (modules/setting/federation.go:23); ours fails closed identically.
 */
export function federationEnabled(env: FederationEnv): boolean {
  return env.FEDERATION_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Go http.Error byte-shape helpers
// ---------------------------------------------------------------------------

/**
 * Go's `http.Error` (net/http/server.go, the writer behind BOTH
 * `ctx.HTTPError` — services/context/base.go:105-111 — and the stub's
 * `activitypub.NotImplemented`): status line, `Content-Type: text/plain;
 * charset=utf-8`, `X-Content-Type-Options: nosniff`, body `text + "\n"`.
 */
function goHttpError(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The disabled API arm — the router's native not-found bytes (Hono's
 *  default handler: `c.text("404 Not Found", 404)`), the "absent from the
 *  router" posture api.go:1007's registration conditional produces. */
function routerNativeNotFound(c: Context<ApiEnv>): Response {
  return c.text("404 Not Found", 404);
}

/** chi v5.4.0's methodMap (tree.go — incl. the RFC-10008 QUERY placeholder,
 *  `methodQuery`): the methods whose 405 carries the `Allow` header. An
 *  unknown method misses the map and bare-405s pre-tree (mux.go routeHTTP's
 *  early arm — before any lookup, registration, or middleware). */
const CHI_KNOWN_METHODS: ReadonlySet<string> = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "QUERY",
  "TRACE",
]);

/** chi's default methodNotAllowedHandler (mux.go:532-540): empty body,
 *  `Allow` ADDED PER method (`w.Header().Add` — one wire line per method;
 *  the endpoint iteration is a Go map range, so upstream's line ORDER is
 *  unspecified — ours is the deterministic declaration order passed here);
 *  unknown methods 405 with NO Allow at all. Exported for the method-arm
 *  pins — workers' Request constructor cannot carry a non-methodMap token
 *  (BREW/QUERY both throw "Invalid HTTP method string"), so the bare-405
 *  byte shape is pinned at the helper, the byte shape being the surface. */
export function chiMethodNotAllowed(method: string, allow: string[]): Response {
  const response = new Response(null, { status: 405 });
  if (CHI_KNOWN_METHODS.has(method)) {
    for (const value of allow) response.headers.append("allow", value);
  }
  return response;
}

// ---------------------------------------------------------------------------
// The /.well-known pair — a plain Hono sub-app (non-contract web routes,
// the avatar-serving seam shape; upstream mounts them on the web mux,
// web.go:531-536, and the frozen OpenAPI contract has no operations here)
// ---------------------------------------------------------------------------

/** The session viewer for webfinger's visibility gate — the web seam's
 *  session arm (attachments-serving.ts:862-895): no cookie → anonymous with
 *  ZERO D1 reads; a dead cookie → anonymous + the clear directive; a live
 *  one → the `ctx.Doer` slice the IsUserVisibleToViewer ladder takes. The
 *  set-cookie directive travels on the response (rotation + clear), the
 *  same decision the attachments seam ships. */
async function resolveSessionDoer(
  env: FederationEnv,
  req: Request,
  options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<{ doer: UserVisibilityDoer; setCookie: string | null }> {
  const value = sessionCookieValue(req);
  if (value === null) {
    return { doer: { id: null, isAdmin: false, loginLower: null }, setCookie: null };
  }
  const verification = await verifySession(env.DB, value);
  const settle = (promise: Promise<unknown>): void => {
    if (options?.waitUntil === undefined) void promise.catch(() => {});
    else options.waitUntil(promise);
  };
  for (const work of verification.background) settle(work);
  if (verification.outcome !== "authenticated") {
    return {
      doer: { id: null, isAdmin: false, loginLower: null },
      setCookie: verification.clearCookie ? clearSessionSetCookie() : null,
    };
  }
  const { id, username, isAdmin } = verification.user;
  return {
    doer: { id, isAdmin, loginLower: username.toLowerCase() },
    setCookie: verification.setCookie === null ? null : sessionSetCookie(verification.setCookie, verification.remember),
  };
}

/** The execution-context sink, route-style: absent under direct
 *  `router.request()` test invocations — the resolver settles inline
 *  (the index.ts onError pattern, src/index.ts:122-127). */
function waitUntilOf(c: Context<{ Bindings: FederationEnv }>): ((promise: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}

export const wellKnownRouter = new Hono<{ Bindings: FederationEnv }>();

/**
 * GET /.well-known/nodeinfo — NodeInfoLinks (nodeinfo.go:23-31): one link,
 * `{appUrl}api/v1/nodeinfo`, rel = the nodeinfo 2.1 schema IRI. The
 * byte-shape is Go's compact struct marshal: `{"links":[{"href":…,"rel":…}]}`
 * (Href before Rel — the struct declares them in that order).
 *
 * The `.all` + method dispatch ports chi's tree arms: the endpoint resolves
 * only for GET (web.go:534 registers GET alone), so every known non-GET
 * method 405s with `Allow: GET` — gate-INDEPENDENTLY, the per-endpoint
 * gate never running for an unresolved method — and an unknown method
 * bare-405s (chiMethodNotAllowed's no-Allow arm).
 */
wellKnownRouter.all("/.well-known/nodeinfo", (c) => {
  const method = c.req.method;
  if (method !== "GET") {
    return chiMethodNotAllowed(method, ["GET"]);
  }
  if (!federationEnabled(c.env)) {
    // web.go:409-414 → ctx.HTTPError(404) → "Not Found\n" (base.go:105-111).
    return goHttpError(404, "Not Found");
  }
  const appUrl = federationAppUrl(c.env.APP_URL, new URL(c.req.url).origin);
  return c.json({
    links: [{ href: `${appUrl}api/v1/nodeinfo`, rel: "http://nodeinfo.diaspora.software/ns/schema/2.1" }],
  });
});

/**
 * GET /.well-known/webfinger — WebfingerQuery (webfinger.go:38-122). The
 * gate first (upstream's federationEnabled wrap), then the session viewer,
 * then the resolution ladder in services/federation/webfinger.ts. Error
 * arms are Go `http.Error` lines: 400 "Bad Request\n" (parse/scheme/host),
 * 404 "Not Found\n" (not-exist / suppressed / hidden). The JRD carries the
 * explicit `Access-Control-Allow-Origin: *` stamp (webfinger.go:116).
 *
 * Same chi tree dispatch as nodeinfo: the session viewer and the resolver
 * never run for a non-GET — chi's 405 answers before any endpoint
 * middleware (web.go:535 registers GET alone).
 */
wellKnownRouter.all("/.well-known/webfinger", async (c) => {
  const method = c.req.method;
  if (method !== "GET") {
    return chiMethodNotAllowed(method, ["GET"]);
  }
  if (!federationEnabled(c.env)) {
    return goHttpError(404, "Not Found");
  }

  const appUrl = federationAppUrl(c.env.APP_URL, new URL(c.req.url).origin);
  const appUrlHost = new URL(appUrl).host;
  const noreplyDomain = new URL(c.req.url).hostname;

  const { doer, setCookie } = await resolveSessionDoer(c.env, c.req.raw, { waitUntil: waitUntilOf(c) });
  const outcome = await resolveWebfinger(c.env.DB, c.req.query("resource")?.trim() ?? "", doer, {
    appUrl,
    host: appUrlHost,
    noreplyDomain,
  });

  const headers: Record<string, string> = {};
  if (setCookie !== null) headers["set-cookie"] = setCookie;

  switch (outcome.kind) {
    case "bad-request":
      return goHttpError(400, "Bad Request");
    case "not-found":
      return goHttpError(404, "Not Found");
    case "found": {
      // webfinger.go:116 — the in-handler CORS stamp, before the body.
      const response = c.json(outcome.jrd, 200, {
        "access-control-allow-origin": "*",
        ...headers,
      });
      return response;
    }
  }
});

// ---------------------------------------------------------------------------
// The gated API stubs — plain-Hono registrations on the /api/v1 OpenAPIHono
// app (the imports.ts carve: outside the generated document, check:api
// untouched — the pin's swagger carries zero /nodeinfo and /activitypub/*
// paths, SPEC §6.3)
// ---------------------------------------------------------------------------

/** Upstream's write-method set (api.go:287-289, mirrored in scope-gate.ts). */
function isWriteMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

/**
 * The `tokenRequiresScopes(ActivityPub)` port (api.go:1009), INLINE on the
 * route group exactly where upstream hangs it. Evaluation matches the
 * central gate byte-for-byte (scope-gate.ts:191-221): anonymous and
 * non-token credentials pass (upstream's early return,
 * api.go:281-283 — the stub answers them 501); a token whose scope misses
 * the method-derived level of the activitypub category answers upstream's
 * exact 403 body. The packages.ts groupScopeGate precedent: the central
 * table's row stays absent so the check never double-runs.
 */
const activitypubScopeGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const auth: AuthInfo | undefined = c.get("auth");
  if (auth?.scope === null || auth?.scope === undefined) {
    await next();
    return;
  }
  const level: ScopeLevel = isWriteMethod(c.req.method) ? "write" : "read";
  const required = requiredScopeNames(level, ["activitypub"]);
  if (!auth.scope.has(...required)) {
    const tokenScope = auth.token?.scopes ?? "";
    throw new ApiError(
      403,
      `token does not have at least one of required scope(s), required=[${required.join(" ")}], token scope=${tokenScope}`,
    );
  }
  await next();
};

/** `activitypub.NotImplemented` (person.go:12-14): Go http.Error with the
 *  literal "Not implemented" at 501 — the package's entire content at the
 *  pin. */
export function federationNotImplemented(): Response {
  return goHttpError(501, "Not implemented");
}

/**
 * routeHTTP's PRE-TREE arm (mux.go): a method outside chi's methodMap
 * bare-405s before any lookup — path-, registration-, and gate-independent.
 * Mounted as the first middleware on both API arms; the web pair inlines
 * the same check in-handler (chiMethodNotAllowed's no-Allow arm). Known
 * methods pass through to the chi tree semantics below.
 */
const chiUnknownMethodGuard: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!CHI_KNOWN_METHODS.has(c.req.method)) {
    return chiMethodNotAllowed(c.req.method, []);
  }
  await next();
};

/**
 * The API arms' gate — the registration conditional (api.go:1007) rendered
 * as middleware: disabled answers the router's native not-found (the
 * unregistered-path posture, see the module header), enabled falls through
 * to the stub.
 */
const federationApiGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!federationEnabled(c.env)) {
    return routerNativeNotFound(c);
  }
  await next();
};

// ---------------------------------------------------------------------------
// The activitypub arms — Tier B (SPEC §6.2 as-built)
// ---------------------------------------------------------------------------

/**
 * chi's per-endpoint method arm: the endpoint registers ONE method, so a
 * known method other than it resolves no endpoint and chi's DEFAULT
 * methodNotAllowedHandler answers (empty body, `Allow` per registered
 * method) BEFORE any endpoint middleware — group middleware (the scope
 * gate) folds into ENDPOINT registrations, never into the 405.
 */
function chiMethodGuard(allowed: string[]): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.req.method !== allowed[0]) {
      return chiMethodNotAllowed(c.req.method, allowed);
    }
    await next();
  };
}

/** The API arms read the appOrigin chain through the widened slice (the
 *  generated Env's var literals stay assignable to the optional string). */
function federationEnvOf(c: Context<ApiEnv>): FederationEnv {
  return c.env;
}

/** The actor IRI for a user row — `{AppURL}api/v1/activitypub/user-id/{id}`. */
function actorIriOf(appUrl: string, userId: number): string {
  return `${appUrl}api/v1/activitypub/user-id/${userId}`;
}

/**
 * The Person actor (person.go:20-79 at `1592576fa5^`): UserIDAssignmentAPI
 * first — garbage id → 0, unknown id → ApiError 404 with ErrUserNotExist's
 * exact text — then the document (keypair lazily generated on first serve)
 * at the ActivityStreams content type. `checkTokenPublicOnly()` (the
 * pre-stub group's second middleware) is a no-op for this surface: it
 * blanks ContextUser EMAIL serializations for public-only tokens, and the
 * Person document carries none — nothing to port.
 */
async function personHandler(c: Context<ApiEnv>): Promise<Response> {
  const id = parseActorIdParam(c.req.param("id"));
  const appUrl = federationAppUrl(federationEnvOf(c).APP_URL, new URL(c.req.url).origin);
  const resolved = await resolvePersonDocument(c.env.DB, id, { appUrl });
  if (resolved === undefined) {
    throw new ApiError(404, `user does not exist [uid: ${id}, name: ]`);
  }
  return c.body(JSON.stringify(resolved.person), 200, { "content-type": ACTIVITY_STREAMS_CONTENT_TYPE });
}

/** The Follow activity's actor IRI — the string form, or an embedded
 *  object's `id` (both legal ActivityStreams). */
function activityActorIri(activity: Record<string, unknown>): string | null {
  const actor = activity["actor"];
  if (typeof actor === "string") return actor;
  if (typeof actor === "object" && actor !== null) {
    const id = (actor as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * The inbox (person.go:81-96's PersonInbox behind reqsignature.go's
 * middleware, in upstream's middleware order — UserIDAssignmentAPI runs
 * BEFORE the signature, so an unknown target 404s without any verification
 * work):
 *   1. the size-capped body read (SPEC §3.1 — the black hole never read
 *      the body; ours must, and the read is the streamed-bounded posture);
 *   2. verifyHttpSignature — error arm → thrown (house 500, upstream
 *      APIErrorInternal), rejected arm → the exact 403 body (:91-93);
 *   3. the Follow → Accept ladder (the user's completion directive; the
 *      Accept rides the RESPONSE — no follower store is sanctioned and no
 *      delivery lane exists, so nothing is persisted and nothing is sent
 *      outbound; SPEC §6.2 as-built records the remaining tier) — every
 *      other activity keeps the upstream 204 black hole. Malformed JSON →
 *      400 (an arm the black hole never needed; it never looked).
 */
async function inboxHandler(c: Context<ApiEnv>, opts: { fetchImpl?: typeof fetch }): Promise<Response> {
  const id = parseActorIdParam(c.req.param("id"));
  const target = await findActorUserById(c.env.DB, id);
  if (target === undefined) {
    throw new ApiError(404, `user does not exist [uid: ${id}, name: ]`);
  }
  const user = resolveInboxTarget(target);

  const spool = await readBodyBounded(c.req.raw, FEDERATION_MAX_BODY_BYTES);
  if (!spool.ok) {
    throw new ApiError(413, "request body exceeds the federation maximum size");
  }

  const url = new URL(c.req.url);
  const outcome = await verifyHttpSignature(
    { method: "POST", pathWithQuery: `${url.pathname}${url.search}`, header: (name) => c.req.header(name) },
    spool.body,
    { fetchImpl: opts.fetchImpl },
  );
  if (outcome.kind === "error") {
    throw new Error(`activitypub signature verification: ${outcome.reason}`);
  }
  if (outcome.kind === "rejected") {
    throw new ApiError(403, "request signature verification failed");
  }

  const appUrl = federationAppUrl(federationEnvOf(c).APP_URL, new URL(c.req.url).origin);
  const actorIri = actorIriOf(appUrl, user.id);

  let activity: unknown;
  try {
    activity = JSON.parse(new TextDecoder().decode(spool.body));
  } catch {
    throw new ApiError(400, "Bad Request");
  }
  if (typeof activity === "object" && activity !== null && (activity as Record<string, unknown>).type === "Follow") {
    const follow = activity as Record<string, unknown>;
    const follower = activityActorIri(follow);
    const accept: Record<string, unknown> = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorIri}#accepts/${crypto.randomUUID()}`,
      type: "Accept",
      actor: actorIri,
      ...(follower === null ? {} : { to: follower }),
      object: follow,
    };
    return c.body(JSON.stringify(accept), 200, { "content-type": ACTIVITY_STREAMS_CONTENT_TYPE });
  }
  // Upstream PersonInbox: `ctx.Status(http.StatusNoContent)` — the black hole.
  return c.body(null, 204);
}

/** Inbox-side target lookup — the same GetUserByID arm as the actor,
 *  without the keypair work (upstream's middleware order: the assignment
 *  middleware runs first; the signature middleware never fires for an
 *  unknown target). */
function resolveInboxTarget(user: { id: number }): { id: number } {
  return { id: user.id };
}

/**
 * Register the gated family on the /api/v1 router (the orchestrator's
 * createApiRouter calls this beside the other families — HANDOFF §6.1).
 * chi-exact method arms:
 *   GET /api/v1/nodeinfo                    api.go:1008 — the W-B1 501 stub,
 *                                           no scope gate (upstream's
 *                                           registration carries none).
 *                                           Disabled, the path is
 *                                           UNREGISTERED: every known
 *                                           method → the mux's native
 *                                           not-found. Enabled, the
 *                                           GET-only endpoint 501s and
 *                                           every other known method
 *                                           tree-405s with `Allow: GET`.
 *   GET /api/v1/activitypub/user-id/{id}    api.go:946-949 at `1592576fa5^`
 *                                           (UserIDAssignmentAPI +
 *                                           checkTokenPublicOnly + the
 *                                           group scope gate) → the Person
 *                                           actor; other known methods
 *                                           tree-405 `Allow: GET`.
 *   POST /api/v1/activitypub/user-id/{id}/inbox
 *                                           api.go:948 (UserIDAssignmentAPI
 *                                           + checkTokenPublicOnly +
 *                                           ReqHTTPSignature + the group
 *                                           scope gate) → the inbox ladder;
 *                                           other known methods tree-405
 *                                           `Allow: POST`.
 * Every other /activitypub/* path (incl. the deprecated `/user/{username}`
 * group, api.go:941-945's "remove in 1.20" form) stays UNREGISTERED — the
 * router's native 404, exactly upstream's unregistered-path posture.
 * Both armed paths: unknown methods bare-405 pre-tree (the guard above) —
 * gate-independent, exactly mux.go's early arm.
 *
 * `opts.fetchImpl` is the test seam for the verifier's outbound
 * actor-document fetch (SPEC §7's env-boundary stubbing; production omits
 * it and the global fetch runs).
 */
export function registerFederationApiRoutes(app: OpenAPIHono<ApiEnv>, opts: { fetchImpl?: typeof fetch } = {}): void {
  app.all("/nodeinfo", chiUnknownMethodGuard, (c) => {
    if (!federationEnabled(c.env)) {
      return routerNativeNotFound(c);
    }
    if (c.req.method !== "GET") {
      return chiMethodNotAllowed(c.req.method, ["GET"]);
    }
    return federationNotImplemented();
  });
  app.all(
    "/activitypub/user-id/:id",
    chiUnknownMethodGuard,
    federationApiGate,
    chiMethodGuard(["GET"]),
    activitypubScopeGate,
    (c) => personHandler(c),
  );
  app.all(
    "/activitypub/user-id/:id/inbox",
    chiUnknownMethodGuard,
    federationApiGate,
    chiMethodGuard(["POST"]),
    activitypubScopeGate,
    (c) => inboxHandler(c, opts),
  );
}
