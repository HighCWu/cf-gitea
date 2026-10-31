/**
 * The admin user AVATAR write arms (census gap #18, the avatar half —
 * upstream's admin users group, web.go:818-821):
 *
 *   POST /-/admin/users/{userid}/avatar         (admin.AvatarPost)
 *   POST /-/admin/users/{userid}/avatar/delete  (admin.DeleteAvatar)
 *
 * Both ride the ALREADY-LANDED avatar store (services/avatars.ts — the same
 * `avatars/u_<id>` R2 key + `users.use_custom_avatar` marker the API and
 * org-settings arms use) and the SAME upstream form struct the user/org
 * settings pages post (forms.AvatarForm — Source string + `avatar`
 * multipart.FileHeader + Gravatar email, forms/user_form.go:182-187); the
 * admin handler is the user-settings one retargeted by userid
 * (users.go:684-702 delegate to the shared user_setting.UpdateAvatarSetting,
 * routers/web/user/setting/profile.go:126-169).
 *
 * ## Upstream behavior at the pin
 *
 *   - prepareUserInfo (users.go:269-278) runs FIRST on both arms: an
 *     unknown {userid} REDIRECTS to `/-/admin/users` (the list) — not a
 *     404. Any users row passes: orgs ARE users rows upstream too
 *     (SPEC-0007's one id space), so an org id gets its avatar set exactly
 *     like the org arm's `org.AsUser()` delegation.
 *   - AvatarPost (:684-702): UpdateAvatarSetting, then Flash + redirect to
 *     `/-/admin/users/{id}` (:698). A parse/processing failure only FLASHES
 *     the message (:692-693) — the redirect is unconditional.
 *   - DeleteAvatar (:701-712): DeleteAvatar (a missing object is tolerated,
 *     services/user/avatar.go:46-69) then JSONRedirect to
 *     `/-/admin/users/{id}`.
 *
 * ## Port reductions (the org-settings family's exact posture)
 *
 *   - NO FLASH: the failure arm drops the flash message — every outcome
 *     303s (upstream's JSONRedirect renders through JS; the no-JS family
 *     answers 303 See Other, base.go:157's default).
 *   - NO `source`/`gravatar` FIELDS: the no-JS port drops the source radio
 *     and the gravatar email (the org arm's documented reduction,
 *     org-settings.tsx header) — an empty submit (no `avatar` file part) is
 *     a silent NO-OP, where upstream's `source=""` post would clear
 *     `use_custom_avatar` (profile.go:127). Never clearing on an
 *     unrendered field beats deleting the admin's target avatar from a
 *     form that cannot express the choice.
 *   - The multipart reader is the org arm's `readOrgAvatarUpload` verbatim
 *     (same AvatarForm, same wire cap, same processor) — imported, not
 *     duplicated (upstream shares the one form struct across all three
 *     scopes).
 *
 * ## Sibling arms of the pin (NOT built here)
 *
 * web.go:818-821 also carries `POST /{userid}/impersonate`
 * (admin.ImpersonateUser, users.go:563-581) — STOPPED at adjudication: the
 * honest port flips the live session's principal while remembering the
 * admin (upstream's in-session `impersonatorData` backup,
 * services/auth/impersonate.go:14-44), and our sessions table (schema.ts
 * SPEC-0010 §3) has NO general JSON column to carry the admin-return id —
 * `oauth_state`/`oauth2_login_state` are narrow read-and-cleared OAuth
 * dance payloads. It needs `sessions.impersonator_user_id` + a migration;
 * the adjudication and mount recipe live with the orchestrator's handoff.
 * The upstream pin has NO dedicated unimpersonate route: exit rides
 * SignOut (routers/web/auth/auth.go:469-478 — ExitImpersonatedUser
 * restores the backup and redirects to /-/admin instead of logging out).
 *
 * ## Mount recipe (the index.ts fold — this module is PORT-FIRST, the two
 * seams below are direct-driven by the suite like the attachments family)
 *
 * In `parseUiRoute`'s `raw[2] === "admin"` tail parse, after the `users`
 * literal (static-before-dynamic — the comment at :4002); the delete route
 * is `/-/admin/users/{userid}/avatar/delete` (web.go:821) — one segment
 * longer:
 *
 *   if (
 *     tail.length === 3 &&
 *     tail[0] === "users" &&
 *     tail[2] === "avatar" &&
 *     /^\d+$/.test(tail[1])
 *   ) {
 *     return { family: "admin-users-avatar", adminUserId: Number(tail[1]) };
 *   }
 *   if (
 *     tail.length === 4 &&
 *     tail[0] === "users" &&
 *     tail[2] === "avatar" &&
 *     tail[3] === "delete" &&
 *     /^\d+$/.test(tail[1])
 *   ) {
 *     return { family: "admin-users-avatar-delete", adminUserId: Number(tail[1]) };
 *   }
 *
 * (`UiRoute` gains the two families + the `adminUserId: number` payload,
 * the union at :3337's shape.) The claims, behind `adminPagePrologue` and
 * the §2.8 `sameOriginGuard` (the org pair's exact ladder,
 * index.ts orgSettingsAvatarSubmit/orgSettingsAvatarDeleteSubmit):
 *
 *   uiRouter.post("/-/admin/users/:userid/avatar", (c) => { … });
 *   uiRouter.post("/-/admin/users/:userid/avatar/delete", (c) => { … });
 *
 * each handler: guard → prologue → the parsed userid →
 * `adminUserAvatarUpload(c.env.REPO_PACKS, c.env.DB, userid, c.req.raw)` /
 * `adminUserAvatarDelete(...)` → `new Response(null, { status: 303,
 * headers: { location: outcome.redirect } })`. Junk segments (non-digits)
 * stay engine-404 (the house idiom — the family guard never claims them).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { deleteAvatar, uploadAvatar } from "../../services/avatars";
import { readOrgAvatarUpload } from "./org-settings";

/** The pair's success redirect — upstream
 *  `setting.AppSubURL + "/-/admin/users/" + id` (users.go:698, :711). */
export function adminUserLink(userId: number): string {
  return `/-/admin/users/${userId}`;
}

/** prepareUserInfo's unknown-{userid} redirect target (users.go:273) — the
 *  listing page. */
export const ADMIN_USERS_LIST_LINK = "/-/admin/users";

/** The target slice the write arms need (any users row — orgs included,
 *  prepareUserInfo's GetUserByID has no type gate). */
export interface AdminAvatarUser {
  readonly id: number;
}

/**
 * prepareUserInfo's lookup (users.go:269-278): the users row by id, or
 * `null` for the unknown-id miss — the caller answers the LIST redirect,
 * never a 404.
 */
export async function loadAdminAvatarUser(d1: D1Database, userId: number): Promise<AdminAvatarUser | null> {
  const row = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

/**
 * POST /-/admin/users/{userid}/avatar (admin.AvatarPost, users.go:684-702):
 * the multipart read (the org arm's AvatarForm reader — applied / none /
 * error), the store through the landed `uploadAvatar` (`{kind: "user"}` —
 * the users-row marker flip + the `avatars/u_<id>` object), then the
 * unconditional 303 target. An unknown target never reads the body
 * (prepareUserInfo answers first, users.go:272-274); a parse error lands
 * where upstream's flash-error arm does — the silent redirect (the
 * no-flash reduction).
 */
export async function adminUserAvatarUpload(
  bucket: R2Bucket,
  d1: D1Database,
  userId: number,
  request: Request,
): Promise<{ redirect: string }> {
  const user = await loadAdminAvatarUser(d1, userId);
  if (user === null) return { redirect: ADMIN_USERS_LIST_LINK };
  const upload = await readOrgAvatarUpload(request);
  if (upload.outcome === "applied") {
    await uploadAvatar({
      bucket,
      d1,
      target: { kind: "user", principalId: user.id },
      data: upload.data,
      contentType: upload.contentType,
    });
  }
  return { redirect: adminUserLink(user.id) };
}

/**
 * POST /-/admin/users/{userid}/avatar/delete (admin.DeleteAvatar,
 * users.go:701-712): the landed delete (the marker clears and the object
 * dies; a missing object deletes nothing and still succeeds —
 * services/avatars.ts deleteAvatar), then the 303. The unknown-target arm
 * is prepareUserInfo's LIST redirect like the upload's.
 */
export async function adminUserAvatarDelete(
  bucket: R2Bucket,
  d1: D1Database,
  userId: number,
): Promise<{ redirect: string }> {
  const user = await loadAdminAvatarUser(d1, userId);
  if (user === null) return { redirect: ADMIN_USERS_LIST_LINK };
  await deleteAvatar(bucket, d1, { kind: "user", principalId: user.id });
  return { redirect: adminUserLink(user.id) };
}
