/**
 * The MUST-CHANGE password page — `/user/settings/change_password`, the
 * PWD-4 enforcement half's web arm (SPEC-0002 §6.3). Upstream pin:
 * routers/web/auth/password.go:267-327 (`MustChangePassword` GET +
 * `MustChangePasswordPost` POST) over templates/user/auth/
 * change_passwd.tmpl + change_passwd_inner.tmpl, mounted at web.go:637-638
 * inside the reqSignIn `/user/settings` group.
 *
 * The shape is the settings change-password form MINUS the old-password
 * field: an admin-created account signs in with the temp password it was
 * seeded with, and upstream's MustChangePasswordForm (forms/user_form.go:
 * 92-96) carries only `password` + `retype` — the live session IS the
 * credential (password.go:286's NeedChangePassword guard runs in the
 * router; our middleware-equivalent arm rides resolveUiSession). The POST
 * applies the shared UpdateAuth arm (services/user-accounts.ts
 * applyPasswordReset — password.go:298-301's `MustChangePassword:
 * optional.Some(false)` call) and lands on "/" (upstream redirectAfterAuth
 * → consumeAuthRedirectLink's default target; the template carries no
 * redirect_to field). Success re-renders are upstream's
 * RenderWithErrDeprecated arms; the success flash
 * (settings.change_password_success) rides no queue in the house's
 * no-flash reduction — the redirect IS the landing.
 *
 * The template is NOT vendored (the password-reset.tsx posture): the layout
 * follows the auth page family's hono/jsx conventions; every copy string
 * cites its locale key. NOTE upstream renders this page in the "signin"
 * page family (change_passwd.tmpl's `page-content user signin`) — mirrored
 * in the pageClass.
 */

import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

export const changePasswordLocale = {
  /** "auth.must_change_password" — the page title AND the git-UA 401
   *  message (web.go:200's `ctx.Locale.TrString("auth.must_change_password")`,
   *  upstream locale: "Update your password"). */
  must_change_password: "Update your password",
  /** "settings.change_password" — the form header + the submit button
   *  (change_passwd_inner.tmpl's h4 + button label). */
  change_password: "Update Password",
  /** "password" — the new-password field label. */
  password: "Password",
  /** "re_type" — the confirm field label (change_passwd_inner.tmpl's
   *  `for="retype"`). */
  retype: "Confirm Password",
} as const;

/**
 * The must-change form (change_passwd_inner.tmpl's reduced field set over
 * the auth family's conventions): the new password pair with
 * `autocomplete="new-password"`, NO old-password field, the error flash
 * above the form (base/alert's RenderWithErrDeprecated slot). Rendered in
 * the SIGNED-IN shell — the doer is mid-flow, not anonymous.
 */
export function MustChangePasswordPage(props: { ctx: UiContext; error: string | null }) {
  return (
    <BaseLayout ctx={props.ctx} title={changePasswordLocale.must_change_password} pageClass="user signin">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{changePasswordLocale.change_password}</h4>
          <div class="ui attached segment">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <form class="ui form" action="/user/settings/change_password" method="post">
              <div class="required field">
                <label for="password">{changePasswordLocale.password}</label>
                <input id="password" name="password" type="password" autocomplete="new-password" required />
              </div>
              <div class="required field">
                <label for="retype">{changePasswordLocale.retype}</label>
                <input id="retype" name="retype" type="password" autocomplete="new-password" required />
              </div>
              <div class="inline field">
                <button type="submit" class="ui primary button tw-w-full">
                  {changePasswordLocale.change_password}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The router-facing render helper (the hono/jsx split — the routers stay
 *  JSX-free). */
export function renderMustChangePasswordPage(options: { ctx: UiContext; error: string | null }): string {
  return renderPage(<MustChangePasswordPage ctx={options.ctx} error={options.error} />);
}
