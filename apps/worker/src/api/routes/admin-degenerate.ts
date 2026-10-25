import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { parseListOptions, setPaginationHeaders } from "../pagination";

/**
 * The five RUNTIME-ONLY admin ops the remaining-API inventory batches as
 * `wave-api-admin-degenerate` (docs/compat/api-remaining-inventory.md,
 * Batch 11) — every op here is DEGENERATE-BUT-HONEST: the answered shapes are
 * exactly what upstream gives when the backing substrate is absent, and the
 * substrate IS absent in cf-gitea, so the degenerate arm is the arm upstream
 * itself would serve:
 *
 *   cron      GET  /admin/cron                     (adminCronList)
 *             POST /admin/cron/{task}              (adminCronRun)
 *             — upstream renders the in-code cron registry
 *               (gitea/routers/api/v1/admin/cron.go over services/cron);
 *               cf-gitea has no cron daemon — the ONE maintenance task we
 *               actually run is the wrangler.jsonc `triggers.crons` trigger
 *               (the every-10-minutes expression, the SPEC-0009 §2.6
 *               mirror-sync producer the Worker's `scheduled` handler
 *               serves). The static registry
 *               below mirrors that declaration under upstream's own task name
 *               (`update_mirrors`, services/cron/tasks_basic.go:31); the run
 *               arm executes the scheduled handler's exact body
 *               (enqueueDueMirrorSyncs) — "run = enqueue".
 *   unadopted GET  /admin/unadopted                (adminUnadoptedList)
 *             POST /admin/unadopted/{owner}/{repo} (adminAdoptRepository)
 *             DELETE …/{owner}/{repo}              (adminDeleteUnadoptedRepository)
 *             — upstream scans the server's git-root filesystem for repo
 *               directories with no `repository` row
 *               (gitea/routers/api/v1/admin/adopt.go over
 *               repo_service.ListUnadoptedRepositories). cf-gitea has NO
 *               filesystem: every repository that exists is a `repositories`
 *               registry row created through the API, so the unadopted set is
 *               structurally empty. The list answers the always-empty
 *               StringSlice (the landed honest-empty convention,
 *               orgListTeamActivityFeeds — routes/org-teams.ts), and adopt /
 *               delete answer upstream's own not-found arm: EVERY branch of
 *               both upstream handlers (unknown owner → APIErrorNotFound();
 *               adopted (`has`) → APIErrorNotFound(); not on disk
 *               (`!exist`) → APIErrorNotFound()) converges on the same
 *               `404 {"message":"not found"}` body (adopt.go — all six arms,
 *               both handlers), and all six are reachable-or-forced here:
 *               the two 204 arms require an on-disk unadopted directory,
 *               which no cf-gitea code path can produce. The unconditional
 *               404 is not a stub of upstream's answer — it IS upstream's
 *               answer for every request our storage model admits.
 *
 * Auth wiring mirrors the /admin group verbatim (api.go:1824-, the
 * admin-t2.ts seams): reqToken → the shared requireAuth middleware (runtime
 * 401 `token is required` — the contract declares no 401s in this tag, so the
 * code stays undeclared per the admin-t2 convention); reqSiteAdmin → the
 * local requireSiteAdmin copy below (403 `user should be the site admin` —
 * contract-declared on the ops whose swagger comments list it). Two
 * response-set honesty notes carried in scripts/check-openapi.mjs
 * RUNTIME_ONLY_RESPONSES:
 *   - POST /admin/cron/{task}: upstream's OWN swagger comment documents only
 *     {204,404} (admin/cron.go PostCronTask) while the group's reqSiteAdmin
 *     403s non-admins before the handler runs — its sibling ListCronTasks
 *     DOES declare the 403, so the omission is a doc-comment gap upstream
 *     sends anyway; we declare the 403.
 *   - DELETE /admin/unadopted/{owner}/{repo}: upstream documents {204,403}
 *     but its handler answers APIErrorNotFound() for every miss (adopt.go);
 *     in cf-gitea that miss is EVERY call, so the 404 is declared.
 *
 * Degenerate-value notes (the Cron render): `prev` and `exec_times` are not
 * tracked anywhere in cf-gitea (the wrangler trigger fires outside the
 * Worker; no counter is kept), so they render Go's zero values —
 * `0001-01-01T00:00:00Z` / `0`, byte-identical to upstream's unset
 * time.Time/int64. `next` is REAL: the trigger expression is a minute-step
 * spec, so the next UTC firing is computable exactly (unsupported spec
 * shapes — a future wrangler cron the helper does not parse — render the
 * zero time rather than a wrong time). `schedule` renders the wrangler
 * expression verbatim (the every-10-minutes string), not upstream's
 * `@every 10m` config string — the expression is literally what runs.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

// ---------------------------------------------------------------------------
// Contract wire shapes defined in the vendored swagger but not yet needed by
// any models/ module (models/ is outside this wave's ownership — the schema
// lives here until a models/cron.ts extracts it, the misc-t3.ts pattern).
// ---------------------------------------------------------------------------

/** `#/definitions/Cron` — upstream modules/structs/cron.go, all five fields. */
const cronSchema = z.object({
  name: z.string().openapi({ description: "The name of the cron task" }),
  schedule: z.string().openapi({ description: 'The cron schedule expression (e.g., "0 0 * * *")' }),
  next: z.string().openapi({ type: "string", format: "date-time", description: "The next scheduled execution time" }),
  prev: z.string().openapi({ type: "string", format: "date-time", description: "The previous execution time" }),
  exec_times: z
    .number()
    .int()
    .openapi({ description: "The total number of times this cron task has been executed", format: "int64" }),
});

/** `#/responses/CronList` — plain `Cron[]`. */
const cronListSchema = z.array(cronSchema);

/** `#/responses/StringSlice` — plain `string[]`. */
const stringSliceSchema = z.array(z.string());

// ---------------------------------------------------------------------------
// The static cron task registry — the mirror of wrangler.jsonc
// `triggers.crons` (the single source of truth for bindings, AGENTS.md).
// The Worker's `scheduled` handler (src/index.ts) serves that trigger with
// exactly the run body recorded here; a cron added to wrangler.jsonc joins
// this registry under its upstream task name in the same change.
// ---------------------------------------------------------------------------

interface CronTask {
  /** Upstream's task name (services/cron tasks_basic.go register calls). */
  name: string;
  /** The wrangler-declared trigger expression — rendered verbatim. */
  spec: string;
  /** The scheduled-handler body this task runs (the POST /admin/cron arm). */
  run: (env: Env) => Promise<number>;
}

const CRON_TASKS: CronTask[] = [
  {
    name: "update_mirrors",
    spec: "*/10 * * * *",
    run: (env) => enqueueDueMirrorSyncs(env, {}),
  },
];

/** Go's zero time.Time as json.Marshal renders it (services/cron leaves
 *  task.Prev unset until the first fire; we never set it). */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * The minute-step subset of cron expressions (a star-slash-N minute field
 * followed by `* * * * *`) → the step in minutes, or null for anything else
 * (a future wrangler spec the helper does not parse renders the zero `next`
 * — never a wrong time).
 */
function minuteStepMinutes(spec: string): number | null {
  if (spec === "* * * * *") {
    return 1;
  }
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const step = Number.parseInt(match[1]!, 10);
  return step >= 1 ? step : null;
}

/**
 * The next UTC firing of a minute-step spec after `from` (Cloudflare cron
 * triggers fire at UTC minute boundaries; on a boundary the NEXT step is
 * returned — the current minute's firing is the one in progress).
 */
function nextMinuteStepFire(stepMinutes: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  const remainder = next.getUTCMinutes() % stepMinutes;
  next.setUTCMinutes(next.getUTCMinutes() + (remainder === 0 ? stepMinutes : stepMinutes - remainder));
  return next;
}

/** structs.Cron render — the cron.go ListCronTasks field mapping. */
function toApiCron(task: CronTask, now: Date) {
  const step = minuteStepMinutes(task.spec);
  return {
    name: task.name,
    schedule: task.spec,
    next: step === null ? GO_ZERO_TIME : nextMinuteStepFire(step, now).toISOString(),
    prev: GO_ZERO_TIME,
    exec_times: 0,
  };
}

// ---------------------------------------------------------------------------
// Auth seam (admin-t2.ts requireSiteAdmin verbatim — that helper is the
// module's private, and admin-t2.ts is outside this wave's ownership)
// ---------------------------------------------------------------------------

/**
 * `reqSiteAdmin` (routers/api/v1/api.go:343-347): a resolved doer who is not
 * a site admin gets the exact upstream 403 message. Mounted AFTER requireAuth,
 * which has already set `authUser` (the middleware order mirrors the upstream
 * group: reqToken then reqSiteAdmin).
 */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Route definitions (declared response sets = the contract plus the two
// RUNTIME_ONLY_RESPONSES-documented codes; see the module header)
// ---------------------------------------------------------------------------

const adminCronListRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/cron",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "List cron tasks",
    operationId: "adminCronList",
    request: {
      query: z.object({
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "CronList", content: { "application/json": { schema: cronListSchema } } },
      403: forbiddenResponse,
    },
  });

const adminCronRunRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/cron/{task}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Run cron task",
    operationId: "adminCronRun",
    request: {
      params: z.object({
        task: z.string().min(1).openapi({ description: "task to run" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): the group's
      // reqSiteAdmin gate — upstream's own swagger comment for this op omits
      // it while its sibling list declares it (module header).
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const adminUnadoptedListRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/unadopted",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "List unadopted repositories",
    operationId: "adminUnadoptedList",
    request: {
      query: z.object({
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
        query: z
          .string()
          .optional()
          .openapi({ description: "glob pattern of repositories to search for, in the form owner or owner/repo" }),
      }),
    },
    responses: {
      200: { description: "StringSlice", content: { "application/json": { schema: stringSliceSchema } } },
      403: forbiddenResponse,
    },
  });

const adminAdoptRepositoryRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/unadopted/{owner}/{repo}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Adopt unadopted files as a repository",
    operationId: "adminAdoptRepository",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const adminDeleteUnadoptedRepositoryRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/admin/unadopted/{owner}/{repo}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Delete unadopted files",
    operationId: "adminDeleteUnadoptedRepository",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): upstream's
      // handler 404s every miss (adopt.go) though its swagger documents only
      // {204,403}; in cf-gitea the miss is every call (module header).
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Registration — handlers
// ---------------------------------------------------------------------------

export function registerAdminDegenerateRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // GET /admin/cron — the static registry, upstream-paginated (cron.go:
  // ListCronTasks — count before the slice, X-Total-Count over the full set).
  app.openapi(adminCronListRoute(requireAuth), (c) => {
    const options = parseListOptions(new URL(c.req.url));
    const start = (options.page - 1) * options.limit;
    const page = CRON_TASKS.slice(start, start + options.limit);
    setPaginationHeaders(c, CRON_TASKS.length, options);
    return c.json(page.map((task) => toApiCron(task, new Date())), 200);
  });

  // POST /admin/cron/{task} — unknown task → APIErrorNotFound() (cron.go:
  // PostCronTask); a known task runs its scheduled-handler body inline (the
  // enqueue is a bounded SELECT + sendBatch, sub-second) and answers 204.
  app.openapi(adminCronRunRoute(requireAuth), async (c) => {
    const { task } = c.req.valid("param");
    const known = CRON_TASKS.find((entry) => entry.name === task);
    if (known === undefined) {
      throw new ApiError(404, "not found");
    }
    await known.run(c.env);
    return c.body(null, 204);
  });

  // GET /admin/unadopted — always-empty (the honest-empty convention): no
  // filesystem exists, so the unadopted set is structurally empty for every
  // page and every glob. Upstream's own Page==0-defaulting rides
  // parseListOptions (page >= 1 always).
  app.openapi(adminUnadoptedListRoute(requireAuth), (c) => {
    const options = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, 0, options);
    return c.json([] as string[], 200);
  });

  // POST/DELETE /admin/unadopted/{owner}/{repo} — the unconditional not-found
  // arm (module header: every upstream branch converges on this body, and
  // the two 204 branches require an on-disk unadopted directory that no
  // cf-gitea code path can produce).
  const unadoptedMiss = (): ApiError => new ApiError(404, "not found");

  app.openapi(adminAdoptRepositoryRoute(requireAuth), () => {
    throw unadoptedMiss();
  });

  app.openapi(adminDeleteUnadoptedRepositoryRoute(requireAuth), () => {
    throw unadoptedMiss();
  });
}
