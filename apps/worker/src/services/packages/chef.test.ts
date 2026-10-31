/**
 * The Chef supermarket protocol battery (SPEC-0016 §7 long tail) on real
 * D1 + the real REPO_PACKS binding — upstream routers/api/packages/chef/
 * chef.go + modules/packages/chef/chef.go at the pin, through the SERVICE
 * face:
 *
 *  - ParseChefMetadata: the `\A\S+\z` / `\A\d+\.\d+(\.\d+)?\z` gates, the
 *    maintainer→author / source_url→repository_url mapping, the URL
 *    validation, the dependencies map (absent → null, Go's marshal);
 *  - ParsePackage: the one-slash metadata.json pick (root/deep members
 *    skip), the missing/corrupt arms;
 *  - the upload round-trip (the multipart scan, the lowercased lead file,
 *    the metadata JSON, the ALWAYS-409 version duplicate, the
 *    missing-tarball 400);
 *  - the universe shape ({cookbook: {version: {location_type "opscode",
 *    urls, dependencies}}}), the search window (the q filter, the
 *    ABSOLUTE start/items window, the order switch), the cookbook +
 *    version metadata (the "_"→"." knife quirk, tarball_file_size,
 *    license/dependencies), the download counter bump, the two deletes
 *    (the version arm, the cookbook arm's empty-package 404 semantics).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageFiles, packageVersions, packages, users } from "../../db/schema";
import { DuplicatePackageVersionError } from "./model";
import { packagesQuotaFromEnv } from "./model";
import { buildTar, gzipCompress, type TarEntry } from "./distro-common";
import {
  ChefArchiveError,
  ChefInvalidNameError,
  ChefInvalidVersionError,
  ChefMissingMetadataError,
  ChefMissingTarballError,
  buildChefMetadataJson,
  buildChefUniverse,
  deleteChefPackage,
  deleteChefPackageVersion,
  getChefCookbookMetadata,
  getChefVersionMetadata,
  openChefPackageForDownload,
  parseChefMetadata,
  parseChefPackage,
  scanChefUploadForm,
  searchChefPackages,
  uploadChefPackage,
} from "./chef";

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

const METADATA_JSON = JSON.stringify({
  name: "test",
  version: "1.0.1",
  description: "Test Description",
  long_description: "Long",
  maintainer: "KN4CK3R",
  license: "MIT",
  source_url: "https://gitea.io/gitea/gitea",
  dependencies: { "apt": ">= 1.0" },
});

const encoder = new TextEncoder();

function tarEntry(name: string, content: string): TarEntry {
  return { name, mode: 0o600, data: encoder.encode(content) };
}

async function makeCookbook(metadataJson: string | null, members: TarEntry[] = []): Promise<Uint8Array> {
  const all = members.slice();
  if (metadataJson !== null) all.push(tarEntry("test/metadata.json", metadataJson));
  return gzipCompress(buildTar(all, true));
}

function makeMultipart(tarball: Uint8Array): { contentType: string; body: Uint8Array } {
  const boundary = "chefboundary9182";
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="1.0.1.tar.gz"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + tarball.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(tarball, head.byteLength);
  body.set(tail, head.byteLength + tarball.byteLength);
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

const OWNER = "chefowner";
const DOER = "chefdoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

function owner(): { id: number; type: "user"; visibility: "public" } {
  return { id: ownerRow.id, type: "user", visibility: "public" };
}

async function uploadCookbook(
  tarball: Uint8Array,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const form = makeMultipart(tarball);
  return uploadChefPackage({
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
// ParseChefMetadata — chef.go:113-146
// ---------------------------------------------------------------------------

describe("parseChefMetadata (chef.go)", () => {
  it("the name/version gates: \\S+ and \\d+\\.\\d+(\\.\\d+)?", () => {
    // \A\S+\z rejects ANY whitespace inside the name.
    expect(() => parseChefMetadata('{"name":"a b","version":"1.0"}')).toThrow(ChefInvalidNameError);
    expect(parseChefMetadata('{"name":"test","version":"1.0.1"}').version).toBe("1.0.1");
    expect(() => parseChefMetadata('{"name":"test","version":"1"}')).toThrow(ChefInvalidVersionError);
    expect(() => parseChefMetadata('{"name":"test","version":"1.0.0.0"}')).toThrow(ChefInvalidVersionError);
    expect(() => parseChefMetadata('{"name":"test","version":"v1.0.1"}')).toThrow(ChefInvalidVersionError);
    expect(() => parseChefMetadata('{"version":"1.0.1"}')).toThrow(ChefInvalidNameError);
    expect(() => parseChefMetadata('{"name":"","version":"1.0.1"}')).toThrow(ChefInvalidNameError);
  });

  it("the Metadata mapping: maintainer→author, source_url→repository_url (validated), dependencies null when absent", () => {
    const parsed = parseChefMetadata(METADATA_JSON);
    expect(parsed.metadata.author).toBe("KN4CK3R");
    expect(parsed.metadata.repository_url).toBe("https://gitea.io/gitea/gitea");
    expect(parsed.metadata.license).toBe("MIT");
    expect(parsed.metadata.dependencies).toEqual({ apt: ">= 1.0" });
    const blanked = parseChefMetadata('{"name":"t","version":"1.0","source_url":"not a url","maintainer":"m"}');
    expect(blanked.metadata.repository_url).toBe("");
    expect(parseChefMetadata('{"name":"t","version":"1.0"}').metadata.dependencies).toBeNull();
  });

  it("an unparseable metadata.json is the plain-error class", () => {
    expect(() => parseChefMetadata("{nope")).toThrow(ChefArchiveError);
  });
});

// ---------------------------------------------------------------------------
// ParsePackage — chef.go:49-83
// ---------------------------------------------------------------------------

describe("parseChefPackage (chef.go)", () => {
  it("the ONE-slash metadata.json pick; root and deep members skip", async () => {
    const good = await makeCookbook(METADATA_JSON);
    const parsed = await parseChefPackage(good);
    expect(parsed.name).toBe("test");
    expect(parsed.version).toBe("1.0.1");

    const root = await gzipCompress(buildTar([tarEntry("metadata.json", METADATA_JSON)], true));
    await expect(parseChefPackage(root)).rejects.toBeInstanceOf(ChefMissingMetadataError);
    const deep = await gzipCompress(buildTar([tarEntry("a/b/metadata.json", METADATA_JSON)], true));
    await expect(parseChefPackage(deep)).rejects.toBeInstanceOf(ChefMissingMetadataError);
  });

  it("a missing member is the 400 sentinel; corrupt archives are the 500 class", async () => {
    await expect(parseChefPackage(await makeCookbook(null, [tarEntry("dummy.txt", "")]))).rejects.toBeInstanceOf(
      ChefMissingMetadataError,
    );
    await expect(parseChefPackage(encoder.encode("not gzip"))).rejects.toBeInstanceOf(ChefArchiveError);
    const badJson = await makeCookbook("{broken");
    await expect(parseChefPackage(badJson)).rejects.toBeInstanceOf(ChefArchiveError);
  });
});

// ---------------------------------------------------------------------------
// The upload round-trip
// ---------------------------------------------------------------------------

describe("uploadChefPackage (chef.go:201-251)", () => {
  it("the multipart scan answers the tarball part; a missing part is the 400", async () => {
    const tarball = await makeCookbook(METADATA_JSON);
    const form = makeMultipart(tarball);
    expect(scanChefUploadForm(form.contentType, form.body).tarball).toEqual(tarball);
    // A valid multipart body WITHOUT a tarball part is the no-part arm.
    const bare = encoder.encode(
      "--chefboundary9182\r\nContent-Disposition: form-data; name=\"comment\"\r\n\r\nhi\r\n--chefboundary9182--\r\n",
    );
    expect(() => scanChefUploadForm("multipart/form-data; boundary=chefboundary9182", bare)).toThrow(
      ChefMissingTarballError,
    );
    // A content type without a boundary is the unparseable arm.
    expect(() => scanChefUploadForm("application/octet-stream", form.body)).toThrow(ChefArchiveError);
  });

  it("the round-trip: the D1 rows, the lowercased lead file, the metadata JSON", async () => {
    const tarball = await makeCookbook(METADATA_JSON);
    const result = (await uploadCookbook(tarball)) as Awaited<ReturnType<typeof uploadChefPackage>>;

    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.type).toBe("chef");
    expect(pkgs[0]?.name).toBe("test");
    expect(pkgs[0]?.semverCompatible).toBe(true);

    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]?.metadataJson ?? "{}")).toEqual({
      description: "Test Description",
      long_description: "Long",
      author: "KN4CK3R",
      license: "MIT",
      repository_url: "https://gitea.io/gitea/gitea",
      dependencies: { apt: ">= 1.0" },
    });

    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("1.0.1.tar.gz");
    expect(files[0]?.isLead).toBe(true);
    expect(result.file.id).toBe(files[0]?.id);
  });

  it("a re-publish of the SAME version is the always-409 (CreatePackageAndAddFile)", async () => {
    const tarball = await makeCookbook(METADATA_JSON);
    await uploadCookbook(tarball);
    await expect(uploadCookbook(tarball)).rejects.toBeInstanceOf(DuplicatePackageVersionError);
    expect(await db().select().from(packageFiles).all()).toHaveLength(1);
  });

  it("an invalid version in the archive is the 400 sentinel before any insert", async () => {
    const tarball = await makeCookbook(JSON.stringify({ name: "test", version: "1.0.0.0" }));
    await expect(uploadCookbook(tarball)).rejects.toBeInstanceOf(ChefInvalidVersionError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Universe / search / metadata / download / delete
// ---------------------------------------------------------------------------

describe("the chef read arms", () => {
  async function seedTwo(): Promise<void> {
    await uploadCookbook(await makeCookbook(METADATA_JSON));
    await uploadCookbook(
      await makeCookbook(
        JSON.stringify({ name: "second", version: "2.0.0", description: "Second", maintainer: "M2" }),
      ),
    );
    await uploadCookbook(
      await makeCookbook(
        JSON.stringify({
          name: "test",
          version: "1.0.2",
          description: "Newer",
          maintainer: "KN4CK3R",
          source_url: "https://gitea.io/gitea/gitea",
          dependencies: { apt: ">= 1.0" },
        }),
      ),
    );
  }

  it("the universe: {cookbook: {version: {location_type, urls, dependencies}}}", async () => {
    await seedTwo();
    const universe = await buildChefUniverse(env.DB, owner(), "https://ex.com/api/packages/o/chef/api/v1");
    expect(Object.keys(universe).sort()).toEqual(["second", "test"]);
    const testVersions = universe.test ?? {};
    expect(Object.keys(testVersions).sort()).toEqual(["1.0.1", "1.0.2"]);
    expect(testVersions["1.0.2"]?.location_type).toBe("opscode");
    expect(testVersions["1.0.2"]?.location_path).toBe("https://ex.com/api/packages/o/chef/api/v1");
    expect(testVersions["1.0.2"]?.download_url).toBe(
      "https://ex.com/api/packages/o/chef/api/v1/cookbooks/test/versions/1.0.2/download",
    );
    expect(testVersions["1.0.2"]?.dependencies).toEqual({ apt: ">= 1.0" });
    // A metadata without dependencies marshals null (Go's nil map).
    expect(universe.second?.["2.0.0"]?.dependencies).toBeNull();
    expect(await buildChefUniverse(env.DB, { id: ownerRow.id + 42, type: "user", visibility: "public" }, "https://x")).toEqual({});
  });

  it("the search: the q filter, the ABSOLUTE start/items window, the order switch", async () => {
    await seedTwo();
    const base = "https://ex.com/api/packages/o/chef/api/v1/cookbooks/";

    const all = await searchChefPackages(env.DB, owner(), "", "", 0, 10, base);
    expect(all.total).toBe(2);
    expect(all.start).toBe(0);
    expect(all.items.map((item) => item.cookbook_name)).toEqual(["second", "test"]); // name ASC

    const filtered = await searchChefPackages(env.DB, owner(), "test", "", 0, 10, base);
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.cookbook_name).toBe("test");
    expect(filtered.items[0]?.cookbook_maintainer).toBe("KN4CK3R");
    expect(filtered.items[0]?.cookbook).toBe(`${base}test`);
    expect(await searchChefPackages(env.DB, owner(), "nomatch", "", 0, 10, base).then((r) => r.items)).toEqual([]);

    // The window skips ABSOLUTELY (start=1, items=1 answers the SECOND row).
    const windowed = await searchChefPackages(env.DB, owner(), "", "", 1, 1, base);
    expect(windowed.items).toHaveLength(1);
    expect(windowed.items[0]?.cookbook_name).toBe("test");

    // The order switch: recently_updated sorts created DESC (test/1.0.2 was
    // the newest insert).
    const recent = await searchChefPackages(env.DB, owner(), "", "recently_updated", 0, 10, base);
    expect(recent.items[0]?.cookbook_name).toBe("test");
  });

  it("the cookbook metadata: the SemVer sort, the latest, the category/deprecated constants", async () => {
    await seedTwo();
    const versionsBase = "https://ex.com/api/packages/o/chef/api/v1/cookbooks/test/versions/";
    const meta = await getChefCookbookMetadata(env.DB, owner(), "test", versionsBase);
    expect(meta?.name).toBe("test");
    expect(meta?.latest_version).toBe(`${versionsBase}1.0.2`);
    expect(meta?.category).toBe("");
    expect(meta?.deprecated).toBe(false);
    expect(meta?.versions).toHaveLength(2);
    expect(meta?.versions[0]).toBe(`${versionsBase}1.0.1`);
    expect(meta?.maintainer).toBe("KN4CK3R");
    expect(meta?.source_url).toBe("https://gitea.io/gitea/gitea");
    expect(await getChefCookbookMetadata(env.DB, owner(), "missing", "https://x/")).toBeNull();
  });

  it("the version metadata: the _→. knife quirk, tarball_file_size, dependencies", async () => {
    await uploadCookbook(await makeCookbook(METADATA_JSON));
    const cookbookBase = "https://ex.com/api/packages/o/chef/api/v1/cookbooks/test";
    const meta = await getChefVersionMetadata(env.DB, owner(), "test", "1_0_1", cookbookBase);
    expect(meta?.version).toBe("1.0.1");
    expect(meta?.cookbook).toBe(cookbookBase);
    expect(meta?.file).toBe(`${cookbookBase}/versions/1.0.1/download`);
    expect(meta?.license).toBe("MIT");
    expect(meta?.dependencies).toEqual({ apt: ">= 1.0" });
    expect(meta?.tarball_file_size).toBeGreaterThan(0);
    expect(await getChefVersionMetadata(env.DB, owner(), "test", "9.9.9", cookbookBase)).toBeNull();
  });

  it("the download: byte parity + the GET-only counter bump", async () => {
    const tarball = await makeCookbook(METADATA_JSON);
    await uploadCookbook(tarball);
    const o = owner();
    const download = await openChefPackageForDownload(env.DB, env.REPO_PACKS, o, "test", "1.0.1", "GET");
    const served = new Uint8Array(await new Response(download?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(tarball);
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    await openChefPackageForDownload(env.DB, env.REPO_PACKS, o, "test", "1.0.1", "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    expect(await openChefPackageForDownload(env.DB, env.REPO_PACKS, o, "test", "9.9.9", "GET")).toBeNull();
  });

  it("the deletes: the version arm and the cookbook arm (the empty-package 404 semantics)", async () => {
    await uploadCookbook(await makeCookbook(METADATA_JSON));
    await uploadCookbook(await makeCookbook(JSON.stringify({ name: "test", version: "1.0.2" })));
    expect(await deleteChefPackageVersion(env.DB, owner(), "test", "1.0.1")).toBe(true);
    expect(await deleteChefPackageVersion(env.DB, owner(), "test", "9.9.9")).toBe(false);
    expect((await db().select().from(packageVersions).all()).map((row) => row.version)).toEqual(["1.0.2"]);
    // The cookbook arm: every version dies, and a SECOND call answers the
    // empty-package 404 arm.
    expect(await deleteChefPackage(env.DB, owner(), "test")).toBe(true);
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
    // The package ROW survives with zero versions (upstream's
    // RemovePackageVersion; FindUnreferencedPackages owns the row sweep).
    expect(await db().select().from(packages).all()).toHaveLength(1);
    expect(await deleteChefPackage(env.DB, owner(), "test")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildChefMetadataJson — the omitempty set
// ---------------------------------------------------------------------------

describe("buildChefMetadataJson", () => {
  it("drops empty fields, keeps a non-empty dependencies map, renders null-dependencies without the key", () => {
    const full = JSON.parse(
      buildChefMetadataJson({
        description: "d",
        long_description: "",
        author: "a",
        license: "",
        repository_url: "https://u",
        dependencies: { x: "1" },
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(full)).toEqual(["description", "author", "repository_url", "dependencies"]);
    const bare = JSON.parse(
      buildChefMetadataJson({ description: "", long_description: "", author: "", license: "", repository_url: "", dependencies: null }),
    ) as Record<string, unknown>;
    expect(bare).toEqual({});
  });
});
