/**
 * The LINK-ACCOUNT page — `GET /user/link_account` plus its two POST arms'
 * renders — the EXTERNAL AUTH W5 arm of specs/external-auth-sources.md §2.5/
 * §5.5.3: upstream's `web.go:597-599` family (`auth.LinkAccount`,
 * `LinkAccountPostSignIn`, `LinkAccountPostRegister` — routers/web/auth/
 * linkaccount.go) rendered from `templates/user/auth/link_account.tmpl`
 * over `signup_inner.tmpl`/`signin_inner.tmpl` at the pin.
 *
 * ## The re-dance substrate (the SPEC §9 W2 as-built (b) — the load-bearing
 * divergence from upstream's shape)
 *
 * Upstream parks the verified goth identity in its anonymous server-side
 * session and the POST arms link it directly (linkaccount.go:140/:241).
 * This substrate has NO anonymous session row to park a tamper-proof
 * identity in, and parking a bearer-supplied identity client-side would be
 * a link-forgery primitive — so W2's contract has the page read UNTRUSTED
 * REDIRECT HINTS ONLY (`oauth2_source`, `oauth2_username_hint`,
 * `redirect_to` — pre-fill data, never a parked identity), and each arm
 * verifies its credential, MINTS the session, and answers the re-dance:
 * `303 /user/oauth2/{source}?redirect_to=…&oauth2_continue=signin-link|signup`
 * (the flow module web/oauth2-login.ts's header). The callback completes
 * the link against the IdP-RE-ASSERTED identity. This module ships the
 * load/render/parse/apply seams (the admin-auths pattern); the route table
 * is link-account-router.ts beside it.
 *
 * ## Field reductions (each recorded at its render site)
 *
 *   - The email field prefills EMPTY: upstream prefills `gothUser.Email`
 *     (linkaccount.go:72) from the parked identity — there is none here,
 *     and W2's redirect carries no email hint (an IdP-asserted claim would
 *     ride the URL). The signup POST requires the typed email, exactly like
 *     /user/sign_up.
 *   - No password/retype fields on the signup arm: PAT-only auth
 *     (SPEC-0002 §4.6.7) — upstream's `DisablePassword` default posture
 *     (linkaccount.go:30, RequireExternalRegistrationPassword=false) hides
 *     them too; the first-run B-1 fix's disclosure rides instead.
 *   - The signin arm's credential label is "Access Token" (the B-1
 *     divergence — `locale.password`), wire name `password` unchanged.
 *   - Upstream's signup tab renders `{{if not .AllowOnlyInternalRegistration}}`;
 *     our analog is ALLOW_SIGNUP (SPEC §5.5.3's gate polarity: closed ⇒ the
 *     tab absent AND the POST 404s — the router enforces the POST half).
 *   - Upstream's inner templates embed the external-auth methods block
 *     (signin_inner.tmpl:48-56) — omitted here: the visitor is already
 *     mid-dance for one source, and a second dance entry point would drop
 *     the re-dance context (hints are not session state); the recorded
 *     reduction.
 *   - The tab strip carries upstream's `data-global-init="initTabSwitcher"`
 *     + `data-tab` attributes verbatim (inert in the no-JS shell, the
 *     data-require-appurl-check precedent) — the ACTIVE tab renders with
 *     upstream's `active` class server-side, so the default arm works no-JS.
 *
 * ## Mount recipe (the orchestrator's registration window — SPEC §9's
 * shared-file rule)
 *
 * `link-account-router.ts` exports `linkAccountRouter` (the three routes).
 * HANDOFF to the dispatcher — src/index.ts, mounted with the FIRST-RUN slot
 * BEFORE `app.route("/", uiRouter)` (the 9d77172 rule: /user/link_account*
 * are TWO-segment statics; a later-mounted router's static loses to
 * uiRouter's dynamic /:owner/:repo pair):
 *
 *   import { linkAccountRouter } from "./ui/pages/link-account-router";
 *   app.route("/", linkAccountRouter); // beside the firstRunRouter mount
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { ScopeSet } from "../../auth/scopes";
import { TokenService } from "../../auth/token-service";
import { loginFirstRunLocale } from "./login";
import { signUpLocale } from "./first-run";
import { locale } from "../locale";
import { sanitizeSuggestedUsername } from "../../services/auth-sources/identity";
import { safeRedirectTarget } from "../session";
import { registerUser } from "../../services/user-accounts";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const linkAccountLocale = {
  title: "Link Account", // "link_account" (the Title + role=main aria-label)
  signup_tab: "Register New Account", // "auth.oauth_signup_tab"
  signin_tab: "Link to Existing Account", // "auth.oauth_signin_tab"
  signup_title: "Complete New Account", // "auth.oauth_signup_title" (signup_inner's LinkAccountMode header)
  signup_submit: "Complete Account", // "auth.oauth_signup_submit"
  signin_title: "Sign In to Authorize Linked Account", // "auth.oauth_signin_title" (signin_inner's LinkAccountMode header)
  signin_submit: "Link Account", // "auth.oauth_signin_submit"
  username: "Username", // "username" (signup_inner's user_name label)
  email: "Email Address", // "email"
  /** The signin arm's failure re-render (linkaccount.go:101's
   *  form.username_password_incorrect — non-committal by design). */
  username_password_incorrect: "Username or password is incorrect.", // "form.username_password_incorrect"
} as const;

// ---------------------------------------------------------------------------
// The page data (upstream prepareLinkAccountPageData + LinkAccount's probe)
// ---------------------------------------------------------------------------

export interface LinkAccountPageData {
  /** The untrusted `oauth2_username_hint` after the pre-fill sanitizer
   *  (identity.ts sanitizeSuggestedUsername — the hint is display data,
   *  re-validated through the shared ladder at POST). */
  userName: string;
  /** The signup arm's email prefill — ALWAYS "" on the GET (module header:
   *  no email hint exists on this substrate); the POST re-render carries
   *  the typed value. */
  email: string;
  /** The raw `oauth2_source` hint (the hidden inputs' carrier; the POST
   *  re-resolves it against the ACTIVE store — never trusted). */
  oauth2Source: string;
  /** The redirect hint through `safeRedirectTarget` ("" when absent or
   *  invalid — the render carries only a validated target). */
  redirectTo: string;
  /** The active tab: upstream's `user_exists` probe (linkaccount.go:76-94
   *  — a matching email first, then a matching username) flips the SIGNIN
   *  tab active; no email hint exists here, so this is the username arm
   *  only. "signup" otherwise (the template's `{{if not .user_exists}}`). */
  activeTab: "signup" | "signin";
  /** ALLOW_SIGNUP (the signup tab's gate — the `AllowOnlyInternalRegistration`
   *  slot; the POST re-renders carry true — a closed gate 404s before any
   *  render). */
  allowSignup: boolean;
  /** The inline failure (the POST re-render arm; null on the GET). */
  error: string | null;
}

/**
 * The GET arm's load — the hint sanitization + the user_exists probe
 * (linkaccount.go:67-94 reduced to the username half; the email half has no
 * input on this substrate — the module header). Pure async: one point read
 * on the users table.
 */
export async function loadLinkAccountPageData(
  d1: D1Database,
  hints: { oauth2Source: string; oauth2UsernameHint: string; redirectTo: string },
  options?: { allowSignup?: boolean; error?: string | null; typedEmail?: string },
): Promise<LinkAccountPageData> {
  const userName = sanitizeSuggestedUsername(hints.oauth2UsernameHint);
  let activeTab: "signup" | "signin" = "signup";
  if (userName !== "") {
    const existing = await drizzle(d1)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, userName.toLowerCase()))
      .get();
    if (existing !== undefined) activeTab = "signin";
  }
  // The redirect hint validates at LOAD (the module header): "/" is
  // safeRedirectTarget's no-target answer (an absent or off-site hint) —
  // the carried value normalizes to "" so the hidden input renders the
  // honest absent-target bytes and the POST's re-dance omits the parameter.
  const target = safeRedirectTarget(hints.redirectTo);
  return {
    userName,
    email: options?.typedEmail ?? "",
    oauth2Source: hints.oauth2Source,
    redirectTo: target === "/" ? "" : target,
    activeTab,
    allowSignup: options?.allowSignup ?? true,
    error: options?.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// The POST forms (upstream SignInForm / RegisterForm over the link arms)
// ---------------------------------------------------------------------------

export interface LinkAccountSignInForm {
  userName: string;
  /** The PAT posted as `password` (the §2.2 wire shape). */
  password: string;
  oauth2Source: string;
  redirectTo: string;
}

export interface LinkAccountSignUpForm {
  userName: string;
  email: string;
  oauth2Source: string;
  redirectTo: string;
}

/** Parse the `application/x-www-form-urlencoded` bodies (the bounded
 *  readUrlEncodedForm seam — the router caps the read; missing fields parse
 *  as empty strings like the first-run parser). */
export function parseLinkAccountSignInForm(params: URLSearchParams): LinkAccountSignInForm {
  return {
    userName: (params.get("user_name") ?? "").trim(),
    password: params.get("password") ?? "",
    oauth2Source: (params.get("oauth2_source") ?? "").trim(),
    redirectTo: params.get("redirect_to") ?? "",
  };
}

export function parseLinkAccountSignUpForm(params: URLSearchParams): LinkAccountSignUpForm {
  return {
    userName: (params.get("user_name") ?? "").trim(),
    email: (params.get("email") ?? "").trim(),
    oauth2Source: (params.get("oauth2_source") ?? "").trim(),
    redirectTo: params.get("redirect_to") ?? "",
  };
}

// ---------------------------------------------------------------------------
// The arms' apply seams (§5.5.3's credential ladders; the ROUTER owns the
// guard ORDER — init window first, then these — and the re-dance redirect)
// ---------------------------------------------------------------------------

export type LinkAccountSignInOutcome =
  | { outcome: "verified"; userId: number }
  | { outcome: "invalid" }
  | { outcome: "scope" }
  | { outcome: "prohibited" };

/**
 * The signin arm's credential verify — SPEC-0010 §2.2's check as built in
 * the login POST (ui/session.ts loginSubmit steps 2-4): the TokenService
 * verify, the optional-owner cross-check (case-insensitive), the
 * capability gate (the minted session carries the USER's web identity, so
 * the PAT must pass the authenticated read path), the prohibited refusal.
 * Unknown/malformed/expired credentials are indistinguishable (`invalid`).
 * Upstream's arm is `UserSignIn` + `handleSignInError`
 * (linkaccount.go:134-141) — the prohibit-login arm upstream renders as its
 * own page; ours is the inline message (the login-page posture).
 */
export async function applyLinkAccountSignIn(d1: D1Database, form: LinkAccountSignInForm): Promise<LinkAccountSignInOutcome> {
  if (form.password === "") return { outcome: "invalid" };
  const verified = await new TokenService(d1).verify(form.password);
  if (verified === null) return { outcome: "invalid" };
  if (form.userName.toLowerCase() !== verified.user.usernameLower) return { outcome: "invalid" };
  const scope = ScopeSet.parseLenient(verified.token.scopes);
  if (!scope.has("read:repository") || scope.publicOnly) return { outcome: "scope" };
  if (verified.user.status !== "active") return { outcome: "prohibited" };
  return { outcome: "verified", userId: verified.user.id };
}

/**
 * The signup arm — the SHARED account ladder (`registerUser`, the
 * SPEC §5.5.3 "signup ladder reuse": usable name, email format, the
 * name/email pre-checks, the UNIQUE arbiter). Password/retype are empty by
 * construction (PAT-only, the module header). The ALLOW_SIGNUP gate and the
 * init-window guard stay in the ROUTER (the gate's 404 polarity and the
 * guard-before-credential order are route-posture, not ladder).
 */
export function applyLinkAccountSignUp(d1: D1Database, form: LinkAccountSignUpForm) {
  return registerUser(d1, { username: form.userName, email: form.email, password: "", retype: "" });
}

// ---------------------------------------------------------------------------
// The render (templates/user/auth/link_account.tmpl over signup_inner /
//  signin_inner at the pin)
// ---------------------------------------------------------------------------

/** The full-document render. `options.error` rides the arm that failed
 *  (`errorTab` marks which segment carries it — upstream's base/alert
 *  split: the signin segment shows the alert only when the signin arm
 *  failed, signup_inner's only when the register arm did). */
export function renderLinkAccountPage(
  ctx: UiContext,
  data: LinkAccountPageData,
  options?: { errorTab?: "signup" | "signin" },
): string {
  return renderPage(<LinkAccountPage ctx={ctx} data={data} errorTab={options?.errorTab} />);
}

/** The link-account page (§2.4.1 discriminator: `user link-account` —
 *  link_account.tmpl:2's `page-content user link-account`). */
export function LinkAccountPage(props: {
  ctx: UiContext;
  data: LinkAccountPageData;
  errorTab?: "signup" | "signin";
}) {
  const { data } = props;
  const signupActive = data.activeTab === "signup";
  const signinActive = data.activeTab === "signin";
  return (
    <BaseLayout ctx={props.ctx} title={linkAccountLocale.title} pageClass="user link-account">
      {/* link_account.tmpl:3-15 — the secondary-nav tab strip. The signup
          tab renders only under the gate (the AllowOnlyInternalRegistration
          slot); the data-global-init/data-tab attributes are upstream's own
          (inert no-JS — the active classes are server-side). */}
      <overflow-menu class="ui secondary pointing tabular top attached borderless menu secondary-nav">
        <div class="overflow-menu-items tw-justify-center" data-global-init="initTabSwitcher">
          {data.allowSignup ? (
            <a class={`item${signupActive ? " active" : ""}`} data-tab="auth-link-signup-tab">
              {linkAccountLocale.signup_tab}
            </a>
          ) : null}
          <a class={`item${signinActive ? " active" : ""}`} data-tab="auth-link-signin-tab">
            {linkAccountLocale.signin_tab}
          </a>
        </div>
      </overflow-menu>
      <div class="ui middle very relaxed page grid">
        <div class="column tw-my-5">
          {/* link_account.tmpl:19-24 — the signup tab (signup_inner's
              LinkAccountMode arm). */}
          {data.allowSignup ? (
            <div class={`ui tab${signupActive ? " active" : ""}`} data-tab="auth-link-signup-tab">
              <div class="tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
                <div class="ui container fluid">
                  <h4 class="ui top attached header center">{linkAccountLocale.signup_title}</h4>
                  <div class="ui attached segment">
                    <div class="ui positive message">{signUpLocale.token_auth_notice}</div>
                    <form class="ui form" action="/user/link_account_signup" method="post">
                      {props.errorTab === "signup" && data.error !== null ? (
                        <div class="ui negative message">{data.error}</div>
                      ) : null}
                      <input type="hidden" name="oauth2_source" value={data.oauth2Source} />
                      <input type="hidden" name="redirect_to" value={data.redirectTo} />
                      <div class="required field">
                        <label for="user_name">{linkAccountLocale.username}</label>
                        <input
                          id="user_name"
                          name="user_name"
                          type="text"
                          value={data.userName}
                          autocomplete="username"
                          autofocus
                          required
                        />
                      </div>
                      <div class="required field">
                        <label for="email">{linkAccountLocale.email}</label>
                        <input id="email" name="email" type="email" value={data.email} required />
                      </div>
                      <div class="inline field">
                        <button type="submit" class="ui primary button tw-w-full">
                          {linkAccountLocale.signup_submit}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {/* link_account.tmpl:25-29 — the signin tab (signin_inner's
              LinkAccountMode arm: user_name + password, NO remember
              checkbox — the LinkAccountMode slot). */}
          <div class={`ui tab${signinActive ? " active" : ""}`} data-tab="auth-link-signin-tab">
            <div class="tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
              <div class="ui container fluid">
                <h4 class="ui top attached header center">{linkAccountLocale.signin_title}</h4>
                <div class="ui attached segment">
                  <form class="ui form" action="/user/link_account_signin" method="post">
                    {props.errorTab === "signin" && data.error !== null ? (
                      <div class="ui negative message">{data.error}</div>
                    ) : null}
                    <input type="hidden" name="oauth2_source" value={data.oauth2Source} />
                    <input type="hidden" name="redirect_to" value={data.redirectTo} />
                    <div class="required field">
                      <label for="user_name">{locale.uname_holder}</label>
                      <input
                        id="user_name"
                        name="user_name"
                        type="text"
                        value={data.userName}
                        autocomplete="username"
                        autofocus
                        required
                        tabindex={1}
                      />
                    </div>
                    <div class="required field">
                      {/* The B-1 divergence again (login.tsx's header): the
                          visible label names the credential truthfully; the
                          wire shape is upstream's `password` field. */}
                      <label for="password">{locale.password}</label>
                      <input
                        id="password"
                        name="password"
                        type="password"
                        autocomplete="current-password"
                        required
                        tabindex={2}
                      />
                      <p class="tw-text-sm tw-text-grey">{loginFirstRunLocale.credential_note}</p>
                    </div>
                    <div class="field">
                      <button type="submit" class="ui primary button tw-w-full" tabindex={3}>
                        {linkAccountLocale.signin_submit}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
