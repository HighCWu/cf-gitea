import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";

import { users } from "../../db/schema";
import type { UserRow } from "./repository";

/**
 * Repo collaborators (SPEC-0004 §2.4 rows repoListCollaborators /
 * repoCheckCollaborator / repoAddCollaborator / repoDeleteCollaborator /
 * repoGetAssignees) — upstream `collaboration` (models/repo/collaboration.go)
 * reduced to one row per (repo, user) with a `read|write|admin` mode.
 *
 * SCHEMA GAP (the raw-D1 + DDL-comment pattern of SPEC-0006's LFS
 * bootstrap): `src/db/schema.ts` is owned by a parallel change this batch and
 * migrations must not be hand-edited, so collaborators live OUTSIDE the
 * Drizzle schema for now, accessed with prepared statements from this mapper
 * (never in routes). DDL for the migration owner's sweep is
 * `REPO_COLLABORATORS_DDL_STATEMENTS`; the sweep also adds the table to the
 * `repositories` delete cascade (src/repos/service.ts deleteRepository) and
 * to the api repoDelete housekeeping (deleteRepoCollaborators). User rows
 * themselves stay on Drizzle (`users` is a landed table).
 *
 * Semantics mirrored (routers/api/v1/repo/collaborators.go +
 * services/repository/collaboration.go):
 *  - AddOrUpdate is an UPSERT at the requested mode (default write when the
 *    body omits `permission`); unknown users are the 422
 *    `user does not exist [uid: 0, name: X]`; DELETE is idempotent 204
 *    (a missing collaboration deletes zero rows and still succeeds);
 *  - the list orders by `collaboration.id` = insertion order (our rowid);
 *  - assignees (GetRepoAssignees, models/repo/user_repo.go:117–152) = the
 *    write-or-above collaborators plus the owner, active users only, name
 *    order, deduped.
 */

/**
 * Pre-migration bootstrap DDL (superseded by the schema entry the migration
 * owner lands; kept exactly like `LFS_OBJECTS_DDL_STATEMENTS`).
 */
export const REPO_COLLABORATORS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repo_collaborators (
  repo_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'write',
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (repo_id, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS idx_repo_collaborators_user
  ON repo_collaborators (user_id)`,
];

/** Upstream `perm.AccessMode` names the wire/body strings map to. */
export type CollaboratorMode = "read" | "write" | "admin";

export interface CollaboratorRow {
  repoId: string;
  userId: number;
  mode: CollaboratorMode;
  createdAt: Date | null;
  updatedAt: Date | null;
}

function fromUnix(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(seconds * 1000);
}

/** `IsCollaborator` (collaboration.go:114). */
export async function isCollaborator(d1: D1Database, repoId: string, userId: number): Promise<boolean> {
  const row = await d1
    .prepare("SELECT 1 AS one FROM repo_collaborators WHERE repo_id = ?1 AND user_id = ?2")
    .bind(repoId, userId)
    .first<{ one: number }>();
  return row !== null;
}

/** The (repo, user) collaboration row, or null. */
export async function findCollaborator(d1: D1Database, repoId: string, userId: number): Promise<CollaboratorRow | null> {
  const row = await d1
    .prepare("SELECT repo_id, user_id, mode, created_at, updated_at FROM repo_collaborators WHERE repo_id = ?1 AND user_id = ?2")
    .bind(repoId, userId)
    .first<{ repo_id: string; user_id: number; mode: string; created_at: number | null; updated_at: number | null }>();
  if (row === null) {
    return null;
  }
  return {
    repoId: row.repo_id,
    userId: row.user_id,
    mode: row.mode as CollaboratorMode,
    createdAt: fromUnix(row.created_at),
    updatedAt: fromUnix(row.updated_at),
  };
}

/** `AddOrUpdateCollaborator` (collaboration.go:23) — the upsert. */
export async function addOrUpdateCollaborator(
  d1: D1Database,
  repoId: string,
  userId: number,
  mode: CollaboratorMode,
  now: Date,
): Promise<void> {
  const unix = Math.floor(now.getTime() / 1000);
  await d1
    .prepare(
      `INSERT INTO repo_collaborators (repo_id, user_id, mode, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (repo_id, user_id) DO UPDATE SET mode = ?3, updated_at = ?4`,
    )
    .bind(repoId, userId, mode, unix)
    .run();
}

/** `DeleteCollaboration` — idempotent (absent row deletes zero rows, still
 *  a success, exactly like upstream's unconditional delete). */
export async function deleteCollaborator(d1: D1Database, repoId: string, userId: number): Promise<void> {
  await d1.prepare("DELETE FROM repo_collaborators WHERE repo_id = ?1 AND user_id = ?2").bind(repoId, userId).run();
}

/** UserRow lookup shared by the join renders — `users` is a landed table, so
 *  this half stays on Drizzle (only repo_collaborators is the schema gap). */
async function userRowsByIds(d1: D1Database, ids: readonly number[]): Promise<Map<number, UserRow>> {
  const map = new Map<number, UserRow>();
  if (ids.length === 0) {
    return map;
  }
  const rows = await drizzle(d1)
    .select()
    .from(users)
    .where(inArray(users.id, [...ids]))
    .all();
  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

/**
 * `GetCollaborators` — user rows joined onto the collaboration rows in
 * insertion order (upstream orders by `collaboration.id` ASC = our rowid).
 * Pagination (page/limit) plus the unpaginated total, like every list
 * service here.
 */
export async function listRepoCollaborators(
  d1: D1Database,
  repoId: string,
  page: number,
  limit: number,
): Promise<{ items: Array<{ user: UserRow; mode: CollaboratorMode }>; total: number }> {
  const totalRow = await d1
    .prepare("SELECT COUNT(*) AS n FROM repo_collaborators WHERE repo_id = ?1")
    .bind(repoId)
    .first<{ n: number }>();
  const { results } = await d1
    .prepare(
      `SELECT user_id, mode FROM repo_collaborators
       WHERE repo_id = ?1 ORDER BY rowid ASC LIMIT ?2 OFFSET ?3`,
    )
    .bind(repoId, limit, (page - 1) * limit)
    .all<{ user_id: number; mode: string }>();
  const usersById = await userRowsByIds(
    d1,
    results.map((row) => row.user_id),
  );
  const items: Array<{ user: UserRow; mode: CollaboratorMode }> = [];
  for (const row of results) {
    const user = usersById.get(row.user_id);
    if (user !== undefined) {
      items.push({ user, mode: row.mode as CollaboratorMode });
    }
  }
  return { items, total: totalRow?.n ?? 0 };
}

/**
 * `GetRepoAssignees` (user_repo.go:117–152) — write-or-above collaborators
 * plus the (non-org) owner; active users only; `GetOrderByName()` order
 * (username ASC); the owner never appears twice.
 */
export async function listRepoAssignees(
  d1: D1Database,
  repo: { id: string; ownerId: number | null },
): Promise<UserRow[]> {
  const { results } = await d1
    .prepare(
      `SELECT user_id FROM repo_collaborators
       WHERE repo_id = ?1 AND mode IN ('write', 'admin') ORDER BY rowid ASC`,
    )
    .bind(repo.id)
    .all<{ user_id: number }>();
  const ids = results.map((row) => row.user_id);
  if (repo.ownerId !== null && !ids.includes(repo.ownerId)) {
    ids.push(repo.ownerId);
  }
  const usersById = await userRowsByIds(d1, ids);
  return [...usersById.values()]
    .filter((user) => user.status === "active")
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

/** Effective collaboration mode of one user on one repo ("none" when absent —
 *  the owner/site-admin grant is the callers' decision, which own that
 *  check). */
export async function collaboratorModeOf(
  d1: D1Database,
  repoId: string,
  userId: number,
): Promise<CollaboratorMode | "none"> {
  const row = await findCollaborator(d1, repoId, userId);
  return row === null ? "none" : row.mode;
}

/** Repo-scoped collaborator delete (the api repoDelete path's housekeeping). */
export async function deleteRepoCollaborators(d1: D1Database, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM repo_collaborators WHERE repo_id = ?1").bind(repoId).run();
}
