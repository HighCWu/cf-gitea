/**
 * The diffpatch file downloads — the parity survey's row 4: the four
 * raw-text routes the Gitea web mux serves (no /api/v1 op exists for them):
 *
 *   GET /{owner}/{repo}/commit/{sha}.{diff|patch}   web.go:1760, repo.RawDiff
 *                                                   (routers/web/repo/commit.go:430-460)
 *   GET /{owner}/{repo}/pulls/{index}.{diff|patch}  web.go:1657-1658,
 *                                                   repo.DownloadPullDiff/Patch
 *                                                   (routers/web/repo/pull.go:1469-1501)
 *
 * ## Upstream shape (the ported contract)
 *
 * Both arms dump RAW diff/patch TEXT straight into the response body:
 *
 *   - commit `.diff`: git.GetRawDiff's RawDiffNormal arm (modules/git/
 *     diff.go:41-49) — `git diff --find-renames <parent> <commit>`, or
 *     `git show <commit>` for a root commit; here engineReads.readDiff(oid)
 *     (id2 defaults to the first parent, null-parent = empty-tree diff) over
 *     renderUnifiedDiff.
 *   - commit `.patch`: GetRawDiff's RawDiffPatch arm (diff.go:50-63) —
 *     `git format-patch --no-signature --stdout`: the git-am MAIL header
 *     (From <oid> / From: / Date: / Subject: [PATCH]) around the unified
 *     diff, WITHOUT the trailing `-- \n<version>` signature; here
 *     renderPatch(commit, files, { signature: null }).
 *   - pull `.diff`: DownloadDiffOrPatch's GetDiff (services/pull/patch.go:
 *     26-45 → modules/git/repo_compare.go:57-62) — `git diff -p
 *     <mergeBase>...refs/pull/N/head`; here pullRequestDiff's three-dot
 *     range (the landed API `.diff` route's own composition,
 *     api/routes/pulls.ts handlePullDiff) over renderUnifiedDiff.
 *   - pull `.patch`: GetPatch (repo_compare.go:74-77) — `git format-patch
 *     --binary --stdout` over the same range: the mail header WITH the
 *     signature tail; here renderPatch(headCommit, files) — the landed API
 *     `.patch` arm verbatim (a RANGE renders as the head commit's single
 *     mail block, the landed API family's approximation of upstream's
 *     per-commit mail series; git-am applies the aggregated diff the same).
 *
 * Content-type: upstream sets none — Go's net/http sniffs the text and
 * answers `text/plain; charset=utf-8`; emitted explicitly here. Cache
 * headers: upstream's web context middleware stamps EVERY web response with
 * `max-age=0, private, must-revalidate` (services/context/context.go:189 →
 * modules/httpcache SetCacheControlInHeader's zero-option prod form); the
 * download responses carry it (the landed UI pages generally omit that
 * global middleware — a pre-existing survey scope, not this row's).
 *
 * ## Semantics
 *
 * - sha resolution: the upstream route pattern admits `([a-f0-9]{7,64})`
 *   (web.go:1760) and RevParse resolves prefixes; the shape gate here
 *   matches the landed commit view's COMMIT_SHA convention (7..64 hex,
 *   case-folded), but the ENGINE answers only full reachable oids — short
 *   prefixes 404 (pages/commit-view.tsx's documented divergence, inherited).
 * - the commit route's MustBeNotEmpty gate: an empty repo 404s before the
 *   engine read (the tags page's arm).
 * - the PR rows: GetPullRequestByIndex reads every state (open, closed,
 *   merged); a non-pull issue row or a missing row 404s (the pull-files
 *   page's arms). The lazy mergeability check is NOT run (the page's
 *   posture — pullRequestDiff computes the merge base directly; the GET
 *   stays read-only over D1).
 * - a pull base/head ref the engine cannot resolve: the page degrades to
 *   upstream's DiffNotAvailable render, but a DOWNLOAD has no such template
 *   — the landed API sibling's mapping (the service's ApiError → 404)
 *   carries over: the 404 shell.
 * - upstream's `?binary=1` diff variant (GetDiffBinary) is not honored —
 *   the landed API seam ignores it too.
 * - error shapes: a missing commit/PR answers the §4.5 404 shell (upstream
 *   ctx.NotFound renders its own 404 page — the landed family convention).
 *
 * This module holds the loaders + the raw Response builder only; the
 * handlers live in src/ui/index.ts beside their sibling dispatchers (the
 * resolveUiRequest session/repo prologue is index-owned).
 */

import { Context, type Context as ContextType } from "hono";

import { ApiError } from "../../api/errors";
import type { ApiEnv } from "../../api/env";
import { engineReads } from "../../api/services/engine";
import { findIssueByRepoAndIndex } from "../../api/services/issues";
import { renderPatch, renderUnifiedDiff } from "../../api/services/git-models";
import { pullRequestDiff } from "../../api/services/pull-engine";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { findRepositoryById } from "../../api/services/repository";

/** The raw output format the URL's `.ext` suffix picks. */
export type DiffPatchExt = "diff" | "patch";

/** The commit-download's sha shape gate — the landed commit view's
 *  COMMIT_SHA verbatim (upstream web.go:1760's `([a-f0-9]{7,64})`, the
 *  ref-suffix rule's case folding; existence is the engine read's answer). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * The commit download's body: the plain unified diff (`.diff`) or the
 * git-am mail shape without the signature tail (`.patch`). `null` = the 404
 * family: a non-hex/wrong-shape segment, an empty repo, or a commit the
 * engine cannot resolve (short prefixes — the full-oid divergence).
 */
export async function loadCommitDiffPatch(
  env: Env,
  repo: { ownerNamespace: string; slug: string },
  sha: string,
  ext: DiffPatchExt,
): Promise<string | null> {
  if (!COMMIT_SHA.test(sha)) return null;
  const reads = engineReads(env, repo);
  const commit = await reads.readCommit(sha);
  if (commit === null) return null;
  const diff = await reads.readDiff(commit.oid);
  const files = diff?.files ?? [];
  return ext === "patch" ? renderPatch(commit, files, { signature: null }) : renderUnifiedDiff(files);
}

/**
 * The pull download's body over the PR's three-dot range. `null` = the 404
 * family: a missing/non-pull row, an unresolvable base/head range (the
 * service's ApiError — the landed API sibling's mapping), or a head commit
 * the engine cannot read back for the mail header.
 */
export async function loadPullDiffPatch(
  c: ContextType<{ Bindings: Env }>,
  repoId: string,
  index: number,
  ext: DiffPatchExt,
): Promise<string | null> {
  const issue = await findIssueByRepoAndIndex(c.env.DB, repoId, index);
  if (issue === null || !issue.isPull) return null;
  const prRow = await findPullRequestByIndex(c.env.DB, repoId, index);
  if (prRow === null) return null;
  // The diff service takes the API's RepositoryWithOwner pair (owner
  // joined) — findRepositoryById re-reads the resolved row by id, the
  // pull-files page's one cheap re-read, never a second visibility decision.
  const pair = await findRepositoryById(c.env.DB, repoId);
  if (pair === null) return null;
  try {
    // pullRequestDiff is typed against the API's Context (its Variables the
    // service never reads) — the request/env pair re-wrapped, no casts (the
    // pull-files page's construction).
    const apiContext = new Context<ApiEnv>(c.req.raw, { env: c.env });
    const range = await pullRequestDiff(apiContext, pair, prRow.pullRequest);
    if (ext === "diff") return renderUnifiedDiff(range.files);
    const headCommit = await engineReads(c.env, pair.repo).readCommit(range.head);
    if (headCommit === null) return null;
    return renderPatch(headCommit, range.files);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // The service's 404 (unresolvable base/head) → the 404 shell.
    return null;
  }
}

/**
 * The raw-text download Response — upstream's sniffed content type plus the
 * web context middleware's zero-option prod Cache-Control (the module doc's
 * header section). Not a page: the caller routes it through the session's
 * `respond` wrapper like any other plain Response (the tree-redirect
 * precedent).
 */
export function diffPatchTextResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
