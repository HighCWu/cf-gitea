/**
 * The file-editor TAIL pages — the two `templates/repo/editor/` confirm pages
 * the landed wave-8 editor did not port 1:1 (pages wave 55; MOUNTED at
 * 1d834d6, window-2e C2b — the routes live in `index.ts`; the retired
 * wiring HANDOFF is the mount record below):
 *
 *   GET+POST /{owner}/{repo}/delete/{branch}/{path}   the DELETE-file confirm
 *                                                     (delete.tmpl — the
 *                                                     faithful DOM over the
 *                                                     LANDED delete arm)
 *   GET+POST /{owner}/{repo}/upload/{branch}[/{dir}]  the UPLOAD confirm
 *                                                     (upload.tmpl — the
 *                                                     write rides the
 *                                                     LANDED staging
 *                                                     family,
 *                                                     services/upload-staging.ts)
 *
 * One module because the two tails share everything but the read/write: the
 * same commit_form reduction (the wave-8 family's target-branch select), the
 * same sidebar + breadcrumb chrome, the same loader vocabulary
 * (loadFileEditorData's branch walk). Upstream spells the literals with a
 * leading underscore (`_delete`/`_upload`, web.go:1459-1464); the family's
 * brief pins the bare names (pages/file-editor.tsx header).
 *
 * ## Mount record (MOUNTED at 1d834d6 — the wiring HANDOFF is retired)
 *
 * - DELETE — the dispatcher branches `fileEditorPage`/`fileEditorSubmit` on
 *   `mode === "delete"` → `renderEditorDeletePage({ ctx, data, form, error })`
 *   — the SAME `loadFileEditorData(engine, repo, "delete", route.refSuffix,
 *   null)` data (type-shared) and the SAME `readEditorForm` values: this
 *   form posts exactly the landed field set (`tree_path`, `commit_summary`,
 *   `commit_message`, `branch`, `blob_sha`); the write stays the landed
 *   `commitFileFromForm` (pages/file-editor.tsx) over `applyFileChanges`.
 * - UPLOAD — all three pieces LANDED (services/upload-staging.ts): the R2-
 *   backed uuid staging store, the dropzone endpoints
 *   POST /{owner}/{repo}/upload-file and POST /{owner}/{repo}/upload-remove,
 *   and the commit arm `commitUploadFromForm` over `uploadRepoFiles`
 *   (files_service.UploadRepoFiles editor.go:468-478's port — staged uuids
 *   resolved under `tree_path`, ONE create-op commit,
 *   `uploadFilesToDirMessage(treePath)` as the default message). The route
 *   arms are the editor Combos' last member (web.go:1462-1464's
 *   `{editor_action:_upload}/*` shape), gated by the editor family's
 *   shared `fileEditorGate` (no landed per-repo upload toggle).
 *
 * ## DOM contract — DELETE (templates/repo/editor/delete.tmpl at the pin)
 *
 * `.page-content.repository file editor delete` (delete.tmpl:2 — the landed
 * wave-8 page drops this discriminator for one shared `editor edit` class;
 * this port restores it), the repo header, `.ui.container.fluid.padded` >
 * `.repo-view-container` with the view_file_tree sidebar (file-view.tsx's
 * FileTreeSidebar, the family export) and the `.repo-view-content` form
 * `class="ui form form-fetch-action" method="post"` (delete.tmpl:9). Inside:
 * the `.repo-editor-header` breadcrumb (delete.tmpl:15-21 — EVERY TreeName is
 * a plain LINK here, the file segment included, unlike the landed page's
 * active-text last segment; getParentTreeFields, editor_util.go:105-113,
 * splits `notes/editor.txt` → links for `notes` and `notes/editor.txt`), then
 * STRAIGHT into the commit form — delete.tmpl renders NO content arm at all
 * (the landed page's `Delete '{path}'` h4 segment is its own reduction, not
 * upstream's). commit_form.tmpl arms: the `commit_summary` placeholder is the
 * PageIsDelete one, "Delete '{path}'" (commit_form.tmpl:14 + locale
 * repo.editor.delete through the family's defaultEditorMessage).
 *
 * ## DOM contract — UPLOAD (templates/repo/editor/upload.tmpl +
 *  repo/upload.tmpl + common_breadcrumb.tmpl at the pin)
 *
 * `.page-content.repository file editor upload` (upload.tmpl:2), the same
 * container/sidebar shell, and the form
 * `class="ui form form-fetch-action repo-file-upload"` (upload.tmpl:9). The
 * breadcrumb is common_breadcrumb.tmpl's PageIsUpload arm: dir segments as
 * links, the LAST one the `#file-name` input — maxlength 255, NO required
 * attribute (`{{Iif $.PageIsUpload "" "required"}}`, common_breadcrumb.tmpl:8),
 * placeholder "Add a directory…" (repo.editor.add_subdir) with the
 * octicon-info filename_help tooltip — carrying the dir's OWN last segment as
 * its value (upstream renders TreeNames' tail into it). That input is a
 * JS-island affordance: repo-editor.ts joinTreePath (web_src/js/features/
 * repo-editor.ts:85-98) merges it into the hidden `#tree_path` client-side;
 * WITHOUT the bundle the form posts `tree_path` = the target dir as rendered,
 * which is the correct default (files land in the viewed dir). The `or
 * Cancel` tail and the hidden `id="tree_path" name="tree_path"` close the
 * breadcrumb (common_breadcrumb.tmpl:14-15). The upload body is repo/
 * upload.tmpl's dropzone DIV: `data-upload-url` `{repoLink}/upload-file`,
 * `data-remove-url` `{repoLink}/upload-remove`, `data-accepts` "" (the
 * default-all AllowedTypes), `data-max-file` 5 / `data-max-size` 50 MB
 * (setting.Repository.Upload defaults, modules/setting/repository.go:169-178),
 * `data-need-uuid-link` false (repo uploads never set it — upload.go:139-149
 * leaves UploadLinkUrl unset too, the upstream TODO), and the five
 * data-text-* locale strings; an empty `.files` div inside — dropzone.js
 * paints the message and the file list, so without the JS the box is inert
 * (upstream's file picking has no no-JS shape either). The commit form's
 * `commit_summary` placeholder is the PageIsUpload one, `Upload files to
 * "{dir}"` (commit_form.tmpl:14 + repo.editor.upload_files_to_dir; the
 * write-side default at editor.go:467 normalizes the empty dir to "/").
 *
 * ## Shared reductions (inherited from the landed family — one vocabulary)
 *
 * - commit_form.tmpl's commit_choice RADIOS ("commit directly" /
 *   "commit to a new branch" + `new_branch_name`, commit_form.tmpl:25-68)
 *   reduce to ONE target-branch select of the EXISTING branches named
 *   `branch` — the wave-8 brief's reduction (pages/file-editor.tsx header);
 *   the landed POST reads only `branch`. The submit label is then always
 *   "Commit Changes" (the propose_file_change arm rides the removed radio).
 * - The signing h3 arm (WillSign lock / wont-sign unlock, commit_form.tmpl:5-11)
 *   is unrendered — no commit-signing pipeline; "Commit Changes" only.
 * - The `signoff` checkbox (commit_form.tmpl:19-24) and the commit-email
 *   select (commit_form.tmpl:70-79, multiple verified emails) are unrendered
 *   (the wave-8 reductions).
 * - The `last_commit` hidden CAS field (commit_form.tmpl:81) stays reduced to
 *   the blob-sha `blob_sha` field (delete only — the loader's entry oid; the
 *   upload loader carries no sha, matching upstream's upload flow whose CAS
 *   is the same last_commit id).
 * - The fork arms (common_top.tmpl's WillSubmitToFork message, the
 *   NeedFork/ForkToEdit redirect) are unrendered — no fork-to-edit flow (the
 *   wave-8 header).
 * - The view_file_tree toggle button (delete.tmpl:12-13 says it must exist —
 *   for the JS toggle) is unrendered: the landed FileTreeSidebar dropped both
 *   toggle buttons (JS island, no UserSettingCodeViewShowFileTree pipeline)
 *   and the sidebar glyphs (`octicon-sidebar-collapse`/`-expand` are not in
 *   the generated icon set; the view_file_tree body itself is the landed
 *   server-side list, not the JS-island #view-file-tree loader).
 * - `return_uri` (IsEditingFileOnly, editor.go:80-81) is unrendered: the
 *   cancel/or-Cancel hrefs are the branch/dir/file views (the landed family
 *   ignores the parameter too).
 * - The DELETE confirm inherits the landed loader's BLOB-path constraint
 *   (loadFileEditorData 404s a directory tail): upstream's DeleteFilePost
 *   deletes directories recursively (editor.go:405-427, delete_directory
 *   message + DeleteRecursively) — directory deletes stay git/API-only.
 * - The upload form's action carries the bare literal `upload` (the family's
 *   naming); no route claims it until the staging family lands (handoff).
 */

import { type EngineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { TreeEntryJson } from "@cf-gitea/git-engine";
import {
  defaultEditorMessage,
  editorFormFromData,
  loadFileEditorData,
  type FileEditorData,
  type EditorFormValues,
} from "./file-editor";
import { FileTreeSidebar } from "./file-view";
import type { ResolvedRefs } from "./home";

/** Page chrome text (component-local, the fileEditorLocale pattern — the
 *  strings cite upstream's locale keys). */
export const editorTailsLocale = {
  upload_file: "Upload File", // "repo.editor.upload_file" (the upload page's Title)
  commit_changes: "Commit Changes", // "repo.editor.commit_changes" (h3 + submit)
  cancel: "Cancel", // "repo.editor.cancel" (the red button) / "repo.editor.cancel_lower" (the breadcrumb tail)
  or: "or", // "repo.editor.or"
  add_subdir: "Add a directory…", // "repo.editor.add_subdir" (the upload name input's placeholder)
  filename_help:
    "Add a directory by typing its name followed by a slash ('/'). Remove a directory by typing backspace at the beginning of the input field.", // "repo.editor.filename_help"
  commit_message_desc: "Add an optional extended description…", // "repo.editor.commit_message_desc"
  /** dropzone.default_message … (repo/upload.tmpl's data-text-* set). */
  dropzone_default_message: "Drop files or click here to upload.", // "dropzone.default_message"
  dropzone_invalid_input_type: "You cannot upload files of this type.", // "dropzone.invalid_input_type"
  dropzone_file_too_big:
    "File size ({{filesize}} MB) exceeds the maximum size of ({{maxFilesize}} MB).", // "dropzone.file_too_big"
  dropzone_remove_file: "Remove file", // "dropzone.remove_file"
  copy_link: "Copy link", // "copy_link"
} as const;

// ---------------------------------------------------------------------------
// The upload-side constants (setting.Repository.Upload defaults)
// ---------------------------------------------------------------------------

/** `setting.Repository.Upload.MaxFiles` (modules/setting/repository.go:178). */
export const EDITOR_UPLOAD_MAX_FILES = 5;

/** `setting.Repository.Upload.FileMaxSize` in MB (repository.go:177). */
export const EDITOR_UPLOAD_MAX_SIZE_MB = 50;

/**
 * The PageIsUpload default message/placeholder: `repo.editor.
 * upload_files_to_dir` = `Upload files to "%s"` (locale_en-US.json:1317),
 * with editor.go:467's `util.IfZero(parsed.form.TreePath, "/")` arm so an
 * empty target dir reads `Upload files to "/"`.
 */
export function uploadFilesToDirMessage(dir: string): string {
  return `Upload files to "${dir === "" ? "/" : dir}"`;
}

// ---------------------------------------------------------------------------
// Data seams
// ---------------------------------------------------------------------------

/** The upload confirm page's render inputs — the target-dir projection of the
 *  family loader's "new" arm (loadFileEditorData walks the branch and lists
 *  the dir; upstream's UploadFile itself only cleans the path,
 *  editor.go:449-459 — the sidebar listing is this port's one addition, the
 *  landed family's server-side view_file_tree). */
export interface EditorUploadData {
  refs: ResolvedRefs;
  /** The URL's branch (short name). */
  branch: string;
  /** The target dir ("" at root — files land at the branch root). */
  treePath: string;
  /** The target dir's listing (the sidebar). */
  siblings: TreeEntryJson[];
}

/** `null` never resolves: an unresolvable branch → 404 shell (the family's
 *  §4.1 arm; upstream answers the same through the ref assignment). */
export async function loadEditorUploadData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  refSuffix: string,
): Promise<EditorUploadData | { notFound: true }> {
  // The "new" arm of the family loader IS the upload read: branch walk + the
  // dir listing, no blob requirement (an upload target need not exist yet).
  const data = await loadFileEditorData(engine, repo, "new", refSuffix, null);
  if ("notFound" in data) return data;
  // The family loader skips the ROOT listing (its new-file page needs no
  // siblings there); the upload sidebar shows the viewed dir at every depth,
  // so the root tree is listed here.
  const siblings =
    data.treePath === "" ? ((await engine.listTree(data.branch))?.entries ?? []) : data.siblings;
  return {
    refs: data.refs,
    branch: data.branch,
    treePath: data.treePath,
    siblings,
  };
}

/** The upload POST body (upstream UploadRepoFileForm, services/forms/
 *  repo_form_editor.go:42-46 — TreePath + Files, through the family's field
 *  vocabulary; the commit fields mirror the landed EditorFormValues). */
export interface EditorUploadFormValues {
  /** The target dir (the hidden #tree_path field). */
  treePath: string;
  /** The staged uuids (`files[]` — dropzone's uploaded set). */
  files: string[];
  summary: string;
  body: string;
  branch: string;
}

/** The GET's initial values (from the loaded data — never a submission). */
export function uploadFormFromData(data: EditorUploadData): EditorUploadFormValues {
  return {
    treePath: data.treePath,
    files: [],
    summary: "",
    body: "",
    branch: data.branch,
  };
}

/** Parse the urlencoded POST (`tree_path`, `files` (multi), `commit_summary`,
 *  `commit_message`, `branch` — the dispatcher calls this on
 *  readUrlEncodedForm's result; the mounted write is the staging family's
 *  `commitUploadFromForm`, the mount record). */
export function parseUploadForm(params: URLSearchParams): EditorUploadFormValues {
  return {
    treePath: params.get("tree_path") ?? "",
    files: params.getAll("files"),
    summary: params.get("commit_summary") ?? "",
    body: params.get("commit_message") ?? "",
    branch: (params.get("branch") ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// The commit-form reduction (commit_form.tmpl — shared by both tails)
// ---------------------------------------------------------------------------

/** commit_form.tmpl's tail through the family reduction: summary input
 *  (maxlength 100, the per-tail placeholder), extended-description textarea
 *  (rows 5), the target-branch select (the commit_choice radios' reduction —
 *  module header), the CAS hidden field, then commit-button + the RED cancel
 *  (commit_form.tmpl:82-85 — the landed page's plain cancel is its own
 *  divergence this port restores). */
function TailCommitForm(props: { branches: readonly string[]; form: { summary: string; body: string; branch: string }; summaryPlaceholder: string; cancelHref: string; casFields?: { blobSha?: string; treePath?: string } }) {
  const selectId = "editor-tail-target-branch";
  return (
    <div class="commit-form-wrapper">
      <div class="commit-form">
        <h3>{editorTailsLocale.commit_changes}</h3>
        <div class="field">
          <input name="commit_summary" maxlength={100} placeholder={props.summaryPlaceholder} value={props.form.summary} autocomplete="off" />
        </div>
        <div class="field">
          <textarea name="commit_message" rows={5} placeholder={editorTailsLocale.commit_message_desc}>
            {props.form.body}
          </textarea>
        </div>
        <div class="field">
          {/* cf-gitea addition, the family's own label for the radio reduction
              (pages/file-editor.tsx target_branch). */}
          <label for={selectId}>Target branch</label>
          <select id={selectId} name="branch" class="ui selection dropdown">
            {props.branches.map((name) => (
              <option value={name} selected={name === props.form.branch}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {props.casFields?.treePath !== undefined ? (
          <input type="hidden" name="tree_path" value={props.casFields.treePath} />
        ) : null}
        {props.casFields?.blobSha !== undefined && props.casFields.blobSha !== "" ? (
          <input type="hidden" name="blob_sha" value={props.casFields.blobSha} />
        ) : null}
        <div class="flex-text-block">
          <button id="commit-button" type="submit" class="ui primary button">
            {editorTailsLocale.commit_changes}
          </button>
          <a class="ui button red" href={props.cancelHref}>
            {editorTailsLocale.cancel}
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The DELETE confirm page (delete.tmpl at the pin)
// ---------------------------------------------------------------------------

/** delete.tmpl's breadcrumb (delete.tmpl:15-21): EVERY TreeName is a plain
 *  link — the file segment included — over getParentTreeFields' name/path
 *  pairs (editor_util.go:105-113). No filename input, no tree_path here
 *  (upstream relies on the URL tail; this port adds the hidden `tree_path`
 *  the LANDED arm reads — the TailCommitForm casFields, header). */
function DeleteBreadcrumb(props: { repoSlug: string; branchHref: string; treePath: string }) {
  const names = props.treePath === "" ? [] : props.treePath.split("/");
  return (
    <div class="breadcrumb">
      <a class="section" href={props.branchHref} title={props.repoSlug}>
        {props.repoSlug}
      </a>
      {names.map((name, i) => (
        <>
          <div class="breadcrumb-divider">/</div>
          <span class="section">
            <a href={`${props.branchHref}/${pathEscapeSegments(names.slice(0, i + 1).join("/"))}`} title={name}>
              {name}
            </a>
          </span>
        </>
      ))}
    </div>
  );
}

/** The full-document DELETE confirm render. `data`/`form` are the FAMILY
 *  types (loadFileEditorData("delete") / EditorFormValues / readEditorForm) —
 *  the dispatcher swapped in this render (MOUNTED at 1d834d6, the mount
 *  record). */
export function renderEditorDeletePage(options: {
  ctx: UiContext;
  data: FileEditorData;
  form: EditorFormValues;
  error: string | null;
}): string {
  return renderPage(
    <EditorDeleteConfirmPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The delete.tmpl page (§2.4.1 discriminator: delete.tmpl:2's
 *  `repository file editor delete`). Form → the LANDED delete arm; the
 *  commit fields carry tree_path + blob_sha (the landed handler's CAS), the
 *  summary placeholder is the PageIsDelete arm. NO content arm — delete.tmpl
 *  renders the commit form directly (module header). */
export function EditorDeleteConfirmPage(props: { ctx: UiContext; data: FileEditorData; form: EditorFormValues; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EditorDeleteConfirmPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const branchHref = `${repoLink}/src/branch/${pathEscapeSegments(data.branch)}`;
  const action = `${repoLink}/delete/${pathEscapeSegments(data.branch)}/${pathEscapeSegments(data.treePath)}`;
  const cancelHref = `${branchHref}/${pathEscapeSegments(data.treePath)}`;

  return (
    <BaseLayout ctx={ctx} title={data.treePath} pageClass="repository file editor delete" activeTab="code">
      <div class="ui container fluid padded">
        <div class="repo-view-container">
          <FileTreeSidebar
            repoLink={repoLink}
            refType="branch"
            ref={data.branch}
            dirPath={data.dirPath}
            siblings={data.siblings}
            activeName={data.treePath.split("/").pop() ?? ""}
          />
          <div class="repo-view-content">
            <form class="ui form form-fetch-action" method="post" action={action}>
              <div class="repo-editor-header">
                <DeleteBreadcrumb repoSlug={repo.slug} branchHref={branchHref} treePath={data.treePath} />
              </div>
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <TailCommitForm
                branches={data.refs.branches}
                form={form}
                summaryPlaceholder={defaultEditorMessage("delete", data.treePath)}
                cancelHref={cancelHref}
                casFields={{ treePath: data.treePath, blobSha: form.blobSha }}
              />
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The UPLOAD confirm page (upload.tmpl + repo/upload.tmpl at the pin)
// ---------------------------------------------------------------------------

/** common_breadcrumb.tmpl's PageIsUpload arm: the dir segments as links, the
 *  LAST one the `#file-name` input (maxlength 255, NOT required on upload —
 *  `{{Iif $.PageIsUpload "" "required"}}` — carrying the dir's own last
 *  segment; at root getParentTreeFields yields ONE empty name, so the input
 *  still renders, value ""), the octicon-info filename_help tooltip, the
 *  `or Cancel` tail and the hidden `#tree_path`. The input is name-less — a
 *  JS-island affordance the bundle merges into #tree_path (repo-editor.ts
 *  joinTreePath); no-JS the form posts the rendered dir (module header). */
function UploadBreadcrumb(props: { repoSlug: string; branchHref: string; treePath: string }) {
  const segments = props.treePath.split("/"); // "" at root → [""], upstream's getParentTreeFields arm
  const last = segments.length - 1;
  return (
    <div class="breadcrumb">
      <a class="section" href={props.branchHref} title={props.repoSlug}>
        {props.repoSlug}
      </a>
      {segments.map((segment, i) => (
        <>
          <div class="breadcrumb-divider">/</div>
          {i === last ? (
            <>
              <input
                id="file-name"
                maxlength={255}
                value={segment}
                placeholder={editorTailsLocale.add_subdir}
                autocomplete="off"
              />
              <span data-tooltip-content={editorTailsLocale.filename_help}>
                <Icon name="octicon-info" size={14} />
              </span>
            </>
          ) : (
            <span class="section">
              <a href={`${props.branchHref}/${pathEscapeSegments(segments.slice(0, i + 1).join("/"))}`} title={segment}>
                {segment}
              </a>
            </span>
          )}
        </>
      ))}
      <span>
        {editorTailsLocale.or}{" "}
        <a href={props.treePath === "" ? props.branchHref : `${props.branchHref}/${pathEscapeSegments(props.treePath)}`}>
          {editorTailsLocale.cancel}
        </a>
      </span>
      <input type="hidden" id="tree_path" name="tree_path" value={props.treePath} />
    </div>
  );
}

/** repo/upload.tmpl's dropzone DIV: the data-* contract AddUploadContextForRepo
 *  renders (services/context/upload/upload.go:139-149) + the five data-text-*
 *  locale strings (repo/upload.tmpl:12-16); `.files` stays empty — dropzone.js
 *  paints it (module header). */
function UploadDropzone(props: { repoLink: string }) {
  return (
    <div
      class="dropzone"
      data-upload-url={`${props.repoLink}/upload-file`}
      data-remove-url={`${props.repoLink}/upload-remove`}
      data-accepts=""
      data-max-file={EDITOR_UPLOAD_MAX_FILES}
      data-max-size={EDITOR_UPLOAD_MAX_SIZE_MB}
      data-need-uuid-link="false"
      data-text-default-message={editorTailsLocale.dropzone_default_message}
      data-text-invalid-input-type={editorTailsLocale.dropzone_invalid_input_type}
      data-text-file-too-big={editorTailsLocale.dropzone_file_too_big}
      data-text-remove-file={editorTailsLocale.dropzone_remove_file}
      data-text-copy-link={editorTailsLocale.copy_link}
    >
      <div class="files" />
    </div>
  );
}

/** The full-document UPLOAD confirm render (the staging family LANDED —
 *  MOUNTED at 1d834d6, the mount record; the POST writes through
 *  `commitUploadFromForm`). */
export function renderEditorUploadPage(options: {
  ctx: UiContext;
  data: EditorUploadData;
  form: EditorUploadFormValues;
  error: string | null;
}): string {
  return renderPage(
    <EditorUploadConfirmPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The upload.tmpl page (§2.4.1 discriminator: upload.tmpl:2's
 *  `repository file editor upload`). Form class
 *  `ui form form-fetch-action repo-file-upload` (upload.tmpl:9); the action
 *  is the family's bare-literal shape — UNCLAIMED until the write family
 *  lands (documented-unrendered). */
export function EditorUploadConfirmPage(props: { ctx: UiContext; data: EditorUploadData; form: EditorUploadFormValues; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EditorUploadConfirmPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const branchHref = `${repoLink}/src/branch/${pathEscapeSegments(data.branch)}`;
  const action =
    data.treePath === ""
      ? `${repoLink}/upload/${pathEscapeSegments(data.branch)}`
      : `${repoLink}/upload/${pathEscapeSegments(data.branch)}/${pathEscapeSegments(data.treePath)}`;

  return (
    <BaseLayout ctx={ctx} title={editorTailsLocale.upload_file} pageClass="repository file editor upload" activeTab="code">
      <div class="ui container fluid padded">
        <div class="repo-view-container">
          <FileTreeSidebar
            repoLink={repoLink}
            refType="branch"
            ref={data.branch}
            dirPath={data.treePath}
            siblings={data.siblings}
            activeName=""
          />
          <div class="repo-view-content">
            <form class="ui form form-fetch-action repo-file-upload" method="post" action={action}>
              <div class="repo-editor-header">
                <UploadBreadcrumb repoSlug={repo.slug} branchHref={branchHref} treePath={data.treePath} />
              </div>
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <div class="field">
                <UploadDropzone repoLink={repoLink} />
              </div>
              <TailCommitForm
                branches={data.refs.branches}
                form={form}
                summaryPlaceholder={uploadFilesToDirMessage(data.treePath)}
                cancelHref={data.treePath === "" ? branchHref : `${branchHref}/${pathEscapeSegments(data.treePath)}`}
              />
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Re-exports (the delete tail's seams ride the family module — one loader,
// one parser, one write; the handoff note's swap touches only the render)
// ---------------------------------------------------------------------------

export { editorFormFromData, loadFileEditorData };
