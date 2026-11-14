/**
 * Password hash service tests — SPEC-0002 §6.6 + census B-86.
 *
 * Known-answer vectors: the 8 Go-generated pbkdf2 fixtures (pin fc493688,
 * Python-hashlib cross-checked, /tmp/pwd-vectors/pwd-fixtures.json copied
 * to password-fixtures.json) and — since B-86 — the 8 Go-generated
 * argon2id/bcrypt fixtures (/tmp/b86-pwd-vectors/pwd-wasm-fixtures.json
 * copied to password-wasm-fixtures.json; golang.org/x/crypto argon2.IDKey +
 * bcrypt.GenerateFromPassword/CompareHashAndPassword, generator notes in
 * that file's header). The suite FAILS if the salt decode rule regresses —
 * the raw-string vs hex-decoded digests differ by design (§6.1 THE SALT
 * CHAIN); the explicit naive-decode tripwire below pins that property
 * forever.
 */

import { describe, expect, it } from "vitest";

import fixtures from "./password-fixtures.json";
import wasmFixtures from "./password-wasm-fixtures.json";
import {
  CONFIGURED_HASH_ALGO,
  CONFIGURED_HASH_SPEC,
  PRODUCTION_ARGON2_MEMORY_CEILING_BYTES,
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
    expect(parseStoredHashAlgo(CONFIGURED_HASH_SPEC)).toEqual({
      hasher: "pbkdf2",
      iter: 50000,
      keyLen: 50,
      specification: CONFIGURED_HASH_SPEC,
    });
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
    expect(parseStoredHashAlgo("pbkdf2$10000$64")).toEqual({
      hasher: "pbkdf2",
      iter: 10000,
      keyLen: 64,
      specification: "pbkdf2$10000$64",
    });
  });

  it("throws the controlled error for hashers outside the landed families (scrypt/unknown — argon2/bcrypt verify since B-86)", () => {
    for (const spec of [
      "scrypt",
      "scrypt$65536$16$2$50",
      // Alias NAMES are not stored specs — a stored "pbkdf2_hi" is unknown
      // to hash.Parse (only full specs are stored; setting.go dealiases at
      // CONFIGURE time, hash.go:124-133 does NOT dealias stored values).
      "pbkdf2_hi",
      "pbkdf2_v1",
      "pbkdf2_v2",
      "dummy",
      // The bcrypt/argon2 CORRUPTED-config class: bcrypt$<cost> is Atoi
      // (bcrypt.go:33-48), argon2's four params are ParseUint at fixed
      // widths (argon2.go:52-66) — invalid configs are the controlled
      // unsupported arm, upstream's nil-hasher/panic class. ("argon2$"/
      // "bcrypt$" are NOT here: an empty config parses as the defaults,
      // hash.go's SplitN + NewXxxHasher("") semantics.)
      "argon2$2$65536$8",
      "argon2$2$65536$8$50$extra",
      "argon2$a$65536$8$50",
      "argon2$-2$65536$8$50",
      "argon2$+2$65536$8$50",
      "argon2$4294967296$65536$8$50",
      "argon2$2$65536$256$50",
      "argon2$0$65536$8$50",
      "argon2$2$65536$0$50",
      "argon2$2$8$8$50",
      "bcrypt$abc",
      "bcrypt$1.5",
      "bcrypt$99999999999999999999999",
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
      parseStoredHashAlgo("scrypt$65536$16$2$50");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PasswordHashUnsupportedError);
      expect((error as PasswordHashUnsupportedError).specification).toBe("scrypt$65536$16$2$50");
      expect((error as PasswordHashUnsupportedError).message).toContain("scrypt");
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

  it("resolves to specs the landed parser accepts for argon2/bcrypt and rejects for scrypt (B-86)", () => {
    expect(parseStoredHashAlgo(hashAlgorithmToSpec("argon2")).hasher).toBe("argon2");
    expect(parseStoredHashAlgo(hashAlgorithmToSpec("bcrypt")).hasher).toBe("bcrypt");
    expect(() => parseStoredHashAlgo(hashAlgorithmToSpec("scrypt"))).toThrow(PasswordHashUnsupportedError);
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

// ---------------------------------------------------------------------------------
// Census B-87's consumption half — the CONFIGURED algorithm is ENV-DRIVEN:
// the arms accept the caller's env-resolved specification
// (api/config.ts configuredPasswordHashAlgo(env).specification), the landed
// pbkdf2 default stands when a caller passes none, and an unexecutable
// configured spec refuses through the controlled parse error (upstream's
// boot log.Fatal, security.go:176-178 — Workers has no boot hook).
// ---------------------------------------------------------------------------------

describe("the env-driven configured algorithm (B-87: configuredSpec threading)", () => {
  const LEGACY_FLOOR_SPEC = "pbkdf2$10000$50"; // executable, below the cap (the pbkdf2_v1 dealias)

  it("newPasswordRecord hashes and stores the PASSED spec; omitted keeps the landed default", async () => {
    const threaded = await newPasswordRecord("threaded-Pw0rd!", LEGACY_FLOOR_SPEC);
    expect(threaded.passwdHashAlgo).toBe(LEGACY_FLOOR_SPEC);
    expect(await verifyPassword("threaded-Pw0rd!", threaded.passwd, threaded.salt, threaded.passwdHashAlgo)).toBe(true);
    // The digest really used the passed parameters (10k iter → verifiable
    // only under the same spec's parse) and the salt is a fresh 32-hex.
    expect(threaded.salt).toMatch(/^[0-9a-f]{32}$/);

    const byDefault = await newPasswordRecord("default-Pw0rd!");
    expect(byDefault.passwdHashAlgo).toBe(CONFIGURED_HASH_SPEC);
    expect(needsRehash(byDefault.passwdHashAlgo, byDefault.salt)).toBe(false);
  });

  it("needsRehash compares against the CONFIGURED algo, not the hardcoded default", () => {
    const goodSalt = newSalt();
    // An instance configured to the pbkdf2_v1 floor: its stored rows need no
    // rehash, but a row from the OLD default does.
    expect(needsRehash(LEGACY_FLOOR_SPEC, goodSalt, LEGACY_FLOOR_SPEC)).toBe(false);
    expect(needsRehash(CONFIGURED_HASH_SPEC, goodSalt, LEGACY_FLOOR_SPEC)).toBe(true);
    // Omitted configuredSpec: the landed default is the comparison target
    // (the pre-B-87 posture, byte-identical).
    expect(needsRehash(LEGACY_FLOOR_SPEC, goodSalt)).toBe(true);
    // Salt-length rule rides unchanged on the threaded arm.
    expect(needsRehash(LEGACY_FLOOR_SPEC, "abcdefghij", LEGACY_FLOOR_SPEC)).toBe(true);
  });

  it("an UNEXECUTABLE configured spec refuses through the controlled parse error (the log.Fatal posture)", async () => {
    // scrypt: platform-impossible family; pbkdf2_hi: above the production cap.
    for (const name of ["scrypt", "pbkdf2_hi"]) {
      const spec = hashAlgorithmToSpec(name);
      // The reader's executable flag is exactly this parse failing.
      expect(() => parseStoredHashAlgo(spec), name).toThrow(PasswordHashUnsupportedError);
      await expect(newPasswordRecord("refused-pw", spec)).rejects.toBeInstanceOf(PasswordHashUnsupportedError);
    }
    // The stored record is untouched by a refused SetPassword — the throw
    // happens before any digest is produced (parse-first inside
    // hashPasswordWithAlgo), so a caller never persists a half record.
  });

  it("an executable-but-verify-only configured spec (argon2) refuses through the same controlled error", async () => {
    const spec = hashAlgorithmToSpec("argon2");
    expect(parseStoredHashAlgo(spec).hasher).toBe("argon2"); // parses fine…
    // …but hashing under it is not implemented (the B-86 arms are
    // verify-only) — the refusal is explicit, never a silent pbkdf2 digest.
    await expect(newPasswordRecord("argon2-configured-pw", spec)).rejects.toBeInstanceOf(PasswordHashUnsupportedError);
    // And the comparison half: a stored old-default row WOULD rehash toward
    // the configured argon2 spec (the caller's newPasswordRecord then
    // refuses — the explicit-error posture, ADR-0008 rule 4).
    expect(needsRehash(CONFIGURED_HASH_SPEC, newSalt(), spec)).toBe(true);
  });
});

describe("bytesToHex (the digest/salt wire format)", () => {
  it("hex-encodes bytes lowercase without padding", () => {
    expect(bytesToHex(new Uint8Array([0x0f, 0xa1, 0x02]))).toBe("0fa102");
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});

// --- Census B-86: the argon2id + bcrypt VERIFY arms (Go-fixture pins) ---

interface WasmVector {
  name: string;
  password: string;
  salt: string;
  algo: string;
  stored_hash: string;
  upstream_ref: string;
  derivation_note?: string;
}

const wasmVectors: WasmVector[] = wasmFixtures.vectors;
const argon2Vectors = wasmVectors.filter((v) => v.name.startsWith("argon2id_"));
const bcryptVectors = wasmVectors.filter((v) => v.name.startsWith("bcrypt_"));

describe("argon2id verify arm (B-86 — Go-IDKey known answers, pin fc493688)", () => {
  it("carries exactly the 4 named argon2id vectors", () => {
    expect(argon2Vectors.map((v) => v.name)).toEqual([
      "argon2id_default_ascii",
      "argon2id_default_utf8",
      "argon2id_bare_legacy",
      "argon2id_alt_params",
    ]);
    expect(wasmFixtures.pin).toBe("go-gitea/gitea fc4936884584");
  });

  it("every vector verifies (incl. UTF-8 password bytes and the alt param set)", async () => {
    for (const v of argon2Vectors) {
      await expect(verifyPassword(v.password, v.stored_hash, v.salt, v.algo), v.name).resolves.toBe(true);
    }
  });

  it("every wrong-password fails (mismatch, never a throw)", async () => {
    for (const v of argon2Vectors) {
      await expect(verifyPassword(`${v.password}-wrong`, v.stored_hash, v.salt, v.algo), v.name).resolves.toBe(false);
    }
  });

  it("parses the spec families: configured default, bare arm = the MUST-NOT-CHANGE defaults, alt params plumb through", () => {
    expect(parseStoredHashAlgo("argon2$2$65536$8$50")).toEqual({
      hasher: "argon2",
      time: 2,
      memoryKiB: 65536,
      threads: 8,
      keyLen: 50,
      specification: "argon2$2$65536$8$50",
    });
    // hash.go:124-133 stored values are NOT dealiased — the bare name takes
    // argon2.go:25-31's pre-config defaults (numerically the same set here).
    expect(parseStoredHashAlgo("argon2")).toEqual({
      hasher: "argon2",
      time: 2,
      memoryKiB: 65536,
      threads: 8,
      keyLen: 50,
      specification: "argon2",
    });
    expect(parseStoredHashAlgo("argon2$3$32768$4$32")).toEqual({
      hasher: "argon2",
      time: 3,
      memoryKiB: 32768,
      threads: 4,
      keyLen: 32,
      specification: "argon2$3$32768$4$32",
    });
  });

  it("the memory ceiling: exactly-at parses, above refuses (B-85's sibling guard)", () => {
    // (134217728 - 1024) / 1024 = 131071 KiB is the largest argon2.wasm
    // allocation that fits the 128 MiB isolate ceiling. Parse-only pins —
    // verifying at the ceiling would claim the whole isolate budget.
    const atCeiling = Math.floor((PRODUCTION_ARGON2_MEMORY_CEILING_BYTES - 1024) / 1024);
    expect(parseStoredHashAlgo(`argon2$2$${atCeiling}$8$50`)).toEqual({
      hasher: "argon2",
      time: 2,
      memoryKiB: 131071,
      threads: 8,
      keyLen: 50,
      specification: `argon2$2$${atCeiling}$8$50`,
    });
    expect(() => parseStoredHashAlgo(`argon2$2$${atCeiling + 1}$8$50`)).toThrow(PasswordHashUnsupportedError);
    try {
      parseStoredHashAlgo("argon2$2$999999999$8$50");
      expect.unreachable();
    } catch (error) {
      expect((error as PasswordHashUnsupportedError).message).toContain("isolate ceiling");
    }
  });

  it("verify on a corrupted argon2 spec FAILS-CONTROLLED (never a silent false)", async () => {
    await expect(verifyPassword("pw", "ab".repeat(50), newSalt(), "argon2$2$65536$8")).rejects.toBeInstanceOf(
      PasswordHashUnsupportedError,
    );
    await expect(verifyPassword("pw", "ab".repeat(50), newSalt(), "argon2$0$65536$8$50")).rejects.toBeInstanceOf(
      PasswordHashUnsupportedError,
    );
  });

  it("hashPasswordWithAlgo REFUSES the non-pbkdf2 families — the B-86 arms are verify-only", async () => {
    for (const spec of ["argon2$2$65536$8$50", "argon2", "bcrypt$10", "bcrypt"]) {
      await expect(hashPasswordWithAlgo("pw", newSalt(), spec)).rejects.toBeInstanceOf(PasswordHashUnsupportedError);
    }
    // The configured pbkdf2 arm is untouched.
    const salt = newSalt();
    expect(await hashPasswordWithAlgo("pw", salt, CONFIGURED_HASH_SPEC)).toMatch(/^[0-9a-f]{100}$/);
  });

  it("needsRehash answers true for every argon2 spec — authenticate.go:60 migrates them on login", () => {
    const goodSalt = newSalt();
    for (const v of argon2Vectors) {
      expect(needsRehash(v.algo, goodSalt), v.algo).toBe(true);
    }
  });
});

describe("bcrypt verify arm (B-86 — Go-GenerateFromPassword known answers)", () => {
  it("carries exactly the 4 named bcrypt vectors, with the $2b$ one derived-and-recorded", () => {
    expect(bcryptVectors.map((v) => v.name)).toEqual([
      "bcrypt_cost10_ascii",
      "bcrypt_cost12_utf8",
      "bcrypt_bare_legacy",
      "bcrypt_2b_prefix_derived",
    ]);
    expect(bcryptVectors.find((v) => v.name === "bcrypt_2b_prefix_derived")?.derivation_note).toContain("$2a$");
    expect(bcryptVectors.find((v) => v.name === "bcrypt_bare_legacy")?.algo).toBe("bcrypt");
  });

  it("every vector verifies — the full crypt string IS the stored passwd (bcrypt.go:21-24)", async () => {
    for (const v of bcryptVectors) {
      await expect(verifyPassword(v.password, v.stored_hash, v.salt, v.algo), v.name).resolves.toBe(true);
    }
  });

  it("every wrong-password fails (CompareHashAndPassword's mismatch arm)", async () => {
    for (const v of bcryptVectors) {
      await expect(verifyPassword(`${v.password}-wrong`, v.stored_hash, v.salt, v.algo), v.name).resolves.toBe(false);
    }
  });

  it("the salt column is UNUSED on the bcrypt arm (bcrypt.go:30-32) — even invalid salts never touch it", async () => {
    const v = bcryptVectors.find((bv) => bv.name === "bcrypt_cost10_ascii")!;
    // The SAME salt string throws PasswordHashSaltError on the pbkdf2/argon2
    // arms (hash.go:52-57) — on the bcrypt arm upstream never decodes it.
    await expect(verifyPassword(v.password, v.stored_hash, "zzzz-not-hex!", v.algo)).resolves.toBe(true);
    await expect(verifyPassword(v.password, v.stored_hash, "", v.algo)).resolves.toBe(true);
    expect(() => decodeSaltBytes("zzzz-not-hex!")).toThrow(PasswordHashSaltError);
  });

  it("the spec's cost is recorded only — verify uses the hash-embedded cost (bcrypt.go:30-32)", async () => {
    const v = bcryptVectors.find((bv) => bv.name === "bcrypt_cost10_ascii")!;
    for (const spec of ["bcrypt$10", "bcrypt", "bcrypt$99", "bcrypt$+10", "bcrypt$-3"]) {
      await expect(verifyPassword(v.password, v.stored_hash, v.salt, spec), spec).resolves.toBe(true);
    }
    expect(parseStoredHashAlgo("bcrypt")).toEqual({ hasher: "bcrypt", cost: 10, specification: "bcrypt" });
    expect(parseStoredHashAlgo("bcrypt$+10")).toEqual({ hasher: "bcrypt", cost: 10, specification: "bcrypt$+10" });
  });

  it("malformed crypt strings fail silently-false — upstream's error-return mapping, never a throw", async () => {
    const password = "correct horse battery staple";
    for (const hash of [
      "",
      "short",
      "$2a$10$short",
      "$9a$10$WQOp0.poqM2QNESrnqRlW.KkjOVkB8mA4keLOXDhdXQ3EccDZN9Sq", // wrong major version
      "$2c$10$WQOp0.poqM2QNESrnqRlW.KkjOVkB8mA4keLOXDhdXQ3EccDZN9Sq", // minor outside the crypt_blowfish family
      "$2a$03$WQOp0.poqM2QNESrnqRlW.KkjOVkB8mA4keLOXDhdXQ3EccDZN9Sq", // cost 3 < 4
      "$2a$32$WQOp0.poqM2QNESrnqRlW.KkjOVkB8mA4keLOXDhdXQ3EccDZN9Sq", // cost 32 > 31
      "$2a$10$!!!!0.poqM2QNESrnqRlW.KkjOVkB8mA4keLOXDhdXQ3EccDZN9Sq", // non-b64 characters
    ]) {
      await expect(verifyPassword(password, hash, "ignored-anyway", "bcrypt$10"), hash.slice(0, 16)).resolves.toBe(
        false,
      );
    }
  });

  it("an over-72-byte password verifies WITHOUT throwing — truncated to 72 (Go's compare buffer)", async () => {
    const v = bcryptVectors.find((bv) => bv.name === "bcrypt_cost10_ascii")!;
    const extended = v.password + "-suffix-padding-the-password-well-past-the-72-byte-mark!!";
    expect(new TextEncoder().encode(extended).length).toBeGreaterThan(72);
    await expect(verifyPassword(extended, v.stored_hash, v.salt, v.algo)).resolves.toBe(false);
  });

  it("needsRehash answers true for every bcrypt spec — authenticate.go:60 migrates them on login", () => {
    const goodSalt = newSalt();
    for (const v of bcryptVectors) {
      expect(needsRehash(v.algo, goodSalt), v.algo).toBe(true);
    }
  });
});
