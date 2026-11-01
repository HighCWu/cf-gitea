/**
 * The `_cargo-index` git-mirror battery (SPEC-0016 §7 M7's deferred half) —
 * upstream `services/packages/cargo/index.go` at the pin, through
 * cargo-index.ts (ensure / update / rebuild) and the cargo.ts hook seam, on a
 * REAL engine cell (`env.REPO` DO at the rowless `owner/_cargo-index`
 * address) + real D1:
 *
 *  - ensure: the config root commit over an unborn cell (the upstream
 *    InitializeIndexRepository shape), the exact config.json bytes
 *    (`json.Encoder` trailing newline), the idempotent re-run ("current"),
 *    the visibility flip re-stamp ("updated" — auth-required true);
 *  - the unborn-mirror write arm: publish on a never-initialized owner —
 *    the upstream repo-absent no-op (index.go:108-111, NO forced creation);
 *  - upload → the tree: config.json + the crate's sparse-path file
 *    (`buildCargoPackagePath`), the NDJSON line's exact shape (name/vers/
 *    deps []/cksum == payload sha256/features {}/yanked), the second version
 *    REWRITING the file in the upstream string-sort order (1.0.10 before
 *    1.0.2);
 *  - yank/unyank through the hook → the yanked flag flipping in the file;
 *  - delete → removed: the emptied package's file drops, the emptied
 *    directory chain collapses, siblings survive (the adjudicated
 *    remove-on-empty divergence from upstream's stale-file quirk);
 *  - the collision guard: a user-owned `repositories` row at the address →
 *    the mirror arms skip, the tip untouched;
 *  - rebuild: the whole-tree replacement — a stale file for an emptied
 *    package vanishes, live packages re-add, config.json preserved;
 *  - identity: the commit person = the owner's row (the noreply fallback),
 *    the publish hook's doerId overriding it (upstream's ctx.Doer).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { RepoCell } from "@cf-gitea/git-engine";

import { packageFiles, packageProperties, packages, packageVersions, repositories, users } from "../../db/schema";
import {
  buildCargoPackagePath,
  CARGO_YANKED_PROPERTY,
  setCargoPackageYanked,
  uploadCargoPackage,
  type CargoOwner,
} from "./cargo";
import {
  cargoIndexBindings,
  CARGO_INDEX_REF,
  ensureCargoIndexMirror,
  rebuildCargoIndexMirror,
  updateCargoIndexMirror,
} from "./cargo-index";
import { deletePackageVersionAndReferences } from "./model";

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
});

const db = () => drizzle(env.DB);

const ORIGIN = "https://mirror.test";
const bindings = () => ({ repo: env.REPO, origin: ORIGIN });

// ---------------------------------------------------------------------------
// Fixtures — the publish-container builder (the cargo.test.ts pattern: a real
// gzipped tar holding Cargo.toml + src/lib.rs, wrapped in the uint32-LE |
// JSON | uint32-LE | payload container).
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

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildCratePayload(crateName: string, version: string, filler = ""): Promise<Uint8Array> {
  const cargoToml = `[package]\nname = "${crateName}"\nversion = "${version}"\nedition = "2021"\n`;
  const libRs = `pub fn hello() -> &'static str { "cf-gitea cargo" }\n${filler}`;
  return gzipBytes(buildTar([tarMember(`${crateName}-${version}/Cargo.toml`, encoder.encode(cargoToml)), tarMember(`${crateName}-${version}/src/lib.rs`, encoder.encode(libRs))]));
}

function buildTar(members: Uint8Array[]): Uint8Array {
  return concatBytes([...members, new Uint8Array(1024)]);
}

function makeCrateContainer(
  meta: { name: string; vers: string; description?: string },
  payload: Uint8Array,
): Uint8Array {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const metaLen = new Uint8Array(4);
  new DataView(metaLen.buffer).setUint32(0, metaBytes.byteLength, true);
  const contentLen = new Uint8Array(4);
  new DataView(contentLen.buffer).setUint32(0, payload.byteLength, true);
  return concatBytes([metaLen, metaBytes, contentLen, payload]);
}

// ---------------------------------------------------------------------------
// Seeds + mirror readers
// ---------------------------------------------------------------------------

async function seedUser(username: string, opts: { email?: string; visibility?: "public" | "limited" | "private" } = {}) {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      email: opts.email ?? null,
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return row;
}

function cargoOwner(row: { id: number; username: string; usernameLower: string; visibility: "public" | "limited" | "private" }): CargoOwner {
  return { id: row.id, username: row.username, usernameLower: row.usernameLower, visibility: row.visibility };
}

interface PublishResult {
  pkgId: number;
  lowerName: string;
  versionId: number;
  version: string;
  payload: Uint8Array;
}

/** Publish one crate through the REAL service walk with the mirror hook —
 *  the upload → mirror round-trip the route arms drive once the recipe
 *  threads `cargoIndex` (the hook carries doerId = the uploader). */
async function publishCrate(
  owner: CargoOwner,
  meta: { name: string; vers: string; description?: string },
  opts: { hook?: boolean } = {},
): Promise<PublishResult> {
  const payload = await buildCratePayload(meta.name, meta.vers);
  const container = makeCrateContainer(meta, payload);
  const result = await uploadCargoPackage({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner,
    doer: { id: owner.id, isAdmin: false },
    content: new Blob([container]).stream() as ReadableStream<Uint8Array>,
    declaredLength: container.byteLength,
    quota: { limitTotalOwnerCount: -1, limitTotalOwnerSize: -1, limitSizeGeneric: -1, packagesEnabled: true },
    ...(opts.hook === false ? {} : { cargoIndex: { bindings: bindings(), doerId: owner.id } }),
  });
  return { pkgId: result.pkg.id, lowerName: result.pkg.lowerName, versionId: result.versionId, version: result.version, payload };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The mirror cell's raw stub — real-cell reads straight off the DO. */
function mirrorCell(ownerNamespace: string): DurableObjectStub<RepoCell> {
  return env.REPO.getByName(`${ownerNamespace}/_cargo-index`);
}

async function mirrorTip(ownerNamespace: string): Promise<string | null> {
  const refs = await mirrorCell(ownerNamespace).listRefs();
  const found = refs?.refs.find((ref) => ref.name === CARGO_INDEX_REF);
  return found?.target ?? null;
}

async function mirrorBlob(ownerNamespace: string, path: string): Promise<Uint8Array | null> {
  const blob = await mirrorCell(ownerNamespace).readBlob(CARGO_INDEX_REF, path);
  return blob?.data ?? null;
}

interface IndexLine {
  name: string;
  vers: string;
  deps: unknown[];
  cksum: string;
  features: Record<string, string[]>;
  yanked: boolean;
}

async function mirrorLines(ownerNamespace: string, path: string): Promise<IndexLine[]> {
  const bytes = await mirrorBlob(ownerNamespace, path);
  if (bytes === null) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as IndexLine);
}

// ---------------------------------------------------------------------------
// ensure — InitializeIndexRepository (index.go:50-61)
// ---------------------------------------------------------------------------

describe("ensureCargoIndexMirror", () => {
  it("creates the cell: the config root commit with the exact config.json bytes", async () => {
    const owner = await seedUser("ensure-owner");
    const result = await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(result.tag).toBe("created");
    if (result.tag !== "created") return;

    const tip = await mirrorTip(owner.usernameLower);
    expect(tip).toBe(result.commitOid);
    const config = await mirrorBlob(owner.usernameLower, "config.json");
    expect(config).not.toBeNull();
    const expected = `${JSON.stringify({
      dl: `${ORIGIN}/api/packages/${owner.username}/cargo/api/v1/crates`,
      api: `${ORIGIN}/api/packages/${owner.username}/cargo`,
      "auth-required": false,
    })}\n`;
    expect(new TextDecoder().decode(config as Uint8Array)).toBe(expected);

    // The first commit carries no parents (the unborn-cell root shape).
    const commit = await mirrorCell(owner.usernameLower).readCommit(tip as string);
    expect(commit?.parents).toEqual([]);
  });

  it("is idempotent over a current config (current) and re-stamps on a visibility flip (updated)", async () => {
    const owner = await seedUser("ensure-twice");
    const first = await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(first.tag).toBe("created");
    const tipBefore = await mirrorTip(owner.usernameLower);

    const second = await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(second.tag).toBe("current");
    expect(await mirrorTip(owner.usernameLower)).toBe(tipBefore);

    await db().update(users).set({ visibility: "private" }).where(eq(users.id, owner.id));
    const third = await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(third.tag).toBe("updated");
    const config = new TextDecoder().decode((await mirrorBlob(owner.usernameLower, "config.json")) as Uint8Array);
    expect((JSON.parse(config) as { "auth-required": boolean })["auth-required"]).toBe(true);
    expect(await mirrorTip(owner.usernameLower)).not.toBe(tipBefore);
  });

  it("refuses a user-owned repositories row at the address (the collision guard)", async () => {
    const owner = await seedUser("ensure-collide");
    await db().insert(repositories).values({
      id: "r_user_cargo_index",
      storageKey: "r_user_cargo_index",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "_cargo-index",
      visibility: "public",
    });
    const result = await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(result.tag).toBe("refused");
    expect(await mirrorTip(owner.usernameLower)).toBeNull();
  });

  it("resolves the origin through cargoIndexBindings' APP_URL → request-origin chain", () => {
    expect(cargoIndexBindings({ REPO: env.REPO }, "https://req.test/").origin).toBe("https://req.test");
    expect(cargoIndexBindings({ REPO: env.REPO, APP_URL: "https://app.test/" }).origin).toBe("https://app.test");
  });
});

// ---------------------------------------------------------------------------
// update — UpdatePackageIndexIfExists' present arm (index.go:108-134)
// ---------------------------------------------------------------------------

describe("updateCargoIndexMirror (the write arms)", () => {
  it("publish on a never-initialized owner is the repo-absent no-op — no cell created", async () => {
    const owner = await seedUser("absent-owner");
    const published = await publishCrate(cargoOwner(owner), { name: "absentcrate", vers: "0.1.0" });
    expect(published.versionId).toBeGreaterThan(0);

    // The hook ran; the mirror stayed unborn (no forced creation).
    expect(await mirrorTip(owner.usernameLower)).toBeNull();
    const refs = await mirrorCell(owner.usernameLower).listRefs();
    expect(refs?.refs ?? []).toHaveLength(0);
  });

  it("upload → the tree holds config.json + the crate file with the exact NDJSON line", async () => {
    const owner = await seedUser("mirror-upload");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    const published = await publishCrate(cargoOwner(owner), { name: "mirrordemo", vers: "1.0.0" });

    const path = buildCargoPackagePath(published.lowerName);
    expect(path).toBe("mi/rr/mirrordemo");
    expect(await mirrorBlob(owner.usernameLower, "config.json")).not.toBeNull();
    const lines = await mirrorLines(owner.usernameLower, path);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      name: "mirrordemo",
      vers: "1.0.0",
      deps: [],
      cksum: await sha256Hex(published.payload),
      features: {},
      yanked: false,
    });
  });

  it("a second version REWRITES the same file in the upstream string-sort order", async () => {
    const owner = await seedUser("mirror-order");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    await publishCrate(cargoOwner(owner), { name: "ordercrate", vers: "1.0.2" });
    await publishCrate(cargoOwner(owner), { name: "ordercrate", vers: "1.0.10" });

    const lines = await mirrorLines(owner.usernameLower, buildCargoPackagePath("ordercrate"));
    // package_version.go:287-294 — version ASC, id DESC, the RAW string sort.
    expect(lines.map((line) => line.vers)).toEqual(["1.0.10", "1.0.2"]);
  });

  it("yank/unyank through the hook flips the yanked flag in the mirror file", async () => {
    const owner = await seedUser("mirror-yank");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    await publishCrate(cargoOwner(owner), { name: "yankcrate", vers: "2.0.0" });
    const path = buildCargoPackagePath("yankcrate");

    await setCargoPackageYanked(env.DB, owner.id, "yankcrate", "2.0.0", true, { bindings: bindings(), doerId: owner.id });
    expect((await mirrorLines(owner.usernameLower, path))[0]?.yanked).toBe(true);

    await setCargoPackageYanked(env.DB, owner.id, "yankcrate", "2.0.0", false, { bindings: bindings(), doerId: owner.id });
    expect((await mirrorLines(owner.usernameLower, path))[0]?.yanked).toBe(false);
  });

  it("delete → removed: the emptied package's file drops, the dir chain collapses, siblings survive", async () => {
    const owner = await seedUser("mirror-delete");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    const doomed = await publishCrate(cargoOwner(owner), { name: "doomedcrate", vers: "1.0.0" });
    const survivor = await publishCrate(cargoOwner(owner), { name: "survivorcrate", vers: "1.0.0" });
    expect(await mirrorBlob(owner.usernameLower, buildCargoPackagePath("doomedcrate"))).not.toBeNull();

    // The cleanup rider's shape: the version rows die, the package row
    // remains with zero versions, the seam re-runs (cargo.go-adjacent —
    // cleanup.go:115's UpdatePackageIndexIfExists).
    await deletePackageVersionAndReferences(env.DB, doomed.versionId);
    const pkgRow = await db().select().from(packages).where(eq(packages.id, doomed.pkgId)).get();
    expect(pkgRow).toBeDefined();
    const result = await updateCargoIndexMirror(bindings(), env.DB, owner.id, pkgRow as NonNullable<typeof pkgRow>);
    expect(result.tag).toBe("removed");

    expect(await mirrorBlob(owner.usernameLower, buildCargoPackagePath("doomedcrate"))).toBeNull();
    // The emptied `do/om` directory chain collapsed — the root only carries
    // config.json + the sibling's shard.
    const root = await mirrorCell(owner.usernameLower).listTree(CARGO_INDEX_REF, "");
    const names = (root?.entries ?? []).map((entry) => entry.name).sort();
    expect(names).toContain("config.json");
    expect(names).toContain("su");
    expect(names).not.toContain("do");
    expect((await mirrorLines(owner.usernameLower, buildCargoPackagePath("survivorcrate"))).length).toBe(1);
    void survivor;
  });

  it("a zero-version update for a never-mirrored package resolves unchanged", async () => {
    const owner = await seedUser("mirror-emptied");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    // The publish ran WITHOUT the hook — the crate's file never reached the
    // tree; the remove arm must find nothing to drop.
    const published = await publishCrate(cargoOwner(owner), { name: "ghostcrate", vers: "1.0.0" }, { hook: false });
    await deletePackageVersionAndReferences(env.DB, published.versionId);
    const pkgRow = await db().select().from(packages).where(eq(packages.id, published.pkgId)).get();
    const result = await updateCargoIndexMirror(bindings(), env.DB, owner.id, pkgRow as NonNullable<typeof pkgRow>);
    expect(result.tag).toBe("unchanged");
  });

  it("the collision guard: a user-owned repositories row freezes the mirror arms", async () => {
    const owner = await seedUser("mirror-collide");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    const frozen = await publishCrate(cargoOwner(owner), { name: "frozencrate", vers: "1.0.0" });
    const tipBefore = await mirrorTip(owner.usernameLower);

    await db().insert(repositories).values({
      id: "r_user_cargo_index_two",
      storageKey: "r_user_cargo_index_two",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "_cargo-index",
      visibility: "public",
    });
    const pkgRow = await db().select().from(packages).where(eq(packages.id, frozen.pkgId)).get();
    const result = await updateCargoIndexMirror(bindings(), env.DB, owner.id, pkgRow as NonNullable<typeof pkgRow>);
    expect(result.tag).toBe("refused");
    expect(await mirrorTip(owner.usernameLower)).toBe(tipBefore);
  });
});

// ---------------------------------------------------------------------------
// rebuild — RebuildIndex (index.go:63-106)
// ---------------------------------------------------------------------------

describe("rebuildCargoIndexMirror", () => {
  it("replaces the whole tree: the stale file of an emptied package vanishes, live packages re-add, config preserved", async () => {
    const owner = await seedUser("rebuild-owner");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    const stale = await publishCrate(cargoOwner(owner), { name: "stalecrate", vers: "1.0.0" });
    await publishCrate(cargoOwner(owner), { name: "livecrate", vers: "3.1.0" });

    // The upstream-quirk path: the emptied package's file goes stale (the
    // version dies WITHOUT the hook re-running).
    await deletePackageVersionAndReferences(env.DB, stale.versionId);

    const configBefore = await mirrorBlob(owner.usernameLower, "config.json");
    const result = await rebuildCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(result.tag).toBe("committed");
    if (result.tag !== "committed") return;
    expect(result.files).toBe(2); // config.json + the live package

    expect(await mirrorBlob(owner.usernameLower, buildCargoPackagePath("stalecrate"))).toBeNull();
    const liveLines = await mirrorLines(owner.usernameLower, buildCargoPackagePath("livecrate"));
    expect(liveLines.map((line) => line.vers)).toEqual(["3.1.0"]);
    expect(await mirrorBlob(owner.usernameLower, "config.json")).toEqual(configBefore as Uint8Array);

    // Idempotent: a rebuild over a current tree lands nothing new to do —
    // the commit still forms (upstream commits unconditionally), the tree
    // content is stable.
    const again = await rebuildCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(again.tag).toBe("committed");
    expect(await mirrorBlob(owner.usernameLower, buildCargoPackagePath("livecrate"))).not.toBeNull();
  });

  it("get-or-creates on an unborn cell (the RebuildIndex init arm)", async () => {
    const owner = await seedUser("rebuild-fresh");
    const result = await rebuildCargoIndexMirror(bindings(), env.DB, owner.id);
    expect(result.tag).toBe("committed");
    if (result.tag !== "committed") return;
    expect(result.files).toBe(1); // config.json only
    expect(await mirrorBlob(owner.usernameLower, "config.json")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Identity — indexPerson (upstream's CommitTreeUserOptions{DoerUser: doer})
// ---------------------------------------------------------------------------

describe("mirror commit identity", () => {
  it("commits as the owner (noreply fallback) and as the hook's doer when given", async () => {
    const owner = await seedUser("identity-owner", { email: "owner@rustacean.dev" });
    const doer = await seedUser("identity-doer", { email: "doer@rustacean.dev" });
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id, { doerId: doer.id });

    const tip = await mirrorTip(owner.usernameLower);
    const commit = await mirrorCell(owner.usernameLower).readCommit(tip as string);
    expect(commit?.author.name).toBe(doer.username);
    expect(commit?.author.email).toBe("doer@rustacean.dev");

    // The publish arm's hook carries doerId = the uploader (this test's
    // owner row is both owner and uploader — the ctx.Doer author).
    await publishCrate(cargoOwner(owner), { name: "identcrate", vers: "1.0.0" });
    const afterTip = await mirrorTip(owner.usernameLower);
    const publishCommit = await mirrorCell(owner.usernameLower).readCommit(afterTip as string);
    expect(publishCommit?.author.name).toBe(owner.username);
    expect(publishCommit?.author.email).toBe("owner@rustacean.dev");
    expect(publishCommit?.message.startsWith("Update identcrate")).toBe(true);

    await setCargoPackageYanked(env.DB, owner.id, "identcrate", "1.0.0", true, { bindings: bindings() });
    const yankTip = await mirrorTip(owner.usernameLower);
    const yankCommit = await mirrorCell(owner.usernameLower).readCommit(yankTip as string);
    expect(yankCommit?.author.name).toBe(owner.username);
    expect(yankCommit?.author.email).toBe("owner@rustacean.dev");
  });

  it("falls back to the noreply address when the email column is null", async () => {
    const owner = await seedUser("noreply-owner");
    await ensureCargoIndexMirror(bindings(), env.DB, owner.id);
    const tip = await mirrorTip(owner.usernameLower);
    const commit = await mirrorCell(owner.usernameLower).readCommit(tip as string);
    expect(commit?.author.email).toBe(`noreply-owner@noreply.mirror.test`);
    expect(commit?.message.startsWith("Initialize Cargo Config")).toBe(true);
  });
});

// The lead-file marker (package_files.is_lead) sanity — the cksum the mirror
// lines carry is the LEAD blob's sha256, and the D1 posture the mirror reads
// is the cargo family's (yanked property present on every publish).
describe("the D1 posture the mirror reads", () => {
  it("publish seeds the cargo.yanked property and the lead file the mirror derives from", async () => {
    const owner = await seedUser("posture-owner");
    const published = await publishCrate(cargoOwner(owner), { name: "posturecrate", vers: "1.0.0" });
    const files = await db().select().from(packageFiles).where(eq(packageFiles.versionId, published.versionId)).all();
    expect(files).toHaveLength(1);
    expect(files[0]?.isLead).toBe(true);
    const props = await db()
      .select()
      .from(packageProperties)
      .where(eq(packageProperties.refId, published.versionId))
      .all();
    expect(props.find((prop) => prop.name === CARGO_YANKED_PROPERTY)?.value).toBe("false");
    const versions = await db().select().from(packageVersions).where(eq(packageVersions.id, published.versionId)).all();
    expect(versions).toHaveLength(1);
  });
});
