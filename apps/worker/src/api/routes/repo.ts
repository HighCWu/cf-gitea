import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositorySchema, searchResultsSchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  findRepositoryById,
  findRepositoryByPath,
  formBool,
  formBoolValue,
  formInt64,
  formString,
  formTrim,
  canViewRepository,
  searchRepositories,
  toApiRepository,
  viewerOf,
  type Viewer,
} from "../services/repository";

/**
 * Tier-1 `repository`-tagged repo-metadata reads (SPEC-0004 §2.4):
 * `GET /repos/{owner}/{repo}` (repoGet), `GET /repos/search` (repoSearch),
 * `GET /repositories/{id}` (repoGetByID).
 *
 * 404s follow the upstream anti-enumeration rule: a missing repository and a
 * private repository invisible to the requester are indistinguishable
 * (APIErrorNotFound → `{message: "not found", url}` at runtime; the vendored
 * contract declares the notFound response body-less — SPEC-0004 §2.5 quirk).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Query params declared as lenient strings (upstream never 400s on query
 * garbage — Go form helpers coerce); the generated OpenAPI types are
 * overridden to the contract's `boolean`/`integer` per parameter. */
const formBoolParam = (description: string) =>
  z.string().optional().openapi({ type: "boolean", description });
const formIntParam = (description: string) =>
  z.string().optional().openapi({ type: "integer", format: "int64", description });

/**
 * `GET /repos/{owner}/{repo}` — vendored contract: tag `repository`,
 * operationId `repoGet`, 200 → Repository + 404 → notFound. Anonymous reads
 * of public repositories; private ones 404 unless the token resolves to the
 * owner or a site admin (reduced ACL — SPEC-0003 owns the full matrix).
 */
function getRepoRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
  method: "get",
  path: "/repos/{owner}/{repo}",
  middleware: [optionalAuth],
  tags: ["repository"],
  summary: "Get a repository",
  operationId: "repoGet",
  request: {
    params: z.object({
      owner: z.string().min(1).openapi({ description: "owner of the repo" }),
      repo: z.string().min(1).openapi({ description: "name of the repo" }),
    }),
  },
  responses: {
    200: {
      description: "Repository",
      content: { "application/json": { schema: repositorySchema } },
    },
    404: notFoundResponse,
  },
  });
}

/**
 * `GET /repos/search` — 17 query params per the contract; 200 → SearchResults
 * + 422 → validationError (invalid `mode`/`sort`/`order`). Runtime list
 * headers (`X-Total-Count`, `Link`) are sent upstream-style on every list.
 * Token is optional (`?private=true` visibility depends on the caller).
 */
function searchReposRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
  method: "get",
  path: "/repos/search",
  middleware: [optionalAuth],
  tags: ["repository"],
  summary: "Search for repositories",
  operationId: "repoSearch",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "keyword" }),
      topic: formBoolParam("Limit search to repositories with keyword as topic"),
      includeDesc: formBoolParam("include search of keyword within repository description"),
      uid: formIntParam("search only for repos that the user with the given id owns or contributes to"),
      priority_owner_id: formIntParam("repo owner to prioritize in the results"),
      team_id: formIntParam("search only for repos that belong to the given team id"),
      starredBy: formIntParam("search only for repos that the user with the given id has starred"),
      private: formBoolParam("include private repositories this user has access to (defaults to true)"),
      is_private: formBoolParam("show only pubic, private or all repositories (defaults to all)"),
      template: formBoolParam("include template repositories this user has access to (defaults to true)"),
      archived: formBoolParam("show only archived, non-archived or all repositories (defaults to all)"),
      mode: z
        .string()
        .optional()
        .openapi({
          description:
            'type of repository to search for. Supported values are "fork", "source", "mirror" and "collaborative"',
        }),
      exclusive: formBoolParam("if `uid` is given, search only for repos that the user owns"),
      sort: z
        .string()
        .optional()
        .openapi({
          description:
            'sort repos by attribute. Supported values are "alpha", "created", "updated", "size", "git_size", "lfs_size", "stars", "forks" and "id". Default is "alpha"',
        }),
      order: z
        .string()
        .optional()
        .openapi({
          description:
            'sort order, either "asc" (ascending) or "desc" (descending). Default is "asc", ignored if "sort" is not specified.',
        }),
      page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
      limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
    }),
  },
  responses: {
    200: {
      description: "SearchResults",
      content: { "application/json": { schema: searchResultsSchema } },
    },
    422: {
      description: "validationError",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
  });
}

/**
 * `GET /repositories/{id}` — token REQUIRED upstream (`reqToken`,
 * SPEC-0004 §2.4): anonymous callers get the runtime 401 `token is required`
 * body exactly like `GET /user` (declared 401 stays out of this operation
 * because the vendored contract documents only 200/404 — the /user
 * RUNTIME_ONLY_RESPONSES exception pattern, orchestrator-owned table).
 * Created inside `registerRepoRoutes`: the declaration carries the
 * `requireAuth` middleware handed in by the router.
 */
function getRepoByIdRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/repositories/{id}",
    tags: ["repository"],
    summary: "Get a repository by id",
    operationId: "repoGetByID",
    middleware: [requireAuth],
    request: {
      params: z.object({
        id: z.string().min(1).openapi({ description: "id of the repo to get", format: "int64" }),
      }),
    },
    responses: {
      200: {
        description: "Repository",
        content: { "application/json": { schema: repositorySchema } },
      },
      404: notFoundResponse,
    },
  });
}

/** Throws the upstream 422 for `mode` values outside the contract enum. */
function validateSearchMode(raw: string): "fork" | "source" | "mirror" | "collaborative" | "" {
  switch (raw) {
    case "source":
    case "fork":
    case "mirror":
    case "collaborative":
    case "":
      return raw;
    default:
      // upstream: ctx.APIError(http.StatusUnprocessableEntity, "invalid search mode")
      throw new ApiError(422, "invalid search mode");
  }
}

/** Resolves the upstream `private` query param for a signed search:
 * `ctx.IsSigned && (FormString("private") == "" || FormBool("private"))`. */
function resolveIncludePrivate(viewer: Viewer, rawPrivate: string): boolean {
  return viewer.requester !== null && (rawPrivate === "" || formBoolValue(rawPrivate));
}

export function registerRepoRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(getRepoRoute(optionalAuth), async (c) => {
    const { owner, repo } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null || !canViewRepository(viewer, found.repo)) {
      // Missing and invisible are the same 404 upstream (anti-enumeration).
      throw new ApiError(404, "not found");
    }
    return c.json(toApiRepository(viewer, found), 200);
  });

  app.openapi(searchReposRoute(optionalAuth), async (c) => {
    const query = c.req.valid("query");
    const url = new URL(c.req.url);
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(url);
    const mode = validateSearchMode(query.mode ?? "");
    const { items, total } = await searchRepositories(c.env.DB, viewer, {
      keyword: formTrim(url.searchParams, "q"),
      topicOnly: formBool(url.searchParams, "topic"),
      includeDesc: formBool(url.searchParams, "includeDesc"),
      uid: formInt64(url.searchParams, "uid"),
      exclusive: formBool(url.searchParams, "exclusive"),
      priorityOwnerId: formInt64(url.searchParams, "priority_owner_id"),
      teamId: formInt64(url.searchParams, "team_id"),
      starredBy: formInt64(url.searchParams, "starredBy"),
      includePrivate: resolveIncludePrivate(viewer, query.private ?? ""),
      isPrivate: query.is_private === undefined || query.is_private === "" ? null : formBool(url.searchParams, "is_private"),
      template: query.template === undefined || query.template === "" ? null : formBool(url.searchParams, "template"),
      archived: query.archived === undefined || query.archived === "" ? null : formBool(url.searchParams, "archived"),
      mode,
      sort: formString(url.searchParams, "sort"),
      order: formString(url.searchParams, "order"),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json({ ok: true, data: items.map((pair) => toApiRepository(viewer, pair)) }, 200);
  });

  app.openapi(getRepoByIdRoute(requireAuth), async (c) => {
    const { id } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryById(c.env.DB, id);
    if (found === null || !canViewRepository(viewer, found.repo)) {
      throw new ApiError(404, "not found");
    }
    return c.json(toApiRepository(viewer, found), 200);
  });
}
