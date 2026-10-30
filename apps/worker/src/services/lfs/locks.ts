/**
 * `lfs_locks` service — the git-lfs file-locking model (SPEC-0006 §2.7).
 *
 * Upstream pin `fc49368845` ports, line-for-line where the wire can see them:
 * - model `models/git/lfs_lock.go` (LFSLock: autoincrement id, repo scope,
 *   owner, normalized path, created) — our table adds `lower_path` (schema.ts
 *   comment) so the per-repo case-insensitive uniqueness is a D1 UNIQUE index
 *   instead of upstream's in-transaction SELECT (lfs_lock.go:74-80).
 * - `util.PathJoinRel` (modules/util/path.go:48-63) — the path normalization
 *   applied on insert AND on every path lookup (`GetLFSLock`, lfs_lock.go:91).
 *   Ported over a faithful Go `path.Clean` (go/src/path/path.go).
 * - `strconv.ParseInt(s, 10, 64)` outcome mimic (`goParseInt64`): the list
 *   handler answers `400 "bad request : " + err.Error()` (locks.go:86-92), so
 *   the Go error text classes ("invalid syntax" / "value out of range") are
 *   part of the wire contract.
 * - `GetLFSLockByRepoID` paging (lfs_lock.go:117-128): `cursor` is a PAGE
 *   number, not a row offset — `page > 0 ? (page-1)*limit : 0`, so cursor 0
 *   and cursor 1 alias the first page (upstream quirk, ported verbatim);
 *   `limit <= 0` means UNLIMITED (no LIMIT clause), ordered by id.
 * - The wire shape is `convert.ToLFSLock` (services/convert/convert.go:1066):
 *   stringified id, second-rounded RFC3339 `locked_at`, `owner: {name}`; a
 *   lock whose owner row is gone renders as `null` (upstream returns a nil
 *   lock there).
 *
 * D1 access goes through Drizzle per the architecture boundary; timestamps
 * are unix seconds (`mode: "timestamp"`, repo convention).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { lfsLocks, users } from "../../db/schema";

// ---------------------------------------------------------------------------
// Go stdlib ports (wire-visible semantics)
// ---------------------------------------------------------------------------

/** Go `path.Clean` (go/src/path/path.go Clean) — char-exact port over a
 *  write index `w` (lazybuf semantics: decrements only move the logical end;
 *  stale chars past `w` are overwritten by later appends). */
function goPathClean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const n = path.length;
  const out: string[] = [];
  let w = 0;
  let r = 0;
  let dotdot = 0;
  if (rooted) {
    out[w++] = "/";
    r = 1;
    dotdot = 1;
  }
  while (r < n) {
    const c = path.charAt(r);
    if (c === "/") {
      r++;
    } else if (c === "." && (r + 1 === n || path.charAt(r + 1) === "/")) {
      r++;
    } else if (c === "." && path.charAt(r + 1) === "." && (r + 2 === n || path.charAt(r + 2) === "/")) {
      r += 2;
      if (w > dotdot) {
        w--;
        // Go inspects out.index(w) — the stale char at the boundary (always
        // defined here: w only shrank below the high-water mark).
        while (w > dotdot && out[w] !== "/") w--;
      } else if (!rooted) {
        if (w > 0) out[w++] = "/";
        out[w++] = ".";
        out[w++] = ".";
        dotdot = w;
      }
      // rooted stays rooted: no leading ".." is ever emitted
    } else {
      if ((rooted && w !== 1) || (!rooted && w !== 0)) out[w++] = "/";
      while (r < n && path.charAt(r) !== "/") {
        out[w++] = path.charAt(r);
        r++;
      }
    }
  }
  if (w === 0) return ".";
  return out.slice(0, w).join("");
}

/**
 * `util.PathJoinRel` (modules/util/path.go:48-63) over a single element —
 * the exact normalization `CreateLFSLock`/`GetLFSLock` apply to every path
 * ("Foo/Test/../subFOlder/../Relative/../BaR.zip" → "Foo/BaR.zip",
 * ".." → ".", "" → "").
 */
export function pathJoinRel(p: string): string {
  if (p === "") return "";
  const cleaned = goPathClean(`/${p}`);
  if (cleaned === "/") return ".";
  return cleaned.slice(1);
}

export interface GoInt64Parse {
  /** Parsed value; 0 on a syntax error, the ±int64 clamp on a range error. */
  value: bigint;
  errorClass: "syntax" | "range" | null;
}

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

/**
 * `strconv.ParseInt(s, 10, 64)` outcome mimic — value plus error class, so
 * callers can render Go's `*NumError` texts ("invalid syntax" / "value out
 * of range") for the locks list `?id=` arm (locks.go:86-92) and reproduce
 * `PathParamInt64`'s discard-the-error semantics (0 on syntax, clamp on
 * range) for the unlock `{lid}` segment.
 */
export function goParseInt64(s: string): GoInt64Parse {
  // ASCII digits only, optional sign — exactly Go's digit loop (no
  // underscores at base 10, no whitespace trimming).
  if (!/^[+-]?[0-9]+$/.test(s)) return { value: 0n, errorClass: "syntax" };
  const v = BigInt(s);
  if (v > INT64_MAX) return { value: INT64_MAX, errorClass: "range" };
  if (v < INT64_MIN) return { value: INT64_MIN, errorClass: "range" };
  return { value: v, errorClass: null };
}

/** Go `*strconv.NumError` text for the locks list 400 arm (locks.go:89). */
export function goParseInt64ErrorText(raw: string, errorClass: "syntax" | "range"): string {
  const detail = errorClass === "syntax" ? "invalid syntax" : "value out of range";
  return `strconv.ParseInt: parsing ${JSON.stringify(raw)}: ${detail}`;
}

// ---------------------------------------------------------------------------
// Paging (upstream locks.go:77-83 + GetLFSLockByRepoID)
// ---------------------------------------------------------------------------

/** `setting.LFS.LocksPagingNum` default (modules/setting/lfs.go:50-52). */
export const LFS_LOCKS_PAGING_NUM = 50;

/**
 * `ctx.FormInt` (Atoi discarding the error: ""/"abc" → 0, range → clamp) +
 * the locks handlers' cursor/limit clamps. `limit <= 0` means unlimited.
 */
export function parseLocksPaging(params: URLSearchParams): { cursor: number; limit: number } {
  const cursor = Math.max(formInt(params, "cursor"), 0);
  let limit = formInt(params, "limit");
  if (limit > LFS_LOCKS_PAGING_NUM && LFS_LOCKS_PAGING_NUM > 0) {
    limit = LFS_LOCKS_PAGING_NUM;
  } else if (limit < 0) {
    limit = 0;
  }
  return { cursor, limit };
}

function formInt(params: URLSearchParams, key: string): number {
  const parsed = goParseInt64(params.get(key) ?? "");
  if (parsed.errorClass === "syntax") return 0;
  const v = Number(parsed.value);
  return Number.isFinite(v) ? v : 0;
}

/** `GetLFSLockByRepoID`'s start: `page > 0 ? (page-1)*pageSize : 0`. */
export function locksPageOffset(cursor: number, limit: number): number {
  const offset = cursor > 0 ? (cursor - 1) * limit : 0;
  // Absurd cursors keep the upstream outcome (an empty page) without
  // handing SQLite an unbound offset.
  return Math.min(Math.max(offset, 0), Number.MAX_SAFE_INTEGER);
}

/** `next = limit > 0 && len(rows) == limit ? itoa(cursor+1) : ""` (both handlers). */
export function locksNextCursor(cursor: number, limit: number, rowCount: number): string {
  return limit > 0 && rowCount === limit ? String(cursor + 1) : "";
}

// ---------------------------------------------------------------------------
// Wire shape (convert.ToLFSLock)
// ---------------------------------------------------------------------------

export interface LfsLockRecord {
  id: number;
  repoId: number;
  ownerId: number;
  path: string;
  createdAt: Date;
  /** `users.username` of the owner; null when the owner row is gone. */
  ownerName: string | null;
}

export interface LfsLockWire {
  id: string;
  path: string;
  locked_at: string;
  owner: { name: string } | null;
}

/** Second-rounded RFC3339 — Go `time.Time` JSON after `Round(time.Second)`. */
export function rfc3339Seconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `convert.ToLFSLock` (convert.go:1066-1081): nil on a missing owner row. */
export function toLfsLockWire(record: LfsLockRecord): LfsLockWire | null {
  if (record.ownerName === null) return null;
  return {
    id: String(record.id),
    path: record.path,
    locked_at: rfc3339Seconds(record.createdAt),
    owner: { name: record.ownerName },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LfsLockService {
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  /**
   * `CreateLFSLock` (lfs_lock.go:69-88): normalize the path, then insert;
   * a UNIQUE conflict on (repo_id, lower_path) answers with the EXISTING
   * lock (the handler echoes it in the 409 body). The conflict-retry loop
   * covers the pathological "conflicting row deleted between the failed
   * insert and the read" window.
   */
  async create(
    repoId: number,
    ownerId: number,
    rawPath: string,
    now: Date,
  ): Promise<{ created: LfsLockRecord } | { conflict: LfsLockRecord }> {
    const path = pathJoinRel(rawPath);
    const lowerPath = path.toLowerCase();
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await this.db
        .insert(lfsLocks)
        .values({ repoId, ownerId, path, lowerPath, createdAt: now })
        .onConflictDoNothing({ target: [lfsLocks.repoId, lfsLocks.lowerPath] })
        .returning();
      const row = inserted[0];
      if (row !== undefined) {
        const created = await this.getByIdAndRepo(row.id, repoId);
        if (created !== null) return { created };
      }
      const existing = await this.getByPath(repoId, path);
      if (existing !== null) return { conflict: existing };
    }
    throw new Error("lfs lock create: conflicting row vanished twice");
  }

  /** `GetLFSLockByIDAndRepo` (lfs_lock.go:105-114), owner name joined. */
  async getByIdAndRepo(id: number, repoId: number): Promise<LfsLockRecord | null> {
    const row = await this.selectWithOwner()
      .where(and(eq(lfsLocks.id, id), eq(lfsLocks.repoId, repoId)))
      .get();
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * `GetLFSLock` (lfs_lock.go:91-102): PathJoinRel + case-insensitive match.
   * The case folding happens against the stored `lower_path` (folded at
   * insert with the same rule), keeping the comparison consistent; ASCII
   * paths behave exactly like upstream's `lower(path) = lower(?)` pair.
   */
  async getByPath(repoId: number, rawPath: string): Promise<LfsLockRecord | null> {
    const lowerPath = pathJoinRel(rawPath).toLowerCase();
    const row = await this.selectWithOwner()
      .where(and(eq(lfsLocks.repoId, repoId), eq(lfsLocks.lowerPath, lowerPath)))
      .get();
    return row === undefined ? null : rowToRecord(row);
  }

  /**
   * `GetLFSLockByRepoID` (lfs_lock.go:117-128): ORDER BY id, LIMIT only when
   * `limit > 0`, offset = page-number semantics (see `locksPageOffset`).
   */
  async listPaged(repoId: number, cursor: number, limit: number): Promise<LfsLockRecord[]> {
    const query = this.selectWithOwner()
      .where(eq(lfsLocks.repoId, repoId))
      .orderBy(asc(lfsLocks.id))
      .$dynamic();
    const rows =
      limit > 0
        ? await query.limit(limit).offset(locksPageOffset(cursor, limit))
        : await query;
    return rows.map(rowToRecord);
  }

  /**
   * `DeleteLFSLockByID`'s read arm (lfs_lock.go:154-171) — the handler runs
   * the ownership check between this read and `remove`, mirroring
   * upstream's transaction sequence.
   */
  async remove(id: number, repoId: number): Promise<void> {
    await this.db.delete(lfsLocks).where(and(eq(lfsLocks.id, id), eq(lfsLocks.repoId, repoId)));
  }

  private selectWithOwner() {
    return this.db
      .select({ lock: lfsLocks, ownerName: users.username })
      .from(lfsLocks)
      .leftJoin(users, eq(users.id, lfsLocks.ownerId));
  }
}

function rowToRecord(row: { lock: typeof lfsLocks.$inferSelect; ownerName: string | null }): LfsLockRecord {
  return {
    id: row.lock.id,
    repoId: row.lock.repoId,
    ownerId: row.lock.ownerId,
    path: row.lock.path,
    createdAt: row.lock.createdAt,
    ownerName: row.ownerName,
  };
}
