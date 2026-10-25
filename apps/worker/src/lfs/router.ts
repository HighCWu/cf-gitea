/**
 * LFS HTTP route family — SPEC-0006 §2.1-§2.3 (M1 relay mode).
 *
 * Upstream registers the whole family under one group with `m.Any("/*",
 * NotFound)` (`routers/common/lfs.go:15-31`); cf-gitea mounts the identical
 * shapes at `/:owner/:repo(.git)?/info/lfs/*`. The branch is intercepted in
 * the SPEC-0003 gitHttpGate (before engine delegation): repos with a D1 row
 * dispatch here through the gate's resolve/redirect pipeline; repos WITHOUT a
 * row keep passing through to the engine verbatim — the transitional
 * passthrough is deliberate (the e2e suite's repositories live there) and
 * stays byte-identical.
 *
 * Wire parity notes (upstream pin `fc49368845`, services/lfs/server.go):
 * - Error responses outside the batch envelope carry the LFS media type and a
 *   JSON body `{"message": "<status text>"}` (`writeStatusMessage`).
 * - The 401 challenge is `WWW-Authenticate: Basic realm="gitea-lfs"` with that
 *   same JSON body (`requireAuth` → `writeStatus(401)`) — unlike the git-HTTP
 *   gate's plain-text `realm="Gitea"` challenge.
 * - Auth split (§2.2): nonexistent repo → 404 before any challenge (here: the
 *   engine passthrough 404s for D1-missing repos); no credentials / no access
 *   → 401 + realm (upstream challenges where git-HTTP 404-masks — documented
 *   divergence from SPEC-0003 §2.4, kept per §2.2); verified token lacking
 *   `read:`/`write:repository` → 403.
 * - Batch: accept check 415 → decode 400 / unknown operation 400 / batch cap
 *   413 → auth (`upload` op writes, `download` reads) → per-object results in
 *   a 200 envelope (object-level errors never fail the request).
 * - Upload: pointer-from-path validation → 422; relay uploads REQUIRE
 *   Content-Length (git-lfs basic always sends one) → 411 otherwise, because
 *   the store's streaming put enforces the declared size (SPEC-0006 §2.3);
 *   bytes already present with a matching row skip the body check; bytes
 *   present without a row (or absent) are streamed through the single-pass
 *   hash-and-forward put, which proves sha256(content) == oid and deletes the
 *   object on mismatch → 422 with the upstream error strings.
 * - Verify: decode 422 → pointer validation 422 → write auth → HEAD-based
 *   verification (presign mode additionally requires the stored checksum);
 *   success flips `uploading → verified`, or adopts a missing row (§3.3
 *   self-heal — our extension, covers a lost batch row write, §4.13).
 * - Download: pointer validation 422 → read auth → row 404 → relay stream
 *   with `Content-Type: application/octet-stream`, the parity header
 *   `X-Gitea-LFS-Content-Length`, upstream's `bytes=(\d+)-(\d*)` Range
 *   handling (206/416), and `Content-Disposition` from the base64url
 *   `{filename}` segment (decode failure ⇒ param ignored, never reflected).
 * - The catch-all is stdlib-shaped, like upstream's `m.Any("/*",
 *   http.NotFound)`: plain-text `404 page not found`, not the LFS JSON
 *   envelope (which only `writeStatusMessage`-issuing handlers use).
 * - Successes ride the same envelope: `writeStatus(200)` emits
 *   `{"message":"OK"}` with the LFS media type (upload + verify).
 *
 * Locks (`info/lfs/locks/*`) are P2 (§2.7): answered with a plain 501 before
 * auth — push/pull never touch them, and `git lfs lock` users get an honest
 * capability signal instead of a 404.
 *
 * Config: upstream serves the subtree only when `LFS_START_SERVER` is on
 * (`lfsServerEnabled` parity). No config surface exists yet (`wrangler.jsonc`
 * is owned elsewhere), so LFS is unconditionally enabled; limits come from
 * the service defaults (§2.2 `LFS_MAX_BATCH_SIZE` 100, §4.6 512 MiB, §4.7
 * 10 GiB quota).
 */

import type { DurableGitHandler } from "@cf-gitea/git-engine";

import type { AuthUser } from "../auth/auth-context";
import { D1FailureLimiter } from "../auth/failure-limiter";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../auth/httpauth";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../auth/middleware";
import { ScopeSet } from "../auth/scopes";
import { TokenService, type VerifiedAuth } from "../auth/token-service";
import { resolveRepository } from "../git-http/acl";
import {
  accountDisabled,
  ownerUnavailable,
  rateLimited,
  redirectPermanent,
  repositoryArchived,
  scopeForbidden,
} from "../git-http/respond";
import { lookupRedirect } from "../repos/service";
import {
  acceptsLfsMediaType,
  BatchRequestError,
  DEFAULT_LFS_LIMITS,
  isValidPointerFields,
  LFS_MEDIA_TYPE,
  parseBatchRequest,
  shapeBatchResponse,
  type BatchShapingContext,
  type LfsLimits,
} from "../services/lfs/batch";
import { LfsStateService, validateAdoptStat } from "../services/lfs/state";
import {
  createLfsStore,
  LfsHashMismatchError,
  LfsSizeMismatchError,
  lfsKey,
  type LfsStore,
} from "../services/lfs/store";
import type { repositories } from "../db/schema";

type RepositoryRow = typeof repositories.$inferSelect;

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

/** The LFS family sub-routes (SPEC-0006 §2.1 table). */
export type LfsRouteKind = "batch" | "upload" | "download" | "verify" | "locks" | "not-found";

export interface LfsRoute {
  /** Decoded owner path segment (request casing; D1 lookups fold case). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed (§2.1). */
  repo: string;
  kind: LfsRouteKind;
  /** `objects/{oid}` first segment, when present (raw — validated per handler). */
  oid: string | null;
  /**
   * `objects/{oid}/{arg}` second segment: the declared size for PUT (upload)
   * or the base64url filename for GET (download). Null on bare `objects/{oid}`.
   */
  arg: string | null;
}

/**
 * Parse a repository-scoped pathname into an LFS route, or null when the path
 * is not under the `/:owner/:repo(.git)?/info/lfs` family (→ not ours; the
 * caller falls through). Shapes follow upstream's registrations
 * (`lfs.go:17-28`): POST objects/batch, PUT objects/{oid}/{size},
 * GET objects/{oid}[/{filename}], POST verify, locks/*, everything else (and
 * every method mismatch) is the `m.Any("/*", NotFound)` catch-all. Segment
 * handling mirrors the gate's parser (src/git-http/parse.ts): per-segment
 * decodeURIComponent, exactly one trailing `.git` trimmed, undecodable escapes
 * → not ours (the engine 404s them).
 */
export function parseLfsRoute(pathname: string, method: string): LfsRoute | null {
  const segments = pathname.split("/");
  // "/owner/repo/info/lfs[...]" → ["", owner, repo, "info", "lfs", ...rest]
  if (segments.length < 5) return null;
  const [empty, rawOwner, rawName, infoMarker, lfsMarker, ...rest] = segments;
  if (empty !== "" || rawOwner === undefined || rawName === undefined) return null;
  if (infoMarker !== "info" || lfsMarker !== "lfs") return null;

  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(rawOwner);
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  const repo = name.endsWith(".git") ? name.slice(0, -4) : name;

  const tail = rest.join("/");
  let kind: LfsRouteKind = "not-found";
  let oid: string | null = null;
  let arg: string | null = null;

  if (tail === "objects/batch") {
    kind = method === "POST" ? "batch" : "not-found";
  } else if (tail === "verify") {
    kind = method === "POST" ? "verify" : "not-found";
  } else if (tail === "locks" || tail.startsWith("locks/")) {
    kind = "locks"; // any method — P2 defer answers 501 for all of them
  } else if (tail.startsWith("objects/") && tail.length > "objects/".length) {
    const value = tail.slice("objects/".length);
    const slash = value.indexOf("/");
    if (slash === -1) {
      // objects/{oid}: GET only (the PUT shape carries the size segment).
      if (method === "GET") {
        kind = "download";
        oid = value;
      }
    } else {
      const first = value.slice(0, slash);
      const second = value.slice(slash + 1);
      if (!second.includes("/")) {
        if (method === "PUT") {
          kind = "upload";
          oid = first;
          arg = second;
        } else if (method === "GET") {
          kind = "download";
          oid = first;
          arg = second;
        }
      }
    }
  }

  return { owner, repo, kind, oid, arg };
}

// ---------------------------------------------------------------------------
// Response shapes (upstream writeStatusMessage / requireAuth)
// ---------------------------------------------------------------------------

/** Go `http.StatusText` for the statuses the family answers with. */
function statusText(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 404:
      return "Not Found";
    case 411:
      return "Length Required";
    case 413:
      return "Request Entity Too Large";
    case 415:
      return "Unsupported Media Type";
    case 416:
      return "Requested Range Not Satisfiable";
    case 422:
      return "Unprocessable Entity";
    case 500:
      return "Internal Server Error";
    case 501:
      return "Not Implemented";
    default:
      return "Unknown";
  }
}

/** `writeStatusMessage` (`server.go:530-540`): LFS media type + JSON message. */
export function lfsError(status: number, message?: string, headers?: Record<string, string>): Response {
  return new Response(`${JSON.stringify({ message: message ?? statusText(status) })}\n`, {
    status,
    headers: { "content-type": LFS_MEDIA_TYPE, ...headers },
  });
}

/**
 * `requireAuth` (`server.go:632-635`): the gitea-lfs realm challenge. The body
 * is the JSON `writeStatus(401)` shape, not the git-HTTP plain text.
 */
export function lfsChallenge(): Response {
  return lfsError(401, "Unauthorized", { "www-authenticate": 'Basic realm="gitea-lfs"' });
}

/**
 * The §2.1 catch-all row — upstream registers `m.Any("/*", http.NotFound)`
 * (`lfs.go:29`), i.e. Go's stdlib plain-text 404, NOT the LFS JSON
 * `writeStatusMessage` shape (which only the handlers use).
 */
export function lfsNotFound(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// Auth — the §2.2 split, mirrored on the git-HTTP ACL pipeline
// ---------------------------------------------------------------------------

/** "upload" op ⇒ write, "download"/GET ⇒ read (§2.1 route table). */
export type LfsOp = "read" | "write";

/** The D1-resolved repo triple the gate's pipeline produces. */
export interface ResolvedLfsRepo {
  repo: RepositoryRow;
  owner: AuthUser | null;
  ownerVisibility: "public" | "limited" | "private";
}

/**
 * Decide an LFS request's authorization. Mirrors `authorizeGitHttp`
 * (credentials → failure limiter → token verify → scope → account status →
 * grants) with upstream's LFS outcomes: no-access challenges (401 + gitea-lfs
 * realm) instead of the git-HTTP 404 mask (SPEC-0006 §2.2 divergence note).
 * Returns true to serve, or the response to send.
 */
export async function authorizeLfs(input: {
  req: Request;
  env: Env;
  waitUntil: (promise: Promise<void>) => void;
  op: LfsOp;
  repo: RepositoryRow;
  owner: AuthUser | null;
  ownerVisibility: ResolvedLfsRepo["ownerVisibility"];
}): Promise<Response | true> {
  const { req, env, op, repo, owner } = input;

  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  const credential =
    parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);

  const ownerActive = owner !== null && owner.status === "active";
  const publiclyVisible = repo.visibility === "public" && ownerActive && input.ownerVisibility === "public";

  if (credential === null) {
    // Anonymous: only reads of a publicly visible repo pass (§5 ACL matrix:
    // anonymous download ok, upload 401); everything else challenges.
    if (op === "read" && publiclyVisible) return true;
    return lfsChallenge();
  }

  // Credential path: same limiter discipline as the git-HTTP gate (SPEC-0002
  // §2.7) — anonymous requests have nothing to brute-force. The limiter's
  // calls fail open (ef2c049): a broken limiter must not 500 the request it
  // guards; verification below stays fail-closed.
  const now = new Date();
  const limiter = new D1FailureLimiter(env.DB);
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) return rateLimited(verdict.retryAfterSeconds);

  let verified: VerifiedAuth | null;
  try {
    verified = await new TokenService(env.DB).verify(credential, { now });
  } catch {
    // D1 unavailable mid-request: fail closed, never fail open (SPEC-0002 §4.5).
    return new Response("internal server error\n", {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  if (verified === null) {
    input.waitUntil(limiterRecordFailureFailOpen(limiter, ip, now));
    return lfsChallenge();
  }

  const scope = ScopeSet.parseLenient(verified.token.scopes);
  input.waitUntil(limiterResetFailOpen(limiter, ip));
  input.waitUntil(
    new TokenService(env.DB).needsLastUsedTouch(verified.token, now)
      ? new TokenService(env.DB).touchLastUsed(verified.token.id, now)
      : Promise.resolve(),
  );

  // Row 7 parity: known token lacking the repository-category scope → 403.
  const required = op === "read" ? "read:repository" : "write:repository";
  if (!scope.has(required)) return scopeForbidden();

  // Row 11 parity: disabled/prohibited doer; then upstream httpBase's
  // owner-status check (applies to every caller, owner included).
  if (verified.user.status === "prohibited") return accountDisabled();
  if (owner !== null && owner.status === "prohibited") return ownerUnavailable();

  // Grant model identical to the git-HTTP matrix (M1: owner + site admin;
  // limited owners expose public repos to any authenticated principal),
  // except the failure outcome: upstream's LFS routes challenge where
  // git-HTTP 404s (§2.2) — the challenge is issued regardless, so existence
  // is not disclosed either way.
  const isOwner = owner !== null && verified.user.id === owner.id;
  const isSiteAdmin = verified.user.isAdmin;
  const canRead =
    publiclyVisible ||
    isOwner ||
    isSiteAdmin ||
    (repo.visibility === "public" && ownerActive && input.ownerVisibility === "limited");
  const maskedByPublicOnly = scope.publicOnly && !publiclyVisible;
  if (!canRead || maskedByPublicOnly) return lfsChallenge();

  if (op === "write") {
    // §4.11: archived repos refuse LFS writes (platform-consistent with the
    // git-HTTP row 10; reads unaffected).
    if (repo.isArchived) return repositoryArchived();
    if (!isOwner && !isSiteAdmin) return lfsChallenge();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface LfsDeps {
  state: LfsStateService;
  store: LfsStore;
  limits: LfsLimits;
  now: () => Date;
}

/**
 * Production deps: relay store by default — presign requires S3 credentials
 * that arrive as wrangler secrets (`createLfsStore` probes, §2.3 fallback).
 */
export function defaultLfsDeps(env: Env): LfsDeps {
  return {
    state: new LfsStateService(env.DB),
    store: createLfsStore(env.REPO_PACKS),
    limits: DEFAULT_LFS_LIMITS,
    now: () => new Date(),
  };
}

/**
 * The gate's LFS branch: resolve the repo through the existing D1 pipeline
 * (row → redirect row 13), then dispatch to the family. D1-missing repos fall
 * through to the engine untouched — byte-identical with the pre-LFS behavior
 * (the transitional passthrough that keeps the e2e suite working).
 */
export async function handleLfsGateBranch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  lfs: LfsRoute,
): Promise<Response> {
  const ownerLower = lfs.owner.toLowerCase();
  const repoLower = lfs.repo.toLowerCase();
  const resolved = await resolveRepository(env.DB, ownerLower, repoLower);
  if (resolved === null) {
    // Row 13: a renamed/transferred repo's old URL 301s to the canonical
    // path before any auth challenge (§2.5.3) — LFS URLs included.
    const redirect = await lookupRedirect(env.DB, ownerLower, repoLower);
    if (redirect !== null) return redirectPermanent(req.url, redirect.ownerNamespace, redirect.slug);
    return engine.fetch(req, env, ctx);
  }
  return serveLfs(req, env, (p) => ctx.waitUntil(p), lfs, resolved, defaultLfsDeps(env));
}

/** Serve one LFS family request against a resolved repo. */
export async function serveLfs(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  // Route-level decisions before auth (upstream: routing first; the §2.1
  // catch-all row carries no auth).
  if (lfs.kind === "not-found") return lfsNotFound();
  if (lfs.kind === "locks") return lfsError(501); // §2.7 P2

  try {
    switch (lfs.kind) {
      case "batch":
        return await handleBatch(req, env, waitUntil, lfs, resolved, deps);
      case "verify":
        return await handleVerify(req, env, waitUntil, lfs, resolved, deps);
      case "upload":
        return await handleUpload(req, env, waitUntil, lfs, resolved, deps);
      case "download":
        return await handleDownload(req, env, waitUntil, lfs, resolved, deps);
    }
  } catch (error) {
    // Store/D1 failures: upstream answers `writeStatus(500)` with the LFS JSON
    // shape (§2.3 verify notes) — never a raw crash page inside the family.
    console.error(
      `[lfs] ${lfs.owner}/${lfs.repo} ${lfs.kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return lfsError(500);
  }
  // Unreachable via parseLfsRoute (locks/not-found are answered above);
  // defensive tail for hand-built routes.
  return lfsNotFound();
}

// ---------------------------------------------------------------------------
// Batch (§2.2)
// ---------------------------------------------------------------------------

/**
 * Batch bodies are JSON envelopes, but the endpoint takes unauthenticated
 * input: cap the read instead of trusting the client (the per-batch object
 * cap alone cannot bound a hostile body). 10 MiB is orders of magnitude above
 * any legitimate batch (100 objects × ~200 B).
 */
export const LFS_BATCH_BODY_MAX_BYTES = 10 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the batch cap");
    this.name = "BodyTooLargeError";
  }
}

/** Stream the request body to a string with a hard cap (AGENTS.md: never an
 *  unbounded `await req.text()`). */
async function readBodyCapped(req: Request, cap: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number.parseInt(declared, 10) > cap) throw new BodyTooLargeError();
  if (req.body === null) return "";
  let total = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) throw new BodyTooLargeError();
      controller.enqueue(chunk);
    },
  });
  return new Response(req.body.pipeThrough(counting)).text();
}

async function handleBatch(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  // Upstream `CheckAcceptMediaType` (batch + verify only; §4.9).
  if (!acceptsLfsMediaType(req.headers.get("accept"))) return lfsError(415);

  let text: string;
  try {
    text = await readBodyCapped(req, LFS_BATCH_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return lfsError(413);
    throw error;
  }
  let request;
  try {
    request = parseBatchRequest(text, deps.limits);
  } catch (error) {
    if (error instanceof BatchRequestError) return lfsError(error.status, error.message);
    throw error;
  }

  // `upload` op mutates (rows + hrefs), `download` only reads (§2.1 table).
  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: request.operation === "upload" ? "write" : "read",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  const objects = await shapeBatchResponse(request, shapingContext(req, lfs, resolved), {
    state: deps.state,
    store: deps.store,
    limits: deps.limits,
    now: deps.now(),
  });
  return new Response(`${JSON.stringify({ objects })}\n`, {
    status: 200,
    headers: { "content-type": LFS_MEDIA_TYPE },
  });
}

function shapingContext(req: Request, lfs: LfsRoute, resolved: ResolvedLfsRepo): BatchShapingContext {
  return {
    repoId: lfsRepoId(resolved.repo.id),
    storageKey: resolved.repo.storageKey,
    owner: lfs.owner,
    repo: lfs.repo,
    origin: new URL(req.url).origin,
    authHeader: req.headers.get("authorization"),
  };
}

/**
 * Numeric repo key for `lfs_objects.repo_id` — the landed state service is
 * typed `number` (DDL: INTEGER) while `repositories.id` is a uuid string.
 * Derived deterministically from the uuid's first 13 hex chars (52 bits,
 * float64-safe); v4-uuid collisions are improbable. TODO(drizzle migration):
 * make `lfs_objects.repo_id` a TEXT reference to `repositories.id` when the
 * table moves into schema.ts and drop this bridge.
 */
export function lfsRepoId(repoUuid: string): number {
  return Number.parseInt(repoUuid.replaceAll("-", "").slice(0, 13), 16);
}

// ---------------------------------------------------------------------------
// Upload (§2.3 relay PUT)
// ---------------------------------------------------------------------------

async function handleUpload(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  // Pointer-from-path validation before auth (upstream order, server.go:310-321;
  // message wording per getAuthenticatedMeta's pointer-validation 422).
  const oid = lfs.oid ?? "";
  const size = lfs.arg !== null && /^\d+$/.test(lfs.arg) ? Number(lfs.arg) : -1;
  if (!isValidPointerFields(oid, size)) return lfsError(422, "Oid or size are invalid");

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "write",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  // The store's streaming put needs a known length to enforce the declared
  // size (FixedLengthStream discipline); git-lfs basic always sends one →
  // 411 otherwise (SPEC-0006 §2.3).
  if (req.headers.get("content-length") === null) return lfsError(411);

  const repoId = lfsRepoId(resolved.repo.id);
  const key = lfsKey(resolved.repo.storageKey, oid);
  const now = deps.now();

  // Bytes present AND linked to this repo with agreeing sizes: skip the body
  // check (upstream server.go:328-339, tightened to require the size match).
  // Present without a row, or sizes in disagreement: stream the body through
  // the hash-and-forward put — the re-hash is the proof of possession (and a
  // mismatching row is refreshed only by a proven re-upload).
  const [row, stat] = await Promise.all([deps.state.get(repoId, oid), deps.store.head(key)]);
  if (row !== null && row.size === size && stat !== null && stat.size === size) {
    return lfsError(200); // upstream writeStatus(200): LFS JSON {"message":"OK"}
  }

  try {
    await deps.store.put(key, req.body ?? new Uint8Array(0), { size, expectedSha256Hex: oid });
  } catch (error) {
    if (error instanceof LfsHashMismatchError || error instanceof LfsSizeMismatchError) {
      // The store already deleted the object (mismatch ⇒ no bytes left).
      return lfsError(422, error.message);
    }
    throw error;
  }
  // NewLFSMetaObject insert-if-absent semantics: the row stays `uploading`
  // until verify (or adopt/sweep) promotes it (§3.3).
  await deps.state.ensureUploading(repoId, oid, size, now);
  return lfsError(200);
}

// ---------------------------------------------------------------------------
// Verify (§2.3)
// ---------------------------------------------------------------------------

async function handleVerify(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  // Upstream `CheckAcceptMediaType` (§4.9).
  if (!acceptsLfsMediaType(req.headers.get("accept"))) return lfsError(415);

  // Upstream decodeJSON failure → 422 (not 400) on this route; bodies are
  // ~100 bytes — the cap only bounds hostile input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBodyCapped(req, 4096)) as unknown;
  } catch {
    return lfsError(422);
  }
  if (typeof parsed !== "object" || parsed === null) return lfsError(422);
  const pointer = parsed as { oid?: unknown; size?: unknown };
  if (typeof pointer.oid !== "string" || typeof pointer.size !== "number") return lfsError(422);
  const { oid, size } = pointer;
  if (!isValidPointerFields(oid, size)) return lfsError(422, "Oid or size are invalid");

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "write",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  const repoId = lfsRepoId(resolved.repo.id);
  const stat = await deps.store.head(lfsKey(resolved.repo.storageKey, oid));
  // Relay mode verifies existence + size; presign mode additionally requires
  // the stored checksum to equal the oid (§2.3 verify notes).
  if (!validateAdoptStat(stat, oid, size, { requireChecksum: deps.store.mode === "presign" })) {
    return lfsError(404);
  }

  // Flip `uploading → verified`; a missing row adopts (§3.3 self-heal for a
  // lost batch row write, §4.13).
  if (!(await deps.state.markVerified(repoId, oid, deps.now()))) {
    await deps.state.insertVerified(repoId, oid, size, deps.now());
  }
  return lfsError(200);
}

// ---------------------------------------------------------------------------
// Download (§2.3 relay GET)
// ---------------------------------------------------------------------------

interface ParsedRange {
  offset: number;
  /** Inclusive end byte (for Content-Range). */
  end: number;
  length: number;
}

/** Upstream `rangeHeaderRegexp` (`bytes=(\d+)-(\d*)`) + its status handling. */
function parseRange(header: string | null, size: number): ParsedRange | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d+)-(\d*).*$/.exec(header);
  if (match === null) return null;
  const from = Number.parseInt(match[1] as string, 10);
  if (from >= size) return "unsatisfiable";
  let to = size - 1;
  const rawTo = match[2];
  if (rawTo !== undefined && rawTo !== "") {
    const candidate = Number.parseInt(rawTo, 10);
    if (candidate >= from && candidate < to) to = candidate;
  }
  return { offset: from, end: to, length: to + 1 - from };
}

/** base64url (no padding) segment decode; null ⇒ param ignored (§4.14). */
function decodeFilenameSegment(raw: string): string | null {
  if (raw === "" || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const padded = `${raw}${"=".repeat((4 - (raw.length % 4)) % 4)}`;
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** `mime.FormatMediaType("attachment", {filename})` equivalent (upstream
 *  `EncodeContentDispositionAttachment`): quoted string for safe printable
 *  ascii, RFC 5987 `filename*` for anything else. */
function contentDisposition(filename: string): string {
  if (/^[\x20-\x7e]+$/.test(filename) && !/["\\]/.test(filename)) {
    return `attachment; filename="${filename}"`;
  }
  const encoded = [...new TextEncoder().encode(filename)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  return `attachment; filename*=utf-8''${encoded}`;
}

async function handleDownload(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  // `getAuthenticatedMeta` order: pointer validation (422) → auth → row (404).
  const oid = lfs.oid ?? "";
  if (!isValidPointerFields(oid, 0)) return lfsError(422, "Oid or size are invalid");

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "read",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  const repoId = lfsRepoId(resolved.repo.id);
  const meta = await deps.state.get(repoId, oid);
  if (meta === null) return lfsError(404);

  const range = parseRange(req.headers.get("range"), meta.size);
  if (range === "unsatisfiable") return lfsError(416);

  const content = await deps.store.get(
    lfsKey(resolved.repo.storageKey, oid),
    range === null ? {} : { range: { offset: range.offset, length: range.length } },
  );
  if (content === null) return lfsError(404); // row but object gone (GC race)

  const servedLength = range === null ? meta.size : range.length;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    // Parity header: protects the length against reverse proxies/compression
    // (server.go:172-173); carries the served byte count, range included.
    "x-gitea-lfs-content-length": String(servedLength),
    "content-length": String(servedLength),
    ...(range !== null
      ? {
          "content-range": `bytes ${range.offset}-${range.end}/${meta.size}`,
          "access-control-expose-headers": "Content-Range",
        }
      : {}),
  };
  if (lfs.arg !== null) {
    const filename = decodeFilenameSegment(lfs.arg);
    if (filename !== null) {
      headers["content-disposition"] = contentDisposition(filename);
      headers["access-control-expose-headers"] = "Content-Disposition";
    }
  }
  // FixedLengthStream makes the declared length authoritative for the
  // streamed body (a short R2 read fails the pipe instead of hanging).
  const body = content.body.pipeThrough(new FixedLengthStream(servedLength));
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
