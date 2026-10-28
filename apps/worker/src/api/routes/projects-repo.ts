import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  addIssueToColumn,
  assertColumnsReorderedExactly,
  cardTypeFromString,
  changeProjectStatus,
  createColumn,
  createProject,
  createWorkflow,
  deleteColumnById,
  deleteProjectById,
  deleteWorkflow,
  findColumnByIdAndProject,
  findIssueByIdInRepo,
  findProjectById,
  findWorkflowByIdAndProject,
  listColumnIssues,
  listColumns,
  listProjects,
  listWorkflows,
  moveColumns,
  moveIssueToColumn,
  parseProjectStateFilter,
  projectColumnNotExistError,
  projectNotExistError,
  projectIssueNotExistError,
  projectWorkflowNotExistError,
  removeIssueFromColumn,
  repoProjectScope,
  setDefaultColumn,
  toApiProject,
  toApiProjectColumn,
  toApiProjectColumnList,
  toApiProjectList,
  toApiProjectWorkflow,
  updateColumn,
  updateProject,
  updateWorkflow,
  type ProjectScope,
} from "../services/projects";
import {
  assertNotArchived,
  canWriteRepository,
  requireVisibleRepo,
} from "../services/repo-access";
import { viewerOf } from "../services/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  createProjectColumnOptionSchema,
  createProjectOptionSchema,
  createProjectWorkflowOptionSchema,
  editProjectColumnOptionSchema,
  editProjectOptionSchema,
  editProjectWorkflowOptionSchema,
  moveProjectColumnsOptionSchema,
  moveProjectIssueOptionSchema,
  projectColumnListSchema,
  projectListSchema,
  projectWorkflowListSchema,
  projectWorkflowSchema,
  projectColumnSchema,
  projectSchema,
} from "../models/project";
import { issueSchema } from "../models/issue";
import { prefetchIssueRenderContext, toApiIssue } from "../services/issues";

/**
 * Tier-1 repo-scoped project-board routes (inventory batch 6 stage 1 — the
 * 21 `repo*Project*` operations over `/repos/{owner}/{repo}/projects…`,
 * frozen contract paths 15859-16979). Reads are anonymous-capable; the
 * writes carry the whole upstream write stack (api.go:1689-1691):
 *
 *  upstream                                   ours
 *  -----------------------------------------  --------------------------------
 *  repoAssignment() (invisible repo → 404)    requireVisibleRepo (404) — as
 *                                             route middleware on the body
 *                                             routes, handler elsewhere
 *  reqRepoReader(unit.TypeProjects)           visibility ⇒ read in our matrix
 *    (visible-repo-no-read → 403)             (arm unreachable; see below)
 *  mustEnableRepoProjects (404)               no-op — we have no per-repo
 *                                             Projects-unit toggle; the unit
 *                                             cannot be disabled (divergence)
 *  reqToken()                                 requireAuth middleware (401)
 *  reqRepoWriter(unit.TypeProjects)           canWriteRepository → 403 "user
 *                                             should have a permission to
 *                                             write to a repo" — route
 *                                             middleware on body routes so it
 *                                             precedes the zod-openapi bind
 *  mustNotBeArchived                          assertNotArchived → 423 "repo
 *                                             is archived" (same middleware)
 *
 * The upstream 403 arm of reqRepoReader (a repo visible to the doer whose
 * Projects unit they cannot read) cannot arise in our reduced matrix —
 * visibility grants read everywhere (services/repo-access.ts header) — so
 * the anti-enumeration 404 is the only read gate.
 *
 * Workflow mutations additionally enforce upstream's CanManageWorkflows
 * (services/projects/workflow.go:27-48 — write access to BOTH the issues
 * and pulls units, since workflows act on items without further checks).
 * Our per-unit matrix collapses to the repo-wide writer, so the same
 * canWriteRepository predicate answers it, with upstream's exact 403
 * message "not allowed to manage the workflows of this project".
 *
 * `project is closed` (findOpenProject, shared/project.go:149-169) — every
 * mutating endpoint rejects CLOSED projects with 403 (edit/delete of the
 * project itself stay open, so a closed board can be reopened/removed).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedErrorResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const projectIdParams = {
  params: z.object({
    ...ownerRepoParams,
    id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the project" }),
  }),
} as const;

const columnIdParams = {
  params: projectIdParams.params.extend({
    column_id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the column" }),
  }),
} as const;

/** Shared `issue_id` path-param metadata (contract: "global id of the issue,
 *  not the repository-local index"). */
const issueIdParam = {
  issue_id: z.string().min(1).openapi({
    type: "integer",
    format: "int64",
    description: "global id of the issue, not the repository-local index",
  }),
} as const;

const columnIssueParams = {
  params: columnIdParams.params.extend(issueIdParam),
} as const;

/**
 * The issue-move route's params: `…/projects/{id}/issues/{issue_id}/move` —
 * owner/repo/id/issue_id with NO `column_id` (the frozen contract's
 * repoMoveProjectIssue parameter list; the target column arrives in the body).
 */
const projectIssueParams = {
  params: projectIdParams.params.extend(issueIdParam),
} as const;

const workflowIdParams = {
  params: projectIdParams.params.extend({
    workflow_id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the workflow" }),
  }),
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const projectsListQuery = {
  query: listQuery.query.extend({
    state: z
      .enum(["open", "closed", "all"])
      .optional()
      .openapi({ description: "State of the project (open, closed, all)", default: "open" }),
  }),
} as const;

/**
 * The upstream pre-bind write stack as route middleware. Upstream mounts the
 * project group under repoAssignment() (404) with the per-route reqRepoWriter
 * (403) + mustNotBeArchived (423) checks AHEAD of web's bind — api.go:783:
 * `m.Post("", bind(api.CreateProjectOption{}), shared.CreateProject)` inside
 * the writeChecks-prepended group (api.go:1689-1691). Hono's zod-openapi
 * registers the body validator AFTER route middleware, so carrying the stack
 * here keeps the exact upstream order 404 → 403 → 423 → bind-422 (an unknown
 * repo addressed with a title-less body must 404, not 422). Handlers re-run
 * the same checks afterwards — route middleware cannot hand them the resolved
 * repo without widening ApiEnv — which is pure redundancy (one extra indexed
 * read on the write paths), not a second gate to maintain.
 */
const repoProjectWriteGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // A shared middleware sees hono's untyped param bag; every route this gate
  // is mounted on matches `/repos/{owner}/{repo}/…`, which guarantees both
  // keys (the handlers get the typed record via c.req.valid("param")).
  const found = await requireVisibleRepo(c, c.req.param() as { owner: string; repo: string });
  await requireRepoProjectWriter(c, found);
  await next();
};

// ---------------------------------------------------------------------------
// Route declarations (operationIds verbatim from the frozen contract)
// ---------------------------------------------------------------------------

const listProjectsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repository's projects",
    operationId: "repoListProjects",
    request: { params: z.object(ownerRepoParams), ...projectsListQuery },
    responses: {
      200: {
        description: "ProjectList",
        content: { "application/json": { schema: projectListSchema } },
      },
      404: notFoundResponse,
    },
  });

const createProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Create a project owned by a repository",
    operationId: "repoCreateProject",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createProjectOptionSchema } } },
    },
    responses: {
      201: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const getProjectRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a project",
    operationId: "repoGetProject",
    request: projectIdParams,
    responses: {
      200: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
    },
  });

const editProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/projects/{id}",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Edit a project",
    operationId: "repoEditProject",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: editProjectOptionSchema } } },
    },
    responses: {
      200: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const deleteProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/projects/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a project",
    operationId: "repoDeleteProject",
    request: projectIdParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      423: repoArchivedErrorResponse,
    },
  });

const listColumnsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}/columns",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a project's columns",
    operationId: "repoListProjectColumns",
    request: { ...projectIdParams, ...listQuery },
    responses: {
      200: {
        description: "ProjectColumnList",
        content: { "application/json": { schema: projectColumnListSchema } },
      },
      404: notFoundResponse,
    },
  });

const createColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/columns",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Create a column in a project",
    operationId: "repoCreateProjectColumn",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: createProjectColumnOptionSchema } } },
    },
    responses: {
      201: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const getColumnRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a project column",
    operationId: "repoGetProjectColumn",
    request: columnIdParams,
    responses: {
      200: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      404: notFoundResponse,
    },
  });

const editColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Edit a project column",
    operationId: "repoEditProjectColumn",
    request: {
      ...columnIdParams,
      body: { content: { "application/json": { schema: editProjectColumnOptionSchema } } },
    },
    responses: {
      200: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const deleteColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a project column",
    description: "The default column cannot be deleted while it is still the column new issues land in.",
    operationId: "repoDeleteProjectColumn",
    request: columnIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const setDefaultColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/default",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Set a project's default column",
    description: "The default column is where newly assigned issues land.",
    operationId: "repoSetDefaultProjectColumn",
    request: columnIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedErrorResponse,
    },
  });

const moveColumnsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/move",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Reorder a project's columns",
    description: "Reorders every column of the project at once. The body lists all column IDs in their new order.",
    operationId: "repoMoveProjectColumns",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: moveProjectColumnsOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const listColumnIssuesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List the issues in a project column",
    operationId: "repoListProjectColumnIssues",
    request: { ...columnIdParams, ...listQuery },
    responses: {
      200: {
        description: "IssueList",
        content: { "application/json": { schema: z.array(issueSchema) } },
      },
      404: notFoundResponse,
    },
  });

const addIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Add an issue to a project column",
    description: "Assigns the issue to the project if it is not a member yet, then places it in the column.",
    operationId: "repoAddIssueToProjectColumn",
    request: columnIssueParams,
    responses: {
      201: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const removeIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Remove an issue from a project column",
    operationId: "repoRemoveIssueFromProjectColumn",
    request: columnIssueParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedErrorResponse,
    },
  });

const moveIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/issues/{issue_id}/move",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Move an issue between a project's columns",
    operationId: "repoMoveProjectIssue",
    request: {
      params: projectIssueParams.params,
      body: { content: { "application/json": { schema: moveProjectIssueOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const listWorkflowsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}/workflows",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a project's workflows",
    operationId: "repoListProjectWorkflows",
    request: { ...projectIdParams, ...listQuery },
    responses: {
      200: {
        description: "ProjectWorkflowList",
        content: { "application/json": { schema: projectWorkflowListSchema } },
      },
      404: notFoundResponse,
    },
  });

const getWorkflowRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a project workflow",
    operationId: "repoGetProjectWorkflow",
    request: workflowIdParams,
    responses: {
      200: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      404: notFoundResponse,
    },
  });

const createWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/projects/{id}/workflows",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Create a project workflow",
    operationId: "repoCreateProjectWorkflow",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: createProjectWorkflowOptionSchema } } },
    },
    responses: {
      201: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const editWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth, repoProjectWriteGate],
    tags: ["repository"],
    summary: "Edit a project workflow",
    operationId: "repoEditProjectWorkflow",
    request: {
      ...workflowIdParams,
      body: { content: { "application/json": { schema: editProjectWorkflowOptionSchema } } },
    },
    responses: {
      200: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedErrorResponse,
    },
  });

const deleteWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a project workflow",
    operationId: "repoDeleteProjectWorkflow",
    request: workflowIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      423: repoArchivedErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

/** `ctx.PathParamInt64` — strict decimal or 0 (garbage ids never match). */
function pathParamInt64(raw: string): number {
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/**
 * The upstream write stack after the repo resolution: reqRepoWriter →
 * mustNotBeArchived (api.go:1690 ordering). 403 precedes 423.
 */
async function requireRepoProjectWriter(c: Context<ApiEnv>, found: Awaited<ReturnType<typeof requireVisibleRepo>>) {
  if (!(await canWriteRepository(c, found))) {
    throw new ApiError(403, "user should have a permission to write to a repo");
  }
  assertNotArchived(found);
}

/** The authenticated doer id (requireAuth middleware guarantees presence). */
function actorIdOf(c: Context<ApiEnv>): number {
  const requester = viewerOf(c).requester;
  if (requester === null || requester.id === undefined) {
    // Unreachable behind requireAuth — kept as the middleware contract's
    // explicit precondition.
    throw new ApiError(401, "token is required");
  }
  return requester.id;
}

/** Tri-state pointer rule: absent and JSON-null both mean "unchanged". */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** Body bind hook: upstream's Go bind answers malformed bodies with the
 *  declared 422 (the route-family generic text). */
const projectBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** `projectScope.findProject` — the 404 carries upstream's message. */
async function findProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
  const project = await findProjectById(c.env.DB, scope, pathParamInt64(rawId));
  if (project === null) {
    throw projectNotExistError(pathParamInt64(rawId));
  }
  return project;
}

/** `columnIn` — the column must belong to the resolved project. */
async function findColumnOr404(c: Context<ApiEnv>, projectId: number, rawColumnId: string) {
  const columnId = pathParamInt64(rawColumnId);
  const column = await findColumnByIdAndProject(c.env.DB, columnId, projectId);
  if (column === null) {
    throw projectColumnNotExistError(columnId);
  }
  return column;
}

/** `scope.findIssue` (repo arm) — global id, repo-scoped, 404 on miss. */
async function findIssueOr404(c: Context<ApiEnv>, repoId: string, rawIssueId: string) {
  const issueId = pathParamInt64(rawIssueId);
  const issue = await findIssueByIdInRepo(c.env.DB, repoId, issueId);
  if (issue === null) {
    throw projectIssueNotExistError(issueId, repoId);
  }
  return issue;
}

/** `project.Link` for the repo scope — `{origin}/{owner}/{repo}/projects/{id}`
 *  (ProjectLinkForRepo + MakeAbsoluteURL). */
function projectHtmlUrl(found: { repo: { ownerNamespace: string; slug: string } }, origin: string, id: number): string {
  return `${origin}/${encodeURIComponent(found.repo.ownerNamespace)}/${encodeURIComponent(found.repo.slug)}/projects/${id}`;
}

/**
 * `scope.findOpenProject` — the mutating endpoints' gate: a closed project
 * is read-only (403 "project is closed", shared/project.go:149-169).
 */
async function findOpenProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
  const project = await findProjectOr404(c, scope, rawId);
  if (project.isClosed) {
    throw new ApiError(403, "project is closed");
  }
  return project;
}

/** `checkCanManageWorkflows` (repo arm) — see the module header. */
async function requireWorkflowManager(c: Context<ApiEnv>, found: Awaited<ReturnType<typeof requireVisibleRepo>>) {
  if (!(await canWriteRepository(c, found))) {
    throw new ApiError(403, "not allowed to manage the workflows of this project");
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectsRepoRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -- projects ------------------------------------------------------------

  app.openapi(listProjectsRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const isClosed = parseProjectStateFilter(url.searchParams.get("state"));
    const scope = repoProjectScope(found.repo.id);
    const { items, total } = await listProjects(c.env.DB, scope, isClosed, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(
      await toApiProjectList(c.env.DB, items, viewer, (row) => projectHtmlUrl(found, viewer.origin, row.id)),
      200,
    );
  });

  app.openapi(
    createProjectRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const actorId = actorIdOf(c);
      const viewer = viewerOf(c);
      const body = c.req.valid("json");
      const row = await createProject(c.env.DB, repoProjectScope(found.repo.id), {
        title: body.title,
        description: body.description,
        template_type: body.template_type,
        card_type: body.card_type,
        creatorId: actorId,
        now: new Date(),
      });
      return c.json(await toApiProject(c.env.DB, row, viewer, projectHtmlUrl(found, viewer.origin, row.id)), 201);
    },
    projectBodyHook,
  );

  app.openapi(getProjectRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const row = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    return c.json(await toApiProject(c.env.DB, row, viewer, projectHtmlUrl(found, viewer.origin, row.id)), 200);
  });

  app.openapi(
    editProjectRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const viewer = viewerOf(c);
      const scope = repoProjectScope(found.repo.id);
      const row = await findProjectOr404(c, scope, c.req.valid("param").id);
      // All body validation precedes any write (upstream assembles opts
      // first, then calls UpdateProject once).
      const body = c.req.valid("json");
      const cardTypeRaw = patchField(body.card_type);
      const cardType = cardTypeRaw === undefined ? undefined : cardTypeFromString(cardTypeRaw);
      const state = patchField(body.state);
      if (state !== undefined && state !== "open" && state !== "closed") {
        // Unreachable through the schema enum — kept for the upstream parity
        // of the exact message (shared/project.go:626-635).
        throw new ApiError(422, "state must be 'open' or 'closed'");
      }
      let updated = await updateProject(c.env.DB, row, {
        title: patchField(body.title),
        description: patchField(body.description),
        cardType,
        now: new Date(),
      });
      if (state !== undefined) {
        updated = await changeProjectStatus(c.env.DB, updated, state === "closed", new Date());
      }
      return c.json(await toApiProject(c.env.DB, updated, viewer, projectHtmlUrl(found, viewer.origin, updated.id)), 200);
    },
    projectBodyHook,
  );

  app.openapi(deleteProjectRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const row = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    await deleteProjectById(c.env.DB, row.id);
    return c.body(null, 204);
  });

  // -- columns ---------------------------------------------------------------

  app.openapi(listColumnsRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const project = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listColumns(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(await toApiProjectColumnList(c.env.DB, items, viewer), 200);
  });

  app.openapi(
    createColumnRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const actorId = actorIdOf(c);
      const viewer = viewerOf(c);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      const body = c.req.valid("json");
      const row = await createColumn(c.env.DB, project.id, {
        title: body.title,
        color: body.color,
        creatorId: actorId,
        now: new Date(),
      });
      return c.json(await toApiProjectColumn(c.env.DB, row, viewer), 201);
    },
    projectBodyHook,
  );

  app.openapi(getColumnRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const project = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    return c.json(await toApiProjectColumn(c.env.DB, row, viewer), 200);
  });

  app.openapi(
    editColumnRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const viewer = viewerOf(c);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
      const body = c.req.valid("json");
      const sorting = patchField(body.sorting);
      if (sorting !== undefined && (sorting < -128 || sorting > 127)) {
        throw new ApiError(422, "sorting must be between -128 and 127");
      }
      const updated = await updateColumn(c.env.DB, row, {
        title: patchField(body.title),
        color: patchField(body.color),
        sorting,
        now: new Date(),
      });
      return c.json(await toApiProjectColumn(c.env.DB, updated, viewer), 200);
    },
    projectBodyHook,
  );

  app.openapi(deleteColumnRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await deleteColumnById(c.env.DB, row, new Date());
    return c.body(null, 204);
  });

  app.openapi(setDefaultColumnRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await setDefaultColumn(c.env.DB, project.id, row.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveColumnsRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      const body = c.req.valid("json");
      // Upstream reads ALL columns (ListOptionsAll); the 127-column cap
      // (column.go:141) makes one page-1/limit-127 read exact.
      const { items } = await listColumns(c.env.DB, project.id, 1, 127);
      assertColumnsReorderedExactly(body.column_ids, items);
      await moveColumns(c.env.DB, body.column_ids);
      return c.body(null, 204);
    },
    projectBodyHook,
  );

  // -- column issues ---------------------------------------------------------

  app.openapi(listColumnIssuesRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const viewer = viewerOf(c);
    const project = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listColumnIssues(c.env.DB, found.repo.id, project.id, column, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    // The M-grade list batching's tier-2 adoption: the per-issue enrichment
    // selects (poster, labels, pin order, milestone, PR row) batch into one
    // inArray read per entity kind for the page, handed to the render through
    // the preload — the response shape is unchanged (routes/issues.ts A2).
    const renderContext = await prefetchIssueRenderContext(c.env.DB, items);
    const rendered = await Promise.all(items.map((issue) => toApiIssue(c.env.DB, viewer, found, issue, { context: renderContext })));
    return c.json(rendered, 200);
  });
  app.openapi(addIssueRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const actorId = actorIdOf(c);
    const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const issue = await findIssueOr404(c, found.repo.id, c.req.valid("param").issue_id);
    await addIssueToColumn(c.env.DB, project, issue, column, actorId, new Date());
    return c.body(null, 201);
  });

  app.openapi(removeIssueRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const actorId = actorIdOf(c);
    const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const issue = await findIssueOr404(c, found.repo.id, c.req.valid("param").issue_id);
    await removeIssueFromColumn(c.env.DB, project, issue, column, actorId, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveIssueRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const actorId = actorIdOf(c);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      // The TARGET column resolves first — a foreign column id is the 422,
      // not the generic 404 (shared/project.go:2089-2098).
      const body = c.req.valid("json");
      const target = await findColumnByIdAndProject(c.env.DB, body.column_id, project.id);
      if (target === null) {
        throw new ApiError(422, "target column does not belong to this project");
      }
      const issue = await findIssueOr404(c, found.repo.id, c.req.valid("param").issue_id);
      await moveIssueToColumn(c.env.DB, project, issue, target, patchField(body.sorting) ?? null, actorId, new Date());
      return c.body(null, 204);
    },
    projectBodyHook,
  );

  // -- workflows ---------------------------------------------------------------

  app.openapi(listWorkflowsRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const project = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listWorkflows(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(items.map((row) => toApiProjectWorkflow(row)), 200);
  });

  app.openapi(getWorkflowRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const project = await findProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
    const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
    if (row === null) {
      throw projectWorkflowNotExistError(workflowId);
    }
    return c.json(toApiProjectWorkflow(row), 200);
  });

  app.openapi(
    createWorkflowRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      // CanManageWorkflows runs BEFORE event validation (the service's first
      // line, services/projects/workflow.go:61-64).
      await requireWorkflowManager(c, found);
      const body = c.req.valid("json");
      const row = await createWorkflow(c.env.DB, repoProjectScope(found.repo.id), found.repo.ownerId, project, {
        event: body.event,
        enabled: body.enabled,
        filters: body.filters,
        actions: body.actions,
        now: new Date(),
      });
      return c.json(toApiProjectWorkflow(row), 201);
    },
    projectBodyHook,
  );

  app.openapi(
    editWorkflowRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoProjectWriter(c, found);
      const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
      const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
      const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
      if (row === null) {
        throw projectWorkflowNotExistError(workflowId);
      }
      await requireWorkflowManager(c, found);
      const body = c.req.valid("json");
      const updated = await updateWorkflow(c.env.DB, repoProjectScope(found.repo.id), found.repo.ownerId, project, row, {
        enabled: patchField(body.enabled),
        filters: patchField(body.filters),
        actions: patchField(body.actions),
        now: new Date(),
      });
      return c.json(toApiProjectWorkflow(updated), 200);
    },
    projectBodyHook,
  );

  app.openapi(deleteWorkflowRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoProjectWriter(c, found);
    const project = await findOpenProjectOr404(c, repoProjectScope(found.repo.id), c.req.valid("param").id);
    const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
    const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
    if (row === null) {
      throw projectWorkflowNotExistError(workflowId);
    }
    await requireWorkflowManager(c, found);
    await deleteWorkflow(c.env.DB, project.id, row.id);
    return c.body(null, 204);
  });
}
