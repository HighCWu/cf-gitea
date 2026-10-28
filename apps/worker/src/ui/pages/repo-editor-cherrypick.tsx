/**
 * The editor family's two REMAINING tails — the cherry-pick + apply-patch
 * pages (pages wave 72; MOUNTED at 1d834d6, window-2e C2b — the routes live
 * in `index.ts`), one module because the two tails share the
 * editor family's whole commit-form vocabulary (the wave-55 tails
 * precedent, pages/repo-editor-tails.tsx):
 *
 *   GET+POST /{owner}/{repo}/patch/{branch}                 the New Patch page
 *             (upstream `/{editor_action:_diffpatch}/*` — web.go:1465-1467,
 *             GET repo.NewDiffPatch / POST repo.NewDiffPatchPost,
 *             routers/web/repo/editor_apply_patch.go:16-52, binding
 *             EditRepoFileForm; template repo/editor/patch.tmpl)
 *   GET+POST /{owner}/{repo}/cherrypick/{sha}/{branch}      the Cherry-pick /
 *             Revert page (upstream
 *             `/{editor_action:_cherrypick}/{sha:([a-f0-9]{7,64})}/*` —
 *             web.go:1468-1470, GET repo.CherryPick / POST
 *             repo.CherryPickPost, routers/web/repo/editor_cherry_pick.go:
 *             17-83, binding CherryPickForm; template
 *             repo/editor/cherry_pick.tmpl)
 *
 * Upstream spells the literals with a leading underscore; the family's brief
 * pins the bare names (pages/file-editor.tsx header). Both tails sit under
 * the same `RepoRefByType(git.RefTypeBranch)` group as the wave-8 family:
 * the tail after the literal (after the sha for cherrypick) is the
 * branch+path rest and resolves against the BRANCH universe only —
 * resolveRefSuffix("branch", …) through the family loader's new arm.
 *
 * ## WRITES — both tails are RENDERED over the landed commit machinery
 *
 * The commit arm is the editor family's own: `patchToFileChanges`
 * (api/services/diffpatch.ts — the landed unified-diff parser + hunk
 * applier) → `applyFileChanges` (api/services/contents.ts — the single
 * commit-build seam, author = committer = the session viewer) + the
 * push-webhook family riding the applied delta (the wave-8 handler's
 * posture, index.ts fileEditorSubmit).
 *
 * - PATCH POST (NewDiffPatchPost, editor_apply_patch.go:28-52): the
 *   textarea's patch (CRLF pairs → LF, editor_apply_patch.go:40 — bare CR
 *   is NOT stripped here, unlike the wave-8 edit arm) applies onto the
 *   TARGET branch tip through patchToFileChanges → applyFileChanges; the
 *   default message is "Apply Patch" (locale repo.editor.patch, through
 *   GetCommitMessage's summary/body assembly, editor.go:106-111).
 * - CHERRY-PICK POST (CherryPickPost, editor_cherry_pick.go:43-83):
 *   `revert=false` renders the commit's FORWARD diff (engineReads.readDiff
 *   parent→commit over renderUnifiedDiff — upstream's fallback arm
 *   GetRawDiff→ApplyDiffPatch, editor_cherry_pick.go:64-72; the plain
 *   unified diff carries the same file ops as the RawDiffPatch mail
 *   envelope, which parseUnifiedPatch ignores) and applies it onto the
 *   target tip. `revert=true` builds the reversed FileChange[] directly
 *   (added → delete; deleted → create with the parent's bytes; modified →
 *   update with the parent's bytes — upstream GetReverseRawDiff →
 *   ApplyDiffPatch). Upstream's read-tree -m fast path (files.CherryPick,
 *   editor_cherry_pick.go:60-62) is skipped — the drift-search hunk applier
 *   is the port, exactly the landed API diffpatch route's posture.
 *
 * Response codes: success 303 → `{repoLink}/src/branch/{branch}` —
 * upstream redirectForCommitChoice's tail (editor.go:220-224) with the
 * empty TreePath both tails submit (cherry_pick.tmpl has no tree_path
 * field; patch.tmpl's is the `__dummy_for_EditRepoFileForm.TreePath(
 * Required)__` binding-satisfier the landed POST does not need). Every
 * service arm re-renders the form at 200 with the message and the submitted
 * values (the login failure convention; upstream flashes
 * repo.editor.fail_to_apply_patch "Unable to apply patch" — the service's
 * own "patch does not apply …" / "branch does not exist …" texts serve
 * here, the wave-8 mapping).
 *
 * ## Mount record (MOUNTED at 1d834d6, window-2e C2b — the wiring HANDOFF
 * is retired)
 *
 * Mounted beside the wave-8 family, following its grammar exactly
 * (index.ts parseUiRoute: the literal head claims the decoded branch+path
 * rest; bare non-literal heads fall through to the engine) — the landed
 * arms:
 *
 *  1. parseUiRoute — the wave-8 literal block claims `patch` and
 *     `cherrypick` (rest non-empty, decodeURIComponent per segment, joined
 *     into the suffix):
 *       - `patch` → `{ family: "editor-patch", owner, repo, refSuffix }`.
 *       - `cherrypick` → `splitCherryPickSuffix(suffix)` (BELOW — sha gate
 *         + branch rest, this module's export); `null` returns null (the
 *         shape falls to the engine, upstream's `({sha:([a-f0-9]{7,64})})`
 *         gate + required `/*` tail); else
 *         `{ family: "editor-cherrypick", owner, repo, sha, refSuffix }` —
 *         the sha rides the ROUTE (upstream's `:sha` segment sits BETWEEN
 *         the literal and the branch tail), the rest is the refSuffix.
 *  2. Registration beside the wave-8 uiRouter block:
 *       uiRouter.get|post("/:owner/:repo/patch/*", …)
 *       uiRouter.get|post("/:owner/:repo/cherrypick/*", …)
 *  3. Handlers mirror fileEditorPage/fileEditorSubmit (the
 *     fileEditorGate prologue: §2.8 Origin guard on POST → resolveUiRequest
 *     → anonymous login 303 → archived/write-predicate 404-shell), with
 *     `loadEditorPatchData`/`loadEditorCherryPickData` (this module) in
 *     place of loadFileEditorData and:
 *       - GET cherrypick: `?cherry-pick-type=revert` (editor_cherry_pick.go:
 *         31) selects the revert arm — pass the query param as
 *         `cherryPickType`.
 *       - POST cherrypick: `commitCherryPickFromForm(env, c.req.raw, repo,
 *         userRow, route.sha, values)`; POST patch:
 *         `commitPatchFromForm(env, c.req.raw, repo, userRow, values)`.
 *       - Success 303 `location` = `${repoLink}/src/branch/${result.branch}`
 *         (the empty-TreePath redirect tail); refusal re-renders the GET
 *         page at 200 with `error: result.message` and the submitted form
 *         values.
 *
 * ## Shared reductions (inherited from the landed family — one vocabulary)
 *
 * - commit_form.tmpl's commit_choice RADIOS reduce to ONE target-branch
 *   select of the EXISTING branches named `branch` (the wave-8 brief's
 *   reduction; the landed POST reads only `branch`) — the red Cancel rides
 *   the wave-55 restoration (commit_form.tmpl:85). No signoff, no
 *   commit-email select, no `last_commit` hidden CAS field (commit_form
 *   reductions, pages/repo-editor-tails.tsx header).
 * - The CodeMirror editor + options.tmpl menu (patch.tmpl's
 *   CodeEditorConfig) reduce to a plain visible monospace textarea (the
 *   wave-8 reduction); patch.tmpl's `tw-hidden` + `editor-loading` island
 *   is dropped.
 * - The form-fetch-action / JSONRedirect JS islands are inert: plain 303
 *   form POSTs here.
 * - Short sha prefixes: the URL gate admits 7..64 hex (upstream's pattern)
 *   but the ENGINE answers only full reachable oids — short prefixes 404
 *   (pages/commit-view.tsx's documented divergence, inherited via
 *   pages/diffpatch-files.ts).
 * - An empty revert (the commit changed nothing) refuses with the
 *   apply-failure arm — upstream's empty reverse patch fails git apply.
 */

import { Context } from "hono";

import type { ApiEnv } from "../../api/env";
import { ApiError } from "../../api/errors";
import { applyFileChanges } from "../../api/services/contents";
import { APPLY_FAILURE_MESSAGE, patchToFileChanges } from "../../api/services/diffpatch";
import { engineReads, type EngineReads } from "../../api/services/engine";
import { renderUnifiedDiff, toPerson, type FileChange } from "../../api/services/git-models";
import { apiUserFromRow, findRepositoryById, type UserRow } from "../../api/services/repository";
import { handleUserPushNotifications } from "../../services/webhooks-push";
import type { CommitJson } from "@cf-gitea/git-engine";
import type { EngineClient } from "../engine";
import { readUrlEncodedForm } from "../forms";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { EDITOR_FORM_MAX_BYTES, loadFileEditorData } from "./file-editor";
import { resolveHeadBranch, type ResolvedRefs } from "./home";

/** Page chrome text (component-local, the editorTailsLocale pattern — the
 *  strings cite upstream's locale keys). */
export const cherrypickLocale = {
  new_patch: "New Patch", // "repo.editor.new_patch" (patch.tmpl's menu item)
  patching: "Patching:", // "repo.editor.patching" (patch.tmpl's breadcrumb head)
  cherry_pick: "Cherry-pick %s onto:", // "repo.editor.cherry_pick" (breadcrumb, %s = the sha link)
  revert: "Revert %s onto:", // "repo.editor.revert" (the revert variant)
  or: "or", // "repo.editor.or"
  cancel: "Cancel", // "repo.editor.cancel_lower" (the breadcrumb tail link)
  commit_changes: "Commit Changes", // "repo.editor.commit_changes" (h3 + submit)
  commit_message_desc: "Add an optional extended description…", // "repo.editor.commit_message_desc"
  apply_patch: "Apply Patch", // "repo.editor.patch" (the PageIsPatch summary placeholder + default message)
  /** commit_form.tmpl:11's else arm — cherry-pick sets none of
   *  PageIsDelete/Upload/IsNewFile/Patch, and its TreePath is empty. */
  update_empty: "Update ",
  commit_empty_file_header: "Commit an empty file", // "repo.editor.commit_empty_file_header" (patch.tmpl form data attrs)
  commit_empty_file_text: "The file you're about to commit is empty. Proceed?", // "repo.editor.commit_empty_file_text"
} as const;

// ---------------------------------------------------------------------------
// The URL grammar — `cherrypick/{sha}/{branch}[/{path}]`
// ---------------------------------------------------------------------------

/** The sha segment's shape gate — upstream web.go:1469's
 *  `({sha:([a-f0-9]{7,64})})` verbatim (existence is the engine read's
 *  answer; short prefixes 404 at the engine — module header). */
const CHERRY_PICK_SHA = /^[0-9a-f]{7,64}$/i;

export interface SplitCherryPickSuffix {
  /** The URL's sha segment (verbatim — the revert prefill cites it, as
   *  upstream's ctx.PathParam("sha") does, editor_cherry_pick.go:33). */
  sha: string;
  /** The branch+path rest (resolveRefSuffix's branch-universe input). */
  rest: string;
}

/** Split the cherrypick tail into its sha segment and the branch rest.
 *  `null` = a missing/malformed sha or no branch tail at all (upstream's
 *  route pattern requires `{sha}/*` — both segments). */
export function splitCherryPickSuffix(suffix: string): SplitCherryPickSuffix | null {
  const slash = suffix.indexOf("/");
  const sha = slash < 0 ? suffix : suffix.slice(0, slash);
  const rest = slash < 0 ? "" : suffix.slice(slash + 1);
  if (!CHERRY_PICK_SHA.test(sha) || rest === "") return null;
  return { sha, rest };
}

// ---------------------------------------------------------------------------
// Data loading (the family loader's new arm — branch walk, no blob)
// ---------------------------------------------------------------------------

/** The cherry-pick page's render inputs (CherryPick, editor_cherry_pick.go:
 *  17-41). */
export interface EditorCherryPickData {
  refs: ResolvedRefs;
  /** The URL's branch (short name — the select's default, the breadcrumb's
   *  BranchLink). */
  branch: string;
  /** The URL's sha segment (verbatim). */
  sha: string;
  /** The picked commit (the prefill's message source). */
  commit: CommitJson;
  /** The `?cherry-pick-type=revert` selection (editor_cherry_pick.go:31). */
  revert: boolean;
}

/** `null` never resolves: a malformed sha/branch shape, an unresolvable
 *  branch, an unborn repo, or a commit the engine cannot read → 404 shell
 *  (the family's §4.1 arm; upstream HandleGitError answers the error
 *  page — the 404 family here). */
export async function loadEditorCherryPickData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  refSuffix: string,
  cherryPickType: string | null,
): Promise<EditorCherryPickData | { notFound: true }> {
  const split = splitCherryPickSuffix(refSuffix);
  if (split === null) return { notFound: true };
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true }; // §4.1: no branch to target
  const resolved = resolveBranchSuffix(split.rest, repo, refs);
  if (resolved === null) return { notFound: true };
  const commit = await engine.readCommit(split.sha);
  if (commit === null) return { notFound: true };
  return {
    refs,
    branch: resolved,
    sha: split.sha,
    commit,
    revert: cherryPickType === "revert",
  };
}

/** The patch page's render inputs (NewDiffPatch, editor_apply_patch.go:
 *  16-25 — PageIsPatch + the diff.patch CodeEditorConfig; no sidebar in
 *  patch.tmpl, so only the refs + branch). */
export interface EditorPatchData {
  refs: ResolvedRefs;
  branch: string;
}

/** `null` never resolves: an unresolvable branch / unborn repo → 404 shell
 *  (the family's §4.1 arm). */
export async function loadEditorPatchData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  refSuffix: string,
): Promise<EditorPatchData | { notFound: true }> {
  // The family loader's new arm IS the read: the branch walk, no blob
  // requirement (the loadEditorUploadData precedent).
  const data = await loadFileEditorData(engine, repo, "new", refSuffix, null);
  if ("notFound" in data) return data;
  return { refs: data.refs, branch: data.branch };
}

/** resolveRefSuffix's branch-universe call (the family grammar's walk) —
 *  re-bound here so the module does not import from ../index (the bench
 *  modules' import posture; the wiring handler already has the parser). */
function resolveBranchSuffix(
  rest: string,
  repo: { defaultBranch: string },
  refs: ResolvedRefs,
): string | null {
  const parts = rest.split("/");
  const walk = (names: readonly string[]): string | null => {
    const set = new Set(names);
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join("/");
      if (set.has(candidate)) return candidate;
    }
    return null;
  };
  const hit = walk(refs.branches);
  if (hit !== null) return hit;
  if (parts[0] === "HEAD") {
    const fallback = refs.branches.includes(repo.defaultBranch)
      ? repo.defaultBranch
      : (refs.branches[0] ?? null);
    if (fallback !== null) return fallback;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Form parsing (the upstream field names)
// ---------------------------------------------------------------------------

/** The cherry-pick POST body (CherryPickForm = CommitCommonForm + Revert,
 *  services/forms/repo_form_editor.go:48-52 — through the family's field
 *  vocabulary: `branch` carries the reduced commit_choice). */
export interface CherryPickFormValues {
  /** The hidden `revert` field (cherry_pick.tmpl:10 — "true"/"false"). */
  revert: boolean;
  summary: string;
  body: string;
  branch: string;
}

/** The GET's initial values (CherryPick's prefills, editor_cherry_pick.go:
 *  31-38 — revert: `revert {sha}` / `revert {message}`; cherry-pick:
 *  MessageTitle/MessageBody, modules/git/commit_message.go:53-66 =
 *  Cut(TrimSpace(message), "\n") trimmed both sides). */
export function cherryPickFormFromData(data: EditorCherryPickData): CherryPickFormValues {
  const trimmed = data.commit.message.trim();
  const cut = trimmed.indexOf("\n");
  const title = cut < 0 ? trimmed : trimmed.slice(0, cut);
  const body = cut < 0 ? "" : trimmed.slice(cut + 1).trim();
  return data.revert
    ? { revert: true, summary: `revert ${data.sha}`, body: `revert ${trimmed}`, branch: data.branch }
    : { revert: false, summary: title, body, branch: data.branch };
}

/** Parse the urlencoded POST (`revert`, `commit_summary`, `commit_message`,
 *  `branch`). The summary/body keep the raw submission; only the message
 *  assembly trims (upstream GetCommitMessage). */
export function parseCherryPickForm(params: URLSearchParams): CherryPickFormValues {
  return {
    revert: (params.get("revert") ?? "") === "true",
    summary: params.get("commit_summary") ?? "",
    body: params.get("commit_message") ?? "",
    branch: (params.get("branch") ?? "").trim(),
  };
}

/** The patch POST body (EditRepoFileForm's patch arm — `content` +
 *  CommitCommonForm; the hidden dummy tree_path satisfies upstream's
 *  Required binding and is not carried). `content` is `null` when the POST
 *  body carried no `content` field at all — the degenerate arm. */
export interface PatchFormValues {
  content: string | null;
  summary: string;
  body: string;
  branch: string;
}

/** The GET's initial values (patch.tmpl renders `.FileContent` — empty on
 *  NewDiffPatch, editor_apply_patch.go:16-25). */
export function patchFormFromData(data: EditorPatchData): PatchFormValues {
  return { content: "", summary: "", body: "", branch: data.branch };
}

/** Parse the urlencoded POST (`content`, `commit_summary`, `commit_message`,
 *  `branch`). */
export function parsePatchForm(params: URLSearchParams): PatchFormValues {
  return {
    content: params.has("content") ? (params.get("content") ?? "") : null,
    summary: params.get("commit_summary") ?? "",
    body: params.get("commit_message") ?? "",
    branch: (params.get("branch") ?? "").trim(),
  };
}

/** Read the urlencoded POST body at the editor's byte budget (forms.ts; the
 *  patch content shares the wave-8 budget — EDITOR_FORM_MAX_BYTES). */
export async function readCherryPickForm(req: Request): Promise<CherryPickFormValues> {
  return parseCherryPickForm(await readUrlEncodedForm(req, EDITOR_FORM_MAX_BYTES));
}

/** Read the urlencoded POST body at the editor's byte budget (forms.ts). */
export async function readPatchForm(req: Request): Promise<PatchFormValues> {
  return parsePatchForm(await readUrlEncodedForm(req, EDITOR_FORM_MAX_BYTES));
}

// ---------------------------------------------------------------------------
// The write arms (the editor commit arm: patchToFileChanges → applyFileChanges)
// ---------------------------------------------------------------------------

export type PatchCommitResult =
  | { outcome: "committed"; branch: string; commitOid: string }
  | { outcome: "invalid"; message: string };

/**
 * The cherry-pick/revert change list (CherryPickPost's ApplyDiffPatch
 * machinery, editor_cherry_pick.go:60-81, over the landed services).
 * Throws the apply-failure 422 ApiError family — the caller re-renders its
 * message (the wave-8 mapping).
 */
export async function cherryPickFileChanges(
  reads: EngineReads,
  sha: string,
  targetTip: string,
  revert: boolean,
): Promise<FileChange[]> {
  const diff = await reads.readDiff(sha);
  if (diff === null) {
    throw new ApiError(422, `${APPLY_FAILURE_MESSAGE}: commit ${sha} is not readable`);
  }
  if (!revert) {
    // The forward arm: upstream's fallback (GetRawDiff → ApplyDiffPatch,
    // editor_cherry_pick.go:67-72) — the plain unified diff over the
    // drift-search hunk applier, applied against the TARGET tip.
    return await patchToFileChanges(reads, targetTip, renderUnifiedDiff(diff.files));
  }
  // The reverse arm (GetReverseRawDiff → ApplyDiffPatch, :65-66): the
  // commit's file set flipped against the parent's bytes.
  const changes: FileChange[] = [];
  for (const file of diff.files) {
    if (file.old === null) {
      // the commit added it — the revert removes it
      changes.push({ operation: "delete", path: file.path });
      continue;
    }
    const blob = await reads.readBlob(diff.old ?? undefined, file.path);
    if (blob === null) {
      throw new ApiError(422, `${APPLY_FAILURE_MESSAGE}: cannot restore ${file.path} from the parent tree`);
    }
    changes.push(
      file.new === null
        ? { operation: "create", path: file.path, content: blob.data }
        : { operation: "update", path: file.path, content: blob.data },
    );
  }
  if (changes.length === 0) {
    throw new ApiError(422, `${APPLY_FAILURE_MESSAGE}: the commit changes nothing`);
  }
  return changes;
}

/** Upstream GetCommitMessage (editor.go:106-111) over the tail's default:
 *  a non-empty trimmed summary replaces the default, a non-empty trimmed
 *  body appends after a blank line. */
function commitMessage(summary: string, body: string, fallback: string): string {
  const trimmedSummary = summary.trim();
  const trimmedBody = body.trim();
  return `${trimmedSummary === "" ? fallback : trimmedSummary}${trimmedBody === "" ? "" : `\n\n${trimmedBody}`}`;
}

/**
 * The shared apply tail: the landed `applyFileChanges` with the session
 * viewer as author AND committer (the wave-8 commitFileFromForm's
 * construction verbatim — doer identity, API-context re-wrap, the
 * push-webhook family riding the applied delta), then the result mapping
 * (service ApiError message re-rendered inline).
 */
async function applyCommitArm(
  env: Env,
  req: Request,
  repo: NonNullable<UiContext["repo"]>,
  userRow: UserRow,
  branch: string,
  changes: FileChange[],
  message: string,
): Promise<PatchCommitResult> {
  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { outcome: "invalid", message: "not found" };
  const hostname = new URL(req.url).hostname;
  const email = userRow.email === null || userRow.email === "" ? `${userRow.username}@noreply.${hostname}` : userRow.email;
  const apiContext = new Context<ApiEnv>(req, { env });
  apiContext.set("authUser", apiUserFromRow(userRow, { origin: new URL(req.url).origin, requester: null }));
  try {
    const result = await applyFileChanges(apiContext, pair, { branch }, changes, {
      message,
      author: toPerson(null, userRow.username, email),
      committer: toPerson(null, userRow.username, email),
    });
    await handleUserPushNotifications(
      env,
      repo,
      [{ ref: result.ref, old: result.built.baseTip, next: result.refTarget }],
      userRow,
    );
    return { outcome: "committed", branch, commitOid: result.built.commitOid };
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/**
 * The cherry-pick POST write (CherryPickPost, editor_cherry_pick.go:43-83):
 * resolve the target tip, build the forward/reverse changes, apply. The
 * default message is the locale commit header ("repo.commit.cherry-pick-
 * header" = `Cherry-pick: {sha}` / "repo.commit.revert-header" =
 * `Revert: {sha}`).
 */
export async function commitCherryPickFromForm(
  env: Env,
  req: Request,
  repo: NonNullable<UiContext["repo"]>,
  userRow: UserRow,
  sha: string,
  values: CherryPickFormValues,
): Promise<PatchCommitResult> {
  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { outcome: "invalid", message: "not found" };
  const reads = engineReads(env, pair.repo);
  const targetTip = (await reads.listRefs())?.refs.find((ref) => ref.name === `refs/heads/${values.branch}`)?.target;
  if (targetTip === undefined) {
    return { outcome: "invalid", message: `branch does not exist [name: ${values.branch}]` };
  }
  let changes: FileChange[];
  try {
    changes = await cherryPickFileChanges(reads, sha, targetTip, values.revert);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  const fallback = values.revert ? `Revert: ${sha}` : `Cherry-pick: ${sha}`;
  return await applyCommitArm(env, req, repo, userRow, values.branch, changes, commitMessage(values.summary, values.body, fallback));
}

/**
 * The patch POST write (NewDiffPatchPost, editor_apply_patch.go:28-52):
 * CRLF pairs → LF (editor_apply_patch.go:40 — bare CR stays, unlike the
 * wave-8 edit arm), apply onto the target tip, default message "Apply
 * Patch" (repo.editor.patch, editor_apply_patch.go:34).
 */
export async function commitPatchFromForm(
  env: Env,
  req: Request,
  repo: NonNullable<UiContext["repo"]>,
  userRow: UserRow,
  values: PatchFormValues,
): Promise<PatchCommitResult> {
  if (values.content === null) {
    return { outcome: "invalid", message: "An error occurred." }; // editor.go:357's degenerate arm ("error.occurred")
  }
  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return { outcome: "invalid", message: "not found" };
  const reads = engineReads(env, pair.repo);
  const targetTip = (await reads.listRefs())?.refs.find((ref) => ref.name === `refs/heads/${values.branch}`)?.target;
  if (targetTip === undefined) {
    return { outcome: "invalid", message: `branch does not exist [name: ${values.branch}]` };
  }
  let changes: FileChange[];
  try {
    changes = await patchToFileChanges(reads, targetTip, values.content.replaceAll("\r\n", "\n"));
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  return await applyCommitArm(env, req, repo, userRow, values.branch, changes, commitMessage(values.summary, values.body, cherrypickLocale.apply_patch));
}

// ---------------------------------------------------------------------------
// Components (cherry_pick.tmpl + patch.tmpl + commit_form.tmpl)
// ---------------------------------------------------------------------------

/** commit_form.tmpl's tail through the family reduction: summary input
 *  (maxlength 100, the per-tail placeholder), extended-description
 *  textarea (rows 5), the target-branch select (the commit_choice radios'
 *  reduction — module header), then commit-button + the RED cancel
 *  (commit_form.tmpl:82-85). No CAS hidden field on either tail (the
 *  wave-55 reduction posture; cherrypick's identity rides the URL sha). */
function CherryPickCommitForm(props: { branches: readonly string[]; form: { summary: string; body: string; branch: string }; summaryPlaceholder: string; cancelHref: string }) {
  const selectId = "editor-cherrypick-target-branch";
  return (
    <div class="commit-form-wrapper">
      <div class="commit-form">
        <h3>{cherrypickLocale.commit_changes}</h3>
        <div class="field">
          <input name="commit_summary" maxlength={100} placeholder={props.summaryPlaceholder} value={props.form.summary} autocomplete="off" />
        </div>
        <div class="field">
          <textarea name="commit_message" rows={5} placeholder={cherrypickLocale.commit_message_desc}>
            {props.form.body}
          </textarea>
        </div>
        <div class="field">
          {/* cf-gitea addition, the family's own label for the radio
              reduction (pages/file-editor.tsx target_branch). */}
          <label for={selectId}>Target branch</label>
          <select id={selectId} name="branch" class="ui selection dropdown">
            {props.branches.map((name) => (
              <option value={name} selected={name === props.form.branch}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div class="flex-text-block">
          <button id="commit-button" type="submit" class="ui primary button">
            {cherrypickLocale.commit_changes}
          </button>
          <a class="ui button red" href={props.cancelHref}>
            {cherrypickLocale.cancel}
          </a>
        </div>
      </div>
    </div>
  );
}

/** cherry_pick.tmpl's breadcrumb (lines 12-22): the revert/cherry-pick
 *  locale line with the sha link (`{repoLink}/commit/{sha}`, ShortSha =
 *  7 chars), the repo + branch sections, the `or Cancel` tail onto the
 *  commit URL. */
function CherryPickBreadcrumb(props: { repoSlug: string; repoLink: string; branchHref: string; branch: string; sha: string; revert: boolean }) {
  const shaUrl = `${props.repoLink}/commit/${props.sha}`;
  const pattern = props.revert ? cherrypickLocale.revert : cherrypickLocale.cherry_pick;
  const [before, after] = pattern.split("%s");
  return (
    <div class="breadcrumb">
      {before}
      <a class="ui primary sha label" href={shaUrl}>
        {props.sha.slice(0, 7)}
      </a>
      {after}
      <a class="section" href={props.repoLink}>
        {props.repoSlug}
      </a>
      <div class="breadcrumb-divider">:</div>
      <a class="section" href={props.branchHref}>
        {props.branch}
      </a>
      <span>
        {cherrypickLocale.or} <a href={shaUrl}>{cherrypickLocale.cancel}</a>
      </span>
    </div>
  );
}

/** The full-document cherry-pick render (cherry_pick.tmpl at the pin). */
export function renderEditorCherryPickPage(options: {
  ctx: UiContext;
  data: EditorCherryPickData;
  form: CherryPickFormValues;
  error: string | null;
}): string {
  return renderPage(
    <EditorCherryPickPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The cherry-pick page (§2.4.1 discriminator: cherry_pick.tmpl:4's
 *  `repository file editor edit` — the one class serves both tails). */
export function EditorCherryPickPage(props: { ctx: UiContext; data: EditorCherryPickData; form: CherryPickFormValues; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EditorCherryPickPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const branchHref = `${repoLink}/src/branch/${pathEscapeSegments(data.branch)}`;
  const action = `${repoLink}/cherrypick/${data.sha}/${pathEscapeSegments(data.branch)}`;
  return (
    <BaseLayout ctx={ctx} title={data.commit.subject} pageClass="repository file editor edit" activeTab="code">
      <div class="ui container">
        <form class="ui edit form form-fetch-action" method="post" action={action}>
          {/* cherry_pick.tmpl:10 — the hidden revert flag ("true"/"false"). */}
          <input type="hidden" name="revert" value={data.revert ? "true" : "false"} />
          <div class="repo-editor-header">
            <CherryPickBreadcrumb
              repoSlug={repo.slug}
              repoLink={repoLink}
              branchHref={branchHref}
              branch={data.branch}
              sha={data.sha}
              revert={data.revert}
            />
          </div>
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <CherryPickCommitForm
            branches={data.refs.branches}
            form={form}
            summaryPlaceholder={cherrypickLocale.update_empty}
            cancelHref={`${repoLink}/commit/${data.sha}`}
          />
        </form>
      </div>
    </BaseLayout>
  );
}

/** patch.tmpl's breadcrumb (lines 15-27): "Patching:" + the repo + branch
 *  sections + the `or Cancel` tail onto the branch, then the hidden dummy
 *  tree_path (the Required binding satisfier — the landed POST does not
 *  read it) and the hidden `#file-name` value "diff.patch". */
function PatchBreadcrumb(props: { repoSlug: string; repoLink: string; branchHref: string; branch: string }) {
  return (
    <div class="breadcrumb">
      {cherrypickLocale.patching}
      <a class="section" href={props.repoLink}>
        {props.repoSlug}
      </a>
      <div class="breadcrumb-divider">:</div>
      <a class="section" href={props.branchHref}>
        {props.branch}
      </a>
      <span>
        {cherrypickLocale.or} <a href={props.branchHref}>{cherrypickLocale.cancel}</a>
      </span>
      <input type="hidden" name="tree_path" value="__dummy_for_EditRepoFileForm.TreePath(Required)__" />
      <input id="file-name" type="hidden" value="diff.patch" />
    </div>
  );
}

/** The full-document patch render (patch.tmpl at the pin). */
export function renderEditorPatchPage(options: {
  ctx: UiContext;
  data: EditorPatchData;
  form: PatchFormValues;
  error: string | null;
}): string {
  return renderPage(
    <EditorPatchPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The patch page (§2.4.1 discriminator: patch.tmpl:4's
 *  `repository file editor edit`). The CodeMirror island reduces to a
 *  plain visible monospace textarea (the wave-8 reduction); the form
 *  carries patch.tmpl:10-12's empty-commit-confirm data attributes. */
export function EditorPatchPage(props: { ctx: UiContext; data: EditorPatchData; form: PatchFormValues; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EditorPatchPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const branchHref = `${repoLink}/src/branch/${pathEscapeSegments(data.branch)}`;
  const action = `${repoLink}/patch/${pathEscapeSegments(data.branch)}`;
  return (
    <BaseLayout ctx={ctx} title={cherrypickLocale.new_patch} pageClass="repository file editor edit" activeTab="code">
      <div class="ui container">
        <form
          class="ui edit form form-fetch-action"
          method="post"
          action={action}
          data-text-empty-confirm-header={cherrypickLocale.commit_empty_file_header}
          data-text-empty-confirm-content={cherrypickLocale.commit_empty_file_text}
        >
          <div class="repo-editor-header">
            <PatchBreadcrumb repoSlug={repo.slug} repoLink={repoLink} branchHref={branchHref} branch={data.branch} />
          </div>
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="field">
            <div class="ui top attached header">
              <div class="flex-left-right">
                <div class="ui compact small menu small-menu-items repo-editor-menu">
                  {/* The single tab: options.tmpl's CodeMirror config menu
                      is a JS island, unrendered (module header). */}
                  <a class="active item" href={action}>
                    <Icon name="octicon-code" size={14} />
                    {cherrypickLocale.new_patch}
                  </a>
                </div>
              </div>
            </div>
            <div class="ui bottom attached segment tw-p-0">
              {/* Plain visible textarea — the CodeMirror reduction; upstream
                  hides it (`tw-hidden`) behind the loading island. */}
              <textarea id="edit_area" name="content" class="tw-font-mono" rows={20} spellcheck={false} data-id={`repo-${repo.slug}-patch`}>
                {form.content ?? ""}
              </textarea>
            </div>
          </div>
          <CherryPickCommitForm
            branches={data.refs.branches}
            form={form}
            summaryPlaceholder={cherrypickLocale.apply_patch}
            cancelHref={branchHref}
          />
        </form>
      </div>
    </BaseLayout>
  );
}
