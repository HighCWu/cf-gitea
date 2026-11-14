/**
 * deleteUserCascade's action-table coverage — the probe-caught regression
 * (2026-10-29): the cascade deleted the RECEIVER column (user_id) alone, so
 * every deleted user's ACTOR rows (act_user_id — the create_repo rows their
 * own pushes wrote) orphaned. Observed live on the reference instance by the
 * deploy probe's audit-action-rows check (action id 387 outliving user 55);
 * no route-level suite exercised the cascade's action arm, which is why it
 * shipped. This suite pins BOTH columns delete.
 *
 * Plus (2026-10-30) the admin-init window's seeded-system premise — the
 * act_runner smoke's finding 4: migration 0003 seeds the `assets` system
 * user on EVERY migrated instance, and the old "users table empty" gate
 * closed the one-shot /install window on fresh deployments. The first-run
 * route suite never saw it — its beforeEach wipes the users table. The
 * bottom describe re-creates the REAL post-migration state (both seeds
 * present) and pins the gate's arms.
 *
 * The per-test storage reset (apply-d1-migrations.ts's caution note) means
 * each test re-applies the schema before seeding.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { AuditActions, findAuditEvents } from "./audit";
import { newPasswordRecord, newSalt, verifyPassword } from "../auth/password";
import { auditEvents, users } from "../db/schema";
import {
  applyPasswordReset,
  changeOwnPassword,
  deleteUserCascade,
  emitUserColumnAuditRows,
  initWindowOpen,
  initializeAdminUser,
} from "./user-accounts";

async function seedActorPair(): Promise<{ actorId: number; receiverId: number }> {
  await applyAuthD1Migrations();
  // The isolation reset is per test FILE in this pool config (observed:
  // the second test hit UNIQUE users.id), so the seed cleans its own ids.
  await env.DB.prepare("DELETE FROM action WHERE repo_id = 'cascade-r1'").run();
  await env.DB.prepare("DELETE FROM users WHERE id IN (9101, 9102)").run();
  const actorId = 9101;
  const receiverId = 9102;
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, 'cascade-actor', 'cascade-actor', 0, 'active', 0, 0), (?, 'cascade-receiver', 'cascade-receiver', 0, 'active', 0, 0)",
  )
    .bind(actorId, receiverId)
    .run();
  // op_type 1 = create_repo. Row 1: user 9101 is the ACTOR (their own push,
  // act_user_id) with 9102 the receiver; row 2: user 9101 is the RECEIVER
  // (user_id) of a foreign actor's action — the actor-delete test expects
  // BOTH dead, the receiver-delete test expects only row 1 dead.
  await env.DB.prepare(
    "INSERT INTO action (user_id, op_type, act_user_id, repo_id, is_deleted, created_unix) VALUES (?, 1, ?, 'cascade-r1', 0, 100), (?, 1, ?, 'cascade-r1', 0, 100)",
  )
    .bind(receiverId, actorId, actorId, 424242)
    .run();
  return { actorId, receiverId };
}

async function survivingRows(): Promise<number> {
  const out = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM action WHERE repo_id = 'cascade-r1'",
  ).first<{ n: number }>();
  return Number(out?.n ?? 0);
}

describe("deleteUserCascade: the action rows (both columns)", () => {
  it("deletes the deleted user's ACTOR rows (act_user_id), not just the receiver side", async () => {
    const { actorId } = await seedActorPair();
    await deleteUserCascade(env, actorId);
    // Pre-fix this was 1: the act_user_id=actorId row survived the cascade.
    expect(await survivingRows()).toBe(0);
  });

  it("deletes the deleted user's RECEIVER rows (user_id) — and only those", async () => {
    const { receiverId } = await seedActorPair();
    await deleteUserCascade(env, receiverId);
    // Row 1 (user_id = the deleted receiver) dies; row 2 (no 9102 column)
    // survives — the cascade never over-deletes foreign rows.
    expect(await survivingRows()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------
// The admin-init window counts HUMANS only — the act_runner smoke's finding 4
// (2026-10-30): migration 0003 seeds the `assets` system user on EVERY
// migrated instance, and the old "users table empty" gate kept the one-shot
// /install window closed on fresh self-hosted deployments. The seeds are the
// codebase's SYSTEM SERVICE PRINCIPALS — `assets` (0003, id 1) and
// `gitea:deploy-key` (0020, id -3, re-asserted on demand by
// api/services/deploy-keys.ts) — always prohibited, non-admin, no email.
// ---------------------------------------------------------------------------------

/**
 * The post-migration users table, hermetic against this file's sibling
 * tests (pool isolation is per FILE here — seedActorPair's note): wipe,
 * then re-assert the two migration seeds EXACTLY as 0003/0020 land them
 * (the shape schema.ts's deploy-keys doc calls "the migration-0003 'assets'
 * reservation row").
 */
async function seedSystemPremise(): Promise<void> {
  await applyAuthD1Migrations();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES " +
      "(1, 'assets', 'assets', 0, 'prohibited', unixepoch()), " +
      "(-3, 'gitea:deploy-key', 'gitea:deploy-key', 0, 'prohibited', unixepoch())",
  ).run();
}

const ADMIN_FORM = { username: "Root", email: "root@example.com", password: "ignored", retype: "ignored" };

describe("the admin-init window counts HUMANS only (act_runner smoke 2026-10-30, finding 4)", () => {
  it("a seeded system user ALONE leaves the window OPEN — and the init insert wins", async () => {
    await seedSystemPremise();
    // `assets` alone (the literal 0003 state — the smoke's dead instance)…
    await env.DB.prepare("DELETE FROM users WHERE id = -3").run();
    expect(await initWindowOpen(env.DB)).toBe(true);
    // …and with the deploy-key principal re-asserted (0020 / on-demand),
    // STILL open — the old gate closed here.
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) " +
        "VALUES (-3, 'gitea:deploy-key', 'gitea:deploy-key', 0, 'prohibited', unixepoch())",
    ).run();
    expect(await initWindowOpen(env.DB)).toBe(true);

    // The one-shot creation itself succeeds on the migrated instance: the
    // first submission WINS despite the seeds (the smoke's dead path).
    const result = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(result.outcome).toBe("created");
    expect(await initWindowOpen(env.DB)).toBe(false);
  });

  it("a seeded system user + one human keeps the window CLOSED (the one-shot holds)", async () => {
    await seedSystemPremise();
    const first = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(first.outcome).toBe("created");

    // Both seeds still sit beside the admin (prohibited + non-admin + no
    // email = the system shape; the admin matches none of it).
    const seeds = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'prohibited' AND is_admin = 0 AND email IS NULL")
      .first<{ n: number }>();
    expect(Number(seeds?.n ?? 0)).toBe(2);
    expect(await initWindowOpen(env.DB)).toBe(false);

    // A second submission still loses — one admin, terminal verdict.
    const second = await initializeAdminUser(env.DB, {
      username: "Second",
      email: "second@example.com",
      password: "x",
      retype: "x",
    });
    expect(second.outcome).toBe("already-initialized");
  });

  it("an org row beside the seeds keeps the window CLOSED (the unified-table semantic)", async () => {
    await seedSystemPremise();
    await env.DB.prepare(
      "INSERT INTO users (username, username_lower, email, is_admin, status, type, created_at) " +
        "VALUES ('Acme', 'acme', 'acme@example.com', 0, 'active', 'org', unixepoch())",
    ).run();
    expect(await initWindowOpen(env.DB)).toBe(false);
  });

  it("a prohibit-logged human NEVER reopens the window (upstream's install lock)", async () => {
    await seedSystemPremise();
    const first = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(first.outcome).toBe("created");
    // The admin gets prohibit_login (the admin PATCH arm): the row keeps its
    // email, so it is STILL human — a bare active-count gate would have
    // resurrected /install here; the identity-of-origin predicate does not.
    await env.DB.prepare("UPDATE users SET status = 'prohibited' WHERE username_lower = 'root'").run();
    expect(await initWindowOpen(env.DB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// B-73's residue — install.go:479's audit row. Upstream initAdminUser records
// `audit.RecordAs(ctx, adminUser, UserCreate, adminUser)` between the CreateUser
// success and the auto-login mint; ours runs at the same point (the created
// verdict, before the caller's session). The loser arms emit nothing.
// ---------------------------------------------------------------------------------

describe("initializeAdminUser's audit row (install.go:479 — B-73's residue)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_event").run();
  });

  it("the created arm records the user:create row — the admin as BOTH actor and scope, origin ui", async () => {
    await seedSystemPremise();
    const result = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(result.outcome).toBe("created");

    const rows = await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserCreate });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorId).toBe(result.outcome === "created" ? result.user.id : -1);
    expect(row.actorName).toBe("Root");
    expect(row.scopeType).toBe("user");
    expect(row.scopeId).toBe(String(result.outcome === "created" ? result.user.id : -1));
    expect(row.scopeName).toBe("Root");
    expect(row.origin).toBe("ui");
    expect(row.message).toBe("Created user Root.");
  });

  it("the race loser (already-initialized) records nothing — only the winner's create emits", async () => {
    await seedSystemPremise();
    const first = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(first.outcome).toBe("created");
    expect(await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserCreate })).toHaveLength(1);

    const second = await initializeAdminUser(env.DB, {
      username: "Second",
      email: "second@example.com",
      password: "x",
      retype: "x",
    });
    expect(second.outcome).toBe("already-initialized");
    expect(await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserCreate })).toHaveLength(1);
  });

  it("an invalid form records nothing (the verdict returns before any insert)", async () => {
    await seedSystemPremise();
    const invalid = await initializeAdminUser(env.DB, { username: "", email: "x@example.com", password: "p", retype: "p" });
    expect(invalid.outcome).toBe("invalid");
    expect(await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserCreate })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------
// Census B-87's consumption half — the configured PASSWORD_HASH_ALGO threading
// (SPEC-THREAD 2026-11-14). The three service arms take the caller's env-resolved
// configuredHashSpec (PasswordArmOptions / the init options bag; the route glue
// bridges configuredPasswordHashAlgo(env).specification — api/config.ts). The pin
// spec "pbkdf2$60000$50" is EXECUTABLE and DISTINCT from the landed default
// ("pbkdf2$50000$50"), so the stored passwd_hash_algo is the observable.
// ---------------------------------------------------------------------------------

const CONFIGURED_SPEC = "pbkdf2$60000$50";
const FLOOR_16_POLICY = { minLength: 16, complexityClasses: [], checkPwned: false };

/** A human row whose password record landed under the DEFAULT arm — the
 *  pre-threading shape every deployed instance carries. */
async function seedPasswordedUser(username: string): Promise<number> {
  await seedSystemPremise();
  const record = await newPasswordRecord("Sup3r-Secret!");
  const [row] = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      email: `${username}@example.com`,
      isAdmin: false,
      status: "active",
      visibility: "public",
      type: "user",
      createdAt: new Date(0),
      passwd: record.passwd,
      salt: record.salt,
      passwdHashAlgo: record.passwdHashAlgo,
      rands: newSalt(),
    })
    .returning({ id: users.id })
    .all();
  return row!.id;
}

describe("the configured-hash-spec threading (census B-87's consumption half — the three arms)", () => {
  it("initializeAdminUser stores the created admin under the CALLER'S configured spec — and verifies under it", async () => {
    await seedSystemPremise();
    const result = await initializeAdminUser(env.DB, ADMIN_FORM, { configuredHashSpec: CONFIGURED_SPEC });
    expect(result.outcome).toBe("created");
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "root")).get())!;
    expect(row.passwdHashAlgo).toBe(CONFIGURED_SPEC);
    expect(await verifyPassword("ignored", row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
  });

  it("initializeAdminUser without the option keeps the landed default arm (the compiles-unchanged contract)", async () => {
    await seedSystemPremise();
    const result = await initializeAdminUser(env.DB, ADMIN_FORM);
    expect(result.outcome).toBe("created");
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "root")).get())!;
    expect(row.passwdHashAlgo).toBe("pbkdf2$50000$50");
  });

  it("changeOwnPassword: an ARMED MIN_PASSWORD_LENGTH floor rejects through the REAL service; a strong password lands under the configured spec (the old-password check still verifies the pre-threading row)", async () => {
    const id = await seedPasswordedUser("specchg");
    const short = await changeOwnPassword(
      env.DB,
      id,
      { oldPassword: "Sup3r-Secret!", newPassword: "A-Short-Pw!", retype: "A-Short-Pw!" },
      { policy: FLOOR_16_POLICY },
    );
    expect(short).toMatchObject({ outcome: "invalid", message: "Password length cannot be less than 16 characters." });

    const changed = await changeOwnPassword(
      env.DB,
      id,
      { oldPassword: "Sup3r-Secret!", newPassword: "A-Long-Enough-Pass!", retype: "A-Long-Enough-Pass!" },
      { policy: FLOOR_16_POLICY, configuredHashSpec: CONFIGURED_SPEC },
    );
    expect(changed).toMatchObject({ outcome: "changed" });
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get())!;
    expect(row.passwdHashAlgo).toBe(CONFIGURED_SPEC);
    expect(await verifyPassword("A-Long-Enough-Pass!", row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
  });

  it("applyPasswordReset (the shared UpdateAuth arm) stores under the configured spec", async () => {
    const id = await seedPasswordedUser("specreset");
    const changed = await applyPasswordReset(env.DB, id, "A-Reset-Pass-Value!", "A-Reset-Pass-Value!", {
      configuredHashSpec: CONFIGURED_SPEC,
    });
    expect(changed).toMatchObject({ outcome: "changed" });
    const row = (await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get())!;
    expect(row.passwdHashAlgo).toBe(CONFIGURED_SPEC);
    expect(await verifyPassword("A-Reset-Pass-Value!", row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// Census B-89 — the UpdateUser audit tail (services/user/update.go:204-218).
// Upstream's shared service tail records one row per ACTUALLY-changed audited
// column against the :68 pre-write snapshot, in fixed order active → admin →
// restricted → visibility; the helper is that tail's port, and these pins hold
// the per-column semantics directly (the write sites' route-level arms live in
// admin-t2.test.ts's PATCH describe).
// ---------------------------------------------------------------------------------

describe("emitUserColumnAuditRows — the UpdateUser audit tail (B-89, update.go:204-218)", () => {
  /** The :68 snapshot shape — plain literals; the helper compares fields, no
   *  row reads of its own. `as const` keeps the enum columns' literal unions
   *  (users.visibility / users.status domains). */
  const BEFORE = { id: 4242, username: "tailtarget", isAdmin: false, visibility: "public", restricted: false, status: "active" } as const;

  beforeEach(async () => {
    await applyAuthD1Migrations();
    await env.DB.prepare("DELETE FROM audit_event").run();
  });

  it("an active-driven flip emits user:status:active with the POSTED value (:204-206)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, { ...BEFORE, status: "prohibited" }, {
      actorId: 1,
      actorName: "root",
      origin: "api",
      activePosted: false,
    });
    const rows = await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserActive });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "user:status:active",
      actorId: 1,
      actorName: "root",
      scopeType: "user",
      scopeId: "4242",
      scopeName: "tailtarget",
      origin: "api",
      message: "Changed activation status of user tailtarget to false.", // the registry template rendered
    });
  });

  it("a prohibit_login-only flip emits NOTHING — upstream's UpdateAuth tail records no prohibit row (:281-293)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, { ...BEFORE, status: "prohibited" }, {
      actorId: 1,
      actorName: "root",
      origin: "api",
      // activePosted undefined: the flip's driver was prohibit_login, whose
      // upstream write arm has no audit tail.
    });
    expect(await findAuditEvents(drizzle(env.DB), { actionPrefix: "user:" })).toHaveLength(0);
  });

  it("an admin flip emits user:status:admin in BOTH directions with the new value (:207-209)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, { ...BEFORE, isAdmin: true }, {
      actorId: 1,
      actorName: "root",
      origin: "api",
    });
    await emitUserColumnAuditRows(env.DB, { ...BEFORE, isAdmin: true }, BEFORE, {
      actorId: 1,
      actorName: "root",
      origin: "api",
    });
    // The read is the raw id-ordered select — findAuditEvents' default sort
    // is timestamp_desc, and same-second rows would reverse the pair.
    const rows = await drizzle(env.DB)
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, AuditActions.UserAdmin))
      .orderBy(asc(auditEvents.id))
      .all();
    expect(rows.map((r) => r.message)).toEqual([
      "Changed admin status of user tailtarget to true.",
      "Changed admin status of user tailtarget to false.",
    ]);
  });

  it("a visibility change emits user:visibility:update with old/new (:213-215)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, { ...BEFORE, visibility: "limited" }, {
      actorId: 1,
      actorName: "root",
      origin: "api",
    });
    const rows = await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserVisibility });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("Changed visibility of user tailtarget from public to limited.");
  });

  it("a restricted flip emits user:status:restricted — the arm fires when a write site lands the column (:210-212)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, { ...BEFORE, restricted: true }, {
      actorId: 1,
      actorName: "root",
      origin: "ui",
    });
    const rows = await findAuditEvents(drizzle(env.DB), { action: AuditActions.UserRestricted });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "ui", message: "Changed restricted status of user tailtarget to true." });
  });

  it("an equal before/after emits NOTHING across the family — the != guards (:204/:207/:210/:213)", async () => {
    await emitUserColumnAuditRows(env.DB, BEFORE, BEFORE, {
      actorId: 1,
      actorName: "root",
      origin: "api",
      activePosted: true, // posted but unchanged — upstream's IsActive true→true is silent too
    });
    expect(await findAuditEvents(drizzle(env.DB), { actionPrefix: "user:" })).toHaveLength(0);
  });

  it("a full-diff emits in upstream order active → admin → restricted → visibility (:204-218's fixed order)", async () => {
    await emitUserColumnAuditRows(
      env.DB,
      BEFORE,
      { ...BEFORE, isAdmin: true, visibility: "private", restricted: true, status: "prohibited" },
      { actorId: 1, actorName: "root", origin: "api", activePosted: false },
    );
    const rows = await drizzle(env.DB).select().from(auditEvents).orderBy(asc(auditEvents.id)).all();
    expect(rows.map((r) => r.action)).toEqual([
      "user:status:active",
      "user:status:admin",
      "user:status:restricted",
      "user:visibility:update",
    ]);
  });
});
