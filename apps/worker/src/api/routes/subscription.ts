import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import type { WatchInfo } from "../models/watch";
import { watchInfoSchema } from "../models/watch";
import { requireVisibleRepo } from "../services/repo-access";
import { apiRepositoryUrl, type RepositoryWithOwner } from "../services/repository";
import { isWatchingRepo, unwatchRepo, watchRepo } from "../services/repo-watchers";

/**
 * Tier-1 repo-subscription routes (SPEC-0004 §2.4 row `GET/PUT/DELETE
 * /repos/{owner}/{repo}/subscription`; upstream routers/api/v1/user/watch.go
 * IsWatching/Watch/Unwatch on the `repo_watchers` raw-D1 store —
 * services/repo-watchers.ts documents the schema gap).
 *
 * Auth: upstream wraps the whole group in `reqToken()` (api.go:1403–1407) —
 * every operation requires a token (anonymous → the 401 runtime-only body,
 * same class as the /user 401). Repo resolution follows the anti-enumeration
 * 404. Semantics: GET 404s when the caller is not watching (upstream
 * APIErrorNotFound), PUT is an idempotent subscribe returning the WatchInfo
 * with `subscribed: true` and the REPOSITORY's created timestamp (upstream
 * `ctx.Repo.Repository.CreatedUnix`), DELETE is the idempotent 204 unwatch.
 * `ignored` stays false (the ignore mode is a tier-2 notification setting)
 * and `reason` renders null like upstream's nil.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** The WatchInfo render (upstream subscriptionURL + Repository.APIURL). */
function toWatchInfo(pair: RepositoryWithOwner, origin: string): WatchInfo {
  const apiUrl = apiRepositoryUrl(pair, origin);
  return {
    subscribed: true,
    ignored: false,
    reason: null,
    created_at: pair.repo.createdAt.toISOString(),
    url: `${apiUrl}/subscription`,
    repository_url: apiUrl,
  };
}

/** The upstream 404 of IsWatching: "User is not watching this repo or repo
 *  do not exist" — both are APIErrorNotFound ({message, url} at runtime,
 *  body-less in the contract; the empty-family conversion note applies). */
function notWatchingError(): ApiError {
  return new ApiError(404, "not found");
}

const checkSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/subscription",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Check if the current user is watching a repo",
    operationId: "userCurrentCheckSubscription",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "WatchInfo", content: { "application/json": { schema: watchInfoSchema } } },
      404: notFoundResponse,
    },
  });

const putSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/subscription",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Watch a repo",
    operationId: "userCurrentPutSubscription",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "WatchInfo", content: { "application/json": { schema: watchInfoSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const deleteSubscriptionRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/subscription",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Unwatch a repo",
    operationId: "userCurrentDeleteSubscription",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

export function registerSubscriptionRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(checkSubscriptionRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const requester = c.get("authUser");
    const requesterId = requester.id ?? 0;
    if (!(await isWatchingRepo(c.env.DB, pair.repo.id, requesterId))) {
      throw notWatchingError();
    }
    return c.json(toWatchInfo(pair, new URL(c.req.url).origin), 200);
  });

  app.openapi(putSubscriptionRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const requester = c.get("authUser");
    await watchRepo(c.env.DB, pair.repo.id, requester.id ?? 0, new Date());
    return c.json(toWatchInfo(pair, new URL(c.req.url).origin), 200);
  });

  app.openapi(deleteSubscriptionRoute(requireAuth), async (c) => {
    const pair = await requireVisibleRepo(c, c.req.valid("param"));
    const requester = c.get("authUser");
    await unwatchRepo(c.env.DB, pair.repo.id, requester.id ?? 0);
    return c.body(null, 204);
  });
}
