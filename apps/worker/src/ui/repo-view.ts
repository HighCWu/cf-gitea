/**
 * Read-only repository lookup for the Tier-2 pages (SPEC-0008 §2.4 module
 * layout, §3.2 data-sourcing rules): the UI never self-fetches its own HTTP
 * surface — it reads the same D1 rows the git gate reads, through the same
 * `resolveRepository()` join (`src/git-http/acl.ts`).
 *
 * Page visibility (§2.5): slice 1 is anonymous, read-only, public repos only.
 * The whole ACL collapses to one check — the exact `publiclyVisible` verdict
 * the gate's matrix row 1 gives an anonymous doer (repo `public` × owner row
 * present and `active` × owner `visibility === "public"`). Anything else is
 * `null`, and the caller answers the 404 shell — invisible repos 404, never
 * a 401 (§2.5; SPEC-0003 §2.4 semantics).
 */

import { resolveRepository } from "../git-http/acl";
import type { RepoRow } from "./ui-context";

/**
 * Resolve the repository at `/:owner/:repo` for anonymous page rendering, or
 * `null` when it must not render (missing row, private repo, missing or
 * prohibited owner, limited/private owner visibility). `owner`/`repo` are
 * request-cased; the lookup folds case like the gate does (§2.1 item 1).
 * Engine addressing (DO `getByName`) stays with the U3 page-data module —
 * this helper is the D1 half only.
 */
export async function resolvePublicRepository(env: Env, owner: string, repo: string): Promise<RepoRow | null> {
  const resolved = await resolveRepository(env.DB, owner.toLowerCase(), repo.toLowerCase());
  if (resolved === null) return null;
  if (resolved.repo.visibility !== "public") return null;
  // Owner row missing (orphaned repo) or prohibited → invisible (§4.8).
  if (resolved.owner === null || resolved.owner.status !== "active") return null;
  // Limited/private owners expose their public repos to authenticated
  // principals only (gate ACL row 2); anonymous pages see public owners only.
  if (resolved.ownerVisibility !== "public") return null;
  return resolved.repo;
}
