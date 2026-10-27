/**
 * The notifications page — `/notifications` — pages wave 10 (SPEC-0008 U3
 * extension), upstream's web notifications family (routers/web/web.go:1784-1791
 * `m.Group("/notifications", …, reqSignIn)` at the pin):
 *
 *   GET  /notifications          the thread list (user.Notifications)
 *   GET  /notifications/new      the unread count JSON (user.NewAvailable)
 *   POST /notifications/status   per-row status write (NotificationStatusPost)
 *   POST /notifications/purge    mark-all-read (NotificationPurgePost)
 *
 * The `/notifications/subscriptions` and `/notifications/watching` pages were
 * not in this slice — w129 batch-14 sweep note: window-2e C3b landed them
 * since (pages/notification-subscriptions.tsx, both GET tails mounted); the
 * route list above stays this module's owner set (new/status/purge).
 *
 * ## DOM contract (templates/user/notification/{notification,notification_div}.tmpl
 *  + base/head_navbar_icons.tmpl at the pin)
 *
 * `.page-content.user.notification` — the role=main div IS upstream's
 * `#notification_div` (id + `data-sequence-number`, BaseLayout's optional
 * mainId/mainDataSequence props), containing: the `flex-left-right` header
 * row (the Unread/Read `small-menu-items` tab menu — the unread tab carries
 * the `notifications-unread-count` label — and, on the unread tab, the
 * mark-all `link-action` button), the `#notification_table` list
 * (`.notifications-item` rows: the shared/issueicon state glyph, the
 * `notifications-link` subject anchor — repo full name + #index line, the
 * title, the pin mark —, the `notifications-updated` time, and the
 * `notifications-buttons` POST form with the pin / mark-as-read /
 * mark-as-unread buttons), upstream's `.empty-placeholder` on an empty tab,
 * and the Older/Newer pager. The row forms carry upstream's
 * `data-fetch-sync="$body #notification_div"` — the official bundle's
 * fetch-action JS morphs the fresh div fragment in place, which is why
 * POST /notifications/status ANSWERS WITH THE DIV FRAGMENT (200 text/html,
 * upstream NotificationStatusPost rendering tplNotificationDiv verbatim) and
 * POST /notifications/purge answers `{"redirect": …}` JSON (upstream
 * JSONRedirect, context.go:239-241). `?div-only=1` on the GET returns the
 * bare fragment for the bundle's live table refresh
 * (features/notification.ts updateNotificationTable).
 *
 * ## Data — the derived-thread model (the canonical UI consumer)
 *
 * There are no materialized notification rows at this tier: the thread set is
 * DERIVED over issues/comments/watchers/subscriptions at read time and only
 * the read/pin state is materialized (`notification_states`, migration 0011).
 * The model's landed owner is the API route module
 * (src/api/routes/notifications.ts — module doc deviations 1-6); its query
 * functions are module-private and importing the route module would drag the
 * zod-openapi graph into the UI bundle, so — exactly like pages/dashboard.tsx
 * (wave 9) — this module RE-ISSUES the predicate set verbatim with citations:
 * the scalar-max `lastActivityExpr`, the `recipientExpr` disjunction, the
 * `updated DESC, id DESC` order (notification_list.go:65-67), the resolved
 * status (`Unread = !(read || pinned)`), the mark upsert (SetNotificationStatus
 * semantics: pin keeps the read marker, read/unread rewrite it), and the
 * thread-lookup guard (threads.go getThread: missing issue / no foreign
 * activity → no mailbox entry; non-recipient → not the caller's thread). The
 * web tabs map to upstream's page query: `?type=unread` (default) filters
 * statuses [unread, pinned], `?type=read` filters [read, pinned]
 * (prepareUserNotificationsData's `statuses = [queryStatus, Pinned]`), 20 per
 * page (the handler's perPage const, "never used or exposed"), requested pages
 * past the end clamp to the last page (upstream's pager rebuild).
 *
 * ## Postures and documented degradations (§6 method)
 *
 * - Anonymous viewers 303 onto `/login?redirect_to=…` on every arm (upstream
 *   reqSignIn); the count JSON degrades `{new: 0}` on a failed read exactly
 *   like upstream NewAvailable's error arm (notification.go:434-446).
 * - The navbar bell (head_navbar_icons.tmpl:41-48: `octicon-bell` +
 *   `.notification_count` badge, hidden at 0) renders for every signed-in
 *   viewer with the unread count — the same one-COUNT-per-request cost
 *   upstream's PageGlobalData carries; a failed count renders the bell with
 *   the badge hidden (the degrade is the upstream error arm's shape). The
 *   bundle's initNotificationCount drives the badge live from
 *   `/notifications/new` (the count JSON arm above — without it the shared
 *   worker's first sync would zero the server-rendered badge).
 * - Row "reason": upstream's NotificationThread carries no reason field at
 *   the pin — the state glyph (open/closed/merged issueicon) and the pin mark
 *   carry the row semantics; `data-status` (1 unread / 2 read / 3 pinned) is
 *   emitted verbatim (upstream's row attribute; no upstream dot element
 *   exists to reproduce).
 * - `mark_page_as_read` (purge-page) is not rendered: it needs the
 *   CurUnreadNotificationIDs id-list channel for a page-wide mark the
 *   mark-all button already covers at this scale (dead surface avoided);
 *   the POST tail stays unclaimed (notifications.test pins the 404).
 *   w129 batch-14 sweep: the subscriptions/watching pages themselves
 *   LANDED since this note was written (window-2e C3b — pages/
 *   notification-subscriptions.tsx, both GET tails mounted); what stays
 *   absent is the profile-dropdown entry that links them upstream
 *   (head_navbar.tmpl:108 — shell chrome outside this module).
 * - The pager preserves `type` (the upstream pager keeps its query params).
 */

import { renderToString } from "hono/jsx/dom/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import {
  issueSubscriptions,
  issues,
  notificationStates,
  pullRequests,
  repoWatchers,
  repositories,
  users,
} from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the dashboardLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const notificationsLocale = {
  notifications: "Notifications", // "notifications"
  unread: "Unread", // "notification.unread"
  read: "Read", // "notification.read"
  mark_all_as_read: "Mark all as read", // "notification.mark_all_as_read"
  mark_as_read: "Mark as read", // "notification.mark_as_read"
  mark_as_unread: "Mark as unread", // "notification.mark_as_unread"
  pin: "Pin notification", // "notification.pin"
  no_unread: "No unread notifications.", // "notification.no_unread"
  no_read: "No read notifications.", // "notification.no_read"
} as const;

/** Upstream perPage (prepareUserNotificationsData: `util.IfZero(…, 20)` —
 *  "this value is never used or exposed"). */
export const NOTIFICATIONS_PAGE_SIZE = 20;

/** The thread status values (the route module's ThreadStatus). */
type ThreadStatus = "unread" | "read" | "pinned";

/** The web page's two tabs (upstream `?type=unread|read`). */
export type NotificationPageType = "unread" | "read";

/** Parse `?type=` (upstream FormString "type"; unknown values degrade to
 *  unread, never an error). */
export function parseNotificationPageType(raw: string | null): NotificationPageType {
  return raw === "read" ? "read" : "unread";
}

/** `Base.FormBool` (the route module's parseFormBool) for `?div-only=`. */
export function parseFormBool(raw: string | null): boolean {
  if (raw === null) return false;
  const value = raw.toLowerCase();
  return value === "1" || value === "t" || value === "true" || value === "on";
}

// ---------------------------------------------------------------------------
// The derived-thread query — notifications.ts re-issued verbatim (header)
// ---------------------------------------------------------------------------

/** Last foreign-authored activity on an issue — src/api/routes/notifications.ts
 *  `lastActivityExpr` verbatim (dashboard.tsx re-issues the same expression). */
function lastActivityExpr(userId: number): SQL {
  return sql`max(
    coalesce((select max(coalesce(c.updated_unix, c.created_unix)) from comments c
      where c.issue_id = ${issues.id} and (c.poster_id is null or c.poster_id <> ${userId})), 0),
    case when ${issues.posterId} is not null and ${issues.posterId} <> ${userId}
      then coalesce(${issues.createdAt}, 0) else 0 end
  )`;
}

/** The recipient disjunction — notifications.ts `recipientExpr` verbatim
 *  (watcher, repo owner, poster, issue subscriber, past commenter); the
 *  repositories join plus the repoWatchers / issueSubscriptions left joins
 *  must be in scope. */
function recipientExpr(userId: number): SQL {
  return sql`(
    ${repoWatchers.userId} is not null
    or ${repositories.ownerId} = ${userId}
    or ${issues.posterId} = ${userId}
    or ${issueSubscriptions.userId} is not null
    or exists (select 1 from comments pc where pc.issue_id = ${issues.id} and pc.poster_id = ${userId})
  )`;
}

/** The derived-status predicate — notifications.ts `statusExpr` verbatim
 *  (the OR join parenthesized; unread arm OR read arm OR pinned arm). */
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

/** The tab's status filter (prepareUserNotificationsData: queryStatus +
 *  Pinned on both tabs). */
function tabStatuses(pageType: NotificationPageType): ThreadStatus[] {
  return pageType === "read" ? ["read", "pinned"] : ["unread", "pinned"];
}

/** The FROM/JOIN shape shared by the page and count queries, spelled out per
 *  query like the route module (the queries select different shapes) — every
 *  left join is row-unique per issue, so the count never fans out. */
function threadConditions(userId: number, statuses: ThreadStatus[]): { lastActivity: SQL; conditions: SQL[] } {
  const lastActivity = lastActivityExpr(userId);
  return {
    lastActivity,
    conditions: [
      // A thread exists only with foreign activity (the mailbox is per-user).
      sql`(${lastActivity}) > 0`,
      recipientExpr(userId),
      statusExpr(statuses, lastActivity),
    ],
  };
}

/** One rendered row (the reduced DerivedThread — everything the template
 *  needs). */
export interface NotificationListItem {
  /** The thread id = the underlying issues.id (route module deviation 3). */
  issueId: number;
  index: number;
  title: string;
  isPull: boolean;
  isClosed: boolean;
  /** The pull_requests extension row's merge flag (false for issues). */
  hasMerged: boolean;
  ownerNamespace: string;
  slug: string;
  /** Resolved status (Unread = !(read || pinned) — notifications.ts
   *  resolvedStatus). */
  status: ThreadStatus;
  /** Unix seconds of the last foreign-authored activity (UpdatedAt). */
  lastActivity: number;
}

/** The page render inputs. */
export interface NotificationsData {
  pageType: NotificationPageType;
  page: number;
  total: number;
  unreadCount: number;
  items: NotificationListItem[];
}

/** Resolved status over the nullable join columns (notifications.ts
 *  resolvedStatus verbatim: pinned wins, then the read marker vs activity). */
function resolvedStatus(
  state: { userId: number | null; readAtUnix: number | null; pinned: boolean | null },
  lastActivity: number,
): ThreadStatus {
  if (state.userId !== null && state.pinned === true) return "pinned";
  if (state.userId !== null && (state.readAtUnix ?? 0) >= lastActivity) return "read";
  return "unread";
}

/**
 * Load one page of the mailbox (§3.2 — the re-issued derived-thread read):
 * the tab's status filter, the `updated DESC, id DESC` order, the 20-row
 * page, the tab total for the pager and the unread count for the tab badge.
 * `unreadCount` may be passed in (the navbar resolution already computed it
 * for this request — one COUNT per request, not two).
 */
export async function loadNotificationsData(
  d1: D1Database,
  userId: number,
  requestedType: NotificationPageType,
  requestedPage: number,
  unreadCount?: number,
): Promise<NotificationsData> {
  const db = drizzle(d1);
  const unread = unreadCount ?? (await countUnreadNotifications(d1, userId));

  const load = async (
    pageType: NotificationPageType,
    page: number,
  ): Promise<{ items: NotificationListItem[]; total: number }> => {
    const { lastActivity, conditions } = threadConditions(userId, tabStatuses(pageType));
    const where = and(...conditions);
    const countRows = await db
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
      .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)))
      .where(where);
    const total = countRows[0]?.value ?? 0;
    const rows = await db
      .select({
        issueId: issues.id,
        index: issues.index,
        title: issues.title,
        isPull: issues.isPull,
        isClosed: issues.isClosed,
        hasMerged: pullRequests.hasMerged,
        ownerNamespace: repositories.ownerNamespace,
        slug: repositories.slug,
        stateUserId: notificationStates.userId,
        stateReadAtUnix: notificationStates.readAtUnix,
        statePinned: notificationStates.pinned,
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
      .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)))
      .where(where)
      // Upstream ToOrders: `updated_unix DESC` (notification_list.go:65-67);
      // the row id is the deterministic tie-break.
      .orderBy(desc(sql`(${lastActivity})`), desc(issues.id))
      .limit(NOTIFICATIONS_PAGE_SIZE)
      .offset((page - 1) * NOTIFICATIONS_PAGE_SIZE);
    return {
      total,
      items: rows.map((row) => ({
        issueId: row.issueId,
        index: row.index,
        title: row.title,
        isPull: row.isPull === true,
        isClosed: row.isClosed === true,
        hasMerged: row.hasMerged === true,
        ownerNamespace: row.ownerNamespace,
        slug: row.slug,
        status: resolvedStatus(
          { userId: row.stateUserId, readAtUnix: row.stateReadAtUnix, pinned: row.statePinned },
          row.lastActivity,
        ),
        lastActivity: row.lastActivity,
      })),
    };
  };

  // Upstream's past-the-end clamp: a requested page above the total rebuilds
  // the pager onto the last page (prepareUserNotificationsData).
  const pageType = requestedType;
  let page = Math.max(1, requestedPage);
  let loaded = await load(pageType, page);
  const totalPages = Math.max(1, Math.ceil(loaded.total / NOTIFICATIONS_PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
    loaded = await load(pageType, page);
  }
  return { pageType, page, total: loaded.total, unreadCount: unread, items: loaded.items };
}

/** The unread count (notifyNewAvailable's query: statuses [unread], pinned
 *  excluded — the route module's countThreads shape). */
export async function countUnreadNotifications(d1: D1Database, userId: number): Promise<number> {
  const db = drizzle(d1);
  const { conditions } = threadConditions(userId, ["unread"]);
  const rows = await db
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
    .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)))
    .where(and(...conditions));
  return rows[0]?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Marking — notifications.ts markThreads / markThreadsInScope re-issued
// ---------------------------------------------------------------------------

/** The urlencoded POST's two fields (upstream FormInt64/FormString names). */
export interface NotificationStatusForm {
  /** Go FormInt64: garbage → 0 (the lookup miss). */
  id: number;
  /** Unknown actions → null (upstream `default: return` — ignored). */
  action: "mark_as_read" | "mark_as_unread" | "pin" | null;
}

export function parseNotificationStatusForm(params: URLSearchParams): NotificationStatusForm {
  const rawId = params.get("notification_id") ?? "";
  const id = /^-?\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : 0;
  const action = params.get("notification_action");
  return {
    id,
    action: action === "mark_as_read" || action === "mark_as_unread" || action === "pin" ? action : null,
  };
}

type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];
type BatchStatements = [BatchStatement, ...BatchStatement[]];

/** The state upsert — notifications.ts `markThreads` verbatim for a single
 *  row (pin keeps the read marker; read/unread rewrite it and clear the
 *  pin). Returns the builder for the caller's batch (NOT awaited — an async
 *  wrap would resolve it into a D1Result). */
export function markThread(
  d1: D1Database,
  userId: number,
  issueId: number,
  toStatus: ThreadStatus,
  now: Date,
): BatchStatement {
  const nowUnix = Math.floor(now.getTime() / 1000);
  return drizzle(d1)
    .insert(notificationStates)
    .values({
      userId,
      issueId,
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
    });
}

/** The mailbox-entry guard for one thread id (notifications.ts threadById's
 *  three misses reduced to a boolean — the web POST answers the 404 shell for
 *  every one of them, existence hidden): the issue exists, the caller is a
 *  recipient, and foreign activity exists. */
export async function isOwnMailboxThread(d1: D1Database, userId: number, issueId: number): Promise<boolean> {
  if (issueId <= 0) return false;
  const lastActivity = lastActivityExpr(userId);
  const rows = await drizzle(d1)
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
    .where(and(eq(issues.id, issueId), sql`(${lastActivity}) > 0`, recipientExpr(userId)))
    .limit(1);
  return rows.length > 0;
}

/** The per-row write (upstream SetNotificationStatus over the derived model).
 *  Returns false when the id is not the caller's mailbox thread (→ the 404
 *  shell; upstream's ServerError arm — the landed API PATCH answers its 404
 *  family for the same misses). The unknown-action case never reaches here
 *  (the router answers 200 empty first — upstream `default: return`). */
export async function markNotificationThread(
  d1: D1Database,
  userId: number,
  form: NotificationStatusForm & { action: "mark_as_read" | "mark_as_unread" | "pin" },
  now: Date,
): Promise<boolean> {
  if (!(await isOwnMailboxThread(d1, userId, form.id))) return false;
  const toStatus: ThreadStatus = form.action === "pin" ? "pinned" : form.action === "mark_as_read" ? "read" : "unread";
  await drizzle(d1).batch([markThread(d1, userId, form.id, toStatus, now)] as BatchStatements);
  return true;
}

/** Mark every unread thread read (upstream MarkAllRead — the purge): the
 *  route module's markThreadsInScope default sweep (statuses [unread], no
 *  pagination, to-status read) re-issued as one D1 batch. */
export async function purgeNotifications(d1: D1Database, userId: number, now: Date): Promise<void> {
  const db = drizzle(d1);
  const { conditions } = threadConditions(userId, ["unread"]);
  const rows = await db
    .select({ issueId: issues.id })
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
    .leftJoin(notificationStates, and(eq(notificationStates.issueId, issues.id), eq(notificationStates.userId, userId)))
    .where(and(...conditions));
  if (rows.length === 0) return;
  const statements = rows.map((row) => markThread(d1, userId, row.issueId, "read", now));
  await db.batch(statements as BatchStatements);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The subject URL (toNotificationThread's html_url shape: issues or pulls
 *  by the row's family). */
function threadUrl(item: NotificationListItem): string {
  return `/${item.ownerNamespace}/${item.slug}/${item.isPull ? "pulls" : "issues"}/${item.index}`;
}

/** Upstream's IsWorkInProgress is a pure title-prefix check (pull.go:652-673:
 * ASCII case-fold against WorkInProgressPrefixes — defaults "WIP:"/"[WIP:]"
 * … the landed item already carries `title`, so the draft branch renders). */
function hasWorkInProgressPrefix(title: string): boolean {
  const folded = title.toLowerCase();
  return folded.startsWith("wip:") || folded.startsWith("[wip]");
}

/** The row's state glyph (shared/issueicon.tmpl — the pull state machine this
 *  projection carries: merged → git-merge purple, closed → PR-closed red,
 *  open WIP → draft light-gray, open → green; issues open/closed). */
function ThreadIcon(props: { item: NotificationListItem }) {
  const { item } = props;
  if (item.isPull) {
    if (item.isClosed) {
      return item.hasMerged ? (
        <Icon name="octicon-git-merge" class="tw-text-purple" />
      ) : (
        <Icon name="octicon-git-pull-request-closed" class="tw-text-red" />
      );
    }
    if (hasWorkInProgressPrefix(item.title)) {
      return <Icon name="octicon-git-pull-request-draft" class="tw-text-text-light" />;
    }
    return <Icon name="octicon-git-pull-request" class="tw-text-green" />;
  }
  return item.isClosed ? (
    <Icon name="octicon-issue-closed" class="tw-text-red" />
  ) : (
    <Icon name="octicon-issue-opened" class="tw-text-green" />
  );
}

/** The upstream data-status number (1 unread / 2 read / 3 pinned). */
const STATUS_NUMBER: Record<ThreadStatus, number> = { unread: 1, read: 2, pinned: 3 };

/** The pager's query string: `type` when read + `page` past 1 (the upstream
 *  pager keeps its params). */
function pagerQuery(pageType: NotificationPageType, page: number): string {
  const params = new URLSearchParams();
  if (pageType === "read") params.set("type", "read");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** The tab strip + mark-all header row (notification_div.tmpl's
 *  flex-left-right block). */
function NotificationsHeader(props: { data: NotificationsData }) {
  const { data } = props;
  const isRead = data.pageType === "read";
  return (
    <div class="flex-left-right tw-mb-[--page-spacing]">
      <div class="small-menu-items ui compact tiny menu">
        <a class={isRead ? "item" : "active item"} href="/notifications?type=unread">
          {notificationsLocale.unread}
          <div
            class={
              data.unreadCount > 0
                ? "notifications-unread-count ui label"
                : "notifications-unread-count ui label tw-hidden"
            }
          >
            {data.unreadCount}
          </div>
        </a>
        <a class={isRead ? "active item" : "item"} href="/notifications?type=read">
          {notificationsLocale.read}
        </a>
      </div>
      {!isRead && data.unreadCount > 0 ? (
        <div class="flex-text-block">
          <button
            type="button"
            class="ui mini button primary link-action"
            data-tooltip-content={notificationsLocale.mark_all_as_read}
            aria-label={notificationsLocale.mark_all_as_read}
            data-url="/notifications/purge"
          >
            <Icon name="octicon-checklist" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One row's mark buttons form (notification_div.tmpl's notifications-buttons:
 *  pin when not pinned, mark-as-read when unread/pinned, mark-as-unread when
 *  read). The action posts back to `/notifications/status` with the page
 *  context in the query so the re-rendered fragment keeps the tab/page. */
function NotificationButtons(props: { item: NotificationListItem; formAction: string }) {
  const { item, formAction } = props;
  return (
    <form
      class="notifications-buttons form-fetch-action"
      action={formAction}
      method="post"
      data-fetch-sync="$body #notification_div"
    >
      <input type="hidden" name="notification_id" value={String(item.issueId)} />
      {item.status !== "pinned" ? (
        <button
          type="submit"
          class="btn interact-bg tw-p-2"
          data-tooltip-content={notificationsLocale.pin}
          aria-label={notificationsLocale.pin}
          name="notification_action"
          value="pin"
        >
          <Icon name="octicon-pin" />
        </button>
      ) : null}
      {item.status === "unread" || item.status === "pinned" ? (
        <button
          type="submit"
          class="btn interact-bg tw-p-2"
          data-tooltip-content={notificationsLocale.mark_as_read}
          aria-label={notificationsLocale.mark_as_read}
          name="notification_action"
          value="mark_as_read"
        >
          <Icon name="octicon-check" />
        </button>
      ) : (
        <button
          type="submit"
          class="btn interact-bg tw-p-2"
          data-tooltip-content={notificationsLocale.mark_as_unread}
          aria-label={notificationsLocale.mark_as_unread}
          name="notification_action"
          value="mark_as_unread"
        >
          <Icon name="octicon-bell" />
        </button>
      )}
    </form>
  );
}

/** The notification list + empty placeholder + pager (the
 *  notification_table block). */
function NotificationsTable(props: { data: NotificationsData; formAction: string }) {
  const { data, formAction } = props;
  return (
    <div id="notification_table">
      {data.items.length === 0 ? (
        <div class="empty-placeholder">
          <Icon name="octicon-inbox" size={56} class="tw-mb-4" />
          {data.pageType === "read" ? notificationsLocale.no_read : notificationsLocale.no_unread}
        </div>
      ) : (
        data.items.map((item) => (
          <div class="notifications-item" id={`notification_${item.issueId}`} data-status={STATUS_NUMBER[item.status]}>
            <div class="tw-self-start tw-mt-[2px]">
              <ThreadIcon item={item} />
            </div>
            <a class="notifications-link silenced tw-flex-1" href={threadUrl(item)}>
              <div class="flex-text-block tw-text-[0.95em]">
                {item.ownerNamespace}/{item.slug} <span class="tw-text-text-light-3">#{item.index}</span>
                {item.status === "pinned" ? <Icon name="octicon-pin" size={13} class="tw-text-blue" /> : null}
              </div>
              <div class="tw-text-16 tw-py-0.5">{item.title}</div>
            </a>
            <div class="notifications-updated flex-text-inline">
              <TimeSince unixSeconds={item.lastActivity} tz="+0000" />
            </div>
            <NotificationButtons item={item} formAction={formAction} />
          </div>
        ))
      )}
    </div>
  );
}

/** The pager (base/paginate.tmpl's center page buttons shape — the
 *  issues-list/explore DOM), preserving `type`. */
function NotificationsPagination(props: { data: NotificationsData }) {
  const { data } = props;
  const more = data.page * NOTIFICATIONS_PAGE_SIZE < data.total;
  if (data.page <= 1 && !more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {data.page > 1 ? (
          <a class="item navigation" href={`/notifications${pagerQuery(data.pageType, data.page - 1)}`}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {more ? (
          <a class="item navigation" href={`/notifications${pagerQuery(data.pageType, data.page + 1)}`}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The role=main div's children — shared byte-for-byte by the full page and
 *  the div-only fragment (the bundle morphs the fragment into the live
 *  page). The sequence number changes per fetch; it belongs to the div, not
 *  the children. */
function NotificationsBody(props: { data: NotificationsData }) {
  const { data } = props;
  return (
    <div class="ui container">
      <NotificationsHeader data={data} />
      <NotificationsTable data={data} formAction={`/notifications/status${pagerQuery(data.pageType, data.page)}`} />
      <NotificationsPagination data={data} />
    </div>
  );
}

/** The full-document render (the render.tsx pattern). The role=main div
 *  carries upstream's `#notification_div` id + sequence number (BaseLayout's
 *  mainId/mainDataSequence props). */
export function renderNotificationsPage(ctx: UiContext, data: NotificationsData, sequenceNumber: string): string {
  return renderPage(
    <BaseLayout
      ctx={ctx}
      title={notificationsLocale.notifications}
      pageClass="user notification"
      mainId="notification_div"
      mainDataSequence={sequenceNumber}
    >
      <NotificationsBody data={data} />
    </BaseLayout>,
  );
}

/** The div-only fragment (upstream tplNotificationDiv — `?div-only=1` on the
 *  GET, and the POST /status answer): the same role=main div WITHOUT the
 *  base head/footer, `renderToString`-emitted (no doctype, upstream shape). */
export function renderNotificationDiv(data: NotificationsData, sequenceNumber: string): string {
  return renderToString(
    <div
      role="main"
      aria-label={notificationsLocale.notifications}
      class="page-content user notification"
      id="notification_div"
      data-sequence-number={sequenceNumber}
    >
      <NotificationsBody data={data} />
    </div>,
  );
}
