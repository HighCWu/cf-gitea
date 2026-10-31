/**
 * The Go module proxy protocol battery (SPEC-0016 §7's long-tail `go` row)
 * on real D1 + the real REPO_PACKS binding — upstream
 * routers/api/packages/goproxy/goproxy.go + modules/packages/goproxy/
 * metadata.go at the pin, with the upstream integration test
 * tests/integration/api_packages_goproxy_test.go as the client-shape oracle:
 *
 *  - the upload round-trip (a real zip with {module}@{version}/go.mod) →
 *    201, the type "go" package + version, the `go.mod` VERSION PROPERTY,
 *    the ONE lead file `{version}.zip`, then @v/list (created ASC, one per
 *    line, the empty-module 404 EMPTY body), @v/{v}.info + @latest (the
 *    {Version, Time} JSON), @v/{v}.mod (the property text), @v/{v}.zip
 *    (BYTE PARITY, the D-6 disposition, the lead GET counter bump — HEAD
 *    never counts);
 *  - the zip layout rules (go.dev/ref/mod#zip-files): the FIRST
 *    {module}@{version} dir wins, the version is x/mod/semver-gated
 *    (pseudo-versions valid — they are canonical semver with a prerelease;
 *    short v1/v1.0 forms valid), entries below the root skipped, no go.mod →
 *    the synthesized `module {name}`, no @-entry → 400 invalid structure;
 *  - the 404/410 contract: upstream serves 404 for EVERY missing
 *    module/version (never 410 — the client treats the pair alike), with the
 *    list miss carrying the EMPTY body and the resolve misses
 *    "package does not exist";
 *  - the sumdb probe (http.NotFound page), the chi router-page 404 for
 *    unmatched shapes AFTER the gate, the auth challenge arms, the quota
 *    403s (+1 count parity, size cap, admin bypass), the 64 MiB parse cap,
 *    the go.mod 16 MiB cap, the zip-bomb gate, PACKAGES_ENABLED=false.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageProperties, packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import { GoInvalidArchiveError, uploadGoPackage } from "../../services/packages/goproxy";

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
// The zip builder — stored entries (method 0) by default, one deflate-raw
// arm (method 8); `lieSizes` overwrites the recorded uncompressed size (the
// go.mod 16 MiB cap rides the RECORDED size — metadata.go:74 — so the lie
// fires the cap without materializing 16 MiB) and `lieSizes` small values
// arm the zip-bomb gate.
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Override the recorded uncompressed size (cap + bomb arms). */
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

async function makeModuleZip(entries: ZipEntrySpec[]): Promise<Uint8Array> {
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
      u16le(20), // version needed
      u16le(0), // flags
      u16le(method),
      u16le(0), // mod time
      u16le(0), // mod date
      u32le(crc),
      u32le(payload.byteLength), // compressed size
      u32le(recorded), // uncompressed size
      u16le(nameBytes.byteLength),
      u16le(0), // extra length
      nameBytes,
      payload,
    ]);
    chunks.push(local);
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
        u32le(recorded),
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
      u32le(0x06054b50),
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

function goModEntry(module: string, version: string, goMod: string, opts: { method?: 0 | 8; recordedUncompressed?: number } = {}): ZipEntrySpec {
  return {
    name: `${module}@${version}/go.mod`,
    data: new TextEncoder().encode(goMod),
    ...opts,
  };
}

async function uploadGo(owner: string, zip: Uint8Array, auth?: Record<string, string>): Promise<Response> {
  return protocol()(`/api/packages/${owner}/go/upload`, {
    method: "PUT",
    headers: { "content-type": "application/zip", ...auth },
    body: zip.slice(),
  });
}

const GO_MOD = `module gitea.local/hello\n\ngo 1.21\n`;

// ---------------------------------------------------------------------------
// The round-trip
// ---------------------------------------------------------------------------

describe("go proxy upload → list/info/mod/zip round-trip", () => {
  it("uploads a module zip: 201, the go.mod property, the lead {version}.zip, byte-parity download + counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zip = await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]);
    const put = await uploadGo("alice", zip, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.arrayBuffer();

    const pkg = await db().select().from(packages).where(eq(packages.type, "go")).all();
    expect(pkg).toHaveLength(1);
    expect(pkg[0]?.name).toBe("gitea.local/hello");
    expect(pkg[0]?.lowerName).toBe("gitea.local/hello");
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe("v1.0.0");
    const properties = await db().select().from(packageProperties).all();
    expect(properties).toHaveLength(1);
    expect(properties[0]?.refType).toBe(0); // PropertyType.Version
    expect(properties[0]?.name).toBe("go.mod");
    expect(properties[0]?.value).toBe(GO_MOD);

    // @v/list — one per line, upstream's text/plain;charset=utf-8.
    const list = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/list");
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await list.text()).toBe("v1.0.0\n");

    // @v/{v}.info — the {Version, Time} JSON, RFC3339Nano (second-granular
    // rows render no fraction; the UTC `Z` is the AsLocalTime reduction).
    const info = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.info");
    expect(info.status).toBe(200);
    expect(info.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const infoBody = await info.json<{ Version: string; Time: string }>();
    expect(infoBody.Version).toBe("v1.0.0");
    expect(infoBody.Time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const stored = versions[0]?.createdUnix as Date;
    expect(infoBody.Time).toBe(stored.toISOString().replace(/\.000Z$/, "Z"));

    // @latest resolves the same document.
    const latest = await protocol()("/api/packages/alice/go/gitea.local/hello/@latest");
    expect(latest.status).toBe(200);
    expect((await latest.json<{ Version: string }>()).Version).toBe("v1.0.0");

    // @v/{v}.mod — the stored property verbatim.
    const mod = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.mod");
    expect(mod.status).toBe(200);
    expect(mod.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await mod.text()).toBe(GO_MOD);

    // @v/{v}.zip — BYTE PARITY through the D-6 serve shape.
    const download = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.zip");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename=v1.0.0.zip");
    const served = new Uint8Array(await download.arrayBuffer());
    expect(Array.from(served)).toEqual(Array.from(zip));
    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(1); // the lead GET bumped

    // HEAD serves the headers without the counter bump.
    const head = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.zip", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-disposition")).toBe("attachment; filename=v1.0.0.zip");
    expect(head.body).toBeNull();
    const rowsAfterHead = await db().select().from(packageVersions).all();
    expect(rowsAfterHead[0]?.downloadCount).toBe(1);
  });

  it("lists versions in creation order; latest arms resolve the newest; latest.zip downloads", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put1 = await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]), authHeaders(writer));
    expect(put1.status).toBe(201);
    // The integration test sleeps a second for a stable order; pin the
    // created_unix directly instead (a date safely BEFORE the second
    // upload's now).
    await db()
      .update(packageVersions)
      .set({ createdUnix: new Date("2026-01-01T10:00:00Z") })
      .where(eq(packageVersions.version, "v1.0.0"))
      .run();
    const put2 = await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.1", GO_MOD)]), authHeaders(writer));
    expect(put2.status).toBe(201);

    const list = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/list");
    expect(await list.text()).toBe("v1.0.0\nv1.0.1\n");

    const latestInfo = await protocol()("/api/packages/alice/go/gitea.local/hello/@latest");
    expect((await latestInfo.json<{ Version: string }>()).Version).toBe("v1.0.1");
    const latestInfo2 = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/latest.info");
    expect((await latestInfo2.json<{ Version: string }>()).Version).toBe("v1.0.1");
    const latestMod = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/latest.mod");
    expect(await latestMod.text()).toBe(GO_MOD);
    const latestZip = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/latest.zip");
    expect(latestZip.status).toBe(200);
    expect((await latestZip.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const latestRows = await db().select().from(packageVersions).all();
    const bumped = latestRows.find((row) => row.version === "v1.0.1");
    expect(bumped?.downloadCount).toBe(1);
    expect(latestRows.find((row) => row.version === "v1.0.0")?.downloadCount).toBe(0);
  });

  it("uploads a pseudo-version (canonical semver with a prerelease — the go client's sha/date form)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pseudo = "v0.0.0-20230101000000-abcdefabcdef";
    const put = await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", pseudo, GO_MOD)]), authHeaders(writer));
    expect(put.status).toBe(201);

    const list = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/list");
    expect(await list.text()).toBe(`${pseudo}\n`);
    const info = await protocol()(`/api/packages/alice/go/gitea.local/hello/@v/${pseudo}.info`);
    expect(info.status).toBe(200);
    expect((await info.json<{ Version: string }>()).Version).toBe(pseudo);
    const zip = await protocol()(`/api/packages/alice/go/gitea.local/hello/@v/${pseudo}.zip`);
    expect(zip.status).toBe(200);
    const urlEncoded = await protocol()(
      `/api/packages/alice/go/${encodeURIComponent("gitea.local/hello")}/@v/${pseudo}.mod`,
    );
    expect(urlEncoded.status).toBe(200);
    expect(await urlEncoded.text()).toBe(GO_MOD);
  });
});

// ---------------------------------------------------------------------------
// The zip layout rules (metadata.go ParsePackage)
// ---------------------------------------------------------------------------

describe("go zip layout arms", () => {
  it("skips entries below the {module}@{version} root; a rootless layout synthesizes 'module {name}'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // Only a BELOW-root go.mod: the parse never finds a root go.mod → the
    // synthesized `module {name}` (metadata.go:100).
    const put = await uploadGo(
      "alice",
      await makeModuleZip([{ name: "gitea.local/hello@v1.2.3/sub/go.mod", data: new TextEncoder().encode("module other") }]),
      authHeaders(writer),
    );
    expect(put.status).toBe(201);
    const mod = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.2.3.mod");
    expect(await mod.text()).toBe("module gitea.local/hello");
  });

  it("greedy-name capture: the FIRST @-entry names the module and gates the version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // The first @-dir carries a valid version; the second entry (deeper,
    // with its own @ spelling) rides along below the root.
    const zip = await makeModuleZip([
      goModEntry("gitea.local/hello", "v1.0.0", GO_MOD),
      { name: "gitea.local/hello@v1.0.0/internal/deep/go.mod", data: new TextEncoder().encode("ignored") },
    ]);
    const put = await uploadGo("alice", zip, authHeaders(writer));
    expect(put.status).toBe(201);
    const mod = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.mod");
    expect(await mod.text()).toBe(GO_MOD);
  });

  it("accepts the SHORT semver forms (v2, v2.1) exactly like x/mod/semver.IsValid", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", "v2", GO_MOD)]), authHeaders(writer));
    expect(put.status).toBe(201);
    const list = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/list");
    expect(await list.text()).toBe("v2\n");
  });

  it("a non-semver version → 400 'package version is invalid'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadGo(
      "alice",
      await makeModuleZip([goModEntry("gitea.local/hello", "notasemver", GO_MOD)]),
      authHeaders(writer),
    );
    expect(put.status).toBe(400);
    expect(await put.text()).toBe("package version is invalid");
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("a zip without any @-entry → 400 'package has invalid structure'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadGo(
      "alice",
      await makeModuleZip([{ name: "just/a/file.txt", data: new TextEncoder().encode("hi") }]),
      authHeaders(writer),
    );
    expect(put.status).toBe(400);
    expect(await put.text()).toBe("package has invalid structure");
  });

  it("a corrupt (non-zip) body → 500 (zip.NewReader's plain error — the DEFAULT arm)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadGo("alice", new TextEncoder().encode("this is not a zip"), authHeaders(writer));
    expect(put.status).toBe(500);
    expect(await put.text()).toBe("internal server error");
  });

  it("a go.mod entry whose RECORDED size exceeds 16 MiB → 400 'go.mod file is too large'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await uploadGo(
      "alice",
      await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD, { recordedUncompressed: 16 * 1024 * 1024 + 1 })]),
      authHeaders(writer),
    );
    expect(put.status).toBe(400);
    expect(await put.text()).toBe("go.mod file is too large");
  });

  it("a deflated go.mod inflates; a lying recorded size arms the zip-bomb gate → 500", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const ok = await uploadGo(
      "alice",
      await makeModuleZip([goModEntry("gitea.local/deflated", "v1.0.0", GO_MOD, { method: 8 })]),
      authHeaders(writer),
    );
    expect(ok.status).toBe(201);
    const mod = await protocol()("/api/packages/alice/go/gitea.local/deflated/@v/v1.0.0.mod");
    expect(await mod.text()).toBe(GO_MOD);

    const bomb = await uploadGo(
      "alice",
      await makeModuleZip([
        goModEntry("gitea.local/bomb", "v1.0.0", GO_MOD.repeat(20), { method: 8, recordedUncompressed: 10 }),
      ]),
      authHeaders(writer),
    );
    expect(bomb.status).toBe(500);
    await bomb.text();
  });

  it("re-publishing ANY version answers 409 (allowDuplicate=false — even same bytes)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zip = await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]);
    expect((await uploadGo("alice", zip, authHeaders(writer))).status).toBe(201);
    const conflict = await uploadGo("alice", zip, authHeaders(writer));
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe("package version already exists");
    const versions = await db().select().from(packageVersions).all();
    expect(versions).toHaveLength(1);
    // The failed re-publish must not double the go.mod property.
    const properties = await db().select().from(packageProperties).all();
    expect(properties).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The semver gate — the x/mod/semver.IsValid table
// ---------------------------------------------------------------------------

describe("isGoSemverValid (the x/mod/semver port)", () => {
  it("accepts canonical, short, prerelease, build and pseudo-version forms", async () => {
    const { isGoSemverValid } = await import("../../services/packages/goproxy");
    const valid = [
      "v1",
      "v1.0",
      "v1.0.0",
      "v0.0.0",
      "v0.0.0-20230101000000-abcdefabcdef",
      "v1.0.0-alpha",
      "v1.0.0-alpha.1",
      "v1.0.0-0",
      "v1.0.0-0a",
      "v1.0.0-x.7.z.92",
      "v1.0.0+build.1",
      "v1.0.0+01.2", // build identifiers MAY carry leading zeros
      "v1.0.0-rc.1+build.01",
      "v2.0.0+20130313144700-8e1626d84c16", // a pseudo-version with a build tail
    ];
    for (const v of valid) {
      expect(isGoSemverValid(v), v).toBe(true);
    }
  });

  it("rejects missing-v, leading zeros, bad prerelease numerics, empty identifiers, junk", async () => {
    const { isGoSemverValid } = await import("../../services/packages/goproxy");
    const invalid = [
      "",
      "1",
      "1.0",
      "1.0.0",
      "V1.0.0",
      "v",
      "vx.0.0",
      "v01.0.0",
      "v1.00.0",
      "v1.0.01",
      "v1.0.0-01",
      "v1.0.0-",
      "v1.0.0-01.2",
      "v1.0.0+",
      "v1.0.0+01.", // trailing empty build identifier
      "v1.0.0-α",
      "v1.0.0-alpha..1",
      "v1.0.0 junk",
    ];
    for (const v of invalid) {
      expect(isGoSemverValid(v), v).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The 404/410 contract + the router page + the sumdb probe
// ---------------------------------------------------------------------------

describe("go missing-module contract", () => {
  it("the list miss answers the EMPTY-body 404 (apiError(404, nil))", async () => {
    await seedUser("alice");
    const list = await protocol()("/api/packages/alice/go/gitea.local/ghost/@v/list");
    expect(list.status).toBe(404);
    expect(list.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(await list.text()).toBe("");
  });

  it("resolve misses answer 404 'package does not exist' (never 410 — the client treats the pair alike)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]), authHeaders(writer));

    for (const path of [
      "/api/packages/alice/go/gitea.local/ghost/@latest",
      "/api/packages/alice/go/gitea.local/ghost/@v/v1.0.0.info",
      "/api/packages/alice/go/gitea.local/ghost/@v/v1.0.0.mod",
      "/api/packages/alice/go/gitea.local/ghost/@v/v1.0.0.zip",
      // The existing module, missing version — same 404 body.
      "/api/packages/alice/go/gitea.local/hello/@v/v9.9.9.info",
      "/api/packages/alice/go/gitea.local/hello/@v/v9.9.9.mod",
      "/api/packages/alice/go/gitea.local/hello/@v/v9.9.9.zip",
    ]) {
      const res = await protocol()(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe("package does not exist");
    }
  });

  it("unmatched shapes serve chi's router page AFTER the gate; the sumdb probe answers http.NotFound", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]), authHeaders(writer));

    const exe = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/v1.0.0.exe");
    expect(exe.status).toBe(404);
    expect(await exe.text()).toBe("404 page not found\n");
    const bare = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/");
    expect(bare.status).toBe(404);
    expect(await bare.text()).toBe("404 page not found\n");
    const emptyVersion = await protocol()("/api/packages/alice/go/gitea.local/hello/@v/.zip");
    expect(emptyVersion.status).toBe(404);
    expect(await emptyVersion.text()).toBe("404 page not found\n");

    // api.go:308 — the checksum-DB mirror probe: 404 = "not supported".
    const sumdb = await protocol()("/api/packages/alice/go/sumdb/sum.golang.org/supported");
    expect(sumdb.status).toBe(404);
    expect(sumdb.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await sumdb.text()).toBe("404 page not found\n");
  });
});

// ---------------------------------------------------------------------------
// Auth / quota / the family switch
// ---------------------------------------------------------------------------

describe("go auth/quota arms", () => {
  it("anonymous upload → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const zip = await makeModuleZip([goModEntry("gitea.local/denied", "v1.0.0", GO_MOD)]);

    const anon = await uploadGo("alice", zip);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();

    const scoped = await uploadGo("alice", zip, authHeaders(wrongCategory));
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a PUBLIC owner's module downloads anonymously; a PRIVATE owner's are the challenge", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    await uploadGo("alice", await makeModuleZip([goModEntry("gitea.local/pub", "v1.0.0", GO_MOD)]), authHeaders(writer));
    await uploadGo("stealth", await makeModuleZip([goModEntry("gitea.local/sec", "v1.0.0", GO_MOD)]), authHeaders(stealthWriter));

    const publicList = await protocol()("/api/packages/alice/go/gitea.local/pub/@v/list");
    expect(publicList.status).toBe(200);
    await publicList.text();
    const publicZip = await protocol()("/api/packages/alice/go/gitea.local/pub/@v/v1.0.0.zip");
    expect(publicZip.status).toBe(200);
    await publicZip.arrayBuffer();

    const privateList = await protocol()("/api/packages/stealth/go/gitea.local/sec/@v/list");
    expect(privateList.status).toBe(401);
    expect(privateList.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateList.text();
    // The private owner's sumdb probe rides the same gate (chi group order).
    const privateSumdb = await protocol()("/api/packages/stealth/go/sumdb/sum.golang.org/supported");
    expect(privateSumdb.status).toBe(401);
    await privateSumdb.text();
  });

  it("the 403 quota arms: owner-total size var, the +1 count boundary, the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const zip = await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)]);

    const sizeCapped = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })("/api/packages/alice/go/upload", {
      method: "PUT",
      headers: { "content-type": "application/zip", ...authHeaders(writer) },
      body: zip.slice(),
    });
    expect(sizeCapped.status).toBe(403);
    expect(await sizeCapped.text()).toBe("maximum allowed package storage quota exceeded");

    const adminPut = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" })("/api/packages/root/go/upload", {
      method: "PUT",
      headers: { "content-type": "application/zip", ...authHeaders(adminWriter) },
      body: zip.slice(),
    });
    expect(adminPut.status).toBe(201);
    await adminPut.arrayBuffer();

    // The count boundary: the 1st publish reaches the cap, the 2nd 403s
    // (the +1 post-insert parity — count + 1 > limit).
    const countEnv = { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" };
    const first = await protocol(countEnv)("/api/packages/alice/go/upload", {
      method: "PUT",
      headers: { "content-type": "application/zip", ...authHeaders(writer) },
      body: (await makeModuleZip([goModEntry("gitea.local/counted", "v1.0.0", GO_MOD)])).slice(),
    });
    expect(first.status).toBe(201);
    await first.arrayBuffer();
    const second = await protocol(countEnv)("/api/packages/alice/go/upload", {
      method: "PUT",
      headers: { "content-type": "application/zip", ...authHeaders(writer) },
      body: (await makeModuleZip([goModEntry("gitea.local/counted", "v2.0.0", GO_MOD)])).slice(),
    });
    expect(second.status).toBe(403);
    expect(await second.text()).toBe("maximum allowed package count exceeded");
  });

  it("PACKAGES_ENABLED=false 404s the whole family", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const disabled = protocol({ PACKAGES_ENABLED: "false" });

    const put = await disabled("/api/packages/alice/go/upload", {
      method: "PUT",
      headers: { "content-type": "application/zip", ...authHeaders(writer) },
      body: (await makeModuleZip([goModEntry("gitea.local/hello", "v1.0.0", GO_MOD)])).slice(),
    });
    expect(put.status).toBe(404);
    expect(await put.text()).toBe("not found");
    const list = await disabled("/api/packages/alice/go/gitea.local/hello/@v/list");
    expect(list.status).toBe(404);
    await list.text();
  });

  it("an unknown owner 404s with the redirect message; the 64 MiB parse cap throws at the service seam", async () => {
    await seedUser("alice");
    const nobody = await protocol()("/api/packages/nobody/go/gitea.local/hello/@v/list");
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toBe("user redirect does not exist [name: nobody]");

    // Service seam: the parse cap is the maxBytes reduction (64 MiB at the
    // route — unwritable as a body here, so the seam pins the mapping's
    // source: PackageBlobTooLargeError → the route's 413 arm).
    const owner = await seedUser("alice2");
    const small = await makeModuleZip([goModEntry("gitea.local/cap", "v1.0.0", GO_MOD)]);
    await expect(
      uploadGoPackage({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner: { id: owner.id, type: "user", visibility: "public" },
        doer: { id: owner.id, isAdmin: false },
        content: new Response(small.slice()).body as ReadableStream<Uint8Array>,
        declaredLength: small.byteLength,
        quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
        maxBytes: 8,
      }),
    ).rejects.toThrow();
    // And a corrupt body at the service seam throws the archive sentinel the
    // route maps to the 500 DEFAULT arm.
    await expect(
      uploadGoPackage({
        d1: env.DB,
        bucket: env.REPO_PACKS,
        owner: { id: owner.id, type: "user", visibility: "public" },
        doer: { id: owner.id, isAdmin: false },
        content: new Response(new TextEncoder().encode("junk")).body as ReadableStream<Uint8Array>,
        declaredLength: 4,
        quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
      }),
    ).rejects.toBeInstanceOf(GoInvalidArchiveError);
  });
});
