/**
 * The org settings BLOCKED USERS tab — the bench-row module
 * (wave 57; MOUNTED at 4f2805f, window-2b: the route lives in `index.ts`
 * and the navbar item in the shared components/settings-nav — the retired
 * wiring HANDOFF is the mount record at the bottom of this header).
 *
 * ## Upstream surface (at the pin)
 *
 * `routers/web/web.go:1088-1090`'s `/{org}/settings/blocked_users` group —
 * `GET org.BlockedUsers` + `POST web.Bind[*forms.BlockUserForm]`
 * `org.BlockedUsersPost` (routers/web/org/block.go:18-39, both thin shims
 * over `routers/web/shared/user/block.go`: the GET calls
 * `shared_user.BlockedUsers(ctx, ctx.ContextUser)` with the ORG as the
 * blocker; the POST redirects
 * `ctx.ContextUser.OrganisationLink()+"/settings/blocked_users"`) — served
 * through `org/settings/blocked_users.tmpl` (layout_head's
 * `organization settings blocked_users` pageClass wrapping
 * `shared/user/blocked_users.tmpl` in `.org-setting-content`). THE
 * owner/admin family like every org settings page: the group sits inside
 * `context.OrgAssignment(... RequireOwner: true)` (web.go:1092) + reqSignIn
 * — upstream answers a signed-in non-owner with the OrgAssignment NotFound
 * shell and anonymous with the login redirect; the landed
 * `resolveOrgTeamsRequest` prologue serves the identical posture for the
 * whole `/{org}/settings` family.
 *
 * ## Data (§3.2 — the landed blocks family, never a self-fetch)
 *
 * The inventory batch 9 block octet over the `user_blocking` table
 * (migration 0022) — services/blocks.ts + routes/blocks.ts, whose org-scope
 * arms this page rides directly:
 *
 *   read     `listBlockedUsers(d1, org.id, …)` (FindBlockings — the exact
 *            read `GET /orgs/{org}/blocks` serves, blockee rows `id` ASC);
 *   block    `blockUser(d1, doer, {org as blocker}, blockee, note)` — the
 *            org arm of `PUT /orgs/{org}/blocks/{username}`
 *            (routes/blocks.ts:366-383: blocker
 *            `{id: org.id, isOrg: true, isAdmin: false}`, doer = the signed
 *            -in owner; the CanBlockUser gate + the relation cascade run
 *            inside the service);
 *   unblock  `unblockUser(d1, doer, blocker, blockee)` — the org arm of
 *            `DELETE /orgs/{org}/blocks/{username}`
 *            (routes/blocks.ts:385-393; NOT idempotent upstream —
 *            unblocking a pair that is not blocked is the 400, not a silent
 *            204).
 *
 * The ownership guard (`requireOrgOwnership` — org owner or site admin) is
 * the ROUTE stage's posture (it 403s/404-shells before this module runs),
 * exactly as the API arm's handler-level guard sits in front of the same
 * service calls; the module trusts its inputs like every landed load
 * function.
 *
 * The landed list arm returns the blockee ROWS only — the note lives on the
 * `user_blocking` edge — so the page batch-reads the notes for the loaded
 * blockees in one `inArray` probe (the org hooks page's delivery-count
 * batching pattern).
 *
 * ## DOM contract
 *
 * shared/user/blocked_users.tmpl verbatim, in order: the "Block a user"
 * header segment with the info paragraph + the docs.gitea.com link; the
 * block form (`action=block`, the `#search-user-box` fluid search prompt
 * with the required `blockee` input + the red Block button, then the
 * optional `note` field with its not-visible help text); the "Blocked
 * users" header segment whose `flex-divided-list` rows render the blockee
 * avatar (`ctx.AvatarUtils.Avatar` — the 28px default, util_avatar.go:39-44
 * — through the landed `/user/avatar/{username}/{size}` serving seam, the
 * org-settings avatar widget's shape), the display-name link
 * (`GetDisplayName` = the username — DefaultShowFullName defaults false,
 * user.go:485-493; `HomeLink` = `/{username}`), the note arm
 * (`{{if .Note}}`), and the per-row unblock form; the empty arm renders
 * "You have not blocked any users."
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The per-row note-edit `show-modal` button + `#block-user-note-modal`
 *   (blocked_users.tmpl:42, 55-72; `action=note` → `GetBlocking` +
 *   `UpdateBlockingNote`, shared/user/block.go:52-57): NOT rendered —
 *   services/blocks.ts exposes no note-update port, so a rendered opener
 *   would be a dead control (the repo-settings-wiki module's modal
 *   reduction). A note set at block time still DISPLAYS on its row.
 * - The upstream POST is `form-fetch-action` (a fetch answered by
 *   JSONRedirect/JSONError toasts): the no-JS reduction answers `applied`
 *   with a 303 onto the page and `invalid` with a 200 re-render carrying
 *   the negative message banner (the org hooks-page convention). The
 *   failure texts stay upstream's: "Failed to block user: <msg>" /
 *   "Failed to unblock user: <msg>" (user.block.block.failure /
 *   user.block.unblock.failure wrapped around the landed 400 arms' exact
 *   messages — shared/user/block.go:42-51) and "The target couldn't be
 *   found." (error.not_found — the ErrNotExist arm, block.go:75-76).
 * - The list renders UNPAGINATED upstream (FindBlockings with no
 *   ListOptions, shared/user/block.go:19-21); the landed arm paginates, so
 *   the page reads the first `BLOCKED_USERS_LIST_LIMIT` (50 — the API
 *   family's own MAX_RESPONSE_ITEMS cap; the HOOKS_LIST_LIMIT convention).
 *   No pager exists in the template to reproduce.
 * - The reduced `action=note` arm (and any other out-of-enum value —
 *   upstream's binding-failure funnel) parses to the invalid outcome
 *   carrying the honest-absence note; neither is ever emitted by this DOM.
 *
 * ## Mount record (MOUNTED at 4f2805f, window-2b — the wiring HANDOFF is
 * retired)
 *
 * The settings navbar is the SHARED components/settings-nav
 * OrgSettingsNavbar (the wave-114 swap — this module's mount-scaffolding
 * OrgSettingsBlockedNav copy is deleted) rendered with `active: "blocked"`.
 * `orgSettingsBlockedLocale.blocked_users` ("user.block.list") remains the
 * page Title (org/block.go:19 sets `ctx.Data["Title"]` to the same key) AND
 * the list header.
 *
 * Route table (`index.ts`): `raw[3] ===
 * "blocked_users"` claimed in the settings family's `raw.length === 4` branch as
 * `{ family: "org-settings-blocked", owner }`; the two handlers are shaped
 * exactly like the wave-53 hooks pair:
 *
 *   GET  /{org}/settings/blocked_users   resolveOrgTeamsRequest →
 *                                        loadOrgBlockedUsers →
 *                                        renderOrgBlockedUsersPage
 *   POST /{org}/settings/blocked_users   sameOriginGuard FIRST →
 *                                        resolveOrgTeamsRequest →
 *                                        parseOrgBlockedForm(
 *                                        readUrlEncodedForm(req)) →
 *                                        applyOrgBlockedForm(db, org,
 *                                        {id: ctx.viewer.id, isAdmin:
 *                                        ctx.viewer.isAdmin}, form) →
 *                                        303 onto the page on `applied`;
 *                                        `invalid` re-renders the fresh
 *                                        load at 200 with the banner.
 *
 * The prologue carries the whole posture (anonymous 303 onto the login
 * round-trip, a signed-in non-owner 404-shells, a renamed org 307s) — the
 * handlers add nothing of their own. Survey row touched on landing:
 * docs/compat/ui-parity-survey.md:416 lists the blocked_users tail among
 * the "no landed org-scope reads" remainders — stale since inventory batch
 * 9 landed `organizationListBlocks` (routes/blocks.ts:178-193).
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  blockPartyFromUserRow,
  blockUser,
  listBlockedUsers,
  unblockUser,
  type BlockDoer,
  type BlockParty,
} from "../../api/services/blocks";
import { findUserByName, type UserRow } from "../../api/services/repository";
import { userBlocking } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { OrgHeader } from "./org-home";

/** Page chrome + copy text (component-local, the orgSettingsLocale pattern —
 *  locale.ts is shared and not this wave's file; upstream locale keys cited,
 *  cf-gitea additions marked). */
export const orgSettingsBlockedLocale = {
  /** The navbar tab, the page Title (org/block.go:19) and the list header. */
  blocked_users: "Blocked users", // "user.block.list"
  title: "Block a user", // "user.block.title"
  info:
    "Blocking a user prevents them from interacting with repositories, such as opening or commenting on pull requests or issues.", // "user.block.info"
  info_docs: "Learn more about blocking a user.", // "user.block.info.docs"
  block: "Block", // "user.block.block"
  search_user: "Search users…", // "search.user_kind" (the prompt placeholder)
  note_title: "Optional note:", // "user.block.note.title"
  note_info: "The note is not visible to the blocked user.", // "user.block.note.info"
  note: "Note", // "user.block.note" (the row arm's label)
  unblock: "Unblock", // "user.block.unblock"
  list_none: "You have not blocked any users.", // "user.block.list.none"
  // The failure texts ("%s" = the landed arm's exact message — the shared
  // handler's ErrorWrapTranslatable funnel, shared/user/block.go:42-51).
  block_failure: "Failed to block user: %s", // "user.block.block.failure"
  unblock_failure: "Failed to unblock user: %s", // "user.block.unblock.failure"
  not_found: "The target couldn't be found.", // "error.not_found"
  // cf-gitea addition — the honest-absence answer for the reduced
  // action=note arm (and any out-of-enum value): the note editor has no
  // landed store port, so the POST cannot be served (the module header).
  note_unavailable: "Editing the note is not supported yet: no landed write arm updates a stored block's note.",
} as const;

/** List page cap (listBlockedUsers is paginated; one page serves the slice —
 *  upstream's web GET renders the list unpaginated, the template has no
 *  pager; 50 is the API family's own MAX_RESPONSE_ITEMS cap, the
 *  HOOKS_LIST_LIMIT convention). */
export const BLOCKED_USERS_LIST_LIMIT = 50;

/** The upstream BlockUserForm's action enum (user_form.go:309) reduced to
 *  the DOM-emitted pair plus the reduced `note` arm. */
export type OrgBlockedAction = "block" | "unblock" | "note";

/** The parsed blocked-users POST (upstream BlockUserForm: action
 *  `Required;In(block,unblock,note)`, the required blockee, the note —
 *  user_form.go:307-312; the field names are the template's verbatim).
 *  `action: null` = a failed binding (any value outside the enum) — the
 *  arm this DOM never emits. */
export interface OrgBlockedForm {
  action: OrgBlockedAction | null;
  blockee: string;
  note: string;
}

export function parseOrgBlockedForm(params: URLSearchParams): OrgBlockedForm {
  const action = params.get("action") ?? "";
  return {
    action: action === "block" || action === "unblock" || action === "note" ? action : null,
    blockee: params.get("blockee") ?? "",
    note: params.get("note") ?? "",
  };
}

export type OrgBlockedResult = { outcome: "applied" } | { outcome: "invalid"; message: string };

/** Upstream's failure-text funnel (shared/user/block.go:42-51): the typed
 *  400 arms wrap into user.block.block.failure / user.block.unblock.failure. */
function failureText(template: string, message: string): string {
  return template.replace("%s", message);
}

/**
 * The blocked-users write (upstream `BlockedUsersPost` over the landed
 * org-scope arms — the exact service calls routes/blocks.ts:366-393 serve):
 * the blockee lookup first (`GetUserByName` — an unknown name is the
 * error.not_found arm, an ORG name flows into the service's
 * ErrBlockOrganization arm), then block or unblock through the landed
 * service (the CanBlockUser/CanUnblockUser gates + the cascade run
 * there). The typed ApiErrors re-render upstream's failure texts; a
 * non-ApiError throws (upstream's ServerError arm).
 */
export async function applyOrgBlockedForm(
  d1: D1Database,
  org: OrgRecord,
  doer: BlockDoer,
  form: OrgBlockedForm,
): Promise<OrgBlockedResult> {
  if (form.action === null || form.action === "note") {
    // The reduced note arm / a failed binding — never emitted by this DOM;
    // the honest-absence answer (the module header's reduction).
    return { outcome: "invalid", message: orgSettingsBlockedLocale.note_unavailable };
  }
  // GetUserByName — the empty required field fails the lookup the same way
  // (upstream's web-bind Required arm funnels through the same JSONError
  // answer; the rendered prompt is `required` so the browser gates it).
  const blockee = await findUserByName(d1, form.blockee);
  if (blockee === null) {
    return { outcome: "invalid", message: orgSettingsBlockedLocale.not_found };
  }
  // The org-scope blocker (routes/blocks.ts:378): org rows are never site
  // admins, and orgs never block their own members (the service gate).
  const blocker: BlockParty = { id: org.id, isOrg: true, isAdmin: false };
  try {
    if (form.action === "block") {
      await blockUser(d1, doer, blocker, blockPartyFromUserRow(blockee), form.note);
    } else {
      await unblockUser(d1, doer, blocker, blockPartyFromUserRow(blockee));
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const template =
        form.action === "block" ? orgSettingsBlockedLocale.block_failure : orgSettingsBlockedLocale.unblock_failure;
      return { outcome: "invalid", message: failureText(template, error.message) };
    }
    throw error;
  }
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The list page (GET /{org}/settings/blocked_users — org/settings/
// blocked_users.tmpl over shared/user/blocked_users.tmpl)
// ---------------------------------------------------------------------------

/** One rendered row: the blockee user row plus the blocking edge's note
 *  (batch-read — the landed list arm carries the blockees only). */
export interface OrgBlockedListItem {
  blockee: UserRow;
  note: string;
}

/** The blocked-users tab's render inputs. */
export interface OrgBlockedUsersData {
  org: OrgRecord;
  blocks: OrgBlockedListItem[];
}

/** Load the list (the landed `organizationListBlocks` read arm — id ASC —
 *  plus the one batched note read for the page). */
export async function loadOrgBlockedUsers(d1: D1Database, org: OrgRecord): Promise<OrgBlockedUsersData> {
  const { items } = await listBlockedUsers(d1, org.id, { page: 1, pageSize: BLOCKED_USERS_LIST_LIMIT });
  // One batched note read for the page (the hooks page's delivery-count
  // batching pattern — listBlockedUsers returns the blockee rows only).
  const notes = new Map<number, string>();
  if (items.length > 0) {
    const rows = await drizzle(d1)
      .select({ blockeeId: userBlocking.blockeeId, note: userBlocking.note })
      .from(userBlocking)
      .where(and(eq(userBlocking.blockerId, org.id), inArray(userBlocking.blockeeId, items.map((u) => u.id))))
      .all();
    for (const row of rows) notes.set(row.blockeeId, row.note);
  }
  return { org, blocks: items.map((blockee) => ({ blockee, note: notes.get(blockee.id) ?? "" })) };
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderOrgBlockedUsersPage(options: {
  ctx: UiContext;
  data: OrgBlockedUsersData;
  error: string | null;
}): string {
  return renderPage(<OrgBlockedUsersPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The org blocked-users page (§2.4.1 discriminator: `organization settings
 * blocked_users` — layout_head's pageClass dict): OrgHeader, the settings
 * navbar with the blocked_users item active, then `.org-setting-content`
 * wrapping shared/user/blocked_users.tmpl verbatim.
 */
export function OrgBlockedUsersPage(props: { ctx: UiContext; data: OrgBlockedUsersData; error: string | null }) {
  const { ctx, data } = props;
  const org = data.org;
  const pageLink = `/${org.username}/settings/blocked_users`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsBlockedLocale.blocked_users} pageClass="organization settings blocked_users">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={`/${org.username}`} active="blocked" />
        <div class="flex-container-main">
          {/* The invalid-POST re-render's banner (the org hooks-page
              convention — upstream's JSONError toast, the no-JS
              reduction). */}
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          {/* org/settings/blocked_users.tmpl:2's .org-setting-content. */}
          <div class="org-setting-content">
            {/* shared/user/blocked_users.tmpl:1-6 — the title header + the
                info segment with the docs link. */}
            <h4 class="ui top attached header">{orgSettingsBlockedLocale.title}</h4>
            <div class="ui attached segment">
              <p>
                {orgSettingsBlockedLocale.info}{" "}
                <a target="_blank" href="https://docs.gitea.com/usage/access-control/blocking-user">
                  {orgSettingsBlockedLocale.info_docs}
                </a>
              </p>
            </div>
            {/* The block form (blocked_users.tmpl:8-19): action=block, the
                required blockee prompt inside the fluid search wrapper, the
                red Block button, the optional note. POSTs the page URL
                ({{$.Link}}). */}
            <div class="ui segment">
              <form class="ui form form-fetch-action ignore-dirty" action={pageLink} method="post">
                <input type="hidden" name="action" value="block" />
                <div id="search-user-box" class="field ui fluid search input">
                  <input
                    class="prompt tw-mr-2"
                    name="blockee"
                    placeholder={orgSettingsBlockedLocale.search_user}
                    autocomplete="off"
                    required
                  />
                  <button type="submit" class="ui red button">
                    {orgSettingsBlockedLocale.block}
                  </button>
                </div>
                <div class="field">
                  <label>{orgSettingsBlockedLocale.note_title}</label>
                  <input name="note" />
                  <p class="help">{orgSettingsBlockedLocale.note_info}</p>
                </div>
              </form>
            </div>
            {/* The list (blocked_users.tmpl:21-54): the header + the
                flex-divided-list rows, else the empty arm. */}
            <h4 class="ui top attached header">{orgSettingsBlockedLocale.blocked_users}</h4>
            <div class="ui attached segment">
              <div class="flex-divided-list items-with-main">
                {data.blocks.length === 0 ? (
                  <div class="item">{orgSettingsBlockedLocale.list_none}</div>
                ) : (
                  data.blocks.map((row) => (
                    <div class="item">
                      <div class="item-leading">
                        {/* ctx.AvatarUtils.Avatar .Blockee — the 28px
                            default (util_avatar.go:39-44, AvatarHTML's
                            lazy/empty-alt/title shape) through the landed
                            serving seam. */}
                        <img
                          loading="lazy"
                          alt=""
                          class="ui avatar"
                          src={`/user/avatar/${encodeURIComponent(row.blockee.username)}/28`}
                          title={row.blockee.username}
                          width={28}
                          height={28}
                        />
                      </div>
                      <div class="item-main">
                        <div class="item-title">
                          {/* HomeLink + GetDisplayName (= the username at
                              the default DefaultShowFullName=false). */}
                          <a class="item" href={`/${row.blockee.username}`}>
                            {row.blockee.username}
                          </a>
                        </div>
                        {row.note !== "" ? (
                          <div class="item-body">
                            <i>{orgSettingsBlockedLocale.note}:</i> {row.note}
                          </div>
                        ) : null}
                      </div>
                      <div class="item-trailing">
                        {/* The unblock form (blocked_users.tmpl:43-47). NO
                            note-edit button: the show-modal opener +
                            #block-user-note-modal arm has no landed store
                            port (the module header) — a rendered opener
                            would be a dead control. */}
                        <form class="form-fetch-action" action={pageLink} method="post">
                          <input type="hidden" name="action" value="unblock" />
                          <input type="hidden" name="blockee" value={row.blockee.username} />
                          <button type="submit" class="ui compact mini button">
                            {orgSettingsBlockedLocale.unblock}
                          </button>
                        </form>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
