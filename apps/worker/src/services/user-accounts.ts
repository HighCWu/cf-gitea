/**
 * Individual-user account creation AND deletion. Creation (SPEC-0010
 * first-run amendment, 2026-10-28): the two creation surfaces the web UI
 * owns — the ONE-SHOT admin-init window (instances with no human user yet —
 * the migration-seeded system service principals don't count, see the
 * seeded-system premise below; upstream's install-page admin-creation
 * posture) and regular self-registration (the `ALLOW_SIGNUP` gate).
 * Deletion (2026-10-28): `deleteUserCascade`, the
 * admin DELETE surface's service — upstream's `DeleteUser` ladder over the
 * EXISTING repo cascade (section at the bottom of the file).
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
 * "No human user yet" is checked by the STATEMENT, not by a prior read:
 * the init insert is a single SQLite statement
 *
 *     INSERT INTO users (...) SELECT ...
 *     WHERE NOT EXISTS (SELECT 1 FROM users WHERE <non-system user>)
 *
 * D1 serializes writes to the one SQLite database, so two simultaneous
 * first-submissions run strictly one-after-another: the winner's insert
 * affects 1 row, the loser's `NOT EXISTS` sees the winner's row and affects
 * 0 — exactly one admin exists, and the loser reports
 * "already-initialized" (meta.changes == 0, the session.ts CAS convention).
 * A count-guarded pre-read would TOCTOU-race; this cannot. The window also
 * closes on ORG rows (`users` holds both types, SPEC-0007; an org only ever
 * exists after a human created it) — same semantics as upstream's `HasUsers`
 * over the unified user table.
 *
 * ## The seeded-system premise (the 2026-10-30 act_runner smoke, finding 4)
 *
 * The gate does NOT count the migration-seeded SYSTEM SERVICE PRINCIPALS:
 * `assets` (migration 0003 — the SPEC-0008 name reservation, the smoke's
 * window-closer) and `gitea:deploy-key` (migration 0020, upstream
 * user_system.go:76 id -3, re-asserted on demand by api/services/
 * deploy-keys.ts). Their codified row shape (schema.ts's deploy-keys doc:
 * "the migration-0003 'assets' reservation row") is `status='prohibited'` +
 * `is_admin=0` + no email — `NON_SYSTEM_USER_ROW` below is that shape's
 * exact negation. Every HUMAN creation path stores a validated email and
 * lands 'active' (the init insert here, registerUser, admin-t2
 * adminCreateUser), and a later prohibit_login PATCH keeps the email — so a
 * prohibit-logged human NEVER reopens the window (upstream's install lock
 * never reopens; a bare active-count gate would). A freshly-migrated
 * instance (seeds only, no humans) therefore still has its one-shot
 * first-admin window open — the exact state the smoke found dead under the
 * old "users table empty" gate.
 */

import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actions,
  issueAssignees,
  issueStopwatches,
  issueSubscriptions,
  notificationStates,
  oauth2Applications,
  orgMembers,
  packageVersions,
  packages,
  reactions,
  repoCollaborators,
  repoWatchers,
  repositories,
  stars,
  userBadges,
  userRedirects,
  users,
} from "../db/schema";
import { RepoNotExistError, RepoService } from "../repos/service";
import { tombstoneRepoDO } from "../repos/purge";
import { OrgService } from "./orgs/orgs";
import { LastOrgOwnerError } from "./orgs/errors";
import { scrubUserFromAllRules } from "./branch-protection";
import { deletePackageAndReferences } from "./packages/model";
import { usableUsernameError } from "./orgs/orgs";
import {
  buildComplexityError,
  DEFAULT_PASSWORD_POLICY,
  isComplexEnough,
  isPwned,
  type PasswordPolicy,
  type PwnedResult,
} from "../auth/password-policy";
import { newPasswordRecord, newSalt, verifyPassword } from "../auth/password";

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

/** A web account-creation form. `password` handling SPLIT by ladder since
 *  PWD-2's store landed (SPEC-0002 §6 superseded §4.6.7's PAT-only
 *  posture): initializeAdminUser requires it non-empty (the retype-match
 *  arm is the form's confirm) and STORES the hash record (user.go:783-794's
 *  SetPassword posture); the register ladder still ignores it
 *  (insertAccountRow takes {username, email} only) until its own arm
 *  lands. `retype` is checked for equality with the password (upstream
 *  RegisterForm semantics, auth.go:577). */
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
// The admin-init window (no HUMAN user yet — the seeded system principals
// don't count)
// ---------------------------------------------------------------------------

/**
 * SQL predicate: TRUE for a HUMAN (non-SYSTEM) user row — the init window's
 * only counting unit (the seeded-system premise, module header). The shape
 * it excludes is exactly the migration-seeded service principals'
 * (`assets` 0003, `gitea:deploy-key` 0020): prohibited, non-admin, no
 * email. Shared VERBATIM by `initWindowOpen`'s probe and the init insert's
 * `NOT EXISTS` guard, so the GET and POST windows can never disagree.
 */
const NON_SYSTEM_USER_ROW = sql`(${users.status} <> 'prohibited' OR ${users.isAdmin} <> 0 OR ${users.email} IS NOT NULL)`;

/** `true` while NO human user row exists (individuals AND orgs — the unified
 *  upstream user table; module header). The migration-seeded system service
 *  principals do NOT close the window. One exists-probe over the shared
 *  predicate. */
export async function initWindowOpen(d1: D1Database): Promise<boolean> {
  const probe = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(NON_SYSTEM_USER_ROW)
    .limit(1)
    .get();
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
 * still-open window); the decision itself is the single existence-guarded
 * statement (module header — the race argument, now over HUMAN rows: the
 * seeded system principals never win the NOT EXISTS). Returns the created
 * row (the caller mints the session, install.go:479–490 parity) or
 * "already-initialized" — the race loser's clear, terminal verdict.
 */
export async function initializeAdminUser(
  d1: D1Database,
  form: AccountForm,
  options?: { now?: Date },
): Promise<AdminInitOutcome> {
  const invalid = accountFormError(form);
  if (invalid !== null) return { outcome: "invalid", message: invalid };

  // install.go:267-276 — the bootstrap admin's password is REQUIRED
  // (non-empty; the confirm-match arm is the form's retype, filled equal by
  // first-run.ts — upstream `err_empty_admin_password`). NO
  // length/complexity gate on the install arm: upstream validates only
  // non-empty + match here (the CreateUser prepare runs SetPassword
  // directly, user.go:783-794).
  if (form.password === "") {
    return { outcome: "invalid", message: "Administrator password is empty" };
  }

  const now = options?.now ?? new Date();
  const lower = form.username.toLowerCase();
  // The password record is hashed BEFORE the guarded insert so the winning
  // row lands complete (user.go:783-794's prepare step — SetPassword: new
  // salt + current algorithm; rands rides EVERY upstream create, :786).
  const record = await newPasswordRecord(form.password);
  const rands = newSalt();
  // The existence-guarded insert: `meta.changes` is the whole verdict. D1
  // serializes writers, so exactly one concurrent submission sees changes
  // == 1 (module header). The guard rides the SAME NON_SYSTEM_USER_ROW
  // predicate as `initWindowOpen` — GET and POST cannot disagree.
  const result = await drizzle(d1)
    .run(
      sql`INSERT INTO users (username, username_lower, email, display_name, is_admin, status, visibility, type, created_at, passwd, passwd_hash_algo, salt, rands)
          SELECT ${form.username}, ${lower}, ${form.email}, NULL, 1, 'active', 'public', 'user', ${Math.floor(now.getTime() / 1000)}, ${record.passwd}, ${record.passwdHashAlgo}, ${record.salt}, ${rands}
          WHERE NOT EXISTS (SELECT 1 FROM ${users} WHERE ${NON_SYSTEM_USER_ROW})`,
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
// The password arms (SPEC-0002 §6 — PWD-2/M8)
// ---------------------------------------------------------------------------

/**
 * The shared UpdateAuth password-validation ladder's SYNC half (upstream
 * services/user/update.go:256-262): minimum length over
 * `policy.minLength`, complexity over `policy.complexityClasses`. The pwned
 * arm (update.go:263-265) is ASYNC + networked, so it lives in the caller
 * (`isPwned` + the knob's `checkPwned` — the change/reset arms' options and
 * the admin-t2 routes). `policy` defaults to DEFAULT_PASSWORD_POLICY =
 * upstream's DEFAULT config (floor 8, NO complexity — security.go:209-218
 * seeds "off" when the key is unset; the B-87 correction, cited in
 * password-policy.ts's header). Callers with an env thread
 * `resolvePasswordPolicy(env)` so an ARMED config gates them too. Returns
 * the inline message for the caller's re-render, or null when clean.
 */
export function validateNewPassword(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string | null {
  if (password.length < policy.minLength) {
    return `Password length cannot be less than ${policy.minLength} characters.`;
  }
  if (!isComplexEnough(password, policy.complexityClasses)) return buildComplexityError(policy.complexityClasses);
  return null;
}

/**
 * The pwned arm's WEB messages (upstream account.go:88-90 / password.go:
 * 216-219 / auth.go:590-600 flash the locale rows):
 * `auth.password_pwned` (locale_en-US.json:442) with the in-text anchor
 * reduced to the bare URL — the house plain-text flash convention (the
 * BuildComplexityError `<ul>` precedent, census PW15) — and
 * `auth.password_pwned_err` (:443). The API edit arm keeps the RAW error
 * texts instead (admin/user.go:220's `err.Error()`) —
 * password-policy.ts PASSWORD_PWNED_ERROR_TEXT + PwnedResult.message.
 */
export const PASSWORD_PWNED_MESSAGE =
  "The password you chose is on a list of stolen passwords (https://haveibeenpwned.com/Passwords) previously exposed in public data breaches. Please try again with a different password and consider changing this password elsewhere too.";
export const PASSWORD_PWNED_REQUEST_FAILED_MESSAGE = "Could not complete request to HaveIBeenPwned";

/** The pwned arm's message for a resolved check: null = clean (the ladder
 *  continues), else the caller's re-render text. The arm runs ONLY when the
 *  knob is armed (`policy.checkPwned`) — the callers gate it there. */
export function pwnedArmMessage(result: PwnedResult): string | null {
  if (result.kind === "clean") return null;
  return result.kind === "pwned" ? PASSWORD_PWNED_MESSAGE : PASSWORD_PWNED_REQUEST_FAILED_MESSAGE;
}

/** The shared options the async password arms take — the policy (resolved
 *  from env by callers that have it; omitted = upstream's default config)
 *  and the pwned check's injectable fetch (tests; production rides the
 *  runtime global fetch). */
export interface PasswordArmOptions {
  now?: Date;
  policy?: PasswordPolicy;
  fetchImpl?: typeof fetch;
}

export interface ChangePasswordForm {
  oldPassword: string;
  newPassword: string;
  retype: string;
}

export type ChangePasswordOutcome =
  | { outcome: "changed"; user: UserAccountRow }
  | { outcome: "invalid"; message: string };

/**
 * The change-password arm (upstream AccountPost, routers/web/user/setting/
 * account.go:60-96 folded with UpdateAuth's password block, update.go:
 * 247-283): the old-password check when a password IS set, the retype
 * match, the validation ladder, SetPassword, the MustChangePassword=false
 * clear (account.go:78's `optional.Some(false)` — ANY own-password change
 * clears the admin-set must-change flag, the PWD-4 enforcement half), and
 * the invalidation = REMEMBER-ME SESSION ROWS ONLY (upstream
 * DeleteAuthTokensByUserID — live browser sessions and PATs are untouched).
 */
export async function changeOwnPassword(
  d1: D1Database,
  userId: number,
  form: ChangePasswordForm,
  options?: PasswordArmOptions,
): Promise<ChangePasswordOutcome> {
  const db = drizzle(d1);
  const user =
    (await db.select().from(users).where(eq(users.id, userId)).get()) ?? null;
  if (user === null) return { outcome: "invalid", message: "user not found" };

  // account.go:74 — the old password is REQUIRED only when a password is
  // set (IsPasswordSet — a password-less row sets its first password
  // without the old check, upstream's own shape).
  if (user.passwd !== "" && !(await verifyPassword(form.oldPassword, user.passwd, user.salt, user.passwdHashAlgo))) {
    return { outcome: "invalid", message: "The current password is incorrect." };
  }
  if (form.newPassword !== form.retype) {
    return { outcome: "invalid", message: "The passwords do not match." };
  }
  const policy = validateNewPassword(form.newPassword, options?.policy);
  if (policy !== null) return { outcome: "invalid", message: policy };
  // The pwned arm (update.go:263-265) — ONLY when the knob is armed
  // (PASSWORD_CHECK_PWN, default off = upstream's default posture).
  if (options?.policy?.checkPwned === true) {
    const pwned = await isPwned(form.newPassword, { fetchImpl: options?.fetchImpl });
    const message = pwnedArmMessage(pwned);
    if (message !== null) return { outcome: "invalid", message };
  }

  const record = await newPasswordRecord(form.newPassword);
  const updated = await db
    .update(users)
    .set({
      passwd: record.passwd,
      salt: record.salt,
      passwdHashAlgo: record.passwdHashAlgo,
      // account.go:78 — MustChangePassword: optional.Some(false): an
      // own-password change always clears the must-change flag (the PWD-4
      // enforcement half — an admin-created account's forced change lands
      // through here too when the user finishes via the settings tab).
      mustChangePassword: false,
    })
    .where(eq(users.id, userId))
    .returning()
    .all();
  const row = updated[0];
  if (row === undefined) return { outcome: "invalid", message: "user not found" };

  // update.go:279-284 — the invalidation: remember-me rows only (upstream
  // DeleteAuthTokensByUserID), then the audit row (update.go:283).
  const { sessions } = await import("../db/schema");
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.remember, true)));
  const { AuditActions, emitAudit } = await import("./audit");
  void emitAudit(db, {
    action: AuditActions.UserPassword,
    actorId: userId,
    actorName: row.username,
    actorCredential: null,
    scopeType: "user",
    scopeId: userId,
    scopeName: row.username,
    origin: "ui",
    ipAddress: null,
    vars: { scope: row.username },
  }).catch((error: unknown) => {
    console.error(`change-password: audit row failed: ${String(error)}`);
  });

  return { outcome: "changed", user: row };
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

// ---------------------------------------------------------------------------
// Admin user deletion — the upstream DeleteUser ladder over the EXISTING
// repo cascade (SPEC-0004 category f as-built, 2026-10-28)
// ---------------------------------------------------------------------------

/**
 * The deletion's engine arms read four bindings off the generated Env —
 * `DB` for every D1 step, `REGISTRY`/`REPO_TASKS`/`REPO` for the repo
 * cascade's engine half (the tombstone rides `tombstoneRepoDO`, whose
 * signature is the full `Env`, so the parameter is too; both callers — the
 * admin route and the tests — hold the complete generated Env).
 */
export type DeleteUserEnv = Env;

/**
 * One owner's repositories, driven through the EXISTING deleteRepository
 * cascade — the port of upstream `DeleteOwnerRepositoriesDirectly`
 * (services/repository/delete.go:396-421): page over the owner's repos
 * (oldest first, LIMIT 50 — upstream's `RepositoryListDefaultPageSize`
 * re-page loop) and delete each through `RepoService.deleteRepository` with
 * the SAME deps the API's DELETE route and the demo-sweep consumer ride
 * (repos/service.ts §2.5.5: D1 cascade inline, DO tombstone synchronous,
 * R2-prefix purge + destroy enqueued to REPO_TASKS). NOT transactional as a
 * whole, deliberately (upstream's own note, user.go:172-178): each repo's
 * D1 cascade is its own transaction, so a mid-loop failure leaves the
 * already-deleted repos deleted and consistent — a retry deletes the rest.
 * A `RepoNotExistError` per repo is a concurrent delete winning the race;
 * the requested end state already holds (the handleDemoSweep §3.4 posture).
 * The page RE-READS after each pass, so repos created concurrently are
 * captured too (upstream's stated intent, user.go:175-178).
 */
async function deleteOwnerRepositories(env: DeleteUserEnv, ownerId: number): Promise<void> {
  const PAGE_LIMIT = 50; // upstream RepositoryListDefaultPageSize (delete.go:399-403)
  for (;;) {
    const page = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, ownerId))
      .orderBy(asc(repositories.createdAt))
      .limit(PAGE_LIMIT)
      .all();
    if (page.length === 0) return;
    for (const { id } of page) {
      try {
        await new RepoService(env.DB, {
          registry: env.REGISTRY.getByName("registry"),
          queue: env.REPO_TASKS,
          tombstone: (engineName) => tombstoneRepoDO(env, engineName),
        }).deleteRepository(id);
      } catch (error) {
        if (!(error instanceof RepoNotExistError)) throw error;
      }
    }
  }
}

/**
 * The user-deletion cascade behind `DELETE /admin/users/{username}` — the
 * port of upstream `DeleteUser` (services/user/user.go:139-295), which the
 * admin route drives with `ctx.FormBool("purge")` (admin/user.go:303). The
 * ROUTE owns the pre-checks upstream runs before the ladder (org target,
 * self, last-admin — user.go:143-149; the route's 422 mapping at
 * admin/user.go:292-301, 303-311) and, in the non-purge mode, the two
 * count guards upstream checks inside its final transaction (owned repos +
 * org memberships, user.go:234-248 → the route's 422s). Everything below
 * the guards lives here:
 *
 *   1. PURGE — owned repositories (`DeleteOwnerRepositoriesDirectly`,
 *      user.go:179): each through the real deleteRepository cascade
 *      (`deleteOwnerRepositories` above), so D1 rows, engine cells, the
 *      registry index and the R2 prefixes all go — never a silent row drop
 *      that would orphan blobs (the reason the purge arm originally stayed
 *      undistinguished, admin-t2 deviation 2, is cured by this cascade).
 *   2. PURGE — org memberships (user.go:184-219): `RemoveOrgUser` per org
 *      (OrgService.removeMember — the counter/team-sweep-maintaining port);
 *      on the last-owner error upstream DELETES the organization
 *      (`DeleteOrganization(ctx, org, true)`, org.go:209 → services/org/
 *      org.go:58-70, whose purge arm deletes the ORG's repos first) —
 *      mirrored with the same cascade + `OrgService.deleteOrg` (the
 *      SPEC-0007 cascade, which refuses an org that still owns repos).
 *   3. PURGE — packages (user.go:249-253 → RemoveAllPackages): every owned
 *      package through the shared `deletePackageAndReferences` cascade
 *      (versions + files + properties + the package row); blob rows and R2
 *      content keys ride the sole-deleter package-cleanup sweep (the
 *      rows-then-sweep split upstream itself has — see the inline comment).
 *   4. Branch-protection whitelist scrub (delete.go:137-160, the
 *      "***** START: Branch Protections *****" block): the deleted id is
 *      stripped from every allowlist column of every SURVIVING rule —
 *      pre-batch, so a failed scrub aborts the delete (the landed route
 *      arm's ordering; ids are JSON-serialized, hence the full-rule pages).
 *   5. THE CENSUS BATCH — one D1 transaction (delete.go:31-206's
 *      `deleteUser` shape), statement order FK-safe:
 *        a. counter decrements FIRST, while the edge rows they read still
 *           exist: each repo the user stars/watches loses exactly one
 *           `num_stars`/`num_watches` (delete.go:35-53's DecrByIDs; the
 *           UNIQUE(user,repo) pair makes the edge count one; the MAX(…,0)
 *           floor is the landed drift insurance, stars.ts posture), and
 *           upstream's follower counters have no landed users columns —
 *           nothing to decrement for follows (n/a);
 *        b. the FK-less user-associable stores die by id — the DeleteBeans
 *           census (delete.go:74-103) ∩ our FK-less tables: watch,
 *           collaboration, reaction, issue-subscription (the landed route
 *           batch), plus the post-landing families the census names:
 *           notification (Notification{UserID}, :101), stopwatch
 *           (Stopwatch{UserID}, :88), the assignee clear (:187), user
 *           badge (UserBadge{UserID}, :90), the OAuth2 application row
 *           (DeleteOAuth2RelictsByUserID, models/auth/oauth2.go:679-695)
 *           and the user's received action rows (Action{UserID} is the
 *           RECEIVER side, :82 — performed-act copies live on other
 *           receivers' feeds, upstream keeps them);
 *        c. the users row LAST — the declared ON DELETE CASCADE FKs carry
 *           the rest of the census: personal access tokens, sessions, org
 *           memberships, redirects, follows, stars, user settings, email
 *           addresses, public keys, GPG keys, blocks, team memberships
 *           (delete.go:75-103 beans ∩ our FK tables).
 *
 * Upstream keeps issues/comments/reviews/projects as ghost data (the
 * DeleteUser docstring, user.go:139-141) — so do we; the census's
 * purge-gated comment deletion (delete.go:111-135) is NOT ported (a
 * purge deletes the user's comments upstream; ours keeps them, the same
 * ghost posture — documented divergence). The demo sweep stays the
 * fail-safe backstop: hand-D1 user deletes that skip this service leave
 * dangling owned repos, which the DEMO_MODE producer still sweeps.
 */
export async function deleteUserCascade(
  env: DeleteUserEnv,
  userId: number,
  options: { purge?: boolean } = {},
): Promise<void> {
  const d1 = env.DB;
  if (options.purge === true) {
    // Upstream runs the purge arms OUTSIDE the final transaction, each with
    // its own internal transactions (user.go:172-186, 249-253) — mirrored.
    await deleteOwnerRepositories(env, userId);
    const orgService = new OrgService(d1);
    const memberships = await drizzle(d1)
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, userId))
      .all();
    for (const { orgId } of memberships) {
      try {
        await orgService.removeMember(orgId, userId);
      } catch (error) {
        if (!(error instanceof LastOrgOwnerError)) throw error;
        // Upstream deletes the last-owner org — with purge, so the org's
        // own repos go through the same cascade BEFORE deleteOrg (which
        // refuses an org that still owns repos, orgs.ts deleteOrg).
        await deleteOwnerRepositories(env, orgId);
        await orgService.deleteOrg(orgId);
      }
    }

    // Delete Packages (user.go:249-253 → services/packages/packages.go:720-750
    // `RemoveAllPackages`): every package the user owns loses its versions,
    // files and properties through the SAME cascade the protocol deletes and
    // the cleanup rules ride (`deletePackageAndReferences` — the RemovePackage
    // shape, model.ts:621-633; rows only). Blob ROWS and R2 content keys are
    // deliberately NOT touched here — the hourly package-cleanup sweep is the
    // SOLE content-key deleter (ratification 4: a `packages/blobs/…` key is
    // deletable only when zero file rows reference its blob id; cleanup.ts
    // arm (b) deletes the unreferenced-blob rows + R2 keys past the window).
    // That is exactly upstream's split too: RemoveAllPackages deletes rows
    // only and its CleanupTask's DeleteUnreferencedBlobs owns the content
    // store — the purge is best-effort on blobs the same way the normal
    // package delete is.
    const ownerPackageIds = await drizzle(d1)
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.ownerId, userId))
      .all();
    for (const { id } of ownerPackageIds) {
      await deletePackageAndReferences(d1, id);
    }
  }

  // The scrub is pre-batch (upstream runs it inside deleteUser, before the
  // user-row delete — delete.go:137-160); a failure aborts the delete.
  await scrubUserFromAllRules(d1, userId);

  const db = drizzle(d1);
  await db.batch([
    // (a) counter decrements — see the census doc above.
    db
      .update(repositories)
      .set({ numStars: sql`MAX(num_stars - 1, 0)` })
      .where(
        inArray(
          repositories.id,
          db.select({ repoId: stars.repoId }).from(stars).where(eq(stars.userId, userId)),
        ),
      ),
    db
      .update(repositories)
      .set({ numWatches: sql`MAX(num_watches - 1, 0)` })
      .where(
        inArray(
          repositories.id,
          db.select({ repoId: repoWatchers.repoId }).from(repoWatchers).where(eq(repoWatchers.userId, userId)),
        ),
      ),
    // (b) the FK-less census stores.
    db.delete(repoWatchers).where(eq(repoWatchers.userId, userId)),
    db.delete(repoCollaborators).where(eq(repoCollaborators.userId, userId)),
    db.delete(reactions).where(eq(reactions.userId, userId)),
    db.delete(issueSubscriptions).where(eq(issueSubscriptions.userId, userId)),
    db.delete(notificationStates).where(eq(notificationStates.userId, userId)),
    db.delete(issueStopwatches).where(eq(issueStopwatches.userId, userId)),
    db.delete(issueAssignees).where(eq(issueAssignees.assigneeId, userId)),
    db.delete(userBadges).where(eq(userBadges.userId, userId)),
    db.delete(oauth2Applications).where(eq(oauth2Applications.uid, userId)),
    // BOTH action columns: userId is the RECEIVER side, actUserId the ACTOR
    // — the mirror of upstream's delete keyed the receiver alone, so every
    // deleted user's create_repo actor rows orphaned (probe-caught 2026-10-29:
    // the fw battery's user-deletes left action id 387 behind; user 55 gone,
    // act_user_id 55 row survived).
    db.delete(actions).where(or(eq(actions.userId, userId), eq(actions.actUserId, userId))),
    // (c) the row — the FK cascades carry the rest of the census.
    db.delete(users).where(eq(users.id, userId)),
  ]);
}

/**
 * The SHARED UpdateAuth password arm with the MustChangePassword=false
 * clear — upstream's one `UpdateAuth(Password, MustChangePassword:
 * optional.Some(false))` call (services/user/update.go:247-283) answers
 * BOTH no-old-password surfaces at the pin: ResetPasswdPost's apply
 * (routers/web/auth/password.go:204-207) and MustChangePasswordPost's
 * apply (password.go:298-301, the admin-created account's forced change —
 * the PWD-4 enforcement half). NO old-password check: a valid reset code's
 * HMAC already binds the hash data, and the must-change flow's credential
 * IS the live session (password.go:286's NeedChangePassword guard runs in
 * the caller). Ladder + retype match + SetPassword + the mcp clear + the
 * remember-me invalidation + the audit row. The caller owns the code
 * verification and the 2FA arms (reset) or the flag pre-check (must-change).
 */
export async function applyPasswordReset(
  d1: D1Database,
  userId: number,
  newPassword: string,
  retype: string,
  options?: PasswordArmOptions,
): Promise<ChangePasswordOutcome> {
  if (newPassword !== retype) {
    return { outcome: "invalid", message: "The passwords do not match." };
  }
  const policy = validateNewPassword(newPassword, options?.policy);
  if (policy !== null) return { outcome: "invalid", message: policy };
  // The pwned arm (password.go:213-221's UpdateAuth error switch, the same
  // ladder) — ONLY when the knob is armed (PASSWORD_CHECK_PWN).
  if (options?.policy?.checkPwned === true) {
    const pwned = await isPwned(newPassword, { fetchImpl: options?.fetchImpl });
    const message = pwnedArmMessage(pwned);
    if (message !== null) return { outcome: "invalid", message };
  }

  const db = drizzle(d1);
  const record = await newPasswordRecord(newPassword);
  const updated = await db
    .update(users)
    .set({
      passwd: record.passwd,
      salt: record.salt,
      passwdHashAlgo: record.passwdHashAlgo,
      // password.go:206/300 — MustChangePassword: optional.Some(false) on
      // both arms of the shared UpdateAuth call.
      mustChangePassword: false,
    })
    .where(eq(users.id, userId))
    .returning()
    .all();
  const row = updated[0];
  if (row === undefined) return { outcome: "invalid", message: "user not found" };

  const { sessions } = await import("../db/schema");
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.remember, true)));
  const { AuditActions, emitAudit } = await import("./audit");
  void emitAudit(db, {
    action: AuditActions.UserPassword,
    actorId: userId,
    actorName: row.username,
    actorCredential: null,
    scopeType: "user",
    scopeId: userId,
    scopeName: row.username,
    origin: "ui",
    ipAddress: null,
    vars: { scope: row.username },
  }).catch((error: unknown) => {
    console.error(`reset-password: audit row failed: ${String(error)}`);
  });

  return { outcome: "changed", user: row };
}

// ---------------------------------------------------------------------------
// The maintenance sweep — delete_inactive_accounts (census B-68, 2026-11-13)
//
// The port of upstream's `delete_inactive_accounts` cron task — the dashboard
// op and scheduled task the pin registers at services/cron/tasks_extended.go:
// 26-36 (`RegisterTaskFatal("delete_inactive_accounts", …)` over
// `user_service.DeleteInactiveUsers(ctx, config.OlderThan)`). It is the ONE
// member of DashboardPost's fixed maintenance list
// (templates/admin/dashboard.tmpl's 13 rows) with a real cf-gitea substrate;
// the other twelve members' derivations (platform-forced / platform-rooted,
// each with its cite) live in the census row and the dashboard module header.
// ---------------------------------------------------------------------------

/**
 * The task's `OlderThan` window: upstream builds it from the service config —
 * `time.Minute * time.Duration(setting.Service.ActiveCodeLives)`
 * (tasks_extended.go:30) over the setting default `MustInt(180)`
 * (modules/setting/service.go:146) — and this tree has no runtime app.ini, so
 * the DEFAULT stands: 180 minutes, the activation-link lifetime the window
 * mirrors (an account older than the link expiry and still unactivated is
 * sweep-eligible; a fresher registration never is).
 */
export const INACTIVE_ACCOUNT_OLDER_THAN_MS = 180 * 60 * 1000;

/**
 * The B-68 sweep — upstream `DeleteInactiveUsers(ctx, olderThan)`
 * (services/user/user.go:311-334) over `GetInactiveUsers(ctx, olderThan)`
 * (models/user/user.go:1009-1030), adapted to the landed users store:
 *
 *   - Upstream's candidate predicate is `is_active = false` AND type ∈
 *     {individual, user_reserved}, plus `created_unix < now - olderThan`
 *     (the window is always > 0 through the task config). Our store carries
 *     NO `is_active` column — the landed carrier of upstream's inactive
 *     writes is `status = 'prohibited'` (the admin edit route folds BOTH
 *     `active: false` and `prohibit_login: true` onto it, api/routes/
 *     admin-t2.ts's adminEditUser mapping; every HUMAN creation path lands
 *     'active', services/user-accounts.ts's creation arms), and the reserved
 *     variants have no cf-gitea enum value yet (schema note) — so the
 *     predicate is `type = 'user' AND status = 'prohibited' AND created <
 *     cutoff`.
 *   - The migration-seeded SYSTEM service principals (`assets` 0003,
 *     `gitea:deploy-key` 0020) are prohibited-no-email rows upstream has no
 *     analogue for — excluded by `NON_SYSTEM_USER_ROW` VERBATIM (the exact
 *     recorded system-row negation; a human prohibited row always keeps its
 *     creation email, so the exclusion never hides a candidate).
 *   - Per candidate, upstream calls `DeleteUser(ctx, u, false)` — the
 *     NON-purge ladder — and its in-transaction count guards surface as
 *     skip-not-fail: `IsErrUserOwnRepos` / `IsErrUserHasOrgs` /
 *     `IsErrUserOwnPackages` are caught by DeleteInactiveUsers with a
 *     log.Warn + continue (user.go:322-327). Ported as the same three counts
 *     the admin delete route checks (owned repositories, org memberships,
 *     non-internal package versions — admin-t2.ts's guard block, the
 *     user.go:234-255 mapping), each > 0 → SKIP; any OTHER error propagates
 *     and aborts the sweep exactly like upstream's `return err`.
 *   - The deletions ride `deleteUserCascade(env, id)` (non-purge) — the
 *     landed `DeleteUser` ladder above — NOT a bare row delete, so the
 *     census batch, the branch-protection scrub and the redirect handling
 *     all hold. Candidates are non-owners by construction, so the purge
 *     arms never engage.
 *
 * Returns the number of users deleted (the sweep's observable for pins;
 * upstream returns only error/nil). Upstream runs the task fire-and-forget
 * (admin.go:181-186's `go task.RunWithUser`), so its HTTP flash is
 * "Started Task" regardless of the body's outcome and a failure surfaces in
 * the server log only — the dashboard caller mirrors that with
 * catch-and-console.error, never a failure flash.
 */
export async function deleteInactiveAccounts(
  env: DeleteUserEnv,
  options: { now?: Date } = {},
): Promise<number> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - INACTIVE_ACCOUNT_OLDER_THAN_MS);
  const candidates = await drizzle(env.DB)
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(
      and(
        eq(users.type, "user"),
        eq(users.status, "prohibited"),
        lt(users.createdAt, cutoff),
        NON_SYSTEM_USER_ROW,
      ),
    )
    .orderBy(asc(users.id))
    .all();

  const db = drizzle(env.DB);
  let deleted = 0;
  for (const candidate of candidates) {
    // The three skip guards (user.go:234-255's counts → user.go:322-327's
    // continue arms): owned repos, org memberships, non-internal package
    // versions — the exact shapes the admin delete route checks.
    const repoCount = await db
      .select({ total: sql<number>`count(*)` })
      .from(repositories)
      .where(eq(repositories.ownerId, candidate.id))
      .get();
    if ((repoCount?.total ?? 0) > 0) continue;
    const membershipCount = await db
      .select({ total: sql<number>`count(*)` })
      .from(orgMembers)
      .where(eq(orgMembers.userId, candidate.id))
      .get();
    if ((membershipCount?.total ?? 0) > 0) continue;
    const packageCount = await db
      .select({ total: sql<number>`count(*)` })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(and(eq(packages.ownerId, candidate.id), eq(packageVersions.isInternal, false)))
      .get();
    if ((packageCount?.total ?? 0) > 0) continue;

    await deleteUserCascade(env, candidate.id);
    deleted += 1;
  }
  return deleted;
}
