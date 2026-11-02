/**
 * The LINK-ACCOUNT routes — `GET /user/link_account`, `POST
 * /user/link_account_signin`, `POST /user/link_account_signup` — upstream's
 * `web.go:597-599` group (routers/web/auth/linkaccount.go at the pin), the
 * EXTERNAL AUTH W5 route family of specs/external-auth-sources.md §2.5/
 * §5.5.3. The page render + seams live in link-account.tsx (the .tsx split);
 * this module is the JSX-free router.
 *
 * ## The arm ladders (the W2 recorded contract — the module's whole point)
 *
 * Each POST arm runs, in order:
 *
 *   1. `sameOriginGuard` (the §2.8 layer-2 rule — a non-GET UI write);
 *   2. `externalSignupBlockedByInitWindow` FIRST — before any credential
 *      work (§5.5.3's strengthening; the identity.ts wrapper named by the
 *      W2 marks) — the open window answers `303 /user/login`;
 *   3. SIGNIN ARM ONLY — the `auth_failures` budget (SPEC §7.11): the arm
 *      verifies a PAT, so it rides the SAME per-IP D1FailureLimiter as the
 *      login POST (SPEC-0002 §2.7; SPEC-0010 §2.2 step 1's posture) —
 *      check first (blocked ⇒ the shared 429), one failure recorded per
 *      failed verify (invalid / scope / prohibited), reset on every
 *      verified arm (the 2FA parks and the mint alike — the credential
 *      proof SUCCEEDED). All through the fail-open wrappers (ef2c049's
 *      rule: a broken limiter never 500s the arm);
 *   4. the signup arm's ALLOW_SIGNUP gate — closed ⇒ the full-shell 404
 *      (the SPEC's exact polarity, the first-run signupNotFound posture);
 *   5. the source hint RE-RESOLVED against the ACTIVE store
 *      (`getActiveOAuth2SourceByName`) — a miss is the honest full-shell
 *      404 (the hints are untrusted; a stale/deactivated source cannot
 *      complete the chain it names);
 *   6. the apply seam (page module): the credential ladder (signin) or the
 *      shared registration ladder (signup);
 *   7. failure ⇒ the 200 re-render with the inline message (the §2.2
 *      posture; the failed arm's tab carries the error);
 *      success on the SIGNIN arm ⇒ THE 2FA GATE (upstream gates this exact
 *      arm — oauth2LinkAccount's HasTwoFactorOrWebAuthn check,
 *      linkaccount.go:149-176, with its deliberate-ignore comment — so a
 *      2FA-enrolled user does NOT mint here): the local login's park
 *      (ui/session.ts steps 4.5a/4.5b) with the RE-DANCE URL parked as the
 *      post-gate target (the gate ticket's redirectTo / the pending
 *      carrier's `to`), so the gate's mint arms resume the flow at the
 *      dance start leg and the link completes post-assertion (our
 *      substrate's completePendingLinks — the W2 callback, not a parked
 *      first-assertion blob);
 *      success otherwise ⇒ `mintSession` (a FRESH row — the fixation
 *      posture) and the RE-DANCE: `303 /user/oauth2/{source}?redirect_to=…&
 *      oauth2_continue=signin-link|signup`. The fresh session cookie rides
 *      the redirect; W2's start leg then parks the dance state on the NEW
 *      session's row (the row carrier), the IdP re-asserts the identity,
 *      and the callback completes the link against it — landing on the
 *      parked `returnTo`, never the generic signed-in arm's
 *      settings/security (the continuation marker discriminates).
 *
 * The SIGNUP arm gates 2FA nowhere: upstream's LinkAccountPostRegister
 * handles a JUST-CREATED user (linkaccount.go:241-262 — handleSignIn with
 * no HasTwoFactorOrWebAuthn arm), and a fresh account can carry no
 * enrollment — the mint is direct.
 *
 * NO provider call happens on any arm here — the arms never see an
 * identity; they only prove a local credential (or create a local account)
 * and hand the flow back to the dance.
 *
 * ## Mount (the HANDOFF — the page module's header carries the exact hunks)
 *
 *   import { linkAccountRouter } from "./ui/pages/link-account-router";
 *   app.route("/", linkAccountRouter); // BEFORE the uiRouter (9d77172:
 *   // the /user/link_account* statics are two segments)
 *
 * Tests drive `createLinkAccountRouter()` directly beside
 * `createOAuth2LoginRouter({ fetchImpl })` (the W2 harness) — the full
 * ladders run end-to-end without the dispatcher mount.
 */

import { Hono, type Context } from "hono";

import { D1FailureLimiter } from "../../auth/failure-limiter";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../../auth/middleware";
import { hasTwoFactorByUid, mintPendingTicket, twofaSetCookie } from "../../auth/two-factor";
import { readUrlEncodedForm } from "../forms";
import { renderNotFound } from "../render";
import { signCeremonyState, webAuthnPendingSetCookie } from "../../web/webauthn-ceremony";
import { hasCredentialsForUser } from "../../web/webauthn-store";
import { externalSignupBlockedByInitWindow } from "../../services/auth-sources/identity";
import {
  applyLinkAccountSignIn,
  applyLinkAccountSignUp,
  linkAccountLocale,
  loadLinkAccountPageData,
  parseLinkAccountSignInForm,
  parseLinkAccountSignUpForm,
  renderLinkAccountPage,
} from "./link-account";
import { locale } from "../locale";
import { signUpLocale } from "./first-run";
import { getActiveOAuth2SourceByName } from "../../services/auth-sources/store";
import { allowSignup } from "../../services/user-accounts";
import { demoModeEnabled } from "../../services/demo-sweep";
import {
  clientIp,
  loginRateLimited,
  sameOriginGuard,
  mintSession,
  safeRedirectTarget,
  sessionCookieValue,
  sessionSetCookie,
  verifySession,
} from "../session";
import { AssetBuildError, loadManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";

type RouteContext = Context<{ Bindings: Env }>;

/** The structural type of the static-assets fetcher binding (ui/index.ts's
 *  UiAssetsFetcher — declared locally so this module's graph stays off the
 *  shared index: the router imports ONLY leaf modules, which keeps its test
 *  harness independent of the dispatcher's churn). */
interface LocalAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

/** ui/index.ts's assetsBinding verbatim (the first-run router's import
 *  twin — duplicated HERE, byte-for-byte, purely to keep this router's
 *  module graph leaf-only; the comment there holds the wiring rationale). */
function assetsBinding(env: Pick<Env, "ASSETS">): LocalAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (typeof binding === "object" && binding !== null && "fetch" in binding) {
      return binding as LocalAssetsFetcher;
    }
  }
  return undefined;
}

/** ui/index.ts's assetsNotBuilt verbatim (the same leaf-only rationale). */
function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

const MAX_FORM_BYTES = 8192;

/** `ctx.waitUntil` where an execution context exists; detached otherwise
 *  (router.fetch-style test invocations — the backgroundSink convention). */
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

/** 303 See Other — the house redirect default (session.ts). */
function seeOther(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

/** The 303 with MULTIPLE Set-Cookie directives — the dual-carrier park (the
 *  pending carrier AND the gate ticket ride one response; session.ts's
 *  seeOtherCookies twin, kept local per the leaf-only module graph). */
function seeOtherCookies(location: string, setCookies: string[]): Response {
  const headers = new Headers({ location });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** Assemble the page context (the first-run router's pageContext — the
 *  §2.3.4 missing-manifest 503 first; the VIEWER resolves honestly: the
 *  link page renders for signed-in visitors too — upstream mounts the
 *  family outside any reqSignIn/reqSignOut gate, web.go:597-599). */
async function pageContext(
  c: RouteContext,
): Promise<{ ctx: UiContext } | { response: Response }> {
  const url = new URL(c.req.url);
  const sink = backgroundSink(c);
  let viewer: UiContext["viewer"] = { kind: "anonymous" };
  const cookie = sessionCookieValue(c.req.raw);
  if (cookie !== null) {
    const verification = await verifySession(c.env.DB, cookie);
    for (const work of verification.background) sink(work);
    if (verification.outcome === "authenticated") {
      viewer = { kind: "user", id: verification.user.id, username: verification.user.username, isAdmin: verification.user.isAdmin };
    }
  }
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    return { ctx: { viewer, origin: url.origin, demoMode: demoModeEnabled(c.env), assets: shellAssetsFromManifest(manifest) } };
  } catch (error) {
    if (error instanceof AssetBuildError) return { response: assetsNotBuilt(error) };
    throw error;
  }
}

/** The untrusted hints off the query string (the GET arm) or the validated
 *  form (the POST re-renders — the hidden inputs carry exactly what the GET
 *  rendered: the raw source hint and the ALREADY-VALIDATED target). */
function hintsFromQuery(c: RouteContext): { oauth2Source: string; oauth2UsernameHint: string; redirectTo: string } {
  const url = new URL(c.req.url);
  return {
    oauth2Source: url.searchParams.get("oauth2_source") ?? "",
    oauth2UsernameHint: url.searchParams.get("oauth2_username_hint") ?? "",
    redirectTo: url.searchParams.get("redirect_to") ?? "",
  };
}

/** The full-shell 404 (the first-run signupNotFound posture — the honest
 *  unclaimed shape for a gate-missed/unresolvable POST target). */
async function notFoundShell(c: RouteContext): Promise<Response> {
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  return c.html(renderNotFound(assembled.ctx), 404);
}

/** The re-dance redirect — W2's contract string:
 *  `/user/oauth2/{source}?redirect_to={target}&oauth2_continue={marker}`
 *  (the target parameter omitted when the hint is absent/invalid —
 *  safeRedirectTarget answers "/" for those and the start leg parks
 *  nothing). */
function reDanceRedirect(sourceName: string, redirectTo: string, marker: string): string {
  const params = new URLSearchParams();
  const target = safeRedirectTarget(redirectTo);
  if (target !== "/") params.set("redirect_to", target);
  params.set("oauth2_continue", marker);
  return `/user/oauth2/${encodeURIComponent(sourceName)}?${params.toString()}`;
}

/** The POST failure re-render (200 + inline message, the failed arm's tab
 *  active). The source hint re-resolves for the re-render's hidden inputs —
 *  the caller resolved it already; the raw hint is what the forms carry. */
async function reRender(
  c: RouteContext,
  hints: { oauth2Source: string; oauth2UsernameHint: string; redirectTo: string },
  options: { allowSignup: boolean; error: string | null; typedEmail?: string; errorTab: "signup" | "signin" },
): Promise<Response> {
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  const data = await loadLinkAccountPageData(c.env.DB, hints, {
    allowSignup: options.allowSignup,
    error: options.error,
    typedEmail: options.typedEmail,
  });
  return c.html(renderLinkAccountPage(assembled.ctx, data, { errorTab: options.errorTab }), 200);
}

// -- GET /user/link_account ---------------------------------------------------

async function linkAccountPage(c: RouteContext): Promise<Response> {
  const assembled = await pageContext(c);
  if ("response" in assembled) return assembled.response;
  // The redirect hint validates inside the loader (the render carries only
  // a validated target — the hidden inputs cannot smuggle an off-site
  // redirect through the re-dance).
  const data = await loadLinkAccountPageData(c.env.DB, hintsFromQuery(c), {
    allowSignup: allowSignup(c.env),
  });
  return c.html(renderLinkAccountPage(assembled.ctx, data), 200);
}

// -- POST /user/link_account_signin -------------------------------------------

async function linkAccountSignInSubmit(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 — a non-GET UI write.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  // The init-window guard FIRST — before any credential work (the W2
  // contract; the first human comes from the one-shot /install).
  if (await externalSignupBlockedByInitWindow(c.env.DB)) return seeOther("/user/login");

  // SPEC §7.11 — the auth_failures budget: this arm verifies a PAT, so it
  // rides the SAME per-IP D1FailureLimiter as the login POST (SPEC-0010
  // §2.2 step 1's check-first posture; the same `clientIp` extraction and
  // the same 429 wire shape). Fail-open (ef2c049's rule — a broken limiter
  // must not 500 the arm; the credential ladder below stays the real
  // gate). Everything after this check — parse, source resolve, verify —
  // consumes the budget; the guard above keeps its W2-contract first place
  // (the limiter is not credential work).
  const sink = backgroundSink(c);
  const now = new Date();
  const ip = clientIp(c.req.raw);
  const limiter = new D1FailureLimiter(c.env.DB);
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) return loginRateLimited(verdict.retryAfterSeconds);

  const params = await readUrlEncodedForm(c.req.raw, MAX_FORM_BYTES);
  const form = parseLinkAccountSignInForm(params);
  const hints = { oauth2Source: form.oauth2Source, oauth2UsernameHint: form.userName, redirectTo: form.redirectTo };

  // The hint is a NAME lookup against the ACTIVE store — never trusted.
  const source = await getActiveOAuth2SourceByName(c.env.DB, form.oauth2Source);
  if (source === null) return notFoundShell(c);

  const outcome = await applyLinkAccountSignIn(c.env.DB, form);
  if (outcome.outcome === "invalid") {
    // One budget failure per failed verify (awaited so the §8 tests count
    // it deterministically — the login POST's renderLoginFailure rule).
    await limiterRecordFailureFailOpen(limiter, ip, now);
    return reRender(c, hints, {
      allowSignup: allowSignup(c.env),
      error: linkAccountLocale.username_password_incorrect,
      errorTab: "signin",
    });
  }
  if (outcome.outcome === "scope") {
    await limiterRecordFailureFailOpen(limiter, ip, now);
    return reRender(c, hints, {
      allowSignup: allowSignup(c.env),
      error: locale.login_error_scope,
      errorTab: "signin",
    });
  }
  if (outcome.outcome === "prohibited") {
    await limiterRecordFailureFailOpen(limiter, ip, now);
    return reRender(c, hints, {
      allowSignup: allowSignup(c.env),
      error: locale.login_error_prohibited,
      errorTab: "signin",
    });
  }

  // -- Verified: the budget resets (SPEC §7.11 — the login POST's rule) -----
  //
  // The credential proof SUCCEEDED, so this is not a failure arm: the
  // reset runs here once, ahead of the 2FA parks AND the direct mint —
  // exactly the local login's park-vs-complete posture (ui/session.ts
  // steps 4.5a/4.5b: "the password proof SUCCEEDED … the house limiter's
  // semantics reset on every verified-password arm alike"). Rides the
  // background sink like the login POST's reset.
  sink(limiterResetFailOpen(limiter, ip));

  // -- THE 2FA GATE (upstream gates this exact arm) --------------------------
  //
  // oauth2LinkAccount checks HasTwoFactorOrWebAuthn BEFORE any link
  // completion and parks via handleTwoFactorRequired — "We deliberately
  // ignore the skip local 2fa setting here because we are linking to a
  // previous user here" (linkaccount.go:149-176); the link completes
  // post-assertion through completePendingLinks (:265-272). Without this
  // check the verified-PAT arm below mints a FULL platform session with no
  // second factor — the local login's own gate (ui/session.ts steps
  // 4.5a/4.5b) applied verbatim: a WebAuthn enrollment parks the signed
  // `gitea_webauthn` PENDING carrier (a D1 session row requires a signed-in
  // user and this is the pre-auth step), a TOTP enrollment the `gitea_twofa`
  // gate ticket, a dual enrollment BOTH carriers at the webauthn prompt
  // (handleTwoFactorRequired's hasWebAuthn-first order). The link-signin
  // form carries no remember checkbox (the page module's LinkAccountMode
  // reduction), so `rem`/`remember` park FALSE.
  //
  // The pending-link state rides INSIDE the carriers: the re-dance URL
  // itself is the parked redirect target — the same slots the local login
  // parks the form target in (the ticket's redirectTo, the carrier's `to`).
  // The gate's mint arms are UNCHANGED and resume the flow: ui/session.ts
  // twofaSubmit redirects to safeRedirectTarget(ticket.redirectTo),
  // web/webauthn.ts assertionPost to safeRedirectTarget(pending.to) — the
  // mint lands on the dance start leg WITH the fresh session, W2's start
  // leg parks the signin-link continuation on the new session's row, the
  // IdP re-asserts the identity, and the callback completes the link onto
  // it and lands on the parked returnTo. That dance callback IS our
  // substrate's completePendingLinks: the external_login_user row is
  // written against the IdP-RE-ASSERTED identity, never from a parked
  // first-assertion blob (the W2 contract — the recorded reason the parked
  // state is a dance URL, not an identity).
  const danceTarget = reDanceRedirect(source.name, form.redirectTo, "signin-link");
  if (await hasCredentialsForUser(c.env.DB, outcome.userId)) {
    const pending = await signCeremonyState(c.env.DB, {
      k: "pending",
      uid: outcome.userId,
      ch: "",
      rem: false,
      to: danceTarget,
    });
    if (await hasTwoFactorByUid(c.env.DB, outcome.userId)) {
      const ticket = await mintPendingTicket(
        c.env.DB,
        { kind: "gate", userId: outcome.userId, remember: false, redirectTo: danceTarget },
      );
      return seeOtherCookies("/user/webauthn", [webAuthnPendingSetCookie(pending), twofaSetCookie(ticket)]);
    }
    return seeOther("/user/webauthn", webAuthnPendingSetCookie(pending));
  }
  if (await hasTwoFactorByUid(c.env.DB, outcome.userId)) {
    const ticket = await mintPendingTicket(
      c.env.DB,
      { kind: "gate", userId: outcome.userId, remember: false, redirectTo: danceTarget },
    );
    return seeOther("/user/two_factor", twofaSetCookie(ticket));
  }

  // Verified, not enrolled: mint (a FRESH row — the fixation posture) and
  // re-dance — the unchanged happy path.
  const cookieValue = await mintSession(c.env.DB, outcome.userId);
  return seeOther(danceTarget, sessionSetCookie(cookieValue, false));
}

// -- POST /user/link_account_signup -------------------------------------------

async function linkAccountSignUpSubmit(c: RouteContext): Promise<Response> {
  // §2.8 layer 2 — a non-GET UI write.
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;

  // The init-window guard FIRST (same order as the signin arm — the W2
  // contract runs it before ANY credential work, the signup ladder
  // included).
  if (await externalSignupBlockedByInitWindow(c.env.DB)) return seeOther("/user/login");

  // ALLOW_SIGNUP's exact polarity (§5.5.3): closed ⇒ the POST 404s (the tab
  // is already absent — the render half of the gate).
  if (!allowSignup(c.env)) return notFoundShell(c);

  const params = await readUrlEncodedForm(c.req.raw, MAX_FORM_BYTES);
  const form = parseLinkAccountSignUpForm(params);
  const hints = { oauth2Source: form.oauth2Source, oauth2UsernameHint: form.userName, redirectTo: form.redirectTo };

  const source = await getActiveOAuth2SourceByName(c.env.DB, form.oauth2Source);
  if (source === null) return notFoundShell(c);

  const result = await applyLinkAccountSignUp(c.env.DB, form);
  if (result.outcome === "invalid") {
    return reRender(c, hints, {
      allowSignup: true, // the gate passed — the re-render's tab renders
      error: result.message,
      typedEmail: form.email,
      errorTab: "signup",
    });
  }
  if (result.outcome === "name-taken") {
    return reRender(c, hints, { allowSignup: true, error: signUpLocale.name_taken, typedEmail: form.email, errorTab: "signup" });
  }
  if (result.outcome === "email-taken") {
    return reRender(c, hints, { allowSignup: true, error: signUpLocale.email_taken, typedEmail: form.email, errorTab: "signup" });
  }

  // Created: mint (upstream's handleSignIn auto-login posture,
  // linkaccount.go:262) and re-dance.
  const cookieValue = await mintSession(c.env.DB, result.user.id);
  return seeOther(reDanceRedirect(source.name, form.redirectTo, "signup"), sessionSetCookie(cookieValue, false));
}

// ---------------------------------------------------------------------------
// The router — mounted by the dispatcher (the HANDOFF in link-account.tsx's
// header): app.route("/", linkAccountRouter); BEFORE the uiRouter.
// ---------------------------------------------------------------------------

export function createLinkAccountRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  router.get("/user/link_account", (c) => linkAccountPage(c));
  router.post("/user/link_account_signin", (c) => linkAccountSignInSubmit(c));
  router.post("/user/link_account_signup", (c) => linkAccountSignUpSubmit(c));
  return router;
}

export const linkAccountRouter = createLinkAccountRouter();
