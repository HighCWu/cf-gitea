/**
 * The Cargo protocol battery (SPEC-0016 §7 M7 tail, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/cargo/cargo.go +
 * services/packages/cargo/index.go + modules/packages/cargo/parser.go at the
 * pin, through the REAL packages-protocols mount (the container.test.ts
 * service-level precedent):
 *
 *  - the publish round-trip: a hand-built publish container (uint32-LE
 *    metadata length | metadata JSON | uint32-LE content length | .crate
 *    bytes — the payload a real tar.gz holding Cargo.toml + src/lib.rs, the
 *    rpm/arch builder pattern; cargo 1.94 exists locally so the REAL client
 *    round-trip rides separately in the ops log) → {"ok":true}, the D1 rows
 *    (metadata JSON, cargo.yanked="false", lead file lowercased), the index
 *    entry through EVERY sparse shape (1/2/3/4-segment —
 *    buildCargoPackagePath), cksum == the .crate bytes' sha256;
 *  - the index-entry shape as-built: name/vers/deps/cksum/features/yanked
 *    (+ links omitempty), deps nil → [], features nil → {}, the upstream
 *    SortVersionAsc string ordering (1.0.10 BEFORE 1.0.2 — package_version.go:287-294),
 *    the yank/unyank posture flipping the entry, the empty-detail 404 arm;
 *  - config.json (dl/api/auth-required, the private-owner arm), search
 *    (q/page/per_page clamps), owners, download (byte parity, the GET-only
 *    counter bump);
 *  - the error shapes: the StatusResponse wrap on every arm — 400 name/
 *    version/container sentinels, 400 "invalid content size" (short
 *    content), 409 duplicate version, 403 quota, 401 write-gate, the
 *    500-strip (missing cargo.yanked property), PACKAGES_ENABLED=false.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageFiles, packageProperties, packageVersions, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "../../api/routes/packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import { buildCargoPackagePath } from "./cargo";

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
  tokenMemos.clear(); // the token rows just died — the memos are stale
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

/** Memoized mint — the token name is per-user unique, so one plaintext per
 *  (user, scopes) pair across the file (mintFor re-mints would collide). */
const tokenMemos = new Map<string, string>();
async function token(user: SeededUser, scopes: string): Promise<string> {
  const memoKey = `${user.id}:${scopes}`;
  const memo = tokenMemos.get(memoKey);
  if (memo !== undefined) return memo;
  const plaintext = (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
  tokenMemos.set(memoKey, plaintext);
  return plaintext;
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
// The publish-container builders — the rpm/arch units' builder pattern: a
// REAL tar.gz payload (Cargo.toml + src/lib.rs, ustar headers) wrapped in
// cargo's publish container (uint32-LE | JSON | uint32-LE | payload).
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

const encoder = new TextEncoder();

function tarMember(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode("0000644\0"), 100); // mode
  header.set(encoder.encode("0000000\0"), 108); // uid
  header.set(encoder.encode("0000000\0"), 116); // gid
  header.set(encoder.encode(`${content.byteLength.toString(8).padStart(11, "0")}\0`), 124); // size
  header.set(encoder.encode("00000000000\0"), 136); // mtime
  header.set(encoder.encode("        "), 148); // checksum placeholder
  header[156] = 0x30; // TypeReg
  header.set(encoder.encode("ustar\x00" + "00"), 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padding = new Uint8Array((512 - (content.byteLength % 512)) % 512);
  return concatBytes([header, content, padding]);
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The .crate payload: a real gzipped tar with Cargo.toml + src/lib.rs. */
async function buildCratePayload(crateName: string, version: string, filler = ""): Promise<Uint8Array> {
  const cargoToml = `[package]\nname = "${crateName}"\nversion = "${version}"\nedition = "2021"\n`;
  const libRs = `pub fn hello() -> &'static str { "cf-gitea cargo" }\n${filler}`;
  return gzipBytes(
    buildTar([
      tarMember(`${crateName}-${version}/Cargo.toml`, encoder.encode(cargoToml)),
      tarMember(`${crateName}-${version}/src/lib.rs`, encoder.encode(libRs)),
    ]),
  );
}

function buildTar(members: Uint8Array[]): Uint8Array {
  return concatBytes([...members, new Uint8Array(1024)]);
}

interface CrateMeta {
  name: string;
  vers: string;
  description?: string;
  authors?: string[];
  deps?: Record<string, unknown>[];
  features?: Record<string, string[]> | null;
  homepage?: string;
  documentation?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  links?: string;
}

/** The publish container: `uint32-LE metaLen | meta JSON | uint32-LE
 *  contentLen | content`. Overrides splice raw JSON (badName etc.). */
function makeCrateContainer(
  meta: CrateMeta,
  payload: Uint8Array,
  overrides: { metaJson?: string; declaredContentLen?: number; truncateContent?: number } = {},
): Uint8Array {
  const metaJson = overrides.metaJson ?? JSON.stringify(meta);
  const metaBytes = encoder.encode(metaJson);
  const metaLen = new Uint8Array(4);
  new DataView(metaLen.buffer).setUint32(0, metaBytes.byteLength, true);
  const contentLen = overrides.declaredContentLen ?? payload.byteLength;
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, contentLen, true);
  const content = overrides.truncateContent !== undefined ? payload.subarray(0, payload.byteLength - overrides.truncateContent) : payload;
  return concatBytes([metaLen, metaBytes, lenBytes, content]);
}

async function publishCrate(
  user: SeededUser,
  meta: CrateMeta,
  overrides: { metaJson?: string; declaredContentLen?: number; truncateContent?: number; tokenPlain?: string } = {},
): Promise<Response> {
  const plain = overrides.tokenPlain ?? (await token(user, "write:package"));
  const payload = await buildCratePayload(meta.name, meta.vers);
  const container = makeCrateContainer(meta, payload, overrides);
  return protocol()(`/api/packages/${user.username}/cargo/api/v1/crates/new`, {
    method: "PUT",
    headers: { ...authHeaders(plain), "content-type": "application/json" },
    body: container,
  });
}

interface SeededCrate {
  name: string;
  version: string;
  payload: Uint8Array;
}

/** Publish one crate and return its payload for byte-parity pins. */
async function seedCrate(user: SeededUser, meta: CrateMeta, filler = ""): Promise<SeededCrate> {
  const payload = await buildCratePayload(meta.name, meta.vers, filler);
  const plain = await token(user, "write:package");
  const container = makeCrateContainer(meta, payload);
  const response = await protocol()(`/api/packages/${user.username}/cargo/api/v1/crates/new`, {
    method: "PUT",
    headers: { ...authHeaders(plain), "content-type": "application/json" },
    body: container,
  });
  if (response.status !== 200) {
    throw new Error(`seedCrate publish failed: ${response.status} ${await response.text()}`);
  }
  return { name: meta.name, version: meta.vers, payload };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// buildCargoPackagePath (index.go:31-45)
// ---------------------------------------------------------------------------

describe("buildCargoPackagePath (the sparse-index layout)", () => {
  it("maps the four name-length shapes", () => {
    expect(buildCargoPackagePath("a")).toBe("1/a");
    expect(buildCargoPackagePath("ab")).toBe("2/ab");
    expect(buildCargoPackagePath("abc")).toBe("3/a/abc");
    expect(buildCargoPackagePath("abcd")).toBe("ab/cd/abcd");
    expect(buildCargoPackagePath("Demo-Crate_1")).toBe("de/mo/demo-crate_1");
    expect(() => buildCargoPackagePath("")).toThrow("Cargo package name can not be empty");
  });
});

// ---------------------------------------------------------------------------
// The publish round-trip + the index-entry shape
// ---------------------------------------------------------------------------

describe("publish + sparse index (cargo.go:170-224, index.go:125-183)", () => {
  it("the round-trip: publish answers {\"ok\":true}, the D1 posture, the index line through EVERY sparse shape", async () => {
    const owner = await seedUser("rustacean");
    const meta: CrateMeta = {
      name: "demo",
      vers: "1.0.0",
      description: "A demo crate",
      authors: ["KN4CK3R"],
      license: "MIT",
      homepage: "https://gitea.io/",
      documentation: "not-a-url",
      repository: "https://github.com/go-gitea/gitea",
      deps: [{ name: "dep", version_req: "1.0" }],
      features: { std: [] },
      keywords: ["demo"],
    };
    const crate = await seedCrate(owner, meta);

    // The D1 posture: the version row carries the metadata JSON in upstream's
    // tag order (renames resolved), the yanked property lands "false", the
    // lead file is the lowercased {name}-{vers}.crate.
    const versionRow = (
      await db()
        .select()
        .from(packageVersions)
        .where(eq(packageVersions.lowerVersion, "1.0.0"))
        .all()
    )[0];
    expect(versionRow).toBeDefined();
    const storedMeta = JSON.parse(versionRow?.metadataJson ?? "{}") as Record<string, unknown>;
    expect(storedMeta).toEqual({
      dependencies: [
        {
          name: "dep",
          req: "1.0",
          features: [],
          optional: false,
          default_features: false,
          target: null,
          kind: "",
          registry: null,
          package: null,
        },
      ],
      features: { std: [] },
      authors: ["KN4CK3R"],
      description: "A demo crate",
      // homepage → project_url; the non-absolute documentation URL blanks out
      // (parser.go:66-71) and its key stays omitted.
      project_url: "https://gitea.io/",
      keywords: ["demo"],
      license: "MIT",
      repository_url: "https://github.com/go-gitea/gitea",
    });
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, versionRow?.id ?? 0))
      .all();
    expect(props).toContainEqual(expect.objectContaining({ name: "cargo.yanked", value: "false" }));
    const fileRow = (await db().select().from(packageFiles).all())[0];
    expect(fileRow?.name).toBe("demo-1.0.0.crate");
    expect(fileRow?.isLead).toBe(true);

    // The index line through EVERY sparse shape (the placeholders are
    // dummies; the package name is the last segment).
    const cksum = await sha256Hex(crate.payload);
    for (const sparsePath of ["3/d/demo", "x/y/demo", "de/mo/demo"]) {
      const response = await protocol()(`/api/packages/rustacean/cargo/${sparsePath}`, {});
      expect(response.status, sparsePath).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const body = await response.text();
      expect(body.endsWith("\n")).toBe(true);
      const line = JSON.parse(body.trim()) as Record<string, unknown>;
      expect(Object.keys(line)).toEqual(["name", "vers", "deps", "cksum", "features", "yanked"]);
      expect(line).toEqual({
        name: "demo",
        vers: "1.0.0",
        deps: [
          {
            name: "dep",
            req: "1.0",
            features: [],
            optional: false,
            default_features: false,
            target: null,
            kind: "",
            registry: null,
            package: null,
          },
        ],
        cksum,
        features: { std: [] },
        yanked: false,
      });
    }
  });

  it("the 1/2-char sparse roots serve too (buildCargoPackagePath parity through the router)", async () => {
    const owner = await seedUser("shortnames");
    await seedCrate(owner, { name: "a", vers: "0.1.0", description: "one" });
    await seedCrate(owner, { name: "ab", vers: "0.2.0", description: "two" });
    for (const [path, vers] of [
      ["1/a", "0.1.0"],
      ["2/ab", "0.2.0"],
    ] as const) {
      const response = await protocol()(`/api/packages/shortnames/cargo/${path}`, {});
      expect(response.status, path).toBe(200);
      expect((JSON.parse(await response.text()) as { vers: string }).vers).toBe(vers);
    }
  });

  it("the renamed-dependency resolution (parser.go:105-124): explicit_name_in_toml names the dep, the original moves to package", async () => {
    const owner = await seedUser("renamer");
    const meta: CrateMeta = {
      name: "testpkg",
      vers: "1.0",
      deps: [{ name: "dep-renamed", explicit_name_in_toml: "dep-explicit", version_req: "1.0" }],
    };
    const plain = await token(owner, "write:package");
    const payload = await buildCratePayload(meta.name, meta.vers);
    const metaJson = JSON.stringify({
      name: meta.name,
      vers: meta.vers,
      deps: [{ name: "dep-renamed", explicit_name_in_toml: "dep-explicit", version_req: "1.0" }],
    });
    const container = makeCrateContainer(meta, payload, { metaJson });
    const response = await protocol()(`/api/packages/renamer/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(plain), "content-type": "application/json" },
      body: container,
    });
    expect(response.status).toBe(200);

    const index = await protocol()(`/api/packages/renamer/cargo/3/t/testpkg`, {});
    const line = JSON.parse((await index.text()).trim()) as { deps: { name: string; package: string | null }[] };
    expect(line.deps[0]?.name).toBe("dep-explicit");
    expect(line.deps[0]?.package).toBe("dep-renamed");
  });

  it("the SortVersionAsc ordering: the raw version STRING asc, id DESC stable tail (package_version.go:287-294)", async () => {
    const owner = await seedUser("orderer");
    // Published in semver-middle order; the string sort pins 1.0.10 BEFORE
    // 1.0.2 (upstream's exact ordering — not a semver-aware sort), with 0.9.0
    // first.
    await seedCrate(owner, { name: "ordered", vers: "1.0.2" });
    await seedCrate(owner, { name: "ordered", vers: "0.9.0" });
    await seedCrate(owner, { name: "ordered", vers: "1.0.10" });

    const response = await protocol()(`/api/packages/orderer/cargo/or/der/ordered`, {});
    expect(response.status).toBe(200);
    const versions = (await response.text())
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { vers: string }).vers);
    expect(versions).toEqual(["0.9.0", "1.0.10", "1.0.2"]);
  });

  it("zero versions → the nil-index 404 arm with the EMPTY detail (cargo.go:80-82 → apiError(404, nil))", async () => {
    const owner = await seedUser("swept");
    await seedCrate(owner, { name: "gone", vers: "1.0.0" });
    // Sweep the version row (the cleanup's package-husk state).
    await db().delete(packageVersions).where(eq(packageVersions.lowerVersion, "1.0.0"));

    const response = await protocol()(`/api/packages/swept/cargo/2/gone`, {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, errors: [{ detail: "" }] });
  });

  it("the unknown package answers the name-miss 404 (cargo.go:68-72)", async () => {
    const owner = await seedUser("nobody");
    const response = await protocol()(`/api/packages/${owner.username}/cargo/4/no/such`, {});
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, errors: [{ detail: "package does not exist" }] });
  });
});

// ---------------------------------------------------------------------------
// config.json / search / owners / download
// ---------------------------------------------------------------------------

describe("config.json, search, owners, download", () => {
  it("config.json renders dl/api/auth-required; the private owner's own view arms auth-required", async () => {
    const owner = await seedUser("cfgowner");
    const response = await protocol()(`/api/packages/${owner.username}/cargo/config.json`, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await response.json()).toEqual({
      dl: "https://example.com/api/packages/cfgowner/cargo/api/v1/crates",
      api: "https://example.com/api/packages/cfgowner/cargo",
      "auth-required": false,
    });

    // A private owner answers only its own credential (the anonymous arm is
    // the 401 challenge); BuildConfig arms auth-required off the visibility.
    const hidden = await seedUser("hider", { visibility: "private" });
    const response2 = await protocol()(`/api/packages/hider/cargo/config.json`, {
      headers: authHeaders(await token(hidden, "read:package")),
    });
    expect(await response2.json()).toEqual({
      dl: "https://example.com/api/packages/hider/cargo/api/v1/crates",
      api: "https://example.com/api/packages/hider/cargo",
      "auth-required": true,
    });
  });

  it("search answers the SearchResult shape with the ToCorrectPageSize clamps", async () => {
    const owner = await seedUser("searcher");
    await seedCrate(owner, { name: "left-pad", vers: "1.0.0", description: "the left pad" });
    await seedCrate(owner, { name: "left-pad-core", vers: "2.0.0", description: "" });
    await seedCrate(owner, { name: "unrelated", vers: "3.0.0", description: "other" });

    const response = await protocol()(`/api/packages/searcher/cargo/api/v1/crates?q=left-pad`, {});
    expect(response.status).toBe(200);
    const body = await response.json<{
      crates: { name: string; max_version: string; description: string }[];
      meta: { total: number };
    }>();
    expect(body.crates.map((crate) => crate.name).sort()).toEqual(["left-pad", "left-pad-core"]);
    expect(body.crates.find((crate) => crate.name === "left-pad")?.description).toBe("the left pad");
    expect(body.crates.find((crate) => crate.name === "left-pad-core")?.description).toBe("");
    expect(body.meta).toEqual({ total: 2 });

    // per_page clamps: 0 → the default 10 (one page holds all three).
    const paged = await protocol()(`/api/packages/searcher/cargo/api/v1/crates?q=&per_page=0`, {});
    const pagedBody = await paged.json<{ crates: unknown[]; meta: { total: number } }>();
    expect(pagedBody.crates).toHaveLength(3);
    // per_page=2 → the first page carries two rows.
    const capped = await protocol()(`/api/packages/searcher/cargo/api/v1/crates?q=&per_page=2`, {});
    expect((await capped.json<{ crates: unknown[] }>()).crates).toHaveLength(2);
    // page beyond the end → empty crates, meta.total unchanged.
    const later = await protocol()(`/api/packages/searcher/cargo/api/v1/crates?q=&per_page=2&page=2`, {});
    const laterBody = await later.json<{ crates: unknown[]; meta: { total: number } }>();
    expect(laterBody.crates).toHaveLength(1);
    expect(laterBody.meta.total).toBe(3);
  });

  it("owners answers the scope owner (cargo.go:152-155)", async () => {
    const owner = await seedUser("holder");
    await seedCrate(owner, { name: "owned", vers: "1.0.0" });
    const response = await protocol()(`/api/packages/holder/cargo/api/v1/crates/owned/owners`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      users: [{ id: owner.id, login: "holder", name: "holder" }],
    });
  });

  it("download: byte parity, the GET counter bump, HEAD's no-bump, the 404 arms", async () => {
    const owner = await seedUser("downloader");
    const crate = await seedCrate(owner, { name: "packed", vers: "1.2.3" });

    const download = await protocol()(`/api/packages/downloader/cargo/api/v1/crates/packed/1.2.3/download`, {});
    expect(download.status).toBe(200);
    const served = new Uint8Array(await download.arrayBuffer());
    expect(served).toEqual(crate.payload);
    let counts = (await db().select().from(packageVersions).all())[0]?.downloadCount ?? -1;
    expect(counts).toBe(1);

    // HEAD serves the bytes' shape without bumping (the lead GET gate).
    const head = await protocol()(`/api/packages/downloader/cargo/api/v1/crates/packed/1.2.3/download`, { method: "HEAD" });
    expect(head.status).toBe(200);
    counts = (await db().select().from(packageVersions).all())[0]?.downloadCount ?? -1;
    expect(counts).toBe(1);

    const missing = await protocol()(`/api/packages/downloader/cargo/api/v1/crates/packed/9.9.9/download`, {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, errors: [{ detail: "package does not exist" }] });
  });
});

// ---------------------------------------------------------------------------
// yank / unyank (cargo.go:247-274)
// ---------------------------------------------------------------------------

describe("yank / unyank", () => {
  it("yank flips the property AND the index entry; unyank flips back", async () => {
    const owner = await seedUser("yanker");
    const writer = await token(owner, "write:package");
    await seedCrate(owner, { name: "yanked-crate", vers: "1.0.0" });

    const yank = await protocol()(`/api/packages/yanker/cargo/api/v1/crates/yanked-crate/1.0.0/yank`, {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(yank.status).toBe(200);
    expect(await yank.json()).toEqual({ ok: true });

    const index = await protocol()(`/api/packages/yanker/cargo/4/ya/yanked-crate`, {});
    expect((JSON.parse((await index.text()).trim()) as { yanked: boolean }).yanked).toBe(true);

    const unyank = await protocol()(`/api/packages/yanker/cargo/api/v1/crates/yanked-crate/1.0.0/unyank`, {
      method: "PUT",
      headers: authHeaders(writer),
    });
    expect(unyank.status).toBe(200);
    expect(await unyank.json()).toEqual({ ok: true });
    const index2 = await protocol()(`/api/packages/yanker/cargo/4/ya/yanked-crate`, {});
    expect((JSON.parse((await index2.text()).trim()) as { yanked: boolean }).yanked).toBe(false);
  });

  it("yank on an unknown version → 404; on a version missing the property → the stripped 500", async () => {
    const owner = await seedUser("propyanker");
    const writer = await token(owner, "write:package");
    await seedCrate(owner, { name: "props", vers: "1.0.0" });

    const missing = await protocol()(`/api/packages/propyanker/cargo/api/v1/crates/props/2.0.0/yank`, {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, errors: [{ detail: "package does not exist" }] });

    // Strip the property (a pre-yank-era row) → the 500 sentinel body.
    await db().delete(packageProperties).where(eq(packageProperties.name, "cargo.yanked"));
    const stripped = await protocol()(`/api/packages/propyanker/cargo/api/v1/crates/props/1.0.0/yank`, {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(stripped.status).toBe(500);
    expect(await stripped.json()).toEqual({ ok: false, errors: [{ detail: "internal server error" }] });
  });
});

// ---------------------------------------------------------------------------
// The error shapes (cargo.go:19-49 + the parser sentinels)
// ---------------------------------------------------------------------------

describe("error shapes", () => {
  it("the parser sentinels: invalid name, invalid version, oversize metadata, malformed container", async () => {
    const owner = await seedUser("parser");
    const bad = async (metaJson: string): Promise<Response> => {
      const plain = await token(owner, "write:package");
      const payload = await buildCratePayload("whatever", "1.0.0");
      const container = makeCrateContainer({ name: "whatever", vers: "1.0.0" }, payload, { metaJson });
      return protocol()(`/api/packages/parser/cargo/api/v1/crates/new`, {
        method: "PUT",
        headers: { ...authHeaders(plain), "content-type": "application/json" },
        body: container,
      });
    };

    // nameMatch (parser.go:53): leading digit, leading dash, 65 chars.
    for (const name of ["0test", "-test", "_test", "a".repeat(65)]) {
      const response = await bad(JSON.stringify({ name, vers: "1.0.0" }));
      expect(response.status, name).toBe(400);
      expect(await response.json()).toEqual({ ok: false, errors: [{ detail: "package name is invalid" }] });
    }
    // version.NewSemver (parser.go:63): the parser_test.go invalid set.
    for (const vers of ["", "1.", "-1.0", "1.0.0/1"]) {
      const response = await bad(JSON.stringify({ name: "test", vers }));
      expect(response.status, vers).toBe(400);
      expect(await response.json()).toEqual({ ok: false, errors: [{ detail: "package version is invalid" }] });
    }
    // MaxMetadataSize (limited_reader.go:14): a 33 MiB declared metadata
    // length errors before the read (the declared length rides the header —
    // the container builder only writes 4 bytes; hand-roll the header).
    const plain = await token(owner, "write:package");
    const oversizeHeader = new Uint8Array(4);
    new DataView(oversizeHeader.buffer).setUint32(0, 32 * 1024 * 1024 + 1, true);
    const oversize = await protocol()(`/api/packages/parser/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(plain), "content-type": "application/json" },
      body: oversizeHeader,
    });
    expect(oversize.status).toBe(400);
    expect(await oversize.json()).toEqual({ ok: false, errors: [{ detail: "content exceeds the size limit" }] });
    // A truncated container (metadata cut mid-JSON) → the 400 parse arm.
    const truncated = await protocol()(`/api/packages/parser/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(plain), "content-type": "application/json" },
      body: encoder.encode('{"name":"test","vers"'),
    });
    expect(truncated.status).toBe(400);
    expect((await truncated.json<{ ok: boolean }>()).ok).toBe(false);
  });

  it("short content → 400 invalid content size (cargo.go:181-184); trailing bytes are ignored (the LimitReader truncation)", async () => {
    const owner = await seedUser("sizer");
    const payload = await buildCratePayload("shorty", "1.0.0");
    const metaBytes = encoder.encode(JSON.stringify({ name: "shorty", vers: "1.0.0" }));
    const plain = await token(owner, "write:package");

    // Declared content length 10 bytes LONGER than the payload → short.
    const container = new Uint8Array(4 + metaBytes.byteLength + 4 + payload.byteLength);
    const view = new DataView(container.buffer);
    view.setUint32(0, metaBytes.byteLength, true);
    container.set(metaBytes, 4);
    view.setUint32(4 + metaBytes.byteLength, payload.byteLength + 10, true); // the lie
    container.set(payload, 8 + metaBytes.byteLength);
    const response = await protocol()(`/api/packages/sizer/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(plain), "content-type": "application/json" },
      body: container,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, errors: [{ detail: "invalid content size" }] });

    // TRAILING bytes past the declared length: upstream truncates and
    // succeeds — the download serves exactly the declared window.
    view.setUint32(4 + metaBytes.byteLength, payload.byteLength, true); // the honest length
    const extra = new Uint8Array(container.byteLength + 5);
    extra.set(container);
    extra.set(encoder.encode("junk!"), container.byteLength);
    const ok = await protocol()(`/api/packages/sizer/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(plain), "content-type": "application/json" },
      body: extra,
    });
    expect(ok.status).toBe(200);
    const served = await protocol()(`/api/packages/sizer/cargo/api/v1/crates/shorty/1.0.0/download`, {});
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(payload);
  });

  it("the duplicate version → 409; the quota → 403; the write gate → 401", async () => {
    const owner = await seedUser("dupe");
    await seedCrate(owner, { name: "again", vers: "1.0.0" });
    const second = await publishCrate(owner, { name: "again", vers: "1.0.0" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ ok: false, errors: [{ detail: "package version already exists" }] });

    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "4" });
    const quotaResponse = await capped(`/api/packages/dupe/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(await token(owner, "write:package")), "content-type": "application/json" },
      body: makeCrateContainer({ name: "big", vers: "1.0.0" }, await buildCratePayload("big", "1.0.0")),
    });
    expect(quotaResponse.status).toBe(403);
    expect((await quotaResponse.json<{ errors: { detail: string }[] }>()).errors[0]?.detail).toContain("quota exceeded");

    const anonymous = await protocol()(`/api/packages/dupe/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: makeCrateContainer({ name: "anon", vers: "1.0.0" }, await buildCratePayload("anon", "1.0.0")),
    });
    // The GATE's challenge wins for a credential-less request (the plain
    // body + WWW-Authenticate, the helm test's shape); the family's JSON wrap
    // rides the doer-null arm INSIDE the handler (an invalid token).
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    expect((await anonymous.text()).startsWith("user should have specific permission")).toBe(true);

    const invalid = await protocol()(`/api/packages/dupe/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders("gitea-invalid-token"), "content-type": "application/json" },
      body: makeCrateContainer({ name: "anon", vers: "1.0.0" }, await buildCratePayload("anon", "1.0.0")),
    });
    // An invalid token resolves to no-doer in the credential pass — the same
    // plain gate challenge answers (the JSON wrap inside the handler rides
    // only for a doer-null that slips past the gate, which the gate stack
    // makes unreachable in practice).
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await invalid.text();

    // A read-scope token cannot publish (reqPackageAccess(write)).
    const reader = await token(owner, "read:package");
    const forbidden = await protocol()(`/api/packages/dupe/cargo/api/v1/crates/new`, {
      method: "PUT",
      headers: { ...authHeaders(reader), "content-type": "application/json" },
      body: makeCrateContainer({ name: "ro", vers: "1.0.0" }, await buildCratePayload("ro", "1.0.0")),
    });
    expect(forbidden.status).toBe(401);
  });

  it("PACKAGES_ENABLED=false → the plain 404; anonymous download of a public owner still serves", async () => {
    const owner = await seedUser("gated");
    await seedCrate(owner, { name: "public-good", vers: "1.0.0" });

    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const response = await disabled(`/api/packages/gated/cargo/config.json`, {});
    expect(response.status).toBe(404);

    const anonymous = await protocol()(`/api/packages/gated/cargo/5/pu/public-good`, {});
    expect(anonymous.status).toBe(200);

    // A PRIVATE owner challenges the anonymous reader (the gate's 401 arm);
    // a public-only TOKEN from ANOTHER user is 404-blind (the
    // ownerBlindToPublicOnly arm), while the owner's own token reads.
    const hidden = await seedUser("vault", { visibility: "private" });
    await seedCrate(hidden, { name: "secret", vers: "1.0.0" });
    const blind = await protocol()(`/api/packages/vault/cargo/4/se/secret`, {});
    expect(blind.status).toBe(401);
    const outsider = await seedUser("outsider");
    const blinded = await protocol()(`/api/packages/vault/cargo/4/se/secret`, {
      headers: authHeaders(await token(outsider, "public-only,read:package")),
    });
    expect(blinded.status).toBe(404);
    const ownView = await protocol()(`/api/packages/vault/cargo/4/se/secret`, {
      headers: authHeaders(await token(hidden, "read:package")),
    });
    expect(ownView.status).toBe(200);
  });
});
