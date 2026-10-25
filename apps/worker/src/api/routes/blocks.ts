import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { userListSchema } from "../models/user";
import { orgDoerOf } from "../services/org-repos";
import { requireOrgOwnership, resolveOrgForRequest, type OrgProfileDoer } from "../services/orgs";
import {
  blockPartyFromUserRow,
  blockUser,
  isBlockedBy,
  listBlockedUsers,
  unblockUser,
  userDoesNotExistMessage,
} from "../services/blocks";
import { findUserByName, viewerOf } from "../services/repository";
import { toApiUser } from "../services/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";

/**
 * The user + org block octet (inventory batch 9 — upstream
 * `routers/api/v1/user/block.go` + `routers/api/v1/org/block.go`, both thin
 * shims over `routers/api/v1/shared/block.go`; storage + validation in
 * services/blocks.ts over the `user_blocking` table, migration
 * 0022_panoramic_bloodstorm).
 *
 * Auth wiring mirrors api.go verbatim (reduced to the landed token
 * middleware):
 *   - /user/blocks group: reqToken + contextAuthenticatedUser
 *     (api.go:1209-1216) → every route mounts requireAuth; 401s come from
 *     the middleware ("token is required").
 *   - /orgs/{org}/blocks group: reqToken + reqOrgOwnership
 *     (api.go:1778-1786) → requireAuth + the handler-level ownership guard
 *     (403 "Must be an organization owner", services/orgs.ts). ALL FOUR org
 *     ops sit behind ownership upstream — the reads included.
 *
 * Declared responses mirror the vendored contract exactly. Runtime-only
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 entry):
 *   - every route:               401 (reqToken, api.go:1211/1783)
 *   - org-scope routes:          307 renamed-org redirect (orgAssignment →
 *                                RedirectToUser; the routes/orgs.ts seam) —
 *                                upstream answers it BEFORE reqToken (the
 *                                outer group middleware), this module
 *                                answers after the 401 like the landed
 *                                org-teams precedent
 *   - PUT/DELETE both scopes:    400 — upstream maps ErrCanNotBlock /
 *                                ErrCanNotUnblock / ErrBlockOrganization to
 *                                http.StatusBadRequest
 *                                (shared/block.go:69-71, 87-89) while the
 *                                swagger declares 422; the declared-vs-
 *                                runtime mismatch is preserved verbatim,
 *                                tests assert the runtime 400 bodies.
 *
 * Scope decision note (batch 9): blocking is NOT wired into any read path
 * yet — blocked-user visibility enforcement (upstream's ErrBlockedUser 403
 * arms across follows/stars/watches/issues/pulls/git-push) is a documented
 * follow-up, mapped in services/blocks.ts' header.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const usernameParams = {
  params: z.object({
    username: z.string().min(1).openapi({ description: "username of the user to block" }),
  }),
} as const;

const orgUsernameParams = {
  params: z.object({
    org: z.string().min(1).openapi({ description: "name of the organization" }),
    username: z.string().min(1).openapi({ description: "username of the user to block" }),
  }),
} as const;

const orgParams = {
  params: z.object({
    org: z.string().min(1).openapi({ description: "name of the organization" }),
  }),
} as const;

const blockNoteQuery = {
  query: z.object({
    note: z.string().optional().openapi({ description: "optional note for the block" }),
  }),
} as const;

// ---------------------------------------------------------------------------
// Route declarations (operationIds are the contract's, verbatim)
// ---------------------------------------------------------------------------

const userListBlocksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/blocks",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List users blocked by the authenticated user",
    operationId: "userListBlocks",
    request: { ...listQuery },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
    },
  });

const userCheckUserBlockRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/blocks/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Check if a user is blocked by the authenticated user",
    operationId: "userCheckUserBlock",
    request: { ...usernameParams },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const userBlockUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/user/blocks/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Block a user",
    operationId: "userBlockUser",
    request: { ...usernameParams, ...blockNoteQuery },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const userUnblockUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/blocks/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Unblock a user",
    operationId: "userUnblockUser",
    request: { ...usernameParams },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const organizationListBlocksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/blocks",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List users blocked by the organization",
    operationId: "organizationListBlocks",
    request: { ...listQuery, ...orgParams },
    responses: {
      200: {
        description: "UserList",
        content: { "application/json": { schema: userListSchema } },
      },
    },
  });

const organizationCheckUserBlockRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/blocks/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Check if a user is blocked by the organization",
    operationId: "organizationCheckUserBlock",
    request: { ...orgUsernameParams },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const organizationBlockUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/orgs/{org}/blocks/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Block a user",
    operationId: "organizationBlockUser",
    request: { ...orgUsernameParams, ...blockNoteQuery },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const organizationUnblockUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/blocks/{username}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Unblock a user",
    operationId: "organizationUnblockUser",
    request: { ...orgUsernameParams },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The orgAssignment seam shared by the org-scoped routes (the org-teams
 *  resolveOrg shape: 307 on renames, the shared 404 on a miss). */
async function resolveOrg(c: Context<ApiEnv>, orgName: string, doer: OrgProfileDoer | null): Promise<OrgRecord> {
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    orgName,
    doer,
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") {
    throw new HTTPException(307, {
      res: new Response(null, { status: 307, headers: { Location: resolved.location } }),
    });
  }
  if (resolved.kind === "missing") {
    throw new ApiError(404, "not found");
  }
  return resolved.org;
}

/** The blockee lookup every username route shares — type-blind like
 *  upstream GetUserByName (orgs resolve, then hit the service's org arm). */
async function blockeeByName(d1: D1Database, username: string) {
  const row = await findUserByName(d1, username);
  if (row === null) {
    throw new ApiError(404, userDoesNotExistMessage(username));
  }
  return row;
}

export function registerBlockRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -- user scope (blocker = the doer) ------------------------------------

  app.openapi(userListBlocksRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listBlockedUsers(c.env.DB, doer.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((row) => toApiUser(viewerOf(c), row)), 200);
  });

  app.openapi(userCheckUserBlockRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { username } = c.req.valid("param");
    const blockee = await blockeeByName(c.env.DB, username);
    if (await isBlockedBy(c.env.DB, doer.id, blockee.id)) {
      return c.body(null, 204);
    }
    // Upstream answers the bare status (ctx.Status(404), no body); the
    // landed convention renders the declared notFound body (follows.ts).
    throw new ApiError(404, "not found");
  });

  app.openapi(userBlockUserRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { username } = c.req.valid("param");
    const { note } = c.req.valid("query");
    const blockee = await blockeeByName(c.env.DB, username);
    // shared.BlockUser(ctx, ctx.Doer): doer and blocker are the same user.
    await blockUser(
      c.env.DB,
      doer,
      { id: doer.id, isOrg: false, isAdmin: doer.isAdmin },
      blockPartyFromUserRow(blockee),
      note ?? "",
    );
    return c.body(null, 204);
  });

  app.openapi(userUnblockUserRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { username } = c.req.valid("param");
    const blockee = await blockeeByName(c.env.DB, username);
    // shared.UnblockUser(ctx, ctx.Doer, ctx.Doer).
    await unblockUser(
      c.env.DB,
      doer,
      { id: doer.id, isOrg: false, isAdmin: doer.isAdmin },
      blockPartyFromUserRow(blockee),
    );
    return c.body(null, 204);
  });

  // -- org scope (blocker = the org; the whole group sits behind
  //    reqOrgOwnership upstream, reads included) --------------------------

  app.openapi(organizationListBlocksRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName } = c.req.valid("param");
    const org = await resolveOrg(c, orgName, doer);
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listBlockedUsers(c.env.DB, org.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((row) => toApiUser(viewerOf(c), row)), 200);
  });

  app.openapi(organizationCheckUserBlockRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName, username } = c.req.valid("param");
    const org = await resolveOrg(c, orgName, doer);
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);
    const blockee = await blockeeByName(c.env.DB, username);
    if (await isBlockedBy(c.env.DB, org.id, blockee.id)) {
      return c.body(null, 204);
    }
    throw new ApiError(404, "not found");
  });

  app.openapi(organizationBlockUserRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName, username } = c.req.valid("param");
    const { note } = c.req.valid("query");
    const org = await resolveOrg(c, orgName, doer);
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);
    const blockee = await blockeeByName(c.env.DB, username);
    // shared.BlockUser(ctx, ctx.Org.Organization.AsUser()): the org blocks;
    // org rows are never site admins.
    await blockUser(
      c.env.DB,
      doer,
      { id: org.id, isOrg: true, isAdmin: false },
      blockPartyFromUserRow(blockee),
      note ?? "",
    );
    return c.body(null, 204);
  });

  app.openapi(organizationUnblockUserRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const { org: orgName, username } = c.req.valid("param");
    const org = await resolveOrg(c, orgName, doer);
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);
    const blockee = await blockeeByName(c.env.DB, username);
    await unblockUser(c.env.DB, doer, { id: org.id, isOrg: true, isAdmin: false }, blockPartyFromUserRow(blockee));
    return c.body(null, 204);
  });
}
