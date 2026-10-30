import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { assertDemoRepoQuota, DemoRepoQuotaError } from "../../services/demo-quota";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createRepoOptionSchema, repositoryListSchema, repositorySchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { toCreatedOrgRepository } from "../services/org-repos";
import {
  findRepositoryById,
  findUserByName,
  listOwnedRepositories,
  listUserRepositories,
  toApiRepository,
  viewerOf,
} from "../services/repository";
import { loadRepoSettings } from "../services/repo-settings";
import { createUserRepository, findDoerRow, resolveAutoInitReadme } from "../services/user-repos";

/**
 * Tier-1 `user`-tagged repository routes (SPEC-0004 §2.4 rows:
 * `GET /users/{username}/repos` (userListRepos), `GET /user/repos`
 * (userCurrentListRepos) and `POST /user/repos` (createCurrentUserRepo)). The
 * two lists send the runtime list headers upstream sends on every list
 * (`X-Total-Count`, `Link`).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuerySchema = {
  query: z.object({
    page: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/**
 * `GET /users/{username}/repos` — public repositories of the user (all of
 * them when the token resolves to the user themself or a site admin); 404
 * when the user does not exist. Token optional (upstream Contexter resolves
 * `ctx.Doer` on every route — visibility widens for the owner/admin).
 */
function userListReposRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/users/{username}/repos",
    tags: ["user"],
    summary: "List the repos owned by the given user",
    operationId: "userListRepos",
    middleware: [optionalAuth],
    request: {
      ...listQuerySchema,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose owned repos are to be listed" }),
      }),
    },
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
      404: notFoundResponse,
    },
  });
}

/**
 * `GET /user/repos` — requires a signed-in caller (upstream `reqToken`);
 * anonymous callers get the runtime 401 `token is required` body exactly
 * like `GET /user` (not declared here: the vendored contract documents only
 * 200 — /user's RUNTIME_ONLY_RESPONSES exception pattern, orchestrator-owned
 * table). Created inside `registerUserReposRoutes`: the declaration carries
 * the `requireAuth` middleware handed in by the router.
 */
function userCurrentListReposRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/user/repos",
    tags: ["user"],
    summary: "List the repos that the authenticated user owns",
    operationId: "userCurrentListRepos",
    middleware: [requireAuth],
    request: listQuerySchema,
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
    },
  });
}

/**
 * `POST /user/repos` — 201 + the Repository at owner permissions
 * (createCurrentUserRepo → upstream repo.Create). Upstream wires the route
 * `rejectPublicOnly()` inside the reqToken'd /user group (api.go:1181) — a
 * signed-in caller is required (anonymous → the runtime 401 `token is
 * required` body, the /user RUNTIME_ONLY class; not declared: the vendored
 * contract declares only {201, 400, 409, 422}). Guard order mirrors
 * CreateUserRepo: unknown readme template → 400; duplicate name → 409 with
 * the upstream message; invalid/reserved name → 422 (the IsUsableRepoName
 * port; our message text differs from Go's error strings — the createOrgRepo
 * note applies). `auto_init` lands the initial commit through the engine
 * (services/user-repos.ts owns the fidelity notes and divergences).
 */
function createCurrentUserRepoRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "post",
    path: "/user/repos",
    tags: ["user"],
    summary: "Create a repository",
    operationId: "createCurrentUserRepo",
    middleware: [requireAuth],
    request: {
      body: { content: { "application/json": { schema: createRepoOptionSchema } } },
    },
    responses: {
      201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      400: errorResponse,
      409: { description: "The repository with the same name already exists." },
      422: validationErrorResponse,
    },
  });
}

export function registerUserReposRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(userListReposRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const viewer = viewerOf(c);
    const user = await findUserByName(c.env.DB, username);
    if (user === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listUserRepositories(c.env.DB, user.usernameLower, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(userCurrentListReposRoute(requireAuth), async (c) => {
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOwnedRepositories(c.env.DB, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(createCurrentUserRepoRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const form = c.req.valid("json");
    // 400 arm first (upstream CreateUserRepo validates the readme template
    // before touching the database).
    resolveAutoInitReadme(form);
    const owner = await findDoerRow(c.env.DB, doer);
    if (owner === null) {
      throw new ApiError(401, "token is required");
    }
    // SPEC-0014 §4.3 — the gated demo repo-count quota (M2): upstream rides
    // the limit check inside the create service (doer.CanCreateRepoIn,
    // user.go:285-295 — the admin doer bypass included — refusing with
    // ErrReachLimitOfRepo); cf-gitea's check rides THIS route (the create
    // call site the SPEC names) because RepoService carries no env, and the
    // owner row IS the doer row here. Gate off → zero reads, zero checks
    // (the §2 invariant). Upstream maps the limit refusal through its
    // ErrPermissionDenied unwrap to 403 + err.Error()
    // (routers/api/v1/repo/repo.go:256-258) — the exact status + message
    // below.
    try {
      await assertDemoRepoQuota(c.env, c.env.DB, owner, owner.id);
    } catch (error) {
      if (error instanceof DemoRepoQuotaError) {
        throw new ApiError(403, error.message);
      }
      throw error;
    }
    let repo;
    try {
      repo = await createUserRepository(c.env.DB, c.env, owner, form, new Date());
    } catch (error) {
      if (error instanceof RepoNameCollisionError) {
        throw new ApiError(409, "The repository with the same name already exists.");
      }
      if (error instanceof RepoNameInvalidError) {
        // upstream 422s err.Error() for reserved/pattern violations; our
        // ported message text differs from Go's error strings
        throw new ApiError(422, error.message);
      }
      throw error;
    }
    const viewer = viewerOf(c);
    // Webhook: repository created (upstream CreateRepository,
    // notifier.go:114-116 — Sender is the creating doer, Organization the
    // owner user). Emitted after the create committed; a webhook failure is
    // caught inside the fan-out and never fails the 201.
    const created = await findRepositoryById(c.env.DB, repo.id);
    if (created !== null) {
      const identity = repositoryEventIdentity(viewer, created);
      await emitRepoEvent(c, {
        repoId: created.repo.id,
        ownerId: created.repo.ownerId,
        eventType: "repository",
        payload: repositoryEventPayload("created", identity.repository, identity.organization, doer),
      });
    }
    // The CreateUserRepo tail: `convert.ToRepo(ctx, repo, Permission{
    // AccessModeOwner})` — the creator's embedded permissions block is the
    // full owner triple (services/org-repos.ts toCreatedOrgRepository).
    // Upstream reloads the row "to get a real state after creation"
    // (repo.go:270-274) so the 201 carries the sent description; the settings
    // read is our equivalent reload (the sweep keeps description in the
    // repo_settings side table — the create service wrote it above). Without
    // it the 201 rendered the empty default and dropped the field (F6).
    const settings = await loadRepoSettings(c.env.DB, repo.id);
    return c.json(toCreatedOrgRepository(viewer, { repo, owner }, settings), 201);
  });
}
