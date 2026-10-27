/**
 * Read-only repository lookup for the Tier-2 pages (SPEC-0008 §2.4 module
 * layout, §3.2 data-sourcing rules): the UI never self-fetches its own HTTP
 * surface — it reads the same D1 rows the git gate reads, through the same
 * `resolveRepository()` join (`src/git-http/acl.ts`).
 *
 * Page visibility (SPEC-0008 §2.5 widened by SPEC-0010 §2.6): the whole ACL
 * is the gate's own grant lines, shared as `readGrant` (acl.ts) so page
 * visibility and git-HTTP visibility cannot drift:
 *
 * - anonymous — matrix row 1's collapse verbatim: repo `public` × owner
 *   active × owner `visibility === "public"`;
 * - `{ kind: "user" }` — `publiclyVisible || isOwner || isSiteAdmin ||
 *   (repoPublic && ownerActive && ownerVisibility === "limited")` (gate
 *   rows 2/7/8/9 minus row 7's scope half — sessions carry no scope
 *   bitmap; the mint-time gate moved that check, SPEC-0010 §2.2 step 3),
 *   then ONE resolved-grant lookup: `viewerTeamAccessMode` — the
 *   repository-service `doerRepoAccessMode` fold admits an org/team grant
 *   (SPEC-0007 §3.5) AND, since SPEC-0005, an active `repo_collaborators`
 *   row (any mode grants read of a private repo; write ranks write for the
 *   page chrome, admin ranks admin) — the collaborator-visibility deferral
 *   the wave-123 tree-view/public-access matrices pinned is lifted.
 *
 * Either way anything else is `null`, and the caller answers the 404 shell
 * — invisible repos 404, never a 401 (§2.6; SPEC-0003 §2.4 semantics).
 * A missing or prohibited owner row is invisible for EVERY viewer (§4.8),
 * the page-shape twin of the gate's owner-status refusal
 * (githttp.go:117-119). Public-only masking cannot arise: such tokens never
 * mint sessions (§2.2 step 3).
 */

import { readGrant, resolveRepository } from "../git-http/acl";
import { viewerTeamAccessMode } from "../api/services/repository";
import type { Viewer } from "./viewer";
import type { RepoRow } from "./ui-context";

/**
 * Resolve the repository at `/:owner/:repo` for the page viewer, or `null`
 * when it must not render (missing row, no grant for the viewer, missing or
 * prohibited owner). `owner`/`repo` are request-cased; the lookup folds case
 * like the gate does (§2.1 item 1). Engine addressing (DO `getByName`) stays
 * with the U3 page-data module — this helper is the D1 half only.
 */
export async function resolveRepositoryForViewer(
  env: Env,
  viewer: Viewer,
  owner: string,
  repo: string,
): Promise<RepoRow | null> {
  const resolved = await resolveRepository(env.DB, owner.toLowerCase(), repo.toLowerCase());
  if (resolved === null) return null;
  // Owner row missing (orphaned repo) or prohibited → invisible for every
  // viewer (§4.8; the gate answers its 403 shape on the git-HTTP side).
  if (resolved.owner === null || resolved.owner.status !== "active") return null;
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : null;
  const grant = readGrant({
    repoVisibility: resolved.repo.visibility,
    owner: { id: resolved.owner.id, status: resolved.owner.status },
    ownerVisibility: resolved.ownerVisibility,
    doer,
  });
  if (grant) return resolved.repo;
  // The cheap arms missed: pay ONE resolved-grant lookup (the same
  // composition the gate and the API ride — wave16's flagged gap: git-HTTP
  // and the API admit team members to private org repos; the pages must
  // too, or invisible ≢ missing breaks across surfaces for the same
  // principal). Since SPEC-0005 the folded mode also carries the active
  // repo_collaborators row — a collaborator reads the private repo's pages.
  if (doer === null) return null;
  // Project onto the service Viewer's three read fields (the repo-grants.ts
  // bridge precedent — the wire type's rest is optional).
  const mode = await viewerTeamAccessMode(
    env.DB,
    { origin: "", requester: { id: doer.id, login: "", is_admin: doer.isAdmin } },
    resolved.repo,
  );
  return mode !== "none" && mode !== null ? resolved.repo : null;
}
