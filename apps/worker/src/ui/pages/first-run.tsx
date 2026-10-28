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
 * required `user_name`/`email`/`password`/`retype` fields, the
 * `auth.create_new_account` submit, and the already-have-account footer.
 * The install page is the login page with `adminInit` set (see login.tsx —
 * upstream's install posture reduced to that panel).
 */

import { BaseLayout, renderPage } from "../shell";
import type { AdminInitPanel } from "./login";
import { renderLoginPage } from "./login";
import type { UiContext } from "../ui-context";

/** Component-local strings (the orgCreateLocale pattern — locale.ts is
 *  shared and not this wave's file). Upstream keys cited per entry. */
export const signUpLocale = {
  title: "Register", // "sign_up"
  user_name: "Username", // "username"
  email: "Email Address", // "email"
  password: "Password", // "password" (accepted-and-ignored — PAT-only auth,
  //  SPEC-0002 §4.6.7; the field keeps upstream RegisterForm's shape)
  retype: "Confirm Password", // "re_type"
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
 *  bindings (never the passwords). */
export function SignUpPage(props: {
  ctx: UiContext;
  error: string | null;
  values?: { userName?: string; email?: string };
}) {
  const values = props.values ?? {};
  return (
    <BaseLayout ctx={props.ctx} title={signUpLocale.title} pageClass="user signin">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{signUpLocale.title}</h4>
          <div class="ui attached segment">
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
              <div class="required field">
                <label for="password">{signUpLocale.password}</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  required
                />
              </div>
              <div class="required field">
                <label for="retype">{signUpLocale.retype}</label>
                <input id="retype" name="retype" type="password" autocomplete="new-password" required />
              </div>
              <div class="inline field">
                <button type="submit" class="ui primary button tw-w-full">
                  {signUpLocale.submit}
                </button>
              </div>
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
}): string {
  return renderPage(
    <SignUpPage ctx={options.ctx} error={options.error} values={options.values} />,
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
