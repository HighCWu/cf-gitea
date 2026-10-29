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

import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  actions,
  issueAssignees,
  issueStopwatches,
  issueSubscriptions,
  notificationStates,
  oauth2Applications,
  orgMembers,
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

  const now = options?.now ?? new Date();
  const lower = form.username.toLowerCase();
  // The existence-guarded insert: `meta.changes` is the whole verdict. D1
  // serializes writers, so exactly one concurrent submission sees changes
  // == 1 (module header). The guard rides the SAME NON_SYSTEM_USER_ROW
  // predicate as `initWindowOpen` — GET and POST cannot disagree.
  const result = await drizzle(d1)
    .run(
      sql`INSERT INTO users (username, username_lower, email, display_name, is_admin, status, visibility, type, created_at)
          SELECT ${form.username}, ${lower}, ${form.email}, NULL, 1, 'active', 'public', 'user', ${Math.floor(now.getTime() / 1000)}
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
 *   3. Branch-protection whitelist scrub (delete.go:137-160, the
 *      "***** START: Branch Protections *****" block): the deleted id is
 *      stripped from every allowlist column of every SURVIVING rule —
 *      pre-batch, so a failed scrub aborts the delete (the landed route
 *      arm's ordering; ids are JSON-serialized, hence the full-rule pages).
 *   4. THE CENSUS BATCH — one D1 transaction (delete.go:31-206's
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
    // Upstream runs the two purge arms OUTSIDE the final transaction, each
    // with its own internal transactions (user.go:172-186) — mirrored.
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
