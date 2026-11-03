/**
 * The OAuth2 provider's stateless JSON arms (SPEC specs/oauth2-provider.md
 * §2.3/§2.6 — W2): the token endpoint, introspection, userinfo and the
 * JWKS, one plain-Hono sub-app beside the avatar/attachments/well-known
 * seams. The authorize + consent pair (GET/POST /login/oauth/authorize +
 * POST /login/oauth/grant) is W3's and will join this mount family.
 *
 * ## Route home decision (SPEC open question 1)
 *
 * The SPEC recommends the session-bound UI family for /login/oauth as a
 * whole; only W3's arms ARE session pages. These four are stateless JSON —
 * the attachments-serving/wellKnownRouter shape (a sub-app mounted at "/"
 * before uiRouter, the dispatcher's repo-scoped branch carved for the
 * "login" prefix). REGISTRATION HANDOFF (src/index.ts, executed):
 *   1. the isRepoScoped carve: `segments[0] !== "login"` — a 3-segment
 *      /login/oauth/* path falls to the engine's headless 404 otherwise
 *      (the /.well-known carve's twin, web.go's group at :617-631);
 *   2. `app.route("/", oauth2Router)` BEFORE uiRouter (the first-run
 *      HANDOFF's precedence finding — literal routes must not race the
 *      /:owner/:repo parser shapes).
 *
 * ## The CORS/OPTIONS posture (web.go:61-87 verbatim)
 *
 * The whole upstream group rides optionsCorsHandler; with [cors] disabled
 * (cf-gitea surfaces no CORS config) an OPTIONS request — with or without
 * Access-Control-Request-Method — is denied with a BARE 405 and no CORS
 * headers (:79-82 "it should explicitly deny OPTIONS requests..."). The
 * per-path `.all` fallbacks below also give the wrong-method arms chi's
 * body-empty 405 (the mux's MethodNotAllowedHandler default).
 *
 * ## The gate (W4's wrap — live)
 *
 * Upstream wraps the group in `oauth2Enabled` (403 when disabled,
 * web.go:373-378/631) — the OAUTH2_ENABLED 403 middleware below is that
 * wrap, the OUTERMOST group middleware (upstream's group option runs
 * before optionsCorsHandler, so a disabled provider answers 403 for every
 * method INCLUDING the bare-OPTIONS probes; enabled, those still take the
 * 405 deny arms). The API-side half of the gate (a disabled provider kills
 * its tokens — services/auth/oauth2.go:32-34) rides
 * resolveOAuth2AccessTokenCredential and stays live via
 * oauth2FeatureEnabled.
 *
 * ## Byte shapes
 *
 * ctx.JSON (services/context/base.go:114-116 → modules/json/jsonv2.go):
 * compact, struct member order, nil slices null, no trailing newline, and
 * the `application/json;charset=utf-8` Content-Type (the jsonResponse
 * helper — hono's c.json emits a bare "application/json", the v1.5.2 F4
 * fix) — services/oauth2/token.ts builds every body in Go struct order. The
 * plain
 * error lines are Go's PlainText (text/plain;charset=utf-8 + nosniff, no
 * newline). OIDCKeys writes its own Content-Type "application/json" and
 * marshals a MAP — Go sorts map keys, so the JWK members are emitted
 * alphabetically (jwtsigningkey.go's ToJWK maps).
 */

import { Hono, type Context } from "hono";

import { verifyClientSecret } from "../api/services/oauth2-apps";
import { parseAuthorizationHeader } from "../auth/httpauth";
import { ScopeSet } from "../auth/scopes";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { users } from "../db/schema";
import {
  getGrantByID,
  getAuthorizationByCode,
  consumeAuthorizationCode,
  grantScopeContains,
  isAuthorizationCodeExpired,
  ErrOAuth2AuthorizationCodeInvalidated,
  type OAuth2ApplicationRow,
  type OAuth2GrantRow,
} from "../services/oauth2/grants";
import { verifyJws } from "../services/oauth2/jws";
import { oauth2Jwks } from "../services/oauth2/keys";
import {
  accessTokenError,
  buildUserInfoResponse,
  getOAuth2ApplicationByClientID,
  importClientKey,
  loadOAuth2SigningMaterial,
  mintTokenTrio,
  normalizeGrantScope,
  oauth2AppUrl,
  oauth2FeatureEnabled,
  oauth2Issuer,
  resolveUserInfoCredential,
  validateCodeChallenge,
  type AccessTokenErrorShape,
  type OAuth2SigningMaterial,
  type OAuth2UserRow,
} from "../services/oauth2/token";

/**
 * The env slice the routes read. The OAuth2 vars ride wrangler `vars`; W4's
 * plumbing adds them to wrangler.jsonc.example, so the generated Env may
 * not type them yet — this alias widens them back to `string | undefined`
 * (the FederationEnv/FirstRunEnv posture) so tests and any config shape
 * stay assignable.
 */
export type OAuth2TokenEnv = Omit<
  Env,
  "OAUTH2_ENABLED" | "OAUTH2_SIGNING_ALGORITHM" | "OAUTH2_JWT_CLAIM_ISSUER" | "OAUTH2_INVALIDATE_REFRESH_TOKENS" | "APP_URL"
> & {
  /** Strict polarity: ONLY the exact string "false" disables (default true
   *  is upstream's — modules/setting/oauth2.go:104). */
  OAUTH2_ENABLED?: string;
  /** The signing alg, default RS256 (modules/setting/oauth2.go:108). */
  OAUTH2_SIGNING_ALGORITHM?: string;
  /** `[oauth2] JWT_CLAIM_ISSUER` — the issuer override, default the AppURL
   *  sans trailing slash (access_token.go:142-145). */
  OAUTH2_JWT_CLAIM_ISSUER?: string;
  /** `[oauth2] INVALIDATE_REFRESH_TOKENS` — strict polarity, ONLY the exact
   *  string "true" enables; the default false is the no-default-rotation
   *  trap (token.ts's module header). */
  OAUTH2_INVALIDATE_REFRESH_TOKENS?: string;
  /** Upstream `setting.AppURL` — unset falls back to the request origin. */
  APP_URL?: string;
};

/** The InvalidateRefreshTokens posture — ONLY the exact string "true"
 *  enables (the DEMO_MODE class); the default false keeps refresh tokens
 *  reusable until expiry (upstream's default, modules/setting/oauth2.go:
 *  107). */
export function invalidateRefreshTokens(env: OAuth2TokenEnv): boolean {
  return env.OAUTH2_INVALIDATE_REFRESH_TOKENS === "true";
}

// ---------------------------------------------------------------------------
// Byte-shape helpers
// ---------------------------------------------------------------------------

/** Upstream ctx.PlainText (services/context/base.go:128-137): the type is
 *  `text/plain;charset=utf-8` (NO space), nosniff, body verbatim. */
function plainTextResponse(status: 401 | 403 | 500, text: string, extraHeaders?: Record<string, string>): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff", ...(extraHeaders ?? {}) },
  });
}

/** Upstream ctx.JSON (services/context/base.go:114-116): the Content-Type is
 *  `application/json;charset=utf-8` (NO space), body JSON.stringify. The
 *  v1.5.2 F4 fix — hono's c.json emits a bare "application/json" (no
 *  charset), diverging from the pin on every JSON arm below. */
function jsonResponse(c: Context<{ Bindings: OAuth2TokenEnv }>, body: unknown, status: 200 | 400): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json;charset=utf-8" } });
}

/** The RFC 6749 §5.2 error body at 400 (oauth2_provider.go:722-724 —
 *  ctx.JSON of AccessTokenError; member order error, error_description). */
function tokenErrorResponse(c: Context<{ Bindings: OAuth2TokenEnv }>, err: AccessTokenErrorShape): Response {
  return jsonResponse(c, { error: err.error, error_description: err.error_description }, 400);
}

/** optionsCorsHandler's deny arm (:79-82): bare 405, empty body, no CORS
 *  headers — plus chi's wrong-method default (the mux's
 *  MethodNotAllowedHandler writes the status line only). */
function methodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

/**
 * RFC 6749 §2.3.1 — client_secret_basic credentials are form-urlencoded
 * inside the Basic pair (parseClientSecretBasic, oauth2_provider.go:135-143
 * over httpauth.ParseAuthorizationHeader). Go's url.QueryUnescape: "+"
 * decodes to space and malformed % escapes are ERRORS (ok=false).
 */
export function parseClientSecretBasic(authHeader: string | undefined): { clientId: string; clientSecret: string; ok: boolean } {
  if (authHeader === undefined) {
    return { clientId: "", clientSecret: "", ok: false };
  }
  const parsed = parseAuthorizationHeader(authHeader);
  const basic = parsed?.basicAuth ?? null;
  if (basic === null) {
    return { clientId: "", clientSecret: "", ok: false };
  }
  const clientId = queryUnescape(basic.username);
  const clientSecret = queryUnescape(basic.password);
  if (clientId === null || clientSecret === null) {
    return { clientId: "", clientSecret: "", ok: false };
  }
  return { clientId, clientSecret, ok: true };
}

/** Go url.QueryUnescape's JS twin: "+" → " ", %XX decoded, malformed
 *  escapes → null (Go's EscapeError → ok=false). */
function queryUnescape(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * The token/introspect form (web.Bind over forms.AccessTokenForm /
 * IntrospectTokenForm — SPEC §2.1): the RFC 6749 shape is
 * application/x-www-form-urlencoded; upstream's binder also accepts JSON
 * (SPEC §4.16(g)) and the URL query (Go r.Form merges query + body, body
 * values winning — FormValue reads the merged slice). Empty segments skip.
 */
export async function parseTokenForm(req: Request): Promise<Record<string, string>> {
  // Go r.Form merges query + body with the BODY values first (FormValue
  // reads the head of the merged slice) — so body values OVERWRITE query
  // values of the same key here.
  const merged: Record<string, string> = {};
  const absorb = (params: URLSearchParams): void => {
    for (const [key, value] of params) {
      merged[key] = value;
    }
  };
  absorb(new URL(req.url).searchParams);
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = JSON.parse(await req.text());
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") merged[key] = value;
        }
      }
    } catch {
      // a malformed JSON body falls through with the query's values —
      // upstream's binder answers the validation arm with empty fields,
      // which lands on the same unknown-grant_type / inactive arms below.
    }
  } else {
    absorb(new URLSearchParams(await req.text()));
  }
  return merged;
}

/** The request-scoped AppURL (the AppURL shape with trailing slash). */
function appUrlOf(c: Context<{ Bindings: OAuth2TokenEnv }>): string {
  return oauth2AppUrl(c.env.APP_URL, new URL(c.req.url).origin);
}

// ---------------------------------------------------------------------------
// The sub-app
// ---------------------------------------------------------------------------

export const oauth2Router = new Hono<{ Bindings: OAuth2TokenEnv }>();

/** ctx.HTTPError(http.StatusForbidden) (services/context/base.go:105-111 →
 *  net/http http.Error): body "Forbidden\n", `text/plain; charset=utf-8`
 *  (WITH the space — http.Error's own spelling; Gitea's PlainText omits
 *  it), nosniff. */
function httpForbidden(): Response {
  return new Response("Forbidden\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// The group wrap (W4): oauth2Enabled (web.go:373-378 — setting.OAuth2.Enabled
// false ⇒ 403) as the OUTERMOST middleware of this group, exactly upstream's
// group option order (it runs before optionsCorsHandler, so a disabled
// provider 403s even the OPTIONS probes). Registered FIRST so it wraps every
// route below (Hono composes in registration order). The well-known route
// answers 404 instead (oauth2_wellknown.go:17-20 — it self-gates).
oauth2Router.use("*", async (c, next) => {
  if (!oauth2FeatureEnabled(c.env)) {
    return httpForbidden();
  }
  await next();
});

// ---------------------------------------------------------------------------
// POST /login/oauth/access_token (AccessTokenOAuth, oauth2_provider.go:506-564)
// ---------------------------------------------------------------------------

oauth2Router.post("/login/oauth/access_token", async (c) => {
  const form = await parseTokenForm(c.req.raw);
  // Client authentication (:508-537): form client_id/client_secret; when
  // EITHER is missing the Basic header is parsed and body values that
  // disagree are invalid_request. No client secret at all is legitimate
  // (public clients).
  let clientId = form.client_id ?? "";
  let clientSecret = form.client_secret ?? "";
  if (clientId === "" || clientSecret === "") {
    const authHeader = c.req.header("Authorization");
    if (authHeader !== undefined && authHeader !== "") {
      const basic = parseClientSecretBasic(authHeader);
      if (!basic.ok) {
        return tokenErrorResponse(c, accessTokenError("invalidRequest", "cannot parse basic auth header"));
      }
      if (clientId !== "" && clientId !== basic.clientId) {
        return tokenErrorResponse(c, accessTokenError("invalidRequest", "client_id in request body inconsistent with Authorization header"));
      }
      clientId = basic.clientId;
      if (clientSecret !== "" && clientSecret !== basic.clientSecret) {
        return tokenErrorResponse(c, accessTokenError("invalidRequest", "client_secret in request body inconsistent with Authorization header"));
      }
      clientSecret = basic.clientSecret;
    }
  }

  // serverKey/clientKey (:539-551): the id_token's HS arm signs with the
  // client secret — an unimportable client key is upstream's create-key
  // failure arm.
  let material: OAuth2SigningMaterial;
  try {
    material = await loadOAuth2SigningMaterial(c.env.DB, c.env.OAUTH2_SIGNING_ALGORITHM);
  } catch (error) {
    console.error("oauth2: signing key load failed", error);
    return plainTextResponse(500, "Internal Server Error");
  }
  let clientKey: { key: CryptoKey; kid?: string };
  try {
    clientKey = await importClientKey(material, clientSecret);
  } catch {
    return tokenErrorResponse(c, accessTokenError("invalidRequest", "Error creating signing key"));
  }

  switch (form.grant_type ?? "") {
    case "refresh_token":
      return await handleRefreshToken(
        c,
        { clientId, clientSecret, refreshToken: form.refresh_token ?? "" },
        material,
        clientKey,
        invalidateRefreshTokens(c.env),
      );
    case "authorization_code":
      return await handleAuthorizationCode(
        c,
        { clientId, clientSecret, code: form.code ?? "", redirectUri: form.redirect_uri ?? "", codeVerifier: form.code_verifier ?? "" },
        material,
        clientKey,
        invalidateRefreshTokens(c.env),
      );
    default:
      return tokenErrorResponse(
        c,
        accessTokenError("unsupportedGrantType", "Only refresh_token or authorization_code grant type is supported"),
      );
  }
});

interface AuthorizationCodeForm {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/**
 * handleAuthorizationCode (oauth2_provider.go:633-720) — the arm order IS
 * the observable surface: every failure below is the next arm's guard.
 */
async function handleAuthorizationCode(
  c: Context<{ Bindings: OAuth2TokenEnv }>,
  form: AuthorizationCodeForm,
  material: OAuth2SigningMaterial,
  clientKey: { key: CryptoKey; kid?: string },
  rotate: boolean,
): Promise<Response> {
  const db = c.env.DB;
  // 1. unknown client — note the SINGLE-quoted %s (vs refresh's %q below).
  const app = await getOAuth2ApplicationByClientID(db, form.clientId);
  if (app === null) {
    return tokenErrorResponse(c, accessTokenError("invalidClient", `cannot load client with client id: '${form.clientId}'`));
  }
  // 2. confidential clients MUST present a valid secret (unauthorized_client
  //    here; the refresh twin says invalid_client — port both verbatim).
  if (app.confidentialClient && !(await validateSecret(app, form.clientSecret))) {
    const description = form.clientSecret === "" ? "invalid empty client secret" : "invalid client secret";
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", description));
  }
  // 3. a presented redirect_uri must be in the registered list.
  if (form.redirectUri !== "" && !containsRedirectUri(app, form.redirectUri)) {
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", "unexpected redirect URI"));
  }
  // 4. load the code (miss ⇒ "client is not authorized").
  const authorization = await getAuthorizationByCode(db, form.code);
  if (authorization === null) {
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", "client is not authorized"));
  }
  const { code, grant } = authorization;
  // 5. expiry: invalidate on discovery, then the invalid_grant line.
  const now = new Date();
  if (isAuthorizationCodeExpired(code, now)) {
    await consumeAuthorizationCode(db, code.id).catch(() => {});
    return tokenErrorResponse(c, accessTokenError("invalidGrant", "authorization code expired"));
  }
  // 6. PKCE verify (ValidateCodeChallenge — constant-time).
  if (!(await validateCodeChallenge(code, form.codeVerifier))) {
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", "failed PKCE code challenge"));
  }
  // 7. the code's stored redirect must equal the presented one (raw string
  //    compare — the loopback variance is the MEMBERSHIP check only, §4.4).
  if (code.redirectUri !== "" && form.redirectUri !== code.redirectUri) {
    return tokenErrorResponse(c, accessTokenError("invalidGrant", "redirect_uri differs from the original authorization request"));
  }
  // 8. the code's grant must belong to the presenting app.
  if (grant.applicationId !== app.id) {
    return tokenErrorResponse(c, accessTokenError("invalidGrant", "invalid grant"));
  }
  // 9. ONE-TIME consumption — the DELETE rowcount is the replay guard.
  try {
    await consumeAuthorizationCode(db, code.id);
  } catch (error) {
    if (error instanceof ErrOAuth2AuthorizationCodeInvalidated) {
      return tokenErrorResponse(c, accessTokenError("invalidGrant", "authorization code already used"));
    }
    return tokenErrorResponse(c, accessTokenError("invalidRequest", "cannot process your request"));
  }
  // 10. mint the trio.
  return await mintResponse(c, { grant, app, material, clientKey, rotate });
}

interface RefreshTokenForm {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * handleRefreshToken (oauth2_provider.go:566-631) — arm order verbatim;
 * the InvalidateRefreshTokens arm reads the flag from the env (the
 * default-false trap, token.ts's module header).
 */
async function handleRefreshToken(
  c: Context<{ Bindings: OAuth2TokenEnv }>,
  form: RefreshTokenForm,
  material: OAuth2SigningMaterial,
  clientKey: { key: CryptoKey; kid?: string },
  rotate: boolean,
): Promise<Response> {
  const db = c.env.DB;
  // 1. unknown client — %q (Go double-quoted, JSON-compatible for ASCII).
  const app = await getOAuth2ApplicationByClientID(db, form.clientId);
  if (app === null) {
    return tokenErrorResponse(c, accessTokenError("invalidClient", `cannot load client with client id: ${goQuote(form.clientId)}`));
  }
  // 2. RFC 6749 §6 — confidential clients must authenticate.
  if (app.confidentialClient && !(await validateSecret(app, form.clientSecret))) {
    const description = form.clientSecret === "" ? "invalid empty client secret" : "invalid client secret";
    return tokenErrorResponse(c, accessTokenError("invalidClient", description));
  }
  // 3. parse + kind: an access token presented as a refresh dies here. A
  //    token without a gnt claim parses with grant id 0 upstream — the
  //    grant lookup misses and the "grant does not exist" arm answers.
  let claims: Record<string, unknown> | null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    claims = (await verifyJws({ alg: material.alg, key: material.serverVerifyKey, token: form.refreshToken, nowSec })).claims;
  } catch {
    claims = null;
  }
  if (claims === null || claims.tt !== KIND_REFRESH_TOKEN) {
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", "unable to parse refresh token"));
  }
  const grantId = typeof claims.gnt === "number" && Number.isInteger(claims.gnt) ? claims.gnt : 0;
  // 4. the grant must exist and belong to the app.
  const grant = await getGrantByID(db, grantId);
  if (grant === null) {
    return tokenErrorResponse(c, accessTokenError("invalidGrant", "grant does not exist"));
  }
  if (grant.applicationId !== app.id) {
    return tokenErrorResponse(c, accessTokenError("invalidGrant", "refresh token belongs to a different client"));
  }
  // 5. InvalidateRefreshTokens — the reuse detection rides the grant's
  //    counter vs the token's cnt (:617-624); the mint performs the CAS
  //    and a stale CAS is the mint's "cannot increase the grant counter".
  const tokenCounter = typeof claims.cnt === "number" ? claims.cnt : 0;
  if (rotate && (grant.counter !== tokenCounter || tokenCounter === 0)) {
    return tokenErrorResponse(c, accessTokenError("unauthorizedClient", "token was already used"));
  }
  return await mintResponse(c, { grant, app, material, clientKey, rotate });
}

/** The token.go TokenKind constants (kept local — the mint module's
 *  exports are the service face). */
const KIND_REFRESH_TOKEN = 1;

/**
 * The mint + 200 envelope. Returns the RFC 6749 error on mint failure (the
 * handleAccessTokenError passthrough — whatever NewAccessTokenResponse
 * reports renders as the 400 body).
 */
async function mintResponse(
  c: Context<{ Bindings: OAuth2TokenEnv }>,
  input: {
    grant: OAuth2GrantRow;
    app: OAuth2ApplicationRow;
    material: OAuth2SigningMaterial;
    clientKey: { key: CryptoKey; kid?: string };
    rotate: boolean;
  },
): Promise<Response> {
  // The subject user row — loads ONLY in the openid arm (access_token.go:
  // 212-221: GetUserByID sits INSIDE `if grant.ScopeContains("openid")` — a
  // non-openid grant mints without the subject user; the v1.5.2 F7 fix, a
  // drift looked it up unconditionally and 400'd a gone user on both grant
  // types). The not-exist arm is invalid_request "cannot find user".
  let userRow: OAuth2UserRow | null = null;
  if (grantScopeContains(input.grant.scope, "openid")) {
    userRow = await getUserRowById(c.env.DB, input.grant.userId);
    if (userRow === null) {
      return tokenErrorResponse(c, accessTokenError("invalidRequest", "cannot find user"));
    }
  }
  const result = await mintTokenTrio({
    db: c.env.DB,
    grant: input.grant,
    application: input.app,
    user: userRow ?? undefined,
    material: input.material,
    clientKey: input.clientKey,
    issuer: oauth2Issuer(c.env, new URL(c.req.url).origin),
    appUrl: appUrlOf(c),
    bucket: c.env.REPO_PACKS,
    now: new Date(),
    invalidateRefreshTokens: input.rotate,
  });
  if (!result.ok) {
    return tokenErrorResponse(c, result.error);
  }
  return jsonResponse(c, result.response, 200);
}

/** GetUserByID's typed half (oauth2.go via drizzle — the routes' only user
 *  reads; null on miss). */
async function getUserRowById(db: D1Database, id: number): Promise<OAuth2UserRow | null> {
  const row = await drizzle(db).select().from(users).where(eq(users.id, id)).get();
  return row ?? null;
}

/** ValidateClientSecret over the landed PBKDF2 encoding; an empty stored
 *  hash (the seeded builtin rows) never verifies — bcrypt's
 *  CompareHashAndPassword fails on a non-hash the same way. */
async function validateSecret(app: OAuth2ApplicationRow, secret: string): Promise<boolean> {
  return await verifyClientSecret(app.clientSecret, secret);
}

/** The token endpoint's registered-list membership check (ContainsRedirectURI,
 *  oauth2.go:164-192 — W3's authorize arm consumes this same comparison; the
 *  port-variance test fixtures live in models/auth/oauth2_test.go:87-106).
 *  normalizeRedirectURIForComparison = ASCII-lowercase + TrimSuffix (ONE
 *  trailing slash, oauth2.go:196-198); public clients add the loopback
 *  port-stripped variant (:190-205). */
export function containsRedirectUri(app: OAuth2ApplicationRow, redirectUri: string): boolean {
  const normalize = (uri: string): string => (uri.endsWith("/") ? uri.slice(0, -1) : uri).toLowerCase();
  const candidates = [redirectUri];
  if (!app.confidentialClient) {
    const loopback = normalizePublicClientRedirectURI(redirectUri);
    if (loopback !== null) candidates.push(loopback);
  }
  let registered: string[];
  try {
    registered = JSON.parse(app.redirectUris) as string[];
  } catch {
    registered = [];
  }
  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate);
    for (const uri of registered) {
      if (normalize(uri) === normalizedCandidate) {
        return true;
      }
    }
  }
  return false;
}

/**
 * normalizePublicClientRedirectURI (oauth2.go:190-205): http ONLY, an
 * EXPLICIT port, a LOOPBACK IP (net.ParseIP().IsLoopback — isLoopbackIP's
 * port below; NOT the name "localhost") — the port is stripped and the URI
 * is re-spelled with Go url.URL.String() over Host = Hostname(): the BARE
 * address (brackets OFF for ::1), so a presented `http://[::1]:3456/`
 * normalizes to `http://::1` and matches a registered `http://::1/` — the
 * upstream fixture at models/auth/oauth2_test.go:87-106.
 */
function normalizePublicClientRedirectURI(redirectUri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" || parsed.port === "") {
    return null;
  }
  // WHATWG keeps the brackets in `hostname` for IPv6; the loopback parse
  // wants the bare address (Go's Hostname() also de-brackets).
  const bareHost =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;
  if (!isLoopbackIP(bareHost)) {
    return null;
  }
  // Go String() over Host = Hostname(): the bare address, brackets off.
  const userinfo = parsed.username === "" ? "" : `${parsed.username}@`;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${userinfo}${bareHost}${path}${parsed.search}${parsed.hash}`;
}

/**
 * net.ParseIP's minimal port over the TEXT forms Go accepts (verified
 * against the Go 1.25.1 stdlib, byte-probe): dotted-quad IPv4 — four octets
 * of 1-3 DIGITS with NO leading zero ("127.0.0.001" and "0127.0.0.1" are
 * rejected; the Go 1.17 strictness — and "127.1" is no shortcut) — and
 * RFC 4291 IPv6 text (1-4 hex digits per group, case-insensitive, at most
 * one "::" run, an optional trailing embedded IPv4 tail, exactly 8 groups
 * after expansion, no %zone). Answers IsLoopback's verdict
 * (net/ip.go): an IPv4-form address — a plain v4 parse, or the IPv4-MAPPED
 * ::ffff:a.b.c.d shape (groups 1-5 zero, group 6 = 0xffff, the dotted and
 * pure-hex spellings alike) — loops back on the 127/8 first octet;
 * otherwise only ::1 itself. Names ("127.evil.com", "localhost") and the
 * embedded-without-mapping form ("::127.0.0.1") parse/loop back NOT.
 */
export function isLoopbackIP(host: string): boolean {
  const groups = parseIPGroups(host);
  if (groups === null) {
    return false;
  }
  if (groups.kind === "ipv4") {
    return groups.octets[0] === 127;
  }
  const g = groups.values;
  // The IPv4-mapped shape (::ffff:a.b.c.d — To4() non-nil upstream).
  if (g.slice(0, 5).every((v) => v === 0) && g[5] === 0xffff) {
    return Math.floor(g[6]! / 256) === 127;
  }
  return g.slice(0, 7).every((v) => v === 0) && g[7] === 1;
}

/** One parsed address: either four IPv4 octets or eight IPv6 groups. */
function parseIPGroups(host: string): { kind: "ipv4"; octets: number[] } | { kind: "ipv6"; values: number[] } | null {
  const ipv4 = parseIPv4Octets(host);
  if (ipv4 !== null) {
    return { kind: "ipv4", octets: ipv4 };
  }
  return parseIPv6Groups(host);
}

/** Go's post-1.17 dotted-quad rule: 1-3 digits, no leading zero (a lone "0"
 *  is fine), value <= 255. */
function parseIPv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

/** RFC 4291 §2.2 text: hex groups, one "::" run max, an optional trailing
 *  IPv4 tail (the tail folds into the last two groups), exactly 8 groups
 *  after expansion ("::" must stand for at least one group; no %zone). */
function parseIPv6Groups(host: string): { kind: "ipv6"; values: number[] } | null {
  if (host.includes("%")) {
    return null; // Go's ParseIP rejects a zone
  }
  const doubleColon = host.split("::");
  if (doubleColon.length > 2) {
    return null;
  }
  const headPart = doubleColon[0]!;
  const tailPart = doubleColon.length === 2 ? doubleColon[1]! : "";
  // A bare leading/trailing "::" yields an empty side ("" — legal);
  // ":::" splits into >2 pieces and died above.
  const parseGroupList = (part: string, allowIpv4Tail: boolean): number[] | null => {
    if (part === "") {
      return [];
    }
    const pieces = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      const isTail = allowIpv4Tail && i === pieces.length - 1;
      if (isTail && piece.includes(".")) {
        const octets = parseIPv4Octets(piece);
        if (octets === null) {
          return null;
        }
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        return null;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseGroupList(headPart, true);
  const tail = parseGroupList(tailPart, true);
  if (head === null || tail === null) {
    return null;
  }
  if (doubleColon.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) {
      return null;
    }
    return { kind: "ipv6", values: [...head, ...new Array<number>(fill).fill(0), ...tail] };
  }
  return head.length === 8 ? { kind: "ipv6", values: head } : null;
}

/** Go %q for the ASCII client-id shapes (the refresh unknown-client arm). */
function goQuote(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// POST /login/oauth/introspect (IntrospectOAuth, oauth2_provider.go:146-209)
// ---------------------------------------------------------------------------

oauth2Router.post("/login/oauth/introspect", async (c) => {
  const db = c.env.DB;
  // Caller authentication is client_secret_basic ONLY (RFC 7662 §2.1) —
  // form credentials are NOT consulted; unauthenticated ⇒ 401 + the Basic
  // challenge (:161-167).
  const basic = parseClientSecretBasic(c.req.header("Authorization"));
  let introspectingApp: OAuth2ApplicationRow | null = null;
  if (basic.ok) {
    const app = await getOAuth2ApplicationByClientID(db, basic.clientId);
    if (app !== null && (await validateSecret(app, basic.clientSecret))) {
      introspectingApp = app;
    }
  }
  if (introspectingApp === null) {
    return plainTextResponse(401, "no valid authorization", { "www-authenticate": 'Basic realm="Gitea OAuth2"' });
  }

  // Invalid/unknown tokens answer 200 {"active":false} — never an error
  // (RFC 7662 §2.2, :176-184).
  const inactive = (): Response => jsonResponse(c, { active: false }, 200);
  const form = await parseTokenForm(c.req.raw);
  const material = await loadOAuth2SigningMaterial(db, c.env.OAUTH2_SIGNING_ALGORITHM);
  let claims: Record<string, unknown> | null;
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const verified = await verifyJws({ alg: material.alg, key: material.serverVerifyKey, token: form.token ?? "", nowSec });
    claims = verified.claims;
  } catch {
    return inactive();
  }
  const grantId = typeof claims.gnt === "number" ? claims.gnt : Number.NaN;
  if (!Number.isInteger(grantId)) {
    return inactive();
  }
  const grant = await getGrantByID(db, grantId);
  if (grant === null || grant.applicationId !== introspectingApp.id) {
    // a foreign client learns nothing (:191-196).
    return inactive();
  }
  const userRow = await getUserRowById(db, grant.userId);
  if (userRow === null) {
    // upstream ctx.ServerError("GetUserByID") — unreachable while grants
    // die with their users; the app's onError 500 arm answers.
    throw new Error(`introspect: grant ${grant.id} references missing user ${grant.userId}`);
  }
  // Active shape (:169-208): active, scope (omitempty — an empty-scope grant
  // OMITS the member, `json:"scope,omitempty"` at oauth2_provider.go:171;
  // the v1.5.2 F6 fix emitted it as `""`), username, then the registered
  // claims iss/sub/aud — exp EXPLICITLY nil upstream and omitted here.
  const normalizedScope = normalizeGrantScope(grant.scope);
  const body: Record<string, unknown> = { active: true };
  if (normalizedScope !== "") {
    body.scope = normalizedScope;
  }
  body.username = userRow.username;
  body.iss = oauth2Issuer(c.env, new URL(c.req.url).origin);
  body.sub = String(grant.userId);
  body.aud = [introspectingApp.clientId];
  return jsonResponse(c, body, 200);
});

// ---------------------------------------------------------------------------
// GET/POST /login/oauth/userinfo (InfoOAuth, oauth2_provider.go:96-132)
// ---------------------------------------------------------------------------

/** The userinfo handler — GET and POST are the same arm upstream
 *  (`m.Methods("GET, POST, OPTIONS", "/userinfo", ...)`). */
async function infoOAuth(c: Context<{ Bindings: OAuth2TokenEnv }>): Promise<Response> {
  const db = c.env.DB;
  // The gate (the AuthedMethod == "oauth2" check, :97-101 + group.go:63-64)
  // is on the AUTH METHOD THAT ANSWERED — and the OAuth2 method itself
  // authenticates BOTH token shapes: a dotted JWT grant AND a dotless PAT
  // (services/auth/oauth2.go:146-165's else branch — the v1.5.5 R3-M2
  // correction: the earlier "PAT ⇒ 401" record misread the chain). A
  // session (or no credential) is still not enough. 401 carries the Bearer
  // challenge.
  const bearer = parseAuthorizationHeader(c.req.header("Authorization") ?? "")?.bearerToken?.token ?? null;
  const resolved =
    bearer === null
      ? null
      : await resolveUserInfoCredential(db, bearer, {
          enabled: oauth2FeatureEnabled(c.env),
          configuredAlgorithm: c.env.OAUTH2_SIGNING_ALGORITHM,
          now: new Date(),
        });
  if (resolved === null) {
    return plainTextResponse(401, "no valid authorization", { "www-authenticate": 'Bearer realm="Gitea OAuth2"' });
  }
  // read:user enforcement (:103-114) over the SAME resolved scope the API
  // gate reads (GetDoerTokenScope) — grant and PAT carriers alike.
  const scopeSet = ScopeSet.parseLenient(resolved.scope);
  if (!scopeSet.has("read:user")) {
    return plainTextResponse(403, "token does not have required scope: read:user", {
      "www-authenticate": 'Bearer realm="Gitea OAuth2"',
    });
  }
  const body = await buildUserInfoResponse(db, resolved.user, {
    appUrl: appUrlOf(c),
    onlyPublicGroups: scopeSet.publicOnly,
    bucket: c.env.REPO_PACKS,
  });
  return jsonResponse(c, body, 200);
}

oauth2Router.get("/login/oauth/userinfo", (c) => infoOAuth(c));
oauth2Router.post("/login/oauth/userinfo", (c) => infoOAuth(c));

// ---------------------------------------------------------------------------
// GET /login/oauth/keys (OIDCKeys, oauth2_provider.go:482-503)
// ---------------------------------------------------------------------------

oauth2Router.get("/login/oauth/keys", async (c) => {
  const jwks = await oauth2Jwks(c.env.DB, c.env.OAUTH2_SIGNING_ALGORITHM);
  // ToJWK builds a Go MAP — the JSON encoder sorts map keys — so the JWK
  // members emit ALPHABETICALLY (RSA: alg,e,kid,kty,n,use; EC:
  // alg,crv,kid,kty,use,x,y; oct: alg,kty). The response's own Content-Type
  // is the handler's literal "application/json" (:498 — ctx.JSON's charset
  // form is NOT used here), and the body is json.NewEncoder(...).Encode's
  // shape: the JSON DOCUMENT PLUS ITS TRAILING NEWLINE (the v1.5.2 F5b fix
  // — Encode writes the terminating "\n" a plain marshal does not).
  const keys = jwks.keys.map((jwk) => {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(jwk).sort()) {
      sorted[key] = jwk[key] ?? "";
    }
    return sorted;
  });
  return new Response(`${JSON.stringify({ keys })}\n`, { headers: { "content-type": "application/json" } });
});

// ---------------------------------------------------------------------------
// The OPTIONS/wrong-method deny arms (optionsCorsHandler :79-82 + chi's
// method-not-allowed default) — registered AFTER the real methods so the
// specific handlers answer first (Hono composes in registration order).
// ---------------------------------------------------------------------------

for (const path of ["/login/oauth/access_token", "/login/oauth/introspect", "/login/oauth/userinfo", "/login/oauth/keys"]) {
  oauth2Router.all(path, () => methodNotAllowed());
}
