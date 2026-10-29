/**
 * Artifacts v1 — the `/api/actions_pipeline` family (SPEC-0012 §2.4, M1b),
 * ported from routers/api/actions/artifacts.go + artifacts_utils.go +
 * artifacts_chunks.go + job_summary.go.
 *
 * Auth (ArtifactContexter, artifacts.go:141-192): `Authorization: Bearer
 * <ACTIONS_RUNTIME_TOKEN>` — the HS256 runtime JWT (secrets.ts); legacy
 * runners send the RAW task polling token (GetRunningTaskByToken's
 * last-eight scan + salted-digest verify). The task must be RUNNING (or
 * cancelling — the cleanup-steps arm, GetRunningTaskByToken's status scan).
 * Run-id in the path must match the token's job.
 *
 * Routes (artifacts.go:117-130, the base relative to the /api/actions_pipeline
 * prefix upstream init.go:203 mounts):
 *   GET/POST/PATCH /_apis/pipelines/workflows/:runId/artifacts
 *   PUT  /_apis/pipelines/workflows/:runId/artifacts/:artifactHash/upload
 *   GET  /_apis/pipelines/workflows/:runId/artifacts/:artifactHash/download_url
 *   GET  /_apis/pipelines/workflows/:runId/artifacts/:artifactId/download
 *   PUT  /_apis/pipelines/workflows/:runId/jobs/:jobId/steps/:stepIndex/summary
 *
 * Chunk ingest STREAMS: the request body pipes through an MD5 tee into a
 * FixedLengthStream straight into R2 — never buffered (AGENTS.md stream
 * rule; content-size mismatches fail the pipe before the response).
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionTasks } from "../../db/schema";
import type { TaskRow } from "./model";
import { Md5, md5Hex } from "../packages/maven";
import {
  CONTENT_ENCODING_V3_GZIP,
  createArtifact,
  findReadableArtifacts,
  getArtifactById,
  makeArtifactStoragePath,
  makeChunkPathV3,
  readableArtifactAttemptIds,
  updateArtifact,
  artifactExpiry,
} from "./artifacts";
import { listV3ChunksByRun, planOrderedChunks, writeMergedArtifact, type ByteSource } from "./artifacts-merge";
import { verifyRunnerToken } from "./model";
import { retentionDaysFromEnv } from "./retention";
import { parseAuthorizationToken } from "./secrets";
import {
  JobSummaryAggregateExceededError,
  deleteJobSummary,
  normalizeJobSummaryContentType,
  upsertJobSummary,
} from "./summaries";
import { getTaskStepsByTaskId, workflowStepIndex } from "./update";

interface Vars {
  actionsArtifactTask: TaskRow;
  actionsArtifactJob: { runId: number; runAttemptId: number; jobId: number; repoId: string; ownerId: number };
}

/** The v1 route base relative to the /api/actions_pipeline mount. */
export const ARTIFACT_V1_BASE = "/_apis/pipelines/workflows";

const INVALID_ARTIFACT_NAME_CHARS = '\\/":<>|*?\r\n';

const ARTIFACT_X_TFS_FILE_LENGTH_HEADER = "x-tfs-filelength";
const ARTIFACT_X_ACTIONS_RESULTS_MD5_HEADER = "x-actions-results-md5";

type C = Context<{ Bindings: Env; Variables: Vars }>;

function httpError(c: C, status: 400 | 401 | 404 | 500, message: string): Response {
  return c.text(message, status);
}

/** GetRunningTaskByToken (models/actions/task.go) minus the cache: the
 *  last-eight scan over running/cancelling tasks, then the salted verify. */
async function getRunningTaskByToken(d1: D1Database, token: string): Promise<TaskRow | null> {
  const fail = () => new Error(`task with token ${token}: does not exist`);
  if (token === "" || token.length !== 40) {
    throw fail();
  }
  for (const x of token) {
    const code = x.charCodeAt(0);
    const isHex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
    if (!isHex) {
      throw fail();
    }
  }
  const lastEight = token.slice(-8);
  const db = drizzle(d1);
  const candidates = await db
    .select()
    .from(actionTasks)
    .where(and(eq(actionTasks.tokenLastEight, lastEight), inArray(actionTasks.status, [6, 8])));
  for (const t of candidates) {
    if (await verifyRunnerToken(t.tokenHash, t.tokenSalt, token)) {
      return t;
    }
  }
  throw fail();
}

/**
 * ArtifactContexter (artifacts.go:141-192) as middleware: the Bearer is
 * either the runtime JWT or a legacy raw task token; the resolved task must
 * be running (cancelling tasks keep authenticating for cleanup steps).
 */
function artifactContexter(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return httpError(c, 401, "Bad authorization header");
    }

    // New runner: the JWT. Old runner: the raw GITEA_TOKEN — the JWT parse
    // fails for a non-JWT string, and the legacy arm takes over
    // (artifacts.go:154-180).
    const loadTask = async (): Promise<TaskRow | null | Response> => {
      const jwtTaskId = await parseAuthorizationToken(c.env, authHeader).catch(() => 0);
      if (jwtTaskId > 0) {
        const rows = await drizzle(c.env.DB).select().from(actionTasks).where(eq(actionTasks.id, jwtTaskId)).limit(1);
        const found = rows[0];
        if (found === undefined) {
          return httpError(c, 500, "Error runner api getting task by ID");
        }
        if (found.status !== 6) {
          return httpError(c, 500, "Error runner api getting task: task is not running");
        }
        return found;
      }
      try {
        return await getRunningTaskByToken(c.env.DB, authHeader.slice("Bearer ".length));
      } catch {
        return httpError(c, 500, "Error runner api getting task");
      }
    };
    const loaded = await loadTask();
    if (loaded instanceof Response) {
      return loaded;
    }
    if (loaded === null) {
      return httpError(c, 401, "Bad authorization header");
    }
    const task = loaded;

    // LoadJob (the claim joins the task to its job row).
    const jobRows = await drizzle(c.env.DB)
      .select({
        runId: actionRunJobs.runId,
        runAttemptId: actionRunJobs.runAttemptId,
        jobId: actionRunJobs.id,
        repoId: actionRunJobs.repoId,
        ownerId: actionRunJobs.ownerId,
      })
      .from(actionRunJobs)
      .where(eq(actionRunJobs.id, task.jobId))
      .limit(1);
    const job = jobRows[0];
    if (job === undefined) {
      return httpError(c, 500, "Error runner api getting job");
    }

    c.set("actionsArtifactTask", task);
    c.set("actionsArtifactJob", job);
    await next();
  };
}

function taskOf(c: C): { task: TaskRow; job: Vars["actionsArtifactJob"] } {
  return { task: c.get("actionsArtifactTask"), job: c.get("actionsArtifactJob") };
}

/** GuessCurrentAppURL (artifacts.go:199-204): the request origin. */
function appUrl(c: C): string {
  return new URL(c.req.url).origin;
}

/** The absolute shape of a v1 route URL (buildArtifactURL's output). */
function artifactV1Url(c: C, runId: number, artifactHashOrId: string, suffix: string): string {
  return `${appUrl(c)}/api/actions_pipeline${ARTIFACT_V1_BASE}/${runId}/artifacts/${artifactHashOrId}/${suffix}`;
}

/** validateRunID (artifacts_utils.go:35-44): the token's run must match. */
function validateRunId(c: C): Response | null {
  const { job } = taskOf(c);
  const runId = Number(c.req.param("runId"));
  if (job.runId !== runId) {
    return httpError(c, 400, "run-id does not match");
  }
  return null;
}

/** validateArtifactHash (artifacts_utils.go:69-79) — md5(itemPath) hex. */
function validateArtifactHash(c: C, artifactName: string): Response | null {
  const paramHash = c.req.param("artifactHash") ?? "";
  const artifactHash = md5Hex(new TextEncoder().encode(artifactName));
  if (paramHash === artifactHash) {
    return null;
  }
  return httpError(c, 400, "Invalid artifact hash");
}

/** validateArtifactName (artifacts_utils.go:26-33) — the toolkit's rules. */
function validateArtifactName(c: C, artifactName: string): Response | null {
  for (const ch of INVALID_ARTIFACT_NAME_CHARS) {
    if (artifactName.includes(ch)) {
      return httpError(c, 400, "Error checking artifact name contains invalid character");
    }
  }
  return null;
}

/** util.PathJoinRelX — clean to a relative slash path; `..` segments and
 *  absolute shapes are rejected (the LFS injection-proof rule). */
function pathJoinRel(input: string): string {
  const replaced = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = replaced.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return "";
  }
  return segments.join("/");
}

/** parseArtifactItemPath (artifacts_utils.go:81-95). */
function parseArtifactItemPath(c: C): { name: string; path: string } | null {
  const itemPath = pathJoinRel(c.req.query("itemPath") ?? "");
  const cutAt = itemPath.indexOf("/");
  const name = cutAt === -1 ? itemPath : itemPath.slice(0, cutAt);
  const path = cutAt === -1 ? "" : itemPath.slice(cutAt + 1);
  if (validateArtifactHash(c, name) !== null || validateArtifactName(c, name) !== null) {
    return null;
  }
  return { name, path };
}

/** getUploadFileSize (artifacts_utils.go:99-105). */
function getUploadFileSize(c: C): number {
  const xTfsLength = Number(c.req.header(ARTIFACT_X_TFS_FILE_LENGTH_HEADER) ?? "0");
  if (xTfsLength > 0) {
    return xTfsLength;
  }
  const len = c.req.header("content-length");
  return len !== undefined && len !== null ? Number(len) : 0;
}

/**
 * The upload-time expiry ceiling (artifact.go:94-107's
 * `setting.Actions.ArtifactRetentionDays` arm) for BOTH artifact families:
 * ACTIONS_ARTIFACT_RETENTION_DAYS armed (strict polarity — positive integer)
 * returns the day count that clamps every expiry down to now + days;
 * un-armed (unset/garbage/zero) reads 0 = no ceiling and keep-forever for
 * expiry-less uploads (the fail-closed posture: a default deployment NEVER
 * deletes — the sweep itself stays producer-gated on the same var). The env
 * slice is the ActionsRetentionEnv posture (retention.ts): the bindings
 * rider keeps a property overlap with Env so a generated Env from a config
 * that predates the vars still satisfies it (the weak-type check), and the
 * parse is retentionDaysFromEnv — no second parser.
 */
type ArtifactRetentionEnv = Partial<Pick<Env, "DB" | "REPO_PACKS">> & {
  ACTIONS_ARTIFACT_RETENTION_DAYS?: string;
};

function artifactRetentionCeiling(env: ArtifactRetentionEnv): number {
  return retentionDaysFromEnv(env.ACTIONS_ARTIFACT_RETENTION_DAYS) ?? 0;
}

export function createArtifactsV1Router(): Hono<{ Bindings: Env; Variables: Vars }> {
  const r = new Hono<{ Bindings: Env; Variables: Vars }>();

  r.use("*", artifactContexter());

  // -- retrieve, list and confirm artifacts --------------------------------
  r.get(`${ARTIFACT_V1_BASE}/:runId/artifacts`, listArtifacts);
  r.post(`${ARTIFACT_V1_BASE}/:runId/artifacts`, getUploadArtifactURL);
  r.patch(`${ARTIFACT_V1_BASE}/:runId/artifacts`, confirmUploadArtifact);
  // handle container artifacts list and download
  r.put(`${ARTIFACT_V1_BASE}/:runId/artifacts/:artifactHash/upload`, uploadArtifact);
  // handle artifacts download
  r.get(`${ARTIFACT_V1_BASE}/:runId/artifacts/:artifactHash/download_url`, getDownloadArtifactURL);
  r.get(`${ARTIFACT_V1_BASE}/:runId/artifacts/:artifactId/download`, downloadArtifact);

  // Job summary upload endpoint (GITHUB_STEP_SUMMARY) — the same
  // ArtifactContexter, exactly upstream's AfterRouting placement.
  r.put(`${ARTIFACT_V1_BASE}/:runId/jobs/:jobId/steps/:stepIndex/summary`, uploadJobSummary);

  return r;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** getUploadArtifactURL (artifacts.go:217-243). */
async function getUploadArtifactURL(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;

  let req: { Type?: unknown; Name?: unknown; RetentionDays?: unknown };
  try {
    req = await c.req.json<{ Type?: unknown; Name?: unknown; RetentionDays?: unknown }>();
  } catch {
    return httpError(c, 500, "Error decode request body");
  }
  const name = typeof req.Name === "string" ? req.Name : "";
  const retentionDays = typeof req.RetentionDays === "number" ? req.RetentionDays : 0;

  // use md5(artifact_name) to create upload url; retentionDays rides it.
  const retentionQuery = retentionDays > 0 ? `?retentionDays=${retentionDays}` : "";
  const artifactHash = md5Hex(new TextEncoder().encode(name));
  return c.json(
    { fileContainerResourceUrl: artifactV1Url(c, runId, artifactHash, `upload${retentionQuery}`) },
    200,
  );
}

/**
 * uploadArtifact (artifacts.go:245-297 + saveUploadChunkV3GetTotalSize,
 * artifacts_chunks.go:127-139): create-or-refresh the artifact row, stream
 * the chunk through an MD5 tee into R2, verify size + digest.
 */
async function uploadArtifact(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { task, job } = taskOf(c);
  const runId = job.runId;
  const parsed = parseArtifactItemPath(c);
  if (parsed === null) return new Response(null, { status: 400 });
  const { name: artifactName, path: artifactPath } = parsed;

  const fileRealTotalSize = getUploadFileSize(c);
  // retentionDays rides the upload URL (artifacts.go:232-238 + 257-259):
  // requested expiry = now + days; the armed ACTIONS_ARTIFACT_RETENTION_DAYS
  // then clamps it down (artifact.go:94-107's min arm). This CreateArtifact
  // call is the ONLY arm upstream computes expiry in — confirm/merge never
  // re-visits it; un-armed var = 0 = no ceiling, keep-forever when the
  // runner sent no days.
  const retentionDaysRaw = Number(c.req.query("retentionDays") ?? "0");
  const expiredUnix = artifactExpiry(
    retentionDaysRaw > 0 ? Math.floor(Date.now() / 1000) + retentionDaysRaw * 86400 : null,
    { retentionDays: artifactRetentionCeiling(c.env) },
  );
  const artifact = await createArtifact(c.env.DB, task, job, artifactName, artifactPath, expiredUnix);

  // saveUploadChunkV3GetTotalSize — parse "bytes s-e/total".
  const contentRange = c.req.header("content-range") ?? "";
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (match === null) {
    return httpError(c, 500, "Error save upload chunk");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalSize = Number(match[3]);
  const contentSize = end - start + 1;

  const storagePath = makeChunkPathV3(runId, artifact.id, start, end);
  const hasher = new Md5();
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      hasher.update(chunk);
      ctrl.enqueue(chunk);
    },
  });
  const fixed = new FixedLengthStream(contentSize);
  let readError: Error | null = null;
  const requestBody = c.req.raw.body;
  if (requestBody === null) {
    return httpError(c, 500, "Error save upload chunk");
  }
  const pipeDone = requestBody
    .pipeThrough(tee)
    .pipeTo(fixed.writable)
    .catch((err: unknown) => {
      readError = err instanceof Error ? err : new Error(String(err));
      try {
        void fixed.writable.abort(readError);
      } catch {
        // already errored/closed
      }
    });
  try {
    await c.env.REPO_PACKS.put(storagePath, fixed.readable);
  } catch {
    await c.env.REPO_PACKS.delete(storagePath);
    await pipeDone;
    return httpError(c, 500, "Error save upload chunk");
  }
  await pipeDone;
  if (readError !== null) {
    await c.env.REPO_PACKS.delete(storagePath);
    return httpError(c, 500, "Error save upload chunk");
  }

  // The digest verify (artifacts_chunks.go:113-122): a mismatch deletes.
  const reqMd5 = c.req.header(ARTIFACT_X_ACTIONS_RESULTS_MD5_HEADER) ?? "";
  const chunkMd5 = base64StdFromHex(hasher.hex());
  if (reqMd5 !== chunkMd5) {
    await c.env.REPO_PACKS.delete(storagePath);
    return httpError(c, 500, "Error save upload chunk");
  }

  // update artifact size if zero or not match (artifacts.go:277-292).
  if (
    artifact.fileSize === 0 ||
    artifact.fileCompressedSize === 0 ||
    artifact.fileSize !== fileRealTotalSize ||
    artifact.fileCompressedSize !== totalSize
  ) {
    await updateArtifact(c.env.DB, artifact.id, {
      fileSize: fileRealTotalSize,
      fileCompressedSize: totalSize,
      contentEncodingOrType: c.req.header("content-encoding") ?? "",
    });
  }

  return c.json({ message: "success" }, 200);
}

function base64StdFromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

/** confirmUploadArtifact (artifacts.go:301-320 + mergeChunksForRun,
 *  artifacts_chunks.go:260-296). */
async function confirmUploadArtifact(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;
  const artifactName = c.req.query("artifactName") ?? "";
  if (artifactName === "") {
    return httpError(c, 400, "Error artifact name is empty");
  }
  try {
    await mergeChunksForRun(c.env, runId, job.runAttemptId, artifactName);
  } catch {
    return httpError(c, 500, "Error merge chunks");
  }
  return c.json({ message: "success" }, 200);
}

/** mergeChunksForRun (artifacts_chunks.go:260-296). */
async function mergeChunksForRun(env: Env, runId: number, runAttemptId: number, artifactName: string): Promise<void> {
  const artifacts = await findReadableArtifacts(env.DB, {
    runId,
    runAttemptIds: [runAttemptId],
    artifactName,
  });
  const chunksMap = await listV3ChunksByRun(env, runId);
  for (const art of artifacts) {
    const chunks = chunksMap.get(art.id);
    if (chunks === undefined) {
      continue; // "artifact %d chunks not found"
    }
    const planned = planOrderedChunks(chunks, art.fileCompressedSize);
    if (planned === null) {
      continue; // not complete — nothing merged
    }
    const sources: ByteSource[] = planned.map((p) => {
      const item = chunks.find((ch) => ch.start === p.start && ch.end === p.end);
      const path = item?.path ?? "";
      return {
        start: p.start,
        end: p.end,
        get: async () => {
          const obj = await env.REPO_PACKS.get(path);
          if (obj === null) {
            throw new Error(`open chunk error: ${path}`);
          }
          return new Uint8Array(await obj.arrayBuffer());
        },
      };
    });
    const storagePath = makeArtifactStoragePath(runId, art.id);
    await writeMergedArtifact(env, storagePath, sources, art.fileCompressedSize, "");
    // drop chunks (artifacts_chunks.go:370-379)
    await env.REPO_PACKS.delete(chunks.map((ch) => ch.path));
    await updateArtifact(env.DB, art.id, { storagePath, status: 2 });
  }
}

/** listArtifacts (artifacts.go:333-384). */
async function listArtifacts(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;
  const attemptIds = readableArtifactAttemptIds(job.runAttemptId);
  const artifacts = await findReadableArtifacts(c.env.DB, {
    runId,
    runAttemptIds: attemptIds,
    status: 2,
  });
  if (artifacts.length === 0) {
    return new Response(null, { status: 404 });
  }

  const items: Array<{ name: string; fileContainerResourceUrl: string }> = [];
  const seen = new Set<string>();
  for (const art of artifacts) {
    if (seen.has(art.artifactName)) {
      continue;
    }
    seen.add(art.artifactName);
    const artifactHash = md5Hex(new TextEncoder().encode(art.artifactName));
    items.push({
      name: art.artifactName,
      fileContainerResourceUrl: artifactV1Url(c, runId, artifactHash, "download_url"),
    });
  }
  return c.json({ count: items.length, value: items }, 200);
}

/** getDownloadArtifactURL (artifacts.go:398-464). */
async function getDownloadArtifactURL(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;
  const itemPath = pathJoinRel(c.req.query("itemPath") ?? "");
  const hashBad = validateArtifactHash(c, itemPath);
  if (hashBad !== null) return hashBad;

  const attemptIds = readableArtifactAttemptIds(job.runAttemptId);
  const artifacts = await findReadableArtifacts(c.env.DB, {
    runId,
    runAttemptIds: attemptIds,
    artifactName: itemPath,
    status: 2,
  });
  if (artifacts.length === 0) {
    return new Response(null, { status: 404 });
  }
  const first = artifacts[0];
  if (first === undefined || itemPath !== first.artifactName) {
    return httpError(c, 400, "Error mismatch artifact name");
  }

  const value = artifacts.map((artifact) => ({
    path: pathJoinRel(`${itemPath}/${artifact.artifactPath}`),
    itemType: "file",
    contentLocation: artifactV1Url(c, runId, String(artifact.id), "download"),
  }));
  return c.json({ value }, 200);
}

/** downloadArtifact (artifacts.go:467-525) — streams the merged object. */
async function downloadArtifact(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;
  const artifactId = Number(c.req.param("artifactId"));

  const artifact = await getArtifactById(c.env.DB, artifactId);
  if (artifact === null) {
    return httpError(c, 404, `artifact with ID ${artifactId} does not exist`);
  }
  if (artifact.runId !== runId) {
    return new Response(null, { status: 400 });
  }
  // resolving the readable attempts costs a query, and an artifact of the
  // task's own attempt never needs it (artifacts.go:490-501).
  if (artifact.runAttemptId !== job.runAttemptId) {
    const attemptIds = readableArtifactAttemptIds(job.runAttemptId);
    if (!attemptIds.includes(artifact.runAttemptId)) {
      return new Response(null, { status: 400 });
    }
  }
  if (artifact.status !== 2) {
    return httpError(c, 404, "Error artifact not found");
  }

  const obj = await c.env.REPO_PACKS.get(artifact.storagePath);
  if (obj === null) {
    return httpError(c, 500, "Error opening file");
  }
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${quoteDisposition(artifact.artifactName)}"`);
  // if artifact is compressed, set content-encoding header to gzip
  // (artifacts.go:516-519).
  if (artifact.contentEncodingOrType === CONTENT_ENCODING_V3_GZIP) {
    headers.set("content-encoding", "gzip");
  }
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { status: 200, headers });
}

function quoteDisposition(name: string): string {
  return name.replaceAll('"', "'");
}

/** uploadJobSummary (job_summary.go:21-106). */
async function uploadJobSummary(c: C): Promise<Response> {
  const bad = validateRunId(c);
  if (bad !== null) return bad;
  const { task, job } = taskOf(c);

  const jobId = Number(c.req.param("jobId"));
  if (!(jobId > 0) || job.jobId !== jobId) {
    return httpError(c, 400, "job_id mismatch");
  }
  const stepIndexRaw = Number(c.req.param("stepIndex"));
  if (!Number.isInteger(stepIndexRaw) || stepIndexRaw < 0) {
    return httpError(c, 400, "invalid step_index");
  }
  const steps = await getTaskStepsByTaskId(c.env.DB, task.id);
  if (!steps.some((s) => workflowStepIndex(s) === stepIndexRaw)) {
    return httpError(c, 400, "step_index mismatch");
  }

  const contentType = normalizeJobSummaryContentType(c.req.header("content-type") ?? "");
  if (contentType === null) {
    return httpError(c, 400, "invalid summary content type");
  }

  // Read capped at MaxJobSummarySize+1 (job_summary.go:66-72).
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = c.req.raw.body?.getReader();
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
        if (total > 1024 * 1024) {
          return httpError(c, 400, "invalid summary");
        }
      }
    }
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }

  let message = "success";
  try {
    if (body.length === 0) {
      // PUT with an empty body clears any previously-stored summary.
      await deleteJobSummary(c.env.DB, job.repoId, job.runId, job.runAttemptId, job.jobId, stepIndexRaw);
      message = "cleared";
    } else {
      await upsertJobSummary(c.env.DB, job.repoId, job.runId, job.runAttemptId, job.jobId, stepIndexRaw, contentType, body);
    }
  } catch (err) {
    if (err instanceof JobSummaryAggregateExceededError) {
      return httpError(c, 400, "job summary aggregate size exceeded");
    }
    if (err instanceof Error && err.message === "invalid summary") {
      return httpError(c, 400, "invalid summary");
    }
    return httpError(c, 500, "Error upsert job summary");
  }

  return c.json({ message, sizeBytes: body.length, runAttempt: job.runAttemptId }, 200);
}
