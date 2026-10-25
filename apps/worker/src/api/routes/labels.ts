import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createLabelOptionSchema, editLabelOptionSchema, labelListSchema, labelSchema } from "../models/label";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  createRepoLabel,
  deleteRepoLabel,
  editRepoLabel,
  findRepoLabelById,
  findRepoLabelByIdOrName,
  labelNotExistError,
  listRepoLabels,
  normalizeLabelColor,
  toApiLabel,
  type LabelSortType,
} from "../services/labels";
import {
  apiRepositoryUrl,
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  viewerOf,
} from "../services/repository";

/**
 * Tier-1 `issue`-tagged repo-label routes (SPEC-0004 §2.4 rows:
 * issueListLabels / issueCreateLabel / issueGetLabel / issueEditLabel /
 * issueDeleteLabel). Reads are anonymous-capable; the writes require a token
 * upstream (`reqToken` + `reqRepoWriter(TypeIssues, TypePullRequests)` —
 * SPEC-0002 `write:issue`). No 423 archived gate here (upstream gates only
 * the issue-level label operations). Label ids are repo-scoped; the id path
 * param falls back to a name lookup on GET (upstream repo.GetLabel), while
 * PATCH/DELETE are strictly numeric.
 */

const notFoundResponse = {
  description: "notFound",
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

const repoParams = {
  params: z.object({
    ...ownerRepoParams,
    id: z
      .string()
      .min(1)
      .openapi({ type: "integer", format: "int64", description: "id of the label" }),
  }),
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const listLabelsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/labels",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get all of a repository's labels",
    operationId: "issueListLabels",
    request: { params: z.object(ownerRepoParams), ...listQuery },
    responses: {
      200: {
        description: "LabelList",
        content: { "application/json": { schema: labelListSchema } },
      },
      404: notFoundResponse,
    },
  });

const createLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/labels",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Create a label",
    operationId: "issueCreateLabel",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createLabelOptionSchema } } },
    },
    responses: {
      201: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getLabelRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/labels/{id}",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get a single label",
    operationId: "issueGetLabel",
    request: repoParams,
    responses: {
      200: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
    },
  });

const editLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/labels/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Update a label",
    operationId: "issueEditLabel",
    request: {
      ...repoParams,
      body: { content: { "application/json": { schema: editLabelOptionSchema } } },
    },
    responses: {
      200: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const deleteLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/labels/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete a label",
    operationId: "issueDeleteLabel",
    request: repoParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

/** Shared repo resolution — the anti-enumeration 404 (SPEC-0004 §2.4). */
async function requireVisibleRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  return { viewer, found };
}

/** Body bind hook: upstream's Go bind answers malformed bodies with the
 * declared 422 (`bind()` → `Name: Required`-shaped message; ours stays the
 * route-family's generic text). */
const labelBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Tri-state pointer rule: absent and JSON-null both mean "unchanged". */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/**
 * `ctx.PathParamInt64` — strict decimal or 0 (garbage ids never match a
 * label, unlike GET's name fallback).
 */
function pathParamInt64(raw: string): number {
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

export function registerLabelRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listLabelsRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    // `sort` is honored but never declared in the contract (upstream reads
    // ctx.FormString("sort") with the same mismatch); unknown values take
    // the default alphabetical order.
    const rawSort = url.searchParams.get("sort") ?? "";
    const sort: LabelSortType =
      rawSort === "reversealphabetically" || rawSort === "leastissues" || rawSort === "mostissues" ? rawSort : "";
    const { items, total } = await listRepoLabels(c.env.DB, found.repo.id, sort, listOptions.page, listOptions.limit);
    setPaginationHeaders(c, total, listOptions);
    const repoApiUrl = apiRepositoryUrl(found, viewer.origin);
    return c.json(items.map((row) => toApiLabel(row, repoApiUrl)), 200);
  });

  app.openapi(
    createLabelRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const body = c.req.valid("json");
      const color = normalizeLabelColor(body.color);
      const row = await createRepoLabel(c.env.DB, found.repo.id, {
        name: body.name,
        exclusive: body.exclusive ?? false,
        color,
        description: body.description ?? "",
        isArchived: body.is_archived ?? false,
        now: new Date(),
      });
      return c.json(toApiLabel(row, apiRepositoryUrl(found, viewer.origin)), 201);
    },
    labelBodyHook,
  );

  app.openapi(getLabelRoute(optionalAuth), async (c) => {
    const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const row = await findRepoLabelByIdOrName(c.env.DB, found.repo.id, id);
    if (row === null) {
      // Upstream's ErrRepoLabelNotExist carries the ids (label.go:33–35) —
      // label_id 0 when the lookup fell to the name branch — unlike the
      // plain `not found` of most routes.
      throw labelNotExistError(pathParamInt64(id), found.repo.id);
    }
    return c.json(toApiLabel(row, apiRepositoryUrl(found, viewer.origin)), 200);
  });

  app.openapi(
    editLabelRoute(requireAuth),
    async (c) => {
      const { viewer, found } = await requireVisibleRepo(c, c.req.valid("param"));
      const { id } = c.req.valid("param");
      const numericId = pathParamInt64(id);
      const row = await findRepoLabelById(c.env.DB, found.repo.id, numericId);
      if (row === null) {
        throw labelNotExistError(numericId, found.repo.id);
      }
      const body = c.req.valid("json");
      let color: string | undefined;
      const rawColor = patchField(body.color);
      if (rawColor !== undefined) {
        color = normalizeLabelColor(rawColor);
      }
      const updated = await editRepoLabel(c.env.DB, row, {
        name: patchField(body.name),
        exclusive: patchField(body.exclusive),
        color,
        description: patchField(body.description),
        isArchived: patchField(body.is_archived),
        now: new Date(),
      });
      return c.json(toApiLabel(updated, apiRepositoryUrl(found, viewer.origin)), 200);
    },
    labelBodyHook,
  );

  app.openapi(deleteLabelRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const row = await findRepoLabelById(c.env.DB, found.repo.id, pathParamInt64(id));
    // Upstream deleteLabel succeeds with zero deleted rows — a missing label
    // is still a 204 (models/issues/label.go:284–286).
    if (row !== null) {
      await deleteRepoLabel(c.env.DB, row);
    }
    return c.body(null, 204);
  });
}
