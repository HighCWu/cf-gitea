/**
 * The issue detail page, `/{owner}/{repo}/issues/{index}` — and the PR twin,
 * `/{owner}/{repo}/pulls/{index}`, served by the same is_pull-aware component
 * (a PR IS an issue row with a `pull_requests` extension, SPEC-0005 §3.2).
 * Pages wave 3 (SPEC-0008 U3 extension).
 *
 * ## DOM contract (templates/repo/issue/view.tmpl + view_title.tmpl +
 *  view_content.tmpl + view_content/comments.tmpl + view_content/
 *  pull_merge_box.tmpl + view_content/sidebar.tmpl at the pin)
 *
 * `.page-content.repository.view.issue.pull` (upstream emits both
 * discriminators unconditionally — mirrored verbatim), then inside one
 * `.ui.container`: the `.issue-title-header` (`h1` title + `.index` span,
 * `.issue-title-meta` state label + poster line), the
 * `.issue-content` two-column grid — `.issue-content-left > .comment-list`
 * holding the root issue comment (`#issue-{id}`), the timeline
 * (`.timeline-item.comment` cards for user comments,
 * `.timeline-item.event` lines with `.badge` state dots for close/reopen/
 * merge, the reduced `.pull-merge-box` for open PRs) — and
 * `.issue-content-right.ui.segment` (the reduced sidebar: labels + milestone).
 *
 * ## Cross-family URL semantics (upstream ViewIssue, issue_view.go:347-352)
 *
 * "Make sure type and URL matches": `/{issues}/{n}` of a PR row 303s onto
 * `/{pulls}/{n}` and the mirror image (upstream `ctx.Redirect` →
 * `Issue.Link()`; 303 See Other per `services/context/base.go:157`). Unknown
 * indexes 404-shell after the §2.5 repo resolution.
 *
 * ## Data
 *
 * Direct service reads (§3.2, never a self-fetch): `findIssueByRepoAndIndex`
 * + `issueLabelRows` + `listIssueTimeline` + `hasWorkInProgressPrefix`
 * (src/api/services/issues.ts), `findPullRequestByIndex`
 * (src/api/services/pulls.ts), `mergeableOfRow` (src/api/services/
 * pull-engine.ts — the cached D1 state machine, the same cheap render the
 * list converter uses; the lazy engine check stays API-side), plus one
 * markdown-pipeline call per body and two batched D1 lookups (milestone,
 * person names). Anonymous, public repos only — the router resolved the row
 * before this loader runs (§2.5).
 *
 * ## Documented v1 degradations (data that has no landed source, §6 method)
 *
 * - The PR merge box renders the cached mergeability summary only (the
 *   upstream merge FORM is a write action, §2.5, and its Vue island needs the
 *   pageData payload — neither lands this wave). Mergeability comes from
 *   `mergeableOfRow` (checking → the "being computed" note) — no engine call.
 * - Timeline coverage: user comments (type 0) and the lifecycle events the
 *   landed write paths produce — close (2), reopen (1), merge (28). The
 *   remaining system-event types (labels/milestones/title/xrefs/…) are
 *   omitted rather than rendered with approximated text (the §2.4.1 dead-UI
 *   rule applied to prose); they land with their feature waves.
 * - Poster/merger names are plain text (upstream links `/{username}` profile
 *   pages — none exist this slice); the issue row's `original_author` (mirrored
 *   imports) wins over the user row when set, as upstream renders it.
 * - PR branch names render as `<code>` without links and without the commit
 *   count ("wants to merge X commits from … into …"): both need engine reads
 *   (branch existence, the PR commit range) deferred with the mergeability
 *   wave. The merge-event sha renders as plain short text — the
 *   `/commit/{sha}` page stays engine-owned (open question 1).
 * - Milestone renders as plain text (upstream links `/{repo}/milestone/{id}` —
 *   no milestone page; the §2.4.1 dead-link rule wins). Label badges link into
 *   the LIVE list filters (`/{issues|pulls}?labels={id}` — wave-2 QueryBuild
 *   parity). The sidebar's edit dropdowns (label/milestone pickers) are write
 *   actions — not rendered (§2.5); the section headings stay.
 * - Avatar images are not rendered (no avatar route exists; an `<img>` to a
 *   missing route is a dead link) — the timeline items keep the upstream
 *   content structure without the `.timeline-avatar` slots.
 * - The PR conversation tab menu (`repo/pulls/tab_menu.tmpl`) is not rendered:
 *   Conversation is this page, and the Commits/Files tabs would be dead links
 *   (those pages don't exist).
 * - The comment form, reactions, context menus and status-change buttons are
 *   write actions or signed-in chrome (§2.5) — not rendered.
 *
 * Bodies render through the SHARED markdown pipeline (§3.4 —
 * src/api/services/markdown.ts in upstream's `comment` mode): relative links
 * rewrite onto the branch-prefixed `/src/...` pages (the pipeline's
 * default-branch fallback), everything else passes; any pipeline failure
 * degrades to the plain no-content variant (markdown never breaks the page).
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { renderMarkdownToHtml } from "../../api/services/markdown";
import {
  findIssueByRepoAndIndex,
  hasWorkInProgressPrefix,
  issueLabelRows,
  listIssueTimeline,
} from "../../api/services/issues";
import { mergeableOfRow } from "../../api/services/pull-engine";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { milestones, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { CommentRow, IssueRow, LabelRow, MilestoneRow, PullRequestRow } from "../../issues/service";
import { TimeSince } from "../components/file-list";
import { LabelBadge } from "./issues-list";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

/** Page chrome text (component-local, the issuesLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const issueDetailLocale = {
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  merged: "Merged", // "repo.pulls.merged"
  draft_title: "Draft", // "repo.issues.draft_title"
  num_comments_1: "1 comment", // "repo.issues.num_comments_1"
  num_comments: "comments", // "repo.issues.num_comments" (count rendered ahead)
  commented_at: "commented", // "repo.issues.commented_at" (verb; the anchor carries the time)
  no_content: "No description provided.", // "repo.issues.no_content"
  labels: "Labels", // "repo.issues.new.labels"
  no_labels: "No labels", // "repo.issues.new.no_labels"
  milestone: "Milestone", // "repo.issues.new.milestone"
  no_milestone: "No Milestone", // "repo.issues.new.no_milestone"
  reopened_issue: "reopened this issue", // "repo.issues.reopened_at" verb
  closed_issue: "closed this issue", // "repo.issues.closed_at" verb
  reopened_pull: "reopened this pull request", // "repo.pulls.reopened_at" verb
  closed_pull: "closed this pull request", // "repo.pulls.closed_at" verb
  merged_commit: "merged commit", // "repo.issues.comment_pull_merged_at" fragment
  merged_into: "into", // "repo.issues.comment_pull_merged_at" fragment
  // Merge-box summary lines: the first three cite upstream's own strings
  // ("repo.pulls.no_merge_wip" and the merge-form Vue component's two
  // sentences); the checking note is a cf-gitea addition for the state the
  // upstream box renders as a loading placeholder.
  merge_box_wip: "This pull request cannot be merged because it is marked as being a work in progress.",
  merge_box_mergeable: "This branch has no conflicts with the base branch.",
  merge_box_conflict: "This branch has conflicts that must be resolved.",
  merge_box_checking: "Pull request mergeability is being computed.",
} as const;

/** Timeline cap (upstream renders the full timeline unpaginated; the cap
 *  bounds the render for pathological threads without changing the order). */
export const TIMELINE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Data loading (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** One rendered timeline entry: a user comment or a lifecycle event. */
export type TimelineEntry =
  | { kind: "comment"; comment: CommentRow; posterName: string | null; bodyHtml: string }
  | { kind: "reopen" | "close" | "merge"; comment: CommentRow; posterName: string | null };

/** The issue/PR detail page render inputs, loaded by loadIssueDetailData. */
export interface IssueDetailData {
  /** The URL family the page was addressed by (drives activeTab + verbs). */
  urlKind: "issues" | "pulls";
  issue: IssueRow;
  /** The `pull_requests` extension row — PRs only (§3.2). */
  pr: PullRequestRow | null;
  /** Cached mergeability (PRs only): null = checking, per mergeableOfRow. */
  mergeable: boolean | null;
  labels: LabelRow[];
  milestone: MilestoneRow | null;
  /** Display-cased poster username; `null` = no user row (mirrored imports). */
  posterName: string | null;
  mergerName: string | null;
  /** The description through the §3.4 pipeline; `""` = no-content variant. */
  bodyHtml: string;
  timeline: TimelineEntry[];
}

/**
 * The §3.4 shared markdown pipeline in upstream's `comment` mode (the
 * issue-body/comment posture): relative links rewrite against the repo root
 * onto the branch-prefixed `/src/...` pages (markdown.ts's default-branch
 * fallback), the same accepted posture as the README render
 * (page-data.renderRepoMarkdown). Any pipeline failure degrades to `""` —
 * markdown never breaks the page.
 */
export function renderIssueMarkdown(input: { text: string; repo: RepoRow; origin: string }): string {
  if (input.text === "") return "";
  try {
    return renderMarkdownToHtml({
      text: input.text,
      mode: "comment",
      context: `/${input.repo.ownerNamespace}/${input.repo.slug}`,
      wiki: false,
      origin: input.origin,
    });
  } catch {
    return "";
  }
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Load one issue/PR with its render inputs. Returns `null` when the index
 * misses (the caller 404-shells) — the row is otherwise rendered as-is,
 * whatever its family; the caller owns the upstream type/URL redirect.
 */
export async function loadIssueDetailData(
  d1: D1Database,
  repo: RepoRow,
  urlKind: "issues" | "pulls",
  index: number,
  origin: string,
): Promise<IssueDetailData | null> {
  const issue = await findIssueByRepoAndIndex(d1, repo.id, index);
  if (issue === null) return null;

  const pr = issue.isPull ? ((await findPullRequestByIndex(d1, repo.id, index))?.pullRequest ?? null) : null;
  const mergeable = pr === null ? null : mergeableOfRow(pr);

  const [labels, timelineRows, milestoneRow] = await Promise.all([
    issueLabelRows(d1, issue.id),
    listIssueTimeline(d1, issue.id, null, null, 1, TIMELINE_LIMIT),
    issue.milestoneId === null
      ? Promise.resolve(null)
      : drizzle(d1)
          .select()
          .from(milestones)
          .where(eq(milestones.id, issue.milestoneId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
  ]);

  // One batched name lookup for every person the render mentions (§3.2's
  // wave-2 batching pattern): poster, merger, timeline posters.
  const personIds = new Set<number>();
  if (issue.posterId !== null) personIds.add(issue.posterId);
  if (pr !== null && pr.hasMerged && pr.mergerId != null) personIds.add(pr.mergerId);
  for (const comment of timelineRows) {
    if (comment.posterId !== null) personIds.add(comment.posterId);
  }
  const names = new Map<number, string>();
  if (personIds.size > 0) {
    const rows = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, [...personIds]))
      .all();
    for (const row of rows) names.set(row.id, row.username);
  }
  const nameOf = (id: number | null): string | null => (id === null ? null : (names.get(id) ?? null));

  const timeline: TimelineEntry[] = [];
  for (const comment of timelineRows) {
    const posterName = nameOf(comment.posterId);
    if (comment.type === CommentType.Comment) {
      timeline.push({
        kind: "comment",
        comment,
        posterName,
        bodyHtml: renderIssueMarkdown({ text: comment.content ?? "", repo, origin }),
      });
    } else if (comment.type === CommentType.Reopen || comment.type === CommentType.Close || comment.type === CommentType.MergePull) {
      const kind = comment.type === CommentType.Reopen ? "reopen" : comment.type === CommentType.Close ? "close" : "merge";
      timeline.push({ kind, comment, posterName });
    }
    // Every other system-event type stays unrendered this wave (header
    // comment: omitted rather than approximated).
  }

  return {
    urlKind,
    issue,
    pr,
    mergeable,
    labels,
    milestone: milestoneRow,
    posterName: nameOf(issue.posterId),
    mergerName: pr !== null && pr.hasMerged ? nameOf(pr.mergerId ?? null) : null,
    bodyHtml: renderIssueMarkdown({ text: issue.content ?? "", repo, origin }),
    timeline,
  };
}

/**
 * Upstream ViewIssue's type/URL match (issue_view.go:347-352): the wrong URL
 * family for the row redirects onto `Issue.Link()`. Returns the target when
 * the families mismatch, `null` when the page can render in place.
 */
export function crossFamilyRedirect(
  urlKind: "issues" | "pulls",
  repoLink: string,
  index: number,
  isPull: boolean,
): string | null {
  const expected = isPull ? "pulls" : "issues";
  return urlKind === expected ? null : `${repoLink}/${expected}/${index}`;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The state chip of view_title.tmpl, in the template's branch order:
 *  merged → closed → draft → open, with the exact label/icon pairs (the
 *  issue-state octicons render since the wave-4 multi-path Icon — the
 *  wave-3 degradation note is retired). */
export function IssueStateBadge(props: { data: IssueDetailData }) {
  const { issue, pr } = props.data;
  if (pr !== null && pr.hasMerged) {
    return (
      <div class="ui purple label issue-state-label">
        <Icon name="octicon-git-merge" class="tw-mr-1" /> {issueDetailLocale.merged}
      </div>
    );
  }
  if (issue.isClosed) {
    return (
      <div class="ui red label issue-state-label">
        <Icon name={issue.isPull ? "octicon-git-pull-request-closed" : "octicon-issue-closed"} />{" "}
        {issueDetailLocale.closed_title}
      </div>
    );
  }
  if (issue.isPull) {
    if (hasWorkInProgressPrefix(issue.title)) {
      return (
        <div class="ui grey label issue-state-label">
          <Icon name="octicon-git-pull-request-draft" /> {issueDetailLocale.draft_title}
        </div>
      );
    }
    return (
      <div class="ui green label issue-state-label">
        <Icon name="octicon-git-pull-request" /> {issueDetailLocale.open_title}
      </div>
    );
  }
  return (
    <div class="ui green label issue-state-label">
      <Icon name="octicon-issue-opened" /> {issueDetailLocale.open_title}
    </div>
  );
}

/** The issue meta line: "opened {time} by {poster} · {n} comments" — poster
 *  plain text (no profile pages), `original_author` winning like upstream. */
function IssueMetaLine(props: { data: IssueDetailData }) {
  const { issue, posterName } = props.data;
  const author = issue.originalAuthor ?? posterName;
  const count =
    issue.numComments === 1 ? issueDetailLocale.num_comments_1 : `${issue.numComments} ${issueDetailLocale.num_comments}`;
  return (
    <span class="time-desc">
      opened{" "}
      {issue.createdAt !== null ? <TimeSince unixSeconds={unixSeconds(issue.createdAt)} tz="+0000" /> : null}
      {author !== null ? <> by {author}</> : null}
      {` · ${count}`}
    </span>
  );
}

/** The PR meta line: "{poster} wants to merge {head} into {base}" (merged:
 *  "{merger} merged … {time}") — the upstream pull-desc shape with the
 *  branch names as `<code>` text (branch links + commit count are engine
 *  reads; header comment). */
function PullMetaLine(props: { data: IssueDetailData }) {
  const { pr, posterName, mergerName } = props.data;
  if (pr === null) return null;
  if (pr.hasMerged) {
    const actor = mergerName ?? posterName;
    return (
      <span id="pull-desc-display" class="pull-desc">
        {actor !== null ? <>{actor} </> : null}
        merged <code>{pr.headBranch}</code> {issueDetailLocale.merged_into} <code>{pr.baseBranch}</code>
        {pr.mergedAt !== null && pr.mergedAt !== undefined ? (
          <>
            {" "}
            <TimeSince unixSeconds={unixSeconds(pr.mergedAt)} tz="+0000" />
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span id="pull-desc-display" class="pull-desc">
      {posterName !== null ? <>{posterName} </> : null}
      wants to merge <code>{pr.headBranch}</code> {issueDetailLocale.merged_into} <code>{pr.baseBranch}</code>
    </span>
  );
}

/** `view_title.tmpl` reduced: the `h1` (#index included) and the state/meta
 *  line — the edit/New buttons are write actions, not rendered (§2.5). */
function IssueTitleBar(props: { data: IssueDetailData }) {
  const { issue, pr } = props.data;
  return (
    <div class="issue-title-header">
      <div class="issue-title" id="issue-title-display">
        <h1>
          {issue.title} <span class="index">#{issue.index}</span>
        </h1>
      </div>
      <div class="issue-title-meta flex-text-block">
        <IssueStateBadge data={props.data} />
        <div class="flex-text-block">{pr === null ? <IssueMetaLine data={props.data} /> : <PullMetaLine data={props.data} />}</div>
      </div>
    </div>
  );
}

/** The comment header line both comment cards share: "{poster} commented
 *  {time}" — the upstream `commented_at` shape with the author plain-text. */
function CommentHeader(props: { hash: string; posterName: string | null; createdAt: Date | null }) {
  return (
    <div class="comment-header avatar-content-left-arrow" role="heading" aria-level="3">
      <div class="comment-header-left">
        <span class="tw-text-text-light muted-links">
          {props.posterName !== null ? <>{props.posterName}{" "}</> : null}
          {issueDetailLocale.commented_at}{" "}
          {props.createdAt !== null ? (
            <a href={`#${props.hash}`}>
              <TimeSince unixSeconds={unixSeconds(props.createdAt)} tz="+0000" />
            </a>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** The render-content body both comment cards share (view_content.tmpl's
 *  `.ui.attached.segment.comment-body`): pipeline HTML, or the upstream
 *  no-content placeholder. */
function CommentBody(props: { bodyHtml: string }) {
  return (
    <div class="ui attached segment comment-body" role="article">
      {props.bodyHtml === "" ? (
        <div class="render-content markup">
          <span class="no-content">{issueDetailLocale.no_content}</span>
        </div>
      ) : (
        <div class="render-content markup" dangerouslySetInnerHTML={{ __html: props.bodyHtml }} />
      )}
    </div>
  );
}

/** The root issue comment (`#issue-{id}`, view_content.tmpl's first
 *  `.timeline-item.comment.issue-content-comment`). */
function RootComment(props: { data: IssueDetailData }) {
  const { issue, posterName, bodyHtml } = props.data;
  const hash = `issue-${issue.id}`;
  const author = issue.originalAuthor ?? posterName;
  return (
    <div id={hash} class="timeline-item comment issue-content-comment">
      <div class="content comment-container">
        <CommentHeader hash={hash} posterName={author} createdAt={issue.createdAt} />
        <CommentBody bodyHtml={bodyHtml} />
      </div>
    </div>
  );
}

/** A timeline user comment (`comments.tmpl` type 0, `#issuecomment-{id}`). */
function TimelineCommentCard(props: { entry: Extract<TimelineEntry, { kind: "comment" }> }) {
  const { comment, posterName, bodyHtml } = props.entry;
  const hash = `issuecomment-${comment.id}`;
  return (
    <div id={hash} class="timeline-item comment">
      <div class="content comment-container">
        <CommentHeader hash={hash} posterName={posterName} createdAt={comment.createdAt} />
        <CommentBody bodyHtml={bodyHtml} />
      </div>
    </div>
  );
}

/** A lifecycle event line (`comments.tmpl` types 1/2/28): the colored badge
 *  (close carries the 2-path octicon-issue-closed since the wave-4
 *  multi-path Icon) and the upstream verb with the `#event-{id}` time
 *  anchor. */
function TimelineEvent(props: { data: IssueDetailData; entry: Extract<TimelineEntry, { kind: "reopen" | "close" | "merge" }> }) {
  const { issue, pr } = props.data;
  const { kind, comment, posterName } = props.entry;
  const hash = `event-${comment.id}`;
  const verb =
    kind === "merge"
      ? null
      : kind === "reopen"
        ? issue.isPull
          ? issueDetailLocale.reopened_pull
          : issueDetailLocale.reopened_issue
        : issue.isPull
          ? issueDetailLocale.closed_pull
          : issueDetailLocale.closed_issue;
  const badge =
    kind === "reopen" ? (
      <Icon name="octicon-dot-fill" />
    ) : kind === "merge" ? (
      <Icon name="octicon-git-merge" />
    ) : (
      <Icon name="octicon-issue-closed" />
    );
  const badgeColor = kind === "reopen" ? "tw-bg-green" : kind === "merge" ? "tw-bg-purple" : "tw-bg-red";
  return (
    <div id={hash} class="timeline-item event">
      <span class={`badge ${badgeColor} tw-text-white`}>{badge}</span>
      <span class="comment-text-line">
        {posterName !== null ? <>{posterName}{" "}</> : null}
        {kind === "merge" ? (
          <>
            {issueDetailLocale.merged_commit} <b>{comment.commitSha === null || comment.commitSha === "" ? "" : comment.commitSha.slice(0, 10)}</b>{" "}
            {issueDetailLocale.merged_into} <b>{pr?.baseBranch ?? ""}</b>
          </>
        ) : (
          verb
        )}{" "}
        {comment.createdAt !== null ? (
          <a id={hash} href={`#${hash}`}>
            <TimeSince unixSeconds={unixSeconds(comment.createdAt)} tz="+0000" />
          </a>
        ) : null}
      </span>
    </div>
  );
}

/** The reduced merge box (`pull_merge_box.tmpl` shape, summary-only): open
 *  PRs get the cached-mergeability line; the merge FORM is a write action
 *  and its Vue island needs pageData — neither lands this wave. */
function PullMergeBox(props: { data: IssueDetailData }) {
  const { issue, pr, mergeable } = props.data;
  if (pr === null) return null;
  const text = hasWorkInProgressPrefix(issue.title)
    ? issueDetailLocale.merge_box_wip
    : mergeable === true
      ? issueDetailLocale.merge_box_mergeable
      : mergeable === false
        ? issueDetailLocale.merge_box_conflict
        : issueDetailLocale.merge_box_checking;
  return (
    <div class="timeline-item comment pull-merge-box">
      <div class="timeline-avatar">
        <Icon name="octicon-git-merge" size={40} />
      </div>
      <div class="content">
        <div class="ui segment fitted avatar-content-left-arrow">
          <div class="merge-section flex-divided-list items-px-default">
            <div class="item flex-left-right">
              <div class="flex-text-block">{text}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The reduced sidebar (`view_content/sidebar.tmpl`): the labels list
 *  (badges linking into the live list filters) and the milestone (plain
 *  text — `/milestone/{id}` is a dead page). The edit dropdowns behind the
 *  upstream section headings are write actions — not rendered (§2.5). */
function IssueSidebar(props: { repoLink: string; data: IssueDetailData }) {
  const { labels, milestone, issue } = props.data;
  const listBase = `${props.repoLink}/${issue.isPull ? "pulls" : "issues"}`;
  return (
    <div class="issue-content-right ui segment">
      <div class="issue-sidebar-combo" data-selection-mode="multiple" data-update-algo="diff">
        <div class="fixed-text muted">
          <strong>{issueDetailLocale.labels}</strong>
        </div>
        <div class="ui list labels-list">
          {labels.length === 0 ? (
            <span class="item empty-list">{issueDetailLocale.no_labels}</span>
          ) : (
            labels.map((label) => (
              <a class="item" href={`${listBase}?labels=${label.id}`}>
                <LabelBadge label={label} />
              </a>
            ))
          )}
        </div>
      </div>
      <div class="divider" />
      <div class="issue-sidebar-combo" data-selection-mode="single" data-update-algo="all">
        <div class="fixed-text muted">
          <strong>{issueDetailLocale.milestone}</strong>
        </div>
        <div class="ui list muted-links flex-items-block">
          {milestone === null ? (
            <span class="item empty-list">{issueDetailLocale.no_milestone}</span>
          ) : (
            <span class="item">
              <Icon name="octicon-milestone" size={18} class="tw-shrink-0" />
              <span class="tw-flex-1 tw-break-anywhere">{milestone.name}</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderIssueDetailPage(ctx: UiContext, data: IssueDetailData): string {
  return renderPage(<IssueDetailPage ctx={ctx} data={data} />);
}

/** The issue/PR detail page (§2.4.1 discriminator: `repository view issue
 *  pull` — upstream view.tmpl:4 emits both classes unconditionally). */
export function IssueDetailPage(props: { ctx: UiContext; data: IssueDetailData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("IssueDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const showMergeBox = data.pr !== null && !data.issue.isClosed && !data.pr.hasMerged;
  return (
    <BaseLayout
      ctx={ctx}
      title={`#${data.issue.index} - ${data.issue.title}`}
      pageClass="repository view issue pull"
      activeTab={data.urlKind === "pulls" ? "pulls" : "issues"}
    >
      <div class="ui container">
        <IssueTitleBar data={data} />
        <div class="issue-content">
          <div class="issue-content-left">
            <div class="comment-list">
              <RootComment data={data} />
              {data.timeline.map((entry) =>
                entry.kind === "comment" ? (
                  <TimelineCommentCard entry={entry} />
                ) : (
                  <TimelineEvent data={data} entry={entry} />
                ),
              )}
              <div class="timeline-item tw-hidden" id="timeline-comments-end" />
              {showMergeBox ? <PullMergeBox data={data} /> : null}
            </div>
          </div>
          <IssueSidebar repoLink={repoLink} data={data} />
        </div>
      </div>
    </BaseLayout>
  );
}
