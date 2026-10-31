/**
 * The ISSUE-ATTACHMENT web WRITE arms — census gap #6 (upstream web.go:1394-
 * 1395 at the pin, inside `addIssuesPullsUpdateRoutes`, mounted under BOTH
 * `/{username}/{reponame}/{type:issues}` and `{type:pulls}` (:1471-1472) with
 * group gates `reqSignIn + context.RepoAssignment +
 * context.RepoMustNotBeArchived()` (:1473) + the per-type unit reader):
 *
 *   POST /{username}/{reponame}/issues/attachments          repo.UploadIssueAttachment
 *   POST /{username}/{reponame}/issues/attachments/remove   repo.DeleteAttachment
 *
 * (and the `/pulls/...` twins — the FIXME at web.go:1403 routes them to the
 * same handlers). REPO-LEVEL paths, no {index}: the dropzone uploads BEFORE
 * any issue/comment exists — upstream inserts `&Attachment{Name, UploaderID,
 * RepoID}` (attachment.go:61-65), IssueID 0; the uuid rides the comment
 * form's hidden `files` inputs and links to the issue/comment only at
 * submit. The GET families of this namespace landed already:
 * pages/comment-attachments-fragment.ts (the repo-level comments arm) and
 * issue-content-fragments.ts (the /{index}/attachments list + the uuid
 * alias), and the site-level byte seam is web/attachments-serving.ts.
 *
 * ## The dropzone contract (web_src/js/features/dropzone.ts, VERIFIED)
 *
 *   - UPLOAD: Dropzone POSTs multipart/form-data with the file in the `file`
 *     part (`ctx.Req.FormFile("file")`, attachment.go:53) to the element's
 *     `data-upload-url`; the response is parsed as JSON and ONLY `uuid` is
 *     read (`type UploadResponse = {uuid: string}`, dropzone.ts:23; the
 *     success handler also appends `<input name="files" value={uuid}>`).
 *     Upstream answers `ctx.JSON(200, map[string]string{"uuid": …})`
 *     (attachment.go:76-78) — the exact body shape pinned in the tests.
 *   - REMOVE: the preview's Remove button POSTs
 *     `new URLSearchParams({file: uuid})` (dropzone.ts:139 — urlencoded
 *     body) to `data-remove-url`; the response body is unread, the status
 *     is not awaited beyond the fetch. Upstream's handler answers
 *     `{"uuid": …}` 200 (:129-131).
 *   - The list arm (`data-link-url` → DropzoneCustomEventReloadFiles) is the
 *     LANDED GET family — `/issues/{index}/attachments` on an issue page,
 *     `/issues/attachments` on new-issue (services/context/upload/upload.go:
 *     119-124) — not this module's.
 *
 * ## Upload handler arm-by-arm (attachment.go:47-79 + services/attachment/
 *    attachment.go:87-115 + upload.go:45-93, port order preserved)
 *
 *   1. `setting.Attachment.Enabled` → 404 (attachment.go:48-51). Frozen
 *      TRUE (modules/setting/attachment.go:19-24 defaults; no settings
 *      surface landed) — the arm is dead here, like the API family's
 *      mustEnableIssuesOrPulls 412.
 *   2. `ctx.Req.FormFile("file")` — the multipart `file` part; ANY error
 *      (non-multipart content type, no `file` part, malformed body) is
 *      `ctx.ServerError` → 500 (attachment.go:53-57). KEPT the web family's
 *      ServerError posture (the comment-attachments-fragment.ts step-3 rule:
 *      a deterministic ServerError class is never fabricated into a 4xx) —
 *      the API twin answered 400 here and disclosed it; the web twin keeps
 *      upstream's 500. STREAMED: the part's bytes go straight through the
 *      landed `parseMultipartParts` scanner into the store — never
 *      arrayBuffer on an unbounded body (AGENTS.md; the packages-upload
 *      discipline).
 *   3. Allowed-types gate (`upload.Verify`, upload.go:45-93) → 400
 *      `ErrFileTypeForbidden` (attachment.go:67-70). DEAD in this instance:
 *      the landed posture gates attachment types at no point (the API
 *      family's header note, the release-assets posture) — documented, not
 *      ported.
 *   4. Size gate: upstream `file.size > MaxSize` → `ErrContentTooLarge` →
 *      falls into the handler's NON-type error branch → ServerError 500
 *      (attachment.go:66-72 — only IsErrFileTypeForbidden maps to 400; the
 *      dropzone's data-max-size makes this client-side-rare). Ours: the
 *      landed family cap `MAX_ISSUE_ATTACHMENT_BYTES` (512 MiB) fires the
 *      streaming `AssetTooLargeError` → the SAME 500 outcome (upstream's
 *      own mapping), with the cap-value divergence documented (upstream
 *      default MaxSize 100 MiB at this pin; ours the store family's 512).
 *   5. Store: `NewAttachment` (services/attachment/attachment.go:19-35) —
 *      uuid, storage save, insert. OURS IS THE LANDED SEAM, verbatim:
 *      `uploadIssueAttachment` (api/routes/issue-attachments.ts:558, the
 *      row-first R2+D1 landing — zero duplicated storage logic), inserting
 *      the split-table row with `issueId: 0, commentId: 0` (upstream's
 *      unlinked IssueID 0; the split table has NO repo_id column — the
 *      RepoID upstream sets is unreproducible, see the remove arm). The
 *      R2 key family `repos/<storage_key>/attachments/<id>/<name>` is the
 *      API family's — shared, purged by the repo-prefix sweep.
 *   6. `ctx.JSON(200, {"uuid"})` — the dropzone contract byte-shape.
 *
 * ## Remove handler arm-by-arm (attachment.go:82-132, order preserved)
 *
 *   1. `file := ctx.FormString("file")` — the posted uuid (missing → "",
 *      which misses at step 2 like upstream).
 *   2. `GetAttachmentByUUID` miss → 400 `attachment does not exist
 *      [id: 0, uuid: <file>]` (models/repo/attachment.go:87-89's Error()
 *      through ctx.HTTPError — http.Error's text/plain + nosniff + trailing
 *      newline). Ours resolves BOTH split halves (the serving seam's walk:
 *      the issue half first) because upstream's ONE attachment table backs
 *      this handler for the release dropzone too (web.go:1524 mounts the
 *      same DeleteAttachment at /releases/attachments/remove — this module
 *      serves both mounts' recipes).
 *   3. `!ctx.IsSigned` → 403 (:90-93). Unreachable through the mount (the
 *      group's reqSignIn 303s first — the issueCommentSubmit anonymous
 *      fold); kept in the seam as upstream's arm.
 *   4. Repo-mismatch → 400 "attachment does not belong to this repository"
 *      (:95-98). Ours derives affiliation per half: the release half CARRIES
 *      repo_id (direct compare, upstream-faithful); the issue half has no
 *      repo column — a LINKED row (issue_id > 0) compares through the
 *      owning issue's repo_id, an UNLINKED row (issue_id = 0, exactly what
 *      this module's upload creates) SKIPS the arm: upstream would compare
 *      its own RepoID, ours cannot know it. DOCUMENTED divergence — an
 *      unlinked uuid removed through a foreign repo's URL is accepted here
 *      (upstream 400s), unavoidable without a schema change; the signed
 *      non-uploader still needs step 5's grant in THAT repo, so the hole is
 *      bounded to uploader-initiated removes.
 *   5. Uploader fast-path (`ctx.Doer.ID == attach.UploaderID`) → delete.
 *      Else the per-half grant (:100-122): issue half linked →
 *      `CanWriteIssuesOrPulls(issue.IsPull)` — the landed
 *      canWriteRepository fold (the issue-content-fragments.ts:720-731
 *      precedent) through the sessionRepoGrant bridge; issue half UNLINKED →
 *      upstream's `IsAdmin() || IsOwner()` arm (:116-121) — the landed
 *      isRepositoryAdmin fold; release half → `CanWrite(TypeReleases)`
 *      (:111-115) — the serving seam's canWriteRepository shape
 *      (attachments-serving.ts:74-79 note). A dangling owning issue row →
 *      GetIssueByID's ServerError 500 (:102-106).
 *   6. `DeleteAttachment(ctx, attach, true)` (:124) — ROW first, then the
 *      stored object, a missing object tolerated (models/repo/
 *      attachment.go:181-211's order; the R2 binding's delete is idempotent,
 *      so only real failures surface) → ServerError 500 on failure.
 *   7. `ctx.JSON(200, {"uuid"})` (:129-131).
 *
 * ## The group gates' mount fold (the recipe's arm order)
 *
 *   reqSignIn → anonymous 303 login (the house mount convention — resolveUiRequest
 *   resolves the repo FIRST, so an invisible repo 404-shells before the
 *   redirect could leak it); RepoAssignment → the visibility grant rides
 *   resolveUiRequest; RepoMustNotBeArchived → ctx.NotFound → the 404 SHELL
 *   (services/context/repo.go:136-142 — the web tier, NOT the API's 423);
 *   the unit readers ({type:issues} RequireUnitReader(issues, pulls),
 *   {type:pulls} reqUnitPullsReader) fold into the mount's repo-visibility
 *   grant — no landed unit-toggle consumer (the comment-attachments-
 *   fragment.ts header's step-2 fold, the aux siblings' convention).
 *
 * ## Divergences ledger (beyond the inline notes)
 *
 *   - upstream MaxFiles (5) and MaxSize (100) feed only the dropzone
 *     ELEMENT's client-side attributes (data-max-file / data-max-size,
 *     dropzone.ts:113-114) — no server arm exists for MaxFiles upstream
 *     either; the fragment renders the frozen defaults.
 *   - an empty part filename: upstream inserts the blank name verbatim;
 *     ours too (the R2 KEY segment degrades to "attachment" inside
 *     issueAttachmentKey's sanitizer — the display name stays "" in D1).
 *   - `ctx.FormString` merges query + body (body wins); the dropzone sends
 *     body-only, the seam reads the urlencoded body then the query.
 *
 * ## Mount handoff (ui/index.ts — OWNED BY A FLYING SIBLING, not edited
 *    here; the b91dd1c/chef handoff pattern)
 *
 *   1. parseUiRoute — inside the `if (head === "issues" || head ===
 *      "pulls")` block (index.ts:4889), the length-1 group (:4904-4919)
 *      gains BEFORE the numeric issue-detail arm (static-before-param, chi's
 *      priority; "attachments" is not numeric so order is safe, but keep it
 *      with the other literals):
 *
 *        if (rest[0] === "attachments") return { family: "issue-attachments-upload", owner, repo };
 *
 *      and a NEW length-2 literal group (no current length-2 arm claims a
 *      non-numeric first segment — :4923 requires `^-?\d+$`, :4901 requires
 *      "new"):
 *
 *        if (rest.length === 2 && rest[0] === "attachments" && rest[1] === "remove") {
 *          return { family: "issue-attachments-remove", owner, repo };
 *        }
 *
 *      Add both families to the repo-scoped route union (the IssueAuxRoute
 *      family list is the natural host — web.go:1394-1395's group is the
 *      update-routes sibling of the view-routes group that family already
 *      ports):
 *
 *        | "issue-attachments-upload"
 *        | "issue-attachments-remove"
 *
 *      Guards claim nothing else: `/issues/attachments/anything`,
 *      `/issues/attachment`, `/issues/attachments/remove/extra` stay
 *      unclaimed → the engine's 404; `pulls` twins claim identically (the
 *      shared head block).
 *   2. Dispatcher handlers (the issueContentHistorySoftDeleteRoute shape —
 *      guard → resolve → drift guard → anonymous → archived → seam):
 *
 *        async function issueAttachmentsUploadRoute(c) {
 *          const guard = sameOriginGuard(c.req.raw);
 *          if (guard !== null) return guard;
 *          const resolved = await resolveUiRequest(c);
 *          if (!resolved.ok) return resolved.response;
 *          const { repo, viewer, respond } = resolved;
 *          if (resolved.route.family !== "issue-attachments-upload") return respond(await c.notFound());
 *          if (viewer.kind === "anonymous") return respond(loginRedirect(resolved.url.pathname + resolved.url.search));
 *          if (repo.isArchived) return respond(c.html(renderNotFound(resolved.ctx), 404));
 *          const outcome = await uploadIssueAttachmentFromMultipart(
 *            c.env, repo, viewer.id, c.req.raw,
 *          );
 *          return respond(issueAttachmentUploadResponse(outcome));
 *        }
 *
 *        async function issueAttachmentsRemoveRoute(c) {
 *          const guard = sameOriginGuard(c.req.raw);
 *          if (guard !== null) return guard;
 *          const resolved = await resolveUiRequest(c);
 *          if (!resolved.ok) return resolved.response;
 *          const { url, repo, viewer, respond } = resolved;
 *          if (resolved.route.family !== "issue-attachments-remove") return respond(await c.notFound());
 *          if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
 *          if (repo.isArchived) return respond(c.html(renderNotFound(resolved.ctx), 404));
 *          const form = await readUrlEncodedForm(c.req.raw);
 *          const outcome = await removeAttachmentByUuid(
 *            c.env, repo, viewer, removeAttachmentFormValue(form, url),
 *          );
 *          return respond(issueAttachmentRemoveResponse(outcome));
 *        }
 *
 *   3. uiRouter registrations (beside the aux block at :16218-16232; the
 *      GET twins are chi's 405 — upstream registers POST-only):
 *
 *        uiRouter.post("/:owner/:repo/:kind{issues|pulls}/attachments", (c) => issueAttachmentsUploadRoute(c));
 *        uiRouter.get("/:owner/:repo/:kind{issues|pulls}/attachments", () => methodNotAllowed("POST"));
 *        uiRouter.post("/:owner/:repo/:kind{issues|pulls}/attachments/remove", (c) => issueAttachmentsRemoveRoute(c));
 *        uiRouter.get("/:owner/:repo/:kind{issues|pulls}/attachments/remove", () => methodNotAllowed("POST"));
 *
 *      NOTE the shadowing order vs the GET family at :16220
 *      (`/:kind/:index{\d+}/attachments` — one segment DEEPER, no overlap)
 *      and :16221 (the alias — three segments deep, no overlap): Hono's
 *      static-before-param precedence keeps `/attachments` literal ahead of
 *      any `:index` param shape, and the parser is the real gate (the drift
 *      guard makes a precedence regression a loud 404).
 *   4. NULL PINS THAT FLIP: none known in the sibling test files —
 *      issue-detail.matrix / aux-fragments.matrix pin the CURRENT unclaimed
 *      state of `/issues/attachments` only if they asserted the engine 404;
 *      a grep for "issues/attachments" over the ui test files found no such
 *      pin at this writing (the wave's mount lander re-runs the family
 *      neighbors regardless).
 *
 * ## The dropzone fragment export (the GET page fold-back)
 *
 *   The comment form renders in pages/issue-detail.tsx (SIBLING-OWNED at
 *   this writing — the render fold is the orchestrator's, the chef-module
 *   pattern): upstream view_content.tmpl:146-159 renders the combo editor
 *   with DropzoneParentContainer ".ui.form", then — `{{if
 *   .IsAttachmentEnabled}}` — a `<div class="field">` carrying the
 *   repo/upload.tmpl markup INSIDE the form element (after the editor
 *   field, before the status-button footer). The fold: import
 *   `CommentAttachmentsDropzone` from "./issue-attachments-write" and
 *   render `<CommentAttachmentsDropzone repoLink={repoLink} issueIndex={issue.index} />`
 *   between the textarea field and the footer field of the `#comment-form`
 *   form (`repoLink` = `/${ownerNamespace}/${slug}`, the landed
 *   repoLinkOf convention; issueIndex present → the GET-list
 *   data-link-url with the index, absent → the bare repo-level URL —
 *   upload.go:119-124's exact branch, which also serves the new-issue
 *   page's form). The new-issue page (pages/new-issue.tsx) folds the same
 *   fragment with issueIndex undefined.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  AssetTooLargeError,
  MalformedMultipartError,
  parseMultipartParts,
  readTextFieldPart,
  readableStreamFromGenerator,
} from "../../api/services/release-assets";
// The landed store seams (row-first R2 + D1 landing, the 512 MiB cap) —
// REUSED verbatim, never duplicated (the org-teams/repo-labels ui→api/routes
// import precedent).
import { MAX_ISSUE_ATTACHMENT_BYTES, uploadIssueAttachment } from "../../api/routes/issue-attachments";
import { canWriteRepository, isRepositoryAdmin } from "../../api/services/repo-access";
import { issueAttachments, issues, releaseAssets } from "../../db/schema";
import { sessionRepoGrant } from "../repo-grants";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

type IssueAttachmentRow = typeof issueAttachments.$inferSelect;
type ReleaseAssetRow = typeof releaseAssets.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/** ctx.JSON's content-type (services/context/base.go:114-116) plus the web
 *  middleware's zero-option prod Cache-Control — the fragments-family header
 *  set (comment-attachments-fragment.ts jsonHeaders twin). */
function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
  };
}

/** Go http.Error (services/context/base.go:105-111 → net/http.Error): the
 *  message (or the status text), text/plain + nosniff + trailing newline —
 *  the attachments-serving textError twin. */
function httpErrorResponse(status: 400 | 403 | 500, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The dropzone fragment (repo/upload.tmpl over upload.go:118-133's context)
// ---------------------------------------------------------------------------

/** `setting.Attachment.AllowedTypes` frozen defaults (modules/setting/
 *  attachment.go:19-21) — upload.go:129 feeds `AddUploadContext`'s
 *  data-accepts with the `|`→`,` replacement (the default carries no `|`). */
export const ISSUE_ATTACHMENT_ACCEPTS =
  ".avif,.cpuprofile,.csv,.dmp,.docx,.fodg,.fodp,.fods,.fodt,.gif,.gz,.jpeg,.jpg,.json,.jsonc,.log,.md,.mov,.mp4,.odf,.odg,.odp,.ods,.odt,.patch,.pdf,.png,.pptx,.svg,.tgz,.txt,.webm,.webp,.xls,.xlsx,.zip";

/** MaxFiles/MaxSize frozen defaults (modules/setting/attachment.go:22-23) —
 *  client-side dropzone attributes only (the header's divergence note). */
export const ISSUE_ATTACHMENT_MAX_FILES = 5;
export const ISSUE_ATTACHMENT_MAX_SIZE_MIB = 100;

/** The dropzone.* locale strings (gitea/options/locale/locale_en-US.json at
 *  the pin) + `copy_link` — the locale.ts-owner caveat (the chef module's
 *  inline-const convention). */
export const dropzoneLocale = {
  /** "dropzone.default_message" */
  defaultMessage: "Drop files or click here to upload.",
  /** "dropzone.invalid_input_type" */
  invalidInputType: "You cannot upload files of this type.",
  /** "dropzone.file_too_big" — the {{filesize}}/{{maxFilesize}} placeholders
   *  are Dropzone's own template tokens, passed through verbatim. */
  fileTooBig: "File size ({{filesize}} MB) exceeds the maximum size of ({{maxFilesize}} MB).",
  /** "dropzone.remove_file" */
  removeFile: "Remove file",
  /** "copy_link" (the data-text-copy-link attribute, upload.tmpl:17). */
  copyLink: "Copy link",
} as const;

/**
 * The comment/new-issue form's dropzone (repo/upload.tmpl verbatim — the
 * `{{if .IsAttachmentEnabled}}<div class="field">` block of view_content.tmpl:
 * 155-159). `repoLink` is `{{.RepoLink}}` = `/{owner}/{repo}`; `issueIndex`
 * present (the issue/PR page's comment form) → `data-link-url` carries the
 * per-issue GET list, absent (new-issue) → the bare repo-level URL
 * (upload.go:119-124's exact branch). `NeedUuidLink: true` (upload.go:132) —
 * the preview's copy-link button. The combo editor's
 * `data-dropzone-parent-container=".ui.form"` (view_content.tmpl:148) is the
 * EDITOR's attribute, rendered by the comment-form family — the JS island
 * finds this div by `.dropzone` inside the form (ComboMarkdownEditor.ts
 * setupDropzone).
 */
export function CommentAttachmentsDropzone(props: { repoLink: string; issueIndex?: number }) {
  const linkUrl =
    props.issueIndex === undefined
      ? `${props.repoLink}/issues/attachments`
      : `${props.repoLink}/issues/${props.issueIndex}/attachments`;
  return (
    <div
      class="dropzone"
      data-link-url={linkUrl}
      data-upload-url={`${props.repoLink}/issues/attachments`}
      data-remove-url={`${props.repoLink}/issues/attachments/remove`}
      data-accepts={ISSUE_ATTACHMENT_ACCEPTS}
      data-max-file={ISSUE_ATTACHMENT_MAX_FILES}
      data-max-size={ISSUE_ATTACHMENT_MAX_SIZE_MIB}
      data-need-uuid-link="true"
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
// The upload arm (attachment.go:47-79 UploadIssueAttachment)
// ---------------------------------------------------------------------------

/** The upload outcome: `ok` is the 200 JSON arm; `serverError` is upstream's
 *  `ctx.ServerError` class (the FormFile failures at :53-57, the over-cap
 *  ErrContentTooLarge falling through :66-72, and store failures) — the
 *  module header's arm map. The Enabled-404 and types-400 arms are dead
 *  (frozen on / no gate). */
export type IssueAttachmentUploadOutcome =
  | { readonly kind: "ok"; readonly uuid: string }
  | { readonly kind: "serverError"; readonly detail: string };

/** The multipart Content-Type boundary extractor — the API family's
 *  module-private `multipartBoundary` re-declared (the attachments-twin
 *  re-declaration convention, comment-attachments-fragment.ts:54-58). */
function multipartBoundary(contentType: string): string | null {
  const match = /^\s*multipart\/form-data\s*(?:;|$)/i.exec(contentType);
  if (match === null) return null;
  const boundaryMatch = /;\s*boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  return boundary === undefined || boundary === "" ? null : boundary;
}

/**
 * The upload seam: the multipart `file` part captured STREAMING (single
 * parse pass — parts before the file part are drained, the file part's
 * generator rides straight into the landed `uploadIssueAttachment`, the
 * API family's exact loop shape) and landed row-first with `issueId: 0,
 * commentId: 0` (upstream's unlinked insert). `uploaderId` is the signed
 * doer (the mount's reqSignIn fold guarantees it). `maxBytes` is the test
 * seam for the over-cap arm; production rides the family cap.
 */
export async function uploadIssueAttachmentFromMultipart(
  env: Env,
  repo: RepoRow,
  uploaderId: number,
  request: Request,
  maxBytes: number = MAX_ISSUE_ATTACHMENT_BYTES,
): Promise<IssueAttachmentUploadOutcome> {
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
        // The generator re-wrapped as a ReadableStream — the API family's
        // exact capture step (routes/issue-attachments.ts:740).
        content = readableStreamFromGenerator(part.content);
        break; // the file part captured — trailing fields are not parsed (the API family's loop)
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

  // Arms 3-5 — the types gate is dead (no gate in this instance); the cap
  // fires inside the landed seam and maps to the SAME ServerError outcome
  // upstream's fall-through produces. The store seam is the API family's
  // row-first landing, unlinked (issueId 0 / commentId 0).
  try {
    const row = await uploadIssueAttachment({
      bucket: env.REPO_PACKS,
      d1: env.DB,
      storageKey: repo.storageKey,
      issueId: 0,
      commentId: 0,
      uploaderId,
      name,
      content,
      multipart: true,
      maxBytes,
    });
    return { kind: "ok", uuid: row.uuid };
  } catch (error) {
    // A mid-flight store failure removes both halves inside the seam (the
    // row-first landing's cleanup); the outcome is upstream's ServerError
    // — the over-cap AssetTooLargeError included (attachment.go:66-72's
    // non-type fall-through).
    const detail = error instanceof AssetTooLargeError ? "attachment exceeds limit" : String(error);
    return { kind: "serverError", detail: `uploadAttachment(uploadFunc): ${detail}` };
  }
}

/**
 * `ctx.JSON(http.StatusOK, map[string]string{"uuid": …})` (attachment.go:
 * 75-78) — the dropzone JS contract byte-shape (`resp.uuid` is the only
 * field read, dropzone.ts:129); the ServerError arm renders the plain-text
 * 500 (the themed-500 divergence, the fragment's unsupportedType shape).
 */
export function issueAttachmentUploadResponse(outcome: IssueAttachmentUploadOutcome): Response {
  if (outcome.kind === "serverError") {
    return httpErrorResponse(500, `uploadAttachment: ${outcome.detail}`);
  }
  return new Response(JSON.stringify({ uuid: outcome.uuid }), { status: 200, headers: jsonHeaders() });
}

// ---------------------------------------------------------------------------
// The remove arm (attachment.go:82-132 DeleteAttachment)
// ---------------------------------------------------------------------------

/** The remove outcome — upstream's arm statuses: `badRequest` is the
 *  uuid-miss (:84-88) and repo-mismatch (:95-98) 400s (the exact
 *  err.Error()/const bodies), `forbidden` the two 403s (:91, :108/:114/:118),
 *  `serverError` the GetIssueByID (:102-106) and DeleteAttachment (:124-128)
 *  500s, `ok` the 200 JSON. */
export type IssueAttachmentRemoveOutcome =
  | { readonly kind: "ok"; readonly uuid: string }
  | { readonly kind: "badRequest"; readonly message: string }
  | { readonly kind: "forbidden" }
  | { readonly kind: "serverError"; readonly detail: string };

/** `ErrAttachmentNotExist.Error()` (models/repo/attachment.go:87-89) with the
 *  GetAttachmentByUUID zero id — the miss 400's exact body. */
function attachmentNotExistMessage(uuid: string): string {
  return `attachment does not exist [id: 0, uuid: ${uuid}]`;
}

/**
 * `ctx.FormString("file")` (attachment.go:83): the urlencoded body's value,
 * falling back to the query string (Go FormValue merges both, body-first).
 * The mount reads the form (`readUrlEncodedForm` — bounded prose, a uuid
 * body) and hands it here with the request URL.
 */
export function removeAttachmentFormValue(form: URLSearchParams, url: URL): string {
  const fromBody = form.get("file");
  if (fromBody !== null) return fromBody;
  return url.searchParams.get("file") ?? "";
}

/** The uuid → half resolution over the split table (the serving seam's
 *  walk, issue half first — but WITHOUT its dangling join: DeleteAttachment
 *  reads the ROW only at this step; the owning issue joins later, in the
 *  perms arm, exactly where upstream's GetIssueByID sits). */
async function resolveAttachmentHalf(
  d1: D1Database,
  uuid: string,
): Promise<{ kind: "issue"; row: IssueAttachmentRow } | { kind: "release"; row: ReleaseAssetRow } | null> {
  const issueRow = (await drizzle(d1).select().from(issueAttachments).where(eq(issueAttachments.uuid, uuid)).limit(1))[0];
  if (issueRow !== undefined) return { kind: "issue", row: issueRow };
  const assetRow = (await drizzle(d1).select().from(releaseAssets).where(eq(releaseAssets.uuid, uuid)).limit(1))[0];
  if (assetRow !== undefined) return { kind: "release", row: assetRow };
  return null;
}

/** `DeleteAttachment(ctx, attach, true)` (models/repo/attachment.go:181-211):
 *  the ROW deletes first, then the stored object; a missing object is
 *  tolerated upstream (the ErrNotExist warn) and the R2 binding's delete is
 *  idempotent — a real failure surfaces (the caller's ServerError arm),
 *  leaving the row already gone like upstream's own partial-failure state.
 *  HALF-AWARE: the split halves delete through their own tables (upstream's
 *  ONE table; the resolved union's row rides the half it resolved from). */
async function deleteAttachmentRowAndObject(
  env: Env,
  half: "issue" | "release",
  row: { id: number; r2Key: string | null },
): Promise<void> {
  if (half === "release") {
    await drizzle(env.DB).delete(releaseAssets).where(eq(releaseAssets.id, row.id));
  } else {
    await drizzle(env.DB).delete(issueAttachments).where(eq(issueAttachments.id, row.id));
  }
  if (row.r2Key === null) {
    // The relay's pending arm (row-first landing, never uploaded) — the row
    // delete is the whole upstream `remove` arm (nothing stored to delete).
    return;
  }
  await env.REPO_PACKS.delete(row.r2Key);
}

/**
 * The remove seam (DeleteAttachment's body, arm order preserved — lookup →
 * signed → mismatch → uploader-or-grant → delete). `repo` is the
 * RepoAssignment row, `viewer` the session viewer (anonymous reaches the
 * :90-93 403 only through direct seam calls — the mount 303s first). The
 * split-half divergences are the module header's step 4.
 */
export async function removeAttachmentByUuid(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  file: string,
): Promise<IssueAttachmentRemoveOutcome> {
  // Arm 2 — GetAttachmentByUUID miss → the exact ErrAttachmentNotExist body.
  const resolved = await resolveAttachmentHalf(env.DB, file);
  if (resolved === null) {
    return { kind: "badRequest", message: attachmentNotExistMessage(file) };
  }

  // Arm 3 — !ctx.IsSigned → bare 403 (:90-93).
  if (viewer.kind !== "user") {
    return { kind: "forbidden" };
  }

  // Arm 5's data — the issue half joins its owning issue once (the
  // mismatch check and the grant arm share the read; a MISSING owning row
  // defers both to the GetIssueByID ServerError at the grant arm, the
  // header's step-4 order fold).
  let owningIssue: IssueRow | null = null;
  if (resolved.kind === "issue" && resolved.row.issueId > 0) {
    owningIssue = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, resolved.row.issueId)).limit(1))[0] ?? null;
  }

  // Arm 4 — the repo-mismatch 400 (:95-98). Release half: the row's own
  // repo_id (upstream's direct compare). Issue half: through the owning
  // issue; an unlinked row (issue_id 0) SKIPS the arm — the header's
  // documented no-repo-column divergence.
  if (resolved.kind === "release") {
    if (resolved.row.repoId !== repo.id) {
      return { kind: "badRequest", message: "attachment does not belong to this repository" };
    }
  } else if (owningIssue !== null && owningIssue.repoId !== repo.id) {
    return { kind: "badRequest", message: "attachment does not belong to this repository" };
  }

  // Arm 5 — the uploader fast-path, then the per-half grant (:100-122).
  if (resolved.row.uploaderId !== null && viewer.id === resolved.row.uploaderId) {
    // fall through to the delete
  } else if (resolved.kind === "issue" && resolved.row.issueId > 0) {
    if (owningIssue === null) {
      // GetIssueByID's ServerError (:102-106) — the dangling owning row.
      return { kind: "serverError", detail: "GetIssueByID: issue does not exist" };
    }
    // CanWriteIssuesOrPulls(issue.IsPull) — the landed canWriteRepository
    // fold through the sessionRepoGrant bridge (the fragments' precedent).
    if (!(await sessionRepoGrant(env, repo, viewer, canWriteRepository))) {
      return { kind: "forbidden" };
    }
  } else if (resolved.kind === "issue") {
    // The unlinked arm (:116-121): IsAdmin() || IsOwner() — the landed
    // isRepositoryAdmin fold (owner + site-admin + admin collaborator/team).
    if (!(await sessionRepoGrant(env, repo, viewer, isRepositoryAdmin))) {
      return { kind: "forbidden" };
    }
  } else {
    // The release half (:111-115): CanWrite(unit.TypeReleases) — the
    // serving seam's canWriteRepository shape.
    if (!(await sessionRepoGrant(env, repo, viewer, canWriteRepository))) {
      return { kind: "forbidden" };
    }
  }

  // Arm 6 — the row-then-object delete; a failure is the ServerError arm.
  try {
    await deleteAttachmentRowAndObject(env, resolved.kind, resolved.row);
  } catch (error) {
    return { kind: "serverError", detail: `DeleteAttachment: ${String(error)}` };
  }

  // Arm 7 — the 200 JSON (the dropzone JS ignores the body, the shape is
  // still upstream's).
  return { kind: "ok", uuid: resolved.row.uuid };
}

/**
 * The remove wire arm — ctx.HTTPError's http.Error bodies for the 4xx/500
 * arms (the miss message carries the posted file value verbatim, upstream's
 * err.Error()), `{"uuid"}` 200 on success.
 */
export function issueAttachmentRemoveResponse(outcome: IssueAttachmentRemoveOutcome): Response {
  switch (outcome.kind) {
    case "ok":
      return new Response(JSON.stringify({ uuid: outcome.uuid }), { status: 200, headers: jsonHeaders() });
    case "badRequest":
      return httpErrorResponse(400, outcome.message);
    case "forbidden":
      return httpErrorResponse(403, "Forbidden");
    case "serverError":
      return httpErrorResponse(500, `DeleteAttachment: ${outcome.detail}`);
  }
}
