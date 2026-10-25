import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import type { RepositoryWithOwner } from "../services/repository";
import { doerRepoAccessMode } from "../services/repository";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { orgDoerOf } from "../services/org-repos";
import type { OrgDoer } from "../services/org-repos";
import type { OrgRecord } from "../../services/orgs/orgs";
import { OrgService } from "../../services/orgs/orgs";
import {
  requireOrgOwnership,
  requireOrgVisible,
  resolveOrgForRequest,
} from "../services/orgs";
import { requireVisibleRepo } from "../services/repo-access";
import {
  createOrUpdateSecret,
  createVariableRow,
  deleteSecretByName,
  deleteVariableRow,
  getVariableRow,
  listSecretRows,
  listVariableRows,
  ownerScope,
  repoScope,
  secretNotFoundMessage,
  toApiSecret,
  toApiVariable,
  updateVariableRow,
  variableNotFoundMessage,
} from "../services/secrets-variables";

/**
 * The actions secrets/variables families (the inventory's
 * `wave-api-secrets-variables` batch — 23 frozen operations over migration
 * 0021's `secrets` + `action_variables` tables, storage in
 * services/secrets-variables.ts). This is the only actions-family surface
 * that works without the actions runtime (SPEC-0012 stays gated): CI/tooling
 * reads and writes the KV stores, no runner involved. The three scopes share
 * ONE wire shape and ONE service — only the auth gates and the id-scope of
 * the storage reads differ:
 *
 *   - repo (8): repoListActionsSecrets / updateRepoSecret / deleteRepoSecret /
 *     getRepoVariablesList / getRepoVariable / createRepoVariable /
 *     updateRepoVariable / deleteRepoVariable — the `reqToken(), reqOwner()`
 *     group (routers/api/v1/api.go:1253 addActionsRoutes → 971-985);
 *   - org (8): orgListActionsSecrets / updateOrgSecret / deleteOrgSecret /
 *     getOrgVariablesList / getOrgVariable / createOrgVariable /
 *     updateOrgVariable / deleteOrgVariable — `reqToken(), reqOrgOwnership()`
 *     (api.go:1738-1742; the landed orgs.ts guard trio);
 *   - user (7): updateUserSecret / deleteUserSecret / getUserVariablesList /
 *     getUserVariable / createUserVariable / updateUserVariable /
 *     deleteUserVariable — the `/user` group's `reqToken()` (api.go:1093,
 *     1113-1127): the doer IS the owner, no further gate.
 *
 * REPO GATE PRECISION — upstream's arm is `reqOwner()`, NOT `reqAdmin()`
 * (api.go:354-361): Permission.IsOwner() is `AccessMode >= AccessModeOwner`
 * (models/perm/access/repo_permission.go:42-44) — the repo's owner user, the
 * site admin (explicit at api.go:356), or an ORG OWNER-team member
 * (team.AccessMode==Owner, repo_permission.go:514). An admin-mode
 * collaborator ranks AccessModeAdmin (3) and 403s, unlike the deploy-keys
 * family's reqAdmin. Ours (requireRepoOwner below): the ownerNamespace login
 * match (services/repository.ts isRepositoryOwner's seam), the site admin,
 * or `doerRepoAccessMode === "owner"` (the isOrgOwner/Owners-team bridge).
 *
 * DECLARED SETS mirror the vendored contract exactly, per operation — the
 * oddities are upstream's own: secret PUT declares {201,204} (create vs
 * update); variable PUT declares a dead 201 next to its 204 (the handler
 * only Status(204)s); variable DELETE declares 200 (a leftover $ref) and a
 * dead 201 next to its 204; user-scope variable delete omits the 200 and
 * variable create omits the 500 its repo/org siblings declare; the reads
 * declare a 400 no read path can produce (the InvalidArgument arm lives in
 * the writes). The RUNTIME-ONLY codes the handlers can still emit (the
 * orchestrator-owned RUNTIME_ONLY_RESPONSES table is NOT extended by this
 * module — the deploy-keys/branch-protections batch pattern):
 *   - every op:   401 (reqToken — all three groups carry it);
 *   - repo arm:   403 (reqOwner — "user should be the owner of the repo");
 *   - org arm:    403 (non-owner member/outsider — reqOrgOwnership);
 *   - body arms:  422 (the Go binder's Required fields — "Data: Required" /
 *                 "Value: Required", api.go:841-844's `<Field>: <error>`
 *                 rendering; the vendored contract declares no 422 here).
 *
 * EMPTY-BODY ARMS — every mutation answers a bare status (ctx.Status), no
 * body, exactly like upstream: secret PUT 201/204, secret DELETE 204,
 * variable create 201, variable update 204, variable delete 204.
 *
 * ERROR MESSAGES (APIErrorAuto → ErrorUnwrapForUser, the err.Error() text):
 *   - secret miss: ErrSecretNotFound{} constructed with the EMPTY Name field
 *     (services/secrets/secrets.go:60-63) → "secret was not found [name: ]";
 *   - variable miss: util.NewNotExistErrorf("variable not found")
 *     (services/actions/variables.go:56);
 *   - invalid name: the three ValidateName texts (services/secrets/
 *     validation.go:29-35) — pattern, GITEA_/GITHUB_ prefix, reserved CI;
 *   - "data too long": both stores' InvalidArgument text (secret.go:70,134;
 *     variable.go:46,80);
 *   - variable create on an existing name: 409 "variable name already
 *     exists" (the handler's pre-check, action.go:349-352 — ordered BEFORE
 *     CreateVariable's ValidateName, so the pre-check arm mirrors that
 *     order).
 *
 * THE AT-REST DIVERGENCE (services/secrets-variables.ts module header):
 * secret `data` stores plaintext — upstream encrypts with the instance
 * SecretKey, and the API never renders secret data, so the divergence is
 * invisible to the contract and gated on the settings-module seam.
 */

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** The rendered `Secret` (structs/secret.go:10-17) — `data` never renders. */
export const secretSchema = z.object({
  name: z.string().openapi({ description: "the secret's name" }),
  description: z.string().openapi({ description: "the secret's description" }),
  created_at: z.string().openapi({ format: "date-time" }),
});

/** The rendered `ActionVariable` (structs/variable.go:38-49) — every field
 *  serializes (no omitempty). */
export const actionVariableSchema = z.object({
  owner_id: z.number().int().openapi({ format: "int64", description: "the owner to which the variable belongs" }),
  repo_id: z.number().int().openapi({ format: "int64", description: "the repository to which the variable belongs" }),
  name: z.string().openapi({ description: "the name of the variable" }),
  data: z.string().openapi({ description: "the value of the variable" }),
  description: z.string().openapi({ description: "the description of the variable" }),
});

/** `#/definitions/CreateOrUpdateSecretOption` — `data` is contract-required. */
const createOrUpdateSecretOptionSchema = z.object({
  data: z.string().openapi({ description: "Data of the secret to update" }),
  description: z.string().optional().openapi({ description: "Description of the secret to update" }),
});

/** `#/definitions/CreateVariableOption` — `value` is contract-required. */
const createVariableOptionSchema = z.object({
  value: z.string().openapi({ description: "Value of the variable to create" }),
  description: z.string().optional().openapi({ description: "Description of the variable to create" }),
});

/** `#/definitions/UpdateVariableOption` — `value` required; `name` renames
 *  (empty/absent keeps the path name, action.go:410-412). */
const updateVariableOptionSchema = z.object({
  name: z.string().optional().openapi({ description: "New name for the variable. If the field is empty, the variable name won't be updated." }),
  value: z.string().openapi({ description: "Value of the variable to update" }),
  description: z.string().optional().openapi({ description: "Description of the variable to update" }),
});

// ---------------------------------------------------------------------------
// Shared response/param fragments.
// ---------------------------------------------------------------------------

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const orgParams = {
  org: z.string().min(1).openapi({ description: "name of the organization" }),
} as const;

const secretNameParams = {
  secretname: z.string().min(1).openapi({ description: "name of the secret" }),
} as const;

const variableNameParams = {
  variablename: z.string().min(1).openapi({ description: "name of the variable" }),
} as const;

// ---------------------------------------------------------------------------
// Gates — the repo reqOwner seam and the org guard trio.
// ---------------------------------------------------------------------------

/**
 * `reqOwner` (routers/api/v1/api.go:354-361) — the repo's owner user (the
 * ownerNamespace login match, services/repository.ts:100-102's private
 * seam), the site admin (checked explicitly upstream at :356), or an org
 * owner-team member (`doerRepoAccessMode === "owner"`, the
 * GetUserRepoPermission owners-team bridge, repo_permission.go:514).
 * Admin-mode collaborators and write collaborators rank below
 * AccessModeOwner and take the exact upstream 403 message.
 */
async function requireRepoOwner(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  const doer = c.get("authUser");
  if (doer !== undefined) {
    if (doer.is_admin === true) {
      return;
    }
    if (doer.login !== undefined && doer.login.toLowerCase() === found.repo.ownerNamespace) {
      return;
    }
    if (doer.id !== undefined && (await doerRepoAccessMode(c.env.DB, found.repo, doer.id)) === "owner") {
      return;
    }
  }
  throw new ApiError(403, "user should be the owner of the repo");
}

/** Shared 404 for org-scoped misses (missing org, invisible org —
 *  APIErrorNotFound, indistinguishable upstream). */
function orgNotFound(): ApiError {
  return new ApiError(404, "not found");
}

/**
 * The renamed-org 307 as a thrown HTTPException carrying its prepared
 * response (services/context/context_response.go RedirectToUser) — the
 * route's declared response union stays {…, 404}-shaped while
 * giteaErrorHandler passes the prepared 307 through untouched (the
 * hooks-scopes seam, restated).
 */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/**
 * The orgAssignment + reqOrgVisible + reqOrgOwnership trio
 * (api.go:1725/1786, 452-475, 423-450) — resolve the org (307 on rename,
 * 404-shaped miss otherwise), then visibility, then ownership (org owner or
 * site admin, else the exact upstream 403 message). The hooks-scopes restatement
 * of the routes/orgs.ts trio — resolveOrg is private there and orgs.ts is
 * outside this module's ownership.
 */
async function requireOrgActionsAccess(
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
// Body bind hooks — the Go binder's `<Field>: <error>` Required texts
// (api.go:841-844); any other bind failure takes the family's generic text.
// ---------------------------------------------------------------------------

/** Secret PUT — the `data` field's binding:"Required" (structs/secret.go:25). */
const secretBodyHook = ({ success, error }: { success: boolean; error?: { issues: { path: (string | number | symbol)[] }[] } }): undefined => {
  if (!success) {
    const field = error?.issues[0]?.path[0];
    throw new ApiError(422, field === "data" ? "Data: Required" : "invalid request body");
  }
  return undefined;
};

/** Variable create/update — `value`'s binding:"Required" (structs/variable.go:12,28). */
const variableBodyHook = ({ success, error }: { success: boolean; error?: { issues: { path: (string | number | symbol)[] }[] } }): undefined => {
  if (!success) {
    const field = error?.issues[0]?.path[0];
    throw new ApiError(422, field === "value" ? "Value: Required" : "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerSecretsVariablesRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // =========================================================================
  // REPO SCOPE (8) — reqToken() + reqOwner(), api.go:971-985.
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/secrets (repoListActionsSecrets)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/secrets",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List a repo's actions secrets",
      operationId: "repoListActionsSecrets",
      request: {
        params: z.object(ownerRepoParams),
        ...listQuery,
      },
      responses: {
        200: {
          description: "SecretList",
          content: { "application/json": { schema: z.array(secretSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listSecretRows(c.env.DB, repoScope(pair.repo.id), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map(toApiSecret), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/actions/secrets/{secretname} (updateRepoSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create or Update a secret value in a repository",
      operationId: "updateRepoSecret",
      request: {
        params: z.object({ ...ownerRepoParams, ...secretNameParams }),
        body: { content: { "application/json": { schema: createOrUpdateSecretOptionSchema } } },
      },
      responses: {
        201: { description: "response when creating a secret" },
        204: { description: "response when updating a secret" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const form = c.req.valid("json");
      const { created } = await createOrUpdateSecret(
        c.env.DB,
        repoScope(pair.repo.id),
        c.req.valid("param").secretname,
        form.data,
        form.description ?? "",
      );
      return c.body(null, created ? 201 : 204);
    },
    secretBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/actions/secrets/{secretname} (deleteRepoSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a secret in a repository",
      operationId: "deleteRepoSecret",
      request: {
        params: z.object({ ...ownerRepoParams, ...secretNameParams }),
      },
      responses: {
        204: { description: "delete one secret of the repository" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const row = await deleteSecretByName(c.env.DB, repoScope(pair.repo.id), c.req.valid("param").secretname);
      if (row === null) {
        throw new ApiError(404, secretNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/variables (getRepoVariablesList)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/variables",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get repo-level variables list",
      operationId: "getRepoVariablesList",
      request: {
        params: z.object(ownerRepoParams),
        ...listQuery,
      },
      responses: {
        200: {
          description: "VariableList",
          content: { "application/json": { schema: z.array(actionVariableSchema) } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listVariableRows(c.env.DB, repoScope(pair.repo.id), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map(toApiVariable), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/actions/variables/{variablename} (getRepoVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a repo-level variable",
      operationId: "getRepoVariable",
      request: {
        params: z.object({ ...ownerRepoParams, ...variableNameParams }),
      },
      responses: {
        200: {
          description: "ActionVariable",
          content: { "application/json": { schema: actionVariableSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const row = await getVariableRow(c.env.DB, repoScope(pair.repo.id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.json(toApiVariable(row), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/actions/variables/{variablename}
  // (createRepoVariable) — the 409 pre-check runs BEFORE the name validation,
  // mirroring the upstream handler order (action.go:341-357).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a repo-level variable",
      operationId: "createRepoVariable",
      request: {
        params: z.object({ ...ownerRepoParams, ...variableNameParams }),
        body: { content: { "application/json": { schema: createVariableOptionSchema } } },
      },
      responses: {
        201: { description: "response when creating a repo-level variable" },
        400: errorResponse,
        409: { description: "variable name already exists.", content: { "application/json": { schema: apiErrorSchema } } },
        500: errorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const { variablename } = c.req.valid("param");
      const form = c.req.valid("json");
      if ((await getVariableRow(c.env.DB, repoScope(pair.repo.id), variablename)) !== null) {
        throw new ApiError(409, "variable name already exists");
      }
      await createVariableRow(c.env.DB, repoScope(pair.repo.id), variablename, form.value, form.description ?? "");
      return c.body(null, 201);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/actions/variables/{variablename}
  // (updateRepoVariable) — the dead 201 is the contract's own declaration
  // (the handler only Status(204)s).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Update a repo-level variable",
      operationId: "updateRepoVariable",
      request: {
        params: z.object({ ...ownerRepoParams, ...variableNameParams }),
        body: { content: { "application/json": { schema: updateVariableOptionSchema } } },
      },
      responses: {
        201: { description: "response when updating a repo-level variable" },
        204: { description: "response when updating a repo-level variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const form = c.req.valid("json");
      const updated = await updateVariableRow(
        c.env.DB,
        repoScope(pair.repo.id),
        c.req.valid("param").variablename,
        form.name,
        form.value,
        form.description,
      );
      if (updated === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/actions/variables/{variablename}
  // (deleteRepoVariable) — the declared 200/201 are the contract's own
  // leftovers; the handler 404s the miss and 204s the hit.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a repo-level variable",
      operationId: "deleteRepoVariable",
      request: {
        params: z.object({ ...ownerRepoParams, ...variableNameParams }),
      },
      responses: {
        200: {
          description: "ActionVariable",
          content: { "application/json": { schema: actionVariableSchema } },
        },
        201: { description: "response when deleting a variable" },
        204: { description: "response when deleting a variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoOwner(c, pair);
      const row = await deleteVariableRow(c.env.DB, repoScope(pair.repo.id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );

  // =========================================================================
  // ORG SCOPE (8) — reqToken() + reqOrgOwnership(), api.go:1738-1742.
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /orgs/{org}/actions/secrets (orgListActionsSecrets)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{org}/actions/secrets",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "List an org's actions secrets",
      operationId: "orgListActionsSecrets",
      request: {
        params: z.object(orgParams),
        ...listQuery,
      },
      responses: {
        200: {
          description: "SecretList",
          content: { "application/json": { schema: z.array(secretSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listSecretRows(c.env.DB, ownerScope(org.id), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map(toApiSecret), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /orgs/{org}/actions/secrets/{secretname} (updateOrgSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{org}/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Create or Update a secret value in an organization",
      operationId: "updateOrgSecret",
      request: {
        params: z.object({ ...orgParams, ...secretNameParams }),
        body: { content: { "application/json": { schema: createOrUpdateSecretOptionSchema } } },
      },
      responses: {
        201: { description: "response when creating a secret" },
        204: { description: "response when updating a secret" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const form = c.req.valid("json");
      const { created } = await createOrUpdateSecret(
        c.env.DB,
        ownerScope(org.id),
        c.req.valid("param").secretname,
        form.data,
        form.description ?? "",
      );
      return c.body(null, created ? 201 : 204);
    },
    secretBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /orgs/{org}/actions/secrets/{secretname} (deleteOrgSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{org}/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Delete a secret in an organization",
      operationId: "deleteOrgSecret",
      request: {
        params: z.object({ ...orgParams, ...secretNameParams }),
      },
      responses: {
        204: { description: "delete one secret of the organization" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const row = await deleteSecretByName(c.env.DB, ownerScope(org.id), c.req.valid("param").secretname);
      if (row === null) {
        throw new ApiError(404, secretNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /orgs/{org}/actions/variables (getOrgVariablesList)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{org}/actions/variables",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Get an org-level variables list",
      operationId: "getOrgVariablesList",
      request: {
        params: z.object(orgParams),
        ...listQuery,
      },
      responses: {
        200: {
          description: "VariableList",
          content: { "application/json": { schema: z.array(actionVariableSchema) } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listVariableRows(c.env.DB, ownerScope(org.id), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map(toApiVariable), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /orgs/{org}/actions/variables/{variablename} (getOrgVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{org}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Get an org-level variable",
      operationId: "getOrgVariable",
      request: {
        params: z.object({ ...orgParams, ...variableNameParams }),
      },
      responses: {
        200: {
          description: "ActionVariable",
          content: { "application/json": { schema: actionVariableSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const row = await getVariableRow(c.env.DB, ownerScope(org.id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.json(toApiVariable(row), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /orgs/{org}/actions/variables/{variablename} (createOrgVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{org}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Create an org-level variable",
      operationId: "createOrgVariable",
      request: {
        params: z.object({ ...orgParams, ...variableNameParams }),
        body: { content: { "application/json": { schema: createVariableOptionSchema } } },
      },
      responses: {
        201: { description: "successfully created the org-level variable" },
        400: errorResponse,
        409: { description: "variable name already exists.", content: { "application/json": { schema: apiErrorSchema } } },
        500: errorResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const { variablename } = c.req.valid("param");
      const form = c.req.valid("json");
      if ((await getVariableRow(c.env.DB, ownerScope(org.id), variablename)) !== null) {
        throw new ApiError(409, "variable name already exists");
      }
      await createVariableRow(c.env.DB, ownerScope(org.id), variablename, form.value, form.description ?? "");
      return c.body(null, 201);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // PUT /orgs/{org}/actions/variables/{variablename} (updateOrgVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{org}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Update an org-level variable",
      operationId: "updateOrgVariable",
      request: {
        params: z.object({ ...orgParams, ...variableNameParams }),
        body: { content: { "application/json": { schema: updateVariableOptionSchema } } },
      },
      responses: {
        201: { description: "response when updating an org-level variable" },
        204: { description: "response when updating an org-level variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const form = c.req.valid("json");
      const updated = await updateVariableRow(
        c.env.DB,
        ownerScope(org.id),
        c.req.valid("param").variablename,
        form.name,
        form.value,
        form.description,
      );
      if (updated === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /orgs/{org}/actions/variables/{variablename} (deleteOrgVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{org}/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["organization"],
      summary: "Delete an org-level variable",
      operationId: "deleteOrgVariable",
      request: {
        params: z.object({ ...orgParams, ...variableNameParams }),
      },
      responses: {
        200: {
          description: "ActionVariable",
          content: { "application/json": { schema: actionVariableSchema } },
        },
        201: { description: "response when deleting a variable" },
        204: { description: "response when deleting a variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const org = await requireOrgActionsAccess(c.env.DB, c.req.valid("param").org, authedDoer(c), c.req.path, new URL(c.req.url).search);
      const row = await deleteVariableRow(c.env.DB, ownerScope(org.id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );

  // =========================================================================
  // USER SCOPE (7) — the /user group's reqToken() (api.go:1093, 1113-1127):
  // the doer IS the owner, no further gate.
  // =========================================================================

  // -------------------------------------------------------------------------
  // PUT /user/actions/secrets/{secretname} (updateUserSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/user/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Create or Update a secret value in a user scope",
      operationId: "updateUserSecret",
      request: {
        params: z.object(secretNameParams),
        body: { content: { "application/json": { schema: createOrUpdateSecretOptionSchema } } },
      },
      responses: {
        201: { description: "response when creating a secret" },
        204: { description: "response when updating a secret" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const form = c.req.valid("json");
      const { created } = await createOrUpdateSecret(
        c.env.DB,
        ownerScope(authedDoer(c).id),
        c.req.valid("param").secretname,
        form.data,
        form.description ?? "",
      );
      return c.body(null, created ? 201 : 204);
    },
    secretBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /user/actions/secrets/{secretname} (deleteUserSecret)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/user/actions/secrets/{secretname}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Delete a secret in a user scope",
      operationId: "deleteUserSecret",
      request: {
        params: z.object(secretNameParams),
      },
      responses: {
        204: { description: "delete one secret of the user" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const row = await deleteSecretByName(c.env.DB, ownerScope(authedDoer(c).id), c.req.valid("param").secretname);
      if (row === null) {
        throw new ApiError(404, secretNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /user/actions/variables (getUserVariablesList)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/user/actions/variables",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Get user-level variables list",
      operationId: "getUserVariablesList",
      request: listQuery,
      responses: {
        200: {
          description: "VariableList",
          content: { "application/json": { schema: z.array(actionVariableSchema) } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listVariableRows(c.env.DB, ownerScope(authedDoer(c).id), opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      return c.json(rows.map(toApiVariable), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /user/actions/variables/{variablename} (getUserVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/user/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Get a user-level variable",
      operationId: "getUserVariable",
      request: {
        params: z.object(variableNameParams),
      },
      responses: {
        200: {
          description: "ActionVariable",
          content: { "application/json": { schema: actionVariableSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const row = await getVariableRow(c.env.DB, ownerScope(authedDoer(c).id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.json(toApiVariable(row), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /user/actions/variables/{variablename} (createUserVariable) — the
  // user-scope create declares NO 500 (the contract's own omission; the
  // repo/org siblings carry it).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/user/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Create a user-level variable",
      operationId: "createUserVariable",
      request: {
        params: z.object(variableNameParams),
        body: { content: { "application/json": { schema: createVariableOptionSchema } } },
      },
      responses: {
        201: { description: "successfully created the user-level variable" },
        400: errorResponse,
        409: { description: "variable name already exists.", content: { "application/json": { schema: apiErrorSchema } } },
      },
    }),
    async (c) => {
      const { variablename } = c.req.valid("param");
      const form = c.req.valid("json");
      const scope = ownerScope(authedDoer(c).id);
      if ((await getVariableRow(c.env.DB, scope, variablename)) !== null) {
        throw new ApiError(409, "variable name already exists");
      }
      await createVariableRow(c.env.DB, scope, variablename, form.value, form.description ?? "");
      return c.body(null, 201);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // PUT /user/actions/variables/{variablename} (updateUserVariable)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/user/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Update a user-level variable",
      operationId: "updateUserVariable",
      request: {
        params: z.object(variableNameParams),
        body: { content: { "application/json": { schema: updateVariableOptionSchema } } },
      },
      responses: {
        201: { description: "response when updating a variable" },
        204: { description: "response when updating a variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const form = c.req.valid("json");
      const updated = await updateVariableRow(
        c.env.DB,
        ownerScope(authedDoer(c).id),
        c.req.valid("param").variablename,
        form.name,
        form.value,
        form.description,
      );
      if (updated === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
    variableBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /user/actions/variables/{variablename} (deleteUserVariable) — the
  // contract omits the 200 its repo/org siblings declare.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/user/actions/variables/{variablename}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "Delete a user-level variable",
      operationId: "deleteUserVariable",
      request: {
        params: z.object(variableNameParams),
      },
      responses: {
        201: { description: "response when deleting a variable" },
        204: { description: "response when deleting a variable" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const row = await deleteVariableRow(c.env.DB, ownerScope(authedDoer(c).id), c.req.valid("param").variablename);
      if (row === null) {
        throw new ApiError(404, variableNotFoundMessage());
      }
      return c.body(null, 204);
    },
  );
}
