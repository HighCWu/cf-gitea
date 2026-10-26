/**
 * The user settings ORGANIZATIONS page — the bench-row UNMOUNTED module
 * (pages wave 58; a sibling owns `index.ts`, this module ships without a
 * route): upstream `templates/user/settings/organizations.tmpl` at the pin,
 * served by `user_setting.Organization` (routers/web/user/setting/
 * profile.go:194–224) behind `m.Get("/organization", …)` (web.go:740 — the
 * PATH is singular, the template filename plural).
 *
 * ## Brief-premise verification (verify-at-the-pin)
 *
 * `organizations.tmpl` EXISTS at the pin (`fc4936884584`) and renders exactly
 * four pieces: the `settings.orgs` header with the New Organization button
 * gated on `SignedUser.CanCreateOrganization`, the `.Orgs` membership list
 * (avatar 28 "mini", the `shared/user/name` link, the description, the
 * leave button), `base/paginate`, and the `settings.orgs_none` empty state —
 * plus the `#leave-organization` confirm modal. The brief's "org visibility"
 * guess is NOT on this surface: the membership-visibility flips are the
 * members page's `/members/action/{private|public}` arms (routers/web/org/
 * members.go:99–108 — the wave-23 org-members header documents that write
 * family as out of inventory), and the org's own profile visibility lives in
 * org settings. Nothing here writes visibility.
 *
 * ## Data (§3.2 — the landed reads, never a self-fetch)
 *
 * The GET's `FindOrgOptions{UserID: doer.ID, IncludeVisibility:
 * structs.VisibleTypePrivate}` + `setting.UI.Admin.UserPagingNum` = 50
 * (modules/setting/ui.go:138) is exactly the LANDED `GET /user/orgs` self-list
 * arm (routes/org-repos.ts:158–171): `OrgService.listUserOrgs(doer.id, …)`
 * with the service-default `'private'` ceiling — every membership listed,
 * non-public ones included (org_list.go:57–63 via
 * `queryUserOrgIDs(uid, includePrivate)`; the route's own comment). The
 * pager follows base/paginate's Newer/Older pair (the org-members pattern).
 *
 * ## Write arms (§3.2 — the landed services)
 *
 * - LEAVE: upstream's leave button opens `#leave-organization` and its
 *   form-fetch-action POSTs `{OrganisationLink}/members/action/leave?uid={id}`
 *   → `MembersAction` case "leave" (members.go:115–121) →
 *   `org_service.RemoveOrgUser(org, ctx.Doer)`; success flashes
 *   `form.organization_leave_success` and `JSONRedirect`s onto AppSubUrl+"/"
 *   (HOME, not back to settings), `ErrLastOrgOwner` becomes the
 *   `form.last_org_owner` JSONError. The write seam is LANDED:
 *   `OrgService.removeMember` (services/orgs/orgs.ts:815) is RemoveOrgUser's
 *   exact port — the pre-batch non-member no-op, the race-proof last-owner
 *   guard, the `num_members` decrement, the typed `LastOrgOwnerError`. This
 *   module's POST arm re-plays that seam; the uid field rides the form
 *   (upstream's `?uid=` query param) but is ACCEPTED-AND-IGNORED exactly as
 *   upstream's leave case is (members.go fetches `uid` then leaves
 *   `ctx.Doer`), so the arm is self-scoped by construction.
 * - The upstream `show-modal` button + `<dialog>` chrome is JS-only — the
 *   no-JS faithful port renders the confirm as a `<details>` disclosure
 *   wrapping the same form (the org-settings danger-row reduction, pages/
 *   org-settings.tsx:589–603); every control stays live.
 * - NOT rendered (no dead controls): the modal's
 *   `form-fetch-action`/JSONRedirect plumbing (a form POST + 303 carries the
 *   same semantics server-side) and the `data-modal-organization-name` span
 *   fill (the name is rendered into the disclosure text directly).
 *
 * ## Handoff note (for the `index.ts` window owner — this module has NO
 *    route; the wave-12 userSettingsPage/userSettingsSubmit pair,
 *    ui/index.ts:3838–3873, is the handler template)
 *
 *   GET  /user/settings/organization  resolveUiSession → anonymous
 *                                     loginRedirect (upstream reqSignIn,
 *                                     web.go:735's group) →
 *                                     loadUserOrgsSettings(d1, viewer.id,
 *                                     url.searchParams) →
 *                                     renderUserOrgsSettingsPage(ctx, data,
 *                                     { error: url.searchParams.get("error")
 *                                     === "last-owner" ? "last-owner" : null })
 *   POST /user/settings/organization/leave
 *                                     sameOriginGuard FIRST (the §2.8
 *                                     layer-2 check, the wave-12 POST's
 *                                     order) → the same session→gate
 *                                     prologue →
 *                                     parseUserOrgsLeaveForm(
 *                                     readUrlEncodedForm(c.req.raw)) →
 *                                     applyUserOrgsLeave(d1, viewer.id,
 *                                     form) → outcome dispatch:
 *                                     "left" → 303 onto "/" (upstream's
 *                                     JSONRedirect target — the home page
 *                                     carries no flash plumbing, so no
 *                                     success line renders);
 *                                     "not-a-member" → 303 onto
 *                                     `/user/settings/organization` (the
 *                                     silent no-op — upstream RemoveOrgUser
 *                                     returns nil → JSONOK);
 *                                     "last-owner" → 303 onto
 *                                     `/user/settings/organization?error=
 *                                     last-owner` (the JSONError text via
 *                                     the `?error=` flash reduction — no
 *                                     session-flash plumbing exists).
 *
 * Mount also folds the local `UserOrgsSettingsNav` below into the settings
 * navbar the wave-12 page owns (and the keys/secrets/security/applications
 * siblings are scaffolding the same way): extend that nav with the
 * Organizations item keyed on the `user settings organization` discriminator
 * and delete this module's scaffold. Survey row to touch on landing:
 * docs/compat/ui-parity-survey.md:383 (the
 * `/user/settings/{…,organization,…}` ABSENT row).
 */

import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { parsePageNumber } from "../page-data";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { LastOrgOwnerError } from "../../services/orgs/errors";
import { userSettingsLocale } from "./user-settings";

/** Page chrome text (component-local, the settingsLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale_en-US keys cited). */
export const userOrgsSettingsLocale = {
  organization: "Organizations", // "settings.organization" (title + navbar item)
  orgs: "Manage Organizations", // "settings.orgs" (the header)
  new_orga: "New Organization", // "admin.orgs.new_orga" (the header button)
  orgs_none: "You are not a member of any organizations.", // "settings.orgs_none"
  leave: "Leave", // "org.members.leave"
  leave_detail_prefix: "Leave ", // "org.members.leave.detail" = "Leave %s?" —
  leave_detail_suffix: "?", //   the %s is the org display name, rendered inline
  last_org_owner:
    "You cannot remove the last user from the 'owners' team. There must be at least one owner for an organization.", // "form.last_org_owner"
} as const;

/** Upstream `setting.UI.Admin.UserPagingNum` (modules/setting/ui.go:138) —
 *  the page's list ceiling (profile.go:200). */
export const USER_ORGS_PAGE_SIZE = 50;

/** The page render inputs: one page of the self-list plus the pager state
 *  (the org-members Data shape, over the GET /user/orgs read). */
export interface UserOrgsSettingsData {
  orgs: OrgRecord[];
  page: number;
  more: boolean;
}

/**
 * Load the page (§3.2 — the landed GET /user/orgs self-list read,
 * routes/org-repos.ts:158–171, at the page's own page param): the service
 * default `'private'` ceiling lists EVERY membership (upstream
 * `IncludeVisibility: private`), ordered by username_lower, paged at 50.
 */
export async function loadUserOrgsSettings(
  d1: D1Database,
  userId: number,
  params: URLSearchParams,
): Promise<UserOrgsSettingsData> {
  const page = parsePageNumber(params.get("page"));
  const { items, total } = await new OrgService(d1).listUserOrgs(userId, { page, pageSize: USER_ORGS_PAGE_SIZE });
  return { orgs: items, page, more: page * USER_ORGS_PAGE_SIZE < total };
}

/** The leave form's fields (upstream `?uid=` query param + the
 *  OrganisationLink path segment, as form fields). */
export interface UserOrgsLeaveForm {
  /** Upstream members.go:85 fetches it — the leave case then removes
   *  `ctx.Doer`, so the value is accepted-and-ignored (the module header). */
  uid: number;
  /** The org to leave (upstream's URL path segment). */
  org: string;
}

export function parseUserOrgsLeaveForm(params: URLSearchParams): UserOrgsLeaveForm {
  const rawUid = params.get("uid") ?? "";
  return {
    uid: /^\d+$/.test(rawUid) ? Number.parseInt(rawUid, 10) : 0,
    org: params.get("org") ?? "",
  };
}

export type UserOrgsLeaveOutcome =
  /** Removed — upstream's success arm (flash + JSONRedirect home). */
  | { outcome: "left" }
  /** Missing org row (upstream's OrgAssignment would 404 first) or the doer
   *  holds no membership — RemoveOrgUser's silent no-op. */
  | { outcome: "not-a-member" }
  /** The §4.3 last-owner guard — upstream's form.last_org_owner JSONError. */
  | { outcome: "last-owner" };

/**
 * The leave write — `MembersAction` case "leave" (members.go:115–121) over
 * the LANDED seam: resolve the org row (`getOrgByUsername` — a missing org is
 * the not-a-member posture; upstream's OrgAssignment 404s before the
 * handler), then `OrgService.removeMember(org.id, viewer.id)` —
 * RemoveOrgUser's exact port (the non-member no-op, the race-proof
 * last-owner guard, the num_members batch). The form's uid is
 * accepted-and-ignored (the module header) — the removed row is always the
 * viewer's own membership.
 */
export async function applyUserOrgsLeave(d1: D1Database, viewerId: number, form: UserOrgsLeaveForm): Promise<UserOrgsLeaveOutcome> {
  const org = await new OrgService(d1).getOrgByUsername(form.org);
  if (org === null) return { outcome: "not-a-member" };
  try {
    const removed = await new OrgService(d1).removeMember(org.id, viewerId);
    return removed ? { outcome: "left" } : { outcome: "not-a-member" };
  } catch (error) {
    if (error instanceof LastOrgOwnerError) return { outcome: "last-owner" };
    throw error;
  }
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderUserOrgsSettingsPage(
  ctx: UiContext,
  data: UserOrgsSettingsData,
  state: { error: "last-owner" | null },
): string {
  return renderPage(<UserOrgsSettingsPage ctx={ctx} data={data} error={state.error} />);
}

/**
 * The settings navbar with the Organizations item — MOUNT SCAFFOLDING ONLY
 * (the handoff note): the wave-12 settings nav DOM (pages/user-settings.tsx)
 * with the Organizations item appended and active. The header + Profile
 * texts import the owner's locale object; when the index.ts window folds the
 * settings siblings into one navbar, delete this component.
 */
export function UserOrgsSettingsNav() {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{userSettingsLocale.settings}</div>
        <a class="item" href="/user/settings">
          {userSettingsLocale.profile}
        </a>
        <a class="active item" href="/user/settings/organization">
          {userOrgsSettingsLocale.organization}
        </a>
      </div>
    </div>
  );
}

/** The leave confirm (organizations.tmpl:41-51's `#leave-organization`
 *  dialog reduced to a `<details>` disclosure wrapping the same form — the
 *  org-settings danger-row reduction; the org's display name renders inline
 *  where upstream's JS fills the `organization-name` span, while the hidden
 *  `org` field carries the username — upstream's OrganisationLink path
 *  segment). */
function LeaveDisclosure(props: { orgUsername: string; orgDisplayName: string; uid: number }) {
  return (
    <details class="ui basic red button tw-p-0">
      <summary class="tw-p-2">{userOrgsSettingsLocale.leave}</summary>
      <div class="ui attached segment tw-text-left">
        <form action="/user/settings/organization/leave" method="post">
          {/* upstream's ?uid={SignedUser.ID} query param + the
              OrganisationLink path segment, as form fields */}
          <input type="hidden" name="uid" value={props.uid} />
          <input type="hidden" name="org" value={props.orgUsername} />
          <p>
            {userOrgsSettingsLocale.leave_detail_prefix}
            {props.orgDisplayName}
            {userOrgsSettingsLocale.leave_detail_suffix}
          </p>
          <button type="submit" class="ui red button">
            {userOrgsSettingsLocale.leave}
          </button>
        </form>
      </div>
    </details>
  );
}

/**
 * The organizations settings page (§2.4.1 discriminator: `user settings
 * organization` — layout_head's pageClass dict, organizations.tmpl:1).
 */
export function UserOrgsSettingsPage(props: { ctx: UiContext; data: UserOrgsSettingsData; error: "last-owner" | null }) {
  const { ctx, data } = props;
  if (ctx.viewer.kind !== "user") throw new Error("UserOrgsSettingsPage requires a signed-in viewer");
  // Captured post-guard — narrowing does not reach the JSX callbacks below.
  const viewerId = ctx.viewer.id;
  const basePath = "/user/settings/organization";
  const pageHref = (target: number): string => `${basePath}?page=${target}`;
  return (
    <BaseLayout ctx={ctx} title={userOrgsSettingsLocale.organization} pageClass="user settings organization">
      <div class="ui container flex-container">
        <UserOrgsSettingsNav />
        <div class="flex-container-main">
          {props.error === "last-owner" ? <div class="ui negative message">{userOrgsSettingsLocale.last_org_owner}</div> : null}
          <div class="user-setting-content">
            {/* organizations.tmpl:3-10 — the header + New Organization button.
                The CanCreateOrganization gate (`IsAdmin ||
                AllowCreateOrganization && !DisableRegularOrgCreation`,
                user.go:301-303) is unreachable at the landed tier — both
                settings default open with no allow-create column (the POST
                /orgs route header, routes/orgs.ts:69-75; the org-create page
                header) — so the button renders for every signed-in viewer. */}
            <h4 class="ui top attached header">
              {userOrgsSettingsLocale.orgs}
              <div class="ui right">
                <a class="ui primary tiny button" href="/org/create">
                  {userOrgsSettingsLocale.new_orga}
                </a>
              </div>
            </h4>
            <div class="ui attached segment orgs">
              {data.orgs.length === 0 ? (
                userOrgsSettingsLocale.orgs_none
              ) : (
                <>
                  <div class="flex-divided-list items-with-main">
                    {data.orgs.map((org) => (
                      <div class="item">
                        <div class="item-leading">
                          {/* organizations.tmpl:17's avatar 28 "mini" — the
                              avatar pipeline does not exist (the org-members
                              avatar-slot rule); the glyph stands in, the name
                              link carries the navigation. */}
                          <Icon name="octicon-person" size={28} />
                        </div>
                        <div class="item-main">
                          <div class="item-title">
                            {/* shared/user/name.tmpl: the muted HomeLink
                                anchor with DisplayNameWithFullName — the org
                                row's fullName-or-username (orgDisplayName). */}
                            <a class="text muted" href={`/${org.username}`}>
                              {org.fullName !== null && org.fullName !== "" ? org.fullName : org.username}
                            </a>
                          </div>
                          <div class="flex-text-body">{org.description ?? ""}</div>
                        </div>
                        <div class="item-trailing">
                          <LeaveDisclosure
                            orgUsername={org.username}
                            orgDisplayName={org.fullName !== null && org.fullName !== "" ? org.fullName : org.username}
                            uid={viewerId}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  {data.page > 1 || data.more ? (
                    <div class="center page buttons">
                      <div class="ui borderless pagination menu">
                        {data.page > 1 ? (
                          <a class="item navigation" href={pageHref(data.page - 1)}>
                            <span class="navigation_label">Newer</span>
                          </a>
                        ) : null}
                        {data.more ? (
                          <a class="item navigation" href={pageHref(data.page + 1)}>
                            <span class="navigation_label">Older</span>
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
