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
 * - The per-row Delete Tag control (web.go:1501's `POST /tags/delete`) is
 *   the wave-33 tail (the survey's top-5 #2): writer-gated
 *   (`canDeleteTag` = CanWrite(code) && CanContentChange — no mirrors, the
 *   archived arm) on NON-release-backed rows only (upstream's `$release.IsTag`
 *   gate), a plain form POST (the labels-page posture — upstream's
 *   link-action JS + confirm modal is not reproduced, the wave-4 hooks-list
 *   reduction the collaboration/branch-protection pages carry). The write
 *   itself is `applyTagDelete` below: upstream's deleteReleaseOrTag(isDelTag
 *   =true) sequence — row lookup → the release-attached 409 → the protected-
 *   tag refusal → the engine ref CAS (a missing git tag tolerated, upstream's
 *   `tag -d` "not found" arm) → the D1 record drop → the zero-commit push +
 *   delete-ref webhook pair (routes/tags.ts's payloads) — with the flash
 *   texts riding the branches page's query-param convention.
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

import { engineReads, engineCell, refTipMap, tagRef, ZERO_OID } from "../../api/services/engine";
import {
  deleteRelease,
  findReleaseByTag,
  findReleaseForRepoById,
  listReleases,
} from "../../api/services/releases";
import { type ReleaseRow } from "../../issues/service";
import { apiUserFromRow, toApiRepository, type RepositoryWithOwner, type UserRow } from "../../api/services/repository";
import { isTagControlAllowed, listProtectedTags } from "../../services/tag-protection";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import { canWriteRepo } from "./file-editor";
import { ExploreSearchForm } from "./explore";
import { BranchesPagination } from "./branches";
import { prettyNumber, RELEASES_PAGE_SIZE } from "./releases";
import { pathEscapeSegments, shortSha } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";

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
  delete_tag: "Delete Tag", // "repo.release.delete_tag" (the wave-33 control)
  /** "repo.release.deletion_tag_success" — the ?deleted= flash (the branches
   *  page's query-param convention; upstream's session flash has no landed
   *  channel). */
  deletion_success: "The tag has been deleted.",
  /** "repo.release.tag_name_protected" — the ?delete_error=protected flash. */
  tag_name_protected: "The tag name is protected.",
  /** cf-gitea addition (the branches page's deletion_failed posture —
   *  upstream's failure flash is the raw "DeleteReleaseByID: {err}" log
   *  text, not a locale). */
  deletion_failed(name: string): string {
    return `Deleting the tag ${name} failed.`;
  },
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
  /** The D1 tag-only record's id when one exists (the wave-33 delete
   *  control's upstream `?id=` carrier — deleteReleaseOrTag's FormInt64);
   *  null for the engine-universe tags our push-sync-absent model keeps
   *  rowless, which carry the name-keyed `?tag=` arm instead (the landed
   *  repoDeleteTag's exact key — the module header's wave-33 note). */
  deleteId: number | null;
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
  /** Upstream's delete-control gate (`$.Repository.CanContentChange` +
   *  CanWrite(TypeCode) + `$release.IsTag` — tag/list.tmpl): CanContentChange
   *  is !IsMirror && !IsArchived (models/repo/repo.go:587-589; no mirrors in
   *  the landed model), so the predicate equals canCreateRelease today — the
   *  code-writer posture (web.go:1501's reqRepoCodeWriter), kept its own
   *  field so the two unit grants never silently couple. */
  canDeleteTag: boolean;
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
      return {
        name,
        commitOid,
        releaseBacked: releaseRow !== null && !releaseRow.isTag,
        // The wave-33 delete carrier: the D1 tag-only record's id when one
        // exists, else the name-keyed arm (the TagRowView note).
        deleteId: releaseRow !== null && releaseRow.isTag ? releaseRow.id : null,
      };
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
    canDeleteTag: canWrite && !repo.isArchived,
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
 *  the time span and the archive pair). The wave-33 Delete Tag control is
 *  the plain form POST the labels page carries (upstream's link-action +
 *  confirm dialog is the documented no-JS reduction); it renders for
 *  writers on non-release-backed rows exactly like upstream's
 *  `(and CanWrite(code) CanContentChange $release.IsTag)` gate, carrying
 *  the upstream `id` form field when a D1 tag record exists and the
 *  name-keyed `tag` arm for rowless engine tags. */
function TagMetaLine(props: { repoLink: string; row: TagRowView; canCreateRelease: boolean; canDeleteTag: boolean }) {
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
      {props.canDeleteTag && !row.releaseBacked ? (
        <form class="tw-inline-block" action={`${props.repoLink}/tags/delete`} method="post">
          {row.deleteId !== null ? (
            <input type="hidden" name="id" value={row.deleteId} />
          ) : (
            <input type="hidden" name="tag" value={row.name} />
          )}
          <button type="submit" class="ui tiny button">
            <Icon name="octicon-trash" /> {tagsLocale.delete_tag}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** The full-document render (the render.tsx pattern). `flash` carries the
 *  wave-33 delete write's outcome texts (the branches page's query-param
 *  convention — the handler 303s with `?deleted=` / `?delete_error=`). */
export function renderTagsPage(options: { ctx: UiContext; data: TagsData; flash?: TagsFlash }): string {
  return renderPage(<TagsPage ctx={options.ctx} data={options.data} flash={options.flash} />);
}

/** The delete write's flash inputs (the BranchesPage shape). */
export interface TagsFlash {
  /** `?deleted={name}` — `deletion_tag_success` (no name interpolation, the
   *  locale's exact text). */
  deleted: string | null;
  /** `?delete_error={kind}` — protected → `tag_name_protected`, failed →
   *  the branches-page-style server-side text. */
  errorKind: string | null;
  errorName: string;
}

/** The flash block (base/alert's `.ui.positive|.negative.message` arms — the
 *  branches page's carried DOM). */
export function TagsFlashBlock(props: { flash: TagsFlash | undefined }) {
  if (props.flash === undefined) return null;
  if (props.flash.deleted !== null) {
    return <div class="ui positive message">{tagsLocale.deletion_success}</div>;
  }
  if (props.flash.errorKind === "protected") {
    return <div class="ui negative message">{tagsLocale.tag_name_protected}</div>;
  }
  if (props.flash.errorKind === "failed") {
    return <div class="ui negative message">{tagsLocale.deletion_failed(props.flash.errorName)}</div>;
  }
  return null;
}

/** The tags page (§2.4.1 discriminator: the template's literal
 *  `repository tags`). No main tab highlights (upstream sets
 *  PageIsViewCode only when the releases unit is DISABLED — with the units
 *  model absent, the header menu carries the active state exactly like the
 *  releases-enabled upstream). */
export function TagsPage(props: { ctx: UiContext; data: TagsData; flash?: TagsFlash }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("TagsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={tagsLocale.page_title} pageClass="repository tags">
      <div class="ui container">
        <TagsFlashBlock flash={props.flash} />
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
                  <TagMetaLine
                    repoLink={repoLink}
                    row={row}
                    canCreateRelease={data.canCreateRelease}
                    canDeleteTag={data.canDeleteTag}
                  />
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

// ---------------------------------------------------------------------------
// The wave-33 delete write (web.go:1501's POST /tags/delete — upstream
// repo.DeleteTag → deleteReleaseOrTag(isDelTag=true), release.go:661-706,
// over DeleteReleaseByID release.go:372-434)
// ---------------------------------------------------------------------------

/** `ctx.HTTPError(http.StatusConflict, …)`'s exact body text
 *  (release.go:677-680) — the handler answers it as the plain-text 409 the
 *  archive family established for ctx.HTTPError (base.go:105-113). */
export const TAG_RELEASE_ATTACHED_MESSAGE = "a tag attached to a release cannot be deleted directly";

export type TagDeleteResult =
  | { outcome: "deleted"; name: string }
  | { outcome: "missing"; name: string } // unresolvable id, or a rowless tag with no ref → the 404 shell
  | { outcome: "release-attached"; name: string } // the 409 class (the message above)
  | { outcome: "refused-protected"; name: string } // the tag_name_protected flash
  | { outcome: "failed"; name: string }; // CAS moved / invalid → the deletion_failed flash

/** The form's carriers: upstream's `id` (FormInt64 — the D1 tag record) and
 *  the rowless-tag `tag` name arm (the landed repoDeleteTag's exact key —
 *  the TagRowView.deleteId note). */
export interface TagDeleteSubject {
  id: number | null;
  tag: string | null;
}

/** Parse the delete POST (both carriers; an id parses only when all-digit —
 *  a junk id is upstream's zero FormInt64, answered by the row lookup's
 *  404 arm, never a parse crash). */
export function parseTagDeleteForm(params: URLSearchParams): TagDeleteSubject {
  const rawId = (params.get("id") ?? "").trim();
  const id = /^\d+$/.test(rawId) && rawId !== "0" ? Number.parseInt(rawId, 10) : null;
  const tag = (params.get("tag") ?? "").trim();
  return { id, tag: tag === "" ? null : tag };
}

/** The doer row the webhook sender renders (the handler resolves it once;
 *  a vanished session doer refuses the write — the editor POST posture). */
export interface TagDeleteInput {
  pair: RepositoryWithOwner;
  doer: UserRow;
  origin: string;
  /** ctx.waitUntil when a live execution context exists (in-process test
   *  callers settle inline / skip the enqueue — the branches-page
   *  convention). */
  waitUntil: ((promise: Promise<unknown>) => void) | undefined;
}

/**
 * The write, upstream deleteReleaseOrTag(isDelTag=true)'s order (the module
 * header cites the sequence):
 *
 * 1. the row lookup — the `id` carrier through findReleaseForRepoById
 *    (GetReleaseForRepoByID), a miss → `missing` (upstream NotFound);
 *    the name carrier through findReleaseByTag (the API seam's key — our
 *    rowless-tag arm);
 * 2. the release-attached 409 (isDelTag && !rel.IsTag → ctx.HTTPError
 *    Conflict, release.go:677-680);
 * 3. the existence gate — a name-arm tag with neither a D1 record nor a git
 *    ref has nothing to delete → `missing` (upstream's row lookup IS this
 *    404 arm; the ref read rides along for the CAS below);
 * 4. the protected-tag refusal (DeleteReleaseByID's IsUserAllowedToControlTag,
 *    release.go:376-390 → the tag_name_protected flash);
 * 5. the engine CAS delete — a MISSING git tag under a record is tolerated
 *    exactly like upstream's `tag -d` "not found" arm (release.go:391-395:
 *    the delete continues to the record drop); a moved or invalid ref →
 *    `failed` (the flash);
 * 6. the D1 tag-record drop (db.DeleteByID — deleteRelease's batch);
 * 7. the webhook pair on a REAL ref deletion, routes/tags.ts's payloads in
 *    its emission order: the zero-commit `push` (OldCommitID = the tip,
 *    NewCommitID = the zero oid, release.go:396-403) then `delete`
 *    (DeleteRef :403, pusher_type "user").
 */
export async function applyTagDelete(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  subject: TagDeleteSubject,
  input: TagDeleteInput,
): Promise<TagDeleteResult> {
  // 1. The subject row (the module header's dual arm).
  let row: ReleaseRow | null;
  let name: string;
  if (subject.id !== null) {
    const found = await findReleaseForRepoById(d1, repo.id, subject.id);
    if (found === null) return { outcome: "missing", name: `#${subject.id}` };
    if (!found.isTag) return { outcome: "release-attached", name: found.tagName };
    row = found;
    name = found.tagName;
  } else if (subject.tag !== null) {
    name = subject.tag;
    const found = await findReleaseByTag(d1, repo.id, name);
    if (found !== null && !found.isTag) return { outcome: "release-attached", name };
    row = found !== null && found.isTag ? found : null;
  } else {
    return { outcome: "missing", name: "" };
  }
  // 2 is the outcome above. 3. The existence gate (the module header's
  // ordering): a name-arm tag with neither a record nor a ref has nothing
  // to delete — `missing`.
  const tips = refTipMap(await engineReads(env, repo).listRefs());
  const tip = tips.get(tagRef(name));
  if (row === null && tip === undefined) {
    return { outcome: "missing", name };
  }
  // 4. The protected-tag refusal (the check runs after the lookup arms,
  // exactly upstream's DeleteReleaseByID order).
  if (!(await isTagControlAllowed(d1, await listProtectedTags(d1, repo.id), name, input.doer.id))) {
    return { outcome: "refused-protected", name };
  }
  // 5. The CAS delete (a WRITE RPC — a transport failure propagates, the
  //    honest 500; the branches-page posture). A MISSING git tag under a
  //    record is tolerated exactly like upstream's `tag -d` "not found" arm
  //    (release.go:391-395: the delete continues to the record drop).
  let refDeleted = false;
  if (tip !== undefined) {
    const result = await engineCell(env, input.pair.repo).deleteApiRef({ ref: tagRef(name), expectedOid: tip.target });
    if (result.tag === "deleted") {
      refDeleted = true;
    } else if (result.tag === "ref_conflict" && result.currentOid !== null) {
      // The ref moved under us — the arm's git-failure family, the
      // deletion_failed flash. currentOid null is the idempotent
      // already-gone arm (the API seam's "removed nothing" case): no
      // event, the record drop continues.
      return { outcome: "failed", name };
    } else if (result.tag === "invalid") {
      return { outcome: "failed", name };
    }
  }
  // 7. The webhook pair BEFORE the record drop's await would order wrong —
  //    upstream notifies after the git delete and before/around the record
  //    drop; the API seam emits push+delete right after the CAS (the landed
  //    order), then 6. drops the record.
  if (refDeleted) {
    await emitTagDeletedWebhooks(env, input, name, tip?.target ?? "");
  }
  // 6. The D1 record drop (a tag record carries no assets; deleteRelease's
  //    batch is the landed cascade).
  if (row !== null) {
    await deleteRelease(d1, row);
  }
  return { outcome: "deleted", name };
}

/** routes/tags.ts emitRefWebhook's port for the deletion pair: the
 *  zero-commit push payload (zeroCommitPushPayload's shape — FULL ref,
 *  before/after, the bare compare_url, no commits, pusher AND sender the
 *  doer) then the DeletePayload (ref the SHORT name, ref_type "tag",
 *  pusher_type "user"). Delivery rows inline, the Queue producer on
 *  waitUntil when the binding is wired; failures logged, never propagated —
 *  a webhook miss cannot fail the write. */
async function emitTagDeletedWebhooks(env: Env, input: TagDeleteInput, tagName: string, beforeOid: string): Promise<void> {
  const queueCandidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  const queue =
    typeof queueCandidate === "object" &&
    queueCandidate !== null &&
    typeof (queueCandidate as { sendBatch?: unknown }).sendBatch === "function"
      ? {
          sendBatch: (queueCandidate as { sendBatch: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> }).sendBatch.bind(
            queueCandidate,
          ),
        }
      : null;
  const viewer = { origin: input.origin, requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }) };
  const enqueue =
    queue !== null && input.waitUntil !== undefined
      ? (deliveryIds: number[]) => {
          input.waitUntil!(
            queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
              console.error(`[tags] delivery enqueue failed (delete): ${error instanceof Error ? error.message : String(error)}`);
            }),
          );
        }
      : undefined;
  try {
    // The zero-commit push (release.go:396-403; the API seam's payload
    // shape verbatim — the family's mirror-path posture, its documented
    // deviation carried).
    await emitWebhookDeliveries(
      env.DB,
      {
        repoId: input.pair.repo.id,
        ownerId: input.pair.repo.ownerId,
        eventType: "push",
        refName: tagRef(tagName),
        payload: {
          ref: tagRef(tagName),
          before: beforeOid,
          after: ZERO_OID,
          compare_url: `${input.origin}/`,
          commits: [],
          total_commits: 0,
          head_commit: null,
          repository: toApiRepository(viewer, input.pair),
          pusher: viewer.requester,
          sender: viewer.requester,
        },
      },
      { enqueue },
    );
    // DeleteRef (notifier.go:858→:870) — pusher_type "user".
    await emitWebhookDeliveries(
      env.DB,
      {
        repoId: input.pair.repo.id,
        ownerId: input.pair.repo.ownerId,
        eventType: "delete",
        refName: tagRef(tagName),
        payload: {
          ref: tagName,
          ref_type: "tag",
          pusher_type: "user",
          repository: toApiRepository(viewer, input.pair),
          sender: viewer.requester,
        },
      },
      { enqueue },
    );
  } catch (error) {
    console.error(`[tags] webhook fan-out failed (delete): ${error instanceof Error ? error.message : String(error)}`);
  }
}
