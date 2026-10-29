/**
 * The system-notices service (SPEC-0018 §3.1/§4.1) — the store seam over the
 * `system_notices` D1 table (schema.ts, migration 0040) and the DLQ emit's
 * description discipline.
 *
 * ## The model (§2.2/§4.1)
 *
 * A column-for-column port of upstream `models/system/notice.go`'s
 * `Notice{ID, Type, Description, CreatedUnix}`: type 1 = repository (repo
 * subsystem failures), type 2 = task (maintenance-task outcomes) — upstream's
 * `NoticeRepository`/`NoticeTask` iota pair. The rows are SYSTEM-attributed:
 * no actor, no owner column, nothing cascades (§5.5 — a dead-lettered purge
 * notice about repo X outlives X by design).
 *
 * ## The bound (§5.2)
 *
 * Upstream stores the description as unbounded LONGTEXT; ours bounds at emit
 * to 2000 chars — the kind label, identity, attempt count, and a one-line
 * diagnostic fit comfortably, and the bound is defensive against error
 * payloads with embedded monsters (§8.4's ratification). The clip is a
 * suffix-truncate with a visible `…` marker, never a silent drop of the row.
 * The DB never stores a template (the audit seam's discipline): callers pass
 * the RENDERED text.
 *
 * ## The emit-vs-retry rule (§5.1)
 *
 * Notices record TERMINAL failures only. A queue message still inside its
 * retry window is a transient, not a notice — the retrying catch arms
 * (repos/purge.ts) keep their log lines and gain nothing. Slice one's sole
 * emitter is the repo-tasks DLQ consumer (repos/dlq.ts), which fires after
 * the platform's `max_retries: 5` — the true terminal state, per the §8.3
 * ratification. Upstream's own emitters sit at operation FAILURE paths, never
 * per retry (notice.go's CreateRepositoryNotice callers).
 *
 * ## The reads/writes (§2.2, upstream routers/web/admin/notice.go)
 *
 * `listNotices` mirrors `Notices` (notice.go:82-88): paged,
 * `created_unix DESC` with the `id DESC` tiebreak (§5.7 — a same-second DLQ
 * batch keeps insertion order), 25 per page (upstream NoticePagingNum,
 * modules/setting/ui.go:140). `deleteNoticesByIds` takes the PRE-FILTERED id
 * set — the `ids[]` form filtering (§5.4, Go ParseInt discipline: a
 * non-numeric entry never parses, a non-positive never survives) is its own
 * exported `parseNoticeIds` so the route and the tests share it; an
 * empty-after-filter set is a no-op SUCCESS (upstream answers the flash
 * regardless of matched rows, notice.go:56-62). `emptyNotices` is the one
 * bare `DELETE FROM system_notices` (upstream's `DeleteNotices(0, 0)` →
 * `DELETE FROM notice`, notice.go:91-93).
 */

import { desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  SYSTEM_NOTICE_TYPE_REPOSITORY,
  SYSTEM_NOTICE_TYPE_TASK,
  systemNotices,
} from "../db/schema";

/** Upstream's closed two-value enum (notice.go:21-26). */
export type NoticeType = typeof SYSTEM_NOTICE_TYPE_REPOSITORY | typeof SYSTEM_NOTICE_TYPE_TASK;

/** The ratification bound (§5.2/§8.4): a rendered description longer than
 *  this is suffix-truncated to exactly this length WITH the trailing `…`. */
export const NOTICE_DESCRIPTION_MAX_CHARS = 2000;

/** Upstream `setting.UI.Admin.NoticePagingNum` (modules/setting/ui.go:140). */
export const ADMIN_NOTICES_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// The emit seam (§3.1) — recordNotice is the DLQ consumer's whole write API
// ---------------------------------------------------------------------------

export interface NoticeInput {
  type: NoticeType;
  /** The RENDERED one-liner (never a template — the header's note). Clipped
   *  to the §5.2 bound here, at emit, before the insert. */
  description: string;
  /** Emit time; default now. */
  now?: Date;
}

/** The §5.2 clip: keep the first `bound - 1` chars and append the visible
 *  `…` marker, so the stored length is exactly the bound when clipped. */
export function clipNoticeDescription(text: string, bound = NOTICE_DESCRIPTION_MAX_CHARS): string {
  if (text.length <= bound) return text;
  return text.slice(0, bound - 1) + "…";
}

/**
 * Insert one system notice. The DLQ consumer calls this INSIDE its
 * never-throw contract (§5.3): a rejected insert is the CALLER's
 * log-and-continue, not a throw that escapes — this function itself is a
 * plain awaited insert and may reject.
 */
export async function recordNotice(db: D1Database, input: NoticeInput): Promise<void> {
  await drizzle(db).insert(systemNotices).values({
    type: input.type,
    description: clipNoticeDescription(input.description),
    createdUnix: input.now ?? new Date(),
  });
}

// ---------------------------------------------------------------------------
// The paged read + count (§2.2 — upstream notice.go:76-88)
// ---------------------------------------------------------------------------

export interface NoticeRow {
  id: number;
  type: NoticeType;
  description: string;
  createdUnix: Date;
}

/** Upstream `CountNotices` (notice.go:76-79) — the page header's total. */
export async function countNotices(db: D1Database): Promise<number> {
  const rows = await drizzle(db)
    .select({ total: sql<number>`count(*)` })
    .from(systemNotices)
    .all();
  return rows[0]?.total ?? 0;
}

/**
 * Upstream `Notices` (notice.go:82-88): one page, `created_unix DESC` with
 * the `id DESC` tiebreak (§5.7), `pageSize` rows after the offset. `page` is
 * 1-based; the caller clamps (the shared parsePageNumber floor).
 */
export async function listNotices(
  db: D1Database,
  page: number,
  pageSize = ADMIN_NOTICES_PAGE_SIZE,
): Promise<NoticeRow[]> {
  const rows = await drizzle(db)
    .select()
    .from(systemNotices)
    .orderBy(desc(systemNotices.createdUnix), desc(systemNotices.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  // The type column's drizzle inference is `number`; the enum is CLOSED
  // (§4.1 — only the two iota values exist), so the narrowing is sound.
  return rows.map((row) => ({ ...row, type: row.type as NoticeType }));
}

// ---------------------------------------------------------------------------
// The deletes (§2.2 — upstream notice.go:46-63 + :66-75/:91-103)
// ---------------------------------------------------------------------------

/**
 * The `ids[]` filtering discipline (§5.4, upstream notice.go:47-54): Go's
 * `strconv.ParseInt` REJECTS mixed strings ("12abc" parses to 12 in JS but is
 * an error upstream — mirrored with the sign-aware digits-only gate), and the
 * survivors must be strictly positive ("0"/"-5" parse upstream and are then
 * dropped by the `id > 0` check — mirrored exactly).
 */
export function parseNoticeIds(values: string[]): number[] {
  const ids: number[] = [];
  for (const raw of values) {
    if (!/^[+-]?\d+$/.test(raw)) continue; // the ParseInt error arm
    const id = Number.parseInt(raw, 10);
    if (id > 0) ids.push(id); // the upstream `id > 0` filter
  }
  return ids;
}

/**
 * Delete the given ids. An EMPTY set is a no-op SUCCESS (§5.4 — upstream's
 * delete answers the flash regardless of matched rows; a junk form never
 * 500s, and an empty `IN ()` would be invalid SQL). Returns the deleted
 * count.
 */
export async function deleteNoticesByIds(db: D1Database, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await drizzle(db)
    .delete(systemNotices)
    .where(inArray(systemNotices.id, ids))
    .returning({ id: systemNotices.id });
  return rows.length;
}

/**
 * The empty-all arm (§2.2): ONE bare delete over the whole table (upstream's
 * `DELETE FROM notice`, notice.go:93). Returns the deleted count (0 on an
 * already-empty table — §5.8's no-op success).
 */
export async function emptyNotices(db: D1Database): Promise<number> {
  const rows = await drizzle(db)
    .delete(systemNotices)
    .where(eq(systemNotices.id, systemNotices.id))
    .returning({ id: systemNotices.id });
  return rows.length;
}
