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
 * ## URL parse (routers/common/compare.go ParseCompareRouterParam, reduced)
 *
 * The decoded tail splits on the FIRST `...` (strings.Cut parity; refnames can
 * never carry `..`, so the separator is unambiguous); a missing separator makes
 * the whole tail the HEAD (upstream's single-ref family), and an empty side
 * falls back to the default branch (util.IfZero over GetPullRequestTargetBranch/
 * DefaultBranch) — the bare `/compare` renders the default...default comparison.
 * NOT claimed (→ the engine's 404, the documented divergences): the two-dot
 * `..` family (DirectComparison — a different diff semantic, not a landed
 * surface) and the `{owner}/{repo}:{head}` fork forms (forks cannot exist yet,
 * SPEC-0003).
 *
 * ## Semantics over the landed engine reads (SPEC-0001b §4.1/§10.8)
 *
 * Both sides resolve against listRefs (branch → tag → 7..64-hex oid —
 * ResolveRefWithSuffix reduced; an unresolvable side 404-shells exactly
 * upstream's NotFound), then `mergeBase(baseTip, headTip)`:
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
 *     !IsSameRef → the resolved ref names differing (services/git/
 *     compare.go:41-43 — same repository && BaseRef == HeadRef; compares
 *     are always same-repository here, the fork family 404s at the parser).
 *     The POST completes the loop (the wave-129 compare-parity posture
 *     flipped): upstream's create side has NO tips gate — the web handler
 *     (pull.go:1318 CompareAndPullRequestPost) accepts the empty diff
 *     unconditionally, the AllowEmptyPr render gate (compare.go:400-402) is
 *     the only control — so the equal-tips ACROSS-REF pair creates; the
 *     SAME-ref arm keeps the landed refusal (the headName === baseName gate,
 *     upstream's IsSameRef reduction).
 *   - otherwise `listCommitsRange(base..head)` (oldest first — DISPLAYED
 *     reversed, newest first like upstream's commits_list) and
 *     `readDiff(head, mergeBase)` (id2..id = mergeBase...head — the three-dot
 *     diff; a null merge base renders the empty range, pull-engine.ts's own
 *     composition rule) rendered through pull-files' DiffFileBox components.
 *
 * ## The new-PR write (the landed create route's arms, CompareAndPullRequestPost)
 *
 * The §2.8 Origin guard, the repo resolution, the anonymous login 303, then the
 * WRITER gate (`canWriteRepo` — the file-editor predicate; a divergence from
 * upstream's reqUnitPullsReader, documented below: without forks a head branch
 * is a writer's artifact, and a non-writer's form would be a broken
 * submission), then the same fail-fast order routes/pulls.ts POST runs:
 * head === base → the 422 message, no common history → no_common_history,
 * duplicate open PR → the landed 409 message (findUnmergedPullRequest),
 * empty title → the title-required re-render. Equal tips refuse NO arm here
 * (upstream's create side is tips-blind): the across-ref pair creates the
 * empty PR under AllowEmptyPr, the same-ref pair already refused above. The
 * create rides `IssuesService.createPullRequest` (the same fields the API POST
 * passes: poster = the session viewer, allow_maintainer_edit =
 * DefaultAllowMaintainerEdit, headSha = the head tip), the refs/pull/N/head
 * CAS write follows (`createPullHeadRef`, the API route's cleanup order on
 * failure: the D1 rows delete again, the gate's plain-text 500 answered), the
 * `pull_request opened` webhook fans out through emitIssueEvent (the wave-4/11
 * UI-emission convention), and success 303s onto
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
 *   Fomantic/JS features — the flat branch-then-tag item list of
 *   components/branch-selector.tsx is the no-JS shape.
 * - The icon-only switch controls (octicon-git-compare head/base swap,
 *   octicon-arrow-left separator type switch, octicon-triangle-down dropdown
 *   carets) are outside the generated icon allowlist (the pull-files tabs
 *   degradation): the head/base swap renders as its title text, the `...`
 *   separator renders as plain text (the `..` switch target is not a landed
 *   surface — a live link would 404, the dead-link rule).
 * - `?expand=1`/`quick_pull` (the form's prefill-expand query family) and the
 *   PR templates are not honored — the form renders expanded with the
 *   commit-derived prefill only.
 * - The `.diff`/`.patch` download suffixes on the compare family
 *   (DownloadCompareDiff/Patch) stay engine-owned (404) — not in this slice.
 * - Anonymous no-common-history renders the nothing-to-compare segment
 *   (upstream leaves that page bare for anonymous viewers — the honest-state
 *   reduction).
 * - The commits count in the table header is the FETCHED page count (upstream
 *   shows the whole range's count before pagination).
 */

import { Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { CommitJson } from "@cf-gitea/git-engine";

import type { ApiEnv } from "../../api/env";
import { engineReads } from "../../api/services/engine";
import { createPullHeadRef } from "../../api/services/pull-engine";
import { findUnmergedPullRequest, pullRequestAlreadyExistsError, toApiPullRequest } from "../../api/services/pulls";
import {
  apiUserFromRow,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";
import type { Viewer as ApiViewer } from "../../api/services/repository";
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

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed engine reads, never a self-fetch)
// ---------------------------------------------------------------------------

/** Which universe a compare side resolved from (upstream RefName.IsBranch/
 *  IsTag — the create gate reads the branch-ness of BOTH sides). */
export type CompareRefKind = "branch" | "tag" | "commit";

/** The compare page render inputs, loaded by loadCompareData. */
export interface CompareData {
  /** The repo's full branch/tag universes (the two dropdowns). */
  refs: ResolvedRefs;
  /** The RESOLVED short names (a URL side may be the default-branch fallback). */
  baseName: string;
  headName: string;
  baseKind: CompareRefKind;
  headKind: CompareRefKind;
  baseTipOid: string;
  headTipOid: string;
  /** The merge base oid; `null` = no common history (the POST's
   *  no_common_history arm keys on this too). */
  mergeBaseOid: string | null;
  /** baseTip === headTip (the POST's landed equal-tips refusal arm). */
  sameTip: boolean;
  /** Upstream nothingToCompare (compare.go:376-378 + 397-405): no common
   *  history OR the head IS the merge base (subsuming same-tip) — the
   *  segment state; the commits table + the diff box fold with it. */
  nothingToCompare: boolean;
  /** The range's commits in DISPLAY order (newest first — the engine returns
   *  base..head oldest first; commits_list.tmpl renders newest first). */
  commits: CommitJson[];
  /** The range log's more flag (the Older link). */
  more: boolean;
  files: DiffFileView[];
  totalAddition: number;
  totalDeletion: number;
  /** The open PR between the two branches (branch pairs only —
   *  findUnmergedPullRequest's exact targets), `null` = none. */
  existing: { index: number; title: string } | null;
  /** The form prefill: the range's FIRST (oldest) commit subject, and — for a
   *  one-commit range — that commit's message body (upstream's
   *  prepareNewPullRequestTitleContent arms). */
  suggestedTitle: string;
  suggestedContent: string;
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
 * a side that resolves to no branch/tag/oid, or an engine read that cannot
 * return either tip (upstream ResolveRefWithSuffix's not-found arm).
 */
export async function loadCompareData(
  env: Env,
  db: D1Database,
  repo: { id: string; ownerNamespace: string; slug: string; defaultBranch: string },
  options: { base: string | null; head: string | null; page: number },
): Promise<CompareData | CompareNotFound> {
  const reads = engineReads(env, repo);
  const refs = resolveHeadBranch(await reads.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { notFound: true }; // unborn repo

  // The sides (util.IfZero fallbacks — the parser's nulls are the default
  // branch upstream's GetPullRequestTargetBranch/DefaultBranch answer).
  const baseName = options.base ?? repo.defaultBranch;
  const headName = options.head ?? repo.defaultBranch;
  const baseKind = compareRefKindOf(baseName, refs);
  const headKind = compareRefKindOf(headName, refs);
  if (baseKind === null || headKind === null) return { notFound: true }; // unresolvable side

  // readCommit accepts branch/tag/oid uniformly; a null is the unreachable tip.
  const baseTip = await reads.readCommit(baseName);
  const headTip = await reads.readCommit(headName);
  if (baseTip === null || headTip === null) return { notFound: true };

  const sameTip = baseTip.oid === headTip.oid;
  // mergeBase(base, head) → the three-dot composition's base; a missing/failed
  // walk is the no-common-history state (the same honest render, the pull-
  // engine.ts null-merge-base rule).
  const merged = await reads.mergeBase(baseTip.oid, headTip.oid);
  const mergeBaseOid = merged !== null && merged.tag === "ok" ? merged.base : null;
  // Upstream nothingToCompare (compare.go:376-378 the CompareBase == "" arm;
  // 397-405 the head == CompareBase arm — the head is already on the base,
  // nothing to bring; equal tips subsume, the merge-base of equal tips being
  // that tip). The range + diff reads fold with it (prepareCompareDiff
  // returns before computing either).
  const nothingToCompare = mergeBaseOid === null || headTip.oid === mergeBaseOid;

  // The range + the diff (only for a comparable pair — the nothing states
  // carry empty lists and the page skips both tables; an empty commits list
  // also leaves the form prefill empty, upstream's `if !cpi.nothingToCompare`
  // skip of the title/content setup, prepareCreatePullRequestPage). The range
  // read is paginated 0-based (the API list route's own convention, pull.go:975).
  const commits: CommitJson[] = [];
  let more = false;
  let files: DiffFileView[] = [];
  if (mergeBaseOid !== null && !nothingToCompare) {
    const range = await reads.listCommitsRange(baseTip.oid, headTip.oid, COMPARE_PAGE_SIZE, options.page - 1);
    if (range !== null) {
      // Engine order is oldest first; display reverses (commits_list order).
      commits.push(...[...range.commits].reverse());
      more = range.more;
    }
    const diff = await reads.readDiff(headTip.oid, mergeBaseOid);
    files = await diffFileViews(diff?.files ?? []);
  }

  // The existing open PR between the branches (upstream
  // prepareCreatePullRequestPage's GetUnmergedPullRequest arm) — branch pairs
  // only, the same targets the create route checks.
  let existing: CompareData["existing"] = null;
  if (baseKind === "branch" && headKind === "branch") {
    const found = await findUnmergedPullRequest(db, repo.id, repo.id, headName, baseName);
    if (found !== null) existing = { index: found.pullRequest.index, title: found.issue.title };
  }

  // The range's FIRST (oldest) commit — the engine returns oldest first, so
  // the display order's LAST entry is the prefill source.
  const rangeFirstCommit = commits.length > 0 ? (commits[commits.length - 1] as CommitJson) : null;

  return {
    refs,
    baseName,
    headName,
    baseKind,
    headKind,
    baseTipOid: baseTip.oid,
    headTipOid: headTip.oid,
    mergeBaseOid,
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
  };
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
  // SAME-ref arm only (IsSameRef, services/git/compare.go:41-43): the
  // create side is tips-blind (pull.go:1318 has no empty-diff gate), so an
  // equal-tips ACROSS-REF pair falls through and creates the empty PR under
  // the page's AllowEmptyPr gate; the ref-folding control is the landed
  // refusal upstream's IsSameRef arm backs.
  if (data.headName === data.baseName) {
    return { outcome: "invalid", message: "Invalid PullRequest: There are no changes between the head and the base" };
  }
  // parseCompareInfo's allowCreatePull arm: BOTH sides must be branches —
  // a tag/oid pair never creates (the have-tag page message).
  if (data.baseKind !== "branch" || data.headKind !== "branch") {
    return { outcome: "invalid", message: compareLocale.nothing_to_compare_have_tag };
  }
  if (data.mergeBaseOid === null) {
    return { outcome: "invalid", message: compareLocale.no_common_history };
  }
  if (form.title === "") {
    return { outcome: "invalid", message: compareLocale.title_required };
  }
  // GetUnmergedPullRequest duplicate check → the landed 409 message.
  const existing = await findUnmergedPullRequest(input.request.env.DB, input.repo.id, input.repo.id, data.headName, data.baseName);
  if (existing !== null) {
    return { outcome: "invalid", message: pullRequestAlreadyExistsError(existing).message };
  }

  let issue: IssueRow;
  let pr: PullRequestRow;
  try {
    const created = await new IssuesService(input.request.env.DB).createPullRequest({
      repoId: input.repo.id,
      headRepoId: input.repo.id,
      baseBranch: data.baseName,
      headBranch: data.headName,
      title: form.title,
      content: form.content === "" ? null : form.content,
      posterId: input.doer.id,
      allowMaintainerEdit: true, // DefaultAllowMaintainerEdit (the API route's repo_unit default)
      headSha: data.headTipOid,
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

/** One base/head dropdown (compare.tmpl:30-97 reduced to the no-JS shape —
 *  the flat branch-then-tag item list; the search input and the branches/tags
 *  tab buttons are Fomantic/JS features). */
function CompareSelector(props: {
  side: "base" | "head";
  label: string;
  repoFullName: string;
  refs: ResolvedRefs;
  active: string;
  /** The comparison's OTHER side, kept across the switch. */
  other: string;
  repoLink: string;
}) {
  const item = (name: string) => {
    const href =
      props.side === "base" ? compareLink(props.repoLink, name, props.other) : compareLink(props.repoLink, props.other, name);
    const isActive = name === props.active;
    return (
      <a class={isActive ? "active item" : "item"} href={href}>
        {props.repoFullName}:{name}
      </a>
    );
  };
  return (
    <div class="ui dropdown jump select-branch">
      <div class="ui basic small button">
        <span class="text">
          {props.label}:{" "}
          <strong>
            {props.repoFullName}:{props.active}
          </strong>
        </span>
      </div>
      <div class="menu">
        {props.refs.branches.map(item)}
        {props.refs.tags.map(item)}
      </div>
    </div>
  );
}

/** The commits_table block over the range (commits_table.tmpl: the count +
 *  sha pair header, the commits list, the pagination). */
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
          <div class="compare-separator">...</div>
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

  // Upstream comparable = NOT nothingToCompare (compare.go:376-378 +
  // 397-405): no common history, or the head IS the merge base (subsuming
  // same-tip).
  const comparable = !data.nothingToCompare;
  const branchPair = data.baseKind === "branch" && data.headKind === "branch";
  // AllowEmptyPr (compare.go:400-402), set ONLY in the head == CompareBase
  // arm — never for no-common-history, where upstream returns before it —
  // reduced: supportEmptyPr = !AutodetectManualMerge → true (the
  // autodetect-manual-merge unit config is unlanded); acrossRepoPr =
  // !IsSameRef → the resolved ref names differing (services/git/compare.go:
  // 41-43 — same repository && BaseRef == HeadRef; compares are always
  // same-repository here, the fork family 404s at the parser).
  const allowEmptyPr = data.headTipOid === data.mergeBaseOid && data.baseName !== data.headName;
  // Upstream $allowCreatePR (compare.tmpl:173): the IsBranch pair, not
  // DirectComparison (the `..` family is an unlanded surface — the parser
  // 404s it), and the form folds with the nothing state unless AllowEmptyPr.
  const allowCreatePR = branchPair && (comparable || allowEmptyPr);
  // The state arms' gate — upstream's router-level allowCreatePull back
  // PageIsComparePull (compare.go:305-306: IsBranch pair && CompareBase !=
  // ""): no-common-history folds it, the head==mergeBase state does NOT —
  // the existing-PR segment and the archived warning survive the fold there
  // (anonymous renders them with the page, the landed honest-state posture).
  const pullArms = branchPair && data.mergeBaseOid !== null;
  // The head flavor: upstream folds ONLY at no common history; ours also
  // folds at equal tips (wave-13 pins the same-tip shape code-flavored — the
  // landed divergence), so the head==mergeBase arm keeps the upstream pull
  // flavor.
  const comparePull = pullArms && !data.sameTip;
  const pageIsComparePull = comparePull && ctx.viewer.kind === "user" && !repo.isArchived;
  const showDiffBox = comparable && (data.commits.length > 0 || data.files.length > 0);
  // The nothing segment's three-way message (compare.tmpl:174-183): the
  // allow-empty-pr text when the form survives the fold, the plain text for
  // a branch pair, the have-tag text otherwise (a tag side folds
  // $allowCreatePR upstream too). The no-common-history arm never holds
  // AllowEmptyPr, so its branch-pair message stays the plain text.
  const nothingMessage = allowCreatePR
    ? compareLocale.nothing_to_compare_and_allow_empty_pr
    : branchPair
      ? compareLocale.nothing_to_compare
      : compareLocale.nothing_to_compare_have_tag;
  const basePath = compareLink(repoLink, data.baseName, data.headName);

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
            href={compareLink(repoLink, data.headName, data.baseName)}
            title={compareLocale.switch_head_and_base}
            aria-label={compareLocale.switch_head_and_base}
          >
            {compareLocale.switch_head_and_base}
          </a>
          <CompareSelector
            side="base"
            label={pageIsComparePull ? compareLocale.merge_into : compareLocale.base}
            repoFullName={repoFullName}
            refs={data.refs}
            active={data.baseName}
            other={data.headName}
            repoLink={repoLink}
          />
          <div class="compare-separator">...</div>
          <CompareSelector
            side="head"
            label={pageIsComparePull ? compareLocale.pull_from : compareLocale.compare}
            repoFullName={repoFullName}
            refs={data.refs}
            active={data.headName}
            other={data.baseName}
            repoLink={repoLink}
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
                      {repoFullName}:{data.headName}
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
          <CompareCommitsTable repoLink={repoLink} data={data} page={props.page} basePath={basePath} />
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
