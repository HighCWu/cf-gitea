/**
 * The user settings SECURITY tab, `/user/settings/security` — pages wave 56
 * (bench row `wave-settings-security-module`, TWO-STAGE UNMOUNTED — the route
 * rides the index.ts window; `index.ts` is orchestrator/sibling-owned).
 *
 * Upstream pin: `templates/user/settings/security/security.tmpl` over its four
 * section templates (`security/twofa.tmpl`, `security/webauthn.tmpl`,
 * `security/accountlinks.tmpl`, `security/openid.tmpl`) and the
 * `security.Security` handler
 * (gitea/routers/web/user/setting/security/security.go:29-47).
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * Upstream's route group is web.go:662-677 (the `/user/settings/security`
 * subtree inside the reqSignIn `/user/settings` group). Only the GET mounts:
 *
 *   GET /user/settings/security → resolveUiSession (signed-in gate, the
 *            user-settings.tsx pattern) → loadUserSettingsSecurityPageData →
 *            renderUserSettingsSecurityPage; a session doer without a D1 row
 *            404-shells (the silent-auth-failure convention).
 *
 * Every POST arm of the upstream group stays UNMOUNTED — each write targets a
 * store or op that does not exist (the per-section notes below):
 * `two_factor/regenerate_scratch` + `two_factor/disable`
 * (security/2fa.go:34-98), `two_factor/enroll` GET+POST (web.go:667-668,
 * twofa_enroll.tmpl), the webauthn `request_register`/`register`/`rename`/
 * `delete` quartet (web.go:669-673, security/webauthn.go), the openid
 * POST/`delete`/`toggle_visibility` trio (web.go:674-676,
 * security/openid.go), and the `account_link` delete (web.go:677,
 * security.go:50-70).
 *
 * ## Data (§3.2 — what the landed auth exposes: none of the four stores)
 *
 *   - 2FA (TOTP): no `two_factor` table — SPEC-0002 §1 puts 2FA/WebAuthn
 *     explicitly out of scope, and the schema carries no such store.
 *     `TOTPEnrolled` is therefore the DERIVED posture — no store = not
 *     enrolled (upstream's `auth_model.HasTwoFactorByUID`, security.go:73-78,
 *     answers false for every doer) — so the template's `{{else}}` arm's TEXT
 *     renders (twofa.tmpl:16-22): `settings.twofa_desc`, the recovery tip
 *     `settings.twofa_recovery_tip`, and `settings.twofa_not_enrolled` (the
 *     "two-factor posture list" this brief pins). The arm's Enroll BUTTON
 *     (twofa.tmpl:20-22 → `/user/settings/security/two_factor/enroll`) is
 *     UNRENDERED — a dead link: no enroll page exists (the dead-link rule).
 *     The ENROLLED arm (twofa.tmpl:6-15, the regenerate-scratch + disable
 *     forms + the `#disable-twofa` confirm dialog) never renders for the same
 *     absence; when a two_factor store and its ops land, the arm renders per
 *     the template.
 *   - WebAuthn: no `webauthn_credentials` store and no register/rename/delete
 *     ops → the whole section UNRENDERED (webauthn.tmpl's list + nickname
 *     form + the two dialogs would all be dead markup).
 *   - Account links: upstream's own guard renders NOTHING — accountlinks
 *     .tmpl:2 `{{if or .AccountLinks .OrderedOAuth2Names}}` — and both
 *     operands are empty at ANY posture here: no `external_login_user` store
 *     and no OAuth2 login sources exist. The section is naturally absent
 *     (upstream-faithful empty arm, not a reduction).
 *   - OpenID: no `user_openid` store and no add/toggle/delete ops → the
 *     section UNRENDERED (openid.tmpl's add form would be a dead control).
 *
 * The password change: upstream's handler comment reads "Security render
 * change user's password page and 2FA" (security.go:28-29) but the pinned
 * template carries NO password form — the change-password form lives on the
 * Account tab (account.tmpl, a different navbar item, unclaimed this wave).
 * cf-gitea has no password model at all: the login credential IS a PAT
 * (SPEC-0010 §1.3) and `users` carries no password column, so no password
 * form renders anywhere.
 *
 * The `security.tmpl:2-15` wrapper gates the content on upstream's
 * `UserDisabledFeatures` MFA/credentials flags; cf-gitea models no
 * per-user disabled-feature list and upstream's default is enabled, so the
 * wrapper (`.user-setting-content`) renders.
 *
 * ## DOM contract (user/settings/{layout_head,navbar}.tmpl +
 *  security/security.tmpl + security/twofa.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings security`; the
 * settings navbar (flex-container-nav) reduces to the LANDED items — Profile
 * (/user/settings), Security (this tab, active), and the Actions disclosure
 * with Secrets (/user/settings/actions/secrets, the sibling secrets module) —
 * the dead-link rule (every other upstream navbar item is an unwired page).
 * The content is `.user-setting-content` carrying the twofa section:
 * `h4.ui.top.attached.header` (settings.twofa) over the `.ui.attached
 * segment` with the three posture paragraphs.
 */

import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsSecurityLocale = {
  settings: "User Settings", // "user.settings" (the navbar header)
  profile: "Profile", // "settings.profile"
  security: "Security", // "settings.security" (the title + navbar item)
  actions: "Actions", // "actions.actions" (the navbar disclosure)
  secrets: "Secrets", // "secrets.secrets" (the disclosure's live sub-item)
  twofa: "Two-Factor Authentication (TOTP)", // "settings.twofa"
  twofa_desc:
    'To protect your account against password theft, you can use a smartphone or another device for receiving time-based one-time passwords ("TOTP").', // "settings.twofa_desc"
  twofa_recovery_tip: "If you lose your device, you will be able to use a single-use recovery key to regain access to your account.", // "settings.twofa_recovery_tip"
  twofa_not_enrolled: "Your account is not currently enrolled in two-factor authentication.", // "settings.twofa_not_enrolled"
} as const;

// ---------------------------------------------------------------------------
// The page data (upstream loadSecurityData's TOTPEnrolled, derived — see the
// header's Data section)
// ---------------------------------------------------------------------------

/** The security tab's render inputs: the derived 2FA posture. `false` is the
 *  only producible value today (no `two_factor` store); the field stays a
 *  boolean so the landed store flips it without a render change. */
export interface UserSettingsSecurityPageData {
  totpEnrolled: boolean;
}

/**
 * The page load — upstream's `HasTwoFactorByUID` arm (security.go:73-78)
 * answered from the store landscape: cf-gitea carries no two_factor table
 * (SPEC-0002 §1), so every doer is not-enrolled. The async signature is the
 * wiring wave's loader convention (the store read plugs in without a call-site
 * change); the d1/userId parameters idle until then.
 */
export function loadUserSettingsSecurityPageData(_d1: D1Database, _userId: number): Promise<UserSettingsSecurityPageData> {
  return Promise.resolve({ totpEnrolled: false });
}

// ---------------------------------------------------------------------------
// The settings navbar (user/settings/navbar.tmpl reduced to the landed items
// — the module header). Exported for the tests; the sibling settings modules
// carry their own copies (the private-Nav convention).
// ---------------------------------------------------------------------------

export function UserSettingsSecurityNav(props: { active: "profile" | "security" | "secrets" }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{userSettingsSecurityLocale.settings}</div>
        <a class={props.active === "profile" ? "active item" : "item"} href="/user/settings">
          {userSettingsSecurityLocale.profile}
        </a>
        <a class={props.active === "security" ? "active item" : "item"} href="/user/settings/security">
          {userSettingsSecurityLocale.security}
        </a>
        {/* navbar.tmpl:39-60's Actions <details class="item"> — open while one
            of its sub-items is the active page (navbar.tmpl:40's open arm);
            Secrets is the only landed sub-item (the dead-link rule). */}
        <details class="item" open={props.active === "secrets" ? true : undefined}>
          <summary>{userSettingsSecurityLocale.actions}</summary>
          <div class="menu">
            <a class={props.active === "secrets" ? "active item" : "item"} href="/user/settings/actions/secrets">
              {userSettingsSecurityLocale.secrets}
            </a>
          </div>
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/security/security.tmpl +
//  security/twofa.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderUserSettingsSecurityPage(ctx: UiContext, data: UserSettingsSecurityPageData): string {
  return renderPage(<UserSettingsSecurityPage ctx={ctx} data={data} />);
}

/** The security page (§2.4.1 discriminator: `user settings security` —
 *  layout_head's pageClass). */
export function UserSettingsSecurityPage(props: { ctx: UiContext; data: UserSettingsSecurityPageData }) {
  const { data } = props;
  return (
    <BaseLayout ctx={props.ctx} title={userSettingsSecurityLocale.security} pageClass="user settings security">
      <div class="ui container flex-container">
        <UserSettingsSecurityNav active="security" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* security.tmpl:5-7's twofa include, not-enrolled arm
                (twofa.tmpl:16-22 — the enrolled arm's regenerate/disable
                forms and the Enroll button stay unrendered: no two_factor
                store or ops, the module header). */}
            <h4 class="ui top attached header">{userSettingsSecurityLocale.twofa}</h4>
            <div class="ui attached segment">
              <p>{userSettingsSecurityLocale.twofa_desc}</p>
              {data.totpEnrolled ? null : (
                <>
                  {/* The recovery tip is upstream's own encouragement line
                      (twofa.tmpl:18's comment). */}
                  <p>{userSettingsSecurityLocale.twofa_recovery_tip}</p>
                  <p>{userSettingsSecurityLocale.twofa_not_enrolled}</p>
                </>
              )}
            </div>
            {/* security.tmpl:6/9-12's remaining sections (webauthn,
                accountlinks, openid) render nothing — no stores, no ops; the
                accountlinks arm is empty upstream too (its own guard), the
                header's Data section. */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
