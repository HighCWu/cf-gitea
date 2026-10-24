/**
 * LFS pointer file format — spec v1 (SPEC-0006 §2.4, port of upstream
 * `modules/lfs/pointer.go:20-112`).
 *
 * A pointer blob is < 1024 bytes, first line exactly
 * `version https://git-lfs.github.com/spec/v1`, then `oid sha256:<64 lowercase
 * hex>` and `size <n>` (non-negative). Canonical serialization has fixed
 * key/value order, so pointer bytes are reproducible — generate() and a
 * parsed-then-reserialized pointer are byte-identical.
 *
 * Three error classes mirror upstream's parser outcomes: too-large input,
 * not-a-pointer (wrong version line / missing keys / bad line shape), and an
 * invalid oid/size payload.
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
 * Parse a candidate blob. Non-pointer content is NOT an error at the call
 * sites that probe blobs (`media/`, enrichment): pass `strict: false` to get
 * `null` instead of NotAPointerError; InvalidPointerError (a *malformed*
 * pointer) always throws — upstream serves those as raw content, a decision
 * the caller owns.
 */
export function parsePointer(
  bytes: Uint8Array,
  { strict = true }: { strict?: boolean } = {},
): LfsPointer | null {
  if (bytes.byteLength > POINTER_MAX_BYTES) {
    throw new PointerTooLargeError(bytes.byteLength);
  }
  const text = new TextDecoder().decode(bytes);
  const lines = text.split("\n");
  if (lines[0] !== VERSION_LINE) {
    if (strict) throw new NotAPointerError("missing version line");
    return null;
  }
  let oid: string | null = null;
  let size: number | null = null;
  // Parser mirrors upstream: ≥3 lines, `key value` shape, unknown keys ignored
  // (forward compat), oid/size required exactly once.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "") continue;
    const sep = line.indexOf(" ");
    if (sep === -1) {
      if (strict) throw new NotAPointerError(`line ${i + 1} is not key/value`);
      return null;
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 1);
    if (key === "oid") {
      if (!value.startsWith("sha256:")) {
        throw new InvalidPointerError("oid algorithm must be sha256");
      }
      const hex = value.slice("sha256:".length);
      if (!OID_RE.test(hex)) {
        throw new InvalidPointerError(`oid is not 64 lowercase hex chars: ${hex}`);
      }
      oid = hex;
    } else if (key === SIZE_KEY) {
      if (!/^\d+$/.test(value)) {
        throw new InvalidPointerError(`size is not a non-negative integer: ${value}`);
      }
      size = Number(value);
    }
  }
  if (oid === null || size === null) {
    if (strict) throw new NotAPointerError("oid or size missing");
    return null;
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
