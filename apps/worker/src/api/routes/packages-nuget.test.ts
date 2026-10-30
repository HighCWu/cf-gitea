/**
 * The nuget protocol battery (SPEC-0016 §7 M5, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/nuget at the pin:
 *
 *  - the push round-trip (UploadPackage: the zip/nuspec parse, the normalized
 *    version, the lead nupkg + the nuspec side file) → 201, the V3 read
 *    family (service index, registration index/leaf with the semver order,
 *    the package-base-address enumerate + byte-parity download with the
 *    lead-file counter bump), the V3 search shapes (totalHits = PACKAGE
 *    count, the grouped data with every version);
 *  - the V2 OData feed (service index XML, the static $metadata Edmx, the
 *    namespaced Packages(Id=..) entry with the verbatim self-closing
 *    `<content/>`, the Search()/FindPackagesById()/Packages() feeds with the
 *    `$skip`/`$top` next link, the plain-text /$count arms);
 *  - the symbol package walk (ExtractPortablePdb's BSJB parse, the composite
 *    key + nuget.symbol.id property, the /symbols/{filename}/{guid}/
 *    {filename2} query protocol, the mismatch/unknown arms);
 *  - the validation arms in order: bad archive / missing-nuspec / sub-nuspec
 *    / invalid id / invalid version → 400, malformed XML → 500, the
 *    unexpected-package-type 400 on both push routes, re-push → 409,
 *    duplicate symbol file → 409 regardless of bytes, symbol push to an
 *    unknown version → 404;
 *  - auth: anonymous push → 401 + the WWW-Authenticate challenge, the
 *    X-NuGet-ApiKey fallback (auth.go:23-26), wrong-scope → 401, private
 *    owner blinds anonymous reads; quota 403 + the admin bypass; 411 without
 *    Content-Length; PACKAGES_ENABLED=false 404s the family; DELETE → 204.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageFiles, packageProperties, packageVersions, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";

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
    "personal_access_tokens",
    "auth_failures",
    "repositories",
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

// JSON access guards (the lint's no-explicit-any).
type Rec = Record<string, unknown>;
function rec(value: unknown): Rec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Rec;
}
function recs(value: unknown): Rec[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value.map(rec);
}

/** The nuget family's `{"Message": ...}` error body (nuget.go:30-35). */
function messageOf(value: unknown): string {
  const message = rec(value).Message;
  if (typeof message !== "string") throw new Error("expected a string Message body");
  return message;
}

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-10-29T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

async function token(user: SeededUser, scopes: string): Promise<string> {
  return (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

// ---------------------------------------------------------------------------
// The zip fixture — a hand-built central-directory archive (stored entries;
// method 8 entries ride CompressionStream("deflate-raw"))
// ---------------------------------------------------------------------------

const CRC32_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipFixtureEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes.slice()).body?.pipeThrough(new CompressionStream("deflate-raw"));
  if (stream === undefined) throw new Error("empty body");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]);
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

async function makeZip(entries: ZipFixtureEntry[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const method = entry.method ?? 0;
    const payload = method === 8 ? await deflateRaw(entry.data) : entry.data;
    const crc = crc32(entry.data);
    // Local file header.
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0), // flags
      u16le(method),
      u16le(0), // mod time
      u16le(0), // mod date
      u32le(crc),
      u32le(payload.byteLength), // compressed size
      u32le(entry.data.byteLength), // uncompressed size
      u16le(nameBytes.byteLength),
      u16le(0), // extra length
      nameBytes,
      payload,
    ]);
    chunks.push(local);
    // Central directory record.
    central.push(
      concatBytes([
        u32le(0x02014b50),
        u16le(20), // version made by
        u16le(20), // version needed
        u16le(0), // flags
        u16le(method),
        u16le(0), // mod time
        u16le(0), // mod date
        u32le(crc),
        u32le(payload.byteLength),
        u32le(entry.data.byteLength),
        u16le(nameBytes.byteLength),
        u16le(0), // extra
        u16le(0), // comment
        u16le(0), // disk start
        u16le(0), // internal attrs
        u32le(0), // external attrs
        u32le(offset), // local header offset
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
      u32le(0x06054b50), // EOCD
      u16le(0),
      u16le(0),
      u16le(entries.length),
      u16le(entries.length),
      u32le(centralBytes.byteLength),
      u32le(centralStart),
      u16le(0), // comment length
    ]),
  );
  return concatBytes(chunks);
}

// ---------------------------------------------------------------------------
// The nuspec fixture (upstream metadata_test.go's content, groupless +
// grouped dependency arms) and the portable-PDB fixture (BSJB + #Pdb)
// ---------------------------------------------------------------------------

interface NuspecOverrides {
  id?: string;
  version?: string;
  /** Appends a <packageTypes> block naming SymbolsPackage. */
  symbols?: boolean;
  /** Overrides the whole metadata body verbatim (malformed-XML arms). */
  body?: string;
  readme?: string;
}

function nuspecXml(overrides: NuspecOverrides = {}): string {
  if (overrides.body !== undefined) {
    return `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">${overrides.body}</package>`;
  }
  const id = overrides.id ?? "System.Gitea";
  const version = overrides.version ?? "1.0.1";
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata minClientVersion="1.0.0.0">
    <authors>Gitea Authors</authors>
    <copyright>Package Copyright</copyright>
    <description>Package Description</description>
    <developmentDependency>true</developmentDependency>
    <iconUrl>https://gitea.io/favicon.png</iconUrl>
    <id>${id}</id>
    <language>Package Language</language>
    <licenseUrl>https://gitea.io/license</licenseUrl>
    <owners>Package Owners</owners>
    <projectUrl>https://gitea.io</projectUrl>
    <readme>${overrides.readme ?? "README.md"}</readme>
    <releaseNotes>Package Release Notes</releaseNotes>
    <repository url="https://gitea.io/gitea/gitea" />
    <requireLicenseAcceptance>true</requireLicenseAcceptance>
    <tags>tag_1 tag_2 tag_3</tags>
    <title>Package Title</title>
    <version>${version}</version>
    <dependencies>
      <dependency id="System.Text.Json" version="5.0.0" exclude="Build,Analyzers" />
      <group targetFramework=".NETStandard2.1">
        <dependency id="System.Text.Json" version="5.0.0" exclude="Build,Analyzers" />
      </group>
    </dependencies>${
      overrides.symbols
        ? `
    <packageTypes>
      <packageType name="SymbolsPackage" />
    </packageTypes>`
        : ""
    }
  </metadata>
</package>`;
}

async function makeNupkg(overrides: NuspecOverrides = {}, readme = "Readme"): Promise<Uint8Array> {
  return makeZip([
    { name: "package.nuspec", data: new TextEncoder().encode(nuspecXml(overrides)) },
    { name: "README.md", data: new TextEncoder().encode(readme) },
    { name: "lib/net45/payload.bin", data: new Uint8Array([1, 2, 3, 4]) },
  ]);
}

/** The 16 GUID bytes of the fixture PDB — id "12345678abcd11220102030405060708". */
const PDB_GUID_BYTES = new Uint8Array([
  0x78, 0x56, 0x34, 0x12, 0xcd, 0xab, 0x22, 0x11, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
]);
const PDB_ID = "12345678abcd11220102030405060708";

function makePortablePdb(guidBytes: Uint8Array = PDB_GUID_BYTES): Uint8Array {
  const versionString = new TextEncoder().encode("PDB1\0\0\0\0"); // 8 bytes, explicit padding
  const head = concatBytes([
    u32le(0x424a5342), // BSJB
    u32le(1), // major version
    u32le(1), // minor version
    u32le(versionString.byteLength), // version string size
    versionString,
    u16le(0), // flags
    u16le(1), // stream count
    u32le(0), // #Pdb stream offset — patched to the computed position below
    u32le(16), // #Pdb stream size
    new TextEncoder().encode("#Pdb\0\0\0\0"),
  ]);
  // The GUID sits directly after the header — patch the offset field
  // (head.byteLength - 16 covers offset+size+name).
  const offsetAt = head.byteLength - 16;
  head.set(u32le(head.byteLength), offsetAt);
  return concatBytes([head, guidBytes]);
}

async function makeSnupkg(pdb: Uint8Array = makePortablePdb(), extra: ZipFixtureEntry[] = []): Promise<Uint8Array> {
  return makeZip([
    { name: "package.nuspec", data: new TextEncoder().encode(nuspecXml({ symbols: true })) },
    { name: "lib/net45/Debug.Gitea.pdb", data: pdb },
    ...extra,
  ]);
}

async function shaHex(algorithm: "SHA-256", bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function push(owner: string, nupkg: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return protocol()(`/api/packages/${owner}/nuget`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-length": String(nupkg.byteLength), ...headers },
    body: nupkg,
  });
}

// ---------------------------------------------------------------------------
// The round-trip: push → V3 index/registration/metadata/download → search
// ---------------------------------------------------------------------------

describe("nuget push → V3 read family", () => {
  it("round-trips a push: 201 → service index → registration → byte-parity nupkg", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const nupkg = await makeNupkg();
    const put = await push("alice", nupkg, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();

    // The stored version row: the NORMALIZED version, semver-compatible flag.
    const versionRows = await db().select().from(packageVersions).all();
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe("1.0.1");
    const metadata = rec(JSON.parse(versionRows[0]?.metadataJson as string));
    expect(metadata.authors).toBe("Gitea Authors");
    expect(metadata.description).toBe("Package Description");
    expect(metadata.development_dependency).toBe(true);
    expect(metadata.require_license_acceptance).toBe(true);
    expect(metadata.project_url).toBe("https://gitea.io");
    expect(metadata.readme).toBe("Readme"); // inlined from the archive, 1 MiB cap
    expect(metadata.min_client_version).toBe("1.0.0.0");
    expect(rec(metadata.dependencies)).toEqual({
      "": [{ id: "System.Text.Json", version: "5.0.0" }],
      ".NETStandard2.1": [{ id: "System.Text.Json", version: "5.0.0" }],
    });

    // Two files: the lead nupkg + the original nuspec bytes (lowercased).
    const fileRows = await db().select().from(packageFiles).all();
    expect(fileRows.map((row) => row.lowerName).sort()).toEqual(["system.gitea.1.0.1.nupkg", "system.gitea.nuspec"]);
    expect(fileRows.find((row) => row.lowerName === "system.gitea.1.0.1.nupkg")?.isLead).toBe(true);

    // The V3 service index (nuget.go:69-86) — the nine resources in order.
    const index = rec(await (await protocol()("/api/packages/alice/nuget/index.json")).json());
    expect(index.version).toBe("3.0.0");
    const resources = recs(index.resources);
    expect(resources).toHaveLength(9);
    expect(resources[8]).toEqual({
      "@id": "https://example.com/api/packages/alice/nuget/symbolpackage",
      "@type": "SymbolPackagePublish/4.9.0",
    });
    expect(resources[6]).toEqual({
      "@id": "https://example.com/api/packages/alice/nuget/package",
      "@type": "PackageBaseAddress/3.0.0",
    });

    // The registration index (api_v3.go:87-140) — the full catalogEntry.
    const registration = rec(
      await (await protocol()("/api/packages/alice/nuget/registration/System.Gitea/index.json")).json(),
    );
    expect(registration["@id"]).toBe("https://example.com/api/packages/alice/nuget/registration/System.Gitea/index.json");
    expect(registration["@type"]).toEqual(["catalog:CatalogRoot", "PackageRegistration", "catalog:Permalink"]);
    expect(registration.count).toBe(1);
    const pages = recs(registration.items);
    expect(pages).toHaveLength(1);
    const page = rec(pages[0]);
    expect(page.lower).toBe("1.0.1");
    expect(page.upper).toBe("1.0.1");
    expect(page.count).toBe(1);
    const items = recs(page.items);
    expect(items).toHaveLength(1);
    const item = rec(items[0]);
    expect(item["@id"]).toBe("https://example.com/api/packages/alice/nuget/registration/System.Gitea/1.0.1.json");
    expect(item.packageContent).toBe(
      "https://example.com/api/packages/alice/nuget/package/System.Gitea/1.0.1/System.Gitea.1.0.1.nupkg",
    );
    const entry = rec(item.catalogEntry);
    expect(entry["@id"]).toBe("https://example.com/api/packages/alice/nuget/registration/System.Gitea/1.0.1.json");
    expect(entry.authors).toBe("Gitea Authors");
    expect(entry.description).toBe("Package Description");
    expect(entry.iconUrl).toBe("https://gitea.io/favicon.png");
    expect(entry.id).toBe("System.Gitea");
    expect(entry.isPrerelease).toBe(false);
    expect(entry.language).toBe("Package Language");
    expect(entry.licenseUrl).toBe("https://gitea.io/license");
    expect(entry.projectUrl).toBe("https://gitea.io");
    expect(entry.requireLicenseAcceptance).toBe(true);
    expect(entry.summary).toBe("");
    expect(entry.tags).toBe("tag_1 tag_2 tag_3");
    expect(entry.version).toBe("1.0.1");
    expect(entry.releaseNotes).toBe("Package Release Notes");
    expect(entry.published).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const dependencyGroups = recs(entry.dependencyGroups);
    expect(dependencyGroups).toHaveLength(2);
    expect(recs(rec(dependencyGroups[0]).dependencies)).toEqual([{ id: "System.Text.Json", range: "5.0.0" }]);

    // The registration leaf: the .json suffix AND the bare shape.
    const leaf = rec(
      await (await protocol()("/api/packages/alice/nuget/registration/System.Gitea/1.0.1.json")).json(),
    );
    expect(leaf["@id"]).toBe("https://example.com/api/packages/alice/nuget/registration/System.Gitea/1.0.1.json");
    expect(leaf["@type"]).toEqual(["Package", "http://schema.nuget.org/catalog#Permalink"]);
    expect(leaf.registration).toBe("https://example.com/api/packages/alice/nuget/registration/System.Gitea/index.json");
    const bareLeaf = await protocol()("/api/packages/alice/nuget/registration/System.Gitea/1.0.1");
    expect(bareLeaf.status).toBe(200);
    await bareLeaf.text();

    // The package-base-address enumerate (api_v3.go:207-216).
    const enumerate = rec(await (await protocol()("/api/packages/alice/nuget/package/System.Gitea/index.json")).json());
    expect(enumerate.versions).toEqual(["1.0.1"]);

    // The nupkg download: BYTE PARITY + the attachment disposition; the
    // lead-file GET bumped the counter (packages.go:667-670).
    const get = await protocol()("/api/packages/alice/nuget/package/System.Gitea/1.0.1/System.Gitea.1.0.1.nupkg");
    expect(get.status).toBe(200);
    // The file NAME is stored lowercased (nuget.go:452's strings.ToLower) —
    // the disposition carries the stored name.
    expect(get.headers.get("content-disposition")).toContain("system.gitea.1.0.1.nupkg");
    expect(get.headers.get("content-length")).toBe(String(nupkg.byteLength));
    // The D-6 ServeContent set (the token-safe name renders bare).
    expect(get.headers.get("content-disposition")).toBe("attachment; filename=system.gitea.1.0.1.nupkg");
    expect(get.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
    expect(get.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(get.headers.get("accept-ranges")).toBe("bytes");
    const served = new Uint8Array(await get.arrayBuffer());
    expect([...served]).toEqual([...nupkg]);
    expect(await shaHex("SHA-256", served)).toBe(await shaHex("SHA-256", nupkg));
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // The nuspec download (not lead → no bump); HEAD never bumps.
    const nuspecGet = await protocol()("/api/packages/alice/nuget/package/System.Gitea/1.0.1/system.gitea.nuspec");
    expect(nuspecGet.status).toBe(200);
    await nuspecGet.arrayBuffer();
    const head = await protocol()(
      "/api/packages/alice/nuget/package/System.Gitea/1.0.1/System.Gitea.1.0.1.nupkg",
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    await head.text();
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // The 304 arm rides the same walk (If-None-Match: * matches the
    // ETag-less file). The counter bumps BEFORE serving upstream
    // (OpenBlobForDownload, packages.go:667-670), so a 304-answered GET
    // counts too — parity by construction.
    const conditional = await protocol()(
      "/api/packages/alice/nuget/package/System.Gitea/1.0.1/System.Gitea.1.0.1.nupkg",
      { headers: { "If-None-Match": "*" } },
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("content-type")).toBeNull();
    expect(conditional.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    await conditional.text();
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(2);
  });

  it("normalizes the version through hashicorp go-version (toNormalizedVersion)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const nupkg = await makeNupkg({ version: "1.04.5.2.5-rc.1+metadata" });
    const put = await push("alice", nupkg, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();

    // "1.04.5.2.5-rc.1+metadata" stores as "1.4.5.2-rc.1" — the fifth segment
    // dropped, the metadata dropped (metadata_test.go's NormalizedVersion arm).
    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.version).toBe("1.4.5.2-rc.1");
    // The nupkg FILENAME derives from the normalized version.
    const files = await db().select().from(packageFiles).all();
    expect(files.map((row) => row.lowerName)).toContain("system.gitea.1.4.5.2-rc.1.nupkg");

    const enumerate = rec(await (await protocol()("/api/packages/alice/nuget/package/System.Gitea/index.json")).json());
    expect(enumerate.versions).toEqual(["1.4.5.2-rc.1"]);
  });

  it("orders the registration index by SemVer (descriptor.go's SemVer.LessThan)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const version of ["1.1.0", "2.0.0-rc.1", "1.0.0"]) {
      const put = await push("alice", await makeNupkg({ version }), authHeaders(writer));
      expect(put.status).toBe(201);
      await put.text();
    }
    const registration = rec(
      await (await protocol()("/api/packages/alice/nuget/registration/System.Gitea/index.json")).json(),
    );
    const page = rec(recs(registration.items)[0]);
    expect(page.lower).toBe("1.0.0");
    expect(page.upper).toBe("2.0.0-rc.1");
    const versions = recs(page.items).map((item) => rec(item.catalogEntry).version);
    expect(versions).toEqual(["1.0.0", "1.1.0", "2.0.0-rc.1"]);
    // isPrerelease is the substring test (package_version.go:40-45).
    const entries = recs(page.items).map((item) => rec(item.catalogEntry).isPrerelease);
    expect(entries).toEqual([false, false, true]);
  });

  it("answers /query with the V3 search shapes (totalHits counts PACKAGES)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const [id, version] of [
      ["Alpha.Pkg", "1.0.0"],
      ["Alpha.Pkg", "1.1.0"],
      ["beta.lib", "0.1.0"],
    ] as const) {
      const put = await push("alice", await makeNupkg({ id, version }), authHeaders(writer));
      expect(put.status).toBe(201);
      await put.text();
    }
    // The unfiltered query lists every package (data grouped, name-collated).
    const search = rec(await (await protocol()("/api/packages/alice/nuget/query")).json());
    // totalHits = the PACKAGE count (nuget search.go:22-27), not versions.
    expect(search.totalHits).toBe(2);
    const data = recs(search.data);
    expect(data).toHaveLength(2);
    expect(data.map((entry) => entry.id)).toEqual(["Alpha.Pkg", "beta.lib"]);
    const first = rec(data[0]);
    expect(first.totalDownloads).toBe(0); // the counter only moves on downloads
    const versions = recs(first.versions);
    expect(versions.map((version) => version.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(versions.every((version) => version.downloads === 0)).toBe(true);
    expect(first.version).toBe("1.1.0"); // the latest by SemVer
    expect(first.registration).toBe("https://example.com/api/packages/alice/nuget/registration/Alpha.Pkg/index.json");
    // The q filter is the lower_name substring (SearchValue non-exact).
    const filtered = rec(await (await protocol()("/api/packages/alice/nuget/query?q=pkg")).json());
    expect(filtered.totalHits).toBe(1);
    expect(recs(filtered.data)[0]?.id).toBe("Alpha.Pkg");
  });
});

// ---------------------------------------------------------------------------
// The V2 OData feed
// ---------------------------------------------------------------------------

describe("nuget V2 OData feed", () => {
  it("serves the service index XML, the static $metadata, and the namespaced leaf entry", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await push("alice", await makeNupkg(), authHeaders(writer));

    // ServiceIndexV2 (nuget.go:45-66) — the atom service document.
    const serviceIndex = await protocol()("/api/packages/alice/nuget");
    expect(serviceIndex.status).toBe(200);
    expect(serviceIndex.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    const serviceXml = await serviceIndex.text();
    expect(serviceXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(serviceXml).toContain(
      '<service base="https://example.com/api/packages/alice/nuget" xmlns="http://www.w3.org/2007/app" xmlns:atom="http://www.w3.org/2005/Atom">',
    );
    expect(serviceXml).toContain('<collection href="Packages"><atom:title type="text">Packages</atom:title></collection>');
    // Go's encoder never self-closes.
    expect(serviceXml.endsWith("</service>")).toBe(true);

    // FeedCapabilityResource — the static Edmx metadata document.
    const metadata = await protocol()("/api/packages/alice/nuget/$metadata");
    expect(metadata.status).toBe(200);
    const metadataXml = await metadata.text();
    expect(metadataXml).toContain('<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">');
    expect(metadataXml).toContain('<EntityType Name="V2FeedPackage" m:HasStream="true">');
    expect(metadataXml).toContain('<Property Name="VersionDownloadCount" Type="Edm.Int64" Nullable="false"></Property>');

    // RegistrationLeafV2 — the namespaced entry with the verbatim
    // self-closing <content/> workaround (nuget.go:340-342).
    const leaf = await protocol()("/api/packages/alice/nuget/Packages(Id='System.Gitea',Version='1.0.1')");
    expect(leaf.status).toBe(200);
    const leafXml = await leaf.text();
    expect(leafXml).toContain(
      '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xml:base="https://example.com/api/packages/alice/nuget">',
    );
    expect(leafXml).toContain(
      '<content type="application/zip" src="https://example.com/api/packages/alice/nuget/package/System.Gitea/1.0.1/System.Gitea.1.0.1.nupkg"/>',
    );
    expect(leafXml).toContain("<d:Id>System.Gitea</d:Id>");
    expect(leafXml).toContain('<d:Created type="Edm.DateTime">');
    expect(leafXml).toContain("<d:NormalizedVersion>1.0.1</d:NormalizedVersion>");
    // The percent-encoded quote shape answers the same document.
    const encoded = await protocol()("/api/packages/alice/nuget/Packages(Id=%27System.Gitea%27,Version=%271.0.1%27)");
    expect(encoded.status).toBe(200);
    await encoded.text();
    // An unknown version → ErrPackageNotExist.
    const missing = await protocol()("/api/packages/alice/nuget/Packages(Id='System.Gitea',Version='9.9.9')");
    expect(missing.status).toBe(404);
    expect(messageOf(await missing.json())).toBe("package does not exist");
  });

  it("serves the feed arms with the next link, the counts, and the search filters", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const [id, version] of [
      ["Alpha.Pkg", "1.0.0"],
      ["Alpha.Pkg", "2.0.0"],
      ["beta.lib", "0.1.0"],
    ] as const) {
      const put = await push("alice", await makeNupkg({ id, version }), authHeaders(writer));
      expect(put.status).toBe(201);
      await put.text();
    }

    // Packages() — SearchServiceV2 over the latest versions (m:count = 2).
    const feed = await protocol()("/api/packages/alice/nuget/Packages()");
    expect(feed.status).toBe(200);
    const feedXml = await feed.text();
    expect(feedXml).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(feedXml).toContain("<m:count>2</m:count>");
    expect(feedXml).toContain("<title type=\"text\">Alpha.Pkg</title>");
    // No next link when the page is not full.
    expect(feedXml).not.toContain('rel="next"');

    // A filled page ($top=1) carries the next link (nuget.go:148-164) —
    // url.Values.Encode escapes $ as %24 and sorts $skip before $top.
    const paged = await protocol()("/api/packages/alice/nuget/Packages()?$top=1");
    const pagedXml = await paged.text();
    expect(pagedXml).toContain('rel="next"');
    expect(pagedXml).toContain(
      'href="https://example.com/api/packages/alice/nuget/Search()?%24skip=1&amp;%24top=1"',
    );

    // FindPackagesById() — all versions of the quoted id + the $count arm.
    const enumerated = await protocol()("/api/packages/alice/nuget/FindPackagesById()?id=%27Alpha.Pkg%27");
    const enumeratedXml = await enumerated.text();
    expect(enumeratedXml).toContain("<m:count>2</m:count>");
    expect(enumeratedXml).toContain("<d:Version>1.0.0</d:Version>");
    expect(enumeratedXml).toContain("<d:Version>2.0.0</d:Version>");
    const count = await protocol()("/api/packages/alice/nuget/FindPackagesById()/$count?id=%27Alpha.Pkg%27");
    expect((await count.text()).trim()).toBe("2");

    // Packages()/$count and the searchTerm filter.
    const packageCount = await protocol()("/api/packages/alice/nuget/Packages()/$count");
    expect((await packageCount.text()).trim()).toBe("2");
    const filtered = await protocol()("/api/packages/alice/nuget/Search()?searchTerm=beta");
    const filteredXml = await filtered.text();
    expect(filteredXml).toContain("<m:count>1</m:count>");
    expect(filteredXml).toContain("<d:Id>beta.lib</d:Id>");
    // The $filter arm: substringof → not exact; Id eq → exact.
    const filterSubstring = await protocol()(
      "/api/packages/alice/nuget/Search()?$filter=substringof('beta',tolower(Id))",
    );
    expect((await filterSubstring.text())).toContain("<m:count>1</m:count>");
    const filterExact = await protocol()("/api/packages/alice/nuget/Search()?$filter=Id eq 'Alpha.Pkg'");
    const filterExactXml = await filterExact.text();
    expect(filterExactXml).toContain("<m:count>1</m:count>");
    expect(filterExactXml).toContain("<d:Id>Alpha.Pkg</d:Id>");
  });
});

// ---------------------------------------------------------------------------
// The symbol package walk
// ---------------------------------------------------------------------------

describe("nuget symbol package", () => {
  it("pushes a snupkg onto an existing version and serves the symbol query protocol", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const nupkg = await makeNupkg();
    expect((await push("alice", nupkg, authHeaders(writer))).status).toBe(201);
    const snupkg = await makeSnupkg();
    const put = await protocol()("/api/packages/alice/nuget/symbolpackage", {
      method: "PUT",
      headers: { "content-length": String(snupkg.byteLength), ...authHeaders(writer) },
      body: snupkg,
    });
    expect(put.status).toBe(201);
    await put.text();

    // The snupkg file (IsLead false) + the pdb file with the composite key
    // and the nuget.symbol.id property (both lowercased).
    const files = await db().select().from(packageFiles).all();
    const snupkgRow = files.find((row) => row.lowerName === "system.gitea.1.0.1.snupkg");
    const pdbRow = files.find((row) => row.lowerName === "debug.gitea.pdb");
    expect(snupkgRow?.isLead).toBe(false);
    expect(pdbRow?.compositeKey).toBe("12345678abcd11220102030405060708");
    const properties = await db().select().from(packageProperties).all();
    expect(properties).toEqual([
      expect.objectContaining({
        refType: 1,
        refId: pdbRow?.id,
        name: "nuget.symbol.id",
        value: "12345678abcd11220102030405060708",
      }),
    ]);

    // The snupkg download via the package-base-address route: BYTE PARITY.
    const snupkgGet = await protocol()(
      "/api/packages/alice/nuget/package/System.Gitea/1.0.1/system.gitea.1.0.1.snupkg",
    );
    expect(snupkgGet.status).toBe(200);
    const served = new Uint8Array(await snupkgGet.arrayBuffer());
    expect([...served]).toEqual([...snupkg]);

    // The symbol query protocol (nuget.go:637-671): the guid carries 8 extra
    // f/F chars; the id is the first 32.
    const symbol = await protocol()(
      `/api/packages/alice/nuget/symbols/debug.gitea.pdb/${PDB_ID}FFFFFFFF/debug.gitea.pdb`,
    );
    expect(symbol.status).toBe(200);
    const pdbServed = new Uint8Array(await symbol.arrayBuffer());
    expect([...pdbServed]).toEqual([...makePortablePdb()]);
    // A filename mismatch → apiError(400, nil).
    const mismatch = await protocol()(
      `/api/packages/alice/nuget/symbols/debug.gitea.pdb/${PDB_ID}FFFFFFFF/other.pdb`,
    );
    expect(mismatch.status).toBe(400);
    expect(messageOf(await mismatch.json())).toBe("");
    // An unknown symbol id → apiError(404, nil).
    const unknown = await protocol()(
      "/api/packages/alice/nuget/symbols/debug.gitea.pdb/00000000abcd11220102030405060708FFFFFFFF/debug.gitea.pdb",
    );
    expect(unknown.status).toBe(404);
    expect(messageOf(await unknown.json())).toBe("");
    // A guid that fails chi's regex falls off the router → 404.
    const badShape = await protocol()(
      "/api/packages/alice/nuget/symbols/debug.gitea.pdb/not-a-guid/debug.gitea.pdb",
    );
    expect(badShape.status).toBe(404);
    expect(messageOf(await badShape.json())).toBe("");
  });

  it("rejects a snupkg without PDBs, with a foreign extension, or a broken PDB", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await push("alice", await makeNupkg(), authHeaders(writer));
    const pushSymbols = async (snupkg: Uint8Array): Promise<{ status: number; message: string }> => {
      const put = await protocol()("/api/packages/alice/nuget/symbolpackage", {
        method: "PUT",
        headers: { "content-length": String(snupkg.byteLength), ...authHeaders(writer) },
        body: snupkg,
      });
      return { status: put.status, message: messageOf(await put.json()) };
    };

    // No .pdb entry (only the skippable .nuspec) → ErrMissingPdbFiles (400).
    const noPdb = await pushSymbols(
      await makeZip([{ name: "package.nuspec", data: new TextEncoder().encode(nuspecXml({ symbols: true })) }]),
    );
    expect(noPdb.status).toBe(400);
    expect(noPdb.message).toBe("package does not contain PDB files");

    // A foreign extension → ErrInvalidFiles (400).
    const foreign = await pushSymbols(await makeSnupkg(makePortablePdb(), [{ name: "tools/init.exe", data: new Uint8Array([1]) }]));
    expect(foreign.status).toBe(400);
    expect(foreign.message).toBe("package contains invalid files");

    // A broken PDB (bad magic) → the wrapped non-InvalidArgument arm (500).
    const broken = await pushSymbols(await makeSnupkg(new Uint8Array(64)));
    expect(broken.status).toBe(500);
    expect(broken.message).toBe("internal server error");
  });

  it("409s a duplicate symbol file regardless of bytes and 404s an unknown version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await push("alice", await makeNupkg(), authHeaders(writer));
    const pushSymbols = async (snupkg: Uint8Array): Promise<{ status: number; message: string }> => {
      const put = await protocol()("/api/packages/alice/nuget/symbolpackage", {
        method: "PUT",
        headers: { "content-length": String(snupkg.byteLength), ...authHeaders(writer) },
        body: snupkg,
      });
      const body = await put.text();
      // A 201 carries no body — only error statuses carry {"Message": ...}.
      return { status: put.status, message: body === "" ? "" : messageOf(JSON.parse(body)) };
    };
    // The version 1.0.1 EXISTS here — a push with a DIFFERENT pdb id lands.
    const first = await pushSymbols(await makeSnupkg(makePortablePdb(new Uint8Array(16).fill(0xab))));
    expect(first.status).toBe(201);
    // A SECOND push with the same pdb id → TryInsertFile fails ANY duplicate
    // regardless of bytes (package_file.go:46-58) → 409.
    const duplicate = await pushSymbols(await makeSnupkg(makePortablePdb(new Uint8Array(16).fill(0xab))));
    expect(duplicate.status).toBe(409);
    expect(duplicate.message).toBe("package file already exists");
    // A different version string → ErrPackageNotExist → 404.
    const missingVersion = await pushSymbols(
      await makeZip([
        { name: "package.nuspec", data: new TextEncoder().encode(nuspecXml({ symbols: true, version: "9.9.9" })) },
        { name: "Debug.Gitea.pdb", data: makePortablePdb() },
      ]),
    );
    expect(missingVersion.status).toBe(404);
    expect(missingVersion.message).toBe("package does not exist");
  });
});

// ---------------------------------------------------------------------------
// The validation / conflict / delete arms
// ---------------------------------------------------------------------------

describe("nuget validation and delete arms", () => {
  it("400s the InvalidArgument set and 500s malformed XML in upstream's order", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pushExpect = async (nupkg: Uint8Array, status: number, message: string): Promise<void> => {
      const put = await push("alice", nupkg, authHeaders(writer));
      expect(put.status).toBe(status);
      expect(messageOf(await put.json())).toBe(message);
    };

    // Not a zip → the archive sentinel carries the reason.
    await pushExpect(new TextEncoder().encode("definitely not a zip"), 400, "unable to parse package meta: zip: not a valid zip file");
    // A zip without a root nuspec.
    await pushExpect(await makeZip([{ name: "sub/package.nuspec", data: new TextEncoder().encode(nuspecXml()) }]), 400, "Nuspec file is missing");
    // An empty nuspec → the XML decode arm (500, non-InvalidArgument).
    await pushExpect(await makeZip([{ name: "package.nuspec", data: new Uint8Array(0) }]), 500, "internal server error");
    // An invalid id / version → metadata.go's sentinels.
    await pushExpect(await makeNupkg({ body: "<metadata><id>!!bad!!</id><version>1.0.0</version></metadata>" }), 400, "Nuspec file contains an invalid id");
    await pushExpect(await makeNupkg({ body: "<metadata><id>Good.Id</id><version>not-semver</version></metadata>" }), 400, "Nuspec file contains an invalid version");
    // The package-type arms (metadata.go:187-193): a SymbolsPackage nuspec on
    // PUT / and a DependencyPackage on PUT /symbolpackage.
    await pushExpect(await makeNupkg({ symbols: true }), 400, "unexpected package type");
    const depToSymbols = await protocol()("/api/packages/alice/nuget/symbolpackage", {
      method: "PUT",
      headers: { "content-length": String((await makeNupkg()).byteLength), ...authHeaders(writer) },
      body: await makeNupkg(),
    });
    expect(depToSymbols.status).toBe(400);
    expect(messageOf(await depToSymbols.json())).toBe("unexpected package type");
  });

  it("409s a re-push and deletes versions with DELETE → 204/404", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const nupkg = await makeNupkg();
    expect((await push("alice", nupkg, authHeaders(writer))).status).toBe(201);
    // Re-push: ErrDuplicatePackageVersion wins over quota (default = unlimited).
    const again = await push("alice", nupkg, authHeaders(writer));
    expect(again.status).toBe(409);
    expect(messageOf(await again.json())).toBe("package version already exists");

    // DeletePackage (nuget.go:675-698): 204, then the package index 404s.
    const del = await protocol()("/api/packages/alice/nuget/System.Gitea/1.0.1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);
    await del.text();
    const enumerate = await protocol()("/api/packages/alice/nuget/package/System.Gitea/index.json");
    expect(enumerate.status).toBe(404);
    expect(messageOf(await enumerate.json())).toBe("");
    const unknown = await protocol()("/api/packages/alice/nuget/System.Gitea/1.0.1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(unknown.status).toBe(404);
    expect(messageOf(await unknown.json())).toBe("package does not exist");
  });
});

// ---------------------------------------------------------------------------
// Auth, quota, and the gate arms
// ---------------------------------------------------------------------------

describe("nuget auth, quota, and gates", () => {
  it("challenges anonymous/wrong-scope writes and honors X-NuGet-ApiKey", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const reader = await token(owner, "read:package");

    // Anonymous push → 401 + the WWW-Authenticate challenge (the gate's
    // plain-text body, packages-protocols.ts's packageAccessChallenge).
    const anonymous = await push("alice", await makeNupkg());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    expect(await anonymous.text()).toBe("user should have specific permission or be a site admin");

    // A read-scoped token cannot push (reqPackageAccess(write) → challenge).
    const wrongScope = await push("alice", await makeNupkg(), authHeaders(reader));
    expect(wrongScope.status).toBe(401);

    // The nuget.Auth fallback (auth.go:23-26): the API key header alone
    // authenticates the push when no Authorization header is present.
    const apiKeyPush = await push("alice", await makeNupkg(), { "X-NuGet-ApiKey": writer });
    expect(apiKeyPush.status).toBe(201);
    await apiKeyPush.text();

    // A private owner blinds anonymous reads with the challenge.
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const stealthWriter = await token(privateOwner, "write:package");
    expect((await push("stealth", await makeNupkg({ id: "Sec.Pkg" }), authHeaders(stealthWriter))).status).toBe(201);
    const blind = await protocol()("/api/packages/stealth/nuget/package/Sec.Pkg/index.json");
    expect(blind.status).toBe(401);
    expect(blind.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
  });

  it("leaves the service-index trio unauthenticated for the NuGet client (api.go:342-346, D-4)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const nupkg = await makeNupkg();
    const pushed = await push("alice", nupkg, authHeaders(writer));
    expect(pushed.status).toBe(201);
    await pushed.text();

    // All three arms answer ANONYMOUS 200 with the upstream shapes: the V2
    // service document, the V3 index JSON, the static Edmx.
    const anon = protocol();
    const v2 = await anon("/api/packages/alice/nuget");
    expect(v2.status).toBe(200);
    expect(v2.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(await v2.text()).toContain('<service base="https://example.com/api/packages/alice/nuget"');
    const v2Slash = await anon("/api/packages/alice/nuget/");
    expect(v2Slash.status).toBe(200);
    await v2Slash.text();

    const v3 = await anon("/api/packages/alice/nuget/index.json");
    expect(v3.status).toBe(200);
    const index = rec(await v3.json());
    expect(index.version).toBe("3.0.0");
    expect(recs(index.resources)).toHaveLength(9);

    const metadata = await anon("/api/packages/alice/nuget/$metadata");
    expect(metadata.status).toBe(200);
    expect(await metadata.text()).toContain("<edmx:Edmx");

    // The drift's core: a PRIVATE owner's index also answers anonymous —
    // upstream's UserAssignmentWeb 404s only an unknown username and no
    // reqPackageAccess wraps this group, so nothing gates the index.
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const stealthWriter = await token(privateOwner, "write:package");
    const stealthPush = await push("stealth", nupkg, authHeaders(stealthWriter));
    expect(stealthPush.status).toBe(201);
    await stealthPush.text();
    for (const path of ["/api/packages/stealth/nuget", "/api/packages/stealth/nuget/index.json", "/api/packages/stealth/nuget/$metadata"]) {
      const res = await anon(path);
      expect(res.status).toBe(200);
      await res.text();
    }

    // PACKAGES_ENABLED=false still 404s the trio (the family posture).
    const disabled = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/nuget/index.json");
    expect(disabled.status).toBe(404);
    await disabled.text();
  });

  it("403s quota with the admin bypass (the one-transaction posture: no rows land)", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminToken = await token(admin, "write:package");
    const nupkg = await makeNupkg();

    // Owner total size quota (upstream ErrQuotaTotalSize → 403).
    const sizeDenied = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "128" })("/api/packages/alice/nuget", {
      method: "PUT",
      headers: { "content-length": String(nupkg.byteLength), ...authHeaders(writer) },
      body: nupkg,
    });
    expect(sizeDenied.status).toBe(403);
    expect(messageOf(await sizeDenied.json())).toBe("maximum allowed package storage quota exceeded");
    // No rows landed (upstream wraps the walk in one transaction).
    expect((await db().select().from(packageVersions).all())).toHaveLength(0);

    // Owner count quota (upstream ErrQuotaTotalCount → 403).
    const countDenied = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "0" })("/api/packages/alice/nuget", {
      method: "PUT",
      headers: { "content-length": String(nupkg.byteLength), ...authHeaders(writer) },
      body: nupkg,
    });
    expect(countDenied.status).toBe(403);
    expect(messageOf(await countDenied.json())).toBe("maximum allowed package count exceeded");

    // Admins bypass both (packages.go:391-393).
    const bypass = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "128", PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "0" })(
      "/api/packages/alice/nuget",
      {
        method: "PUT",
        headers: { "content-length": String(nupkg.byteLength), ...authHeaders(adminToken) },
        body: nupkg,
      },
    );
    expect(bypass.status).toBe(201);
    await bypass.text();
  });

  it("a chunked body streams; non-zip bytes answer 400 (D-2) and the family 404s when disabled", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("bytes"));
        controller.close();
      },
    });
    const noLength = await protocol()("/api/packages/alice/nuget", {
      method: "PUT",
      headers: authHeaders(writer),
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing
      duplex: "half",
    });
    // D-2: the spool streamed the body (no 411); "bytes" is not a zip so
    // the package reader's 400 is the terminal answer.
    expect(noLength.status).toBe(400);
    expect(messageOf(await noLength.json())).toMatch(/package|zip/i);

    // The strict-polarity PACKAGES_ENABLED arm (only "false" disables).
    const disabled = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/nuget/index.json");
    expect(disabled.status).toBe(404);
    await disabled.text();
    const enabled = await protocol({ PACKAGES_ENABLED: "true" })("/api/packages/alice/nuget/index.json");
    expect(enabled.status).toBe(200);
    await enabled.text();
  });
});
