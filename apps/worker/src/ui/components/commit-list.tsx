/**
 * The commit log table (templates/repo/commits_list.tmpl at the pin):
 * `.ui.attached.table.segment.commit-table` → `table#commits-table` →
 * `tbody.commit-list` rows with the author cell (plain name text — no avatar
 * images v1), the sha cell (commit-id-short label), the subject cell, and the
 * relative date (§3.3 row shape).
 *
 * Omitted per §3.3: total count header, keyword search box, per-commit CI
 * statuses, signature badges, branch/tag decorations, and the trailing
 * actions column (copy-hash/view-at-rev buttons — no octicon-copy in the
 * generated icon allowlist, and the buttons' targets are all dead this
 * slice). Sha/subject links use the upstream-shaped `/commit/{oid}` URLs
 * that land on the 404 shell this slice (§1.2, open question 1).
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { commitLink } from "../links";
import { shortSha } from "../page-data";
import { TimeSince } from "./file-list";

/** Page-level strings (upstream keys cited; locale.ts is shell chrome —
 *  page text lands beside the pages that render it). */
export const commitsLocale = {
  /** "repo.commits.commits" */
  commits: "Commits",
  /** "repo.commits.author" */
  author: "Author",
  /** the SHA column header: `StringUtils.ToUpper .ObjectFormatName` — the
   *  engine is SHA-1 (SPEC-0001). */
  sha: "SHA1",
  /** "repo.commits.message" */
  message: "Message",
  /** "repo.commits.date" */
  date: "Date",
  /** "repo.issues.previous" / the §3.3 "Older" paging link */
  newer: "Newer",
  older: "Older",
} as const;

export function CommitList(props: { repoLink: string; commits: readonly CommitJson[] }) {
  return (
    <div class="ui attached table segment commit-table">
      <table class="ui very basic table unstackable" id="commits-table">
        <thead>
          <tr>
            {/* scope=col: the U5 §5.5 smoke requires explicit scope on real
                table headers (additive attribute, no CSS/JS reads it). */}
            <th scope="col" class="three wide">{commitsLocale.author}</th>
            <th scope="col" class="two wide sha">{commitsLocale.sha}</th>
            <th scope="col" class="eight wide message">{commitsLocale.message}</th>
            <th scope="col" class="two wide tw-text-right">{commitsLocale.date}</th>
          </tr>
        </thead>
        <tbody class="commit-list">
          {props.commits.map((commit) => (
            <tr>
              <td class="author">{commit.author.name}</td>
              <td class="sha">
                <a
                  href={commitLink(props.repoLink, commit.oid)}
                  class="ui label commit-id-short"
                  rel="nofollow"
                >
                  {shortSha(commit.oid)}
                </a>
              </td>
              <td class="message">
                <span class="message-wrapper">
                  <span class="commit-summary" title={commit.subject}>
                    <a href={commitLink(props.repoLink, commit.oid)}>{commit.subject}</a>
                  </span>
                </span>
              </td>
              <td class="tw-text-right">
                <TimeSince unixSeconds={commit.committer.time} tz={commit.committer.tz} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
