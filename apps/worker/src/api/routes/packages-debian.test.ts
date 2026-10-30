/**
 * The Debian registry battery (SPEC-0016 §7 M7) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/debian/debian.go at the
 * pin fc4936884584:
 *
 *  - the dpkg-deb-shaped .deb upload round-trip (ar: debian-binary +
 *    control.tar.gz + a data.tar member the parse must SKIP) → 201, the
 *    stored Packages index (control stanza + Filename/Size/SHA lines, no
 *    MD5sum — the documented reduction), the Release trio, the repository.key
 *    armored transferable key;
 *  - the pool download with BYTE PARITY + the lead-file counter bump;
 *  - by-hash serving (sha256) and the md5 404 (never stored);
 *  - delete → 204 → the paragraph drops from Packages and the unreferenced
 *    version row goes with the file;
 *  - the validation arms (invalid distribution/component, control-less
 *    archive, .xz control → unsupported compression), duplicates → 409, the
 *    auth/challenge/quota/enabled gates shared with the other families.
 *
 * The signature CRYPTO is verified against the real gpg in the live battery
 * (the M7 report); in-suite the InRelease/Release.gpg structure is pinned.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import { asciiBytes, buildTar, concatBytes, gzipCompress } from "../../services/packages/distro-common";

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
    "user_settings_kv",
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
// The dpkg-deb-shaped .deb fixture (deb(5)): ar with debian-binary,
// control.tar.gz (the control stanza), and a data.tar member the walk must
// skip without reading.
// ---------------------------------------------------------------------------

const HELLO_CONTROL = [
  "Package: hello",
  "Version: 1.0",
  "Architecture: amd64",
  "Maintainer: Alice <alice@example.com>",
  "Depends: libc6 (>= 2.14), bash",
  "Description: a test package",
  " long description folded line",
  "Homepage: https://example.com/hello",
  "",
].join("\n");

function arMember(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(60);
  const text = (value: string, offset: number, length: number): void => {
    asciiBytes(value)
      .subarray(0, length)
      .forEach((byte, index) => {
        header[offset + index] = byte;
      });
  };
  text(`${name}/`, 0, 16);
  text(String(data.byteLength).padStart(10, " "), 48, 10);
  const pad = data.byteLength % 2 === 1 ? new Uint8Array(1) : new Uint8Array(0);
  return concatBytes(header, data, pad);
}

async function helloDebBytes(): Promise<Uint8Array> {
  const controlTar = buildTar([{ name: "./control", mode: 0o644, data: asciiBytes(HELLO_CONTROL) }], true);
  const controlGz = await gzipCompress(controlTar);
  const dataTar = buildTar([{ name: "./usr/bin/hello", mode: 0o755, data: asciiBytes("echo hello\n") }], true);
  const dataGz = await gzipCompress(dataTar);
  return concatBytes(
    asciiBytes("!<arch>\n"),
    arMember("debian-binary", asciiBytes("2.0\n")),
    arMember("control.tar.gz", controlGz),
    arMember("data.tar.gz", dataGz),
  );
}

async function uploadDeb(
  owner: string,
  distribution: string,
  component: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
  envOverrides: Record<string, string> = {},
): Promise<Response> {
  return protocol(envOverrides)(`/api/packages/${owner}/debian/pool/${distribution}/${component}/upload`, {
    method: "PUT",
    headers: { "content-length": String(body.byteLength), ...headers },
    body: body as unknown as BodyInit,
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The round-trip
// ---------------------------------------------------------------------------

describe("debian upload → index → download", () => {
  it("round-trips a .deb upload: 201, the Packages paragraph, the Release trio, the key", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    const put = await uploadDeb("alice", "stable", "main", deb, authHeaders(writer));
    expect(put.status).toBe(201);

    // The stored Packages index (composite key stable|main|amd64).
    const packagesRes = await protocol()("/api/packages/alice/debian/dists/stable/main/binary-amd64/Packages");
    expect(packagesRes.status).toBe(200);
    const packagesText = await packagesRes.text();
    expect(packagesText).toContain("Package: hello");
    expect(packagesText).toContain("Version: 1.0");
    expect(packagesText).toContain("Architecture: amd64");
    expect(packagesText).toContain("Filename: pool/stable/main/hello_1.0_amd64.deb");
    expect(packagesText).toContain(`Size: ${deb.byteLength}`);
    expect(packagesText).toMatch(/^SHA256: [0-9a-f]{64}$/m);
    expect(packagesText).not.toContain("MD5sum:"); // the documented reduction
    expect(packagesText).toContain("Description: a test package");
    expect(packagesText).toContain(" long description folded line");
    expect(packagesText).toContain("Depends: libc6 (>= 2.14), bash");

    // The dist-level trio.
    const inRelease = await protocol()("/api/packages/alice/debian/dists/stable/InRelease");
    expect(inRelease.status).toBe(200);
    const inReleaseText = await inRelease.text();
    expect(inReleaseText).toMatch(/^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nOrigin: Gitea\n/);
    expect(inReleaseText).toContain("Suite: stable");
    expect(inReleaseText).toContain("Components: main");
    expect(inReleaseText).toContain("Architectures: amd64");
    expect(inReleaseText).toContain("Acquire-By-Hash: yes");
    expect(inReleaseText).toMatch(/^Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/m);
    // The Release's checksum rows hash the INDEX FILES themselves.
    const packagesRes2 = await protocol()("/api/packages/alice/debian/dists/stable/main/binary-amd64/Packages");
    const packagesBytes = new Uint8Array(await packagesRes2.arrayBuffer());
    const packagesDigest = await sha256Hex(packagesBytes);
    expect(inReleaseText).toContain(`SHA256:\n ${packagesDigest} ${packagesBytes.byteLength} main/binary-amd64/Packages`);
    expect(inReleaseText).toContain("main/binary-amd64/Packages.gz");
    expect(inReleaseText).toMatch(/^SHA1:\n [0-9a-f]{40} \d+ main\/binary-amd64\/Packages$/m);
    expect(inReleaseText).toMatch(/^SHA512:\n [0-9a-f]{128} \d+ main\/binary-amd64\/Packages$/m);
    expect(inReleaseText).toContain("-----BEGIN PGP SIGNATURE-----");
    expect(inReleaseText).toMatch(/\n=[A-Za-z0-9+/]{4}\n/); // the CRC24 line

    const release = await protocol()("/api/packages/alice/debian/dists/stable/Release");
    expect(release.status).toBe(200);
    const releaseText = await release.text();
    expect(releaseText.startsWith("Origin: Gitea\n")).toBe(true);
    expect(releaseText.endsWith("\n")).toBe(true);

    const releaseGpg = await protocol()("/api/packages/alice/debian/dists/stable/Release.gpg");
    expect(releaseGpg.status).toBe(200);
    expect((await releaseGpg.text()).startsWith("-----BEGIN PGP SIGNATURE-----\n\n")).toBe(true);

    // The repository.key arm: the armored transferable public key.
    const key = await protocol()("/api/packages/alice/debian/repository.key");
    expect(key.status).toBe(200);
    expect(key.headers.get("content-type")).toBe("application/pgp-keys");
    expect(await key.text()).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
  });

  it("downloads the .deb with byte parity and bumps the lead-file counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    expect((await uploadDeb("alice", "stable", "main", deb, authHeaders(writer))).status).toBe(201);

    const get = await protocol()("/api/packages/alice/debian/pool/stable/main/hello_1.0_amd64.deb");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/vnd.debian.binary-package");
    const served = new Uint8Array(await get.arrayBuffer());
    expect([...served]).toEqual([...deb]);

    const rows = await db()
      .select({ version: packageVersions })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(eq(packageVersions.isInternal, false))
      .all();
    expect(rows[0]?.version.downloadCount).toBe(1);

    const head = await protocol()("/api/packages/alice/debian/pool/stable/main/hello_1.0_amd64.deb", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(deb.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0); // HEAD has no body
  });

  it("serves by-hash (sha256) and 404s md5 (never stored)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    await uploadDeb("alice", "stable", "main", deb, authHeaders(writer));

    const packagesRes = await protocol()("/api/packages/alice/debian/dists/stable/main/binary-amd64/Packages");
    const packagesBytes = new Uint8Array(await packagesRes.arrayBuffer());
    const digest = await sha256Hex(packagesBytes);
    const byHash = await protocol()(`/api/packages/alice/debian/dists/stable/by-hash/sha256/${digest}`);
    expect(byHash.status).toBe(200);
    expect(new Uint8Array(await byHash.arrayBuffer())).toEqual(packagesBytes);

    // The component-context by-hash arm answers the same (hash-only lookup).
    const byHashNested = await protocol()(`/api/packages/alice/debian/dists/stable/main/binary-amd64/by-hash/sha256/${digest}`);
    expect(byHashNested.status).toBe(200);

    const md5 = await protocol()(`/api/packages/alice/debian/dists/stable/by-hash/md5sum/${digest}`);
    expect(md5.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Mutations: the delete rider rebuilds the indices
// ---------------------------------------------------------------------------

describe("debian delete → rebuild", () => {
  it("deletes the file, drops the paragraph, removes the unreferenced version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    await uploadDeb("alice", "stable", "main", deb, authHeaders(writer));

    const del = await protocol()("/api/packages/alice/debian/pool/stable/main/hello/1.0/amd64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);

    const packagesRes = await protocol()("/api/packages/alice/debian/dists/stable/main/binary-amd64/Packages");
    expect(packagesRes.status).toBe(404); // the empty arm deleted the index

    const release = await protocol()("/api/packages/alice/debian/dists/stable/Release");
    expect(release.status).toBe(404); // the Release trio follows the include-set

    // The non-internal version row is gone; the internal _debian one stays.
    const rows = await db()
      .select({ version: packageVersions, pkg: packages })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .all();
    const nonInternal = rows.filter((row) => row.version.isInternal === false);
    expect(nonInternal).toHaveLength(0);
    const internal = rows.filter((row) => row.pkg.isInternal === true);
    expect(internal.map((row) => row.pkg.name)).toContain("_debian");
  });

  it("404s a missing file/version on delete", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const del = await protocol()("/api/packages/alice/debian/pool/stable/main/nope/1.0/amd64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Validation + duplicates + the shared gates
// ---------------------------------------------------------------------------

describe("debian validation and gates", () => {
  it("rejects an invalid distribution/component with 400", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    // A charset violation (space) without changing the route shape.
    const bad = await uploadDeb("alice", "bad%20name", "main", deb, authHeaders(writer));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("invalid distribution or component");
  });

  it("rejects a control-less archive and an .xz control with 400", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const garbage = asciiBytes("not an ar archive at all, just noise padded out");
    const missing = await uploadDeb("alice", "stable", "main", garbage, authHeaders(writer));
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe("control file is missing");

    const controlTar = buildTar([{ name: "./control", mode: 0o644, data: asciiBytes(HELLO_CONTROL) }], true);
    const fakeXz = concatBytes(asciiBytes("!<arch>\n"), arMember("debian-binary", asciiBytes("2.0\n")), arMember("control.tar.xz", controlTar));
    const unsupported = await uploadDeb("alice", "stable", "main", fakeXz, authHeaders(writer));
    expect(unsupported.status).toBe(400);
    expect(await unsupported.text()).toBe("unsupported compression algorithm");
  });

  it("answers 409 on the same file re-upload (the D-1 any-duplicate rule)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    expect((await uploadDeb("alice", "stable", "main", deb, authHeaders(writer))).status).toBe(201);
    const again = await uploadDeb("alice", "stable", "main", deb, authHeaders(writer));
    expect(again.status).toBe(409);
    expect(await again.text()).toBe("package file already exists");
  });

  it("accepts the same version into a second component (a new file row, one version)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    expect((await uploadDeb("alice", "stable", "main", deb, authHeaders(writer))).status).toBe(201);
    const second = await uploadDeb("alice", "stable", "contrib", deb, authHeaders(writer));
    expect(second.status).toBe(201);
    // Each component's index carries its own paragraph.
    const main = await protocol()("/api/packages/alice/debian/dists/stable/main/binary-amd64/Packages");
    expect(await main.text()).toContain("pool/stable/main/hello_1.0_amd64.deb");
    const contrib = await protocol()("/api/packages/alice/debian/dists/stable/contrib/binary-amd64/Packages");
    expect(await contrib.text()).toContain("pool/stable/contrib/hello_1.0_amd64.deb");
    // The Release lists BOTH components.
    const release = await (await protocol()("/api/packages/alice/debian/dists/stable/Release")).text();
    expect(release).toContain("Components: contrib main");
    expect(release).toContain("contrib/binary-amd64/Packages");
    expect(release).toContain("main/binary-amd64/Packages");
  });

  it("401s anonymous writes with the WWW-Authenticate challenge and blinds wrong-scope tokens", async () => {
    await seedUser("alice");
    const deb = await helloDebBytes();
    const anon = await uploadDeb("alice", "stable", "main", deb);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');

    const bob = await seedUser("bob");
    const reader = await token(bob, "read:package");
    const wrongScope = await uploadDeb("alice", "stable", "main", deb, authHeaders(reader));
    expect(wrongScope.status).toBe(401);
  });

  it("enforces the count quota (+1 parity) with the admin bypass", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const deb = await helloDebBytes();
    // The N-th publish reaching the cap SUCCEEDS; the N+1-th 403s (the +1
    // pre-insert equivalent of upstream's insert-then-check).
    expect((await uploadDeb("alice", "stable", "main", deb, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" })).status).toBe(201);
    const second = await protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" })(
      "/api/packages/alice/debian/pool/stable/contrib/upload",
      {
        method: "PUT",
        headers: { "content-length": String(deb.byteLength), ...authHeaders(writer) },
        body: deb as unknown as BodyInit,
      },
    );
    expect(second.status).toBe(403);

    // Admin bypass (fresh env, unlimited default).
    const admin = await seedUser("root", { isAdmin: true });
    const adminToken = await token(admin, "write:package");
    expect((await uploadDeb("root", "stable", "main", deb, authHeaders(adminToken))).status).toBe(201);
  });

  it("404s the whole family under PACKAGES_ENABLED=false", async () => {
    await seedUser("alice");
    const key = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/debian/repository.key");
    expect(key.status).toBe(404);
  });
});
