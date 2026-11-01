/**
 * A minimal CBOR (RFC 8949) decoder — the slice the WebAuthn ceremonies
 * need: `attestationObject` ({fmt, attStmt, authData}), authenticator data's
 * embedded COSE key, and (when the extension-data flag is set) the
 * authenticator extensions map.
 *
 * Zero-dependency by design (the mission's constraint): the workerd Web
 * platform has no CBOR, and pulling a library in for ~120 lines of
 * well-specified decoding is exactly the dependency-budget trade the repo's
 * dependency rules weigh against. Supported: major types 0/1 (unsigned /
 * negative integers), 2 (byte strings), 3 (text strings), 4 (arrays),
 * 5 (maps), 6 (tags — the tag is dropped, the tagged value kept), 7
 * (false/true/null/undefined + 16/32/64-bit floats). Definite lengths only —
 * authenticators emit definite-length encodings (the WebAuthn conformance
 * targets never use indefinite ones) and a fail-closed decoder is the safer
 * default for an auth surface.
 *
 * Decode errors throw CborError — the ceremony ladder catches and maps to
 * the upstream failure arms (500 at registration, 403 at assertion).
 */

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

/** A decoded CBOR data item. Integers are JS numbers (safe up to 2^53 —
 *  every WebAuthn use is far below: COSE algs, map keys, counters). */
export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<CborValue, CborValue>;

const MAX_DEPTH = 16;

interface DecodeResult {
  value: CborValue;
  offset: number;
}

function readHead(bytes: Uint8Array, offset: number): { major: number; info: number; value: number; offset: number } {
  if (offset >= bytes.length) throw new CborError("truncated: no initial byte");
  const initial = bytes[offset]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = offset + 1;
  let value: number;
  if (info < 24) {
    value = info;
  } else if (info === 24) {
    value = readUint(bytes, cursor, 1);
    cursor += 1;
  } else if (info === 25) {
    value = readUint(bytes, cursor, 2);
    cursor += 2;
  } else if (info === 26) {
    value = readUint(bytes, cursor, 4);
    cursor += 4;
  } else if (info === 27) {
    // Full 64-bit width: WebAuthn payloads never carry values above 2^53
    // (algs, lengths, counters); reject the astronomically large instead of
    // silently truncating.
    const hi = readUint(bytes, cursor, 4);
    const lo = readUint(bytes, cursor + 4, 4);
    value = hi * 0x100000000 + lo;
    if (!Number.isSafeInteger(value)) throw new CborError("integer exceeds 2^53");
    cursor += 8;
  } else {
    throw new CborError(`unsupported additional info ${info} (indefinite lengths not accepted)`);
  }
  return { major, info, value, offset: cursor };
}

function readUint(bytes: Uint8Array, offset: number, width: number): number {
  if (offset + width > bytes.length) throw new CborError("truncated integer");
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 256 + bytes[offset + i]!;
  return value;
}

function decodeItem(bytes: Uint8Array, offset: number, depth: number): DecodeResult {
  if (depth > MAX_DEPTH) throw new CborError("nesting depth exceeded");
  const head = readHead(bytes, offset);
  const { major, info, value } = head;
  let cursor = head.offset;
  switch (major) {
    case 0:
      return { value, offset: cursor };
    case 1:
      // Negative integer: -1 - n.
      return { value: -1 - value, offset: cursor };
    case 2:
    case 3: {
      if (cursor + value > bytes.length) throw new CborError("truncated string");
      const slice = bytes.slice(cursor, cursor + value);
      cursor += value;
      return major === 2
        ? { value: slice, offset: cursor }
        : { value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(slice), offset: cursor };
    }
    case 4: {
      if (cursor + value > bytes.length) throw new CborError("truncated array head");
      const items: CborValue[] = [];
      for (let i = 0; i < value; i++) {
        const item = decodeItem(bytes, cursor, depth + 1);
        items.push(item.value);
        cursor = item.offset;
      }
      return { value: items, offset: cursor };
    }
    case 5: {
      if (cursor + value > bytes.length) throw new CborError("truncated map head");
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < value; i++) {
        const key = decodeItem(bytes, cursor, depth + 1);
        const val = decodeItem(bytes, key.offset, depth + 1);
        map.set(key.value, val.value);
        cursor = val.offset;
      }
      return { value: map, offset: cursor };
    }
    case 6: {
      // Tag: drop the tag number, keep the tagged value.
      const tagged = decodeItem(bytes, cursor, depth + 1);
      return { value: tagged.value, offset: tagged.offset };
    }
    case 7: {
      if (info === 20) return { value: false, offset: cursor };
      if (info === 21) return { value: true, offset: cursor };
      if (info === 22) return { value: null, offset: cursor };
      if (info === 23) return { value: undefined, offset: cursor };
      if (info === 25) {
        // Half-precision float (rare; decoded for completeness).
        const half = readUint(bytes, cursor, 2);
        cursor += 2;
        const exp = (half >> 10) & 0x1f;
        const mant = half & 0x3ff;
        let result: number;
        if (exp === 0) result = mant * 2 ** -24;
        else if (exp !== 31) result = (mant + 1024) * 2 ** (exp - 25);
        else result = mant === 0 ? Infinity : NaN;
        return { value: half & 0x8000 ? -result : result, offset: cursor };
      }
      if (info === 26) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4);
        cursor += 4;
        return { value: view.getFloat32(0), offset: cursor };
      }
      if (info === 27) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8);
        cursor += 8;
        return { value: view.getFloat64(0), offset: cursor };
      }
      throw new CborError(`unsupported simple value ${info}`);
    }
    default:
      throw new CborError(`unreachable major type ${major}`);
  }
}

/**
 * Decode exactly one CBOR item from the front of `bytes`. Use
 * {@link decodeCbor} for whole-buffer payloads; the item form is for
 * walking authenticator data, where the COSE key sits mid-buffer and the
 * end offset matters.
 */
export function decodeCborItem(bytes: Uint8Array, offset = 0): { value: CborValue; offset: number } {
  return decodeItem(bytes, offset, 0);
}

/** Decode a whole buffer as ONE CBOR item; trailing bytes are an error (a
 *  truncated or junk-padded attestationObject is a malformed payload). */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const result = decodeCborItem(bytes, 0);
  if (result.offset !== bytes.length) throw new CborError("trailing bytes after CBOR item");
  return result.value;
}
