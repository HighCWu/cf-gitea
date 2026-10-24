/**
 * The repo file list (templates/repo/view_list.tmpl at the pin) and the
 * latest-commit box (templates/repo/latest_commit.tmpl) — shared by the repo
 * home page (root listing) and the file view's directory rendering (the file
 * view page doubles as the tree browser, §3.3).
 *
 * The `#repo-files-table` ID is load-bearing CSS (§2.4.1); the
 * `.repo-file-line` / `.repo-file-item` / `.repo-file-cell` structure and the
 * `name muted-links` / `message commit-summary` / `age` cell classes mirror
 * the template exactly. Slice 1 renders the table COMPLETE whenever the §3.5
 * enrichment resolves an entry's commit, and the muted `.notready` message
 * cell (without the `data-fetch` loader — no partial endpoint exists) when it
 * does not.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { commitLink, treeLink } from "../links";
import { shortSha, timeSinceParts } from "../page-data";
import { Icon } from "../shell";

/** One rendered row's inputs. `commit === null` → the `.notready` cell. */
export interface FileListItem {
  entry: TreeEntryJson;
  commit: CommitJson | null;
}

/** Upstream `{{DateUtils.TimeSince …}}` — the relative-time web component
 *  with the absolute stamp as text (page-data.timeSinceParts). */
export function TimeSince(props: { unixSeconds: number; tz: string }) {
  const parts = timeSinceParts(props.unixSeconds, props.tz);
  return (
    <relative-time
      prefix=""
      tense={parts.tense}
      datetime={parts.datetime}
      data-tooltip-content=""
      data-tooltip-interactive="true"
    >
      {parts.text}
    </relative-time>
  );
}

/**
 * The latest-commit box (repo/latest_commit.tmpl, slice-1 subset): the
 * subject as an upstream-shaped commit link, plain author name text (no
 * avatar images, §3.3), no sign badge / statuses / ellipsis body (no backing
 * data — §3.3 omissions). `null` renders the template's `…` placeholder.
 */
export function LatestCommitBox(props: { repoLink: string; commit: CommitJson | null }) {
  const { commit } = props;
  if (commit === null) {
    return <div class="latest-commit">…</div>;
  }
  return (
    <div class="latest-commit">
      <span class="grey commit-summary" title={commit.subject}>
        <span class="message-wrapper">
          <a href={commitLink(props.repoLink, commit.oid)}>{commit.subject}</a>
        </span>
        <span class="author-wrapper">{commit.author.name}</span>
      </span>
    </div>
  );
}

/** The entry icon: directories fill, everything else the plain file glyph.
 *  Symlink/submodule-specific octicons are outside the generated allowlist —
 *  documented degradation (§4.10 renders the same name/link shapes, only the
 *  glyph is shared). */
function entryIcon(entry: TreeEntryJson) {
  return <Icon name={entry.type === "tree" ? "octicon-file-directory-fill" : "octicon-file"} />;
}

/**
 * view_list.tmpl: the last-commit line, the optional parent-link row (§5.1
 * sub-directory views), then one `.repo-file-item` per entry.
 */
export function RepoFilesTable(props: {
  repoLink: string;
  /** The ref the listing hangs off, emitted in the URL suffix shape. */
  refType: "branch" | "tag" | "commit";
  ref: string;
  /** The directory being listed ("" = root); prefixes entry links + the
   *  per-entry enrichment paths. */
  dirPath: string;
  entries: readonly TreeEntryJson[];
  commits: ReadonlyMap<string, CommitJson | null>;
  /** The directory's own last commit (the top `.repo-file-last-commit` line). */
  latestCommit: CommitJson | null;
}) {
  const { repoLink, refType, ref, dirPath, entries, commits, latestCommit } = props;
  const parentPath = dirPath === "" ? null : dirPath.split("/").slice(0, -1).join("/");
  const entryPath = (entry: TreeEntryJson): string => (dirPath === "" ? entry.name : `${dirPath}/${entry.name}`);
  return (
    <div id="repo-files-table">
      <div class="repo-file-line repo-file-last-commit">
        <LatestCommitBox repoLink={repoLink} commit={latestCommit} />
        <div>
          {latestCommit !== null ? (
            <TimeSince unixSeconds={latestCommit.committer.time} tz={latestCommit.committer.tz} />
          ) : null}
        </div>
      </div>
      {parentPath !== null ? (
        <a
          class="repo-file-line parent-link silenced"
          href={treeLink(repoLink, refType, ref, parentPath)}
        >
          <Icon name="octicon-file-directory-fill" /> ..
        </a>
      ) : null}
      {entries.map((entry) => {
        const commit = commits.get(entry.name) ?? null;
        return (
          <div class="repo-file-item">
            <div class="repo-file-cell name muted-links">
              {entryIcon(entry)}
              {entry.type === "commit" ? (
                // §4.10: submodule rows render `name @ <sha>` as plain text
                // (no cross-forge resolution v1).
                <span class="entry-name" title={entry.name}>
                  {entry.name} @ {shortSha(entry.oid)}
                </span>
              ) : (
                <a class="entry-name" href={treeLink(repoLink, refType, ref, entryPath(entry))} title={entry.name}>
                  {entry.name}
                </a>
              )}
            </div>
            <div
              class={
                commit === null
                  ? "repo-file-cell message commit-summary notready"
                  : "repo-file-cell message commit-summary"
              }
            >
              {commit !== null ? (
                <a href={commitLink(repoLink, commit.oid)}>{commit.subject}</a>
              ) : (
                // §3.5 degradation: muted placeholder, no data-fetch loader.
                "…"
              )}
            </div>
            <div class="repo-file-cell age">
              {commit !== null ? <TimeSince unixSeconds={commit.committer.time} tz={commit.committer.tz} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
