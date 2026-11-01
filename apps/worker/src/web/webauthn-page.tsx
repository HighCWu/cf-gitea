/**
 * The WebAuthn LOGIN PROMPT page — `GET /user/webauthn`, upstream
 * `templates/user/auth/webauthn.tmpl` over `webauthn_error.tmpl`
 * (auth.WebAuthn renders it; the route + gates live in webauthn.ts).
 *
 * The DOM is a WIRE CONTRACT: the vendored Gitea frontend bundle (loaded by
 * the shell) registers initUserAuthWebAuthn, which activates on
 * `.user.signin.webauthn-prompt` and drives the whole ceremony against this
 * backend's endpoints (web_src/js/features/user-auth-webauthn.ts:12-31,
 * 88-121) — the class marker, the `#webauthn-error`/`#webauthn-error-msg`
 * pair and the `data-webauthn-error-msg` spans are what its error ladder
 * reads. Rendered upstream-verbatim at the pin (twofa header, the
 * insert-key segment, the loading-spinner segment, the two_factor link
 * armed by the HasTwoFactor data the router loads; base/alert has no flash
 * data on this surface — no render).
 */

import { BaseLayout, Icon, renderPage } from "../ui/shell";
import type { UiContext } from "../ui/ui-context";

/** The page's strings — the upstream keys at the pin. */
export const webAuthnPromptLocale = {
  twofa: "Two-Factor Authentication", // "twofa" (the title + the header)
  insertKey: "Insert your security key", // "webauthn_insert_key"
  signIn: "Press the button on your security key. If your security key has no button, re-insert it.", // "webauthn_sign_in"
  pressButton: "Please press the button on your security key…", // "webauthn_press_button"
  useTwofa: "Use a two-factor code from your phone", // "webauthn_use_twofa"
  error: "Could not read your security key.", // "webauthn_error"
  unsupportedBrowser: "Your browser does not currently support WebAuthn.", // "webauthn_unsupported_browser"
  errorUnknown: "An unknown error occurred. Please retry.", // "webauthn_error_unknown"
  errorInsecure:
    'WebAuthn only supports secure connections. For testing over HTTP, you can use the origin "localhost".', // "webauthn_error_insecure"
  errorUnableToProcess: "The server could not process your request.", // "webauthn_error_unable_to_process"
  errorDuplicated:
    "The security key is not permitted for this request. Please make sure that the key is not already registered.", // "webauthn_error_duplicated"
  errorEmpty: "You must set a name for this key.", // "webauthn_error_empty"
  errorTimeout: "Timeout reached before your key could be read. Please reload this page and retry.", // "webauthn_error_timeout"
} as const;

/** webauthn_error.tmpl — the hidden error ladder the bundle's
 *  webAuthnError() fills (the typed spans + the message slot). */
function WebAuthnErrorBox() {
  return (
    <div id="webauthn-error" class="ui negative message tw-hidden">
      <div class="header">{webAuthnPromptLocale.error}</div>
      <div id="webauthn-error-msg" class="tw-pt-2"></div>
      <div class="tw-hidden">
        <div data-webauthn-error-msg="browser">{webAuthnPromptLocale.unsupportedBrowser}</div>
        <div data-webauthn-error-msg="unknown">{webAuthnPromptLocale.errorUnknown}</div>
        <div data-webauthn-error-msg="insecure">{webAuthnPromptLocale.errorInsecure}</div>
        <div data-webauthn-error-msg="unable-to-process">{webAuthnPromptLocale.errorUnableToProcess}</div>
        <div data-webauthn-error-msg="duplicated">{webAuthnPromptLocale.errorDuplicated}</div>
        <div data-webauthn-error-msg="empty">{webAuthnPromptLocale.errorEmpty}</div>
        <div data-webauthn-error-msg="timeout">{webAuthnPromptLocale.errorTimeout}</div>
      </div>
    </div>
  );
}

/** The prompt page (webauthn.tmpl). `hasTwoFactor` arms the "use a code
 *  from your phone" link (the template's `{{if .HasTwoFactor}}`). */
export function renderWebAuthnPromptPage(ctx: UiContext, data: { hasTwoFactor: boolean }): string {
  return renderPage(
    <BaseLayout ctx={ctx} title={webAuthnPromptLocale.twofa} pageClass="user signin webauthn-prompt">
      <div role="main" aria-label={webAuthnPromptLocale.twofa} class="page-content user signin webauthn-prompt">
        <div class="ui page grid">
          <div class="column tw-text-center">
            <WebAuthnErrorBox />
            <h3 class="ui top attached header">{webAuthnPromptLocale.twofa}</h3>
            <div class="ui attached segment">
              {/* octicon-key is outside the generated allowlist — the
                  settings-keys shield-lock substitute (the house rule). */}
              <Icon name="octicon-shield-lock" size={56} />
              <h3>{webAuthnPromptLocale.insertKey}</h3>
              <p>{webAuthnPromptLocale.signIn}</p>
            </div>
            <div class="ui attached segment tw-flex tw-items-center tw-justify-center tw-gap-1 tw-py-2">
              <div class="is-loading tw-w-[40px] tw-h-[40px]"></div>
              <span>{webAuthnPromptLocale.pressButton}</span>
            </div>
            {data.hasTwoFactor ? (
              <div class="ui attached segment">
                <a href="/user/two_factor">{webAuthnPromptLocale.useTwofa}</a>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>,
  );
}
