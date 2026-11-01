/**
 * The bzip2 ENCODER battery (SPEC-0016 §7 conda row, wall 3's reopen
 * trigger) — every arm asserts the encoder's output round-trips through
 * the LANDED decoder (./bz2, the Go compress/bzip2 port, which verifies
 * every block CRC and the combined stream CRC on the way), and the
 * committed goldens pin the encoder's own byte output against regressions.
 * The goldens were cross-checked with SYSTEM bzip2 at authoring time: the
 * authoring harness compressed each arm's content with this module and
 * ran `bzip2 -d -c` (bzip2 1.0.8) over the bytes — every arm reproduced
 * its content byte-for-byte, plus a 200-case mixed-shape differential
 * fuzz (runs + random + cycles, levels 1-9) through BOTH decoders. The
 * regeneration command (any host with the repo checkout and bzip2):
 * compile ./bz2-encode.ts standalone, feed it the generator output below,
 * `bzip2 -d -c <out.bz2>` — the content must come back verbatim; the
 * base64 goldens must reproduce verbatim too (they also guard the
 * decoder side: the empty and aaaaa goldens are byte-IDENTICAL to the
 * system bzip2 fixtures embedded in bz2.test.ts).
 *
 * Encoder freedom is exercised on purpose: block split points, the
 * table count and its per-50-symbol assignment are this module's own
 * choices (byte-identity with bzip2(1) is NOT a goal — correctness is).
 */

import { describe, expect, it } from "vitest";

import { bzip2Decompress } from "./bz2";
import { bzip2Compress } from "./bz2-encode";

// --- the committed goldens (base64 of THIS encoder's output, produced by
// the authoring harness above) ----------------------------------------------

// The empty stream — byte-identical to system `bzip2 -9` (header + footer
// + zero CRC), 14B.
const ENCODED_EMPTY = "QlpoORdyRThQkAAAAAA=";
// "aaaaa" — the block ends on an RLE count byte; byte-identical to system
// bzip2's output, 39B.
const ENCODED_AAAAA = "QlpoOTFBWSZTWUSkMD0AAAJBACAAIAAgACEAggsXckU4UJBEpDA9";
// "z".repeat(5000) — a single-symbol alphabet (zero MTF diversity → the
// global-frequency table fallback), 46B.
const ENCODED_ONE_SYMBOL_5K = "QlpoOTFBWSZTWd3ucT0AAAmAoIAQAIAACCAAIRNBE0lCgBOLuSKcKEhu9ziegA==";
// The run-heavy corpus (300 runs of 200-692 bytes + separators, 133677B) —
// RUNA/RUNB heavy, 525B.
const ENCODED_RUN_HEAVY =
  "QlpoOTFBWSZTWVYdIhgAAWh/r4gAAAgQAAAQIAAAIH////iAgQECBAAABAgAAAhAAcEMOFIAAYjATAgGhSAGQxBggGmmCGADCYgABgAFIAxDEAAMAFgABCAIQyAAIABCbHLPQQymtOhLGufAYAgBFZCEIRhCEIR5CEIMbRjGMbhjGMcBjGUIAAIQiCEIQkCEIQkSEIEAAEIQiCEIQiiEIQiiECAACEIQiCEIQiiEIQiiBAAAxjGNAxjGNQxjGNRAgAAYxjGgYxjGoYxjGogQAAMYxmQYxjGWYxjGWsxjGMkxjGMsxjGMZajGMZRylKtZSlKUqilKUpylKVRSlKUqilKUqSlKVBSlKUqilKUqilKVRCEIRRCEIRRCEIohCEIohCEIohCEUfQhCKQcpSlUkpSqWAIAbBAEIQBAAMJc9sbYz1uEhCEIThjGMb4jGMY4jEIQhFEIQhREIQhCKIQhCCEJhCEUQhCMIQhCEIohCEYQhCEIRRCEIwghCEJQhCEwghCEJQhCEwghCEJBCEIRjCEIQiiEIQhGEIQhBCEJSDGYYxjEIQghCYIQjCEIQhCYIQmCEIQhCYIQmCAAAAMAADBAAAAGCEITAAAADAAARjDGMYzDGMYzDGMYxCEYYzDGMZhjGcIAAIQhyEIQ5CDGMZxjGM4xCEI4hCEcZQBCEAAABIXckU4UJBWHSIYA";
// 1024 seeded-PRNG bytes — incompressible (mostly literal symbols across a
// wide alphabet → six Huffman tables), 1220B.
const ENCODED_RANDOM_1K =
  "QlpoOTFBWSZTWTcNMEMAAFL//9/////////v////////+///////////v/7/f///v///wAKgQMDhAAAAGgAAAAAAAAAAAAAAADQAAAAAAaNAAAaAAAAAAAAAABAAAAAAAAAAAAAAAAADQAAAAAAAAAAGgAAAAADQAAA0GgABAAAAAAAAAAAAAAAAAAGgAAABoABoAAAAA0AAAAAAAAAAaBAAAAAAAAAANAAAAAAAAAAAAAAAAAAAAAAABoAA0ABoAADT6QgBpBh06rzoN/oHCxDsUnRSrAubGEoa3zLzibEIu16Ntme/LKdLckwyH30xI2HdwG+pjK+5oAcfQKfBIpuuxv3iBkA8nCMDPgAMOVCRmA255K6gH4M6ci/lkIBN5PvoS4biK0z2m6TyKRKVj5R4T4/ZVZqFyyfy9bjiG0AR8mPHwjTrjakA39g1X05iNE5XKXt8gTVJK7N2vlynsNgDp7CkPcG2UxOTpU4nNrwLuyT5DESOr8ExglRROCrOL5KbOmNX2SVVUrM69HNTatgqBBJEp6Dj/8F0rhmHXxzQ+E2ySImALH8Dt+gChpd4qiESaRHgClRhAlZu4b8Miwpa8wRNpJLpQHyaVwVI9i54lfn2Yv25DFEJg1wJZzsb9r16cyIMlXBHs+tpWmWwAYu/JrKXySVy3sDfouFGhjPEcPCo/ciIkrTTA7QR5elXHynB0NgwIHTBERlp248Ja37Kp0t/ANjeE4xa4wOGzOndecKRwZkw0c+UzW9tnYgqQMLZTGbQipzspjgf3+lOtIQxDtkeCpspIwDCqXTiECGpMcg5dZh/VX5HdOChin6twAKs4QoJk2D1W6JAEdIk3G9ssQHQh5lBWRDcHGskT26gJXYFCSsrkQXfh4VmpuYB0/jD7bEUFKYriihPAH46Y+pcNTam+FpVZtdDo6na+C1tGSEeo63g2GoSB7klOUfrlaEWvPyEvdM654n4oiMPMj7o9kP1HBWIVFStV+tHaLABvdXlQ1BaYOfuUQs9CaiRyAkc2sjnSgyctskhtf0YaOiUC1pA+9mMeGy/pI+rUsMTDQGZv/UbgRYJFdoNXU4kC7BJEKll+Co3lycYHNroWDhLehbEwFtb4scQSThH2DF4jYbyZVv8Ng/IRNEuoNrT4obK9u9MwRC5rsGMtNMd1A6BdGcRrjnvH4n6hFcBzsRfeKJ/X92Wn92gOlPeqzRou5sqyWGFgI8hFP79+BqeuL3IKTwUAYOnp4zhcjb/HdifA7Lx2q1zMopmdSwgMr8bxDBPfYwFZAnUl7zxslQUYUVi35aPGxJbrRgVDAD7TRB3frGac2QmQEr5e2c+7CoA32qkonRBfqve+GduX2wBypVPEJfX3TfqvOJkImn3J+3fnK508W76LDvh2Ujl5Fi0C857bwgiqlQLjgkM7DhtCBlJSeVxT8x044VUOQrQUyBvKH8KFuMRLi5AQzF+pgfcMYldw067qUFrmI+29ujpj9ILg07ofploFSe+Cf0KDajW+UtIPHmB/SPbF2aw2rnOUoJh5XQhG6ODqAL8Na4/pHuux05PcWwO99Nh4dU8pYgFCoBKodobhw4NrwCdmICvkoRcAHVjhiar/i7kinChIG4aYIY=";
// cycle(900000, 23) — the EXACT level-9 block capacity in one block, 237B.
const ENCODED_CYCLE_900K =
  "QlpoOTFBWSZTWYB2iHAATG0GAD///4AwAQIwhAYQANCEAAwQCEAABgYBARARAAEQBXiICICIAAiAQEQEQEQABEAiIgIgIgACIBIRARARAAEQCYiAiAiAAIgBCICICIAAiAGIgIgIgACIAgiAiAiAAIgCiICICIAAiAWAQEQEQABEAwAgIgIgACIBkBARARAAEQDQCAiAiAAIgBAICICIAAiAGAgIgIgACIAgCAiAiAAIgCgICICIAAiAMAgIgIgACIAQCAiAiAAIgBgICICIAAiAIAgIgIgACIAoCAiAiAAIgDC7kinChIQDtEOA";

// --- the deterministic content generators (shared verbatim with the
// authoring harness and with bz2.test.ts's decoder-side generators) ------

function bytesFromBase64(base64: string): Uint8Array {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function cycleBytes(count: number, mod: number, base = 65): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = base + (i % mod);
  return out;
}

function prngBytes(seed: number, count: number): Uint8Array {
  let s = seed >>> 0;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function runHeavyBytes(): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 300; i++) {
    parts.push(new Uint8Array(200 + (i % 17) * 31).fill(97)); // "a" * run
    parts.push(new Uint8Array([98 + (i % 26)])); // the separator byte
  }
  const total = parts.reduce((acc, part) => acc + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A repodata-SHAPED body: many small JSON package records over a bounded
 *  alphabet — the conda wall's actual service load (deterministic). */
function repodataJson(packages: number): Uint8Array {
  const entries: string[] = [];
  for (let i = 0; i < packages; i++) {
    const name = `pkg-${String(i % 97).padStart(2, "0")}-${i}`;
    const hex = (seed: number, length: number): string =>
      [...prngBytes(seed, length)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    entries.push(
      `    "${name}-1.${i % 40}.0-py3_0.tar.bz2": {"name":"pkg-${i % 97}","version":"1.${i % 40}.0","noarch":"","subdir":"linux-64","timestamp":1700000000,"build":"py3_${i % 7}","build_number":${i % 7},"depends":["python >=3.10,<3.11.0a0","numpy 1.26.*"],"license":"BSD-3-Clause","license_family":"BSD","md5":"${hex(i + 1, 8)}","sha256":"${hex(i + 1000, 16)}","size":${200000 + i * 37}}`,
    );
  }
  return new TextEncoder().encode(
    `{"info":{"subdir":"linux-64"},"packages":{\n${entries.join(",\n")}\n},"packages.conda":{},"removed":{}}\n`,
  );
}

function expectRoundTrip(payload: Uint8Array, level?: number): Uint8Array {
  const encoded = bzip2Compress(payload, level === undefined ? undefined : { level });
  const decoded = bzip2Decompress(encoded);
  expect(decoded.byteLength).toBe(payload.byteLength);
  expect(Array.from(decoded)).toEqual(Array.from(payload));
  return encoded;
}

describe("bzip2Compress — round-trip through the landed decoder", () => {
  it("the empty stream encodes to the system-identical 14-byte header+footer", () => {
    const encoded = expectRoundTrip(new Uint8Array(0));
    // Byte-identical to system `bzip2 -9` on empty input (no encoder
    // freedom is exercised with zero blocks).
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_EMPTY)));
  });

  it("tiny bodies: one byte, and aaaa...a ending on the RLE count byte", () => {
    expectRoundTrip(Uint8Array.of(97));
    const encoded = expectRoundTrip(Uint8Array.of(97, 97, 97, 97, 97));
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_AAAAA)));
  });

  it("a single-symbol alphabet (the zero-MTF-diversity corner)", () => {
    const encoded = expectRoundTrip(new Uint8Array(5000).fill(122));
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_ONE_SYMBOL_5K)));
  });

  it("the full 256-byte alphabet", () => {
    const payload = new Uint8Array(2560);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
    expectRoundTrip(payload);
  });

  it("the run-heavy corpus (RUNA/RUNB heavy, multi-hundred-byte runs)", () => {
    const encoded = expectRoundTrip(runHeavyBytes());
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_RUN_HEAVY)));
  });

  it("incompressible PRNG payloads (1k golden + a 100k single block)", () => {
    const encoded = expectRoundTrip(prngBytes(42, 1024));
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_RANDOM_1K)));
    expectRoundTrip(prngBytes(7, 100000));
  });

  it("the level-9 block cap boundary: exactly 900000, and one over", () => {
    const encoded = expectRoundTrip(cycleBytes(900000, 23));
    expect(Array.from(encoded)).toEqual(Array.from(bytesFromBase64(ENCODED_CYCLE_900K)));
    // One byte over the RLE1 capacity → the block splits at the pair
    // boundary and the combined CRC chains two blocks.
    expectRoundTrip(cycleBytes(900001, 23));
  });

  it("multi-block at level 1: 1.1M across eleven 100k blocks", () => {
    expectRoundTrip(cycleBytes(1100000, 23), 1);
  });

  it("the RLE1 block cut lands BETWEEN run pairs (exact fill, then one over)", () => {
    // 20000 × (255×'a') → RLE1 = exactly 100000 bytes: one completely full
    // level-1 block.
    const exact = new Uint8Array(20000 * 255).fill(97);
    expectRoundTrip(exact, 1);
    // +1 byte → the second block carries a single pair.
    const over = new Uint8Array(20000 * 255 + 1).fill(97);
    over[20000 * 255] = 98;
    expectRoundTrip(over, 1);
  });

  it("the repodata-shaped JSON body (the conda wall's service load)", () => {
    expectRoundTrip(repodataJson(300));
  });

  it("every level 1..9 round-trips the same payload", () => {
    for (let level = 1; level <= 9; level++) {
      expectRoundTrip(repodataJson(30), level);
    }
  });

  it("the encoder is deterministic (same bytes on a second pass)", () => {
    const payload = repodataJson(50);
    expect(Array.from(bzip2Compress(payload))).toEqual(Array.from(bzip2Compress(payload)));
  });

  it("rejects out-of-range levels", () => {
    const payload = Uint8Array.of(97, 98, 99);
    expect(() => bzip2Compress(payload, { level: 0 })).toThrow(/level/);
    expect(() => bzip2Compress(payload, { level: 10 })).toThrow(/level/);
    expect(() => bzip2Compress(payload, { level: 4.5 })).toThrow(/level/);
  });
});

describe("bzip2Compress — committed goldens decode back through the landed decoder", () => {
  const cases: Array<[string, string, Uint8Array]> = [
    ["empty", ENCODED_EMPTY, new Uint8Array(0)],
    ["aaaaa", ENCODED_AAAAA, Uint8Array.of(97, 97, 97, 97, 97)],
    ["one-symbol-5k", ENCODED_ONE_SYMBOL_5K, new Uint8Array(5000).fill(122)],
    ["run-heavy", ENCODED_RUN_HEAVY, runHeavyBytes()],
    ["random-1k", ENCODED_RANDOM_1K, prngBytes(42, 1024)],
    ["cycle-900k", ENCODED_CYCLE_900K, cycleBytes(900000, 23)],
  ];
  for (const [name, golden, payload] of cases) {
    it(`${name}: bzip2Compress reproduces the golden and the golden decodes to the content`, () => {
      expect(Array.from(bytesFromBase64(golden))).toEqual(Array.from(bzip2Compress(payload)));
      expect(Array.from(bzip2Decompress(bytesFromBase64(golden)))).toEqual(Array.from(payload));
    });
  }
});
