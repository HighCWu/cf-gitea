/**
 * The repo-migrate-status module tests (the repo-migrate.test.ts fixture
 * discipline): the module is UNMOUNTED — the three route arms are
 * index-owned (the module header's HANDOFF carries the parse claims and
 * registrations) — so the tests drive the record resolution, the status
 * derivation, the payload gate, the exact response bodies, and the
 * retry/cancel writes DIRECTLY, on real D1 (workerd,
 * @cloudflare/vitest-plugin).
 *
 * The retry leg's enqueue is CAPTURED with the recording-queue pattern (the
 * repo-migrate.test.ts / migrate.test.ts posture — the live dev-queue
 * consumer's real-network sync must never see these messages). No egress
 * gate or KEK is needed: these arms read rows and write schedule columns,
 * never source URLs or credentials.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repoImports, repoMirrors, repositories } from "../../db/schema";
import type { MigrateRetryEnv, MigrationRecord } from "./repo-migrate-status";
import {
  MIGRATE_CANCEL_SENTINEL,
  MIGRATE_FAILED_GENERIC,
  cancelMigration,
  deriveMigrationStatus,
  migrateStatusNotFoundResponse,
  migrateStatusPayload,
  migrateStatusResponse,
  migrateRetryOkResponse,
  resolveMigrationRecord,
  retryMigration,
} from "./repo-migrate-status";

// --- fixtures ----------------------------------------------------------------

/** Fixed wall clock for every write arm — the asserted schedule columns are
 *  derived from this, never Date.now(). */
const NOW = new Date("2026-01-15T12:00:00Z");
const NOW_UNIX = Math.floor(NOW.getTime() / 1000);

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the retry's enqueue is CAPTURED here (the
 *  module-header pattern). */
function recordingQueue(): RecordingQueue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    send: (body: unknown) => {
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function retryEnv(queue: RecordingQueue): MigrateRetryEnv {
  return { ...env, MIRROR_SYNC_QUEUE: queue };
}

let repoSeq = 0;
let importSeq = 0;

/** A born repositories row — direct INSERT (the loader-level unit posture;
 *  RepoService.create would drag the REGISTRY binding into what are pure
 *  row-state tests). */
async function seedRepo(
  overrides: Partial<typeof repositories.$inferInsert> = {},
): Promise<string> {
  repoSeq += 1;
  const id = `r_${String(repoSeq).padStart(4, "0")}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `k_${id}`,
    ownerNamespace: "miller",
    ownerId: doerId,
    slug: `repo-${repoSeq}`,
    visibility: "public",
    status: "ready",
    isEmpty: true,
    updatedAt: NOW,
    ...overrides,
  });
  return id;
}

/** A 1:1 mirror row (defaults: pending initial population, no error). */
async function seedMirror(
  repoId: string,
  overrides: Partial<Omit<typeof repoMirrors.$inferInsert, "repoId">> = {},
): Promise<typeof repoMirrors.$inferSelect> {
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId,
    remoteAddress: "https://src.example.com/org/repo.git",
    intervalSeconds: 600,
    syncState: "idle",
    nextSyncAt: NOW_UNIX - 3600, // due — the post-POST initial population
    lastSyncAt: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  });
  const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (row === undefined) throw new Error("mirror row vanished after seed");
  return row;
}

/** A repo_imports row (defaults: staged, no error). */
async function seedImport(
  repoId: string,
  overrides: Partial<Omit<typeof repoImports.$inferInsert, "repoId">> = {},
): Promise<typeof repoImports.$inferSelect> {
  importSeq += 1;
  await drizzle(env.DB).insert(repoImports).values({
    repoId,
    importTokenSha256: `sha-${String(importSeq).padStart(4, "0")}`,
    state: "staged",
    chunkCap: 512 * 1024 * 1024,
    totalBytes: 0,
    staged: "{}",
    error: null,
    heartbeatAt: NOW,
    ...overrides,
  });
  const rows = await drizzle(env.DB).select().from(repoImports).where(eq(repoImports.repoId, repoId)).all();
  const row = rows.find((candidate) => candidate.importTokenSha256 === `sha-${String(importSeq).padStart(4, "0")}`);
  if (row === undefined) throw new Error("import row vanished after seed");
  return row;
}

const mirrorRowOf = async (repoId: string) =>
  drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
const importRowsOf = async (repoId: string) =>
  drizzle(env.DB).select().from(repoImports).where(eq(repoImports.repoId, repoId)).all();
const repoRowOf = async (repoId: string) =>
  drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();

/** Guard helper (the no-non-null-assertion convention). */
function expectRecord(record: MigrationRecord | null): MigrationRecord {
  if (record === null) throw new Error("record was null where one was expected");
  return record;
}

// --- harness -----------------------------------------------------------------

let doerId = 0;

beforeAll(async () => {
  // The full generated migration ledger (the repo-migrate.test.ts
  // bootstrap; no repo_settings DDL — these arms read/write no settings
  // subset).
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_mirrors", "repo_imports", "repositories", "personal_access_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  const doer = await seedVerifiedUser({ username: "Miller" });
  doerId = doer.id;
  repoSeq = 0;
  importSeq = 0;
});

// --- record resolution (the GetMigratingTask port) ---------------------------

describe("resolveMigrationRecord", () => {
  it("returns null when the repo carries no migration record", async () => {
    const repoId = await seedRepo();
    expect(await resolveMigrationRecord(env.DB, repoId)).toBeNull();
  });

  it("resolves a mirror-only repo to the mirror record", async () => {
    const repoId = await seedRepo();
    const seeded = await seedMirror(repoId);
    const record = expectRecord(await resolveMigrationRecord(env.DB, repoId));
    expect(record.kind).toBe("mirror");
    if (record.kind === "mirror") expect(record.row.id).toBe(seeded.id);
  });

  it("prefers an ACTIVE import row over the mirror row (the migration in flight)", async () => {
    const repoId = await seedRepo({ status: "migrating" });
    await seedMirror(repoId);
    const staged = await seedImport(repoId, { state: "staged" });
    const record = expectRecord(await resolveMigrationRecord(env.DB, repoId));
    expect(record.kind).toBe("import");
    if (record.kind === "import") expect(record.row.id).toBe(staged.id);
  });

  it("prefers an active import in later states too (indexing)", async () => {
    const repoId = await seedRepo({ status: "migrating" });
    await seedMirror(repoId);
    const indexing = await seedImport(repoId, { state: "indexing" });
    const record = expectRecord(await resolveMigrationRecord(env.DB, repoId));
    if (record.kind === "import") expect(record.row.id).toBe(indexing.id);
    else throw new Error("expected the import record");
  });

  it("answers the LATEST terminal import over the mirror row (a failed verdict is not masked)", async () => {
    const repoId = await seedRepo();
    await seedMirror(repoId);
    await seedImport(repoId, { state: "done" }); // older terminal row
    const failed = await seedImport(repoId, { state: "failed", error: "manifest invalid" });
    const record = expectRecord(await resolveMigrationRecord(env.DB, repoId));
    expect(record.kind).toBe("import");
    if (record.kind === "import") expect(record.row.id).toBe(failed.id);
  });
});

// --- status derivation (the wire ints) ----------------------------------------

/** Derive from a REAL seeded import row (the resolution + derivation pair —
 *  the pure-row casts stay out per the no-forced-cast rule). */
async function importStatusOf(state: "staged" | "indexing" | "finalizing" | "done" | "failed", error?: string) {
  const repoId = await seedRepo({ status: state === "done" ? "ready" : "migrating" });
  await seedImport(repoId, { state, ...(error !== undefined ? { error } : {}) });
  return deriveMigrationStatus(expectRecord(await resolveMigrationRecord(env.DB, repoId)));
}

/** Derive from a REAL seeded mirror row. */
async function mirrorStatusOf(mirror: Partial<Omit<typeof repoMirrors.$inferInsert, "repoId">>) {
  const repoId = await seedRepo();
  await seedMirror(repoId, mirror);
  return deriveMigrationStatus(expectRecord(await resolveMigrationRecord(env.DB, repoId)));
}

describe("deriveMigrationStatus", () => {
  it("maps the import ladder: staged 0, indexing 1, finalizing 1, done 4, failed 3+message", async () => {
    expect(await importStatusOf("staged")).toEqual({ status: 0, failedMessage: null });
    expect(await importStatusOf("indexing")).toEqual({ status: 1, failedMessage: null });
    expect(await importStatusOf("finalizing")).toEqual({ status: 1, failedMessage: null });
    expect(await importStatusOf("done")).toEqual({ status: 4, failedMessage: null });
    expect(await importStatusOf("failed", "manifest invalid")).toEqual({
      status: 3,
      failedMessage: "manifest invalid",
    });
  });

  it("maps a finished population to 4 forever — later sync failures are the mirror channel's state", async () => {
    expect(await mirrorStatusOf({ lastSyncAt: NOW_UNIX, lastError: "fetch failed", syncState: "idle" })).toEqual({
      status: 4,
      failedMessage: null,
    });
  });

  it("maps a pending population by syncState: idle/queued 0, syncing 1 — a transient failure is NOT terminal", async () => {
    expect(await mirrorStatusOf({ lastSyncAt: null, lastError: "fetch failed", syncState: "idle" })).toEqual({
      status: 0,
      failedMessage: null,
    });
    expect(await mirrorStatusOf({ lastSyncAt: null, lastError: null, syncState: "queued" })).toEqual({
      status: 0,
      failedMessage: null,
    });
    expect(await mirrorStatusOf({ lastSyncAt: null, lastError: null, syncState: "syncing" })).toEqual({
      status: 1,
      failedMessage: null,
    });
  });

  it("maps the cancel sentinel to the terminal 3 (divergence 1)", async () => {
    expect(await mirrorStatusOf({ lastSyncAt: null, lastError: MIGRATE_CANCEL_SENTINEL, syncState: "idle" })).toEqual({
      status: 3,
      failedMessage: MIGRATE_CANCEL_SENTINEL,
    });
  });
});

// --- the message gate + response bodies --------------------------------------

describe("migrateStatusPayload", () => {
  it("carries an empty message for every non-failed state, gate notwithstanding", () => {
    expect(migrateStatusPayload({ status: 0, failedMessage: null }, false).message).toBe("");
    expect(migrateStatusPayload({ status: 4, failedMessage: null }, true).message).toBe("");
  });

  it("echoes the raw failure text to admins (canSeeFailure)", () => {
    expect(migrateStatusPayload({ status: 3, failedMessage: "manifest invalid" }, true)).toEqual({
      status: 3,
      message: "manifest invalid",
    });
  });

  it("substitutes upstream's generic text for everyone else", () => {
    expect(migrateStatusPayload({ status: 3, failedMessage: "manifest invalid" }, false)).toEqual({
      status: 3,
      message: MIGRATE_FAILED_GENERIC,
    });
  });
});

describe("response builders", () => {
  it("renders the 200 body in Go's sorted-map key order with ctx.JSON's headers", () => {
    const response = migrateStatusResponse({ status: 0, message: "" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    return response.text().then((body) => expect(body).toBe('{"message":"","status":0}'));
  });

  it("renders the exact no-record 404 body (migrate.go:274-278)", () => {
    const response = migrateStatusNotFoundResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    return response
      .text()
      .then((body) => expect(body).toBe('{"err":"task does not exist or you do not have access to this task"}'));
  });

  it("renders the JSONOK body for the retry success arms (context.go:243-245)", () => {
    const response = migrateRetryOkResponse();
    expect(response.status).toBe(200);
    return response.text().then((body) => expect(body).toBe('{"ok":true}'));
  });
});

// --- retryMigration (task.RetryMigrateTask's port) ----------------------------

describe("retryMigration", () => {
  it("reports missing when no record exists (the handler maps upstream's ServerError)", async () => {
    const repoId = await seedRepo();
    const queue = recordingQueue();
    const outcome = await retryMigration(env.DB, retryEnv(queue), { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("missing");
    expect(queue.sent).toEqual([]);
  });

  it("no-ops on an ACTIVE import (upstream's queued/running arm) without sending", async () => {
    const repoId = await seedRepo({ status: "migrating" });
    const staged = await seedImport(repoId, { state: "staged" });
    const queue = recordingQueue();
    const outcome = await retryMigration(env.DB, retryEnv(queue), { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("noop");
    expect(queue.sent).toEqual([]);
    const rows = await importRowsOf(repoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe(staged.state);
  });

  it("no-ops on terminal import rows — the chunks are purged and a browser has no uploader (divergence 4)", async () => {
    for (const state of ["done", "failed"] as const) {
      const repoId = await seedRepo();
      await seedImport(repoId, { state, error: state === "failed" ? "boom" : null });
      const queue = recordingQueue();
      const outcome = await retryMigration(
        env.DB,
        retryEnv(queue),
        { id: repoId, ownerNamespace: "miller", slug: "repo-x" },
        NOW,
      );
      expect(outcome).toBe("noop");
      expect(queue.sent).toEqual([]);
    }
  });

  it("no-ops on a finished population without writing or sending", async () => {
    const repoId = await seedRepo();
    const syncedAt = NOW_UNIX - 60;
    await seedMirror(repoId, { lastSyncAt: syncedAt, nextSyncAt: syncedAt + 600, syncState: "idle" });
    const queue = recordingQueue();
    const outcome = await retryMigration(env.DB, retryEnv(queue), { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("noop");
    expect(queue.sent).toEqual([]);
    const row = await mirrorRowOf(repoId);
    expect(row?.lastSyncAt).toBe(syncedAt);
    expect(row?.nextSyncAt).toBe(syncedAt + 600);
  });

  it("requeues a pending population: re-due now, error cleared, one best-effort enqueue", async () => {
    const repoId = await seedRepo();
    await seedMirror(repoId, { lastError: "fetch failed", nextSyncAt: NOW_UNIX - 3600, syncState: "idle" });
    const queue = recordingQueue();
    const outcome = await retryMigration(env.DB, retryEnv(queue), { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("requeued");
    const row = await mirrorRowOf(repoId);
    expect(row?.nextSyncAt).toBe(NOW_UNIX);
    expect(row?.lastError).toBeNull();
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId }]);
  });

  it("requeues the canceled sentinel back to live (the cancel→retry loop, upstream's shape)", async () => {
    const repoId = await seedRepo();
    await seedMirror(repoId, { lastError: MIGRATE_CANCEL_SENTINEL, nextSyncAt: 0, syncState: "idle" });
    const queue = recordingQueue();
    const outcome = await retryMigration(env.DB, retryEnv(queue), { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("requeued");
    const row = await mirrorRowOf(repoId);
    expect(row?.lastError).toBeNull();
    expect(row?.nextSyncAt).toBe(NOW_UNIX);
  });

  it("requeues without a queue binding (the self-heal posture — the row is due at now)", async () => {
    const repoId = await seedRepo();
    await seedMirror(repoId, { lastError: "fetch failed", nextSyncAt: NOW_UNIX - 3600 });
    // The bare-env leg: the generated Env types the binding required, so the
    // undefined write needs the tests-only cast (the push-sync.test.ts:712
    // precedent — the module runtime-guards the absent queue and self-heals
    // at the next cron tick).
    const bare = { ...env, MIRROR_SYNC_QUEUE: undefined } as unknown as MigrateRetryEnv;
    const outcome = await retryMigration(env.DB, bare, { id: repoId, ownerNamespace: "miller", slug: "repo-1" }, NOW);
    expect(outcome).toBe("requeued");
    const row = await mirrorRowOf(repoId);
    expect(row?.nextSyncAt).toBe(NOW_UNIX);
    expect(row?.lastError).toBeNull();
  });
});

// --- cancelMigration (repo.MigrateCancelPost's port) --------------------------

describe("cancelMigration", () => {
  it("no-ops with no record and with terminal records (upstream redirects either way)", async () => {
    const bare = await seedRepo();
    await cancelMigration(env.DB, { id: bare }, NOW);
    expect(await resolveMigrationRecord(env.DB, bare)).toBeNull();

    const done = await seedRepo();
    await seedImport(done, { state: "done" });
    await cancelMigration(env.DB, { id: done }, NOW);
    expect((await importRowsOf(done))[0]?.state).toBe("done");

    const failed = await seedRepo();
    await seedImport(failed, { state: "failed", error: "boom" });
    await cancelMigration(env.DB, { id: failed }, NOW);
    expect((await importRowsOf(failed))[0]?.state).toBe("failed");

    const finished = await seedRepo();
    await seedMirror(finished, { lastSyncAt: NOW_UNIX - 60, nextSyncAt: NOW_UNIX + 540 });
    await cancelMigration(env.DB, { id: finished }, NOW);
    const row = await mirrorRowOf(finished);
    expect(row?.lastError).toBeNull();
    expect(row?.nextSyncAt).toBe(NOW_UNIX + 540);
  });

  it("aborts an ACTIVE import through the channel CAS and flips the repo back to ready", async () => {
    for (const state of ["staged", "indexing"] as const) {
      const repoId = await seedRepo({ status: "migrating" });
      await seedImport(repoId, { state });
      await cancelMigration(env.DB, { id: repoId }, NOW);
      const row = (await importRowsOf(repoId))[0];
      expect(row?.state).toBe("failed");
      expect(row?.error).toBe("aborted");
      const repo = await repoRowOf(repoId);
      expect(repo?.status).toBe("ready");
    }
  });

  it("deschedules a pending population with the sentinel, CAS'd on lastSyncAt null", async () => {
    const repoId = await seedRepo();
    await seedMirror(repoId, { lastError: "fetch failed", nextSyncAt: NOW_UNIX - 3600, syncState: "queued" });
    await cancelMigration(env.DB, { id: repoId }, NOW);
    const row = await mirrorRowOf(repoId);
    expect(row?.nextSyncAt).toBe(0);
    expect(row?.lastError).toBe(MIGRATE_CANCEL_SENTINEL);
    expect(row?.lastSyncAt).toBeNull();
  });

  it("leaves a syncing population to the CAS (a settle under the write wins honestly)", async () => {
    // The pending WHERE is lastSyncAt IS NULL, not syncState — a mid-sync
    // cancel deschedules; the settle then lands lastSyncAt and the row
    // converges to 4 (divergence 6). Here: cancel first, then a settled
    // lastSyncAt exists — a SECOND cancel must not touch it.
    const repoId = await seedRepo();
    await seedMirror(repoId, { syncState: "syncing" });
    await cancelMigration(env.DB, { id: repoId }, NOW);
    await drizzle(env.DB)
      .update(repoMirrors)
      // The settle's write (settleMirrorSuccess): lastSyncAt lands AND the
      // schedule re-arms — the descheduled 0 from the cancel is overwritten.
      .set({ lastSyncAt: NOW_UNIX, nextSyncAt: NOW_UNIX + 600, syncState: "idle", lastError: null })
      .where(eq(repoMirrors.repoId, repoId)); // the settle wins the race
    await cancelMigration(env.DB, { id: repoId }, NOW);
    const row = await mirrorRowOf(repoId);
    expect(row?.lastSyncAt).toBe(NOW_UNIX);
    expect(row?.lastError).toBeNull();
    expect(row?.nextSyncAt).not.toBe(0);
  });
});
