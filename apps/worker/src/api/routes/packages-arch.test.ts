/**
 * The Arch (pacman) registry battery (SPEC-0016 §7 M7) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/arch/arch.go +
 * services/packages/arch/repository.go + vercmp.go + modules/packages/arch/
 * metadata.go at the pin fc4936884584, shapes mirrored from upstream's own
 * integration test (tests/integration/api_packages_arch_test.go):
 *
 *  - the pacman-shaped .pkg.tar.gz upload round-trip (.PKGINFO + member
 *    names) → 201, the stored packages.db;
 *  - the .db structure: a single gzip member whose ustar carries the
 *    `{name}-{version}/files` + `{name}-{version}/desc` pairs (files FIRST,
 *    repository.go:282-287, Mode 0o777), desc = the be_sync.c field document
 *    (%FILENAME%/%MD5SUM-omitted%/%SHA256SUM%/%PGPSIG%/%CSIZE%/%ISIZE%/%NAME%
 *    /%BASE%/%ARCH%/%VERSION%/%DESC%/%URL%/%LICENSE%/%GROUPS%/%BUILDDATE%/
 *    %PACKAGER%/%PROVIDES%... order, empty fields skipped);
 *  - the symlink-dance normalization: ALL the index filename spellings
 *    (packages.db, packages.db.tar.gz, index.db, index.db.tar.gz, index.files,
 *    index.files.tar.gz — the integration test's six-name sweep) serve the
 *    SAME stored bytes, each with a working .sig arm;
 *  - the REAL crypto: the index .sig's RSA-SHA256 OpenPGP packet verifies
 *    over the served .db bytes against the served repository.key, and the
 *    desc's PGPSIG verifies over the UPLOADED package bytes;
 *  - the any-arch merge + the any fallback on serving (any/aarch64/myarch);
 *  - the vercmp fold (KeepLastVersion): the index carries only the highest
 *    version per package, vercmp_test.go's own table pinned verbatim;
 *  - multi-segment + empty repositories; delete → rebuild → the empty-arm
 *    404; the auth/duplicate/format/quota gates.
 *
 * pacman/repo-add are NOT installed on this host (disclosed) — the live
 * arms are the byte-level structure asserts + upstream's own test vectors,
 * the alpine suite's posture.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages as packagesTable, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import {
  asciiBytes,
  base64ToBytes,
  buildTar,
  concatBytes,
  gzipCompress,
  walkGzipMembers,
} from "../../services/packages/distro-common";
import {
  archCompareVersions,
  ArchInvalidArchitectureError,
  ArchInvalidNameError,
  ArchInvalidVersionError,
  parseArchEVR,
  parseArchPackageInfo,
} from "../../services/packages/arch";

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

async function seedUser(username: string, opts: { isAdmin?: boolean } = {}): Promise<SeededUser> {
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
// The pacman-shaped fixture (upstream createPackage, api_packages_arch_test.go
// :36-81): ONE gzip member whose tar carries .PKGINFO + two file members.
// ---------------------------------------------------------------------------

function pkginfoFor(name: string, version: string, arch: string): string {
  return [
    "pkgname = " + name,
    "pkgbase = " + name,
    "pkgver = " + version,
    "pkgdesc = Description",
    "# comment",
    "builddate = 1678834800",
    "size = 8",
    "arch = " + arch,
    "packager = Gitea Builder <builder@example.com>",
    "license = MIT",
    "depend = glibc",
    "provides = " + name + "=" + version,
    "",
  ].join("\n");
}

async function archPkgBytes(name: string, version: string, arch: string, opts: { files?: string[] } = {}): Promise<Uint8Array> {
  const files = opts.files ?? ["etc/dummy", "opt/file/bin"];
  const entries: { name: string; mode: number; data: Uint8Array }[] = [
    { name: ".PKGINFO", mode: 0o600, data: asciiBytes(pkginfoFor(name, version, arch)) },
    ...files.map((file) => ({ name: file, mode: 0o600, data: asciiBytes("test") })),
  ];
  return gzipCompress(buildTar(entries, true));
}

async function uploadPkg(
  owner: string,
  repository: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
  envOverrides: Record<string, string> = {},
): Promise<Response> {
  return protocol(envOverrides)(`/api/packages/${owner}/arch/${repository}`, {
    method: "PUT",
    headers: { "content-length": String(body.byteLength), ...headers },
    body: body as unknown as BodyInit,
  });
}

/** A local tar walk that KEEPS the mode field (readTarMembers hardcodes its
 *  reader mode; the desc/files entries' 0o777 is the upstream pin —
 *  repository.go:390-394 writes Mode os.ModePerm). */
function tarEntriesWithMode(payload: Uint8Array): { name: string; mode: number; data: Uint8Array }[] {
  const entries: { name: string; mode: number; data: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 512 <= payload.byteLength) {
    if ((payload[offset] ?? 0) === 0) break;
    const size = Number.parseInt(new TextDecoder("latin1").decode(payload.subarray(offset + 124, offset + 136)).replace(/\0.*/, "").trim(), 8);
    const mode = Number.parseInt(new TextDecoder("latin1").decode(payload.subarray(offset + 100, offset + 108)).replace(/\0.*/, "").trim(), 8);
    let nameEnd = offset + 100;
    while (nameEnd < offset + 100 && (payload[nameEnd] ?? 0) !== 0) nameEnd++;
    let end = offset;
    while (end < offset + 100 && (payload[end] ?? 0) !== 0) end++;
    const name = new TextDecoder("latin1").decode(payload.subarray(offset, end));
    const dataStart = offset + 512;
    entries.push({ name, mode, data: payload.slice(dataStart, dataStart + size) });
    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

/** Fetch + decompress the served .db and return its tar entries. */
async function servedIndexEntries(owner: string, repository: string, architecture: string, indexName = "packages.db") {
  const res = await protocol()(`/api/packages/${owner}/arch/${repository}/${architecture}/${indexName}`);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const members = await walkGzipMembers(bytes);
  expect(members).toHaveLength(1); // ONE gzip member (upstream's single tar)
  return { res, bytes, entries: tarEntriesWithMode(members[0]?.payload ?? new Uint8Array(0)) };
}

function descOf(entries: { name: string; data: Uint8Array }[], name: string, version: string): string {
  const entry = entries.find((candidate) => candidate.name === `${name}-${version}/desc`);
  if (entry === undefined) throw new Error(`desc member missing for ${name}-${version}`);
  return new TextDecoder().decode(entry.data);
}

function filesOf(entries: { name: string; data: Uint8Array }[], name: string, version: string): string {
  const entry = entries.find((candidate) => candidate.name === `${name}-${version}/files`);
  if (entry === undefined) throw new Error(`files member missing for ${name}-${version}`);
  return new TextDecoder().decode(entry.data);
}

/** The RSA n/e out of the SERVED repository.key armor (the OpenPGP
 *  transferable public key — key packet + userid + self-cert): strip the
 *  frame/CRC lines, parse the new-format key-packet header, then the v4 key
 *  body (04 || creation u32 || algo || MPI(n) || MPI(e)). */
function pgpKeyJwkFromArmor(pem: string): JsonWebKey {
  const base64 = pem
    .replace(/-----[^-]+-----/g, "")
    .replace(/^=.*$/gm, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // First packet: new-format tag 6 (0x98) with a 2- or 3-byte length —
  // RSA-2048 key packets are >191 bytes, so the 3-byte form.
  const firstLen = bytes[1] ?? 0;
  const keyAt = firstLen === 255 ? 6 : firstLen >= 192 && firstLen < 224 ? 3 : 2;
  // Key packet body: version(1) creation(4) algo(1) MPI(n) MPI(e).
  const body = bytes.subarray(keyAt);
  if ((body[0] ?? 0) !== 0x04 || (body[5] ?? 0) !== 0x01) throw new Error("not an RSA v4 key packet");
  const readMpi = (at: number): { value: Uint8Array; next: number } => {
    const bits = ((body[at] ?? 0) << 8) | (body[at + 1] ?? 0);
    const byteLen = Math.ceil(bits / 8);
    return { value: body.slice(at + 2, at + 2 + byteLen), next: at + 2 + byteLen };
  };
  const n = readMpi(6);
  const e = readMpi(n.next);
  const base64url = (value: Uint8Array): string => {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return { kty: "RSA", n: base64url(n.value), e: base64url(e.value), alg: "RS256", key_ops: ["verify"], ext: true };
}

/** WebCrypto verify against the JWK parsed out of the served armor. The
 *  OpenPGP signature covers doc ‖ prefix ‖ trailer (RFC 4880 §5.2.4) and the
 *  prefix/trailer ride INSIDE the packet (the hashed-subpacket area + the
 *  framing trailer) — reconstruct the exact signed byte string from the
 *  packet itself, then hand the MPI + message to WebCrypto. */
async function rsaVerifyJwk(jwk: JsonWebKey, signature: Uint8Array, doc: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const { hashInput, mpi } = openPgpSignedMessage(packetBody(signature), doc);
  // The parsed MPI must BE the packet's trailing MPI (the walk is honest).
  expect([...mpi]).toEqual([...rsaMpiOfPacket(signature)]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, mpi, hashInput);
}

function packetBody(packet: Uint8Array): Uint8Array {
  const firstLen = packet[1] ?? 0;
  let at = 1;
  if (firstLen < 192) at += 1;
  else if (firstLen < 224) at += 2;
  else if (firstLen === 255) at += 5;
  const first = packet[0] ?? 0;
  const tag = first & 0x3f;
  if (tag !== 2) throw new Error("not a signature packet");
  let bodyLen: number;
  if (firstLen < 192) bodyLen = firstLen;
  else if (firstLen < 224) bodyLen = (firstLen - 192) * 256 + (packet[2] ?? 0) + 192;
  else bodyLen = ((packet[2] ?? 0) * 16777216 + (packet[3] ?? 0) * 65536 + (packet[4] ?? 0) * 256 + (packet[5] ?? 0)) | 0;
  return packet.subarray(at, at + bodyLen);
}

function openPgpSignedMessage(body: Uint8Array, doc: Uint8Array): { hashInput: Uint8Array; mpi: Uint8Array } {
  const hashedLen = ((body[4] ?? 0) << 8) | (body[5] ?? 0);
  const prefix = body.slice(0, 6 + hashedLen);
  const framedLen = 6 + hashedLen;
  const trailer = new Uint8Array([
    0x04,
    0xff,
    (framedLen >>> 24) & 0xff,
    (framedLen >>> 16) & 0xff,
    (framedLen >>> 8) & 0xff,
    framedLen & 0xff,
  ]);
  let cursor = 6 + hashedLen;
  const unhashedLen = ((body[cursor] ?? 0) << 8) | (body[cursor + 1] ?? 0);
  cursor += 2 + unhashedLen + 2; // skip unhashed area + left16
  const bits = ((body[cursor] ?? 0) << 8) | (body[cursor + 1] ?? 0);
  const mpi = body.slice(cursor + 2, cursor + 2 + Math.ceil(bits / 8));
  return { hashInput: concatBytes(doc, prefix, trailer), mpi };
}

/** The raw RSA sig bytes out of an OpenPGP v4 signature packet: parse the
 *  new-format header (RFC 4880 §4.2.2 — 2/3/6-byte forms, the distro-common
 *  packetHeader's outputs), then walk version/type/algo/hash + the
 *  hashed/unhashed subpacket areas + left16 to the trailing RSA MPI. */
function rsaMpiOfPacket(packet: Uint8Array): Uint8Array {
  let at = 1;
  const firstLen = packet[at] ?? 0;
  let bodyLen: number;
  if (firstLen < 192) {
    bodyLen = firstLen;
    at += 1;
  } else if (firstLen < 224) {
    bodyLen = (firstLen - 192) * 256 + (packet[at + 1] ?? 0) + 192;
    at += 2;
  } else if (firstLen === 255) {
    bodyLen = ((packet[at + 1] ?? 0) * 16777216 + (packet[at + 2] ?? 0) * 65536 + (packet[at + 3] ?? 0) * 256 + (packet[at + 4] ?? 0)) | 0;
    at += 5;
  } else {
    throw new Error("partial-length packets are not produced here");
  }
  const body = packet.subarray(at, at + bodyLen);
  // body: version(1) sigtype(1) pubalgo(1) hash(1) hashedLen(2) hashed…
  const hashedLen = ((body[4] ?? 0) << 8) | (body[5] ?? 0);
  let cursor = 6 + hashedLen;
  const unhashedLen = ((body[cursor] ?? 0) << 8) | (body[cursor + 1] ?? 0);
  cursor += 2 + unhashedLen;
  cursor += 2; // left16
  const bits = ((body[cursor] ?? 0) << 8) | (body[cursor + 1] ?? 0);
  const byteLen = Math.ceil(bits / 8);
  return body.slice(cursor + 2, cursor + 2 + byteLen);
}

// ---------------------------------------------------------------------------
// vercmp — upstream services/packages/arch/vercmp_test.go VERBATIM
// ---------------------------------------------------------------------------

describe("arch vercmp (vercmp_test.go's own table)", () => {
  it("orders the man-vercmp.8 chains ascending in both directions", () => {
    const checks: string[][] = [
      ["1.0a", "1.0b", "1.0beta", "1.0p", "1.0pre", "1.0rc", "1.0", "1.0.a", "1.0.1"],
      ["1", "1.0", "1.1", "1.1.1", "1.2", "2.0", "3.0.0"],
    ];
    for (const check of checks) {
      for (let i = 0; i < check.length - 1; i++) {
        expect(archCompareVersions(check[i] ?? "", check[i + 1] ?? "")).toBe(-1);
        expect(archCompareVersions(check[i + 1] ?? "", check[i] ?? "")).toBe(1);
      }
    }
  });

  it("pins the epoch/release arms of vercmp_test.go", () => {
    expect(archCompareVersions("1.0-2", "1.0")).toBe(1);
    expect(archCompareVersions("0:1.0-1", "1.0")).toBe(0);
    expect(archCompareVersions("1:1.0-1", "2.0")).toBe(1);
    expect(archCompareVersions("1.0", "1.0")).toBe(0);
  });

  it("parses EVR with the epoch=0/release=1 defaults (vercmp.go:14-30)", () => {
    expect(parseArchEVR("1.4.1")).toEqual({ epoch: "0", version: "1.4.1", release: "1" });
    expect(parseArchEVR("3:2.0-4")).toEqual({ epoch: "3", version: "2.0", release: "4" });
    expect(parseArchEVR("1.0-2")).toEqual({ epoch: "0", version: "1.0", release: "2" });
  });
});

// ---------------------------------------------------------------------------
// The .PKGINFO reader (metadata.go:180-269)
// ---------------------------------------------------------------------------

describe("arch PKGINFO parse", () => {
  it("reads the keyed lines and skips comments", () => {
    const info = parseArchPackageInfo(pkginfoFor("gitea-test", "1.4.1-r3", "aarch64"));
    expect(info.name).toBe("gitea-test");
    expect(info.version).toBe("1.4.1-r3");
    expect(info.versionMetadata.description).toBe("Description");
    expect(info.fileMetadata.architecture).toBe("aarch64");
    expect(info.fileMetadata.build_date).toBe(1678834800);
    expect(info.fileMetadata.installed_size).toBe(8);
    expect(info.versionMetadata.licenses).toEqual(["MIT"]);
    expect(info.fileMetadata.depends).toEqual(["glibc"]);
    expect(info.fileMetadata.provides).toEqual(["gitea-test=1.4.1-r3"]);
    expect(info.fileMetadata.packager).toBe("Gitea Builder <builder@example.com>");
  });

  it("validates the name/version/architecture patterns (metadata.go:254-262 + metadata_test.go's Regexp table)", () => {
    expect(() => parseArchPackageInfo("pkgname = bad name!\npkgver = 1.0\narch = x86_64")).toThrow(ArchInvalidNameError);
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = \narch = x86_64")).toThrow(ArchInvalidVersionError);
    // metadata_test.go's NotRegexp vectors: non-digit epoch, slash, space.
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = a:1.0.0-1\narch = x86_64")).toThrow(ArchInvalidVersionError);
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = 0.0.1/1-1\narch = x86_64")).toThrow(ArchInvalidVersionError);
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = 1.0.0 -1\narch = x86_64")).toThrow(ArchInvalidVersionError);
    // ...and the Regexp vectors accept.
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = 1.2_3~4+5\narch = x86_64")).not.toThrow();
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = 1:2_3~4+5\narch = x86_64")).not.toThrow();
    expect(() => parseArchPackageInfo("pkgname = ok\npkgver = 1.0")).toThrow(ArchInvalidArchitectureError);
  });

  it("mirrors metadata_test.go's Valid field sweep (xdata/backup/group/conflict/makedepend/checkdepend)", () => {
    const info = parseArchPackageInfo(
      [
        "pkgname = gitea",
        "pkgbase = gitea",
        "pkgver = 1.0.1",
        "pkgdesc = Package Description",
        "url = https://gitea.com",
        "# comment",
        "group=group",
        "builddate = 1678834800",
        "size = 123456",
        "arch = x86_64",
        "license = MIT",
        "packager = KN4CK3R <packager@gitea.com>",
        "depend = common",
        "xdata = value",
        "depend = gitea",
        "provides = common",
        "provides = gitea",
        "optdepend = hex",
        "replaces = gogs",
        "checkdepend = common",
        "makedepend = cmake",
        "conflict = ninja",
        "backup = usr/bin/paket1",
        "",
      ].join("\n"),
    );
    expect(info.name).toBe("gitea");
    expect(info.fileMetadata.base).toBe("gitea");
    expect(info.version).toBe("1.0.1");
    expect(info.versionMetadata.description).toBe("Package Description");
    expect(info.versionMetadata.project_url).toBe("https://gitea.com");
    expect(info.versionMetadata.licenses).toEqual(["MIT"]);
    expect(info.fileMetadata.packager).toBe("KN4CK3R <packager@gitea.com>");
    expect(info.fileMetadata.build_date).toBe(1678834800);
    expect(info.fileMetadata.installed_size).toBe(123456);
    expect(info.fileMetadata.architecture).toBe("x86_64");
    expect(info.fileMetadata.xdata).toEqual(["value"]);
    expect(info.fileMetadata.groups).toEqual(["group"]);
    expect(info.fileMetadata.provides).toEqual(["common", "gitea"]);
    expect(info.fileMetadata.depends).toEqual(["common", "gitea"]);
    expect(info.fileMetadata.replaces).toEqual(["gogs"]);
    expect(info.fileMetadata.opt_depends).toEqual(["hex"]);
    expect(info.fileMetadata.check_depends).toEqual(["common"]);
    expect(info.fileMetadata.conflicts).toEqual(["ninja"]);
    expect(info.fileMetadata.make_depends).toEqual(["cmake"]);
    expect(info.fileMetadata.backup).toEqual(["usr/bin/paket1"]);
  });

  it("clears a non-http(s) url like upstream's IsValidURL gate", () => {
    const info = parseArchPackageInfo("pkgname = ok\npkgver = 1.0\narch = any\nurl = ftp://example.com/x");
    expect(info.versionMetadata.project_url).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The round-trip: upload → the stored .db → the normalized serving family
// ---------------------------------------------------------------------------

describe("arch upload → packages.db → download", () => {
  it("round-trips an upload with the desc/files tar, 0o777 modes, and the six index spellings", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("gitea-test", "1.4.1-r3", "aarch64");
    expect((await uploadPkg("alice", "main", pkg, authHeaders(writer))).status).toBe(201);

    // The one stored index: exactly TWO members (files FIRST then desc —
    // repository.go:282-287), Mode 0o777 (os.ModePerm), field format
    // `%KEY%\nvalue\n\n`.
    const { entries, bytes } = await servedIndexEntries("alice", "main", "aarch64");
    expect(entries.map((entry) => entry.name)).toEqual(["gitea-test-1.4.1-r3/files", "gitea-test-1.4.1-r3/desc"]);
    for (const entry of entries) expect(entry.mode).toBe(0o777);

    const desc = descOf(entries, "gitea-test", "1.4.1-r3");
    expect(desc).toContain("%FILENAME%\ngitea-test-1.4.1-r3-aarch64.pkg.tar.gz\n\n");
    // MD5SUM omitted (the blobs.ts posture — the empty field is skipped,
    // writeFields' `if kv.Value == "" continue`), SHA256SUM present.
    expect(desc).not.toContain("%MD5SUM%");
    expect(desc).toMatch(/%SHA256SUM%\n[0-9a-f]{64}\n\n/);
    expect(desc).toContain("%CSIZE%\n" + String(pkg.byteLength) + "\n\n");
    expect(desc).toContain("%ISIZE%\n8\n\n");
    expect(desc).toContain("%NAME%\ngitea-test\n\n");
    expect(desc).toContain("%BASE%\ngitea-test\n\n");
    expect(desc).toContain("%ARCH%\naarch64\n\n");
    expect(desc).toContain("%VERSION%\n1.4.1-r3\n\n");
    expect(desc).toContain("%DESC%\nDescription\n\n");
    expect(desc).toContain("%LICENSE%\nMIT\n\n");
    expect(desc).toContain("%BUILDDATE%\n1678834800\n\n");
    expect(desc).toContain("%PACKAGER%\nGitea Builder <builder@example.com>\n\n");
    expect(desc).toContain("%PROVIDES%\ngitea-test=1.4.1-r3\n\n");
    expect(desc).toContain("%DEPENDS%\nglibc\n\n");
    // Empty-value fields are skipped (BASE-adjacent: CONFLICTS/REPLACES/GROUPS…).
    expect(desc).not.toContain("%CONFLICTS%");
    expect(desc).not.toContain("%URL%");

    const files = filesOf(entries, "gitea-test", "1.4.1-r3");
    expect(files).toBe("%FILES%\netc/dummy\nopt/file/bin\n\n");

    // The symlink-dance normalization (arch.go:186-197): every spelling
    // serves the SAME stored bytes, each with a working .sig arm —
    // the integration test's six-name sweep.
    for (const indexName of ["packages.db", "packages.db.tar.gz", "index.db", "index.db.tar.gz", "index.files", "index.files.tar.gz"]) {
      const res = await protocol()(`/api/packages/alice/arch/main/aarch64/${indexName}`);
      expect(res.status).toBe(200);
      const same = new Uint8Array(await res.arrayBuffer());
      expect([...same]).toEqual([...bytes]);
      const sig = await protocol()(`/api/packages/alice/arch/main/aarch64/${indexName}.sig`);
      expect(sig.status).toBe(200);
    }

    // THE REAL CRYPTO: the index .sig (RSA-SHA256 OpenPGP packet) verifies
    // over the served .db bytes against the n/e parsed out of the SERVED
    // repository.key armor (the full OpenPGP framing end-to-end).
    const keyRes = await protocol()("/api/packages/alice/arch/repository.key");
    expect(keyRes.status).toBe(200);
    expect(keyRes.headers.get("content-type")).toBe("application/pgp-keys");
    const keyPem = await keyRes.text();
    expect(keyPem).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    const keyJwk = pgpKeyJwkFromArmor(keyPem);
    const sigRes = await protocol()("/api/packages/alice/arch/main/aarch64/packages.db.sig");
    const packet = new Uint8Array(await sigRes.arrayBuffer());
    expect(rsaMpiOfPacket(packet).byteLength).toBe(256); // RSA-2048
    // SignData signs the STORED index bytes (the gz buffer, repository.go:293
    // — indexContent, not its decompressed payload).
    const ok = await rsaVerifyJwk(keyJwk, packet, bytes);
    expect(ok).toBe(true);
    const tampered = bytes.slice(0, bytes.byteLength - 1);
    expect(await rsaVerifyJwk(keyJwk, packet, tampered)).toBe(false);

    // …and the desc's PGPSIG is the package file's own signature, verifiable
    // over the UPLOADED bytes.
    const pgpsigMatch = /%PGPSIG%\n([A-Za-z0-9+/=]+)\n\n/.exec(desc);
    expect(pgpsigMatch).not.toBeNull();
    const descSig = base64ToBytes(pgpsigMatch?.[1] ?? "");
    const pkgSigRes = await protocol()("/api/packages/alice/arch/main/aarch64/gitea-test-1.4.1-r3-aarch64.pkg.tar.gz.sig");
    expect(pkgSigRes.status).toBe(200);
    expect([...new Uint8Array(await pkgSigRes.arrayBuffer())]).toEqual([...descSig]);
    const pkgOk = await rsaVerifyJwk(keyJwk, descSig, pkg);
    expect(pkgOk).toBe(true);
  });

  it("downloads the package file with byte parity (no counter bump — arch.go serves bare)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    await uploadPkg("alice", "main", pkg, authHeaders(writer));

    const get = await protocol()("/api/packages/alice/arch/main/x86_64/helloworld-1.0-1-x86_64.pkg.tar.gz");
    expect(get.status).toBe(200);
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...pkg]);

    const rows = await db()
      .select({ version: packageVersions })
      .from(packageVersions)
      .innerJoin(packagesTable, eq(packagesTable.id, packageVersions.packageId))
      .where(and(eq(packagesTable.isInternal, false), eq(packageVersions.isInternal, false)))
      .all();
    expect(rows[0]?.version.downloadCount).toBe(0);
  });

  it("serves multi-segment and empty repositories (the <repository:*> wildcard)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("slashed", "2.0-1", "x86_64");
    expect((await uploadPkg("alice", "with/slash", pkg, authHeaders(writer))).status).toBe(201);
    expect((await servedIndexEntries("alice", "with/slash", "x86_64")).res.status).toBe(200);
    expect(descOf((await servedIndexEntries("alice", "with/slash", "x86_64")).entries, "slashed", "2.0-1")).toContain("%NAME%\nslashed\n\n");

    // repository "" — the bare PUT (api.go:120) + the tail-pinned GET with an
    // empty prefix (the integration test's KeepLastVersion shape).
    const emptyPkg = await archPkgBytes("bare", "0.1-1", "any");
    const barePut = await protocol()("/api/packages/alice/arch/", {
      method: "PUT",
      headers: { "content-length": String(emptyPkg.byteLength), ...authHeaders(writer) },
      body: emptyPkg as unknown as BodyInit,
    });
    expect(barePut.status).toBe(201);
    const bareIndex = await protocol()("/api/packages/alice/arch/any/packages.db");
    expect(bareIndex.status).toBe(200);
    const bareBytes = new Uint8Array(await bareIndex.arrayBuffer());
    const barePayload = (await walkGzipMembers(bareBytes))[0]?.payload ?? new Uint8Array(0);
    const bareEntries = tarEntriesWithMode(barePayload);
    expect(bareEntries.map((entry) => entry.name)).toEqual(["bare-0.1-1/files", "bare-0.1-1/desc"]);
  });
});

// ---------------------------------------------------------------------------
// The any-arch merge + the serving fallback (repository.go:155-163/:194-201,
// arch.go:204-216)
// ---------------------------------------------------------------------------

describe("arch any-architecture merge and fallback", () => {
  it("merges any files into every architecture index and falls back on serving", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const x86 = await archPkgBytes("helloworld", "1.2-1", "x86_64");
    const any = await archPkgBytes("scripts", "2.0-1", "any");
    expect((await uploadPkg("alice", "main", x86, authHeaders(writer))).status).toBe(201);
    expect((await uploadPkg("alice", "main", any, authHeaders(writer))).status).toBe(201);

    const { entries } = await servedIndexEntries("alice", "main", "x86_64");
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      ["helloworld-1.2-1/desc", "helloworld-1.2-1/files", "scripts-2.0-1/desc", "scripts-2.0-1/files"].sort(),
    );
    expect(descOf(entries, "scripts", "2.0-1")).toContain("%ARCH%\nany\n\n");
    expect(descOf(entries, "helloworld", "1.2-1")).toContain("%ARCH%\nx86_64\n\n");
    expect(descOf(entries, "helloworld", "1.2-1")).not.toContain("%ARCH%\nany\n\n");

    // The any package file serves under ANY requested architecture.
    for (const arch of ["any", "x86_64", "myarch"]) {
      const res = await protocol()(`/api/packages/alice/arch/main/${arch}/scripts-2.0-1-any.pkg.tar.gz`);
      expect(res.status).toBe(200);
    }
    // The x86_64 package does NOT serve under a foreign architecture.
    const miss = await protocol()("/api/packages/alice/arch/main/any/helloworld-1.2-1-x86_64.pkg.tar.gz");
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The vercmp fold (repository.go:225-235) — the KeepLastVersion shape
// ---------------------------------------------------------------------------

describe("arch index keeps the highest version (vercmp consumer)", () => {
  it("drops the older entry on re-upload and restores it after a delete", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const v1 = await archPkgBytes("gitea-test", "1.0.0", "aarch64");
    const v2 = await archPkgBytes("gitea-test", "1.0.1", "aarch64");
    expect((await uploadPkg("alice", "", v1, authHeaders(writer))).status).toBe(201);
    expect((await uploadPkg("alice", "", v2, authHeaders(writer))).status).toBe(201);

    const { entries } = await servedIndexEntries("alice", "", "aarch64");
    expect(entries.map((entry) => entry.name)).toEqual(["gitea-test-1.0.1/files", "gitea-test-1.0.1/desc"]);

    // Delete 1.0.1 → the index re-rolls with 1.0.0 (the rebuild rider).
    const del = await protocol()("/api/packages/alice/arch/gitea-test/1.0.1/aarch64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);
    const after = await servedIndexEntries("alice", "", "aarch64");
    expect(after.entries.map((entry) => entry.name)).toEqual(["gitea-test-1.0.0/files", "gitea-test-1.0.0/desc"]);
  });
});

// ---------------------------------------------------------------------------
// Delete arms + the empty-repository index 404
// ---------------------------------------------------------------------------

describe("arch delete → rebuild → the empty arm", () => {
  it("deletes the last file and the index 404s with the empty body", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    await uploadPkg("alice", "main", pkg, authHeaders(writer));
    expect((await servedIndexEntries("alice", "main", "x86_64")).res.status).toBe(200);

    const del = await protocol()("/api/packages/alice/arch/main/helloworld/1.0-1/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);

    const index = await protocol()("/api/packages/alice/arch/main/x86_64/packages.db");
    expect(index.status).toBe(404); // the empty arm deleted the index
    expect(await index.text()).toBe("");
  });

  it("distinguishes the two 404 bodies on delete (resource-missing vs empty)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // Version miss → the not-exist sentinel body (arch.go:268-275).
    const versionMiss = await protocol()("/api/packages/alice/arch/main/ghost/9.9.9/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(versionMiss.status).toBe(404);
    expect(await versionMiss.text()).toBe("resource does not exist");

    // A real version whose file is elsewhere → the EMPTY body (arch.go:285-288).
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    await uploadPkg("alice", "main", pkg, authHeaders(writer));
    const fileMiss = await protocol()("/api/packages/alice/arch/testing/helloworld/1.0-1/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(fileMiss.status).toBe(404);
    expect(await fileMiss.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The gates (arch.go:43-70 + :115-118 + :149-158)
// ---------------------------------------------------------------------------

describe("arch validation and gates", () => {
  it("rejects an unsupported container with 400 (zst/xz are the documented reduction)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const zst = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const res = await uploadPkg("alice", "main", zst, authHeaders(writer));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("unsupported package container format");
    const xz = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect((await uploadPkg("alice", "main", xz, authHeaders(writer))).status).toBe(400);
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]);
    expect((await uploadPkg("alice", "main", junk, authHeaders(writer))).status).toBe(400);
  });

  it("rejects a PKGINFO-less archive and an empty body with 400", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const garbage = await gzipCompress(asciiBytes("nothing here"));
    const res = await uploadPkg("alice", "main", garbage, authHeaders(writer));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(".PKGINFO file is missing");
  });

  it("answers 409 on the same file re-upload and 401 anonymous/wrong-scope", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    expect((await uploadPkg("alice", "main", pkg, authHeaders(writer))).status).toBe(201);
    const again = await uploadPkg("alice", "main", pkg, authHeaders(writer));
    expect(again.status).toBe(409);
    expect(await again.text()).toBe("package file already exists");

    const anon = await uploadPkg("alice", "main", pkg);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');

    const reader = await token(owner, "read:package");
    const readonly = await uploadPkg("alice", "main", pkg, authHeaders(reader));
    expect(readonly.status).toBe(401);
  });

  it("enforces the count quota (+1 parity) and the enabled gate", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    expect((await uploadPkg("alice", "main", pkg, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" })).status).toBe(201);
    const second = await uploadPkg("alice", "testing", pkg, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" });
    expect(second.status).toBe(403);

    const disabled = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/arch/repository.key");
    expect(disabled.status).toBe(404);
  });

  it("routes the wildcard grammar: short GET/DELETE remainders 404 at the walk", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("helloworld", "1.0-1", "x86_64");
    await uploadPkg("alice", "main", pkg, authHeaders(writer));
    // GET with one segment has no architecture/filename tail → 404.
    const shortGet = await protocol()("/api/packages/alice/arch/lonely", { headers: authHeaders(writer) });
    expect(shortGet.status).toBe(404);
    // DELETE with two segments → 404.
    const shortDel = await protocol()("/api/packages/alice/arch/helloworld/1.0-1", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(shortDel.status).toBe(404);
    // The bare index GET with the empty repository (the two-segment tail).
    const okGet = await protocol()("/api/packages/alice/arch/main/x86_64/packages.db");
    expect(okGet.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The file-list metadata: the desc/files entries flow from the uploaded tar
// (joinFields' newline-forgery gate is metadata.go:158-160's skip)
// ---------------------------------------------------------------------------

describe("arch file list metadata", () => {
  it("carries the package's member names into the FILES field", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const pkg = await archPkgBytes("listed", "3.1-2", "any", { files: ["usr/bin/listed", "etc/listed.conf"] });
    await uploadPkg("alice", "main", pkg, authHeaders(writer));
    const { entries } = await servedIndexEntries("alice", "main", "any");
    expect(filesOf(entries, "listed", "3.1-2")).toBe("%FILES%\nusr/bin/listed\netc/listed.conf\n\n");
  });

  it("concatenates multi-member gzips like upstream's multistream reader", async () => {
    // Go's gzip.Reader defaults to multistream and its tar.Reader stops at
    // the end-of-archive marker — so the parity fixture carries .PKGINFO in
    // an END-BLOCK-LESS first member (the stream continues into member B's
    // tar) and the file member in the second.
    const memberA = await gzipCompress(buildTar([{ name: ".PKGINFO", mode: 0o600, data: asciiBytes(pkginfoFor("twomem", "1.0-1", "any")) }], false));
    const memberB = await gzipCompress(buildTar([{ name: "usr/bin/twomem", mode: 0o755, data: asciiBytes("test") }], true));
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const upload = await uploadPkg("alice", "main", concatBytes(memberA, memberB), authHeaders(writer));
    expect(upload.status).toBe(201);
    const { entries } = await servedIndexEntries("alice", "main", "any");
    expect(filesOf(entries, "twomem", "1.0-1")).toBe("%FILES%\nusr/bin/twomem\n\n");
  });
});
