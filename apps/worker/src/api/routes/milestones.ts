import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  createMilestoneOptionSchema,
  editMilestoneOptionSchema,
  milestoneListSchema,
  milestoneSchema,
} from "../models/milestone";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  createRepoMilestone,
  deleteRepoMilestone,
  editRepoMilestone,
  findRepoMilestoneByIdOrName,
  listRepoMilestones,
  parseMilestoneDeadline,
  toApiMilestone,
} from "../services/milestones";
import { IssuesService } from "../../issues/service";
import { canViewRepositoryWithTeams, findRepositoryByPath, viewerOf } from "../services/repository";

/**
 * Tier-1 `issue`-tagged repo-milestone routes (SPEC-0004 §2.4 rows:
 * issueGetMilestonesList / issueCreateMilestone / issueGetMilestone /
 * issueEditMilestone / issueDeleteMilestone). Reads are anonymous-capable;
 * writes require a token upstream (`reqToken` + `reqRepoWriter(TypeIssues,
 * TypePullRequests)` — SPEC-0002 `write:issue`). The path id resolves by id
 * (strconv.ParseInt base 0) with a case-sensitive NAME fallback — including
 * on PATCH and DELETE. Mutations wrap the landed IssuesService.
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

const idParams = {
  params: z.object({
    ...ownerRepoParams,
    id: z
      .string()
      .min(1)
      .openapi({ description: "the milestone, identified by ID and if not available by name" }),
  }),
} as const;

const collectionParams = { params: z.object(ownerRepoParams) } as const;

const listQuery = {
  query: z.object({
    state: z
      .string()
      .optional()
      .openapi({
        description: 'Milestone state, Recognized values are open, closed and all. Defaults to "open"',
      }),
    name: z.string().optional().openapi({ description: "filter by milestone name" }),
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const listMilestonesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/milestones",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get all of a repository's opened milestones",
    operationId: "issueGetMilestonesList",
    request: { ...collectionParams, ...listQuery },
    responses: {
      200: {
        description: "MilestoneList",
        content: { "application/json": { schema: milestoneListSchema } },
      },
      404: notFoundResponse,
    },
  });

const createMilestoneRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/milestones",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Create a milestone",
    operationId: "issueCreateMilestone",
    request: {
      ...collectionParams,
      body: { content: { "application/json": { schema: createMilestoneOptionSchema } } },
    },
    responses: {
      201: {
        description: "Milestone",
        content: { "application/json": { schema: milestoneSchema } },
      },
      404: notFoundResponse,
    },
  });

const getMilestoneRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/milestones/{id}",
    middleware: [optionalAuth],
    tags: ["issue"],
    summary: "Get a milestone",
    operationId: "issueGetMilestone",
    request: idParams,
    responses: {
      200: {
        description: "Milestone",
        content: { "application/json": { schema: milestoneSchema } },
      },
      404: notFoundResponse,
    },
  });

const editMilestoneRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/milestones/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Update a milestone",
    operationId: "issueEditMilestone",
    request: {
      ...idParams,
      body: { content: { "application/json": { schema: editMilestoneOptionSchema } } },
    },
    responses: {
      200: {
        description: "Milestone",
        content: { "application/json": { schema: milestoneSchema } },
      },
      404: notFoundResponse,
    },
  });

const deleteMilestoneRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/milestones/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Delete a milestone",
    operationId: "issueDeleteMilestone",
    request: idParams,
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

/**
 * `ParseIssueFilterStateIsClosed` — unknown state values mean open
 * (upstream: "unknown state, undefined behavior").
 */
function milestoneStateFilter(raw: string): "open" | "closed" | "all" {
  if (raw === "all") {
    return "all";
  }
  return raw === "closed" ? "closed" : "open";
}

/**
 * The `due_on` tri-state of Go's `optional.Option[*string]`: absent = keep,
 * null = remove, "" = remove, a string = parse (400 on a bad format — the
 * upstream runtime 400 that the vendored contract does not declare).
 */
function resolveDeadlineInput(raw: string | null | undefined): { keep: boolean; deadline?: Date | null } {
  if (raw === undefined) {
    return { keep: true };
  }
  if (raw === null || raw === "") {
    return { keep: false, deadline: null };
  }
  return { keep: false, deadline: parseMilestoneDeadline(raw) };
}

/** Tri-state pointer rule for the plain `*string`/`*enum` fields. */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function registerMilestoneRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listMilestonesRoute(optionalAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    const { items, total } = await listRepoMilestones(c.env.DB, found.repo.id, {
      state: milestoneStateFilter(url.searchParams.get("state") ?? ""),
      name: (url.searchParams.get("name") ?? "").trim(),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map(toApiMilestone), 200);
  });

  app.openapi(createMilestoneRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const body = c.req.valid("json");
    const service = new IssuesService(c.env.DB);
    const row = await createRepoMilestone(service, found.repo.id, {
      title: body.title ?? "",
      description: body.description ?? "",
      deadlineAt: resolveDeadlineInput(body.due_on).deadline ?? null,
      state: body.state === "closed" ? "closed" : "open",
      now: new Date(),
    });
    return c.json(toApiMilestone(row), 201);
  });

  app.openapi(getMilestoneRoute(optionalAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const row = await findRepoMilestoneByIdOrName(new IssuesService(c.env.DB), c.env.DB, found.repo.id, id);
    if (row === null) {
      throw new ApiError(404, "not found");
    }
    return c.json(toApiMilestone(row), 200);
  });

  app.openapi(editMilestoneRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const service = new IssuesService(c.env.DB);
    const row = await findRepoMilestoneByIdOrName(service, c.env.DB, found.repo.id, id);
    if (row === null) {
      throw new ApiError(404, "not found");
    }
    const body = c.req.valid("json");
    const deadline = resolveDeadlineInput(body.due_on);
    const updated = await editRepoMilestone(service, row.id, {
      title: patchField(body.title),
      description: patchField(body.description),
      ...(deadline.keep ? {} : { deadlineAt: deadline.deadline }),
      state: patchField(body.state),
      now: new Date(),
    });
    return c.json(toApiMilestone(updated), 200);
  });

  app.openapi(deleteMilestoneRoute(requireAuth), async (c) => {
    const { found } = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    const service = new IssuesService(c.env.DB);
    const row = await findRepoMilestoneByIdOrName(service, c.env.DB, found.repo.id, id);
    if (row === null) {
      // Unlike labels, the milestone DELETE resolves first — missing → the
      // plain 404 (routers/api/v1/repo/milestone.go getMilestoneByIDOrName).
      throw new ApiError(404, "not found");
    }
    await deleteRepoMilestone(service, row.id);
    return c.body(null, 204);
  });
}
