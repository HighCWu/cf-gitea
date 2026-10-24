/**
 * Token format + digest tests — SPEC-0002 §3 (format decision) and §5
 * (generator format regex, alphabet restriction, prefix extraction,
 * known-vector sha256, timing-safe compare behavior).
 */

import { describe, expect, it } from "vitest";

import { sha256Hex, timingSafeDigestEqual } from "./digest";
import {
  generateToken,
  isCfGiteaTokenShape,
  tokenFromRandomBytes,
  tokenLookupPrefix,
  TOKEN_VALUE_LENGTH,
} from "./token-format";

describe("generateToken", () => {
  it("mints the exact cfg_<8hex>_<32base32> shape", () => {
    const { value, prefix } = generateToken();
    expect(value).toMatch(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/);
    expect(value.length).toBe(TOKEN_VALUE_LENGTH);
    expect(prefix).toBe(value.slice(0, 12));
    expect(prefix).toMatch(/^cfg_[0-9a-f]{8}$/);
  });

  it("generates distinct tokens (runtime randomness)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateToken().value);
    expect(seen.size).toBe(50);
  });
});

describe("tokenFromRandomBytes (deterministic construction)", () => {
  it("maps 24 bytes deterministically into the format", () => {
    const bytes = new Uint8Array(24).map((_, i) => (i * 7 + 3) % 256);
    const first = tokenFromRandomBytes(bytes);
    const second = tokenFromRandomBytes(bytes);
    expect(first.value).toBe(second.value);
    expect(first.value).toMatch(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/);
    // 20 secret bytes = 160 bits of base32 payload
    expect(first.value.slice(13)).toHaveLength(32);
  });

  it("rejects wrong entropy sizes", () => {
    expect(() => tokenFromRandomBytes(new Uint8Array(20))).toThrow("24 random bytes");
  });
});

describe("tokenLookupPrefix", () => {
  it("rejects values shorter than the upstream len>=8 gate", () => {
    expect(tokenLookupPrefix("short")).toBeNull();
    expect(tokenLookupPrefix("1234567")).toBeNull();
  });

  it("accepts 8-char values (whole value as prefix candidate)", () => {
    expect(tokenLookupPrefix("12345678")).toBe("12345678");
  });

  it("uses the first 12 chars of our format as prefix", () => {
    const { value, prefix } = generateToken();
    expect(tokenLookupPrefix(value)).toBe(prefix);
  });

  it("accepts the imported 40-hex Gitea shape (first 12 hex chars)", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567";
    expect(tokenLookupPrefix(hex)).toBe("0123456789ab");
  });
});

describe("isCfGiteaTokenShape", () => {
  it("accepts minted tokens", () => {
    expect(isCfGiteaTokenShape(generateToken().value)).toBe(true);
  });

  it("rejects wrong lengths, wrong separators and out-of-alphabet chars", () => {
    expect(isCfGiteaTokenShape("cfg_00_0")).toBe(false);
    expect(isCfGiteaTokenShape("xyz_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
    expect(isCfGiteaTokenShape(`cfg_0000000g_${"A".repeat(32)}`)).toBe(false); // 'g' is not hex
    expect(isCfGiteaTokenShape(`cfg_00000000_${"0".repeat(32)}`)).toBe(false); // '0' is excluded from the base32 alphabet
    expect(isCfGiteaTokenShape(`cfg_00000000_I${"A".repeat(31)}`)).toBe(false); // 'I' is excluded
    const { value } = generateToken();
    expect(isCfGiteaTokenShape(`${value}x`)).toBe(false);
  });
});

describe("digest (SPEC-0002 §5 known vectors)", () => {
  it("sha256Hex matches the known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("timingSafeDigestEqual compares equal digests", async () => {
    const a = await sha256Hex("abc");
    expect(await timingSafeDigestEqual(a, a)).toBe(true);
    expect(await timingSafeDigestEqual(a, await sha256Hex("abd"))).toBe(false);
  });

  it("returns false for unequal-length or malformed hex without throwing", async () => {
    expect(await timingSafeDigestEqual("abcd", "abc")).toBe(false);
    expect(await timingSafeDigestEqual("zzzz", "abcd")).toBe(false);
  });
});
