/**
 * The user settings SECURITY tab, `/user/settings/security` — pages wave 56
 * (bench row `wave-settings-security-module`, MOUNTED at 0c2b151 — the route
 * lives in `index.ts`).
 *
 * Upstream pin: `templates/user/settings/security/security.tmpl` over its four
 * section templates (`security/twofa.tmpl`, `security/webauthn.tmpl`,
 * `security/accountlinks.tmpl`, `security/openid.tmpl`) and the
 * `security.Security` handler
 * (gitea/routers/web/user/setting/security/security.go:29-47).
 *
 * ## EXTERNAL AUTH W5 — the account-links section is LIVE
 *
 * `accountlinks.tmpl` renders now that the W1 store (`external_login_user`,
 * `login_source`) exists: upstream's own guard (`{{if or .AccountLinks
 * .OrderedOAuth2Names}}`, accountlinks.tmpl:2) keeps the section ABSENT for
 * a doer with no links on an instance with no active OAuth2 source — the
 * landed default posture is byte-stable. loadSecurityData's arms port as:
 * the doer's link rows joined to their `login_source` (a missing source row
 * drops the entry — security.go's `if … err == nil` skip arm; unreachable
 * through the admin flow, whose delete refuses an in-use source), the
 * ACTIVE OAuth2 sources as the link buttons (security.go's
 * `OrderedOAuth2Names` — active only, name order), and the provider display
 * name off the registry (`displayName`; upstream's cfg `DisplayName()/
 * Name()` chain reduced to the registry — our cfg carries no displayName
 * field, the lattice is the single source). The list rows render upstream's
 * shape (icon, source name, the Active badge, Remove); the Remove control
 * is a PLAIN-FORM POST (the house no-JS rule — upstream's `link-action`
 * button is JS-driven, type="button"; the form makes unlink work with JS
 * disabled, the admin-pages delete idiom) carrying upstream's
 * `data-modal-confirm` hook + the `#delete-account-link` dialog bytes
 * (repo-wiki's dialog precedent; the dialog's own buttons stay inert no-JS
 * exactly like upstream's). The "Link Account" dropdown
 * (accountlinks.tmpl:5-20, a Fomantic JS-open menu) reduces to always-
 * visible button anchors — a JS-gated menu is a dead control in the no-JS
 * shell.
 *
 * ## The unlink arm (`POST /user/settings/security/account_link`,
 * web.go:677 `DeleteAccountLink`, security.go:50-70)
 *
 * Seams live HERE (the admin-auths split); the ui/index.ts hunks are the
 * HANDOFF — the settings prologue (`userSettingsTabPrologue`) is
 * module-private there. Recipe (the appearanceSubmit shape):
 *
 *   import { applyAccountLinkUnlink, loadUserSettingsSecurityPageData,
 *            parseAccountLinkUnlinkForm, renderUserSettingsSecurityPage }
 *   //   from "./pages/user-settings-security";
 *
 *   async function userSettingsSecurityUnlink(c: Context<{ Bindings: Env }>): Promise<Response> {
 *     const p = await userSettingsTabPrologue(c, true);   // the origin guard rides the POST
 *     if (!p.ok) return p.response;
 *     const form = parseAccountLinkUnlinkForm(await readUrlEncodedForm(c.req.raw));
 *     const outcome = form.id === null
 *       ? { outcome: "not-exist" as const }               // security.go:55-57's id arm
 *       : await applyAccountLinkUnlink(c.env.DB, p.viewer.id, form.id);
 *     if (outcome.outcome === "removed") {
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/security" } }));
 *     }
 *     const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
 *     return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data, {
 *       notice: { kind: "negative", message: outcome.outcome === "invalid-id"
 *         ? "Account link id is not given" : userSettingsSecurityLocale.unlink_missing },
 *     })), 200);
 *   }
 *
 *   uiRouter.post("/user/settings/security/account_link", (c) => userSettingsSecurityUnlink(c));
 *   // the GET twin answers methodNotAllowed("POST") (chi's 405 — the job_queue posture)
 *
 * Upstream flashes + `JSONRedirect`s to /user/settings/security on BOTH
 * outcomes; the plain-form reduction keeps the failure message alive with a
 * 200 re-render notice (the W4 delete-refusal posture) and 303s the success
 * (the W4 success-arm posture — the message rides no wire; the removed row's
 * absence IS the feedback). Upstream emits an audit row
 * (`UserExternalLoginRemove`, security.go:59-61) — NOT emitted here: the
 * action id `user:externallogin:remove` (action.go:90) is unregistered in
 * the landed audit registry and services/audit.ts is outside this wave's
 * ownership; the exact registration hunk rides the W6 tail.
 *
 * ## Mount record (MOUNTED at 0c2b151 — the wiring HANDOFF is retired)
 *
 * Upstream's route group is web.go:662-677 (the `/user/settings/security`
 * subtree inside the reqSignIn `/user/settings` group). Only the GET mounts
 * (plus the W5 unlink POST above and the 2FA four below, HANDOFF):
 *
 *   GET /user/settings/security → resolveUiSession (signed-in gate, the
 *            user-settings.tsx pattern) → loadUserSettingsSecurityPageData →
 *            renderUserSettingsSecurityPage; a session doer without a D1 row
 *            404-shells (the silent-auth-failure convention).
 *
 * ## The TOTP arms (LIVE — migration 0059's `two_factor` table + the
 * src/auth/two-factor.ts seam; this unit flipped the derived posture off)
 *
 * `totpEnrolled` is now the REAL read (`hasTwoFactorByUid` — upstream's
 * `auth_model.HasTwoFactorByUID`, security.go:73-78), and BOTH template
 * arms render (twofa.tmpl at the pin):
 *
 *   - ENROLLED: `settings.twofa_is_enrolled` (the <strong> emphasis
 *     rendered as markup — the no-raw-HTML rule keeps it as elements), the
 *     regenerate form (POST …/regenerate_scratch), and the disable form
 *     (POST …/disable). THE DISABLE DIVERGENCE (the mission's mandate):
 *     upstream's disable form is a bare confirm dialog; ours carries a
 *     REQUIRED passcode input — a hijacked session must not strip 2FA with
 *     one click. The seam (applyTwofaDisable) verifies the code — TOTP in
 *     the ±1 window or the scratch token — WITHOUT consuming/burning it;
 *     recorded in src/auth/two-factor.ts's header. Upstream's
 *     `enctype="multipart/form-data"` on the regenerate form is DROPPED —
 *     the recipe handlers read urlencoded bodies (readUrlEncodedForm).
 *   - NOT ENROLLED: the description, the recovery tip, the not-enrolled
 *     line, and the Enroll BUTTON (twofa.tmpl:20-22) — now a LIVE link:
 *     the enroll page exists (ui/pages/twofa.tsx, the no-QR divergence
 *     documented there).
 *
 * The regenerate/disable POSTs and the enroll GET+POST are the HANDOFF —
 * the full handler recipe lives in ui/pages/twofa.tsx's module header
 * (userSettingsTabPrologue is index.ts-private, the unlink pattern). The
 * once-shown scratch token travels in the security page's `notice` slot:
 * after enroll/regenerate the handler re-renders THIS page with the
 * positive notice carrying the token (the flash rides no wire in the
 * no-JS shell; the W4 posture with the once-only carrier).
 *
 * Still UNMOUNTED — each write targets a store or op that does not exist:
 * the openid POST/`delete`/`toggle_visibility` trio (web.go:674-676,
 * security/openid.go). (The webauthn quartet is MOUNTED by the WebAuthn
 * unit's own router — src/web/webauthn.ts, web.go:669-673 — not here: its
 * dispatcher carve hands the tails to Hono beside that router's login
 * family.)
 *
 * ## Data (§3.2 — what the landed auth exposes)
 *
 *   - 2FA (TOTP): LIVE — the `two_factor` store (migration 0059) through
 *     src/auth/two-factor.ts; both twofa.tmpl arms render (above).
 *   - WebAuthn: LIVE (the WebAuthn unit) — the `webauthn_credentials`
 *     store (migration 0060) through src/web/webauthn-store.ts; the
 *     webauthn.tmpl section renders below (list + the register entry +
 *     the rename modal + the delete form; the JS ceremony is the vendored
 *     bundle's initUserAuthWebAuthnRegister against src/web/webauthn.ts).
 *   - Account links: LIVE (the W5 header section above).
 *   - OpenID: no `user_openid` store/ops → the section UNRENDERED.
 *
 * The password change: the change-password form lives on the Account tab;
 * cf-gitea has no password model at all (the login credential IS a PAT,
 * SPEC-0010 §1.3) so no password form renders anywhere.
 *
 * The `security.tmpl:2-15` wrapper gates the content on upstream's
 * `UserDisabledFeatures` MFA/credentials flags; cf-gitea models no
 * per-user disabled-feature list and upstream's default is enabled, so the
 * wrapper (`.user-setting-content`) renders.
 *
 * ## DOM contract (user/settings/{layout_head,navbar}.tmpl +
 *  security/security.tmpl + security/twofa.tmpl + security/accountlinks.tmpl
 *  at the pin)
 *
 * layout_head's pageClass is the literal `user settings security`; the
 * settings navbar is the SHARED components/settings-nav UserSettingsNavbar
 * with the Security item active. The content is `.user-setting-content`
 * carrying the twofa section and — when the guard's operands are non-empty —
 * the accountlinks section.
 */

import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import { hasTwoFactorByUid } from "../../auth/two-factor";
import { oauth2LoginSourceButtons, ProviderIcon } from "./login";
import { formatKeyDate } from "./user-settings-keys";
import { getProviderDescriptor } from "../../services/auth-sources/registry";
import { parseOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import { findExternalLogins, getLoginSource, listActiveOAuth2Sources, removeExternalLogin } from "../../services/auth-sources/store";
import { listCredentialsByUser } from "../../web/webauthn-store";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsSecurityLocale = {
  security: "Security", // "settings.security" (the title + the shared navbar item)
  twofa: "Two-Factor Authentication (TOTP)", // "settings.twofa"
  twofa_desc:
    'To protect your account against password theft, you can use a smartphone or another device for receiving time-based one-time passwords ("TOTP").', // "settings.twofa_desc"
  twofa_recovery_tip: "If you lose your device, you will be able to use a single-use recovery key to regain access to your account.", // "settings.twofa_recovery_tip"
  twofa_not_enrolled: "Your account is not currently enrolled in two-factor authentication.", // "settings.twofa_not_enrolled"

  // --- the account-links section (accountlinks.tmpl; W5) ---------------------
  manage_account_links: "Manage Linked Accounts", // "settings.manage_account_links"
  link_account: "Link Account", // "settings.link_account" (the dropdown button — the static buttons' slot)
  manage_account_links_desc: "These external accounts are linked to your Gitea account.", // "settings.manage_account_links_desc"
  active: "Active", // "repo.settings.active" (the per-row badge)
  remove: "Remove", // "remove"
  remove_account_link: "Remove Linked Account", // "settings.remove_account_link" (the dialog header)
  remove_account_link_desc:
    "Removing a linked account will revoke its access to your Gitea account. Continue?", // "settings.remove_account_link_desc"
  modal_no: "No", // "modal.no" (modal_actions_confirm's default negative)
  modal_yes: "Yes", // "modal.yes" (the default positive)
  /** The unlink POST's missing-row notice (the not-exist flash — upstream
   *  interpolates Go's ErrExternalLoginUserNotExist text into
   *  "RemoveAccountLink: …"; ours is the fixed non-committal copy). */
  unlink_missing: "The linked account was not found — it may already have been removed.",

  // --- the TOTP arms (twofa.tmpl; the 2FA unit) -------------------------------
  passcode: "Passcode", // "passcode" (the disable form's label — the mission's code requirement)
  twofa_is_enrolled_prefix: "Your account is currently ", // "settings.twofa_is_enrolled" (split at the template's <strong>)
  twofa_is_enrolled_strong: "enrolled", // "settings.twofa_is_enrolled" (the emphasized word)
  twofa_is_enrolled_suffix: " in two-factor authentication.", // "settings.twofa_is_enrolled"
  twofa_enroll_button: "Enroll in Two-Factor Authentication", // "settings.twofa_enroll" (the not-enrolled arm's button)
  regenerate_scratch_token_desc:
    "If you misplaced your recovery key or have already used it to sign in, you can reset it here.", // "settings.regenerate_scratch_token_desc"
  twofa_scratch_token_regenerate: "Regenerate Single-Use Recovery Key", // "settings.twofa_scratch_token_regenerate"
  twofa_disable_note: "You can disable two-factor authentication if needed.", // "settings.twofa_disable_note"
  twofa_disable: "Disable Two-Factor Authentication", // "settings.twofa_disable"
  twofa_disable_desc: "Disabling two-factor authentication will make your account less secure. Continue?", // "settings.twofa_disable_desc"

  // --- the WebAuthn section (webauthn.tmpl + webauthn_error.tmpl; the
  //     WebAuthn unit) ----------------------------------------------------------
  webauthn: "Two-Factor Authentication (Security Keys)", // "settings.webauthn"
  webauthn_desc_prefix: "Security keys are hardware devices containing cryptographic keys. They can be used for two-factor authentication. Security keys must support the", // "settings.webauthn_desc" (split at the template's link)
  webauthn_desc_link: "WebAuthn Authenticator", // "settings.webauthn_desc" (the link text)
  webauthn_key_loss_warning: "If you lose your security keys, you will lose access to your account.", // "settings.webauthn_key_loss_warning"
  webauthn_alternative_tip: "You may want to configure an additional authentication method.", // "settings.webauthn_alternative_tip"
  webauthn_nickname: "Nickname", // "settings.webauthn_nickname"
  webauthn_register_key: "Add Security Key", // "settings.webauthn_register_key"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it (the deploy-keys idiom)
  rename: "Rename", // "rename"
  webauthn_delete_key: "Remove Security Key", // "settings.webauthn_delete_key" (the dialog header)
  webauthn_delete_key_desc: "If you remove a security key, you can no longer sign in with it. Continue?", // "settings.webauthn_delete_key_desc"
  webauthn_error: "Could not read your security key.", // "webauthn_error" (the error box header)
  webauthn_unsupported_browser: "Your browser does not currently support WebAuthn.", // "webauthn_unsupported_browser"
  webauthn_error_unknown: "An unknown error occurred. Please retry.", // "webauthn_error_unknown"
  webauthn_error_insecure:
    'WebAuthn only supports secure connections. For testing over HTTP, you can use the origin "localhost".', // "webauthn_error_insecure"
  webauthn_error_unable_to_process: "The server could not process your request.", // "webauthn_error_unable_to_process"
  webauthn_error_duplicated:
    "The security key is not permitted for this request. Please make sure that the key is not already registered.", // "webauthn_error_duplicated"
  webauthn_error_empty: "You must set a name for this key.", // "webauthn_error_empty"
  webauthn_error_timeout: "Timeout reached before your key could be read. Please reload this page and retry.", // "webauthn_error_timeout"
} as const;

// ---------------------------------------------------------------------------
// The page data (upstream loadSecurityData's TOTPEnrolled derived + the
// account-links projections — the module header's W5 section)
// ---------------------------------------------------------------------------

/** One linked-account row (accountlinks.tmpl:28-48's item inputs). */
export interface AccountLinkView {
  /** The owning login_source id — the Remove form's `id` wire value
   *  (upstream's data-url id, security.go:52's FormInt64). */
  loginSourceId: number;
  /** `login_source.name` — the row's rendered title (accountlinks.tmpl:36). */
  sourceName: string;
  isActive: boolean;
  /** The cfg IconURL override (providers.go:63-70's img arm); null = the
   *  fallback glyph. */
  iconUrl: string | null;
  /** The cfg provider key (the glyph pick); "" = a dead stored cfg (the
   *  honest-degrade arm — upstream 500s here, the recorded divergence). */
  provider: string;
  /** The provider display name (the tooltip): the registry's displayName —
   *  upstream's cfg DisplayName()/Name() chain reduced (the module header);
   *  a dead cfg falls back to the source name. */
  displayName: string;
}

/** One Link-Account button (the `OrderedOAuth2Names` arm — ACTIVE sources,
 *  name order; accountlinks.tmpl:10-16's menu items). */
export interface AccountLinkButton {
  /** The source NAME — the dance-start href token AND the button text
   *  upstream renders as the provider DisplayName; ours renders
   *  `displayName` (below) as the text and keeps the name for the href. */
  name: string;
  displayName: string;
  iconUrl: string | null;
  provider: string;
}

/** One enrolled security key (webauthn.tmpl:10-29's item inputs — the
 *  WebAuthn unit; the display slice of webauthn-store's row). */
export interface WebAuthnCredentialView {
  /** The row id — the Rename/Delete forms' wire value (the template's
   *  data-modal-id / data-url id, ctx.FormInt64). */
  id: number;
  /** The nickname (webauthn.tmpl:16's item-title). */
  name: string;
  /** Upstream `CreatedUnix` (webauthn.tmpl:18's Added-on date). */
  createdUnix: Date;
}

/** The security tab's render inputs: the LIVE 2FA posture (the real
 *  `two_factor` read — the 2FA unit) + the W5 account-links projections
 *  (empty on every instance without linked identities/active sources — the
 *  section renders nothing, upstream's own guard) + the WebAuthn
 *  credentials (the WebAuthn unit; empty until a key enrolls). */
export interface UserSettingsSecurityPageData {
  totpEnrolled: boolean;
  /** The doer's links joined to their sources, `login_source_id` DESC
   *  (upstream loadSecurityData's OrderBy). A link whose source row is gone
   *  drops from the list (security.go's skip arm — the module header). */
  accountLinks: AccountLinkView[];
  /** The ACTIVE OAuth2 sources' link buttons (name order — the store read's
   *  order; upstream `sort.Strings(orderedOAuth2Names)`). Dead cfgs drop
   *  (the dead-source rule — a source that cannot complete a chain renders
   *  no entry point). */
  linkButtons: AccountLinkButton[];
  /** The enrolled security keys (upstream loadSecurityData's
   *  GetWebAuthnCredentialsByUID, security.go:80-86 — pk order, the store's
   *  default). */
  webauthnCredentials: WebAuthnCredentialView[];
}

/** The provider display name — the registry as the single source (the
 *  module header's reduction note). */
function providerDisplayName(provider: string, sourceName: string): string {
  if (provider !== "") {
    const descriptor = getProviderDescriptor(provider);
    if (descriptor !== undefined) return descriptor.displayName;
    return provider;
  }
  return sourceName;
}

/**
 * The page load — upstream's `HasTwoFactorByUID` arm (security.go:73-78)
 * over the LIVE `two_factor` store (the 2FA unit; the derived false
 * posture is retired) plus the W5 account-links projections (the module
 * header).
 */
export async function loadUserSettingsSecurityPageData(d1: D1Database, userId: number): Promise<UserSettingsSecurityPageData> {
  // The links joined to their sources (security.go:87-117): the store read
  // is external_id-ordered (W1's FindExternalUsers); upstream's settings
  // list OrderBy is `login_source_id DESC` — the sort lives here so the
  // store read stays untouched.
  const joined: AccountLinkView[] = [];
  for (const link of await findExternalLogins(d1, { userId })) {
    const source = await getLoginSource(d1, link.loginSourceId);
    if (source === null) continue; // security.go's `err == nil` skip arm
    let provider = "";
    let iconUrl: string | null = null;
    try {
      const cfg = parseOAuth2SourceConfig(source.cfg);
      provider = cfg.provider;
      iconUrl = cfg.iconUrl ?? null;
    } catch {
      // dead cfg — the honest-degrade row (globe glyph, source-name label)
    }
    joined.push({
      loginSourceId: source.id,
      sourceName: source.name,
      isActive: source.isActive,
      iconUrl,
      provider,
      displayName: providerDisplayName(provider, source.name),
    });
  }
  joined.sort((a, b) => b.loginSourceId - a.loginSourceId);

  // The ACTIVE sources (security.go:120-131 + the active filter at :144):
  // the login page's one-read projection (dead cfgs drop), enriched with
  // the display name.
  const linkButtons: AccountLinkButton[] = oauth2LoginSourceButtons(await listActiveOAuth2Sources(d1)).map((button) => ({
    ...button,
    displayName: providerDisplayName(button.provider, button.name),
  }));

  // The LIVE TOTP posture (security.go:73-78's HasTwoFactorByUID — the
  // existence read over migration 0059's table).
  // The WebAuthn credentials (security.go:80-86's
  // GetWebAuthnCredentialsByUID — the WebAuthn unit; pk order upstream).
  const webauthnCredentials: WebAuthnCredentialView[] = (await listCredentialsByUser(d1, userId)).map((cred) => ({
    id: cred.id,
    name: cred.name,
    createdUnix: cred.createdUnix,
  }));
  return {
    totpEnrolled: await hasTwoFactorByUid(d1, userId),
    accountLinks: joined,
    linkButtons,
    webauthnCredentials,
  };
}

// ---------------------------------------------------------------------------
// The unlink seams (security.go:50-70's DeleteAccountLink — the HANDOFF
// handler recipe lives in the module header)
// ---------------------------------------------------------------------------

/** `ctx.FormInt64("id")` (security.go:52): digits only, and `0` is the
 *  not-given arm upstream flashes (`id <= 0`); junk parses as null (the
 *  digits-only claim posture — the junk segment never reaches here through
 *  the mounted route, the form field can still carry junk). */
export function parseAccountLinkUnlinkForm(params: URLSearchParams): { id: number | null } {
  const raw = (params.get("id") ?? "").trim();
  if (!/^\d+$/.test(raw) || raw === "0") return { id: null };
  return { id: Number.parseInt(raw, 10) };
}

export type AccountLinkUnlinkOutcome = { outcome: "removed" } | { outcome: "not-exist" };

/**
 * `RemoveAccountLink` (external_login_user.go:107-118) over the W1 store
 * op: delete the (userId, loginSourceId) pair; zero rows deleted is
 * upstream's ErrExternalLoginUserNotExist (`not-exist` — the caller's 404
 * decision is the notice re-render per the header recipe). The pin carries
 * NO last-link guard (the mission's "if the pin carries one": it does not —
 * a doer may unlink every external identity; the password-less posture
 * keeps PAT sign-in working).
 */
export async function applyAccountLinkUnlink(d1: D1Database, userId: number, loginSourceId: number): Promise<AccountLinkUnlinkOutcome> {
  const deleted = await removeExternalLogin(d1, userId, loginSourceId);
  return deleted > 0 ? { outcome: "removed" } : { outcome: "not-exist" };
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/security/security.tmpl +
//  security/twofa.tmpl + security/accountlinks.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render. `options.notice` is the unlink POST's failure
 *  re-render slot (the W4 notices idiom; absent on the GET). */
export function renderUserSettingsSecurityPage(
  ctx: UiContext,
  data: UserSettingsSecurityPageData,
  options?: { notice?: { kind: "positive" | "negative"; message: string } },
): string {
  return renderPage(<UserSettingsSecurityPage ctx={ctx} data={data} notice={options?.notice} />);
}

/** The security page (§2.4.1 discriminator: `user settings security` —
 *  layout_head's pageClass). */
export function UserSettingsSecurityPage(props: {
  ctx: UiContext;
  data: UserSettingsSecurityPageData;
  notice?: { kind: "positive" | "negative"; message: string };
}) {
  const { data } = props;
  return (
    <BaseLayout ctx={props.ctx} title={userSettingsSecurityLocale.security} pageClass="user settings security">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="security" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {props.notice !== undefined ? (
              <div class={`ui ${props.notice.kind} message`}>{props.notice.message}</div>
            ) : null}
            {/* security.tmpl:5-7's twofa include — BOTH arms render (the
                module header's TOTP section). */}
            <h4 class="ui top attached header">{userSettingsSecurityLocale.twofa}</h4>
            <div class="ui attached segment">
              <p>{userSettingsSecurityLocale.twofa_desc}</p>
              {data.totpEnrolled ? (
                <>
                  {/* twofa.tmpl:6's enrolled line — the template's
                      <strong> rendered as elements (the no-raw-HTML rule). */}
                  <p>
                    {userSettingsSecurityLocale.twofa_is_enrolled_prefix}
                    <strong>{userSettingsSecurityLocale.twofa_is_enrolled_strong}</strong>
                    {userSettingsSecurityLocale.twofa_is_enrolled_suffix}
                  </p>
                  {/* twofa.tmpl:7-10's regenerate form. Upstream's
                      enctype="multipart/form-data" is DROPPED — the recipe
                      handler reads urlencoded bodies (the module header). */}
                  <form class="ui form" action="/user/settings/security/two_factor/regenerate_scratch" method="post">
                    <p>{userSettingsSecurityLocale.regenerate_scratch_token_desc}</p>
                    <button type="submit" class="ui primary button">
                      {userSettingsSecurityLocale.twofa_scratch_token_regenerate}
                    </button>
                  </form>
                  {/* twofa.tmpl:11-14's disable form — THE MISSION'S
                      DIVERGENCE: the required passcode field (upstream is a
                      bare confirm dialog; a hijacked session must not strip
                      2FA with one click — the seam verifies without
                      consuming, src/auth/two-factor.ts's header). */}
                  <form class="ui form form-fetch-action" action="/user/settings/security/two_factor/disable" method="post">
                    <p>{userSettingsSecurityLocale.twofa_disable_note}</p>
                    <div class="field">
                      <label for="disable-passcode">{userSettingsSecurityLocale.passcode}</label>
                      <input id="disable-passcode" name="passcode" type="text" autocomplete="one-time-code" inputmode="numeric" required />
                    </div>
                    <button type="submit" class="ui red button" data-modal-confirm="#disable-twofa">
                      {userSettingsSecurityLocale.twofa_disable}
                    </button>
                  </form>
                </>
              ) : (
                <>
                  {/* The recovery tip is upstream's own encouragement line
                      (twofa.tmpl:18's comment). */}
                  <p>{userSettingsSecurityLocale.twofa_recovery_tip}</p>
                  <p>{userSettingsSecurityLocale.twofa_not_enrolled}</p>
                  {/* twofa.tmpl:19-21's Enroll button — LIVE (the enroll
                      page exists, ui/pages/twofa.tsx). */}
                  <div class="inline field">
                    <a class="ui primary button" href="/user/settings/security/two_factor/enroll">
                      {userSettingsSecurityLocale.twofa_enroll_button}
                    </a>
                  </div>
                </>
              )}
            </div>
            {/* twofa.tmpl:23-33's disable confirm dialog — UNCONDITIONAL in
                the template (it sits outside the {{if}}), rendered in both
                arms byte-faithfully; in the not-enrolled arm it has no
                trigger button, exactly upstream's inert markup. The
                account-links dialog's no-JS posture applies verbatim. */}
            <dialog class="modal-dialog" id="disable-twofa">
              <div class="header">
                <Icon name="octicon-trash" /> {userSettingsSecurityLocale.twofa_disable}
              </div>
              <div class="content">
                <p>{userSettingsSecurityLocale.twofa_disable_desc}</p>
              </div>
              <div class="actions">
                <button type="button" class="ui cancel button">
                  {userSettingsSecurityLocale.modal_no}
                </button>
                <button type="submit" class="ui primary ok button">
                  {userSettingsSecurityLocale.modal_yes}
                </button>
              </div>
            </dialog>
            {/* security.tmpl:6's webauthn include — LIVE (the WebAuthn unit;
                migration 0060's store + the webauthn.ts endpoints). */}
            <WebAuthnSection data={data} />
            {/* security.tmpl:9-12's openid include: UNRENDERED (no
                user_openid store/ops — the module header). */}
            {data.accountLinks.length > 0 || data.linkButtons.length > 0 ? (
              <AccountLinksSection data={data} />
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The account-links section (accountlinks.tmpl at the pin — the W5 arm;
 *  the module header holds the dropdown/dialog reductions). The icons are
 *  the login page's exported ProviderIcon at IconHTML's 20
 *  (accountlinks.tmpl:13's dropdown + :32's row-leading `IconHTML 20`):
 *  the img arm (providers.go:63-70), the brand-glyph arm (the
 *  provider-keyed pick — previously reduced away to img-or-globe here, the
 *  icons.ts-allowlist note retired with the export), and the
 *  octicon-globe fallback (a dead stored cfg's honest-degrade arm, the
 *  loader's "" provider). */
function AccountLinksSection(props: { data: UserSettingsSecurityPageData }) {
  const { data } = props;
  return (
    <>
      <h4 class="ui top attached header">
        {userSettingsSecurityLocale.manage_account_links}
        {data.linkButtons.length > 0 ? (
          <div class="ui right">
            {/* accountlinks.tmpl:5-20's dropdown reduced to always-visible
                button anchors (the module header): one per ACTIVE source,
                href the dance start — the SAME url shape the login page's
                navigator renders. */}
            {data.linkButtons.map((button) => (
              <a
                class="ui primary tiny button"
                rel="nofollow"
                href={`/user/oauth2/${encodeURIComponent(button.name)}`}
                title={button.displayName}
              >
                <ProviderIcon
                  source={{ name: button.displayName, provider: button.provider, iconUrl: button.iconUrl }}
                  size={20}
                />{" "}
                {button.displayName}
              </a>
            ))}
          </div>
        ) : null}
      </h4>
      <div class="ui attached segment">
        <div class="flex-divided-list items-with-main">
          <div class="item">{userSettingsSecurityLocale.manage_account_links_desc}</div>
          {data.accountLinks.map((link) => (
            <div class="item">
              <div class="item-leading">
                <ProviderIcon source={{ name: link.displayName, provider: link.provider, iconUrl: link.iconUrl }} size={20} />
              </div>
              <div class="item-main">
                <span class="item-title" data-tooltip-content={link.displayName}>
                  {link.sourceName}
                </span>
                {link.isActive ? (
                  <span class="flex-text-body tw-text-primary">{userSettingsSecurityLocale.active}</span>
                ) : null}
              </div>
              <div class="item-trailing">
                {/* The plain-form POST (the no-JS unlink — the module
                    header): upstream's link-action button classes, the
                    dialog hook preserved for the JS enhancement. */}
                <form action="/user/settings/security/account_link" method="post">
                  <input type="hidden" name="id" value={String(link.loginSourceId)} />
                  <button type="submit" class="ui red tiny button" data-modal-confirm="#delete-account-link">
                    {userSettingsSecurityLocale.remove}
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>

        {/* accountlinks.tmpl:51-60's confirm dialog (the modal_actions_confirm
            default Yes/No arm; octicon-x/check are not in the allowlist —
            text only, the repo-wiki precedent). Inert no-JS exactly like
            upstream's: the working control is the form above. */}
        <dialog class="modal-dialog" id="delete-account-link">
          <div class="header">
            <Icon name="octicon-trash" /> {userSettingsSecurityLocale.remove_account_link}
          </div>
          <div class="content">
            <p>{userSettingsSecurityLocale.remove_account_link_desc}</p>
          </div>
          <div class="actions">
            <button type="button" class="ui cancel button">
              {userSettingsSecurityLocale.modal_no}
            </button>
            <button type="submit" class="ui primary ok button">
              {userSettingsSecurityLocale.modal_yes}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

/** The WebAuthn section (webauthn.tmpl + webauthn_error.tmpl at the pin —
 *  the WebAuthn unit). The registration ceremony is JS-only upstream (the
 *  `#register-webauthn` button is type="button"); the VENDORED bundle's
 *  initUserAuthWebAuthnRegister is its driver — it reads `#nickname`,
 *  `#register-webauthn` and the `#webauthn-error` box below and POSTs the
 *  webauthn.ts endpoints, so the markup here is a WIRE CONTRACT (ids, the
 *  wrapping `div.field`, the data-webauthn-error-msg spans). Rename is
 *  upstream's JS-only modal (show-modal + form-fetch), rendered verbatim;
 *  Delete reduces to the house plain-form POST (the account-links Remove
 *  idiom — upstream's link-action is JS-driven) with the dialog hook
 *  preserved. */
function WebAuthnSection(props: { data: UserSettingsSecurityPageData }) {
  const { data } = props;
  return (
    <>
      <h4 class="ui top attached header">{userSettingsSecurityLocale.webauthn}</h4>
      <div class="ui attached segment">
        {/* webauthn.tmpl:3's desc — the template's link rendered as an
            anchor (the no-raw-HTML rule). */}
        <p>
          {userSettingsSecurityLocale.webauthn_desc_prefix}{" "}
          <a rel="noreferrer" target="_blank" href="https://w3c.github.io/webauthn/#webauthn-authenticator">
            {userSettingsSecurityLocale.webauthn_desc_link}
          </a>
          .
        </p>
        <p>
          {userSettingsSecurityLocale.webauthn_key_loss_warning} {userSettingsSecurityLocale.webauthn_alternative_tip}
        </p>
        {/* webauthn_error.tmpl — the bundle's webAuthnError() fills this
            box (the prompt page's twin markup). */}
        <div id="webauthn-error" class="ui negative message tw-hidden">
          <div class="header">{userSettingsSecurityLocale.webauthn_error}</div>
          <div id="webauthn-error-msg" class="tw-pt-2"></div>
          <div class="tw-hidden">
            <div data-webauthn-error-msg="browser">{userSettingsSecurityLocale.webauthn_unsupported_browser}</div>
            <div data-webauthn-error-msg="unknown">{userSettingsSecurityLocale.webauthn_error_unknown}</div>
            <div data-webauthn-error-msg="insecure">{userSettingsSecurityLocale.webauthn_error_insecure}</div>
            <div data-webauthn-error-msg="unable-to-process">{userSettingsSecurityLocale.webauthn_error_unable_to_process}</div>
            <div data-webauthn-error-msg="duplicated">{userSettingsSecurityLocale.webauthn_error_duplicated}</div>
            <div data-webauthn-error-msg="empty">{userSettingsSecurityLocale.webauthn_error_empty}</div>
            <div data-webauthn-error-msg="timeout">{userSettingsSecurityLocale.webauthn_error_timeout}</div>
          </div>
        </div>
        <div class="flex-divided-list items-with-main">
          {data.webauthnCredentials.map((cred) => (
            <div class="item">
              <div class="item-leading">
                {/* octicon-key is outside the generated allowlist — the
                    settings-keys shield-lock substitute (the house rule). */}
                <Icon name="octicon-shield-lock" size={32} />
              </div>
              <div class="item-main">
                <div class="item-title">{cred.name}</div>
                <div class="item-body">
                  <i>
                    {userSettingsSecurityLocale.added_on} {formatKeyDate(cred.createdUnix)}
                  </i>
                </div>
              </div>
              <div class="item-trailing">
                {/* webauthn.tmpl:21-24's rename trigger — the bundle's
                    show-modal machinery opens the dialog and copies the
                    data-modal-id/name onto the form inputs. */}
                <button
                  type="button"
                  class="ui tiny button show-modal"
                  data-modal="#rename-webauthn-nickname"
                  data-modal-id={String(cred.id)}
                  data-modal-name={cred.name}
                >
                  {userSettingsSecurityLocale.rename}
                </button>
                {/* The plain-form delete POST (the no-JS reduction — the
                    module header); the dialog hook preserved. */}
                <form action="/user/settings/security/webauthn/delete" method="post">
                  <input type="hidden" name="id" value={String(cred.id)} />
                  <button type="submit" class="ui red tiny button" data-modal-confirm="#delete-registration">
                    {userSettingsSecurityLocale.remove}
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div class="ui attached segment">
        <div class="ui form">
          {/* webauthn.tmpl:35-40's register form — the `div.field` wrap and
              both ids are the bundle's selectors (webAuthnRegisterRequest
              reads `#nickname`, its `.closest('div.field')`, and
              `#register-webauthn`). */}
          <div class="required field">
            <label for="nickname">{userSettingsSecurityLocale.webauthn_nickname}</label>
            <input id="nickname" name="nickname" type="text" required />
          </div>
          <button type="button" id="register-webauthn" class="ui primary button">
            <Icon name="octicon-shield-lock" /> {userSettingsSecurityLocale.webauthn_register_key}
          </button>
        </div>
        {/* webauthn.tmpl:43-56's rename dialog — the form-fetch POST the
            bundle intercepts (upstream-exact JSON arms on the endpoint). */}
        <dialog class="modal-dialog" id="rename-webauthn-nickname">
          <div class="header">
            <Icon name="octicon-pencil" />
            {userSettingsSecurityLocale.rename}
          </div>
          <form class="content ui form form-fetch-action" action="/user/settings/security/webauthn/rename" method="post">
            <input type="hidden" name="id" />
            <div class="required field">
              <label>{userSettingsSecurityLocale.webauthn_nickname}</label>
              <input name="name" type="text" maxlength={255} required />
            </div>
            <div class="actions">
              <button type="button" class="ui cancel button">
                {userSettingsSecurityLocale.modal_no}
              </button>
              <button type="submit" class="ui primary ok button">
                {userSettingsSecurityLocale.modal_yes}
              </button>
            </div>
          </form>
        </dialog>
        {/* webauthn.tmpl:58-66's delete confirm dialog — inert no-JS
            (the working control is the per-row form above), the
            account-links dialog posture. */}
        <dialog class="modal-dialog" id="delete-registration">
          <div class="header">
            <Icon name="octicon-trash" /> {userSettingsSecurityLocale.webauthn_delete_key}
          </div>
          <div class="content">
            <p>{userSettingsSecurityLocale.webauthn_delete_key_desc}</p>
          </div>
          <div class="actions">
            <button type="button" class="ui cancel button">
              {userSettingsSecurityLocale.modal_no}
            </button>
            <button type="submit" class="ui primary ok button">
              {userSettingsSecurityLocale.modal_yes}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
