/**
 * The TOTP core — RFC 6238 over HMAC-SHA1 (SPEC glossary: "the TOTP core")
 * plus the scratch-code crypto, both ported byte-exact from the upstream pin
 * and its dependency:
 *
 *   - the passcode math is pquerna/otp v1.5.0 (gitea/go.mod:72) verbatim:
 *     `totp.Validate` runs ValidateOpts{Period: 30s, Skew: 1, Digits: 6,
 *     Algorithm: SHA1} probing counters [T, T+1, T-1] in that order
 *     (totp.go ValidateCustom), each through hotp.GenerateCodeCustom's
 *     RFC-4226 dynamic truncation and `% 10^digits` reduction with
 *     zero-padding (hotp.go). The base32 secret decoding carries the
 *     library's documented leniency (hotp.go issue #10/#17/#24): TrimSpace,
 *     pad with `=` to a multiple of 8, uppercase.
 *   - the scratch token is `TwoFactor.GenerateScratchToken`
 *     (models/auth/twofactor.go:68-76): 6 crypto-random bytes, base32 over
 *     the ambiguity-free alphabet "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" (no
 *     padding — 10 chars), with a `CryptoRandomString(10)` salt (the 62-char
 *     alphabet, modules/util/util.go:74-77) and `HashToken`'s EXACT hash
 *     (twofactor.go:79-82): PBKDF2-SHA256(token, salt, 10000 iterations,
 *     50 bytes) as hex.
 *
 * Zero dependencies — `crypto.subtle` only (the AGENTS.md Workers crypto
 * rule). Pure functions; the D1 seam lives in ./two-factor. The verify
 * here never mutates state; every login surface must go through
 * two-factor.ts's ValidateAndConsumeTOTP port so a passcode cannot be
 * redeemed twice (upstream's own rule, twofactor.go:108-110).
 */

// ---------------------------------------------------------------------------
// base32 (RFC 4648 std alphabet, the pquerna leniency)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** base32 encode, NO padding (upstream's `b32NoPadding.EncodeToString`,
 *  totp/totp.go Generate). */
export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32 encode over a CUSTOM 32-char alphabet, no padding — the scratch
 *  token's `base32.NewEncoding(base32Chars).WithPadding(NoPadding)
 *  .EncodeToString` (twofactor.go:72). The alphabet must be exactly 32
 *  unique chars (the caller's constant satisfies it; a bad alphabet is a
 *  programming error and throws). */
export function base32EncodeCustom(bytes: Uint8Array, alphabet: string): string {
  if (alphabet.length !== 32 || new Set(alphabet).size !== 32) {
    throw new Error("base32EncodeCustom: the alphabet must hold exactly 32 unique chars");
  }
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Decode a base32 secret the way pquerna/otp does before HMAC (hotp.go
 * GenerateCodeCustom): TrimSpace, pad with `=` to a multiple of 8,
 * uppercase. Bytes are decoded strictly over the std alphabet; a character
 * outside it throws (upstream maps the error to
 * ErrValidateSecretInvalidBase32 — the caller's ServerError arm).
 * Padding-bit correctness is NOT enforced (Go's decoder rejects non-zero
 * trailing bits; every real authenticator produces zeroed bits, so the
 * lenient read never fires on honest input).
 */
export function base32DecodeSecret(secret: string): Uint8Array {
  const cleaned = secret.trim().toUpperCase();
  const padded = cleaned + "=".repeat((8 - (cleaned.length % 8)) % 8);
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of padded) {
    if (ch === "=") break;
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// HMAC + the passcode math (pquerna/otp hotp.go + totp.go verbatim)
// ---------------------------------------------------------------------------

/** The RFC 6238 default step (pquerna ValidateOpts.Period). */
export const TOTP_PERIOD_SECONDS = 30;

/** The upstream-facing window: `totp.Validate`'s Skew 1 — the code from the
 *  previous and the next 30 s step both verify (the mission's "±1 window"). */
export const TOTP_DEFAULT_SKEW = 1;

/** pquerna's digit set — the six-digit default and the RFC 6238 vector
 *  length (the fixed vectors are 8-digit; the test asserts them byte-exact
 *  through this union). */
export type TotpDigits = 6 | 8;

async function hmacSha1(secretBytes: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, message);
  return new Uint8Array(mac);
}

/**
 * HOTP at `counter` — hotp.GenerateCodeCustom's default-encoder arm:
 * HMAC-SHA1 over the 8-byte big-endian counter, RFC 4226 §5.4 dynamic
 * truncation, `% 10^digits`, zero-padded to `digits` (Digits.Format).
 */
export async function hotpCode(secret: string, counter: number, digits: TotpDigits = 6): Promise<string> {
  const secretBytes = base32DecodeSecret(secret);
  const buf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff; // counter is a step count — well inside Number's safe integers
    counter = Math.floor(counter / 256);
  }
  const sum = await hmacSha1(secretBytes, buf);
  const offset = (sum[sum.length - 1] ?? 0) & 0x0f;
  const value =
    (((sum[offset] ?? 0) & 0x7f) << 24) |
    ((sum[offset + 1] ?? 0) & 0xff) << 16 |
    ((sum[offset + 2] ?? 0) & 0xff) << 8 |
    ((sum[offset + 3] ?? 0) & 0xff);
  const mod = value % 10 ** digits;
  return String(mod).padStart(digits, "0");
}

/** `Math.Floor(float64(t.Unix()) / float64(Period))` (totp.go
 *  GenerateCodeCustom) — the time-step counter. */
export function totpPeriodAt(unixSeconds: number, period: number = TOTP_PERIOD_SECONDS): number {
  return Math.floor(unixSeconds / period);
}

/** The TOTP passcode at a unix timestamp (GenerateCode's math). */
export async function totpCode(
  secret: string,
  unixSeconds: number,
  options?: { digits?: TotpDigits; period?: number },
): Promise<string> {
  return hotpCode(secret, totpPeriodAt(unixSeconds, options?.period), options?.digits ?? 6);
}

/** Constant-time string equality on the formatted passcodes (upstream's
 *  `subtle.ConstantTimeCompare`, hotp.go ValidateCustom) — equal length is
 *  pre-checked by the caller (the length leak is upstream's too). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/**
 * One counter's check — hotp.ValidateCustom: TrimSpace the passcode, the
 * length must equal the digit count (`ErrValidateInputInvalidLength`
 * otherwise), then the constant-time compare against the computed code.
 */
export async function verifyHotp(
  passcode: string,
  secret: string,
  counter: number,
  digits: TotpDigits = 6,
): Promise<boolean> {
  const trimmed = passcode.trim();
  if (trimmed.length !== digits) return false;
  return constantTimeEqual(trimmed, await hotpCode(secret, counter, digits));
}

/**
 * The ±1-window TOTP verify — totp.ValidateCustom's probe ORDER preserved
 * (current counter first, then +1, then -1), with the matched step's period
 * returned instead of pquerna's bare boolean: the two_factor store's replay
 * guard is PERIOD-based (the landed `last_used_passcode_period` column —
 * the schema's strengthening of upstream's last-passcode-string compare,
 * RFC 6238 §5.2's monotonic recommendation), and consuming needs to know
 * WHICH step matched. `null` = no window code matches.
 */
export async function verifyTotpPeriod(
  passcode: string,
  secret: string,
  unixSeconds: number,
  options?: { digits?: TotpDigits; period?: number; skew?: number },
): Promise<number | null> {
  const period = options?.period ?? TOTP_PERIOD_SECONDS;
  const digits = options?.digits ?? 6;
  const skew = options?.skew ?? TOTP_DEFAULT_SKEW;
  const current = totpPeriodAt(unixSeconds, period);
  const counters = [current];
  for (let i = 1; i <= skew; i++) {
    counters.push(current + i);
    counters.push(current - i);
  }
  for (const counter of counters) {
    if (await verifyHotp(passcode, secret, counter, digits)) return counter;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scratch code (models/auth/twofactor.go:68-91 — the exact port)
// ---------------------------------------------------------------------------

/** `base32Chars` verbatim — "specially chosen, avoid ambiguous chars like
 *  `0`, `O`, `1`, `I`" (twofactor.go:70-71). */
export const SCRATCH_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The CryptoRandomString alphabet (modules/util/util.go:74-77) — the
 *  scratch salt's charset. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * `GenerateScratchToken` (twofactor.go:68-76): 6 crypto-random bytes →
 * custom-alphabet base32, no padding — 10 chars.
 */
export function generateScratchToken(): string {
  return base32EncodeCustom(crypto.getRandomValues(new Uint8Array(6)), SCRATCH_ALPHABET);
}

/** `util.CryptoRandomString(10)` — the salt (twofactor.go:73). Rejection
 *  sampling over whole bytes keeps the 62-char alphabet uniform (256 % 62
 *  != 0) — the session.ts cryptoRandomId recipe. */
export function generateScratchSalt(): string {
  let out = "";
  while (out.length < 10) {
    const buf = crypto.getRandomValues(new Uint8Array((10 - out.length) * 2));
    for (const byte of buf) {
      if (byte >= 248) continue; // 248 = 4 × 62: uniform remapped range
      out += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (out.length === 10) break;
    }
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte >> 4).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(hex[i * 2] ?? "", 16);
    const lo = parseInt(hex[i * 2 + 1] ?? "", 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * `HashToken` (twofactor.go:79-82) — the EXACT hash the mission pins:
 * PBKDF2-SHA256(password = token, salt, 10000 iterations, 50 bytes), hex.
 */
export async function hashScratchToken(token: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 10000 },
    key,
    400,
  );
  return bytesToHex(new Uint8Array(bits));
}

/**
 * `VerifyScratchToken` (twofactor.go:85-91): empty tokens fail outright;
 * otherwise re-hash with the stored salt and compare against the stored
 * hex in constant time (`subtle.ConstantTimeCompare`). The scratch
 * verification never mutates the row — the caller burns the code by
 * regenerating it (upstream's own split: verify here, invalidate at the
 * call site).
 */
export async function verifyScratchTokenHash(storedHashHex: string, token: string, salt: string): Promise<boolean> {
  if (token.length === 0) return false;
  const stored = hexToBytes(storedHashHex);
  const candidate = hexToBytes(await hashScratchToken(token, salt));
  if (stored === null || candidate === null || stored.length !== candidate.length) return false;
  return crypto.subtle.timingSafeEqual(stored, candidate);
}
