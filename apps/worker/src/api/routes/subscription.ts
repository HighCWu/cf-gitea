import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import type { WatchInfo } from "../models/watch";
import { watchInfoSchema } from "../models/watch";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { requireVisibleRepo } from "../services/repo-access";
import { apiRepositoryUrl, type RepositoryWithOwner } from "../services/repository";
import { isWatchingRepo, unwatchRepo, watchRepo } from "../services/repo-watchers";

/**
 * Tier-1 repo-subscription routes (SPEC-0004 §2.4 row `GET/PUT/DELETE
 * /repos/{owner}/{repo}/subscription`; upstream routers/api/v1/user/watch.go
 * IsWatching/Watch/Unwatch on the `repo_watchers` store — the watch MODES
 * ride the store's mode + include_* columns, services/repo-watchers.ts).
 *
 * Auth: upstream wraps the whole group in `reqToken()` (api.go:1403–1407) —
 * every operation requires a token (anonymous → the 401 runtime-only body,
 * same class as the /user 401). Repo resolution follows the anti-enumeration
 * 404. PUT's declared 403 is LIVE —
 * upstream's ErrBlockedUser arm (models/repo/watch.go:170-171, unwrapped by
 * Watch at watch.go:174) is wired in the handler below (the
 * blocks-enforcement sweep). Mode semantics (the WatchRepoAuto arms,
 * watch.go:159-178, via services/repo-watchers.ts): PUT is the idempotent
 * subscribe that KEEPS a Custom selection (watch.go:173-175 — the response
 * still renders `subscribed: true`, like upstream's unconditional
 * WatchInfo) and resets the include flags when starting to watch; DELETE
 * lands an Auto watch on the persisted Dont mode (watch.go:164-165, the
 * row stays, the counter decrements) and everything else on None (row
 * deleted). GET 404s unless `IsWatchModeWatching(mode)` (IsWatchingRepo,
 * watch.go:109-112 — a persisted Dont row answers 404). The WatchInfo
 * render stays upstream-literal: `subscribed: true` with the REPOSITORY's
 * created timestamp (upstream `ctx.Repo.Repository.CreatedUnix`),
 * `ignored: false` (hardcoded false in upstream's IsWatching/Watch
 * handlers too — the field is not read from the mode there) and `reason`
 * null like upstream's nil. The Custom/ignore SETTERS are web-form arms
 * (POST /action/watch|participate|ignore and /action/watch/options,
 * routers/web/repo/watch.go) — the store primitive
 * (`watchRepoWithOptions`) is landed; the routes ride the UI window.
 *
 * RE-PIN 099abf5db4 (REPIN-WATCH 2026-11-20, window fc49368845..099abf5db4):
 * 5671c5192d folded this trio's declared 403/404s into a single
 * `default: error` swagger response (annotation-only, wire-identical — our
 * `responses` blocks keep the explicit statuses, the admin-t2
 * documented-superset convention) and added the missing post-error `return`
 * to the same file's watched-listings handlers (our throw-style handlers
 * have no fall-through to fix). models/repo/watch.go's only window change is
 * 6a8eec1cc3's `UNIQUE(watch) INDEX` annotation on Watch.RepoID —
 * schema-only, and our composite PK (repo_id, user_id) already indexes
 * repo_id as its leading column; every watch.go line anchor above is
 * unchanged (the edit is a 1:1 line swap at :42).
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
    // WatchRepoAuto's blocked arm (models/repo/watch.go:170-171): a doer
    // blocked by the repo owner answers ErrBlockedUser on the doWatch=true
    // path — AFTER the !doWatch arms (unwatch is never blocked) and BEFORE
    // the custom-mode keep. Watch (watch.go:174) unwraps the error to the
    // declared 403 `err.Error()`; the isUserBlockedBy site-admin
    // short-circuit is upstream's `blockee.IsAdmin`.
    if (await isUserBlockedBy(c.env.DB, { id: requester.id ?? 0, isAdmin: requester.is_admin === true }, pair.repo.ownerId ?? -1)) {
      throw new ApiError(403, BLOCKED_USER_MESSAGE);
    }
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
