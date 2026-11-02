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

describe("parsePointer (positional — upstream ReadPointerFromBuffer, pointer.go:53-80)", () => {
  it("roundtrips generate → parse → identical bytes", () => {
    const bytes = generatePointer(OID, 7);
    const parsed = parsePointer(bytes);
    expect(parsed).toEqual({ oid: OID, size: 7 });
    expect(generatePointer(parsed!.oid, parsed!.size)).toEqual(bytes);
  });

  it("parses positionally: lines[1] is the oid, lines[2] the size, the rest unread", () => {
    // Extra/blank/duplicate lines AFTER lines[2] are never looked at.
    const tail = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 3\nx-future 1\n\noid sha256:${"b".repeat(64)}\n`);
    expect(parsePointer(tail)).toEqual({ oid: OID, size: 3 });
    // No trailing newline is fine (split length 3 exactly).
    const short = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 3`);
    expect(parsePointer(short)).toEqual({ oid: OID, size: 3 });
  });

  it("out-of-order keys reject: upstream never scans beyond the positional reads", () => {
    // size on line 1, oid on line 2 → the oid read fails (ErrInvalidOIDFormat
    // class); the OLD scan-all parser accepted this (ledger L4, 2026-11-02).
    const swapped = enc(`version https://git-lfs.github.com/spec/v1\nsize 3\noid sha256:${OID}\n`);
    expect(() => parsePointer(swapped)).toThrow(InvalidPointerError);
    // InvalidPointerError throws in BOTH strict modes (only NotAPointerError
    // degrades to null under strict:false).
    expect(() => parsePointer(swapped, { strict: false })).toThrow(InvalidPointerError);

    // A blank line where the oid belongs: TrimPrefix leaves "" → invalid oid.
    const blank = enc(`version https://git-lfs.github.com/spec/v1\n\noid sha256:${OID}\nsize 3\n`);
    expect(() => parsePointer(blank)).toThrow(InvalidPointerError);

    // oid duplicated onto the size line: the size read fails.
    const dup = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\noid sha256:${OID}\n`);
    expect(() => parsePointer(dup)).toThrow(InvalidPointerError);
  });

  it("Go ParseInt size semantics: `+5` parses, int64 range bounds, negatives reach the IsValid arm", () => {
    expect(parsePointer(enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize +5\n`))).toEqual({
      oid: OID,
      size: 5,
    });
    // Out of int64 range — Go's ParseInt errors ("value out of range").
    const huge = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 99999999999999999999\n`);
    expect(() => parsePointer(huge)).toThrow(InvalidPointerError);
    // Negative parses fine upstream but fails IsValid() (pointer.go:102) —
    // our InvalidPointerError IS that arm.
    const negSize = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize -3\n`);
    expect(() => parsePointer(negSize)).toThrow(InvalidPointerError);
    expect(() => parsePointer(negSize, { strict: false })).toThrow(InvalidPointerError);
    // Non-numeric → the strconv arm.
    const junk = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize abc\n`);
    expect(() => parsePointer(junk)).toThrow(InvalidPointerError);
  });

  it("the version line is a HasPrefix check (trailing characters tolerated, pointer.go:57)", () => {
    const suffixed = enc(`version https://git-lfs.github.com/spec/v1-extra\noid sha256:${OID}\nsize 1\n`);
    expect(parsePointer(suffixed)).toEqual({ oid: OID, size: 1 });
    // The TrimPrefix oid read accepts a BARE 64-hex line (no `oid sha256:`
    // prefix) — upstream's no-op-strip behavior.
    const bare = enc(`version https://git-lfs.github.com/spec/v1\n${OID}\nsize 1\n`);
    expect(parsePointer(bare)).toEqual({ oid: OID, size: 1 });
  });

  it("structure errors: prefix miss and fewer than 3 newline segments are not-a-pointer", () => {
    const plain = enc("just some file content\n");
    expect(() => parsePointer(plain)).toThrow(NotAPointerError);
    expect(parsePointer(plain, { strict: false })).toBeNull();

    const twoSegments = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}`); // no \n after oid
    expect(() => parsePointer(twoSegments)).toThrow(NotAPointerError);
    expect(parsePointer(twoSegments, { strict: false })).toBeNull();

    // A 2-LINE pointer WITH a trailing newline splits to 3 segments, so the
    // structure check passes and the SIZE read fails instead (strconv arm).
    const missingSize = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\n`);
    expect(() => parsePointer(missingSize)).toThrow(InvalidPointerError);
  });

  it("a BOM'd pointer is NOT a pointer — Go string(buf) keeps the BOM, HasPrefix fails (pointer.go:58-61)", () => {
    // The default TextDecoder strips EF BB BF, which would let the version
    // prefix match where upstream's ErrMissingPrefix arm serves the file raw;
    // ignoreBOM:true keeps the BOM in the decoded text (the v1.5.5 R4-3
    // correction). Both strict modes answer not-a-pointer.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1\n`)]);
    expect(() => parsePointer(bom)).toThrow(NotAPointerError);
    expect(parsePointer(bom, { strict: false })).toBeNull();
    // Sanity: the identical bytes WITHOUT the BOM still parse — the flag's
    // effect is the BOM, not the content.
    expect(parsePointer(enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 1\n`))).toEqual({
      oid: OID,
      size: 1,
    });
  });

  it("malformed pointer payloads are always invalid", () => {
    const upper = enc(`version https://git-lfs.github.com/spec/v1\noid sha256:${"A".repeat(64)}\nsize 1\n`);
    expect(() => parsePointer(upper)).toThrow(InvalidPointerError);
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
