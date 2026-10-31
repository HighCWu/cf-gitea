import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { enqueueDueAuditRetention } from "../../services/audit";
import { enqueueDueDemoSweeps } from "../../services/demo-sweep";
import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
import { enqueueDuePushMirrorSyncs } from "../../services/mirror/push-sync";
import { enqueueDuePackagesCleanup } from "../../services/packages/cleanup";
import {
  CRON_ARMS,
  listCronState,
  recordArmsSuccess,
  type CronArm,
  type CronStateRow,
} from "../../services/cron-state";
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
 *             — upstream renders its in-code cron registry
 *               (gitea/routers/api/v1/admin/cron.go ListCronTasks over
 *               services/cron: every registered task, with the live
 *               Next/Prev/ExecTimes triple, cron.go:119-127) and runs ONE
 *               named task (PostCronTask → task.Run(), which counts
 *               ExecTimes at start and stamps LastRun before the body —
 *               services/cron/tasks.go:95-115). cf-gitea's analog registry
 *               is the scheduled dispatcher's arm census — CRON_ARMS
 *               (services/cron-state.ts), the same names the scheduled
 *               handler's recorder keys and the admin monitor's cron page
 *               renders — and its analog tick store is the `cron_state`
 *               table the recorder upserts per entry (upstream keeps the
 *               triple in memory on its long-lived Task structs; Workers
 *               isolates are ephemeral, hence the store). The LIST renders
 *               the full census with the recorded state merged (prev =
 *               last_success — upstream's Prev is a run START while the
 *               store's granularity is entry completion, the store's own
 *               disclosed note — and exec_times = runs); the RUN arm
 *               executes the arm's scheduled producer body ("run =
 *               enqueue", the landed posture the monitor's form cites) and
 *               records the manual tick exactly like the monitor does
 *               (recordArmsSuccess, log-and-continue — upstream's
 *               ExecTimes counts manual runs too, tasks.go:95-97).
 *
 *             The registry SPLIT the two surfaces keep (disclosed): the
 *             census (10 arms) is the SCHEDULER's lens while the API's run
 *             gate is the runnable subset whose producer bodies are landed
 *             here — upstream's registry is its runnable set, but upstream
 *             is one process where we are two invocation kinds (fetch vs
 *             scheduled). A listed-but-unrunnable task answers the same 404
 *             as an unknown one — the monitor's adjudicated arm
 *             ("a listed-but-unrunnable arm must answer task.unknown
 *             exactly like an unknown op", admin-monitor.tsx
 *             RUNNABLE_CRON_ARMS); extending run capability extends BOTH
 *             this map and the monitor's set (its extension rule says so).
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
 * Degenerate-value notes (the Cron render): an arm with no `cron_state` row
 * (nothing recorded yet — a fresh deployment) renders Go's zero values —
 * `0001-01-01T00:00:00Z` / `0`, byte-identical to upstream's unset
 * time.Time/int64; an arm WITH recorded ticks renders them
 * (last_success / runs — the merge the monitor's state loader performs).
 * `next` is REAL for the census's two spec shapes (the minute-step and the
 * hourly-at-minute expressions): the next UTC firing is computable exactly
 * (unsupported spec shapes — a future wrangler cron the helper does not
 * parse — render the zero time rather than a wrong time). `schedule`
 * renders the wrangler expression verbatim (the census's own convention),
 * not upstream's `@every 10m` config string — the expression is literally
 * what runs.
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
// The cron registry — the arm census (CRON_ARMS, services/cron-state.ts) for
// the LIST, and the runnable producer bodies for the RUN arm. The census is
// the single source both the scheduled handler's recorder and the admin
// monitor's cron page key on, so an API row, its tick row and the monitor
// row can never drift apart; a census arm's producer body joins the run map
// in the same change (the monitor's RUNNABLE_CRON_ARMS extension rule).
// ---------------------------------------------------------------------------

/** The env shapes the five producers take are structural subsets of Env; the
 *  map's value type pins only what the callers share. */
type CronRunBody = (env: Env) => Promise<number>;

/**
 * The runnable arms — the census entries whose scheduled producer body is
 * landed here (services/cron-state.ts's census holds the per-arm upstream
 * cites; the bodies are the scheduled dispatcher's exact producer calls,
 * "run = enqueue" — "crons enqueue, consumers do the work"). A census arm
 * absent from this map (the FIVE actions-family arms — stop_zombie_tasks,
 * cleanup_actions, stop_endless_tasks, cancel_abandoned_jobs and
 * cleanup_ephemeral_runners, whose producer modules live in
 * services/actions/**, an in-flight sibling's ownership) answers the run
 * arm's 404 exactly like an unknown task — the monitor's adjudicated arm —
 * and extending run capability extends the monitor's RUNNABLE_CRON_ARMS in
 * the same landing.
 */
const CRON_RUN_BODIES: Readonly<Record<string, CronRunBody>> = {
  update_mirrors: (env) => enqueueDueMirrorSyncs(env, {}),
  update_push_mirrors: (env) => enqueueDuePushMirrorSyncs(env, {}),
  demo_sweep: (env) => enqueueDueDemoSweeps(env, {}),
  delete_old_audit_events: (env) => enqueueDueAuditRetention(env, {}),
  cleanup_packages: (env) => enqueueDuePackagesCleanup(env, {}),
};

/** Go's zero time.Time as json.Marshal renders it (services/cron leaves
 *  task.Prev unset until the first fire; an arm without a cron_state row is
 *  exactly that posture). */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * The minute-step subset of cron expressions (a star-slash-N minute field
 * followed by `* * * * *`) → the step in minutes, or null for anything else.
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
 * The hourly-at-minute subset (`M * * * *`, the DEMO_SWEEP_CRON shape) → the
 * fire minute, or null for anything else.
 */
function hourlyEntryMinute(spec: string): number | null {
  const match = /^(\d{1,2}) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const minute = Number.parseInt(match[1]!, 10);
  return minute >= 0 && minute <= 59 ? minute : null;
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

/** The next UTC firing of an hourly-at-minute spec after `from`. */
function nextHourlyFire(minute: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

/** The supported families' dispatch — null renders the zero time (never a
 *  wrong time, the parser's own posture for an unsupported future spec;
 *  mirrored from the monitor's nextFireForSpec). */
function nextFireForSpec(spec: string, from: Date): Date | null {
  const step = minuteStepMinutes(spec);
  if (step !== null) {
    return nextMinuteStepFire(step, from);
  }
  const minute = hourlyEntryMinute(spec);
  if (minute !== null) {
    return nextHourlyFire(minute, from);
  }
  return null;
}

/** structs.Cron render — the cron.go ListCronTasks field mapping over the
 *  census arm and its recorded state (prev = last_success, exec_times =
 *  runs; a rowless arm renders the zero pair). */
function toApiCron(task: CronArm, now: Date, state: CronStateRow | undefined) {
  const next = nextFireForSpec(task.spec, now);
  return {
    name: task.arm,
    schedule: task.spec,
    next: next === null ? GO_ZERO_TIME : next.toISOString(),
    prev: state === undefined || state.lastSuccess === null ? GO_ZERO_TIME : state.lastSuccess.toISOString(),
    exec_times: state?.runs ?? 0,
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
  // GET /admin/cron — the full arm census, upstream-paginated (cron.go:
  // ListCronTasks — count before the slice, X-Total-Count over the full
  // registry) with the recorded tick state merged (the monitor's loader
  // shape; one point scan of a ≤10-row table).
  app.openapi(adminCronListRoute(requireAuth), async (c) => {
    const options = parseListOptions(new URL(c.req.url));
    const start = (options.page - 1) * options.limit;
    const state = await listCronState(c.env.DB);
    const now = new Date();
    const page = CRON_ARMS.slice(start, start + options.limit).map((arm) => toApiCron(arm, now, state.get(arm.arm)));
    setPaginationHeaders(c, CRON_ARMS.length, options);
    return c.json(page, 200);
  });

  // POST /admin/cron/{task} — unknown AND listed-but-unrunnable →
  // APIErrorNotFound() (cron.go PostCronTask's miss arm; the monitor's
  // adjudicated posture for the census/runnable split). A runnable task
  // executes its scheduled producer body inline (each body is a bounded
  // probe + enqueue, sub-second) and then records the manual tick exactly
  // like the monitor's form does — recordArmsSuccess AFTER the body,
  // log-and-continue (upstream counts manual runs too, tasks.go:95-97; a
  // failed run records nothing — recordArmsSuccess is a COMPLETED tick).
  app.openapi(adminCronRunRoute(requireAuth), async (c) => {
    const { task } = c.req.valid("param");
    const run = CRON_RUN_BODIES[task];
    if (run === undefined) {
      throw new ApiError(404, "not found");
    }
    await run(c.env);
    const arm = CRON_ARMS.find((entry) => entry.arm === task);
    if (arm !== undefined) {
      await recordArmsSuccess(c.env.DB, [arm]).catch((recordError: unknown) => {
        console.error("[cron-state] manual run tick not recorded", recordError);
      });
    }
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
