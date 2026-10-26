import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { addCollaboratorOptionSchema } from "../models/collaborator";
import { userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import {
  addOrUpdateCollaborator,
  deleteCollaborator,
  isCollaborator,
  listRepoAssignees,
  listRepoCollaborators,
  type CollaboratorMode,
} from "../services/repo-collaborators";
import { apiUserFromRow, findUserByName, viewerOf } from "../services/repository";

/**
 * Tier-1 collaborator/assignee routes (SPEC-0004 §2.4 rows
 * repoListCollaborators / repoCheckCollaborator / repoAddCollaborator /
 * repoDeleteCollaborator / repoGetAssignees; upstream
 * routers/api/v1/repo/collaborators.go on the `repo_collaborators` raw-D1
 * store — services/repo-collaborators.ts documents the schema gap).
 *
 * Auth (upstream registration, api.go:1291–1302): the whole group sits under
 * `reqToken()`; the list + check + assignees carry `reqAnyRepoReader`
 * (visibility only — anonymous callers are cut by the reqToken), and
 * PUT/DELETE carry `reqAdmin` (services/repo-access.ts's admin gate).
 *
 * Declared responses mirror the vendored contract exactly. The 422 of an
 * unknown user is upstream's `ErrUserNotExist.Error()` —
 * `user does not exist [uid: 0, name: X]` (user/error.go:45–46), NOT the
 * anti-enumeration 404: the caller already has repo-admin/read standing.
 * DELETE answers 204 even when the named user was never a collaborator
 * (upstream's unconditional DeleteCollaboration).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const collaboratorParams = {
  ...ownerRepoParams,
  collaborator: z.string().min(1).openapi({ description: "user name of collaborator" }),
} as const;

/** Body bind hook: upstream's Go bind answers malformed bodies with 422
 *  (including a `permission` outside the contract enum — the declared 422). */
const collaboratorBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** `ErrUserNotExist.Error()` with the route's UID=0 fill (user/error.go). */
function userNotExistError(name: string): ApiError {
  return new ApiError(422, `user does not exist [uid: 0, name: ${name}]`);
}

/** Collaborator path-param resolution: missing user → the 422 above. */
async function requireCollaboratorUser(c: Context<ApiEnv>, username: string) {
  const user = await findUserByName(c.env.DB, username);
  if (user === null) {
    throw userNotExistError(username);
  }
  return user;
}

const listCollaboratorsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/collaborators",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "List a repository's collaborators",
    operationId: "repoListCollaborators",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: z.array(userSchema) } } },
      404: notFoundResponse,
    },
  });

const checkCollaboratorRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/collaborators/{collaborator}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Check if a user is a collaborator of a repository",
    operationId: "repoCheckCollaborator",
    request: { params: z.object(collaboratorParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const addCollaboratorRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/collaborators/{collaborator}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Add or Update a collaborator to a repository",
    operationId: "repoAddCollaborator",
    request: {
      params: z.object(collaboratorParams),
      body: { content: { "application/json": { schema: addCollaboratorOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const deleteCollaboratorRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/collaborators/{collaborator}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a collaborator from a repository",
    operationId: "repoDeleteCollaborator",
    request: { params: z.object(collaboratorParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getAssigneesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/assignees",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Return all users that have write access and can be assigned to issues",
    operationId: "repoGetAssignees",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: z.array(userSchema) } } },
      404: notFoundResponse,
    },
  });

export function registerCollaboratorRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(listCollaboratorsRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listRepoCollaborators(c.env.DB, found.repo.id, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(({ user }) => apiUserFromRow(user, viewer)), 200);
  });

  app.openapi(checkCollaboratorRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const { collaborator } = c.req.valid("param");
    const user = await requireCollaboratorUser(c, collaborator);
    if (!(await isCollaborator(c.env.DB, found.repo.id, user.id))) {
      throw new ApiError(404, "not found");
    }
    return c.body(null, 204);
  });

  app.openapi(
    addCollaboratorRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, found);
      const { collaborator } = c.req.valid("param");
      const user = await requireCollaboratorUser(c, collaborator);
      // Upstream: an inactive account is an internal error (the account
      // exists — anti-enumeration does not apply to admin callers).
      if (user.status !== "active") {
        throw new ApiError(500, "");
      }
      // AddOrUpdateCollaborator's blocked arms (services/repository/
      // collaboration.go:35-37 via collaborators.go:188): the collaborator
      // and the repo owner must not block EACH OTHER in either direction —
      // 403 "user is blocked" (site admins are never blocked-by, the
      // IsUserBlockedBy bypass). Runs after the inactive-account arm,
      // exactly where upstream's LoadOwner probe sits inside the service.
      if (
        (await isUserBlockedBy(c.env.DB, user, found.repo.ownerId ?? -1)) ||
        (await isUserBlockedBy(c.env.DB, found.owner, user.id))
      ) {
        throw new ApiError(403, BLOCKED_USER_MESSAGE);
      }
      const form = c.req.valid("json");
      // Nil permission defaults to write (AddOrUpdateCollaborator's
      // ParseAccessMode fallback, collaboration.go:23).
      const mode: CollaboratorMode = form.permission ?? "write";
      await addOrUpdateCollaborator(c.env.DB, found.repo.id, user.id, mode, new Date());
      return c.body(null, 204);
    },
    collaboratorBodyHook,
  );

  app.openapi(deleteCollaboratorRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoAdmin(c, found);
    const { collaborator } = c.req.valid("param");
    const user = await requireCollaboratorUser(c, collaborator);
    await deleteCollaborator(c.env.DB, found.repo.id, user.id);
    return c.body(null, 204);
  });

  app.openapi(getAssigneesRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const assignees = await listRepoAssignees(c.env.DB, { id: found.repo.id, ownerId: found.repo.ownerId });
    return c.json(assignees.map((user) => apiUserFromRow(user, viewer)), 200);
  });
}
