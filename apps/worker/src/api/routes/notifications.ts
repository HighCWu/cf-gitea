import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { CommentType } from "../../issues/comment-types";
import type { IssueRow, PullRequestRow } from "../../issues/service";
import {
  comments,
  issueSubscriptions,
  issues,
  notificationStates,
  pullRequests,
  repositories,
  repoWatchers,
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
 *    subscriber, or comment participant) AND at least one activity event on
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
 * 4. Recipient set reduced to our tables: owner ∪ repo_watchers (mode-aware:
 *    a Dont/ignore row does NOT qualify — the migration-0053 mode columns
 *    closed the "untyped rows" gap; the per-type include matching upstream
 *    applies, GetRepoWatchersIDs' include_<type> arm, watch.go:266-292,
 *    is still not ported here) ∪ issue poster ∪ explicit issue subscribers
 *    ∪ comment participants. Upstream additionally notifies assignees and
 *    requested reviewers (no assignee table at this tier) and excludes
 *    access-revoked users (no revocation model).
 * 5. Subject types are Issue/Pull only. `subject-type=commit/repository`
 *    filters are accepted (upstream maps them to valid sources) but match
 *    nothing here — no commit/repository notification source exists.
 * 6. 205 responses carry NO body. Upstream returns the marked
 *    NotificationThreadList JSON with 205; Cloudflare's runtime enforces the
 *    fetch spec's null-body rule ("Response with null body status … cannot
 *    have a body"), so the body is dropped and the marked set is observable
 *    via a follow-up GET. The declared code stays 205 (contract subset).
 *
 * Undeclared runtime codes (kept out of the orchestrator RUNTIME_ONLY tables
 * by this batch — the landed route-module convention): 401 anonymous
 * (upstream reqToken), 400 bad last_read_at (user.go:137), 422 bad
 * since/before (GetQueryBeforeSince). Auth: every operation requires a token
 * (requireAuth); the upstream `notification` scope category and the
 * public-only-token rejection land with the SPEC-0002 scope work — no scope
 * model exists yet.
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
    .enum(["open", "closed", "merged"])
    .openapi({ description: "State indicates the current state of the notification subject" }),
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
    "status-types": z.string().optional().openapi({
      description:
        "Show notifications with the provided status types (repeated query params). Options are: unread, read and/or pinned. Defaults to unread & pinned.",
    }),
    "subject-type": z.string().optional().openapi({
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
    "status-types": z.string().optional().openapi({
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
    "status-types": z.string().optional().openapi({
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
  pull: PullRequestRow | null;
  /** The caller's state row (null when never touched). */
  state: typeof notificationStates.$inferSelect | null;
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
 * The recipient predicate (module doc deviation 4); needs the repositories
 * join plus the repo_watchers / issue_subscriptions left joins in scope.
 * The watch arm is MODE-aware: a row qualifies only outside the ignore
 * state (`mode <> Dont` — upstream's watcher-recipients never enumerate
 * Dont rows: GetRepoWatchersIDs' `watch.mode<>? WatchModeDont`,
 * models/repo/watch.go:281, and the mailer additionally sweeps the ignorers
 * into the visited set FIRST — "muting the repository outranks every other
 * source, including mentions", services/mailer/mail_issue.go:88-93), so a
 * persisted Dont watch (the Auto-unwatch landing, watch.go:164-165) does
 * not qualify a notification recipient on its own.
 */
function recipientExpr(userId: number): SQL {
  return sql`(
    (${repoWatchers.userId} is not null and ${repoWatchers.mode} <> ${WatchMode.Dont})
    or ${repositories.ownerId} = ${userId}
    or ${issues.posterId} = ${userId}
    or ${issueSubscriptions.userId} is not null
    or exists (select 1 from comments pc where pc.issue_id = ${issues.id} and pc.poster_id = ${userId})
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
      pull: pullRequests,
      state: notificationStates,
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

/** GetLastComment (models/issues/issue.go:470-483): latest CommentTypeComment. */
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

/** Resolved {unread, pinned} of a thread (upstream Unread = !(read||pinned)). */
function resolvedStatus(thread: DerivedThread): { unread: boolean; pinned: boolean } {
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
// Handlers (the list/read pair shared by the global and repo-scoped routes).
// The response constructors stay inline in the route handlers — the
// hono-zod-openapi Handler type wants the c.json/c.body call in its own body.
// ---------------------------------------------------------------------------

/** Shared list body: fetch + pagination headers + serialization. */
async function listThreadsPayload(
  c: Context<ApiEnv>,
  userId: number,
  repoId: string | undefined,
): Promise<z.infer<typeof notificationThreadListSchema>> {
  const url = new URL(c.req.url);
  const listOptions = parseListOptions(url);
  const { items, total } = await fetchThreads(c.env.DB, {
    userId,
    repoId,
    updatedAfter: parseQueryTime(url.searchParams.get("since")) ?? undefined,
    updatedBefore: parseQueryTime(url.searchParams.get("before")) ?? undefined,
    statuses: parseFormBool(url.searchParams.get("all"))
      ? []
      : parseStatusTypes(url.searchParams.getAll("status-types"), ["unread", "pinned"]),
    sources: parseSubjectTypes(url.searchParams.getAll("subject-type")),
    listOptions,
  });
  setPaginationHeaders(c, total, listOptions);
  const viewer = viewerOf(c);
  return items.map((thread) => toNotificationThread(viewer, thread, resolvedStatus(thread)));
}

/** Shared mark body: fetch the in-scope threads and write their state rows. */
async function markThreadsInScope(c: Context<ApiEnv>, userId: number, repoId: string | undefined): Promise<void> {
  const url = new URL(c.req.url);
  const { items } = await fetchThreads(c.env.DB, {
    userId,
    repoId,
    // No pagination on the mark sweep (upstream Find without ListOptions).
    updatedBefore: parseLastReadAt(url.searchParams.get("last_read_at")),
    statuses: parseFormBool(url.searchParams.get("all"))
      ? []
      : parseStatusTypes(url.searchParams.getAll("status-types"), ["unread"]),
  });
  await markThreads(c.env.DB, userId, items, parseToStatus(url.searchParams.get("to-status")), new Date());
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

/** Resolve one derived thread by id with the upstream ownership guard. */
async function threadById(
  d1: D1Database,
  doer: { id: number; is_admin: boolean },
  id: number,
): Promise<DerivedThread> {
  const db = drizzle(d1);
  const rows = await db
    .select({ issue: issues, repo: repositories, owner: users, pull: pullRequests })
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
  pull: PullRequestRow | null;
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
      const total = await countThreads(c.env.DB, { userId: requireDoer(c).id, statuses: ["unread"] });
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
      return c.json(toNotificationThread(viewerOf(c), thread, resolvedStatus(thread)), 200);
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
      await markThreads(c.env.DB, doer.id, [thread], parseToStatus(c.req.valid("query")["to-status"]), new Date());
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
