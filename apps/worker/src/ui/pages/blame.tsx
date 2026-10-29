/**
 * The blame page, `/{owner}/{repo}/blame/{branch|tag|commit}/{ref}/{path}` —
 * the census R08 UI half (docs/compat/ui-gap-census-2026-10-29.md) over the
 * engine's `blame()` read RPC (the same machinery the DO's own cgit blame
 * page runs, now surfaced at the boundary).
 *
 * ## DOM contract (templates/repo/blame.tmpl + view.tmpl at the pin; upstream
 *  repo.RefBlame, routers/web/repo/blame.go, web.go:1729-1733)
 *
 * view.tmpl's `repository file list` discriminator gains `blame` when
 * IsBlame (view.tmpl:2) — the page mirrors the file view's layout (the
 * branch chrome + breadcrumb, the repo-view-container with the current-dir
 * sidebar, then the content column) with blame.tmpl's body: the
 * `non-diff-file-content` root, the file-header (file-info left; Raw /
 * Permalink / Normal View / History actions right — blame.tmpl:19-27), and
 * the `.file-view.code-view` table. One `<tr>` per line (renderBlame's rows):
 * `top-line-blame` on each part's FIRST line only; every row carries the
 * `lines-commit` sidebar cell (blame-info: avatar/message/time — the
 * message links the commit, upstream RenderCommitMessageLinkSubject's
 * shape), the `lines-blame-btn` cell (the `previousOid` "view blame prior"
 * link — blame.tmpl:57-63, PreviousShaURL's /blame/commit/{sha}/{path}
 * shape), the `lines-num` cell (L{n} span, data-line-number) and the
 * `lines-code` cell (code-inner).
 *
 * ## Data (§3.2 — the landed engine reads, never a self-fetch)
 *
 * `engine.blame(ref, treePath)` (ui/engine.ts) for the runs + commit
 * metadata; `listTree(parentDir)` for the sidebar + the entry existence
 * gate (the file-view blob arm's shape); `readCommit(ref)` for the
 * Permalink target (upstream ctx.Repo.CommitID). Unresolvable ref, missing
 * path, and every blame-unavailable posture (binary, over-size, over
 * MAX_BLAME_LINES) → the engine's null → the 404 shell (upstream
 * blame.go's NotFound arms).
 *
 * ## Documented v1 divergences/degradations (§6 method)
 *
 * - **First-parent attribution.** The engine blames the first-parent chain
 *   (the DO's blamePage semantic); a file introduced by a merge attributes
 *   to the merge commit where git blame would name the side-branch commit —
 *   pinned by packages/git-engine/e2e/check-blame.mjs check 4.
 * - The truncated-walk info message (result.truncated) has no upstream
 *   analog (upstream always walks to the root); it renders in the
 *   ignore-revs info-message slot's shape.
 * - Avatar stacks (blame.tmpl's blame-avatar / AvatarStackData) have no
 *   avatar infrastructure this slice — the author NAME renders plain in
 *   that slot (the commit-list precedent).
 * - .git-blame-ignore-revs is not read (UsesIgnoreRevs/FaultyIgnoreRevsFile
 *   always false — the banner never renders); the unicode-escape toggle
 *   buttons and the code-line-menu island (copy-line-permalink tippy) are
 *   JS surfaces the no-JS reduction omits (the file-view precedent).
 * - Syntax highlighting is client-side by Gitea's own bundles (no server
 *   lexer) — line text renders plain (the file-view code-view precedent).
 * - The previous-sha button's octicon-versions glyph is outside the
 *   generated icon allowlist — the accessible text stands in (the Copy
 *   button's precedent).
 */

import type { BlameResult, TreeEntryJson } from "@cf-gitea/git-engine";

import { BranchSelector } from "../components/branch-selector";
import { TimeSince } from "../components/file-list";
import type { EngineClient } from "../engine";
import { FileTreeSidebar } from "./file-view";
import { blameLink, commitLink, commitsHistoryLink, rawFileLink, treeLink } from "../links";
import { formatByteSize, pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { resolveRefSuffix, splitRefSuffix, type RefType } from "../index";
import { resolveHeadBranch, type ResolvedRefs } from "./home";

/** Page chrome text (upstream locale keys, locale_en-US.json at the pin). */
export const blameViewLocale = {
  /** "repo.blame" */
  blame: "Blame",
  /** "repo.file_permalink" */
  permalink: "Permalink",
  /** "repo.normal_view" */
  normal_view: "Normal View",
  /** "repo.file_history" */
  history: "History",
  /** "repo.blame_prior" — the previous-sha link's tooltip */
  blame_prior: "View blame prior to this change",
  /** "repo.blame_prior" reduced to link text (no octicon-versions glyph) */
  prior: "prior",
  /** the truncated-walk notice (no upstream analog — see the header) */
  truncated_notice:
    "Line attribution covers the newest commits only — the history walk stopped at its budget before reaching this file's creation commit.",
} as const;

/** The blame page render inputs, loaded by loadBlameData. */
export type BlamePageData =
  | {
      refs: ResolvedRefs;
      active: { refType: RefType; ref: string };
      treePath: string;
      /** The containing directory's listing — the current-dir sidebar (§2.1). */
      siblings: TreeEntryJson[];
      entry: TreeEntryJson;
      /** The resolved tip commit oid — the Permalink target (upstream
       *  ctx.Repo.CommitID); falls back to the request ref on a transport
       *  miss (the blame answer already proves the ref resolves). */
      commitId: string;
      result: BlameResult;
    }
  | { notFound: true };

/**
 * Load the blame view. `notFound` covers blame.go's NotFound arms: the
 * missing/non-exact ref suffix, an unresolvable ref, an empty tree path
 * (blame.go:48-51), a path that is not a blob, and every blame-unavailable
 * posture the engine answers null for (binary, over-size, over-lines).
 */
export async function loadBlameData(
  engine: EngineClient,
  repo: { ownerNamespace: string; slug: string; defaultBranch: string },
  refSuffix: string,
): Promise<BlamePageData> {
  const split = splitRefSuffix(refSuffix);
  if (split === null) return { notFound: true };
  const refs = resolveHeadBranch(await engine.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true };
  const resolved = resolveRefSuffix(split.refType, split.rest, {
    branches: refs.branches,
    tags: refs.tags,
    defaultBranch: repo.defaultBranch,
  });
  if (resolved === null || resolved.treePath === "") return { notFound: true }; // incl. blame.go's empty-TreePath arm
  const { refType, ref, treePath } = resolved;

  const parentDir = treePath.includes("/") ? treePath.split("/").slice(0, -1).join("/") : "";
  const baseName = treePath.split("/").pop() ?? "";
  const parentTree = await engine.listTree(ref, parentDir);
  const entry = parentTree?.entries.find((e) => e.name === baseName) ?? null;
  if (entry === null || entry.type !== "blob") return { notFound: true };

  const result = await engine.blame(ref, treePath);
  if (result === null) return { notFound: true };
  const commit = await engine.readCommit(ref);
  return {
    refs,
    active: { refType, ref },
    treePath,
    siblings: parentTree?.entries ?? [],
    entry,
    commitId: commit?.oid ?? ref,
    result,
  };
}

/** One blame row (renderBlame's blameRow): the sidebar cells render on EVERY
 *  row (blame.tmpl:42-56 — empty for continuation rows), the commit content
 *  only on the part's first line. */
function BlameRow(props: {
  repoLink: string;
  treePath: string;
  lineNumber: number;
  line: string;
  part: { oid: string; previousOid?: string; subject?: string; message?: string; authorName?: string; authorTime?: number; authorTz?: string };
  isFirstOfPart: boolean;
}) {
  const { part } = props;
  return (
    <tr class={props.isFirstOfPart ? "top-line-blame" : undefined}>
      <td class="lines-commit">
        {props.isFirstOfPart ? (
          <div class="blame-info">
            <div class="blame-data">
              <div class="blame-avatar">{part.authorName}</div>
              <div class="blame-message muted-links" title={part.message}>
                <a href={commitLink(props.repoLink, part.oid)}>{part.subject}</a>
              </div>
              {part.authorTime !== undefined ? (
                <div class="blame-time not-mobile">
                  <TimeSince unixSeconds={part.authorTime} tz={part.authorTz ?? "UTC"} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </td>
      <td class="lines-blame-btn">
        {props.isFirstOfPart && part.previousOid !== undefined ? (
          <a
            class="muted"
            href={blameLink(props.repoLink, "commit", part.previousOid, props.treePath)}
            data-tooltip-content={blameViewLocale.blame_prior}
          >
            {blameViewLocale.prior}
          </a>
        ) : null}
      </td>
      <td class="lines-num">
        <span id={`L${props.lineNumber}`} data-line-number={props.lineNumber}></span>
      </td>
      <td rel={`L${props.lineNumber}`} class="lines-code blame-code chroma">
        <code class="code-inner tw-pl-2">{props.line}</code>
      </td>
    </tr>
  );
}

/** The blame body (blame.tmpl's non-diff-file-content over the RPC). */
export function BlameFileView(props: { repoLink: string; data: Extract<BlamePageData, { result: BlameResult }> }) {
  const { data } = props;
  const numLines = data.result.totalLines;
  return (
    <div class="non-diff-file-content">
      {data.result.truncated ? <div class="ui info message">{blameViewLocale.truncated_notice}</div> : null}
      <h4 class="file-header ui top attached header flex-left-right">
        <div class="file-header-left tw-flex tw-items-center tw-py-2 tw-pr-4">
          <Icon name="octicon-file" size={16} class="tw-mr-2" />
          <strong>{data.treePath.split("/").pop()}</strong>
          <div class="file-info tw-font-mono">
            {numLines !== 0 ? (
              <div class="file-info-entry">
                {numLines} {numLines === 1 ? "line" : "lines"}
              </div>
            ) : null}
            <div class="file-info-entry">
              <span class="file-info-size">{formatByteSize(data.entry.size ?? 0)}</span>
            </div>
          </div>
        </div>
        <div class="file-header-right file-actions flex-text-block tw-flex-wrap">
          <div class="ui buttons tw-mr-1">
            <a
              class="ui mini basic button"
              href={rawFileLink(props.repoLink, data.treePath, data.active.ref, data.active.refType)}
              rel="nofollow"
            >
              Raw
            </a>
            {data.active.refType !== "commit" ? (
            <a
              class="ui mini basic button"
              href={`${props.repoLink}/src/commit/${encodeURIComponent(data.commitId)}/${pathEscapeSegments(data.treePath)}`}
            >
              {blameViewLocale.permalink}
            </a>
            ) : null}
            <a class="ui mini basic button" href={treeLink(props.repoLink, data.active.refType, data.active.ref, data.treePath)}>
              {blameViewLocale.normal_view}
            </a>
            <a class="ui mini basic button" href={commitsHistoryLink(props.repoLink, data.treePath)}>
              {blameViewLocale.history}
            </a>
          </div>
        </div>
      </h4>
      <div class="ui bottom attached segment file-view-container">
        {data.result.totalLines === 0 ? (
          <div class="file-view">
            <div class="file-not-rendered-prompt">The file is empty.</div>
          </div>
        ) : (
          <div class="file-view code-view unicode-escaped">
            <table>
              <tbody>
                {data.result.parts.map((part, partIdx) => {
                  const meta = data.result.commits[part.oid];
                  const enriched = {
                    oid: part.oid,
                    previousOid: part.previousOid,
                    subject: meta?.subject,
                    message: meta?.message,
                    authorName: meta?.author.name,
                    authorTime: meta?.author.time,
                    authorTz: meta?.author.tz,
                  };
                  return part.lines.map((line, lineIdx) => (
                    <BlameRow
                      key={`${partIdx}-${lineIdx}`}
                      repoLink={props.repoLink}
                      treePath={data.treePath}
                      lineNumber={absoluteLineNumber(data.result, partIdx, lineIdx)}
                      line={line}
                      part={enriched}
                      isFirstOfPart={lineIdx === 0}
                    />
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** 1-based absolute number of `lineIdx` within `partIdx` (the window's
 *  numbering stays file-absolute via firstLine: upstream rows count through
 *  every part). */
function absoluteLineNumber(result: BlameResult, partIdx: number, lineIdx: number): number {
  let n = lineIdx;
  for (const earlier of result.parts.slice(0, partIdx)) n += earlier.lines.length;
  return result.firstLine + n;
}

/** The full-document render (the render.tsx pattern). */
export function renderBlamePage(options: { ctx: UiContext; data: BlamePageData }): string {
  return renderPage(<BlamePage ctx={options.ctx} data={options.data} />);
}

/** The blame page (§2.4.1 discriminator: view.tmpl:2's `repository file list
 *  blame`). */
export function BlamePage(props: { ctx: UiContext; data: BlamePageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("BlamePage requires ctx.repo");
  if ("notFound" in data) throw new Error("BlamePage received notFound — the route answers the 404 shell");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={data.treePath} pageClass="repository file list blame" activeTab="code">
      <div class="ui container fluid padded">
        <div class="repo-button-row">
          <div class="repo-button-row-left">
            <BranchSelector
              repoLink={repoLink}
              family="src"
              refs={data.refs}
              active={data.active}
              treePath={data.treePath}
            />
          </div>
        </div>
        <div class="repo-view-container">
          <FileTreeSidebar
            repoLink={repoLink}
            refType={data.active.refType}
            ref={data.active.ref}
            dirPath={data.treePath.includes("/") ? data.treePath.split("/").slice(0, -1).join("/") : ""}
            siblings={data.siblings}
            activeName={data.treePath.split("/").pop() ?? ""}
          />
          <div class="repo-view-content">
            <BlameFileView repoLink={repoLink} data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
