/**
 * The OAuth2 consent page + the grant_error page (SPEC specs/oauth2-provider.md
 * §2.2 step 8 — W3). Byte-level reductions of the pin's
 * `templates/user/auth/grant.tmpl` and `templates/user/auth/grant_error.tmpl`
 * over the SPEC-0008 shell (the login.tsx pattern: plain HTML form, no client
 * script):
 *
 *   - the `oauth2-authorize-application-box` page-content class, the
 *     tw-max-w-[500px] container, the attached header/segment stack, the
 *     hidden client_id/state/scope/nonce/redirect_uri fields and the
 *     `granted=true|false` submit pair (ids and classes verbatim);
 *   - the AdditionalScopes flag drives the description line exactly like the
 *     template's `{{if not .AdditionalScopes}}` (the description shows when
 *     the grant's access authority is the legacy `all` — see
 *     oauth2-authorize.ts grantAdditionalScopes);
 *   - AddedScopes renders the "New scopes:" callout only when non-empty;
 *   - REMOVED scopes are never rendered (the template has no arm for them —
 *     the diff still drives scopeChanged in the handler);
 *   - the creator line: `<a href="/{username}">@{username}</a>` for a
 *     user-owned application (upstream ApplicationCreatorLinkHTML's HomeLink
 *     arm, oauth2_provider.go:366-370), `<a href="/">{instance}</a>` without
 *     the @ for uid=0 (the builtin seed's instance arm, :371-373).
 *
 * One divergence, forced by the shell: upstream never sets Data["Title"] on
 * this page, so its document title is the bare site name and its role=main
 * aria-label renders EMPTY; our BaseLayout uses the title for the
 * aria-label and the house a11y smoke (R3) requires it non-empty — the
 * authorize_title string fills the slot.
 *
 * The grant_error page keeps the template's h1→h3 shape VERBATIM — the house
 * a11y rule R2 flags that level skip; upstream parity wins per AGENTS.md's
 * decision rule and the golden test pins the single expected R2 violation
 * instead of bending the page.
 */

import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Component-local strings (the loginFirstRunLocale pattern — locale.ts is
 *  shared and not this wave's file). Upstream keys cited per entry
 *  (gitea/options/locale/locale_en-US.json at the pin). */
export const oauth2GrantLocale = {
  /** "auth.authorize_title" — `Authorize "%s" to access your account?` over
   *  the application name. */
  authorize_title: (appName: string): string => `Authorize "${appName}" to access your account?`,
  /** "auth.authorize_application_description" */
  authorize_application_description:
    "If you grant access, it will be able to access and write to all your account information, including private repos and organizations.",
  /** "auth.authorize_application_created_by" — prefix/suffix around the
   *  creator link (%s carries template.HTML upstream). */
  created_by_prefix: "This application was created by ",
  created_by_suffix: ".",
  /** "auth.authorize_application_with_scopes" */
  with_scopes_prefix: "With scopes: ",
  /** "auth.authorize_application_new_scopes" */
  new_scopes_prefix: "New scopes: ",
  /** "auth.authorize_redirect_notice" — prefix/suffix around the
   *  <strong> redirect target (%s carries template.HTML upstream). */
  redirect_notice_prefix: "You will be redirected to ",
  redirect_notice_suffix: " if you authorize this application.",
  /** "auth.authorize_application" */
  authorize_application: "Authorize Application",
  /** "cancel" */
  cancel: "Cancel",
  /** "auth.authorization_failed" */
  authorization_failed: "Authorization failed",
  /** "auth.authorization_failed_desc" */
  authorization_failed_desc:
    "The authorization failed because we detected an invalid request. Please contact the maintainer of the app you tried to authorize.",
} as const;

/** The consent page (grant.tmpl). Every prop renders verbatim; the form
 *  POSTs `granted=true|false` to /login/oauth/grant (AppSubUrl is empty
 *  here — the root mount). */
export function Oauth2GrantPage(props: {
  ctx: UiContext;
  applicationName: string;
  clientId: string;
  /** The owning user's username; null ⇒ the instance arm (uid=0). */
  creatorUsername: string | null;
  /** The instance display name for the uid=0 creator arm. */
  instanceName: string | null;
  scope: string;
  addedScopes: string[];
  additionalScopes: boolean;
  redirectUri: string;
  state: string;
  nonce: string;
}) {
  return (
    <BaseLayout ctx={props.ctx} title={oauth2GrantLocale.authorize_title(props.applicationName)} pageClass="oauth2-authorize-application-box">
      <div class="ui container tw-max-w-[500px]">
        <h3 class="ui top attached header">{oauth2GrantLocale.authorize_title(props.applicationName)}</h3>
        <div class="ui attached segment">
          <p>
            {!props.additionalScopes ? (
              <>
                <b>{oauth2GrantLocale.authorize_application_description}</b>
                <br />
              </>
            ) : null}
            {oauth2GrantLocale.created_by_prefix}
            {props.creatorUsername !== null ? (
              <a href={`/${props.creatorUsername}`}>@{props.creatorUsername}</a>
            ) : (
              <a href="/">{props.instanceName ?? "cf-gitea"}</a>
            )}
            {oauth2GrantLocale.created_by_suffix}
            <br />
            {oauth2GrantLocale.with_scopes_prefix}
            <b>{props.scope}</b>
            {props.addedScopes.length > 0 ? (
              <>
                <br />
                {oauth2GrantLocale.new_scopes_prefix}
                <b>{props.addedScopes.join(" ")}</b>
              </>
            ) : null}
          </p>
        </div>
        <div class="ui attached segment">
          <p>
            {oauth2GrantLocale.redirect_notice_prefix}
            <strong>{props.redirectUri}</strong>
            {oauth2GrantLocale.redirect_notice_suffix}
          </p>
        </div>
        <div class="ui attached segment tw-text-center">
          <form method="post" action="/login/oauth/grant">
            <input type="hidden" name="client_id" value={props.clientId} />
            <input type="hidden" name="state" value={props.state} />
            <input type="hidden" name="scope" value={props.scope} />
            <input type="hidden" name="nonce" value={props.nonce} />
            <input type="hidden" name="redirect_uri" value={props.redirectUri} />
            <button type="submit" id="authorize-app" name="granted" value="true" class="ui red inline button">
              {oauth2GrantLocale.authorize_application}
            </button>
            <button type="submit" name="granted" value="false" class="ui basic primary inline button">
              {oauth2GrantLocale.cancel}
            </button>
          </form>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The grant_error page (grant_error.tmpl) — the 400 arm when no validated
 *  redirect URI exists to carry the error. */
export function Oauth2GrantErrorPage(props: { ctx: UiContext; errorDescription: string }) {
  return (
    <BaseLayout ctx={props.ctx} title={oauth2GrantLocale.authorization_failed} pageClass="oauth2-authorize-application-box">
      <div class="ui container tw-max-w-[500px]">
        <h1 class="ui top attached header">{oauth2GrantLocale.authorization_failed}</h1>
        <h3 class="ui attached segment">{props.errorDescription}</h3>
        <div class="ui attached segment">
          <p>{oauth2GrantLocale.authorization_failed_desc}</p>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-page renders the router answers with (render.tsx's split — the
 *  router module stays JSX-free). */
export function renderOauth2GrantPage(options: {
  ctx: UiContext;
  applicationName: string;
  clientId: string;
  creatorUsername: string | null;
  instanceName: string | null;
  scope: string;
  addedScopes: string[];
  additionalScopes: boolean;
  redirectUri: string;
  state: string;
  nonce: string;
}): string {
  return renderPage(<Oauth2GrantPage {...options} />);
}

export function renderOauth2GrantErrorPage(options: { ctx: UiContext; errorDescription: string }): string {
  return renderPage(<Oauth2GrantErrorPage {...options} />);
}
