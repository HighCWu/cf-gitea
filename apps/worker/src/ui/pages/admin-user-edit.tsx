/**
 * The ADMIN USER EDIT page — `/-/admin/users/{userid}/edit` — the GET+POST
 * combo of upstream web.go:820's
 * `m.Combo("/{userid}/edit").Get(admin.EditUser).Post(web.Bind[*forms.AdminEditUserForm](), admin.EditUserPost)`
 * (routers/web/admin/users.go:391-557 over editUserCommon + prepareUserInfo,
 * rendered by templates/admin/user/edit.tmpl). PORT-FIRST: the module owns
 * the load + render + submit; the route lives behind the orchestrator's
 * index.ts fold (the mount recipe at the bottom). This is the last unlanded
 * piece of the admin users group — the detail page landed at eb8df05, the
 * avatar write pair at 2a00e28, and the list's actions column has pointed
 * nowhere until now.
 *
 * ## The unknown-id arm (prepareUserInfo, users.go:269-278)
 *
 * An unknown {userid} REDIRECTS to `/-/admin/users` (the list), never a 404
 * — the SAME arm the detail page answers (`loadAdminUserEdit` answers null;
 * the handler 303s onto `ADMIN_USERS_LIST_LINK`, the admin-users-avatar.ts
 * export). Any users row passes — orgs ARE users rows (SPEC-0007's one id
 * space; upstream GetUserByID has no type gate), so an org id renders the
 * form exactly like the detail page renders its census.
 *
 * ## The form (edit.tmpl at the pin) and the port's reductions
 *
 * pageClass `admin edit user` (layout_head's dict), the AdminFamilyShell
 * (active "users"), then the ONE `<form action="./edit" method="post">`
 * whose field set reads exactly upstream's:
 *
 *   - `user_name` — the RENAME field (users.go:427-462's RenameUser arm,
 *     skipped when the posted value is empty or unchanged). Targets of
 *     type 'user' ride the module-local mirror of admin-t2.ts's
 *     `renameUserRow` (route-private there — the list page's
 *     module-local-predicate posture); org targets ride the landed
 *     `OrgService.renameOrg` (the same upstream RenameUser, the org-side
 *     port). Name errors carry the WEB ladder's en-US texts
 *     (form.username_been_taken / user.form.name_reserved /
 *     user.form.name_pattern_not_allowed / user.form.name_chars_not_allowed),
 *     mapped from the typed org errors, flagged on the field.
 *   - `user_type` — renders ONLY when upstream's CanConvertUserType holds
 *     (CheckConvertUserType, services/user/update.go:299-307: admins and
 *     orgs can't convert). Submitting "Bot" hits the landed deviation 3
 *     (our users.type enum has no bot value): plain targets re-render with
 *     the API arm's exact "user type can not be converted" text
 *     (upstream would convert — the closest declared error, admin-t2.ts's
 *     posture); an admin target answers upstream's ErrBotCanNotBeAdmin arm
 *     (users.go:545-550 — Flash + redirect; the no-flash reduction 303s
 *     silently); an org target answers upstream's default ServerError arm
 *     (users.go:553-556) as the app's plain-text 500 (the impersonate
 *     module's convention). Junk values fail the In(,User,Bot) bind — the
 *     flag-less silent re-render (users.go:421-424's HasError arm; the
 *     rendered select cannot produce junk).
 *   - `login_type` — the auth-source dropdown. Upstream lists Local (0-0)
 *     plus every FindSources row; the port lists the LANDED login_sources
 *     (services/auth-sources/store.ts findLoginSources — the FindSources
 *     port, name ASC). The posted value is ACCEPTED AND IGNORED: our users
 *     rows carry no login_source column (schema.ts SPEC external-auth §4 —
 *     the OAuth2-only v1 resolves through external_login_user), the
 *     deviation-1 set admin-t2.ts's PATCH arm records for source_id.
 *   - `visibility` — the required dropdown; the no-JS select posts
 *     upstream's wire values 0/1/2 (edit.tmpl's hidden-input values —
 *     Public/Limited/Private), junk or absent re-renders flagged on the
 *     field (upstream's Err_Visibility bind arm, silent — no banner).
 *   - `login_name` — rendered hidden exactly like upstream's
 *     `{{if eq .User.LoginSource 0}}tw-hidden{{end}}` arm (every row is
 *     source 0), accepted and ignored (no column).
 *   - `full_name` → users.full_name + users.display_name (the admin-t2
 *     PATCH arm's dual-column posture — display_name is the directory
 *     render column), empty clears (upstream's optional.Some semantics —
 *     the form always posts every field).
 *   - `email` (required) — the bind phase checks required + format
 *     (services/user-accounts.ts invalidEmailMessage — the
 *     IsEmailAddressValid port); a bind miss re-renders FLAGGED with no
 *     banner (upstream's silent HasError arm). The email arm
 *     (users.go:497-510 → ReplacePrimaryEmailAddress): org targets answer
 *     upstream's InvalidArgument mapping (email.go:28-31 →
 *     users.go:507-509 — "The email address is invalid." + the field
 *     flag; the API twin's 400 carries the service text instead), the
 *     case-fold-same address no-ops, a foreign duplicate re-renders
 *     flagged with form.email_been_used. The domain-allowlist flash
 *     warning (users.go:511-513) has no allowlist config landed — dead
 *     arm, not ported.
 *   - `password` — rendered for form parity (upstream renders it for
 *     local users; every row is local) and ACCEPTED AND IGNORED (SPEC-0002
 *     §4.6.7, PAT-only auth — admin-t2.ts deviation 1: no password store,
 *     no length/complexity/pwned arm exists to hit). Never echoes.
 *   - `language` — DROPPED: users has no language column (the detail
 *     page's unproducible-language-line posture) and the landed
 *     EditUserOption contract (admin-t2.ts editUserOptionSchema) declares
 *     no language field to accept-and-ignore.
 *   - `website` / `location` → the landed columns, empty clears.
 *   - `max_repo_creation` — rendered at upstream's fresh-row default -1,
 *     the int bind enforced (junk re-renders flagged, silent), the value
 *     ACCEPTED AND IGNORED (the contract declares it; no column).
 *   - `active` / `prohibit_login` — the status-enum fold (admin-t2.ts
 *     deviation 6): either off-signal lands 'prohibited', an explicit-on
 *     lands 'active'. The SKIP-SELF guard (users.go:476-480) forces
 *     prohibit false when the target IS the doer — the rendered checkbox
 *     is also disabled for self (edit.tmpl:132's eq arm).
 *   - `admin` — users.is_admin, always applied (upstream's
 *     UpdateOptionFieldFromValue), with the last-admin guard
 *     (admin-t2.ts's isLastAdminUser — route-private, mirrored
 *     module-local): unsetting the last admin re-renders with
 *     auth.last_admin, no field flag (upstream's exact arm,
 *     users.go:539-541).
 *   - `restricted` — rendered unchecked (the constant-false store), the
 *     posted value accepted and ignored.
 *   - `allow_git_hook` / `allow_import_local` — rendered hidden+disabled
 *     exactly like upstream's DEFAULT-config render (setting.
 *     DisableGitHooks defaults true, security.go:71; ImportLocalPaths
 *     defaults false, security.go:168 → both fields carry tw-hidden and
 *     the checkbox disabled at our no-config posture; CanEditGitHook /
 *     CanImportLocal fold to false, user.go:306-319), the posted values
 *     accepted and ignored.
 *   - `allow_create_organization` — rendered checked iff isAdmin
 *     (CanCreateOrganization, user.go:301-303 — the flag column is the
 *     absent half), the posted value accepted and ignored.
 *   - `reset_2fa` — present iff upstream's TwoFactorEnabled holds:
 *     hasTOTP || hasWebAuthn (users.go:305-307) — the landed `two_factor`
 *     table (schema.ts migration 0059) is read for the TOTP half; WebAuthn
 *     has no store yet (its half is the constant false). On submit the
 *     DisableTwoFactor arm (users.go:551-556, twofactor.go:199-208) dies
 *     the TOTP row; the WebAuthn half is the recorded future unit.
 *   - The DELETE-ACCOUNT button + #delete-user-modal are OMITTED — they
 *     POST `./delete` (web.go:819's admin.DeleteUser, unlanded) and the
 *     dead-control rule drops them (the detail page's remove-org posture).
 *   - base/disable_form_autofill's dummy inputs are omitted — every landed
 *     form omits the autofill bait (browser-only concern, no backend
 *     reader).
 *   - THE AVATAR SECTION (edit.tmpl:189-225) — upstream hosts it HERE, and
 *     this page renders the landed org-settings reduction's twin (the
 *     no-JS form the landed admin-users-avatar.ts seams pin: the `avatar`
 *     file input + Update Avatar + Delete Current Avatar pointed at
 *     `${adminUserLink(id)}/avatar[ /delete]`). The detail page's
 *     temporary fold (eb8df05/0cf8fd1 hosted the forms while this page was
 *     unlanded) is the ORCHESTRATOR's re-fold decision — that file is
 *     read-only here; until the re-fold the form renders on both pages,
 *     both pointing at the same landed seams.
 *
 * ## The POST ladder (EditUserPost's observable order)
 *
 * prepareUserInfo (unknown → the LIST redirect) → the BIND phase
 * (required email, the visibility/max_repo_creation/login_type/user_type
 * enum-int binds — misses re-render flagged at 200, no banner, NOTHING
 * else runs) → the rename arm (commits immediately, upstream's own tx
 * boundary) → the auth fold (status; the accepted-and-ignored set
 * absorbed) → the email arm (org / duplicate) → the UpdateUser position
 * (the type arms, the last-admin guard, then ONE column UPDATE) → the
 * reset-2FA arm → the 303 onto `adminUserLink(targetId)` (upstream's
 * Flash success + redirect; the no-flash reduction drops the banner —
 * admin.users.update_profile_success has no renderable analog). Upstream
 * persists the rename BEFORE a later arm can fail, so a failed email
 * after a successful rename re-renders the NEW name — the port's fresh
 * re-read reproduces that partial-persist observable.
 *
 * ## Mount recipe (the orchestrator's index.ts fold)
 *
 * 1. `UiRoute` gains `{ family: "admin-user-edit"; adminUserId: number }`
 *    (the admin-users-avatar.ts recipe's payload shape — the same carrier
 *    the detail/impersonate/avatar families use).
 * 2. `parseUiRoute`, in the `raw[1] === "-" && raw[2] === "admin"` tail
 *    parse, AFTER the `admin-user-detail` claim (static-before-dynamic;
 *    static-before-the-longer-tail is already the block's shape — the
 *    avatar-delete four-segment claim sits beside the three-segment ones):
 *
 *      if (
 *        tail.length === 3 &&
 *        tail[0] === "users" &&
 *        tail[2] === "edit" &&
 *        /^\d+$/.test(tail[1])
 *      ) {
 *        return { family: "admin-user-edit", adminUserId: Number.parseInt(tail[1], 10) };
 *      }
 *
 *    (junk segments stay engine-404 — the house idiom every sibling
 *    family claims by).
 * 3. Handlers (the adminUserDetailPage / adminUserAvatarSubmit shapes —
 *    the prologue IS the admin gate: anonymous 303s onto the login
 *    round-trip, a non-admin 404-shells; the POST adds the §2.8
 *    sameOriginGuard first):
 *
 *      async function adminUserEditPage(c, userId) {
 *        const p = await adminPagePrologue(c);
 *        if (!p.ok) return p.response;
 *        const data = await loadAdminUserEdit(c.env.DB, userId);
 *        if (data === null) return p.respond(new Response(null, { status: 303, headers: { location: ADMIN_USERS_LIST_LINK } }));
 *        return p.respond(c.html(renderAdminUserEditPage(p.ctx, { ...data, error: null, errorField: null, oauth2Enabled: oauth2FeatureEnabled(c.env) }), 200));
 *      }
 *
 *      async function adminUserEditSubmit(c, userId) {
 *        const guard = sameOriginGuard(c.req.raw);
 *        if (guard !== null) return guard;
 *        const p = await adminPagePrologue(c);
 *        if (!p.ok) return p.response;
 *        if (p.ctx.viewer.kind !== "user") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *        const form = parseAdminUserEditForm(await readUrlEncodedForm(c.req.raw));
 *        const outcome = await submitAdminUserEdit(c.env.DB, userId, p.ctx.viewer.id, form);
 *        if (outcome.outcome === "unknown-target") {
 *          return p.respond(new Response(null, { status: 303, headers: { location: ADMIN_USERS_LIST_LINK } }));
 *        }
 *        if (outcome.outcome === "server-error") {
 *          return p.respond(new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain;charset=utf-8" } }));
 *        }
 *        if (outcome.outcome === "invalid") {
 *          // upstream's RenderWithErrDeprecated: re-render the FRESH row
 *          // at 200 with the banner + the flagged field (the partial
 *          // persist — a completed rename shows — survives).
 *          const data = await loadAdminUserEdit(c.env.DB, userId);
 *          if (data === null) return p.respond(new Response(null, { status: 303, headers: { location: ADMIN_USERS_LIST_LINK } }));
 *          return p.respond(c.html(renderAdminUserEditPage(p.ctx, { ...data, error: outcome.message, errorField: outcome.field, oauth2Enabled: oauth2FeatureEnabled(c.env) }), 200));
 *        }
 *        // updated | redirect — both 303 onto the detail page (upstream's
 *        // userLink; redirect is the flash+redirect arms with the flash
 *        // dropped).
 *        return p.respond(new Response(null, { status: 303, headers: { location: adminUserLink(userId) } }));
 *      }
 *
 * 4. Registration beside the detail claim (index.ts:17136's block — the
 *    combo rides the SAME `{\\d+}` digit-guard shape):
 *
 *      uiRouter.get("/-/admin/users/:userid{\\d+}/edit", (c) => adminUserEditPage(c, Number.parseInt(c.req.param("userid"), 10)));
 *      uiRouter.post("/-/admin/users/:userid{\\d+}/edit", (c) => adminUserEditSubmit(c, Number.parseInt(c.req.param("userid"), 10)));
 *
 * 5. Null pins that flip with this landing (the orchestrator's folds; both
 *    files are read-only here):
 *    - pages/admin-users.tsx: the list's per-row actions column
 *      (list.tmpl:112-118's pencil link to `{.Link}/edit`) can render —
 *      the column exists but has pointed nowhere since the list landed.
 *    - pages/admin-user-detail.tsx: view.tmpl:10's edit link
 *      (`${adminUserLink(id)}/edit`) can render beside the (still
 *      stopped) impersonate button; the avatar section MAY move here
 *      wholesale (upstream hosts it on THIS page — see the section note).
 *    - pages/admin-user-detail.test.tsx:285-291 pins the edit link's
 *      ABSENCE — that assertion flips to a presence pin at the fold.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, twoFactor, userRedirects, users } from "../../db/schema";
import { invalidEmailMessage } from "../../services/user-accounts";
import {
  OrgError,
  OrgNameCharsInvalidError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
} from "../../services/orgs/errors";
import { OrgService, usableUsernameError } from "../../services/orgs/orgs";
import { findLoginSources, type LoginSourceRow } from "../../services/auth-sources/store";
import type { UiContext } from "../ui-context";
import { AdminFamilyShell, adminUsersLocale } from "./admin-users";
import { ADMIN_USERS_LIST_LINK, adminUserLink } from "./admin-users-avatar";
import { orgSettingsLocale } from "./org-settings";
import { renderPage } from "../shell";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminUserEditLocale = {
  edit_account: "Edit User Account", // "admin.users.edit_account" (the Title + the h4)
  username: "Username", // "username" (edit.tmpl:10)
  auth_source: "Authentication Source", // "admin.users.auth_source" (:29) — alias of adminUsersLocale's cell copy
  auth_login_name: "Authentication Sign-In Name", // "admin.users.auth_login_name" (:71)
  visibility: "User visibility", // "settings.visibility" (:47)
  visibility_public: "Public", // "settings.visibility.public"
  visibility_limited: "Limited", // "settings.visibility.limited"
  visibility_private: "Private", // "settings.visibility.private"
  full_name: "Full Name", // "settings.full_name" (:75)
  email: "Email Address", // "email" (:79)
  password: "Password", // "password" (:84)
  password_helper: "Leave the password empty to keep it unchanged.", // "admin.users.password_helper" (:86)
  website: "Website", // "settings.website" (:105)
  location: "Location", // "settings.location" (:109)
  max_repo_creation: "Maximum Number of Repositories", // "admin.users.max_repo_creation" (:116)
  max_repo_creation_desc: "(Enter -1 to use the global default limit.)", // "admin.users.max_repo_creation_desc" (:118)
  is_activated: "User Account Is Activated", // "admin.users.is_activated" (:125)
  prohibit_login: "Disable Sign-In", // "admin.users.prohibit_login" (:131)
  is_admin: "Is Administrator", // "admin.users.is_admin" (:138)
  is_restricted: "Is Restricted", // "admin.users.is_restricted" (:144)
  allow_git_hook: "May Create Git Hooks", // "admin.users.allow_git_hook" (:151)
  allow_git_hook_tooltip:
    "Git Hooks are executed as the OS user running Gitea and will have the same level of host access. As a result, users with this special Git Hook privilege can access and modify all Gitea repositories as well as the database used by Gitea. Consequently they are also able to gain Gitea administrator privileges.", // "admin.users.allow_git_hook_tooltip" (:150)
  allow_import_local: "May Import Local Repositories", // "admin.users.allow_import_local" (:157)
  allow_create_organization: "May Create Organizations", // "admin.users.allow_create_organization" (:164)
  reset_2fa: "Reset 2FA", // "admin.users.reset_2fa" (:174)
  update_profile: "Update User Account", // "admin.users.update_profile" (:183)
  avatar_section: "Avatar", // "settings.avatar" (:190)
  // The RenderWithErr ladder's en-US texts (users.go:434-458, :500-509, :540).
  username_been_taken: "The username is already taken.", // "form.username_been_taken"
  name_reserved: 'The username "%s" is reserved.', // "user.form.name_reserved"
  name_pattern_not_allowed: 'The pattern "%s" is not allowed in a username.', // "user.form.name_pattern_not_allowed"
  name_chars_not_allowed: 'Username "%s" contains invalid characters.', // "user.form.name_chars_not_allowed"
  email_been_used: "The email address is already used.", // "form.email_been_used"
  email_invalid: "The email address is invalid.", // "form.email_invalid"
  last_admin: "You cannot remove the last admin. There must be at least one admin.", // "auth.last_admin"
} as const;

// ---------------------------------------------------------------------------
// The loader (EditUser's data pull over prepareUserInfo)
// ---------------------------------------------------------------------------

/** The page's render inputs (edit.tmpl's model: .User + .Sources +
 *  .CanConvertUserType + .TwoFactorEnabled). */
export interface AdminUserEditData {
  user: typeof users.$inferSelect;
  /** The auth-source dropdown's tail (prepareUserInfo's .Sources —
   *  FindSources over every row, name ASC). */
  sources: LoginSourceRow[];
  /** `user_type` renders only when CheckConvertUserType(u) == nil
   *  (services/user/update.go:299-307): NOT an admin and NOT an org. */
  canConvertUserType: boolean;
  /** hasTOTP || hasWebAuthn (users.go:305-307): the landed two_factor row
   *  is the TOTP half; WebAuthn has no store yet (the constant-false
   *  half). Gates the reset_2fa checkbox (edit.tmpl:170-178). */
  twoFactorEnabled: boolean;
}

/**
 * prepareUserInfo's pull (users.go:269-281): the users row by id (`null` =
 * the LIST-redirect arm, never a 404), the auth sources, the convert gate,
 * and the 2FA-enabled read.
 */
export async function loadAdminUserEdit(d1: D1Database, userId: number): Promise<AdminUserEditData | null> {
  const db = drizzle(d1);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return null;
  const sources = await findLoginSources(d1);
  const totp = await db.select({ uid: twoFactor.userId }).from(twoFactor).where(eq(twoFactor.userId, userId)).limit(1);
  return {
    user,
    sources,
    canConvertUserType: !user.isAdmin && user.type === "user",
    twoFactorEnabled: totp.length > 0,
  };
}

// ---------------------------------------------------------------------------
// The form parse (web.Bind[*forms.AdminEditUserForm] — forms/admin.go:47-69;
// an unchecked checkbox is ABSENT, not false-valued — the org-settings
// parse convention)
// ---------------------------------------------------------------------------

export interface AdminUserEditForm {
  userName: string;
  /** The raw `user_type` wire value ("" | "User" | "Bot" pass upstream's
   *  In(,User,Bot) bind; junk is absorbed to "" in the submit). */
  userType: string;
  /** The raw `login_type` wire value ("0-0" local; the Required bind). */
  loginType: string;
  loginName: string;
  fullName: string;
  email: string;
  password: string;
  website: string;
  location: string;
  /** The raw `max_repo_creation` wire value (the int bind). */
  maxRepoCreation: string;
  /** The raw `visibility` wire value ("0" | "1" | "2" upstream). */
  visibility: string;
  active: boolean;
  prohibitLogin: boolean;
  admin: boolean;
  restricted: boolean;
  allowGitHook: boolean;
  allowImportLocal: boolean;
  allowCreateOrganization: boolean;
  reset2fa: boolean;
}

export function parseAdminUserEditForm(params: URLSearchParams): AdminUserEditForm {
  return {
    userName: params.get("user_name") ?? "",
    userType: params.get("user_type") ?? "",
    loginType: params.get("login_type") ?? "",
    loginName: params.get("login_name") ?? "",
    fullName: params.get("full_name") ?? "",
    email: params.get("email") ?? "",
    password: params.get("password") ?? "",
    website: params.get("website") ?? "",
    location: params.get("location") ?? "",
    maxRepoCreation: params.get("max_repo_creation") ?? "",
    visibility: params.get("visibility") ?? "",
    active: params.get("active") !== null,
    prohibitLogin: params.get("prohibit_login") !== null,
    admin: params.get("admin") !== null,
    restricted: params.get("restricted") !== null,
    allowGitHook: params.get("allow_git_hook") !== null,
    allowImportLocal: params.get("allow_import_local") !== null,
    allowCreateOrganization: params.get("allow_create_organization") !== null,
    reset2fa: params.get("reset_2fa") !== null,
  };
}

// ---------------------------------------------------------------------------
// The submit (EditUserPost, users.go:413-557, over the landed seams)
// ---------------------------------------------------------------------------

/** The fields the re-render can flag (upstream's Err_UserName /
 *  Err_LoginType / Err_Visibility / Err_Email / Err_MaxRepoCreation class
 *  hooks; Err_Password / Err_LoginName are unreachable — the deviation-1
 *  accepted-and-ignored set). */
export type AdminUserEditErrorField = "userName" | "loginType" | "visibility" | "email" | "maxRepoCreation";

/** The arm's outcome union (the wiring's map, the module header's recipe):
 *  `invalid` re-renders the FRESH row at 200 with the banner (`message`,
 *  null = the silent bind arms) + the flagged field; `redirect` is the
 *  flash+redirect arms with the flash dropped (the wiring's 303 equals
 *  updated's); `server-error` is the ServerError arm as the app's
 *  plain-text 500. */
export type AdminUserEditOutcome =
  | { outcome: "updated" }
  | { outcome: "unknown-target" }
  | { outcome: "redirect" }
  | { outcome: "invalid"; message: string | null; field: AdminUserEditErrorField | null }
  | { outcome: "server-error" };

/** admin-t2.ts's `isLastAdminUser` (route-private — mirrored module-local,
 *  the list page's predicate posture): only the FALSE-set checks
 *  (update.go:145-157). */
async function isLastAdminUser(d1: D1Database, target: { id: number; isAdmin: boolean }): Promise<boolean> {
  if (!target.isAdmin) return false;
  const others = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), sql`${users.id} != ${target.id}`))
    .limit(1);
  return others.length === 0;
}

/** admin-t2.ts's `emailUsedByOther` (route-private — mirrored
 *  module-local): upstream IsEmailUsed over any user row, self-excluded. */
async function emailUsedByOther(d1: D1Database, email: string, selfId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .all();
  return rows.some((row) => row.id !== selfId);
}

/**
 * admin-t2.ts's `renameUserRow` (route-private — mirrored module-local),
 * the user-side half of upstream RenameUser (services/user/user.go:36-116):
 * exact-compare no-op, the name rules through the typed org errors,
 * case-only display flip (no redirect row — our ownerNamespace stores the
 * LOWER name, unchanged by a case flip), then ONE batch = rename + the
 * NewUserRedirect write rule + the repositories.owner_namespace rewrite.
 * Org targets never reach here (the submit routes them to the landed
 * OrgService.renameOrg).
 */
async function renameUserRow(
  d1: D1Database,
  target: { id: number; username: string; usernameLower: string },
  newName: string,
): Promise<void> {
  if (newName === target.username) return;
  const nameError = usableUsernameError(newName);
  if (nameError !== null) throw nameError;
  const newLower = newName.toLowerCase();

  const db = drizzle(d1);
  if (newLower === target.usernameLower) {
    await db.update(users).set({ username: newName }).where(eq(users.id, target.id));
    return;
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, newLower)).get();
  if (existing !== undefined && existing.id !== target.id) {
    throw new OrgNameCollisionError(newName);
  }

  const now = new Date();
  try {
    await db.batch([
      db
        .update(users)
        .set({ username: newName, usernameLower: newLower })
        .where(and(eq(users.id, target.id), eq(users.type, "user"))),
      db.delete(userRedirects).where(eq(userRedirects.lowerName, target.usernameLower)),
      db.delete(userRedirects).where(eq(userRedirects.lowerName, newLower)),
      db.insert(userRedirects).values({ lowerName: target.usernameLower, redirectUserId: target.id }),
      db.update(repositories).set({ ownerNamespace: newLower, updatedAt: now }).where(eq(repositories.ownerId, target.id)),
    ]);
  } catch (error) {
    let text = error instanceof Error ? error.message : String(error);
    let cause: unknown = error;
    while (cause instanceof Error && cause.cause !== undefined) {
      cause = cause.cause;
      text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (text.includes("UNIQUE constraint failed")) throw new OrgNameCollisionError(newName);
    throw error;
  }
}

/** The WEB rename ladder's texts (users.go:431-458) mapped from the typed
 *  org errors — the locale strings upstream's RenderWithErr arms carry
 *  (the API twin answers the service texts instead). */
function renameErrorMessage(error: OrgError, newName: string): string {
  if (error instanceof OrgNameCollisionError) return adminUserEditLocale.username_been_taken;
  if (error instanceof OrgNameCharsInvalidError) return adminUserEditLocale.name_chars_not_allowed.replace("%s", newName);
  if (error instanceof OrgNameReservedError) return adminUserEditLocale.name_reserved.replace("%s", newName);
  if (error instanceof OrgNamePatternNotAllowedError) return adminUserEditLocale.name_pattern_not_allowed.replace("%s", newName);
  return error.message; // the remaining rule texts (renameOrg's 40-char cap)
}

/** edit.tmpl's visibility wire values (0/1/2) → the landed enum (the bind
 *  phase already guarantees the domain). */
function visibilityFromString(raw: string): "public" | "limited" | "private" {
  return raw === "1" ? "limited" : raw === "2" ? "private" : "public";
}

/**
 * POST /-/admin/users/{userid}/edit (admin.EditUserPost, users.go:413-557)
 * over the landed seams — the module header carries the ladder and every
 * reduction. The caller supplies the §2.8-guarded, prologue-gated doer id
 * (`doerId`) for the skip-self prohibit guard.
 */
export async function submitAdminUserEdit(
  d1: D1Database,
  targetId: number,
  doerId: number,
  form: AdminUserEditForm,
): Promise<AdminUserEditOutcome> {
  const db = drizzle(d1);
  const user = await db.select().from(users).where(eq(users.id, targetId)).get();
  if (user === undefined) return { outcome: "unknown-target" };

  // --- the bind phase (web.Bind's AdminEditUserForm validation; a miss
  // re-renders at 200 with the flagged fields and NO banner — the silent
  // HasError arm, users.go:421-424 — and NOTHING else runs).
  if (form.loginType === "") return { outcome: "invalid", message: null, field: "loginType" };
  if (!/^(0|1|2)$/.test(form.visibility)) return { outcome: "invalid", message: null, field: "visibility" };
  if (!/^-?\d+$/.test(form.maxRepoCreation)) return { outcome: "invalid", message: null, field: "maxRepoCreation" };
  if (form.userType !== "" && form.userType !== "User" && form.userType !== "Bot") {
    // In(,User,Bot): junk fails the bind with no Err_ hook on the template
    // — the flag-less silent re-render.
    return { outcome: "invalid", message: null, field: null };
  }
  if (form.email === "" || invalidEmailMessage(form.email) !== null) {
    // The Required;Email bind — Err_Email flagged, silent.
    return { outcome: "invalid", message: null, field: "email" };
  }

  // --- the rename arm (users.go:427-462 → RenameUser): commits
  // immediately like upstream's own tx — a later arm's failure re-renders
  // the NEW name (the partial-persist observable).
  if (form.userName !== "" && form.userName !== user.username) {
    try {
      if (user.type === "org") {
        await new OrgService(d1).renameOrg(user.id, form.userName);
      } else {
        await renameUserRow(d1, user, form.userName);
      }
    } catch (error) {
      if (error instanceof OrgError) {
        return { outcome: "invalid", message: renameErrorMessage(error, form.userName), field: "userName" };
      }
      throw error;
    }
  }

  // --- the auth arm (users.go:464-495 → UpdateAuth): password /
  // login_name / login_type are the deviation-1 accepted-and-ignored set
  // (no password store, no login-source column — no arm exists to hit);
  // the prohibit fold with the SKIP-SELF guard (users.go:476-480), then
  // the deviation-6 status fold (admin-t2.ts's PATCH posture).
  const prohibitLogin = form.prohibitLogin && doerId !== user.id;
  const prohibited = prohibitLogin || form.active === false;
  const activated = form.active === true || form.prohibitLogin === false;
  const nextStatus: "active" | "prohibited" | null = prohibited ? "prohibited" : activated ? "active" : null;

  // --- the email arm (users.go:497-510 → ReplacePrimaryEmailAddress): the
  // case-fold-same address no-ops (email.go:33-35); an org target answers
  // upstream's InvalidArgument mapping; a foreign duplicate the
  // email_been_used arm.
  const emailChanged = (user.email ?? "").toLowerCase() !== form.email.toLowerCase();
  if (emailChanged && user.type === "org") {
    return { outcome: "invalid", message: adminUserEditLocale.email_invalid, field: "email" };
  }
  if (emailChanged && (await emailUsedByOther(d1, form.email, user.id))) {
    return { outcome: "invalid", message: adminUserEditLocale.email_been_used, field: "email" };
  }

  // --- the UpdateUser position (users.go:511-548): the type arms first
  // (CheckConvertUserType lives inside upstream's UpdateUser), then the
  // last-admin guard, then ONE column UPDATE.
  if (form.userType === "Bot") {
    if (user.type === "org") return { outcome: "server-error" }; // ErrUserTypeCanNotConvert → the default ServerError arm
    if (user.isAdmin) return { outcome: "redirect" }; // ErrBotCanNotBeAdmin → Flash + redirect (the flash dropped)
    return { outcome: "invalid", message: "user type can not be converted", field: null }; // deviation 3 — upstream converts; our enum has no bot value
  }
  if (form.admin === false && (await isLastAdminUser(d1, user))) {
    return { outcome: "invalid", message: adminUserEditLocale.last_admin, field: null };
  }

  // The column patch — upstream's optional.Some semantics: the form always
  // posts every field, empties CLEAR (fullName rides the admin-t2 PATCH
  // arm's dual-column posture).
  const patch: Partial<typeof users.$inferInsert> = {
    fullName: form.fullName,
    displayName: form.fullName,
    website: form.website,
    location: form.location,
    isAdmin: form.admin,
    visibility: visibilityFromString(form.visibility),
  };
  if (emailChanged) patch.email = form.email;
  if (nextStatus !== null && nextStatus !== user.status) patch.status = nextStatus;
  await db.update(users).set(patch).where(eq(users.id, user.id));

  // --- the reset-2FA arm (users.go:551-556 → DisableTwoFactor,
  // twofactor.go:199-208): the TOTP row dies; the WebAuthn half has no
  // landed store (the module header).
  if (form.reset2fa) {
    await db.delete(twoFactor).where(eq(twoFactor.userId, user.id));
  }

  return { outcome: "updated" };
}

// ---------------------------------------------------------------------------
// The render (edit.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The re-render's model (RenderWithErrDeprecated's posture): the FRESH row
 *  + the banner text (null = pristine GET) + the flagged field. */
export interface AdminUserEditRenderData extends AdminUserEditData {
  error: string | null;
  errorField: AdminUserEditErrorField | null;
  /** The shell's Integrations gate (the AdminUsersData convention — the
   *  route threads `oauth2FeatureEnabled(c.env)`). Absent/true = enabled. */
  oauth2Enabled?: boolean;
}

/** One field div's class (edit.tmpl's `{{if .Err_X}}error{{end}}` hooks). */
function fieldClass(field: AdminUserEditErrorField | null, mine: AdminUserEditErrorField, base: string): string {
  return field === mine ? `${base} error` : base;
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminUserEditPage(ctx: UiContext, data: AdminUserEditRenderData): string {
  return renderPage(<AdminUserEditPage ctx={ctx} data={data} />);
}

/** The admin user edit page (§2.4.1 discriminator: layout_head's
 *  `admin edit user`, edit.tmpl:1). */
export function AdminUserEditPage(props: { ctx: UiContext; data: AdminUserEditRenderData }) {
  const { ctx, data } = props;
  const user = data.user;
  const link = adminUserLink(user.id);
  const prohibited = user.status === "prohibited";
  const isSelf = ctx.viewer.kind === "user" && ctx.viewer.id === user.id;
  const err = data.errorField;
  return (
    <AdminFamilyShell ctx={ctx} title={adminUserEditLocale.edit_account} pageClass="admin edit user" active="users" oauth2Enabled={data.oauth2Enabled}>
      {data.error !== null ? (
        <div class="ui negative message">
          <p>{data.error}</p>
        </div>
      ) : null}

      <h4 class="ui top attached header">{adminUserEditLocale.edit_account}</h4>
      <div class="ui attached segment">
        <form class="ui form" action={`${link}/edit`} method="post">
          {/* user_name (:9-12) — the rename field. */}
          <div class={fieldClass(err, "userName", "field")}>
            <label for="user_name">{adminUserEditLocale.username}</label>
            <input id="user_name" name="user_name" value={user.username} maxlength={40} />
          </div>
          {/* user_type (:13-26) — the CanConvertUserType gate. */}
          {data.canConvertUserType ? (
            <div class="required field">
              <label for="user_type">{adminUsersLocale.user_type}</label>
              <select id="user_type" name="user_type" class="ui selection dropdown">
                <option value="User" selected>
                  {adminUsersLocale.user_type_user}
                </option>
                <option value="Bot">{adminUsersLocale.user_type_bot}</option>
              </select>
            </div>
          ) : null}
          {/* login_type (:27-44) — Local + the landed sources; the posted
              value is the accepted-and-ignored set. */}
          <div class={fieldClass(err, "loginType", "required js-non-bot field")}>
            <label for="login_type">{adminUserEditLocale.auth_source}</label>
            <select id="login_type" name="login_type" class="ui selection dropdown">
              <option value="0-0" selected>
                {adminUsersLocale.local}
              </option>
              {data.sources.map((source) => (
                <option value={`${source.type}-${source.id}`}>{source.name}</option>
              ))}
            </select>
          </div>
          {/* visibility (:46-68) — the required dropdown, upstream's 0/1/2
              wire values. */}
          <div class={fieldClass(err, "visibility", "required field")}>
            <label for="visibility">{adminUserEditLocale.visibility}</label>
            <select id="visibility" name="visibility" class="ui selection dropdown">
              <option value="0" selected={user.visibility === "public"}>
                {adminUserEditLocale.visibility_public}
              </option>
              <option value="1" selected={user.visibility === "limited"}>
                {adminUserEditLocale.visibility_limited}
              </option>
              <option value="2" selected={user.visibility === "private"}>
                {adminUserEditLocale.visibility_private}
              </option>
            </select>
          </div>
          {/* login_name (:70-73) — hidden exactly like upstream's
              LoginSource-0 arm (every row is source 0). */}
          <div class="required js-non-local js-non-bot field tw-hidden">
            <label for="login_name">{adminUserEditLocale.auth_login_name}</label>
            <input id="login_name" name="login_name" value="" />
          </div>
          {/* full_name (:74-77). */}
          <div class="field">
            <label for="full_name">{adminUserEditLocale.full_name}</label>
            <input id="full_name" name="full_name" value={user.fullName ?? ""} maxlength={100} />
          </div>
          {/* email (:78-81). */}
          <div class={fieldClass(err, "email", "required field")}>
            <label for="email">{adminUserEditLocale.email}</label>
            <input id="email" name="email" type="email" value={user.email ?? ""} required />
          </div>
          {/* password (:82-88) — form parity, accepted-and-ignored; never
              echoes (no value attr upstream). */}
          <div class="js-local js-non-bot field">
            <label for="password">{adminUserEditLocale.password}</label>
            <input id="password" name="password" type="password" autocomplete="new-password" />
            <p class="help">{adminUserEditLocale.password_helper}</p>
          </div>

          {/* The language field (:90-102) is DROPPED — no column, no
              contract field (the module header). */}

          {/* website (:104-107). */}
          <div class="field">
            <label for="website">{adminUserEditLocale.website}</label>
            <input
              id="website"
              name="website"
              type="url"
              value={user.website ?? ""}
              placeholder="http://mydomain.com or https://mydomain.com"
              maxlength={255}
            />
          </div>
          {/* location (:108-111). */}
          <div class="field">
            <label for="location">{adminUserEditLocale.location}</label>
            <input id="location" name="location" value={user.location ?? ""} maxlength={50} />
          </div>

          <div class="divider"></div>

          {/* max_repo_creation (:115-119) — upstream's fresh-row default
              -1; accepted-and-ignored. */}
          <div class={fieldClass(err, "maxRepoCreation", "inline field")}>
            <label for="max_repo_creation">{adminUserEditLocale.max_repo_creation}</label>
            <input id="max_repo_creation" name="max_repo_creation" type="number" min={-1} value={-1} />
            <p class="help">{adminUserEditLocale.max_repo_creation_desc}</p>
          </div>

          <div class="divider"></div>

          {/* The checkbox block (:123-168): active; prohibit_login
              (disabled for self, :132); admin; restricted (the
              constant-false store); allow_git_hook + allow_import_local
              hidden+disabled (the DEFAULT-config render — DisableGitHooks
              true, ImportLocalPaths false, the module header);
              allow_create_organization (checked iff isAdmin). */}
          <div class="inline field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.is_activated}</strong>
              </label>
              <input name="active" type="checkbox" checked={user.status === "active"} />
            </div>
          </div>
          <div class="inline field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.prohibit_login}</strong>
              </label>
              <input name="prohibit_login" type="checkbox" checked={prohibited} disabled={isSelf} />
            </div>
          </div>
          <div class="inline field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.is_admin}</strong>
              </label>
              <input name="admin" type="checkbox" checked={user.isAdmin} />
            </div>
          </div>
          <div class="inline field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.is_restricted}</strong>
              </label>
              <input name="restricted" type="checkbox" />
            </div>
          </div>
          <div class="inline field tw-hidden">
            <div class="ui checkbox" data-tooltip-content={adminUserEditLocale.allow_git_hook_tooltip}>
              <label>
                <strong>{adminUserEditLocale.allow_git_hook}</strong>
              </label>
              <input name="allow_git_hook" type="checkbox" disabled />
            </div>
          </div>
          <div class="inline field tw-hidden">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.allow_import_local}</strong>
              </label>
              <input name="allow_import_local" type="checkbox" disabled />
            </div>
          </div>
          <div class="inline field">
            <div class="ui checkbox">
              <label>
                <strong>{adminUserEditLocale.allow_create_organization}</strong>
              </label>
              <input name="allow_create_organization" type="checkbox" checked={user.isAdmin} />
            </div>
          </div>

          {/* reset_2fa (:170-178) — the TwoFactorEnabled gate. */}
          {data.twoFactorEnabled ? (
            <>
              <div class="divider"></div>
              <div class="inline field">
                <div class="ui checkbox">
                  <label>
                    <strong>{adminUserEditLocale.reset_2fa}</strong>
                  </label>
                  <input name="reset_2fa" type="checkbox" />
                </div>
              </div>
            </>
          ) : null}

          <div class="divider"></div>

          <div class="field">
            <button type="submit" class="ui primary button">
              {adminUserEditLocale.update_profile}
            </button>
            {/* The DELETE-ACCOUNT button + #delete-user-modal (:184, :226-244)
                are OMITTED — POST ./delete is unlanded (the dead-control
                rule, the module header). */}
          </div>
        </form>
      </div>

      {/* THE AVATAR SECTION (:189-225) — upstream hosts it HERE; the landed
          org-settings reduction's twin (the detail page's temporary fold is
          the orchestrator's re-fold, the module header). */}
      <h4 class="ui top attached header">{adminUserEditLocale.avatar_section}</h4>
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
    </AdminFamilyShell>
  );
}

/** The unknown-id redirect target — re-exported so the handler glue imports
 *  the pair from one module (the detail page's posture). */
export { ADMIN_USERS_LIST_LINK };
