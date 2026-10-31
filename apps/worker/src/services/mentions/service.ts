/**
 * The mentions service entry — upstream's `FindAndUpdateIssueMentions`
 * (gitea/models/issues/issue_update.go:551-571 at pin fc493688): parse the
 * content, resolve against visibility, hand the survivors to the notify
 * layer. The emit sites call this exactly where upstream's issue service
 * does (services/issue/comments.go:81 CreateIssueComment, :68-adjacent
 * services/issue/issue.go:68 CreateIssue, services/pull/pull.go:184
 * CreatePullRequest) and pass the result into the mail arms' `mentions`
 * parameter — the shape slice two threaded as the reduction
 * (specs/email-outbound.md §8.2, lifted in §13).
 *
 * Deviation from the upstream function, recorded in resolve.ts's header:
 * the `IsUserBlockedBy` filter (no block table). The `UpdateIssueMentions`
 * persistence arm (the `issue_user` carrier) LANDED (migration 0057,
 * `carrier.ts`): the callers run resolve + persist — this entry stays the
 * pure resolve half so the mail consumers can keep threading the resolved
 * users straight through.
 */

import type { RepositoryRow, UserRow } from "../../api/services/repository";
import { findAllMentionsMarkdown } from "./parser";
import { resolveIssueMentionsByVisibility } from "./resolve";

export interface FindIssueMentionsInput {
  repo: Pick<RepositoryRow, "id" | "ownerId" | "visibility">;
  issue: Pick<RepositoryIssueRow, "isPull">;
  doer: UserRow;
  /** The written content (comment body / issue description / PR body). */
  content: string;
}

/** Structural slice of the landed issue row (issues/service.ts's IssueRow)
 *  — the resolve needs only IsPull. */
export interface RepositoryIssueRow {
  isPull: boolean;
}

/**
 * `FindAndUpdateIssueMentions` minus the two schema-absent arms (module
 * header): raw parse (case kept) → visibility resolution (case-folded,
 * deduped, team-expanded, read-gated). Empty content short-circuits before
 * the strip runs.
 */
export async function findIssueMentions(d1: D1Database, input: FindIssueMentionsInput): Promise<UserRow[]> {
  const rawMentions = findAllMentionsMarkdown(input.content);
  if (rawMentions.length === 0) return [];
  return resolveIssueMentionsByVisibility(d1, {
    repo: input.repo,
    isPull: input.issue.isPull,
    doer: input.doer,
    mentions: rawMentions,
  });
}
