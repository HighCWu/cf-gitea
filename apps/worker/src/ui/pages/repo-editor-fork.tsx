/**
 * The editor family's FORK-TO-EDIT seam — census gap #13 (pages wave 129
 * batch; the flow the wave-8 header documented as 404-shell). Upstream:
 * a reader without write pressing Edit renders `templates/repo/editor/fork`
 * (`NeedFork`, services/context/repo.go:191-197 — "no fork of this source
 * yet"); confirming POSTs `/{owner}/{repo}/_fork/{branch}`
 * (`m.Post("/_fork/*", repo.ForkToEditPost)`, routers/web/web.go:1450,
 * routers/web/repo/editor_fork.go — "read-only, fork to own repo, fine with
 * 'code reader'"), the server forks and answers `{"redirect": ""}`
 * (`ctx.JSONRedirect("")`), and the bundle's form-fetch-action
 * (`window.location.reload()`, web_src/js/modules/fetch-action.ts:77-82)
 * reloads the editor page — where `PrepareCommitFormOptions` now FINDS the
 * fresh fork (`GetForkedRepo`) and renders the editor with
 * `TargetFormAction` pointing at the FORK's own editor route
 * (`WillSubmitToFork`, repo.go:203-206 + 244-249: the fork's default branch
 * in the URL, `?from_base_branch=` carrying the base branch). The edit then
 * POSTs onto the fork, where the doer is the owner and the landed write
 * admits them. THIS module owns every fork-shaped piece of that flow:
 *
 *   - `renderEditorForkPrompt` — fork.tmpl's full-document port (the prompt
 *     the editor GET renders instead of the editor);
 *   - `resolveEditorForkBranch` — the RepoRefByType(branch) arm the prompt
 *     and the `/_fork` POST share (upstream resolves the branch BEFORE the
 *     handler; an unresolvable tail 404s there);
 *   - `EditorForkOverlay` + `editorForkTargetAction` + `loadEditorForkOverlay`
 *     — the WillSubmitToFork render overlay (TargetFormAction port: the
 *     fork's default branch + treePath + `from_base_branch`, repo.go:244-258)
 *     and common_top.tmpl's blue banner (`EditorForkBanner`), which the
 *     file-editor page and the tails pages accept as an optional prop;
 *   - `createForkToEdit` — ForkToEditPost's port over the LANDED fork
 *     service (createFork, api/services/forks.ts): ForkRepository's arm
 *     order — blocked (services/repository/fork.go:64), the GetUserFork
 *     one-fork-per-owner probe (fork.go:75-82; landed findForkByOwner), the
 *     `getUniqueRepositoryName` loop (editor_util.go:114-131, ported with
 *     its double-increment quirk), then createFork;
 *   - `editorForkReturnTarget` — the no-JS reload reduction: upstream's
 *     empty redirect reloads the CURRENT page through the bundle; this port
 *     carries the current editor URL in the prompt form's hidden
 *     `return_uri` (upstream's own field name — redirectForCommitChoice
 *     reads `ctx.FormString("return_uri")` with
 *     `httplib.IsCurrentGiteaSiteURL` validation, editor.go:225-231) and
 *     303s onto it, validated site-relative AND scoped to the same repo
 *     (stricter than upstream: a forged return_uri cannot bounce across
 *     repos or leak fork existence).
 *
 * ## Wiring (LANDED — the ui/index.ts mount record, f9907f9)
 *
 * The routes live in `index.ts` (this module is pure seams — the repo-fork
 * precedent): the `/_fork/{branch}` claim shape, the POST registration, the
 * gate's non-writer split, and the handlers' overlay fold are LANDED there
 * (f9907f9) — the `EditorForkRoute` union arm, the parse claim at the
 * `head === "_fork"` literal, `editorForkSubmit` over
 * `uiRouter.post("/:owner/:repo/_fork/*", …)`, the fileEditorGate forkArm
 * overload pulling the four overlay-mounted GET families into the fork
 * flow, and the banner/action/branch overlay folded into
 * fileEditorPage/fileUploadPage. The `/_fork` literal keeps upstream's
 * underscore — it is NOT one
 * of the bare-named editor_action combos (the family brief pins those bare;
 * `/_fork` is upstream's own spelling). POST-only registration: a GET
 * `/_fork/...` misses to the parent app's plain 404 (upstream chi answers
 * 405 — the tags-delete posture).
 *
 * ## Documented v1 reductions (the family's method)
 *
 * - The prompt form carries ONE field upstream does not (`return_uri`) —
 *   the no-JS reload reduction above; upstream's field set is empty because
 *   the bundle reloads. One URL, same destination (the `?filename=` prefill
 *   reduction's shape, pages/file-editor.tsx header).
 * - The fork-targeting editor commits DIRECTLY onto the fork's default
 *   branch (the landed POST reads only `branch`; the commit_choice radios
 *   and the `new_branch` arm are the family's reduction — upstream's
 *   `from_base_branch` new-branch push, editor.go:163-171, stays API-only).
 *   The `from_base_branch` query rides the action URL exactly as upstream
 *   carries it; the landed POST ignores it (inert under the reduction).
 * - The fork's engine refs fill the target-branch select; a fork still
 *   settling ('creating', engine cell empty) renders the select with the
 *   fork's `default_branch` row value alone — the replication creates
 *   exactly that branch. A commit POSTing before the settle lands 404s on
 *   the fork's editor route (no branch to resolve) — the repo-fork page's
 *   documented strand posture (the fork 404-shells until the push lands).
 * - The stale-fork CAS: the fork-targeting page renders the BASE repo's
 *   blob sha (upstream reads `ctx.Repo` — base — for the content too); the
 *   landed per-blob CAS then guards the commit on the FORK's blob. Fresh
 *   fork (tip = base tip) the shas match; a stale fork surfaces the landed
 *   sha-mismatch re-render — the same drift refusal upstream's
 *   `last_commit` guard produces on a stale fork.
 * - The fork-not-editable refusal (upstream `WillSubmitToFork &&
 *   !TargetRepo.CanContentChange()` → NotFoundPrompt 404 with
 *   "repo.editor.fork_not_editable") answers the landed plain 404 shell —
 *   the landed renderNotFound carries no prompt slot.
 * - Upstream's double-POST race (fork exists at POST time after the prompt
 *   rendered) answers ServerError upstream (ErrForkAlreadyExist falls
 *   through ForkRepoTo's switch, fork.go:204-247); this port probes first
 *   and answers the reload — the exact page the reloaded GET renders once
 *   the fork exists (the landed repo-fork page's existing-fork arm shape).
 * - The reach-limit arm (ForkRepository's CanForkRepoIn) is unported — the
 *   landed repos service models no repo-creation quota (the repo-fork
 *   page's omission, kept).
 * - The prompt page's aria-label: upstream renders `{{.Title}}` UNSET
 *   (ForkToEdit never sets it); this port titles the page with the
 *   fork_create heading (every landed page titles itself — BaseLayout's
 *   title is the role=main aria-label).
 */

import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../../api/services/blocks";
import {
  createFork,
  findForkByOwner,
  type ForkServiceDeps,
} from "../../api/services/forks";
import { findRepositoryById } from "../../api/services/repository";
import { repositories } from "../../db/schema";
import type { EngineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { resolveRefSuffix } from "../index";
import { resolveHeadBranch } from "./home";

/** Page chrome text (component-local, the fileEditorLocale pattern — the
 *  strings are upstream's locale keys verbatim, locale_en-US.json:962+1328-
 *  1331). */
export const editorForkLocale = {
  fork_create: "Fork Repository to Propose Changes", // "repo.editor.fork_create" (the prompt's h3)
  fork_create_description:
    "You cannot edit this repository directly. Instead you can create a fork, make edits and create a pull request.", // "repo.editor.fork_create_description" (the prompt's p)
  fork_repo: "Fork Repository", // "repo.fork_repo" (the prompt's submit, fork.tmpl:13)
  /** common_top.tmpl's WillSubmitToFork banner — the words AROUND the fork
   *  link (the link itself is rendered HTML: <b><a>owner/name</a></b>). */
  fork_edit_prefix: "You cannot edit this repository directly. The changes will be written to your fork ",
  fork_edit_suffix: ", so you can create a pull request.", // "repo.editor.fork_edit_description" (locale_en-US.json:1330)
} as const;

// ---------------------------------------------------------------------------
// The prompt (templates/repo/editor/fork.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document prompt render (fork.tmpl:2-15): page-content class is
 *  bare `repository` (fork.tmpl carries no `file editor` tail), the plain
 *  `.ui.container` (NOT the editor family's fluid padded), the centered
 *  form POSTing `/_fork/{branch}`, h3 + p, one primary button. The hidden
 *  `return_uri` is this port's no-JS reload reduction (module header) —
 *  upstream's form carries no fields because the bundle reloads. `error`
 *  is base/alert's slot (the invalid-arm re-render). */
export function renderEditorForkPrompt(options: {
  ctx: UiContext;
  /** The resolved branch short name (the form action's tail). */
  branch: string;
  /** The current editor URL (path + query) the POST 303s back onto. */
  returnUri: string;
  error: string | null;
}): string {
  return renderPage(<EditorForkPromptPage ctx={options.ctx} branch={options.branch} returnUri={options.returnUri} error={options.error} />);
}

/** The fork.tmpl page (§2.4.1 discriminator: fork.tmpl:4's bare
 *  `page-content repository`). */
export function EditorForkPromptPage(props: { ctx: UiContext; branch: string; returnUri: string; error: string | null }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("EditorForkPromptPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const action = `${repoLink}/_fork/${pathEscapeSegments(props.branch)}`;
  return (
    <BaseLayout ctx={ctx} title={editorForkLocale.fork_create} pageClass="repository" activeTab="code">
      <div class="ui container">
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        <form class="ui form form-fetch-action" method="post" action={action}>
          <input type="hidden" name="return_uri" value={props.returnUri} />
          <div class="tw-text-center">
            <div class="tw-my-[40px]">
              <h3>{editorForkLocale.fork_create}</h3>
              <p>{editorForkLocale.fork_create_description}</p>
            </div>
            <button type="submit" class="ui primary button">
              {editorForkLocale.fork_repo}
            </button>
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The branch resolution (the prompt's and the POST's shared RepoRefByType arm)
// ---------------------------------------------------------------------------

/**
 * The `RepoRefByType(git.RefTypeBranch)` arm for the fork flow (upstream
 * resolves the branch in middleware BEFORE ForkToEdit/EditFile run — web.go
 * :1449's group wrap; an unresolvable tail 404s there): the same branch
 * walk `loadFileEditorData` heads with (resolveHeadBranch + the branch-type
 * resolveRefSuffix), WITHOUT the treePath/blob requirements — upstream
 * renders the prompt without reading the file (the fork check precedes
 * editFileOpenExisting, editor.go:57-68). `null` = the repo has no refs or
 * the tail names no branch → the caller's 404 shell.
 */
export async function resolveEditorForkBranch(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  refSuffix: string,
): Promise<string | null> {
  // resolveRefSuffix walks the branch universe against the LIVE refs — the
  // same walk the family loader heads with (pages/file-editor.tsx:228).
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return null;
  const resolved = resolveRefSuffix("branch", refSuffix, {
    branches: refs.branches,
    tags: refs.tags,
    defaultBranch: repo.defaultBranch,
  });
  return resolved?.ref ?? null;
}

// ---------------------------------------------------------------------------
// The WillSubmitToFork overlay (TargetFormAction port + the banner)
// ---------------------------------------------------------------------------

/** The fork-targeting render overlay (services/context/repo.go's
 *  CommitFormOptions arms the landed family renders): the form's action
 *  onto the FORK's editor route, the fork's branches for the commit select,
 *  and the banner's fork label. The pages accept it as an optional prop —
 *  absent, everything renders exactly as before (byte-identical). */
export interface EditorForkOverlay {
  /** `TargetFormAction` (repo.go:254-258): the fork's editor URL built by
   *  `editorForkTargetAction`. */
  action: string;
  /** The fork's existing branches (the commit select's list) — the POST
   *  lands on the fork, so the select must name ITS branches; a
   *  still-settling fork renders `[defaultBranch]` (module header). */
  branches: string[];
  /** The fork's default branch (the select's initial value — the POST's
   *  `branch`). */
  defaultBranch: string;
  /** The banner's link target + text (`TargetRepo.Link` /
   *  `TargetRepo.FullName`). */
  fullName: string;
  forkLink: string;
}

/**
 * `TargetFormAction` (services/context/repo.go:251-258): the FORK's link +
 * the editor literal + the fork's DEFAULT branch + the treePath + the
 * `from_base_branch` query, then the current page's query appended
 * (upstream appends `ctx.Req.URL.RawQuery` through the Iif's ?/& switch).
   * `editorLiteral` is the page's OWN URL literal (the family's bare names —
   * `new|edit|delete|upload|patch`, with `patch` the documented bare
   * divergence; `_cherrypick` carries the sha between the literal and the
   * branch, web.go:1469's `{sha}` segment — pass it as `sha`; upstream
   * passes the `_cherrypick` literal verbatim through this construction,
   * repo.go:258-259, and the bare spelling is not an editor_action).
   * Pass `query` with its leading `?`/`&`-free form (the raw
 * `url.search` substring WITHOUT the leading `?` — "" when none).
 */
export function editorForkTargetAction(options: {
  forkLink: string;
  editorLiteral: string;
  /** _cherrypick only (web.go:1469 — the sha rides between the literal and
   *  the branch tail); undefined elsewhere. */
  sha?: string;
  forkDefaultBranch: string;
  treePath: string;
  baseBranch: string;
  /** The current page's query, leading `?` stripped ("" when none) —
   *  upstream's `ctx.Req.URL.RawQuery` passthrough. */
  query: string;
}): string {
  const shaPart = options.sha !== undefined ? `/${pathEscapeSegments(options.sha)}` : "";
  const treePart = options.treePath === "" ? "" : `/${pathEscapeSegments(options.treePath)}`;
  let action =
    `${options.forkLink}/${options.editorLiteral}${shaPart}/` +
    `${pathEscapeSegments(options.forkDefaultBranch)}${treePart}` +
    `?from_base_branch=${encodeURIComponent(options.baseBranch)}`;
  if (options.query !== "") action += `&${options.query}`;
  return action;
}

/**
 * The fork's overlay inputs (§3.2): the fork cell's LIVE branches for the
 * commit select (an empty/settling cell falls back to `[defaultBranch]` —
 * the replication creates exactly that branch; module header) over the
 * given pre-built action. `null` never happens today (listRefs' null-safe
 * client answers empty) — the signature stays nullable for the engine's
 * posture symmetry with the family loaders.
 */
export async function loadEditorForkOverlay(
  engine: EngineClient,
  fork: { ownerNamespace: string; slug: string; defaultBranch: string },
  action: string,
): Promise<EditorForkOverlay | null> {
  const fullName = `${fork.ownerNamespace}/${fork.slug}`;
  let branches: string[] = [];
  // The fork cell's live branch universe — resolveHeadBranch's refs/heads/
  // walk (the family derivation; listRefs' raw RefsResult names carry the
  // refs/heads/ prefix).
  const headBranches = resolveHeadBranch(await engine.listRefs(), fork.defaultBranch).branches;
  if (headBranches.length > 0) branches = [...headBranches].sort();
  if (branches.length === 0) branches = [fork.defaultBranch];
  return {
    action,
    branches,
    defaultBranch: fork.defaultBranch,
    fullName,
    forkLink: `/${fullName}`,
  };
}

/** common_top.tmpl's WillSubmitToFork banner (common_top.tmpl:1-7): the
 *  blue message with the fork link inside <b> — the locale's
 *  `fork_edit_description` words around the HTMLFormat link. Rendered as
 *  the form's FIRST child on every editor page when the overlay is set
 *  (all five editor templates include common_top). */
export function EditorForkBanner(props: { overlay: EditorForkOverlay }) {
  return (
    <div class="ui blue message">
      {editorForkLocale.fork_edit_prefix}
      <b>
        <a href={props.overlay.forkLink}>{props.overlay.fullName}</a>
      </b>
      {editorForkLocale.fork_edit_suffix}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The write (ForkToEditPost over the landed fork service)
// ---------------------------------------------------------------------------

/** The parsed `/_fork` POST (the prompt form's field set — the no-JS
 *  reduction's `return_uri` plus nothing else; upstream's form carries no
 *  fields at all). */
export interface EditorForkForm {
  returnUri: string;
}

/** Parse the urlencoded POST (`return_uri`, verbatim — validation happens
 *  at redirect time, editorForkReturnTarget). */
export function parseEditorForkForm(params: URLSearchParams): EditorForkForm {
  return { returnUri: params.get("return_uri") ?? "" };
}

/**
 * The validated reload target (upstream `JSONRedirect("")` → the bundle's
 * `window.location.reload()`): the carried `return_uri` when it is
 * site-relative (`/…`, never `//…` — the protocol-relative guard) AND
 * scoped to THIS repo's prefix (stricter than upstream's
 * IsCurrentGiteaSiteURL — a forged form cannot bounce across repos);
 * otherwise the editor root for the POST's own branch tail (the prompt's
 * action branch — the form always carries return_uri in practice, so this
 * is the hand-crafted-POST arm).
 */
export function editorForkReturnTarget(returnUri: string, repoLink: string, branch: string): string {
  if (returnUri.startsWith("/") && !returnUri.startsWith("//") && returnUri.startsWith(`${repoLink}/`)) {
    return returnUri;
  }
  return `${repoLink}/edit/${pathEscapeSegments(branch)}`;
}

export type EditorForkResult =
  | { outcome: "created" }
  | { outcome: "existing" }
  | { outcome: "invalid"; message: string };

/**
 * `getUniqueRepositoryName` (editor_util.go:114-131) ported EXACTLY,
 * double-increment quirk included: upstream's loop body advances `i` AS
 * WELL AS the loop header, so the tried sequence is `name`, `name-1`,
 * `name-3`, `name-5`, … (the odd postfixes; `name-999` is set but never
 * checked), the first name ABSENT from the owner's repositories wins, and
 * exhaustion returns "" (upstream then fails the create with the empty
 * name). `ownerNamespaceLower` is the doer's namespace (the
 * GetRepositoryByName(ownerID, name) probe over our
 * namespace-scoped-slug lookup).
 */
export async function uniqueEditorForkName(d1: D1Database, ownerNamespaceLower: string, name: string): Promise<string> {
  let candidate = name;
  for (let i = 1; i < 1000; i++) {
    const hit = await drizzle(d1)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, ownerNamespaceLower), eq(repositories.slug, candidate)))
      .get();
    if (hit === undefined) return candidate;
    candidate = `${name}-${i}`;
    i++;
  }
  return "";
}

/**
 * The `/_fork` POST's write (ForkToEditPost, editor_fork.go:20-29, over the
 * LANDED createFork): the doer's fork of THIS source — ForkRepository's arm
 * order preserved (services/repository/fork.go:59-82): the blocked arm, the
 * GetUserFork one-fork-per-owner probe (an existing fork answers
 * `existing` — the reload arm; module header), the unique-name port, then
 * the landed createFork with the queue + registry bindings (the replication
 * hand-off). Upstream copies the description and single-branches the fork
 * at the DEFAULT branch (`SingleBranch: DefaultBranch`); the landed
 * createFork copies the description and pins `default_branch` itself (the
 * same posture — createFork copies the source's default branch). Service
 * name errors surface as `invalid` (the repo-fork page's convention);
 * everything else propagates (the services/engine.ts posture).
 */
export async function createForkToEdit(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
): Promise<EditorForkResult> {
  const source = await findRepositoryById(d1, repo.id);
  if (source === null) return { outcome: "invalid", message: "not found" };

  // ForkRepository's blocked arm (fork.go:64) — a doer blocked by the
  // SOURCE owner cannot fork (the landed createForkFromForm's arm order).
  if (await isUserBlockedBy(d1, { id: viewer.id, isAdmin: viewer.isAdmin }, source.repo.ownerId ?? -1)) {
    return { outcome: "invalid", message: BLOCKED_USER_MESSAGE };
  }

  // GetUserFork (fork.go:75-82): at most one fork per owner — the
  // double-POST race answers the reload, not upstream's ServerError
  // fall-through (module header).
  const existing = await findForkByOwner(d1, source.repo.id, viewer.id);
  if (existing !== null) return { outcome: "existing" };

  const ownerNamespaceLower = viewer.username.toLowerCase();
  const name = await uniqueEditorForkName(d1, ownerNamespaceLower, source.repo.slug);
  if (name === "") return { outcome: "invalid", message: "repository name could not be uniquified" };

  const deps: ForkServiceDeps = {
    queue: env.REPO_TASKS,
    registry: env.REGISTRY.getByName("registry"),
  };
  try {
    await createFork(d1, deps, {
      source,
      targetOwner: { id: viewer.id, usernameLower: ownerNamespaceLower },
      name,
    });
    return { outcome: "created" };
  } catch (error) {
    if (error instanceof RepoNameCollisionError) {
      // The create raced the unique-name probe (upstream ErrRepoAlreadyExist
      // → "new_owner_has_same_repo", fork.go:217-219).
      return { outcome: "invalid", message: "The new owner already has a repository with same name. Please choose another name." };
    }
    if (error instanceof RepoNameInvalidError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
}
