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
import { parseUploadRequest, parsePushCommands, parsePushOptions, renderStatus, sidebandFrames, streamingCloneResponse, ATOMIC_PUSH_FAILED, type CommandResult, type PushCommand } from "./git/protocol";
import {
  streamWorkerWarmFullClone,
  uploadKeepaliveMs,
  UPLOAD_KEEPALIVE_FRAME,
  type PlanWorkerWarmCloneResult,
  type ReadUploadObjectResult,
  type ReadWarmClonePageResult,
  type ReadWarmLoosePageResult,
  type WorkerLooseEntry,
  type WorkerPackedEntry,
  type WorkerUploadPackMeta,
  type WorkerUploadStub,
} from "./upload/stream";
import { isOid, concat, te, toHex, ZERO_OID, Sha1 } from "./git/util";
import { gunzipLimited } from "./git/zlib";
import { MultipartCapture, beginRawMultipart } from "./git/multipart";
import { overDeclaredLength, tooLargeResponse } from "./repo";
import { idxR2Key, packName, packR2Key } from "./git/r2keys";
import {
  asCommandResults,
  NO_PACK,
  resolveReceiveLeaseTtlSeconds,
  type FinalizedPack,
  type PushCommandKind,
  type ReceiveCommandResult,
} from "./control-plane";
import type { RepoCell } from "./repo";
import type { PlanCloneStreamResult } from "./read-leases";
import { DeltaResolver, RANGE_BUDGET, type ResolveResult } from "./receive/delta";
import { walkPack } from "./receive/scan";
import { writeIdx } from "./receive/idx";
import { copyObject } from "./fork/replicate";

export { RepoCell } from "./repo";
export { Registry } from "./registry";
export type { Env } from "./env";
export type { RepoInfo, RepoConfig } from "./registry";
export type { RefsResult, CommitJson, TreeResult, TreeEntryJson, TreeCommitsResult, BlobResult, LogResult, DiffResult, DiffFileJson, BlameResult, BlamePartJson, GrepResult, ActivityStatsResult, ActivityAuthor, ContributorStatsResult, GraphDataResult, GraphRow, GraphEdge, GraphCommitJson, LfsPointerScanResult } from "./repo";
export { TREE_COMMITS_MAX_PATHS, MAX_BLAME_BYTES, MAX_LFS_SCAN_FILES, MAX_LFS_CANDIDATES, MAX_LFS_POINTER_BYTES } from "./repo";
export { MAX_BLAME_LINES } from "./git/blame";
export type { Person } from "./git/objects";
// object serializers (SPEC-0001a §4.1): the Worker-side builders construct the
// canonical bytes that putApiObjects verifies and stores
// the .gitattributes language subset the archive surface consumes (P2-8's
// attr-macro arm): pattern compile + match, export-ignore/export-subst
// resolution, MACRO ATTRIBUTES. Boundary decision:
// docs/research/attr-macro-boundary.md (the matcher is engine-side — this
// package's git-semantics layer — and the worker walk consumes expanded
// rules unchanged).
export {
  createAttrMacros,
  exportIgnoreExcluded,
  exportSubstActive,
  parseGitattributes,
  ruleMatches,
} from "./git/attributes";
export type { AttrMacros, GitattributesRule } from "./git/attributes";
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
  ClassifyReceiveInput,
  ClassifyReceiveResult,
  CommitApiChangeInput,
  CommitApiChangeResult,
  DestroyResult,
  DiffReceiveInput,
  DiffReceiveResult,
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
  PushCommandKind,
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
// the receive lease's configurable TTL (L325): the embedding Worker resolves
// GIT_TIMEOUT_RECEIVE through the resolver and passes beginReceive's
// leaseTtlMs; exported so deployments and tests pin the same clamp/default
export {
  RECEIVE_LEASE_TTL_MAX_MS,
  RECEIVE_LEASE_TTL_MIN_MS,
  RECEIVE_LEASE_TTL_MS,
  clampReceiveLeaseTtlMs,
  resolveReceiveLeaseTtlSeconds,
} from "./control-plane";
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
export {
  streamWorkerWarmFullClone,
  uploadKeepaliveMs,
  UPLOAD_KEEPALIVE_FRAME,
  type PlanWorkerWarmCloneResult,
  type ReadUploadObjectResult,
  type ReadWarmClonePageResult,
  type ReadWarmLoosePageResult,
  type WorkerLooseEntry,
  type WorkerPackedEntry,
  type WorkerUploadPackMeta,
  type WorkerUploadStub,
} from "./upload/stream";

/** an upload-pack negotiation body is wants/haves/caps only — a few hundred KB */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;
/** default push cap when MAX_PUSH_MB is unset, in MiB (matches env.ts docs) */
const DEFAULT_MAX_PUSH_MB = 512;
/** default wall-clock budget for one receive's indexing phase, in ms (matches
 * env.ts GIT_RECEIVE_DEADLINE_MS docs): 10 minutes — strictly inside the
 * default GIT_TIMEOUT_RECEIVE (900s) so a breached deadline releases the
 * lease through the unpack-ng path before the TTL sweep would. */
const RECEIVE_INDEX_DEADLINE_MS = 600_000;

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = new Set(["api", "cgit.css", "favicon.ico", "robots.txt", "info", "git-upload-pack", "git-receive-pack"]);
/**
 * Infrastructure-cell names — rowless engine cells the embedding Worker's
 * git gate serves over git HTTP WITHOUT a D1 repositories row (the wiki
 * sibling's hiding posture: no registry entry, invisible to every listing).
 * `_cargo-index` is upstream Gitea's exact cargo sparse-index mirror
 * repository name (services/packages/cargo/index.go:28-29,
 * `IndexRepositoryName = "_cargo-index"` — the traditional git-protocol
 * mirror cargo's git-URL face clones); the leading underscore keeps it
 * outside the D1 name alphabet (the worker enforces this regex's
 * alphanumeric first char on top of upstream's own name rules, so the name
 * can never collide with a user repository). Admission here is ROUTE parsing
 * only — the registry-existence oracle below still 404s protocol reads of a
 * registry-unknown name until the gate seeds the priv:1 row, exactly the
 * wiki family's contract; the `.wiki` sibling needs no entry here (`x.wiki`
 * already satisfies REPO_NAME).
 */
const INFRA_REPO_NAMES = new Set(["_cargo-index"]);
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
  /**
   * The authenticated pusher, when the embedding Worker resolved one for this
   * receive and passed it on the fetch call (`internal.pusher` — see
   * `PusherIdentity` for why this is a call argument, not a request header).
   * Absent for engine-native receives (no argument passed); consumers must
   * fall back to their own attribution (e.g. the repository owner) and never
   * derive the pusher from client-controlled request data.
   */
  pusherId?: number;
  pusherLogin?: string;
  /**
   * The origin (scheme + authority, e.g. "https://git.example.com") the
   * receive-pack request arrived on — the base for absolute webhook payload
   * URLs. Populated by the engine's own receive path from the live request
   * (`requestOrigin`); absent if a receive path without a parsable http(s)
   * request URL ever fires the hook. The literal request origin, never
   * proxy-header-rewritten; consumers must treat it as client-visible data,
   * not an authenticated value.
   */
  origin?: string;
  /**
   * The push options the client sent with this push (gitprotocol-pack
   * `push-options`: pkt-lines between the command list and the packfile,
   * present when the server advertises `push-options` and the client passed
   * `--push-option`). Verbatim `key=value`-shaped strings, client-visible
   * data; the hook layer's equivalent of upstream Gitea's GIT_PUSH_OPTION_*
   * environment (cmd/hook.go pushOptions()). Absent when the push carried
   * none, so `=== undefined` is the "no options" test.
   */
  pushOptions?: string[];
}

/**
 * One receive-pack command as the `validatePush` hook sees it: the wire
 * command plus the engine-side classification (SPEC-0013 M2). create/delete
 * are wire facts; fast-forward vs force-push is ancestry, classified by the
 * engine over the lease-staged rows (one batched `classifyReceive` RPC per
 * push) — the hook never walks objects ITSELF. A policy that needs the
 * pushed content (the protected-file arms) asks the engine through
 * `ValidatePushContext.changedPaths`, and the DO does the walk.
 */
export interface ClassifiedPushCommand {
  ref: string;
  /** all-zeros for a created ref */
  old: string;
  /** all-zeros for a deleted ref */
  new: string;
  kind: PushCommandKind;
}

/** One per-command verdict of the `validatePush` hook. */
export interface PushVerdict {
  /** report-status ng message when the command must not apply; absent = apply */
  reject?: string;
}

/**
 * The answer of `ValidatePushContext.changedPaths`. `ok` carries the changed
 * paths (repo-relative, case preserved); `truncated: true` means a walk
 * budget ran out and `paths` is only a PREFIX. `unresolved` means the walk
 * could not answer at all (a missing object, no divergence point for a
 * created branch, a lost lease) — it is NEVER "nothing changed". A policy
 * must fail closed on `unresolved`, and on `truncated` unless the prefix
 * already decided it.
 */
export type ChangedPathsVerdict =
  | { tag: "ok"; paths: string[]; truncated: boolean }
  | { tag: "unresolved"; reason: string };

/**
 * The per-call context of a `validatePush` invocation. `pusher` is the
 * embedding Worker's authenticated identity for this receive — the same
 * in-process channel as `PushEvent.pusherId` (never derivable from client
 * request data); absent when none was resolved, which the hook evaluates
 * as not-whitelisted. `pushOptions` carries the client's push options
 * (gitprotocol-pack push-options section) when the push sent any — the
 * policy hook's view of the same data `PushEvent.pushOptions` surfaces
 * after apply.
 *
 * `changedPaths` is the lease-carrying changed-path read (upstream's
 * pre-receive `GetAffectedFiles`, hook_pre_receive.go:210-260): the files one
 * command changes, walked DO-side over the lease-staged rows (the
 * `diffReceive` RPC — an update diffs its two tips, a create diffs from its
 * divergence point). One RPC per call, so a policy asks only for the
 * commands whose rule needs it. The receive flow always supplies it; it is
 * optional in the type for hand-built contexts, and a policy whose file arm
 * is armed must treat its absence as `unresolved`.
 */
export interface ValidatePushContext {
  repo: string;
  pusher?: PusherIdentity;
  pushOptions?: string[];
  changedPaths?: (command: { ref: string; old: string; new: string }) => Promise<ChangedPathsVerdict>;
}

/**
 * The SPEC-0013 M2 per-ref push-policy hook, supplied per receive-pack call
 * (an in-process argument, never a wire-trustable input — the same channel
 * discipline as `pusher`). Invoked after the pack is staged and indexed
 * (classification needs the new tips' ancestry) and BEFORE finalize.
 *
 * Contract: returns one verdict per classified command, INDEX-ALIGNED — a
 * crafted request can send two commands for one ref, so verdicts join by
 * position, never by ref name. `undefined` allows everything; a malformed
 * return (wrong length, non-string reject) fails closed for the whole
 * section; a thrown error fails the whole request closed (500, lease
 * released, staging swept). Rejected commands render as report-status ng
 * with `reject` as the message and never apply; their siblings land.
 */
export type PushValidator = (
  commands: ClassifiedPushCommand[],
  ctx: ValidatePushContext,
) => PushVerdict[] | undefined | Promise<PushVerdict[] | undefined>;

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
    req.filter.kind === "none" && // a filtered clone omits blobs — the cached pack is the FULL object set, never the answer (protocol-v2 fetch=filter)
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

/**
 * Worker-streamed warm full-clone handler (SPEC-0024 M4.0): runs instead of
 * the clone-cache probe when `UPLOAD_PACK_WORKER_STREAM === "true"`, avoiding
 * extra DO RPCs and synchronous inline R2 teeing while serving single-pack
 * passthrough or multi-pack sequential streams directly from R2 with official
 * `0005\x01` sideband keepalives.
 */
async function serveWorkerWarmClone(
  env: Env,
  repo: string,
  body: Uint8Array,
  stub: DurableObjectStub<RepoCell>,
  signal?: AbortSignal | null
): Promise<Response | null> {
  if (env.UPLOAD_PACK_WORKER_STREAM !== "true") return null;
  const bucket = env.REPO_PACKS;
  if (!bucket) return null;
  const req = parseUploadRequest(body);
  // G3: unsupported fetch arguments must fall through cleanly to DO `uploadPack`
  // so it returns a protocol ERR without touching R2 or planning RPCs.
  if (req.badArgument) return null;
  const v2 = req.command === "fetch";
  const sideband = v2 || req.caps.has("side-band-64k");
  const fullClone =
    req.wants.length > 0 &&
    req.wants.every(isOid) &&
    req.haves.length === 0 &&
    req.done &&
    req.deepen.kind === "none" &&
    req.filter.kind === "none" &&
    req.clientShallows.length === 0 &&
    (v2 || req.command === null);
  if (!fullClone) return null;
  let plan: PlanWorkerWarmCloneResult;
  try {
    plan = await stub.planWorkerWarmFullClone(repo, req.wants);
  } catch {
    return null;
  }
  if (plan.tag !== "leased") return null;
  return streamWorkerWarmFullClone({
    bucket,
    stub,
    plan,
    v2,
    sideband,
    noProgress: req.caps.has("no-progress"),
    keepaliveMs: uploadKeepaliveMs(env.GIT_UPLOAD_KEEPALIVE_MS),
    signal,
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
  /** the client's push options (gitprotocol-pack push-options section); empty
   * when the client did not request the capability or sent no options */
  pushOptions: string[];
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
 * Read a gzipped receive body under the push cap measured on the COMPRESSED
 * bytes. `req.arrayBuffer()` would buffer the whole body before the inflate
 * cap applies, so the read walks the stream with a running byte count: the
 * declared Content-Length is checked up front, and the moment the counted
 * read passes the cap the reader is cancelled and the standard 413 error is
 * thrown (an "exceeds maximum size" message maps to `tooLargeResponse` in
 * the receive catch). Only the surviving bounded bytes reach gunzipLimited,
 * which keeps the DECOMPRESSED side of the budget.
 */
async function readGzipBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`request body exceeds maximum size (${declared} bytes declared)`);
  }
  const reader = req.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {}); // stop the sender; never surfaces
      throw new Error(`request body exceeds maximum size (${total} compressed bytes read)`);
    }
    parts.push(value);
  }
  return concat(parts);
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
    // only small pushes arrive gzipped, and the budget is two-layered: the
    // COMPRESSED bytes are read through a counting wrapper (a declared or
    // actual body over the cap 413s before the excess is ever buffered —
    // never `arrayBuffer()`-first, which would hold the whole body), and
    // gunzipLimited bounds the INFLATED bytes, so a zlib bomb can no more
    // exceed the push cap than a plain body can.
    bufferedAll = gunzipLimited(await readGzipBodyBounded(req, maxBytes), maxBytes);
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

  // push options (gitprotocol-pack: `push-options = *PKT-LINE(push-option)
  // flush-pkt`, after the command list's flush-pkt, before the packfile): the
  // client sends the section EXACTLY when it requested the advertised
  // `push-options` capability — git's send-pack writes it iff it passed
  // --push-option, so the capability token is the discriminator (a client
  // without it goes straight to the pack). git's read_push_options breaks on
  // the flush OR stream end (readPushOptions, builtin/receive-pack.c), so an
  // EOF mid-section ends the section here too; a malformed length still
  // throws like the command loop above.
  let pushOptions: string[] = [];
  if (caps.includes("push-options")) {
    const optionsStart = pos;
    for (;;) {
      if (!(await need(4))) break;
      const len = hex4(buf, pos);
      if (len === 0) {
        pos += 4;
        break;
      }
      if (len < 4) throw new Error("bad pkt-line in push request");
      if (!(await need(len))) break;
      pos += len;
    }
    pushOptions = parsePushOptions(buf.subarray(optionsStart, pos));
  }

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
  return { commands, caps, pushOptions, head, reader, hint };
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
 * window before the object is declared complete. Every body read races the
 * client-disconnect signal: a mid-pack client death fails HERE (inside this
 * function's own unwinds, so the writer/multipart capture abort) instead of
 * parking on a read that a silent drop never settles.
 */
async function stagePack(
  bucket: R2Bucket,
  stagingKey: string,
  push: ParsedPush,
  maxBytes: number,
  sideband: boolean,
  emit: (chunk: Uint8Array) => void,
  metrics: { stagingPuts: number; stagingParts: number },
  signal: AbortSignal | null | undefined
): Promise<StagedPack> {
  const sha = new Sha1();
  let tail = new Uint8Array(0); // rolling 20-byte lookbehind (the trailer)
  let total = 0;
  let lastLogged = 0;
  const absorb = (data: Uint8Array) => {
    total += data.length;
    // the wording is load-bearing: a body over the cap answers the STANDARD
    // 413 like every other size failure in the receive family
    // (overDeclaredLength up front, readGzipBodyBounded/gunzipLimited on the
    // gzip arm) — the receive staging catch rethrows an "exceeds maximum
    // size" message to the outer catch, whose filter maps it to
    // tooLargeResponse. (Was "pack exceeds maximum push size", which no
    // filter matched — the W11 follow-up.)
    if (total > maxBytes) throw new Error("pack exceeds maximum size");
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
        const { done, value } = await raceAbort(push.reader.read(), signal);
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
      // the destination rejects alongside the aborted writer — an abort-thrown
      // catch never reaches `await put`, and a dangling rejection would log as
      // an unhandled error on every disconnected push
      put.catch(() => {});
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
        const { done, value } = await raceAbort(push.reader.read(), signal);
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

/** The ng message every command carries when the validatePush hook returns
 *  a malformed verdict array — an authorization seam fails closed, never
 *  degrades into allow. */
const VERDICT_CONTRACT_VIOLATION = "push rejected: validatePush contract violation";

/**
 * Normalize the hook's return into per-command reject messages (null =
 * apply). The contract is strict — an index-aligned array of the same
 * length; anything else (wrong length, non-object entries, a non-string
 * reject) fails CLOSED with a fixed message.
 */
function verdictRejects(verdicts: PushVerdict[] | undefined, count: number): (string | null)[] {
  if (verdicts === undefined) return new Array<string | null>(count).fill(null);
  if (!Array.isArray(verdicts) || verdicts.length !== count) {
    console.log(
      `[receive] validatePush contract violation: expected ${count} verdicts, got ${Array.isArray(verdicts) ? verdicts.length : typeof verdicts}`
    );
    return new Array<string | null>(count).fill(VERDICT_CONTRACT_VIOLATION);
  }
  return verdicts.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "object") return VERDICT_CONTRACT_VIOLATION;
    if (v.reject === undefined) return null;
    return typeof v.reject === "string" && v.reject.length > 0 ? v.reject : VERDICT_CONTRACT_VIOLATION;
  });
}

/**
 * Build the classified command section the validatePush hook receives
 * (SPEC-0013 §3.5, OQ-1 decided): create/delete are wire facts;
 * fast-forward vs force-push is ancestry — the engine classifies DO-side
 * over the lease-staged rows (ONE classifyReceive RPC per push, never per
 * command) instead of handing the hook raw commands. A lost lease cannot be
 * surfaced meaningfully here (finalize rejects the push regardless), so its
 * update commands keep the conservative force-push kind.
 *
 * Returns that verdict array separately (`kinds`), non-null only when EVERY
 * entry is authoritative — the wire facts always are, the ancestry entries
 * only when the classify RPC answered "ok". finalizeReceive consumes it to
 * reuse the ancestry verdict instead of re-walking (a conservative classify
 * yields null and validatePush walks as before).
 */
async function classifyForValidator(
  stub: DurableObjectStub<RepoCell>,
  leaseToken: string,
  commands: PushCommand[]
): Promise<{ classified: ClassifiedPushCommand[]; kinds: PushCommandKind[] | null }> {
  const classified: ClassifiedPushCommand[] = commands.map((c) => ({
    ref: c.ref,
    old: c.old,
    new: c.next,
    kind: c.next === ZERO_OID ? "delete" : c.old === ZERO_OID ? "create" : "force-push",
  }));
  const kinds: PushCommandKind[] = classified.map((c) => c.kind);
  // ancestry entries need the batched RPC; an all-wire-facts section is
  // already authoritative without it
  if (classified.some((c) => c.kind === "force-push")) {
    const res = await stub.classifyReceive({
      leaseToken,
      commands: commands.map((c) => ({ old: c.old, next: c.next })),
    });
    if (res.tag === "ok") {
      res.kinds.forEach((kind, i) => {
        const c = classified[i];
        if (c) c.kind = kind;
        kinds[i] = kind;
      });
      return { classified, kinds };
    }
    // conservative kinds (lost lease): NOT authoritative — validatePush walks
    return { classified, kinds: null };
  }
  return { classified, kinds };
}

/**
 * Merge the receive section's per-command outcomes for report-status: the
 * hook's rejections by position, finalize's results (index-aligned with the
 * commands finalize was given) for the rest. With no hook this is the
 * historical identity render.
 */
function statusOfCommands(
  commands: PushCommand[],
  hookRejects: (string | null)[] | null,
  finResults: ReceiveCommandResult[] | null
): CommandResult[] {
  if (hookRejects === null) return asCommandResults(finResults ?? []);
  const out: CommandResult[] = [];
  let cursor = 0;
  commands.forEach((cmd, i) => {
    const reject = hookRejects[i];
    if (reject !== null) {
      out.push({ ref: cmd.ref, ok: false, msg: reject ?? VERDICT_CONTRACT_VIOLATION });
      return;
    }
    const r = finResults?.[cursor++];
    out.push(r ? { ref: r.ref, ok: r.ok, msg: r.message } : { ref: cmd.ref, ok: false, msg: "internal error" });
  });
  return out;
}

/**
 * The client-disconnect failure. A fixed, matched message (the same filter
 * discipline as the size-cap wording above): every receive-phase catch
 * rethrows it to the outer catch, which releases the lease and answers the
 * unobservable 499. Upstream's equivalent event is the request-context
 * cancel that KILLS the receive-pack child process (gitcmd command.go
 * CommandContext; serviceRPC pipes the request body into it) — git's
 * advisory locks die with the process, so upstream never needs this error:
 * there is no lock left behind to release. Here the lease must be released
 * explicitly, because the DO row outlives the isolate otherwise.
 */
const RECEIVE_CLIENT_GONE = "client disconnected mid-push";
function clientGoneError(): Error {
  return new Error(RECEIVE_CLIENT_GONE);
}
function isClientGoneError(err: unknown): boolean {
  return err instanceof Error && err.message === RECEIVE_CLIENT_GONE;
}

/**
 * Reject the awaited promise the moment `signal` aborts — the disconnect
 * fast-fail for the two receive phases that read the CLIENT's body
 * (parsePushRequest's command section, stagePack's pack stream). The body
 * read itself is what normally notices a disconnect, but a client that dies
 * SILENTLY (no TCP FIN/RST reaches the edge) delivers no error at all: the
 * read pends forever while the exclusive receive lease 503s every other
 * push to the repo until its TTL expires. The abort signal is the runtime's
 * disconnect event (upstream: the request-context cancel that kills the
 * receive-pack process); racing it turns a dead client's slot over in one
 * event-loop turn. Server-side phases (R2 scan, idx write, finalize) are
 * deliberately NOT raced: once the pack is staged the client's presence no
 * longer matters — upstream's receive-pack keeps the pack and its ref
 * updates ride or die on whether the process was killed BEFORE
 * execute_commands, which the explicit pre-finalize abort check below
 * mirrors.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(clientGoneError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(clientGoneError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * The official keepAlive packet (SPEC 0230): a pkt-line of total length 5 —
 * four ASCII hex length chars `0005` plus one 0x01 payload byte — i.e. a
 * ZERO-DATA band-1 sideband frame. This is git's own receive-pack form
 * (git-config(1) `receive.keepAlive` / `uploadpack.keepAlive`, the "empty
 * keepalive packet" sent while processing produces no output), copied
 * verbatim rather than inventing a custom heartbeat format. A client's
 * sideband demuxer reads the band byte, finds zero data bytes, and keeps
 * waiting — the bytes themselves keep the edge path from judging the
 * response idle.
 */
const RECEIVE_KEEPALIVE_FRAME = te.encode("0005\x01");

/** Default heartbeat cadence: interval x 2 stays under the observed answer
 * silence-cap floor (~60s) with margin, per SPEC 0230's hard constraint. */
const DEFAULT_RECEIVE_KEEPALIVE_MS = 20_000;

/**
 * The heartbeat interval, deployable config (parsed like the sibling
 * GIT_RECEIVE_DEADLINE_MS): default 20s, floor 50ms (protocol-timing
 * batteries), ceiling 30s (keeps the x2 < 60s cap-floor constraint true for
 * every deployable value). Unset/garbage keeps the default.
 */
function receiveKeepaliveMs(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_RECEIVE_KEEPALIVE_MS;
  return Math.min(Math.max(n, 50), 30_000);
}

/**
 * A streaming receive answer (SPEC 0230). Opened once the pack body is fully
 * staged — at the indexing boundary, past the busy/importing/rejected early
 * exits and every pre-arm failure whose buffered Response must stay
 * byte-identical (503s, the rejected render, 413s, the disconnect 499). From
 * here the HTTP status is committed at 200, so failures express IN BAND:
 * report-status (unpack ok/ng) rides the stream as before, and a
 * catastrophic failure emits a band-3 error frame before the stream closes
 * instead of a never-delivered 500. The lease, deadline and sweep semantics
 * are unchanged; only the delivery shape is.
 */
interface ReceiveStreamArm {
  /** the streaming Response, returned while the receive tail keeps running */
  readonly delivered: Response;
  /** redirect target for `emit`: enqueue one wire chunk into the stream */
  write(chunk: Uint8Array): void;
  /** stop the heartbeat and end the stream cleanly (after the report) */
  complete(): Promise<void>;
  /** stop the heartbeat; band-3 the failure unless the client is gone; close */
  fail(err: unknown, clientGone: boolean): Promise<void>;
}

/**
 * The lease-mismatch marker for the streaming arm: past the arm a 500
 * Response is undeliverable, so the mismatch surfaces as a band-3 frame
 * carrying the same text the buffered path answers with. Skips the FAILED
 * log line on purpose — the buffered path answers this verdict silently and
 * the parity is kept.
 */
class ReceiveLeaseLostError extends Error {
  constructor() {
    super("receive lease lost (expired or already finalized); retry the push");
  }
}

/**
 * Open the streaming arm: an explicit push-driven ReadableStream carries the
 * Response body — the same mechanism family as the upload-pack fast path
 * (git/protocol.ts streamingCloneResponse), production-proven on this
 * runtime. The queueing shape matters: `controller.enqueue`/`close` NEVER
 * wait on a consumer, so the receive tail can always finish regardless of
 * whether (or how fast) the client drains the answer — a writer/pull pair
 * (e.g. an identity TransformStream) would couple `close` to backpressure
 * on an unread stream and hang the tail behind it. The answer's total
 * post-staging volume is bounded (progress milestones + one report +
 * keepalives), so the unbounded queue costs nothing; a consumer that
 * cancelled is handled by the enqueue throw + the cancel callback, while
 * the tail's throwIfClientGone owns the lease.
 */
function openReceiveStreamArm<E extends Env>(env: E): ReceiveStreamArm {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // the consumer stopped reading (disconnect or abandonment); late
      // enqueues throw into the swallow below and the tail's disconnect
      // path owns the lease
      ended = true;
    },
  });
  const keepaliveMs = receiveKeepaliveMs(env.GIT_RECEIVE_KEEPALIVE_MS);
  // the official idle gate (receive.keepAlive semantics): a tick that already
  // saw another frame stays silent; the keepalive itself counts as output for
  // the next gate, so a quiet stretch emits exactly one packet per interval
  let framesSinceTick = false;
  let ended = false;
  const write = (chunk: Uint8Array): void => {
    if (ended || controller === null) return;
    framesSinceTick = true;
    try {
      controller.enqueue(chunk);
    } catch {
      ended = true; // the stream was closed, errored or cancelled
    }
  };
  const timer = setInterval(() => {
    if (ended) return;
    if (framesSinceTick) {
      framesSinceTick = false;
      return;
    }
    write(RECEIVE_KEEPALIVE_FRAME);
  }, keepaliveMs);
  return {
    delivered: new Response(stream, { headers: receiveHeaders() }),
    write,
    complete: async () => {
      ended = true;
      clearInterval(timer);
      try {
        controller?.close();
      } catch {
        // already closed, errored or cancelled by the consumer side
      }
    },
    fail: async (err: unknown, clientGone: boolean) => {
      clearInterval(timer);
      try {
        if (!clientGone) {
          // a client that is still connected deserves the failure in band
          // (band-3 = error per gitprotocol-pack(5)); a dead one never reads
          const msg = err instanceof Error ? err.message : String(err);
          for (const f of sidebandFrames(3, te.encode(`error: ${msg}\n`))) write(f);
        }
        controller?.close();
      } catch {
        // already closed, errored or cancelled by the consumer side
      }
      ended = true;
    },
  };
}

/**
 * POST /git-receive-pack — the Worker-side receive flow. Auth (write) has
 * already run. Wire behavior is unchanged end to end: 503 Retry-After when
 * another push holds the lease (T7), report-status with per-command ok/ng
 * lines otherwise, byte-identical to the pre-split DO rendering.
 *
 * SPEC 0230 (the mirror-line answer-silence wall): once the pack body is
 * fully staged, a `side-band-64k` push's answer becomes a STREAMING
 * response — the indexing milestones and the final report-status enqueue
 * into the open stream while the pipeline still runs, and an idle-gated
 * heartbeat emits the official `receive.keepAlive` packet (`0005\x01`, the
 * zero-data band-1 frame) whenever processing produces no other output, so
 * a long index never looks like a dead answer. Without the capability the
 * buffered one-shot answer is byte-for-byte unchanged, and every pre-arm
 * failure (busy/importing 503s, the rejected render, 413, the disconnect
 * 499) keeps its buffered shape. See the arm block below for the failure
 * semantics past the arm.
 *
 * `internal` carries the embedding Worker's per-call options: `pusher`, the
 * authenticated identity for this receive (surfaced verbatim on the onPush
 * event, never used for authorization), `validatePush`, the SPEC-0013
 * M2 per-ref policy hook (invoked between the scan and finalize; absent →
 * no enforcement), and `signal`, the client-disconnect signal (the abort
 * fast-fail below; absent → `req.signal`, and the lease TTL stays the only
 * backstop for holders that stop making progress without a disconnect).
 */

async function receivePack<E extends Env>(
  req: Request,
  env: E,
  repo: string,
  ctx: ExecutionContext,
  registry: DurableObjectStub<Registry>,
  options: DurableGitOptions<E>,
  internal?: EngineCallOptions,
): Promise<Response> {
  const pusher = internal?.pusher;
  // The disconnect fast-fail channel (EngineCallOptions.signal doc): a
  // re-wrapped D1 forward loses the original request's signal, so the
  // embedding Worker hands it across; a verbatim passthrough falls back to
  // the request's own signal.
  const signal = internal?.signal ?? req.signal;
  const throwIfClientGone = () => {
    if (signal?.aborted) throw clientGoneError();
  };
  const bucket = env.REPO_PACKS;
  if (!bucket) {
    return new Response("error: git push requires an R2 bucket binding (REPO_PACKS)\n", { status: 500 });
  }
  const maxBytes = (parseInt(env.MAX_PUSH_MB ?? "", 10) || DEFAULT_MAX_PUSH_MB) * 1024 * 1024;
  // refuse an over-sized push from its declared length: buffering it first
  // and checking after is exactly the memory the limit exists to bound
  if (overDeclaredLength(req, maxBytes)) return tooLargeResponse(maxBytes);

  const stub = env.REPO.getByName(repo);
  // The answer accumulator. Buffered (chunks) until the SPEC 0230 stream arm
  // opens — every pre-arm answer and every non-sideband answer is returned
  // from here exactly as before — then redirected into the response stream
  // (the `emit` closure below is re-aimed at the arm's writer), so the
  // indexing-phase milestones and the final report-status reach the client
  // while the pipeline is still running instead of after it ends.
  const chunks: Uint8Array[] = [];
  let emit: (chunk: Uint8Array) => void = (chunk) => chunks.push(chunk);
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
    // 1. the command section only — the pack is never parsed here. Raced
    // against the disconnect signal: no lease is held yet, but a client dead
    // before its command section must not park this handler on a body read
    // that may never settle (silent drop).
    const push = await raceAbort(parsePushRequest(req, maxBytes), signal);
    const sideband = push.caps.includes("side-band-64k");
    // report-status-v2 (gitprotocol-pack) extends report-status with proc-
    // receive option lines; a client requesting either capability gets a
    // status report, and this engine — no proc-receive, exactly like upstream
    // Gitea — never rewrites refs, so the v2 report carries zero option
    // lines: the same bytes git 2.43.0 sends for a non-rewritten push.
    const wantStatus = push.caps.includes("report-status") || push.caps.includes("report-status-v2");
    // atomic (gitprotocol-pack): any per-ref failure rejects the whole
    // command section (see the hook merge below and commitPush)
    const atomic = push.caps.includes("atomic");

    // 2. open the lease (refname validation happens before any byte streams).
    // FIRST, bind the cell's name (repo.ts bindRepo): this entry is a direct
    // RPC and never runs the cell's fetch handler, whose bindR2 was upstream
    // dgit's receive-entry binding — without it a never-fetched cell (no
    // prior info/refs advert; create-by-push reaches unknown names by
    // design) has neither meta.storage_key nor meta.repo, and the lease's
    // key resolution lands on the degenerate `repos//` staging prefix. The
    // x-storage-key header below (SPEC-0001a §3 Step 3) still wins when the
    // caller knows the D1-minted key; absent, the freshly bound name IS the
    // documented fallback. The parse above ran first, so a malformed command
    // section never touches the cell.
    await stub.bindRepo(repo);
    const begin = await stub.beginReceive({
      commands: push.commands,
      capabilities: push.caps,
      packBytesHint: push.hint,
      storageKey: req.headers.get("x-storage-key"),
      leaseTtlMs: resolveReceiveLeaseTtlSeconds(env.GIT_TIMEOUT_RECEIVE),
    });
    if (begin.tag === "busy") {
      // the busy 503 names the blocking holder's lease lifetime: without it a
      // stranded holder (the silent-drop shape the TTL is the backstop for)
      // is invisible until the wall heals itself at expiry — with it the
      // remaining window reads straight off the log (absolute + remaining)
      const leaseSecondsLeft = Math.max(0, Math.ceil((begin.leaseExpiresAt - Date.now()) / 1000));
      console.log(
        `[receive ${repo}] busy: another push holds the lease until ${new Date(begin.leaseExpiresAt).toISOString()} (${leaseSecondsLeft}s left); retry-after ${begin.retryAfterSeconds}s`
      );
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
        staged = await stagePack(bucket, begin.stagingKey, push, maxBytes, sideband, emit, metrics, signal);
      } catch (err) {
        // a client disconnect is not an unpack verdict: the push is dead and
        // the lease must turn over NOW (the outer catch releases + sweeps);
        // rethrown before the unpackError swallow, mirroring the size-cap arm
        if (isClientGoneError(err)) throw err;
        const stagedMsg = err instanceof Error ? err.message : String(err);
        // the cap's violation is a TRANSPORT answer, not a protocol one: the
        // same violation detected from the declared length 413s before any
        // byte streams (overDeclaredLength above), so the same violation
        // detected mid-stream 413s here — the size messages rethrow to the
        // outer catch (lease release + staging sweep + tooLargeResponse);
        // every other staging failure stays the report-status unpack ng.
        if (stagedMsg.includes("exceeds maximum size")) {
          try {
            await push.reader?.cancel();
          } catch {
            // client may already be gone
          }
          throw err;
        }
        unpackError = stagedMsg;
        console.log(`[receive ${repo}] staging failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        try {
          await push.reader?.cancel();
        } catch {
          // client may already be gone
        }
      }
    }

    // === SPEC 0230: the answer's delivery shape ==============================
    // The stream arm opens HERE — past the busy/importing/rejected early
    // exits and the entire staging upload, whose failures must keep their
    // buffered answers byte-identical (the 503s, the rejected render, the
    // 413 mapping, the disconnect 499 — each commits a status a stream arm
    // could not), at the boundary of the indexing phase the proposal
    // targets. With `side-band-64k` negotiated, the answer becomes a
    // streaming Response returned immediately while the pipeline below keeps
    // running as the invocation's tail, so the indexing milestones and the
    // final report-status reach the client while the work is still in
    // flight — the property that keeps an edge path from judging the answer
    // silent during a long index (the mirror wall this amends). The
    // heartbeat rides the same arm (the official receive.keepAlive packet,
    // idle-gated). Without sideband, everything below returns the buffered
    // one-shot answer byte-for-byte as before.
    const arm: ReceiveStreamArm | null = sideband ? openReceiveStreamArm(env) : null;
    if (arm !== null) emit = arm.write;

    // Steps 4 → 6 as the shared continuation: awaited inline on the buffered
    // path, driven as the tail on the streaming one. Every `return` below
    // hands its answer to `deliver`, which returns the buffered Response
    // unchanged or — on the streaming arm, where the answer is already
    // flowing — resolves with the already-returned streaming Response so the
    // caller-side tail can end the stream.
    const deliver = async (): Promise<Response> => {
      if (arm === null) return new Response(concat(chunks) as unknown as BodyInit, { headers: receiveHeaders() });
      return arm.delivered;
    };
    const indexAndFinalize = async (): Promise<Response> => {
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
          const rangeBudget = parseInt(env.RANGE_BUDGET ?? "", 10) || RANGE_BUDGET;
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
              rangeBudget,
              collisionDetect,
              onProgress: progress,
            }
          );
          // The indexing phase (scan + delta resolution + connectivity) runs
          // under a wall-clock deadline. The receive-walk's cost is data-shape
          // dependent — thin-pack base resolution consults the object database
          // in chain waves (one batched DO RPC per wave since the L761 wave
          // batching, down from one single-oid RPC per foreign chain hop, whose
          // 87-RPC / 2m14s production walk crossed the ~2.4min platform
          // teardown line) — and when the walk still outgrows the platform's
          // patience the invocation is torn down WITHOUT any catch running,
          // stranding the exclusive lease until the TTL and 503ing every
          // concurrent push. The deadline converts that silent grind into an
          // explicit unpack-ng: the lease is released through finalize and the
          // slot turns over. Default 10 minutes, strictly inside
          // GIT_TIMEOUT_RECEIVE's 15 so the ng always beats the TTL sweep;
          // GIT_RECEIVE_DEADLINE_MS overrides.
          const deadlineMs = Math.min(
            Math.max(parseInt(env.GIT_RECEIVE_DEADLINE_MS ?? "", 10) || RECEIVE_INDEX_DEADLINE_MS, 1000),
            86_400_000
          );
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const indexing = (async () => {
            await walkPack(
              { body: stagedObj.body, size: stagedObj.size },
              // a disconnect during a long scan fails the walk the same way a
              // staging failure does: the step-4 catch rethrows it to the outer
              // release (rows already pushed are crash debris the DO's orphan
              // sweep reclaims), instead of finishing a push whose client is gone
              // and holding the lease for the whole walk
              (entry) => {
                throwIfClientGone();
                return resolver.onEntry(entry);
              },
              { collisionDetect, onHeader: (count) => resolver.init(count), onProgress: progress }
            );
            return resolver.finish();
          })();
          // whichever promise loses the race keeps running with nobody awaiting
          // it — swallow its rejection so it can never surface as an unhandled
          // one (the deadline loser settles against an already-released lease;
          // its next lease-bound RPC fails with lease-invalid and dies quietly)
          indexing.catch(() => {});
          const deadline = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => reject(new Error(`receive indexing deadline exceeded (${deadlineMs}ms)`)), deadlineMs);
          });
          deadline.catch(() => {});
          let resolved: ResolveResult;
          try {
            resolved = await Promise.race([indexing, deadline]);
          } finally {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          }
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
          // a disconnect mid-scan rethrows to the outer release — never an
          // unpack verdict for a client that cannot read the report anyway
          if (isClientGoneError(err)) throw err;
          // scan/resolution/idx failures surface verbatim in report-status
          // ("unpack <msg>"); rows already pushed are crash debris the DO's
          // orphan sweep reclaims (their pack never reaches pack_catalog)
          unpackError = err instanceof Error ? err.message : String(err);
          console.log(`[receive ${repo}] index failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }
      }

      // 4.5 Per-ref push policy (SPEC-0013 M2): the embedding Worker's
      // validatePush call option decides per classified command. Runs after
      // the scan (classification needs the new tips' ancestry — one batched
      // classifyReceive RPC) and before finalize (rejected commands must
      // never apply). A throwing hook propagates to the outer catch: the
      // lease is released with a sweep and the request fails closed (500) —
      // on the streaming arm the same throw reaches the tail's catch, whose
      // band-3 frame is the in-band form of that 500.
      let hookRejects: (string | null)[] | null = null;
      // classifyReceive's authoritative ancestry verdicts (null when the
      // classify was conservative or no hook ran): finalize reuses them instead
      // of re-walking the same (old,next) ancestry — the bounded walk ran twice
      // per force-shaped push, and its duration grows with repo history
      let classifiedKinds: PushCommandKind[] | undefined;
      if (internal?.validatePush && unpackError === null) {
        const { classified, kinds } = await classifyForValidator(stub, begin.leaseToken, push.commands);
        if (kinds !== null) classifiedKinds = kinds;
        const verdicts = await internal.validatePush(classified, {
          repo,
          ...(pusher !== undefined ? { pusher } : {}),
          ...(push.pushOptions.length > 0 ? { pushOptions: push.pushOptions } : {}),
          // The lease-carrying changed-path read: the hook asks, the DO walks
          // the staged rows under THIS receive's lease. A lost lease surfaces
          // as `unresolved` (the push is dead regardless; the policy fails
          // closed and finalize reports the lease mismatch).
          changedPaths: async (command) => {
            const res = await stub.diffReceive({
              leaseToken: begin.leaseToken,
              ref: command.ref,
              old: command.old,
              next: command.new,
            });
            if (res.tag === "ok") return { tag: "ok", paths: res.paths, truncated: res.truncated };
            return { tag: "unresolved", reason: res.tag === "lease_mismatch" ? "receive lease lost" : res.reason };
          },
        });
        hookRejects = verdictRejects(verdicts, push.commands.length);
      }
      // Under `atomic`, any per-ref failure rejects the whole section: the
      // hook-declined commands keep their own message, the commands that WOULD
      // have applied report ATOMIC_PUSH_FAILED — git's transaction-abort shape
      // (execute_commands_atomic). Marking the nulls here funnels the push
      // through the existing all-rejected path (finalize skipped, lease released
      // with a sweep, nothing applies), and statusOfCommands renders it as-is.
      if (atomic && hookRejects !== null && hookRejects.some((r) => r !== null)) {
        hookRejects = hookRejects.map((r) => (r === null ? ATOMIC_PUSH_FAILED : r));
      }

      // 5. finalize: the DO re-checks per-command CAS and commits refs +
      // refs_version in one transaction (the pack is already indexed). The
      // hook-rejected commands are removed first, so a per-ref rejection
      // never blocks its siblings (upstream rejects per-ref inside
      // pre-receive) — except under `atomic`, where the merge above turned any
      // hook rejection into an all-reject section; finalize's `atomic` flag
      // gives the DO-side verdicts (validation rejects, CAS mismatches) the
      // same all-or-nothing shape inside the one commit transaction.
      // finalize's results stay index-aligned with the command
      // list it receives, and the merge below re-aligns them to the section.
      const finalizeCommands =
        hookRejects === null ? push.commands : push.commands.filter((_, i) => hookRejects![i] === null);
      // the kinds array rides the same filter: it must stay index-aligned with
      // the commands finalize actually receives
      let finalizeKinds = classifiedKinds;
      if (finalizeKinds !== undefined && hookRejects !== null) {
        finalizeKinds = push.commands
          .map((_, i) => i)
          .filter((i) => hookRejects![i] === null)
          .map((i) => finalizeKinds![i]);
      }
      if (finalizeCommands.length === 0) {
        // every command rejected by policy: nothing to finalize — drop the
        // lease with a sweep (staging object + index rows) so an all-rejected
        // push leaves no debris, then render all-ng report-status
        leaseToken = null;
        try {
          await stub.releaseReceive({ leaseToken: begin.leaseToken, sweep: true });
        } catch {
          // best effort: the lease-expiry sweep is the backstop
        }
        if (wantStatus) emit(renderStatus(statusOfCommands(push.commands, hookRejects, null), null, sideband));
        return await deliver();
      }
      // The upstream kill boundary, mirrored: a receive-pack canceled by the
      // HTTP request context BEFORE execute_commands applies nothing (the
      // process dies holding git's advisory locks; refs never move). The
      // staging/scan arms rethrow disconnects above, but a deletes-only push
      // never reads a pack byte — this check is the only fast-fail it gets.
      // Failing here releases the lease via the outer catch (the tail's catch
      // on the streaming arm) and applies nothing; a disconnect AFTER finalize
      // has already decided the lease is not observable (this line sits
      // strictly before the RPC).
      throwIfClientGone();
      const fin = await stub.finalizeReceive({
        leaseToken: begin.leaseToken,
        expectedRefsVersion: begin.refsVersion,
        commands: finalizeCommands,
        newTips: finalizeCommands.map((c) => (c.next === ZERO_OID ? null : c.next)),
        pack,
        unpackError,
        packIncomplete,
        atomic,
        ...(finalizeKinds !== undefined ? { classifiedKinds: finalizeKinds } : {}),
      });
      leaseToken = null; // finalize decided the lease; the release below is a no-op sweep
      if (fin.tag === "lease_mismatch") {
        // Buffered, this verdict keeps its silent 500. On the streaming arm
        // the status is already committed, so the mismatch throws to the
        // tail's catch: same lease semantics (finalize decided it — nothing
        // to release), the band-3 frame carries the buffered path's exact
        // text, and the FAILED log line is skipped for parity with the
        // silent 500.
        if (arm === null) {
          return new Response("error: receive lease lost (expired or already finalized); retry the push\n", {
            status: 500,
          });
        }
        throw new ReceiveLeaseLostError();
      }

      // 6. report-status — byte-identical to the pre-split DO rendering; with
      // a hook, the per-ref rejections are merged back in by position.
      // SPEC 0230 acceptance ⑤: this emit is the ONLY success report and it
      // sits strictly AFTER finalize's single transaction (objects landed +
      // SHA-1 checksums verified in the idx + refs updated), so a success
      // report can never precede the persistence it reports.
      if (wantStatus) emit(renderStatus(statusOfCommands(push.commands, hookRejects, fin.results), unpackError, sideband));

      // begin + the entry's name bind (bindRepo) + finalize
      const doRpcs = 3 + metrics.rowRpcs + metrics.lookupRpcs;
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
          const origin = requestOrigin(req);
          const onPush = options.onPush; // narrowed local: property narrowing does not survive the .then closure
          const event: PushEvent = {
            repo,
            updates: fin.updates,
            commitTime: idle,
            ...(pusher !== undefined ? { pusherId: pusher.id, pusherLogin: pusher.login } : {}),
            ...(origin !== undefined ? { origin } : {}),
            ...(push.pushOptions.length > 0 ? { pushOptions: push.pushOptions } : {}),
          };
          // The hook call runs INSIDE the promise chain: `Promise.resolve(
          // options.onPush(...))` evaluates the hook BEFORE wrapping it, so a
          // synchronous throw escaped the waitUntil argument and — via the
          // outer catch — turned an already-applied push into a 500, against
          // this hook's documented contract (a throwing hook never fails the
          // push). Sync and async throws both land in the catch below now.
          ctx.waitUntil(
            Promise.resolve()
              .then(() => onPush(event, env))
              .catch((err) => {
                console.log(`[onPush ${repo}] hook failed: ${err instanceof Error ? err.message : String(err)}`);
              })
          );
        }
      }
      return await deliver();
    };

    if (arm === null) return await indexAndFinalize();

    // The streaming tail. The buffered path's outer catch below never sees
    // these failures — the 200 is already on the wire — so its semantics are
    // re-expressed IN BAND here: the same FAILED/disconnect log lines, the
    // same lease release + staging sweep, then a band-3 error frame (a live
    // client deserves the failure spelled out; a dead one just gets the
    // close) before the stream ends. The size-cap arm is absent on purpose:
    // every size violation fires before the arm opens. The tail is tied by
    // waitUntil AND the still-open response stream (the streamingCloneResponse
    // mechanism family); the bare-Object ExecutionContext some batteries pass
    // carries no waitUntil, and there the drained response alone paces the
    // tail.
    const tail = (async () => {
      try {
        await indexAndFinalize();
        await arm.complete();
      } catch (err) {
        const leaseLost = err instanceof ReceiveLeaseLostError;
        const clientGone = isClientGoneError(err);
        if (!clientGone && !leaseLost) {
          console.log(`[receive ${repo}] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        }
        if (leaseToken) {
          // abandon the lease and sweep the staging object; safe even when the
          // failure raced a finalize (idempotent-on-lease_mismatch)
          try {
            await stub.releaseReceive({ leaseToken, sweep: true });
          } catch {
            // best effort: the lease-expiry sweep is the backstop
          }
        }
        if (clientGone) {
          console.log(`[receive ${repo}] client disconnected (abort signal) — receive lease released`);
        }
        await arm.fail(err, clientGone);
      }
    })();
    (ctx as { waitUntil?: ExecutionContext["waitUntil"] }).waitUntil?.(tail);
    // completion handoff (SPEC 0230): the tail outlives this return — the
    // embedding worker sequences its dependent tails behind it
    try {
      internal?.pushSettled?.(tail);
    } catch {
      // a throwing handoff must not fail the already-committed answer
    }
    return arm.delivered;
  } catch (err) {
    const clientGone = isClientGoneError(err);
    // one line per failure class: a disconnect is not a FAILED receive (the
    // push is dead by client choice), it is a lease turnover
    if (!clientGone) {
      console.log(`[receive ${repo}] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
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
    if (clientGone) {
      // The client is gone and will never read this; the status exists for
      // logs and probes (499, nginx's "client closed request" convention — a
      // deliberate non-standard pick, recorded in SPEC-0001 §5). The lease
      // release above is the behavior that matters.
      console.log(`[receive ${repo}] client disconnected (abort signal) — receive lease released`);
      return new Response(`error: ${RECEIVE_CLIENT_GONE}\n`, { status: 499 });
    }
    return new Response(`error: ${msg}\n`, { status: 500 });
  }
}

function receiveHeaders(): Record<string, string> {
  return {
    "content-type": "application/x-git-receive-pack-result",
    "cache-control": "no-cache",
  };
}

/**
 * The origin (`PushEvent.origin`) a receive-pack request arrived on. Only
 * http(s) URLs carry a real origin (`URL.origin` is "null" for exotic
 * schemes). Defensive by contract: the only call site runs POST-finalize on
 * an already-applied push, so a parse failure degrades to `undefined` — it
 * must never turn an applied push into a 500.
 */
function requestOrigin(req: Request): string | undefined {
  try {
    const u = new URL(req.url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The returned handler: a valid Worker default export, with `fetch` non-optional
 * so it can also be delegated to from a wrapping router. */
export interface DurableGitHandler<E extends Env = Env> {
  fetch(req: Request, env: E, ctx: ExecutionContext, internal?: EngineCallOptions): Promise<Response>;
}

/**
 * An authenticated identity the embedding Worker resolved for a receive and
 * hands to the engine on the fetch call. In-process by construction: the
 * identity never rides the wire, so a client cannot forge it on any path —
 * including the paths that bypass an embedding Worker's auth gate and reach
 * the engine with raw client headers, where a request-header channel (e.g. an
 * `x-push-user` header) WOULD be forgeable. The engine surfaces it verbatim
 * on `PushEvent.pusherId`/`pusherLogin`; it performs no authorization with it.
 */
export interface PusherIdentity {
  /** the pusher's stable id in the embedding Worker's store */
  id: number;
  /** the pusher's case-folded login */
  login: string;
}

/**
 * Per-call options for an embedding Worker's `engine.fetch` invocation. The
 * parameter is positional and optional, so every existing caller — including
 * the runtime's three-argument default-export invocation — is unaffected.
 */
export interface EngineCallOptions {
  /** Attribution for a receive-pack apply, surfaced on `PushEvent`. */
  pusher?: PusherIdentity;
  /**
   * Per-ref push policy for a receive-pack (SPEC-0013 M2), enforced by the
   * engine's receive flow: rejected commands render as report-status ng and
   * never apply, their siblings land. An in-process call argument, never a
   * wire-trustable input — receives that bypass the embedding Worker's gate
   * (the mirror/import engine composition, the D1-missing transitional
   * passthrough) pass no hook: no enforcement, byte-identical flow.
   */
  validatePush?: PushValidator;
  /**
   * The CLIENT-side disconnect signal for a receive-pack, observed by the
   * receive flow's fast-fail race: an aborted signal fails the push
   * immediately, releases the lease with a sweep, and applies nothing.
   * In-process because a D1-resolved receive forward is RE-WRAPPED
   * (the x-storage-key override), and a reconstructed Request carries a
   * fresh never-aborting signal — the embedding Worker must hand the
   * original request's signal across (gate.ts forwardToEngine passes
   * `req.signal` here); receives that arrive verbatim (the D1-missing
   * passthrough) fall back to `req.signal` engine-side. Upstream shape:
   * serviceRPC's receive-pack child process is bound to the request
   * context (gitcmd command.go CommandContext), so a disconnect kills the
   * process and git's advisory locks die with it — this signal is the
   * same cancel event for a lease that has no process to die. Absent
   * (mirror/import internal receives) → no disconnect observation beyond
   * the request's own signal; the lease TTL stays the backstop.
   */
  signal?: AbortSignal | null;
  /**
   * SPEC 0230 completion handoff for a STREAMING receive answer. When the
   * side-band arm opens, receivePack returns its Response while the receive
   * pipeline (staging → indexing → hook → finalize → report) keeps running
   * as the invocation tail; it invokes this with that tail's promise. An
   * embedding Worker whose own tails read POST-PUSH state (the gate's push
   * tails: webhook fan-out over the landed refs, the §2.5.2 create settle
   * over the engine's listRefs) must sequence them behind this promise —
   * "the response resolved" no longer implies "the push applied". Never
   * invoked on the buffered path: there the same guarantee is already
   * carried by the fetch resolution itself (finalize completes before
   * receivePack returns). In-process by construction (the same channel
   * discipline as pusher/validatePush/signal); a throwing handoff never
   * fails the already-committed answer.
   */
  pushSettled?: (settled: Promise<void>) => void;
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
  const raws = namespaced ? [g.owner, g.name] : [g.name];
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    if (!raw) return null;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // the infrastructure-cell marker rides the NAME segment only (the flat
    // form's only segment); an OWNER segment stays on the strict alphabet
    const isNameSegment = i === raws.length - 1;
    if (!REPO_NAME.test(seg) && !(isNameSegment && INFRA_REPO_NAMES.has(seg))) return null;
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
    // the M3.3/M3.4 pack-maintenance shapes (SPEC-0011 §5.1/§2 amendment,
    // 2026-11-25 — the compactNow/gcNow RPCs had no call surface outside the
    // tests; these are their admin-guarded HTTP twins, same guard family as
    // POST /gc: the authorize hook decides, with op "admin")
    ((sub === "/compact" || sub === "/pack-gc") && method === "POST") ||
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
    async fetch(req: Request, env: E, ctx: ExecutionContext, internal?: EngineCallOptions): Promise<Response> {
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
        const received = await receivePack(req, env, repo, ctx, registry, options, internal);
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
          // A gzipped body reads through the receive arm's bounded reader (the
          // readGzipBodyBounded parity — an arrayBuffer()-first read would hold
          // the whole COMPRESSED body before the inflate cap applies, and a
          // chunked gzipped upload-pack request carries no Content-Length, so
          // the "small" predicate above admits it unbounded): the declared
          // length pre-checks and the counted walk cancels the reader the
          // moment the compressed count passes the cap, throwing the standard
          // "exceeds maximum size" message — mapped to the standard 413 here,
          // the same mapping the DO-side upload-pack arm applies to its own
          // size errors (repo.ts uploadPack's catch).
          const gzipped = req.headers.get("content-encoding")?.includes("gzip") ?? false;
          let raw: Uint8Array;
          if (gzipped) {
            try {
              raw = await readGzipBodyBounded(req, MAX_UPLOAD_PACK_BYTES);
            } catch (err) {
              if (err instanceof Error && err.message.includes("exceeds maximum size")) {
                return tooLargeResponse(MAX_UPLOAD_PACK_BYTES);
              }
              throw err;
            }
          } else {
            raw = new Uint8Array(await req.arrayBuffer());
          }
          let parsed: Uint8Array = raw;
          if (gzipped) {
            try {
              parsed = gunzipLimited(raw, MAX_UPLOAD_PACK_BYTES);
            } catch {
              parsed = new Uint8Array(0);
            }
          }
          if (env.REPO_PACKS && parsed.length) {
            const hit =
              env.UPLOAD_PACK_WORKER_STREAM === "true"
                ? await serveWorkerWarmClone(env, repo, parsed, stub, internal?.signal ?? req.signal)
                : await serveCloneFromR2(env, repo, parsed, stub);
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
