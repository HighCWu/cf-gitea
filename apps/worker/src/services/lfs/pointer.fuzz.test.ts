import { describe, expect, it } from "vitest";

import {
  generatePointer,
  InvalidPointerError,
  NotAPointerError,
  parsePointer,
  PointerTooLargeError,
} from "./pointer";

/**
 * Robustness fuzz for the LFS pointer parser (SPEC-0006 §2.4 / SPEC-0001 §7
 * spirit): arbitrary payloads must never escape with an unexpected exception —
 * every throw is one of the three typed error classes. Seeded PRNG (same
 * xmur3→mulberry32 family as the bench fixtures).
 */
function rng(seed: number): () => number {
  let h = seed + 0x9e3779b9;
  const mix = (): number => {
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0;
  };
  let a = mix();
  return () => {
    a >>>= 0; a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPED = [PointerTooLargeError, NotAPointerError, InvalidPointerError];

describe("fuzz: pointer parser throws only typed errors", () => {
  it("30k random payloads (both strict modes) stay within the error contract", () => {
    const rand = rng(1234);
    for (let i = 0; i < 30_000; i++) {
      const len = Math.floor(rand() * 1400);
      const bytes = new Uint8Array(len);
      // bias: sprinkle valid version-line bytes into some candidates
      const injectVersion = rand() < 0.3;
      for (let j = 0; j < len; j++) bytes[j] = Math.floor(rand() * 256);
      if (injectVersion && len > 45) {
        const line = new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\n");
        bytes.set(line.subarray(0, Math.min(line.length, len)), 0);
      }
      for (const strict of [true, false]) {
        try {
          parsePointer(bytes, { strict });
        } catch (e) {
          const typed = TYPED.some((cls) => e instanceof cls);
          if (!typed) {
            throw new Error(`unexpected throw on input #${i} strict=${strict}: ${String(e)}`, { cause: e });
          }
        }
      }
    }
    // The property under test is the error contract; real parses are covered
    // by the roundtrip case below (random tails rarely form valid oid/size).
  });

  it("random valid oids/sizes roundtrip byte-identically", () => {
    const rand = rng(555);
    for (let i = 0; i < 2_000; i++) {
      const oid = [...crypto.getRandomValues(new Uint8Array(32))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const size = Math.floor(rand() * 1e9);
      const bytes = generatePointer(oid, size);
      const back = parsePointer(bytes);
      expect(back).toEqual({ oid, size });
      expect(generatePointer(back!.oid, back!.size)).toEqual(bytes);
    }
  });
});
