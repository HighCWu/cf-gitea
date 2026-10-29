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

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { deleteUserCascade, initWindowOpen, initializeAdminUser } from "./user-accounts";

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
