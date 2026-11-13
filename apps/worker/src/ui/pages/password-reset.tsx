/**
 * The forgot/reset password pages — upstream
 * templates/user/auth/forgot_password.tmpl + reset_password.tmpl over the
 * routers/web/auth/password.go handlers (SPEC-0002 §6.2 reset row, PWD-2).
 * Rendered in the anonymous shell (login.tsx's BaseLayout posture).
 *
 * THE FORGOT-REQUEST ARM (B-84): with a mailer configured (MAIL_ENABLED)
 * the GET renders the IsResetRequest form and the POST the full
 * ForgotPasswdPost ladder (password.go:53-106) — the anti-enumeration
 * posture renders the SAME IsResetSent prompt for an unknown AND a known
 * account (no user-existence oracle). Without a mailer the GET renders the
 * reset-disabled state (upstream's IsResetDisable arm — no mailer ⇒ no reset
 * request) and the POST 404s (password.go:53-57's NotFound). The
 * RESET-COMPLETE arm (the valid-code consumption) is live: GET
 * /user/reset_password?code=… verifies the HMAC time-limit code, POST
 * applies the new password through the UpdateAuth ladder. NOTE: upstream's
 * templates are NOT vendored (the submodule carries source, not templates/)
 * — the layout follows the login/signup page family's hono/jsx conventions;
 * every copy string cites its locale key.
 */

import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

export const passwordResetLocale = {
  forgot_title: "Forgot Password", // "auth.forgot_password_title"
  reset_title: "Account Recovery", // "auth.reset_password"
  reset_disabled:
    "Password recovery is not available on this instance: no mail service is configured.", // the IsResetDisable posture (forgot_password.tmpl's disabled arm; reduced render — the template is not vendored)
  email_label: "Email Address", // "email"
  send_reset_mail: "Send Account Recovery Email", // "auth.send_reset_mail"
  new_password: "New Password", // "settings.new_password"
  retype_new_password: "Confirm New Password", // "settings.retype_new_password"
  passcode: "Auth passcode", // "auth.passcode" (the reset form's 2FA field, reset_password.tmpl)
  scratch_code: "Scratch code", // "auth.scratch_code"
  remember_me: "Remember This Device", // "auth.remember_me"
  submit: "Recover Account", // "auth.reset_password_helper"
  invalid_code: "Your confirmation code is invalid or has expired.", // "auth.invalid_code"
  non_local_account:
    "Non-local users cannot update their password through the Gitea web interface.", // "auth.non_local_account" (password.go:81-85's flash)
  reset_password_wrong_user:
    "You are signed in as %s, but the account recovery link is meant for %s", // "auth.reset_password_wrong_user" (B-83)
} as const;

/** The forgot page's three render states (forgot_passwd.tmpl's data arms):
 *  `disabled` — IsResetDisable (no mailer); `request` — IsResetRequest (the
 *  email form, `errEmail` = Err_Email's field-error class, `error` = the
 *  flash slot RenderWithErrDeprecated fills); `sent` — IsResetSent (the
 *  prompt rendered for a known AND an unknown account alike). */
export type ForgotPasswordState =
  | { state: "disabled" }
  | { state: "request"; email: string; errEmail?: boolean; error?: string }
  | { state: "sent"; email: string; lives: string };

/** GET/POST /user/forgot_password — forgot_passwd.tmpl's reduced render.
 *  The `sent` prompt is locale auth.reset_password_mail_sent_prompt ("A
 *  confirmation email has been sent to <b>%s</b>. Please check your inbox
 *  within the next %s to complete the account recovery process."); the <b>
 *  wrapper is the locale string's own, composed here as elements. */
export function ForgotPasswordPage(props: { ctx: UiContext; arm?: ForgotPasswordState }) {
  const arm = props.arm ?? { state: "disabled" as const };
  return (
    <BaseLayout ctx={props.ctx} title={passwordResetLocale.forgot_title} pageClass="user forgot password">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{passwordResetLocale.forgot_title}</h4>
          <div class="ui attached segment">
            {arm.state === "sent" ? (
              <p class="text left">
                {"A confirmation email has been sent to "}
                <b>{arm.email}</b>
                {". Please check your inbox within the next "}
                {arm.lives}
                {" to complete the account recovery process."}
              </p>
            ) : null}
            {arm.state === "request" && arm.error !== undefined ? (
              <div class="ui negative message">{arm.error}</div>
            ) : null}
            {arm.state === "request" ? (
              <form class="ui form" action="/user/forgot_password" method="post">
                <div class={`required field${arm.errEmail ? " error" : ""}`}>
                  <label for="email">{passwordResetLocale.email_label}</label>
                  <input id="email" name="email" type="email" value={arm.email} autofocus required />
                </div>
                <div class="divider" />
                <div class="inline field">
                  <button type="submit" class="ui primary button">
                    {passwordResetLocale.send_reset_mail}
                  </button>
                </div>
              </form>
            ) : null}
            {arm.state === "disabled" ? (
              <div class="ui info message">
                <p class="text left">{passwordResetLocale.reset_disabled}</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The reset form (reset_password.tmpl:6-38's reduced field set): the new
 *  password pair, the 2FA fields when the account is TOTP-enrolled, the
 *  remember checkbox. `error` renders the failure flash. `action` mirrors
 *  upstream's `{{.Link}}` (the served path without the query — context.go:59;
 *  the reset MAIL's link lands on /user/recover_account, web.go:761-762's
 *  alias of the same handlers, and the form posts BACK to that path). */
export function ResetPasswordPage(props: {
  ctx: UiContext;
  code: string;
  error: string | null;
  twoFactor: boolean;
  action?: string;
}) {
  const action = props.action ?? "/user/reset_password";
  return (
    <BaseLayout ctx={props.ctx} title={passwordResetLocale.reset_title} pageClass="user reset password">
      <div class="ui middle very relaxed page grid">
        <div class="column tw-flex tw-flex-col tw-gap-4 tw-max-w-2xl tw-m-auto">
          <h4 class="ui top attached header center">{passwordResetLocale.reset_title}</h4>
          <div class="ui attached segment">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <form class="ui form" action={action} method="post">
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

/**
 * password.go:144-146's flash text (B-83, auth.reset_password_wrong_user,
 * locale_en-US): the Go `%s` pair filled with (doer.Email, target.Email).
 * Function replacers, so email content can never trip the `$` replacement
 * patterns. The wrong-user refusal renders this as the page's error flash;
 * the reset does NOT apply (the probe lives with the session arms — this
 * module stays session-free, the import cycle must not close).
 */
export function resetWrongUserMessage(doerEmail: string, targetEmail: string): string {
  return passwordResetLocale.reset_password_wrong_user.replace("%s", () => doerEmail).replace("%s", () => targetEmail);
}

/** The router-facing render helpers (the hono/jsx split — session.ts stays
 *  JSX-free). */
export function renderForgotPasswordPage(ctx: UiContext, arm?: ForgotPasswordState): string {
  return renderPage(<ForgotPasswordPage ctx={ctx} arm={arm} />);
}

export function renderResetPasswordPage(options: {
  ctx: UiContext;
  code: string;
  error: string | null;
  twoFactor: boolean;
  action?: string;
}): string {
  return renderPage(
    <ResetPasswordPage
      ctx={options.ctx}
      code={options.code}
      error={options.error}
      twoFactor={options.twoFactor}
      action={options.action}
    />,
  );
}
