import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { hookDeliverySchema } from "../models/webhook";
import {
  getRepoHook,
  listHookDeliveries,
  toApiDelivery,
} from "../services/hooks";
import { canViewRepository, findRepositoryByPath, viewerOf } from "../services/repository";

/**
 * Tier-2 webhook delivery item (SPEC-0004 appendix A row
 * `/repos/{owner}/{repo}/hooks/{id}/deliveries/{uuid}` — upstream
 * routers/api/v1/repo/hook.go GetHookDelivery): one delivery WITH its request
 * and response payloads (the landed list route omits them — upstream's
 * ListDeliveries does too; this is the only payload-bearing read).
 *
 * Auth matches the landed hook family: upstream's whole /repos/{owner}/{repo}
 * hooks group sits behind `reqToken` (api.go) — requireAuth only.
 *
 * Resolution is id-chained: unknown repo → the anti-enumeration 404; unknown
 * hook id → 404; unknown uuid for a known hook → 404 (upstream scans
 * hook.Histories() for the uuid and answers APIErrorNotFound).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const getDeliveryRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/hooks/{id}/deliveries/{uuid}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Get a webhook delivery",
    operationId: "repoGetHookDelivery",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the hook" }),
        uuid: z.string().min(1).openapi({ description: "uuid of the delivery" }),
      }),
    },
    responses: {
      200: { description: "HookDelivery", content: { "application/json": { schema: hookDeliverySchema } } },
      404: notFoundResponse,
    },
  });

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404);
 *  the same convention routes/hooks.ts applies to the hook id. */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Repo resolution + visibility — the anti-enumeration 404 (the hooks-routes
 *  local copy; this module registers only the deeper delivery path). */
async function requireVisibleRepoPair(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

export function registerHookDeliveryRoute(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(getDeliveryRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepoPair(c, c.req.valid("param"));
    const { id, uuid } = c.req.valid("param");
    const hookId = pathId(id);
    if ((await getRepoHook(c.env.DB, found.repo.id, hookId)) === null) {
      throw new ApiError(404, "not found");
    }
    // The uuid is unique per delivery row; the page size covers a hook's
    // history (upstream Histories() is the same unbounded in-memory list).
    const { items } = await listHookDeliveries(c.env.DB, hookId, { page: 1, limit: 1000 });
    const row = items.find((candidate) => candidate.uuid === uuid);
    if (row === undefined) {
      throw new ApiError(404, "not found");
    }
    // The single-delivery read carries the full request/response payloads
    // (upstream GetHookDelivery) — the omitPayload arm stays off.
    return c.json(toApiDelivery(row), 200);
  });
}
