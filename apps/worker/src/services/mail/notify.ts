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
 *     recipient is NOT the participants resolution, SPEC §12). Slice six
 *     adds `MergePullRequest` (:138-146 — the winning-merge mail over the
 *     same funnel, SPEC §12.4); its `AutoMergePullRequest` twin (:148-156)
 *     stays STAGED — unreachable while no scheduled-merge store exists
 *     (SPEC §1.3). Slice eight lands the REVIEW family's three receivers
 *     (SPEC §14.6 — the review-service extraction's firing points):
 *     `PullRequestReview` (:98-111, MailParticipantsComment over the
 *     type-22 comment), `PullRequestCodeComment` (:113-117,
 *     MailMentionsComment's mentions-only batch per attached code comment)
 *     and `PullRequestReviewRequest` (:129-136, SendIssueAssignedMail's
 *     "Requested to review <htmlurl>." twin of IssueChangeAssignee).
 *
 * The inbound fold (specs/email-inbound.md §9 — mail_issue_common.go:
 * 181-202) rides the same loop: with `MAIL_INBOUND_ENABLED=true` (+ secret +
 * a valid `%{token}` reply-address template) every recipient's mail carries
 * the per-recipient REPLY token (`Reply-To` + `List-Post` mailto + the
 * `<reply-<token>@AppDomain>` References carrier) and the UNSUBSCRIBE token
 * (the `List-Unsubscribe` mailto arm), minted through
 * `services/mail/inbound.ts`'s exported primitives. Without the vars the
 * headers stay absent — the pre-fold bytes, fail-closed.
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
  ReviewType,
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
import {
  createReplyToken,
  parseReplyAddressTemplate,
  replyAddressFor,
  type ReplyRefType,
} from "./inbound";
import { appDomainFromAppUrl, parseMailFrom, sanitizeSubject } from "./message";
import { enqueueMailOutbox, type EnqueueOutcome, type MailOutboxEnv } from "./outbox";
import { appUrlWithSlash, GITEA_APP_NAME, isMailable } from "./register-notify";
import {
  displayNameWithFullName,
  issueActionApproveLine,
  issueActionCloseLine,
  issueActionMergeLine,
  issueActionNewLine,
  issueActionReadyForReviewLine,
  issueActionRejectLine,
  issueActionReopenLine,
  issueActionReviewLine,
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
  | "IssueChangeAssignee"
  | "MergePullRequest"
  | "PullRequestReview"
  | "PullRequestCodeComment"
  | "PullRequestReviewRequest";

/** The env slice the hub reads (both bindings ride the outbox; the
 *  MAIL_INBOUND_* trio arms the per-recipient token carriers — SPEC
 *  email-inbound §9). */
export type MailNotifyEnv = Pick<MailOutboxEnv, "DB" | "REPO_TASKS" | "APP_URL"> & {
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
  MAIL_INBOUND_ENABLED?: string;
  MAIL_INBOUND_REPLY_ADDRESS?: string;
  MAIL_INBOUND_SECRET?: string;
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

/**
 * `CommentType.HasMailReplySupport` (models/issues/comment.go:196-201) over
 * the comment types the hub's comment-bearing arms can hold: Comment (0),
 * Assignees (9), Code (21), Review (22) all carry it; ReviewRequest (27) —
 * the review-request family's mail comment — does NOT, so its compose
 * leaves the reply payload nil (mail_issue_common.go:148-154: no Reply-To,
 * no List-Post, a bare thread References; the UNSUBSCRIBE token is
 * independent and still minted).
 */
function hasMailReplySupport(type: number): boolean {
  return (
    type === CommentType.Comment ||
    type === CommentType.Assignees ||
    type === CommentType.Code ||
    type === CommentType.Review ||
    type === CommentType.DismissReview ||
    type === CommentType.Reopen ||
    type === CommentType.Close ||
    type === CommentType.MergePull
  );
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
 *  ActionMergePullRequest|ActionAutoMergePullRequest → `/merge/<unixMilli>`
 *  :296-297, ActionPullRequestReadyForReview → `/ready/<unixMilli>`
 *  :303-304): every status mail's Message-ID is distinct across repeated
 *  close/reopen cycles over one issue (upstream's own uniqueness mechanism —
 *  the pin's test at mail_test.go:446/:462 asserts exactly the `/close/` and
 *  `/reopen/` prefixes). The "new" arm has NO extra (ActionCreateIssue falls
 *  through the switch, mail_test.go:407-418), so it reuses `issueMessageId`
 *  plain. */
function issueActionMessageId(
  repoPath: string,
  isPull: boolean,
  index: number,
  appDomain: string,
  action: "close" | "reopen" | "ready" | "merge",
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
 * whole (SPEC §4.4). The token carriers (Reply-To/List-Post, the References
 * tail, the List-Unsubscribe mailto arm) are NOT here — upstream sets them
 * on the message before this family (:175-205), and they ride the compose
 * sites' per-recipient `inboundTokenCarriers` arm below.
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

/**
 * The compose-side inbound arm — mail_issue_common.go:181's
 * `setting.IncomingEmail.Enabled` gate. Armed ONLY when
 * `MAIL_INBOUND_ENABLED==="true"` AND the secret is present AND the
 * reply-address template validates (`parseReplyAddressTemplate` — exactly
 * one `%{token}`, in the user part, no display name; upstream Fatal's at
 * boot, incoming_email.go:47-63 — we have no boot step, so the arm degrades
 * to the un-armed shape with a warn, the inbound handler's own
 * dropped-misconfigured posture). EVERY other state leaves the token
 * headers absent — the pre-fold behavior, byte-identical (fail-closed in
 * both directions: an armed inbound with an unarmed compose just keeps
 * logging dropped-no-token, which is safe).
 */
type InboundCompose = { armed: false } | { armed: true; secret: string; replyAddressTemplate: string };

function inboundComposeOf(env: MailNotifyEnv): InboundCompose {
  if (env.MAIL_INBOUND_ENABLED !== "true") return { armed: false };
  const secret = env.MAIL_INBOUND_SECRET ?? "";
  const replyAddressTemplate = env.MAIL_INBOUND_REPLY_ADDRESS ?? "";
  if (secret === "" || parseReplyAddressTemplate(replyAddressTemplate) === null) {
    console.warn(
      "[mail] MAIL_INBOUND_ENABLED=true but MAIL_INBOUND_SECRET/MAIL_INBOUND_REPLY_ADDRESS is missing or invalid; reply headers omitted",
    );
    return { armed: false };
  }
  return { armed: true, secret, replyAddressTemplate };
}

/**
 * One recipient's token carriers (mail_issue_common.go:181-202 — per
 * RECIPIENT under the Enabled gate). Upstream sets, in order:
 *   - `Reply-To` = REPLY_TO_ADDRESS with `%{token}` replaced once by the
 *     per-recipient REPLY token (`msg.ReplyTo`, :186-188; the placeholder
 *     sits in the user part, validated by `inboundComposeOf`);
 *   - `List-Post` = `<mailto:replyAddress>` (:189);
 *   - `References` += `<reply-<token>@AppDomain>` (:191) — the SECOND
 *     carrier so a plain group-reply delivers the token even when the
 *     client replies to From/References instead of Reply-To;
 *   - `List-Unsubscribe` += `<mailto:addr-with-UNSUBSCRIBE-token>`
 *     (:195-201) — UNCONDITIONAL per recipient (NOT gated on the reply
 *     payload); the issue-url arm stays first (:179).
 * Our rows store one string per header, so upstream's two-value gomail
 * lists (mail_test.go:134/:137 pin the pairs) collapse: `References`
 * space-joined (RFC 5322 §3.6.4's *msg-id list) and `List-Unsubscribe`
 * comma-joined (RFC 2369's list syntax). Un-armed, everything is ABSENT and
 * the headers return the pre-fold bytes (References = the bare thread id,
 * List-Unsubscribe = the url arm only, no Reply-To on the row).
 *
 * The REPLY token binds (recipient, reply reference) — `replyRef` carries
 * the comment's (type, id) when the arm composes over a comment with
 * HasMailReplySupport at the pin (models/issues/comment.go:196-201 — the
 * hub's comment arms hold types 0, 9, 21 and 22; ALL of them carry it), the
 * ISSUE for the comment-nil arms (:147-154), and NULL exactly when upstream
 * leaves the payload nil — the compose's `replyPayload == nil` gate at
 * :148-154 (a comment type OUTSIDE the HasMailReplySupport set — the
 * review-request family's CommentTypeReviewRequest 27 is the hub's one such
 * arm) replies nothing: no Reply-To, no List-Post, a bare thread
 * References. The UNSUBSCRIBE token binds the ISSUE always (:159) and is
 * minted under the `unsubscribe` FAMILY (SPEC §3.2's domain separation) — a
 * reply-family verify of it can never pass, so a mail sent to the
 * unsubscribe address drops dropped-invalid-token until the
 * UnsubscribeHandler slice lands (SPEC §1.3); it can never masquerade as a
 * reply.
 */
async function inboundTokenCarriers(
  inbound: InboundCompose,
  input: {
    recipientId: number;
    /** The reply token's payload binding; null = upstream's nil payload
     *  (no reply carriers — see the gate above). */
    replyRef: { type: ReplyRefType; id: number } | null;
    issueId: number;
    threadId: string;
    issueUrl: string;
    appDomain: string;
    now?: Date;
  },
): Promise<{
  replyTo: string | null;
  listPost: string | undefined;
  references: string;
  listUnsubscribe: string;
}> {
  if (!inbound.armed) {
    return {
      replyTo: null,
      listPost: undefined,
      references: input.threadId,
      listUnsubscribe: `<${input.issueUrl}>`,
    };
  }
  const replyToken =
    input.replyRef === null
      ? null
      : await createReplyToken(inbound.secret, {
          userId: input.recipientId,
          refType: input.replyRef.type,
          refId: input.replyRef.id,
          now: input.now,
        });
  const replyAddress =
    replyToken === null ? null : replyAddressFor(inbound.replyAddressTemplate, replyToken);
  const unsubscribeToken = await createReplyToken(inbound.secret, {
    userId: input.recipientId,
    refType: "issue",
    refId: input.issueId,
    family: "unsubscribe",
    now: input.now,
  });
  const unsubscribeAddress = replyAddressFor(inbound.replyAddressTemplate, unsubscribeToken);
  return {
    replyTo: replyAddress,
    listPost: replyAddress === null ? undefined : `<mailto:${replyAddress}>`,
    references:
      replyToken === null
        ? input.threadId
        : `${input.threadId} <reply-${replyToken}@${input.appDomain}>`,
    listUnsubscribe: `<${input.issueUrl}>, <mailto:${unsubscribeAddress}>`,
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
  // The per-recipient token gate (mail_issue_common.go:181) — resolved once,
  // consulted per recipient in the loop.
  const inbound = inboundComposeOf(env);

  const enqueue: EnqueueOutcome[] = [];
  const recipientIds: number[] = [];
  for (const recipient of recipients) {
    recipientIds.push(recipient.id);
    // The token carriers for THIS recipient (the comment arm replies over
    // the type-0 comment — mail_issue_common.go:148-151).
    const carriers = await inboundTokenCarriers(inbound, {
      recipientId: recipient.id,
      replyRef: { type: "comment", id: input.comment.id },
      issueId: input.issue.id,
      threadId,
      issueUrl,
      appDomain,
      now: options.now,
    });
    enqueue.push(
      await enqueueMailOutbox(
        env,
        {
          info,
          fromAddress: from.address,
          fromDisplayName,
          toAddr: recipient.email!,
          replyTo: carriers.replyTo,
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
            ...(carriers.listPost === undefined ? {} : { "List-Post": carriers.listPost }),
            References: carriers.references,
            "List-Unsubscribe": carriers.listUnsubscribe,
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
 *  mail_issue.go:188-198) — extended with the comment-bearing variant
 *  (`comment`, the review family) and the pre-resolved recipient list
 *  (`recipients`, MailMentionsComment/SendIssueAssignedMail's batched
 *  callers). */
interface NotifyIssueArmInput {
  issue: IssueMailRow;
  /** The mail's doer — issue.Poster for NewIssue (notify.go:55) AND for
   *  NewPullRequest (notify.go:89 `pr.Issue.Poster`), the actor for
   *  IssueChangeStatus (notify.go:76), `c.Poster` for the comment-bearing
   *  review arms (mail_comment.go:22/54). */
  doer: UserRow;
  /** actionToTemplate's name for the arm (mail_issue_common.go:227-246):
   *  ActionCreateIssue AND ActionCreatePullRequest → "new";
   *  ActionCloseIssue|ClosePullRequest → "close";
   *  ActionReopenIssue|ReopenPullRequest → "reopen" (IsPull picks the
   *  activities constant, not the name — notify.go:63-73);
   *  ActionPullRequestReadyForReview → "ready_for_review" (:248);
   *  ActionMergePullRequest|ActionAutoMergePullRequest → "merge" (:235-236);
   *  the UNKNOWN action types fall to the comment-type switch (:247-268):
   *  CommentTypeReview → "approve"|"reject"|"review" by the review's type,
   *  CommentTypeCode → "code"-shaped "comment", CommentTypeReviewRequest →
   *  "default". */
  actionName:
    | "new"
    | "close"
    | "reopen"
    | "ready_for_review"
    | "merge"
    | "approve"
    | "reject"
    | "review"
    | "comment"
    | "default";
  /** MailParticipants' content rule (mail_issue.go:179-185): the issue
   *  content for "new" AND "ready_for_review" (ActionCreatePullRequest is
   *  NOT in the empty list; neither is ActionPullRequestReadyForReview);
   *  "" for close/reopen AND merge/auto-merge (upstream empties them,
   *  :184-185). The comment-bearing arms pass the comment's content
   *  (MailParticipantsComment's `content := c.Content`, mail_comment.go:21 —
   *  emptied only for the push type). */
  content: string;
  /** The dedupe-key family (SPEC §8.3's trigger-level idempotency). */
  dedupePrefix:
    | "issue-new"
    | "issue-status"
    | "pull-new"
    | "pull-ready"
    | "pull-merge"
    | "pull-review"
    | "pull-code-comment"
    | "pull-review-request";
  /** The pull-create arm's repo-watcher WIP-gate exception (the
   *  resolveIssueMailRecipients flag, mail_issue.go:67-76). */
  pullCreate?: boolean;
  /** `.Issue.PullRequest.BaseBranch` — the merge line's %[3]s locale arg
   *  (default.tmpl's merge branch; the merge arm passes the PR row's
   *  baseBranch, every other arm leaves it unset). */
  baseBranch?: string;
  /** The content's resolved mentions (upstream `mentions []*User`): the
   *  create arms pass FindAndUpdateIssueMentions' result (services/issue/
   *  issue.go:68, services/pull/pull.go:184); the status/title arms pass
   *  none (services/issue/status.go:43/:56, issue.go:127 — no content
   *  parses there). ALSO the per-recipient IsMention source: a recipient in
   *  this set rides the mention batch (compose's fromMention=true). */
  mentions?: UserRow[];
  /** The comment-bearing variant (upstream `mailComment.Comment != nil`):
   *  the link grows the comment's HashTag anchor (mail_issue_common.go:
   *  56-61), the Message-ID carries the `/comment/<id>` extra
   *  (generateMessageIDForIssue's comment branch, :280-292), the reply
   *  token binds the comment when its type carries HasMailReplySupport
   *  (:148-151), and the dedupe key rides the comment id (the
   *  issue-assigned arm's discipline). */
  comment?: CommentMailRow;
  /** The pre-resolved recipient list (upstream's batched callers hand
   *  their own recipients: MailMentionsComment's mentions-only batch,
   *  mail_comment.go:56-60, and SendIssueAssignedMail's sole-recipient
   *  list, mail_issue.go:230). Present = resolveIssueMailRecipients is
   *  SKIPPED — the caller owns the funnel filters. */
  recipients?: UserRow[];
  /** The compose's batch info (composeIssueCommentMessages' `info` arg —
   *  "issue comments" for the participant/mention batches, mail_issue.go:
   *  157/165, "issue assigned" for SendIssueAssignedMail's, :222). */
  info?: string;
}

/**
 * The shared arm compose — the middle behind NewIssue, IssueChangeStatus,
 * NewPullRequest (comment-nil) and the review family (comment-bearing):
 * `MailParticipants`/`MailParticipantsComment` (mail_issue.go:173-202,
 * mail_comment.go:19-40/46-64) → `mailIssueCommentToParticipants` (or the
 * caller's pre-resolved batch) → `composeIssueCommentMessages` over the
 * default.tmpl branches. Differences across the arms, all pinned:
 *   - link = `Issue.HTMLURL` with NO anchor when Comment is nil
 *     (mail_issue_common.go:60-64); the comment-bearing arms grow
 *     `#issuecomment-<id>` (Comment.HashTag, models/issues/comment.go:
 *     554-556);
 *   - subject prefix "Re: " only when actName != "new" (:88-91) — the new
 *     mail is the thread's root;
 *   - Message-ID: Comment non-nil carries the `/comment/<id>` extra
 *     (generateMessageIDForIssue's comment branch, :280-292 — it OUTRANKS
 *     the action switch); comment-nil "new" carries NO extra (the
 *     mail_test.go:412 "Open Issue" and :417-422 "Open Pull" fixtures pin
 *     the plain `<owner/repo/issues|pulls/#idx@domain>`); close/reopen/
 *     merge/ready carry their `/<action>/<unixMilli>` extras (the
 *     :446/:462 fixtures);
 *   - In-Reply-To/References stay the plain thread id for every arm (the
 *     reference is generated with ActionType(0) and nil comment, :165);
 *   - the body is the arm's content rendered with absolute links
 *     (:71-72); "" short-circuits to the template's empty-body branch;
 *   - the action line: close/reopen/ready_for_review/approve/reject/review
 *     render theirs ALWAYS (default.tmpl's first chain — "review" keys
 *     `mail.issue.action.review`, the CommentTypeReview default branch,
 *     actionToTemplate :248-257); "comment"/"default" render none (the
 *     body branch carries the mail);
 *   - IsMention per recipient: the mention-batch members (input.mentions)
 *     get default.tmpl's `x_mentioned_you` line (compose's fromMention,
 *     mail_issue.go:101/115);
 *   - info: "issue comments" (the batch string, mail_issue.go:157/165)
 *     unless the caller passes SendIssueAssignedMail's "issue assigned"
 *     (:222).
 * Dedupe keys: comment-bearing arms use
 * `<prefix>:<commentId>:<recipientId>` (the issue-assigned discipline —
 * the comment id is unique per trigger); comment-nil
 * `issue-new:<issueId>:<recipientId>` / `pull-new:<issueId>:<recipientId>`
 * and `issue-status|pull-ready|pull-merge:<issueId>:<action>:<unixMilli>:
 * <recipientId>` (the ms rides the key exactly as it rides the Message-ID).
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
        : input.actionName === "merge"
          ? "merge mail"
          : input.actionName === "comment"
            ? "code-comment mail"
            : input.actionName === "default"
              ? "review-request mail"
              : input.actionName === "approve" || input.actionName === "reject" || input.actionName === "review"
                ? "pull-review mail"
                : "issue-status mail";
  const pre = await mailArmPrelude(env, armName, `${armName} for issue ${input.issue.id}`, input.issue.repoId);
  if (!pre.ok) return pre.outcome;
  const { from, pair } = pre;

  const recipients =
    input.recipients ??
    (await resolveIssueMailRecipients(env.DB, {
      issue: input.issue,
      repo: pair.repo,
      doer: input.doer,
      pullCreate: input.pullCreate,
      mentions: input.mentions,
    }));
  if (recipients.length === 0) return { outcome: "no-recipients" };

  // ---- compose (composeIssueCommentMessages) ----
  const unixMilli = (options.now ?? new Date()).getTime();
  const repoPath = `${pair.repo.ownerNamespace}/${pair.repo.slug}`;
  const origin = appUrlWithSlash(env.APP_URL);
  const appDomain = appDomainFromAppUrl(env.APP_URL);
  const repoHtmlUrl = `${origin}${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const issueUrl = issueMailUrl(origin, pair.repo.ownerNamespace, pair.repo.slug, input.issue.isPull, input.issue.index);
  // Comment non-nil: link = HTMLURL + "#" + HashTag (mail_issue_common.go:56-61).
  const link = input.comment === undefined ? issueUrl : `${issueUrl}#${commentAnchor(input.comment.id)}`;
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
  // The action line: close/reopen/ready_for_review/approve/reject/review
  // render theirs ALWAYS (default.tmpl's first action chain — the review
  // arms may carry the kept content alongside, MailParticipantsComment
  // never empties a review body); "comment"/"default" render none;
  // "new" renders its line only when the body is empty (the nested
  // `{{if eq .ActionName "new"}}`).
  const doerDisplay = displayNameWithFullName(input.doer.username, input.doer.fullName);
  const actionLineHtml =
    input.actionName === "close"
      ? issueActionCloseLine(doerDisplay, input.issue.index)
      : input.actionName === "reopen"
        ? issueActionReopenLine(doerDisplay, input.issue.index)
        : input.actionName === "ready_for_review"
          ? issueActionReadyForReviewLine(doerDisplay)
          : input.actionName === "merge"
            ? issueActionMergeLine(doerDisplay, input.issue.index, input.baseBranch ?? "")
            : input.actionName === "approve"
              ? issueActionApproveLine(doerDisplay)
              : input.actionName === "reject"
                ? issueActionRejectLine(doerDisplay)
                : input.actionName === "review"
                  ? issueActionReviewLine(doerDisplay)
                  : bodyHtml === "" && input.actionName === "new"
                    ? issueActionNewLine(doerDisplay, input.issue.index)
                    : null;
  const fromDisplayName = mailFromDisplayName(input.doer);
  // generateMessageIDForIssue (mail_issue_common.go:280-292): the COMMENT
  // branch outranks the action switch; comment-nil "new" has no extra; the
  // status actions carry their `/<action>/<unixMilli>` extras. The final
  // fallback is defensive-unreachable (the approve/reject/review/comment/
  // default names only ever ride the comment-bearing branch above).
  const messageId =
    input.comment !== undefined
      ? issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain, input.comment.id)
      : input.actionName === "new"
        ? issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain)
        : input.actionName === "close" || input.actionName === "reopen" || input.actionName === "merge"
          ? issueActionMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain, input.actionName, unixMilli)
          : input.actionName === "ready_for_review"
            ? issueActionMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain, "ready", unixMilli)
            : issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain);
  const threadId = issueMessageId(repoPath, input.issue.isPull, input.issue.index, appDomain);
  const info = `Subject: ${sanitized}, ${input.info ?? "issue comments"}`;
  // The per-recipient token gate (mail_issue_common.go:181).
  const inbound = inboundComposeOf(env);
  // The per-recipient IsMention (compose's fromMention — the mention batch's
  // membership, mail_issue.go:101/115).
  const mentionIdSet = new Set<number>((input.mentions ?? []).map((user) => user.id));

  const enqueue: EnqueueOutcome[] = [];
  const recipientIds: number[] = [];
  for (const recipient of recipients) {
    recipientIds.push(recipient.id);
    // The token carriers for THIS recipient (mail_issue_common.go:147-201):
    // the comment-nil arms reply over the ISSUE (:152-154); the
    // comment-bearing arms reply over the COMMENT when its type carries
    // HasMailReplySupport (:148-151 — the hub's comment types 0/9/21/22 all
    // do), and a type OUTSIDE the set (the review-request family's 27)
    // leaves the payload nil — no Reply-To/List-Post, a bare thread
    // References.
    const carriers = await inboundTokenCarriers(inbound, {
      recipientId: recipient.id,
      replyRef:
        input.comment === undefined
          ? { type: "issue", id: input.issue.id }
          : hasMailReplySupport(input.comment.type)
            ? { type: "comment", id: input.comment.id }
            : null,
      issueId: input.issue.id,
      threadId,
      issueUrl,
      appDomain,
      now: options.now,
    });
    enqueue.push(
      await enqueueMailOutbox(
        env,
        {
          info,
          fromAddress: from.address,
          fromDisplayName,
          toAddr: recipient.email!,
          replyTo: carriers.replyTo,
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
            isMention: mentionIdSet.has(recipient.id),
            doerName: input.doer.username,
          }),
          headers: JSON.stringify({
            "Message-ID": messageId,
            "In-Reply-To": threadId,
            ...(carriers.listPost === undefined ? {} : { "List-Post": carriers.listPost }),
            References: carriers.references,
            "List-Unsubscribe": carriers.listUnsubscribe,
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
            input.comment !== undefined
              ? `${input.dedupePrefix}:${input.comment.id}:${recipient.id}`
              : input.dedupePrefix === "issue-new" || input.dedupePrefix === "pull-new"
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
 * The `MergePullRequest` arm's mail (notify.go:138-146 → MailParticipants
 * with ActionMergePullRequest, doer = the merger, mentions nil) — upstream
 * fires it from `markAsMergedPostProcess` (services/pull/merge.go:385-412,
 * `wasAutoMerged` false :406) AFTER the merge tx, with the issue RELOADED
 * closed. Compose-wise it is the "Re: "-prefixed status-family arm whose
 * content is EMPTIED (ActionMergePullRequest is in MailParticipants'
 * :180-185 empty list — the merge line IS the body), the Message-ID carries
 * the `/merge/<unixMilli>` extra (mail_issue_common.go:296-297 — the switch
 * covers ActionAutoMergePullRequest too), and default.tmpl's merge branch
 * renders `<b>%[1]s</b> merged #%[2]d into %[3]s.` — %[3]s is
 * `.Issue.PullRequest.BaseBranch` (`baseBranch` below, escaped like every
 * plain-string locale arg). Recipients: the full participants resolution,
 * `pullCreate` NOT set (a merge of a WIP-titled pull drops the repo
 * watchers upstream-shaped, mail_issue.go:67-76; our merge route refuses WIP
 * anyway, the same unreachable-but-faithful posture). Dedupe
 * `pull-merge:<issueId>:merge:<unixMilli>:<recipientId>` — the ms discipline
 * (the issue-status family). The sibling `AutoMergePullRequest` receiver
 * (notify.go:148-156) is STAGED, not landed: its only differences are the
 * ActionAutoMergePullRequest constant (same "merge" template name,
 * :235-236), the same `/merge/` Message-ID extra and
 * `ForceDoerNotification` (mail_issue.go:191 — the merger receives their
 * own merge mail bypassing the :94-97 doer exclusion); none is reachable
 * while this backend has no scheduled-merge store (see SPEC §1.3).
 */
export async function notifyMergePullRequest(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; doer: UserRow; baseBranch: string },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      actionName: "merge",
      content: "",
      dedupePrefix: "pull-merge",
      baseBranch: input.baseBranch,
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
  // The token gate (mail_issue_common.go:181 — SendIssueAssignedMail rides
  // the same composeIssueCommentMessages loop).
  const inbound = inboundComposeOf(env);
  // The token carriers for the assignee (the type-9 comment carries
  // HasMailReplySupport at the pin, models/issues/comment.go:196-201, so
  // the reply token binds the comment — mail_issue_common.go:148-151).
  const carriers = await inboundTokenCarriers(inbound, {
    recipientId: input.assignee.id,
    replyRef: { type: "comment", id: input.comment.id },
    issueId: input.issue.id,
    threadId,
    issueUrl,
    appDomain,
    now: options.now,
  });

  const enqueue = await enqueueMailOutbox(
    env,
    {
      info,
      fromAddress: from.address,
      fromDisplayName,
      toAddr: input.assignee.email!,
      replyTo: carriers.replyTo,
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
        ...(carriers.listPost === undefined ? {} : { "List-Post": carriers.listPost }),
        References: carriers.references,
        "List-Unsubscribe": carriers.listUnsubscribe,
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

// ---------------------------------------------------------------------------
// The review family (SPEC §14.6) — the review-service extraction's firing
// points. Upstream fires ALL THREE from the model/service layer AFTER the
// writes commit (never the router): PullRequestReview +
// PullRequestCodeComment from ONE body — SubmitReview (services/pull/
// review.go:316 and :323-331) — and PullRequestReviewRequest from the
// request model arm (services/issue/review_request.go:38, `comment !=
// nil`).
// ---------------------------------------------------------------------------

/** ReviewType → actionToTemplate's name (mail_issue_common.go:248-257, the
 *  CommentTypeReview branch of the action switch's default arm): approve →
 *  "approve", reject → "reject", every other type → "review". */
function reviewActionName(reviewType: number): "approve" | "reject" | "review" {
  if (reviewType === ReviewType.Approve) return "approve";
  if (reviewType === ReviewType.Reject) return "reject";
  return "review";
}

/** The review family's input (the notify receivers' parameters, notify.go
 *  :98-136): the PR's issue row, the fired comment, the doer and the
 *  review/comment payload each arm composes over. */
export interface NotifyPullRequestReviewInput {
  /** The PR's issue row (`pr.Issue`). */
  issue: IssueMailRow;
  /** The type-22 review comment SubmitReview just landed (upstream `comm`,
   *  services/pull/review.go:316 — the mail's anchor, Message-ID and
   *  content carrier). */
  comment: CommentMailRow;
  /** The submitted review's type (upstream `r.Type`, read through
   *  `comment.Review` by actionToTemplate) — picks the mail's action line:
   *  approve / reject / review. */
  reviewType: number;
  /** The review's author (`comment.Poster`). */
  doer: UserRow;
  /** The doer content's resolved mentions (upstream FindAndUpdateIssueMentions
   *  over `comm.Content`, services/pull/review.go:310-314 — the write
   *  service resolves BEFORE the receiver fires). */
  mentions?: UserRow[];
}

/**
 * The `PullRequestReview` arm's mail (notify.go:98-111 →
 * MailParticipantsComment over the type-22 comment → the participants
 * funnel → composeIssueCommentMessages). Upstream's action switch maps by
 * COMMENT type — Close→close, Reopen→reopen, Comment(0)→"comment" — and a
 * type-22 review comment falls through to ActionType(0), whose compose
 * re-keys on the comment type + review type (actionToTemplate :247-257):
 * name approve|reject|review, template default.tmpl (no
 * approve/reject/review template file exists at the pin — the fallback
 * chain lands on issue/default). So the mail is the "Re: "-prefixed arm
 * whose action line is the review verdict (kept content rendered beneath
 * it — MailParticipantsComment empties only the push type,
 * mail_comment.go:21-23), the link/Message-ID carry the type-22 comment,
 * and the reply token binds it (HasMailReplySupport). Recipients: the FULL
 * participants resolution (mentions ride first, IsMention=true for them) —
 * `pullCreate` NOT set, so the WIP repo-watcher gate applies exactly as
 * upstream's ActionType(0) != ActionCreatePullRequest.
 * Dedupe `pull-review:<commentId>:<recipientId>`.
 */
export async function notifyPullRequestReview(
  env: MailNotifyEnv,
  input: NotifyPullRequestReviewInput,
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      comment: input.comment,
      actionName: reviewActionName(input.reviewType),
      content: input.comment.content ?? "",
      dedupePrefix: "pull-review",
      mentions: input.mentions,
    },
    options,
  );
}

/**
 * The `PullRequestCodeComment` arm's mail (notify.go:113-117 →
 * MailMentionsComment, mail_comment.go:46-64). NOT the participants
 * funnel: upstream batches ONLY the code comment's resolved mentions
 * (mailIssueCommentBatch over `mentions`, `visited = {poster}`,
 * fromMention=true) — a watcher who is not mentioned gets nothing from a
 * code comment. The batch filter is upstream's: IsMailable, the
 * preference gate with fromMention=true admitting onmention
 * (mail_issue.go:141-146), the poster excluded via the pre-seeded visited,
 * and CheckRepoUnitUser visibility. Compose: ActionType ActionCommentPull →
 * name "comment" → template default.tmpl (no comment file at the pin) —
 * no action line, the code comment's content IS the body, every recipient
 * carries the IsMention line (fromMention=true for the whole batch),
 * link/Message-ID carry the type-21 comment, the reply token binds it.
 * Dedupe `pull-code-comment:<commentId>:<recipientId>`.
 */
export async function notifyPullRequestCodeComment(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; comment: CommentMailRow; doer: UserRow; mentions: UserRow[] },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  // The receiver's master gate first (MailMentionsComment's MailService nil
  // arm — no point reading rows for a disabled mailer).
  if (env.MAIL_ENABLED !== "true") return { outcome: "disabled" };
  const pair = await findRepositoryById(env.DB, input.issue.repoId);
  if (pair === null) {
    console.error(`[mail] code-comment mail skipped: repository row missing [id: ${input.issue.repoId}]`);
    return { outcome: "no-recipients" };
  }
  // mailIssueCommentBatch's filter (mail_issue.go:122-151) over the mentions
  // batch: IsMailable → preference (fromMention=true: enabled/andyourown/
  // onmention all pass, disabled does not) → visited (the poster is
  // pre-seeded, mail_comment.go:53) → CheckRepoUnitUser.
  const recipients: UserRow[] = [];
  for (const user of input.mentions) {
    if (user.id === input.doer.id) continue; // visited pre-seed (:53)
    if (!isMailable(user)) continue;
    const pref =
      (await drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, user.id)).get())
        ?.emailNotificationsPreference ?? "enabled";
    if (pref === "disabled") continue;
    // CheckRepoUnitUser (repo_permission.go:660-672), the resolution's fold:
    // admin short-circuit, public reads to everyone, private needs a grant.
    if (!(user.isAdmin || pair.repo.visibility === "public" || (await doerRepoAccessMode(env.DB, pair.repo, user.id)) !== "none")) {
      continue;
    }
    recipients.push(user);
  }
  // Compose over the pre-resolved batch — every recipient rides the mention
  // batch (mentions ARE the recipients, so IsMention=true per compose).
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      comment: input.comment,
      actionName: "comment",
      content: input.comment.content ?? "",
      dedupePrefix: "pull-code-comment",
      mentions: recipients,
      recipients,
    },
    options,
  );
}

/**
 * The `PullRequestReviewRequest` arm's mail (notify.go:129-136 →
 * SendIssueAssignedMail, mail_issue.go:200-232) — the IssueChangeAssignee
 * twin: the sole recipient is the requested reviewer, NOT the participants
 * funnel. The RECEIVER gates (notify.go:130-131): only the ADD fires
 * (`isRequest` — the removal's `comment != nil` still calls the receiver,
 * which self-gates it off), not to self (`doer.ID != reviewer.ID`), and
 * the reviewer's preference is not disabled; IsMailable filters inside the
 * send (the langMap build, :213-217). The compose is composeIssueCommentMessages
 * over `{ActionType: 0, Content: "Requested to review <htmlurl>.", Comment:
 * <the type-27 row>}` with info "issue assigned" (:222): the link AND the
 * Message-ID carry the type-27 comment; the compose's comment-type switch
 * has NO ReviewRequest case (actionToTemplate :258-268) → name "default" →
 * default.tmpl — NO action line, the rendered content ("Requested to
 * review <link>.") IS the body. The type-27 comment carries NO
 * HasMailReplySupport (comment.go:196-201) → the reply payload is nil:
 * no Reply-To/List-Post, a bare thread References (the unsubscribe token
 * still rides, :195-201). Dedupe
 * `pull-review-request:<commentId>:<recipientId>`.
 */
export async function notifyPullRequestReviewRequest(
  env: MailNotifyEnv,
  input: { issue: IssueMailRow; comment: CommentMailRow; doer: UserRow; reviewer: UserRow; isRequest: boolean },
  options: { now?: Date } = {},
): Promise<MailNotifyOutcome> {
  // The receiver gates (notify.go:130-131) — order upstream's.
  if (!input.isRequest) return { outcome: "no-recipients" };
  if (input.doer.id === input.reviewer.id) return { outcome: "no-recipients" };
  const reviewerPref =
    (await drizzle(env.DB).select().from(userSettings).where(eq(userSettings.userId, input.reviewer.id)).get())
      ?.emailNotificationsPreference ?? "enabled";
  if (reviewerPref === "disabled") return { outcome: "no-recipients" };
  // SendIssueAssignedMail's prelude (mail_issue.go:203-211): the master
  // gate + the MAIL_FROM parse + the repo pair load.
  const pre = await mailArmPrelude(
    env,
    "review-request mail",
    `review-request mail for comment ${input.comment.id}`,
    input.issue.repoId,
  );
  if (!pre.ok) return pre.outcome;
  // The langMap's IsMailable filter (mail_issue.go:213-217).
  if (!isMailable(input.reviewer)) return { outcome: "no-recipients" };

  // `ct := fmt.Sprintf("Requested to review %s.", issue.HTMLURL(ctx))`
  // (notify.go:132) — the FULL html url (origin + owner/repo/pulls|issues/
  // index), rendered by the compose like every Content.
  const origin = appUrlWithSlash(env.APP_URL);
  const issueHtmlUrl = issueMailUrl(
    origin,
    pre.pair.repo.ownerNamespace,
    pre.pair.repo.slug,
    input.issue.isPull,
    input.issue.index,
  );
  return notifyIssueArm(
    env,
    {
      issue: input.issue,
      doer: input.doer,
      comment: input.comment,
      actionName: "default",
      content: `Requested to review ${issueHtmlUrl}.`,
      dedupePrefix: "pull-review-request",
      recipients: [input.reviewer],
      info: "issue assigned",
    },
    options,
  );
}
