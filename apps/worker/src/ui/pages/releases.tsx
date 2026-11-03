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
 *   GET  /{owner}/{repo}/releases/edit/{tag} the edit form (wave 33 — the
 *                                            survey's top-5 #4; upstream
 *                                            `repo.EditRelease`,
 *                                            web.go:1519 — the SAME new.tmpl
 *                                            under PageIsEditRelease,
 *                                            writer-gated)
 *   POST /{owner}/{repo}/releases/edit/{tag} the edit write (upstream
 *                                            `repo.EditReleasePost`,
 *                                            web.go:1520) → 303 onto the list
 *   POST /{owner}/{repo}/releases/delete     the delete write (upstream
 *                                            `repo.DeleteRelease`,
 *                                            web.go:1523 — the edit page's
 *                                            red button) → 303 onto the list
 *   POST /{owner}/{repo}/releases/{id}/reactions/{action}
 *                                            the reaction toggle (R16(f) —
 *                                            upstream `ChangeReleaseReaction`,
 *                                            web.go:1515; the handler lives in
 *                                            pages/release-reaction-writes.ts
 *                                            beside its index.ts mount recipe,
 *                                            the issue family's fold pattern)
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
 * detail rides `findReleaseByTag` with the SingleRelease rules (R12: the
 * lookup includes tag-only records and renders them as the PageIsSingleTag
 * page; drafts stay write-gated — `assertDraftVisible`'s posture); assets
 * ride `listReleaseAssets` + `toApiAttachment` (the landed asset URLs, the
 * R13 unique-name flip included); notes render through the shared
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
 * - The release_tag_header menu's Tags item (`{RepoLink}/tags`) renders on
 *   the LIST page (wave 25, when the tags list page landed — the finding F9
 *   tab) and, since the git-e2e F9 fix, on the DETAIL page too: upstream
 *   renders release_tag_header on EVERY tplReleasesList render (SingleRelease
 *   included — release.go:335 `ctx.HTML(http.StatusOK, tplReleasesList)`),
 *   with the Tags item ACTIVE on the tags page AND the single-tag render
 *   (`{{if or .PageIsTagList .PageIsSingleTag}}active{{end}}`). Since R2/R12
 *   (the v1.5.2 wave) a deleted release CONVERTS to an is_tag record and the
 *   detail page renders it as the SingleTag page — Tags goes active there
 *   (releasesLocale's count is the engine refs/tags universe, the
 *   ReleasesData.numTags note upstream counts releases-table tag records).
 *   The RSS button stays unrendered — the feed family is the repo header's
 *   links (wave-2e), not this header's button surface.
 * - The tab strip's Releases count label (`{{if .NumReleases}}` — computed
 *   per repo page upstream, services/context/repo.go:634) is unrendered:
 *   D1 keeps no maintained num_releases counter and the shared shell would
 *   pay a COUNT on every repo-scoped render for a label most repos never
 *   show. The releases PAGES render the real count in the header menu.
 * - The row edit pencil (`/releases/edit/{tag}`) is the wave-33 tail (the
 *   survey's top-5 #4): the list renders it for `CanCreateRelease` viewers
 *   (list.tmpl's `{{if and $.CanCreateRelease (not $.PageIsSingleTag)}}` —
 *   the DETAIL page is SingleRelease's PageIsSingleTag render, where the
 *   pencil never shows upstream either). The REACTIONS block is LANDED
 *   (R16(f), list.tmpl:110-115's shared/reactions arm:
 *   the bar on every non-tag non-draft row, the write arm the
 *   release-reaction-writes.ts module + its mount recipe). The compare
 *   branch dropdown, commit statuses and the ahead/behind line stay
 *   unrendered — no landed surfaces (the upstream ahead line
 *   itself never renders while `num_commits` stays 0 at the engine
 *   boundary). The `add_tag_msg` checkbox, the tag-only button and the
 *   generate-notes button target engine tag creation / the
 *   generate-notes POST — none landed (dead-link rule).
 * - The edit page is new.tmpl under `PageIsEditRelease` (upstream renders
 *   ONE template for both): the tag field collapses to hidden inputs +
 *   the `{tag} @ {target}` text (new.tmpl:25-28), the heading swaps to
 *   `edit_release`/`edit_subheader`, the Cancel link and the red Delete
 *   Release button join the submit row (new.tmpl:104-118) — the delete
 *   rides `POST /releases/delete?id=` as a plain form POST (upstream's
 *   link-action + confirm modal is the documented no-JS reduction, the
 *   wave-4 hooks-list posture), and the draft checkbox carries the draft
 *   state exactly like the create form (upstream EditReleasePost's
 *   `len(form.Draft) > 0` reads the same checkbox). The edit write sets
 *   Title/Note UNCONDITIONALLY (EditReleasePost's plain assignments — an
 *   emptied note clears, unlike the API PATCH's non-empty guards) and
 *   never touches the tag pair (the hidden inputs upstream ignores) — but
 *   the WRITE runs upstream's createTag re-run (release.go:269): publishing
 *   a draft whose git tag is missing lands `refs/tags/<tag>` at the stored
 *   target and fills sha1/created/num_commits (editReleaseFromForm's doc).
 * - Source-archive rows in the downloads block (`/archive/{tag}.zip|tar.gz`)
 *   render since the P2-7 remaining-S wave (release/list.tmpl:78-89 — the
 *   non-draft gate; the wave-32 web-shape archive route the old reduction
 *   called missing is LANDED, so the premise was stale); the attachment
 *   rows render the landed `browser_download_url` — the R13 flip (the v1.5.2
 *   wave): the unique-name `/releases/download/{tag}/{name}` when a
 *   release's asset names are unique, the uuid `/attachments/{uuid}` shape
 *   on duplicates, exactly upstream's DownloadURL.
 *   The uuid arm's serving route is the survey's separate S row
 *   (`/releases/attachments/{uuid}`).
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
import { ALLOWED_RELEASE_REACTIONS, listReleaseReactions } from "../../api/services/release-reactions";
import {
  createReleaseWithGitTag,
  deleteRelease,
  editRelease,
  findLatestRelease,
  findReleaseByTag,
  findReleaseByTagExact,
  findReleaseForRepoById,
  listReleases,
  pathEscapeSegments,
  toApiRelease,
  uniqueNameDownloadUrlBuilder,
} from "../../api/services/releases";
import type { ReleaseReactionRow } from "../../api/services/release-reactions";
import { engineReads } from "../../api/services/engine";
import {
  apiUserFromRow,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";import { ReleaseAlreadyExistError } from "../../issues/errors";
import { type ReleaseRow } from "../../issues/service";
import { emitIssueEvent, type IssueEventRequest } from "../../services/issue-events";
import { users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { REACTION_EMOJI, groupReactions, renderIssueMarkdown, type ReactionGroup } from "./issue-detail";
import { parseFormBool } from "./notifications";
import { formatByteSize, parsePageNumber, shortSha } from "../page-data";
import { userLink } from "../links";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

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
  source_code: "Source Code", // "repo.release.source_code" (the archive rows' label)
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
  /** Wave-33 edit/delete chrome (the upstream locale keys cited). */
  edit_release: "Update Release", // "repo.release.edit_release"
  edit_subheader: "Releases organize project versions.", // "repo.release.edit_subheader"
  edit_tooltip: "Edit", // "repo.release.edit" (the list pencil's tooltip)
  cancel: "Cancel", // "repo.release.cancel"
  delete_release: "Delete Release", // "repo.release.delete_release"
  /** "repo.release.deletion_success" — the ?deleted= flash (the tags page's
   *  query-param convention). */
  deletion_success: "The release has been deleted.",
  /** R16(f): "repo.reactions" — the reaction bar's aria-label. */
  reactions: "Reactions",
  /** cf-gitea addition (the branches page's server-side flash posture —
   *  upstream's failure flash is the raw "DeleteReleaseByID: {err}" text). */
  deletion_failed(name: string): string {
    return `Deleting the release ${name} failed.`;
  },
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
  /** The in-git tag count (upstream NumTags — release_tag_header.tmpl's
   *  second menu item renders it on the SINGLE-release render too:
   *  SingleRelease answers the SAME list template, release.go:335). Set by
   *  the DETAIL loader only — the tag universe is already in hand there, so
   *  the count is free; the LIST carries it on ReleasesData.numTags instead
   *  and leaves this undefined (enrichEntries never sets it). */
  numTags?: number;
  /** R16(f): the row's reaction groups (list.tmpl:110-115's
   *  `$info.Reactions.GroupByType` — upstream getReleaseInfos' single
   *  FindReleaseReactions over the page's release ids, grouped per row).
   *  The allowed-set filter rode the READ (api/services/release-reactions.ts
   *  listReleaseReactions), so every group here is renderable. */
  reactions: ReactionGroup[];
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
  // R16(f): one batched reactions read (upstream getReleaseInfos' single
  // FindReleaseReactions over the page's release ids, release.go:96) then
  // the rows-by-release map (that function's reactionsByRelease) and
  // GroupByType per row — the render re-orders the groups by type at the
  // bar (Go map-key order, reactions.tmpl:14; see ReleaseReactionBar), the
  // rows themselves in the created_unix,id read order.
  const foundReactions = await listReleaseReactions(
    d1,
    rows.map((row) => row.id),
  );
  const reactionRowsByRelease = new Map<number, ReleaseReactionRow[]>();
  for (const reaction of foundReactions) {
    const list = reactionRowsByRelease.get(reaction.releaseId);
    if (list === undefined) reactionRowsByRelease.set(reaction.releaseId, [reaction]);
    else list.push(reaction);
  }
  const reactionsByRelease = new Map<number, ReactionGroup[]>(
    [...reactionRowsByRelease].map(([releaseId, reactionRows]) => [releaseId, groupReactions(reactionRows)]),
  );
  return Promise.all(
    rows.map(async (row): Promise<ReleaseEntry> => {
      const assetRows = await listReleaseAssets(d1, row.id);
      // The R13 flip rides the UI rows too (list.tmpl renders
      // `$att.DownloadURL` — upstream's DownloadURL carries the same
      // unique-name CustomDownloadURL; uniqueNameDownloadUrlBuilder returns
      // undefined on duplicate names and the uuid shape stands in).
      const downloadUrl = uniqueNameDownloadUrlBuilder(origin, repo, row.tagName, assetRows);
      const assets = assetRows.map((assetRow): ReleaseAssetView => {
        return {
          row: assetRow,
          downloadUrl: toApiAttachment(origin, assetRow, downloadUrl?.(assetRow.name)).browser_download_url ?? "",
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
        reactions: reactionsByRelease.get(row.id) ?? [],
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
 * Load one release by tag with the upstream SingleRelease rules (R12 —
 * routers/web/repo/release.go:303-339): the release-table lookup INCLUDES
 * tag-only records (`IncludeTags: true`), drafts stay write-gated
 * (`IncludeDrafts: writeAccess`), a miss 404s, and a tag-only record renders
 * the SingleTag page (PageIsSingleTag — the same list template, the title
 * falling back to the tag name, release.go:331-334). The lookup is the
 * CASE-SENSITIVE raw `tag_name IN (tag)` arm (release.go:296-308's
 * TagNames → models/repo/release.go:282-284 — findReleaseByTagExact, NOT
 * the lowered GetRelease pair; a `/releases/tag/V1.0` URL over a `v1.0`
 * row 404s upstream and here too, while the edit form's GetRelease lookup
 * stays lowered). Before the R2 conversion landed this row never existed in
 * our tree, so the loader's old `isTag → null` arm was the documented
 * corollary; now a deleted release leaves its record behind and the tag
 * page must render it exactly like upstream's.
 */
export async function loadReleaseDetailData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  tag: string,
  canWrite: boolean,
  origin: string,
): Promise<ReleaseEntry | null> {
  const row = await findReleaseByTagExact(d1, repo.id, tag);
  if (row === null) return null;
  if (row.isDraft && !canWrite) return null;
  const [latest, tags] = await Promise.all([findLatestRelease(d1, repo.id), tagTipsOf(env, repo)]);
  const [entry] = await enrichEntries(env, d1, repo, [row], latest?.id ?? -1, origin, tags);
  if (entry === undefined) return null;
  // The header menu's Tags count (F9): upstream's SingleRelease render carries
  // release_tag_header's two-item menu, and the tag universe is already in
  // hand here — the count rides the entry for renderReleaseDetailPage.
  return { ...entry, numTags: tags.size };
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
    // The N2 wave: the WEB create arm rides createReleaseWithGitTag too —
    // a fresh tag_name lands its git tag before the row (upstream's
    // NewReleasePost → release_service.CreateRelease → createTag; the form
    // pre-checks the target branch above, so the wrapper's 404 arm is the
    // unreachable guard, and its 422 protected-tag answer maps onto the
    // form's invalid outcome like the API's).
    const created = await createReleaseWithGitTag({
      env: input.env,
      d1: input.env.DB,
      pair,
      publisherId: doer.id,
      doer: { id: doer.id, login: doer.username, email: doer.email },
      requestHost: new URL(origin).host,
      tagName: form.tagName,
      targetCommitish: target,
      tagMessage: undefined,
      title: form.title,
      note: form.content,
      isDraft: form.draft,
      isPrerelease: form.prerelease,
    });
    row = created.row;
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
// The edit form + write (GET/POST /releases/edit/{tag}) and the delete write
// (POST /releases/delete) — wave 33, the survey's top-5 #4
// ---------------------------------------------------------------------------

/** The parsed edit-release submission (upstream EditReleaseForm's fields —
 *  services/forms/repo_form.go:557-564: title/content/draft/prerelease; the
 *  hidden tag pair arrives but the handler ignores it). */
export interface EditReleaseForm {
  title: string;
  content: string;
  draft: boolean;
  prerelease: boolean;
}

export function parseEditReleaseForm(params: URLSearchParams): EditReleaseForm {
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    draft: parseFormBool(params.get("draft")),
    prerelease: parseFormBool(params.get("prerelease")),
  };
}

/**
 * Load the edit form (upstream EditRelease, release.go:557-597): the
 * release row by the URL's tag, 404 arms first (a missing row —
 * GetRelease's IsErrReleaseNotExist; a TAG-ONLY record — "for a pure tag
 * release, don't allow to edit it as a release", release.go:573-576), then
 * the stored values as the form's prefill (`tag_target` falls back to the
 * default branch, release.go:583's util.IfZero). The write gate (upstream's
 * reqSignIn + RepoMustNotBeArchived + reqRepoReleaseWriter group) is the
 * handler's releasesWriteGate.
 */
export async function loadEditReleaseData(d1: D1Database, repoId: string, tag: string): Promise<ReleaseRow | null> {
  const row = await findReleaseByTag(d1, repoId, tag);
  if (row === null || row.isTag) return null;
  return row;
}

export type EditReleaseResult =
  | { outcome: "updated"; tag: string }
  | { outcome: "invalid"; message: string };

/**
 * The write (upstream EditReleasePost, release.go:599-655, over the LANDED
 * edit arm): the title guards (the binding's TrimSpace;Required;MaxSize(255)
 * — the create form's carried server-side mirror), then `editRelease` with
 * Title/Note set UNCONDITIONALLY (the web form's plain assignments — an
 * emptied note clears, the API PATCH's non-empty guards are its own
 * semantics) and the flags from the checkboxes, then the `release` webhook
 * through the shared emit seam — drafts stay silent (routes/releases.ts
 * emitReleaseEvent's gate), the action follows upstream's notifier fork
 * (release.go:361-367): an edit that CREATED the tag (isTagCreated — the
 * publish-from-draft whose git tag was missing) maps to "published", every
 * other published edit to "updated" (the fixture tag already in git rides).
 * The hidden tag pair the form carries stays ignored (upstream's handler
 * never reads it) — the tag arm works from the STORED row: publishing a
 * draft whose tag doesn't exist lands refs/tags/<tag> at the stored target
 * through the same createTag re-run the API PATCH runs. The created tag's
 * ref-webhook pair (PushCommits + CreateRef) stays the API route's emission —
 * the landed web create write carries the same reduction. Failures answer
 * `invalid` with the message (upstream JSONErrorAuto's message render — an
 * untaggable publish, protected tag included, is a 500 there, context.go:
 * 257-274; the re-render convention keeps the form).
 */
export async function editReleaseFromForm(input: {
  env: Env;
  /** The request the webhook emission reads (the executionCtx-guarded
   *  Queue probe — the shared seam's shape; both routers' Contexts fit). */
  request: IssueEventRequest;
  repo: RepoRow;
  pair: RepositoryWithOwner;
  doer: UserRow;
  row: ReleaseRow;
  form: EditReleaseForm;
  origin: string;
}): Promise<EditReleaseResult> {
  const { form, row } = input;
  if (form.title === "") return { outcome: "invalid", message: releasesLocale.title_required };
  if (form.title.length > 255) return { outcome: "invalid", message: releasesLocale.title_too_long };
  let updated: { row: ReleaseRow | null; tagCreated: boolean };
  try {
    updated = await editRelease({
      env: input.env,
      d1: input.env.DB,
      pair: input.pair,
      doer: { id: input.doer.id, login: input.doer.username, email: input.doer.email },
      requestHost: new URL(input.origin).host,
      row,
      patch: {
        title: form.title,
        note: form.content,
        isDraft: form.draft,
        isPrerelease: form.prerelease,
        now: new Date(),
      },
    });
  } catch (error) {
    return { outcome: "invalid", message: error instanceof Error ? error.message : "release edit failed" };
  }
  if (updated.row === null) {
    // Lost a concurrent delete — the upstream UpdateRelease would surface as
    // an internal error; the API route's re-read keeps the answer honest
    // (here: the edit simply failed, the kept form re-renders).
    return { outcome: "invalid", message: "the release was deleted by someone else" };
  }
  // The `release` webhook (the API PATCH route's action mapping) — drafts
  // silent, best-effort (the create write's posture).
  if (!updated.row.isDraft) {
    try {
      const apiViewer = { origin: input.origin, requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }) };
      const rendered = await toApiRelease(input.env.DB, apiViewer, input.pair, updated.row);
      await emitIssueEvent(input.request, {
        repoId: input.repo.id,
        ownerId: input.repo.ownerId,
        eventType: "release",
        payload: {
          action: updated.tagCreated ? "published" : "updated",
          release: rendered,
          repository: toApiRepository(apiViewer, input.pair),
          sender: apiUserFromRow(input.doer, apiViewer),
        },
      });
    } catch (error) {
      console.error(`[releases] webhook fan-out failed (updated): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { outcome: "updated", tag: updated.row.tagName };
}

export type DeleteReleaseResult =
  | { outcome: "deleted"; name: string }
  | { outcome: "missing"; name: string };

/**
 * The delete write (upstream DeleteRelease → deleteReleaseOrTag(isDelTag
 * =false), release.go:656-706): the row lookup by the form's `id`
 * (GetReleaseForRepoByID — a miss 404s), then `deleteRelease` — the R2
 * conversion: the row flips to `is_tag = true` (a re-create keeps the id,
 * the tags-API delete finds the record), the asset rows + R2 objects +
 * reactions are swept (R4), the git tag is untouched — then the
 * `release` "deleted" webhook through the shared emit seam with the
 * PRE-wipe assets (upstream's DeleteReleaseByID loads Attachments before
 * DeleteAttachmentsByRelease, release.go:418-424), drafts silent (upstream
 * `if !rel.IsDraft` + the API DELETE route's exact emit).
 */
export async function deleteReleaseFromForm(input: {
  env: Env;
  request: IssueEventRequest;
  repo: RepoRow;
  pair: RepositoryWithOwner;
  doer: UserRow;
  id: number;
  origin: string;
}): Promise<DeleteReleaseResult> {
  const row = await findReleaseForRepoById(input.env.DB, input.repo.id, input.id);
  if (row === null) return { outcome: "missing", name: `#${input.id}` };
  const { assets } = await deleteRelease(input.env, input.env.DB, row);
  if (!row.isDraft) {
    try {
      const apiViewer = { origin: input.origin, requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }) };
      const rendered = await toApiRelease(input.env.DB, apiViewer, input.pair, row, assets);
      await emitIssueEvent(input.request, {
        repoId: input.repo.id,
        ownerId: input.repo.ownerId,
        eventType: "release",
        payload: {
          action: "deleted",
          release: rendered,
          repository: toApiRepository(apiViewer, input.pair),
          sender: apiUserFromRow(input.doer, apiViewer),
        },
      });
    } catch (error) {
      console.error(`[releases] webhook fan-out failed (deleted): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { outcome: "deleted", name: row.title !== "" ? row.title : row.tagName };
}

/** Parse the delete POST (the hidden `id` field — FormInt64's all-digit
 *  carrier; junk/zero answers the row lookup's 404 arm). */
export function parseReleaseDeleteForm(params: URLSearchParams): number | null {
  const raw = (params.get("id") ?? "").trim();
  return /^\d+$/.test(raw) && raw !== "0" ? Number.parseInt(raw, 10) : null;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The releases header (release_tag_header.tmpl's `.flex-left-right`):
 *  the counts menu (the Releases item plus the Tags item — F9's tab; the
 *  module header's note) and the New Release button (CanCreateRelease's
 *  write && !archived). */
function ReleasesHeader(props: {
  basePath: string;
  total: number;
  canCreate: boolean;
  newHref: string | null;
  /** release_tag_header.tmpl's second menu entry — `{N} Tags` onto
   *  `{RepoLink}/tags` (`{{if $canReadCode}}`, the landed tags page
   *  pages/tags.tsx). Rendered by the LIST page (the loader's `numTags`) and
   *  by the DETAIL page (the entry's `numTags` — SingleRelease renders the
   *  same header). Upstream keeps Releases ACTIVE on the list and on the
   *  real-release detail (`PageIsReleaseList && !PageIsSingleTag`) and hands
   *  active to Tags on the tags page AND the single-tag render
   *  (`{{if or .PageIsTagList .PageIsSingleTag}}active{{end}}` — R12). */
  tags?: { href: string; count: number };
  /** The single-tag render's active swap (R12): Tags active, Releases
   *  plain — release_tag_header.tmpl's `or PageIsTagList PageIsSingleTag`. */
  tagsActive?: boolean;
}) {
  return (
    <div class="flex-left-right">
      <h2 class="ui compact small menu small-menu-items">
        <a class={props.tagsActive === true ? "item" : "active item"} href={props.basePath}>
          {prettyNumber(props.total)} {props.total === 1 ? releasesLocale.release : releasesLocale.page_title}
        </a>
        {props.tags !== undefined ? (
          <a class={props.tagsActive === true ? "active item" : "item"} href={props.tags.href}>
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

/** R16(f): the shared/reactions.tmpl bar reduced to no-JS forms over the
 *  RELEASE set (the issue surface's twin — pages/issue-detail.tsx's
 *  ReactionBar — bakes ITS module's ALLOWED_REACTIONS into the picker, and
 *  that file is not this unit's; this local render iterates the release
 *  set instead, upstream passes AllowedReactions per surface to the SAME
 *  partial). Template shape verbatim: the bar renders when there are
 *  reactions OR the viewer can react (`{{if or .Reactions $canReact}}`);
 *  `$canReact = and $allowedReactions IsSigned (not IsArchived)` — the
 *  picker is the disclosure block of react forms, each grouped label is a
 *  toggle form POSTing `{actionUrl}/{unreact|react}` with the hidden
 *  `content`, anonymous visitors get bare labels. The tooltip reduces to
 *  `type: count` (the issue twin's carried reduction — the reacting-user
 *  names need the LoadUsers join upstream renders via GetFirstUsers). */
export function ReleaseReactionBar(props: { actionUrl: string; groups: ReactionGroup[]; viewer: Viewer; canReact: boolean }) {
  if (props.groups.length === 0 && !props.canReact) return null;
  const emojiOf = (type: string): string => REACTION_EMOJI[type] ?? `:${type}:`;
  const viewerId = props.viewer.kind === "user" ? props.viewer.id : null;
  // Upstream's group order is Go MAP-KEY order: reactions.tmpl:14 ranges
  // `{{range $key, $value := .Reactions}}` over the GroupByType map (models/
  // issues/reaction.go's map[string]ReactionList) and html/template walks
  // maps in SORTED-KEY order — ALPHABETICAL by type, not the rows'
  // first-appearance order the shared groupReactions preserves (the issue
  // twin keeps insertion order; the release render re-orders here).
  const groups = [...props.groups].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return (
    <div class="bottom-reactions" data-action-url={props.actionUrl} role="group" aria-label={releasesLocale.reactions}>
      {props.canReact ? (
        <details class="select-reaction">
          <summary aria-label={releasesLocale.reactions} title={releasesLocale.reactions}>
            <span aria-hidden="true">🙂</span>
          </summary>
          <div class="reaction-picker">
            {ALLOWED_RELEASE_REACTIONS.map((value) => (
              <form class="item emoji" method="post" action={`${props.actionUrl}/react`}>
                <input type="hidden" name="content" value={value} />
                <button type="submit" aria-label={value} title={value}>
                  {emojiOf(value)}
                </button>
              </form>
            ))}
          </div>
        </details>
      ) : null}
      {groups.map((group) => {
        const reacted = viewerId !== null && group.userIds.includes(viewerId);
        const label = `${group.type}: ${group.count}`;
        return props.canReact ? (
          <form class="ui label basic" method="post" action={`${props.actionUrl}/${reacted ? "unreact" : "react"}`}>
            <input type="hidden" name="content" value={group.type} />
            <button type="submit" class="reaction" aria-label={label} title={label} data-has-reacted={reacted ? "true" : "false"} data-reaction-content={group.type}>
              <span class="reaction">{emojiOf(group.type)}</span> <span>{group.count}</span>
            </button>
          </form>
        ) : (
          <span class="ui label basic disabled" aria-label={label}>
            <span class="reaction">{emojiOf(group.type)}</span> <span>{group.count}</span>
          </span>
        );
      })}
    </div>
  );
}

/** One `.release-entry` row of list.tmpl (reductions in the module header).
 *  `firstOpen`: the `<details class="download">` opens for the first entry
 *  of the page render (`{{if eq $idx 0}}open{{end}}`). `canEdit`: the
 *  wave-33 edit pencil (list.tmpl's `{{if and $.CanCreateRelease
 *  (not $.PageIsSingleTag)}}` — the detail render passes false).
 *  `singleTag`: the PageIsSingleTag render's title arm — the title is PLAIN
 *  text there (no `/releases/tag/` self-link, list.tmpl's
 *  `{{if $.PageIsSingleTag}}` — R12). `viewer`/`repoArchived`: the R16(f)
 *  reaction bar's canReact inputs (shared/reactions.tmpl's IsSigned +
 *  !IsArchived). */
export function ReleaseEntryItem(props: { entry: ReleaseEntry; repoLink: string; firstOpen: boolean; canEdit?: boolean; singleTag?: boolean; viewer?: Viewer; repoArchived?: boolean }) {
  const { entry, repoLink } = props;
  const { row } = entry;
  // The Go-parity util.PathEscapeSegments (api/services/releases — R2-L2):
  // keeps the `/` separators and url.PathEscape's keep-set ($&+:;=@ stay,
  // !'()* encode) — list.tmpl renders $release.HTMLURL, the same escaper.
  const escapedTag = pathEscapeSegments(row.tagName);
  // R16(f): the reaction bar's gates (list.tmpl:110-115's render gate —
  // `not (or $release.IsTag $release.IsDraft)` — and shared/reactions.tmpl's
  // canReact: allowed-set non-empty && signed && !archived; the set is a
  // constant non-empty list here). The POST target is the GLOBAL release id
  // (upstream printf "%s/releases/%d/reactions" $.RepoLink $release.ID).
  const canReact = props.viewer !== undefined && props.viewer.kind === "user" && props.repoArchived !== true;
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
            {props.singleTag === true ? (
              // PageIsSingleTag's title arm (list.tmpl:30 — the plain text,
              // no self-link; R12).
              <span class="muted">{releaseTitleOf(entry)}</span>
            ) : (
              <a class="muted" href={`${repoLink}/releases/tag/${escapedTag}`}>
                {releaseTitleOf(entry)}
              </a>
            )}
            <ReleaseLabel entry={entry} />
          </h3>
          {/* The wave-33 edit pencil (list.tmpl's CanCreateRelease arm —
              the wave-20 reduction's surface now landed): octicon-pencil,
              the "repo.release.edit" tooltip, onto /releases/edit/{tag}. */}
          <div>
            {props.canEdit === true ? (
              <a
                class="muted"
                data-tooltip-content={releasesLocale.edit_tooltip}
                href={`${repoLink}/releases/edit/${escapedTag}`}
                rel="nofollow"
                aria-label={releasesLocale.edit_tooltip}
              >
                <Icon name="octicon-pencil" />
              </a>
            ) : null}
          </div>
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
            {/* The Source-Code archive rows (release/list.tmpl:78-89 at the
                pin): `{{if and (not $.DisableDownloadSourceArchives) (not
                $release.IsDraft) ($.Permission.CanRead TypeCode)}}` — the
                archives setting is default-on at the pin (no landed toggle),
                the code-read half is vacuous on this render (every resolved
                viewer reads code — the unit-gates note), so the gate is the
                draft state. The hrefs are the LANDED web-shape archive
                family (wave-32's /archive/{tag}.zip|.tar.gz GET — the P2-7
                premise that the route was missing is stale; the POST arm
                4e6d1cc mounted too). The tags page's twin reduction
                (pages/tags.tsx) carries the same stale premise and is NOT
                this module's file. */}
            {!row.isDraft ? (
              <>
                <li class="item">
                  <a class="archive-link" download href={`${repoLink}/archive/${escapedTag}.zip`} rel="nofollow">
                    <strong class="flex-text-inline">
                      <Icon name="octicon-file-zip" size={16} class="download-icon" />
                      {releasesLocale.source_code} (ZIP)
                    </strong>
                  </a>
                </li>
                <li class="item">
                  <a class="archive-link" download href={`${repoLink}/archive/${escapedTag}.tar.gz`} rel="nofollow">
                    <strong class="flex-text-inline">
                      <Icon name="octicon-file-zip" size={16} class="download-icon" />
                      {releasesLocale.source_code} (TAR.GZ)
                    </strong>
                  </a>
                </li>
              </>
            ) : null}
          </ul>
        </details>
        {!(row.isTag || row.isDraft) ? (
          <ReleaseReactionBar
            actionUrl={`${repoLink}/releases/${row.id}/reactions`}
            groups={entry.reactions}
            viewer={props.viewer ?? { kind: "anonymous" }}
            canReact={canReact}
          />
        ) : null}
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

/** The full-document render (the render.tsx pattern). `flash` carries the
 *  wave-33 delete write's outcome texts (the branches page's query-param
 *  convention — the handler 303s with `?deleted=`). */
export function renderReleasesPage(ctx: UiContext, data: ReleasesData, flash?: ReleasesFlash): string {
  return renderPage(<ReleasesPage ctx={ctx} data={data} flash={flash} />);
}

/** The delete write's flash inputs (the TagsFlash shape — the query-param
 *  convention; `deleted` carries the deleted release's title-or-tag). */
export interface ReleasesFlash {
  deleted: string | null;
  errorKind: string | null;
  errorName: string;
}

/** The flash block (base/alert's `.ui.positive|.negative.message` arms — the
 *  branches/tags pages' carried DOM). */
export function ReleasesFlashBlock(props: { flash: ReleasesFlash | undefined }) {
  if (props.flash === undefined) return null;
  if (props.flash.deleted !== null) {
    return <div class="ui positive message">{releasesLocale.deletion_success}</div>;
  }
  if (props.flash.errorKind === "failed") {
    return <div class="ui negative message">{releasesLocale.deletion_failed(props.flash.errorName)}</div>;
  }
  return null;
}

/** The releases list page (§2.4.1 discriminator: `repository releases`),
 *  activeTab="releases". */
export function ReleasesPage(props: { ctx: UiContext; data: ReleasesData; flash?: ReleasesFlash }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("ReleasesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const canEdit = data.canCreate && !repo.isArchived;
  return (
    <BaseLayout ctx={ctx} title={releasesLocale.page_title} pageClass="repository releases" activeTab="releases">
      <div class="ui container">
        <ReleasesFlashBlock flash={props.flash} />
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
            <ReleaseEntryItem entry={entry} repoLink={repoLink} firstOpen={index === 0} canEdit={canEdit} viewer={ctx.viewer} repoArchived={repo.isArchived} />
          ))}
        </ul>
        <ReleasesPagination basePath={`${repoLink}/releases`} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

/** The release detail page — upstream SingleRelease renders the SAME list
 *  template over one row (release.go:327 tplReleasesList); the title is the
 *  release's (or the tag's — a tag-only record's title falls back to the
 *  tag name, release.go:331-332, R12), the header menu shows the repo's
 *  totals (F9: the Tags item included — the entry's numTags the detail
 *  loader attaches), and a TAG-ONLY record renders the PageIsSingleTag
 *  shape: the title plain (no self-link), the edit pencil hidden (R12;
 *  the pencil was already detail-absent, now it is contract-explicit), the
 *  Tags menu item active
 *  (`{{if or .PageIsTagList .PageIsSingleTag}}active{{end}}`). */
export function renderReleaseDetailPage(options: { ctx: UiContext; entry: ReleaseEntry; total: number }): string {
  const { ctx, entry, total } = options;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("renderReleaseDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const singleTag = entry.row.isTag;
  return renderPage(
    <BaseLayout ctx={ctx} title={releaseTitleOf(entry)} pageClass="repository releases" activeTab="releases">
      <div class="ui container">
        {/* SingleRelease renders the same template without the create
            button's page state — the button is the list's CanCreate arm; the
            detail page keeps the header menu + the single entry. */}
        <ReleasesHeader
          basePath={`${repoLink}/releases`}
          total={total}
          canCreate={false}
          newHref={null}
          tags={entry.numTags !== undefined ? { href: `${repoLink}/tags`, count: entry.numTags } : undefined}
          tagsActive={singleTag}
        />
        <div class="divider" />
        <ul id="release-list">
          <ReleaseEntryItem entry={entry} repoLink={repoLink} firstOpen={true} canEdit={false} singleTag={singleTag} viewer={ctx.viewer} repoArchived={repo.isArchived} />
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

/** The edit page's fixed-meta inputs (the wave-33 `PageIsEditRelease` arm —
 *  the tag pair the form carries hidden and the delete button's row id). */
export interface EditReleaseMeta {
  tagName: string;
  /** The stored target, default-branch-fallen-back (release.go:583). */
  target: string;
  /** The delete button's `id` carrier (POST /releases/delete). */
  deleteId: number;
}

/** The full-document render for the EDIT arm (upstream renders new.tmpl for
 *  both — the same component with `edit` set). */
export function renderEditReleasePage(options: {
  ctx: UiContext;
  data: NewReleaseData;
  form: NewReleaseForm;
  error: string | null;
  edit: EditReleaseMeta;
}): string {
  return renderPage(
    <NewReleasePage ctx={options.ctx} data={options.data} form={options.form} error={options.error} edit={options.edit} />,
  );
}

/** The create/edit form (§2.4.1 discriminator: `repository new release` —
 *  BOTH arms, new.tmpl is upstream's shared template; the edit branches per
 *  the module header's wave-33 note). */
export function NewReleasePage(props: {
  ctx: UiContext;
  data: NewReleaseData;
  form: NewReleaseForm;
  error: string | null;
  edit?: EditReleaseMeta;
}) {
  const { ctx, data, form } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("NewReleasePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const edit = props.edit;
  const target = form.tagTarget === "" ? data.defaultBranch : form.tagTarget;
  return (
    <BaseLayout ctx={ctx} title={releasesLocale.new_release} pageClass="repository new release" activeTab="releases">
      <div class="ui container">
        <h2 class="ui dividing header">
          {edit !== undefined ? releasesLocale.edit_release : releasesLocale.new_release}
          <div class="sub header">
            {edit !== undefined ? releasesLocale.edit_subheader : releasesLocale.new_subheader}
          </div>
        </h2>
        <form
          class="ui form"
          action={
            edit !== undefined
              ? `${repoLink}/releases/edit/${pathEscapeSegments(edit.tagName)}`
              : `${repoLink}/releases/new`
          }
          method="post"
          id="new-release"
        >
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="inline field">
            <label class="tw-block tw-mb-1" for="release-tag-name">
              <b>{releasesLocale.git_tag}</b>
            </label>
            {edit !== undefined ? (
              // PageIsEditRelease's tag arm (new.tmpl:25-28): the pair goes
              // hidden, the `tag @ target` text renders, no helper.
              <>
                <input type="hidden" name="tag_name" value={edit.tagName} />
                <input type="hidden" name="tag_target" value={edit.target} />
                <span>
                  {edit.tagName} @ {edit.target}
                </span>
              </>
            ) : (
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
            )}
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
            {edit !== undefined ? (
              // PageIsEditRelease's submit row (new.tmpl:104-118): Cancel,
              // the red Delete Release, the single Update submit (the draft
              // checkbox carries the state). Upstream's delete is a
              // link-action (JS POST + confirm modal — the documented no-JS
              // reduction); the plain-HTML answer is a submit button whose
              // formaction/formmethod OVERRIDE the enclosing form onto
              // POST /releases/delete, its name/value pair the `id` carrier
              // (a nested <form> is invalid HTML, so the override rides).
              <>
                <a class="ui small button" href={`${repoLink}/releases`}>
                  {releasesLocale.cancel}
                </a>
                <button
                  type="submit"
                  class="ui small red button"
                  formaction={`${repoLink}/releases/delete`}
                  formmethod="post"
                  name="id"
                  value={edit.deleteId}
                >
                  {releasesLocale.delete_release}
                </button>
                <button type="submit" class="ui small primary button">
                  {releasesLocale.edit_release}
                </button>
              </>
            ) : (
              <button type="submit" class="ui small primary button">
                {releasesLocale.publish}
              </button>
            )}
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
