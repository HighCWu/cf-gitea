/**
 * The xz codec battery — goldens generated with the system xz/md5sum tooling
 * (recorded generation commands in this header; xz (XZ Utils) 5.4.5):
 *
 *   cd <scratch> && printf 'Package: hello\nVersion: 1.0\nArchitecture: amd64\n\nPackage: world\nVersion: 2.0\nArchitecture: all\n' > control.txt
 *   xz -z -c --check=crc64 -6 control.txt > control.xz.crc64        (same shape for crc32/sha256/none)
 *   xz -z -c --check=crc64 --block-list=40,0 control.txt > control.xz.multiblock
 *   printf 'x' > tiny.txt && xz -z -c --check=crc64 tiny.txt > tiny.xz.crc64
 *   printf '' > empty.txt && xz -z -c --check=crc64 empty.txt > empty.xz.crc64
 *   head -c 262144 /dev/zero > zeros.txt && xz -z -c --check=crc64 -6 zeros.txt > bomb.xz.crc64
 *   cat control.txt <(head -c 3072 /dev/urandom) > mixed.txt && xz -z -c --check=crc64 -6 mixed.txt > mixed.xz.crc64
 *
   (the mixed fixture's urandom tail is per-invocation, so the pin is the
   STREAM bytes below plus the decoded-output identity against the md5 of
   mixed.txt (309b281801400b49693b6f9c42c4c473, `md5sum mixed.txt`) — the
   md5 implementation itself is battery-verified against system md5sum
   above; every other golden regenerates byte-exact from the commands.)
 */

import { describe, expect, it } from "vitest";

import { xzDecode, XzError } from "./xz";
import { xzEncodeStored } from "./xz-encode";
import { Md5, md5Hex } from "./md5";

const CONTROL_TEXT = "Package: hello\nVersion: 1.0\nArchitecture: amd64\n\nPackage: world\nVersion: 2.0\nArchitecture: all\n";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const GOLDEN_CONTROL_XZ_CRC64 =
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4ABeAEFdACgYSGbb2jCF/hblXKh4+VxOOUP4af9UyCy7p5FkaZPBmqd5T67Kmk2OmjEbEAUk0zHLLRizL3riILcN" +
  "bD9l2QeAAAAAAK2w4wxv82UhAAFdX1faR9QftvN9AQAAAAAEWVo=";
const GOLDEN_CONTROL_XZ_CRC32 =
  "/Td6WFoAAAFpIt42AgAhARYAAAB0L+Wj4ABeAEFdACgYSGbb2jCF/hblXKh4+VxOOUP4af9UyCy7p5FkaZPBmqd5T67Kmk2OmjEbEAUk0zHLLRizL3riILcN" +
  "bD9l2QeAAAAAAEz1xigAAVlfUx8rsJBCmQ0BAAAAAAFZWg==";
const GOLDEN_CONTROL_XZ_SHA256 =
  "/Td6WFoAAArh+wyhAgAhARYAAAB0L+Wj4ABeAEFdACgYSGbb2jCF/hblXKh4+VxOOUP4af9UyCy7p5FkaZPBmqd5T67Kmk2OmjEbEAUk0zHLLRizL3riILcN" +
  "bD9l2QeAAAAAABsOHvqNwsKhIhS04JV/suwTV6TOL9XztoRrnXInlpKVAAF1X/10GokYm0uaAQAAAAAKWVo=";
const GOLDEN_CONTROL_XZ_NONE =
  "/Td6WFoAAAD/EtlBAgAhARYAAAB0L+Wj4ABeAEFdACgYSGbb2jCF/hblXKh4+VxOOUP4af9UyCy7p5FkaZPBmqd5T67Kmk2OmjEbEAUk0zHLLRizL3riILcN" +
  "bD9l2QeAAAAAAAABVV9fUJ4cBnKeegEAAAAAAFla";
const GOLDEN_CONTROL_XZ_MULTIBLOCK =
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAnUGFja2FnZTogaGVsbG8KVmVyc2lvbjogMS4wCkFyY2hpdGVjdHVyZQCuny+kG+c63AIAIQEWAAAAdC/lowEANjogYW1kNjQKClBhY2thZ2U6IHdvcmxkClZlcnNpb246IDIuMApBcmNoaXRlY3R1cmU6IGFsbAoAACgHW3AswFlDAAJAKE83AACXGwfuscRn+wIAAAAABFla";
const GOLDEN_TINY_XZ_CRC64 = "/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAAeAAAAABFru+D+O4WCgABGQGlLIHMH7bzfQEAAAAABFla";
const GOLDEN_EMPTY_XZ_CRC64 = "/Td6WFoAAATm1rRGAAAAABzfRCEftvN9AQAAAAAEWVo=";
const GOLDEN_BOMB_XZ_CRC64 =
  "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4///AGpdAABv/f//o7f/Rz5IFXI5YVG4kijmo4YH+e7kHoLTL8U6PAFLsX7JiopNL6MN2X+m44wjEVPgWRjFdYri" +
  "d/i2lH8MasDedElk4ulcU7IE2PdEDKtfDW1G6eXDdoi3llestk3haR1vq/zrOgAAAAD8OJgpPd8bJgABhgGAgBAAQrVycLHEZ/sCAAAAAARZWg==";
const GOLDEN_MIXED_XZ_CRC64 =
  "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";
/** md5sum mixed.txt — the decoded-output identity of the mixed golden. */
const GOLDEN_MIXED_MD5 = "309b281801400b49693b6f9c42c4c473";

const MD5_GOLDENS: { input: string; digest: string }[] = [
  { input: "", digest: "d41d8cd98f00b204e9800998ecf8427e" },
  { input: "x", digest: "9dd4e461268c8034f5c8564e155c67a6" },
  { input: "abc", digest: "900150983cd24fb0d6963f7d28e17f72" },
  { input: "message digest", digest: "f96b697d7cb7938d525a2f31aaf161d0" },
  { input: "The quick brown fox jumps over the lazy dog", digest: "9e107d9d372bb6826bd81d3542a419d6" },
];

describe("md5 (RFC 1321)", () => {
  it("matches the md5sum(1) goldens", () => {
    for (const golden of MD5_GOLDENS) {
      expect(md5Hex(new TextEncoder().encode(golden.input))).toBe(golden.digest);
    }
  });

  it("cross-checks the fixture control text against system md5sum", () => {
    // md5sum control.txt -> 095c3e7c1f25c45a282e3035ebf163c8
    expect(md5Hex(new TextEncoder().encode(CONTROL_TEXT))).toBe("095c3e7c1f25c45a282e3035ebf163c8");
  });

  it("chunks identically to the one-shot across aligned and unaligned splits", () => {
    const bytes = new TextEncoder().encode("abc".repeat(1000));
    const expected = md5Hex(bytes);
    for (const [first, second, third] of [
      [1, 500, 2499],
      [64, 64, 2872],
      [0, 1234, 1766],
    ] as [number, number, number][]) {
      const md5 = new Md5();
      if (first > 0) md5.update(bytes.subarray(0, first));
      md5.update(bytes.subarray(first, first + second));
      md5.update(bytes.subarray(first + second));
      expect(md5.digestHex()).toBe(expected);
      expect(bytes.length).toBe(first + second + third);
    }
  });
});

describe("xzDecode (the .xz control-archive acceptance)", () => {
  it("decodes the system-xz crc64 golden to the control fixture", async () => {
    const decoded = await xzDecode(base64ToBytes(GOLDEN_CONTROL_XZ_CRC64));
    expect(new TextDecoder().decode(decoded)).toBe(CONTROL_TEXT);
  });

  it("decodes the crc32/sha256/none-check siblings of the control golden", async () => {
    for (const golden of [GOLDEN_CONTROL_XZ_CRC32, GOLDEN_CONTROL_XZ_SHA256, GOLDEN_CONTROL_XZ_NONE]) {
      const decoded = await xzDecode(base64ToBytes(golden));
      expect(new TextDecoder().decode(decoded)).toBe(CONTROL_TEXT);
    }
  });

  it("decodes the tiny crc64 golden", async () => {
    const decoded = await xzDecode(base64ToBytes(GOLDEN_TINY_XZ_CRC64));
    expect(new TextDecoder().decode(decoded)).toBe("x");
  });

  it("decodes the empty crc64 golden", async () => {
    const decoded = await xzDecode(base64ToBytes(GOLDEN_EMPTY_XZ_CRC64));
    expect(decoded.byteLength).toBe(0);
  });

  it("decodes the multiblock golden (every block restarts the dictionary)", async () => {
    // xz --block-list=40,0: the first block carries bytes 0..40 as an
    // uncompressed LZMA2 chunk, the second block re-opens with its own dict
    // reset and carries the rest — the mid-stream dict boundary the .xz
    // acceptance must survive.
    const decoded = await xzDecode(base64ToBytes(GOLDEN_CONTROL_XZ_MULTIBLOCK));
    expect(new TextDecoder().decode(decoded)).toBe(CONTROL_TEXT);
  });

  it("decodes the mixed golden (real LZMA-compressed bytes)", async () => {
    // control.txt + 3072 bytes of urandom at -6: the LZMA chunks carry real
    // match/literal work, not the stored chunks the small fixtures ride.
    const decoded = await xzDecode(base64ToBytes(GOLDEN_MIXED_XZ_CRC64));
    expect(md5Hex(decoded)).toBe(GOLDEN_MIXED_MD5);
    expect(decoded.byteLength).toBe(3167);
  });

  it("decodes concatenated streams and tolerates a trailing-garbage tail", async () => {
    const first = base64ToBytes(GOLDEN_CONTROL_XZ_CRC64);
    const second = base64ToBytes(GOLDEN_TINY_XZ_CRC64);
    const concatenated = new Uint8Array(first.byteLength + second.byteLength);
    concatenated.set(first, 0);
    concatenated.set(second, first.byteLength);
    const decoded = await xzDecode(concatenated);
    expect(new TextDecoder().decode(decoded)).toBe(CONTROL_TEXT + "x");

    // A tail that never forms a stream header stops the walk (xz -d's
    // trailing-garbage tolerance), it does not fail the decode.
    const withGarbage = new Uint8Array(concatenated.byteLength + 20);
    withGarbage.set(concatenated, 0);
    withGarbage.set(new TextEncoder().encode("\ntrailing garbage!!\n"), concatenated.byteLength);
    const tolerated = await xzDecode(withGarbage);
    expect(new TextDecoder().decode(tolerated)).toBe(CONTROL_TEXT + "x");
  });

  it("rejects output above maxOutputBytes and decodes fully under it (the bomb gate)", async () => {
    const bomb = base64ToBytes(GOLDEN_BOMB_XZ_CRC64); // 172 bytes -> 256 KiB of zeros
    await expect(xzDecode(bomb, { maxOutputBytes: 4096 })).rejects.toThrow(XzError);

    // Under the gate the same stream expands fully and exactly.
    const decoded = await xzDecode(bomb);
    expect(decoded.byteLength).toBe(256 * 1024);
    for (let i = 0; i < decoded.byteLength; i++) expect(decoded[i]).toBe(0);
  });

  it("round-trips a payload above the 64KiB chunk cap through the stored encoder", async () => {
    // Deterministic pseudo-random bytes (xorshift) — every arm of the
    // decoder's LZMA2 chunk walk runs across four 64KiB-boundary chunks.
    const length = 200 * 1024;
    const payload = new Uint8Array(length);
    let seed = 0x12345678;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      payload[i] = seed & 0xff;
    }
    const decoded = await xzDecode(xzEncodeStored(payload));
    expect(decoded.byteLength).toBe(length);
    for (let i = 0; i < length; i++) expect(decoded[i]).toBe(payload[i]);
  });
});

describe("xzEncodeStored (the Packages.xz posture)", () => {
  it("round-trips the fixture control text through the decoder", async () => {
    const encoded = xzEncodeStored(new TextEncoder().encode(CONTROL_TEXT));
    const decoded = await xzDecode(encoded);
    expect(new TextDecoder().decode(decoded)).toBe(CONTROL_TEXT);
  });

  it("encodes the empty payload", async () => {
    const decoded = await xzDecode(xzEncodeStored(new Uint8Array(0)));
    expect(decoded.byteLength).toBe(0);
  });

  it("emits the same stream shape the empty and multi-chunk arms declare", () => {
    // The stream header + footer flags pin the CRC32 check id; the whole
    // stream stays a single record (one block).
    const encoded = xzEncodeStored(new TextEncoder().encode(CONTROL_TEXT));
    expect(encoded[6]).toBe(0x00); // stream flag byte 0 reserved
    expect(encoded[7]).toBe(0x01); // check id CRC32
    expect(encoded[encoded.byteLength - 1]).toBe(0x5a); // "YZ"
    expect(encoded[encoded.byteLength - 2]).toBe(0x59);
  });

  it("splits a large payload into 64KiB uncompressed LZMA2 chunks", () => {
    // 200 KiB -> four chunks: one dict-resetting 0x01 header, then 0x02s,
    // each <= the 16-bit size field's cap, then the end marker.
    const encoded = xzEncodeStored(new Uint8Array(200 * 1024).fill(0x41));
    let p = 12; // past the stream header
    const headerSizeByte = encoded[p];
    p += (headerSizeByte! + 1) * 4; // past the block header
    const chunks: { control: number; size: number }[] = [];
    for (;;) {
      const control = encoded[p]!;
      if (control === 0x00) break;
      expect(control === 0x01 || control === 0x02).toBe(true);
      const size = ((encoded[p + 1]! << 8) | encoded[p + 2]!) + 1;
      chunks.push({ control, size });
      p += 3 + size;
    }
    expect(chunks.length).toBe(4);
    expect(chunks[0]).toEqual({ control: 0x01, size: 65536 });
    expect(chunks[1]).toEqual({ control: 0x02, size: 65536 });
    expect(chunks[2]).toEqual({ control: 0x02, size: 65536 });
    expect(chunks[3]).toEqual({ control: 0x02, size: 8192 });
  });
});
