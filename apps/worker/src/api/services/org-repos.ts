import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../../db/schema";
import { OrgService, type ListOptions, type OrgRecord } from "../../services/orgs/orgs";
import { ApiError } from "../errors";
import type { Organization } from "../models/organization";
import type { Repository } from "../models/repository";
import type { User } from "../models/user";
import { toApiRepository, type RepositoryWithOwner, type Viewer } from "./repository";

/**
 * Tier-1 organization routes' service half (SPEC-0007 §2.2 rows 1–3):
 * `GET /user/orgs` (orgListCurrentUserOrgs), `GET /orgs/{org}/repos`
 * (orgListRepos), `POST /orgs/{org}/repos` (createOrgRepo). Storage goes
 * through the landed org service (src/services/orgs/orgs.ts — the raw-D1
 * layer that owns the org-as-user-row model) and the landed repos service
 * (src/repos/service.ts) for creation; this module only adds the API
 * projections and the upstream guard predicates the routes need.
 *
 * Visibility predicate: upstream `HasOrgOrUserVisible`
 * (gitea/models/organization/org.go:457–461) over
 * `ownerVisibilitySatisfiesDoer` (:439–455) — anonymous ⇒ public only;
 * site admin ⇒ always; public ⇒ anyone; limited ⇒ any authenticated
 * principal; private ⇒ members only. Restricted principals do not exist yet
 * (no users.restricted column), so that arm is unreachable.
 */

/** The authenticated doer slice the guards need (null = anonymous). */
export interface OrgDoer {
  id: number | null;
  isAdmin: boolean;
}

/**
 * `HasOrgOrUserVisible` (org.go:439–461). Membership is the override: a
 * private org is visible to its members (any role — membership test = row
 * exists, SPEC-0007 §3.3).
 */
export async function orgVisibleToDoer(
  orgs: OrgService,
  org: OrgRecord,
  doer: OrgDoer,
): Promise<boolean> {
  if (doer.id !== null && (doer.isAdmin || doer.id === org.id)) return true;
  switch (org.visibility) {
    case "public":
      return true;
    case "limited":
      return doer.id !== null;
    case "private":
      if (doer.id === null) return false;
      return (await orgs.getMembership(org.id, doer.id)) !== null;
  }
}

/**
 * `ToOrganization` (services/convert/convert.go:928–943): the 11-field
 * projection of the org-as-user row. `avatar_url` derives from a hash of
 * `avatar_email` (falling back to the username hash — nobody fetches the
 * route in tier 1, SPEC-0007 §4.6; see avatarHash for the hash divergence).
 * `email` renders for authenticated callers; the anonymous blanking rule is
 * the tier-2 GET /orgs/{org} handler's business (SPEC-0007 §2.2 preview).
 */
export function toApiOrganization(org: OrgRecord, options: { origin: string; includeEmail: boolean }): Organization {
  return {
    id: org.id,
    name: org.username,
    username: org.username, // deprecated alias of name, kept faithful
    full_name: org.fullName ?? "",
    email: options.includeEmail ? (org.email ?? "") : "",
    avatar_url: `${options.origin}/avatar/${avatarHash(org.avatarEmail ?? org.usernameLower)}`,
    description: org.description ?? "",
    website: org.website ?? "",
    location: org.location ?? "",
    visibility: org.visibility,
    repo_admin_change_team_access: org.repoAdminChangeTeamAccess,
  };
}

/** The avatar-hash segment: SHA-256 was the plan, but WebCrypto digests are
 *  async and MD5 unsupported — a deterministic FNV-1a hex rendering keeps
 *  the URL shape (`/avatar/<hex>`) until the avatar surface lands (T2);
 *  nobody fetches the URL in tier 1 (SPEC-0007 §4.6). */
function avatarHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The org's own `users` row (orgs ARE users rows) — the Repository.owner
 *  projection source. Drizzle selects the schema-known columns; the org-only
 *  DDL columns are ignored, which is all `apiUserFromRow` needs. */
export async function orgUserRow(d1: D1Database, org: OrgRecord) {
  const row = await drizzle(d1).select().from(users).where(eq(users.id, org.id)).get();
  if (row === undefined) throw new Error(`org users row missing: ${org.id}`);
  return row;
}

/**
 * `GET /orgs/{org}/repos` page (orgListRepos → user.listUserRepos): the
 * org service decides the page (the §4.7 quirk — anonymous callers get 200 +
 * the public repos of limited/private orgs; owners/admins see private rows),
 * then the rows hydrate into the frozen 71-field `Repository` projection.
 */
export async function listOrgRepositories(
  d1: D1Database,
  org: OrgRecord,
  doer: OrgDoer,
  options: ListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const orgs = new OrgService(d1);
  const page = await orgs.listOrgRepos(org.id, { id: doer.id, isAdmin: doer.isAdmin }, options);
  if (page.items.length === 0) {
    return { items: [], total: page.total };
  }
  const owner = await orgUserRow(d1, org);
  const ids = page.items.map((row) => row.id);
  const full = await drizzle(d1).select().from(repositories).where(inArray(repositories.id, ids)).all();
  const byId = new Map(full.map((row) => [row.id, row]));
  const items: RepositoryWithOwner[] = [];
  for (const projected of page.items) {
    const row = byId.get(projected.id);
    if (row !== undefined) items.push({ repo: row, owner });
  }
  return { items, total: page.total };
}

/**
 * `POST /orgs/{org}/repos` guard chain (upstream order,
 * `prepareDoerCreateRepoInOrg` routers/api/v1/repo/fork.go:87–110):
 *  1. org missing **or a plain user** (`GetOrgByName` type filter, §4.11)
 *     → 404 "not found";
 *  2. org invisible to the doer (`HasOrgOrUserVisible`) → 404 "not found";
 *  3. repo-create grant missing (tier 1: `role='owner'`; admins bypass,
 *     fork.go:97–108) → 403 "User is not allowed to create repositories in
 *     this organization."
 * Returns the org row to create under.
 */
export async function requireCanCreateOrgRepo(
  d1: D1Database,
  orgName: string,
  doer: OrgDoer & { id: number },
): Promise<OrgRecord> {
  const orgs = new OrgService(d1);
  const org = await orgs.getOrgByUsername(orgName);
  if (org === null) {
    throw new ApiError(404, "not found");
  }
  if (!(await orgVisibleToDoer(orgs, org, doer))) {
    // invisible orgs are indistinguishable from missing ones (upstream
    // answers both with APIErrorNotFound)
    throw new ApiError(404, "not found");
  }
  if (!doer.isAdmin && !(await orgs.canCreateOrgRepo(org.id, doer.id))) {
    throw new ApiError(403, "User is not allowed to create repositories in this organization.");
  }
  return org;
}

/**
 * The 201 body: `convert.ToRepo(ctx, repo, Permission{AccessModeOwner})`
 * (routers/api/v1/repo/repo.go CreateUserRepo tail) — the creator's embedded
 * permissions block is the full owner triple regardless of the generic
 * viewer matrix (the doer just created the repo; the org-owner doer is not
 * the `ownerNamespace` login the generic predicate matches on).
 */
export function toCreatedOrgRepository(viewer: Viewer, pair: RepositoryWithOwner): Repository {
  return {
    ...toApiRepository(viewer, pair),
    permissions: { admin: true, push: true, pull: true },
  };
}

/** Re-export for the route's User-typed doer → OrgDoer narrowing. */
export function orgDoerOf(doer: User): OrgDoer & { id: number } {
  // The contract `User` mirror has no required fields, but the auth middleware
  // only ever resolves D1-backed identities — an authenticated principal
  // without an id cannot exist, so a missing id is an invalid credential and
  // takes upstream's reqToken answer (same convention as the api middlewares).
  if (doer.id === undefined) {
    throw new ApiError(401, "token is required");
  }
  return { id: doer.id, isAdmin: doer.is_admin === true };
}
