import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { orgMembers, users } from "../../db/schema";
import { LastOrgOwnerError, OrgError } from "../../services/orgs/errors";
import { OrgService, type ListOptions, type OrgMembershipRecord, type OrgRecord } from "../../services/orgs/orgs";
import { ApiError } from "../errors";
import type { EditOrgOption } from "../models/organization";
import { orgVisibleToDoer, type OrgDoer } from "./org-repos";

/**
 * Tier-2 organization routes' service half (SPEC-0004 appendix A rows
 * `/orgs/{org}` GET/PATCH, `/orgs/{org}/members…`, `/orgs/{org}/public_members…`):
 * the upstream guard predicates, member listings, membership-visibility flips
 * and the `EditOrgOption` apply. Storage rides the landed org service
 * (src/services/orgs/orgs.ts — SPEC-0007's org-as-user-row model); this module
 * adds only what the routes need beyond it, mirroring upstream:
 *
 *   - `orgAssignment` + `RedirectToUser` (routers/api/v1/api.go:610–640,
 *     services/context/context_response.go:28–56) — resolveOrgForRequest;
 *   - `reqOrgVisible` / `reqOrgOwnership` / `reqOrgMembership`
 *     (routers/api/v1/api.go:452–475, 422–450, 546–573) — the require* guards;
 *   - `org.ListMembers`/`ListPublicMembers` (routers/api/v1/org/member.go:17–126
 *     over `FindOrgMembersOpts.PublicOnly`, models/organization/org.go:180–182)
 *     — orgMembersPublicOnly + listOrgMemberRows;
 *   - `ChangeOrgUserStatus` (models/organization/org.go:498–513) and
 *     `checkCanChangeOrgUserStatus` (routers/api/v1/org/member.go:243–259)
 *     — requireCanChangeOrgUserStatus + setOrgMembershipPublic;
 *   - `org.Edit` (routers/api/v1/org/org.go:373–413 over
 *     `user_service.UpdateOptions`) — editOrgProfile.
 *
 * Public-only tokens (`DoerCanViewPrivate`, models/user/user_extdata.go:110–112)
 * are not modeled in the api identity yet: a resolved doer is always
 * private-capable, so every doer parameter here is `OrgDoer | null`.
 */

/** The authenticated doer slice the guards need (null = anonymous). */
export type OrgProfileDoer = OrgDoer;

/** D1 row of the `users` table — member listings return these for the
 *  routes' `toApiUser` projection (same shape as services/user.ts). */
export type MemberUserRow = typeof users.$inferSelect;

/**
 * `DoerCanViewPrivate` (user_extdata.go:110–112) at the landed tier: doer
 * present ⇔ private-capable. The public-only-token downgrade and the
 * `IsRestricted` arm have no schema yet (SPEC-0002 scope gates pending).
 */
export function doerCanViewPrivate(doer: OrgProfileDoer | null): boolean {
  return doer !== null && doer.id !== null;
}

/** `DoerIsSiteAdminFullAccess` reduced to the modeled axis (site admin). */
export function doerIsAdminFullAccess(doer: OrgProfileDoer | null): boolean {
  return doer !== null && doer.isAdmin;
}

// ---------------------------------------------------------------------------
// Org resolution + the rename-redirect seam (orgAssignment + RedirectToUser)
// ---------------------------------------------------------------------------

export type ResolvedOrg =
  | { kind: "org"; org: OrgRecord }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * The `/orgs/{org}` group's context half (`orgAssignment(true)`,
 * api.go:1725/1786): resolve the org by name; on a miss, consult the
 * `user_redirects` table (`LookupUserRedirect`) and — when the renamed
 * target's visibility satisfies the coarse `RedirectToUser` gate
 * (context_response.go:40–47: non-public needs a signed-in, non-public-only
 * doer; NO membership arm, coarser than `HasOrgOrUserVisible`) — answer with
 * the 307 seam: the caller replaces the FIRST occurrence of the old name in
 * the request path (query preserved) and redirects. Everything else reads as
 * the shared 404-shaped miss (`APIErrorNotFound`; a plain user under /orgs is
 * equally a miss — SPEC-0007 §4.11's type filter).
 */
export async function resolveOrgForRequest(
  d1: D1Database,
  orgName: string,
  doer: OrgProfileDoer | null,
  requestPath: string,
  requestQuery: string,
): Promise<ResolvedOrg> {
  const orgs = new OrgService(d1);
  const org = await orgs.getOrgByUsername(orgName);
  if (org !== null) {
    return { kind: "org", org };
  }
  const redirectUserId = await orgs.lookupUserRedirect(orgName);
  if (redirectUserId === null) {
    return { kind: "missing" };
  }
  const target = await orgs.getOrgById(redirectUserId);
  if (target === null) {
    return { kind: "missing" };
  }
  if (target.visibility !== "public" && !doerCanViewPrivate(doer)) {
    // "We must be signed in to see limited or private organizations"
    // (context_response.go:41–44) — indistinguishable from a miss.
    return { kind: "missing" };
  }
  // RedirectToUser (context_response.go:47–55): first occurrence of the old
  // name in the escaped path → the new display name; query string preserved.
  // Org names are URL-path-safe (`^[\da-zA-Z][-.\w]*$`), so a raw substring
  // replace is the escaped-path replace.
  let location = requestPath.replace(orgName, target.username);
  if (requestQuery !== "") {
    location += `?${requestQuery}`;
  }
  return { kind: "redirect", location };
}

// ---------------------------------------------------------------------------
// Route guards (upstream middlewares, org context)
// ---------------------------------------------------------------------------

/**
 * `reqOrgVisible` (api.go:452–475): the org must be visible to the doer
 * (`HasOrgOrUserVisible`) — invisible orgs are indistinguishable from
 * missing ones (APIErrorNotFound).
 */
export async function requireOrgVisible(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer | null): Promise<void> {
  if (!(await orgVisibleToDoer(orgs, org, doer ?? { id: null, isAdmin: false }))) {
    throw new ApiError(404, "not found");
  }
}

/**
 * `reqOrgOwnership` (api.go:422–450), org context: org owner
 * (`IsOrganizationOwner` — the tier-1 `role='owner'` collapse, SPEC-0007
 * §3.3) or site admin, else the exact upstream 403 message.
 */
export async function requireOrgOwnership(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<void> {
  if (doer.isAdmin) return;
  if (doer.id === null || !(await orgs.canCreateOrgRepo(org.id, doer.id))) {
    throw new ApiError(403, "Must be an organization owner");
  }
}

/**
 * `reqOrgMembership` (api.go:546–573), org context: member or site admin,
 * else the exact upstream 403 message.
 */
export async function requireOrgMembership(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<void> {
  if (doer.isAdmin) return;
  if (doer.id === null || (await orgs.getMembership(org.id, doer.id)) === null) {
    throw new ApiError(403, "Must be an organization member");
  }
}

// ---------------------------------------------------------------------------
// Members + public members (org.ListMembers / ListPublicMembers family)
// ---------------------------------------------------------------------------

/**
 * `FindOrgMembersOpts.PublicOnly` (models/organization/org.go:180–182):
 * `!DoerCanViewPrivate(doer) || !(isDoerMember || DoerIsSiteAdminFullAccess)`.
 * The restricted-principal arm of the non-public filter
 * (applyTeamMatesOnlyFilter, org.go:214–226) is unreachable — no
 * users.restricted column yet.
 */
export function orgMembersPublicOnly(doer: OrgProfileDoer | null, isDoerMember: boolean): boolean {
  return !doerCanViewPrivate(doer) || !(isDoerMember || doerIsAdminFullAccess(doer));
}

/** `IsOrgMember` for the listing handlers (doer-gated callers only). */
export async function isDoerOrgMember(orgs: OrgService, org: OrgRecord, doer: OrgProfileDoer): Promise<boolean> {
  if (doer.id === null) return false;
  return (await orgs.getMembership(org.id, doer.id)) !== null;
}

/**
 * One page of `GET /orgs/{org}/members` or `/public_members`:
 * `GetOrgUsersByOrgID` (models/organization/org.go:473–495) — org_members
 * joined to their users, `is_public = true` filtered when publicOnly,
 * ordered `org_user.uid ASC`, paginated upstream's silent-clamp way
 * (page/limit already clamped by the routes' parseListOptions).
 */
export async function listOrgMemberRows(
  d1: D1Database,
  orgId: number,
  publicOnly: boolean,
  options: ListOptions,
): Promise<{ items: Array<{ user: MemberUserRow; membership: OrgMembershipRecord }>; total: number }> {
  const db = drizzle(d1);
  const where = publicOnly
    ? and(eq(orgMembers.orgId, orgId), eq(orgMembers.isPublic, true))
    : eq(orgMembers.orgId, orgId);
  const limit = options.pageSize ?? 30;
  const offset = ((options.page ?? 1) - 1) * limit;
  const rows = await db
    .select({ membership: orgMembers, user: users })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(where)
    .orderBy(asc(orgMembers.userId))
    .limit(limit)
    .offset(offset);
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(orgMembers)
    .where(where)
    .get();
  return {
    items: rows.map((row) => ({ user: row.user, membership: row.membership })),
    total: totalRow?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Membership visibility flips (ChangeOrgUserStatus + the change guard)
// ---------------------------------------------------------------------------

/**
 * `checkCanChangeOrgUserStatus` (routers/api/v1/org/member.go:243–259): the
 * target themself, a site admin, or an org owner may flip membership
 * visibility — everyone else gets the exact upstream 403. (Upstream wires
 * `reqOrgMembership` in front of this, so the reachable non-owner case is a
 * member touching someone else's flag.)
 */
export async function requireCanChangeOrgUserStatus(
  orgs: OrgService,
  org: OrgRecord,
  doer: OrgProfileDoer,
  targetUserId: number,
): Promise<void> {
  if (doer.id !== null && (doer.isAdmin || doer.id === targetUserId)) return;
  if (doer.id !== null && (await orgs.canCreateOrgRepo(org.id, doer.id))) return;
  throw new ApiError(403, "Cannot change member visibility");
}

/**
 * `ChangeOrgUserStatus` (models/organization/org.go:498–513): flips
 * `org_members.is_public` when a membership row exists; a non-member target
 * is the upstream silent no-op (the API answers 204 either way).
 */
export async function setOrgMembershipPublic(
  d1: D1Database,
  orgId: number,
  userId: number,
  isPublic: boolean,
): Promise<void> {
  await drizzle(d1)
    .update(orgMembers)
    .set({ isPublic })
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
}

// ---------------------------------------------------------------------------
// PATCH /orgs/{org} (org.Edit)
// ---------------------------------------------------------------------------

/**
 * `org.Edit` (routers/api/v1/org/org.go:373–413) reduced to the landed
 * columns: apply only the fields the body PRESENTS (Go pointers; empty string
 * clears), guarded to org rows. The rename field does not exist here —
 * `POST /orgs/{org}/rename` (service `renameOrg`) is the surface that rides
 * the redirect rule.
 *
 * Documented divergences (the contract declares only {200, 404}, so the
 * upstream 422 binding failures are not reproducible as declared statuses):
 * field length caps (`MaxSize(50..255)`) and `ValidUrl` are not enforced, and
 * `UpdateOrgEmailAddress`'s `ValidateEmail` 422 (services/org/org.go:197–210)
 * is skipped — a malformed email is stored as given. An out-of-enum
 * `visibility` dies in the request validator instead (runtime-only 400, same
 * class as the documented /markdown 400).
 */
export async function editOrgProfile(d1: D1Database, org: OrgRecord, form: EditOrgOption): Promise<OrgRecord> {
  const patch: Partial<typeof users.$inferInsert> = {};
  if (form.full_name !== undefined) patch.fullName = form.full_name;
  if (form.description !== undefined) patch.description = form.description;
  if (form.website !== undefined) patch.website = form.website;
  if (form.location !== undefined) patch.location = form.location;
  if (form.email !== undefined) patch.email = form.email;
  if (form.visibility !== undefined) patch.visibility = form.visibility;
  if (form.repo_admin_change_team_access !== undefined) {
    patch.repoAdminChangeTeamAccess = form.repo_admin_change_team_access;
  }
  if (Object.keys(patch).length > 0) {
    await drizzle(d1)
      .update(users)
      .set(patch)
      .where(and(eq(users.id, org.id), eq(users.type, "org")));
  }
  const updated = await new OrgService(d1).getOrgById(org.id);
  if (updated === null) {
    // The re-read lost the row mid-flight — a bare 500, upstream
    // APIErrorInternal-shaped (blanked message in prod).
    throw new Error(`org disappeared during edit: ${org.id}`);
  }
  return updated;
}

/**
 * The OrgError → ApiError mapping the errors module promised ("the future
 * route batches map them 1:1"). The one deliberate exception is
 * `LastOrgOwnerError`: upstream routes it through `APIErrorInternal` → a 500
 * whose message is blanked in prod (routers/api/v1/org/member.go:338–343,
 * SPEC-0007 §4.3) — rethrowing it UNMAPPED lands in giteaErrorHandler's
 * default branch, which is exactly that 500-with-blank-message.
 */
export function mapOrgError(error: unknown): Error {
  if (error instanceof LastOrgOwnerError) {
    return error;
  }
  if (error instanceof OrgError) {
    return new ApiError(error.status, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}
