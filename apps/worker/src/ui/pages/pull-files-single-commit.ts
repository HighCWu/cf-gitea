/**
 * The pull-files SINGLE-COMMIT page — the compare-feeds family's named
 * follow-on arm (the ef1aaa4 open issue 3): one commit's own file changes,
 * upstream `repo.ViewPullFilesForSingleCommit` (routers/web/repo/pull.go:953-957)
 * delegating to `viewPullFiles("", sha)` (pull.go:680-950, the isSingleCommit
 * arm at pull.go:706,732-738).
 *
 * ## The surface (a documented mount divergence)
 *
 * Upstream at the pin serves this handler at
 * `/{owner}/{repo}/pulls/{index}/commits/{sha}` (web.go:1663,
 * `{sha:[a-f0-9]{7,64}}`), while the `/files` group admits only the bare
 * tail and the `{shaFrom}..{shaTo}` pair (web.go:1671-1672) — a single-sha
 * `/files/{sha}` segment is upstream's pattern miss → 404. The landed window
 * names the `/files/{sha}` tail as this family (the compare-feeds test's
 * HANDOFF NOTE: "the bare and single-commit `/files/{sha}` tails stay
 * unclaimed — the single-commit route is upstream's
 * ViewPullFilesForSingleCommit"), so this module claims that tail; the
 * dispatcher mounts it in the pulls arm (`rest.length === 3 &&
 * rest[1] === "files"`) AFTER compare-feeds' `parsePullFilesRange` claim.
 * The two grammars are disjoint (the hex class admits no dot; the range
 * pattern demands `..`), so the try-order is safe either way. The bare
 * `/files` tail (upstream ViewPullFilesForAllCommitsOfPr) stays unclaimed.
 *
 * ## Upstream semantics (pull.go:680-950, the ports)
 *
 * - `getPullInfo` (pull.go:115-150): a missing row 404s; a non-pull row
 *   REDIRECTS upstream — the landed family's documented no-redirect
 *   divergence (404) applies here too.
 * - `prCompareInfo.HeadCommitID == ""` → 404 (pull.go:697-700): the broken
 *   PR (refs/pull/N/head unresolvable).
 * - The PR's commit list is half-open `(CompareBase, head]` (pull.go:707-709);
 *   admission is `indexCommit`'s EXACT full-oid string equality against that
 *   list (pull.go:670-677, 718), OR the direct `GetCommit` escape when the
 *   sha equals the head oid itself (pull.go:719-724 — the empty-list case:
 *   unrelated histories, where GetCompareInfo returns no list at all,
 *   services/git/compare.go:91-93, or an already-merged head). A SHORT
 *   prefix never equals a full oid → 404. The merge base itself is NOT
 *   admitted — the handler's own comment: "it doesn't support showing files
 *   from mergebase to the special commit otherwise it will be ambiguous"
 *   (pull.go:954-955).
 * - `isSingleCommit` (this arm always): before = the after commit's FIRST
 *   PARENT — `afterCommit.Parent(ctx, gitRepo, 0)` (pull.go:732-738) — and
 *   the diff is the direct two-commit pair (getDiffBasic's two-arg form,
 *   services/gitdiff/gitdiff.go:1326-1337), exactly one commit's own changes.
 * - CompareBase for the list: the base branch tip's merge base, or the
 *   STORED merge base when the base branch is gone (prepareViewOpenPullInfo,
 *   pull.go:560-568 — baseRef := pull.MergeBase). Unlike the range arm, an
 *   unrelated-history PR does NOT 404 here: the list is simply empty and
 *   admission rides the head escape (upstream never consults CompareBase in
 *   the single-commit admission path).
 * - The empty diff renders upstream's DiffNotAvailable arm
 *   (`ctx.Data["DiffNotAvailable"]`, pull.go:900; tplPullFiles' `<h4>Diff
 *   Content Not Available</h4>`) — e.g. an empty commit.
 *
 * ## The root-commit divergence (deliberate, mission-directed)
 *
 * Upstream CRASHES on a root commit here: `Parent(0)` over zero parents is
 * `ErrNotExist` (modules/git/commit.go:41-46) → `ctx.ServerError` → 500
 * (pull.go:733-737). This port renders the DiffNotAvailable arm instead
 * (before = null, files = []): refusing to reproduce a 500 edge beats
 * emulating a crash, per the wave brief ("root commit → the empty-diff/
 * DiffNotAvailable arm"). A root-commit PR head is reachable only through
 * the head escape (unrelated histories — the PR list can never contain a
 * root commit, since a non-empty list implies a shared merge base).
 *
 * ## Render reuse (no duplication)
 *
 * The page is the SAME tplPullFiles the range arm serves (pull.go:950), so
 * `renderPullFilesRangePage` is REUSED verbatim via import from
 * compare-feeds — the data shape (`PullFilesRangeData`) matches one-to-one;
 * only the endpoints' meaning differs (before is the commit's first parent,
 * never a URL-chosen range side; "" for the root arm). The loader's row
 * prologue (issue/PR/repo rows, the merge-base resolution, the batched
 * poster/merger names) mirrors `loadPullFilesRange`, which keeps those steps
 * private — the ~30-line duplication is deliberate: compare-feeds.tsx is
 * committed and read-only for this wave, so no shared helper could be
 * extracted without touching it.
 *
 * This module holds the grammar, the resolver and the loader only; the route
 * lives in src/ui/index.ts beside its sibling dispatchers (the
 * resolveUiRequest session/repo prologue is index-owned). UNMOUNTED module —
 * the HANDOFF NOTE in the smoke test carries the mount recipe.
 */

import type { Context as ContextType } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";

import { branchRef, engineReads, pullHeadRef, type EngineReads } from "../../api/services/engine";
import { findIssueByRepoAndIndex } from "../../api/services/issues";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { findRepositoryById } from "../../api/services/repository";
import { users } from "../../db/schema";
import {
  renderPullFilesRangePage,
  type PullFilesRangeData,
} from "./compare-feeds";
import { diffFileViews, type DiffFileView } from "./pull-files";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// The grammar (web.go:1663's `{sha:[a-f0-9]{7,64}}`)
// ---------------------------------------------------------------------------

/** The route's sha shape: LOWERCASE hex only, 7..64, anchored — the same
 *  class the range pattern's sides use (web.go:1663 vs web.go:1672). */
export const PULL_FILES_SINGLE_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * Parse the single-sha segment (post-decode — the window's discriminator
 * decodes first like the compare arm; the hex class admits no `%`, so an
 * encoded segment is upstream's pattern miss, the same 404). Disjoint from
 * compare-feeds' `parsePullFilesRange` by construction (no dot can match
 * this class; a `..` pair can never match it) — the dispatcher's order is
 * free. `null` = not this family (the bare tail or a foreign segment).
 */
export function parsePullFilesSingleCommit(segment: string): string | null {
  const match = PULL_FILES_SINGLE_COMMIT_PATTERN.exec(segment);
  return match === null ? null : match[0];
}

// ---------------------------------------------------------------------------
// The admission (pull.go:670-677, 707-724 — indexCommit + the head escape)
// ---------------------------------------------------------------------------

/** The PR compare info's endpoints the admission runs against: `head` = the
 *  refs/pull/N/head tip (upstream HeadCommitID), `base` = the merge base
 *  (upstream CompareBase) — `null` when the histories are unrelated (the
 *  list is then EMPTY; the range arm 404s this shape, this arm does not). */
export interface PullSingleCommitRefs {
  base: string | null;
  head: string;
}

/** Upstream's commit-list membership as ancestry predicates (the range arm's
 *  vocabulary): the list is `git log base..head` — commits reachable from
 *  head and NOT from base (half-open "(base, head]", pull.go:707-709) — and
 *  `mergeBase(x, y) === x` iff x is an ancestor-or-self of y. */
async function ancestorOrSelf(reads: EngineReads, x: string, y: string): Promise<boolean> {
  const merged = await reads.mergeBase(x, y);
  return merged !== null && merged.tag === "ok" && merged.base === x;
}

/**
 * The single-commit admission (pull.go:718-724): the sha admits when it is
 * an EXACT member of the half-open `(base, head]` list, or when it equals
 * the head oid itself (the direct GetCommit escape — the empty-list arm).
 * `null` = upstream ctx.NotFound: a short prefix (never equals a full oid),
 * the merge base or any base ancestor (the handler's ambiguity refusal,
 * pull.go:954-955), or a commit outside the PR's range. The resolved after
 * is the commit's full oid; `before` is its FIRST PARENT (pull.go:732-738),
 * `null` for the root commit (the DiffNotAvailable divergence — module
 * header).
 */
export async function resolvePullFilesSingleCommit(
  reads: EngineReads,
  refs: PullSingleCommitRefs,
  sha: string,
): Promise<{ after: string; before: string | null } | null> {
  if (sha !== refs.head) {
    // The list admission (indexCommit's exact full-oid membership — a short
    // prefix never equals a full oid, so the ancestry resolution of the
    // predicates cannot rescue it; the committed range arm's test pins the
    // same rejection).
    if (refs.base === null) return null; // empty list: only the head escape admits
    if (!(await ancestorOrSelf(reads, sha, refs.head))) return null;
    if (await ancestorOrSelf(reads, sha, refs.base)) return null; // (base, head] excludes the base side
  }
  const commit = await reads.readCommit(sha);
  if (commit === null) return null; // the escape's GetCommit failure (upstream ServerError; the landed convention folds engine-read failures into the 404 family)
  return { after: commit.oid, before: commit.parents[0] ?? null };
}

// ---------------------------------------------------------------------------
// The loader (viewPullFiles' single-commit arm over the landed row loaders)
// ---------------------------------------------------------------------------

/**
 * Load the PR files SINGLE-COMMIT view: the PR rows (the pull-files page's
 * exact loaders), the compare endpoints (base branch tip — or the STORED
 * merge base when the branch is gone, pull.go:560-568 — vs refs/pull/N/head),
 * the admission, then the direct first-parent diff. `null` = the 404 family:
 * a grammar miss, a missing/non-pull row (the family's no-redirect
 * divergence), a broken PR (unresolvable head — the `HeadCommitID == ""`
 * arm), a rejected sha, or a failed engine read.
 */
export async function loadPullFilesSingleCommit(
  c: ContextType<{ Bindings: Env }>,
  repoId: string,
  index: number,
  segment: string,
): Promise<PullFilesRangeData | null> {
  const sha = parsePullFilesSingleCommit(segment);
  if (sha === null) return null;
  const issue = await findIssueByRepoAndIndex(c.env.DB, repoId, index);
  if (issue === null || !issue.isPull) return null;
  const prRow = await findPullRequestByIndex(c.env.DB, repoId, index);
  if (prRow === null) return null;
  // The diff service's pair convention (the pull-files page's one cheap
  // re-read, never a second visibility decision).
  const pair = await findRepositoryById(c.env.DB, repoId);
  if (pair === null) return null;
  const pr = prRow.pullRequest;

  const reads = engineReads(c.env, pair.repo);
  const headCommit = await reads.readCommit(pullHeadRef(pr.index));
  if (headCommit === null) return null; // broken PR (pull.go:697-700's arm)
  let baseOid: string | null = null;
  const baseTip = await reads.readCommit(branchRef(pr.baseBranch));
  if (baseTip !== null) {
    const merged = await reads.mergeBase(baseTip.oid, headCommit.oid);
    if (merged !== null && merged.tag === "ok" && merged.base !== null) baseOid = merged.base;
  } else if (pr.mergeBase !== null && pr.mergeBase !== "") {
    baseOid = pr.mergeBase; // the gone-base-branch arm (pull.go:560-568)
  }
  // No unrelated-histories 404 here (the range arm's divergence): the empty
  // list is fine — the head escape still admits the head itself.

  const resolved = await resolvePullFilesSingleCommit(reads, { base: baseOid, head: headCommit.oid }, sha);
  if (resolved === null) return null;

  // The root-commit arm: no first parent → the DiffNotAvailable render
  // (upstream ServerErrors here — the module header's documented divergence).
  // Otherwise the diff is the direct two-commit pair: exactly one commit's
  // own changes (getDiffBasic's two-arg form).
  const diff = resolved.before === null ? null : await reads.readDiff(resolved.after, resolved.before);
  const files: DiffFileView[] = await diffFileViews(diff?.files ?? []);

  // The title bar's two names (the detail page's batched-name pattern —
  // mirrored from loadPullFilesRange, which keeps this step private).
  const personIds = new Set<number>();
  if (issue.posterId !== null) personIds.add(issue.posterId);
  if (pr.hasMerged && pr.mergerId != null) personIds.add(pr.mergerId);
  const names = new Map<number, string>();
  if (personIds.size > 0) {
    const rows = await drizzle(c.env.DB)
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
    before: resolved.before ?? "", // "" = the root arm (no parent — never rendered as an endpoint)
    after: resolved.after,
    files,
    totalAddition: files.reduce((sum, view) => sum + view.file.add, 0),
    totalDeletion: files.reduce((sum, view) => sum + view.file.del, 0),
  };
}

// ---------------------------------------------------------------------------
// The page render (tplPullFiles scoped to one commit — REUSED, no duplication)
// ---------------------------------------------------------------------------

/** The full-document render — the compare-feeds family's range render REUSED
 *  verbatim (the same tplPullFiles DOM contract, pull.go:950; the data shape
 *  matches one-to-one, only the endpoints' meaning differs). One import
 *  site, zero duplicated JSX. */
export function renderPullFilesSingleCommitPage(options: { ctx: UiContext; data: PullFilesRangeData }): string {
  return renderPullFilesRangePage(options);
}
