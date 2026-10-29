/**
 * The EXPLORE code search page — the census's R02 UI half (SPEC-0019 §3.2,
 * milestone M2) over the federation loader (pages/code-search-federation.ts)
 * and the LANDED grep RPC:
 *
 *   GET /explore/code   web.go:558 `m.Get("/code", explore.Code)` in the
 *                       /explore group (web.go:549-557) — routers/web/explore/
 *                       code.go:25
 *
 * ## The ratified disposition (SPEC-0019 §8 question 1 — the capped PAGE)
 *
 * Upstream gates the route on `!setting.Indexer.RepoIndexerEnabled ||
 * setting.Service.Explore.DisableCodePage` → redirect to `/explore`
 * (code.go:26-29): at DEFAULT config the page IS a redirect. The §8
 * ratification shipped the PROPOSAL arm — the capped federated page — with
 * the redirect recorded as the one-line flip we did NOT take (§3.2). The
 * kill-switch (`DISABLE_CODE_PAGE`) has no v1 analog (§5.10 — the over-cap
 * notice is the degradation path).
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * templates/explore/code.tmpl is the explore NAVBAR (the tab strip — this
 * page's active tab is the navbar's Code item, navbar.tmpl:17) + the shared
 * search block inside one container. Its page-content class is upstream's own
 * reuse — `page-content explore users` (explore/code.tmpl:3; the orgs page
 * carries the same class for the same reason). Title = `explore_title`
 * ("Explore", code.go:35). The handler's arms: empty `q` renders the bare
 * form and returns (code.go:40-43 — NO scope query, NO search); a keyword
 * resolves the repo scope — `FindUserCodeAccessibleRepoIDs(ctx, doer)` for
 * guests and non-admins (code.go:61, repo_list.go:744-748 over
 * `AccessibleRepositoryCondition` at unit.TypeCode) while an ADMIN searches
 * UNFILTERED (code.go:55-66 — the `repoIDs` list stays empty and the search
 * runs unguarded) — then one indexed search over that filter, deleted-repo
 * results cleaned post-search (code.go:110-120 — ours never surface them:
 * visibility is enforced BEFORE the fan-out, §5.4), pager at 20 (code.go:126).
 * This page renders NO union pager (§3.3 item 3 — upstream pages the
 * indexer's exact global count; the federation renders one capped grouped
 * page), and the language facet has no federation analog (§3.3 item 2).
 *
 * ## The seed posture (the instance-wide arm — this module's new logic)
 *
 * The loader carries the owner-scoped seeds (R05's user/org halves); the
 * INSTANCE arm lands HERE (pages/code-search-federation.ts stays untouched —
 * the loader is a consumed substrate, not this module's file). The predicate
 * is the explore REPOS tab's seeding mirrored (the landed discovery surface's
 * own scope — `searchExploreRepos` → services/repository.ts
 * `visibilityConditions(viewer, includePrivate: true)`):
 *
 * - anonymous → `visibility = 'public'` rows (the landed listing's anonymous
 *   arm — no owner join);
 * - signed-in non-admin → public ∪ OWN repos (∪ the team/collaborator grant
 *   EXISTS arms) — the `includePrivate` arm re-issued;
 * - site admin → UNFILTERED (code.go:55-66's isAdmin arm —
 *   `visibilityConditions`' admin arm is the same call).
 *
 * The grant EXISTS arms are `services/repository.ts` privates re-issued
 * verbatim (`teamGrantCondition`/`collaboratorGrantCondition`) — api/services
 * is not this wave's file ownership, the documented re-issue precedent
 * (search.ts's searchUsers re-issue; explore.tsx's exploreUserOrderBy
 * re-issue). Recorded reduction vs upstream's `AccessibleRepositoryCondition`:
 * a PUBLIC repo under a limited/private OWNER seeds for every viewer exactly
 * as the explore repos page lists it (with the Private badge) — the code page
 * is never narrower (nor wider) than the instance's own discovery surface for
 * the same viewer; upstream's `PublicRepoUnderPublicOwnerCond` narrowing
 * (repo_list.go:755-763) is the alternative posture, not taken. The seed
 * order is the ratified `updated_unix DESC, id DESC` (§8 question 3) —
 * SQL-level, NULL updatedAt sorts last under DESC, byte-identical to the
 * loader's user arm. One full projection read, no page walk: the cap covers
 * the ordered top slice and the FULL count rides `totalVisible` for the
 * over-cap notice (§5.1 — never a silent truncation).
 *
 * ## The render (the R05 module's components re-issued)
 *
 * The R05 page (pages/user-code-search.tsx) owns the federated render — its
 * components are module-private and that file is outside this wave's
 * ownership, so the shared block is re-issued here verbatim: the mode form
 * (exact|words only, §3.3 item 1's parse/display split), the always-on scan
 * notice, the over-cap notice, the per-repo truncation hoists (the R10
 * message pair, repo-prefixed), the `owner/repo` result cards
 * (shared/search/code/results.tmpl's `{{if not $.Repo}}` arm — the R02/R05
 * template shape; upstream loads RepoMaps for the card headers at
 * explore/code.go:102-108), and the file line tables. Upstream renders BOTH
 * pages through ONE shared template (shared/search/code/search.tmpl) — the
 * two-module shape mirrors that reality, one copy of the copy per module.
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * This module is fully self-contained (seed + loader + render); the route
 * lands in the orchestrator's window (ui/index.ts was an integrator sibling's
 * file at write time). The exact arms, mirroring the explore literals:
 *
 * 1. Interface: `ExploreRoute.family` gains `"explore-code"`.
 * 2. Parse arm (in the `raw[1] === "explore"` block, beside the
 *    organizations literal): `if (raw.length === 3 && raw[2] === "code")
 *    return { family: "explore-code" };` — the exact 3-segment shape; deeper
 *    tails stay unclaimed (the engine 404).
 * 3. Import: `import { loadExploreCodeSearchData, renderExploreCodePage }
 *    from "./pages/explore-code";`
 * 4. Handler (the exploreReposPage twin):
 *
 *     async function exploreCodePage(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const resolved = await resolveUiSession(c);
 *       if (!resolved.ok) return resolved.response;
 *       const { url, ctx, viewer, respond } = resolved;
 *       const data = await loadExploreCodeSearchData(c.env, c.env.DB, viewer, url.searchParams);
 *       return respond(c.html(renderExploreCodePage(ctx, data), 200));
 *     }
 *
 * 5. Registration (the static block, beside the explore literals — static
 *    before dynamic, the wave-9 precedence note):
 *    `uiRouter.get("/explore/code", (c) => exploreCodePage(c));`
 * 6. The neighbor suite's re-arm: pages/explore.matrix.test.ts pins
 *    `/explore/code` UNCLAIMED (the claim-pin describe block's first test,
 *    the 404s-unclaimed test, and the trailing-slash no-laundering
 *    assertion) — those pins flip when this registration lands (parse → the
 *    explore-code family, GET → 200, the slash form canonicalizes onto the
 *    now-claimed page).
 */

import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import { engineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  federatedCodeSearch,
  parseFederatedDisplayMode,
  parseFederatedSearchMode,
  type CodeSearchSeed,
  type FederatedCodeSearch,
  type FederatedGrepRow,
  type FederatedSearchMode,
} from "./code-search-federation";
import { ExploreNavbar, exploreLocale } from "./explore";
import { searchPageLocale } from "./repo-search";
import { userCodeSearchLocale } from "./user-code-search";
import type { GrepResult } from "@cf-gitea/git-engine";

// ---------------------------------------------------------------------------
// The doer seam
// ---------------------------------------------------------------------------

/** The instance seed's doer slice: the visibility ladder's three arms read
 *  exactly these fields (anonymous = `id === null`; admin = unfiltered;
 *  the own-repos arm matches the lowercased login against owner_namespace). */
export interface ExploreCodeDoer {
  id: number | null;
  isAdmin: boolean;
  usernameLower: string | null;
}

/** The page viewer → the seed doer (the exploreDoer seam's shape plus the
 *  own-repos arm's namespace key). */
export function exploreCodeDoer(viewer: Viewer): ExploreCodeDoer {
  return viewer.kind === "user"
    ? { id: viewer.id, isAdmin: viewer.isAdmin, usernameLower: viewer.username.toLowerCase() }
    : { id: null, isAdmin: false, usernameLower: null };
}

// ---------------------------------------------------------------------------
// The instance seed (the explore repos posture — the module header)
// ---------------------------------------------------------------------------

/**
 * The grant EXISTS arms — `services/repository.ts`'s
 * `collaboratorGrantCondition`/`teamGrantCondition` re-issued verbatim
 * (module header: api/services is not this wave's file ownership; the
 * search.ts/explore.tsx re-issue precedent). The collaborator row grants
 * read of the private repo regardless of its owner's visibility (upstream
 * `UserCollaborationRepoCond`, repo_list.go:272-282); the team arm covers the
 * org teams whose effective mode is not 'none' (the same units collapse
 * `OrgService.teamRepoAccessMode` computes row-wise).
 */
function collaboratorGrantCondition(userId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM repo_collaborators rc
    WHERE rc.repo_id = ${repositories.id} AND rc.user_id = ${userId}
  )`;
}

function teamGrantCondition(userId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE t.org_id = ${repositories.ownerId}
      AND tm.user_id = ${userId}
      AND (
        t.authorize <> 'none'
        OR EXISTS (
          SELECT 1 FROM json_each(t.units_map) ju
          WHERE ju.value IN ('read', 'write', 'admin', 'owner')
        )
      )
      AND (
        t.includes_all_repositories = 1
        OR EXISTS (
          SELECT 1 FROM team_repo_access tra
          WHERE tra.team_id = t.id AND tra.repo_id = ${repositories.id}
        )
      )
  )`;
}

/** The seed's WHERE arms — `visibilityConditions(viewer, includePrivate:
 *  true)`'s three arms (module header: anonymous = public rows; signed-in
 *  non-admin = public ∪ own ∪ grants; admin = unfiltered, code.go:55-66). */
function exploreCodeVisibilityConditions(doer: ExploreCodeDoer): SQL[] {
  if (doer.id === null) {
    return [eq(repositories.visibility, "public")];
  }
  if (doer.isAdmin) {
    return [];
  }
  return [
    or(
      eq(repositories.visibility, "public"),
      eq(repositories.ownerNamespace, doer.usernameLower ?? ""),
      collaboratorGrantCondition(doer.id),
      teamGrantCondition(doer.id),
    ) as SQL,
  ];
}

/**
 * The INSTANCE-WIDE seed query (SPEC-0019 §3.1 step 1's R02 arm over the
 * explore repos posture — the module header carries the full mapping): every
 * doer-visible repository row, projected to the loader's seed shape, ordered
 * by the ratified `updated_unix DESC, id DESC` (§8 question 3; SQLite sorts
 * NULL updated_at last under DESC — the loader's user arm performs the
 * identical ORDER BY). The query is the ONLY visibility authority (§5.4):
 * no grep is ever issued for an invisible repo.
 */
export async function loadExploreCodeSearchSeeds(d1: D1Database, doer: ExploreCodeDoer): Promise<CodeSearchSeed[]> {
  const where = and(...exploreCodeVisibilityConditions(doer));
  return drizzle(d1)
    .select({
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
      defaultBranch: repositories.defaultBranch,
      isArchived: repositories.isArchived,
    })
    .from(repositories)
    .where(where)
    .orderBy(desc(repositories.updatedAt), desc(repositories.id))
    .all();
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** The R02 page's render inputs. `search === null` is the bare arm (the
 *  early return — no seed read, no engine call). */
export interface ExploreCodeSearchData {
  /** The trimmed keyword (echoed into the form's value). */
  keyword: string;
  /** The EXECUTED mode (parseFederatedSearchMode — absent/unknown = words). */
  selectedMode: FederatedSearchMode;
  /** The DISPLAYED mode (the raw URL value when known, else null — the
   *  select shows its first option, combo.tmpl's quirk). */
  displayMode: FederatedSearchMode | null;
  /** The federation answer — null on the bare arm. */
  search: FederatedCodeSearch | null;
}

/**
 * Load the R02 page (explore/code.go:25-140 over the federation loader): the
 * parse/display mode split, then, for a non-empty keyword, the instance seed
 * and the capped fan-out. The bare arm makes NO seed read and NO engine call
 * (code.go:40-43's early return). The engine seam is the loader's per-repo
 * composition (`engineClient(env, name).grep` — SPEC-0019 §2.5's "a
 * federation loader composes these per repo").
 */
export async function loadExploreCodeSearchData(
  env: Env,
  d1: D1Database,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<ExploreCodeSearchData> {
  const rawMode = params.get("search_mode");
  const keyword = (params.get("q") ?? "").trim();
  const selectedMode = parseFederatedSearchMode(rawMode);
  const displayMode = parseFederatedDisplayMode(rawMode);

  // The bare arm stops HERE — no seed read, no engine call (code.go 40-43's
  // early return).
  const search =
    keyword === ""
      ? null
      : await federatedCodeSearch(
          await loadExploreCodeSearchSeeds(d1, exploreCodeDoer(viewer)),
          { q: keyword, mode: selectedMode },
          (repoName, ref, opts) => engineClient(env, repoName).grep(ref, opts),
        );

  return { keyword, selectedMode, displayMode, search };
}

// ---------------------------------------------------------------------------
// Components — the R05 module's federated render re-issued verbatim (the
// module header: upstream serves BOTH pages through ONE shared template;
// user-code-search.tsx is outside this wave's file ownership)
// ---------------------------------------------------------------------------

/** The mode label/tooltip pair — the R10 page's exported locale strings (the
 *  same upstream keys; regexp is NOT in this page's set, §3.3 item 1). */
const FEDERATED_MODE_META: Record<FederatedSearchMode, { label: string; tooltip: string }> = {
  exact: { label: searchPageLocale.exact, tooltip: searchPageLocale.exact_tooltip },
  words: { label: searchPageLocale.words, tooltip: searchPageLocale.words_tooltip },
};

/** The query bar (shared/search/combo + input + button, the R10 form's
 *  two-mode arm): the q input, the native-select mode stand-in, the submit
 *  button. `displayMode === null` leaves every option unselected — the
 *  first option (exact) displays, combo tmpl's quirk. */
function FederatedSearchForm(props: { action: string; keyword: string; displayMode: FederatedSearchMode | null }) {
  const modes: FederatedSearchMode[] = ["exact", "words"];
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
          {modes.map((mode) => (
            <option value={mode} selected={props.displayMode === mode} title={FEDERATED_MODE_META[mode].tooltip}>
              {FEDERATED_MODE_META[mode].label}
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

/** The file permalink — searchfile.tmpl:9's line anchor target
 *  (`$repo.Link/src/commit/{CommitID}/{PathEscapeSegments Filename}`; each
 *  row's answer carries its OWN tip oid). */
function federatedFilePermalink(repoLink: string, commitId: string, path: string): string {
  return `${repoLink}/src/commit/${encodeURIComponent(commitId)}/${pathEscapeSegments(path)}`;
}

/** The card-input view: a FederatedGrepRow narrowed to the fields the render
 *  reads (the R05 page's FederatedGrepRowView shape). */
type FederatedGrepRowView = {
  seed: CodeSearchSeed;
  repoName: string;
  grep: GrepResult;
};

/** One federated result card (results.tmpl's `{{if not $.Repo}}` arm — the
 *  R02/R05 template shape): the header names `owner/repo` (the repo link,
 *  the Archived label when archived) then the filename, the View File
 *  button, and the searchfile.tmpl line table (the code-view presentational
 *  exemption — the a11y R6 note). */
function FederatedSearchHit(props: { row: FederatedGrepRowView; hit: FederatedGrepRowView["grep"]["results"][number] }) {
  const repoLink = `/${props.row.seed.ownerNamespace}/${props.row.seed.slug}`;
  const permalink = federatedFilePermalink(repoLink, props.row.grep.commit, props.hit.path);
  return (
    <div class="diff-file-box file-content non-diff-file-content repo-search-result">
      <h4 class="ui top attached header tw-font-normal flex-text-block tw-flex-wrap tw-py-2">
        <span class="file tw-flex-1">
          <a rel="nofollow" href={repoLink}>
            {props.row.repoName}
          </a>
          {props.row.seed.isArchived ? <span class="ui basic label">{userCodeSearchLocale.archived}</span> : null}
          {" - "}
          {props.hit.path}
        </span>
        <a role="button" class="ui basic tiny button" rel="nofollow" href={permalink}>
          {userCodeSearchLocale.view_file}
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

/** The per-repo truncation notice (the R10 message pair, repo-prefixed,
 *  hoisted to the page level). The counted arm renders when the answer
 *  counted past its cap; the partial arm covers the mid-scan budget exit
 *  INCLUDING a scan that surfaced nothing (the R10 no-results-arm rule). */
function FederatedTruncationNotice(props: { row: FederatedGrepRowView }) {
  const counted =
    props.row.grep.results.length > 0 && props.row.grep.total > props.row.grep.results.length
      ? searchPageLocale.truncated_counted(props.row.grep.total, props.row.grep.results.length)
      : searchPageLocale.truncated_partial;
  return (
    <div class="ui info message">
      <p>
        {props.row.repoName}: {counted}
      </p>
    </div>
  );
}

/** The shared search block (shared/search/code/search.tmpl over federated
 *  data): the form, the divider, the `ui list` — the always-on scan notice,
 *  the over-cap notice, the per-repo truncation notices, then the results /
 *  no-results / empty-placeholder arms. */
function FederatedSearchBlock(props: { action: string; data: ExploreCodeSearchData }) {
  const { data } = props;
  const hitRows = (data.search?.rows ?? []).filter((row: FederatedGrepRow) => row.grep.results.length > 0);
  const truncatedRows = data.search?.rows.filter((row: FederatedGrepRow) => row.grep.truncated) ?? [];
  return (
    <>
      <FederatedSearchForm action={props.action} keyword={data.keyword} displayMode={data.displayMode} />
      <div class="divider" />
      <div class="ui list">
        <div class="ui message">
          <p>{userCodeSearchLocale.by_scan}</p>
        </div>
        {data.search === null ? (
          <div class="empty-placeholder">
            <Icon name="octicon-search" size={48} />
            <h2>{userCodeSearchLocale.code_empty}</h2>
            <p>{userCodeSearchLocale.code_empty_description}</p>
          </div>
        ) : (
          <>
            {data.search.overCap ? (
              <div class="ui info message">
                <p>{userCodeSearchLocale.over_cap(data.search.cap, data.search.totalVisible)}</p>
              </div>
            ) : null}
            {truncatedRows.map((row) => (
              <FederatedTruncationNotice row={row} />
            ))}
            {hitRows.length > 0 ? (
              <div class="repository search">
                {hitRows.map((row) => row.grep.results.map((hit) => <FederatedSearchHit row={row} hit={hit} />))}
              </div>
            ) : (
              <div>{userCodeSearchLocale.no_results}</div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderExploreCodePage(ctx: UiContext, data: ExploreCodeSearchData): string {
  return renderPage(<ExploreCodePage ctx={ctx} data={data} />);
}

/**
 * The R02 page (explore/code.tmpl at the pin): the explore navbar with the
 * Code tab active, then the shared search block in one container. The
 * page-content class is upstream's own template line — `explore users`
 * (explore/code.tmpl:3; the orgs page carries it for the same reason).
 */
export function ExploreCodePage(props: { ctx: UiContext; data: ExploreCodeSearchData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={exploreLocale.explore} pageClass="explore users" activeNav="explore">
      <ExploreNavbar active="code" />
      <div class="ui container">
        <FederatedSearchBlock action="/explore/code" data={data} />
      </div>
    </BaseLayout>
  );
}
