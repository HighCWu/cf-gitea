/**
 * The file view page (§2.1 src row, §3.3): the file view doubles as the tree
 * browser — a resolved directory renders the shared `#repo-files-table`
 * (with the parent-link row), a resolved blob renders the §3.3 variants
 * through components/file-content. The URL's ref suffix is REQUIRED and
 * pre-resolved by the router's splitRefSuffix/resolveRefSuffix (§3.3); a
 * path that resolves to neither tree nor blob, and submodules (no content
 * view this slice — the file-list row shape is §4.10), 404-shell.
 *
 * The blob view carries the §2.4.1 enhancement registry: root
 * `data-global-init="initRepoFileView"` + `data-raw-file-link`, and the copy
 * button `data-global-click="onCopyContentButtonClick"` — the raw link
 * targets the upstream WEB raw shape (links.ts rawFileLink; the former
 * tier-1 API `?ref=` divergence is retired). LFS-pointed files flip the
 * same registry to the /media family (view_file.go:210-212's RawFileLink
 * overwrite — components/file-content.tsx composes it off `isLfsFile`).
 *
 * The blob view also carries upstream's LFS badge (file_info.tmpl:14 —
 * `<span class="ui label">LFS</span>` beside the size): the loader runs
 * view_file.go's pointer probe (routers/web/repo/view.go:72-123
 * getFileReader — the first lfs.MetaFileMaxSize bytes text-gated, then
 * lfs.ReadPointerFromBuffer; a VALID pointer flags the file LFS, INCLUDING
 * when the meta row is missing — view.go:104-110 sets lfsMeta on that error
 * path too, so the badge is a parse-only, D1-free property). The SAME
 * parse-only flag drives the raw/media link flip: view_file.go:210-212
 * overwrites RawFileLink with `/media/` + RefTypeNameSubURL + TreePath
 * whenever `fInfo.isLFSFile()` — meta row or not — so a pointer file's
 * Raw button, copy control, and view-raw media sources resolve LFS while
 * a regular file keeps /raw (SingleDownload has no LFS arm at the pin).
 *
 * The blob view's sidebar carries the upstream file-tree toggle PAIR
 * (view_file_tree.tmpl:3-8's hide button inside the container +
 * view_file_tree_toggle_button.tmpl's show button beside it — our port had
 * omitted both): each carries the official bundle's contract verbatim
 * (class `repo-view-file-tree-toggle`, `data-global-click=
 * "onRepoViewFileTreeToggle"`, `data-toggle-action`, the diff locale
 * tooltips — "repo.diff.hide_file_tree"/"show_file_tree") so the bundle's
 * repo-view-file-tree.ts toggles the container client-side and POSTs
 * `{codeViewShowFileTree}` to /user/settings/update_preferences for a
 * signed-in user (the landed KV write, ui/index.ts). The rendered INITIAL
 * state rides the optional `showFileTree` prop (default true —
 * view_home.go:360-371's GetUserSetting default) fed by render.tsx's src
 * case through `loadFileTreeVisibility` — the user_settings_kv READ-BACK
 * of the toggle POST's stored bytes (the follow-up V1 reported; upstream's
 * defaults stand: anonymous and never-toggled users see the tree, a stored
 * "false" hides it — view_home.go:360-371 verbatim). The pair renders only
 * on BLOB views (the only views whose sidebar exists — a toggle with no
 * container would be a dead control), so the read-back runs on blob views
 * only; a tree view costs zero KV reads. The blame (blame.go:65) and edit
 * (editor.go:44) sidebars ride the same upstream switch — their pages'
 * threading is a disclosed follow-up (outside this module's wave
 * ownership); their FileTreeSidebar calls stay at the default-true posture.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";
import { MAX_BLAME_BYTES, MAX_BLAME_LINES } from "@cf-gitea/git-engine";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { userSettingsKv } from "../../db/schema";
import { BranchSelector } from "../components/branch-selector";
import { FileContentView, type MediaKind } from "../components/file-content";
import { RepoFilesTable } from "../components/file-list";
import type { EngineClient } from "../engine";
import { resolveRefSuffix, splitRefSuffix } from "../index";
import type { RefType } from "../index";
import { blameLink, treeLink } from "../links";
import { parsePointer, POINTER_MAX_BYTES, PointerTooLargeError } from "../../services/lfs/pointer";
import {
  classifyBlob,
  enrichTreeCommits,
  isBinaryData,
  MAX_DISPLAY_FILE_SIZE,
  mediaKindOf,
  pathEscapeSegments,
  renderRepoMarkdown,
  splitLines,
  type BlobViewVariant,
} from "../page-data";
import { BaseLayout, Icon } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { resolveHeadBranch, type ResolvedRefs } from "./home";

/** The file/tree view render inputs, loaded by loadFileViewData. */
export type FileViewData =
  | {
      kind: "tree";
      refs: ResolvedRefs;
      active: { refType: RefType; ref: string };
      dirPath: string;
      entries: TreeEntryJson[];
      commits: Map<string, CommitJson | null>;
      latestCommit: CommitJson | null;
    }
  | {
      kind: "blob";
      refs: ResolvedRefs;
      active: { refType: RefType; ref: string };
      treePath: string;
      /** The containing directory's listing — the current-dir sidebar (§2.1). */
      siblings: TreeEntryJson[];
      entry: TreeEntryJson;
      variant: BlobViewVariant;
      /** file_info.tmpl:14's LFS badge gate — the loader's pointer probe
       *  (view.go:72-123 getFileReader's isLFSFile). */
      isLfsFile: boolean;
      markupHtml?: string;
      text?: string;
      mediaKind?: MediaKind;
      /** The census R08 Blame anchor's gate: text-representable AND inside
       *  the engine's blame budget (size ≤ MAX_BLAME_BYTES, lines ≤
       *  MAX_BLAME_LINES — the loader knows both before rendering; false =
       *  no button, never a dead link to a 404 blame). */
      blameable: boolean;
      latestCommit: CommitJson | null;
    }
  | { notFound: true };

/** The directory whose listing surrounds `path` ("" at root). */
function parentDirOf(path: string): string {
  return path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
}

/**
 * view_file.go getFileReader's pointer probe (view.go:72-123): the first
 * lfs.MetaFileMaxSize (= POINTER_MAX_BYTES) bytes of the GIT blob, text-gated
 * (`if !fi.st.IsText() … return` — our landed null-byte sniff is the §4.2
 * port of the same gate), then `lfs.ReadPointerFromBuffer`. A VALID pointer
 * answers true — INCLUDING when the meta row is missing (view.go:104-110
 * sets lfsMeta on that error path, so `isLFSFile()` stays true and the badge
 * shows over pointer content). A MALFORMED pointer (the parser's
 * InvalidPointerError — upstream's `pointer.IsValid() == false`) is a plain
 * file; PointerTooLargeError cannot fire (the probe slices at the cap).
 */
function probeIsLfsFile(blobData: Uint8Array): boolean {
  const probe = blobData.subarray(0, Math.min(blobData.byteLength, POINTER_MAX_BYTES));
  if (probe.byteLength === 0 || isBinaryData(probe)) return false; // the IsText gate
  try {
    return parsePointer(probe, { strict: false }) !== null;
  } catch (error) {
    if (error instanceof PointerTooLargeError) throw error; // unreachable — the probe slices
    return false; // InvalidPointerError — upstream's invalid-pointer arm
  }
}

/** The current-dir sidebar (§2.1: one listTree call, no lazy tree v1).
 *  Exported for the file editor (pages wave 8) — editor/edit.tmpl renders the
 *  same view_file_tree beside its form. The button row leads with upstream's
 *  hide-toggle (view_file_tree.tmpl:3-8 — the class/data contract verbatim:
 *  the bundle's onRepoViewFileTreeToggle flips the container client-side and
 *  POSTs the preference for a signed-in user; see the module header). The
 *  container's `tw-hidden` rides the `showFileTree` prop (view_file_tree.tmpl:1
 *  — `{{if not .UserSettingCodeViewShowFileTree}}tw-hidden{{end}}`; default
 *  true, so the blame/editor consumers that have not threaded the read-back
 *  yet keep today's exact bytes). */
export function FileTreeSidebar(props: {
  repoLink: string;
  refType: RefType;
  ref: string;
  dirPath: string;
  siblings: readonly TreeEntryJson[];
  activeName: string;
  showFileTree?: boolean;
}) {
  return (
    <div class={`repo-view-file-tree-container${props.showFileTree === false ? " tw-hidden" : ""}`}>
      <div class="flex-text-block repo-button-row">
        <button
          type="button"
          class="repo-view-file-tree-toggle ui button"
          data-global-click="onRepoViewFileTreeToggle"
          data-toggle-action="hide"
          data-tooltip-content="Hide file tree"
        >
          <Icon name="octicon-sidebar-expand" />
        </button>
        <b>Files</b>
      </div>
      <div id="view-file-tree">
        <ul class="repo-view-file-tree">
          {props.siblings.map((entry) => {
            const name = props.dirPath === "" ? entry.name : `${props.dirPath}/${entry.name}`;
            const href = treeLink(props.repoLink, props.refType, props.ref, name);
            const isActive = entry.name === props.activeName;
            return (
              <li>
                <a class={isActive ? "active" : undefined} href={href}>
                  {entry.name}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** The `repo / dir / file` breadcrumb of the src views (view_content.tmpl's
 *  `.breadcrumb`): the repo name links to the ref root, every segment to its
 *  cumulative path, the last one active (plain text). */
function TreeBreadcrumb(props: {
  repoSlug: string;
  repoLink: string;
  refType: RefType;
  ref: string;
  treePath: string;
}) {
  const segments = props.treePath === "" ? [] : props.treePath.split("/");
  const last = segments.length - 1;
  return (
    <span class="breadcrumb">
      <a class="section" href={treeLink(props.repoLink, props.refType, props.ref)} title={props.repoSlug}>
        {props.repoSlug}
      </a>
      {segments.map((segment, i) => {
        const prefix = segments.slice(0, i + 1).join("/");
        return (
          <>
            <span class="breadcrumb-divider">/</span>
            {i === last ? (
              <span class="active section" title={segment}>
                {segment}
              </span>
            ) : (
              <span class="section">
                <a href={treeLink(props.repoLink, props.refType, props.ref, prefix)} title={segment}>
                  {segment}
                </a>
              </span>
            )}
          </>
        );
      })}
    </span>
  );
}

/** Load the file/tree view data. Every miss (non-exact or unresolvable ref
 *  suffix, path that is neither tree nor blob, submodule file views) →
 *  notFound → 404 shell. The ref suffix is REQUIRED (§3.3). */
export async function loadFileViewData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  origin: string,
  refSuffix: string,
): Promise<FileViewData> {
  const split = splitRefSuffix(refSuffix);
  if (split === null) return { notFound: true }; // no (or non-exact) prefix (§3.3)
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true };
  const resolved = resolveRefSuffix(split.refType, split.rest, {
    branches: refs.branches,
    tags: refs.tags,
    defaultBranch: repo.defaultBranch,
  });
  if (resolved === null) return { notFound: true }; // unresolvable ref (§3.3)
  const { refType, ref, treePath } = resolved;

  const parentDir = parentDirOf(treePath);
  const baseName = treePath === "" ? "" : (treePath.split("/").pop() ?? "");
  const parentTree = await engine.listTree(ref, parentDir);
  const entry =
    treePath === "" ? null : (parentTree?.entries.find((e) => e.name === baseName) ?? null);
  if (treePath !== "" && entry === null) return { notFound: true }; // missing path (§4.5)

  // ---- directory (the tree browser) ----
  if (treePath === "" || entry?.type === "tree") {
    const dirPath = treePath;
    const tree = treePath === "" ? parentTree : await engine.listTree(ref, dirPath);
    if (tree === null) return { notFound: true };
    const commits = await enrichTreeCommits(
      engine,
      ref,
      tree.entries,
      (e) => (dirPath === "" ? e.name : `${dirPath}/${e.name}`),
    );
    // The box: the directory's own last commit (root = the ref tip, §3.3).
    const dirLog = dirPath === "" ? null : await engine.listLog(ref, { path: dirPath, ofs: 0, n: 1 });
    const latestCommit = dirLog?.commits[0] ?? (dirPath === "" ? await engine.readCommit(ref) : null);
    return {
      kind: "tree",
      refs,
      active: { refType, ref },
      dirPath,
      entries: tree.entries,
      commits,
      latestCommit,
    };
  }

  // ---- blob ----
  if (entry === null || entry.type !== "blob") return { notFound: true }; // submodule (§4.10)

  // §4.3: the tree entry's size decides BEFORE readBlob — too-large blobs are
  // never pulled into the DO→Worker hop.
  if ((entry.size ?? 0) > MAX_DISPLAY_FILE_SIZE) {
    const tooLargeLog = await engine.listLog(ref, { path: treePath, ofs: 0, n: 1 });
    return {
      kind: "blob",
      refs,
      active: { refType, ref },
      treePath,
      siblings: parentTree?.entries ?? [],
      entry,
      variant: "too-large",
      // A pointer blob is ≤ lfs.MetaFileMaxSize bytes — never over the 8 MiB
      // display cap, so the too-large arm cannot be an LFS file (and §4.3
      // forbids the readBlob the probe would need anyway).
      isLfsFile: false,
      // over the display cap ⇒ necessarily over the engine's 1 MiB blame cap
      blameable: false,
      latestCommit: tooLargeLog?.commits[0] ?? null,
    };
  }

  const [blob, lastCommitLog] = await Promise.all([
    engine.readBlob(ref, treePath),
    engine.listLog(ref, { path: treePath, ofs: 0, n: 1 }),
  ]);
  if (blob === null) return { notFound: true };

  let variant: BlobViewVariant = classifyBlob(entry, blob.data);
  let markupHtml: string | undefined;
  let text: string | undefined;
  let mediaKind: MediaKind | undefined;
  // The census R08 Blame anchor's gate, computed where the decoded text is
  // already in hand: text-representable variants only, inside the engine's
  // tip-size and line-count budgets (MAX_BLAME_BYTES / MAX_BLAME_LINES —
  // the engine 404s the rest; the dead-link rule forbids the button there).
  let blameLines: number | undefined;
  if (variant === "markup") {
    // §3.4: the shared renderer with repo context against the file's directory.
    const raw = new TextDecoder().decode(blob.data);
    blameLines = splitLines(raw).length;
    const html = renderRepoMarkdown({
      text: raw,
      name: entry.name,
      repo,
      refType,
      ref,
      origin,
    });
    if (html !== "") {
      markupHtml = html;
    } else {
      // Pipeline failure → plain-text fallback (§3.4 posture).
      variant = "plain-text";
      text = raw;
    }
  } else if (variant === "code-view" || variant === "plain-text") {
    text = new TextDecoder().decode(blob.data);
    blameLines = splitLines(text).length;
  } else if (variant === "view-raw") {
    mediaKind = mediaKindOf(entry.name) ?? undefined;
  }
  const blameable =
    (variant === "markup" || variant === "plain-text" || variant === "code-view" || variant === "empty") &&
    (entry.size ?? 0) <= MAX_BLAME_BYTES &&
    (blameLines === undefined || blameLines <= MAX_BLAME_LINES);

  return {
    kind: "blob",
    refs,
    active: { refType, ref },
    treePath,
    siblings: parentTree?.entries ?? [],
    entry,
    variant,
    isLfsFile: probeIsLfsFile(blob.data),
    markupHtml,
    text,
    mediaKind,
    blameable,
    latestCommit: lastCommitLog?.commits[0] ?? null,
  };
}

/** The generic user-settings KV key upstream names
 *  SettingsKeyCodeViewShowFileTree (models/user/setting_options.go:19) — the
 *  same string ui/index.ts's update_preferences POST writes. Declared here
 *  (not imported) because ui/index.ts is the router module this file must
 *  not reach into; the two spellings cite each other. */
const SETTINGS_KEY_CODE_VIEW_SHOW_FILE_TREE = "code_view.show_file_tree";

/**
 * view_home.go:360-371 `prepareHomeTreeSideBarSwitch`'s read-back over the
 * user_settings_kv store the toggle POST writes (ui/index.ts's
 * userSettingsUpdatePreferences): the blob sidebar's INITIAL visibility.
 * Upstream verbatim: anonymous — `showFileTree := true` with NO store read
 * (the template-data arm for `ctx.Doer == nil`); a signed-in user —
 * GetUserSetting(key, "true")'s default, so an absent row (never toggled)
 * keeps the tree SHOWN, and the stored bytes decide otherwise (`"true"`
 * shows; anything else hides — strconv.ParseBool's error arm lands false,
 * and our writer stores only FormatBool's exact bytes). Tree views consume
 * nothing (no sidebar) — render.tsx calls this on blob views only.
 */
export async function loadFileTreeVisibility(d1: D1Database, viewer: Viewer): Promise<boolean> {
  if (viewer.kind !== "user") return true;
  const row = await drizzle(d1)
    .select({ settingValue: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(
      and(eq(userSettingsKv.userId, viewer.id), eq(userSettingsKv.settingKey, SETTINGS_KEY_CODE_VIEW_SHOW_FILE_TREE)),
    )
    .get();
  return row === undefined || row.settingValue === "true";
}

/**
 * The file/tree view page. §2.4.1 discriminators: the upstream view.tmpl
 * base `repository file list`, extended with `view file` on blob views
 * (§2.4.1's "repository view file-style" note; directory views keep the
 * plain list discriminator).
 *
 * Wave 8 (the web file editor): `canWrite` — computed by the route handler
 * (pages/file-editor.tsx's `canWriteRepo`, the session-viewer port of the
 * landed canWriteRepository) — adds the write chrome: the New File link in
 * the button row (branch views only) and the Edit/Delete actions on blob
 * views (view_file.tmpl:72-84's CanContentChange block, at the editor's
 * literal route names). The golden renders are anonymous → canWrite false →
 * byte-identical to the pre-wave DOM.
 *
 * The toggle-pair's show button (view_file_tree_toggle_button.tmpl — the
 * `repo-view-file-tree-toggle` emitter beside the container, blob views
 * only) renders with the `tw-hidden` state the `showFileTree` prop carries
 * (default true — the GetUserSetting default, view_home.go:363-370;
 * render.tsx's src case feeds the user_settings_kv read-back through
 * loadFileTreeVisibility, module header).
 */
export function FileViewPage(props: { ctx: UiContext; data: FileViewData; canWrite?: boolean; showFileTree?: boolean }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("FileViewPage requires ctx.repo");
  if ("notFound" in data) throw new Error("FileViewPage received notFound — render.tsx answers the 404 shell");
  const showFileTree = props.showFileTree ?? true;

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const { refType, ref } = data.active;
  const treePath = data.kind === "tree" ? data.dirPath : data.treePath;
  // The write chrome shows on branch views of unarchived repos only (the
  // editor routes resolve branches; tags/commits have no editor target).
  const canEdit = props.canWrite === true && refType === "branch" && !repo.isArchived;
  const newFileHref =
    canEdit && data.kind === "tree"
      ? `${repoLink}/new/${pathEscapeSegments(ref)}${data.dirPath === "" ? "" : `/${pathEscapeSegments(data.dirPath)}`}`
      : undefined;

  const chrome = (
    <div class="repo-button-row">
      <div class="repo-button-row-left">
        {data.kind === "blob" ? (
          // view_content.tmpl:6-11's show-toggle (rendered only off the tree
          // root upstream; here blob views only — the views whose sidebar
          // exists). Hidden when the tree shows (the default-true posture).
          <button
            type="button"
            class={`repo-view-file-tree-toggle ui button not-mobile${showFileTree ? " tw-hidden" : ""}`}
            data-global-click="onRepoViewFileTreeToggle"
            data-toggle-action="show"
            data-tooltip-content="Show file tree"
          >
            <Icon name="octicon-sidebar-collapse" />
          </button>
        ) : null}
        <BranchSelector
          repoLink={repoLink}
          family="src"
          refs={data.refs}
          active={data.active}
          treePath={treePath}
        />
        <TreeBreadcrumb repoSlug={repo.slug} repoLink={repoLink} refType={refType} ref={ref} treePath={treePath} />
      </div>
      {newFileHref !== undefined ? (
        <div class="repo-button-row-right">
          <a class="ui mini primary button" href={newFileHref}>
            <Icon name="octicon-plus" size={14} /> New File
          </a>
        </div>
      ) : null}
    </div>
  );

  if (data.kind === "tree") {
    return (
      <BaseLayout ctx={ctx} title={treePath === "" ? undefined : treePath} pageClass="repository file list" activeTab="code">
        <div class="ui container fluid padded">
          {chrome}
          <RepoFilesTable
            repoLink={repoLink}
            refType={refType}
            ref={ref}
            dirPath={data.dirPath}
            entries={data.entries}
            commits={data.commits}
            latestCommit={data.latestCommit}
          />
        </div>
      </BaseLayout>
    );
  }

  return (
    <BaseLayout ctx={ctx} title={treePath} pageClass="repository file list view file" activeTab="code">
      <div class="ui container fluid padded">
        {chrome}
        <div class="repo-view-container">
          <FileTreeSidebar
            repoLink={repoLink}
            refType={refType}
            ref={ref}
            dirPath={parentDirOf(data.treePath)}
            siblings={data.siblings}
            activeName={data.treePath.split("/").pop() ?? ""}
            showFileTree={showFileTree}
          />
          <div class="repo-view-content">
            <FileContentView
              repoLink={repoLink}
              treePath={data.treePath}
              ref={ref}
              refType={refType}
              variant={data.variant}
              markupHtml={data.markupHtml}
              text={data.text}
              mediaKind={data.mediaKind}
              size={data.entry.size ?? null}
              isLfsFile={data.isLfsFile}
              numLines={data.text !== undefined ? splitLines(data.text).length : null}
              isSymlink={data.entry.mode === "120000"}
              latestCommit={data.latestCommit}
              blameHref={data.blameable ? blameLink(repoLink, refType, ref, data.treePath) : undefined}
              editHref={
                canEdit ? `${repoLink}/edit/${pathEscapeSegments(ref)}/${pathEscapeSegments(data.treePath)}` : undefined
              }
              deleteHref={
                canEdit ? `${repoLink}/delete/${pathEscapeSegments(ref)}/${pathEscapeSegments(data.treePath)}` : undefined
              }
            />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
