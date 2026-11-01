/**
 * The CARGO protocol routes' `_cargo-index` mirror threading (SPEC-0016 §7 —
 * the e4d7e49 recipe's execution at the ROUTE level) on a REAL engine cell +
 * real D1, upstream routers/api/packages/cargo/cargo.go at the pin:
 *
 *  - the publish arm (`PUT /api/packages/{owner}/cargo/api/v1/crates/new`)
 *    threads `cargoIndex: { bindings: cargoIndexBindings(c.env), doerId:
 *    doer.id }` — a publish over an INITIALIZED mirror lands the crate's
 *    sparse-path file with the exact NDJSON line (cksum == the payload's
 *    sha256), committed as the DOER (upstream's ctx.Doer, index.go:301-303 —
 *    the route threads the token's user, the module battery pins the seam);
 *  - the yank arm (`DELETE …/yank`) flips the yanked flag in the mirror file
 *    through the route (cargo.go:262-267's UpdatePackageIndexIfExists);
 *  - the cleanup rider arm: the REPO_TASKS consumer's
 *    handlePackagesCleanup (the REPO binding threaded per the same recipe —
 *    cleanup.go:108-118's per-package UpdatePackageIndexIfExists) rewrites
 *    the mirror file from D1 after the rule trims a version — the trimmed
 *    version's line drops, the survivor stays.
 *
 * The route harness is the protocol battery's mount shape (the sub-app at
 * /api/packages); the crate fixtures are the cargo-index module battery's
 * (the real gzipped tar in the uint32-LE container).
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { RepoCell } from "@cf-gitea/git-engine";

import { packageCleanupRules, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import { buildCargoPackagePath, CARGO_INDEX_REPOSITORY_NAME } from "../../services/packages/cargo";
import { CARGO_INDEX_REF, ensureCargoIndexMirror } from "../../services/packages/cargo-index";
import { handlePackagesCleanup } from "../../services/packages/cleanup";

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

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(): (path: string, init?: RequestInit) => Promise<Response> {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), env);
}

async function seedUser(username: string): Promise<{ id: number; username: string; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: "public",
      createdAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return { id: row.id, username: row.username, usernameLower: row.usernameLower };
}

async function token(userId: number): Promise<string> {
  return (await mintFor(userId, "pat-cargo-mirror", "write:package")).plaintext;
}

// --- the crate fixtures (the cargo-index module battery's builders) ----------

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
  header.set(encoder.encode("0000644\0"), 100);
  header.set(encoder.encode("0000000\0"), 108);
  header.set(encoder.encode("0000000\0"), 116);
  header.set(encoder.encode(`${content.byteLength.toString(8).padStart(11, "0")}\0`), 124);
  header.set(encoder.encode("00000000000\0"), 136);
  header.set(encoder.encode("        "), 148);
  header[156] = 0x30;
  header.set(encoder.encode("ustar\x00" + "00"), 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padding = new Uint8Array((512 - (content.byteLength % 512)) % 512);
  return concatBytes([header, content, padding]);
}

function buildTar(members: Uint8Array[]): Uint8Array {
  return concatBytes([...members, new Uint8Array(1024)]);
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildCratePayload(crateName: string, version: string): Promise<Uint8Array> {
  const cargoToml = `[package]\nname = "${crateName}"\nversion = "${version}"\nedition = "2021"\n`;
  const libRs = `pub fn hello() -> &'static str { "cf-gitea cargo" }\n`;
  return gzipBytes(buildTar([tarMember(`${crateName}-${version}/Cargo.toml`, encoder.encode(cargoToml)), tarMember(`${crateName}-${version}/src/lib.rs`, encoder.encode(libRs))]));
}

function makeCrateContainer(meta: { name: string; vers: string }, payload: Uint8Array): Uint8Array {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const metaLen = new Uint8Array(4);
  new DataView(metaLen.buffer).setUint32(0, metaBytes.byteLength, true);
  const contentLen = new Uint8Array(4);
  new DataView(contentLen.buffer).setUint32(0, payload.byteLength, true);
  return concatBytes([metaLen, metaBytes, contentLen, payload]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// --- the mirror readers (the module battery's raw-cell shape) -----------------

function mirrorCell(ownerNamespace: string): DurableObjectStub<RepoCell> {
  return env.REPO.getByName(`${ownerNamespace}/${CARGO_INDEX_REPOSITORY_NAME}`);
}

async function mirrorTip(ownerNamespace: string): Promise<string | null> {
  const refs = await mirrorCell(ownerNamespace).listRefs();
  const found = refs?.refs.find((ref) => ref.name === CARGO_INDEX_REF);
  return found?.target ?? null;
}

async function mirrorLines(ownerNamespace: string, path: string): Promise<Array<{ name: string; vers: string; cksum: string; yanked: boolean }>> {
  const blob = await mirrorCell(ownerNamespace).readBlob(CARGO_INDEX_REF, path);
  if (blob === null || blob.data === undefined) throw new Error(`mirror blob ${path} absent`);
  return new TextDecoder()
    .decode(blob.data)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { name: string; vers: string; cksum: string; yanked: boolean });
}

/** Publish one crate THROUGH THE ROUTE (the token's user is the doer). */
async function routePublish(owner: { username: string }, writerToken: string, name: string, vers: string): Promise<Response> {
  const payload = await buildCratePayload(name, vers);
  const container = makeCrateContainer({ name, vers }, payload);
  return protocol()(`/api/packages/${owner.username}/cargo/api/v1/crates/new`, {
    method: "PUT",
    headers: { authorization: `token ${writerToken}`, "content-type": "application/octet-stream", "content-length": String(container.byteLength) },
    body: container as unknown as BodyInit,
  });
}

// --- the arms -----------------------------------------------------------------

describe("the cargo publish route threads the _cargo-index hook (the e4d7e49 recipe at the route level)", () => {
  it("publish → mirror-updated: the route's PUT lands the sparse-path file, committed as the doer", async () => {
    const owner = await seedUser("cargoroute");
    // The mirror must be BORN first — the unborn-cell write arm is the
    // upstream repo-absent no-op (index.go:108-111, no forced creation).
    await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://mirror.test" }, env.DB, owner.id);
    const writerToken = await token(owner.id);

    const res = await routePublish(owner, writerToken, "routedemo", "1.0.0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const path = buildCargoPackagePath("routedemo");
    const lines = await mirrorLines(owner.usernameLower, path);
    expect(lines).toHaveLength(1);
    const payload = await buildCratePayload("routedemo", "1.0.0");
    expect(lines[0]).toEqual({ name: "routedemo", vers: "1.0.0", deps: [], cksum: await sha256Hex(payload), features: {}, yanked: false });
    // The route threaded doerId = cred.doer (upstream's ctx.Doer author —
    // the owner publishes with their own token here, the same person).
    const tip = await mirrorTip(owner.usernameLower);
    const commit = await mirrorCell(owner.usernameLower).readCommit(tip as string);
    expect(commit?.author.name).toBe(owner.username);
    expect(commit?.message.startsWith("Update routedemo")).toBe(true);
  });

  it("the yank route flips the yanked flag in the mirror file (cargo.go:262-267 through the route)", async () => {
    const owner = await seedUser("cargoyank");
    await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://mirror.test" }, env.DB, owner.id);
    const writerToken = await token(owner.id);
    expect(await routePublish(owner, writerToken, "routeyank", "2.0.0").then((r) => r.status)).toBe(200);
    const path = buildCargoPackagePath("routeyank");
    expect((await mirrorLines(owner.usernameLower, path))[0]?.yanked).toBe(false);

    const res = await protocol()(`/api/packages/${owner.username}/cargo/api/v1/crates/routeyank/2.0.0/yank`, {
      method: "DELETE",
      headers: { authorization: `token ${writerToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await mirrorLines(owner.usernameLower, path))[0]?.yanked).toBe(true);
  });
});

describe("the cleanup rider threads the mirror hook (cleanup.go:108-118 through the consumer)", () => {
  it("a keep-count rule's trimmed version drops from the mirror file; the survivor stays", async () => {
    const owner = await seedUser("cargocleanup");
    await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://mirror.test" }, env.DB, owner.id);
    const writerToken = await token(owner.id);
    expect(await routePublish(owner, writerToken, "ridercrate", "1.0.0").then((r) => r.status)).toBe(200);
    expect(await routePublish(owner, writerToken, "ridercrate", "1.0.1").then((r) => r.status)).toBe(200);
    const path = buildCargoPackagePath("ridercrate");
    expect((await mirrorLines(owner.usernameLower, path)).map((line) => line.vers)).toEqual(["1.0.0", "1.0.1"]);

    // The rule: keep the newest 1, remove older ones (removeDays 0 — every
    // version is at-or-past the cut, the positional trim decides).
    await db().insert(packageCleanupRules).values({
      enabled: true,
      ownerId: owner.id,
      type: "cargo",
      keepCount: 1,
      keepPattern: "",
      removeDays: 0,
      removePattern: "",
      matchFullName: false,
      createdUnix: new Date(),
      updatedUnix: new Date(),
    });

    // The REPO_TASKS consumer's arm with the REPO binding threaded (the
    // widened PackagesCleanupEnv Pick — the rider's 4th arg carries the
    // bindings; the owner authors, doerId omitted).
    await handlePackagesCleanup(env);

    const rows = await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.ownerId, owner.id)).all();
    expect(rows).toHaveLength(1); // the rule survived the sweep (no purge arm here)
    expect((await mirrorLines(owner.usernameLower, path)).map((line) => line.vers)).toEqual(["1.0.1"]);
  });
});
