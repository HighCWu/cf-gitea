import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { IssueNotExistError } from "../../issues/errors";
import { issueAttachments, comments, issues } from "../../db/schema";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { attachmentSchema } from "../models/release";
import {
  AssetSizeMismatchError,
  AssetTooLargeError,
  MalformedMultipartError,
  parseMultipartParts,
  readTextFieldPart,
  readableStreamFromGenerator,
} from "../services/release-assets";
import { findIssueByRepoAndIndex, findRepoCommentById, commentNotExistError, issueErrorToApiError } from "../services/issues";
import { assertIssueRowUnit, assertIssuesOrPullsUnit, issuePullUnits } from "../services/issue-unit-gates";
import { assertNotBlockedForIssueContent } from "../services/blocks";
import {
  assertNotArchived,
  canWriteRepository,
  isRepositoryAdmin,
  requireVisibleRepo,
} from "../services/repo-access";
import type { RepositoryWithOwner } from "../services/repository";

/**
 * Issue + comment attachments (SPEC-0005 §3.3 — the last deferred issue-tag
 * batch; 10 ops). Upstream handlers: routers/api/v1/repo/issue_attachment.go
 * (the issue family) and issue_comment_attachment.go (the comment family) at
 * the submodule pin; registration api.go:1589-1600 (comment assets, inside
 * `mustEnableAttachments`) and :1645-1656 (issue assets), both under
 * `mustEnableIssuesOrPulls` and `tokenRequiresScopes(issue)`.
 *
 * Operations (5 + 5; declared response codes are exactly the frozen
 * contract's per op):
 *   - GET    /repos/{owner}/{repo}/issues/{index}/assets
 *     (issueListIssueAttachments, issue_attachment.go:74-114): {200,404}.
 *   - POST   /repos/{owner}/{repo}/issues/{index}/assets
 *     (issueCreateIssueAttachment, issue_attachment.go:117-214):
 *     {201,400,404,413,422,423}.
 *   - GET    …/{index}/assets/{attachment_id} (issueGetIssueAttachment,
 *     issue_attachment.go:25-71): {200,404}.
 *   - PATCH  …/{index}/assets/{attachment_id} (issueEditIssueAttachment,
 *     issue_attachment.go:217-283): {201,404,422,423} — upstream answers
 *     201 on edit verbatim.
 *   - DELETE …/{index}/assets/{attachment_id} (issueDeleteIssueAttachment,
 *     issue_attachment.go:286-334): {204,404,423}.
 *   - the identical five under /repos/{owner}/{repo}/issues/comments/{id}/
 *     assets (issueListIssueCommentAttachments :80-119,
 *     issueCreateIssueCommentAttachment :122-230 — the only op that declares
 *     403, issueGetIssueCommentAttachment :27-77,
 *     issueEditIssueCommentAttachment :233-296,
 *     issueDeleteIssueCommentAttachment :299-345).
 * The release-attachment family is NOT here (repoListReleaseAttachment et al
 * landed with routes/repo-extras-t2.ts + routes/release-assets.ts).
 *
 * ACL (ported, both families):
 *   - reads: repo visibility only (upstream repoAssignment +
 *     CanReadIssuesOrPulls — the landed anti-enumeration 404 matrix);
 *   - issue-family writes: canUserWriteIssueAttachment (issue_attachment.go:
 *     361-369) — the issue poster OR repo write (IsUserRepoAdmin/
 *     IsUserSiteAdmin/CanWriteIssuesOrPulls fold into canWriteRepository);
 *   - comment-family writes: canUserWriteIssueCommentAttachment
 *     (issue_comment_attachment.go:374-382) over CanSelfChangeOrAccessContent
 *     (services/issue/issue.go:322-336) — the comment poster OR repo write,
 *     and a locked issue (issues.is_locked) denies the poster-without-write.
 * Write order per the upstream middleware chain: repo 404 → archived 423
 * (mustNotBeArchived is a middleware; reads have none) → issue/comment 404 →
 * write grant 403 → body.
 *
 * Storage (the SPEC-0006 relay precedent, new key family):
 *   `repos/<storage_key>/attachments/<attachment-id>/<sanitized name>` in the
 *   shared REPO_PACKS bucket — sibling of `release-assets/` (SPEC-0005 §3.3),
 *   covered by the repo-prefix purge (§4.13). Row-first landing: the id is
 *   part of the R2 key, so the D1 row is inserted BEFORE the bytes stream and
 *   `r2_key`/`size` flip on completion (issue_attachments.r2_key nullable).
 *
 * Upload flow (both shapes on one row shape):
 *   1. inline (upstream wire): the POST carries the file — multipart
 *      `attachment` part (the contract's formData param) or
 *      `application/octet-stream` + `?name=` — and the bytes stream straight
 *      into R2 in the same request, single pass, never buffered (the
 *      services/release-assets.ts discipline; its MPU/pipe internals are
 *      module-private, so the compact twins live below).
 *   2. two-phase relay (the imports-relay shape): a POST with NO body and NO
 *      Content-Length creates the row only and answers 201 + the Attachment
 *      with a `Location` header pointing at the worker-internal relay PUT
 *      (an extra body field would be unknown-field drift for the compat
 *      suite); the client PUTs the raw bytes to
 *      /api/v1/repos/{o}/{r}/issues/attachments/{id}/blob (requireAuth +
 *      the family write gate + 411/413), and the bytes serve back from
 *      GET …/issues/attachments/{id}/blob (the issue-read ACL; bumps
 *      download_count like upstream's web ServeAttachment,
 *      routers/web/repo/attachment.go:213). Both relay routes are PLAIN
 *      hono routes OUTSIDE the generated OpenAPI document (routes/imports.ts
 *      discipline — check-openapi fails any declared path the frozen
 *      contract does not list).
 *
 * Size cap: 512 MiB — the landed asset/LFS convention (SPEC-0005 §3.3 "ours
 * fixed at 512 MiB until a settings SPEC", the constant twin of
 * MAX_RELEASE_ASSET_BYTES; upstream's attachment default is 2048 MiB).
 * Checked before streaming when Content-Length is known (413) and enforced
 * per chunk while streaming.
 *
 * Runtime-only statuses (emitted, undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch):
 *   - writes: 401 (requireAuth), 403 on the ISSUE family (the contract
 *     declares 403 only for comment-create — issue_attachment.go:364 fires
 *     for all three issue writes), 411 (missing Content-Length on inline
 *     uploads), 412 (mustEnableIssuesOrPulls — unreachable, every repo has
 *     the issues unit enabled), 500 (unexpected store failures);
 *   - the 422 arms of POST are declared but unreachable: upstream's 422 is
 *     the allowed-types rejection (issue_attachment.go:196-198) and this
 *     instance gates attachment types at no point (the release-assets.ts
 *     posture); PATCH's declared 422 fires on a malformed JSON body only.
 *
 * Documented divergences (upstream behavior vs this instance):
 *   - upstream CreateIssueAttachment bumps the issue's content_version via
 *     issue_service.ChangeContent (issue_attachment.go:208-211) and the
 *     comment create bumps the comment via UpdateComment
 *     (issue_comment_attachment.go:220-227) — cache-invalidation noise with
 *     no API-visible effect on unchanged content; skipped here (reads are
 *     D1-fresh).
 *   - a multipart body without an `attachment` part answers 400 (upstream's
 *     FormFile error surfaces as an empty-body 500);
 *   - an empty resolved name answers 400 "Could not determine name of
 *     attachment." (upstream would create a blank-named attachment);
 *   - PATCH renames the D1 row only — the stored object keeps its landing
 *     key (upstream likewise never moves the file);
 *   - the web `/attachments/{uuid}` download route behind
 *     browser_download_url is not landed (the release-assets.ts posture —
 *     the URL is emitted upstream-shaped; bytes download here via the API
 *     blob GET until the web route lands with the orchestrator's index.ts).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const attachmentListSchema = z.array(attachmentSchema);

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const indexParam = {
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue" }),
} as const;

const commentIdParam = {
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the comment" }),
} as const;

const attachmentIdParam = {
  attachment_id: z
    .string()
    .min(1)
    .openapi({ type: "integer", format: "int64", description: "id of the attachment" }),
} as const;

/**
 * EditAttachmentOptions (modules/structs) — inline (no component
 * registration; routes/repo-extras-t2.ts already registers the name).
 */
const editAttachmentOptionsSchema = z.object({
  name: z.string().optional().openapi({ description: "Name is the new filename for the attachment" }),
});

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const bodyBind422 = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Shared guards (the issue-t2.ts / issue-write-t2.ts twins)
// ---------------------------------------------------------------------------

type IssueRow = typeof issues.$inferSelect;
type CommentRow = typeof comments.$inferSelect;
type IssueAttachmentRow = typeof issueAttachments.$inferSelect;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Repo resolution + the issues-group UNIT gate (services/issue-unit-gates.ts):
 *  every route in this file sits in upstream's `/issues` subtree, closed by
 *  `mustEnableIssuesOrPulls` (api.go:1674 + api.go:720-746) after
 *  repoAssignment — unit-less repos 404 before any handler logic. */
async function requireVisibleIssuesRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const found = await requireVisibleRepo(c, path);
  await assertIssuesOrPullsUnit(c.env.DB, found);
  return found;
}

/** Issue-by-index lookup answering the upstream ErrIssueNotExist 404, then
 *  `getRepoIssueByIndexForDoer`'s unit narrowing (issue.go:998-1009): an
 *  issue whose own unit (issues vs pulls) is unreadable is the same bare 404
 *  — plain issues hide on a pulls-fallback repo. */
async function requireIssue(c: Context<ApiEnv>, found: RepositoryWithOwner, rawIndex: string): Promise<IssueRow> {
  const index = pathId(rawIndex);
  const issue = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, index);
  if (issue === null) {
    throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index }));
  }
  assertIssueRowUnit(await issuePullUnits(c.env.DB, found), issue.isPull);
  return issue;
}

/** getIssueCommentSafe (issue_comment_attachment.go:347-361) — the global
 *  comment id scoped through this repo, closed by that helper's unit
 *  narrowing (:352-355 CanReadIssuesOrPulls → APIErrorNotFound): a comment
 *  whose issue's own unit is unreadable is the same bare 404. */
async function requireComment(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  rawId: string,
): Promise<{ comment: CommentRow; issue: IssueRow }> {
  const commentId = pathId(rawId);
  const row = await findRepoCommentById(c.env.DB, found.repo.id, commentId);
  if (row === null) {
    // GetCommentWithRepoID miss → APIErrorAuto(ErrCommentNotExist).
    throw commentNotExistError(commentId);
  }
  assertIssueRowUnit(await issuePullUnits(c.env.DB, found), row.issue.isPull);
  return row;
}

/** ErrAttachmentNotExist.Error() (models/repo/attachment.go:87-89) — the id
 *  lookup carries no uuid, so the field renders empty like upstream's
 *  zero value. */
function attachmentNotExistError(id: number): ApiError {
  return new ApiError(404, `attachment does not exist [id: ${id}, uuid: ]`);
}

/**
 * canUserWriteIssueAttachment (issue_attachment.go:361-369): the issue
 * poster, a repo admin, a site admin, or issue/pull write. The landed
 * canWriteRepository folds the admin/site-admin/CanWriteIssuesOrPulls arms
 * (owner + push + write/admin collaborator rows), so the port is
 * poster-or-writer — the routes/issues.ts canEditIssue shape.
 */
async function canWriteIssueAttachment(c: Context<ApiEnv>, found: RepositoryWithOwner, issue: IssueRow): Promise<boolean> {
  const doer = c.get("authUser");
  if (doer === undefined) {
    return false;
  }
  if (issue.posterId !== null && doer.id === issue.posterId) {
    return true;
  }
  return canWriteRepository(c, found);
}

/**
 * canUserWriteIssueCommentAttachment (issue_comment_attachment.go:374-382)
 * over CanSelfChangeOrAccessContent (services/issue/issue.go:322-336): read
 * access (guaranteed — the repo is visible), then comment-poster-or-write,
 * then the IsLocked arm (a locked issue denies the poster without write).
 */
async function canWriteCommentAttachment(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  comment: CommentRow,
  issue: IssueRow,
): Promise<boolean> {
  const doer = c.get("authUser");
  if (doer === undefined) {
    return false;
  }
  const writer = await canWriteRepository(c, found);
  const isPoster = comment.posterId !== null && doer.id === comment.posterId;
  if (!isPoster && !writer) {
    return false;
  }
  if (issue.isLocked && !writer) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Attachment lookups (getIssueAttachmentSafeRead + the belongs-to arms)
// ---------------------------------------------------------------------------

/**
 * The issue-family attachment read (issue_attachment.go:349-359 +
 * attachmentBelongsToRepoOrIssue :371-387): the row must exist, belong to
 * this issue, and be a DIRECT issue attachment (comment_id = 0 — upstream's
 * `attachment.CommentID != 0 → "no such attachment in issue"` arm).
 */
async function findIssueAttachment(d1: D1Database, issueId: number, rawAttachmentId: string): Promise<IssueAttachmentRow> {
  const id = pathId(rawAttachmentId);
  const row = id <= 0 ? undefined : await drizzle(d1).select().from(issueAttachments).where(eq(issueAttachments.id, id)).get();
  if (row === undefined || row.issueId !== issueId || row.commentId !== 0) {
    throw new ApiError(404, row === undefined ? attachmentNotExistError(id).message : "no such attachment in issue");
  }
  return row;
}

/**
 * The comment-family attachment read (issue_comment_attachment.go:384-394 +
 * attachmentBelongsToRepoOrComment :396-413): the row must exist and belong
 * to this comment (the "attachment not in comment" re-check at :70-74 is
 * dead upstream — the belongs-to arm already guarantees the match — so the
 * belongs-to text is the only reachable 404 message).
 */
async function findCommentAttachment(d1: D1Database, commentId: number, rawAttachmentId: string): Promise<IssueAttachmentRow> {
  const id = pathId(rawAttachmentId);
  const row = id <= 0 ? undefined : await drizzle(d1).select().from(issueAttachments).where(eq(issueAttachments.id, id)).get();
  if (row === undefined || row.commentId !== commentId) {
    throw new ApiError(404, row === undefined ? attachmentNotExistError(id).message : "no such attachment in comment");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Storage: key layout + streaming (the services/release-assets.ts twins —
// its MPU/pipe internals are module-private, so the family twins live here)
// ---------------------------------------------------------------------------

/** SPEC-0005 §3.3 / the landed asset-LFS cap convention — 512 MiB. */
export const MAX_ISSUE_ATTACHMENT_BYTES = 512 * 1024 * 1024;

/** R2 multipart-upload part size for the multipart path (≥ 5 MiB minimum). */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The R2 key for an attachment (`repos/<storage_key>/attachments/<id>/<name>`,
 * the module header's layout). Every segment is format-gated before
 * concatenation (the LFS/release-assets key discipline): the storage key
 * must match the engine's key shape, the attachment id must be a positive
 * integer, and the name segment is reduced to `[A-Za-z0-9._-]` (display
 * names stay verbatim in D1) so `/`, `..` and control bytes can never
 * escape the prefix.
 */
export function issueAttachmentKey(storageKey: string, attachmentId: number, name: string): string {
  if (!STORAGE_KEY_RE.test(storageKey)) {
    throw new Error(`invalid repo storage key: ${storageKey}`);
  }
  if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    throw new Error(`invalid attachment id: ${attachmentId}`);
  }
  return `repos/${storageKey}/attachments/${attachmentId}/${sanitizeNameSegment(name)}`;
}

/** The R2 key's name segment: injection-proof, leading dots flattened
 *  (the services/release-assets.ts sanitizeAssetNameSegment twin). */
function sanitizeNameSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : "attachment";
}

/** Incremental sha-256 over forwarded chunks (the DigestStream discipline). */
class RunningDigest {
  private readonly digest = new crypto.DigestStream("SHA-256");
  private readonly writer = this.digest.getWriter();

  write(chunk: Uint8Array): Promise<void> {
    return this.writer.write(chunk).then(() => undefined);
  }

  async hex(): Promise<string> {
    await this.writer.close();
    return [...new Uint8Array(await this.digest.digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

/**
 * The octet-stream path: single-pass hash-and-forward (LFS putStream shape).
 * A known declared length inserts a FixedLengthStream so the R2 binding gets
 * its required known-length body and a lying Content-Length errors the pipe.
 */
async function streamIntoObject(
  bucket: R2Bucket,
  key: string,
  content: ReadableStream<Uint8Array>,
  digest: RunningDigest,
  declaredLength: number | undefined,
  limit: number,
): Promise<number> {
  let forwarded = 0;
  // The typed flush error (size mismatch / over-limit) and the
  // FixedLengthStream's anonymous abort race for the first rejection;
  // whichever surfaces, the typed error is the one worth mapping to a status.
  let typedError: Error | null = null;
  try {
    const hashAndForward = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        forwarded += chunk.byteLength;
        if (forwarded > limit) {
          const over = new AssetTooLargeError();
          typedError = over;
          throw over;
        }
        controller.enqueue(chunk);
        return digest.write(chunk);
      },
      flush() {
        // Typed check beats FixedLengthStream's anonymous abort.
        if (declaredLength !== undefined && forwarded !== declaredLength) {
          const mismatch = new AssetSizeMismatchError();
          typedError = mismatch;
          throw mismatch;
        }
      },
    });
    const sink =
      declaredLength === undefined
        ? hashAndForward.readable
        : hashAndForward.readable.pipeThrough(new FixedLengthStream(declaredLength));
    const put = bucket.put(key, sink);
    const pipe = content.pipeTo(hashAndForward.writable);
    const settled = await Promise.allSettled([put, pipe]);
    const rejected = settled.find((step) => step.status === "rejected");
    if (rejected !== undefined) {
      // The typed flush error (size mismatch / over-limit) and the
      // FixedLengthStream's anonymous abort race for the first rejection;
      // whichever surfaces, the typed error is the one worth mapping to a
      // status — prefer it over the stream-machinery wrapper.
      const reason: unknown = typedError ?? rejected.reason;
      throw reason;
    }
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  return forwarded;
}

/** The multipart path: bounded 8 MiB parts through an R2 multipart upload. */
async function streamIntoMultipartUpload(
  bucket: R2Bucket,
  key: string,
  content: ReadableStream<Uint8Array>,
  digest: RunningDigest,
  limit: number,
): Promise<number> {
  const mpu = await bucket.createMultipartUpload(key);
  const uploaded: R2UploadedPart[] = [];
  let partNumber = 1;
  let forwarded = 0;
  try {
    const buffer = new Uint8Array(UPLOAD_PART_BYTES);
    let filled = 0;
    const flush = async (): Promise<void> => {
      if (filled === 0) return;
      const body = buffer.slice(0, filled);
      uploaded.push(await mpu.uploadPart(partNumber, body));
      partNumber += 1;
      filled = 0;
    };
    const reader = content.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      forwarded += value.byteLength;
      if (forwarded > limit) {
        throw new AssetTooLargeError();
      }
      await digest.write(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const room = UPLOAD_PART_BYTES - filled;
        const count = Math.min(room, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === UPLOAD_PART_BYTES) {
          await flush();
        }
      }
    }
    await flush();
    if (uploaded.length === 0) {
      // Zero-byte asset: abort the (empty) MPU and store the empty object
      // directly — a multipart upload with no parts cannot be completed.
      await mpu.abort();
      await bucket.put(key, new Uint8Array(0));
      return forwarded;
    }
    await mpu.complete(uploaded);
  } catch (error) {
    try {
      await mpu.abort();
    } catch {
      // Already aborted/completed (or the sweep collects the parts) — abort
      // failures must not mask the original error.
    }
    throw error;
  }
  return forwarded;
}

export interface CreateAttachmentInput {
  bucket: R2Bucket;
  d1: D1Database;
  storageKey: string;
  issueId: number;
  /** 0 for a direct issue attachment; the comment id for comment assets. */
  commentId: number;
  uploaderId: number;
  name: string;
  content: ReadableStream<Uint8Array>;
  multipart: boolean;
  declaredLength?: number;
  /** Limit override — test seam for the 413 path (routes use the module const). */
  maxBytes?: number;
  now?: Date;
}

/**
 * Row-first landing (the module header): insert the `issue_attachments` row
 * to obtain the id the R2 key embeds, stream the bytes, then flip
 * r2_key/size/checksum on the row. Any failure removes both halves — the
 * R2 object (retryable confirm-ordering of release-assets.ts, inverted for
 * the row-first shape) and the pending row.
 */
export async function uploadIssueAttachment(input: CreateAttachmentInput): Promise<IssueAttachmentRow> {
  const now = input.now ?? new Date();
  const inserted = await drizzle(input.d1)
    .insert(issueAttachments)
    .values({
      uuid: crypto.randomUUID(),
      issueId: input.issueId,
      commentId: input.commentId,
      uploaderId: input.uploaderId,
      name: input.name,
      size: 0,
      downloadCount: 0,
      r2Key: null,
      createdAt: now,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("issue attachment row insert returned no row");
  }
  const key = issueAttachmentKey(input.storageKey, row.id, input.name);
  const digest = new RunningDigest();
  const limit = input.maxBytes ?? MAX_ISSUE_ATTACHMENT_BYTES;
  try {
    const size = await (input.multipart
      ? streamIntoMultipartUpload(input.bucket, key, input.content, digest, limit)
      : streamIntoObject(input.bucket, key, input.content, digest, input.declaredLength, limit));
    const checksumSha256 = await digest.hex();
    const updated = await drizzle(input.d1)
      .update(issueAttachments)
      .set({ r2Key: key, size, checksumSha256 })
      .where(eq(issueAttachments.id, row.id))
      .returning();
    const finalRow = updated[0];
    if (finalRow === undefined) {
      throw new Error("issue attachment row update returned no row");
    }
    return finalRow;
  } catch (error) {
    // Storage first, then the row: both idempotent, so a retry after a
    // partial failure sees no orphan and no ghost row.
    try {
      await input.bucket.delete(key);
    } catch {
      // the failed write never landed; nothing to clean
    }
    await drizzle(input.d1).delete(issueAttachments).where(eq(issueAttachments.id, row.id));
    throw error;
  }
}

/** The two-phase relay's row-only creation (no bytes yet; r2_key stays NULL). */
export async function createPendingAttachment(input: Omit<CreateAttachmentInput, "bucket" | "content" | "multipart" | "declaredLength" | "maxBytes">): Promise<IssueAttachmentRow> {
  const inserted = await drizzle(input.d1)
    .insert(issueAttachments)
    .values({
      uuid: crypto.randomUUID(),
      issueId: input.issueId,
      commentId: input.commentId,
      uploaderId: input.uploaderId,
      name: input.name,
      size: 0,
      downloadCount: 0,
      r2Key: null,
      createdAt: input.now ?? new Date(),
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("issue attachment row insert returned no row");
  }
  return row;
}

/** The services/release-assets.ts render twin — typed to this family's row
 *  (whose r2_key is nullable). `browser_download_url` is upstream's
 *  Attachment.DownloadURL: /attachments/ + the path-escaped uuid. */
function toApiAttachment(origin: string, row: IssueAttachmentRow): z.infer<typeof attachmentSchema> {
  return {
    id: row.id,
    name: row.name,
    created_at: row.createdAt === null || row.createdAt === undefined ? undefined : row.createdAt.toISOString(),
    download_count: row.downloadCount,
    size: row.size,
    uuid: row.uuid,
    browser_download_url: `${origin}/attachments/${encodeURIComponent(row.uuid)}`,
  };
}

// ---------------------------------------------------------------------------
// Inline-create body handling (the routes/release-assets.ts posture)
// ---------------------------------------------------------------------------

/** Extract the RFC 2046 boundary from a multipart Content-Type (null otherwise). */
function multipartBoundary(contentType: string): string | null {
  const match = /^\s*multipart\/form-data\s*(?:;|$)/i.exec(contentType);
  if (match === null) return null;
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  return boundary === undefined || boundary === "" ? null : boundary;
}

/** Map the streaming upload's typed failures onto upstream status codes. */
function attachmentErrorToApiError(error: unknown): ApiError | undefined {
  if (error instanceof AssetTooLargeError) {
    return new ApiError(413, "attachment is too large");
  }
  if (error instanceof MalformedMultipartError || error instanceof AssetSizeMismatchError) {
    return new ApiError(400, error.message);
  }
  return undefined;
}

/** The request body — a zero-byte stream when absent. */
function ensureBody(request: Request): ReadableStream<Uint8Array> {
  // The platform types the body's element as `any`; the wire contract here is
  // bytes, and the zero-byte stand-in covers a body-less Content-Length: 0 POST.
  const body = request.body as ReadableStream<Uint8Array> | null;
  return body ?? emptyStream();
}

/** A closed zero-byte stream. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** The declared Content-Length (null when absent or not a valid integer). */
function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The POST body contract shared by both create ops: capture the file source
 * and the resolved name, with the upstream name priority (query ?name= >
 * multipart `name` field > part filename) and the 400/411 arms. Returns
 * `{ relay: true }` for the body-less relay initiation (module header flow 2).
 */
async function readCreateBody(
  request: Request,
  queryName: string,
): Promise<{ relay: true } | { relay: false; content: ReadableStream<Uint8Array>; multipart: boolean; name: string }> {
  const declaredLength = contentLength(request);
  const rawBody = request.body as ReadableStream<Uint8Array> | null;
  if (declaredLength === null && rawBody === null) {
    if (queryName === "") {
      // A relay initiation still needs a name (?name= is the only source).
      throw new ApiError(400, "Could not determine name of attachment.");
    }
    return { relay: true };
  }
  if (declaredLength === null) {
    // 411 — the relay-store Content-Length discipline (the R2 binding needs
    // a known-length body on the octet path).
    throw new ApiError(411, "Content-Length header is required");
  }
  if (declaredLength > MAX_ISSUE_ATTACHMENT_BYTES) {
    throw new ApiError(413, "attachment is too large");
  }

  const contentType = request.headers.get("content-type") ?? "";
  const boundary = multipartBoundary(contentType);
  let filenameFromPart: string | null = null;
  let nameField: string | null = null;
  let content: ReadableStream<Uint8Array> | null = null;
  let multipart = false;
  if (boundary !== null) {
    // multipart/form-data: the `attachment` file part carries the bytes (its
    // filename names the asset unless overridden). Single pass — the loop
    // breaks once the file part is captured (a trailing `name` field is not
    // parsed; the contract's `?name=` query always wins and is
    // order-independent).
    multipart = true;
    for await (const part of parseMultipartParts(ensureBody(request), boundary)) {
      if (part.name === "attachment" && content === null) {
        filenameFromPart = part.filename;
        content = readableStreamFromGenerator(part.content);
        break;
      }
      if (part.name === "name") {
        const text = await readTextFieldPart(part);
        if (text !== "") nameField = text;
      } else {
        await readTextFieldPart(part); // drain unknown fields
      }
    }
  } else {
    // octet-stream (any non-multipart type, upstream's else branch): the
    // body IS the asset; ?name= is the only name source.
    content = ensureBody(request);
  }

  const name = queryName !== "" ? queryName : (nameField ?? filenameFromPart);
  if (name === null || name === "") {
    throw new ApiError(400, "Could not determine name of attachment.");
  }
  if (content === null) {
    // A multipart body with no `attachment` part (upstream FormFile fails
    // with an internal error; ours keeps the request-scoped 400 class).
    throw new ApiError(400, "no attachment file in request");
  }
  return { relay: false, content, multipart, name };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerIssueAttachmentRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // Shared create body (both families): guards → body → row-first upload.
  // `comment` switches the family (write gate); handlers render the 201
  // (hono's typed-response contract wants c.json at the handler).
  // -------------------------------------------------------------------------
  const prepareAttachmentCreate = async (
    c: Context<ApiEnv>,
    found: RepositoryWithOwner,
    issue: IssueRow,
    comment: CommentRow | null,
    queryName: string,
  ): Promise<{ row: IssueAttachmentRow; location: string | null }> => {
    // canUserWriteIssueAttachment / canUserWriteIssueCommentAttachment.
    const allowed =
      comment === null
        ? await canWriteIssueAttachment(c, found, issue)
        : await canWriteCommentAttachment(c, found, comment, issue);
    if (!allowed) {
      throw new ApiError(
        403,
        comment === null ? "user should have permission to write issue" : "user should have permission to edit comment",
      );
    }

    const uploaderId = c.get("authUser")?.id ?? 0;
    const parsed = await readCreateBody(c.req.raw, queryName);
    if (parsed.relay) {
      // Two-phase initiation: the row only, 201 + the upload URL in the
      // Location header (module header flow 2).
      const row = await createPendingAttachment({
        d1: c.env.DB,
        storageKey: found.repo.storageKey,
        issueId: issue.id,
        commentId: comment?.id ?? 0,
        uploaderId,
        name: queryName,
      });
      const origin = new URL(c.req.url).origin;
      const uploadUrl = `${origin}/api/v1/repos/${encodeURIComponent(found.repo.ownerNamespace)}/${encodeURIComponent(found.repo.slug)}/issues/attachments/${row.id}/blob`;
      return { row, location: uploadUrl };
    }

    try {
      const row = await uploadIssueAttachment({
        bucket: c.env.REPO_PACKS,
        d1: c.env.DB,
        storageKey: found.repo.storageKey,
        issueId: issue.id,
        commentId: comment?.id ?? 0,
        uploaderId,
        name: parsed.name,
        content: parsed.content,
        multipart: parsed.multipart,
        declaredLength: parsed.multipart ? undefined : contentLength(c.req.raw) ?? undefined,
      });
      return { row, location: null };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const mapped = attachmentErrorToApiError(error);
      throw mapped ?? error;
    }
  };

  // =========================================================================
  // The issue family — /repos/{owner}/{repo}/issues/{index}/assets[…]
  // =========================================================================

  const issueItemParams = { ...ownerRepoParams, ...indexParam, ...attachmentIdParam };

  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issues/{index}/assets",
      middleware: [optionalAuth],
      tags: ["issue"],
      summary: "List issue's attachments",
      operationId: "issueListIssueAttachments",
      request: { params: z.object({ ...ownerRepoParams, ...indexParam }) },
      responses: {
        200: { description: "AttachmentList", content: { "application/json": { schema: attachmentListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const rows = await drizzle(c.env.DB)
        .select()
        .from(issueAttachments)
        .where(and(eq(issueAttachments.issueId, issue.id), eq(issueAttachments.commentId, 0)))
        .orderBy(asc(issueAttachments.id))
        .all();
      const origin = new URL(c.req.url).origin;
      return c.json(rows.map((row) => toApiAttachment(origin, row)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/issues/{index}/assets",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Create an issue attachment",
      operationId: "issueCreateIssueAttachment",
      // The consumed body is multipart/form-data (`attachment` file part,
      // the contract's formData param) OR application/octet-stream — not
      // expressible as an OpenAPI-3 JSON schema (the release-assets.ts
      // posture); the raw body is read streaming, never via c.req.parseBody().
      request: {
        params: z.object({ ...ownerRepoParams, ...indexParam }),
        query: z.object({
          name: z.string().optional().openapi({ description: "name of the attachment" }),
        }),
      },
      responses: {
        201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        400: errorResponse,
        404: notFoundResponse,
        413: errorResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const created = await prepareAttachmentCreate(c, found, issue, null, c.req.valid("query").name ?? "");
      const origin = new URL(c.req.url).origin;
      return c.json(toApiAttachment(origin, created.row), 201, created.location === null ? {} : { Location: created.location });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}",
      middleware: [optionalAuth],
      tags: ["issue"],
      summary: "Get an issue attachment",
      operationId: "issueGetIssueAttachment",
      request: { params: z.object(issueItemParams) },
      responses: {
        200: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      const row = await findIssueAttachment(c.env.DB, issue.id, c.req.valid("param").attachment_id);
      return c.json(toApiAttachment(new URL(c.req.url).origin, row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Edit an issue attachment",
      operationId: "issueEditIssueAttachment",
      request: {
        params: z.object(issueItemParams),
        body: { content: { "application/json": { schema: editAttachmentOptionsSchema } } },
      },
      responses: {
        // upstream answers 201 on edit (issue_attachment.go:282) — kept verbatim
        201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      if (!(await canWriteIssueAttachment(c, found, issue))) {
        // runtime-only 403 on the issue family (the contract declares 403
        // only for comment-create) — issue_attachment.go:364.
        throw new ApiError(403, "user should have permission to write issue");
      }
      const row = await findIssueAttachment(c.env.DB, issue.id, c.req.valid("param").attachment_id);
      const form = c.req.valid("json");
      // Upstream renames only when a non-empty name arrives
      // (issue_attachment.go:268-271); there is no content to re-validate,
      // so the declared 422 arm (allowed-types, :273-279) stays unreachable.
      if (form.name !== undefined && form.name !== "") {
        await drizzle(c.env.DB).update(issueAttachments).set({ name: form.name }).where(eq(issueAttachments.id, row.id));
      }
      const updated = await drizzle(c.env.DB).select().from(issueAttachments).where(eq(issueAttachments.id, row.id)).get();
      if (updated === undefined) {
        throw attachmentNotExistError(row.id); // deleted concurrently mid-request
      }
      return c.json(toApiAttachment(new URL(c.req.url).origin, updated), 201);
    },
    bodyBind422,
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Delete an issue attachment",
      operationId: "issueDeleteIssueAttachment",
      request: { params: z.object(issueItemParams) },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const issue = await requireIssue(c, found, c.req.valid("param").index);
      if (!(await canWriteIssueAttachment(c, found, issue))) {
        // runtime-only 403 (issue_attachment.go:364) — undeclared for delete.
        throw new ApiError(403, "user should have permission to write issue");
      }
      const row = await findIssueAttachment(c.env.DB, issue.id, c.req.valid("param").attachment_id);
      // Storage first: a failed R2 delete leaves the D1 row intact and the
      // request retryable (upstream DeleteAttachment deletes the file too,
      // issue_attachment.go:328 repo_model.DeleteAttachment(ctx, a, true)).
      if (row.r2Key !== null) {
        await c.env.REPO_PACKS.delete(row.r2Key);
      }
      await drizzle(c.env.DB).delete(issueAttachments).where(eq(issueAttachments.id, row.id));
      return c.body(null, 204);
    },
  );

  // =========================================================================
  // The comment family — /repos/{owner}/{repo}/issues/comments/{id}/assets[…]
  // =========================================================================

  const commentItemParams = { ...ownerRepoParams, ...commentIdParam, ...attachmentIdParam };

  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issues/comments/{id}/assets",
      middleware: [optionalAuth],
      tags: ["issue"],
      summary: "List comment's attachments",
      operationId: "issueListIssueCommentAttachments",
      request: { params: z.object({ ...ownerRepoParams, ...commentIdParam }) },
      responses: {
        200: { description: "AttachmentList", content: { "application/json": { schema: attachmentListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      const target = await requireComment(c, found, c.req.valid("param").id);
      const rows = await drizzle(c.env.DB)
        .select()
        .from(issueAttachments)
        .where(eq(issueAttachments.commentId, target.comment.id))
        .orderBy(asc(issueAttachments.id))
        .all();
      const origin = new URL(c.req.url).origin;
      return c.json(rows.map((row) => toApiAttachment(origin, row)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/issues/comments/{id}/assets",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Create a comment attachment",
      operationId: "issueCreateIssueCommentAttachment",
      // The consumed body is multipart/form-data OR application/octet-stream
      // (formData `attachment` + query `name` in the vendored contract) —
      // the release-assets.ts posture; see the issue-family POST above.
      request: {
        params: z.object({ ...ownerRepoParams, ...commentIdParam }),
        query: z.object({
          name: z.string().optional().openapi({ description: "name of the attachment" }),
        }),
      },
      responses: {
        201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        400: errorResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
        413: errorResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const target = await requireComment(c, found, c.req.valid("param").id);
      const created = await prepareAttachmentCreate(c, found, target.issue, target.comment, c.req.valid("query").name ?? "");
      // CreateIssueCommentAttachment's blocked arm (issue_comment_attachment.go:
      // 218-227): the ErrBlockedUser check rides UpdateComment, i.e. AFTER the
      // write-permission gate AND after the attachment row + bytes land — the
      // blocked doer's 403 "user is blocked" leaves the row behind, upstream-
      // faithful (repo admin bypasses, IsUserRepoAdmin).
      const uploader = c.get("authUser");
      await assertNotBlockedForIssueContent(
        c.env.DB,
        { id: uploader.id ?? 0, isAdmin: uploader.is_admin === true },
        await isRepositoryAdmin(c, found),
        target.issue.posterId,
        found.repo.ownerId,
      );
      const origin = new URL(c.req.url).origin;
      return c.json(toApiAttachment(origin, created.row), 201, created.location === null ? {} : { Location: created.location });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}",
      middleware: [optionalAuth],
      tags: ["issue"],
      summary: "Get a comment attachment",
      operationId: "issueGetIssueCommentAttachment",
      request: { params: z.object(commentItemParams) },
      responses: {
        200: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      const target = await requireComment(c, found, c.req.valid("param").id);
      const row = await findCommentAttachment(c.env.DB, target.comment.id, c.req.valid("param").attachment_id);
      return c.json(toApiAttachment(new URL(c.req.url).origin, row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Edit a comment attachment",
      operationId: "issueEditIssueCommentAttachment",
      request: {
        params: z.object(commentItemParams),
        body: { content: { "application/json": { schema: editAttachmentOptionsSchema } } },
      },
      responses: {
        // upstream answers 201 on edit (issue_comment_attachment.go:295)
        201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const target = await requireComment(c, found, c.req.valid("param").id);
      if (!(await canWriteCommentAttachment(c, found, target.comment, target.issue))) {
        // runtime-only 403 for edit (undeclared) — :377.
        throw new ApiError(403, "user should have permission to edit comment");
      }
      const row = await findCommentAttachment(c.env.DB, target.comment.id, c.req.valid("param").attachment_id);
      const form = c.req.valid("json");
      if (form.name !== undefined && form.name !== "") {
        await drizzle(c.env.DB).update(issueAttachments).set({ name: form.name }).where(eq(issueAttachments.id, row.id));
      }
      const updated = await drizzle(c.env.DB).select().from(issueAttachments).where(eq(issueAttachments.id, row.id)).get();
      if (updated === undefined) {
        throw attachmentNotExistError(row.id); // deleted concurrently mid-request
      }
      return c.json(toApiAttachment(new URL(c.req.url).origin, updated), 201);
    },
    bodyBind422,
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}",
      middleware: [requireAuth],
      tags: ["issue"],
      summary: "Delete a comment attachment",
      operationId: "issueDeleteIssueCommentAttachment",
      request: { params: z.object(commentItemParams) },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleIssuesRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      const target = await requireComment(c, found, c.req.valid("param").id);
      if (!(await canWriteCommentAttachment(c, found, target.comment, target.issue))) {
        // runtime-only 403 for delete (undeclared) — :377.
        throw new ApiError(403, "user should have permission to edit comment");
      }
      const row = await findCommentAttachment(c.env.DB, target.comment.id, c.req.valid("param").attachment_id);
      if (row.r2Key !== null) {
        await c.env.REPO_PACKS.delete(row.r2Key);
      }
      await drizzle(c.env.DB).delete(issueAttachments).where(eq(issueAttachments.id, row.id));
      return c.body(null, 204);
    },
  );

  // =========================================================================
  // The worker-internal relay pair (PLAIN hono routes OUTSIDE the generated
  // OpenAPI document — the routes/imports.ts discipline; the frozen contract
  // lists no such paths). Module header "Upload flow" flows 2-3.
  // =========================================================================

  /** The relay row (repo-scoped): join the owning issue for the ACL gates. */
  const requireRelayAttachment = async (
    c: Context<ApiEnv>,
    path: { owner: string; repo: string },
    rawId: string,
  ): Promise<{ row: IssueAttachmentRow; issue: IssueRow; comment: CommentRow | null }> => {
    const found = await requireVisibleIssuesRepo(c, path);
    const id = pathId(rawId);
    const joined =
      id <= 0
        ? undefined
        : (
            await drizzle(c.env.DB)
              .select({ attachment: issueAttachments, issue: issues })
              .from(issueAttachments)
              .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
              .where(eq(issueAttachments.id, id))
              .limit(1)
          )[0];
    if (joined === undefined || joined.issue.repoId !== found.repo.id) {
      throw attachmentNotExistError(id);
    }
    const comment =
      joined.attachment.commentId === 0
        ? null
        : (await findRepoCommentById(c.env.DB, found.repo.id, joined.attachment.commentId))?.comment ?? null;
    return { row: joined.attachment, issue: joined.issue, comment };
  };

  // PUT …/issues/attachments/{id}/blob — the relay upload (module header
  // flow 2): family write gate, 423 archived, 411 without Content-Length,
  // 413 over the cap, one streaming pass into the row's key.
  app.put("/repos/:owner/:repo/issues/attachments/:attachmentId/blob", requireAuth, async (c) => {
    const path = { owner: c.req.param("owner") ?? "", repo: c.req.param("repo") ?? "" };
    const found = await requireVisibleIssuesRepo(c, path);
    const { row, issue, comment } = await requireRelayAttachment(c, path, c.req.param("attachmentId") ?? "");
    assertNotArchived(found);
    const allowed =
      comment === null
        ? await canWriteIssueAttachment(c, found, issue)
        : await canWriteCommentAttachment(c, found, comment, issue);
    if (!allowed) {
      throw new ApiError(
        403,
        comment === null ? "user should have permission to write issue" : "user should have permission to edit comment",
      );
    }
    const declaredLength = contentLength(c.req.raw);
    if (declaredLength === null) {
      throw new ApiError(411, "Content-Length header is required");
    }
    if (declaredLength > MAX_ISSUE_ATTACHMENT_BYTES) {
      throw new ApiError(413, "attachment is too large");
    }
    if (c.req.raw.body === null) {
      throw new ApiError(400, "missing attachment body");
    }
    const key = issueAttachmentKey(found.repo.storageKey, row.id, row.name);
    const digest = new RunningDigest();
    try {
      const size = await streamIntoObject(c.env.REPO_PACKS, key, c.req.raw.body as ReadableStream<Uint8Array>, digest, declaredLength, MAX_ISSUE_ATTACHMENT_BYTES);
      const checksumSha256 = await digest.hex();
      await drizzle(c.env.DB)
        .update(issueAttachments)
        .set({ r2Key: key, size, checksumSha256 })
        .where(eq(issueAttachments.id, row.id));
      return c.json({ attachment_id: row.id, bytes: size, sha256: checksumSha256, state: "ready" }, 200);
    } catch (error) {
      try {
        await c.env.REPO_PACKS.delete(key);
      } catch {
        // the failed write never landed; nothing to clean
      }
      if (error instanceof ApiError) throw error;
      const mapped = attachmentErrorToApiError(error);
      throw mapped ?? error;
    }
  });

  // GET …/issues/attachments/{id}/blob — the bytes download (module header
  // flow 3): the issue-read ACL (repo visibility), the upstream web-route
  // download-count increment (routers/web/repo/attachment.go:213), and a
  // streamed octet-stream body with Content-Disposition.
  app.get("/repos/:owner/:repo/issues/attachments/:attachmentId/blob", optionalAuth, async (c) => {
    const path = { owner: c.req.param("owner") ?? "", repo: c.req.param("repo") ?? "" };
    await requireVisibleIssuesRepo(c, path);
    const { row } = await requireRelayAttachment(c, path, c.req.param("attachmentId") ?? "");
    if (row.r2Key === null) {
      // created but never uploaded (the relay's pending arm)
      throw attachmentNotExistError(row.id);
    }
    const object = await c.env.REPO_PACKS.get(row.r2Key);
    if (object === null) {
      throw attachmentNotExistError(row.id);
    }
    await drizzle(c.env.DB)
      .update(issueAttachments)
      .set({ downloadCount: row.downloadCount + 1 })
      .where(eq(issueAttachments.id, row.id));
    const fallback = row.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return c.newResponse(object.body, 200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      ETag: object.httpEtag,
    });
  });
}
