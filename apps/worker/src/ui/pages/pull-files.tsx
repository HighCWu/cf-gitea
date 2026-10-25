/**
 * The PR files page, `/{owner}/{repo}/pulls/{index}/files` — pages wave 5
 * (SPEC-0008 U3 extension, the first ENGINE-reading page beyond the slice-1
 * code views).
 *
 * ## DOM contract (templates/repo/pulls/files.tmpl + repo/diff/{box,stats,
 *  section_unified,section_code}.tmpl + repo/pulls/tab_menu.tmpl + repo/issue/
 *  view_title.tmpl at the pin fc4936884584)
 *
 * `.page-content.repository.view.issue.pull.files.diff`, then one
 * `.ui.container.fluid.padded` holding the upstream page order: the
 * `view_title` bar (issue-detail.tsx's IssueTitleBar over the same row —
 * files.tmpl:6), the PR tab menu with the Files tab active (files.tmpl:7;
 * issue-detail.tsx's PullTabs), and `repo/diff/box`: the
 * `.diff-detail-box` toolbar (the summary line only — the file-tree toggle,
 * whitespace/commit dropdowns and review composer are JS islands/write
 * actions), then `#diff-container > #diff-file-boxes` with one
 * `.diff-file-box.file-content` per file: `.diff-file-header.sticky-2nd-row
 * .ui.top.attached.header` (name anchor + entry-mode label + per-file +A/-D
 * stats or the BIN mark) and `.diff-file-body.ui.attached.unstackable
 * .table.segment` — the unified `<table class="chroma">` of
 * section_unified.tmpl (colgroup 50/50/10/10/auto; `tr.{add,del,same,tag}-
 * code` rows with `lines-num-old/new` + `rel="diff-{hash}L{n}"` spans,
 * `lines-escape`, `lines-type-marker` and `chroma lines-code` cells; hunk
 * headers as `tag-code` rows with the `blob-hunk` cell), or the honest
 * degraded body (binary / too large / mode change / whitespace-only).
 *
 * ## Data (§3.2 — the landed diff service, never a self-fetch)
 *
 * `pullRequestDiff` (src/api/services/pull-engine.ts:116-138) — the SAME
 * composition the API `.diff`/`.patch` routes render
 * (api/routes/pulls.ts:513): three-dot range `merge_base...refs/pull/N/head`
 * through the engine's readDiff, `DiffFileJson[]` with line-level hunks
 * (aStart/aLen/bStart/bLen + `{tag: eq|del|add, line}` ops). The row lookup
 * reuses the detail page's loaders (findIssueByRepoAndIndex +
 * findPullRequestByIndex); the `RepositoryWithOwner` pair the service takes
 * comes from `findRepositoryById` (the owner join — the shape
 * requireVisibleRepo returns); a missing owner row 404-shells (the pair
 * cannot compose).
 *
 * ## Auth + posture
 *
 * Public anonymous GET like every read page (the router resolved the repo
 * first, §2.5). A non-pull row 404-shells — the upstream route hangs off the
 * `/{type:pulls}/{index}` group only (web.go:1657-1680) and never
 * redirect-issue-views (that is ViewIssue's behavior, our detail route).
 * An engine-side range failure (base branch or PR head unresolvable — the
 * service's ApiError 404) degrades to upstream's DiffNotAvailable render:
 * `<h4>Diff Content Not Available</h4>` (box.tmpl:79-80), not a 500.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - Rename/mode-change metadata: the engine's DiffFileJson carries ONE path
 *   plus old/new blob oids+modes — no rename detection (git without -M),
 *   so a renamed file renders as its underlying content delta under the new
 *   path; `data-old-filename` equals the new path (upstream's
 *   "old → new" header text, box.tmpl:107-109, needs data this service does
 *   not model). Mode changes ARE derivable (old.mode !== new.mode) and
 *   render the box.tmpl:203-204 body + the translated entry-mode label.
 * - `DiffResult.truncated` is dropped by pullRequestDiff's return shape, so
 *   the `#diff-incomplete` "too many files" segment (box.tmpl:225-235)
 *   cannot render — a truncated diff just shows its first files.
 * - Chroma syntax highlighting and the inline word-diff
 *   (GetComputedInlineDiffFor) are client/chroma features — line bodies
 *   render as plain `<code class="code-inner">` text (section_code.tmpl's
 *   shape, no highlighting spans).
 * - The fold-file/clipboard/kebab buttons, the file-view toggle (image/CSV),
 *   the viewed-files checkbox and the diff-file-tree are JS islands — the
 *   no-JS reduction omits them; the +A/-D stats bar and the BIN mark
 *   (stats.tmpl, box.tmpl:126-130) render server-side.
 * - The tab/toolbar octicons (octicon-comment-discussion/git-commit/diff)
 *   are outside the generated icon allowlist (scripts/gen-ui-icons.mjs is
 *   not a ui/ file) — the tabs and the summary line render text only.
 * - `?style=split` and the whitespace query family are not honored (the
 *   upstream dropdowns are JS; the unified view is the only shape).
 */

import { Context, type Context as ContextType } from "hono";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DiffFileJson } from "@cf-gitea/git-engine";

import { ApiError } from "../../api/errors";
import type { ApiEnv } from "../../api/env";
import { findIssueByRepoAndIndex } from "../../api/services/issues";
import { pullRequestDiff } from "../../api/services/pull-engine";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { findRepositoryById } from "../../api/services/repository";
import { users } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { IssueTitleBar, PullTabs, type IssueTitleData } from "./issue-detail";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the issueDetailLocale pattern — the
 *  strings cite upstream's own locale keys). */
export const pullFilesLocale = {
  changed_files: "changed files", // "repo.diff.stats_desc" fragment
  with: "with", // fragment
  and: "and", // fragment
  additions: "additions", // fragment
  deletions: "deletions", // fragment
  bin: "BIN", // "repo.diff.bin"
  bin_not_shown: "Binary file not shown.", // "repo.diff.bin_not_shown"
  file_suppressed: "File diff suppressed because it is too large.", // "repo.diff.file_suppressed"
  data_not_available: "Diff Content Not Available", // "repo.diff.data_not_available"
  file_mode_changed: "File mode changed.", // "repo.diff.file_mode_changed"
  whitespace_only: "Whitespace-only changes.", // "repo.diff.file_whitespace_only_changes"
  // git.filemode.* — TranslateDiffEntryMode's names (gitdiff.go:601-618).
  filemode_regular: "Regular",
  filemode_executable: "Executable",
  filemode_symlink: "Symlink",
  filemode_submodule: "Submodule",
} as const;

// ---------------------------------------------------------------------------
// Render model — the loader computes everything (hashes, numbering, body
// branch), the components render synchronously (the established pattern).
// ---------------------------------------------------------------------------

/** One unified line row (section_unified.tmpl:12-43 reduced). Left indices
 *  count eq+del lines, right indices eq+add lines — the unified numbering;
 *  `null` = the blank half of the pair (data-line-num="" / rel="" like the
 *  template's falsy branches). */
export interface DiffLineRow {
  type: "add" | "del" | "same";
  left: number | null;
  right: number | null;
  content: string;
}

/** One hunk: the @@ header text + its line rows. */
export interface DiffHunkView {
  header: string;
  rows: DiffLineRow[];
}

/** Which body branch a file renders (DiffFileBox's four degraded variants
 *  or the unified table). */
export type DiffFileBody = "binary" | "toolarge" | "mode" | "whitespace" | "table";

/** One file box's render model. */
export interface DiffFileView {
  file: DiffFileJson;
  /** `HashFilePathForWebUI` (modules/git/utils.go:42-46) — sha1 hex of the
   *  path; the `diff-{hash}` box id and the `diff-{hash}L/R{n}` anchors. */
  nameHash: string;
  /** TranslateDiffEntryMode reduced (gitdiff.go:601-626): created/deleted
   *  entry mode, or the "{old} → {new}" changed-mode pair; `null` = none. */
  modeLabel: string | null;
  body: DiffFileBody;
  hunks: DiffHunkView[];
}

/** The files page render inputs, loaded by loadPullFilesData. */
export interface PullFilesData {
  issue: IssueRow;
  pr: PullRequestRow;
  /** Display-cased names for the title bar (null = no user row). */
  posterName: string | null;
  mergerName: string | null;
  files: DiffFileView[];
  /** Total additions/deletions across the files (the toolbar summary). */
  totalAddition: number;
  totalDeletion: number;
}

/** `HashFilePathForWebUI` — plain sha1 hex of the path. */
async function hashFilePathForWebUI(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** TranslateDiffEntryMode's name table (the modes the engine emits). */
function fileModeName(mode: string): string {
  switch (mode) {
    case "100644":
      return pullFilesLocale.filemode_regular;
    case "100755":
      return pullFilesLocale.filemode_executable;
    case "120000":
      return pullFilesLocale.filemode_symlink;
    case "160000":
      return pullFilesLocale.filemode_submodule;
    default:
      return mode;
  }
}

/** Number one hunk's ops into the unified row model. */
function hunkView(hunk: DiffFileJson["hunks"][number]): DiffHunkView {
  const rows: DiffLineRow[] = [];
  let left = hunk.aStart;
  let right = hunk.bStart;
  for (const op of hunk.ops) {
    if (op.tag === "eq") {
      rows.push({ type: "same", left, right, content: op.line });
      left += 1;
      right += 1;
    } else if (op.tag === "del") {
      rows.push({ type: "del", left, right: null, content: op.line });
      left += 1;
    } else {
      rows.push({ type: "add", left: null, right, content: op.line });
      right += 1;
    }
  }
  return { header: `@@ -${hunk.aStart},${hunk.aLen} +${hunk.bStart},${hunk.bLen} @@`, rows };
}

/**
 * Map one engine diff's files into the render model (hashes, numbering,
 * body branch) — the shared half of every diff page's loader. Exported for
 * the compare view (pages/compare.tsx, pages wave 13), which renders the
 * SAME boxes over a base...head range instead of a PR's refs/pull head.
 */
export async function diffFileViews(files: DiffFileJson[]): Promise<DiffFileView[]> {
  return Promise.all(
    files.map(async (file) => ({
      file,
      nameHash: await hashFilePathForWebUI(file.path),
      modeLabel:
        file.old === null && file.new !== null
          ? fileModeName(file.new.mode)
          : file.new === null && file.old !== null
            ? fileModeName(file.old.mode)
            : file.old !== null && file.new !== null && file.old.mode !== file.new.mode
              ? `${fileModeName(file.old.mode)} → ${fileModeName(file.new.mode)}`
              : null,
      body:
        file.kind === "binary"
          ? "binary"
          : file.kind === "toolarge"
            ? "toolarge"
            : file.old !== null && file.new !== null && file.old.mode !== file.new.mode
              ? "mode"
              : file.hunks.length === 0
                ? "whitespace"
                : "table",
      hunks: file.hunks.map(hunkView),
    })),
  );
}

/**
 * Load the PR + its three-dot range diff. Returns `null` when the row
 * misses or is not a pull (the caller 404-shells); engine-side range
 * failures (missing base/head refs — the service's ApiError 404) collapse
 * to the empty file list → the DiffNotAvailable render.
 */
export async function loadPullFilesData(
  c: ContextType<{ Bindings: Env }>,
  repoId: string,
  index: number,
): Promise<PullFilesData | null> {
  const issue = await findIssueByRepoAndIndex(c.env.DB, repoId, index);
  if (issue === null || !issue.isPull) return null;
  const prRow = await findPullRequestByIndex(c.env.DB, repoId, index);
  if (prRow === null) return null;
  const pr = prRow.pullRequest;

  // The diff service takes the API's RepositoryWithOwner pair (owner
  // joined); findRepositoryById re-reads the same row by id — repo
  // resolution already succeeded, so this is one cheap re-read, never a
  // second visibility decision.
  const pair = await findRepositoryById(c.env.DB, repoId);
  if (pair === null) return null;
  let files: DiffFileJson[];
  try {
    // pullRequestDiff is typed against the API's Context (its Variables the
    // service never reads) — the request/env pair re-wrapped, no casts.
    const apiContext = new Context<ApiEnv>(c.req.raw, { env: c.env });
    files = (await pullRequestDiff(apiContext, pair, pr)).files;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // The service's 404 (unresolvable base/head) → the empty range.
    files = [];
  }

  const views: DiffFileView[] = await diffFileViews(files);

  // The title bar's two names (the detail page's batched-name pattern).
  const personIds = new Set<number>();
  if (issue.posterId !== null) personIds.add(issue.posterId);
  if (pr.hasMerged && pr.mergerId != null) personIds.add(pr.mergerId);
  const names = new Map<number, string>();
  if (personIds.size > 0) {
    const rows = await drizzle(c.env.DB)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...personIds]))
      .all();
    for (const row of rows) names.set(row.id, row.username);
  }

  return {
    issue,
    pr,
    posterName: issue.posterId === null ? null : (names.get(issue.posterId) ?? null),
    mergerName: pr.hasMerged ? (names.get(pr.mergerId ?? -1) ?? null) : null,
    files: views,
    totalAddition: files.reduce((sum, file) => sum + file.add, 0),
    totalDeletion: files.reduce((sum, file) => sum + file.del, 0),
  };
}

// ---------------------------------------------------------------------------
// Diff components (repo/diff/box.tmpl + stats.tmpl + section_unified.tmpl)
// ---------------------------------------------------------------------------

/** stats.tmpl verbatim: the +A/-D counters and the proportional bar (the
 *  denominator carries upstream's `+ 0.0` float guard, stats.tmpl:13-14). */
function DiffStats(props: { addition: number; deletion: number }) {
  if (props.addition === 0 && props.deletion === 0) return null;
  const pct = (100 * props.addition) / (props.addition + props.deletion + 0.0);
  return (
    <div class="flex-text-block tw-flex-shrink-0 tw-text-[13px]">
      <span>
        {props.addition !== 0 ? <strong class="tw-text-diff-added-fg">+{props.addition}</strong> : null}
        {props.deletion !== 0 ? <strong class="tw-text-diff-removed-fg">-{props.deletion}</strong> : null}
      </span>
      <span class="diff-stats-bar">
        <div class="diff-stats-add-bar" style={`width: ${pct}%`} />
      </span>
    </div>
  );
}

/** One unified line row — the exact section_unified.tmpl:14-43 cell DOM
 *  (minus the JS-only excerpt/comment/escape controls, whose empty cells
 *  stay so the built CSS keeps shaping the rows). */
function UnifiedLineRow(props: { nameHash: string; row: DiffLineRow }) {
  const { row } = props;
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : "";
  return (
    <tr class={`${row.type}-code`} data-line-type={row.type}>
      <td class="lines-num lines-num-old" data-line-num={row.left === null ? "" : String(row.left)}>
        <span rel={row.left === null ? "" : `diff-${props.nameHash}L${row.left}`} />
      </td>
      <td class="lines-num lines-num-new" data-line-num={row.right === null ? "" : String(row.right)}>
        <span rel={row.right === null ? "" : `diff-${props.nameHash}R${row.right}`} />
      </td>
      <td class="lines-escape" />
      <td class="lines-type-marker">
        <span class="tw-font-mono" data-type-marker={marker} />
      </td>
      <td class={`chroma lines-code${row.right === null ? " lines-code-old" : ""}`}>
        <code class="code-inner">{row.content}</code>
      </td>
    </tr>
  );
}

/** One hunk: the `tag-code` header row (upstream renders the @@ line as a
 *  DiffLineSection — IsDiffLineSection's colspan'd lines-num + blob-hunk
 *  cell, section_unified.tmpl:15-21,31-32) then its line rows. */
function UnifiedHunkRows(props: { nameHash: string; hunk: DiffHunkView }) {
  return [
    <tr class="tag-code" data-line-type="tag">
      <td colspan={2} class="lines-num" />
      <td class="lines-escape" />
      <td class="lines-type-marker" />
      <td class="chroma lines-code blob-hunk">
        <code class="code-inner">{props.hunk.header}</code>
      </td>
    </tr>,
    ...props.hunk.rows.map((row) => <UnifiedLineRow nameHash={props.nameHash} row={row} />),
  ];
}

/** One file box (box.tmpl:95-222 reduced): header (name anchor + entry-mode
 *  label + stats/BIN) and body (unified table, or the honest degraded
 *  branch). Exported for the compare view's diff half (pages/compare.tsx) —
 *  one box vocabulary for every diff surface. */
export function DiffFileBox(props: { view: DiffFileView }) {
  const { view } = props;
  return (
    <div
      class="diff-file-box file-content tw-mt-0"
      id={`diff-${view.nameHash}`}
      data-old-filename={view.file.path}
      data-new-filename={view.file.path}
    >
      <div class="diff-file-header sticky-2nd-row ui top attached header">
        <div class="diff-file-name tw-flex tw-flex-1 tw-items-center tw-gap-1 tw-flex-wrap">
          <div class="flex-text-block">
            <a class="muted file-link tw-font-mono" title={view.file.path} href={`#diff-${view.nameHash}`}>
              {view.file.path}
            </a>
          </div>
          {view.modeLabel !== null ? <span class="ui label">{view.modeLabel}</span> : null}
        </div>
        <div class="diff-file-header-actions flex-text-block tw-justify-end tw-flex-wrap">
          {view.file.kind === "binary" ? (
            <>{pullFilesLocale.bin}</>
          ) : (
            <DiffStats addition={view.file.add} deletion={view.file.del} />
          )}
        </div>
      </div>
      <div class="diff-file-body ui attached unstackable table segment">
        <div id={`diff-source-${view.nameHash}`} class="file-body file-code unicode-escaped code-diff code-diff-unified">
          {view.body === "binary" ? (
            <div class="tw-p-3">{pullFilesLocale.bin_not_shown}</div>
          ) : view.body === "toolarge" ? (
            <div class="tw-p-3">{pullFilesLocale.file_suppressed}</div>
          ) : view.body === "mode" ? (
            <div class="tw-p-3">{pullFilesLocale.file_mode_changed}</div>
          ) : view.body === "whitespace" ? (
            <div class="tw-p-3">{pullFilesLocale.whitespace_only}</div>
          ) : (
            <table class="chroma">
              <colgroup>
                <col width="50" />
                <col width="50" />
                <col width="10" />
                <col width="10" />
                <col />
              </colgroup>
              <tbody>
                {view.hunks.map((hunk) => (
                  <UnifiedHunkRows nameHash={view.nameHash} hunk={hunk} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderPullFilesPage(options: { ctx: UiContext; data: PullFilesData }): string {
  return renderPage(<PullFilesPage ctx={options.ctx} data={options.data} />);
}

/** The PR files page (§2.4.1 discriminator: `repository view issue pull
 *  files diff` — pulls/files.tmpl:3 verbatim). */
export function PullFilesPage(props: { ctx: UiContext; data: PullFilesData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("PullFilesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const titleData: IssueTitleData = {
    issue: data.issue,
    pr: data.pr,
    posterName: data.posterName,
    mergerName: data.mergerName,
  };
  const empty = data.files.length === 0;
  return (
    <BaseLayout
      ctx={ctx}
      title={`#${data.issue.index} - ${data.issue.title}`}
      pageClass="repository view issue pull files diff"
      activeTab="pulls"
    >
      <div class="ui container fluid padded">
        <IssueTitleBar data={titleData} />
        <PullTabs repoLink={repoLink} issue={data.issue} active="files" filesCount={data.files.length} />
        <div class="diff-detail-box">
          <div class="flex-text-block tw-flex-wrap tw-ml-0.5">
            {!empty ? (
              <div class="diff-detail-stats tw-flex tw-items-center tw-flex-wrap">
                <strong>
                  {data.files.length} {pullFilesLocale.changed_files}
                </strong>{" "}
                {pullFilesLocale.with}{" "}
                <strong>
                  {data.totalAddition} {pullFilesLocale.additions}
                </strong>{" "}
                {pullFilesLocale.and}{" "}
                <strong>
                  {data.totalDeletion} {pullFilesLocale.deletions}
                </strong>
              </div>
            ) : null}
          </div>
          <div id="diff-container">
            <div id="diff-boxes-column">
              <div id="diff-file-boxes">
                {empty ? (
                  <h4>{pullFilesLocale.data_not_available}</h4>
                ) : (
                  data.files.map((view) => <DiffFileBox view={view} />)
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
