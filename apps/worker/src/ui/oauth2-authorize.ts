/**
 * The OAuth2 authorize dance (SPEC specs/oauth2-provider.md §2.2 — W3): the
 * consent flow over the SPEC-0010 web session, ported from the pin
 * (`routers/web/auth/oauth2_provider.go:224-479`):
 *
 *   GET+POST /login/oauth/authorize — the request validation ladder
 *     (client_id → redirect-URI membership → response_type → PKCE → grant
 *     diff → auto-consent or the consent page)
 *   POST     /login/oauth/grant   — the session-state verification and the
 *     authorization-code mint
 *
 * Route home (SPEC open question 1, resolved per its recommendation): the
 * SESSION-ROUTER family beside `sessionRouter` (the authorize endpoints ARE
 * session-bound UI pages; upstream mounts the whole /login/oauth group under
 * reqSignIn, web.go:617-631). MOUNT (orchestrator handoff — this module does
 * not touch src/index.ts): `app.route("/", oauth2AuthorizeRouter);` beside
 * the sessionRouter mount (order vs uiRouter is immaterial — no overlapping
 * claims).
 *
 * The gate slot: upstream wraps the group in `oauth2Enabled` (web.go:631 —
 * setting.OAuth2.Enabled false ⇒ 403 on every endpoint). WIRED in W4: the
 * router export below carries the group 403 wrap over the OAUTH2_ENABLED
 * var (SPEC §6/§2.11), the outermost middleware before any session read.
 *
 * ## The session-state seam (the one adaptation upstream forces)
 *
 * Upstream stashes the dance state in five server-side session keys —
 * CodeChallenge/CodeChallengeMethod at the PKCE switch (:271-295) and
 * client_id/redirect_uri/state before the consent page renders (:378-395) —
 * and NEVER deletes them. cf-gitea's session is a D1 row (SPEC-0010), so
 * the same state lives in the migration-0052 `sessions.oauth_state` column
 * as ONE nullable JSON blob
 * `{client_id, redirect_uri, state, scope, nonce, code_challenge,
 * code_challenge_method}` (the schema comment's shape):
 *
 *   - stashed at the consent-page render (the :378-395 arm);
 *   - READ-AND-CLEARED at POST /grant (SPEC §2.2 step 9/§3 — upstream never
 *     clears, but the column is one blob; the clear rides a
 *     compare-and-set on the read value so two concurrent consent POSTs
 *     cannot both verify — the second answer is the 400-mismatch arm).
 *
 * The auto-consent path never stashes: it mints the code inline from the
 * request (:339-359 — upstream writes its session keys there too, but
 * nothing reads them back on a path with no POST /grant).
 *
 * ## Body shape
 *
 * These are UI forms: `application/x-www-form-urlencoded` only (the
 * AuthorizationForm/GrantApplicationForm fields, services/forms/user_form.go:
 * 108-128 — same names). Upstream's web.Bind also sniffs JSON; for the two
 * consent forms SPEC §4.16(g)'s form-is-the-contract posture applies (the
 * token endpoint's JSON arm is W2's surface). Bodies are capped at 8 KiB
 * before parsing (the login form's guard).
 *
 * Audit: upstream records audit.UserOAuth2ApplicationGrant on first-consent
 * grant creation (:449-453); the registry row (services/audit.ts's
 * `user:oauth2application:grant`, action.go:98 verbatim) and the emit ride
 * the grantPost create arm below (W4 — the W3 open issue closed).
 */

import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { normalizeScope } from "../auth/scopes";
import { containsRedirectURI } from "../api/services/oauth2-apps";
import {
  generateAuthorizationCode,
  getGrantByUserID,
  getOrCreateGrant,
  setGrantNonce,
  updateGrantScope,
} from "../services/oauth2/grants";
import { oauth2FeatureEnabled } from "../services/oauth2/token";
import { oauth2Applications, sessions, users } from "../db/schema";
import { AuditActions, emitAudit } from "../services/audit";
import { demoModeEnabled } from "../services/demo-sweep";
import { assetsBinding, assetsNotBuilt } from "./index";
import {
  clearSessionSetCookie,
  sameOriginGuard,
  sessionCookieValue,
  verifySession,
  type SessionUser,
} from "./session";
import { AssetBuildError, loadManifest } from "./manifest";
import { renderOauth2GrantErrorPage, renderOauth2GrantPage } from "./pages/oauth2-grant";
import { shellAssetsFromManifest, type UiContext } from "./ui-context";

// ---------------------------------------------------------------------------
// Scopes (services/oauth2_provider/access_token.go:87-134) — exported for the
// token endpoint's `scope` response field and introspection (W2/W4 consume;
// this module is the shared home until a dedicated service file wins).
// ---------------------------------------------------------------------------

/** GeneralScopesSupported (access_token.go:78-85) — the four OIDC scopes,
 *  stored verbatim, driving id_token/userinfo claims. */
export const GENERAL_SCOPES = ["openid", "profile", "email", "groups"] as const;

/**
 * splitGrantScopes (access_token.go:87-119): one space-separated string
 * mixing general scopes (kept verbatim) with comma-joinable access-scope
 * words. Every access word is normalized alone and DROPPED on failure
 * (upstream's `if err == nil` — normalization that discards every invalid
 * scope leaves `no-token-scope`, never `all`: :110-118). No access word at
 * all ⇒ "" (the CALLER decides the legacy-`all` default —
 * grantAdditionalScopes below, :127-134).
 */
function splitGrantScopes(grantScopes: string): { generalScopes: string[]; accessScope: string } {
  const generalScopes: string[] = [];
  const accessWords: string[] = [];
  let hasAccessScopes = false;
  for (const scope of grantScopes.split(" ")) {
    if (scope === "") continue;
    if ((GENERAL_SCOPES as readonly string[]).includes(scope)) {
      generalScopes.push(scope);
      continue;
    }
    hasAccessScopes = true;
    for (const word of scope.split(",")) {
      try {
        accessWords.push(normalizeScope(word));
      } catch {
        // invalid word dropped (access_token.go:101-104)
      }
    }
  }
  if (!hasAccessScopes) {
    return { generalScopes, accessScope: "" };
  }
  if (accessWords.length === 0) {
    return { generalScopes, accessScope: "no-token-scope" };
  }
  // The join re-normalizes (a no-op over valid words — the bitmap is
  // idempotent) exactly like upstream's join-then-Normalize (:116-118).
  return { generalScopes, accessScope: normalizeScope(accessWords.join(",")) };
}

/** NormalizeGrantScope (access_token.go:121-125) — general scopes then the
 *  normalized access scope, space-joined; the stored grant-scope shape. */
export function normalizeGrantScope(grantScopes: string): string {
  const { generalScopes, accessScope } = splitGrantScopes(grantScopes);
  return [...generalScopes, ...(accessScope === "" ? [] : accessScope.split(","))].join(" ");
}

/** GrantAdditionalScopes (access_token.go:127-134) — the API authority an
 *  empty access part keeps: grants without access scopes retain the legacy
 *  `all` default (since 1.22). */
export function grantAdditionalScopes(grantScopes: string): string {
  const { accessScope } = splitGrantScopes(grantScopes);
  return accessScope === "" ? "all" : accessScope;
}

/** util.DiffSlice (modules/util/util.go:323-339) — order-preserving,
 *  de-duplicated added/removed between the granted and requested scope
 *  word lists (:330-336's SetOf arms). */
function diffSlice(oldSlice: string[], newSlice: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldSlice);
  const newSet = new Set(newSlice);
  const addedSet = new Set<string>();
  const removedSet = new Set<string>();
  const added: string[] = [];
  const removed: string[] = [];
  for (const value of newSlice) {
    if (!oldSet.has(value) && !addedSet.has(value)) {
      addedSet.add(value);
      added.push(value);
    }
  }
  for (const value of oldSlice) {
    if (!newSet.has(value) && !removedSet.has(value)) {
      removedSet.add(value);
      removed.push(value);
    }
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Responses + the redirect builders
// ---------------------------------------------------------------------------

type RouteContext = Context<{ Bindings: Env }>;

/** 303 See Other — upstream's redirect default (services/context/base.go:157;
 *  the grant POST names StatusSeeOther explicitly, :479). */
function seeOther(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

/** Plain-text error, the house shape (the crossOriginRejected posture). */
function plainStatus(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** GenerateRedirectURI (models/auth/oauth2.go:428-440): the stored redirect
 *  URI keeps its existing query, `code` always, `state` only when non-empty.
 *  (Go's q.Encode() sorts params; WHATWG appends — byte-identical for the
 *  alphanumeric values real clients send, a recorded cosmetic divergence.) */
function generateRedirectURI(redirectUri: string, code: string, state: string): string | null {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  u.searchParams.set("code", code);
  if (state !== "") u.searchParams.set("state", state);
  return u.toString();
}

// ---------------------------------------------------------------------------
// The consent state on the session row (§2.2 — the oauth_state seam)
// ---------------------------------------------------------------------------

/** The migration-0052 column's JSON shape (db/schema.ts `oauthState`). */
export interface OauthState {
  client_id: string;
  redirect_uri: string;
  state: string;
  scope: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: string;
}

function encodeOauthState(state: OauthState): string {
  return JSON.stringify({
    client_id: state.client_id,
    redirect_uri: state.redirect_uri,
    state: state.state,
    scope: state.scope,
    nonce: state.nonce,
    code_challenge: state.code_challenge,
    code_challenge_method: state.code_challenge_method,
  });
}

/** Stash the dance state at the consent-page render (the :378-395 arm). A
 *  failed write takes the server_error arm upstream (:381-395 — each
 *  Session.Set error funnels there); the caller maps false →
 *  handleServerError. */
async function stashOauthState(db: D1Database, sessionId: string, state: OauthState): Promise<boolean> {
  try {
    await drizzle(db).update(sessions).set({ oauthState: encodeOauthState(state) }).where(eq(sessions.id, sessionId)).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-and-clear (SPEC §2.2 step 9/§3): SELECT the column, then clear it
 * with a compare-and-set on the read value. The CAS is the one-consumer
 * guarantee — two concurrent consent POSTs read the same blob, but only the
 * first clear matches; the loser sees zero rows and takes the 400-mismatch
 * arm (upstream's persistent session keys would verify twice; the SPEC pins
 * read-and-clear).
 */
async function readAndClearOauthState(db: D1Database, sessionId: string): Promise<OauthState | null> {
  const row = await drizzle(db).select({ oauthState: sessions.oauthState }).from(sessions).where(eq(sessions.id, sessionId)).get();
  const raw = row?.oauthState;
  if (raw === undefined || raw === null) return null;
  const cleared = await drizzle(db)
    .update(sessions)
    .set({ oauthState: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.oauthState, raw)))
    .run();
  if ((cleared.meta.changes ?? 0) === 0) return null; // a concurrent POST consumed it
  try {
    const parsed = JSON.parse(raw) as Partial<OauthState>;
    if (
      typeof parsed.client_id !== "string" ||
      typeof parsed.redirect_uri !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.scope !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.code_challenge !== "string" ||
      typeof parsed.code_challenge_method !== "string"
    ) {
      return null;
    }
    return parsed as OauthState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// reqSignIn (web.go:623) — the session seam
// ---------------------------------------------------------------------------

interface SignedIn {
  user: SessionUser;
  /** The live session ROW id — the oauth_state seam's key. It comes from the
   *  PRESENTED cookie's id half AFTER verifySession authenticated the secret
   *  (the id alone authorizes nothing; the pair does). */
  sessionId: string;
}

/** Settle the verification's background work (`ctx.waitUntil` where an
 *  execution context exists — the session.ts backgroundSink shape). */
function backgroundSink(c: RouteContext): (promise: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (promise) => {
      ctx.waitUntil(promise);
    };
  } catch {
    return (promise) => void promise.catch(() => {});
  }
}

/**
 * The §2.4 verification, handler-shaped. Signed-in ⇒ the doer + row id;
 * otherwise the reqSignIn redirect — 303 to `/login?redirect_to=<path+query>`
 * (SPEC-0010 §2.1's divergence: our web login lives at /login, upstream's at
 * /user/login; the dance resumes through the same redirect_to seam the login
 * POST validates with safeRedirectTarget). A dead cookie is cleared on the
 * way out (the resolveViewer directive posture).
 */
async function requireSignIn(c: RouteContext): Promise<SignedIn | Response> {
  const value = sessionCookieValue(c.req.raw);
  if (value !== null) {
    const verification = await verifySession(c.env.DB, value);
    const sink = backgroundSink(c);
    for (const work of verification.background) sink(work);
    if (verification.outcome === "authenticated") {
      const colon = value.indexOf(":");
      return { user: verification.user, sessionId: colon > 0 ? value.slice(0, colon) : "" };
    }
    if (verification.clearCookie) {
      return signInRedirect(c, clearSessionSetCookie());
    }
    return signInRedirect(c);
  }
  return signInRedirect(c);
}

function signInRedirect(c: RouteContext, setCookie?: string): Response {
  const url = new URL(c.req.url);
  const requestUri = `${url.pathname}${url.search}`;
  return seeOther(`/login?redirect_to=${encodeURIComponent(requestUri)}`, setCookie);
}

// ---------------------------------------------------------------------------
// Form parsing (AuthorizationForm / GrantApplicationForm,
// services/forms/user_form.go:108-128 — form-urlencoded, 8 KiB cap)
// ---------------------------------------------------------------------------

const MAX_FORM_BYTES = 8192;

/** Go strconv.ParseBool's true set (web.Bind binds `Granted bool` through
 *  it — "false" must bind FALSE, not merely non-empty). */
function parseGoBool(value: string | null): boolean {
  if (value === null) return false;
  return ["1", "t", "true", "T", "TRUE", "True"].includes(value);
}

async function parseForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!contentType.startsWith("application/x-www-form-urlencoded") || length > MAX_FORM_BYTES) {
    return new URLSearchParams();
  }
  try {
    return new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  } catch {
    return new URLSearchParams();
  }
}

// ---------------------------------------------------------------------------
// The error renderers (oauth2_provider.go:734-757)
// ---------------------------------------------------------------------------

/** The page context the grant_error page needs (the session.ts pageContext
 *  shape — a missing manifest fails fast with the 503). */
async function errorPageContext(c: RouteContext): Promise<{ ctx: UiContext } | { response: Response }> {
  const url = new URL(c.req.url);
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    return {
      ctx: { viewer: { kind: "anonymous" }, origin: url.origin, demoMode: demoModeEnabled(c.env), assets: shellAssetsFromManifest(manifest) },
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { response: assetsNotBuilt(error) };
    throw error;
  }
}

/**
 * handleAuthorizeError (oauth2_provider.go:744-757): with a VALIDATED
 * redirect URI the error rides the redirect as `error` / `error_description`
 * / `state` query params at 303 (state is set UNCONDITIONALLY — an empty
 * one still lands in the query, :751-755 verbatim); without one the
 * `grant_error` page renders at **400** — the redirect URI is never trusted
 * for navigation, so nothing leaks (SPEC §4.11).
 */
async function handleAuthorizeError(
  c: RouteContext,
  authErr: { errorCode: string; errorDescription: string; state: string },
  redirectURI: string,
): Promise<Response> {
  if (redirectURI === "") {
    const assembled = await errorPageContext(c);
    if ("response" in assembled) return assembled.response;
    return c.html(renderOauth2GrantErrorPage({ ctx: assembled.ctx, errorDescription: authErr.errorDescription }), 400);
  }
  // upstream url.Parse + q.Set (:747-756): the URI keeps its existing query,
  // the three error params ride it.
  let u: URL;
  try {
    u = new URL(redirectURI);
  } catch {
    return plainStatus(500, "server error");
  }
  u.searchParams.set("error", authErr.errorCode);
  u.searchParams.set("error_description", authErr.errorDescription);
  u.searchParams.set("state", authErr.state);
  return seeOther(u.toString());
}

/** handleServerError (oauth2_provider.go:736-742) — unexpected failures
 *  funnel into the same shape as `server_error`. */
async function handleServerError(c: RouteContext, state: string, redirectURI: string): Promise<Response> {
  return handleAuthorizeError(c, { errorCode: "server_error", errorDescription: "A server error occurred", state }, redirectURI);
}

// ---------------------------------------------------------------------------
// GET+POST /login/oauth/authorize (AuthorizeOAuth, :224-395)
// ---------------------------------------------------------------------------

interface AuthorizeForm {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  nonce: string;
  codeChallengeMethod: string;
  codeChallenge: string;
}

async function authorize(c: RouteContext): Promise<Response> {
  const signedIn = await requireSignIn(c);
  if (signedIn instanceof Response) return signedIn;
  const doer = signedIn.user;

  // oauthDoerAuthorizePreCheck (:211-222): two-factor-required doers get the
  // access_denied redirect. SLOT — cf-gitea has no 2FA yet (SPEC §2.2 step
  // 1); the predicate is a no-op so the re-pin finds the seam.

  const params = c.req.method === "GET" ? new URL(c.req.url).searchParams : await parseForm(c.req.raw);
  const form: AuthorizeForm = {
    responseType: params.get("response_type") ?? "",
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    scope: params.get("scope") ?? "",
    nonce: params.get("nonce") ?? "",
    codeChallengeMethod: params.get("code_challenge_method") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
  };

  // Load the application by client_id (:232-247); unknown ⇒ unauthorized_client
  // "Client ID not registered" — redirectURI is still UNVALIDATED, so the
  // grant_error page renders (the "" arm).
  const appRows = await drizzle(c.env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.clientId, form.clientId)).limit(1);
  const app = appRows[0];
  if (app === undefined) {
    return handleAuthorizeError(
      c,
      { errorCode: "unauthorized_client", errorDescription: "Client ID not registered", state: form.state },
      "",
    );
  }

  // The consent page's creator link (:250-259): the owning user when the app
  // is user-owned, the instance name for uid=0 (the builtin seed's rows).
  let creator: { username: string } | null = null;
  if (app.uid !== 0) {
    const creatorRows = await drizzle(c.env.DB).select({ username: users.username }).from(users).where(eq(users.id, app.uid)).limit(1);
    const creatorRow = creatorRows[0];
    if (creatorRow === undefined) {
      // upstream GetUserByID's miss is a ServerError (:254-257) — an orphaned
      // application (the user row is gone; nothing cascades app rows).
      return plainStatus(500, "server error");
    }
    creator = creatorRow;
  }

  // Redirect-URI membership (:261-269) — ContainsRedirectURI; failure renders
  // the page (never redirects to the presented URI).
  if (!containsRedirectURI(app, form.redirectUri)) {
    return handleAuthorizeError(
      c,
      { errorCode: "invalid_request", errorDescription: "Unregistered Redirect URI", state: form.state },
      "",
    );
  }

  // From here the redirect URI is VALIDATED — errors ride it (:271+).
  if (form.responseType !== "code") {
    return handleAuthorizeError(
      c,
      { errorCode: "unsupported_response_type", errorDescription: "Only code response type is supported.", state: form.state },
      form.redirectUri,
    );
  }

  // PKCE (:271-317): S256/plain accepted (the challenge rides the dance
  // state); absent on a PUBLIC client ⇒ invalid_request (RFC 7636 §4.4.1 /
  // RFC 8252 §8.1 — the description cites the RFCs verbatim); anything else
  // (including wrong spelling) ⇒ invalid_request "unsupported code challenge
  // method" (RFC 7636 §4.4.1's transformation arm).
  if (form.codeChallengeMethod === "S256" || form.codeChallengeMethod === "plain") {
    // upstream ctx.Session.Set arms — our stash happens with the consent
    // render below (auto-consent reads the form values directly, :348-350).
  } else if (form.codeChallengeMethod === "") {
    if (!app.confidentialClient) {
      return handleAuthorizeError(
        c,
        {
          errorCode: "invalid_request",
          errorDescription: "PKCE is required for public clients",
          state: form.state,
        },
        form.redirectUri,
      );
    }
  } else {
    return handleAuthorizeError(
      c,
      { errorCode: "invalid_request", errorDescription: "unsupported code challenge method", state: form.state },
      form.redirectUri,
    );
  }

  // The user's existing grant (:321-327); an empty requested scope defaults
  // to the granted one, then the mixed string normalizes.
  const grant = await getGrantByUserID(c.env.DB, doer.id, app.id);
  if (grant !== null && form.scope === "") {
    form.scope = grant.scope;
  }
  form.scope = normalizeGrantScope(form.scope);

  const { added, removed } = grant !== null
    ? diffSlice(normalizeGrantScope(grant.scope).split(" "), form.scope.split(" "))
    : { added: [], removed: [] };
  const scopeChanged = added.length > 0 || removed.length > 0;

  // Auto-consent (:339-359): confidential client (or the explicit skip flag)
  // + existing grant + unchanged scope ⇒ mint the code NOW and 303. PUBLIC
  // clients ALWAYS see the consent page (RFC 6749 §10.2 — untrusted clients
  // re-authorize every time).
  if ((app.confidentialClient || app.skipSecondaryAuthorization) && grant !== null && !scopeChanged) {
    const code = await generateAuthorizationCode(
      c.env.DB,
      {
        grantId: grant.id,
        redirectUri: form.redirectUri,
        codeChallenge: form.codeChallenge,
        codeChallengeMethod: form.codeChallengeMethod,
      },
      new Date(),
    );
    const redirect = generateRedirectURI(form.redirectUri, code.code, form.state);
    if (redirect === null) return handleServerError(c, form.state, form.redirectUri);
    // Update nonce to reflect the new session (:357-362) — a failed write is
    // logged and the redirect still happens.
    if (form.nonce.length > 0) {
      try {
        await setGrantNonce(c.env.DB, grant.id, form.nonce);
      } catch (error) {
        console.error("oauth2: unable to update nonce", error);
      }
    }
    return seeOther(redirect);
  }

  // The consent page (:364-395): scope flags, creator link, redirect notice,
  // and the dance state stashed on the session row BEFORE rendering.
  const additionalScopes = grantAdditionalScopes(form.scope) !== "all";
  const stashed = await stashOauthState(c.env.DB, signedIn.sessionId, {
    client_id: app.clientId,
    redirect_uri: form.redirectUri,
    state: form.state,
    scope: form.scope,
    nonce: form.nonce,
    code_challenge: form.codeChallenge,
    code_challenge_method: form.codeChallengeMethod,
  });
  if (!stashed) return handleServerError(c, form.state, form.redirectUri);

  const url = new URL(c.req.url);
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    const ctx: UiContext = {
      viewer: { kind: "user", id: doer.id, username: doer.username, isAdmin: doer.isAdmin },
      origin: url.origin,
      demoMode: demoModeEnabled(c.env),
      assets: shellAssetsFromManifest(manifest),
    };
    return c.html(
      renderOauth2GrantPage({
        ctx,
        applicationName: app.name,
        clientId: app.clientId,
        creatorUsername: creator?.username ?? null,
        instanceName: creator === null ? "cf-gitea" : null,
        scope: form.scope,
        addedScopes: added,
        additionalScopes,
        redirectUri: form.redirectUri,
        state: form.state,
        nonce: form.nonce,
      }),
      200,
    );
  } catch (error) {
    if (error instanceof AssetBuildError) return assetsNotBuilt(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// POST /login/oauth/grant (GrantApplicationOAuth, :405-479)
// ---------------------------------------------------------------------------

async function grantPost(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 / SPEC §4.12 — the consent POST is a non-GET UI route; the
  // sameOriginGuard is the house posture (a disclosed strengthening — the
  // pin carries no CSRF token, SPEC-0002 §2.8).
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  const signedIn = await requireSignIn(c);
  if (signedIn instanceof Response) return signedIn;
  const doer = signedIn.user;

  // oauthDoerAuthorizePreCheck (:411-413) — the 2FA slot, see authorize().

  const params = await parseForm(c.req.raw);
  const form = {
    clientId: params.get("client_id") ?? "",
    granted: parseGoBool(params.get("granted")),
    redirectUri: params.get("redirect_uri") ?? "",
    state: params.get("state") ?? "",
    scope: params.get("scope") ?? "",
    nonce: params.get("nonce") ?? "",
  };

  // The session-state verification (:411-415): the stashed client_id / state
  // / redirect_uri must equal the form's, else plain 400. Read-and-clear —
  // the consent form is one-shot (see readAndClearOauthState).
  const stashed = await readAndClearOauthState(c.env.DB, signedIn.sessionId);
  if (
    stashed === null ||
    stashed.client_id !== form.clientId ||
    stashed.state !== form.state ||
    stashed.redirect_uri !== form.redirectUri
  ) {
    return plainStatus(400, "Bad Request");
  }

  if (!form.granted) {
    return handleAuthorizeError(
      c,
      { errorCode: "access_denied", errorDescription: "the request is denied", state: form.state },
      form.redirectUri,
    );
  }

  // Load the application (:426-432) — the session-matched client_id should
  // exist; a miss is the deleted-app race and takes the ServerError arm.
  const appRows = await drizzle(c.env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.clientId, form.clientId)).limit(1);
  const app = appRows[0];
  if (app === undefined) {
    return plainStatus(500, "server error");
  }

  const grant = await getGrantByUserID(c.env.DB, doer.id, app.id);
  form.scope = normalizeGrantScope(form.scope);

  if (grant === null) {
    // CreateGrant (:436-443) + the audit record (:449-453 — FIRST-consent
    // grant creation only; the re-consent scope-update branch records
    // nothing, :455-461). The store's `created` flag arbitrates the consent
    // race, so exactly one of two concurrent first-consents emits.
    const { created } = await getOrCreateGrant(c.env.DB, { userId: doer.id, applicationId: app.id, scope: form.scope }, new Date());
    if (created) {
      // audit.Record(ctx, audit_model.UserOAuth2ApplicationGrant, ctx.Doer,
      // "oauth2_application", app.Name, "granted_scope", form.Scope):
      // scope = the doer (user), metadata pairs oauth2_application +
      // granted_scope (the template renders {oauth2_application} and the
      // reserved {scope}). Upstream's writeEvent LOGS failures and never
      // fails the request (services/audit/event.go:136-140) — the catch
      // keeps that posture.
      try {
        await emitAudit(drizzle(c.env.DB), {
          action: AuditActions.UserOAuth2ApplicationGrant,
          actorId: doer.id,
          actorName: doer.username,
          scopeType: "user",
          scopeId: doer.id,
          scopeName: doer.username,
          origin: "ui",
          ipAddress: c.req.header("cf-connecting-ip") ?? null,
          vars: { scope: doer.username, oauth2_application: app.name },
          metadata: { oauth2_application: app.name, granted_scope: form.scope },
        });
      } catch (error) {
        console.error("oauth2: unable to record the grant audit event", error);
      }
    }
  } else if (grant.scope !== form.scope) {
    // UpdateGrantScope (:445-449) — the scope column only.
    await updateGrantScope(c.env.DB, grant.id, form.scope);
  }
  // The effective grant row (upstream holds the CreateGrant/GetGrantByUserID
  // value in `grant` throughout) — re-read once after a create so the nonce
  // and the code below address the real id (getOrCreateGrant is
  // read-back-arbitrated, so the row always exists here).
  const effectiveGrant =
    grant !== null && grant.scope === form.scope ? grant : (await getGrantByUserID(c.env.DB, doer.id, app.id));
  if (effectiveGrant === null) {
    return handleServerError(c, form.state, form.redirectUri);
  }

  if (form.nonce.length > 0) {
    // SetNonce (:452-458) — a failed write is logged, the flow continues.
    try {
      await setGrantNonce(c.env.DB, effectiveGrant.id, form.nonce);
    } catch (error) {
      console.error("oauth2: unable to update nonce", error);
    }
  }

  // The code: PKCE fields ride the STASHED state (the form carries none —
  // upstream reads its session keys here, :461-463).
  const code = await generateAuthorizationCode(
    c.env.DB,
    {
      grantId: effectiveGrant.id,
      redirectUri: form.redirectUri,
      codeChallenge: stashed.code_challenge,
      codeChallengeMethod: stashed.code_challenge_method,
    },
    new Date(),
  );
  const redirect = generateRedirectURI(form.redirectUri, code.code, form.state);
  if (redirect === null) return handleServerError(c, form.state, form.redirectUri);
  return seeOther(redirect);
}

// ---------------------------------------------------------------------------
// The router — MOUNT (orchestrator handoff): `app.route("/",
// oauth2AuthorizeRouter);` beside the sessionRouter mount.
// ---------------------------------------------------------------------------

export const oauth2AuthorizeRouter = new Hono<{ Bindings: Env }>();

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

// THE GATE SLOT, WIRED (W4): oauth2Enabled (web.go:373-378 —
// setting.OAuth2.Enabled false ⇒ 403) as the OUTERMOST middleware of the
// group (web.go:631 — the group option runs before reqSignIn, so a disabled
// provider 403s the authorize/grant pair before any session read). The gate
// reads the OAUTH2_ENABLED var through the landed strict-polarity helper
// (oauth2FeatureEnabled — ONLY the exact string "false" disables, default
// true is upstream's, modules/setting/oauth2.go:104); the widened read
// below is the Env-posture (the generated Env may not type the var yet —
// the OAuth2TokenEnv alias note, web/oauth2-token.ts).
oauth2AuthorizeRouter.use("*", async (c, next) => {
  if (!oauth2FeatureEnabled(c.env)) {
    return httpForbidden();
  }
  await next();
});

// upstream registers GET and POST on /authorize with the same handler
// (web.go:622-630 — the POST arm carries the TODO comment verbatim there).
oauth2AuthorizeRouter.get("/login/oauth/authorize", (c) => authorize(c));
oauth2AuthorizeRouter.post("/login/oauth/authorize", (c) => authorize(c));
oauth2AuthorizeRouter.post("/login/oauth/grant", (c) => grantPost(c));
