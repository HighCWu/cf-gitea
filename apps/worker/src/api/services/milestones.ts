import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { milestones } from "../../db/schema";
import { ApiError } from "../errors";
import type { Milestone } from "../models/milestone";
import { GO_ZERO_TIME } from "./repository";
import { IssuesService, type MilestoneRow, type MilestoneStateFilter, type UpdateMilestonePatch } from "../../issues/service";

/**
 * Repo-scoped milestone routes (SPEC-0004 §2.4 rows: issueGetMilestonesList /
 * issueCreateMilestone / issueGetMilestone / issueEditMilestone /
 * issueDeleteMilestone). Mutations WRAP the landed SPEC-0005 IssuesService
 * (create/update/delete) — no duplicated write semantics; this module adds
 * the API-facing read (upstream default ordering + name filter + pagination,
 * which the data-layer `listMilestones` does not model), the id-or-name
 * resolution, and the deadline parsing.
 *
 * Upstream references mirrored:
 *  - state filter: `common.ParseIssueFilterStateIsClosed` — "all" disables,
 *    "closed" is closed, "open"/""/UNKNOWN all mean open (no validation).
 *  - ordering: FindMilestoneOptions default `deadline_unix ASC, name ASC`
 *    (models/issues/milestone_list.go ToOrders default).
 *  - due dates: `common.ApplyAPIDeadlineTimestamp` (routers/common/deadline.go)
 *    — "2006-01-02", "2006-01-02 15:04:05" or RFC3339 input, normalized to
 *    23:59:59 of that calendar day (DefaultUILocation = UTC here), sub-2-day
 *    unix values cleared to "no deadline"; anything else is the exact 400
 *    `invalid date format: <input>` (upstream runtime-only: the vendored
 *    contract declares no 400 for milestone POST/PATCH).
 *  - id-or-name: `getMilestoneByIDOrName` (routers/api/v1/repo/milestone.go)
 *    — strconv.ParseInt BASE 0 (0x/0o/leading-0 forms), nonzero numeric ids
 *    fall through to a case-sensitive name lookup, missing → plain
 *    `not found` 404.
 */

/**
 * The deadline parser. Returns the end-of-day UTC timestamp, or null for the
 * cleared form. Mirrors Go's format attempts in order; the wall-clock
 * Y-M-D is the literal string prefix in every accepted format (Go
 * ParseInLocation reads those wall fields even for offset RFC3339 input).
 */
export function parseMilestoneDeadline(raw: string): Date | null {
  if (raw === "") {
    return null;
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const dateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw);
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const prefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if ((!dateOnly && !dateTime && !rfc3339) || prefix === null) {
    throw new ApiError(400, `invalid date format: ${raw}`);
  }
  // ApplyAPIDeadlineTimestamp: end of that calendar day (DefaultUILocation =
  // UTC in Workers), values under 2 days cleared ("tolerate timezone
  // difference between server and client").
  const endOfDay = new Date(`${prefix[1]}-${prefix[2]}-${prefix[3]}T23:59:59Z`);
  if (Number.isNaN(endOfDay.getTime())) {
    throw new ApiError(400, `invalid date format: ${raw}`);
  }
  const unix = Math.floor(endOfDay.getTime() / 1000);
  return unix < 86400 * 2 ? null : endOfDay;
}

/**
 * `strconv.ParseInt(s, 0, 64)` subset: 0x/0o/0b prefixes and the leading-0
 * octal form parse as such, else decimal; garbage → 0 (Go ignores the error).
 */
export function goParseIntBase0(raw: string): number {
  const match = /^([-+])?(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|0[0-7]+|[0-9]+)$/.exec(raw);
  if (match === null) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const digits = match[2] ?? "";
  let radix = 10;
  let value = digits;
  if (/^0[xX]/.test(digits)) {
    radix = 16;
    value = digits.slice(2);
  } else if (/^0[bB]/.test(digits)) {
    radix = 2;
    value = digits.slice(2);
  } else if (/^0[oO]/.test(digits)) {
    radix = 8;
    value = digits.slice(2);
  } else if (/^0[0-7]/.test(digits)) {
    radix = 8;
    value = digits.slice(1);
  }
  const parsed = Number.parseInt(value, radix);
  return Number.isSafeInteger(parsed) ? sign * parsed : 0;
}

function nullableIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/**
 * `convert.ToAPIMilestone` — open/closed counters derive from the maintained
 * D1 counters (`NumOpenIssues = NumIssues - NumClosedIssues`, AfterLoad);
 * `closed_at` renders only when closed; `due_on` only when a deadline is set.
 */
export function toApiMilestone(row: MilestoneRow): Milestone {
  const numIssues = row.numIssues ?? 0;
  const numClosedIssues = row.numClosedIssues ?? 0;
  return {
    id: row.id,
    state: row.isClosed ? "closed" : "open",
    title: row.name,
    description: row.content ?? "",
    open_issues: numIssues - numClosedIssues,
    closed_issues: numClosedIssues,
    created_at: row.createdAt === null ? GO_ZERO_TIME : row.createdAt.toISOString(),
    updated_at: nullableIso(row.updatedAt),
    closed_at: row.isClosed ? nullableIso(row.closedDateAt) : null,
    due_on: row.deadlineAt === null ? null : row.deadlineAt.toISOString(),
  };
}

export interface RepoMilestoneListOptions {
  state: MilestoneStateFilter;
  name: string;
  page: number;
  limit: number;
}

/** `ListMilestones` — FindAndCount with the default `deadline ASC, name ASC` order. */
export async function listRepoMilestones(
  d1: D1Database,
  repoId: string,
  opts: RepoMilestoneListOptions,
): Promise<{ items: MilestoneRow[]; total: number }> {
  const conditions: SQL[] = [eq(milestones.repoId, repoId)];
  if (opts.state !== "all") {
    conditions.push(eq(milestones.isClosed, opts.state === "closed"));
  }
  if (opts.name !== "") {
    // db.BuildCaseInsensitiveLike shape. NOT LIKE: D1 caps LIKE patterns at
    // 50 bytes, so a long `?name=` needle threw D1_ERROR and the route
    // answered a plain 500. The substring goes through instr() instead —
    // the documented user-search precedent (services/user.ts:81-97, the
    // org-members 943e1e9 shape). The needle pre-lowers for the
    // case-insensitive pair (the name lower()s in SQL, exactly what the
    // LIKE wrapped).
    conditions.push(sql`instr(lower(${milestones.name}), ${opts.name.toLowerCase()}) > 0`);
  }
  const where = and(...conditions);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(milestones).where(where);
  const items = await db
    .select()
    .from(milestones)
    .where(where)
    .orderBy(asc(milestones.deadlineAt), asc(milestones.name))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `getMilestoneByIDOrName` — nonzero numeric path ids resolve by id (repo-
 * scoped) and fall through to the case-sensitive name lookup; everything
 * else is a name.
 */
export async function findRepoMilestoneByIdOrName(
  service: IssuesService,
  d1: D1Database,
  repoId: string,
  rawId: string,
): Promise<MilestoneRow | null> {
  const numericId = goParseIntBase0(rawId);
  if (numericId !== 0) {
    const rows = await drizzle(d1)
      .select()
      .from(milestones)
      .where(and(eq(milestones.id, numericId), eq(milestones.repoId, repoId)))
      .limit(1);
    const byId = rows[0];
    if (byId !== undefined) {
      return byId;
    }
  }
  if (rawId === "") {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(milestones)
    .where(and(eq(milestones.name, rawId), eq(milestones.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateMilestoneApiInput {
  title: string;
  description: string;
  /** Already-parsed end-of-day deadline (null = none). */
  deadlineAt: Date | null;
  /** Create-time lifecycle (upstream stamps closed_date_unix = now). */
  state: "open" | "closed";
  now: Date;
}

/**
 * `route CreateMilestone` via the landed service: create, then apply the
 * create-time closed state through the same PATCH path upstream's
 * `form.State == "closed"` branch produces.
 */
export async function createRepoMilestone(
  service: IssuesService,
  repoId: string,
  input: CreateMilestoneApiInput,
): Promise<MilestoneRow> {
  const row = await service.createMilestone({
    repoId,
    name: input.title.trim(), // upstream NewMilestone trims the name
    content: input.description,
    deadlineAt: input.deadlineAt,
    now: input.now,
  });
  if (input.state === "closed") {
    return service.updateMilestone(row.id, { state: "closed", now: input.now });
  }
  return row;
}

export interface EditMilestoneApiPatch {
  /** Applied only when a non-empty string (upstream `len(form.Title) > 0`). */
  title?: string;
  description?: string;
  deadlineAt?: Date | null;
  state?: "open" | "closed";
  now: Date;
}

/** `route EditMilestone` via the landed service (name trimmed, upstream rule). */
export async function editRepoMilestone(
  service: IssuesService,
  id: number,
  patch: EditMilestoneApiPatch,
): Promise<MilestoneRow> {
  const updatePatch: UpdateMilestonePatch = { now: patch.now };
  if (patch.title !== undefined && patch.title.length > 0) {
    updatePatch.name = patch.title.trim();
  }
  if (patch.description !== undefined) {
    updatePatch.content = patch.description;
  }
  if (patch.deadlineAt !== undefined) {
    updatePatch.deadlineAt = patch.deadlineAt;
  }
  if (patch.state !== undefined) {
    updatePatch.state = patch.state;
  }
  return service.updateMilestone(id, updatePatch);
}

/** `deleteMilestone` via the landed service (unlinks the milestone's issues). */
export async function deleteRepoMilestone(service: IssuesService, id: number): Promise<boolean> {
  return service.deleteMilestone(id);
}
