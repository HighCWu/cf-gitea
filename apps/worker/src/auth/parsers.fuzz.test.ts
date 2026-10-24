import { describe, expect, it } from "vitest";

import {
  basicAuthTokenCandidate,
  parseAuthorizationHeader,
} from "./httpauth";
import { isCfGiteaTokenShape, tokenLookupPrefix } from "./token-format";

/**
 * Robustness fuzz for the untrusted-input parsers (SPEC-0001 §7 spirit,
 * applied early to the landed non-engine surfaces). Seeded PRNG — no
 * fast-check dep; deterministic per the repo's fixture conventions. The
 * property under test: parsing arbitrary input NEVER throws an unexpected
 * exception — outcomes are typed values or the module's own error classes
 * (here: none of the auth parsers throw at all).
 */

/** xmur3→mulberry32, same seeding family as scripts/gen-bench-fixtures.mjs. */
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

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -_=.:/+!\u00e9\u4e2d\ud83d\ude00";
const seedString = (rand: () => number, maxLen: number): string => {
  const len = Math.floor(rand() * maxLen);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
};

/** Pure-random strings almost never carry a valid scheme word — bias part of
 *  the corpus with real prefixes so the parse-hit sanity check can hold. */
const SCHEMES = ["Basic ", "basic ", "token ", "TOKEN ", "Bearer ", "bEaReR "];
const fuzzHeader = (rand: () => number): string => {
  const body = seedString(rand, 120);
  if (rand() < 0.25) return SCHEMES[Math.floor(rand() * SCHEMES.length)] + body;
  return body;
};

describe("fuzz: Authorization header parsing never throws", () => {
  it("50k seeded random header values produce typed outcomes only", () => {
    const rand = rng(42);
    let bears = 0;
    let basics = 0;
    for (let i = 0; i < 50_000; i++) {
      const value = fuzzHeader(rand);
      let parsed: unknown;
      try {
        parsed = parseAuthorizationHeader(value);
      } catch (e) {
        throw new Error(`parseAuthorizationHeader threw on input #${i}: ${String(e)}`, { cause: e });
      }
      if (parsed === null) continue;
      // Real shape: { basicAuth | null, bearerToken | null } (httpauth.ts)
      if ((parsed as { basicAuth: unknown }).basicAuth !== null) basics++;
      if ((parsed as { bearerToken: unknown }).bearerToken !== null) bears++;
      // candidate extraction consumes a parsed Basic header; total-function check
      basicAuthTokenCandidate(parsed as never);
    }
    expect(bears + basics).toBeGreaterThan(0);
  });

  it("malformed base64 in Basic never throws", () => {
    const rand = rng(7);
    for (let i = 0; i < 10_000; i++) {
      const header = { scheme: "basic", token: seedString(rand, 80), user: "", password: "" };
      expect(() => basicAuthTokenCandidate(header as never)).not.toThrow();
    }  });
});

describe("fuzz: token shape helpers are total functions", () => {
  it("arbitrary strings: lookup prefix is null or 12 chars; shape check never throws", () => {
    const rand = rng(99);
    for (let i = 0; i < 50_000; i++) {
      const value = seedString(rand, 60);
      const prefix = tokenLookupPrefix(value);
      // Contract: null (below the ≥8 gate) or slice(0,12) — which is SHORTER
      // than 12 for inputs of 8-11 chars (valid behavior: prefix lookups of
      // short values simply never match a cfg_/40-hex prefix).
      expect(prefix === null || prefix.length <= 12).toBe(true);
      expect(typeof isCfGiteaTokenShape(value)).toBe("boolean");
    }
  });
});
