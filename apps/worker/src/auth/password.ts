/**
 * Password hashing — SPEC-0002 §6 Phase A (the pbkdf2 family).
 *
 * Pure module: no schema, no route imports. Mirrors upstream at pin
 * v29.0.0-dev-208-gfc493688:
 * - modules/auth/password/hash/hash.go:42-60    salt decode (BOTH eras)
 * - modules/auth/password/hash/hash.go:63-79    verify (constant-time, log-and-false on hash error)
 * - modules/auth/password/hash/hash.go:108-135  bare "pbkdf2" parse (DO NOT COALESCE)
 * - modules/auth/password/hash/pbkdf2.go:27-67  PBKDF2-HMAC-SHA256 (iter/keyLen)
 * - modules/auth/password/hash/setting.go:13-64 dealias chain (config default ONLY)
 * - models/user/user.go:407-414  SetPassword (new salt + current algo)
 * - models/user/user.go:427-430  IsPasswordSet (passwd !== "")
 * - models/user/user.go:555-565  GetUserSalt (hex(16 random bytes))
 *
 * The two pbkdf2 arms are DISTINCT and never coalesced (hash.go:108-135):
 * a stored bare "pbkdf2"/"" is the ORIGINAL unconfigured iter-10000/keyLen-50
 * algorithm (pbkdf2.go:44-47, "MUST NOT BE CHANGED"); the configured
 * PASSWORD_HASH_ALGO default "pbkdf2" dealiases to the spec
 * "pbkdf2$50000$50" (setting.go:26,30; security.go:175 stores the dealiased
 * spec). Phase A hardwires the configured algorithm (the knob is Phase C).
 *
 * Stored algorithms outside the pbkdf2 family (argon2/bcrypt/scrypt/unknown)
 * are unverifiable until Phase B: parsing raises the controlled
 * PasswordHashUnsupportedError (SPEC §6.3-3, ADR-0008 rule 4) — callers
 * translate it into upstream's generic auth failure on the wire while the
 * server log carries the cause; NEVER a silent mismatch. The same controlled
 * arm answers pbkdf2 specs ABOVE the production iteration cap (B-85 — PW4's
 * rule-4 class, the accepted-but-unexecutable parse; see the constant below).
 */

import { timingSafeDigestEqual } from "./digest";

/** The hardwired PASSWORD_HASH_ALGO config name (setting.go:13). */
export const CONFIGURED_HASH_ALGO = "pbkdf2";

/**
 * The PRODUCTION Workers PBKDF2 iteration cap (B-85): production deriveBits
 * refuses iterations above 100,000 (workerd#1346; SPEC-0002 §5.4's
 * iterationCapProbe) while the LOCAL workerd this repo tests in does NOT
 * enforce it — the test-asymmetry hazard the benchmark flagged. A stored
 * spec above the cap (e.g. `pbkdf2$320000$50`, the pbkdf2_hi dealias,
 * setting.go:33) verifies in every local test and would throw MID-VERIFY in
 * production; parseStoredHashAlgo routes such specs to the controlled
 * PasswordHashUnsupportedError at PARSE time, so both runtimes fail CLOSED
 * with the same controlled error (the same arm as the other unexecutable
 * parses) instead of a verify that diverges by environment.
 */
export const PRODUCTION_PBKDF2_ITERATION_CAP = 100_000;

/**
 * The dealiased configured specification stored in `passwd_hash_algo` on
 * every SetPassword (setting.go:26,30 + security.go:175).
 */
export const CONFIGURED_HASH_SPEC = "pbkdf2$50000$50";

/**
 * Bare stored name = the ORIGINAL pre-config algorithm (hash.go:116
 * defaultEmptyHashAlgorithmSpecification) — iter 10000 / keyLen 50
 * (pbkdf2.go:44-47, backwards-compat locked).
 */
const LEGACY_BARE_SPECIFICATION = "pbkdf2";
const LEGACY_BARE_ITER = 10_000;
const LEGACY_BARE_KEY_LEN = 50;

/** user.go:560 SaltByteLength — salts are hex(16 bytes) = 32 chars. */
export const SALT_BYTE_LENGTH = 16;

/**
 * Controlled parse failure for stored algorithms Phase A cannot verify
 * (SPEC §6.3-3): argon2/bcrypt/scrypt/unknown names and malformed
 * pbkdf2 configurations. Callers render upstream's generic auth failure;
 * this error's message carries the cause for the server log.
 */
export class PasswordHashUnsupportedError extends Error {
  /** The stored algorithm specification that failed to parse. */
  readonly specification: string;

  constructor(specification: string, cause: string) {
    super(`unsupported password hash algorithm spec "${specification}": ${cause}`);
    this.name = "PasswordHashUnsupportedError";
    this.specification = specification;
  }
}

/** hash.go:52-57 — the non-10-char salt must be valid hex. */
export class PasswordHashSaltError extends Error {
  constructor(salt: string) {
    super(`passwordhash: invalid hex salt of length ${salt.length}`);
    this.name = "PasswordHashSaltError";
  }
}

/** setting.go:22-34 aliasAlgorithmNames — resolved transitively (:45-55). */
const ALIAS_ALGORITHM_NAMES: Record<string, string> = {
  argon2: "argon2$2$65536$8$50",
  bcrypt: "bcrypt$10",
  scrypt: "scrypt$65536$16$2$50",
  pbkdf2: "pbkdf2_v2",
  pbkdf2_v1: "pbkdf2$10000$50",
  pbkdf2_v2: "pbkdf2$50000$50",
  pbkdf2_hi: "pbkdf2$320000$50",
};

/**
 * setting.go:45-55 hashAlgorithmToSpec: resolve a PASSWORD_HASH_ALGO name
 * through the alias chain to a full specification ("" = the default name).
 * Used ONLY for the configured algorithm; stored values are NOT dealiased
 * (hash.go:124-133).
 */
export function hashAlgorithmToSpec(algorithmName: string): string {
  let name = algorithmName === "" ? CONFIGURED_HASH_ALGO : algorithmName;
  let alias: string | undefined = ALIAS_ALGORITHM_NAMES[name];
  while (alias !== undefined) {
    name = alias;
    alias = ALIAS_ALGORITHM_NAMES[name];
  }
  return name;
}

/** A parsed algorithm specification (the usable subset of hash.Parse). */
export interface ParsedHashSpec {
  hasher: string;
  iter: number;
  keyLen: number;
  /** The specification exactly as stored/parsed (never dealiased). */
  specification: string;
}

/**
 * hash.go:134-189 Parse for the Phase A (pbkdf2-only) factory set.
 * "" and "pbkdf2" are the legacy bare arm (iter 10000/keyLen 50, DO NOT
 * COALESCE with the configured default); "pbkdf2$<iter>$<keyLen>" carries
 * explicit parameters (pbkdf2.go:38-67). Anything else — argon2, bcrypt,
 * scrypt, alias names like "pbkdf2_hi", malformed configs — raises the
 * controlled PasswordHashUnsupportedError.
 */
export function parseStoredHashAlgo(algorithmSpec: string): ParsedHashSpec {
  let spec = algorithmSpec;
  if (spec === "") {
    spec = LEGACY_BARE_SPECIFICATION;
  }

  const dollar = spec.indexOf("$");
  const hasherType = dollar === -1 ? spec : spec.slice(0, dollar);
  const config = dollar === -1 ? "" : spec.slice(dollar + 1);

  if (hasherType !== "pbkdf2") {
    throw new PasswordHashUnsupportedError(spec, `unknown hasher type "${hasherType}"`);
  }

  if (config === "") {
    return { hasher: hasherType, iter: LEGACY_BARE_ITER, keyLen: LEGACY_BARE_KEY_LEN, specification: spec };
  }

  // pbkdf2.go:53-57 — config must be exactly "<iter>$<keyLen>".
  const split = config.indexOf("$");
  if (split === -1) {
    throw new PasswordHashUnsupportedError(spec, `invalid pbkdf2 hash spec "${config}"`);
  }
  const iter = parseIntParam(spec, config.slice(0, split), "iter");
  const keyLen = parseIntParam(spec, config.slice(split + 1), "keyLen");
  if (iter < 1 || keyLen < 1) {
    // Upstream would run pbkdf2.Key with the raw (signed) ints; a corrupted
    // row lands here, and the controlled error is the honest arm (§6.3-3).
    throw new PasswordHashUnsupportedError(spec, `pbkdf2 params out of range: iter=${iter} keyLen=${keyLen}`);
  }
  if (iter > PRODUCTION_PBKDF2_ITERATION_CAP) {
    // B-85 (PW4's rule-4 class): production Workers refuse deriveBits above
    // the cap (workerd#1346) — a stored pbkdf2_hi-era spec would verify in
    // local tests and throw MID-VERIFY in production. The controlled
    // unsupported error here fails CLOSED identically in both runtimes;
    // never a verify whose outcome depends on the environment.
    throw new PasswordHashUnsupportedError(
      spec,
      `pbkdf2 iteration count ${iter} exceeds the production Workers cap ${PRODUCTION_PBKDF2_ITERATION_CAP} (workerd#1346)`,
    );
  }
  return { hasher: hasherType, iter, keyLen, specification: spec };
}

/** common.go:13-20 parseIntParam — strconv.Atoi semantics (optional sign). */
function parseIntParam(specification: string, value: string, param: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new PasswordHashUnsupportedError(specification, `invalid integer for ${param} representation`);
  }
  return Number(value);
}

/**
 * hash.go:42-60 — the stored salt decodes differently per era: the 10-char
 * pre-2022 binary salt is used RAW (its string bytes), everything else is
 * HEX-DECODED (the 32-char hex(16-byte) form GetUserSalt produces).
 */
export function decodeSaltBytes(salt: string): Uint8Array {
  if (salt.length === 10) {
    return new TextEncoder().encode(salt);
  }
  if (!/^[0-9a-fA-F]*$/.test(salt) || salt.length % 2 !== 0) {
    throw new PasswordHashSaltError(salt);
  }
  const out = new Uint8Array(salt.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(salt.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * pbkdf2.go:27-32 — hex(PBKDF2-HMAC-SHA256(utf8(password), saltBytes, iter,
 * keyLen)). Async because WebCrypto is (workerd native).
 */
export async function pbkdf2Sha256Hex(
  password: string,
  saltBytes: Uint8Array,
  iter: number,
  keyLen: number,
): Promise<string> {
  const passwordBytes = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes as BufferSource, iterations: iter },
    key,
    keyLen * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * hash.go:42-60 Hash — decode the salt per era, then hash under the given
 * STORED algorithm specification (never dealiased). Salt decode errors
 * propagate (upstream Hash returns the error; SetPassword's salt is always
 * self-generated so this is corrupted-row territory only).
 */
export async function hashPasswordWithAlgo(
  password: string,
  salt: string,
  storedAlgoSpec: string,
): Promise<string> {
  const parsed = parseStoredHashAlgo(storedAlgoSpec);
  const saltBytes = decodeSaltBytes(salt);
  return pbkdf2Sha256Hex(password, saltBytes, parsed.iter, parsed.keyLen);
}

/**
 * hash.go:63-79 VerifyPassword for the pbkdf2 family: recompute the
 * provided password's hash and compare constant-time. A salt decode error
 * logs and returns false (hash.go:71-75 — never a throw on the verify
 * path). An UNSUPPORTED stored algorithm throws the controlled
 * PasswordHashUnsupportedError — callers translate it to the generic auth
 * failure and log the cause (SPEC §6.3-3); returning false here would be
 * the silent mismatch ADR-0008 forbids.
 */
export async function verifyPassword(
  providedPassword: string,
  hashedPassword: string,
  salt: string,
  storedAlgoSpec: string,
): Promise<boolean> {
  const parsed = parseStoredHashAlgo(storedAlgoSpec);
  let providedHash: string;
  try {
    const saltBytes = decodeSaltBytes(salt);
    providedHash = await pbkdf2Sha256Hex(providedPassword, saltBytes, parsed.iter, parsed.keyLen);
  } catch (error) {
    if (error instanceof PasswordHashUnsupportedError) throw error;
    console.error(`passwordhash: ${parsed.specification}.Hash(): ${String(error)}`);
    return false;
  }
  return timingSafeDigestEqual(hashedPassword, providedHash);
}

/**
 * user.go:555-565 GetUserSalt — hex(16 crypto-random bytes), a 32-char
 * lowercase hex string. Also the rands generator (user.go:786 uses
 * GetUserSalt for Rands).
 */
export function newSalt(): string {
  const bytes = new Uint8Array(SALT_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Alias of newSalt for the rands column (user.go:786). */
export const newRands = newSalt;

/** Lowercase hex encoding of raw bytes (the digest/salt/code wire format). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte >> 4).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  return out;
}

/**
 * user.go:407-414 SetPassword — the pure record: new salt, hash under the
 * CONFIGURED algorithm, store the configured spec. The caller persists
 * passwd/salt/passwdHashAlgo (authenticate.go:64 updates exactly these
 * three columns on rehash).
 */
export async function newPasswordRecord(password: string): Promise<{
  passwd: string;
  salt: string;
  passwdHashAlgo: string;
}> {
  const salt = newSalt();
  const passwd = await hashPasswordWithAlgo(password, salt, CONFIGURED_HASH_SPEC);
  return { passwd, salt, passwdHashAlgo: CONFIGURED_HASH_SPEC };
}

/**
 * authenticate.go:60 — rehash-on-login condition: the stored algorithm
 * differs from the CONFIGURED SPECIFICATION (settings store the dealiased
 * spec, security.go:175) OR the salt is not the current 32-char length.
 */
export function needsRehash(storedAlgoSpec: string, salt: string): boolean {
  return storedAlgoSpec !== CONFIGURED_HASH_SPEC || salt.length !== SALT_BYTE_LENGTH * 2;
}

/** user.go:427-430 IsPasswordSet — an empty row never reaches a hash call. */
export function isPasswordSet(passwd: string): boolean {
  return passwd !== "";
}
