/**
 * The artifact model + storage naming (SPEC-0012 §2.4-2.5/§4.2, M1b) —
 * ported from gitea/models/actions/artifact.go and the storage-path/chunk
 * naming of routers/api/actions/artifacts_chunks.go.
 *
 * R2 KEYS (§4.2, the SPEC's namespace table — names are pure functions of
 * validated numeric segments, never user input):
 *   actions/logs/<log_filename>                                  (logs.ts)
 *   actions/tmp/<run_id>/v3/<run>-<artifact>-<s>-<e>.chunk       v3 chunks
 *   actions/tmp/<run_id>/v4/tmp-upload/run-<run_id>-v4/…         v4 spool
 *   actions/artifacts/<run_id>/<artifact_id>                     merged
 *
 * The merge runs as an R2 multipart upload fed part-by-part (§4.2's
 * platform note: no server-side concatenation; the multipart pack is the
 * near-zero-CPU answer, artifacts-merge.ts).
 */

import { and, asc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionArtifacts } from "../../db/schema";
import type { TaskRow } from "./model";

type D1 = D1Database;

export const ARTIFACT_STATUS_UPLOAD_PENDING = 1;
export const ARTIFACT_STATUS_UPLOAD_CONFIRMED = 2;
export const ARTIFACT_STATUS_UPLOAD_ERROR = 3; // reserved upstream, unused
export const ARTIFACT_STATUS_EXPIRED = 4;
export const ARTIFACT_STATUS_PENDING_DELETION = 5;
export const ARTIFACT_STATUS_DELETED = 6;

export const CONTENT_ENCODING_V3_GZIP = "gzip";
export const CONTENT_TYPE_ZIP = "application/zip";

export type ArtifactRow = typeof actionArtifacts.$inferSelect;

// ---------------------------------------------------------------------------
// Naming (artifacts_chunks.go:33-51,179-182)
// ---------------------------------------------------------------------------

/** The v3 chunk namespace root (§4.2). */
export function v3Dir(runId: number): string {
  return `actions/tmp/${runId}/v3`;
}

/** makeChunkFilenameV3 (artifacts_chunks.go:41-47): `<run>-<artifact>-<start>-<end>.chunk`. */
export function makeChunkFilenameV3(runId: number, artifactId: number, start: number, end: number): string {
  return `${runId}-${artifactId}-${start}-${end}.chunk`;
}

/** The v3 chunk object key (§4.2 table row). */
export function makeChunkPathV3(runId: number, artifactId: number, start: number, end: number): string {
  return `${v3Dir(runId)}/${makeChunkFilenameV3(runId, artifactId, start, end)}`;
}

/** The v4 spool directory — upstream's `tmp-upload/run-<id>-v4` inside the
 *  run's v4 namespace (§4.2 table row). */
export function v4Dir(runId: number): string {
  return `actions/tmp/${runId}/v4/tmp-upload/run-${runId}-v4`;
}

/** makeBlockFilenameV4 (artifactsv4.go:179-182): base64url WITH padding in
 *  the name (the SIGNATURE is raw/no-pad — different spellings, both
 *  upstream). Size 0 keeps the file listable (no "-1" in names). */
export function makeBlockFilenameV4(runId: number, artifactId: number, size: number, blockId: string): string {
  const sizeInName = Math.max(size, 0);
  const encoded = btoa(Array.from(new TextEncoder().encode(blockId), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_"); // base64.URLEncoding keeps padding
  return `block-${runId}-${artifactId}-${sizeInName}-${encoded}`;
}

/** The v4 blocklist object key (artifactsv4.go:448). */
export function makeBlockListKeyV4(runId: number, artifactId: number): string {
  return `${v4Dir(runId)}/${runId}-${artifactId}-blocklist`;
}

/** The merged artifact object key (§4.2: actions/artifacts/<run>/<artifact>;
 *  upstream generateArtifactStoragePath adds a nanotime + extension — the
 *  run/artifact pair is already unique here, and the v4 listing filters by
 *  content_encoding containing "/", which the merged arm does not need). */
export function makeArtifactStoragePath(runId: number, artifactId: number): string {
  return `actions/artifacts/${runId}/${artifactId}`;
}

// ---------------------------------------------------------------------------
// Expiry (artifact.go:92-107)
// ---------------------------------------------------------------------------

export interface ArtifactExpiryOptions {
  /** ACTIONS_ARTIFACT_RETENTION_DAYS (0 = upstream's unlimited). */
  retentionDays: number;
}

/**
 * artifactExpiry (artifact.go:94-107): an explicit expiry clamps up to
 * tomorrow (v4 clients use the runner's clock) and down to the retention
 * ceiling; no explicit expiry → retention days or keep-forever (0).
 */
export function artifactExpiry(requestedSeconds: number | null, opts: ArtifactExpiryOptions): number {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 24 * 60 * 60;
  if (requestedSeconds !== null) {
    let expiry = Math.max(requestedSeconds, now + DAY);
    if (opts.retentionDays > 0) {
      expiry = Math.min(expiry, now + DAY * opts.retentionDays);
    }
    return expiry;
  }
  if (opts.retentionDays <= 0) {
    return 0; // artifactKeepForever
  }
  return now + DAY * opts.retentionDays;
}

// ---------------------------------------------------------------------------
// Create / update / find (artifact.go:109-153,155-204)
// ---------------------------------------------------------------------------

/** CreateArtifact (artifact.go:110-148): get-or-create on the
 *  (run, attempt, name, path) identity; an existing row only refreshes its
 *  expiry (a re-upload answers with the EXISTING row semantics, §5.5). */
export async function createArtifact(
  d1: D1,
  task: TaskRow,
  job: { runId: number; runAttemptId: number },
  artifactName: string,
  artifactPath: string,
  expiredUnix: number,
): Promise<ArtifactRow> {
  const db = drizzle(d1);
  const now = new Date();
  const existing = await db
    .select()
    .from(actionArtifacts)
    .where(
      and(
        eq(actionArtifacts.runId, job.runId),
        eq(actionArtifacts.runAttemptId, job.runAttemptId),
        eq(actionArtifacts.artifactName, artifactName),
        eq(actionArtifacts.artifactPath, artifactPath),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found !== undefined) {
    await db
      .update(actionArtifacts)
      .set({ expiredUnix, updated: now })
      .where(eq(actionArtifacts.id, found.id));
    return { ...found, expiredUnix };
  }
  const rows = await db
    .insert(actionArtifacts)
    .values({
      artifactName,
      artifactPath,
      runId: job.runId,
      runAttemptId: job.runAttemptId,
      runnerId: task.runnerId,
      repoId: task.repoId,
      ownerId: task.ownerId,
      commitSha: task.commitSha,
      status: ARTIFACT_STATUS_UPLOAD_PENDING,
      expiredUnix,
      created: now,
      updated: now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("actions: artifact insert returned no row");
  }
  return row;
}

export async function updateArtifact(
  d1: D1,
  id: number,
  cols: Partial<Pick<ArtifactRow, "storagePath" | "fileSize" | "fileCompressedSize" | "contentEncodingOrType" | "status" | "expiredUnix">>,
): Promise<void> {
  await drizzle(d1)
    .update(actionArtifacts)
    .set({ ...cols, updated: new Date() })
    .where(eq(actionArtifacts.id, id));
}

export async function getArtifactById(d1: D1, id: number): Promise<ArtifactRow | null> {
  const rows = await drizzle(d1).select().from(actionArtifacts).where(eq(actionArtifacts.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface FindArtifactsOptions {
  runId?: number;
  /** Empty means every attempt. */
  runAttemptIds?: number[];
  artifactName?: string;
  /** 0 = no status filter. */
  status?: number;
  /** The v4 finalized filter: confirmed-or-expired with a real content
   *  type (artifact.go:188-192). */
  finalizedArtifactsV4?: boolean;
}

/**
 * FindReadableArtifacts (artifact.go:171-204): the filtered rows, then —
 * when reading across MORE than one attempt — keep, per name, only the
 * artifacts of the newest attempt that has it (keepLatestAttemptArtifacts).
 */
export async function findReadableArtifacts(d1: D1, opts: FindArtifactsOptions): Promise<ArtifactRow[]> {
  const db = drizzle(d1);
  const conds: SQL[] = [];
  if (opts.runId !== undefined && opts.runId > 0) {
    conds.push(eq(actionArtifacts.runId, opts.runId));
  }
  if (opts.runAttemptIds !== undefined && opts.runAttemptIds.length > 0) {
    conds.push(inArray(actionArtifacts.runAttemptId, opts.runAttemptIds));
  }
  if (opts.artifactName !== undefined && opts.artifactName !== "") {
    conds.push(eq(actionArtifacts.artifactName, opts.artifactName));
  }
  if (opts.status !== undefined && opts.status > 0) {
    conds.push(eq(actionArtifacts.status, opts.status));
  }
  if (opts.finalizedArtifactsV4) {
    conds.push(
      sql`(${actionArtifacts.status} = ${ARTIFACT_STATUS_UPLOAD_CONFIRMED} OR ${actionArtifacts.status} = ${ARTIFACT_STATUS_EXPIRED})`,
    );
    // "*/*" means the field is a content type (artifact.go:191).
    conds.push(sql`${actionArtifacts.contentEncodingOrType} LIKE ${"%/%"}`);
  }
  const rows = await db
    .select()
    .from(actionArtifacts)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(actionArtifacts.id));
  const attemptIds = opts.runAttemptIds ?? [];
  if (attemptIds.length <= 1) {
    return rows;
  }
  const latest = new Map<string, number>();
  for (const art of rows) {
    latest.set(art.artifactName, Math.max(latest.get(art.artifactName) ?? 0, art.runAttemptId));
  }
  return rows.filter((art) => art.runAttemptId === latest.get(art.artifactName));
}

/** GetArtifactAttemptIDs (artifacts_utils.go:57-67): v1's rerun inheritance
 *  is v2 (rerun > 1, SPEC §1.4) — the task's own attempt only. */
export function readableArtifactAttemptIds(runAttemptId: number): number[] {
  return [runAttemptId];
}

// ---------------------------------------------------------------------------
// Deletion + expiry flips (artifact.go:255-287)
// ---------------------------------------------------------------------------

async function setConfirmedArtifactsStatus(d1: D1, status: number, where: SQL[]): Promise<void> {
  await drizzle(d1)
    .update(actionArtifacts)
    .set({ status, updated: new Date() })
    .where(and(eq(actionArtifacts.status, ARTIFACT_STATUS_UPLOAD_CONFIRMED), ...where));
}

export function setArtifactExpired(d1: D1, artifactId: number): Promise<void> {
  return setConfirmedArtifactsStatus(d1, ARTIFACT_STATUS_EXPIRED, [eq(actionArtifacts.id, artifactId)]);
}

export function setArtifactNeedDeleteByID(d1: D1, artifactId: number): Promise<void> {
  return setConfirmedArtifactsStatus(d1, ARTIFACT_STATUS_PENDING_DELETION, [eq(actionArtifacts.id, artifactId)]);
}

export function setArtifactNeedDeleteByRunAttempt(d1: D1, runId: number, runAttemptId: number, name: string): Promise<void> {
  return setConfirmedArtifactsStatus(d1, ARTIFACT_STATUS_PENDING_DELETION, [
    eq(actionArtifacts.runId, runId),
    eq(actionArtifacts.runAttemptId, runAttemptId),
    eq(actionArtifacts.artifactName, name),
  ]);
}

export async function setArtifactDeleted(d1: D1, artifactId: number): Promise<void> {
  await drizzle(d1)
    .update(actionArtifacts)
    .set({ status: ARTIFACT_STATUS_DELETED, updated: new Date() })
    .where(eq(actionArtifacts.id, artifactId));
}

/** ListNeedExpiredArtifacts (artifact.go:241-245). */
export async function listNeedExpiredArtifacts(d1: D1): Promise<ArtifactRow[]> {
  const now = Math.floor(Date.now() / 1000);
  return drizzle(d1)
    .select()
    .from(actionArtifacts)
    .where(
      and(
        sql`${actionArtifacts.expiredUnix} > 0`,
        lt(actionArtifacts.expiredUnix, now),
        eq(actionArtifacts.status, ARTIFACT_STATUS_UPLOAD_CONFIRMED),
      ),
    );
}

/** ListPendingDeleteArtifacts (artifact.go:249-253). */
export async function listPendingDeleteArtifacts(d1: D1, limit: number): Promise<ArtifactRow[]> {
  return drizzle(d1)
    .select()
    .from(actionArtifacts)
    .where(eq(actionArtifacts.status, ARTIFACT_STATUS_PENDING_DELETION))
    .limit(limit);
}
