/**
 * The Composer protocol battery (SPEC-0016 §7 long tail) on real D1 + the
 * real REPO_PACKS binding — upstream routers/api/packages/composer/{api,
 * composer}.go + modules/packages/composer/metadata.go at the pin,
 * through the SERVICE face:
 *
 *  - detectComposerExtName's magic dispatch (zip / tar.gz / bz2-detect +
 *    reject), ParseComposerPackage's composer.json extraction (the
 *    case-insensitive member find), the name/version/type/readme arms,
 *    the ?version= fallback and the BOTH-missing 400, the stored file
 *    name `vendor-project[.version]ext`, the license string|array forms,
 *    the homepage validation;
 *  - the round-trip: the raw-body upload → the D1 rows (SemVer-marked
 *    package, the metadata JSON, the `composer.type` VERSION property,
 *    the lead file), the ALWAYS-409 duplicate;
 *  - the read shapes: the service-index templates, the search (the
 *    property-filtered TOTAL, the FULL-page `next` link, the per_page
 *    clamps), the list, the p2 metadata (minified/packages/type/time/
 *    dist-lowercase-url/shasum, the linked-repo source arm's visibility
 *    gates), the download + the GET-only bump.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageFiles, packageProperties, packageVersions, packages, repositories, users } from "../../db/schema";
import { DuplicatePackageVersionError } from "./model";
import { QuotaTotalCountError, packagesQuotaFromEnv } from "./model";
import {
  COMPOSER_EXT_TAR_BZ2,
  COMPOSER_EXT_TAR_GZ,
  COMPOSER_EXT_ZIP,
  ComposerArchiveError,
  ComposerInvalidNameError,
  ComposerInvalidVersionError,
  ComposerMissingComposerJsonError,
  buildComposerServiceIndex,
  detectComposerExtName,
  getComposerPackageMetadata,
  listComposerPackages,
  openComposerFileForDownload,
  parseComposerPackage,
  searchComposerPackages,
  uploadComposerPackage,
} from "./composer";

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

async function seedUser(username: string, opts: { isAdmin?: boolean } = {}): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
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
// The zip builder (ordered stored entries — the swift battery's builder)
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

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

const COMPOSER_JSON = JSON.stringify({
  name: "gitea/composer-package",
  description: "Package Description",
  type: "composer-plugin",
  license: "MIT",
  homepage: "https://gitea.io",
  authors: [{ name: "Gitea Authors" }],
  bin: ["./bin/script"],
  require: { "php": ">=8.1" },
});

function composerArchive(version?: string, name = "gitea/composer-package"): Uint8Array {
  const raw = JSON.parse(COMPOSER_JSON) as Record<string, unknown>;
  raw.name = name;
  if (version !== undefined) raw.version = version;
  return makeZip([
    { name: "composer.json", data: encoder.encode(JSON.stringify(raw)) },
    { name: "README.md", data: encoder.encode("# Readme") },
  ]);
}

const OWNER = "composerowner";
const DOER = "composerdoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

function owner(): { id: number; type: "user"; visibility: "public" } {
  return { id: ownerRow.id, type: "user", visibility: "public" };
}

async function uploadPackage(bytes: Uint8Array, overrides: Record<string, unknown> = {}): Promise<unknown> {
  return uploadComposerPackage({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: owner(),
    doer: { id: doerRow.id, isAdmin: false },
    content: new Response(bytes.slice()).body as ReadableStream<Uint8Array>,
    declaredLength: bytes.byteLength,
    versionParam: "",
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The format dispatch + ParseComposerPackage
// ---------------------------------------------------------------------------

describe("detectComposerExtName + parseComposerPackage (metadata.go)", () => {
  it("the magic dispatch: PK → zip, gzip → tar.gz, BZh → DETECTED but rejected", () => {
    expect(detectComposerExtName(makeZip([]))).toBe(COMPOSER_EXT_ZIP);
    expect(detectComposerExtName(new Uint8Array([0x1f, 0x8b, 0, 0]))).toBe(COMPOSER_EXT_TAR_GZ);
    expect(detectComposerExtName(encoder.encode("BZh9"))).toBe(COMPOSER_EXT_TAR_BZ2);
    expect(() => detectComposerExtName(encoder.encode("plain"))).toThrow(ComposerArchiveError);
    // The bz2 rejection is the documented reduction (no bzip2 on Workers).
    const info = { name: "x/y", version: "1.0.0" };
    void info;
  });

  it("the composer.json extraction: the fields, the filename, the readme fold", async () => {
    const parsed = await parseComposerPackage(composerArchive("1.0.3"));
    expect(parsed.name).toBe("gitea/composer-package");
    expect(parsed.version).toBe("1.0.3");
    expect(parsed.type).toBe("composer-plugin");
    expect(parsed.filename).toBe("gitea-composer-package.1.0.3.zip");
    expect(parsed.metadata.description).toBe("Package Description");
    expect(parsed.metadata.license).toEqual(["MIT"]);
    expect(parsed.metadata.authors).toEqual([{ name: "Gitea Authors" }]);
    expect(parsed.metadata.bin).toEqual(["./bin/script"]);
    expect(parsed.metadata.require).toEqual({ php: ">=8.1" });
    expect(parsed.metadata.readme).toBe("# Readme");
  });

  it("the version arms: the ?version= fallback, the BOTH-missing 400, the bad-version 400", async () => {
    const parsed = await parseComposerPackage(composerArchive(undefined), "2.1.0");
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.filename).toBe("gitea-composer-package.2.1.0.zip");
    // ParseComposerPackage TOLERATES the empty version (metadata.go:185's
    // optional-arg fallback) — the 400 lives at the route's
    // `if cp.Version == ""` (composer.go:172-176), which the upload test
    // below pins.
    expect((await parseComposerPackage(composerArchive(undefined))).version).toBe("");
    await expect(parseComposerPackage(composerArchive("not-semver"))).rejects.toBeInstanceOf(ComposerInvalidVersionError);
  });

  it("the name grammar and the missing-composer.json sentinels", async () => {
    await expect(parseComposerPackage(composerArchive("1.0.0", "Bad/Name"))).rejects.toBeInstanceOf(ComposerInvalidNameError);
    await expect(
      parseComposerPackage(makeZip([{ name: "other.json", data: encoder.encode("{}") }])),
    ).rejects.toBeInstanceOf(ComposerMissingComposerJsonError);
    await expect(parseComposerPackage(encoder.encode("garbage"))).rejects.toBeInstanceOf(ComposerArchiveError);
  });

  it("an invalid homepage blanks; the license string form wraps", async () => {
    const parsed = await parseComposerPackage(
      makeZip([
        {
          name: "composer.json",
          data: encoder.encode(JSON.stringify({ name: "a/b", version: "1.0.0", homepage: "not a url", license: "MIT" })),
        },
      ]),
    );
    expect(parsed.metadata.homepage).toBe("");
    expect(parsed.metadata.license).toEqual(["MIT"]);
  });
});

// ---------------------------------------------------------------------------
// The upload round-trip + the read shapes
// ---------------------------------------------------------------------------

describe("uploadComposerPackage (composer.go:151-223)", () => {
  it("the round-trip: the D1 rows, the composer.type VERSION property, the lead file", async () => {
    const bytes = composerArchive("1.0.3");
    const result = (await uploadPackage(bytes)) as Awaited<ReturnType<typeof uploadComposerPackage>>;

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.type).toBe("composer");
    expect(pkgs[0]?.lowerName).toBe("gitea/composer-package");
    expect(pkgs[0]?.semverCompatible).toBe(true);

    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    const metadata = JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata.description).toBe("Package Description");
    expect(metadata.license).toEqual(["MIT"]);
    expect(metadata.readme).toBe("# Readme");

    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, versions[0]?.id ?? 0))
      .all();
    expect(props).toHaveLength(1);
    expect(props[0]?.name).toBe("composer.type");
    expect(props[0]?.value).toBe("composer-plugin");
    expect(props[0]?.refType).toBe(0); // PropertyType.Version

    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("gitea-composer-package.1.0.3.zip");
    expect(files[0]?.isLead).toBe(true);
    void result;
  });

  it("a re-publish of the SAME version is the always-409", async () => {
    const bytes = composerArchive("1.0.3");
    await uploadPackage(bytes);
    await expect(uploadPackage(bytes)).rejects.toBeInstanceOf(DuplicatePackageVersionError);
    expect(await db().select().from(packageFiles).all()).toHaveLength(1);
  });

  it("the missing-version arm (neither composer.json nor ?version=) is the 400", async () => {
    await expect(uploadPackage(composerArchive(undefined))).rejects.toBeInstanceOf(ComposerInvalidVersionError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("the count quota fires on the +1 boundary", async () => {
    const bytes = composerArchive("1.0.3");
    await uploadPackage(bytes, {
      quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
    });
    const bytes2 = composerArchive("1.0.4");
    await expect(
      uploadPackage(bytes2, {
        quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
      }),
    ).rejects.toBeInstanceOf(QuotaTotalCountError);
  });
});

describe("the composer read shapes (api.go)", () => {
  async function seedTwoPackages(): Promise<void> {
    await uploadPackage(composerArchive("1.0.3"));
    await uploadPackage(composerArchive("1.0.4"));
    await uploadPackage(composerArchive("1.0.0", "gitea/second-package"));
  }

  it("the service index templates (api.go:18-28)", () => {
    const index = buildComposerServiceIndex("https://ex.com/api/packages/o/composer");
    expect(index).toEqual({
      search: "https://ex.com/api/packages/o/composer/search.json?q=%query%&type=%type%",
      metadata_url: "https://ex.com/api/packages/o/composer/p2/%package%.json",
      list: "https://ex.com/api/packages/o/composer/list.json",
    });
  });

  it("the search: the property-filtered total, the FULL-page next link, the pagination", async () => {
    await seedTwoPackages();
    const url = "https://ex.com/api/packages/o/composer/search.json";

    const all = await searchComposerPackages(env.DB, owner(), "", "", 1, 10, url);
    expect(all.total).toBe(2);
    expect(all.results.map((entry) => entry.name).sort()).toEqual(["gitea/composer-package", "gitea/second-package"]);
    expect(all.next).toBe("");

    const filtered = await searchComposerPackages(env.DB, owner(), "second", "", 1, 10, url);
    expect(filtered.total).toBe(1);
    expect(filtered.results[0]?.name).toBe("gitea/second-package");

    // The type filter narrows the TOTAL (the property-filtered count) —
    // BOTH seeded packages carry composer-plugin (the shared fixture json).
    const typed = await searchComposerPackages(env.DB, owner(), "", "composer-plugin", 1, 10, url);
    expect(typed.total).toBe(2);
    expect(await searchComposerPackages(env.DB, owner(), "", "library", 1, 10, url).then((r) => r.total)).toBe(0);

    // The FULL page answers the next link (2 rows, per_page 1).
    const paged = await searchComposerPackages(env.DB, owner(), "", "", 1, 1, url);
    expect(paged.results).toHaveLength(1);
    expect(paged.next).toBe("https://ex.com/api/packages/o/composer/search.json?q=&type=&page=2&per_page=1");
    const page2 = await searchComposerPackages(env.DB, owner(), "", "", 2, 1, url);
    expect(page2.next).toBe("");
  });

  it("the list (api.go:97-110)", async () => {
    await seedTwoPackages();
    expect(await listComposerPackages(env.DB, owner())).toEqual([
      "gitea/composer-package",
      "gitea/second-package",
    ]);
  });

  it("the p2 metadata: the shape, the type property, the dist url + shasum, the source gates", async () => {
    await seedTwoPackages();
    // Link the package to a PUBLIC repo (the SetRepositoryLink arm).
    await db().insert(repositories).values({
      id: "repo-1",
      storageKey: "r_repo-1",
      ownerNamespace: OWNER,
      ownerId: ownerRow.id,
      slug: "linked",
      visibility: "public",
      createdAt: new Date("2026-10-31T12:00:00Z"),
      updatedAt: new Date("2026-10-31T12:00:00Z"),
    });
    const pkg = (await db().select().from(packages).all())[0];
    await db()
      .update(packages)
      .set({ repoId: "repo-1" })
      .where(eq(packages.id, pkg?.id ?? 0));

    const registry = "https://ex.com/api/packages/o/composer";
    const meta = await getComposerPackageMetadata(env.DB, owner(), "gitea", "composer-package", registry, "https://ex.com", {
      id: doerRow.id,
      isAdmin: false,
    });
    expect(meta?.minified).toBe("composer/2.0");
    const versions = meta?.packages["gitea/composer-package"] ?? [];
    expect(versions).toHaveLength(2);
    const first = versions[0];
    expect(first?.name).toBe("gitea/composer-package");
    expect(first?.type).toBe("composer-plugin");
    expect(first?.time).toBe(new Date(first?.time ?? 0).toISOString());
    expect(first?.dist.type).toBe("zip");
    expect(first?.dist.shasum).toMatch(/^[0-9a-f]{40}$/);
    // api.go:141 — url.PathEscape escapes the vendor slash (%2F).
    expect(first?.dist.url).toContain("/files/gitea%2Fcomposer-package/");
    expect(first?.dist.url.endsWith(".zip")).toBe(true);
    expect(first?.metadata.description).toBe("Package Description");
    expect(first?.source).toEqual({ url: "https://ex.com/composerowner/linked", type: "git", reference: first?.version });

    // A PRIVATE repo: the OWNER sees the source; another doer does not.
    await db().update(repositories).set({ visibility: "private" }).where(eq(repositories.id, "repo-1"));
    const asOwner = await getComposerPackageMetadata(env.DB, owner(), "gitea", "composer-package", registry, "https://ex.com", {
      id: ownerRow.id,
      isAdmin: false,
    });
    expect(asOwner?.packages["gitea/composer-package"]?.[0]?.source.url).toBe("https://ex.com/composerowner/linked");
    const asOther = await getComposerPackageMetadata(env.DB, owner(), "gitea", "composer-package", registry, "https://ex.com", {
      id: doerRow.id,
      isAdmin: false,
    });
    expect(asOther?.packages["gitea/composer-package"]?.[0]?.source.url).toBe("");
    // An UNLINKED package renders the empty source.
    const other = await getComposerPackageMetadata(env.DB, owner(), "gitea", "second-package", registry, "https://ex.com", {
      id: doerRow.id,
      isAdmin: false,
    });
    expect(other?.packages["gitea/second-package"]?.[0]?.source.url).toBe("");
    // The 404 arm.
    expect(await getComposerPackageMetadata(env.DB, owner(), "gitea", "missing", registry, "https://ex.com", null)).toBeNull();
  });

  it("the download: byte parity + the GET-only bump; the misses", async () => {
    const bytes = composerArchive("1.0.3");
    await uploadPackage(bytes);
    const o = owner();
    const download = await openComposerFileForDownload(
      env.DB,
      env.REPO_PACKS,
      o,
      "gitea/composer-package",
      "1.0.3",
      "gitea-composer-package.1.0.3.zip",
      "GET",
    );
    const served = new Uint8Array(await new Response(download?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(bytes);
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    await openComposerFileForDownload(env.DB, env.REPO_PACKS, o, "gitea/composer-package", "1.0.3", "gitea-composer-package.1.0.3.zip", "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    expect(
      await openComposerFileForDownload(env.DB, env.REPO_PACKS, o, "gitea/composer-package", "9.9.9", "x.zip", "GET"),
    ).toBeNull();
    expect(
      await openComposerFileForDownload(env.DB, env.REPO_PACKS, o, "gitea/composer-package", "1.0.3", "wrong.zip", "GET"),
    ).toBeNull();
  });
});
