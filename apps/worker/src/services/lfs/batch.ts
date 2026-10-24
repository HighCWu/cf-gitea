/**
 * LFS batch API v1 — request/response shaping (SPEC-0006 §2.2).
 *
 * Wire contract ported from upstream `services/lfs/server.go:186-293` and
 * `modules/lfs/shared.go`: the envelope is always `200` with per-object
 * results (object-level problems never fail the whole request, §4.8); JSON
 * decode failures, unknown operations and oversized batches are the only
 * whole-request errors (400/400/413). Error strings are upstream's, verbatim:
 *
 * - 422 "Oid or size are invalid"                    (invalid pointer fields)
 * - 422 "Object <oid> is not <size> bytes"           (declared size ≠ row size)
 * - 422 "Size must be less than or equal to <max>"   (upload, not yet stored)
 * - 404 "Not Found"                                  (download, absent object)
 * - 422 "LFS quota exceeded for repository"          (our addition, §4.7)
 *
 * Href strategy per §2.3: the store's capability probe decides — presigned
 * R2 URLs when `presignPut`/`presignGet` return a link, otherwise relay
 * endpoint paths with the caller's `Authorization` echoed. Relay shapes are
 * upstream's verbatim (`RepoGitURL + "/info/lfs/..."`), so the route wave can
 * mount them unchanged; the verify hop always stays on the Worker because it
 * flips D1 state.
 */

import { checksumHeaderFor, lfsKey, type LfsHref, type LfsStore } from "./store";
import { LfsStateService, validateAdoptStat } from "./state";

/** The LFS JSON media type — request and response (`modules/lfs/shared.go:16`). */
export const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
/**
 * Verify-action `Accept` workaround for git-lfs < 2.8.0 (upstream
 * `lfs_module.AcceptHeader`, echoed verbatim).
 */
export const LFS_ACCEPT_HEADER = "application/vnd.git-lfs+json;q=0.9, */*;q=0.8";

/** Default object size cap (SPEC-0006 §4.6; hard cap is R2's 5 GiB single PUT). */
export const DEFAULT_LFS_MAX_FILE_SIZE = 512 * 1024 * 1024;
/** R2 single-PUT ceiling — config above this is rejected at the boundary. */
export const LFS_MAX_FILE_SIZE_HARD_CAP = 5 * 1024 * 1024 * 1024;
/**
 * Default per-batch object cap. Upstream defaults to unlimited (0); Workers
 * isolates need a budget — documented divergence (SPEC-0006 §2.2,
 * `LFS_MAX_BATCH_SIZE`).
 */
export const DEFAULT_LFS_MAX_BATCH_SIZE = 100;
/** Default per-repo LFS quota (§4.7; 0 disables). */
export const DEFAULT_LFS_REPO_QUOTA = 10 * 1024 * 1024 * 1024;

export interface LfsLimits {
  /** 0 = unlimited (upstream default). */
  maxFileSize: number;
  /** 0 = unlimited (upstream default). */
  maxBatchSize: number;
  /** 0 = unlimited. */
  repoQuota: number;
}

export const DEFAULT_LFS_LIMITS: LfsLimits = {
  maxFileSize: DEFAULT_LFS_MAX_FILE_SIZE,
  maxBatchSize: DEFAULT_LFS_MAX_BATCH_SIZE,
  repoQuota: DEFAULT_LFS_REPO_QUOTA,
};

/** Whole-request batch failures (upstream `writeStatus` semantics). */
export class BatchRequestError extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "BatchRequestError";
  }
}

export type LfsBatchOperation = "upload" | "download";

export interface LfsBatchPointer {
  oid: string;
  size: number;
}

export interface LfsBatchRequest {
  operation: LfsBatchOperation;
  /** Accepted and ignored (upstream never reads them; basic always). */
  transfers?: string[];
  ref?: { name?: unknown };
  objects: LfsBatchPointer[];
}

/**
 * Upstream `CheckAcceptMediaType` (`server.go:104-112`): the first
 * `;`-segment of `Accept` must equal the LFS media type — no trimming, else
 * the caller answers 415.
 */
export function acceptsLfsMediaType(acceptHeader: string | null): boolean {
  return (acceptHeader ?? "").split(";")[0] === LFS_MEDIA_TYPE;
}

type RawBatchBody = {
  operation?: unknown;
  transfers?: unknown;
  ref?: unknown;
  objects?: unknown;
};

/**
 * Parse + validate a batch request body (already-decoded JSON or raw text).
 * Strict like upstream's typed decode: `operation` must be exactly
 * "upload"/"download" (400), each object must carry a string oid and an
 * integral number size (400 — Go's json would fail the decode), and the
 * object count is capped (413). `transfers`/`ref` are accepted and ignored.
 * A missing/empty `objects` array yields zero results (upstream loops a nil
 * slice), never an error.
 */
export function parseBatchRequest(body: unknown, limits: Pick<LfsLimits, "maxBatchSize">): LfsBatchRequest {
  let raw: unknown;
  if (typeof body === "string") {
    try {
      raw = JSON.parse(body);
    } catch {
      throw new BatchRequestError(400, "Bad Request");
    }
  } else {
    raw = body;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new BatchRequestError(400, "Bad Request");
  }
  const record = raw as RawBatchBody;

  let operation: LfsBatchOperation;
  switch (record.operation) {
    case "upload":
      operation = "upload";
      break;
    case "download":
      operation = "download";
      break;
    default:
      throw new BatchRequestError(400, "Bad Request");
  }

  const objects: LfsBatchPointer[] = [];
  if (record.objects !== undefined) {
    if (!Array.isArray(record.objects)) {
      throw new BatchRequestError(400, "Bad Request");
    }
    if (limits.maxBatchSize > 0 && record.objects.length > limits.maxBatchSize) {
      throw new BatchRequestError(413, "Request Entity Too Large");
    }
    for (const entry of record.objects) {
      if (typeof entry !== "object" || entry === null) {
        throw new BatchRequestError(400, "Bad Request");
      }
      const object = entry as { oid?: unknown; size?: unknown };
      if (typeof object.oid !== "string" || typeof object.size !== "number" || !Number.isInteger(object.size)) {
        throw new BatchRequestError(400, "Bad Request");
      }
      objects.push({ oid: object.oid, size: object.size });
    }
  }

  return {
    operation,
    ...(Array.isArray(record.transfers)
      ? { transfers: record.transfers.filter((t): t is string => typeof t === "string") }
      : {}),
    ...(typeof record.ref === "object" && record.ref !== null ? { ref: record.ref } : {}),
    objects,
  };
}

export interface BatchObjectError {
  code: number;
  message: string;
}

export interface BatchLink {
  href: string;
  header?: Record<string, string>;
  expires_at?: string;
  expires_in?: number;
}

export interface BatchObjectResponse {
  oid: string;
  size: number;
  /** `{}` means "already present — client skips the transfer" (upstream shape). */
  actions?: Record<string, BatchLink>;
  error?: BatchObjectError;
}

export interface BatchShapingContext {
  repoId: number;
  /** Immutable `r_<id>` storage key (SPEC-0003 §3.1) — never a repo name. */
  storageKey: string;
  owner: string;
  /** Repo name with any `.git` suffix already trimmed (§2.1 normalization). */
  repo: string;
  /** Request origin, no trailing slash (upstream `GuessCurrentAppURL`). */
  origin: string;
  /** Caller's `Authorization` header — echoed into relay hrefs verbatim. */
  authHeader: string | null;
}

export interface BatchDeps {
  state: LfsStateService;
  store: LfsStore;
  limits?: LfsLimits;
  now?: Date;
}

/** Upstream `requestContext.RepoGitURL` shape: `<origin>/<owner>/<repo>.git`. */
export function buildRelayHrefBase(ctx: Pick<BatchShapingContext, "origin" | "owner" | "repo">): string {
  return `${ctx.origin.replace(/\/+$/, "")}/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}.git/info/lfs`;
}

export function relayUploadHref(relayBase: string, oid: string, size: number): string {
  return `${relayBase}/objects/${oid}/${size}`;
}

export function relayDownloadHref(relayBase: string, oid: string): string {
  return `${relayBase}/objects/${oid}`;
}

export function relayVerifyHref(relayBase: string): string {
  return `${relayBase}/verify`;
}

/**
 * Upstream `Link.WithHeader` skips empty values — an anonymous relay href
 * carries no `Authorization` key at all.
 */
function withAuth(header: Record<string, string>, authHeader: string | null): Record<string, string> {
  return authHeader === null || authHeader === "" ? header : { ...header, Authorization: authHeader };
}

/** Upstream `Pointer.IsValid` (`modules/lfs/pointer.go:98-106`). */
export function isValidPointerFields(oid: string, size: number): boolean {
  return /^[0-9a-f]{64}$/.test(oid) && Number.isInteger(size) && size >= 0;
}

function errorObject(oid: string, size: number, code: number, message: string): BatchObjectResponse {
  return { oid, size, error: { code, message } };
}

/** Wire shape for a presigned link: LfsHref expiry fields are camelCase. */
function toBatchLink(href: LfsHref): BatchLink {
  return {
    href: href.href,
    ...(href.header !== undefined ? { header: href.header } : {}),
    ...(href.expiresAt !== undefined ? { expires_at: href.expiresAt } : {}),
    ...(href.expiresIn !== undefined ? { expires_in: href.expiresIn } : {}),
  };
}

/**
 * Shape one object result — the per-object table of §2.2, with §3.3 adopt
 * folded in. "Present" means row-verified (with the object still in R2) or
 * adoptable — strictly safer than upstream's global-store existence check,
 * because a repo-scoped checksum-bound key can only hold authorized bytes.
 */
export async function shapeBatchObject(
  pointer: LfsBatchPointer,
  operation: LfsBatchOperation,
  ctx: BatchShapingContext,
  deps: BatchDeps,
): Promise<BatchObjectResponse> {
  const { oid, size } = pointer;
  const limits = deps.limits ?? DEFAULT_LFS_LIMITS;
  const now = deps.now ?? new Date();

  if (!isValidPointerFields(oid, size)) {
    return errorObject(oid, size, 422, "Oid or size are invalid");
  }

  const meta = await deps.state.get(ctx.repoId, oid);
  if (meta !== null && meta.size !== size) {
    return errorObject(oid, size, 422, `Object ${oid} is not ${size} bytes`);
  }

  const key = lfsKey(ctx.storageKey, oid);
  const stat = await deps.store.head(key);
  const requireChecksum = deps.store.mode === "presign";

  let present: boolean;
  if (meta !== null && meta.state === "verified") {
    // Row says verified but the object vanished (GC race): self-heal by
    // re-issuing hrefs — ensureUploading demotes the row on the way (§3.3).
    present = stat !== null;
  } else if (validateAdoptStat(stat, oid, size, { requireChecksum })) {
    await deps.state.insertVerified(ctx.repoId, oid, size, now);
    present = true;
  } else {
    present = false;
  }

  if (present) {
    if (operation === "download") {
      return { oid, size, actions: { download: await buildDownloadHref(oid, ctx, deps) } };
    }
    // Empty actions ⇒ git-lfs skips the transfer (http_client.go:184-187);
    // upstream emits an empty map, not an absent key.
    return { oid, size, actions: {} };
  }
  if (operation === "download") {
    return errorObject(oid, size, 404, "Not Found");
  }

  // Upload op: guards run before any href is issued (upstream order,
  // server.go:268-278 — max size first, then our quota addition).
  if (limits.maxFileSize > 0 && size > limits.maxFileSize) {
    return errorObject(oid, size, 422, `Size must be less than or equal to ${limits.maxFileSize}`);
  }
  if (limits.repoQuota > 0 && (await deps.state.sumSize(ctx.repoId)) + size > limits.repoQuota) {
    return errorObject(oid, size, 422, "LFS quota exceeded for repository");
  }
  await deps.state.ensureUploading(ctx.repoId, oid, size, now);

  const relayBase = buildRelayHrefBase(ctx);
  const actions: Record<string, BatchLink> = {};

  const presigned = await deps.store.presignPut({
    key,
    checksumSha256Base64: checksumHeaderFor(oid),
    now,
  });
  if (presigned !== null) {
    actions.upload = toBatchLink(presigned);
  } else {
    // Upstream `UploadLink` + the chunked-transfer hint (server.go:510-515).
    actions.upload = {
      href: relayUploadHref(relayBase, oid, size),
      header: withAuth({ "Transfer-Encoding": "chunked" }, ctx.authHeader),
    };
  }

  // The verify hop always stays on the Worker: it flips D1 state (§2.3).
  actions.verify = {
    href: relayVerifyHref(relayBase),
    header: withAuth({ Accept: LFS_ACCEPT_HEADER }, ctx.authHeader),
  };

  return { oid, size, actions };
}

/**
 * Shape one download action href — presigned GET when the store can mint
 * one (bearer URL, no Authorization), else the relay path with the caller's
 * `Authorization` echoed (upstream `DownloadLink`, server.go:504-507).
 */
export async function buildDownloadHref(
  oid: string,
  ctx: BatchShapingContext,
  deps: BatchDeps,
): Promise<BatchLink> {
  const presigned = await deps.store.presignGet({ key: lfsKey(ctx.storageKey, oid), now: deps.now ?? new Date() });
  if (presigned !== null) return toBatchLink(presigned);
  const relayBase = buildRelayHrefBase(ctx);
  return { href: relayDownloadHref(relayBase, oid), header: withAuth({}, ctx.authHeader) };
}

/**
 * Shape a whole batch — one pass over objects; per-object results are
 * independent (§4.8), store/D1 failures surface as a whole-request error
 * (upstream answers 500 on storage errors, `server.go:236-241`).
 */
export async function shapeBatchResponse(
  request: LfsBatchRequest,
  ctx: BatchShapingContext,
  deps: BatchDeps,
): Promise<BatchObjectResponse[]> {
  return Promise.all(request.objects.map((pointer) => shapeBatchObject(pointer, request.operation, ctx, deps)));
}
