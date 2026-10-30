import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, sql } from "drizzle-orm";

import { repoCollaborators, users } from "../../db/schema";
import type { UserRow } from "./repository";

/**
 * Repo collaborators (SPEC-0004 §2.4 rows repoListCollaborators /
 * repoCheckCollaborator / repoAddCollaborator / repoDeleteCollaborator /
 * repoGetAssignees) — upstream `collaboration` (models/repo/collaboration.go)
 * reduced to one row per (repo, user) with a `read|write|admin` mode.
 *
 * The table lives in the Drizzle schema (`repoCollaborators`,
 * src/db/schema.ts) and landed as migration 0007; D1 access goes through
 * Drizzle per the architecture boundary (no hand-written SQL in services).
 * Superseded: `REPO_COLLABORATORS_DDL_STATEMENTS` below is kept only as the
 * historical record of the pre-migration bootstrap (the batch-7 schema gap) —
 * the generated migration is authoritative now.
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
 * SUPERSEDED by migration 0007 (`repoCollaborators` in src/db/schema.ts) —
 * kept only so pre-migration scratch databases can still be bootstrapped by
 * hand. Do not extend; change the schema + regenerate instead (AGENTS.md).
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

/**
 * `perm.ParseAccessMode` restricted to the read/write/admin allowlist, exactly
 * as the collaborators PUT calls it (routers/api/v1/repo/collaborators.go:
 * `ParseAccessMode(string(*form.Permission), AccessModeRead, AccessModeWrite,
 * AccessModeAdmin)`). Unknown strings — "owner", "" (the empty permission
 * string decodes as present), anything unlisted — parse to `AccessModeNone`
 * (models/perm/access_mode.go:46-61), which `AddOrUpdateCollaborator`'s range
 * check rejects with `ErrInvalidAccessMode` before any write or blocked-arm
 * work (services/repository/collaboration.go:27-30). The route renders that
 * as the blanked internal 500. `null` = that invalid-mode arm.
 */
export function parseCollaboratorMode(permission: string): CollaboratorMode | null {
  switch (permission) {
    case "read":
    case "write":
    case "admin":
      return permission;
    default:
      return null;
  }
}

export interface CollaboratorRow {
  repoId: string;
  userId: number;
  mode: CollaboratorMode;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** `IsCollaborator` (collaboration.go:114). */
export async function isCollaborator(d1: D1Database, repoId: string, userId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ repoId: repoCollaborators.repoId })
    .from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.userId, userId)))
    .get();
  return row !== undefined;
}

/** The (repo, user) collaboration row, or null. */
export async function findCollaborator(d1: D1Database, repoId: string, userId: number): Promise<CollaboratorRow | null> {
  const row = await drizzle(d1)
    .select()
    .from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.userId, userId)))
    .get();
  if (row === undefined) {
    return null;
  }
  return {
    repoId: row.repoId,
    userId: row.userId,
    mode: row.mode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  await drizzle(d1)
    .insert(repoCollaborators)
    .values({ repoId, userId, mode, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [repoCollaborators.repoId, repoCollaborators.userId],
      set: { mode, updatedAt: now },
    });
}

/** `DeleteCollaboration` — idempotent (absent row deletes zero rows, still
 *  a success, exactly like upstream's unconditional delete). */
export async function deleteCollaborator(d1: D1Database, repoId: string, userId: number): Promise<void> {
  await drizzle(d1)
    .delete(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.userId, userId)));
}

/** UserRow lookup shared by the join renders. */
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
 * insertion order (upstream orders by `collaboration.id` ASC = our rowid;
 * the composite-PK table keeps a rowid, ordered here with a raw `rowid`
 * fragment — drizzle has no column object for it). Pagination (page/limit)
 * plus the unpaginated total, like every list service here.
 */
export async function listRepoCollaborators(
  d1: D1Database,
  repoId: string,
  page: number,
  limit: number,
): Promise<{ items: Array<{ user: UserRow; mode: CollaboratorMode }>; total: number }> {
  const db = drizzle(d1);
  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(repoCollaborators)
    .where(eq(repoCollaborators.repoId, repoId))
    .get();
  const rows = await db
    .select({ userId: repoCollaborators.userId, mode: repoCollaborators.mode })
    .from(repoCollaborators)
    .where(eq(repoCollaborators.repoId, repoId))
    .orderBy(sql`rowid ASC`)
    .limit(limit)
    .offset((page - 1) * limit)
    .all();
  const usersById = await userRowsByIds(
    d1,
    rows.map((row) => row.userId),
  );
  const items: Array<{ user: UserRow; mode: CollaboratorMode }> = [];
  for (const row of rows) {
    const user = usersById.get(row.userId);
    if (user !== undefined) {
      items.push({ user, mode: row.mode });
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
  const rows = await drizzle(d1)
    .select({ userId: repoCollaborators.userId })
    .from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repo.id), inArray(repoCollaborators.mode, ["write", "admin"])))
    .orderBy(sql`rowid ASC`)
    .all();
  const ids = rows.map((row) => row.userId);
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

/** Repo-scoped collaborator delete (the api repoDelete path's housekeeping;
 *  the deleteRepository cascade covers the same rows through the schema
 *  table). */
export async function deleteRepoCollaborators(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoCollaborators).where(eq(repoCollaborators.repoId, repoId));
}
