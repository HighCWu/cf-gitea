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
 * (plus the W5 unlink POST above, HANDOFF):
 *
 *   GET /user/settings/security → resolveUiSession (signed-in gate, the
 *            user-settings.tsx pattern) → loadUserSettingsSecurityPageData →
 *            renderUserSettingsSecurityPage; a session doer without a D1 row
 *            404-shells (the silent-auth-failure convention).
 *
 * Every other POST arm of the upstream group stays UNMOUNTED — each write
 * targets a store or op that does not exist (the per-section notes below):
 * `two_factor/regenerate_scratch` + `two_factor/disable`
 * (security/2fa.go:34-98), `two_factor/enroll` GET+POST (web.go:667-668,
 * twofa_enroll.tmpl), the webauthn `request_register`/`register`/`rename`/
 * `delete` quartet (web.go:669-673, security/webauthn.go), and the openid
 * POST/`delete`/`toggle_visibility` trio (web.go:674-676,
 * security/openid.go).
 *
 * ## Data (§3.2 — what the landed auth exposes)
 *
 *   - 2FA (TOTP): no `two_factor` table — SPEC-0002 §1 puts 2FA/WebAuthn
 *     explicitly out of scope, and the schema carries no such store.
 *     `TOTPEnrolled` is therefore the DERIVED posture — no store = not
 *     enrolled (upstream's `auth_model.HasTwoFactorByUID`, security.go:73-78,
 *     answers false for every doer) — so the template's `{{else}}` arm's TEXT
 *     renders (twofa.tmpl:16-22): `settings.twofa_desc`, the recovery tip
 *     `settings.twofa_recovery_tip`, and `settings.twofa_not_enrolled`. The
 *     arm's Enroll BUTTON (twofa.tmpl:20-22) is UNRENDERED — a dead link: no
 *     enroll page exists (the dead-link rule). The ENROLLED arm never
 *     renders for the same absence.
 *   - WebAuthn: no store/ops → the section UNRENDERED.
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
import { oauth2LoginSourceButtons } from "./login";
import { getProviderDescriptor } from "../../services/auth-sources/registry";
import { parseOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import { findExternalLogins, getLoginSource, listActiveOAuth2Sources, removeExternalLogin } from "../../services/auth-sources/store";
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

/** The security tab's render inputs: the derived 2FA posture (`false` is
 *  the only producible value today — no `two_factor` store) + the W5
 *  account-links projections (both empty on every instance without linked
 *  identities/active sources — the section renders nothing, upstream's own
 *  guard, and the page bytes stay the wave-56 shape). */
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
 * answered from the store landscape (no two_factor table ⇒ false) plus the
 * W5 account-links projections (the module header).
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

  return { totpEnrolled: false, accountLinks: joined, linkButtons };
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
            {/* security.tmpl:6's webauthn include: UNRENDERED (no store/ops,
                the module header). security.tmpl:9-12's openid include:
                UNRENDERED. */}
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
 *  the module header holds the dropdown/dialog reductions). The row icon is
 *  the img-or-globe arm (providers.go:63-70's img markup; the brand-glyph
 *  arm stays the login page's — the icons.ts allowlist carries no provider
 *  brand set here, the recorded reduction). */
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
                {button.iconUrl !== null ? (
                  <img class="tw-object-contain" width="20" height="20" src={button.iconUrl} alt={button.displayName} />
                ) : (
                  <Icon name="octicon-globe" size={20} />
                )}{" "}
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
                {link.iconUrl !== null ? (
                  <img class="tw-object-contain" width="20" height="20" src={link.iconUrl} alt={link.displayName} />
                ) : (
                  <Icon name="octicon-globe" size={20} />
                )}
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
