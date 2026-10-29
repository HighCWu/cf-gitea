/**
 * deleteUserCascade's action-table coverage — the probe-caught regression
 * (2026-10-29): the cascade deleted the RECEIVER column (user_id) alone, so
 * every deleted user's ACTOR rows (act_user_id — the create_repo rows their
 * own pushes wrote) orphaned. Observed live on the reference instance by the
 * deploy probe's audit-action-rows check (action id 387 outliving user 55);
 * no route-level suite exercised the cascade's action arm, which is why it
 * shipped. This suite pins BOTH columns delete.
 *
 * The per-test storage reset (apply-d1-migrations.ts's caution note) means
 * each test re-applies the schema before seeding.
 */

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { deleteUserCascade } from "./user-accounts";

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
