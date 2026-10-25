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
 * targets the tier-1 API raw route (§3.3, open question 3).
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { BranchSelector } from "../components/branch-selector";
import { FileContentView, type MediaKind } from "../components/file-content";
import { RepoFilesTable } from "../components/file-list";
import type { EngineClient } from "../engine";
import { resolveRefSuffix, splitRefSuffix } from "../index";
import type { RefType } from "../index";
import { treeLink } from "../links";
import {
  classifyBlob,
  enrichTreeCommits,
  MAX_DISPLAY_FILE_SIZE,
  mediaKindOf,
  pathEscapeSegments,
  renderRepoMarkdown,
  splitLines,
  type BlobViewVariant,
} from "../page-data";
import { BaseLayout, Icon } from "../shell";
import type { UiContext } from "../ui-context";
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
      markupHtml?: string;
      text?: string;
      mediaKind?: MediaKind;
      latestCommit: CommitJson | null;
    }
  | { notFound: true };

/** The directory whose listing surrounds `path` ("" at root). */
function parentDirOf(path: string): string {
  return path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
}

/** The current-dir sidebar (§2.1: one listTree call, no lazy tree v1).
 *  Exported for the file editor (pages wave 8) — editor/edit.tmpl renders the
 *  same view_file_tree beside its form. */
export function FileTreeSidebar(props: {
  repoLink: string;
  refType: RefType;
  ref: string;
  dirPath: string;
  siblings: readonly TreeEntryJson[];
  activeName: string;
}) {
  return (
    <div class="repo-view-file-tree-container">
      <div class="flex-text-block repo-button-row">
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
  if (variant === "markup") {
    // §3.4: the shared renderer with repo context against the file's directory.
    const raw = new TextDecoder().decode(blob.data);
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
  } else if (variant === "view-raw") {
    mediaKind = mediaKindOf(entry.name) ?? undefined;
  }

  return {
    kind: "blob",
    refs,
    active: { refType, ref },
    treePath,
    siblings: parentTree?.entries ?? [],
    entry,
    variant,
    markupHtml,
    text,
    mediaKind,
    latestCommit: lastCommitLog?.commits[0] ?? null,
  };
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
 */
export function FileViewPage(props: { ctx: UiContext; data: FileViewData; canWrite?: boolean }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("FileViewPage requires ctx.repo");
  if ("notFound" in data) throw new Error("FileViewPage received notFound — render.tsx answers the 404 shell");

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
          />
          <div class="repo-view-content">
            <FileContentView
              repoLink={repoLink}
              treePath={data.treePath}
              ref={ref}
              variant={data.variant}
              markupHtml={data.markupHtml}
              text={data.text}
              mediaKind={data.mediaKind}
              size={data.entry.size ?? null}
              numLines={data.text !== undefined ? splitLines(data.text).length : null}
              isSymlink={data.entry.mode === "120000"}
              latestCommit={data.latestCommit}
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
