/**
 * The must-change-password wire arm — EXTRACTED from ui/session.ts (2026-11-14,
 * the GOLDENS escalation): HOFF-A's consumers (git-http/acl, lfs/router,
 * web/oauth2-token) imported the arm from ui/session, and session's own import
 * graph (ui/index -> the page tree) closed a cycle through
 * admin-monitor -> cron-state -> demo-sweep -> mirror/sync -> git-http/gate ->
 * git-http/acl -> ui/session — under which cron-state's top-level CRON_ARMS
 * read DEMO_SWEEP_CRON as undefined (all hourly rows rendered empty). The arm
 * itself is a leaf: one carved-out path, one locale string, one 303, one PK
 * read. ui/session re-exports these for its existing importers; NEW consumers
 * import here directly.
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";
import { changePasswordLocale } from "./pages/change-password";

/** The gate's carved-out path (web.go:198/203's literal). */
export const MUST_CHANGE_PASSWORD_PATH = "/user/settings/change_password";

function seeOther(location: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}

/**
 * The gate's DECISION arm — pure request math, no D1. `flagged` is the
 * caller's already-verified doer's flag (`CheckSignedInUser` shape:
 * impersonated sessions never gate — the common/auth.go:71 derivation; bot
 * rows cannot exist here, the users.type enum carries no bot value).
 * `setCookie` attaches the caller's pending §2.4 directive to BOTH failure
 * shapes — a rotation that silently never reaches the client is the
 * documented forced-logout bug (the loginPage comment): the stale cookie
 * would trip reuse detection past the grace and delete the row. `null` =
 * the request passes (anonymous, unflagged, impersonated, or the carved-
 * out path); otherwise the ready Response: the git-UA 401 or the 303.
 */
export function mustChangePasswordArm(req: Request, flagged: boolean, setCookie?: string): Response | null {
  if (!flagged) return null;
  const url = new URL(req.url);
  if (url.pathname === MUST_CHANGE_PASSWORD_PATH) return null;
  // web.go:199-201 — `strings.HasPrefix(ctx.Req.UserAgent(), "git")`:
  // a git client pointed at the WEB surface gets upstream's HTTPError(401)
  // — http.Error's exact wire (text/plain; charset=utf-8, nosniff, the
  // locale string + "\n").
  if (req.headers.get("user-agent")?.startsWith("git") === true) {
    const headers: Record<string, string> = {
      "content-type": "text/plain;charset=utf-8",
      "x-content-type-options": "nosniff",
    };
    if (setCookie !== undefined) headers["set-cookie"] = setCookie;
    return new Response(`${changePasswordLocale.must_change_password}\n`, { status: 401, headers });
  }
  return seeOther(MUST_CHANGE_PASSWORD_PATH, setCookie);
}

/**
 * The flag read for consumers that hold only a viewer/doer id (the
 * uiRouter's resolveUiSession — viewer.ts drops the flag additively — and
 * the API middleware's post-auth arm, which keeps its own local copy of the
 * same shape). One PK read; upstream avoids it by reading the doer row the
 * request already resolved, which the Viewer projection cannot carry
 * without touching viewer.ts (not this unit's file) — the read is the
 * disclosed ownership-shape cost, one indexed PK probe per signed-in page
 * request.
 */
export async function userMustChangePassword(d1: D1Database, userId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.mustChangePassword === true;
}
