/**
 * First-run pages (SPEC-0010 §6 amendment): the sign-up page
 * (`/user/sign_up`, the ALLOW_SIGNUP-gated registration) and the install
 * page render (`/install`, the one-shot admin-init window — the login page
 * with the Administrator Account Settings panel set). JSX lives here; the
 * router module (src/ui/first-run.ts) stays JSX-free (the session.ts
 * split, SPEC-0008 §2.4).
 *
 * Upstream shape (templates/user/auth/signup.tmpl + signup_inner.tmpl at
 * the pin): page-content `user signin` (upstream reuses the sign-in
 * page-content discriminator), the attached header/segment pair, the
 * required `user_name`/`email` fields, the `auth.create_new_account`
 * submit, and the already-have-account footer. The install page is the
 * login page with `adminInit` set (see login.tsx — upstream's install
 * posture reduced to that panel).
 *
 * ## The password-field omission (the B-1 usability fix, 2026-10-30)
 *
 * Upstream renders `password` + `retype` behind signup_inner.tmpl's
 * `{{if not .DisablePassword}}` — an instance with password auth disabled
 * gets NO password fields. cf-gitea is exactly that shape, permanently:
 * PAT-only auth, no password store (SPEC-0002 §4.6.7 divergence 7). The
 * earlier render kept the fields for bare-form parity and DISCARDED both
 * values (services/user-accounts.ts "accepted-and-ignored") — collecting a
 * credential the server throws away is the decoy the first-run audit
 * flagged (docs/usability/findings-first-run.md blocker 1), so the fields
 * are GONE and an upfront notice discloses the credential model instead,
 * riding upstream's in-segment pre-form notice slot
 * (signup_inner.tmpl's `{{if .IsFirstTimeRegistration}}` sign_up_tip `<p>`)
 * with the upstream flash-banner idiom (`RenderFlashMessage`'s
 * `ui positive message`, util_render.go:263-289 — our repo idiom drops the
 * `flash-*` classes, admin-monitor.tsx). The POST handler reads no
 * password fields any more (src/ui/first-run.ts).
 */

import { BaseLayout, renderPage } from "../shell";
import type { AdminInitPanel, OAuth2LoginSourceButton } from "./login";
import { ExternalAuthMethods, renderLoginPage } from "./login";
import type { UiContext } from "../ui-context";

/** Component-local strings (the orgCreateLocale pattern — locale.ts is
 *  shared and not this wave's file). Upstream keys cited per entry. */
export const signUpLocale = {
  title: "Register", // "sign_up"
  user_name: "Username", // "username"
  email: "Email Address", // "email"
  /** The PAT-only disclosure (cf-gitea addition — upstream needs no such
   *  banner because upstream HAS passwords). Rendered in the upstream
   *  sign_up_tip slot; states the credential model where the password
   *  fields used to sit (the B-1 fix — module header). */
  token_auth_notice:
    "Accounts on this instance authenticate with personal access tokens, not passwords. After signing up, create a token under Settings → Applications and use it to sign in.",
  submit: "Register Account", // "auth.create_new_account"
  already_have_account: "Already have an account?", // "auth.already_have_account"
  sign_in_now: "Sign in now!", // "auth.sign_in_now"
  /** The inline re-render messages: the taken-name / used-email pair is
   *  upstream's web copy ("form.username_been_taken" /
   *  "form.email_been_used"); invalid carries the service's message. */
  name_taken: "The username is already taken.",
  email_taken: "The email address is already used.",
} as const;

/** The sign-up page (`user/sign_up`, auth.SignUp's render arm). `error` is
 *  the server-side inline failure (200 re-render, the §2.2 posture);
 *  `values` re-fills the typed fields like upstream's `{{.user_name}}`
 *  bindings. No password fields: PAT-only auth (the B-1 fix — module
 *  header); the token_auth_notice discloses the credential model in the
 *  upstream sign_up_tip slot instead. The EXTERNAL AUTH W4 arm (specs/
 *  external-auth-sources.md §5.6, upstream signup_inner.tmpl:50-56) renders
 *  the social block INSIDE the form after the fields — the same
 *  divider+navigator pair as the login page, driven by the `oauth2Sources`
 *  option (absent/empty = no block). */
export function SignUpPage(props: {
  ctx: UiContext;
  error: string | null;
  values?: { userName?: string; email?: string };
  oauth2Sources?: OAuth2LoginSourceButton[];
}) {
  const values = props.values ?? {};
  return (
    <BaseLayout ctx={props.ctx} title={signUpLocale.title} pageClass="user signin">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{signUpLocale.title}</h4>
          <div class="ui attached segment">
            <div class="ui positive message">{signUpLocale.token_auth_notice}</div>
            <form class="ui form" action="/user/sign_up" method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <div class="required field">
                <label for="user_name">{signUpLocale.user_name}</label>
                <input
                  id="user_name"
                  name="user_name"
                  type="text"
                  value={values.userName ?? ""}
                  autocomplete="username"
                  autofocus
                  required
                />
              </div>
              <div class="required field">
                <label for="email">{signUpLocale.email}</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={values.email ?? ""}
                  required
                />
              </div>
              <div class="inline field">
                <button type="submit" class="ui primary button tw-w-full">
                  {signUpLocale.submit}
                </button>
              </div>
              {/* signup_inner.tmpl:50-56 — the external methods block sits
                  INSIDE the form (upstream's own markup shape), before its
                  close. */}
              {props.oauth2Sources !== undefined ? (
                <ExternalAuthMethods sources={props.oauth2Sources} />
              ) : null}
            </form>
          </div>
          <div class="ui attached segment header top tw-flex tw-flex-col tw-items-center">
            <span>
              {signUpLocale.already_have_account}{" "}
              <a href="/login">{signUpLocale.sign_in_now}</a>
            </span>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-page render the first-run router answers with. */
export function renderSignUpPage(options: {
  ctx: UiContext;
  error: string | null;
  values?: { userName?: string; email?: string };
  oauth2Sources?: OAuth2LoginSourceButton[];
}): string {
  return renderPage(
    <SignUpPage
      ctx={options.ctx}
      error={options.error}
      values={options.values}
      oauth2Sources={options.oauth2Sources}
    />,
  );
}

/**
 * The install page render (`GET /install`): the login page with the
 * admin-init panel set — zero-user instances see "Administrator Account
 * Settings" under the sign-in form; an initialized instance never renders
 * it (the router 303s to `/` before any render). signUpLink stays off
 * here: while the init window is open there is nothing to register into.
 */
export function renderInstallPage(options: { ctx: UiContext; adminInit: AdminInitPanel }): string {
  return renderLoginPage({ ctx: options.ctx, redirectTo: null, error: null, adminInit: options.adminInit });
}
