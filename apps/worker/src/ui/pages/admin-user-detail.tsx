/**
 * The ADMIN USER DETAIL page — `/-/admin/users/{userid}` — census gap #18's
 * NOTE arm and the 2a00e28 handoff: upstream web.go:817's
 * `m.Get("/{userid}", admin.ViewUser)` inside the `/-/admin/users` group,
 * served by `admin.ViewUser` (routers/web/admin/users.go:313-362) through
 * `prepareUserInfo` (:269-281) and rendered by templates/admin/user/
 * view.tmpl + admin/user/{view_details,view_emails,view_orgs}.tmpl.
 * PORT-FIRST: the module owns the load + render; the route lives behind the
 * orchestrator's index.ts fold (the mount recipe at the bottom). The landed
 * admin-users-avatar.ts write pair (web.go:820-821's POST
 * `/{userid}/avatar[ /delete]` seams, port-first at 2a00e28) REDIRECTS onto
 * this page — until this render lands, the pair's target 404s; the avatar
 * FORMS fold into this page's render through those seams (below).
 *
 * ## The unknown-id arm (prepareUserInfo, users.go:268-277)
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
 *     Impersonate button + Edit link against the LIVE targets
 *     (view.tmpl:6-11): the impersonate POST `/{id}/impersonate` is landed
 *     (admin-users-impersonate.ts, migration 0058 — its upstream
 *     `link-action data-url` JS dialect reduces to the no-JS form POST, the
 *     house convention; the success arm 303s onto /user/settings) and the
 *     edit link `/{id}/edit` is the landed admin-user-edit page. The
 *     `{{if not .User.IsTypeBot}}` guard is LIVE since B-72 (the
 *     users.type 'bot' value): a bot row renders NO impersonate button
 *     (the write seam refuses besides — B-72 handoff 3). The no-JS form is
 *     rendered in upstream's flex-text-block span beside the Edit anchor.
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
 *   - THE BOT ACCESS-TOKENS PANEL (view.tmpl:28-29 — LANDED, the B-72
 *     handoff (4) close-out; the former "unproducible" note is history —
 *     `users.type` carries 'bot' since B-72): ViewUser's `u.IsTypeBot()`
 *     gate (users.go:354-358 at the pin) feeds `.BotAccessTokens` =
 *     user_setting.NewAccessTokensPanel (applications.go:47-66) and the
 *     shared access_tokens.tmpl renders it — the
 *     `admin.users.bot_token_desc` lead line (:17) and, since 365cb2bd5e,
 *     the per-row Regenerate button (:51-54) and the regenerate confirm
 *     modal (:113-121) are UNCONDITIONAL (the former `{{if not $.IsBot}}`
 *     wraps are history — bot tokens are admin-managed, so the button
 *     renders here too; the modal drops in the render, the settings
 *     reduction). Rendered here ONLY for
 *     type=bot targets: the loader answers `botTokens: null` otherwise
 *     (the `{{if .BotAccessTokens}}` gate), so a user/org row carries no
 *     panel and no token read. The scope table drops the `admin` category
 *     unless the OWNER is a site admin (applications.go:66-68 keys on
 *     `owner.IsAdmin` — the BOT row's flag, never the viewing admin's).
 *     The panel's link is upstream's `ctx.Link + "/access_tokens"`
 *     (users.go:355).
 *   - THE BOT-TOKEN WRITE TRIO (web.go:791-793 at the pin, the panel's only
 *     arms): POST `/{userid}/access_tokens` (admin.NewBotTokenPost →
 *     user_setting.CreateAccessToken, applications.go:67-146), POST
 *     `/{userid}/access_tokens/delete` (admin.DeleteBotToken →
 *     user_setting.DeleteAccessToken, :155-170) and — since 365cb2bd5e —
 *     POST `/{userid}/access_tokens/regenerate` (admin.RegenerateBotToken →
 *     user_setting.RegenerateAccessToken(ctx, u), :176-187), all behind
 *     getTargetBot (users.go:365-375 at the pin): GetUserByID's miss is
 *     ServerError (500 — NOT prepareUserInfo's list redirect, the trio does
 *     its own lookup) and a NON-bot target answers JSONError
 *     `admin.users.bot_token_only` (400, the impersonate arm's
 *     buildJsonErrorMap convention) — the arms serve BOTS ONLY, an accepted
 *     POST against a user/org row is REFUSED, never accept-and-ignore
 *     (other accounts manage their own tokens on
 *     /user/settings/applications). The machinery is the EXISTING token
 *     service — `TokenService.mint`/`revoke`, the settings page's
 *     `regenerateTokenFromForm` (the ONE store path for regeneration) +
 *     `emitAccessTokenAudit`, the account-aggregates API arm's exact pair
 *     (routes/account-aggregates.ts userCreateToken/userDeleteAccessToken)
 *     — never a duplicate store path. The audit rows carry owner = THE BOT
 *     and actor = THE CALLING ADMIN (upstream audit.Record's doer over
 *     `owner`, applications.go:133/:162/:182 — the API twin's pinned
 *     shape), the reason the seams thread the explicit actor rather than
 *     ride the settings page's createTokenFromForm (whose actor IS its
 *     owner); the regenerate row is the pin's `user:accesstoken:regenerate`
 *     with vars {token: the name}. Reductions — the settings page's
 *     adjudicated conventions for the SAME shared template
 *     (user-settings-applications.tsx's module header):
 *       * the mint answers the FULL page re-rendered with the one-time
 *         plaintext in `<code id="new-access-token-value">` (upstream
 *         renders only the tplAccessTokens fragment with NewTokenValue for
 *         the form-fetch-action swap, applications.go:139-145; SPEC-0002 §3
 *         never stores the plaintext — it exists in this one response);
 *       * an invalid mint (the Required/MaxSize binder arms,
 *         `settings.at_least_one_permission`,
 *         `settings.generate_token_name_duplicate`) re-renders with the
 *         negative line + the kept name (upstream's JSONError arms);
 *       * the revoke 303s back HERE (JSONRedirect("")'s reduction, the
 *         B-71 arms' posture); a stale id 303s silently — upstream's
 *         flash-error arm carries the Go error string
 *         ("GetAccessTokenByID: …"), no renderable analog;
 *       * the regenerate mirrors the settings page's F10 arm (its upstream
 *         is the SAME RegenerateAccessToken, applications.go:176-187):
 *         a hit re-renders the FULL page with the fresh plaintext in the
 *         mint slot (upstream flashes `settings.generate_token_success` +
 *         the token value, JSONRedirect("") — the no-flash reduction keeps
 *         the one-show posture; the settings page's own adjudicated shape,
 *         index.ts's regenerateTokenFromForm handler); a stale/foreign id
 *         303s silently (upstream's ServerError over the not-found miss —
 *         "access token not found", the family's stale-id posture);
 *       * the copy button, the delete confirm dialog and the gt-checkbox
 *         styling reduce exactly as on the settings page.
 *     The doer-token child-scope containment (applications.go:108-126)
 *     needs the doer's token scope in the session identity, which the UI
 *     session does not carry — the documented settings/API divergence (a
 *     session doer mints as a scope-less parent, upstream's own
 *     `hasApiTokenScope == false` arm for a cookie session).
 *   - Repositories: "Repositories (Total: N)" + the SHARED repo list rows —
 *     pages/org-home.tsx's OrgRepoListItem (the shared/repo/list.tmpl row
 *     component, this page is exactly upstream's shared/repo/list
 *     consumer): every repo the target OWNS (upstream SearchRepository
 *     OwnerID + Private:true + Collaborate:false, users.go:329-339 — no
 *     collaboration rows, no visibility filter on the admin view),
 *     slug-ASC (upstream db.SearchOrderByAlphabetically), the batched
 *     description read (the org-home loader's pattern).
 *   - view_orgs: "Organizations (Total: N)" + the membership rows — the
 *     placeholder avatar glyph (the org-home avatar-slot rule), the name
 *     link, the Private badge on private orgs, the "Joined on" date line
 *     (DateUtils.AbsoluteShort — formatAdminDate). THE REMOVE ARMS (the
 *     census B-71 pair, web.go:824-825): the Remove All button opens the
 *     remove-all-orgs-modal upstream (view_orgs.tmpl:7-21) and the per-org
 *     Remove button is a link-action with the confirm modal
 *     (view_orgs.tmpl:47-49) — the no-JS reduction posts the same paths
 *     plain (`{link}/orgs/remove-all` and `{link}/orgs/{orgId}/remove`, the
 *     landed index.ts families "admin-user-orgs-remove-all" /
 *     "admin-user-org-remove"; the JS-dialect classes and the confirm
 *     dialogs drop, the impersonate button's reduction). The refusal /
 *     success flashes ride upstream's JSONRedirect("") — the no-session-flash
 *     reduction 303s onto this page (the arms' handler notes). The listing
 *     is the landed `OrgService.listUserOrgs` (the GET /user/orgs read,
 *     maxVisibility "private" — the admin sees every membership upstream's
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
 * 5. The bot-token write trio (web.go:791-793 at the pin — the SAME users
 *    group; the third arm is 365cb2bd5e's regenerate):
 *    `UiRoute` gains `admin-user-bot-token` + `admin-user-bot-token-delete`
 *    + `admin-user-bot-token-regenerate` (the `adminUserId` payload),
 *    claimed in the tail parse beside the avatar pair in upstream's route
 *    order (`handlesUiRoute` gates the dispatcher on the parse — an
 *    unclaimed POST never reaches uiRouter):
 *
 *      tail.length === 3 && tail[2] === "access_tokens"            → the mint
 *      tail.length === 4 && tail[2] === "access_tokens"
 *                        && tail[3] === "delete"                   → the revoke
 *      tail.length === 4 && tail[2] === "access_tokens"
 *                        && tail[3] === "regenerate"               → the regen
 *
 *    and registered POST-only (the GET twins answer chi's 405 — the B-71
 *    pair's convention). The handlers are the settings arms' shape: the
 *    §2.8 sameOriginGuard → adminPagePrologue → the seam → the map —
 *    `unknown-target` 500 plain (getTargetBot's ServerError), `refused`
 *    400 JSON `ADMIN_BOT_TOKEN_ONLY_ERROR`, `created`/`invalid` the
 *    re-rendered page at 200 (`withBotTokenMintOutcome` overlays the
 *    one-time plaintext or the error slot onto a FRESH load), `deleted`/
 *    `missing` 303 `adminUserLink(id)`, `regenerated` the re-rendered page
 *    at 200 with the fresh plaintext overlaid (the settings arm's exact
 *    shape, index.ts's regenerateTokenFromForm handler; a stale id
 *    303s `adminUserLink(id)`).
 *
 *    LANDED (the re-pin's REPIN-ROUTES wave, 0a97aed): index.ts claims the
 *    `admin-user-bot-token-regenerate` family and mounts
 *    `adminUserBotTokenRegenerateSubmit` — the gate ladder + the settings
 *    `regenerateTokenFromForm` + the mint-arm re-render, the POST/405 pair.
 *    AUDIT FOLD (recorded, and tightened at the freeze-gate triage): the
 *    seam's OWN emit — owner = the bot, actor = the admin — DUPLICATED the
 *    shared helper's row once REPIN-OAUTH taught `regenerateTokenFromForm`
 *    to emit (two `user:accesstoken:regenerate` writes per regenerate). The
 *    helper now carries the actor override (upstream's admin handler records
 *    ctx.Doer = the calling admin, web.go:791-793; the settings arm keeps
 *    doer = owner, applications.go:182) and the seam rides it — ONE row per
 *    regenerate on both panels.
 */

import { and, asc, eq, inArray , sql} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { AuthToken } from "../../auth/auth-context";
import { TokenNameExistsError, TokenNameTooLongError } from "../../auth/errors";
import { InvalidScopeError, normalizeScope, ScopeSet, scopeStringSlice } from "../../auth/scopes";
import { TokenService } from "../../auth/token-service";
import { emailAddresses, personalAccessTokens, repositories, users } from "../../db/schema";
import { emitAccessTokenAudit } from "../../services/oauth2/audit-arms";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import type { IconName } from "../icons";
import { Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { AdminEmbeddedSvg, AdminFamilyShell, adminUsersLocale, formatAdminDate } from "./admin-users";
import { ADMIN_USERS_LIST_LINK, adminUserLink } from "./admin-users-avatar";
import { OrgRepoListItem } from "./org-home";
import { orgSettingsLocale } from "./org-settings";
import {
  formatTokenDate,
  regenerateTokenFromForm,
  TOKENS_LIST_LIMIT,
  tokenScopeCategories,
  userSettingsApplicationsLocale,
  type TokenListItem,
  type UserSettingsApplicationsForm,
} from "./user-settings-applications";

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
  remove_all: "Remove All", // "remove_all" (view_orgs.tmpl:7 — the B-71 sweep button)
  remove: "Remove", // "remove" (view_orgs.tmpl:49 — the B-71 per-org button)
  avatar_section: "Avatar", // "settings.avatar" (edit.tmpl:190's section header — the fold's title)
  impersonate: "Impersonate", // "admin.users.impersonate" (view.tmpl:8 — the header's POST button)
  edit: "Edit", // "admin.users.edit" (view.tmpl:10 — the header's Edit link)
  // --- the bot access-tokens panel (the B-72 handoff (4) close-out; the
  //     SHARED panel copy — manage_access_token, token_name, the permission
  //     labels … — rides userSettingsApplicationsLocale, the settings page's
  //     const for the SAME shared template) ---
  bot_token_desc: "Bot accounts cannot sign in, so their access tokens are managed here by administrators.", // "admin.users.bot_token_desc" (access_tokens.tmpl:17 — the IsBot lead line)
  bot_token_only: "Access tokens can only be generated for bot accounts here.", // "admin.users.bot_token_only" (users.go:372 — getTargetBot's non-bot refusal)
} as const;

/** getTargetBot's JSONError body (users.go:372 — `ctx.Tr("admin.users.
 *  bot_token_only")` at the pin's en-US locale), rendered under
 *  context.go:276-278's buildJsonErrorMap shape and answered 400 (the
 *  impersonate arm's exact convention — IMPERSONATE_BOT_REFUSED_ERROR's
 *  twin for this pair's shared gate). */
export const ADMIN_BOT_TOKEN_ONLY_ERROR = {
  errorMessage: adminUserDetailLocale.bot_token_only,
  renderFormat: "text",
} as const;

/** Upstream `DisplayNameWithFullName` (models/user/user.go:514-519): the
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

/** The bot access-tokens panel — upstream AccessTokensPanel
 *  (user/setting/applications.go:37-45) with the render projections folded
 *  into TokenListItem (the settings page's row shape, the SAME shared
 *  template). `IsBot` bakes true — the panel renders only for bot targets —
 *  and `ScopePublicOnly` bakes the "public-only" scope literal (the settings
 *  render's value). */
export interface AdminBotTokensPanel {
  /** Upstream `.Link` = `ctx.Link + "/access_tokens"` (ViewUser,
   *  users.go:356) — the generate form's action and the delete rows' POST
   *  target base (`{link}/delete`, the data-url shape folded into the body
   *  field — the settings reduction). */
  link: string;
  tokens: TokenListItem[];
  /** GetAccessTokenCategories' SORTED order minus "admin" unless the OWNER
   *  is a site admin (applications.go:66-68 keys on `owner.IsAdmin` — the
   *  BOT row's flag, never the viewing admin's). */
  scopeCategories: string[];
  /** The minted plaintext, carried exactly once on the mint POST's
   *  re-render (upstream NewTokenValue, applications.go:151). */
  newToken: string | null;
  /** The failed create's message + the kept submission ("" / null on the
   *  plain GET) — the settings page's error-slot reduction. */
  error: string | null;
  formName: string;
}

/** The page's render inputs. */
export interface AdminUserDetailData {
  user: typeof users.$inferSelect;
  emails: AdminUserEmailEntry[];
  emailsTotal: number;
  repos: AdminUserDetailRepo[];
  reposTotal: number;
  orgs: OrgRecord[];
  /** The bot access-tokens panel (view.tmpl:28-29's `{{if
   *  .BotAccessTokens}}`): set ONLY for type=bot targets — ViewUser's
   *  `u.IsTypeBot()` gate (users.go:354-358); a user/org row renders no
   *  panel and takes no token read. */
  botTokens: AdminBotTokensPanel | null;
  /** The shell's Integrations gate (the AdminUsersData convention — the
   *  route threads `oauth2FeatureEnabled(c.env)`). Absent/true = enabled. */
  oauth2Enabled?: boolean;
}

/**
 * ViewUser's data pull (users.go:313-362 over prepareUserInfo): the users
 * row by id (`null` = the LIST-redirect arm, never a 404), the email
 * entries (the synthesized-primary union), the owned repos (slug ASC,
 * no visibility filter — the admin view) with batched descriptions, the
 * org memberships (the landed listUserOrgs, the admin's unfiltered
 * ceiling, capped at MAX_PAGE_SIZE — the module header's reduction), and —
 * for a BOT target only (users.go:354-358's `u.IsTypeBot()` gate) — the
 * access-tokens panel. `now` is the panel's HasRecentActivity clock (the
 * settings loader's fixed-clock parameter).
 */
export async function loadAdminUserDetail(
  d1: D1Database,
  userId: number,
  now: Date = new Date(),
): Promise<Omit<AdminUserDetailData, "oauth2Enabled"> | null> {
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

  // The owned repos (users.go:329-339's SearchRepository: OwnerID,
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
      .select({ repoId: repositories.id, description: sql<string>`coalesce(${repositories.description}, '')` })
      .from(repositories)
      .where(inArray(repositories.id, repoRows.map((row) => row.id)))
      .all();
    for (const row of settings) descriptions.set(row.repoId, row.description);
  }

  // The org memberships (upstream GetUserOrganizations, users.go:360-362):
  // the landed read at the admin's unfiltered ceiling.
  const orgs = await new OrgService(d1).listUserOrgs(user.id, { maxVisibility: "private", page: 1, pageSize: 50 });

  // The bot access-tokens panel (users.go:354-358): ViewUser sets
  // `.BotAccessTokens` ONLY when `u.IsTypeBot()` — every other row answers
  // null (no panel, no token read).
  const botTokens = user.type === "bot" ? await loadAdminBotTokensPanel(d1, user, now) : null;

  return {
    user,
    emails,
    emailsTotal: emails.length,
    repos: repoRows.map((row) => ({ repo: row, description: descriptions.get(row.id) ?? "" })),
    reposTotal: repoRows.length,
    orgs: orgs.items,
    botTokens,
  };
}

// ---------------------------------------------------------------------------
// The bot access-tokens panel + its write pair (ViewUser's
// NewAccessTokensPanel, users.go:354-358 → applications.go:47-66; the POST
// arms web.go:791-793 → users.go:365-394 → applications.go:67-187)
// ---------------------------------------------------------------------------

/** The panel's link (upstream `ctx.Link + "/access_tokens"`, users.go:356). */
export function adminBotTokensLink(userId: number): string {
  return `${adminUserLink(userId)}/access_tokens`;
}

/** One token's render projections — the settings loader's exact map (the
 *  SAME shared template rows, access_tokens.tmpl:19-63): DisplayPublicOnly,
 *  Scope.StringSlice minus the public-only literal, and upstream's AfterLoad
 *  pair HasUsed / HasRecentActivity (access_token.go:38-39 — the 7-day
 *  window) over created/last_used_at. */
function toTokenListItem(token: AuthToken, now: Date): TokenListItem {
  return {
    token,
    publicOnly: ScopeSet.parseLenient(token.scopes).publicOnly,
    scopes: scopeStringSlice(token.scopes).filter((scope) => scope !== "public-only"),
    hasUsed: token.lastUsedAt !== null && token.lastUsedAt.getTime() > token.createdAt.getTime(),
    hasRecentActivity: token.lastUsedAt !== null && token.lastUsedAt.getTime() + 7 * 24 * 60 * 60 * 1000 > now.getTime(),
  };
}

/**
 * NewAccessTokensPanel (applications.go:47-66) for a bot owner: EVERY token
 * of the owner through the landed `TokenService.list` (upstream db.Find —
 * no pagination; TOKENS_LIST_LIMIT is the settings page's render bound),
 * the sorted scope categories minus "admin" unless the OWNER row is a site
 * admin, and the link. The mint/error slots start empty — the POST handler
 * overlays them (`withBotTokenMintOutcome`).
 */
export async function loadAdminBotTokensPanel(
  d1: D1Database,
  owner: Pick<AdminUserDetailData["user"], "id" | "isAdmin">,
  now: Date = new Date(),
): Promise<AdminBotTokensPanel> {
  const page = await new TokenService(d1).list(owner.id, 1, TOKENS_LIST_LIMIT);
  return {
    link: adminBotTokensLink(owner.id),
    tokens: page.tokens.map((token) => toTokenListItem(token, now)),
    scopeCategories: tokenScopeCategories(owner.isAdmin),
    newToken: null,
    error: null,
    formName: "",
  };
}

/** The pair's shared target lookup — getTargetBot (users.go:365-375):
 *  GetUserByID's miss is `unknown-target` (upstream ServerError — the pair
 *  does its OWN lookup, never prepareUserInfo's list redirect) and a
 *  non-bot row is `refused` (JSONError admin.users.bot_token_only — the arm
 *  serves bots only; other accounts manage their own tokens). */
async function loadTargetBot(d1: D1Database, userId: number): Promise<{ id: number } | "unknown-target" | "refused"> {
  const row = await drizzle(d1).select({ id: users.id, type: users.type }).from(users).where(eq(users.id, userId)).get();
  if (row === undefined) return "unknown-target";
  if (row.type !== "bot") return "refused";
  return { id: row.id };
}

/** The acting admin (upstream audit.Record's doer — `ctx.Doer`, the
 *  signed-in admin the prologue resolved) plus the impersonation carry
 *  (event.go:124's Impersonator pair, migration 0058 — the settings PAT
 *  arms' thread). */
export interface AdminBotTokenActor {
  id: number;
  username: string;
  impersonatorUserId?: number | null;
}

/** The mint outcomes the handler maps (the module header's recipe step 5). */
export type AdminBotTokenMintOutcome =
  | { outcome: "created"; plaintext: string }
  | { outcome: "invalid"; message: string; name: string }
  | { outcome: "refused" }
  | { outcome: "unknown-target" };

/**
 * POST /-/admin/users/{userid}/access_tokens — admin.NewBotTokenPost
 * (users.go:378-382) over getTargetBot + user_setting.CreateAccessToken
 * (applications.go:67-146), through the EXISTING token service (the
 * account-aggregates API arm's `TokenService.mint` + `emitAccessTokenAudit`
 * pair — never a second store path).
 *
 * The ladder, upstream's order: the target gate (unknown → refused), the
 * NewAccessTokenForm binder arms (Required / MaxSize(255) — the settings
 * twin's spellings), the `scope-*` join's Normalize (an unknown scope
 * answers the InvalidScopeError message — upstream ServerErrors, unreachable
 * from the rendered radios; the settings twin's posture), the
 * HasPermissionScope gate (`settings.at_least_one_permission`), the
 * duplicate-name arm (`settings.generate_token_name_duplicate`, the
 * <strong> wrapper stripped), the mint FOR THE BOT (`UID: owner.ID`), then
 * the UserAccessTokenAdd audit row — owner = the bot, actor = the calling
 * admin (applications.go:133; the API twin's pinned shape). The plaintext
 * rides the outcome exactly once.
 */
export async function adminUserMintBotToken(
  d1: D1Database,
  actor: AdminBotTokenActor,
  targetUserId: number,
  form: UserSettingsApplicationsForm,
  now: Date = new Date(),
): Promise<AdminBotTokenMintOutcome> {
  const target = await loadTargetBot(d1, targetUserId);
  if (target === "unknown-target") return { outcome: "unknown-target" };
  if (target === "refused") return { outcome: "refused" };

  const invalid = (message: string): AdminBotTokenMintOutcome => ({ outcome: "invalid", message, name: form.name });
  if (form.name === "") return invalid("Name: Required");
  let normalized: string;
  try {
    normalized = normalizeScope(form.scopesRaw);
  } catch (error) {
    if (error instanceof InvalidScopeError) return invalid(error.message);
    throw error;
  }
  if (!ScopeSet.parse(normalized).hasPermissionScope()) {
    return invalid(userSettingsApplicationsLocale.at_least_one_permission);
  }
  let minted: Awaited<ReturnType<TokenService["mint"]>>;
  try {
    minted = await new TokenService(d1).mint({ userId: target.id, name: form.name, scopes: normalized, now });
  } catch (error) {
    if (error instanceof TokenNameExistsError) {
      return invalid(`${form.name} has been used as an application name already. Please use a new one.`);
    }
    if (error instanceof TokenNameTooLongError) return invalid("Name: MaxSize(255)");
    throw error;
  }
  // audit.Record(ctx, audit_model.UserAccessTokenAdd, owner, "token", t.Name,
  // "token_scope", t.Scope) (applications.go:133): the scope is the OWNER
  // (the bot), the actor the DOER (the admin); the write rode a session — no
  // actor credential.
  await emitAccessTokenAudit(d1, {
    userId: target.id,
    tokenName: minted.name,
    tokenScope: minted.scopes,
    verb: "add",
    origin: "ui",
    actor: { id: actor.id, username: actor.username },
    actorCredential: null,
    impersonatorUserId: actor.impersonatorUserId ?? null,
  });
  return { outcome: "created", plaintext: minted.plaintext };
}

/** The revoke outcomes (the handler's map — `deleted` and `missing` both
 *  303 back, upstream's JSONRedirect("") after either flash). */
export type AdminBotTokenRevokeOutcome = "deleted" | "missing" | "refused" | "unknown-target";

/**
 * POST /-/admin/users/{userid}/access_tokens/delete — admin.DeleteBotToken
 * (users.go:384-388) over getTargetBot + user_setting.DeleteAccessToken
 * (applications.go:155-170), through the EXISTING `TokenService.revoke`:
 * the target gate, then GetAccessTokenByID's owner-scoped load (the row's
 * NAME feeds the audit pair; a miss is `missing` with NO audit — upstream's
 * flash-error arm, a stale or foreign id: a token of ANOTHER account never
 * deletes through a bot's panel, the `(id, owner.ID)` key), the delete, then
 * the UserAccessTokenRemove audit row — owner = the bot, actor = the calling
 * admin (applications.go:163).
 */
export async function adminUserRevokeBotToken(
  d1: D1Database,
  actor: AdminBotTokenActor,
  targetUserId: number,
  tokenId: number,
): Promise<AdminBotTokenRevokeOutcome> {
  const target = await loadTargetBot(d1, targetUserId);
  if (target === "unknown-target" || target === "refused") return target;

  const service = new TokenService(d1);
  // GetAccessTokenByID(id, owner.ID) — the owner-scoped (id, uid) load (the
  // row's NAME feeds the audit pair): a miss is `missing` with NO audit —
  // upstream's flash-error arm, a stale or foreign id (a token of ANOTHER
  // account never deletes through a bot's panel).
  const row = await drizzle(d1)
    .select({ id: personalAccessTokens.id, name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, target.id)))
    .get();
  if (row === undefined) return "missing";
  if (!(await service.revoke(target.id, tokenId))) return "missing";
  await emitAccessTokenAudit(d1, {
    userId: target.id,
    tokenName: row.name,
    verb: "remove",
    origin: "ui",
    actor: { id: actor.id, username: actor.username },
    actorCredential: null,
    impersonatorUserId: actor.impersonatorUserId ?? null,
  });
  return "deleted";
}

/** The regenerate outcomes (the handler's map — `regenerated` re-renders the
 *  page with the fresh plaintext, `missing` 303s back, upstream's
 *  ServerError over the not-found miss; `refused`/`unknown-target` as the
 *  trio's gate). */
export type AdminBotTokenRegenerateOutcome =
  | { outcome: "regenerated"; plaintext: string }
  | { outcome: "missing" }
  | { outcome: "refused" }
  | { outcome: "unknown-target" };

/**
 * POST /-/admin/users/{userid}/access_tokens/regenerate — admin.
 * RegenerateBotToken (users.go:390-394, 365cb2bd5e) over getTargetBot +
 * user_setting.RegenerateAccessToken(ctx, u) (applications.go:176-187),
 * through the settings page's `regenerateTokenFromForm` — the ONE
 * regeneration store path (auth_model.RegenerateAccessToken's owner-scoped
 * `(id, uid)` load → new prefix/hash/salt/last-eight over the SAME row,
 * name + scopes + stamps untouched). Upstream's ladder: the target gate,
 * then the regenerate; a miss ("access token not found") is a
 * ServerError — our `missing` outcome 303s (the family's stale-id
 * posture). The hit carries the pin's NEW audit row —
 * `audit.Record(ctx, audit_model.UserAccessTokenRegenerate, owner,
 * "token", t.Name)` (applications.go:182): owner = the bot, actor = the
 * calling admin, the row's NAME (read pre-regenerate; upstream's t is the
 * updated struct whose Name never changes).
 */
export async function adminUserRegenerateBotToken(
  d1: D1Database,
  actor: AdminBotTokenActor,
  targetUserId: number,
  tokenId: number,
): Promise<AdminBotTokenRegenerateOutcome> {
  const target = await loadTargetBot(d1, targetUserId);
  if (target === "unknown-target") return { outcome: "unknown-target" };
  if (target === "refused") return { outcome: "refused" };

  // GetAccessTokenByID(id, owner.ID)'s owner-scoped load — the row's NAME
  // feeds the audit pair; a stale or foreign id is `missing` with NO audit
  // (a token of ANOTHER account never regenerates through a bot's panel).
  const row = await drizzle(d1)
    .select({ id: personalAccessTokens.id, name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, target.id)))
    .get();
  if (row === undefined) return { outcome: "missing" };

  const regenerated = await regenerateTokenFromForm(d1, target.id, tokenId, actor.impersonatorUserId ?? null, {
    id: actor.id,
    username: actor.username,
  });
  if (regenerated.outcome !== "regenerated") return { outcome: "missing" };
  // The audit row rides the shared helper's emit with the ADMIN-actor
  // override (upstream records ctx.Doer = the calling admin on this panel —
  // web.go:791-793; the settings twin keeps doer = owner). The seam's own
  // emit is GONE — it duplicated the helper's row (two
  // user:accesstoken:regenerate writes per regenerate, the freeze-gate
  // catch).
  return { outcome: "regenerated", plaintext: regenerated.plaintext };
}

/**
 * Overlay a mint outcome onto a FRESH load for the POST's re-render — the
 * upstream shape: CreateAccessToken builds a NEW panel after the insert and
 * sets NewTokenValue on it (applications.go:139-145), so the minted row is
 * already in the list beside its one-time plaintext; an invalid outcome
 * carries the negative line + the kept name. `null` = the target stopped
 * being a renderable bot between the write and the reload (deleted or
 * converted mid-flight) — the caller's LIST-redirect belt.
 */
export function withBotTokenMintOutcome(
  data: AdminUserDetailData,
  outcome: Extract<AdminBotTokenMintOutcome, { outcome: "created" | "invalid" }>,
): AdminUserDetailData | null {
  if (data.botTokens === null) return null;
  const botTokens: AdminBotTokensPanel =
    outcome.outcome === "created"
      ? { ...data.botTokens, newToken: outcome.plaintext }
      : { ...data.botTokens, error: outcome.message, formName: outcome.name };
  return { ...data, botTokens };
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

/** The view_orgs block (view_orgs.tmpl — the B-71 remove arms live, the
 *  module header carries the reductions). */
function UserOrgsBlock(props: { userId: number; orgs: OrgRecord[] }) {
  const link = adminUserLink(props.userId);
  return (
    <>
      <h4 class="ui top attached header flex-left-right">
        <span>
          {adminUserDetailLocale.organizations} ({adminUserDetailLocale.total.replace("%d", String(props.orgs.length))})
        </span>
        {props.orgs.length > 0 ? (
          /* view_orgs.tmpl:7-21's show-modal button + remove-all-orgs-modal —
             the no-JS reduction posts the modal form's action plain. */
          <form method="post" action={`${link}/orgs/remove-all`}>
            <button type="submit" class="ui red tiny button">{adminUserDetailLocale.remove_all}</button>
          </form>
        ) : null}
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
                {/* view_orgs.tmpl:46-50's item-trailing Remove (the
                    link-action + data-modal-confirm dialect — the no-JS
                    reduction posts the same URL plain). */}
                <div class="item-trailing">
                  <form method="post" action={`${link}/orgs/${org.id}/remove`}>
                    <button type="submit" class="ui red tiny button">{adminUserDetailLocale.remove}</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The item-leading token glyph — upstream `{{svg "fontawesome-send" 32}}`;
 *  fontawesome-send is outside the generated icon allowlist — octicon-mail
 *  is the documented stand-in (the settings page's TOKEN_ICON seam, the
 *  SAME shared template rows). */
const BOT_TOKEN_ICON: IconName = "octicon-mail";

/**
 * The BotAccessTokens block — shared/user/access_tokens.tmpl at the pin
 * with the bot arms LIVE, the settings page's row-for-row twin (the SAME
 * shared template, its locale const rides along):
 *
 *   - the lead line is `admin.users.bot_token_desc` (:17's IsBot arm);
 *   - the per-row Regenerate button is UNCONDITIONAL since 365cb2bd5e
 *     (:51-54 — the former `{{if not $.IsBot}}` wrap is history; bot tokens
 *     are admin-managed) and posts plain to `{link}/regenerate` with the
 *     hidden `id`; the regenerate confirm dialog (:113-121) drops (the
 *     settings reduction, the delete twin's convention; the desc text rides
 *     the button's title);
 *   - the delete posts plain to `{link}/delete` with the hidden `id`
 *     (the data-url's `?id=` query param folded into the body field); the
 *     confirm dialog (:102-111) drops (the settings reduction);
 *   - the generate form posts plain to the panel `link` (upstream's
 *     form-fetch-action + data-fetch-sync panel swap reduces to this
 *     full-document render); an invalid mint re-renders with the negative
 *     line inside the form + the kept name;
 *   - the minted plaintext renders once in `<code
 *     id="new-access-token-value">` inside the positive message (:6-14) —
 *     the copy button drops (the bundle's clipboard JS).
 */
function BotAccessTokensBlock(props: { panel: AdminBotTokensPanel }) {
  const { panel } = props;
  const L = userSettingsApplicationsLocale;
  return (
    <div id="access-token-panel">
      <h4 class="ui top attached header">{L.manage_access_token}</h4>
      <div class="ui attached segment">
        {panel.newToken !== null ? (
          <div class="ui positive message">
            <div class="flex-text-block tw-justify-center">
              <span>{L.generate_token_success}</span>
              <code id="new-access-token-value">{panel.newToken}</code>
            </div>
          </div>
        ) : null}
        <div class="flex-divided-list items-with-main">
          <div class="item">{adminUserDetailLocale.bot_token_desc}</div>
          {panel.tokens.map((item) => (
            <div class="item" key={item.token.id}>
              <div class="item-leading">
                <span
                  class={item.hasRecentActivity ? "tw-text-green" : undefined}
                  data-tooltip-content={item.hasRecentActivity ? L.token_state_desc : undefined}
                >
                  <Icon name={BOT_TOKEN_ICON} size={32} />
                </span>
              </div>
              <div class="item-main">
                <details>
                  <summary>
                    <span class="item-title">{item.token.name}</span>
                  </summary>
                  <p class="tw-my-1">
                    {L.repo_and_org_access}
                    {": "}
                    {item.publicOnly ? L.permissions_public_only : L.permissions_access_all}
                  </p>
                  <p class="tw-my-1">{L.permissions_list}</p>
                  <ul class="tw-my-1">
                    {item.scopes.map((scope) => (
                      <li key={scope}>{scope}</li>
                    ))}
                  </ul>
                </details>
                <div class="item-body">
                  <i>
                    {L.added_on} {formatTokenDate(item.token.createdAt)} — <Icon name="octicon-info" />
                    {item.hasUsed && item.token.lastUsedAt !== null ? (
                      <>
                        {` ${L.last_used} `}
                        <span class={item.hasRecentActivity ? "tw-text-green" : undefined}>
                          {formatTokenDate(item.token.lastUsedAt)}
                        </span>
                      </>
                    ) : (
                      ` ${L.no_activity}`
                    )}
                  </i>
                </div>
              </div>
              <div class="item-trailing">
                {/* access_tokens.tmpl:51-54 at the pin — the Regenerate
                    button is UNCONDITIONAL since 365cb2bd5e (the former
                    `{{if not $.IsBot}}` wrap is history); the settings
                    page's no-JS form POST reduction (upstream's
                    data-modal-confirm link-action + #regenerate-token
                    dialog, :113-121, drop — the confirm modal's house
                    reduction, the delete twin's convention). Upstream
                    renders octicon-sync. */}
                <form method="post" action={`${panel.link}/regenerate`}>
                  <input type="hidden" name="id" value={String(item.token.id)} />
                  <button
                    type="submit"
                    class="ui tiny button"
                    title={userSettingsApplicationsLocale.access_token_regeneration_desc}
                  >
                    {userSettingsApplicationsLocale.regenerate_token}
                  </button>
                </form>
                <form method="post" action={`${panel.link}/delete`}>
                  <input type="hidden" name="id" value={String(item.token.id)} />
                  <button type="submit" class="ui red tiny button">
                    <Icon name="octicon-trash" />
                    {` ${L.delete_token}`}
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div class="ui bottom attached segment">
        {/* access_tokens.tmpl:67 — open when no tokens exist. */}
        <details open={panel.tokens.length === 0}>
          <summary>
            <h4 class="ui header tw-inline-block tw-my-2">{L.generate_new_token}</h4>
          </summary>
          <form class="ui form" action={panel.link} method="post">
            {panel.error !== null ? <div class="ui negative message">{panel.error}</div> : null}
            <div class="field">
              <label for="name">{L.token_name}</label>
              <input id="name" name="name" required maxlength={255} value={panel.formName} />
            </div>
            <div class="field">
              <div class="tw-my-2">{L.repo_and_org_access}</div>
              <label class="gt-checkbox">
                <input type="radio" name="scope-public-only" value="public-only" /> {L.permissions_public_only}
              </label>
              <label class="gt-checkbox">
                <input type="radio" name="scope-public-only" value="" checked /> {L.permissions_access_all}
              </label>
            </div>
            <div>
              <div class="tw-my-2">
                {L.access_token_desc_lead}{" "}
                <a href="/api/swagger" target="_blank">
                  {L.access_token_desc_api}
                </a>{" "}
                {L.access_token_desc_middle}{" "}
                <a href="https://docs.gitea.com/development/oauth2-provider#scopes" target="_blank">
                  {L.access_token_desc_docs}
                </a>{" "}
                {L.access_token_desc_tail}
              </div>
              <table class="ui table unstackable tw-my-2">
                {panel.scopeCategories.map((category) => (
                  <tr key={category}>
                    <td>{category}</td>
                    <td>
                      <label class="gt-checkbox">
                        <input type="radio" name={`scope-${category}`} value="" checked /> {L.permission_no_access}
                      </label>
                    </td>
                    <td>
                      <label class="gt-checkbox">
                        <input type="radio" name={`scope-${category}`} value={`read:${category}`} /> {L.permission_read}
                      </label>
                    </td>
                    <td>
                      <label class="gt-checkbox">
                        <input type="radio" name={`scope-${category}`} value={`write:${category}`} /> {L.permission_write}
                      </label>
                    </td>
                  </tr>
                ))}
              </table>
            </div>
            <button type="submit" class="ui primary button">
              {L.generate_token}
            </button>
          </form>
        </details>
      </div>
    </div>
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
          {/* The header (view.tmpl:5-13): the Title span + the Impersonate
              button + Edit link against the LIVE targets (the module header —
              the landed impersonate POST's no-JS form reduction inside
              upstream's flex-text-block span, and the landed edit page's
              anchor). The Impersonate button is GATED off for bot rows
              (view.tmpl:9's `{{if not .User.IsTypeBot}}` — live since B-72;
              the write seam's own guard, admin-users-impersonate.ts, backs
              it). No type label renders here — upstream's view_details
              carries only the Admin label (view_details.tmpl:10). */}
          <h4 class="ui top attached header flex-left-right">
            <span>{adminUserDetailLocale.details}</span>
            <span class="flex-text-block">
              {user.type !== "bot" ? (
                <form method="post" action={`${link}/impersonate`}>
                  <button type="submit" class="ui primary compact tiny basic button">
                    {adminUserDetailLocale.impersonate}
                  </button>
                </form>
              ) : null}
              <a class="ui primary compact tiny button" href={`${link}/edit`}>
                {adminUserDetailLocale.edit}
              </a>
            </span>
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

      {/* THE BOT ACCESS-TOKENS PANEL (view.tmpl:28-29's `{{if
          .BotAccessTokens}}` — rendered ONLY for type=bot targets, the
          loader's users.go:354-358 gate; the write trio is the mounted
          access_tokens POST family, the module header's recipe step 5). */}
      {data.botTokens !== null ? <BotAccessTokensBlock panel={data.botTokens} /> : null}

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

      <UserOrgsBlock userId={user.id} orgs={data.orgs} />
    </AdminFamilyShell>
  );
}

/** The unknown-id redirect target (prepareUserInfo, users.go:272) — re-
 *  exported so the handler glue imports the pair from one module. */
export { ADMIN_USERS_LIST_LINK };
