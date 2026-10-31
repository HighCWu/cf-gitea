/**
 * The swift parse + go-version port battery (SPEC-0016 §2.1's long-tail
 * `swift` row) — upstream modules/packages/swift/metadata_test.go as the
 * oracle, with hashicorp/go-version v1.9.0's own tables for the version
 * grammar (no swift toolchain locally — hand-built zip fixtures, the
 * rpm/arch builder pattern):
 *
 *  - ParsePackage: the missing-manifest / too-large / too-many arms, the
 *    manifest selection (shallowest dir wins, ties by dir name, never
 *    archive order; the single-top-level-directory archives of `swift
 *    package archive-source`), the tools-version trim, the metadata JSON
 *    decode (author synthesis, URL validation, the EMPTY document);
 *  - TrimmedVersionString: the upstream test's table (1 → 1.0, 1.0.0+meta →
 *    1.0, …);
 *  - the go-version port: String() canonicalization, Compare (numeric vs
 *    non-numeric prerelease parts, the longer-prerelease arms, the
 *    jagged-segment rule), NewSemver vs NewVersion acceptance;
 *  - Person.String() (the name-synthesis join).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_SWIFT_MANIFEST_FILE_SIZE,
  MAX_SWIFT_MANIFEST_FILES,
  SwiftInvalidArchiveError,
  SwiftManifestFileTooLargeError,
  SwiftManifestFilesTooLargeError,
  SwiftMissingManifestFileError,
  parseSwiftPackage,
  parseSwiftVersionLax,
  parseSwiftVersionStrict,
  serializeSwiftMetadata,
  swiftCompareVersions,
  swiftTrimmedVersionString,
  swiftVersionString,
} from "./swift";

// ---------------------------------------------------------------------------
// The zip builder — ORDERED stored entries (the upstream
// writeOrderedZipArchive posture: archive order must be controllable for the
// selection-tie arms); `recordedUncompressed` overwrites the recorded size
// (the caps ride the recorded size — metadata.go:74/153 — so the lie fires
// the cap without materializing bytes).
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  recordedUncompressed?: number;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data.slice()).body?.pipeThrough(new CompressionStream("deflate-raw"));
  if (!stream) throw new Error("no deflate stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeSwiftZip(entries: ZipEntrySpec[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const method = entry.method ?? 0;
    const payload = method === 8 ? await deflateRaw(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const recorded = entry.recordedUncompressed ?? entry.data.byteLength;
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20),
      u16le(0),
      u16le(method),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(payload.byteLength),
      u32le(recorded),
      u16le(nameBytes.byteLength),
      u16le(0),
      nameBytes,
      payload,
    ]);
    chunks.push(local);
    central.push(
      concatBytes([
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(0),
        u16le(method),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(payload.byteLength),
        u32le(recorded),
        u16le(nameBytes.byteLength),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        nameBytes,
      ]),
    );
    offset += local.byteLength;
  }
  const centralStart = offset;
  const centralBytes = concatBytes(central);
  chunks.push(centralBytes);
  chunks.push(
    concatBytes([
      u32le(0x06054b50),
      u16le(0),
      u16le(0),
      u16le(entries.length),
      u16le(entries.length),
      u32le(centralBytes.byteLength),
      u32le(centralStart),
      u16le(0),
    ]),
  );
  return concatBytes(chunks);
}

function swiftEntry(name: string, content: string, opts: { method?: 0 | 8; recordedUncompressed?: number } = {}): ZipEntrySpec {
  return { name, data: new TextEncoder().encode(content), ...opts };
}

const MANIFEST_1 = "// swift-tools-version:5.7\n//\n//  Package.swift";
const MANIFEST_2 = "// swift-tools-version:5.6\n//\n//  Package@swift-5.6.swift";

// ---------------------------------------------------------------------------
// ParsePackage — the metadata_test.go arms
// ---------------------------------------------------------------------------

describe("parseSwiftPackage (the metadata_test.go oracle)", () => {
  it("missing manifest → ErrMissingManifestFile (a dummy archive has none)", async () => {
    const zip = await makeSwiftZip([swiftEntry("dummy.txt", "")]);
    await expect(parseSwiftPackage(zip, null)).rejects.toBeInstanceOf(SwiftMissingManifestFileError);
  });

  it("a deeper manifest alone does not stand in for the missing root one (AltManifestOnlyInRootDirectory)", async () => {
    const zip = await makeSwiftZip([
      swiftEntry("Package@swift-5.5.swift", "// swift-tools-version:5.5"),
      swiftEntry("Sub/Package.swift", "// swift-tools-version:5.7"),
    ]);
    // depth 0 dir "." holds only the alt; Sub/Package.swift is depth 1 — the
    // SHALLOWEST dir ("." with the alt) has no default manifest → missing.
    await expect(parseSwiftPackage(zip, null)).rejects.toBeInstanceOf(SwiftMissingManifestFileError);
  });

  it("a single manifest over the recorded size cap → ErrManifestFileTooLarge", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", "a".repeat(MAX_SWIFT_MANIFEST_FILE_SIZE + 1))]);
    await expect(parseSwiftPackage(zip, null)).rejects.toBeInstanceOf(SwiftManifestFileTooLargeError);
  });

  it("the recorded-size lie fires the file cap without materializing bytes", async () => {
    const zip = await makeSwiftZip([
      swiftEntry("Package.swift", "tiny", { recordedUncompressed: MAX_SWIFT_MANIFEST_FILE_SIZE + 1 }),
    ]);
    await expect(parseSwiftPackage(zip, null)).rejects.toBeInstanceOf(SwiftManifestFileTooLargeError);
  });

  it("more than 64 selected manifests → ErrManifestFilesTooLarge (TooManyManifestFiles)", async () => {
    const entries: ZipEntrySpec[] = [swiftEntry("Package.swift", "// swift-tools-version:5.7")];
    for (let i = 0; i < MAX_SWIFT_MANIFEST_FILES; i++) {
      entries.push(swiftEntry(`Package@swift-5.${i}.swift`, "// swift-tools-version:5.7"));
    }
    const zip = await makeSwiftZip(entries);
    await expect(parseSwiftPackage(zip, null)).rejects.toBeInstanceOf(SwiftManifestFilesTooLargeError);
  });

  it("exactly 64 selected manifests parse fine (the cap is > not >=)", async () => {
    const entries: ZipEntrySpec[] = [swiftEntry("Package.swift", MANIFEST_1)];
    for (let i = 1; i < MAX_SWIFT_MANIFEST_FILES; i++) {
      entries.push(swiftEntry(`Package@swift-5.${i}.swift`, "// swift-tools-version:5.7"));
    }
    const zip = await makeSwiftZip(entries);
    const pck = await parseSwiftPackage(zip, null);
    expect(Object.keys(pck.metadata.manifests)).toHaveLength(MAX_SWIFT_MANIFEST_FILES);
  });

  it("WithoutMetadata: two manifests, tools versions trimmed to 5.7 / 5.6 (the alt keyed 5.5 by FILENAME)", async () => {
    const zip = await makeSwiftZip([
      swiftEntry("Package.swift", MANIFEST_1),
      swiftEntry("Package@swift-5.5.swift", MANIFEST_2),
    ]);
    const pck = await parseSwiftPackage(zip, null);
    expect(pck.repositoryURLs).toHaveLength(0);
    expect(Object.keys(pck.metadata.manifests)).toHaveLength(2);
    expect(pck.metadata.manifests[""]?.content).toBe(MANIFEST_1);
    expect(pck.metadata.manifests[""]?.toolsVersion).toBe("5.7");
    // The FILENAME's version keys the map, the CONTENT's tools version is
    // recorded separately (the upstream assert).
    expect(pck.metadata.manifests["5.5"]?.content).toBe(MANIFEST_2);
    expect(pck.metadata.manifests["5.5"]?.toolsVersion).toBe("5.6");
  });

  it("IgnoresNestedManifests: the shallowest dir wins, ties by dir name, never order", async () => {
    const rootAlt = "// swift-tools-version:5.5\n//\n//  Package@swift-5.5.swift";
    const rootPatchAlt = "// swift-tools-version:5.7.1\n//\n//  Package@swift-5.7.1.swift";
    const nested = "// swift-tools-version:6.3\n//\n//  nested fixture package";
    const zip = await makeSwiftZip([
      swiftEntry("/Package.swift", nested), // leading slash → depth 1, dir "/"
      swiftEntry("Package.swift", MANIFEST_1), // depth 0 → wins
      swiftEntry("Package@swift-5.5.swift", rootAlt),
      swiftEntry("Package@swift-5.7.1.swift", rootPatchAlt),
      swiftEntry("Benchmarks/Package.swift", nested),
      swiftEntry("Utils/Fixtures/PlainPackage/Package.swift", nested),
    ]);
    const pck = await parseSwiftPackage(zip, null);
    expect(Object.keys(pck.metadata.manifests)).toHaveLength(3);
    expect(pck.metadata.manifests[""]?.content).toBe(MANIFEST_1);
    expect(pck.metadata.manifests[""]?.toolsVersion).toBe("5.7");
    expect(pck.metadata.manifests["5.5"]?.content).toBe(rootAlt);
    expect(pck.metadata.manifests["5.7.1"]?.content).toBe(rootPatchAlt);
  });

  it("IgnoresNestedManifestsInPrefixedArchive: `swift package archive-source`'s single top-level dir", async () => {
    const zip = await makeSwiftZip([
      swiftEntry("gitea-1.0.1/Package.swift", MANIFEST_1),
      swiftEntry("gitea-1.0.1/Tests/Fixtures/Package.swift", "// swift-tools-version:6.3"),
    ]);
    const pck = await parseSwiftPackage(zip, null);
    expect(Object.keys(pck.metadata.manifests)).toHaveLength(1);
    expect(pck.metadata.manifests[""]?.content).toBe(MANIFEST_1);
  });

  it("ManifestDirectoryTieBreak: equal depth → the NAME decides, never archive order", async () => {
    const contentA = "// swift-tools-version:5.7\n// A";
    const contentB = "// swift-tools-version:5.7\n// B";
    const zip = await makeSwiftZip([
      swiftEntry("b/Package.swift", contentB), // "b" registered FIRST on purpose
      swiftEntry("a/Package.swift", contentA),
    ]);
    const pck = await parseSwiftPackage(zip, null);
    expect(Object.keys(pck.metadata.manifests)).toHaveLength(1);
    expect(pck.metadata.manifests[""]?.content).toBe(contentA);
  });

  it("WithMetadata: the JSON form part fills description/keywords/license/author/repositoryURLs", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    const metadata = `{"name":"gitea","version":"1.0.1","description":"Package Description","keywords":["swift","package"],"license":"MIT","licenseURL":"https://opensource.org/license/mit","codeRepository":"https://gitea.io/gitea/gitea","author":{"givenName":"KN4CK3R"},"repositoryURLs":["https://gitea.io/gitea/repo"]}`;
    const pck = await parseSwiftPackage(zip, new TextEncoder().encode(metadata));
    expect(pck.metadata.description).toBe("Package Description");
    expect(pck.metadata.keywords).toEqual(["swift", "package"]);
    expect(pck.metadata.license).toBe("MIT");
    expect(pck.metadata.licenseURL).toBe("https://opensource.org/license/mit");
    // codeRepository stores as the metadata repository_url (a validated URL).
    expect(pck.metadata.repositoryURL).toBe("https://gitea.io/gitea/gitea");
    expect(pck.metadata.author.name).toBe("KN4CK3R");
    expect(pck.metadata.author.givenName).toBe("KN4CK3R");
    expect(pck.repositoryURLs).toEqual(["https://gitea.io/gitea/repo"]);
  });

  it("WithExplicitNameField: an explicit author name is kept alongside the parts", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    const metadata = `{"author":{"name":"John Doe","givenName":"John","familyName":"Doe"}}`;
    const pck = await parseSwiftPackage(zip, new TextEncoder().encode(metadata));
    expect(pck.metadata.author.name).toBe("John Doe");
    expect(pck.metadata.author.givenName).toBe("John");
    expect(pck.metadata.author.familyName).toBe("Doe");
  });

  it("NameFieldGeneration: the name synthesizes from the parts when absent", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    const metadata = `{"author":{"givenName":"John","middleName":"Q","familyName":"Doe"}}`;
    const pck = await parseSwiftPackage(zip, new TextEncoder().encode(metadata));
    expect(pck.metadata.author.name).toBe("John Q Doe");
  });

  it("WithEmptyJSONMetadata: {} decodes to the zero metadata", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    const pck = await parseSwiftPackage(zip, new TextEncoder().encode("{}"));
    expect(pck.metadata.author.name).toBe("");
    expect(pck.repositoryURLs).toHaveLength(0);
    expect(pck.metadata.repositoryURL).toBe("");
  });

  it("an INVALID repositoryURL / licenseURL is cleared; repositoryURLs are NOT validated", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    const metadata = `{"codeRepository":"not a url","licenseURL":"also not","repositoryURLs":["ssh://git@host/repo.git"]}`;
    const pck = await parseSwiftPackage(zip, new TextEncoder().encode(metadata));
    expect(pck.metadata.repositoryURL).toBe("");
    expect(pck.metadata.licenseURL).toBe("");
    expect(pck.repositoryURLs).toEqual(["ssh://git@host/repo.git"]);
  });

  it("an empty metadata document is a decode failure (the 500 default arm class)", async () => {
    const zip = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1)]);
    await expect(parseSwiftPackage(zip, new TextEncoder().encode(""))).rejects.toThrow();
  });

  it("a corrupt (non-zip) body is zip.NewReader's plain failure", async () => {
    const bytes = new TextEncoder().encode("this is not a zip");
    await expect(parseSwiftPackage(bytes, null)).rejects.toBeInstanceOf(SwiftInvalidArchiveError);
  });

  it("a deflated manifest inflates; a lying recorded size arms the bomb gate", async () => {
    const ok = await makeSwiftZip([swiftEntry("Package.swift", MANIFEST_1, { method: 8 })]);
    const pck = await parseSwiftPackage(ok, null);
    expect(pck.metadata.manifests[""]?.content).toBe(MANIFEST_1);

    const bomb = await makeSwiftZip([
      swiftEntry("Package.swift", MANIFEST_1.repeat(50), { method: 8, recordedUncompressed: 10 }),
    ]);
    await expect(parseSwiftPackage(bomb, null)).rejects.toBeInstanceOf(SwiftInvalidArchiveError);
  });

  it("a one-segment @swift- filename version keys its TRIMMED form (5 → 5.0)", async () => {
    // The filename/tools grammars admit only digit-dot captures (1-3
    // segments), so upstream's ErrInvalidManifestVersion is reachable solely
    // via int64 segment overflow — a guard our port cannot trip (JS numbers
    // never overflow); the observable behavior is the trim.
    const zip = await makeSwiftZip([
      swiftEntry("Package.swift", MANIFEST_1),
      swiftEntry("Package@swift-5.swift", MANIFEST_2),
    ]);
    const pck = await parseSwiftPackage(zip, null);
    expect(pck.metadata.manifests["5.0"]?.content).toBe(MANIFEST_2);
  });

  it("serializeSwiftMetadata renders upstream's tag order with the sorted manifests map", () => {
    const json = serializeSwiftMetadata({
      description: "Package Description",
      keywords: ["swift"],
      repositoryURL: "",
      license: "",
      licenseURL: "https://opensource.org/license/mit",
      author: { name: "KN4CK3R", givenName: "KN4CK3R", middleName: "", familyName: "" },
      manifests: {
        "5.6": { content: MANIFEST_2, toolsVersion: "5.6" },
        "": { content: MANIFEST_1, toolsVersion: "5.7" },
      },
    });
    const round = JSON.parse(json) as Record<string, unknown>;
    // Field order is upstream's declaration order.
    expect(Object.keys(round)).toEqual(["description", "keywords", "license_url", "author", "manifests"]);
    expect(Object.keys(round.manifests as object)).toEqual(["", "5.6"]); // Go's sorted map keys
    expect((round.manifests as Record<string, Record<string, string>>)[""]?.tools_version).toBe("5.7");
    expect((round.manifests as Record<string, Record<string, string>>)["5.6"]?.content).toBe(MANIFEST_2);
  });
});

// ---------------------------------------------------------------------------
// TrimmedVersionString — the upstream table
// ---------------------------------------------------------------------------

describe("swiftTrimmedVersionString (the upstream table)", () => {
  it("renders major.minor plus a non-zero patch", () => {
    const cases: [string, string][] = [
      ["1", "1.0"],
      ["1.0", "1.0"],
      ["1.0.0", "1.0"],
      ["1.0.1", "1.0.1"],
      ["1.0+meta", "1.0"],
      ["1.0.0+meta", "1.0"],
      ["1.0.1+meta", "1.0.1"],
    ];
    for (const [input, expected] of cases) {
      const parsed = parseSwiftVersionStrict(input);
      expect(parsed, input).not.toBeNull();
      expect(swiftTrimmedVersionString(parsed as NonNullable<typeof parsed>), input).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// The go-version port — String() / Compare / the two grammars
// ---------------------------------------------------------------------------

describe("swiftVersionString (go-version canonicalization)", () => {
  it("pads to three segments, drops v and leading zeros, keeps pre/meta", () => {
    expect(swiftVersionString(parseSwiftVersionStrict("v1.0.0") as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>)).toBe(
      "1.0.0",
    );
    expect(swiftVersionString(parseSwiftVersionStrict("1") as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>)).toBe("1.0.0");
    expect(swiftVersionString(parseSwiftVersionStrict("1.04.0") as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>)).toBe(
      "1.4.0",
    );
    expect(swiftVersionString(parseSwiftVersionStrict("1.0.4-beta.1") as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>)).toBe(
      "1.0.4-beta.1",
    );
    expect(swiftVersionString(parseSwiftVersionStrict("1.0.4+b.7") as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>)).toBe(
      "1.0.4+b.7",
    );
  });
});

describe("swiftCompareVersions (go-version Compare)", () => {
  const v = (input: string) => parseSwiftVersionStrict(input) as NonNullable<ReturnType<typeof parseSwiftVersionStrict>>;
  const cmp = (a: string, b: string) => swiftCompareVersions(v(a), v(b));

  it("orders numerically across the segment count", () => {
    expect(cmp("1.0.3", "1.0.4")).toBeLessThan(0);
    expect(cmp("1.0", "1.0.0")).toBe(0);
    expect(cmp("1", "1.0.0")).toBe(0);
    expect(cmp("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(cmp("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("a release outranks its prereleases; prereleases walk go-version's rules", () => {
    expect(cmp("1.0.4", "1.0.4-beta.1")).toBeGreaterThan(0);
    expect(cmp("1.0.4-beta.1", "1.0.4")).toBeLessThan(0);
    // numeric parts compare numerically
    expect(cmp("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    // numeric sorts BELOW non-numeric (comparePart's rule)
    expect(cmp("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    // lexical for both-string parts
    expect(cmp("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    // the LONGER prerelease outranks when the tail part is numeric
    expect(cmp("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    // the jagged-segment rule: 1.0 vs 1.0.1 — the missing segment is non-zero
    expect(cmp("1.0", "1.0.1")).toBeLessThan(0);
  });
});

describe("parseSwiftVersionStrict vs parseSwiftVersionLax (NewSemver vs NewVersion)", () => {
  it("both accept the canonical semver forms", () => {
    for (const input of ["1", "1.0", "1.0.0", "v1.2.3", "1.0.4-beta.1", "1.0.4+b.1", "1.0.0-beta"]) {
      expect(parseSwiftVersionStrict(input), input).not.toBeNull();
      expect(parseSwiftVersionLax(input), input).not.toBeNull();
    }
  });

  it("both reject the malformed forms (the upload gate's 400s)", () => {
    for (const input of ["", "1_0.0", "abc", "1..2", "1.0.0+", "v"]) {
      expect(parseSwiftVersionStrict(input), input).toBeNull();
      expect(parseSwiftVersionLax(input), input).toBeNull();
    }
    // "1.0.6-" is STRICT-invalid (NewSemver — the upload gate's 400, the
    // integration test's arm) but LAX-VALID: NewVersion's letter-prerelease
    // class [-A-Za-z~] EATS the trailing hyphen (verified against
    // go-version v1.9.0 — String() renders "1.0.6--").
    expect(parseSwiftVersionStrict("1.0.6-")).toBeNull();
    const laxDash = parseSwiftVersionLax("1.0.6-");
    expect(laxDash).not.toBeNull();
    expect(laxDash !== null && swiftVersionString(laxDash)).toBe("1.0.6--");
  });

  it("the LAX pattern alone accepts the missing-separator letter prerelease", () => {
    expect(parseSwiftVersionStrict("1.0.0alpha")).toBeNull();
    const lax = parseSwiftVersionLax("1.0.0alpha");
    expect(lax).not.toBeNull();
    expect(lax !== null && swiftVersionString(lax)).toBe("1.0.0-alpha");
  });
});
