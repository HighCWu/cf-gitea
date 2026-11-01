/**
 * The wiki commit-diff surfaces — the two commit tails under the
 * `/{username}/{reponame}/wiki` group (web.go:1619-1620), served over the
 * SIBLING `owner/slug.wiki` engine cell. Upstream routes both through the
 * group's `PageIsWiki` data (web.go:1622-1626's closing func), which flips
 * the read onto the wiki storage repo:
 *
 *   GET …/wiki/commit/{sha}                 web.go:1619 — repo.Diff's wiki
 *         arm (routers/web/repo/commit.go:277-430 rendering tplCommitPage):
 *         the commit-page diff surface with `commitLinkBase` onto
 *         `{RepoLink}/wiki/commit` (commit_page.tmpl:2's PageIsWiki Iif) and
 *         the whole `commit-header-buttons` block gated off
 *         (commit_page.tmpl:12 `{{if not $.PageIsWiki}}`).
 *   GET …/wiki/commit/{sha}.{patch|diff}    web.go:1620 — repo.RawDiff's
 *         wiki arm (commit.go:432-441): RawDiff opens the WIKI storage repo
 *         when PageIsWiki (commit.go:433-440) and dumps `git.GetRawDiff`'s
 *         RawDiffNormal / RawDiffPatch bytes (modules/git/diff.go:41-99) —
 *         the same raw-text contract as the landed commit downloads
 *         (pages/diffpatch-files.ts's module doc).
 *
 * ## Dispatch posture (why this module's parse is the route gate)

 * parseUiRoute's wiki family arm is a catch-all — EVERY `wiki/*` tail
 * claims as `family: "wiki"` with the decoded rawTail and rides the page
 * handler, so the two commit tails arrive at `loadWikiViewData`
 * (pages/repo-wiki.tsx) as rawTails. There is no dedicated route to port:
 * this module's tail grammars ARE web.go:1619-1620's URL patterns
 * (lowercase `[a-f0-9]{7,64}` verbatim), and the page-name fallthrough for
 * a non-matching tail is upstream's chi specificity rule — the pattern miss
 * drops into `m.Combo("/*")` and wiki.Wiki treats the whole tail as a page
 * name. THE VIEW mounts through loadWikiViewData's commit arm today; the
 * DOWNLOADS ship here as loader + grammar only — a raw-text Response cannot
 * pass the page handler (every arm `c.html`-wraps the render), so the
 * serving arm is index.ts work pending at report time: one branch that
 * maps `parseWikiCommitDownloadTail` + `loadWikiCommitDiffPatch`'s null to
 * the §4.5 shell and everything else through `diffPatchTextResponse` (the
 * diffpatch family's exact convention). Until it lands, a dotted tail folds
 * to the page-name path — upstream-exact for every non-hex shape, an
 * interim 303 divergence for hex+suffix tails only.
 *
 * ## Semantics
 *
 * - sha resolution: the pattern admits 7..64 hex; the engine answers FULL
 *   reachable oids only — short prefixes parse but `readCommit` nulls (the
 *   commit view's documented full-oid divergence, inherited). A well-shaped
 *   unresolvable sha is upstream's Diff 404 (commit.go's IsErrNotExist →
 *   ctx.NotFound); the view arm interim-folds to the family's missing
 *   outcome (the fixed handler outcome set cannot answer a 404), the
 *   download loader nulls (the serving arm's shell).
 * - the diff/patch rendering rides the landed raw renderer family
 *   (api/services/git-models.ts: `readDiff` → `renderUnifiedDiffAsync` /
 *   `renderPatchAsync`, the verbatim-bytes contract with the no-newline
 *   markers and the trailing-newline-only hunk synthesis) — the SAME seams
 *   the commit downloads compose. `.patch` keeps the commit arm's
 *   `--no-signature` shape (`signature: null`).
 * - the blob read-back encode: the renderer fetches hunk context blobs by
 *   the diff envelope's paths — the wiki cell's STORED flat entry names
 *   (QueryEscaped by the codec: `Docs%2FDiff-Guide.md`). The engine decodes
 *   every path argument per segment, so the read-back needs the same
 *   encode services/wiki.ts's private `enginePath` applies ("%25" doubling)
 *   — mirrored here as `wikiEnginePath` (services/wiki.ts owns the
 *   original; collapsing the mirror means exporting it, reported).
 * - `.patch` over a MERGE commit: upstream's RawDiffPatch arm runs
 *   format-patch `<merge>...<parent0>` and format-patch skips merges — the
 *   non-merge side-commit series, EMPTY when the series is empty
 *   (diff.go:87-99). `wikiPatchSeries` mirrors diffpatch-files.ts's private
 *   `renderPatchSeries` over the wiki blob source (same cap, same
 *   between-mail seam bytes).
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { type EngineReads } from "../../api/services/engine";
import {
  renderPatchAsync,
  renderUnifiedDiffAsync,
  usernamesByEmail,
  type DiffBlobSource,
  type RenderPatchOptions,
} from "../../api/services/git-models";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { wikiReads } from "../../services/wiki";
import { commitViewLocale, type CommitViewData } from "./commit-view";
import { messageBodyOf } from "./compare";
import { userLink } from "../links";
import { shortSha } from "../page-data";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { DiffFileBox, DiffStats, diffFileViews, pullFilesLocale } from "./pull-files";
import { TimeSince } from "../components/file-list";

/** Upstream's route pattern `[a-f0-9]{7,64}` (web.go:1619-1620) — shape
 *  gate only, LOWERCASE-only like the pattern itself (an uppercase tail is
 *  a pattern miss → the page-name fold); existence is the engine read's
 *  answer. The landed COMMIT_SHA conventions fold case, but those sit
 *  behind router-level lowercase patterns — here the parse IS the gate. */
const WIKI_COMMIT_SHA = /^[0-9a-f]{7,64}$/;

/** The raw output format the URL's `.ext` suffix picks (the diffpatch
 *  family's DiffPatchExt twin). */
export type WikiCommitDownloadExt = "diff" | "patch";

/**
 * web.go:1619's pattern as a tail parse: `commit/{sha}` — the revision-diff
 * VIEW arm. `null` = a pattern miss → the whole tail stays a page name
 * (chi's specificity fold, module doc).
 */
export function parseWikiCommitViewTail(rawTail: string): { sha: string } | null {
  const match = /^commit\/([0-9a-f]{7,64})$/.exec(rawTail);
  if (match === null) return null;
  return { sha: match[1] as string };
}

/**
 * web.go:1620's pattern as a tail parse: `commit/{sha}.{diff|patch}` — the
 * raw-download arm. `null` = a pattern miss → page name. Consumed by the
 * serving arm (index.ts, pending — module doc).
 */
export function parseWikiCommitDownloadTail(rawTail: string): { sha: string; ext: WikiCommitDownloadExt } | null {
  const match = /^commit\/([0-9a-f]{7,64})\.(diff|patch)$/.exec(rawTail);
  if (match === null) return null;
  return { sha: match[1] as string, ext: match[2] as WikiCommitDownloadExt };
}

/**
 * services/wiki.ts's private `enginePath` encode, mirrored (module doc):
 * the codec-space stored name → the engine's wire path. Plain names carry
 * no "%" and pass through unchanged; coded names ("%2F") double the escape
 * so the engine's per-segment decode restores the stored bytes.
 */
function wikiEnginePath(gitPath: string): string {
  return gitPath
    .split("/")
    .map((segment) => segment.replaceAll("%", "%25"))
    .join("/");
}

/**
 * The DiffBlobSource over the wiki cell's reads — diffBlobSource's shape
 * with the read-back encode above (the renderer's context-blob fetches must
 * address the STORED flat entry names).
 */
function wikiDiffBlobSource(reads: EngineReads, oldTip: string | null, newTip: string): DiffBlobSource {
  return {
    oldTip,
    newTip,
    blobText: async (tip: string | null, path: string) => {
      if (tip === null) return null;
      const blob = await reads.readBlob(tip, wikiEnginePath(path));
      return blob === null ? null : new TextDecoder().decode(blob.data);
    },
  };
}

// ---------------------------------------------------------------------------
// The revision-diff VIEW (web.go:1619 — repo.Diff's wiki arm)
// ---------------------------------------------------------------------------

/**
 * Load the wiki cell's commit + its diff over the SIBLING cell — the
 * commit view loader's exact shape (pages/commit-view.tsx
 * loadCommitViewData) with `wikiReads` in place of `engineReads`. `null` =
 * the 404 family: a wrong-shape sha or one the engine cannot resolve
 * (unknown / short-prefix — the full-oid divergence).
 */
export async function loadWikiCommitDiffData(env: Env, db: D1Database, pair: RepositoryWithOwner, sha: string): Promise<CommitViewData | null> {
  if (!WIKI_COMMIT_SHA.test(sha)) return null;
  const reads = wikiReads(env, pair);
  const commit = await reads.readCommit(sha);
  if (commit === null) return null;
  const diff = await reads.readDiff(commit.oid);
  const files = await diffFileViews(diff?.files ?? []);
  // The identity→profile resolution (the API's ToPayloadCommit map, one
  // query for both identities — the commit view's posture).
  const usernames = await usernamesByEmail(db, [commit]);
  return {
    commit,
    authorUsername: usernames.get(commit.author.email.toLowerCase()) ?? null,
    committerUsername: usernames.get(commit.committer.email.toLowerCase()) ?? null,
    committerIsAuthor: commit.committer.name === commit.author.name && commit.committer.email === commit.author.email,
    files,
    totalAddition: files.reduce((sum, file) => sum + file.file.add, 0),
    totalDeletion: files.reduce((sum, file) => sum + file.file.del, 0),
  };
}

/** The full-document render (the render.tsx pattern). */
export function renderWikiCommitDiffPage(options: { ctx: UiContext; data: CommitViewData }): string {
  return renderPage(<WikiCommitDiffPage ctx={options.ctx} data={options.data} />);
}

/**
 * The wiki arm of the commit page (commit_page.tmpl at the PageIsWiki arms
 * — the CommitViewPage surface with TWO deltas): `commitLinkBase` onto
 * `{RepoLink}/wiki/commit` (commit_page.tmpl:2's Iif) for the parents' and
 * the commit's own sha labels, and the `commit-header-buttons` block absent
 * (commit_page.tmpl:12 `{{if not $.PageIsWiki}}` — no Browse Source, the
 * operations dropdown was never landed). The active tab is the WIKI tab
 * (the group's PageIsWiki data — the family's activeTab="wiki" posture).
 */
export function WikiCommitDiffPage(props: { ctx: UiContext; data: CommitViewData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("WikiCommitDiffPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // commit_page.tmpl:2 — `print $.RepoLink (Iif $.PageIsWiki "/wiki" "") "/commit"`.
  const commitLinkBase = `${repoLink}/wiki/commit`;
  const { commit } = data;
  const body = messageBodyOf(commit);
  const empty = data.files.length === 0;
  const time = <TimeSince unixSeconds={commit.committer.time} tz={commit.committer.tz} />;
  const author = data.authorUsername !== null ? <a href={userLink(data.authorUsername)}>{commit.author.name}</a> : <>{commit.author.name}</>;
  return (
    <BaseLayout ctx={ctx} title={`${commit.subject} · ${shortSha(commit.oid)}`} pageClass="repository diff" activeTab="wiki">
      <div class="ui container fluid padded">
        <div class="ui top attached header segment">
          <div class="flex-left-right tw-mb-4 tw-items-start">
            <h3 class="tw-m-0">
              <span class="commit-summary" title={commit.subject}>
                {commit.subject}
              </span>
            </h3>
            {/* commit_page.tmpl:12's PageIsWiki gate — the whole
                commit-header-buttons block stays off on the wiki arm. */}
          </div>
          {body !== "" ? <pre class="commit-body">{body}</pre> : null}
        </div>

        <div class="ui attached segment flex-text-block tw-flex-wrap">
          {/* commit_page.tmpl:129-150's identity sentence (the CommitViewPage
              IdentityLine shape): committed_at vs authored_committed_at. */}
          <span class="flex-text-inline tw-text-text-light">
            {data.committerIsAuthor ? (
              <>
                {author} {commitViewLocale.committed} {time}
              </>
            ) : (
              <>
                {author} {commitViewLocale.authored_and}{" "}
                <strong>
                  {data.committerUsername !== null ? (
                    <a href={userLink(data.committerUsername)}>{commit.committer.name}</a>
                  ) : (
                    <>{commit.committer.name}</>
                  )}
                </strong>{" "}
                {commitViewLocale.committed} {time}
              </>
            )}
          </span>
          <div class="tw-flex-1" />
          <div class="flex-text-block tw-flex-wrap">
            {commit.parents.length > 0 ? (
              <div class="flex-text-inline tw-flex-wrap">
                <span class="tw-text-text-light">
                  {commit.parents.length} {commit.parents.length === 1 ? commitViewLocale.parent : commitViewLocale.parents}
                </span>
                {commit.parents.map((parent) => (
                  <a class="ui label commit-id-short" href={`${commitLinkBase}/${encodeURIComponent(parent)}`}>
                    {shortSha(parent)}
                  </a>
                ))}
              </div>
            ) : null}
            <div class="flex-text-inline">
              <span class="flex-text-inline tw-text-text-light">{commitViewLocale.commit}</span>
              <a class="ui label commit-id-short" href={`${commitLinkBase}/${encodeURIComponent(commit.oid)}`}>
                {shortSha(commit.oid)}
              </a>
            </div>
          </div>
        </div>

        {!empty ? (
          <div class="ui attached segment flex-left-right">
            <strong>
              {data.files.length} {data.files.length === 1 ? commitViewLocale.files_changed_1 : commitViewLocale.files_changed_n}
            </strong>
            <DiffStats addition={data.totalAddition} deletion={data.totalDeletion} />
          </div>
        ) : null}

        <div class="diff-detail-box">
          <div class="flex-text-block tw-flex-wrap tw-ml-0.5" />
          <div id="diff-container">
            {empty ? (
              <h4>{pullFilesLocale.data_not_available}</h4>
            ) : (
              <div id="diff-boxes-column">
                <div id="diff-file-boxes">
                  {data.files.map((view) => (
                    <DiffFileBox view={view} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The raw downloads (web.go:1620 — repo.RawDiff's wiki arm)
// ---------------------------------------------------------------------------

/**
 * The series walker: the non-merge commits of `base..head` oldest-first,
 * one `--no-signature` mail per commit diffed against its own first parent
 * — diffpatch-files.ts's private renderPatchSeries mirrored over the wiki
 * blob source (module doc). The walk cap and the between-mail seam bytes
 * are that walker's verbatim (recorded against `git format-patch --stdout`).
 */
const MERGE_SERIES_COMMIT_CAP = 2000;
const MERGE_SERIES_PAGE = 500;

async function wikiPatchSeries(reads: EngineReads, base: string, head: string, options: RenderPatchOptions): Promise<string> {
  const commits: CommitJson[] = [];
  for (let page = 0; commits.length < MERGE_SERIES_COMMIT_CAP; page++) {
    const walked = await reads.listCommitsRange(base, head, MERGE_SERIES_PAGE, page);
    if (walked === null) break;
    for (const commit of walked.commits) {
      if (commit.parents.length <= 1) commits.push(commit);
    }
    if (!walked.more) break;
  }
  const numbered = commits.length > 1;
  const mails: string[] = [];
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i] as CommitJson;
    const parent = commit.parents.length === 1 ? commit.parents[0] : undefined;
    const diff = await reads.readDiff(commit.oid, parent);
    const files = diff?.files ?? [];
    const src = wikiDiffBlobSource(reads, diff?.old ?? null, diff?.new ?? commit.oid);
    mails.push(
      await renderPatchAsync(commit, files, src, {
        ...options,
        ...(numbered ? { patchNumber: { index: i + 1, count: commits.length } } : {}),
      }),
    );
  }
  return mails.map((mail) => `${mail}\n`).join("\n");
}

/**
 * The wiki download's body — loadCommitDiffPatch's exact composition over
 * the SIBLING cell (pages/diffpatch-files.ts): `.diff` is the plain unified
 * diff (readDiff's default-second-parent semantic; a root commit diffs
 * against the empty tree), `.patch` the git-am mail WITHOUT the signature
 * tail, a merge the non-merge side-commit series. `null` = the 404 family
 * (wrong shape, unknown/unresolvable oid — the serving arm answers the
 * §4.5 shell, the diffpatch family's convention).
 */
export async function loadWikiCommitDiffPatch(env: Env, pair: RepositoryWithOwner, sha: string, ext: WikiCommitDownloadExt): Promise<string | null> {
  if (!WIKI_COMMIT_SHA.test(sha)) return null;
  const reads = wikiReads(env, pair);
  const commit = await reads.readCommit(sha);
  if (commit === null) return null;
  if (ext === "patch" && commit.parents.length > 1) {
    return wikiPatchSeries(reads, commit.parents[0] as string, commit.oid, { signature: null });
  }
  const diff = await reads.readDiff(commit.oid);
  const files = diff?.files ?? [];
  const src = wikiDiffBlobSource(reads, diff?.old ?? null, diff?.new ?? commit.oid);
  if (ext === "patch") {
    return renderPatchAsync(commit, files, src, { signature: null });
  }
  return renderUnifiedDiffAsync(files, src);
}
