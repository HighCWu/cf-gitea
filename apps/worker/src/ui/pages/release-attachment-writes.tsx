/**
 * The RELEASE-ATTACHMENT web WRITE arms (census B-55's attachment tails —
 * web.go:1523-1524 at the pin, mounted inside the releases WRITE group
 * (:1518-1525, gates `reqSignIn + context.RepoMustNotBeArchived() +
 * reqRepoReleaseWriter` over the group's reader pair)):
 *
 *   POST /{owner}/{repo}/releases/attachments          repo.UploadReleaseAttachment
 *   POST /{owner}/{repo}/releases/attachments/remove   repo.DeleteAttachment
 *
 * REPO-LEVEL paths, no release id: the dropzone uploads BEFORE any release
 * exists — upstream inserts `&Attachment{Name, UploaderID, RepoID}`
 * (attachment.go:61-65 via uploadAttachment → UploadAttachmentForRelease,
 * services/attachment/attachment.go:50-55), ReleaseID 0; the uuid rides the
 * release form's hidden `files` inputs and links to the release only at
 * submit (NewReleasePost/EditReleasePost's attachmentUUIDs, release.go:506).
 * The GET family of this namespace is the shared attachments-serving seam's
 * repo-scoped twin (web/attachments-serving.ts — web.go:1513), and the
 * sibling ISSUE mounts of the same upstream handlers landed already as
 * pages/issue-attachments-write.tsx — this module is that twin's RELEASE
 * face: the dropzone contract, the arm map and the response bytes are shared,
 * the store half differs (the release_assets table, releaseId 0 = unlinked).
 *
 * ## The dropzone contract (web_src/js/features/dropzone.ts, VERIFIED — the
 *    issue twin's header applies verbatim)
 *
 *   - UPLOAD: multipart `file` part → `{"uuid": …}` 200 (attachment.go:75-78).
 *   - REMOVE: urlencoded `file={uuid}` POST → `{"uuid": …}` 200
 *     (attachment.go:129-131; the JS ignores the body).
 *   - The release arm's element attrs (services/context/upload/upload.go:108-
 *     117 AddUploadContext "release"): UploadUrl/UploadRemoveUrl/UploadLinkUrl
 *     = {RepoLink}/releases/attachments[/remove], UploadAccepts = the Release
 *     AllowedTypes with `|`→`,` (frozen default "" — NO accept filter), Max 5
 *     files, MaxSize 2048 MiB; NeedUuidLink unset (no uuid link button —
 *     the release form's own attachment rows carry the names).
 *
 * ## Upload handler arm-by-arm (attachment.go:42-79, the SHARED body — the
 *    issue twin's arm map, re-derived at the release call)
 *
 *   1. `setting.Attachment.Enabled` → 404. Frozen TRUE (the issue twin's
 *      step-1 note; the FIXME at attachment.go:51-55 notwithstanding).
 *   2. `ctx.Req.FormFile("file")` — ANY failure (non-multipart, no `file`
 *      part, malformed body) is `ctx.ServerError` → 500. KEPT the web
 *      family's ServerError posture. STREAMED: the part rides the landed
 *      `parseMultipartParts` scanner straight into the store — never
 *      arrayBuffer on an unbounded body (AGENTS.md).
 *   3. Allowed-types gate (`upload.Verify` with the RELEASE settings) → 400.
 *      DEAD in this instance: the release AllowedTypes default is "" (all
 *      types allowed — repository.go:232), so the gate never fires at the
 *      frozen defaults.
 *   4. Size gate: `ErrContentTooLarge` → the NON-type error branch →
 *      ServerError 500 (attachment.go:66-72). Ours: the landed family cap
 *      `MAX_RELEASE_ASSET_BYTES` (512 MiB, SPEC-0005 §3.3) fires the
 *      streaming `AssetTooLargeError` → the SAME 500 outcome, with the
 *      cap-value divergence documented (upstream's Release.FileMaxSize
 *      default 2048 MiB, repository.go:234; the landed face fixed 512 until
 *      a settings SPEC — the release-assets module header's posture).
 *   5. Store: NewAttachment (attachment.go:19-35 — uuid, storage save,
 *      insert). OURS IS THE LANDED release_assets seam at the unlinked
 *      shape: one R2 object at `repos/<storage_key>/release-assets/0/
 *      <uuid>-<name>` + the D1 row with `releaseId: 0` — the 0 id is the
 *      seam's OWN unlinked discriminator (attachments-serving.ts:1073's
 *      unlinked-release arm: uploader-only serving, exactly upstream's
 *      TypeInvalid posture for a ReleaseID-0 row). The repo-prefix purge
 *      (SPEC-0005 §4.13) covers the key; listReleaseAssets never sees the
 *      row (eq releaseId). The R2 multipart-upload streaming (the part's
 *      length is unknowable from the whole-body Content-Length) re-derives
 *      the release-assets module's bounded 8 MiB-part streamer — that helper
 *      is module-private there, and this file is the ui family's own (the
 *      attachments-twin re-declaration convention).
 *   6. `ctx.JSON(200, {"uuid"})`.
 *
 * ## Remove arm
 *
 *   Upstream mounts the ONE DeleteAttachment handler at BOTH
 *   /issues/attachments/remove and /releases/attachments/remove — the landed
 *   port is issue-attachments-write.tsx's `removeAttachmentByUuid` (its
 *   header's step 2 derives exactly this: "the same DeleteAttachment …
 *   serves both mounts' recipes"), and this module simply rides it: the
 *   release half's repo-mismatch compare and the CanWrite(TypeReleases)
 *   grant are the landed release-half arms. The response builder is shared
 *   byte-for-byte (`{"uuid"}` 200 / http.Error 400/403/500).
 *
 * ## Divergences ledger (beyond the inline notes)
 *
 *   - the uuids uploaded here stay UNLINKED until the release form's write
 *     consumes its `files` field (upstream NewReleasePost/EditReleasePost);
 *     the landed release form write carries no `files` consumer — the
 *     uploads remain repo-scoped unlinked rows (visible to their uploader
 *     through the seam, never orphan-attached to a release). The form side
 *     is the release-form wave's surface, not this module's.
 *   - an empty part filename: inserted blank verbatim (the issue twin's
 *     note); the R2 KEY segment degrades to "asset" in the sanitizer.
 *   - `ctx.FormString` merges query + body (body wins) — the remove arm's
 *     reader (the issue twin's removeAttachmentFormValue) applies the same
 *     merge.
 */

import { drizzle } from "drizzle-orm/d1";

import {
  AssetTooLargeError,
  MalformedMultipartError,
  MAX_RELEASE_ASSET_BYTES,
  parseMultipartParts,
  readTextFieldPart,
  readableStreamFromGenerator,
} from "../../api/services/release-assets";
import { releaseAssets } from "../../db/schema";
import type { RepoRow } from "../ui-context";
import {
  dropzoneLocale,
  issueAttachmentRemoveResponse,
  removeAttachmentByUuid,
  removeAttachmentFormValue,
  type IssueAttachmentRemoveOutcome,
} from "./issue-attachments-write";
import type { Viewer } from "../viewer";

// ---------------------------------------------------------------------------
// The release dropzone fragment (repo/upload.tmpl over upload.go:108-117)
// ---------------------------------------------------------------------------

/** MaxFiles/MaxSize frozen defaults (repository.go:234-235) — client-side
 *  dropzone attributes only (the issue twin's divergence note). The release
 *  AllowedTypes default is the empty string → NO data-accepts attribute
 *  (dropzone.ts:110 treats an empty accepts like an unfiltered wildcard;
 *  upload.go:114's ReplaceAll of the empty string stays empty). */
export const RELEASE_ATTACHMENT_MAX_FILES = 5;
export const RELEASE_ATTACHMENT_MAX_SIZE_MIB = 2048;

/**
 * The release new/edit form's dropzone (repo/upload.tmpl verbatim — the
 * `{{if .IsAttachmentEnabled}}` block of new.tmpl:95-100; frozen enabled).
 * `repoLink` is `{{.RepoLink}}` = `/{owner}/{repo}`. NeedUuidLink UNSET
 * (upload.go:117's release arm carries no uuid-link flag — the release
 * form's own attachment rows render the names).
 */
export function ReleaseAttachmentsDropzone(props: { repoLink: string }) {
  return (
    <div
      class="dropzone"
      data-link-url={`${props.repoLink}/releases/attachments`}
      data-upload-url={`${props.repoLink}/releases/attachments`}
      data-remove-url={`${props.repoLink}/releases/attachments/remove`}
      data-max-file={RELEASE_ATTACHMENT_MAX_FILES}
      data-max-size={RELEASE_ATTACHMENT_MAX_SIZE_MIB}
      data-text-default-message={dropzoneLocale.defaultMessage}
      data-text-invalid-input-type={dropzoneLocale.invalidInputType}
      data-text-file-too-big={dropzoneLocale.fileTooBig}
      data-text-remove-file={dropzoneLocale.removeFile}
      data-text-copy-link={dropzoneLocale.copyLink}
    >
      <div class="files" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The upload arm (attachment.go:42-79 UploadReleaseAttachment)
// ---------------------------------------------------------------------------

/** The upload outcome: `ok` is the 200 JSON arm; `serverError` is upstream's
 *  `ctx.ServerError` class (the FormFile failures at :53-57, the over-cap
 *  ErrContentTooLarge falling through :66-72, and store failures) — the
 *  module header's arm map. The Enabled-404 and types-400 arms are dead
 *  (frozen on / release types default ""). */
export type ReleaseAttachmentUploadOutcome =
  | { readonly kind: "ok"; readonly uuid: string }
  | { readonly kind: "serverError"; readonly detail: string };

/** The multipart Content-Type boundary extractor — the API family's
 *  module-private `multipartBoundary` re-declared (the attachments-twin
 *  re-declaration convention, issue-attachments-write.tsx:388-394). */
function multipartBoundary(contentType: string): string | null {
  const match = /^\s*multipart\/form-data\s*(?:;|$)/i.exec(contentType);
  if (match === null) return null;
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  return boundary === undefined || boundary === "" ? null : boundary;
}

/** The storage-key format gate (release-assets.ts STORAGE_KEY_RE's shape). */
const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/** The R2 key's name segment: injection-proof, leading dots flattened — the
 *  release-assets sanitizer's verbatim re-declaration (module-private there;
 *  the unlinked 0-id key family shares its collision-free uuid prefix). */
function sanitizeAssetNameSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : "asset";
}

/**
 * The UNLINKED release-asset R2 key: the landed family layout with the 0 id
 * (release-assets.ts releaseAssetKey's shape — which REJECTS ids ≤ 0, the
 * linked rows' gate; the unlinked web-upload shape carries 0 exactly like
 * upstream's ReleaseID-0 rows). The repo-prefix purge covers it; the uuid
 * prefix keeps same-name uploads collision-free.
 */
function unlinkedReleaseAssetKey(storageKey: string, uuid: string, name: string): string {
  if (!STORAGE_KEY_RE.test(storageKey)) {
    throw new Error(`invalid repo storage key: ${storageKey}`);
  }
  return `repos/${storageKey}/release-assets/0/${uuid}-${sanitizeAssetNameSegment(name)}`;
}

/** The bounded 8 MiB part size (release-assets.ts UPLOAD_PART_BYTES's
 *  re-declaration — ≥ 5 MiB S3 minimum). */
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * Stream one asset part into R2 through a multipart upload (the release-assets
 * streamIntoMultipartUpload's verbatim re-derivation — module-private there;
 * bounded 8 MiB parts, per-chunk limit, sha-256 digest). Returns the byte
 * count and checksum; aborts the MPU on any failure so the orphan sweep
 * never sees confirmed bytes.
 */
async function streamIntoR2MultipartUpload(
  bucket: R2Bucket,
  key: string,
  content: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ size: number; checksumSha256: string }> {
  const digest = new crypto.DigestStream("SHA-256");
  const digestWriter = digest.getWriter();
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
      await digestWriter.write(value);
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
      // directly (a multipart upload with no parts cannot complete).
      await mpu.abort();
      await bucket.put(key, new Uint8Array(0));
    } else {
      await mpu.complete(uploaded);
    }
  } catch (error) {
    try {
      await mpu.abort();
    } catch {
      // Already aborted/completed (or the sweep collects the parts) — abort
      // failures must not mask the original error.
    }
    await digestWriter.close().catch(() => undefined);
    throw error;
  }
  await digestWriter.close();
  return { size: forwarded, checksumSha256: bytesToHex(new Uint8Array(await digest.digest)) };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * The upload seam: the multipart `file` part captured STREAMING (single
 * parse pass — parts before the file part are drained, the file part's
 * generator rides straight into the store, the issue twin's exact loop
 * shape) and landed row-first at the unlinked shape (`releaseId: 0`,
 * upstream's ReleaseID-0 insert). `uploaderId` is the signed doer (the
 * mount's reqSignIn fold guarantees it). `maxBytes` is the test seam for
 * the over-cap arm; production rides the family cap.
 */
export async function uploadReleaseAttachmentFromMultipart(
  env: Env,
  repo: RepoRow,
  uploaderId: number,
  request: Request,
  maxBytes: number = MAX_RELEASE_ASSET_BYTES,
): Promise<ReleaseAttachmentUploadOutcome> {
  // Arm 2 — FormFile("file"): the non-multipart / no-part / malformed arms
  // are ALL upstream's ServerError (:53-57).
  const boundary = multipartBoundary(request.headers.get("content-type") ?? "");
  if (boundary === null) {
    return {
      kind: "serverError",
      detail: "FormFile: request Content-Type isn't multipart/form-data",
    };
  }
  const body = request.body as ReadableStream<Uint8Array> | null;
  if (body === null) {
    return { kind: "serverError", detail: "FormFile: multipart without a body" };
  }

  let filename: string | null = null;
  let content: ReadableStream<Uint8Array> | null = null;
  try {
    for await (const part of parseMultipartParts(body, boundary)) {
      if (part.name === "file" && content === null) {
        filename = part.filename;
        content = readableStreamFromGenerator(part.content);
        break; // the file part captured — trailing fields are not parsed
      }
      await readTextFieldPart(part); // drain the fields Dropzone may precede the file with
    }
  } catch (error) {
    if (error instanceof MalformedMultipartError) {
      return { kind: "serverError", detail: `FormFile: ${error.message}` };
    }
    return { kind: "serverError", detail: `FormFile: ${String(error)}` };
  }
  if (content === null) {
    return { kind: "serverError", detail: "FormFile: no file part in the multipart body" };
  }
  const name = filename ?? "";

  // Arms 4-5 — the cap fires inside the store walk and maps to the SAME
  // ServerError outcome upstream's fall-through produces. Row-first: the
  // R2 landing completes, then the row inserts; a row failure deletes the
  // object (the §4.10 confirmed-bytes discipline, release-assets.ts:602).
  const uuid = crypto.randomUUID();
  let key: string;
  try {
    key = unlinkedReleaseAssetKey(repo.storageKey, uuid, name);
  } catch (error) {
    return { kind: "serverError", detail: `NewAttachment: ${String(error)}` };
  }
  try {
    const { size, checksumSha256 } = await streamIntoR2MultipartUpload(env.REPO_PACKS, key, content, maxBytes);
    try {
      await drizzle(env.DB).insert(releaseAssets).values({
        uuid,
        repoId: repo.id,
        releaseId: 0, // unlinked — the seam's uploader-only serving arm
        uploaderId,
        name,
        size,
        downloadCount: 0,
        r2Key: key,
        checksumSha256,
        createdAt: new Date(),
      });
    } catch (rowError) {
      await env.REPO_PACKS.delete(key); // confirmed bytes need their row
      return { kind: "serverError", detail: `NewAttachment: ${String(rowError)}` };
    }
    return { kind: "ok", uuid };
  } catch (error) {
    const detail = error instanceof AssetTooLargeError ? "attachment exceeds limit" : String(error);
    return { kind: "serverError", detail: `uploadAttachment(uploadFunc): ${detail}` };
  }
}

/**
 * `ctx.JSON(http.StatusOK, map[string]string{"uuid": …})` (attachment.go:
 * 75-78) — the dropzone JS contract byte-shape; the ServerError arm renders
 * the plain-text 500 (the issue twin's response builder shape).
 */
export function releaseAttachmentUploadResponse(outcome: ReleaseAttachmentUploadOutcome): Response {
  if (outcome.kind === "serverError") {
    return new Response(
      `uploadAttachment: ${outcome.detail}\n`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } },
    );
  }
  return new Response(JSON.stringify({ uuid: outcome.uuid }), {
    status: 200,
    headers: { "content-type": "application/json;charset=utf-8", "cache-control": "max-age=0, private, must-revalidate" },
  });
}

// ---------------------------------------------------------------------------
// The remove arm (attachment.go:82-132 — the shared DeleteAttachment; the
// landed port is issue-attachments-write.tsx's, ridden verbatim)
// ---------------------------------------------------------------------------

/** The remove outcome (the issue twin's union — the same upstream handler). */
export type ReleaseAttachmentRemoveOutcome = IssueAttachmentRemoveOutcome;

/** `ctx.FormString("file")` — the issue twin's reader (body then query). */
export function releaseAttachmentRemoveFormValue(form: URLSearchParams, url: URL): string {
  return removeAttachmentFormValue(form, url);
}

/** The remove seam (DeleteAttachment's body — the issue twin's port, whose
 *  release half IS this mount's arm set). */
export function removeReleaseAttachment(env: Env, repo: RepoRow, viewer: Viewer, file: string) {
  return removeAttachmentByUuid(env, repo, viewer, file);
}

/** The remove wire arm — the issue twin's builder byte-for-byte. */
export function releaseAttachmentRemoveResponse(outcome: ReleaseAttachmentRemoveOutcome): Response {
  return issueAttachmentRemoveResponse(outcome);
}
