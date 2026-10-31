/**
 * The mail notify hub (specs/email-outbound.md §1.3 first surface) — the port
 * of upstream's mail notifier arm over the landed outbox:
 *
 *   - upstream's seam: the `Notifier` interface's mail receiver
 *     (services/mailer/notify.go — `mailNotifier`) fires per write event;
 *     the comment arm (`CreateIssueComment`, notify.go:31-51) maps a type-0
 *     comment to `ActionCommentIssue` and calls `MailParticipantsComment`
 *     (services/mailer/mail_comment.go:19-40), which funnels into the shared
 *     recipient resolution `mailIssueCommentToParticipants`
 *     (services/mailer/mail_issue.go:28-120) and the per-recipient compose
 *     `composeIssueCommentMessages` (services/mailer/mail_issue_common.go:
 *     47-215) — one independent `Message` per recipient ("Make sure to
 *     compose independent messages to avoid leaking user emails",
 *     mail_issue_common.go:143).
 *   - our shape: ONE enqueue-shape entry per notify event. Each resolved
 *     recipient gets one `email_outbox` row (the single-recipient `to_addr`
 *     is the schema's leak prevention, SPEC §4.1) plus one `{kind:
 *     "mail-outbox"}` queue message; the consumer arm needs no change (the
 *     outbox row is transport-agnostic). The remaining notify surfaces are
 *     additive entries against the same core — the recipient resolution and
 *     the compose below are exactly upstream's shared middle, so
 *     `NewIssue` / `IssueChangeStatus` (notify.go:53-76) and
 *     `NewPullRequest` (:88-93) are thin wrappers passing a different
 *     action type and `comment = null` (all three landed here; slice four
 *     records the pull arm in SPEC §10 — its one unique behavior is the
 *     repo-watcher WIP-gate exception, mail_issue.go:67-76). Slice five adds
 *     the next two file-order arms: `IssueChangeTitle` (:80-90, the WIP →
 *     ready-for-review rename mail over the same funnel, SPEC §11) and
 *     `IssueChangeAssignee` (:119-127, the assigned mail — the one arm whose
 *     recipient is NOT the participants resolution, SPEC §12).
 *
 * The emit sites are the real write paths (`IssuesService.addComment` /
 * `createIssue` / `closeIssue`+`reopenIssue` — upstream fires notify from
 * the model layer too: CreateIssueComment's notify call rides the
 * comment-create service, NewIssue's rides the issue-create service and
 * IssueChangeStatus's the state-transition service, never the router).
 * Failures are logged, never propagated (upstream logs at the receiver,
 * notify.go:48-50 `log.Error("MailParticipantsComment: %v", err)`); the
 * write stays committed.
 *
 * Documented reductions (all schema-absent, SPEC §8):
 *   - mentions: LIFTED (SPEC §13) — the parser + visibility resolution
 *     landed in services/mentions/ (upstream's references.
 *     FindAllMentionsMarkdown + ResolveIssueMentionsByVisibility, ported at
 *     the pin) and every batch arm carries a `mentions` parameter; the
 *     mention users ride the resolution FIRST with the onmention allowance
 *     (mail_issue.go:99-102, :135-137), exactly upstream's `mentions
 *     []*User` batches. Still schema-absent: the issue_user.is_mentioned
 *     CARRIER (upstream's mention persistence, issue_update.go:567 —
 *     HANDOFF; a mention never touches issue_watch, so no subscription row
 *     is written here either).
 *   - repo-watch modes: LANDED (was the reduction "every watcher gets issue
 *     AND pull mail") — the `repo_watchers` mode + include_* columns
 *     (migration 0053) carry upstream's WatchMode (models/repo/watch.go:
 *     17-50), and the resolution arms below filter per upstream: watchers
 *     gate on include_pull_requests|issues by IsPull (GetRepoWatchersIDs,
 *     watch.go:253-258), the custom-watch set (GetRepoCustomWatchersIDs,
 *     :260-264) feeds the onmention allowance of the batch filter
 *     (mail_issue.go:141-146), and ignorers (mode=Dont) join `visited`
 *     ahead of everything (GetRepoIgnorersIDs, mail_issue.go:87-92).
 *   - upstream's `emoji.ReplaceAliases` on the subject
 *     (mail_issue_common.go:133) — no alias table ported.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  issueAssignees,
  issues,
  issueSubscriptions,
  repoWatchers,
  userSettings,
  users,
} from "../../db/schema";
import { hasWorkInProgressPrefix } from "../../api/services/issues";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import {
  doerRepoAccessMode,
  findRepositoryById,
  type RepositoryRow,
  type RepositoryWithOwner,
  type UserRow,
} from "../../api/services/repository";
import { WatchMode } from "../../api/services/repo-watchers";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { CommentType } from "../../issues/comment-types";
import { appDomainFromAppUrl, parseMailFrom, sanitizeSubject } from "./message";
import { enqueueMailOutbox, type EnqueueOutcome, type MailOutboxEnv } from "./outbox";
import { appUrlWithSlash, GITEA_APP_NAME, isMailable } from "./register-notify";
import {
  displayNameWithFullName,
  issueActionCloseLine,
  issueActionNewLine,
  issueActionReadyForReviewLine,
  issueActionReopenLine,
  issueMailFallbackSubject,
  renderIssueActionMail,
  renderIssueAssignedMail,
  renderIssueCommentMail,
} from "./templates";

/** The issue row the arm composes over (schema-derived; no issues/service
 *  import — the emit site imports US). */
type IssueMailRow = typeof issues.$inferSelect;
type CommentMailRow = typeof comments.$inferSelect;

/**
 * The notify-event vocabulary — upstream's `Notifier` method names
 * (services/notify/notifier.go). The issue-thread arms land here
 * (CreateIssueComment notify.go:31-51, NewIssue :53-58, IssueChangeStatus
 * :59-76, IssueChangeTitle :80-90, NewPullRequest :88-93,
 * IssueChangeAssignee :119-127); the rest are the additive entries SPEC
 * §1.3 enumerates (each lands as a thin wrapper over the same resolution +
 * compose core below).
 */
export type MailNotifyEvent =
  | "CreateIssueComment"
  | "NewIssue"
  | "IssueChangeStatus"
  | "IssueChangeTitle"
  | "NewPullRequest"
  | "IssueChangeAssignee";

/** The env slice the hub reads (both bindings ride the outbox). */
export type MailNotifyEnv = Pick<MailOutboxEnv, "DB" | "REPO_TASKS" | "APP_URL"> & {
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
};

export interface NotifyIssueCommentInput {
  /** The comment's issue row (the mail's subject/link subject). */
  issue: IssueMailRow;
  /** The created comment row (type 0 — the plain-comment arm). */
  comment: CommentMailRow;
  /** The comment's poster (upstream `Comment.Poster` = the doer). */
  doer: UserRow;
  /** The comment content's resolved mentions (upstream's
   *  `mentions []*User` — FindAndUpdateIssueMentions' result passed to
   *  notify.CreateIssueComment, services/issue/comments.go:81-101). */
  mentions?: UserRow[];
}

export type MailNotifyOutcome =
  | { outcome: "disabled" }
  | { outcome: "misconfigured"; message: string }
  | { outcome: "no-recipients" }
  | { outcome: "enqueued"; recipientIds: number[]; enqueue: EnqueueOutcome[] };

/** `Issue.HTMLURL` (models/issues/issue.go:386-394: `Repo.HTMLURL()` +
 *  "/issues|pulls" + "/" + index — the origin arrives in upstream AppUrl's
 *  trailing-slash form, so the join absorbs it). */
function issueMailUrl(origin: string, owner: string, slug: string, isPull: boolean, index: number): string {
  return `${origin}${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${isPull ? "pulls" : "issues"}/${index}`;
}

/** `Comment.HashTag` anchor (models/issues/comment.go:554-556). */
function commentAnchor(commentId: number): string {
  return `issuecomment-${commentId}`;
}

/** Upstream `fromDisplayName` (services/mailer/mail.go:157-175) — the
 *  default template: `FullName (username)` when a full name is set, else the
 *  username. The MIME Q-encode half is the SPEC §5.6 divergence (relay
 *  carries UTF-8). */
function mailFromDisplayName(user: UserRow): string {
  const fullName = (user.fullName ?? "").trim();
  return fullName === "" ? user.username : `${fullName} (${user.username})`;
}

/** `generateMessageIDForIssue` (mail_issue_common.go:280-305) —
 *  `<owner/repo/issues|pulls/#index[/comment/<id>]@AppDomain>`; the
 *  close/reopen timestamp suffix lives in `issueActionMessageId`. */
function issueMessageId(
  repoPath: string,
  isPull: boolean,
  index: number,
  appDomain: string,
  commentId?: number,
): string {
  const path = isPull ? "pulls" : "issues";
  const extra = commentId === undefined ? "" : `/comment/${commentId}`;
  return `<${repoPath}/${path}/${index}${extra}@${appDomain}>`;
}

/** `generateMessageIDForIssue`'s close/reopen extras (mail_issue_common.go:
 *  286-293 — ActionCloseIssue/ClosePullRequest → `/close/<unixMilli>`,
 *  ActionReopenIssue/ReopenPullRequest → `/reopen/<unixMilli>`,
 *  ActionPullRequestReadyForReview → `/ready/<unixMilli>` :303-304): every
 *  status mail's Message-ID is distinct across repeated close/reopen cycles
 *  over one issue (upstream's own uniqueness mechanism — the pin's test at
 *  mail_test.go:446/:462 asserts exactly the `/close/` and `/reopen/`
 *  prefixes). The "new" arm has NO extra (ActionCreateIssue falls through
 *  the switch, mail_test.go:407-418), so it reuses `issueMessageId` plain. */
function issueActionMessageId(
  repoPath: string,
  isPull: boolean,
  index: number,
  appDomain: string,
  action: "close" | "reopen" | "ready",
  unixMilli: number,
): string {
  const path = isPull ? "pulls" : "issues";
  return `<${repoPath}/${path}/${index}/${action}/${unixMilli}@${appDomain}>`;
}

/**
 * The per-recipient metadata headers — `generateAdditionalHeadersForIssue`
 * (mail_issue_common.go:307-321) over `generateMetadataHeaders` (mail.go:
 * 180-198), `generateSenderRecipientHeaders` (mail.go:200-208) and
 * `generateReasonHeaders` (mail.go:210-216). Every header the family sets is
 * single-valued, so the row's `Record<string, string>` storage holds it
 * whole (SPEC §4.4). `References`/`List-Unsubscribe` carry only the
 * no-incoming-email arm of upstream's lists (the reply/mailto tokens ride
 * `IncomingEmail`, mail_issue_common.go:181-202 — not landed).
 */
function issueMailHeaders(input: {
  repoPath: string;
  repoName: string;
  repoHtmlUrl: string;
  issueUrl: string;
  issueIndex: number;
  isPull: boolean;
  appDomain: string;
  sender: UserRow;
  recipient: UserRow;
}): Record<string, string> {
  const reason = input.isPull ? "pull" : "issue";
  const owner = input.repoPath.split("/")[0]!;
  return {
    // generateMetadataHeaders (mail.go:180-198)
    "List-ID": `${input.repoPath} <${input.repoName}.${owner}.${input.appDomain}>`,
    "List-Archive": `<${input.repoHtmlUrl}>`,
    "X-Mailer": "Gitea",
    "X-Gitea-Repository": input.repoName,
    "X-Gitea-Repository-Path": input.repoPath,
    "X-Gitea-Repository-Link": input.repoHtmlUrl,
    "X-GitLab-Project": input.repoName,
    "X-GitLab-Project-Path": input.repoPath,
    // generateSenderRecipientHeaders (mail.go:200-208)
    "X-Gitea-Sender": input.sender.username,
    "X-Gitea-Recipient": input.recipient.username,
    "X-Gitea-Recipient-Address": input.recipient.email ?? "",
    "X-GitHub-Sender": input.sender.username,
    "X-GitHub-Recipient": input.recipient.username,
    "X-GitHub-Recipient-Address": input.recipient.email ?? "",
    // generateReasonHeaders (mail.go:210-216)
    "X-Gitea-Reason": reason,
    "X-GitHub-Reason": reason,
    "X-GitLab-NotificationReason": reason,
    // the issue-specific trio (mail_issue_common.go:316-318)
    "X-Gitea-Issue-ID": String(input.issueIndex),
    "X-Gitea-Issue-Link": input.issueUrl,
    "X-GitLab-Issue-IID": String(input.issueIndex),
  };
}

/** Union-by-first-occurrence in the caller's source order (upstream's
 *  container.Set dedupe, mail_issue.go:85). */
function unionIds(...sources: number[][]): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const source of sources) {
    for (const id of source) {
      if (id <= 0 || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * `mailIssueCommentToParticipants`' recipient resolution port
 * (mail_issue.go:28-120) over our tables, upstream's source order: repo
 * watchers (built first, mail_issue.go:67-76 — upstream appends them ahead
 * of the accumulated slice), then poster, assignees, participants, issue
 * watchers. Filters, in upstream order:
 *   - the unit enabled (upstream `perm.CanRead(unit)` folds the unit's
 *     enabled state into the access check; ours reads the landed
 *     repo-settings flags — false excludes everyone upstream-shaped, so it
 *     is checked once here);
 *   - the repo-watch MODE arms (see the watcher block below): include-flag
 *     gate by IsPull, the custom-watch onmention allowance, ignorers into
 *     `visited` ahead of everything;
 *   - `GetMailableUsersByIDs` (models/user/user.go) prefilter: individual,
 *     active, preference enabled/andyourown — plus onmention when a custom
 *     watch exists (user.go:1157-1179's isMention arm) — folded with the
 *     batch filter (mail_issue.go:141-146) into the preference gate below;
 *     the email half of `IsMailable`. The preference rides the typed
 *     `user_settings` side store (the SPEC user-notification-settings
 *     collapse; an absent row IS upstream's 'enabled' default, admin.go:32)
 *     — the LEFT JOIN + default mirrors the upstream column read;
 *   - the doer excluded unless their preference is andyourown
 *     (mail_issue.go:94-97);
 *   - explicit issue unwatchers excluded (mail_issue.go:104-109);
 *   - `CheckRepoUnitUser` (models/perm/access/repo_permission.go:660-672):
 *     site admin always; a public repo reads to everyone; a private repo
 *     needs a grant — our single grant predicate `doerRepoAccessMode` ≠ none
 *     (the repo_permission.go:448-508 grant fold, per its header).
 * Zero survivors ⇒ the caller skips mail entirely (the empty batch arm —
 * mailIssueCommentBatch over no users sends nothing).
 */
export async function resolveIssueMailRecipients(
  d1: D1Database,
  input: {
    issue: Pick<IssueMailRow, "id" | "repoId" | "posterId" | "isPull" | "title">;
    repo: Pick<RepositoryRow, "id" | "ownerId" | "visibility">;
    doer: UserRow;
    /** The mailIssueCommentToParticipants create-arm exception
     *  (mail_issue.go:67-76): upstream's gate is
     *  `IsPull && IsWorkInProgress && ActionType != ActionCreatePullRequest`,
     *  so the PULL-CREATE mail keeps the repo watchers even on a WIP pull
     *  (the create mail is the notification that tells them a PR exists);
     *  every other pull arm drops them. `IsWorkInProgress` recomputes from
     *  the title prefix (models/issues/pull.go:652-658) — the landed
     *  `hasWorkInProgressPrefix` proxy. */
    pullCreate?: boolean;
    /** The resolved mention users (services/mentions — upstream's
     *  `mentions []*User`, resolved by the WRITE service before the notify
     *  fires, services/issue/comments.go:81). They ride FIRST in the union
     *  (the mention batch mails before the participants batch,
     *  mail_issue.go:99-102 vs :115) and alone unlock the onmention
     *  preference (:135-137's `fromMention` arm); the visited semantics
     *  are batch-1's — ignorers and the doer still exclude, explicit
     *  issue-unwatchers do NOT (the unwatcher block joins visited after
     *  the mention batch, :104-109). */
    mentions?: UserRow[];
  },
): Promise<UserRow[]> {
  const db = drizzle(d1);

  // The unit-enabled gate — one read (upstream's CanRead(unit) unit half).
  const settings = await loadRepoSettings(d1, input.repo.id);
  if (input.issue.isPull ? !settings.hasPullRequests : !settings.hasIssues) {
    return [];
  }

  // =========== Repo watchers + ignorers (mail_issue.go:67-92), from ONE row
  // read of the mode-carrying `repo_watchers` (upstream runs three queries:
  // GetRepoWatchersIDs watch.go:266-292, GetRepoCustomWatchersIDs :260-264,
  // GetRepoIgnorersIDs :244-251 — the partition below is their exact
  // predicate set over the same rows):
  //   - ignorers: mode = Dont — collected ALWAYS (upstream's ignorers block
  //     sits OUTSIDE the WIP `if`), joined into `visited` below ahead of
  //     every other source ("muting the repository outranks every other
  //     source, including mentions", mail_issue.go:85-92);
  //   - watchers: mode <> Dont AND include_<type> (type = pull_requests |
  //     issues by IsPull) — gated by the WIP arm (mail_issue.go:67-76, the
  //     ActionCreatePullRequest exception: false for the create arm);
  //   - the custom set (customOnly, watch.go:283-289): watchers matching
  //     `mode = Custom OR any include false`. NOT a recipient source — an
  //     enabled-preference custom watcher already rides the watcher arm —
  //     it is the onmention allowance in the batch filter
  //     (mail_issue.go:141-146), folded into the preference gate below.
  //     The WIP arm skips BOTH watcher queries upstream, so the set stays
  //     empty there (no allowance) while ignorers still visit.
  const wipGate =
    input.issue.isPull && hasWorkInProgressPrefix(input.issue.title) && !input.pullCreate;
  const repoWatchRows = await db
    .select({
      userId: repoWatchers.userId,
      mode: repoWatchers.mode,
      includePullRequests: repoWatchers.includePullRequests,
      includeIssues: repoWatchers.includeIssues,
      includeReleases: repoWatchers.includeReleases,
    })
    .from(repoWatchers)
    .where(eq(repoWatchers.repoId, input.issue.repoId))
    .all();
  const ignorerIds = new Set<number>();
  const customWatcherIds = new Set<number>();
  const repoWatcherIds: number[] = [];
  for (const watch of repoWatchRows) {
    if (watch.mode === WatchMode.Dont) {
      ignorerIds.add(watch.userId);
      continue;
    }
    if (wipGate) continue;
    if (!(input.issue.isPull ? watch.includePullRequests : watch.includeIssues)) continue;
    repoWatcherIds.push(watch.userId);
    if (watch.mode === WatchMode.Custom || !watch.includePullRequests || !watch.includeIssues || !watch.includeReleases) {
      customWatcherIds.add(watch.userId);
    }
  }

  // =========== Original poster (mail_issue.go:43-44) ===========
  const posterIds = input.issue.posterId === null ? [] : [input.issue.posterId];

  // =========== Assignees (mail_issue.go:46-51) ===========
  const assigneeIds = (
    await db.select({ id: issueAssignees.assigneeId }).from(issueAssignees).where(eq(issueAssignees.issueId, input.issue.id)).all()
  ).map((row) => row.id);

  // =========== Participants (mail_issue.go:53-58) —
  // GetParticipantsIDsByIssueID (models/issues/issue.go:620-627): DISTINCT
  // poster over comment types Comment(0)/Code(21)/Review(22); poster_id is
  // nullable in our schema (system comments), nulls are not participants.
  const participantIds = (
    await db
      .selectDistinct({ id: comments.posterId })
      .from(comments)
      .where(
        and(
          eq(comments.issueId, input.issue.id),
          inArray(comments.type, [CommentType.Comment, CommentType.Code, CommentType.Review]),
        ),
      )
      .all()
  )
    .map((row) => row.id)
    .filter((id): id is number => id !== null);

  // =========== Issue watchers (mail_issue.go:60-65) ===========
  const issueWatcherIds = (
    await db
      .select({ id: issueSubscriptions.userId })
      .from(issueSubscriptions)
      .where(and(eq(issueSubscriptions.issueId, input.issue.id), eq(issueSubscriptions.isWatching, true)))
      .all()
  ).map((row) => row.id);

  // =========== Mentions (mail_issue.go:99-102, the FIRST batch) ===========
  // Resolved upstream by the write service (FindAndUpdateIssueMentions) and
  // handed to the notify receiver; the batch filter below is where their
  // onmention allowance lives. First in the union = the send order.
  const mentionIdSet = new Set<number>((input.mentions ?? []).map((user) => user.id));

  const orderedIds = unionIds([...mentionIdSet], repoWatcherIds, posterIds, assigneeIds, participantIds, issueWatcherIds);
  if (orderedIds.length === 0) return [];

  // The GetMailableUsersByIDs prefilter, preference half through the typed
  // `user_settings` side store (absent row = upstream's 'enabled' default,
  // admin.go:32 — the LEFT JOIN + coalesce is the column read's shape here).
  const candidates = await db
    .select({ user: users, pref: userSettings.emailNotificationsPreference })
    .from(users)
    .leftJoin(userSettings, eq(userSettings.userId, users.id))
    .where(inArray(users.id, orderedIds))
    .all();
  const byId = new Map<number, UserRow>();
  for (const row of candidates) {
    if (!isMailable(row.user)) continue;
    const pref = row.pref ?? "enabled";
    // The batch filter (mail_issue.go:141-146), folding upstream's two
    // layers: GetMailableUsersByIDs' prefilter admits enabled/andyourown —
    // plus onmention when ANY custom watcher exists (user.go:1157-1179's
    // `isMention` arm) — and the per-recipient batch then requires
    // enabled/andyourown OR (onmention AND (mentioned OR custom watcher)).
    // Mentions stay unported (the §8.2 reduction), so an onmention user
    // passes exactly when they hold a custom watch (`customWatcherIds`).
    if (pref === "disabled") continue;
    // The batch filter's onmention allowance (mail_issue.go:135-137):
    // `onmention && (fromMention || customWatchers.Contains(id))` — the
    // mention ids ARE the fromMention batch, a custom watch the other arm.
    if (pref === "onmention" && !customWatcherIds.has(row.user.id) && !mentionIdSet.has(row.user.id)) continue;
    byId.set(row.user.id, row.user);
  }

  // visited: the ignorers FIRST (mail_issue.go:87-92 — muting outranks
  // every other source), then the explicit unwatchers (:104-109) + the doer
  // (:94-97).
  const visited = new Set<number>(ignorerIds);
  for (const row of (
    await db
      .select({ id: issueSubscriptions.userId })
      .from(issueSubscriptions)
      .where(and(eq(issueSubscriptions.issueId, input.issue.id), eq(issueSubscriptions.isWatching, false)))
      .all()
  )) {
    visited.add(row.id);
  }
  const doerPref = (
    await db.select().from(userSettings).where(eq(userSettings.userId, input.doer.id)).get()
  )?.emailNotificationsPreference ?? "enabled";
  if (doerPref !== "andyourown") {
    visited.add(input.doer.id);
  }

  const publicRepo = input.repo.visibility === "public";
  const recipients: UserRow[] = [];
  for (const id of orderedIds) {
    if (visited.has(id)) {
      // Mention ids ride the batch-1 visited (mail_issue.go:85-97 —
      // ignorers + the doer only); the explicit-unwatcher block joins
      // visited AFTER the mention batch (:104-109), so a mention who is
      // ONLY an explicit unwatcher still receives the mention mail.
      if (!mentionIdSet.has(id) || ignorerIds.has(id) || (id === input.doer.id && doerPref !== "andyourown")) {
        continue;
      }
    }
    const user = byId.get(id);
    if (user === undefined) continue; // not mailable at the prefilter
    // CheckRepoUnitUser (repo_permission.go:660-672): admin short-circuit,
    // public reads to everyone, private needs a grant.
    if (!(user.isAdmin || publicRepo || (await doerRepoAccessMode(d1, input.repo, user.id)) !== "none")) {
      continue;
    }
    recipients.push(user);
  }
  return recipients;
}

/**
 * The arms' shared prelude — the master gate (SPEC §5.1, upstream
 * `setting.MailService == nil`), the MAIL_FROM parse (§5.2) and the repo
 * pair load (upstream loads the repo before composing, mail_issue.go:30-32;
 * a missing row logs and skips — the push-wave degradation rule). `mailName`
 * names the arm in both log lines; notifyIssueComment's landed messages are
 * byte-identical through it.
 */
type MailArmPrelude =
  | { ok: false; outcome: MailNotifyOutcome }
  | { ok: true; from: { displayName: string; address: string }; pair: RepositoryWithOwner };

async function mailArmPrelude(env: MailNotifyEnv, mailName: string, warnDetail: string, repoId: string): Promise<MailArmPrelude> {
  if (env.MAIL_ENABLED !== "true") return { ok: false, outcome: { outcome: "disabled" } };
  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) {
    const message = `[mail] MAIL_ENABLED=true but MAIL_FROM is missing or unparseable; skipping ${warnDetail}`;
    console.warn(message);
    return { ok: false, outcome: { outcome: "misconfigured", message } };
  }
  const pair = await findRepositoryById(env.DB, repoId);
  if (pair === null) {
    console.error(`[mail] ${mailName} skipped: repository row missing [id: ${repoId}]`);
    return { ok: false, outcome: { outcome: "no-recipients" } };
  }
  return { ok: true, from, pair };
}

/**
 * The `CreateIssueComment` arm's mail (notify.go:31-51 →
 * MailParticipantsComment → mailIssueCommentToParticipants →
 * composeIssueCommentMessages). Gate → resolve → compose → outbox, never
 * throwing for disabled/misconfigured/no-recipients (the register-notify
 * posture); only a D1 failure propagates and the emit site catches it.
 * `input.mentions` is the write service's FindAndUpdateIssueMentions result
 * (services/issue/comments.go:81's shape) — the mention batch rides first.
 */
export async function notifyIssueComment(
  env: MailNotifyEnv,
  input: NotifyIssueCommentInput,
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  const pre = await mailArmPrelude(env, "issue-comment mail", `issue-comment mail for comment ${input.comment.id}`, input.issue.repoId);
  if (!pre.ok) return pre.outcome;
  const { from, pair } = pre;

  const recipients = await resolveIssueMailRecipients(env.DB, {
    issue: input.issue,
    repo: pair.repo,
    doer: input.doer,
    mentions: input.mentions,
  });
  if (recipients.length === 0) return { outcome: "no-recipients" };

  // ---- compose (composeIssueCommentMessages' used slice) ----
  const repoPath = `${pair.repo.ownerNamespace}/${pair.repo.slug}`;
  const origin = appUrlWithSlash(env.APP_URL);
  const appDomain = appDomainFromAppUrl(env.APP_URL);
  const repoHtmlUrl = `${origin}${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const issueUrl = issueMailUrl(origin, pair.repo.ownerNamespace, pair.repo.slug, input.issue.isPull, input.issue.index);
  const link = `${issueUrl}#${commentAnchor(input.comment.id)}`;
  // The subject: prefix "Re: " (actName != "new", mail_issue_common.go:88-90)
  // + the fallback; stored UNSANITIZED (SPEC §4.2), sanitized at consume.
  const subject = `Re: ${issueMailFallbackSubject(repoPath, input.issue.title, input.issue.index)}`;
  const sanitized = sanitizeSubject(subject);
  // The body: the comment content rendered with absolute links
  // (mail_issue_common.go:71-72, WithUseAbsoluteLink(true) → AppUrl origin;
  // the repo-comment context is our "comment" render mode).
  const bodyHtml = renderMarkdownToHtml({
    text: input.comment.content ?? "", // our column is nullable; upstream's Content is ""
    mode: "comment",
    context: repoPath,
    wiki: false,
    origin,
  });
  const fromDisplayName = mailFromDisplayName(input.doer);
  const messageId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain, input.comment.id);
  const threadId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain);
  // Upstream `msg.Info = "Subject: %s, %s"` with the batch info "issue
  // comments" (mail_issue.go:159, mail_issue_common.go:173).
  const info = `Subject: ${sanitized}, issue comments`;

  const enqueue: EnqueueOutcome[] = [];
  const recipientIds: number[] = [];
  for (const recipient of recipients) {
    recipientIds.push(recipient.id);
    enqueue.push(
      await enqueueMailOutbox(
        env,
        {
          info,
          fromAddress: from.address,
          fromDisplayName,
          toAddr: recipient.email!,
          replyTo: null, // the Reply-To arm rides IncomingEmail (not landed)
          subject,
          bodyHtml: renderIssueCommentMail({
            subject: sanitized,
            bodyHtml,
            link,
            issueIndex: input.issue.index,
            appName: GITEA_APP_NAME,
            appUrl: origin,
          }),
          headers: JSON.stringify({
            "Message-ID": messageId,
            "In-Reply-To": threadId,
            References: threadId,
            "List-Unsubscribe": `<${issueUrl}>`,
            ...issueMailHeaders({
              repoPath,
              repoName: pair.repo.slug,
              repoHtmlUrl,
              issueUrl,
              issueIndex: input.issue.index,
              isPull: input.issue.isPull,
              appDomain,
              sender: input.doer,
              recipient,
            }),
          }),
          dedupeKey: `issue-comment:${input.comment.id}:${recipient.id}`,
        },
        options,
      ),
    );
  }
  return { outcome: "enqueued", recipientIds, enqueue };
}

/** The comment-nil arms' input (upstream `mailComment` with `Comment: nil`,
 *  mail_issue.go:188-198). */
interface NotifyIssueArmInput {
  issue: IssueMailRow;
  /** The mail's doer — issue.Poster for NewIssue (notify.go:55) AND for
   *  NewPullRequest (notify.go:89 `pr.Issue.Poster`), the actor for
   *  IssueChangeStatus (notify.go:76). */
  doer: UserRow;
  /** actionToTemplate's name for the arm (mail_issue_common.go:227-246):
   *  ActionCreateIssue AND ActionCreatePullRequest → "new";
   *  ActionCloseIssue|ClosePullRequest → "close";
   *  ActionReopenIssue|ReopenPullRequest → "reopen" (IsPull picks the
   *  activities constant, not the name — notify.go:63-73);
   *  ActionPullRequestReadyForReview → "ready_for_review" (:248). */
  actionName: "new" | "close" | "reopen" | "ready_for_review";
  /** MailParticipants' content rule (mail_issue.go:179-185): the issue
   *  content for "new" AND "ready_for_review" (ActionCreatePullRequest is
   *  NOT in the empty list; neither is ActionPullRequestReadyForReview);
   *  "" for close/reopen (upstream empties it). */
  content: string;
  /** The dedupe-key family (SPEC §8.3's trigger-level idempotency). */
  dedupePrefix: "issue-new" | "issue-status" | "pull-new" | "pull-ready";
  /** The pull-create arm's repo-watcher WIP-gate exception (the
   *  resolveIssueMailRecipients flag, mail_issue.go:67-76). */
  pullCreate?: boolean;
  /** The content's resolved mentions (upstream `mentions []*User`): the
   *  create arms pass FindAndUpdateIssueMentions' result (services/issue/
   *  issue.go:68, services/pull/pull.go:184); the status/title arms pass
   *  none (services/issue/status.go:43/:56, issue.go:127 — no content
   *  parses there). */
  mentions?: UserRow[];
}

/**
 * The comment-nil arm compose — the shared middle behind NewIssue,
 * IssueChangeStatus and NewPullRequest: `MailParticipants`
 * (mail_issue.go:173-202) with `Comment: nil` →
 * `mailIssueCommentToParticipants` (the same resolution core the comment
 * arm uses) → `composeIssueCommentMessages` over the default.tmpl
 * non-comment branches. Differences from the comment arm, all pinned:
 *   - link = `Issue.HTMLURL`, no anchor (mail_issue_common.go:60-64 —
 *     Comment nil);
 *   - subject prefix "Re: " only when actName != "new" (:88-91) — the new
 *     mail is the thread's root;
 *   - Message-ID: "new" carries NO extra (mail_issue_common.go:285-294's
 *     switch has no ActionCreateIssue/ActionCreatePullRequest case — the
 *     mail_test.go:412 "Open Issue" and :417-422 "Open Pull" fixtures pin
 *     the plain `<owner/repo/issues|pulls/#idx@domain>`); close/reopen
 *     carry `/close|reopen/<unixMilli>` (the :446/:462 fixtures);
 *   - In-Reply-To/References stay the plain thread id for both arms (the
 *     reference is generated with ActionType(0), :165);
 *   - the body is the ISSUE content for new and empty for close/reopen, so
 *     default.tmpl renders the locale action line (`mail.issue.action.*`,
 *     interpolated with DisplayNameWithFullName) instead of a body for
 *     close/reopen and for empty new-issue descriptions;
 *   - info stays "issue comments" (mail_issue.go:159's batch string).
 * Dedupe keys: `issue-new:<issueId>:<recipientId>` /
 * `pull-new:<issueId>:<recipientId>` (issueId is unique — the comment arm's
 * commentId discipline; the pull arm is a DIFFERENT trigger than the issue
 * one, upstream's separate NewPullRequest receiver) and
 * `issue-status:<issueId>:<action>:<unixMilli>:<recipientId>` /
 * `pull-ready:<issueId>:ready_for_review:<unixMilli>:<recipientId>` (the ms
 * rides the key exactly as it rides the Message-ID — repeated close/reopen/
 * ready cycles over one issue must each mail).
 */
async function notifyIssueArm(
  env: MailNotifyEnv,
  input: NotifyIssueArmInput,
  options: { now?: Date },
): Promise<MailNotifyOutcome> {
  const armName = input.pullCreate
    ? "new-pull mail"
    : input.actionName === "new"
      ? "new-issue mail"
      : input.actionName === "ready_for_review"
        ? "ready-for-review mail"
        : "issue-status mail";
  const pre = await mailArmPrelude(env, armName, `${armName} for issue ${input.issue.id}`, input.issue.repoId);
  if (!pre.ok) return pre.outcome;
  const { from, pair } = pre;

  const recipients = await resolveIssueMailRecipients(env.DB, {
    issue: input.issue,
    repo: pair.repo,
    doer: input.doer,
    pullCreate: input.pullCreate,
    mentions: input.mentions,
  });
  if (recipients.length === 0) return { outcome: "no-recipients" };

  // ---- compose (composeIssueCommentMessages' comment-nil slice) ----
  const unixMilli = (options.now ?? new Date()).getTime();
  const repoPath = `${pair.repo.ownerNamespace}/${pair.repo.slug}`;
  const origin = appUrlWithSlash(env.APP_URL);
  const appDomain = appDomainFromAppUrl(env.APP_URL);
  const repoHtmlUrl = `${origin}${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const issueUrl = issueMailUrl(origin, pair.repo.ownerNamespace, pair.repo.slug, input.issue.isPull, input.issue.index);
  const link = issueUrl;
  const prefix = input.actionName === "new" ? "" : "Re: ";
  const subject = `${prefix}${issueMailFallbackSubject(repoPath, input.issue.title, input.issue.index)}`;
  const sanitized = sanitizeSubject(subject);
  // The body: rendered with absolute links like the comment arm
  // (mail_issue_common.go:71-72); "" short-circuits to the template's
  // empty-body branch (markdown.RenderString of "" IS "" — the `eq .Body
  // ""` check keys on the rendered value).
  const bodyHtml =
    input.content === ""
      ? ""
      : renderMarkdownToHtml({
          text: input.content,
          mode: "comment",
          context: repoPath,
          wiki: false,
          origin,
        });
  // The action line: close/reopen/ready_for_review render theirs ALWAYS
  // (default.tmpl's first action chain — close/reopen guaranteed Body == ""
  // by MailParticipants, ready_for_review may carry the kept description
  // alongside); "new" renders its line only when the body is empty (the
  // nested `{{if eq .ActionName "new"}}`).
  const doerDisplay = displayNameWithFullName(input.doer.username, input.doer.fullName);
  const actionLineHtml =
    input.actionName === "close"
      ? issueActionCloseLine(doerDisplay, input.issue.index)
      : input.actionName === "reopen"
        ? issueActionReopenLine(doerDisplay, input.issue.index)
        : input.actionName === "ready_for_review"
          ? issueActionReadyForReviewLine(doerDisplay)
          : bodyHtml === ""
            ? issueActionNewLine(doerDisplay, input.issue.index)
            : null;
  const fromDisplayName = mailFromDisplayName(input.doer);
  const messageId =
    input.actionName === "new"
      ? issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain)
      : issueActionMessageId(
          repoPath,
          input.issue.isPull,
          input.issue.index,
          appDomain,
          input.actionName === "ready_for_review" ? "ready" : input.actionName,
          unixMilli,
        );
  const threadId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain);
  const info = `Subject: ${sanitized}, issue comments`;

  const enqueue: EnqueueOutcome[] = [];
  const recipientIds: number[] = [];
  for (const recipient of recipients) {
    recipientIds.push(recipient.id);
    enqueue.push(
      await enqueueMailOutbox(
        env,
        {
          info,
          fromAddress: from.address,
          fromDisplayName,
          toAddr: recipient.email!,
          replyTo: null, // the Reply-To arm rides IncomingEmail (not landed)
          subject,
          bodyHtml: renderIssueActionMail({
            subject: sanitized,
            actionName: input.actionName,
            bodyHtml,
            actionLineHtml,
            link,
            issueIndex: input.issue.index,
            appName: GITEA_APP_NAME,
            appUrl: origin,
          }),
          headers: JSON.stringify({
            "Message-ID": messageId,
            "In-Reply-To": threadId,
            References: threadId,
            "List-Unsubscribe": `<${issueUrl}>`,
            ...issueMailHeaders({
              repoPath,
              repoName: pair.repo.slug,
              repoHtmlUrl,
              issueUrl,
              issueIndex: input.issue.index,
              isPull: input.issue.isPull,
              appDomain,
              sender: input.doer,
              recipient,
            }),
          }),
          dedupeKey:
            input.dedupePrefix === "issue-new" || input.dedupePrefix === "pull-new"
              ? `${input.dedupePrefix}:${input.issue.id}:${recipient.id}`
              : `${input.dedupePrefix}:${input.issue.id}:${input.actionName}:${unixMilli}:${recipient.id}`,
        },
        options,
      ),
    );
  }
  return { outcome: "enqueued", recipientIds, enqueue };
}

/**
 * The `NewIssue` arm's mail (notify.go:53-58 → MailParticipants with
 * ActionCreateIssue, doer = `issue.Poster`; `input.mentions` is the
 * issue-content resolution the emit service threaded — upstream
 * services/issue/issue.go:68). Only issues ride it — pull creation is the
 * separate `NewPullRequest` receiver (notify.go:88-93,
 * notifyPullRequestCreated).
 */
export async function notifyIssueCreated(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; doer: UserRow; mentions?: UserRow[] },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      actionName: "new",
      content: input.issue.content ?? "",
      dedupePrefix: "issue-new",
      mentions: input.mentions,
    },
    options,
  );
}

/**
 * The `NewPullRequest` arm's mail (notify.go:88-93 → MailParticipants over
 * the PR's issue row with ActionCreatePullRequest, doer = `pr.Issue.Poster`;
 * `input.mentions` is the PR-body resolution (upstream services/pull/
 * pull.go:184 — SPEC §13). Compose-wise
 * it is the thread-root "new" arm with IsPull = true: ActionCreatePullRequest
 * maps to the SAME "new" name as ActionCreateIssue (actionToTemplate,
 * mail_issue_common.go:228-230), keeps the issue content (NOT in
 * MailParticipants' :180-185 empty list), and carries NO Message-ID extra
 * (the :285-294 switch — the mail_test.go:417-422 "Open Pull" fixture pins
 * the plain `<owner/repo/pulls/#idx@domain>`); the render falls through to
 * issue/default.tmpl (no `mail/repo/pull/` exists at the pin), byte-identical
 * to the issue-new arm. Its ONE unique behavior: the repo-watcher WIP gate
 * does NOT apply (mail_issue.go:67-76's ActionCreatePullRequest exception —
 * `pullCreate` below).
 */
export async function notifyPullRequestCreated(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; doer: UserRow; mentions?: UserRow[] },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      pullCreate: true,
      actionName: "new",
      content: input.issue.content ?? "",
      dedupePrefix: "pull-new",
      mentions: input.mentions,
    },
    options,
  );
}

/**
 * The `IssueChangeStatus` arm's mail (notify.go:59-76 → MailParticipants
 * with ActionCloseIssue|ActionClosePullRequest when closing,
 * ActionReopenIssue|ActionReopenPullRequest when reopening — IsPull picks
 * the activities constant — doer = the actor, mentions nil). The closed/
 * reopened family, NOT a MailIssueClearComment chain: no such function
 * exists at the pin. MailParticipants empties the content for these ops
 * (mail_issue.go:180-185), so the action line IS the body.
 */
export async function notifyIssueStatusChanged(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; doer: UserRow; isClosed: boolean },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      actionName: input.isClosed ? "close" : "reopen",
      content: "",
      dedupePrefix: "issue-status",
    },
    options,
  );
}

/**
 * The `IssueChangeTitle` arm's mail (notify.go:80-90): a pull whose title
 * transitioned WIP → non-WIP mails the participants
 * `ActionPullRequestReadyForReview`. The receiver's gate runs FIRST
 * (upstream: `issue.IsPull && HasWorkInProgressPrefix(oldTitle) &&
 * !issue.PullRequest.IsWorkInProgress(ctx)` — IsWorkInProgress recomputes
 * from the CURRENT title prefix, models/issues/pull.go:652-658, the landed
 * `hasWorkInProgressPrefix` proxy — so `issue` must be the UPDATED row and a
 * plain-issue rename mails nothing), then the shared MailParticipants funnel
 * with mentions nil. Compose-wise it is the "Re: "-prefixed action arm whose
 * content is KEPT (ActionPullRequestReadyForReview is not in
 * mail_issue.go:179-185's empty list — the ready line renders above the
 * kept description), the Message-ID carries the `/ready/<unixMilli>` extra
 * (mail_issue_common.go:303-304 — the switch's dedicated case), and the
 * repo watchers ride the resolution (the new title is non-WIP, so the WIP
 * gate in resolveIssueMailRecipients is false on its own terms). Dedupe
 * `pull-ready:<issueId>:ready_for_review:<unixMilli>:<recipientId>` — the ms
 * rides the key exactly as it rides the Message-ID. The gate-off arm reports
 * "no-recipients" (nothing else was checked upstream either — the receiver
 * returns before MailParticipants).
 */
export async function notifyIssueTitleChanged(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; doer: UserRow; oldTitle: string },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  if (!input.issue.isPull) return { outcome: "no-recipients" };
  if (!hasWorkInProgressPrefix(input.oldTitle)) return { outcome: "no-recipients" };
  if (hasWorkInProgressPrefix(input.issue.title)) return { outcome: "no-recipients" };
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      actionName: "ready_for_review",
      content: input.issue.content ?? "",
      dedupePrefix: "pull-ready",
    },
    options,
  );
}

/**
 * The `IssueChangeAssignee` arm's mail (notify.go:119-127 →
 * `SendIssueAssignedMail`, mail_issue.go:200-232) — NOT the participants
 * funnel: the sole recipient is the added assignee, gated at the receiver
 * (`!removed && doer.ID != assignee.ID &&
 * assignee.EmailNotificationsPreference != Disabled`, notify.go:121 — the
 * side-store preference read, absent row = 'enabled') and inside the send
 * (`IsMailable`, mail_issue.go:208-210). NO access re-check: the assignee
 * was `CanBeAssigned`-validated at add time and this compose bypasses
 * mailIssueCommentBatch entirely (upstream shape). The compose is
 * composeIssueCommentMessages over `{ActionType: 0, Content: "Assigned
 * #<index>.", Comment: <the type-9 row>}` with info "issue assigned"
 * (:216-222): Comment non-nil ⇒ the link AND the Message-ID carry the
 * type-9 comment (`#issuecomment-<id>` anchor, `/comment/<id>` extra),
 * actionToTemplate's default case keys `CommentTypeAssignees` → name
 * "assigned" → `mail/repo/issue/assigned` (the ONE named issue template
 * that exists at the pin), whose body renders ONLY the
 * `mail.issue_assigned.pull|issue` locale line — the Content string is
 * rendered by the compose but never printed by this template. Subject "Re: "
 * + fallback (no subject section in assigned.tmpl); the thread
 * In-Reply-To/References stay plain (generated with ActionType(0)).
 * Dedupe `issue-assigned:<commentId>:<recipientId>` — the comment id is
 * unique per toggle, the comment arm's discipline.
 */
export async function notifyIssueAssigneeChanged(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; comment: CommentMailRow; doer: UserRow; assignee: UserRow; removed: boolean },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  // The receiver gates (notify.go:121) — order upstream's.
  if (input.removed) return { outcome: "no-recipients" };
  if (input.doer.id === input.assignee.id) return { outcome: "no-recipients" };
  const assigneePref =
    (await drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, input.assignee.id)).get())
      ?.emailNotificationsPreference ?? "enabled";
  if (assigneePref === "disabled") return { outcome: "no-recipients" };

  // SendIssueAssignedMail's prelude — the master gate + the MAIL_FROM parse
  // + the repo pair load (mail_issue.go:203-208).
  const pre = await mailArmPrelude(
    env,
    "issue-assigned mail",
    `issue-assigned mail for comment ${input.comment.id}`,
    input.issue.repoId,
  );
  if (!pre.ok) return pre.outcome;
  const { from, pair } = pre;
  // The langMap's IsMailable filter (mail_issue.go:208-210).
  if (!isMailable(input.assignee)) return { outcome: "no-recipients" };

  // ---- compose (composeIssueCommentMessages' assigned slice) ----
  const repoPath = `${pair.repo.ownerNamespace}/${pair.repo.slug}`;
  const origin = appUrlWithSlash(env.APP_URL);
  const appDomain = appDomainFromAppUrl(env.APP_URL);
  const repoHtmlUrl = `${origin}${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const issueUrl = issueMailUrl(origin, pair.repo.ownerNamespace, pair.repo.slug, input.issue.isPull, input.issue.index);
  // Comment non-nil: link = HTMLURL + "#" + HashTag (mail_issue_common.go:
  // 56-61) — the type-9 comment's anchor; List-Unsubscribe stays the plain
  // issue URL (compose :198).
  const link = `${issueUrl}#${commentAnchor(input.comment.id)}`;
  const subject = `Re: ${issueMailFallbackSubject(repoPath, input.issue.title, input.issue.index)}`;
  const sanitized = sanitizeSubject(subject);
  const fromDisplayName = mailFromDisplayName(input.doer);
  const messageId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain, input.comment.id);
  const threadId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain);
  // Upstream `msg.Info` with SendIssueAssignedMail's batch info (mail_issue.go:221).
  const info = `Subject: ${sanitized}, issue assigned`;

  const enqueue = await enqueueMailOutbox(
    env,
    {
      info,
      fromAddress: from.address,
      fromDisplayName,
      toAddr: input.assignee.email!,
      replyTo: null, // the Reply-To arm rides IncomingEmail (not landed)
      subject,
      bodyHtml: renderIssueAssignedMail({
        subject: sanitized,
        isPull: input.issue.isPull,
        doerDisplayName: displayNameWithFullName(input.doer.username, input.doer.fullName),
        link,
        issueIndex: input.issue.index,
        repoHtmlUrl,
        repoPath,
        appName: GITEA_APP_NAME,
        appUrl: origin,
      }),
      headers: JSON.stringify({
        "Message-ID": messageId,
        "In-Reply-To": threadId,
        References: threadId,
        "List-Unsubscribe": `<${issueUrl}>`,
        ...issueMailHeaders({
          repoPath,
          repoName: pair.repo.slug,
          repoHtmlUrl,
          issueUrl,
          issueIndex: input.issue.index,
          isPull: input.issue.isPull,
          appDomain,
          sender: input.doer,
          recipient: input.assignee,
        }),
      }),
      dedupeKey: `issue-assigned:${input.comment.id}:${input.assignee.id}`,
    },
    options,
  );
  return { outcome: "enqueued", recipientIds: [input.assignee.id], enqueue: [enqueue] };
}
