/**
 * The bzip2 decoder battery — the fixtures are REAL system-bzip2 archives
 * (bzip2 1.0.8, `bzip2 -<level> -c` at authoring time, embedded as base64
 * literals); the CONTENT side is regenerated in-test by the same
 * deterministic loops/PRNG the generator used, so every case asserts
 * decode(fixture) === known content byte-for-byte, with the format's own
 * block+combined CRCs as the loud integrity gate. Regeneration command
 * (any host with bzip2): `bzip2 -9 -c <content-file>` — the base64 below
 * is the verbatim output.
 *
 * The composer tar fixtures were built with the repo's OWN ustar builder
 * (buildTar — the byte-exact expected side is recomputed in-test), so the
 * tar level is cross-verified too, not just the bzip2 level.
 */

import { describe, expect, it } from "vitest";

import { Bzip2Error, bzip2Decompress } from "./bz2";
import { buildTar, readTarMembers } from "./distro-common";

// --- the embedded fixtures (base64 of bzip2 CLI output) -------------------

// bzip2 -9 of a 3072-byte ustar (buildTar: composer.json + README.md + end
// blocks) — the composer upload arm's own fixture, 376B compressed.
const FIXTURE_COMPOSER_TAR_9 =
  "QlpoOTFBWSZTWW7LCeoAAMrfws7QWAf/0yaiXIp///96AACBAAgIMAE4S2GoI0hk9Rk0PU0aNANDI0aAGgNNBpCnkgyAAMmQDIABpkDAgSmlCGp6nk2qZPIRk0NGhkNABoyGjTyz0n5tcQTWBhrtVDBpHJgrvUkxKWhCTA4OJCZVaKmNiaqCzxp3h1yswM7AYwN07ZuCMyXqotWPVpl0Yq1xQf5sDplaeMICSSXIrKbbXfTVo4y5uRUQ6I5M+/iwZbtwmBpCA4Md/hEMURyW3prFmyLKZhC2krzQWREyQgfjNlU7kLtlQaQw/LplKYFAgG9QNMDXx91BkYRUmxkgOvQokaVmDzAq6THhHpIU5MwimSe5udcrEnbKCD0w1kk62ltpddn7vXWnnX7HvUkSQYEyLBftbE0JCQKZGOJAr9Rw0DFbUSlwYj2VlyYCbQYvoDaSTPSC1gVAcHFVuBL1C9AhsIbaQ+O+CSIsIIP4u5IpwoSDdlhPUA==";
// the SAME tar at bzip2 -1 (a different Huffman/selector shape), 376B.
const FIXTURE_COMPOSER_TAR_1 =
  "QlpoMTFBWSZTWW7LCeoAAMrfws7QWAf/0yaiXIp///96AACBAAgIMAE4S2GoI0hk9Rk0PU0aNANDI0aAGgNNBpCnkgyAAMmQDIABpkDAgSmlCGp6nk2qZPIRk0NGhkNABoyGjTyz0n5tcQTWBhrtVDBpHJgrvUkxKWhCTA4OJCZVaKmNiaqCzxp3h1yswM7AYwN07ZuCMyXqotWPVpl0Yq1xQf5sDplaeMICSSXIrKbbXfTVo4y5uRUQ6I5M+/iwZbtwmBpCA4Md/hEMURyW3prFmyLKZhC2krzQWREyQgfjNlU7kLtlQaQw/LplKYFAgG9QNMDXx91BkYRUmxkgOvQokaVmDzAq6THhHpIU5MwimSe5udcrEnbKCD0w1kk62ltpddn7vXWnnX7HvUkSQYEyLBftbE0JCQKZGOJAr9Rw0DFbUSlwYj2VlyYCbQYvoDaSTPSC1gVAcHFVuBL1C9AhsIbaQ+O+CSIsIIP4u5IpwoSDdlhPUA==";
// bzip2 -9 of the empty stream (header + footer only), 14B.
const FIXTURE_EMPTY = "QlpoORdyRThQkAAAAAA=";
// bzip2 -9 of "aaaaa" — the block ends on an RLE count byte (the pending-
// repeats-at-block-end edge), 39B.
const FIXTURE_RUN5 = "QlpoOTFBWSZTWUSkMD0AAAJBACAAIAAgACEAggsXckU4UJBEpDA9";
// bzip2 -5 of "z".repeat(5000) — a single-symbol alphabet, 45B.
const FIXTURE_ONE_SYMBOL = "QlpoNTFBWSZTWd3ucT0AAAmAoIAQAIAACCAAIKU0GY1GwTxdyRThQkN3ucT0";
// bzip2 -9 of cycle(900000, 23) — the EXACT single-block capacity, 185B.
const FIXTURE_CYCLE_900K =
  "QlpoOTFBWSZTWUeI5zkATGyGAD///4AwARgBQAYjTTRoUAGI000aBSqjJoaMQaacRShRrzSlCjBKUKMUpQo6JShRklKFHVKUKOyUoUd0pQozSlCjwlKFHlKUKNEpQo1SlCjSKUKNopQo9RShR7ilCj5FKFH2KUKN4pQo/RShRxFKFH8xQVkmU1lWBFN9AAAFBgA/8P+AIAAxTJiZBkYQTIaBkxJWNL4yut875n/E0LuSKcKEhsis6Hg=";
// bzip2 -1 of cycle(110000, 23) — TWO blocks (the -1 block size is
// 100000), exercising the multi-block walk + the combined CRC, 222B.
const FIXTURE_MULTIBLOCK =
  "QlpoMTFBWSZTWa+7IxwACH0GAD///4AwANAKADEaaaNBNVRNGmQaAwoAMRppo03IFVgQKrEgVXIgVWRAquZAquhAqsyBVdSBVaECq1IFV2IFV3IFV4IFV5IFVsQKr0QKr2QKr4QKr6QKr8QKr+QKrcgVXBigrJMprMP8UFiAAGzDAB///8AYAFgKADEaaaNBNVUZNDRiDTQoAMRppo04KJrzpEwpExpE6UiZUidaRO1InekTOkTxSJ5pE0pE1pE0KJsUT0UT2UT4UT6UTcon4onBRP4u5IpwoSGxHc0Q";
// bzip2 -9 of the run-heavy corpus (300 runs of 200-692 bytes + separators,
// 133677B) — RUNA/RUNB + RLE1 heavy, 378B.
const FIXTURE_RUN_HEAVY =
  "QlpoOTFBWSZTWVYdIhgAAWh/r4gAAAgQAAAQIAAAIH////iAgQECBAAABAgAAAhAAcI3RA0qAAD/aqjJ6nqYCABUgAB/5VQY8qAAAgMRp/+VKP8qoGT9UaAABCoQb/aVSN/qUjQZNGmmmjGhKIURH5KEoinbu38OLop09Jda7Lbr2oSw7ABWAFwA3Y227W23e26ISQEgAvADACEkASACYATCEkAEgAmAEyEkqtqqyqs66qUoqtqqyqs66qUoqtiqyqsyqtqqyqrMKsVgTIAEABWAQABAAWgFgAEABABEkkzJJMySZkkmZJJmSTO7skmd+623PdbPfZV1W26u7q6q//p87+HHv4fnHw6ABybbf9zbbfNqrFV/lVYqoFVirVVWKtVVYq1ACAFQAgBUANqq2qrFVaqoBNuMXGMYVQKBgAAgEAAIBBJJRJQSSUAIkkoklIAEACAAkoEAIBi6qm3htvDYBgAwJJYSSwaau7qqquou5IpwoSCsOkQw";
// bzip2 -9 of 1024 seeded-PRNG bytes — incompressible, 1339B.
const FIXTURE_RANDOM_1K =
  "QlpoOTFBWSZTWTcNMEMAAFL//9/////////v////////+///////////v/7/f///v///wAK87ddUzdumIExoCGNA1MIyNMBMEek2g0T0R6BPSZpqMNRtBoMoZNqYajIepoYyTTJppoxoT0DRpqaYDQj0m0jaIw0GgmJoyemjQEbQh1Bk00/VDTyamgxHqBoyPKaZNHqB6E9RtJ4oPUepo0GIG0R6IyNP0pso9AZDUPSGyno0EPUZMynlNHqep7VMBMYpiegamRkMg/SmQaGntIiAAmAnpMABMmTNBMaAAGmmk8ow00CYJtGhkEG0ANTAmnojJpp6hk0wmmEaZGaTNNRgTaNExoBpM1MnoTyJpgCYgNGhoGpgyNT1PSM0JpvSTCZNMmmIYmJtJhMmaE9TGhqPQm0R5qTEGTJpphGmJphqaZ6jIJ6mRho0TJgAnoaJkaaYRgTTIMH/5IpfMhpzozgUbPFDga3GtKyerjkdP0+wPIeVJ79boZBLs/q6KnVg+rfzDSmBSyQi7c/F70VwC4PPMNIDxJbdsjdqJINQTKKCDOSwSBOscviA/3i0YveI2YIEtqz62JH+5dzoghg1LiHBO2mCZu0HhkbpkcMuZHik5Q/WBQS8LlpQVO0swCJBv68D7Ct3e9Js4VgMD7d/Kl8YjhYwcDm5PH8Jz7lU+fElkJzmuAAF7tboCiig7pBgloUp2dxNsK9le+yXC2bRYKBUEkWILksXS9Wseg/h2BoXsz59HJw+KMX65zfFtcUCgU+06OhKHQqnK+JDiKSgZ0TQajmtIH3J59LUcgptrrvI2Mgfll/vXVYWEHbzfrRPpvZVcfwCDdyHOZJlFwtmYbh/lemdvkJ/fSG3p+IklMQqHQ6U5zT12DDF7h31+wDCJ0jZvAQCl3ArQKdhb5MMU4BuIfTyQj8F7mEjtSzzHPLOecX+fnCGbD6XSisChlIyCwgYeHVUxDs0pFnT48nJoKG45diPNO4AOuvjCGl5HWP2XTMLc1ET6LQQlBBLXGjG4zhQUiUF0DX7D57ql7+WnQfTTchVhgTvEUPGH4pEmTNyiG5NVweNGx3AxIxgTFm7uLCItVBrYKv0symMNBrAqGf4KysGw7iGF3iKPmDMqKKuYHOm89XqXsiI2NdO3HbSoF3NlyTYbR+w84WvKLO0IUVGVAxN52sh3bA8lUr2DRMBzsrCZ1A5EFSGznMyQ480Rim2mZMnkBSD/FOYw7qSJDS1Eed3RDOr8TNAgCSjVcXhT6E2JNCusZOJ+aaiwWFKd6Umsn+NBpMfKTQDDXaMh7vHybBLDsr6VMYzjJErYdXnd0SsofevedWhncyoQFHxzSlKQ5IOEQ1OkP4pYON1n5aJBAVib+4M2WAKpzr+VdeytHAWRQm20HgHSPKeg3oQZ6BE6GiTRrUHmJdfXm3gINabUGLOgnZ6CEXDvutIpJAPfjs2TofNgy82mTihwDdVH3M3ecULuQNsgZQZ//G+v9fL6BxRFtX8ieeR2X2KT2xoMgWytyFiBIwdoBaaXddPUn9mAGsYBlbTn7wmJfVx6zngDMMOhNfjRbtJ+UrSqEKwIMX6Hae6eSn0KJElLubevJjypFB4EiP1eTtiPJiW2CtZsT3Bb7VwVw7lUnu1HQpxm9DeQ1Y2g2gy4e2wegjiMs8LcfGOhxS8SC4p+lvo5v3iheuA18YQI+SQEcyeMFjWtaJvOnxN3y2Bmpvov0Od8ClgHe/7MkE9hgMfFc1gFio8xGv5YSo8z21sViTQw3OLuSKcKEgbhpghgA==";

// --- the deterministic content generators (shared with the authoring
// script that produced the fixtures) ---------------------------------------

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

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** The exact tar the composer fixtures compress (the repo's own builder —
 *  the expected side of the byte-exact comparison). */
function composerTar(): Uint8Array {
  const composerJson = JSON.stringify(
    {
      name: "gitea/bzip2-package",
      description: "Package Description",
      version: "1.0.0",
      type: "composer-plugin",
      license: "MIT",
      homepage: "https://example.com",
      authors: [{ name: "Gitea Authors" }],
      require: { php: ">=8.1" },
      bin: ["./bin/script"],
    },
    null,
    4,
  );
  const readme = "# Readme\n\nA bzip2-packed composer fixture.\n";
  const encoder = new TextEncoder();
  return buildTar(
    [
      { name: "composer.json", mode: 0o644, data: encoder.encode(composerJson) },
      { name: "README.md", mode: 0o644, data: encoder.encode(readme) },
    ],
    true,
  );
}

// --- the battery -----------------------------------------------------------

describe("bzip2Decompress (the real-bzip2 fixture set)", () => {
  it("decodes the composer tar fixture byte-exactly (buildTar is the oracle)", () => {
    const expected = composerTar();
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_COMPOSER_TAR_9));
    expect(decoded.byteLength).toBe(expected.byteLength);
    expect(latin1(decoded)).toBe(latin1(expected));
  });

  it("decodes the level -1 variant of the same tar byte-exactly", () => {
    const expected = composerTar();
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_COMPOSER_TAR_1));
    expect(latin1(decoded)).toBe(latin1(expected));
  });

  it("the decoded tar walks into the two members with their contents", () => {
    const members = readTarMembers(bzip2Decompress(bytesFromBase64(FIXTURE_COMPOSER_TAR_9)));
    expect(members.map((member) => member.name)).toEqual(["composer.json", "README.md"]);
    const composerJsonBytes = members[0];
    const readmeBytes = members[1];
    if (composerJsonBytes === undefined || readmeBytes === undefined) {
      throw new Error("the decoded tar is missing members");
    }
    const composerJson = latin1(composerJsonBytes.data);
    expect(JSON.parse(composerJson)).toMatchObject({ name: "gitea/bzip2-package", version: "1.0.0" });
    expect(latin1(readmeBytes.data)).toContain("A bzip2-packed composer fixture.");
  });

  it("decodes the two-block -1 fixture (multi-block walk + combined CRC)", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_MULTIBLOCK));
    expect(latin1(decoded)).toBe(latin1(cycleBytes(110000, 23)));
  });

  it("decodes the exact-block-capacity fixture (900000 bytes at -9)", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_CYCLE_900K));
    expect(latin1(decoded)).toBe(latin1(cycleBytes(900000, 23)));
  });

  it("decodes the run-heavy fixture (RUNA/RUNB + RLE1 paths)", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_RUN_HEAVY));
    expect(latin1(decoded)).toBe(latin1(runHeavyBytes()));
  });

  it("decodes the single-symbol fixture", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_ONE_SYMBOL));
    expect(latin1(decoded)).toBe("z".repeat(5000));
  });

  it("flushes the pending repeats of a block ending on a count byte", () => {
    // "aaaaa" encodes as four tracked a's + count 1 as the LAST symbols.
    expect(latin1(bzip2Decompress(bytesFromBase64(FIXTURE_RUN5)))).toBe("aaaaa");
  });

  it("decodes the incompressible random fixture", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_RANDOM_1K));
    expect(latin1(decoded)).toBe(latin1(prngBytes(42, 1024)));
  });

  it("decodes the empty stream to zero bytes", () => {
    const decoded = bzip2Decompress(bytesFromBase64(FIXTURE_EMPTY));
    expect(decoded.byteLength).toBe(0);
  });

  it("decodes concatenated streams in sequence (the combined CRC restarts)", () => {
    // run5 (-9) || one-symbol (-5): different levels, two stream headers.
    const a = bytesFromBase64(FIXTURE_RUN5);
    const b = bytesFromBase64(FIXTURE_ONE_SYMBOL);
    const joined = new Uint8Array(a.byteLength + b.byteLength);
    joined.set(a, 0);
    joined.set(b, a.byteLength);
    const decoded = bzip2Decompress(joined);
    expect(latin1(decoded)).toBe("aaaaa" + "z".repeat(5000));
  });
});

describe("bzip2Decompress rejects malformed streams", () => {
  const good = bytesFromBase64(FIXTURE_COMPOSER_TAR_9);

  it("a truncated stream", () => {
    expect(() => bzip2Decompress(good.subarray(0, 12))).toThrow(Bzip2Error);
  });

  it("a flipped block-CRC bit (the self-checking gate)", () => {
    const bad = good.slice();
    bad[11] = (bad[11] ?? 0) ^ 0x01;
    expect(() => bzip2Decompress(bad)).toThrow(/block checksum mismatch/);
  });

  it("the deprecated randomized-block bit", () => {
    // Byte 14's MSB is the rand bit (4-byte header + 6-byte block magic +
    // 4-byte block CRC are byte-aligned here).
    const bad = good.slice();
    bad[14] = (bad[14] ?? 0) | 0x80;
    expect(() => bzip2Decompress(bad)).toThrow(/deprecated randomized block/);
  });

  it("garbage after the footer (a bad continuation)", () => {
    const bad = new Uint8Array(good.byteLength + 2);
    bad.set(good, 0);
    bad[good.byteLength] = 0x00;
    bad[good.byteLength + 1] = 0x01;
    expect(() => bzip2Decompress(bad)).toThrow(/continuation file/);
  });

  it("a bad compression level", () => {
    const bad = new Uint8Array([0x42, 0x5a, 0x68, 0x30, 0, 0, 0, 0]);
    expect(() => bzip2Decompress(bad)).toThrow(/invalid compression level/);
  });

  it("a non-bzip2 stream", () => {
    const bad = new TextEncoder().encode("not a bzip2 stream at all");
    expect(() => bzip2Decompress(bad)).toThrow(/bad magic value/);
  });
});
