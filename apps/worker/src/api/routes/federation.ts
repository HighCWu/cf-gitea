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
 * The whole /.well-known group rides upstream's optionsCorsHandler
 * (web.go:542) — a no-op without [cors] config, which cf-gitea does not
 * surface; OPTIONS therefore falls through to the router's native 404 here
 * exactly as it does upstream. webfinger stamps its own
 * `Access-Control-Allow-Origin: *` in-handler (webfinger.go:116), gate-open
 * only — the discovery tier is the gate's payload, disabled = absent.
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

/**
 * The env slice the family reads. `FEDERATION_ENABLED` rides wrangler `vars`
 * — BOTH configs declare it (default `"false"`), and the generated Env may
 * type it as that literal; this alias widens it back to `string | undefined`
 * so tests and any config shape stay assignable (the `FirstRunEnv` posture,
 * services/user-accounts.ts:108). `APP_URL` widens the same way (the
 * WebhookPushEnv posture, services/webhooks-push.ts:172).
 */
export type FederationEnv = Omit<Env, "FEDERATION_ENABLED" | "APP_URL"> & {
  /** `"true"` mounts the discovery pair + the 501 stubs; absent or any
   *  other value keeps the surface fail-closed at upstream's disabled
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
 */
wellKnownRouter.get("/.well-known/nodeinfo", (c) => {
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
 */
wellKnownRouter.get("/.well-known/webfinger", async (c) => {
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

/**
 * Register the gated stubs on the /api/v1 router (the orchestrator's
 * createApiRouter calls this beside the other families — HANDOFF §6.1).
 * Both arms answer `Not implemented\n` at 501 when enabled:
 *   GET /api/v1/nodeinfo          api.go:1008 — no scope gate (upstream's
 *                                 registration carries none).
 *   ANY /api/v1/activitypub/*     api.go:1009 — the activitypub scope gate
 *                                 rides between the enable gate and the stub.
 */
export function registerFederationApiRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.get("/nodeinfo", federationApiGate, () => federationNotImplemented());
  app.all("/activitypub/*", federationApiGate, activitypubScopeGate, () => federationNotImplemented());
}
