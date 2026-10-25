/**
 * The PR commits page, `/{owner}/{repo}/pulls/{index}/commits` — the PR tab
 * menu's middle member (SPEC-0008 U3 extension; the three-tab menu completes:
 * Conversation + Commits + Files, the order and shape of upstream
 * templates/repo/pulls/tab_menu.tmpl at the pin fc4936884584).
 *
 * ## DOM contract (templates/repo/pulls/commits.tmpl + repo/issue/view_title.
 *  tmpl + repo/pulls/tab_menu.tmpl + repo/commits_table.tmpl + repo/
 *  commits_list.tmpl at the pin)
 *
 * `.page-content.repository.view.issue.pull.commits`, then one
 * `.ui.container` holding the upstream page order: the `view_title` bar
 * (issue-detail.tsx's IssueTitleBar over the same row — commits.tmpl:6), the
 * PR tab menu with the Commits tab active (commits.tmpl:7;
 * issue-detail.tsx's PullTabs, all three members with the upstream counts —
 * Conversation carries the issue's comment count, Commits the range's count,
 * Files the empty "-" branch), and `repo/commits_table`: the
 * `.ui.top.attached.header.flex-left-right` count line ("{n} Commits" —
 * commitsLocale.commits, "repo.commits.commits"; the compare family's
 * sha-pair right half is `IsDiffCompare`-only and never renders here), the
 * commits_list rows (components/commit-list — subject link onto the commit
 * view, author, short-sha label, relative date), and base/paginate (the
 * commits page's CommitsPagination over `?page=`).
 *
 * ## Data (§3.2 — the landed reads, never a self-fetch)
 *
 * The PR commit range, composed exactly like the diff service's
 * `merge_base...refs/pull/N/head` (src/api/services/pull-engine.ts:116-138 —
 * pullRequestDiff's composition minus the diff read): the row loaders
 * (findIssueByRepoAndIndex + findPullRequestByIndex) fetch the PR, then
 * `engineReads` (src/api/services/engine.ts) resolves the base branch tip
 * (`branchRef(pr.baseBranch)`) and the PR head (`pullHeadRef(pr.index)`),
 * the merge base rides the row's cached `pr.mergeBase` with the engine's
 * mergeBase RPC as the fallback (pullRequestDiff's own order), and
 * `listCommitsRange(mergeBase, headOid)` — the read compare.tsx's wave-13
 * commits table is built on — walks base..head oldest-first, Kahn
 * topological, paged (packages/git-engine NOTICE.md; display reverses to
 * commits_list's newest-first order). A null merge base (unrelated
 * histories) is the empty range — pullRequestDiff's own null-merge-base
 * rule — rendering the "0 Commits" header with no rows.
 *
 * ## Auth + posture
 *
 * Public anonymous GET like every read page (the router resolved the repo
 * first, §2.5). A non-pull row 404-shells — the upstream route hangs off the
 * `/{type:pulls}/{index}` group only (web.go ViewPullCommits,
 * routers/web/repo/pull.go:631-668), and an unresolvable base/head is that
 * route's `prCompareInfo.HeadCommitID == "" → ctx.NotFound` arm verbatim
 * (pull.go:645-647).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - Upstream fetches the WHOLE range unpaginated (GetPullRequestCommits —
 *   the tab badge and the header count are the full range size). The engine
 *   read is paged, so this page paginates at the commits page's
 *   CommitsRangeSize (50 per `?page=`), and BOTH counts are the FETCHED
 *   page's size (compare.tsx's documented count degradation, applied to the
 *   tab badge too).
 * - The Files tab's count renders upstream's empty branch ("-") on this
 *   page: the number would cost the full engine diff read on every commits
 *   view (the files page shows the real count) — the wave-5 posture for
 *   engine-cost tab counts, now symmetric (the Commits count renders "-"
 *   on the conversation and files pages for the same reason).
 * - The tab octicons (octicon-comment-discussion/git-commit/diff) are
 *   outside the generated icon allowlist (scripts/gen-ui-icons.mjs is not a
 *   ui/ file) — the tabs render text + count labels only (the wave-5 note).
 * - upstream's right-hand commits_table extras (the follow-renames
 *   checkbox, the `PageIsCommits` search form) are compare/branch-log
 *   features that do not render on this page upstream either — only the
 *   count line, the list and the pagination are this page's template body.
 */

import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { CommitJson } from "@cf-gitea/git-engine";

import { branchRef, engineReads, pullHeadRef } from "../../api/services/engine";
import { findIssueByRepoAndIndex } from "../../api/services/issues";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { users } from "../../db/schema";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { CommitList, commitsLocale } from "../components/commit-list";
import { IssueTitleBar, PullTabs, type IssueTitleData } from "./issue-detail";
import { CommitsPagination } from "./commits";
import { parsePageNumber } from "../page-data";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/**
 * The PR commits page's page size — upstream `setting.Git.CommitsRangeSize`
 * (modules/setting/git.go:44), the commits page's own constant. Upstream's
 * PR commits tab fetches the whole range; the engine's paged read is the
 * documented degradation (module header).
 */
export const PULL_COMMITS_PAGE_SIZE = 50;

/** The PR commits page render inputs, loaded by loadPullCommitsData. */
export interface PullCommitsData {
  issue: IssueRow;
  pr: PullRequestRow;
  /** Display-cased names for the title bar (null = no user row). */
  posterName: string | null;
  mergerName: string | null;
  /** The fetched page of the range, in DISPLAY order (newest first — the
   *  engine returns base..head oldest first; commits_list order). */
  commits: CommitJson[];
  /** The range log's more flag (the Older link). */
  more: boolean;
  /** The `?page=` clamp (1 = the oldest page of the range, the engine
   *  read's 0-based convention). */
  page: number;
}

/**
 * Load the PR + its merge-base..head commit range. Returns `null` when the
 * row misses, is not a pull, or the base/head refs do not resolve (upstream
 * ViewPullCommits' NotFound arm, pull.go:645-647 — the caller 404-shells).
 * A null merge base (unrelated histories) is the empty range render, not a
 * 404 — pullRequestDiff's composition rule.
 */
export async function loadPullCommitsData(
  env: Env,
  repo: { id: string; ownerNamespace: string; slug: string },
  index: number,
  rawPage: string | null,
): Promise<PullCommitsData | null> {
  const issue = await findIssueByRepoAndIndex(env.DB, repo.id, index);
  if (issue === null || !issue.isPull) return null;
  const prRow = await findPullRequestByIndex(env.DB, repo.id, index);
  if (prRow === null) return null;
  const pr = prRow.pullRequest;

  const reads = engineReads(env, repo);
  const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
  const headCommit = await reads.readCommit(pullHeadRef(pr.index));
  // Upstream 404s when the head commit id is missing (pull.go:645-647); an
  // unresolvable base branch is the same dead range.
  if (baseTip === null || headCommit === null) return null;

  // The row's cached merge base first — pullRequestDiff's exact order (the
  // lazy check owns the cache write; the UI never triggers it, §2.5).
  const mergeBase =
    pr.mergeBase ??
    (await (async () => {
      const merged = await reads.mergeBase(baseTip.oid, headCommit.oid);
      return merged !== null && merged.tag === "ok" ? merged.base : null;
    })());

  const page = parsePageNumber(rawPage);
  let commits: CommitJson[] = [];
  let more = false;
  if (mergeBase !== null) {
    const range = await reads.listCommitsRange(mergeBase, headCommit.oid, PULL_COMMITS_PAGE_SIZE, page - 1);
    if (range !== null) {
      // Engine order is oldest first; display reverses (commits_list order).
      commits = [...range.commits].reverse();
      more = range.more;
    }
  }

  // The title bar's two names (the detail page's batched-name pattern).
  const personIds = new Set<number>();
  if (issue.posterId !== null) personIds.add(issue.posterId);
  if (pr.hasMerged && pr.mergerId != null) personIds.add(pr.mergerId);
  const names = new Map<number, string>();
  if (personIds.size > 0) {
    const rows = await drizzle(env.DB)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...personIds]))
      .all();
    for (const row of rows) names.set(row.id, row.username);
  }

  return {
    issue,
    pr,
    posterName: issue.posterId === null ? null : (names.get(issue.posterId) ?? null),
    mergerName: pr.hasMerged ? (names.get(pr.mergerId ?? -1) ?? null) : null,
    commits,
    more,
    page,
  };
}

/** The full-document render (the render.tsx pattern). */
export function renderPullCommitsPage(options: { ctx: UiContext; data: PullCommitsData }): string {
  return renderPage(<PullCommitsPage ctx={options.ctx} data={options.data} />);
}

/** The PR commits page (§2.4.1 discriminator: `repository view issue pull
 *  commits` — pulls/commits.tmpl:3 verbatim). */
export function PullCommitsPage(props: { ctx: UiContext; data: PullCommitsData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("PullCommitsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const titleData: IssueTitleData = {
    issue: data.issue,
    pr: data.pr,
    posterName: data.posterName,
    mergerName: data.mergerName,
  };
  return (
    <BaseLayout
      ctx={ctx}
      title={`#${data.issue.index} - ${data.issue.title}`}
      pageClass="repository view issue pull commits"
      activeTab="pulls"
    >
      <div class="ui container">
        <IssueTitleBar data={titleData} />
        <PullTabs
          repoLink={repoLink}
          issue={data.issue}
          active="commits"
          commitsCount={data.commits.length}
          filesCount={null}
        />
        {/* commits_table's count line (the right half is the compare family's
            IsDiffCompare sha pair — never on this page). */}
        <div class="ui top attached header flex-left-right">
          <div class="flex-text-block">
            {data.commits.length} {commitsLocale.commits}
          </div>
        </div>
        {data.commits.length > 0 ? <CommitList repoLink={repoLink} commits={data.commits} /> : null}
        <CommitsPagination
          basePath={`${repoLink}/pulls/${data.issue.index}/commits`}
          path=""
          page={data.page}
          more={data.more}
        />
      </div>
    </BaseLayout>
  );
}
