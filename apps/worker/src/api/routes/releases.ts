import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ReleaseAlreadyExistError } from "../../issues/errors";
import type { ReleaseRow } from "../../issues/service";
import { IssuesService } from "../../issues/service";
import { issueErrorToApiError } from "../services/issues";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createReleaseOptionSchema,
  editReleaseOptionSchema,
  releaseListSchema,
  releaseSchema,
} from "../models/release";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { loadRepoSettings } from "../services/repo-settings";
import {
  assertDraftVisible,
  assertNotTagRecord,
  deleteRelease,
  editRelease,
  findLatestRelease,
  findReleaseByTag,
  findReleaseForRepoById,
  listReleases,
  toApiRelease,
} from "../services/releases";

/**
 * Tier-1 release routes (SPEC-0004 §2.4 rows repoListReleases /
 * repoCreateRelease / repoGetLatestRelease / repoGetReleaseByTag /
 * repoDeleteReleaseByTag / repoGetRelease / repoEditRelease /
 * repoDeleteRelease; upstream routers/api/v1/repo/release.go + release_tags.go
 * over the landed `releases` D1 table — writes ride the SPEC-0005
 * IssuesService.createRelease with its 409 semantics).
 *
 * Auth (upstream registration, api.go:1408–1428): the group is
 * `mustEnableUnit(TypeReleases)`; reads are anonymous-capable on public
 * repos, writes carry `reqToken + reqRepoWriter(TypeReleases)` — the writer
 * gate is services/repo-access.ts's (reduced matrix + collaborator rows).
 * DRAFTS are 404-hidden from callers without release-write access
 * (canAccessReleaseDraft).
 *
 * Declared responses mirror the vendored contract exactly. Runtime-only code
 * the handlers can emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch, and no
 * scenario drives them):
 *   - every route of the family: 412 when the stored has_releases flag is
 *     false (upstream mustEnableUnit — the flag itself is only settable via
 *     repoEdit's has_releases);
 *   - POST: 423 is NOT emitted — the vendored pin registers NO
 *     mustNotBeArchived on release writes, unlike topics/contents.
 *
 * Engine boundary (per the batch brief — releases are D1-only until assets):
 * creating/editing a release does NOT create/rename the git tag through the
 * engine commit-builder (SPEC-0004 §3.4), and DELETE does not delete it;
 * `sha1` stays null and target_commitish is a stored string.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const conflictResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const releaseIdParams = {
  ...ownerRepoParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the release to get" }),
} as const;

const tagParams = {
  ...ownerRepoParams,
  tag: z.string().min(1).openapi({ description: "tag name of the release to get" }),
} as const;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const releaseBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Upstream `ctx.FormOptionalBool`: absent/"" = null; `true`/`1` = true;
 *  `false`/`0` = false; anything else = false-with-log (we mirror the parse,
 *  keep it total). */
function formOptionalBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "") return null;
  return raw === "true" || raw === "1" || raw === "on";
}

/** Shared repo resolution + the releases-unit gate. */
async function requireReleasesRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const found = await requireVisibleRepo(c, path);
  const settings = await loadRepoSettings(c.env.DB, found.repo.id);
  if (!settings.hasReleases) {
    // mustEnableUnit(TypeReleases) — runtime-only 412 (module header).
    throw new ApiError(412, "releases are disabled for this repo");
  }
  return found;
}

/** The release-write grant (reqRepoWriter(TypeReleases) reduced). */
async function requireReleaseWriter(c: Context<ApiEnv>, found: Awaited<ReturnType<typeof requireVisibleRepo>>): Promise<void> {
  if (await canWriteRepository(c, found)) {
    return;
  }
  throw new ApiError(403, "token does not have the required scope or the user does not have write access");
}

/** The single-release 404 (APIErrorNotFound at runtime). */
function releaseNotExist(): ApiError {
  return new ApiError(404, "not found");
}

/** GetRelease/EditRelease/DeleteRelease lookup with the upstream 404 rules:
 *  repo-scoped id, tag-only records invisible. */
async function requireReleaseById(c: Context<ApiEnv>, repoId: string, rawId: string): Promise<ReleaseRow> {
  const row = await findReleaseForRepoById(c.env.DB, repoId, pathId(rawId));
  if (row === null) {
    throw releaseNotExist();
  }
  assertNotTagRecord(row);
  return row;
}

const listReleasesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repo's releases",
    operationId: "repoListReleases",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        draft: z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "filter (exclude / include) drafts, if you don't have repo write access none will show" }),
        "pre-release": z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "filter (exclude / include) pre-releases" }),
        tag_filter: z
          .string()
          .optional()
          .openapi({ description: 'filter releases by tag. supports "*" as a wildcard (for example: v1*, *beta, *rc*).' }),
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "ReleaseList", content: { "application/json": { schema: releaseListSchema } } },
      404: notFoundResponse,
    },
  });

const createReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/releases",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a release",
    operationId: "repoCreateRelease",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createReleaseOptionSchema } } },
    },
    responses: {
      201: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
      409: conflictResponse,
      422: validationErrorResponse,
    },
  });

const getLatestReleaseRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/latest",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Gets the most recent non-prerelease, non-draft release of a repository, sorted by created_at",
    operationId: "repoGetLatestRelease",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const getReleaseByTagRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/tags/{tag}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a release by tag name",
    operationId: "repoGetReleaseByTag",
    request: { params: z.object(tagParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const deleteReleaseByTagRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/releases/tags/{tag}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a release by tag name",
    operationId: "repoDeleteReleaseByTag",
    request: { params: z.object(tagParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getReleaseRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a release",
    operationId: "repoGetRelease",
    request: { params: z.object(releaseIdParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const editReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Update a release",
    operationId: "repoEditRelease",
    request: {
      params: z.object(releaseIdParams),
      body: { content: { "application/json": { schema: editReleaseOptionSchema } } },
    },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const deleteReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a release",
    operationId: "repoDeleteRelease",
    request: { params: z.object(releaseIdParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

export function registerReleaseRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listReleasesRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const listOptions = parseListOptions(new URL(c.req.url));
    const query = c.req.valid("query");
    const canWrite = await canWriteRepository(c, found);
    const { items, total } = await listReleases(c.env.DB, found.repo.id, {
      includeDrafts: canWrite,
      isDraft: formOptionalBool(query.draft),
      isPrerelease: formOptionalBool(query["pre-release"]),
      tagFilter: (query.tag_filter ?? "").trim(),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const rendered = await Promise.all(items.map((row) => toApiRelease(c.env.DB, viewer, found, row)));
    return c.json(rendered, 200);
  });

  app.openapi(
    createReleaseRoute(requireAuth),
    async (c) => {
      const found = await requireReleasesRepo(c, c.req.valid("param"));
      await requireReleaseWriter(c, found);
      const requester = c.get("authUser");
      const viewer = { origin: new URL(c.req.url).origin, requester };
      const form = c.req.valid("json");

      // Upstream fail-fast: an empty repo has no commitish to tag (422).
      if (found.repo.refsVersion === 0) {
        throw new ApiError(422, "repo is empty");
      }

      const target = form.target_commitish !== undefined && form.target_commitish !== "" ? form.target_commitish : found.repo.defaultBranch;
      let row: ReleaseRow;
      try {
        row = await new IssuesService(c.env.DB).createRelease({
          repoId: found.repo.id,
          publisherId: requester.id ?? 0,
          tagName: form.tag_name,
          target,
          title: form.name ?? "",
          note: form.body ?? "",
          isDraft: form.draft === true,
          isPrerelease: form.prerelease === true,
        });
      } catch (error) {
        if (error instanceof ReleaseAlreadyExistError) {
          throw issueErrorToApiError(error); // the declared 409 (error-body)
        }
        throw error;
      }
      return c.json(await toApiRelease(c.env.DB, viewer, found, row), 201);
    },
    releaseBodyHook,
  );

  app.openapi(getLatestReleaseRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const row = await findLatestRelease(c.env.DB, found.repo.id);
    if (row === null) {
      throw releaseNotExist();
    }
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(getReleaseByTagRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const { tag } = c.req.valid("param");
    const row = await findReleaseByTag(c.env.DB, found.repo.id, tag);
    if (row === null) {
      throw releaseNotExist();
    }
    assertNotTagRecord(row);
    assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, row);
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(deleteReleaseByTagRoute(requireAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    await requireReleaseWriter(c, found);
    const { tag } = c.req.valid("param");
    const row = await findReleaseByTag(c.env.DB, found.repo.id, tag);
    if (row === null) {
      throw releaseNotExist();
    }
    assertNotTagRecord(row);
    await deleteRelease(c.env.DB, row);
    return c.body(null, 204);
  });

  app.openapi(getReleaseRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const { id } = c.req.valid("param");
    const row = await requireReleaseById(c, found.repo.id, id);
    assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, row);
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(
    editReleaseRoute(requireAuth),
    async (c) => {
      const found = await requireReleasesRepo(c, c.req.valid("param"));
      await requireReleaseWriter(c, found);
      const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") };
      const { id } = c.req.valid("param");
      const row = await requireReleaseById(c, found.repo.id, id);
      const form = c.req.valid("json");
      // Upstream applies only the SET fields, and only non-empty strings
      // (len(form.X) > 0 guards); the flags are explicit tri-states.
      const updated = await editRelease(c.env.DB, row, {
        tagName: form.tag_name !== undefined && form.tag_name !== "" ? form.tag_name : undefined,
        target: form.target_commitish !== undefined && form.target_commitish !== "" ? form.target_commitish : undefined,
        title: form.name !== undefined && form.name !== "" ? form.name : undefined,
        note: form.body !== undefined && form.body !== "" ? form.body : undefined,
        isDraft: form.draft,
        isPrerelease: form.prerelease,
        now: new Date(),
      });
      if (updated === null) {
        // Lost a concurrent rename/delete — the upstream UpdateRelease would
        // surface as an internal error; the re-read keeps the answer honest.
        const fresh = await findReleaseForRepoById(c.env.DB, found.repo.id, row.id);
        if (fresh === null) {
          throw releaseNotExist();
        }
        return c.json(await toApiRelease(c.env.DB, viewer, found, fresh), 200);
      }
      return c.json(await toApiRelease(c.env.DB, viewer, found, updated), 200);
    },
    releaseBodyHook,
  );

  app.openapi(deleteReleaseRoute(requireAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    await requireReleaseWriter(c, found);
    const { id } = c.req.valid("param");
    const row = await requireReleaseById(c, found.repo.id, id);
    await deleteRelease(c.env.DB, row);
    return c.body(null, 204);
  });
}
