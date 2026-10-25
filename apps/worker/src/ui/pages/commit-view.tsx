/**
 * The commit view page, `/{owner}/{repo}/commit/{sha}` — pages wave 18 (the
 * UI parity survey's #1 dead-end: docs/compat/ui-parity-survey.md's top
 * demand-per-effort pick, the target every commits-log / branches-list / PR
 * commits ShortSha link lands on).
 *
 * ## DOM contract (templates/repo/commit_page.tmpl + repo/diff/{box,stats,
 *  section_unified,section_code}.tmpl at the pin; upstream repo.Diff,
 *  routers/web/repo/commit.go:277-430, web.go:1739)
 *
 * `.page-content.repository.diff`, then one `.ui.container.fluid.padded`
 * holding the upstream page order: the `.ui.top.attached.header.segment`
 * (the `commit-summary` h3 title — RenderCommitMessage's plain-text
 * reduction, the commit-body `pre` when the message carries a body, and the
 * header buttons — only "Browse Source" renders, the
 * create-branch/tag/revert/cherry-pick dropdown is a writer JS island), the
 * `.ui.attached.segment.flex-text-block` identity bar (the
 * committed_at/authored_committed_at sentence with the
 * `<relative-time>` stamp, the parents' `commit-id-short` labels, and the
 * commit's own sha label), the `.ui.attached.segment.flex-left-right`
 * diff short-stat line ("N file(s) changed" + the stats bar, rendered only
 * when files exist — ShowDiffSummaryInCommitHeader), and `repo/diff/box`:
 * the `.diff-detail-box` (toolbar empty for us — the file-tree toggle is a
 * JS island and ShowDiffSummaryInToolbar is false on this page) and
 * `#diff-container > #diff-file-boxes` with one DiffFileBox per file (the
 * wave-5/13 components over pull-files.tsx), or the DiffNotAvailable h4.
 *
 * ## Data (§3.2 — the landed engine reads, never a self-fetch)
 *
 * `engineReads(env, pair)` (api/services/engine.ts — the same client the
 * compare page rides): `readCommit(sha)` for the header, `readDiff(oid)`
 * for the diff — the engine's default-second-parent semantic IS the commit
 * diff (survey engineReads; repo.d.ts:319). `diffFileViews` +
 * `DiffFileBox` (pages/pull-files.tsx) render the boxes; DiffStats (the
 * stats.tmpl shape) renders the short-stat bar. The author/committer
 * profile links ride the landed `usernamesByEmail` (api/services/
 * git-models.ts — the API's ToPayloadCommit email resolution): a mapped
 * email anchors `/{username}` (the wave-7 dead-link rule), an unmapped one
 * renders plain name text — upstream AvatarStackWithNames' linked vs
 * AvatarByEmail's plain arms.
 *
 * ## Auth + posture
 *
 * Public anonymous GET like every read page (the router resolved the repo
 * first, §2.5). The sha arms: a non-hex or wrong-shape segment, a hex
 * segment that resolves to nothing, and an unreachable oid all 404-shell
 * (upstream Diff's git.IsErrNotExist → ctx.NotFound).
 *
 * ## Documented v1 divergences/degradations (§6 method)
 *
 * - **Full oids only.** Upstream's route pattern `([a-f0-9]{7,64})` resolves
 *   short prefixes through git's RevParse; the engine's `readCommit`
 *   resolves refs and FULL 40-hex reachable oids only
 *   (packages/git-engine/src/repo.ts resolveServable — short-prefix
 *   resolution is deliberately absent there: a force-pushed secret must
 *   stay unresolvable through the UI). A 7..39-hex URL therefore 404-shells
 *   where upstream renders the commit; the emitted links are always full
 *   oids, so no page-internal link can hit the divergence.
 * - The `.{patch|diff}` suffix family (web.go:1760 RawDiff) and the
 *   `/load-branches-and-tags` aux JSON (web.go:1740) stay unlanded — the
 *   parser claims only the exact single-segment view shape (a dotted
 *   segment 404-shells through the same non-hex arm until the RawDiff
 *   slice lands).
 * - Commit statuses (CI) and the sign badge have no backing data model —
 *   the template's `commit_statuses` + `commit_sign_badge` slots render
 *   nothing (the commit-list precedent).
 * - The operations dropdown (branch/tag create, revert, cherry-pick —
 *   writer JS islands), the copy-hash button, the file-tree toggle and the
 *   git-notes section (no notes storage) are omitted; the no-JS reduction
 *   renders the "Browse Source" button only.
 * - `DiffResult.truncated` is dropped by the shared render model (the
 *   pull-files header's same degradation): a truncated diff shows its
 *   first files without the `#diff-incomplete` segment.
 * - RenderCommitMessage/RenderCommitBody's issue-reference linkification
 *   and chroma highlighting are upstream render services this slice does
 *   not run — title/body/line text render plain (the commit-list and
 *   pull-files precedent).
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { engineReads } from "../../api/services/engine";
import { usernamesByEmail } from "../../api/services/git-models";
import { userLink, treeLink } from "../links";
import { shortSha } from "../page-data";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { DiffFileBox, diffFileViews, pullFilesLocale, DiffStats, type DiffFileView } from "./pull-files";
import { messageBodyOf } from "./compare";
import { TimeSince } from "../components/file-list";

/** Page chrome text (component-local, the pullFilesLocale pattern — the
 *  strings cite upstream's own locale keys). */
export const commitViewLocale = {
  committed: "committed", // "repo.diff.committed_at" fragment
  authored_and: "authored and", // "repo.diff.authored_committed_at" fragment
  commit: "commit", // "repo.diff.commit"
  parent: "parent", // "repo.diff.parent"
  parents: "parents", // "repo.diff.parents"
  files_changed_1: "file changed", // "repo.diff.num_files_changed_1"
  files_changed_n: "files changed", // "repo.diff.num_files_changed_n"
  browse_source: "Browse Source", // "repo.diff.browse_source"
} as const;

/** Upstream route pattern `([a-f0-9]{7,64})` (web.go:1739) — shape gate
 *  only; existence is the engine read's answer. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed reads)
// ---------------------------------------------------------------------------

/** The commit page render inputs, loaded by loadCommitViewData. */
export interface CommitViewData {
  commit: CommitJson;
  /** The author/committer display names' profile usernames (null = the
   *  email maps to no account — plain-name render, upstream's
   *  AvatarByEmail arm). */
  authorUsername: string | null;
  committerUsername: string | null;
  /** `Commit.CommitterIsAuthor` (modules/git/commit_message.go:180-182):
   *  both name AND email equal — picks committed_at vs
   *  authored_committed_at. */
  committerIsAuthor: boolean;
  files: DiffFileView[];
  totalAddition: number;
  totalDeletion: number;
}

export interface CommitViewNotFound {
  notFound: true;
}

/** The repo-scoped subset the loader reads (the caller's resolved row). */
export type CommitViewRepo = {
  ownerNamespace: string;
  slug: string;
};

/**
 * Load the commit + its diff. `notFound` covers the §4.5 404 family: a
 * non-hex/short-sha-shaped segment (upstream's route-pattern miss), and any
 * hex the engine cannot resolve to a reachable commit (unknown oid — the
 * full-oid divergence above). An engine diff failure degrades to the empty
 * file list → the DiffNotAvailable render (never a 500).
 */
export async function loadCommitViewData(
  env: Env,
  db: D1Database,
  repo: CommitViewRepo,
  sha: string,
): Promise<CommitViewData | CommitViewNotFound> {
  if (!COMMIT_SHA.test(sha)) return { notFound: true };
  const reads = engineReads(env, repo);
  const commit = await reads.readCommit(sha);
  if (commit === null) return { notFound: true };
  const diff = await reads.readDiff(commit.oid);
  const files = await diffFileViews(diff?.files ?? []);

  // The identity→profile resolution (the API's ToPayloadCommit map, one
  // query for both identities).
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

// ---------------------------------------------------------------------------
// Components (repo/commit_page.tmpl + repo/diff/stats.tmpl)
// ---------------------------------------------------------------------------

/** One identity name: profile link when the email mapped to an account,
 *  plain text otherwise (upstream AvatarStackWithNames vs AvatarByEmail). */
function IdentityName(props: { name: string; username: string | null }) {
  return props.username !== null ? (
    <a href={userLink(props.username)}>{props.name}</a>
  ) : (
    <>{props.name}</>
  );
}

/** The identity bar's sentence (commit_page.tmpl:132-154): "A committed
 *  {time}" when committer is author, "A authored and C committed {time}"
 *  otherwise — both stamped with the COMMITTER's TimeSince. */
function IdentityLine(props: { data: CommitViewData }) {
  const { commit } = props.data;
  const time = <TimeSince unixSeconds={commit.committer.time} tz={commit.committer.tz} />;
  const author = <IdentityName name={commit.author.name} username={props.data.authorUsername} />;
  return (
    <span class="flex-text-inline tw-text-text-light">
      {props.data.committerIsAuthor ? (
        <>
          {author} {commitViewLocale.committed} {time}
        </>
      ) : (
        <>
          {author} {commitViewLocale.authored_and}{" "}
          <strong>
            <IdentityName name={commit.committer.name} username={props.data.committerUsername} />
          </strong>{" "}
          {commitViewLocale.committed} {time}
        </>
      )}
    </span>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderCommitViewPage(options: { ctx: UiContext; data: CommitViewData }): string {
  return renderPage(<CommitViewPage ctx={options.ctx} data={options.data} />);
}

/** The commit view page (§2.4.1 discriminator: `repository diff` —
 *  commit_page.tmpl:5 verbatim). */
export function CommitViewPage(props: { ctx: UiContext; data: CommitViewData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("CommitViewPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const { commit } = data;
  const body = messageBodyOf(commit);
  const empty = data.files.length === 0;
  return (
    <BaseLayout
      ctx={ctx}
      title={`${commit.subject} · ${shortSha(commit.oid)}`}
      pageClass="repository diff"
      activeTab="code"
    >
      <div class="ui container fluid padded">
        <div class="ui top attached header segment">
          <div class="flex-left-right tw-mb-4 tw-items-start">
            <h3 class="tw-m-0">
              <span class="commit-summary" title={commit.subject}>
                {commit.subject}
              </span>
            </h3>
            <div class="commit-header-buttons">
              <a class="ui tiny button" href={treeLink(repoLink, "commit", commit.oid)}>
                {commitViewLocale.browse_source}
              </a>
            </div>
          </div>
          {body !== "" ? <pre class="commit-body">{body}</pre> : null}
        </div>

        <div class="ui attached segment flex-text-block tw-flex-wrap">
          <IdentityLine data={data} />
          <div class="tw-flex-1" />
          <div class="flex-text-block tw-flex-wrap">
            {commit.parents.length > 0 ? (
              <div class="flex-text-inline tw-flex-wrap">
                <span class="tw-text-text-light">
                  {commit.parents.length} {commit.parents.length === 1 ? commitViewLocale.parent : commitViewLocale.parents}
                </span>
                {commit.parents.map((parent) => (
                  <a class="ui label commit-id-short" href={`${repoLink}/commit/${encodeURIComponent(parent)}`}>
                    {shortSha(parent)}
                  </a>
                ))}
              </div>
            ) : null}
            <div class="flex-text-inline">
              <span class="flex-text-inline tw-text-text-light">{commitViewLocale.commit}</span>
              <a class="ui label commit-id-short" href={`${repoLink}/commit/${encodeURIComponent(commit.oid)}`}>
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
