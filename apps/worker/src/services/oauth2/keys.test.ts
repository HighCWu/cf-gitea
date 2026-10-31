/**
 * The signing-key suite (SPEC specs/oauth2-provider.md §5 "Keystore"): the
 * get-or-create race posture (insert-or-nothing + read-back adoption — the
 * conflict-skip arm is pinned by pre-seeding a row the loader must adopt),
 * the kid recipe (base64url(SHA-256(SPKI DER)), recomputed independently
 * from the stored material), the JWKS render per key family (RSA/EC/oct —
 * the oct arm publishes NO secret members), the shared
 * general_token_signing_secret row in the HS arm, and the sibling-row
 * isolation (the Actions OIDC row is never touched).
 */

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { systemKeystore } from "../../db/schema";
import { drizzle } from "drizzle-orm/d1";
import {
  isSymmetricAlgorithm,
  KEYSTORE_OAUTH2_ROW,
  loadOAuth2SigningKey,
  oauth2Jwks,
  resetOAuth2KeyCachesForTests,
  resolveSigningAlgorithm,
} from "./keys";

const T0 = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM system_keystore").run();
  resetOAuth2KeyCachesForTests();
});

afterEach(() => {
  resetOAuth2KeyCachesForTests();
});

function db(): D1Database {
  return env.DB;
}

async function listKeystoreRows(): Promise<Map<string, string>> {
  const rows = await drizzle(env.DB).select().from(systemKeystore).all();
  return new Map(rows.map((row) => [row.name, row.value]));
}

/** The independent kid recomputation: import the stored public half, export
 *  SPKI DER, SHA-256, base64url-nopad — the Actions row's exact recipe.
 *  The public members are spelled explicitly (key_ops/ext never ride —
 *  workerd validates them against the requested usages on import). */
async function expectedKid(privateJwk: JsonWebKey & { kid: string }): Promise<string> {
  const publicJwk: JsonWebKey = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e };
  // EXTRACTABLE in this test-only path: the recomputation exports the SPKI
  // (the module itself derives the kid at generation time, before storage).
  const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
  const spki = (await crypto.subtle.exportKey("spki", key)) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", spki);
  let bin = "";
  for (const b of new Uint8Array(digest)) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("get-or-create over system_keystore (the 0042 posture)", () => {
  it("creates the oauth2_signing_key row once with the Actions row's shape", async () => {
    const key = await loadOAuth2SigningKey(db());
    expect(key.kind).toBe("asymmetric");
    if (key.kind !== "asymmetric") return;
    expect(key.alg).toBe("RS256");
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/); // sha256 → 32 bytes → 43 base64url chars, no padding
    const rows = await listKeystoreRows();
    expect(rows.has(KEYSTORE_OAUTH2_ROW)).toBe(true);
    const material = JSON.parse(rows.get(KEYSTORE_OAUTH2_ROW)!) as { v: number; alg: string; privateJwk: JsonWebKey & { kid: string } };
    expect(material.v).toBe(1);
    expect(material.alg).toBe("RS256");
    expect(material.privateJwk.kid).toBe(key.kid);
    expect(material.privateJwk.d).toBeTypeOf("string"); // the PRIVATE half is at rest
    // createdAt/updatedAt ride the row (the keystore table's shape).
    const row = await drizzle(env.DB).select().from(systemKeystore).all();
    expect(row).toHaveLength(1);
    expect(row[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("is stable across isolate restarts (cache reset → same material from the row)", async () => {
    const first = await loadOAuth2SigningKey(db());
    resetOAuth2KeyCachesForTests();
    const second = await loadOAuth2SigningKey(db());
    expect(second.kind).toBe("asymmetric");
    if (first.kind !== "asymmetric" || second.kind !== "asymmetric") return;
    expect(second.kid).toBe(first.kid);
    expect(second.privateJwk).toEqual(first.privateJwk);
  });

  it("parallel cold loads converge on ONE row (the cache dedupes; the index arbitrates)", async () => {
    const [a, b] = await Promise.all([loadOAuth2SigningKey(db()), loadOAuth2SigningKey(db())]);
    expect(a.kind === "asymmetric" && b.kind === "asymmetric" ? a.kid === b.kid : false).toBe(true);
    const rows = await listKeystoreRows();
    expect(rows.size).toBe(1);
  });

  it("a loser adopts the winner's material: a pre-seeded row is never overwritten", async () => {
    const winner = await loadOAuth2SigningKey(db());
    resetOAuth2KeyCachesForTests();
    // Simulate a concurrent isolate that cold-loads after the row exists:
    // its insert is conflict-skipped and the read-back adopts the winner.
    const adopted = await loadOAuth2SigningKey(db());
    if (winner.kind !== "asymmetric" || adopted.kind !== "asymmetric") return;
    expect(adopted.privateJwk).toEqual(winner.privateJwk);
    const rows = await listKeystoreRows();
    expect(rows.size).toBe(1);
  });

  it("leaves sibling keystore rows untouched (two distinct rows, two distinct kids)", async () => {
    const actionsRow = {
      v: 1,
      oidcPrivateJwk: { kty: "RSA", kid: "actions-kid-placeholder" },
    };
    await drizzle(env.DB)
      .insert(systemKeystore)
      .values({ name: "actions_oidc_signing_key", value: JSON.stringify(actionsRow), createdAt: T0, updatedAt: T0 })
      .onConflictDoNothing();
    const ours = await loadOAuth2SigningKey(db());
    const rows = await listKeystoreRows();
    expect(rows.get("actions_oidc_signing_key")).toBe(JSON.stringify(actionsRow)); // byte-intact
    expect(rows.size).toBe(2);
    if (ours.kind !== "asymmetric") return;
    expect(ours.kid).not.toBe("actions-kid-placeholder");
  });
});

describe("the kid recipe (base64url(SHA-256(SPKI DER)) — CreatePublicKeyFingerprint)", () => {
  it("derives the RSA kid deterministically from the public half", async () => {
    const rsa = await loadOAuth2SigningKey(db(), "RS256");
    if (rsa.kind !== "asymmetric") return;
    expect(rsa.kid).toBe(await expectedKid(rsa.privateJwk));
  });

  it("derives the EC kid with the same recipe (ES256 → P-256)", async () => {
    const es = await loadOAuth2SigningKey(db(), "ES256");
    if (es.kind !== "asymmetric") return;
    expect(es.privateJwk.crv).toBe("P-256");
    // EC: same recipe over the EC SPKI (public members spelled explicitly).
    const ecPublic: JsonWebKey = { kty: es.privateJwk.kty, crv: es.privateJwk.crv, x: es.privateJwk.x, y: es.privateJwk.y };
    const ecKey = await crypto.subtle.importKey("jwk", ecPublic, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    const spki = (await crypto.subtle.exportKey("spki", ecKey)) as ArrayBuffer;
    const digest = await crypto.subtle.digest("SHA-256", spki);
    let bin = "";
    for (const b of new Uint8Array(digest)) {
      bin += String.fromCharCode(b);
    }
    expect(es.privateJwk.kid).toBe(btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""));
  });
});

describe("the JWKS render (OIDCKeys / ToJWK parity)", () => {
  it("renders the RSA public members with kty/alg/kid/use and no private material", async () => {
    const jwks = await oauth2Jwks(db(), "RS256");
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.n).toBeTypeOf("string");
    expect(key.e).toBeTypeOf("string");
    expect(key.d).toBeUndefined();
    expect(key.p).toBeUndefined();
  });

  it("renders the EC members (crv/x/y) for ES256", async () => {
    const jwks = await oauth2Jwks(db(), "ES256");
    const key = jwks.keys[0]!;
    expect(key.kty).toBe("EC");
    expect(key.crv).toBe("P-256");
    expect(key.x).toBeTypeOf("string");
    expect(key.y).toBeTypeOf("string");
    expect(key.d).toBeUndefined();
  });

  it("renders kty/alg ONLY for the HS arm — no secret members (jwtsigningkey.go:69-74)", async () => {
    const jwks = await oauth2Jwks(db(), "HS256");
    expect(jwks.keys).toEqual([{ kty: "oct", alg: "HS256" }]);
  });
});

describe("the symmetric arm rides the shared general_token_signing_secret row", () => {
  it("creates the Actions-shaped secret row and hands the hex secret to signers", async () => {
    const key = await loadOAuth2SigningKey(db(), "HS256");
    expect(key.kind).toBe("symmetric");
    if (key.kind !== "symmetric") return;
    expect(key.alg).toBe("HS256");
    expect(key.secretHex).toMatch(/^[0-9a-f]{64}$/);
    const rows = await listKeystoreRows();
    expect(rows.has("general_token_signing_secret")).toBe(true);
    expect(rows.has(KEYSTORE_OAUTH2_ROW)).toBe(false); // no asymmetric row for an HS deployment
  });

  it("adopts the existing row (shared with the Actions module — one material)", async () => {
    await drizzle(env.DB)
      .insert(systemKeystore)
      .values({ name: "general_token_signing_secret", value: JSON.stringify({ v: 1, tokenSigningSecret: "ab".repeat(32) }), createdAt: T0, updatedAt: T0 })
      .onConflictDoNothing();
    const key = await loadOAuth2SigningKey(db(), "HS384");
    if (key.kind !== "symmetric") return;
    expect(key.secretHex).toBe("ab".repeat(32));
    const rows = await listKeystoreRows();
    expect(rows.size).toBe(1);
  });
});

describe("the configured-algorithm validation + the row mismatch posture", () => {
  it("resolveSigningAlgorithm defaults to RS256 and validates through the jws table", () => {
    expect(resolveSigningAlgorithm(undefined)).toBe("RS256");
    expect(resolveSigningAlgorithm("ES512")).toBe("ES512");
    expect(() => resolveSigningAlgorithm("EdDSA")).toThrow();
  });

  it("isSymmetricAlgorithm splits the arms exactly at the HS family", () => {
    for (const alg of ["HS256", "HS384", "HS512"]) {
      expect(isSymmetricAlgorithm(alg as "HS256")).toBe(true);
    }
    for (const alg of ["RS256", "RS512", "ES256", "ES384", "ES512"]) {
      expect(isSymmetricAlgorithm(alg as "RS256")).toBe(false);
    }
  });

  it("fails closed when the stored key's family differs from the configured alg (rotation named)", async () => {
    await loadOAuth2SigningKey(db(), "RS256"); // seeds an RSA row
    resetOAuth2KeyCachesForTests();
    await expect(loadOAuth2SigningKey(db(), "ES256")).rejects.toThrow(/does not match.*rotate the keystore row/s);
  });
});
