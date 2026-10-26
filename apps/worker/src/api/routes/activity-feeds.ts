import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  isDoerOrgMember,
  requireOrgVisible,
  resolveOrgForRequest,
  type OrgProfileDoer,
} from "../services/orgs";
import { canViewRepositoryWithTeams, findRepositoryByPath, findUserByName, viewerOf } from "../services/repository";
import {
  activitySchema,
  getFeedRows,
  renderFeedItems,
  type Activity,
  type FeedActor,
  type FeedQueryOptions,
} from "../services/activity-feeds";

/**
 * The three activity-feed reads (specs/activity-feeds.md — upstream
 * `ListRepoActivityFeeds` routers/api/v1/repo/repo.go:1262-1316,
 * `ListOrgActivityFeeds` routers/api/v1/org/org.go:448-512,
 * `ListUserActivityFeeds` routers/api/v1/user/user.go:164-219). All three
 * are OPTIONAL-AUTH upstream (api.go:1073/1545/1776 — no reqToken):
 * anonymous callers get the public feed, signed callers get the widened
 * visibility window (SPEC §3.4). Responses mirror the frozen contract
 * exactly: `#/responses/ActivityFeedsList` is a PLAIN ARRAY of `Activity`
 * (Go's non-nil slice shape) plus the runtime `X-Total-Count`/`Link` list
 * headers (`ctx.SetTotalCountHeader`), with the declared notFound for
 * missing/invisible subjects.
 *
 * Feeds list only what the landed emitters wrote (the SPEC §3.3 matrix) —
 * a fresh instance answers `[]`, never synthesized activity.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const feedsListResponse = {
  description: "ActivityFeedsList",
  content: { "application/json": { schema: z.array(activitySchema) } },
} as const;

/** Query params shared by all three ops (declared `type: integer` per the
 *  contract, parsed the landed string-then-clamp way). */
const feedsQuery = {
  date: z
    .string()
    .optional()
    .openapi({ type: "string", format: "date", description: "the date of the activities to be found" }),
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

const repoFeedsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/activities/feeds",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repository's activity feeds",
    operationId: "repoListActivityFeeds",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
      query: z.object(feedsQuery),
    },
    responses: {
      200: feedsListResponse,
      404: notFoundResponse,
    },
  });

const orgFeedsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/activities/feeds",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List an organization's activity feeds",
    operationId: "orgListActivityFeeds",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the org" }),
      }),
      query: z.object(feedsQuery),
    },
    responses: {
      200: feedsListResponse,
      404: notFoundResponse,
    },
  });

const userFeedsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/activities/feeds",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "List a user's activity feeds",
    operationId: "userListActivityFeeds",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose activity feeds are to be listed" }),
      }),
      query: z.object({
        "only-performed-by": z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "if true, only show actions performed by the requested user" }),
        ...feedsQuery,
      }),
    },
    responses: {
      200: feedsListResponse,
      404: notFoundResponse,
    },
  });

/** The actor slice the feed query needs (null = anonymous). */
function feedActorOf(viewer: ReturnType<typeof viewerOf>): FeedActor | null {
  if (viewer.requester === null || viewer.requester.id === undefined) return null;
  return { id: viewer.requester.id, isAdmin: viewer.requester.is_admin === true };
}

/** `ctx.FormString("date")` — first value or absent. */
function dateOf(c: Context<ApiEnv>): string | undefined {
  const raw = new URL(c.req.raw.url).searchParams.get("date");
  return raw === null || raw === "" ? undefined : raw;
}

/** `ctx.FormBool("only-performed-by")` — the ParseBool value rule. */
function formBoolParam(c: Context<ApiEnv>, key: string): boolean {
  const raw = new URL(c.req.raw.url).searchParams.get(key);
  return raw !== null && ["1", "t", "T", "true", "TRUE", "True", "on", "ON", "On"].includes(raw);
}

/** Run one feed query and produce the rendered page + pagination inputs. */
async function feedPage(
  c: Context<ApiEnv>,
  viewer: ReturnType<typeof viewerOf>,
  opts: Omit<FeedQueryOptions, "page" | "limit" | "date">,
): Promise<{ body: Activity[]; total: number; list: { page: number; limit: number } }> {
  const list = parseListOptions(new URL(c.req.url));
  const { total, rows } = await getFeedRows(c.env.DB, { ...opts, date: dateOf(c), ...list });
  return { body: await renderFeedItems(c.env.DB, viewer, rows), total, list };
}

export function registerActivityFeedRoutes(
  app: OpenAPIHono<ApiEnv>,
  _requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // GET /repos/{owner}/{repo}/activities/feeds — repoAssignment visibility
  // via the shared seam (invisible/missing = the anti-enumeration 404);
  // IncludePrivate is ALWAYS true past that gate (repo.go:1299-1304), and
  // the query pins the original rows only (action.go:517-521).
  app.openapi(repoFeedsRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const { owner, repo } = c.req.valid("param");
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
      throw new ApiError(404, "not found");
    }
    const { body, total, list } = await feedPage(c, viewer, {
      kind: "repo",
      repoId: found.repo.id,
      actor: feedActorOf(viewer),
      includePrivate: true,
      onlyPerformedBy: false,
    });
    setPaginationHeaders(c, total, list);
    return c.json(body, 200);
  });

  // GET /orgs/{org}/activities/feeds — orgAssignment parity through the
  // exported org seam (resolve miss → 404, renamed org → the 307 redirect
  // seam, reqOrgVisible → 404); IncludePrivate = admin || org member
  // (org.go:477-489).
  app.openapi(orgFeedsRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const doer: OrgProfileDoer | null = feedActorOf(viewer);
    const url = new URL(c.req.url);
    const resolved = await resolveOrgForRequest(
      c.env.DB,
      c.req.valid("param").org,
      doer,
      c.req.path,
      url.search.startsWith("?") ? url.search.slice(1) : url.search,
    );
    if (resolved.kind === "redirect") {
      // The renamed-org 307 seam (routes/orgs.ts resolveOrg wrapper shape).
      throw new HTTPException(307, {
        res: new Response(null, { status: 307, headers: { Location: resolved.location } }),
      });
    }
    if (resolved.kind === "missing") {
      throw new ApiError(404, "not found");
    }
    const org: OrgRecord = resolved.org;
    const orgs = new OrgService(c.env.DB);
    await requireOrgVisible(orgs, org, doer);
    const includePrivate = doer !== null && (doer.isAdmin || (await isDoerOrgMember(orgs, org, doer)));
    const feedDoer: FeedActor | null = doer === null || doer.id === null ? null : { id: doer.id, isAdmin: doer.isAdmin };
    const { body, total, list } = await feedPage(c, viewer, {
      kind: "org",
      requested: org,
      actor: feedDoer,
      includePrivate,
      onlyPerformedBy: false,
    });
    setPaginationHeaders(c, total, list);
    return c.json(body, 200);
  });

  // GET /users/{username}/activities/feeds — UserAssignmentAPI parity
  // (missing/invisible subject = the 404: public always, limited to signed
  // callers, private to self/admin); IncludePrivate = self || admin
  // (user.go:197); only-performed-by through the FormBool rule.
  app.openapi(userFeedsRoute(optionalAuth), async (c) => {
    const viewer = viewerOf(c);
    const doer = feedActorOf(viewer);
    const subject = await findUserByName(c.env.DB, c.req.valid("param").username);
    if (subject === null) {
      throw new ApiError(404, "not found");
    }
    const selfOrAdmin = doer !== null && (doer.isAdmin || doer.id === subject.id);
    const visible =
      subject.visibility === "public" || (subject.visibility === "limited" && doer !== null) || selfOrAdmin;
    if (!visible) {
      throw new ApiError(404, "not found");
    }
    const { body, total, list } = await feedPage(c, viewer, {
      kind: "user",
      requested: subject,
      actor: doer,
      includePrivate: selfOrAdmin,
      onlyPerformedBy: formBoolParam(c, "only-performed-by"),
    });
    setPaginationHeaders(c, total, list);
    return c.json(body, 200);
  });
}
