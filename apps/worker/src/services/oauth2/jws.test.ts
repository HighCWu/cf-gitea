/**
 * The JWS primitive suite (SPEC specs/oauth2-provider.md §5 "JWS unit"):
 * sign→verify round-trips for every alg in the table over real WebCrypto
 * (workerd), the kid/alg header shape, alg-pinning (ParseToken's no-
 * algorithm-confusion rule), tamper rejection, the zero-leeway exp/nbf
 * arms (golang-jwt v5's default validator parity) and the API-path's
 * stricter exp/iat gate (services/auth/oauth2.go:53), the HS client-secret
 * arm, and the ES256 JOSE-raw-signature alignment pinned against RFC
 * 7515 appendix A.3's fixed vector.
 */

import { describe, expect, it } from "vitest";

import {
  assertApiTimeBounds,
  assertSigningAlgorithm,
  DEFAULT_SIGNING_ALGORITHM,
  importSigningKey,
  importVerifyKey,
  publicJwkOf,
  signJws,
  SIGNING_ALGORITHMS,
  verifyJws,
  type JwsAlgorithm,
} from "./jws";

const T0 = 1767225600; // 2026-01-01T00:00:00Z in unix seconds

async function generateAsymmetric(alg: JwsAlgorithm): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const suffix = alg.slice(2) as "256" | "384" | "512";
  const hash: "SHA-256" | "SHA-384" | "SHA-512" = `SHA-${suffix}`;
  const params =
    alg[0] === "R"
      ? ({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash } as const)
      : ({ name: "ECDSA", namedCurve: suffix === "256" ? "P-256" : suffix === "384" ? "P-384" : "P-521" } as const);
  const pair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("keygen did not return a pair");
  }
  return {
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
  };
}

describe("assertSigningAlgorithm (the upstream set, EdDSA rejected-until-proven)", () => {
  it("accepts every alg of the upstream table (minus EdDSA) and defaults to RS256", () => {
    for (const alg of SIGNING_ALGORITHMS) {
      expect(assertSigningAlgorithm(alg)).toBe(alg);
    }
    expect(SIGNING_ALGORITHMS).toHaveLength(9);
    expect(DEFAULT_SIGNING_ALGORITHM).toBe("RS256");
  });

  it("rejects EdDSA with the recorded-deferrence message (SPEC §2.10 divergence (c))", () => {
    expect(() => assertSigningAlgorithm("EdDSA")).toThrow(/EdDSA.*rejected-until-proven/s);
  });

  it("rejects everything else with upstream's ErrInvalidAlgorithmType text (jwtsigningkey.go:16-20)", () => {
    expect(() => assertSigningAlgorithm("none")).toThrow("JWT signing algorithm is not supported: none");
    expect(() => assertSigningAlgorithm("RS256D")).toThrow("JWT signing algorithm is not supported: RS256D");
    expect(() => assertSigningAlgorithm("")).toThrow("JWT signing algorithm is not supported: ");
  });
});

describe("sign → verify round-trips per algorithm", () => {
  it("round-trips RS256 with the kid/typ header shape (PreProcessToken parity)", async () => {
    const { privateJwk } = await generateAsymmetric("RS256");
    const key = await importSigningKey("RS256", privateJwk);
    const token = await signJws({ alg: "RS256", key, claims: { gnt: 7, tt: 0, exp: T0 + 3600 }, kid: "kid-1", nowSec: T0 });
    const verifyKey = await importVerifyKey("RS256", publicJwkOf(privateJwk));
    const verified = await verifyJws({ alg: "RS256", key: verifyKey, token, nowSec: T0 });
    expect(verified.header).toEqual({ alg: "RS256", kid: "kid-1", typ: "JWT" });
    expect(verified.claims).toEqual({ gnt: 7, tt: 0, exp: T0 + 3600, iat: T0 });
  });

  it("round-trips every algorithm in the table (the full accepted set minus EdDSA)", async () => {
    for (const alg of SIGNING_ALGORITHMS) {
      const claims = { gnt: 3, tt: 1, cnt: 2, exp: T0 + 60 };
      let token: string;
      let verifyKey: CryptoKey;
      if (alg[0] === "H") {
        // The HS client-secret arm: the key material is a raw secret
        // STRING (an id_token signed with the client secret — §2.4).
        const signKey = await importSigningKey(alg, "gto_aclientsecret");
        verifyKey = await importVerifyKey(alg, "gto_aclientsecret");
        token = await signJws({ alg, key: signKey, claims });
      } else {
        const { privateJwk } = await generateAsymmetric(alg);
        const signKey = await importSigningKey(alg, privateJwk);
        verifyKey = await importVerifyKey(alg, publicJwkOf(privateJwk));
        token = await signJws({ alg, key: signKey, claims, kid: "k" });
      }
      const verified = await verifyJws({ alg, key: verifyKey, token, nowSec: T0 });
      expect(verified.claims.gnt).toBe(3);
      expect(verified.claims.tt).toBe(1);
    }
  });

  it("carries no kid header when none is passed (hmacSigningKey.PreProcessToken no-op parity)", async () => {
    const signKey = await importSigningKey("HS256", "secret");
    const token = await signJws({ alg: "HS256", key: signKey, claims: { gnt: 1 } });
    const verifyKey = await importVerifyKey("HS256", "secret");
    const verified = await verifyJws({ alg: "HS256", key: verifyKey, token, nowSec: T0 });
    expect(verified.header).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("verifies with the public half only — a foreign key fails", async () => {
    const a = await generateAsymmetric("ES256");
    const b = await generateAsymmetric("ES256");
    const signKey = await importSigningKey("ES256", a.privateJwk);
    const token = await signJws({ alg: "ES256", key: signKey, claims: { gnt: 1 }, nowSec: T0 });
    const goodKey = await importVerifyKey("ES256", publicJwkOf(a.privateJwk));
    await expect(verifyJws({ alg: "ES256", key: goodKey, token, nowSec: T0 })).resolves.toBeTruthy();
    const foreignKey = await importVerifyKey("ES256", publicJwkOf(b.privateJwk));
    await expect(verifyJws({ alg: "ES256", key: foreignKey, token, nowSec: T0 })).rejects.toThrow("invalid token");
  });

  it("signs the HS id_token arm with the CLIENT secret and rejects other secrets", async () => {
    const clientSecret = "gto_thebuiltinclientssecret";
    const signKey = await importSigningKey("HS256", clientSecret);
    const token = await signJws({ alg: "HS256", key: signKey, claims: { iss: "http://s", aud: "client", sub: "5" }, nowSec: T0 });
    await expect(verifyJws({ alg: "HS256", key: await importVerifyKey("HS256", clientSecret), token, nowSec: T0 })).resolves.toBeTruthy();
    await expect(
      verifyJws({ alg: "HS256", key: await importVerifyKey("HS256", "gto_asecondsecret"), token, nowSec: T0 }),
    ).rejects.toThrow("invalid token");
  });
});

describe("alg pinning + tamper rejection (ParseToken parity, token.go:44-46)", () => {
  it("rejects a token whose header alg differs from the expected algorithm", async () => {
    const hsKey = await importSigningKey("HS256", "secret");
    const hsToken = await signJws({ alg: "HS256", key: hsKey, claims: { gnt: 1 } });
    // Declared alg HS256, expected RS256: the pin fires before any key work.
    const rsa = await generateAsymmetric("RS256");
    const rsaVerify = await importVerifyKey("RS256", publicJwkOf(rsa.privateJwk));
    await expect(verifyJws({ alg: "RS256", key: rsaVerify, token: hsToken, nowSec: T0 })).rejects.toThrow(
      "unexpected signing algo: HS256",
    );
  });

  it("rejects an asymmetric token presented under the HS expectation (no algorithm confusion)", async () => {
    const rsa = await generateAsymmetric("RS256");
    const signKey = await importSigningKey("RS256", rsa.privateJwk);
    const token = await signJws({ alg: "RS256", key: signKey, claims: { gnt: 1 } });
    const hsKey = await importVerifyKey("HS256", "secret");
    await expect(verifyJws({ alg: "HS256", key: hsKey, token, nowSec: T0 })).rejects.toThrow("unexpected signing algo: RS256");
  });

  it("rejects a tampered payload (constant-time verify, signature mismatch)", async () => {
    const hsKey = await importSigningKey("HS256", "secret");
    const token = await signJws({ alg: "HS256", key: hsKey, claims: { gnt: 1, tt: 0 }, nowSec: T0 });
    const [header, , signature] = token.split(".");
    const forgedPayload = btoa(JSON.stringify({ gnt: 2, tt: 0 })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const verifyKey = await importVerifyKey("HS256", "secret");
    await expect(verifyJws({ alg: "HS256", key: verifyKey, token: `${header}.${forgedPayload}.${signature}`, nowSec: T0 })).rejects.toThrow(
      "invalid token",
    );
  });

  it("rejects junk shapes: wrong part count, undecodable header, undecodable signature", async () => {
    const key = await importVerifyKey("HS256", "secret");
    await expect(verifyJws({ alg: "HS256", key, token: "a.b", nowSec: T0 })).rejects.toThrow("invalid token");
    await expect(verifyJws({ alg: "HS256", key, token: "!!!.e30.AA", nowSec: T0 })).rejects.toThrow("invalid token");
    await expect(verifyJws({ alg: "HS256", key, token: "eyJhbGciOiJIUzI1NiJ9.e30.%%%%", nowSec: T0 })).rejects.toThrow();
  });
});

describe("claim validation: zero-leeway exp/nbf (golang-jwt v5 default-validator parity)", () => {
  async function tokenWithClaims(claims: object): Promise<{ token: string; key: CryptoKey }> {
    const key = await importVerifyKey("HS256", "secret");
    const signKey = await importSigningKey("HS256", "secret");
    return { token: await signJws({ alg: "HS256", key: signKey, claims }), key };
  }

  it("accepts exp == now + 1, rejects exp == now (v5: now >= exp ⇒ expired)", async () => {
    const ok = await tokenWithClaims({ gnt: 1, exp: T0 + 1 });
    await expect(verifyJws({ alg: "HS256", key: ok.key, token: ok.token, nowSec: T0 })).resolves.toBeTruthy();
    const boundary = await tokenWithClaims({ gnt: 1, exp: T0 });
    await expect(verifyJws({ alg: "HS256", key: boundary.key, token: boundary.token, nowSec: T0 })).rejects.toThrow("token is expired");
  });

  it("rejects a future nbf at zero leeway and accepts nbf == now", async () => {
    const future = await tokenWithClaims({ gnt: 1, nbf: T0 + 1 });
    await expect(verifyJws({ alg: "HS256", key: future.key, token: future.token, nowSec: T0 })).rejects.toThrow("token is not valid yet");
    const boundary = await tokenWithClaims({ gnt: 1, nbf: T0 });
    await expect(verifyJws({ alg: "HS256", key: boundary.key, token: boundary.token, nowSec: T0 })).resolves.toBeTruthy();
  });

  it("does NOT validate iat here — the API path's gate is a separate export (oauth2.go:53 asymmetry)", async () => {
    const { token, key } = await tokenWithClaims({ gnt: 1, exp: T0 + 100, iat: T0 + 50 });
    await expect(verifyJws({ alg: "HS256", key, token, nowSec: T0 })).resolves.toBeTruthy();
  });

  it("tokens without exp/nbf verify (v5 validates only when present)", async () => {
    const { token, key } = await tokenWithClaims({ gnt: 1 });
    await expect(verifyJws({ alg: "HS256", key, token, nowSec: T0 + 100000 })).resolves.toBeTruthy();
  });

  it("skipClaimValidation decodes claims without the time arms (raw-signature arms)", async () => {
    const { token, key } = await tokenWithClaims({ gnt: 1, exp: 1 });
    await expect(verifyJws({ alg: "HS256", key, token, skipClaimValidation: true })).resolves.toBeTruthy();
  });
});

describe("assertApiTimeBounds (services/auth/oauth2.go:53 — the API path's second gate)", () => {
  it("rejects exp < now and accepts exp == now (ExpiresAt.Before is strict)", () => {
    expect(() => assertApiTimeBounds({ exp: T0 - 1, iat: T0 - 10 }, T0)).toThrow("token is expired");
    expect(() => assertApiTimeBounds({ exp: T0, iat: T0 }, T0)).not.toThrow();
  });

  it("rejects iat > now and accepts iat == now (IssuedAt.After is strict)", () => {
    expect(() => assertApiTimeBounds({ exp: T0 + 10, iat: T0 + 1 }, T0)).toThrow("token issued in the future");
    expect(() => assertApiTimeBounds({ exp: T0 + 10, iat: T0 }, T0)).not.toThrow();
  });

  it("tokens without exp/iat pass the bound check (the fields are the caller's contract)", () => {
    expect(() => assertApiTimeBounds({}, T0)).not.toThrow();
  });
});

describe("ES256 JOSE-raw alignment — RFC 7515 appendix A.3's fixed vector", () => {
  // https://www.rfc-editor.org/rfc/rfc7515#appendix-A.3 — the exact JWK,
  // protected header, payload and signature from the RFC (the payload's
  // exp is 2011, so the vector runs with skipClaimValidation: it pins the
  // SIGNATURE primitive, i.e. WebCrypto's raw r||s output is JOSE's ES256
  // signature with no DER wrapping).
  const RFC7515_A3 = {
    jwk: {
      kty: "EC",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    } as JsonWebKey,
    token:
      "eyJhbGciOiJFUzI1NiJ9." +
      "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ." +
      "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q",
  };

  it("verifies the RFC's fixed ES256 token byte-for-byte", async () => {
    const key = await importVerifyKey("ES256", RFC7515_A3.jwk);
    const verified = await verifyJws({ alg: "ES256", key, token: RFC7515_A3.token, skipClaimValidation: true });
    expect(verified.claims.iss).toBe("joe");
    expect(verified.claims.exp).toBe(1300819380);
  });

  it("rejects a one-character signature mutation of the RFC token", async () => {
    const key = await importVerifyKey("ES256", RFC7515_A3.jwk);
    const parts = RFC7515_A3.token.split(".");
    // Mutate the FIRST character (all 6 bits significant — the trailing
    // character of a %4==2 base64url tail carries discarded padding bits,
    // so mutating it would decode to the identical bytes).
    const mutated = `EtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q`;
    await expect(verifyJws({ alg: "ES256", key, token: `${parts[0]}.${parts[1]}.${mutated}`, skipClaimValidation: true })).rejects.toThrow(
      "invalid token",
    );
  });
});

describe("publicJwkOf (the JWKS half of a private JWK)", () => {
  it("strips the RSA private members and keeps the public ones", async () => {
    const { privateJwk } = await generateAsymmetric("RS256");
    const pub = publicJwkOf(privateJwk);
    expect(pub.d).toBeUndefined();
    expect(pub.p).toBeUndefined();
    expect(pub.q).toBeUndefined();
    expect(pub.dp).toBeUndefined();
    expect(pub.dq).toBeUndefined();
    expect(pub.qi).toBeUndefined();
    expect(pub.kty).toBe("RSA");
    expect(pub.n).toBe(privateJwk.n);
    expect(pub.e).toBe(privateJwk.e);
  });

  it("strips the EC private member and keeps crv/x/y", async () => {
    const { privateJwk } = await generateAsymmetric("ES256");
    const pub = publicJwkOf(privateJwk);
    expect(pub.d).toBeUndefined();
    expect(pub.crv).toBe("P-256");
    expect(pub.x).toBe(privateJwk.x);
    expect(pub.y).toBe(privateJwk.y);
  });
});
