/**
 * The ONE shared settings navbar for the user + org settings families —
 * waves' consolidation of the per-module local nav copies (the appearance
 * module's open issue: the copies' item sets disagree because each was
 * reduced to the tabs landed at its writing time).
 *
 * ## Upstream source of truth (at the pin fc49368)
 *
 * TWO materially different templates (hence two components from one module):
 *
 *   - `templates/user/settings/navbar.tmpl`: header "user.settings", items
 *     Profile (:4-6), Account (:7-11, disabled-features-gated),
 *     Notifications (:12-16, EnableNotifyMail-gated), Appearance (:17-19),
 *     Security (:20-24), Blocked users (:25-27), Applications (:28-30),
 *     SSH/GPG Keys (:31-35), Audit (:36-38), the Actions <details> (:39-60:
 *     General/Runners/Secrets/Variables/Scoped-workflows), Packages
 *     (:61-65), Hooks (:66-70, DisableWebhooks-gated), Organization
 *     (:71-73), Repos (:74-76).
 *   - `templates/org/settings/navbar.tmpl`: header "org.settings", items
 *     Options (:4-6), Hooks (:7-11), Labels (:12-14),
 *     Applications (:15-19, EnableOAuth2-gated), Blocked users (:20-22),
 *     Packages (:23-27), the Actions <details> (:28-48:
 *     General/Runners/Secrets/Variables/Scoped-workflows), Audit (:50-52).
 *
 * ## The dead-link rule (exactly the landed modules' convention)
 *
 * An upstream item with NO landed/committed target page renders NOTHING —
 * never a dead anchor (the appearance/keys/security/... module headers; the
 * no-dead-controls rule). Every item below links a landed or
 * committed-unmounted module; the committed-unmounted ones (appearance,
 * blocked_users, and the user actions/organizations tabs at their writing)
 * are live links for the index.ts window to route.
 *
 * Per-template reductions applied:
 *   - user nav: Blocked users (no user-scope module), Audit, Packages,
 *     Repos, and the Actions General/Runners/Scoped-workflows sub-items are
 *     UNRENDERED (no landed pages). Account and Notifications RENDER —
 *     their pages landed (upstream gates them on disabled-features /
 *     EnableNotifyMail; both settings pin FALSE/TRUE so the items always
 *     render — the modules' SPEC §3 reduction).
 *   - org nav: Packages and the Actions General/Scoped-workflows sub-items
 *     are UNRENDERED (Applications joined the landed set with the R20-a tab,
 *     Audit with the census R13 org arm, and Runners with the census C7 org
 *     twin's mount — pages/org-settings-actions-runners.tsx; the user
 *     runners page has no landed module, so the user nav's Runners item
 *     stays dead).
 *   - The Labels item keeps the landed href `{orgLink}/labels` — upstream's
 *     `{.OrgLink}}/settings/labels` target is the DOCUMENTED wave-14 URL
 *     divergence (pages/org-settings.tsx header: "the target exists so the
 *     tab stays live"); all three landed org nav copies use `/labels`.
 *
 * Item texts are the upstream English locale strings (options/locale/
 * locale_en-US.json at the pin), matching every local copy's vocabulary.
 *
 * ## Auth posture (why there is no viewer parameter)
 *
 * The nav is a pure function of its `active` prop — the family convention
 * (every local copy takes only active/orgLink). The settings families are
 * signed-in-gated at the ROUTE prologue (resolveUiSession /
 * resolveOrgTeamsRequest: anonymous 303s onto the login round-trip, a
 * session doer without a D1 row 404-shells; org settings additionally
 * owner-only 404-shells), so no settings page ever renders for an anonymous
 * viewer and the nav never branches on viewer state.
 *
 * ## Mount record — the swap list (DONE at 94c6851, the 13-site
 * shared-navbar swap; the wiring HANDOFF is retired)
 *
 * The swap is complete: every module below replaced its local nav copy with
 * the shared components (the list kept as the provenance record;
 * file:line = the local component's now-deleted definition):
 *
 *   USER family (swap for `UserSettingsNavbar`, `active` = the page's tab):
 *     1. pages/user-settings.tsx:187 — private `UserSettingsNav`
 *        (Profile only) — profile page.
 *     2. pages/user-settings-appearance.tsx:333 — exported
 *        `UserSettingsAppearanceNav` (6 items) — appearance page.
 *     3. pages/user-settings-security.tsx:135 — exported
 *        `UserSettingsSecurityNav` — security page.
 *     4. pages/user-settings-secrets.tsx:325 — exported
 *        `UserSettingsSecretsNav` — actions/secrets page.
 *     5. pages/user-settings-variables.tsx:403 — exported
 *        `UserSettingsVariablesNav` — actions/variables page.
 *     6. pages/user-settings-keys.tsx:551 — private `UserSettingsKeysNav` —
 *        keys page.
 *     7. pages/user-settings-applications.tsx:355 — private
 *        `UserSettingsApplicationsNav` — applications page.
 *     8. pages/user-settings-webhooks.tsx:285 — private
 *        `UserSettingsWebhooksNav` — the user hooks pages (reuses this
 *        module's USER hooks href, its `USER_SETTINGS_HOOKS_LINK` twin).
 *     9. pages/user-settings-organizations.tsx:218 — exported
 *        `UserOrgsSettingsNav` (mount scaffolding) — organizations page.
 *   ORG family (swap for `OrgSettingsNavbar`, `orgLink` = `/{org}`):
 *     10. pages/org-settings.tsx:569 — exported `SettingsNavbar`
 *         (options/hooks/labels; imported by the hooks page) — options page.
 *     11. pages/org-settings-hooks.tsx:210,434 — call sites only (renders
 *         org-settings.tsx's SettingsNavbar with `hooks`).
 *     12. pages/org-settings-blocked.tsx:333 — exported
 *         `OrgSettingsBlockedNav` (mount scaffolding) — blocked_users page.
 *     13. pages/org-settings-actions.tsx:523 — exported
 *         `OrgSettingsActionsNav` (mount scaffolding) — the org
 *         actions/secrets + actions/variables pages.
 *
 *   Out of scope by template: pages/settings.tsx:330's `SettingsNav` is the
 *   REPO settings nav (templates/repo/settings/navbar.tmpl — a third
 *   upstream template this brief does not cover).
 *
 *   Per the family convention, each swap DELETED the local copy and the
 *   tests' local-nav expectations moved onto the shared component (the
 *   WikiSettingsNav deletion precedent, pages/repo-settings-wiki.tsx).
 */

// ---------------------------------------------------------------------------
// The locale (the component-local pattern — every string cites its upstream
// key; values are the pin's locale_en-US.json English texts)
// ---------------------------------------------------------------------------

export const settingsNavLocale = {
  // The user group (templates/user/settings/navbar.tmpl).
  user_settings: "User Settings", // "user.settings" (the header, :3)
  profile: "Profile", // "settings.profile" (:5)
  account: "Account", // "settings.account" (:9)
  notifications: "Notifications", // "notifications" (:14)
  appearance: "Appearance", // "settings.appearance" (:18)
  security: "Security", // "settings.security" (:22)
  applications: "Applications", // "settings.applications" (:29)
  ssh_gpg_keys: "SSH / GPG Keys", // "settings.ssh_gpg_keys" (:33)
  actions: "Actions", // "actions.actions" (the <details> summary, :41)
  runners: "Runners", // "actions.runners" (the org navbar.tmpl:35-37 sub-item — lit by the C7 org twin's mount; the USER nav's twin stays dead)
  secrets: "Secrets", // "secrets.secrets" (:50)
  variables: "Variables", // "actions.variables" (:53)
  hooks: "Webhooks", // "repo.settings.hooks" (:68)
  organization: "Organizations", // "settings.organization" (:72)
  repos: "Repositories", // "settings.repos" (repos.tmpl:649)
  // The org group (templates/org/settings/navbar.tmpl).
  org_settings: "Settings", // "org.settings" (the header, :3)
  org_options: "Organization", // "org.settings.options" (:5)
  labels: "Labels", // "repo.labels" (:13)
  blocked_users: "Blocked users", // "user.block.list" (:21)
  audit: "Audit Log", // "audit.title" (:51 — the census R13 org arm's item)
} as const;

/** The user settings tabs this nav can mark active — one per landed or
 *  committed-unmounted module (the dead-link rule keeps every other
 *  upstream PageIs* arm out). */
export type UserSettingsNavTab =
  | "profile" // pages/user-settings.tsx
  | "account" // pages/user-settings-account.tsx
  | "notifications" // pages/user-settings-notifications.tsx
  | "appearance" // pages/user-settings-appearance.tsx
  | "security" // pages/user-settings-security.tsx
  | "applications" // pages/user-settings-applications.tsx
  | "keys" // pages/user-settings-keys.tsx
  | "secrets" // pages/user-settings-secrets.tsx
  | "variables" // pages/user-settings-variables.tsx
  | "hooks" // pages/user-settings-webhooks.tsx
  | "organization" // pages/user-settings-organizations.tsx
  | "repos"; // pages/user-settings-repos.tsx

/** The org settings tabs — options/hooks/applications/audit (landed),
 *  blocked (committed-unmounted), secrets/variables/runners (landed via
 *  org-settings-actions / org-settings-actions-runners), plus `labels` for
 *  upstream's PageIsOrgSettingsLabels arm (navbar.tmpl:12 — today the item
 *  links the landed `/{org}/labels` page, which renders no settings nav, so
 *  no caller passes it yet). */
export type OrgSettingsNavTab = "options" | "hooks" | "labels" | "applications" | "blocked" | "runners" | "secrets" | "variables" | "audit";

// ---------------------------------------------------------------------------
// The user settings navbar (user/settings/navbar.tmpl reduced)
// ---------------------------------------------------------------------------

/**
 * The shared USER settings navbar. `active` marks the rendered page's tab;
 * the Actions <details> opens while a secrets/variables page renders
 * (navbar.tmpl:40's or-arm) and stays closed otherwise. Item order is
 * navbar.tmpl's exact order with the dead items dropped: Profile, Account,
 * Notifications, Appearance, Security, Applications, Keys,
 * Actions▸(Secrets, Variables), Hooks, Organizations.
 */
export function UserSettingsNavbar(props: { active: UserSettingsNavTab }) {
  const item = (tab: UserSettingsNavTab) => (props.active === tab ? "active item" : "item");
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{settingsNavLocale.user_settings}</div>
        {/* navbar.tmpl:4-6 */}
        <a class={item("profile")} href="/user/settings">
          {settingsNavLocale.profile}
        </a>
        {/* navbar.tmpl:7-11 */}
        <a class={item("account")} href="/user/settings/account">
          {settingsNavLocale.account}
        </a>
        {/* navbar.tmpl:12-16 */}
        <a class={item("notifications")} href="/user/settings/notifications">
          {settingsNavLocale.notifications}
        </a>
        {/* navbar.tmpl:17-19 (Blocked users :25-27 dead) */}
        <a class={item("appearance")} href="/user/settings/appearance">
          {settingsNavLocale.appearance}
        </a>
        {/* navbar.tmpl:20-24 (Blocked users :25-27 dead) */}
        <a class={item("security")} href="/user/settings/security">
          {settingsNavLocale.security}
        </a>
        {/* navbar.tmpl:28-30 */}
        <a class={item("applications")} href="/user/settings/applications">
          {settingsNavLocale.applications}
        </a>
        {/* navbar.tmpl:31-35 (Audit :36-38 dead) */}
        <a class={item("keys")} href="/user/settings/keys">
          {settingsNavLocale.ssh_gpg_keys}
        </a>
        {/* navbar.tmpl:39-60 — General/Runners (:43-48) and
            Scoped-workflows (:55-57) dead; Secrets (:49-51) + Variables
            (:52-54) landed. Open while either is the active page. */}
        <details class="item" open={props.active === "secrets" || props.active === "variables" ? true : undefined}>
          <summary>{settingsNavLocale.actions}</summary>
          <div class="menu">
            <a class={item("secrets")} href="/user/settings/actions/secrets">
              {settingsNavLocale.secrets}
            </a>
            <a class={item("variables")} href="/user/settings/actions/variables">
              {settingsNavLocale.variables}
            </a>
          </div>
        </details>
        {/* navbar.tmpl:66-70 (Packages :61-65 dead) — the user hooks tab
            reuses the repo key's text; href = the webhooks module's
            USER_SETTINGS_HOOKS_LINK. */}
        <a class={item("hooks")} href="/user/settings/hooks">
          {settingsNavLocale.hooks}
        </a>
        {/* navbar.tmpl:71-73 */}
        <a class={item("organization")} href="/user/settings/organization">
          {settingsNavLocale.organization}
        </a>
        {/* navbar.tmpl:74-76 — the doer's own repo list (GET only; the
            unadopted POST is structurally absent, the module header). */}
        <a class={item("repos")} href="/user/settings/repos">
          {settingsNavLocale.repos}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The org settings navbar (org/settings/navbar.tmpl reduced)
// ---------------------------------------------------------------------------

/**
 * The shared ORG settings navbar. `orgLink` is `/{org}` (the family's
 * OrgLink); `active` marks the rendered page's tab. Item order is
 * navbar.tmpl's exact order with the dead items dropped: Options, Hooks,
 * Labels, Applications, Blocked users, Actions▸(Runners, Secrets,
 * Variables), Audit.
 */
export function OrgSettingsNavbar(props: { orgLink: string; active: OrgSettingsNavTab }) {
  const item = (tab: OrgSettingsNavTab) => (props.active === tab ? "active item" : "item");
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{settingsNavLocale.org_settings}</div>
        {/* navbar.tmpl:4-6 */}
        <a class={item("options")} href={`${props.orgLink}/settings`}>
          {settingsNavLocale.org_options}
        </a>
        {/* navbar.tmpl:7-11 */}
        <a class={item("hooks")} href={`${props.orgLink}/settings/hooks`}>
          {settingsNavLocale.hooks}
        </a>
        {/* navbar.tmpl:12-14 — the wave-14 URL divergence: the landed target
            is `/{org}/labels`, upstream's href is `{.OrgLink}}/settings/
            labels` (pages/org-settings.tsx's documented reduction). */}
        <a class={item("labels")} href={`${props.orgLink}/labels`}>
          {settingsNavLocale.labels}
        </a>
        {/* navbar.tmpl:15-19 — lit by the org settings applications tab's
            mount (the a43d9b1 dead-link omission retired: the target page
            is landed); upstream gates the item on .EnableOAuth2, cf-gitea's
            OAuth2 store is unconditional (the page module header). */}
        <a class={item("applications")} href={`${props.orgLink}/settings/applications`}>
          {settingsNavLocale.applications}
        </a>
        {/* navbar.tmpl:20-22 (Packages :23-27 dead) — the blocked_users
            module is committed-unmounted. */}
        <a class={item("blocked")} href={`${props.orgLink}/settings/blocked_users`}>
          {settingsNavLocale.blocked_users}
        </a>
        {/* navbar.tmpl:28-48 — General (:32-34) and Scoped-workflows
            (:44-46) dead; Runners (:35-37) lit by the census C7 org twin's
            mount (pages/org-settings-actions-runners.tsx), Secrets (:38-40) +
            Variables (:41-43) landed. Open while any of the three is the
            active page (navbar.tmpl:29's or-arm). */}
        <details
          class="item"
          open={props.active === "runners" || props.active === "secrets" || props.active === "variables" ? true : undefined}
        >
          <summary>{settingsNavLocale.actions}</summary>
          <div class="menu">
            <a class={item("runners")} href={`${props.orgLink}/settings/actions/runners`}>
              {settingsNavLocale.runners}
            </a>
            <a class={item("secrets")} href={`${props.orgLink}/settings/actions/secrets`}>
              {settingsNavLocale.secrets}
            </a>
            <a class={item("variables")} href={`${props.orgLink}/settings/actions/variables`}>
              {settingsNavLocale.variables}
            </a>
          </div>
        </details>
        {/* navbar.tmpl:50-52 — Audit, LAST in upstream's menu. Lit by the
            org settings audit tab's mount (the census R13 org arm — the
            dead-link omission retired); the user family's Audit item
            (:36-38) stays dead, its arm is not in the R13 scope. */}
        <a class={item("audit")} href={`${props.orgLink}/settings/audit_logs`}>
          {settingsNavLocale.audit}
        </a>
      </div>
    </div>
  );
}
