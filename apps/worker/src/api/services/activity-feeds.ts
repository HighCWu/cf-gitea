import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  actions,
  comments,
  issues,
  orgMembers,
  repoCollaborators,
  repoWatchers,
  repositories,
  teamMembers,
  teamRepoAccess,
  users,
} from "../../db/schema";
import { commentSchema, type Comment } from "../models/issue";
import { repositorySchema } from "../models/repository";
import { userSchema } from "../models/user";
import {
  apiUserFromRow,
  findRepositoryById,
  toApiRepository,
  type RepositoryWithOwner,
  type Viewer,
} from "./repository";
import { toApiComment } from "./issues";

/**
 * The activity-feed store over the `action` table (specs/activity-feeds.md):
 * the NotifyWatchers write fan-out port (§3.2) shared by the emitter insert
 * hooks, and the GetFeeds read port (§3.4) behind the three
 * /activities/feeds endpoints.
 *
 * Upstream cites (submodule pin fc4936884584):
 *   - table + ActionType: gitea/models/activities/action.go:23-56,135-151;
 *   - fan-out: gitea/services/feed/feed.go:32-100 (notifyWatchers);
 *   - read conditions: gitea/models/activities/action_list.go:207-260 +
 *     gitea/models/activities/action.go:445-562 (ActivityQueryCondition,
 *     FeedDateCond, GetFeeds);
 *   - payload: gitea/services/convert/activity.go:17-50 (ToActivity).
 *
 * Deviations are pinned in the SPEC (§3.1 TEXT repo_id / 3-of-5 indexes,
 * §3.2 no write-time watcher permission filter, §3.3 the wired action-type
 * matrix, §3.4 visibility='private' plays keep_activity_private — the
 * routes/user-read-t2.ts heatmap precedent — and UTC date windows). The
 * visibility/repo-access filters run as SQL subqueries so the D1 bound
 * parameter cap (100/query) never constrains the id sets.
 */

// ---------------------------------------------------------------------------
// Upstream ActionType (action.go:23-56) — numeric iota preserved in D1.
// ---------------------------------------------------------------------------

export const ActionType = {
  CreateRepo: 1,
  RenameRepo: 2,
  StarRepo: 3,
  WatchRepo: 4,
  CommitRepo: 5,
  CreateIssue: 6,
  CreatePullRequest: 7,
  TransferRepo: 8,
  PushTag: 9,
  CommentIssue: 10,
  MergePullRequest: 11,
  CloseIssue: 12,
  ReopenIssue: 13,
  ClosePullRequest: 14,
  ReopenPullRequest: 15,
  DeleteTag: 16,
  DeleteBranch: 17,
  MirrorSyncPush: 18,
  MirrorSyncCreate: 19,
  MirrorSyncDelete: 20,
  ApprovePullRequest: 21,
  RejectPullRequest: 22,
  CommentPull: 23,
  PublishRelease: 24,
  PullReviewDismissed: 25,
  PullRequestReadyForReview: 26,
  AutoMergePullRequest: 27,
} as const;

/** ActionType.String() (action.go:91-134) — the wire `op_type` strings,
 *  typed against the contract enum so renders cannot drift from it. Rows
 *  are written only through the ActionType constants above; an unmapped
 *  numeric value is a programmer error and throws. */
const OP_TYPE_NAMES: Record<number, Activity["op_type"]> = {
  1: "create_repo",
  2: "rename_repo",
  3: "star_repo",
  4: "watch_repo",
  5: "commit_repo",
  6: "create_issue",
  7: "create_pull_request",
  8: "transfer_repo",
  9: "push_tag",
  10: "comment_issue",
  11: "merge_pull_request",
  12: "close_issue",
  13: "reopen_issue",
  14: "close_pull_request",
  15: "reopen_pull_request",
  16: "delete_tag",
  17: "delete_branch",
  18: "mirror_sync_push",
  19: "mirror_sync_create",
  20: "mirror_sync_delete",
  21: "approve_pull_request",
  22: "reject_pull_request",
  23: "comment_pull",
  24: "publish_release",
  25: "pull_review_dismissed",
  26: "pull_request_ready_for_review",
  27: "auto_merge_pull_request",
};

export function opTypeName(opType: number): Activity["op_type"] {
  const name = OP_TYPE_NAMES[opType];
  if (name === undefined) {
    throw new Error(`action op_type ${opType} has no wire name`);
  }
  return name;
}

export type ActionRow = typeof actions.$inferSelect;

// ---------------------------------------------------------------------------
// Write side — the NotifyWatchers fan-out (feed.go:32-100).
// ---------------------------------------------------------------------------

/** One logical action to record (the upstream `Action` before fan-out). */
export interface ActionDraft {
  /** Performer (upstream ActUserID). */
  actUserId: number;
  /** TEXT repositories.id (upstream RepoID is int64). */
  repoId: string;
  /** Upstream ActionType numeric value. */
  opType: number;
  /** Upstream `IsPrivate` — repo privacy at action time. */
  isPrivate: boolean;
  /** Upstream `Content` — "index|excerpt" / old repo name / ... */
  content?: string;
  /** Upstream `CommentID` — 0/undefined when the action has no comment. */
  commentId?: number;
  /** Upstream `RefName`. */
  refName?: string;
  /** Row timestamp; defaults to now (upstream `xorm:"created"`). */
  createdAt?: Date;
}

/**
 * Insert the receiver fan-out for one action (SPEC §3.2): the original row
 * (`user_id = act_user_id`), the org-owner row when the repo is org-owned
 * and the actor is not the org (feed.go:55-62), and one row per repo
 * watcher (feed.go:64-100). Deviation (SPEC §3.2): upstream's write-time
 * per-watcher unit-permission/notification-pref filter is NOT ported —
 * cf-gitea has no per-unit permissions and `repo_watchers` carries no
 * prefs; the read path's per-caller filters bound visibility under our
 * model.
 *
 * Throws on D1 errors — the emitter hooks own the catch-and-log posture,
 * exactly like the webhook fan-out.
 */
export async function recordAction(db: D1Database, draft: ActionDraft): Promise<void> {
  const d1 = drizzle(db);
  const createdAt = draft.createdAt ?? new Date();
  const receivers: number[] = [draft.actUserId];

  // The org-owner receiver: owner row must be an org user row and not the
  // actor themself.
  const repoRows = await d1
    .select({ ownerId: repositories.ownerId })
    .from(repositories)
    .where(eq(repositories.id, draft.repoId))
    .limit(1)
    .all();
  const ownerId = repoRows[0]?.ownerId ?? null;
  if (ownerId !== null && ownerId !== draft.actUserId) {
    const ownerRows = await d1
      .select({ type: users.type })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
      .all();
    if (ownerRows[0]?.type === "org") {
      receivers.push(ownerId);
    }
  }

  // Watcher receivers, minus the actor and the org owner.
  const watcherRows = await d1
    .select({ userId: repoWatchers.userId })
    .from(repoWatchers)
    .where(eq(repoWatchers.repoId, draft.repoId))
    .all();
  for (const watcher of watcherRows) {
    if (watcher.userId !== draft.actUserId && !receivers.includes(watcher.userId)) {
      receivers.push(watcher.userId);
    }
  }

  await d1
    .insert(actions)
    .values(
      receivers.map((userId) => ({
        userId,
        opType: draft.opType,
        actUserId: draft.actUserId,
        repoId: draft.repoId,
        commentId: draft.commentId ?? 0,
        isDeleted: false,
        refName: draft.refName ?? "",
        isPrivate: draft.isPrivate,
        content: draft.content ?? "",
        createdAt,
      })),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Read side — the GetFeeds port (action_list.go:207-260).
// ---------------------------------------------------------------------------

/** The signed-in actor as the read path sees it (null = anonymous). */
export interface FeedActor {
  id: number;
  isAdmin: boolean;
}

/** Which feed family the query targets. */
export type FeedKind = "repo" | "user" | "org";

export interface FeedQueryOptions {
  kind: FeedKind;
  /** kind=repo: the TEXT repositories.id. */
  repoId?: string;
  /** kind=user|org: the requested subject's row (user rows cover orgs —
   *  only the id feeds the predicates). */
  requested?: { id: number };
  /** The viewer's identity row (null = anonymous). */
  actor: FeedActor | null;
  /** Per-endpoint IncludePrivate (SPEC §2): repo=true; user=self||admin;
   *  org=member||admin. */
  includePrivate: boolean;
  /** userListActivityFeeds' `only-performed-by`. */
  onlyPerformedBy: boolean;
  /** `YYYY-MM-DD` window; unparsable skips the filter (upstream parity). */
  date?: string;
  page: number;
  limit: number;
}

/** True when the fast path applies (action_list.go:215): actor is the
 *  requested subject themself or a site admin — no visibility filters. */
function isSelfOrAdmin(opts: FeedQueryOptions): boolean {
  if (opts.actor === null) return false;
  if (opts.actor.isAdmin) return true;
  return opts.requested !== undefined && opts.actor.id === opts.requested.id;
}

/**
 * FeedDateCond (action.go:445-461): `[date 00:00:00, date 23:59:59]` in UTC
 * (upstream setting.DefaultUILocation, UTC by default); unparsable input
 * skips the filter exactly like upstream's warn-and-continue.
 */
function dateCond(date: string | undefined): SQL | undefined {
  if (date === undefined || date === "") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return undefined;
  const low = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
  const high = low + 86_399;
  return and(gte(actions.createdAt, new Date(low * 1000)), lte(actions.createdAt, new Date(high * 1000)));
}

/**
 * Act-user visibility (action.go:473-497) with the landed mapping
 * keep_activity_private ⟺ users.visibility = 'private' (the heatmap
 * precedent). Anonymous ⇒ public-only act users; signed ⇒ public+limited ∪
 * {actor} plus the requested-subject branches (the requested org itself;
 * orgs the requested user belongs to). Admin/self ⇒ undefined (no filter).
 */
function actUserCond(opts: FeedQueryOptions): SQL | undefined {
  if (isSelfOrAdmin(opts)) return undefined;
  if (opts.actor === null) {
    return sql`${actions.actUserId} IN (SELECT id FROM ${users} WHERE visibility = 'public')`;
  }
  const branches: SQL[] = [
    sql`${actions.actUserId} IN (SELECT id FROM ${users} WHERE visibility IN ('public', 'limited'))`,
    sql`${actions.actUserId} = ${opts.actor.id}`,
  ];
  if (opts.kind === "org" && opts.requested !== undefined) {
    // "An organization can always see the activities whose act_user_id is
    // the same as its id" (action.go:488-490).
    branches.push(sql`${actions.actUserId} = ${opts.requested.id}`);
  }
  if (opts.kind === "user" && opts.requested !== undefined) {
    // "... a user can always see the activities of the organizations to
    // which the user belongs" (action.go:491-496).
    branches.push(
      sql`${actions.actUserId} IN (SELECT org_id FROM ${orgMembers} WHERE user_id = ${opts.requested.id})`,
    );
  }
  return sql.join(
    branches.map((branch) => sql`(${branch})`),
    sql` OR `,
  );
}

/**
 * Repo accessibility (action.go:499-501, AccessibleRepoIDsQuery) over the
 * landed repo model: public repos ∪ actor-owned ∪ collaborator rows ∪
 * team-granted (team_members ⋈ team_repo_access). Admins and the repo-kind
 * endpoint (the repo was already visibility-gated by the route) skip it.
 */
function repoAccessCond(opts: FeedQueryOptions): SQL | undefined {
  if (opts.actor === null) {
    return sql`${actions.repoId} IN (SELECT id FROM ${repositories} WHERE visibility = 'public')`;
  }
  if (opts.actor.isAdmin || opts.kind === "repo") return undefined;
  const id = opts.actor.id;
  return sql`${actions.repoId} IN (
    SELECT id FROM ${repositories} WHERE visibility = 'public'
    UNION SELECT id FROM ${repositories} WHERE owner_id = ${id}
    UNION SELECT repo_id FROM ${repoCollaborators} WHERE user_id = ${id}
    UNION SELECT tra.repo_id FROM ${teamMembers} tm
      JOIN ${teamRepoAccess} tra ON tra.team_id = tm.team_id
      WHERE tm.user_id = ${id}
  )`;
}

/**
 * The full WHERE predicate (§3.4 conditions 1-7). The fast path
 * (action_list.go:215 — actor is the requested subject or a site admin)
 * skips BOTH the act-user visibility filter and the repo-accessibility
 * filter, exactly like upstream's short-circuited condition.
 *
 * The is_deleted filter is UNCONDITIONAL here — unlike the visibility
 * filters it also applies on the self/admin fast path, which is upstream's
 * shape too (action_list.go:222-224 fast path + action.go:539-541 general
 * path both add `is_deleted = false`). Nothing writes the flag true on
 * either side (repo delete HARD-deletes the rows: upstream
 * services/repository/delete.go:155-157 DeleteBeans; the ported arm is the
 * repo_id-keyed DELETE in repos/service.ts) — the filter is the parity arm
 * for any soft-deleted shape and is pinned by activity-feeds.test.ts.
 */
function feedCondition(opts: FeedQueryOptions): SQL | undefined {
  const parts: (SQL | undefined)[] = [eq(actions.isDeleted, false)];

  if (opts.kind === "repo") {
    // Only the ORIGINAL rows (action.go:517-521 — the NotifyWatchers
    // dedup): repo_id = ? AND user_id = act_user_id.
    parts.push(eq(actions.repoId, opts.repoId ?? ""));
    parts.push(sql`${actions.userId} = ${actions.actUserId}`);
  } else {
    parts.push(eq(actions.userId, opts.requested?.id ?? -1));
  }
  if (opts.onlyPerformedBy) {
    parts.push(eq(actions.actUserId, opts.requested?.id ?? -1));
  }
  if (!opts.includePrivate) {
    parts.push(eq(actions.isPrivate, false));
  }
  if (!isSelfOrAdmin(opts)) {
    parts.push(actUserCond(opts));
    parts.push(repoAccessCond(opts));
  }
  parts.push(dateCond(opts.date));

  const defined = parts.filter((part): part is SQL => part !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

/** One page of the feed: raw rows + the unpaginated total (X-Total-Count). */
export async function getFeedRows(
  db: D1Database,
  opts: FeedQueryOptions,
): Promise<{ total: number; rows: ActionRow[] }> {
  const d1 = drizzle(db);
  const condition = feedCondition(opts);
  const offset = (opts.page - 1) * opts.limit;
  const rows = await d1
    .select()
    .from(actions)
    .where(condition)
    .orderBy(desc(actions.createdAt), desc(actions.id))
    .limit(opts.limit)
    .offset(offset)
    .all();
  const totals = await d1
    .select({ count: sql<number>`count(*)` })
    .from(actions)
    .where(condition)
    .all();
  return { total: Number(totals[0]?.count ?? 0), rows };
}

// ---------------------------------------------------------------------------
// Rendering — convert.ToActivity (services/convert/activity.go:17-50).
// ---------------------------------------------------------------------------

/** The `op_type` enum exactly as the frozen contract declares it. */
const OP_TYPE_ENUM = z.enum([
  "create_repo",
  "rename_repo",
  "star_repo",
  "watch_repo",
  "commit_repo",
  "create_issue",
  "create_pull_request",
  "transfer_repo",
  "push_tag",
  "comment_issue",
  "merge_pull_request",
  "close_issue",
  "reopen_issue",
  "close_pull_request",
  "reopen_pull_request",
  "delete_tag",
  "delete_branch",
  "mirror_sync_push",
  "mirror_sync_create",
  "mirror_sync_delete",
  "approve_pull_request",
  "reject_pull_request",
  "comment_pull",
  "publish_release",
  "pull_review_dismissed",
  "pull_request_ready_for_review",
  "auto_merge_pull_request",
]);

/**
 * `#/definitions/Activity` — the contract shape, field-for-field (the
 * schemas compose the landed model schemas so renders cannot drift).
 * `comment`/`comment_id` render ONLY for live comments, upstream's
 * `if ac.Comment != nil` gate (activity.go:42-46).
 */
export const activitySchema = z
  .object({
    id: z.number().int().openapi({ format: "int64", description: "The unique identifier of the activity" }),
    user_id: z
      .number()
      .int()
      .openapi({ format: "int64", description: "The ID of the user who receives/sees this activity" }),
    op_type: OP_TYPE_ENUM.openapi({ description: "the type of action" }),
    act_user_id: z
      .number()
      .int()
      .openapi({ format: "int64", description: "The ID of the user who performed the action" }),
    act_user: userSchema.nullable().optional().openapi({ description: "The user who performed the action" }),
    repo_id: z
      .number()
      .int()
      .openapi({ format: "int64", description: "The ID of the repository associated with the activity" }),
    repo: repositorySchema
      .nullable()
      .optional()
      .openapi({ description: "The repository associated with the activity" }),
    comment_id: z
      .number()
      .int()
      .openapi({ format: "int64", description: "The ID of the comment associated with the activity (if applicable)" }),
    comment: commentSchema.nullable().optional().openapi({
      description: "The comment associated with the activity (if applicable)",
    }),
    ref_name: z
      .string()
      .openapi({ description: "The name of the git reference (branch/tag) associated with the activity" }),
    is_private: z.boolean().openapi({ description: "Whether this activity is from a private repository" }),
    content: z.string().openapi({ description: "Additional content or details about the activity" }),
    created: z.string().openapi({ format: "date-time", description: "The date and time when the activity occurred" }),
  })
  .openapi("Activity");

export type Activity = z.infer<typeof activitySchema>;

function isoOrZero(value: Date | null): string {
  return value === null ? "0001-01-01T00:00:00Z" : value.toISOString();
}

/**
 * Render a feed page. Rows with a missing repository or act-user row are
 * skipped (our delete cascades hard; upstream soft-keeps rows — SPEC §4).
 * The comment renders (with comment_id) ONLY when the comment row is alive,
 * upstream's `if ac.Comment != nil` gate (activity.go:42-46).
 */
export async function renderFeedItems(
  db: D1Database,
  viewer: Viewer,
  rows: ActionRow[],
): Promise<Activity[]> {
  const d1 = drizzle(db);
  if (rows.length === 0) return [];

  const actUserIds = [...new Set(rows.map((row) => row.actUserId))];
  const userRows = await d1.select().from(users).where(inArray(users.id, actUserIds)).all();
  const usersById = new Map(userRows.map((row) => [row.id, row]));

  const repoIds = [...new Set(rows.map((row) => row.repoId))];
  const repoPairs = new Map<string, RepositoryWithOwner>();
  await Promise.all(
    repoIds.map(async (repoId) => {
      const pair = await findRepositoryById(db, repoId);
      if (pair !== null) repoPairs.set(repoId, pair);
    }),
  );

  const commentIds = [...new Set(rows.filter((row) => row.commentId !== 0).map((row) => row.commentId))];
  const commentRenders = new Map<number, { comment: Comment; issueId: number }>();  if (commentIds.length > 0) {
    const commentRows = await d1.select().from(comments).where(inArray(comments.id, commentIds)).all();
    const issueRows = await d1
      .select()
      .from(issues)
      .where(inArray(issues.id, [...new Set(commentRows.map((row) => row.issueId))]))
      .all();
    const issuesById = new Map(issueRows.map((row) => [row.id, row]));
    await Promise.all(
      commentRows.map(async (commentRow) => {
        const issueRow = issuesById.get(commentRow.issueId);
        const pair = issueRow === undefined ? undefined : repoPairs.get(issueRow.repoId);
        if (issueRow === undefined || pair === undefined) return;
        commentRenders.set(commentRow.id, {
          comment: await toApiComment(db, viewer, pair, issueRow, commentRow),
          issueId: issueRow.id,
        });
      }),
    );
  }

  const items: Activity[] = [];
  for (const row of rows) {
    const actUser = usersById.get(row.actUserId);
    const pair = repoPairs.get(row.repoId);
    if (actUser === undefined || pair === undefined) continue;
    const renderedComment = commentRenders.get(row.commentId);
    items.push({
      id: row.id,
      user_id: row.userId,
      op_type: opTypeName(row.opType),
      act_user_id: row.actUserId,
      act_user: apiUserFromRow(actUser, viewer),
      repo_id: numericRepoId(row.repoId),
      repo: toApiRepository(viewer, pair),
      // comment_id always serializes (Go zero-value 0; no omitempty upstream);
      // the embedded comment OBJECT only for a live comment row.
      comment_id: row.commentId,
      ...(renderedComment === undefined ? {} : { comment: renderedComment.comment }),
      ref_name: row.refName,
      is_private: row.isPrivate,
      content: row.content,
      created: isoOrZero(row.createdAt),
    });
  }
  return items;
}

/**
 * Upstream `Repository.id` is int64; the registry keys TEXT ids. Numeric
 * text ids pass through, anything else renders 0 — the same documented
 * conversion as api/services/repository.ts repositoryIdNumber (module-
 * private there; duplicated to honor this wave's file ownership).
 */
function numericRepoId(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
