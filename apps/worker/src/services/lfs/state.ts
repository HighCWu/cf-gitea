/**
 * `lfs_objects` state machine over Drizzle ORM (SPEC-0006 §3.2–3.4).
 *
 * The table lives in the Drizzle schema (`lfsObjects`, src/db/schema.ts) and
 * landed as migration 0005; D1 access goes through Drizzle per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `LFS_OBJECTS_DDL_STATEMENTS` below is kept only as the historical record of
 * the pre-migration bootstrap — the generated migration is authoritative now.
 *
 * Timestamps are unix seconds (repo convention, `mode: "timestamp"` — drizzle
 * maps Date ↔ integer seconds exactly like the previous raw `toUnix`/
 * `fromUnix` helpers). Rows exist only for objects the LFS API touched — a
 * pointer merely seen in git history never creates a row. State transitions
 * (§3.3):
 *
 *   absent --batch(upload)--> uploading --verify(200)--> verified
 *   absent --adopt(HEAD ok)--> verified        (upload finished, verify lost)
 *   uploading --sweep(HEAD ok)--> verified     (stale >24 h)
 *   uploading --sweep(HEAD missing)--> deleted
 *   verified --GC(unreachable > grace)--> row+object deleted
 */

import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { lfsObjects } from "../../db/schema";
import type { LfsObjectStat } from "./store";
import { pointerBlobSha1, type LfsPointer } from "./pointer";

/**
 * SUPERSEDED by migration 0005 (`lfsObjects` in src/db/schema.ts) — kept only
 * so pre-migration scratch databases can still be bootstrapped by hand. Do
 * not extend; change the schema + regenerate instead (AGENTS.md).
 */
export const LFS_OBJECTS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lfs_objects (
  repo_id INTEGER NOT NULL,
  oid TEXT NOT NULL,
  size INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, oid)
)`,
  `CREATE INDEX IF NOT EXISTS idx_lfs_objects_repo_state_updated
  ON lfs_objects (repo_id, state, updated_at)`,
];

/** Default stale-`uploading` age before the sweep may touch a row (24 h). */
export const DEFAULT_STALE_UPLOADING_AFTER_SECONDS = 24 * 60 * 60;
/** Default GC grace for `verified` rows (7 d — upstream's push/upload race guard). */
export const DEFAULT_GC_GRACE_SECONDS = 7 * 24 * 60 * 60;
/** D1 binds per query are capped at 100; IN-lists chunk at ≤90 (§3.2). */
export const D1_IN_CHUNK = 90;

export type LfsObjectState = "uploading" | "verified";

export interface LfsObjectRow {
  repoId: number;
  oid: string;
  size: number;
  state: LfsObjectState;
  createdAt: Date;
  updatedAt: Date;
}

/** HEAD seam used by adopt/sweep — backed by the store in production. */
export type LfsHeadFn = (oid: string) => Promise<LfsObjectStat | null>;

export interface AdoptValidateOptions {
  /**
   * Presign mode requires the stored checksum to equal the oid; relay mode
   * accepts size-only when the object carries no stored checksum (§3.3).
   */
  requireChecksum?: boolean;
}

/**
 * Adopt validation (§3.3): the object must exist, match the declared size,
 * and — whenever a stored checksum is known — that checksum must equal the
 * oid. Safe without re-reading bytes because the key is repo-scoped: only
 * content authorized for this repo can be under `lfs/<storage_key>/`.
 */
export function validateAdoptStat(
  stat: LfsObjectStat | null,
  oid: string,
  declaredSize: number,
  options: AdoptValidateOptions = {},
): boolean {
  if (stat === null) return false;
  if (stat.size !== declaredSize) return false;
  if (stat.sha256Hex !== null) return stat.sha256Hex.toLowerCase() === oid;
  return options.requireChecksum !== true;
}

export class LfsStateService {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  /** Row lookup — the batch API's per-object meta read (PK covers it). */
  async get(repoId: number, oid: string): Promise<LfsObjectRow | null> {
    const row = await this.db
      .select()
      .from(lfsObjects)
      .where(and(eq(lfsObjects.repoId, repoId), eq(lfsObjects.oid, oid)))
      .get();
    return row ?? null;
  }

  /**
   * Idempotent `uploading` row for a batch that is about to issue hrefs.
   * Callers must reach this only after the "already present ⇒ no actions"
   * rule excluded `verified` rows, so a plain upsert is correct: re-batching
   * after a failed verify re-issues hrefs and refreshes `updated_at`
   * (post-sweep grace), and the one demotion case — a `verified` row whose
   * object vanished from R2 — is the self-heal path that WANTS the demotion.
   */
  async ensureUploading(repoId: number, oid: string, size: number, now: Date): Promise<void> {
    await this.db
      .insert(lfsObjects)
      .values({ repoId, oid, size, state: "uploading", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [lfsObjects.repoId, lfsObjects.oid],
        set: { size, state: "uploading", updatedAt: now },
      });
  }

  /**
   * Insert/promote as `verified` without a prior row read — the adopt write
   * (§3.3). Validates nothing itself; compose with `validateAdoptStat`.
   */
  async insertVerified(repoId: number, oid: string, size: number, now: Date): Promise<void> {
    await this.db
      .insert(lfsObjects)
      .values({ repoId, oid, size, state: "verified", createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [lfsObjects.repoId, lfsObjects.oid],
        set: { size, state: "verified", updatedAt: now },
      });
  }

  /**
   * Adopt: HEAD the object via the seam, validate size (+ stored checksum),
   * insert as `verified` — "upload finished, verify never arrived". Returns
   * false when validation fails (caller falls through to re-upload).
   */
  async adopt(
    repoId: number,
    oid: string,
    size: number,
    head: LfsHeadFn,
    options: AdoptValidateOptions & { now?: Date } = {},
  ): Promise<boolean> {
    const stat = await head(oid);
    if (!validateAdoptStat(stat, oid, size, options)) return false;
    await this.insertVerified(repoId, oid, size, options.now ?? new Date());
    return true;
  }

  /** The verify handler's state flip (`uploading → verified`). */
  async markVerified(repoId: number, oid: string, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(lfsObjects)
      .set({ state: "verified", updatedAt: now })
      .where(and(eq(lfsObjects.repoId, repoId), eq(lfsObjects.oid, oid)))
      .returning({ oid: lfsObjects.oid });
    return updated.length > 0;
  }

  async delete(repoId: number, oid: string): Promise<boolean> {
    const deleted = await this.db
      .delete(lfsObjects)
      .where(and(eq(lfsObjects.repoId, repoId), eq(lfsObjects.oid, oid)))
      .returning({ oid: lfsObjects.oid });
    return deleted.length > 0;
  }

  /** Batch existence map for the (future) push gate — chunked IN at ≤90. */
  async existingOids(repoId: number, oids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < oids.length; i += D1_IN_CHUNK) {
      const chunk = oids.slice(i, i + D1_IN_CHUNK);
      if (chunk.length === 0) continue;
      const rows = await this.db
        .select({ oid: lfsObjects.oid })
        .from(lfsObjects)
        .where(and(eq(lfsObjects.repoId, repoId), inArray(lfsObjects.oid, chunk)));
      for (const row of rows) found.add(row.oid);
    }
    return found;
  }

  /** Projected per-repo LFS size for the quota check (§4.7). Includes
   * `uploading` rows on purpose: abandoned uploads overcount only until the
   * sweep reclaims them — the conservative direction for a quota. */
  async sumSize(repoId: number): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${lfsObjects.size}), 0)` })
      .from(lfsObjects)
      .where(eq(lfsObjects.repoId, repoId));
    return rows[0]?.total ?? 0;
  }

  /** Cron fan-out shape: one Queue message per repo with stale rows (§3.4). */
  async repoIdsWithStaleUploading(cutoff: Date, limit = 100): Promise<number[]> {
    const rows = await this.db
      .selectDistinct({ repoId: lfsObjects.repoId })
      .from(lfsObjects)
      .where(and(eq(lfsObjects.state, "uploading"), lt(lfsObjects.updatedAt, cutoff)))
      .limit(limit);
    return rows.map((row) => row.repoId);
  }

  /** Sweep consumer shape: one repo's stale-`uploading` rows. */
  async listStaleUploading(repoId: number, cutoff: Date, limit = 100): Promise<LfsObjectRow[]> {
    return this.db
      .select()
      .from(lfsObjects)
      .where(
        and(
          eq(lfsObjects.repoId, repoId),
          eq(lfsObjects.state, "uploading"),
          lt(lfsObjects.updatedAt, cutoff),
        ),
      )
      .limit(limit);
  }

  /**
   * One sweep step: promote when HEAD validates against the row's declared
   * size, else drop the row (single-shot PUTs mean no partial object to reap).
   */
  async sweepStaleUploading(
    repoId: number,
    cutoff: Date,
    head: LfsHeadFn,
    options: { now?: Date; limit?: number } = {},
  ): Promise<{ promoted: string[]; deleted: string[] }> {
    const rows = await this.listStaleUploading(repoId, cutoff, options.limit ?? 100);
    const promoted: string[] = [];
    const deleted: string[] = [];
    for (const row of rows) {
      const stat = await head(row.oid);
      if (validateAdoptStat(stat, row.oid, row.size)) {
        await this.markVerified(repoId, row.oid, options.now ?? new Date());
        promoted.push(row.oid);
      } else {
        await this.delete(repoId, row.oid);
        deleted.push(row.oid);
      }
    }
    return { promoted, deleted };
  }

  /**
   * GC candidate page: `verified` rows older than grace in both created_at
   * and updated_at (upstream `OlderThan` + `UpdatedLessRecentlyThan`,
   * `services/repository/lfs.go:120-131`), keyset-paged on the PK.
   */
  async listGcCandidates(
    repoId: number,
    grace: { olderThan: Date; updatedLessRecentlyThan: Date },
    options: { limit?: number; afterOid?: string } = {},
  ): Promise<LfsObjectRow[]> {
    const limit = options.limit ?? 100;
    const after = options.afterOid ?? "";
    return this.db
      .select()
      .from(lfsObjects)
      .where(
        and(
          eq(lfsObjects.repoId, repoId),
          eq(lfsObjects.state, "verified"),
          lt(lfsObjects.createdAt, grace.olderThan),
          lt(lfsObjects.updatedAt, grace.updatedLessRecentlyThan),
          gt(lfsObjects.oid, after),
        ),
      )
      .orderBy(asc(lfsObjects.oid))
      .limit(limit);
  }
}

/**
 * Reachability predicate for the GC (§3.4): the object is collectable only
 * when the repo's object index no longer holds the pointer blob whose git
 * sha1 is `sha1("blob <len>\0" + canonical pointer text)`. `hasBlob` is the
 * RepoDO RPC seam (`hasBlob`, SPEC-0001 §4) — inject a stub until that RPC
 * lands; upstream parity: `GarbageCollectLFSMetaObjectsForRepo` computes
 * `ComputeBlobHash` over the canonical pointer and asks `IsObjectExist`.
 */
export async function isLfsObjectUnreachable(
  pointer: LfsPointer,
  hasBlob: (gitBlobSha1Hex: string) => Promise<boolean>,
): Promise<boolean> {
  const blobSha1 = await pointerBlobSha1(pointer);
  return !(await hasBlob(blobSha1));
}
