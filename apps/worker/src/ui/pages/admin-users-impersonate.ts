/**
 * The admin user IMPERSONATE write arm (census gap #18's sanctioned
 * follow-up — upstream's admin users group, web.go:818):
 *
 *   POST /-/admin/users/{userid}/impersonate   (admin.ImpersonateUser)
 *
 * The adjudicated port of 2a00e28: upstream flips the LIVE session's
 * principal while backing the admin up under the session's
 * `impersonatorData` key (services/auth/impersonate.go:14-44); our session
 * row now carries that backup as `sessions.impersonator_user_id`
 * (schema.ts SPEC-0010 §3, migration 0058), and the store halves live in
 * session.ts — `impersonateSessionUser` (the flip) and
 * `exitImpersonationBySecret` (the exit, folded into POST /logout exactly
 * like upstream's SignOut, routers/web/auth/auth.go:469-478 — NO
 * unimpersonate route exists at the pin).
 *
 * ## Upstream behavior at the pin (users.go:563-581)
 *
 *   - GetUserByID first: an unknown {userid} answers JSONError("unable to
 *     get user") — 400 — NOT the avatar pair's prepareUserInfo list
 *     redirect (impersonate does its own lookup, users.go:565-568).
 *   - The bot guard (u.IsTypeBot → JSONError impersonate_bot_not_allowed,
 *     users.go:569-571) is a DOCUMENTED DEAD ARM here: our users.type is
 *     the SPEC-0002 two-value enum ("user" | "organization") with no bot
 *     value, so no row can trip it — recorded, not ported.
 *   - The session flip errors "already impersonating a user"
 *     (impersonate.go:16-18) → ctx.ServerError → the 500 page
 *     (users.go:575-577): the port answers the app's plain-text 500
 *     posture — an error status, never a silent redirect (the refusal is
 *     the point: a second impersonate over a live one would destroy the
 *     first admin's only backup).
 *   - Success: JSONRedirect(setting.AppSubURL + "/user/settings")
 *     (users.go:580) — the no-JS family reduction answers 303 See Other
 *     (base.go:157's default; the avatar pair's posture).
 *
 * ## The arm's dependencies (all landed, imported not duplicated)
 *
 *   - session.ts `impersonateSessionUser` — the guarded in-place flip
 *     (`user_id = target ∧ impersonator_user_id = admin WHERE id = ? AND
 *     impersonator_user_id IS NULL`): identity-only, the same cookie keeps
 *     authenticating as the target.
 *   - session.ts `lookupValidSession` — the caller-side §2.4 decision that
 *     yields the admin's user id AND the live row id (the flip's key).
 *   - services/audit.ts `emitAudit` + the `user:impersonation:start` action
 *     (upstream action.go:65): the START row emits after the flip lands
 *     (users.go:580's Record — actor the admin, scope the target); the
 *     EXIT row (action.go:66, auth.go:476's RecordAs) lives at session.ts's
 *     logout arm. A failed insert logs and never fails the flip (upstream
 *     writeEvent's posture).
 *
 * ## Mount recipe (the index.ts fold — this module is PORT-FIRST, direct-
 * driven by the suite like the avatar pair)
 *
 * In the `parseUiRoute` `raw[2] === "admin"` tail parse, after the
 * `users` literal (static-before-dynamic — the avatar recipe's exact
 * slot):
 *
 *   if (
 *     tail.length === 3 &&
 *     tail[0] === "users" &&
 *     tail[2] === "impersonate" &&
 *     /^\d+$/.test(tail[1])
 *   ) {
 *     return { family: "admin-users-impersonate", adminUserId: Number(tail[1]) };
 *   }
 *
 * (`UiRoute` gains the family + the `adminUserId: number` payload, the
 * avatar recipe's union shape.) The claim, behind the §2.8
 * `sameOriginGuard` and the `adminPagePrologue` (the avatar recipe's exact
 * ladder — anonymous 303s onto the login round-trip, a non-admin
 * 404-shells):
 *
 *   uiRouter.post("/-/admin/users/:userid/impersonate", (c) => { … });
 *
 * The handler: guard → prologue → the §2.4 cookie decision for the LIVE
 * row (`lookupValidSession(c.env.DB, value)` over
 * `sessionCookieValue(c.req.raw)` — the prologue's viewer carries the
 * identity but not the row id the flip keys on; `null` = the session died
 * between the prologue and the flip → the anonymous arm's posture,
 * `seeOther(loginRedirect(...), clearSessionSetCookie())`) → the parsed
 * userid → `adminUserImpersonate(...)` → map:
 *
 *   - impersonated         → 303 `IMPERSONATE_SUCCESS_REDIRECT` (/user/settings)
 *   - unknown-user         → 400 JSON `IMPERSONATE_UNKNOWN_USER_ERROR`
 *                            (`application/json;charset=utf-8` — the
 *                            org-settings-actions-general json-outcome
 *                            convention)
 *   - already-impersonating→ 500 plain text `IMPERSONATE_REFUSED_BODY`
 *                            (upstream ServerError's status over the
 *                            app's plain-text error shape)
 *   - session-gone         → 303 `/login?redirect_to=<this path>` +
 *                            `clearSessionSetCookie()` (the expired
 *                            session's anonymous round-trip)
 *
 * Junk segments (non-digits) stay engine-404 (the house idiom — the
 * family guard never claims them).
 *
 * NOTE for the render owner (the avatar pair's caveat repeated): the
 * impersonate button lives on the admin user VIEW page upstream
 * (templates/admin/user/view.tmpl:10 — `link-action` data-url
 * `{.Link}/impersonate`), and GET /-/admin/users/{id} (ViewUser) is
 * ALSO unlanded — the write seam here is complete regardless; the JS
 * link-action dialect upstream posts with is the reason the error arms
 * keep the JSON bodies.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { AuditActions, emitAudit } from "../../services/audit";
import { impersonateSessionUser } from "../session";

/** The success redirect — upstream
 *  `setting.AppSubURL + "/user/settings"` (users.go:580; AppSubURL is ""
 *  at our single-host posture). */
export const IMPERSONATE_SUCCESS_REDIRECT = "/user/settings";

/** The unknown-target JSONError body — users.go:566-568's LITERAL string
 *  under context.go:276-278's shape (`buildJsonErrorMap`: a string message
 *  renders `"renderFormat":"text"`); the wiring answers it 400 (the
 *  org-settings-actions-general json-outcome convention). */
export const IMPERSONATE_UNKNOWN_USER_ERROR = { errorMessage: "unable to get user", renderFormat: "text" } as const;

/** The refusal's plain-text body — users.go:575-577's ServerError first
 *  argument, answered 500 (upstream renders the 500 page; the app's
 *  plain-text error posture carries the same status). */
export const IMPERSONATE_REFUSED_BODY = "unable to impersonate user";

/** The arm's outcome union (the wiring's map, above). */
export type AdminUserImpersonateOutcome =
  | { outcome: "impersonated" }
  | { outcome: "unknown-user" }
  | { outcome: "already-impersonating" }
  | { outcome: "session-gone" };

/** The target slice the arm needs (any users row passes upstream's
 *  GetUserByID — orgs included; only the bot type would refuse, and our
 *  enum has no bot value — the dead arm above). `username` + `type` feed
 *  the audit row's scope snapshot (upstream ScopeFromUser's shape: an org
 *  target scopes as `organization`, refs.go:44-50). */
export interface AdminImpersonateTarget {
  readonly id: number;
  readonly username: string;
  readonly type: "user" | "org";
}

/**
 * GetUserByID's lookup (users.go:565-568): the users row by id, or `null`
 * for the unknown-id miss — the caller answers the 400 JSONError, never a
 * 404 and never the avatar pair's list redirect.
 */
export async function loadAdminImpersonateTarget(d1: D1Database, userId: number): Promise<AdminImpersonateTarget | null> {
  const row = await drizzle(d1)
    .select({ id: users.id, username: users.username, type: users.type })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

/**
 * POST /-/admin/users/{userid}/impersonate (admin.ImpersonateUser,
 * users.go:563-581) over the D1 session store: the target lookup, then the
 * guarded in-place flip (session.ts `impersonateSessionUser` — the admin
 * backup + the user_id move, race-free against a concurrent second
 * impersonate). The caller supplies the §2.4-verified session
 * (`sessionId` + the admin's user id, the `lookupValidSession` shape): a
 * `no-session` flip outcome means the row died between that verify and the
 * write — the `session-gone` outcome maps to the anonymous round-trip, not
 * an impersonation.
 */
export async function adminUserImpersonate(
  d1: D1Database,
  session: { sessionId: string; adminUserId: number },
  targetUserId: number,
): Promise<AdminUserImpersonateOutcome> {
  const target = await loadAdminImpersonateTarget(d1, targetUserId);
  if (target === null) return { outcome: "unknown-user" };
  // Upstream's bot guard (users.go:569-571) is a dead arm here — our
  // users.type enum has no bot value (module header); nothing to check.
  // A transient D1 failure propagates (§4.8 — never masquerade as an
  // outcome); the admin-deleted race cannot reach the flip as a FK error
  // (the impersonator_user_id cascade removes the session row first, and
  // the flip then answers no-session).
  const flip = await impersonateSessionUser(d1, session.sessionId, session.adminUserId, target.id);
  switch (flip) {
    case "impersonating":
      // The START audit row (upstream users.go:580's `audit.Record(ctx,
      // audit_model.UserImpersonation, u)`): actor the ADMIN (the signed-in
      // doer Record reads), scope the TARGET (ScopeFromUser's shape — an
      // org target scopes `organization`), origin ui. A failed insert must
      // not fail the flip (upstream writeEvent logs, never throws); the
      // client IP is upstream's IPAddress stamp, but the request lives at
      // the route layer this seam deliberately doesn't see — recorded null.
      {
        const adminName =
          (
            await drizzle(d1)
              .select({ username: users.username })
              .from(users)
              .where(eq(users.id, session.adminUserId))
              .get()
          )?.username ?? "";
        await emitAudit(drizzle(d1), {
          action: AuditActions.UserImpersonation,
          actorId: session.adminUserId,
          actorName: adminName,
          actorCredential: null, // the write rode a session
          scopeType: target.type === "org" ? "organization" : "user",
          scopeId: target.id,
          scopeName: target.username,
          origin: "ui",
          // the message column stores the RENDERED template (the seam's
          // contract) — the upstream template's two tokens
          vars: { actor: adminName, scope: target.username },
        }).catch((error: unknown) => {
          console.log(
            `[audit] impersonation-start row failed (actor=${session.adminUserId} scope=${target.id}): ${String(error)}`,
          );
        });
        return { outcome: "impersonated" };
      }
    case "already-impersonating":
      return { outcome: "already-impersonating" };
    case "no-session":
      return { outcome: "session-gone" };
  }
}
