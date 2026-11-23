/**
 * A zero-dependency xz ENCODER (stored form) — census B-58's serve arm.
 * Upstream renders `Packages.xz` beside the .gz baseline at index-build time
 * (services/packages/debian/repository.go:184-187 rides Go's ulikunitz/xz
 * Writer; the file is STORED with the other indices and served on request —
 * the serve path never decodes). Workers has no xz compressor, and a real
 * LZMA2 match-finding encoder is out of proportion for an index artifact the
 * registry itself generates, so this module emits the format's own
 * uncompressed form:
 *
 *   LZMA2's in-band protocol carries UNCOMPRESSED chunks (control bytes
 *   0x01/0x02 + a 16-bit size header, ≤ 64 KiB of payload each) inside a
 *   standard xz block whose only filter is LZMA2 — a fully valid .xz stream
 *   that every decoder (xz --decompress, apt, ./xz.ts) expands byte-exactly,
 *   at a 1.0 ratio plus 3 bytes per 64 KiB chunk and the fixed container
 *   overhead (~100 bytes for small inputs).
 *
 * The bz2-encode posture applies (SPEC-0016's conda precedent): byte-identity
 * with xz(1) is NOT a goal — the format's own encoder freedom is exercised
 * (chunk split points, the declared size fields, the check id, the dict-size
 * property byte) — correctness is, and it is self-checking: the container
 * CRCs ride the same crc32 the decoder verifies, the stream declares the
 * CRC32 check id so the content itself is integrity-covered, and the battery
 * round-trips every arm through BOTH ./xz.ts and system xz fixtures (see
 * ./xz.test.ts; the system-xz goldens were generated with `xz --check=crc64`
 * at authoring time and validated with `xz -t`; the encoder's own output was
 * validated with `xz -t` / `xz -d` in the same scratch run).
 */

import { crc32 } from "./distro-common";

// ---------------------------------------------------------------------------
// Byte-frame helpers.
// ---------------------------------------------------------------------------

const STREAM_MAGIC = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const STREAM_FOOTER_MAGIC = new Uint8Array([0x59, 0x5a]); // "YZ"
const CHECK_CRC32_ID = 0x01;
/** LZMA2 filter id (the xz filter registry). */
const LZMA2_FILTER_ID = 0x21;
/** LZMA2 uncompressed-chunk control bytes (dict reset / no reset). */
const LZMA2_UNCOMPRESSED_RESET = 0x01;
const LZMA2_UNCOMPRESSED = 0x02;
const LZMA2_END_MARKER = 0x00;
/** Uncompressed-chunk payload cap: the 16-bit size field carries size-1. */
const LZMA2_CHUNK_PAYLOAD_MAX = 1 << 16;
/**
 * The filter's dictionary-size property byte, encoded per the LZMA2 spec
 * (byte v: dictSize = (2 | (v & 1)) << (floor(v/2) + 11); v=0 means 4 GiB).
 * 0x1A decodes to 32 MiB — well above any index payload, the zstd posture's
 * window scale. Irrelevant to decoding uncompressed chunks but validated by
 * decoders.
 */
const LZMA2_DICT_SIZE_BYTE = 0x1a;

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

/** The xz multibyte integer (little-endian 7-bit groups, all groups present). */
function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Encode `data` as a valid single-block xz stream with the CRC32 check:
 * stream header → block header (one LZMA2 filter, both size fields declared
 * — we know both, so declare them) → LZMA2 uncompressed chunks + end marker →
 * block padding → CRC32 → index → stream footer.
 */
export function xzEncodeStored(data: Uint8Array): Uint8Array {
  // ---- The LZMA2 payload: uncompressed chunks, then the end marker. ----
  const lzma2: Uint8Array[] = [];
  if (data.byteLength > 0) {
    let offset = 0;
    let first = true;
    do {
      const take = Math.min(LZMA2_CHUNK_PAYLOAD_MAX, data.byteLength - offset);
      const header = new Uint8Array(3);
      header[0] = first ? LZMA2_UNCOMPRESSED_RESET : LZMA2_UNCOMPRESSED;
      // The 16-bit size field is BIG-endian (size - 1) per the LZMA2 spec.
      header[1] = ((take - 1) >>> 8) & 0xff;
      header[2] = (take - 1) & 0xff;
      lzma2.push(header, data.subarray(offset, offset + take));
      offset += take;
      first = false;
    } while (offset < data.byteLength);
  }
  lzma2.push(Uint8Array.of(LZMA2_END_MARKER));
  const lzma2Bytes = concat(lzma2);

  // ---- Block header: size byte, flags, the declared sizes, filter, padding. ----
  // Flags: bit 0-1 = one filter; bit 6 = Compressed Size present; bit 7 =
  // Uncompressed Size present (the xz block_header_decoder.c layout).
  const filterProps = Uint8Array.of(LZMA2_FILTER_ID, 0x01, LZMA2_DICT_SIZE_BYTE);
  const sizes = concat([varint(lzma2Bytes.byteLength), varint(data.byteLength)]);
  const bodySoFar = 2 + sizes.byteLength + filterProps.byteLength; // size byte + flags + ...
  const blockHeaderRealSize = Math.ceil((bodySoFar + 4) / 4) * 4; // + the header CRC
  if (blockHeaderRealSize / 4 - 1 > 0xf3) throw new Error("xz block header above the size cap");
  const blockHeaderBody = concat([
    Uint8Array.of(blockHeaderRealSize / 4 - 1, 0xc0), // one filter + both size fields
    sizes,
    filterProps,
    new Uint8Array(blockHeaderRealSize - 4 - bodySoFar), // zero padding to the CRC
  ]);
  const blockHeader = concat([blockHeaderBody, u32le(crc32(blockHeaderBody))]);

  // ---- Block padding + check ----
  const blockPadding = (4 - (lzma2Bytes.byteLength % 4)) % 4;
  const check = u32le(crc32(data));
  // Unpadded Size = Block Header + Compressed Data + Check (the padding is
  // the only excluded part — the same formula the decoder verifies against
  // the xz spec's index record semantics).
  const unpaddedSize = blockHeaderRealSize + lzma2Bytes.byteLength + check.byteLength;

  // ---- Index: one record; the CRC32 covers indicator through padding ----
  const indexBody = concat([
    Uint8Array.of(0x00), // index indicator
    varint(1), // record count
    varint(unpaddedSize),
    varint(data.byteLength),
  ]);
  const indexPadding = (4 - (indexBody.byteLength % 4)) % 4;
  const indexNoCrc = concat([indexBody, new Uint8Array(indexPadding)]);
  const index = concat([indexNoCrc, u32le(crc32(indexNoCrc))]);

  // ---- Stream header / footer ----
  const streamFlags = Uint8Array.of(0x00, CHECK_CRC32_ID);
  const header = concat([STREAM_MAGIC, streamFlags, u32le(crc32(streamFlags))]);
  // Footer: CRC32 | Backward Size (4 bytes: index real size / 4 - 1) |
  // Stream Flags | "YZ". The CRC covers backward size + flags ONLY — the
  // magic bytes sit outside the check (fixture-verified against xz 5.4.5).
  const backwardSize = index.byteLength / 4 - 1;
  const footerBody = concat([u32le(backwardSize), streamFlags]);
  const footer = concat([u32le(crc32(footerBody)), footerBody, STREAM_FOOTER_MAGIC]);

  return concat([header, blockHeader, lzma2Bytes, new Uint8Array(blockPadding), check, index, footer]);
}
