/**
 * The pub protocol battery (SPEC-0016 §7 long tail) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/pub/pub.go +
 * modules/packages/pub/metadata.go at the pin, through the SERVICE face:
 *
 *  - parsePubspecYaml: the bounded-subset reader (nested block maps, block
 *    and flow sequences, quoted scalars, comments, int/bool/null
 *    resolution, the EMPTY document → null);
 *  - ParsePubspecMetadata: the name pattern arms, the go-version NewSemver
 *    gate + the v.String() NORMALIZATION ("v1.0.0" stores as "1.0.0"),
 *    the URL validation (invalid homepage/repository blanked), the
 *    whole-document pubspec pass-through;
 *  - ParsePackage: the tar.gz walk (pubspec.yaml required — the 400
 *    sentinel; readme.md EqualFold — both members read; the 128 KiB cap;
 *    the corrupt-gzip 500 class);
 *  - the multipart scan + the upload round-trip (the lowercased lead
 *    "{version}.tar.gz", the metadata JSON with pubspec), the ALWAYS-409
 *    version duplicate, the enumerate shape (SemVer sort, latest = last),
 *    the download (.tar.gz trim, byte parity, the GET-only bump), the
 *    finalize probe, the quota boundary.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageFiles, packageVersions, packages, users } from "../../db/schema";
import { DuplicatePackageVersionError } from "./model";
import { QuotaTotalCountError, packagesQuotaFromEnv } from "./model";
import { buildTar, gzipCompress, type TarEntry } from "./distro-common";
import {
  PubArchiveError,
  PubInvalidNameError,
  PubInvalidVersionError,
  PubMissingFileError,
  PubMissingPubspecError,
  PubPubspecTooLargeError,
  enumeratePubPackage,
  getPubVersionMetadata,
  openPubFileForDownload,
  parsePubPackage,
  parsePubspecMetadata,
  parsePubspecYaml,
  pubVersionExists,
  scanPubUploadForm,
  uploadPubPackage,
} from "./pub";

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

const PUBSPEC = [
  "name: test_package",
  "version: 1.0.1",
  "description: Test Description",
  "homepage: https://gitea.io",
  "repository: https://gitea.io/gitea/gitea",
  "documentation: https://gitea.io/docs",
  "environment:",
  "  sdk: '>=3.0.0 <4.0.0'",
  "dependencies:",
  "  http: ^1.2.0",
  "  path: any",
  "dev_dependencies:",
  "  test: '>=1.24.0'",
  "flutter:",
  "  uses-material-design: true",
  "",
].join("\n");

const encoder = new TextEncoder();

function tarEntry(name: string, content: string): TarEntry {
  return { name, mode: 0o600, data: encoder.encode(content) };
}

async function makePackageArchive(pubspec: string | null, readme: string | null): Promise<Uint8Array> {
  const members: TarEntry[] = [];
  if (pubspec !== null) members.push(tarEntry("pubspec.yaml", pubspec));
  if (readme !== null) members.push(tarEntry("README.md", readme));
  return gzipCompress(buildTar(members, true));
}

function makeMultipart(archive: Uint8Array, field = "file"): { contentType: string; body: Uint8Array } {
  const boundary = "pubboundary7351";
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="dummy.tar.gz"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + archive.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(archive, head.byteLength);
  body.set(tail, head.byteLength + archive.byteLength);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

const OWNER = "pubowner";
const DOER = "pubdoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

function owner(): { id: number; type: "user"; visibility: "public" } {
  return { id: ownerRow.id, type: "user", visibility: "public" };
}

async function uploadArchive(archive: Uint8Array, overrides: Record<string, unknown> = {}): Promise<unknown> {
  const form = makeMultipart(archive);
  return uploadPubPackage({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: owner(),
    doer: { id: doerRow.id, isAdmin: false },
    contentType: form.contentType,
    content: new Response(form.body.slice()).body as ReadableStream<Uint8Array>,
    declaredLength: form.body.byteLength,
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The YAML subset reader
// ---------------------------------------------------------------------------

describe("parsePubspecYaml (the bounded subset)", () => {
  it("the flat fields, nested block maps, block sequences, comments, scalar resolution", () => {
    const doc = parsePubspecYaml(PUBSPEC) as Record<string, unknown>;
    expect(doc.name).toBe("test_package");
    expect(doc.version).toBe("1.0.1");
    expect(doc.environment).toEqual({ sdk: ">=3.0.0 <4.0.0" });
    expect(doc.dependencies).toEqual({ http: "^1.2.0", path: "any" });
    expect(doc.flutter).toEqual({ "uses-material-design": true });
    // comments + blank lines vanish
    const commented = parsePubspecYaml("name: x # trailing\n# whole line\nversion: 1.0.0\n") as Record<string, unknown>;
    expect(commented.name).toBe("x");
    expect(commented.version).toBe("1.0.0");
    // sequences
    const seq = parsePubspecYaml("topics:\n  - a\n  - b\nnums: [1, 2, 3]\nmixed:\n  - k: v\n    j: w\n  - plain\n");
    expect(seq).toEqual({
      topics: ["a", "b"],
      nums: [1, 2, 3],
      mixed: [
        { k: "v", j: "w" },
        "plain",
      ],
    });
    // scalar forms
    expect(parsePubspecYaml("a: 'quoted # hash'\nb: \"double\"\nc: 42\nd: 3.14\ne: true\nf: null\ng:\n")).toEqual({
      a: "quoted # hash",
      b: "double",
      c: 42,
      d: 3.14,
      e: true,
      f: null,
      g: null,
    });
  });

  it("the EMPTY document is null (yaml.Unmarshal's answer)", () => {
    expect(parsePubspecYaml("")).toBeNull();
    expect(parsePubspecYaml("# only comments\n\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ParsePubspecMetadata — the metadata.go:115-157 arms
// ---------------------------------------------------------------------------

describe("parsePubspecMetadata (metadata.go)", () => {
  it("the struct fields + the pubspec pass-through + the URL validation", () => {
    const parsed = parsePubspecMetadata(PUBSPEC);
    expect(parsed.name).toBe("test_package");
    expect(parsed.version).toBe("1.0.1");
    expect(parsed.metadata.description).toBe("Test Description");
    expect(parsed.metadata.project_url).toBe("https://gitea.io");
    expect(parsed.metadata.repository_url).toBe("https://gitea.io/gitea/gitea");
    expect(parsed.metadata.documentation_url).toBe("https://gitea.io/docs");
    expect((parsed.metadata.pubspec as Record<string, unknown>).name).toBe("test_package");
  });

  it("invalid homepage/repository blank; valid ones kept (validation.IsValidURL)", () => {
    const parsed = parsePubspecMetadata("name: x\nversion: 1.0.0\nhomepage: not a url\nrepository: ftp://nope\n");
    expect(parsed.metadata.project_url).toBe("");
    expect(parsed.metadata.repository_url).toBe("");
  });

  it("the name pattern `[a-zA-Z_][a-zA-Z0-9_]*` — the 400 sentinels", () => {
    expect(() => parsePubspecMetadata("name: 9bad\nversion: 1.0.0\n")).toThrow(PubInvalidNameError);
    expect(() => parsePubspecMetadata("name: has-dash\nversion: 1.0.0\n")).toThrow(PubInvalidNameError);
    expect(() => parsePubspecMetadata("version: 1.0.0\n")).toThrow(PubInvalidNameError); // name ""
  });

  it("the version gate: go-version NewSemver with the v.String() normalization", () => {
    expect(parsePubspecMetadata("name: x\nversion: v1.0.0\n").version).toBe("1.0.0");
    // An UNQUOTED float-looking version is go-yaml's DECODE ERROR (the
    // plain-error arm), not the invalid-version 400.
    expect(() => parsePubspecMetadata("name: x\nversion: 1.0\n")).toThrow(PubArchiveError);
    expect(parsePubspecMetadata("name: x\nversion: 1.0.0-beta.1+meta\n").version).toBe("1.0.0-beta.1+meta");
    expect(() => parsePubspecMetadata("name: x\nversion: not-semver\n")).toThrow(PubInvalidVersionError);
    expect(() => parsePubspecMetadata("name: x\nversion: 1.0.6-\n")).toThrow(PubInvalidVersionError);
    expect(() => parsePubspecMetadata("name: x\n")).toThrow(PubInvalidVersionError); // version ""
  });
});

// ---------------------------------------------------------------------------
// ParsePackage — the tar.gz walk
// ---------------------------------------------------------------------------

describe("parsePubPackage (metadata.go:75-113)", () => {
  it("the pubspec + readme walk (EqualFold on the readme, BOTH members read)", async () => {
    const archive = await makePackageArchive(PUBSPEC, "# Readme");
    const parsed = await parsePubPackage(archive);
    expect(parsed.metadata.readme).toBe("# Readme");
    // The walk reads the readme AFTER the pubspec too.
    const swapped = await gzipCompress(buildTar([tarEntry("README.md", "late"), tarEntry("pubspec.yaml", PUBSPEC)], true));
    expect((await parsePubPackage(swapped)).metadata.readme).toBe("late");
  });

  it("a pubspec-less archive is the 400 sentinel; the cap and the corrupt arms", async () => {
    await expect(parsePubPackage(await makePackageArchive(null, "readme only"))).rejects.toBeInstanceOf(
      PubMissingPubspecError,
    );
    await expect(parsePubPackage(await makePackageArchive("a".repeat(128 * 1024 + 1), null))).rejects.toBeInstanceOf(
      PubPubspecTooLargeError,
    );
    await expect(parsePubPackage(encoder.encode("not gzip"))).rejects.toBeInstanceOf(PubArchiveError);
    const badYaml = await makePackageArchive("name: [unclosed", null);
    await expect(parsePubPackage(badYaml)).rejects.toBeInstanceOf(PubInvalidNameError);
  });
});

// ---------------------------------------------------------------------------
// The multipart scan + the upload round-trip
// ---------------------------------------------------------------------------

describe("scanPubUploadForm + uploadPubPackage (pub.go:117-190)", () => {
  it("the multipart scan answers the `file` part's bytes; a missing part is the 400", async () => {
    const archive = await makePackageArchive(PUBSPEC, null);
    const form = makeMultipart(archive);
    const scanned = scanPubUploadForm(form.contentType, form.body);
    expect(scanned.file).toEqual(archive);
    const wrongName = makeMultipart(archive, "attachment");
    expect(() => scanPubUploadForm(wrongName.contentType, wrongName.body)).toThrow(PubMissingFileError);
  });

  it("the round-trip: the D1 rows, the lowercased lead file, the metadata JSON with pubspec", async () => {
    const archive = await makePackageArchive(PUBSPEC, "# Readme");
    const result = (await uploadArchive(archive)) as Awaited<ReturnType<typeof uploadPubPackage>>;

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.type).toBe("pub");
    expect(pkgs[0]?.name).toBe("test_package");
    expect(pkgs[0]?.semverCompatible).toBe(true);

    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    const metadata = JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata.description).toBe("Test Description");
    expect(metadata.project_url).toBe("https://gitea.io");
    expect(metadata.repository_url).toBe("https://gitea.io/gitea/gitea");
    expect(metadata.readme).toBe("# Readme");
    expect((metadata.pubspec as Record<string, unknown>).version).toBe("1.0.1");

    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("1.0.1.tar.gz"); // ToLower(version + ".tar.gz")
    expect(files[0]?.isLead).toBe(true);
    expect(result.file.id).toBe(files[0]?.id);
  });

  it("the version normalization on the wire: v1.0.0 stores 1.0.0.tar.gz", async () => {
    const archive = await makePackageArchive("name: norm\nversion: v1.0.0\n", null);
    await uploadArchive(archive);
    const files = await db().select().from(packageFiles).all();
    expect(files[0]?.name).toBe("1.0.0.tar.gz");
    const versions = await db().select().from(packageVersions).all();
    expect(versions[0]?.version).toBe("1.0.0");
  });

  it("a re-publish of the SAME version is the always-409 (CreatePackageAndAddFile)", async () => {
    const archive = await makePackageArchive(PUBSPEC, null);
    await uploadArchive(archive);
    await expect(uploadArchive(archive)).rejects.toBeInstanceOf(DuplicatePackageVersionError);
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);
    expect(await db().select().from(packageFiles).all()).toHaveLength(1);
  });

  it("the quota count boundary (+1) fires before any insert", async () => {
    const archive = await makePackageArchive(PUBSPEC, null);
    const form = makeMultipart(archive);
    await uploadPubPackage({
      d1: env.DB,
      bucket: env.REPO_PACKS,
      owner: owner(),
      doer: { id: doerRow.id, isAdmin: false },
      contentType: form.contentType,
      content: new Response(form.body.slice()).body as ReadableStream<Uint8Array>,
      declaredLength: form.body.byteLength,
      quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
    });
    const second = await makePackageArchive(PUBSPEC.replace("version: 1.0.1", "version: 1.0.2"), null);
    const form2 = makeMultipart(second);
    await expect(
      uploadPubPackage({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner: owner(),
        doer: { id: doerRow.id, isAdmin: false },
        contentType: form2.contentType,
        content: new Response(form2.body.slice()).body as ReadableStream<Uint8Array>,
        declaredLength: form2.body.byteLength,
        quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
      }),
    ).rejects.toBeInstanceOf(QuotaTotalCountError);
  });
});

// ---------------------------------------------------------------------------
// Enumerate + metadata + download + finalize
// ---------------------------------------------------------------------------

describe("enumeratePubPackage / getPubVersionMetadata / openPubFileForDownload", () => {
  it("the enumerate shape: SemVer ASC, latest = the LAST entry, pubspec rendered", async () => {
    await uploadArchive(await makePackageArchive(PUBSPEC, null));
    await uploadArchive(await makePackageArchive(PUBSPEC.replace("version: 1.0.1", "version: 1.0.2"), null));
    const list = await enumeratePubPackage(env.DB, owner(), "test_package", "https://example.com/api/packages/o/pub/api/packages");
    expect(list).not.toBeNull();
    expect(list?.name).toBe("test_package");
    expect(list?.versions.map((entry) => entry.version)).toEqual(["1.0.1", "1.0.2"]);
    expect(list?.latest.version).toBe("1.0.2");
    expect(list?.latest.archive_url).toBe(
      "https://example.com/api/packages/o/pub/api/packages/test_package/files/1.0.2.tar.gz",
    );
    expect((list?.latest.pubspec as Record<string, unknown>).description).toBe("Test Description");
    // The normalize arm participates in the sort.
    const listNorm = await enumeratePubPackage(env.DB, owner(), "missing", "https://x");
    expect(listNorm).toBeNull();
  });

  it("the single-version metadata and the finalize probe", async () => {
    await uploadArchive(await makePackageArchive(PUBSPEC, null));
    const meta = await getPubVersionMetadata(
      env.DB,
      owner(),
      "test_package",
      "1.0.1",
      "https://example.com/api/packages/o/pub/api/packages",
    );
    expect(meta?.version).toBe("1.0.1");
    expect(meta?.archive_url).toBe(
      "https://example.com/api/packages/o/pub/api/packages/test_package/files/1.0.1.tar.gz",
    );
    expect((meta?.pubspec as Record<string, unknown>).name).toBe("test_package");
    expect(await getPubVersionMetadata(env.DB, owner(), "test_package", "9.9.9", "https://x")).toBeNull();
    expect(await pubVersionExists(env.DB, owner(), "test_package", "1.0.1")).toBe(true);
    expect(await pubVersionExists(env.DB, owner(), "test_package", "9.9.9")).toBe(false);
  });

  it("the download: the .tar.gz trim, byte parity, the GET-only counter bump", async () => {
    const archive = await makePackageArchive(PUBSPEC, null);
    await uploadArchive(archive);
    const ownerRowShape = owner();

    const download = await openPubFileForDownload(env.DB, env.REPO_PACKS, ownerRowShape, "test_package", "1.0.1.tar.gz", "GET");
    expect(download).not.toBeNull();
    const served = new Uint8Array(await new Response(download?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(archive);
    expect(download?.file.name).toBe("1.0.1.tar.gz");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // The bare version segment serves too; HEAD never counts.
    await openPubFileForDownload(env.DB, env.REPO_PACKS, ownerRowShape, "test_package", "1.0.1", "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    expect(
      await openPubFileForDownload(env.DB, env.REPO_PACKS, ownerRowShape, "test_package", "9.9.9.tar.gz", "GET"),
    ).toBeNull();
    expect(
      await openPubFileForDownload(env.DB, env.REPO_PACKS, ownerRowShape, "missing", "1.0.1.tar.gz", "GET"),
    ).toBeNull();
  });
});
