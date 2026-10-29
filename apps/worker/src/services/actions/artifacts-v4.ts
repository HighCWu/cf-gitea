/**
 * Artifacts v4 — the `/twirp/github.actions.results.api.v1.ArtifactService`
 * family (SPEC-0012 §2.5, M1b), ported from routers/api/actions/
 * artifactsv4.go. The proto is IN-TREE (routers/api/actions/artifact.proto)
 * — the five request/response pairs are transcribed here as the frozen
 * protojson shapes.
 *
 * Bodies are protojson, capped at 1 MiB (parseProtobufBody's LimitReader);
 * int64 fields spell STRINGS on the wire (protojson) and accept both
 * spellings on parse; StringValue/Int64Value wrappers encode as bare JSON
 * values; timestamps encode RFC3339.
 *
 * Signed URLs: HMAC-SHA256 (secrets.ts's BuildSignature port) over
 * (tag="v4", endpoint, expires, artifactName, taskID, artifactID),
 * base64rawurl — 60-minute expiry, verified byte-for-byte + clock-checked
 * (artifactsv4.go:163-261).
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionTasks } from "../../db/schema";
import type { TaskRow } from "./model";
import {
  CONTENT_TYPE_ZIP,
  artifactExpiry,
  createArtifact,
  findReadableArtifacts,
  makeArtifactStoragePath,
  makeBlockFilenameV4,
  makeBlockListKeyV4,
  makeChunkPathV3,
  readableArtifactAttemptIds,
  setArtifactNeedDeleteByRunAttempt,
  updateArtifact,
  v4Dir,
} from "./artifacts";
import { listOrderedChunksForArtifact, writeMergedArtifact, type ByteSource, type ChunkItem } from "./artifacts-merge";
import { retentionDaysFromEnv } from "./retention";
import { actionsBuildSignature, base64RawUrlDecode, base64RawUrlEncode, signaturesEqual, taskIdFromToken } from "./secrets";

/**
 * The upload-time expiry ceiling (artifact.go:94-107's
 * `setting.Actions.ArtifactRetentionDays` arm) — the SAME helper shape as the
 * v1 family: ACTIONS_ARTIFACT_RETENTION_DAYS armed (strict polarity —
 * positive integer) returns the day count that clamps every expiry down to
 * now + days; un-armed (unset/garbage/zero) reads 0 = no ceiling and
 * keep-forever for expiry-less creates (the fail-closed posture: a default
 * deployment NEVER deletes). The env slice is the ActionsRetentionEnv
 * posture (retention.ts): the bindings rider keeps a property overlap with
 * Env so a generated Env from a config that predates the vars still
 * satisfies it (the weak-type check), and the parse is retentionDaysFromEnv
 * — no second parser.
 */
type ArtifactRetentionEnv = Partial<Pick<Env, "DB" | "REPO_PACKS">> & {
  ACTIONS_ARTIFACT_RETENTION_DAYS?: string;
};

function artifactRetentionCeiling(env: ArtifactRetentionEnv): number {
  return retentionDaysFromEnv(env.ACTIONS_ARTIFACT_RETENTION_DAYS) ?? 0;
}

/** ArtifactV4RouteBase (artifactsv4.go:124) — the FULL mount path. */
export const ARTIFACT_V4_ROUTE_BASE = "/twirp/github.actions.results.api.v1.ArtifactService";

const MAX_PROTOBUF_BODY_SIZE = 1024 * 1024;

interface Vars {
  actionsArtifactTask: TaskRow;
  actionsArtifactJob: { runId: number; runAttemptId: number; jobId: number; repoId: string; ownerId: number };
}

type C = Context<{ Bindings: Env; Variables: Vars }>;

// ---------------------------------------------------------------------------
// The frozen protojson shapes (artifact.proto, in-tree at the pin)
// ---------------------------------------------------------------------------

interface TimestampJson {
  seconds?: number;
  nanos?: number;
}

interface CreateArtifactRequest {
  workflow_run_backend_id: string;
  workflow_job_run_backend_id: string;
  name: string;
  expires_at?: TimestampJson | null;
  version?: number;
  mime_type?: string | null;
}
interface CreateArtifactResponse {
  ok: boolean;
  /** protojson emits the lowerCamelCase form (artifactsv4.go:21). */
  signedUploadUrl: string;
}
interface FinalizeArtifactRequest {
  workflow_run_backend_id: string;
  workflow_job_run_backend_id: string;
  name: string;
  size: string | number;
  hash?: string | null;
}
interface FinalizeArtifactResponse {
  ok: boolean;
  /** protojson emits the lowerCamelCase form (artifactsv4.go:50). */
  artifactId: string;
}
interface ListArtifactsRequest {
  workflow_run_backend_id: string;
  workflow_job_run_backend_id: string;
  name_filter?: string | null;
  id_filter?: string | number | null;
}
interface MonolithArtifact {
  workflowRunBackendId: string;
  workflowJobRunBackendId: string;
  databaseId: string;
  name: string;
  size: string;
  createdAt?: string;
}
interface ListArtifactsResponse {
  artifacts: MonolithArtifact[];
}
interface GetSignedArtifactURLRequest {
  workflow_run_backend_id: string;
  workflow_job_run_backend_id: string;
  name: string;
}
interface GetSignedArtifactURLResponse {
  /** protojson emits the lowerCamelCase form (artifactsv4.go:84). */
  signedUrl: string;
}
interface DeleteArtifactRequest {
  workflow_run_backend_id: string;
  workflow_job_run_backend_id: string;
  name: string;
}
interface DeleteArtifactResponse {
  ok: boolean;
  /** protojson emits the lowerCamelCase form. */
  artifactId: string;
}

// ---------------------------------------------------------------------------
// protojson helpers
// ---------------------------------------------------------------------------

function tsToJson(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function tsFromJson(value: TimestampJson | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
}

class ProtobufBodyTooLarge extends Error {}

async function parseProtobufBody<T>(c: C): Promise<T | null> {
  // Capped read (parseProtobufBody's LimitReader): at most MAX+1 bytes are
  // pulled from the stream before the 413 answers.
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = c.req.raw.body?.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        total += value.byteLength;
        if (total > MAX_PROTOBUF_BODY_SIZE) {
          throw new ProtobufBodyTooLarge();
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
  try {
    const text = new TextDecoder().decode(body);
    return JSON.parse(text === "" ? "{}" : text) as T;
  } catch {
    return null;
  }
}

function sendProtobufBody(c: C, value: unknown): Response {
  return c.newResponse(JSON.stringify(value), 200, {
    "content-type": "application/json;charset=utf-8",
  });
}

// ---------------------------------------------------------------------------
// The Go-layout expires string (artifactsv4.go:168/238 —
// "2006-01-02 15:04:05.999999999 -0700 MST"). The runner treats the URL as
// opaque, so the build+verify pair only has to agree with itself; we spell
// UTC ("+0000 UTC").
// ---------------------------------------------------------------------------

function formatExpires(date: Date): string {
  const iso = date.toISOString(); // 2026-01-01T00:00:00.123Z
  const frac = iso.slice(iso.indexOf(".") + 1, iso.indexOf("Z"));
  const padded = (frac + "000000000").slice(0, 9).replace(/0+$/, "") || "0";
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${padded} +0000 UTC`;
}

function parseExpires(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? ([+-])(\d{2})(\d{2}) (\w+)$/.exec(value);
  if (match === null) {
    return null;
  }
  const [, y, mo, d, h, mi, s, frac, sign, oh, om] = match;
  const offsetMinutes = (Number(oh) * 60 + Number(om)) * (sign === "-" ? -1 : 1);
  const ms = frac !== undefined ? Number(`0.${frac}`) * 1000 : 0;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) + ms - offsetMinutes * 60_000;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Signature + contexter
// ---------------------------------------------------------------------------

async function buildSignature(env: Env, endpoint: string, expires: string, artifactName: string, taskId: number, artifactId: number): Promise<Uint8Array> {
  return actionsBuildSignature(env, "v4", [endpoint, expires, artifactName, String(taskId), String(artifactId)]);
}

/**
 * buildArtifactURL (artifactsv4.go:167-177): sig (base64rawurl) + expires +
 * artifactName + taskID + artifactID query params on the twirp endpoint.
 */
async function buildArtifactUrl(c: C, endpoint: string, artifactName: string, taskId: number, artifactId: number): Promise<string> {
  const expires = formatExpires(new Date(Date.now() + 60 * 60 * 1000));
  const sig = base64RawUrlEncode(await buildSignature(c.env, endpoint, expires, artifactName, taskId, artifactId));
  const base = `${new URL(c.req.url).origin}${ARTIFACT_V4_ROUTE_BASE}`;
  return (
    `${base}/${endpoint}?sig=${sig}` +
    `&expires=${encodeURIComponent(expires)}` +
    `&artifactName=${encodeURIComponent(artifactName)}` +
    `&taskID=${taskId}` +
    `&artifactID=${artifactId}`
  );
}

interface ArtifactJob {
  runId: number;
  runAttemptId: number;
  jobId: number;
  repoId: string;
  ownerId: number;
}

/** LoadJob — the task's job row projected to the fields the family uses. */
async function loadJobOf(d1: D1Database, jobId: number): Promise<ArtifactJob | null> {
  const rows = await drizzle(d1)
    .select({
      runId: actionRunJobs.runId,
      runAttemptId: actionRunJobs.runAttemptId,
      jobId: actionRunJobs.id,
      repoId: actionRunJobs.repoId,
      ownerId: actionRunJobs.ownerId,
    })
    .from(actionRunJobs)
    .where(eq(actionRunJobs.id, jobId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * ArtifactV4Contexter — v4's authenticated twirp group (artifactsv4.go:131-138
 * + the ArtifactContexter v4 path: the runtime JWT only; there is no legacy
 * arm on the v4 family).
 */
function v4Contexter(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return v4HttpError(c, 401, "Bad authorization header");
    }
    let taskId: number;
    try {
      taskId = await taskIdFromToken(c.env, authHeader.slice("Bearer ".length), false);
    } catch {
      return v4HttpError(c, 500, "Error runner api getting task");
    }
    const rows = await drizzle(c.env.DB).select().from(actionTasks).where(eq(actionTasks.id, taskId)).limit(1);
    const task = rows[0];
    if (task === undefined) {
      return v4HttpError(c, 500, "Error runner api getting task by ID");
    }
    if (task.status !== 6) {
      return v4HttpError(c, 500, "Error runner api getting task: task is not running");
    }
    const job = await loadJobOf(c.env.DB, task.jobId);
    if (job === null) {
      return v4HttpError(c, 500, "Error runner api getting job");
    }
    c.set("actionsArtifactTask", task);
    c.set("actionsArtifactJob", job);
    await next();
  };
}

function v4HttpError(c: C, status: 400 | 401 | 404 | 413 | 500, message: string): Response {
  return c.text(message, status);
}

function taskOf(c: C): { task: TaskRow; job: Vars["actionsArtifactJob"] } {
  return { task: c.get("actionsArtifactTask"), job: c.get("actionsArtifactJob") };
}

/** validateRunIDV4 (artifacts_utils.go:46-55). */
function validateRunIdV4(c: C, rawRunId: string): Response | null {
  const { job } = taskOf(c);
  const runId = Number(rawRunId);
  if (Number.isNaN(runId) || job.runId !== runId) {
    return v4HttpError(c, 400, "run-id does not match");
  }
  return null;
}

/**
 * verifySignature (artifactsv4.go:217-261): decode the sig params, compare
 * the HMAC, check expiry, load the task (must be running).
 */
async function verifySignature(c: C, endpoint: string): Promise<{ artifactName: string } | null> {
  const rawTaskId = c.req.query("taskID") ?? "";
  const rawArtifactId = c.req.query("artifactID") ?? "";
  const sig = c.req.query("sig") ?? "";
  const expires = c.req.query("expires") ?? "";
  const artifactName = c.req.query("artifactName") ?? "";
  let dsig: Uint8Array;
  let taskId: number;
  let artifactId: number;
  try {
    dsig = base64RawUrlDecode(sig);
    taskId = Number(rawTaskId);
    artifactId = Number(rawArtifactId);
    if (Number.isNaN(taskId) || Number.isNaN(artifactId)) {
      throw new Error("bad ids");
    }
  } catch {
    void v4HttpError(c, 400, "Error decoding signature values");
    return null;
  }
  const expected = await buildSignature(c.env, endpoint, expires, artifactName, taskId, artifactId);
  if (!signaturesEqual(dsig, expected)) {
    void v4HttpError(c, 401, "Error unauthorized");
    return null;
  }
  const expiry = parseExpires(expires);
  if (expiry === null || expiry.getTime() < Date.now()) {
    void v4HttpError(c, 401, "Error link expired");
    return null;
  }
  const rows = await drizzle(c.env.DB).select().from(actionTasks).where(eq(actionTasks.id, taskId)).limit(1);
  const task = rows[0];
  if (task === undefined) {
    void v4HttpError(c, 500, "Error runner api getting task by ID");
    return null;
  }
  if (task.status !== 6) {
    void v4HttpError(c, 500, "Error runner api getting task: task is not running");
    return null;
  }
  // LoadJob parity: the signed task must still own a job row.
  const job = await loadJobOf(c.env.DB, task.jobId);
  if (job === null) {
    void v4HttpError(c, 500, "Error runner api getting job");
    return null;
  }
  c.set("actionsArtifactTask", task);
  c.set("actionsArtifactJob", job);
  return { artifactName };
}

// ---------------------------------------------------------------------------
// Artifact resolution helpers (artifactsv4.go:263-291)
// ---------------------------------------------------------------------------

/** getOwnAttemptArtifactByName — upload/finalize/delete work on the pending
 *  row this attempt created (any status). */
async function getOwnAttemptArtifactByName(c: C, runId: number, runAttemptId: number, name: string) {
  const rows = await findReadableArtifacts(c.env.DB, {
    runId,
    runAttemptIds: [runAttemptId],
    artifactName: name,
  });
  // findArtifactByName orders run_attempt_id DESC, id DESC and requires a
  // real content type ("%/%" LIKE) — the v4 family always sets one.
  const withType = rows.filter((a) => a.contentEncodingOrType.includes("/"));
  const newest = withType.sort((a, b) => b.runAttemptId - a.runAttemptId || b.id - a.id)[0];
  return newest ?? null;
}

/** getDownloadableArtifactByName — the newest CONFIRMED artifact within the
 *  readable attempts (a pending row of a newer attempt never shadows an
 *  older confirmed copy). */
async function getDownloadableArtifactByName(c: C, runId: number, runAttemptIds: number[], name: string) {
  const rows = await findReadableArtifacts(c.env.DB, {
    runId,
    runAttemptIds,
    artifactName: name,
    status: 2,
    finalizedArtifactsV4: true,
  });
  const newest = rows.sort((a, b) => b.runAttemptId - a.runAttemptId || b.id - a.id)[0];
  return newest ?? null;
}

// ---------------------------------------------------------------------------
// The router (artifactsv4.go:140-161)
// ---------------------------------------------------------------------------

export function createArtifactsV4Router(): Hono<{ Bindings: Env; Variables: Vars }> {
  const r = new Hono<{ Bindings: Env; Variables: Vars }>();

  r.onError((err, c) => {
    if (err instanceof ProtobufBodyTooLarge) {
      return v4HttpError(c, 413, "request body too large");
    }
    return v4HttpError(c, 500, err instanceof Error ? err.message : "internal error");
  });

  // The authenticated twirp posts (ArtifactContexter's v4 arm).
  r.use("/CreateArtifact", v4Contexter());
  r.use("/FinalizeArtifact", v4Contexter());
  r.use("/ListArtifacts", v4Contexter());
  r.use("/GetSignedArtifactURL", v4Contexter());
  r.use("/DeleteArtifact", v4Contexter());
  // Upload/Download ride HMAC-signed URLs — UNAUTHENTICATED requests
  // (artifactsv4.go:155-158, no contexter on this group; signature only).
  r.post("/CreateArtifact", createArtifactV4);
  r.post("/FinalizeArtifact", finalizeArtifact);
  r.post("/ListArtifacts", listArtifactsV4);
  r.post("/GetSignedArtifactURL", getSignedArtifactURL);
  r.post("/DeleteArtifact", deleteArtifactV4);
  r.put("/UploadArtifact", uploadArtifactV4);
  r.get("/DownloadArtifact", downloadArtifactV4);

  return r;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** createArtifact (artifactsv4.go:330-402). */
async function createArtifactV4(c: C): Promise<Response> {
  const req = await parseProtobufBody<CreateArtifactRequest>(c);
  if (req === null) {
    return v4HttpError(c, 500, "Error decode request body");
  }
  const bad = validateRunIdV4(c, req.workflow_run_backend_id ?? "");
  if (bad !== null) return bad;
  const { task, job } = taskOf(c);

  const artifactName = req.name ?? "";
  const expirySeconds = tsFromJson(req.expires_at)?.getTime();
  let encoding = req.mime_type ?? "";
  if (encoding !== "") {
    encoding = encoding.split(";")[0]?.trim().toLowerCase() ?? "";
  }
  let fileName = artifactName;
  if (!encoding.includes("/") || (encoding === CONTENT_TYPE_ZIP && !fileName.endsWith(".zip"))) {
    encoding = CONTENT_TYPE_ZIP;
    fileName = `${artifactName}.zip`;
  }
  // Expiry (artifact.go:94-107): the request's expires_at clamps up to
  // tomorrow (v4 clients use the runner's clock) and down to the armed
  // ACTIONS_ARTIFACT_RETENTION_DAYS ceiling; no expires_at → the armed
  // ceiling or keep-forever (0). Computed HERE at CreateArtifact — the only
  // arm upstream computes expiry in (FinalizeArtifact never re-visits it);
  // un-armed var = 0 = no ceiling + keep-forever (the fail-closed default
  // NEVER deletes — the sweep itself stays producer-gated on the same var).
  const expiredUnix = artifactExpiry(
    expirySeconds !== undefined ? Math.floor(expirySeconds / 1000) : null,
    { retentionDays: artifactRetentionCeiling(c.env) },
  );
  // create or get artifact — the v4 path is (name, fileName-as-path).
  const artifact = await createArtifact(c.env.DB, task, job, artifactName, fileName, expiredUnix);
  await updateArtifact(c.env.DB, artifact.id, {
    contentEncodingOrType: encoding,
    fileSize: 0,
    fileCompressedSize: 0,
    status: 1,
  });

  const signedUploadUrl = await buildArtifactUrl(c, "UploadArtifact", artifactName, task.id, artifact.id);
  return sendProtobufBody(c, { ok: true, signedUploadUrl } satisfies CreateArtifactResponse);
}

/**
 * uploadArtifact (artifactsv4.go:404-456): comp=block|appendBlock stream
 * into R2; comp=blocklist stores the XML block list (deleted at finalize's
 * read — readBlockList's arm).
 */
async function uploadArtifactV4(c: C): Promise<Response> {
  const verified = await verifySignature(c, "UploadArtifact");
  if (verified === null) return new Response(null, { status: 401 });
  const { job } = taskOf(c);
  const artifactName = verified.artifactName;

  const comp = c.req.query("comp") ?? "";
  const requestBody = c.req.raw.body;
  if (comp === "block" || comp === "appendBlock") {
    const artifact = await getOwnAttemptArtifactByName(c, job.runId, job.runAttemptId, artifactName);
    if (artifact === null) {
      return v4HttpError(c, 404, "Error artifact not found");
    }
    const blockId = c.req.query("blockid") ?? "";
    if (blockId === "") {
      // appendUploadChunkV3: anonymous append chunk named by range.
      const contentLength = Number(c.req.header("content-length") ?? "0");
      const start = artifact.fileSize;
      const end = contentLength > 0 ? start + contentLength - 1 : 0;
      const path = makeChunkPathV3(job.runId, artifact.id, start, end);
      const contentSize = contentLength > 0 ? contentLength : -1;
      if (contentSize < 0) {
        // Unknown length: read the body through to R2 as a plain PUT of the
        // buffered bytes — appendBlock without a length header is the rare
        // legacy arm; the toolkit always sends Content-Length.
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await c.env.REPO_PACKS.put(path, bytes);
      } else {
        if (requestBody === null) {
          return v4HttpError(c, 500, "Error appending Chunk");
        }
        const fixed = new FixedLengthStream(contentSize);
        const pipeDone = requestBody
          .pipeTo(fixed.writable)
          .catch(() => {
            try {
              void fixed.writable.abort(new Error("chunk read failed"));
            } catch {
              // already errored
            }
          });
        try {
          await c.env.REPO_PACKS.put(path, fixed.readable);
        } catch {
          await pipeDone;
          await c.env.REPO_PACKS.delete(path);
          return v4HttpError(c, 500, "Error appending Chunk");
        }
        await pipeDone;
      }
      const uploadedLength = contentLength > 0 ? contentLength : 0;
      await updateArtifact(c.env.DB, artifact.id, {
        fileCompressedSize: artifact.fileCompressedSize + uploadedLength,
        fileSize: artifact.fileSize + uploadedLength,
      });
    } else {
      // Named block upload (makeBlockFilenameV4).
      const contentLength = Number(c.req.header("content-length") ?? "0");
      const filename = makeBlockFilenameV4(job.runId, artifact.id, contentLength, blockId);
      const path = `${v4Dir(job.runId)}/${filename}`;
      if (contentLength > 0) {
        if (requestBody === null) {
          return v4HttpError(c, 500, "Error uploading block blob");
        }
        const fixed = new FixedLengthStream(contentLength);
        const pipeDone = requestBody
          .pipeTo(fixed.writable)
          .catch(() => {
            try {
              void fixed.writable.abort(new Error("block read failed"));
            } catch {
              // already errored
            }
          });
        try {
          await c.env.REPO_PACKS.put(path, fixed.readable);
        } catch {
          await pipeDone;
          await c.env.REPO_PACKS.delete(path);
          return v4HttpError(c, 500, "Error uploading block blob");
        }
        await pipeDone;
      } else {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        await c.env.REPO_PACKS.put(path, bytes);
      }
    }
    return c.newResponse(JSON.stringify("appended"), 201, { "content-type": "application/json" });
  }

  if (comp === "blocklist") {
    const rawArtifactId = c.req.query("artifactID") ?? "0";
    const artifactId = Number(rawArtifactId);
    const path = makeBlockListKeyV4(job.runId, artifactId);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    await c.env.REPO_PACKS.put(path, bytes);
    return c.newResponse(JSON.stringify("created"), 201, { "content-type": "application/json" });
  }

  // An unknown comp is a no-op upstream too (the switch falls through).
  return new Response(null, { status: 200 });
}

/** readBlockList (artifactsv4.go:462-483): the Latest block ids, in order;
 *  the list object is deleted on read (both paths, like upstream). */
async function readBlockList(env: Env, runId: number, artifactId: number): Promise<string[] | null> {
  const key = makeBlockListKeyV4(runId, artifactId);
  const obj = await env.REPO_PACKS.get(key);
  if (obj === null) {
    return null;
  }
  const xml = await obj.text();
  const latest: string[] = [];
  const re = /<Latest>([^<]*)<\/Latest>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    latest.push(decodeXmlEntities(m[1] ?? ""));
  }
  await env.REPO_PACKS.delete(key);
  return latest;
}

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** finalizeArtifact (artifactsv4.go:485-557 + finalizeDefaultArtifact). */
async function finalizeArtifact(c: C): Promise<Response> {
  const req = await parseProtobufBody<FinalizeArtifactRequest>(c);
  if (req === null) {
    return v4HttpError(c, 500, "Error decode request body");
  }
  const bad = validateRunIdV4(c, req.workflow_run_backend_id ?? "");
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;

  const artifact = await getOwnAttemptArtifactByName(c, runId, job.runAttemptId, req.name ?? "");
  if (artifact === null) {
    return v4HttpError(c, 404, "Error artifact not found");
  }

  // finalizeDefaultArtifact: the blocklist (deleted on read) orders the
  // replay; without one the chunks fall back to v3's start order.
  const blockList = await readBlockList(c.env, runId, artifact.id);
  const chunks: ChunkItem[] = await listOrderedChunksForArtifact(c.env, runId, artifact.id, blockList);
  const last = chunks[chunks.length - 1];
  const fileSize = (last?.end ?? 0) + 1;
  if (Number(req.size ?? "0") !== fileSize) {
    return v4HttpError(c, 500, "Error merge chunks size mismatch");
  }

  const sources: ByteSource[] = chunks.map((item) => ({
    start: item.start,
    end: item.end,
    get: async () => {
      const obj = await c.env.REPO_PACKS.get(item.path);
      if (obj === null) {
        throw new Error(`open chunk error: ${item.path}`);
      }
      return new Uint8Array(await obj.arrayBuffer());
    },
  }));
  const storagePath = makeArtifactStoragePath(runId, artifact.id);
  await writeMergedArtifact(c.env, storagePath, sources, fileSize, req.hash ?? "");
  // drop chunks (artifacts_chunks.go:370-379)
  await c.env.REPO_PACKS.delete(chunks.map((ch) => ch.path));

  await updateArtifact(c.env.DB, artifact.id, {
    storagePath,
    status: 2,
    fileSize,
    fileCompressedSize: fileSize,
  });

  return sendProtobufBody(c, { ok: true, artifactId: String(artifact.id) } satisfies FinalizeArtifactResponse);
}

/** listArtifacts (artifactsv4.go:611-669). */
async function listArtifactsV4(c: C): Promise<Response> {
  const req = await parseProtobufBody<ListArtifactsRequest>(c);
  if (req === null) {
    return v4HttpError(c, 500, "Error decode request body");
  }
  const bad = validateRunIdV4(c, req.workflow_run_backend_id ?? "");
  if (bad !== null) return bad;
  const { job } = taskOf(c);
  const runId = job.runId;
  const attemptIds = readableArtifactAttemptIds(job.runAttemptId);

  const artifacts = await findReadableArtifacts(c.env.DB, {
    runId,
    runAttemptIds: attemptIds,
    status: 2,
    finalizedArtifactsV4: true,
  });

  // Both filters pick from what this attempt may read, so they run after
  // the shadowed artifacts are gone (artifactsv4.go:640-663).
  const table = new Map<string, MonolithArtifact | null>();
  for (const artifact of artifacts) {
    const idFilter = req.id_filter !== undefined && req.id_filter !== null ? Number(req.id_filter) : null;
    const nameFilter = req.name_filter ?? null;
    if (table.has(artifact.artifactName) || (idFilter !== null && artifact.id !== idFilter) || (nameFilter !== null && artifact.artifactName !== nameFilter)) {
      table.set(artifact.artifactName, null);
      continue;
    }
    table.set(artifact.artifactName, {
      workflowRunBackendId: req.workflow_run_backend_id ?? "",
      workflowJobRunBackendId: req.workflow_job_run_backend_id ?? "",
      databaseId: String(artifact.id),
      name: artifact.artifactName,
      size: String(artifact.fileSize),
      createdAt: tsToJson(new Date(artifact.created.getTime())),
    });
  }
  const list: MonolithArtifact[] = [];
  for (const artifact of artifacts) {
    const item = table.get(artifact.artifactName);
    if (item !== undefined && item !== null) {
      list.push(item);
      table.delete(artifact.artifactName);
    }
  }
  return sendProtobufBody(c, { artifacts: list } satisfies ListArtifactsResponse);
}

/** getSignedArtifactURL (artifactsv4.go:671-709). */
async function getSignedArtifactURL(c: C): Promise<Response> {
  const req = await parseProtobufBody<GetSignedArtifactURLRequest>(c);
  if (req === null) {
    return v4HttpError(c, 500, "Error decode request body");
  }
  const bad = validateRunIdV4(c, req.workflow_run_backend_id ?? "");
  if (bad !== null) return bad;
  const { task, job } = taskOf(c);
  const runId = job.runId;
  const attemptIds = readableArtifactAttemptIds(job.runAttemptId);
  const artifactName = req.name ?? "";

  const artifact = await getDownloadableArtifactByName(c, runId, attemptIds, artifactName);
  if (artifact === null) {
    return v4HttpError(c, 404, "Error artifact not found");
  }
  const signedUrl = await buildArtifactUrl(c, "DownloadArtifact", artifactName, task.id, artifact.id);
  return sendProtobufBody(c, { signedUrl } satisfies GetSignedArtifactURLResponse);
}

/** downloadArtifact (artifactsv4.go:711-734) — streams the merged object. */
async function downloadArtifactV4(c: C): Promise<Response> {
  const verified = await verifySignature(c, "DownloadArtifact");
  if (verified === null) return new Response(null, { status: 401 });
  const { job } = taskOf(c);
  const attemptIds = readableArtifactAttemptIds(job.runAttemptId);

  const artifact = await getDownloadableArtifactByName(c, job.runId, attemptIds, verified.artifactName);
  if (artifact === null) {
    return v4HttpError(c, 404, "Error artifact not found");
  }
  const obj = await c.env.REPO_PACKS.get(artifact.storagePath);
  if (obj === null) {
    return v4HttpError(c, 500, "failed to download artifact");
  }
  const headers = new Headers();
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", `attachment; filename="${verified.artifactName.replaceAll('"', "'")}"`);
  return new Response(obj.body, { status: 200, headers });
}

/** deleteArtifact (artifactsv4.go:736-767). */
async function deleteArtifactV4(c: C): Promise<Response> {
  const req = await parseProtobufBody<DeleteArtifactRequest>(c);
  if (req === null) {
    return v4HttpError(c, 500, "Error decode request body");
  }
  const bad = validateRunIdV4(c, req.workflow_run_backend_id ?? "");
  if (bad !== null) return bad;
  const { job } = taskOf(c);

  const artifact = await getOwnAttemptArtifactByName(c, job.runId, job.runAttemptId, req.name ?? "");
  if (artifact === null) {
    return v4HttpError(c, 404, "Error artifact not found");
  }
  await setArtifactNeedDeleteByRunAttempt(c.env.DB, job.runId, job.runAttemptId, req.name ?? "");
  return sendProtobufBody(c, { ok: true, artifactId: String(artifact.id) } satisfies DeleteArtifactResponse);
}
