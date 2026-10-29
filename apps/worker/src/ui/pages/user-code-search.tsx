/**
 * The OWNER-SCOPED code search page — the census's R05 UI half (SPEC-0019
 * §3.2, M1) over the federation loader (pages/code-search-federation.ts)
 * and the LANDED grep RPC:
 *
 *   GET /{username}/-/code   web.go:1166 `m.Get("/code", user.CodeSearch)`
 *                            in the `/{username}/-` group's code arm
 *                            (web.go:1164-1167) — routers/web/user/
 *                            code.go:25
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * templates/user/code.tmpl renders BOTH owner kinds: an ORG context user
 * gets `page-content organization code` (org/header + the shared search
 * block in one container — RenderUserOrgHeader's position, user/code.go:30);
 * an INDIVIDUAL gets `page-content user profile` (the profile grid —
 * profile_big_avatar + user/overview/header — then the shared search block).
 * The shared block (shared/search/code/search.tmpl) is the R10 page's body
 * verbatim: the combo form (q + the mode select), a divider, then the
 * `ui list` — notice(s), results / no-results / the empty placeholder.
 *
 * The federated RESULT CARD (shared/search/code/results.tmpl's
 * `{{if not $.Repo}}` arm — the R02/R05 template shape, upstream loads
 * RepoMaps for the card headers at user/code.go:104-108) carries the
 * `owner/repo` link + the filename in one header span (plus the Archived
 * label when the repo is archived), the View File button, and the same
 * searchfile.tmpl line table the R10 page renders.
 *
 * ## The gate posture (the SPEC-ledgered divergences, §3.3 item 5 + §5.9/§5.4)
 *
 * Upstream gates the route on `!setting.Indexer.RepoIndexerEnabled` →
 * redirect to the context user's profile home (user/code.go:26-29 — note
 * the `DisableCodePage` kill-switch does NOT apply here). Our substrate's
 * always-on scan arm is upstream's own R10 precedent (the gitgrep fallback
 * page works with the indexer off) extended to the multi-repo arm, so this
 * page is NOT config-gated and NEVER redirects: the cap honesty stands in
 * for the index. The route group's `reqAnyRepoUnitAccess(TypeCode, read)` +
 * `individualPermsChecker` collapse into the SEED (§5.4 — the seed queries
 * are the ONLY visibility authority; §5.9 — the pages carry no additional
 * auth beyond the visibility seed): the owner resolves through the profile
 * family's ladders (the ORG half first — resolveOrgHome; then the USER
 * half — resolveUserProfile, the packages family's owner-resolution twin
 * without the package-access gate), and the doer-visible repo set answers
 * everything else. An invisible owner 404-shells, indistinguishable from
 * missing; a visible owner with zero visible repos renders the form (and a
 * keyword search answers upstream's clean no-results state over the empty
 * set).
 *
 * ## The honesty surface (§3.2's three-message idiom, the R10 page's arms)
 *
 * - The ALWAYS-ON scan notice renders on every arm (bare included, the R10
 *   posture): the federated text names the per-repository scans (the
 *   `by_git_grep` message class).
 * - The OVER-CAP notice ("Searched the 25 most recently updated of M visible
 *   repositories.") renders only when the visible set exceeded the cap —
 *   the covered slice is the seed order's top-25, deterministic across
 *   requests (§5.1: NEVER a silent truncation; the reopen signal §8 q4
 *   watches is exactly this notice firing routinely).
 * - The PER-REPO TRUNCATION notices hoist each truncated repo's honesty
 *   flag to the page level: one message per truncated repo, in seed order,
 *   reusing repo-search.tsx's counted/partial message pair (counted past
 *   the 50-block cap vs the mid-scan budget exit) prefixed with the repo
 *   name. A partial scan that surfaced nothing still hoists (the R10
 *   no-results-arm rule — a budget exit is not upstream's clean state).
 *
 * ## Arms (user/code.go:25-68 mapped)
 *
 * - `q` empty/absent → the bare form page, 200, NO seed query and NO engine
 *   call (user/code.go:40-43's early return — the chrome counts still load,
 *   they are page furniture, not search data).
 * - The search runs each repo's DEFAULT BRANCH through the loader.
 * - Modes render exact|words ONLY (§3.3 item 1 — no regexp option, even
 *   though the RPC serves it; absent/unknown executes words, displays
 *   exact-first — the loader's parse split).
 * - No pagination across the union (§3.3 item 3 — upstream pages the
 *   indexer's exact global count; the federation renders one capped grouped
 *   page), no language facet / `?l=` filter (§3.3 item 2), no relevance
 *   order (§3.3 item 4 — grouped by repo in seed order, blocks in file
 *   order).
 * - Anonymous sees the owner's genuinely-public rows only; self/admin sees
 *   every row (the user half) — org members/ admins see the org's private
 *   rows through the landed org listing predicate (the org half).
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * This module is fully self-contained (resolution + loader + render); the
 * route itself lands in the orchestrator's window (ui/index.ts was an
 * integrator sibling's file at write time). The exact arms, mirroring the
 * owner-heatmap family:
 *
 * 1. Interface (beside OwnerHeatmapRoute): `export interface
 *    UserCodeSearchRoute { family: "user-code-search"; owner: string; }` —
 *    the owner segment is the decoded {username} (org or user rows — the
 *    resolution runs both halves).
 * 2. Parse arm (in the `repo === "-"` block, beside the heatmap literal):
 *    `if (repo === "-" && raw.length === 4 && raw[3] === "code") { return
 *    { family: "user-code-search", owner }; }` — the exact 4-segment
 *    shape; deeper tails stay unclaimed, the engine's 404 (upstream's
 *    unregistered-route answer).
 * 3. Import: `import { loadUserCodeSearchData, renderUserCodeSearchPage,
 *    resolveUserCodeSearchOwner } from "./pages/user-code-search";`
 * 4. Handler (the ownerHeatmapData twin with the page render): resolve the
 *    ui session; drift-guard the family; build the ProfileDoer from the
 *    viewer; resolveUserCodeSearchOwner(c.env.DB, route.owner, doer,
 *    resolved.url.pathname, resolved.url.search); the redirect arm answers
 *    `new Response(null, { status: 307, headers: { location:
 *    owner.location } })`; the missing arm answers
 *    `c.html(renderNotFound(ctx), 404)`; then
 *    loadUserCodeSearchData(c.env, c.env.DB, owner, doer,
 *    resolved.url.searchParams) and
 *    respond(c.html(renderUserCodeSearchPage(ctx, data), 200)).
 * 5. Registration (beside the heatmap tail):
 *    `uiRouter.get("/:owner/-/code", (c) => userCodeSearchPage(c));`
 * 6. The deferred nav tab (both strips): ProfileTabs' optional-prop pattern —
 *    a `codeTab?: { active: boolean; href: string }` on user-profile.tsx's
 *    ProfileTabs + org-home.tsx's OrgMenu, armed active on this page, and
 *    inert (or armed per the census disposition) on the profile/org pages —
 *    the two files are outside this module's ownership.
 */

import type { GrepResult } from "@cf-gitea/git-engine";

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { listFollowers, listFollowing } from "../../api/services/follows";
import type { OrgDoer } from "../../api/services/org-repos";
import { repositories } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { engineClient } from "../engine";
import { pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgHeader, OrgMenu, resolveOrgHome } from "./org-home";
import {
  federatedCodeSearch,
  loadOrgCodeSearchSeeds,
  loadUserCodeSearchSeeds,
  parseFederatedDisplayMode,
  parseFederatedSearchMode,
  type CodeSearchSeed,
  type FederatedCodeSearch,
  type FederatedSearchMode,
} from "./code-search-federation";
import { searchPageLocale } from "./repo-search";
import {
  ProfileAvatarCard,
  ProfileTabs,
  resolveUserProfile,
  type ProfileDoer,
  type UserProfileRow,
} from "./user-profile";

// ---------------------------------------------------------------------------
// Chrome text (upstream locale keys, locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

/** Page chrome text (the searchPageLocale pattern — upstream locale keys). */
export const userCodeSearchLocale = {
  /** "explore.code" — upstream's ctx.Data["Title"] (user/code.go:34) */
  title: "Code",
  /** "user.code" / "org.code" — the deferred nav tab's label (the handoff
   *  note in the module header; exported for the window's tab arm). */
  code_tab: "Code",
  /** The always-on scan notice (§3.2 — the by_git_grep message class, the
   *  federated text the SPEC names). */
  by_scan:
    "Current code search results are provided by per-repository scans; a site-wide index is not configured.",
  /** The over-cap notice (§3.2's quoted copy — the covered count and the
   *  visible total; §5.1's never-silent rule). */
  over_cap: (cap: number, total: number): string =>
    `Searched the ${cap} most recently updated of ${total} visible repositories.`,
  /** "search.no_results" */
  no_results: "No matching results found.",
  /** "search.code_empty" */
  code_empty: "Start a code search.",
  /** "search.code_empty_description" */
  code_empty_description: "Enter a keyword to search across the code.",
  /** "repo.diff.view_file" */
  view_file: "View File",
  /** "repo.desc.archived" — the federated card header's archived label */
  archived: "Archived",
} as const;

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (index.ts calls these; kept here so the
// page module owns its data path, the packages pattern)
// ---------------------------------------------------------------------------

/** The owner union the page renders (the resolution's admitted arms — the
 *  upstream handler branches on `ctx.ContextUser.IsOrganization()`). */
export type CodeSearchOwner =
  | { kind: "org"; org: OrgRecord }
  | { kind: "user"; user: UserProfileRow };

/** The resolution outcome for the R05 subtree — the owner union plus the
 *  shared redirect/miss arms. */
export type CodeSearchOwnerResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "user"; user: UserProfileRow }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the owner for the code-search subtree — the packages family's
 * owner-resolution twin WITHOUT the package-access gate (the code family's
 * only gate is the seed query itself, the module header's §5.4/§5.9 note):
 * the ORG half first (`resolveOrgHome` — renamed orgs 307, invisible orgs
 * miss), then the USER half (`resolveUserProfile` — the userAssignment +
 * RedirectToUser seam). Both halves run their full visibility ladders, so
 * an admitted row is already doer-visible.
 */
export async function resolveUserCodeSearchOwner(
  d1: D1Database,
  owner: string,
  doer: ProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<CodeSearchOwnerResolution> {
  const org = await resolveOrgHome(d1, owner, doer, requestPath, requestQuery);
  if (org.kind === "redirect") return org;
  if (org.kind === "org") return { kind: "org", org: org.org };
  const profile = await resolveUserProfile(d1, owner, doer, requestPath, requestQuery);
  if (profile.kind === "redirect") return profile;
  if (profile.kind === "missing") return { kind: "missing" };
  return { kind: "user", user: profile.user };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** The profile-grid chrome counts (the packages page's userProfileChrome
 *  idiom: the menu tab's repository count + the avatar card's pair). */
export interface CodeSearchChrome {
  repoCount: number;
  followers: number;
  following: number;
}

/** The doer-visible repository count for the tab label (the packages page's
 *  ownerRepoCount idiom — the profile loader's WHERE, count-only). */
async function ownerRepoCount(d1: D1Database, ownerId: number, doer: ProfileDoer): Promise<number> {
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === ownerId);
  const where = seePrivate
    ? eq(repositories.ownerId, ownerId)
    : and(eq(repositories.ownerId, ownerId), eq(repositories.visibility, "public"));
  const row = await drizzle(d1).select({ total: sql<number>`count(*)` }).from(repositories).where(where).get();
  return Number(row?.total ?? 0);
}

/** The org arm's tab-label count — the org listing's own total (one 1-row
 *  page read; the same doer-visible predicate the seeds walk). */
async function orgRepoCount(d1: D1Database, org: OrgRecord, doer: OrgDoer): Promise<number> {
  const orgs = new OrgService(d1);
  const page = await orgs.listOrgRepos(org.id, { id: doer.id, isAdmin: doer.isAdmin }, { page: 1, pageSize: 1 });
  return page.total;
}

/** The user arm's avatar-card counts (the follows service, count-only
 *  pages — the packages page's followCountsOf idiom). */
async function followCountsOf(d1: D1Database, userId: number, doer: ProfileDoer): Promise<{ followers: number; following: number }> {
  const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
  const [followerPage, followingPage] = await Promise.all([
    listFollowers(d1, userId, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, userId, followViewer, { page: 1, pageSize: 1 }),
  ]);
  return { followers: followerPage.total, following: followingPage.total };
}

/** The R05 page's render inputs. `search === null` is the bare arm (the
 *  early return — no seed read, no engine call). */
export interface UserCodeSearchData {
  owner: CodeSearchOwner;
  chrome: CodeSearchChrome;
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
 * Load the R05 page (user/code.go:25-68 over the federation loader): the
 * chrome counts (both arms — page furniture), then, for a non-empty
 * keyword, the owner-kind seed query and the capped fan-out. The bare arm
 * makes NO seed read and NO engine call (user/code.go:40-43). The engine
 * seam is the loader's per-repo composition (`engineClient(env, name).grep`
 * — SPEC-0019 §2.5's "a federation loader composes these per repo").
 */
export async function loadUserCodeSearchData(
  env: Env,
  d1: D1Database,
  owner: CodeSearchOwner,
  doer: ProfileDoer,
  params: URLSearchParams,
): Promise<UserCodeSearchData> {
  const rawMode = params.get("search_mode");
  const keyword = (params.get("q") ?? "").trim();
  const selectedMode = parseFederatedSearchMode(rawMode);
  const displayMode = parseFederatedDisplayMode(rawMode);

  // The chrome counts ride every arm (page furniture, not search data).
  // The org arm carries no avatar-card pair (OrgHeader renders none
  // upstream) — the zeros are structural, never rendered.
  const [repoCount, follows] = await Promise.all([
    owner.kind === "org" ? orgRepoCount(d1, owner.org, doer) : ownerRepoCount(d1, owner.user.id, doer),
    owner.kind === "org" ? Promise.resolve({ followers: 0, following: 0 }) : followCountsOf(d1, owner.user.id, doer),
  ]);

  // The bare arm stops HERE — no seed read, no engine call (user/code.go
  // 40-43's early return).
  const search = keyword === "" ? null : await runSearch(env, d1, owner, doer, keyword, selectedMode);

  return {
    owner,
    chrome: { repoCount, followers: follows.followers, following: follows.following },
    keyword,
    selectedMode,
    displayMode,
    search,
  };
}

/** The keyword arm: the owner-kind seed query, then the bounded fan-out. */
async function runSearch(
  env: Env,
  d1: D1Database,
  owner: CodeSearchOwner,
  doer: ProfileDoer,
  keyword: string,
  selectedMode: FederatedSearchMode,
): Promise<FederatedCodeSearch> {
  const seeds: CodeSearchSeed[] =
    owner.kind === "org"
      ? await loadOrgCodeSearchSeeds(d1, owner.org, doer)
      : await loadUserCodeSearchSeeds(d1, owner.user.id, doer);
  return federatedCodeSearch(seeds, { q: keyword, mode: selectedMode }, (repoName, ref, opts) =>
    engineClient(env, repoName).grep(ref, opts),
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The mode label/tooltip pair — the R10 page's exported locale strings
 *  (the same upstream keys; regexp is NOT in this page's set, §3.3 item 1). */
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
            <option
              value={mode}
              selected={props.displayMode === mode}
              title={FEDERATED_MODE_META[mode].tooltip}
            >
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

/** The card-input view: a FederatedGrepRow narrowed to the fields the
 *  render reads (kept as a type alias so the hit component's props stay
 *  honest about what crosses the render boundary). */
type FederatedGrepRowView = {
  seed: CodeSearchSeed;
  repoName: string;
  grep: GrepResult;
};

/** The per-repo truncation notice (the R10 message pair, repo-prefixed,
 *  hoisted to the page level — the module header's honesty note). The
 *  counted arm renders when the answer counted past its cap; the partial
 *  arm covers the mid-scan budget exit INCLUDING a scan that surfaced
 *  nothing (the R10 no-results-arm rule). */
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
function FederatedSearchBlock(props: { action: string; data: UserCodeSearchData }) {
  const { data } = props;
  const hitRows = (data.search?.rows ?? []).filter((row) => row.grep.results.length > 0);
  const truncatedRows = data.search?.rows.filter((row) => row.grep.truncated) ?? [];
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
                {hitRows.map((row) =>
                  row.grep.results.map((hit) => <FederatedSearchHit row={row} hit={hit} />),
                )}
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
export function renderUserCodeSearchPage(ctx: UiContext, data: UserCodeSearchData): string {
  return renderPage(<UserCodeSearchPage ctx={ctx} data={data} />);
}

/** The R05 page (user/code.tmpl's two owner arms). */
export function UserCodeSearchPage(props: { ctx: UiContext; data: UserCodeSearchData }) {
  const { ctx, data } = props;
  const ownerName = data.owner.kind === "org" ? data.owner.org.username : data.owner.user.username;
  const action = `/${ownerName}/-/code`;
  if (data.owner.kind === "org") {
    // org arm: `page-content organization code` — org/header + the search
    // block (user/code.tmpl:3-7).
    return (
      <BaseLayout ctx={ctx} title={userCodeSearchLocale.title} pageClass="organization code">
        <OrgHeader org={data.owner.org} signedIn={ctx.viewer.kind === "user"} />
        <OrgMenu
          orgLink={`/${data.owner.org.username}`}
          repoCount={data.chrome.repoCount}
          packagesTab={ctx.packagesEnabled !== false ? { active: false, href: `/${data.owner.org.username}/-/packages` } : undefined}
        />
        <div class="ui container">
          <FederatedSearchBlock action={action} data={data} />
        </div>
      </BaseLayout>
    );
  }
  // user arm: `page-content user profile` — the profile grid (avatar card +
  // overview header) + the search block (user/code.tmpl:9-21). The overview
  // header renders WITHOUT the Code tab (the module header's deferred nav
  // arm — the tab strip is outside this module's ownership).
  return (
    <BaseLayout ctx={ctx} title={userCodeSearchLocale.title} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard
              user={data.owner.user}
              followers={data.chrome.followers}
              following={data.chrome.following}
            />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <ProfileTabs
              username={data.owner.user.username}
              repoCount={data.chrome.repoCount}
              starsCount={data.owner.user.numStars}
              packagesTab={ctx.packagesEnabled !== false ? { active: false, href: `/${data.owner.user.username}/-/packages` } : undefined}
            />
            <FederatedSearchBlock action={action} data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
