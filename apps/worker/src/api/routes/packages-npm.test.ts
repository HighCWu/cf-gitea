/**
 * The npm protocol battery (SPEC-0016 §7 M4, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/npm at the pin:
 *
 *  - the publish round-trip (creator.go's couchdb-ish document: the versions
 *    map, the base64 _attachments, the sha512- integrity) → 201, the
 *    packument (api.go's shapes: normalized versions keys, the dist block,
 *    time.created/modified, the weak ETag with the 304 arm), dist-tags CRUD,
 *    the tarball download with BYTE PARITY, `npm deprecate`, `npm unpublish`;
 *  - the upstream validation arms in order: invalid name → 400 "package name
 *    is invalid", invalid version → 400 "package version is invalid",
 *    integrity mismatch → 400 "failed to validate integrity", missing
 *    attachment → 400 "package attachment is invalid", no versions → 400
 *    "package is invalid", malformed JSON → 500 (upstream's
 *    non-InvalidArgument arm), re-publish → 409;
 *  - auth: anonymous publish → 401 + the WWW-Authenticate challenge,
 *    wrong-scope token → 401, private owner blinds anonymous downloads,
 *    whoami's 401 {"error":"Unauthorized"}; quota 403 + the admin bypass;
 *    411 without Content-Length; PACKAGES_ENABLED=false 404s the family;
 *  - the repository-link arms (npm.go:198-216): a foreign instance repo the
 *    doer cannot write → 403 "no permission to upload this package", the
 *    doer's own repo links the package row, an external URL skips silently.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages, repositories, users } from "../../db/schema";
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

// JSON access guards for the packument assertions (the lint's no-explicit-any).
type Rec = Record<string, unknown>;
function rec(value: unknown): Rec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Rec;
}
function recs(value: unknown): Rec[] {
  if (!Array.isArray(value)) throw new Error("expected a JSON array");
  return value.map(rec);
}

/** The `{"error": ...}` body the npm family answers with. */
function errorOf(value: unknown): string {
  const error = rec(value).error;
  if (typeof error !== "string") throw new Error("expected a string error body");
  return error;
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

async function seedRepo(owner: SeededUser, slug: string): Promise<void> {
  const id = crypto.randomUUID();
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: owner.username.toLowerCase(),
    ownerId: owner.id,
    slug,
    visibility: "public",
  });
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
// The tarball fixture — a real ustar+gzip archive (CompressionStream)
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

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  header.set(enc.encode(name.slice(0, 100)), 0);
  header.set(enc.encode("0000644\0"), 100); // mode
  header.set(enc.encode("0000000\0"), 108); // uid
  header.set(enc.encode("0000000\0"), 116); // gid
  header.set(enc.encode(`${size.toString(8).padStart(11, "0")} `), 124); // size
  header.set(enc.encode("00000000000 "), 136); // mtime
  header.set(enc.encode("        "), 148); // checksum placeholder (spaces)
  header[156] = 0x30; // '0' regular file
  header.set(enc.encode("ustar\0"), 257);
  header.set(enc.encode("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return header;
}

async function makeTarball(files: Record<string, string>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(content);
    chunks.push(tarHeader(name, bytes.byteLength));
    chunks.push(bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024)); // two zero blocks close the archive
  const tar = concatBytes(chunks);
  const gzipped = new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip")));
  return new Uint8Array(await gzipped.arrayBuffer());
}

async function shaHex(algorithm: "SHA-1" | "SHA-512" | "SHA-256", bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// The publish document (creator.go's packageUpload shape)
// ---------------------------------------------------------------------------

interface PublishDocOverrides {
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  readme?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  repository?: unknown;
  bin?: unknown;
  distTags?: Record<string, string>;
  /** Overrides the auto attachment key/data entirely when set. */
  attachments?: Record<string, { data: string; length?: number }>;
  integrity?: string;
  version?: string;
  docName?: string;
  scripts?: Record<string, string>;
  shrinkwrap?: boolean;
}

async function publishDocument(
  name: string,
  version: string,
  tarball: Uint8Array,
  overrides: PublishDocOverrides = {},
): Promise<string> {
  const displayVersion = overrides.version ?? version;
  const docName = overrides.docName ?? name;
  const integrity =
    overrides.integrity ?? `sha512-${toBase64(new Uint8Array(await crypto.subtle.digest("SHA-512", tarball)))}`;
  const versionDoc: Record<string, unknown> = {
    name: docName,
    version: displayVersion,
    description: overrides.description ?? "a test package",
    author: { name: overrides.author ?? "The Author" },
    license: overrides.license ?? "MIT",
    dist: { integrity },
  };
  if (overrides.homepage !== undefined) versionDoc.homepage = overrides.homepage;
  if (overrides.readme !== undefined) versionDoc.readme = overrides.readme;
  if (overrides.keywords !== undefined) versionDoc.keywords = overrides.keywords;
  if (overrides.dependencies !== undefined) versionDoc.dependencies = overrides.dependencies;
  if (overrides.repository !== undefined) versionDoc.repository = overrides.repository;
  if (overrides.bin !== undefined) versionDoc.bin = overrides.bin;
  if (overrides.scripts !== undefined) {
    // The tarball's package.json scripts surface through the scan.
    versionDoc.scripts = overrides.scripts;
  }
  const doc: Record<string, unknown> = {
    _id: docName,
    name: docName,
    description: overrides.description ?? "a test package",
    "dist-tags": overrides.distTags ?? { latest: displayVersion },
    versions: { [displayVersion]: versionDoc },
    _attachments:
      overrides.attachments ??
      { [`${docName}-${displayVersion}.tgz`]: { data: toBase64(tarball), length: tarball.byteLength } },
  };
  return JSON.stringify(doc);
}

const NPM_TARBALL = await makeTarball({
  "package/package.json": JSON.stringify({ name: "pkg", version: "1.0.0" }),
});

async function publish(
  owner: string,
  name: string,
  version: string,
  tarball: Uint8Array,
  overrides: PublishDocOverrides = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = await publishDocument(name, version, tarball, overrides);
  return protocol()(`/api/packages/${owner}/npm/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "content-length": String(body.length), ...headers },
    body,
  });
}

// ---------------------------------------------------------------------------
// The round-trip: publish → packument → dist-tags → tarball download
// ---------------------------------------------------------------------------

describe("npm publish → packument → dist-tags → download", () => {
  it("round-trips a publish: 201 → the packument shapes → byte-parity tarball", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await publish("alice", "@scope/pkg", "1.0.0", NPM_TARBALL, {
      keywords: ["gitea"],
      homepage: "https://gitea.io/",
      readme: "the readme",
    }, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();

    // The packument answers on all three upstream URL shapes
    // (npm.go's NPM-ROUTE-PATH-PATTERN hint).
    const packument = await protocol()("/api/packages/alice/npm/@scope%2Fpkg");
    expect(packument.status).toBe(200);
    expect(packument.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const etag = packument.headers.get("etag");
    expect(etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
    const doc = rec(await packument.json());
    expect(doc._id).toBe("@scope/pkg");
    expect(doc.name).toBe("@scope/pkg");
    expect(doc["dist-tags"]).toEqual({ latest: "1.0.0" });
    const versions = rec(doc.versions);
    expect(Object.keys(versions)).toEqual(["1.0.0"]);
    expect(doc.maintainers).toEqual([{ name: "alice" }]);
    expect(doc.author).toEqual({ name: "The Author" });
    expect(doc.license).toBe("MIT");
    expect(doc.homepage).toBe("https://gitea.io/");
    expect(doc.readme).toBe("the readme");
    expect(doc.keywords).toEqual(["gitea"]);
    const time = rec(doc.time);
    expect(time.created).toBeDefined();
    expect(time.modified).toBeDefined();
    expect(time["1.0.0"]).toBeDefined();

    // The version object: _id/name/version, the dist block per api.go:119-123.
    const versionDoc = rec(versions["1.0.0"]);
    expect(versionDoc._id).toBe("@scope/pkg@1.0.0");
    expect(versionDoc.name).toBe("@scope/pkg");
    expect(versionDoc.version).toBe("1.0.0");
    expect(versionDoc.description).toBe("a test package");
    expect(versionDoc.author).toEqual({ name: "The Author" });
    expect(versionDoc.maintainers).toEqual([{ name: "alice" }]);
    const shasum = await shaHex("SHA-1", NPM_TARBALL);
    const integrity = `sha512-${toBase64(new Uint8Array(await crypto.subtle.digest("SHA-512", NPM_TARBALL)))}`;
    const dist = rec(versionDoc.dist);
    expect(dist.shasum).toBe(shasum);
    expect(dist.integrity).toBe(integrity);
    // The stored gitea_tarball_path URL (creator.go:349) — case-kept name.
    expect(dist.tarball).toBe("https://example.com/api/packages/alice/npm/@scope/pkg/-/pkg-1.0.0.tgz");

    // The other two URL shapes answer the same packument.
    const unencoded = await protocol()("/api/packages/alice/npm/@scope/pkg");
    expect(unencoded.status).toBe(200);
    await unencoded.text();
    const fullyEncoded = await protocol()("/api/packages/alice/npm/%40scope%2Fpkg");
    expect(fullyEncoded.status).toBe(200);
    await fullyEncoded.text();

    // The weak ETag honored: If-None-Match → 304 (serveMetadata + ServeContent).
    const conditional = await protocol()("/api/packages/alice/npm/@scope%2Fpkg", {
      headers: { "if-none-match": etag as string },
    });
    expect(conditional.status).toBe(304);
    await conditional.text();

    // The tarball download: byte parity (GET /{id}/-/{filename}).
    const get = await protocol()("/api/packages/alice/npm/@scope%2Fpkg/-/pkg-1.0.0.tgz");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toContain("pkg-1.0.0.tgz");
    const served = new Uint8Array(await get.arrayBuffer());
    expect([...served]).toEqual([...NPM_TARBALL]);

    // The two-segment shape (version segment IGNORED — npm.go:135-152).
    const shaped = await protocol()("/api/packages/alice/npm/@scope%2Fpkg/-/1.0.0/pkg-1.0.0.tgz");
    expect(shaped.status).toBe(200);
    await shaped.arrayBuffer();

    // The lead-file GET bumped the counter once (the HEAD never does).
    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(2);
    const head = await protocol()("/api/packages/alice/npm/@scope%2Fpkg/-/pkg-1.0.0.tgz", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    await head.text();

    // The stored metadata carries the tarball scan's flags + the path.
    const metadata = rec(JSON.parse(rows[0]?.metadataJson as string));
    expect(metadata.name).toBe("pkg");
    expect(metadata.scope).toBe("@scope");
    expect(metadata.gitea_tarball_path).toBe("@scope/pkg/-/pkg-1.0.0.tgz");
  });

  it("normalizes the versions key through the go-version canonical form", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // "v1.2" publishes canonically as "1.2.0" (api.go:31-32's SemVer.String()).
    const put = await publish("alice", "canon", "v1.2", NPM_TARBALL, { version: "v1.2" }, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();
    const doc = rec(await (await protocol()("/api/packages/alice/npm/canon")).json());
    const canonVersions = rec(doc.versions);
    expect(Object.keys(canonVersions)).toEqual(["1.2.0"]);
    // The dist-tags VALUE is the stored row's version — upstream stores the
    // canonical v.String() too (creator.go:313), so "v1.2" lands as "1.2.0".
    expect(rec(doc["dist-tags"]).latest).toBe("1.2.0");
    const canonVersion = rec(canonVersions["1.2.0"]);
    expect(canonVersion.version).toBe("1.2.0");
    // The filename derives from the UNSCOPED name (creator.go:347).
    expect(rec(canonVersion.dist).tarball).toContain("/canon/-/canon-1.2.0.tgz");
  });

  it("orders the packument by semver and falls back to the highest non-prerelease latest", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const [name, version] of [
      ["ord", "1.1.0"],
      ["ord", "2.0.0-rc.1"],
      ["ord", "1.0.0"],
    ] as const) {
      const put = await publish("alice", name, version, NPM_TARBALL, { distTags: {} }, authHeaders(writer));
      expect(put.status).toBe(201);
      await put.text();
    }
    const doc = rec(await (await protocol()("/api/packages/alice/npm/ord")).json());
    // Ascending SemVer.LessThan (api.go:21-23); deterministic map keys.
    expect(Object.keys(rec(doc.versions))).toEqual(["1.0.0", "1.1.0", "2.0.0-rc.1"]);
    // The latest fallback: the highest version WITHOUT a prerelease
    // (api.go:51-60 — the upstream api_test's exact fixture).
    expect(doc["dist-tags"]).toEqual({ latest: "1.1.0" });
    expect(rec(doc.time).created).toBeDefined();

    // Unpublish 1.1.0 → the fallback moves to the next non-prerelease.
    const unpublish = await protocol()("/api/packages/alice/npm/ord/-/ord-1.1.0.tgz/-rev/1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(unpublish.status).toBe(200);
    await unpublish.text();
    const after = rec(await (await protocol()("/api/packages/alice/npm/ord")).json());
    expect(Object.keys(rec(after.versions))).toEqual(["1.0.0", "2.0.0-rc.1"]);
    expect(after["dist-tags"]).toEqual({ latest: "1.0.0" });
  });

  it("serves the single-version metadata, the latest fallback, and 404s unknown versions", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await publish("alice", "vm", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    const one = await protocol()("/api/packages/alice/npm/vm/1.0.0");
    expect(one.status).toBe(200);
    expect(one.headers.get("etag")).toMatch(/^W\//);
    const doc = rec(await one.json());
    expect(doc._id).toBe("vm@1.0.0");
    expect(rec(doc.dist).tarball).toContain("/vm/-/");

    const latest = await protocol()("/api/packages/alice/npm/vm/latest");
    expect(latest.status).toBe(200);
    await latest.json();

    const missing = await protocol()("/api/packages/alice/npm/vm/9.9.9");
    expect(missing.status).toBe(404);
    expect(errorOf(await missing.json())).toBe("version not found: 9.9.9");
  });

  it("moves dist-tags through the property CRUD (PUT/DELETE dist-tags/{tag})", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await publish("alice", "tags", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));

    const initial = rec(await (await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags")).json());
    expect(initial).toEqual({ latest: "1.0.0" });

    // PUT a tag (the quoted-version body, npm.go:408-421).
    const put = await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags/next", {
      method: "PUT",
      headers: { ...authHeaders(writer), "content-type": "application/json" },
      body: '"1.0.0"',
    });
    expect(put.status).toBe(200);
    await put.text();
    const withNext = rec(await (await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags")).json());
    expect(withNext).toEqual({ latest: "1.0.0", next: "1.0.0" });

    // A version-shaped tag name is invalid (npm.go:464-471).
    const invalid = await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags/2.0.0", {
      method: "PUT",
      headers: { ...authHeaders(writer), "content-type": "application/json" },
      body: '"1.0.0"',
    });
    expect(invalid.status).toBe(400);
    expect(errorOf(await invalid.json())).toBe("The tag name is invalid");

    // A tag pointing at an unknown version → 404 (ErrPackageNotExist).
    const unknown = await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags/lts", {
      method: "PUT",
      headers: { ...authHeaders(writer), "content-type": "application/json" },
      body: '"9.9.9"',
    });
    expect(unknown.status).toBe(404);
    expect(errorOf(await unknown.json())).toBe("package does not exist");

    // DELETE the tag; the tag list keeps the packument fallback.
    const del = await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags/next", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(200);
    await del.text();
    const after = rec(await (await protocol()("/api/packages/alice/npm/-/package/tags/dist-tags")).json());
    expect(after).toEqual({ latest: "1.0.0" });
  });
});

// ---------------------------------------------------------------------------
// npm deprecate / unpublish
// ---------------------------------------------------------------------------

describe("npm deprecate and unpublish", () => {
  it("deprecates and undeprecates through the attachment-less PUT", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await publish("alice", "dep", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));

    // `npm deprecate` reuses the publish endpoint with no _attachments
    // (npm.go:192-196); only versions whose object carries `deprecated` are
    // patched (creator.go:462-486).
    const body = JSON.stringify({
      name: "dep",
      versions: { "1.0.0": { deprecated: "gone" }, "9.9.9": { deprecated: "missing" } },
    });
    const put = await protocol()("/api/packages/alice/npm/dep", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": String(body.length), ...authHeaders(writer) },
      body,
    });
    expect(put.status).toBe(200);
    await put.text();

    const doc = rec(await (await protocol()("/api/packages/alice/npm/dep")).json());
    expect(rec(rec(doc.versions)["1.0.0"]).deprecated).toBe("gone");

    // An empty message undeprecates (npm.go:288's contract).
    const clear = JSON.stringify({ name: "dep", versions: { "1.0.0": { deprecated: "" } } });
    const cleared = await protocol()("/api/packages/alice/npm/dep", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": String(clear.length), ...authHeaders(writer) },
      body: clear,
    });
    expect(cleared.status).toBe(200);
    await cleared.text();
    const after = rec(await (await protocol()("/api/packages/alice/npm/dep")).json());
    expect(rec(rec(after.versions)["1.0.0"]).deprecated).toBeUndefined();

    // A deprecate with NO versions → 400 (npm.go:290-292).
    const empty = await protocol()("/api/packages/alice/npm/dep", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "14", ...authHeaders(writer) },
      body: '{"name":"dep"}',
    });
    expect(empty.status).toBe(400);
    expect(errorOf(await empty.json())).toBe("npm deprecate request contains no versions");
  });

  it("unpublishes by tarball and the whole package (the -rev DELETE shapes)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await publish("alice", "gone", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    await publish("alice", "gone", "2.0.0", NPM_TARBALL, { distTags: {} }, authHeaders(writer));

    // DeletePreview answers 200 without doing anything (npm.go:280-284).
    const preview = await protocol()("/api/packages/alice/npm/gone/-rev/1", {
      method: "PUT",
      headers: authHeaders(writer),
      body: "",
    });
    expect(preview.status).toBe(200);
    await preview.text();

    // Unpublish 1.0.0 by its tarball.
    const unpublish = await protocol()("/api/packages/alice/npm/gone/-/gone-1.0.0.tgz/-rev/1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(unpublish.status).toBe(200);
    await unpublish.text();
    const doc = rec(await (await protocol()("/api/packages/alice/npm/gone")).json());
    expect(Object.keys(rec(doc.versions))).toEqual(["2.0.0"]);

    // Unknown tarball → 404 {"error":""} (apiError(404, nil)).
    const missing = await protocol()("/api/packages/alice/npm/gone/-/gone-9.9.9.tgz/-rev/1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(missing.status).toBe(404);
    expect(errorOf(await missing.json())).toBe("");

    // Unpublish the WHOLE package; then every read 404s.
    const whole = await protocol()("/api/packages/alice/npm/gone/-rev/1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(whole.status).toBe(200);
    await whole.text();
    const packument = await protocol()("/api/packages/alice/npm/gone");
    expect(packument.status).toBe(404);
    await packument.text();
    const tags = await protocol()("/api/packages/alice/npm/-/package/gone/dist-tags");
    expect(tags.status).toBe(404);
    await tags.text();
  });
});

// ---------------------------------------------------------------------------
// The upstream validation arms (creator.go's sentinels)
// ---------------------------------------------------------------------------

describe("npm publish validation arms", () => {
  it("400s 'package name is invalid' on a versions entry that disagrees with the URL id", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // The URL id "outer" passes chi's route regex; the ENTRY name "Test"
    // fails creator.go's matcher (npm.go:285-287 — parseUploadPackage's arm).
    const put = await publish("alice", "outer", "1.0.0", NPM_TARBALL, { docName: "Test" }, authHeaders(writer));
    expect(put.status).toBe(400);
    expect(errorOf(await put.json())).toBe("package name is invalid");
  });

  it("404s URL ids that fail the upstream route regex (chi MatchPath anchoring)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const bad of ["Test", "te st", " test", "_test", ".test", "invalid/scope", "@invalid/_name"]) {
      const put = await publish("alice", bad, "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
      expect(put.status).toBe(404);
      await put.text();
    }
  });

  it("400s 'package version is invalid' on a non-semver version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await publish("alice", "v", "first-version", NPM_TARBALL, {}, authHeaders(writer));
    expect(put.status).toBe(400);
    expect(errorOf(await put.json())).toBe("package version is invalid");
  });

  it("400s 'failed to validate integrity' on a hash mismatch", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const bogus = await publish("alice", "integ", "1.0.0", NPM_TARBALL, {
      integrity: `sha512-${toBase64(new TextEncoder().encode("wrong-bytes-hash"))}`,
    }, authHeaders(writer));
    expect(bogus.status).toBe(400);
    expect(errorOf(await bogus.json())).toBe("failed to validate integrity");
  });

  it("400s 'package attachment is invalid' on missing/undecodable attachment data", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const empty = await publish("alice", "att", "1.0.0", NPM_TARBALL, {
      attachments: { "wrong-key.tgz": { data: toBase64(NPM_TARBALL), length: NPM_TARBALL.byteLength }, "extra.tgz": { data: toBase64(NPM_TARBALL) } },
    }, authHeaders(writer));
    expect(empty.status).toBe(400);
    expect(errorOf(await empty.json())).toBe("package attachment is invalid");
    const garbage = await publish("alice", "att2", "1.0.0", NPM_TARBALL, {
      attachments: { "att2-1.0.0.tgz": { data: "not base64!!" } },
    }, authHeaders(writer));
    expect(garbage.status).toBe(400);
    expect(errorOf(await garbage.json())).toBe("package attachment is invalid");
  });

  it("400s 'package is invalid' without a versions map; 500s malformed JSON", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const noVersions = JSON.stringify({
      _id: "nv",
      name: "nv",
      _attachments: { "nv-1.0.0.tgz": { data: toBase64(NPM_TARBALL) } },
    });
    const put = await protocol()("/api/packages/alice/npm/nv", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(noVersions.length),
        ...authHeaders(writer),
      },
      body: noVersions,
    });
    expect(put.status).toBe(400);
    expect(errorOf(await put.json())).toBe("package is invalid");

    // Malformed JSON is upstream's non-InvalidArgument arm → 500, stripped
    // for non-admins in production (ProcessErrorForUser, helper.go:38-44).
    const malformed = await protocol()("/api/packages/alice/npm/bad", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "14", ...authHeaders(writer) },
      body: '{"broken": tru',
    });
    expect(malformed.status).toBe(500);
    expect(errorOf(await malformed.json())).toBe("internal server error");
  });

  it("409s a re-publish of an existing version (ErrDuplicatePackageVersion)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const first = await publish("alice", "dup", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    expect(first.status).toBe(201);
    await first.text();
    const again = await publish("alice", "dup", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    expect(again.status).toBe(409);
    expect(errorOf(await again.json())).toBe("package version already exists");
  });

  it("a chunked body streams; non-tarball bytes answer 400 (D-2)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const put = await protocol()("/api/packages/alice/npm/streamed", {
      method: "PUT",
      headers: { "content-type": "application/json", ...authHeaders(writer) },
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing
      duplex: "half",
    });
    // D-2: the spool streamed the body (no 411); "{}" is not a tarball so
    // the packument validation's 400 is the terminal answer.
    expect(put.status).toBe(400);
    await put.text();
  });

  it("scans the tarball for shrinkwrap and lifecycle scripts (creator.go:398-438)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const flagged = await makeTarball({
      "package/npm-shrinkwrap.json": "{}",
      "package/package.json": JSON.stringify({ scripts: { postinstall: "echo hi" } }),
    });
    const put = await publish("alice", "scanned", "1.0.0", flagged, {}, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();
    const rows = await db().select().from(packageVersions).all();
    const metadata = rec(JSON.parse(rows[0]?.metadataJson as string));
    expect(metadata.has_shrinkwrap).toBe(true);
    expect(metadata.has_install_script).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Search, ping, whoami
// ---------------------------------------------------------------------------

describe("npm search, ping, whoami", () => {
  it("searches latest versions with the upstream object shape", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await publish("alice", "@scope/alpha", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    await publish("alice", "beta", "2.0.0", NPM_TARBALL, {}, authHeaders(writer));

    const all = rec(await (
      await protocol()("/api/packages/alice/npm/-/v1/search?size=10")
    ).json());
    expect(all.total).toBe(2);
    const objects = recs(all.objects);
    expect(objects).toHaveLength(2);
    // Default order: created DESC — beta (published last) first.
    const first = rec(rec(objects[0]).package);
    expect(first.name).toBe("beta");
    expect(first.scope).toBe("unscoped");
    expect(first.version).toBe("2.0.0");
    expect(first.publisher).toEqual({ name: "alice" });
    expect(first.maintainers).toEqual([]);
    expect(rec(first.links).npm).toBe("https://example.com/api/packages/alice/npm");

    const scoped = rec(await (
      await protocol()("/api/packages/alice/npm/-/v1/search?text=alpha&size=10")
    ).json());
    expect(scoped.total).toBe(1);
    const scopedObjects = recs(scoped.objects);
    expect(scopedObjects).toHaveLength(1);
    const scopedPkg = rec(rec(scopedObjects[0]).package);
    expect(scopedPkg.scope).toBe("@scope");
    expect(scopedPkg.name).toBe("alpha");
  });

  it("answers ping and whoami (whoami 401s anonymously)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const ping = await protocol()("/api/packages/alice/npm/-/ping");
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({});

    const anon = await protocol()("/api/packages/alice/npm/-/whoami");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: "Unauthorized" });

    const authed = await protocol()("/api/packages/alice/npm/-/whoami", { headers: authHeaders(writer) });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ username: "alice" });
  });
});

// ---------------------------------------------------------------------------
// Auth, quota, enable-gate, repository-link arms
// ---------------------------------------------------------------------------

describe("npm auth/quota/repo-link arms", () => {
  it("anonymous publish → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const anon = await publish("alice", "n", "1.0.0", NPM_TARBALL);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();
    const scoped = await publish("alice", "n", "1.0.0", NPM_TARBALL, {}, authHeaders(wrongCategory));
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a PUBLIC owner's tarball downloads anonymously; a PRIVATE owner's does not", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    await publish("alice", "pub", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    await publish("stealth", "sec", "1.0.0", NPM_TARBALL, {}, authHeaders(stealthWriter));

    const publicGet = await protocol()("/api/packages/alice/npm/pub/-/pub-1.0.0.tgz");
    expect(publicGet.status).toBe(200);
    await publicGet.arrayBuffer();

    const privateGet = await protocol()("/api/packages/stealth/npm/sec/-/sec-1.0.0.tgz");
    expect(privateGet.status).toBe(401);
    expect(privateGet.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateGet.text();
  });

  it("the 403 quota arm (owner-total var override) and the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");

    const denied = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "4" })(
      "/api/packages/alice/npm/q",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": String((await publishDocument("q", "1.0.0", NPM_TARBALL)).length),
          ...authHeaders(writer),
        },
        body: await publishDocument("q", "1.0.0", NPM_TARBALL),
      },
    );
    expect(denied.status).toBe(403);
    await denied.text();

    // The unlimited default lets the same bytes through; an ADMIN publishing
    // to their OWN owner bypasses the cap.
    const allowed = await publish("alice", "q", "1.0.0", NPM_TARBALL, {}, authHeaders(writer));
    expect(allowed.status).toBe(201);
    await allowed.text();
    const adminPut = await publish("root", "qa", "1.0.0", NPM_TARBALL, {}, authHeaders(adminWriter));
    expect(adminPut.status).toBe(201);
    await adminPut.text();
  });

  it("the count-quota boundary (+1 parity): the Nth publish reaches the cap, the (N+1)th 403s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // LIMIT = 2. Upstream inserts the version THEN checks count > limit inside
    // the rolling-back transaction (packages.go:188-191 with the throw at
    // 380-381), so the publish that REACHES the limit passes and only one
    // past 403s — a pre-insert `count > limit` check would allow one version
    // MORE than upstream at exactly this boundary.
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" });
    const cappedPut = async (version: string): Promise<Response> => {
      const body = await publishDocument("bnd", version, NPM_TARBALL);
      return capped(`/api/packages/alice/npm/bnd`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          ...authHeaders(writer),
        },
        body,
      });
    };

    // N-1 → N: the publish that REACHES the limit succeeds (1 + 1 ≤ 2).
    const reach = await cappedPut("1.0.0");
    expect(reach.status).toBe(201);
    await reach.text();
    // The Nth publish succeeds with the owner exactly AT the limit (2 + 1 →
    // count 2; 2 > 2 is false upstream).
    const atLimit = await cappedPut("2.0.0");
    expect(atLimit.status).toBe(201);
    await atLimit.text();

    // The (N+1)th publish past the cap → 403 ErrQuotaTotalCount, and the
    // rollback posture leaves the two landed versions untouched.
    const over = await cappedPut("3.0.0");
    expect(over.status).toBe(403);
    expect(errorOf(await over.json())).toBe("package quota count limit exceeded");
    expect((await db().select().from(packageVersions).all())).toHaveLength(2);
  });

  it("PACKAGES_ENABLED=false 404s the whole family", async () => {
    await seedUser("alice");
    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const packument = await disabled("/api/packages/alice/npm/pkg");
    expect(packument.status).toBe(404);
    await packument.text();
    const ping = await disabled("/api/packages/alice/npm/-/ping");
    expect(ping.status).toBe(404);
    await ping.text();
  });

  it("the repository link: foreign repo → 403, own repo → linked, external URL → skipped", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await seedRepo(alice, "alice-repo");
    await seedRepo(bob, "bob-repo");
    const writer = await token(alice, "write:package");

    // npm.go:198-216 — a repo URL the doer cannot write answers 403.
    const foreign = await publish("alice", "foreign", "1.0.0", NPM_TARBALL, {
      repository: { type: "git", url: "https://example.com/bob/bob-repo" },
    }, authHeaders(writer));
    expect(foreign.status).toBe(403);
    expect(errorOf(await foreign.json())).toBe("no permission to upload this package");

    // The doer's OWN repo links the package row (SetRepositoryLink).
    const own = await publish("alice", "linked", "1.0.0", NPM_TARBALL, {
      repository: { type: "git", url: "https://example.com/alice/alice-repo" },
    }, authHeaders(writer));
    expect(own.status).toBe(201);
    await own.text();
    const linked = await db().select().from(packages).all();
    expect(linked).toHaveLength(1);
    expect(linked[0]?.repoId).not.toBeNull();

    // The scp-shape twin resolves the same repo.
    await db().delete(packages).all();
    const scp = await publish("alice", "linked2", "1.0.0", NPM_TARBALL, {
      repository: "git@example.com:alice/alice-repo.git",
    }, authHeaders(writer));
    expect(scp.status).toBe(201);
    await scp.text();
    const scpLinked = await db().select().from(packages).all();
    expect(scpLinked[0]?.repoId).not.toBeNull();

    // An external URL skips the arm silently (npm.go:198's err gate).
    await db().delete(packages).all();
    const external = await publish("alice", "ext", "1.0.0", NPM_TARBALL, {
      repository: { type: "git", url: "https://github.com/gitea/gitea" },
    }, authHeaders(writer));
    expect(external.status).toBe(201);
    await external.text();
    const unlinked = await db().select().from(packages).all();
    expect(unlinked[0]?.repoId).toBeNull();
    void bob;
  });
});
