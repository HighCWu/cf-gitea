/**
 * The package model service on real D1 (SPEC-0016 §6 model battery): the
 * GetOrInsert shapes (duplicate package → existing row; duplicate version →
 * existing row; blob dedup; the file duplicate's three outcomes), the UNIQUE
 * arbitrations, the searches (latest-per-package + all-versions), the
 * link/unlink pair, the delete cascades, the download counter, the quota
 * checks (admin bypass, -1 defaults, owner accumulation), and the
 * determinePackageAccessMode ladder with the §4.1 org fold.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  orgMembers,
  packageBlobs,
  packages,
  repositories,
  teamMembers,
  teams,
  users,
} from "../../db/schema";
import {
  PropertyType,
  type PackageOwnerRow,
  checkCountQuotaExceeded,
  checkSizeQuotaExceeded,
  calculateFileSize,
  countVersions,
  deletePackageAndReferences,
  deletePackageVersionAndReferences,
  determinePackageAccessMode,
  findExpiredUnreferencedBlobs,
  findUnreferencedPackages,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  hasVersionFileReferences,
  incrementDownloadCounter,
  linkPackageToRepo,
  packagesQuotaFromEnv,
  searchLatestVersions,
  searchVersions,
  tryInsertFile,
  unlinkPackageFromRepo,
  unlinkPackagesOfRepo,
  DEFAULT_LIMIT_SIZE_GENERIC,
} from "./model";
import { getOrInsertBlob } from "./blobs";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  // Children before parents; the users cascade last (repositories is in the
  // sweep so the link fixtures' storage keys never collide across tests).
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repositories",
    "team_members",
    "team_repo_access",
    "teams",
    "org_members",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);
const NOW = new Date("2026-10-29T12:00:00Z");

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; type?: "user" | "org"; visibility?: "public" | "limited" | "private" } = {},
) {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: opts.type ?? "user",
      visibility: opts.visibility ?? "public",
      createdAt: NOW,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user;
}

/** One blob row from a fixed payload (the tests' shared digest fixture). */
async function seedBlob(payload: string, now = NOW) {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { row } = await getOrInsertBlob(env.DB, { size: bytes.byteLength, sha256, now });
  return { row, sha256 };
}

async function seedPackageVersion(ownerId: number, name: string, version: string, creatorId = 0, now = NOW) {
  const { row: pkg } = await getOrInsertPackage(env.DB, { ownerId, type: "generic", name, now });
  const { row: ver } = await getOrInsertVersion(env.DB, { packageId: pkg.id, creatorId, version, now });
  return { pkg, ver };
}

// ---------------------------------------------------------------------------
// GetOrInsert shapes (§5.2)
// ---------------------------------------------------------------------------

describe("getOrInsertPackage (TryInsertPackage arbitration)", () => {
  it("creates once and answers the EXISTING row for a duplicate (any display case)", async () => {
    const owner = await seedUser("alice");
    const first = await getOrInsertPackage(env.DB, { ownerId: owner.id, type: "generic", name: "MyPkg", now: NOW });
    expect(first.created).toBe(true);
    expect(first.row.lowerName).toBe("mypkg");

    const duplicate = await getOrInsertPackage(env.DB, { ownerId: owner.id, type: "generic", name: "mypkg", now: NOW });
    expect(duplicate.created).toBe(false);
    expect(duplicate.row.id).toBe(first.row.id);
  });

  it("keeps (owner, type, lower_name) distinct — same name across owners/types", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const a = await getOrInsertPackage(env.DB, { ownerId: alice.id, type: "generic", name: "tool", now: NOW });
    const b = await getOrInsertPackage(env.DB, { ownerId: bob.id, type: "generic", name: "tool", now: NOW });
    const otherType = await getOrInsertPackage(env.DB, { ownerId: alice.id, type: "npm", name: "tool", now: NOW });
    expect(new Set([a.row.id, b.row.id, otherType.row.id]).size).toBe(3);
  });
});

describe("getOrInsertVersion (GetOrInsertVersion arbitration)", () => {
  it("answers the existing row on a re-publish (the ErrDuplicatePackageVersion shape)", async () => {
    const owner = await seedUser("alice");
    const created = await getOrInsertPackage(env.DB, { ownerId: owner.id, type: "generic", name: "app", now: NOW });
    const first = await getOrInsertVersion(env.DB, { packageId: created.row.id, creatorId: owner.id, version: "1.0.0", now: NOW });
    expect(first.created).toBe(true);
    const republish = await getOrInsertVersion(env.DB, { packageId: created.row.id, creatorId: owner.id, version: "1.0.0", now: NOW });
    expect(republish.created).toBe(false);
    expect(republish.row.id).toBe(first.row.id);
  });

  it("is case-insensitive on the version (lower_version is the uniqueness key)", async () => {
    const owner = await seedUser("alice");
    const { pkg } = await seedPackageVersion(owner.id, "app", "V1.0");
    const twin = await getOrInsertVersion(env.DB, { packageId: pkg.id, creatorId: 0, version: "v1.0", now: NOW });
    expect(twin.created).toBe(false);
    void pkg;
  });
});

describe("getOrInsertBlob + tryInsertFile (the dedup pair)", () => {
  it("dedups identical bytes to one blob row (the extra digests ride the first insert)", async () => {
    const first = await getOrInsertBlob(env.DB, { size: 5, sha256: "a".repeat(64), now: NOW });
    expect(first.created).toBe(true);
    // The sha256 IS the content identity: a second lookup carrying digest
    // extras the first insert did not store still answers the SAME row.
    const second = await getOrInsertBlob(env.DB, { size: 5, sha256: "a".repeat(64), sha1: "b".repeat(40), now: NOW });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.hashSha1).toBeNull(); // first writer wins on the optional digests
  });

  it("same sha256 with a drifted size answers the existing row (the sha256 IS the content identity)", async () => {
    const first = await getOrInsertBlob(env.DB, { size: 5, sha256: "a".repeat(64), now: NOW });
    // Upstream's lookup spans size+all-four-hashes and a drifted size would
    // error on the sha256 UNIQUE; ours re-selects by the content identity in
    // the conflict arm — the sha256 names the bytes, so the row is shared.
    const drifted = await getOrInsertBlob(env.DB, { size: 4, sha256: "a".repeat(64), now: NOW });
    expect(drifted.created).toBe(false);
    expect(drifted.row.id).toBe(first.row.id);
  });

  it("files: created / identical (same blob) / conflict (different blob) on the same key", async () => {
    const owner = await seedUser("alice");
    const { ver } = await seedPackageVersion(owner.id, "app", "1.0");
    const blobA = await seedBlob("payload-a");
    const blobB = await seedBlob("payload-b");

    const created = await tryInsertFile(env.DB, { versionId: ver.id, blobId: blobA.row.id, name: "file.bin", now: NOW });
    expect(created.outcome).toBe("created");

    const identical = await tryInsertFile(env.DB, { versionId: ver.id, blobId: blobA.row.id, name: "FILE.BIN", now: NOW });
    expect(identical.outcome).toBe("identical");
    expect(identical.row.id).toBe(created.row.id);

    const conflict = await tryInsertFile(env.DB, { versionId: ver.id, blobId: blobB.row.id, name: "file.bin", now: NOW });
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.row.id).toBe(created.row.id);

    // A different composite key is a distinct file identity.
    const otherKey = await tryInsertFile(env.DB, {
      versionId: ver.id,
      blobId: blobB.row.id,
      name: "file.bin",
      compositeKey: "maven-arm",
      now: NOW,
    });
    expect(otherKey.outcome).toBe("created");
  });

  it("dedups across owners: two owners, one blob row, two file rows (§6 model plan)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const shared = await seedBlob("same-bytes-everywhere");
    const a = await seedPackageVersion(alice.id, "shared", "1.0");
    const b = await seedPackageVersion(bob.id, "shared", "1.0");
    const fileA = await tryInsertFile(env.DB, { versionId: a.ver.id, blobId: shared.row.id, name: "asset", now: NOW });
    const fileB = await tryInsertFile(env.DB, { versionId: b.ver.id, blobId: shared.row.id, name: "asset", now: NOW });
    expect(fileA.outcome).toBe("created");
    expect(fileB.outcome).toBe("created");
    const allBlobs = await db().select().from(packageBlobs).all();
    expect(allBlobs).toHaveLength(1);
    expect(allBlobs[0]?.id).toBe(shared.row.id);
  });

  it("getFileForVersionByName resolves case-insensitively and misses on empty name", async () => {
    const owner = await seedUser("alice");
    const { ver } = await seedPackageVersion(owner.id, "app", "1.0");
    const blob = await seedBlob("x");
    await tryInsertFile(env.DB, { versionId: ver.id, blobId: blob.row.id, name: "README.md", now: NOW });
    expect((await getFileForVersionByName(env.DB, ver.id, "readme.md"))?.name).toBe("README.md");
    expect(await getFileForVersionByName(env.DB, ver.id, "")).toBeNull();
    expect(await getFileForVersionByName(env.DB, ver.id, "missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Searches (SearchVersions / SearchLatestVersions)
// ---------------------------------------------------------------------------

describe("searchVersions / searchLatestVersions", () => {
  it("orders by created desc, id desc and reports the total count", async () => {
    const owner = await seedUser("alice");
    await seedPackageVersion(owner.id, "app", "0.1", 0, new Date("2026-01-01T00:00:00Z"));
    await seedPackageVersion(owner.id, "app", "0.2", 0, new Date("2026-01-02T00:00:00Z"));
    const { rows, count } = await searchVersions(env.DB, { ownerId: owner.id });
    expect(count).toBe(2);
    expect(rows.map((r) => r.version.lowerVersion)).toEqual(["0.2", "0.1"]);
  });

  it("latest-per-package is the MAX(id) GROUP BY package_id shape", async () => {
    const owner = await seedUser("alice");
    await seedPackageVersion(owner.id, "app", "0.1", 0, new Date("2026-01-01T00:00:00Z"));
    const second = await seedPackageVersion(owner.id, "app", "0.2", 0, new Date("2026-01-02T00:00:00Z"));
    await seedPackageVersion(owner.id, "lib", "9.9", 0, new Date("2026-01-03T00:00:00Z"));
    const { rows, count } = await searchLatestVersions(env.DB, { ownerId: owner.id });
    expect(count).toBe(2);
    const ids = rows.map((r) => r.version.id).sort((x, y) => x - y);
    expect(ids).toContain(second.ver.id);
  });

  it("filters by type, exact name and the q substring; excludeInternal pins both flags", async () => {
    const owner = await seedUser("alice");
    await seedPackageVersion(owner.id, "app", "1.0");
    await seedPackageVersion(owner.id, "lib", "1.0");
    const genericOnly = await searchVersions(env.DB, { ownerId: owner.id, type: "generic", excludeInternal: true });
    expect(genericOnly.count).toBe(2);
    const exact = await searchVersions(env.DB, { ownerId: owner.id, name: "APP", exact: true });
    expect(exact.count).toBe(1);
    const fuzzy = await searchVersions(env.DB, { ownerId: owner.id, name: "pp" });
    expect(fuzzy.count).toBe(1);
    const none = await searchVersions(env.DB, { ownerId: owner.id, type: "npm", excludeInternal: true });
    expect(none.count).toBe(0);
  });

  it("pagination returns the requested page window", async () => {
    const owner = await seedUser("alice");
    await seedPackageVersion(owner.id, "app", "1.0", 0, new Date("2026-01-01T00:00:00Z"));
    await seedPackageVersion(owner.id, "app", "2.0", 0, new Date("2026-01-02T00:00:00Z"));
    await seedPackageVersion(owner.id, "app", "3.0", 0, new Date("2026-01-03T00:00:00Z"));
    const page1 = await searchVersions(env.DB, { ownerId: owner.id, page: 1, limit: 2 });
    expect(page1.count).toBe(3);
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0]?.version.lowerVersion).toBe("3.0");
    const page2 = await searchVersions(env.DB, { ownerId: owner.id, page: 2, limit: 2 });
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]?.version.lowerVersion).toBe("1.0");
  });

  it("getVersionByNameAndVersion walks owner+type+name+version case-insensitively", async () => {
    const owner = await seedUser("Alice");
    await seedPackageVersion(owner.id, "MyPkg", "V2");
    const found = await getVersionByNameAndVersion(env.DB, owner.id, "generic", "mypkg", "v2");
    expect(found?.version).toBe("V2");
    expect(await getVersionByNameAndVersion(env.DB, owner.id, "generic", "mypkg", "v3")).toBeNull();
  });
});

describe("incrementDownloadCounter (§5.8 — the bare x+1)", () => {
  it("accumulates per-row without read-modify-write races", async () => {
    const owner = await seedUser("alice");
    const { ver } = await seedPackageVersion(owner.id, "app", "1.0");
    await incrementDownloadCounter(env.DB, ver.id);
    await incrementDownloadCounter(env.DB, ver.id);
    const reread = await getVersionByNameAndVersion(env.DB, owner.id, "generic", "app", "1.0");
    expect(reread?.downloadCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Link / unlink + delete cascades
// ---------------------------------------------------------------------------

describe("link/unlink", () => {
  async function seedRepo(ownerId: number, namespace: string, slug: string): Promise<string> {
    const id = crypto.randomUUID();
    await db()
      .insert(repositories)
      .values({ id, storageKey: `r_${slug}`, ownerNamespace: namespace, slug, ownerId, visibility: "public", createdAt: NOW });
    return id;
  }

  it("sets and clears the pointer (repo_id TEXT — the audit scope_id adaptation)", async () => {
    const owner = await seedUser("alice");
    const repoId = await seedRepo(owner.id, "alice", "tools");
    const { pkg } = await seedPackageVersion(owner.id, "app", "1.0");
    await linkPackageToRepo(env.DB, pkg.id, repoId);
    expect((await db().select().from(packages).all())[0]?.repoId).toBe(repoId);
    await unlinkPackageFromRepo(env.DB, pkg.id);
    expect((await db().select().from(packages).all())[0]?.repoId).toBeNull();
  });

  it("unlinkPackagesOfRepo detaches every linked package of one repo (§5.6 arm)", async () => {
    const owner = await seedUser("alice");
    const repoId = await seedRepo(owner.id, "alice", "tools");
    const a = await seedPackageVersion(owner.id, "app", "1.0");
    const b = await seedPackageVersion(owner.id, "lib", "1.0");
    await linkPackageToRepo(env.DB, a.pkg.id, repoId);
    await linkPackageToRepo(env.DB, b.pkg.id, repoId);
    await unlinkPackagesOfRepo(env.DB, repoId);
    const rows = await db().select().from(packages).all();
    expect(rows.every((row) => row.repoId === null)).toBe(true);
  });
});

describe("delete cascades", () => {
  it("deletePackageVersionAndReferences removes version+files+properties, keeps the package", async () => {
    const owner = await seedUser("alice");
    const { ver } = await seedPackageVersion(owner.id, "app", "1.0");
    const blob = await seedBlob("x");
    await tryInsertFile(env.DB, { versionId: ver.id, blobId: blob.row.id, name: "f", now: NOW });
    await deletePackageVersionAndReferences(env.DB, ver.id);
    expect(await hasVersionFileReferences(env.DB, ver.id)).toBe(false);
    expect(await getVersionByNameAndVersion(env.DB, owner.id, "generic", "app", "1.0")).toBeNull();
    expect(await db().select().from(packages).all()).toHaveLength(1);
  });

  it("deletePackageAndReferences removes the package and everything beneath it", async () => {
    const owner = await seedUser("alice");
    const { pkg, ver } = await seedPackageVersion(owner.id, "app", "1.0");
    const blob = await seedBlob("x");
    await tryInsertFile(env.DB, { versionId: ver.id, blobId: blob.row.id, name: "f", now: NOW });
    await deletePackageAndReferences(env.DB, pkg.id);
    expect(await db().select().from(packages).all()).toHaveLength(0);
    expect(await hasVersionFileReferences(env.DB, ver.id)).toBe(false);
  });

  it("findUnreferencedPackages + findExpiredUnreferencedBlobs drive the sweep inputs", async () => {
    const owner = await seedUser("alice");
    const orphan = await seedPackageVersion(owner.id, "gone", "1.0");
    await deletePackageVersionAndReferences(env.DB, orphan.ver.id);
    const unreferenced = await findUnreferencedPackages(env.DB);
    expect(unreferenced.map((p) => p.lowerName)).toEqual(["gone"]);

    const old = new Date("2025-01-01T00:00:00Z");
    await getOrInsertBlob(env.DB, { size: 1, sha256: "c".repeat(64), now: old });
    await getOrInsertBlob(env.DB, { size: 1, sha256: "d".repeat(64), now: NOW }); // young
    const referenced = await seedBlob("referenced", old);
    const { ver } = await seedPackageVersion(owner.id, "keeper", "1.0", 0, old);
    await tryInsertFile(env.DB, { versionId: ver.id, blobId: referenced.row.id, name: "f", now: old });

    const expired = await findExpiredUnreferencedBlobs(env.DB, new Date("2026-01-01T00:00:00Z"));
    expect(expired.map((b) => b.hashSha256)).toEqual(["c".repeat(64)]); // the referenced old blob is protected
  });
});

// ---------------------------------------------------------------------------
// Quota (§3.4)
// ---------------------------------------------------------------------------

describe("quota config parsing", () => {
  it("defaults: -1 counts/total, 512 MiB generic, enabled (strict polarity)", () => {
    const config = packagesQuotaFromEnv({});
    expect(config.limitTotalOwnerCount).toBe(-1);
    expect(config.limitTotalOwnerSize).toBe(-1);
    expect(config.limitSizeGeneric).toBe(DEFAULT_LIMIT_SIZE_GENERIC);
    expect(config.packagesEnabled).toBe(true);
    expect(packagesQuotaFromEnv({ PACKAGES_ENABLED: "false" }).packagesEnabled).toBe(false);
    expect(packagesQuotaFromEnv({ PACKAGES_ENABLED: "true" }).packagesEnabled).toBe(true);
    expect(packagesQuotaFromEnv({ PACKAGES_ENABLED: "1" }).packagesEnabled).toBe(true); // only "false" disables
  });

  it("parses -1 and integers; invalid values fall back to the defaults", () => {
    expect(packagesQuotaFromEnv({ PACKAGES_LIMIT_SIZE_GENERIC: "1024" }).limitSizeGeneric).toBe(1024);
    expect(packagesQuotaFromEnv({ PACKAGES_LIMIT_SIZE_GENERIC: "-1" }).limitSizeGeneric).toBe(-1);
    expect(packagesQuotaFromEnv({ PACKAGES_LIMIT_SIZE_GENERIC: "banana" }).limitSizeGeneric).toBe(DEFAULT_LIMIT_SIZE_GENERIC);
    expect(packagesQuotaFromEnv({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" }).limitTotalOwnerCount).toBe(2);
  });
});

describe("quota checks (CheckCount/CheckSizeQuotaExceeded)", () => {
  it("count: admin bypass, -1 disabled, cap enforced over the owner's versions", async () => {
    const owner = await seedUser("alice");
    await seedPackageVersion(owner.id, "a", "1.0");
    await seedPackageVersion(owner.id, "b", "1.0");
    const config = { ...packagesQuotaFromEnv({}), limitTotalOwnerCount: 2 };
    await expect(checkCountQuotaExceeded(env.DB, false, owner.id, config)).resolves.toBeUndefined(); // 2 <= 2
    await expect(checkCountQuotaExceeded(env.DB, false, owner.id, { ...config, limitTotalOwnerCount: 1 })).rejects.toThrow();
    await expect(
      checkCountQuotaExceeded(env.DB, true, owner.id, { ...config, limitTotalOwnerCount: 0 }),
    ).resolves.toBeUndefined(); // admin bypass
    await expect(checkCountQuotaExceeded(env.DB, false, owner.id, packagesQuotaFromEnv({}))).resolves.toBeUndefined();
    expect(await countVersions(env.DB, owner.id)).toBe(2);
  });

  it("size: the generic per-file cap and the owner-total accumulation (two packages)", async () => {
    const owner = await seedUser("alice");
    const a = await seedPackageVersion(owner.id, "a", "1.0");
    const b = await seedPackageVersion(owner.id, "b", "1.0");
    const blobA = await seedBlob("12345");
    const blobB = await seedBlob("6789");
    await tryInsertFile(env.DB, { versionId: a.ver.id, blobId: blobA.row.id, name: "f", now: NOW });
    await tryInsertFile(env.DB, { versionId: b.ver.id, blobId: blobB.row.id, name: "f", now: NOW });
    expect(await calculateFileSize(env.DB, owner.id)).toBe(9); // 5 + 4

    const config = { ...packagesQuotaFromEnv({}), limitSizeGeneric: 4 };
    await expect(checkSizeQuotaExceeded(env.DB, false, owner.id, "generic", 5, config)).rejects.toThrow(); // single upload past the per-type cap
    await expect(checkSizeQuotaExceeded(env.DB, false, owner.id, "npm", 5, config)).resolves.toBeUndefined(); // per-type lattice is generic-only in v1
    const total = { ...packagesQuotaFromEnv({}), limitTotalOwnerSize: 10 };
    await expect(checkSizeQuotaExceeded(env.DB, false, owner.id, "generic", 2, total)).rejects.toThrow(); // 9 + 2 > 10
    await expect(checkSizeQuotaExceeded(env.DB, false, owner.id, "generic", 1, total)).resolves.toBeUndefined();
    await expect(checkSizeQuotaExceeded(env.DB, true, owner.id, "generic", 999, total)).resolves.toBeUndefined(); // admin bypass
  });
});

// ---------------------------------------------------------------------------
// determinePackageAccessMode (the §2.4/§4.1 ladder + org fold)
// ---------------------------------------------------------------------------

describe("determinePackageAccessMode", () => {
  const asOwner = (row: { id: number; type: string; visibility: "public" | "limited" | "private" }): PackageOwnerRow => ({
    id: row.id,
    type: row.type,
    visibility: row.visibility,
  });

  it("user owner: self → owner; admin → owner; public stranger → read; anonymous+public → read", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const admin = await seedUser("root", { isAdmin: true });
    const owner = asOwner(alice);
    expect(await determinePackageAccessMode(env.DB, owner, { id: alice.id, isAdmin: false })).toBe("owner");
    expect(await determinePackageAccessMode(env.DB, owner, { id: admin.id, isAdmin: true })).toBe("owner");
    expect(await determinePackageAccessMode(env.DB, owner, { id: bob.id, isAdmin: false })).toBe("read");
    expect(await determinePackageAccessMode(env.DB, owner, null)).toBe("read");
    void bob;
  });

  it("user owner: limited reads only authenticated; private only self/admin", async () => {
    const limited = await seedUser("lim", { visibility: "limited" });
    const priv = await seedUser("priv", { visibility: "private" });
    const bob = await seedUser("bob");
    expect(await determinePackageAccessMode(env.DB, asOwner(limited), { id: bob.id, isAdmin: false })).toBe("read");
    expect(await determinePackageAccessMode(env.DB, asOwner(limited), null)).toBe("none");
    expect(await determinePackageAccessMode(env.DB, asOwner(priv), { id: bob.id, isAdmin: false })).toBe("none");
    expect(await determinePackageAccessMode(env.DB, asOwner(priv), { id: priv.id, isAdmin: false })).toBe("owner");
    expect(await determinePackageAccessMode(env.DB, asOwner(priv), null)).toBe("none");
  });

  it("public-only blind arm: ownerVisibleToDoer=false → none", async () => {
    const limited = await seedUser("lim", { visibility: "limited" });
    const bob = await seedUser("bob");
    expect(
      await determinePackageAccessMode(env.DB, asOwner(limited), { id: bob.id, isAdmin: false }, { ownerVisibleToDoer: false }),
    ).toBe("none");
  });

  it("org fold (ratification 8 + the HasOrgOrUserVisible membership floor): owner-role member → owner; write/read team grants; plain member reads; private non-member → none", async () => {
    const orgOwner = await seedUser("acme-owner");
    const org = await seedUser("acme", { type: "org" });
    const writer = await seedUser("writer");
    const reader = await seedUser("reader");
    const plain = await seedUser("plainmember");
    const outsider = await seedUser("outsider");
    await db().insert(orgMembers).values({ orgId: org.id, userId: orgOwner.id, role: "owner", createdAt: NOW });
    // The PLAIN member: a membership row, no team row — upstream
    // HasOrgOrUserVisible (org.go:458-461) grants this doer read through the
    // membership arm at package.go:155-157.
    await db().insert(orgMembers).values({ orgId: org.id, userId: plain.id, role: "member", createdAt: NOW });

    const writeTeam = await db()
      .insert(teams)
      .values({ orgId: org.id, lowerName: "writers", name: "writers", authorize: "write" })
      .returning()
      .all();
    const writeTeamId = writeTeam[0]?.id;
    if (writeTeamId === undefined) throw new Error("team seed failed");
    await db().insert(teamMembers).values({ orgId: org.id, teamId: writeTeamId, userId: writer.id });
    const readTeam = await db()
      .insert(teams)
      .values({ orgId: org.id, lowerName: "readers", name: "readers", authorize: "read" })
      .returning()
      .all();
    const readTeamId = readTeam[0]?.id;
    if (readTeamId === undefined) throw new Error("team seed failed");
    await db().insert(teamMembers).values({ orgId: org.id, teamId: readTeamId, userId: reader.id });

    const orgRow = asOwner(org);
    expect(await determinePackageAccessMode(env.DB, orgRow, { id: orgOwner.id, isAdmin: false })).toBe("owner");
    expect(await determinePackageAccessMode(env.DB, orgRow, { id: writer.id, isAdmin: false })).toBe("write");
    expect(await determinePackageAccessMode(env.DB, orgRow, { id: reader.id, isAdmin: false })).toBe("read");
    expect(await determinePackageAccessMode(env.DB, orgRow, { id: plain.id, isAdmin: false })).toBe("read"); // public org: floor and visibility agree
    expect(await determinePackageAccessMode(env.DB, orgRow, { id: outsider.id, isAdmin: false })).toBe("read"); // public org visible
    expect(await determinePackageAccessMode(env.DB, orgRow, null)).toBe("read");

    // Private org: members keep their grants — the TEAM-granted reader AND
    // the PLAIN member (the closed HasOrgOrUserVisible floor, package.go:
    // 155-157) — while strangers are blind. The owner row is re-read AFTER
    // the visibility flip (the ladder reads the row's CURRENT visibility).
    await db().update(users).set({ visibility: "private" }).where(eq(users.id, org.id));
    const privateUser = await db().select().from(users).where(eq(users.id, org.id)).get();
    if (privateUser === undefined) throw new Error("org seed vanished");
    const privateRow = asOwner(privateUser);
    expect(await determinePackageAccessMode(env.DB, privateRow, { id: reader.id, isAdmin: false })).toBe("read");
    expect(await determinePackageAccessMode(env.DB, privateRow, { id: plain.id, isAdmin: false })).toBe("read"); // the membership floor
    expect(await determinePackageAccessMode(env.DB, privateRow, { id: outsider.id, isAdmin: false })).toBe("none");
    expect(await determinePackageAccessMode(env.DB, privateRow, null)).toBe("none");
  });
});

// The properties ref-type iota is exercised implicitly by the cascades above;
// pin the constants so the upstream order stays load-bearing.
describe("PropertyType", () => {
  it("keeps upstream's iota (0=version / 1=file / 2=package)", () => {
    expect(PropertyType.Version).toBe(0);
    expect(PropertyType.File).toBe(1);
    expect(PropertyType.Package).toBe(2);
  });
});
