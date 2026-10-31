/**
 * The CRAN protocol battery (SPEC-0016 §7 long tail) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/cran/cran.go +
 * modules/packages/cran/metadata.go + models/packages/cran/search.go at the
 * pin, through the SERVICE face (the container.test.ts service-level
 * precedent; the route arms ride the packages-protocols unit):
 *
 *  - ParseDescription: the field set, the continuation-line rule (a
 *    non-header line joins the previous field with a space), the Author
 *    parenthetical strip, NeedsCompilation yes/no, the invalid
 *    name/version 400 arms;
 *  - ParsePackage: the gzip-magic dispatch (tar.gz vs zip), the
 *    shallow-depth DESCRIPTION pick, the missing-DESCRIPTION 400, the
 *    corrupt-archive 500 class;
 *  - CompareVersions: R's "-" ≡ "." and the natural sort (1.0.2 < 1.0.10);
 *  - the round-trip: the source upload → `{name}_{version}.tar.gz` lead
 *    file + the `cran.type=source` property; the binary upload → the
 *    `platform|rversion` composite key + the THREE-property triple; the
 *    PACKAGES index shape (the field blocks, the per-package latest pick
 *    after an OLDER upload — the integration test's
 *    EnumerateAfterOlderUpload arm); the download's property-matched
 *    search (the platform-mismatch miss); the always-409 duplicate; the
 *    quota arms.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageFiles, packageProperties, packageVersions, packages, users } from "../../db/schema";
import { DuplicatePackageFileError } from "./generic";
import { QuotaTotalCountError, QuotaTotalSizeError, packagesQuotaFromEnv } from "./model";
import { buildTar, gzipCompress, type TarEntry } from "./distro-common";
import {
  CRAN_PROPERTY_PLATFORM,
  CRAN_PROPERTY_RVERSION,
  CRAN_PROPERTY_TYPE,
  CranArchiveError,
  CranInvalidNameError,
  CranInvalidVersionError,
  CranMissingDescriptionError,
  cranCompareVersions,
  enumerateCranPackages,
  naturalSortCompare,
  openCranFileForDownload,
  parseCranDescription,
  parseCranPackage,
  renderCranPackagesIndex,
  uploadCranBinaryPackage,
  uploadCranSourcePackage,
} from "./cran";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repositories",
    "personal_access_tokens",
    "auth_failures",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
});

const db = () => drizzle(env.DB);

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: "public",
      createdAt: new Date("2026-10-31T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// The fixture builders — a real tar.gz / zip holding `pkg/DESCRIPTION`
// (the upstream integration test's WriteTarCompression / WriteZipArchive
// shapes, one directory deep).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function tarEntry(name: string, content: string): TarEntry {
  return { name, mode: 0o600, data: encoder.encode(content) };
}

const DESCRIPTION = [
  "Package: test.package",
  "Version: 1.0.3",
  "Title: The Test Package",
  "Author: KN4CK3R (maintainer)",
  "Maintainer: ORPHANED",
  "Description: Gitea Test",
  "    Package",
  "License: MIT",
  "Depends: methods,",
  "    utils",
  "Imports: abc,",
  " 123",
  "NeedsCompilation: yes",
  "",
].join("\n");

async function makeTarGz(members: TarEntry[]): Promise<Uint8Array> {
  return gzipCompress(buildTar(members, true));
}

// -- The zip builder (the swift battery's ordered stored-entry builder) ----

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

function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(entry.data.byteLength),
      u32le(entry.data.byteLength),
      u16le(nameBytes.byteLength),
      u16le(0),
      nameBytes,
      entry.data,
    ]);
    chunks.push(local);
    central.push(
      concatBytes([
        u32le(0x02014b50),
        u16le(20),
        u16le(20),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(entry.data.byteLength),
        u32le(entry.data.byteLength),
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

const OWNER = "cranowner";
const DOER = "crandoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

function owner(): { id: number; type: "user"; visibility: "public" } {
  return { id: ownerRow.id, type: "user", visibility: "public" };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes.slice()).body as ReadableStream<Uint8Array>;
}

function sourceInput(bytes: Uint8Array, overrides: Record<string, unknown> = {}): Parameters<typeof uploadCranSourcePackage>[0] {
  return {
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: owner(),
    doer: { id: doerRow.id, isAdmin: false },
    content: stream(bytes),
    declaredLength: undefined,
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ParseDescription — the metadata.go arms
// ---------------------------------------------------------------------------

describe("parseCranDescription (metadata.go)", () => {
  it("the field set: continuation lines join with a space, the Author parenthetical strips", () => {
    const parsed = parseCranDescription(DESCRIPTION);
    expect(parsed.name).toBe("test.package");
    expect(parsed.version).toBe("1.0.3");
    expect(parsed.metadata.title).toBe("The Test Package");
    expect(parsed.metadata.description).toBe("Gitea Test Package");
    expect(parsed.metadata.authors).toEqual(["KN4CK3R"]);
    expect(parsed.metadata.license).toBe("MIT");
    expect(parsed.metadata.depends).toEqual(["methods", "utils"]);
    expect(parsed.metadata.imports).toEqual(["abc", "123"]);
    expect(parsed.metadata.needs_compilation).toBe(true);
    expect(parsed.fileExtension).toBe("");
  });

  it("the invalid arms: a bad name, a bad version (the 400 sentinels)", () => {
    expect(() => parseCranDescription("Package: 9bad\nVersion: 1.0\n")).toThrow(CranInvalidNameError);
    expect(() => parseCranDescription("Package: good\nVersion: 1.0.x\n")).toThrow(CranInvalidVersionError);
    // The version grammar admits dot AND dash separators.
    expect(parseCranDescription("Package: good\nVersion: 1.2-3\n").version).toBe("1.2-3");
  });

  it("NeedsCompilation: anything but 'yes' is no; URL splits on ', '", () => {
    const parsed = parseCranDescription("Package: good\nVersion: 1.0\nNeedsCompilation: no\nURL: https://a.io, https://b.io\n");
    expect(parsed.metadata.needs_compilation).toBe(false);
    expect(parsed.metadata.project_url).toEqual(["https://a.io", "https://b.io"]);
  });
});

// ---------------------------------------------------------------------------
// ParsePackage — the container dispatch
// ---------------------------------------------------------------------------

describe("parseCranPackage (metadata.go:63-220)", () => {
  it("the gzip-magic dispatch: a tar.gz answers .tar.gz, a zip answers .zip", async () => {
    const tarGz = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    expect((await parseCranPackage(tarGz)).fileExtension).toBe(".tar.gz");
    const zip = makeZip([{ name: "test.package/DESCRIPTION", data: encoder.encode(DESCRIPTION) }]);
    expect((await parseCranPackage(zip)).fileExtension).toBe(".zip");
  });

  it("a ROOT-level DESCRIPTION and a one-dir-down one both parse; two levels deep is skipped", async () => {
    const root = await makeTarGz([tarEntry("DESCRIPTION", DESCRIPTION)]);
    expect((await parseCranPackage(root)).name).toBe("test.package");
    const deep = await makeTarGz([tarEntry("a/b/DESCRIPTION", DESCRIPTION)]);
    await expect(parseCranPackage(deep)).rejects.toBeInstanceOf(CranMissingDescriptionError);
  });

  it("a missing DESCRIPTION is the 400 sentinel; corrupt archives are the 500 class", async () => {
    await expect(parseCranPackage(await makeTarGz([tarEntry("dummy.txt", "")]))).rejects.toBeInstanceOf(
      CranMissingDescriptionError,
    );
    await expect(parseCranPackage(makeZip([{ name: "dummy.txt", data: encoder.encode("") }]))).rejects.toBeInstanceOf(
      CranMissingDescriptionError,
    );
    await expect(parseCranPackage(encoder.encode("garbage bytes here"))).rejects.toBeInstanceOf(CranArchiveError);
    // gzip magic but a corrupt deflate body.
    await expect(parseCranPackage(new Uint8Array([0x1f, 0x8b, 0, 0, 0, 0, 0, 0, 0, 99]))).rejects.toBeInstanceOf(
      CranArchiveError,
    );
    // A lying zip entry (declared data beyond the buffer).
    const badZip = makeZip([{ name: "x/DESCRIPTION", data: encoder.encode("Package: x\nVersion: 1.0\n") }]);
    badZip[40] = 0xff;
    await expect(parseCranPackage(badZip)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CompareVersions — R's ordering
// ---------------------------------------------------------------------------

describe("cranCompareVersions / naturalSortCompare (metadata.go:248-251)", () => {
  it("R treats '.' and '-' as equivalent separators; the natural sort beats the string order", () => {
    expect(cranCompareVersions("1.0-3", "1.0.3")).toBe(0);
    expect(cranCompareVersions("1.0.2", "1.0.10")).toBeLessThan(0); // NOT the string order
    expect(cranCompareVersions("1.10", "1.9")).toBeGreaterThan(0);
    expect(naturalSortCompare("v1.02.3", "v1.2.03")).toBeLessThan(0); // the tail string compare
    expect(naturalSortCompare("000", "0")).toBeGreaterThan(0); // the tail string compare (upstream's own rule)
  });
});

// ---------------------------------------------------------------------------
// The upload + enumerate + download round-trip
// ---------------------------------------------------------------------------

describe("the cran round-trip (cran.go:113-253)", () => {
  it("the source upload: the {name}_{version}.tar.gz lead file + the source property", async () => {
    const bytes = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    const result = await uploadCranSourcePackage(sourceInput(bytes));

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.type).toBe("cran");
    expect(pkgs[0]?.name).toBe("test.package");
    expect(pkgs[0]?.semverCompatible).toBe(false);

    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]?.metadataJson ?? "{}")).toMatchObject({ title: "The Test Package", license: "MIT" });

    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("test.package_1.0.3.tar.gz");
    expect(files[0]?.isLead).toBe(true);
    expect(files[0]?.compositeKey).toBe("");
    expect(result.file.id).toBe(files[0]?.id);

    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, files[0]?.id ?? 0))
      .all();
    expect(props).toHaveLength(1);
    expect(props[0]?.name).toBe(CRAN_PROPERTY_TYPE);
    expect(props[0]?.value).toBe("source");
  });

  it("the binary upload: the platform|rversion composite key + the THREE-property triple", async () => {
    const zipBytes = makeZip([{ name: "test.package/DESCRIPTION", data: encoder.encode(DESCRIPTION) }]);
    const result = await uploadCranBinaryPackage(sourceInput(zipBytes), "windows", "4.2");
    expect(result.file.compositeKey).toBe("windows|4.2");
    expect(result.file.name).toBe("test.package_1.0.3.zip");

    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, result.file.id))
      .all();
    const byName = new Map(props.map((p) => [p.name, p.value]));
    expect(byName.get(CRAN_PROPERTY_TYPE)).toBe("binary");
    expect(byName.get(CRAN_PROPERTY_PLATFORM)).toBe("windows");
    expect(byName.get(CRAN_PROPERTY_RVERSION)).toBe("4.2");
    // The upstream property-key spellings verbatim (the `cran.rvserion`
    // typo included).
    expect([...byName.keys()].sort()).toEqual(["cran.platform", "cran.rvserion", "cran.type"].sort());

    // A SECOND platform on the SAME version: a second FILE (a different
    // composite key), the version row untouched.
    const second = await uploadCranBinaryPackage(sourceInput(zipBytes), "osx", "4.2");
    expect(second.version.id).toBe(result.version.id);
    expect(await db().select().from(packageFiles).all()).toHaveLength(2);

    // The enumerate arm: only the matching platform triple answers.
    const osx = await enumerateCranPackages(env.DB, owner(), "binary", "osx", "4.2");
    expect(osx).toHaveLength(1);
    expect(osx[0]?.file.id).toBe(second.file.id);
    const missing = await enumerateCranPackages(env.DB, owner(), "binary", "solaris", "4.2");
    expect(missing).toHaveLength(0);
  });

  it("the PACKAGES index shape + the per-package latest pick after an OLDER upload", async () => {
    const bytes = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    await uploadCranSourcePackage(sourceInput(bytes));
    // The OLDER version (the integration test's EnumerateAfterOlderUpload).
    const older = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION.replace("Version: 1.0.3", "Version: 1.0.2"))]);
    await uploadCranSourcePackage(sourceInput(older));

    const entries = await enumerateCranPackages(env.DB, owner(), "source", "", "");
    expect(entries).toHaveLength(1); // the LATEST version only
    expect(entries[0]?.version.version).toBe("1.0.3");
    const body = renderCranPackagesIndex(entries);
    const lines = body.split("\n");
    expect(lines[0]).toBe("Package: test.package");
    expect(lines[1]).toBe("Version: 1.0.3");
    expect(body).toContain("License: MIT");
    expect(body).toContain("Depends: methods, utils");
    expect(body).toContain("Imports: abc, 123");
    expect(body).toContain("NeedsCompilation: yes");
    expect(body).toContain("MD5sum: ");
    expect(entries[0]?.blob.hashMd5).toBeNull();
  });

  it("two packages order by name in the index; the empty answer is []", async () => {
    const z = await makeTarGz([tarEntry("zpkg/DESCRIPTION", DESCRIPTION.replace("test.package", "zpkg"))]);
    const a = await makeTarGz([tarEntry("apkg/DESCRIPTION", DESCRIPTION.replace("test.package", "apkg"))]);
    await uploadCranSourcePackage(sourceInput(z));
    await uploadCranSourcePackage(sourceInput(a));
    const entries = await enumerateCranPackages(env.DB, owner(), "source", "", "");
    expect(entries.map((entry) => entry.pkg.name)).toEqual(["apkg", "zpkg"]);
    expect(await enumerateCranPackages(env.DB, owner(), "source", "", "")).not.toHaveLength(0);
    expect(
      await enumerateCranPackages(env.DB, { id: ownerRow.id + 12345, type: "user", visibility: "public" }, "source", "", ""),
    ).toHaveLength(0);
  });

  it("the download: the property-matched file search (the Archive route's filename match)", async () => {
    const bytes = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    await uploadCranSourcePackage(sourceInput(bytes));
    const zipBytes = makeZip([{ name: "test.package/DESCRIPTION", data: encoder.encode(DESCRIPTION) }]);
    await uploadCranBinaryPackage(sourceInput(zipBytes), "windows", "4.2");

    // Source by filename.
    const source = await openCranFileForDownload(
      env.DB,
      env.REPO_PACKS,
      owner(),
      "source",
      "",
      "",
      "test.package_1.0.3.tar.gz",
    );
    expect(source).not.toBeNull();
    const served = new Uint8Array(await new Response(source?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(bytes);

    // Binary: the right platform matches, the wrong one misses.
    expect(
      await openCranFileForDownload(env.DB, env.REPO_PACKS, owner(), "binary", "windows", "4.2", "test.package_1.0.3.zip"),
    ).not.toBeNull();
    expect(
      await openCranFileForDownload(env.DB, env.REPO_PACKS, owner(), "binary", "osx", "4.2", "test.package_1.0.3.zip"),
    ).toBeNull();
    // The filename miss.
    expect(
      await openCranFileForDownload(env.DB, env.REPO_PACKS, owner(), "source", "", "", "test.package_9.9.9.tar.gz"),
    ).toBeNull();
    expect(await openCranFileForDownload(env.DB, env.REPO_PACKS, owner(), "source", "", "", "")).toBeNull();
  });

  it("a duplicate file (same version + name + composite key) is the 409 even with different bytes", async () => {
    const bytes = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    await uploadCranSourcePackage(sourceInput(bytes));
    const changed = await makeTarGz([tarEntry("other/DESCRIPTION", DESCRIPTION), tarEntry("pad.txt", "x")]);
    await expect(uploadCranSourcePackage(sourceInput(changed))).rejects.toBeInstanceOf(DuplicatePackageFileError);
    expect(await db().select().from(packageFiles).all()).toHaveLength(1);
  });

  it("the quota arms: the +1 count boundary and the owner-size cap with the admin bypass", async () => {
    const bytes = await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION)]);
    const atCap = sourceInput(bytes, {
      quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
    });
    await uploadCranSourcePackage(atCap);
    await expect(
      uploadCranSourcePackage(
        sourceInput(bytes, { quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true } }),
      ),
    ).rejects.toBeInstanceOf(QuotaTotalCountError);
    await expect(
      uploadCranSourcePackage(
        sourceInput(bytes, {
          quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: bytes.byteLength - 1, limitSizeGeneric: -1, packagesEnabled: true },
        }),
      ),
    ).rejects.toBeInstanceOf(QuotaTotalSizeError);
    await uploadCranSourcePackage(
      sourceInput(await makeTarGz([tarEntry("test.package/DESCRIPTION", DESCRIPTION.replace("Version: 1.0.3", "Version: 9.9.9"))]), {
        doer: { id: doerRow.id, isAdmin: true },
        quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: 1, limitSizeGeneric: 1, packagesEnabled: true },
      }),
    );
  });
});
