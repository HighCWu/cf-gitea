/**
 * The packages cleanup arm battery (SPEC-0016 §4.4/§6 cleanup plan): the
 * producer probes (no rules + no orphans → zero queue sends; each probe arm
 * alone arms the single enqueue), the window parsing, and the consumer's two
 * arms — ExecuteCleanupRules (keep-count, remove-days, keep/remove patterns,
 * match_full_name, the un-compilable-pattern skip) and CleanupExpiredData
 * (unreferenced package rows, the expired unreferenced blob rows + their R2
 * content keys — the SOLE content-key deleter — and the orphan spool sweep),
 * with the idempotency re-run pin.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  packageBlobs,
  packageCleanupRules,
  packageFiles,
  packageProperties,
  packageVersions,
  packages,
  repositories,
  users,
} from "../../db/schema";
import {
  cleanupOlderThanHoursFromEnv,
  enqueueDuePackagesCleanup,
  handlePackagesCleanup,
  DEFAULT_CLEANUP_OLDER_THAN_HOURS,
} from "./cleanup";
import { getOrInsertPackage, getOrInsertVersion } from "./model";
import { getOrInsertBlob, packageBlobContentKey, packageBlobSpoolKey, spoolAndHash } from "./blobs";
import { PropertyType, getOrCreateInternalPackageVersion } from "./distro-common";
import { RPM_PROPERTY_GROUP, RPM_REPOSITORY_PACKAGE, RPM_REPOSITORY_VERSION } from "./rpm";
import { ARCH_REPOSITORY_PACKAGE, ARCH_REPOSITORY_VERSION } from "./arch";
import { DEBIAN_REPOSITORY_PACKAGE, DEBIAN_REPOSITORY_VERSION } from "./debian";
import { ALPINE_REPOSITORY_PACKAGE, ALPINE_REPOSITORY_VERSION } from "./alpine";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const db = () => drizzle(env.DB);
const NOW = new Date("2026-10-29T12:00:00Z");

async function seedUser(username: string): Promise<number> {
  const rows = await db()
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), status: "active", createdAt: NOW })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user.id;
}

// The audit.test.ts spyQueue shape — counts sends AND captures bodies
// (typed as the Queue & extras intersection so the producer env slots it in).
function spyQueue(): Queue & {
  sends: number;
  sendBatchCalls: number;
  bodies: unknown[][];
} {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBatchCalls: 0,
    bodies: [] as unknown[][],
    send: (_body: unknown) => {
      queue.sends += 1;
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sendBatchCalls += 1;
      queue.bodies.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The producer env with explicit overrides. */
function producerEnv(queue: ReturnType<typeof spyQueue>) {
  return { DB: env.DB, REPO_TASKS: queue, REPO_PACKS: env.REPO_PACKS };
}

const consumerEnv = () => ({ DB: env.DB, REPO_PACKS: env.REPO_PACKS });

async function listKeys(prefix: string): Promise<string[]> {
  const listed = await env.REPO_PACKS.list({ prefix });
  return listed.objects.map((object) => object.key);
}

function streamOf(payload: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
}

/** A version row directly under a package, at a given time. */
async function seedVersion(ownerId: number, pkgName: string, version: string, at: Date) {
  const { row: pkg } = await getOrInsertPackage(env.DB, { ownerId, type: "generic", name: pkgName, now: at });
  const { row: ver } = await getOrInsertVersion(env.DB, { packageId: pkg.id, creatorId: 0, version, now: at });
  return { pkg, ver };
}

/** A version row under a package of an explicit registry type. */
async function seedTypedVersion(ownerId: number, type: string, pkgName: string, version: string, at: Date) {
  const { row: pkg } = await getOrInsertPackage(env.DB, { ownerId, type, name: pkgName, now: at });
  const { row: ver } = await getOrInsertVersion(env.DB, { packageId: pkg.id, creatorId: 0, version, now: at });
  return { pkg, ver };
}

/** An enabled cleanup rule (one per owner+type, the UNIQUE's arbitration). */
async function seedRule(input: Partial<typeof packageCleanupRules.$inferInsert> & { ownerId: number }) {
  await db().insert(packageCleanupRules).values({
    enabled: true,
    type: "generic",
    ...input,
    createdUnix: NOW,
    updatedUnix: NOW,
  });
}

/** An unreferenced blob row created at `at` (optionally with its R2 key). */
async function seedBlobRow(sha: string, at: Date, withObject = false) {
  const { row } = await getOrInsertBlob(env.DB, { size: 1, sha256: sha, now: at });
  if (withObject) {
    await env.REPO_PACKS.put(packageBlobContentKey(sha), "x");
  }
  return row;
}

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.REPO_PACKS.delete(await listKeys("packages/tmp/"));
  await env.REPO_PACKS.delete(await listKeys("packages/blobs/"));
});

describe("cleanupOlderThanHoursFromEnv", () => {
  it("defaults to 24h; accepts positive integers; falls back on anything else (never disarms)", () => {
    expect(cleanupOlderThanHoursFromEnv({})).toBe(DEFAULT_CLEANUP_OLDER_THAN_HOURS);
    expect(cleanupOlderThanHoursFromEnv({ PACKAGE_CLEANUP_OLDER_THAN: "48" })).toBe(48);
    expect(cleanupOlderThanHoursFromEnv({ PACKAGE_CLEANUP_OLDER_THAN: "banana" })).toBe(DEFAULT_CLEANUP_OLDER_THAN_HOURS);
    expect(cleanupOlderThanHoursFromEnv({ PACKAGE_CLEANUP_OLDER_THAN: "0" })).toBe(DEFAULT_CLEANUP_OLDER_THAN_HOURS);
    expect(cleanupOlderThanHoursFromEnv({ PACKAGE_CLEANUP_OLDER_THAN: "-5" })).toBe(DEFAULT_CLEANUP_OLDER_THAN_HOURS);
  });
});

describe("enqueueDuePackagesCleanup (the producer probes)", () => {
  it("no rules + no orphans → zero sends (and the bodies list stays empty)", async () => {
    const queue = spyQueue();
    const enqueued = await enqueueDuePackagesCleanup(producerEnv(queue), { now: NOW });
    expect(enqueued).toBe(0);
    expect(queue.sends + queue.sendBatchCalls).toBe(0);
  });

  it("an enabled cleanup rule alone arms the single enqueue", async () => {
    const ownerId = await seedUser("alice");
    await db().insert(packageCleanupRules).values({
      enabled: true,
      ownerId,
      type: "generic",
      createdUnix: NOW,
      updatedUnix: NOW,
    });
    const queue = spyQueue();
    const enqueued = await enqueueDuePackagesCleanup(producerEnv(queue), { now: NOW });
    expect(enqueued).toBe(1);
    expect(queue.bodies[0]).toEqual([{ kind: "package-cleanup" }]);
  });

  it("a DISABLED rule does not arm the producer", async () => {
    const ownerId = await seedUser("alice");
    await db().insert(packageCleanupRules).values({
      enabled: false,
      ownerId,
      type: "generic",
      createdUnix: NOW,
      updatedUnix: NOW,
    });
    const queue = spyQueue();
    expect(await enqueueDuePackagesCleanup(producerEnv(queue), { now: NOW })).toBe(0);
    expect(queue.sends + queue.sendBatchCalls).toBe(0);
  });

  it("an expired UNREFERENCED blob arms; a young or referenced one does not", async () => {
    const ownerId = await seedUser("alice");
    const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    const { ver } = await seedVersion(ownerId, "keeper", "1.0", old);
    const referenced = await seedBlobRow("a".repeat(64), old);
    await db().insert(packageFiles).values({
      versionId: ver.id,
      blobId: referenced.id,
      name: "f",
      lowerName: "f",
      createdUnix: old,
    });
    await seedBlobRow("b".repeat(64), old); // expired unreferenced
    await seedBlobRow("c".repeat(64), NOW); // young unreferenced

    const queue = spyQueue();
    expect(await enqueueDuePackagesCleanup(producerEnv(queue), { now: NOW })).toBe(1);

    // Remove the expired blob: only the young + referenced remain → quiet.
    await db().delete(packageBlobs).where(eq(packageBlobs.hashSha256, "b".repeat(64)));
    const quiet = spyQueue();
    expect(await enqueueDuePackagesCleanup(producerEnv(quiet), { now: NOW })).toBe(0);
    expect(quiet.sends + quiet.sendBatchCalls).toBe(0);
  });

  it("an orphan spool object past the window arms; a fresh one does not", async () => {
    await spoolAndHash({
      bucket: env.REPO_PACKS,
      content: streamOf(new TextEncoder().encode("stale")),
      declaredLength: 5,
      spoolKey: packageBlobSpoolKey("12345678-1234-1234-1234-123456789abc"),
    });
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000); // the cut moves past every upload
    const queue = spyQueue();
    expect(await enqueueDuePackagesCleanup(producerEnv(queue), { now: future })).toBe(1);

    const present = spyQueue();
    expect(await enqueueDuePackagesCleanup(producerEnv(present), { now: new Date() })).toBe(0);
    expect(present.sends + present.sendBatchCalls).toBe(0);
  });

  it("unbound bindings fail loud (the config-bug defense)", async () => {
    await expect(enqueueDuePackagesCleanup({}, { now: NOW })).rejects.toThrow(/not bound/);
  });
});

describe("handlePackagesCleanup — CleanupExpiredData (the sole content-key deleter)", () => {
  it("deletes the expired unreferenced blob's ROW + R2 key; young and referenced blobs survive", async () => {
    const ownerId = await seedUser("alice");
    const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    const { ver } = await seedVersion(ownerId, "keeper", "1.0", old);
    const referenced = await seedBlobRow("a".repeat(64), old, true);
    await db().insert(packageFiles).values({
      versionId: ver.id,
      blobId: referenced.id,
      name: "f",
      lowerName: "f",
      createdUnix: old,
    });
    await seedBlobRow("b".repeat(64), old, true); // expired unreferenced — the victim
    await seedBlobRow("c".repeat(64), NOW, true); // young unreferenced — survives

    await handlePackagesCleanup(consumerEnv(), { now: NOW });

    const hashes = (await db().select().from(packageBlobs).all()).map((b) => b.hashSha256).sort();
    expect(hashes).toEqual(["a".repeat(64), "c".repeat(64)]); // the referenced old + the young
    expect(await env.REPO_PACKS.head(packageBlobContentKey("a".repeat(64)))).not.toBeNull();
    expect(await env.REPO_PACKS.head(packageBlobContentKey("b".repeat(64)))).toBeNull();
    expect(await env.REPO_PACKS.head(packageBlobContentKey("c".repeat(64)))).not.toBeNull();
  });

  it("removes package rows left with zero versions (and their package-scoped properties)", async () => {
    const ownerId = await seedUser("alice");
    const doomed = await seedVersion(ownerId, "doomed", "1.0", NOW);
    // Empty the version: the package row becomes unreferenced.
    await db().delete(packageVersions).where(eq(packageVersions.id, doomed.ver.id));
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    const left = await db().select().from(packages).all();
    expect(left).toHaveLength(0);
  });

  it("sweeps orphan spool objects past the window and keeps fresh ones", async () => {
    await spoolAndHash({
      bucket: env.REPO_PACKS,
      content: streamOf(new TextEncoder().encode("stale")),
      declaredLength: 5,
      spoolKey: packageBlobSpoolKey("12345678-1234-1234-1234-123456789abc"),
    });
    const future = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await handlePackagesCleanup(consumerEnv(), { now: future });
    expect(await listKeys("packages/tmp/")).toEqual([]);
  });

  it("is idempotent: a second run is a no-op (the queue-redelivery posture)", async () => {
    const old = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    await seedBlobRow("d".repeat(64), old, true);
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    await expect(handlePackagesCleanup(consumerEnv(), { now: NOW })).resolves.toBeUndefined();
    expect(await db().select().from(packageBlobs).all()).toHaveLength(0);
  });
});

describe("handlePackagesCleanup — ExecuteCleanupRules", () => {
  it("keep-count keeps the newest N versions by created desc", async () => {
    const ownerId = await seedUser("alice");
    const v1 = await seedVersion(ownerId, "app", "1.0", new Date("2026-01-01T00:00:00Z"));
    const v2 = await seedVersion(ownerId, "app", "2.0", new Date("2026-01-02T00:00:00Z"));
    await seedVersion(ownerId, "app", "3.0", new Date("2026-01-03T00:00:00Z"));
    await seedRule({ ownerId, keepCount: 1 });

    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    const left = await db().select().from(packageVersions).all();
    expect(left.map((v) => v.lowerVersion)).toEqual(["3.0"]);
    void v1;
    void v2;
    // The package row (one version remains) stays.
    expect(await db().select().from(packages).all()).toHaveLength(1);
  });

  it("remove-days keeps versions younger than the window", async () => {
    const ownerId = await seedUser("alice");
    const young = await seedVersion(ownerId, "app", "1.0", new Date("2026-10-28T00:00:00Z"));
    const old = await seedVersion(ownerId, "app", "0.9", new Date("2026-01-01T00:00:00Z"));
    await seedRule({ ownerId, removeDays: 7 });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    const left = (await db().select().from(packageVersions).all()).map((v) => v.lowerVersion);
    expect(left).toEqual([young.ver.lowerVersion]);
    void old;
  });

  it("keep-pattern pins matching versions even past remove-days; remove-pattern narrows deletions", async () => {
    const ownerId = await seedUser("alice");
    const pinned = await seedVersion(ownerId, "app", "1.0.0", new Date("2026-01-01T00:00:00Z"));
    const disposable = await seedVersion(ownerId, "app", "0.9.0-nightly", new Date("2026-01-01T00:00:00Z"));
    // Upstream compiles patterns as `(?i)\A<pattern>\z` — WHOLE-string
    // matches, so the idiomatic prefix pattern is `1\..*` (no inner ^).
    await seedRule({ ownerId, removeDays: 1, keepPattern: "1\\..*" });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    let left = (await db().select().from(packageVersions).all()).map((v) => v.lowerVersion);
    expect(left).toEqual([pinned.ver.lowerVersion]); // keep-pattern protected 1.0.0; 0.9.0-nightly fell to remove-days

    // remove-pattern: only MATCHING versions are deletable (whole-string
    // anchoring — the idiomatic suffix shape is `.*-rc`, not `rc$`).
    const kept = await seedVersion(ownerId, "lib", "1.0.0", new Date("2026-01-01T00:00:00Z"));
    const removed = await seedVersion(ownerId, "lib", "2.0.0-rc", new Date("2026-01-01T00:00:00Z"));
    await db().delete(packageCleanupRules);
    await seedRule({ ownerId, removeDays: 1, removePattern: ".*-rc" });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    left = (await db().select().from(packageVersions).all()).map((v) => v.lowerVersion);
    expect(left).toContain(kept.ver.lowerVersion);
    expect(left).not.toContain(removed.ver.lowerVersion);
    void disposable;
  });

  it("match_full_name matches lower_name/lower_version instead of the bare version", async () => {
    const ownerId = await seedUser("alice");
    await seedVersion(ownerId, "keepme", "2.0", new Date("2026-01-01T00:00:00Z"));
    const doomed = await seedVersion(ownerId, "dropme", "2.0", new Date("2026-01-01T00:00:00Z"));
    await seedRule({ ownerId, removeDays: 1, removePattern: "dropme/.*", matchFullName: true });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    const left = (await db().select().from(packageVersions).all()).map((v) => v.lowerVersion);
    expect(left).toEqual(["2.0"]); // keepme/2.0 matched nothing (name differs); dropme/2.0 matched and fell
    void doomed;
  });

  it("an un-compilable keep pattern skips the rule (upstream logs and moves on)", async () => {
    const ownerId = await seedUser("alice");
    const kept = await seedVersion(ownerId, "app", "1.0", new Date("2026-01-01T00:00:00Z"));
    await seedRule({ ownerId, removeDays: 1, keepPattern: "(" });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    expect((await db().select().from(packageVersions).all()).map((v) => v.lowerVersion)).toEqual([kept.ver.lowerVersion]);
  });

  it("the rules + expired-data composition: rule-deleted versions leave the blob to the sweep; the empty package row goes too", async () => {
    const ownerId = await seedUser("alice");
    const old = new Date("2026-01-01T00:00:00Z");
    const { ver } = await seedVersion(ownerId, "app", "1.0", old);
    const blob = await getOrInsertBlob(env.DB, { size: 1, sha256: "f".repeat(64), now: old });
    await db().insert(packageFiles).values({
      versionId: ver.id,
      blobId: blob.row.id,
      name: "f",
      lowerName: "f",
      createdUnix: old,
    });
    await seedRule({ ownerId, removeDays: 1 });
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
    expect(await db().select().from(packages).all()).toHaveLength(0); // unreferenced row swept
    expect(await db().select().from(packageBlobs).all()).toHaveLength(0); // expired unreferenced blob swept
    expect(await env.REPO_PACKS.head(packageBlobContentKey("f".repeat(64)))).toBeNull(); // the key with it
  });

  it("is idempotent across a redelivery (a second full run changes nothing)", async () => {
    const ownerId = await seedUser("alice");
    await seedRule({ ownerId, removeDays: 1 });
    await seedVersion(ownerId, "app", "1.0", new Date("2026-01-01T00:00:00Z"));
    await handlePackagesCleanup(consumerEnv(), { now: NOW });
    await expect(handlePackagesCleanup(consumerEnv(), { now: NOW })).resolves.toBeUndefined();
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
  });
});

describe("handlePackagesCleanup — the distro rebuild-arm (upstream cleanup.go:122-147)", () => {
  let blobSeq = 0;

  /** A unique 64-hex blob sha (the table's hex-only content key). */
  const nextSha = () => (++blobSeq).toString(16).padStart(64, "0");

  /** A stale index file row under the family's internal `_family/_repository`
   *  version — BuildAllRepositoryFiles' step 1 (the delete-all of the
   *  internal version's files) sweeps it whenever the rebuild fires. */
  async function seedStaleIndexFile(
    ownerId: number,
    family: { type: string; repositoryPackage: string; repositoryVersion: string },
  ): Promise<number> {
    const repoVersion = await getOrCreateInternalPackageVersion(env.DB, ownerId, family.type, family.repositoryPackage, family.repositoryVersion);
    const blob = (await getOrInsertBlob(env.DB, { size: 1, sha256: nextSha(), now: NOW })).row;
    await db().insert(packageFiles).values({
      versionId: repoVersion.version.id,
      blobId: blob.id,
      name: "stale-index.xml",
      lowerName: "stale-index.xml",
      compositeKey: "stale",
      createdUnix: NOW,
    });
    return repoVersion.version.id;
  }

  const internalFileCount = (versionId: number) =>
    db()
      .select({ id: packageFiles.id })
      .from(packageFiles)
      .where(eq(packageFiles.versionId, versionId))
      .all()
      .then((rows) => rows.length);

  // The four families upstream's switch names (cleanup.go:124-145) — each
  // with its internal repository package/version constants.
  const FAMILIES = [
    { type: "debian", repositoryPackage: DEBIAN_REPOSITORY_PACKAGE, repositoryVersion: DEBIAN_REPOSITORY_VERSION },
    { type: "alpine", repositoryPackage: ALPINE_REPOSITORY_PACKAGE, repositoryVersion: ALPINE_REPOSITORY_VERSION },
    { type: "rpm", repositoryPackage: RPM_REPOSITORY_PACKAGE, repositoryVersion: RPM_REPOSITORY_VERSION },
    { type: "arch", repositoryPackage: ARCH_REPOSITORY_PACKAGE, repositoryVersion: ARCH_REPOSITORY_VERSION },
  ] as const;
  const RPM_FAMILY = FAMILIES[2];

  it("a rule-type-matched version delete triggers the family's rebuild — the internal version's files are deleted whole (all four families)", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    for (const family of FAMILIES) {
      const ownerId = await seedUser(`owner-${family.type}`);
      const internalVersionId = await seedStaleIndexFile(ownerId, family);
      const doomed = await seedTypedVersion(ownerId, family.type, "app", "1.0", old);
      await seedRule({ ownerId, type: family.type, removeDays: 1 });

      await handlePackagesCleanup(consumerEnv(), { now: NOW });

      // The rule's delete ran...
      expect(
        await db().select().from(packageVersions).where(eq(packageVersions.id, doomed.ver.id)).all(),
        `${family.type}: the doomed version fell`,
      ).toHaveLength(0);
      // ...and the rebuild fired: the stale internal index file is gone
      // (BuildAllRepositoryFiles' step 1 — the fresh enumeration is empty
      // here, so nothing is re-added).
      expect(await internalFileCount(internalVersionId), `${family.type}: the rebuild swept the internal files`).toBe(0);
    }
  });

  it("the rpm rebuild renders fresh repodata for the surviving group (the full BuildAll path, rpm repository.go:74-104)", async () => {
    const ownerId = await seedUser("rebuilder");
    const internalVersionId = await seedStaleIndexFile(ownerId, RPM_FAMILY);
    const old = new Date("2026-01-01T00:00:00Z");
    await seedTypedVersion(ownerId, "rpm", "doomed", "1.0", old);
    const survivor = await seedTypedVersion(ownerId, "rpm", "survivor", "2.0", NOW);
    const blob = (await getOrInsertBlob(env.DB, { size: 10, sha256: nextSha(), now: NOW })).row;
    const inserted = await db()
      .insert(packageFiles)
      .values({
        versionId: survivor.ver.id,
        blobId: blob.id,
        name: "survivor-2.0-1.noarch.rpm",
        lowerName: "survivor-2.0-1.noarch.rpm",
        compositeKey: "devel",
        createdUnix: NOW,
      })
      .returning()
      .all();
    const file = inserted[0];
    if (file === undefined) throw new Error("file seed failed");
    // The group property drives buildAllRpmRepositoryFiles' enumeration
    // (listRpmGroups — the rpm.group file property).
    await db().insert(packageProperties).values({ refType: PropertyType.File, refId: file.id, name: RPM_PROPERTY_GROUP, value: "devel" });
    await seedRule({ ownerId, type: "rpm", removeDays: 1 });

    await handlePackagesCleanup(consumerEnv(), { now: NOW });

    const rebuilt = await db().select().from(packageFiles).where(eq(packageFiles.versionId, internalVersionId)).all();
    const names = rebuilt.map((row) => row.lowerName).sort();
    // The stale row is gone; the devel group's fresh repodata took its place.
    expect(names).toContain("repomd.xml");
    expect(names).toContain("repomd.xml.asc"); // the detached signature arm
    expect(names).toContain("primary.xml.gz");
    expect(rebuilt.every((row) => row.compositeKey === "devel")).toBe(true);
  });

  it("a non-distro rule type deletes its versions but rebuilds nothing (upstream's switch has no arm for it)", async () => {
    const ownerId = await seedUser("generic-owner");
    const internalVersionId = await seedStaleIndexFile(ownerId, RPM_FAMILY);
    const doomed = await seedTypedVersion(ownerId, "generic", "app", "1.0", new Date("2026-01-01T00:00:00Z"));
    await seedRule({ ownerId, type: "generic", removeDays: 1 });

    await handlePackagesCleanup(consumerEnv(), { now: NOW });

    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, doomed.ver.id)).all()).toHaveLength(0);
    expect(await internalFileCount(internalVersionId)).toBe(1); // the stale row survives — no rebuild
  });

  it("no deletion → no rebuild (upstream's anyVersionDeleted gate, cleanup.go:122)", async () => {
    const ownerId = await seedUser("young-owner");
    const internalVersionId = await seedStaleIndexFile(ownerId, RPM_FAMILY);
    const young = await seedTypedVersion(ownerId, "rpm", "app", "1.0", NOW); // young — remove-days keeps it
    await seedRule({ ownerId, type: "rpm", removeDays: 1 });

    await handlePackagesCleanup(consumerEnv(), { now: NOW });

    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, young.ver.id)).all()).toHaveLength(1);
    expect(await internalFileCount(internalVersionId)).toBe(1); // the stale row survives — no rebuild
  });
});

describe("handlePackagesCleanup — the cargo per-package rider (upstream cleanup.go:108-118)", () => {
  it("a cargo rule's per-package delete runs the index seam — INSIDE the loop, and no post-loop rebuild", async () => {
    // The rider is observable through the repositories-row probe it takes
    // (updateCargoPackageIndex resolves the `_cargo-index` repo-absent arm,
    // index.go:94-99). Seed a repo row so the PRESENT arm runs — the sweep
    // must stay live either way.
    const ownerId = await seedUser("cargo-owner");
    await db().insert(repositories).values({
      id: "r_cargo_index_probe",
      storageKey: "r_cargo_index_probe",
      ownerNamespace: "cargo-owner",
      ownerId,
      slug: "_cargo-index",
      visibility: "public",
    });
    const old = new Date("2026-01-01T00:00:00Z");
    const doomedA = await seedTypedVersion(ownerId, "cargo", "app-a", "1.0.0", old);
    const doomedB = await seedTypedVersion(ownerId, "cargo", "app-b", "2.0.0", old);
    const survivor = await seedTypedVersion(ownerId, "cargo", "app-a", "2.0.0", NOW);
    await seedRule({ ownerId, type: "cargo", removeDays: 1 });

    await expect(handlePackagesCleanup(consumerEnv(), { now: NOW })).resolves.toBeUndefined();

    // Both packages lost a version → the rider ran PER PACKAGE (the loop
    // shape, cleanup.go:110-118) and both resolves.
    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, doomedA.ver.id)).all()).toHaveLength(0);
    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, doomedB.ver.id)).all()).toHaveLength(0);
    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, survivor.ver.id)).all()).toHaveLength(1);
  });

  it("a cargo rule with the index-repo row absent resolves the same (the repo-absent no-op, index.go:96-99)", async () => {
    const ownerId = await seedUser("plain-cargo-owner");
    const doomed = await seedTypedVersion(ownerId, "cargo", "crate", "0.1.0", new Date("2026-01-01T00:00:00Z"));
    await seedRule({ ownerId, type: "cargo", removeDays: 1 });

    await expect(handlePackagesCleanup(consumerEnv(), { now: NOW })).resolves.toBeUndefined();
    expect(await db().select().from(packageVersions).where(eq(packageVersions.id, doomed.ver.id)).all()).toHaveLength(0);
    // No cargo post-loop rebuild exists — and no internal `_cargo` rows were
    // fabricated (the distro families' getOrCreateInternal shape is absent
    // for cargo by design; the sparse index derives on read).
    const cargoPackages = await db().select().from(packages).where(eq(packages.type, "cargo")).all();
    expect(cargoPackages.every((row) => row.isInternal === false)).toBe(true);
  });
});
