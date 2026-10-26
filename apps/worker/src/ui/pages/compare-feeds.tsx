/**
 * The compare-family byte feeds — the parity survey's tick-10 bench row 2,
 * one unit, three surfaces:
 *
 *   (a) GET /{owner}/{repo}/compare/{basehead}.diff   web.go:1309,
 *       repo.DownloadCompareDiff (routers/web/repo/compare.go:570-603)
 *   (b) GET /{owner}/{repo}/compare/{basehead}.patch  web.go:1310,
 *       repo.DownloadComparePatch (same helper, `patch` arm)
 *   (c) GET /{owner}/{repo}/pulls/{index}/files/{a}..{b}  web.go:1672,
 *       repo.ViewPullFilesForRange (routers/web/repo/pull.go:959-960,680-950)
 *
 * ## Upstream shape (the ported contract)
 *
 * (a)/(b) — `downloadCompareDiffOrPatch` (compare.go:582-603) parses the
 * `basehead` path param (the router strips the literal `.diff`/`.patch`
 * suffix — web.go:1309-1310's `MatchPath("/<basehead:*>.ext")`; the mux
 * unescapes params, so the strip applies to the DECODED tail), sets
 * `Content-Type: text/plain; charset=utf-8` EXPLICITLY (compare.go:593 —
 * no sniffing, no application/x-diff anywhere in this family), then dumps
 * the git output verbatim:
 *
 *   - `.diff`: GetDiff (modules/git/repo_compare.go:57-62) — `git diff -p
 *     <BaseCommitID><sep><HeadCommitID>` over the RESOLVED full oids with
 *     the URL's ORIGINAL separator (compare.go:594): `...` diffs from the
 *     merge base (probe: `git diff -p A...B` with no merge base is FATAL —
 *     exit 128 → ServerError, upstream 500), `..` diffs the two tips
 *     directly (a reversed pair renders the REVERSED diff).
 *   - `.patch`: GetPatch (repo_compare.go:74-77) — `git format-patch
 *     --binary --stdout <same compareArg>`: a mail SERIES (one mail per
 *     range commit; probe: symmetric-difference commits for `...`, B-not-in-A
 *     for `..`, ZERO mails — an EMPTY body — when the set is empty). The
 *     landed family renders a RANGE as the head commit's single mail block
 *     (pages/diffpatch-files.ts header — the API `.patch` arm's approximation);
 *     the signature tail is ON (GetPatch passes no --no-signature), so this
 *     module emits renderPatch(headCommit, files) verbatim.
 *
 * Cache headers: the web context middleware stamps EVERY web response with
 * `max-age=0, private, must-revalidate` (services/context/context.go:189 →
 * httpcache's zero-option prod form) — the same pair the diffpatch sibling
 * emits; the builder is REUSED from pages/diffpatch-files.ts (one copy).
 *
 * URL grammar (routers/common/compare.go:74-124 ParseCompareRouterParam):
 * the decoded tail splits on the FIRST `...`, else the first `..`, else the
 * whole tail is the head ref (separator defaults `...`, base falls back to
 * the repo's default branch — util.IfZero over GetPullRequestTargetBranch/
 * DefaultBranch, compare.go:200-201). Each side then goes through
 * ParseRefSuffix (`^`/`~N` ancestry suffixes) + ResolveRefWithSuffix. NOT
 * claimed (→ the 404 family, the landed compare page's own reductions —
 * pages/compare.tsx header): the `{owner}[:{repo}]:{ref}` fork forms (a
 * colon-bearing head; forks cannot exist yet, SPEC-0003) and the ref-suffix
 * family (the engine reads resolve exact names/oids only — a `feature^`
 * side 404s here exactly as it does on the compare page).
 *
 * (c) — the route admits `{shaFrom:[a-f0-9]{7,64}}..{shaTo:[a-f0-9]{7,64}}`
 * (web.go:1672 — LOWERCASE hex only, 7..64 per side, the `..` separator
 * mandatory; the mux unescapes first, but the hex class admits no `%`, so an
 * encoded segment is a pattern miss → 404). `viewPullFiles` (pull.go:680)
 * resolves the PR's compare info — base branch tip (or the STORED merge base
 * when the branch is gone, pull.go:562-567) vs `refs/pull/N/head` — and
 * admits the endpoints against the PR's commit list (`git log base..head`,
 * half-open: "(base, head]", pull.go:707-709) by EXACT full-oid match
 * (indexCommit, pull.go:670-677): the after side admits the list plus the
 * head oid itself (pull.go:712-715), the before side the list plus the merge
 * base (pull.go:722-731) — so a SHORT prefix 404s (never equals a full oid),
 * `after == mergeBase` 404s (not in the half-open list, not the head), a
 * reversed pair renders (both endpoints in the list; the diff simply runs
 * `git diff <before> <after>` — getDiffBasic's two-arg direct form,
 * services/gitdiff/gitdiff.go:1326-1337), and a same-ref pair renders the
 * empty diff (upstream's DiffNotAvailable render). A broken PR (head ref
 * unresolved → `HeadCommitID == ""`) 404s (pull.go:697-700); unrelated
 * histories (empty CompareBase) can never admit a before side → 404.
 *
 * ## Arms (per surface)
 *
 * - (a)/(b): `repo.MustBeNotEmpty` (web.go:1309-1310) — an EMPTY repo 404s;
 *   an unresolvable side 404s (parseCompareInfo's ErrNotExist); the
 *   no-merge-base `...` download 500s for `.diff` (the git fatal above) and
 *   is REFUSED with the same 500 for `.patch` — upstream actually succeeds
 *   there (the symmetric-difference mail series, probed); refusing beats
 *   inventing a series the single-block render cannot express (documented
 *   divergence).
 * - (c): a missing/non-pull row 404s (getPullInfo, pull.go:115-150 — the
 *   landed family's documented no-redirect divergence); the range page
 *   itself is tplPullFiles (pull-files.tsx's DOM contract) scoped to the
 *   range — rendered through the SAME landed DiffFileBox vocabulary.
 *
 * This module holds the grammars, the loaders and the range-page render
 * only; the routes live in src/ui/index.ts beside their sibling dispatchers
 * (the resolveUiRequest session/repo prologue is index-owned). Bench pair
 * with pages/diffpatch-files.ts (wave 29) — UNMOUNTED module, the HANDOFF
 * NOTE in the tests carries the mount recipe per surface.
 */

import type { Context as ContextType } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";

import { diffPatchTextResponse } from "./diffpatch-files";
import { branchRef, engineReads, pullHeadRef, type EngineReads } from "../../api/services/engine";
import { findIssueByRepoAndIndex } from "../../api/services/issues";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { findRepositoryById } from "../../api/services/repository";
import { renderPatch, renderUnifiedDiff } from "../../api/services/git-models";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import { users } from "../../db/schema";
import { resolveHeadBranch } from "./home";
import { compareRefKindOf } from "./compare";
import {
  diffFileViews,
  pullFilesLocale,
  DiffFileBox,
  type DiffFileView,
} from "./pull-files";
import { IssueTitleBar, PullTabs, type IssueTitleData } from "./issue-detail";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Surfaces (a)/(b): the compare download grammar + loader
// ---------------------------------------------------------------------------

/** The raw output format the URL's `.ext` suffix picks (the diffpatch
 *  sibling's union). */
export type CompareFeedExt = "diff" | "patch";

/**
 * Strip the download suffix off the decoded compare tail (web.go:1309-1310's
 * MatchPath patterns — the mux strips ONE literal lowercase suffix from the
 * END; `.patch` after `.diff` keeps stripping one, so `x.patch.diff` is the
 * `.diff` of ref `x.patch`, `x.diff.patch` the `.patch` of `x.diff` — exactly
 * upstream's mutually-exclusive regex match). `null` = not this family (the
 * bare compare page / catch-all claims the tail).
 */
export function parseCompareFeedTail(tail: string): { basehead: string; ext: CompareFeedExt } | null {
  if (tail.endsWith(".diff")) return { basehead: tail.slice(0, -".diff".length), ext: "diff" };
  if (tail.endsWith(".patch")) return { basehead: tail.slice(0, -".patch".length), ext: "patch" };
  return null;
}

/** The parsed basehead (ParseCompareRouterParam reduced to the same-repo
 *  forms): `null` sides fall back to the default branch (util.IfZero,
 *  compare.go:200-201); `separator` is the URL's ORIGINAL (compare.go:594 —
 *  it picks the diff semantic downstream). */
export interface CompareFeedBaseHead {
  base: string | null;
  head: string | null;
  separator: "..." | "..";
}

/**
 * ParseCompareRouterParam (routers/common/compare.go:74-124) reduced:
 * the FIRST `...` splits, else the first `..`, else the whole tail is the
 * head (separator `...`). A colon-bearing side (the cross-repo fork forms)
 * or a `..` left inside a part is `null` — the unclaimed forms 404 (the
 * landed compare family's own reductions; refnames can never carry `:`,
 * and upstream's fork resolution cannot succeed without forks).
 */
export function parseCompareBaseHead(basehead: string): CompareFeedBaseHead | null {
  let separator: "..." | "..";
  let basePart: string;
  let headPart: string;
  const tri = basehead.indexOf("...");
  if (tri >= 0) {
    separator = "...";
    basePart = basehead.slice(0, tri);
    headPart = basehead.slice(tri + 3);
  } else {
    const bi = basehead.indexOf("..");
    if (bi >= 0) {
      separator = "..";
      basePart = basehead.slice(0, bi);
      headPart = basehead.slice(bi + 2);
    } else {
      separator = "...";
      basePart = "";
      headPart = basehead;
    }
  }
  if (basePart.includes("..") || basePart.includes(":") || headPart.includes("..") || headPart.includes(":")) {
    return null;
  }
  return {
    base: basePart === "" ? null : basePart,
    head: headPart === "" ? null : headPart,
    separator,
  };
}

/** The loader's repo subset (the caller's resolved row — the branches
 *  aux's shape). */
export type CompareFeedRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** One compare download's outcome: the body bytes, the 404 family (empty
 *  repo, unclaimed form, unresolvable side, unreadable head commit) or the
 *  no-merge-base refusal (the `.diff` arm's upstream ServerError — and the
 *  `.patch` arm's documented refusal, the module header). */
export type CompareFeedResult =
  | { kind: "body"; body: string }
  | { kind: "notFound" }
  | { kind: "noMergeBase" };

/**
 * Load one compare download body. Resolution per side rides the compare
 * page's exact vocabulary (compareRefKindOf: branch → tag → 7..64-hex oid,
 * then readCommit reachability). The `.diff` body is the separator-aware
 * unified diff (`.patch`: the head-anchored git-am mail block over the same
 * files, signature ON — GetPatch passes no --no-signature), with the
 * EMPTY-RANGE arms emitting the empty body: upstream's format-patch answers
 * ZERO mails (an empty body, probed) when the range set is empty — `...`
 * with identical tips, or `..` with the head already inside the base.
 */
export async function loadCompareFeed(
  env: Env,
  repo: CompareFeedRepo,
  tail: string,
  ext: CompareFeedExt,
): Promise<CompareFeedResult> {
  if (repo.isEmpty) return { kind: "notFound" }; // MustBeNotEmpty (web.go:1309-1310)
  const stripped = parseCompareFeedTail(tail);
  if (stripped === null || stripped.ext !== ext) return { kind: "notFound" }; // dispatcher drift guard
  const basehead = parseCompareBaseHead(stripped.basehead);
  if (basehead === null) return { kind: "notFound" }; // the fork-form / dotted-part 404
  const reads = engineReads(env, repo);
  const refs = resolveHeadBranch(await reads.listRefs(), repo.defaultBranch);
  if (refs.headBranch === null) return { kind: "notFound" }; // unborn (belt over the isEmpty gate)

  const baseName = basehead.base ?? repo.defaultBranch;
  const headName = basehead.head ?? repo.defaultBranch;
  if (compareRefKindOf(baseName, refs) === null || compareRefKindOf(headName, refs) === null) {
    return { kind: "notFound" }; // unresolvable side (ResolveRefWithSuffix's not-found arm)
  }
  const baseCommit = await reads.readCommit(baseName);
  const headCommit = await reads.readCommit(headName);
  if (baseCommit === null || headCommit === null) return { kind: "notFound" };
  const baseOid = baseCommit.oid;
  const headOid = headCommit.oid;

  // The compareArg's old side: merge base for `...` (compare.go:594's
  // three-dot form — a missing one is the git-fatal 500 upstream), the base
  // tip itself for `..` (the direct two-commit diff).
  let oldSide: string;
  if (basehead.separator === "...") {
    const merged = await reads.mergeBase(baseOid, headOid);
    if (merged === null || merged.tag !== "ok" || merged.base === null) return { kind: "noMergeBase" };
    oldSide = merged.base;
  } else {
    oldSide = baseOid;
  }

  const diff = await reads.readDiff(headOid, oldSide);
  const files = diff?.files ?? [];
  if (ext === "diff") return { kind: "body", body: renderUnifiedDiff(files) };

  // .patch empty arms (format-patch's zero-mail body): `...` with identical
  // tips, or `..` with the head an ancestor-or-self of the base.
  if (basehead.separator === "...") {
    if (baseOid === headOid) return { kind: "body", body: "" };
  } else {
    const behind = await reads.mergeBase(headOid, baseOid);
    if (behind !== null && behind.tag === "ok" && behind.base === headOid) return { kind: "body", body: "" };
  }
  const mailCommit = await reads.readCommit(headOid);
  if (mailCommit === null) return { kind: "notFound" };
  return { kind: "body", body: renderPatch(mailCommit, files) };
}

/**
 * The no-merge-base download's 500 — upstream ctx.ServerError's class
 * (compare.go:601-602 via the `git diff -p A...B` fatal) reduced to plain
 * text (the byte feed has no 500 page in the landed family; the mount
 * recipe answers this through `respond` like the other arms).
 */
export function compareFeedServerErrorResponse(): Response {
  return new Response("server error\n", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** The download's 200 Response — the diffpatch sibling's exact builder
 *  (text/plain; charset=utf-8 + the web middleware's zero-option prod
 *  Cache-Control), re-exported under the compare-feed name so the window's
 *  dispatcher has one import site for the family. */
export function compareFeedTextResponse(body: string): Response {
  return diffPatchTextResponse(body);
}

// ---------------------------------------------------------------------------
// Surface (c): the pull-files range grammar + resolver + loader
// ---------------------------------------------------------------------------

/** The route's sha shape (web.go:1672 — `{shaFrom:[a-f0-9]{7,64}}..
 *  {shaTo:[a-f0-9]{7,64}}`): LOWERCASE hex only, 7..64 per side, `..`
 *  mandatory, anchored (a segment can carry one range only). */
export const PULL_FILES_RANGE_PATTERN = /^([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})$/;

/** Parse the `/{a}..{b}` segment (post-decode — the window's discriminator
 *  decodes first like the compare arm; the hex class admits no `%`, so an
 *  encoded segment is upstream's pattern miss, the same 404). */
export function parsePullFilesRange(segment: string): { from: string; to: string } | null {
  const match = PULL_FILES_RANGE_PATTERN.exec(segment);
  if (match === null) return null;
  return { from: match[1] as string, to: match[2] as string };
}

/** The PR compare info's endpoints the admission runs against (full oids:
 *  `base` = the merge base (upstream CompareBase), `head` = the
 *  refs/pull/N/head tip (upstream HeadCommitID)). */
export interface PullRangeRefs {
  base: string;
  head: string;
}

/** Upstream's commit-list membership as ancestry predicates: the PR's
 *  commit list is `git log base..head` — commits reachable from head and
 *  NOT from base (half-open "(base, head]", pull.go:707-709) — and
 *  `mergeBase(x, y) === x` iff x is an ancestor-or-self of y. */
async function ancestorOrSelf(reads: EngineReads, x: string, y: string): Promise<boolean> {
  const merged = await reads.mergeBase(x, y);
  return merged !== null && merged.tag === "ok" && merged.base === x;
}

/**
 * viewPullFiles' admission arms (pull.go:707-731) over full oids: the after
 * side admits the commit list plus the head oid itself; the before side the
 * list plus the merge base (the `beforeCommitID == prCompareInfo.CompareBase`
 * arm). `null` = upstream ctx.NotFound: a short prefix (never equals a full
 * oid), an endpoint outside the PR's range, or the after side pointing at
 * the merge base (excluded from the half-open list, not the head).
 */
export async function resolvePullFilesRange(
  reads: EngineReads,
  refs: PullRangeRefs,
  from: string,
  to: string,
): Promise<{ before: string; after: string } | null> {
  const inCommitList = async (oid: string): Promise<boolean> =>
    (await ancestorOrSelf(reads, oid, refs.head)) && !(await ancestorOrSelf(reads, oid, refs.base));
  const afterOk = to === refs.head || (await inCommitList(to));
  if (!afterOk) return null;
  const beforeOk = from === refs.base || (await inCommitList(from));
  if (!beforeOk) return null;
  return { before: from, after: to };
}

/** The range page's render inputs, loaded by loadPullFilesRange. */
export interface PullFilesRangeData {
  issue: IssueRow;
  pr: PullRequestRow;
  /** Display-cased names for the title bar (null = no user row). */
  posterName: string | null;
  mergerName: string | null;
  /** The resolved endpoints (before = shaFrom, after = shaTo) — the diff
   *  runs direct between them (getDiffBasic's two-arg form), so a reversed
   *  pair renders the reversed diff. */
  before: string;
  after: string;
  files: DiffFileView[];
  totalAddition: number;
  totalDeletion: number;
}

/**
 * Load the PR files RANGE view: the PR rows (the pull-files page's exact
 * loaders), the compare endpoints (base branch tip — or the STORED merge
 * base when the branch is gone, pull.go:562-567 — vs refs/pull/N/head),
 * the admission, then the direct two-commit diff. `null` = the 404 family:
 * a grammar miss, a missing/non-pull row (the family's no-redirect
 * divergence), a broken PR (unresolvable head — the `HeadCommitID == ""`
 * arm), unrelated histories (empty CompareBase can never admit a before
 * side), a rejected endpoint, or a failed engine read.
 */
export async function loadPullFilesRange(
  c: ContextType<{ Bindings: Env }>,
  repoId: string,
  index: number,
  segment: string,
): Promise<PullFilesRangeData | null> {
  const parsed = parsePullFilesRange(segment);
  if (parsed === null) return null;
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
    baseOid = pr.mergeBase; // the gone-base-branch arm (pull.go:562-567)
  }
  if (baseOid === null) return null; // unrelated histories: before never admits

  const range = await resolvePullFilesRange(reads, { base: baseOid, head: headCommit.oid }, parsed.from, parsed.to);
  if (range === null) return null;

  const diff = await reads.readDiff(range.after, range.before);
  const files: DiffFileView[] = await diffFileViews(diff?.files ?? []);

  // The title bar's two names (the detail page's batched-name pattern).
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
    before: range.before,
    after: range.after,
    files,
    totalAddition: files.reduce((sum, view) => sum + view.file.add, 0),
    totalDeletion: files.reduce((sum, view) => sum + view.file.del, 0),
  };
}

// ---------------------------------------------------------------------------
// The range page render (tplPullFiles scoped to the range — the pull-files
// page's DOM contract, the same landed box vocabulary)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderPullFilesRangePage(options: { ctx: UiContext; data: PullFilesRangeData }): string {
  return renderPage(<PullFilesRangePage ctx={options.ctx} data={options.data} />);
}

/** The PR files RANGE page (§2.4.1 discriminator: `repository view issue
 *  pull files diff` — the same tplPullFiles the full files view serves). */
export function PullFilesRangePage(props: { ctx: UiContext; data: PullFilesRangeData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("PullFilesRangePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const titleData: IssueTitleData = {
    issue: data.issue,
    pr: data.pr,
    posterName: data.posterName,
    mergerName: data.mergerName,
  };
  const empty = data.files.length === 0;
  return (
    <BaseLayout
      ctx={ctx}
      title={`#${data.issue.index} - ${data.issue.title}`}
      pageClass="repository view issue pull files diff"
      activeTab="pulls"
    >
      <div class="ui container fluid padded">
        <IssueTitleBar data={titleData} />
        <PullTabs repoLink={repoLink} issue={data.issue} active="files" commitsCount={null} filesCount={data.files.length} />
        <div class="diff-detail-box">
          <div class="flex-text-block tw-flex-wrap tw-ml-0.5">
            {!empty ? (
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
                {empty ? (
                  <h4>{pullFilesLocale.data_not_available}</h4>
                ) : (
                  data.files.map((view) => <DiffFileBox view={view} />)
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
