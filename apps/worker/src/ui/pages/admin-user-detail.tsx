/**
 * The ADMIN USER DETAIL page — `/-/admin/users/{userid}` — census gap #18's
 * NOTE arm and the 2a00e28 handoff: upstream web.go:817's
 * `m.Get("/{userid}", admin.ViewUser)` inside the `/-/admin/users` group,
 * served by `admin.ViewUser` (routers/web/admin/users.go:314-370) through
 * `prepareUserInfo` (:269-281) and rendered by templates/admin/user/
 * view.tmpl + admin/user/{view_details,view_emails,view_orgs}.tmpl.
 * PORT-FIRST: the module owns the load + render; the route lives behind the
 * orchestrator's index.ts fold (the mount recipe at the bottom). The landed
 * admin-users-avatar.ts write pair (web.go:820-821's POST
 * `/{userid}/avatar[ /delete]` seams, port-first at 2a00e28) REDIRECTS onto
 * this page — until this render lands, the pair's target 404s; the avatar
 * FORMS fold into this page's render through those seams (below).
 *
 * ## The unknown-id arm (prepareUserInfo, users.go:269-278)
 *
 * An unknown {userid} is a REDIRECT to `/-/admin/users` (the list), never a
 * 404: `loadAdminUserDetail` answers `null` and the handler 303s onto
 * `ADMIN_USERS_LIST_LINK` (the admin-users-avatar.ts export — the exact
 * posture its write arms already answer). Any users row passes — orgs ARE
 * users rows (SPEC-0007's one id space; upstream GetUserByID has no type
 * gate), so an org id renders its details the same way.
 *
 * ## Sections (view.tmpl at the pin) and the landed fold
 *
 * pageClass `admin view user` (layout_head's dict), the AdminFamilyShell
 * (active "users"), then:
 *
 *   - The header row: "User Details" (admin.users.details) with the
 *     impersonate button + edit link OMITTED — the impersonate POST is the
 *     2a00e28 STOP arm (needs `sessions.impersonator_user_id`, the
 *     adjudication lives with that landing) and `/-/admin/users/{id}/edit`
 *     is unlanded: dead controls are forbidden (§2.4.1), the same rule that
 *     dropped the list page's actions column.
 *   - view_details: the 48px avatar (the landed serving seam
 *     `/user/avatar/{name}/48`), the shared/user/name link (upstream
 *     DisplayNameWithFullName — "name (Full Name)" when the full name is
 *     set; a PROHIBITED row renders PLAIN text, the list page's §4.8
 *     posture — a prohibited account is invisible to every viewer, so the
 *     profile link would be dead), the "Admin" basic label on isAdmin, the
 *     Authentication Source line (the constant "Local" — every account is
 *     local, the admin-t2 deviation-4 posture), the Activated /
 *     Disable-Sign-In / Restricted / 2FA check-x lines (octicon-check when
 *     the flag holds, octicon-x otherwise — verbatim view_details.tmpl's
 *     Iif arms; restricted + 2FA are the constant-false stores, so x
 *     always; the status enum folds activated ⇔ !prohibit_login), the
 *     visibility line (Public/Limited/Private), and the location/website
 *     rows when set. The language line never renders — `users` has no
 *     language column, view_details.tmpl:44's `{{if .User.Language}}` gate
 *     is unproducible.
 *   - THE AVATAR FORMS (the mission's fold — upstream hosts them on the
 *     EDIT page, admin/user/edit.tmpl:189-225, which is unlanded): the
 *     settings.avatar section renders the org-settings avatar form's
 *     no-JS reduction — the live avatar img, the `avatar` multipart file
 *     input, Update Avatar, and Delete Current Avatar — pointed at the
 *     landed write seams `${adminUserLink(id)}/avatar` and
 *     `.../avatar/delete` (admin-users-avatar.ts; both 303 back HERE, the
 *     redirect target this page provides). The upstream form's
 *     source/gravatar radio fields stay dropped — the org arm's documented
 *     reduction the write seams pin (an empty submit is a no-op, never a
 *     clear).
 *   - view_emails: "User Email Addresses (Total: N)" + the flex-divided-list
 *     rows — the mailto link, the Primary label, the
 *     Activated/Requires-activation pair. The read is the API twin's
 *     synthesized-primary union (routes/misc-t3.ts emailEntriesOfUser — the
 *     primary lives on users.email, secondaries in email_addresses, the
 *     primary unshifted when no row carries it), module-local like the list
 *     page's predicate (the module-local-query posture).
 *   - The BotAccessTokens section never renders — `users.type` is
 *     'user'|'org' (no bot value exists, the 2a00e28 dead-arm note), so
 *     view.tmpl:25's `{{if .BotAccessTokens}}` gate is unproducible.
 *   - Repositories: "Repositories (Total: N)" + the SHARED repo list rows —
 *     pages/org-home.tsx's OrgRepoListItem (the shared/repo/list.tmpl row
 *     component, this page is exactly upstream's shared/repo/list
 *     consumer): every repo the target OWNS (upstream SearchRepository
 *     OwnerID + Private:true + Collaborate:false, users.go:330-340 — no
 *     collaboration rows, no visibility filter on the admin view),
 *     slug-ASC (upstream db.SearchOrderByAlphabetically), the batched
 *     description read (the org-home loader's pattern).
 *   - view_orgs: "Organizations (Total: N)" + the membership rows — the
 *     placeholder avatar glyph (the org-home avatar-slot rule), the name
 *     link, the Private badge on private orgs, the "Joined on" date line
 *     (DateUtils.AbsoluteShort — formatAdminDate). The Remove All button +
 *     modal and the per-org Remove buttons are OMITTED — they POST to
 *     `/-/admin/users/{id}/orgs/*` (web.go:826-827), unlanded writes (the
 *     dead-control rule). The listing is the landed
 *     `OrgService.listUserOrgs` (the GET /user/orgs read, maxVisibility
 *     "private" — the admin sees every membership upstream's
 *     GetUserOrganizations lists), capped at the service's MAX_PAGE_SIZE —
 *     upstream pages with ListOptionsAll (unbounded); a target with >50
 *     orgs truncates, the documented reduction.
 *
 * ## Mount recipe (the orchestrator's index.ts fold)
 *
 * 1. `UiRoute` gains `{ family: "admin-user-detail"; adminUserId: number }`
 *    (the admin-users-avatar.ts recipe's payload shape — one carrier for
 *    both folds).
 * 2. `parseUiRoute`, in the `raw[1] === "-" && raw[2] === "admin"` tail
 *    parse, AFTER the `users` literal (static-before-dynamic, the
 *    admin-users-avatar.ts header's block):
 *
 *      if (
 *        tail.length === 2 &&
 *        tail[0] === "users" &&
 *        /^\d+$/.test(tail[1])
 *      ) {
 *        return { family: "admin-user-detail", adminUserId: Number(tail[1]) };
 *      }
 *
 *    (`/{userid}/edit` et al stay unclaimed → the engine's 404 — the
 *    unlanded pages; junk segments stay engine-404, the house idiom. Upstream
 *    chi would claim `/users/{userid}` for ANY segment and let
 *    prepareUserInfo redirect non-numeric ids; the landed family claims
 *    digits only, so a non-numeric segment 404s here — the
 *    admin-users-avatar.ts recipes' exact posture.)
 * 3. Handler (the adminUsersPage shape):
 *
 *      async function adminUserDetailPage(c: Context<{ Bindings: Env }>) {
 *        const p = await adminPagePrologue(c);
 *        if (!p.ok) return p.response;
 *        const route = ...; // the parsed route, drift-guarded
 *        const data = await loadAdminUserDetail(c.env.DB, route.adminUserId);
 *        if (data === null) {
 *          return p.respond(new Response(null, { status: 303, headers: { location: ADMIN_USERS_LIST_LINK } }));
 *        }
 *        return p.respond(c.html(renderAdminUserDetailPage(p.ctx, { ...data, oauth2Enabled: oauth2FeatureEnabled(c.env) })));
 *      }
 *
 * 4. Registration beside the admin family's GETs:
 *    `uiRouter.get("/-/admin/users/:userid", (c) => adminUserDetailPage(c));`
 *    — AFTER the `/-/admin/users` static (Hono's router prefers the static
 *    literal; the avatar POSTs already carry their own deeper paths).
 */

import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, repoSettings, repositories, users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { AdminEmbeddedSvg, AdminFamilyShell, adminUsersLocale, formatAdminDate } from "./admin-users";
import { ADMIN_USERS_LIST_LINK, adminUserLink } from "./admin-users-avatar";
import { OrgRepoListItem } from "./org-home";
import { orgSettingsLocale } from "./org-settings";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminUserDetailLocale = {
  details: "User Details", // "admin.users.details" (view.tmpl:6 — the Title)
  auth_source: "Authentication Source", // "admin.users.auth_source" (view_details.tmpl:14)
  local: "Local", // "admin.users.local" — alias of adminUsersLocale.local (the render rides the shared const)
  activated: "Activated", // "admin.users.activated" (:17)
  prohibit_login: "Disable Sign-In", // "admin.users.prohibit_login" (:20)
  restricted: "Restricted", // "admin.users.restricted" (:23)
  visibility: "User visibility", // "settings.visibility" (:27)
  visibility_public: "Public", // "settings.visibility.public"
  visibility_limited: "Limited", // "settings.visibility.limited"
  visibility_private: "Private", // "settings.visibility.private"
  two_factor: "2FA", // "admin.users.2fa" (:33)
  emails: "User Email Addresses", // "admin.emails" (view.tmpl:16)
  repositories: "Repositories", // "admin.repositories" (view.tmpl:33)
  organizations: "Organizations", // "settings.organization" (view_orgs.tmpl:6)
  total: "Total: %d", // "admin.total"
  primary: "Primary", // "settings.primary" (view_emails.tmpl:7)
  activated_label: "Activated", // "settings.activated" (view_emails.tmpl:9)
  requires_activation: "Requires activation", // "settings.requires_activation" (:10)
  private: "Private", // "repo.desc.private" (view_orgs.tmpl:31)
  joined_on: "Joined on %s", // "user.joined_on" (view_orgs.tmpl:37)
  avatar_section: "Avatar", // "settings.avatar" (edit.tmpl:190's section header — the fold's title)
} as const;

/** Upstream `DisplayNameWithFullName` (models/user/user.go:496-501): the
 *  name, or "name (Full Name)" when a non-blank full name is set. */
export function displayNameWithFullName(user: { username: string; fullName: string | null }): string {
  const fullName = user.fullName?.trim();
  return fullName !== undefined && fullName !== "" ? `${user.username} (${fullName})` : user.username;
}

// ---------------------------------------------------------------------------
// The loader (ViewUser's data pull over the landed reads)
// ---------------------------------------------------------------------------

/** One view_emails row (the EmailEntry shape — a real email_addresses row
 *  or the synthesized primary). */
export interface AdminUserEmailEntry {
  email: string;
  isActivated: boolean;
  isPrimary: boolean;
}

/** One shared/repo/list row: the repositories row + the batched
 *  repoSettings description (the OrgHomeRepoItem shape the shared row
 *  component renders). */
export interface AdminUserDetailRepo {
  repo: typeof repositories.$inferSelect;
  description: string;
}

/** The page's render inputs. */
export interface AdminUserDetailData {
  user: typeof users.$inferSelect;
  emails: AdminUserEmailEntry[];
  emailsTotal: number;
  repos: AdminUserDetailRepo[];
  reposTotal: number;
  orgs: OrgRecord[];
  /** The shell's Integrations gate (the AdminUsersData convention — the
   *  route threads `oauth2FeatureEnabled(c.env)`). Absent/true = enabled. */
  oauth2Enabled?: boolean;
}

/**
 * ViewUser's data pull (users.go:314-370 over prepareUserInfo): the users
 * row by id (`null` = the LIST-redirect arm, never a 404), the email
 * entries (the synthesized-primary union), the owned repos (slug ASC,
 * no visibility filter — the admin view) with batched descriptions, the
 * org memberships (the landed listUserOrgs, the admin's unfiltered
 * ceiling, capped at MAX_PAGE_SIZE — the module header's reduction).
 */
export async function loadAdminUserDetail(d1: D1Database, userId: number): Promise<Omit<AdminUserDetailData, "oauth2Enabled"> | null> {
  const db = drizzle(d1);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return null;

  // The emails (misc-t3.ts emailEntriesOfUser's twin — primary first, then
  // the rows by id; the primary synthesized when no row carries it).
  const emailRows = await db
    .select()
    .from(emailAddresses)
    .where(eq(emailAddresses.userId, user.id))
    .orderBy(asc(emailAddresses.id));
  const emails: AdminUserEmailEntry[] = emailRows.map((row) => ({
    email: row.email,
    isActivated: row.isActivated,
    isPrimary: row.isPrimary,
  }));
  const primaryLower = user.email?.toLowerCase();
  if (primaryLower !== undefined && primaryLower !== "" && !emailRows.some((row) => row.lowerEmail === primaryLower)) {
    emails.unshift({ email: user.email!, isActivated: true, isPrimary: true });
  }

  // The owned repos (users.go:330-340's SearchRepository: OwnerID,
  // Private:true — no visibility filter on the admin view —
  // Collaborate:false, alphabetical) + the batched descriptions (the
  // org-home loader's pattern).
  const repoRows = await db
    .select()
    .from(repositories)
    .where(eq(repositories.ownerId, user.id))
    .orderBy(asc(repositories.slug))
    .all();
  const descriptions = new Map<string, string>();
  if (repoRows.length > 0) {
    const settings = await db
      .select({ repoId: repoSettings.repoId, description: repoSettings.description })
      .from(repoSettings)
      .where(inArray(repoSettings.repoId, repoRows.map((row) => row.id)))
      .all();
    for (const row of settings) descriptions.set(row.repoId, row.description);
  }

  // The org memberships (upstream GetUserOrganizations, users.go:360-362):
  // the landed read at the admin's unfiltered ceiling.
  const orgs = await new OrgService(d1).listUserOrgs(user.id, { maxVisibility: "private", page: 1, pageSize: 50 });

  return {
    user,
    emails,
    emailsTotal: emails.length,
    repos: repoRows.map((row) => ({ repo: row, description: descriptions.get(row.id) ?? "" })),
    reposTotal: repoRows.length,
    orgs: orgs.items,
  };
}

// ---------------------------------------------------------------------------
// The render (view.tmpl + view_details + view_emails + view_orgs)
// ---------------------------------------------------------------------------

/** The check/x cell (view_details.tmpl's `{{svg (Iif .X "octicon-check"
 *  "octicon-x")}}`): check is allowlisted; x embeds the submodule bytes
 *  (admin-users.tsx's seam). */
function CheckCell(props: { on: boolean }) {
  return props.on ? <Icon name="octicon-check" /> : <AdminEmbeddedSvg name="octicon-x" />;
}

/** The view_details block (:1-63 at the pin, reductions in the header). */
function UserDetailsBlock(props: { user: AdminUserDetailData["user"] }) {
  const { user } = props;
  const prohibited = user.status === "prohibited";
  return (
    <div class="flex-divided-list items-with-main">
      <div class="item">
        <div class="item-leading">
          {/* ctx.AvatarUtils.Avatar .User 48 — the landed serving seam. */}
          <img class="ui avatar" src={`/user/avatar/${encodeURIComponent(user.username)}/48`} alt="" width={48} height={48} />
        </div>
        <div class="item-main">
          <div class="item-title">
            {/* shared/user/name — the link degrades to plain text on a
                prohibited row (the list page's §4.8 posture). */}
            {prohibited ? (
              <span class="text muted">{displayNameWithFullName(user)}</span>
            ) : (
              <a class="text muted" href={`/${user.username}`}>{displayNameWithFullName(user)}</a>
            )}
            {user.isAdmin ? <span class="ui basic label">{adminUsersLocale.admin_label}</span> : null}
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.auth_source}:</b> {adminUsersLocale.local}
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.activated}:</b> <CheckCell on={user.status === "active"} />
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.prohibit_login}:</b> <CheckCell on={prohibited} />
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.restricted}:</b> <CheckCell on={false} />
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.visibility}:</b>{" "}
            {user.visibility === "public"
              ? adminUserDetailLocale.visibility_public
              : user.visibility === "limited"
                ? adminUserDetailLocale.visibility_limited
                : adminUserDetailLocale.visibility_private}
          </div>
          <div class="item-body">
            <b>{adminUserDetailLocale.two_factor}:</b> <CheckCell on={false} />
          </div>
          {user.location !== null && user.location !== "" ? (
            <div class="item-body">
              <span class="flex-text-inline">
                <Icon name="octicon-location" />
                {user.location}
              </span>
            </div>
          ) : null}
          {user.website !== null && user.website !== "" ? (
            <div class="item-body">
              <span class="flex-text-inline">
                <Icon name="octicon-link" />
                <a target="_blank" rel="noopener noreferrer" href={user.website}>
                  {user.website}
                </a>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The view_emails block (:1-16). */
function UserEmailsBlock(props: { emails: AdminUserEmailEntry[] }) {
  return (
    <div class="flex-divided-list items-with-main">
      {props.emails.map((entry) => (
        <div class="item">
          <div class="item-main">
            <div class="flex-text-block">
              <a href={`mailto:${entry.email}`}>{entry.email}</a>
              {entry.isPrimary ? <div class="ui primary label">{adminUserDetailLocale.primary}</div> : null}
              {entry.isActivated ? (
                <div class="ui green label">{adminUserDetailLocale.activated_label}</div>
              ) : (
                <div class="ui label">{adminUserDetailLocale.requires_activation}</div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The view_orgs block (view_orgs.tmpl — the remove arms omitted, the
 *  module header). */
function UserOrgsBlock(props: { orgs: OrgRecord[] }) {
  return (
    <>
      <h4 class="ui top attached header">
        {adminUserDetailLocale.organizations} ({adminUserDetailLocale.total.replace("%d", String(props.orgs.length))})
      </h4>
      {props.orgs.length > 0 ? (
        <div class="ui attached segment">
          <div class="flex-divided-list items-with-main">
            {props.orgs.map((org) => (
              <div class="item tw-items-center">
                <div class="item-leading">
                  <span class="ui avatar" aria-hidden="true">
                    <Icon name="octicon-person" />
                  </span>
                </div>
                <div class="item-main">
                  <div class="item-title">
                    <a class="text muted" href={`/${org.username}`}>{displayNameWithFullName(org)}</a>
                    {org.visibility === "private" ? (
                      <span class="ui basic tiny label">{adminUserDetailLocale.private}</span>
                    ) : null}
                  </div>
                  <div class="item-body">
                    <span class="flex-text-inline">
                      <Icon name="octicon-calendar" /> {adminUserDetailLocale.joined_on.replace("%s", formatAdminDate(org.createdAt))}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminUserDetailPage(ctx: UiContext, data: AdminUserDetailData): string {
  return renderPage(<AdminUserDetailPage ctx={ctx} data={data} />);
}

/** The admin user detail page (§2.4.1 discriminator: layout_head's
 *  `admin view user`, view.tmpl:1). */
export function AdminUserDetailPage(props: { ctx: UiContext; data: AdminUserDetailData }) {
  const { ctx, data } = props;
  const user = data.user;
  const link = adminUserLink(user.id);
  return (
    <AdminFamilyShell ctx={ctx} title={adminUserDetailLocale.details} pageClass="admin view user" active="users" oauth2Enabled={data.oauth2Enabled}>
      <div class="admin-responsive-columns">
        <div class="tw-flex-1">
          {/* The header (view.tmpl:5-13): the Title span; the impersonate
              button + edit link are OMITTED (the module header — the STOP
              arm + the unlanded edit page, the dead-control rule). */}
          <h4 class="ui top attached header flex-left-right">
            <span>{adminUserDetailLocale.details}</span>
          </h4>
          <div class="ui attached segment">
            <UserDetailsBlock user={user} />
          </div>
        </div>
        <div class="tw-flex-1">
          <h4 class="ui top attached header">
            {adminUserDetailLocale.emails} ({adminUserDetailLocale.total.replace("%d", String(data.emailsTotal))})
          </h4>
          <div class="ui attached segment">
            <UserEmailsBlock emails={data.emails} />
          </div>
        </div>
      </div>

      {/* THE AVATAR FORMS (the mission's fold — the write seams' redirect
          target; upstream hosts the form on the unlanded edit page,
          edit.tmpl:189-225; the no-JS reduction is the org-settings form's,
          with the source/gravatar fields the seams already dropped). */}
      <h4 class="ui top attached header">{adminUserDetailLocale.avatar_section}</h4>
      <div class="ui attached segment">
        <form class="ui form" action={`${link}/avatar`} method="post" enctype="multipart/form-data">
          <div class="inline field">
            <img class="ui avatar" src={`/user/avatar/${encodeURIComponent(user.username)}/64`} alt="" />{" "}
            <label for="avatar">{orgSettingsLocale.choose_new_avatar}</label>
            <input id="avatar" name="avatar" type="file" />
          </div>
          <div class="field">
            <button type="submit" class="ui primary button">
              {orgSettingsLocale.update_avatar}
            </button>
            <button type="submit" class="ui red button" formaction={`${link}/avatar/delete`} formnovalidate>
              {orgSettingsLocale.delete_current_avatar}
            </button>
          </div>
        </form>
      </div>

      {/* The repositories section (view.tmpl:31-38) — the shared repo list
          rows; ShowRepoOwnerOnList stays off (every row's owner IS the
          target, upstream's default for this consumer). */}
      <h4 class="ui top attached header">
        {adminUserDetailLocale.repositories} ({adminUserDetailLocale.total.replace("%d", String(data.reposTotal))})
      </h4>
      <div class="ui attached segment">
        {data.repos.length === 0 ? (
          <div class="empty-placeholder">
            <Icon name="octicon-repo" size={48} />
          </div>
        ) : (
          <div class="flex-divided-list items-with-main">
            {data.repos.map((item) => (
              <OrgRepoListItem orgLink={`/${user.username}`} item={item} orgPrivate={user.visibility === "private"} />
            ))}
          </div>
        )}
      </div>

      <UserOrgsBlock orgs={data.orgs} />
    </AdminFamilyShell>
  );
}

/** The unknown-id redirect target (prepareUserInfo, users.go:273) — re-
 *  exported so the handler glue imports the pair from one module. */
export { ADMIN_USERS_LIST_LINK };
