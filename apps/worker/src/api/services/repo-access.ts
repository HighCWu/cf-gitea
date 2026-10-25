import type { Context } from "hono";

import { collaboratorModeOf } from "./repo-collaborators";
import {
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  repositoryPermissions,
  viewerOf,
  viewerTeamAccessMode,
  type RepositoryWithOwner,
} from "./repository";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";

/**
 * Shared repo-access guards for the batch-7 route families (topics,
 * subscription, collaborators/assignees, releases, repo-edit/transfer).
 * `requireVisibleRepo` is THE repo-visibility seam: every route family that
 * resolves a repo through it (and the families that still carry local
 * copies of the same shape) reads the ONE team-aware predicate
 * (`canViewRepositoryWithTeams` — SPEC-0007 §3.5), so a team-granted member
 * sees a private org repo upstream-style everywhere, and the collaborator
 * grants below read from exactly one table.
 *
 * Permission model (the reduced ACL matrix of services/repository.ts,
 * widened with the collaborator rows this batch stores, the org/team grant
 * in the visibility arm, and the §3.5 team arms on the write/admin grants):
 *  - visible  = public, or requester is owner/site admin, or an org team
 *    grant covers the repo (anti-enumeration 404 for everything else —
 *    SPEC-0004 §2.4);
 *  - admin    = owner / site admin, a collaborator with the `admin` mode, or
 *    an admin/owner-mode org-team grant (upstream `reqAdmin`, api.go:383–390
 *    — GetDoerRepoPermission's team resolution,
 *    models/perm/access/repo_permission.go);
 *  - write    = admin, or `push` on the reduced matrix, or a collaborator
 *    with the `write`/`admin` mode, or a write/admin/owner-mode team grant
 *    (read teams rank pull only) — upstream `reqRepoWriter`.
 *
 * Both widened grants REUSE the landed composition —
 * `viewerTeamAccessMode`/`doerRepoAccessMode` resolved once and mapped
 * through `repositoryPermissions`' AccessMode→Permission block (read ⇒
 * pull; write/admin/owner ⇒ push; admin/owner ⇒ admin) — so grant, git-HTTP
 * gate, and the rendered permissions block cannot drift.
 */

/** Visible-repo resolution — missing and invisible are the same 404. */
export async function requireVisibleRepo(
  c: Context<ApiEnv>,
  path: { owner: string; repo: string },
): Promise<RepositoryWithOwner> {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  return found;
}

/** The requester id (or null when the optional-auth middleware was absent). */
function requesterId(c: Context<ApiEnv>): number | null {
  return c.get("authUser")?.id ?? null;
}

/**
 * Admin grant: owner / site admin / collaborator-admin / the §3.5 team arm
 * (see module header).
 */
export async function isRepositoryAdmin(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<boolean> {
  const viewer = viewerOf(c);
  if (repositoryPermissions(viewer, found.repo).admin === true) {
    return true;
  }
  const userId = requesterId(c);
  if (userId === null) {
    return false;
  }
  if ((await collaboratorModeOf(c.env.DB, found.repo.id, userId)) === "admin") {
    return true;
  }
  return (
    repositoryPermissions(viewer, found.repo, await viewerTeamAccessMode(c.env.DB, viewer, found.repo)).admin ===
    true
  );
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
 * matrix's `push`, write/admin collaborator rows, and the §3.5 team arm —
 * a write/admin/owner-mode team grant ranks push (read teams rank pull
 * only), mapped through the same `repositoryPermissions` composition as
 * the admin arm.
 */
export async function canWriteRepository(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<boolean> {
  const viewer = viewerOf(c);
  const permissions = repositoryPermissions(viewer, found.repo);
  if (permissions.admin === true || permissions.push === true) {
    return true;
  }
  const userId = requesterId(c);
  if (userId === null) {
    return false;
  }
  const mode = await collaboratorModeOf(c.env.DB, found.repo.id, userId);
  if (mode === "write" || mode === "admin") {
    return true;
  }
  return (
    repositoryPermissions(viewer, found.repo, await viewerTeamAccessMode(c.env.DB, viewer, found.repo)).push ===
    true
  );
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
