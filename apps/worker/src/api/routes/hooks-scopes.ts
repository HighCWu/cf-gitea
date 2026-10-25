import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createHookOptionSchema,
  editHookOptionSchema,
  hookListSchema,
  hookSchema,
} from "../models/webhook";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import type { GlobalHookType } from "../services/hooks";
import {
  createGlobalHook,
  createOwnerHook,
  deleteGlobalHook,
  deleteOwnerHook,
  editRepoHook,
  getGlobalHook,
  getOwnerHook,
  listGlobalHooks,
  listOwnerHooks,
  toApiHook,
} from "../services/hooks";
import { orgDoerOf } from "../services/org-repos";
import type { OrgDoer } from "../services/org-repos";
import type { OrgRecord } from "../../services/orgs/orgs";
import { OrgService } from "../../services/orgs/orgs";
import {
  requireOrgOwnership,
  requireOrgVisible,
  resolveOrgForRequest,
} from "../services/orgs";

/**
 * The three non-repository webhook scopes over the landed `webhooks` table
 * (the repo family lives in routes/hooks.ts; this module completes the
 * batch-2 surface, 15 operations):
 *
 *   - organization (5): orgListHooks / orgCreateHook / orgGetHook /
 *     orgEditHook / orgDeleteHook — `GET/POST /orgs/{org}/hooks`,
 *     `GET/PATCH/DELETE /orgs/{org}/hooks/{id}` (gitea/routers/api/v1/org/hook.go,
 *     every handler delegating to utils/hook.go's ListOwnerHooks / AddOwnerHook /
 *     GetOwnerHook / EditOwnerHook / DeleteOwnerHook);
 *   - user (5): userListHooks / userCreateHook / userGetHook / userEditHook /
 *     userDeleteHook — `GET/POST /user/hooks`, `GET/PATCH/DELETE /user/hooks/{id}`
 *     (gitea/routers/api/v1/user/hook.go, the same owner-scope utils with the
 *     doer as owner);
 *   - admin (5): adminListHooks / adminCreateHook / adminGetHook /
 *     adminEditHook / adminDeleteHook — `GET/POST /admin/hooks`,
 *     `GET/PATCH/DELETE /admin/hooks/{id}` (gitea/routers/api/v1/admin/hooks.go
 *     over models/webhook/webhook_system.go's global `repo_id=0 AND owner_id=0`
 *     rows; our NULL-adapted columns: repoId + ownerId both NULL).
 *
 * The wire payload (`Hook`) is identical across scopes — ToHook takes only a
 * base URL that never serializes — so the three arms differ ONLY in the auth
 * gates and the id-scope of the storage reads:
 *   - org: `reqToken() + reqOrgOwnership()` (api.go org hooks group, 1765–1773)
 *     — owner or site admin, invisible org = 404 (the landed orgs.ts guard
 *     trio: resolveOrgForRequest → requireOrgVisible → requireOrgOwnership);
 *   - user: `reqToken()` on the /user group (api.go:1093, 1196–1202) — the
 *     doer IS the owner, no further gate (user/hook.go's redundant
 *     `OwnerID != Doer.ID` re-check is unreachable behind the owner-scoped
 *     lookup);
 *   - admin: `reqSiteAdmin()` on the /admin group (api.go:1814, 1849–1857) —
 *     the exact upstream 403 message (routes/admin-t2.ts's seam, restated
 *     locally).
 *
 * Upstream's `reqWebhooksEnabled()` gate (403 when the instance disables
 * webhooks) has no instance-setting model yet and is not ported — same class
 * as the repo family's documented omission (routes/hooks.ts header).
 *
 * Declared responses mirror the vendored contract exactly — the org family
 * declares 404 next to its success codes; the user and admin families
 * declare ONLY the success code (the contract's own omission of the
 * id-lookup 404 and the group-gate 401). The RUNTIME-ONLY codes the handlers
 * can still emit (same class as the /user 401 exception, orchestrator-owned
 * table):
 *   - every arm:  401 (reqToken — all three groups carry it);
 *   - org:        403 (non-owner member/outsider — reqOrgOwnership);
 *   - admin:      403 (non-site-admin — reqSiteAdmin);
 *   - POST arms:  422 (checkCreateHookOption / bind) + 400 (invalid slack
 *                 channel / malformed JSON);
 *   - PATCH arms: 422 (invalid url / content type) + 422 (bind);
 *   - user/admin {id} arms: 404 (owner/global-scoped id miss — upstream's
 *                 APIErrorNotFound, undocumented in the contract like the
 *                 repo family's sibling omissions).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const orgParam = {
  org: z.string().min(1).openapi({ description: "name of the organization" }),
} as const;

/** Lenient string param (upstream never 400s — garbage parses to 0, which
 *  then misses like any unknown id), OpenAPI-typed to the contract's integer. */
const hookIdParam = {
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the hook" }),
} as const;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook: upstream's Go bind answers malformed/invalid bodies with
 *  422 (routers/api/v1/api.go bind → APIErrorValidation); the route family's
 *  generic text stands in for Go's per-field message. */
const hookBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

// ---------------------------------------------------------------------------
// Org-scope guard (the routes/orgs.ts trio, restated — resolveOrg is private
// there and orgs.ts is outside this module's ownership)
// ---------------------------------------------------------------------------

/** Shared 404 for org-scoped misses (missing org, plain user under /orgs,
 *  invisible org — APIErrorNotFound, all indistinguishable upstream). */
function orgNotFound(): ApiError {
  return new ApiError(404, "not found");
}

/**
 * The renamed-org 307 as a thrown HTTPException carrying its prepared
 * response (services/context/context_response.go RedirectToUser) — the
 * route's declared response union stays {…, 404}-shaped while
 * giteaErrorHandler passes the prepared 307 through untouched.
 */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/**
 * The orgAssignment seam (orgAssignment(true) + reqOrgVisible +
 * reqOrgOwnership): resolve the org (307 on rename, 404-shaped miss
 * otherwise), then require visibility, then ownership (owner or site admin,
 * else the exact upstream 403 message).
 */
async function requireOrgHookAccess(
  d1: D1Database,
  orgName: string,
  doer: OrgDoer & { id: number },
  requestPath: string,
  requestQuery: string,
): Promise<OrgRecord> {
  const resolved = await resolveOrgForRequest(d1, orgName, doer, requestPath, requestQuery);
  if (resolved.kind === "redirect") {
    throw renamedOrgRedirect(resolved.location);
  }
  if (resolved.kind === "missing") {
    throw orgNotFound();
  }
  const orgs = new OrgService(d1);
  await requireOrgVisible(orgs, resolved.org, doer);
  await requireOrgOwnership(orgs, resolved.org, doer);
  return resolved.org;
}

/** Doer slice for the org guards — requireAuth has resolved the caller. */
function authedDoer(c: Context<ApiEnv>): OrgDoer & { id: number } {
  return orgDoerOf(c.get("authUser"));
}

// ---------------------------------------------------------------------------
// Admin gate (routes/admin-t2.ts's seam restated — requireSiteAdmin is
// private there and admin-t2.ts is outside this module's ownership)
// ---------------------------------------------------------------------------

/**
 * `reqSiteAdmin` (routers/api/v1/api.go:343–347): a resolved doer who is not
 * a site admin gets the exact upstream 403 message. Mounted AFTER requireAuth,
 * which has already set `authUser` (the middleware order mirrors the upstream
 * group: reqToken then reqSiteAdmin).
 */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Route declarations — responses mirror the vendored contract field-for-field
// ---------------------------------------------------------------------------

const orgListHooksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/hooks",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List an organization's webhooks",
    operationId: "orgListHooks",
    request: { params: z.object(orgParam), ...listQuery },
    responses: {
      200: { description: "HookList", content: { "application/json": { schema: hookListSchema } } },
      404: notFoundResponse,
    },
  });

const orgCreateHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/hooks",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create a hook",
    operationId: "orgCreateHook",
    request: {
      params: z.object(orgParam),
      body: { content: { "application/json": { schema: createHookOptionSchema } } },
    },
    responses: {
      201: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const orgGetHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Get a hook",
    operationId: "orgGetHook",
    request: { params: z.object({ ...orgParam, ...hookIdParam }) },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const orgEditHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Update a hook",
    operationId: "orgEditHook",
    request: {
      params: z.object({ ...orgParam, ...hookIdParam }),
      body: { content: { "application/json": { schema: editHookOptionSchema } } },
    },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const orgDeleteHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a hook",
    operationId: "orgDeleteHook",
    request: { params: z.object({ ...orgParam, ...hookIdParam }) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

// The user family declares ONLY its success codes (the contract's own set —
// the group-gate 401 and the id-miss 404 are the runtime-only codes documented
// in the module header).

const userListHooksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/hooks",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's webhooks",
    operationId: "userListHooks",
    request: { ...listQuery },
    responses: {
      200: { description: "HookList", content: { "application/json": { schema: hookListSchema } } },
    },
  });

const userCreateHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/hooks",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a hook",
    operationId: "userCreateHook",
    request: {
      body: { content: { "application/json": { schema: createHookOptionSchema } } },
    },
    responses: {
      201: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const userGetHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/hooks/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a hook",
    operationId: "userGetHook",
    request: { params: z.object(hookIdParam) },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const userEditHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/user/hooks/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Update a hook",
    operationId: "userEditHook",
    request: {
      params: z.object(hookIdParam),
      body: { content: { "application/json": { schema: editHookOptionSchema } } },
    },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const userDeleteHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/hooks/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a hook",
    operationId: "userDeleteHook",
    request: { params: z.object(hookIdParam) },
    responses: {
      204: emptyResponse,
    },
  });

// The admin family likewise declares only success codes; the list's `type`
// query param mirrors the contract's enum + default ("system").

const adminListHooksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/hooks",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "List system's webhooks",
    operationId: "adminListHooks",
    request: {
      ...listQuery,
      query: listQuery.query.extend({
        type: z
          .string()
          .optional()
          .openapi({
            type: "string",
            enum: ["system", "default", "all"],
            description: "system, default or both kinds of webhooks",
            default: "system",
          }),
      }),
    },
    responses: {
      200: { description: "HookList", content: { "application/json": { schema: hookListSchema } } },
    },
  });

const adminCreateHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/hooks",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Create a hook",
    operationId: "adminCreateHook",
    request: {
      body: { content: { "application/json": { schema: createHookOptionSchema } } },
    },
    responses: {
      201: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const adminGetHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/hooks/{id}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Get a hook",
    operationId: "adminGetHook",
    request: { params: z.object(hookIdParam) },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const adminEditHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/admin/hooks/{id}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Update a hook",
    operationId: "adminEditHook",
    request: {
      params: z.object(hookIdParam),
      body: { content: { "application/json": { schema: editHookOptionSchema } } },
    },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
    },
  });

const adminDeleteHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/admin/hooks/{id}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Delete a hook",
    operationId: "adminDeleteHook",
    request: { params: z.object(hookIdParam) },
    responses: {
      204: emptyResponse,
    },
  });

/** The list `type` param's runtime semantics (admin/hooks.go ListHooks): the
 *  default is the system filter; any unlisted value behaves like "system"
 *  (upstream's switch leaves the Some(true) default). */
function globalHookTypeOf(raw: string | undefined): GlobalHookType {
  if (raw === "default") return "default";
  if (raw === "all") return "all";
  return "system";
}

export function registerHookScopeRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -----------------------------------------------------------------------
  // Organization scope (routers/api/v1/org/hook.go)
  // -----------------------------------------------------------------------

  app.openapi(orgListHooksRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { org: orgName } = c.req.valid("param");
    const url = new URL(c.req.url);
    await requireOrgHookAccess(c.env.DB, orgName, doer, c.req.path, url.search.startsWith("?") ? url.search.slice(1) : url.search);
    const listOptions = parseListOptions(url);
    const { items, total } = await listOwnerHooks(c.env.DB, doer.id, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(toApiHook), 200);
  });

  app.openapi(
    orgCreateHookRoute(requireAuth),
    async (c) => {
      const doer = authedDoer(c);
      const { org: orgName } = c.req.valid("param");
      const url = new URL(c.req.url);
      await requireOrgHookAccess(c.env.DB, orgName, doer, c.req.path, url.search.startsWith("?") ? url.search.slice(1) : url.search);
      const form = c.req.valid("json");
      const row = await createOwnerHook(c.env.DB, doer.id, form);
      return c.json(toApiHook(row), 201);
    },
    hookBodyHook,
  );

  app.openapi(orgGetHookRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { org: orgName, id } = c.req.valid("param");
    await requireOrgHookAccess(c.env.DB, orgName, doer, c.req.path, "");
    const row = await getOwnerHook(c.env.DB, doer.id, pathId(id));
    if (row === null) throw new ApiError(404, "not found");
    return c.json(toApiHook(row), 200);
  });

  app.openapi(
    orgEditHookRoute(requireAuth),
    async (c) => {
      const doer = authedDoer(c);
      const { org: orgName, id } = c.req.valid("param");
      await requireOrgHookAccess(c.env.DB, orgName, doer, c.req.path, "");
      const row = await getOwnerHook(c.env.DB, doer.id, pathId(id));
      if (row === null) throw new ApiError(404, "not found");
      const form = c.req.valid("json");
      const updated = await editRepoHook(c.env.DB, row, form);
      return c.json(toApiHook(updated), 200);
    },
    hookBodyHook,
  );

  app.openapi(orgDeleteHookRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { org: orgName, id } = c.req.valid("param");
    await requireOrgHookAccess(c.env.DB, orgName, doer, c.req.path, "");
    const deleted = await deleteOwnerHook(c.env.DB, doer.id, pathId(id));
    if (!deleted) throw new ApiError(404, "not found");
    return c.body(null, 204);
  });

  // -----------------------------------------------------------------------
  // User scope (routers/api/v1/user/hook.go) — the doer is the owner
  // -----------------------------------------------------------------------

  app.openapi(userListHooksRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOwnerHooks(c.env.DB, doer.id, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(toApiHook), 200);
  });

  app.openapi(
    userCreateHookRoute(requireAuth),
    async (c) => {
      const doer = authedDoer(c);
      const form = c.req.valid("json");
      const row = await createOwnerHook(c.env.DB, doer.id, form);
      return c.json(toApiHook(row), 201);
    },
    hookBodyHook,
  );

  app.openapi(userGetHookRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { id } = c.req.valid("param");
    const row = await getOwnerHook(c.env.DB, doer.id, pathId(id));
    if (row === null) throw new ApiError(404, "not found");
    return c.json(toApiHook(row), 200);
  });

  app.openapi(
    userEditHookRoute(requireAuth),
    async (c) => {
      const doer = authedDoer(c);
      const { id } = c.req.valid("param");
      const row = await getOwnerHook(c.env.DB, doer.id, pathId(id));
      if (row === null) throw new ApiError(404, "not found");
      const form = c.req.valid("json");
      const updated = await editRepoHook(c.env.DB, row, form);
      return c.json(toApiHook(updated), 200);
    },
    hookBodyHook,
  );

  app.openapi(userDeleteHookRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { id } = c.req.valid("param");
    const deleted = await deleteOwnerHook(c.env.DB, doer.id, pathId(id));
    if (!deleted) throw new ApiError(404, "not found");
    return c.body(null, 204);
  });

  // -----------------------------------------------------------------------
  // Admin scope (routers/api/v1/admin/hooks.go over webhook_system.go)
  // -----------------------------------------------------------------------

  app.openapi(adminListHooksRoute(requireAuth), async (c) => {
    const { type } = c.req.valid("query");
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listGlobalHooks(c.env.DB, listOptions, globalHookTypeOf(type));
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(toApiHook), 200);
  });

  app.openapi(
    adminCreateHookRoute(requireAuth),
    async (c) => {
      const form = c.req.valid("json");
      const row = await createGlobalHook(c.env.DB, form);
      return c.json(toApiHook(row), 201);
    },
    hookBodyHook,
  );

  app.openapi(adminGetHookRoute(requireAuth), async (c) => {
    const { id } = c.req.valid("param");
    const row = await getGlobalHook(c.env.DB, pathId(id));
    if (row === null) throw new ApiError(404, "not found");
    return c.json(toApiHook(row), 200);
  });

  app.openapi(
    adminEditHookRoute(requireAuth),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await getGlobalHook(c.env.DB, pathId(id));
      if (row === null) throw new ApiError(404, "not found");
      const form = c.req.valid("json");
      const updated = await editRepoHook(c.env.DB, row, form);
      return c.json(toApiHook(updated), 200);
    },
    hookBodyHook,
  );

  app.openapi(adminDeleteHookRoute(requireAuth), async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await deleteGlobalHook(c.env.DB, pathId(id));
    if (!deleted) throw new ApiError(404, "not found");
    return c.body(null, 204);
  });
}
