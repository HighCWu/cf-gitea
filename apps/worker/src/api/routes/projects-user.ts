import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import type { IssueRow } from "../../issues/service";
import { userRedirects, users } from "../../db/schema";
import {
  addIssueToColumn,
  assertColumnsReorderedExactly,
  cardTypeFromString,
  canManageUserProjectWorkflows,
  changeProjectStatus,
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
  parseProjectStateFilter,
  projectColumnNotExistError,
  projectIssueCountsForOrg,
  projectIssueNotExistError,
  projectNotExistError,
  projectWorkflowNotExistError,
  removeIssueFromColumn,
  setDefaultColumn,
  toApiOrgProject,
  toApiProject,
  toApiProjectColumn,
  toApiProjectColumnList,
  toApiProjectWorkflow,
  updateColumn,
  updateProject,
  updateWorkflow,
  userProjectScope,
  userVisibleRepos,
  type ProjectRow,
  type ProjectScope,
} from "../services/projects";
import type { RepositoryWithOwner, UserRow } from "../services/repository";
import { canViewRepositoryWithTeams, findRepositoryById, findUserByName, viewerOf } from "../services/repository";
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
import { toApiIssue } from "../services/issues";

/**
 * Tier-1 user-scoped project-board routes (inventory batch 6 stage 3): the
 * 21 `userCurrent*` operations over `/user/projects…` plus the read-only
 * `userListProjects` over `/users/{username}/projects` (frozen contract,
 * tags "user"). The handlers are shared upstream — only the OWNER resolution
 * differs from the org scope (routes/projects-org.ts). Upstream mounts the
 * user group at api.go:1102-1104:
 *
 *   m.Group("/projects", func() {
 *     addProjectRoutes(m, reqToken())
 *   }, tokenRequiresScopes(Issue))
 *
 *  upstream                                      ours
 *  --------------------------------------------  --------------------------------
 *  NO group read gate (unlike the org's          none — the scope owner IS the
 *    reqProjectsUnitAccess(Read))                  doer: projectScopeFromContext's
 *                                                  `owner := util.IfZero(
 *                                                  ctx.ContextUser, ctx.Doer)`
 *                                                  (shared/project.go:38-44)
 *  reqToken() on the mutation group              requireAuth middleware (401
 *                                                  "token is required")
 *  tokenRequiresScopes(Issue)                    no-op — our tokens carry no
 *                                                  scope (SPEC-0002 scope gates
 *                                                  pending)
 *
 * DOER-OWNS-EVERYTHING: every id lookup runs through `GetProjectByIDAndOwner`
 * keyed on the doer's id, so another user's project id reads as not found —
 * there is no gate to fail and no 403 arm on the project CRUD (the contract
 * declares none). ANONYMOUS READS: upstream passes them into
 * projectScopeFromContext with a NIL owner (`owner.IsOrganization()` on a nil
 * *user_model.User is a latent nil-dereference — the contract declares no
 * 401 for these reads either); ours resolves the defined zero-owner answer
 * instead: `GET /user/projects` → 200 [], `GET /user/projects/{id}` → 404
 * (no project row carries owner_id 0).
 *
 * KNOWN DIVERGENCE (stage-2 shape kept): requireAuth precedes everything, so
 * an anonymous MUTATION answers 401 exactly like upstream's reqToken.
 *
 * Issue arms (add/remove/move) reuse the global GetIssueByID semantics
 * documented on the org scope (shared/project.go:114-147): the issue is
 * looked up GLOBALLY, an unreadable repo hides behind the plain 404, and the
 * per-issue archived check answers 423 "repo is archived" (owner boards have
 * no group-level mustNotBeArchived).
 *
 * Column-issue LISTING and every Project render filter through the
 * owner-arm visibility set (LoadIssueNumbersForProject's owner branch):
 * here the owner is a USER, so `userVisibleRepos` walks the target's own
 * repositories through the same canViewRepositoryWithTeams predicate — an
 * anonymous caller of `GET /users/{username}/projects` sees only the public
 * repos' items in the counts; the doer of `/user/projects` sees all their
 * own (private included).
 *
 * Workflow mutations enforce `CanManageWorkflows`' individual arm
 * (services/projects/workflow.go:52): "being a user project's user" — plain
 * `doer.ID == project.OwnerID`, WITHOUT the org arm's site-admin
 * short-circuit (workflow.go:44-49 is TypeOrganization-only). On this scope
 * the project ids are doer-scoped, so the check always passes and the
 * contract's declared 403 arm stays declared-but-unreachable.
 *
 * `GET /users/{username}/projects` (api.go:1065-1066):
 *
 *   m.Get("/projects", tokenRequiresScopes(Issue), reqExploreSignIn(),
 *     reqProjectsUnitAccess(perm.AccessModeRead), shared.ListProjects)
 *
 *  upstream                          ours
 *  --------------------------------  --------------------------------
 *  context.UserAssignmentAPI()       resolveTargetUserOr404 — case-
 *    (services/context/user.go:38-     insensitive name hit, the
 *    66): self short-circuit,          user_redirect 307 seam
 *    GetUserByName, LookupUser-        (RedirectToUser — first path
 *    Redirect → RedirectToUser         occurrence replaced, query
 *    307 / 404 "user redirect does     preserved), else 404 with
 *    not exist [name: …]"; the         upstream's exact miss text;
 *    DoerTokenAllowsOwner arm          our tokens carry no public-
 *                                      only scope so the arm passes
 *  individualPermsChecker            resolved-user ⇒ visible: the
 *    (api.go:922-927) → IsUser-       landed identity has every user
 *    VisibleToViewer → 404 hidden      public until the SPEC-0007
 *                                      visibility column (the
 *                                      routes/users.ts deviation)
 *  reqProjectsUnitAccess(Read)       no-op for individuals —
 *    (api.go:753-767)                  upstream checks
 *                                      ctx.ContextUser.IsOrganization()
 *                                      ONLY; "individual visibility is
 *                                      handled by individualPermsChecker"
 *  reqExploreSignIn                  no-op — RequireSignInViewStrict /
 *                                      Explore.RequireSigninView are
 *                                      false upstream-by-default and
 *                                      unmodeled
 *
 * So the served matrix is: any user that resolves (public — all of them, in
 * the landed model) lists ALL of that user's projects to ANYONE, state
 * filtered, with doer-visible counts (the visibility lives at the USER level,
 * not the project level — upstream has no per-project filter on this route).
 *
 * html_url is the owner-arm link shape `{origin}/{owner}/-/projects/{id}`
 * (ProjectLinkForOrg, models/project/project.go:132-134 — a user's HomeLink
 * is `/{username}`).
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

const projectIdParams = {
  params: z.object({
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
 * id/issue_id with NO `column_id` (the frozen contract's
 * userCurrentMoveProjectIssue parameter list; the target column arrives in
 * the body).
 */
const projectIssueParams = {
  params: projectIdParams.params.extend(issueIdParam),
} as const;

const workflowIdParams = {
  params: projectIdParams.params.extend({
    workflow_id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the workflow" }),
  }),
} as const;

const usernameParams = {
  params: z.object({
    username: z.string().min(1).openapi({ description: "username of the user" }),
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

// ---------------------------------------------------------------------------
// Route declarations (operationIds verbatim from the frozen contract)
// ---------------------------------------------------------------------------

const listProjectsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/projects",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List your projects",
    operationId: "userCurrentListProjects",
    request: projectsListQuery,
    responses: {
      200: {
        description: "ProjectList",
        content: { "application/json": { schema: projectListSchema } },
      },
    },
  });

const createProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/projects",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a project owned by the authenticated user",
    operationId: "userCurrentCreateProject",
    request: {
      body: { content: { "application/json": { schema: createProjectOptionSchema } } },
    },
    responses: {
      201: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      422: validationErrorResponse,
    },
  });

const getProjectRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/projects/{id}",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Get a project",
    operationId: "userCurrentGetProject",
    request: projectIdParams,
    responses: {
      200: { description: "Project", content: { "application/json": { schema: projectSchema } } },
      404: notFoundResponse,
    },
  });

const editProjectRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/user/projects/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Edit a project",
    operationId: "userCurrentEditProject",
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
    path: "/user/projects/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a project",
    operationId: "userCurrentDeleteProject",
    request: projectIdParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

const listColumnsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/projects/{id}/columns",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List a project's columns",
    operationId: "userCurrentListProjectColumns",
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
    path: "/user/projects/{id}/columns",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a column in a project",
    operationId: "userCurrentCreateProjectColumn",
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
    path: "/user/projects/{id}/columns/{column_id}",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Get a project column",
    operationId: "userCurrentGetProjectColumn",
    request: columnIdParams,
    responses: {
      200: { description: "ProjectColumn", content: { "application/json": { schema: projectColumnSchema } } },
      404: notFoundResponse,
    },
  });

const editColumnRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/user/projects/{id}/columns/{column_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Edit a project column",
    operationId: "userCurrentEditProjectColumn",
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
    path: "/user/projects/{id}/columns/{column_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a project column",
    description: "The default column cannot be deleted while it is still the column new issues land in.",
    operationId: "userCurrentDeleteProjectColumn",
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
    path: "/user/projects/{id}/columns/{column_id}/default",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Set a project's default column",
    description: "The default column is where newly assigned issues land.",
    operationId: "userCurrentSetDefaultProjectColumn",
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
    path: "/user/projects/{id}/columns/move",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Reorder a project's columns",
    description: "Reorders every column of the project at once. The body lists all column IDs in their new order.",
    operationId: "userCurrentMoveProjectColumns",
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
    path: "/user/projects/{id}/columns/{column_id}/issues",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List the issues in a project column",
    operationId: "userCurrentListProjectColumnIssues",
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
    path: "/user/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Add an issue to a project column",
    description: "Assigns the issue to the project if it is not a member yet, then places it in the column.",
    operationId: "userCurrentAddIssueToProjectColumn",
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
    path: "/user/projects/{id}/columns/{column_id}/issues/{issue_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Remove an issue from a project column",
    operationId: "userCurrentRemoveIssueFromProjectColumn",
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
    path: "/user/projects/{id}/issues/{issue_id}/move",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Move an issue between a project's columns",
    operationId: "userCurrentMoveProjectIssue",
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
    path: "/user/projects/{id}/workflows",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List a project's workflows",
    operationId: "userCurrentListProjectWorkflows",
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
    path: "/user/projects/{id}/workflows/{workflow_id}",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Get a project workflow",
    operationId: "userCurrentGetProjectWorkflow",
    request: workflowIdParams,
    responses: {
      200: { description: "ProjectWorkflow", content: { "application/json": { schema: projectWorkflowSchema } } },
      404: notFoundResponse,
    },
  });

const createWorkflowRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/projects/{id}/workflows",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create a project workflow",
    operationId: "userCurrentCreateProjectWorkflow",
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
    path: "/user/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Edit a project workflow",
    operationId: "userCurrentEditProjectWorkflow",
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
    path: "/user/projects/{id}/workflows/{workflow_id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a project workflow",
    operationId: "userCurrentDeleteProjectWorkflow",
    request: workflowIdParams,
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userListProjectsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/projects",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List a user's projects",
    operationId: "userListProjects",
    request: { ...usernameParams, ...projectsListQuery },
    responses: {
      200: {
        description: "ProjectList",
        content: { "application/json": { schema: projectListSchema } },
      },
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

/** The renamed-user 307 (UserAssignmentAPI → RedirectToUser; the
 *  account-aggregates seam shape — first path occurrence replaced, query
 *  preserved). */
function renamedUserRedirect(c: Context<ApiEnv>, username: string, canonical: string): HTTPException {
  const url = new URL(c.req.url);
  let location = c.req.path.replace(username, canonical);
  if (url.search !== "") {
    location += url.search;
  }
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/**
 * `context.UserAssignmentAPI` (services/context/user.go:38-66) for the
 * `/users/{username}` group: the case-insensitive self short-circuit and the
 * name lookup are one indexed query here; the redirect miss answers 404 with
 * upstream's exact `ErrUserRedirectNotExist` text. The DoerTokenAllowsOwner
 * arm passes (our tokens carry no public-only scope) and
 * IsUserVisibleToViewer is trivially true in the landed all-public identity.
 */
async function resolveTargetUserOr404(c: Context<ApiEnv>, username: string): Promise<UserRow> {
  const row = await findUserByName(c.env.DB, username);
  if (row !== null) {
    return row;
  }
  const redirect = (
    await drizzle(c.env.DB)
      .select({ userId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, username.toLowerCase()))
      .limit(1)
  )[0];
  if (redirect !== undefined) {
    const target = (
      await drizzle(c.env.DB).select().from(users).where(eq(users.id, redirect.userId)).limit(1)
    )[0];
    if (target !== undefined) {
      throw renamedUserRedirect(c, username, target.username);
    }
  }
  throw new ApiError(404, `user redirect does not exist [name: ${username}]`);
}

/**
 * The authenticated doer with a definite id — the requireAuth middleware's
 * contract on every write route (a resolved principal always carries an id;
 * anything else is the 401 the middleware would already have answered).
 */
function requireDoer(c: Context<ApiEnv>): { id: number; isAdmin: boolean } {
  const requester = viewerOf(c).requester;
  if (requester === null || requester.id === undefined) {
    throw new ApiError(401, "token is required");
  }
  return { id: requester.id, isAdmin: requester.is_admin === true };
}

/** The scope owner: the doer, or null for an anonymous caller (the zero
 *  owner — see the module header's anonymous-reads note). */
function userScope(c: Context<ApiEnv>): ProjectScope {
  return userProjectScope(viewerOf(c).requester?.id ?? null);
}

/**
 * `projectScope.findIssue`'s owner arm (shared/project.go:114-147): GLOBAL
 * issue lookup (404 carries `ErrIssueNotExist{id, 0, 0}`), the issue's repo
 * read permission hides as the plain 404, then the per-issue archived 423
 * (project.go:141-143 — owner boards have no group-level mustNotBeArchived).
 */
async function findUserIssueOr404(
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
 *  is scoped to THIS owner (another user's id reads as not found). */
async function findUserProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
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
async function findOpenUserProjectOr404(c: Context<ApiEnv>, scope: ProjectScope, rawId: string) {
  const project = await findUserProjectOr404(c, scope, rawId);
  if (project.isClosed) {
    throw new ApiError(403, "project is closed");
  }
  return project;
}

/** `ProjectLinkForOrg` over the owner's HomeLink — `{origin}/{owner}/-/projects/{id}`. */
function userProjectHtmlUrl(ownerUsername: string, origin: string, id: number): string {
  return `${origin}/${encodeURIComponent(ownerUsername)}/-/projects/${id}`;
}

/**
 * The user arm's Project render: the counts are filtered through the
 * doer-visible repositories OWNED by the scope owner
 * (LoadIssueNumbersForProject's owner branch) — the repo scope's plain
 * counts would leak private-repo items from `GET /users/{username}/projects`.
 */
async function renderUserProjectRow(
  c: Context<ApiEnv>,
  row: ProjectRow,
  ownerUsername: string,
  visibleRepoIds: string[],
) {
  const viewer = viewerOf(c);
  const counts = await projectIssueCountsForOrg(c.env.DB, row.id, visibleRepoIds);
  return toApiOrgProject(c.env.DB, row, viewer, userProjectHtmlUrl(ownerUsername, viewer.origin, row.id), counts);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectsUserRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -- projects ------------------------------------------------------------

  app.openapi(listProjectsRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const isClosed = parseProjectStateFilter(url.searchParams.get("state"));
    const scope = userScope(c);
    const { items, total } = await listProjects(c.env.DB, scope, isClosed, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    // The doer reads their own boards, so the visible set is every own repo
    // (private included); an anonymous caller lists the zero owner's empty
    // set and needs no render counts.
    const visibleRepoIds =
      scope.ownerId === null
        ? []
        : (await userVisibleRepos(c.env.DB, scope.ownerId, viewer)).map((pair) => pair.repo.id);
    const rendered = [];
    for (const row of items) {
      rendered.push(await renderUserProjectRow(c, row, viewer.requester?.login ?? "", visibleRepoIds));
    }
    return c.json(rendered, 200);
  });

  app.openapi(
    createProjectRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const viewer = viewerOf(c);
      const body = c.req.valid("json");
      const row = await createProject(c.env.DB, userProjectScope(doer.id), {
        title: body.title,
        description: body.description,
        template_type: body.template_type,
        card_type: body.card_type,
        creatorId: doer.id,
        now: new Date(),
      });
      // A fresh board has no items anywhere — plain and filtered counts are 0.
      return c.json(
        await toApiProject(c.env.DB, row, viewer, userProjectHtmlUrl(viewer.requester?.login ?? "", viewer.origin, row.id)),
        201,
      );
    },
    projectBodyHook,
  );

  app.openapi(getProjectRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const scope = userScope(c);
    const row = await findUserProjectOr404(c, scope, c.req.valid("param").id);
    const visibleRepoIds =
      scope.ownerId === null
        ? []
        : (await userVisibleRepos(c.env.DB, scope.ownerId, viewer)).map((pair) => pair.repo.id);
    return c.json(
      await renderUserProjectRow(c, row, viewer.requester?.login ?? "", visibleRepoIds),
      200,
    );
  });

  app.openapi(
    editProjectRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const scope = userProjectScope(doer.id);
      const row = await findUserProjectOr404(c, scope, c.req.valid("param").id);
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
      const visibleRepoIds = (await userVisibleRepos(c.env.DB, doer.id, viewer)).map((pair) => pair.repo.id);
      return c.json(
        await renderUserProjectRow(c, updated, viewer.requester?.login ?? "", visibleRepoIds),
        200,
      );
    },
    projectBodyHook,
  );

  app.openapi(deleteProjectRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const row = await findUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    await deleteProjectById(c.env.DB, row.id);
    return c.body(null, 204);
  });

  // -- columns ---------------------------------------------------------------

  app.openapi(listColumnsRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const project = await findUserProjectOr404(c, userScope(c), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listColumns(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(await toApiProjectColumnList(c.env.DB, items, viewer), 200);
  });

  app.openapi(
    createColumnRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const viewer = viewerOf(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
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
    const viewer = viewerOf(c);
    const project = await findUserProjectOr404(c, userScope(c), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    return c.json(await toApiProjectColumn(c.env.DB, row, viewer), 200);
  });

  app.openapi(
    editColumnRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const viewer = viewerOf(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
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
    const doer = requireDoer(c);
    const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await deleteColumnById(c.env.DB, row, new Date());
    return c.body(null, 204);
  });

  app.openapi(setDefaultColumnRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    const row = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    await setDefaultColumn(c.env.DB, project.id, row.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveColumnsRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
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
    const viewer = viewerOf(c);
    const scope = userScope(c);
    const project = await findUserProjectOr404(c, scope, c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const visible =
      scope.ownerId === null ? [] : await userVisibleRepos(c.env.DB, scope.ownerId, viewer);
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
    const doer = requireDoer(c);
    const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const { issue } = await findUserIssueOr404(c, c.req.valid("param").issue_id);
    await addIssueToColumn(c.env.DB, project, issue, column, doer.id, new Date());
    return c.body(null, 201);
  });

  app.openapi(removeIssueRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    const column = await findColumnOr404(c, project.id, c.req.valid("param").column_id);
    const { issue } = await findUserIssueOr404(c, c.req.valid("param").issue_id);
    await removeIssueFromColumn(c.env.DB, project, issue, column, doer.id, new Date());
    return c.body(null, 204);
  });

  app.openapi(
    moveIssueRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
      // The TARGET column resolves first — a foreign column id is the 422,
      // not the generic 404 (shared/project.go:2089-2098).
      const body = c.req.valid("json");
      const target = await findColumnByIdAndProject(c.env.DB, body.column_id, project.id);
      if (target === null) {
        throw new ApiError(422, "target column does not belong to this project");
      }
      const { issue } = await findUserIssueOr404(c, c.req.valid("param").issue_id);
      await moveIssueToColumn(c.env.DB, project, issue, target, patchField(body.sorting) ?? null, doer.id, new Date());
      return c.body(null, 204);
    },
    projectBodyHook,
  );

  // -- workflows ---------------------------------------------------------------

  app.openapi(listWorkflowsRoute(optionalAuth), async (c) => {
    const project = await findUserProjectOr404(c, userScope(c), c.req.valid("param").id);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const { items, total } = await listWorkflows(c.env.DB, project.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(items.map((row) => toApiProjectWorkflow(row)), 200);
  });

  app.openapi(getWorkflowRoute(optionalAuth), async (c) => {
    const project = await findUserProjectOr404(c, userScope(c), c.req.valid("param").id);
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
      const doer = requireDoer(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
      // CanManageWorkflows' individual arm (workflow.go:52) — owner equality;
      // ids are doer-scoped here, so this asserts the invariant.
      if (!canManageUserProjectWorkflows(project, doer)) {
        throw new ApiError(403, "not allowed to manage the workflows of this project");
      }
      const body = c.req.valid("json");
      const row = await createWorkflow(c.env.DB, userProjectScope(doer.id), null, project, {
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
      const doer = requireDoer(c);
      const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
      const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
      const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
      if (row === null) {
        throw projectWorkflowNotExistError(workflowId);
      }
      if (!canManageUserProjectWorkflows(project, doer)) {
        throw new ApiError(403, "not allowed to manage the workflows of this project");
      }
      const body = c.req.valid("json");
      const updated = await updateWorkflow(c.env.DB, userProjectScope(doer.id), null, project, row, {
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
    const doer = requireDoer(c);
    const project = await findOpenUserProjectOr404(c, userProjectScope(doer.id), c.req.valid("param").id);
    const workflowId = pathParamInt64(c.req.valid("param").workflow_id);
    const row = await findWorkflowByIdAndProject(c.env.DB, workflowId, project.id);
    if (row === null) {
      throw projectWorkflowNotExistError(workflowId);
    }
    if (!canManageUserProjectWorkflows(project, doer)) {
      throw new ApiError(403, "not allowed to manage the workflows of this project");
    }
    await deleteWorkflow(c.env.DB, project.id, row.id);
    return c.body(null, 204);
  });

  // -- another user's boards ---------------------------------------------------

  app.openapi(userListProjectsRoute(optionalAuth), async (c) => {
    const target = await resolveTargetUserOr404(c, c.req.valid("param").username);
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const isClosed = parseProjectStateFilter(url.searchParams.get("state"));
    const scope = userProjectScope(target.id);
    const { items, total } = await listProjects(c.env.DB, scope, isClosed, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    const visibleRepoIds = (await userVisibleRepos(c.env.DB, target.id, viewer)).map((pair) => pair.repo.id);
    const rendered = [];
    for (const row of items) {
      rendered.push(await renderUserProjectRow(c, row, target.username, visibleRepoIds));
    }
    return c.json(rendered, 200);
  });
}
