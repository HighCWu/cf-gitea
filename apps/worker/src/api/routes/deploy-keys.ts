import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { repositorySchema } from "../models/repository";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  addDeployKeySsh,
  addDeployKeyToken,
  canSeePrivateDeployKey,
  deleteDeployKeyRow,
  deployKeyNotExistMessage,
  getDeployKeyRow,
  listDeployKeys,
  loadDeployKeyContent,
  toApiDeployKey,
} from "../services/deploy-keys";
import { requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import { viewerOf } from "../services/repository";

/**
 * SPEC-0004 tier-2 — the repo deploy-key family (5 frozen operations, the
 * inventory batch `wave-api-deploy-keys` over migration 0020's `deploy_keys`
 * table): repoListKeys, repoGetKey, repoCreateKey, repoDeleteKey,
 * repoCreateDeployToken (routers/api/v1/repo/key.go; the storage layer is
 * services/deploy-keys.ts — the upstream `deploykey` model port).
 *
 * MIDDLEWARE — upstream mounts the whole group with `reqToken(), reqAdmin()`
 * (routers/api/v1/api.go:1374-1380). Ours: [requireAuth] + requireVisibleRepo
 * (the 404 arm) + requireRepoAdmin (the 403 arm). RUNTIME-ONLY codes the
 * handlers can emit that the vendored contract omits (the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table is not extended by this module — the
 * branch-protections.ts batch pattern):
 *   - 401 on every op (upstream reqToken; the contract's error family
 *     declares no 401 anywhere in this tag);
 *   - 403 on the reads AND both creates (reqAdmin runs before every handler;
 *     only repoDeleteKey's swagger declares the 403).
 * Declared sets mirror the contract exactly: list {200,404}, get {200,404},
 * create {201,404,422}, tokens {201,404,422}, delete {204,403,404}.
 *
 * NO ARCHIVED GATE — upstream's group carries no mustNotBeArchived (unlike
 * branch_protections), so creates against archived repos succeed; none of
 * the ops declares (or emits) the 423.
 *
 * DELETE SEMANTICS (key.go DeleteDeployKey:299-330) — the miss is SWALLOWED:
 * "a key that is already gone still leaves the caller with the state it
 * asked for", so an unknown id answers 204 like a deleted one (:311-317).
 * The declared 403 is upstream's ErrKeyAccessDenied arm — dead code in this
 * pin (the delete path emits it nowhere) and unreachable behind reqAdmin;
 * declared for contract parity, never emitted. 404 is unreachable at
 * runtime too (the anti-enumeration repo 404 is requireVisibleRepo's, and
 * the key-miss 204s) — kept for the contract's declared set.
 *
 * CREATE SEMANTICS (key.go CreateDeployKey:197-232 / CreateDeployToken:
 * 225-260) — required fields answer the Go binder's exact texts
 * ("Title: Required", "Key: Required"; binding.go:141 newFieldError +
 * api.go:841-844's `<Field>: <error>` rendering); the token title's
 * `binding:"MaxSize(50)"` 422s with the binder's rule message ("Title:
 * MaxSize", binding.go:156-160). The key-content 422 family comes from the
 * shared parser ("Invalid key content: …") and HandleAddKeyError's mapping
 * (:148-171): "Key content has been used as non-deploy key" (the fingerprint
 * exists as a USER key), "This key has already been added to this
 * repository" ((repo, key) pair), "A key with the same name already exists"
 * (checkDeployKeyName) — checked in upstream's order.
 *
 * RENDER (convert.ToDeployKey, convert.go:908-925 + the key.go
 * appendPrivateInformation gate :26-38) — the embedded `repository` object
 * appears ONLY for the site admin or the repo owner (owner-id equality;
 * org-owned repos bind ownerId to the org row, so human org owners stay
 * outside the arm exactly like upstream), carrying the KEY's access mode in
 * its permissions block ({admin: false, push: mode==2, pull: true}); other
 * repo admins get the bare key. Token rows render key_id 0, key '', and the
 * masked fingerprint; the plaintext `token` rides ONLY the create response
 * (Token is xorm:"-"), matching the field's omitempty on reads.
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

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** The rendered DeployKey (structs/repo_key.go:8-36) — `token` and
 *  `repository` are the omitempty fields (create-only / owner-admin-only). */
export const deployKeySchema = z.object({
  id: z.number().int().openapi({ format: "int64", description: "ID is the unique identifier for the deploy-key" }),
  key_type: z.enum(["ssh", "token"]).openapi({ description: "Type tells whether the key authenticates over SSH or with a token over HTTPS" }),
  key_id: z.number().int().openapi({ format: "int64", description: "KeyID is the associated public key ID" }),
  key: z.string().openapi({ description: "Key contains the actual SSH key content" }),
  url: z.string().openapi({ description: "URL is the API URL for this deploy-key" }),
  title: z.string().openapi({ description: "Title is the human-readable name for the key" }),
  fingerprint: z.string().openapi({ description: "Fingerprint is the key's fingerprint" }),
  token: z
    .string()
    .optional()
    .openapi({ description: "Token is the plaintext token of an HTTPS key, only returned when it is created" }),
  created_at: z.string().openapi({ format: "date-time", description: "Created is the time when the deploy-key was added" }),
  read_only: z.boolean().openapi({ description: "ReadOnly indicates if the key has read-only access" }),
  repository: repositorySchema.optional().openapi({ description: "Repository is the repository this deploy-key belongs to" }),
});

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** `#/definitions/CreateKeyOption` — fields optional in the schema; the
 *  required ones 422 in-handler with the Go binder's exact texts (the
 *  misc-t3 requireKeyFields pattern). */
const createKeyOptionSchema = z.object({
  title: z.string().optional().openapi({ description: "Title of the key to add" }),
  key: z.string().optional().openapi({ description: "An armored SSH key to add" }),
  read_only: z.boolean().optional().openapi({ description: "Describe if the key has only read access or read/write" }),
});

/** `#/definitions/CreateDeployKeyTokenOption` — title Required + MaxSize(50). */
const createTokenOptionSchema = z.object({
  title: z.string().optional().openapi({ description: "Title of the token to add" }),
  read_only: z.boolean().optional().openapi({ description: "Describe if the token has only read access or read/write" }),
});

// ---------------------------------------------------------------------------
// Handler helpers — the upstream ports, in handler order.
// ---------------------------------------------------------------------------

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathParamInt64(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Go FormInt64 — absent or non-integer query values count as 0 (unfiltered). */
function formInt64(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return 0;
  }
  return Number.parseInt(raw, 10);
}

/** The binding arm of CreateDeployKey (:200-206): Required fields 422 with
 *  the Go binder's exact `<Field>: <error>` texts. */
function requireCreateKeyFields(form: { title?: string; key?: string }): void {
  if (form.title === undefined || form.title === "") {
    throw new ApiError(422, "Title: Required");
  }
  if (form.key === undefined || form.key === "") {
    throw new ApiError(422, "Key: Required");
  }
}

/** The binding arm of CreateDeployToken (:229-233): Required + MaxSize(50). */
function requireCreateTokenFields(form: { title?: string }): void {
  if (form.title === undefined || form.title === "") {
    throw new ApiError(422, "Title: Required");
  }
  if (form.title.length > 50) {
    throw new ApiError(422, "Title: MaxSize");
  }
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerDeployKeyRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/keys (repoListKeys)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/keys",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List a repository's keys",
      operationId: "repoListKeys",
      request: {
        params: z.object(ownerRepoParams),
        query: z.object({
          key_id: z.string().optional().openapi({ type: "integer", description: "the key_id to search for" }),
          fingerprint: z.string().optional().openapi({ description: "fingerprint of the key" }),
          page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
          limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
        }),
      },
      responses: {
        200: {
          description: "DeployKeyList",
          content: { "application/json": { schema: z.array(deployKeySchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const url = new URL(c.req.url);
      const opts = parseListOptions(url);
      const { rows, total } = await listDeployKeys(c.env.DB, pair.repo.id, { keyId: formInt64(url, "key_id"), fingerprint: url.searchParams.get("fingerprint") ?? "" }, opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      const viewer = viewerOf(c);
      const withRepository = canSeePrivateDeployKey(viewer, pair);
      return c.json(
        await Promise.all(
          rows.map(async (row) =>
            toApiDeployKey(viewer, pair, row, row.keyType === 1 ? await loadDeployKeyContent(c.env.DB, row.keyId) : null, {
              withRepository,
            }),
          ),
        ),
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/keys (repoCreateKey)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/keys",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Add a key to a repository",
      operationId: "repoCreateKey",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: createKeyOptionSchema } } },
      },
      responses: {
        201: { description: "DeployKey", content: { "application/json": { schema: deployKeySchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const form = c.req.valid("json");
      requireCreateKeyFields(form);
      // CheckPublicKeyString runs INSIDE AddDeployKeySSH upstream — the parse
      // 422s before the name/pair checks (key.go:203-210).
      const added = await addDeployKeySsh(c.env.DB, pair.repo.id, form.title!, form.key!, form.read_only === true);
      // ToDeployKey only — the create response carries no repository field
      // (appendPrivateInformation runs on the list/get paths alone).
      return c.json(toApiDeployKey(viewerOf(c), pair, added.row, added.keyContent ?? null), 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/keys/tokens (repoCreateDeployToken) —
  // registered BEFORE the {id} family like upstream's group order; POST is
  // method-disjoint from GET/DELETE /{id}, so no shadowing exists (the
  // branch_protections/priority precedent).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/keys/tokens",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Add a deploy token to a repository, it authenticates git over HTTPS",
      operationId: "repoCreateDeployToken",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: createTokenOptionSchema } } },
      },
      responses: {
        201: { description: "DeployKey", content: { "application/json": { schema: deployKeySchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const form = c.req.valid("json");
      requireCreateTokenFields(form);
      const added = await addDeployKeyToken(c.env.DB, pair.repo.id, form.title!, form.read_only === true);
      return c.json(toApiDeployKey(viewerOf(c), pair, added.row, null, { token: added.token }), 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/keys/{id} (repoGetKey)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/keys/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a repository's key by id",
      operationId: "repoGetKey",
      request: {
        params: z.object({ ...ownerRepoParams, id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the key to get" }) }),
      },
      responses: {
        200: { description: "DeployKey", content: { "application/json": { schema: deployKeySchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const id = pathParamInt64(c.req.valid("param").id);
      // GetDeployKeyByID is repo-scoped: a foreign repo's key id is the same
      // plain 404 (APIErrorAuto over ErrDeployKeyNotExist, error.go:27-29).
      const row = await getDeployKeyRow(c.env.DB, pair.repo.id, id);
      if (row === null) {
        throw new ApiError(404, deployKeyNotExistMessage(id, pair.repo.id));
      }
      const viewer = viewerOf(c);
      return c.json(
        toApiDeployKey(viewer, pair, row, row.keyType === 1 ? await loadDeployKeyContent(c.env.DB, row.keyId) : null, {
          withRepository: canSeePrivateDeployKey(viewer, pair),
        }),
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/keys/{id} (repoDeleteKey) — the key-miss
  // 204s (idempotent delete, key.go:311-317); the declared 403/404 arms are
  // unreachable (module header).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/keys/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a key from a repository",
      operationId: "repoDeleteKey",
      request: {
        params: z.object({ ...ownerRepoParams, id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the key to delete" }) }),
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const id = pathParamInt64(c.req.valid("param").id);
      const row = await getDeployKeyRow(c.env.DB, pair.repo.id, id);
      if (row !== null) {
        await deleteDeployKeyRow(c.env.DB, row);
      }
      return c.body(null, 204);
    },
  );
}
