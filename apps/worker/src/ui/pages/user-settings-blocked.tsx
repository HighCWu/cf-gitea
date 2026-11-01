/**
 * The USER settings BLOCKED USERS tab — the org twin's user-scope twin
 * (census gap #14; MOUNTED at 20f7290's five-fold — the wiring HANDOFF is
 * retired, the mount recipe at the bottom of this header is the executed
 * index.ts record, the b91dd1c pattern's landing).
 *
 * ## Upstream surface (at the pin fc493688)
 *
 * `routers/web/web.go:750-752`'s `/user/settings/blocked_users` group —
 * `GET user_setting.BlockedUsers` + `POST web.Bind[*forms.BlockUserForm]()`
 * `user_setting.BlockedUsersPost` (routers/web/user/setting/block.go:19-33,
 * both thin shims over `routers/web/shared/user/block.go`: the GET calls
 * `shared_user.BlockedUsers(ctx, ctx.Doer)` with the DOER as the blocker and
 * sets Title "user.block.list" + PageIsSettingsBlockedUsers; the POST
 * redirects `setting.AppSubURL+"/user/settings/blocked_users"`) — served
 * through `user/settings/blocked_users.tmpl` (layout_head's
 * `user settings blocked_users` pageClass wrapping
 * `shared/user/blocked_users.tmpl` in `.user-setting-content`). THE
 * reqSignIn posture like every user settings page: the group sits inside
 * web.go:646's `reqSignIn` (anonymous answers the login redirect; the
 * signed-in session doer IS the blocker — upstream has NO ownership gate
 * beyond sign-in at user scope, unlike the org family's RequireOwner). The
 * landed `userSettingsTabPrologue` serves the identical posture for the
 * whole `/user/settings` family.
 *
 * ## Data (§3.2 — the landed blocks family, never a self-fetch)
 *
 * The inventory batch 9 block octet over the `user_blocking` table
 * (migration 0022) — services/blocks.ts + routes/blocks.ts; the USER-scope
 * arms are the personal-access twin of `GET/PUT/DELETE
 * /user/settings/blocked_users`' service calls (upstream's own API serves
 * the same store through the user-block endpoints). This page rides the
 * same seams the org twin does, with blocker = the doer (upstream
 * `BlockedUsersPost(ctx, ctx.Doer, …)` — at user scope the blocker IS the
 * signed-in user, so `applyUserBlockedForm` takes the doer alone and builds
 * the BlockParty from it):
 *
 *   read     `listBlockedUsers(d1, doer.id, …)` (FindBlockings — blockee
 *            rows `id` ASC);
 *   block    `blockUser(d1, doer, {doer as blocker}, blockee, note)` — the
 *            CanBlockUser gate + the relation cascade run inside the
 *            service (self-block and re-block are the 400 arms);
 *   unblock  `unblockUser(d1, doer, blocker, blockee)` — NOT idempotent
 *            upstream: unblocking a pair that is not blocked is the 400,
 *            not a silent success.
 *
 * The ownership guard at user scope is STRUCTURAL: the module derives the
 * blocker from its doer argument, so the service's non-admin/unrelated-doer
 * unblock arm is unreachable through this page — exactly upstream's shape
 * (the route stage's `ctx.Doer` flows into both parameters). The route
 * stage owns the anonymous/anonymous-POST posture (the prologue), as for
 * every user settings tab.
 *
 * The landed list arm returns the blockee ROWS only — the note lives on the
 * `user_blocking` edge — so the page batch-reads the notes for the loaded
 * blockees in one `inArray` probe (the org twin's batching, verbatim).
 *
 * ## DOM contract
 *
 * `user/settings/blocked_users.tmpl` (the pageClass + the
 * `.user-setting-content` wrap) over `shared/user/blocked_users.tmpl`
 * verbatim, in order: the "Block a user" header segment with the info
 * paragraph + the docs.gitea.com link; the block form (`action=block`, the
 * `#search-user-box` fluid search prompt with the required `blockee` input
 * + the red Block button, then the optional `note` field with its
 * not-visible help text); the "Blocked users" header segment whose
 * `flex-divided-list` rows render the blockee avatar (the 28px default,
 * util_avatar.go:39-44, through the landed `/user/avatar/{username}/{size}`
 * serving seam), the display-name link (`GetDisplayName` = the username —
 * DefaultShowFullName defaults false; `HomeLink` = `/{username}`), the note
 * arm (`{{if .Note}}`), and the per-row unblock form; the empty arm renders
 * "You have not blocked any users." The navbar item rides the shared
 * components/settings-nav UserSettingsNavbar between Security and
 * Applications (user navbar.tmpl:25-27) — the item landed WITH this module
 * (the dead-link rule: the page exists, the link goes live).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * Identical to the org twin's (the SAME shared template): the per-row
 * note-edit `show-modal` button + `#block-user-note-modal`
 * (blocked_users.tmpl:42, 55-72; `action=note` → `GetBlocking` +
 * `UpdateBlockingNote`, shared/user/block.go:52-57) is NOT rendered —
 * services/blocks.ts exposes no note-update port, so a rendered opener
 * would be a dead control. A note set at block time still DISPLAYS on its
 * row. The upstream POST is `form-fetch-action` (JSONRedirect/JSONError
 * toasts): the no-JS reduction answers `applied` with a 303 onto the page
 * and `invalid` with a 200 re-render carrying the negative message banner
 * (the org hooks-page convention). Failure texts stay upstream's: "Failed
 * to block user: <msg>" / "Failed to unblock user: <msg>"
 * (user.block.block.failure / user.block.unblock.failure wrapped around the
 * landed 400 arms' exact messages — shared/user/block.go:42-51) and "The
 * target couldn't be found." (error.not_found — the ErrNotExist arm,
 * block.go:75-76). The list renders UNPAGINATED upstream (FindBlockings
 * with no ListOptions, shared/user/block.go:19-21); the landed arm
 * paginates, so the page reads the first `USER_BLOCKED_USERS_LIST_LIMIT`
 * (50 — the API family's own MAX_RESPONSE_ITEMS cap; the org twin's
 * BLOCKED_USERS_LIST_LIMIT convention). No pager exists in the template to
 * reproduce. The reduced `action=note` arm (and any other out-of-enum
 * value — upstream's binding-failure funnel) parses to the invalid outcome
 * carrying the honest-absence note; neither is ever emitted by this DOM.
 *
 * ## Mount record (MOUNTED at 20f7290 — the wiring HANDOFF retired, the
 * recipe below executed in index.ts; the org twin's retired handoff's exact
 * shape, userSettingsTabPrologue division):
 *
 *   1. `UserSettingsTabRoute` union: add
 *      `"user-settings-blocked-users"` (GET+POST /user/settings/
 *      blocked_users, web.go:750-752).
 *   2. parseUiRoute's `/user/settings` branch (after the security claim,
 *      navbar.tmpl order):
 *      `if (tail.length === 1 && tail[0] === "blocked_users") return
 *      { family: "user-settings-blocked-users", id: null };`
 *   3. import beside the window-2a tab modules:
 *      `import { applyUserBlockedForm, loadUserBlockedUsers,
 *      parseUserBlockedForm, renderUserSettingsBlockedPage } from
 *      "./pages/user-settings-blocked";`
 *   4. the handlers (the appearance pair's shape — GET without the origin
 *      guard, POST with sameOriginGuard-first via the prologue's
 *      withOriginGuard arm; anonymous 303s onto the login round-trip; the
 *      POST's redirect is upstream's AppSubURL target):
 *
 *        async function userSettingsBlockedUsersPage(c) {
 *          const p = await userSettingsTabPrologue(c, false);
 *          if (!p.ok) return p.response;
 *          const data = await loadUserBlockedUsers(c.env.DB, p.viewer.id);
 *          return p.respond(c.html(renderUserSettingsBlockedPage({ ctx: p.ctx, data, error: null }), 200));
 *        }
 *        async function userSettingsBlockedUsersSubmit(c) {
 *          const p = await userSettingsTabPrologue(c, true);
 *          if (!p.ok) return p.response;
 *          const form = parseUserBlockedForm(await readUrlEncodedForm(c.req.raw));
 *          const result = await applyUserBlockedForm(c.env.DB, { id: p.viewer.id, isAdmin: p.viewer.isAdmin }, form);
 *          if (result.outcome === "applied") {
 *            return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/blocked_users" } }));
 *          }
 *          const data = await loadUserBlockedUsers(c.env.DB, p.viewer.id);
 *          return p.respond(c.html(renderUserSettingsBlockedPage({ ctx: p.ctx, data, error: result.message }), 200));
 *        }
 *
 *   5. registrations beside the other tab pairs:
 *      `uiRouter.get("/user/settings/blocked_users", (c) => userSettingsBlockedUsersPage(c));`
 *      `uiRouter.post("/user/settings/blocked_users", (c) => userSettingsBlockedUsersSubmit(c));`
 *      (BOTH methods are upstream routes — no chi-405 twin.)
 *   6. index.test.ts / route-pin follow-ups: parseUiRoute
 *      "/user/settings/blocked_users" → { family: "user-settings-blocked-users",
 *      id: null } (no pre-existing blocked_users pins existed under
 *      /user/settings at the handoff — grep verified 2026-11-01).
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
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { UserSettingsNavbar } from "../components/settings-nav";

/** Page chrome + copy text (component-local, the orgSettingsBlockedLocale
 *  pattern — locale.ts is shared and not this wave's file; upstream locale
 *  keys cited, cf-gitea additions marked). */
export const userSettingsBlockedLocale = {
  /** The navbar tab (user navbar.tmpl:26), the page Title (setting/
   *  block.go:20) and the list header. */
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
 *  pager; 50 is the API family's own MAX_RESPONSE_ITEMS cap, the org twin's
 *  BLOCKED_USERS_LIST_LIMIT convention). */
export const USER_BLOCKED_USERS_LIST_LIMIT = 50;

/** The upstream BlockUserForm's action enum (user_form.go:309) reduced to
 *  the DOM-emitted pair plus the reduced `note` arm. */
export type UserBlockedAction = "block" | "unblock" | "note";

/** The parsed blocked-users POST (upstream BlockUserForm: action
 *  `Required;In(block,unblock,note)`, the required blockee, the note —
 *  user_form.go:307-312; the field names are the template's verbatim).
 *  `action: null` = a failed binding (any value outside the enum) — the
 *  arm this DOM never emits. */
export interface UserBlockedForm {
  action: UserBlockedAction | null;
  blockee: string;
  note: string;
}

export function parseUserBlockedForm(params: URLSearchParams): UserBlockedForm {
  const action = params.get("action") ?? "";
  return {
    action: action === "block" || action === "unblock" || action === "note" ? action : null,
    blockee: params.get("blockee") ?? "",
    note: params.get("note") ?? "",
  };
}

export type UserBlockedResult = { outcome: "applied" } | { outcome: "invalid"; message: string };

/** Upstream's failure-text funnel (shared/user/block.go:42-51): the typed
 *  400 arms wrap into user.block.block.failure / user.block.unblock.failure. */
function failureText(template: string, message: string): string {
  return template.replace("%s", message);
}

/**
 * The blocked-users write (upstream `BlockedUsersPost` over the landed
 * service — at user scope the BLOCKER IS THE DOER, setting/block.go:32's
 * `ctx.Doer` flows into both upstream parameters): the blockee lookup first
 * (`GetUserByName` — an unknown name is the error.not_found arm, an ORG
 * name flows into the service's ErrBlockOrganization arm), then block or
 * unblock through the landed service (the CanBlockUser/CanUnblockUser gates
 * + the cascade run there — self-block, re-block and unblock-non-pair are
 * the 400 arms). The typed ApiErrors re-render upstream's failure texts; a
 * non-ApiError throws (upstream's ServerError arm).
 */
export async function applyUserBlockedForm(d1: D1Database, doer: BlockDoer, form: UserBlockedForm): Promise<UserBlockedResult> {
  if (form.action === null || form.action === "note") {
    // The reduced note arm / a failed binding — never emitted by this DOM;
    // the honest-absence answer (the module header's reduction).
    return { outcome: "invalid", message: userSettingsBlockedLocale.note_unavailable };
  }
  // GetUserByName — the empty required field fails the lookup the same way
  // (upstream's web-bind Required arm funnels through the same JSONError
  // answer; the rendered prompt is `required` so the browser gates it).
  const blockee = await findUserByName(d1, form.blockee);
  if (blockee === null) {
    return { outcome: "invalid", message: userSettingsBlockedLocale.not_found };
  }
  // The doer IS the blocker at user scope (setting/block.go:32); admin
  // riders the doer's own flag exactly as upstream's ctx.Doer carries it.
  const blocker: BlockParty = { id: doer.id, isOrg: false, isAdmin: doer.isAdmin };
  try {
    if (form.action === "block") {
      await blockUser(d1, doer, blocker, blockPartyFromUserRow(blockee), form.note);
    } else {
      await unblockUser(d1, doer, blocker, blockPartyFromUserRow(blockee));
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const template =
        form.action === "block" ? userSettingsBlockedLocale.block_failure : userSettingsBlockedLocale.unblock_failure;
      return { outcome: "invalid", message: failureText(template, error.message) };
    }
    throw error;
  }
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The list page (GET /user/settings/blocked_users — user/settings/
// blocked_users.tmpl over shared/user/blocked_users.tmpl)
// ---------------------------------------------------------------------------

/** One rendered row: the blockee user row plus the blocking edge's note
 *  (batch-read — the landed list arm carries the blockees only). */
export interface UserBlockedListItem {
  blockee: UserRow;
  note: string;
}

/** The blocked-users tab's render inputs (the signed-in viewer is the
 *  blocker — the list is fixed to the loader's userId). */
export interface UserBlockedUsersData {
  blocks: UserBlockedListItem[];
}

/** Load the list (the landed read arm — id ASC — plus the one batched note
 *  read for the page). */
export async function loadUserBlockedUsers(d1: D1Database, blockerId: number): Promise<UserBlockedUsersData> {
  const { items } = await listBlockedUsers(d1, blockerId, { page: 1, pageSize: USER_BLOCKED_USERS_LIST_LIMIT });
  // One batched note read for the page (the org twin's batching —
  // listBlockedUsers returns the blockee rows only).
  const notes = new Map<number, string>();
  if (items.length > 0) {
    const rows = await drizzle(d1)
      .select({ blockeeId: userBlocking.blockeeId, note: userBlocking.note })
      .from(userBlocking)
      .where(and(eq(userBlocking.blockerId, blockerId), inArray(userBlocking.blockeeId, items.map((u) => u.id))))
      .all();
    for (const row of rows) notes.set(row.blockeeId, row.note);
  }
  return { blocks: items.map((blockee) => ({ blockee, note: notes.get(blockee.id) ?? "" })) };
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderUserSettingsBlockedPage(options: { ctx: UiContext; data: UserBlockedUsersData; error: string | null }): string {
  return renderPage(<UserSettingsBlockedPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The user blocked-users page (§2.4.1 discriminator: `user settings
 * blocked_users` — layout_head's pageClass dict): the settings navbar with
 * the blocked_users item active, then `.user-setting-content` wrapping
 * shared/user/blocked_users.tmpl verbatim.
 */
export function UserSettingsBlockedPage(props: { ctx: UiContext; data: UserBlockedUsersData; error: string | null }) {
  const { ctx, data } = props;
  const pageLink = "/user/settings/blocked_users";
  return (
    <BaseLayout ctx={ctx} title={userSettingsBlockedLocale.blocked_users} pageClass="user settings blocked_users">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="blocked-users" />
        <div class="user-setting-content">
          {/* The invalid-POST re-render's banner (the org hooks-page
              convention — upstream's JSONError toast, the no-JS
              reduction). */}
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          {/* shared/user/blocked_users.tmpl:1-6 — the title header + the
              info segment with the docs link. */}
          <h4 class="ui top attached header">{userSettingsBlockedLocale.title}</h4>
          <div class="ui attached segment">
            <p>
              {userSettingsBlockedLocale.info}{" "}
              <a target="_blank" href="https://docs.gitea.com/usage/access-control/blocking-user">
                {userSettingsBlockedLocale.info_docs}
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
                  placeholder={userSettingsBlockedLocale.search_user}
                  autocomplete="off"
                  required
                />
                <button type="submit" class="ui red button">
                  {userSettingsBlockedLocale.block}
                </button>
              </div>
              <div class="field">
                <label>{userSettingsBlockedLocale.note_title}</label>
                <input name="note" />
                <p class="help">{userSettingsBlockedLocale.note_info}</p>
              </div>
            </form>
          </div>
          {/* The list (blocked_users.tmpl:21-54): the header + the
              flex-divided-list rows, else the empty arm. */}
          <h4 class="ui top attached header">{userSettingsBlockedLocale.blocked_users}</h4>
          <div class="ui attached segment">
            <div class="flex-divided-list items-with-main">
              {data.blocks.length === 0 ? (
                <div class="item">{userSettingsBlockedLocale.list_none}</div>
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
                          <i>{userSettingsBlockedLocale.note}:</i> {row.note}
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
                          {userSettingsBlockedLocale.unblock}
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
    </BaseLayout>
  );
}
