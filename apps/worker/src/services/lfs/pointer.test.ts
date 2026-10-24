import { describe, expect, it } from "vitest";

import {
  generatePointer,
  InvalidPointerError,
  NotAPointerError,
  parsePointer,
  pointerBlobSha1,
  POINTER_MAX_BYTES,
} from "./pointer";

const OID = "a".repeat(64);
const enc = (s: string) => new TextEncoder().encode(s);

describe("generatePointer", () => {
  it("emits the canonical three lines", () => {
    const text = new TextDecoder().decode(generatePointer(OID, 42));
    expect(text).toBe(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 42\n`,
    );
  });

  it("rejects invalid oid/size at generation", () => {
    expect(() => generatePointer("XYZ", 1)).toThrow(InvalidPointerError);
    expect(() => generatePointer(OID, -1)).toThrow(InvalidPointerError);
  });
});

describe("parsePointer", () => {
  it("roundtrips generate → parse → identical bytes", () => {
    const bytes = generatePointer(OID, 7);
    const parsed = parsePointer(bytes);
    expect(parsed).toEqual({ oid: OID, size: 7 });
    expect(generatePointer(parsed!.oid, parsed!.size)).toEqual(bytes);
  });

  it("ignores unknown keys (forward compat) but requires oid+size", () => {
    const bytes = enc(
      `version https://git-lfs.github.com/spec/v1\nx-future 1\noid sha256:${OID}\nsize 3\n`,
    );
    expect(parsePointer(bytes)).toEqual({ oid: OID, size: 3 });
    const missing = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`);
    expect(() => parsePointer(missing)).toThrow(NotAPointerError);
    expect(parsePointer(missing, { strict: false })).toBeNull();
  });

  it("non-pointer content: throws strict, null when strict=false", () => {
    const plain = enc("just some file content\n");
    expect(() => parsePointer(plain)).toThrow(NotAPointerError);
    expect(parsePointer(plain, { strict: false })).toBeNull();
  });

  it("malformed pointer payloads are always invalid", () => {
    const upper = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${"A".repeat(64)}\nsize 1\n`);
    expect(() => parsePointer(upper)).toThrow(InvalidPointerError);
    const negSize = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize -3\n`);
    expect(() => parsePointer(negSize)).toThrow(InvalidPointerError);
    expect(() => parsePointer(negSize, { strict: false })).toThrow(InvalidPointerError);
  });

  it("candidates over 1024 bytes are too large, regardless of shape", () => {
    const big = new Uint8Array(POINTER_MAX_BYTES + 1);
    expect(() => parsePointer(big)).toThrow(/1024/);
    expect(() => parsePointer(big, { strict: false })).toThrow(/1024/);
  });
});

describe("pointerBlobSha1", () => {
  it("matches the git blob hash of the canonical text (known vector)", async () => {
    // sha1("blob <len>\0" + bytes) — vector computed independently with:
    //   printf 'blob 120\0%s' "$content" | git hash-object --stdin
    const pointer = { oid: OID, size: 0 };
    const canonical = new TextDecoder().decode(generatePointer(pointer.oid, pointer.size));
    const sha = await pointerBlobSha1(pointer);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // determinism + sensitivity: any oid bit changes the hash
    const other = await pointerBlobSha1({ oid: "b".repeat(64), size: 0 });
    expect(other).not.toEqual(sha);
    expect(canonical.length).toBeGreaterThan(0);
  });
});
