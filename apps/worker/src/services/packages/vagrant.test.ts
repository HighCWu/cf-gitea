/**
 * The Vagrant box protocol battery (SPEC-0016 §7 long tail) on real D1 + the
 * real REPO_PACKS binding — upstream routers/api/packages/vagrant/vagrant.go +
 * modules/packages/vagrant/metadata.go at the pin, through the SERVICE face
 * (the container.test.ts service-level precedent; the route arms ride the
 * packages-protocols unit):
 *
 *  - ParseMetadataFromBox: the missing-info.json arm (the ZERO metadata, no
 *    error — metadata.go:48), the info.json key walk (case-insensitive, the
 *    URL validation arms, description/author/short-description/website/
 *    repository splits), the corrupt-gzip/tar/JSON arms (the plain-error
 *    500 class), the tar early-return (a member AFTER info.json never
 *    parsed);
 *  - the upload gates (NewSemver → VagrantInvalidVersionError, the ".box"
 *    suffix → VagrantInvalidProviderError, both BEFORE any D1 write);
 *  - the round-trip: a real tar.gz box → the D1 rows (the path NAME as the
 *    package name, the SemVer-marked version, the ONE lead file lowercased,
 *    the `vagrant.provider` property with original case minus ".box"), the
 *    enumerate shape (providers array, sha512 checksum, "active" status,
 *    the newest version's description, the SemVer sort — 1.0.2 BEFORE
 *    1.0.10), the byte-parity download with the GET-only counter bump, the
 *    always-409 duplicate (and NO duplicate property row), the chunked
 *    (no-Content-Length) upload arm, quota 403s with the admin bypass.
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
  VAGRANT_PROPERTY_PROVIDER,
  VagrantBoxFormatError,
  VagrantInvalidProviderError,
  VagrantInvalidVersionError,
  enumerateVagrantBox,
  isVagrantProviderNameValid,
  openVagrantBoxForDownload,
  parseVagrantBoxMetadata,
  parseVagrantSemver,
  uploadVagrantBox,
  vagrantBoxExists,
} from "./vagrant";
import type { UploadVagrantBoxInput } from "./vagrant";

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
// The .box builder — a real tar.gz (the upstream integration test's shape:
// an `info.json` member plus padding files).
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function tarEntry(name: string, content: string): TarEntry {
  return { name, mode: 0o600, data: encoder.encode(content) };
}

async function buildBox(members: TarEntry[]): Promise<Uint8Array> {
  return gzipCompress(buildTar(members, true));
}

const INFO_JSON = JSON.stringify({
  description: "Test Description",
  short_description: "Ignored (description wins the later-key walk)",
  author: "KN4CK3R",
  website: "https://gitea.io",
  repository: "https://gitea.io/gitea/gitea",
});

async function makeVagrantBox(infoJson: string | null, extra: TarEntry[] = []): Promise<Uint8Array> {
  const members = extra.slice();
  if (infoJson !== null) members.push(tarEntry("info.json", infoJson));
  return buildBox(members);
}

function sha512Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-512", bytes as unknown as ArrayBuffer).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  );
}

/** The service call with the standard owner/doer/quota wiring. */
function upload(
  owner: { id: number },
  doerId: number,
  overrides: Partial<UploadVagrantBoxInput> & { content: ReadableStream<Uint8Array> },
): Promise<unknown> {
  return uploadVagrantBox({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: { id: owner.id, type: "user", visibility: "public" },
    doer: { id: doerId, isAdmin: false },
    name: "test_package",
    version: "1.0.1",
    provider: "virtualbox.box",
    declaredLength: undefined,
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  });
}

const OWNER = "vagrantowner";
const DOER = "vagranted";
let ownerRow: { id: number; username: string };
let doerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser(OWNER);
  doerRow = await seedUser(DOER);
});

// ---------------------------------------------------------------------------
// ParseMetadataFromBox — the metadata.go arms
// ---------------------------------------------------------------------------

describe("parseVagrantBoxMetadata (metadata.go)", () => {
  it("a box WITHOUT info.json is the ZERO metadata, no error (metadata.go:48)", async () => {
    const box = await makeVagrantBox(null, [tarEntry("dummy.txt", "")]);
    expect(await parseVagrantBoxMetadata(box)).toEqual({
      author: "",
      description: "",
      project_url: "",
      repository_url: "",
    });
  });

  it("the info.json key walk: description/author/website/repository (case-insensitive keys)", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    expect(await parseVagrantBoxMetadata(box)).toEqual({
      author: "KN4CK3R",
      description: "Ignored (description wins the later-key walk)",
      project_url: "https://gitea.io",
      repository_url: "https://gitea.io/gitea/gitea",
    });
  });

  it("an invalid URL candidate is dropped (validation.IsValidURL); DESCRIPTION/SHORT_DESCRIPTION overwrite", async () => {
    const box = await makeVagrantBox(
      JSON.stringify({
        DESCRIPTION: "the winner",
        short_description: "the loser",
        WEBSITE: "not a url",
        homepage: "ftp://nope",
        AUTHORS: "Gitea Authors",
      }),
    );
    expect(await parseVagrantBoxMetadata(box)).toEqual({
      author: "Gitea Authors",
      description: "the loser",
      project_url: "",
      repository_url: "",
    });
  });

  it("info.json parses EARLY — a member after it is never read (a corrupt tail cannot fail the walk)", async () => {
    const good = await makeVagrantBox(INFO_JSON);
    // Append garbage INSIDE the tar: an entry with a lying (huge) size after
    // info.json would break a full walk — the early-return never reads it.
    const members: TarEntry[] = [tarEntry("info.json", INFO_JSON)];
    const tar = buildTar(members, false);
    const junk = encoder.encode("\0junk-not-a-real-member");
    const patched = new Uint8Array(tar.byteLength + junk.byteLength);
    patched.set(tar, 0);
    patched.set(junk, tar.byteLength);
    const box = await gzipCompress(patched);
    const parsed = await parseVagrantBoxMetadata(box);
    expect(parsed.description).toBe("Ignored (description wins the later-key walk)");
    void good;
  });

  it("corrupt inputs are the plain-error class (gzip magic, truncated tar, bad JSON, JSON array)", async () => {
    await expect(parseVagrantBoxMetadata(encoder.encode("definitely not gzip"))).rejects.toBeInstanceOf(
      VagrantBoxFormatError,
    );
    await expect(parseVagrantBoxMetadata(new Uint8Array(8))).rejects.toBeInstanceOf(VagrantBoxFormatError);
    const badJson = await makeVagrantBox("{not json");
    await expect(parseVagrantBoxMetadata(badJson)).rejects.toBeInstanceOf(VagrantBoxFormatError);
    const arrayJson = await makeVagrantBox("[1,2]");
    await expect(parseVagrantBoxMetadata(arrayJson)).rejects.toBeInstanceOf(VagrantBoxFormatError);
  });
});

// ---------------------------------------------------------------------------
// The upload gates + round-trip
// ---------------------------------------------------------------------------

describe("uploadVagrantBox (vagrant.go:97-171)", () => {
  it("the version gate fires BEFORE any D1 write (vagrant.go:104-108)", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    await expect(
      upload(ownerRow, doerRow.id, { content: new Response(box.slice()).body as ReadableStream<Uint8Array>, version: "not-semver" }),
    ).rejects.toBeInstanceOf(VagrantInvalidVersionError);
    const rows = await db().select().from(packages).all();
    expect(rows).toHaveLength(0);
    // The parseVagrantSemver arm IS the go-version NewSemver gate.
    expect(parseVagrantSemver("1.0.1")).not.toBeNull();
    expect(parseVagrantSemver("1.0.1-alpha.1+meta")).not.toBeNull();
    expect(parseVagrantSemver("1.0.1-")).toBeNull();
  });

  it("the provider gate fires BEFORE any D1 write (vagrant.go:110-113)", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    await expect(
      upload(ownerRow, doerRow.id, {
        content: new Response(box.slice()).body as ReadableStream<Uint8Array>,
        provider: "virtualbox",
      }),
    ).rejects.toBeInstanceOf(VagrantInvalidProviderError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
    expect(isVagrantProviderNameValid("virtualbox.box")).toBe(true);
    expect(isVagrantProviderNameValid("virtualbox")).toBe(false);
  });

  it("the round-trip: the D1 rows, the enumerate shape, the byte-parity download + the GET-only bump", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const result = (await upload(ownerRow, doerRow.id, {
      content: new Response(box.slice()).body as ReadableStream<Uint8Array>,
    })) as Awaited<ReturnType<typeof uploadVagrantBox>>;

    // The package row: the PATH name, type vagrant, SemVer-marked.
    const pkgs = await db().select().from(packages).all();
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.name).toBe("test_package");
    expect(pkgs[0]?.type).toBe("vagrant");
    expect(pkgs[0]?.semverCompatible).toBe(true);

    // The version row carries the box metadata.
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]?.metadataJson ?? "{}")).toEqual({
      author: "KN4CK3R",
      description: "Ignored (description wins the later-key walk)",
      project_url: "https://gitea.io",
      repository_url: "https://gitea.io/gitea/gitea",
    });

    // The ONE lead file: the provider lowercased.
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("virtualbox.box");
    expect(files[0]?.isLead).toBe(true);
    expect(result.file.id).toBe(files[0]?.id);

    // The provider property: original case minus ".box".
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, files[0]?.id ?? 0))
      .all();
    expect(props).toHaveLength(1);
    expect(props[0]?.name).toBe(VAGRANT_PROPERTY_PROVIDER);
    expect(props[0]?.value).toBe("virtualbox");

    // Enumerate: the providers array with the sha512 checksum.
    const enumerate = await enumerateVagrantBox(env.DB, { id: ownerRow.id, type: "user", visibility: "public" }, "test_package", "https://example.com/api/packages/vagrantowner/vagrant/test_package");
    expect(enumerate).not.toBeNull();
    expect(enumerate?.name).toBe("test_package");
    expect(enumerate?.description).toBe("Ignored (description wins the later-key walk)");
    expect(enumerate?.versions).toHaveLength(1);
    const version = enumerate?.versions[0];
    expect(version?.version).toBe("1.0.1");
    expect(version?.status).toBe("active");
    expect(version?.providers).toHaveLength(1);
    expect(version?.providers[0]?.name).toBe("virtualbox");
    expect(version?.providers[0]?.checksum).toBe(await sha512Hex(box));
    expect(version?.providers[0]?.checksum_type).toBe("sha512");
    expect(version?.providers[0]?.url).toBe(
      "https://example.com/api/packages/vagrantowner/vagrant/test_package/1.0.1/virtualbox.box",
    );

    // Download: byte parity, then the GET bump (HEAD never counts).
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const first = await openVagrantBoxForDownload(env.DB, env.REPO_PACKS, owner, "test_package", "1.0.1", "virtualbox.box", "GET");
    expect(first).not.toBeNull();
    const served = new Uint8Array(await new Response(first?.stream as ReadableStream).arrayBuffer());
    expect(served).toEqual(box);
    expect(first?.size).toBe(box.byteLength);
    const afterGet = (await db().select().from(packageVersions).all())[0]?.downloadCount;
    expect(afterGet).toBe(1);

    await openVagrantBoxForDownload(env.DB, env.REPO_PACKS, owner, "test_package", "1.0.1", "virtualbox.box", "HEAD");
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // The miss arms.
    expect(await openVagrantBoxForDownload(env.DB, env.REPO_PACKS, owner, "test_package", "9.9.9", "virtualbox.box", "GET")).toBeNull();
    expect(await openVagrantBoxForDownload(env.DB, env.REPO_PACKS, owner, "test_package", "1.0.1", "vmware.box", "GET")).toBeNull();
  });

  it("a re-upload of the SAME file is the 409 duplicate, and NO duplicate property row lands", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const stream = (): ReadableStream<Uint8Array> => new Response(box.slice()).body as ReadableStream<Uint8Array>;
    await upload(ownerRow, doerRow.id, { content: stream() });
    await expect(upload(ownerRow, doerRow.id, { content: stream() })).rejects.toBeInstanceOf(DuplicatePackageFileError);
    const files = await db().select().from(packageFiles).all();
    expect(files).toHaveLength(1);
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, files[0]?.id ?? 0))
      .all();
    expect(props).toHaveLength(1);
  });

  it("a SECOND provider on the SAME version rides the existing version (metadata kept) as its own file", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const stream = (): ReadableStream<Uint8Array> => new Response(box.slice()).body as ReadableStream<Uint8Array>;
    await upload(ownerRow, doerRow.id, { content: stream() });
    const second = (await upload(ownerRow, doerRow.id, {
      content: stream(),
      provider: "vmware_desktop.box",
    })) as Awaited<ReturnType<typeof uploadVagrantBox>>;
    expect(second.file.name).toBe("vmware_desktop.box");
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    const enumerate = await enumerateVagrantBox(env.DB, { id: ownerRow.id, type: "user", visibility: "public" }, "test_package", "https://x/api/packages/u/vagrant/test_package");
    expect(enumerate?.versions[0]?.providers).toHaveLength(2);
  });

  it("the SemVer enumerate sort: 1.0.2 BEFORE 1.0.10 (not the string order)", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const stream = (): ReadableStream<Uint8Array> => new Response(box.slice()).body as ReadableStream<Uint8Array>;
    await upload(ownerRow, doerRow.id, { content: stream(), version: "1.0.10" });
    await upload(ownerRow, doerRow.id, { content: stream(), version: "1.0.2" });
    const enumerate = await enumerateVagrantBox(env.DB, { id: ownerRow.id, type: "user", visibility: "public" }, "test_package", "https://x/v");
    expect(enumerate?.versions.map((entry) => entry.version)).toEqual(["1.0.2", "1.0.10"]);
  });

  it("the enumerate miss (no versions) and the box-exists probe", async () => {
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    expect(await enumerateVagrantBox(env.DB, owner, "missing", "https://x")).toBeNull();
    expect(await vagrantBoxExists(env.DB, owner, "missing")).toBe(false);
    const box = await makeVagrantBox(null);
    await upload(ownerRow, doerRow.id, { content: new Response(box.slice()).body as ReadableStream<Uint8Array> });
    expect(await vagrantBoxExists(env.DB, owner, "test_package")).toBe(true);
  });

  it("a chunked (no-Content-Length) upload rides the bounded MPU spool arm", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const result = (await upload(ownerRow, doerRow.id, {
      content: new Response(box.slice()).body as ReadableStream<Uint8Array>,
      declaredLength: undefined,
    })) as Awaited<ReturnType<typeof uploadVagrantBox>>;
    expect(result.blob.size).toBe(box.byteLength);
    const download = await openVagrantBoxForDownload(
      env.DB,
      env.REPO_PACKS,
      { id: ownerRow.id, type: "user", visibility: "public" },
      "test_package",
      "1.0.1",
      "virtualbox.box",
      "GET",
    );
    expect(download?.size).toBe(box.byteLength);
  });

  it("the quota arms: count 403 (the +1 boundary), size 403, the admin bypass", async () => {
    const box = await makeVagrantBox(INFO_JSON);
    const stream = (): ReadableStream<Uint8Array> => new Response(box.slice()).body as ReadableStream<Uint8Array>;
    // COUNT: an owner at limit-1 publishes the version that REACHES the cap
    // but not one past (the pypi posture).
    const atCap = {
      d1: env.DB,
      bucket: env.REPO_PACKS,
      owner: { id: ownerRow.id, type: "user", visibility: "public" },
      doer: { id: doerRow.id, isAdmin: false },
      name: "test_package",
      version: "1.0.1",
      provider: "virtualbox.box",
      content: stream(),
      declaredLength: undefined,
      quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
    } as UploadVagrantBoxInput;
    await uploadVagrantBox(atCap);
    await expect(
      uploadVagrantBox({ ...atCap, version: "1.0.2", content: stream() }),
    ).rejects.toBeInstanceOf(QuotaTotalCountError);

    // SIZE: the per-type cap (only the generic entry exists — the box bytes
    // charged whole).
    await expect(
      uploadVagrantBox({
        ...atCap,
        owner: { id: ownerRow.id, type: "user", visibility: "public" },
        content: stream(),
        quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: box.byteLength - 1, limitSizeGeneric: -1, packagesEnabled: true },
      }),
    ).rejects.toBeInstanceOf(QuotaTotalSizeError);

    // The admin bypass: over both caps, still created.
    await uploadVagrantBox({
      ...atCap,
      doer: { id: doerRow.id, isAdmin: true },
      version: "2.0.0",
      content: stream(),
      quota: { limitTotalOwnerCount: 1, limitTotalOwnerSize: 1, limitSizeGeneric: 1, packagesEnabled: true },
    });
    expect(await db().select().from(packageVersions).all()).toHaveLength(2);
  });
});
