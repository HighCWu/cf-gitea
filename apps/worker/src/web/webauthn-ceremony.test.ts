/**
 * The WebAuthn ceremony suite — the verification ladder's accept/reject
 * arms over FIXED synthetic vectors (webauthn-fixtures.ts: hand-built
 * authenticator data + CBOR attestation objects over test-generated
 * WebCrypto keys — no authenticator in CI, the mission's constraint).
 *
 * Covers: the CBOR decoder's fixed byte vectors; COSE key parse/import/
 * verify for ES256 + RS256; the registration ladder (none + packed-self
 * accept; challenge/origin/rp-hash/UP/UV/id-match/trailing-bytes/unknown-
 * fmt/bad-sig/alg-mismatch rejects); the assertion ladder (accept + counter
 * advance; challenge/origin/rp-hash/UP/signature/userHandle rejects; the
 * sign-count clone arm at equal AND lower counts); the state cookie codec
 * (round-trip, tamper, wrong kind, expiry — over the real keystore row);
 * the userHandle varint (Go binary.PutVarint shapes).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";

import { decodeCbor, decodeCborItem, CborError } from "./webauthn-cbor";
import {
  buildCreationOptions,
  buildDiscoverableRequestOptions,
  buildRequestOptions,
  encodeCoseKey,
  parseAssertionResponse,
  parseCreationResponse,
  signCeremonyState,
  verifyAssertion,
  verifyCeremonyState,
  verifyRegistration,
  webAuthnCookieValue,
  WebAuthnError,
  type RelyingParty,
} from "./webauthn-ceremony";
import {
  base64UrlEncode,
  bytesEqual,
  coseVerify,
  importCoseKey,
  parseCoseKey,
  sha256,
  userIdFromWebAuthnId,
  webAuthnIdForUser,
} from "./webauthn-cose";
import {
  buildAssertionResponse,
  buildAuthData,
  buildCreationResponse,
  clientDataJson,
  cborEncode,
  cborMapUnsorted,
  FLAG_AT,
  FLAG_ED,
  FLAG_UP,
  FLAG_UV,
  FIXED_AAGUID,
  FIXED_CHALLENGE_B64,
  FIXTURE_ORIGIN,
  FIXTURE_RP_ID,
  makeChallenge,
  makeEcFixture,
  makeRsaFixture,
  signWith,
} from "./webauthn-fixtures";

const RP: RelyingParty = { id: FIXTURE_RP_ID, name: "cf-gitea", origin: FIXTURE_ORIGIN };

beforeAll(async () => {
  // The state codec's HMAC key rides the shared `general_token_signing_
  // secret` keystore row (the ceremony module's generate-once cold path);
  // system_keystore is deliberately NOT wiped between tests — the module
  // cache holds the key anyway (session.test.ts's posture).
  await applyAuthD1Migrations();
});

// ---------------------------------------------------------------------------------
// CBOR decoder — fixed byte vectors
// ---------------------------------------------------------------------------------

describe("webauthn-cbor: fixed byte vectors", () => {
  it("decodes the major types", () => {
    expect(decodeCbor(new Uint8Array([0x00]))).toBe(0);
    expect(decodeCbor(new Uint8Array([0x17]))).toBe(23);
    expect(decodeCbor(new Uint8Array([0x18, 0x2a]))).toBe(42);
    expect(decodeCbor(new Uint8Array([0x19, 0x01, 0x00]))).toBe(256);
    expect(decodeCbor(new Uint8Array([0x1a, 0x00, 0x0f, 0x42, 0x40]))).toBe(1_000_000);
    expect(decodeCbor(new Uint8Array([0x20]))).toBe(-1);
    expect(decodeCbor(new Uint8Array([0x38, 0x63]))).toBe(-100);
    expect(decodeCbor(new Uint8Array([0x63, 0x61, 0x62, 0x63]))).toBe("abc");
    expect(decodeCbor(new Uint8Array([0x44, 0x01, 0x02, 0x03, 0x04]))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decodeCbor(new Uint8Array([0xf4]))).toBe(false);
    expect(decodeCbor(new Uint8Array([0xf5]))).toBe(true);
    expect(decodeCbor(new Uint8Array([0xf6]))).toBe(null);
    // Array [1, -1, "a"]:
    expect(decodeCbor(new Uint8Array([0x83, 0x01, 0x20, 0x61, 0x61]))).toEqual([1, -1, "a"]);
  });

  it("decodes maps with integer keys (the COSE shape)", () => {
    // {1: 2, 3: -7, -1: 1}:
    const bytes = new Uint8Array([0xa3, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
    const map = decodeCbor(bytes) as Map<number, number>;
    expect(map).toBeInstanceOf(Map);
    expect(map.get(1)).toBe(2);
    expect(map.get(3)).toBe(-7);
    expect(map.get(-1)).toBe(1);
  });

  it("decodes an unordered map (the decoder is order-independent)", () => {
    const bytes = cborMapUnsorted([
      [3, -257],
      [1, 3],
      [-1, new Uint8Array([9, 9])],
    ]);
    const map = decodeCbor(bytes) as Map<number, number | Uint8Array>;
    expect(map.get(1)).toBe(3);
    expect(map.get(3)).toBe(-257);
    expect(map.get(-1)).toEqual(new Uint8Array([9, 9]));
  });

  it("decodes a tagged value by dropping the tag", () => {
    expect(decodeCbor(new Uint8Array([0xc0, 0x17]))).toBe(23);
  });

  it("rejects truncation, trailing bytes, and indefinite lengths", () => {
    expect(() => decodeCbor(new Uint8Array([0x18]))).toThrow(CborError);
    expect(() => decodeCbor(new Uint8Array([0x63, 0x61]))).toThrow(CborError); // short text
    expect(() => decodeCbor(new Uint8Array([0x43, 0x01]))).toThrow(CborError); // short bytes
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow(CborError); // trailing
    expect(() => decodeCbor(new Uint8Array([0x9f, 0x01, 0xff]))).toThrow(CborError); // indefinite array
    expect(() => decodeCbor(new Uint8Array([0x82, 0x01]))).toThrow(CborError); // short array
    expect(() => decodeCbor(new Uint8Array([0xa1, 0x01]))).toThrow(CborError); // short map
  });

  it("decodeCborItem reports the consumed offset (the mid-buffer walk)", () => {
    const item = decodeCborItem(new Uint8Array([0x01, 0x02]));
    expect(item.value).toBe(1);
    expect(item.offset).toBe(1);
  });
});

// ---------------------------------------------------------------------------------
// COSE keys + the varint userHandle
// ---------------------------------------------------------------------------------

describe("webauthn-cose: keys and the varint", () => {
  it("parses the ES256 key and round-trips through encodeCoseKey", async () => {
    const fixture = await makeEcFixture();
    const parsed = parseCoseKey(fixture.coseBytes, 0);
    expect(parsed.key.kty).toBe("EC2");
    expect(parsed.end).toBe(fixture.coseBytes.length);
    const reencoded = encodeCoseKey(parsed.key);
    const reparsed = parseCoseKey(reencoded, 0);
    expect(reparsed.key.kty).toBe("EC2");
    if (reparsed.key.kty === "EC2") {
      expect(bytesEqual(reparsed.key.x, fixture.cose.x)).toBe(true);
      expect(bytesEqual(reparsed.key.y, fixture.cose.y)).toBe(true);
    }
    // The re-encoded bytes verify with WebCrypto:
    const key = await importCoseKey(reparsed.key);
    const data = new TextEncoder().encode("payload");
    const sig = await signWith(fixture, data);
    expect(await coseVerify(key, reparsed.key, sig, data)).toBe(true);
  });

  it("parses an RS256 key from a fixed raw-byte vector", () => {
    // Import validity needs a real modulus; parse-correctness needs only
    // the structure (the full RSA verify runs in the registration suite).
    const n = new Uint8Array(32).fill(0x11);
    const e = new Uint8Array([0x01, 0x00, 0x01]);
    const bytes = cborEncode(
      new Map<number, number | Uint8Array>([
        [1, 3],
        [3, -257],
        [-1, n],
        [-2, e],
      ]),
    );
    const parsed = parseCoseKey(bytes, 0);
    expect(parsed.key.kty).toBe("RSA");
    if (parsed.key.kty === "RSA") {
      expect(bytesEqual(parsed.key.n, n)).toBe(true);
      expect(bytesEqual(parsed.key.e, e)).toBe(true);
    }
  });

  it("rejects unsupported key types and curves", () => {
    const ed25519 = cborEncode(
      new Map<number, number>([
        [1, 1], // OKP
        [3, -8], // EdDSA
      ]),
    );
    expect(() => parseCoseKey(ed25519, 0)).toThrow();
    const p384 = cborEncode(
      new Map<number, number>([
        [1, 2],
        [3, -7],
        [-1, 3], // P-384 — out of scope
      ]),
    );
    expect(() => parseCoseKey(p384, 0)).toThrow();
  });

  it("the userHandle varint matches Go's binary.PutVarint shapes", () => {
    const one = webAuthnIdForUser(1);
    expect(Array.from(one)).toEqual([0x02, 0, 0, 0, 0, 0, 0, 0]);
    expect(userIdFromWebAuthnId(one)).toBe(1);
    const two = webAuthnIdForUser(2);
    expect(two[0]).toBe(0x04);
    // id 128: zigzag 256 → LEB128 [0x80, 0x02]:
    const c128 = webAuthnIdForUser(128);
    expect(Array.from(c128)).toEqual([0x80, 0x02, 0, 0, 0, 0, 0, 0]);
    expect(userIdFromWebAuthnId(c128)).toBe(128);
    for (const id of [1, 2, 63, 64, 127, 4096, 98765, 2 ** 40]) {
      expect(userIdFromWebAuthnId(webAuthnIdForUser(id))).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------------
// The registration ladder
// ---------------------------------------------------------------------------------

interface RegistrationInputs {
  fixture: Awaited<ReturnType<typeof makeEcFixture>>;
  credentialId: Uint8Array;
  parsed: ReturnType<typeof parseCreationResponse>;
}

/** The synthetic registration ceremony — packed self-attestation by default
 *  (it exercises the signature path); `fmt: "none"` for the none arms. */
async function registrationInputs(
  options: {
    fixture?: Awaited<ReturnType<typeof makeEcFixture>>;
    challengeB64?: string;
    origin?: string;
    rpId?: string;
    flags?: number;
    signCount?: number;
    fmt?: "none" | "packed" | "fido-u2f";
    credentialId?: Uint8Array;
    attStmtAlgMismatch?: boolean;
    badSignature?: boolean;
    trailingJunk?: number;
    attStmtOverride?: Map<number | string, number | Uint8Array>;
  } = {},
): Promise<RegistrationInputs> {
  const fixture = options.fixture ?? (await makeEcFixture());
  const credentialId = options.credentialId ?? new Uint8Array([0xc0, 0xfe, 0x01, 0x02]);
  const challenge = options.challengeB64 ?? FIXED_CHALLENGE_B64;
  const flags = options.flags ?? (FLAG_UP | FLAG_UV | FLAG_AT);
  const signCount = options.signCount ?? 5;
  const fmt = options.fmt ?? "packed";
  const authData = await buildAuthData({
    rpId: options.rpId ?? FIXTURE_RP_ID,
    flags,
    signCount,
    attested: { aaguid: FIXED_AAGUID, credentialId, coseKey: fixture.coseBytes },
    trailingJunk: options.trailingJunk,
  });
  const clientData = clientDataJson("webauthn.create", challenge, options.origin ?? FIXTURE_ORIGIN);
  let attStmt = new Map<number | string, number | Uint8Array>();
  if (fmt === "packed") {
    const clientHash = await sha256(clientData);
    const signed = new Uint8Array(authData.length + clientHash.length);
    signed.set(authData, 0);
    signed.set(clientHash, authData.length);
    let sig = await signWith(fixture, signed);
    if (options.badSignature) sig = sig.slice(1);
    attStmt = new Map<number | string, number | Uint8Array>([
      ["alg", options.attStmtAlgMismatch ? -257 : -7],
      ["sig", sig],
    ]);
  }
  if (options.attStmtOverride !== undefined) attStmt = options.attStmtOverride;
  const body = buildCreationResponse({ credentialId, authData, clientData, fmt, attStmt, transports: ["usb", "nfc"] });
  return { fixture, credentialId, parsed: parseCreationResponse(body) };
}

describe("webauthn-ceremony: the registration ladder", () => {
  it("accepts fmt=none with attested data (the ES256 happy path)", async () => {
    const inputs = await registrationInputs({ fmt: "none" });
    const verified = await verifyRegistration(inputs.parsed, {
      challenge: FIXED_CHALLENGE_B64,
      rp: RP,
      requireUserVerification: true,
    });
    expect(bytesEqual(verified.credentialId, inputs.credentialId)).toBe(true);
    expect(verified.attestationType).toBe("none");
    expect(verified.signCount).toBe(5);
    expect(verified.userPresent).toBe(true);
    expect(verified.userVerified).toBe(true);
    expect(bytesEqual(verified.aaguid, FIXED_AAGUID)).toBe(true);
    expect(verified.transports).toEqual(["usb", "nfc"]);
    // The stored COSE key re-parses and verifies a test signature:
    const reparsed = parseCoseKey(verified.publicKeyRaw, 0);
    const key = await importCoseKey(reparsed.key);
    const data = new TextEncoder().encode("payload");
    expect(await coseVerify(key, reparsed.key, await signWith(inputs.fixture, data), data)).toBe(true);
  });

  it("accepts packed SELF-attestation verified against the credential's own key", async () => {
    const inputs = await registrationInputs({ fmt: "packed" });
    const verified = await verifyRegistration(inputs.parsed, {
      challenge: FIXED_CHALLENGE_B64,
      rp: RP,
      requireUserVerification: true,
    });
    expect(verified.attestationType).toBe("self");
  });

  it("accepts an RS256 credential (fmt none)", async () => {
    const rsa = await makeRsaFixture();
    const credentialId = new Uint8Array([0xde, 0xad]);
    const authData = await buildAuthData({
      rpId: FIXTURE_RP_ID,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      signCount: 1,
      attested: { aaguid: FIXED_AAGUID, credentialId, coseKey: rsa.coseBytes },
    });
    const clientData = clientDataJson("webauthn.create", FIXED_CHALLENGE_B64, FIXTURE_ORIGIN);
    const body = buildCreationResponse({ credentialId, authData, clientData, fmt: "none" });
    const verified = await verifyRegistration(parseCreationResponse(body), {
      challenge: FIXED_CHALLENGE_B64,
      rp: RP,
      requireUserVerification: true,
    });
    expect(verified.attestationType).toBe("none");
    expect(verified.coseKey.kty).toBe("RSA");
  });

  it("rejects: wrong challenge, wrong origin, wrong rpIdHash", async () => {
    const wrongChallenge = await registrationInputs({ challengeB64: base64UrlEncode(makeChallenge()) });
    await expect(
      verifyRegistration(wrongChallenge.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/challenge mismatch/);

    const wrongOrigin = await registrationInputs({ origin: "https://evil.example" });
    await expect(
      verifyRegistration(wrongOrigin.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/origin mismatch/);

    const wrongRp = await registrationInputs({ rpId: "other.local" });
    await expect(
      verifyRegistration(wrongRp.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/RP ID hash mismatch/);
  });

  it("rejects missing UP, and missing UV when required", async () => {
    const noUp = await registrationInputs({ flags: FLAG_UV | FLAG_AT, fmt: "none" });
    await expect(
      verifyRegistration(noUp.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/user-presence/);

    const noUv = await registrationInputs({ flags: FLAG_UP | FLAG_AT, fmt: "none" });
    await expect(
      verifyRegistration(noUv.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/user-verification/);
    // The same body PASSES when UV is not required:
    await expect(
      verifyRegistration(noUv.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: false }),
    ).resolves.toBeTruthy();
  });

  it("rejects id/rawId mismatches and junk-padded authenticator data", async () => {
    const mismatched = {
      id: base64UrlEncode(new Uint8Array([1, 2, 3])),
      rawId: base64UrlEncode(new Uint8Array([4, 5, 6])),
      type: "public-key",
      response: { attestationObject: "AA", clientDataJSON: "AA" },
    };
    expect(() => parseCreationResponse(mismatched)).toThrow(/rawId/);

    const junk = await registrationInputs({ trailingJunk: 3, fmt: "none" });
    await expect(
      verifyRegistration(junk.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/trailing bytes/);
  });

  it("rejects unknown attestation formats and bad/mismatched packed signatures", async () => {
    const u2f = await registrationInputs({ fmt: "fido-u2f" });
    await expect(
      verifyRegistration(u2f.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/unsupported attestation format/);

    const algMismatch = await registrationInputs({ attStmtAlgMismatch: true });
    await expect(
      verifyRegistration(algMismatch.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/alg mismatch/);

    const badSig = await registrationInputs({ badSignature: true });
    await expect(
      verifyRegistration(badSig.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/signature invalid/);
  });

  it("rejects none-with-a-statement and an ED-flagged extension walk", async () => {
    // "none" with a non-empty statement:
    const inputs = await registrationInputs({ fmt: "none", attStmtOverride: new Map([["x", 1]]) });
    await expect(
      verifyRegistration(inputs.parsed, { challenge: FIXED_CHALLENGE_B64, rp: RP, requireUserVerification: true }),
    ).rejects.toThrow(/carries a statement/);

    // The ED flag adds the extensions map — a well-formed one walks through:
    const fixture = await makeEcFixture();
    const credentialId = new Uint8Array([0xed, 0x01]);
    const authData = await buildAuthData({
      rpId: FIXTURE_RP_ID,
      flags: FLAG_UP | FLAG_UV | FLAG_AT | FLAG_ED,
      attested: { aaguid: FIXED_AAGUID, credentialId, coseKey: fixture.coseBytes },
      extensions: new Map([["credProtect", 3]]),
    });
    const clientData = clientDataJson("webauthn.create", FIXED_CHALLENGE_B64, FIXTURE_ORIGIN);
    const body = buildCreationResponse({ credentialId, authData, clientData, fmt: "none" });
    const verified = await verifyRegistration(parseCreationResponse(body), {
      challenge: FIXED_CHALLENGE_B64,
      rp: RP,
      requireUserVerification: true,
    });
    expect(bytesEqual(verified.credentialId, credentialId)).toBe(true);
  });

  it("the options builders emit the vendored JS's contract shape", () => {
    const challenge = makeChallenge();
    const creation = buildCreationOptions(
      RP,
      { id: webAuthnIdForUser(7), name: "alice", displayName: "Alice" },
      challenge,
      [new Uint8Array([1])],
    );
    const pk = creation.publicKey;
    expect(pk.rp).toEqual({ id: FIXTURE_RP_ID, name: "cf-gitea" });
    expect(pk.challenge).toBe(base64UrlEncode(challenge));
    expect((pk.user as { id: string }).id).toBe(base64UrlEncode(webAuthnIdForUser(7)));
    expect(pk.pubKeyCredParams).toEqual([
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ]);
    expect(pk.authenticatorSelection).toEqual({ residentKey: "required", userVerification: "required" });
    expect(pk.attestation).toBe("none");
    expect(pk.excludeCredentials).toEqual([{ type: "public-key", id: base64UrlEncode(new Uint8Array([1])) }]);

    const request = buildRequestOptions(RP, challenge, [new Uint8Array([2])]);
    const rpk = request.publicKey;
    expect(rpk.rpId).toBe(FIXTURE_RP_ID);
    expect(rpk.allowCredentials).toEqual([{ type: "public-key", id: base64UrlEncode(new Uint8Array([2])) }]);
    expect(rpk.userVerification).toBe("preferred");

    const discoverable = buildDiscoverableRequestOptions(RP, challenge);
    const dpk = discoverable.publicKey;
    expect(dpk.allowCredentials).toBeUndefined();
    expect(dpk.userVerification).toBe("required");
  });
});

// ---------------------------------------------------------------------------------
// The assertion ladder
// ---------------------------------------------------------------------------------

async function assertionInputs(
  options: {
    storedCount?: number;
    newCount?: number;
    /** The clientData's challenge (varies for the mismatch arms). */
    challengeB64?: string;
    /** The EXPECTED challenge (defaults to the fixture constant). */
    expectedChallengeB64?: string;
    origin?: string;
    rpId?: string;
    flags?: number;
    userHandle?: Uint8Array | null;
    expectedUserHandle?: Uint8Array;
    requireUserVerification?: boolean;
    badSignature?: boolean;
  } = {},
) {
  const fixture = await makeEcFixture();
  const credentialId = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const stored = { credentialId, coseKey: fixture.cose, signCount: options.storedCount ?? 10 };
  const challenge = options.challengeB64 ?? FIXED_CHALLENGE_B64;
  const authData = await buildAuthData({
    rpId: options.rpId ?? FIXTURE_RP_ID,
    flags: options.flags ?? (FLAG_UP | FLAG_UV),
    signCount: options.newCount ?? 11,
  });
  const clientData = clientDataJson("webauthn.get", challenge, options.origin ?? FIXTURE_ORIGIN);
  const clientHash = await sha256(clientData);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);
  let signature = await signWith(fixture, signed);
  if (options.badSignature) signature = signature.slice(1);
  const parsed = parseAssertionResponse(
    buildAssertionResponse({ credentialId, authData, clientData, signature, userHandle: options.userHandle ?? null }),
  );
  return {
    stored,
    parsed,
    expected: {
      challenge: options.expectedChallengeB64 ?? FIXED_CHALLENGE_B64,
      rp: RP,
      ...(options.expectedUserHandle !== undefined ? { expectedUserHandle: options.expectedUserHandle } : {}),
      ...(options.requireUserVerification !== undefined ? { requireUserVerification: options.requireUserVerification } : {}),
    },
  };
}

describe("webauthn-ceremony: the assertion ladder", () => {
  it("accepts a valid assertion and reports the counter advance", async () => {
    const inputs = await assertionInputs({ storedCount: 10, newCount: 11 });
    const verified = await verifyAssertion(inputs.parsed, inputs.stored, inputs.expected);
    expect(verified.userPresent).toBe(true);
    expect(verified.cloneDetected).toBe(false);
    expect(verified.signCount).toBe(11);
  });

  it("flags the clone arm at an EQUAL counter (the replay)", async () => {
    const inputs = await assertionInputs({ storedCount: 10, newCount: 10 });
    const verified = await verifyAssertion(inputs.parsed, inputs.stored, inputs.expected);
    expect(verified.cloneDetected).toBe(true);
  });

  it("flags the clone arm at a LOWER counter", async () => {
    const inputs = await assertionInputs({ storedCount: 100, newCount: 5 });
    const verified = await verifyAssertion(inputs.parsed, inputs.stored, inputs.expected);
    expect(verified.cloneDetected).toBe(true);
  });

  it("stays silent for zero counters on both sides (the count-0 authenticators)", async () => {
    const inputs = await assertionInputs({ storedCount: 0, newCount: 0 });
    const verified = await verifyAssertion(inputs.parsed, inputs.stored, inputs.expected);
    expect(verified.cloneDetected).toBe(false);
  });

  it("rejects: wrong challenge/origin/rpHash, missing UP, bad signature, wrong userHandle", async () => {
    const wrongChallenge = await assertionInputs({ challengeB64: base64UrlEncode(makeChallenge()) });
    await expect(verifyAssertion(wrongChallenge.parsed, wrongChallenge.stored, wrongChallenge.expected)).rejects.toThrow(
      /challenge mismatch/,
    );

    const wrongOrigin = await assertionInputs({ origin: "https://evil.example" });
    await expect(verifyAssertion(wrongOrigin.parsed, wrongOrigin.stored, wrongOrigin.expected)).rejects.toThrow(
      /origin mismatch/,
    );

    const wrongRp = await assertionInputs({ rpId: "other.local" });
    await expect(verifyAssertion(wrongRp.parsed, wrongRp.stored, wrongRp.expected)).rejects.toThrow(/RP ID hash mismatch/);

    const noUp = await assertionInputs({ flags: FLAG_UV });
    await expect(verifyAssertion(noUp.parsed, noUp.stored, noUp.expected)).rejects.toThrow(/user-presence required but flag not set/);
    const caught = await verifyAssertion(noUp.parsed, noUp.stored, noUp.expected).catch((error: unknown) => error);
    // UP is always required in LOGIN (go-webauthn login.go's
    // shouldVerifyUserPresence := true) and both handlers answer the
    // ErrVerification with 403 (webauthn.go:114-119/226-231) — the
    // forbidden arm, not the 400 of the unreachable post-validate arm.
    expect((caught as WebAuthnError).arm).toBe("forbidden");

    const badSig = await assertionInputs({ badSignature: true });
    await expect(verifyAssertion(badSig.parsed, badSig.stored, badSig.expected)).rejects.toThrow(/signature invalid/);

    const wrongHandle = await assertionInputs({
      userHandle: webAuthnIdForUser(9),
      expectedUserHandle: webAuthnIdForUser(7),
    });
    await expect(verifyAssertion(wrongHandle.parsed, wrongHandle.stored, wrongHandle.expected)).rejects.toThrow(
      /userHandle mismatch/,
    );
  });

  it("the UV gate: required rejects an uv-less assertion 403-class; preferred (the 2FA arm) accepts it", async () => {
    // The passkey arm's ceremony (VerificationRequired, webauthn.go:59):
    // an assertion carrying UP alone fails the UV requirement.
    const uvLess = await assertionInputs({ flags: FLAG_UP, requireUserVerification: true });
    await expect(verifyAssertion(uvLess.parsed, uvLess.stored, uvLess.expected)).rejects.toThrow(
      /user-verification required but flag not set/,
    );
    const caught = await verifyAssertion(uvLess.parsed, uvLess.stored, uvLess.expected).catch((error: unknown) => error);
    expect((caught as WebAuthnError).arm).toBe("forbidden");

    // The same wire assertion with UV set passes the required ceremony.
    const withUv = await assertionInputs({ flags: FLAG_UP | FLAG_UV, requireUserVerification: true });
    const verified = await verifyAssertion(withUv.parsed, withUv.stored, withUv.expected);
    expect(verified.userVerified).toBe(true);

    // The 2FA arm (VerificationPreferred, webauthn.go:189 — go-webauthn's
    // shouldVerifyUser=false): the uv-less assertion is ACCEPTED, the flag
    // merely reported.
    const preferred = await assertionInputs({ flags: FLAG_UP, requireUserVerification: false });
    const accepted = await verifyAssertion(preferred.parsed, preferred.stored, preferred.expected);
    expect(accepted.userPresent).toBe(true);
    expect(accepted.userVerified).toBe(false);
    expect(accepted.cloneDetected).toBe(false);
  });

  it("rejects a credential mismatch and junk authenticator data", async () => {
    const inputs = await assertionInputs();
    const otherCred = { ...inputs.stored, credentialId: new Uint8Array([1]) };
    await expect(verifyAssertion(inputs.parsed, otherCred, inputs.expected)).rejects.toThrow(/rawId does not match/);

    const shortAuthData = parseAssertionResponse(
      buildAssertionResponse({
        credentialId: inputs.stored.credentialId,
        authData: new Uint8Array(20),
        clientData: clientDataJson("webauthn.get", FIXED_CHALLENGE_B64, FIXTURE_ORIGIN),
        signature: new Uint8Array(64),
      }),
    );
    await expect(verifyAssertion(shortAuthData, inputs.stored, inputs.expected)).rejects.toThrow(/shorter than/);
  });
});

// ---------------------------------------------------------------------------------
// The state cookie codec (over the REAL keystore row — env.DB)
// ---------------------------------------------------------------------------------

describe("webauthn-ceremony: the state cookie codec", () => {
  it("round-trips a signed state through the cookie value reader", async () => {
    const value = await signCeremonyState(env.DB, {
      k: "assert",
      uid: 42,
      ch: FIXED_CHALLENGE_B64,
      ac: ["YQ", "Yg"],
    });
    const state = await verifyCeremonyState(env.DB, value, "assert");
    expect(state).toMatchObject({ k: "assert", uid: 42, ch: FIXED_CHALLENGE_B64, ac: ["YQ", "Yg"] });

    const header = new Request("https://test.local/x", { headers: { cookie: `gitea_webauthn_challenge=${encodeURIComponent(value)}` } });
    expect(webAuthnCookieValue(header, "assert")).toBe(value);
    expect(webAuthnCookieValue(header, "pending")).toBeNull(); // the carriers are name-split
    expect(webAuthnCookieValue(new Request("https://test.local/x"), "assert")).toBeNull();
  });

  it("rejects tampering, wrong kinds, junk, and absent values", async () => {
    const value = await signCeremonyState(env.DB, { k: "reg", uid: 1, ch: "abc", name: "key" });
    await expect(verifyCeremonyState(env.DB, value, "assert")).resolves.toBeNull(); // wrong kind
    const tampered = `${value.slice(0, -2)}aa`;
    await expect(verifyCeremonyState(env.DB, tampered, "reg")).resolves.toBeNull(); // broken MAC
    await expect(verifyCeremonyState(env.DB, "not-a-state", "reg")).resolves.toBeNull();
    await expect(verifyCeremonyState(env.DB, null, "reg")).resolves.toBeNull();
    await expect(verifyCeremonyState(env.DB, undefined, "reg")).resolves.toBeNull();
  });

  it("an expired state verifies as null (the shifted-clock check)", async () => {
    const value = await signCeremonyState(env.DB, { k: "pending", uid: 5, ch: "" });
    const realNow = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 601_000);
    const state = await verifyCeremonyState(env.DB, value, "pending");
    spy.mockRestore();
    expect(state).toBeNull();
  });
});
