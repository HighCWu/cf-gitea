/**
 * The repo settings LFS pages — the census R11 row (upstream web.go:1249-1261's
 * `m.Group("/lfs", ...)`, handlers `routers/web/repo/setting/lfs.go`,
 * templates `repo/settings/lfs*.tmpl`). FOUR read surfaces, all reqRepoAdmin
 * (the whole settings group closes behind it, web.go:1283-1286 — the shared
 * settingsGate posture: anonymous → the login 303, a signed-in non-admin →
 * the 404 shell):
 *
 *   GET /{owner}/{repo}/settings/lfs              LFSFiles    (lfs.go:44-68)
 *   GET /{owner}/{repo}/settings/lfs/show/{oid}   LFSFileGet  (lfs.go:230-315)
 *   GET /{owner}/{repo}/settings/lfs/pointers     LFSPointerFiles (lfs.go:389-495)
 *   GET /{owner}/{repo}/settings/lfs/find         LFSFileFind (lfs.go:349-386)
 *
 * Upstream's `if !setting.LFS.StartServer { NotFound }` gate is vacuous here:
 * the LFS server is unconditional at this pin (SPEC-0006's always-on store),
 * so every request passes the arm upstream would refuse only on a
 * LFS-disabled install.
 *
 * ## The data split (ratified SPEC-0015 §2.3/§3.3)
 *
 * The engine's `scanLfsPointers` (fdfe73a) answers RAW size-gated candidate
 * blobs; services/lfs/read.ts parses (the landed `parsePointer`), dedups by
 * git blob oid (upstream's scan is object-keyed — one row per unique pointer
 * blob — while the tree-walk engine answer is per path), and joins
 * `lfsObjects` over the numeric `lfsRepoId` bridge. This module assembles the
 * page data (engineClient + defaultLfsDeps) and renders.
 *
 * ## Write arms — OUT this wave (the census's read-only split)
 *
 * LFSDelete (lfs.go:318-346), LFSAutoAssociate (lfs.go:498-526) and the locks
 * trio (lfs.go:71-227) are upstream POST arms: no buttons, forms or dialogs
 * render (lfs.tmpl's delete trash button + #delete-lfs-object dialog,
 * lfs_pointers.tmpl's associate form, lfs_locks.tmpl's lock/unlock forms all
 * stay unrendered — the no-dead-controls rule). The Locks anchor on the list
 * header (lfs.tmpl:6) omits for the same reason WITH a stronger one: the
 * locks API is a 501 defer at this pin (SPEC-0006 §2.7 P2,
 * src/lfs/router.ts:432) — there is no locks page to anchor. The census
 * impact table's "locks already landed" reads SPEC-0006's PLAN, not the pin
 * (the census correction this module's header records).
 *
 * ## Reductions (the divergence-ledger records)
 *
 *   - The Associatable mid term (a row in ANOTHER repo the viewer can read —
 *     LFSObjectAccessible's AccessibleRepositoryCondition join, lfs.go:450)
 *     honest-absents: `lfs_objects.repo_id` is the numeric lfsRepoId bridge,
 *     not a joinable `repositories.id` FK (services/lfs/read.ts header).
 *   - The find arm (LFSFileFind → FindLFSFile) walks REF TIPS under
 *     LFS_FIND_REF_SCAN_MAX with the batched per-path first-touch commit —
 *     upstream's `rev-list --all` × full-tree walk per commit is not
 *     expressible on this engine (read.ts header). The canonical-pointer
 *     identity (ComputeBlobHash over StringContent) ports EXACTLY as
 *     `pointerBlobSha1` — upstream never matches non-canonical pointer bytes
 *     either (lfs.go:366-368 builds the canonical text).
 *   - The detail view's media embeds (lfs_file.tmpl:25-37's img/video/audio
 *     arms — content typesniffer) render as the View Raw link arm: the
 *     sniffer has no landed port and the LFS object carries no filename for
 *     an extension sniff. Text renders as the line-numbered table
 *     (lfs.go:292-307's shape); too-large/empty are the template's exact
 *     size guards.
 *   - The pager renders the Older/Newer shape (base/paginate via the
 *     milestones module's landed reduction) over ExplorePagingNum's
 *     default-20 page size (lfs.go:57's builder).
 */

import type { LfsObjectContent, LfsFindResult, LfsMetaListItem, LfsPointerCounters, LfsPointerRow } from "../../services/lfs/read";
import {
  LFS_LIST_PAGE_SIZE,
  findLfsPointerCommits,
  getLfsMetaObject,
  listLfsMetaObjects,
  loadLfsObjectContent,
  loadLfsPointerRows,
} from "../../services/lfs/read";
import { defaultLfsDeps, lfsRepoId } from "../../lfs/router";
import { isValidPointerFields } from "../../services/lfs/batch";
import type { RepoRow, UiContext } from "../ui-context";
import { engineClient } from "../engine";
import { BaseLayout, Icon, renderPage } from "../shell";
import { formatByteSize, pathEscapeSegments, shortSha } from "../page-data";
import { TimeSince } from "../components/file-list";
import { SettingsNav } from "./settings";
import { AdminEmbeddedSvg } from "./admin-users";
import type { Child } from "hono/jsx";

/** Page chrome + notes text (component-local, the settingsLocale pattern;
 *  upstream locale keys cited, cf-gitea additions marked). */
export const repoSettingsLfsLocale = {
  lfs: "LFS", // "repo.settings.lfs" (the navbar item + the breadcrumb root)
  filelist: "LFS files stored in this repository", // "repo.settings.lfs_filelist"
  no_lfs_files: "No LFS files stored in this repository", // "repo.settings.lfs_no_lfs_files"
  findcommits: "Find commits", // "repo.settings.lfs_findcommits"
  findpointerfiles: "Find pointer files", // "repo.settings.lfs_findpointerfiles"
  lfs_file_no_commits: "No Commits found for this LFS file", // "repo.settings.lfs_lfs_file_no_commits"
  pointers_found: "Found %d blob pointer(s) — %d associated, %d unassociated (%d missing from store)", // "repo.settings.lfs_pointers.found"
  pointers_sha: "Blob SHA", // "repo.settings.lfs_pointers.sha"
  pointers_oid: "OID", // "repo.settings.lfs_pointers.oid"
  pointers_inRepo: "In Repo", // "repo.settings.lfs_pointers.inRepo"
  pointers_exists: "Exists in store", // "repo.settings.lfs_pointers.exists"
  pointers_accessible: "Accessible to User", // "repo.settings.lfs_pointers.accessible"
  total: "Total: %d", // "admin.total"
  file_too_large: "This file is too large to be displayed.", // shared/filetoolarge's text (the landed reduction)
  file_is_empty: "This file is empty.", // shared/fileisempty's text (the landed reduction)
  view_raw: "View Raw", // "repo.file_view_raw"
  scan_truncated: "The pointer scan hit its walk budget — the list below is partial.", // cf-gitea addition — the engine's budget honesty surfaced
} as const;

/** admin.total's %d render. */
function totalText(n: number): string {
  return repoSettingsLfsLocale.total.replace("%d", String(n));
}

/** lfs_pointers.found's four-%d render. */
function foundText(c: LfsPointerCounters): string {
  return repoSettingsLfsLocale.pointers_found.replace("%d", String(c.numPointers)).replace("%d", String(c.numAssociated)).replace("%d", String(c.numNotAssociated)).replace("%d", String(c.numNoExist));
}

// ---------------------------------------------------------------------------
// Page data loaders (the env seams assembled here; the pipeline in
// services/lfs/read.ts)
// ---------------------------------------------------------------------------

/** The list page's data (LFSFiles). Pure D1 — renders on an unborn HEAD too
 *  (upstream has no MustBeNotEmpty gate on the family). */
export async function loadLfsFilesPageData(env: Env, repo: RepoRow, page: number): Promise<LfsFilesPageData> {
  const { total, rows } = await listLfsMetaObjects(env.DB, lfsRepoId(repo.id), page, LFS_LIST_PAGE_SIZE);
  return { total, rows, page, pageSize: LFS_LIST_PAGE_SIZE };
}

/** The detail page's data (LFSFileGet): `null` = the handler's 404 — an
 *  invalid oid (lfs.go:238-242's IsValid arm) or a meta miss
 *  (lfs.go:246-254's ErrLFSObjectNotExist). */
export async function loadLfsDetailPageData(env: Env, repo: RepoRow, oid: string): Promise<LfsFileDetailPageData | null> {
  if (!isValidPointerFields(oid, 0)) return null; // lfs.go:238-242's Pointer.IsValid arm
  const meta = await getLfsMetaObject(env.DB, lfsRepoId(repo.id), oid);
  if (meta === null) return null;
  const { store } = defaultLfsDeps(env);
  const content = await loadLfsObjectContent(store, repo.storageKey, meta.oid, meta.size);
  // lfs.go:273's RawFileLink — the LFS download endpoint on the .git family.
  const rawLink = `/${repo.ownerNamespace}/${repo.slug}.git/info/lfs/objects/${meta.oid}`;
  return { meta, content, rawLink };
}

/** The pointers page's data (LFSPointerFiles). The engine's null ladder
 *  (unborn HEAD) renders the EMPTY table — upstream's scanner over an empty
 *  history finds nothing and the template renders found-0 (never a 404). */
export async function loadLfsPointersPageData(env: Env, repo: RepoRow, viewerIsAdmin: boolean): Promise<LfsPointersPageData> {
  const { store } = defaultLfsDeps(env);
  // The engine's methods are interface-declared members — extract BOUND
  // (the unbound-method rule; the client object is arrow-built, so the
  // bind is identity) — the injected scan seam keeps its exact signature.
  const client = engineClient(env, `${repo.ownerNamespace}/${repo.slug}`);
  const scan = client.scanLfsPointers.bind(client);
  const scanned = await loadLfsPointerRows(env.DB, store, scan, {
    repoId: lfsRepoId(repo.id),
    storageKey: repo.storageKey,
    ref: repo.defaultBranch,
    viewerIsAdmin,
  });
  if (scanned.answer === null) {
    return {
      pointers: [],
      counters: { numPointers: 0, numAssociated: 0, numAssociatable: 0, numNoExist: 0, numNotAssociated: 0 },
      truncated: false,
    };
  }
  return scanned.answer;
}

/** The find page's data (LFSFileFind): `null` = the handler's 404 — an empty
 *  oid or a zero size (lfs.go:356-359's guard; a junk oid short-circuits at
 *  the canonical-identity compute, which throws on a non-hex oid). */
export async function loadLfsFindPageData(env: Env, repo: RepoRow, oid: string, size: number, sha?: string): Promise<LfsFileFindPageData | null> {
  if (oid === "" || size === 0) return null;
  if (!isValidPointerFields(oid, 0)) return null;
  const client = engineClient(env, `${repo.ownerNamespace}/${repo.slug}`);
  const refs = await client.listRefs();
  // Bound extraction (see loadLfsPointersPageData's note).
  const scan = client.scanLfsPointers.bind(client);
  const listTreeCommits = client.listTreeCommits.bind(client);
  const results =
    refs === null
      ? []
      : await findLfsPointerCommits(scan, refs, listTreeCommits, oid, size, sha);
  return { oid, size, sha: sha ?? "", results };
}

// ---------------------------------------------------------------------------
// Page data shapes
// ---------------------------------------------------------------------------

export interface LfsFilesPageData {
  total: number;
  rows: LfsMetaListItem[];
  page: number;
  pageSize: number;
}

export interface LfsFileDetailPageData {
  meta: { oid: string; size: number; createdAt: Date };
  content: LfsObjectContent;
  /** The LFS download endpoint (lfs.go:273's RawFileLink). */
  rawLink: string;
}

export interface LfsPointersPageData {
  pointers: LfsPointerRow[];
  counters: LfsPointerCounters;
  truncated: boolean;
}

export interface LfsFileFindPageData {
  oid: string;
  size: number;
  sha: string;
  results: LfsFindResult[];
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The settings-LFS pageClass — layout_head's literal shared by all four
 *  upstream templates ("repository settings lfs"). */
const PAGE_CLASS = "repository settings lfs";

/** The shared shell: BaseLayout + the settings nav with the LFS item lit. */
function LfsShell(props: { ctx: UiContext; title: string; children: Child }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("repo-settings-lfs requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass={PAGE_CLASS}>
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="lfs" repo={repo} />
        <div class="flex-container-main">{props.children}</div>
      </div>
    </BaseLayout>
  );
}

/** The Created cell — DateUtils.TimeSince's `<relative-time>` shape (the
 *  landed TimeSince component; D1 timestamps are UTC). */
function TimeSinceCell(props: { at: Date }) {
  return <TimeSince unixSeconds={Math.floor(props.at.getTime() / 1000)} tz="+0000" />;
}

/** The check/x glyph pair (lfs_pointers.tmpl:44-46's Iif) — octicon-check is
 *  allowlisted, octicon-x rides the embedded-svg fold (admin-users' exported
 *  renderer, the org-home import precedent). */
function CheckX(props: { on: boolean }) {
  return props.on ? <Icon name="octicon-check" /> : <AdminEmbeddedSvg name="octicon-x" />;
}

/** The list page (lfs.tmpl). The Locks anchor and the delete
 *  button/dialog omit — the write arms this wave excludes (module header). */
export function RepoSettingsLfsListPage(props: { ctx: UiContext; data: LfsFilesPageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsLfsListPage requires ctx.repo");
  const link = `/${repo.ownerNamespace}/${repo.slug}/settings/lfs`;
  const more = data.page * data.pageSize < data.total;
  return (
    <LfsShell ctx={ctx} title={repoSettingsLfsLocale.lfs}>
      <h4 class="ui top attached header">
        {repoSettingsLfsLocale.filelist} ({totalText(data.total)})
        <div class="ui right">
          <a class="ui primary tiny compact button" href={`${link}/pointers`}>
            {repoSettingsLfsLocale.findpointerfiles}
          </a>
        </div>
      </h4>
      <table id="lfs-files-table" class="ui attached segment single line table">
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <td colspan={4}>{repoSettingsLfsLocale.no_lfs_files}</td>
            </tr>
          ) : (
            data.rows.map((row) => (
              <tr>
                <td>
                  <a href={`${link}/show/${row.oid}`} title={row.oid} class="ui label commit-id-short">
                    {shortSha(row.oid)}
                  </a>
                </td>
                <td>{formatByteSize(row.size)}</td>
                <td>
                  <TimeSinceCell at={row.createdAt} />
                </td>
                <td>
                  <div class="flex-text-block tw-justify-end">
                    <a class="ui basic primary tiny compact button" href={`${link}/find?oid=${row.oid}&size=${row.size}`}>
                      {repoSettingsLfsLocale.findcommits}
                    </a>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {data.page > 1 || more ? (
        <div class="center page buttons">
          <div class="ui borderless pagination menu">
            {data.page > 1 ? (
              <a class="item navigation" href={data.page === 2 ? link : `${link}?page=${data.page - 1}`}>
                <span class="navigation_label">Newer</span>
              </a>
            ) : null}
            {more ? (
              <a class="item navigation" href={`${link}?page=${data.page + 1}`}>
                <span class="navigation_label">Older</span>
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </LfsShell>
  );
}

/** The detail page (lfs_file.tmpl). Media embeds render as the View Raw
 *  arm (module header's reduction); text renders the line-numbered table. */
export function RepoSettingsLfsDetailPage(props: { ctx: UiContext; data: LfsFileDetailPageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsLfsDetailPage requires ctx.repo");
  const link = `/${repo.ownerNamespace}/${repo.slug}/settings/lfs`;
  return (
    <LfsShell ctx={ctx} title={data.meta.oid}>
      <div class="tab-size-8 non-diff-file-content">
        <h4 class="ui top attached header">
          <a href={link}>{repoSettingsLfsLocale.lfs}</a> / <span class="truncate sha">{data.meta.oid}</span>
          <div class="ui right">
            <a class="ui primary tiny button" href={`${link}/find?oid=${data.meta.oid}&size=${data.meta.size}`}>
              {repoSettingsLfsLocale.findcommits}
            </a>
          </div>
        </h4>
        <div class="ui bottom attached segment file-view-container">
          <div class="file-view">
            {data.content.kind === "too-large" ? (
              <div class="view-raw tw-p-4">
                {repoSettingsLfsLocale.file_too_large}{" "}
                <a href={data.rawLink} rel="nofollow">
                  {repoSettingsLfsLocale.view_raw}
                </a>
              </div>
            ) : data.content.kind === "empty" ? (
              <div class="view-raw tw-p-4">{repoSettingsLfsLocale.file_is_empty}</div>
            ) : data.content.kind === "text" ? (
              <table>
                <tbody>
                  {data.content.lines.map((line, i) => (
                    <tr>
                      <td class="lines-num">{i + 1}</td>
                      <td class="lines-code">
                        <code class="code-inner">{line}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="view-raw">
                <a href={data.rawLink} rel="nofollow" class="tw-p-4">
                  {repoSettingsLfsLocale.view_raw}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </LfsShell>
  );
}

/** The pointers page (lfs_pointers.tmpl). The associate form omits — the
 *  write arm this wave excludes (module header); the truncated honesty line
 *  is the cf-gitea addition surfacing the engine's budget flag. */
export function RepoSettingsLfsPointersPage(props: { ctx: UiContext; data: LfsPointersPageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsLfsPointersPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const link = `${repoLink}/settings/lfs`;
  return (
    <LfsShell ctx={ctx} title={repoSettingsLfsLocale.findpointerfiles}>
      <h4 class="ui top attached header">{foundText(data.counters)}</h4>
      {data.truncated ? <div class="ui warning message">{repoSettingsLfsLocale.scan_truncated}</div> : null}
      <div class="ui attached segment">
        <table id="lfs-files-table" class="ui fixed single line table">
          <thead>
            <tr>
              <th class="three wide">{repoSettingsLfsLocale.pointers_sha}</th>
              <th class="four wide">{repoSettingsLfsLocale.pointers_oid}</th>
              <th class="two wide">{repoSettingsLfsLocale.pointers_inRepo}</th>
              <th class="two wide">{repoSettingsLfsLocale.pointers_exists}</th>
              <th class="two wide">{repoSettingsLfsLocale.pointers_accessible}</th>
              <th class="three wide" />
            </tr>
          </thead>
          <tbody>
            {data.pointers.map((row) => {
              // lfs_pointers.tmpl:39 — the oid link is live only when the
              // object is viewable (exists AND in this repo).
              const viewable = row.exists && row.inRepo;
              return (
                <tr>
                  <td>
                    <a href={`${repoLink}/raw/blob/${row.blobSha}`} rel="nofollow" target="_blank" title={row.blobSha} class="ui label commit-id-short">
                      {shortSha(row.blobSha)}
                    </a>
                  </td>
                  <td>
                    <a
                      href={`${link}/show/${row.oid}`}
                      rel="nofollow"
                      target="_blank"
                      title={row.oid}
                      class={`ui label commit-id-short${viewable ? "" : " disabled"}`}
                    >
                      {shortSha(row.oid)}
                    </a>
                  </td>
                  <td>
                    <CheckX on={row.inRepo} />
                  </td>
                  <td>
                    <CheckX on={row.exists} />
                  </td>
                  <td>
                    <CheckX on={row.accessible} />
                  </td>
                  <td class="tw-text-right">
                    <a class="ui primary button" href={`${link}/find?oid=${row.oid}&size=${row.size}&sha=${row.blobSha}`}>
                      {repoSettingsLfsLocale.findcommits}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </LfsShell>
  );
}

/** The find page (lfs_file_find.tmpl). The upstream sha arm rides the
 *  pointers table's &sha= param; the module never emits it otherwise. */
export function RepoSettingsLfsFindPage(props: { ctx: UiContext; data: LfsFileFindPageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsLfsFindPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const link = `${repoLink}/settings/lfs`;
  return (
    <LfsShell ctx={ctx} title={data.oid}>
      <div class="tab-size-8 non-diff-file-content">
        <h4 class="ui top attached header">
          <a href={link}>{repoSettingsLfsLocale.lfs}</a> / <span class="truncate sha">{data.oid}</span>
        </h4>
        <table id="lfs-files-find-table" class="ui attached segment single line table">
          <tbody>
            {data.results.length === 0 ? (
              <tr>
                <td colspan={5}>{repoSettingsLfsLocale.lfs_file_no_commits}</td>
              </tr>
            ) : (
              data.results.map((result) => (
                <tr>
                  <td>
                    <Icon name="octicon-file" />
                    <a href={`${repoLink}/src/commit/${result.sha}/${pathEscapeSegments(result.path)}`} title={result.path}>
                      {result.path}
                    </a>
                  </td>
                  <td class="message">
                    <span class="truncate">
                      <a href={`${repoLink}/commit/${result.sha}`} title={result.summary}>
                        {result.summary}
                      </a>
                    </span>
                  </td>
                  <td>
                    <span class="tw-text-text-light">
                      <Icon name="octicon-git-branch" />
                      {result.branchName}
                    </span>
                  </td>
                  <td>
                    {result.parentHashes.length > 0 ? (
                      <>
                        Parent{" "}
                        {result.parentHashes.map((parent) => (
                          <a class="ui primary sha label" href={`${repoLink}/commit/${parent}`}>
                            {shortSha(parent)}
                          </a>
                        ))}{" "}
                      </>
                    ) : null}
                    Commit{" "}
                    <a class="ui primary sha label" href={`${repoLink}/commit/${result.sha}`}>
                      {shortSha(result.sha)}
                    </a>
                  </td>
                  <td>
                    <TimeSinceCell at={new Date(result.when * 1000)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </LfsShell>
  );
}

/** The renderPage wrappers (§2.4.1 — the family's one-liner render seam). */
export function renderRepoSettingsLfsListPage(options: { ctx: UiContext; data: LfsFilesPageData }): string {
  return renderPage(<RepoSettingsLfsListPage ctx={options.ctx} data={options.data} />);
}

export function renderRepoSettingsLfsDetailPage(options: { ctx: UiContext; data: LfsFileDetailPageData }): string {
  return renderPage(<RepoSettingsLfsDetailPage ctx={options.ctx} data={options.data} />);
}

export function renderRepoSettingsLfsPointersPage(options: { ctx: UiContext; data: LfsPointersPageData }): string {
  return renderPage(<RepoSettingsLfsPointersPage ctx={options.ctx} data={options.data} />);
}

export function renderRepoSettingsLfsFindPage(options: { ctx: UiContext; data: LfsFileFindPageData }): string {
  return renderPage(<RepoSettingsLfsFindPage ctx={options.ctx} data={options.data} />);
}
