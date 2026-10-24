import type { Context } from "hono";

import { collaboratorModeOf } from "./repo-collaborators";
import {
  canViewRepository,
  findRepositoryByPath,
  repositoryPermissions,
  viewerOf,
  type RepositoryWithOwner,
} from "./repository";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";

/**
 * Shared repo-access guards for the batch-7 route families (topics,
 * subscription, collaborators/assignees, releases, repo-edit/transfer).
 * The landed route families (hooks/pulls/issues) carry their own copies of
 * `requireVisibleRepo`; this module is the shared seam going forward so the
 * collaborator-mode grants below read from exactly one table.
 *
 * Permission model (the reduced ACL matrix of services/repository.ts,
 * widened with the collaborator rows this batch stores):
 *  - visible  = public, or requester is owner/site admin (anti-enumeration
 *    404 for everything else — SPEC-0004 §2.4);
 *  - admin    = owner / site admin, or a collaborator with the `admin` mode
 *    (upstream `reqAdmin`, api.go:383–390 — the full org-team grant lands
 *    with SPEC-0002/0007);
 *  - write    = admin, or `push` on the reduced matrix, or a collaborator
 *    with the `write`/`admin` mode (upstream `reqRepoWriter`).
 */

/** Visible-repo resolution — missing and invisible are the same 404. */
export async function requireVisibleRepo(
  c: Context<ApiEnv>,
  path: { owner: string; repo: string },
): Promise<RepositoryWithOwner> {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
    throw new ApiError(404, "not found");
  }
  return found;
}

/** The requester id (or null when the optional-auth middleware was absent). */
function requesterId(c: Context<ApiEnv>): number | null {
  return c.get("authUser")?.id ?? null;
}

/** Admin grant: owner / site admin / collaborator-admin (see module header). */
export async function isRepositoryAdmin(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<boolean> {
  if (repositoryPermissions(viewerOf(c), found.repo).admin === true) {
    return true;
  }
  const userId = requesterId(c);
  if (userId === null) {
    return false;
  }
  return (await collaboratorModeOf(c.env.DB, found.repo.id, userId)) === "admin";
}

/** `reqAdmin` — 403 with upstream's exact message (api.go:386). */
export async function requireRepoAdmin(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (await isRepositoryAdmin(c, found)) {
    return;
  }
  throw new ApiError(403, "user should be an owner or a collaborator with admin write of a repository");
}

/**
 * `reqRepoWriter`-grade grant (release POST/PATCH/DELETE): the reduced
 * matrix's `push` plus write/admin collaborator rows.
 */
export async function canWriteRepository(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<boolean> {
  const permissions = repositoryPermissions(viewerOf(c), found.repo);
  if (permissions.admin === true || permissions.push === true) {
    return true;
  }
  const userId = requesterId(c);
  if (userId === null) {
    return false;
  }
  const mode = await collaboratorModeOf(c.env.DB, found.repo.id, userId);
  return mode === "write" || mode === "admin";
}

/** The danger-zone 403 (upstream reqRepoDangerZone, api.go:363–370). */
export async function requireRepoDangerZone(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (await isRepositoryAdmin(c, found)) {
    return;
  }
  throw new ApiError(403, "user has no permission to manage the danger zone");
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
export function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
}
