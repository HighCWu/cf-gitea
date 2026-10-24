import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { users } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { editOrgOptionSchema, organizationSchema } from "../models/organization";
import { userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { orgDoerOf, toApiOrganization } from "../services/org-repos";
import {
  doerCanViewPrivate,
  editOrgProfile,
  isDoerOrgMember,
  listOrgMemberRows,
  mapOrgError,
  orgMembersPublicOnly,
  requireCanChangeOrgUserStatus,
  requireOrgMembership,
  requireOrgOwnership,
  requireOrgVisible,
  resolveOrgForRequest,
  setOrgMembershipPublic,
  type OrgProfileDoer,
} from "../services/orgs";
import { toApiUser } from "../services/user";
import { viewerOf } from "../services/repository";

/**
 * Tier-2 `organization`-tagged routes (SPEC-0004 appendix A, category a):
 * `GET/PATCH /orgs/{org}` (orgGet/orgEdit), `GET /orgs/{org}/members` +
 * `GET/DELETE …/members/{username}` (orgListMembers/orgIsMember/
 * orgDeleteMember), `GET /orgs/{org}/public_members` +
 * `GET/PUT/DELETE …/public_members/{username}` (orgListPublicMembers/
 * orgIsPublicMember/orgPublicizeMember/orgConcealMember). Teams
 * (`/orgs/{org}/teams…`) are STUB-DEFERRED per SPEC-0007 §3.5.
 *
 * Declared responses mirror the vendored contract exactly; the RUNTIME-ONLY
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 exception):
 *   - GET /orgs/{org}:                        307 — renamed-org redirect
 *                                             (orgAssignment → RedirectToUser)
 *   - PATCH /orgs/{org}:                      401 (reqToken), 403 (reqOrgOwnership
 *                                             "Must be an organization owner"),
 *                                             307 (renamed org — upstream answers
 *                                             it before reqToken, group
 *                                             middleware runs first), 400
 *                                             (out-of-enum visibility dies in the
 *                                             request validator; upstream 422s
 *                                             the binding)
 *   - GET /orgs/{org}/members:                401 (reqToken), 307
 *   - GET /orgs/{org}/members/{username}:     401, 307
 *   - DELETE /orgs/{org}/members/{username}:  401, 403 ("Must be an organization
 *                                             owner"), 307, 500 (last-owner guard
 *                                             — upstream APIErrorInternal with the
 *                                             message blanked in prod; SPEC-0007
 *                                             §4.3)
 *   - GET /orgs/{org}/public_members:         307
 *   - GET …/public_members/{username}:        307
 *   - PUT/DELETE …/public_members/{username}: 401 (reqToken), 403 ("Must be an
 *                                             organization member" /
 *                                             "Cannot change member visibility"),
 *                                             307
 *
 * Public-only tokens are unmodeled (services/orgs.ts header) — the
 * `rejectPublicOnly` gate upstream runs inside reqOrgOwnership lands with the
 * SPEC-0002 scope wave.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** Shared 404 for org/user-scoped misses (missing org, plain user under /orgs,
 *  invisible org, missing member target — all indistinguishable upstream:
 *  APIErrorNotFound → "not found"). */
function orgNotFound(): ApiError {
  return new ApiError(404, "not found");
}

/**
 * The renamed-org 307 as a thrown HTTPException carrying its prepared
 * response: the route's declared response union stays {200, 404}-shaped (the
 * contract's set) while giteaErrorHandler passes the prepared 307 — Location
 * + empty body — through untouched (errors.ts).
 */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/** Doer slice for optional-auth org routes (null = anonymous). */
function optionalDoer(c: Context<ApiEnv>): OrgProfileDoer | null {
  const requester = c.get("authUser");
  return requester === undefined ? null : orgDoerOf(requester);
}

/**
 * The orgAssignment seam every route here shares: the resolved org, or a
 * thrown 307 for renamed orgs (see renamedOrgRedirect), or a thrown
 * 404-shaped miss.
 */
async function resolveOrg(
  c: Context<ApiEnv>,
  orgName: string,
  doer: OrgProfileDoer | null,
): Promise<{ kind: "org"; org: OrgRecord }> {
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    orgName,
    doer,
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") {
    throw renamedOrgRedirect(resolved.location);
  }
  if (resolved.kind === "missing") {
    throw orgNotFound();
  }
  return { kind: "org", org: resolved.org };
}

// ---------------------------------------------------------------------------
// Route declarations — responses mirror the vendored contract field-for-field
// ---------------------------------------------------------------------------

const orgGetRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Get an organization",
    operationId: "orgGet",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization to get" }),
      }),
    },
    responses: {
      200: {
        description: "Organization",
        content: { "application/json": { schema: organizationSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgEditRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Edit an organization",
    operationId: "orgEdit",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization to edit" }),
      }),
      body: { content: { "application/json": { schema: editOrgOptionSchema } } },
    },
    responses: {
      200: {
        description: "Organization",
        content: { "application/json": { schema: organizationSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgListMembersRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/members",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List an organization's members",
    operationId: "orgListMembers",
    request: {
      ...listQuery,
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
      }),
    },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgIsMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Check if a user is a member of an organization",
    operationId: "orgIsMember",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user to check for an organization membership" }),
      }),
    },
    responses: {
      204: { description: "user is a member" },
      303: { description: "redirection to /orgs/{org}/public_members/{username}" },
      404: { description: "user is not a member" },
    },
  });

const orgDeleteMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Remove a member from an organization",
    operationId: "orgDeleteMember",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user to remove from the organization" }),
      }),
    },
    responses: {
      204: { description: "member removed" },
      404: notFoundResponse,
    },
  });

const orgListPublicMembersRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/public_members",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List an organization's public members",
    operationId: "orgListPublicMembers",
    request: {
      ...listQuery,
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
      }),
    },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgIsPublicMemberRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/public_members/{username}",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Check if a user is a public member of an organization",
    operationId: "orgIsPublicMember",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user to check for a public organization membership" }),
      }),
    },
    responses: {
      204: { description: "user is a public member" },
      404: { description: "user is not a public member" },
    },
  });

const orgPublicizeMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/orgs/{org}/public_members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Publicize a user's membership",
    operationId: "orgPublicizeMember",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose membership is to be publicized" }),
      }),
    },
    responses: {
      204: { description: "membership publicized" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const orgConcealMemberRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/public_members/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Conceal a user's membership",
    operationId: "orgConcealMember",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose membership is to be concealed" }),
      }),
    },
    responses: {
      204: { description: "membership concealed" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

export function registerOrgProfileRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // GET /orgs/{org} — anonymous allowed; handler-level HasOrgOrUserVisible
  // (org.go:324–327) 404s invisible orgs; email is blanked for anonymous
  // callers (org.go:335–338).
  app.openapi(orgGetRoute(optionalAuth), async (c) => {
    const doer = optionalDoer(c);
    const { org: orgName } = c.req.valid("param");
    const { org } = await resolveOrg(c, orgName, doer);
    await requireOrgVisible(new OrgService(c.env.DB), org, doer);
    const origin = new URL(c.req.url).origin;
    return c.json(toApiOrganization(org, { origin, includeEmail: doer !== null }), 200);
  });

  // PATCH /orgs/{org} — reqToken + reqOrgOwnership upstream; answers the
  // edited Organization (email visible: the doer is authenticated). No name
  // field — renames ride POST /orgs/{org}/rename (T2, service landed).
  app.openapi(orgEditRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName } = c.req.valid("param");
    const { org } = await resolveOrg(c, orgName, doer);
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);
    const form = c.req.valid("json");
    const updated = await editOrgProfile(c.env.DB, org, form);
    const origin = new URL(c.req.url).origin;
    return c.json(toApiOrganization(updated, { origin, includeEmail: true }), 200);
  });

  // GET /orgs/{org}/members — reqToken upstream (the swagger's declared 404 is
  // the /user/orgs-style stand-in; anonymous is answered 401 at runtime).
  // PublicOnly per FindOrgMembersOpts.
  app.openapi(orgListMembersRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName } = c.req.valid("param");
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    const publicOnly = orgMembersPublicOnly(doer, await isDoerOrgMember(orgs, org, doer));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOrgMemberRows(c.env.DB, org.id, publicOnly, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row.user)), 200);
  });

  // GET /orgs/{org}/members/{username} — the membership-oracle ladder
  // (member.go:144–182): member/admin → 204/404 by the target's membership;
  // a signed-in non-member checking themself → 404; everyone else is
  // redirected to the public-membership oracle (303).
  app.openapi(orgIsMemberRoute(requireAuth), async (c) => {
    const { org: orgName, username } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    const target = await findUserOr404(c.env.DB, username);
    if (doerCanViewPrivate(doer)) {
      if ((await isDoerOrgMember(orgs, org, doer)) || doer.isAdmin) {
        const membership = await orgs.getMembership(org.id, target.id);
        if (membership === null) throw orgNotFound();
        return c.body(null, 204);
      }
      if (doer.id === target.id) {
        throw orgNotFound();
      }
    }
    // Location = AppSubURL + /api/v1/… (member.go:178–181) — the mount prefix.
    const location = `/api/v1/orgs/${encodeURIComponent(org.username)}/public_members/${encodeURIComponent(target.username)}`;
    return c.body(null, 303, { Location: location });
  });

  // DELETE /orgs/{org}/members/{username} — reqOrgOwnership; the non-member
  // target takes upstream's early return (services/org/user.go:31–35:
  // `!has → return nil` BEFORE any write, so num_members is untouched — the
  // route checks membership first for exactly that reason); the §4.3
  // last-owner guard surfaces as the unmapped 500 (APIErrorInternal, message
  // blanked in prod).
  app.openapi(orgDeleteMemberRoute(requireAuth), async (c) => {
    const { org: orgName, username } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    await requireOrgOwnership(orgs, org, doer);
    const target = await findUserOr404(c.env.DB, username);
    if ((await orgs.getMembership(org.id, target.id)) === null) {
      return c.body(null, 204);
    }
    try {
      await orgs.removeMember(org.id, target.id);
    } catch (error) {
      throw mapOrgError(error);
    }
    return c.body(null, 204);
  });

  // GET /orgs/{org}/public_members — anonymous allowed; ListPublicMembers
  // passes isDoerMember=false, so a site admin sees ALL members (the mirrored
  // upstream quirk: DoerIsSiteAdminFullAccess disables PublicOnly) while
  // anonymous and plain users see only is_public rows.
  app.openapi(orgListPublicMembersRoute(optionalAuth), async (c) => {
    const doer = optionalDoer(c);
    const { org: orgName } = c.req.valid("param");
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    const publicOnly = orgMembersPublicOnly(doer, false);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOrgMemberRows(c.env.DB, org.id, publicOnly, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row.user)), 200);
  });

  // GET /orgs/{org}/public_members/{username} — 204 iff is_public
  // (IsPublicMembership → 204/404, member.go:185–222).
  app.openapi(orgIsPublicMemberRoute(optionalAuth), async (c) => {
    const { org: orgName, username } = c.req.valid("param");
    const doer = optionalDoer(c);
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    const target = await findUserOr404(c.env.DB, username);
    const membership = await orgs.getMembership(org.id, target.id);
    if (membership !== null && membership.isPublic) {
      return c.body(null, 204);
    }
    throw orgNotFound();
  });

  // PUT/DELETE /orgs/{org}/public_members/{username} — reqOrgMembership then
  // checkCanChangeOrgUserStatus (self / admin / owner); ChangeOrgUserStatus
  // no-ops for non-member targets (still 204).
  const flipMembership = async (
    c: Context<ApiEnv>,
    orgName: string,
    username: string,
    isPublic: boolean,
  ): Promise<Response> => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    await requireOrgMembership(orgs, org, doer);
    const target = await findUserOr404(c.env.DB, username);
    await requireCanChangeOrgUserStatus(orgs, org, doer, target.id);
    await setOrgMembershipPublic(c.env.DB, org.id, target.id, isPublic);
    return c.body(null, 204);
  };

  app.openapi(orgPublicizeMemberRoute(requireAuth), async (c) => {
    const { org: orgName, username } = c.req.valid("param");
    return flipMembership(c, orgName, username, true);
  });
  app.openapi(orgConcealMemberRoute(requireAuth), async (c) => {
    const { org: orgName, username } = c.req.valid("param");
    return flipMembership(c, orgName, username, false);
  });
}

// ---------------------------------------------------------------------------
// Local helpers (route-thin glue)
// ---------------------------------------------------------------------------

/** D1 row of the `users` table — the member-target lookup's shape. */
type MemberTargetRow = typeof users.$inferSelect;

/** Missing member targets are the same 404-shaped miss (userAssignment). */
async function findUserOr404(d1: D1Database, username: string): Promise<MemberTargetRow> {
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.usernameLower, username.toLowerCase()))
    .get();
  if (row === undefined) {
    throw orgNotFound();
  }
  return row;
}
