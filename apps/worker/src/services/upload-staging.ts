/**
 * The web editor's UPLOAD staging family (pages wave 70 wiring) — the three
 * pieces the committed upload-confirm page (ui/pages/repo-editor-tails.tsx,
 * f4492b2's HANDOFF NOTE) needs before its confirm POST can write:
 *
 *   1. the uuid staging store — upstream's `upload` table
 *      (models/repo/upload.go:30-33: `Upload{ID, UUID, Name}`) ported onto
 *      the shared REPO_PACKS R2 bucket: `newRepoUpload` / `getRepoUploadByUUID`
 *      / `getRepoUploadsByUUIDs` / `deleteRepoUploadByUUID` (upload.go:59-141).
 *   2. the dropzone endpoints — `uploadFileToServer` / `uploadRemoveFromServer`
 *      (routers/web/repo/editor_uploader.go:18-60): multipart `file` POST →
 *      `verifyUploadFileType` (services/context/upload/upload.go:52-103) →
 *      `cleanGitTreePath` (services/repository/files/file.go:143-155) →
 *      JSON `{"uuid"}`; remove POST (`file` = uuid) → 204. Exported as
 *      UNMOUNTED handlers — the orchestrator's index.ts mounts them at
 *      `/{owner}/{repo}/upload-file` + `/{owner}/{repo}/upload-remove`
 *      (web.go:1471-1475) behind the standard write gates (upstream wraps the
 *      pair in `MustBeAbleToUpload` + `reqRepoCodeWriter`, web.go:1475 — the
 *      upload.Enabled toggle does not exist here yet, so the mount gates with
 *      the family's `canWriteRepo` per the repo-editor-tails handoff).
 *   3. the commit arm — `commitUploadFromForm` over `uploadRepoFiles`
 *      (services/repository/files/upload.go:76-113): resolve the staged
 *      uuids, ONE multi-file create-or-update commit under the target dir
 *      (upstream's `upload` operation — update.go:366-373 tolerates a missing
 *      existing entry, which is exactly our builder's update-without-sha arm,
 *      git-models.ts "PUT without sha = create"), the default message
 *      `uploadFilesToDirMessage(treePath)` (editor.go:467) through the
 *      standard summary/body assembly, then the best-effort staging cleanup
 *      (upload.go:108-113) and the push-webhook ride (the file-editor family's
 *      posture, pages/file-editor.tsx module header).
 *
 * ## R2 key layout (the one deviation worth calling out)
 *
 * Upstream's upload rows are REPO-AGNOSTIC — the table has no repo column;
 * the uuid is the only reference and the route's writer predicate is the
 * entire authorization (upload.go:59-66 mints a bare `uuid.New()` key). The
 * port mirrors that: `repo-uploads/<uuid>` on the shared bucket — the name
 * echoes upstream's `AppDataTempDir("repo-uploads")` local layout
 * (upload.go:44-47) flattened (the `<u>/<uu>/` shard split is a filesystem
 * inode optimization R2 does not need). Deliberately NOT under
 * `repos/<storage_key>/staging/`: that prefix is the engine's receive-lease
 * staging, swept at lease release and watched by the `staging-orphan`
 * invariant (src/invariants/check.ts:322-341) — editor staging objects can
 * legitimately live for minutes before the confirm POST. The upload row's
 * `Name` rides the object's R2 `customMetadata` (no D1 table, no migration —
 * the divergence from upstream's `upload` table is that its uuid→name lookup
 * is exactly what object metadata carries here).
 *
 * ## Multipart posture
 *
 * The parse is the landed org-avatar precedent (ui/pages/org-settings.tsx
 * `readOrgAvatarUpload`): gate the content-type, bound the declared
 * Content-Length BEFORE any body byte is read (upstream leaves the size check
 * to a FIXME — editor_uploader.go:41 — and the dropzone's 50 MB
 * `data-max-size`; we answer the FIXME at the wire cap because
 * `request.formData()` buffers), then `await request.formData()`. The
 * `cf-gitea-ref` projects were consulted for a multipart-upload-to-R2
 * precedent and none exists (gitorange's LFS notes "the basic LFS transfer
 * adapter has no multipart"; g1t uses `request.formData()` only for plain
 * form posts) — the Web-standard parse is the mechanism.
 */

import { Context } from "hono";

import { ApiError } from "../api/errors";
import type { ApiEnv } from "../api/env";
import { applyFileChanges } from "../api/services/contents";
import { toPerson } from "../api/services/git-models";
import { apiUserFromRow, findRepositoryById, type UserRow } from "../api/services/repository";
import type { RepoRow } from "../repos/service";
import { handleUserPushNotifications } from "./webhooks-push";
import { uploadFilesToDirMessage, type EditorUploadFormValues } from "../ui/pages/repo-editor-tails";

// ---------------------------------------------------------------------------
// The staging store (models/repo/upload.go at the pin)
// ---------------------------------------------------------------------------

/** The `upload` row's projection (upload.go:30-33 — ID/UUID/Name; the size is
 *  observable off the object, not a column). */
export interface RepoUpload {
  uuid: string;
  /** The CLEANED file name (editor_uploader.go:35 stores the cleaned form). */
  name: string;
  size: number;
}

/** crypto.randomUUID()'s shape — the only uuids the store mints; lookups
 *  gate the key construction on it (the lfsKey discipline: injection-proof
 *  keys, services/lfs/store.ts:78-86). */
const UPLOAD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The R2 key for one staged upload: `repo-uploads/<uuid>` (module header —
 * repo-agnostic by upstream parity, off the invariant-watched engine
 * staging prefix). Throws on a non-uuid (never key from raw input).
 */
export function repoUploadKey(uuid: string): string {
  if (!UPLOAD_UUID_RE.test(uuid)) {
    throw new ApiError(400, "upload uuid is invalid");
  }
  return `repo-uploads/${uuid}`;
}

/**
 * `repo_model.NewUpload` (upload.go:59-87): mint the uuid, store the bytes,
 * record the name. R2's conditional put is not needed — a fresh uuid cannot
 * collide (1-in-2^122), and a rewrite of an existing key would be a caller
 * bug this store need not arbitrate.
 */
export async function newRepoUpload(bucket: R2Bucket, name: string, bytes: Uint8Array): Promise<RepoUpload> {
  const uuid = crypto.randomUUID();
  const stored = await bucket.put(repoUploadKey(uuid), bytes, {
    customMetadata: { name },
  });
  return { uuid, name, size: stored?.size ?? bytes.byteLength };
}

/** `repo_model.GetUploadByUUID` (upload.go:90-101): null = ErrUploadNotExist. */
export async function getRepoUploadByUUID(bucket: R2Bucket, uuid: string): Promise<RepoUpload | null> {
  if (!UPLOAD_UUID_RE.test(uuid)) return null;
  const object = await bucket.get(repoUploadKey(uuid));
  if (object === null) return null;
  const name = object.customMetadata?.name ?? "";
  return { uuid, name, size: object.size };
}

/**
 * `repo_model.GetUploadsByUUIDs` (upload.go:104-114): "Silently drop invalid
 * uuids" — a missing or malformed uuid never fails the batch.
 */
export async function getRepoUploadsByUUIDs(bucket: R2Bucket, uuids: readonly string[]): Promise<RepoUpload[]> {
  const found: RepoUpload[] = [];
  for (const uuid of uuids) {
    const upload = await getRepoUploadByUUID(bucket, uuid);
    if (upload !== null) found.push(upload);
  }
  return found;
}

/**
 * `repo_model.DeleteUploadByUUID` (upload.go:126-141): a missing upload is
 * not an error ("just continue, don't fail the whole operation if a file is
 * missing" — DeleteUploads' own comment, upload.go:98-100); malformed uuids
 * tolerate the same way (nothing to delete).
 */
export async function deleteRepoUploadByUUID(bucket: R2Bucket, uuid: string): Promise<void> {
  if (!UPLOAD_UUID_RE.test(uuid)) return;
  await bucket.delete(repoUploadKey(uuid));
}

// ---------------------------------------------------------------------------
// CleanGitTreePath (services/repository/files/file.go:143-155)
// ---------------------------------------------------------------------------

/**
 * `files_service.CleanGitTreePath`: `util.PathJoinRel` (path.Clean with the
 * leading slash dropped; `""` stays `""`, `/` reads as `""` after the
 * trailing-strip) plus the git hard rule — any `.git` segment (CASE-INSENSITIVE)
 * makes the whole name invalid (`""`), and a lone `.` cleans to `""`.
 * `""` = refuse (the caller answers 400 "Upload file name is invalid").
 * The segment filter implements PathJoinRel's empty-elem drop + Clean's dot
 * collapse for the join shapes the editor produces (the family's
 * cleanEditorTreePath vocabulary, with the `.git` rule this time — the staged
 * NAME is the untrusted input).
 */
export function cleanGitTreePath(name: string): string {
  const segments = name.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment.toLowerCase() === ".git") return "";
  }
  return segments.join("/");
}

/**
 * `path.Join(opts.TreePath, upload.Name)` (files/upload.go:101) for the
 * already-cleaned inputs: one slash join, empties dropped. Callers clean both
 * sides first (the staged name at stage time, the form dir here), so the
 * dot-collapsing a raw Go path.Join would do is unreachable by construction.
 */
export function joinUploadTreePath(treePath: string, name: string): string {
  const segments = [...treePath.split("/"), ...name.split("/")].filter((segment) => segment.length > 0);
  return segments.join("/");
}

// ---------------------------------------------------------------------------
// upload.Verify (services/context/upload/upload.go:52-103)
// ---------------------------------------------------------------------------

/** `ErrFileTypeForbidden.Error()` (upload.go:28-30) — the 400 body. */
export const UPLOAD_TYPE_FORBIDDEN_MESSAGE =
  "This file cannot be uploaded or modified due to a forbidden file extension or type.";

/**
 * `setting.Repository.Upload.AllowedTypes` default (modules/setting/
 * repository.go:176): `""` — EVERYTHING is allowed. There is no app.ini
 * pipeline yet; when the knob lands it feeds `verifyUploadFileType` unchanged.
 */
export const UPLOAD_ALLOWED_TYPES = "";

/**
 * The minimal WHATWG/Go mimesniff subset DetectContentType's verdicts need
 * for the common allow-lists: magic-number signatures first (Go's table
 * order — most specific wins), then the textual fallback. Only the first
 * 512 bytes are inspected (Go's sniff length). Dormant under the default
 * empty AllowedTypes (the early return below); kept structural so the knob
 * is a config change, not a code change.
 */
function detectContentType(buf: Uint8Array): string {
  const head = buf.subarray(0, 512);
  const starts = (...signature: number[]): boolean => signature.every((byte, i) => head[i] === byte);
  const hasAt = (offset: number, signature: string): boolean => {
    const bytes = new TextEncoder().encode(signature);
    return offset + bytes.length <= head.length && bytes.every((byte, i) => head[offset + i] === byte);
  };
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf"; // %PDF-
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08)) {
    return "application/zip"; // PK^E^F etc. (ooxml/epub ride the zip match)
  }
  if (starts(0x1f, 0x8b)) return "application/x-gzip";
  if (starts(0x37, 0x7a, 0xbc, 0x27, 0xaf, 0x27)) return "application/x-7z-compressed";
  if (starts(0x52, 0x61, 0x72, 0x21)) return "application/x-rar-compressed"; // Rar!
  if (starts(0x00, 0x61, 0x73, 0x6d)) return "application/wasm";
  if (starts(0x4f, 0x67, 0x67, 0x53)) return "application/ogg"; // OggS
  if (starts(0x66, 0x4c, 0x61, 0x43)) return "audio/x-flac"; // fLaC
  if (starts(0x49, 0x44, 0x33)) return "audio/mpeg"; // ID3
  if (starts(0x42, 0x4d)) return "image/bmp"; // BM
  if (starts(0x52, 0x49, 0x46, 0x46) && hasAt(8, "WEBP")) return "image/webp";
  if (starts(0x52, 0x49, 0x46, 0x46) && hasAt(8, "WAVE")) return "audio/wav";
  if (starts(0x52, 0x49, 0x46, 0x46) && hasAt(8, "AVI ")) return "video/x-msvideo";
  if (hasAt(4, "ftyp")) return "video/mp4"; // the ISOBMFF family
  // The text arm (Go's plain-sniff reduced): bytes that decode as UTF-8 read
  // as text/plain; anything else is octet-stream.
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head);
    return "text/plain; charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}

/**
 * `upload.Verify` (upload.go:52-103): `""`/absent allowed-types allows
 * everything; otherwise the file passes on an extension match (`.<ext>`
 * entries, case-folded), a full mime match, a `type STAR SLASH` wildcard
 * match, or the match-all entry; the mime is sniffed from the bytes and NEVER
 * trusted from the part's declared type, and the sniff is skipped only for an
 * (almost-)empty buffer (`len(buf) <= 1`). `null` = allowed; a string = the
 * refusal message.
 */
export function verifyUploadFileType(buf: Uint8Array, fileName: string, allowedTypes: string): string | null {
  const allowed = allowedTypes
    .replaceAll("|", ",") // compat for the old config format (upload.go:54)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (allowed.length === 0) return null; // everything is allowed (upload.go:66-68)

  const fullMimeType = detectContentType(buf);
  const mimeType = fullMimeType.split(";")[0]?.trim() ?? fullMimeType; // mime.ParseMediaType's media-type half
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  const isBufEmpty = buf.byteLength <= 1;

  for (const allowEntry of allowed) {
    if (allowEntry === "*/*") return null; // everything allowed (upload.go:84-86)
    if (allowEntry.startsWith(".") && allowEntry === extension) return null; // extension match
    if (isBufEmpty) continue; // skip mime checks for an empty buffer (upload.go:90-92)
    if (mimeType === allowEntry) return null; // mime match
    if (/^[a-z]+\/\*$/.test(allowEntry) && mimeType.startsWith(allowEntry.slice(0, allowEntry.length - 1))) {
      return null; // wildcard match, e.g. image/* (upload.go:95-97)
    }
  }
  return UPLOAD_TYPE_FORBIDDEN_MESSAGE;
}

// ---------------------------------------------------------------------------
// The endpoints (routers/web/repo/editor_uploader.go:18-60) — UNMOUNTED
// ---------------------------------------------------------------------------

/** `setting.Repository.Upload.FileMaxSize` in MB (repository.go:177) — the
 *  dropzone contract's `data-max-size` (the page's EDITOR_UPLOAD_MAX_SIZE_MB).
 *  The wire cap adds multipart-form overhead headroom to the per-file max. */
export const UPLOAD_FILE_MAX_SIZE_MB = 50;
export const UPLOAD_WIRE_MAX_BYTES = UPLOAD_FILE_MAX_SIZE_MB * 1024 * 1024 + 64 * 1024;

/** The outcome of the multipart `file` parse (see readUploadFilePart). */
type UploadFilePart =
  | { tag: "ok"; fileName: string; bytes: Uint8Array }
  | { tag: "too-large" } // the wire cap (the answered size FIXME, 400)
  | { tag: "malformed" }; // not multipart / missing part / unreadable body (upstream ServerError, 500)

/**
 * Parse the multipart POST's `file` part (editor_uploader.go:19-27 reads
 * `ctx.Req.FormFile("file")`). The parse is the landed org-avatar posture
 * (ui/pages/org-settings.tsx readOrgAvatarUpload): gate the content-type,
 * bound the DECLARED Content-Length before any body byte is read, then
 * `await request.formData()`.
 */
async function readUploadFilePart(request: Request): Promise<UploadFilePart> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) return { tag: "malformed" };
  const declared = request.headers.get("content-length");
  const length = declared === null ? undefined : Number.parseInt(declared, 10);
  if (length !== undefined && Number.isFinite(length) && length > UPLOAD_WIRE_MAX_BYTES) {
    return { tag: "too-large" }; // the size FIXME arm (editor_uploader.go:41) at the wire cap
  }
  try {
    const form = await request.formData();
    const part = form.get("file");
    if (part instanceof File) {
      return { tag: "ok", fileName: part.name, bytes: new Uint8Array(await part.arrayBuffer()) };
    }
    return { tag: "malformed" };
  } catch {
    return { tag: "malformed" };
  }
}

/**
 * POST /{owner}/{repo}/upload-file (editor_uploader.go:18-48 `UploadFileToServer`):
 * multipart `file` → `upload.Verify` (400 + the refusal text on a forbidden
 * type) → `CleanGitTreePath(header.Filename)` (400 "Upload file name is
 * invalid" when empty) → `NewUpload` → JSON `{"uuid"}` at 200
 * (editor_uploader.go:46). A malformed body answers upstream's ServerError
 * 500 (editor_uploader.go:20-22); an over-cap body answers the size FIXME
 * (editor_uploader.go:41) with a 400 — the dropzone's own
 * `data-max-size` contract, answered server-side. UNMOUNTED: the
 * orchestrator's route adds the §2.8 Origin guard, the repo prologue and the
 * writer gate (upstream web.go:1471-1475's `MustBeAbleToUpload` +
 * `reqRepoCodeWriter`).
 */
export async function uploadFileToServer(bucket: R2Bucket, request: Request): Promise<Response> {
  const part = await readUploadFilePart(request);
  if (part.tag === "malformed") {
    return new Response("unable to read the upload form", { status: 500 }); // upstream ServerError("FormFile")
  }
  if (part.tag === "too-large") {
    return new Response(`upload file size exceeds the maximum of ${UPLOAD_FILE_MAX_SIZE_MB} MB`, { status: 400 });
  }
  const forbidden = verifyUploadFileType(part.bytes, part.fileName, UPLOAD_ALLOWED_TYPES);
  if (forbidden !== null) {
    return new Response(forbidden, { status: 400 }); // ctx.HTTPError(400, err.Error())
  }
  const name = cleanGitTreePath(part.fileName);
  if (name === "") {
    return new Response("Upload file name is invalid", { status: 400 }); // editor_uploader.go:36-39
  }
  const uploaded = await newRepoUpload(bucket, name, part.bytes);
  return Response.json({ uuid: uploaded.uuid }, { status: 200 }); // ctx.JSON(StatusOK, {"uuid"})
}

/**
 * POST /{owner}/{repo}/upload-remove (editor_uploader.go:51-60
 * `RemoveUploadFileFromServer`): the `file` form field carries the uuid
 * (dropzone posts multipart FormData); `DeleteUploadByUUID`'s
 * missing-tolerant arm means EVERY well-formed body answers 204
 * (editor_uploader.go:59) — unknown uuids included (upload.go:131-135).
 */
export async function uploadRemoveFromServer(bucket: R2Bucket, request: Request): Promise<Response> {
  let fileUUID = "";
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const value = form.get("file");
      if (typeof value === "string") fileUUID = value;
    } else if (contentType.startsWith("application/x-www-form-urlencoded")) {
      fileUUID = new URLSearchParams(await request.text()).get("file") ?? "";
    }
  } catch {
    fileUUID = ""; // a malformed body deletes nothing, answers 204 like upstream's empty FormString
  }
  await deleteRepoUploadByUUID(bucket, fileUUID);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// The commit arm (services/repository/files/upload.go:76-113 + the router's
// message assembly, routers/web/repo/editor.go:461-484)
// ---------------------------------------------------------------------------

export type UploadCommitResult =
  | { outcome: "committed"; branch: string; treePath: string; ref: string; commitOid: string; landed: string[] }
  | { outcome: "noop" } // zero staged files (upload.go:78-80 returns nil; the router still 303s onto the tree)
  | { outcome: "invalid"; message: string };

/** The repository row the editor touches (the ui-context RepoRow — the same
 *  repositories.$inferSelect the landed family's commitFileFromForm takes). */
type UploadRepoRow = RepoRow;

/**
 * `files_service.UploadRepoFiles` (upload.go:76-113) through the LANDED
 * `applyFileChanges` (api/services/contents.ts — UNTOUCHED: its multi-file
 * change list is already the ChangeRepoFiles shape, and its `update`
 * operation WITHOUT a sha is exactly upstream's `upload` operation —
 * update.go:366-373 tolerates a missing existing entry where `update` would
 * demand a sha; the landing CAS is the branch tip, all-or-nothing per change
 * set). After the commit: the best-effort staging cleanup (upload.go:108-113
 * — a failed delete only logs) and the push-webhook ride with the applied
 * delta (pages/file-editor.tsx's family posture — a web-editor commit does
 * not traverse the engine's onPush seam).
 *
 * Identity + message mirror the landed family exactly: author = committer =
 * the session viewer (the doerIdentity convention), and the summary/body
 * assembly of upstream `GetCommitMessage` (editor.go:106-111) over the
 * PageIsUpload default `uploadFilesToDirMessage(treePath)` (editor.go:467 —
 * an empty dir reads `Upload files to "/"`).
 *
 * Both path inputs are cleaned before the join: the staged NAME was cleaned
 * at stage time (editor_uploader.go:35), the form's treePath here (a `.`/`..`
 * or `.git` component refuses with the family's "invalid file path" arm —
 * upstream's path.Join + update.go's path checks refuse the same shapes).
 * The final landing path is `joinUploadTreePath(treePath, name)`.
 */
export async function commitUploadFromForm(
  env: Env,
  req: Request,
  repo: UploadRepoRow,
  userRow: UserRow,
  values: Pick<EditorUploadFormValues, "treePath" | "files" | "summary" | "body" | "branch">,
): Promise<UploadCommitResult> {
  const treePath = cleanGitTreePath(values.treePath);
  if (values.treePath.trim() !== "" && treePath === "") {
    return { outcome: "invalid", message: "invalid file path" };
  }

  const bucket = env.REPO_PACKS;
  const uploads = await getRepoUploadsByUUIDs(bucket, values.files);
  if (uploads.length === 0) return { outcome: "noop" }; // upload.go:78-80

  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { outcome: "invalid", message: "not found" };

  // The doer identity (contents.ts:214-222 mirrored onto the session row —
  // the family's commitFileFromForm convention).
  const hostname = new URL(req.url).hostname;
  const email =
    userRow.email === null || userRow.email === "" ? `${userRow.username}@noreply.${hostname}` : userRow.email;

  // Upstream GetCommitMessage over the PageIsUpload default (editor.go:467).
  const summary = values.summary.trim();
  const body = values.body.trim();
  const message = `${summary === "" ? uploadFilesToDirMessage(treePath) : summary}${body === "" ? "" : `\n\n${body}`}`;

  const apiContext = new Context<ApiEnv>(req, { env });
  apiContext.set("authUser", apiUserFromRow(userRow, { origin: new URL(req.url).origin, requester: null }));

  // The staged bytes (upload.go:101's ContentReader pull — one R2 GET per
  // staged uuid, read fully for the builder's blob objects).
  const changes = [];
  for (const upload of uploads) {
    const object = await bucket.get(repoUploadKey(upload.uuid));
    changes.push({
      operation: "update" as const, // without sha = create-or-update (upstream's "upload" op)
      path: joinUploadTreePath(treePath, upload.name),
      content: new Uint8Array(await object?.arrayBuffer() ?? new ArrayBuffer(0)),
    });
  }

  try {
    const result = await applyFileChanges(
      apiContext,
      pair,
      { branch: values.branch },
      changes,
      {
        message,
        author: toPerson(null, userRow.username, email),
        committer: toPerson(null, userRow.username, email),
      },
    );
    // The staging cleanup (upload.go:108-113): best-effort, never fails the
    // arm — the object is gone from the store's duties either way.
    for (const upload of uploads) {
      await deleteRepoUploadByUUID(bucket, upload.uuid);
    }
    // The push-family ride (module header): the applied delta through the
    // onPush adapter's own entry, awaited inline like the landed editor's.
    await handleUserPushNotifications(
      env,
      repo,
      [{ ref: result.ref, old: result.built.baseTip, next: result.refTarget }],
      userRow,
    );
    return {
      outcome: "committed",
      branch: values.branch,
      treePath,
      ref: result.ref,
      commitOid: result.built.commitOid,
      landed: result.paths,
    };
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}
