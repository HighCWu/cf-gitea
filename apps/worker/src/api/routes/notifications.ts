import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { CommentType } from "../../issues/comment-types";
import type { IssueRow } from "../../issues/service";
import {
  comments,
  issueSubscriptions,
  issues,
  notificationStates,
  pullRequests,
  repositories,
  repoTransfer,
  repoWatchers,
  ReviewType,
  userSettingsKv,
  users,
} from "../../db/schema";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositorySchema, type Repository } from "../models/repository";
import { parseListOptions, setPaginationHeaders, type ListOptions } from "../pagination";
import { WatchMode } from "../services/repo-watchers";
import { requireVisibleRepo } from "../services/repo-access";
import { goRfc3339ParseError, parseQueryTime } from "../services/issues";
import { apiRepositoryUrl, toApiRepository, viewerOf, type Viewer } from "../services/repository";

/**
 * Tier-2 notifications — the frozen contract's `notification` tag, all 7
 * operations (SPEC-0004 §2.6 tier-3 row promoted):
 *
 *   GET   /notifications                        (notifyGetList)
 *   PUT   /notifications                        (notifyReadList)
 *   GET   /notifications/new                    (notifyNewAvailable)
 *   GET   /notifications/threads/{id}           (notifyGetThread)
 *   PATCH /notifications/threads/{id}           (notifyReadThread)
 *   GET   /repos/{owner}/{repo}/notifications   (notifyGetRepoList)
 *   PUT   /repos/{owner}/{repo}/notifications   (notifyReadRepoList)
 *
 * There is NO threads/{id}/pin pair in the vendored contract (pin is a
 * status value carried by `to-status`, not an endpoint).
 *
 * Upstream behavior references (submodule pin fc4936884584):
 *   - routers/api/v1/notify/{user,repo,threads,notifications}.go — the four
 *     handlers, the find-options builder (getFindNotificationOptions) and
 *     the status-string mapping (statusStringsToNotificationStatuses);
 *   - models/activities/notification.go — the Notification row, the status
 *     enum (unread=1/read=2/pinned=3) and the per-(user, issue) identity;
 *   - models/activities/notification_list.go — FindNotificationOptions
 *     filters and the `updated_unix DESC` ordering (ToOrders, :65-67);
 *   - services/convert/notification.go — the NotificationThread serializer
 *     (Unread = !(read || pinned), subject URLs, latest comment, the
 *     stripped permissions block);
 *   - services/context/utils.go GetQueryBeforeSince — RFC3339 since/before
 *     parse failures are 422 (via the shared parseQueryTime);
 *   - routers/api/v1/notify/user.go:133-144 — last_read_at parse failure is
 *     400; routers/api/v1/api.go:1043-1051,1563-1566 — every operation is
 *     reqToken + the `notification` token-scope category (+ rejectPublicOnly
 *     on the /notifications group).
 *
 * DATA MODEL (deviations from upstream, all deliberate):
 *
 * 1. Derived threads, not materialized rows. Upstream inserts a notification
 *    row per recipient per issue at activity time
 *    (CreateOrUpdateIssueNotifications, notification_list.go:73) and the API
 *    reads those rows. Our thread set is DERIVED from real issue/comment
 *    activity at read time: an issue is a thread for user U iff U is a
 *    recipient (repo owner, repo watcher, issue poster, explicit issue
 *    subscriber, comment participant, mentioned user, assignee, or
 *    requested reviewer — deviation 4) AND at least one activity event on
 *    the issue was authored by someone else (upstream excludes the activity
 *    author from the recipients too — notification_list.go:135
 *    `delete(toNotify, notificationAuthorID)`). Activity events are the
 *    issue creation (poster, created_unix) and every comment (poster,
 *    coalesce(updated_unix, created_unix)); issue title/body edits are NOT
 *    events (the issue row records no editor).
 * 2. Read/pin state is the only materialized state: `notification_states`
 *    (one row per user per issue, migration 0011). A thread is unread while
 *    its last foreign-authored activity is newer than the stored read marker
 *    (0 = never read); pinning is a flag and implies non-unread (upstream's
 *    `Unread = !(read || pinned)`), so new activity after a read re-marks the
 *    thread unread without a write-path hook into the issue services.
 * 3. Thread id = the underlying issues.id. Upstream ids are per-notification
 *    rows (two users watching one issue hold different ids); ours are the
 *    globally-unique issue row ids, so both users address their own view of
 *    the same thread by the same number. GET/PATCH ownership mirrors
 *    threads.go getThread: missing issue → 404, non-recipient caller → 403
 *    (exact upstream message), site admin bypasses the recipient check (and
 *    falls back to the global latest activity when they authored every
 *    event); a recipient with no foreign activity has no mailbox entry → 404.
 * 4. Recipient set = upstream's toNotify union (notification_list.go:93-133):
 *    owner ∪ repo_watchers (mode-aware: a Dont/ignore row does NOT qualify —
 *    the migration-0053 mode columns closed the "untyped rows" gap; the
 *    per-type include matching upstream applies, GetRepoWatchersIDs'
 *    include_<type> arm, watch.go:266-292, is still not ported here; and
 *    WIP-PR titles drop the arm at read time — notification_list.go:100,
 *    evaluated against the CURRENT title, so a rename re-qualifies or
 *    retires the watcher's view of past activity) ∪ issue poster ∪ explicit
 *    issue subscribers ∪ comment participants ∪ mentioned (issue_user
 *    is_mentioned) ∪ assignees ∪ requested reviewers (pull_reviews
 *    type=Request). One whole-union gate mirrors upstream's post-assembly
 *    pass: the mute rule (ignorers removed AFTER every source — "muting
 *    the repository outranks every other source, including mentions",
 *    notification_list.go:135-141; the mail fan-out's twin at
 *    services/mail/notify.ts). The B-72-era bot skip (a users.type='user'
 *    conjunct beside the mute rule) is RETIRED at the repin: upstream
 *    e7629a62b4 (#40254, in the 099abf5db4 window) removed the
 *    IsTypeBot skips — bots now receive issue/PR notification rows (mail
 *    still excludes them; the permission checks — units, mute — still
 *    gate), so a bot caller resolves threads here through the same union.
 *    Access-revoked users remain excluded upstream-only (no revocation
 *    model).
 * 5. Subject sources: Issue/Pull derive from issue activity;
 *    `repository` matches the pending-transfer thread leg (deviation 7);
 *    `commit` filters still match nothing — no commit notification source
 *    exists on this tree.
 * 6. 205 responses carry NO body. Upstream returns the marked
 *    NotificationThreadList JSON with 205; Cloudflare's runtime enforces the
 *    fetch spec's null-body rule ("Response with null body status … cannot
 *    have a body"), so the body is dropped and the marked set is observable
 *    via a follow-up GET. The declared code stays 205 (contract subset).
 * 7. The repository-source class (B-65's completion, the pending-transfer
 *    thread) rides the same API by DERIVATION: upstream materializes one
 *    Notification row per recipient at request time
 *    (CreateRepoTransferNotification, notification.go:119-155); ours derives
 *    at read time from the `repo_transfer` pending row itself
 *    (UNIQUE(repo_id) — the row IS the transfer's existence), so a thread
 *    lives exactly as long as the pending request (upstream's rows persist
 *    after accept/reject — the recorded delta of the same fold). Thread id =
 *    NEGATIVE repo_transfer.id (positive ids would shadow issue ids — the
 *    disjoint sign convention; the single-thread lookup branches on it).
 *    Read/pin state materializes in `user_settings_kv` under
 *    `notifications.repo_state.<repoId>` (JSON `{readAt, pinned}` — an
 *    absent row is unread), written by the mark paths' KV arm (the
 *    markThreads twin). Recipients = the transfer's target user OR, for an
 *    org target, the canCreateOrgRepo grant set (services/orgs/orgs.ts:687's
 *    exact disjunction over the collapsed owners-team bridge); NO mute arm
 *    (upstream's mute pass is the issue-source assembly's own post-join,
 *    notification_list.go:135-141 — this class holds no watcher rows to
 *    mute). The B-72-era bot skip (upstream notification.go:129/140 then;
 *    the repoRecipientExpr conjunct) is RETIRED at the repin —
 *    e7629a62b4 (#40254) removed both upstream, so a bot target user and
 *    bot org-grantees resolve the transfer thread like anyone else. The
 *    subject
 *    renders upstream's Repository arm verbatim (convert/notification.go:
 *    87-94): title = the full name, URL = the RELATIVE repo path (the
 *    converter's own FIXME kept), absolute html_url, the empty
 *    latest-comment pair, and the ZERO NotifySubjectStateType "" — hence
 *    the widened wire enum (the 201-transfer RUNTIME_ONLY precedent). The
 *    thread's updated_at = max(updated_at, created_at): upstream's xorm
 *    `updated` tag insert-stamps UpdatedUnix, our pending rows carry the
 *    insert-time created_at (the column default) while updated_at stays 0
 *    until a stamping writer lands (the schema's recorded port-when-read
 *    follow-up). Pagination merges both legs — each fetches
 *    top-(page*limit), the merge sorts updated_at DESC then SERIALIZED id
 *    DESC and slices the page window — and X-Total-Count, NewAvailable and
 *    the mark sweep ride the merged totals (the mark sweep carries no
 *    subject-type param, so its repo leg always rides). The web purge
 *    page's derivation copy (ui/pages/notifications.tsx) stays
 *    issue-source-only this wave — the transfer-pending class rides the API
 *    totals only (follow-up for the ui owner).
 *
 * Undeclared runtime codes (kept out of the orchestrator RUNTIME_ONLY tables
 * by this batch — the landed route-module convention): 401 anonymous
 * (upstream reqToken), 400 bad last_read_at (user.go:137), 422 bad
 * since/before (GetQueryBeforeSince). Auth: every operation requires a token
 * (requireAuth) plus the `notification` token-scope category
 * (api/scope-gate.ts:95-97,162 — the category is registered on both the
 * global /notifications and the repo-scoped notifications subtrees) and the
 * public-only-token rejection (auth/middleware.ts rejectPublicOnly) — both
 * LANDED (the census NF12 defect that called them pending is retired).
 */

// ---------------------------------------------------------------------------
// Wire schemas (contract definitions NotificationThread /
// NotificationSubject / NotificationCount — field-for-field mirrors; the Go
// structs carry no omitempty, so every field always serializes).
// ---------------------------------------------------------------------------

const notificationSubjectSchema = z.object({
  title: z.string().openapi({ description: "Title is the title of the notification subject" }),
  url: z.string().openapi({ description: "URL is the API URL for the notification subject" }),
  latest_comment_url: z.string().openapi({ description: "LatestCommentURL is the API URL for the latest comment" }),
  html_url: z.string().openapi({ description: "HTMLURL is the web URL for the notification subject" }),
  latest_comment_html_url: z
    .string()
    .openapi({ description: "LatestCommentHTMLURL is the web URL for the latest comment" }),
  type: z
    .enum(["Issue", "Pull", "Commit", "Repository"])
    .openapi({ description: "Type indicates the type of the notification subject" }),
  state: z
    .enum(["open", "closed", "merged", ""])
    .openapi({
      description: "State indicates the current state of the notification subject",
      // The "" arm is upstream's zero NotifySubjectStateType: the
      // Repository subject arm (convert/notification.go:87-94) never sets
      // State, so the serializer emits the zero value — the swagger enum
      // [open,closed,merged] misses it (the 201-transfer RUNTIME_ONLY
      // precedent; module doc deviation 7).
    }),
});

const notificationThreadSchema = z.object({
  id: z
    .number()
    .int()
    .openapi({ format: "int64", description: "ID is the unique identifier for the notification thread" }),
  repository: repositorySchema.openapi({
    description: "Repository is the repository associated with the notification",
  }),
  subject: notificationSubjectSchema.openapi({
    description: "Subject contains details about the notification subject",
  }),
  unread: z.boolean().openapi({ description: "Unread indicates if the notification has been read" }),
  pinned: z.boolean().openapi({ description: "Pinned indicates if the notification is pinned" }),
  updated_at: z
    .string()
    .openapi({ format: "date-time", description: "UpdatedAt is the time when the notification was last updated" }),
  url: z.string().openapi({ description: "URL is the API URL for this notification thread" }),
});

const notificationThreadListSchema = z.array(notificationThreadSchema);

const notificationCountSchema = z.object({
  new: z.number().int().openapi({ format: "int64", description: "New is the number of unread notifications" }),
});

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const threadListResponse = {
  description: "NotificationThreadList",
  content: { "application/json": { schema: notificationThreadListSchema } },
} as const;

const threadResponse = {
  description: "NotificationThread",
  content: { "application/json": { schema: notificationThreadSchema } },
} as const;

const countResponse = {
  description: "NotificationCount",
  content: { "application/json": { schema: notificationCountSchema } },
} as const;

/** 205 reset-content — declared with the contract's response name; the
 *  runtime body is empty (module doc deviation 6). */
const resetContentResponse = { description: "NotificationThreadList" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const pageQuery = z
  .string()
  .optional()
  .openapi({ type: "integer", description: "page number of results to return (1-based)" });
const limitQuery = z.string().optional().openapi({ type: "integer", description: "page size of results" });

const rfc3339Query = (description: string) => z.string().optional().openapi({ format: "date-time", description });

const listQuery = {
  query: z.object({
    all: z
      .string()
      .optional()
      .openapi({ type: "boolean", description: "If true, show notifications marked as read. Default value is false" }),
    "status-types": z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        description:
          "Show notifications with the provided status types (repeated query params). Options are: unread, read and/or pinned. Defaults to unread & pinned.",
      }),
    "subject-type": z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        description:
          "filter notifications by subject type (repeated query params). Options are: issue, pull, commit, repository.",
      }),
    since: rfc3339Query("Only show notifications updated after the given time. This is a timestamp in RFC 3339 format"),
    before: rfc3339Query("Only show notifications updated before the given time. This is a timestamp in RFC 3339 format"),
    page: pageQuery,
    limit: limitQuery,
  }),
} as const;

const readQuery = {
  query: z.object({
    last_read_at: rfc3339Query(
      "Describes the last point that notifications were checked. Anything updated since this time will not be updated.",
    ),
    all: z
      .string()
      .optional()
      .openapi({ description: "If true, mark all notifications on this repo. Default value is false" }),
    "status-types": z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        description:
          "Mark notifications with the provided status types (repeated query params). Options are: unread, read and/or pinned. Defaults to unread.",
      }),
    "to-status": z.string().optional().openapi({ description: "Status to mark notifications as, Defaults to read." }),
  }),
} as const;

const repoReadQuery = {
  query: z.object({
    all: z
      .string()
      .optional()
      .openapi({ description: "If true, mark all notifications on this repo. Default value is false" }),
    "status-types": z
      .union([z.string(), z.array(z.string())])
      .optional()
      .openapi({
        description:
          "Mark notifications with the provided status types (repeated query params). Options are: unread, read and/or pinned. Defaults to unread.",
      }),
    "to-status": z.string().optional().openapi({ description: "Status to mark notifications as. Defaults to read." }),
    last_read_at: rfc3339Query(
      "Describes the last point that notifications were checked. Anything updated since this time will not be updated.",
    ),
  }),
} as const;

const threadIdParams = {
  params: z.object({
    id: z.string().min(1).openapi({ description: "id of notification thread" }),
  }),
} as const;

const readThreadQuery = {
  query: z.object({
    "to-status": z.string().optional().openapi({ description: "Status to mark notifications as", default: "read" }),
  }),
} as const;

// ---------------------------------------------------------------------------
// Query-param parsing (upstream base_form.go / notify package semantics).
// ---------------------------------------------------------------------------

type ThreadStatus = "unread" | "read" | "pinned";
type SubjectSource = "issue" | "pull" | "commit" | "repository";

/** `Base.FormBool` — strconv.ParseBool's truthy set plus "on" (case-folded). */
function parseFormBool(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  const value = raw.toLowerCase();
  return value === "1" || value === "t" || value === "true" || value === "on";
}

/**
 * `statusStringsToNotificationStatuses` (notify/repo.go:32-44): unknown
 * values are dropped; an EMPTY input falls back to the defaults, but a
 * provided-but-all-unknown input yields NO filter (upstream's empty result
 * slice defeats the ToConds length check).
 */
function parseStatusTypes(values: string[], defaults: ThreadStatus[]): ThreadStatus[] {
  if (values.length === 0) {
    return defaults;
  }
  const parsed = values
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is ThreadStatus => value === "unread" || value === "read" || value === "pinned");
  return [...new Set(parsed)];
}

/**
 * `subjectToSource` (notify/notifications.go:63-77): case-folded enum match;
 * unknown values dropped; unknown-only input → no filter (null here).
 */
function parseSubjectTypes(values: string[]): SubjectSource[] | null {
  if (values.length === 0) {
    return null;
  }
  const parsed = values
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is SubjectSource => {
      return value === "issue" || value === "pull" || value === "commit" || value === "repository";
    });
  return parsed.length === 0 ? null : [...new Set(parsed)];
}

/** `statusStringToNotificationStatus` — unknown/absent → read (the default). */
function parseToStatus(raw: string | null | undefined): ThreadStatus {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "unread":
      return "unread";
    case "pinned":
      return "pinned";
    default:
      return "read";
  }
}

/**
 * last_read_at (notify/user.go:133-144): RFC3339 only, failures are 400 with
 * Go's parse error text; Go's zero time parses back to "unbounded" (0).
 */
function parseLastReadAt(raw: string | null): number {
  const value = (raw ?? "").trim();
  if (value === "") {
    return 0;
  }
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() === Date.parse("0001-01-01T00:00:00Z")
  ) {
    throw new ApiError(400, goRfc3339ParseError(value));
  }
  return Math.floor(parsed.getTime() / 1000);
}

/** Go PathParamInt64 — non-integer path ids become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Derived-thread queries (module doc deviations 1-2 for the model).
// ---------------------------------------------------------------------------

/** One derived notification thread with everything the serializer needs. */
interface DerivedThread {
  issue: IssueRow;
  repo: typeof repositories.$inferSelect;
  owner: typeof users.$inferSelect;
  pull: { hasMerged: boolean } | null;
  /** The caller's state row (null when never touched) — only the two
   *  fields the status resolver reads; the select is column-trimmed to
   *  keep the whole-table join under D1's result-set column cap (the
   *  FN-4 regression: five whole tables + 18 new repositories columns
   *  pushed the wide list query over it). */
  state: { pinned: boolean; readAtUnix: number } | null;
  /** Unix seconds of the last activity authored by someone else. */
  lastActivity: number;
  /** Latest CommentType.Comment id on the issue (upstream GetLastComment). */
  lastCommentId: number | null;
}

interface ThreadQuery {
  userId: number;
  /** Repo-scoped variant (notifyGetRepoList / notifyReadRepoList). */
  repoId?: string;
  /** `since` — lastActivity >= (upstream Gte). 0/undefined = unbounded. */
  updatedAfter?: number;
  /** `before` / last_read_at — lastActivity <= (upstream Lte). 0 = unbounded. */
  updatedBefore?: number;
  /** Status filter; empty/undefined = no filter (all=true or unknown-only). */
  statuses?: ThreadStatus[];
  /** `subject-type` filter; null = no filter. */
  sources?: SubjectSource[] | null;
  /** Pagination; undefined = the unbounded mark-list sweep. */
  listOptions?: ListOptions;
}

/**
 * Last foreign-authored activity on an issue, as a correlated SQL scalar:
 * MAX(latest foreign comment time, the issue creation when the poster is not
 * the user). References issues columns — only valid over a query FROM
 * `issues` (unix seconds everywhere; the columns are raw INTEGERs).
 */
function lastActivityExpr(userId: number): SQL {
  return sql`max(
    coalesce((select max(coalesce(c.updated_unix, c.created_unix)) from comments c
      where c.issue_id = ${issues.id} and (c.poster_id is null or c.poster_id <> ${userId})), 0),
    case when ${issues.posterId} is not null and ${issues.posterId} <> ${userId}
      then coalesce(${issues.createdAt}, 0) else 0 end
  )`;
}

/** Global latest activity (any author) — the admin-corner fallback. */
function lastAnyActivityExpr(): SQL {
  return sql`max(
    coalesce(${issues.createdAt}, 0),
    coalesce((select max(coalesce(c.updated_unix, c.created_unix)) from comments c where c.issue_id = ${issues.id}), 0)
  )`;
}

/**
 * `HasWorkInProgressPrefix` (models/issues/pull.go:652-658) as a SQL
 * fragment — the same prefix set as the mail layer's `hasWorkInProgressPrefix`
 * (api/services/issues.ts `WIP_PREFIXES`, the upstream
 * setting.Repository.PullRequest.WorkInProgressPrefixes default verbatim,
 * modules/setting/repository.go:199; kept in literal sync — that constant is
 * not exported and this module owns no shared file). SQLite LIKE is ASCII
 * case-insensitive, the helper's own matching rule; no prefix contains a
 * LIKE metacharacter ("[" is literal in SQLite).
 */
const RECIPIENT_WIP_PREFIXES: readonly string[] = ["WIP:", "[WIP]"];

/** The WIP-title match over the issues row in scope (reads issues.title). */
function wipTitleExpr(): SQL {
  return sql`(${sql.join(
    RECIPIENT_WIP_PREFIXES.map((prefix) => sql`${issues.title} like ${`${prefix}%`}`),
    sql` or `,
  )})`;
}

/**
 * The recipient predicate (module doc deviation 4); needs the repositories
 * join plus the repo_watchers / issue_subscriptions left joins in scope.
 * The arms mirror upstream's toNotify assembly
 * (createOrUpdateIssueNotifications, notification_list.go:93-133): repo
 * watchers (GetRepoWatchersIDs), the poster/participants (ours split into
 * poster / explicit subscribers / comment participants), the is_mentioned
 * carrier (issue_user, migration 0057 — upstream's mail fan-out mails the
 * resolved mentions as their OWN batch first of all sources,
 * "========== Mentions ==========", services/mailer/mail_issue.go:99-105,
 * fed by FindAndUpdateIssueMentions' resolved users, which our carrier
 * persists at the same emit positions), assignees (GetAssigneeIDsByIssue)
 * and requested reviewers (GetPullRequestRequestedReviewerIDs — pull-reviews
 * `type = Request` rows with a user reviewer, the same shape our
 * pull_reviews table mirrors; the isPull guard mirrors upstream's
 * `if issue.IsPull` around the reviewer query).
 *
 * TWO gates apply to the WHOLE union, not to a single arm, mirroring
 * upstream's post-assembly passes:
 * - The mute rule: repo ignorers (watch mode=Dont, GetRepoIgnorersIDs,
 *   watch.go:244-251) are removed from toNotify AFTER every source joined —
 *   "muting the repository outranks every other source, including mentions"
 *   (notification_list.go:135-141). The mail fan-out applies the same rule
 *   (services/mail/notify.ts: the ignorer set joins `visited` ahead of
 *   every batch) — this conjunct is the mailbox twin, so an ignorer who
 *   commented / was mentioned / is the poster loses the thread too. The
 *   watchers arm itself still carries the mode<>Dont guard (a Dont row
 *   never qualifies on its own, GetRepoWatchersIDs' `watch.mode<>?`,
 *   watch.go:281; the Auto-unwatch landing, watch.go:164-165).
 * - The WIP-PR rule: while a pull's title carries a WIP prefix, the
 *   repo-watchers arm does NOT qualify — upstream guards ONLY that arm at
 *   notify time (`if !(issue.IsPull && HasWorkInProgressPrefix(issue.Title))`
 *   around the GetRepoWatchersIDs add, notification_list.go:100); every
 *   other arm still receives. Gate evaluated against the CURRENT title —
 *   a rename re-qualifies/retires the watcher's view of past activity
 *   (derived-model timing, deviation 1).
 *
 * Bot recipients: upstream skipped user.IsTypeBot() users when
 * materializing (notification_list.go:158-160 at fc49368845 — a bot never
 * got a notification row, so its mailbox stayed empty and getThread found
 * no row) and this port mirrored that with a whole-union users.type='user'
 * conjunct beside the mute rule (B-72 handoff 4). RETIRED at the repin:
 * e7629a62b4 (#40254, in the 099abf5db4 window) removed the
 * materialization skip — bots get rows, so a bot caller resolves the same
 * union's threads here (mute rule and unit checks still gate; upstream
 * mail still excludes bots — the funnel files never carried the skip).
 */
function recipientExpr(userId: number): SQL {
  return sql`(
    (
      (
        (${repoWatchers.userId} is not null and ${repoWatchers.mode} <> ${WatchMode.Dont})
        and not (${issues.isPull} = 1 and ${wipTitleExpr()})
      )
      or ${repositories.ownerId} = ${userId}
      or ${issues.posterId} = ${userId}
      or ${issueSubscriptions.userId} is not null
      or exists (select 1 from comments pc where pc.issue_id = ${issues.id} and pc.poster_id = ${userId})
      or exists (
        select 1 from issue_user mu
        where mu.issue_id = ${issues.id} and mu.user_id = ${userId} and mu.is_mentioned = 1
      )
      or exists (
        select 1 from issue_assignees aa
        where aa.issue_id = ${issues.id} and aa.assignee_id = ${userId}
      )
      or (
        ${issues.isPull} = 1
        and exists (
          select 1 from pull_reviews rr
          where rr.issue_id = ${issues.id} and rr.type = ${ReviewType.Request} and rr.reviewer_id = ${userId}
        )
      )
    )
    and not exists (
      select 1 from repo_watchers ig
      where ig.repo_id = ${issues.repoId} and ig.user_id = ${userId} and ig.mode = ${WatchMode.Dont}
    )
  )`;
}

/** Derived-status predicate over the notification_states left join (the OR
 *  join is parenthesized — AND binds tighter than OR). */
function statusExpr(statuses: ThreadStatus[], lastActivity: SQL): SQL {
  const parts: SQL[] = [];
  if (statuses.includes("unread")) {
    parts.push(
      sql`(${notificationStates.userId} is null or (${notificationStates.pinned} = 0 and coalesce(${notificationStates.readAtUnix}, 0) < (${lastActivity})))`,
    );
  }
  if (statuses.includes("read")) {
    parts.push(
      sql`(${notificationStates.userId} is not null and ${notificationStates.pinned} = 0 and ${notificationStates.readAtUnix} >= (${lastActivity}))`,
    );
  }
  if (statuses.includes("pinned")) {
    parts.push(sql`${notificationStates.pinned} = 1`);
  }
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** subject-type → source predicate; commit/repository match nothing (§5). */
function sourceExpr(sources: SubjectSource[]): SQL {
  const parts = sources.map((source): SQL => {
    if (source === "issue") {
      return sql`${issues.isPull} = 0`;
    }
    if (source === "pull") {
      return sql`${issues.isPull} = 1`;
    }
    return sql`0 = 1`;
  });
  return sql`(${sql.join(parts, sql` or `)})`;
}

/**
 * FROM/JOIN shape shared by the page and count queries below (spelled out
 * twice — the queries select different shapes). Every left join is
 * row-unique per issue (the watchers/subscribers/states PKs and the
 * pull_requests unique index), so the count never fans out.
 */
function threadCountQuery(db: DrizzleD1Database, userId: number) {
  return db
    .select({ value: sql<number>`count(*)` })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
    .leftJoin(
      issueSubscriptions,
      and(
        eq(issueSubscriptions.issueId, issues.id),
        eq(issueSubscriptions.userId, userId),
        eq(issueSubscriptions.isWatching, true),
      ),
    )
    .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)));
}

function threadRowQuery(db: DrizzleD1Database, userId: number, lastActivity: SQL) {
  return db
    .select({
      issue: issues,
      repo: repositories,
      owner: users,
      // Column-trimmed (the D1 result-set cap — see DerivedThread.state):
      // the serializer reads only pull.hasMerged and state's two fields;
      // issue/repo/owner stay whole (toApiRepository consumes them fully).
      pull: { hasMerged: pullRequests.hasMerged },
      state: { pinned: notificationStates.pinned, readAtUnix: notificationStates.readAtUnix },
      lastActivity: sql<number>`(${lastActivity})`,
    })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id))
    .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
    .leftJoin(
      issueSubscriptions,
      and(
        eq(issueSubscriptions.issueId, issues.id),
        eq(issueSubscriptions.userId, userId),
        eq(issueSubscriptions.isWatching, true),
      ),
    )
    .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)));
}

function threadConditions(query: ThreadQuery, lastActivity: SQL): SQL[] {
  const conditions: SQL[] = [
    // A thread exists only with foreign activity (the mailbox is per-user).
    sql`(${lastActivity}) > 0`,
    recipientExpr(query.userId),
  ];
  if (query.repoId !== undefined) {
    conditions.push(eq(issues.repoId, query.repoId));
  }
  if (query.updatedAfter !== undefined && query.updatedAfter > 0) {
    conditions.push(sql`(${lastActivity}) >= ${query.updatedAfter}`);
  }
  if (query.updatedBefore !== undefined && query.updatedBefore > 0) {
    conditions.push(sql`(${lastActivity}) <= ${query.updatedBefore}`);
  }
  if (query.statuses !== undefined && query.statuses.length > 0) {
    conditions.push(statusExpr(query.statuses, lastActivity));
  }
  if (query.sources !== null && query.sources !== undefined && query.sources.length > 0) {
    conditions.push(sourceExpr(query.sources));
  }
  return conditions;
}

/** Total matching threads (the X-Total-Count / notifyNewAvailable value). */
async function countThreads(d1: D1Database, query: ThreadQuery): Promise<number> {
  const db = drizzle(d1);
  const lastActivity = lastActivityExpr(query.userId);
  const rows = await threadCountQuery(db, query.userId).where(
    and(...threadConditions(query, lastActivity)),
  );
  return rows[0]?.value ?? 0;
}

async function fetchThreads(d1: D1Database, query: ThreadQuery): Promise<{ items: DerivedThread[]; total: number }> {
  const db = drizzle(d1);
  const lastActivity = lastActivityExpr(query.userId);
  const conditions = threadConditions(query, lastActivity);
  const total = await countThreads(d1, query);

  const rows = await threadRowQuery(db, query.userId, lastActivity)
    .where(and(...conditions))
    // Upstream ToOrders: `updated_unix DESC` (notification_list.go:65-67);
    // the row id is the deterministic tie-break.
    .orderBy(desc(sql`(${lastActivity})`), desc(issues.id))
    .limit(query.listOptions?.limit ?? -1)
    .offset(query.listOptions === undefined ? 0 : (query.listOptions.page - 1) * query.listOptions.limit);

  const items: DerivedThread[] = rows.map((row) => ({
    issue: row.issue,
    repo: row.repo,
    owner: row.owner,
    pull: row.pull,
    state: row.state,
    lastActivity: row.lastActivity,
    lastCommentId: null,
  }));
  await fillLastCommentIds(d1, items);
  return { items, total };
}

/**
 * GetLastComment (models/issues/issue.go:470-483): latest CommentTypeComment.
 *
 * Review-finding verdict (the "transition-pinned CommentID" claim): at this
 * pin the REST serializer does NOT render notification.CommentID —
 * services/convert/notification.go (both Source arms) calls
 * `n.Issue.GetLastComment(ctx)` for latest_comment_url/_html_url, which is
 * exactly this newest-CommentType.Comment-at-read-time query.
 * updateIssueNotification (models/activities/notification.go:176-196) pins
 * CommentID only on the read→unread transition, but that column feeds the
 * web-UI/mail surfaces, not this API — so newest-wins here IS upstream
 * parity, and the sequence test pins it across a re-mark transition.
 * (Tie-break: upstream orders by created_unix DESC with no id tiebreak;
 * max(id) is the deterministic stand-in for the same "latest" set.)
 */
async function fillLastCommentIds(d1: D1Database, items: DerivedThread[]): Promise<void> {
  const ids = items.map((item) => item.issue.id);
  if (ids.length === 0) {
    return;
  }
  const db = drizzle(d1);
  const latest = await db
    .select({ issueId: comments.issueId, id: sql<number>`max(${comments.id})` })
    .from(comments)
    .where(and(eq(comments.type, CommentType.Comment), inArray(comments.issueId, ids)))
    .groupBy(comments.issueId);
  const byIssue = new Map(latest.map((row) => [row.issueId, row.id]));
  for (const item of items) {
    item.lastCommentId = byIssue.get(item.issue.id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Marking (the read/pin write path — upstream SetNotificationStatus).
// ---------------------------------------------------------------------------

type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];
type BatchStatements = [BatchStatement, ...BatchStatement[]];

/**
 * Upsert the state rows for the marked threads in one D1 batch (one SQLite
 * transaction). `read` stamps the wall-clock marker (any later activity
 * re-marks unread), `unread` zeroes it, `pinned` only sets the flag (pinning
 * implies non-unread regardless of the marker, like upstream's status
 * replace — SetNotificationStatus writes the whole status value).
 */
async function markThreads(
  d1: D1Database,
  userId: number,
  threads: ReadonlyArray<{ issue: { id: number } }>,
  toStatus: ThreadStatus,
  now: Date,
): Promise<void> {
  if (threads.length === 0) {
    return;
  }
  const db = drizzle(d1);
  const nowUnix = Math.floor(now.getTime() / 1000);
  const statements: BatchStatement[] = threads.map((thread) =>
    db
      .insert(notificationStates)
      .values({
        userId,
        issueId: thread.issue.id,
        readAtUnix: toStatus === "read" ? nowUnix : 0,
        pinned: toStatus === "pinned",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notificationStates.userId, notificationStates.issueId],
        set:
          toStatus === "pinned"
            ? { pinned: true, updatedAt: now }
            : { readAtUnix: toStatus === "read" ? nowUnix : 0, pinned: false, updatedAt: now },
      }),
  );
  await db.batch(statements as BatchStatements);
}

// ---------------------------------------------------------------------------
// Serialization (services/convert/notification.go ToNotificationThread).
// ---------------------------------------------------------------------------

/** Resolved {unread, pinned} of a thread (upstream Unread = !(read||pinned)).
 *  Structural over both thread kinds: DerivedThread and RepoThread carry the
 *  same {state, lastActivity} view. */
function resolvedStatus(thread: {
  state: { pinned: boolean; readAtUnix: number } | null;
  lastActivity: number;
}): { unread: boolean; pinned: boolean } {
  if (thread.state !== null && thread.state.pinned) {
    return { unread: false, pinned: true };
  }
  if (thread.state !== null && thread.state.readAtUnix >= thread.lastActivity) {
    return { unread: false, pinned: false };
  }
  return { unread: true, pinned: false };
}

function toNotificationThread(
  viewer: Viewer,
  thread: DerivedThread,
  status: { unread: boolean; pinned: boolean },
): z.infer<typeof notificationThreadSchema> {
  const origin = viewer.origin;
  const pair = { repo: thread.repo, owner: thread.owner };
  const ownerNamespace = encodeURIComponent(thread.repo.ownerNamespace);
  const slug = encodeURIComponent(thread.repo.slug);
  const repoApiUrl = apiRepositoryUrl(pair, origin);
  const repoHtmlUrl = `${origin}/${ownerNamespace}/${slug}`;
  const isPull = thread.issue.isPull === true;
  const htmlPath = isPull ? "pulls" : "issues";
  const index = thread.issue.index;
  const state =
    isPull && thread.pull !== null && thread.pull.hasMerged === true
      ? "merged"
      : thread.issue.isClosed
        ? "closed"
        : "open";

  const repository: Repository = toApiRepository(viewer, pair);
  // Upstream nulls the permissions block on the whole parent chain
  // (services/convert/notification.go:40-43); there is no parent here.
  delete repository.permissions;

  return {
    id: thread.issue.id,
    repository,
    subject: {
      title: thread.issue.title,
      // Issue.APIURL is always the /issues/{index} API path, even for PRs
      // (models/issues/issue.go:374-380); the HTML URL switches on IsPull.
      url: `${repoApiUrl}/issues/${index}`,
      latest_comment_url: thread.lastCommentId === null ? "" : `${repoApiUrl}/issues/comments/${thread.lastCommentId}`,
      html_url: `${repoHtmlUrl}/${htmlPath}/${index}`,
      latest_comment_html_url:
        thread.lastCommentId === null ? "" : `${repoHtmlUrl}/${htmlPath}/${index}#issuecomment-${thread.lastCommentId}`,
      type: isPull ? "Pull" : "Issue",
      state,
    },
    unread: status.unread,
    pinned: status.pinned,
    updated_at: new Date(thread.lastActivity * 1000).toISOString(),
    url: `${origin}/api/v1/notifications/threads/${thread.issue.id}`,
  };
}

// ---------------------------------------------------------------------------
// The repository-source leg (module doc deviation 7): pending-transfer
// threads derived from `repo_transfer`, read/pin state in `user_settings_kv`.
// ---------------------------------------------------------------------------

/** The KV key namespace of the per-user repo-thread state (deviation 7). */
const REPO_STATE_KEY_PREFIX = "notifications.repo_state.";

interface RepoThreadState {
  pinned: boolean;
  readAtUnix: number;
}

/** One derived repository-source thread (the pending transfer's mailbox). */
interface RepoThread {
  transfer: typeof repoTransfer.$inferSelect;
  repo: typeof repositories.$inferSelect;
  owner: typeof users.$inferSelect;
  /** The caller's KV state row (null when never touched — unread). */
  state: RepoThreadState | null;
  /** max(updated_at, created_at) unix seconds — the xorm `updated`
   *  insert-stamp fold (deviation 7's updated_at note). */
  lastActivity: number;
}

function repoStateKey(repoId: string): string {
  return `${REPO_STATE_KEY_PREFIX}${repoId}`;
}

/** The stored KV value — `{readAt, pinned}` JSON; malformed → null (unread). */
function parseRepoState(raw: string | null): RepoThreadState | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { readAt?: unknown; pinned?: unknown };
    if (typeof parsed.readAt !== "number" || !(parsed.pinned === true || parsed.pinned === false || parsed.pinned === 0 || parsed.pinned === 1)) {
      return null;
    }
    return { readAtUnix: parsed.readAt, pinned: parsed.pinned === true || parsed.pinned === 1 };
  } catch {
    return null;
  }
}

/** The thread's updated_at over the transfer row (unix seconds; the columns
 *  are raw INTEGERs — see deviation 7 for the max() fold). */
function repoLastActivityExpr(): SQL {
  return sql`max(coalesce(${repoTransfer.updatedAt}, 0), coalesce(${repoTransfer.createdAt}, 0))`;
}

/**
 * The repository-source recipient predicate (deviation 7): the caller is a
 * recipient iff they are the transfer's TARGET USER, or — for an org target
 * — a member who can create repos in that org: OrgService.canCreateOrgRepo
 * (services/orgs/orgs.ts:687) mirrored as one SQL disjunction over the
 * collapsed owners-team bridge (`org_members.role='owner'`, SPEC-0007 §3.3)
 * OR a `team_members × teams` row with `can_create_org_repo` or
 * `authorize='owner'`, both scoped to the target org id. The org arms only
 * ever match org-id targets (membership rows exist for orgs alone). NO
 * mute arm. The B-72-era BOT SKIP (upstream notification.go:129's
 * IsTypeBot continue inside the org grant set and :140's
 * `!newOwner.IsTypeBot()` target refusal — the trailing users.type='user'
 * conjunct) is RETIRED at the repin: e7629a62b4 (#40254) removed both
 * upstream — a bot target and bot org-grantees receive the transfer
 * notification like anyone else.
 */
function repoRecipientExpr(userId: number): SQL {
  return sql`(
    ${repoTransfer.newOwnerId} = ${userId}
    or exists (
      select 1 from org_members om
      where om.org_id = ${repoTransfer.newOwnerId} and om.user_id = ${userId} and om.role = 'owner'
    )
    or exists (
      select 1 from team_members tm
      join teams t on t.id = tm.team_id
      where tm.user_id = ${userId} and t.org_id = ${repoTransfer.newOwnerId}
        and (t.can_create_org_repo = 1 or t.authorize = 'owner')
    )
  )`;
}

/**
 * The status predicate over the KV left join (the statusExpr twin; the state
 * rides a JSON TEXT column, so the fields extract at query time — D1's
 * SQLite carries JSON1). Same semantics as the issue leg: unread while no
 * state or unpinned-and-behind the marker; read when the marker covers the
 * activity; pinned when the flag is set (pinning implies non-unread).
 */
function repoStatusExpr(statuses: ThreadStatus[], lastActivity: SQL): SQL {
  const pinnedExpr = sql`coalesce(json_extract(${userSettingsKv.settingValue}, '$.pinned'), 0)`;
  const readAtExpr = sql`coalesce(json_extract(${userSettingsKv.settingValue}, '$.readAt'), 0)`;
  const parts: SQL[] = [];
  if (statuses.includes("unread")) {
    parts.push(sql`(${userSettingsKv.settingValue} is null or (${pinnedExpr} = 0 and ${readAtExpr} < (${lastActivity})))`);
  }
  if (statuses.includes("read")) {
    parts.push(
      sql`(${userSettingsKv.settingValue} is not null and ${pinnedExpr} = 0 and ${readAtExpr} >= (${lastActivity}))`,
    );
  }
  if (statuses.includes("pinned")) {
    parts.push(sql`${pinnedExpr} = 1`);
  }
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** The repo leg's filters (the ThreadQuery slice the leg consumes, plus the
 *  page-window bound). */
interface RepoThreadQuery {
  userId: number;
  repoId?: string;
  updatedAfter?: number;
  updatedBefore?: number;
  statuses?: ThreadStatus[];
  /** page*limit — undefined = unbounded (the mark sweep). */
  topK?: number;
}

function repoThreadConditions(query: RepoThreadQuery, lastActivity: SQL): SQL[] {
  const conditions: SQL[] = [repoRecipientExpr(query.userId)];
  if (query.repoId !== undefined) {
    conditions.push(eq(repoTransfer.repoId, query.repoId));
  }
  if (query.updatedAfter !== undefined && query.updatedAfter > 0) {
    conditions.push(sql`(${lastActivity}) >= ${query.updatedAfter}`);
  }
  if (query.updatedBefore !== undefined && query.updatedBefore > 0) {
    conditions.push(sql`(${lastActivity}) <= ${query.updatedBefore}`);
  }
  if (query.statuses !== undefined && query.statuses.length > 0) {
    conditions.push(repoStatusExpr(query.statuses, lastActivity));
  }
  return conditions;
}

/** The KV join arm — `setting_key = 'notifications.repo_state.' || repo_id`.
 *  (user_id, setting_key) is UNIQUE, so the left join never fans out. */
function repoStateJoin(userId: number) {
  return and(
    eq(userSettingsKv.userId, userId),
    sql`${userSettingsKv.settingKey} = ${REPO_STATE_KEY_PREFIX} || ${repoTransfer.repoId}`,
  );
}

/** Total matching repo threads (the merged totals' second summand). */
async function countRepoThreads(d1: D1Database, query: RepoThreadQuery): Promise<number> {
  const lastActivity = repoLastActivityExpr();
  const rows = await drizzle(d1)
    .select({ value: sql<number>`count(*)` })
    .from(repoTransfer)
    .leftJoin(userSettingsKv, repoStateJoin(query.userId))
    .where(and(...repoThreadConditions(query, lastActivity)));
  return rows[0]?.value ?? 0;
}

async function fetchRepoThreads(d1: D1Database, query: RepoThreadQuery): Promise<{ items: RepoThread[]; total: number }> {
  const db = drizzle(d1);
  const lastActivity = repoLastActivityExpr();
  const conditions = repoThreadConditions(query, lastActivity);
  const total = await countRepoThreads(d1, query);
  const rows = await db
    .select({
      transfer: repoTransfer,
      repo: repositories,
      owner: users,
      stateValue: userSettingsKv.settingValue,
      lastActivity: sql<number>`(${lastActivity})`,
    })
    .from(repoTransfer)
    .innerJoin(repositories, eq(repositories.id, repoTransfer.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(userSettingsKv, repoStateJoin(query.userId))
    .where(and(...conditions))
    // Upstream ToOrders `updated_unix DESC`; the tie-break reads the
    // SERIALIZED ids (deviation 7's merge note — the negative sign makes
    // "id desc" the deterministic, client-visible order).
    .orderBy(desc(sql`(${lastActivity})`), desc(sql`(-${repoTransfer.id})`))
    .limit(query.topK ?? -1)
    .offset(0);
  return {
    items: rows.map((row) => ({
      transfer: row.transfer,
      repo: row.repo,
      owner: row.owner,
      state: parseRepoState(row.stateValue),
      lastActivity: row.lastActivity,
    })),
    total,
  };
}

/** Single repo thread by NEGATIVE thread id (the threadById branch) — the
 *  same 404/403 shapes as the issue leg, exact upstream messages. */
async function repoThreadById(d1: D1Database, doer: { id: number; is_admin: boolean }, id: number): Promise<RepoThread> {
  const transferId = -id;
  const db = drizzle(d1);
  const rows = await db
    .select({ transfer: repoTransfer, repo: repositories, owner: users })
    .from(repoTransfer)
    .innerJoin(repositories, eq(repositories.id, repoTransfer.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(eq(repoTransfer.id, transferId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    // GetNotificationByID → db.ErrNotExist → 404 (notify/threads.go:105-112).
    throw new ApiError(404, `notification does not exist [id: ${id}]`);
  }
  const isRecipient =
    (
      await db
        .select({ one: sql<number>`1` })
        .from(repoTransfer)
        .where(and(eq(repoTransfer.id, transferId), repoRecipientExpr(doer.id)))
        .limit(1)
    ).length > 0;
  if (!isRecipient && !doer.is_admin) {
    // threads.go:114-117 — exact upstream message (the issue leg's twin).
    throw new ApiError(403, `only user itself and admin are allowed to read/change this thread ${id}`);
  }
  const stateRow = await db
    .select({ value: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, doer.id), eq(userSettingsKv.settingKey, repoStateKey(row.repo.id))))
    .get();
  return {
    transfer: row.transfer,
    repo: row.repo,
    owner: row.owner,
    state: parseRepoState(stateRow?.value ?? null),
    lastActivity: Math.max(row.transfer.updatedAt.getTime(), row.transfer.createdAt.getTime()) / 1000,
  };
}

/**
 * The KV arm of the mark paths (markThreads' twin): one
 * `notifications.repo_state.<repoId>` upsert per marked thread in one D1
 * batch. Same status rules as the issue leg — `read` stamps the wall-clock
 * marker, `unread` zeroes it, `pinned` only sets the flag (pinning implies
 * non-unread; the stored marker survives).
 */
async function markRepoThreads(
  d1: D1Database,
  userId: number,
  threads: ReadonlyArray<{ repo: { id: string } }>,
  toStatus: ThreadStatus,
  now: Date,
): Promise<void> {
  if (threads.length === 0) {
    return;
  }
  const db = drizzle(d1);
  const nowUnix = Math.floor(now.getTime() / 1000);
  const statements: BatchStatement[] = threads.map((thread) =>
    db
      .insert(userSettingsKv)
      .values({
        userId,
        settingKey: repoStateKey(thread.repo.id),
        settingValue: JSON.stringify({ readAt: toStatus === "read" ? nowUnix : 0, pinned: toStatus === "pinned" }),
      })
      .onConflictDoUpdate({
        target: [userSettingsKv.userId, userSettingsKv.settingKey],
        set:
          toStatus === "pinned"
            ? { settingValue: sql`json_set(${userSettingsKv.settingValue}, '$.pinned', json('true'))` }
            : {
                settingValue: sql`json_set(${userSettingsKv.settingValue}, '$.readAt', ${toStatus === "read" ? nowUnix : 0}, '$.pinned', json('false'))`,
              },
      }),
  );
  await db.batch(statements as BatchStatements);
}

/** The Repository subject's serialization (convert/notification.go:87-94) —
 *  byte-for-byte upstream: the relative-path URL (the converter's own FIXME
 *  kept), the empty latest-comment pair, and the zero state "" (the wire
 *  enum's widened arm). */
function toRepoNotificationThread(
  viewer: Viewer,
  thread: RepoThread,
  status: { unread: boolean; pinned: boolean },
): z.infer<typeof notificationThreadSchema> {
  const origin = viewer.origin;
  const pair = { repo: thread.repo, owner: thread.owner };
  const ownerNamespace = encodeURIComponent(thread.repo.ownerNamespace);
  const slug = encodeURIComponent(thread.repo.slug);
  const id = -thread.transfer.id;

  const repository: Repository = toApiRepository(viewer, pair);
  // Upstream nulls the permissions block on the whole parent chain
  // (services/convert/notification.go:40-43); there is no parent here.
  delete repository.permissions;

  return {
    id,
    repository,
    subject: {
      title: `${thread.repo.ownerNamespace}/${thread.repo.slug}`, // FullName
      // FIXME carried from upstream: "this is a relative URL, rather useless
      // and inconsistent, but keeping for backwards compat"
      // (convert/notification.go:91-92).
      url: `/${ownerNamespace}/${slug}`,
      latest_comment_url: "",
      html_url: `${origin}/${ownerNamespace}/${slug}`,
      latest_comment_html_url: "",
      type: "Repository",
      state: "",
    },
    unread: status.unread,
    pinned: status.pinned,
    updated_at: new Date(thread.lastActivity * 1000).toISOString(),
    url: `${origin}/api/v1/notifications/threads/${id}`,
  };
}

// ---------------------------------------------------------------------------
// Handlers (the list/read pair shared by the global and repo-scoped routes).
// The response constructors stay inline in the route handlers — the
// hono-zod-openapi Handler type wants the c.json/c.body call in its own body.
// ---------------------------------------------------------------------------

/** Shared list body: fetch both legs, merge, pagination headers, serialize. */
async function listThreadsPayload(
  c: Context<ApiEnv>,
  userId: number,
  repoId: string | undefined,
): Promise<z.infer<typeof notificationThreadListSchema>> {
  const url = new URL(c.req.url);
  const listOptions = parseListOptions(url);
  const updatedAfter = parseQueryTime(url.searchParams.get("since")) ?? undefined;
  const updatedBefore = parseQueryTime(url.searchParams.get("before")) ?? undefined;
  const statuses = parseFormBool(url.searchParams.get("all"))
    ? []
    : parseStatusTypes(url.searchParams.getAll("status-types"), ["unread", "pinned"]);
  const sources = parseSubjectTypes(url.searchParams.getAll("subject-type"));
  // The two-leg top-K merge (module doc deviation 7): each leg fetches
  // top-(page*limit), the merge sorts updated DESC / serialized-id DESC and
  // slices the page window. The repository-source leg rides only when the
  // subject-type filter admits it (commit stays match-nothing).
  const repoLegAdmitted = sources === null || sources.includes("repository");
  const topK = listOptions.page * listOptions.limit;
  const [issuePage, repoPage] = await Promise.all([
    fetchThreads(c.env.DB, { userId, repoId, updatedAfter, updatedBefore, statuses, sources, listOptions: { page: 1, limit: topK } }),
    repoLegAdmitted
      ? fetchRepoThreads(c.env.DB, { userId, repoId, updatedAfter, updatedBefore, statuses, topK })
      : Promise.resolve({ items: [] as RepoThread[], total: 0 }),
  ]);
  setPaginationHeaders(c, issuePage.total + repoPage.total, listOptions);
  const merged = [
    ...issuePage.items.map((thread) => ({ id: thread.issue.id, lastActivity: thread.lastActivity, thread })),
    ...repoPage.items.map((thread) => ({ id: -thread.transfer.id, lastActivity: thread.lastActivity, thread })),
  ].sort((a, b) => b.lastActivity - a.lastActivity || b.id - a.id);
  const window = merged.slice((listOptions.page - 1) * listOptions.limit, listOptions.page * listOptions.limit);
  const viewer = viewerOf(c);
  return window.map((entry) =>
    "issue" in entry.thread
      ? toNotificationThread(viewer, entry.thread, resolvedStatus(entry.thread))
      : toRepoNotificationThread(viewer, entry.thread, resolvedStatus(entry.thread)),
  );
}

/** Shared mark body: fetch the in-scope threads of BOTH legs and write
 *  their state (notification_states / the KV arm — deviation 7). */
async function markThreadsInScope(c: Context<ApiEnv>, userId: number, repoId: string | undefined): Promise<void> {
  const url = new URL(c.req.url);
  // No pagination on the mark sweep (upstream Find without ListOptions).
  const updatedBefore = parseLastReadAt(url.searchParams.get("last_read_at"));
  const statuses = parseFormBool(url.searchParams.get("all"))
    ? []
    : parseStatusTypes(url.searchParams.getAll("status-types"), ["unread"]);
  const toStatus = parseToStatus(url.searchParams.get("to-status"));
  const now = new Date();
  const { items } = await fetchThreads(c.env.DB, { userId, repoId, updatedBefore, statuses });
  await markThreads(c.env.DB, userId, items, toStatus, now);
  // The mark arms carry no subject-type param, so the repo leg always rides.
  const repoLeg = await fetchRepoThreads(c.env.DB, { userId, repoId, updatedBefore, statuses });
  await markRepoThreads(c.env.DB, userId, repoLeg.items, toStatus, now);
}

function requireDoer(c: Context<ApiEnv>): { id: number; is_admin: boolean } {
  const doer = c.get("authUser");
  // The contract User schema declares no required fields, so the id narrows
  // here too (the starred routes' doer-idless corner → the same 401).
  if (doer?.id === undefined) {
    throw new ApiError(401, "token is required");
  }
  return { id: doer.id, is_admin: doer.is_admin === true };
}

// ---------------------------------------------------------------------------
// Single-thread lookup (notify/threads.go getThread guard, mirrored).
// ---------------------------------------------------------------------------

/** Resolve one derived thread by id with the upstream ownership guard.
 *  Negative ids branch to the repository-source leg (deviation 7). */
async function threadById(
  d1: D1Database,
  doer: { id: number; is_admin: boolean },
  id: number,
): Promise<DerivedThread | RepoThread> {
  if (id < 0) {
    return repoThreadById(d1, doer, id);
  }
  const db = drizzle(d1);
  const rows = await db
    // pull trimmed to the serializer's only read (the D1 result-set cap).
    .select({
      issue: issues,
      repo: repositories,
      owner: users,
      pull: { hasMerged: pullRequests.hasMerged },
    })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .leftJoin(pullRequests, eq(pullRequests.issueId, issues.id))
    .where(eq(issues.id, id))
    .limit(1);
  const base = rows[0];
  if (base === undefined) {
    // GetNotificationByID → db.ErrNotExist → 404 (notify/threads.go:105-112).
    throw new ApiError(404, `notification does not exist [id: ${id}]`);
  }

  const userId = doer.id;
  const lastActivity = await db
    .select({ value: sql<number>`(${lastActivityExpr(userId)})` })
    .from(issues)
    .where(eq(issues.id, id))
    .then((activityRows) => activityRows[0]?.value ?? 0);

  const recipientRows = await db
    .select({ one: sql<number>`1` })
    .from(issues)
    .innerJoin(repositories, eq(repositories.id, issues.repoId))
    .leftJoin(repoWatchers, and(eq(repoWatchers.repoId, issues.repoId), eq(repoWatchers.userId, userId)))
    .leftJoin(
      issueSubscriptions,
      and(
        eq(issueSubscriptions.issueId, issues.id),
        eq(issueSubscriptions.userId, userId),
        eq(issueSubscriptions.isWatching, true),
      ),
    )
    .where(and(eq(issues.id, id), recipientExpr(userId)))
    .limit(1);

  if (recipientRows.length === 0) {
    if (!doer.is_admin) {
      // threads.go:114-117 — exact upstream message.
      throw new ApiError(403, `only user itself and admin are allowed to read/change this thread ${id}`);
    }
    // Admin corner: upstream serves the owner's row; ours serves the
    // caller-perspective thread — fall back to the global latest activity
    // when the admin authored every event on the issue.
    const fallback =
      lastActivity > 0
        ? lastActivity
        : await db
            .select({ value: sql<number>`(${lastAnyActivityExpr()})` })
            .from(issues)
            .where(eq(issues.id, id))
            .then((fallbackRows) => fallbackRows[0]?.value ?? 0);
    return assembleThread(d1, doer.id, base, fallback);
  }
  if (lastActivity <= 0) {
    // No foreign activity = no mailbox entry for this user — the upstream
    // GetNotificationByID miss.
    throw new ApiError(404, `notification does not exist [id: ${id}]`);
  }
  return assembleThread(d1, doer.id, base, lastActivity);
}

/** The issue/repo/owner/pull join row shared by the thread lookup. */
type ThreadBase = {
  issue: IssueRow;
  repo: typeof repositories.$inferSelect;
  owner: typeof users.$inferSelect;
  pull: { hasMerged: boolean } | null;
};

async function assembleThread(d1: D1Database, userId: number, base: ThreadBase, lastActivity: number): Promise<DerivedThread> {
  const db = drizzle(d1);
  const stateRows = await db
    .select()
    .from(notificationStates)
    .where(and(eq(notificationStates.userId, userId), eq(notificationStates.issueId, base.issue.id)))
    .limit(1);
  const thread: DerivedThread = {
    issue: base.issue,
    repo: base.repo,
    owner: base.owner,
    pull: base.pull,
    state: stateRows[0] ?? null,
    lastActivity,
    lastCommentId: null,
  };
  await fillLastCommentIds(d1, [thread]);
  return thread;
}

// ---------------------------------------------------------------------------
// Route registration.
// ---------------------------------------------------------------------------

export function registerNotificationsRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // GET /notifications — notifyGetList (notify/user.go ListNotifications).
  app.openapi(
    createRoute({
      method: "get",
      path: "/notifications",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "List users's notification threads",
      operationId: "notifyGetList",
      request: listQuery,
      responses: {
        200: threadListResponse,
      },
    }),
    async (c) => c.json(await listThreadsPayload(c, requireDoer(c).id, undefined), 200),
  );

  // PUT /notifications — notifyReadList (notify/user.go ReadNotifications).
  app.openapi(
    createRoute({
      method: "put",
      path: "/notifications",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "Mark notification threads as read, pinned or unread",
      operationId: "notifyReadList",
      request: readQuery,
      responses: {
        205: resetContentResponse,
      },
    }),
    async (c) => {
      await markThreadsInScope(c, requireDoer(c).id, undefined);
      // Deviation 6: the 205 body upstream sends cannot exist on this runtime.
      return c.body(null, 205);
    },
  );

  // GET /notifications/new — notifyNewAvailable (notify/notifications.go
  // NewAvailable): the unread count; pinned is excluded (a distinct status
  // upstream — the count filters status = unread only).
  app.openapi(
    createRoute({
      method: "get",
      path: "/notifications/new",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "Check if unread notifications exist",
      operationId: "notifyNewAvailable",
      responses: {
        200: countResponse,
      },
    }),
    async (c) => {
      // The unread count rides the merged totals (deviation 7): the issue
      // leg plus the repository-source leg.
      const doer = requireDoer(c);
      const total =
        (await countThreads(c.env.DB, { userId: doer.id, statuses: ["unread"] })) +
        (await countRepoThreads(c.env.DB, { userId: doer.id, statuses: ["unread"] }));
      return c.json({ new: total }, 200);
    },
  );

  // GET /notifications/threads/{id} — notifyGetThread (notify/threads.go
  // GetThread + the getThread ownership guard).
  app.openapi(
    createRoute({
      method: "get",
      path: "/notifications/threads/{id}",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "Get notification thread by ID",
      operationId: "notifyGetThread",
      request: threadIdParams,
      responses: {
        200: threadResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const doer = requireDoer(c);
      const thread = await threadById(c.env.DB, doer, pathId(c.req.valid("param").id));
      const viewer = viewerOf(c);
      // The serializer branches on the thread kind (deviation 7): the
      // Repository subject arm for the pending-transfer leg.
      return c.json(
        "issue" in thread
          ? toNotificationThread(viewer, thread, resolvedStatus(thread))
          : toRepoNotificationThread(viewer, thread, resolvedStatus(thread)),
        200,
      );
    },
  );

  // PATCH /notifications/threads/{id} — notifyReadThread (notify/threads.go
  // ReadThread): to-status query, default read.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/notifications/threads/{id}",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "Mark notification thread as read by ID",
      operationId: "notifyReadThread",
      request: { ...threadIdParams, ...readThreadQuery },
      responses: {
        205: resetContentResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const doer = requireDoer(c);
      const thread = await threadById(c.env.DB, doer, pathId(c.req.valid("param").id));
      const toStatus = parseToStatus(c.req.valid("query")["to-status"]);
      // The mark branches on the thread kind (deviation 7): issue threads
      // write notification_states, repository-source threads the KV arm.
      if ("issue" in thread) {
        await markThreads(c.env.DB, doer.id, [thread], toStatus, new Date());
      } else {
        await markRepoThreads(c.env.DB, doer.id, [thread], toStatus, new Date());
      }
      // Deviation 6: the 205 body upstream sends cannot exist on this runtime.
      return c.body(null, 205);
    },
  );

  // GET /repos/{owner}/{repo}/notifications — notifyGetRepoList
  // (notify/repo.go ListRepoNotifications + repoAssignment).
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/notifications",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "List users's notification threads on a specific repo",
      operationId: "notifyGetRepoList",
      request: { params: z.object(ownerRepoParams), ...listQuery },
      responses: {
        200: threadListResponse,
      },
    }),
    async (c) => {
      const doer = requireDoer(c);
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      return c.json(await listThreadsPayload(c, doer.id, found.repo.id), 200);
    },
  );

  // PUT /repos/{owner}/{repo}/notifications — notifyReadRepoList
  // (notify/repo.go ReadRepoNotifications + repoAssignment).
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/notifications",
      middleware: [requireAuth],
      tags: ["notification"],
      summary: "Mark notification threads as read, pinned or unread on a specific repo",
      operationId: "notifyReadRepoList",
      request: { params: z.object(ownerRepoParams), ...repoReadQuery },
      responses: {
        205: resetContentResponse,
      },
    }),
    async (c) => {
      const doer = requireDoer(c);
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await markThreadsInScope(c, doer.id, found.repo.id);
      // Deviation 6: the 205 body upstream sends cannot exist on this runtime.
      return c.body(null, 205);
    },
  );
}
