/**
 * The Swift package registry battery (SPEC-0016 §2.1's long-tail `swift`
 * row) on real D1 + the real REPO_PACKS binding — upstream
 * routers/api/packages/swift/swift.go + modules/packages/swift/metadata.go at
 * the pin, with tests/integration/api_packages_swift_test.go as the
 * client-shape oracle:
 *
 *  - the login probe pair (401 Problem for anonymous, the bare 200 with NO
 *    Content-Version for any valid credential — the unauthenticated group);
 *  - the Accept media-type contract (a present-but-different Accept answers
 *    the 400 Problem on every read shape + the PUT);
 *  - the upload round-trip (multipart file part + metadata JSON → 201, the
 *    `scope.name` package + package properties + repository_url version
 *    properties + the lead `{name}-{version}.zip`; byte-parity download with
 *    the Digest header + the counter bump; the always-409 re-publish);
 *  - the metadata/manifest/enumerate/identifiers wire shapes (the 303
 *    manifest redirect on a swift-version miss, the TrimmedVersionString
 *    query normalization, the SemVer-sorted releases + the Link header);
 *  - the error taxonomy (the 400 InvalidArgument sentinels, the chi router
 *    page for unmatched shapes AFTER the gate, the auth challenges, the
 *    quota arms, PACKAGES_ENABLED=false).
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageProperties, packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter, parseSwiftTarget } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import {
  SWIFT_ACCEPT_JSON,
  SWIFT_ACCEPT_SWIFT,
  SWIFT_ACCEPT_ZIP,
  uploadSwiftPackage,
} from "../../services/packages/swift";

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

interface SeededUser {
  id: number;
  username: string;
  usernameLower: string;
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
      createdAt: new Date("2026-10-31T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, usernameLower: user.usernameLower, isAdmin: user.isAdmin };
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
// The zip builder (stored entries) + the multipart builder — hand-built
// fixtures (no swift toolchain locally, the rpm/arch unit pattern)
// ---------------------------------------------------------------------------

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

function makeSwiftZip(entries: { name: string; content: string }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const payload = new TextEncoder().encode(entry.content);
    const crc = crc32(payload);
    const local = concatBytes([
      u32le(0x04034b50),
      u16le(20),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(payload.byteLength),
      u32le(payload.byteLength),
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
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(crc),
        u32le(payload.byteLength),
        u32le(payload.byteLength),
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

const MANIFEST_1 = "// swift-tools-version:5.7\n//\n//  Package.swift";
const MANIFEST_2 = "// swift-tools-version:5.6\n//\n//  Package@swift-5.6.swift";
const SCOPE = "test-scope";
const NAME = "test_package";
const PACKAGE_ID = "test-scope.test_package";
const REPO_URL_1 = "https://gitea.io/gitea/repo";
const REPO_URLS = [REPO_URL_1, "https://gitea.io/gitea/repo.git", "ssh://git@gitea.io/gitea/repo.git"];

function metadataJson(version: string): string {
  return `{"name":"${NAME}","version":"${version}","description":"Gitea Test Package","codeRepository":"https://gitea.io/gitea/gitea","licenseURL":"https://opensource.org/license/mit","author":{"givenName":"KN4CK3R"},"repositoryURLs":["${REPO_URLS.join('","')}"]}`;
}

interface MultipartPartSpec {
  name: string;
  filename?: string;
  body: Uint8Array | string;
}

function makeMultipart(parts: MultipartPartSpec[]): { body: Uint8Array; contentType: string } {
  const boundary = "swift-test-boundary";
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` + (part.filename !== undefined ? `; filename="${part.filename}"` : "");
    const body = typeof part.body === "string" ? new TextEncoder().encode(part.body) : part.body;
    chunks.push(new TextEncoder().encode(`--${boundary}\r\n${disposition}\r\n\r\n`));
    chunks.push(body);
    chunks.push(new TextEncoder().encode("\r\n"));
  }
  chunks.push(new TextEncoder().encode(`--${boundary}--\r\n`));
  return { body: concatBytes(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function uploadSwift(
  owner: string,
  scope: string,
  name: string,
  version: string,
  parts: MultipartPartSpec[],
  auth?: Record<string, string>,
  accept?: string,
): Promise<Response> {
  const form = makeMultipart(parts);
  const headers: Record<string, string> = { "content-type": form.contentType, ...(auth ?? {}) };
  if (accept !== undefined) headers.Accept = accept;
  return protocol()(`/api/packages/${owner}/swift/${scope}/${name}/${version}`, {
    method: "PUT",
    headers,
    body: form.body.slice(),
  });
}

function sourceArchiveParts(
  version: string,
  opts: { manifests?: { name: string; content: string }[]; metadata?: string } = {},
): MultipartPartSpec[] {
  const manifests = opts.manifests ?? [
    { name: "Package.swift", content: MANIFEST_1 },
    { name: "Package@swift-5.6.swift", content: MANIFEST_2 },
  ];
  const zip = makeSwiftZip(manifests);
  const parts: MultipartPartSpec[] = [{ name: "source-archive", filename: "source-archive.zip", body: zip }];
  if (opts.metadata !== undefined) {
    parts.push({ name: "metadata", body: opts.metadata });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// The login probe pair (CheckAuthenticate)
// ---------------------------------------------------------------------------

describe("swift CheckAuthenticate", () => {
  it("anonymous → 401 Problem; any valid credential → bare 200 (NO Content-Version)", async () => {
    await seedUser("alice");
    const writer = await token(await seedUser("bob"), "read:repository"); // any scope passes

    const anon = await protocol()("/api/packages/alice/swift", { method: "POST", body: "" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("content-type")).toBe("application/problem+json");
    expect(anon.headers.get("content-version")).toBe("1");
    expect(await anon.json()).toEqual({ status: 401, detail: "" });

    const authed = await protocol()("/api/packages/alice/swift", {
      method: "POST",
      headers: authHeaders(writer),
      body: "",
    });
    expect(authed.status).toBe(200);
    expect(authed.headers.get("content-version")).toBeNull();

    const anonLogin = await protocol()("/api/packages/alice/swift/login", { method: "POST", body: "" });
    expect(anonLogin.status).toBe(401);
    const authedLogin = await protocol()("/api/packages/alice/swift/login", {
      method: "POST",
      headers: authHeaders(writer),
      body: "",
    });
    expect(authedLogin.status).toBe(200);
    expect(authedLogin.headers.get("content-version")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Accept media-type contract (CheckAcceptMediaType)
// ---------------------------------------------------------------------------

describe("swift CheckAcceptMediaType", () => {
  it("a present-but-different Accept answers the 400 Problem on every shape", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const shapes = [
      "/api/packages/alice/swift/scope/package",
      "/api/packages/alice/swift/scope/package.json",
      "/api/packages/alice/swift/scope/package/1.0.0",
      "/api/packages/alice/swift/scope/package/1.0.0.json",
      "/api/packages/alice/swift/scope/package/1.0.0.zip",
      "/api/packages/alice/swift/scope/package/1.0.0/Package.swift",
      "/api/packages/alice/swift/identifiers",
    ];
    for (const path of shapes) {
      const res = await protocol()(path, { headers: { Accept: "application/unknown" } });
      expect(res.status, path).toBe(400);
      expect(res.headers.get("content-version"), path).toBe("1");
      expect(res.headers.get("content-type"), path).toBe("application/problem+json");
      expect(await res.text(), path).toBe(
        `{"status":400,"detail":"Unexpected accept header. Should be '${path.endsWith("Package.swift") ? SWIFT_ACCEPT_SWIFT : path.endsWith(".zip") ? SWIFT_ACCEPT_ZIP : SWIFT_ACCEPT_JSON}'."}\n`,
      );
    }

    const badUpload = await uploadSwift("alice", "scope", "package", "1.0.0", sourceArchiveParts("1.0.0"), authHeaders(writer), "application/unknown");
    expect(badUpload.status).toBe(400);
    expect(badUpload.headers.get("content-version")).toBe("1");
    expect(badUpload.headers.get("content-type")).toBe("application/problem+json");
    await badUpload.text();
  });
});

// ---------------------------------------------------------------------------
// The upload round-trip
// ---------------------------------------------------------------------------

describe("swift upload → metadata/download/manifest round-trip", () => {
  it("uploads: 201, the properties + metadata JSON + lead file; re-publish 409", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zipParts = sourceArchiveParts("1.0.3", { metadata: metadataJson("1.0.3") });
    const put = await uploadSwift("alice", SCOPE, NAME, "1.0.3", zipParts, authHeaders(writer));
    expect(put.status).toBe(201);
    expect(put.headers.get("content-version")).toBe("1");
    await put.arrayBuffer();

    const pkg = (await db().select().from(packages).where(eq(packages.type, "swift")).all())[0];
    expect(pkg?.name).toBe(PACKAGE_ID);
    expect(pkg?.lowerName).toBe(PACKAGE_ID);
    expect(pkg?.semverCompatible).toBe(true);

    const version = (await db().select().from(packageVersions).all())[0];
    expect(version?.version).toBe("1.0.3");

    const properties = await db().select().from(packageProperties).all();
    const packageProps = properties.filter((property) => property.refType === 2);
    expect(packageProps.map((property) => [property.name, property.value])).toEqual([
      ["swift.scope", SCOPE],
      ["swift.name", NAME],
    ]);
    const versionProps = properties.filter((property) => property.refType === 0);
    expect(versionProps).toHaveLength(REPO_URLS.length);
    expect(versionProps[0]?.name).toBe("swift.repository_url");
    expect(versionProps[0]?.value).toBe(REPO_URL_1);

    const metadata = JSON.parse(version?.metadataJson ?? "{}") as {
      description: string;
      author: { name: string };
      manifests: Record<string, { content: string; tools_version: string }>;
    };
    expect(metadata.description).toBe("Gitea Test Package");
    expect(metadata.author.name).toBe("KN4CK3R");
    expect(Object.keys(metadata.manifests).sort()).toEqual(["", "5.6"]);
    expect(metadata.manifests[""]?.content).toBe(MANIFEST_1);
    expect(metadata.manifests[""]?.tools_version).toBe("5.7");
    expect(metadata.manifests["5.6"]?.tools_version).toBe("5.6");

    // Re-publish → 409 ALWAYS (ErrDuplicatePackageVersion).
    const conflict = await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.3",
      sourceArchiveParts("1.0.3", { manifests: [{ name: "Package.swift", content: MANIFEST_1 }], metadata: "" }),
      authHeaders(writer),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ status: 409, detail: "package version already exists" });
    expect((await db().select().from(packageVersions).all())).toHaveLength(1);
    // The failed re-publish must not double any property row.
    expect((await db().select().from(packageProperties).all())).toHaveLength(properties.length);
  });

  it("a VALUE-part source-archive uploads too (the FormValue fallback); the prerelease version is kept", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zip = makeSwiftZip([
      { name: "Package.swift", content: MANIFEST_1 },
      { name: "Package@swift-5.6.swift", content: MANIFEST_2 },
    ]);
    const put = await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.4-beta.1",
      [
        { name: "source-archive", body: zip }, // a plain VALUE part (no filename)
        { name: "metadata", body: metadataJson("1.0.4-beta.1") },
      ],
      authHeaders(writer),
    );
    expect(put.status).toBe(201);
    await put.arrayBuffer();
    const version = (await db().select().from(packageVersions).all())[0];
    expect(version?.version).toBe("1.0.4-beta.1"); // the FULL version kept
  });

  it("the bad shape triples answer 400 (bad scope / bad name / bad version)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // scope with underscore — scopePattern forbids it
    const badScope = await uploadSwift("alice", "sc_ope", "package", "1.0.0", [], authHeaders(writer));
    expect(badScope.status).toBe(400);
    expect(badScope.headers.get("content-version")).toBe("1");
    expect(await badScope.json()).toEqual({ status: 400, detail: "" });
    // name with tilde — namePattern forbids it
    const badName = await uploadSwift("alice", "scope", "pack~age", "1.0.0", [], authHeaders(writer));
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({ status: 400, detail: "" });
    // version "1_0.0" — NewSemver fails; the detail IS the go-version error
    const badVersion = await uploadSwift("alice", "scope", "package", "1_0.0", [], authHeaders(writer));
    expect(badVersion.status).toBe(400);
    expect(await badVersion.json()).toEqual({ status: 400, detail: "malformed version: 1_0.0" });
    // the semver prerelease separator rule: "1.0.6-" is NewSemver-invalid
    const dashVersion = await uploadSwift("alice", "scope", "package", "1.0.6-", [], authHeaders(writer));
    expect(dashVersion.status).toBe(400);
    expect(await dashVersion.json()).toEqual({ status: 400, detail: "malformed version: 1.0.6-" });
    expect((await db().select().from(packages).all())).toHaveLength(0);
  });

  it("a missing source-archive part → 400 'unable to read source-archive file'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadSwift("alice", SCOPE, NAME, "1.0.0", [{ name: "metadata", body: "{}" }], authHeaders(writer));
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ status: 400, detail: "unable to read source-archive file" });
  });

  it("a manifest-less archive → 400 'Package.swift file is missing'; a corrupt archive → 500", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const noManifest = await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.0",
      [{ name: "source-archive", filename: "source-archive.zip", body: makeSwiftZip([{ name: "dummy.txt", content: "" }]) }],
      authHeaders(writer),
    );
    expect(noManifest.status).toBe(400);
    expect(await noManifest.json()).toEqual({ status: 400, detail: "Package.swift file is missing" });

    const corrupt = await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.1",
      [{ name: "source-archive", filename: "source-archive.zip", body: new TextEncoder().encode("not a zip") }],
      authHeaders(writer),
    );
    expect(corrupt.status).toBe(500);
    expect(await corrupt.json()).toEqual({ status: 500, detail: "internal server error" });
    expect((await db().select().from(packages).all())).toHaveLength(0);
  });

  it("the download arm: byte parity, application/zip, the Digest header, the lead GET bump", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zipParts = sourceArchiveParts("1.0.3", { metadata: metadataJson("1.0.3") });
    await uploadSwift("alice", SCOPE, NAME, "1.0.3", zipParts, authHeaders(writer));
    const zip = (zipParts[0]?.body as Uint8Array).slice();

    const res = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3.zip`, {
      headers: { Accept: SWIFT_ACCEPT_ZIP },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename=${NAME}-1.0.3.zip`);
    expect(res.headers.get("digest")).toBe(`sha256=${await sha256Hex(zip)}`);
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(zip));
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // HEAD serves headers, never counts.
    const head = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3.zip`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("digest")).toBe(`sha256=${await sha256Hex(zip)}`);
    expect(head.body).toBeNull();
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Enumerate / metadata / manifest / identifiers
// ---------------------------------------------------------------------------

describe("swift enumerate + metadata + manifest + identifiers", () => {
  it("enumerate: SemVer-sorted releases with the Link header; the .json twin matches", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // Upload OUT of order — the enumerate sorts by SemVer.
    for (const version of ["1.0.4-beta.1", "1.0.3", "1.0.4"]) {
      const put = await uploadSwift(
        "alice",
        SCOPE,
        NAME,
        version,
        sourceArchiveParts(version, { manifests: [{ name: "Package.swift", content: MANIFEST_1 }] }),
        authHeaders(writer),
      );
      expect(put.status).toBe(201);
      await put.arrayBuffer();
    }

    const res = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}`, {
      headers: { Accept: SWIFT_ACCEPT_JSON },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const baseURL = `https://example.com/api/packages/alice/swift/${SCOPE}/${NAME}/`;
    // Link targets the HIGHEST semver's RAW version (1.0.4 > 1.0.4-beta.1).
    expect(res.headers.get("link")).toBe(`<${baseURL}1.0.4>; rel="latest-version"`);
    const body = await res.text();
    // Go's map marshal renders the keys sorted; each URL carries the RAW version.
    expect(body).toBe(
      `{"releases":{"1.0.3":{"url":"${baseURL}1.0.3"},"1.0.4":{"url":"${baseURL}1.0.4"},"1.0.4-beta.1":{"url":"${baseURL}1.0.4-beta.1"}}}`,
    );
    // The .json twin renders the SAME document; the name suffix strips.
    const jsonTwin = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}.json`);
    expect(jsonTwin.status).toBe(200);
    expect(await jsonTwin.text()).toBe(body);

    // The enumerate miss → 404 with the EMPTY detail.
    const miss = await protocol()(`/api/packages/alice/swift/${SCOPE}/ghost`, {
      headers: { Accept: SWIFT_ACCEPT_JSON },
    });
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ status: 404, detail: "" });
  });

  it("metadata: the resources pair + the schema.org document; the .json twin matches", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zipParts = sourceArchiveParts("1.0.3", { metadata: metadataJson("1.0.3") });
    await uploadSwift("alice", SCOPE, NAME, "1.0.3", zipParts, authHeaders(writer));
    const checksum = await sha256Hex(zipParts[0]?.body as Uint8Array);

    const res = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3`, {
      headers: { Accept: SWIFT_ACCEPT_JSON },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-version")).toBe("1");
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({
      id: PACKAGE_ID,
      version: "1.0.3",
      resources: [{ name: "source-archive", type: "application/zip", checksum }],
      metadata: {
        "@context": ["http://schema.org/"],
        "@type": "SoftwareSourceCode",
        name: NAME,
        version: "1.0.3",
        description: "Gitea Test Package",
        codeRepository: "https://gitea.io/gitea/gitea",
        licenseURL: "https://opensource.org/license/mit",
        author: { "@type": "Person", name: "KN4CK3R", givenName: "KN4CK3R" },
        programmingLanguage: { "@type": "ComputerLanguage", name: "Swift", url: "https://swift.org" },
        repositoryURLs: REPO_URLS,
      },
    });
    const jsonTwin = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3.json`);
    expect(await jsonTwin.text()).toBe(body);

    const miss = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/9.9.9`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ status: 404, detail: "package does not exist" });
  });

  it("empty JSON metadata uploads: no author, no repositoryURLs, no codeRepository", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.5",
      sourceArchiveParts("1.0.5", { metadata: "{}" }),
      authHeaders(writer),
    );
    const res = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.5`);
    const body = JSON.parse(await res.text()) as { metadata: Record<string, unknown> };
    expect(body.metadata.author).toBeUndefined();
    expect(body.metadata.repositoryURLs).toBeUndefined();
    expect(body.metadata.codeRepository).toBeUndefined();
    expect(body.metadata.licenseURL).toBeUndefined();
  });

  it("manifest: default, the swift-version trim, and the 303 redirect on a miss", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.3",
      sourceArchiveParts("1.0.3"),
      authHeaders(writer),
    );
    const manifestURL = `/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3/Package.swift`;

    const def = await protocol()(manifestURL, { headers: { Accept: SWIFT_ACCEPT_SWIFT } });
    expect(def.status).toBe(200);
    expect(def.headers.get("content-version")).toBe("1");
    expect(def.headers.get("content-type")).toBe("text/x-swift");
    expect(await def.text()).toBe(MANIFEST_1);

    // ?swift-version=5.6 → the alt manifest; 5.6.0 TRIMS to 5.6 (the same one).
    const alt = await protocol()(`${manifestURL}?swift-version=5.6`);
    expect(alt.status).toBe(200);
    expect(await alt.text()).toBe(MANIFEST_2);
    const altTrim = await protocol()(`${manifestURL}?swift-version=5.6.0`);
    expect(altTrim.status).toBe(200);
    expect(await altTrim.text()).toBe(MANIFEST_2);

    // A miss → 303 SeeOther with the bare Location + Content-Version.
    const redirect = await protocol()(`${manifestURL}?swift-version=1.0`);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("content-version")).toBe("1");
    expect(redirect.headers.get("location")).toBe(
      `https://example.com/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3/Package.swift`,
    );
    // An UNPARSEABLE param rides raw → the same redirect.
    const garbage = await protocol()(`${manifestURL}?swift-version=notasemver`);
    expect(garbage.status).toBe(303);
  });

  it("identifiers: the 400 empty-detail miss, the 404 unknown-url miss, the hit", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.3",
      sourceArchiveParts("1.0.3", { metadata: metadataJson("1.0.3") }),
      authHeaders(writer),
    );

    const noUrl = await protocol()("/api/packages/alice/swift/identifiers");
    expect(noUrl.status).toBe(400);
    expect(noUrl.headers.get("content-version")).toBe("1");
    expect(await noUrl.json()).toEqual({ status: 400, detail: "" });

    const unknown = await protocol()("/api/packages/alice/swift/identifiers?url=https://unknown.host/");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ status: 404, detail: "" });

    const hit = await protocol()(`/api/packages/alice/swift/identifiers?url=${encodeURIComponent(REPO_URL_1)}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-version")).toBe("1");
    expect(await hit.json()).toEqual({ identifiers: [PACKAGE_ID] });
  });

  it("unmatched shapes under {scope}/{name} run the gate then chi's router page", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.3",
      sourceArchiveParts("1.0.3"),
      authHeaders(writer),
    );

    // A public owner: `1.0.3.exe` rides the BARE `<version>` route (chi's
    // `[^/]+` matches the whole segment) → the metadata lookup's Problem 404.
    const exe = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3.exe`);
    expect(exe.status).toBe(404);
    expect(await exe.json()).toEqual({ status: 404, detail: "package does not exist" });

    // A FOUR-segment shape matches nothing in the PathGroup → the read gate
    // then chi's router page.
    const deepMiss = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3/foo`);
    expect(deepMiss.status).toBe(404);
    expect(await deepMiss.text()).toBe("404 page not found\n");

    // The private owner's PathGroup miss answers the gate's challenge first.
    const privateMiss = await protocol()(`/api/packages/stealth/swift/s/n/1.0.0/foo`);
    expect(privateMiss.status).toBe(401);
    expect(privateMiss.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateMiss.text();

    // A one-segment shape is ungated (no route there to carry middleware).
    const shallow = await protocol()("/api/packages/alice/swift/onlyscope");
    expect(shallow.status).toBe(404);
    expect(await shallow.text()).toBe("404 page not found\n");
    void privateOwner;
  });
});

// ---------------------------------------------------------------------------
// Auth / quota / the family switch
// ---------------------------------------------------------------------------

describe("swift auth/quota arms", () => {
  it("anonymous upload → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const parts = sourceArchiveParts("1.0.0");

    const anon = await uploadSwift("alice", SCOPE, NAME, "1.0.0", parts);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();

    const scoped = await uploadSwift("alice", SCOPE, NAME, "1.0.0", parts, authHeaders(wrongCategory));
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a PUBLIC owner's registry reads anonymously; a PRIVATE owner's are the challenge", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    await uploadSwift(
      "alice",
      SCOPE,
      NAME,
      "1.0.3",
      sourceArchiveParts("1.0.3"),
      authHeaders(writer),
    );
    await uploadSwift(
      "stealth",
      "sec",
      "ret",
      "1.0.0",
      sourceArchiveParts("1.0.0", { manifests: [{ name: "Package.swift", content: MANIFEST_1 }] }),
      authHeaders(stealthWriter),
    );

    const publicEnum = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}`);
    expect(publicEnum.status).toBe(200);
    await publicEnum.text();
    const publicZip = await protocol()(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.3.zip`);
    expect(publicZip.status).toBe(200);
    await publicZip.arrayBuffer();

    const privateEnum = await protocol()("/api/packages/stealth/swift/sec/ret");
    expect(privateEnum.status).toBe(401);
    expect(privateEnum.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateEnum.text();
  });

  it("the 403 quota arms: owner-total size var, the +1 count boundary, the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const parts = sourceArchiveParts("1.0.0");
    const form = makeMultipart(parts);

    // The total-size cap of 1 byte: the DECLARED length fires the pre-check.
    const capped = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })(
      `/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.0`,
      {
        method: "PUT",
        headers: { "content-type": form.contentType, ...authHeaders(writer) },
        body: form.body.slice(),
      },
    );
    expect(capped.status).toBe(403);
    expect(await capped.json()).toEqual({ status: 403, detail: "maximum allowed package storage quota exceeded" });

    // The admin bypass publishes under the same cap.
    const adminPut = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })(
      `/api/packages/root/swift/${SCOPE}/${NAME}/1.0.0`,
      {
        method: "PUT",
        headers: { "content-type": form.contentType, ...authHeaders(adminWriter) },
        body: form.body.slice(),
      },
    );
    expect(adminPut.status).toBe(201);
    await adminPut.arrayBuffer();

    // The count boundary on a FRESH owner: the 1st publish passes (0+1 ≤ 1),
    // the 2nd 403s (1+1 > 1 — the +1 parity).
    const countEnv = { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" };
    const bob = await seedUser("bob");
    const bobWriter = await token(bob, "write:package");
    const first = await protocol(countEnv)(`/api/packages/bob/swift/${SCOPE}/${NAME}/1.0.0`, {
      method: "PUT",
      headers: { "content-type": form.contentType, ...authHeaders(bobWriter) },
      body: (makeMultipart(sourceArchiveParts("1.0.0"))).body.slice(),
    });
    expect(first.status).toBe(201);
    await first.arrayBuffer();
    const second = await protocol(countEnv)(`/api/packages/bob/swift/${SCOPE}/${NAME}/2.0.0`, {
      method: "PUT",
      headers: { "content-type": form.contentType, ...authHeaders(bobWriter) },
      body: (makeMultipart(sourceArchiveParts("2.0.0"))).body.slice(),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ status: 403, detail: "maximum allowed package count exceeded" });
  });

  it("PACKAGES_ENABLED=false 404s the whole family; an unknown owner carries the redirect message", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const form = makeMultipart(sourceArchiveParts("1.0.0"));
    const put = await disabled(`/api/packages/alice/swift/${SCOPE}/${NAME}/1.0.0`, {
      method: "PUT",
      headers: { "content-type": form.contentType, ...authHeaders(writer) },
      body: form.body.slice(),
    });
    expect(put.status).toBe(404);
    expect(await put.text()).toBe("not found");
    const list = await disabled(`/api/packages/alice/swift/${SCOPE}/${NAME}`);
    expect(list.status).toBe(404);
    await list.text();

    const nobody = await protocol()("/api/packages/nobody/swift/s/n");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toBe("user redirect does not exist [name: nobody]");
  });

  it("the 64 MiB parse cap throws at the service seam (the route's 413 arm)", async () => {
    const owner = await seedUser("alice2");
    const zip = makeSwiftZip([{ name: "Package.swift", content: MANIFEST_1 }]);
    await expect(
      uploadSwiftPackage({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner: { id: owner.id, type: "user", visibility: "public" },
        doer: { id: owner.id, isAdmin: false },
        scope: SCOPE,
        name: NAME,
        version: "1.0.0",
        contentType: "multipart/form-data; boundary=x", // a NON-multipart body → the urlencoded walk
        content: new Response(zip.slice()).body as ReadableStream<Uint8Array>,
        declaredLength: zip.byteLength,
        quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
        maxBytes: 8,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The walk grammar (parseSwiftTarget)
// ---------------------------------------------------------------------------

describe("parseSwiftTarget", () => {
  it("pins the arm/suffix shapes and the gated/ungated 404 split", () => {
    expect(parseSwiftTarget(["scope", "name"], "GET")).toEqual({ arm: "enumerate", scope: "scope", name: "name" });
    expect(parseSwiftTarget(["scope", "name.json"], "GET")).toEqual({ arm: "enumerate", scope: "scope", name: "name" });
    expect(parseSwiftTarget(["scope", "name.jsonx"], "GET")).toEqual({ arm: "enumerate", scope: "scope", name: "name.jsonx" });
    expect(parseSwiftTarget(["scope", "name"], "PUT")).toEqual({ arm: "not-found", gated: false });
    expect(parseSwiftTarget(["scope"], "GET")).toEqual({ arm: "not-found", gated: false });
    expect(parseSwiftTarget(["scope", "name", "1.0.0"], "GET")).toEqual({
      arm: "metadata",
      scope: "scope",
      name: "name",
      version: "1.0.0",
    });
    expect(parseSwiftTarget(["scope", "name", "1.0.0.json"], "GET")).toEqual({
      arm: "metadata",
      scope: "scope",
      name: "name",
      version: "1.0.0",
    });
    expect(parseSwiftTarget(["scope", "name", "1.0.0.zip"], "GET")).toEqual({
      arm: "download",
      scope: "scope",
      name: "name",
      version: "1.0.0",
    });
    expect(parseSwiftTarget(["scope", "name", "1.0.0", "Package.swift"], "GET")).toEqual({
      arm: "manifest",
      scope: "scope",
      name: "name",
      version: "1.0.0",
    });
    expect(parseSwiftTarget(["scope", "name", ".json"], "GET")).toEqual({
      arm: "metadata",
      scope: "scope",
      name: "name",
      version: ".json",
    });
    // The bare `<version>` route matches ANY single segment (chi `[^/]+`) —
    // "1.0.0.exe" is a metadata lookup that misses in the DB.
    expect(parseSwiftTarget(["scope", "name", "1.0.0.exe"], "GET")).toEqual({
      arm: "metadata",
      scope: "scope",
      name: "name",
      version: "1.0.0.exe",
    });
    expect(parseSwiftTarget(["scope", "name", "1.0.0"], "PUT")).toEqual({
      arm: "upload",
      scope: "scope",
      name: "name",
      version: "1.0.0",
    });
    expect(parseSwiftTarget(["scope", "name", "1.0.0"], "DELETE")).toEqual({ arm: "not-found", gated: true });
    expect(parseSwiftTarget(["scope", "name", "1.0.0", "foo"], "GET")).toEqual({ arm: "not-found", gated: true });
    expect(parseSwiftTarget(["identifiers"], "GET")).toEqual({ arm: "identifiers" });
    expect(parseSwiftTarget(["identifiers"], "POST")).toEqual({ arm: "not-found", gated: false });
  });
});
