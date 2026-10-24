import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { labels, type LabelRow } from "../../db/schema";
import type { Label } from "../models/label";
import { labelOrderBy, toApiLabel, type LabelSortType } from "./labels";

/**
 * Org-scoped label service — the tier-2 `organization`-tagged label family
 * (orgListLabels / orgCreateLabel / orgGetLabel / orgEditLabel / orgDeleteLabel)
 * over the landed `labels` table's org half (`repo_id IS NULL, org_id > 0`,
 * SPEC-0005 §3.2). The routes live in routes/labels-t2.ts; this module carries
 * the org-scoped queries, the create path and the wire mapping. Behavior
 * authority (upstream submodule pin, cited per function below):
 *
 *   - list/count: `GetLabelsByOrgID` / `CountLabelsByOrgID`
 *     (gitea/models/issues/label.go:497–521, 536–538) — the SAME sort switch
 *     as the repo family (`reversealphabetically` | `leastissues` |
 *     `mostissues`, default name ASC, id ASC tiebreak), total ignoring
 *     pagination;
 *   - lookups: `GetLabelInOrgByID` / `GetLabelInOrgByName`
 *     (models/issues/label.go:453–480) — ids are org-scoped (another org's id
 *     and a repo label's id both 404), the name branch is a case-SENSITIVE
 *     exact match;
 *   - create: `org.CreateLabel` (gitea/routers/api/v1/org/label.go:74–110) —
 *     NormalizeColor (the shared normalizeLabelColor, 422 on failure) then
 *     `NewLabel` with OrgID. The `is_archived` body field is IGNORED here:
 *     upstream builds the Label without an archived stamp
 *     (org/label.go:97–103), unlike repo.CreateLabel's
 *     `l.SetArchived(form.IsArchived)` (repo/label.go:163) — mirrored quirk;
 *   - edit/delete: the shared repo-family primitives apply verbatim —
 *     `UpdateLabel` (models/issues/label.go:262–270) is owner-independent, and
 *     `DeleteOrgLabel` → `deleteLabel` (label.go:278–298) cascades
 *     issue_links + the label system comment rows + the label row; a missing
 *     label deletes zero rows and still succeeds (the route answers 204).
 *     routes/labels-t2.ts calls editRepoLabel/deleteRepoLabel directly.
 *
 * Wire: `convert.ToLabel(label, nil, org.AsUser())`
 * (gitea/services/convert/issue.go:259–287) — the org URL branch,
 * `{AppURL}api/v1/orgs/{name}/labels/{id}`, so the shared toApiLabel works
 * with an org URL base. 404s of this family are the plain "not found"
 * (`org.GetLabel` → APIErrorNotFound, org/label.go:73) — unlike the repo
 * family's detailed `label does not exist [label_id: …, repo_id: …]`.
 */

/** `{origin}/api/v1/orgs/{name}` — the ToLabel org URL base
 * (services/convert/issue.go:276, PathEscape → encodeURIComponent). */
export function apiOrgLabelsUrl(orgName: string, origin: string): string {
  return `${origin}/api/v1/orgs/${encodeURIComponent(orgName)}`;
}

/** `convert.ToLabel` for an org label — color without '#', org-scoped URL. */
export function toApiOrgLabel(row: LabelRow, orgName: string, origin: string): Label {
  return toApiLabel(row, apiOrgLabelsUrl(orgName, origin));
}

/**
 * One page of `GET /orgs/{org}/labels` (`GetLabelsByOrgID`, ordering per the
 * shared labelOrderBy switch — identical to the repo query's) plus the
 * pagination-independent total (`CountLabelsByOrgID`).
 */
export async function listOrgLabels(
  d1: D1Database,
  orgId: number,
  sort: LabelSortType,
  page: number,
  limit: number,
): Promise<{ items: LabelRow[]; total: number }> {
  const where = eq(labels.orgId, orgId);
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

/** `GetLabelInOrgByID` — org-scoped, ids <= 0 never match. */
export async function findOrgLabelById(d1: D1Database, orgId: number, labelId: number): Promise<LabelRow | null> {
  if (labelId <= 0 || orgId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/** `GetLabelInOrgByName` — case-sensitive exact name within the org. */
export async function findOrgLabelByName(d1: D1Database, orgId: number, name: string): Promise<LabelRow | null> {
  if (name.length === 0 || orgId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.name, name), eq(labels.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `GET /orgs/{org}/labels/{id}` resolution (org.GetLabel, org/label.go:57–63):
 * a NUMERIC id looks up by id only; anything else is treated as a
 * (case-sensitive) name — the same shape as the repo family's GET, and
 * PATCH/DELETE stay numeric-only (ctx.PathParamInt64).
 */
export async function findOrgLabelByIdOrName(d1: D1Database, orgId: number, rawId: string): Promise<LabelRow | null> {
  // Go strconv.ParseInt accepts the WHOLE string only ("99abc" is a name).
  if (/^[+-]?\d+$/.test(rawId)) {
    return findOrgLabelById(d1, orgId, Number.parseInt(rawId, 10));
  }
  return findOrgLabelByName(d1, orgId, rawId);
}

export interface CreateOrgLabelInput {
  name: string;
  exclusive: boolean;
  color: string;
  description: string;
}

/**
 * `org.CreateLabel` (org/label.go:97–103) — inserts the org-scoped row
 * (`repo_id` NULL, `org_id` set). There is NO is_archived input: upstream
 * never stamps archived_unix on the org create path (documented quirk).
 */
export async function createOrgLabel(d1: D1Database, orgId: number, input: CreateOrgLabelInput): Promise<LabelRow> {
  const rows = await drizzle(d1)
    .insert(labels)
    .values({
      repoId: null,
      orgId,
      name: input.name,
      exclusive: input.exclusive,
      color: input.color,
      description: input.description,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("org label insert committed without returning rows");
  }
  return row;
}

