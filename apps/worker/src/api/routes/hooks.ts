import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createHookOptionSchema,
  editHookOptionSchema,
  hookDeliveryListSchema,
  hookListSchema,
  hookSchema,
} from "../models/webhook";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  buildTestPushPayload,
  createRepoHook,
  deleteRepoHook,
  editRepoHook,
  fireTestDelivery,
  getRepoHook,
  listHookDeliveries,
  listRepoHooks,
  toApiDelivery,
  toApiHook,
} from "../services/hooks";
import { canViewRepository, findRepositoryByPath, toApiRepository, viewerOf } from "../services/repository";

/**
 * Tier-1 `repository`-tagged webhook routes (SPEC-0004 §2.4 rows:
 * repoListHooks / repoCreateHook / repoGetHook / repoEditHook / repoDeleteHook /
 * repoTestHook / repoListHookDeliveries; SPEC-0005 §2.6 model, §3.6 delivery).
 *
 * Every operation requires a token upstream (`reqToken` inside the
 * repo-admin middleware group — SPEC-0002 `write:`/`read:repository`
 * (admin) scopes; the per-route admin permission gate lands with the
 * SPEC-0002 ACL matrix, the landed routes' requireAuth convention stands in).
 * Repo resolution follows the anti-enumeration rule: missing and invisible
 * repositories are the same 404.
 *
 * Declared responses mirror the vendored contract exactly ({200,404} /
 * {201,404} / {204,404}); the RUNTIME-ONLY codes the handlers can still
 * emit (same class as the /user 401 exception, orchestrator-owned table):
 *   - POST /hooks:            422 (checkCreateHookOption validation),
 *                             400 (invalid slack channel / malformed JSON)
 *   - PATCH /hooks/{id}:      422 (invalid url / content type)
 *   - POST /hooks/{id}/tests: none — empty repo 204s without firing
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
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

const listHooksRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/hooks",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "List the hooks in a repository",
    operationId: "repoListHooks",
    request: { params: z.object(ownerRepoParams), ...listQuery },
    responses: {
      200: { description: "HookList", content: { "application/json": { schema: hookListSchema } } },
      404: notFoundResponse,
    },
  });

const createHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/hooks",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a hook",
    operationId: "repoCreateHook",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createHookOptionSchema } } },
    },
    responses: {
      201: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const getHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Get a hook",
    operationId: "repoGetHook",
    request: { params: z.object({ ...ownerRepoParams, ...hookIdParam }) },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const editHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Edit a hook in a repository",
    operationId: "repoEditHook",
    request: {
      params: z.object({ ...ownerRepoParams, ...hookIdParam }),
      body: { content: { "application/json": { schema: editHookOptionSchema } } },
    },
    responses: {
      200: { description: "Hook", content: { "application/json": { schema: hookSchema } } },
      404: notFoundResponse,
    },
  });

const deleteHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/hooks/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a hook in a repository",
    operationId: "repoDeleteHook",
    request: { params: z.object({ ...ownerRepoParams, ...hookIdParam }) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const testHookRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/hooks/{id}/tests",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Test a push webhook",
    operationId: "repoTestHook",
    request: {
      params: z.object({ ...ownerRepoParams, ...hookIdParam }),
      query: z.object({
        ref: z
          .string()
          .optional()
          .openapi({
            description:
              "The name of the commit/branch/tag, indicates which commit will be loaded to the webhook payload.",
          }),
      }),
    },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const listDeliveriesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/hooks/{id}/deliveries",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "List the deliveries of a hook in a repository",
    operationId: "repoListHookDeliveries",
    request: { params: z.object({ ...ownerRepoParams, ...hookIdParam }), ...listQuery },
    responses: {
      200: {
        description: "HookDeliveryList",
        content: { "application/json": { schema: hookDeliveryListSchema } },
      },
      404: notFoundResponse,
    },
  });

/** Resolve + visibility-check the repo (anti-enumeration 404), shared guard. */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !canViewRepository(viewer, found.repo)) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

/**
 * The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired (wrangler
 * `queues.producers` + `wrangler types`). The binding is absent from the
 * generated Env today (wrangler.jsonc's queues block carries a duplicate-key
 * shadowing bug — orchestrator action item), so the probe is a structural
 * lookup: the moment Env gains the binding this starts enqueueing with no code
 * change. Absent ⇒ rows stay `pending` and the delivery log stays complete
 * (SPEC-0005 §3.6: the queue only ever carries `{deliveryId}`; the D1 row is
 * the source of truth and a later pass enqueues stranded rows).
 */
function webhookDeliveryQueue(
  env: ApiEnv["Bindings"],
): { sendBatch(messages: WebhookDeliveryMessage[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: WebhookDeliveryMessage[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

export function registerHookRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(listHooksRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listRepoHooks(c.env.DB, found.repo.id, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(toApiHook), 200);
  });

  app.openapi(
    createHookRoute(requireAuth),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const form = c.req.valid("json");
      const row = await createRepoHook(c.env.DB, found.repo.id, form);
      return c.json(toApiHook(row), 201);
    },
    hookBodyHook,
  );

  app.openapi(getHookRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const row = await getRepoHook(c.env.DB, found.repo.id, pathId(id));
    if (row === null) throw new ApiError(404, "not found");
    return c.json(toApiHook(row), 200);
  });

  app.openapi(
    editHookRoute(requireAuth),
    async (c) => {
      const { found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { id } = c.req.valid("param");
      const row = await getRepoHook(c.env.DB, found.repo.id, pathId(id));
      if (row === null) throw new ApiError(404, "not found");
      const form = c.req.valid("json");
      const updated = await editRepoHook(c.env.DB, row, form);
      return c.json(toApiHook(updated), 200);
    },
    hookBodyHook,
  );

  app.openapi(deleteHookRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const deleted = await deleteRepoHook(c.env.DB, found.repo.id, pathId(id));
    if (!deleted) throw new ApiError(404, "not found");
    return c.body(null, 204);
  });

  app.openapi(testHookRoute(requireAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    // Upstream: a repo without commits fires nothing (TestHook's
    // `ctx.Repo.Commit == nil` early-204). The is_empty flag is the
    // settled truth (push-create and import settles both write it; the
    // refs_version column is observability-only and never synced).
    if (found.repo.isEmpty) {
      return c.body(null, 204);
    }
    const { id } = c.req.valid("param");
    const hook = await getRepoHook(c.env.DB, found.repo.id, pathId(id));
    if (hook === null) throw new ApiError(404, "not found");

    const query = c.req.valid("query");
    const ref = query.ref !== undefined && query.ref.trim() !== "" ? query.ref.trim() : `refs/heads/${found.repo.defaultBranch}`;
    // The test-fire bypasses event subscriptions, branch filter and the active
    // gate (upstream PrepareTestWebhook) — the representative push payload is
    // built and enqueued DIRECTLY for this hook id. The delivery row insert is
    // the request-visible effect and runs INLINE (upstream CreateHookTask is
    // synchronous too); the Queue message ({deliveryId}, SPEC-0005 §3.6) hangs
    // off c.executionCtx.waitUntil — sub-second, never fails the response, and
    // a missing/broken producer leaves the row `pending` with the log complete
    // (the consumer's idempotent CAS makes a later pass a safe replay).
    const payload = buildTestPushPayload(found, ref, {
      repository: toApiRepository(viewer, found),
      pusher: c.get("authUser"),
      sender: c.get("authUser"),
    });
    const deliveryId = await fireTestDelivery(c.env.DB, hook, "push", payload, { repoId: found.repo.id });
    const queue = webhookDeliveryQueue(c.env);
    if (queue !== null) {
      // c.executionCtx throws outside a real worker invocation (in-process
      // test callers have none — the pending D1 row is the durable truth, so
      // skipping the enqueue there is safe). Access it in VALUE position
      // only: Hono's accessor signature references the generated global
      // ExecutionContext type, which drifted (no tracing/abort) — never name
      // or typeof it in type position.
      let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
      try {
        execCtx = c.executionCtx;
      } catch {
        execCtx = undefined;
      }
      if (execCtx !== undefined) {
        execCtx.waitUntil(
          queue.sendBatch([{ deliveryId }]).then(undefined, (error: unknown) => {
            console.error(`[hooks] delivery enqueue failed for ${deliveryId}: ${errorMessage(error)}`);
          }),
        );
      }
    }
    return c.body(null, 204);
  });

  app.openapi(listDeliveriesRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const hookId = pathId(id);
    if ((await getRepoHook(c.env.DB, found.repo.id, hookId)) === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listHookDeliveries(c.env.DB, hookId, listOptions);
    setPaginationHeaders(c, total, listOptions);
    // Upstream's ListDeliveries omits the payloads from list rows (they are
    // only returned per delivery, tier-2 GET …/deliveries/{uuid}).
    return c.json(items.map((row) => toApiDelivery(row, { omitPayload: true })), 200);
  });
}

/** Observability-log rendering for the waitUntil enqueue failure path. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
