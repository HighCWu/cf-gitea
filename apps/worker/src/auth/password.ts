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
 * spec). Census B-87's consumption half made the configured algorithm
 * ENV-DRIVEN: the SetPassword/needsRehash arms accept the caller's resolved
 * specification (`configuredPasswordHashAlgo(env).specification` in
 * api/config.ts), with the landed pbkdf2 default standing when a caller
 * passes none — upstream's boot-time log.Fatal on an unexecutable spec
 * (security.go:176-178) becomes the controlled parse error at the arm
 * (Workers has no boot hook).
 *
 * Census B-86 lands the argon2id + bcrypt VERIFY arms (the PWD-3 benchmark's
 * static-wasm shape — password-wasm.ts over the vendored hash-wasm binaries,
 * Go-fixture-pinned): stored "argon2$<time>$<memory>$<threads>$<keyLen>"
 * rows (argon2.go:38-42, hex(argon2.IDKey(...)), the ID variant) and stored
 * "bcrypt$<cost>" rows (bcrypt.go:30-32's SPECIALIZED verifier — the passwd
 * column is the full "$2a$<cost>$<22><31>" crypt string and the salt column
 * is UNUSED on that arm, hash.go:66) now verify, so rehash-on-login
 * (authenticate.go:60, needsRehash answers true for both) migrates them to
 * the configured algorithm exactly as upstream does.
 *
 * Stored algorithms outside the pbkdf2/argon2/bcrypt families (scrypt/
 * unknown) remain unverifiable: parsing raises the controlled
 * PasswordHashUnsupportedError (SPEC §6.3-3, ADR-0008 rule 4) — callers
 * translate it into upstream's generic auth failure on the wire while the
 * server log carries the cause; NEVER a silent mismatch. The same controlled
 * arm answers pbkdf2 specs ABOVE the production iteration cap (B-85 — PW4's
 * rule-4 class, the accepted-but-unexecutable parse; see the constant below)
 * and argon2 memory specs ABOVE the isolate ceiling (B-86's sibling guard).
 */

import { timingSafeDigestEqual } from "./digest";
import { argon2idBytes, bcryptVerifyCrypt, ensurePasswordWasm } from "./password-wasm";

/**
 * The DEFAULT PASSWORD_HASH_ALGO config name (setting.go:13). The DEFAULT
 * arm of the env-driven posture (census B-87's consumption half): the arms
 * below accept the caller's env-resolved configured specification, and when
 * no caller resolves one (tests, pre-threading call sites) this landed
 * pbkdf2 default stands. Upstream resolves the var ONCE at boot
 * (security.go:175); Workers resolves per request, so callers bridge env →
 * `configuredPasswordHashAlgo(env).specification` (api/config.ts) → these
 * arms — this module cannot import the reader (the reader parses THROUGH
 * this module's chain).
 */
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
 * The PRODUCTION Workers argon2 memory ceiling (B-86's B-85 sibling): the
 * standard isolate memory ceiling is 128 MiB (the benchmark's
 * MEMORY_CEILING_MIB), and argon2.wasm allocates memorySize * 1024 + 1024
 * bytes of linear memory per derivation — a stored spec above the ceiling
 * cannot execute here (a mid-verify allocation trap), while specs at or
 * below it parse and run (the benchmark graded the upstream-default
 * 64 MiB ≈ 91 ms well inside the ceiling). Like the pbkdf2 cap above, the
 * guard lives at PARSE time so local workerd and production fail CLOSED
 * with the same controlled error instead of an environment-dependent
 * verify outcome.
 */
export const PRODUCTION_ARGON2_MEMORY_CEILING_BYTES = 128 * 1024 * 1024;

/**
 * The dealiased DEFAULT configured specification stored in `passwd_hash_algo`
 * on every SetPassword that did not receive an env-resolved spec
 * (setting.go:26,30 + security.go:175). The DEFAULT arm of the env-driven
 * posture (see CONFIGURED_HASH_ALGO): a caller threads
 * `configuredPasswordHashAlgo(env).specification` to make the configured
 * algorithm live; unset, this landed pbkdf2$50000$50 default stands.
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

/**
 * A parsed algorithm specification (the usable subset of hash.Parse), one
 * variant per registered hasher family. `specification` is the stored value
 * verbatim (never dealiased).
 */
export type ParsedHashSpec =
  | { hasher: "pbkdf2"; iter: number; keyLen: number; specification: string }
  | { hasher: "argon2"; time: number; memoryKiB: number; threads: number; keyLen: number; specification: string }
  | { hasher: "bcrypt"; cost: number; specification: string };

/**
 * hash.go:134-189 Parse for the landed factory set (pbkdf2 + argon2 +
 * bcrypt — scrypt stays controlled-unsupported, platform-impossible).
 * "" and "pbkdf2" are the legacy bare arm (iter 10000/keyLen 50, DO NOT
 * COALESCE with the configured default); "pbkdf2$<iter>$<keyLen>" carries
 * explicit parameters (pbkdf2.go:38-67). "argon2"/"argon2$<t>$<m>$<p>$<l>"
 * (argon2.go:47-66, bare = the MUST-NOT-CHANGE pre-config defaults) and
 * "bcrypt"/"bcrypt$<cost>" (bcrypt.go:26-48, Atoi cost, default 10) parse
 * for VERIFY. Anything else — scrypt, alias names like "pbkdf2_hi",
 * malformed configs — raises the controlled PasswordHashUnsupportedError.
 */
export function parseStoredHashAlgo(algorithmSpec: string): ParsedHashSpec {
  let spec = algorithmSpec;
  if (spec === "") {
    spec = LEGACY_BARE_SPECIFICATION;
  }

  const dollar = spec.indexOf("$");
  const hasherType = dollar === -1 ? spec : spec.slice(0, dollar);
  const config = dollar === -1 ? "" : spec.slice(dollar + 1);

  if (hasherType === "pbkdf2") {
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

  if (hasherType === "argon2") {
    // argon2.go:22-31 — the bare stored name ("argon2") AND the trailing-$
    // form ("argon2$" — hash.go's SplitN(algorithmSpec, "$", 2) yields an
    // empty config either way, and NewArgon2Hasher("") returns the defaults)
    // take the pre-config defaults; "THESE VALUES MUST NOT BE CHANGED OR
    // BACKWARDS COMPATIBILITY WILL BREAK".
    if (config === "") {
      return { hasher: hasherType, time: 2, memoryKiB: 65_536, threads: 8, keyLen: 50, specification: spec };
    }

    // argon2.go:49-66 — SplitN(config, "$", 4), exactly four uint params:
    // <time uint32>$<memory uint32>$<threads uint8>$<keyLen uint32>.
    const parts = config.split("$");
    if (parts.length !== 4) {
      throw new PasswordHashUnsupportedError(spec, `invalid argon2 hash spec "${config}"`);
    }
    const time = parseUintParam(spec, parts[0]!, "time", 32);
    const memoryKiB = parseUintParam(spec, parts[1]!, "memory", 32);
    const threads = parseUintParam(spec, parts[2]!, "threads", 8);
    const keyLen = parseUintParam(spec, parts[3]!, "keyLen", 32);
    if (time < 1 || threads < 1 || memoryKiB < 8 * threads) {
      // Upstream PARSES these (ParseUint accepts 0 and small memory) but
      // PANICS inside argon2.IDKey (x/crypto deriveKey: t<1, p<1, m<8p) —
      // a corrupted row 500s there. The controlled error is this repo's
      // corrupted-spec arm (SPEC §6.3-3, the pbkdf2 iter<1 precedent).
      throw new PasswordHashUnsupportedError(
        spec,
        `argon2 params out of range: time=${time} memory=${memoryKiB} threads=${threads} (argon2 requires time ≥ 1, threads ≥ 1, memory ≥ 8*threads)`,
      );
    }
    if (memoryKiB * 1024 + 1024 > PRODUCTION_ARGON2_MEMORY_CEILING_BYTES) {
      // B-85's sibling (PW4's rule-4 class): the 128 MiB isolate ceiling
      // bounds argon2.wasm's linear-memory allocation — an above-ceiling
      // spec would verify in local tests and trap MID-VERIFY in production.
      // Parse-time controlled refusal fails CLOSED identically in both.
      throw new PasswordHashUnsupportedError(
        spec,
        `argon2 memory ${memoryKiB} KiB exceeds the production Workers isolate ceiling ${PRODUCTION_ARGON2_MEMORY_CEILING_BYTES} bytes (docs/research/hash-bench-phase-b.md §5)`,
      );
    }
    return { hasher: hasherType, time, memoryKiB, threads, keyLen, specification: spec };
  }

  if (hasherType === "bcrypt") {
    // bcrypt.go:26-48 — config "" is the pre-config default cost 10 ("MUST
    // NOT BE CHANGED"); otherwise strconv.Atoi (SIGNED — "+10" parses). The
    // cost is recorded only: verification uses the cost embedded in the
    // stored crypt string (bcrypt.go:30-32), never this value, so upstream's
    // no-range-check here needs none of ours.
    const cost = config === "" ? 10 : parseIntParam(spec, config, "cost");
    return { hasher: "bcrypt", cost, specification: spec };
  }

  throw new PasswordHashUnsupportedError(spec, `unknown hasher type "${hasherType}"`);
}

/**
 * common.go:22-32 parseUintParam — strconv.ParseUint semantics: digits only
 * (no sign), no overflow past the declared bit width.
 */
function parseUintParam(specification: string, value: string, param: string, bits: number): number {
  if (!/^\d+$/.test(value)) {
    throw new PasswordHashUnsupportedError(specification, `invalid integer for ${param} representation in argon2 hash spec`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2 ** bits - 1) {
    throw new PasswordHashUnsupportedError(specification, `integer out of range for ${param} (uint${bits}) in argon2 hash spec`);
  }
  return parsed;
}

/**
 * common.go:13-20 parseIntParam — strconv.Atoi semantics (optional sign).
 * Go's Atoi additionally fails with ErrRange past the 64-bit int maximum;
 * JS numbers lose integer precision past 2^53 long before that, so any
 * non-safe-integer value raises the same controlled error here (the
 * conservatively smaller window is parse-only: a real stored cost/iter is
 * orders of magnitude below it).
 */
function parseIntParam(specification: string, value: string, param: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new PasswordHashUnsupportedError(specification, `invalid integer for ${param} representation`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PasswordHashUnsupportedError(specification, `integer out of range for ${param} representation`);
  }
  return parsed;
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
 *
 * pbkdf2-only BY DESIGN: SetPassword hashes under the CONFIGURED algorithm,
 * which Phase A hardwired to pbkdf2$50000$50 (the config knob is B-87). The
 * argon2/bcrypt arms landed with B-86 are VERIFY-ONLY (upstream rows exist
 * from instances configured with those algorithms; ours never CREATES them),
 * so a non-pbkdf2 spec here is a caller bug — refused with the controlled
 * error, never a wrong-family digest silently computed.
 */
export async function hashPasswordWithAlgo(
  password: string,
  salt: string,
  storedAlgoSpec: string,
): Promise<string> {
  const parsed = parseStoredHashAlgo(storedAlgoSpec);
  if (parsed.hasher !== "pbkdf2") {
    throw new PasswordHashUnsupportedError(
      parsed.specification,
      `hashing under "${parsed.hasher}" is not implemented (the B-86 arms are verify-only)`,
    );
  }
  const saltBytes = decodeSaltBytes(salt);
  return pbkdf2Sha256Hex(password, saltBytes, parsed.iter, parsed.keyLen);
}

/**
 * hash.go:63-79 VerifyPassword: recompute the provided password's hash under
 * the STORED algorithm specification and compare constant-time — with one
 * specialized arm upstream also takes (hash.go:66's PasswordVerifier
 * override): bcrypt.go:30-32 verifies the crypt STRING directly (its own
 * cost + salt are embedded in the stored passwd value; the salt column is
 * unused there).
 *
 * A salt decode or compute error logs and returns false (hash.go:71-75 —
 * never a throw on the verify path). An UNSUPPORTED stored algorithm throws
 * the controlled PasswordHashUnsupportedError — callers translate it to the
 * generic auth failure and log the cause (SPEC §6.3-3); returning false here
 * would be the silent mismatch ADR-0008 forbids.
 */
export async function verifyPassword(
  providedPassword: string,
  hashedPassword: string,
  salt: string,
  storedAlgoSpec: string,
): Promise<boolean> {
  const parsed = parseStoredHashAlgo(storedAlgoSpec);
  try {
    // bcrypt arm (bcrypt.go:30-32): the crypt string carries everything; the
    // salt column is NOT decoded (decoding it could throw for a row whose
    // salt predates the column's current shape — upstream never touches it).
    if (parsed.hasher === "bcrypt") {
      return bcryptVerifyCrypt(new TextEncoder().encode(providedPassword), hashedPassword);
    }
    const saltBytes = decodeSaltBytes(salt);
    let providedHash: string;
    if (parsed.hasher === "argon2") {
      // The whole wasm pipeline is synchronous (password-wasm.ts's
      // concurrency invariant) — no yield between the memory writes and the
      // final read.
      ensurePasswordWasm();
      providedHash = bytesToHex(argon2idBytes(new TextEncoder().encode(providedPassword), saltBytes, parsed));
    } else {
      providedHash = await pbkdf2Sha256Hex(providedPassword, saltBytes, parsed.iter, parsed.keyLen);
    }
    return timingSafeDigestEqual(hashedPassword, providedHash);
  } catch (error) {
    if (error instanceof PasswordHashUnsupportedError) throw error;
    console.error(`passwordhash: ${parsed.specification}.Hash(): ${String(error)}`);
    return false;
  }
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
 *
 * `configuredSpec` is the ENV-DRIVEN arm (census B-87's consumption half):
 * callers with a request env thread
 * `configuredPasswordHashAlgo(env).specification` (api/config.ts — the
 * alias chain's dealiased form, security.go:175); omitted, the landed
 * pbkdf2$50000$50 default stands. An UNEXECUTABLE configured spec refuses
 * through the controlled parse inside hashPasswordWithAlgo (scrypt/
 * above-cap/unparseable → PasswordHashUnsupportedError — the recorded
 * Workers posture for upstream's boot log.Fatal, security.go:176-178), and
 * a non-pbkdf2 executable spec (argon2/bcrypt) refuses through
 * hashPasswordWithAlgo's verify-only guard — both explicit, never a
 * silent fallback to the default algorithm.
 */
export async function newPasswordRecord(
  password: string,
  configuredSpec: string = CONFIGURED_HASH_SPEC,
): Promise<{
  passwd: string;
  salt: string;
  passwdHashAlgo: string;
}> {
  const salt = newSalt();
  const passwd = await hashPasswordWithAlgo(password, salt, configuredSpec);
  return { passwd, salt, passwdHashAlgo: configuredSpec };
}

/**
 * authenticate.go:60 — rehash-on-login condition: the stored algorithm
 * differs from the CONFIGURED SPECIFICATION (settings store the dealiased
 * spec, security.go:175) OR the salt is not the current 32-char length.
 * `configuredSpec` is the env-driven arm (see newPasswordRecord): callers
 * thread the env-resolved specification so an operator's PASSWORD_HASH_ALGO
 * becomes the comparison target; omitted, the landed default stands.
 */
export function needsRehash(
  storedAlgoSpec: string,
  salt: string,
  configuredSpec: string = CONFIGURED_HASH_SPEC,
): boolean {
  return storedAlgoSpec !== configuredSpec || salt.length !== SALT_BYTE_LENGTH * 2;
}

/** user.go:427-430 IsPasswordSet — an empty row never reaches a hash call. */
export function isPasswordSet(passwd: string): boolean {
  return passwd !== "";
}
