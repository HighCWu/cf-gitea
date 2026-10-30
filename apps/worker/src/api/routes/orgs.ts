import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { users } from "../../db/schema";
import { OrgNameCollisionError } from "../../services/orgs/errors";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createOrgOptionSchema,
  editOrgOptionSchema,
  organizationListSchema,
  organizationPermissionsSchema,
  organizationSchema,
  renameOrgOptionSchema,
} from "../models/organization";
import { userListSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { orgDoerOf, toApiOrganization } from "../services/org-repos";
import {
  doerCanViewPrivate,
  doerViewOtherVisibility,
  editOrgProfile,
  isDoerOrgMember,
  listOrgMemberRows,
  listVisibleOrgs,
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
import { findUserByName, viewerOf } from "../services/repository";
import { toApiUser } from "../services/user";

/**
 * Tier-2 `organization`-tagged routes (SPEC-0004 appendix A, category a):
 * `GET/PATCH/DELETE /orgs/{org}` (orgGet/orgEdit/orgDelete), `POST
 * /orgs/{org}/rename` (renameOrg), `GET /orgs` (orgGetAll), `POST /orgs`
 * (orgCreate), `GET /users/{username}/orgs` (orgListUserOrgs), `GET
 * /users/{username}/orgs/{org}/permissions` (orgGetUserPermissions),
 * `GET /orgs/{org}/members` + `GET/DELETE …/members/{username}`
 * (orgListMembers/orgIsMember/orgDeleteMember), `GET /orgs/{org}/public_members`
 * + `GET/PUT/DELETE …/public_members/{username}` (orgListPublicMembers/
 * orgIsPublicMember/orgPublicizeMember/orgConcealMember). Teams
 * (`/orgs/{org}/teams…`) are STUB-DEFERRED per SPEC-0007 §3.5.
 *
 * Declared responses mirror the vendored contract exactly; the RUNTIME-ONLY
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 exception):
 *   - GET /orgs:                             none — anonymous allowed, 200-only
 *                                            contract (org.go:184–234 has no
 *                                            auth middleware)
 *   - POST /orgs:                            401 (reqToken, api.go:1723) — the
 *                                            declared 403 "not allowed to
 *                                            create org" is UNREACHABLE at
 *                                            the landed tier: the
 *                                            CanCreateOrganization gate is
 *                                            `IsAdmin ||
 *                                            AllowCreateOrganization &&
 *                                            !DisableRegularOrgCreation`
 *                                            (user.go:301–303) and both
 *                                            settings default open with no
 *                                            allow_create_organization column;
 *                                            400 (out-of-enum visibility dies
 *                                            in the request validator;
 *                                            upstream binding 422s)
 *   - GET /users/{username}/orgs:            401 (reqToken, api.go:1720)
 *   - GET /users/{username}/orgs/{org}/permissions:
 *                                            401 (reqToken); the declared 403
 *                                            is unreachable upstream too
 *                                            (individualPermsChecker 404s,
 *                                            api.go:922–927)
 *   - POST /orgs/{org}/rename:               401 (reqToken), 403
 *                                            (reqOrgOwnership "Must be an
 *                                            organization owner"), 307
 *                                            (renamed org — the group
 *                                            orgAssignment answers before
 *                                            reqToken), 400 (missing
 *                                            new_name dies in the validator;
 *                                            upstream bind 422s)
 *   - DELETE /orgs/{org}:                    401 (reqToken), 403
 *                                            (reqOrgOwnership), 307 (renamed
 *                                            org), 500 (org owns repos —
 *                                            ErrUserOwnRepos rides
 *                                            APIErrorInternal, message
 *                                            blanked in prod; org.go:423–446
 *                                            maps every DeleteOrganization
 *                                            error to the internal error)
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
 * SPEC-0002 scope wave. Token-scope categories (tokenRequiresScopes) are
 * mounted tree-wide since the auth-parity H1 wave (src/api/router.ts's
 * apiScopeGate — the /orgs rows carry `organization`, with the repo create/
 * delete arms adding `repository` per api.go:1731,1733).
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

const orgGetAllRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Get list of organizations",
    operationId: "orgGetAll",
    request: listQuery,
    responses: {
      200: {
        description: "OrganizationList",
        content: { "application/json": { schema: organizationListSchema } },
      },
    },
  });

const orgCreateRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create an organization",
    operationId: "orgCreate",
    request: {
      body: { content: { "application/json": { schema: createOrgOptionSchema } } },
    },
    responses: {
      201: {
        description: "Organization",
        content: { "application/json": { schema: organizationSchema } },
      },
      403: forbiddenResponse,
      422: {
        description: "validationError",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });

const orgListUserOrgsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/orgs",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List a user's organizations",
    operationId: "orgListUserOrgs",
    request: {
      ...listQuery,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose organizations are to be listed" }),
      }),
    },
    responses: {
      200: {
        description: "OrganizationList",
        content: { "application/json": { schema: organizationListSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgGetUserPermissionsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/orgs/{org}/permissions",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Get user permissions in organization",
    operationId: "orgGetUserPermissions",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose permissions are to be obtained" }),
        org: z.string().min(1).openapi({ description: "name of the organization" }),
      }),
    },
    responses: {
      200: {
        description: "OrganizationPermissions",
        content: { "application/json": { schema: organizationPermissionsSchema } },
      },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const orgRenameRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/rename",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Rename an organization",
    operationId: "renameOrg",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "existing org name" }),
      }),
      body: { content: { "application/json": { schema: renameOrgOptionSchema } } },
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      422: {
        description: "validationError",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });

const orgDeleteRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete an organization",
    operationId: "orgDelete",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "organization that is to be deleted" }),
      }),
    },
    responses: {
      204: { description: "empty" },
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

  // GET /orgs — anonymous allowed (no auth middleware upstream, api.go:1724);
  // the Visible ladder widens per doer: public → +limited (signed-in) →
  // +private (site admin). Unlike Get, GetAll does NOT blank email —
  // ToOrganization renders the column verbatim (convert.go:928–942).
  app.openapi(orgGetAllRoute(optionalAuth), async (c) => {
    const doer = optionalDoer(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listVisibleOrgs(c.env.DB, doer, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const origin = new URL(c.req.url).origin;
    return c.json(items.map((org) => toApiOrganization(org, { origin, includeEmail: true })), 200);
  });

  // POST /orgs — reqToken upstream; CreateOrganization via the landed
  // service (creator gets the role='owner' row in the same batch). The
  // CanCreateOrganization 403 is unreachable at the landed tier (header
  // doc); upstream 422s the name errors with err.Error() (org.go:280–289).
  app.openapi(orgCreateRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const form = c.req.valid("json");
    let org: OrgRecord;
    try {
      org = await new OrgService(c.env.DB).createOrg({
        name: form.username,
        ownerId: doer.id,
        visibility: form.visibility ?? "public",
        fullName: form.full_name ?? null,
        description: form.description ?? null,
        website: form.website ?? null,
        location: form.location ?? null,
        email: form.email ?? null,
        repoAdminChangeTeamAccess: form.repo_admin_change_team_access,
      });
    } catch (error) {
      throw mapOrgNameError(error);
    }
    const origin = new URL(c.req.url).origin;
    return c.json(toApiOrganization(org, { origin, includeEmail: true }), 201);
  });

  // GET /users/{username}/orgs — reqToken upstream (api.go:1719–1722). The
  // SUBJECT is the {username} param — UserAssignmentAPI is type-blind and
  // answers the 404-shaped miss for missing names (the landed /users shape
  // keeps no redirect seam); org subjects are a type-blind upstream quirk
  // (an org holds no memberships ⇒ 200 []). The ceiling is
  // DoerViewOtherVisibility(doer, subject): self/admin ⇒ private, anonymous
  // ⇒ public, everyone else ⇒ limited (org.go:38–59, org_list.go:79–90).
  app.openapi(orgListUserOrgsRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { username } = c.req.valid("param");
    const subject = await findUserByName(c.env.DB, username);
    if (subject === null) {
      throw orgNotFound();
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await new OrgService(c.env.DB).listUserOrgs(subject.id, {
      maxVisibility: doerViewOtherVisibility(doer, subject.id),
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const origin = new URL(c.req.url).origin;
    return c.json(items.map((org) => toApiOrganization(org, { origin, includeEmail: true })), 200);
  });

  // GET /users/{username}/orgs/{org}/permissions — reqToken upstream. The
  // {org} param resolves via GetUserByPathParam (user/helper.go:13–28):
  // TYPE-BLIND (a plain user is a valid answer — no team rows to aggregate
  // ⇒ all-false), the user_redirect 307 seam on a renamed target, else 404;
  // found org rows then pass HasOrgOrUserVisible. The authorize ladder
  // collapses to the Owners row (SPEC-0007 §3.3): role='owner' ⇒ authorize
  // owner (every boolean true), anything else ⇒ none (GetOrgUserMaxAuthorize
  // Level aggregates team rows, org.go:416–426 — plain members have none);
  // can_create_repository is the same owner grant (§3.4). The declared 403
  // is unreachable upstream too (individualPermsChecker 404s, api.go:922–927).
  app.openapi(orgGetUserPermissionsRoute(requireAuth), async (c) => {
    const { username, org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const subject = await findUserByName(c.env.DB, username);
    if (subject === null) {
      throw orgNotFound();
    }
    const orgRow = await findOrgParamRow(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    if (orgRow.type === "org") {
      const org = await orgs.getOrgById(orgRow.id);
      if (org === null) throw orgNotFound();
      await requireOrgVisible(orgs, org, doer);
    }
    const membership = await orgs.getMembership(orgRow.id, subject.id);
    const authorize = orgRow.type === "org" && membership?.role === "owner" ? 4 : 0;
    const canCreateRepository =
      orgRow.type === "org" && (await orgs.canCreateOrgRepo(orgRow.id, subject.id));
    return c.json(
      {
        can_read: authorize > 0,
        can_write: authorize > 1,
        is_admin: authorize > 2,
        is_owner: authorize > 3,
        can_create_repository: canCreateRepository,
      },
      200,
    );
  });

  // POST /orgs/{org}/rename — reqToken + reqOrgOwnership; the landed
  // renameOrg service carries the whole RenameUser port (name rules, the
  // shared-namespace collision, the NewUserRedirect write rule, the
  // owner_namespace rewrite). Upstream 422s the name errors with err.Error()
  // (org.go:356–365); success is the bare 204.
  app.openapi(orgRenameRoute(requireAuth), async (c) => {
    const { org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgOwnership(orgs, org, doer);
    const form = c.req.valid("json");
    try {
      await orgs.renameOrg(org.id, form.new_name);
    } catch (error) {
      throw mapOrgNameError(error);
    }
    return c.body(null, 204);
  });

  // DELETE /orgs/{org} — reqToken + reqOrgOwnership (no reqOrgVisible —
  // ownership implies the membership; upstream wires the same pair on the
  // Combo, api.go:1727–1728). The repository guard rides the service and
  // surfaces as the blanked APIErrorInternal 500 (header doc); the cascade
  // (memberships + redirects + the org users row, one batch) is
  // DeleteOrganization's deleteOrganization port.
  app.openapi(orgDeleteRoute(requireAuth), async (c) => {
    const { org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const { org } = await resolveOrg(c, orgName, doer);
    const orgs = new OrgService(c.env.DB);
    await requireOrgOwnership(orgs, org, doer);
    try {
      await orgs.deleteOrg(org.id);
    } catch (error) {
      throw mapOrgError(error);
    }
    return c.body(null, 204);
  });
}

// ---------------------------------------------------------------------------
// Local helpers (route-thin glue)
// ---------------------------------------------------------------------------

/**
 * The create/rename name-error mapping (org.go:280–289, 356–365): upstream
 * routes `IsErrUserAlreadyExist` — the shared user/org namespace collision —
 * through the DECLARED 422 (`err.Error()` body), not the 409 the typed error
 * carries for the repo-family convention; the remaining name errors ride
 * their own ported 422s via mapOrgError.
 */
function mapOrgNameError(error: unknown): Error {
  if (error instanceof OrgNameCollisionError) {
    return new ApiError(422, error.message);
  }
  return mapOrgError(error);
}

/**
 * The `org` path param of /users/{username}/orgs/{org}/permissions —
 * GetUserByPathParam (routers/api/v1/user/helper.go:13–28): a TYPE-BLIND
 * name lookup (a plain user row is a valid answer — the handler's authorize
 * ladder reads zero), then the user_redirect seam (RedirectToUser: the first
 * path occurrence replaced, query preserved, gated on the target's
 * visibility) on a renamed target, else the shared 404-shaped miss.
 */
async function findOrgParamRow(
  c: Context<ApiEnv>,
  name: string,
  doer: OrgProfileDoer,
): Promise<MemberTargetRow> {
  const row = await findUserByName(c.env.DB, name);
  if (row !== null) {
    return row;
  }
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    name,
    doer,
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") {
    throw renamedOrgRedirect(resolved.location);
  }
  throw orgNotFound();
}

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
