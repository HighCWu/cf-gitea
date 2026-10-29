/**
 * SPEC-0012 §4.4 — the keystore HOME (the M2 port of M1b's parking): the
 * instance crypto material lives in the `system_keystore` D1 rows (the
 * upstream-faithful analog of app.ini `[oauth2] JWT_SECRET` +
 * `<AppDataPath>/jwt/actions_oidc.pem` — see secrets.ts's module header for
 * the cites), behind the loadKeystore swap point.
 *
 * The module-level keystore cache is the isolate's copy of upstream's
 * process-wide signing vars — every test controls it explicitly with
 * resetKeystoreCacheForTests() (the simulated restart), which is also the
 * restart half of the rotation semantics under test.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { systemKeystore } from "../../db/schema";
import {
  KEYSTORE_OIDC_ROW,
  KEYSTORE_R2_KEY,
  KEYSTORE_SECRET_ROW,
  createAuthorizationToken,
  oidcPublicJwk,
  resetKeystoreCacheForTests,
  taskIdFromToken,
} from "./secrets";

const db = () => drizzle(env.DB);

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function storedSecretRow(): Promise<string | undefined> {
  const row = await db().select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_SECRET_ROW)).get();
  if (row === undefined) return undefined;
  return (JSON.parse(row.value) as { tokenSigningSecret: string }).tokenSigningSecret;
}

interface StoredJwk {
  kid: string;
  n?: string;
}

async function storedJwkRow(): Promise<StoredJwk | undefined> {
  const row = await db().select().from(systemKeystore).where(eq(systemKeystore.name, KEYSTORE_OIDC_ROW)).get();
  if (row === undefined) return undefined;
  const piece = JSON.parse(row.value) as { oidcPrivateJwk: StoredJwk };
  return piece.oidcPrivateJwk;
}

beforeEach(async () => {
  await applyAuthD1Migrations();
  // Unlike the actions data tables, the keystore rows are THIS file's test
  // state (every test controls the cold/warm cache boundary itself).
  await db().delete(systemKeystore);
  await env.REPO_PACKS.delete(KEYSTORE_R2_KEY);
  resetKeystoreCacheForTests();
});

describe("the keystore home (system_keystore behind loadKeystore)", () => {
  it("mints once into D1: one cold load writes both rows; a warm load serves from them", async () => {
    const jwk1 = await oidcPublicJwk(env);
    // Both rows landed (the upstream generate-once-save-back analog).
    expect(await storedSecretRow()).toBeDefined();
    const storedJwk = await storedJwkRow();
    expect(storedJwk?.kid).toBe(jwk1.kid);
    // The legacy R2 home is NOT written anymore.
    expect(await env.REPO_PACKS.get(KEYSTORE_R2_KEY)).toBeNull();

    // The restart half: drop the cache (isolate restart) → the material
    // round-trips THROUGH D1 (the rows serve; no regeneration).
    resetKeystoreCacheForTests();
    const jwk2 = await oidcPublicJwk(env);
    expect(jwk2).toEqual(jwk1);
  });

  it("the HS secret round-trips through D1: tokens minted before a restart verify after it", async () => {
    const token = await createAuthorizationToken(env, 42, 7, 9);
    resetKeystoreCacheForTests();
    expect(await taskIdFromToken(env, token, false)).toBe(42);
  });

  it("the kid is upstream's fingerprint spelling: base64url(SHA-256(SPKI DER))", async () => {
    const jwk = await oidcPublicJwk(env);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true, // extractable — the SPKI export below is the test's whole point
      ["verify"],
    );
    const spki = await crypto.subtle.exportKey("spki", publicKey);
    if (!(spki instanceof ArrayBuffer)) throw new Error("SPKI export returned a JWK");
    const kid = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
    expect(jwk.kid).toBe(kid);
  });

  it("rotation is operator-only: replace the row + restart → new material, old tokens invalidated", async () => {
    await oidcPublicJwk(env); // mint
    const oldSecret = await storedSecretRow();
    const oldKid = (await storedJwkRow())?.kid;
    const oldToken = await createAuthorizationToken(env, 42, 7, 9);

    // The operator's out-of-band rotation (upstream: replace the PEM / edit
    // app.ini; here: delete the rows via wrangler d1 execute).
    await db().delete(systemKeystore);
    resetKeystoreCacheForTests(); // the deployment restart

    const newKid = (await oidcPublicJwk(env)).kid;
    const newSecret = await storedSecretRow();
    expect(newKid).not.toBe(oldKid); // fresh key, new JWKS kid
    expect(newSecret).not.toBe(oldSecret);
    // Old tokens fail verification once (the runner re-auths)…
    await expect(taskIdFromToken(env, oldToken, false)).rejects.toThrow();
    // …and the new material verifies its own tokens.
    expect(await taskIdFromToken(env, await createAuthorizationToken(env, 43, 7, 9), false)).toBe(43);
  });

  it("adopts the M1b legacy R2 object on a cold D1 miss, then serves from D1 alone", async () => {
    // Seed a legacy combined keystore object (the M1b shape).
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    if (!("privateKey" in pair)) throw new Error("keygen");
    const legacyJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey & { kid?: string };
    const legacy = {
      tokenSigningSecret: "a".repeat(64),
      oidcPrivateJwk: { ...legacyJwk, kid: "legacy-kid" },
    };
    await env.REPO_PACKS.put(KEYSTORE_R2_KEY, JSON.stringify(legacy));

    // The cold load adopts BOTH pieces into D1.
    const jwk = await oidcPublicJwk(env);
    expect(jwk.kid).toBe("legacy-kid");
    expect(await storedSecretRow()).toBe("a".repeat(64));
    expect((await storedJwkRow())?.kid).toBe("legacy-kid");

    // R2 is no longer needed: wipe it, restart, the same material serves.
    await env.REPO_PACKS.delete(KEYSTORE_R2_KEY);
    resetKeystoreCacheForTests();
    const again = await oidcPublicJwk(env);
    expect(again.kid).toBe("legacy-kid");
    expect(await storedSecretRow()).toBe("a".repeat(64));
  });

  it("a pre-existing row wins the insert race (the on-conflict adoption)", async () => {
    // Simulate a sibling isolate that minted first.
    const now = new Date();
    await db().insert(systemKeystore).values({
      name: KEYSTORE_SECRET_ROW,
      value: JSON.stringify({ v: 1, tokenSigningSecret: "b".repeat(64) }),
      createdAt: now,
      updatedAt: now,
    });
    resetKeystoreCacheForTests();
    await createAuthorizationToken(env, 1, 1, 1);
    expect(await storedSecretRow()).toBe("b".repeat(64)); // adopted, not regenerated
  });

  it("a malformed row fails loud (the deployment-material incident posture)", async () => {
    const now = new Date();
    await db().insert(systemKeystore).values({
      name: KEYSTORE_OIDC_ROW,
      value: "{{{ not json",
      createdAt: now,
      updatedAt: now,
    });
    resetKeystoreCacheForTests();
    await expect(oidcPublicJwk(env)).rejects.toThrow("keystore");
  });
});
