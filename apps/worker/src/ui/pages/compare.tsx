/**
 * The compare view + the new-PR form, `/{owner}/{repo}/compare[/{base}...{head}]`
 * — pages wave 13 (SPEC-0008 U3 extension; upstream routers/web/repo/
 * compare.go CompareDiff + routers/web/repo/pull.go CompareAndPullRequestPost,
 * templates/repo/diff/compare.tmpl + repo/commits_table.tmpl + repo/issue/
 * new_form.tmpl at the pin fc4936884584).
 *
 * ## Flow shape (upstream's own: the form lives INLINE on the compare page)
 *
 * Upstream registers the new-PR POST on the SAME `/compare/{basehead}` catch-all
 * the page GET serves (web.go:1308-1315 `m.PathGroup("/compare/*")`), and
 * compare.tmpl renders `repo/issue/new_form` directly on the page (`action=
 * {{.Link}}` — the compare URL itself); the `/new/pull` alternative from the
 * wave brief would collide with the claimed `/new/{branch}` file-editor family,
 * so the inline shape — the one upstream's flow uses — is what is claimed here.
 * The PR-block DOM order is compare.tmpl's: the choose-branch segment, then the
 * state arms (nothing-to-compare segment | the existing-PR segment | the
 * archived warning | the info message + the form), then the commits table and
 * the diff box (`{{if $showDiffBox}}`).
 *
 * ## URL parse (routers/common/compare.go ParseCompareRouterParam, full grammar)
 *
 * The decoded tail splits on the FIRST `...` (strings.Cut parity), else on
 * the first `..` — the two-dot DirectComparison arm (the separator is
 * CompareInfo.CompareSeparator and picks the diff semantic below); failing
 * both, the whole tail is the HEAD (upstream's single-ref family); an empty
 * side falls back to the default branch (util.IfZero over
 * GetPullRequestTargetBranch/DefaultBranch) — the bare `/compare` renders
 * the default...default comparison. The HEAD part carries the fork forms
 * (parseHead, grammar forms 2/3/5/6): `{owner}:{ref}` names the owner's fork
 * of the base, `{owner}/{repo}:{ref}` names an explicit head repo; the BASE
 * part never carries a fork form upstream (a colon there is an unresolvable
 * refname → the 404 shell, parity with upstream's resolution miss).
 *
 * ## The cross-repo arm (GetHeadOwnerAndRepo + GetCompareInfo over forks)
 *
 * A fork-form head resolves through the landed fork-edge port
 * (services/pulls.ts `resolveHeadRepo` — the API POST's own grammar: the
 * same-owner fold back onto the base repo, the fork-edge walk for the bare
 * `{owner}:{ref}` form, the explicit owner/name lookup; upstream
 * compare.go:152-192). The doer must READ the head repo's code
 * (compare.go:182-189 — permHead.CanRead; the miss 404-shells) — the §2.5
 * page-visibility grant. Every compare read then runs in the HEAD cell:
 * upstream opens headGitRepo and fetches the base commit INTO it before the
 * merge base, the commit range and the diff (services/git/compare.go:70-89,
 * GetDiffForRender on ci.HeadGitRepo); forks are full copies
 * (SPEC-0001b §5.2) so the landed `crossRepoCreateMergeBase` port supplies
 * the fetch (its carry) + the head-cell walk — for the `..` form the walk's
 * answer is computed-and-ignored (upstream skips the merge base for the
 * direct form but still fetches, compare.go:73-80 vs 83-89).
 *
 * ## Semantics over the landed engine reads (SPEC-0001b §4.1/§10.8)
 *
 * Both sides resolve against their repo's listRefs (branch → tag → 7..64-hex
 * oid — ResolveRefWithSuffix reduced; an unresolvable side 404-shells exactly
 * upstream's NotFound), then — for the three-dot form —
 * `mergeBase(baseTip, headTip)` in the HEAD cell:
 *   - null base → no common history: the nothing-to-compare segment
 *     (`repo.pulls.nothing_to_compare*`), no commits table, no diff; the POST
 *     refuses with upstream's no_common_history message (the API create
 *     route's parseCompareInfo arm).
 *   - head tip === merge base → the nothing-to-compare fold (upstream
 *     compare.go:397-405 headCommitID == ci.CompareBase — the head is
 *     already on the base, nothing to bring; same-tip is subsumed — the
 *     merge-base of equal tips is that tip, the engine graph's
 *     `oa === ob` fast path): the same segment (compare.tmpl:174-183 — the
 *     and_allow_empty_pr text when the form survives it, the plain/have-tag
 *     text otherwise), no commits table, no diff. The create form survives
 *     the fold only through AllowEmptyPr (compare.go:400-402), reduced:
 *     supportEmptyPr = !AutodetectManualMerge → true (the
 *     autodetect-manual-merge unit config is unlanded); acrossRepoPr =
 *     !IsSameRef (services/git/compare.go:41-43 — same repository && the
 *     same resolved ref; cross-repo pairs never hold it, whatever the
 *     names). The POST completes the loop (the wave-129 compare-parity
 *     posture flipped): upstream's create side has NO tips gate — the web
 *     handler (pull.go:1318 CompareAndPullRequestPost) accepts the empty
 *     diff unconditionally, the AllowEmptyPr render gate (compare.go:400-402)
 *     is the only control — so the equal-tips ACROSS-REF pair creates; the
 *     SAME-ref arm keeps the landed refusal (the IsSameRef name-equality
 *     gate, for the same-repo head only).
 *   - otherwise `listCommitsRange(CompareBase..headTip)` (oldest first —
 *     DISPLAYED reversed, newest first like upstream's commits_list;
 *     upstream's ShowPrettyFormatLogToList(ci.CompareBase+".."+head),
 *     services/git/compare.go:96-103 — the merge base for `...`, the base
 *     tip itself for `..`, so base-only commits never leak into the range)
 *     and `readDiff(headTip, CompareBase)` (upstream's BeforeCommitID =
 *     ci.CompareBase / AfterCommitID = headCommitID — mergeBase...head for
 *     `...`, the direct two-tip diff for `..`; a null merge base renders the
 *     empty range, pull-engine.ts's own composition rule) rendered through
 *     pull-files' DiffFileBox components. Both reads run in the HEAD cell
 *     (the cross-repo arm above).
 *
 * ## The `..` two-dot arm (DirectComparison)
 *
 * Upstream sets CompareInfo.CompareBase = BaseCommitID directly for the
 * direct form (services/git/compare.go:83-89) — never empty, so the
 * no-common-history fold is structurally unreachable and the page renders
 * the direct two-tip diff even when the head sits BEHIND the base (the
 * reverse delta) while the commit list runs baseTip..headTip (empty for a
 * behind head — commits_table renders the 0 count beside the diff box, the
 * `$showDiffBox := or .CommitCount .DiffShortStat.NumFiles` shape). The
 * create form folds for `..` pairs (compare.tmpl:173's
 * `(not $.CompareInfo.DirectComparison)`) — the POST itself stays
 * tips-blind AND separator-blind upstream (no DirectComparison gate in
 * pull.go:1318), so a hand-crafted `..` POST creates like its `...` twin
 * (the same-ref arm keeps the landed refusal for main..main). The separator
 * switch link (compare.tmpl:99 — repo.pulls.switch_comparison_type, the
 * `..`↔`...` toggle) rides the now-landed target: the no-JS render keeps
 * the icon-out reduction but emits the LIVE link carrying the OTHER
 * separator.
 *
 * ## The new-PR write (the landed create route's arms, CompareAndPullRequestPost)
 *
 * The §2.8 Origin guard, the repo resolution, the anonymous login 303, then the
 * WRITER gate (`canWriteRepo` — the file-editor predicate; a divergence from
 * upstream's reqUnitPullsReader, documented below — it predates the fork flow,
 * whose head branches are not the writer's artifacts; the flip is the recorded
 * follow-up), then the same fail-fast order routes/pulls.ts POST runs:
 * head === base (IsSameRef — the same-repo head only; cross-repo pairs never
 * hold it) → the 422 message, no common history (CompareBase === "" —
 * structurally unreachable for `..`) → no_common_history, duplicate open PR →
 * the landed 409 message (findUnmergedPullRequest keyed on the HEAD repo),
 * empty title → the title-required re-render. Equal tips refuse NO arm here
 * (upstream's create side is tips-blind): the across-ref pair creates the
 * empty PR under AllowEmptyPr, the same-ref pair already refused above. The
 * create rides `IssuesService.createPullRequest` (the same fields the API POST
 * passes: poster = the session viewer, allow_maintainer_edit =
 * DefaultAllowMaintainerEdit, headSha = the head tip, headRepoId = the head
 * repo), the CROSS-REPO arm runs the landed create-compare seam first —
 * `crossRepoCreateMergeBase` (pr.MergeBase, pull.go:520) +
 * `carryForkHeadIntoBase` (the head closure into the base cell so
 * refs/pull/N/head can land — the API POST's exact order, routes/pulls.ts:
 * 947-951) — the refs/pull/N/head CAS write follows (`createPullHeadRef`, the
 * API route's cleanup order on failure: the D1 rows delete again, the gate's
 * plain-text 500 answered), the `pull_request opened` webhook fans out through
 * emitIssueEvent (the wave-4/11 UI-emission convention), and success 303s onto
 * `/{owner}/{repo}/pulls/{index}` (upstream's `ctx.JSONRedirect(pullIssue.
 * Link())` reduced to the no-JS 303).
 *
 * ## Form reduction (repo/issue/new_form.tmpl)
 *
 * Title (`name="title"`, prefilled from the range's FIRST (oldest) commit
 * subject — upstream's useFirstCommitAsTitle single-commit arm; the brief pins
 * it as the default for every range size) and body textarea (`name="content"`,
 * the single commit's message body when the range is exactly one commit —
 * upstream's `len(commits) == 1` arm). The sidebar (labels/milestone/assignees)
 * is the wave-4 reduction not repeated here; the base/head summary rides the
 * right column (upstream's "merge into"/"pull from" labels,
 * repo.pulls.compare_base/compare_compare). Upstream hides the form behind a
 * `.show-panel` JS toggle (compare.tmpl:204-211) — the no-JS reduction renders
 * it directly, the dead control omitted.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The dropdowns' search input and the branches/tags tab buttons are
 *   Fomantic/JS features — the flat branch-then-tag item list is the no-JS
 *   shape (the per-repo groups of compare.tmpl's menus render in the
 *   upstream order, one flat menu).
 * - The icon-only switch controls (octicon-git-compare head/base swap,
 *   octicon-arrow-left separator type switch, octicon-triangle-down dropdown
 *   carets) are outside the generated icon allowlist (the pull-files tabs
 *   degradation): the head/base swap renders as its title text; the
 *   separator switch (compare.tmpl:99) is now the LIVE toggle link (the `..`
 *   target landed) minus its icon.
 * - `?expand=1`/`quick_pull` (the form's prefill-expand query family) and the
 *   PR templates are not honored — the form renders expanded with the
 *   commit-derived prefill only.
 * - The `.diff`/`.patch` download suffixes keep the compare-feeds module's
 *   own grammar: its `..` arm is landed there, its fork forms stay unclaimed
 *   (the feed loader's parseCompareBaseHead nulls colon-bearing sides).
 * - Anonymous no-common-history renders the nothing-to-compare segment
 *   (upstream leaves that page bare for anonymous viewers — the honest-state
 *   reduction).
 * - The commits count in the table header is the FETCHED page count (upstream
 *   shows the whole range's count before pagination).
 * - The new_form maintainer-edit checkbox (the cross-repo +
 *   CanWriteToHeadRepo arm, new_form.tmpl:64-68) rides the landed sidebar
 *   reduction (allow_maintainer_edit defaults true at create; the checkbox
 *   never rendered).
 * - The WRITER gate above keeps the POST to base-repo writers (upstream's
 *   reqUnitPullsReader admits any pulls reader — the fork flow's natural
 *   author) — the recorded gate-flip follow-up; the cross-repo machinery
 *   (headRepoId rows, the object carries, refs/pull/N/head) is the API
 *   fork-PR path's own, so the flip is mechanical when sanctioned.
 */

import { Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { CommitJson } from "@cf-gitea/git-engine";

import type { ApiEnv } from "../../api/env";
import { engineReads } from "../../api/services/engine";
import { carryForkHeadIntoBase, createPullHeadRef, crossRepoCreateMergeBase } from "../../api/services/pull-engine";
import { findForkByOwner } from "../../api/services/forks";
import {
  findUnmergedPullRequest,
  pullRequestAlreadyExistsError,
  resolveHeadRepo,
  toApiPullRequest,
} from "../../api/services/pulls";
import {
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";
import type { Viewer as ApiViewer } from "../../api/services/repository";
import { resolveRepositoryForViewer } from "../repo-view";
import type { Viewer } from "../viewer";
import { issues, pullRequests } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { emitIssueEvent, type IssueEventRequest } from "../../services/issue-events";
import { readUrlEncodedForm } from "../forms";
import { pathEscapeSegments, shortSha } from "../page-data";
import { commitLink } from "../links";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { resolveHeadBranch, type ResolvedRefs } from "./home";
import { CommitList, commitsLocale } from "../components/commit-list";
import { CommitsPagination } from "./commits";
import { DiffFileBox, diffFileViews, pullFilesLocale, type DiffFileView } from "./pull-files";

/** Page chrome text (component-local, the pullFilesLocale pattern — the
 *  strings cite upstream's own locale keys verbatim). */
export const compareLocale = {
  comparing_changes: "Comparing changes", // "repo.compare.title"
  comparing_description:
    "Choose two branches or tags to see what’s changed or to start a new pull request.", // "repo.compare.description"
  compare_commits: "Compare commits", // "action.compare_commits_general"
  merge_into: "merge into", // "repo.pulls.compare_base" (the pull-flavored base label)
  pull_from: "pull from", // "repo.pulls.compare_compare" (the pull-flavored head label)
  base: "base", // "repo.compare.compare_base"
  compare: "compare", // "repo.compare.compare_head"
  switch_head_and_base: "Switch head and base", // "repo.pulls.switch_head_and_base"
  switch_comparison_type: "Switch comparison type", // "repo.pulls.switch_comparison_type"
  new_pull_request: "New Pull Request", // "repo.pulls.new"
  new_description: "Discuss and review the changes in this comparison with others.", // "repo.pulls.new.description"
  view_pull_request: "View Pull Request", // "repo.pulls.view"
  nothing_to_compare: "There are no differences to show. There is no need to create a pull request.", // "repo.pulls.nothing_to_compare"
  nothing_to_compare_have_tag:
    "There are no differences to show between the selected branches or tags.", // "repo.pulls.nothing_to_compare_have_tag"
  nothing_to_compare_and_allow_empty_pr:
    "These branches are equal. This PR will be empty.", // "repo.pulls.nothing_to_compare_and_allow_empty_pr"
  no_common_history:
    "These branches do not share a common merge base. Select a different base or compare branch.", // "repo.pulls.no_common_history"
  archived:
    "This repo is archived. You can view files and clone it. You cannot open issues or pull requests or push a commit.", // "repo.archive.title"
  title_placeholder: "Title", // "repo.milestones.title" (the title input's placeholder upstream)
  /** cf-gitea addition: upstream's HTML5 `required` catches the empty title
   *  client-side; this is the server-side re-render message (the new-issue
   *  page's title_required convention). */
  title_required: "A title is required.",
} as const;

/** The compare commits table's page size — upstream `setting.Git.CommitsRangeSize`
 *  (modules/setting/git.go:44), the commits page's own constant. */
export const COMPARE_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// URL helpers (the compare family's link shapes)
// ---------------------------------------------------------------------------

/** The compare URL for one base...head pair: the segments escape per
 *  refname-slash, the separator stays literal (refnames can never carry
 *  `..`, so the emitted form always re-parses to the same pair). */
export function compareLink(repoLink: string, base: string, head: string): string {
  return `${repoLink}/compare/${pathEscapeSegments(base)}...${pathEscapeSegments(head)}`;
}

/** The fork-form compare URL (`{base}...{owner}[/{repo}]:{head}` — grammar
 *  forms 2/3): the same escaping with the head side's owner/repo prefix, the
 *  colon literal (re-parses through parseHead). */
export function compareForkLink(
  repoLink: string,
  base: string,
  headOwner: string,
  headRepoName: string | null,
  head: string,
): string {
  const repoPart = headRepoName === null ? pathEscapeSegments(headOwner) : `${pathEscapeSegments(headOwner)}/${pathEscapeSegments(headRepoName)}`;
  return `${repoLink}/compare/${pathEscapeSegments(base)}...${repoPart}:${pathEscapeSegments(head)}`;
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed engine reads, never a self-fetch)
// ---------------------------------------------------------------------------

/** Which universe a compare side resolved from (upstream RefName.IsBranch/
 *  IsTag — the create gate reads the branch-ness of BOTH sides). */
export type CompareRefKind = "branch" | "tag" | "commit";

/** The compare page render inputs, loaded by loadCompareData. */
export interface CompareData {
  /** The BASE repo's full branch/tag universes (the base dropdown's own
   *  group; the head repo's universe rides headRefs). */
  refs: ResolvedRefs;
  /** The head repo's universes — the same object as `refs` for a same-repo
   *  head, the resolved fork/head-repo universe otherwise. */
  headRefs: ResolvedRefs;
  /** The RESOLVED short names (a URL side may be the default-branch fallback;
   *  the head side falls back to the HEAD repo's default, upstream
   *  compare.go:194 util.IfZero(headOriRef, headRepo.DefaultBranch)). */
  baseName: string;
  headName: string;
  baseKind: CompareRefKind;
  headKind: CompareRefKind;
  baseTipOid: string;
  headTipOid: string;
  /** The URL's separator (CompareInfo.CompareSeparator). */
  separator: "..." | "..";
  /** `separator === ".."` (CompareInfo.DirectComparison — the direct diff
   *  semantic; the create form folds for these pairs). */
  directComparison: boolean;
  /** The `...` merge base oid; `null` = no common history or the `..` form
   *  (never computed for the direct arm — upstream skips the walk,
   *  services/git/compare.go:83-89). */
  mergeBaseOid: string | null;
  /** Upstream CompareInfo.CompareBase — the range/diff read's left side: the
   *  merge base for `...` (null when no common history), the base tip itself
   *  for `..` (never null). The POST's no_common_history arm keys on this. */
  compareBaseOid: string | null;
  /** baseTip === headTip (the head-flavor fold arm). */
  sameTip: boolean;
  /** Upstream nothingToCompare (compare.go:376-378 CompareBase == "" + 397-405
   *  head == CompareBase): for `..` only the equal-tips arm is reachable. */
  nothingToCompare: boolean;
  /** The range's commits in DISPLAY order (newest first — the engine returns
   *  CompareBase..head oldest first; commits_list.tmpl renders newest first). */
  commits: CommitJson[];
  /** The range log's more flag (the Older link). */
  more: boolean;
  files: DiffFileView[];
  totalAddition: number;
  totalDeletion: number;
  /** The open PR between the two branches (branch pairs only —
   *  findUnmergedPullRequest's exact targets, keyed on the HEAD repo),
   *  `null` = none. */
  existing: { index: number; title: string } | null;
  /** The form prefill: the range's FIRST (oldest) commit subject, and — for a
   *  one-commit range — that commit's message body (upstream's
   *  prepareNewPullRequestTitleContent arms). */
  suggestedTitle: string;
  suggestedContent: string;
  /** The head repo when the compare is CROSS-REPO (ci.HeadRepo); `null` =
   *  same-repo (IsSameRepository). */
  headRepo: { id: string; ownerNamespace: string; slug: string; defaultBranch: string } | null;
  /** The head repo id (== the base's for a same-repo head) — the duplicate
   *  check + the create row's headRepoId. */
  headRepoId: string;
  /** OwnForkRepo (compare.go:243-250 + 281-297): the viewer's fork of the
   *  BASE repo when the viewer is neither its owner nor already the head,
   *  readable, and distinct from the root — the dropdown's third group;
   *  `null` = absent (anonymous, owner viewer, no fork, unreadable). */
  ownFork: { owner: string; name: string; link: string; refs: ResolvedRefs } | null;
  /** RootRepo (compare.go:229-274): the base's fork parent when distinct
   *  from base and head and readable — the dropdown's fourth group; `null` =
   *  the base is not a fork (or absent/unreadable). The template's
   *  `.RootRepo.AllowsPulls` gate rides the always-on pulls unit. */
  rootRepo: { owner: string; name: string; link: string; refs: ResolvedRefs } | null;
}

export interface CompareNotFound {
  notFound: true;
}

/** Upstream `MessageBody()` reduced: the full message minus the subject line
 *  and the blank-line separator, edge-trimmed (the engine's CommitJson keeps
 *  `message` as the WHOLE commit message, git/objects.ts). Exported for the
 *  commit view's commit-body pre (pages/commit-view.tsx, pages wave 18). */
export function messageBodyOf(commit: CommitJson): string {
  if (commit.message === commit.subject) return "";
  return commit.message.slice(commit.subject.length).replace(/^\n+/, "").replace(/\s+$/, "");
}

/** Upstream `ResolveRefWithSuffix` reduced to the three universes the UI
 *  addresses: an exact branch name, then an exact tag, then a raw 7..64-hex
 *  oid (the /src walk's commit arm — readCommit resolves reachability). */
export function compareRefKindOf(name: string, refs: ResolvedRefs): CompareRefKind | null {
  if (refs.branches.includes(name)) return "branch";
  if (refs.tags.includes(name)) return "tag";
  if (/^[0-9a-f]{7,64}$/i.test(name)) return "commit";
  return null;
}

/**
 * Load the comparison. `notFound` covers the §4.5 404 family: an unborn repo,
 * a side that resolves to no branch/tag/oid, an engine read that cannot
 * return either tip (upstream ResolveRefWithSuffix's not-found arm), an
 * unresolvable fork-form head (GetHeadOwnerAndRepo's invalid-argument /
 * missing-fork arms — the landed anti-enumeration 404), or an unreadable
 * head repo (compare.go:182-189's permHead.CanRead miss → the not-exist
 * shell).
 */
export async function loadCompareData(
  env: Env,
  db: D1Database,
  repo: {
    id: string;
    ownerNamespace: string;
    slug: string;
    defaultBranch: string;
    forkParent: string | null;
    ownerId: number | null;
  },
  options: {
    base: string | null;
    head: string | null;
    headOwner: string | null;
    headRepoName: string | null;
    separator: "..." | "..";
    viewer: Viewer;
    page: number;
  },
): Promise<CompareData | CompareNotFound> {
  const reads = engineReads(env, repo);
  const refs = resolveHeadBranch(await reads.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true }; // unborn repo

  // The base side (util.IfZero — the parser's null is the default branch,
  // upstream GetPullRequestTargetBranch/DefaultBranch answer).
  const baseName = options.base ?? repo.defaultBranch;
  const baseKind = compareRefKindOf(baseName, refs);
  if (baseKind === null) return { notFound: true }; // unresolvable side
  const baseTip = await reads.readCommit(baseName);
  if (baseTip === null) return { notFound: true };

  // The head repo (GetHeadOwnerAndRepo, compare.go:152-192): no fork form →
  // the base repo itself; the same owner/name folds back onto it too
  // (compare.go:161-163 + 169-171); anything else resolves through the
  // landed grammar port (the fork edge / the explicit owner+name lookup) and
  // must be readable by the viewer (permHead.CanRead → the §2.5 grant).
  let headRepoRow: typeof repo = repo;
  let headRepo: CompareData["headRepo"] = null;
  if (options.headOwner !== null) {
    const sameOwner = options.headOwner.toLowerCase() === repo.ownerNamespace.toLowerCase();
    const sameName =
      options.headRepoName === null || options.headRepoName.toLowerCase() === repo.slug.toLowerCase();
    if (!(sameOwner && sameName)) {
      // resolveHeadRepo parses the same `owner[/repo]:ref` grammar (the API
      // POST's head port). The branch it returns is discarded — the null-side
      // fallback uses the HEAD repo's default below; the placeholder keeps
      // the parse well-formed for the null-head call.
      const headParam = `${options.headOwner}${options.headRepoName !== null ? `/${options.headRepoName}` : ""}:${options.head ?? "_"}`;
      let headRepoId: string;
      try {
        const resolved = await resolveHeadRepo(db, await basePairOf(db, repo), headParam);
        headRepoId = resolved.headRepoId;
      } catch {
        return { notFound: true }; // the fork-edge / path-resolution miss (the 404 class)
      }
      const resolvedPair = await findRepositoryById(db, headRepoId);
      const resolvedRow = resolvedPair?.repo;
      if (resolvedRow === undefined) return { notFound: true };
      if (
        (await resolveRepositoryForViewer(env, options.viewer, resolvedRow.ownerNamespace, resolvedRow.slug)) ===
        null
      ) {
        return { notFound: true }; // the head repo's code-read miss (compare.go:186-188)
      }
      headRepoRow = resolvedRow;
      headRepo = {
        id: resolvedRow.id,
        ownerNamespace: resolvedRow.ownerNamespace,
        slug: resolvedRow.slug,
        defaultBranch: resolvedRow.defaultBranch,
      };
    }
  }

  const headReads = headRepo === null ? reads : engineReads(env, headRepoRow);
  const headRefs =
    headRepo === null ? refs : resolveHeadBranch(await headReads.listRefs(), headRepoRow.defaultBranch);
  if (headRefs.headBranch === null) return { notFound: true }; // unborn head repo
  const headName = options.head ?? headRepoRow.defaultBranch;
  const headKind = compareRefKindOf(headName, headRefs);
  if (headKind === null) return { notFound: true }; // unresolvable head side

  const headTip = await headReads.readCommit(headName);
  if (headTip === null) return { notFound: true };

  const directComparison = options.separator === "..";
  const sameTip = baseTip.oid === headTip.oid;
  // The compare prologue in the HEAD cell (services/git/compare.go:70-89):
  // `...` walks the merge base there; a cross-repo pair first fetches the
  // base commit into the head repo — the landed crossRepoCreateMergeBase
  // port (the carry + the head-cell walk). The `..` form skips the walk but
  // still fetches (the diff below reads both tips in the head cell), so the
  // port runs for it too with the answer computed-and-ignored.
  let mergeBaseOid: string | null = null;
  if (headRepo !== null) {
    const headPair = await findRepositoryById(db, headRepoRow.id);
    if (headPair === null) return { notFound: true };
    const apiCtx = new Context<ApiEnv>(new Request("http://compare.local/"), { env });
    const merged = await crossRepoCreateMergeBase(apiCtx, await basePairOf(db, repo), headPair, baseName, baseTip.oid, headTip.oid);
    if (!directComparison) mergeBaseOid = merged;
  } else if (!directComparison) {
    // Same-repo: a missing/failed walk is the no-common-history state (the
    // same honest render, the pull-engine.ts null-merge-base rule).
    const merged = await reads.mergeBase(baseTip.oid, headTip.oid);
    mergeBaseOid = merged !== null && merged.tag === "ok" ? merged.base : null;
  }
  // Upstream CompareInfo.CompareBase: the merge base for `...`, the base tip
  // itself for `..` (never null — the no-common-history fold is structurally
  // unreachable for the direct form). nothingToCompare = CompareBase == ""
  // (compare.go:376-378) OR the head IS the CompareBase (397-405). The range
  // + diff reads fold with it (prepareCompareDiff returns before either).
  const compareBaseOid = directComparison ? baseTip.oid : mergeBaseOid;
  const nothingToCompare = compareBaseOid === null || headTip.oid === compareBaseOid;

  // The range + the diff (only for a comparable pair — the nothing states
  // carry empty lists and the page skips both tables; an empty commits list
  // also leaves the form prefill empty, upstream's `if !cpi.nothingToCompare`
  // skip of the title/content setup, prepareCreatePullRequestPage). Both
  // reads run in the HEAD cell over CompareBase..head (ShowPrettyFormatLogToList
  // + GetDiffForRender's Before/AfterCommitID pair, services/git/compare.go:
  // 96-103). The range read is paginated 0-based (the API list route's own
  // convention, pull.go:975).
  const commits: CommitJson[] = [];
  let more = false;
  let files: DiffFileView[] = [];
  if (compareBaseOid !== null && !nothingToCompare) {
    const range = await headReads.listCommitsRange(compareBaseOid, headTip.oid, COMPARE_PAGE_SIZE, options.page - 1);
    if (range !== null) {
      // Engine order is oldest first; display reverses (commits_list order).
      commits.push(...[...range.commits].reverse());
      more = range.more;
    }
    const diff = await headReads.readDiff(headTip.oid, compareBaseOid);
    files = await diffFileViews(diff?.files ?? []);
  }

  // The existing open PR between the branches (upstream
  // prepareCreatePullRequestPage's GetUnmergedPullRequest arm) — branch pairs
  // only, keyed on the HEAD repo (ci.HeadRepo.ID, pull.go:1355).
  let existing: CompareData["existing"] = null;
  if (baseKind === "branch" && headKind === "branch") {
    const found = await findUnmergedPullRequest(db, headRepoRow.id, repo.id, headName, baseName);
    if (found !== null) existing = { index: found.pullRequest.index, title: found.issue.title };
  }

  // OwnForkRepo (compare.go:243-250 + the 281-297 dropdown group): the
  // signed-in non-owner viewer's own fork of the BASE repo, readable, and
  // distinct from the head repo and the root.
  let ownFork: CompareData["ownFork"] = null;
  if (options.viewer.kind === "user" && (repo.ownerId ?? -1) !== options.viewer.id) {
    const forkRow = await findForkByOwner(db, repo.id, options.viewer.id);
    const rootPair = repo.forkParent !== null ? await findRepositoryById(db, repo.forkParent) : null;
    if (
      forkRow !== null &&
      forkRow.id !== headRepoRow.id &&
      (rootPair === null || forkRow.id !== rootPair.repo.id) &&
      (await resolveRepositoryForViewer(env, options.viewer, forkRow.ownerNamespace, forkRow.slug)) !== null
    ) {
      const forkRefs = resolveHeadBranch(await engineReads(env, forkRow).listRefs(), forkRow.defaultBranch);
      if (forkRefs.headBranch !== null) {
        ownFork = {
          owner: forkRow.ownerNamespace,
          name: forkRow.slug,
          link: `/${forkRow.ownerNamespace}/${forkRow.slug}`,
          refs: forkRefs,
        };
      }
    }
  }

  // RootRepo (compare.go:229-274): the base's fork parent when distinct from
  // both the base and the head repo and readable (CheckRepoUnitUser's code
  // read → the §2.5 grant).
  let rootRepo: CompareData["rootRepo"] = null;
  if (repo.forkParent !== null && repo.forkParent !== headRepoRow.id) {
    const rootPair = await findRepositoryById(db, repo.forkParent);
    if (
      rootPair !== null &&
      rootPair.repo.id !== repo.id &&
      (await resolveRepositoryForViewer(env, options.viewer, rootPair.repo.ownerNamespace, rootPair.repo.slug)) !== null
    ) {
      const rootRefs = resolveHeadBranch(await engineReads(env, rootPair.repo).listRefs(), rootPair.repo.defaultBranch);
      if (rootRefs.headBranch !== null) {
        rootRepo = {
          owner: rootPair.repo.ownerNamespace,
          name: rootPair.repo.slug,
          link: `/${rootPair.repo.ownerNamespace}/${rootPair.repo.slug}`,
          refs: rootRefs,
        };
      }
    }
  }

  // The range's FIRST (oldest) commit — the engine returns oldest first, so
  // the display order's LAST entry is the prefill source.
  const rangeFirstCommit = commits.length > 0 ? (commits[commits.length - 1] as CommitJson) : null;

  return {
    refs,
    headRefs,
    baseName,
    headName,
    baseKind,
    headKind,
    baseTipOid: baseTip.oid,
    headTipOid: headTip.oid,
    separator: options.separator,
    directComparison,
    mergeBaseOid,
    compareBaseOid,
    sameTip,
    nothingToCompare,
    commits,
    more,
    files,
    totalAddition: files.reduce((sum, file) => sum + file.file.add, 0),
    totalDeletion: files.reduce((sum, file) => sum + file.file.del, 0),
    existing,
    suggestedTitle: rangeFirstCommit !== null ? rangeFirstCommit.subject : "",
    suggestedContent:
      commits.length === 1 && rangeFirstCommit !== null ? messageBodyOf(rangeFirstCommit) : "",
    headRepo,
    headRepoId: headRepoRow.id,
    ownFork,
    rootRepo,
  };
}

/** The base repo's `RepositoryWithOwner` pair (the carries' source shape). */
async function basePairOf(db: D1Database, repo: { id: string }): Promise<RepositoryWithOwner> {
  const pair = await findRepositoryById(db, repo.id);
  if (pair === null) throw new Error(`compare: base repo row vanished [id: ${repo.id}]`);
  return pair;
}

// ---------------------------------------------------------------------------
// Form parsing + the write (the landed create route's arms, in its order)
// ---------------------------------------------------------------------------

/** The parsed `application/x-www-form-urlencoded` submission (upstream
 *  CreateIssueForm's `title`/`content` pair). */
export interface ComparePullForm {
  title: string;
  content: string;
}

export function parseComparePullForm(params: URLSearchParams): ComparePullForm {
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
  };
}

/** Parse the urlencoded POST body (the prose default cap — title + body are
 *  bounded prose, forms.ts). */
export async function readComparePullForm(req: Request): Promise<ComparePullForm> {
  return parseComparePullForm(await readUrlEncodedForm(req));
}

export type ComparePullSubmitResult =
  | { outcome: "created"; issue: IssueRow; pr: PullRequestRow }
  | { outcome: "invalid"; message: string }
  | { outcome: "failed"; message: string };

/** Inputs of the write, resolved once by the POST handler (`request` is the
 *  hono context — structurally the IssueEventRequest the webhook seam takes). */
export interface ComparePullWriteInput {
  request: IssueEventRequest;
  /** The raw Request, for the API-context re-wrap the head-ref write takes. */
  raw: Request;
  origin: string;
  pair: RepositoryWithOwner;
  repo: { id: string; ownerNamespace: string; slug: string };
  doer: UserRow;
  data: CompareData;
  form: ComparePullForm;
}

/**
 * The write: the landed create route's fail-fast arms, then
 * `IssuesService.createPullRequest` + the refs/pull/N/head CAS write (the API
 * route's cleanup order deletes the D1 rows again when the ref write fails),
 * then the `pull_request opened` webhook fan-out through emitIssueEvent (the
 * wave-4/11 best-effort convention — never fails the created PR).
 */
export async function createPullFromForm(input: ComparePullWriteInput): Promise<ComparePullSubmitResult> {
  const { data, form } = input;
  // Upstream fail-fast (routes/pulls.ts:612-614 verbatim message) — the
  // SAME-ref arm only (IsSameRef, services/git/compare.go:41-43 — same
  // repository AND the same resolved ref; a cross-repo head never holds it,
  // whatever the names): the create side is tips-blind (pull.go:1318 has no
  // empty-diff gate) AND separator-blind (no DirectComparison gate), so an
  // equal-tips ACROSS-REF pair — and a hand-crafted `..` POST — falls
  // through and creates the empty PR under the page's AllowEmptyPr gate; the
  // ref-folding control is the landed refusal upstream's IsSameRef arm backs.
  if (data.headRepo === null && data.headName === data.baseName) {
    return { outcome: "invalid", message: "Invalid PullRequest: There are no changes between the head and the base" };
  }
  // parseCompareInfo's allowCreatePull arm: BOTH sides must be branches —
  // a tag/oid pair never creates (the have-tag page message).
  if (data.baseKind !== "branch" || data.headKind !== "branch") {
    return { outcome: "invalid", message: compareLocale.nothing_to_compare_have_tag };
  }
  // ci.CompareBase == "" (pull.go:1321-1324) — the merge-base miss; the `..`
  // form's CompareBase is the base tip itself, never empty.
  if (data.compareBaseOid === null) {
    return { outcome: "invalid", message: compareLocale.no_common_history };
  }
  if (form.title === "") {
    return { outcome: "invalid", message: compareLocale.title_required };
  }
  // GetUnmergedPullRequest duplicate check (ci.HeadRepo.ID keyed) → the
  // landed 409 message.
  const existing = await findUnmergedPullRequest(input.request.env.DB, data.headRepoId, input.repo.id, data.headName, data.baseName);
  if (existing !== null) {
    return { outcome: "invalid", message: pullRequestAlreadyExistsError(existing).message };
  }

  // The cross-repo create-compare seam (the API POST's exact order,
  // routes/pulls.ts:947-951): pr.MergeBase computes IN THE HEAD CELL
  // (crossRepoCreateMergeBase — the base-fetch carry ported with it), then
  // the head closure carries INTO the base cell so refs/pull/N/head can
  // land. Engine writes: a refusal above moved no bytes (upstream-true
  // order); a carry failure propagates (the honest 500, the API route's
  // posture).
  let mergeBase: string | null = null;
  if (data.headRepo !== null) {
    const headPair = await findRepositoryById(input.request.env.DB, data.headRepoId);
    if (headPair === null) return { outcome: "failed", message: "the head repository is gone" };
    const apiContext = new Context<ApiEnv>(input.raw, { env: input.request.env });
    mergeBase = await crossRepoCreateMergeBase(apiContext, input.pair, headPair, data.baseName, data.baseTipOid, data.headTipOid);
    await carryForkHeadIntoBase(apiContext, input.pair, headPair, data.headName, data.headTipOid);
  }

  let issue: IssueRow;
  let pr: PullRequestRow;
  try {
    const created = await new IssuesService(input.request.env.DB).createPullRequest({
      repoId: input.repo.id,
      headRepoId: data.headRepoId,
      baseBranch: data.baseName,
      headBranch: data.headName,
      title: form.title,
      content: form.content === "" ? null : form.content,
      posterId: input.doer.id,
      allowMaintainerEdit: true, // DefaultAllowMaintainerEdit (the API route's repo_unit default)
      headSha: data.headTipOid,
      // The cross-repo arm passes the computed merge base (the API POST's
      // `mergeBase: mergeBaseOid`); the same-repo form create keeps the
      // landed null shape (the lazy mergeability check computes it).
      ...(data.headRepo !== null ? { mergeBase } : {}),
    });
    issue = created.issue;
    pr = created.pullRequest;
  } catch (error) {
    return { outcome: "invalid", message: error instanceof Error ? error.message : "invalid pull request" };
  }

  // The base-repo head ref: a receive-less CAS write; failure after the D1
  // commit deletes the rows again (the API route's cleanup order, services/
  // pull/pull.go:157) and answers the gate's plain-text 500 (retryable-
  // unknown state).
  let headRefWritten = true;
  try {
    const apiContext = new Context<ApiEnv>(input.raw, { env: input.request.env });
    await createPullHeadRef(apiContext, input.pair, pr.index, data.headTipOid);
  } catch {
    headRefWritten = false;
  }
  if (!headRefWritten) {
    await drizzle(input.request.env.DB).delete(issues).where(eq(issues.id, issue.id));
    await drizzle(input.request.env.DB).delete(pullRequests).where(eq(pullRequests.id, pr.id));
    return { outcome: "failed", message: "the pull request head ref write failed" };
  }

  // The pull_request "opened" webhook family (routes/pulls.ts:705-710's
  // payload shape through the shared emitIssueEvent seam) — best-effort.
  try {
    const viewer: ApiViewer = {
      origin: input.origin,
      requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }),
    };
    const rendered = await toApiPullRequest(input.request.env.DB, viewer, input.pair, issue, pr, "single");
    await emitIssueEvent(input.request, {
      repoId: input.pair.repo.id,
      ownerId: input.pair.repo.ownerId,
      eventType: "pull_request",
      payload: {
        action: "opened",
        number: issue.index,
        pull_request: rendered,
        repository: toApiRepository(viewer, input.pair),
        sender: apiUserFromRow(input.doer, viewer),
        commit_id: "",
      },
    });
  } catch {
    // Best-effort (emitIssueEvent already contains its own failure posture;
    // the payload assembly must never fail the write).
  }

  return { outcome: "created", issue, pr };
}

// ---------------------------------------------------------------------------
// Components (repo/diff/compare.tmpl + commits_table.tmpl)
// ---------------------------------------------------------------------------

/** One dropdown group (compare.tmpl's per-repo menus: the page repo's own
 *  universes ride first; a cross-repo compare appends the head repo's, the
 *  viewer's OwnForkRepo's, and the RootRepo's — each with ITS OWN link
 *  shape, the upstream hrefs verbatim). */
interface CompareSelectorGroup {
  repoFullName: string;
  refs: string[];
  /** The group's item href (the per-group shapes of compare.tmpl:56-95 /
   *  127-166). */
  href: (ref: string) => string;
  /** Upstream marks `selected` only on the page repo's own groups. */
  marksActive: boolean;
}

/** One base/head dropdown (compare.tmpl:30-97 reduced to the no-JS shape —
 *  the flat branch-then-tag item list over the group sequence; the search
 *  input and the branches/tags tab buttons are Fomantic/JS features). */
function CompareSelector(props: {
  label: string;
  /** The active side's resolved ref name + its repo's display name (the
   *  button's `{label}: {fullName}:{active}` pair). */
  active: string;
  activeRepoFullName: string;
  groups: CompareSelectorGroup[];
}) {
  return (
    <div class="ui dropdown jump select-branch">
      <div class="ui basic small button">
        <span class="text">
          {props.label}:{" "}
          <strong>
            {props.activeRepoFullName}:{props.active}
          </strong>
        </span>
      </div>
      <div class="menu">
        {props.groups.flatMap((group) =>
          group.refs.map((name) => (
            <a class={group.marksActive && name === props.active ? "active item" : "item"} href={group.href(name)}>
              {group.repoFullName}:{name}
            </a>
          )),
        )}
      </div>
    </div>
  );
}

/** The commits_table block over the range (commits_table.tmpl: the count +
 *  sha pair header, the commits list, the pagination). The sha links ride
 *  CommitRepoLink = ci.HeadRepo.Link() (compare.go:383 — both sides link
 *  into the head repo) and the separator is the URL's own
 *  (CompareInfo.CompareSeparator). */
function CompareCommitsTable(props: { repoLink: string; data: CompareData; page: number; basePath: string }) {
  const { data } = props;
  return (
    <>
      <div class="ui top attached header flex-left-right">
        <div class="flex-text-block">
          {data.commits.length} {commitsLocale.commits}
        </div>
        <div class="flex-text-block">
          <a href={commitLink(props.repoLink, data.baseTipOid)} class="ui green sha label tw-mx-0">
            {shortSha(data.baseTipOid)}
          </a>
          <div class="compare-separator">{data.separator}</div>
          <a href={commitLink(props.repoLink, data.headTipOid)} class="ui green sha label tw-mx-0">
            {shortSha(data.headTipOid)}
          </a>
        </div>
      </div>
      {data.commits.length > 0 ? <CommitList repoLink={props.repoLink} commits={data.commits} /> : null}
      <CommitsPagination basePath={props.basePath} path="" page={props.page} more={data.more} />
    </>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderComparePage(options: {
  ctx: UiContext;
  data: CompareData;
  form: ComparePullForm;
  error: string | null;
  canCreate: boolean;
  /** The `?page=` clamp (the range log's pagination). */
  page: number;
}): string {
  return renderPage(
    <ComparePage
      ctx={options.ctx}
      data={options.data}
      form={options.form}
      error={options.error}
      canCreate={options.canCreate}
      page={options.page}
    />,
  );
}

/** The compare page (§2.4.1 discriminator: `repository diff[ compare pull]` —
 *  compare.tmpl:2, the `compare pull` tail only when the viewer is signed in
 *  over a PR-able branch pair (a merge base, tips unequal — the head flavor's
 *  own fold), upstream's PageIsComparePull shape). */
export function ComparePage(props: {
  ctx: UiContext;
  data: CompareData;
  form: ComparePullForm;
  error: string | null;
  canCreate: boolean;
  page: number;
}) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("ComparePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const repoFullName = `${repo.ownerNamespace}/${repo.slug}`;
  const es = pathEscapeSegments;
  // The cross-repo arm (PullRequestCtx.SameRepo false upstream): the head
  // repo's link/name and the fork prefix carried on every head side
  // (compare.tmpl's `{{if not SameRepo}}{{HeadUser}}/{{HeadRepo.Name}}:{{end}}`).
  const crossRepo = data.headRepo !== null;
  const headRepoLink = data.headRepo === null ? repoLink : `/${data.headRepo.ownerNamespace}/${data.headRepo.slug}`;
  const headRepoFullName = data.headRepo === null ? repoFullName : `${data.headRepo.ownerNamespace}/${data.headRepo.slug}`;
  const headPrefix = data.headRepo === null ? "" : `${es(data.headRepo.ownerNamespace)}/${es(data.headRepo.slug)}:`;
  const basePrefix = `${es(repo.ownerNamespace)}/${es(repo.slug)}:`;

  // Upstream comparable = NOT nothingToCompare (compare.go:376-378 +
  // 397-405): no common history, or the head IS the CompareBase (subsuming
  // same-tip; for `..` only the equal-tips arm is reachable).
  const comparable = !data.nothingToCompare;
  const branchPair = data.baseKind === "branch" && data.headKind === "branch";
  // IsSameRef (services/git/compare.go:41-43 — same repository && the same
  // resolved ref): cross-repo pairs never hold it, whatever the names.
  const sameRef = data.headRepo === null && data.baseName === data.headName;
  // AllowEmptyPr (compare.go:400-402), set ONLY in the head == CompareBase
  // arm — never for no-common-history, where upstream returns before it —
  // reduced: supportEmptyPr = !AutodetectManualMerge → true (the
  // autodetect-manual-merge unit config is unlanded); acrossRepoPr =
  // !IsSameRef.
  const allowEmptyPr = data.compareBaseOid !== null && data.headTipOid === data.compareBaseOid && !sameRef;
  // Upstream $allowCreatePR (compare.tmpl:173): the IsBranch pair, NOT
  // DirectComparison (the `..` pairs never offer the form), and the form
  // folds with the nothing state unless AllowEmptyPr.
  const allowCreatePR = branchPair && !data.directComparison && (comparable || allowEmptyPr);
  // The state arms' gate — upstream's router-level allowCreatePull back
  // PageIsComparePull (compare.go:305-306: IsBranch pair && CompareBase !=
  // ""): no-common-history folds it, the head==CompareBase state does NOT —
  // the existing-PR segment and the archived warning survive the fold there
  // (anonymous renders them with the page, the landed honest-state posture).
  // A `..` branch pair keeps it (its CompareBase is the base tip, never
  // empty) — the pull-flavored header with the form folded by the gate
  // above, exactly upstream's render.
  const pullArms = branchPair && data.compareBaseOid !== null;
  // The head flavor: upstream folds ONLY at no common history; ours also
  // folds at equal tips (wave-13 pins the same-tip shape code-flavored — the
  // landed divergence), so the head==CompareBase arm keeps the upstream pull
  // flavor.
  const comparePull = pullArms && !data.sameTip;
  const pageIsComparePull = comparePull && ctx.viewer.kind === "user" && !repo.isArchived;
  const showDiffBox = comparable && (data.commits.length > 0 || data.files.length > 0);
  // The nothing segment's three-way message (compare.tmpl:174-183): the
  // allow-empty-pr text when the form survives the fold, the plain text for
  // a branch pair, the have-tag text otherwise (a tag side folds
  // $allowCreatePR upstream too — as does every `..` pair). The
  // no-common-history arm never holds AllowEmptyPr, so its branch-pair
  // message stays the plain text.
  const nothingMessage = allowCreatePR
    ? compareLocale.nothing_to_compare_and_allow_empty_pr
    : branchPair
      ? compareLocale.nothing_to_compare
      : compareLocale.nothing_to_compare_have_tag;
  const basePath = crossRepo
    ? compareForkLink(repoLink, data.baseName, data.headRepo.ownerNamespace, data.headRepo.slug, data.headName)
    : compareLink(repoLink, data.baseName, data.headName);

  // The dropdown groups (compare.tmpl:56-95 base side / 127-166 head side,
  // in the template's order: the page repo's own universes, then — for a
  // cross-repo compare — the head repo's, then OwnForkRepo's, then
  // RootRepo's).
  // The dropdown groups (compare.tmpl:56-95 base side / 127-166 head side,
  // in the template's order: the page repo's own universes, then — for a
  // cross-repo compare — the head repo's, then OwnForkRepo's, then
  // RootRepo's). The head side of every BASE-side href carries the fork
  // prefix only when cross-repo (the `{{if not SameRepo}}` guards).
  const baseSideHref = (link: string, ref: string): string =>
    data.headRepo === null
      ? `${link}/compare/${es(ref)}...${es(data.headName)}`
      : compareForkLink(link, ref, data.headRepo.ownerNamespace, data.headRepo.slug, data.headName);
  const headSideHref = (prefix: string, ref: string): string =>
    `${repoLink}/compare/${es(data.baseName)}${data.separator}${prefix}${es(ref)}`;
  const baseGroups: CompareSelectorGroup[] = [
    { repoFullName, refs: data.refs.branches, marksActive: true, href: (ref) => baseSideHref(repoLink, ref) },
    { repoFullName, refs: data.refs.tags, marksActive: true, href: (ref) => baseSideHref(repoLink, ref) },
  ];
  const headGroups: CompareSelectorGroup[] = [
    {
      repoFullName: headRepoFullName,
      refs: data.headRefs.branches,
      marksActive: true,
      href: (ref) => headSideHref(headPrefix, ref),
    },
    {
      repoFullName: headRepoFullName,
      refs: data.headRefs.tags,
      marksActive: true,
      href: (ref) => headSideHref(headPrefix, ref),
    },
  ];
  if (crossRepo && data.headRepo !== null) {
    // The head repo's branches as BASE candidates (onto the head repo's own
    // compare page, compare.tmpl:60-64/80-84) and the base repo's as HEAD
    // candidates (the base repo prefix, compare.tmpl:131-135/151-155).
    baseGroups.push(
      { repoFullName: headRepoFullName, refs: data.headRefs.branches, marksActive: false, href: (ref) => baseSideHref(headRepoLink, ref) },
      { repoFullName: headRepoFullName, refs: data.headRefs.tags, marksActive: false, href: (ref) => baseSideHref(headRepoLink, ref) },
    );
    headGroups.push(
      { repoFullName, refs: data.refs.branches, marksActive: false, href: (ref) => headSideHref(basePrefix, ref) },
      { repoFullName, refs: data.refs.tags, marksActive: false, href: (ref) => headSideHref(basePrefix, ref) },
    );
  }
  if (data.ownFork !== null) {
    const ownFork = data.ownFork;
    const ownPrefix = `${es(ownFork.owner)}/${es(ownFork.name)}:`;
    baseGroups.push(
      { repoFullName: `${ownFork.owner}/${ownFork.name}`, refs: ownFork.refs.branches, marksActive: false, href: (ref) => baseSideHref(ownFork.link, ref) },
      { repoFullName: `${ownFork.owner}/${ownFork.name}`, refs: ownFork.refs.tags, marksActive: false, href: (ref) => baseSideHref(ownFork.link, ref) },
    );
    headGroups.push(
      { repoFullName: `${ownFork.owner}/${ownFork.name}`, refs: ownFork.refs.branches, marksActive: false, href: (ref) => headSideHref(ownPrefix, ref) },
      { repoFullName: `${ownFork.owner}/${ownFork.name}`, refs: ownFork.refs.tags, marksActive: false, href: (ref) => headSideHref(ownPrefix, ref) },
    );
  }
  if (data.rootRepo !== null) {
    const rootRepo = data.rootRepo;
    const rootPrefix = `${es(rootRepo.owner)}/${es(rootRepo.name)}:`;
    baseGroups.push(
      { repoFullName: `${rootRepo.owner}/${rootRepo.name}`, refs: rootRepo.refs.branches, marksActive: false, href: (ref) => baseSideHref(rootRepo.link, ref) },
      { repoFullName: `${rootRepo.owner}/${rootRepo.name}`, refs: rootRepo.refs.tags, marksActive: false, href: (ref) => baseSideHref(rootRepo.link, ref) },
    );
    headGroups.push(
      { repoFullName: `${rootRepo.owner}/${rootRepo.name}`, refs: rootRepo.refs.branches, marksActive: false, href: (ref) => headSideHref(rootPrefix, ref) },
      { repoFullName: `${rootRepo.owner}/${rootRepo.name}`, refs: rootRepo.refs.tags, marksActive: false, href: (ref) => headSideHref(rootPrefix, ref) },
    );
  }
  // The separator switch (compare.tmpl:99): the href carries the OTHER
  // separator ($compareSeparatorSwitch), the visible text the current one;
  // the head side carries the fork prefix when cross-repo.
  const switchSeparator = data.directComparison ? "..." : "..";

  return (
    <BaseLayout
      ctx={ctx}
      title={compareLocale.comparing_changes}
      pageClass={`repository diff${comparePull ? " compare pull" : ""}`}
      activeTab="code"
    >
      <div class="ui container fluid padded">
        <h2 class="ui header">
          {pageIsComparePull ? (
            <>
              {compareLocale.comparing_changes}
              <div class="sub header">{compareLocale.comparing_description}</div>
            </>
          ) : (
            compareLocale.compare_commits
          )}
        </h2>
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}

        <div class="ui segment choose branch">
          <a
            class="tw-mr-2"
            href={crossRepo ? compareForkLink(headRepoLink, data.headName, repo.ownerNamespace, repo.slug, data.baseName) : compareLink(repoLink, data.headName, data.baseName)}
            title={compareLocale.switch_head_and_base}
            aria-label={compareLocale.switch_head_and_base}
          >
            {compareLocale.switch_head_and_base}
          </a>
          <CompareSelector
            label={pageIsComparePull ? compareLocale.merge_into : compareLocale.base}
            active={data.baseName}
            activeRepoFullName={repoFullName}
            groups={baseGroups}
          />
          <a
            href={`${repoLink}/compare/${es(data.baseName)}${switchSeparator}${headPrefix}${es(data.headName)}`}
            title={compareLocale.switch_comparison_type}
            aria-label={compareLocale.switch_comparison_type}
          >
            <div class="compare-separator">{data.separator}</div>
          </a>
          <CompareSelector
            label={pageIsComparePull ? compareLocale.pull_from : compareLocale.compare}
            active={data.headName}
            activeRepoFullName={headRepoFullName}
            groups={headGroups}
          />
        </div>

        {/* The state arms (compare.tmpl:171-217 order): the nothing segment,
            then the existing-PR segment, the archived warning, and the form —
            the latter three riding upstream's PageIsComparePull gate. */}
        {!comparable ? <div class="ui segment">{nothingMessage}</div> : null}
        {pullArms && data.existing !== null ? (
          <div class="ui segment flex-text-block tw-gap-4">
            <div class="issue-title tw-break-anywhere">
              {data.existing.title}
              <span class="index">#{data.existing.index}</span>
            </div>
            <a href={`${repoLink}/pulls/${data.existing.index}`} class="ui compact button primary">
              {compareLocale.view_pull_request}
            </a>
          </div>
        ) : null}
        {pullArms && data.existing === null && repo.isArchived ? (
          <div class="ui warning message">{compareLocale.archived}</div>
        ) : null}
        {/* The form rides $allowCreatePR (compare.tmpl:204) and additionally
            the caller's writer gate (the module header's divergence note). */}
        {allowCreatePR && data.existing === null && !repo.isArchived && props.canCreate ? (
          <>
            <div class="ui info message flex-text-block">
              <span class="tw-flex-1">{compareLocale.new_description}</span>
            </div>
            <div class="pullrequest-form">
              <form class="issue-content ui comment form" id="new-issue" action={basePath} method="post">
                <div class="issue-content-left">
                  <div class="ui comments">
                    <div class="comment">
                      {/* The upstream avatar slot is omitted — no avatar route
                          exists (the new-issue page's shape). */}
                      <div class="ui segment content tw-my-0 avatar-content-left-arrow">
                        <div class="field">
                          <input
                            name="title"
                            id="issue_title"
                            required
                            maxlength={255}
                            autocomplete="off"
                            placeholder={compareLocale.title_placeholder}
                            value={props.form.title}
                          />
                        </div>
                        <div class="field">
                          <textarea id="content" name="content" rows={10}>
                            {props.form.content}
                          </textarea>
                        </div>
                        <div class="flex-text-block tw-justify-end">
                          <button type="submit" class="ui primary button">
                            {compareLocale.new_pull_request}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="issue-content-right ui segment">
                  {/* The base/head summary (the brief's arm; upstream's
                      compare_base/compare_compare pull-flavor labels). */}
                  <div class="issue-sidebar-combo" data-selection-mode="single">
                    <div class="fixed-text muted">
                      <strong>{compareLocale.merge_into}</strong>
                    </div>
                    <span class="item">
                      {repoFullName}:{data.baseName}
                    </span>
                    <div class="divider" />
                    <div class="fixed-text muted">
                      <strong>{compareLocale.pull_from}</strong>
                    </div>
                    <span class="item">
                      {headRepoFullName}:{data.headName}
                    </span>
                  </div>
                </div>
              </form>
            </div>
          </>
        ) : null}
      </div>

      {showDiffBox ? (
        <div class="ui container fluid padded tw-my-4">
          <CompareCommitsTable repoLink={headRepoLink} data={data} page={props.page} basePath={basePath} />
          <div class="diff-detail-box">
            <div class="flex-text-block tw-flex-wrap tw-ml-0.5">
              {data.files.length > 0 ? (
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
                  {data.files.length === 0 ? (
                    <h4>{pullFilesLocale.data_not_available}</h4>
                  ) : (
                    data.files.map((view) => <DiffFileBox view={view} />)
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </BaseLayout>
  );
}
