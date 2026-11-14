/**
 * userSignInPassword's rehash-on-login arm under the CONFIGURED hash spec —
 * census B-87's consumption half (SPEC-THREAD 2026-11-14). The service takes
 * the caller's env-resolved `configuredHashSpec` (PasswordSignInOptions; the
 * session/Basic/git callers bridge `configuredPasswordHashAlgo(env).specification`
 * — api/config.ts — in their owners' windows). The pin spec "pbkdf2$60000$50"
 * is executable and DISTINCT from the landed default ("pbkdf2$50000$50"), so
 * the stored passwd_hash_algo is the observable. The verify-only configured
 * arm ("argon2$2$65536$8$50" — parses, verifies, cannot WRITE in this
 * runtime) pins the derived SKIP posture: the rehash is dropped with a server
 * log, the verified login proceeds, the row stays on its verifiable stored
 * algorithm (the derivation lives on the rehash arm's comment in
 * password-auth.ts).
 *
 * Per-test storage reset (apply-d1-migrations.ts's caution note): each test
 * re-applies the schema before seeding.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";
import { userSignInPassword } from "./password-auth";
import { CONFIGURED_HASH_SPEC, hashPasswordWithAlgo, newPasswordRecord, verifyPassword } from "./password";
import { users } from "../db/schema";

const CONFIGURED_SPEC = "pbkdf2$60000$50";
const ARGON2_SPEC = "argon2$2$65536$8$50";
const PASSWORD = "correct horse battery staple";

/** A live human row. Default arm: the landed default record (the
 *  pre-threading shape every deployed instance carries). `storedSpec` /
 *  `storedSalt` override for the migration arms (the digest is recomputed to
 *  match when the salt is overridden, so the row always VERIFIES). */
async function seedPasswordedRow(
  storedSpec?: string,
  storedSalt?: string,
): Promise<number> {
  await applyAuthD1Migrations();
  await env.DB.prepare("DELETE FROM users WHERE username_lower = 'rehashuser'").run();
  const record = await newPasswordRecord(PASSWORD);
  const salt = storedSalt ?? record.salt;
  const passwd =
    storedSalt !== undefined || storedSpec !== undefined
      ? await hashPasswordWithAlgo(PASSWORD, salt, storedSpec ?? record.passwdHashAlgo)
      : record.passwd;
  const [row] = await drizzle(env.DB)
    .insert(users)
    .values({
      username: "RehashUser",
      usernameLower: "rehashuser",
      email: "rehashuser@example.com",
      isAdmin: false,
      status: "active",
      visibility: "public",
      type: "user",
      createdAt: new Date(0),
      passwd,
      salt,
      passwdHashAlgo: storedSpec ?? record.passwdHashAlgo,
      rands: record.salt,
    })
    .returning({ id: users.id })
    .all();
  return row!.id;
}

async function rowOf(id: number) {
  return (await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get())!;
}

beforeEach(async () => {
  await applyAuthD1Migrations();
});

describe("userSignInPassword's rehash-on-login under the configured spec (census B-87's consumption half)", () => {
  it("the DEFAULT arm (no options): a stored default-spec row with a current salt does NOT rehash", async () => {
    const id = await seedPasswordedRow();
    const before = await rowOf(id);
    const result = await userSignInPassword(env.DB, "rehashuser", PASSWORD);
    expect(result).toMatchObject({ ok: true, rehashed: false });
    const after = await rowOf(id);
    expect(after.passwdHashAlgo).toBe(CONFIGURED_HASH_SPEC);
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
  });

  it("the configured spec becomes BOTH the comparison target and the rehash target: a stored default-spec row migrates on login", async () => {
    const id = await seedPasswordedRow();
    const first = await userSignInPassword(env.DB, "rehashuser", PASSWORD, { configuredHashSpec: CONFIGURED_SPEC });
    expect(first).toMatchObject({ ok: true, rehashed: true });
    const row = await rowOf(id);
    expect(row.passwdHashAlgo).toBe(CONFIGURED_SPEC);
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyPassword(PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
    // The migrated row is NOW at the configured spec — the next login stops rehashing.
    const second = await userSignInPassword(env.DB, "rehashuser", PASSWORD, { configuredHashSpec: CONFIGURED_SPEC });
    expect(second).toMatchObject({ ok: true, rehashed: false });
  });

  it("the salt-length migration fires under the configured spec (short stored salt, stored spec already configured)", async () => {
    // "abcd1234" is valid-hex/even-length (the decoder's contract) but 8
    // chars — the pre-322 salt era needsRehash migrates on LENGTH alone.
    const id = await seedPasswordedRow(CONFIGURED_SPEC, "abcd1234");
    const result = await userSignInPassword(env.DB, "rehashuser", PASSWORD, { configuredHashSpec: CONFIGURED_SPEC });
    expect(result).toMatchObject({ ok: true, rehashed: true });
    const row = await rowOf(id);
    expect(row.passwdHashAlgo).toBe(CONFIGURED_SPEC);
    expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyPassword(PASSWORD, row.passwd, row.salt, row.passwdHashAlgo)).toBe(true);
  });

  it("a verify-only configured spec (argon2) SKIPS the rehash — the verified login proceeds and the row stays on its stored algorithm", async () => {
    const id = await seedPasswordedRow();
    const before = await rowOf(id);
    const result = await userSignInPassword(env.DB, "rehashuser", PASSWORD, { configuredHashSpec: ARGON2_SPEC });
    expect(result).toMatchObject({ ok: true, rehashed: false });
    const after = await rowOf(id);
    expect(after.passwdHashAlgo).toBe(CONFIGURED_HASH_SPEC); // NOT the argon2 spec — the write refused
    expect(after.passwd).toBe(before.passwd);
    expect(after.salt).toBe(before.salt);
    expect(await verifyPassword(PASSWORD, after.passwd, after.salt, after.passwdHashAlgo)).toBe(true);
  });

  it("a wrong password under a configured spec fails with no write (the ladder's order holds)", async () => {
    const id = await seedPasswordedRow();
    const before = await rowOf(id);
    const result = await userSignInPassword(env.DB, "rehashuser", "not-the-password", {
      configuredHashSpec: CONFIGURED_SPEC,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: "password-invalid" } });
    const after = await rowOf(id);
    expect(after.passwd).toBe(before.passwd);
    expect(after.passwdHashAlgo).toBe(before.passwdHashAlgo);
  });
});
