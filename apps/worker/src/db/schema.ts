import { desc, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * D1 schema.
 *
 * SPEC-0001 §4 defines `repositories(id, storage_key, refs_version,
 * backend='self-hosted', ...)`; SPEC-0002 §3 the auth tables; SPEC-0005 §3.2
 * the issue/PR/release/webhook model (this file's largest block).
 *
 * Conventions for the SPEC-0005 tables: timestamps are `integer` unix seconds
 * (drizzle `mode: "timestamp"`), booleans are `integer` 0/1, JSON columns are
 * `text`. `id` columns are global autoincrement unless noted. Repo-scoped
 * foreign keys are plain columns (upstream Gitea also does not enforce them);
 * the SPEC pins exactly one FK: `repo_counters.repo_id → repositories.id`.
 *
 * Every change here must go through `pnpm db:generate`; never hand-edit SQL
 * under drizzle/migrations (AGENTS.md).
 */
export const repositories = sqliteTable(
  "repositories",
  {
    /** Immutable repository id; `storage_key` is derived as `r_<id>` (ADR-0001 D3). */
    id: text("id").primaryKey(),
    /** Immutable storage key (`r_<id>`); never changes on rename (SPEC-0001 §3). */
    storageKey: text("storage_key").notNull().unique(),
    /** Owner namespace (user or org slug); ownership model lands in SPEC-0002. */
    ownerNamespace: text("owner_namespace").notNull(),
    /** SPEC-0003 §3.1: `users.id` of the owner. Plain column (no FK) per the
     *  schema conventions above; `owner_namespace` is the case-folded lookup key
     *  the git gate joins on, kept in lockstep by the rename/transfer service. */
    ownerId: integer("owner_id"),
    /** Repository slug within the owner namespace (renamable). */
    slug: text("slug").notNull(),
    /** Repository visibility. */
    visibility: text("visibility", { enum: ["public", "private"] }).notNull(),
    /** SPEC-0003 §2.5.1: instance default branch; push-create adopts the first
     *  pushed branch (§2.5.2). */
    defaultBranch: text("default_branch").notNull().default("main"),
    /** SPEC-0003 §3.1: no refs advertised yet. Existing rows (engine-created
     *  repos predating lifecycle) default true; dev-scratch only. */
    isEmpty: integer("is_empty", { mode: "boolean" }).notNull().default(true),
    /** SPEC-0003 §2.4 row 10: archived repos refuse pushes (clone stays OK). */
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    /** SPEC-0003 §3.1: 'ready' | 'creating' | 'migrating' ('broken' reserved) —
     *  mirrors upstream RepositoryStatus (models/repo/repo.go:146-149). */
    status: text("status", { enum: ["ready", "creating", "migrating", "broken"] })
    .notNull()
    .default("ready"),
    /** Bumped on every push; cache buster for edge ref caches (SPEC-0001 §5). */
    refsVersion: integer("refs_version").notNull().default(0),
    /** Storage backend routing; only 'self-hosted' exists today (ADR-0001 D1). */
    backend: text("backend").notNull().default("self-hosted"),
    // ---------------------------------------------------------------------------
    // SPEC-0005 §3.2 maintained counters — updated in the same D1 batch as the
    // state change (issue/PR create, close, reopen, milestone create/delete).
    numIssues: integer("num_issues").notNull().default(0),
    numClosedIssues: integer("num_closed_issues").notNull().default(0),
    numPulls: integer("num_pulls").notNull().default(0),
    numClosedPulls: integer("num_closed_pulls").notNull().default(0),
    numMilestones: integer("num_milestones").notNull().default(0),
    /** SPEC-0005 §4.6: whether commits on any branch may close issues (upstream
     *  `CloseIssuesViaCommitInAnyBranch`, default false). */
    closeIssuesViaCommitInAnyBranch: integer("close_issues_via_commit_in_any_branch", {
    mode: "boolean",
    })
    .notNull()
    .default(false),
    /** Row creation timestamp (unix epoch seconds). */
    createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
    /** Row mutation timestamp (unix epoch seconds). Nullable: SQLite forbids
     *  non-constant defaults in ALTER TABLE ADD COLUMN, so the lifecycle
     *  service sets it explicitly on every rename/transfer/status write. */
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => [
    // SPEC-0003 §3.1: "UNIQUE(owner_id, lower_name) is the arbitration point
    // for every create path" — the §4.1 concurrent push-create race, rename
    // collisions and recreate-after-delete all decide here (the landed
    // owner/slug columns stand in for owner_id/lower_name).
    uniqueIndex("repositories_owner_slug_uq").on(t.ownerNamespace, t.slug),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0003 §3.1 — lifecycle tables: redirects, pending transfers, units.
// ---------------------------------------------------------------------------

/**
 * Old-URL → repo mapping after rename/transfer (SPEC-0003 §2.5.3/§2.5.4;
 * port of upstream `repo_redirect`, models/repo/redirect.go:27-33).
 * `UNIQUE(owner_id, lower_name)` is the shadow rule: at most one redirect per
 * (owner, name), deleted before a rename/create claims the name (§4.11).
 * `owner_namespace` is the case-folded lookup key (the git gate's row-13
 * check resolves old URLs without a users join).
 */
export const repoRedirects = sqliteTable(
  "repo_redirects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Owner namespace at the time of the redirect (users.id). */
    ownerId: integer("owner_id").notNull(),
    /** Case-folded owner name the old URL was filed under. */
    ownerNamespace: text("owner_namespace").notNull(),
    /** Case-folded old repository name. */
    lowerName: text("lower_name").notNull(),
    /** The repository the old URL now serves. */
    redirectRepoId: text("redirect_repo_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("repo_redirects_owner_name_uq").on(t.ownerId, t.lowerName),
    index("repo_redirects_lookup_idx").on(t.ownerNamespace, t.lowerName),
    index("repo_redirects_repo_idx").on(t.redirectRepoId),
  ],
);

/**
 * Pending transfer (SPEC-0003 §2.5.4; upstream `repo_transfer`). One live
 * request per repo (`repo_id` UNIQUE); the repo stays fully usable while the
 * row exists. Teams column deferred to SPEC-0005.
 */
export const repoTransfer = sqliteTable(
  "repo_transfer",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull().unique(),
    /** Who filed the request. */
    doerId: integer("doer_id").notNull(),
    /** Target owner (users.id). */
    newOwnerId: integer("new_owner_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
);

/**
 * Per-repo units (SPEC-0003 §3.1, minimal: 'code' only; extended in 0005).
 * `anonymous_access_mode` backs ACL rows 4/5 (upstream
 * `RepoUnit.AnonymousAccessMode`, git_smart_http_test.go:163-189).
 */
export const repoUnits = sqliteTable(
  "repo_units",
  {
    repoId: text("repo_id").notNull(),
    /** Unit type; 'code' is the only unit today. */
    type: text("type", { enum: ["code"] }).notNull().default("code"),
    /** What anonymous visitors may do on this unit: 'none' | 'read'. */
    anonymousAccessMode: text("anonymous_access_mode", { enum: ["none", "read"] })
      .notNull()
      .default("none"),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.type] })],
);

// ---------------------------------------------------------------------------
// SPEC-0005 §3.1 — per-repo monotonic issue/PR number allocation.
// ---------------------------------------------------------------------------

/**
 * One row per repository holding the shared issue/PR counter (upstream
 * `issue_index` table, `models/db/index.go`). Allocation happens inside the
 * creation batch: `UPDATE ... SET issue_index = issue_index + 1 RETURNING`,
 * then the issue/PR row inserts with a scalar subquery on the bumped value —
 * one D1 batch = one SQLite transaction, so concurrent creations get strictly
 * sequential indexes and a failed insert rolls the bump back (§4.1).
 * Counters are never reused; `syncMaxIssueIndex` is the repair path.
 */
export const repoCounters = sqliteTable("repo_counters", {
  repoId: text("repo_id")
    .primaryKey()
    .references(() => repositories.id),
  issueIndex: integer("issue_index").notNull().default(0),
});

/**
 * Identity — SPEC-0002 §3. Mirrors upstream `user` (lower_name UNIQUE,
 * IsAdmin, ProhibitLogin) reduced to what cf-gitea needs today.
 */
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Display-cased username, as Gitea's `name`. */
    username: text("username").notNull(),
    /** Case-folded login key; mirrors upstream `lower_name` UNIQUE
     *  (gitea/models/user/user.go:97) — all lookups are case-insensitive. */
    usernameLower: text("username_lower").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    /** Site admin — gates `sudo`, admin routes (upstream `IsAdmin`). */
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    /** 'active' | 'prohibited' — upstream `IsActive` / `ProhibitLogin`
     *  (gitea/routers/web/repo/githttp.go:194–197). */
    status: text("status", { enum: ["active", "prohibited"] })
      .notNull()
      .default("active"),
    /** SPEC-0003 §2.5.6 — upstream VisibleType
     *  (modules/structs/visible_type.go:9-18): 'public' | 'limited' (repos
     *  visible to any authenticated principal) | 'private' (owner + site
     *  admin only). Gates ACL row 2 alongside `repositories.visibility`. */
    visibility: text("visibility", { enum: ["public", "limited", "private"] })
      .notNull()
      .default("public"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("users_username_lower_uq").on(t.usernameLower)],
);

/**
 * Personal access tokens — SPEC-0002 §3. Opaque `cfg_<8hex>_<32base32>`
 * values, never stored in plaintext: `prefix` is the public lookup key
 * (unique index for O(1) resolution, the role upstream's non-unique
 * `token_last_eight` plays), `sha256_digest` hex-hashes the full value.
 */
export const personalAccessTokens = sqliteTable(
  "personal_access_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Caller-chosen label; duplicate-per-user rejected at the service layer,
     *  matching upstream's non-constraint check (access_token.go:130–132). */
    name: text("name").notNull(),
    /** 'cfg_<8hex>' — public lookup key, UNIQUE index for O(1) resolution.
     *  Plays the role of upstream's non-unique `token_last_eight`. */
    prefix: text("prefix", { length: 12 }).notNull(),
    /** hex(sha256(full token value)); plaintext never stored. */
    sha256Digest: text("sha256_digest", { length: 64 }).notNull(),
    /** Normalized, comma-joined upstream scope string (SPEC-0002 §2.4). */
    scopes: text("scopes").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    /** cf-gitea extension: upstream PATs never expire (SPEC-0002 §2.1);
     *  null = no expiry. */
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("pat_prefix_uq").on(t.prefix), index("pat_user_idx").on(t.userId)],
);

/**
 * Per-IP auth-failure window (SPEC-0002 §2.7). One live window per IP;
 * `count` is upserted, reset on success or window rotation.
 */
export const authFailures = sqliteTable("auth_failures", {
  ip: text("ip").notNull().primaryKey(),
  windowStart: integer("window_start", { mode: "timestamp" }).notNull(),
  count: integer("count").notNull().default(0),
});

// ---------------------------------------------------------------------------
// SPEC-0005 §3.2 — issues, PRs, comments, labels, milestones, reactions,
// releases, subscriptions, statuses, pins, webhooks.
// ---------------------------------------------------------------------------

/** `pull_requests.status` — upstream `PullRequestStatus`
 *  (gitea/models/issues/pull.go:44–57). */
export const PRStatus = {
  Conflict: 0,
  Checking: 1,
  ManuallyMerged: 2,
  Mergeable: 3,
  Error: 4,
  Empty: 5,
  Ancestor: 6,
} as const;

/** `pull_requests.flow` — upstream `PullRequestFlow` (github = 0 default). */
export const PRFlow = {
  Github: 0,
  AGit: 1,
} as const;

/**
 * Issues and pull requests (SPEC-0005 §3.2). A PR is an issue row with
 * `is_pull = 1` plus a `pull_requests` row joined on `issue_id`; both draw
 * `index` from `repo_counters` (§3.1). `(repo_id, index)` is UNIQUE — the
 * public identity contract (`issues/{index}` URLs, webhook `number`).
 */
export const issues = sqliteTable(
  "issues",
  {
    /** Global autoincrement id (webhook payload `issue.id`, comment routes). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    /** Per-repo public number, shared between issues and PRs (§3.1). */
    index: integer("index").notNull(),
    posterId: integer("poster_id"),
    /** Mirrored importer fields (upstream OriginalAuthor/OriginalAuthorID). */
    originalAuthor: text("original_author"),
    originalAuthorId: integer("original_author_id"),
    /** Title, truncated to 255 display-width chars by the service (§2.2). */
    title: text("title").notNull(),
    content: text("content"),
    contentVersion: integer("content_version").notNull().default(0),
    milestoneId: integer("milestone_id"),
    priority: integer("priority").default(0),
    isClosed: integer("is_closed", { mode: "boolean" }).notNull().default(false),
    isPull: integer("is_pull", { mode: "boolean" }).notNull().default(false),
    /** Denormalized comment count (includes system comments), maintained in
     *  the same batch as comment writes. */
    numComments: integer("num_comments").notNull().default(0),
    /** Branch reference for close-via-commit gating (§4.6); '' = default. */
    ref: text("ref").default(""),
    isLocked: integer("is_locked", { mode: "boolean" }).notNull().default(false),
    timeEstimate: integer("time_estimate").notNull().default(0),
    deadlineAt: integer("deadline_unix", { mode: "timestamp" }),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
    closedAt: integer("closed_unix", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("issues_repo_index_uq").on(t.repoId, t.index)],
);

/**
 * Pull request extension row — 1:1 with `issues` via `issue_id` (SPEC-0005
 * §3.2, mirrors `PullRequest`, gitea/models/issues/pull.go:120–152).
 * `head_sha` is a cf-gitea addition: a denormalized cache of the
 * `refs/pull/N/head` target; the engine ref stays authoritative (§3.4).
 */
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id").notNull(),
    /** Same shared per-repo number as the joined issue row. */
    index: integer("index").notNull(),
    /** `PRStatus` — created as `checking` (§3.4). */
    status: integer("status").notNull().default(PRStatus.Checking),
    /** JSON array of conflicted file paths (engine check result). */
    conflictedFiles: text("conflicted_files"),
    commitsAhead: integer("commits_ahead").default(0),
    commitsBehind: integer("commits_behind").default(0),
    headRepoId: text("head_repo_id").notNull(),
    baseRepoId: text("base_repo_id").notNull(),
    headBranch: text("head_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    mergeBase: text("merge_base"),
    /** Denormalized cache of `refs/pull/N/head`; engine ref is authoritative. */
    headSha: text("head_sha"),
    allowMaintainerEdit: integer("allow_maintainer_edit", { mode: "boolean" })
      .notNull()
      .default(false),
    hasMerged: integer("has_merged", { mode: "boolean" }).notNull().default(false),
    mergedCommitId: text("merged_commit_id"),
    mergerId: integer("merger_id"),
    mergedAt: integer("merged_unix", { mode: "timestamp" }),
    flow: integer("flow").notNull().default(PRFlow.Github),
  },
  (t) => [
    uniqueIndex("pull_requests_issue_id_uq").on(t.issueId),
    // §3.4 sync pushes look up open PRs by (head_repo_id, head_branch) —
    // fork pushes included — on every branch push.
    index("pull_requests_head_idx").on(t.headRepoId, t.headBranch),
  ],
);

/**
 * Comments — the full upstream Comment mutation-metadata shape
 * (`models/issues/comment.go:246–328`); system comments (close/reopen/labels/
 * xrefs) and user comments share this table, discriminated by `type`
 * (`CommentType` in src/issues/comment-types.ts). The xref columns
 * (types 3/4/5/6) point at the referenced issue (`ref_*`).
 */
export const comments = sqliteTable(
  "comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** `CommentType` 0–38. */
    type: integer("type").notNull(),
    posterId: integer("poster_id"),
    issueId: integer("issue_id").notNull(),
    labelId: integer("label_id"),
    oldMilestoneId: integer("old_milestone_id"),
    milestoneId: integer("milestone_id"),
    assigneeId: integer("assignee_id"),
    removedAssignee: integer("removed_assignee").default(0),
    resolveDoerId: integer("resolve_doer_id"),
    oldTitle: text("old_title"),
    newTitle: text("new_title"),
    oldRef: text("old_ref"),
    newRef: text("new_ref"),
    dependentIssueId: integer("dependent_issue_id"),
    line: integer("line"),
    treePath: text("tree_path"),
    content: text("content"),
    contentVersion: integer("content_version").notNull().default(0),
    patch: text("patch"),
    commitSha: text("commit_sha"),
    reviewId: integer("review_id").default(0),
    /** Review-thread invalidation flag (tier 2 reviews SPEC reuses it). */
    invalidated: integer("invalidated", { mode: "boolean" }).notNull().default(false),
    // Cross-reference origin columns (types 3/4/5/6, §2.2).
    refRepoId: text("ref_repo_id"),
    refIssueId: integer("ref_issue_id"),
    refCommentId: integer("ref_comment_id"),
    /** none(0)/closes(1)/reopens(2)/neutered(3). */
    refAction: integer("ref_action"),
    refIsPull: integer("ref_is_pull", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
  },
  (t) => [
    index("comments_issue_idx").on(t.issueId),
    index("comments_ref_issue_idx").on(t.refIssueId),
    index("comments_ref_repo_idx").on(t.refRepoId),
  ],
);

/**
 * Labels. Org labels are `repo_id IS NULL, org_id > 0` (upstream sentinel
 * `repo_id=0` adapted to our TEXT repo ids, §3.2); they participate in issue
 * creation and the `label.RepoID != repo.ID && label.OrgID != owner` drop
 * rule (`models/issues/issue_update.go:424–429`).
 */
export const labels = sqliteTable("labels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id"),
  orgId: integer("org_id").default(0),
  name: text("name").notNull(),
  exclusive: integer("exclusive", { mode: "boolean" }).notNull().default(false),
  exclusiveOrder: integer("exclusive_order").default(0),
  description: text("description").default(""),
  /** `#RRGGBB`. */
  color: text("color"),
  numIssues: integer("num_issues").default(0),
  numClosedIssues: integer("num_closed_issues").default(0),
  archivedAt: integer("archived_unix", { mode: "timestamp" }),
});

/** Issue↔label attachment (SPEC-0005 §3.2). */
export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: integer("issue_id").notNull(),
    labelId: integer("label_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] })],
);

/**
 * Milestones (mirrors `Milestone`, gitea/models/issues/milestone.go).
 * `completeness` is the closed/total percentage; counters are maintained on
 * issue create/close/reopen and on milestone create/delete (§3.2).
 */
export const milestones = sqliteTable("milestones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: text("repo_id").notNull(),
  name: text("name").notNull(),
  content: text("content").default(""),
  isClosed: integer("is_closed", { mode: "boolean" }).notNull().default(false),
  numIssues: integer("num_issues").default(0),
  numClosedIssues: integer("num_closed_issues").default(0),
  completeness: integer("completeness").default(0),
  deadlineAt: integer("deadline_unix", { mode: "timestamp" }),
  closedDateAt: integer("closed_date_unix", { mode: "timestamp" }),
  createdAt: integer("created_unix", { mode: "timestamp" }),
  updatedAt: integer("updated_unix", { mode: "timestamp" }),
});

/**
 * Reactions (mirrors `Reaction`, models/issues/reaction.go:62–74 — release
 * reactions included). One reaction per (user, target, type).
 */
export const reactions = sqliteTable(
  "reactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    issueId: integer("issue_id").notNull(),
    commentId: integer("comment_id").notNull().default(0),
    releaseId: integer("release_id").notNull().default(0),
    /** Emoji short-code (e.g. `+1`, `heart`). */
    type: text("type").notNull(),
    createdAt: integer("created_unix", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("reactions_target_uq").on(t.userId, t.issueId, t.commentId, t.releaseId, t.type),
  ],
);

/**
 * Releases (mirrors `Release`, models/repo/release.go). Global autoincrement
 * id; `(repo_id, tag_name)` UNIQUE — a duplicate maps to
 * `ErrReleaseAlreadyExist` → 409 (§4.11). `lower_tag_name` backs
 * case-insensitive tag lookup. Drafts hide from public lists and
 * `/releases/latest` (§2.3).
 */
export const releases = sqliteTable(
  "releases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    publisherId: integer("publisher_id").notNull(),
    tagName: text("tag_name").notNull(),
    lowerTagName: text("lower_tag_name").notNull(),
    /** Commitish the tag is created at when it does not exist yet (§2.3). */
    target: text("target").default(""),
    title: text("title").notNull().default(""),
    /** Tag commit sha once the tag exists. */
    sha1: text("sha1"),
    numCommits: integer("num_commits").default(0),
    note: text("note").default(""),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    isPrerelease: integer("is_prerelease", { mode: "boolean" }).notNull().default(false),
    /** Pure tag record with no release metadata (§2.3). */
    isTag: integer("is_tag", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    /** 0 = unpublished (draft). Plain integer per SPEC §3.2. */
    publishedUnix: integer("published_unix").notNull().default(0),
  },
  (t) => [
    uniqueIndex("releases_repo_tag_uq").on(t.repoId, t.tagName),
    index("releases_repo_created_idx").on(t.repoId, desc(t.createdAt)),
  ],
);

/**
 * Release assets — R2-backed blobs (SPEC-0005 §3.2/§3.3). Upstream keeps one
 * shared `attachment` table; we split release assets out (different storage
 * path, presign flow, size limits). Bare R2 keys only in D1, under the repo
 * prefix so repo purge covers them (§4.13).
 */
export const releaseAssets = sqliteTable(
  "release_assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uuid: text("uuid").notNull(),
    repoId: text("repo_id").notNull(),
    releaseId: integer("release_id").notNull(),
    uploaderId: integer("uploader_id"),
    name: text("name").notNull(),
    size: integer("size").notNull().default(0),
    downloadCount: integer("download_count").notNull().default(0),
    r2Key: text("r2_key").notNull(),
    checksumSha256: text("checksum_sha256"),
    createdAt: integer("created_unix", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("release_assets_uuid_uq").on(t.uuid),
    index("release_assets_release_idx").on(t.releaseId),
  ],
);

/** Issue-level subscriptions (upstream `issue_watch`, §2.2). */
export const issueSubscriptions = sqliteTable(
  "issue_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    issueId: integer("issue_id").notNull(),
    isWatching: integer("is_watching", { mode: "boolean" }).notNull(),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("issue_subscriptions_user_issue_uq").on(t.userId, t.issueId)],
);

/**
 * Commit statuses (SPEC-0005 §3.2). Sort orders and the combined-status
 * worst-of aggregation follow SPEC-0004 §2.4; this table only stores rows.
 */
export const commitStatuses = sqliteTable(
  "commit_statuses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    sha: text("sha").notNull(),
    targetUrl: text("target_url"),
    description: text("description").default(""),
    /** Status context (e.g. `ci/test`); 'default' when absent. */
    context: text("context").notNull().default("default"),
    /** pending|success|failure|warning|skipped|error. */
    state: text("state", {
      enum: ["pending", "success", "failure", "warning", "skipped", "error"],
    }).notNull(),
    creatorId: integer("creator_id"),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
  },
  (t) => [index("commit_statuses_repo_sha_idx").on(t.repoId, t.sha)],
);

// Canonical row types for consumers (API/services); feature modules may
// re-derive their own — these stay the shared reference.
export type CommitStatusRow = typeof commitStatuses.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;

/** Issue pins (tier-2 surface, table now per §3.2). */
export const issuePins = sqliteTable("issue_pins", {
  issueId: integer("issue_id").primaryKey(),
  repoId: text("repo_id"),
  pinOrder: integer("pin_order").notNull(),
});

/** `webhooks.last_status` — upstream `HookStatus`. */
export const HookStatus = {
  None: 0,
  Succeed: 1,
  Fail: 2,
} as const;

/**
 * Webhooks (SPEC-0005 §2.6, mirrors `Webhook`). `repo_id` NULL = org/user or
 * system webhook (upstream sentinel `repo_id=0`, adapted to TEXT ids);
 * `events` is the upstream `HookEvent` JSON (`push_only`, `send_everything`,
 * `choose_events`, `branch_filter`, `events` map). `CreateHookOption.active`
 * defaults to false (SPEC-0004 §2.4).
 */
export const webhooks = sqliteTable(
  "webhooks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id"),
    ownerId: integer("owner_id"),
    isSystemWebhook: integer("is_system_webhook", { mode: "boolean" })
      .notNull()
      .default(false),
    url: text("url").notNull(),
    name: text("name").notNull().default(""),
    /** POST default; GET/PUT are special forms (§2.6). */
    httpMethod: text("http_method").notNull().default("POST"),
    /** json=1 | form=2 (upstream `HookContentType`). */
    contentType: integer("content_type").notNull().default(1),
    secret: text("secret").notNull().default(""),
    /** JSON `HookEvent` blob — subscription flags + branch filter live here. */
    events: text("events").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    /** gitea|gogs|slack|discord|... (upstream `HookType`). */
    type: text("type", { length: 16 }).notNull().default("gitea"),
    /** Hook-type-specific attributes (channel id, etc.). */
    meta: text("meta").notNull().default(""),
    lastStatus: integer("last_status").notNull().default(HookStatus.None),
    /** Optional encrypted Authorization header (upstream parity). */
    headerAuthorizationEncrypted: text("header_authorization_encrypted"),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
  },
  (t) => [
    index("webhooks_repo_idx").on(t.repoId),
    index("webhooks_owner_idx").on(t.ownerId),
  ],
);

/**
 * Webhook delivery log — one row per (event, hook), inserted by
 * `emitWebhookDeliveries` AFTER the mutation's own transaction (§3.5 step 3).
 * The Queue message carries `{deliveryId}` only; the consumer drives
 * state pending → delivering → delivered (or skipped/failed) with the §3.6
 * CAS (`state='pending'` guard), so queue redelivery after a crash is a
 * no-op. `payload_content` holds the exact bytes signed and sent.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hookId: integer("hook_id").notNull(),
    /** Denormalized for the §4.13 repo purge. */
    repoId: text("repo_id").notNull(),
    uuid: text("uuid").notNull(),
    /** Specific event type (e.g. `issue_comment`) — `X-Gitea-Event-Type`. */
    eventType: text("event_type").notNull(),
    /** Event group header value (e.g. `issues`) — `X-Gitea-Event`. */
    eventGroup: text("event_group").notNull(),
    payloadContent: text("payload_content").notNull(),
    /** pending|delivering|delivered|skipped|failed. */
    state: text("state", {
      enum: ["pending", "delivering", "delivered", "skipped", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    isSucceed: integer("is_succeed", { mode: "boolean" }).notNull().default(false),
    /** JSON `HookRequest` info (Authorization masked, §3.6 step 5). */
    requestContent: text("request_content"),
    /** JSON `HookResponse` info; terminal failures record the error text. */
    responseContent: text("response_content"),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    deliveredAt: integer("delivered_unix", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_uuid_uq").on(t.uuid),
    index("webhook_deliveries_hook_idx").on(t.hookId),
  ],
);
