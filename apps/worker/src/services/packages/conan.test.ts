/**
 * The Conan protocol battery (SPEC-0016 §7 long tail) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/conan/{conan,search}.go
 * + modules/packages/conan/* + models/packages/conan/* at the pin, through
 * the SERVICE face:
 *
 *  - the reference grammar (the "_" placeholders, the user/channel
 *    pairing, the name/version/revision gates, the composite keys);
 *  - the parsers (the conanfile six-field regexes + the topics tuple, the
 *    conaninfo section walk with the pre-section invalid arm);
 *  - the upload walk (the filename filter, the conanfile metadata UPDATE
 *    on an existing version, the conaninfo property JSON, the
 *    OverwriteExisting delete-and-reinsert with NO duplicate property
 *    rows, the IsLead conanfile);
 *  - THE REVISIONS DANCE (the distinctive arm): recipe revisions and
 *    package revisions as the created-DESC property aggregates, the
 *    latest-revision probes, the unpinned raw-revision filter answering
 *    empty (upstream's shape), the v1 delete that IGNORES the revision,
 *    the v2 pin, the package sweeps (the empty ids = every reference),
 *    the last-file version fold;
 *  - the snapshot/digest/download_urls shapes, the upload_urls filename
 *    filter, the search query grammar (the wildcards, the @user/channel
 *    assembly), the {reference: conaninfo} walk.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageFiles, packageProperties, packageVersions, packages, users } from "../../db/schema";
import { packagesQuotaFromEnv } from "./model";
import {
  CONAN_DEFAULT_REVISION,
  CONAN_PROPERTY_PACKAGE_INFO,
  ConanInfoInvalidError,
  ConanReferenceValidationError,
  buildConanMetadataJson,
  buildConanSnapshot,
  buildConanDownloadUrls,
  buildConanUploadUrls,
  conanPackageAsKey,
  conanRecipeAsKey,
  conanRecipeLinkName,
  conanRecipeString,
  deleteConanPackageV1,
  deleteConanPackageV2,
  deleteConanRecipeV1,
  deleteConanRecipeV2,
  getConanLatestPackageRevision,
  getConanLatestRecipeRevision,
  listConanPackageRevisions,
  listConanPackageReferences,
  listConanRecipeRevisions,
  listConanRevisionFiles,
  newConanPackageReference,
  newConanRecipeReference,
  openConanFileForDownload,
  parseConanConanfile,
  parseConanConaninfo,
  parseConanRecipeQuery,
  searchConanPackages,
  searchConanRecipes,
  uploadConanFile,
} from "./conan";

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
// The fixtures (the upstream integration test's buildConanfileContent shape)
// ---------------------------------------------------------------------------

const CONANFILE = `from conans import ConanFile

class TestConan(ConanFile):
	name = "ConanPackage"
	version = "1.2"
	license = "MIT"
	author = "KN4CK3R"
	homepage = "https://gitea.io"
	url = "https://gitea.io/gitea/gitea"
	description = "test description"
	topics = ("conan", "package")
	settings = "os"
`;

const CONANINFO = `[settings]
os=Windows
[requires]
pkg/1.0
[env]
CC=gcc-10
`;

const encoder = new TextEncoder();

const OWNER = "conanowner";
const DOER = "conandoer";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

function owner(): { id: number; type: "user"; visibility: "public" } {
  return { id: ownerRow.id, type: "user", visibility: "public" };
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(encoder.encode(text).slice()).body as ReadableStream<Uint8Array>;
}

/** The upload walk with the standard wiring (v1 default revision form). */
async function put(
  filename: string,
  content: string,
  overrides: {
    name?: string;
    version?: string;
    user?: string;
    channel?: string;
    revision?: string;
    packageReference?: { reference: string; revision: string } | null;
    now?: Date;
  } = {},
): Promise<unknown> {
  return uploadConanFile({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: owner(),
    doer: { id: doerRow.id, isAdmin: false },
    recipe: newConanRecipeReference(
      overrides.name ?? "ConanPackage",
      overrides.version ?? "1.2",
      overrides.user ?? "gitea",
      overrides.channel ?? "test",
      overrides.revision ?? "",
    ),
    packageReference: overrides.packageReference ?? null,
    filename,
    content: stream(content),
    declaredLength: undefined,
    quota: packagesQuotaFromEnv({}),
    now: overrides.now,
  });
}

// ---------------------------------------------------------------------------
// The reference grammar (reference.go)
// ---------------------------------------------------------------------------

describe("the conan reference grammar (reference.go)", () => {
  it("the _ placeholders blank; the user/channel pairing is enforced", () => {
    expect(newConanRecipeReference("pkg", "1.0", "_", "_", "")).toEqual({
      name: "pkg",
      version: "1.0",
      user: "",
      channel: "",
      revision: "",
    });
    expect(() => newConanRecipeReference("pkg", "1.0", "user", "", "")).toThrow(ConanReferenceValidationError);
    expect(() => newConanRecipeReference("pkg", "1.0", "", "channel", "")).toThrow(ConanReferenceValidationError);
  });

  it("the name/version/user/channel/revision gates (the ref.py limits)", () => {
    expect(() => newConanRecipeReference("x", "1.0", "", "", "")).toThrow(ConanReferenceValidationError); // < 2 chars
    expect(() => newConanRecipeReference("pkg", "  ", "", "", "")).toThrow(ConanReferenceValidationError);
    expect(() => newConanRecipeReference("bad name", "1.0", "", "", "")).toThrow(ConanReferenceValidationError);
    expect(() => newConanRecipeReference("pkg", "1.0", "u$er", "c", "")).toThrow(ConanReferenceValidationError);
    expect(() => newConanRecipeReference("pkg", "1.0", "", "", "rev!")).toThrow(ConanReferenceValidationError);
    expect(newConanRecipeReference("a.b+c-d_e", "1.0", "user", "channel", "rev1")).not.toBeNull();
    expect(() => newConanPackageReference(newConanRecipeReference("pkg", "1.0", "", "", ""), "", "")).toThrow(
      ConanReferenceValidationError,
    );
    expect(() => newConanPackageReference(newConanRecipeReference("pkg", "1.0", "", "", ""), "ref!!", "")).toThrow(
      ConanReferenceValidationError,
    );
  });

  it("the keys and the link names (the composite keys ride |)", () => {
    const rref = newConanRecipeReference("pkg", "1.0", "user", "channel", "");
    expect(conanRecipeAsKey(rref)).toBe("user|channel|0");
    expect(conanRecipeLinkName(rref)).toBe("pkg/1.0/user/channel/0");
    expect(conanRecipeString(rref)).toBe("pkg/1.0@user/channel");
    const bare = newConanRecipeReference("pkg", "1.0", "_", "_", "");
    expect(conanRecipeLinkName(bare)).toBe("pkg/1.0/_/_/0");
    expect(conanRecipeString(bare)).toBe("pkg/1.0");
    const pref = newConanPackageReference(rref, "9f4c", "2");
    expect(conanPackageAsKey(pref)).toBe("user|channel|0|9f4c|2");
    expect(conanPackageAsKey(newConanPackageReference(rref, "9f4c", ""))).toBe("user|channel|0|9f4c|0");
    expect(CONAN_DEFAULT_REVISION).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

describe("the conanfile/conaninfo parsers", () => {
  it("ParseConanfile: the six regex arms + the topics tuple", () => {
    const metadata = parseConanConanfile(CONANFILE);
    expect(metadata.author).toBe("KN4CK3R");
    expect(metadata.license).toBe("MIT");
    expect(metadata.project_url).toBe("https://gitea.io");
    expect(metadata.repository_url).toBe("https://gitea.io/gitea/gitea");
    expect(metadata.description).toBe("test description");
    expect(metadata.keywords).toEqual(["conan", "package"]);
    expect(buildConanMetadataJson(metadata)).toBe(
      JSON.stringify({
        author: "KN4CK3R",
        license: "MIT",
        project_url: "https://gitea.io",
        repository_url: "https://gitea.io/gitea/gitea",
        description: "test description",
        keywords: ["conan", "package"],
      }),
    );
  });

  it("ParseConaninfo: the section walk (maps, requires, env, recipe_hash, the nil empties)", () => {
    const info = parseConanConaninfo(CONANINFO);
    expect(info.settings).toEqual({ os: "Windows" });
    expect(info.requires).toEqual(["pkg/1.0"]);
    expect(info.environment).toEqual({ CC: ["gcc-10"] });
    expect(info.recipe_hash).toBeNull();
    expect(info.full_settings).toBeNull();
    // Content BEFORE any section is the invalid arm.
    expect(() => parseConanConaninfo("junk\n[settings]\nos=Linux\n")).toThrow(ConanInfoInvalidError);
    // An empty body parses to the all-nil shape.
    expect(parseConanConaninfo("")).toEqual({
      settings: null,
      full_settings: null,
      requires: null,
      full_requires: null,
      options: null,
      full_options: null,
      recipe_hash: null,
      environment: null,
    });
    // The bracketed env form splits on commas.
    const env = parseConanConaninfo("[env]\nPATH=[/usr/bin,/bin]\n");
    expect(env.environment).toEqual({ PATH: ["/usr/bin", "/bin"] });
  });
});

// ---------------------------------------------------------------------------
// The upload walk
// ---------------------------------------------------------------------------

describe("uploadConanFile (conan.go:338-461)", () => {
  it("the filename filter: the recipe set and the package set; anything else 400s", async () => {
    await expect(put("extra.txt", "x")).rejects.toThrow("filename is not allowed");
    await expect(
      put("conan_package.tgz", "x", { packageReference: { reference: "9f4c", revision: "" } }),
    ).resolves.toBeTruthy();
    await expect(put("conan_package.tgz", "x")).rejects.toThrow("filename is not allowed");
  });

  it("the conanfile upload: the D1 rows, the metadata, the lead flag, the property triple", async () => {
    await put(CONAN_FILE_NAME, CONANFILE);
    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.type).toBe("conan");
    expect(pkgs[0]?.name).toBe("ConanPackage");
    expect(pkgs[0]?.semverCompatible).toBe(false);
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>).toMatchObject({ author: "KN4CK3R", license: "MIT" });
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("conanfile.py");
    expect(files[0]?.isLead).toBe(true);
    expect(files[0]?.compositeKey).toBe("gitea|test|0");
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, files[0]?.id ?? 0))
      .all();
    const byName = new Map(props.map((prop) => [prop.name, prop.value]));
    expect(byName.get("conan.recipe.user")).toBe("gitea");
    expect(byName.get("conan.recipe.channel")).toBe("test");
    expect(byName.get("conan.recipe.revision")).toBe("0");
  });

  it("the conaninfo upload: the package reference + revision properties + the info JSON", async () => {
    await put(CONAN_FILE_NAME, CONANFILE);
    await put("conaninfo.txt", CONANINFO, { packageReference: { reference: "9f4c", revision: "2" } });
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(2);
    const infoFile = files.find((file) => file.name === "conaninfo.txt");
    expect(infoFile?.compositeKey).toBe("gitea|test|0|9f4c|2");
    expect(infoFile?.isLead).toBe(false);
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, infoFile?.id ?? 0))
      .all();
    const byName = new Map(props.map((prop) => [prop.name, prop.value]));
    expect(byName.get("conan.package.reference")).toBe("9f4c");
    expect(byName.get("conan.package.revision")).toBe("2");
    expect(JSON.parse(byName.get(CONAN_PROPERTY_PACKAGE_INFO) ?? "{}")).toMatchObject({ settings: { os: "Windows" } });
  });

  it("the OverwriteExisting arm: a re-upload REPLACES the row with NO duplicate properties", async () => {
    await put(CONAN_FILE_NAME, CONANFILE);
    const before = (await db().select().from(packageFiles).all())[0]?.id;
    await put(CONAN_FILE_NAME, CONANFILE.replace("MIT", "Apache-2.0"));
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.id).not.toBe(before);
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, files[0]?.id ?? 0))
      .all();
    expect(props.filter((prop) => prop.name === "conan.recipe.user")).toHaveLength(1);
  });

  it("the conanfile metadata UPDATE rides the EXISTING version (conan.go:404-419)", async () => {
    await put(CONAN_FILE_NAME, CONANFILE);
    await put("conanmanifest.txt", "manifest");
    await put(CONAN_FILE_NAME, CONANFILE.replace("test description", "rewritten"));
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect((JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>).description).toBe("rewritten");
    // The manifest file survived the metadata update.
    expect(await db().select().from(packageFiles).all()).toHaveLength(2);
  });
});

const CONAN_FILE_NAME = "conanfile.py";

// ---------------------------------------------------------------------------
// THE REVISIONS DANCE
// ---------------------------------------------------------------------------

describe("the revisions dance (references.go + conan.go:699-833)", () => {
  async function seedTwoRevisions(): Promise<void> {
    // Distinct clocks: the created DESC order is the aggregate's ORDER BY,
    // and D1's second-granularity createdUnix would tie inside one second.
    const t1 = new Date("2026-10-31T10:00:00Z");
    const t2 = new Date("2026-10-31T10:00:10Z");
    await put(CONAN_FILE_NAME, CONANFILE, { revision: "rev1", now: t1 });
    await put("conaninfo.txt", CONANINFO, { revision: "rev1", packageReference: { reference: "9f4c", revision: "r1" }, now: t1 });
    await put(CONAN_FILE_NAME, CONANFILE, { revision: "rev2", now: t2 });
    await put("conaninfo.txt", CONANINFO, { revision: "rev2", packageReference: { reference: "9f4c", revision: "r2" }, now: t2 });
  }

  it("the recipe revisions list created DESC + the latest probe", async () => {
    await seedTwoRevisions();
    const rref = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "");
    const revisions = await listConanRecipeRevisions(env.DB, ownerRow.id, rref);
    expect(revisions.map((entry) => entry.value)).toEqual(["rev2", "rev1"]);
    const latest = await getConanLatestRecipeRevision(env.DB, ownerRow.id, rref);
    expect(latest?.revision).toBe("rev2");
    // The OTHER user/channel pair does not see them.
    const other = newConanRecipeReference("ConanPackage", "1.2", "other", "test", "");
    expect(await listConanRecipeRevisions(env.DB, ownerRow.id, other)).toEqual([]);
    // The 404 maps to null at the service (the route renders the 404 body).
    expect(await getConanLatestRecipeRevision(env.DB, ownerRow.id, other)).toBeNull();
  });

  it("the package references + revisions; the UNPINNED raw-revision filter answers empty", async () => {
    await seedTwoRevisions();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const refs = await listConanPackageReferences(env.DB, ownerRow.id, pinned);
    expect(refs.map((entry) => entry.value)).toEqual(["9f4c"]);
    const pref = newConanPackageReference(pinned, "9f4c", "");
    const revisions = await listConanPackageRevisions(env.DB, ownerRow.id, pref);
    expect(revisions.map((entry) => entry.value)).toEqual(["r1"]);
    const latest = await getConanLatestPackageRevision(env.DB, ownerRow.id, pref);
    expect(latest?.revision).toBe("r1");
    // The UNPINNED recipe revision filters on "" — upstream's raw shape.
    const unpinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "");
    expect(await listConanPackageReferences(env.DB, ownerRow.id, unpinned)).toEqual([]);
  });

  it("the revision-files list answers {files: {name: null}}; the misses are null", async () => {
    await seedTwoRevisions();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const files = await listConanRevisionFiles(env.DB, ownerRow.id, pinned, conanRecipeAsKey(pinned));
    expect(files?.files).toEqual({ "conanfile.py": null });
    const missing = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "revX");
    expect(await listConanRevisionFiles(env.DB, ownerRow.id, missing, conanRecipeAsKey(missing))).toBeNull();
  });

  it("the snapshot, the digest urls, and the upload_urls filename filter", async () => {
    await seedTwoRevisions();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const key = conanRecipeAsKey(pinned);
    const snapshot = await buildConanSnapshot(env.DB, ownerRow.id, pinned, key);
    expect(snapshot).toEqual({ "conanfile.py": "" }); // the WebCrypto md5 reduction
    const urls = await buildConanDownloadUrls(env.DB, ownerRow.id, pinned, key, "https://x/files/pkg/1.2/gitea/test/rev1/recipe");
    expect(urls).toEqual({ "conanfile.py": "https://x/files/pkg/1.2/gitea/test/rev1/recipe/conanfile.py" });
    const missingKey = conanRecipeAsKey(newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "revX"));
    await expect(buildConanSnapshot(env.DB, ownerRow.id, newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "revX"), missingKey)).resolves.toBeNull();
    expect(
      buildConanUploadUrls({ "conanfile.py": 1, "removed.txt": 0 }, false, "https://x/recipe"),
    ).toEqual({ "conanfile.py": "https://x/recipe/conanfile.py" });
    expect(buildConanUploadUrls({ "conaninfo.txt": 5, "conanfile.py": 1 }, true, "https://x/package")).toEqual({
      "conaninfo.txt": "https://x/package/conaninfo.txt",
    });
  });

  it("the download: byte parity + the lead GET bump", async () => {
    await seedTwoRevisions();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const download = await openConanFileForDownload(
      env.DB,
      env.REPO_PACKS,
      ownerRow.id,
      pinned,
      conanRecipeAsKey(pinned),
      "conanfile.py",
      "GET",
    );
    const served = new TextDecoder().decode(new Uint8Array(await new Response(download?.stream as ReadableStream).arrayBuffer()));
    expect(served).toBe(CONANFILE);
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    await openConanFileForDownload(env.DB, env.REPO_PACKS, ownerRow.id, pinned, conanRecipeAsKey(pinned), "conanfile.py", "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
    expect(
      await openConanFileForDownload(env.DB, env.REPO_PACKS, ownerRow.id, pinned, conanRecipeAsKey(pinned), "conaninfo.txt", "GET"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The deletes
// ---------------------------------------------------------------------------

describe("the conan deletes (conan.go:509-696)", () => {
  async function seed(): Promise<void> {
    await put(CONAN_FILE_NAME, CONANFILE, { revision: "rev1" });
    await put("conaninfo.txt", CONANINFO, { revision: "rev1", packageReference: { reference: "9f4c", revision: "r1" } });
    await put("conaninfo.txt", CONANINFO, { revision: "rev1", packageReference: { reference: "aa11", revision: "r1" } });
    await put(CONAN_FILE_NAME, CONANFILE, { revision: "rev2" });
  }

  it("DeletePackageV2 (pinned): the exact reference+revision dies, the rest survives", async () => {
    await seed();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const outcome = await deleteConanPackageV2(env.DB, ownerRow.id, pinned, newConanPackageReference(pinned, "9f4c", "r1"));
    expect(outcome.kind).toBe("deleted");
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(3); // 2 recipe files (rev1+rev2) + the aa11 info
    // The UNPINNED package revision ignores the package revision (the
    // ignorePackageRevision arm) — the same reference's other revision goes.
    const outcome2 = await deleteConanPackageV2(env.DB, ownerRow.id, pinned, newConanPackageReference(pinned, "aa11", ""));
    expect(outcome2.kind).toBe("deleted");
    expect(await db().select().from(packageFiles).all()).toHaveLength(2);
    // A MISS is the reference-not-exist arm.
    expect(
      (await deleteConanPackageV2(env.DB, ownerRow.id, pinned, newConanPackageReference(pinned, "zzzz", ""))).kind,
    ).toBe("reference-not-exist");
  });

  it("DeletePackageV2 (unpinned reference) sweeps every reference of the revision", async () => {
    await seed();
    const pinned = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1");
    const outcome = await deleteConanPackageV2(env.DB, ownerRow.id, pinned, null);
    expect(outcome.kind).toBe("deleted");
    // rev1's packages die; BOTH recipe files survive (the version fold
    // fires only when the VERSION runs dry — rev2's recipe file remains).
    const remaining = (await db().select().from(packageFiles).all()).map((file) => `${file.name}@${file.compositeKey}`);
    expect(remaining.sort()).toEqual([
      `conanfile.py@${conanRecipeAsKey(newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev1"))}`,
      `conanfile.py@${conanRecipeAsKey(newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "rev2"))}`,
    ]);
  });

  it("DeletePackageV1 sweeps the ids (or every reference) across ALL revisions", async () => {
    await seed();
    const rref = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "");
    await deleteConanPackageV1(env.DB, ownerRow.id, rref, ["9f4c"]);
    expect((await db().select().from(packageFiles).all()).map((file) => file.name).sort()).toEqual([
      "conanfile.py",
      "conanfile.py",
      "conaninfo.txt", // the aa11 reference only
    ]);
    await deleteConanPackageV1(env.DB, ownerRow.id, rref, []);
    // The [] sweep deletes PACKAGES only — the recipe files stay.
    expect((await db().select().from(packageFiles).all()).map((file) => file.name)).toEqual(["conanfile.py", "conanfile.py"]);
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);
  });

  it("DeleteRecipeV1 ignores the revision; DeleteRecipeV2 pins it", async () => {
    await seed();
    const rref = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "");
    await deleteConanRecipeV2(env.DB, ownerRow.id, conanRecipeWithRevision(rref, "rev1"));
    // rev1 whole (recipe file + both infos); rev2's recipe file survives.
    expect((await db().select().from(packageFiles).all()).map((file) => file.compositeKey)).toEqual([
      conanRecipeAsKey(conanRecipeWithRevision(rref, "rev2")),
    ]);
    await deleteConanRecipeV1(env.DB, ownerRow.id, rref);
    expect(await db().select().from(packageFiles).all()).toHaveLength(0);
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
    // The miss arms.
    expect((await deleteConanRecipeV1(env.DB, ownerRow.id, rref)).kind).toBe("not-found");
  });
});

function conanRecipeWithRevision(
  rref: ReturnType<typeof newConanRecipeReference>,
  revision: string,
): ReturnType<typeof newConanRecipeReference> {
  return { ...rref, revision };
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

describe("the conan search (search.go)", () => {
  async function seedSearch(): Promise<void> {
    await put(CONAN_FILE_NAME, CONANFILE); // ConanPackage/1.2@gitea/test
    await put(CONAN_FILE_NAME, CONANFILE.replace("1.2", "1.3"), { version: "1.3" });
    await put(CONAN_FILE_NAME, CONANFILE, { channel: "final" });
    await put("conaninfo.txt", CONANINFO, { packageReference: { reference: "9f4c", revision: "r1" } });
  }

  it("parseConanRecipeQuery: the @→/ split, the * wildcards stay unfiltered", () => {
    expect(parseConanRecipeQuery("ConanPackage/1.2@gitea/test")).toEqual({
      name: "ConanPackage",
      version: "1.2",
      user: "gitea",
      channel: "test",
    });
    expect(parseConanRecipeQuery("ConanPackage")).toEqual({ name: "ConanPackage", version: "", user: "", channel: "" });
    expect(parseConanRecipeQuery("ConanPackage/*/*/*")).toEqual({ name: "ConanPackage", version: "", user: "", channel: "" });
  });

  it("SearchRecipes: the wildcard grammar over the @user/channel assembly", async () => {
    await seedSearch();
    const all = await searchConanRecipes(env.DB, ownerRow.id, "");
    expect(all.sort()).toEqual([
      "ConanPackage/1.2@gitea/final",
      "ConanPackage/1.2@gitea/test",
      "ConanPackage/1.3@gitea/test",
    ]);
    expect((await searchConanRecipes(env.DB, ownerRow.id, "ConanPackage/1.2")).sort()).toEqual([
      "ConanPackage/1.2@gitea/final",
      "ConanPackage/1.2@gitea/test",
    ]);
    expect(await searchConanRecipes(env.DB, ownerRow.id, "Conan*")).toHaveLength(3);
    expect(await searchConanRecipes(env.DB, ownerRow.id, "ConanPackage/1*@gitea/*")).toHaveLength(3);
    expect(await searchConanRecipes(env.DB, ownerRow.id, "ConanPackage/1.2@gitea/final")).toEqual([
      "ConanPackage/1.2@gitea/final",
    ]);
    expect(await searchConanRecipes(env.DB, ownerRow.id, "ConanPackage/9.9")).toEqual([]);
  });

  it("SearchPackages: {reference: conaninfo} over the resolved revision(s)", async () => {
    await seedSearch();
    // v1 (all revisions).
    const rref = newConanRecipeReference("ConanPackage", "1.2", "gitea", "test", "");
    const all = await searchConanPackages(env.DB, ownerRow.id, rref, true);
    expect(Object.keys(all ?? {})).toEqual(["9f4c"]);
    expect((all?.["9f4c"] as NonNullable<typeof all>["9f4c"]).settings).toEqual({ os: "Windows" });
    // v2 pinned.
    const pinned = conanRecipeWithRevision(rref, "0");
    const pinnedResult = await searchConanPackages(env.DB, ownerRow.id, pinned, false);
    expect(Object.keys(pinnedResult ?? {})).toEqual(["9f4c"]);
    // v2 unpinned resolves the LAST revision.
    const resolved = await searchConanPackages(env.DB, ownerRow.id, rref, false);
    expect(Object.keys(resolved ?? {})).toEqual(["9f4c"]);
    // The empty recipe is null (the 404).
    expect(
      await searchConanPackages(env.DB, ownerRow.id, newConanRecipeReference("Missing", "1.0", "gitea", "test", ""), true),
    ).toBeNull();
  });
});
