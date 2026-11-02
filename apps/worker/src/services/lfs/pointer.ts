/**
 * LFS pointer file format — spec v1 (SPEC-0006 §2.4, port of upstream
 * `modules/lfs/pointer.go:20-112`).
 *
 * A pointer blob is < 1024 bytes, starts with
 * `version https://git-lfs.github.com/spec/v1`, then carries `oid sha256:<64
 * lowercase hex>` and `size <n>`. Canonical serialization has fixed key/value
 * order, so pointer bytes are reproducible — generate() and a
 * parsed-then-reserialized pointer are byte-identical.
 *
 * The parser is the POSITIONAL port of upstream `ReadPointerFromBuffer`
 * (pointer.go:53-80): the buffer must start with the version identifier
 * (HasPrefix over the whole content — trailing characters on the version line
 * are tolerated), split to ≥3 newline-separated segments, then exactly two
 * positional reads — lines[1] is the oid line, lines[2] the size line.
 * Decoding is Go's `string(buf)` byte-verbatim: a leading UTF-8 BOM STAYS in
 * the text (TextDecoder ignoreBOM:true) and fails the prefix check — a BOM'd
 * pointer is not a pointer, upstream's ErrMissingPrefix arm
 * (pointer.go:58-61). Anything past lines[2] is never read: extra/blank/
 * duplicate/out-of-order keys are invisible, upstream's exact leniency
 * envelope. `size` parses with Go strconv.ParseInt(…, 10, 64) semantics
 * (optional sign, ASCII digits, int64 range), so `size +5` is valid — the
 * ledger L4 correction (2026-11-02): the earlier scan-all-lines parser
 * accepted out-of-order shapes upstream rejects and rejected `+5` upstream
 * accepts. The BOM polarity is the v1.5.5 R4-3 correction: the earlier
 * default decoder stripped the BOM and accepted a BOM'd pointer upstream
 * serves raw.
 *
 * Three error classes mirror upstream's parser outcomes: too-large input,
 * not-a-pointer (prefix miss / invalid structure), and an invalid oid/size
 * payload (ErrInvalidOIDFormat and the ParseInt arms).
 */

export const POINTER_MAX_BYTES = 1024;
const VERSION_LINE = "version https://git-lfs.github.com/spec/v1";
const OID_PREFIX = "oid sha256:";
const SIZE_KEY = "size";
const OID_RE = /^[0-9a-f]{64}$/;

export class PointerTooLargeError extends Error {
  constructor(bytes: number) {
    super(`LFS pointer candidate is ${bytes} bytes (max ${POINTER_MAX_BYTES})`);
    this.name = "PointerTooLargeError";
  }
}

export class NotAPointerError extends Error {
  constructor(reason: string) {
    super(`not a git-lfs pointer: ${reason}`);
    this.name = "NotAPointerError";
  }
}

export class InvalidPointerError extends Error {
  constructor(reason: string) {
    super(`invalid LFS pointer: ${reason}`);
    this.name = "InvalidPointerError";
  }
}

export interface LfsPointer {
  /** 64 lowercase hex chars — the sha256 of the LFS object. */
  oid: string;
  /** Object size in bytes (≥ 0). */
  size: number;
}

/** Canonical bytes for a pointer — fixed key order, LF-terminated lines. */
export function generatePointer(oid: string, size: number): Uint8Array {
  if (!OID_RE.test(oid)) {
    throw new InvalidPointerError(`oid must be 64 lowercase hex chars: ${oid}`);
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new InvalidPointerError(`size must be a non-negative integer: ${size}`);
  }
  return encode(`${VERSION_LINE}\n${OID_PREFIX}${oid}\n${SIZE_KEY} ${size}\n`);
}

/**
 * Parse a candidate blob — the positional port of upstream
 * `ReadPointerFromBuffer` (pointer.go:53-80). Non-pointer content is NOT an
 * error at the call sites that probe blobs (`media/`, enrichment): pass
 * `strict: false` to get `null` instead of NotAPointerError;
 * InvalidPointerError (a *malformed* pointer) always throws — upstream serves
 * those as raw content, a decision the caller owns.
 */
export function parsePointer(
  bytes: Uint8Array,
  { strict = true }: { strict?: boolean } = {},
): LfsPointer | null {
  if (bytes.byteLength > POINTER_MAX_BYTES) {
    throw new PointerTooLargeError(bytes.byteLength);
  }
  // Go's `string(buf)` is the bytes verbatim — a leading UTF-8 BOM stays in
  // the text and HasPrefix fails (ErrMissingPrefix, pointer.go:58-61), so a
  // BOM'd pointer is NOT a pointer upstream. The TextDecoder default strips
  // the BOM (ignoreBOM:false omits EF BB BF from the output), which would
  // accept a BOM'd pointer where upstream serves it raw; ignoreBOM:true is
  // the WHATWG "do not strip" polarity and keeps the BOM in `text`.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  // Upstream checks HasPrefix over the WHOLE buffer, not exact line equality —
  // trailing characters on the version line pass (pointer.go:57-59).
  if (!text.startsWith(VERSION_LINE)) {
    if (strict) throw new NotAPointerError("content lacks the LFS prefix");
    return null;
  }
  const lines = text.split("\n");
  if (lines.length < 3) {
    if (strict) throw new NotAPointerError("invalid structure");
    return null;
  }

  // Positional read 1 — the oid line (pointer.go:67-70). Go's TrimPrefix is a
  // no-op when the prefix is absent, so a BARE 64-hex line is accepted, exactly
  // like upstream; anything else fails isValidOid (ErrInvalidOIDFormat).
  const oidLine = lines[1] as string;
  const oid = oidLine.startsWith(OID_PREFIX) ? oidLine.slice(OID_PREFIX.length) : oidLine;
  if (!OID_RE.test(oid)) {
    throw new InvalidPointerError(`oid is not 64 lowercase hex chars: ${oid}`);
  }

  // Positional read 2 — the size line (pointer.go:71-74): the `size ` prefix
  // strips when present, then Go strconv.ParseInt(s, 10, 64) — optional sign
  // (so `size +5` parses to 5), ASCII digits only at base 10, int64 range.
  const sizeLine = lines[2] as string;
  const rawSize = sizeLine.startsWith(`${SIZE_KEY} `) ? sizeLine.slice(SIZE_KEY.length + 1) : sizeLine;
  if (!/^[+-]?[0-9]+$/.test(rawSize)) {
    throw new InvalidPointerError(`size is not an integer: ${JSON.stringify(rawSize)}`);
  }
  const value = BigInt(rawSize);
  if (value > 9223372036854775807n || value < -9223372036854775808n) {
    throw new InvalidPointerError(`size is out of int64 range: ${rawSize}`);
  }
  const size = Number(value); // lossy only past 2^53 — absurd sizes, exact int64 accept-range preserved
  // Upstream parses a negative size fine and rejects it later at IsValid()
  // (pointer.go:98-106); parsePointer's contract is "returns usable pointers",
  // so the IsValid arm is this throw (InvalidPointerError — the same outcome
  // upstream callers observe).
  if (size < 0) {
    throw new InvalidPointerError(`size is negative: ${rawSize}`);
  }
  return { oid, size };
}

/**
 * Git blob sha1 of the canonical pointer text — the reachability key for the
 * LFS GC (SPEC-0006 §3.4): `sha1("blob <len>\0" + canonicalBytes)`.
 */
export async function pointerBlobSha1(pointer: LfsPointer): Promise<string> {
  const canonical = generatePointer(pointer.oid, pointer.size);
  const header = encode(`blob ${canonical.byteLength}\0`);
  const digest = await crypto.subtle.digest("SHA-1", concat(header, canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}
