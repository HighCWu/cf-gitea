/**
 * The TOTP core's vectors (the mission's "RFC-6238's SHA1 FIXED VECTORS
 * byte-exact" gate) + the scratch-code crypto:
 *
 *   - RFC 6238's SHA-1 secret ASCII "12345678901234567890", 8-digit codes,
 *     all six fixed time inputs — asserted verbatim.
 *   - RFC 4226 Appendix D's HOTP table over the same secret — the counter
 *     math underneath (the first six, the table's canonical set).
 *   - The ±1 window + probe order (pquerna's [T, T+1, T-1]) and the matched
 *     period the replay guard consumes.
 *   - The pquerna base32 leniency (trim/pad/uppercase) and its rejection arm.
 *   - The scratch token's shape (10 chars over the ambiguity-free alphabet)
 *     and HashToken's EXACT PBKDF2 parameters — pinned against a
 *     RFC-6070-style independently-computed vector plus the determinism
 *     check (same token+salt ⇒ same 100-hex hash; salt flips every byte).
 *
 * Pure-`crypto` module: runs on workerd's WebCrypto unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  SCRATCH_ALPHABET,
  base32DecodeSecret,
  base32Encode,
  generateScratchSalt,
  generateScratchToken,
  hashScratchToken,
  hotpCode,
  totpCode,
  totpPeriodAt,
  verifyHotp,
  verifyScratchTokenHash,
  verifyTotpPeriod,
} from "./totp";

// RFC 6238 §B — the SHA-1 secret, every fixed vector (T, TOTP). The RFC's
// secret is the raw ASCII bytes; pquerna's API (and ours) takes the base32
// STRING spelling — `base32("12345678901234567890")` decodes back to exactly
// those bytes.
const RFC6238_SHA1_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

// RFC 4226 Appendix D — the HOTP secret (the same ASCII bytes)
const RFC4226_SECRET = RFC6238_SHA1_SECRET;
const RFC6238_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

// RFC 4226 Appendix D — the HOTP table (same secret, counters 0-9, 6 digits)
const RFC4226_TABLE = [
  "755224",
  "287082",
  "359152",
  "969429",
  "338314",
  "254676",
  "287922",
  "162583",
  "399871",
  "520489",
];

describe("RFC 6238 — the SHA1 fixed vectors (8 digits)", () => {
  for (const [t, code] of RFC6238_VECTORS) {
    it(`T=${t} → ${code}`, async () => {
      expect(await totpCode(RFC6238_SHA1_SECRET, t, { digits: 8 })).toBe(code);
    });
  }

  it("every vector verifies through the window at its own instant (digits 8)", async () => {
    for (const [t, code] of RFC6238_VECTORS) {
      expect(await verifyTotpPeriod(code, RFC6238_SHA1_SECRET, t, { digits: 8 })).toBe(totpPeriodAt(t));
    }
  });
});

describe("RFC 4226 Appendix D — the HOTP table underneath", () => {
  for (const [counter, code] of RFC4226_TABLE.entries()) {
    it(`counter ${counter} → ${code}`, async () => {
      expect(await hotpCode(RFC4226_SECRET, counter, 6)).toBe(code);
    });
  }
  it("verifyHotp accepts the table and rejects off-by-one codes", async () => {
    expect(await verifyHotp("755224", RFC4226_SECRET, 0)).toBe(true);
    expect(await verifyHotp("287082", RFC4226_SECRET, 0)).toBe(false);
    // a 7-digit string fails the length pre-check (ErrValidateInputInvalidLength)
    expect(await verifyHotp("0755224", RFC4226_SECRET, 0)).toBe(false);
  });
});

describe("the ±1 window (totp.Validate's Skew 1)", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  it("accepts the current, the previous, and the next step's code — and reports WHICH matched", async () => {
    const now = 1_700_000_000;
    const current = totpPeriodAt(now);
    for (const offset of [-1, 0, 1]) {
      const code = await totpCode(secret, now + offset * 30);
      expect(await verifyTotpPeriod(code, secret, now)).toBe(current + offset);
    }
  });

  it("rejects codes outside the window (±2 steps)", async () => {
    const now = 1_700_000_000;
    const far = await totpCode(secret, now + 2 * 30);
    expect(await verifyTotpPeriod(far, secret, now)).toBeNull();
  });

  it("a boundary code from the NEXT step, presented one step early, verifies and reports T+1", async () => {
    // The skew window's real cross-step arm: the code generated at T+1 is
    // valid at T (probe [T, T+1, T-1] hits it on the second probe) and the
    // matched period reported is T+1 — the guard's monotonic consume
    // (`last_used_passcode_period < period`) then rejects any older-step
    // replay, as designed.
    const now = 1_700_000_000;
    const next = await totpCode(secret, now + 30);
    expect(await verifyTotpPeriod(next, secret, now)).toBe(totpPeriodAt(now) + 1);
  });

  it("normalizes whitespace around the passcode (hotp.go's TrimSpace)", async () => {
    const now = 1_700_000_000;
    const code = await totpCode(secret, now);
    expect(await verifyTotpPeriod(` ${code} `, secret, now)).toBe(totpPeriodAt(now));
  });

  it("rejects the empty passcode outright", async () => {
    expect(await verifyTotpPeriod("", secret, 1_700_000_000)).toBeNull();
  });
});

describe("base32 — the pquerna decode leniency", () => {
  it("round-trips through the std alphabet, no padding", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(40));
    const encoded = base32Encode(bytes);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(new Uint8Array(base32DecodeSecret(encoded))).toEqual(bytes);
  });

  it("decodes lowercase, outer-whitespace-padded, unpadded input (issues #10/#17/#24)", () => {
    expect(new Uint8Array(base32DecodeSecret(" jbswy3dp "))).toEqual(new Uint8Array(base32DecodeSecret("JBSWY3DP")));
  });

  it("throws on a character outside the alphabet (ErrValidateSecretInvalidBase32's arm)", () => {
    expect(() => base32DecodeSecret("JBSWY1DP")).toThrow(/invalid base32/);
  });
});

describe("the scratch token (models/auth/twofactor.go's exact crypto)", () => {
  it("generates 10 chars over the ambiguity-free alphabet", () => {
    const token = generateScratchToken();
    expect(token).toHaveLength(10);
    for (const ch of token) expect(SCRATCH_ALPHABET).toContain(ch);
    // the ambiguous chars are exactly the alphabet's omissions
    expect(token).not.toMatch(/[0O1I]/);
  });

  it("HashToken pins PBKDF2-SHA256(token, salt, 10000, 50 bytes) hex — an independent vector", async () => {
    // The vector computed OUTSIDE this tree: python3
    //   hashlib.pbkdf2_hmac('sha256', b'ABCDEF2345', b'salt123456',
    //                       10000, dklen=50).hex()
    // — the parameters upstream's
    //   pbkdf2.Key([]byte(token), []byte(salt), 10000, 50, sha256.New)
    // (twofactor.go:80) picks, 100 hex = 50 bytes.
    expect(await hashScratchToken("ABCDEF2345", "salt123456")).toBe(
      "2a3f50244311c65d1420122cf97efab8547ac37cec80cc8c970ef78716bdc40a82365fe48a03a31090038fda86b0fa7544fc",
    );
    // determinism + the parameters' participation
    const hash = await hashScratchToken("ABCDEF2345", "salt123456");
    expect(await hashScratchToken("ABCDEF2345", "salt123456")).toBe(hash);
    // a one-bit salt change re-derives every byte
    expect(await hashScratchToken("ABCDEF2345", "salt123457")).not.toBe(hash);
    // the token participates (upstream hashes TOKEN with SALT, never the reverse)
    expect(await hashScratchToken("ABCDEF2346", "salt123456")).not.toBe(hash);
  });

  it("verifyScratchTokenHash: exact match true, wrong token false, empty token false, junk hex false", async () => {
    const token = generateScratchToken();
    const salt = generateScratchSalt();
    const hash = await hashScratchToken(token, salt);
    expect(await verifyScratchTokenHash(hash, token, salt)).toBe(true);
    expect(await verifyScratchTokenHash(hash, `${token}X`, salt)).toBe(false);
    expect(await verifyScratchTokenHash(hash, "", salt)).toBe(false);
    expect(await verifyScratchTokenHash("not-hex", token, salt)).toBe(false);
  });

  it("generateScratchSalt: 10 chars over the CryptoRandomString alphabet", () => {
    const salt = generateScratchSalt();
    expect(salt).toHaveLength(10);
    expect(salt).toMatch(/^[a-zA-Z0-9]+$/);
  });
});
