import { desc, sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    // -------------------------------------------------------------------------
    // SPEC-0004 §2.4 forks — the fork edge (the fifth raw-DDL sweep,
    // superseding `FORKS_DDL_STATEMENTS` in services/forks.ts; the 0005/0007/
    // 0008 supersede pattern). Kept LAST in this object because ALTER TABLE
    // ADD COLUMN physically appends the column — the table_info order below
    // is the migration order.
    // -------------------------------------------------------------------------
    /** The fork edge: the source's `repositories.id` (upstream
     *  `Repository.ForkID int64`, models/repo/repo.go), NULL for non-forks
     *  and for existing rows (nullable, no default — the ALTER ADD COLUMN
     *  constraint). Plain TEXT column, no FK, per the schema conventions
     *  above; rows need no delete-cascade entry (the edge dies with the
     *  repositories row itself). The index serves the fork list's
     *  `WHERE fork_parent = ?` scan (FindForks' `fork_id` lookup,
     *  fork.go:253) and findForkByOwner's one-fork-per-owner arbitration. */
    forkParent: text("fork_parent"),
    // -------------------------------------------------------------------------
    // SPEC-0009 §3.1 — the mirror edge (the sixth raw-DDL sweep: the wave's
    // pinned DDL, read raw by services/mirror/sync.ts until migration 0010).
    // Kept LAST like fork_parent above — ALTER TABLE ADD COLUMN physically
    // appends, so the table_info order stays the migration order.
    // -------------------------------------------------------------------------
    /** Upstream `Repository.IsMirror` (models/repo/repo.go:189): the repo is
     *  a pull mirror; its schedule/state lives in the 1:1 `repo_mirrors` row
     *  (the UNIQUE repo_id there is the per-repo arbiter). */
    isMirror: integer("is_mirror", { mode: "boolean" }).notNull().default(false),
    /** Upstream `OriginalUrl` (repo.go:163) — the sanitized source URL
     *  (userinfo stripped, modules/util/url.go:21-27). Nullable with no
     *  default (the ALTER ADD COLUMN constraint): null for non-mirrors and
     *  pre-existing rows. */
    originalUrl: text("original_url"),
  },
  (t) => [
    // SPEC-0003 §3.1: "UNIQUE(owner_id, lower_name) is the arbitration point
    // for every create path" — the §4.1 concurrent push-create race, rename
    // collisions and recreate-after-delete all decide here (the landed
    // owner/slug columns stand in for owner_id/lower_name).
    uniqueIndex("repositories_owner_slug_uq").on(t.ownerNamespace, t.slug),
    // SPEC-0004 §2.4: the fork list's source scan (verbatim from the
    // superseded FORKS_DDL_STATEMENTS index).
    index("repositories_fork_parent_idx").on(t.forkParent),
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
     *  admin only). Gates ACL row 2 alongside `repositories.visibility`.
     *  Recorded deviation from SPEC-0007 §3.2's INTEGER-ladder sketch: the
     *  landed TEXT enum stays (0003); the org service expresses the listing
     *  ceiling as an IN-list instead of a range compare. */
    visibility: text("visibility", { enum: ["public", "limited", "private"] })
      .notNull()
      .default("public"),
    // -------------------------------------------------------------------------
    // SPEC-0007 §3.2 — org-as-user-row amendments (users is ALTERed, not
    // recreated): type, profile columns, the maintained member counter, and
    // the org-only team-access flag. Upstream user.go:48–165.
    // -------------------------------------------------------------------------
    /** Upstream UserType 0/1 (user.go:48–67): 'user' | 'org' — orgs ARE user
     *  rows (upstream's own trick, `Organization.TableName()` = "user",
     *  gitea/models/organization/org.go:76–87). Usernames and org slugs share
     *  `users_username_lower_uq`; owner lookups stay one type-blind read.
     *  Reserved variants (2–5) have no cf-gitea equivalent yet. */
    type: text("type", { enum: ["user", "org"] }).notNull().default("user"),
    /** Upstream FullName (user.go:99–105); null for unused profile fields. */
    fullName: text("full_name"),
    description: text("description"),
    website: text("website"),
    location: text("location"),
    /** AvatarEmail — the hash input, not a URL (upstream AvatarEmail). No
     *  identicon is generated at org create (SPEC-0007 §4.6 divergence). */
    avatarEmail: text("avatar_email"),
    useCustomAvatar: integer("use_custom_avatar", { mode: "boolean" }).notNull().default(false),
    /** Maintained org member counter (upstream NumMembers, org.go:330–331/537);
     *  0 on plain users. Bumped/decremented in the same batch as membership
     *  writes. */
    numMembers: integer("num_members").notNull().default(0),
    /** Org-only flag, honored when teams land (upstream user.go:165); stored
     *  now so the tier-2 PATCH /orgs/{org} body has a home. */
    repoAdminChangeTeamAccess: integer("repo_admin_change_team_access", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("users_username_lower_uq").on(t.usernameLower),
    // SPEC-0007 §3.2: the type-aware partial index keeps org lookups and user
    // listings cheap.
    index("users_type_idx").on(t.type),
  ],
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

// ---------------------------------------------------------------------------
// SPEC-0006 §3.2 — LFS metadata state machine (lfs_objects).
// ---------------------------------------------------------------------------

/**
 * LFS object metadata — the batch/verify/adopt/GC state machine rows
 * (SPEC-0006 §3.2–3.4; the storage counterpart of upstream `LFSMetaObject`).
 * Rows exist only for objects the LFS API touched — a pointer merely seen in
 * git history never creates a row. Timestamps are unix seconds (`mode:
 * "timestamp"`; the LFS state service converts explicitly). State
 * transitions (§3.3):
 *
 *   absent --batch(upload)--> uploading --verify(200)--> verified
 *   absent --adopt(HEAD ok)--> verified        (upload finished, verify lost)
 *   uploading --sweep(HEAD ok)--> verified     (stale >24 h)
 *   uploading --sweep(HEAD missing)--> deleted
 *   verified --GC(unreachable > grace)--> row+object deleted
 *
 * `repo_id` is the NUMERIC repo key the LFS router derives (SPEC-0006 §2.1);
 * the composite PK `(repo_id, oid)` is the per-repo object identity, and
 * `(repo_id, state, updated_at)` serves the stale-sweep fan-out and GC
 * candidate pages (§3.4). Ported verbatim from the service-side
 * `LFS_OBJECTS_DDL_STATEMENTS` (migration 0005), which it supersedes.
 */
export const lfsObjects = sqliteTable(
  "lfs_objects",
  {
    /** Numeric repo key derived by the LFS router (not `repositories.id`). */
    repoId: integer("repo_id").notNull(),
    /** sha256 hex of the object content (= the LFS oid). */
    oid: text("oid").notNull(),
    /** Declared byte size; quota projection sums this (§4.7). */
    size: integer("size").notNull(),
    /** 'uploading' | 'verified' (§3.3). */
    state: text("state", { enum: ["uploading", "verified"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.oid] }),
    index("idx_lfs_objects_repo_state_updated").on(t.repoId, t.state, t.updatedAt),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0003 §3.1/§2.6 — async chunked import channel (repo_imports).
// ---------------------------------------------------------------------------

/**
 * One row per chunked import (SPEC-0003 §2.6, >1 GiB histories). State
 * machine (`state`, D1-authoritative — the SPEC's DO-side
 * `imports_checkpoints` awaits the engine's importCheckpoint/importFinalize
 * RPCs, a documented ENGINE-WAVE gap; the D1 row carries the same
 * information and the queue consumer is single-threaded per repo):
 *
 *   staged --start--> indexing --all chunks done--> finalizing --> done
 *      \                  \                            \
 *       \                  + chunk failure ------------> failed
 *        + abort -----------------------------(purge)--> failed
 *
 * `manifest` is the start-time JSON contract ({head, refs, chunks,
 * totalBytes}); `staged` is the upload-time JSON map (chunk index → {bytes,
 * sha1}) recorded by the relay PUTs before the manifest exists. Chunk
 * checkpoints mutate `manifest.chunks[i].status` in place under the
 * `state='indexing'` CAS guard, so a concurrent abort makes every in-flight
 * checkpoint a no-op (0 rows changed).
 */
export const repoImports = sqliteTable(
  "repo_imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    /** sha256 hex of the one-time import token (SPEC §3.1: hashed like PATs;
     *  plaintext is returned once by the POST and never stored). Unique:
     *  O(1) token → row resolution for the relay-chunk auth. */
    importTokenSha256: text("import_token_sha256").notNull(),
    /** 'staged' | 'indexing' | 'finalizing' | 'done' | 'failed' (§2.6). */
    state: text("state", { enum: ["staged", "indexing", "finalizing", "done", "failed"] })
      .notNull()
      .default("staged"),
    /** Start-time manifest JSON (ImportManifest) — null until start. */
    manifest: text("manifest"),
    /** Upload-time staged-chunk map JSON (Record<string, {bytes, sha1}>) —
     *  cf-gitea extension beyond the SPEC's column sketch (the relay needs a
     *  pre-manifest record of what landed; GET status exposes it). */
    staged: text("staged"),
    /** Chunk size cap frozen at POST time (bytes) — PUT/start enforce the
     *  value the client was told, even if the instance limit changes
     *  mid-import. */
    chunkCap: integer("chunk_cap").notNull(),
    /** Manifest-declared total (bytes); 0 until start. */
    totalBytes: integer("total_bytes").notNull().default(0),
    /** Terminal failure text (abort/failure reason). */
    error: text("error"),
    /** Consumer liveness (unix seconds); the 24 h sweep abandons on silence. */
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("repo_imports_token_uq").on(t.importTokenSha256),
    index("repo_imports_repo_idx").on(t.repoId),
    // §2.6 "one active import per repo": the partial unique index is the
    // arbitration point — a second POST racing the first loses here (the
    // whole create batch, repo status flip included, rolls back).
    uniqueIndex("repo_imports_active_uq")
      .on(t.repoId)
      .where(sql`state IN ('staged', 'indexing', 'finalizing')`),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0007 §3.3/§3.6 — org membership and user/org rename redirects.
// ---------------------------------------------------------------------------

/**
 * Org membership (SPEC-0007 §3.3; port of upstream `OrgUser`,
 * org_user.go:26–31, plus our Owners-team collapse into `role`: 'owner' ⟺
 * membership in the upstream synthetic Owners team at tier 1). Cascades on
 * either side's user row (org deletion lands later; the FK is declared now).
 */
export const orgMembers = sqliteTable(
  "org_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Public member listing flag (upstream IsPublic; default false =
     *  `DefaultOrgMemberVisible`). Grants/denies NO repo access (§4.5). */
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(false),
    /** 'owner' | 'member' — the §3.4 repo-create grant is `role = 'owner'`. */
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("org_members_org_user_uq").on(t.orgId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ],
);

/**
 * User/org rename redirects (SPEC-0007 §3.6; port of upstream `user_redirect`,
 * models/user/redirect.go:33–46). The namespace-wide alias table for user AND
 * org renames — distinct from `repo_redirects` (keyed (owner_id, lower_name)):
 * owner renames write here, repo renames there. At most one redirect per
 * lower-cased old name; creating an account/org on a live redirect consumes it.
 */
export const userRedirects = sqliteTable(
  "user_redirects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Case-folded old name — UNIQUE: one redirect per name. */
    lowerName: text("lower_name").notNull(),
    redirectUserId: integer("redirect_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("user_redirects_lower_uq").on(t.lowerName)],
);

// ---------------------------------------------------------------------------
// SPEC-0004 batch-7 stores — the migration sweep of the raw-D1 schema gap
// (`REPO_TOPICS/REPO_WATCHERS/REPO_COLLABORATORS/REPO_SETTINGS_DDL_STATEMENTS`
// in the services, ported verbatim; same supersede pattern as migration
// 0005's LFS/org consolidation). All four key on the TEXT `repositories.id`,
// all four are repo-scoped rows deleted in the deleteRepository cascade
// (src/repos/service.ts) — no declared FK, per the schema conventions above.
// Timestamps stay the raw DDL's bare INTEGER unix seconds (app-managed, no
// unixepoch() defaults — the services always bind them explicitly).
// ---------------------------------------------------------------------------

/**
 * Repo topics (upstream pairs a `topic` + `repo_topic` join with a
 * denormalized `repository.topics` render cache; the join half is the one the
 * API semantics need — see services/repo-topics.ts). `(repo_id, topic)` is
 * the PK: SaveTopics' diffed replace relies on it (a naive delete-all +
 * re-insert would abort on kept rows).
 */
export const repoTopics = sqliteTable(
  "repo_topics",
  {
    repoId: text("repo_id").notNull(),
    /** Sanitized name: trimmed, lowercased, `^[a-z0-9][-.a-z0-9]*$`, ≤ 35. */
    topic: text("topic").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.topic] })],
);

/**
 * Repo-level watch edges (upstream `repo_watcher`, models/repo/watch.go —
 * deliberately NOT `issue_watch`, which is `issue_subscriptions` here).
 * `(repo_id, user_id)` PK; `ON CONFLICT DO NOTHING` keeps the FIRST
 * `created_at` on repeat watches. `ignored` is always false at this tier
 * (user-notification setting) and has no column.
 */
export const repoWatchers = sqliteTable(
  "repo_watchers",
  {
    repoId: text("repo_id").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.userId] }),
    index("idx_repo_watchers_user").on(t.userId),
  ],
);

/**
 * Repo collaborators (upstream `collaboration`,
 * models/repo/collaboration.go) — one row per (repo, user) with the
 * `read|write|admin` access mode. The composite PK is the upsert arbiter
 * (AddOrUpdateCollaborator), `mode` defaults to 'write' when the Add
 * Collaborator body omits `permission`; implicit rowid order = upstream's
 * `collaboration.id` order (the list/assignee renders order by it).
 */
export const repoCollaborators = sqliteTable(
  "repo_collaborators",
  {
    repoId: text("repo_id").notNull(),
    userId: integer("user_id").notNull(),
    mode: text("mode", { enum: ["read", "write", "admin"] }).notNull().default("write"),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.userId] }),
    index("idx_repo_collaborators_user").on(t.userId),
  ],
);

/**
 * Repo-edit stored subset (SPEC-0004 §2.4 `PATCH /repos/{owner}/{repo}`):
 * the `EditRepoOption` fields with no landed `repositories` column that must
 * survive a PATCH→GET round trip — profile text and the has_* unit flags.
 * Upstream keeps these on the repository row itself; a side table (1:1,
 * `repo_id` PK) avoids touching the hot `repositories` schema. Missing row =
 * upstream defaults (services/repo-settings.ts DEFAULT_REPO_SETTINGS).
 */
export const repoSettings = sqliteTable("repo_settings", {
  repoId: text("repo_id").primaryKey(),
  description: text("description").notNull().default(""),
  website: text("website").notNull().default(""),
  hasIssues: integer("has_issues", { mode: "boolean" }).notNull().default(true),
  hasWiki: integer("has_wiki", { mode: "boolean" }).notNull().default(true),
  hasPullRequests: integer("has_pull_requests", { mode: "boolean" }).notNull().default(true),
  hasReleases: integer("has_releases", { mode: "boolean" }).notNull().default(true),
  hasProjects: integer("has_projects", { mode: "boolean" }).notNull().default(false),
  hasPackages: integer("has_packages", { mode: "boolean" }).notNull().default(false),
  hasActions: integer("has_actions", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

// ---------------------------------------------------------------------------
// SPEC-0004 appendix A — user follows (tier-2 follow trio).
// ---------------------------------------------------------------------------

/**
 * User follows (port of upstream `Follow`, models/user/follow.go:13–19):
 * `user_id` follows `follow_id`; the pair is UNIQUE (upstream
 * `UNIQUE(follow)`), the reverse direction gets its own index for follower
 * listings. Both edges cascade on the user row (the delete-user flow's
 * explicit follow cleanup upstream). User-scoped — NOT part of the
 * repo-delete cascade. `created_at` is unix seconds mirroring `CreatedUnix
 * xorm:"INDEX created"`.
 */
export const follows = sqliteTable(
  "follows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followId: integer("follow_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("follows_user_follow_uq").on(t.userId, t.followId),
    index("follows_follow_idx").on(t.followId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0004 §2.4 stragglers — user stars + account preference settings (the
// fourth raw-DDL sweep; `STARS_DDL_STATEMENTS`/`USER_SETTINGS_DDL_STATEMENTS`
// in the services, ported verbatim; the 0005/0007 supersede pattern).
// ---------------------------------------------------------------------------

/**
 * Repo stars (port of upstream `Star`, models/repo/star.go:17–22):
 * `UNIQUE(user_id, repo_id)` is the idempotence arbitration point (the PUT
 * star's ON CONFLICT DO NOTHING), the reverse index serves repo-side counts
 * and the delete cascade, `created_at` is unix seconds (repo convention)
 * mirroring `CreatedUnix xorm:"INDEX created"`. `user_id` cascades like the
 * rest of the users-adjacent tables; `repo_id` is the registry's TEXT id
 * (no FK — plain column per the schema conventions above), and its rows are
 * deleted in the deleteRepository cascade (src/repos/service.ts).
 */
export const stars = sqliteTable(
  "stars",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("stars_user_repo_uq").on(t.userId, t.repoId),
    index("stars_repo_idx").on(t.repoId),
  ],
);

/**
 * User account preference settings (the five upstream `user` preference
 * columns with no landed `users` column — user.go:171–173 + :102 + :119,
 * reduced into this side store by services/user-settings.ts): 1:1 on the
 * user row (`user_id` PK), FK cascade like the rest of the users-adjacent
 * tables. Booleans are the repo-convention INTEGERs. The defaults are
 * upstream's creation values (theme 'gitea-auto'; empty style/language;
 * keep-email/activity private false) — an absent row renders the same
 * defaults (the service's DEFAULT_USER_SETTINGS). User-scoped — NOT part
 * of the repo-delete cascade.
 */
export const userSettings = sqliteTable("user_settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("gitea-auto"),
  language: text("language").notNull().default(""),
  diffViewStyle: text("diff_view_style").notNull().default(""),
  hideEmail: integer("hide_email", { mode: "boolean" }).notNull().default(false),
  hideActivity: integer("hide_activity", { mode: "boolean" }).notNull().default(false),
});

// ---------------------------------------------------------------------------
// SPEC-0009 §3.1 — pull-mirror schedule/state (the sixth raw-DDL sweep: the
// wave's pinned DDL comment in services/mirror/sync.ts, ported verbatim into
// this table; the sync service's raw reads/writes swapped one-for-one in the
// same change). Upstream `Mirror`, models/repo/mirror.go:23-38.
// ---------------------------------------------------------------------------

/**
 * One pull mirror per repository — `repo_id` UNIQUE is the per-repo
 * arbitration point (upstream `GetMirrorByRepoID` assumes ≤ 1,
 * mirror.go:80-88). Plain `repo_id` column (no FK) per the schema
 * conventions above; rows are removed by the deleteRepository cascade
 * (SPEC-0009 §4.3.13 → SPEC-0003 §2.5.5 step 1). Timestamps are unix
 * seconds; `next_sync_at`/`last_sync_at` stay plain integers (no timestamp
 * mode) because the sync arithmetic (`now + interval`), the due scan
 * (`next_sync_at <= now AND next_sync_at != 0`) and the `0 = unscheduled`
 * sentinel all work on raw numbers. The sync-state machine (§2.6):
 *
 *   idle --cron CAS--> queued --claim CAS--> syncing --success--> idle
 *      \                     \                  \
 *       \                     + delete race     + failure settle --> idle
 *        + (any CAS loser is a no-op: 0 rows)    (next_sync_at stays due)
 */
export const repoMirrors = sqliteTable(
  "repo_mirrors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The mirrored repository's `repositories.id`; UNIQUE = one pull mirror
     *  per repo. AAD half of the credential envelope (§4.2). */
    repoId: text("repo_id").notNull().unique(),
    /** Sync cadence seconds; `0` = disabled; validated ≥ MIRROR_MIN_INTERVAL
     *  (default 600) unless 0 (upstream `Interval`/`ScheduleNextUpdate`,
     *  mirror.go:71-77). 28800 = upstream's 8 h default. */
    intervalSeconds: integer("interval_seconds").notNull().default(28800),
    /** Delete remote-side refs that vanished upstream (§2.6 step 2). */
    enablePrune: integer("enable_prune", { mode: "boolean" }).notNull().default(true),
    /** Reserved for LFS mirroring (§1; upstream mirror.go:34-35) — created
     *  now, unengineered until the LFS-mirror wave. */
    lfsEnabled: integer("lfs_enabled", { mode: "boolean" }).notNull().default(false),
    lfsEndpoint: text("lfs_endpoint"),
    /** Sanitized source URL (userinfo stripped, modules/util/url.go:21-27) —
     *  the egress gate re-checks THIS stored value on every sync (§4.1). */
    remoteAddress: text("remote_address").notNull(),
    /** Not secret (§3.1): upstream keeps it in the remote URL. */
    credentialsUsername: text("credentials_username"),
    /** AES-256-GCM over the full Authorization header value (§4.2), keyed by
     *  the MIRROR_CREDENTIAL_KEY KEK, AAD-bound to `(mirror_id, repo_id)`. */
    credentialsCiphertext: text("credentials_ciphertext"),
    /** The enqueue/serialization guard (§2.6 step 1): `idle → queued` (cron
     *  producer), `queued|idle → syncing` (consumer claim), back to `idle`
     *  on settle. CHECK'd in DDL exactly like the sweep's pinned DDL. */
    syncState: text("sync_state", { enum: ["idle", "queued", "syncing"] })
      .notNull()
      .default("idle"),
    /** Next scheduled sync (unix seconds); `0` = unscheduled/disabled
     *  (upstream `NextUpdateUnix`). */
    nextSyncAt: integer("next_sync_at").notNull().default(0),
    /** Last successful sync (unix seconds); null until the first one
     *  (upstream `LastUpdateUnix`) — the due scan's oldest-first order key. */
    lastSyncAt: integer("last_sync_at"),
    /** Sanitized last failure (§2.6 step 5); cleared on success. Failure
     *  leaves `next_sync_at` due so the next cron retries (upstream posture,
     *  mirror_pull.go:303-308). */
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    /** Bumped by every CAS write (the sync service always sets it). */
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [check("repo_mirrors_sync_state_check", sql`${t.syncState} IN ('idle', 'queued', 'syncing')`)],
);

// ---------------------------------------------------------------------------
// Tier-2 notifications — the Gitea `notification` tag (7 contract ops,
// SPEC-0004 §2.6 tier-3 row promoted). The notification thread set is
// DERIVED from issue/comment activity (repos the user watches or owns plus
// issue participation — see routes/notifications.ts for the upstream
// deviations this model documents); the only materialized per-user state is
// the read marker and the pin flag, one row per (user, issue) — migration
// 0011. Upstream materializes a `notification` row per recipient per issue
// at activity time (models/activities/notification.go:52-73); the derived
// model reaches the same observable thread list without a write-path hook
// into the issue services.
// ---------------------------------------------------------------------------

/**
 * Per-user notification read/pin state, keyed `(user_id, issue_id)` — the
 * upstream `GetIssueNotification` identity (one notification per user per
 * issue, models/activities/notification.go:199-206). The upstream status
 * enum (unread=1 / read=2 / pinned=3, notification.go:31-38) collapses into
 * the `(read_at_unix, pinned)` pair: a thread is *unread* while activity on
 * the issue is newer than `read_at_unix` (0 = never read), *pinned* while
 * `pinned` is set (pinning implies non-unread, mirroring ToNotificationThread's
 * `Unread = !(read || pinned)`, services/convert/notification.go:20). New
 * activity after a read therefore re-marks the thread unread without any
 * write-path hook — the property the derived model is built around.
 * `read_at_unix` stays a plain integer (not `mode: "timestamp"`) because the
 * derived-thread comparisons bind raw unix column values.
 */
export const notificationStates = sqliteTable(
  "notification_states",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    /** The thread's underlying `issues.id` — the API thread id IS this issue
     *  id (one thread per user per issue; issue ids are globally unique, so
     *  the thread id space is collision-free). */
    issueId: integer("issue_id").notNull(),
    /** Unix seconds of the last activity the user consumed; 0 = nothing read
     *  (any activity leaves the thread unread). */
    readAtUnix: integer("read_at_unix").notNull().default(0),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    /** Last state write (unix seconds; set explicitly by the mark paths). */
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("notification_states_user_issue_uq").on(t.userId, t.issueId),
    index("notification_states_user_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0005 §2.2 tier-2 issue TABLE families — assignees, dependencies,
// tracked times, stopwatches (migration 0012; routes/issue-tables-t2.ts).
// All four mirror their upstream table verbatim in column form (upstream
// xorm DDL, models/issues/{assignees,dependency,tracked_time,stopwatch}.go);
// the routes around them carry the citations and collapsed-gate notes.
// ---------------------------------------------------------------------------

/**
 * Issue↔assignee edges (upstream `issue_assignees`, models/issues/
 * assignees.go:15-21: `ID pk autoincr, AssigneeID INDEX, IssueID INDEX`).
 * Upstream guards duplicates in code (`AddAssigneeIfNotAssigned`); the
 * `(issue_id, assignee_id)` unique index here is the same arbitration point
 * the landed `issue_pins`/`issue_subscriptions` tables use (the ON CONFLICT
 * DO NOTHING add path — concurrent adds lose silently, the re-add is also
 * the code-path skip). The reverse index serves "issues assigned to you"
 * reads. Rows are deleted with the issue (§4.12 cascade owner: the landed
 * deleteIssueCascade; the join-table sweep lands with it).
 */
export const issueAssignees = sqliteTable(
  "issue_assignees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id").notNull(),
    assigneeId: integer("assignee_id").notNull(),
  },
  (t) => [
    uniqueIndex("issue_assignees_issue_assignee_uq").on(t.issueId, t.assigneeId),
    index("issue_assignees_assignee_idx").on(t.assigneeId),
  ],
);

/**
 * Issue dependency edge — `issue_id` depends on `dependency_id` (upstream
 * `issue_dependency`, models/issues/dependency.go:101-110: `ID pk, UserID
 * NOT NULL, IssueID + DependencyID UNIQUE(issue_dependency), CreatedUnix,
 * UpdatedUnix`). ONE row per direction: "A is blocked by B" is
 * `(issue_id=A, dependency_id=B)`, so the blocks family reads the same rows
 * from the other side. The reverse index serves the blocking direction's
 * scans (`BlockingDependencies`, models/issues/issue.go:691-708).
 */
export const issueDependencies = sqliteTable(
  "issue_dependency",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The doer that created the edge (upstream `UserID NOT NULL`). */
    userId: integer("user_id").notNull(),
    /** The dependent issue (the one being blocked). */
    issueId: integer("issue_id").notNull(),
    /** The blocker issue. */
    dependencyId: integer("dependency_id").notNull(),
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("issue_dependency_issue_dep_uq").on(t.issueId, t.dependencyId),
    index("issue_dependency_dependency_idx").on(t.dependencyId),
  ],
);

/**
 * Tracked time entries (upstream `tracked_time`, models/issues/
 * tracked_time.go:16-26: `ID pk autoincr, IssueID INDEX, UserID INDEX,
 * CreatedUnix created, Time NOT NULL, Deleted NOT NULL DEFAULT false`).
 * `seconds` is upstream's `Time` (int64 seconds — a negative value is
 * upstream-legal and passes through). Soft delete mirrors upstream exactly:
 * `DeleteIssueUserTimes`/`DeleteTime` flip `deleted` and every read filters
 * `deleted = false` (`FindTrackedTimesOptions.ToConds`), so the ids stay
 * addressable in timelines (`comments.time_id` points at them).
 */
export const trackedTimes = sqliteTable(
  "tracked_time",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id").notNull(),
    userId: integer("user_id").notNull(),
    /** Seconds spent (upstream `Time NOT NULL`). */
    seconds: integer("seconds").notNull(),
    /** Upstream `Deleted` — soft-delete flag; lists filter it out. */
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_unix", { mode: "timestamp" }),
  },
  (t) => [
    index("tracked_time_issue_idx").on(t.issueId),
    index("tracked_time_user_idx").on(t.userId),
  ],
);

/**
 * Running stopwatches (upstream `stopwatch`, models/issues/stopwatch.go:16-22:
 * `ID pk autoincr, IssueID INDEX, UserID INDEX, CreatedUnix created`). At
 * most one row per USER exists at a time (upstream `CreateIssueStopwatch`
 * finishes any other stopwatch the user had — models/issues/stopwatch.go:
 * 172-206); the elapsed value is derived as `now - created_unix`, never
 * stored. Mirrors the two single-column indexes (no pair unique — the
 * single-per-user rule is enforced by the start path's read + swap).
 */
export const issueStopwatches = sqliteTable(
  "stopwatch",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issueId: integer("issue_id").notNull(),
    userId: integer("user_id").notNull(),
    /** Stopwatch start (unix seconds; the elapsed value derives from it). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("stopwatch_user_idx").on(t.userId),
    index("stopwatch_issue_idx").on(t.issueId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0010 §3 — web sessions: the D1 store behind the `gitea_session`
// cookie (SPEC-0008 milestone U4). Migration 0013.
// ---------------------------------------------------------------------------

/**
 * One row per live web session (SPEC-0010 §3). The row shape mirrors
 * upstream's `auth_token` table (models/auth/auth_token.go: `ID` string pk,
 * `TokenHash`, `UserID`, `ExpiresUnix`, `PreviousTokenHash`, `RotatedUnix`)
 * plus the throttled `last_seen_at`. The row plays the role of upstream's
 * server-side session store verbatim: the cookie carries only `id:secret`
 * (§2.3), the 256-bit secret itself is never stored — `sha256_digest` is
 * hex(sha256(secret)) and every comparison is timing-safe
 * (src/auth/digest.ts). `previous_sha256_digest` identifies in-flight stale
 * cookies without authenticating them (the 60 s rotation grace, §2.4 step 3),
 * `rotated_at` bounds that grace and triggers re-rotation (≥ 24 h), and
 * `expires_at` is the hard TTL (24 h at mint, extended on every rotation —
 * an actively used session keeps living, an idle one dies). Timestamps are
 * unix seconds (`mode: "timestamp"`, SPEC-0002 §3 conventions); GC is lazy —
 * expiry is checked before authority (§2.4 step 2) and each POST /login
 * sweeps expired rows in waitUntil; no cron exists.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    /** Public row id: 10 chars of crypto-random alphanumeric (upstream
     *  `util.CryptoRandomString(10)`, services/auth/auth_token.go:100). Not
     *  secret; the secret half of the cookie is. */
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** hex(sha256(secret)); the 256-bit secret itself is never stored. */
    sha256Digest: text("sha256_digest", { length: 64 }).notNull(),
    /** Previous secret's digest — identifies in-flight stale cookies without
     *  authenticating them (upstream `PreviousTokenHash`). */
    previousSha256Digest: text("previous_sha256_digest", { length: 64 }),
    /** Bounds the 60 s stale-cookie grace window; rotation trigger. */
    rotatedAt: integer("rotated_at", { mode: "timestamp" }).notNull(),
    /** Hard expiry; extended on rotation (§2.3). */
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    /** Throttled write: at most once per hour per session (§3). */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0005 §3.3 — issue/comment attachments: the D1 half of the relay-store
// family (routes/issue-attachments.ts). Migration 0014.
// ---------------------------------------------------------------------------

/**
 * Issue and comment attachments (upstream `attachment`,
 * models/repo/attachment.go:34-49 — one shared table for release/issue/
 * comment assets). The release half already landed as `release_assets`
 * (split out per SPEC-0005 §3.2: different storage path and flow); this is
 * the issue/comment half, addressed by `issue_id` with `comment_id = 0`
 * marking a direct issue attachment (upstream's
 * `attachmentBelongsToRepoOrIssue`/`…OrComment` split,
 * routers/api/v1/repo/issue_attachment.go:371-387 and
 * issue_comment_attachment.go:396-413).
 *
 * Storage: R2 keys are `repos/<storage_key>/attachments/<attachment_id>/<sanitized
 * name>` under the shared REPO_PACKS bucket — a NEW key family next to
 * `release-assets/`, covered by the repo-prefix purge (SPEC-0005 §4.13) and
 * documented in SPEC-0005 §3.3. Row-first landing (the id is part of the
 * key): the row is inserted before the bytes stream, so `r2_key` starts
 * NULL and flips on upload completion — the two-phase relay of
 * routes/issue-attachments.ts. Conventions follow `release_assets` (uuid
 * unique, download_count, size, created_unix; timestamps unix seconds).
 */
export const issueAttachments = sqliteTable(
  "issue_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uuid: text("uuid").notNull(),
    issueId: integer("issue_id").notNull(),
    /** 0 = a direct issue attachment; > 0 = an attachment of that comment. */
    commentId: integer("comment_id").notNull().default(0),
    uploaderId: integer("uploader_id"),
    /** Display filename (verbatim in D1; the R2 key segment is sanitized). */
    name: text("name").notNull(),
    size: integer("size").notNull().default(0),
    downloadCount: integer("download_count").notNull().default(0),
    /** Bare R2 key; NULL until the relay upload completed (row-first landing). */
    r2Key: text("r2_key"),
    /** hex sha256 of the stored bytes (cheap — the single streaming pass
     *  already digests them; the `release_assets` convention). */
    checksumSha256: text("checksum_sha256"),
    createdAt: integer("created_unix", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("issue_attachments_uuid_uq").on(t.uuid),
    index("issue_attachments_issue_idx").on(t.issueId),
    index("issue_attachments_comment_idx").on(t.commentId),
  ],
);
