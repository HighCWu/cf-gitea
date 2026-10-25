import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositoryListSchema, repositorySchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { requireCanCreateOrgRepo } from "../services/org-repos";
import { createFork, findForkByOwner, listForks, toForkRepository } from "../services/forks";
import {
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  findUserByName,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";

/**
 * Tier-1 fork routes (SPEC-0004 §2.4 row `GET/POST /repos/{owner}/{repo}/forks`
 * — upstream routers/api/v1/repo/fork.go ListForks/CreateFork, registered
 * `m.Combo("/forks").Get(repo.ListForks).Post(reqToken(), reqRepoReader(…))`,
 * api.go:1312-1313):
 *
 *   GET  — anonymous allowed upstream (no reqToken on the Get arm); the fork
 *          list is visibility-filtered per viewer (FindForks'
 *          AccessibleRepositoryCondition) and sends the runtime list headers.
 *   POST — a signed-in reader of the SOURCE forks it (404 anti-enumeration
 *          for invisible sources); 202 Accepted + the fork's Repository at
 *          owner permissions, with the git replication handed to the
 *          REPO_TASKS consumer ({kind: "repo-fork"}, src/repos/fork-task.ts —
 *          SPEC-0001b §5.3 full-copy, no cross-repo pack sharing).
 *
 * Declared responses mirror the vendored contract exactly (202 with a
 * Repository body — the upstream "TODO change back to 201" quirk is kept
 * faithful; 409 declares no body, upstream's APIError 409s still marshal
 * {message, url} at runtime — the suite's documented empty-409 conversion).
 */

/**
 * Mirror of the vendored contract's `CreateForkOption`
 * (#/definitions/CreateForkOption) — field-for-field. The contract declares
 * no `required` fields and NO `default_branch_only` (that upstream option
 * postdates the vendored pin — it is not in the frozen contract, so it is not
 * accepted here; the 422 validator rejects unknown fields anyway).
 */
const createForkOptionSchema = z.object({
  name: z.string().optional().openapi({ description: "name of the forked repository" }),
  organization: z
    .string()
    .optional()
    .openapi({ description: "organization name, if forking into an organization" }),
});

type CreateForkOption = z.infer<typeof createForkOptionSchema>;

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

const listQuery = {
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

/** `GET /repos/{owner}/{repo}/forks` — the RepositoryList page (upstream
 *  ListForks: SetLinkHeader + SetTotalCountHeader + ToRepo per fork). */
const listForksRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/forks",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repository's forks",
    operationId: "listForks",
    request: {
      ...listQuery,
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
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

/** `POST /repos/{owner}/{repo}/forks` — 202 (upstream's CreateFork accepted
 *  code; the "TODO change back to 201" comment is upstream's own). */
const createForkRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/forks",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Fork a repository",
    operationId: "createFork",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo to fork" }),
        repo: z.string().min(1).openapi({ description: "name of the repo to fork" }),
      }),
      body: { content: { "application/json": { schema: createForkOptionSchema } } },
    },
    responses: {
      202: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      409: { description: "The repository with the same name already exists." },
      422: validationErrorResponse,
    },
  });

/** Visible-source-or-404 (the reqRepoReader anti-enumeration shape both
 *  routes share; SPEC-0003's ACL matrix + the SPEC-0007 §3.5 team grant). */
async function requireVisibleSource(c: Context<ApiEnv>, owner: string, repo: string): Promise<RepositoryWithOwner> {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, owner, repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  return found;
}

export function registerForkRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listForksRoute(optionalAuth), async (c) => {
    const { owner, repo } = c.req.valid("param");
    const source = await requireVisibleSource(c, owner, repo);
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listForks(c.env.DB, source.repo.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
      doerLoginLower: viewer.requester?.login?.toLowerCase() ?? null,
      isAdmin: viewer.requester?.is_admin === true,
    });
    setPaginationHeaders(c, total, listOptions);
    // The list renders through the stock converter (services/repository.ts
    // owns the TODO markers); forks keep the stock `fork: false` projection
    // on LIST bodies — the maintained column does not exist yet and the list
    // shape is the frozen-contract mirror either way. (The POST 202 body
    // carries the real `fork: true` + `parent` via toForkRepository.)
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(createForkRoute(requireAuth), async (c) => {
    const { owner, repo } = c.req.valid("param");
    const doer = c.get("authUser");
    const source = await requireVisibleSource(c, owner, repo);
    const viewer = viewerOf(c);
    const doerRow =
      doer.id === undefined || doer.login === undefined
        ? null
        : await findUserByName(c.env.DB, doer.login);
    if (doerRow === null) {
      throw new ApiError(401, "token is required"); // the silent-auth-failure convention
    }

    // Upstream guard order (CreateFork + prepareDoerCreateRepoInOrg): the
    // target owner resolves FIRST — organization ? org grant chain : doer.
    const form: CreateForkOption = c.req.valid("json");
    let targetOwner: { id: number; usernameLower: string };
    if (form.organization !== undefined) {
      // 404 (missing/invisible org) → 403 (no repo-create grant) inside.
      const org = await requireCanCreateOrgRepo(c.env.DB, form.organization, {
        id: doerRow.id,
        isAdmin: doer.is_admin === true,
      });
      targetOwner = { id: org.id, usernameLower: org.usernameLower };
    } else {
      targetOwner = { id: doerRow.id, usernameLower: doerRow.usernameLower };
    }

    // `optional.FromPtr(form.Name).ValueOrDefault(repo.Name)` — the source's
    // name is the default fork name.
    const name = form.name !== undefined && form.name !== "" ? form.name : source.repo.slug;

    // GetUserFork: at most one fork of this source per owner (the 409 that
    // slug-collision checking alone would miss when a custom name is given).
    const existing = await findForkByOwner(c.env.DB, source.repo.id, targetOwner.id);
    if (existing !== null) {
      throw new ApiError(
        409,
        `repository is already forked by user [uname: ${existing.ownerNamespace}, repo path: ${source.repo.ownerNamespace}/${source.repo.slug}, fork path: ${existing.ownerNamespace}/${existing.slug}]`,
      );
    }

    const { fork } = await createFork(
      c.env.DB,
      { queue: c.env.REPO_TASKS },
      { source, targetOwner, name },
    ).catch((error: unknown) => {
      if (error instanceof RepoNameCollisionError) {
        throw new ApiError(409, "The repository with the same name already exists.");
      }
      if (error instanceof RepoNameInvalidError) {
        // upstream 422s err.Error() for reserved/pattern violations; our
        // ported message text differs from Go's error strings
        throw new ApiError(422, error.message);
      }
      throw error;
    });

    const forkPair = await findRepositoryByPath(c.env.DB, fork.ownerNamespace, fork.slug);
    if (forkPair === null) {
      throw new ApiError(500, "fork row vanished after creation");
    }
    return c.json(toForkRepository(viewer, forkPair, source), 202);
  });
}
