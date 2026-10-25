/**
 * The web file editor, `/{owner}/{repo}/{new|edit|delete}/...` — pages wave 8
 * (SPEC-0008 U3 extension): the write surface that lets a repository gain and
 * change files without git. Three routes at the brief's literal names —
 * upstream's `/{editor_action:_edit|_new|_delete}/*` Combos under
 * `RepoRefByType(git.RefTypeBranch)` (routers/web/web.go:1453-1461):
 *
 *   GET+POST /{owner}/{repo}/new/{branch}[/{dir}]?filename=…   create a file
 *   GET+POST /{owner}/{repo}/edit/{branch}/{path}              edit a file
 *   GET+POST /{owner}/{repo}/delete/{branch}/{path}            delete a file
 *
 * (Upstream spells the literals with a leading underscore; the brief pins the
 * bare names. The tail after the literal resolves against the BRANCH universe
 * only — `resolveRefSuffix("branch", …)`, so a branch named `feature/foo`
 * walks the shortest existing prefix exactly like the /src family. The bare
 * literals stay unclaimed: upstream chi requires the `/*` tail too.)
 *
 * ## DOM contract (templates/repo/editor/edit.tmpl + delete.tmpl +
 *  commit_form.tmpl + common_breadcrumb.tmpl + view_file_tree at the pin)
 *
 * `.page-content.repository file editor edit` (edit.tmpl:4 — the ONE template
 * serves _new and _edit; delete.tmpl:4 is `... editor delete`), then
 * `.ui.container.fluid.padded` > `.repo-view-container` with the
 * view-file-tree sidebar (file-view.tsx's FileTreeSidebar, exported) and the
 * `.repo-view-content` `<form class="ui edit form" method="post">`: the
 * `.repo-editor-header` breadcrumb (repo link → dir segments → the last
 * segment; on NEW that last segment is the full-path `<input id="file-name"
 * name="tree_path" maxlength="255" required>`, common_breadcrumb.tmpl's
 * editable input), then edit.tmpl's write tab header + the content textarea,
 * then commit_form.tmpl: `h3` "Commit Changes", the `commit_summary` input
 * (maxlength 100, placeholder = the upstream default message), the
 * `commit_message` textarea (rows 5), the target-branch select, the submit
 * + cancel pair.
 *
 * ## Write path (§3.2 — the landed contents write service, never a self-fetch)
 *
 * POST → `applyFileChanges` (src/api/services/contents.ts:72 — the shared
 * CreateFile/UpdateFile/DeleteFile orchestration over buildFileChangeCommit →
 * putApiObjects → commitApiChange). Per change: `operation` create/update/
 * delete, `path` = the cleaned tree_path, `content` = UTF-8 bytes with CR
 * stripped (upstream EditFilePost's `ReplaceAll(…, "\r", "")`,
 * editor.go:352), `sha` = the blob oid the page rendered for edit/delete —
 * the service's CAS arm ("sha does not match [given: …, expected: …]", 422)
 * is the upstream `last_commit` concurrency guard at blob granularity (a
 * commit touching OTHER files does not block your edit; documented).
 *
 * Commit identity — author = committer = the SESSION VIEWER: the identity
 * mirrors the API write route's doerIdentity (contents.ts:214-222 — name =
 * login, email = the stored email or `{login}@noreply.{hostname}`) fed through
 * `toPerson(null, name, email)` (git-models.ts:798 — the route's own defaults
 * when the body carries no author/committer). The commit message mirrors
 * upstream `GetCommitMessage` (editor.go:106-111): a non-empty trimmed
 * `commit_summary` replaces the default, a non-empty trimmed `commit_message`
 * body appends after a blank line; the default is `Add|Update|Delete '{path}'`
 * ("repo.editor.add|update|delete"). Validation failures surface the
 * service's own arms re-rendered inline: create-already-exists / sha
 * mismatch / invalid path → 422 text, missing file or branch → 404 text, a
 * lost CAS → 409 text (contents.ts applyFileChanges' mapping) — plus the
 * form-level arms (empty file name, "."/".." segments) with the values
 * preserved (the login failure convention).
 *
 * The push-webhook family rides the write: the engine's onPush seam fires
 * only on the git-HTTP receive path (packages/git-engine mod.ts:1022-1035,
 * after finalizeReceive) — a commit landing through `commitApiChange` does
 * NOT fire it — so the handler fans the applied delta out through
 * `handleUserPushNotifications` (src/services/webhooks-push.ts:522), the
 * exact entry the onPush adapter calls: one `{ref, old: baseTip, next}`
 * update renders the SAME push payload (and the create/sync family) a git
 * push of that ref would have produced, with the session viewer as pusher.
 *
 * ## Auth + CSRF posture (the wave-4 write surfaces' shape)
 *
 * Every route runs the §2.8 layer-2 Origin/Referer check first
 * (`sameOriginGuard`), then the repo resolution (invisible repos 404-shell,
 * existence never leaks), then anonymous → the login 303 round-trip. The
 * write predicate is `canWriteRepo` — the UI delegate onto the LANDED
 * `canWriteRepository` (api/services/repo-access.ts, via ../repo-grants.ts):
 * site admin, the case-folded owner, a write/admin collaborator, or a
 * write/admin/owner-mode org-team grant — the same arms the contents PUT
 * enforces, so a team-granted member sees the editor entry the write seam
 * admits; non-writers 404-shell like the settings pages. Archived repos
 * 404-shell both verbs (upstream `RepoMustNotBeArchived` wraps the editor
 * group and answers NotFound, services/context/repo.go:136-141). The file
 * view renders the Edit/Delete entry links (and the tree chrome the New
 * File link) only under the same predicate.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The CodeMirror/monaco code editor is a client-bundle feature: the content
 *   edits in a plain visible `<textarea id="edit_area" name="content">`
 *   carrying the built CSS's monospace utility (`tw-font-mono`). No syntax
 *   highlighting, no editor options menu (options.tmpl), no find/palette.
 * - Preview is OFF in v1 (the brief): edit.tmpl's write/preview/diff tab menu
 *   reduces to the single write tab; no `/_preview/*` route exists.
 * - No fork-to-edit: upstream shows readers a fork-then-edit flow
 *   (NeedFork/ForkToEdit); readers here 404-shell at the write predicate.
 * - The commit_choice radios ("commit directly" / "commit to a new branch" +
 *   `new_branch_name`, commit_form.tmpl) reduce to ONE target-branch select
 *   of the EXISTING branches (the brief; the service's new_branch arm stays
 *   API-only). No signoff checkbox, no commit-email select (single verified
 *   email), no `last_commit` hidden field (the blob-sha CAS covers drift).
 * - New-file `?filename=` PREFILLS the name input; upstream 303s onto the
 *   path-carrying URL instead (editor.go:274-284) — one URL, same value.
 * - The breadcrumb filename input carries the FULL path (no-JS shape):
 *   upstream splits dir (`tree_path` hidden) + name (`#file-name`) and
 *   merges client-side (web_src/js/features/repo-editor.ts).
 * - Renames (upstream's edit-with-changed-path "rename" operation) and
 *   uploads (`_upload`) are out of scope; LFS-pointer files are not
 *   distinguished (no LFS read in the page path) — they edit as their
 *   pointer text.
 */

import { Context } from "hono";

import { ApiError } from "../../api/errors";
import type { ApiEnv } from "../../api/env";
import { applyFileChanges } from "../../api/services/contents";
import { toPerson } from "../../api/services/git-models";
import { canWriteRepository } from "../../api/services/repo-access";
import { apiUserFromRow, findRepositoryById, type UserRow } from "../../api/services/repository";
import { handleUserPushNotifications } from "../../services/webhooks-push";
import type { TreeEntryJson } from "@cf-gitea/git-engine";
import type { EngineClient } from "../engine";
import { readUrlEncodedForm } from "../forms";
import { MAX_DISPLAY_FILE_SIZE, isBinaryData, pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { sessionRepoGrant } from "../repo-grants";
import type { Viewer } from "../viewer";
import { FileTreeSidebar } from "./file-view";
import { resolveHeadBranch, type ResolvedRefs } from "./home";
import { resolveRefSuffix } from "../index";

/** Page chrome text (component-local, the milestonesLocale pattern — the
 *  strings cite upstream's locale keys). */
export const fileEditorLocale = {
  new_file: "New File", // "repo.editor.new_file" (the write tab's label on _new)
  edit_file: "Edit File", // "repo.editor.edit_file"
  commit_changes: "Commit Changes", // "repo.editor.commit_changes" (h3 + submit)
  cancel: "Cancel", // "repo.editor.cancel"
  name_your_file: "Name your file…", // "repo.editor.name_your_file" (the input's placeholder)
  commit_message_desc: "Add an optional extended description…", // "repo.editor.commit_message_desc"
  add_tmpl: "'<filename>'", // "repo.editor.add_tmpl" (the new-file summary placeholder)
  /** The commit_choice radios reduce to one existing-branch select (header). */
  target_branch: "Target branch", // cf-gitea addition (the radio reduction's label)
  cannot_edit_non_text: "Files cannot be edited through the web interface.", // "repo.editor.cannot_edit_non_text_files"
  cannot_edit_too_large: "The file is too large to be edited through the web interface.", // "repo.editor.cannot_edit_too_large_file"
  edit: "Edit", // the file-view action link's accessible text ("repo.edit")
  delete: "Delete", // the file-view action link's accessible text (btn-octicon tooltip upstream)
  /** cf-gitea addition: upstream's HTML5 `required` catches the empty name
   *  client-side; this is the server-side re-render message (the new-issue
   *  page's title_required convention). */
  filename_required: "A file name is required.",
  /** The service's own arm for a path the commit builder refuses — reused
   *  verbatim for the UI-side "."/".." segment check (one vocabulary). */
  invalid_path: "invalid file path",
  /** Upstream's degenerate-POST answer for an edit without a content field
   *  (editor.go:357, `error.occurred`). */
  error_occurred: "An error occurred.",
} as const;

/** The editor POST body budget: MAX_DISPLAY_FILE_SIZE (8 MiB, the display cap
 *  the edit GET already enforces) plus urlencoded-escaping headroom — see
 *  readUrlEncodedForm's maxBytes parameter. */
export const EDITOR_FORM_MAX_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The write predicate (the landed canWriteRepository, unforked — repo-access.ts)
// ---------------------------------------------------------------------------

/**
 * The repo-write grant for the editor surfaces, evaluated through the LANDED
 * `canWriteRepository` service predicate (repo-access.ts) via the shared
 * session bridge (../repo-grants.ts): site admin, the repo's owner
 * (case-folded namespace fold), a collaborator with the `write`/`admin`
 * mode, or a write/admin/owner-mode org-team grant — the same arms the
 * contents PUT enforces, so a write-team member SEES the editor entry the
 * write seam admits. Anonymous viewers never write (zero D1 reads).
 */
export async function canWriteRepo(env: Env, repo: RepoEditorRow, viewer: Viewer): Promise<boolean> {
  return sessionRepoGrant(env, repo, viewer, canWriteRepository);
}

/** The repository row the editor touches (the ui-context RepoRow). */
type RepoEditorRow = NonNullable<UiContext["repo"]>;

// ---------------------------------------------------------------------------
// Data loading (§3.2 — direct engine RPCs through the null-on-failure client)
// ---------------------------------------------------------------------------

/** The editor page's render inputs (loaded once, re-render reuses it). */
export interface FileEditorData {
  mode: "new" | "edit" | "delete";
  refs: ResolvedRefs;
  /** The URL's branch (short name — resolveRefSuffix's branch walk). */
  branch: string;
  /** The sidebar's directory (the target's parent; "" at root). */
  dirPath: string;
  siblings: TreeEntryJson[];
  /** edit/delete: the file's repo-relative path. new: the dir prefix from
   *  the URL ("" at root). */
  treePath: string;
  /** new: the filename input's initial value (`?filename=` joined onto the
   *  dir prefix, else the prefix's trailing-slash hint). */
  prefillPath: string;
  /** edit: the decoded text at load; new/delete: "". */
  content: string;
  /** edit/delete: the blob oid at load (the form's hidden CAS field). */
  blobSha: string;
  /** edit-only refusal (binary / too large): the page renders the upstream
   *  NotEditableReason segment instead of the editor. */
  notEditableReason: string | null;
}

/** `null` never resolves: an unresolvable branch, a missing path, or an
 *  editor route on an empty repo (no branch exists to target) → 404 shell. */
export async function loadFileEditorData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  mode: "new" | "edit" | "delete",
  refSuffix: string,
  filenameParam: string | null,
): Promise<FileEditorData | { notFound: true }> {
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true }; // §4.1: no branch to target
  // Branch-type only (upstream RepoRefByType(git.RefTypeBranch), web.go:1472):
  // the walk admits slash-bearing branch names, shortest prefix first.
  const resolved = resolveRefSuffix("branch", refSuffix, {
    branches: refs.branches,
    tags: refs.tags,
    defaultBranch: repo.defaultBranch,
  });
  if (resolved === null) return { notFound: true };
  const branch = resolved.ref;

  if (mode === "new") {
    const dirPath = resolved.treePath;
    const tree = dirPath === "" ? null : await engine.listTree(branch, dirPath);
    const prefill = filenameParam !== null && filenameParam !== ""
      ? dirPath === "" ? filenameParam : `${dirPath}/${filenameParam}`
      : dirPath === "" ? "" : `${dirPath}/`;
    return {
      mode,
      refs,
      branch,
      dirPath,
      siblings: tree?.entries ?? [],
      treePath: dirPath,
      prefillPath: prefill,
      content: "",
      blobSha: "",
      notEditableReason: null,
    };
  }

  // edit/delete: the path must resolve to a blob.
  const treePath = resolved.treePath;
  if (treePath === "") return { notFound: true };
  const parentDir = treePath.includes("/") ? treePath.slice(0, treePath.lastIndexOf("/")) : "";
  const baseName = treePath.split("/").pop() ?? "";
  const parentTree = await engine.listTree(branch, parentDir);
  const entry = parentTree?.entries.find((e) => e.name === baseName) ?? null;
  if (entry === null || entry.type !== "blob") return { notFound: true };

  let content = "";
  let notEditableReason: string | null = null;
  if (mode === "edit") {
    if ((entry.size ?? 0) > MAX_DISPLAY_FILE_SIZE) {
      notEditableReason = fileEditorLocale.cannot_edit_too_large;
    } else {
      const blob = await engine.readBlob(branch, treePath);
      if (blob === null) return { notFound: true };
      if (isBinaryData(blob.data)) {
        notEditableReason = fileEditorLocale.cannot_edit_non_text;
      } else {
        content = new TextDecoder().decode(blob.data);
      }
    }
  }

  return {
    mode,
    refs,
    branch,
    dirPath: parentDir,
    siblings: parentTree?.entries ?? [],
    treePath,
    prefillPath: treePath,
    content,
    blobSha: entry.oid,
    notEditableReason,
  };
}

// ---------------------------------------------------------------------------
// Form parsing + the write (§3.2 — applyFileChanges directly)
// ---------------------------------------------------------------------------

/** The parsed submission (the re-render's preserved values). `content` is
 *  `null` when the POST body carried no `content` field at all — for edit
 *  that is upstream's degenerate arm (editor.go:357), for new it reads as
 *  the empty file. */
export interface EditorFormValues {
  treePath: string;
  content: string | null;
  summary: string;
  body: string;
  branch: string;
  blobSha: string;
}

/** Parse the urlencoded POST (`tree_path`, `content`, `commit_summary`,
 *  `commit_message`, `branch`, `blob_sha` — the upstream field names plus the
 *  blob-sha CAS field). The summary/body keep the raw submission; only the
 *  message assembly trims (upstream GetCommitMessage). */
export function parseEditorForm(params: URLSearchParams): EditorFormValues {
  return {
    treePath: params.get("tree_path") ?? "",
    content: params.has("content") ? (params.get("content") ?? "") : null,
    summary: params.get("commit_summary") ?? "",
    body: params.get("commit_message") ?? "",
    branch: (params.get("branch") ?? "").trim(),
    blobSha: (params.get("blob_sha") ?? "").trim(),
  };
}

/** The GET's initial values (from the loaded data — never a submission). */
export function editorFormFromData(data: FileEditorData): EditorFormValues {
  return {
    treePath: data.mode === "new" ? data.prefillPath : data.treePath,
    content: data.mode === "edit" ? data.content : "",
    summary: "",
    body: "",
    branch: data.branch,
    blobSha: data.blobSha,
  };
}

/** `files_service.CleanGitTreePath`'s web core: non-empty segments, no
 *  "."/"..", joined. `null` = refuse (the service's "invalid file path" arm;
 *  the service itself only rejects the empty case). */
export function cleanEditorTreePath(raw: string): string | null {
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

/** Upstream's default message per operation ("repo.editor.add|update|delete"
 *  — `Add '{path}'` etc., editor.go:336, 414-418). */
export function defaultEditorMessage(mode: "new" | "edit" | "delete", path: string): string {
  const verb = mode === "new" ? "Add" : mode === "edit" ? "Update" : "Delete";
  return `${verb} '${path}'`;
}

export type FileCommitResult =
  | { outcome: "committed"; branch: string; treePath: string; ref: string; commitOid: string }
  | { outcome: "invalid"; message: string };

/**
 * The write (§3.2): validate the form's own arms, then the landed
 * `applyFileChanges` with the session viewer as author AND committer, then
 * the push-family fan-out for the applied delta. Every service ApiError
 * message re-renders inline (the service's arms — see the module header).
 */
export async function commitFileFromForm(
  env: Env,
  req: Request,
  repo: RepoEditorRow,
  userRow: UserRow,
  mode: "new" | "edit" | "delete",
  values: EditorFormValues,
): Promise<FileCommitResult> {
  const path = cleanEditorTreePath(values.treePath);
  if (path === null) {
    return { outcome: "invalid", message: values.treePath.trim() === "" ? fileEditorLocale.filename_required : fileEditorLocale.invalid_path };
  }
  if (mode === "edit" && values.content === null) {
    return { outcome: "invalid", message: fileEditorLocale.error_occurred };
  }

  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { outcome: "invalid", message: "not found" };

  // The doer identity (contents.ts:214-222 mirrored onto the session row):
  // name = login, email = the stored address or the hostname fallback.
  const hostname = new URL(req.url).hostname;
  const email = userRow.email === null || userRow.email === "" ? `${userRow.username}@noreply.${hostname}` : userRow.email;

  // Upstream GetCommitMessage (editor.go:106-111).
  const summary = values.summary.trim();
  const body = values.body.trim();
  const message = `${summary === "" ? defaultEditorMessage(mode, path) : summary}${body === "" ? "" : `\n\n${body}`}`;

  const operation = mode === "new" ? ("create" as const) : mode === "edit" ? ("update" as const) : ("delete" as const);
  // CR stripped (upstream EditFilePost, editor.go:352 — textareas submit CRLF).
  const content = operation === "delete" ? undefined : new TextEncoder().encode((values.content ?? "").replaceAll("\r", ""));

  // The service is typed against the API Context (pull-files.tsx's re-wrap
  // precedent); authUser carries the SESSION viewer — the same identity the
  // token middleware sets for the API's own write routes — so the service's
  // canWriteRepository re-check reads the same grant the page gate did.
  const apiContext = new Context<ApiEnv>(req, { env });
  apiContext.set("authUser", apiUserFromRow(userRow, { origin: new URL(req.url).origin, requester: null }));

  try {
    const result = await applyFileChanges(
      apiContext,
      pair,
      { branch: values.branch },
      [{ operation, path, content, sha: values.blobSha === "" ? undefined : values.blobSha }],
      {
        message,
        author: toPerson(null, userRow.username, email),
        committer: toPerson(null, userRow.username, email),
      },
    );
    // The push-family ride (module header): the applied delta through the
    // onPush adapter's own entry — the delivery rows a git push of this ref
    // would have produced, awaited inline like the issue write's emission.
    await handleUserPushNotifications(
      env,
      repo,
      [{ ref: result.ref, old: result.built.baseTip, next: result.refTarget }],
      userRow,
    );
    return { outcome: "committed", branch: values.branch, treePath: path, ref: result.ref, commitOid: result.built.commitOid };
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/** Read the urlencoded POST body at the editor's byte budget (forms.ts). */
export async function readEditorForm(req: Request): Promise<EditorFormValues> {
  return parseEditorForm(await readUrlEncodedForm(req, EDITOR_FORM_MAX_BYTES));
}

// ---------------------------------------------------------------------------
// Components (editor/edit.tmpl + delete.tmpl + commit_form.tmpl)
// ---------------------------------------------------------------------------

/** The `.repo-editor-header` breadcrumb (common_breadcrumb.tmpl): the repo
 *  name links the branch view, dir segments link their cumulative paths; on
 *  NEW the last segment is the full-path filename input (header comment's
 *  no-JS shape), on edit/delete everything is plain text + hidden tree_path. */
function EditorBreadcrumb(props: { repoSlug: string; branchHref: string; dirSegments: string[]; hrefFor: (prefix: string) => string; form: EditorFormValues; nameInput: boolean }) {
  const segments = props.dirSegments;
  const last = segments.length - 1;
  return (
    <div class="breadcrumb">
      <a class="section" href={props.branchHref} title={props.repoSlug}>
        {props.repoSlug}
      </a>
      {segments.map((segment, i) => (
        <>
          <span class="breadcrumb-divider">/</span>
          {i === last && props.nameInput ? (
            <span class="section">{segment}</span>
          ) : (
            <span class="section">
              <a href={props.hrefFor(segments.slice(0, i + 1).join("/"))} title={segment}>
                {segment}
              </a>
            </span>
          )}
        </>
      ))}
      {props.nameInput ? (
        <>
          {segments.length > 0 ? <span class="breadcrumb-divider">/</span> : null}
          <input
            id="file-name"
            name="tree_path"
            maxlength={255}
            required
            autocomplete="off"
            placeholder={fileEditorLocale.name_your_file}
            value={props.form.treePath}
          />
        </>
      ) : (
        <>
          {segments.length > 0 ? <span class="breadcrumb-divider">/</span> : null}
          <span class="active section" title={props.form.treePath}>
            {props.form.treePath.split("/").pop()}
          </span>
          <input type="hidden" name="tree_path" value={props.form.treePath} />
        </>
      )}
    </div>
  );
}

/** commit_form.tmpl's tail: summary, extended description, the target-branch
 *  select (the commit_choice radios' reduction), the CAS field, submit +
 *  cancel. The summary placeholder follows the template's per-mode switch:
 *  add_tmpl on new, `Update|Delete '{path}'` otherwise (commit_form.tmpl:11). */
function EditorCommitForm(props: { action: string; branches: readonly string[]; form: EditorFormValues; summaryPlaceholder: string; cancelHref: string }) {
  const selectId = "editor-target-branch";
  return (
    <div class="commit-form-wrapper">
      <div class="commit-form">
        <h3>{fileEditorLocale.commit_changes}</h3>
        <div class="field">
          <input name="commit_summary" maxlength={100} placeholder={props.summaryPlaceholder} value={props.form.summary} autocomplete="off" />
        </div>
        <div class="field">
          <textarea name="commit_message" rows={5} placeholder={fileEditorLocale.commit_message_desc}>
            {props.form.body}
          </textarea>
        </div>
        <div class="field">
          <label for={selectId}>{fileEditorLocale.target_branch}</label>
          <select id={selectId} name="branch" class="ui selection dropdown">
            {props.branches.map((name) => (
              <option value={name} selected={name === props.form.branch}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {props.form.blobSha !== "" ? <input type="hidden" name="blob_sha" value={props.form.blobSha} /> : null}
        <div class="flex-text-block">
          <button id="commit-button" type="submit" class="ui primary button">
            {fileEditorLocale.commit_changes}
          </button>
          <a class="ui button" href={props.cancelHref}>
            {fileEditorLocale.cancel}
          </a>
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). `form` carries the
 *  field values (the GET's prefills or the preserved submission); `data`
 *  carries the structure (branches, sidebar, refusals). */
export function renderFileEditorPage(options: {
  ctx: UiContext;
  data: FileEditorData;
  form: EditorFormValues;
  error: string | null;
}): string {
  return renderPage(<FileEditorPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />);
}

/** The editor page (§2.4.1 discriminator: edit.tmpl:4's
 *  `repository file editor edit`; the delete variant's `editor delete`
 *  tail is dropped — one template serves all three modes). */
export function FileEditorPage(props: { ctx: UiContext; data: FileEditorData; form: EditorFormValues; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("FileEditorPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const branchHref = `${repoLink}/src/branch/${pathEscapeSegments(data.branch)}`;
  const action =
    data.mode === "new"
      ? `${repoLink}/new/${pathEscapeSegments(data.branch)}`
      : `${repoLink}/${data.mode}/${pathEscapeSegments(data.branch)}/${pathEscapeSegments(data.treePath)}`;
  const cancelHref =
    data.mode === "new" || data.treePath === ""
      ? branchHref
      : `${branchHref}/${pathEscapeSegments(data.treePath)}`;
  const dirSegments = data.dirPath === "" ? [] : data.dirPath.split("/");
  const hrefFor = (prefix: string): string => `${branchHref}/${pathEscapeSegments(prefix)}`;
  const title = data.mode === "new" ? fileEditorLocale.new_file : data.treePath;

  return (
    <BaseLayout ctx={ctx} title={title} pageClass="repository file editor edit" activeTab="code">
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
            <form class="ui edit form" method="post" action={action}>
              <div class="repo-editor-header">
                <EditorBreadcrumb
                  repoSlug={repo.slug}
                  branchHref={branchHref}
                  dirSegments={dirSegments}
                  hrefFor={hrefFor}
                  form={form}
                  nameInput={data.mode === "new"}
                />
              </div>
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {data.notEditableReason !== null ? (
                <div class="field">
                  <div class="ui segment tw-text-center">
                    <h4>{data.notEditableReason}</h4>
                  </div>
                </div>
              ) : data.mode === "delete" ? (
                <div class="field">
                  <div class="ui segment tw-text-center">
                    <h4>
                      {defaultEditorMessage("delete", data.treePath)}
                    </h4>
                  </div>
                </div>
              ) : (
                <>
                  <div class="ui top attached header">
                    <div class="ui compact small menu small-menu-items repo-editor-menu">
                      {/* The write tab only: preview/diff tabs are JS-island
                          features and `/_preview/*` does not exist (header). */}
                      <a class="active item" href={action}>
                        <Icon name="octicon-code" size={14} />
                        {data.mode === "new" ? fileEditorLocale.new_file : fileEditorLocale.edit_file}
                      </a>
                    </div>
                  </div>
                  <div class="ui bottom attached segment tw-p-0">
                    {/* Plain visible textarea — the CodeMirror reduction
                        (header): monospace via the built CSS's utility. */}
                    <textarea
                      id="edit_area"
                      name="content"
                      class="tw-font-mono"
                      rows={20}
                      spellcheck={false}
                      data-id={`repo-${repo.slug}-${data.treePath}`}
                    >
                      {form.content ?? ""}
                    </textarea>
                  </div>
                </>
              )}
              <EditorCommitForm
                action={action}
                branches={data.refs.branches}
                form={form}
                summaryPlaceholder={
                  data.mode === "new" ? fileEditorLocale.add_tmpl : defaultEditorMessage(data.mode, data.treePath)
                }
                cancelHref={cancelHref}
              />
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
