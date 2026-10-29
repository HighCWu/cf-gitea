/**
 * The ADMIN USERS list page — `/-/admin/users` — the wave-admin-pages bench
 * row (the parity survey row docs/compat/ui-parity-survey.md:549's users
 * remainder), MOUNTED at 2f7afe9 (the mount window): the route lives in
 * `index.ts`'s admin literal family block — the retired wiring HANDOFF is
 * the mount record at the bottom of this header. Sibling scope: `admin-orgs.tsx`
 * + `admin-repos.tsx` (this same wave) own the orgs/repos lists; the landed
 * dashboard/monitor family (window-2c, `e31c0cf`) owns `/-/admin` and
 * `/-/admin/monitor/*` — none of those files is touched here.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/user/list.tmpl` (147 lines) served by `admin.Users`
 * (routers/web/admin/users.go:59-125) through the shared
 * `explore.RenderUserSearch` (routers/web/explore/user.go:35-122 — the same
 * helper the explore users page rides), route `GET /-/admin/users`
 * (web.go:806-819's `/users` group `m.Get("")`), behind
 * `verifyAuthWithOptionsWeb(&VerifyOptions{SignInRequired: true,
 * AdminRequired: true})` (web.go:779) — anonymous → the login redirect, a
 * signed-in non-admin → the 404 shell. That gate is the ROUTE stage's posture
 * (the module trusts its inputs like every landed load function).
 *
 * The handler's data pull (users.go:59-125): Title + PageIsAdminUsers, the
 * five `status_filter[key]` query arms read verbatim (is_active / is_admin /
 * is_restricted / is_2fa_enabled / is_prohibit_login, users.go:63-69), `sort`
 * defaulting to `UserSearchDefaultAdminSort` = "alphabetically"
 * (users.go:49,71), the `user_type` filter (users.go:74-79 — unfiltered lists
 * UserTypeIndividual + UserReserved + Bot + RemoteUser, i.e. NEVER
 * organizations), the auth-source filter inputs (users.go:87-108 — rendered
 * only `{{if .HasAuthSources}}`, list.tmpl:51), then RenderUserSearch with
 * `SearchByEmail: true` and page size `setting.UI.Admin.UserPagingNum` = 50
 * (modules/setting/ui.go:138). RenderUserSearch maps the web sort vocabulary
 * onto SQL (user.go:61-83) and builds the pager (user.go:118).
 *
 * ## Row projection (list.tmpl:104-139 at the pin → the landed D1 columns)
 *
 *   ID                             users.id (sortable: oldest/newest)
 *   Username                       users.username → /{username} (HomeLink);
 *                                  + the "Admin" basic label when isAdmin
 *                                  (list.tmpl:110-111); the Reserved (type 2)
 *                                  / Remote (type 5) / Bot
 *                                  (shared/user/user_type_label) arms are
 *                                  unreachable — `users.type` is only
 *                                  'user'|'org' and this list is type='user'
 *                                  (the individual family; orgs live on the
 *                                  sibling page) — no row can carry them
 *                                  (sortable: alphabetically/reverse-
 *                                  alphabetically, data-sortt-default)
 *   Email Address                  users.email ?? "" (list.tmpl:119)
 *   Auth Source                    the constant "Local" (list.tmpl:120's
 *                                  `.LoginSource` zero arm — no external-auth
 *                                  store exists; every account is local, the
 *                                  admin-t2 deviation 4 posture)
 *   Activated                      octicon-check when status='active' else
 *                                  octicon-x (list.tmpl:121 — the landed
 *                                  status enum folds upstream's is_active)
 *   Restricted                     octicon-x ALWAYS (no is_restricted column —
 *                                  the constant-false store, admin-t2
 *                                  deviation 4; the check arm is not
 *                                  producible but the column is the honest
 *                                  state, like the API's restricted:false)
 *   2FA                            octicon-x ALWAYS (no two-factor/webauthn
 *                                  store — UsersTwoFaStatus has no source)
 *   Created                        createdAt → DateUtils.AbsoluteShort
 *                                  ("Jan 2, 2006", the formatDueDate twin)
 *   Last Sign-In                   "Never Signed In" ALWAYS (no last_login
 *                                  column; the API's last_login renders
 *                                  GO_ZERO_TIME — services/user.ts:45 — so
 *                                  the never-login arm list.tmpl:127-129 is
 *                                  the only producible posture). The header's
 *                                  lastlogin/reverselastlogin sorter
 *                                  (list.tmpl:97) has no backing → rendered
 *                                  as a PLAIN header (no link, no arrow).
 *   (actions)                      list.tmpl:130-135's details/edit links
 *                                  target /-/admin/users/{id}[/edit] —
 *                                  UNLANDED pages → OMITTED (the dead-link
 *                                  rule §2.4.1; the column collapses to the
 *                                  9 live columns, the empty-state colspan
 *                                  follows)
 *
 * The header's "Create User Account" button (list.tmpl:6 → /-/admin/users/new)
 * is an UNLANDED page → omitted. The search/filter form and the sorters are
 * LIVE (below); the pager is the landed Older/Newer reduction (base/paginate's
 * full numbered bar is JS-free upstream but the repo's established reduction —
 * explore/activity/issues all ship the pair).
 *
 * ## Live search/filter arms (query passthrough, list.tmpl:10-80)
 *
 * One no-JS GET form wraps the combo + the filter dropdowns exactly like the
 * upstream form does; upstream's Fomantic dropdowns reduce to `<details>`
 * disclosures (the settings-secrets reduction) and the sort menu keeps its
 * upstream submit-button shape (`button name="sort"`, list.tmpl:71-76 — no-JS
 * live):
 *   - `q` — substring over username OR full name OR email (the admin actor's
 *     SearchByEmail arm; the parameterized instr() triple is the API twin's
 *     exact predicate — routes/admin-t2.ts:268-281, adminSearchUsers).
 *   - `status_filter[is_active]`/`[is_prohibit_login]` — the landed
 *     `users.status` enum folds the two columns (admin-t2 deviation 6):
 *     is_active=1 ⇔ is_prohibit_login=0 ⇔ status='active'.
 *   - `status_filter[is_admin]` — users.isAdmin, both directions live.
 *   - `status_filter[is_restricted]`/`[is_2fa_enabled]` — value 1 matches
 *     nothing (constant-false store, `0 = 1`), value 0/absent filters nothing
 *     (the API twin's exact posture, admin-t2.ts:315-323). The radios render:
 *     choosing "2FA Enabled" honestly answers an empty list.
 *   - `user_type` — "" (all) / "User" (≡ the default individual family) /
 *     "Bot" (matches nothing — no bot rows exist; live empty answer).
 *   - `sort` — the six upstream dropdown values (oldest/newest/
 *     alphabetically/reversealphabetically/recentupdate/leastupdate). The
 *     table headers carry the same vocabulary as toggle links (the JS
 *     tablesort.ts reduction — a plain `?sort=` anchor, no-JS live), with
 *     octicon-triangle-up/down arrows mirroring upstream's SortArrow
 *     (modules/templates/util_misc.go:29-53) — both triangles are outside the
 *     generated icon allowlist and embed the submodule's exact asset bytes
 *     (the pull-merge-box FOLD_SVG precedent), as do octicon-x (octicon-check
 *     IS allowlisted) and octicon-lock (exported for the sibling pages).
 *   - `source_id` — NOT rendered (HasAuthSources is false — no auth-source
 *     store); a stray param is ignored, like the API's absent column.
 *   - The Reset item (list.tmpl:21, upstream JS `js-reset-status-filter`)
 *     reduces to a plain link back to the bare page (a radio cannot uncheck
 *     itself without JS).
 *
 * Sort deviations (documented): recentupdate/leastupdate sort `updated_unix`
 * upstream; `users` has no updated column → created_at (the API twin's
 * deviation 5, admin-t2.ts:104,213-214). lastlogin/reverselastlogin have NO
 * stand-in at all → not offered (the header degrades, above).
 *
 * ## Data (§3.2 — D1 through Drizzle; the service-layer gap recorded)
 *
 * No landed service carries the admin-shaped user arm: services/user.ts
 * `searchUsers` has no type gate (org rows would surface) and no status
 * filters; services/search.ts `searchExploreUsers` pins status='active',
 * which the admin page must NOT (upstream lists inactive accounts and the
 * filters need both directions); the API twin `searchAdminUsers`
 * (routes/admin-t2.ts:261-342) keeps its predicate unexported inside the
 * route module (the wave-9 "Choice recorded" precedent, services/search.ts:14).
 * So this module issues the admin predicate directly through Drizzle — the
 * module-local query pattern of admin-monitor.tsx and
 * user-settings-secrets.tsx (parameterized `sql` fragments inside the query
 * builder, never string SQL; the §Architecture D1 rule binds route handlers,
 * and this module IS the data seam until a service arm is extracted).
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the route is live)
 *
 * Route table (`index.ts`), beside the landed adminPagePrologue pair
 * (session resolveUiSession → anonymous login-303 → non-admin 404 shell,
 * web.go:779's exact posture):
 *
 *   GET /-/admin/users   adminPagePrologue(c) → loadAdminUsersData(c.env.DB,
 *                        c.req.raw's URL searchParams) →
 *                        renderAdminUsersPage(p.ctx, data) at 200
 *
 * The claim sits in the landed admin literal family block
 * (`raw[1] === "-" && raw[2] === "admin"`): `tail.length === 1 &&
 * tail[0] === "users"` returns `{ family: "admin-users" }` BEFORE any
 * dynamic `/users/{id}` arm can exist (the
 * static-before-dynamic rule; the detail routes stay unclaimed → 404).
 * Registration order within the file is inert (the parser claims by shape),
 * but the FAMILY block itself must stay ahead of the owner/repo parse (it
 * already is). The sibling pages mount in the same block:
 * `tail[0] === "orgs"` → admin-orgs, `tail[0] === "repos"` → admin-repos.
 * Upstream's static `/users` literal already shadows the `/{username}` parse
 * the same way (web.go:806's group registers before web.go:1102's owner
 * routes; a user named "users" is create-time reserved besides).
 *
 * The family navbar below (AdminFamilyNav) is the WHOLE admin family's ONE
 * shared navbar (the mount window's F7 fold — the AdminDashboardNav +
 * AdminMonitorNav scaffolding copies deleted): it renders upstream's
 * navbar.tmpl reduced to the LANDED pages — Maintenance (Dashboard),
 * Identity & Access (Organizations + Users + Badges + Emails), Assets
 * (Repositories + Packages — the tick-18 arm, gated on the global packages
 * flag), Integrations (Applications + Webhooks), the Configuration
 * group (SPEC-0018 §3.2's Summary item), the top-level System Notices item
 * (SPEC-0018 §3.1), Monitoring (the four live monitor items; audit_logs
 * omitted) — with the details-open + active-item arms derived from the
 * `active` prop (upstream's per-group PageIs* conditions), and OMITS every
 * group whose items are all unlanded (self_check, auths — SPEC-0018 §3.3's
 * omission verdict, actions). Survey row flipped on landing:
 * docs/compat/ui-parity-survey.md:549 (the `/-/admin/*` row — users/orgs/
 * repos go PARTIAL→listed).
 */

import type { Child } from "hono/jsx";

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";

import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Shared family chrome — the embedded icons (the pull-merge-box FOLD_SVG
// precedent: non-allowlisted octicons embed the pinned submodule's exact
// `<path d>` bytes, gitea/public/assets/img/svg/ at the pin) + the family
// navbar. Exported for the sibling admin-orgs/admin-repos modules (this
// wave's family; the mount mounts the three together).
// ---------------------------------------------------------------------------

/** Non-allowlisted icons with their upstream asset bytes. octicon-x is the
 *  pull-merge-box's verified bytes; the triangles/lock/mirror/fork ride the
 *  submodule's own svg files verbatim. */
export const ADMIN_EMBEDDED_ICONS: Record<string, { paths: string[]; viewBox: string }> = {
  "octicon-x": {
    paths: [
      "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.75.75 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.75.75 0 0 1-.734-.215L8 9.06l-3.22 3.22a.75.75 0 0 1-1.042-.018.75.75 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06",
    ],
    viewBox: "0 0 16 16",
  },
  "octicon-triangle-down": {
    paths: ["m4.427 7.427 3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427"],
    viewBox: "0 0 16 16",
  },
  "octicon-triangle-up": {
    paths: ["m4.427 9.573 3.396-3.396a.25.25 0 0 1 .354 0l3.396 3.396a.25.25 0 0 1-.177.427H4.604a.25.25 0 0 1-.177-.427"],
    viewBox: "0 0 16 16",
  },
  "octicon-lock": {
    paths: [
      "M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25M10.5 6V4a2.5 2.5 0 1 0-5 0v2Z",
    ],
    viewBox: "0 0 16 16",
  },
  "octicon-mirror": {
    paths: [
      "M15.547 3.061A.75.75 0 0 1 16 3.75v8.5a.751.751 0 0 1-1.265.545l-4.5-4.25a.75.75 0 0 1 0-1.09l4.5-4.25a.75.75 0 0 1 .812-.144M0 12.25v-8.5a.751.751 0 0 1 1.265-.545l4.5 4.25a.75.75 0 0 1 0 1.09l-4.5 4.25A.75.75 0 0 1 0 12.25m1.5-6.76v5.02L4.158 8ZM11.842 8l2.658 2.51V5.49ZM8 4a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5A.75.75 0 0 1 8 4m.75-2.25v.5a.75.75 0 0 1-1.5 0v-.5a.75.75 0 0 1 1.5 0m0 6v.5a.75.75 0 0 1-1.5 0v-.5a.75.75 0 0 1 1.5 0M8 10a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5A.75.75 0 0 1 8 10m0 3a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5A.75.75 0 0 1 8 13",
    ],
    viewBox: "0 0 16 16",
  },
  "octicon-repo-forked": {
    paths: [
      "M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0M5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0m6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5m-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0",
    ],
    viewBox: "0 0 16 16",
  },
  "octicon-apps": {
    paths: [
      "M1.5 3.25c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5A1.75 1.75 0 0 1 5.75 7.5h-2.5A1.75 1.75 0 0 1 1.5 5.75Zm7 0c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a1.75 1.75 0 0 1-1.75 1.75h-2.5A1.75 1.75 0 0 1 8.5 5.75Zm-7 7c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a1.75 1.75 0 0 1-1.75 1.75h-2.5a1.75 1.75 0 0 1-1.75-1.75Zm7 0c0-.966.784-1.75 1.75-1.75h2.5c.966 0 1.75.784 1.75 1.75v2.5a1.75 1.75 0 0 1-1.75 1.75h-2.5a1.75 1.75 0 0 1-1.75-1.75ZM3.25 3a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h2.5A.25.25 0 0 0 6 5.75v-2.5A.25.25 0 0 0 5.75 3Zm7 0a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h2.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25Zm-7 7a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h2.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25Zm7 0a.25.25 0 0 0-.25.25v2.5c0 .138.112.25.25.25h2.5a.25.25 0 0 0 .25-.25v-2.5a.25.25 0 0 0-.25-.25Z",
    ],
    viewBox: "0 0 16 16",
  },
};

/** `{{svg "name" size}}`'s DOM for allowlisted AND embedded names (the
 *  MergeBoxSvg twin): allowlisted paths ride the shared ICON_PATHS via the
 *  shell Icon; embedded names render here. */
export function AdminEmbeddedSvg(props: { name: string; size?: number; class?: string }) {
  const embedded = ADMIN_EMBEDDED_ICONS[props.name];
  if (embedded === undefined) {
    // Allowlisted name — the shared renderer's exact DOM.
    return <Icon name={props.name as IconName} size={props.size} class={props.class} />;
  }
  const classes = props.class === undefined ? `svg ${props.name}` : `svg ${props.name} ${props.class}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={embedded.viewBox}
      width={props.size ?? 16}
      height={props.size ?? 16}
      class={classes}
      aria-hidden="true"
    >
      {embedded.paths.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

/** The admin navbar union — the pages this family's scaffolding links: the
 *  listings PLUS the dashboard, the monitor family, and the census-R18 arms
 *  (emails/badges/applications/hooks — this wave's mount window). Upstream's
 *  navbar.tmpl marks the active page's item inside its open group. */
export type AdminFamilyNavActive =
  | "dashboard"
  | "users"
  | "orgs"
  | "repos"
  | "packages"
  | "emails"
  | "badges"
  | "applications"
  | "hooks"
  | "config"
  | "notices"
  | "stats"
  | "cron"
  | "queue"
  | "trace";

/** The family page chrome (component-local, the adminMonitorLocale pattern —
 *  locale.ts is shared and not this wave's file; upstream locale keys cited
 *  alongside). */
export const adminFamilyLocale = {
  settings: "Admin Settings", // "admin.settings" (navbar.tmpl:3)
  maintenance: "Maintenance", // "admin.maintenance" (navbar.tmpl:5)
  dashboard: "Dashboard", // "admin.dashboard"
  identityAccess: "Identity & Access", // "admin.identity_access" (navbar.tmpl:16)
  organizations: "Organizations", // "admin.organizations"
  userAccounts: "User Accounts", // "admin.users" (the nav item + page Title)
  badges: "Badges", // "admin.badges" (the R18 arm's nav item)
  emails: "User Email Addresses", // "admin.emails" (the R18 arm's nav item)
  assets: "Assets", // "admin.assets" (navbar.tmpl:31)
  repositories: "Repositories", // "admin.repositories"
  packages: "Packages", // "packages.title" (the admin packages arm's nav item, navbar.tmpl:35)
  integrations: "Integrations", // "admin.integrations" (navbar.tmpl:53 — the R18 wave's group)
  applications: "Applications", // "settings.applications" (the admin applications arm's nav item)
  hooks: "Webhooks", // "admin.hooks" (the admin hooks arm's nav item)
  configuration: "Configuration", // "admin.config" (navbar.tmpl:93 — the SPEC-0018 §3.2 arm's group)
  configSummary: "Summary", // "admin.config_summary" (navbar.tmpl:95-97; config.go:61's Title)
  notices: "System Notices", // "admin.notices" (the SPEC-0018 §3.1 arm's nav item)
  monitoring: "Monitoring", // "admin.monitor"
  stats: "Stats", // "admin.monitor.stats"
  cron: "Cron Tasks", // "admin.monitor.cron"
  queues: "Queues", // "admin.monitor.queues"
  trace: "Trace", // "admin.monitor.trace"
} as const;

/** The admin layout's navbar (navbar.tmpl at the pin; the F7 fold — ONE
 *  shared navbar across the whole admin family): the Maintenance details
 *  (Dashboard), Identity & Access (Organizations + User Accounts + Badges +
 *  Emails — the R18 arms), Assets (Packages — the tick-18 arm, gated on the
 *  global packages flag like navbar.tmpl:34's `{{if .EnablePackages}}` —
 *  then Repositories), Integrations (Applications + Webhooks — the R18
 *  arms), the Configuration group (the SPEC-0018 §3.2 arm's Summary item,
 *  navbar.tmpl:93-102 — the settings-editor item omitted by the dead-link
 *  rule), the TOP-LEVEL System Notices item (the SPEC-0018 §3.1 arm,
 *  navbar.tmpl:104-106's position), and Monitoring (the monitor family's
 *  four live items). Upstream's per-group `PageIs*` conditions reduce to:
 *  the group containing the active page renders `open`, the active item
 *  gets the `active item` class. auths, audit_logs, self_check, actions are
 *  omitted — all their upstream items are unlanded pages (the dead-link
 *  rule; the census's (b)/(c) classes; the auths omission is SPEC-0018
 *  §3.3's verdict). */
export function AdminFamilyNav(props: { active: AdminFamilyNavActive; packagesEnabled?: boolean }) {
  const item = (href: string, label: string, active: boolean) => (
    <a class={active ? "active item" : "item"} href={href}>
      {label}
    </a>
  );
  // navbar.tmpl's per-group PageIs* conditions — the details-open arm
  // derived from the active page (upstream opens the group containing it).
  const maintenanceOpen = props.active === "dashboard";
  const identityOpen =
    props.active === "users" || props.active === "orgs" || props.active === "badges" || props.active === "emails";
  // navbar.tmpl:33: `{{if or .PageIsAdminRepositories (and .EnablePackages
  // .PageIsAdminPackages)}}open{{end}}` — the packages arm only opens the
  // group while the feature is enabled.
  const assetsOpen = props.active === "repos" || (props.packagesEnabled !== false && props.active === "packages");
  const integrationsOpen = props.active === "applications" || props.active === "hooks";
  const configOpen = props.active === "config";
  const monitorOpen = props.active === "stats" || props.active === "cron" || props.active === "queue" || props.active === "trace";
  const openAttr = (open: boolean) => (open ? true : undefined);
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{adminFamilyLocale.settings}</div>
        <details class="item" open={openAttr(maintenanceOpen)}>
          <summary>{adminFamilyLocale.maintenance}</summary>
          <div class="menu">{item("/-/admin", adminFamilyLocale.dashboard, props.active === "dashboard")}</div>
        </details>
        <details class="item" open={openAttr(identityOpen)}>
          <summary>{adminFamilyLocale.identityAccess}</summary>
          <div class="menu">
            {item("/-/admin/orgs", adminFamilyLocale.organizations, props.active === "orgs")}
            {item("/-/admin/users", adminFamilyLocale.userAccounts, props.active === "users")}
            {item("/-/admin/badges", adminFamilyLocale.badges, props.active === "badges")}
            {item("/-/admin/emails", adminFamilyLocale.emails, props.active === "emails")}
          </div>
        </details>
        <details class="item" open={openAttr(assetsOpen)}>
          <summary>{adminFamilyLocale.assets}</summary>
          <div class="menu">
            {/* navbar.tmpl:34-38: the Packages item sits BEFORE Repositories,
                rendered only when the global packages flag arms (the strict
                polarity — absent/true = enabled, the ctx.packagesEnabled
                value the shell threads). */}
            {props.packagesEnabled !== false
              ? item("/-/admin/packages", adminFamilyLocale.packages, props.active === "packages")
              : null}
            {item("/-/admin/repos", adminFamilyLocale.repositories, props.active === "repos")}
          </div>
        </details>
        <details class="item" open={openAttr(integrationsOpen)}>
          <summary>{adminFamilyLocale.integrations}</summary>
          <div class="menu">
            {item("/-/admin/applications", adminFamilyLocale.applications, props.active === "applications")}
            {item("/-/admin/hooks", adminFamilyLocale.hooks, props.active === "hooks")}
          </div>
        </details>
        {/* The SPEC-0018 §3.2 config arm — upstream's Configuration group
            (navbar.tmpl:93-102) between Integrations and the top-level
            System Notices item, carrying its Summary item only: the
            settings-editor item (navbar.tmpl:98-100) stays omitted — its
            page requires the §-out write path (the dead-link rule). */}
        <details class="item" open={openAttr(configOpen)}>
          <summary>{adminFamilyLocale.configuration}</summary>
          <div class="menu">{item("/-/admin/config", adminFamilyLocale.configSummary, props.active === "config")}</div>
        </details>
        {/* The SPEC-0018 §3.1 notices arm — upstream renders it as a TOP-LEVEL
            item after the Configuration group and before Monitor
            (navbar.tmpl:104-106); the landed nav keeps that order. */}
        {item("/-/admin/notices", adminFamilyLocale.notices, props.active === "notices")}
        <details class="item" open={openAttr(monitorOpen)}>
          <summary>{adminFamilyLocale.monitoring}</summary>
          <div class="menu">
            {item("/-/admin/monitor/stats", adminFamilyLocale.stats, props.active === "stats")}
            {item("/-/admin/monitor/cron", adminFamilyLocale.cron, props.active === "cron")}
            {item("/-/admin/monitor/queue", adminFamilyLocale.queues, props.active === "queue")}
            {item("/-/admin/monitor/stacktrace", adminFamilyLocale.trace, props.active === "trace")}
          </div>
        </details>
      </div>
    </div>
  );
}

/** The admin layout shell (layout_head.tmpl verbatim around the content
 *  block): the family pageClass, the fluid padded flex container, the
 *  navbar, then `.flex-container-main` wrapping `.admin-setting-content`.
 *  The shell threads ctx.packagesEnabled into the nav (the Assets group's
 *  Packages item arms on it — navbar.tmpl's EnablePackages condition). */
export function AdminFamilyShell(props: { ctx: UiContext; title: string; pageClass: string; active: AdminFamilyNavActive; children: Child }) {
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass={props.pageClass}>
      <div class="ui container fluid padded flex-container">
        <AdminFamilyNav active={props.active} packagesEnabled={props.ctx.packagesEnabled !== false} />
        <div class="flex-container-main">
          <div class="admin-setting-content">{props.children}</div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The Older/Newer pager (base/paginate's landed reduction — the
 *  ExplorePagination shape) over a query built by the caller. */
export function AdminFamilyPagination(props: { basePath: string; query: URLSearchParams; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams(props.query);
    params.set("page", String(page));
    return `${props.basePath}?${params.toString()}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminUsersLocale = {
  user_manage_panel: "User Account Management", // "admin.users.user_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total" (list.tmpl:4)
  search_placeholder: "Search users…", // "search.user_kind" (list.tmpl:12)
  search: "Search…", // "search.search" (the combo's submit — the explore text-button reduction)
  filter_menu: "Filter", // "admin.users.list_status_filter.menu_text" (list.tmpl:18)
  reset: "Reset", // "admin.users.list_status_filter.reset" (list.tmpl:21)
  is_admin: "Admin", // "admin.users.list_status_filter.is_admin" (list.tmpl:23)
  not_admin: "Not Admin", // "admin.users.list_status_filter.not_admin" (list.tmpl:24)
  is_active: "Active", // "admin.users.list_status_filter.is_active" (list.tmpl:26)
  not_active: "Inactive", // "admin.users.list_status_filter.not_active" (list.tmpl:27)
  is_restricted: "Restricted", // "admin.users.list_status_filter.is_restricted" (list.tmpl:30)
  not_restricted: "Not Restricted", // "admin.users.list_status_filter.not_restricted" (list.tmpl:29)
  is_prohibit_login: "Prohibit Login", // "admin.users.list_status_filter.is_prohibit_login" (list.tmpl:33)
  not_prohibit_login: "Allow Login", // "admin.users.list_status_filter.not_prohibit_login" (list.tmpl:32)
  is_2fa_enabled: "2FA Enabled", // "admin.users.list_status_filter.is_2fa_enabled" (list.tmpl:35)
  not_2fa_enabled: "2FA Disabled", // "admin.users.list_status_filter.not_2fa_enabled" (list.tmpl:36)
  user_type: "User Type", // "admin.users.user_type" (list.tmpl:41)
  user_type_user: "User", // "concept_user_user" (list.tmpl:45)
  user_type_bot: "Bot", // "concept_user_bot" (list.tmpl:46)
  all: "All", // "all" (list.tmpl:44)
  sort: "Sort", // "repo.issues.filter_sort" (list.tmpl:67)
  sort_oldest: "Oldest", // "repo.issues.filter_sort.oldest"
  sort_newest: "Newest", // "repo.issues.filter_sort.latest"
  sort_alphabetically: "Alphabetically", // "repo.issues.label.filter_sort.alphabetically"
  sort_reverse_alphabetically: "Reverse alphabetically", // "repo.issues.label.filter_sort.reverse_alphabetically"
  sort_recentupdate: "Most recently updated", // "repo.issues.filter_sort.recentupdate"
  sort_leastupdate: "Least recently updated", // "repo.issues.filter_sort.leastupdate"
  col_id: "ID", // list.tmpl:86
  col_name: "Username", // "admin.users.name" (list.tmpl:88)
  col_email: "Email Address", // "email" (list.tmpl:91)
  col_auth_source: "Authentication Source", // "admin.users.auth_source" (list.tmpl:92)
  col_activated: "Activated", // "admin.users.activated" (list.tmpl:93)
  col_restricted: "Restricted", // "admin.users.restricted" (list.tmpl:94)
  col_2fa: "2FA", // "admin.users.2fa" (list.tmpl:95)
  col_created: "Created", // "admin.users.created" (list.tmpl:96)
  col_last_login: "Last Sign-In", // "admin.users.last_login" (list.tmpl:98)
  local: "Local", // "admin.users.local" (list.tmpl:120's zero arm)
  admin_label: "Admin", // "admin.users.admin" (list.tmpl:111)
  never_login: "Never Signed In", // "admin.users.never_login" (list.tmpl:128)
  no_results: "No results found.", // "no_results_found" (list.tmpl:138)
} as const;

/** Upstream `setting.UI.Admin.UserPagingNum` (modules/setting/ui.go:138). */
export const ADMIN_USERS_PAGE_SIZE = 50;

/** The five `status_filter[key]` keys upstream reads (users.go:63). */
export type AdminUserStatusFilterKey = "is_active" | "is_admin" | "is_restricted" | "is_2fa_enabled" | "is_prohibit_login";

/** One filter's parsed value: "1" | "0" | null (absent — the param's own
 *  tri-state). */
export type AdminUserStatusFilterValue = "1" | "0" | null;

/** The parsed query (the render's checked states + the pager's param set). */
export interface AdminUsersListParams {
  keyword: string;
  statusFilter: Record<AdminUserStatusFilterKey, AdminUserStatusFilterValue>;
  /** `user_type` — "" (all) | "User" | "Bot" (any other value folds to "",
   *  upstream's convert-or-default arm, users.go:75-79). */
  userType: "" | "User" | "Bot";
  /** The effective sort (users.go:71's default + user.go:61-83's fold of
   *  unknown values onto... — see adminUserOrderBy: unknown values keep the
   *  page default "alphabetically", RenderUserSearch's IfZero arm). */
  sort: AdminUserSort;
  /** Whether `?sort=` was in the URL (SortArrow's urlSort non-emptiness). */
  explicitSort: boolean;
  page: number;
}

/** The six dropdown sorts (list.tmpl:71-76); the page default is
 *  "alphabetically" (users.go:49). */
export type AdminUserSort = "oldest" | "newest" | "alphabetically" | "reversealphabetically" | "recentupdate" | "leastupdate";

/** `ctx.FormString("sort", UserSearchDefaultAdminSort)` — unknown values keep
 *  the default (RenderUserSearch's sortOrder mapping has no junk arm for the
 *  admin pages: the admin handler passes opts.OrderBy straight through, so a
 *  junk `sort` would order by the raw string upstream and SQL-error; the
 *  web page degrades to the default instead — the explore.tsx degradation
 *  posture, documented in the module header). */
export function parseAdminUserSort(raw: string | null): AdminUserSort {
  switch (raw) {
    case "oldest":
    case "newest":
    case "reversealphabetically":
    case "recentupdate":
    case "leastupdate":
      return raw;
    default:
      return "alphabetically";
  }
}

/** The query parse (users.go:59-79's shape). `status_filter[key]` is read
 *  verbatim — the bracket name is the upstream wire format. */
export function parseAdminUsersListParams(params: URLSearchParams): AdminUsersListParams {
  const statusFilter = {} as Record<AdminUserStatusFilterKey, AdminUserStatusFilterValue>;
  for (const key of ["is_active", "is_admin", "is_restricted", "is_2fa_enabled", "is_prohibit_login"] as const) {
    const raw = params.get(`status_filter[${key}]`);
    statusFilter[key] = raw === "1" || raw === "0" ? raw : null;
  }
  const userTypeRaw = params.get("user_type") ?? "";
  const rawSort = params.get("sort");
  return {
    keyword: (params.get("q") ?? "").trim(),
    statusFilter,
    userType: userTypeRaw === "User" || userTypeRaw === "Bot" ? userTypeRaw : "",
    sort: parseAdminUserSort(rawSort),
    explicitSort: rawSort !== null && rawSort !== "",
    page: parsePageNumber(params.get("page")),
  };
}

/** The user.go:61-83 orderBy switch over the landed columns.
 *  recentupdate/leastupdate sort `updated_unix` upstream — `users` carries no
 *  updated column, so created_at stands in (the API twin's deviation 5,
 *  routes/admin-t2.ts:104,216-221). lastlogin/reverselastlogin have no
 *  stand-in and are not part of this page's sort set. Alphabetical sorts ride
 *  `username_lower` (the search.ts convention for upstream's `name`). */
export function adminUserOrderBy(sort: AdminUserSort): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(users.id)];
    case "newest":
      return [desc(users.id)];
    case "alphabetically":
      return [asc(users.usernameLower)];
    case "reversealphabetically":
      return [desc(users.usernameLower)];
    case "recentupdate":
      return [desc(users.createdAt)];
    case "leastupdate":
      return [asc(users.createdAt)];
  }
}

// ---------------------------------------------------------------------------
// The loader (§3.2 — the module header's service-gap note)
// ---------------------------------------------------------------------------

/** The page's render inputs. `params` echoes the parsed query (the form's
 *  checked/selected states); `query` is the pager's param set (q + the
 *  filters + sort, page excluded). */
export interface AdminUsersData {
  params: AdminUsersListParams;
  query: URLSearchParams;
  total: number;
  more: boolean;
  items: (typeof users.$inferSelect)[];
}

/**
 * The list load — `admin.Users` → `RenderUserSearch` over the landed columns:
 * type='user' (upstream's individual family — orgs never surface, users.go:74),
 * the admin-actor keyword triple (username/full name/email — SearchByEmail,
 * the API twin's exact instr() predicate), the five status filters (the
 * header's mapping) + the user_type arm, the sort, one page of 50.
 */
export async function loadAdminUsersData(d1: D1Database, search: URLSearchParams): Promise<AdminUsersData> {
  const params = parseAdminUsersListParams(search);
  const conditions: SQL[] = [eq(users.type, "user")];

  if (params.keyword !== "") {
    const keyword = params.keyword.toLowerCase();
    conditions.push(sql`(
      instr(${users.usernameLower}, ${keyword}) > 0
      or instr(lower(coalesce(${users.fullName}, '')), ${keyword}) > 0
      or instr(lower(coalesce(${users.email}, '')), ${keyword}) > 0
    )`);
  }

  const { statusFilter, userType } = params;
  // The status enum folds is_active/is_prohibit_login (the module header):
  // is_active=1 ⇔ prohibit=0 ⇔ 'active'.
  if (statusFilter.is_active !== null) {
    conditions.push(eq(users.status, statusFilter.is_active === "1" ? "active" : "prohibited"));
  }
  if (statusFilter.is_prohibit_login !== null) {
    conditions.push(eq(users.status, statusFilter.is_prohibit_login === "1" ? "prohibited" : "active"));
  }
  if (statusFilter.is_admin !== null) {
    conditions.push(eq(users.isAdmin, statusFilter.is_admin === "1"));
  }
  // restricted / 2FA: the constant-false store — truthy filters match
  // nothing, falsy/absent filter nothing out (the API twin's exact arms,
  // routes/admin-t2.ts:315-323).
  if (statusFilter.is_restricted === "1" || statusFilter.is_2fa_enabled === "1") {
    conditions.push(sql`0 = 1`);
  }
  if (userType === "Bot") {
    conditions.push(sql`0 = 1`); // no bot rows exist (users.type is 'user'|'org')
  }

  const where = and(...conditions);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(users).where(where);
  const total = Number(totalRows[0]?.value ?? 0);
  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(...adminUserOrderBy(params.sort))
    .limit(ADMIN_USERS_PAGE_SIZE)
    .offset((params.page - 1) * ADMIN_USERS_PAGE_SIZE);

  const query = new URLSearchParams();
  if (params.keyword !== "") query.set("q", params.keyword);
  if (params.userType !== "") query.set("user_type", params.userType);
  for (const key of ["is_active", "is_admin", "is_restricted", "is_2fa_enabled", "is_prohibit_login"] as const) {
    const value = statusFilter[key];
    if (value !== null) query.set(`status_filter[${key}]`, value);
  }
  if (params.sort !== "alphabetically") query.set("sort", params.sort);

  return { params, query, total, more: params.page * ADMIN_USERS_PAGE_SIZE < total, items };
}

// ---------------------------------------------------------------------------
// The render (templates/admin/user/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, the formatDueDate twin
 *  (milestones.tsx:168). */
export function formatAdminDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The check/x cell (list.tmpl:121-123's Iif pair): octicon-check is
 *  allowlisted; octicon-x embeds the submodule bytes (the module header). */
function CheckCell(props: { on: boolean }) {
  return props.on ? <Icon name="octicon-check" /> : <AdminEmbeddedSvg name="octicon-x" />;
}

/** The SortArrow reduction: the header link toggles the direction
 *  (tablesort.ts's pair) and the arrow mirrors util_misc.go:29-53 — up when
 *  this column's asc is the EXPLICIT sort, down on its explicit desc, down on
 *  the default column when no sort param is in the URL. Rendered only for
 *  headers with landed backing. */
export function SortHeader(props: {
  label: string;
  asc: string;
  desc: string;
  /** The effective sort (the page default when the param is absent). */
  active: string;
  /** Whether `?sort=` is in the URL (upstream's urlSort non-emptiness). */
  explicit: boolean;
  defaultColumn?: boolean;
  buildHref: (sort: string) => string;
}) {
  const isAscActive = props.active === props.asc;
  const isDescActive = props.active === props.desc;
  const target = isAscActive ? props.desc : props.asc;
  const arrow = props.explicit && isAscActive ? (
    <AdminEmbeddedSvg name="octicon-triangle-up" />
  ) : props.explicit && isDescActive ? (
    <AdminEmbeddedSvg name="octicon-triangle-down" />
  ) : !props.explicit && props.defaultColumn === true ? (
    <AdminEmbeddedSvg name="octicon-triangle-down" />
  ) : null;
  return (
    <a href={props.buildHref(target)}>
      {props.label}
      {arrow}
    </a>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminUsersPage(ctx: UiContext, data: AdminUsersData): string {
  return renderPage(<AdminUsersPage ctx={ctx} data={data} />);
}

/** The admin users page (§2.4.1 discriminator: `admin user` — layout_head's
 *  pageClass, list.tmpl:1; upstream's Title is ctx.Tr "admin.users",
 *  users.go:60). */
export function AdminUsersPage(props: { ctx: UiContext; data: AdminUsersData }) {
  const { params } = props.data;
  const colCount = 9; // the live columns (the actions column omitted — the module header)
  const sortHref = (sort: string): string => {
    const next = new URLSearchParams(props.data.query);
    // The header toggle keeps every param and replaces sort (tablesort.ts's
    // exact shape — page persists, upstream quirk mirrored).
    if (sort === "alphabetically") {
      next.delete("sort"); // the default never rides the URL (users.go:71)
    } else {
      next.set("sort", sort);
    }
    const qs = next.toString();
    return qs === "" ? "/-/admin/users" : `/-/admin/users?${qs}`;
  };
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminUsersLocale.user_manage_panel} pageClass="admin user" active="users">
      {/* The header (list.tmpl:3-8): panel name + total. The "Create User
          Account" button is omitted — /-/admin/users/new is unlanded (the
          module header). */}
      <h4 class="ui top attached header">
        {adminUsersLocale.user_manage_panel} ({adminUsersLocale.total.replace("%d", String(props.data.total))})
      </h4>
      {/* The toolbar (list.tmpl:9-81): ONE no-JS GET form wrapping the combo
          + the filter/sort dropdowns, exactly upstream's form shape. */}
      <div class="ui attached segment">
        <form class="ui form ignore-dirty flex-text-block" id="user-list-search-form" method="get" action="/-/admin/users">
          <div class="tw-flex-1">
            <div class="ui small fluid action input">
              <input
                type="search"
                name="q"
                value={params.keyword}
                maxlength={255}
                spellcheck={false}
                placeholder={adminUsersLocale.search_placeholder}
              />
              <button type="submit" class="ui small icon button" aria-label={adminUsersLocale.search}>
                {adminUsersLocale.search}
              </button>
            </div>
          </div>
          {/* The status filter dropdown (list.tmpl:17-38) as a details
              disclosure; the radios are live (they submit with the form) and
              the Reset item is the plain-link reduction (the module header). */}
          <details class="item">
            <summary>{adminUsersLocale.filter_menu}</summary>
            <div class="menu flex-items-menu">
              <a class="item js-reset-status-filter" href={sortHref(params.sort)}>
                {adminUsersLocale.reset}
              </a>
              <div class="divider"></div>
              <label class="item">
                <input type="radio" name="status_filter[is_admin]" value="1" checked={params.statusFilter.is_admin === "1"} />{" "}
                {adminUsersLocale.is_admin}
              </label>
              <label class="item">
                <input type="radio" name="status_filter[is_admin]" value="0" checked={params.statusFilter.is_admin === "0"} />{" "}
                {adminUsersLocale.not_admin}
              </label>
              <div class="divider"></div>
              <label class="item">
                <input type="radio" name="status_filter[is_active]" value="1" checked={params.statusFilter.is_active === "1"} />{" "}
                {adminUsersLocale.is_active}
              </label>
              <label class="item">
                <input type="radio" name="status_filter[is_active]" value="0" checked={params.statusFilter.is_active === "0"} />{" "}
                {adminUsersLocale.not_active}
              </label>
              <div class="divider"></div>
              <label class="item">
                <input type="radio" name="status_filter[is_restricted]" value="0" checked={params.statusFilter.is_restricted === "0"} />{" "}
                {adminUsersLocale.not_restricted}
              </label>
              <label class="item">
                <input type="radio" name="status_filter[is_restricted]" value="1" checked={params.statusFilter.is_restricted === "1"} />{" "}
                {adminUsersLocale.is_restricted}
              </label>
              <div class="divider"></div>
              <label class="item">
                <input
                  type="radio"
                  name="status_filter[is_prohibit_login]"
                  value="0"
                  checked={params.statusFilter.is_prohibit_login === "0"}
                />{" "}
                {adminUsersLocale.not_prohibit_login}
              </label>
              <label class="item">
                <input
                  type="radio"
                  name="status_filter[is_prohibit_login]"
                  value="1"
                  checked={params.statusFilter.is_prohibit_login === "1"}
                />{" "}
                {adminUsersLocale.is_prohibit_login}
              </label>
              <div class="divider"></div>
              <label class="item">
                <input
                  type="radio"
                  name="status_filter[is_2fa_enabled]"
                  value="1"
                  checked={params.statusFilter.is_2fa_enabled === "1"}
                />{" "}
                {adminUsersLocale.is_2fa_enabled}
              </label>
              <label class="item">
                <input
                  type="radio"
                  name="status_filter[is_2fa_enabled]"
                  value="0"
                  checked={params.statusFilter.is_2fa_enabled === "0"}
                />{" "}
                {adminUsersLocale.not_2fa_enabled}
              </label>
            </div>
          </details>
          {/* The user-type dropdown (list.tmpl:40-48). The auth-source
              dropdown (list.tmpl:51-62) does not render — no auth-source
              store (the module header). */}
          <details class="item">
            <summary>{adminUsersLocale.user_type}</summary>
            <div class="menu flex-items-menu">
              <label class="item">
                <input type="radio" name="user_type" value="" checked={params.userType === ""} /> {adminUsersLocale.all}
              </label>
              <label class="item">
                <input type="radio" name="user_type" value="User" checked={params.userType === "User"} />{" "}
                {adminUsersLocale.user_type_user}
              </label>
              <label class="item">
                <input type="radio" name="user_type" value="Bot" checked={params.userType === "Bot"} />{" "}
                {adminUsersLocale.user_type_bot}
              </label>
            </div>
          </details>
          {/* The sort dropdown (list.tmpl:64-78) — upstream's own
              submit-button shape, no-JS live. */}
          <details class="item">
            <summary>{adminUsersLocale.sort}</summary>
            <div class="menu">
              <button type="submit" class="item" name="sort" value="oldest">
                {adminUsersLocale.sort_oldest}
              </button>
              <button type="submit" class="item" name="sort" value="newest">
                {adminUsersLocale.sort_newest}
              </button>
              <button type="submit" class="item" name="sort" value="alphabetically">
                {adminUsersLocale.sort_alphabetically}
              </button>
              <button type="submit" class="item" name="sort" value="reversealphabetically">
                {adminUsersLocale.sort_reverse_alphabetically}
              </button>
              <button type="submit" class="item" name="sort" value="recentupdate">
                {adminUsersLocale.sort_recentupdate}
              </button>
              <button type="submit" class="item" name="sort" value="leastupdate">
                {adminUsersLocale.sort_leastupdate}
              </button>
            </div>
          </details>
        </form>
      </div>
      {/* The table (list.tmpl:82-142) — the nine live columns. The sortable
          headers are the tablesort.ts link reduction (the module header); the
          Last Sign-In header's lastlogin sorter has no backing → plain text. */}
      <div class="ui attached table segment">
        <table class="ui very basic selectable table unstackable">
          <thead>
            <tr>
              <th scope="col">
                <SortHeader
                  label={adminUsersLocale.col_id}
                  asc="oldest"
                  desc="newest"
                  active={params.sort}
                  explicit={params.explicitSort}
                  buildHref={sortHref}
                />
              </th>
              <th scope="col">
                <SortHeader
                  label={adminUsersLocale.col_name}
                  asc="alphabetically"
                  desc="reversealphabetically"
                  active={params.sort}
                  explicit={params.explicitSort}
                  defaultColumn={true}
                  buildHref={sortHref}
                />
              </th>
              <th scope="col">{adminUsersLocale.col_email}</th>
              <th scope="col">{adminUsersLocale.col_auth_source}</th>
              <th scope="col">{adminUsersLocale.col_activated}</th>
              <th scope="col">{adminUsersLocale.col_restricted}</th>
              <th scope="col">{adminUsersLocale.col_2fa}</th>
              <th scope="col">{adminUsersLocale.col_created}</th>
              <th scope="col">{adminUsersLocale.col_last_login}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr class="no-results-row">
                <td class="tw-text-center" colspan={colCount}>
                  {adminUsersLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>
                    <a href={`/${row.username}`}>{row.username}</a>
                    {row.isAdmin ? <span class="ui basic label tw-py-0 tw-align-baseline">{adminUsersLocale.admin_label}</span> : null}
                  </td>
                  <td class="gt-ellipsis tw-max-w-48">{row.email ?? ""}</td>
                  {/* The auth-source cell: every account is local (the
                      module header). */}
                  <td class="gt-ellipsis tw-max-w-32">{adminUsersLocale.local}</td>
                  <td>
                    <CheckCell on={row.status === "active"} />
                  </td>
                  {/* restricted / 2FA: the constant-false store renders the
                      x arm only (the module header). */}
                  <td>
                    <CheckCell on={false} />
                  </td>
                  <td>
                    <CheckCell on={false} />
                  </td>
                  <td>{formatAdminDate(row.createdAt)}</td>
                  <td>
                    <span>{adminUsersLocale.never_login}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AdminFamilyPagination basePath="/-/admin/users" query={props.data.query} page={params.page} more={props.data.more} />
    </AdminFamilyShell>
  );
}
