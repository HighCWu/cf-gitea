/**
 * Unit pins for the minimum-key-size / type-allowlist gate of the shared SSH
 * parser (services/ssh-gpg-keys.ts checkSshKeyMinSize — CheckPublicKeyString's
 * tail, models/asymkey/ssh_key_parse.go:180-204, at upstream's DEFAULTS:
 * MinimumKeySizeCheck true, setting/ssh.go:55; MinimumKeySizes from
 * setting/ssh.go:56 ← consts/asymkey.go:7-8).
 *
 * Upstream behavior pinned here:
 *   - rsa needs ≥ AsymKeyMinBitsRsa (3071 — 3072-1, the leading-zero
 *     tolerance); undersized answers "key length is not enough: got N,
 *     needs 3071" (the only type whose length can miss its floor).
 *   - dsa parses but has NO MinimumKeySizes entry — rejected at any size as
 *     "key type is not allowed: dsa" (ssh_key_parse.go:203-204).
 *   - the listed elliptic types (ed25519, the sk pairs, the ecdsa curves)
 *     always pass: their lengths (256/384/521) meet the 256-bit
 *     AsymKeyMinBitsEC floor.
 *   - a wire type outside SSHNativeParsePublicKey's switch is the same
 *     allowlist miss, named by its wire string.
 *
 * The parser is structural, so fabricated wire keys exercise every branch
 * without key-generation tooling; the real ssh-keygen fixtures (the ed25519
 * and dsa lines) pin the real-world encodings. The carrier suites
 * (misc-t3 / deploy-keys / user-settings-keys) pin the HTTP/422 wrapping on
 * top; this file pins the detail-only contract directly.
 */

import { describe, expect, it } from "vitest";

import { SshKeyParseError, parseSshPublicKey } from "./ssh-gpg-keys";

// --- wire fabrication ---------------------------------------------------------

const encoder = new TextEncoder();

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/** A structurally valid `<type> <base64>` line: type string + material
 *  fields, exactly what parseSshPublicKey's wire walk accepts. */
function wireKey(type: string, fields: Uint8Array[]): string {
  const parts = [lengthPrefixed(encoder.encode(type)), ...fields.map(lengthPrefixed)];
  const blob = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    blob.set(part, offset);
    offset += part.length;
  }
  let binary = "";
  for (const byte of blob) {
    binary += String.fromCharCode(byte);
  }
  return `${type} ${btoa(binary)}`;
}

function bytesOf(count: number, firstByte: number): Uint8Array {
  return new Uint8Array(count).fill(firstByte);
}

const RSA_EXPONENT = Uint8Array.of(0x01, 0x00, 0x01); // 65537

// Real ssh-keygen fixtures (generated at authoring time; the fingerprint is
// the tools' — `ssh-keygen -lf`).
const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICQgLhusngED6SvOcMDWHg9wVjgOJ4QTN77gPol4OtTU ed25519-comment user@host";
const DSA_KEY =
  "ssh-dss AAAAB3NzaC1kc3MAAACBANziQoXJkUWmwoVkU1w8otc+LG8Gyit5TKIs3bz8yHgTdDwe2rUC9r3Pkf/BKAAm+7EilJG3Ls5jPCxMQ2lLSsTLUaFEUtVhfe66tPZR/uzrXMYF3rT6ly5c/nmOn8jQDukiUceXe8dEHCFpuLqqVkZB2IhiElHGWkvLcjbArYY5AAAAFQDy2cIqRwRH/qXk9NLDjOayEWUcAwAAAIALZ3x/CJ4+FlpC98yi/WJIQrWKnAivn+bLGODZtxjlrWCGym8BWeUx326afjKVaVd9yWo6xQhbJwphc8feEjF+awNJaZcz3cCpB0/3lfTCylfbkHbs20jQ7U+W5lg2cj2R+rjlLl7AaV4Gw4SsSb2cSD71rvZotbZu5U8g1VDmpQAAAIAZT5Cniy6XyoGVH3Wx+O8Q64gRgF6uUUyFkCS+iiZpfaEooEAjTXsT6vDcJ9OS54oMLMS9wnVuMM1OqS7Uu35tCu9TpfzibwjCXFTPzBledfk7QH4XPwqa3LB08EcmEl+PYIUCqECvRb/QBFOtPIlWqrSxkM+/i3VFdeNNiLltXQ==";

// --- rsa: the only length that can miss its floor ------------------------------

describe("checkSshKeyMinSize via parseSshPublicKey — rsa length floor", () => {
  it("rejects a 1024-bit modulus with the upstream spelling", async () => {
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(128, 0xd4)]))).rejects.toThrow(
      new SshKeyParseError("key length is not enough: got 1024, needs 3071"),
    );
  });

  it("rejects a 2048-bit modulus the same way (the pre-2026 default size)", async () => {
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(256, 0xd4)]))).rejects.toThrow(
      new SshKeyParseError("key length is not enough: got 2048, needs 3071"),
    );
  });

  it("accepts 3072 bits and the exact 3071 boundary (length >= minLen)", async () => {
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(384, 0xd4)]))).resolves.toMatchObject({
      content: wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(384, 0xd4)]),
    });
    // 383*8 + 7 = 3071: the inclusive floor.
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(384, 0x7f)]))).resolves.toBeDefined();
    // One bit under the floor fails with its exact length.
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, bytesOf(384, 0x3f)]))).rejects.toThrow(
      new SshKeyParseError("key length is not enough: got 3070, needs 3071"),
    );
  });

  it("counts the modulus after the mpint's leading zero (AsymKeyMinBitsRsa = 3072-1)", async () => {
    // A real high-bit-first 3072-bit modulus encodes as 0x00 ‖ 384 bytes.
    const modulus = new Uint8Array(385);
    modulus.set(bytesOf(384, 0xd4), 1);
    await expect(parseSshPublicKey(wireKey("ssh-rsa", [RSA_EXPONENT, modulus]))).resolves.toBeDefined();
  });

  it("rejects a real ssh-keygen 1024-bit key with the same detail", async () => {
    await expect(
      parseSshPublicKey(
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDSJ0mzSbBXSJmq8hAHHJOEZ9qnOVO7lEBj2mzb2TVfDhZzUs+webtOaB650gH8R5wNSb4wq5RwITqXfnF6wZghhXgD2Hu1esODrlV+7AOY2kOGw99Bb2mlADeXO91PHyBHblL/l2CxeA+s/bdxL7ioEeYgObfqGMohTSXY4G08Yw==",
      ),
    ).rejects.toThrow(new SshKeyParseError("key length is not enough: got 1024, needs 3071"));
  });
});

// --- the type allowlist --------------------------------------------------------

describe("checkSshKeyMinSize via parseSshPublicKey — the MinimumKeySizes allowlist", () => {
  it("rejects dsa at any size — the map miss (ssh_key_parse.go:203-204)", async () => {
    await expect(parseSshPublicKey(DSA_KEY)).rejects.toThrow(new SshKeyParseError("key type is not allowed: dsa"));
    // The fabricated 1024-bit dsa shape fails identically.
    await expect(
      parseSshPublicKey(wireKey("ssh-dss", [bytesOf(128, 0xd4), bytesOf(20, 0xd4), bytesOf(128, 0xd4), bytesOf(128, 0xd4)])),
    ).rejects.toThrow(new SshKeyParseError("key type is not allowed: dsa"));
  });

  it("rejects a wire type outside SSHNativeParsePublicKey's switch", async () => {
    await expect(parseSshPublicKey(wireKey("spki-hero", [bytesOf(4, 0x41)]))).rejects.toThrow(
      new SshKeyParseError("key type is not allowed: spki-hero"),
    );
  });

  it("accepts every listed type at its real length", async () => {
    await expect(parseSshPublicKey(ED25519_KEY)).resolves.toMatchObject({
      content: ED25519_KEY,
      fingerprint: "SHA256:nBIbxZfae58Hod5zlVgetQGtfn2OhEymkNryw9sEXR8",
    });
    for (const type of [
      "ecdsa-sha2-nistp256",
      "ecdsa-sha2-nistp384",
      "ecdsa-sha2-nistp521",
      "ssh-ed25519",
      "sk-ecdsa-sha2-nistp256@openssh.com",
      "sk-ssh-ed25519@openssh.com",
    ]) {
      await expect(parseSshPublicKey(wireKey(type, [bytesOf(4, 0x41)]))).resolves.toBeDefined();
    }
  });
});
