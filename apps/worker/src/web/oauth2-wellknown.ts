/**
 * The OIDC discovery document (SPEC specs/oauth2-provider.md §2.6 — W4):
 * GET /.well-known/openid-configuration, ported from the pin's
 * `routers/web/auth/oauth2_wellknown.go` (registered at web.go:531-532,
 * OUTSIDE the /login/oauth group — the handler self-gates).
 *
 * ## The gate (oauth2_wellknown.go:17-20)
 *
 * Unlike the /login/oauth family (the group 403 wrap, web.go:373-378/631),
 * the well-known handler checks `setting.OAuth2.Enabled` ITSELF and answers
 * Go `http.NotFound` — the plain `404 page not found\n` text line (net/http
 * http.Error shape: `text/plain; charset=utf-8` + nosniff), NOT 403. An
 * unauthorized client must not learn the provider exists while disabled.
 *
 * ## Byte shape
 *
 * Upstream builds ONE Go `map[string]any` and hands it to `ctx.JSON`
 * (oauth2_wellknown.go:25-68) — jsonv2 (modules/json/jsonv2.go, the same
 * writer the token endpoint uses) emits map members in SORTED KEY ORDER,
 * compact, no trailing newline, slice values in declaration order. Every
 * top-level key below is therefore spelled in ALPHABETICAL order; the
 * arrays keep their upstream order verbatim. Content-Type is ctx.JSON's
 * `application/json;charset=utf-8` (services/context/base.go:114-116).
 *
 * The issuer rides the SAME source the id_token's `iss` claim uses —
 * `NewJwtRegisteredClaimsFromUser("well-known", 0, nil)` at
 * oauth2_wellknown.go:21-22 reads `[oauth2] JWT_CLAIM_ISSUER` or the AppURL
 * sans trailing slash (access_token.go:136-152; openid-connect-discovery
 * §4: the issuer MUST equal the URL the document was fetched from) — so
 * this module calls the landed `oauth2Issuer` (services/oauth2/token.ts),
 * one source for both surfaces. The ENDPOINT URLs always derive from the
 * AppURL (the pin trims it at :23 — the JWT_CLAIM_ISSUER override only
 * moves the `issuer` member, never the endpoints).
 *
 * `id_token_signing_alg_values_supported` publishes EXACTLY the configured
 * algorithm (DefaultSigningKey.SigningMethod().Alg(), :35-37) — resolved
 * through the landed keys-service seam `resolveSigningAlgorithm`
 * (services/oauth2/keys.ts), the same parse the JWKS route's key material
 * loads with, so the document can never advertise an alg the key does not
 * speak.
 *
 * MOUNT HANDOFF (src/index.ts, orchestrator-owned — this module does not
 * touch the shared index; the federation wellKnownRouter's INTEGRATION
 * note is the pattern):
 *   1. `app.route("/", oauth2WellKnownRouter);` beside the federation
 *      `wellKnownRouter` mount (before uiRouter — the /.well-known carve
 *      at the dispatcher's repo-scoped branch already exists, so a
 *      /.well-known/* request never reaches the engine);
 *   2. no API contract op: the frozen OpenAPI surface gains nothing (the
 *      document is a web route like the federation pair — verified by
 *      `pnpm check:api` staying PASS).
 */

import { Hono, type Context } from "hono";

import { GENERAL_SCOPES_SUPPORTED, oauth2AppUrl, oauth2FeatureEnabled, oauth2Issuer } from "../services/oauth2/token";
import { resolveSigningAlgorithm } from "../services/oauth2/keys";

/**
 * The env slice the route reads. The OAuth2 vars ride wrangler `vars`
 * (declared in wrangler.jsonc.example by W4 — this file's posture is the
 * landed OAuth2TokenEnv alias): the generated Env may not type them yet,
 * so the alias widens them back to `string | undefined` and tests/config
 * shapes stay assignable.
 */
export type OAuth2WellKnownEnv = Omit<Env, "OAUTH2_ENABLED" | "OAUTH2_SIGNING_ALGORITHM" | "OAUTH2_JWT_CLAIM_ISSUER" | "APP_URL"> & {
  /** Strict polarity: ONLY the exact string "false" disables (default true
   *  is upstream's — modules/setting/oauth2.go:104). */
  OAUTH2_ENABLED?: string;
  /** The signing alg, default RS256 (modules/setting/oauth2.go:108). */
  OAUTH2_SIGNING_ALGORITHM?: string;
  /** `[oauth2] JWT_CLAIM_ISSUER` — the issuer override (access_token.go:
   *  142-145). Moves the `issuer` member only, never the endpoints. */
  OAUTH2_JWT_CLAIM_ISSUER?: string;
  /** Upstream `setting.AppURL` — unset falls back to the request origin. */
  APP_URL?: string;
};

/** Go `http.Error` (net/http/server.go) — the writer behind BOTH
 *  `ctx.HTTPError` (services/context/base.go:105-111) and `http.NotFound`
 *  (which calls `Error(w, "404 page not found", 404)`): body + "\n",
 *  `Content-Type: text/plain; charset=utf-8` (net/http's own spelling,
 *  WITH the space — Gitea's PlainText omits it, http.Error does not),
 *  `X-Content-Type-Options: nosniff`. */
function goHttpError(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The well-known doc's key order — upstream marshals a MAP, jsonv2 emits
 *  map members sorted; the arrays below carry the pin's exact member
 *  order (oauth2_wellknown.go:32-66). */
function discoveryDocument(issuer: string, baseUrl: string, signingAlg: string): Record<string, unknown> {
  return {
    authorization_endpoint: `${baseUrl}/login/oauth/authorize`,
    claims_supported: [
      "aud",
      "exp",
      "iat",
      "iss",
      "sub",
      "name",
      "preferred_username",
      "profile",
      "picture",
      "website",
      "locale",
      "updated_at",
      "email",
      "email_verified",
      "groups",
    ],
    code_challenge_methods_supported: ["plain", "S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    id_token_signing_alg_values_supported: [signingAlg],
    introspection_endpoint: `${baseUrl}/login/oauth/introspect`,
    issuer,
    jwks_uri: `${baseUrl}/login/oauth/keys`,
    response_types_supported: ["code"],
    scopes_supported: [...GENERAL_SCOPES_SUPPORTED],
    subject_types_supported: ["public"],
    token_endpoint: `${baseUrl}/login/oauth/access_token`,
    userinfo_endpoint: `${baseUrl}/login/oauth/userinfo`,
  };
}

/** OIDCWellKnown (oauth2_wellknown.go:16-69): the self-gated discovery
 *  document — 404 when the provider is disabled, the map-ordered document
 *  otherwise. */
function oidcWellKnown(c: Context<{ Bindings: OAuth2WellKnownEnv }>): Response {
  if (!oauth2FeatureEnabled(c.env)) {
    // oauth2_wellknown.go:17-20 — http.NotFound(ctx.Resp, ctx.Req).
    return goHttpError(404, "404 page not found");
  }
  const origin = new URL(c.req.url).origin;
  // The issuer from the JWT registered-claims source (:21-22); the endpoint
  // base from the AppURL (:23) — two different derivations upstream, kept
  // two here (the JWT_CLAIM_ISSUER override moves only the issuer).
  const issuer = oauth2Issuer(c.env, origin);
  const baseUrl = oauth2AppUrl(c.env.APP_URL, origin).replace(/\/+$/, "");
  const signingAlg = resolveSigningAlgorithm(c.env.OAUTH2_SIGNING_ALGORITHM);
  const body = JSON.stringify(discoveryDocument(issuer, baseUrl, signingAlg));
  // ctx.JSON's Content-Type (base.go:114-116); compact, no trailing newline.
  return new Response(body, { status: 200, headers: { "content-type": "application/json;charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// The sub-app — a plain Hono seam (the federation wellKnownRouter shape;
// the frozen OpenAPI contract has no operation here)
// ---------------------------------------------------------------------------

export const oauth2WellKnownRouter = new Hono<{ Bindings: OAuth2WellKnownEnv }>();

oauth2WellKnownRouter.get("/.well-known/openid-configuration", (c) => oidcWellKnown(c));
