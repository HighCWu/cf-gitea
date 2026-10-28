/**
 * Individual-user account creation (SPEC-0010 first-run amendment,
 * 2026-10-28): the two creation surfaces the web UI owns — the ONE-SHOT
 * admin-init window (zero-user instances, upstream's install-page
 * admin-creation posture) and regular self-registration (the
 * `ALLOW_SIGNUP` gate).
 *
 * ## Reuse (never duplicate the ladder)
 *
 * The row shape and the validation ladder are the `POST /admin/users`
 * path's (`api/routes/admin-t2.ts` adminCreateUser, itself the port of
 * upstream `user_model.createUser`, models/user/user.go:700–812):
 *   1. usable name — `usableUsernameError` (services/orgs/orgs.ts, the
 *      upstream reserved/pattern list, REUSED verbatim here);
 *   2. email format — `invalidEmailMessage` (a byte-identical port of the
 *      admin-t2 private helper — it is not exported, so the service carries
 *      the single web-facing copy; upstream `IsEmailAddressValid`,
 *      models/user/email_address.go:120–138);
 *   3. name collision — pre-check, then the `UNIQUE(users.username_lower)`
 *      arbiter on the insert itself (admin-t2.ts:482–495 unwrapping);
 *   4. email-in-use pre-check (admin-t2 `emailUsedByOther` shape);
 *   5. live `user_redirect` consumption on create (user.go:798).
 * **No password store** (SPEC-0002 §4.6.7, admin-t2 deviation 1): the forms
 * accept a password field for upstream InstallForm/RegisterForm parity and
 * it is IGNORED — users authenticate exclusively with personal access
 * tokens, exactly like every adminCreateUser-created row.
 *
 * ## The one-shot window's atomicity (the §2 race argument)
 *
 * "Empty users table" is checked by the STATEMENT, not by a prior read:
 * the init insert is a single SQLite statement
 *
 *     INSERT INTO users (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)
 *
 * D1 serializes writes to the one SQLite database, so two simultaneous
 * first-submissions run strictly one-after-another: the winner's insert
 * affects 1 row, the loser's `NOT EXISTS` sees the winner's row and affects
 * 0 — exactly one admin exists, and the loser reports
 * "already-initialized" (meta.changes == 0, the session.ts CAS convention).
 * A count-guarded pre-read would TOCTOU-race; this cannot. The window also
 * closes on ORG rows (`users` holds both types, SPEC-0007) — same semantics
 * as upstream's `HasUsers` over the unified user table.
 */

import { sql, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userRedirects, users } from "../db/schema";
import { usableUsernameError } from "./orgs/orgs";

// ---------------------------------------------------------------------------
// The ALLOW_SIGNUP gate (upstream DISABLE_REGISTRATION, inverted polarity)
// ---------------------------------------------------------------------------

/**
 * The env this service + the first-run router read. `ALLOW_SIGNUP` rides
 * wrangler `vars` (the deploy-page-visible surface); BOTH configs declare it
 * (default `"false"`), so the generated Env types it as that literal — this
 * alias widens it back to `string | undefined` so tests and any config shape
 * stay assignable (the `MirrorSyncEnv.MIRROR_EGRESS_MODE` posture,
 * services/mirror/sync.ts). The generated Env satisfies this structurally.
 */
export type FirstRunEnv = Omit<Env, "ALLOW_SIGNUP"> & {
  /** `"true"` enables self-registration. Absent, empty, or anything else →
   *  registration closed (the self-host default; upstream's
   *  DISABLE_REGISTRATION default is true, setting/service.go:148). */
  ALLOW_SIGNUP?: string;
};

/** The gate, absent-safe: FALSE unless the var is explicitly on. */
export function allowSignup(env: FirstRunEnv): boolean {
  const raw = env.ALLOW_SIGNUP;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "true" || value === "1";
}

// ---------------------------------------------------------------------------
// Shared validation (the adminCreateUser ladder's steps 1-2)
// ---------------------------------------------------------------------------

/** A web account-creation form. `password` is accepted-and-ignored
 *  (module header — PAT-only auth); `retype` is checked for equality with
 *  it (upstream RegisterForm semantics, auth.go:577) but the value itself
 *  never lands anywhere. */
export interface AccountForm {
  username: string;
  email: string;
  password: string;
  retype: string;
}

/**
 * Upstream `IsEmailAddressValid` essentials — the byte-identical port of
 * admin-t2.ts's `invalidEmailMessage` (models/user/email_address.go:120–138,
 * ValidateEmailForAdmin: format only): one '@', non-empty local and domain
 * parts, no whitespace or control chars. `null` = valid.
 */
export function invalidEmailMessage(email: string): string | null {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[\s@]/.test(email.split("@")[0] ?? "")) {
    return null;
  }
  return `email address is invalid: ${email}`;
}

/** The password-retype check (upstream auth.go:575-579, "form.password_not_match"). */
function retypeMismatchMessage(form: AccountForm): string | null {
  if (form.password === form.retype) return null;
  return "password and re-type do not match";
}

/** The whole shared ladder's validation phase: `null` = clean, else the
 *  inline message (the field's server-side re-render copy). */
export function accountFormError(form: AccountForm): string | null {
  const nameError = usableUsernameError(form.username);
  if (nameError !== null) return nameError.message;
  const emailError = invalidEmailMessage(form.email);
  if (emailError !== null) return emailError;
  return retypeMismatchMessage(form);
}

// ---------------------------------------------------------------------------
// Row creation (the adminCreateUser insert shape)
// ---------------------------------------------------------------------------

/** D1 row of the `users` table (the admin-t2 TargetRow shape). */
export type UserAccountRow = typeof users.$inferSelect;

/** Chained-cause message text — the admin-t2.ts:485–490 unwrapping (drizzle
 *  wraps driver errors; the UNIQUE arbiter text may sit on any cause). */
function errorText(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text;
}

/** `true` when the insert died on `UNIQUE(users.username_lower)` — the
 *  two-creations race arbiter (admin-t2.ts:491). */
function isUniqueConstraintError(error: unknown): boolean {
  return errorText(error).includes("UNIQUE constraint failed");
}

/** Case-folded collision pre-check (adminCreateUser's `findUserByName` arm,
 *  admin-t2.ts:853 — type-blind lower_name lookup). */
async function findAccountByName(d1: D1Database, username: string): Promise<UserAccountRow | null> {
  return (
    (await drizzle(d1)
      .select()
      .from(users)
      .where(eq(users.usernameLower, username.toLowerCase()))
      .get()) ?? null
  );
}

/** Duplicate-email probe over any user row (admin-t2 `emailUsedByOther`). */
async function emailUsed(d1: D1Database, email: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .all();
  return rows.length > 0;
}

/**
 * The plain account insert — admin-t2's `insertCreatedUser` shape
 * (admin-t2.ts:443–479): display_name stays NULL (no full_name field on the
 * web forms; the toApiUser render treats null the same), `type='user'`,
 * `is_admin` per the caller, `status='active'`, `visibility='public'`.
 */
async function insertAccountRow(
  d1: D1Database,
  form: { username: string; email: string },
  options: { isAdmin: boolean },
  now: Date,
): Promise<UserAccountRow> {
  const inserted = await drizzle(d1)
    .insert(users)
    .values({
      username: form.username,
      usernameLower: form.username.toLowerCase(),
      email: form.email,
      displayName: null,
      isAdmin: options.isAdmin,
      status: "active",
      visibility: "public",
      fullName: null,
      type: "user",
      createdAt: now,
    })
    .returning();
  return inserted[0]!;
}

// ---------------------------------------------------------------------------
// The admin-init window (zero users)
// ---------------------------------------------------------------------------

/** `true` when NO user row exists (individuals AND orgs — the unified
 *  upstream user table; module header). One indexed-exists probe. */
export async function initWindowOpen(d1: D1Database): Promise<boolean> {
  const probe = await drizzle(d1).select({ id: users.id }).from(users).limit(1).get();
  return probe === undefined;
}

export type AdminInitOutcome =
  | { outcome: "created"; user: UserAccountRow }
  | { outcome: "already-initialized" }
  | { outcome: "invalid"; message: string };

/**
 * The ONE-SHOT first-admin creation (upstream install `initAdminUser`,
 * routers/install/install.go:452–478: `IsAdmin: true`, active, then the
 * auto-login). Validation runs first (friendly inline errors for the
 * still-open window); the decision itself is the count-guarded single
 * statement (module header — the race argument). Returns the created row
 * (the caller mints the session, install.go:479–490 parity) or
 * "already-initialized" — the race loser's clear, terminal verdict.
 */
export async function initializeAdminUser(
  d1: D1Database,
  form: AccountForm,
  options?: { now?: Date },
): Promise<AdminInitOutcome> {
  const invalid = accountFormError(form);
  if (invalid !== null) return { outcome: "invalid", message: invalid };

  const now = options?.now ?? new Date();
  const lower = form.username.toLowerCase();
  // The count-guarded insert: `meta.changes` is the whole verdict. D1
  // serializes writers, so exactly one concurrent submission sees changes
  // == 1 (module header).
  const result = await drizzle(d1)
    .run(
      sql`INSERT INTO users (username, username_lower, email, display_name, is_admin, status, visibility, type, created_at)
          SELECT ${form.username}, ${lower}, ${form.email}, NULL, 1, 'active', 'public', 'user', ${Math.floor(now.getTime() / 1000)}
          WHERE NOT EXISTS (SELECT 1 FROM ${users})`,
    );
  if ((result.meta.changes ?? 0) === 0) {
    return { outcome: "already-initialized" };
  }
  const user = await findAccountByName(d1, form.username);
  if (user === null) {
    // Unreachable by construction (the winner's row is committed before the
    // read — same statement-then-read serialization), but never assume.
    return { outcome: "already-initialized" };
  }
  return { outcome: "created", user };
}

// ---------------------------------------------------------------------------
// Regular registration (ALLOW_SIGNUP)
// ---------------------------------------------------------------------------

export type RegisterOutcome =
  | { outcome: "created"; user: UserAccountRow }
  | { outcome: "invalid"; message: string }
  | { outcome: "name-taken" }
  | { outcome: "email-taken" };

/**
 * A standard registration (upstream `SignUpPost`, routers/web/auth/
 * auth.go:548–632, gated on ALLOW_SIGNUP instead of DISABLE_REGISTRATION):
 * the shared validation ladder, the name/email collision pre-checks, the
 * live-redirect consumption (adminCreateUser parity, user.go:798), then the
 * insert whose UNIQUE arbiter settles the two-signups race. Plain member
 * account: `is_admin=false`.
 */
export async function registerUser(
  d1: D1Database,
  form: AccountForm,
  options?: { now?: Date },
): Promise<RegisterOutcome> {
  const invalid = accountFormError(form);
  if (invalid !== null) return { outcome: "invalid", message: invalid };

  if ((await findAccountByName(d1, form.username)) !== null) return { outcome: "name-taken" };
  if (await emailUsed(d1, form.email)) return { outcome: "email-taken" };

  const now = options?.now ?? new Date();
  // DeleteUserRedirect (user.go:798): creating on a live redirect consumes
  // it — the adminCreateUser arm verbatim (admin-t2.ts:862).
  await drizzle(d1)
    .delete(userRedirects)
    .where(eq(userRedirects.lowerName, form.username.toLowerCase()));
  try {
    const user = await insertAccountRow(d1, form, { isAdmin: false }, now);
    return { outcome: "created", user };
  } catch (error) {
    if (isUniqueConstraintError(error)) return { outcome: "name-taken" };
    throw error;
  }
}
