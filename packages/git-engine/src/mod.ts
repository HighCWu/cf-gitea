/**
 * durable-git library entry. `createDurableGit(options)` returns the Worker
 * handler; re-export `RepoCell` and `Registry` from your entry module so the
 * runtime can find the Durable Object classes:
 *
 *   import { createDurableGit } from "durable-git";
 *   export { RepoCell, Registry } from "durable-git";
 *   export default createDurableGit({ authorize, onPush });
 */
import type { Env } from "./env";
import type { Registry, RepoInfo } from "./registry";
import { esc, repoUrl, age, layout, htmlResponse, errorPage } from "./ui/html";
import { CSS } from "./ui/style";
import { parseUploadRequest, parsePushCommands, renderStatus, sidebandFrames, streamingCloneResponse, type PushCommand } from "./git/protocol";
import { isOid, concat, te, toHex, ZERO_OID, Sha1 } from "./git/util";
import { gunzipLimited } from "./git/zlib";
import { MultipartCapture, beginRawMultipart } from "./git/multipart";
import { overDeclaredLength, tooLargeResponse } from "./repo";
import { idxR2Key, packName, packR2Key } from "./git/r2keys";
import {
  asCommandResults,
  NO_PACK,
  type FinalizedPack,
} from "./control-plane";
import type { RepoCell } from "./repo";
import type { PlanCloneStreamResult } from "./read-leases";
import { DeltaResolver } from "./receive/delta";
import { walkPack } from "./receive/scan";
import { writeIdx } from "./receive/idx";
import { copyObject } from "./fork/replicate";

export { RepoCell } from "./repo";
export { Registry } from "./registry";
export type { Env } from "./env";
export type { RepoInfo, RepoConfig } from "./registry";
export type { RefsResult, CommitJson, TreeResult, TreeEntryJson, BlobResult, LogResult, DiffResult, DiffFileJson } from "./repo";
export type { Person } from "./git/objects";
// object serializers (SPEC-0001a §4.1): the Worker-side builders construct the
// canonical bytes that putApiObjects verifies and stores
export {
  serializeCommit,
  serializeCommit as serializeCommitObject,
  serializeTag,
  serializeTree,
  emptyTree,
  EMPTY_TREE_OID,
  personLine,
  type CommitSpec,
  type TagSpec,
  type SerializeTreeEntry,
} from "./commit/serialize";
// receive control plane (SPEC-0001a §3 Steps 1-2): the Worker-side data plane
// in this file drives these lease RPCs; consumers of the engine re-export them
// so the typed boundary is complete. The repo lifecycle RPCs
// (markDeleted/destroy/setHead, SPEC-0003 §2.5.5) ride the same boundary.
export type {
  ApiObject,
  BeginReceiveInput,
  BeginReceiveResult,
  CommitApiChangeInput,
  CommitApiChangeResult,
  DestroyResult,
  FinalizedPack,
  FinalizeReceiveInput,
  FinalizeReceiveResult,
  IndexRow,
  ListPackCatalogInput,
  ListPackCatalogResult,
  LookupObjectHit,
  LookupObjectResult,
  MarkDeletedResult,
  PackCatalogEntry,
  PutApiObjectsResult,
  PutRebaseObjectsResult,
  ReceiveCommandResult,
  ReleaseReceiveInput,
  ReleaseReceiveResult,
  SetHeadResult,
} from "./control-plane";
// merge surface (SPEC-0001b §4): the PR/compare API waves consume these
// through the generated dist-types boundary
export type {
  CheckMergeabilityInput,
  CheckMergeabilityResult,
  DeleteApiRefInput,
  DeleteApiRefResult,
  ExecuteMergeInput,
  ExecuteMergeResult,
  ExtraRefUpdate,
  MergeabilityStatus,
  MergeStyle,
  RebaseOntoInput,
  RebaseOutcome,
} from "./merge/types";
export type { MergeConflictPath, MergeObject, MergePlan, TreeChange } from "./merge/tree";
export type { WalkAnswer, WalkOpts } from "./merge/graph";
export { MERGE_BASE_MAX_VISITS } from "./merge/graph";
// read leases (SPEC-0011 §3, M3.1): the DO-side substrate re-exported so the
// typed boundary is complete — the Worker consumes the RepoCell RPCs
// (planCloneStream/renewAndAuthorizeRead/releaseReadLease) through these types.
export type {
  ByteRange,
  LiveReadLease,
  PlanCloneStreamResult,
  PlanFetchOptions,
  PlanFetchResult,
  ReadLeasePayload,
  ReleaseReadResult,
  RenewReadResult,
} from "./read-leases";
export { READ_LEASE_TTL_MS, READ_RENEW_MARGIN_MS } from "./read-leases";
// compaction (SPEC-0011 §5, M3.3): the DO-side round + its trigger constants,
// re-exported so tests/benches and the typed boundary see one surface — the
// entry point is the RepoCell.compactNow RPC, the production trigger the DO
// alarm over `compaction_wanted_at`.
export type {
  CompactionHost,
  CompactionLeasePayload,
  CompactionResult,
  CompactionRunOptions,
} from "./compaction";
export {
  COMPACTION_ACTIVE_PACK_THRESHOLD,
  COMPACTION_LEASE_TTL_MS,
  COMPACTION_MIN_INPUT_PACKS,
  COMPACTION_RETRY_MS,
  COMPACTION_WINDOW_BYTES,
  COMPACTION_WINDOW_OBJECTS,
  COMPACTION_WINDOW_PACKS,
  runCompaction,
} from "./compaction";
// GC (SPEC-0011 §2, M3.4): the RETIRED→RECLAIMABLE→DELETED transitions + the
// clone-cache drain, re-exported for the same reason — the entry points are
// the RepoCell.gcNow RPC and the DO alarm pass over `gc_wanted_at`.
export type { GcCollected, GcHost, GcPassResult } from "./gc";
export { GC_RETRY_MS, runGcPass } from "./gc";
// fork catalog replication (SPEC-0001b §5.3): the four RepoCell RPCs plus the
// Worker-side consumer loop the fork endpoint's queue consumer calls (the
// streamed bucket.get → bucket.put copy — the R2 binding has no server-side
// copy — lives in replicate.ts and is reused by the receive path below)
export type {
  AdoptForkPacksResult,
  BeginForkImportResult,
  CatalogPage,
  CatalogPackEntry,
  FinalizeForkImportInput,
  FinalizeForkImportResult,
  ForkInvalid,
} from "./fork/types";
export type { ForkSourceRepo, ForkTargetRepo, ReplicateForkOpts, ReplicateForkResult } from "./fork/replicate";
export { copyObject, replicateForkCatalog } from "./fork/replicate";

/** an upload-pack negotiation body is wants/haves/caps only — a few hundred KB */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;
/** default push cap when MAX_PUSH_MB is unset, in MiB (matches env.ts docs) */
const DEFAULT_MAX_PUSH_MB = 512;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["api", "cgit.css", "favicon.ico", "robots.txt", "info", "git-upload-pack", "git-receive-pack"]);
const CACHE_TTL = 60;

/** What a request is asking to do, from the repository's point of view. */
export type AuthOp = "read" | "write" | "admin";

export interface AuthContext<E extends Env = Env> {
  repo: string;
  /** read: pages, clones, fetches, the content API; write: git push; admin: config/gc/delete */
  op: AuthOp;
  /** the repository's private flag (false for a repository that does not exist yet) */
  private: boolean;
  /** HTTP Basic credentials on the request, if any */
  credentials: { user: string; pass: string } | null;
  /** the live incoming request: headers and URL only — do NOT read its body,
   * which is consumed downstream (a hook that drains it breaks every push) */
  request: Request;
  env: E;
}

export interface RefUpdate {
  ref: string;
  /** all-zeros for a created ref */
  old: string;
  /** all-zeros for a deleted ref */
  new: string;
}

export interface PushEvent {
  repo: string;
  /** the ref updates this push actually applied (rejected commands excluded) */
  updates: RefUpdate[];
  /** unix millis of the newest committer date after the push */
  commitTime: number;
}

export interface DurableGitOptions<E extends Env = Env> {
  /**
   * Gate every repository-scoped request. Return true to allow, false for the
   * default 401 Basic challenge, or a Response to send verbatim (a custom
   * challenge, a redirect to your login page). The default implementation is
   * the stock token check: reads of public repositories are open; writes,
   * admin operations, and anything on a private repository require a
   * GIT_TOKEN/GIT_TOKENS match, with per-IP failure rate limiting.
   */
  authorize?: (ctx: AuthContext<E>) => boolean | Response | Promise<boolean | Response>;
  /**
   * Fired after a push applies at least one ref update, off the response path
   * (via waitUntil), so a slow or throwing hook never fails the push.
   */
  onPush?: (event: PushEvent, env: E) => void | Promise<void>;
  /**
   * false runs dgit headless: the git protocol, admin endpoints, and the JSON
   * API stay; every page (index and repo UI) 404s, so a wrapping Worker can
   * own the whole frontend. Default true.
   */
  ui?: boolean;
  /**
   * access-control-allow-origin for the JSON API (e.g. "*"), so a
   * cross-origin UI can call it from the browser; preflights are answered.
   */
  cors?: string;
  /**
   * true routes every repository as <owner>/<name> (GitHub-style, exactly two
   * segments); the combined name is the repository name everywhere — hooks,
   * the registry, the API, RPC (env.REPO.getByName("owner/name")). Default
   * false: flat single-segment names.
   */
  namespaces?: boolean;
}

function tokens(env: Env): string[] {
  const list = [env.GIT_TOKEN ?? "", ...(env.GIT_TOKENS ?? "").split(",")];
  return list.map((t) => t.trim()).filter(Boolean);
}

function unauthorized(): Response {
  return new Response("auth required\n", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="dgit"' },
  });
}

function tooManyRequests(retryAfterMs: number): Response {
  return new Response("too many failed attempts\n", {
    status: 429,
    headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) },
  });
}

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Fixed-length SHA-256 digests, so this leaks nothing about input length. */
function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Timing-safe string comparison for authorize hooks. `credentials.pass ===
 * secret` leaks the match length through timing; compare through this instead.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  return digestsEqual(await digest(a), await digest(b));
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function parseBasic(req: Request): { user: string; pass: string } | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return { user: decoded, pass: "" };
    return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_MAX_IPS = 5000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function pruneAuthFailures(now: number): void {
  if (authFailures.size <= RATE_LIMIT_MAX_IPS) return;
  for (const [ip, e] of authFailures) {
    if (e.resetAt <= now) authFailures.delete(ip);
  }
  while (authFailures.size > RATE_LIMIT_MAX_IPS) {
    const oldest = authFailures.keys().next().value;
    if (oldest === undefined) break;
    authFailures.delete(oldest);
  }
}

function rateLimited(ip: string): number | null {
  const e = authFailures.get(ip);
  if (!e || e.resetAt <= Date.now()) return null;
  return e.count >= RATE_LIMIT_MAX ? e.resetAt - Date.now() : null;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const e = authFailures.get(ip);
  if (!e || e.resetAt <= now) {
    authFailures.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    e.count++;
  }
  pruneAuthFailures(now);
}

/** The default authorize: HTTP Basic where the password is one of the configured tokens. */
async function tokenAuthorize(ctx: AuthContext): Promise<boolean | Response> {
  if (ctx.op === "read" && !ctx.private) return true;
  const valid = tokens(ctx.env);
  if (!valid.length) {
    return new Response("access is disabled: set the GIT_TOKEN secret\n", { status: 403 });
  }
  const header = ctx.request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return unauthorized();

  const ip = clientIp(ctx.request);
  const retryMs = rateLimited(ip);
  if (retryMs !== null) return tooManyRequests(retryMs);

  // a Basic header that failed to decode is a failed attempt, same as a wrong
  // password — otherwise malformed headers probe the endpoint rate-limit-free
  if (!ctx.credentials) {
    recordAuthFailure(ip);
    return unauthorized();
  }

  const passDigest = await digest(ctx.credentials.pass);
  let ok = false;
  for (const v of valid) ok = digestsEqual(passDigest, await digest(v)) || ok;
  if (!ok) {
    recordAuthFailure(ip);
    return unauthorized();
  }
  return true;
}

function siteBase(env: Env) {
  return {
    site: env.SITE_NAME ?? "dgit",
    siteDesc: env.SITE_DESC ?? "",
    title: env.SITE_NAME ?? "dgit",
    sub: env.SITE_DESC ?? "",
    tab: "index",
  };
}

async function indexPage(env: Env): Promise<Response> {
  const registry = env.REGISTRY.getByName("registry");
  const repos = await registry.list();
  let rows = "";
  for (const r of repos) {
    rows +=
      `<tr><td><a href='/${repoUrl(r.name)}/'>${esc(r.name)}</a></td>` +
      `<td>${esc(r.desc || "[no description]")}</td>` +
      `<td>${esc(r.owner || env.SITE_OWNER || "")}</td>` +
      `<td>${age(Math.floor(r.idle / 1000))}</td></tr>`;
  }
  const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Name</th><th class='left'>Description</th><th class='left'>Owner</th><th class='left'>Updated</th></tr>
${rows || "<tr class='nohover'><td colspan='4'>no repositories yet &mdash; create one by pushing: <code>git push https://&lt;this-host&gt;/myrepo.git main</code></td></tr>"}
</table>`;
  return htmlResponse(layout({ ...siteBase(env), body }));
}

/**
 * Per-isolate memo of registry lookups. Without it every page view — cache
 * hit or not — funnels through the single Registry DO, which becomes the
 * global bottleneck under a traffic spike. Staleness window is small and
 * only affects metadata (descriptions, versions, the private flag). Bounded
 * and short-TTL'd on misses so enumerating random repo names can't grow it
 * unbounded.
 */
const infoMemo = new Map<string, { at: number; info: RepoInfo | null }>();
const INFO_TTL_MS = 20_000;
const INFO_NEG_TTL_MS = 2_000;
const INFO_MEMO_MAX = 5000;

function pruneInfoMemo(): void {
  while (infoMemo.size > INFO_MEMO_MAX) {
    const oldest = infoMemo.keys().next().value;
    if (oldest === undefined) break;
    infoMemo.delete(oldest);
  }
}

async function repoInfo(env: Env, repo: string, fresh: boolean): Promise<RepoInfo | null> {
  const hit = infoMemo.get(repo);
  if (!fresh && hit && Date.now() - hit.at < (hit.info ? INFO_TTL_MS : INFO_NEG_TTL_MS)) return hit.info;
  const info = await env.REGISTRY.getByName("registry").get(repo);
  infoMemo.set(repo, { at: Date.now(), info });
  pruneInfoMemo();
  return info;
}

/** Cache API is a Cloudflare-only surface; celld has none, so feature-detect. */
function pageCache(): Cache | null {
  try {
    // eslint-disable-next-line no-undef
    return typeof caches !== "undefined" && (caches as unknown as { default?: Cache }).default
      ? (caches as unknown as { default: Cache }).default
      : null;
  } catch {
    return null;
  }
}

/**
 * R2 full-clone fast path, served entirely from the Worker so the DO is never
 * contacted for bytes (this is the read-offload that avoids the workerd
 * DO->response stall on large packs). Detects a true full clone from the tiny
 * negotiation body — wants, no haves, `done`, not shallow/deepen, side-band-64k
 * — then asks the DO for the versioned key WITH its read lease
 * (`planCloneStream` — probe + lease registration are one DO transaction,
 * SPEC-0011 §3.1) and streams the stored raw pack from R2 with on-the-fly
 * side-band framing. The re-framing loop renews the lease INLINE before each
 * R2 segment (§3.3: the Worker paces the stream, so a slow renewal
 * back-pressures the client; a rejected/expired renewal terminates the
 * response — never a false success) and releases it when the last R2 read
 * completes (§3.4 — not the HTTP response lifetime). Returns null (a miss, a
 * partial/shallow fetch, or any failure) to fall through to the normal DO
 * clone path. Callers MUST invoke this only after the auth gate, so a private
 * repo never streams R2 bytes to an anonymous client.
 */
async function serveCloneFromR2(
  env: Env,
  repo: string,
  body: Uint8Array,
  stub: DurableObjectStub<RepoCell>
): Promise<Response | null> {
  // the ONE pack bucket since the SPEC-0001a §3 Step 3 unification: the clone
  // cache lives under repos/<storage_key>/clone-cache/ in REPO_PACKS
  const bucket = env.REPO_PACKS;
  if (!bucket) return null;
  const req = parseUploadRequest(body);
  // G3 (cache unreachability): a request carrying unsupported-but-semantics-
  // changing fetch arguments (deepen-since/deepen-not/deepen-relative/filter,
  // unknowns) must never reach the full-clone cache probe — the parse verdict
  // short-circuits BEFORE the fullClone predicate and the planCloneStream RPC,
  // and the DO's uploadPack renders the protocol-shaped ERR instead.
  if (req.badArgument) return null;
  const fullClone =
    req.wants.length > 0 &&
    req.wants.every(isOid) &&
    req.haves.length === 0 &&
    req.done &&
    req.deepen.kind === "none" &&
    req.clientShallows.length === 0 &&
    (req.command === "fetch" || req.caps.has("side-band-64k"));
  if (!fullClone) return null;
  let plan: PlanCloneStreamResult;
  try {
    plan = await stub.planCloneStream(repo, req.wants);
  } catch {
    return null;
  }
  if (plan.tag !== "leased") return null;
  // release best-effort: every no-stream exit below must not strand the lease
  // past its TTL (the sweep is the backstop, but why wait)
  const abandon = () => stub.releaseReadLease(plan.planId).catch(() => {});
  let obj: R2ObjectBody | null;
  try {
    obj = await bucket.get(plan.key);
  } catch {
    await abandon();
    return null;
  }
  if (!obj) {
    await abandon();
    return null;
  }
  const objects = parseInt(obj.customMetadata?.objects ?? "", 10);
  if (!Number.isFinite(objects)) {
    await abandon();
    return null;
  }
  // §4.2 fast path: ONE long-lived GET under a whole-stream lease. The guard
  // closure rides the re-framing loop (streamingCloneResponse): renew inline
  // before each segment, release on last read / error / cancel. An RPC throw
  // inside renew() is rejection-class — the loop errors the stream either way.
  return streamingCloneResponse(obj.body, objects, req.caps.has("no-progress"), req.command === "fetch", {
    planId: plan.planId,
    expiresAt: plan.expiresAt,
    renew: () => stub.renewAndAuthorizeRead(plan.planId, plan.key, null),
    release: () => stub.releaseReadLease(plan.planId),
  });
}

function withCors(res: Response, origin: string | undefined): Response {
  if (origin) res.headers.set("access-control-allow-origin", origin);
  return res;
}

function corsPreflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "authorization",
      "access-control-max-age": "86400",
    },
  });
}

// ---- receive data plane (SPEC-0001a §3 Steps 1-2) ---------------------------
//
// Pack bytes never pass through the DO: this side parses ONLY the pkt-line
// command section, opens a receive lease, streams the pack remainder straight
// into R2 staging (FixedLengthStream when Content-Length is known, 16 MiB
// multipart parts otherwise), scans + delta-resolves the staging object with
// ONE streaming GET (per-entry CRC-32, inflate bounds, chain/cycle caps),
// streams index rows to the DO in bounded batches (putIndexRows), resolves
// thin-pack bases through lookupObjects, emits idx v2 byte-equivalent to
// `git index-pack`, copies staging → packs/ BEFORE finalize (so a crash in
// between leaves an unreferenced packs/ object the orphan sweep reclaims —
// never a committed ref pointing at a missing object), then calls
// finalizeReceive and renders report-status exactly as the DO path did.

interface ParsedPush {
  commands: PushCommand[];
  caps: string[];
  /** pack bytes already read off the body (possibly all of it, e.g. gzipped) */
  head: Uint8Array;
  /** live body reader while the pack is still streaming; null when buffered */
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** remaining byte count when known (Content-Length minus consumed), else null */
  hint: number | null;
}

/** Strict 4-hex pkt-line length (PktParser rules, SPEC-0001 §7): parseInt-style
 * leniency would let "  12" or "001g" frame a bogus length and desync the stream. */
function hex4(buf: Uint8Array, pos: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[pos + i];
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
    else throw new Error("bad pkt-line length");
    n = (n << 4) | d;
  }
  return n;
}

/**
 * Read the pkt-line command section of a receive-pack request. Only this small
 * section is buffered; everything after the flush-pkt is the pack and stays a
 * stream. A gzipped body (small pushes only) is inflated once under the push
 * budget, exactly as the pre-split DO path did.
 */
async function parsePushRequest(req: Request, maxBytes: number): Promise<ParsedPush> {
  let bufferedAll: Uint8Array | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let buf: Uint8Array;
  if (req.headers.get("content-encoding")?.includes("gzip")) {
    // only small pushes arrive gzipped, and the inflate is budgeted: a
    // zlib bomb can no more exceed the push cap than a plain body can
    bufferedAll = gunzipLimited(new Uint8Array(await req.arrayBuffer()), maxBytes);
    buf = bufferedAll;
  } else {
    reader = (req.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>) ?? null;
    buf = new Uint8Array(0);
  }

  let pos = 0;
  const need = async (n: number): Promise<boolean> => {
    while (buf.length - pos < n) {
      if (!reader) return false;
      const { done, value } = await reader.read();
      if (done) return false;
      if (value?.length) buf = concat([buf, value]);
    }
    return true;
  };
  for (;;) {
    if (!(await need(4))) break;
    const len = hex4(buf, pos);
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len < 4) throw new Error("bad pkt-line in push request");
    if (!(await need(len))) throw new Error("truncated push request");
    pos += len;
  }
  const { commands, caps } = parsePushCommands(buf.subarray(0, pos));

  // Peek until at least one pack byte is in hand (or the body ends): a
  // deletes-only push carries no pack at all, and the known-length staging
  // path needs the consumed count to include every byte already read.
  let head = buf.subarray(pos);
  if (reader) {
    while (head.length === 0) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        buf = concat([buf, value]);
        head = buf.subarray(pos);
      }
    }
  }

  let hint: number | null = null;
  if (bufferedAll) hint = bufferedAll.length - pos;
  else {
    const declared = parseInt(req.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared)) {
      // the pack remainder is everything after the command section: bytes
      // over-read into `buf` beyond `pos` belong to the pack and are staged
      // verbatim, so only the section counts against the declared length
      hint = Math.max(declared - pos, 0);
    }
  }
  return { commands, caps, head, reader, hint };
}

interface StagedPack {
  packSha1: string;
  packBytes: number;
}

/**
 * Stream the pack remainder into the R2 staging object while hashing it.
 * Known length → a single R2 PUT over a FixedLengthStream (the runtime's
 * length-delimited body: a short or lying body errors instead of hanging);
 * chunked → 16 MiB multipart parts via MultipartCapture (moved unchanged from
 * the DO's ingest). The SHA-1 trailer is verified through a 20-byte sliding
 * window before the object is declared complete.
 */
async function stagePack(
  bucket: R2Bucket,
  stagingKey: string,
  push: ParsedPush,
  maxBytes: number,
  sideband: boolean,
  emit: (chunk: Uint8Array) => void,
  metrics: { stagingPuts: number; stagingParts: number }
): Promise<StagedPack> {
  const sha = new Sha1();
  let tail = new Uint8Array(0); // rolling 20-byte lookbehind (the trailer)
  let total = 0;
  let lastLogged = 0;
  const absorb = (data: Uint8Array) => {
    total += data.length;
    if (total > maxBytes) throw new Error("pack exceeds maximum push size");
    if (total - lastLogged >= 64 * 1024 * 1024) {
      lastLogged = total;
      const msg = `Receiving pack: ${Math.round(total / 1048576)}MB\n`;
      if (sideband) for (const f of sidebandFrames(2, te.encode(msg))) emit(f);
    }
    const joined = tail.length ? concat([tail, data]) : data;
    if (joined.length > 20) {
      sha.update(joined.subarray(0, joined.length - 20));
      tail = joined.slice(joined.length - 20);
    } else {
      tail = joined.slice();
    }
  };

  if (!push.reader) {
    // fully buffered (gzipped): hash the remainder, then one plain PUT
    if (push.head.length) absorb(push.head);
    if (total) {
      metrics.stagingPuts++;
      await bucket.put(stagingKey, push.head);
    }
  } else if (push.hint !== null) {
    // known length: R2 PUT over a FixedLengthStream
    metrics.stagingPuts++;
    const fixed = new FixedLengthStream(push.hint);
    const writer = fixed.writable.getWriter();
    const put = bucket.put(stagingKey, fixed.readable);
    try {
      if (push.head.length) {
        absorb(push.head);
        await writer.write(push.head);
      }
      for (;;) {
        const { done, value } = await push.reader.read();
        if (done) break;
        if (value?.length) {
          absorb(value);
          await writer.write(value);
        }
      }
      await writer.close();
    } catch (err) {
      try {
        await writer.abort(err);
      } catch {
        // already errored by the short write
      }
      throw err;
    }
    await put;
  } else {
    // chunked: 16 MiB multipart parts
    const mp = await beginRawMultipart(bucket, stagingKey);
    if (!mp) throw new Error("pack staging unavailable: R2 refused the multipart upload");
    const uploadPart = mp.uploadPart;
    mp.uploadPart = (data) => {
      metrics.stagingParts++;
      return uploadPart(data);
    };
    const capture = new MultipartCapture(mp);
    try {
      if (push.head.length) {
        absorb(push.head);
        capture.push(push.head);
        await capture.drain();
        if (capture.aborted) throw new Error("pack upload to R2 failed");
      }
      for (;;) {
        const { done, value } = await push.reader.read();
        if (done) break;
        if (value?.length) {
          absorb(value);
          capture.push(value);
          await capture.drain();
          if (capture.aborted) throw new Error("pack upload to R2 failed");
        }
      }
      await capture.finish();
      if (capture.aborted) throw new Error("pack upload to R2 failed");
    } catch (err) {
      await capture.abort();
      throw err;
    }
  }

  // trailer verification BEFORE the staging object is treated as complete —
  // identical wording to the pre-split path's phase-A checks
  if (total < 32) throw new Error("pack too small");
  const packSha1 = toHex(sha.digest());
  if (toHex(tail) !== packSha1) throw new Error("pack checksum mismatch");
  return { packSha1, packBytes: total };
}

// copyObject (staging → packs/, and the fork replication's pack copies) is
// shared with src/fork/replicate.ts — imported at the top; see its doc there
// for the FixedLengthStream contract and the buffered host fallback.

/**
 * POST /git-receive-pack — the Worker-side receive flow. Auth (write) has
 * already run. Wire behavior is unchanged end to end: 503 Retry-After when
 * another push holds the lease (T7), report-status with per-command ok/ng
 * lines otherwise, byte-identical to the pre-split DO rendering.
 */
async function receivePack<E extends Env>(
  req: Request,
  env: E,
  repo: string,
  ctx: ExecutionContext,
  registry: DurableObjectStub<Registry>,
  options: DurableGitOptions<E>
): Promise<Response> {
  const bucket = env.REPO_PACKS;
  if (!bucket) {
    return new Response("error: git push requires an R2 bucket binding (REPO_PACKS)\n", { status: 500 });
  }
  const maxBytes = (parseInt(env.MAX_PUSH_MB ?? "", 10) || DEFAULT_MAX_PUSH_MB) * 1024 * 1024;
  // refuse an over-sized push from its declared length: buffering it first
  // and checking after is exactly the memory the limit exists to bound
  if (overDeclaredLength(req, maxBytes)) return tooLargeResponse(maxBytes);

  const stub = env.REPO.getByName(repo);
  const chunks: Uint8Array[] = [];
  const emit = (chunk: Uint8Array) => chunks.push(chunk);
  // subrequest accounting for the T3 checkpoint (SPEC-0001 §6): every R2
  // operation and DO RPC the receive path spends, logged at the end
  const metrics = {
    stagingPuts: 0,
    stagingParts: 0,
    scanGets: 0,
    rangeGets: 0,
    idxPuts: 0,
    copies: 0,
    rowRpcs: 0,
    lookupRpcs: 0,
    lookupOids: 0,
  };
  let leaseToken: string | null = null;
  try {
    // 1. the command section only — the pack is never parsed here
    const push = await parsePushRequest(req, maxBytes);
    const sideband = push.caps.includes("side-band-64k");
    const wantStatus = push.caps.includes("report-status");

    // 2. open the lease (refname validation happens before any byte streams).
    // The x-storage-key header (SPEC-0001a §3 Step 3) carries the D1-minted
    // immutable storage key when the caller knows it (cf-gitea's git-http
    // gate sets it from the repositories row); absent, the DO falls back to
    // its persisted meta.storage_key / meta.repo — see control-plane.ts.
    const begin = await stub.beginReceive({
      commands: push.commands,
      capabilities: push.caps,
      packBytesHint: push.hint,
      storageKey: req.headers.get("x-storage-key"),
    });
    if (begin.tag === "busy") {
      return new Response("busy: too many concurrent pushes, retry shortly\n", {
        status: 503,
        headers: { "retry-after": String(begin.retryAfterSeconds) },
      });
    }
    if (begin.tag === "importing") {
      // a fork catalog import is replicating into this repo (SPEC-0001b §5.3):
      // the push cannot be served until it finalizes — a distinctly-worded 503
      // with a longer retry hint than the lease-busy case
      return new Response("busy: repository is being created (fork import in progress), retry shortly\n", {
        status: 503,
        headers: { "retry-after": "30" },
      });
    }
    if (begin.tag === "rejected") {
      const status = renderStatus(asCommandResults(begin.results), null, sideband);
      if (wantStatus) emit(status);
      return new Response(concat(chunks) as unknown as BodyInit, {
        headers: receiveHeaders(),
      });
    }
    leaseToken = begin.leaseToken;

    // 3. stage the pack straight into R2 (the DO never sees these bytes). A
    // deletes-only push carries no pack bytes and skips straight to finalize.
    let unpackError: string | null = null;
    let staged: StagedPack | null = null;
    if (push.head.length > 0) {
      try {
        staged = await stagePack(bucket, begin.stagingKey, push, maxBytes, sideband, emit, metrics);
      } catch (err) {
        unpackError = err instanceof Error ? err.message : String(err);
        console.log(`[receive ${repo}] staging failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        try {
          await push.reader?.cancel();
        } catch {
          // client may already be gone
        }
      }
    }

    // 4. scan + delta resolution + idx v2 (SPEC-0001a §3 Step 2): the Worker
    // reads the staging object directly, resolves every delta, streams index
    // rows to the DO in bounded batches, and emits the idx — the DO never
    // touches pack bytes.
    let pack: FinalizedPack = NO_PACK;
    let packIncomplete = false;
    if (staged && !unpackError) {
      // final keys via the single builder (r2keys.ts): packs/<pack-<sha1>>.pack
      // + the idx v2 sidecar, both under the lease's storage key
      const name = packName(staged.packSha1);
      const packKey = packR2Key(begin.storageKey, name);
      const idxKey = idxR2Key(begin.storageKey, name);
      try {
        const progress = (msg: string) => {
          if (sideband) for (const f of sidebandFrames(2, te.encode(msg))) emit(f);
        };
        // 4a. one streaming GET of the staging object drives the whole walk;
        // rows stream out through putIndexRows as deltas resolve
        const stagedObj = await bucket.get(begin.stagingKey);
        if (!stagedObj) throw new Error("staged pack object missing from R2");
        if (stagedObj.size !== staged.packBytes) throw new Error("staged pack size mismatch");
        metrics.scanGets++;
        const collisionDetect = env.SHA1DC === "1";
        const cacheMb = parseInt(env.INGEST_CACHE_MB ?? "", 10) || 16;
        const resolver = new DeltaResolver(
          {
            selfPackKey: begin.stagingKey,
            lookupObjects: async (oids) => {
              metrics.lookupRpcs++;
              metrics.lookupOids += oids.length;
              return stub.lookupObjects(begin.leaseToken, oids);
            },
            readEntryBytes: async (key, off, len) => {
              metrics.rangeGets++;
              const region = await bucket.get(key, { range: { offset: off, length: len } });
              if (!region) throw new Error(`pack object missing from R2: ${key}`);
              return new Uint8Array(await region.arrayBuffer());
            },
            putRows: async (rows) => {
              metrics.rowRpcs++;
              return stub.putIndexRows(begin.leaseToken, name, rows);
            },
          },
          {
            cacheBytes: Math.max(1, cacheMb) * 1024 * 1024,
            collisionDetect,
            onProgress: progress,
          }
        );
        await walkPack(
          { body: stagedObj.body, size: stagedObj.size },
          (entry) => resolver.onEntry(entry),
          { collisionDetect, onHeader: (count) => resolver.init(count), onProgress: progress }
        );
        const resolved = await resolver.finish();
        packIncomplete = resolved.incomplete;
        if (resolved.incomplete) {
          console.log(`[receive ${repo}] connectivity check failed: missing ${resolved.firstMissing}`);
        }

        // 4b. idx v2 streamed to its final key. The length is exact up front
        // (fixed header + fanout + 28N + large offsets + two checksums), so
        // the PUT rides a FixedLengthStream and a short write fails loudly.
        let largeOffsets = 0;
        for (let i = 0; i < resolved.oidEntry.length; i++) {
          if (resolved.entryOffsets[resolved.oidEntry[i]] >= 0x80000000) largeOffsets++;
        }
        const expectedIdx = 1072 + 28 * resolved.objects + 8 * largeOffsets;
        const fixed = new FixedLengthStream(expectedIdx);
        const put = bucket.put(idxKey, fixed.readable);
        const writer = fixed.writable.getWriter();
        let idxBytes: number;
        try {
          idxBytes = await writeIdx((chunk) => writer.write(chunk), {
            oids: resolved.oids,
            oidEntry: resolved.oidEntry,
            entryCrcs: resolved.entryCrcs,
            entryOffsets: resolved.entryOffsets,
            packSha1: staged.packSha1,
          });
          await writer.close();
        } catch (err) {
          try {
            await writer.abort(err);
          } catch {
            // already errored by the short write
          }
          try {
            await put;
          } catch {
            // the destination rejects alongside the failed write
          }
          throw err;
        }
        await put;
        metrics.idxPuts++;
        if (idxBytes !== expectedIdx) {
          throw new Error(`idx length mismatch: wrote ${idxBytes}, expected ${expectedIdx}`);
        }

        // 4c. copy staging → packs/ BEFORE finalize (crash ordering, see header)
        await copyObject(bucket, begin.stagingKey, packKey);
        metrics.copies++;
        pack = {
          packKey,
          packSha1: staged.packSha1,
          packBytes: staged.packBytes,
          objectCount: resolved.objects,
          idxBytes,
        };
      } catch (err) {
        // scan/resolution/idx failures surface verbatim in report-status
        // ("unpack <msg>"); rows already pushed are crash debris the DO's
        // orphan sweep reclaims (their pack never reaches pack_catalog)
        unpackError = err instanceof Error ? err.message : String(err);
        console.log(`[receive ${repo}] index failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }

    // 5. finalize: the DO re-checks per-command CAS and commits refs +
    // refs_version in one transaction (the pack is already indexed)
    const fin = await stub.finalizeReceive({
      leaseToken: begin.leaseToken,
      expectedRefsVersion: begin.refsVersion,
      commands: push.commands,
      newTips: push.commands.map((c) => (c.next === ZERO_OID ? null : c.next)),
      pack,
      unpackError,
      packIncomplete,
    });
    leaseToken = null; // finalize decided the lease; the release below is a no-op sweep
    if (fin.tag === "lease_mismatch") {
      return new Response("error: receive lease lost (expired or already finalized); retry the push\n", {
        status: 500,
      });
    }

    // 6. report-status — byte-identical to the pre-split DO rendering
    if (wantStatus) emit(renderStatus(asCommandResults(fin.results), unpackError, sideband));

    const doRpcs = 2 + metrics.rowRpcs + metrics.lookupRpcs;
    const subrequests =
      metrics.stagingPuts +
      metrics.stagingParts +
      metrics.scanGets +
      metrics.rangeGets +
      metrics.idxPuts +
      metrics.copies * 2 +
      doRpcs;
    console.log(
      `[receive ${repo}] subrequests: total=${subrequests}` +
        ` staging=${metrics.stagingPuts + metrics.stagingParts}` +
        ` scanGets=${metrics.scanGets} rangeGets=${metrics.rangeGets}` +
        ` idxPuts=${metrics.idxPuts} copies=${metrics.copies}` +
        ` rows=${metrics.rowRpcs} lookups=${metrics.lookupRpcs}/${metrics.lookupOids}` +
        ` doRpcs=${doRpcs}`
    );

    // bookkeeping after an applied push (was keyed on the x-changed header)
    if (fin.tag === "committed" && fin.updates.length > 0) {
      const idle = fin.commitTime || Date.now();
      try {
        // a registry hiccup must not fail an already-applied push; next push heals
        await registry.upsert(repo, idle);
      } catch {
        // registry deferred
      }
      if (options.onPush) {
        const event: PushEvent = { repo, updates: fin.updates, commitTime: idle };
        ctx.waitUntil(
          Promise.resolve(options.onPush(event, env)).catch((err) => {
            console.log(`[onPush ${repo}] hook failed: ${err instanceof Error ? err.message : String(err)}`);
          })
        );
      }
    }
    return new Response(concat(chunks) as unknown as BodyInit, { headers: receiveHeaders() });
  } catch (err) {
    console.log(`[receive ${repo}] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    if (leaseToken) {
      // abandon the lease and sweep the staging object; safe even when the
      // failure raced a finalize (idempotent-on-lease_mismatch)
      try {
        await stub.releaseReceive({ leaseToken, sweep: true });
      } catch {
        // best effort: the lease-expiry sweep is the backstop
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("exceeds maximum size")) return tooLargeResponse(maxBytes);
    return new Response(`error: ${msg}\n`, { status: 500 });
  }
}

function receiveHeaders(): Record<string, string> {
  return {
    "content-type": "application/x-git-receive-pack-result",
    "cache-control": "no-cache",
  };
}

/** The returned handler: a valid Worker default export, with `fetch` non-optional
 * so it can also be delegated to from a wrapping router. */
export interface DurableGitHandler<E extends Env = Env> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
}

/**
 * Parse a repository route: /<name>[.git][/sub] flat, /<owner>/<name>[.git][/sub]
 * namespaced. null for anything that is not a well-formed repository path
 * (bad or reserved names, undecodable escapes).
 */
function repoPath(
  pattern: URLPattern,
  namespaced: boolean,
  path: string
): { repo: string; sub: string } | null {
  const m = pattern.exec({ pathname: path });
  if (!m) return null;
  const g = m.pathname.groups;
  const segs: string[] = [];
  for (const raw of namespaced ? [g.owner, g.name] : [g.name]) {
    if (!raw) return null;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!REPO_NAME.test(seg)) return null;
    segs.push(seg);
  }
  if (RESERVED.has(segs[0])) return null;
  return { repo: segs.join("/"), sub: g["0"] ? `/${g["0"]}` : "/" };
}

/** What a repository sub-path is asking for, and the authorize op it implies. */
function classify(sub: string, method: string, url: URL): {
  op: AuthOp;
  isReceive: boolean;
  isProtocol: boolean;
  isApi: boolean;
  isAdmin: boolean;
} {
  const isReceive =
    sub === "/git-receive-pack" ||
    (sub === "/info/refs" && url.searchParams.get("service") === "git-receive-pack");
  const isProtocol = isReceive || sub === "/git-upload-pack" || sub === "/info/refs";
  const isApi = sub.startsWith("/api/");
  const isAdmin =
    ((sub === "/config" || sub === "/description") && method === "PUT") ||
    (sub === "/gc" && method === "POST") ||
    ((sub === "/" || sub === "") && method === "DELETE");
  return { op: isReceive ? "write" : isAdmin ? "admin" : "read", isReceive, isProtocol, isApi, isAdmin };
}

export function createDurableGit<E extends Env = Env>(options: DurableGitOptions<E> = {}): DurableGitHandler<E> {
  const authorize = options.authorize ?? tokenAuthorize;
  const ui = options.ui !== false;
  const namespaced = !!options.namespaces;
  const repoRoute = new URLPattern({
    pathname: namespaced ? "/:owner/:name{.git}?{/*}?" : "/:name{.git}?{/*}?",
  });
  return {
    async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // site-level JSON ("api" is a reserved repository name)
      if (path.startsWith("/api/")) {
        if (options.cors && req.method === "OPTIONS") return corsPreflight(options.cors);
        const json = (data: unknown, status = 200) =>
          withCors(Response.json(data, { status, headers: { "x-content-type-options": "nosniff" } }), options.cors);
        if (path === "/api/repos" && req.method === "GET") {
          const ns = url.searchParams.get("owner") ?? undefined;
          const repos = await env.REGISTRY.getByName("registry").list(1000, ns);
          return json({
            repos: repos.map((r) => ({ name: r.name, description: r.desc, owner: r.owner, section: r.section, idle: r.idle })),
          });
        }
        return json({ error: "not found" }, 404);
      }

      if (!ui && (path === "/" || path === "" || path === "/cgit.css" || path === "/robots.txt" || path === "/favicon.ico")) {
        return new Response("not found\n", { status: 404 });
      }

      if (path === "/" || path === "") {
        // the index is the front door under load: cache it briefly at the edge
        const cache = pageCache();
        if (cache) {
          const key = new Request(`${url.origin}/?__index`, { method: "GET" });
          const hit = await cache.match(key);
          if (hit) return hit;
          const res = await indexPage(env);
          const toCache = new Response(res.clone().body, res);
          toCache.headers.set("cache-control", "public, max-age=30");
          ctx.waitUntil(cache.put(key, toCache));
          return res;
        }
        return indexPage(env);
      }
      if (path === "/cgit.css") {
        return new Response(CSS, { headers: { "content-type": "text/css", "cache-control": "public, max-age=3600" } });
      }
      if (path === "/robots.txt") {
        return new Response(
          "User-agent: *\nDisallow: /*/snapshot/\nDisallow: /*/blame/\nDisallow: /*/stats/\nDisallow: /*/diff/\nDisallow: /*/rawdiff/\nDisallow: /*/patch/\n",
          { headers: { "content-type": "text/plain" } }
        );
      }
      if (path === "/favicon.ico") {
        return new Response("not found\n", { status: 404 });
      }

      const parsed = repoPath(repoRoute, namespaced, path);
      if (!parsed) {
        return ui
          ? errorPage(siteBase(env), `no such repository: ${path}`, 404)
          : new Response("not found\n", { status: 404 });
      }
      const { repo, sub } = parsed;
      const { op, isReceive, isProtocol, isApi, isAdmin } = classify(sub, req.method, url);

      const registry = env.REGISTRY.getByName("registry");

      // headless: pages 404 before touching the registry or the cell; a CORS
      // preflight (credential-less by spec) is answered before the auth gate
      if (!ui && !isProtocol && !isApi && !isAdmin) {
        return new Response("not found\n", { status: 404 });
      }
      if (options.cors && isApi && req.method === "OPTIONS") {
        return corsPreflight(options.cors);
      }

      // mutations read the registry fresh; page views tolerate a short memo
      const info: RepoInfo | null = await repoInfo(env, repo, isReceive || isAdmin);

      // every repo-scoped request passes through authorize; the default hook
      // waves reads of public repositories straight through
      const decision = await authorize({
        repo,
        op,
        private: !!info?.priv,
        credentials: parseBasic(req),
        request: req,
        env,
      });
      if (decision instanceof Response) return decision;
      if (!decision) return unauthorized();

      // only pushes and admin ops may touch repos that don't exist yet
      if (!info && !isReceive && !isAdmin) {
        if (isApi) return Response.json({ error: `repository not found: ${repo}` }, { status: 404 });
        if (isProtocol) return new Response(`repository not found: ${repo}\n`, { status: 404 });
        return errorPage(siteBase(env), `no such repository: ${repo}`, 404);
      }

      // page cache for public repo GET pages (versioned key; skipped on celld)
      const cache = pageCache();
      const cacheable =
        cache !== null &&
        req.method === "GET" &&
        !isProtocol &&
        info !== null &&
        !info.priv &&
        !req.headers.has("authorization");
      let cacheKey: Request | null = null;
      if (cacheable) {
        const keyUrl = new URL(url.toString());
        keyUrl.searchParams.set("__v", String(info!.ver));
        cacheKey = new Request(keyUrl.toString(), { method: "GET" });
        const hit = await cache!.match(cacheKey);
        if (hit) return hit;
      }

      const stub = env.REPO.getByName(repo);
      const doUrl = new URL(req.url);
      doUrl.pathname = sub;

      // The push data plane is Worker-side (SPEC-0001a §3 Step 1): parse the
      // command section, stage the pack into R2, copy it into packs/, then
      // drive the beginReceive/finalizeReceive/releaseReceive lease RPCs.
      // Pack bytes never reach the repository cell. The registry memo is
      // invalidated on return: a create-by-push must be visible to the next
      // request on this isolate immediately.
      if (sub === "/git-receive-pack" && req.method === "POST") {
        const received = await receivePack(req, env, repo, ctx, registry, options);
        if (isReceive || isAdmin) infoMemo.delete(repo); // this isolate sees its own mutations
        return received;
      }

      // The upload-pack body streams through to the repository cell — the
      // Worker only buffers the small negotiation bodies it inspects for the
      // R2 fast path. celld <0.3 re-wrapped a bytes-backed request into a
      // stream-backed one that UTF-8-decoded the whole body (fatal for a
      // binary pack), so this path requires celld >=0.3, where the body
      // decodes lazily (denoland/celld.dev#129) and a local Durable Object
      // call forwards the body as a stream (denoland/celld.dev#156).
      let fwdBody: BodyInit | null = null;
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
        const declared = parseInt(req.headers.get("content-length") ?? "", 10);
        const smallUploadPack =
          sub === "/git-upload-pack" && (!Number.isFinite(declared) || declared <= MAX_UPLOAD_PACK_BYTES);
        if (smallUploadPack) {
          // buffer the tiny negotiation body so a full clone can be served straight
          // from R2 (never touching the DO for bytes); the auth gate above has
          // already run, so a private repo cannot reach this point anonymously.
          const raw = new Uint8Array(await req.arrayBuffer());
          let parsed: Uint8Array = raw;
          if (req.headers.get("content-encoding")?.includes("gzip")) {
            try {
              parsed = gunzipLimited(raw, MAX_UPLOAD_PACK_BYTES);
            } catch {
              parsed = new Uint8Array(0);
            }
          }
          if (env.REPO_PACKS && parsed.length) {
            const hit = await serveCloneFromR2(env, repo, parsed, stub);
            if (hit) return hit;
          }
          fwdBody = raw; // miss: forward the original (still-encoded) bytes to the DO
        } else {
          fwdBody = req.body;
        }
      }
      const fwd = new Request(doUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body: fwdBody,
      });
      fwd.headers.set("x-repo", repo);
      fwd.headers.set("x-host", url.host);
      fwd.headers.set("x-proto", url.protocol.replace(":", ""));
      let res = await stub.fetch(fwd);
      // set before the cache put, so cached copies carry the header too
      if (options.cors && isApi) {
        res = new Response(res.body, res);
        res.headers.set("access-control-allow-origin", options.cors);
      }

      // bookkeeping after successful config mutations. idle is the newest
      // committer date (x-commit-time on the config response — the admin
      // header channel; the push path moved to the finalizeReceive result).
      if (res.ok && (sub === "/config" || sub === "/description") && req.method === "PUT") {
        try {
          const cfg = (await res.clone().json()) as {
            description: string;
            owner: string;
            section: string;
            private: boolean;
          };
          const idle = parseInt(res.headers.get("x-commit-time") ?? "", 10) || Date.now();
          if (!info) await registry.upsert(repo, idle);
          await registry.setConfig(
            repo,
            {
              desc: cfg.description,
              owner: cfg.owner,
              section: cfg.section,
              priv: cfg.private,
            },
            idle
          );
        } catch {
          // non-JSON response; skip registry sync
        }
      }
      if (res.ok && (sub === "/" || sub === "") && req.method === "DELETE") {
        await registry.remove(repo);
      }
      if (isReceive || isAdmin) infoMemo.delete(repo); // this isolate sees its own mutations

      if (cacheable && cacheKey && res.ok && !res.headers.has("set-cookie")) {
        const toCache = new Response(res.clone().body, res);
        toCache.headers.set("cache-control", `public, max-age=${CACHE_TTL}`);
        ctx.waitUntil(cache!.put(cacheKey, toCache));
      }
      return res;
    },
  };
}
