/**
 * TokenService integration tests on real D1 (SPEC-0002 §5): mint→verify
 * roundtrip, wrong/expired/revoked credentials, normalization, child-scope
 * and public-only mint rules, prefix-collision retry, list pagination,
 * name lookup, throttled last_used_at.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  EmptyTokenScopeError,
  InvalidTokenScopeError,
  TokenNameExistsError,
  TokenNameTooLongError,
  TokenPrefixCollisionError,
  TokenScopeEscalationError,
} from "./errors";
import { LAST_USED_THROTTLE_MS, TokenService } from "./token-service";
import { tokenFromRandomBytes, type GeneratedToken } from "./token-format";
import { users } from "../db/schema";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";
import { resetAuthTables } from "./testing/seeds";

beforeAll(applyAuthD1Migrations);
beforeEach(resetAuthTables);

const db = () => drizzle(env.DB);

interface SeedUserOptions {
  username?: string;
  isAdmin?: boolean;
  status?: "active" | "prohibited";
}

async function seedUser(options: SeedUserOptions = {}): Promise<{ id: number; username: string }> {
  const username = options.username ?? "Alice";
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: options.status ?? "active",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

const service = (): TokenService => new TokenService(env.DB);

describe("mint → verify roundtrip", () => {
  it("verifies a minted token back to its owner", async () => {
    const user = await seedUser();
    const minted = await service().mint({ userId: user.id, name: "cli", scopes: "write:user" });

    expect(minted.plaintext).toMatch(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/);
    const verified = await service().verify(minted.plaintext);
    expect(verified).not.toBeNull();
    expect(verified?.user.id).toBe(user.id);
    expect(verified?.user.username).toBe("Alice");
    expect(verified?.token.name).toBe("cli");
    expect(verified?.token.scopes).toBe("write:user");
  });

  it("normalizes the scope string before storage", async () => {
    const user = await seedUser();
    const minted = await service().mint({
      userId: user.id,
      name: "normalized",
      scopes: "read:user,write:user,write:user",
    });
    expect(minted.scopes).toBe("write:user");
    expect((await service().verify(minted.plaintext))?.token.scopes).toBe("write:user");
  });

  it("keeps no-token-scope as a valid stored scope", async () => {
    const user = await seedUser();
    const minted = await service().mint({ userId: user.id, name: "scopeless", scopes: "no-token-scope" });
    expect(minted.scopes).toBe("no-token-scope");
    expect(await service().verify(minted.plaintext)).not.toBeNull();
  });

  it("never stores the plaintext: digest column holds sha256 hex", async () => {
    const user = await seedUser();
    const minted = await service().mint({ userId: user.id, name: "atrest", scopes: "read:user" });
    const rows = await env.DB.prepare("SELECT sha256_digest, prefix FROM personal_access_tokens WHERE id = ?")
      .bind(minted.id)
      .all<{ sha256_digest: string; prefix: string }>();
    expect(rows.results[0]?.prefix).toBe(minted.prefix);
    expect(rows.results[0]?.sha256_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.results[0]?.sha256_digest).not.toContain(minted.plaintext);
  });
});

describe("verify failure states (all ≡ unknown credential)", () => {
  it("rejects an unknown prefix", async () => {
    expect(await service().verify("cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });

  it("rejects a too-short value (upstream len>=8 gate)", async () => {
    expect(await service().verify("short")).toBeNull();
  });

  it("rejects a same-prefix wrong secret (digest mismatch)", async () => {
    const user = await seedUser();
    const minted = await service().mint({ userId: user.id, name: "t", scopes: "read:user" });
    // Flip the last base32 char into a different in-alphabet char.
    const original = minted.plaintext.at(-1) as string;
    const replacement = original === "A" ? "B" : "A";
    const forged = minted.plaintext.slice(0, -1) + replacement;
    expect(forged).not.toBe(minted.plaintext);
    expect(forged.slice(0, 12)).toBe(minted.plaintext.slice(0, 12));
    expect(await service().verify(forged)).toBeNull();
  });

  it("rejects an expired token with the same unknown-credential result", async () => {
    const user = await seedUser();
    const expired = await service().mint({
      userId: user.id,
      name: "expired",
      scopes: "read:user",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service().verify(expired.plaintext)).toBeNull();

    const future = await service().mint({
      userId: user.id,
      name: "future",
      scopes: "read:user",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await service().verify(future.plaintext)).not.toBeNull();
  });

  it("rejects a revoked token on the next lookup", async () => {
    const user = await seedUser();
    const svc = service();
    const minted = await svc.mint({ userId: user.id, name: "revoked", scopes: "read:user" });
    expect(await svc.verify(minted.plaintext)).not.toBeNull();
    expect(await svc.revoke(user.id, minted.id)).toBe(true);
    expect(await svc.verify(minted.plaintext)).toBeNull();
  });
});

describe("mint validation (upstream 400 precedence)", () => {
  it("duplicate name per user → exact upstream message", async () => {
    const user = await seedUser();
    const svc = service();
    await svc.mint({ userId: user.id, name: "dup", scopes: "read:user" });
    await expect(svc.mint({ userId: user.id, name: "dup", scopes: "read:user" })).rejects.toThrow(
      new TokenNameExistsError(),
    );
    // Same name on another user is fine.
    const other = await seedUser({ username: "Bob" });
    await expect(svc.mint({ userId: other.id, name: "dup", scopes: "read:user" })).resolves.not.toBeNull();
  });

  it("invalid scope → upstream-wrapped message", async () => {
    const user = await seedUser();
    await expect(service().mint({ userId: user.id, name: "bad", scopes: "banana" })).rejects.toThrow(
      new InvalidTokenScopeError("invalid access token scope: banana"),
    );
  });

  it("empty scope → exact upstream message", async () => {
    const user = await seedUser();
    await expect(service().mint({ userId: user.id, name: "empty", scopes: "" })).rejects.toThrow(
      new EmptyTokenScopeError(),
    );
  });

  it("name longer than 255 chars → 400", async () => {
    const user = await seedUser();
    await expect(service().mint({ userId: user.id, name: "x".repeat(256), scopes: "read:user" })).rejects.toThrow(
      TokenNameTooLongError,
    );
  });

  it("duplicate-name check precedes scope validation (upstream order)", async () => {
    const user = await seedUser();
    const svc = service();
    await svc.mint({ userId: user.id, name: "dup2", scopes: "read:user" });
    await expect(svc.mint({ userId: user.id, name: "dup2", scopes: "banana" })).rejects.toThrow(
      TokenNameExistsError,
    );
  });
});

describe("mint child-scope and public-only rules", () => {
  it("rejects minting a broader scope than the authenticating token", async () => {
    const user = await seedUser();
    const svc = service();
    await expect(
      svc.mint({ userId: user.id, name: "esc", scopes: "write:user", mintedByScope: "read:user" }),
    ).rejects.toThrow(new TokenScopeEscalationError());
    await expect(
      svc.mint({ userId: user.id, name: "ok", scopes: "read:user", mintedByScope: "write:user" }),
    ).resolves.not.toBeNull();
  });

  it("carries public-only down from a public-only parent", async () => {
    const user = await seedUser();
    const minted = await service().mint({
      userId: user.id,
      name: "carry",
      scopes: "read:user",
      mintedByScope: "read:user,public-only",
    });
    expect(minted.scopes).toBe("public-only,read:user");
  });

  it("does not add public-only when the parent lacks it", async () => {
    const user = await seedUser();
    const minted = await service().mint({
      userId: user.id,
      name: "nocarry",
      scopes: "read:user",
      mintedByScope: "write:user",
    });
    expect(minted.scopes).toBe("read:user");
  });
});

describe("prefix-collision retry (SPEC-0002 §3)", () => {
  it("retries generation on a unique-prefix violation and eventually succeeds", async () => {
    const user = await seedUser();
    const colliding: GeneratedToken = tokenFromRandomBytes(new Uint8Array(24).fill(1));
    // Seed a row already holding the colliding prefix.
    await env.DB.prepare(
      "INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, created_at) VALUES (?, 'seeded', ?, 'deadbeef', 'read:user', unixepoch())",
    )
      .bind(user.id, colliding.prefix)
      .run();

    let generation = 0;
    const generator = (): GeneratedToken => {
      generation++;
      return generation === 1 ? colliding : tokenFromRandomBytes(new Uint8Array(24).fill(2 + generation));
    };
    const minted = await new TokenService(env.DB, { tokenGenerator: generator }).mint({
      userId: user.id,
      name: "after-collision",
      scopes: "read:user",
    });
    expect(generation).toBe(2);
    expect(minted.prefix).not.toBe(colliding.prefix);
    expect(await new TokenService(env.DB).verify(minted.plaintext)).not.toBeNull();
  });

  it("gives up after three attempts with the collision error", async () => {
    const user = await seedUser();
    const colliding: GeneratedToken = tokenFromRandomBytes(new Uint8Array(24).fill(9));
    await env.DB.prepare(
      "INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, created_at) VALUES (?, 'seeded', ?, 'deadbeef', 'read:user', unixepoch())",
    )
      .bind(user.id, colliding.prefix)
      .run();
    const generator = (): GeneratedToken => colliding;
    await expect(
      new TokenService(env.DB, { tokenGenerator: generator }).mint({
        userId: user.id,
        name: "always-collides",
        scopes: "read:user",
      }),
    ).rejects.toThrow(TokenPrefixCollisionError);
  });
});

describe("list pagination + name lookup", () => {
  it("pages with total count", async () => {
    const user = await seedUser();
    const svc = service();
    for (let i = 0; i < 5; i++) {
      await svc.mint({ userId: user.id, name: `t${i}`, scopes: "read:user" });
    }
    const page1 = await svc.list(user.id, 1, 2);
    expect(page1.total).toBe(5);
    expect(page1.tokens).toHaveLength(2);

    const page3 = await svc.list(user.id, 3, 2);
    expect(page3.tokens).toHaveLength(1);

    const page4 = await svc.list(user.id, 4, 2);
    expect(page4.tokens).toHaveLength(0);
  });

  it("isolates per-user listings", async () => {
    const alice = await seedUser({ username: "Alice2" });
    const bob = await seedUser({ username: "Bob2" });
    const svc = service();
    await svc.mint({ userId: alice.id, name: "alice-only", scopes: "read:user" });
    expect((await svc.list(bob.id, 1, 10)).total).toBe(0);
  });

  it("finds tokens by exact name", async () => {
    const user = await seedUser();
    const svc = service();
    await svc.mint({ userId: user.id, name: "unique-name", scopes: "read:user" });
    const found = await svc.findByName(user.id, "unique-name");
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("unique-name");
    expect(await svc.findByName(user.id, "missing")).toHaveLength(0);
  });
});

describe("throttled last_used_at (SPEC-0002 §2.7)", () => {
  it("touches a never-used token, then throttles for 24h", async () => {
    const user = await seedUser();
    const svc = service();
    const minted = await svc.mint({ userId: user.id, name: "throttle", scopes: "read:user" });
    const firstUse = new Date("2026-10-01T00:00:00Z");
    expect(svc.needsLastUsedTouch(minted, firstUse)).toBe(true);

    await svc.touchLastUsed(minted.id, firstUse);
    const stored = await svc.list(user.id, 1, 10);
    expect(stored.tokens[0]?.lastUsedAt?.getTime()).toBe(firstUse.getTime());

    const refreshed = stored.tokens[0];
    if (refreshed === undefined) throw new Error("throttled token vanished");

    const withinWindow = new Date(firstUse.getTime() + LAST_USED_THROTTLE_MS - 60_000);
    expect(svc.needsLastUsedTouch(refreshed, withinWindow)).toBe(false);

    const afterWindow = new Date(firstUse.getTime() + LAST_USED_THROTTLE_MS);
    expect(svc.needsLastUsedTouch(refreshed, afterWindow)).toBe(true);
  });
});

describe("user lookups", () => {
  it("resolves users case-insensitively (lower_name semantics)", async () => {
    const user = await seedUser({ username: "MixedCase" });
    const svc = service();
    expect((await svc.getUserByName("mixedcase"))?.id).toBe(user.id);
    expect((await svc.getUserByName("MIXEDCASE"))?.id).toBe(user.id);
    expect(await svc.getUserByName("ghost")).toBeNull();
  });

  it("deleting a user cascades their tokens", async () => {
    const user = await seedUser({ username: "Cascade" });
    const svc = service();
    await svc.mint({ userId: user.id, name: "doomed", scopes: "read:user" });
    await db().delete(users).where(eq(users.id, user.id)).run();
    expect((await svc.list(user.id, 1, 10)).total).toBe(0);
  });
});
