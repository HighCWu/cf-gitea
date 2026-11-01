/**
 * The admin user impersonate arm's seam suite (PORT-FIRST: the POST seam is
 * driven DIRECTLY — the ui/index.ts fold is a recorded handoff riding
 * behind the orchestrator's index.ts ownership; the mount recipe lives in
 * the module header). The ROUTE-level halves — the logout exit arm, the
 * banner exposure through the real pipeline — live in session.test.ts
 * (SPEC-0010 §5, the session owner's suite).
 *
 * Coverage (upstream at the pin: web.go:818's route,
 * admin/users.go:563-581's handler over services/auth/impersonate.go):
 *
 *   - THE FLIP (users.go:575-580): a live admin session flips IN PLACE —
 *     user_id = target ∧ impersonator_user_id = admin, the secret (and so
 *     the presented cookie) untouched, the outcome the /user/settings
 *     redirect's.
 *   - THE ALREADY-IMPERSONATING REFUSAL (impersonate.go:16-18,
 *     users.go:575-577 → ServerError): a second impersonate over a live one
 *     refuses WITHOUT overwriting the first admin's backup — the guarded
 *     UPDATE's race property.
 *   - THE UNKNOWN-TARGET ARM (users.go:565-568): JSONError("unable to get
 *     user") — the literal body constant — never a 404, never the avatar
 *     pair's list redirect.
 *   - THE SESSION-GONE ARM: a flip keyed on a vanished row (expired /
 *     reuse-deleted between the §2.4 verify and the write) answers
 *     session-gone, not an impersonation.
 *   - THE ORG-TARGET ARM: any users row passes (orgs ARE users rows,
 *     SPEC-0007 — upstream GetUserByID has no type gate).
 *   - THE BOT GUARD, DOCUMENTED DEAD (users.go:569-571): our users.type
 *     enum has no bot value — pinned by asserting an org-typed target (the
 *     closest non-user type that EXISTS) impersonates like any row.
 *
 * Fixture discipline (the avatar suite's pattern): tables wiped per test
 * (children first), ids captured at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { sessions, users } from "../../db/schema";
import { exitImpersonationBySecret, impersonateSessionUser, lookupValidSession, mintSession, verifySession } from "../session";
import {
  IMPERSONATE_SUCCESS_REDIRECT,
  IMPERSONATE_UNKNOWN_USER_ERROR,
  adminUserImpersonate,
  loadAdminImpersonateTarget,
} from "./admin-users-impersonate";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z (users.createdAt seed data only)

/** Tables the fixtures touch (children first — the org-settings matrix's
 *  cleanup-list convention). */
const FIXTURE_TABLES = ["sessions", "users"];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

interface Seeded {
  adminId: number; // dave — the site admin doing the impersonating
  targetId: number; // alice — the plain user impersonated
}

async function seedUsers(): Promise<Seeded> {
  const inserted = await drizzle(env.DB)
    .insert(users)
    .values([
      { username: "dave", usernameLower: "dave", isAdmin: true, status: "active", createdAt: T0 },
      { username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
    ])
    .returning({ id: users.id })
    .all();
  const dave = inserted[0];
  const alice = inserted[1];
  if (dave === undefined || alice === undefined) throw new Error("seed failed");
  return { adminId: dave.id, targetId: alice.id };
}

/** The impersonating session row's identity halves off the store. */
async function rowIdentity(sessionId: string): Promise<{ userId: number | null; impersonatorUserId: number | null }> {
  const row = await drizzle(env.DB)
    .select({ userId: sessions.userId, impersonatorUserId: sessions.impersonatorUserId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (row === undefined) throw new Error("rowIdentity: session row vanished");
  return row;
}

// --- the flip ----------------------------------------------------------------

describe("adminUserImpersonate (upstream admin.ImpersonateUser, users.go:563-581)", () => {
  it("flips the live session in place: user_id = target, impersonator_user_id = admin, secret untouched", async () => {
    const { adminId, targetId } = await seedUsers();
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";
    const before = await drizzle(env.DB)
      .select({ digest: sessions.sha256Digest, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();

    const outcome = await adminUserImpersonate(env.DB, { sessionId, adminUserId: adminId }, targetId);

    expect(outcome).toEqual({ outcome: "impersonated" });
    expect(await rowIdentity(sessionId)).toEqual({ userId: targetId, impersonatorUserId: adminId });
    // Identity-only flip: the secret (so the presented cookie) and the
    // clocks survive — upstream flips KeyUID inside the live session.
    const after = await drizzle(env.DB)
      .select({ digest: sessions.sha256Digest, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    expect(after?.digest).toBe(before?.digest);
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());

    // The SAME cookie now authenticates AS THE TARGET with the admin
    // backup exposed (the shell banner's channel).
    const verification = await verifySession(env.DB, cookieValue);
    expect(verification.outcome).toBe("authenticated");
    if (verification.outcome !== "authenticated") return;
    expect(verification.user.id).toBe(targetId);
    expect(verification.user.username).toBe("alice");
    expect(verification.user.isAdmin).toBe(false);
    expect(verification.impersonatorUserId).toBe(adminId);
    expect(IMPERSONATE_SUCCESS_REDIRECT).toBe("/user/settings");
  });

  it("refuses a second impersonate (upstream 'already impersonating a user' → ServerError) WITHOUT overwriting the first backup", async () => {
    const { adminId, targetId } = await seedUsers();
    const secondAdmin = (
      await drizzle(env.DB)
        .insert(users)
        .values([{ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: T0 }])
        .returning({ id: users.id })
        .all()
    )[0]!.id;
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";
    expect(
      await adminUserImpersonate(env.DB, { sessionId, adminUserId: adminId }, targetId),
    ).toEqual({ outcome: "impersonated" });

    // The second admin's impersonate over the LIVE one: refused, and the
    // row still carries the FIRST admin's backup (the guarded UPDATE's
    // race property — a lost refusal never rewrites user_id either).
    const outcome = await adminUserImpersonate(env.DB, { sessionId, adminUserId: secondAdmin }, targetId);
    expect(outcome).toEqual({ outcome: "already-impersonating" });
    expect(await rowIdentity(sessionId)).toEqual({ userId: targetId, impersonatorUserId: adminId });

    // The service half pins the same refusal directly.
    expect(await impersonateSessionUser(env.DB, sessionId, secondAdmin, adminId)).toBe("already-impersonating");
  });

  it("answers unknown-user (JSONError literal) — never a 404, never the avatar pair's list redirect", async () => {
    const { adminId, targetId } = await seedUsers();
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";

    const outcome = await adminUserImpersonate(env.DB, { sessionId, adminUserId: adminId }, 424242);

    expect(outcome).toEqual({ outcome: "unknown-user" });
    expect(IMPERSONATE_UNKNOWN_USER_ERROR).toEqual({ errorMessage: "unable to get user", renderFormat: "text" });
    // The miss wrote nothing: the session is untouched.
    expect(await rowIdentity(sessionId)).toEqual({ userId: adminId, impersonatorUserId: null });
    expect(targetId).not.toBe(424242);
  });

  it("answers session-gone when the row vanished between the §2.4 verify and the flip", async () => {
    const { adminId, targetId } = await seedUsers();

    const outcome = await adminUserImpersonate(env.DB, { sessionId: "nosuchrow1", adminUserId: adminId }, targetId);

    expect(outcome).toEqual({ outcome: "session-gone" });
  });

  it("accepts an org-typed users row (orgs ARE users rows — upstream GetUserByID has no type gate)", async () => {
    const { adminId } = await seedUsers();
    const orgId = (
      await drizzle(env.DB)
        .insert(users)
        .values([{ username: "forge", usernameLower: "forge", type: "org", status: "active", createdAt: T0 }])
        .returning({ id: users.id })
        .all()
    )[0]!.id;
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";

    const outcome = await adminUserImpersonate(env.DB, { sessionId, adminUserId: adminId }, orgId);

    expect(outcome).toEqual({ outcome: "impersonated" });
    expect(await rowIdentity(sessionId)).toEqual({ userId: orgId, impersonatorUserId: adminId });
  });
});

// --- the exit arm (service half; the route half is session.test.ts) ----------

describe("exitImpersonationBySecret (upstream ExitImpersonatedUser, impersonate.go:46-63)", () => {
  it("restores user_id from the backup, clears the column, and keeps the same cookie authenticating as the admin", async () => {
    const { adminId, targetId } = await seedUsers();
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";
    expect(await exitImpersonationBySecret(env.DB, cookieValue)).toBe(false); // not impersonating yet
    expect(await impersonateSessionUser(env.DB, sessionId, adminId, targetId)).toBe("impersonating");

    expect(await exitImpersonationBySecret(env.DB, cookieValue)).toBe(true);
    expect(await rowIdentity(sessionId)).toEqual({ userId: adminId, impersonatorUserId: null });

    // The SAME session continues as the admin — upstream keeps the session
    // store entry and flips only the keys (auth.go:474's /-/admin redirect
    // rides the wire in the route test).
    const verification = await verifySession(env.DB, cookieValue);
    expect(verification.outcome).toBe("authenticated");
    if (verification.outcome !== "authenticated") return;
    expect(verification.user.id).toBe(adminId);
    expect(verification.impersonatorUserId).toBeNull();
  });

  it("refuses a wrong-secret exit (the deleteSessionBySecret guard posture) and leaves the backup intact", async () => {
    const { adminId, targetId } = await seedUsers();
    const cookieValue = await mintSession(env.DB, adminId);
    const sessionId = cookieValue.split(":")[0] ?? "";
    expect(await impersonateSessionUser(env.DB, sessionId, adminId, targetId)).toBe("impersonating");

    const forged = `${sessionId}:${"f".repeat(64)}`;
    expect(await exitImpersonationBySecret(env.DB, forged)).toBe(false);
    expect(await rowIdentity(sessionId)).toEqual({ userId: targetId, impersonatorUserId: adminId });
    expect(await lookupValidSession(env.DB, cookieValue)).not.toBeNull();
  });

  it("is false on a garbage cookie and on a vanished row", async () => {
    expect(await exitImpersonationBySecret(env.DB, "nonsense")).toBe(false);
    expect(await exitImpersonationBySecret(env.DB, "nosuchrow1:ab")).toBe(false);
  });
});

// --- the lookup the arm shares ----------------------------------------------

describe("loadAdminImpersonateTarget (GetUserByID, users.go:565-568)", () => {
  it("resolves an existing users row by id and nulls the miss", async () => {
    const { targetId } = await seedUsers();

    expect(await loadAdminImpersonateTarget(env.DB, targetId)).toEqual({ id: targetId });
    expect(await loadAdminImpersonateTarget(env.DB, 987654)).toBeNull();
  });
});
