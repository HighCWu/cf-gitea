/**
 * The RPM (yum/dnf) registry battery (SPEC-0016 §7 M7) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/rpm/rpm.go +
 * services/packages/rpm/repository.go + modules/packages/rpm/{header,
 * metadata}.go at the pin fc4936884584.
 *
 * The core fixture is upstream's OWN test fixture
 * (modules/packages/rpm/metadata_test.go's `base64RpmsignSignedPackage` — a
 * real rpmsign-signed RPM, gzip-transported exactly as the Go test stores
 * it): the parse-parity test asserts the SAME field values the Go test
 * asserts, and the upload round-trip drives the whole repodata family from
 * it. The hand-built noarch RPM pins the binary header reader's exact-read
 * walk (lead + signature section with a real SHA-256 digest + alignment pad
 * + main header), and corrupted inputs pin the rejection arms.
 *
 * The OpenPGP repomd.xml.asc structure is pinned in-suite (the armor + CRC
 * framing, the debian suite's posture); the signature CRYPTO is verified
 * against the real gpg/gpgv in the live battery, alongside the real `rpm`
 * client's parse of the fixture (the M7 report — this host has rpm/rpmbuild
 * but NO dnf/createrepo, disclosed).
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { parseRpmPackage, parseRpmTarget } from "../../services/packages/rpm";
import { mintFor } from "../../auth/testing/seeds";
import { asciiBytes, base64ToBytes, concatBytes } from "../../services/packages/distro-common";

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
// Fixtures
// ---------------------------------------------------------------------------

/** The upstream test fixture (modules/packages/rpm/metadata_test.go:21-55,
 *  reflowed) — gzip-transported, exactly as the Go test stores it. */
const UPSTREAM_FIXTURE_B64 = `
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
OvSXaRmpzyTLHvsXg/M9EcwbAAA=`;

let cachedFixture: Uint8Array | null = null;

/** gunzip the upstream fixture (the Go test's transport layer). */
async function fixtureRpmBytes(): Promise<Uint8Array> {
  if (cachedFixture !== null) return cachedFixture;
  const gz = base64ToBytes(UPSTREAM_FIXTURE_B64.replace(/\s+/g, ""));
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(gz).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
  }
  cachedFixture = concatBytes(...chunks);
  return cachedFixture;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(bytes).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
  }
  return concatBytes(...chunks);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- the hand-built minimal RPM (the binary reader's exact-read walk) -------

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

const RPM_TYPE_STRING = 6;
const RPM_TYPE_INT32 = 4;
const RPM_TYPE_I18NSTRING = 9;

interface RpmTagInput {
  tag: number;
  type: number;
  data: Uint8Array;
  count: number;
}

/** One header section: intro (magic, reserved, indexCount, dataSize) + index
 *  entries + the store, with the real rpmbuild alignment rule (each entry's
 *  data aligned to its type width; strings/bins align 1). */
function headerSection(tags: RpmTagInput[]): Uint8Array {
  const widths = new Map<number, number>([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 4],
    [5, 8],
    [7, 1],
  ]);
  const parts: Uint8Array[] = [];
  let storeSize = 0;
  const indexParts: Uint8Array[] = [];
  for (const entry of tags) {
    const width = widths.get(entry.type) ?? 1;
    const pad = (width - (storeSize % width)) % width;
    if (pad > 0) {
      parts.push(new Uint8Array(pad));
      storeSize += pad;
    }
    indexParts.push(concatBytes(be32(entry.tag), be32(entry.type), be32(storeSize), be32(entry.count)));
    parts.push(entry.data);
    storeSize += entry.data.byteLength;
  }
  const intro = concatBytes(be32(0x8eade801), be32(0), be32(tags.length), be32(storeSize));
  return concatBytes(intro, ...indexParts, ...parts);
}

function stringTag(tag: number, value: string): RpmTagInput {
  return { tag, type: RPM_TYPE_STRING, data: asciiBytes(`${value}\0`), count: 1 };
}

function leadBytes(): Uint8Array {
  const lead = new Uint8Array(96);
  lead.set([0xed, 0xab, 0xee, 0xdb], 0);
  return lead;
}

/** lead || signature section (SHA-256 digest over the main header + payload
 *  size) || pad || main header || payload — a well-formed minimal rpm the
 *  real format spec would accept. */
async function buildMinimalRpm(fields: { name: string; version: string; release: string; arch: string; summary?: string }, payload: Uint8Array): Promise<Uint8Array> {
  const main = headerSection([
    stringTag(1000, fields.name), // tagName
    stringTag(1001, fields.version), // tagVersion
    stringTag(1002, fields.release), // tagRelease
    stringTag(1022, fields.arch), // tagArch
    { tag: 1004, type: RPM_TYPE_I18NSTRING, data: asciiBytes(`${fields.summary ?? "minimal rpm"}\0`), count: 1 }, // tagSummary
  ]);
  const digest = await sha256Hex(main);
  const sig = headerSection([
    stringTag(273, digest), // sigTagSHA256
    { tag: 1007, type: RPM_TYPE_INT32, data: be32(payload.byteLength), count: 1 }, // sigTagPayloadSize
  ]);
  const pad = (8 - (sig.byteLength % 8)) % 8;
  return concatBytes(leadBytes(), sig, new Uint8Array(pad), main, payload);
}

// --- upload helpers ---------------------------------------------------------

async function uploadRpm(owner: string, group: string, body: Uint8Array, headers: Record<string, string> = {}, envOverrides: Record<string, string> = {}): Promise<Response> {
  return protocol(envOverrides)(`/api/packages/${owner}/rpm/${group}/upload`, {
    method: "PUT",
    headers: { "content-length": String(body.byteLength), ...headers },
    body: body as unknown as BodyInit,
  });
}

async function repodata(owner: string, group: string, filename: string, method = "GET"): Promise<Response> {
  return protocol()(`/api/packages/${owner}/rpm/${group}/repodata/${filename}`, { method });
}

// ---------------------------------------------------------------------------
// The parse parity with upstream's metadata_test.go
// ---------------------------------------------------------------------------

describe("rpm header parse (the binary reader)", () => {
  it("extracts the exact metadata upstream's Go test asserts", async () => {
    const rpmBytes = await fixtureRpmBytes();
    const info = await parseRpmPackage(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rpmBytes);
        controller.close();
      },
    }));
    // metadata_test.go:68-92 — the same values, field for field.
    expect(info.name).toBe("gitea-test");
    expect(info.version).toBe("1.0.2-1");
    expect(info.versionMetadata.license).toBe("MIT");
    expect(info.versionMetadata.project_url).toBe("https://gitea.io");
    expect(info.versionMetadata.summary).toBe("RPM package summary");
    expect(info.versionMetadata.description).toBe("RPM package description");
    expect(info.fileMetadata.architecture).toBe("x86_64");
    expect(info.fileMetadata.epoch).toBe("0");
    expect(info.fileMetadata.version).toBe("1.0.2");
    expect(info.fileMetadata.release).toBe("1");
    expect(info.fileMetadata.vendor).toBeUndefined();
    expect(info.fileMetadata.packager).toBe("KN4CK3R");
    expect(info.fileMetadata.source_rpm).toBe("gitea-test-1.0.2-1.src.rpm");
    expect(info.fileMetadata.build_host).toBe("e44b1687d04b");
    expect(info.fileMetadata.build_time).toBe(1678225964);
    expect(info.fileMetadata.file_time).toBe(1678225964);
    expect(info.fileMetadata.installed_size).toBe(13);
    expect(info.fileMetadata.archive_size).toBe(272);
    expect(info.fileMetadata.conflict).toBeUndefined();
    expect(info.fileMetadata.obsolete).toBeUndefined();
    // metadata_test.go:93-112 — the provides entries.
    expect(info.fileMetadata.provide).toEqual([
      { name: "gitea-test", flags: "EQ", version: "1.0.2", epoch: "0", release: "1" },
      { name: "gitea-test(x86-64)", flags: "EQ", version: "1.0.2", epoch: "0", release: "1" },
    ]);
    // metadata_test.go:113-155 — the requires entries.
    expect(info.fileMetadata.require).toEqual([
      { name: "/bin/sh" },
      { name: "/bin/sh" },
      { name: "/bin/sh" },
      { name: "rpmlib(CompressedFileNames)", flags: "LE", version: "3.0.4", epoch: "0", release: "1" },
      { name: "rpmlib(FileDigests)", flags: "LE", version: "4.6.0", epoch: "0", release: "1" },
      { name: "rpmlib(PayloadFilesHavePrefix)", flags: "LE", version: "4.0", epoch: "0", release: "1" },
      { name: "rpmlib(PayloadIsXz)", flags: "LE", version: "5.2", epoch: "0", release: "1" },
    ]);
    // metadata_test.go:156-165 — the file list.
    expect(info.fileMetadata.files).toEqual([{ path: "/usr/local/bin/hello", is_executable: true }]);
    // metadata_test.go:166-176 — the changelog.
    expect(info.fileMetadata.changelogs).toEqual([{ author: "KN4CK3R <dummy@gitea.io>", date: 1678276800, text: "- Changelog message." }]);
  });

  it("rejects a bad lead magic, a header digest mismatch, and an oversized index", async () => {
    const rpmBytes = await fixtureRpmBytes();
    const parse = (bytes: Uint8Array): Promise<unknown> =>
      parseRpmPackage(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    // A bad lead magic.
    const badLead = rpmBytes.slice();
    badLead[0] = 0xed ^ 0xff;
    await expect(parse(badLead)).rejects.toThrow("invalid RPM package");
    // Truncated input.
    await expect(parse(rpmBytes.subarray(0, 40))).rejects.toThrow("invalid RPM package");
    // Corrupt the MAIN header (the signature's SHA-256 no longer matches) —
    // the headerStart = 96 + sigSection + pad, computed from the sig intro.
    const view = new DataView(rpmBytes.buffer, rpmBytes.byteOffset);
    const sigIndexCount = view.getUint32(96 + 8);
    const sigDataSize = view.getUint32(96 + 12);
    const sigSize = 16 + sigIndexCount * 16 + sigDataSize;
    const headerStart = 96 + sigSize + ((8 - (sigSize % 8)) % 8);
    const corrupt = rpmBytes.slice();
    corrupt[headerStart + 20] = (corrupt[headerStart + 20] ?? 0) ^ 0xff;
    await expect(parse(corrupt)).rejects.toThrow("invalid RPM package");
    // An oversized non-bin array count (metadata_test.go:200-209's arm):
    // count = maxHeaderArray + 1 on an int8 entry, a full 1 MiB store.
    const bogusMain = headerSection([{ tag: 1034, type: 2, data: new Uint8Array(1024 * 1024), count: 1024 * 1024 }]);
    const bogusSig = headerSection([stringTag(273, await sha256Hex(bogusMain))]);
    const bogusPad = (8 - (bogusSig.byteLength % 8)) % 8;
    const bogusRpm = concatBytes(leadBytes(), bogusSig, new Uint8Array(bogusPad), bogusMain);
    await expect(parse(bogusRpm)).rejects.toThrow("invalid RPM package");
    // A payload corruption does NOT invalidate (the digest covers the header
    // only — upstream reads the header sections and never the payload).
    const payloadCorrupt = rpmBytes.slice();
    payloadCorrupt[payloadCorrupt.byteLength - 1] = (payloadCorrupt[payloadCorrupt.byteLength - 1] ?? 0) ^ 0xff;
    await expect(parse(payloadCorrupt)).resolves.toHaveProperty("name", "gitea-test");
  });

  it("routes the wildcard remainder through the upstream grammar", () => {
    expect(parseRpmTarget("repository.key", "GET")).toEqual({ arm: "key", group: "" });
    expect(parseRpmTarget("el9.repo", "GET")).toEqual({ arm: "repo-config", group: "el9" });
    expect(parseRpmTarget("el9/x86_64/base.repo", "HEAD")).toEqual({ arm: "repo-config", group: "el9/x86_64/base" });
    expect(parseRpmTarget("el9/repodata/repomd.xml", "GET")).toEqual({ arm: "repodata", group: "el9", filename: "repomd.xml" });
    expect(parseRpmTarget("el9/repodata/repomd.xml", "HEAD")).toEqual({ arm: "repodata", group: "el9", filename: "repomd.xml" });
    expect(parseRpmTarget("el9/base/upload", "PUT")).toEqual({ arm: "upload", group: "el9/base" });
    expect(parseRpmTarget("el9/package/gitea-test/1.0.2-1/errata", "POST")).toEqual({
      arm: "errata",
      group: "el9",
      name: "gitea-test",
      version: "1.0.2-1",
    });
    expect(parseRpmTarget("el9/package/n/v/x86_64/filename-any", "GET")).toEqual({
      arm: "download",
      group: "el9",
      name: "n",
      version: "v",
      architecture: "x86_64",
      filename: "filename-any",
    });
    expect(parseRpmTarget("el9/package/n/v/x86_64", "GET")).toEqual({
      arm: "download",
      group: "el9",
      name: "n",
      version: "v",
      architecture: "x86_64",
    });
    expect(parseRpmTarget("el9/package/n/v/x86_64", "DELETE")).toEqual({
      arm: "delete",
      group: "el9",
      name: "n",
      version: "v",
      architecture: "x86_64",
    });
    // Multi-segment groups span the tail anchors.
    expect(parseRpmTarget("el9/base/repodata/primary.xml.gz", "GET")).toEqual({
      arm: "repodata",
      group: "el9/base",
      filename: "primary.xml.gz",
    });
    // Wrong methods and empty segments 404 (chi's non-empty-segment matching).
    expect(parseRpmTarget("el9/package/n/v/x86_64", "POST")).toBeNull();
    expect(parseRpmTarget("el9//repodata/repomd.xml", "GET")).toBeNull();
    expect(parseRpmTarget("", "GET")).toBeNull();
    expect(parseRpmTarget("el9/base/upload", "GET")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The round-trip: upload → repodata → download
// ---------------------------------------------------------------------------

describe("rpm upload → repodata → download", () => {
  it("round-trips the upstream fixture: 201, the repodata family, the key", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    const put = await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer));
    expect(put.status).toBe(201);

    // primary.xml.gz — the createrepo-shaped package entry. Each stored file
    // is buffered ONCE; the repomd loop re-hashes the same buffers.
    const primaryRes = await repodata("alice", "el9", "primary.xml.gz");
    expect(primaryRes.status).toBe(200);
    const primaryBytes = new Uint8Array(await primaryRes.arrayBuffer());
    const primaryXml = new TextDecoder().decode(await gunzip(primaryBytes));
    expect(primaryXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(primaryXml).toContain('<metadata xmlns="http://linux.duke.edu/metadata/common"');
    expect(primaryXml).toContain('xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1"');
    expect(primaryXml).toContain('<package type="rpm">');
    expect(primaryXml).toContain("<name>gitea-test</name>");
    expect(primaryXml).toContain("<arch>x86_64</arch>");
    expect(primaryXml).toContain('<version epoch="0" ver="1.0.2" rel="1"></version>');
    const digest = await sha256Hex(rpmBytes);
    expect(primaryXml).toContain(`<checksum type="sha256" pkgid="YES">${digest}</checksum>`);
    expect(primaryXml).toContain("<summary>RPM package summary</summary>");
    expect(primaryXml).toContain("<description>RPM package description</description>");
    expect(primaryXml).toContain("<packager>KN4CK3R</packager>");
    expect(primaryXml).toContain("<url>https://gitea.io</url>");
    expect(primaryXml).toContain('<time file="1678225964" build="1678225964"></time>');
    expect(primaryXml).toContain(`<size package="${rpmBytes.byteLength}" installed="13" archive="272"></size>`);
    expect(primaryXml).toContain(
      '<location href="package/gitea-test/1.0.2-1/x86_64/gitea-test-1.0.2-1.x86_64.rpm"></location>',
    );
    expect(primaryXml).toContain("<rpm:license>MIT</rpm:license>");
    expect(primaryXml).toContain("<rpm:sourcerpm>gitea-test-1.0.2-1.src.rpm</rpm:sourcerpm>");
    expect(primaryXml).toContain('<rpm:entry name="gitea-test" flags="EQ" ver="1.0.2" epoch="0" rel="1"></rpm:entry>');
    expect(primaryXml).toContain('<rpm:entry name="rpmlib(PayloadIsXz)" flags="LE" ver="5.2" epoch="0" rel="1"></rpm:entry>');
    expect(primaryXml).toContain("<file>/usr/local/bin/hello</file>");

    // filelists.xml.gz — pkgid/name/arch + EVERY file.
    const filelistsRes = await repodata("alice", "el9", "filelists.xml.gz");
    expect(filelistsRes.status).toBe(200);
    const filelistsBytes = new Uint8Array(await filelistsRes.arrayBuffer());
    const filelistsXml = new TextDecoder().decode(await gunzip(filelistsBytes));
    expect(filelistsXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(filelistsXml).toContain('<filelists xmlns="http://linux.duke.edu/metadata/other" packages="1">');
    expect(filelistsXml).toContain(`<package pkgid="${digest}" name="gitea-test" arch="x86_64">`);
    expect(filelistsXml).toContain("<file>/usr/local/bin/hello</file>");

    // other.xml.gz — the changelog.
    const otherRes = await repodata("alice", "el9", "other.xml.gz");
    expect(otherRes.status).toBe(200);
    const otherBytes = new Uint8Array(await otherRes.arrayBuffer());
    const otherXml = new TextDecoder().decode(await gunzip(otherBytes));
    expect(otherXml).toContain('<otherdata xmlns="http://linux.duke.edu/metadata/other" packages="1">');
    expect(otherXml).toContain('<changelog author="KN4CK3R &lt;dummy@gitea.io&gt;" date="1678276800">- Changelog message.</changelog>');

    // repomd.xml — the data descriptors hash the STORED files.
    const repomd = await repodata("alice", "el9", "repomd.xml");
    expect(repomd.status).toBe(200);
    const repomdXml = await repomd.text();
    expect(repomdXml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(repomdXml).toContain('<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">');
    for (const { type, bytes } of [
      { type: "primary", bytes: primaryBytes },
      { type: "filelists", bytes: filelistsBytes },
      { type: "other", bytes: otherBytes },
    ]) {
      const compressedDigest = await sha256Hex(bytes);
      const openBytes = await gunzip(bytes);
      const openDigest = await sha256Hex(openBytes);
      expect(repomdXml).toContain(`<data type="${type}">`);
      expect(repomdXml).toContain(`<checksum type="sha256">${compressedDigest}</checksum>`);
      expect(repomdXml).toContain(`<open-checksum type="sha256">${openDigest}</open-checksum>`);
      expect(repomdXml).toContain(`<location href="repodata/${type}.xml.gz"></location>`);
      expect(repomdXml).toContain(`<size>${bytes.byteLength}</size>`);
      expect(repomdXml).toContain(`<open-size>${openBytes.byteLength}</open-size>`);
      expect(repomdXml).toMatch(/<timestamp>\d+<\/timestamp>/);
    }
    // No updateinfo yet (no errata posted).
    expect(repomdXml).not.toContain('<data type="updateinfo">');

    // repomd.xml.asc — the armored detached signature (the crypto rides the
    // live gpgv battery).
    const asc = await repodata("alice", "el9", "repomd.xml.asc");
    expect(asc.status).toBe(200);
    const ascText = await asc.text();
    expect(ascText.startsWith("-----BEGIN PGP SIGNATURE-----\n\n")).toBe(true);
    expect(ascText).toMatch(/\n=[A-Za-z0-9+/]{4}\n/); // the CRC-24 line
    expect(ascText.endsWith("-----END PGP SIGNATURE-----\n")).toBe(true);

    // repository.key — the armored transferable public key. The arm is
    // GROUP-LESS (upstream registers /rpm/repository.key only; the .repo
    // gpgkey line points there for every group — one owner keypair).
    const key = await protocol()("/api/packages/alice/rpm/repository.key");
    expect(key.status).toBe(200);
    expect(key.headers.get("content-type")).toBe("application/pgp-keys");
    expect(key.headers.get("content-disposition")).toContain("repository.key");
    expect(await key.text()).toContain("-----BEGIN PGP PUBLIC KEY BLOCK-----");
    // The group-qualified path is NOT a route (upstream 404s it too).
    const groupKey = await protocol()("/api/packages/alice/rpm/el9/repository.key");
    expect(groupKey.status).toBe(404);
  });

  it("downloads the .rpm with byte parity, the filename-tail variant, HEAD, and the counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer));

    // The filename-less shape (rpm.go's internal index href).
    const get = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/x86_64");
    expect(get.status).toBe(200);
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...rpmBytes]);

    // The filename tail is IGNORED (the upstream route comment).
    const named = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/x86_64/whatever.rpm");
    expect(named.status).toBe(200);
    expect([...new Uint8Array(await named.arrayBuffer())]).toEqual([...rpmBytes]);

    // HEAD has no body.
    const head = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/x86_64", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(rpmBytes.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // The lead-file counter bumped per GET (two GETs — the HEAD does not).
    const rows = await db()
      .select({ version: packageVersions })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(eq(packageVersions.isInternal, false))
      .all();
    expect(rows[0]?.version.downloadCount).toBe(2);
  });

  it("serves a noarch file through the x86_64 fallback and a hand-built minimal rpm parses", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const noarchBytes = await buildMinimalRpm({ name: "hello2", version: "2.0", release: "2", arch: "noarch" }, asciiBytes("payload-cpio-bytes"));
    const put = await uploadRpm("alice", "el9", noarchBytes, authHeaders(writer));
    expect(put.status).toBe(201);

    // The exact noarch arm.
    const direct = await protocol()("/api/packages/alice/rpm/el9/package/hello2/2.0-2/noarch");
    expect(direct.status).toBe(200);
    expect([...new Uint8Array(await direct.arrayBuffer())]).toEqual([...noarchBytes]);
    // The x86_64 request falls back to noarch (rpm.go:245-247).
    const fallback = await protocol()("/api/packages/alice/rpm/el9/package/hello2/2.0-2/x86_64");
    expect(fallback.status).toBe(200);
    expect([...new Uint8Array(await fallback.arrayBuffer())]).toEqual([...noarchBytes]);

    // The hand-built rpm's primary entry (the binary reader walked the
    // minimal sections).
    const primaryXml = new TextDecoder().decode(await gunzip(new Uint8Array(await (await repodata("alice", "el9", "primary.xml.gz")).arrayBuffer())));
    expect(primaryXml).toContain('<version epoch="0" ver="2.0" rel="2"></version>');
    expect(primaryXml).toContain("<arch>noarch</arch>");
    expect(primaryXml).toContain("<summary>minimal rpm</summary>");
  });
});

// ---------------------------------------------------------------------------
// Mutations: groups, delete, errata
// ---------------------------------------------------------------------------

describe("rpm groups, delete, errata", () => {
  it("keeps groups independent: the same package in two groups, delete empties only one", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    expect((await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer))).status).toBe(201);
    expect((await uploadRpm("alice", "el8", rpmBytes, authHeaders(writer))).status).toBe(201);

    const el9 = await repodata("alice", "el9", "primary.xml.gz");
    expect(el9.status).toBe(200);
    const el8 = await repodata("alice", "el8", "primary.xml.gz");
    expect(el8.status).toBe(200);
    expect(new TextDecoder().decode(await gunzip(new Uint8Array(await el8.arrayBuffer())))).toContain("gitea-test");

    // The empty group deletes ITS files only (the family per-key posture).
    const del = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);
    expect((await repodata("alice", "el9", "primary.xml.gz")).status).toBe(404);
    expect((await repodata("alice", "el9", "repomd.xml")).status).toBe(404);
    expect((await repodata("alice", "el9", "repomd.xml.asc")).status).toBe(404);
    expect((await repodata("alice", "el8", "primary.xml.gz")).status).toBe(200);

    // The version row SURVIVES the first delete — el8 still references it.
    let rows = await db()
      .select({ version: packageVersions, pkg: packages })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .all();
    expect(rows.filter((row) => row.pkg.name === "gitea-test")).toHaveLength(1);

    // Emptying the last group folds the unreferenced version away; the
    // internal _rpm version stays.
    const del8 = await protocol()("/api/packages/alice/rpm/el8/package/gitea-test/1.0.2-1/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del8.status).toBe(204);
    expect((await repodata("alice", "el8", "primary.xml.gz")).status).toBe(404);
    rows = await db()
      .select({ version: packageVersions, pkg: packages })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .all();
    expect(rows.filter((row) => row.pkg.name === "gitea-test")).toHaveLength(0);
    expect(rows.filter((row) => row.pkg.isInternal === true).map((row) => row.pkg.name)).toContain("_rpm");
  });

  it("404s a missing version/file on delete and a missing package on download", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const del = await protocol()("/api/packages/alice/rpm/el9/package/nope/1.0/x86_64", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(404);
    const get = await protocol()("/api/packages/alice/rpm/el9/package/nope/1.0/x86_64");
    expect(get.status).toBe(404);
  });

  it("posts errata: updateinfo.xml.gz appears, repomd gains the data entry, merges dedupe", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer));

    const update = {
      from: "Fedora Update System",
      status: "stable",
      type: "security",
      version: "1.0",
      id: "FEDORA-2026-1",
      title: "gitea-test security update",
      severity: "high",
      description: "fixes everything",
      references: [{ href: "https://example.com/adv1", id: "ADV-1", title: "advisory", type: "security" }],
      pkg_list: [
        {
          short: "gitea-test",
          packages: [{ arch: "x86_64", name: "gitea-test", release: "1", src: "gitea-test-1.0.2-1.src.rpm", version: "1.0.2", filename: "gitea-test-1.0.2-1.x86_64.rpm" }],
        },
      ],
    };
    const post = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/errata", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(writer) },
      body: JSON.stringify([update]),
    });
    expect(post.status).toBe(200);

    const updateinfo = await repodata("alice", "el9", "updateinfo.xml.gz");
    expect(updateinfo.status).toBe(200);
    const updateinfoXml = new TextDecoder().decode(await gunzip(new Uint8Array(await updateinfo.arrayBuffer())));
    expect(updateinfoXml).toContain('<updates xmlns="http://linux.duke.edu/metadata/updateinfo">');
    expect(updateinfoXml).toContain('<update from="Fedora Update System" status="stable" type="security" version="1.0">');
    expect(updateinfoXml).toContain("<id>FEDORA-2026-1</id>");
    expect(updateinfoXml).toContain('<issued date="');
    expect(updateinfoXml).toContain('<updated date="');
    expect(updateinfoXml).toContain('<reference href="https://example.com/adv1" id="ADV-1" title="advisory" type="security"></reference>');
    expect(updateinfoXml).toContain('<collection short="gitea-test">');
    expect(updateinfoXml).toContain('<package arch="x86_64" name="gitea-test" release="1" src="gitea-test-1.0.2-1.src.rpm" version="1.0.2"><filename>gitea-test-1.0.2-1.x86_64.rpm</filename></package>');

    const repomdXml = await (await repodata("alice", "el9", "repomd.xml")).text();
    expect(repomdXml).toContain('<data type="updateinfo">');

    // A second POST merges into the SAME update id: same collection short
    // gains a package; the duplicate package is not repeated.
    const second = { ...update, pkg_list: [{ short: "gitea-test", packages: [
      { arch: "x86_64", name: "gitea-test", release: "1", src: "gitea-test-1.0.2-1.src.rpm", version: "1.0.2", filename: "gitea-test-1.0.2-1.x86_64.rpm" },
      { arch: "x86_64", name: "other-pkg", release: "3", src: "other.src.rpm", version: "9", filename: "other-9-3.x86_64.rpm" },
    ] }] };
    expect((await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/errata", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(writer) },
      body: JSON.stringify([second]),
    })).status).toBe(200);
    const mergedXml = new TextDecoder().decode(await gunzip(new Uint8Array(await (await repodata("alice", "el9", "updateinfo.xml.gz")).arrayBuffer())));
    expect(mergedXml).toContain("<id>FEDORA-2026-1</id>");
    expect((mergedXml.match(/<update /g) ?? []).length).toBe(1);
    expect(mergedXml).toContain('name="other-pkg"');
    expect((mergedXml.match(/name="gitea-test" release="1"/g) ?? []).length).toBe(1);
  });

  it("404s errata for a missing version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const post = await protocol()("/api/packages/alice/rpm/el9/package/nope/1.0/errata", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(writer) },
      body: "[]",
    });
    expect(post.status).toBe(404);
    expect(await post.text()).toBe("package does not exist");
  });
});

// ---------------------------------------------------------------------------
// The .repo configs + HEAD existence + validation + gates
// ---------------------------------------------------------------------------

describe("rpm repo config, HEAD, validation, gates", () => {
  it("renders the group-less and group .repo configs (rpm.go:36-52)", async () => {
    await seedUser("alice");
    const top = await protocol()("/api/packages/alice/rpm.repo");
    expect(top.status).toBe(200);
    expect(await top.text()).toBe(
      "[gitea-alice]\nname=alice - Gitea\nbaseurl=https://example.com/api/packages/alice/rpm\nenabled=1\ngpgcheck=1\ngpgkey=https://example.com/api/packages/alice/rpm/repository.key",
    );
    const grouped = await protocol()("/api/packages/alice/rpm/el9/base.repo");
    expect(grouped.status).toBe(200);
    expect(await grouped.text()).toBe(
      "[gitea-alice-el9-base]\nname=alice - Gitea - el9 - base\nbaseurl=https://example.com/api/packages/alice/rpm/el9/base\nenabled=1\ngpgcheck=1\ngpgkey=https://example.com/api/packages/alice/rpm/repository.key",
    );
  });

  it("HEADs repodata existence and 404s unknown files", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await uploadRpm("alice", "el9", await fixtureRpmBytes(), authHeaders(writer));
    const head = await repodata("alice", "el9", "repomd.xml", "HEAD");
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const missingHead = await repodata("alice", "el9", "nope.xml", "HEAD");
    expect(missingHead.status).toBe(404);
    const missingGet = await repodata("alice", "el9", "nope.xml");
    expect(missingGet.status).toBe(404);
    // A GET whose remainder matches no grammar arm 404s.
    const garbage = await protocol()("/api/packages/alice/rpm/el9/random/tail");
    expect(garbage.status).toBe(404);
  });

  it("rejects garbage and corrupt uploads with 400 invalid RPM package", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const noise = asciiBytes("definitely not an rpm file, just noise padded out to pass");
    const bad = await uploadRpm("alice", "el9", noise, authHeaders(writer));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe("invalid RPM package");

    // Corrupt the main header (the signature's SHA-256 no longer matches).
    const rpmBytes = await fixtureRpmBytes();
    const view = new DataView(rpmBytes.buffer, rpmBytes.byteOffset);
    const sigIndexCount = view.getUint32(96 + 8);
    const sigDataSize = view.getUint32(96 + 12);
    const sigSize = 16 + sigIndexCount * 16 + sigDataSize;
    const headerStart = 96 + sigSize + ((8 - (sigSize % 8)) % 8);
    const corrupt = rpmBytes.slice();
    corrupt[headerStart + 20] = (corrupt[headerStart + 20] ?? 0) ^ 0xff;
    const corruptRes = await uploadRpm("alice", "el9", corrupt, authHeaders(writer));
    expect(corruptRes.status).toBe(400);
    expect(await corruptRes.text()).toBe("invalid RPM package");
  });

  it("answers 409 on the same file re-upload (the D-1 any-duplicate rule)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    expect((await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer))).status).toBe(201);
    const again = await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer));
    expect(again.status).toBe(409);
    expect(await again.text()).toBe("package file already exists");
  });

  it("401s anonymous writes with the WWW-Authenticate challenge and blinds wrong-scope tokens", async () => {
    await seedUser("alice");
    const rpmBytes = await fixtureRpmBytes();
    const anon = await uploadRpm("alice", "el9", rpmBytes);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    const bob = await seedUser("bob");
    const reader = await token(bob, "read:package");
    const wrongScope = await uploadRpm("alice", "el9", rpmBytes, authHeaders(reader));
    expect(wrongScope.status).toBe(401);
    const anonDelete = await protocol()("/api/packages/alice/rpm/el9/package/gitea-test/1.0.2-1/x86_64", { method: "DELETE" });
    expect(anonDelete.status).toBe(401);
  });

  it("enforces the count quota (+1 parity) with the admin bypass", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const rpmBytes = await fixtureRpmBytes();
    const noarchBytes = await buildMinimalRpm({ name: "hello2", version: "2.0", release: "2", arch: "noarch" }, asciiBytes("payload"));
    expect((await uploadRpm("alice", "el9", rpmBytes, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" })).status).toBe(201);
    const second = await uploadRpm("alice", "el8", noarchBytes, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" });
    expect(second.status).toBe(403);
    const admin = await seedUser("root", { isAdmin: true });
    const adminToken = await token(admin, "write:package");
    expect((await uploadRpm("root", "el9", noarchBytes, authHeaders(adminToken))).status).toBe(201);
  });

  it("404s the whole family under PACKAGES_ENABLED=false", async () => {
    await seedUser("alice");
    const key = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/rpm/el9/repository.key");
    expect(key.status).toBe(404);
    const config = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/rpm.repo");
    expect(config.status).toBe(404);
  });
});
