import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { assertNotArchived, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import {
  addPushMirror,
  deletePushMirrorByName,
  enqueuePushMirrorSyncs,
  getPushMirrorByName,
  listPushMirrors,
  toApiPushMirror,
} from "../services/push-mirrors";

/**
 * The `/repos/{owner}/{repo}/push_mirrors` API family (the inventory batch 7
 * wave-api-push-mirrors — 5 frozen operations over the `push_mirrors` table,
 * migration 0023): repoListPushMirrors, repoGetPushMirrorByRemoteName,
 * repoAddPushMirror, repoDeletePushMirror, repoPushMirrorSync. Upstream
 * mounts the whole group with `reqAdmin(), reqToken()` and adds
 * `mustNotBeArchived` to the two writes plus the sync trigger
 * (routers/api/v1/api.go:1431-1437) — so EVERY op here is
 * [requireAuth] + requireVisibleRepo (the 404 arm) + requireRepoAdmin (the
 * 403 arm; the repo-writer/reader split the inventory sketch hints at does
 * NOT exist upstream: even the reads are admin-gated, mirror.go:1432-1437),
 * and assertNotArchived (423) rides add/delete/sync only.
 *
 * DECLARED sets mirror the frozen contract exactly — list {200,400,403,404},
 * get {200,400,403,404}, add {200,400,403,404}, delete {204,400,404},
 * sync {200,400,403,404,422}. RUNTIME-ONLY codes the handlers can emit that
 * the contract omits (thrown ApiErrors, the landed convention — the
 * orchestrator-owned RUNTIME_ONLY_RESPONSES table is not extended here):
 *   - 401 on every op (requireAuth) and on add's egress denial
 *     ("Permission denied", upstream IsPermissionDenied bucket);
 *   - 403 on DELETE (the group reqAdmin fires it at runtime; the contract's
 *     delete row declares only {204,400,404});
 *   - 423 on add/delete/sync (mustNotBeArchived);
 *   - 500 add KEK / sync-queue failures.
 * The contract's 400s are real here (upstream carries runtime 400s on every
 * op: the add body's interval/URL validation, mirror.go:341-361+391-405).
 *
 * ENQUEUE SEMANTICS — sync sends one
 * `{kind: "push-mirror-sync", repoId, pushMirrorId}` per mirror on
 * MIRROR_SYNC_QUEUE and 200s; the LANDED consumer ACKs unknown kinds, so the
 * outbound push worker is follow-up scope (services/push-mirrors.ts header).
 * The 422 arm ("error occurred when syncing push mirrors: a, b",
 * mirror.go:126-133) fires only when an enqueue itself fails.
 *
 * DELETE is IDEMPOTENT like upstream: models.DeletePushMirrors never errors
 * on a zero-rows delete, so an unknown remote name STILL 204s — the
 * contract's 404 on delete is the repo-resolution arm.
 *
 * Handlers stay thin (AGENTS.md): parse → authorize → service → respond.
 */

/** The add body is a small JSON document; reject oversized ones before
 *  buffering (the mirror.ts migrate cap pattern). */
const PUSH_MIRROR_BODY_MAX_BYTES = 64 * 1024;

/** The frozen-contract `PushMirror` response schema (verbatim property set;
 *  `created`/`last_update` are RFC 3339 — upstream `strfmt date-time`). */
export const pushMirrorSchema = z
  .object({
    repo_name: z.string().openapi({ description: "The name of the source repository" }),
    remote_name: z.string().openapi({ description: "The name of the remote in the git configuration" }),
    remote_address: z.string().openapi({ description: "The remote repository URL being mirrored to" }),
    created: z.string().openapi({ description: "The creation time", format: "date-time" }),
    last_update: z
      .string()
      .nullable()
      .openapi({ description: "The last update time (null until the first sync)", format: "date-time" }),
    last_error: z.string().openapi({ description: "The last error message encountered during sync" }),
    interval: z.string().openapi({ description: "The sync interval for automatic updates" }),
    sync_on_commit: z.boolean().openapi({ description: "Whether to sync on every commit" }),
  })
  .openapi("PushMirror");

/** The contract's `CreatePushMirrorOption` body — deliberately loose: the
 *  upstream validation lives in the service (ParseDuration + the URL gate),
 *  whose 400 texts are this family's contract. */
const createPushMirrorOptionSchema = z.object({
  remote_address: z.string().optional().openapi({ description: "The remote repository URL to push to" }),
  remote_username: z.string().optional().openapi({ description: "The username for authentication with the remote repository" }),
  remote_password: z.string().optional().openapi({ description: "The password for authentication with the remote repository" }),
  interval: z.string().optional().openapi({ description: "The sync interval for automatic updates" }),
  sync_on_commit: z.boolean().optional().openapi({ description: "Whether to sync on every commit" }),
});

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
};

const nameParam = {
  name: z.string().min(1).openapi({ description: "remote name of push mirror" }),
};

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const badRequestResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

export function registerPushMirrorRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/push_mirrors (repoListPushMirrors)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/push_mirrors",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get all push mirrors of the repository",
      operationId: "repoListPushMirrors",
      request: {
        params: z.object(ownerRepoParams),
        query: z.object({
          page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
          limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
        }),
      },
      responses: {
        200: {
          description: "PushMirrorList",
          content: { "application/json": { schema: z.array(pushMirrorSchema) } },
        },
        400: badRequestResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const param = c.req.valid("param");
      const pair = await requireVisibleRepo(c, param);
      await requireRepoAdmin(c, pair);
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listPushMirrors(c.env.DB, pair.repo.id, opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map((row) => toApiPushMirror(row, pair.repo.slug)), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/push_mirrors (repoAddPushMirror)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/push_mirrors",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "add a push mirror to the repository",
      operationId: "repoAddPushMirror",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: createPushMirrorOptionSchema } } },
      },
      responses: {
        200: {
          description: "PushMirror",
          content: { "application/json": { schema: pushMirrorSchema } },
        },
        400: badRequestResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const param = c.req.valid("param");
      const pair = await requireVisibleRepo(c, param);
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);

      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      if (Number.isInteger(declared) && declared > PUSH_MIRROR_BODY_MAX_BYTES) {
        throw new ApiError(413, `push mirror options exceed the ${PUSH_MIRROR_BODY_MAX_BYTES} byte cap`);
      }
      const options = c.req.valid("json");
      const wire = await addPushMirror(c.env.DB, c.env, { id: pair.repo.id, slug: pair.repo.slug }, options);
      return c.json(wire, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/push_mirrors/{name} (repoGetPushMirrorByRemoteName)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/push_mirrors/{name}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get push mirror of the repository by remoteName",
      operationId: "repoGetPushMirrorByRemoteName",
      request: {
        params: z.object({ ...ownerRepoParams, ...nameParam }),
      },
      responses: {
        200: {
          description: "PushMirror",
          content: { "application/json": { schema: pushMirrorSchema } },
        },
        400: badRequestResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const param = c.req.valid("param");
      const pair = await requireVisibleRepo(c, param);
      await requireRepoAdmin(c, pair);
      const row = await getPushMirrorByName(c.env.DB, pair.repo.id, param.name);
      if (row === null) throw new ApiError(404, "not found");
      return c.json(toApiPushMirror(row, pair.repo.slug), 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/push_mirrors/{name} (repoDeletePushMirror)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/push_mirrors/{name}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "deletes a push mirror from a repository by remoteName",
      operationId: "repoDeletePushMirror",
      request: {
        params: z.object({ ...ownerRepoParams, ...nameParam }),
      },
      responses: {
        204: { description: "APIEmpty is an empty response" },
        400: badRequestResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const param = c.req.valid("param");
      const pair = await requireVisibleRepo(c, param);
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      // Idempotent like upstream: an unknown name is still 204 (see the
      // module header).
      await deletePushMirrorByName(c.env.DB, pair.repo.id, param.name);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/push_mirrors-sync (repoPushMirrorSync)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/push_mirrors-sync",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Sync all push mirrored repository",
      operationId: "repoPushMirrorSync",
      request: {
        params: z.object(ownerRepoParams),
      },
      responses: {
        200: { description: "empty" },
        400: badRequestResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const param = c.req.valid("param");
      const pair = await requireVisibleRepo(c, param);
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const queue = c.env.MIRROR_SYNC_QUEUE;
      if (!queue) throw new ApiError(500, "MIRROR_SYNC_QUEUE binding missing");
      const failed = await enqueuePushMirrorSyncs(c.env.DB, queue, pair.repo.id);
      if (failed.length > 0) {
        throw new ApiError(422, `error occurred when syncing push mirrors: ${failed.join(", ")}`);
      }
      return c.body(null, 200);
    },
  );
}
