/**
 * Password hash service tests — SPEC-0002 §6.6.
 *
 * Known-answer vectors: the 8 Go-generated fixtures (pin fc493688,
 * Python-hashlib cross-checked, /tmp/pwd-vectors/pwd-fixtures.json copied
 * to password-fixtures.json). The suite FAILS if the salt decode rule
 * regresses — the raw-string vs hex-decoded digests differ by design
 * (§6.1 THE SALT CHAIN); the explicit naive-decode tripwire below pins
 * that property forever.
 */

import { describe, expect, it } from "vitest";

import fixtures from "./password-fixtures.json";
import {
  CONFIGURED_HASH_ALGO,
  CONFIGURED_HASH_SPEC,
  PRODUCTION_PBKDF2_ITERATION_CAP,
  PasswordHashSaltError,
  PasswordHashUnsupportedError,
  bytesToHex,
  decodeSaltBytes,
  hashAlgorithmToSpec,
  hashPasswordWithAlgo,
  isPasswordSet,
  needsRehash,
  newPasswordRecord,
  newSalt,
  parseStoredHashAlgo,
  pbkdf2Sha256Hex,
  verifyPassword,
} from "./password";

interface PwdVector {
  name: string;
  password: string;
  salt: string;
  algo: string;
  iter: number;
  key_len: number;
  stored_hash: string;
  upstream_ref: string;
}

const vectors: PwdVector[] = fixtures.vectors;

/**
 * The EXECUTABLE vectors — everything except `pbkdf2_hi`: its spec
 * `pbkdf2$320000$50` sits above the production Workers PBKDF2 iteration cap
 * (B-85, workerd#1346), so the parser routes it to the controlled
 * PasswordHashUnsupportedError and no hash/verify call may run it (it is the
 * guard's own pin row, in the describe below). Keeping the vector in the
 * fixture is deliberate: a configured upstream instance CAN store such a
 * row (setting.go:33), and the fixture records its exact digest for the day
 * the cap question is revisited.
 */
const HASHABLE_VECTORS = vectors.filter((v) => v.name !== "pbkdf2_hi");

/** The 8 named vectors, in file order — guards the fixture copy. */
const EXPECTED_NAMES = [
  "pbkdf2_v2_default_ascii",
  "pbkdf2_v2_utf8_multibyte",
  "pbkdf2_v2_second_salt",
  "pbkdf2_bare_legacy_ascii",
  "pbkdf2_bare_legacy_utf8",
  "pbkdf2_legacy_raw_10byte_salt",
  "pbkdf2_hi",
  "pbkdf2_v1",
];

/**
 * Map a fixture to the STORED algorithm specification it represents.
 * - "pbkdf2" + iter 10000 = the bare legacy arm (hash.go:116) — stored "pbkdf2"
 * - "pbkdf2" + iter 50000 = the CONFIGURED default arm — stored
 *   "pbkdf2$50000$50" (setting.go:26,30 dealias; security.go:175)
 * - specs with "$" are stored verbatim ("pbkdf2$320000$50", "pbkdf2$10000$50")
 */
function storedSpecOf(vector: PwdVector): string {
  if (vector.algo.includes("$")) return vector.algo;
  if (vector.iter === 50000) return CONFIGURED_HASH_SPEC;
  return "pbkdf2";
}

describe("known-answer vectors (8, Go+Python cross-checked)", () => {
  it("carries exactly the 8 named vectors, of which 7 are executable", () => {
    expect(vectors.map((v) => v.name)).toEqual(EXPECTED_NAMES);
    // pbkdf2_hi is the production-cap refused row (B-85) — the loops below
    // must never quietly re-include it.
    expect(HASHABLE_VECTORS.map((v) => v.name)).toEqual(EXPECTED_NAMES.filter((n) => n !== "pbkdf2_hi"));
    expect(vectors.find((v) => v.name === "pbkdf2_hi")?.algo).toBe("pbkdf2$320000$50");
  });

  it("every EXECUTABLE vector hashPasswordWithAlgo reproduces the stored hash byte-exact", async () => {
    for (const v of HASHABLE_VECTORS) {
      await expect(hashPasswordWithAlgo(v.password, v.salt, storedSpecOf(v)), v.name).resolves.toBe(
        v.stored_hash,
      );
    }
  });

  it("every EXECUTABLE vector verifies", async () => {
    for (const v of HASHABLE_VECTORS) {
      await expect(verifyPassword(v.password, v.stored_hash, v.salt, storedSpecOf(v)), v.name).resolves.toBe(
        true,
      );
    }
  });

  it("every EXECUTABLE wrong-password fails", async () => {
    for (const v of HASHABLE_VECTORS) {
      await expect(
        verifyPassword(`${v.password}-wrong`, v.stored_hash, v.salt, storedSpecOf(v)),
        v.name,
      ).resolves.toBe(false);
    }
  });

  it("covers both salt decode paths (32-hex hex-decoded + 10-char raw bytes)", () => {
    const hexVector = vectors.find((v) => v.name === "pbkdf2_v2_default_ascii");
    const rawVector = vectors.find((v) => v.name === "pbkdf2_legacy_raw_10byte_salt");
    expect(hexVector).toBeDefined();
    expect(rawVector).toBeDefined();
    expect(hexVector?.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(rawVector?.salt).toHaveLength(10);
    // hash.go:49-50 — the 10-char salt goes in as its RAW string bytes.
    expect(Array.from(decodeSaltBytes(rawVector?.salt ?? ""))).toEqual([
      82, 50, 117, 114, 121, 82, 57, 101, 51, 107,
    ]);
    // hash.go:52-56 — the 32-char salt is HEX-DECODED to 16 bytes.
    expect(Array.from(decodeSaltBytes(hexVector?.salt ?? ""))).toEqual([
      161, 178, 195, 212, 229, 246, 7, 24, 41, 58, 75, 92, 109, 126, 143, 144,
    ]);
  });

  it("TRIPWIRE: the naive raw-UTF-8 salt reading produces DIFFERENT digests", async () => {
    // The make-or-break of §6.1: treating the stored 32-char salt string as
    // raw UTF-8 bytes (instead of hex-decoding) must NOT reproduce any
    // vector — if this ever starts matching, the decode rule regressed.
    const v = vectors[0]!;
    const naive = await pbkdf2Sha256Hex(v.password, new TextEncoder().encode(v.salt), v.iter, v.key_len);
    expect(naive).not.toBe(v.stored_hash);
    expect(await pbkdf2Sha256Hex(v.password, decodeSaltBytes(v.salt), v.iter, v.key_len)).toBe(v.stored_hash);
  });

  it("verify returns false (not a throw) when the stored salt is invalid hex (hash.go:71-75)", async () => {
    await expect(verifyPassword("pw", vectors[0]!.stored_hash, "zzzz-not-hex!", CONFIGURED_HASH_SPEC)).resolves.toBe(
      false,
    );
    expect(() => decodeSaltBytes("zzzz-not-hex!")).toThrow(PasswordHashSaltError);
  });
});

describe("parseStoredHashAlgo (hash.go:134-189)", () => {
  it('"" and bare "pbkdf2" are the legacy iter-10000 arm — DO NOT COALESCE', () => {
    expect(parseStoredHashAlgo("")).toEqual({
      hasher: "pbkdf2",
      iter: 10000,
      keyLen: 50,
      specification: "pbkdf2",
    });
    expect(parseStoredHashAlgo("pbkdf2")).toEqual({
      hasher: "pbkdf2",
      iter: 10000,
      keyLen: 50,
      specification: "pbkdf2",
    });
    // The configured default is a DIFFERENT arm even though both read "pbkdf2".
    expect(parseStoredHashAlgo(CONFIGURED_HASH_SPEC).iter).toBe(50000);
  });

  it('parses the "pbkdf2$<iter>$<keyLen>" family up to the production cap', () => {
    expect(parseStoredHashAlgo("pbkdf2$50000$50")).toEqual({
      hasher: "pbkdf2",
      iter: 50000,
      keyLen: 50,
      specification: "pbkdf2$50000$50",
    });
    // 320000 sits ABOVE the cap — refused, the B-85 describe below.
    expect(() => parseStoredHashAlgo("pbkdf2$320000$50")).toThrow(PasswordHashUnsupportedError);
    expect(parseStoredHashAlgo("pbkdf2$10000$64").keyLen).toBe(64);
  });

  it("throws the controlled error for non-pbkdf2 hashers (Phase B boundary)", () => {
    for (const spec of [
      "argon2",
      "argon2$2$65536$8$50",
      "bcrypt",
      "bcrypt$10",
      "scrypt",
      "scrypt$65536$16$2$50",
      // Alias NAMES are not stored specs — a stored "pbkdf2_hi" is unknown
      // to hash.Parse (only full specs are stored; setting.go dealiases at
      // CONFIGURE time, hash.go:124-133 does NOT dealias stored values).
      "pbkdf2_hi",
      "pbkdf2_v1",
      "pbkdf2_v2",
      "dummy",
    ]) {
      expect(() => parseStoredHashAlgo(spec), spec).toThrow(PasswordHashUnsupportedError);
    }
  });

  it("throws for malformed pbkdf2 configs (pbkdf2.go:53-66)", () => {
    for (const spec of ["pbkdf2$50000", "pbkdf2$abc$50", "pbkdf2$50000$xyz", "pbkdf2$50000$50$extra"]) {
      expect(() => parseStoredHashAlgo(spec), spec).toThrow(PasswordHashUnsupportedError);
    }
  });

  it("carries the failing spec on the error for the server log", () => {
    try {
      parseStoredHashAlgo("argon2$2$65536$8$50");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordHashUnsupportedError);
      expect((error as PasswordHashUnsupportedError).specification).toBe("argon2$2$65536$8$50");
      expect((error as PasswordHashUnsupportedError).message).toContain("argon2");
    }
  });
});

describe("the production PBKDF2 iteration cap (B-85 — PW4's rule-4 class)", () => {
  /** The fixture's pbkdf2_hi row: what a configured upstream instance
   *  (setting.go:33) can legitimately store. */
  const hiVector = vectors.find((v) => v.name === "pbkdf2_hi");
  if (hiVector === undefined) throw new Error("pbkdf2_hi fixture missing — the cap pin needs its row");

  const LEGACY_SALT = "0123456789abcdef0123456789abcdef"; // 32-hex, both decode eras happy

  it("the boundary: exactly-at-cap parses, above-cap refuses", () => {
    expect(parseStoredHashAlgo(`pbkdf2$${PRODUCTION_PBKDF2_ITERATION_CAP}$50`)).toEqual({
      hasher: "pbkdf2",
      iter: 100000,
      keyLen: 50,
      specification: "pbkdf2$100000$50",
    });
    expect(() => parseStoredHashAlgo(`pbkdf2$${PRODUCTION_PBKDF2_ITERATION_CAP + 1}$50`)).toThrow(
      PasswordHashUnsupportedError,
    );
  });

  it("a stored 320k-spec row (the pbkdf2_hi dealias) verifies FAILS-CONTROLLED, never a raw platform throw", async () => {
    // The row's digest is the real Go-generated one — but no verify may
    // reach deriveBits: parse routes first, identically in local workerd
    // and production (the environments otherwise disagree, workerd#1346).
    expect(hiVector.algo).toBe("pbkdf2$320000$50");
    await expect(verifyPassword(hiVector.password, hiVector.stored_hash, hiVector.salt, hiVector.algo)).rejects.toBeInstanceOf(
      PasswordHashUnsupportedError,
    );
    await expect(verifyPassword(hiVector.password + "-wrong", hiVector.stored_hash, hiVector.salt, hiVector.algo)).rejects.toBeInstanceOf(
      PasswordHashUnsupportedError,
    );
    await expect(hashPasswordWithAlgo(hiVector.password, hiVector.salt, hiVector.algo)).rejects.toBeInstanceOf(
      PasswordHashUnsupportedError,
    );
  });

  it("the controlled error carries the spec and a loggable cause naming the cap", async () => {
    try {
      await verifyPassword("pw", "ab".repeat(50), LEGACY_SALT, "pbkdf2$320000$50");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordHashUnsupportedError);
      const unsupported = error as PasswordHashUnsupportedError;
      expect(unsupported.specification).toBe("pbkdf2$320000$50");
      expect(unsupported.message).toContain("320000");
      expect(unsupported.message).toContain(String(PRODUCTION_PBKDF2_ITERATION_CAP));
    }
  });

  it("the 50k configured default and the legacy 10k arms are UNCHANGED below the cap", async () => {
    const record = await newPasswordRecord("cap-unaffected-Pw0rd!");
    expect(await verifyPassword("cap-unaffected-Pw0rd!", record.passwd, record.salt, record.passwdHashAlgo)).toBe(true);
    await expect(verifyPassword("pw", "ab".repeat(50), LEGACY_SALT, "pbkdf2$10000$50")).resolves.toBe(false);
    await expect(verifyPassword("pw", "ab".repeat(50), LEGACY_SALT, "pbkdf2")).resolves.toBe(false);
  });

  it("ASYMMETRY DOCUMENTED: local workerd EXECUTES above-cap deriveBits (production refuses it, workerd#1346) — the guard must live at parse time", async () => {
    // The live probe proves the local-vs-production split the benchmark
    // (§5.4 iterationCapProbe) measured: the LOCAL workerd vitest runs in
    // happily derives above the cap. Production derives NOTHING here — it
    // throws mid-call. If a future workerd starts enforcing locally, this
    // assertion's premise lapses; the parse-time guard stays correct in
    // either world, which is exactly why the route went through
    // PasswordHashUnsupportedError instead of relying on the platform.
    const above = PRODUCTION_PBKDF2_ITERATION_CAP + 1;
    const localDigest = await pbkdf2Sha256Hex("asymmetry-probe", new TextEncoder().encode(LEGACY_SALT), above, 50);
    expect(localDigest).toMatch(/^[0-9a-f]{100}$/);
    // …so a verify with an above-cap spec must be refused by the PARSER
    // (before any WebCrypto call), never by an environment-dependent throw.
    await expect(
      verifyPassword("asymmetry-probe", localDigest, LEGACY_SALT, `pbkdf2$${above}$50`),
    ).rejects.toBeInstanceOf(PasswordHashUnsupportedError);
  });
});

describe("hashAlgorithmToSpec (setting.go:45-55, config-side ONLY)", () => {
  it('dealiases the configured default "pbkdf2" transitively to "pbkdf2$50000$50"', () => {
    expect(hashAlgorithmToSpec(CONFIGURED_HASH_ALGO)).toBe(CONFIGURED_HASH_SPEC);
    expect(hashAlgorithmToSpec("")).toBe(CONFIGURED_HASH_SPEC);
    expect(hashAlgorithmToSpec("pbkdf2_v2")).toBe(CONFIGURED_HASH_SPEC);
  });

  it("maps the full upstream alias table", () => {
    expect(hashAlgorithmToSpec("pbkdf2_v1")).toBe("pbkdf2$10000$50");
    expect(hashAlgorithmToSpec("pbkdf2_hi")).toBe("pbkdf2$320000$50");
    expect(hashAlgorithmToSpec("argon2")).toBe("argon2$2$65536$8$50");
    expect(hashAlgorithmToSpec("bcrypt")).toBe("bcrypt$10");
    expect(hashAlgorithmToSpec("scrypt")).toBe("scrypt$65536$16$2$50");
  });

  it("resolves to a spec the Phase A parser rejects for non-pbkdf2 hashers", () => {
    expect(() => parseStoredHashAlgo(hashAlgorithmToSpec("argon2"))).toThrow(PasswordHashUnsupportedError);
  });
});

describe("newSalt (user.go:555-565)", () => {
  it("returns 32 lowercase hex chars that decode to 16 bytes", () => {
    const salt = newSalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(decodeSaltBytes(salt)).toHaveLength(16);
  });

  it("is crypto-random (distinct across draws)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(newSalt());
    expect(seen.size).toBe(50);
  });

  it("the generated salt round-trips through the configured hash arm", async () => {
    const salt = newSalt();
    const digest = await hashPasswordWithAlgo("roundtrip-pw", salt, CONFIGURED_HASH_SPEC);
    expect(await verifyPassword("roundtrip-pw", digest, salt, CONFIGURED_HASH_SPEC)).toBe(true);
    expect(await verifyPassword("wrong-pw", digest, salt, CONFIGURED_HASH_SPEC)).toBe(false);
  });
});

describe("needsRehash (authenticate.go:60) truth table", () => {
  it("algo mismatch or salt-length mismatch both trigger", () => {
    const goodSalt = newSalt();
    expect(needsRehash(CONFIGURED_HASH_SPEC, goodSalt)).toBe(false);
    expect(needsRehash("pbkdf2", goodSalt)).toBe(true); // bare legacy arm
    expect(needsRehash("argon2$2$65536$8$50", goodSalt)).toBe(true);
    expect(needsRehash("", goodSalt)).toBe(true);
    expect(needsRehash(CONFIGURED_HASH_SPEC, "abcdefghij")).toBe(true); // 10-char legacy salt
    expect(needsRehash(CONFIGURED_HASH_SPEC, "")).toBe(true);
    expect(needsRehash(CONFIGURED_HASH_SPEC, goodSalt.slice(0, 31))).toBe(true);
  });
});

describe("isPasswordSet (user.go:427-430)", () => {
  it("empty row never set; anything else set", () => {
    expect(isPasswordSet("")).toBe(false);
    expect(isPasswordSet("digest-hex")).toBe(true);
  });
});

describe("newPasswordRecord (user.go:407-414 SetPassword pure part)", () => {
  it("produces the configured-algo record and round-trips", async () => {
    const record = await newPasswordRecord("s3cure-Passw0rd!");
    expect(record.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(record.passwd).toMatch(/^[0-9a-f]{100}$/); // keyLen 50 → 100 hex chars
    expect(record.passwdHashAlgo).toBe(CONFIGURED_HASH_SPEC);
    expect(await verifyPassword("s3cure-Passw0rd!", record.passwd, record.salt, record.passwdHashAlgo)).toBe(true);
    expect(await verifyPassword("other", record.passwd, record.salt, record.passwdHashAlgo)).toBe(false);
  });

  it("needsRehash(record) is false — a fresh record never rehashes", async () => {
    const record = await newPasswordRecord("pw");
    expect(needsRehash(record.passwdHashAlgo, record.salt)).toBe(false);
  });

  it("two records for the same password differ (fresh salt per call)", async () => {
    const a = await newPasswordRecord("same-pw");
    const b = await newPasswordRecord("same-pw");
    expect(a.salt).not.toBe(b.salt);
    expect(a.passwd).not.toBe(b.passwd);
  });
});

describe("bytesToHex (the digest/salt wire format)", () => {
  it("hex-encodes bytes lowercase without padding", () => {
    expect(bytesToHex(new Uint8Array([0x0f, 0xa1, 0x02]))).toBe("0fa102");
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});
