/**
 * The forgot/reset password pages — upstream
 * templates/user/auth/forgot_password.tmpl + reset_password.tmpl over the
 * routers/web/auth/password.go handlers (SPEC-0002 §6.2 reset row, PWD-2).
 * Rendered in the anonymous shell (login.tsx's BaseLayout posture).
 *
 * THE FORGOT-REQUEST ARM STAYS GATED OFF (upstream-faithful absence):
 * without a Workers mailer the GET renders the reset-disabled state
 * (upstream's IsResetDisable arm — no mailer ⇒ no reset request) and the
 * POST 404s (password.go:53-57's NotFound). The RESET-COMPLETE arm (the
 * valid-code consumption) is live: GET /user/reset_password?code=… verifies
 * the HMAC time-limit code, POST applies the new password through the
 * UpdateAuth ladder. NOTE: upstream's templates are NOT vendored (the
 * submodule carries source, not templates/) — the layout follows the
 * login/signup page family's hono/jsx conventions; every copy string cites
 * its locale key.
 */

import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

export const passwordResetLocale = {
  forgot_title: "Forgot Password", // "auth.forgot_password_title"
  reset_title: "Account Recovery", // "auth.reset_password"
  reset_disabled:
    "Password recovery is not available on this instance: no mail service is configured.", // the IsResetDisable posture (forgot_password.tmpl's disabled arm; reduced render — the template is not vendored)
  new_password: "New Password", // "settings.new_password"
  retype_new_password: "Confirm New Password", // "settings.retype_new_password"
  passcode: "Auth passcode", // "auth.passcode" (the reset form's 2FA field, reset_password.tmpl)
  scratch_code: "Scratch code", // "auth.scratch_code"
  remember_me: "Remember This Device", // "auth.remember_me"
  submit: "Recover Account", // "auth.reset_password_helper"
  invalid_code: "Your confirmation code is invalid or has expired.", // "auth.invalid_code"
} as const;

/** GET /user/forgot_password — the reset-disabled state (no mailer). */
export function ForgotPasswordPage(props: { ctx: UiContext }) {
  return (
    <BaseLayout ctx={props.ctx} title={passwordResetLocale.forgot_title} pageClass="user forgot password">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{passwordResetLocale.forgot_title}</h4>
          <div class="ui attached segment">
            <div class="ui info message">
              <p class="text left">{passwordResetLocale.reset_disabled}</p>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The reset form (reset_password.tmpl:6-38's reduced field set): the new
 *  password pair, the 2FA fields when the account is TOTP-enrolled, the
 *  remember checkbox. `error` renders the failure flash. */
export function ResetPasswordPage(props: {
  ctx: UiContext;
  code: string;
  error: string | null;
  twoFactor: boolean;
  scratchMode?: boolean;
}) {
  return (
    <BaseLayout ctx={props.ctx} title={passwordResetLocale.reset_title} pageClass="user reset password">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{passwordResetLocale.reset_title}</h4>
          <div class="ui attached segment">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <form class="ui form" action="/user/reset_password" method="post">
              <input type="hidden" name="code" value={props.code} />
              {props.twoFactor ? (
                <div class="field">
                  <label for="passcode">{passwordResetLocale.passcode}</label>
                  <input id="passcode" name="passcode" type="text" autocomplete="one-time-code" />
                </div>
              ) : null}
              <div class="required field">
                <label for="password">{passwordResetLocale.new_password}</label>
                <input id="password" name="password" type="password" autocomplete="new-password" required />
              </div>
              <div class="required field">
                <label for="retype">{passwordResetLocale.retype_new_password}</label>
                <input id="retype" name="retype" type="password" autocomplete="new-password" required />
              </div>
              <div class="inline field">
                <div class="ui checkbox">
                  <label for="remember">{passwordResetLocale.remember_me}</label>
                  <input id="remember" name="remember" type="checkbox" />
                </div>
              </div>
              <div class="field">
                <button type="submit" class="ui primary button tw-w-full">{passwordResetLocale.submit}</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The router-facing render helpers (the hono/jsx split — session.ts stays
 *  JSX-free). */
export function renderForgotPasswordPage(ctx: UiContext): string {
  return renderPage(<ForgotPasswordPage ctx={ctx} />);
}

export function renderResetPasswordPage(options: {
  ctx: UiContext;
  code: string;
  error: string | null;
  twoFactor: boolean;
}): string {
  return renderPage(
    <ResetPasswordPage ctx={options.ctx} code={options.code} error={options.error} twoFactor={options.twoFactor} />,
  );
}
