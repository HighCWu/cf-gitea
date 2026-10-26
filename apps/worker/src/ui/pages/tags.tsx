/**
 * The repository tags page — pages wave 25 (the UI-parity survey's TOP-1
 * dispatchable row, docs/compat/ui-parity-survey.md): the tags listing,
 * `GET /{owner}/{repo}/tags` — upstream's repo tags group
 * (web.go:1493-1500: `m.Get("", context.RepoRefByDefaultBranch(), repo.TagsList)`
 * under the `/tags` group, handlers/web/repo/release.go:227-275 TagsList)
 * over the ENGINE ref universe — the brief's data authority, exactly the
 * landed repoListTags API's read (routes/tags.ts sortedTags: `refs/tags/*`
 * filtered, name-sorted byte order, the peel cache distinguishing annotated
 * from lightweight without reading objects).
 *
 * ## Gates (the group's order, reduced to the landed model)
 *
 * `optSignIn` + RepoAssignment + `repo.MustBeNotEmpty` + reqUnitCodeReader:
 * anonymous-capable (RequireSignInViewStrict is off at the pin — the social
 * trio's posture), an invisible repo 404-shells through the router's §2.5
 * read, an EMPTY repo 404-shells (MustBeNotEmpty — the group's own gate; the
 * branches page's GET sits outside its group's gate, this one does not), and
 * every repo reader holds the code unit here (no landed units — the §2.5
 * read grant IS the code-read arm).
 *
 * ## DOM contract (templates/repo/tag/list.tmpl + release_tag_header.tmpl at
 *  the pin)
 *
 * `.page-content.repository tags`, the shell's RepoHeader, then the
 * release_tag_header compact menu — `h2.ui.compact.small.menu` with the
 * Releases item (`{N} Releases` onto `/releases`, the landed page) and the
 * Tags item active (`{M} Tags`) — the h2→h3 heading lift of the count header
 * below is the a11y R2's demand (upstream's h4 would skip from the h2 menu;
 * the branches 0%-width precedent). The `h4`-shaped count header renders as
 * h3 with the template's `ui top attached header` classes, the search combo
 * (shared/search/combo — the ExploreSearchForm port, `search.tag_kind`
 * placeholder), the `#tags-table` divided list and base/paginate.
 *
 * Per row (`.item.tag-list-row`): the h3 title link — upstream
 * `{{if $canReadReleases}}` links EVERY tag onto `/releases/tag/{name}`
 * (SingleRelease renders tag-only rows upstream — release.go:332-341); the
 * LANDED release detail 404s tag-only rows (pages/releases.tsx's documented
 * assertNotTagRecord posture), so only release-backed tags keep that href
 * and tag-only tags fall to upstream's OWN else-arm target `/src/tag/{name}`
 * (the dead-link rule — the landed file view resolves tag refs). The meta
 * line: the ShortSha commit link onto `/src/commit/{oid}` (octicon-git-commit
 * — allowlisted), then the upstream action links this slice renders:
 * "New Release" onto `/releases/new?tag={name}` when the tag is NOT
 * release-backed and the viewer holds CanCreateRelease (= CanWrite(Releases)
 * && !IsArchived — TagsList:230; the write seam's canWriteRepo predicate),
 * "Detail" onto `/releases/tag/{name}` when it is (both octicon-tag).
 *
 * ## Reductions (documented divergences)
 *
 * - The per-row creation-time span (`{{if .CreatedUnix}}` octicon-clock +
 *   TimeSince) is unrendered: upstream's timestamp lives on the releases-
 *   table row (the push-synced tag record), and the engine boundary carries
 *   no tag timestamps — the API's own Tag model renders none. A D1 tag-only
 *   row's CreatedUnix would fake a git fact; nothing renders instead.
 * - The ZIP / TAR.GZ archive links are unrendered: the web-shape archive
 *   route is the survey's separate bench row, not landed (the branches
 *   page's archive reduction — dead-link rule).
 * - The per-row Delete Tag link-action (`/tags/delete?id=`, web.go:1501's
 *   POST) is unrendered: the delete write is its own survey row, not in this
 *   slice's brief, and rendering the control would emit a dead form target.
 * - The `EnableFeed` RSS button in the header block is unrendered: no feed
 *   family exists (the releases page's identical reduction).
 * - The New Release header button never renders (`(not .PageIsTagList)`
 *   upstream — the tags page never qualified); the per-row link above is the
 *   page's create surface, riding the landed `/releases/new` form whose
 *   `?tag=` prefill this wave adds to the GET handler (index.ts).
 * - `?q=` filters by case-insensitive substring over the tag names (the
 *   branches page's honest stand-in for upstream's SQL LIKE NamePattern);
 *   the h4 count carries the FILTERED count exactly like upstream's
 *   TagCount (opts carries NamePattern through the count query).
 * - Pagination sizes with upstream `setting.Repository.Release.
 *   DefaultPagingNum` = 10 (release.go:246-250) — the releases list's own
 *   constant; the Older/Newer pager is the BranchesPagination shape
 *   preserving `?q=`.
 * - The releases count in the header menu is the write-access-inclusive
 *   total (upstream NumReleases includes drafts for writers only —
 *   services/context/repo.go:636-643); the tags count is the ENGINE tag
 *   universe (upstream counts the releases-table tag records — the
 *   push-synced stand-in this engine has no subsystem for).
 * - An empty result with a nonzero unfiltered total renders upstream's
 *   `no_results_found` paragraph; a tagless repo renders the bare segment
 *   (the template's exact arms).
 */

import { engineReads } from "../../api/services/engine";
import { findReleaseByTag, listReleases } from "../../api/services/releases";
import { canWriteRepo } from "./file-editor";
import { ExploreSearchForm } from "./explore";
import { BranchesPagination } from "./branches";
import { prettyNumber, RELEASES_PAGE_SIZE } from "./releases";
import { pathEscapeSegments, shortSha } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the releasesLocale pattern; upstream
 *  locale keys cited). */
export const tagsLocale = {
  page_title: "Tags", // "repo.release.tags"
  tag_singular: "Tag", // "repo.release.tag" (TrN singular)
  releases: "Releases", // "repo.release.releases" (TrN plural arm)
  release_singular: "Release", // "repo.release" (TrN singular — the releases page's count label)
  tags: "Tags", // "repo.release.tags" (TrN plural arm)
  search_placeholder: "Search tags…", // "search.tag_kind"
  new_release: "New Release", // "repo.release.new_release"
  detail: "Detail", // "repo.release.detail"
  no_results: "No results found.", // "no_results_found"
} as const;

/** One rendered tag row: the name, its tip commit (null = unresolvable —
 *  the commit link drops, the row never breaks), and the release coupling
 *  that splits the title/action links (the module header's DOM contract). */
export interface TagRowView {
  name: string;
  /** The commit the tag names (peeled for annotated, the target for
   *  lightweight); null when the engine cannot resolve it. */
  commitOid: string | null;
  /** A NON-tag release row backs this tag (the "Detail" arm). */
  releaseBacked: boolean;
}

/** The page's render inputs, loaded by loadTagsData. */
export interface TagsData {
  keyword: string;
  page: number;
  /** The pager's Older flag (the commits-list convention: filtered count
   *  beyond the fetched page). */
  more: boolean;
  /** The header menu's Releases total (write-access-inclusive — the module
   *  header's NumReleases note). */
  releaseCount: number;
  /** The unfiltered ENGINE tag count (the header menu's Tags item). */
  tagCount: number;
  /** The filtered, one-page slice (the h3 count header's TagCount is
   *  `filtered.length`). */
  rows: TagRowView[];
  /** Upstream CanCreateRelease (= CanWrite(TypeReleases) && !IsArchived —
   *  TagsList:230): gates the per-row New Release links. */
  canCreateRelease: boolean;
}

/**
 * Load the page. The repo row is non-empty and visible by the time this
 * runs (the handler's MustBeNotEmpty + §2.5 posture); a failed ref read
 * degrades to the empty list (§4.9 — unreadable storage never breaks the
 * page), matching the API LIST's `refs ?? []` arm.
 */
export async function loadTagsData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  options: { page: number; keyword: string; viewer: Viewer },
): Promise<TagsData> {
  const refs = await engineReads(env, repo).listRefs();
  // The repoListTags API's universe: refs/tags/ filtered, name-sorted (byte
  // order — routes/tags.ts sortedTags, "the engine's list order is
  // unspecified" so the sort is ours exactly like the API's). The ref rows
  // stay in a map for the per-row tip resolution below.
  const tagRefs = (refs?.refs ?? []).filter((ref) => ref.name.startsWith("refs/tags/"));
  const tagTips = new Map(tagRefs.map((ref) => [ref.name, ref]));
  const tagNames = tagRefs
    .map((ref) => ref.name.slice("refs/tags/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // The keyword filter (case-insensitive substring — the search combo's
  // honest stand-in for upstream's LIKE NamePattern), then the page slice
  // (§4.11 clamps); the per-row reads run for the rendered slice only (the
  // branches page's ENRICH_MAX budget discipline).
  const needle = options.keyword.trim().toLowerCase();
  const filtered = needle === "" ? tagNames : tagNames.filter((name) => name.toLowerCase().includes(needle));
  const page = Math.max(options.page, 1);
  const start = (page - 1) * RELEASES_PAGE_SIZE;
  const pageNames = filtered.slice(start, start + RELEASES_PAGE_SIZE);
  const more = filtered.length > start + RELEASES_PAGE_SIZE;

  // The header menu's releases total (upstream NumReleases:
  // write-access-inclusive — drafts counted for writers only). One 1-row
  // read: only the count is consumed.
  const canWrite = await canWriteRepo(env, repo, options.viewer);
  const releaseCount = (
    await listReleases(d1, repo.id, {
      includeDrafts: canWrite,
      isDraft: null,
      isPrerelease: null,
      tagFilter: "",
      page: 1,
      limit: 1,
    })
  ).total;

  const rows = await Promise.all(
    pageNames.map(async (name): Promise<TagRowView> => {
      // The release coupling splits the row's links (the module header):
      // findReleaseByTag answers either kind, `isTag` distinguishes them
      // (a tag-only record is NOT release-backed — upstream's IsTag arm).
      const releaseRow = await findReleaseByTag(d1, repo.id, name);
      const ref = tagTips.get(`refs/tags/${name}`);
      const commitOid = ref?.peeled ?? ref?.target ?? null;
      return { name, commitOid, releaseBacked: releaseRow !== null && !releaseRow.isTag };
    }),
  );

  return {
    keyword: options.keyword,
    page,
    more,
    releaseCount,
    tagCount: tagNames.length,
    rows,
    canCreateRelease: canWrite && !repo.isArchived,
  };
}

// ---------------------------------------------------------------------------
// Components (tag/list.tmpl's DOM, the reductions documented in the header)
// ---------------------------------------------------------------------------

/** The release_tag_header compact menu (both items live — the releases page
 *  and this one; Tags active). The RSS button is the header's reduction. */
function TagsReleaseHeader(props: { repoLink: string; releaseCount: number; tagCount: number }) {
  return (
    <div class="flex-left-right">
      <h2 class="ui compact small menu small-menu-items">
        <a class="item" href={`${props.repoLink}/releases`}>
          {prettyNumber(props.releaseCount)}{" "}
          {props.releaseCount === 1 ? tagsLocale.release_singular : tagsLocale.releases}
        </a>
        <a class="active item" href={`${props.repoLink}/tags`}>
          {prettyNumber(props.tagCount)} {props.tagCount === 1 ? tagsLocale.tag_singular : tagsLocale.tags}
        </a>
      </h2>
    </div>
  );
}

/** The meta line (list.tmpl's flex-text-block): the ShortSha commit link,
 *  then the action links the slice renders (the header's reductions cover
 *  the time span, the archive pair and the delete action). */
function TagMetaLine(props: { repoLink: string; row: TagRowView; canCreateRelease: boolean }) {
  const { row } = props;
  return (
    <div class="flex-text-block muted-links tw-gap-4 tw-flex-wrap">
      {row.commitOid !== null ? (
        <a class="flex-text-inline tw-font-mono" href={`${props.repoLink}/src/commit/${row.commitOid}`}>
          <Icon name="octicon-git-commit" />
          {shortSha(row.commitOid)}
        </a>
      ) : null}
      {props.canCreateRelease && !row.releaseBacked ? (
        <a class="flex-text-inline" href={`${props.repoLink}/releases/new?tag=${pathEscapeSegments(row.name)}`}>
          <Icon name="octicon-tag" />
          {tagsLocale.new_release}
        </a>
      ) : null}
      {row.releaseBacked ? (
        <a class="flex-text-inline" href={`${props.repoLink}/releases/tag/${pathEscapeSegments(row.name)}`}>
          <Icon name="octicon-tag" />
          {tagsLocale.detail}
        </a>
      ) : null}
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderTagsPage(options: { ctx: UiContext; data: TagsData }): string {
  return renderPage(<TagsPage ctx={options.ctx} data={options.data} />);
}

/** The tags page (§2.4.1 discriminator: the template's literal
 *  `repository tags`). No main tab highlights (upstream sets
 *  PageIsViewCode only when the releases unit is DISABLED — with the units
 *  model absent, the header menu carries the active state exactly like the
 *  releases-enabled upstream). */
export function TagsPage(props: { ctx: UiContext; data: TagsData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("TagsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={tagsLocale.page_title} pageClass="repository tags">
      <div class="ui container">
        <TagsReleaseHeader repoLink={repoLink} releaseCount={data.releaseCount} tagCount={data.tagCount} />
        <div class="divider" />

        {/* The count header — upstream's h4 lifted to h3 (the a11y R2 note
            in the module header); the count is the FILTERED count exactly
            like upstream's TagCount. */}
        <h3 class="ui top attached header">
          {filteredCountLabel(data.rows.length)}
        </h3>

        <div class="ui attached segment">
          <ExploreSearchForm action={`${repoLink}/tags`} keyword={data.keyword} placeholder={tagsLocale.search_placeholder} />
        </div>

        <div class="ui attached segment tw-p-0">
          {data.rows.length > 0 ? (
            <div class="ui divided list" id="tags-table">
              {data.rows.map((row) => (
                <div class="item tag-list-row tw-p-4">
                  <h3 class="tag-list-row-title tw-mb-2">
                    {/* Release-backed tags link onto the landed release
                        detail; tag-only tags fall to upstream's OWN else-arm
                        target — the landed detail 404s tag-only rows (the
                        module header's DOM-contract note). */}
                    <a
                      class="tag-list-row-link"
                      href={`${repoLink}/${row.releaseBacked ? "releases/tag" : "src/tag"}/${pathEscapeSegments(row.name)}`}
                      rel="nofollow"
                    >
                      {row.name}
                    </a>
                  </h3>
                  <TagMetaLine repoLink={repoLink} row={row} canCreateRelease={data.canCreateRelease} />
                </div>
              ))}
            </div>
          ) : (
            // The template's else arm: a nonzero unfiltered universe means
            // the keyword filtered everything out (`no_results_found`);
            // a tagless repo renders the bare segment.
            data.tagCount > 0 ? <p class="tw-p-4">{tagsLocale.no_results}</p> : null
          )}
        </div>

        <BranchesPagination basePath={`${repoLink}/tags`} keyword={data.keyword} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

/** `{TagCount} Tags` — the count header's text (upstream
 *  `{{.TagCount}} {{ctx.Locale.Tr "repo.release.tags"}}`; the singular/plural
 *  split is TrN's, en-US). */
function filteredCountLabel(count: number): string {
  return `${count} ${count === 1 ? tagsLocale.tag_singular : tagsLocale.tags}`;
}
