import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  issues,
  labels,
  orgMembers,
  projectColumns,
  projectIssues,
  projectWorkflows,
  projects,
  repositories,
  teamMembers,
  teams,
  users,
} from "../../db/schema";
import { ellipsisDisplayString } from "../../issues/service";
import type { IssueRow } from "../../issues/service";
import { ApiError } from "../errors";
import type {
  CreateProjectColumnOption,
  CreateProjectOption,
  CreateProjectWorkflowOption,
  EditProjectColumnOption,
  EditProjectWorkflowOption,
  ProjectColumn,
  ProjectWorkflow,
  Project,
  ProjectWorkflowActions,
  ProjectWorkflowFilters,
} from "../models/project";
import type { User } from "../models/user";
import { OrgService } from "../../services/orgs/orgs";
import { apiUserFromRow, canViewRepositoryWithTeams, type RepositoryWithOwner, type Viewer } from "./repository";

/**
 * The shared project-board store backing the repo-scoped project API
 * (batch 6 stage 1 — routes/projects-repo.ts) and, verbatim, the org/user
 * scopes of stages 2/3. Upstream mirrored at the pinned commit:
 *  - models:    gitea/models/project/{project,column,issue,workflows}.go
 *  - handlers:  gitea/routers/api/v1/shared/{project,project_workflow}.go
 *  - services:  gitea/services/projects/{project,issue,workflow}.go
 *  - convert:   gitea/services/convert/project.go
 *
 * Every failure carries upstream's exact `APIErrorAuto` message — the
 * errorForUser mapping (modules/util/error.go:25-31) renders the WRAPPED
 * error's own text with its code: ErrNotExist family → 404,
 * ErrUnprocessableContent → 422, ErrPermissionDenied → 403.
 *
 * Scope model: `ProjectScope` identifies whose projects a route operates on
 * (upstream projectScope, shared/project.go:28-65). Repository scope keys on
 * the landed TEXT repositories.id; owner scopes key on users.id. Exactly one
 * of repoId/ownerId is set.
 *
 * DEVIATIONS (documented, none wire-visible in the repo scope):
 *  - upstream maintains `repository.num_projects`/`num_closed_projects`
 *    counters (project.go:282,359-379); the landed repositories table has no
 *    such columns — not maintained (nothing in the contract renders them).
 *  - upstream's project/move system comments (CommentType 30/31) have
 *    dedicated int64 columns (`old_project_id`, `project_id`,
 *    `project_column_id`, `project_column_title`, models/issues/comment.go);
 *    the landed comments table does not carry them, so the ids serialize
 *    into `content` as JSON — the established adaptation (type 29
 *    PullRequestPush stores PushActionContent JSON the same way). The rows,
 *    timestamps and the issue.updated_unix bump follow upstream
 *    updateCommentInfos (comment.go:937-948: system comments do NOT bump
 *    num_comments but DO touch updated_unix).
 *  - workflow execution (the notifier reacting to item events,
 *    services/projects/workflow_notifier.go) and the workflow audit trail
 *    (services/projects/workflow.go recordWorkflowAudit) are out of this
 *    batch's scope — only the CRUD surface exists here.
 */

// ---------------------------------------------------------------------------
// Scope + row types + errors
// ---------------------------------------------------------------------------

/** The drizzle D1 batch statement shape (the services/issues.ts alias). */
type BatchStatement = Parameters<ReturnType<typeof drizzle>["batch"]>[number][number];

/** D1 rows (feature-module derivation — the schema.ts RepositoryRow precedent). */
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectColumnRow = typeof projectColumns.$inferSelect;
export type ProjectIssueRow = typeof projectIssues.$inferSelect;
export type ProjectWorkflowRow = typeof projectWorkflows.$inferSelect;

/** Upstream `projectScope` (routers/api/v1/shared/project.go:28-65). */
export interface ProjectScope {
  /** Upstream project.Type: 1 individual / 2 repository / 3 organization. */
  kind: "individual" | "repository" | "organization";
  /** TEXT repositories.id — set iff kind is "repository". */
  repoId: string | null;
  /** users.id of the owning user/org — set iff kind is not "repository". */
  ownerId: number | null;
}

/** The repo scope this batch mounts (stages 2/3 add the owner scopes). */
export function repoProjectScope(repoId: string): ProjectScope {
  return { kind: "repository", repoId, ownerId: null };
}

/** `ErrProjectNotExist` — 404 "projects does not exist [id: N]". */
export function projectNotExistError(id: number): ApiError {
  return new ApiError(404, `projects does not exist [id: ${id}]`);
}

/** `ErrProjectColumnNotExist` — 404 "project column does not exist [id: N]". */
export function projectColumnNotExistError(id: number): ApiError {
  return new ApiError(404, `project column does not exist [id: ${id}]`);
}

/** `db.ErrNotExist{Resource: "ProjectWorkflow"}` — 404 with upstream's text. */
export function projectWorkflowNotExistError(id: number): ApiError {
  return new ApiError(404, `ProjectWorkflow does not exist [id: ${id}]`);
}

/** `ErrIssueNotExist` via GetIssueByRepoID — 404 with the full triple. */
export function projectIssueNotExistError(issueId: number, repoId: string): ApiError {
  return new ApiError(404, `issue does not exist [id: ${issueId}, repo_id: ${repoIdNumber(repoId)}, index: 0]`);
}

/** Numeric rendering of the text registry id (services/issues.ts rule). */
function repoIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Enum maps (convert/project.go:20-75)
// ---------------------------------------------------------------------------

/** TemplateType ↔ wire strings. Invalid input on create is the exact 422. */
export function templateTypeToString(value: number): "none" | "basic_kanban" | "bug_triage" {
  if (value === 1) return "basic_kanban";
  if (value === 2) return "bug_triage";
  return "none";
}

export function templateTypeFromString(raw: string): number {
  if (raw === "" || raw === "none") return 0;
  if (raw === "basic_kanban") return 1;
  if (raw === "bug_triage") return 2;
  throw new ApiError(422, `invalid template_type ${JSON.stringify(raw)} (expected none, basic_kanban, bug_triage)`);
}

/** CardType ↔ wire strings. */
export function cardTypeToString(value: number): "text_only" | "images_and_text" {
  return value === 1 ? "images_and_text" : "text_only";
}

export function cardTypeFromString(raw: string): number {
  if (raw === "" || raw === "text_only") return 0;
  if (raw === "images_and_text") return 1;
  throw new ApiError(422, `invalid card_type ${JSON.stringify(raw)} (expected text_only, images_and_text)`);
}

/** project.Type ↔ wire string (unknown renders "" — unreachable via inserts). */
export function projectTypeToString(value: number): "individual" | "repository" | "organization" | "" {
  if (value === 1) return "individual";
  if (value === 2) return "repository";
  if (value === 3) return "organization";
  return "";
}

/** scope.kind → project.Type int. */
export function projectTypeFromKind(kind: ProjectScope["kind"]): number {
  return kind === "individual" ? 1 : kind === "repository" ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** `ParseIssueFilterStateIsClosed` (routers/common/issue_filter.go:16-27). */
export function parseProjectStateFilter(state: string | null): boolean | null {
  if (state === "all") return null;
  if (state === "closed") return true;
  return false; // "", "open", unknown → open (upstream: unknown is undefined behavior)
}

/**
 * `projectScope.findProject` — id scoped to the owner: another owner's id
 * reads as not found (GetProjectForRepoByID / GetProjectByIDAndOwner).
 */
export async function findProjectById(d1: D1Database, scope: ProjectScope, id: number): Promise<ProjectRow | null> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const where =
    scope.repoId !== null
      ? and(eq(projects.id, id), eq(projects.repoId, scope.repoId))
      : and(eq(projects.id, id), eq(projects.ownerId, scope.ownerId ?? 0));
  const rows = await drizzle(d1)
    .select()
    .from(projects)
    .where(where)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `ListProjects` — scope-filtered, `state` filtered (default open), ordered
 * `id DESC` (SearchOrderByIDReverse: unique, so pagination cannot repeat or
 * skip rows). Total ignores pagination (FindAndCount).
 */
export async function listProjects(
  d1: D1Database,
  scope: ProjectScope,
  isClosed: boolean | null,
  page: number,
  limit: number,
): Promise<{ items: ProjectRow[]; total: number }> {
  const conditions: SQL[] = [
    scope.repoId !== null ? eq(projects.repoId, scope.repoId) : eq(projects.ownerId, scope.ownerId ?? 0),
  ];
  if (isClosed !== null) {
    conditions.push(eq(projects.isClosed, isClosed));
  }
  const where = and(...conditions) as SQL;
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(projects).where(where);
  const items = await db
    .select()
    .from(projects)
    .where(where)
    .orderBy(desc(projects.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `LoadIssueNumbersForProject`'s repository branch (ownerId === 0,
 * services/projects/issue.go:298-309) — plain joined counts, no permission
 * filtering (route visibility already covers every member issue).
 * `project_issue` joins `issue` so rows whose issue vanished do not count.
 */
export async function projectIssueCounts(
  d1: D1Database,
  projectId: number,
): Promise<{ open: number; closed: number; total: number }> {
  const rows = await drizzle(d1)
    .select({ closed: issues.isClosed, value: sql<number>`count(*)` })
    .from(projectIssues)
    .innerJoin(issues, eq(projectIssues.issueId, issues.id))
    .where(eq(projectIssues.projectId, projectId))
    .groupBy(issues.isClosed);
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    if (row.closed) {
      closed = Number(row.value);
    } else {
      open = Number(row.value);
    }
  }
  return { open, closed, total: open + closed };
}

export interface CreateProjectInput extends CreateProjectOption {
  creatorId: number;
  now: Date;
}

/**
 * `project_model.NewProject` (project.go:261-289): invalid enum inputs fall
 * back to their zero value (the route already rejected them), the title
 * truncates to 255 display-width chars, and a non-`none` template copies the
 * default column set (createDefaultColumnsForProject, column.go:95-137):
 * a "Backlog" default column FIRST, then the template's columns, all with
 * sorting 0 (insertion order breaks ties via `sorting, id`).
 */
export async function createProject(d1: D1Database, scope: ProjectScope, input: CreateProjectInput): Promise<ProjectRow> {
  const templateType = templateTypeFromString(input.template_type ?? "");
  const cardType = cardTypeFromString(input.card_type ?? "");
  const rows = await drizzle(d1)
    .insert(projects)
    .values({
      title: ellipsisDisplayString(input.title, 255),
      description: input.description ?? "",
      ownerId: scope.ownerId ?? 0,
      repoId: scope.repoId ?? "",
      creatorId: input.creatorId,
      boardType: templateType,
      cardType,
      type: projectTypeFromKind(scope.kind),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("project insert committed without returning rows");
  }
  await createDefaultColumns(d1, row, templateType, input.now);
  return row;
}

/** `createDefaultColumnsForProject` — the default column set per template. */
const BASIC_KANBAN_COLUMNS = ["To Do", "In Progress", "Done"];
const BUG_TRIAGE_COLUMNS = ["Needs Triage", "High Priority", "Low Priority", "Closed"];

async function createDefaultColumns(d1: D1Database, project: ProjectRow, templateType: number, now: Date): Promise<void> {
  if (templateType === 0) {
    return; // TemplateTypeNone copies nothing
  }
  const items = templateType === 1 ? BASIC_KANBAN_COLUMNS : BUG_TRIAGE_COLUMNS;
  // One batch: "Backlog" (the default landing column) then the template set.
  // All carry sorting 0 — upstream inserts directly (column.go:109-136), so
  // ordering falls to `sorting, id` = insertion order.
  await drizzle(d1).insert(projectColumns).values([
    { title: "Backlog", isDefault: true, projectId: project.id, creatorId: project.creatorId, createdAt: now, updatedAt: now },
    ...items.map((title) => ({ title, projectId: project.id, creatorId: project.creatorId, createdAt: now, updatedAt: now })),
  ]);
}

export interface UpdateProjectPatch {
  /** Absent/null = keep (the tri-state pointer rule). */
  title?: string;
  description?: string;
  cardType?: number;
  now: Date;
}

/**
 * `project_service.UpdateProject` (services/projects/project.go:23-37) —
 * unset fields keep the row value; the update writes title/description/
 * card_type and bumps updated_unix (xorm `updated`). CardType validity was
 * already enforced by the caller's enum parse (the service's own fallback to
 * text_only is unreachable via the API).
 */
export async function updateProject(d1: D1Database, row: ProjectRow, patch: UpdateProjectPatch): Promise<ProjectRow> {
  const rows = await drizzle(d1)
    .update(projects)
    .set({
      title: ellipsisDisplayString(patch.title ?? row.title, 255),
      description: patch.description ?? row.description,
      cardType: patch.cardType ?? row.cardType,
      updatedAt: patch.now,
    })
    .where(eq(projects.id, row.id))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("project update committed without returning rows");
  }
  return updated;
}

/**
 * `changeProjectStatus` (project.go:404-416): the is_closed flip is guarded
 * on the OLD value, so a no-op PATCH (state already == target) changes
 * nothing — including the closed_date_unix stamp, which is set on EVERY
 * real transition (close AND reopen). Not part of the model's
 * `updated_unix` write (upstream updates only is_closed/closed_date_unix).
 */
export async function changeProjectStatus(d1: D1Database, row: ProjectRow, isClosed: boolean, now: Date): Promise<ProjectRow> {
  if (row.isClosed === isClosed) {
    return row;
  }
  const rows = await drizzle(d1)
    .update(projects)
    .set({ isClosed, closedAtUnix: now })
    .where(and(eq(projects.id, row.id), eq(projects.isClosed, row.isClosed)))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    return row; // lost a concurrent transition — the flip already happened
  }
  return updated;
}

/**
 * `DeleteProjectByID` (project.go:420-448) in one batch: the memberships,
 * the columns, the workflows, then the project row. A missing project
 * deletes nothing and still succeeds (the route already resolved it).
 */
export async function deleteProjectById(d1: D1Database, projectId: number): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db.delete(projectIssues).where(eq(projectIssues.projectId, projectId)),
    db.delete(projectColumns).where(eq(projectColumns.projectId, projectId)),
    db.delete(projectWorkflows).where(eq(projectWorkflows.projectId, projectId)),
    db.delete(projects).where(eq(projects.id, projectId)),
  ]);
}

// ---------------------------------------------------------------------------
// Columns (upstream table `project_board`)
// ---------------------------------------------------------------------------

/** `GetColumns` ordering (`sorting, id`, column_list.go:20), paginated. */
export async function listColumns(
  d1: D1Database,
  projectId: number,
  page: number,
  limit: number,
): Promise<{ items: ProjectColumnRow[]; total: number }> {
  const where = eq(projectColumns.projectId, projectId);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(projectColumns).where(where);
  const items = await db
    .select()
    .from(projectColumns)
    .where(where)
    .orderBy(asc(projectColumns.sorting), asc(projectColumns.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetColumnByIDAndProjectID` — the column must belong to THIS project. */
export async function findColumnByIdAndProject(
  d1: D1Database,
  columnId: number,
  projectId: number,
): Promise<ProjectColumnRow | null> {
  if (!Number.isSafeInteger(columnId) || columnId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(projectColumns)
    .where(and(eq(projectColumns.id, columnId), eq(projectColumns.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Upstream `ColumnColorPattern` (column.go:39) — "" is valid (no color). */
export function validateColumnColor(color: string): void {
  if (color.length !== 0 && !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new ApiError(422, `invalid column color ${JSON.stringify(color)}, expected a 6-digit hex string like #FF0000`);
  }
}

/** maxProjectColumns (column.go:141) — sorting is int8 in the database. */
const MAX_PROJECT_COLUMNS = 127;

export interface CreateColumnInput extends CreateProjectColumnOption {
  creatorId: number;
  now: Date;
}

/**
 * `NewColumn` (column.go:144-165): color validated first (422), title
 * truncated, the 127-column cap (422 "maximum number of columns reached"),
 * sorting = `min(max(sorting)+1, 127)` — or 0 for the first column
 * (MaxInt8+1 would wrap the append to the front).
 */
export async function createColumn(d1: D1Database, projectId: number, input: CreateColumnInput): Promise<ProjectColumnRow> {
  const color = input.color ?? "";
  validateColumnColor(color);
  const title = ellipsisDisplayString(input.title, 255);
  const agg = await drizzle(d1)
    .select({
      maxSorting: sql<number | null>`max(${projectColumns.sorting})`,
      columnCount: sql<number>`count(*)`,
    })
    .from(projectColumns)
    .where(eq(projectColumns.projectId, projectId));
  const columnCount = Number(agg[0]?.columnCount ?? 0);
  if (columnCount >= MAX_PROJECT_COLUMNS) {
    throw new ApiError(422, "maximum number of columns reached");
  }
  const maxSorting = agg[0]?.maxSorting === null || agg[0]?.maxSorting === undefined ? 0 : Number(agg[0].maxSorting);
  const sorting = columnCount > 0 ? Math.min(maxSorting + 1, 127) : 0;
  const rows = await drizzle(d1)
    .insert(projectColumns)
    .values({
      title,
      color,
      projectId,
      creatorId: input.creatorId,
      sorting,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("column insert committed without returning rows");
  }
  return row;
}

export interface EditColumnPatch extends Pick<EditProjectColumnOption, "title" | "color" | "sorting"> {
  now: Date;
}

/**
 * `route EditProjectColumn` + `UpdateColumn` (column.go:244-251): patch the
 * provided fields (tri-state), validate the resulting color, truncate the
 * title, write title/sorting/color + updated_unix.
 */
export async function updateColumn(d1: D1Database, row: ProjectColumnRow, patch: EditColumnPatch): Promise<ProjectColumnRow> {
  const title = patch.title ?? row.title;
  const color = patch.color ?? row.color;
  validateColumnColor(color);
  const sorting = patch.sorting ?? row.sorting;
  const rows = await drizzle(d1)
    .update(projectColumns)
    .set({ title: ellipsisDisplayString(title, 255), color, sorting, updatedAt: patch.now })
    .where(eq(projectColumns.id, row.id))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("column update committed without returning rows");
  }
  return updated;
}

/**
 * `MustDefaultColumn` (column.go:290-310): the flagged default column (newest
 * id wins), else the first column by `sorting, id` is ELEVATED to default,
 * else an "Uncategorized" column is created as the default.
 */
export async function mustDefaultColumn(
  d1: D1Database,
  project: ProjectRow,
  now: Date,
): Promise<ProjectColumnRow> {
  const flagged = await drizzle(d1)
    .select()
    .from(projectColumns)
    .where(and(eq(projectColumns.projectId, project.id), eq(projectColumns.isDefault, true)))
    .orderBy(desc(projectColumns.id))
    .limit(1);
  const flaggedRow = flagged[0];
  if (flaggedRow !== undefined) {
    return flaggedRow;
  }
  const first = await drizzle(d1)
    .select()
    .from(projectColumns)
    .where(eq(projectColumns.projectId, project.id))
    .orderBy(asc(projectColumns.sorting), asc(projectColumns.id))
    .limit(1);
  const firstRow = first[0];
  if (firstRow !== undefined) {
    if (!firstRow.isDefault) {
      await drizzle(d1)
        .update(projectColumns)
        .set({ isDefault: true })
        .where(eq(projectColumns.id, firstRow.id));
      return { ...firstRow, isDefault: true };
    }
    return firstRow;
  }
  const rows = await drizzle(d1)
    .insert(projectColumns)
    .values({
      title: "Uncategorized",
      isDefault: true,
      projectId: project.id,
      creatorId: project.creatorId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const created = rows[0];
  if (created === undefined) {
    throw new Error("default column insert committed without returning rows");
  }
  return created;
}

/** `errColumnIsDefault` — 422 (column.go:174-176). */
function columnIsDefaultError(): ApiError {
  return new ApiError(422, "cannot delete the default column");
}

/**
 * `DeleteColumnByID` (column.go:168-210): the default column is undeletable
 * (422); any other column has its issues MOVED to the project's default
 * column (MustDefaultColumn, creating "Uncategorized" if needed) before the
 * row goes. Not-found deletes nothing and still succeeds (upstream returns
 * nil; the route already 404'd).
 */
export async function deleteColumnById(d1: D1Database, column: ProjectColumnRow, now: Date): Promise<void> {
  if (column.isDefault) {
    throw columnIsDefaultError();
  }
  const projectRows = await drizzle(d1).select().from(projects).where(eq(projects.id, column.projectId)).limit(1);
  const project = projectRows[0];
  if (project === undefined) {
    return; // orphaned column — nothing to move into; just remove it below
  }
  const defaultColumn = await mustDefaultColumn(d1, project, now);
  await moveColumnsIssues(d1, column, defaultColumn);
  await drizzle(d1).delete(projectColumns).where(eq(projectColumns.id, column.id));
}

/** `SetDefaultColumn` (column.go:313-331): clear the old flag, set the new. */
export async function setDefaultColumn(d1: D1Database, projectId: number, columnId: number, now: Date): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db
      .update(projectColumns)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(projectColumns.projectId, projectId), eq(projectColumns.isDefault, true))),
    db
      .update(projectColumns)
      .set({ isDefault: true, updatedAt: now })
      .where(and(eq(projectColumns.id, columnId), eq(projectColumns.projectId, projectId))),
  ]);
}

/**
 * `route MoveProjectColumns` — the body must list EVERY column of the
 * project exactly once, in any order (util.SliceSortedEqual,
 * modules/util/slice.go:23-41 — an order-INSENSITIVE multiset equality;
 * the body's order is the new left-to-right order the route writes back,
 * MoveColumnsOnProject's position → id map), else the exact 422.
 */
export function assertColumnsReorderedExactly(columnIds: number[], existing: ProjectColumnRow[]): void {
  const existingIds = existing.map((column) => column.id);
  if (!sameIdMultiset(columnIds, existingIds)) {
    throw new ApiError(422, "column_ids must list every column of the project exactly once");
  }
}

/** util.SliceSortedEqual for column ids: equal length, equal value counts. */
function sameIdMultiset(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const counts = new Map<number, number>();
  for (const id of a) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of b) {
    const count = counts.get(id);
    if (count === undefined || count === 0) {
      return false;
    }
    counts.set(id, count - 1);
  }
  return true; // equal lengths + every decrement matched ⇒ all counts zero
}

/**
 * `MoveColumnsOnProject` (column.go:334-364): write each position. The raw
 * upstream UPDATE does not touch `updated_unix` (xorm raw exec) — mirrored:
 * only `sorting` moves.
 */
export async function moveColumns(d1: D1Database, columnIds: number[]): Promise<void> {
  if (columnIds.length === 0) {
    return;
  }
  const db = drizzle(d1);
  const statements = columnIds.map((columnId, position) =>
    db
      .update(projectColumns)
      .set({ sorting: position })
      .where(eq(projectColumns.id, columnId)),
  ) as BatchStatement[];
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
}

// ---------------------------------------------------------------------------
// Column issues
// ---------------------------------------------------------------------------

/** `columnIssueIDs` (issue.go:39-44): the default column also claims the
 *  legacy 0 rows. */
function columnClaimedColumnIds(column: ProjectColumnRow): number[] {
  return column.isDefault ? [column.id, 0] : [column.id];
}

/** `GetColumnIssueIDs` — the issue ids placed in a column. */
export async function columnIssueIds(d1: D1Database, column: ProjectColumnRow): Promise<number[]> {
  const rows = await drizzle(d1)
    .select({ issueId: projectIssues.issueId })
    .from(projectIssues)
    .where(
      and(
        eq(projectIssues.projectId, column.projectId),
        inArray(projectIssues.projectColumnId, columnClaimedColumnIds(column)),
      ),
    );
  return rows.map((row) => row.issueId);
}

/** `IsIssueInColumn` (issue.go:47-53). */
export async function issueInColumn(d1: D1Database, issueId: number, column: ProjectColumnRow): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: projectIssues.id })
    .from(projectIssues)
    .where(
      and(
        eq(projectIssues.issueId, issueId),
        eq(projectIssues.projectId, column.projectId),
        inArray(projectIssues.projectColumnId, columnClaimedColumnIds(column)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** `GetIssueByRepoID` — the GLOBAL issue id within the route's repo. */
export async function findIssueByIdInRepo(d1: D1Database, repoId: string, issueId: number): Promise<IssueRow | null> {
  if (!Number.isSafeInteger(issueId) || issueId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `ListProjectColumnIssues` (shared/project.go:1657-1708, repo arm): the
 * column's issues joined with `project_issue` so the column sorting applies
 * (`project-column-sorting`: `project_issue.sorting ASC, created_unix DESC,
 * id DESC`, issue_search.go:125-126), repo-filtered and paginated.
 */
export async function listColumnIssues(
  d1: D1Database,
  repoId: string,
  projectId: number,
  column: ProjectColumnRow,
  page: number,
  limit: number,
): Promise<{ items: IssueRow[]; total: number }> {
  // The default column's [id, 0] claim can match a project_issue row twice
  // only in degenerate data (both values equal) — IN deduplicates anyway.
  const claimedIssueIds = await columnIssueIds(d1, column);
  if (claimedIssueIds.length === 0) {
    return { items: [], total: 0 };
  }
  const where = and(
    eq(issues.repoId, repoId),
    inArray(issues.id, claimedIssueIds),
  ) as SQL;
  // The join repeats the project filter (upstream ProjectIDs "joins
  // project_issue so the column sorting applies"); exactly one project_issue
  // row per (issue, project) participates.
  const joinCondition = and(
    eq(projectIssues.issueId, issues.id),
    eq(projectIssues.projectId, projectId),
  ) as SQL;
  const db = drizzle(d1);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(issues)
    .innerJoin(projectIssues, joinCondition)
    .where(where);
  const items = await db
    .select({ issue: issues })
    .from(issues)
    .innerJoin(projectIssues, joinCondition)
    .where(where)
    .orderBy(asc(projectIssues.sorting), desc(issues.createdAt), desc(issues.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items: items.map((row) => row.issue), total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetColumnIssueNextSorting` (issue.go:65-78): append position. */
async function columnIssueNextSorting(d1: D1Database, column: ProjectColumnRow): Promise<number> {
  const agg = await drizzle(d1)
    .select({
      maxSorting: sql<number | null>`max(${projectIssues.sorting})`,
      issueCount: sql<number>`count(*)`,
    })
    .from(projectIssues)
    .where(
      and(
        eq(projectIssues.projectId, column.projectId),
        inArray(projectIssues.projectColumnId, columnClaimedColumnIds(column)),
      ),
    );
  const issueCount = Number(agg[0]?.issueCount ?? 0);
  if (issueCount === 0) {
    return 0;
  }
  return agg[0]?.maxSorting === null || agg[0]?.maxSorting === undefined ? 0 : Number(agg[0].maxSorting) + 1;
}

/** The `project_issue` row of (issue, project), or null. */
async function projectIssueRow(d1: D1Database, issueId: number, projectId: number): Promise<ProjectIssueRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(projectIssues)
    .where(and(eq(projectIssues.issueId, issueId), eq(projectIssues.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The system comment the project arms write (adaptation: ids in `content`
 * JSON — see the module header). Types 30/31 do NOT bump `num_comments`
 * (upstream updateCommentInfos, comment.go:937-948) but DO bump the issue's
 * `updated_unix`.
 */
async function writeProjectComment(
  d1: D1Database,
  type: 30 | 31,
  issueId: number,
  posterId: number | null,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const db = drizzle(d1);
  await db.batch([
    db.insert(comments).values({
      type,
      posterId,
      issueId,
      content: JSON.stringify(payload),
      createdAt: now,
      updatedAt: now,
    }),
    db.update(issues).set({ updatedAt: now }).where(eq(issues.id, issueId)),
  ]);
}

/** `moveIssuesToAnotherColumn` (issue.go:80-111): the column's issues move
 *  to the END of the target column, order preserved (`sorting, id`). */
async function moveColumnsIssues(
  d1: D1Database,
  from: ProjectColumnRow,
  to: ProjectColumnRow,
): Promise<void> {
  if (from.id === to.id) {
    return;
  }
  const moved = await drizzle(d1)
    .select()
    .from(projectIssues)
    .where(
      and(
        eq(projectIssues.projectId, from.projectId),
        inArray(projectIssues.projectColumnId, columnClaimedColumnIds(from)),
      ),
    )
    .orderBy(asc(projectIssues.sorting), asc(projectIssues.id));
  if (moved.length === 0) {
    return;
  }
  let nextSorting = await columnIssueNextSorting(d1, to);
  const db = drizzle(d1);
  const statements = moved.map((row) =>
    db
      .update(projectIssues)
      .set({ projectColumnId: to.id, sorting: nextSorting++ })
      .where(eq(projectIssues.id, row.id)),
  ) as BatchStatement[];
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
}

/**
 * `project_service.AddIssueToColumn` (services/projects/issue.go:28-49):
 * assigns the issue to the column's project first when new (landing row in
 * the default column at its next sorting), then places it in the requested
 * column (append). One batch per step; a failure cannot strand the row in
 * the default column because the assign only happens when the move's inputs
 * are already known.
 */
export async function addIssueToColumn(
  d1: D1Database,
  project: ProjectRow,
  issue: IssueRow,
  column: ProjectColumnRow,
  doerId: number,
  now: Date,
): Promise<void> {
  const membership = await projectIssueRow(d1, issue.id, project.id);
  if (membership === null) {
    // IssueAssignOrRemoveProject's add arm (issue_project.go:103-148):
    // land in the default column at its next sorting.
    const defaultColumn = await mustDefaultColumn(d1, project, now);
    const nextSorting = await columnIssueNextSorting(d1, defaultColumn);
    await drizzle(d1)
      .insert(projectIssues)
      .values({
        issueId: issue.id,
        projectId: project.id,
        projectColumnId: defaultColumn.id,
        sorting: nextSorting,
      });
    await writeProjectComment(d1, 30, issue.id, doerId, { old_project_id: 0, project_id: project.id }, now);
  }
  await moveIssueWithinProject(d1, project, issue, column, null, doerId, now);
}

/**
 * `project_service.RemoveIssueFromColumn` (services/projects/issue.go:78-99):
 * the issue must be in the column (404 "issue N is not in column M"
 * otherwise), then the project membership row goes with a
 * CommentTypeProject removal comment.
 */
export async function removeIssueFromColumn(
  d1: D1Database,
  project: ProjectRow,
  issue: IssueRow,
  column: ProjectColumnRow,
  doerId: number,
  now: Date,
): Promise<void> {
  const exists = await issueInColumn(d1, issue.id, column);
  if (!exists) {
    throw new ApiError(404, `issue ${issue.id} is not in column ${column.id}`);
  }
  await drizzle(d1)
    .delete(projectIssues)
    .where(and(eq(projectIssues.issueId, issue.id), eq(projectIssues.projectId, project.id)));
  await writeProjectComment(d1, 30, issue.id, doerId, { old_project_id: project.id, project_id: 0 }, now);
}

/**
 * `project_service.MoveIssueToColumn` + `moveIssuesOnProjectColumn`
 * (services/projects/issue.go:53-73,124-206): the issue must ALREADY be a
 * project member (422 "all issues have to be added to a project first"),
 * the column switch writes (project_column_id, sorting) scoped to
 * (issue_id, project_id) — the upstream IMPORTANT clause: a move in one
 * project must not touch the issue's row in another project — and a real
 * column change writes the CommentTypeProjectColumn comment. Legacy-0 rows
 * resolve their old column through the default column.
 */
export async function moveIssueToColumn(
  d1: D1Database,
  project: ProjectRow,
  issue: IssueRow,
  column: ProjectColumnRow,
  sorting: number | null,
  doerId: number,
  now: Date,
): Promise<void> {
  const membership = await projectIssueRow(d1, issue.id, project.id);
  if (membership === null) {
    throw new ApiError(422, "all issues have to be added to a project first");
  }
  await moveIssueWithinProject(d1, project, issue, column, sorting, doerId, now);
}

async function moveIssueWithinProject(
  d1: D1Database,
  project: ProjectRow,
  issue: IssueRow,
  column: ProjectColumnRow,
  sorting: number | null,
  doerId: number,
  now: Date,
): Promise<void> {
  const membership = await projectIssueRow(d1, issue.id, project.id);
  if (membership === null) {
    // Only reachable when a concurrent remove raced the caller's membership
    // check — the same 422 upstream's count guard produces.
    throw new ApiError(422, "all issues have to be added to a project first");
  }
  const position = sorting ?? (await columnIssueNextSorting(d1, column));
  let oldColumnId = membership.projectColumnId;
  if (oldColumnId === 0) {
    // Legacy encoding of the default column (services/projects/issue.go:169-176).
    const defaultColumn = await mustDefaultColumn(d1, project, now);
    oldColumnId = defaultColumn.id;
  }
  await drizzle(d1)
    .update(projectIssues)
    .set({ projectColumnId: column.id, sorting: position })
    .where(and(eq(projectIssues.issueId, issue.id), eq(projectIssues.projectId, project.id)));
  if (oldColumnId !== column.id) {
    await writeProjectComment(
      d1,
      31,
      issue.id,
      doerId,
      { project_id: project.id, project_column_id: column.id, project_column_title: column.title },
      now,
    );
  }
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** The eight WorkflowEvent values (workflows.go:21-29) with their
 *  filter/action capabilities (workflows.go:110-133). */
const WORKFLOW_CAPABILITIES: Record<string, { filters: string[]; actions: string[] }> = {
  item_added_to_project: {
    filters: ["issue_type", "labels"],
    actions: ["column", "add_labels", "remove_labels", "issue_state"],
  },
  item_removed_from_project: {
    filters: ["issue_type", "labels"],
    actions: ["add_labels", "remove_labels", "issue_state"],
  },
  item_reopened: {
    filters: ["issue_type", "labels"],
    actions: ["column", "add_labels", "remove_labels"],
  },
  item_closed: {
    filters: ["issue_type", "labels"],
    actions: ["column", "add_labels", "remove_labels"],
  },
  item_column_changed: {
    filters: ["issue_type", "source_column", "target_column", "labels"],
    actions: ["add_labels", "remove_labels", "issue_state"],
  },
  code_changes_requested: {
    filters: ["labels"],
    actions: ["column", "add_labels", "remove_labels"],
  },
  code_review_approved: {
    filters: ["labels"],
    actions: ["column", "add_labels", "remove_labels"],
  },
  pull_request_merged: {
    filters: ["labels"],
    actions: ["column", "add_labels", "remove_labels"],
  },
};

/** `WorkflowFilters.Types()` — present filters (non-zero). */
function filterTypes(filters: ProjectWorkflowFilters): string[] {
  const types: string[] = [];
  if (filters.issue_type) types.push("issue_type");
  if (filters.source_column_id) types.push("source_column");
  if (filters.target_column_id) types.push("target_column");
  if ((filters.label_ids?.length ?? 0) > 0) types.push("labels");
  return types;
}

/** `WorkflowActions.Types()`. */
function actionTypes(actions: ProjectWorkflowActions): string[] {
  const types: string[] = [];
  if (actions.column_id) types.push("column");
  if ((actions.add_label_ids?.length ?? 0) > 0) types.push("add_labels");
  if ((actions.remove_label_ids?.length ?? 0) > 0) types.push("remove_labels");
  if (actions.issue_state) types.push("issue_state");
  return types;
}

/** `uniqueIDs` — sorted + deduplicated (services/projects/workflow.go:194-196). */
function uniqueIds(ids: number[] | undefined): number[] {
  return [...new Set(ids ?? [])].sort((a, b) => a - b);
}

/**
 * `GetProjectLabels` (services/projects/label.go:11-34): repository
 * projects read the repo's labels PLUS the owner org's labels; owner-level
 * projects read the owner's org labels only (an individual owner has none —
 * upstream queries GetLabelsByOrgID against a plain user id the same way).
 */
export async function projectLabels(d1: D1Database, scope: ProjectScope, repoOwnerId: number | null): Promise<Set<number>> {
  const conditions: SQL[] = [];
  if (scope.repoId !== null) {
    conditions.push(eq(labels.repoId, scope.repoId));
    if (repoOwnerId !== null) {
      conditions.push(and(eq(labels.orgId, repoOwnerId), sql`${labels.repoId} IS NULL`) as SQL);
    }
  } else {
    conditions.push(and(eq(labels.orgId, scope.ownerId ?? 0), sql`${labels.repoId} IS NULL`) as SQL);
  }
  const rows = await drizzle(d1)
    .select({ id: labels.id })
    .from(labels)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));
  return new Set(rows.map((row) => row.id));
}

/**
 * `setWorkflowRules` (services/projects/workflow.go:139-192) — validates the
 * MERGED filters/actions state against the event's capabilities, then the
 * cross-references (columns belong to this project; labels exist in the
 * project's label pool). Throws the exact 422s upstream's APIErrorAuto
 * renders.
 */
async function validateWorkflowRules(
  d1: D1Database,
  scope: ProjectScope,
  repoOwnerId: number | null,
  project: ProjectRow,
  event: string,
  filters: ProjectWorkflowFilters,
  actions: ProjectWorkflowActions,
): Promise<void> {
  const capabilities = WORKFLOW_CAPABILITIES[event];
  if (capabilities === undefined) {
    throw new ApiError(422, `invalid event: ${event}`);
  }
  for (const type of filterTypes(filters)) {
    if (!capabilities.filters.includes(type)) {
      throw new ApiError(422, `${type} is not supported by this event`);
    }
  }
  for (const type of actionTypes(actions)) {
    if (!capabilities.actions.includes(type)) {
      throw new ApiError(422, `${type} is not supported by this event`);
    }
  }
  if (actionTypes(actions).length === 0) {
    throw new ApiError(422, "at least one action must be configured");
  }
  if (!["", "issue", "pull_request"].includes(filters.issue_type ?? "")) {
    throw new ApiError(422, `invalid issue_type: ${filters.issue_type}`);
  }
  if (!["", "close", "reopen"].includes(actions.issue_state ?? "")) {
    throw new ApiError(422, `invalid issue_state: ${actions.issue_state}`);
  }
  if (actions.issue_state === "reopen" && filters.issue_type === "pull_request") {
    throw new ApiError(422, "pull requests cannot be reopened by a workflow");
  }
  for (const columnId of [filters.source_column_id, filters.target_column_id, actions.column_id]) {
    if (!columnId) {
      continue;
    }
    if ((await findColumnByIdAndProject(d1, columnId, project.id)) === null) {
      throw new ApiError(422, `invalid column: ${columnId}`);
    }
  }
  const requestedLabels = [
    ...uniqueIds(filters.label_ids),
    ...uniqueIds(actions.add_label_ids),
    ...uniqueIds(actions.remove_label_ids),
  ];
  if (requestedLabels.length === 0) {
    return;
  }
  const known = await projectLabels(d1, scope, repoOwnerId);
  for (const labelId of requestedLabels) {
    if (!known.has(labelId)) {
      throw new ApiError(422, `invalid label: ${labelId}`);
    }
  }
}

/** `db.FindAndCount[Workflow]` ordering (`project_id ASC, id ASC`). */
export async function listWorkflows(
  d1: D1Database,
  projectId: number,
  page: number,
  limit: number,
): Promise<{ items: ProjectWorkflowRow[]; total: number }> {
  const where = eq(projectWorkflows.projectId, projectId);
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(projectWorkflows).where(where);
  const items = await db
    .select()
    .from(projectWorkflows)
    .where(where)
    .orderBy(asc(projectWorkflows.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/** `GetWorkflowByProjectAndID` — scoped to the project. */
export async function findWorkflowByIdAndProject(
  d1: D1Database,
  workflowId: number,
  projectId: number,
): Promise<ProjectWorkflowRow | null> {
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(projectWorkflows)
    .where(and(eq(projectWorkflows.id, workflowId), eq(projectWorkflows.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateWorkflowInput extends CreateProjectWorkflowOption {
  now: Date;
}

/**
 * `project_service.CreateWorkflow` (workflow.go:61-81) minus the audit
 * trail (no audit table landed): validates, then inserts. `enabled`
 * defaults true.
 */
export async function createWorkflow(
  d1: D1Database,
  scope: ProjectScope,
  repoOwnerId: number | null,
  project: ProjectRow,
  input: CreateWorkflowInput,
): Promise<ProjectWorkflowRow> {
  const event = input.event;
  if (WORKFLOW_CAPABILITIES[event] === undefined) {
    throw new ApiError(422, `invalid event: ${event}`);
  }
  const filters: ProjectWorkflowFilters = {
    issue_type: input.filters?.issue_type,
    source_column_id: input.filters?.source_column_id,
    target_column_id: input.filters?.target_column_id,
    label_ids: uniqueIds(input.filters?.label_ids),
  };
  const actions: ProjectWorkflowActions = {
    column_id: input.actions?.column_id,
    add_label_ids: uniqueIds(input.actions?.add_label_ids),
    remove_label_ids: uniqueIds(input.actions?.remove_label_ids),
    issue_state: input.actions?.issue_state,
  };
  await validateWorkflowRules(d1, scope, repoOwnerId, project, event, filters, actions);
  const rows = await drizzle(d1)
    .insert(projectWorkflows)
    .values({
      projectId: project.id,
      event,
      filters: JSON.stringify(filters),
      actions: JSON.stringify(actions),
      enabled: input.enabled ?? true,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("workflow insert committed without returning rows");
  }
  return row;
}

export interface EditWorkflowPatch extends Omit<EditProjectWorkflowOption, "filters" | "actions"> {
  filters?: ProjectWorkflowFilters;
  actions?: ProjectWorkflowActions;
  now: Date;
}

/**
 * `project_service.UpdateWorkflow` (workflow.go:83-111): provided fields are
 * MERGED with the stored row (upstream assigns onto the loaded workflow
 * before validating), the merged state is re-validated against the event's
 * capabilities, and a no-op PATCH (nothing provided) neither writes nor
 * bumps updated_unix.
 */
export async function updateWorkflow(
  d1: D1Database,
  scope: ProjectScope,
  repoOwnerId: number | null,
  project: ProjectRow,
  row: ProjectWorkflowRow,
  patch: EditWorkflowPatch,
): Promise<ProjectWorkflowRow> {
  const storedFilters = parseWorkflowFilters(row.filters);
  const storedActions = parseWorkflowActions(row.actions);
  const filters =
    patch.filters === undefined
      ? storedFilters
      : {
          issue_type: patch.filters.issue_type,
          source_column_id: patch.filters.source_column_id,
          target_column_id: patch.filters.target_column_id,
          label_ids: uniqueIds(patch.filters.label_ids),
        };
  const actions =
    patch.actions === undefined
      ? storedActions
      : {
          column_id: patch.actions.column_id,
          add_label_ids: uniqueIds(patch.actions.add_label_ids),
          remove_label_ids: uniqueIds(patch.actions.remove_label_ids),
          issue_state: patch.actions.issue_state,
        };
  const enabled = patch.enabled ?? row.enabled;
  const unchanged =
    patch.filters === undefined &&
    patch.actions === undefined &&
    patch.enabled === undefined;
  if (unchanged) {
    return row;
  }
  await validateWorkflowRules(d1, scope, repoOwnerId, project, row.event, filters, actions);
  const rows = await drizzle(d1)
    .update(projectWorkflows)
    .set({
      filters: JSON.stringify(filters),
      actions: JSON.stringify(actions),
      enabled,
      updatedAt: patch.now,
    })
    .where(and(eq(projectWorkflows.id, row.id), eq(projectWorkflows.projectId, project.id)))
    .returning();
  const updated = rows[0];
  if (updated === undefined) {
    throw new Error("workflow update committed without returning rows");
  }
  return updated;
}

/** `DeleteWorkflow` — scoped to the project. */
export async function deleteWorkflow(d1: D1Database, projectId: number, workflowId: number): Promise<void> {
  await drizzle(d1)
    .delete(projectWorkflows)
    .where(and(eq(projectWorkflows.id, workflowId), eq(projectWorkflows.projectId, projectId)));
}

// ---------------------------------------------------------------------------
// Converters (services/convert/project.go)
// ---------------------------------------------------------------------------

/** Omitempty projection of the stored WorkflowFilters JSON. */
export function toApiWorkflowFilters(raw: string): ProjectWorkflowFilters {
  const filters = parseWorkflowFilters(raw);
  return {
    issue_type: filters.issue_type || undefined,
    source_column_id: filters.source_column_id || undefined,
    target_column_id: filters.target_column_id || undefined,
    label_ids: filters.label_ids && filters.label_ids.length > 0 ? filters.label_ids : undefined,
  };
}

/** Omitempty projection of the stored WorkflowActions JSON. */
export function toApiWorkflowActions(raw: string): ProjectWorkflowActions {
  const actions = parseWorkflowActions(raw);
  return {
    column_id: actions.column_id || undefined,
    add_label_ids: actions.add_label_ids && actions.add_label_ids.length > 0 ? actions.add_label_ids : undefined,
    remove_label_ids:
      actions.remove_label_ids && actions.remove_label_ids.length > 0 ? actions.remove_label_ids : undefined,
    issue_state: actions.issue_state || undefined,
  };
}

function parseWorkflowFilters(raw: string): ProjectWorkflowFilters {
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectWorkflowFilters> | null;
    return {
      issue_type: typeof parsed?.issue_type === "string" ? parsed.issue_type : "",
      source_column_id: typeof parsed?.source_column_id === "number" ? parsed.source_column_id : 0,
      target_column_id: typeof parsed?.target_column_id === "number" ? parsed.target_column_id : 0,
      label_ids: Array.isArray(parsed?.label_ids) ? parsed.label_ids.map(Number) : [],
    };
  } catch {
    return { issue_type: "", source_column_id: 0, target_column_id: 0, label_ids: [] };
  }
}

function parseWorkflowActions(raw: string): ProjectWorkflowActions {
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectWorkflowActions> | null;
    return {
      column_id: typeof parsed?.column_id === "number" ? parsed.column_id : 0,
      add_label_ids: Array.isArray(parsed?.add_label_ids) ? parsed.add_label_ids.map(Number) : [],
      remove_label_ids: Array.isArray(parsed?.remove_label_ids) ? parsed.remove_label_ids.map(Number) : [],
      issue_state: typeof parsed?.issue_state === "string" ? parsed.issue_state : "",
    };
  } catch {
    return { column_id: 0, add_label_ids: [], remove_label_ids: [], issue_state: "" };
  }
}

/** `ToProjectWorkflow` — filters/actions always present, omitempty inside. */
export function toApiProjectWorkflow(row: ProjectWorkflowRow): ProjectWorkflow {
  return {
    id: row.id,
    event: row.event,
    enabled: row.enabled,
    filters: toApiWorkflowFilters(row.filters),
    actions: toApiWorkflowActions(row.actions),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** The creator's API `User`, best-effort (vanished user → null). */
async function creatorUser(d1: D1Database, creatorId: number, viewer: Viewer): Promise<User | null> {
  if (creatorId <= 0) {
    return null;
  }
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, creatorId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : apiUserFromRow(row, viewer);
}

/** `ToProjectColumn` — `color` omitempty (empty string drops the field). */
export async function toApiProjectColumn(d1: D1Database, row: ProjectColumnRow, viewer: Viewer): Promise<ProjectColumn> {
  return {
    id: row.id,
    title: row.title,
    default: row.isDefault,
    sorting: row.sorting,
    color: row.color === "" ? undefined : row.color,
    project_id: row.projectId,
    creator: (await creatorUser(d1, row.creatorId, viewer)) ?? undefined,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `ToProjectColumnList` — one creator lookup per column (upstream batches;
 *  ours awaits per row like the other landed converters). */
export async function toApiProjectColumnList(
  d1: D1Database,
  rows: ProjectColumnRow[],
  viewer: Viewer,
): Promise<ProjectColumn[]> {
  const result: ProjectColumn[] = [];
  for (const row of rows) {
    result.push(await toApiProjectColumn(d1, row, viewer));
  }
  return result;
}

/**
 * `ToProject` (convert/project.go:119-157): state/closed_at flip together
 * (closed_at only renders while closed — the reopen-stamped timestamp is
 * hidden), `updated_at` null only for legacy rows (our column is NOT NULL),
 * creator embedded when the user row still exists (`loadProjectCreators` is
 * best-effort: a vanished creator leaves the field off rather than failing).
 */
export async function toApiProject(d1: D1Database, row: ProjectRow, viewer: Viewer, htmlUrl: string): Promise<Project> {
  const counts = await projectIssueCounts(d1, row.id);
  const isClosed = row.isClosed;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    owner_id: row.ownerId,
    repo_id: repoIdNumber(row.repoId),
    creator: (await creatorUser(d1, row.creatorId, viewer)) ?? undefined,
    creator_id: row.creatorId,
    state: isClosed ? "closed" : "open",
    is_closed: isClosed,
    template_type: templateTypeToString(row.boardType),
    card_type: cardTypeToString(row.cardType),
    type: projectTypeToString(row.type),
    num_open_issues: counts.open,
    num_closed_issues: counts.closed,
    num_issues: counts.total,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    closed_at: isClosed && row.closedAtUnix !== null ? row.closedAtUnix.toISOString() : undefined,
    html_url: htmlUrl,
  };
}

/** `ToProjectList` (convert/project.go:181-188). */
export async function toApiProjectList(
  d1: D1Database,
  rows: ProjectRow[],
  viewer: Viewer,
  htmlUrlOf: (row: ProjectRow) => string,
): Promise<Project[]> {
  const result: Project[] = [];
  for (const row of rows) {
    result.push(await toApiProject(d1, row, viewer, htmlUrlOf(row)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Org scope (batch 6 stage 2 — routes/projects-org.ts). Additive appendix:
// everything here is the owner arm of a stage-1 function — the repo scope's
// semantics are reused verbatim wherever the owner kind changes nothing.
// ---------------------------------------------------------------------------

/** The org scope — project.Type 3, keyed on the org's users.id. */
export function orgProjectScope(ownerId: number): ProjectScope {
  return { kind: "organization", repoId: null, ownerId };
}

/** perm.AccessMode's value space (perm/access_mode.go:17-22). */
export type OrgAccessMode = "none" | "read" | "write" | "admin" | "owner";

const ORG_ACCESS_RANK: Record<OrgAccessMode, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/** The org project gates' comparison (api.go:754-768 `< accessMode`). */
export function orgAccessAtLeast(access: OrgAccessMode, required: "read" | "write"): boolean {
  return ORG_ACCESS_RANK[access] >= ORG_ACCESS_RANK[required];
}

/**
 * `ownerVisibilitySatisfiesDoer` (models/organization/org.go:439-454) reduced
 * to the modeled axes: anonymous is satisfied by a public org only; admin and
 * the org itself are handled by callers; signed-in satisfies public AND
 * limited (`RequireSignInViewStrict` is false upstream-by-default and
 * unmodeled; `IsRestricted` has no column).
 */
function orgVisibilitySatisfiesDoer(
  org: { id: number; visibility: "public" | "limited" | "private" },
  doerId: number | null,
): boolean {
  if (doerId === null) {
    return org.visibility === "public";
  }
  if (doerId === org.id) {
    return true;
  }
  return org.visibility !== "private";
}

/**
 * `Organization.AnyRepoUnitPermission` for unit.TypeProjects
 * (models/organization/org.go:278-302) — the predicate behind BOTH org
 * project gates (api.go:754-768 reqProjectsUnitAccess, the read group arm
 * and the write per-route arm alike):
 *  - the doer's `org_members.role='owner'` row IS the Owners team (SPEC-0007
 *    §3.3 bridge) → "owner" (upstream IsOwnerTeam short-circuits
 *    AccessModeOwner, team_list.go:33-36);
 *  - else the MAXIMUM effective access over the doer's teams in THIS org —
 *    `max(authorize, the unitsMap overrides)`, the landed units collapse —
 *    deliberately WITHOUT a repository-coverage filter (upstream
 *    GetUserOrgTeams + AnyRepoUnitMaxAccess: org-level boards are not
 *    repo-scoped; org.go:279's FIXME acknowledges the breadth);
 *  - with NO teams at all: the coarse `ownerVisibilitySatisfiesDoer`
 *    fallback (org.go:297-301) — team-less org members of a private org
 *    read as "none" (upstream's own blind spot, mirrored verbatim).
 */
export async function orgProjectsAccessMode(
  d1: D1Database,
  org: { id: number; visibility: "public" | "limited" | "private" },
  doerId: number | null,
): Promise<OrgAccessMode> {
  if (doerId !== null) {
    const ownerRow = await drizzle(d1)
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, doerId), eq(orgMembers.role, "owner")))
      .limit(1);
    if (ownerRow.length > 0) {
      return "owner";
    }
  }
  const teamRows =
    doerId === null
      ? []
      : await drizzle(d1)
          .select({ authorize: teams.authorize, unitsMap: teams.unitsMap })
          .from(teams)
          .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
          .where(and(eq(teams.orgId, org.id), eq(teamMembers.userId, doerId)));
  if (teamRows.length === 0) {
    return orgVisibilitySatisfiesDoer(org, doerId) ? "read" : "none";
  }
  let best: OrgAccessMode = "none";
  for (const team of teamRows) {
    let effective: OrgAccessMode = team.authorize;
    if (team.unitsMap !== null) {
      for (const mode of Object.values(JSON.parse(team.unitsMap) as Record<string, string>)) {
        const parsed: OrgAccessMode =
          mode === "read" || mode === "write" || mode === "admin" || mode === "owner" ? mode : "none";
        if (ORG_ACCESS_RANK[parsed] > ORG_ACCESS_RANK[effective]) {
          effective = parsed;
        }
      }
    }
    if (ORG_ACCESS_RANK[effective] > ORG_ACCESS_RANK[best]) {
      best = effective;
    }
  }
  return best;
}

/**
 * `GetIssueByID` (models/issues/issue.go:557-567) — the owner arms' GLOBAL
 * issue lookup (shared/project.go:114-122): an owner-level board addresses
 * any issue of any repository, gated afterward on read permission.
 */
export async function findIssueByIdGlobally(d1: D1Database, issueId: number): Promise<IssueRow | null> {
  if (!Number.isSafeInteger(issueId) || issueId <= 0) {
    return null;
  }
  const rows = await drizzle(d1).select().from(issues).where(eq(issues.id, issueId)).limit(1);
  return rows[0] ?? null;
}

/**
 * The owner arm's issue-visibility set (shared/project.go:1685-1692 and
 * services/projects/issue.go:298-308): the org's OWN repositories run
 * through the ONE landed visibility predicate — the `IssuesOptions.Doer`
 * arm for authenticated callers, `AllPublic` for anonymous (canViewRepository's
 * public short-circuit).
 */
export async function orgVisibleRepos(d1: D1Database, orgId: number, viewer: Viewer): Promise<RepositoryWithOwner[]> {
  const orgRows = await drizzle(d1).select().from(users).where(eq(users.id, orgId)).limit(1);
  const owner = orgRows[0];
  if (owner === undefined) {
    return [];
  }
  const repoRows = await drizzle(d1).select().from(repositories).where(eq(repositories.ownerId, orgId));
  const visible: RepositoryWithOwner[] = [];
  for (const repo of repoRows) {
    if (await canViewRepositoryWithTeams(d1, viewer, repo)) {
      visible.push({ repo, owner });
    }
  }
  return visible;
}

/**
 * `LoadIssueNumbersForProject`'s owner branch (services/projects/issue.go:
 * 291-330): the joined open/closed counts filtered to the doer-visible
 * org repositories (unlike the repository branch's plain counts).
 */
export async function projectIssueCountsForOrg(
  d1: D1Database,
  projectId: number,
  visibleRepoIds: string[],
): Promise<{ open: number; closed: number; total: number }> {
  if (visibleRepoIds.length === 0) {
    return { open: 0, closed: 0, total: 0 };
  }
  const rows = await drizzle(d1)
    .select({ closed: issues.isClosed, value: sql<number>`count(*)` })
    .from(projectIssues)
    .innerJoin(issues, eq(projectIssues.issueId, issues.id))
    .where(and(eq(projectIssues.projectId, projectId), inArray(issues.repoId, visibleRepoIds)))
    .groupBy(issues.isClosed);
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    if (row.closed) {
      closed = Number(row.value);
    } else {
      open = Number(row.value);
    }
  }
  return { open, closed, total: open + closed };
}

/**
 * `ToProject` with the owner arm's permission-filtered counts. toApiProject
 * still computes the plain counts internally (kept untouched — the same
 * "pure redundancy, not a second gate" trade the repo routes document);
 * the org arm's numbers win on the wire.
 */
export async function toApiOrgProject(
  d1: D1Database,
  row: ProjectRow,
  viewer: Viewer,
  htmlUrl: string,
  counts: { open: number; closed: number; total: number },
): Promise<Project> {
  const rendered = await toApiProject(d1, row, viewer, htmlUrl);
  return { ...rendered, num_open_issues: counts.open, num_closed_issues: counts.closed, num_issues: counts.total };
}

/**
 * `ListProjectColumnIssues`'s owner arm (shared/project.go:1685-1704): the
 * column's claimed issues filtered to the doer-visible org repositories —
 * issues added from repositories OUTSIDE the org stay assigned but never
 * list (upstream `issuesOpts.Owner = scope.Owner`). Same join + ordering as
 * the repository arm.
 */
export async function listColumnIssuesForOrg(
  d1: D1Database,
  projectId: number,
  column: ProjectColumnRow,
  visibleRepoIds: string[],
  page: number,
  limit: number,
): Promise<{ items: IssueRow[]; total: number }> {
  const claimedIssueIds = await columnIssueIds(d1, column);
  if (claimedIssueIds.length === 0 || visibleRepoIds.length === 0) {
    return { items: [], total: 0 };
  }
  const where = and(inArray(issues.id, claimedIssueIds), inArray(issues.repoId, visibleRepoIds)) as SQL;
  const joinCondition = and(
    eq(projectIssues.issueId, issues.id),
    eq(projectIssues.projectId, projectId),
  ) as SQL;
  const db = drizzle(d1);
  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(issues)
    .innerJoin(projectIssues, joinCondition)
    .where(where);
  const items = await db
    .select({ issue: issues })
    .from(issues)
    .innerJoin(projectIssues, joinCondition)
    .where(where)
    .orderBy(asc(projectIssues.sorting), desc(issues.createdAt), desc(issues.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { items: items.map((row) => row.issue), total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `CanManageWorkflows`'s organization arm (services/projects/workflow.go:
 * 33-39): owner-level projects hold the owner's private items too, so a
 * present doer needs site admin or the org OWNER (`IsOrganizationOwner`) —
 * merely holding the Projects-unit write gate is NOT enough. The
 * `DoerCanViewPrivate` precondition collapses to "doer present" (every
 * resolved doer is private-capable in the landed identity).
 */
export async function canManageOrgProjectWorkflows(
  d1: D1Database,
  org: { id: number },
  doer: { id: number; isAdmin: boolean },
): Promise<boolean> {
  if (doer.isAdmin) {
    return true;
  }
  return await new OrgService(d1).isOrgOwner(org.id, doer.id);
}
