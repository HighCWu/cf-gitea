/**
 * The zstd decoder battery — the fixtures are REAL system-zstd frames
 * (zstd 1.5.7, `zstd -<level>` at authoring time, embedded as base64
 * literals); the CONTENT side is regenerated in-test by the same
 * deterministic generators the fixture script used (xorshift PRNG,
 * byte cycles, a cycling lorem corpus), so every case asserts
 * decode(fixture) === known content byte-for-byte. The frames carry the
 * format's own XXH-64 content checksums (the CLI's default), so a decode
 * bug fails loudly on real bytes. Regeneration command (any host with
 * zstd): `zstd -<level> -f <content> -o out.zst` — the base64 below is
 * the verbatim output; the crafted rejection frames are hand-built
 * headers per the format doc (dictionary ID, windowLog 30, legacy magic).
 *
 * Coverage: empty/one-byte frames, raw-literal incompressible data,
 * RLE blocks at the 128 KB block cap, overlapping long matches (offset <
 * match length — the overlap-copy trap), 4-stream Huffman literals behind
 * the jump table, FSE-coded sequence tables, concatenated frames,
 * skippable-frame pass-through, the no-checksum arm, the windowLog 27
 * memory cap, and the rejection arms (dictionary, oversized window,
 * legacy/bad magic, truncation, corruption, empty input).
 */

import { describe, expect, it } from "vitest";

import { xxh64, ZstdError, zstdDecompress } from "./zstd";

// --- the embedded fixtures (base64 of zstd CLI output) -------------------

// zstd -3 of the empty content — header + empty raw last block + checksum.
const FIXTURE_EMPTY = "KLUv/SQAAQAAmenYUQ==";
// zstd -3 of the single byte 0x2e.
const FIXTURE_ONE = "KLUv/SQBCQAALgiAs+8=";
// zstd -3 of "hello zstd world".
const FIXTURE_TINY = "KLUv/SQQgQAAaGVsbG8genN0ZCB3b3JsZH+BaGA=";
// zstd -3 of the 16 KB lorem corpus (cycling words) — highly compressible.
const FIXTURE_TEXT16K_L3 = "KLUv/WR7P10DAGIIGBagNW3d3S0leVqx9v8SSyk7VVWN/c8atn6oVQ94loIVlGnxvhoblrEKY4zjs4e4tsybfP3j9vboyXrVJ1SkYEtlWKuLT9xBPKRZWYpwOf1IKyqMgJM0RiQTwALhjIF/NgEABvmf4I0UqWNaRg==";
// the SAME content at zstd -19 (deeper Huffman/FSE tables, different block shape).
const FIXTURE_TEXT16K_L19 = "KLUv/WR7P1UDAGLIFxKQzwFgiww22GCLDPr//+D6gxx/5AI6vrAzmrh1DTbjcyQfDJyBRYg0N33oQYPxrtznefo0O4aPHCNDt5r4gGAw0PGe1TH0pY3bC9TBIc/26JZEr42c0QbDkzjynU0HAQAG+Z/gjRSpY1pG";
// the no-checksum twin (--no-check): no Content_Checksum trailer.
const FIXTURE_TEXT16K_L3_NOCK = "KLUv/WB7P10DAGIIGBagNW3d3S0leVqx9v8SSyk7VVWN/c8atn6oVQ94loIVlGnxvhoblrEKY4zjs4e4tsybfP3j9vboyXrVJ1SkYEtlWKuLT9xBPKRZWYpwOf1IKyqMgJM0RiQTwALhjIF/NgEABvmf4I0U";
// zstd -3 of 4096 seeded-PRNG bytes — incompressible, raw literals.
const FIXTURE_RAND4K_L3 = "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";
// zstd -3 of 'a' × 300 KB — RLE blocks at the 128 KB block maximum, and
// the first block's overlap match (offset 1, length 131070).
const FIXTURE_AAA300K_L3 = "KLUv/aQAsAQAVAAAEGFhAQD7/znAAgIAEGEDgAVhbZGwZA==";
// zstd -19 of cycle(150 KB, 256) — FSE-coded sequence tables, long matches.
const FIXTURE_CYCLE150K_L19 = "KLUv/aQAWAIAXAgABBBBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AAQAA/f4D+ZoCVQAAAAEA/dcAgD0CAd3OAdE=";
// the SAME content compressed with --long=27 — the window-log cap frame.
const FIXTURE_CYCLE150K_LONG27_L19 = "KLUv/aQAWAIAXAgABBBBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AAQAA/f4D+ZoCVQAAAAEA/dcAgD0CAd3OAdE=";
// zstd -19 of cycle(100 KB, 3) — EVERY match overlaps (offset 3 < length):
// the byte-by-byte overlap-copy arm.
const FIXTURE_OVERLAP100K_L19 = "KLUv/aQAkAEAXQAAGGFiYwEA+o/mbgiMqd+e";
// zstd -3 of 128 KB zero bytes — exactly one full-capacity RLE block.
const FIXTURE_ZEROS128K_L3 = "KLUv/aQAAAIAVQAAEAAAAQD7/znAAnNQlXo=";
// zstd -3 of 130 KB zero bytes — a full RLE block + a remainder block.
const FIXTURE_ZEROS130K_L3 = "KLUv/aQACAIAVAAAEAAAAQD7/znAAgNAAABk8W5f";
// zstd -3 of (8 KB seeded PRNG ‖ the same 8 KB again) — real-entropy
// literals through the 4-stream Huffman path + a self-referential match
// spanning the literal/match boundary.
const FIXTURE_MIX16K_L3 = "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";
// three frames joined (text16k L3 ‖ rand4k L3 ‖ aaa300k L3) — the
// concatenated-frames walk with per-frame entropy/offset resets.
const FIXTURE_CONCAT3 = "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";
// a crafted skippable frame (magic 0x184D2A50, 5-byte payload) then a
// real frame — the pass-through arm.
const FIXTURE_SKIPPABLE_THEN_TINY = "UCpNGAUAAAABAgMEBSi1L/0kEIEAAGhlbGxvIHpzdGQgd29ybGR/gWhg";
// the tiny frame again — corrupted/truncated at test time.
const FIXTURE_TINY_FOR_CORRUPT = "KLUv/SQQgQAAaGVsbG8genN0ZCB3b3JsZH+BaGA=";
// zstd -3 of "a" — its trailer IS the low 32 bits of XXH-64("a") (the
// xxh64 implementation's ground truth from the reference tool).
const FIXTURE_ONE_CHECKSUM_FRAME = "KLUv/SQBCQAAYVtujKk=";

// crafted rejection frames (format-doc headers, hand-built):
// singleSegment + FCS + Dictionary_ID_flag set (0x2A) — dictionaries REJECTED.
const FIXTURE_R_DICT = "KLUv/SEqBCAAAGFiY2Q=";
// window descriptor with exponent 20 → windowLog 30 — above the 27 cap.
const FIXTURE_R_WINDOW30 = "KLUv/QCgIAAAYWJjZA==";
// legacy magic 0xFD2FB527 (below the zstd range) — legacy frames REJECTED.
const FIXTURE_R_LEGACY = "J7Uv/QEAAA==";
// garbage magic.
const FIXTURE_R_BADMAGIC = "/////wA=";

// --- the deterministic content generators (shared with the authoring
// script that produced the fixtures) ---------------------------------------

function bytesFromBase64(base64: string): Uint8Array {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function prngBytes(seed: number, count: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17; // logical shift — the authoring generator's unsigned form
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function cycleBytes(count: number, mod: number, base = 65): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (base + (i % mod)) & 0xff;
  return out;
}

const LOREM_WORDS =
  "the quick brown fox jumps over a lazy dog while zstandard compresses repetitive text data with huffman and fse entropy coding stages ".split(" ");

function loremBytes(total: number): Uint8Array {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < total) {
    const word = LOREM_WORDS[i % LOREM_WORDS.length] as string;
    i++;
    parts.push(word);
    n += word.length + 1;
  }
  return new TextEncoder().encode(parts.join(" ").slice(0, total));
}

function expectContent(actual: Uint8Array, expected: Uint8Array, label: string): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  let diffAt = -1;
  for (let i = 0; i < expected.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      diffAt = i;
      break;
    }
  }
  if (diffAt >= 0) {
    throw new Error(`${label}: byte ${diffAt} differs (got ${actual[diffAt]}, want ${expected[diffAt]})`);
  }
}

// --- the decode battery -----------------------------------------------------

describe("zstdDecompress — real zstd frames", () => {
  it("the empty frame decodes to zero bytes", () => {
    expect(zstdDecompress(bytesFromBase64(FIXTURE_EMPTY)).byteLength).toBe(0);
  });

  it("a one-byte frame decodes exactly", () => {
    expect(Array.from(zstdDecompress(bytesFromBase64(FIXTURE_ONE)))).toEqual([0x2e]);
  });

  it("a tiny text frame decodes exactly", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_TINY));
    expect(new TextDecoder().decode(out)).toBe("hello zstd world");
  });

  it("the 16 KB lorem corpus at level 3 (its checksum is the integrity gate)", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_TEXT16K_L3));
    expectContent(out, loremBytes(16 * 1024 + 123), "text16k L3");
  });

  it("the same corpus at level 19 (deeper Huffman/FSE table shapes)", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_TEXT16K_L19));
    expectContent(out, loremBytes(16 * 1024 + 123), "text16k L19");
  });

  it("a no-checksum frame decodes (the Content_Checksum trailer absent)", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_TEXT16K_L3_NOCK));
    expectContent(out, loremBytes(16 * 1024 + 123), "text16k no-checksum");
  });

  it("incompressible PRNG bytes ride raw literals", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_RAND4K_L3));
    expectContent(out, prngBytes(0x9e3779b9, 4096), "rand4k");
  });

  it("300 KB of 'a' — RLE blocks and the offset-1 overlap match", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_AAA300K_L3));
    expectContent(out, cycleBytes(300 * 1024, 1, 97), "aaa300k");
  });

  it("cycle(150 KB, 256) at level 19 — FSE sequence tables + long matches", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_CYCLE150K_L19));
    expectContent(out, cycleBytes(150 * 1024, 256), "cycle150k L19");
  });

  it("the --long=27 frame (windowLog at the decoder's memory cap) decodes", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_CYCLE150K_LONG27_L19));
    expectContent(out, cycleBytes(150 * 1024, 256), "cycle150k long27");
  });

  it("cycle(100 KB, 3) — every match overlaps its own output (offset < length)", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_OVERLAP100K_L19));
    expectContent(out, cycleBytes(100 * 1024, 3, 97), "overlap100k");
  });

  it("128 KB of zeros — exactly one full-capacity RLE block", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_ZEROS128K_L3));
    expectContent(out, new Uint8Array(128 * 1024), "zeros128k");
  });

  it("130 KB of zeros — a full RLE block plus a remainder block", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_ZEROS130K_L3));
    expectContent(out, new Uint8Array(130 * 1024), "zeros130k");
  });

  it("mixed entropy + self-referential copy — 4-stream literals and the jump table", () => {
    const first = prngBytes(0xdeadbeef, 8192);
    const expected = new Uint8Array(16384);
    expected.set(first, 0);
    expected.set(first, 8192);
    const out = zstdDecompress(bytesFromBase64(FIXTURE_MIX16K_L3));
    expectContent(out, expected, "mix16k");
  });

  it("three concatenated frames decode in sequence (per-frame state resets)", () => {
    const joined = bytesFromBase64(FIXTURE_CONCAT3);
    const expected = new Uint8Array(
      loremBytes(16 * 1024 + 123).byteLength + 4096 + 300 * 1024,
    );
    expected.set(loremBytes(16 * 1024 + 123), 0);
    expected.set(prngBytes(0x9e3779b9, 4096), 16 * 1024 + 123);
    expected.set(cycleBytes(300 * 1024, 1, 97), 16 * 1024 + 123 + 4096);
    const out = zstdDecompress(joined);
    expectContent(out, expected, "concat3");
  });

  it("a skippable frame passes through and the following frame decodes", () => {
    const out = zstdDecompress(bytesFromBase64(FIXTURE_SKIPPABLE_THEN_TINY));
    expect(new TextDecoder().decode(out)).toBe("hello zstd world");
  });
});

// --- the rejection battery ---------------------------------------------------

describe("zstdDecompress — malformed streams rejected", () => {
  it("empty input is rejected (no frame at all)", () => {
    expect(() => zstdDecompress(new Uint8Array(0))).toThrow(ZstdError);
  });

  it("a garbage magic number is rejected", () => {
    expect(() => zstdDecompress(bytesFromBase64(FIXTURE_R_BADMAGIC))).toThrow(ZstdError);
  });

  it("a legacy-frame magic is rejected", () => {
    expect(() => zstdDecompress(bytesFromBase64(FIXTURE_R_LEGACY))).toThrow(/magic/);
  });

  it("a dictionary frame (Dictionary_ID set) is rejected", () => {
    expect(() => zstdDecompress(bytesFromBase64(FIXTURE_R_DICT))).toThrow(/dictionary/);
  });

  it("a windowLog above 27 is rejected (the memory gate)", () => {
    expect(() => zstdDecompress(bytesFromBase64(FIXTURE_R_WINDOW30))).toThrow(/too much memory/);
  });

  it("a truncated frame is rejected", () => {
    const whole = bytesFromBase64(FIXTURE_TINY_FOR_CORRUPT);
    expect(() => zstdDecompress(whole.slice(0, whole.byteLength - 6))).toThrow(ZstdError);
  });

  it("a flipped content byte fails the frame checksum", () => {
    const copy = bytesFromBase64(FIXTURE_TINY_FOR_CORRUPT);
    copy[10] = (copy[10] ?? 0) ^ 0xff;
    expect(() => zstdDecompress(copy)).toThrow(/checksum/);
  });
});

// --- the XXH-64 implementation -----------------------------------------------

describe("xxh64 — the frame checksum primitive", () => {
  it("matches the published one-shot vectors", () => {
    const show = (bytes: Uint8Array): string => {
      const [hi, lo] = xxh64(bytes);
      return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
    };
    expect(show(new Uint8Array(0))).toBe("ef46db3751d8e999");
    expect(show(new TextEncoder().encode("a"))).toBe("d24ec4f1a98c6e5b");
    expect(show(new TextEncoder().encode("abc"))).toBe("44bc2cf5ad770999");
    expect(show(new TextEncoder().encode("message digest"))).toBe("066ed728fceeb3be");
  });

  it("reproduces the checksum the reference tool stored for 'a'", () => {
    const frame = bytesFromBase64(FIXTURE_ONE_CHECKSUM_FRAME);
    const stored =
      ((frame[frame.byteLength - 4] as number) |
        ((frame[frame.byteLength - 3] as number) << 8) |
        ((frame[frame.byteLength - 2] as number) << 16) |
        ((frame[frame.byteLength - 1] as number) << 24)) >>>
      0;
    const digest = xxh64(new TextEncoder().encode("a"));
    expect(digest[1] >>> 0).toBe(0xa98c6e5b);
    expect(stored).toBe(0xa98c6e5b);
  });
});
