/**
 * The in-repo CODE SEARCH page — the census's R10 UI half (the gap census's
 * impact #8) over the SPEC-0015 M1 grep RPC:
 *
 *   GET /{owner}/{repo}/search   web.go:1768 `m.Get("/search", reqUnitCodeReader,
 *                                repo.Search)` — routers/web/repo/search.go:22
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * templates/repo/search.tmpl renders the repo header + one `ui container`
 * holding templates/shared/search/code/search.tmpl: the query bar
 * (shared/search/combo), a divider, then the results area. Page discriminator
 * `page-content repository file list` (search.tmpl:2); `PageIsViewCode` arms
 * the navbar's Code tab (search.go:23). The route group (web.go:1764-1773)
 * carries `optSignIn, context.RepoAssignment` + `reqUnitCodeReader` on the
 * route — NO MustBeNotEmpty (unlike the code-read group above it).
 *
 * The form fields (verified against shared/search/combo.tmpl +
 * shared/search/input.tmpl): `q` (type=search, maxlength 255, placeholder
 * "search.code_kind" = "Search code…") and `search_mode` ONLY. Upstream has
 * NO path-filter field on this page — the language picker renders only off
 * indexer-provided SearchResultLanguages (never on the gitgrep path) and the
 * instance include/exclude pathspecs fold in from config, not the form. Our
 * page accepts `?path=` as a URL-driven passthrough to the RPC's path arm
 * (SPEC-0015 §3.1's ledgered reduction of those pathspecs) but renders no
 * field for it — upstream-verbatim form.
 *
 * Modes: `search_mode` ∈ exact|words|regexp (indexer.GitGrepSupportedSearchModes,
 * indexer.go:46-53 — fuzzy is NOT offered on the gitgrep path). Upstream's
 * default is WORDS at EXECUTION time (gitgrep.go:28's switch falls through)
 * while the combo template DISPLAYS the first item when the URL names no
 * known mode (combo.tmpl's `{{$selected := index .SearchModes 0}}` = exact).
 * Both halves are reproduced: the loader executes an absent/unknown mode as
 * words, and the select echoes only a KNOWN raw value — absent/unknown
 * leaves the first option (exact) displaying. Upstream's rendered form also
 * always SUBMITS a mode (the dropdown's hidden input pins the displayed
 * value); the native select submits its visible option the same way.
 *
 * Results: one card per matching file
 * (shared/search/code/results.tmpl's `diff-file-box … repo-search-result`
 * shape — in-repo arm, `$.Repo` is always set so the card header carries the
 * bare filename), the match lines through shared/searchfile.tmpl's
 * code-view table (`lines-num` anchor → the file permalink's `#L{n}`,
 * `lines-code chroma` + `code-inner`). Upstream PAGES the capped result
 * blocks (gitgrep.go:50-53 slices the ≤50-file answer into
 * setting.UI.RepoSearchPagingNum = 20 pages, ui.go:90) with base/paginate
 * rendering when TotalPages > 1; total = the CAPPED count there (grep.go:77's
 * silent MaxResultLimit 50 + CancelPipeline at grep.go:109). The pager hrefs
 * echo q + the EXECUTED mode (+ the path filter when the URL carried it), so
 * paging never flips the executed mode.
 *
 * ## The truncation notice (the SPEC-ledgered divergence)
 *
 * Upstream caps SILENTLY at 50 result blocks and its pager shows the capped
 * total; our grep RPC answers the same ≤50 block cap but flags `truncated`
 * and reports `total` = the pre-cap count (the blame budget-exit rule —
 * "a budget-bounded scan is never presented complete"). This page renders
 * the honesty field as an info message above the results — "the first 50 of
 * N matching files" when the scan counted past the cap, the plain
 * partial-scan sentence when a budget exit stopped the count itself (or
 * before any block surfaced). The notice renders on the no-results arm too:
 * a partial scan that surfaced nothing is not upstream's clean
 * "No matching results found." state.
 *
 * ## Highlight mechanism (verified at the pin)
 *
 * Server-side only: gitgrep.PerformSearch runs the chroma lexer over the
 * matched lines (HighlightSearchResultCode, indexer/code/search.go:73-88)
 * and the template inserts the pre-highlighted HTML verbatim — there is NO
 * client-side highlight JS for this page and NO term-emphasis wrapper
 * (searchResult's active-match writes are contiguous plain slices,
 * search.go:104-108). Our engine RPC returns raw line text and workerd has
 * no chroma, so the SSR renders the line ESCAPED in the same cell markup
 * (`lines-code chroma` + `code-inner`) — markup classes byte-identical,
 * syntax coloring absent (the file-view code-view precedent, the documented
 * reduction).
 *
 * ## Arms (search.go:22-68 mapped)
 *
 * - `q` empty/absent → the bare form page, 200, NO engine call (search.go:25-28
 *   returns before the ref resolution — an empty repo renders the form too).
 * - The search runs against the repo's DEFAULT BRANCH (search.go:62 —
 *   git.RefNameFromBranch(DefaultBranch)), not the engine's HEAD convention.
 * - Unresolvable default branch (unborn default branch / empty repo) →
 *   upstream ServerErrors 500 (gitgrep's exit-128 TODO at gitgrep.go:63);
 *   ours 404-shells — the blame/activity engine-absence convention, the
 *   documented reduction.
 * - `page` ≤ 0 → 1 (search.go:30-33).
 * - The visibility read IS the reqUnitCodeReader gate (the code unit has no
 *   landed toggle — the repo-activity group-gate precedent): invisible repos
 *   404-shell in the shared prologue, existence stays hidden.
 */

import type { GrepResult } from "@cf-gitea/git-engine";

import type { EngineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (upstream locale keys, locale_en-US.json at the pin). */
export const searchPageLocale = {
  /** "search.code_kind" — the input's placeholder */
  code_kind: "Search code…",
  /** "search.search" — the submit button's aria-label */
  search: "Search…",
  /** "search.type_tooltip" */
  type_tooltip: "Search type",
  /** "search.exact" */
  exact: "Exact",
  /** "search.words" */
  words: "Words",
  /** "search.regexp" */
  regexp: "Regexp",
  /** "search.exact_tooltip" */
  exact_tooltip: "Include only results that match the exact search term",
  /** "search.words_tooltip" */
  words_tooltip: "Include only results that match the search term words",
  /** "search.regexp_tooltip" */
  regexp_tooltip: "Include only results that match the regexp search term",
  /** "search.code_search_by_git_grep" — the always-on gitgrep notice (our
   *  posture IS the non-indexed path; upstream's IsRepoIndexerEnabled=false arm) */
  by_git_grep:
    'Current code search results are provided by "git grep". There might be better results if site administrator enables Repository Indexer.',
  /** "search.no_results" */
  no_results: "No matching results found.",
  /** "search.code_empty" */
  code_empty: "Start a code search.",
  /** "search.code_empty_description" */
  code_empty_description: "Enter a keyword to search across the code.",
  /** "repo.diff.view_file" */
  view_file: "View File",
  /** the truncated notice, counted-past-cap arm (the SPEC-ledgered honesty
   *  field — upstream caps silently; no upstream analog) */
  truncated_counted: (total: number, shown: number): string =>
    `The search stopped at its result budget — showing the first ${shown} of ${total} matching files.`,
  /** the truncated notice, mid-scan budget-exit arm (the count itself was
   *  cut, or nothing surfaced before the exit) */
  truncated_partial:
    "The search stopped at its scan budget before finishing the repository — results may be partial.",
} as const;

/** Upstream `setting.UI.RepoSearchPagingNum` (ui.go:90) — result blocks per
 *  page; gitgrep.go:50-53 slices the ≤50-file answer into these. */
export const REPO_SEARCH_PAGE_SIZE = 20;

/** The gitgrep execution modes (indexer.GitGrepSupportedSearchModes' order —
 *  exact, words, regexp; fuzzy is indexer-only). */
const SEARCH_MODES = ["exact", "words", "regexp"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** The mode label/tooltip pair (the locale strings above, upstream order). */
const MODE_META: Record<SearchMode, { label: string; tooltip: string }> = {
  exact: { label: searchPageLocale.exact, tooltip: searchPageLocale.exact_tooltip },
  words: { label: searchPageLocale.words, tooltip: searchPageLocale.words_tooltip },
  regexp: { label: searchPageLocale.regexp, tooltip: searchPageLocale.regexp_tooltip },
};

/** The EXECUTED mode — upstream gitgrep.go:28-35's switch: exact and regexp
 *  map by name, EVERYTHING else (absent, empty, unknown) executes as words. */
export function parseSearchMode(raw: string | null): SearchMode {
  for (const mode of SEARCH_MODES) {
    if (raw === mode) return mode;
  }
  return "words";
}

/** The DISPLAYED mode — the raw URL value when it names a known mode, else
 *  `null` (combo.tmpl's first-item display; a native select without an
 *  explicit selected attribute shows its first option). */
export function parseDisplayMode(raw: string | null): SearchMode | null {
  for (const mode of SEARCH_MODES) {
    if (raw === mode) return mode;
  }
  return null;
}

/** The grep answer subset the page renders. */
export type RepoSearchPageData =
  | {
      /** The bare-form arm: `q` was empty (search.go:25-28) — no engine call
       *  was made and every result field is absent. */
      bare: true;
      keyword: "";
      /** The EXECUTED mode (parseSearchMode — absent/unknown = words). */
      selectedMode: SearchMode;
      /** The DISPLAYED mode (the raw URL value when known, else null — the
       *  select shows its first option, combo.tmpl's quirk). */
      displayMode: SearchMode | null;
    }
  | {
      bare: false;
      /** The trimmed keyword (echoed into the form's value). */
      keyword: string;
      /** The EXECUTED mode. */
      selectedMode: SearchMode;
      /** The DISPLAYED mode. */
      displayMode: SearchMode | null;
      /** The path prefix filter, when the URL carried `?path=` (the SPEC
       *  §3.1 pathspec-reduction arm — never rendered as a form field). */
      path: string;
      /** 1-based, clamped (search.go:30-33). */
      page: number;
      /** The resolved tip oid — every card's CommitID (gitgrep.go:56: the
       *  same resolved tip per result). */
      commitId: string;
      /** The RPC's ≤50 result blocks for THIS page slice (gitgrep.go:50-53). */
      results: GrepResult["results"];
      /** The RPC's FULL returned block count (≤50) before this page's slice —
       *  the truncation notice's "showing the first N" number. */
      resultCount: number;
      /** The RPC's honest pre-cap matching-file count (upstream reports the
       *  capped len instead — the truncation-notice arm's number). */
      total: number;
      /** Any budget exit (the honesty field — the notice renders when set). */
      truncated: boolean;
      /** Result pages over the returned blocks (upstream's pager total = the
       *  capped count; ours = the same ≤50 sliceable blocks). */
      pageCount: number;
    };

/**
 * Load the search page. `null` = the engine answered null for the grep on
 * the default branch — an unresolvable ref (unborn default branch / empty
 * repo) or a transport failure; the caller 404-shells (upstream ServerErrors
 * the unborn branch — the documented reduction). The BARE arm (`q` empty)
 * never reaches the engine.
 */
export async function loadRepoSearchData(
  engine: EngineClient,
  repo: { defaultBranch: string },
  params: URLSearchParams,
): Promise<RepoSearchPageData | null> {
  const rawMode = params.get("search_mode");
  const keyword = (params.get("q") ?? "").trim();
  const selectedMode = parseSearchMode(rawMode);
  const displayMode = parseDisplayMode(rawMode);
  if (keyword === "") return { bare: true, keyword: "", selectedMode, displayMode };

  const path = (params.get("path") ?? "").trim();
  const rawPage = params.get("page");
  const parsedPage = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1; // search.go:30-33

  const result = await engine.grep(repo.defaultBranch, {
    q: keyword,
    mode: selectedMode,
    path: path === "" ? undefined : path,
  });
  if (result === null) return null; // unresolvable default branch / transport

  // gitgrep.go:50-53's slice, verbatim: page windows over the returned
  // blocks (≤50), clamped at both ends.
  const pageStart = Math.min((page - 1) * REPO_SEARCH_PAGE_SIZE, result.results.length);
  const pageEnd = Math.min(page * REPO_SEARCH_PAGE_SIZE, result.results.length);
  return {
    bare: false,
    keyword,
    selectedMode,
    displayMode,
    path,
    page,
    commitId: result.commit,
    results: result.results.slice(pageStart, pageEnd),
    resultCount: result.results.length,
    total: result.total,
    truncated: result.truncated,
    pageCount: Math.max(1, Math.ceil(result.results.length / REPO_SEARCH_PAGE_SIZE)),
  };
}

/** The file permalink shape — results.tmpl:27's View File target and
 *  searchfile.tmpl:9's line anchor (`$repo.Link/src/commit/{CommitID}/
 *  {PathEscapeSegments Filename}`). */
function filePermalink(repoLink: string, commitId: string, path: string): string {
  return `${repoLink}/src/commit/${encodeURIComponent(commitId)}/${pathEscapeSegments(path)}`;
}

/** One result card (results.tmpl:14-33, the in-repo arm — `$.Repo` always
 *  set, so no repo-prefix header span) with its searchfile.tmpl line table.
 *  The line table rides the `code-view` presentational exemption (the a11y
 *  R6 note — upstream's line tables carry no header semantics). */
function SearchHit(props: { repoLink: string; commitId: string; hit: GrepResult["results"][number] }) {
  const permalink = filePermalink(props.repoLink, props.commitId, props.hit.path);
  return (
    <div class="diff-file-box file-content non-diff-file-content repo-search-result">
      <h4 class="ui top attached header tw-font-normal flex-text-block tw-flex-wrap tw-py-2">
        <span class="file tw-flex-1">{props.hit.path}</span>
        <a role="button" class="ui basic tiny button" rel="nofollow" href={permalink}>
          {searchPageLocale.view_file}
        </a>
      </h4>
      <div class="ui attached table segment">
        <div class="file-body file-code code-view">
          <table>
            <tbody>
              {props.hit.lines.map((line) => (
                <tr>
                  <td class="lines-num">
                    <a href={`${permalink}#L${line.num}`}>
                      <span>{line.num}</span>
                    </a>
                  </td>
                  <td class="lines-code chroma">
                    <code class="code-inner">{line.code}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** The query bar (shared/search/combo + input + button): the q input, the
 *  native-select mode stand-in for the Fomantic dropdown (the file-editor
 *  milestone precedent), the submit button. `displayMode === null` leaves
 *  every option unselected — the first option (exact) displays, combo
 *  tmpl's quirk. */
function SearchForm(props: { action: string; keyword: string; displayMode: SearchMode | null }) {
  return (
    <form class="ui form ignore-dirty" method="get" action={props.action}>
      <div class="ui small fluid action input">
        <input
          type="search"
          name="q"
          value={props.keyword === "" ? undefined : props.keyword}
          maxlength={255}
          spellcheck={false}
          placeholder={searchPageLocale.code_kind}
        />
        <select
          name="search_mode"
          class="ui small dropdown selection"
          title={searchPageLocale.type_tooltip}
          aria-label={searchPageLocale.type_tooltip}
        >
          {SEARCH_MODES.map((mode) => (
            <option value={mode} selected={props.displayMode === mode} title={MODE_META[mode].tooltip}>
              {MODE_META[mode].label}
            </option>
          ))}
        </select>
        <button type="submit" class="ui small icon button" aria-label={searchPageLocale.search}>
          <Icon name="octicon-search" />
        </button>
      </div>
    </form>
  );
}

/** The pager (base/paginate's shape when TotalPages > 1): prev/numbered/
 *  next over the query-preserving hrefs. The page window is the full 1..N
 *  list — N ≤ 3 on every real answer (50 results / 20 per page), so no
 *  ellipsis arm exists to port; upstream's first/last navigation items only
 *  ever target pages 1/N which the numbered items already carry, so they
 *  are omitted rather than duplicated. Disabled arms render the upstream
 *  `disabled item` anchors (paginate's {{if}} bodies drop the href on the
 *  inert arms). */
function SearchPagination(props: {
  basePath: string;
  keyword: string;
  selectedMode: SearchMode;
  path: string;
  page: number;
  pageCount: number;
}) {
  if (props.pageCount <= 1) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    params.set("q", props.keyword);
    params.set("search_mode", props.selectedMode);
    if (props.path !== "") params.set("path", props.path);
    if (page > 1) params.set("page", String(page));
    return `${props.basePath}?${params.toString()}`;
  };
  const pages = Array.from({ length: props.pageCount }, (_v, i) => i + 1);
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">Previous</span>
          </a>
        ) : (
          <a class="disabled item navigation">
            <span class="navigation_label">Previous</span>
          </a>
        )}
        {pages.map((num) =>
          num === props.page ? (
            <a class="active item">{num}</a>
          ) : (
            <a class="item" href={href(num)}>
              {num}
            </a>
          ),
        )}
        {props.page < props.pageCount ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">Next</span>
          </a>
        ) : (
          <a class="disabled item navigation">
            <span class="navigation_label">Next</span>
          </a>
        )}
      </div>
    </div>
  );
}

/** The page body (search.tmpl:2-7 + shared/search/code/search.tmpl): the
 *  form, the divider, then the `ui list` — the always-on gitgrep notice,
 *  the truncation notice (any budget exit), and the results / no-results /
 *  empty-placeholder arms. */
export function RepoSearchPage(props: { ctx: UiContext; data: RepoSearchPageData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSearchPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const title = `${repo.ownerNamespace}/${repo.slug}`;
  const truncationNotice =
    !data.bare && data.truncated ? (
      <div class="ui info message">
        <p>
          {data.resultCount > 0 && data.total > data.resultCount
            ? searchPageLocale.truncated_counted(data.total, data.resultCount)
            : searchPageLocale.truncated_partial}
        </p>
      </div>
    ) : null;
  return (
    <BaseLayout ctx={ctx} title={title} pageClass="repository file list" activeTab="code">
      <div class="ui container">
        <SearchForm action={`${repoLink}/search`} keyword={data.keyword} displayMode={data.displayMode} />
        <div class="divider" />
        <div class="ui list">
          <div class="ui message">
            <p>{searchPageLocale.by_git_grep}</p>
          </div>
          {data.bare ? (
            <div class="empty-placeholder">
              <Icon name="octicon-search" size={48} />
              <h2>{searchPageLocale.code_empty}</h2>
              <p>{searchPageLocale.code_empty_description}</p>
            </div>
          ) : data.results.length > 0 ? (
            <>
              {truncationNotice}
              <div class="repository search">
                {data.results.map((hit) => (
                  <SearchHit repoLink={repoLink} commitId={data.commitId} hit={hit} />
                ))}
              </div>
              <SearchPagination
                basePath={`${repoLink}/search`}
                keyword={data.keyword}
                selectedMode={data.selectedMode}
                path={data.path}
                page={data.page}
                pageCount={data.pageCount}
              />
            </>
          ) : (
            <>
              {truncationNotice}
              <div>{searchPageLocale.no_results}</div>
            </>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The serialized page (the render.tsx pattern). */
export function renderRepoSearchPage(options: { ctx: UiContext; data: RepoSearchPageData }): string {
  return renderPage(<RepoSearchPage ctx={options.ctx} data={options.data} />);
}
