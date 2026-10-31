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
 *     `NewIssue` / `IssueChangeStatus` / `NewPullRequest` (notify.go:53-96,
 *     SPEC §1.3's next arms) become thin wrappers passing a different
 *     action type and `comment = null`.
 *
 * The emit site is the real write path (`IssuesService.addComment` —
 * upstream fires notify from the model layer too: CreateIssueComment's
 * notify call rides the comment-create service, not the router). Failures
 * are logged, never propagated (upstream logs at the receiver,
 * notify.go:48-50 `log.Error("MailParticipantsComment: %v", err)`); the
 * write stays committed.
 *
 * Documented reductions (all schema-absent, SPEC §8):
 *   - mentions: upstream resolves `mentions []*User` from the content and
 *     mails them FIRST with `fromMention=true` (mail_issue.go:99-102); no
 *     mention parser is ported this slice, so `onmention`-preference users
 *     have no reachable source (their upstream sources — mentions and custom
 *     watchers — are both absent here) and are excluded everywhere.
 *   - repo-watch modes: upstream's `watch` table carries mode + include_
 *     flags (models/repo/watch.go:17-43); ours is (repo_id, user_id) — every
 *     watcher receives issue AND pull mail, and there are no ignorers
 *     (GetRepoIgnorersIDs, mail_issue.go:87-92) or custom watchers.
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
  type UserRow,
} from "../../api/services/repository";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { CommentType } from "../../issues/comment-types";
import { appDomainFromAppUrl, parseMailFrom, sanitizeSubject } from "./message";
import { enqueueMailOutbox, type EnqueueOutcome, type MailOutboxEnv } from "./outbox";
import { appUrlWithSlash, GITEA_APP_NAME, isMailable } from "./register-notify";
import { issueMailFallbackSubject, renderIssueCommentMail } from "./templates";

/** The issue row the arm composes over (schema-derived; no issues/service
 *  import — the emit site imports US). */
type IssueMailRow = typeof issues.$inferSelect;
type CommentMailRow = typeof comments.$inferSelect;

/**
 * The notify-event vocabulary — upstream's `Notifier` method names
 * (services/notify/notifier.go). This slice fires the FIRST arm only;
 * the rest are the additive entries SPEC §1.3 enumerates (each lands as a
 * thin wrapper over the same resolution + compose core below).
 */
export type MailNotifyEvent = "CreateIssueComment";

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
 *  close/reopen/merge timestamp suffixes belong to the later arms. */
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
 *   - `GetMailableUsersByIDs` (models/user/user.go) prefilter: individual,
 *     active, preference enabled/andyourown (the mention/custom arms absent —
 *     see module header), plus the email half of `IsMailable`. The
 *     preference rides the typed `user_settings` side store (the SPEC
 *     user-notification-settings collapse; an absent row IS upstream's
 *     'enabled' default, admin.go:32) — the LEFT JOIN + default mirrors the
 *     upstream column read;
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
  },
): Promise<UserRow[]> {
  const db = drizzle(d1);

  // The unit-enabled gate — one read (upstream's CanRead(unit) unit half).
  const settings = await loadRepoSettings(d1, input.repo.id);
  if (input.issue.isPull ? !settings.hasPullRequests : !settings.hasIssues) {
    return [];
  }

  // =========== Repo watchers (WIP-gated, mail_issue.go:67-76) ===========
  const repoWatcherIds =
    input.issue.isPull && hasWorkInProgressPrefix(input.issue.title)
      ? []
      : (
          await db.select({ id: repoWatchers.userId }).from(repoWatchers).where(eq(repoWatchers.repoId, input.issue.repoId)).all()
        ).map((row) => row.id);

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

  const orderedIds = unionIds(repoWatcherIds, posterIds, assigneeIds, participantIds, issueWatcherIds);
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
    if (pref !== "enabled" && pref !== "andyourown") continue;
    byId.set(row.user.id, row.user);
  }

  // visited: the explicit unwatchers (mail_issue.go:104-109) + the doer
  // (mail_issue.go:94-97).
  const visited = new Set<number>(
    (
      await db
        .select({ id: issueSubscriptions.userId })
        .from(issueSubscriptions)
        .where(and(eq(issueSubscriptions.issueId, input.issue.id), eq(issueSubscriptions.isWatching, false)))
        .all()
    ).map((row) => row.id),
  );
  const doerPref = (
    await db.select().from(userSettings).where(eq(userSettings.userId, input.doer.id)).get()
  )?.emailNotificationsPreference ?? "enabled";
  if (doerPref !== "andyourown") {
    visited.add(input.doer.id);
  }

  const publicRepo = input.repo.visibility === "public";
  const recipients: UserRow[] = [];
  for (const id of orderedIds) {
    if (visited.has(id)) continue;
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
 * The `CreateIssueComment` arm's mail (notify.go:31-51 →
 * MailParticipantsComment → mailIssueCommentToParticipants →
 * composeIssueCommentMessages). Gate → resolve → compose → outbox, never
 * throwing for disabled/misconfigured/no-recipients (the register-notify
 * posture); only a D1 failure propagates and the emit site catches it.
 */
export async function notifyIssueComment(
  env: MailNotifyEnv,
  input: NotifyIssueCommentInput,
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  // The master gate — upstream `setting.MailService == nil` parity (SPEC §5.1).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };
  const from = parseMailFrom(env.MAIL_FROM ?? "");
  if (from === null) {
    const message = `[mail] MAIL_ENABLED=true but MAIL_FROM is missing or unparseable; skipping issue-comment mail for comment ${input.comment.id}`;
    console.warn(message);
    return { outcome: "misconfigured", message };
  }

  // The repo pair — the subject/link/repo-header source (upstream loads the
  // repo before composing, mail_issue.go:30-32). A missing row (orphaned
  // repo) logs and skips — the push-wave degradation rule.
  const pair = await findRepositoryById(env.DB, input.issue.repoId);
  if (pair === null) {
    console.error(`[mail] issue-comment mail skipped: repository row missing [id: ${input.issue.repoId}]`);
    return { outcome: "no-recipients" };
  }

  const recipients = await resolveIssueMailRecipients(env.DB, {
    issue: input.issue,
    repo: pair.repo,
    doer: input.doer,
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
