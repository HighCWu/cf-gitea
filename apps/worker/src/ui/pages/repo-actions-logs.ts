/**
 * The repo Actions JOB-LOG DOWNLOAD tail — the ui-parity survey's F-row tail
 * GET #1 (docs/compat/ui-parity-survey.md's F actions row): the raw log
 * file the run-viewer's "Download logs" button fetches, over the M1b log
 * chunk store. NOT a page — a bytes arm (the archive-files/wiki-raw family
 * shape); it rides the landed C2 run-viewer family's resolution seam.
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - Route: web.go:1589 `m.Get("/logs", actions.Logs)` inside the
 *     `/runs/{run}/jobs/{job}` subgroup of the `/actions` group (group
 *     middleware `optSignIn, context.RepoAssignment, repo.MustBeNotEmpty,
 *     reqRepoActionsReader, actions.MustEnableActions`) — a READ arm, no
 *     writer gate.
 *   - Handler: view.go:1030 `Logs` → `getCurrentRunByPathParam` (view.go:60-73:
 *     the "latest" literal → GetLatestRun, everything else →
 *     GetRunByRepoAndID — ID-based ONLY, no index disambiguation, no
 *     redirect; the landed pages/repo-actions-view.tsx `resolveRunByPath`
 *     is this port verbatim) →
 *     `common.DownloadActionsRunJobLogsWithID` (routers/common/actions.go:33).
 *   - The download (routers/common/actions.go:98-132
 *     `DownloadActionsRunJobLogs`): job looked up RUN-SCOPED
 *     (GetRunJobByRunAndID — a foreign job id misses), EffectiveTaskID()
 *     (= TaskID>0 ? TaskID : SourceTaskID, run_job.go:158-163) zero →
 *     "job not started", the task row → its LogExpired flag → "logs have
 *     been cleaned up", then OpenLogs → ServeContent with
 *     `Filename: FileNameJoinFields(PathBaseStem(run.WorkflowID), job.Name,
 *     task.ID, ".log")`, `ContentLength: task.LogSize`,
 *     `ContentType: "text/plain; charset=utf-8"`,
 *     `ContentDisposition: attachment`.
 *   - ERROR ARMS ARE 500s upstream: Logs wraps the whole download in
 *     `ctx.ServerError` — a missing job row, an unclaimed job, a vanished
 *     task, an expired log, AND an unreadable log object all answer the
 *     ServerError page, not a 404 (view.go:1036-1039). Ported verbatim:
 *     the loader's `throw` outcomes ride the app's 500 chrome (the
 *     resolveRunAttemptAndJobs precedent in repo-actions-view.tsx, whose
 *     missing-job/missing-attempt arms throw for the same class).
 *
 * ## Headers (httplib.ServeSetHeaders, modules/httplib/serve.go:77-102)
 *
 * `Content-Type: text/plain; charset=utf-8` (the explicit option),
 * `Content-Length` (upstream passes &task.LogSize — the column and the
 * stored bytes advance in the same D1 batch, so the read-back length is the
 * same number; we emit the BYTE-TRUTH length, the honest value if the two
 * ever diverge), `Content-Disposition: attachment; filename=…` through the
 * landed encodeContentDisposition port (content_disposition.go:47-65 — the
 * safe-name form + the RFC 5987 `filename*` suffix when encoding happened;
 * upstream passes path.Base(Filename) into it), `Access-Control-Expose-Headers:
 * Content-Disposition`, and the zero-option prod Cache-Control
 * `max-age=0, private, must-revalidate` (httpcache.go:31-33 — the
 * activity-author-data precedent pair). Upstream's http.ServeContent also
 * carries Range/If-Modified-Since; the Workers reduction serves one full
 * 200 body (a download button's fetch never ranges) — the archive-files
 * family's documented posture.
 *
 * ## The bytes (the M1b store's read half, module-local)
 *
 * Hot tasks read the `action_log_chunks` rows in seq order concatenated
 * (the row-formatted `"<ts> <content>\n"` lines VERBATIM — the download
 * serves raw stored bytes, never re-parsed: upstream io.Copy's the DBFS
 * file); sealed tasks read the R2 object `actions/logs/<log_filename>`.
 * This mirrors services/actions/logs.ts `readLogs`' storage arms without
 * its parseLog validation (a malformed line must not 500 a download that
 * upstream serves byte-for-byte); the landing dedup note sits on the
 * helper.
 *
 * ## Gates (the HANDOFF handler's ladder — the C2 read posture)
 *
 * resolveUiRequest (optSignIn + RepoAssignment) → repo.MustBeNotEmpty →
 * MustEnableActions' repo-unit arm (`repo_settings.has_actions`, the C8
 * polarity) — anonymous readers of a public repo pass (reqRepoActionsReader
 * = RequireUnitReader(TypeActions), the tab-region gate the C1/C2 modules
 * documented). GET-only upstream — a POST answers chi's 405 (the audit
 * arm's convention).
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * 1. Interface: `RepoActionsRunViewRoute.family` gains
 *    `"actions-run-job-logs"` (the tail shares the run-viewer's shape —
 *    run + job segments).
 * 2. Parse arm (inside the `rest[0] === "runs"` block, after the
 *    `rest.length === 4 && rest[2] === "jobs"` view arm):
 *    `if (rest.length === 5 && rest[4] === "logs")
 *    return { family: "actions-run-job-logs", owner, repo, run: rest[1] as string, job: rest[3] as string };`
 *    — the exact `/runs/{run}/jobs/{job}/logs` shape; every deeper tail
 *    stays unclaimed → the engine's 404.
 * 3. Import: `import { actionsJobLogsResponse, loadActionsRunJobLogs }
 *    from "./pages/repo-actions-logs";`
 * 4. Handler (the C2 read ladder; `actionsRunViewGate` is index.ts's shared
 *    MustBeNotEmpty+hasActions helper):
 *
 *     async function actionsRunJobLogsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const resolved = await resolveUiRequest(c);
 *       if (!resolved.ok) return resolved.response;
 *       const { ctx, repo, respond } = resolved;
 *       if (resolved.route.family !== "actions-run-job-logs") return respond(await c.notFound()); // drift guard
 *       const gate = await actionsRunViewGate(c, resolved);
 *       if (gate !== null) return gate;
 *       const route = resolved.route;
 *       const outcome = await loadActionsRunJobLogs(c.env.DB, c.env, repo.id, route.run, route.job ?? "");
 *       if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
 *       if (outcome.outcome === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
 *       return respond(actionsJobLogsResponse(outcome.bytes, outcome.filename));
 *     }
 *
 * 5. Registration (beside the run-viewer subtree's lines — static literals
 *    first, the C1/C2 block's ordering note):
 *    `uiRouter.get("/:owner/:repo/actions/runs/:run/jobs/:job/logs", (c) => actionsRunJobLogsRoute(c));`
 *    `uiRouter.post("/:owner/:repo/actions/runs/:run/jobs/:job/logs", () => methodNotAllowed("GET"));`
 * 6. The neighbor suites' re-arm: pages/repo-actions-view.test.tsx pins
 *    `/actions/runs/7/jobs/9/extra` unclaimed (stays — the logs claim is
 *    the exact 5-segment shape) and does NOT pin `/jobs/9/logs`; the
 *    run-viewer family's `/runs/7/logs` pin (line ~246) stays unclaimed —
 *    upstream has no such route (the download is job-scoped, web.go:1589).
 */

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionLogChunks, actionRunJobs, actionTasks } from "../../db/schema";
import type { RunJobRow } from "../../services/actions/model";
import { encodeContentDisposition } from "../../web/attachments-serving";
import { resolveRunByPath } from "./repo-actions-view";

type D1 = D1Database;

/** ContentDispositionAttachment (httplib/serve.go:24). */
const CONTENT_DISPOSITION_ATTACHMENT = "attachment";
/** The download's content type (DownloadActionsRunJobLogs' ServeHeaderOptions). */
const LOG_CONTENT_TYPE = "text/plain; charset=utf-8";

// ---------------------------------------------------------------------------
// The download filename (util.FileNameJoinFields — filename.go:17-54)
// ---------------------------------------------------------------------------

/** PathNameValidator's InvalidChars (path.go:25 — `(?i)[<>:"/\|?* \x00-\x1f]`)
 *  as a code-point walk (the mirror/gitclient precedent: a literal
 *  control-character range trips the no-control-regex lint). Each invalid
 *  char replaces with "_", upstream's ReplaceAllString shape. */
function sanitizeInvalidFilenameChars(field: string): string {
  let out = "";
  for (const ch of field) {
    const code = ch.codePointAt(0) ?? 0;
    const upper = code >= 0x61 && code <= 0x7a ? code - 0x20 : code; // the (?i) fold
    const invalid =
      upper === 0x3c /* < */ ||
      upper === 0x3e /* > */ ||
      upper === 0x3a /* : */ ||
      upper === 0x22 /* " */ ||
      upper === 0x2f /* / */ ||
      upper === 0x5c /* \ */ ||
      upper === 0x7c /* | */ ||
      upper === 0x3f /* ? */ ||
      upper === 0x2a /* * */ ||
      code <= 0x1f;
    out += invalid ? "_" : ch;
  }
  return out;
}

/** PathBaseStem (path.go:32-34): base name minus its extension (Go's Ext
 *  scans only the final element; a leading-dot name like ".env" has Ext
 *  ".env", so the stem goes empty — Go's exact arithmetic). */
export function pathBaseStem(s: string): string {
  const base = s.slice(s.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  return base.slice(0, base.length - ext.length);
}

/** TruncateStringBytes — a raw byte cut (Go slices bytes; a split rune's
 *  remainder is dropped by the decoder, upstream serves the raw bytes). */
function truncateStringBytes(s: string, limit: number): string {
  if (limit <= 0) return "";
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= limit) return s;
  return new TextDecoder().decode(bytes.slice(0, limit));
}

const textByteLen = (() => {
  const encoder = new TextEncoder();
  return (s: string): number => encoder.encode(s).length;
})();

/**
 * FileNameJoinFields (filename.go:17-54): fields joined by "-", each
 * non-final field sanitized (invalid chars → "_", then "."/"-" → "_") and
 * byte-truncated against the 210-byte budget with a "__" marker; the LAST
 * field is the extension, written verbatim with NO separator before it.
 * The download's call shape is
 * `FileNameJoinFields(PathBaseStem(run.WorkflowID), job.Name, task.ID, ".log")`.
 */
export function fileNameJoinFields(fields: Array<string | number>): string {
  const maxFilenameLen = 210;
  let out = "";
  let len = 0;
  for (let i = 0; i < fields.length; i++) {
    const isLast = i === fields.length - 1;
    let field = sanitizeInvalidFilenameChars(String(fields[i]));
    if (!isLast) {
      field = field.replaceAll(".", "_").replaceAll("-", "_");
      const estimatedRemainingLen = (fields.length - 1 - i) * 3;
      const estimatedLimit = maxFilenameLen - estimatedRemainingLen;
      if (len + textByteLen(field) > estimatedLimit) {
        field = truncateStringBytes(field, estimatedLimit - len - 2) + "__";
      }
      len += textByteLen(field);
      out += field;
      // The separator rides only between STEM fields (never before the ext).
      if (i < fields.length - 2) {
        out += "-";
      }
    } else {
      out += field;
    }
  }
  return out;
}

/** The ServeContent filename for one job's log (actions.go:126). */
export function actionsJobLogFilename(runWorkflowId: string, jobName: string, taskId: number): string {
  return fileNameJoinFields([pathBaseStem(runWorkflowId), jobName, taskId, ".log"]);
}

// ---------------------------------------------------------------------------
// EffectiveTaskID (run_job.go:158-163)
// ---------------------------------------------------------------------------

/** The job's effective task: the current attempt's claim, else the reused
 *  historical task (the rerun-reuses-result column). */
export function effectiveTaskId(job: Pick<RunJobRow, "taskId" | "sourceTaskId">): number {
  if (job.taskId > 0) return job.taskId;
  return job.sourceTaskId;
}

// ---------------------------------------------------------------------------
// The raw log bytes (readLogs' storage arms without the parse — logs.ts:288-311)
// ---------------------------------------------------------------------------

/** services/actions/logs.ts sealedLogKey (§4.2) — kept in sync by shape. */
function sealedLogKey(logFilename: string): string {
  return `actions/logs/${logFilename}`;
}

/**
 * The task's stored log BYTES, verbatim (the formatted
 * `"<ts> <content>\n"` rows): hot tasks concatenate the chunk rows in seq
 * order; sealed tasks read the R2 object. `null` = the open miss —
 * upstream's openTaskLogs converts fs.ErrNotExist into the not-exist error
 * (actions.go:24-31), which the Logs handler still answers 500 (the module
 * header's error-arms note) — the loader maps null to its `throw` outcome.
 */
async function readTaskLogRawBytes(env: Env, task: { id: number; logInStorage: boolean; logFilename: string }): Promise<Uint8Array | null> {
  if (task.logInStorage) {
    const obj = await env.REPO_PACKS.get(sealedLogKey(task.logFilename));
    if (obj === null) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  const rows = await drizzle(env.DB)
    .select({ bytes: actionLogChunks.bytes })
    .from(actionLogChunks)
    .where(eq(actionLogChunks.taskId, task.id))
    .orderBy(asc(actionLogChunks.seq));
  const total = rows.reduce((sum, r) => sum + asBytes(r.bytes).length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const r of rows) {
    const b = asBytes(r.bytes);
    bytes.set(b, at);
    at += b.length;
  }
  return bytes;
}

/** drizzle's blob mode types the column `unknown` — narrow by inspection
 *  (the dispatch.ts/logs.ts idiom). */
function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("actions: blob column did not return bytes");
}

// ---------------------------------------------------------------------------
// The loader (Logs → DownloadActionsRunJobLogsWithID → DownloadActionsRunJobLogs)
// ---------------------------------------------------------------------------

export type ActionsJobLogsOutcome =
  | { outcome: "not-found" }
  | { outcome: "throw"; reason: string }
  | { outcome: "serve"; bytes: Uint8Array; filename: string; size: number };

/**
 * The Logs handler's data arm over one resolved (run, job) URL pair. The
 * run resolution is ID-based ONLY (getCurrentRunByPathParam — "latest" or a
 * row id; the legacy index URL is NOT disambiguated here, it simply misses
 * GetRunByRepoAndID and 404s — upstream's own asymmetry against the view
 * GET). Every download failure is upstream's ctx.ServerError → the `throw`
 * outcome (reason carries the ServerError log tag's message text).
 */
export async function loadActionsRunJobLogs(
  d1: D1,
  env: Env,
  repoId: string,
  runRaw: string,
  jobRaw: string,
): Promise<ActionsJobLogsOutcome> {
  // getCurrentRunByPathParam (view.go:60-73) — the landed resolution port.
  const run = await resolveRunByPath(d1, repoId, runRaw);
  if (run === null) return { outcome: "not-found" };

  // GetRunJobByRunAndID (run_job.go:230-240) — run-scoped; the miss is
  // upstream's ServerError arm (a foreign job id 500s, it does not 404).
  const jobId = parseJobParam(jobRaw);
  const jobRows = await drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(eq(actionRunJobs.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (job === undefined || job.runId !== run.id) {
    return { outcome: "throw", reason: `DownloadActionsRunJobLogsWithID: run job ${jobRaw} not found for run ${run.id}` };
  }

  // DownloadActionsRunJobLogs' posture gates, in order (actions.go:99-117):
  // the repo match (unreachable through the run-scoped job + repo-scoped
  // run lookups — kept as the asserted invariant), the effective task,
  // the task row, the expiry flag.
  if (job.repoId !== repoId) {
    return { outcome: "throw", reason: "DownloadActionsRunJobLogs: job not found" };
  }
  const taskID = effectiveTaskId(job);
  if (taskID === 0) {
    return { outcome: "throw", reason: "DownloadActionsRunJobLogs: job not started" };
  }
  const taskRows = await drizzle(d1).select().from(actionTasks).where(eq(actionTasks.id, taskID)).limit(1);
  const task = taskRows[0];
  if (task === undefined) {
    return { outcome: "throw", reason: `DownloadActionsRunJobLogs: GetTaskByID ${taskID} not found` };
  }
  if (task.logExpired) {
    return { outcome: "throw", reason: "DownloadActionsRunJobLogs: logs have been cleaned up" };
  }

  const bytes = await readTaskLogRawBytes(env, task);
  if (bytes === null) {
    return { outcome: "throw", reason: `DownloadActionsRunJobLogs: unable to open task logs: ${task.logFilename}` };
  }
  return {
    outcome: "serve",
    bytes,
    filename: actionsJobLogFilename(run.workflowId, job.name, task.id),
    size: bytes.length,
  };
}

/** The URL's {job} segment → the row id (digits parse; junk → 0 — the
 *  parsePathParamInt64 convention; 0 misses the lookup → the throw arm). */
function parseJobParam(raw: string): number {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

// ---------------------------------------------------------------------------
// The Response (ServeSetHeaders + the Workers body)
// ---------------------------------------------------------------------------

/**
 * The attachment response: the ServeSetHeaders header set (the module
 * header) over one full 200 body. Content-Length carries the byte truth
 * (the module header's note on upstream's &task.LogSize); the disposition
 * rides the LANDED content_disposition.go port (upstream passes
 * path.Base(Filename) into encodeContentDisposition).
 */
export function actionsJobLogsResponse(bytes: Uint8Array, filename: string): Response {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": LOG_CONTENT_TYPE,
      "content-disposition": encodeContentDisposition(CONTENT_DISPOSITION_ATTACHMENT, base),
      "access-control-expose-headers": "Content-Disposition",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
