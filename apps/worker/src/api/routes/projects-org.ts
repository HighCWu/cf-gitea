import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import type { IssueRow } from "../../issues/service";
import {
  addIssueToColumn,
  assertColumnsReorderedExactly,
  cardTypeFromString,
  changeProjectStatus,
  canManageOrgProjectWorkflows,
  createColumn,
  createProject,
  createWorkflow,
  deleteColumnById,
  deleteProjectById,
  deleteWorkflow,
  findColumnByIdAndProject,
  findIssueByIdGlobally,
  findProjectById,
  findWorkflowByIdAndProject,
  listColumnIssuesForOrg,
  listColumns,
  listProjects,
  listWorkflows,
  moveColumns,
  moveIssueToColumn,
  orgAccessAtLeast,
  orgProjectScope,
  orgProjectsAccessMode,
  orgVisibleRepos,
  parseProjectStateFilter,
  projectColumnNotExistError,
  projectIssueCountsForOrg,
  projectIssueNotExistError,
  projectNotExistError,
  projectWorkflowNotExistError,
  removeIssueFromColumn,
  setDefaultColumn,
  toApiOrgProject,
  toApiProjectColumn,
  toApiProjectColumnList,
  toApiProjectWorkflow,
  updateColumn,
  updateProject,
  updateWorkflow,
  type OrgAccessMode,
  type ProjectRow,
  type ProjectScope,
} from "../services/projects";
import { resolveOrgForRequest, type OrgProfileDoer } from "../services/orgs";
import type { OrgRecord } from "../../services/orgs/orgs";
import { orgDoerOf } from "../services/org-repos";
import {
  canViewRepositoryWithTeams,
  findRepositoryById,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";
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
  type Project,
} from "../models/project";
import { issueSchema } from "../models/issue";
import { toApiIssue } from "../services/issues";

/**
 * Tier-1 org-scoped project-board routes (inventory batch 6 stage 2 — the
 * 21 `org*Project*` operations over `/orgs/{org}/projects…`, frozen contract
 * paths, tags "organization"). The wire logic is the repo scope's
 * (routes/projects-repo.ts — the handlers are shared upstream); only the
 * OWNER resolution and the gates differ. Upstream mounts the org group at
 * api.go:1755-1757:
 *
 *   m.Group("/projects", func() {
 *     addProjectRoutes(m, reqToken(), reqProjectsUnitAccess(perm.AccessModeWrite))
 *   }, reqProjectsUnitAccess(perm.AccessModeRead), tokenRequiresScopes(Issue))
 *
 *  upstream                                      ours
 *  --------------------------------------------  --------------------------------
 *  orgAssignment(true) (miss → 404, rename →     resolveOrgOr404 (resolveOrgFor-
 *    307 RedirectToUser)                         Request — the org-teams seam)
 *  reqProjectsUnitAccess(Read) — group,          requireOrgProjectsAccess "read"
 *    AnyRepoUnitPermission < Read → 404            in every handler
 *  tokenRequiresScopes(AccessTokenScope-         no-op — our tokens carry no
 *    CategoryIssue)                               scope (SPEC-0002 scope gates
 *                                                   pending); upstream itself
 *                                                   passes when no OAuth2 token
 *                                                   scope exists (api.go:278-282)
 *  reqToken()                                    requireAuth middleware (401)
 *  reqProjectsUnitAccess(Write) — per route,     orgProjectWriteGate route
 *    AnyRepoUnitPermission < Write → 404           middleware (404) on the body
 *                                                  routes so it precedes the
 *                                                  zod-openapi bind
 *
 * `reqProjectsUnitAccess` answers BOTH arms with `APIErrorNotFound` — "org
 * visibility is too permissive for reads, org ownership too strict for
 * writes" (api.go:754-756) — so the org scope's gate failure is the
 * anti-enumeration 404 everywhere; the 403s the contract declares on the
 * column/issue/workflow ops come from the SHARED handlers' own checks
 * ("project is closed", CanManageWorkflows), not from the gate.
 *
 * KNOWN DIVERGENCE (stage-1 shape kept): requireAuth precedes the write
 * gate, so an ANONYMOUS write at an invisible org answers 401 where
 * upstream's read gate would 404 first; reads keep the exact order
 * (optionalAuth passes anonymous through to the read gate).
 *
 * The predicate is `Organization.AnyRepoUnitPermission` for the Projects
 * unit (services/projects.ts orgProjectsAccessMode — org-owner bridge, the
 * team maximum with NO repo-coverage filter, then the coarse org-visibility
 * fallback; team-less members of private orgs read "none", upstream's own
 * blind spot).
 *
 * Issue arms (add/remove/move): `projectScope.findIssue`'s owner branch
 * (shared/project.go:114-147) looks the issue up GLOBALLY (any repository),
 * hides unreadable repos behind the plain 404, and — because the repo route
 * group's mustNotBeArchived does not cover owner boards — checks the issue's
 * repo archived state PER ISSUE (project.go:141-143): 423 "repo is
 * archived". Column-issue LISTING filters the org's own repositories to the
 * doer's visible set (issues added from outside the org stay assigned but
 * never list — upstream `issuesOpts.Owner`), and every Project render
 * carries the same filtered counts (LoadIssueNumbersForProject's owner
 * branch) — unlike the repo scope's plain counts.
 *
 * Workflow mutations enforce `CanManageWorkflows`'s organization arm
 * (services/projects/workflow.go:33-39): site admin or the org OWNER —
 * a Projects-unit writer who is not an owner passes the write gate but
 * still fails this check with the exact 403 "not allowed to manage the
 * workflows of this project". Order follows the service: open project →
 * workflow existence → manage check → validation.
 *
 * `project is closed` (findOpenProject, shared/project.go:150-160) — every
 * mutating endpoint except project edit/delete rejects CLOSED projects with
 * 403 (a closed board can still be reopened/removed — exactly the arms the
 * contract omits 403 on for orgEditProject/orgDeleteProject).
 *
 * html_url is ProjectLinkForOrg made absolute (models/project/project.go:
 * 132-134): `{origin}/{org}/-/projects/{id}` — note the `/-/projects/`
 * owner-arm shape.
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

const orgParam = {
  org: z.string().min(1).openapi({ description: "name of the organization" }),
} as const;

const orgParams = {
  params: z.object(orgParam),
} as const;

const projectIdParams = {
  params: z.object({
    ...orgParam,
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
 * org/id/issue_id with NO `column_id` (the frozen contract's
 * orgMoveProjectIssue parameter list; the target column arrives in the body).
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
 * The upstream write stack as route middleware: the group's read gate folds
 * into the write check (rank-ordered, ≥write ⇒ ≥read), so one resolution
 * carries orgAssignment → reqProjectsUnitAccess(Write) in upstream's order —
 * 404 → 404 → bind-422 (an unknown org addressed with a title-less body must
 * 404, not 422). Hono's zod-openapi registers the body validator AFTER route
 * middleware. Handlers re-resolve the org afterwards (the stage-1
 * redundancy pattern — one extra indexed read, not a second gate).
 */
const orgProjectWriteGate: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // A shared middleware sees hono's untyped param bag; every route this gate
  // is mounted on matches `/orgs/{org}/…`, which guarantees the key (the
  // handlers get the typed record via c.req.valid("param")).
  const org = await resolveOrgOr404(c, c.req.param("org") ?? "");
  await requireOrgProjectsAccess(c, org, "write");
  await next();
};

// ---------------------------------------------------------------------------
// Route declarations (operationIds verbatim from the frozen contract)
// ---------------------------------------------------------------------------

const listProjectsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/projects",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List an organization's projects",
    operationId: "orgListProjects",
    request: { params: orgParams.params, ...projectsListQuery },
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
    path: "/orgs/{org}/projects",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Create a project owned by an organization",
    operationId: "orgCreateProject",
    request: {
      params: orgParams.params,
      body: { content: { "application/json": { schema: createProjectOptionSchema } } },
    },
    responses: {
      201: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getProjectRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/projects/{id}",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Get a project",
    operationId: "orgGetProject",
    request: projectIdParams,
    responses: {
      200: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
    },
  });

const editProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}/projects/{id}",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Edit a project",
    operationId: "orgEditProject",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: editProjectOptionSchema } } },
    },
    responses: {
      200: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const deleteProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/projects/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a project",
    operationId: "orgDeleteProject",
    request: projectIdParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const listColumnsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/projects/{id}/columns",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List a project's columns",
    operationId: "orgListProjectColumns",
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
    path: "/orgs/{org}/projects/{id}/columns",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Create a column in a project",
    operationId: "orgCreateProjectColumn",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: createProjectColumnOptionSchema } } },
    },
    responses: {
      201: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getColumnRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/projects/{id}/columns/{column_id}",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Get a project column",
    operationId: "orgGetProjectColumn",
    request: columnIdParams,
    responses: {
      200: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      404: notFoundResponse,
    },
  });

const editColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}/projects/{id}/columns/{column_id}",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Edit a project column",
    operationId: "orgEditProjectColumn",
    request: {
      ...columnIdParams,
      body: { content: { "application/json": { schema: editProjectColumnOptionSchema } } },
    },
    responses: {
      200: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const deleteColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/projects/{id}/columns/{column_id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a project column",
    description: "The default column cannot be deleted while it is still the column new issues land in.",
    operationId: "orgDeleteProjectColumn",
    request: columnIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const setDefaultColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/projects/{id}/columns/{column_id}/default",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Set a project's default column",
    description: "The default column is where newly assigned issues land.",
    operationId: "orgSetDefaultProjectColumn",
    request: columnIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const moveColumnsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/projects/{id}/columns/move",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Reorder a project's columns",
    description: "Reorders every column of the project at once. The body lists all column IDs in their new order.",
    operationId: "orgMoveProjectColumns",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: moveProjectColumnsOptionSchema } } },
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const listColumnIssuesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/projects/{id}/columns/{column_id}/issues",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List the issues in a project column",
    operationId: "orgListProjectColumnIssues",
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
    path: "/orgs/{org}/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Add an issue to a project column",
    description: "Assigns the issue to the project if it is not a member yet, then places it in the column.",
    operationId: "orgAddIssueToProjectColumn",
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
    path: "/orgs/{org}/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Remove an issue from a project column",
    operationId: "orgRemoveIssueFromProjectColumn",
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
    path: "/orgs/{org}/projects/{id}/issues/{issue_id}/move",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Move an issue between a project's columns",
    operationId: "orgMoveProjectIssue",
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
    path: "/orgs/{org}/projects/{id}/workflows",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List a project's workflows",
    operationId: "orgListProjectWorkflows",
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
    path: "/orgs/{org}/projects/{id}/workflows/{workflow_id}",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "Get a project workflow",
    operationId: "orgGetProjectWorkflow",
    request: workflowIdParams,
    responses: {
      200: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      404: notFoundResponse,
    },
  });

const createWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/projects/{id}/workflows",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Create a project workflow",
    operationId: "orgCreateProjectWorkflow",
    request: {
      ...projectIdParams,
      body: { content: { "application/json": { schema: createProjectWorkflowOptionSchema } } },
    },
    responses: {
      201: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const editWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth, orgProjectWriteGate],
    tags: ["organization"],
    summary: "Edit a project workflow",
    operationId: "orgEditProjectWorkflow",
    request: {
      ...workflowIdParams,
      body: { content: { "application/json": { schema: editProjectWorkflowOptionSchema } } },
    },
    responses: {
      200: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const deleteWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a project workflow",
    operationId: "orgDeleteProjectWorkflow",
    request: workflowIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

/** `ctx.PathParamInt64` — strict decimal or 0 (garbage ids never match). */
function pathParamInt64(raw: string): number {
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

function notFound(): ApiError {
  return new ApiError(404, "not found");
}

/** The renamed-org 307 (orgAssignment → RedirectToUser; the org-teams seam). */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/** The authenticated doer slice for the org guards (null = anonymous). */
function orgDoerOrNull(c: Context<ApiEnv>): OrgProfileDoer | null {
  const requester = viewerOf(c).requester;
  return requester === null ? null : orgDoerOf(requester);
}

/**
 * The authenticated doer with a definite id — the requireAuth middleware's
 * contract on every write route (a resolved principal always carries an id;
 * anything else is the 401 the middleware would already have answered).
 */
function requireOrgDoer(c: Context<ApiEnv>): { id: number; isAdmin: boolean } {
  const doer = orgDoerOrNull(c);
  if (doer === null || doer.id === null) {
    throw new ApiError(401, "token is required");
  }
  return { id: doer.id, isAdmin: doer.isAdmin };
}

/**
 * orgAssignment(true) — resolve the `/orgs/{org}` context: the org, the
 * rename 307, or the shared 404-shaped miss.
 */
async function resolveOrgOr404(c: Context<ApiEnv>, orgName: string): Promise<OrgRecord> {
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    orgName,
    orgDoerOrNull(c),
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") throw renamedOrgRedirect(resolved.location);
  if (resolved.kind === "missing") throw notFound();
  return resolved.org;
}

/**
 * `reqProjectsUnitAccess` (api.go:754-768): site admins bypass; otherwise
 * the doer's Projects-unit access over the org must reach `mode`, and ANY
 * shortfall is the anti-enumeration 404 (both arms — see the module header).
 */
async function requireOrgProjectsAccess(c: Context<ApiEnv>, org: OrgRecord, mode: "read" | "write"): Promise<void> {
  const viewer = viewerOf(c);
  if (viewer.requester?.is_admin === true) {
    return; // ctx.IsUserSiteAdmin()
  }
  const access: OrgAccessMode = await orgProjectsAccessMode(c.env.DB, org, viewer.requester?.id ?? null);
  if (!orgAccessAtLeast(access, mode)) {
    throw notFound();
  }
}

/**
 * `projectScope.findIssue`'s owner arm (shared/project.go:114-147): GLOBAL
 * issue lookup (404 carries `ErrIssueNotExist{id, 0, 0}`), the issue's repo
 * read permission hides as the plain 404, then the per-issue archived 423
 * (project.go:141-143 — owner boards have no group-level mustNotBeArchived).
 */
async function findOrgIssueOr404(
  c: Context<ApiEnv>,
  rawIssueId: string,
): Promise<{ issue: IssueRow; repo: RepositoryWithOwner }> {
  const issueId = pathParamInt64(rawIssueId);
  const issue = await findIssueByIdGlobally(c.env.DB, issueId);
  if (issue === null) {
    throw projectIssueNotExistError(issueId, "0");
  }
  const repo = await findRepositoryById(c.env.DB, issue.repoId);
  if (repo === null || !(await canViewRepositoryWithTeams(c.env.DB, viewerOf(c), repo.repo))) {
    // perm.CanReadIssuesOrPulls miss — hide the issue's existence.
    throw notFound();
  }
  if (repo.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
  return { issue, repo };
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

/** `projectScope.findProject` — the 404 carries upstream's message; the id
 *  is scoped to THIS org (another org's id reads as not found). */
async function findOrgProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
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

/**
 * `scope.findOpenProject` — the mutating endpoints' gate: a closed project
 * is read-only (403 "project is closed", shared/project.go:150-160).
 */
async function findOpenOrgProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
  const project = await findOrgProjectOr404(c, scope, rawId);
  if (project.isClosed) {
    throw new ApiError(403, "project is closed");
  }
  return project;
}

/** `checkCanManageWorkflows` (org arm) → PermissionDenied 403 — see header. */
async function requireOrgWorkflowManager(c: Context<ApiEnv>, org: OrgRecord): Promise<void> {
  if (!(await canManageOrgProjectWorkflows(c.env.DB, org, requireOrgDoer(c)))) {
    throw new ApiError(403, "not allowed to manage the workflows of this project");
  }
}

/** `ProjectLinkForOrg` + MakeAbsoluteURL — `{origin}/{org}/-/projects/{id}`. */
function orgProjectHtmlUrl(org: { username: string }, origin: string, id: number): string {
  return `${origin}/${encodeURIComponent(org.username)}/-/projects/${id}`;
}

/**
 * The org arm's Project render: the counts are filtered through the doer's
 * visible org repositories (LoadIssueNumbersForProject's owner branch) —
 * the repo scope's plain counts would leak private-repo items. The visible
 * set resolves once per request and feeds every row.
 */
async function renderOrgProjectRow(
  c: Context<ApiEnv>,
  org: OrgRecord,
  row: ProjectRow,
  visibleRepoIds: string[],
): Promise<Project> {
  const viewer = viewerOf(c);
  const counts = await projectIssueCountsForOrg(c.env.DB, row.id, visibleRepoIds);
  return toApiOrgProject(c.env.DB, row, viewer, orgProjectHtmlUrl(org, viewer.origin, row.id), counts);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectsOrgRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -- projects ------------------------------------------------------------

  app.openapi(listProjectsRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const isClosed = parseProjectStateFilter(url.searchParams.get("state"));
    const scope = orgProjectScope(org.id);
    const { items, total } = await listProjects(c.env.DB, scope, isClosed, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    const visibleRepoIds = (await orgVisibleRepos(c.env.DB, org.id, viewerOf(c))).map((pair) => pair.repo.id);
    const rendered = [];
    for (const row of items) {
      rendered.push(await renderOrgProjectRow(c, org, row, visibleRepoIds));
    }
    return c.json(rendered, 200);
  });

  app.openapi(
    createProjectRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const doer = requireOrgDoer(c);
      const viewer = viewerOf(c);
      const body = c.req.valid("json");
      const row = await createProject(c.env.DB, orgProjectScope(org.id), {
        title: body.title,
        description: body.description,
        template_type: body.template_type,
        card_type: body.card_type,
        creatorId: doer.id,
        now: new Date(),
      });
      // A fresh board has no items anywhere — the filtered counts are 0.
      const counts = { open: 0, closed: 0, total: 0 };
      return c.json(await toApiOrgProject(c.env.DB, row, viewer, orgProjectHtmlUrl(org, viewer.origin, row.id), counts), 201);
    },
    projectBodyHook,
  );

  app.openapi(getProjectRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const row = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const visibleRepoIds = (await orgVisibleRepos(c.env.DB, org.id, viewerOf(c))).map((pair) => pair.repo.id);
    return c.json(await renderOrgProjectRow(c, org, row, visibleRepoIds), 200);
  });

  app.openapi(
    editProjectRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const scope = orgProjectScope(org.id);
      const row = await findOrgProjectOr404(c, scope, c.req.valid("param").id);
      // All body validation precedes any write (upstream assembles opts
      // first, then calls UpdateProject once).
      const body = c.req.valid("json");
      const cardTypeRaw = patchField(body.card_type);
      const cardType = cardTypeRaw === undefined ? undefined : cardTypeFromString(cardTypeRaw);
      const state = patchField(body.state);
      if (state !== undefined && state !== "open" && state !== "closed") {
        // Unreachable through the schema enum — kept for the upstream parity
        // of the exact message (shared/project.go:620-634).
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
      const viewer = viewerOf(c);
      const visibleRepoIds = (await orgVisibleRepos(c.env.DB, org.id, viewer)).map((pair) => pair.repo.id);
      const counts = await projectIssueCountsForOrg(c.env.DB, updated.id, visibleRepoIds);
      return c.json(
        await toApiOrgProject(c.env.DB, updated, viewer, orgProjectHtmlUrl(org, viewer.origin, updated.id), counts),
        200,
      );
    },
    projectBodyHook,
  );

  app.openapi(deleteProjectRoute(requireAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const row = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    await deleteProjectById(c.env.DB, row.id);
    return c.body(null, 204);
  });

  // -- columns ---------------------------------------------------------------

  app.openapi(listColumnsRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const viewer = viewerOf(c);
    const project = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listColumns(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(await toApiProjectColumnList(c.env.DB, items, viewer), 200);
  });

  app.openapi(
    createColumnRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const doer = requireOrgDoer(c);
      const viewer = viewerOf(c);
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
      const body = c.req.valid("json");
      const row = await createColumn(c.env.DB, project.id, {
        title: body.title,
        color: body.color,
        creatorId: doer.id,
        now: new Date(),
      });
      return c.json(await toApiProjectColumn(c.env.DB, row, viewer), 201);
    },
    projectBodyHook,
  );

  app.openapi(getColumnRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const viewer = viewerOf(c);
    const project = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    return c.json(await toApiProjectColumn(c.env.DB, row, viewer), 200);
  });

  app.openapi(
    editColumnRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const viewer = viewerOf(c);
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
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
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await deleteColumnById(c.env.DB, row, new Date());
    return c.body(null, 204);
  });

  app.openapi(setDefaultColumnRoute(requireAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await setDefaultColumn(c.env.DB, project.id, row.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveColumnsRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
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
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const viewer = viewerOf(c);
    const project = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const visible = await orgVisibleRepos(c.env.DB, org.id, viewer);
    const { items, total } = await listColumnIssuesForOrg(
      c.env.DB,
      project.id,
      column,
      visible.map((pair) => pair.repo.id),
      page,
      limit,
    );
    setPaginationHeaders(c, total, { page, limit });
    const pairsById = new Map(visible.map((pair) => [pair.repo.id, pair]));
    const rendered = [];
    for (const issue of items) {
      const pair = pairsById.get(issue.repoId);
      if (pair === undefined) {
        continue; // both sides read the same visible set — defensive only
      }
      rendered.push(await toApiIssue(c.env.DB, viewer, pair, issue));
    }
    return c.json(rendered, 200);
  });

  app.openapi(addIssueRoute(requireAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const doer = requireOrgDoer(c);
    const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const { issue } = await findOrgIssueOr404(c, c.req.valid("param").issue_id);
    await addIssueToColumn(c.env.DB, project, issue, column, doer.id, new Date());
    return c.body(null, 201);
  });

  app.openapi(removeIssueRoute(requireAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const doer = requireOrgDoer(c);
    const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const { issue } = await findOrgIssueOr404(c, c.req.valid("param").issue_id);
    await removeIssueFromColumn(c.env.DB, project, issue, column, doer.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveIssueRoute(requireAuth),
    async (c) => {
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const doer = requireOrgDoer(c);
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
      // The TARGET column resolves first — a foreign column id is the 422,
      // not the generic 404 (shared/project.go:2089-2098).
      const body = c.req.valid("json");
      const target = await findColumnByIdAndProject(c.env.DB, body.column_id, project.id);
      if (target === null) {
        throw new ApiError(422, "target column does not belong to this project");
      }
      const { issue } = await findOrgIssueOr404(c, c.req.valid("param").issue_id);
      await moveIssueToColumn(c.env.DB, project, issue, target, patchField(body.sorting) ?? null, doer.id, new Date());
      return c.body(null, 204);
    },
    projectBodyHook,
  );

  // -- workflows ---------------------------------------------------------------

  app.openapi(listWorkflowsRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const project = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listWorkflows(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(items.map((row) => toApiProjectWorkflow(row)), 200);
  });

  app.openapi(getWorkflowRoute(optionalAuth), async (c) => {
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "read");
    const project = await findOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
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
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
      // CanManageWorkflows runs BEFORE event validation (the service's first
      // line, services/projects/workflow.go:61-64).
      await requireOrgWorkflowManager(c, org);
      const body = c.req.valid("json");
      const row = await createWorkflow(c.env.DB, orgProjectScope(org.id), null, project, {
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
      const org = await resolveOrgOr404(c, c.req.valid("param").org);
      await requireOrgProjectsAccess(c, org, "write");
      const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
      const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
      const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
      if (row === null) {
        throw projectWorkflowNotExistError(workflowId);
      }
      await requireOrgWorkflowManager(c, org);
      const body = c.req.valid("json");
      const updated = await updateWorkflow(c.env.DB, orgProjectScope(org.id), null, project, row, {
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
    const org = await resolveOrgOr404(c, c.req.valid("param").org);
    await requireOrgProjectsAccess(c, org, "write");
    const project = await findOpenOrgProjectOr404(c, orgProjectScope(org.id), c.req.valid("param").id);
    const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
    const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
    if (row === null) {
      throw projectWorkflowNotExistError(workflowId);
    }
    await requireOrgWorkflowManager(c, org);
    await deleteWorkflow(c.env.DB, project.id, row.id);
    return c.body(null, 204);
  });
}
