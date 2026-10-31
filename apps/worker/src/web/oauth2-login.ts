/**
 * The OAuth2 client-flow routes — `GET /user/oauth2/{source}` and
 * `GET /user/oauth2/{source}/callback` (specs/external-auth-sources.md §5.2;
 * upstream `routers/web/web.go:768-771`, handlers `SignInOAuth`
 * routers/web/auth/oauth.go:40-69 and `SignInOAuthCallback` :89-268).
 * The dispatcher mounts the DEFAULT router beside the session router in
 * its registration window (`app.route("/", oauth2LoginRouter)` — the units
 * hand the mount off, SPEC §9's shared-file rule); tests build
 * `createOAuth2LoginRouter({ fetchImpl })` with the stub IdP (the SPEC §8
 * injectable-fetch seam, the mirror gitclient pattern).
 *
 * ## The flow (upstream's shape, the substrate adaptations recorded)
 *
 *   - **Start** (oauth.go:40-69): resolve the ACTIVE source by NAME
 *     (`getActiveOAuth2SourceByName`, oauth2.go:664-677 — a miss is our
 *     honest 404; upstream ServerErrors, the recorded divergence §5.2),
 *     park the dance state (§5.3 — the identity.ts carriers: the session
 *     row column when a session exists, the `gitea_oauth2_state` cookie
 *     otherwise), and 303 to the provider authorize URL. Upstream's
 *     "direct callback fast path" (oauth.go:48-58 — resume a still-valid
 *     provider session without re-auth) has no arm here: our v1 persists
 *     no provider tokens (§7.8), so the 303-through-IdP IS the fast path —
 *     a live IdP SSO session bounces back in one hop.
 *   - **Callback** (oauth.go:89-268): provider `error` params map to the
 *     errCallback ladder (:111-130 — access_denied /
 *     temporarily_unavailable / default) as `/login?oauth2_error={code}`;
 *     the description text upstream flashes is NOT carried (fixed codes
 *     only — no provider-controlled reflection into our UI). Then the
 *     state compare (constant-time, both carriers consulted, the state
 *     spent on EVERY outcome — §5.3.2), the code exchange + id_token
 *     verify (`oidc-client.ts`), the identity ladder (`identity.ts`):
 *     join hit ⇒ mint + redirect the parked `returnTo` (through
 *     `safeRedirectTarget`); miss + signed-in doer ⇒ link to the CURRENT
 *     account (oauth.go:133-141) and redirect
 *     `/user/settings/security` — UNLESS the state carries the link-arm
 *     continuation marker (the re-dance, tail of this header), in which
 *     case the link completes onto the freshly minted session and the flow
 *     lands on the parked `returnTo`; miss + anonymous ⇒ 303 to the
 *     link-account page (W5's UI rides this contract) with the UNTRUSTED
 *     pre-fill hints (`oauth2_source`, `oauth2_username_hint`,
 *     `redirect_to`) — the arms re-dance, the identity is re-verified by
 *     the IdP at link time.
 *   - **Session mint**: `mintSession` (SPEC-0010's seam, ui/session.ts) —
 *     a FRESH row per sign-in, upstream's regeneration posture
 *     (oauth.go:420-424). `last_login_at` rides the mint (the seam's
 *     batched bump — upstream's SetLastLogin on the OAuth path,
 *     oauth.go:409). Prohibited accounts sign into nothing (the login
 *     form's step 4 posture) — the fixed `prohibited` arm instead.
 *
 * ## The re-dance contract (W5's arms — the §5.5.3 link arms on this
 * substrate)
 *
 * The link-account arms verify the credential, MINT the session (a fresh
 * row — the fixation posture), then answer
 * `303 /user/oauth2/{sourceName}?redirect_to={target}&oauth2_continue={
 * signin-link|signup}`. This module's start leg parks the continuation
 * marker in the dance state; the callback completes the link against the
 * IdP-re-asserted identity and lands on `returnTo` (never the generic
 * signed-in arm's settings/security). `externalSignupBlockedByInitWindow`
 * gates BOTH arms before any credential work (§5.5.3's strengthening —
 * the first human comes from the one-shot /install).
 *
 * Status note: the start leg answers 303 (the house redirect default,
 * ui/session.ts seeOther) where upstream issues 307 — SPEC §5.2's own
 * recorded choice.
 */

import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sessions } from "../db/schema";
import {
  decodeOAuth2LoginState,
  encodeOAuth2LoginState,
  linkIdentityToUser,
  oauth2DanceClearCookie,
  oauth2DanceCookieValue,
  oauth2DanceSetCookie,
  resolveByExternalLogin,
  suggestedUsername,
  timingSafeStateEqual,
  type OAuth2LoginState,
} from "../services/auth-sources/identity";
import {
  buildOidcAuthorizeUrl,
  exchangeOidcCode,
  fetchOidcDiscovery,
  OidcVerifyError,
  resolveOAuth2Client,
  type FetchImpl as OidcFetchImpl,
} from "../services/auth-sources/oidc-client";
import { getActiveOAuth2SourceByName } from "../services/auth-sources/store";
import { lookupValidSession, mintSession, safeRedirectTarget, sessionCookieValue, sessionSetCookie } from "../ui/session";

export type FetchImpl = OidcFetchImpl;

type RouteContext = Context<{ Bindings: Env }, "/user/oauth2/:source">;
type CallbackContext = Context<{ Bindings: Env }, "/user/oauth2/:source/callback">;

/** 303 See Other — the house redirect default (session.ts). `cookies`
 *  carries zero, one, or two Set-Cookie directives as SEPARATE header
 *  values (Headers.append keeps them un-joined for the wire). */
function seeOther(location: string, cookies?: string[]): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies ?? []) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** The honest 404 (unclaimed-path posture) — the recorded divergence from
 *  upstream's ServerError 500 for unknown/inactive sources (SPEC §5.2). */
function notFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** The failure arm's marker codes — a FIXED set (no provider-controlled
 *  reflection; upstream interpolates the error description into the general
 *  flash, we drop the text and keep the code — the recorded divergence). */
type OAuth2ErrorCode = "access_denied" | "temporarily_unavailable" | "internal" | "state" | "prohibited" | "provider_unavailable";

/** The failure arm — upstream's errCallback ladder (oauth.go:111-130)
 *  answered as `/login?oauth2_error={code}`. The marker is inert until
 *  W4's login-page option renders the flash. */
function loginErrorRedirect(code: OAuth2ErrorCode, cookies?: string[]): Response {
  return seeOther(`/login?oauth2_error=${code}`, cookies);
}

/** Map the provider's `error` query param onto the errCallback codes
 *  (oauth.go:113-121's switch; everything else is the default arm). */
function providerErrorCode(raw: string | null): OAuth2ErrorCode {
  if (raw === "access_denied" || raw === "temporarily_unavailable") return raw;
  return "internal";
}

/** rememberAuthRedirectLink (auth.go:165-180) essentials: the explicit
 *  `redirect_to` wins; else a SAME-ORIGIN Referer whose path is not under
 *  `/user/` (auth pages and settings pages are skipped — the upstream
 *  comment's reasons). Everything passes through `safeRedirectTarget`'s
 *  gate (path-absolute, no `//`, no control chars); invalid ⇒ no park. */
function parkReturnTo(req: Request): string | undefined {
  const url = new URL(req.url);
  const explicit = safeRedirectTarget(url.searchParams.get("redirect_to"));
  if (explicit !== "/") return explicit;

  const referer = req.headers.get("referer");
  if (referer !== null) {
    try {
      const ref = new URL(referer);
      if (ref.origin === url.origin && !ref.pathname.startsWith("/user/")) {
        const target = safeRedirectTarget(`${ref.pathname}${ref.search}`);
        if (target !== "/") return target;
      }
    } catch {
      // unparseable referer — no park
    }
  }
  return undefined;
}

/** The W5 re-dance continuation marker (module header's contract). */
function readContinuation(url: string): "signin-link" | "signup" | undefined {
  const raw = new URL(url).searchParams.get("oauth2_continue");
  return raw === "signin-link" || raw === "signup" ? raw : undefined;
}

/** The redirect_uri the IdP registration binds — the SOURCE NAME rides it
 *  (§5.2: the button href and the name-keyed lookup both encode it;
 *  renaming a source invalidates the registration). */
function callbackRedirectUri(requestUrl: string, sourceName: string): string {
  return `${new URL(requestUrl).origin}/user/oauth2/${encodeURIComponent(sourceName)}/callback`;
}

interface RouterDeps {
  /** The outbound fetch the OIDC client uses — global fetch in
   *  production, the stub IdP in tests (SPEC §8). */
  fetchImpl?: FetchImpl;
}

export function createOAuth2LoginRouter(deps: RouterDeps = {}): Hono<{ Bindings: Env }> {
  const fetchImpl: FetchImpl = deps.fetchImpl ?? fetch;

  // The dance state carriers (identity.ts) — the row when a session
  // exists, the cookie otherwise; both helpers answer what they used.

  async function readParkedState(c: RouteContext | CallbackContext): Promise<{ state: OAuth2LoginState | null; sessionId: string | null }> {
    const cookie = sessionCookieValue(c.req.raw);
    if (cookie !== null) {
      const doer = await lookupValidSession(c.env.DB, cookie);
      if (doer !== null) {
        const sessionId = cookie.slice(0, cookie.indexOf(":"));
        const row = await drizzle(c.env.DB)
          .select({ parked: sessions.oauth2LoginState })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .get();
        return { state: decodeOAuth2LoginState(row?.parked ?? null), sessionId };
      }
    }
    return { state: decodeOAuth2LoginState(oauth2DanceCookieValue(c.req.raw)), sessionId: null };
  }

  /** Park the state on whichever carrier the visitor carries. Returns the
   *  Set-Cookie directive to attach (the dance cookie, or its CLEARANCE
   *  when the row carries the state — a stale cookie must not linger). */
  async function parkDanceState(
    c: RouteContext | CallbackContext,
    state: OAuth2LoginState,
  ): Promise<{ cookieDirective: string | undefined; sessionId: string | null }> {
    const cookie = sessionCookieValue(c.req.raw);
    if (cookie !== null) {
      const doer = await lookupValidSession(c.env.DB, cookie);
      if (doer !== null) {
        const sessionId = cookie.slice(0, cookie.indexOf(":"));
        await drizzle(c.env.DB)
          .update(sessions)
          .set({ oauth2LoginState: encodeOAuth2LoginState(state) })
          .where(eq(sessions.id, sessionId))
          .run();
        return { cookieDirective: oauth2DanceClearCookie(), sessionId };
      }
    }
    return { cookieDirective: oauth2DanceSetCookie(encodeOAuth2LoginState(state)), sessionId: null };
  }

  /** Spend the state on BOTH carriers (one-time — §5.3.2; every terminal
   *  outcome clears). */
  async function spendDanceState(c: RouteContext | CallbackContext, sessionId: string | null): Promise<string[]> {
    if (sessionId !== null) {
      await drizzle(c.env.DB)
        .update(sessions)
        .set({ oauth2LoginState: null })
        .where(eq(sessions.id, sessionId))
        .run();
    }
    return [oauth2DanceClearCookie()];
  }

  // -- GET /user/oauth2/{source} — the start leg (SignInOAuth) --------------

  async function startOAuth2Login(c: RouteContext): Promise<Response> {
    const source = await getActiveOAuth2SourceByName(c.env.DB, c.req.param("source"));
    if (source === null) return notFound();

    const client = resolveOAuth2Client(source.cfg);
    if (client.kind !== "oidc") {
      // W2 carries the OIDC arm; the github/gplus clients are W3's (§9).
      return loginErrorRedirect("provider_unavailable");
    }

    // The discovery document (memoized against the row's updatedAt — the
    // freshness hint, §5.3.1). A fetch/parse failure is the failure arm
    // (§7.5 — upstream's Callout error ladder).
    const rowKey = `${String(source.id)}:${String(source.updatedAt.getTime())}`;
    let document;
    try {
      ({ document } = await fetchOidcDiscovery(fetchImpl, rowKey, client.cfg.discoveryUrl!));
    } catch {
      return loginErrorRedirect("internal");
    }

    // The two dance UUIDs (§5.3.1 — goth's SetState is a UUID too,
    // init.go:31-34).
    const expectedState = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const state: OAuth2LoginState = {
      sourceId: source.id,
      provider: client.cfg.provider,
      expectedState,
      nonce,
      returnTo: parkReturnTo(c.req.raw),
      continue: readContinuation(c.req.url),
    };

    const authorizeUrl = buildOidcAuthorizeUrl(
      document,
      client.cfg,
      callbackRedirectUri(c.req.url, source.name),
      expectedState,
      nonce,
    );
    const parked = await parkDanceState(c, state);
    return seeOther(authorizeUrl, parked.cookieDirective === undefined ? [] : [parked.cookieDirective]);
  }

  // -- GET /user/oauth2/{source}/callback — the completion leg --------------

  async function oauth2Callback(c: CallbackContext): Promise<Response> {
    const source = await getActiveOAuth2SourceByName(c.env.DB, c.req.param("source"));
    if (source === null) return notFound(); // inactive-mid-dance answers 404 too (§7.2)

    const url = new URL(c.req.url);
    const parked = await readParkedState(c);
    const spentCookies = await spendDanceState(c, parked.sessionId);

    // Provider error params (oauth.go:94-101, :111-130).
    const providerError = url.searchParams.get("error");
    if (providerError !== null && providerError !== "") {
      return loginErrorRedirect(providerErrorCode(providerError), spentCookies);
    }

    // The state compare (§5.3.2 — constant-time, both carriers consulted,
    // the state already spent above).
    const queryState = url.searchParams.get("state");
    if (
      parked.state === null ||
      parked.state.sourceId !== source.id ||
      queryState === null ||
      !timingSafeStateEqual(queryState, parked.state.expectedState)
    ) {
      return loginErrorRedirect("state", spentCookies);
    }
    const state = parked.state;
    const returnTo = safeRedirectTarget(state.returnTo);

    // The provider client (a source re-configured mid-dance dies here like
    // any dead row).
    const client = resolveOAuth2Client(source.cfg);
    if (client.kind !== "oidc") return loginErrorRedirect("provider_unavailable", spentCookies);

    // Exchange + id_token verify (§5.3.3/§5.4). Every verify failure is
    // the errCallback default arm.
    const code = url.searchParams.get("code");
    if (code === null || code === "") return loginErrorRedirect("internal", spentCookies);
    let identity;
    try {
      const discovery = await fetchOidcDiscovery(fetchImpl, `${String(source.id)}:${String(source.updatedAt.getTime())}`, client.cfg.discoveryUrl!);
      const exchanged = await exchangeOidcCode({
        fetchImpl,
        document: discovery.document,
        entry: discovery.entry,
        cfg: client.cfg,
        redirectUri: callbackRedirectUri(c.req.url, source.name),
        code,
        expectedNonce: state.nonce,
      });
      identity = exchanged.identity;
    } catch (error) {
      if (error instanceof OidcVerifyError) return loginErrorRedirect("internal", spentCookies);
      throw error;
    }

    // -- the ladder (§5.5) --------------------------------------------------

    const resolution = await resolveByExternalLogin(c.env.DB, source, identity);
    if (resolution.outcome === "linked") {
      if (resolution.user.status !== "active") return loginErrorRedirect("prohibited", spentCookies);
      const cookieValue = await mintSession(c.env.DB, resolution.user.id);
      return seeOther(returnTo, [sessionSetCookie(cookieValue, false), ...spentCookies]);
    }

    // Miss + signed-in doer (oauth.go:133-141) — the current account gains
    // the link. The re-dance continuation lands on the returnTo instead of
    // settings/security (module header).
    const sessionCookie = sessionCookieValue(c.req.raw);
    const doer = sessionCookie !== null ? await lookupValidSession(c.env.DB, sessionCookie) : null;
    if (doer !== null) {
      await linkIdentityToUser(c.env.DB, source, doer.id, identity);
      const destination = state.continue !== undefined ? returnTo : "/user/settings/security";
      return seeOther(destination, spentCookies);
    }

    // Miss + anonymous ⇒ the link-account page (W5's UI rides this
    // contract — the hints are pre-fill only, never trusted at link time).
    const params = new URLSearchParams({
      oauth2_source: source.name,
      oauth2_username_hint: suggestedUsername(identity),
    });
    if (state.returnTo !== undefined && returnTo !== "/") params.set("redirect_to", state.returnTo);
    return seeOther(`/user/link_account?${params.toString()}`, spentCookies);
  }

  const router = new Hono<{ Bindings: Env }>();
  router.get("/user/oauth2/:source", (c) => startOAuth2Login(c));
  router.get("/user/oauth2/:source/callback", (c) => oauth2Callback(c));
  return router;
}

/** The production router — global fetch; mounted beside the session
 *  router by the dispatcher's registration window. */
export const oauth2LoginRouter = createOAuth2LoginRouter();
