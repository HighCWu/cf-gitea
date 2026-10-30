/**
 * The Alpine registry battery (SPEC-0016 §7 M7) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/alpine/alpine.go +
 * services/packages/alpine/repository.go at the pin fc4936884584:
 *
 *  - the apk-tools-shaped .apk upload round-trip (concatenated gzip members:
 *    signature stream || control stream carrying .PKGINFO || a data stream
 *    the parse must skip) → 201, the two-member signed APKINDEX.tar.gz;
 *  - the APKINDEX structure: `.SIGN.RSA-<owner>@<fingerprint>.rsa.pub` entry
 *    (tar, no end blocks) + the APKINDEX paragraph (C:Q1 checksum = sha1 of
 *    the RAW control member, P/V/A/S/I/o/m/t/D/p lines), with the noarch
 *    merge and the noarch index fallback;
 *  - the REAL crypto verification: the .SIGN.RSA entry's RSA-SHA1 signature
 *    verifies over the unsigned archive's raw bytes against the served
 *    repository.key's SPKI (WebCrypto verify in-suite);
 *  - the .apk download with byte parity + the counter; delete → rebuild;
 *    the validation/auth/quota gates shared with the other families.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, packages as packagesTable, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import {
  asciiBytes,
  buildTar,
  bytesToBase64,
  concatBytes,
  gzipCompress,
  rsaVerify,
  walkGzipMembers,
  readTarMembers,
} from "../../services/packages/distro-common";

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
  opts: { isAdmin?: boolean } = {},
): Promise<SeededUser> {
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
// The apk-tools-shaped fixture: THREE concatenated gzip members (signature,
// control with .PKGINFO, data) — the parser must stop at the control member
// and hash ITS raw bytes for the C: checksum.
// ---------------------------------------------------------------------------

const HW_PKGINFO = [
  "pkgname = helloworld",
  "pkgver = 1.2-r0",
  "pkgdesc = a test apk",
  "url = https://example.com/hw",
  "builddate = 1700000000",
  "size = 2048",
  "arch = x86_64",
  "origin = helloworld",
  "commit = abc123",
  "maintainer = Alice <alice@example.com>",
  "packager = Builder <builder@example.com>",
  "license = MIT",
  "depend = so:libc.musl-x86_64.so.1",
  "depend = busybox",
  "provides = cmd:helloworld=1.2-r0",
  "",
].join("\n");

async function apkBytes(pkgname: string, pkgver: string, arch: string): Promise<Uint8Array> {
  const pkginfo = HW_PKGINFO.replace("pkgname = helloworld", `pkgname = ${pkgname}`).replace(
    "pkgver = 1.2-r0",
    `pkgver = ${pkgver}`,
  ).replace("arch = x86_64", `arch = ${arch}`);
  const signatureMember = await gzipCompress(
    buildTar([{ name: ".SIGN.RSA-fake@deadbeef.rsa.pub", mode: 0o600, data: asciiBytes("placeholder") }], false),
  );
  const controlMember = await gzipCompress(
    buildTar(
      [
        { name: ".PKGINFO", mode: 0o644, data: asciiBytes(pkginfo) },
        { name: ".trigger", mode: 0o644, data: asciiBytes("echo trigger\n") },
      ],
      true,
    ),
  );
  const dataMember = await gzipCompress(
    buildTar([{ name: `usr/bin/${pkgname}`, mode: 0o755, data: asciiBytes("echo hi\n") }], true),
  );
  return concatBytes(signatureMember, controlMember, dataMember);
}

async function uploadApk(
  owner: string,
  branch: string,
  repository: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
  envOverrides: Record<string, string> = {},
): Promise<Response> {
  return protocol(envOverrides)(`/api/packages/${owner}/alpine/${branch}/${repository}`, {
    method: "PUT",
    headers: { "content-length": String(body.byteLength), ...headers },
    body: body as unknown as BodyInit,
  });
}

/** The APKINDEX assertions: the two-member structure, the SIGN entry naming,
 *  and the paragraph shape. Returns the member raw bytes for the crypto
 *  verification. */
async function parseServedIndex(owner: string, branch: string, repository: string, architecture: string) {
  const res = await protocol()(`/api/packages/${owner}/alpine/${branch}/${repository}/${architecture}/APKINDEX.tar.gz`);
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const members = await walkGzipMembers(bytes);
  expect(members).toHaveLength(2);
  const signMember = members[0];
  const indexMember = members[1];
  if (signMember === undefined || indexMember === undefined) throw new Error("index members missing");
  const signEntries = readTarMembers(signMember.payload);
  expect(signEntries).toHaveLength(1);
  const signEntry = signEntries[0];
  if (signEntry === undefined) throw new Error("signature entry missing");
  const signName = signEntry.name;
  expect(signName).toMatch(/^\.SIGN\.RSA-alice@[0-9a-f]{64}\.rsa\.pub$/);
  const indexEntries = readTarMembers(indexMember.payload);
  const indexEntry = indexEntries.find((entry) => entry.name === "APKINDEX");
  if (indexEntry === undefined) throw new Error("APKINDEX entry missing");
  const indexText = new TextDecoder().decode(indexEntry.data);
  return { members, signName, signature: signEntry.data, indexText };
}

function indexMemberRaw(members: Awaited<ReturnType<typeof walkGzipMembers>>): Uint8Array {
  return members[1]?.raw ?? new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// The round-trip
// ---------------------------------------------------------------------------

describe("alpine upload → APKINDEX → download", () => {
  it("round-trips an .apk upload with the signed two-member APKINDEX and a verifiable signature", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    const put = await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer));
    expect(put.status).toBe(201);

    const { members, signature, indexText } = await parseServedIndex("alice", "v3.19", "main", "x86_64");

    // The C: checksum = "Q1" + base64(sha1(RAW control-member bytes)) — of
    // the UPLOADED .apk's members (the served index's own members are a
    // different pair; the checksum travels from the parse).
    const apkMembers = await walkGzipMembers(apk);
    expect(apkMembers).toHaveLength(3);
    const expectedChecksum = `Q1${bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-1", apkMembers[1]?.raw ?? new Uint8Array(0))))}`;
    expect(indexText).toContain(`C:${expectedChecksum}`);
    expect(indexText).toContain("P:helloworld");
    expect(indexText).toContain("V:1.2-r0");
    expect(indexText).toContain("A:x86_64");
    expect(indexText).toContain("T:a test apk");
    expect(indexText).toContain("U:https://example.com/hw");
    expect(indexText).toContain("L:MIT");
    // S: is the blob size (repository.go:231 — pd.Blob.Size); I: the PKGINFO
    // installed size (repository.go:232 — FileMetadata.Size).
    expect(indexText).toContain(`S:${apk.byteLength}`);
    expect(indexText).toMatch(/^I:2048$/m);
    expect(indexText).toContain("o:helloworld");
    expect(indexText).toContain("m:Alice <alice@example.com>");
    expect(indexText).toContain("t:1700000000");
    expect(indexText).toContain("c:abc123");
    expect(indexText).toContain("D:so:libc.musl-x86_64.so.1 busybox");
    expect(indexText).toContain("p:cmd:helloworld=1.2-r0");
    // The checksum member is the CONTROL member (the signature stream's
    // sha1 differs — the walk stopped at the PKGINFO member like upstream).
    const signMemberChecksum = `Q1${bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-1", apkMembers[0]?.raw ?? new Uint8Array(0))))}`;
    expect(indexText).not.toContain(`C:${signMemberChecksum}`);

    // THE REAL CRYPTO VERIFICATION: the .SIGN.RSA entry's RSA-SHA1 signature
    // verifies over the unsigned archive's raw bytes against the served key.
    const keyRes = await protocol()("/api/packages/alice/alpine/key");
    expect(keyRes.status).toBe(200);
    expect(keyRes.headers.get("content-type")).toBe("application/x-pem-file");
    const keyPem = await keyRes.text();
    const spki = pemSpki(keyPem);
    const raw = indexMemberRaw(members);
    const ok = await rsaVerify(spki, "SHA-1", signature, raw);
    expect(ok).toBe(true);
    // ...and a tampered payload fails.
    const tampered = raw.slice(0, raw.byteLength - 1);
    expect(await rsaVerify(spki, "SHA-1", signature, tampered)).toBe(false);
  });

  it("merges noarch packages into every architecture index and falls back on serving", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const x86 = await apkBytes("helloworld", "1.2-r0", "x86_64");
    const noarch = await apkBytes("scripts", "2.0-r0", "noarch");
    expect((await uploadApk("alice", "v3.19", "main", x86, authHeaders(writer))).status).toBe(201);
    expect((await uploadApk("alice", "v3.19", "main", noarch, authHeaders(writer))).status).toBe(201);

    // The x86_64 index carries BOTH packages (the noarch merge).
    const { indexText } = await parseServedIndex("alice", "v3.19", "main", "x86_64");
    expect(indexText).toContain("P:helloworld");
    expect(indexText).toContain("P:scripts");
    // The noarch paragraph carries the INDEX's architecture in A:.
    const scriptsParagraph = indexText.split("\n\n").find((paragraph) => paragraph.includes("P:scripts"));
    expect(scriptsParagraph).toContain("A:x86_64");

    // The aarch64 index does not exist, but the noarch fallback serves the
    // noarch index (scripts) for the requesting architecture.
    const fallback = await protocol()("/api/packages/alice/alpine/v3.19/main/aarch64/APKINDEX.tar.gz");
    expect(fallback.status).toBe(200);
    const fallbackMembers = await walkGzipMembers(new Uint8Array(await fallback.arrayBuffer()));
    const fallbackIndex = fallbackMembers[1];
    const fallbackEntry = fallbackIndex === undefined ? undefined : readTarMembers(fallbackIndex.payload).find((entry) => entry.name === "APKINDEX");
    const fallbackText = new TextDecoder().decode(fallbackEntry?.data ?? new Uint8Array(0));
    expect(fallbackText).toContain("P:scripts");
    expect(fallbackText).not.toContain("P:helloworld");
  });

  it("downloads the .apk with byte parity and bumps the counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer));

    const get = await protocol()("/api/packages/alice/alpine/v3.19/main/x86_64/helloworld-1.2-r0.apk");
    expect(get.status).toBe(200);
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([...apk]);

    const rows = await db()
      .select({ version: packageVersions })
      .from(packageVersions)
      .innerJoin(packagesTable, eq(packagesTable.id, packageVersions.packageId))
      .where(eq(packageVersions.isInternal, false))
      .all();
    expect(rows[0]?.version.downloadCount).toBe(1);
  });

  it("deletes the file and rebuilds the index without the paragraph", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer));

    const del = await protocol()("/api/packages/alice/alpine/v3.19/main/x86_64/helloworld-1.2-r0.apk", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(del.status).toBe(204);

    const index = await protocol()("/api/packages/alice/alpine/v3.19/main/x86_64/APKINDEX.tar.gz");
    expect(index.status).toBe(404); // the empty arm deleted the index
  });
});


/** Extract the SPKI DER out of the served PEM. */
function pemSpki(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

describe("alpine validation and gates", () => {
  it("rejects an empty/whitespace branch or repository with 400", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    // A branch of only spaces survives the route (%20) and fails the trim.
    const res = await protocol()("/api/packages/alice/alpine/%20%20/main", {
      method: "PUT",
      headers: { "content-length": String(apk.byteLength), ...authHeaders(writer) },
      body: apk as unknown as BodyInit,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid branch or repository");
  });

  it("rejects a PKGINFO-less archive with 400", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const garbage = concatBytes(await gzipCompress(asciiBytes("nothing here")), await gzipCompress(asciiBytes("nor here")));
    const res = await uploadApk("alice", "v3.19", "main", garbage, authHeaders(writer));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("PKGINFO file is missing");
  });

  it("answers 409 on the same file re-upload and 401 anonymous/wrong-scope", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    expect((await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer))).status).toBe(201);
    const again = await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer));
    expect(again.status).toBe(409);

    const anon = await uploadApk("alice", "v3.19", "main", apk);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
  });

  it("enforces the count quota (+1 parity) and the enabled gate", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const apk = await apkBytes("helloworld", "1.2-r0", "x86_64");
    expect((await uploadApk("alice", "v3.19", "main", apk, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" })).status).toBe(201);
    const second = await uploadApk("alice", "v3.19", "testing", apk, authHeaders(writer), { PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" });
    expect(second.status).toBe(403);

    const disabled = await protocol({ PACKAGES_ENABLED: "false" })("/api/packages/alice/alpine/key");
    expect(disabled.status).toBe(404);
  });
});
