/**
 * The WebAuthn routes — upstream `web.go:658-675`'s `/user/webauthn` group
 * (the login-side five: the prompt page, the 2FA assertion pair, the
 * passkey pair) plus `web.go:669-673`'s settings quartet
 * (`/user/settings/security/webauthn/*`, handlers
 * routers/web/user/setting/security/webauthn.go). The ceremony math lives
 * in webauthn-ceremony.ts, the rows in webauthn-store.ts, the prompt page
 * render in webauthn-page.tsx.
 *
 * ## Mount (the HANDOFF — units hand shared-file folds to the orchestrator,
 * the oauth2LoginRouter/linkAccountRouter precedent)
 *
 * The dispatcher's `isUserAuthPath` carve must hand BOTH prefixes to Hono
 * BEFORE the repo-scoped branch (the ui parser never claims these tails —
 * without the carve the headless engine 404s them first):
 *
 *   // src/index.ts, the isUserAuthPath condition, two added clauses:
 *   segments[1] === "webauthn" ||
 *   (segments[1] === "settings" && segments[2] === "security" && segments[3] === "webauthn") ||
 *   // src/index.ts, beside the oauth2LoginRouter mount:
 *   import { webauthnRouter } from "./web/webauthn";
 *   app.route("/", webauthnRouter);
 *
 * Tests drive `createWebAuthnRouter()` directly (the W2 harness shape).
 *
 * ## Arm notes (each cites its upstream handler)
 *
 *  - reqSignOut parity (web.go:214-218): a SIGNED-IN visitor on the login
 *    family 303s to "/" (upstream redirects home before any handler runs).
 *  - GET /user/webauthn (auth.WebAuthn): the pending carrier IS the 2FA
 *    session (upstream `twofaUid`); its absence answers upstream's
 *    ServerError arm (500 — "not in WebAuthn session", webauthn.go:34-38).
 *  - GET/POST /user/webauthn/assertion (WebAuthnLoginAssertion/Post): the
 *    challenge carrier (`webauthnAssertion`) is consumed on EVERY post
 *    outcome (upstream's defer Session.Delete) while the pending carrier
 *    SURVIVES failures — the prompt page's JS re-requests a fresh challenge
 *    exactly like upstream. Success: mintSession (the handleSignInFull
 *    twin — last-login rides the mint) + {"redirect"}.
 *  - GET/POST /user/webauthn/passkey/* (WebAuthnPasskeyAssertion/Login):
 *    upstream gates on setting.Service.EnablePasskeyAuth (default TRUE,
 *    service.go:181 — carried: no setting exists, the default stands).
 *    The passkey arm binds userHandle → users.id (upstream's
 *    binary.Varint decode, webauthn.go:100-104).
 *  - The settings quartet (security/webauthn.go): the name-conflict 409s at
 *    BOTH request_register (:41-49) and register (:118-126); registration
 *    verify failures answer upstream's ServerError (500 — the JS reads only
 *    409/201); rename is the upstream-exact JSONRedirect arm (the vendored
 *    form-fetch modal is its only client — the JS-only posture is
 *    upstream's own); delete answers the house plain-form posture (the
 *    accountlink unlink recipe: 303 the success, the 200 notice re-render
 *    the miss).
 *  - Bodies: the vendored JS sends request_register as MULTIPART FormData
 *    (modules/fetch.ts passes FormData through verbatim) and the ceremony
 *    POSTs as JSON — both parsed here (the login form's content-length
 *    bound; AGENTS.md's streaming rule is about unbounded bodies, a
 *    ceremony post is bytes-small).
 *  - CSRF: every POST carries the sameOriginGuard (the §2.8 layer-2 rule —
 *    the settings prologue's guard rides these POSTs too).
 *  - The ManageMFA disabled-features gates (security/webauthn.go:30-33 etc.)
 *    are DOCUMENTED DEAD ARMS: our users carry no per-user disabled-feature
 *    list, so no row can trip them (the bot-guard precedent).
 *  - The audit rows (UserWebAuthAdd/Rename/Remove) are NOT emitted: the
 *    action ids are unregistered in the landed audit registry (the W5
 *    unlink's recorded posture).
 */

import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { twoFactor, users } from "../db/schema";
import { readUrlEncodedForm } from "../ui/forms";
import { locale } from "../ui/locale";
import { renderNotFound } from "../ui/render";
import {
  mintSession,
  safeRedirectTarget,
  sameOriginGuard,
  sessionCookieValue,
  sessionSetCookie,
  verifySession,
} from "../ui/session";
import type { UiContext } from "../ui/ui-context";
import {
  buildCreationOptions,
  buildDiscoverableRequestOptions,
  buildRequestOptions,
  parseAssertionResponse,
  parseCreationResponse,
  relyingPartyFromRequest,
  signCeremonyState,
  verifyAssertion,
  verifyCeremonyState,
  verifyRegistration,
  webAuthnClearCookie,
  webAuthnCookieValue,
  webAuthnSetCookie,
  WebAuthnError,
} from "./webauthn-ceremony";
import { base64UrlEncode, userIdFromWebAuthnId, webAuthnIdForUser } from "./webauthn-cose";
import { renderWebAuthnPromptPage } from "./webauthn-page";
import {
  applyAssertionSignCount,
  createCredential,
  deleteCredential,
  getCredentialByCredentialId,
  getCredentialByName,
  listCredentialsByUser,
  renameCredential,
} from "./webauthn-store";

type RouteContext = Context<{ Bindings: Env }>;

// ---------------------------------------------------------------------------
// Response helpers — multiple Set-Cookie ride SEPARATE headers (Headers
// append; comma-joined cookies break at the first `; Path=` boundary)
// ---------------------------------------------------------------------------

function withCookies(init: { status: number; body?: BodyInit; json?: unknown; location?: string }, cookies: string[]): Response {
  const headers = new Headers();
  if (init.json !== undefined) headers.set("content-type", "application/json;charset=utf-8");
  if (init.location !== undefined) headers.set("location", init.location);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  const body = init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? null);
  return new Response(body, { status: init.status, headers });
}

function jsonOk(body: unknown, ...cookies: string[]): Response {
  return withCookies({ status: 200, json: body }, cookies);
}

function jsonError(status: number, message: string, ...cookies: string[]): Response {
  return withCookies({ status, json: { errorMessage: message } }, cookies);
}

function seeOther(location: string, ...cookies: string[]): Response {
  return withCookies({ status: 303, location }, cookies);
}

/** The ServerError arm — upstream's prod plain-text line
 *  (context_response.go:173-192's non-HTML shape). */
function serverError(): Response {
  return new Response("Internal Server Error\n", {
    status: 500,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** ui/index.ts's methodNotAllowed (the GET-on-POST-only-family arm). */
function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { "content-type": "text/plain;charset=utf-8", allow, "x-content-type-options": "nosniff" },
  });
}

/** The login redirect (the settings prologue's arm — the requestUri form). */
function loginRedirect(requestUri: string): Response {
  return seeOther(`/login?redirect_to=${encodeURIComponent(requestUri)}`);
}

/** The asset-missing 503 (the link-account router's leaf-only twin). */
function assetsNotBuilt(error: Error): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

function assetsBinding(env: Pick<Env, "ASSETS">): { fetch(input: RequestInfo): Promise<Response> } | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (typeof binding === "object" && binding !== null && "fetch" in binding) {
      return binding as { fetch(input: RequestInfo): Promise<Response> };
    }
  }
  return undefined;
}

async function pageContext(c: RouteContext): Promise<{ ctx: UiContext } | { response: Response }> {
  const url = new URL(c.req.url);
  let viewer: UiContext["viewer"] = { kind: "anonymous" };
  const cookie = sessionCookieValue(c.req.raw);
  if (cookie !== null) {
    const verification = await verifySession(c.env.DB, cookie);
    if (verification.outcome === "authenticated") {
      viewer = { kind: "user", id: verification.user.id, username: verification.user.username, isAdmin: verification.user.isAdmin };
    }
  }
  try {
    const { loadManifest } = await import("../ui/manifest");
    const { shellAssetsFromManifest } = await import("../ui/ui-context");
    const { demoModeEnabled } = await import("../services/demo-sweep");
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    return { ctx: { viewer, origin: url.origin, demoMode: demoModeEnabled(c.env), assets: shellAssetsFromManifest(manifest) } };
  } catch (error) {
    if (error instanceof Error && error.name === "AssetBuildError") return { response: assetsNotBuilt(error) };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared arms
// ---------------------------------------------------------------------------

/** The reqSignOut parity arm: a signed-in visitor on the login family
 *  303s home (web.go:214-218). */
async function signedInRedirect(c: RouteContext): Promise<Response | null> {
  const cookie = sessionCookieValue(c.req.raw);
  if (cookie === null) return null;
  const verification = await verifySession(c.env.DB, cookie);
  if (verification.outcome === "authenticated") return seeOther("/");
  return null;
}

/** The settings doer gate (the userSettingsTabPrologue's arms): the Origin
 *  guard first, then signed-in-or-login-redirect. */
async function settingsDoer(c: RouteContext): Promise<{ userId: number } | { response: Response }> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return { response: guard };
  const cookie = sessionCookieValue(c.req.raw);
  if (cookie !== null) {
    const verification = await verifySession(c.env.DB, cookie);
    if (verification.outcome === "authenticated") return { userId: verification.user.id };
  }
  return { response: loginRedirect(new URL(c.req.url).pathname) };
}

/** The pending user load (upstream GetUserByID over twofaUid): the row must
 *  exist and be active — upstream's ServerError arm on a missing row. */
async function loadPendingUser(
  d1: D1Database,
  uid: number,
): Promise<{ id: number; username: string; displayName: string | null } | null> {
  const row = await drizzle(d1)
    .select({ id: users.id, username: users.username, displayName: users.displayName, status: users.status, type: users.type })
    .from(users)
    .where(eq(users.id, uid))
    .get();
  if (row === undefined || row.type !== "user" || row.status !== "active") return null;
  return { id: row.id, username: row.username, displayName: row.displayName };
}

// ---------------------------------------------------------------------------
// Login family (web.go:658-664)
// ---------------------------------------------------------------------------

/** GET /user/webauthn — the prompt page (auth.WebAuthn). */
async function webAuthnPage(c: RouteContext): Promise<Response> {
  const signedIn = await signedInRedirect(c);
  if (signedIn !== null) return signedIn;
  const pending = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "pending"), "pending");
  if (pending === null) return serverError(); // "not in WebAuthn session"
  const user = await loadPendingUser(c.env.DB, pending.uid);
  if (user === null) return serverError();
  // HasTwoFactor (webauthn.go:40-46): the TOTP enrollment the page's
  // "use a code from your phone" link arms.
  const totp = await drizzle(c.env.DB)
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(eq(twoFactor.userId, pending.uid))
    .get();
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  return c.html(renderWebAuthnPromptPage(assembled.ctx, { hasTwoFactor: totp !== undefined }), 200);
}

/** GET /user/webauthn/assertion — BeginLogin (WebAuthnLoginAssertion). */
async function assertionOptions(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const signedIn = await signedInRedirect(c);
  if (signedIn !== null) return signedIn;
  const pending = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "pending"), "pending");
  if (pending === null) return serverError();
  const user = await loadPendingUser(c.env.DB, pending.uid);
  if (user === null) return serverError();
  const credentials = await listCredentialsByUser(c.env.DB, pending.uid);
  if (credentials.length === 0) return serverError(); // "no device registered"
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const state = await signCeremonyState(c.env.DB, {
    k: "assert",
    uid: pending.uid,
    ch: base64UrlEncode(challenge),
    ac: credentials.map((cred) => base64UrlEncode(cred.credentialId)),
  });
  return jsonOk(buildRequestOptions(rp, challenge, credentials.map((cred) => cred.credentialId)), webAuthnSetCookie(state, "assert"));
}

/** The ceremony POST body reader — JSON, bounded at the cap (module
 *  header's body note): a DECLARED content-length over the cap rejects
 *  before any read; an undeclared one (platform-dependent — workerd test
 *  requests carry none) reads and checks the text length after. A ceremony
 *  post is bytes-small; the cap is the abuse bound, not a streaming
 *  decision (the readUrlEncodedForm trade). */
const MAX_CEREMONY_BODY_BYTES = 262_144;

async function readCeremonyJson(c: RouteContext): Promise<unknown> {
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader !== null) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > MAX_CEREMONY_BODY_BYTES) {
      throw new WebAuthnError("forbidden", "oversized request body");
    }
  }
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new WebAuthnError("forbidden", "unreadable request body");
  }
  if (text.length > MAX_CEREMONY_BODY_BYTES) {
    throw new WebAuthnError("forbidden", "oversized request body");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebAuthnError("forbidden", "request body is not valid JSON");
  }
}

/** POST /user/webauthn/assertion — ValidateLogin (WebAuthnLoginAssertionPost). */
async function assertionPost(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const signedIn = await signedInRedirect(c);
  if (signedIn !== null) return signedIn;
  const pending = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "pending"), "pending");
  const challengeState = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "assert"), "assert");
  // Both carriers required (webauthn.go:204-209's session arms). The assert
  // carrier is CONSUMED on every outcome (upstream's defer delete); the
  // pending carrier survives so the prompt page can retry (module header).
  if (pending === null || challengeState === null) return serverError();
  const clearChallenge = webAuthnClearCookie("assert");

  let body: unknown;
  let parsed;
  try {
    body = await readCeremonyJson(c);
    parsed = parseAssertionResponse(body);
  } catch (error) {
    if (error instanceof WebAuthnError) return jsonError(403, error.message, clearChallenge);
    throw error;
  }

  const user = await loadPendingUser(c.env.DB, pending.uid);
  if (user === null) return serverError();

  // The credential resolution — the rawId must be among the user's enrolled
  // ids AND (when the challenge carried the allowlist) among those the
  // challenge allowed. Unknown credential ⇒ the failed-auth 403
  // (ValidateLogin's "credential not found" arm).
  const credential = await getCredentialByCredentialId(c.env.DB, pending.uid, parsed.rawId);
  if (credential === null) return jsonError(403, "credential not found", clearChallenge);
  if (challengeState.ac !== undefined && !challengeState.ac.includes(base64UrlEncode(parsed.rawId))) {
    return jsonError(403, "credential not allowed", clearChallenge);
  }

  try {
    const verified = await verifyAssertion(
      parsed,
      { credentialId: credential.credentialId, coseKey: credential.coseKey, signCount: credential.signCount },
      // The 2FA arm begins with VerificationPreferred (webauthn.go:189) —
      // go-webauthn maps that to shouldVerifyUser=false, so the UV flag is
      // reported but never required here.
      { challenge: challengeState.ch, rp, requireUserVerification: false },
    );
    if (verified.cloneDetected) {
      // The CloneWarning arm (webauthn.go:133-137/245-249 — cloned
      // credential ⇒ 403). The CAS holds the counter at its stored
      // HIGH-WATER mark and persists only clone_warning: upstream never
      // lowers the stored sign count (UpdateSignCount runs on the success
      // path alone), and writing the replayed (≤ stored) count here would
      // UN-block a later replay of the earlier higher-count response — the
      // monotonic ladder would read it as fresh. Holding the mark keeps the
      // durable-rejection posture (the module header) without the hole.
      await applyAssertionSignCount(c.env.DB, credential.id, credential.signCount, credential.signCount, true);
      return jsonError(403, "cloned credential", clearChallenge);
    }
    const outcome = await applyAssertionSignCount(c.env.DB, credential.id, credential.signCount, verified.signCount, false);
    if (outcome === "counter-moved") {
      // A concurrent verify of the same response moved the counter first —
      // the durable single-use arm (module header).
      return jsonError(403, "cloned credential", clearChallenge);
    }
    // Success: mint (the handleSignInFull twin — remember rides the pending
    // carrier, upstream's twofaRemember) and answer the redirect
    // (consumeAuthRedirectLink's validated target, "/" fallback).
    const remember = pending.rem ?? false;
    const cookieValue = await mintSession(c.env.DB, pending.uid, { remember });
    const target = safeRedirectTarget(pending.to ?? "/");
    return jsonOk({ redirect: target }, webAuthnClearCookie("assert"), webAuthnClearCookie("pending"), sessionSetCookie(cookieValue, remember));
  } catch (error) {
    if (error instanceof WebAuthnError) {
      return error.arm === "bad-request" ? jsonError(400, error.message, clearChallenge) : jsonError(403, error.message, clearChallenge);
    }
    throw error;
  }
}

/** GET /user/webauthn/passkey/assertion — BeginDiscoverableLogin. */
async function passkeyOptions(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const signedIn = await signedInRedirect(c);
  if (signedIn !== null) return signedIn;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const state = await signCeremonyState(c.env.DB, { k: "passkey", uid: 0, ch: base64UrlEncode(challenge) });
  return jsonOk(buildDiscoverableRequestOptions(rp, challenge), webAuthnSetCookie(state, "passkey"));
}

/** POST /user/webauthn/passkey/login — ValidateDiscoverableLogin. */
async function passkeyLogin(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const signedIn = await signedInRedirect(c);
  if (signedIn !== null) return signedIn;
  const challengeState = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "passkey"), "passkey");
  if (challengeState === null) return serverError();
  const clearChallenge = webAuthnClearCookie("passkey");

  let parsed;
  try {
    parsed = parseAssertionResponse(await readCeremonyJson(c));
  } catch (error) {
    if (error instanceof WebAuthnError) return jsonError(403, error.message, clearChallenge);
    throw error;
  }

  // The userHandle → user resolution (webauthn.go:100-104's handler —
  // invalid rawID ⇒ the nil-user 400 arm).
  if (parsed.userHandle === null) return jsonError(400, "invalid userHandle", clearChallenge);
  const uid = userIdFromWebAuthnId(parsed.userHandle);
  if (uid === null || uid <= 0) return jsonError(400, "invalid userHandle", clearChallenge);
  const user = await loadPendingUser(c.env.DB, uid);
  if (user === null) return jsonError(400, "invalid userHandle", clearChallenge);

  const credential = await getCredentialByCredentialId(c.env.DB, uid, parsed.rawId);
  if (credential === null) return jsonError(403, "credential not found", clearChallenge);

  try {
    const verified = await verifyAssertion(
      parsed,
      { credentialId: credential.credentialId, coseKey: credential.coseKey, signCount: credential.signCount },
      // The passkey is the SOLE factor — the ceremony demands UV (upstream
      // BeginDiscoverableLogin's WithUserVerification(VerificationRequired),
      // webauthn.go:59; go-webauthn enforces it inside AuthenticatorData.
      // Verify and the handler 403s the failure, webauthn.go:114-119).
      { challenge: challengeState.ch, rp, expectedUserHandle: parsed.userHandle, requireUserVerification: true },
    );
    if (verified.cloneDetected) {
      // High-water hold — the 2FA arm's clone comment above (upstream never
      // lowers the stored counter; writing the replayed count would
      // un-block a later replay of the higher-count response).
      await applyAssertionSignCount(c.env.DB, credential.id, credential.signCount, credential.signCount, true);
      return jsonError(403, "cloned credential", clearChallenge);
    }
    const outcome = await applyAssertionSignCount(c.env.DB, credential.id, credential.signCount, verified.signCount, false);
    if (outcome === "counter-moved") return jsonError(403, "cloned credential", clearChallenge);
    // Upstream: `remember := false // TODO: implement remember me`.
    const cookieValue = await mintSession(c.env.DB, uid, { remember: false });
    return jsonOk({ redirect: "/" }, webAuthnClearCookie("passkey"), sessionSetCookie(cookieValue, false));
  } catch (error) {
    if (error instanceof WebAuthnError) {
      return error.arm === "bad-request" ? jsonError(400, error.message, clearChallenge) : jsonError(403, error.message, clearChallenge);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Settings family (web.go:669-673)
// ---------------------------------------------------------------------------

/** The WebauthnRegistrationForm name (binding TrimSpace; MaxSize(255)). */
function parseRegistrationName(raw: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length > 255) return null;
  return trimmed;
}

/** The upstream default name (security/webauthn.go:37-39): hex of the unix
 *  nano clock. Our Date.now() carries millisecond precision — the hex
 *  rendering is the shape that matters (a collision-proof label). */
function defaultRegistrationName(): string {
  return Date.now().toString(16);
}

/** The request_register form reader — the vendored JS sends MULTIPART
 *  FormData (modules/fetch.ts passes FormData through verbatim); plain
 *  urlencoded form posts parse through the shared reader. */
async function readRegistrationForm(c: RouteContext): Promise<URLSearchParams> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    const length = Number(c.req.header("content-length") ?? "0");
    if (length <= 0 || length > 65_536) return new URLSearchParams();
    const form = await c.req.formData();
    const params = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return readUrlEncodedForm(c.req.raw, 65_536);
}

/** POST /user/settings/security/webauthn/request_register — BeginRegistration. */
async function requestRegister(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const doer = await settingsDoer(c);
  if ("response" in doer) return doer.response;

  const params = await readRegistrationForm(c);
  const name = parseRegistrationName(params.get("name"));
  if (name === null) return jsonError(400, "name exceeds the 255-byte bound");
  const effective = name === "" ? defaultRegistrationName() : name;

  // The name-conflict arm (security/webauthn.go:41-49 — StatusConflict
  // "Name already taken"; the vendored JS reads only the status).
  const existing = await getCredentialByName(c.env.DB, doer.userId, effective);
  if (existing !== null) return jsonError(409, "Name already taken");

  const credentials = await listCredentialsByUser(c.env.DB, doer.userId);
  const user = await loadPendingUser(c.env.DB, doer.userId);
  if (user === null) return serverError();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const state = await signCeremonyState(c.env.DB, {
    k: "reg",
    uid: doer.userId,
    ch: base64UrlEncode(challenge),
    name: effective,
  });
  const options = buildCreationOptions(
    rp,
    { id: webAuthnIdForUser(doer.userId), name: user.username, displayName: user.displayName ?? user.username },
    challenge,
    credentials.map((cred) => cred.credentialId),
  );
  return jsonOk(options, webAuthnSetCookie(state, "reg"));
}

/** The go-webauthn Credential JSON (the 201 body — the JS reads only the
 *  status; the shape is the response's honest record). */
function credentialJson(cred: {
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  attestationType: string;
  signCount: number;
  aaguid: Uint8Array | null;
}): Record<string, unknown> {
  return {
    id: base64UrlEncode(cred.credentialId),
    publicKey: base64UrlEncode(cred.publicKey),
    attestationType: cred.attestationType,
    authenticator: { aaguid: cred.aaguid === null ? null : base64UrlEncode(cred.aaguid), signCount: cred.signCount },
  };
}

/** POST /user/settings/security/webauthn/register — FinishRegistration. */
async function registerPost(c: RouteContext): Promise<Response> {
  const rp = relyingPartyFromRequest(c.req.raw, locale.app_name);
  const doer = await settingsDoer(c);
  if ("response" in doer) return doer.response;
  const state = await verifyCeremonyState(c.env.DB, webAuthnCookieValue(c.req.raw, "reg"), "reg");
  if (state === null || state.name === undefined) {
    // "no registration" (security/webauthn.go:98-102 — the ServerError arm).
    return jsonError(500, "no registration in progress");
  }
  const clearState = webAuthnClearCookie("reg");

  let verified;
  try {
    // The verify ladder — every failure answers upstream's ServerError arm
    // (security/webauthn.go:109-116): the JS maps non-201/409 to 'unknown'.
    verified = await verifyRegistration(parseCreationResponse(await readCeremonyJson(c)), {
      challenge: state.ch,
      rp,
      requireUserVerification: true,
    });
  } catch (error) {
    if (error instanceof WebAuthnError) return jsonError(500, error.message, clearState);
    throw error;
  }

  // The name-conflict re-check (security/webauthn.go:118-126).
  const existing = await getCredentialByName(c.env.DB, doer.userId, state.name);
  if (existing !== null) return jsonError(409, "Name already taken", clearState);

  const cred = await createCredential(c.env.DB, doer.userId, state.name, verified);
  // StatusCreated (security/webauthn.go:139 — the vendored JS reads 201 as
  // the enroll success and reloads).
  return withCookies({ status: 201, json: credentialJson(cred) }, [clearState]);
}

/** The rename/delete form id (ctx.FormInt64's digits posture — the
 *  parseAccountLinkUnlinkForm twin; 0/null is the not-given arm). */
function parseFormId(params: URLSearchParams): number | null {
  const raw = (params.get("id") ?? "").trim();
  if (!/^\d+$/.test(raw) || raw === "0") return null;
  return Number.parseInt(raw, 10);
}

/** POST /user/settings/security/webauthn/rename — WebauthnRename. The
 *  vendored modal's form-fetch form is the only client; upstream-exact JSON
 *  on every arm (success = JSONRedirect). */
async function renamePost(c: RouteContext): Promise<Response> {
  const doer = await settingsDoer(c);
  if ("response" in doer) return doer.response;
  const params = await readUrlEncodedForm(c.req.raw, 65_536);
  const id = parseFormId(params);
  const name = parseRegistrationName(params.get("name"));
  if (id === null || name === null || name === "") {
    return jsonError(400, "invalid rename request");
  }
  const outcome = await renameCredential(c.env.DB, doer.userId, id, name);
  if (outcome === "not-exist") return jsonError(404, "WebAuthn credential does not exist");
  if (outcome === "name-taken") {
    // "settings.webauthn_nickname_been_used" (the translatable arm).
    return jsonError(400, "A security key with the same nickname already exists.");
  }
  return jsonOk({ redirect: "/user/settings/security" });
}

/** POST /user/settings/security/webauthn/delete — WebauthnDelete over the
 *  house plain-form posture (the accountlink unlink recipe): 303 the
 *  success, the 200 notice re-render the miss. */
async function deletePost(c: RouteContext): Promise<Response> {
  const doer = await settingsDoer(c);
  if ("response" in doer) return doer.response;
  const params = await readUrlEncodedForm(c.req.raw, 65_536);
  const id = parseFormId(params);

  const removed = id === null ? false : await deleteCredential(c.env.DB, doer.userId, id);
  if (removed) return seeOther("/user/settings/security");

  // The miss arm — the re-render with the negative notice (the W4
  // notices idiom; upstream's JSONErrorAuto body is machine-read by the
  // fetch JS we do not drive here).
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  if (assembled.ctx.viewer.kind !== "user") return seeOther("/user/settings/security");
  const { loadUserSettingsSecurityPageData, renderUserSettingsSecurityPage } = await import("../ui/pages/user-settings-security");
  const data = await loadUserSettingsSecurityPageData(c.env.DB, assembled.ctx.viewer.id);
  if (data === null) return c.html(renderNotFound(assembled.ctx), 404);
  return c.html(
    renderUserSettingsSecurityPage(assembled.ctx, data, {
      notice: { kind: "negative", message: "The security key was not found — it may already have been removed." },
    }),
    200,
  );
}

// ---------------------------------------------------------------------------
// The router — mounted by the dispatcher (the module header's HANDOFF)
// ---------------------------------------------------------------------------

export function createWebAuthnRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  // The login family (web.go:659-664).
  router.get("/user/webauthn", (c) => webAuthnPage(c));
  router.get("/user/webauthn/assertion", (c) => assertionOptions(c));
  router.post("/user/webauthn/assertion", (c) => assertionPost(c));
  router.get("/user/webauthn/passkey/assertion", (c) => passkeyOptions(c));
  router.post("/user/webauthn/passkey/login", (c) => passkeyLogin(c));
  // The settings quartet (web.go:669-673) + the GET 405 twins (chi's
  // methodNotAllowed posture — the carve hands all methods to Hono).
  const settingsPaths = [
    "/user/settings/security/webauthn/request_register",
    "/user/settings/security/webauthn/register",
    "/user/settings/security/webauthn/rename",
    "/user/settings/security/webauthn/delete",
  ];
  router.post("/user/settings/security/webauthn/request_register", (c) => requestRegister(c));
  router.post("/user/settings/security/webauthn/register", (c) => registerPost(c));
  router.post("/user/settings/security/webauthn/rename", (c) => renamePost(c));
  router.post("/user/settings/security/webauthn/delete", (c) => deletePost(c));
  for (const path of settingsPaths) {
    router.get(path, () => methodNotAllowed("POST"));
  }
  return router;
}

export const webauthnRouter = createWebAuthnRouter();
