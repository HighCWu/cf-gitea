/**
 * The releases family — pages wave 20 (SPEC-0008 U3 extension; the parity
 * survey's #4) — over the LANDED release data side (api/services/releases.ts
 * + release-assets.ts + the SPEC-0005 IssuesService.createRelease write):
 *
 *   GET  /{owner}/{repo}/releases            the list (upstream `repo.Releases`,
 *                                            web.go:1506 — `?page=` pager)
 *   GET  /{owner}/{repo}/releases/new        the create form (upstream
 *                                            `repo.NewRelease`, web.go:1517;
 *                                            writer-gated)
 *   POST /{owner}/{repo}/releases/new        the create write (upstream
 *                                            `repo.NewReleasePost`,
 *                                            web.go:1518) → 303 onto the
 *                                            created release's detail page
 *   GET  /{owner}/{repo}/releases/tag/{tag}  the release detail (upstream
 *                                            `repo.SingleRelease`,
 *                                            web.go:1509 — ONE release
 *                                            rendered through the same
 *                                            list template)
 *   GET  /{owner}/{repo}/releases/latest     303 onto the latest stable
 *                                            release's detail page (upstream
 *                                            `repo.LatestRelease`,
 *                                            web.go:1510 — Redirect(Link()))
 *
 * Upstream citations (submodule pin fc4936884584): templates/repo/release/
 * list.tmpl + new.tmpl + label.tmpl + release_tag_header.tmpl,
 * routers/web/repo/release.go (Releases / NewRelease / NewReleasePost /
 * SingleRelease / LatestRelease), routers/web/web.go:1505-1527.
 *
 * ## DOM contract (list.tmpl at the pin — the detail page IS the list
 * template over one row, SingleRelease's exact shape)
 *
 * `.page-content.repository releases` (the form: `repository new release`),
 * release_tag_header.tmpl's `.flex-left-right` (the counts menu + the New
 * Release button) over `<ul id="release-list">` rows: `.release-entry` with
 * the `.meta` tag/commit links, the `.ui.segment.detail` carrying the title
 * + label (label.tmpl), the author + "released this" line, the notes through
 * the §3.4 markdown pipeline and the `<details class="download">` block with
 * the attachment rows.
 *
 * ## Data (§3.2 — the landed services, never a self-fetch)
 *
 * The list rides `listReleases` (the upstream FindReleases posture:
 * tag-only rows excluded, drafts included for writers only,
 * `created_unix DESC, id DESC`); the Latest mark rides `findLatestRelease`
 * (the API's GetLatestReleaseByRepoID arm — the install-script contract);
 * detail rides `findReleaseByTag` with the API's exact visibility rules
 * (`assertNotTagRecord` + `assertDraftVisible` postures — tag-only records
 * and foreign-eye drafts 404); assets ride `listReleaseAssets` +
 * `toApiAttachment` (the landed asset URLs); notes render through the shared
 * markdown pipeline (§3.4 — the issue-detail `comment` mode, imported from
 * pages/issue-detail.tsx so the two bodies can never diverge). The write
 * goes through `IssuesService.createRelease` (the landed create arm with its
 * 409 semantics + tag-record conversion) and emits the API POST route's
 * `release` webhook through the shared `emitIssueEvent` seam (drafts stay
 * silent — routes/releases.ts emitReleaseEvent's `!rel.IsDraft` gate).
 *
 * ## Auth + CSRF posture (the file-editor/milestones shape)
 *
 * The list + detail render for every viewer who can see the repo (§2.5
 * resolution; upstream reqRepoReleaseReader). Draft visibility IS the write
 * grant (`canWriteRepo` — the session bridge over the landed
 * `canWriteRepository`; upstream IncludeDrafts: writeAccess). The form +
 * write are WRITER-gated: anonymous 303s onto the login round-trip, a
 * signed-in non-writer 404-shells (the file-editor/milestones convention;
 * upstream reqRepoReleaseWriter answers 403 — our undiscoverable-404
 * posture). The POST runs the §2.8 layer-2 Origin/Referer check. Archived
 * repos 404-shell the form routes (upstream RepoMustNotBeArchived answers
 * 403 — the file-editor reduction) and hide the New Release button
 * (CanCreateRelease's !IsArchived); the LIST still renders (upstream gates
 * the read group on MustBeNotEmpty only). An EMPTY repo 404-shells the whole
 * family (upstream `repo.MustBeNotEmpty` wraps the group verbatim).
 *
 * ## Documented v1 degradations (§6 method — dead-link rule throughout)
 *
 * - The entry title renders `h3.release-list-title` (upstream `h4` under the
 *   header menu's `h2` — an upward heading skip the §5.5 R2 rule refuses;
 *   the class hooks the official bundle targets are unchanged, the
 *   commit-list scope=col precedent of additive a11y deviations).
 * - The tag/commit links resolve against the ENGINE ref universe
 *   (listRefs): a release whose tag exists in git renders the `/src/tag/…`
 *   tag link and the `/src/commit/{oid}` ShortSha commit link (upstream's
 *   Sha1-bearing DOM); a D1-only release (the documented engine boundary —
 *   api/services/releases.ts header: creating a release does not create the
 *   tag) renders the tag as PLAIN TEXT and no commit link. Upstream renders
 *   `href="#"` in that state; §2.4.1's "dead links are not emitted" wins.
 * - The IsLatest label extends the LIST rows: upstream's list template
 *   renders the label without IsLatest (only the repo-home sidebar passes
 *   it — home_sidebar_bottom.tmpl:15); the task brief names the Latest tag
 *   a list feature and label.tmpl carries the contract, so the newest
 *   stable release renders the green Latest label in the list too.
 * - The release_tag_header menu's Tags item (`{RepoLink}/tags`) and the RSS
 *   button are unrendered — the tags list page and the feed family do not
 *   exist (dead-link rule); the menu keeps the single live Releases item
 *   (the milestones navbar reduction).
 * - The tab strip's Releases count label (`{{if .NumReleases}}` — computed
 *   per repo page upstream, services/context/repo.go:634) is unrendered:
 *   D1 keeps no maintained num_releases counter and the shared shell would
 *   pay a COUNT on every repo-scoped render for a label most repos never
 *   show. The releases PAGES render the real count in the header menu.
 * - The row edit pencil (`/releases/edit/{tag}`), the compare branch
 *   dropdown, commit statuses, the reactions block and the ahead/behind
 *   line are unrendered — no landed surfaces (the upstream ahead line
 *   itself never renders while `num_commits` stays 0 at the engine
 *   boundary). The `add_tag_msg` checkbox, the tag-only button and the
 *   generate-notes button target engine tag creation / the
 *   generate-notes POST — none landed (dead-link rule).
 * - Source-archive rows in the downloads block (`/archive/{tag}.zip|tar.gz`)
 *   are unrendered — the web-shape archive route does not exist (the
 *   branches page's archive reduction); the attachment rows render the
 *   landed `browser_download_url` (`/attachments/{uuid}`) whose serving
 *   route is the survey's separate S row (`/releases/attachments/{uuid}`).
 * - The create form's JS tag dropdown reduces to a native `<select>` over
 *   the branch universe (the file-editor target-branch select); the two
 *   submit buttons reduce to ONE Publish button + a draft CHECKBOX (the
 *   task brief's field shape — upstream expresses draft as the Save Draft
 *   submit variant), the combo markdown editor reduces to the plain
 *   textarea (the new-issue convention).
 * - Success redirects onto the created release's DETAIL page (the task
 *   brief, the new-issue POST convention); upstream NewReleasePost
 *   JSONRedirects onto the list. Validation failures re-render at 200 with
 *   the message and the kept submission (the login failure convention).
 * - Pagination is the list pages' Older/Newer shape, page size upstream
 *   `setting.Repository.Release.DefaultPagingNum` = 10.
 */

import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";

import type { ReleaseAssetRow } from "../../api/services/release-assets";
import { listReleaseAssets, toApiAttachment } from "../../api/services/release-assets";
import {
  findLatestRelease,
  findReleaseByTag,
  listReleases,
  toApiRelease,
} from "../../api/services/releases";
import { engineReads } from "../../api/services/engine";
import {
  apiUserFromRow,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";import { ReleaseAlreadyExistError } from "../../issues/errors";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { emitIssueEvent, type IssueEventRequest } from "../../services/issue-events";
import { users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { renderIssueMarkdown } from "./issue-detail";
import { parseFormBool } from "./notifications";
import { formatByteSize, parsePageNumber, pathEscapeSegments, shortSha } from "../page-data";
import { userLink } from "../links";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

/** Page chrome text (component-local, the tabLocale pattern — the strings
 *  cite upstream's locale keys). */
export const releasesLocale = {
  page_title: "Releases", // "repo.releases" / "repo.release.releases"
  tags_label: "Tags", // "repo.release.tags" (wave 25's header-menu item)
  new_release: "New Release", // "repo.release.new_release"
  new_subheader: "Releases organize project versions.", // "repo.release.new_subheader"
  release: "Release", // "repo.release" (TrN singular)
  tag: "Tag", // "repo.release.tag"
  latest: "Latest", // "repo.release.latest"
  draft: "Draft", // "repo.release.draft"
  prerelease: "Pre-Release", // "repo.release.prerelease"
  stable: "Stable", // "repo.release.stable"
  released_this: "released this", // "repo.released_this"
  downloads: "Downloads", // "repo.release.downloads"
  source_code: "Source Code", // "repo.release.source_code" (unrendered — archive reduction)
  download_count: "Downloads", // "repo.release.download_count" (the tooltip prefix)
  git_tag: "Git Tag", // "repo.git_tag"
  tag_name: "Tag name", // "repo.release.tag_name"
  target: "Target", // "repo.release.target"
  title: "Release title", // "repo.release.title"
  notes: "Release notes", // "repo.release.notes"
  message_placeholder: "Describe this release", // "repo.release.message"
  prerelease_desc: "Mark as Pre-Release", // "repo.release.prerelease_desc"
  prerelease_helper: "Mark this release unsuitable for production use.", // "repo.release.prerelease_helper"
  save_draft: "Save Draft", // "repo.release.save_draft" (the draft checkbox label)
  publish: "Publish Release", // "repo.release.publish"
  /** Upstream `repo.release.title_empty` — the empty-title re-render. */
  title_required: "Title cannot be empty.",
  /** Upstream `repo.release.tag_name_already_exist` — the 409 re-render
   *  (IssuesService.createRelease's ReleaseAlreadyExistError). */
  tag_already_exist: "A release with this tag name already exists.",
  /** Upstream `form.target_branch_not_exist` — the target-branch check. */
  target_branch_not_exist: "Target branch does not exist.",
  /** cf-gitea additions (the milestones page's server-side mirror of the
   *  HTML5 required/maxlength checks — upstream binds them at form level). */
  tag_name_required: "Tag name is required.",
  tag_name_too_long: "Tag name must be at most 255 characters.",
  title_too_long: "Release title must be at most 255 characters.",
  /** The archived refusal — the API create route's exact message (the
   *  milestones page's carried convention). */
  repo_archived: "repo is archived",
} as const;

/** Upstream `setting.Repository.Release.DefaultPagingNum`
 * (modules/setting/repository.go:233) — the releases list page size. */
export const RELEASES_PAGE_SIZE = 10;

/** Upstream `ctx.Locale.PrettyNumber` (en-US grouping, ICU-free so the
 *  rendered bytes never depend on the runtime). Exported for pages/tags.tsx
 *  (wave 25 — the tags page's header menu shares the shape). */
export function prettyNumber(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The tag universe of one repository: `refs/tags/*` name → commit oid (the
 *  listRefs read; an annotated tag's `peeled` commit wins over the tag
 *  object — upstream's Sha1 is the commit the tag names). A failed read
 *  degrades to the empty map — tags then render as plain text, never broken
 *  pages). */
export async function tagTipsOf(env: Env, repo: RepoRow): Promise<Map<string, string>> {
  const refs = await engineReads(env, repo).listRefs();
  const tips = new Map<string, string>();
  for (const ref of refs?.refs ?? []) {
    if (ref.name.startsWith("refs/tags/")) tips.set(ref.name.slice("refs/tags/".length), ref.peeled ?? ref.target);
  }
  return tips;
}

// ---------------------------------------------------------------------------
// Row enrichment (shared by the list and the detail — the same entry DOM)
// ---------------------------------------------------------------------------

/** One rendered asset row (the attachment-list item). */
export interface ReleaseAssetView {
  row: ReleaseAssetRow;
  /** `toApiAttachment`'s browser_download_url — the landed asset URL. */
  downloadUrl: string;
  /** `FormatByteSize` text. */
  sizeText: string;
}

/** One rendered release entry (list.tmpl's `.release-entry` inputs). */
export interface ReleaseEntry {
  row: ReleaseRow;
  /** Display-cased publisher username; `null` = no user row (Ghost — the
   *  upstream `{{else}}Ghost{{end}}` arm). */
  publisherName: string | null;
  /** The newest non-draft non-prerelease release (findLatestRelease) — the
   *  green Latest label (the module header's IsLatest note). */
  isLatest: boolean;
  /** The note through the §3.4 shared pipeline; `""` = no-content variant. */
  noteHtml: string;
  assets: ReleaseAssetView[];
  /** The tag's in-git state (the engine boundary note): when set, the meta
   *  row renders the /src/tag/ link and the /src/commit/ ShortSha link. */
  tagOid: string | null;
}

/** The entry title (upstream renders the title, falling back to the tag name
 *  for tag records; an empty REAL-release title falls back too — the empty
 *  link text would violate the a11y R5 link-name rule). */
export function releaseTitleOf(entry: { row: ReleaseRow }): string {
  return entry.row.title !== "" ? entry.row.title : entry.row.tagName;
}

async function enrichEntries(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  rows: ReleaseRow[],
  latestId: number,
  origin: string,
  tags: Map<string, string>,
): Promise<ReleaseEntry[]> {
  // One batched publisher lookup (§3.2's wave-2 batching pattern).
  const publisherIds = [...new Set(rows.map((row) => row.publisherId).filter((id) => id > 0))];
  const names = new Map<number, string>();
  if (publisherIds.length > 0) {
    const rowsById = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, publisherIds))
      .all();
    for (const row of rowsById) names.set(row.id, row.username);
  }
  return Promise.all(
    rows.map(async (row): Promise<ReleaseEntry> => {
      const assets = (await listReleaseAssets(d1, row.id)).map((assetRow): ReleaseAssetView => {
        return {
          row: assetRow,
          downloadUrl: toApiAttachment(origin, assetRow).browser_download_url ?? "",
          sizeText: formatByteSize(assetRow.size),
        };
      });
      return {
        row,
        publisherName: names.get(row.publisherId) ?? null,
        isLatest: row.id === latestId,
        noteHtml: renderIssueMarkdown({ text: row.note ?? "", repo, origin }),
        assets,
        tagOid: tags.get(row.tagName) ?? null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// The list (GET /releases)
// ---------------------------------------------------------------------------

/** The releases list render inputs. */
export interface ReleasesData {
  page: number;
  items: ReleaseEntry[];
  /** The write-access-inclusive total (upstream NumReleases,
   *  services/context/repo.go:634's IncludeDrafts: CanWrite count). */
  total: number;
  /** The in-git tag count (upstream NumTags — HasSha1 count; the engine's
   *  refs/tags universe is the honest source at the D1-only boundary). */
  numTags: number;
  more: boolean;
  /** The create grant behind the New Release button (upstream
   *  CanCreateRelease = CanWrite(TypeReleases) && !IsArchived). Set by the
   *  route handler after the load (the milestones canWrite pattern). */
  canCreate: boolean;
}

/**
 * Load the list (§3.2): one filtered page read + the latest-release lookup +
 * the engine tag universe (one listRefs). `canWrite` drives the draft
 * inclusion exactly like the API LIST's includeDrafts arm.
 */
export async function loadReleasesData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  canWrite: boolean,
  params: URLSearchParams,
  origin: string,
): Promise<ReleasesData> {
  const page = parsePageNumber(params.get("page"));
  const [{ items: rows, total }, latest, tags] = await Promise.all([
    listReleases(d1, repo.id, {
      includeDrafts: canWrite,
      isDraft: null,
      isPrerelease: null,
      tagFilter: "",
      page,
      limit: RELEASES_PAGE_SIZE,
    }),
    findLatestRelease(d1, repo.id),
    tagTipsOf(env, repo),
  ]);
  const items = await enrichEntries(env, d1, repo, rows, latest?.id ?? -1, origin, tags);
  return {
    page,
    items,
    total,
    numTags: tags.size,
    more: page * RELEASES_PAGE_SIZE < total,
    canCreate: false, // the handler assigns the real predicate (see ReleasesData)
  };
}

// ---------------------------------------------------------------------------
// The detail (GET /releases/tag/{tag})
// ---------------------------------------------------------------------------

/**
 * Load one release by tag with the API family's exact visibility rules
 * (findReleaseByTag → assertNotTagRecord → assertDraftVisible postures):
 * a missing or tag-only row answers null, a draft answers null for viewers
 * without the write grant (the recurring 404 — the service module's
 * canAccessReleaseDraft note).
 */
export async function loadReleaseDetailData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  tag: string,
  canWrite: boolean,
  origin: string,
): Promise<ReleaseEntry | null> {
  const row = await findReleaseByTag(d1, repo.id, tag);
  if (row === null || row.isTag) return null;
  if (row.isDraft && !canWrite) return null;
  const [latest, tags] = await Promise.all([findLatestRelease(d1, repo.id), tagTipsOf(env, repo)]);
  const [entry] = await enrichEntries(env, d1, repo, [row], latest?.id ?? -1, origin, tags);
  return entry ?? null;
}

// ---------------------------------------------------------------------------
// The create form + write (GET/POST /releases/new)
// ---------------------------------------------------------------------------

/** The form's render inputs (the branch universe for the target select). */
export interface NewReleaseData {
  branches: readonly string[];
  /** The select's default (the repo row's default branch — upstream
   *  `ctx.Data["tag_target"] = ctx.Repo.Repository.DefaultBranch`). */
  defaultBranch: string;
}

/** The parsed create-release submission; raw strings re-render on failure. */
export interface NewReleaseForm {
  tagName: string;
  tagTarget: string;
  title: string;
  content: string;
  draft: boolean;
  prerelease: boolean;
}

/** Parse the urlencoded POST (`tag_name`, `tag_target`, `title`, `content`,
 *  `draft`, `prerelease` — the upstream NewReleaseForm field names; the
 *  checkboxes are the task brief's shape, the module header's note). */
export function parseNewReleaseForm(params: URLSearchParams): NewReleaseForm {
  return {
    tagName: (params.get("tag_name") ?? "").trim(),
    tagTarget: (params.get("tag_target") ?? "").trim(),
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    draft: parseFormBool(params.get("draft")),
    prerelease: parseFormBool(params.get("prerelease")),
  };
}

/** Load the form's branch universe (upstream PrepareBranchList — the
 *  branches page's filter + byte-order sort over listRefs). */
export async function loadNewReleaseData(env: Env, repo: RepoRow): Promise<NewReleaseData> {
  const refs = await engineReads(env, repo).listRefs();
  const branches = (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { branches, defaultBranch: repo.defaultBranch };
}

export type NewReleaseResult =
  | { outcome: "created"; tag: string }
  | { outcome: "invalid"; message: string };

/**
 * The write (upstream NewReleasePost's sequence over the LANDED create arm):
 * validate the form (title/tag required, target branch exists — the form
 * binding checks upstream answers), then `IssuesService.createRelease` (the
 * API POST route's exact call: target falls back to the default branch, the
 * 409 duplicate semantics, the tag-record conversion), then the `release`
 * webhook through the shared emit seam — drafts stay silent, a publish
 * emits action "published" (routes/releases.ts emitReleaseEvent). Any
 * service-level failure re-renders as `invalid` with the upstream message.
 */
export async function createReleaseFromForm(input: {
  env: Env;
  /** The request the webhook emission reads (the executionCtx-guarded
   *  Queue probe — the shared seam's shape; both routers' Contexts fit). */
  request: IssueEventRequest;
  repo: RepoRow;
  pair: RepositoryWithOwner;
  doer: UserRow;
  form: NewReleaseForm;
  branches: readonly string[];
  origin: string;
}): Promise<NewReleaseResult> {
  const { form, repo, pair, doer, origin } = input;
  if (form.tagName === "") return { outcome: "invalid", message: releasesLocale.tag_name_required };
  if (form.tagName.length > 255) return { outcome: "invalid", message: releasesLocale.tag_name_too_long };
  if (form.title === "") return { outcome: "invalid", message: releasesLocale.title_required };
  if (form.title.length > 255) return { outcome: "invalid", message: releasesLocale.title_too_long };
  // Upstream: `form.Target = util.IfZero(form.Target, DefaultBranch)` then
  // the IsBranchExist check (NewReleasePost).
  const target = form.tagTarget === "" ? repo.defaultBranch : form.tagTarget;
  if (!input.branches.includes(target)) {
    return { outcome: "invalid", message: releasesLocale.target_branch_not_exist };
  }

  let row: ReleaseRow;
  try {
    row = await new IssuesService(input.env.DB).createRelease({
      repoId: repo.id,
      publisherId: doer.id,
      tagName: form.tagName,
      target,
      title: form.title,
      note: form.content,
      isDraft: form.draft,
      isPrerelease: form.prerelease,
    });
  } catch (error) {
    if (error instanceof ReleaseAlreadyExistError) {
      return { outcome: "invalid", message: releasesLocale.tag_already_exist };
    }
    return { outcome: "invalid", message: error instanceof Error ? error.message : "release create failed" };
  }

  // The `release` webhook (NewRelease, release.go:198) — the API POST
  // route's emitReleaseEvent ported onto the shared seam; drafts stay
  // silent, the payload renders through the same converters.
  if (!row.isDraft) {
    try {
      const apiViewer = { origin, requester: apiUserFromRow(doer, { origin, requester: null }) };
      const rendered = await toApiRelease(input.env.DB, apiViewer, pair, row);
      await emitIssueEvent(input.request, {
        repoId: repo.id,
        ownerId: repo.ownerId,
        eventType: "release",
        payload: {
          action: "published",
          release: rendered,
          repository: toApiRepository(apiViewer, pair),
          sender: apiUserFromRow(doer, apiViewer),
        },
      });
    } catch (error) {
      // Best-effort, the compare write's posture — never fail the write.
      console.error(`[releases] webhook fan-out failed (published): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { outcome: "created", tag: row.tagName };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The releases header (release_tag_header.tmpl's `.flex-left-right`):
 *  the counts menu (reduced to the single live item — the module header's
 *  Tags/RSS note) and the New Release button (CanCreateRelease's write &&
 *  !archived). */
function ReleasesHeader(props: {
  basePath: string;
  total: number;
  canCreate: boolean;
  newHref: string | null;
  /** Wave 25's additive Tags item (release_tag_header.tmpl's second menu
   *  entry — `{{if $canReadCode}}`, the landed tags page
   *  pages/tags.tsx): rendered only by the LIST page, where the loader's
   *  `numTags` is already in hand (the DETAIL page keeps the wave-20
   *  single-item menu — no listRefs just for a menu label, the same cost
   *  note that landed the reduction). Upstream keeps Releases ACTIVE on
   *  the list (`PageIsReleaseList`) and hands active to Tags only on the
   *  tags page itself — the plain item here. */
  tags?: { href: string; count: number };
}) {
  return (
    <div class="flex-left-right">
      <h2 class="ui compact small menu small-menu-items">
        <a class="active item" href={props.basePath}>
          {prettyNumber(props.total)} {props.total === 1 ? releasesLocale.release : releasesLocale.page_title}
        </a>
        {props.tags !== undefined ? (
          <a class="item" href={props.tags.href}>
            {prettyNumber(props.tags.count)} {props.tags.count === 1 ? releasesLocale.tag : releasesLocale.tags_label}
          </a>
        ) : null}
      </h2>
      {props.canCreate && props.newHref !== null ? (
        <div class="flex-text-block">
          <a class="ui small primary button" href={props.newHref}>
            {releasesLocale.new_release}
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** The release/label.tmpl label stack (IsLatest → Draft → Pre-Release →
 *  Stable, the template's if/else-if order). */
export function ReleaseLabel(props: { entry: ReleaseEntry }) {
  const { row, isLatest } = props.entry;
  if (isLatest) return <span class="ui green label">{releasesLocale.latest}</span>;
  if (row.isDraft) return <span class="ui yellow label">{releasesLocale.draft}</span>;
  if (row.isPrerelease) return <span class="ui orange label">{releasesLocale.prerelease}</span>;
  return <span class="ui green label">{releasesLocale.stable}</span>;
}

/** One attachment row (list.tmpl:82-94 — the landed asset URLs; the serving
 *  route is the survey's separate row, the module header's note). */
function ReleaseAssetItem(props: { asset: ReleaseAssetView }) {
  const { asset } = props;
  const createdAt = asset.row.createdAt;
  return (
    <li class="item">
      <a target="_blank" class="tw-flex-1 gt-ellipsis" rel="nofollow" download href={asset.downloadUrl}>
        <strong class="flex-text-inline">
          <Icon name="octicon-package" size={16} class="download-icon" />
          <span class="gt-ellipsis">{asset.row.name}</span>
        </strong>
      </a>
      <div class="attachment-right-info flex-text-inline">
        <span class="tw-pl-5">{asset.sizeText}</span>
        <span class="flex-text-inline" data-tooltip-content={`${releasesLocale.download_count}: ${prettyNumber(asset.row.downloadCount)}`}>
          <Icon name="octicon-info" />
        </span>
        <div class="tw-flex-1" />
        {createdAt !== null && createdAt !== undefined ? (
          <TimeSince unixSeconds={Math.floor(createdAt.getTime() / 1000)} tz="+0000" />
        ) : null}
      </div>
    </li>
  );
}

/** One `.release-entry` row of list.tmpl (reductions in the module header).
 *  `firstOpen`: the `<details class="download">` opens for the first entry
 *  of the page render (`{{if eq $idx 0}}open{{end}}`). */
export function ReleaseEntryItem(props: { entry: ReleaseEntry; repoLink: string; firstOpen: boolean }) {
  const { entry, repoLink } = props;
  const { row } = entry;
  const escapedTag = pathEscapeSegments(row.tagName);
  return (
    <li class="release-entry">
      <div class="meta">
        {entry.tagOid !== null ? (
          <a class="muted" href={`${repoLink}/src/tag/${escapedTag}`} rel="nofollow">
            <Icon name="octicon-tag" size={16} class="tw-mr-1" />
            {row.tagName}
          </a>
        ) : (
          <span class="muted">
            <Icon name="octicon-tag" size={16} class="tw-mr-1" />
            {row.tagName}
          </span>
        )}
        {entry.tagOid !== null ? (
          <a class="muted tw-font-mono" href={`${repoLink}/src/commit/${entry.tagOid}`} rel="nofollow">
            <Icon name="octicon-git-commit" size={16} class="tw-mr-1" />
            {shortSha(entry.tagOid)}
          </a>
        ) : null}
      </div>
      <div class="ui segment detail">
        <div class="flex-left-right tw-mb-2">
          {/* upstream renders h4.release-list-title under the header menu's
              h2 — an upward heading skip the §5.5 R2 rule refuses; the tag
              drops one level (the class hooks the official bundle targets
              are unchanged, the commit-list scope=col precedent of additive
              a11y deviations). */}
          <h3 class="release-list-title tw-break-anywhere">
            <a class="muted" href={`${repoLink}/releases/tag/${escapedTag}`}>
              {releaseTitleOf(entry)}
            </a>
            <ReleaseLabel entry={entry} />
          </h3>
          <div>{/* the edit pencil — no /releases/edit surface (module header) */}</div>
        </div>
        <p class="tw-text-text-light">
          <span class="author">
            {entry.publisherName !== null ? (
              <a href={userLink(entry.publisherName)}>{entry.publisherName}</a>
            ) : (
              "Ghost"
            )}
          </span>
          {!row.isDraft ? (
            <>
              <span class="released">{releasesLocale.released_this}</span>
              <span class="time">
                <TimeSince unixSeconds={row.publishedUnix} tz="+0000" />
              </span>
            </>
          ) : null}
        </p>
        <div class="render-content markup" dangerouslySetInnerHTML={{ __html: entry.noteHtml }} />
        <div class="divider" />
        <details class="download" open={props.firstOpen ? true : undefined}>
          <summary>{releasesLocale.downloads}</summary>
          <ul class="ui divided list attachment-list">
            {entry.assets.map((asset) => (
              <ReleaseAssetItem asset={asset} />
            ))}
          </ul>
        </details>
      </div>
    </li>
  );
}

/** The Older/Newer pagination — the list pages' DOM shape
 * (div.center.page.buttons), driven by `page * size < total`. */
function ReleasesPagination(props: { basePath: string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={props.page <= 2 ? props.basePath : `${props.basePath}?page=${props.page - 1}`}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={`${props.basePath}?page=${props.page + 1}`}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderReleasesPage(ctx: UiContext, data: ReleasesData): string {
  return renderPage(<ReleasesPage ctx={ctx} data={data} />);
}

/** The releases list page (§2.4.1 discriminator: `repository releases`),
 *  activeTab="releases". */
export function ReleasesPage(props: { ctx: UiContext; data: ReleasesData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("ReleasesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={releasesLocale.page_title} pageClass="repository releases" activeTab="releases">
      <div class="ui container">
        <ReleasesHeader
          basePath={`${repoLink}/releases`}
          total={data.total}
          canCreate={data.canCreate}
          newHref={data.canCreate && !repo.isArchived ? `${repoLink}/releases/new` : null}
          tags={{ href: `${repoLink}/tags`, count: data.numTags }}
        />
        <div class="divider" />
        <ul id="release-list">
          {data.items.map((entry, index) => (
            <ReleaseEntryItem entry={entry} repoLink={repoLink} firstOpen={index === 0} />
          ))}
        </ul>
        <ReleasesPagination basePath={`${repoLink}/releases`} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

/** The release detail page — upstream SingleRelease renders the SAME list
 *  template over one row (release.go:327 tplReleasesList); the title is the
 *  release's (or the tag's), the header menu shows the repo's totals. */
export function renderReleaseDetailPage(options: { ctx: UiContext; entry: ReleaseEntry; total: number }): string {
  const { ctx, entry, total } = options;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("renderReleaseDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return renderPage(
    <BaseLayout ctx={ctx} title={releaseTitleOf(entry)} pageClass="repository releases" activeTab="releases">
      <div class="ui container">
        {/* SingleRelease renders the same template without the create
            button's page state — the button is the list's CanCreate arm; the
            detail page keeps the header menu + the single entry. */}
        <ReleasesHeader basePath={`${repoLink}/releases`} total={total} canCreate={false} newHref={null} />
        <div class="divider" />
        <ul id="release-list">
          <ReleaseEntryItem entry={entry} repoLink={repoLink} firstOpen={true} />
        </ul>
      </div>
    </BaseLayout>,
  );
}

// ---------------------------------------------------------------------------
// The new-release form (GET/POST /releases/new)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderNewReleasePage(options: {
  ctx: UiContext;
  data: NewReleaseData;
  form: NewReleaseForm;
  error: string | null;
}): string {
  return renderPage(<NewReleasePage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />);
}

/** The create form (§2.4.1 discriminator: `repository new release`),
 *  new.tmpl reduced per the module header (the JS dropdown → the native
 *  select, the submit-button pair → the draft checkbox + one Publish
 *  button, the combo editor → the plain textarea). */
export function NewReleasePage(props: { ctx: UiContext; data: NewReleaseData; form: NewReleaseForm; error: string | null }) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("NewReleasePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const target = form.tagTarget === "" ? data.defaultBranch : form.tagTarget;
  return (
    <BaseLayout ctx={ctx} title={releasesLocale.new_release} pageClass="repository new release" activeTab="releases">
      <div class="ui container">
        <h2 class="ui dividing header">
          {releasesLocale.new_release}
          <div class="sub header">{releasesLocale.new_subheader}</div>
        </h2>
        <form class="ui form" action={`${repoLink}/releases/new`} method="post" id="new-release">
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="inline field">
            <label class="tw-block tw-mb-1" for="release-tag-name">
              <b>{releasesLocale.git_tag}</b>
            </label>
            <div class="flex-text-block tw-flex-wrap">
              <input
                id="release-tag-name"
                type="text"
                class="tw-w-auto"
                name="tag_name"
                value={form.tagName}
                aria-label={releasesLocale.tag_name}
                placeholder={releasesLocale.tag_name}
                required
                maxlength={255}
                autocomplete="off"
              />
              <span>@</span>
              <div class="tag-target-selector tw-contents">
                <label class="tw-sr-only" for="release-tag-target">
                  {releasesLocale.target}
                </label>
                <select id="release-tag-target" name="tag_target" class="ui selection dropdown">
                  {data.branches.map((name) => (
                    <option value={name} selected={name === target}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div class="field">
            <label for="release-title">{releasesLocale.title}</label>
            <input
              id="release-title"
              name="title"
              placeholder={releasesLocale.title}
              value={form.title}
              maxlength={255}
              autocomplete="off"
            />
          </div>
          <div class="field">
            <label for="release-content">{releasesLocale.notes}</label>
            <textarea id="release-content" name="content" rows={5} placeholder={releasesLocale.message_placeholder}>
              {form.content}
            </textarea>
          </div>
          <div class="field">
            <div class="ui checkbox">
              <input type="checkbox" name="draft" id="release-draft" checked={form.draft ? true : undefined} />
              <label for="release-draft">
                <strong>{releasesLocale.save_draft}</strong>
              </label>
            </div>
          </div>
          <div class="field">
            <div class="ui checkbox">
              <input type="checkbox" name="prerelease" id="release-prerelease" checked={form.prerelease ? true : undefined} />
              <label for="release-prerelease">
                <strong>{releasesLocale.prerelease_desc}</strong>
              </label>
            </div>
            <div class="help tw-block tw-ml-[21px]">{releasesLocale.prerelease_helper}</div>
          </div>
          <div class="flex-text-block tw-justify-end">
            <button type="submit" class="ui small primary button">
              {releasesLocale.publish}
            </button>
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The /releases/latest redirect arm (upstream LatestRelease)
// ---------------------------------------------------------------------------

/**
 * The redirect target of `GET /releases/latest` (upstream
 * `ctx.Redirect(release.Link())` — Release.Link() is the HTMLURL shape
 * `{repo}/releases/tag/{tag}`, models/repo/release.go:130-155). `null` when
 * no stable release exists (the caller 404-shells — upstream NotFound).
 */
export async function latestReleaseTagOf(d1: D1Database, repoId: string): Promise<string | null> {
  const row = await findLatestRelease(d1, repoId);
  return row === null ? null : row.tagName;
}
