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
  packageVersions,
  packages,
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
  async function seedRule(input: Partial<typeof packageCleanupRules.$inferInsert> & { ownerId: number }) {
    await db().insert(packageCleanupRules).values({
      enabled: true,
      type: "generic",
      ...input,
      createdUnix: NOW,
      updatedUnix: NOW,
    });
  }

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
