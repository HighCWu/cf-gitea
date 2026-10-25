import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, issueLabels, labels, type LabelRow } from "../../db/schema";
import { ApiError } from "../errors";
import type { Label } from "../models/label";

/**
 * Repo-scoped label CRUD backing the tier-1 `issue`-tagged label routes
 * (SPEC-0004 §2.4 rows: issueListLabels / issueCreateLabel / issueGetLabel /
 * issueEditLabel / issueDeleteLabel) on the landed `labels` D1 table.
 *
 * Upstream references mirrored:
 *  - color: `label.NormalizeColor` (gitea/modules/label/label.go:29–51) —
 *    trim + lowercase + implicit leading '#', `^#([0-9a-f]{3}|[0-9a-f]{6})$`,
 *    3-char shorthand expands; failure is the exact 422
 *    `invalid color: <normalized>`. The wire renders the color WITHOUT the
 *    '#" (convert.ToLabel TrimLeft).
 *  - lookups: `GetLabelInRepoByID` / `GetLabelInRepoByName`
 *    (models/issues/label.go) — ids are repo-scoped (another repo's id 404s),
 *    GET falls back to a case-SENSITIVE name match, PATCH/DELETE are
 *    numeric-only.
 *  - archive: `Label.SetArchived` — archiving stamps archived_unix only when
 *    newly archived; unarchiving always clears it.
 *  - delete: `deleteLabel` (models/issues/label.go:282) deletes the
 *    issue_links and the label system comments; a missing label deletes zero
 *    rows and still succeeds → 204.
 */

/**
 * `NormalizeColor` port. Returns the canonical `#rrggbb` form; invalid input
 * throws the upstream 422 with the exact message (the normalized string —
 * trimmed, lowercased, hash added — is what Go's %s prints).
 */
export function normalizeLabelColor(raw: string): string {
  let color = raw.trim().toLowerCase();
  if (color.length === 6 || color.length === 3) {
    color = `#${color}`;
  }
  if (!/^#[\da-f]{3}$/.test(color) && !/^#[\da-f]{6}$/.test(color)) {
    throw new ApiError(422, `invalid color: ${color}`);
  }
  if (color.length === 4) {
    const r = color[1];
    const g = color[2];
    const b = color[3];
    color = `#${r}${r}${g}${g}${b}${b}`;
  }
  return color;
}

/** `convert.ToLabel` for a repo label — color without '#', URL `{repoApiUrl}/labels/{id}`. */
export function toApiLabel(row: LabelRow, repoApiUrl: string): Label {
  return {
    id: row.id,
    name: row.name,
    exclusive: row.exclusive,
    is_archived: row.archivedAt !== null,
    color: (row.color ?? "").replace(/^#+/, ""),
    description: row.description ?? "",
    url: `${repoApiUrl}/labels/${row.id}`,
  };
}

export type LabelSortType = "reversealphabetically" | "leastissues" | "mostissues" | "";

/**
 * `GetLabelsByRepoID` ordering (models/issues/label.go:421–445). `sort` is
 * NOT declared in the contract — upstream reads it silently
 * (`ctx.FormString("sort")`), so the route honors it from the raw query.
 */
export function labelOrderBy(sort: LabelSortType): SQL[] {
  switch (sort) {
    case "reversealphabetically":
      return [desc(labels.name), asc(labels.id)];
    case "leastissues":
      return [sql`${labels.numIssues} - ${labels.numClosedIssues} asc`, asc(labels.id)];
    case "mostissues":
      return [sql`${labels.numIssues} - ${labels.numClosedIssues} desc`, asc(labels.id)];
    default:
      return [asc(labels.name), asc(labels.id)];
  }
}

/** `ListLabels` — repo labels only; total ignores pagination
 * (CountLabelsByRepoID). The org-label NO-union is upstream-shaped at the
 * pin: ListLabels reads GetLabelsByRepoID / CountLabelsByRepoID, both
 * `Where("repo_id = ?")` (routers/api/v1/repo/label.go:52,58 over
 * models/issues/label.go:420-450), and GET /labels/{id} stays repo-scoped
 * (GetLabelInRepoByID/ByName, repo/label.go:102-107). Org labels (repo_id
 * NULL) surface on the ISSUE attach/replace/detach/render arms only —
 * surveyed at the pin, see routes/issues.ts' header and
 * routes/issue-write-t2.ts' GetLabelInRepoOrOrgByID seam. */
export async function listRepoLabels(
  d1: D1Database,
  repoId: string,
  sort: LabelSortType,
  page: number,
  limit: number,
): Promise<{ items: LabelRow[]; total: number }> {
  const where = eq(labels.repoId, repoId);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(labels).where(where);
  const items = await db
    .select()
    .from(labels)
    .where(where)
    .orderBy(...labelOrderBy(sort))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetLabelInRepoByID` — repo-scoped, ids <= 0 never match. */
export async function findRepoLabelById(d1: D1Database, repoId: string, labelId: number): Promise<LabelRow | null> {
  if (labelId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** `GetLabelInRepoByName` — case-sensitive exact name within the repo. */
export async function findRepoLabelByName(d1: D1Database, repoId: string, name: string): Promise<LabelRow | null> {
  if (name.length === 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.name, name), eq(labels.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `GET /labels/{id}` resolution (repo.GetLabel): a NUMERIC id looks up by id
 * only; anything else is treated as a (case-sensitive) name. No fallthrough —
 * unlike the milestone routes.
 */
export async function findRepoLabelByIdOrName(d1: D1Database, repoId: string, rawId: string): Promise<LabelRow | null> {
  // Go strconv.ParseInt accepts the WHOLE string only ("99abc" is a name).
  if (/^[+-]?\d+$/.test(rawId)) {
    return findRepoLabelById(d1, repoId, Number.parseInt(rawId, 10));
  }
  return findRepoLabelByName(d1, repoId, rawId);
}

/** The upstream 404 of GetLabelInRepoByID/ErrRepoLabelNotExist — the message
 * carries the ids (unlike the plain `not found` of most routes). */
export function labelNotExistError(labelId: number, repoId: string): ApiError {
  return new ApiError(404, `label does not exist [label_id: ${labelId}, repo_id: ${repoId}]`);
}

export interface CreateRepoLabelInput {
  name: string;
  exclusive: boolean;
  color: string;
  description: string;
  isArchived: boolean;
  now: Date;
}

/** `NewLabel` (route CreateLabel) — inserts the repo-scoped row. */
export async function createRepoLabel(d1: D1Database, repoId: string, input: CreateRepoLabelInput): Promise<LabelRow> {
  const rows = await drizzle(d1)
    .insert(labels)
    .values({
      repoId,
      name: input.name,
      exclusive: input.exclusive,
      color: input.color,
      description: input.description,
      archivedAt: input.isArchived ? input.now : null,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("label insert committed without returning rows");
  }
  return row;
}

export interface EditRepoLabelPatch {
  /** Absent = keep; a string (even "") replaces. */
  name?: string;
  exclusive?: boolean;
  color?: string;
  description?: string;
  isArchived?: boolean;
  now: Date;
}

/**
 * `route EditLabel` — patch non-nil fields; SetArchived stamps archived_unix
 * only on a NEW archive and clears it on unarchive.
 */
export async function editRepoLabel(d1: D1Database, row: LabelRow, patch: EditRepoLabelPatch): Promise<LabelRow> {
  const set: Partial<typeof labels.$inferInsert> = {
    name: patch.name ?? row.name,
    exclusive: patch.exclusive ?? row.exclusive,
    color: patch.color ?? row.color,
    description: patch.description ?? row.description,
  };
  let archivedAt = row.archivedAt;
  if (patch.isArchived !== undefined) {
    if (!patch.isArchived) {
      archivedAt = null;
    } else if (archivedAt === null) {
      archivedAt = patch.now;
    }
  }
  set.archivedAt = archivedAt;
  const rows = await drizzle(d1).update(labels).set(set).where(eq(labels.id, row.id)).returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("label update committed without returning rows");
  }
  return updated;
}

/**
 * `deleteLabel` (models/issues/label.go:282–299) in one batch: the issue
 * links, the label system comment ROWS (upstream deletes them, not nulls
 * them), then the label row. Missing labels delete nothing and still succeed
 * (route answers 204).
 */
export async function deleteRepoLabel(d1: D1Database, row: LabelRow): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).delete(issueLabels).where(eq(issueLabels.labelId, row.id)),
    drizzle(d1).delete(comments).where(eq(comments.labelId, row.id)),
    drizzle(d1).delete(labels).where(eq(labels.id, row.id)),
  ]);
}
