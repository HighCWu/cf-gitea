/**
 * The repository WIKI family — all five `templates/repo/wiki/` pages as the
 * UNMOUNTED bench module (survey bench-row 8, the last M-tier surface;
 * pages wave 69 — `index.ts` is orchestrator/sibling-owned, this module
 * ships without a route). One module because the five pages share the same
 * data spine: the sibling `owner/slug.wiki` engine cell through the LANDED
 * wiki service (src/services/wiki.ts — specs/wiki.md) and one route grammar.
 *
 * ## VERIFIED ROUTE GRAMMAR (the flagship deliverable — derived from
 *    gitea/routers/web/repo/wiki.go at the pin, NOT from a naive web.go
 *    reading; the survey's verify-first warning was correct)
 *
 * web.go registers ONLY two combos plus raw/commit/excerpt tails inside the
 * `/{username}/{reponame}/wiki` group (web.go:1611-1626):
 *
 *   m.Combo("").    Get(repo.Wiki).                        web.go:1612-1614
 *                   Post(RepoMustNotBeArchived, reqSignIn, reqUnitWikiWriter, repo.WikiPost)
 *   m.Combo("/*").  Get(repo.Wiki).                        web.go:1615-1617
 *                   Post(same middlewares, repo.WikiPost)
 *   m.Get("/blob_excerpt/{sha}", …)                        web.go:1618 (the
 *                                                   landed wiki-blob-excerpt twin)
 *   m.Get("/commit/{sha…}") / ".{patch,diff}"              web.go:1619-1620
 *   m.Get("/raw/*", repo.WikiRaw)                          web.go:1621
 *
 * The SUB-PAGES ARE NOT ROUTES. They are case-arms on the `action` form
 * value inside the handlers themselves:
 *
 *   GET  repo.Wiki (wiki.go:445-469)  switch ctx.FormString("action"):
 *     "_pages"    → WikiPages       wiki.go:449-451  (pages list)
 *     "_revision" → WikiRevision    wiki.go:452-454  (revision list)
 *     "_edit"     → EditWiki        wiki.go:455-461  (writer-gated; renders
 *                                    tplWikiNew with PageIsWikiEdit)
 *     "_new"      → NewWiki         wiki.go:462-468  (writer-gated)
 *     default     → HasWiki? renderViewPage : tplWikiStart   wiki.go:471-501
 *   POST repo.WikiPost (wiki.go:419-442)  switch ctx.FormString("action"):
 *     "_new"      → NewWikiPost     wiki.go:421-427  (writer-gated)
 *     "_delete"   → DeleteWikiPagePost wiki.go:428-434 (writer-gated)
 *     default     → EditWikiPost    wiki.go:437-441  (writer-gated; note
 *                                    the edit form's "?action=_edit" POST
 *                                    falls into THIS default arm)
 *
 * So the complete working surface (P = `/{owner}/{repo}`):
 *
 *   GET  P/wiki                  view "Home" (or tplWikiStart when no wiki)
 *   GET  P/wiki/{PageURL}        view that page
 *   GET  P/wiki/?action=_pages   pages list        (NOT a /wiki/_pages route!)
 *   GET  P/wiki/{PageURL}?action=_revision   revisions (?page=N paginates)
 *   GET  P/wiki/{PageURL}?action=_edit       edit form
 *   GET  P/wiki?action=_new                  new form
 *   POST P/wiki?action=_new                 create (fields title/content/message)
 *   POST P/wiki/{PageURL}?action=_edit      edit/rename (same fields; the
 *                                action value lands in WikiPost's default arm)
 *   POST P/wiki/{PageURL}?action=_delete    delete
 *   GET  P/wiki/raw/*                       raw blob (WikiRaw)
 *
 * A page NAME of "_pages"/"_new"/"_edit"/"raw" is refused at write time
 * (reservedWikiNames, wiki_path.go:42) — precisely so these action values
 * can never collide with page names. The wiki 404 arm: a missing page on
 * view/edit/revision REDIRECTS to `P/wiki/?action=_pages` (wiki.go:238,
 * 340, 400); a whole-absent wiki renders tplWikiStart (wiki.go:471-475) or
 * redirects to P/wiki (WikiPages wiki.go:537-540, EditWiki wiki.go:692-695).
 *
 * ## HANDOFF NOTE (mount recipe for the index.ts window owner)
 *
 * The mounts ride the standard repo prologue (`resolveUiRequest` — D1 row +
 * viewer) plus the landed wiki gates: `loadRepoSettings(d1, repo.id).hasWiki`
 * 404-shells a disabled wiki (MustEnableWiki, web.go:1614 — the landed
 * blob-excerpt wiki twin's exact posture, index.ts:5439-5442), reads need no
 * further gate (reqUnitWikiReader reduces to repo visibility — already the
 * prologue's), writes add `canWriteRepo(env, repo, viewer)` (pages/
 * file-editor.tsx:180) + !repo.isArchived (RepoMustNotBeArchived) + the
 * sameOriginGuard + session (the standard POST prologue order):
 *
 *   GET  /:owner/:repo/wiki[/*]      loadWikiViewData(env, pair, rawTail,
 *                                    origin) → "start" renders
 *                                    renderWikiStartPage, "missing" 303s
 *                                    `${repoLink}/wiki/?action=_pages`,
 *                                    "view" renders renderWikiViewPage.
 *                                    canWrite = (await canWriteRepo(...)) &&
 *                                    !repo.isArchived (wiki.go:446).
 *   GET  …/wiki/?action=_pages       loadWikiPagesData → "no-wiki" 303s
 *                                    `${repoLink}/wiki` (wiki.go:537-540),
 *                                    "pages" renders renderWikiPagesPage.
 *   GET  …/wiki?action=_new          renderWikiNewPage({ initialTitle:
 *                                    hasWiki ? (url title param ?? "") :
 *                                    "Home" } — wiki.go:652-663) — writer
 *                                    gate else 404 (wiki.go:462-468).
 *   GET  …/wiki/*?action=_edit       loadWikiEditData → renderWikiEditPage;
 *                                    no-wiki 303s /wiki, missing 303s _pages
 *                                    (wiki.go:692-695, 399-401); writer gate.
 *   GET  …/wiki/*?action=_revision   loadWikiRevisionData (page param through
 *                                    parsePageNumber) → renderWikiRevisionPage;
 *                                    start/missing arms as above.
 *   POST …/wiki?action=_new          parseWikiPageForm(readUrlEncodedForm) →
 *                                    createWikiPageFromForm(env, pair, doer,
 *                                    form, origin) → 303 onto
 *                                    `${repoLink}/wiki/${page.sub_url}`
 *                                    (NewWikiPost's JSONRedirect,
 *                                    wiki.go:685). doer = the session
 *                                    viewer's git identity (the routes/wiki.ts
 *                                    wikiDoer derivation: login, or email,
 *                                    else `{login}@noreply.{hostname}`).
 *   POST …/wiki/*?action=_edit       editWikiPageFromForm(env, pair, doer,
 *                                    oldWikiName = webPathFromRequest(rawTail),
 *                                    form, origin) → 303 onto the new page
 *                                    (EditWikiPost, wiki.go:725).
 *   POST …/wiki/*?action=_delete     deleteWikiPageFromForm(env, pair, doer,
 *                                    webPathFromRequest(rawTail) — "" means
 *                                    "Home", wiki.go:730-731) → 303 onto
 *                                    `${repoLink}/wiki/` (wiki.go:739).
 *
 * Parser note: the wildcard tail must reach the loaders RAW (pre-decoding) —
 * the codec's `webPathFromRequest` re-encodes `/`→`%2F` itself
 * (services/wiki.ts:213), so the index.ts wildcard parser hands over
 * `route.rawTail` verbatim (the blob-excerpt twin's rawTail pattern).
 * Survey rows to touch on landing: docs/compat/ui-parity-survey.md row 8
 * (the repo-wiki family row) — page note "bench module landed, unmounted".
 *
 * ## DOM contracts + documented reductions (per template at the pin)
 *
 * - start.tmpl — `.page-content.repository.wiki.start`, the centered segment
 *   with the 48px book glyph, the two welcome lines and the writer-gated
 *   "Create the First Page" button (start.tmpl:5-12). Glyph substitution:
 *   `octicon-book` is NOT in the generated icon allowlist — `octicon-repo`
 *   stands in (the editor-tails missing-glyph rule).
 * - view.tmpl — page-dropdown row (the pages list for the dropdown comes
 *   from a raw tree walk WITHOUT per-page last-commit RPCs — upstream
 *   renderViewPage's PageMeta carries no UpdatedUnix, wiki.go:196-217 —
 *   unlike the pages TABLE which is upstream WikiPages and does), the
 *   history button (count + octicon-history), the last-edited line
 *   (`repo.wiki.last_commit_info` = "%s edited this page %s" over the
 *   commiter identity), the writer-gated Edit/New/Delete buttons with the
 *   delete modal (view.tmpl:99-103 + modal_actions_confirm.tmpl — the
 *   default Yes/No arm), and the content/sidebar/footer markup divisions
 *   (view.tmpl:64-95) with the sidebar-presence `with-sidebar` class.
 *   WebPath hrefs carry the WebPath VERBATIM (upstream interpolates the
 *   already-escaped SubURL/PageURL into the URL attributes; only the raw
 *   git-entry name is PathEscaped). UNRENDERED (no pipeline / no dead
 *   controls):
 *     - the clone_panel includes (view.tmpl:31, revision.tmpl:18) — no
 *       clone-button surface is landed anywhere (CloneButtonOriginLink is
 *       WikiCloneLink, web.go:1624's group arg);
 *     - the EscapeStatus unescape buttons + unicode_escape_prompt
 *       (view.tmpl:46-49, 72) — no control-character escape pipeline (the
 *       shared markdown posture escapes raw HTML wholesale);
 *     - the WikiSidebarTocHTML TOC arm (view.tmpl:65-69) — the markdown
 *       service has no TOC extraction; the `with-sidebar` class keys on the
 *       sidebar content alone;
 *     - the FormatWarning arm (wiki.go:488-491) — unreachable here: every
 *       coded page path ends `.md`, and the raw-file fallback redirects to
 *       /wiki/raw before any render.
 * - pages.tmpl — the header + writer-gated New Page button, the admin-only
 *   default-wiki-branch line (ours = the repo default branch, the
 *   wikiBranch value), and the `wiki-pages-list` table: file icon, name
 *   link, the wiki-git-entry chevron ("View original Git file instead of
 *   using friendly link") and the last-updated cell, entries NATURALLY
 *   sorted (wiki.go:563 CustomSort(NaturalSortCompare) → localeCompare
 *   numeric). The chevron glyph substitutes `octicon-link` (no
 *   octicon-chevron-right in the allowlist).
 * - new.tmpl (BOTH the new and the edit page — upstream renders tplWikiNew
 *   for EditWiki too, wiki.go:702) — the title input (required, the
 *   `?title=`/existing name prefilled), the page_name_desc help, the
 *   combomarkdowneditor reduced to the landed plain textarea (id="edit_area"
 *   name="content" — the file-editor reduction; the NEW form pre-fills the
 *   `repo.wiki.welcome` text, new.tmpl:20-23), the optional-message input,
 *   and cancel + Save Page. The form action is upstream's literal relative
 *   `?action=_new` / `?action=_edit` (new.tmpl:12 — it posts to the current
 *   URL; the _edit value lands in WikiPost's DEFAULT arm). The
 *   PageIsWikiEdit header carries the tiny New Page button (new.tmpl:8-11).
 * - revision.tmpl — the back-to-wiki button (octicon-home substitutes
 *   octicon-repo), the last-edited line, the "{count} Commits" attached
 *   header and the landed CommitList (repo/commits_list parity) over the
 *   mapped wiki commits, plus the Newer/Older pagination at CommitsRangeSize
 *   (the service op's own page size). The commit rows link
 *   `{repoLink}/commit/{sha}` exactly like upstream's commits_list — wiki
 *   shas do not resolve in the repo view there either (upstream quirk kept
 *   for parity).
 *
 * ## Data sourcing (§3.2 — service ops, never a self-fetch)
 *
 * Reads: `readWikiPage` (view/edit content + sidebar/footer base64 +
 * commit_count + last_commit), `listWikiPageRevisions` (the revision page),
 * and — for the two tree listings — the service's OWN read client
 * (`wikiReads`) + codec (`gitPathToWebPath`/`webPathToUserTitle`), because
 * the pages table needs the raw GitEntryName the API metadata projection
 * does not carry (the service's listWikiPages feeds the API surface). The
 * per-row last-commit rides `lastCommitForPath` (api/services/contents —
 * the same primitive the service op uses). Writes: `createWikiPage` /
 * `editWikiPage` / `deleteWikiPage` verbatim through the form seams below
 * (the mount wave's POST arms are one call each). Rendered markdown goes
 * through the SHARED pipeline (api/services/markdown.ts) in `wiki` mode —
 * `[[wiki-link]]`s and relative links rewrite onto `{origin}/{owner}/{repo}/
 * wiki/…`, images onto `/wiki/raw/…` — the same reuse rule as the issue
 * family's comment mode.
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { branchRef, refTipMap, type EngineReads, type RefTip } from "../../api/services/engine";
import { lastCommitForPath } from "../../api/services/contents";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import type { RepositoryWithOwner } from "../../api/services/repository";
import {
  createWikiPage,
  deleteWikiPage,
  editWikiPage,
  gitPathToWebPath,
  listWikiPageRevisions,
  readWikiPage,
  webPathFromRequest,
  webPathToUserTitle,
  wikiReads,
  type WikiCommitJson,
  type WikiDoer,
  type WikiPageJson,
} from "../../services/wiki";
import { CommitList } from "../components/commit-list";
import { TimeSince } from "../components/file-list";
import { parsePageNumber, pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local; upstream locale keys cited). */
export const wikiLocale = {
  wiki: "Wiki", // "repo.wiki" (the start page's Title)
  welcome: "Welcome to the Wiki.", // "repo.wiki.welcome"
  welcome_desc: "The wiki lets you write and share documentation with collaborators.", // "repo.wiki.welcome_desc"
  create_first_page: "Create the First Page", // "repo.wiki.create_first_page"
  page: "Page", // "repo.wiki.page"
  filter_page: "Filter page", // "repo.wiki.filter_page"
  no_results_found: "No results found.", // "no_results_found" (the dropdown's data-no-results)
  pages: "Pages", // "repo.wiki.pages"
  new_page: "Page", // "repo.wiki.new_page" (the form header — yes, "Page")
  new_page_button: "New Page", // "repo.wiki.new_page_button"
  edit_page_button: "Edit", // "repo.wiki.edit_page_button"
  delete_page_button: "Delete Page", // "repo.wiki.delete_page_button"
  delete_page_notice_1: 'Deleting the wiki page "%s" cannot be undone. Continue?', // "repo.wiki.delete_page_notice_1"
  file_revision: "Page Revision", // "repo.wiki.file_revision" (the history button's title)
  last_commit_info: "%s edited this page %s", // "repo.wiki.last_commit_info"
  last_updated: "Last updated %s", // "repo.wiki.last_updated"
  original_git_entry_tooltip: "View original Git file instead of using friendly link.", // "repo.wiki.original_git_entry_tooltip"
  page_title: "Page title", // "repo.wiki.page_title"
  page_name_desc: "Enter a name for this Wiki page. Some special names are: 'Home', '_Sidebar' and '_Footer'.", // "repo.wiki.page_name_desc"
  page_content: "Page content", // "repo.wiki.page_content"
  default_commit_message: "Write a note about this page update (optional).", // "repo.wiki.default_commit_message"
  save_page: "Save Page", // "repo.wiki.save_page"
  back_to_wiki: "Back to wiki page", // "repo.wiki.back_to_wiki"
  wiki_page_revisions: "Wiki Page Revisions", // "repo.wiki.wiki_page_revisions"
  default_branch: "Default branch:", // "repo.default_branch" (the admin line's label)
  modal_yes: "Yes", // "modal.yes" (modal_actions_confirm's default positive)
  modal_no: "No", // "modal.no" (its default negative)
  commits: "Commits", // "repo.commits.commits" (the revision count header)
  newer: "Newer", // "repo.commits.previous" (the paginate reduction's label)
  older: "Older", // "repo.commits.older"
  home: "Home", // the default page name (wiki.go:222-224)
} as const;

/** `setting.Git.CommitsRangeSize` — the revision pager's page size (the
 *  service op's own page size; the paginate arm mirrors it). */
export const WIKI_REVISIONS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Shared read helpers (the service's own vocabulary — module header §sourcing)
// ---------------------------------------------------------------------------

/** The wiki branch's tip (the service's private wikiTip posture, inlined —
 *  wikiReads/branchRef/refTipMap are its exported building blocks). */
export async function wikiTipOf(env: Env, pair: RepositoryWithOwner): Promise<RefTip | undefined> {
  const reads = wikiReads(env, pair);
  const tips = refTipMap(await reads.listRefs());
  return tips.get(branchRef(wikiBranchOf(pair)));
}

/** The wiki's default branch = the repo's (services/wiki.ts wikiBranch). */
function wikiBranchOf(pair: RepositoryWithOwner): string {
  return pair.repo.defaultBranch;
}

/** One raw tree walk over the wiki cell (upstream `commit.Tree().ListEntries`
 *  → PageMeta loop, wiki.go:190-217 / 558-591): regular blobs only, coded to
 *  WebPaths, invalid names silently skipped. `dropSideBars` is the VIEW
 *  dropdown's `_Sidebar`/`_Footer` skip (wiki.go:208-210); `withUpdated`
 *  adds the per-row last-commit lookup (the pages table only — the view
 *  dropdown's upstream PageMeta carries no stamp). */
async function listWikiTreeEntries(
  reads: EngineReads,
  tip: string,
  options: { dropSideBars: boolean; withUpdated: boolean },
): Promise<WikiPageMeta[]> {
  const tree = await reads.listTree(tip);
  if (tree === null) return [];
  const pages: WikiPageMeta[] = [];
  for (const entry of tree.entries) {
    if (entry.type !== "blob") continue; // entry.IsRegular() (wiki.go:198, 573)
    const wikiName = gitPathToWebPath(entry.name);
    if (wikiName === null) continue; // ErrWikiInvalidFileName skip (wiki.go:203-205)
    if (options.dropSideBars && (wikiName === "_Sidebar" || wikiName === "_Footer")) continue;
    let updatedUnix: number | null = null;
    if (options.withUpdated) {
      // WikiPages' GetCommitsInfo per entry (wiki.go:565-590) — the same
      // lastCommitForPath primitive the service's listWikiPages uses.
      const commit = await lastCommitForPath(reads, tip, entry.name);
      updatedUnix = commit?.committer.time ?? null;
    }
    pages.push({
      name: webPathToUserTitle(wikiName).display,
      subUrl: wikiName, // WebPathToURLPath is the identity (wiki_path.go:140-142)
      gitEntryName: entry.name,
      updatedUnix,
    });
  }
  return pages;
}

/** One page row for the dropdown + the pages table. */
export interface WikiPageMeta {
  /** The display title (WebPathToUserTitle). */
  name: string;
  /** The WebPath href tail (WebPathToURLPath — the identity). */
  subUrl: string;
  /** The raw tree entry name (the pages table's git-entry chevron). */
  gitEntryName: string;
  /** The last-update unix stamp (pages table only; null = not loaded). */
  updatedUnix: number | null;
}

/** Go `time.Time`-RFC3339 → unix seconds (the wiki commits' `commiter.date`
 *  form — services/wiki.ts's rfc3339 output). NaN-safe: an unparseable stamp
 *  reads as null (never breaks the page). */
export function wikiDateToUnixSeconds(rfc3339: string): number | null {
  const ms = Date.parse(rfc3339);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Decode the service's base64 content fields (`content_base64`, `sidebar`,
 *  `footer`) to UTF-8 text ("" stays ""). */
export function decodeWikiBase64(base64: string): string {
  if (base64 === "") return "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The §3.4 pipeline in `wiki` mode: `[[target]]`/`[[label|target]]` links
 *  and relative links rewrite onto `{origin}/{owner}/{repo}/wiki/…`, images
 *  onto `/wiki/raw/…` (markdown.ts's wiki policy). Any pipeline failure
 *  degrades to "" — markdown never breaks the page (the issue-family rule). */
export function renderWikiMarkdown(input: {
  text: string;
  repo: { ownerNamespace: string; slug: string };
  origin: string;
}): string {
  if (input.text === "") return "";
  try {
    return renderMarkdownToHtml({
      text: input.text,
      mode: "wiki",
      context: `/${input.repo.ownerNamespace}/${input.repo.slug}`,
      wiki: false,
      origin: input.origin,
    });
  } catch {
    return "";
  }
}

/** `ConvertFromGitCommit` in reverse: the wiki API's commit projection maps
 *  back onto the engine display shape the family CommitList renders (time ←
 *  RFC3339, subject ← the message's first line; toWikiCommit dropped
 *  exactly these). */
export function wikiCommitAsEngineCommit(commit: WikiCommitJson): CommitJson {
  const time = wikiDateToUnixSeconds(commit.commiter.date) ?? 0;
  return {
    oid: commit.sha,
    tree: "",
    parents: [],
    author: { name: commit.author.name, email: commit.author.email, time, tz: "+0000" },
    committer: { name: commit.commiter.name, email: commit.commiter.email, time, tz: "+0000" },
    subject: commit.message.split("\n")[0] ?? "",
    message: commit.message,
  };
}

/** `{{ctx.Locale.Tr "repo.wiki.last_commit_info" name $since}}` renders
 *  "%s edited this page %s" with the relative-time element in the second
 *  slot — the JSX reduction emits the filled prefix and lets the element
 *  complete it. */
function lastEditedPrefix(name: string): string {
  return `${wikiLocale.last_commit_info.replace("%s", name).split("%s")[0] ?? ""}`;
}

/** "Last updated %s" → the prefix the relative-time element completes. */
function localePrefix(text: string): string {
  const at = text.indexOf("%s");
  return at < 0 ? text : text.slice(0, at);
}

// ---------------------------------------------------------------------------
// Write seams (the service ops behind the form POSTs — one call each)
// ---------------------------------------------------------------------------

/** The new/edit POST body (new.tmpl's field names verbatim: `title`,
 *  `content`, `message` — WikiEditForm, services/forms). */
export interface WikiPageFormValues {
  title: string;
  content: string;
  message: string;
}

/** Parse the urlencoded POST (the mount wave calls this on
 *  readUrlEncodedForm's result). Absent fields read empty (the form's zero
 *  values; the service applies the `Add %q`/`Update %q` defaults on ""). */
export function parseWikiPageForm(params: URLSearchParams): WikiPageFormValues {
  return {
    title: params.get("title") ?? "",
    content: params.get("content") ?? "",
    message: params.get("message") ?? "",
  };
}

/** NewWikiPost's write: the create op (title through the codec, the service
 *  refusing reserved/duplicate names) answered with the fresh page — the
 *  mount 303s onto `wiki/{page.sub_url}` (wiki.go:685). */
export async function createWikiPageFromForm(
  env: Env,
  pair: RepositoryWithOwner,
  doer: WikiDoer,
  form: WikiPageFormValues,
  origin: string,
): Promise<WikiPageJson> {
  return createWikiPage(
    env,
    pair,
    doer,
    {
      title: form.title,
      content: new TextEncoder().encode(form.content),
      message: form.message,
    },
    origin,
  );
}

/** EditWikiPost's write: content replace + optional rename — the op's
 *  empty-title arm keeps the old name (upstream's binding-optional title). */
export async function editWikiPageFromForm(
  env: Env,
  pair: RepositoryWithOwner,
  doer: WikiDoer,
  oldWikiName: string,
  form: WikiPageFormValues,
  origin: string,
): Promise<WikiPageJson> {
  return editWikiPage(
    env,
    pair,
    doer,
    oldWikiName,
    {
      title: form.title,
      content: new TextEncoder().encode(form.content),
      message: form.message,
    },
    origin,
  );
}

/** DeleteWikiPagePost's write: "" means "Home" (wiki.go:730-731). */
export async function deleteWikiPageFromForm(env: Env, pair: RepositoryWithOwner, doer: WikiDoer, wikiName: string): Promise<void> {
  return deleteWikiPage(env, pair, doer, wikiName === "" ? wikiLocale.home : wikiName);
}

// ---------------------------------------------------------------------------
// Data loads (one per GET arm; the discriminated outcomes carry the handler's
// redirect/start decisions so the mount wave is wire-up only)
// ---------------------------------------------------------------------------

/**
 * The wildcard tail → the wiki page name (upstream `WebPathFromRequest` +
 * the `len(pageName) == 0 → "Home"` arm, wiki.go:222-224/327-329/386-389).
 * `webPathFromRequest("")` is "" (pathJoinRelX's empty-input arm answers ""
 * per upstream PathJoinRelX), so the bare `/wiki` tail lands here.
 */
function wikiNameFromTail(rawTail: string): string {
  const raw = webPathFromRequest(rawTail);
  return raw === "" ? wikiLocale.home : raw;
}

export type WikiViewData =
  | { outcome: "start" } // no wiki branch — tplWikiStart (wiki.go:471-475)
  | { outcome: "missing" } // page absent — 303 ?action=_pages (wiki.go:237-239)
  | {
      outcome: "view";
      title: string;
      pageUrl: string;
      page: WikiPageJson;
      contentHtml: string;
      sidebarHtml: string;
      footerHtml: string;
      pages: WikiPageMeta[];
    };

/** The GET view arm (repo.Wiki default): `rawTail` is the wildcard tail
 *  VERBATIM (the codec re-encodes it); "" → "Home". */
export async function loadWikiViewData(env: Env, pair: RepositoryWithOwner, rawTail: string, origin: string): Promise<WikiViewData> {
  const wikiName = wikiNameFromTail(rawTail);
  const tip = await wikiTipOf(env, pair);
  if (tip === undefined) return { outcome: "start" }; // HasWiki (wiki.go:471)
  const page = await readWikiPage(env, pair, wikiName, origin);
  if (page === null) return { outcome: "missing" }; // noEntry (wiki.go:237-239)
  const repo = { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug };
  // The dropdown's page list — the no-last-commit tree walk (module header).
  const pages = await listWikiTreeEntries(wikiReads(env, pair), tip.target, {
    dropSideBars: true,
    withUpdated: false,
  });
  return {
    outcome: "view",
    title: webPathToUserTitle(wikiName).display,
    pageUrl: wikiName,
    page,
    contentHtml: renderWikiMarkdown({ text: decodeWikiBase64(page.content_base64), repo, origin }),
    sidebarHtml: renderWikiMarkdown({ text: decodeWikiBase64(page.sidebar), repo, origin }),
    footerHtml: renderWikiMarkdown({ text: decodeWikiBase64(page.footer), repo, origin }),
    pages,
  };
}

export type WikiPagesData = { outcome: "no-wiki" } | { outcome: "pages"; pages: WikiPageMeta[] };

/** The GET `_pages` arm (WikiPages): ALL entries with per-row last-update,
 *  naturally sorted (wiki.go:563). */
export async function loadWikiPagesData(env: Env, pair: RepositoryWithOwner): Promise<WikiPagesData> {
  const tip = await wikiTipOf(env, pair);
  if (tip === undefined) return { outcome: "no-wiki" };
  const pages = await listWikiTreeEntries(wikiReads(env, pair), tip.target, {
    dropSideBars: false,
    withUpdated: true,
  });
  pages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { outcome: "pages", pages };
}

export type WikiEditData =
  | { outcome: "no-wiki" } // — 303 /wiki (wiki.go:692-695)
  | { outcome: "missing" } // — 303 ?action=_pages (wiki.go:399-401)
  | { outcome: "edit"; title: string; pageUrl: string; content: string };

/** The GET `_edit` arm (EditWiki → renderEditPage): the page's current
 *  content as the textarea's initial value (`origin` feeds the unused
 *  metadata projection of the underlying read). */
export async function loadWikiEditData(env: Env, pair: RepositoryWithOwner, rawTail: string, origin: string): Promise<WikiEditData> {
  const wikiName = wikiNameFromTail(rawTail);
  const tip = await wikiTipOf(env, pair);
  if (tip === undefined) return { outcome: "no-wiki" };
  const page = await readWikiPage(env, pair, wikiName, origin);
  if (page === null) return { outcome: "missing" };
  return {
    outcome: "edit",
    title: webPathToUserTitle(wikiName).display,
    pageUrl: wikiName,
    content: decodeWikiBase64(page.content_base64),
  };
}

export type WikiRevisionData =
  | { outcome: "start" } // no wiki — tplWikiStart (wiki.go:507-511)
  | { outcome: "missing" } // page absent — 303 ?action=_pages (wiki.go:339-341)
  | {
      outcome: "revision";
      title: string;
      pageUrl: string;
      count: number;
      commits: WikiCommitJson[];
      /** The page's newest commit (the header's last-edited line). */
      lastCommit: WikiCommitJson | null;
      page: number;
    };

/** The GET `_revision` arm (WikiRevision → renderRevisionPage): the paged
 *  per-page log at the service op's CommitsRangeSize. `pageParam` is the raw
 *  `?page=` value (§4.11 clamp). */
export async function loadWikiRevisionData(
  env: Env,
  pair: RepositoryWithOwner,
  rawTail: string,
  pageParam: string | null,
): Promise<WikiRevisionData> {
  const wikiName = wikiNameFromTail(rawTail);
  const tip = await wikiTipOf(env, pair);
  if (tip === undefined) return { outcome: "start" };
  const page = parsePageNumber(pageParam);
  const revisions = await listWikiPageRevisions(env, pair, wikiName, page);
  if (revisions === null) return { outcome: "missing" };
  return {
    outcome: "revision",
    title: webPathToUserTitle(wikiName).display,
    pageUrl: wikiName,
    count: revisions.count,
    commits: revisions.commits,
    lastCommit: revisions.commits[0] ?? null,
    page,
  };
}

// ---------------------------------------------------------------------------
// The five page renders
// ---------------------------------------------------------------------------

/** The full-document START render (tplWikiStart — wiki.go:473/483). */
export function renderWikiStartPage(options: { ctx: UiContext; canWrite: boolean }): string {
  return renderPage(<WikiStartPage ctx={options.ctx} canWrite={options.canWrite} />);
}

/** start.tmpl (§2.4.1 discriminator: start.tmpl:2's `repository wiki start`). */
export function WikiStartPage(props: { ctx: UiContext; canWrite: boolean }) {
  const repo = props.ctx.repo;
  if (repo === undefined) throw new Error("WikiStartPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={props.ctx} title={wikiLocale.wiki} pageClass="repository wiki start" activeTab="code">
      <div class="ui container">
        <div class="ui center segment tw-py-8">
          {/* start.tmpl:6 — octicon-book is not in the generated allowlist;
              octicon-repo stands in (the missing-glyph rule). */}
          <Icon name="octicon-repo" size={48} />
          <h2>{wikiLocale.welcome}</h2>
          <p>{wikiLocale.welcome_desc}</p>
          {props.canWrite && !repo.isMirror ? (
            <a class="ui primary button tw-mr-0" href={`${repoLink}/wiki?action=_new`}>
              {wikiLocale.create_first_page}
            </a>
          ) : null}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document VIEW render (tplWikiView — wiki.go:500). */
export function renderWikiViewPage(options: { ctx: UiContext; data: Extract<WikiViewData, { outcome: "view" }>; canWrite: boolean }): string {
  return renderPage(<WikiViewPage ctx={options.ctx} data={options.data} canWrite={options.canWrite} />);
}

/** view.tmpl (discriminator: `repository wiki` — shared with the form page).
 *  `data` is the "view" outcome of loadWikiViewData. */
export function WikiViewPage(props: { ctx: UiContext; data: Extract<WikiViewData, { outcome: "view" }>; canWrite: boolean }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("WikiViewPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const writer = props.canWrite && !repo.isMirror;
  // The WebPath carries VERBATIM in hrefs (module header §DOM contracts) —
  // only the raw git-entry name is PathEscaped (pages table).
  const pageUrl = data.pageUrl;
  const lastEdited =
    data.page.last_commit === null
      ? null
      : (() => {
          const unix = wikiDateToUnixSeconds(data.page.last_commit.commiter.date);
          if (unix === null) return null;
          return (
            <>
              {lastEditedPrefix(data.page.last_commit.commiter.name)}
              <TimeSince unixSeconds={unix} tz="+0000" />
            </>
          );
        })();
  return (
    <BaseLayout ctx={ctx} title={data.title} pageClass="repository wiki" activeTab="code">
      <div class="ui container">
        {/* The page dropdown row (view.tmpl:6-32). */}
        <div class="repo-button-row">
          <div class="flex-text-block tw-flex-1">
            <div class="ui floating filter dropdown" data-no-results={wikiLocale.no_results_found}>
              <div class="ui basic small button">
                <span class="text">
                  {wikiLocale.page}: <strong>{data.title}</strong>
                </span>
                {/* view.tmpl:14 octicon-triangle-down — not in the allowlist;
                    octicon-search stands in (the missing-glyph rule). */}
                <Icon name="octicon-search" size={14} class="dropdown icon" />
              </div>
              <div class="menu">
                <div class="ui icon search input">
                  <i class="icon">
                    {/* view.tmpl:18 octicon-filter — octicon-search stands in. */}
                    <Icon name="octicon-search" size={16} />
                  </i>
                  <input name="search" placeholder={`${wikiLocale.filter_page}...`} />
                </div>
                <div class="scrolling menu">
                  <a class="item muted" href={`${repoLink}/wiki/?action=_pages`}>
                    {wikiLocale.pages}
                  </a>
                  <div class="divider" />
                  {data.pages.map((pageMeta) => (
                    <a class={`item ${pageMeta.name === data.title ? "selected" : ""}`} href={`${repoLink}/wiki/${pageMeta.subUrl}`}>
                      {pageMeta.name}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* view.tmpl:31's clone_panel — unrendered (module header). */}
        </div>
        {/* The dividing header (view.tmpl:33-57). */}
        <div class="ui dividing header">
          <div class="flex-text-block tw-flex-wrap tw-justify-end">
            <div class="flex-text-block tw-flex-1 tw-min-w-[300px]">
              <a class="ui basic button tw-px-3 tw-gap-3" title={wikiLocale.file_revision} href={`${repoLink}/wiki/${pageUrl}?action=_revision`}>
                {data.page.commit_count > 0 ? <span>{data.page.commit_count}</span> : null}
                <Icon name="octicon-history" />
              </a>
              <div class="tw-flex-1 gt-ellipsis">
                {data.title}
                <div class="ui sub header gt-ellipsis">{lastEdited}</div>
              </div>
            </div>
            <div class="repo-button-row">
              {writer ? (
                <>
                  <a class="ui small button" href={`${repoLink}/wiki/${pageUrl}?action=_edit`}>
                    {wikiLocale.edit_page_button}
                  </a>
                  <a class="ui small primary button" href={`${repoLink}/wiki?action=_new`}>
                    {wikiLocale.new_page_button}
                  </a>
                  {/* The link-action delete (view.tmpl:53): the JS POSTs
                      data-url; no-JS the anchor is inert (upstream same). */}
                  <a
                    class="ui small red button link-action"
                    href="#"
                    data-modal-confirm="#repo-wiki-delete-page-modal"
                    data-url={`${repoLink}/wiki/${pageUrl}?action=_delete`}
                  >
                    {wikiLocale.delete_page_button}
                  </a>
                </>
              ) : null}
            </div>
          </div>
        </div>
        {/* The content parts (view.tmpl:64-95): no TOC arm, no escape
            prompt (module header); `with-sidebar` keys on the sidebar. */}
        <div class="wiki-content-parts">
          <div
            class={`render-content markup wiki-content-main ${data.sidebarHtml !== "" ? "with-sidebar" : ""}`}
            dangerouslySetInnerHTML={{ __html: data.contentHtml }}
          />
          {data.sidebarHtml !== "" ? (
            <div class="render-content markup wiki-content-sidebar">
              {writer ? (
                <a class="tw-float-right muted" href={`${repoLink}/wiki/_Sidebar?action=_edit`} aria-label={wikiLocale.edit_page_button}>
                  <Icon name="octicon-pencil" />
                </a>
              ) : null}
              <div dangerouslySetInnerHTML={{ __html: data.sidebarHtml }} />
            </div>
          ) : null}
          <div class="tw-clear-both" />
          {data.footerHtml !== "" ? (
            <div class="render-content markup wiki-content-footer">
              {writer ? (
                <a class="tw-float-right muted" href={`${repoLink}/wiki/_Footer?action=_edit`} aria-label={wikiLocale.edit_page_button}>
                  <Icon name="octicon-pencil" />
                </a>
              ) : null}
              <div dangerouslySetInnerHTML={{ __html: data.footerHtml }} />
            </div>
          ) : null}
        </div>
      </div>
      {/* The delete confirm modal (view.tmpl:99-103 + modal_actions_confirm's
          default Yes/No arm; octicon-x/check are not in the allowlist — text
          only). */}
      <dialog class="modal-dialog" id="repo-wiki-delete-page-modal">
        <div class="header">
          <Icon name="octicon-trash" /> {wikiLocale.delete_page_button}
        </div>
        <div class="content">
          <p>{wikiLocale.delete_page_notice_1.replace("%s", data.title)}</p>
        </div>
        <div class="actions">
          <button type="button" class="ui cancel button">
            {wikiLocale.modal_no}
          </button>
          <button type="submit" class="ui primary ok button">
            {wikiLocale.modal_yes}
          </button>
        </div>
      </dialog>
    </BaseLayout>
  );
}

/** The full-document PAGES-LIST render (tplWikiPages — wiki.go:594). */
export function renderWikiPagesPage(options: { ctx: UiContext; data: Extract<WikiPagesData, { outcome: "pages" }>; canWrite: boolean }): string {
  return renderPage(<WikiPagesPage ctx={options.ctx} data={options.data} canWrite={options.canWrite} />);
}

/** pages.tmpl (discriminator: pages.tmpl:2's `repository wiki pages`). */
export function WikiPagesPage(props: { ctx: UiContext; data: Extract<WikiPagesData, { outcome: "pages" }>; canWrite: boolean }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("WikiPagesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={wikiLocale.pages} pageClass="repository wiki pages" activeTab="code">
      <div class="ui container">
        <h2 class="ui header flex-left-right">
          <span>{wikiLocale.pages}</span>
          <span>
            {props.canWrite && !repo.isMirror ? (
              <a class="ui small primary button" href={`${repoLink}/wiki?action=_new`}>
                {wikiLocale.new_page_button}
              </a>
            ) : null}
          </span>
        </h2>
        {/* pages.tmpl:13's Permission.IsAdmin line — ours = the repo default
            branch (the wikiBranch value, services/wiki.ts:348). */}
        {(ctx.viewer.kind === "user" && ctx.viewer.isAdmin) ? (
          <div>
            {wikiLocale.default_branch} {repo.defaultBranch}
          </div>
        ) : null}
        <table class="ui table selectable wiki-pages-list">
          <tbody>
            {data.pages.map((pageMeta) => (
              <tr>
                <td>
                  <Icon name="octicon-file" />
                  <a href={`${repoLink}/wiki/${pageMeta.subUrl}`}>{pageMeta.name}</a>
                  <a
                    class="wiki-git-entry"
                    href={`${repoLink}/wiki/${pathEscapeSegments(pageMeta.gitEntryName)}`}
                    data-tooltip-content={wikiLocale.original_git_entry_tooltip}
                  >
                    {/* pages.tmpl:21 octicon-chevron-right — not in the
                        allowlist; octicon-link stands in. */}
                    <Icon name="octicon-link" />
                  </a>
                </td>
                <td class="tw-text-right">
                  {pageMeta.updatedUnix === null ? null : (
                    <>
                      {localePrefix(wikiLocale.last_updated)}
                      <TimeSince unixSeconds={pageMeta.updatedUnix} tz="+0000" />
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BaseLayout>
  );
}

/** The full-document NEW-form render (tplWikiNew, PageIsWikiEdit=false —
 *  wiki.go:662). `initialTitle`: "" (has wiki), "Home" (no wiki), or the
 *  `?title=` value — the mount wave's arm (wiki.go:655-660). */
export function renderWikiNewPage(options: { ctx: UiContext; initialTitle: string; error: string | null }): string {
  return renderPage(
    <WikiFormPage
      ctx={options.ctx}
      isEdit={false}
      documentTitle={wikiLocale.new_page}
      pageUrl=""
      content={wikiLocale.welcome}
      initialTitle={options.initialTitle}
      error={options.error}
    />,
  );
}

/** The full-document EDIT-form render (tplWikiNew, PageIsWikiEdit=true —
 *  wiki.go:702; the document title is the page's display name,
 *  wiki.go:393-395). */
export function renderWikiEditPage(options: { ctx: UiContext; data: Extract<WikiEditData, { outcome: "edit" }>; error: string | null }): string {
  return renderPage(
    <WikiFormPage
      ctx={options.ctx}
      isEdit={true}
      documentTitle={options.data.title}
      pageUrl={options.data.pageUrl}
      content={options.data.content}
      initialTitle={options.data.title}
      error={options.error}
    />,
  );
}

/** new.tmpl (discriminator: `repository wiki` — the view's class; the
 *  PageIsWikiEdit arm switches the header, the form action, the cancel href
 *  and the content prefill). The combomarkdowneditor reduces to the landed
 *  plain textarea (id="edit_area" — the file-editor reduction). */
export function WikiFormPage(props: {
  ctx: UiContext;
  isEdit: boolean;
  /** The <title>/aria-label part (edit: the page's name; new: "Page"). */
  documentTitle: string;
  /** The WebPath (the edit arm — the cancel href's tail). */
  pageUrl: string;
  /** The textarea's initial content (edit: the page's; new: the welcome). */
  content: string;
  initialTitle: string;
  error: string | null;
}) {
  const ctx = props.ctx;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("WikiFormPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // new.tmpl:12 — the literal relative action (posts to the current URL; the
  // _edit value lands in WikiPost's DEFAULT arm — module header grammar).
  const action = props.isEdit ? "?action=_edit" : "?action=_new";
  // new.tmpl:37's {{.Link}} — the page's own canonical URL (ctx.Link).
  const cancelHref = props.isEdit ? `${repoLink}/wiki/${props.pageUrl}?action=_edit` : `${repoLink}/wiki?action=_new`;
  return (
    <BaseLayout ctx={ctx} title={props.documentTitle} pageClass="repository wiki" activeTab="code">
      <div class="ui container">
        {/* new.tmpl:5's base/alert — the error slot. */}
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        <div class="ui header flex-left-right">
          {wikiLocale.new_page}
          {props.isEdit ? (
            <a class="ui tiny primary button" href={`${repoLink}/wiki?action=_new`}>
              {wikiLocale.new_page_button}
            </a>
          ) : null}
        </div>
        <form class="ui form form-fetch-action" action={action} method="post">
          <div class="field">
            <input name="title" value={props.initialTitle} aria-label={wikiLocale.page_title} placeholder={wikiLocale.page_title} autofocus required />
          </div>
          <div class="help">{wikiLocale.page_name_desc}</div>
          <div class="field">
            {/* The combomarkdowneditor reduction: the plain visible textarea
                (the file-editor's CodeMirror reduction). */}
            <textarea id="edit_area" name="content" class="tw-font-mono" rows={20} placeholder={wikiLocale.page_content}>
              {props.content}
            </textarea>
          </div>
          <div class="field tw-mt-4">
            <input name="message" aria-label={wikiLocale.default_commit_message} placeholder={wikiLocale.default_commit_message} />
          </div>
          <div class="divider" />
          <div class="flex-text-block tw-justify-end">
            <a class="ui basic cancel button" href={cancelHref}>
              Cancel
            </a>
            <button type="submit" class="ui primary button">
              {wikiLocale.save_page}
            </button>
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}

/** The full-document REVISION render (tplWikiRevision — wiki.go:532). */
export function renderWikiRevisionPage(options: { ctx: UiContext; data: Extract<WikiRevisionData, { outcome: "revision" }> }): string {
  return renderPage(<WikiRevisionPage ctx={options.ctx} data={options.data} />);
}

/** revision.tmpl (discriminator: revision.tmpl:2's `repository wiki
 *  revisions`). */
export function WikiRevisionPage(props: { ctx: UiContext; data: Extract<WikiRevisionData, { outcome: "revision" }> }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("WikiRevisionPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const pageUrl = data.pageUrl;
  const revisionHref = (page: number): string =>
    page <= 1 ? `${repoLink}/wiki/${pageUrl}?action=_revision` : `${repoLink}/wiki/${pageUrl}?action=_revision&page=${page}`;
  const lastEdited =
    data.lastCommit === null
      ? null
      : (() => {
          const unix = wikiDateToUnixSeconds(data.lastCommit.commiter.date);
          if (unix === null) return null;
          return (
            <>
              {lastEditedPrefix(data.lastCommit.commiter.name)}
              <TimeSince unixSeconds={unix} tz="+0000" />
            </>
          );
        })();
  return (
    <BaseLayout ctx={ctx} title={data.title} pageClass="repository wiki revisions" activeTab="code">
      <div class="ui container">
        {/* The header row (revision.tmpl:6-20). */}
        <div class="ui dividing header flex-left-right">
          <div class="flex-text-block">
            <a class="ui basic button tw-px-3" title={wikiLocale.back_to_wiki} href={`${repoLink}/wiki/${pageUrl}`}>
              {/* revision.tmpl:8 octicon-home — not in the allowlist;
                  octicon-repo stands in (the missing-glyph rule). */}
              <Icon name="octicon-repo" />
            </a>
            <div class="tw-flex-1 gt-ellipsis">
              {data.title}
              <div class="ui sub header gt-ellipsis">{lastEdited}</div>
            </div>
          </div>
          <div class="flex-text-block">
            {/* revision.tmpl:18's clone_panel — unrendered (module header). */}
          </div>
        </div>
        <h2 class="ui top header">{wikiLocale.wiki_page_revisions}</h2>
        <div class="tw-mt-4">
          <h4 class="ui top attached header">
            <div class="ui stackable grid">
              <div class="sixteen wide column">
                {data.count} {wikiLocale.commits}
              </div>
            </div>
          </h4>
          {data.commits.length > 0 && data.count > 0 ? <CommitList repoLink={repoLink} commits={data.commits.map(wikiCommitAsEngineCommit)} /> : null}
          {/* base/paginate — the family's Newer/Older reduction with the
              action-carrying hrefs (CommitsPagination's DOM shape). */}
          {data.page > 1 || data.page * WIKI_REVISIONS_PAGE_SIZE < data.count ? (
            <div class="center page buttons">
              <div class="ui borderless pagination menu">
                {data.page > 1 ? (
                  <a class="item navigation" href={revisionHref(data.page - 1)}>
                    <span class="navigation_label">{wikiLocale.newer}</span>
                  </a>
                ) : null}
                {data.page * WIKI_REVISIONS_PAGE_SIZE < data.count ? (
                  <a class="item navigation" href={revisionHref(data.page + 1)}>
                    <span class="navigation_label">{wikiLocale.older}</span>
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Re-exports (the codec spell the mount wave needs at the POST arms)
// ---------------------------------------------------------------------------

export { webPathFromRequest };
