import { desc, sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
    // -------------------------------------------------------------------------
    // Long-tail batch (wave-api-badges-licenses-template) — the template flag.
    // Kept LAST like fork_parent/is_mirror above — ALTER TABLE ADD COLUMN
    // physically appends, so the table_info order stays the migration order.
    // -------------------------------------------------------------------------
    /** Upstream `Repository.IsTemplate` (models/repo/repo.go:190): the repo
     *  may seed `POST /repos/{template_owner}/{template_repo}/generate`
     *  copies (api/routes/generate-repo.ts). NOT NULL DEFAULT FALSE per the
     *  upstream column default; the ALTER backfills existing rows false. */
    isTemplate: integer("is_template", { mode: "boolean" }).notNull().default(false),
    // -------------------------------------------------------------------------
    // Settle-time repo size (wave-repo-size) — upstream's size accounting,
    // Kept LAST like fork_parent/is_mirror/is_template above — ALTER TABLE
    // ADD COLUMN physically appends, so the table_info order stays the
    // migration order.
    // -------------------------------------------------------------------------
    /** Upstream `Repository.Size int64` (repo.go:203) rendered as the API
     *  `size` KB integer (services/convert/repository.go:207
     *  `Size: int(repo.Size / 1024)`). Upstream stores BYTES (git + LFS,
     *  models/repo/update.go:110) and divides at render; we store the settled
     *  KiB directly — the floored KB value the API serves. The byte source is
     *  upstream's CalRepositorySize scope (modules/git/size.go:15-39 — the
     *  git-directory walk) mapped onto our storage: the R2 `repos/<key>/`
     *  prefix (packs + staging + clone cache, packages/git-engine
     *  src/git/r2keys.ts), summed by services/repo-size.ts at the settle
     *  points upstream recomputes (push.go:81, fork.go:190, generate.go:295).
     *  NULL-free DEFAULT 0 = the empty repo (ALTER backfills existing rows
     *  0; the next settle leg over the prefix re-accounts them). */
    sizeKb: integer("size_kb").notNull().default(0),
    // -------------------------------------------------------------------------
    // Social counters (wave-star-watch-counters) — upstream's star/watch
    // tallies. Kept LAST like fork_parent/is_mirror/is_template/size_kb above
    // — ALTER TABLE ADD COLUMN physically appends, so the table_info order
    // stays the migration order.
    // -------------------------------------------------------------------------
    /** Upstream `Repository.NumStars` (models/repo/repo.go:168) — rendered
     *  as the API `stars_count` (services/convert/repository.go:219
     *  `Stars: repo.NumStars`). Maintained in the SAME D1 batch as the star
     *  edge write (upstream star.go:45/59 — insert/delete + the
     *  `num_stars ± 1` update inside one WithTx), and by the block cascade's
     *  unstar arm (services/user/block.go:150-181 → StarRepo(false) per
     *  repo). The per-USER twin (`user.num_stars`, star.go:48/62) landed
     *  alongside as migration 0031 (the users.num_stars column below).
     *  NOT NULL DEFAULT 0: the ALTER backfills pre-existing rows to 0 (the
     *  one-time settle for rows predating migration 0030 — existing star
     *  edges keep counting only via the next unstar/restar cycle; the
     *  idempotent operator sweep, if ever needed, is
     *  `UPDATE repositories SET num_stars = (SELECT count(*) FROM stars
     *  WHERE stars.repo_id = repositories.id)` (and the repo_watchers twin
     *  for num_watches) via wrangler d1 execute — deliberately NOT
     *  automated: dev D1 is scratch (AGENTS.md) and remote D1 has no
     *  production rows yet (placeholder database_id). */
    numStars: integer("num_stars").notNull().default(0),
    /** Upstream `Repository.NumWatches` (repo.go:167) — rendered as the API
     *  `watchers_count` (convert/repository.go:221 `Watchers:
     *  repo.NumWatches`). Maintained in the SAME D1 batch as the watch edge
     *  write, ONLY when watching-ness flips (upstream watchRepoByMode's
     *  repoWatchDelta arithmetic, watch.go:128-154 — a repeat watch or a
     *  no-op unwatch never moves the column), and by the block cascade's
     *  unwatch arm (block.go:183-214 → WatchRepoAuto(false) per repo).
     *  Upstream's ClearRepoWatches zeroes it when a repo goes private
     *  (watch.go:327-333) — wired via clearRepoWatches in the repo-edit
     *  visibility arm (services/repo-watchers.ts). Backfill = the DEFAULT 0,
     *  same settle posture as num_stars above. */
    numWatches: integer("num_watches").notNull().default(0),
    // -------------------------------------------------------------------------
    // Fork tally (wave-counters-2) — the social-counters block's third column.
    // Kept LAST like fork_parent/is_mirror/is_template/size_kb/num_stars/
    // num_watches above — ALTER TABLE ADD COLUMN physically appends, so the
    // table_info order stays the migration order.
    // -------------------------------------------------------------------------
    /** Upstream `Repository.NumForks` (models/repo/repo.go:169) — rendered as
     *  the API `forks_count` (services/convert/repository.go:220
     *  `Forks: repo.NumForks`). Upstream bumps it inside ForkRepository's
     *  creation transaction (services/repository/fork.go:110-113 →
     *  IncrementRepoForkNum, models/repo/fork.go:57-61 — the raw
     *  `num_forks = num_forks + 1` UPDATE; the SOLE increment call site — the
     *  template-generate copy, GenerateRepository, never touches it: a
     *  generated repo has IsFork=false/ForkID=0) and decrements when a fork
     *  is deleted (services/repository/delete.go:224-228) or converted back
     *  to a normal repo (fork.go:221-227 → DecrementRepoForkNum,
     *  models/repo/fork.go:63-66). Maintained HERE at the fork settle — the
     *  CAS `creating → ready` flip in repos/fork-task.ts settleForkRow, the
     *  exactly-once gate standing in for upstream's create-time bump (a
     *  documented timing divergence: the tally moves when the fork becomes
     *  servable, not when the row is minted) — guarded, inside the settle's
     *  one D1 batch, by the fork row still being 'creating'. The fork-delete
     *  / child-reset decrements (delete.go:224-228 / :282-285) live in the
     *  delete cascade (repos/service.ts) — reported to that owner, not wired
     *  here. NOT NULL DEFAULT 0: the ALTER backfills pre-existing rows to 0;
     *  the idempotent operator sweep, if ever needed, is
     *  `UPDATE repositories SET num_forks = (SELECT count(*) FROM
     *  repositories f WHERE f.fork_parent = repositories.id)` via
     *  `wrangler d1 execute` — deliberately NOT automated (dev D1 is scratch,
     *  AGENTS.md; remote D1 has no production rows yet). */
    numForks: integer("num_forks").notNull().default(0),
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
    // Index audit P1: owner-scoped repo scans. `owner_id` is nullable and NOT
    // covered by `repositories_owner_slug_uq` (that one leads with the
    // owner_namespace slug), so every `WHERE owner_id = ?` walk was a full
    // table scan: the org repo listing (services/orgs/orgs.ts:619-620), the
    // org-wide branch-protection fan (services/branch-protection.ts:1049),
    // the block cascade's unwatch/unstar arms (api/services/blocks.ts:464-470)
    // and the feeds' owner-private probe (api/services/activity-feeds.ts:174).
    // Upstream carries the same index (`OwnerID int64
    // xorm:"UNIQUE(s) index"`, models/repo/repo.go).
    index("repositories_owner_id_idx").on(t.ownerId),
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
    /**
     * Unit type; SPEC-0016 M2 (ratification 7) extends the enum with
     * 'packages' (upstream unit 9, models/unit/unit.go:34 TypePackages) so
     * the R16 tab/visibility work can carry per-unit rows. The TEXT column
     * carries no CHECK constraint — the extension is type-level only, no SQL
     * migration (drizzle's SQLite enum is TS-only), verified by the
     * db:generate no-drift gate. The R16 gate itself rides
     * `repo_settings.has_packages` (the landed MustEnableRepoPackages
     * reduction, the has_projects precedent).
     * SPEC-0012 M1a adds 'actions' (upstream unit 10,
     * models/unit/unit.go:35 TypeActions) — the owner-scope runner scan's
     * unit gate (services/actions CreateTaskForRunner's repo_unit join).
     * The repoEdit parity wave adds 'pull_requests' (upstream unit 2,
     * models/unit/unit.go:28 TypePullRequests) and 'projects' (upstream
     * unit 8, models/unit/unit.go:38 TypeProjects) — config carriers for
     * the PATCH /repos merge-flag + projects_mode stores
     * (services/repo-settings.ts; upstream unit 5 TypeCode keeps its
     * pre-existing row role: has_code's lockstep toggle). Same type-level
     * -only extension, no SQL migration.
     */
    type: text("type", {
      enum: ["code", "packages", "actions", "pull_requests", "projects"],
    }).notNull().default("code"),
    /** What anonymous visitors may do on this unit: 'none' | 'read'. */
    anonymousAccessMode: text("anonymous_access_mode", { enum: ["none", "read"] })
      .notNull()
      .default("none"),
    /**
     * SPEC-0012's ActionsConfig store (upstream `RepoUnit.Config`,
     * models/repo/repo_unit.go:32 — `Config convert.Conversion xorm:"TEXT"`,
     * the unit-type-specific JSON blob). Only the actions unit carries one
     * here: the ActionsConfig (models/repo/repo_unit_actions.go:76-93 —
     * CollaborativeOwnerIDs, TokenPermissionMode, MaxTokenPermissions,
     * OverrideOwnerConfig plus the workflow-disable maps), serialized/
     * deserialized by services/actions/config.ts in upstream's exact
     * Go-marshal shape. NULL = upstream's nil-Config unit: ActionsConfig()
     * answers the zero value, so the loader treats NULL as the empty config.
     * The column's lifetime inherits upstream's for free through the landed
     * unit-toggle lockstep write (repo-settings.ts saveRepoSettings): the
     * disable arm deletes the actions row (UpdateRepositoryUnits' delete
     * arm), wiping the config; re-enabling starts fresh — upstream
     * ActionsUnitPost's newRepoUnit(repo, TypeActions, nil) is the same
     * reset.
     */
    config: text("config"),
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
 *
 * `run_index` (SPEC-0012 §4.5) is the second counter: upstream's
 * `action_run_index` named sequence (GetNextResourceIndex,
 * models/db/index.go:115-168) feeding `action_runs.index`. The Actions
 * trigger's `nextRunIndex` bumps it in its own atomic batch, with the same
 * never-rewind repair discipline (bootstrap at the repo's current max —
 * rows created before the column carry 0 — then a guarded max() raise) so a
 * pre-column repo self-heals on first use. `UNIQUE(repo_id, index)` on
 * action_runs stays as the backstop for the two max+1 writers that bypass
 * the counter (invalid-workflow runs, repo-actions routes).
 */
export const repoCounters = sqliteTable("repo_counters", {
  repoId: text("repo_id")
    .primaryKey()
    .references(() => repositories.id),
  issueIndex: integer("issue_index").notNull().default(0),
  runIndex: integer("run_index").notNull().default(0),
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
    // -------------------------------------------------------------------------
    // Social counter (wave-counters-2) — the per-USER star tally. Kept LAST
    // in this object because ALTER TABLE ADD COLUMN physically appends the
    // column — the table_info order below is the migration order.
    // -------------------------------------------------------------------------
    /** Upstream `User.NumStars` (models/user/user.go:155) — rendered as the
     *  API `starred_repos_count` (modules/structs/user.go:60
     *  `StarredRepos`; also the GET /user/starred pagination total,
     *  routers/api/v1/user/star.go:85-86/117-118). Maintained in the SAME
     *  transaction as the star edge (upstream star.go:48/62 — the
     *  `num_stars ± 1` update inside StarRepo's WithTx, beside the
     *  repositories.num_stars bump), by the block cascade's unstar arm
     *  (block.go:172-175 → StarRepo(false) per repo), and on repo delete
     *  (services/repository/delete.go:133 — each stargazer loses one; wired
     *  in deleteRepository's batch, repos/service.ts).
     *  NOT NULL DEFAULT 0: the ALTER backfills existing rows to 0 beneath
     *  surviving star edges — un-star floors at 0 (the MAX(…,0) drift
     *  insurance, same posture as repositories.num_stars); the idempotent
     *  operator sweep, if ever needed, is `UPDATE users SET num_stars =
     *  (SELECT count(*) FROM stars WHERE stars.user_id = users.id)` via
     *  `wrangler d1 execute` — deliberately NOT automated (dev D1 is
     *  scratch, AGENTS.md; remote D1 has no production rows yet). */
    numStars: integer("num_stars").notNull().default(0),
    // -------------------------------------------------------------------------
    // Auth last-login (P3-7) — kept LAST for the same reason as `num_stars`:
    // ALTER TABLE ADD COLUMN physically appends the column.
    // -------------------------------------------------------------------------
    /** Upstream `User.LastLoginUnix` (models/user/user.go:124, `xorm:"INDEX"`)
     *  — set at every SESSION MINT (upstream's sign-in family: handleSignInFull
     *  routers/web/auth/auth.go:427-430, handleUserCreated :713-717, account
     *  activation :905, OAuth oauth.go:409, the non-interactive middleware
     *  sign-ins services/auth/auth.go:52), never at per-request session verify
     *  (CheckAuthToken, services/auth/auth_token.go:33-69, is read-only on the
     *  user row). Rendered authed-gated by the API serializer
     *  (apiUserFromRow — convert/user.go:118: `result.LastLogin =
     *  user.LastLoginUnix.AsTime()` under `if authed`). NULL = never signed in
     *  (upstream's zero TimeStamp; AsTime() then renders Go zero time, the
     *  serializer's GO_ZERO_TIME). Upstream's INDEX exists for the admin
     *  user-list `LastLoginSince` filter (user.go:897) which has no landed
     *  surface — no index here. */
    lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
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
  (t) => [
    uniqueIndex("issues_repo_index_uq").on(t.repoId, t.index),
    // Index audit P0: the issue/PR list page. The shared WHERE builder binds
    // `repo_id = ?` (or an IN-list), `is_closed = ?` and `is_pull = ?`, then
    // orders `created_unix DESC, id DESC` (api/services/issues.ts
    // issueFilterConditions:632-637 + the page ORDER BY:693/714; pulls twin
    // api/services/pulls.ts:235). Upstream keeps these as scalar INDEXes
    // (`RepoID xorm:"INDEX UNIQUE(repo_index)"`, `IsClosed xorm:"INDEX"`,
    // `IsPull xorm:"INDEX"`, `CreatedUnix xorm:"INDEX created"`,
    // models/issues/issue.go) — the composite collapses them into the exact
    // filter+order shape, so the page reads an ordered index range instead of
    // a repo scan + filesort. Plain ASC columns: SQLite scans an index
    // backwards for DESC (the releases_repo_created_idx precedent).
    index("issues_repo_pull_closed_created_idx").on(t.repoId, t.isPull, t.isClosed, t.createdAt),
    // Index audit P1: the poster's own issues — the activity heatmap scan
    // (`poster_id = ? AND created_unix > cutoff`, api/routes/user-read-t2.ts:
    // 150-160) and the `?posted_by=` list filter (api/services/issues.ts:661,
    // pulls.ts:235). Upstream's scalar pair (`PosterID xorm:"INDEX"`,
    // `CreatedUnix xorm:"INDEX created"`) composed into the two-column shape
    // both call sites use.
    index("issues_poster_created_idx").on(t.posterId, t.createdAt),
    // Index audit P2: upstream's scalar `MilestoneID int64 xorm:"INDEX"`
    // (models/issues/issue.go:69). The milestone-filtered list pages bind
    // repo_id first (the 0036 composite serves them), but the milestone
    // delete's unassign arm — `UPDATE issues SET milestone_id = NULL WHERE
    // milestone_id = ?` (src/issues/service.ts deleteMilestone, behind DELETE
    // /repos/{owner}/{repo}/milestones/{id}) — filters on milestone_id alone
    // and full-scanned the instance's largest table per delete.
    index("issues_milestone_idx").on(t.milestoneId),
  ],
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
    // Index audit P2: the PR-side identity + the PR list page. Every
    // pull_requests read leads with base_repo_id — findPullRequestByIndex's
    // `WHERE base_repo_id = ? AND index = ?` (api/services/pulls.ts:96, the
    // GET /repos/{owner}/{repo}/pulls/{index} path), the list page's first
    // condition (pulls.ts:215), the compare and create-time duplicate lookups
    // (pulls.ts:116/:141), the mergeability fan (services/branch-protection.ts
    // :773), the close-via-commit probe (api/routes/commits.ts:335) and the
    // delete-cascade base arm (repos/service.ts) — and the table had no
    // base-side index, so each walk was a full scan. Upstream indexes the
    // scalar BaseRepoID (`xorm:"INDEX"`, models/issues/pull.go:139; Index
    // carries no tag — upstream filters it in-code), so the composite extends
    // the upstream shape with the per-repo number: the by-index lookup reads
    // one index entry. Uniqueness stays the issues (repo_id, index) uq's job
    // (base_repo_id mirrors the joined issue's repo_id) — documented
    // divergence: a plain index, not upstream's UNIQUE(s) composite.
    index("pull_requests_base_index_idx").on(t.baseRepoId, t.index),
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
    // Index audit P2: the scalar issue_id twin above is deliberately KEPT
    // beside the covering index — `issue_id = ?` is queried directly (15 call
    // sites) and SQLite's cost model can prefer the narrower scalar for the
    // bare scan, so dropping it is not plan-dead (the witness battery
    // surfaced exactly this plan switch).
    // Covering index for the per-issue comment aggregates the derived-thread
    // notifications page probes (last foreign-authored activity +
    // comment-participant existence, 7 correlated evaluations per candidate
    // row across the page+count pair): issue_id equality + the poster filter
    // + the timestamp payload, so each probe reads index-only entries.
    index("comments_issue_covering_idx").on(t.issueId, t.posterId, t.updatedAt, t.createdAt),
    index("comments_ref_issue_idx").on(t.refIssueId),
    // Index audit P2 drop (carried by migration 0037): comments_ref_repo_idx
    // (upstream `RefRepoID xorm:"index"`, comment.go:350) — ZERO query
    // references: the xref surface resolves by ref_issue_id only
    // (api/services/issues.ts:1195); ref_repo_id is written (the §2.2
    // cross-reference emitters) and never filtered.
    // Index audit P1: the poster's own comments — the activity heatmap's
    // comment half (`poster_id = ? AND created_unix > cutoff`,
    // api/routes/user-read-t2.ts:163-171). Upstream's scalar
    // `PosterID int64 xorm:"INDEX"` (models/issues/comment.go) composed with
    // the created order both heatmap arms filter on.
    index("comments_poster_created_idx").on(t.posterId, t.createdAt),
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
  }, (t) => [
    // Index audit P0: the two upstream scalar indexes (models/issues/label.go:
    // 83-84 — `RepoID int64 xorm:"INDEX"`, `OrgID int64 xorm:"INDEX"`). The
    // table had NO index: every repo/org label list, the create-time
    // name-exists precheck and the issue-attach resolution were full scans.
    // Repo side: api/services/labels.ts:101 (list), :135 (name precheck),
    // api/services/issues.ts:545 + pulls.ts:646 (attach resolution),
    // projects.ts:1053. Org side: api/services/labels-t2.ts:69/90/103,
    // api/services/issues.ts:560, projects.ts:1055-1058.
    index("labels_repo_id_idx").on(t.repoId),
    index("labels_org_id_idx").on(t.orgId),
  ],
);

/** Issue↔label attachment (SPEC-0005 §3.2). */
export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: integer("issue_id").notNull(),
    labelId: integer("label_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    // Index audit P2: the label-filtered list pages embed `issue_id IN
    // (SELECT issue_id FROM issue_labels WHERE label_id IN (…))` (the shared
    // WHERE builders, api/services/issues.ts:671 + pulls.ts:227) and the
    // label delete cascade detaches edges by label_id (api/services/labels.ts
    // :234) — the PK leads with issue_id, so neither could seek. Deliberate
    // divergence from upstream (models/issues/issue_label.go:19-23: the
    // UNIQUE(s) composite leads with issue_id; upstream scans the label side
    // too) — the follows/star reverse-index precedent for the read-heavy
    // direction.
    index("issue_labels_label_idx").on(t.labelId),
  ],
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
  }, (t) => [
    // Index audit P0: the milestone list/get gate. Upstream's scalar
    // `RepoID int64 xorm:"INDEX"` (models/issues/milestone.go). The table had
    // NO index, so every `WHERE repo_id = ?` scan (api/services/milestones.ts:
    // 133 list, :176/:189 get-or-404; src/issues/service.ts:300;
    // api/services/issues.ts:597/608 milestone-entry resolution) walked the
    // whole table.
    index("milestones_repo_id_idx").on(t.repoId),
  ],
);

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
    // Index audit P0: the reaction page/delete target scan — `WHERE issue_id
    // = ? AND comment_id = ? AND release_id = 0` (api/services/issue-extras.
    // ts:59-62 page render, :118-126 delete-by-target). `reactions_target_uq`
    // leads with user_id, so neither call site could use it. Upstream indexes
    // (issue_id, comment_id) as the named `issue_comment` composite and
    // release_id standalone (models/issues/reaction.go — `IssueID …
    // INDEX(issue_comment)`, `CommentID … INDEX(issue_comment) INDEX`,
    // `ReleaseID … INDEX`); our one composite carries the release arm as the
    // trailing column because both call sites bind `release_id = 0` in the
    // same predicate (documented divergence: a future release-reactions path
    // querying by release_id alone would need its own index).
    index("reactions_issue_comment_release_idx").on(t.issueId, t.commentId, t.releaseId),
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
    // Index audit P2: the §4.13 repo purge — the delete cascade detaches
    // every asset of the repo with `WHERE repo_id = ?` (repos/service.ts),
    // which full-scanned the table. Upstream-matched: `RepoID int64
    // xorm:"INDEX"` (models/repo/attachment.go:29).
    index("release_assets_repo_idx").on(t.repoId),
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
  (t) => [
    uniqueIndex("issue_subscriptions_user_issue_uq").on(t.userId, t.issueId),
    // Index audit P1: the issue-side probes. The unique arbiter leads with
    // user_id, so the subscriber listing (`issue_id = ? AND is_watching`,
    // api/services/issue-extras.ts:175) and the notifications joins
    // (api/routes/notifications.ts:480/506/798) scanned. Upstream has no
    // issue-side index (UNIQUE(watch) on (user_id, issue_id) only,
    // models/issues/issue_watch.go:18-20 — upstream scans too); ours is the
    // follows/star reverse-index precedent for the read-heavy direction.
    index("issue_subscriptions_issue_idx").on(t.issueId),
  ],
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
export const issuePins = sqliteTable(
  "issue_pins",
  {
    issueId: integer("issue_id").primaryKey(),
    repoId: text("repo_id"),
    pinOrder: integer("pin_order").notNull(),
  },
  (t) => [
    // Index audit P2: the pinned-issues strips. The pin list per repo joins
    // `WHERE issue_pins.repo_id = ? AND issues.is_pull = ? ORDER BY
    // issue_pins.pin_order` (api/services/issue-extras.ts:218-221 on the
    // issues/PRs list pages, api/routes/issue-write-t2.ts:460 and the
    // reorder-shift UPDATEs :541-545, issue-tables-t2.ts:1777) and the repo
    // delete cascade detaches by repo_id (repos/service.ts) — the table's
    // only index was the issue_id PK, so every walk scanned. Upstream's
    // IssuePin carries UNIQUE(s)(repo_id, issue_id) (models/issues/
    // issue_pin.go:19-23), whose repo_id lead already indexes these scans;
    // ours extends the lead with pin_order so the ordered strip reads the
    // index in order and the reorder shift gets a range seek (documented
    // divergence: (repo_id, pin_order), no uniqueness — the PK is the
    // arbiter).
    index("issue_pins_repo_order_idx").on(t.repoId, t.pinOrder),
  ],
);

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
    // Index audit P2: the §4.13 repo purge. `repo_id` exists solely as the
    // denormalized purge key (see the table comment) and the delete cascade
    // detaches every delivery with `WHERE repo_id = ?` (repos/service.ts) —
    // unindexed, that scanned the instance's largest table per repo delete.
    // Deliberate divergence: upstream's HookTask has no repo_id at all
    // (models/webhook/hooktask.go:59-66 — the purge joins through hook_id
    // there); ours carries the denormalized column, so it carries the index.
    index("webhook_deliveries_repo_idx").on(t.repoId),
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
// SPEC-0006 §2.7 — git-lfs file locking (lfs_locks).
// ---------------------------------------------------------------------------

/**
 * One git-lfs file lock (`git lfs lock`) — the `LFSLock` model
 * (upstream models/git/lfs_lock.go:21-28): numeric autoincrement id (the wire
 * `id` is its decimal string), repo scope, owning user, normalized path,
 * creation time (unix seconds, `mode: "timestamp"` — upstream renders
 * `locked_at` second-rounded RFC3339 via `convert.ToLFSLock`).
 *
 * `lower_path` is our one added column: upstream enforces the per-repo
 * path-uniqueness of `CreateLFSLock` with a case-insensitive SELECT
 * (`lower(path) = ?`, lfs_lock.go:94) inside the insert transaction; D1 has
 * no such transactional check-then-insert, so the folded copy carries a
 * UNIQUE index (`uq_lfs_locks_repo_lower_path`) — the duplicate race answers
 * 409 with the existing lock instead of double-inserting. Wire-invisible.
 * `repo_id` is the numeric repo key the LFS router derives (same bridge as
 * `lfs_objects`; same TODO to move to `repositories.id`).
 */
export const lfsLocks = sqliteTable(
  "lfs_locks",
  {
    /** Wire lock id (decimal string on the LFS locks API). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Numeric repo key derived by the LFS router (not `repositories.id`). */
    repoId: integer("repo_id").notNull(),
    /** Owning user id (`users.id`; orgs included — orgs are user rows). */
    ownerId: integer("owner_id").notNull(),
    /** Locked file path, `util.PathJoinRel`-normalized, original case. */
    path: text("path").notNull(),
    /** `path.toLowerCase()` — the case-insensitive uniqueness/lookup key. */
    lowerPath: text("lower_path").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("uq_lfs_locks_repo_lower_path").on(t.repoId, t.lowerPath)],
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
 * Repo-level watch edges (upstream `watch` table, models/repo/watch.go:38-50
 * — the xorm model is named `Watch`, the historical D1 table kept Gitea's
 * pre-rename `repo_watcher` name; deliberately NOT `issue_watch`, which is
 * `issue_subscriptions` here). `(repo_id, user_id)` PK; `ON CONFLICT DO
 * NOTHING` keeps the FIRST `created_at` on repeat watches.
 *
 * The watch MODES (watch.go:17-27) ride the four mode columns, all mirroring
 * upstream's xorm tags verbatim:
 *   - `mode`: `WatchMode` — None=0 ("watch nothing unless mentioned"),
 *     Normal=1 (proactively watching), Dont=2 (ignore the repo), Auto=3
 *     (from AutoWatchOnChanges), Custom=4 (the picked events only). Column
 *     default 1 = upstream's `SMALLINT NOT NULL DEFAULT 1`; mode None is
 *     NEVER persisted (watchRepoByMode deletes the row on the None
 *     transition, watch.go:149-151) — an absent row IS None via the
 *     GetWatch dummy (watch.go:62-67).
 *   - the three include flags (`include_pull_requests`/`include_issues`/
 *     `include_releases`, all `NOT NULL DEFAULT true`): the custom watch's
 *     per-event picks (watch.go:47-49). Starting to watch resets them to
 *     true so a custom selection survives plain watch/unwatch cycles
 *     (watch.go:136-138); the mail resolution gates per event type on them
 *     (getRepoWatchersIDs, watch.go:266-292).
 * `ignored` on the API render is upstream-hardcoded false (routers/api/v1/
 * user/watch.go IsWatching/Watch) and has no column; upstream's
 * `updated` timestamp (watch.go:45) is unread by every surface we carry and
 * has no column either.
 */
export const repoWatchers = sqliteTable(
  "repo_watchers",
  {
    repoId: text("repo_id").notNull(),
    userId: integer("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
    mode: integer("mode").notNull().default(1).$type<0 | 1 | 2 | 3 | 4>(),
    includePullRequests: integer("include_pull_requests", { mode: "boolean" }).notNull().default(true),
    includeIssues: integer("include_issues", { mode: "boolean" }).notNull().default(true),
    includeReleases: integer("include_releases", { mode: "boolean" }).notNull().default(true),
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
  // The user settings NOTIFICATIONS tab's two preference columns
  // (specs/user-notification-settings.md — upstream split across the
  // `users.email_notifications_preference` column, user.go:103, and the
  // `user_setting` KV `email_notification.gitea_actions`,
  // setting_options.go:21-24; both halves collapsed into this side store,
  // the theme/language precedent). Defaults are upstream's creation
  // values (DEFAULT_EMAIL_NOTIFICATIONS 'enabled', admin.go:32; the
  // actions KV default 'failure-only', setting_options.go:23). Enum sets
  // are upstream's exact Go constants — the POST arms validate against
  // these same catalogs (services/user-notification-prefs.ts). Written
  // ONLY by that service's targeted upserts: loadUserSettings/
  // saveUserSettings map explicit columns, so neither side's write can
  // clobber the other's.
  emailNotificationsPreference: text("email_notifications_preference", {
    enum: ["enabled", "andyourown", "onmention", "disabled"],
  })
    .notNull()
    .default("enabled"),
  actionsEmailNotificationsPreference: text("actions_email_notifications_preference", {
    enum: ["all", "failure-only", "disabled"],
  })
    .notNull()
    .default("failure-only"),
});

// ---------------------------------------------------------------------------
// The generic user-settings KV store (upstream `user_setting`,
// models/user/setting.go:22-29) — ONE table, MANY keys. The typed
// `user_settings` above is this deployment's COLLAPSE of upstream's
// user-preference KV keys (theme/language + the two email-notification
// preferences — each its own column there); upstream itself keeps every one
// of those keys on the SAME generic KV, and the keys with no typed home —
// `SettingsKeyActionsConfig` = "actions.config" (setting_options.go:26,
// models/actions/config.go:38-47's Get/SetOwnerActionsConfig) first — land
// here, so the store's semantics are upstream's: absent row = the caller's
// default (setting.go:210-232's GetUserSettingJSON), the row is a
// (user_id, key) → text upsert (setting.go:186-208's
// upsertUserSettingValue). Column-for-column with upstream: the composite
// UNIQUE over (user_id, setting_key) IS upstream's `key_userid` constraint
// (both columns carry xorm's `unique(key_userid)` tag, :24-26 — its
// user_id prefix serves the load-all-of-a-user's-settings scan, :100-110,
// so there is no separate user_id index upstream either), setting_value is
// upstream's TEXT. Owner scope note: upstream's OwnerActionsConfig rows are
// written with the ORG's id as readily as a user's (getRunnersCtx's
// OwnerID, runners.go:82-91) because upstream orgs are users-table rows —
// the `users.type` collapse here matches, so one FK covers both scopes.
// The constant lives in services/actions/owner-actions-config.ts (the
// schema carries tables; the SYSTEM_NOTICE_* precedents are page-render
// enums). Written ONLY through that service (the user_settings typed
// store's saveUserSettings maps explicit columns and never touches this
// table — the two stores' writes cannot clobber each other).
// ---------------------------------------------------------------------------

export const userSettingsKv = sqliteTable(
  "user_settings_kv",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Upstream `UserID` — the owner row (a user OR an org; see the
     *  section comment's scope note). */
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Upstream `SettingKey varchar(255)` — lowercase always (upstream's
     *  validateUserSettingKey refuses mixed case, setting.go:116-124). */
    settingKey: text("setting_key").notNull(),
    /** Upstream `SettingValue text` — opaque string bytes; the JSON keys
     *  store their Go-marshal serialization (models/user/setting.go:227-232's
     *  SetUserSettingJSON). */
    settingValue: text("setting_value").notNull(),
  },
  (t) => [
    // Upstream's composite UNIQUE `key_userid` (setting.go:24-26) — the
    // upsert's arbitration point and the per-user scan key in one.
    uniqueIndex("user_settings_kv_user_key_uq").on(t.userId, t.settingKey),
  ],
);

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
  (t) => [
    // Upstream-matched pair for the audit P2: the cron producer's due scan —
    // `WHERE next_sync_at <= now AND next_sync_at != 0 AND sync_state = 'idle'`
    // (services/mirror/sync.ts:861) — ran per cron tick with no usable index.
    // `NextUpdateUnix int64 xorm:"INDEX"` (models/repo/mirror.go:31) is the
    // upstream scalar; ours carries the same column (the sync_state equality
    // and the `!= 0` sentinel filter the ordered range, the push_mirrors
    // sibling's next_sync precedent).
    index("repo_mirrors_next_sync_idx").on(t.nextSyncAt),
    check("repo_mirrors_sync_state_check", sql`${t.syncState} IN ('idle', 'queued', 'syncing')`),
  ],
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
    // Index audit P2: the scalar user twin is deliberately KEPT (bare
    // `user_id = ?` scans have no route today, but SQLite's cost model can
    // prefer the narrower scalar if one lands, so its removal is not
    // plan-dead); the issue-side index below is the P2 add.
    index("notification_states_user_idx").on(t.userId),
    // Index audit P2 add: the issue-delete cascade arm — `WHERE issue_id = ?`
    // (api/services/issues.ts deleteIssueCascade) full-scanned the table: the
    // uq leads with user_id, so notification_states was the one issue-scoped
    // family with no issue-side index (every sibling — comments, reactions,
    // subscriptions, attachments, tracked times, stopwatches, history — has
    // one). Deliberate divergence: upstream's notification table carries no
    // IssueID index (models/activities/notification.go:54-60 — both columns
    // are bare NOT NULLs; upstream scans the cascade too).
    index("notification_states_issue_idx").on(t.issueId),
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
    /** The login's `remember` decision (§2.3): rotation re-sets the cookie
     *  with this persistence — `Max-Age=2678400` vs session-scope — so a
     *  remembered login never degrades at its first 24 h rotation
     *  (upstream re-sets the remember cookie on rotation,
     *  routers/web/auth/auth.go:127). DEFAULT false: pre-0035 rows were
     *  minted session-scope. */
    remember: integer("remember", { mode: "boolean" }).notNull().default(false),
    /** OAuth2 authorize-dance state (SPEC-0010 §3 extension, the OAuth2
     *  SPEC §2.2): JSON {client_id, redirect_uri, state, scope, nonce,
     *  code_challenge, code_challenge_method} stashed between
     *  GET /login/oauth/authorize and POST /login/oauth/grant; read-and-
     *  cleared by /grant; NULL otherwise. Upstream stashes the same state in
     *  its server-side session (oauth2_provider.go:271-295, 378-395) and
     *  re-checks it at POST /grant (:411-415) — binding consent to the live
     *  session is the security property (a captured consent page is useless
     *  after logout/session rotation). */
    oauthState: text("oauth_state"),
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

// ---------------------------------------------------------------------------
// SPEC-0007 §3.5 — org teams (the deferred core landed): `teams`,
// `team_members`, `team_repo_access` over migration 0015. Ports of upstream
// `team` (gitea/models/organization/team.go:76–96), `team_user`
// (team_user.go:16–21) and `team_repo` (team_repo.go:17–22). Ownership stays
// with `org_members.role` (the tier-1 Owners-team bridge, §3.3): NO owners
// team row is created — a team named `owners` cannot exist (the create path
// answers the bridge's duplicate) and org owners keep their grants without
// team rows. `team_unit` (team_unit.go:15–21) is NOT modeled — per-unit
// overrides collapse onto the team row (see `teams.unitsMap`).
// ---------------------------------------------------------------------------

/** Effective access mode of a team (upstream `perm.AccessMode`,
 *  gitea/models/perm/access_mode.go:17–22, + the unit-mode union the team
 *  carries). TEXT enum per the schema convention (`org_members.role`,
 *  `repo_collaborators.mode`) — recorded deviation from upstream's INTEGER
 *  `authorize` column, same class as the `users.visibility` deviation. */
export type TeamAccessMode = "none" | "read" | "write" | "admin" | "owner";

/**
 * Org team (upstream `Team`, gitea/models/organization/team.go:76–96).
 * `UNIQUE(org_id, lower_name)` is the race arbiter for the existence check
 * `NewTeam` performs in-tx (services/org/team.go:60–70) — a real constraint
 * where upstream relies on the check (deviation: constraint-first, the
 * `org_members_org_user_uq` pattern). No `created` column: upstream's `Team`
 * struct carries none and the API model never renders one. `num_repos` /
 * `num_members` are maintained counters (upstream `NumRepos`/`NumMembers`,
 * read by the members listing total header, routers/api/v1/org/team.go:392).
 */
export const teams = sqliteTable(
  "teams",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Case-folded team key — UNIQUE per org with `org_id`. */
    lowerName: text("lower_name").notNull(),
    /** Display case (upstream `Name`). */
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Upstream `authorize` (AccessMode). 'owner' is unreachable from the API
     *  (ParseAccessMode never parses owner from input, access_mode.go:46–62)
     *  — only the value space stays closed. */
    authorize: text("authorize", { enum: ["none", "read", "write", "admin", "owner"] })
      .notNull()
      .default("none"),
    includesAllRepositories: integer("includes_all_repositories", { mode: "boolean" })
      .notNull()
      .default(false),
    canCreateOrgRepo: integer("can_create_org_repo", { mode: "boolean" }).notNull().default(false),
    /** Maintained count of team-scoped repositories (upstream `NumRepos`). */
    numRepos: integer("num_repos").notNull().default(0),
    /** Maintained member count (upstream `NumMembers`; the last-owner guard
     *  and the members total header read it). */
    numMembers: integer("num_members").notNull().default(0),
    /** Team visibility within the org (upstream `Visibility`, DEFAULT 2 =
     *  private, team.go:96). */
    visibility: text("visibility", { enum: ["public", "limited", "private"] })
      .notNull()
      .default("private"),
    /**
     * DEVIATION (documented): upstream stores per-unit overrides in the
     * `team_unit` table (team_unit.go:15–21) and drops `authorize` to none
     * when units are set (services/org/team.go:156–186). cf-gitea has no unit
     * ACL to enforce, so the overrides collapse onto this JSON column —
     * `{"repo.code":"read",...}` — written exactly when the request supplied
     * `units`/`units_map` (with `authorize` stored as 'none', upstream's
     * observable state). Null = no unit overrides (plain-permission team).
     */
    unitsMap: text("units_map"),
  },
  (t) => [
    // Index audit P2: teams_org_idx (upstream `OrgID xorm:"INDEX"`,
    // models/organization/team.go) is deliberately KEPT beside the uq — bare
    // `org_id = ?` scans are real (the org team listings) and SQLite's cost
    // model can prefer the narrower scalar over the uq's org_id lead, so
    // dropping it is not plan-dead (the witness battery surfaced this).
    index("teams_org_idx").on(t.orgId),
    uniqueIndex("teams_org_lower_uq").on(t.orgId, t.lowerName),
  ],
);

/**
 * Team membership (upstream `TeamUser`, team_user.go:16–21 — upstream table
 * `team_user`; renamed per the SPEC-0007 §3.4 sketch's `team_members`). The
 * UNIQUE (team_id, user_id) pair is `IsTeamMember`'s lookup (team_user.go:26–33)
 * and the add-path race arbiter. The (org_id, user_id) index covers
 * `removeInvalidOrgUser`'s count-remaining-teams scan
 * (services/org/team.go:366–382) — deviation from upstream's plain `org_id`
 * index, covering the same scan without a filter.
 */
export const teamMembers = sqliteTable(
  "team_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("team_members_team_user_uq").on(t.teamId, t.userId),
    index("team_members_org_user_idx").on(t.orgId, t.userId),
    index("team_members_user_idx").on(t.userId),
  ],
);

/**
 * Team↔repository grants (upstream `TeamRepo`, team_repo.go:17–22 — upstream
 * table `team_repo`; renamed `team_repo_access` per the wave brief).
 * `repo_id` keys the landed TEXT `repositories.id` and declares NO FK, per
 * the repo-scoped-table convention (`repo_topics`, `stars`,
 * `repo_collaborators`): rows die with the deleteRepository cascade.
 * Upstream materializes one row per covered repo — including the
 * `includes_all_repositories` fan-out at create/edit
 * (services/repository/repo_team.go:72–100) — so the read path is a plain
 * join; the cf-gitea write path materializes on team create/edit/repo-add and
 * the teams route module's reads additionally union the includes-all coverage
 * (repos created after the last fan-out are not materialized until then).
 */
export const teamRepoAccess = sqliteTable(
  "team_repo_access",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orgId: integer("org_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
  },
  (t) => [
    uniqueIndex("team_repo_access_team_repo_uq").on(t.teamId, t.repoId),
    index("team_repo_access_repo_idx").on(t.repoId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0002 account families — user emails, SSH public keys, GPG keys
// (migration 0016; the API write/read half lives in routes/misc-t3.ts).
// Column-faithful ports of upstream `email_address`
// (gitea/models/user/email_address.go:76-83), `public_key`
// (gitea/models/asymkey/ssh_key.go:39-54) and `gpg_key`
// (gitea/models/asymkey/gpg_key.go:23-39). Upstream's `gpg_key_import`
// (gpg_key_import.go:14-19 — the raw armor kept for commit-signature
// verification) is NOT modeled: cf-gitea verifies no commits yet; the
// omission is documented in the route module header. Upstream checks
// key/email uniqueness in code (no UNIQUE constraints on fingerprint/key_id);
// the indexes below are plain mirrors of upstream's, same arbitration split.
// ---------------------------------------------------------------------------

/**
 * A user email address (upstream `EmailAddress`,
 * models/user/email_address.go:76-83: `UID INDEX NOT NULL`, `Email UNIQUE
 * NOT NULL`, `LowerEmail UNIQUE NOT NULL`, `IsActivated`, `IsPrimary DEFAULT
 * false NOT NULL` — no timestamp columns upstream). Upstream materializes
 * the signup address as the is_primary row at user creation; cf-gitea keeps
 * the primary on `users.email` (SPEC-0002 §3) and only secondary addresses
 * get rows — the read side unions the primary back (the "synthesized
 * primary" in routes/misc-t3.ts), so no write path here ever sets
 * `is_primary` today.
 */
export const emailAddresses = sqliteTable(
  "email_addresses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Display-case address; globally UNIQUE (upstream `Email UNIQUE`). */
    email: text("email").notNull(),
    /** Case-folded lookup key; globally UNIQUE (upstream `LowerEmail UNIQUE`,
     *  filled by the BeforeInsert hook, email_address.go:91-94). */
    lowerEmail: text("lower_email").notNull(),
    /** Upstream `IsActivated`; API-added addresses activate immediately
     *  (upstream `!setting.Service.RegisterEmailConfirm`, default false). */
    isActivated: integer("is_activated", { mode: "boolean" }).notNull().default(false),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("email_addresses_email_uq").on(t.email),
    uniqueIndex("email_addresses_lower_email_uq").on(t.lowerEmail),
    index("email_addresses_user_idx").on(t.userId),
  ],
);

/**
 * SSH public keys (upstream `PublicKey`, models/asymkey/ssh_key.go:39-54).
 * `mode` is upstream's raw `perm.AccessMode` integer (NOT NULL DEFAULT 2 =
 * write; the API create path always writes 2, key.go AddPublicKey:151),
 * `type` the raw `KeyType` (NOT NULL DEFAULT 1 = user; deploy keys live in a
 * later family). `fingerprint` is `SHA256:<base64-nopad>` over the key blob
 * (upstream `ssh.FingerprintSHA256`, ssh_key_fingerprint.go:42-48) — indexed,
 * not UNIQUE: the global reuse check is the code path
 * (checkKeyFingerprint, ssh_key_fingerprint.go:16-25). `created`/`updated`
 * are upstream's xorm `created`/`updated` auto-columns (the latter doubles as
 * last-used once usage tracking lands; AfterLoad, ssh_key.go:61-64).
 */
export const publicKeys = sqliteTable(
  "public_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Caller-chosen title; duplicate-per-owner rejected in code
     *  (AddPublicKey:137-144), not by constraint — upstream form. */
    name: text("name").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** The authorized_keys-form key line ("type base64 comment"). */
    content: text("content").notNull(),
    /** Raw perm.AccessMode integer; 2 = write (upstream DEFAULT 2). */
    mode: integer("mode").notNull().default(2),
    /** Raw KeyType integer; 1 = user, 2 = deploy, 3 = principal. */
    type: integer("type").notNull().default(1),
    /** Upstream `LoginSourceID NOT NULL DEFAULT 0` — external auth source;
     *  always 0 until an LDAP/OAuth2 SPEC lands. */
    loginSourceId: integer("login_source_id").notNull().default(0),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    /** Row creation (upstream `CreatedUnix xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"updated"` — last key use once usage
     *  tracking lands; equals createdAt at insert (AfterLoad's HasUsed gate). */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("public_keys_owner_idx").on(t.ownerId),
    index("public_keys_fingerprint_idx").on(t.fingerprint),
  ],
);

/**
 * GPG keys (upstream `GPGKey`, models/asymkey/gpg_key.go:23-39). Subkeys are
 * rows in the SAME table with `primary_key_id` set to the parent's `key_id`
 * (addGPGSubKey, gpg_key_add.go:47-55); top-level keys store ''. `content`
 * is base64 of the serialized public-key packet (upstream
 * `Base64EncPubKey` → `packet.Serialize`, gpg_key_common.go:52-58) — NOT the
 * armored input (the armor goes to the unmodeled `gpg_key_import` upstream).
 * `key_id` is the 16-hex-uppercase short id (low 64 bits of the v4
 * fingerprint); the parser writes v4 keys only (route module header for the
 * v5/v6 omission). `verified` exists upstream but is unreachable in
 * cf-gitea: OpenPGP signature verification (the only true-setter) is not
 * implemented.
 */
export const gpgKeys = sqliteTable(
  "gpg_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 16 uppercase hex chars (upstream `KeyID INDEX CHAR(16) NOT NULL`). */
    keyId: text("key_id", { length: 16 }).notNull(),
    /** Parent's key_id for subkeys; '' for primaries (upstream
     *  `PrimaryKeyID CHAR(16)` — FindGPGKeyOptions filters `= ''`). */
    primaryKeyId: text("primary_key_id", { length: 16 }).notNull().default(""),
    /** base64 of the public-key packet (see above). */
    content: text("content").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    canSign: integer("can_sign", { mode: "boolean" }).notNull().default(false),
    canEncryptComms: integer("can_encrypt_comms", { mode: "boolean" }).notNull().default(false),
    canEncryptStorage: integer("can_encrypt_storage", { mode: "boolean" }).notNull().default(false),
    canCertify: integer("can_certify", { mode: "boolean" }).notNull().default(false),
    /** Key-packet creation time (upstream `CreatedUnix = pubkey.CreationTime`,
     *  gpg_key.go:197) — NOT the row time. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Key expiry; null = never (upstream zero TimeStamp renders
     *  0001-01-01T00:00:00Z through the API). */
    expiresAt: integer("expired_unix", { mode: "timestamp" }),
    /** Row insertion time (upstream `AddedUnix`, BeforeInsert
     *  gpg_key.go:46-48). */
    addedAt: integer("added_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("gpg_keys_owner_idx").on(t.ownerId),
    index("gpg_keys_key_id_idx").on(t.keyId),
    index("gpg_keys_primary_key_id_idx").on(t.primaryKeyId),
  ],
);

// ---------------------------------------------------------------------------
// PR review family (SPEC-0005 §3.2 tail — the `review` table port). One table
// carries BOTH the submitted/pending reviews AND the reviewer requests:
// upstream stores a request as a `review` row of `ReviewTypeRequest`
// (gitea/models/issues/review.go:697–770 AddReviewRequest — there is no
// separate review_request table), so cf-gitea mirrors that exactly.
// ---------------------------------------------------------------------------

/** `pull_reviews.type` — upstream `ReviewType`
 *  (gitea/models/issues/review.go:96–103). */
export const ReviewType = {
  /** Not published yet (the draft a SubmitPullReview converts). */
  Pending: 0,
  Approve: 1,
  Comment: 2,
  /** REQUEST_CHANGES on the wire (upstream name: Reject). */
  Reject: 3,
  /** A reviewer REQUEST row, not feedback (ReviewTypeRequest). */
  Request: 4,
} as const;

/**
 * PR reviews + reviewer requests (mirrors `Review`,
 * gitea/models/issues/review.go:107–141). Rows hang off the joined issue
 * (`issue_id` — the PR's issue row, like every issue-family table); request
 * rows are `type=4` with `reviewer_id>0` (user) or `reviewer_team_id>0`
 * (team). Original-author importer columns (upstream OriginalAuthor*) are
 * omitted: no cf-gitea migration surface writes reviews.
 */
export const pullReviews = sqliteTable(
  "pull_reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** `ReviewType` 0–4. */
    type: integer("type").notNull(),
    /** Reviewer user id; 0 on team-request rows (upstream NOT NULL DEFAULT 0). */
    reviewerId: integer("reviewer_id").notNull().default(0),
    /** Requesting team id (org teams); 0 on user rows. */
    reviewerTeamId: integer("reviewer_team_id").notNull().default(0),
    issueId: integer("issue_id").notNull(),
    /** Review body (empty for request rows — upstream leaves it ''). */
    content: text("content"),
    /** Review by someone whose approval counts. Since SPEC-0013 M1 the
     *  protected-branch whitelist arm EXISTS (services/branch-protection.ts
     *  isOfficialReviewer: no rule/no whitelist → write access; whitelist →
     *  listed users/teams only; an admin off the whitelist is NOT official). */
    official: integer("official", { mode: "boolean" }).notNull().default(false),
    /** Head commit the review was made against (VARCHAR(64) upstream). */
    commitId: text("commit_id"),
    /** Invalidated by a head-branch push (MarkReviewsAsStale). */
    stale: integer("stale", { mode: "boolean" }).notNull().default(false),
    /** Dismissal state (DismissReview, models/issues/review.go:638–652). */
    dismissed: integer("dismissed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_unix", { mode: "timestamp" }),
    updatedAt: integer("updated_unix", { mode: "timestamp" }),
  },
  (t) => [
    // Index audit P2: pull_reviews_issue_idx (upstream `IssueID int64
    // xorm:"index"`, models/issues/review.go:133) is deliberately KEPT beside
    // the reviewer composite — `issue_id = ?` scans are real (FindReviews,
    // 23 call sites) and SQLite's cost model can prefer the narrower scalar,
    // so dropping it is not plan-dead (the witness battery surfaced this).
    index("pull_reviews_issue_idx").on(t.issueId),
    // The latest-review-per-reviewer lookups (GetReviewByIssueIDAndUserID,
    // review.go:586–593) and the official-flag clears key on the reviewer.
    index("pull_reviews_reviewer_idx").on(t.issueId, t.reviewerId, t.type),
  ],
);

// ---------------------------------------------------------------------------
// Protected branches (SPEC-0013 §3.1 — the `protected_branch` table port,
// gitea/models/git/protected_branch.go:30–42, minus ORM plumbing). One row
// per rule; the six user/team allowlists stay inside the single `rules` JSON
// blob exactly like upstream's one `config` column.
// ---------------------------------------------------------------------------

export const protectedBranches = sqliteTable(
  "protected_branches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Keys the landed TEXT repositories.id — the repo-scoped-table
     *  convention (no FK; rows die with the deleteRepository cascade). */
    repoId: text("repo_id").notNull(),
    /** Upstream column `branch_name` (RuleName, protected_branch.go:34 — "a
     *  branch name or a glob match to branch name"); we keep the semantic
     *  name and the API carries `rule_name`. */
    ruleName: text("rule_name").notNull(),
    /** First-match ordering input (protected_branch.go:35, NOT NULL DEFAULT 0). */
    priority: integer("priority").notNull().default(0),
    /** The `ProtectedBranchConfig` JSON verbatim under upstream's exact
     *  snake_case json keys (protected_branch.go:45–80) so contract
     *  rendering is a read-and-echo (SPEC-0013 §3.1). */
    rules: text("rules").notNull(),
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(s) pair (RepoID, RuleName) — protected_branch.go:32,34.
    // Index audit P2: protected_branches_repo_idx (not upstream — the pair's
    // repo_id lead covers the scans upstream) is deliberately KEPT: bare
    // `repo_id = ?` scans are real (the per-push rule loads) and SQLite's
    // cost model can prefer the narrower scalar, so dropping it is not
    // plan-dead (the witness battery surfaced this).
    uniqueIndex("protected_branches_repo_rule_uq").on(t.repoId, t.ruleName),
    index("protected_branches_repo_idx").on(t.repoId),
  ],
);

/**
 * Repository deploy keys and deploy tokens (upstream `DeployKey`,
 * models/deploykey/deploykey.go:25-46). ONE table carries BOTH principals:
 * `key_type` 1 = an SSH deploy key (a `public_keys` row of `type=2` shared by
 * every repo that adds the same content — FindOrAddDeployPublicKey,
 * asymkey/ssh_key.go:93-120) and 2 = an HTTPS deploy token (`gdt_…` secret;
 * the plaintext is returned exactly once at create, only `token_hash`
 * sha256 persists — deploykey_token.go:12-44).
 *
 * `key_id` mirrors upstream's raw `KeyID INDEX` — a plain column, NO FK
 * constraint: token rows carry Go's zero key_id 0 (GetDeployKeyByRepoPublicKey
 * filters `key_type = 1` precisely because "every token row carries key id
 * 0", deploykey_ssh.go:60), and upstream's xorm tag is INDEX only. The
 * referenced `public_keys` row is itself FK-less on our side of the design:
 * upstream materializes deploy public-key rows with `owner_id = 0` (no owner
 * — invisible to every /user/keys owner filter), which our landed
 * `public_keys.owner_id → users.id` FK cannot store; the service layer points
 * them at the upstream system principal `gitea:deploy-key` (user_system.go:76,
 * DeployKeyUserID = -3) seeded by migration 0020 and re-asserted on demand —
 * same shape as the migration-0003 'assets' reservation row (prohibited
 * status, un-takeable at the DB level, never a token holder).
 *
 * `repo_id` keys the landed TEXT repositories.id — the repo-scoped-table
 * convention (plain column, no FK; rows die with the deleteRepository
 * cascade arm — upstream's DeleteBeans census carries the DeployKey bean,
 * services/repository/delete.go). `fingerprint` copies the public key's
 * SHA-256 fingerprint onto the deploy row for upstream's by-fingerprint list
 * filter; token rows store the masked scan-bait rendering instead
 * (generateToken, deploykey_token.go:22-26). Name uniqueness per repo is a
 * CODE check, not a constraint (checkDeployKeyName, deploykey.go:55-69).
 * `created`/`updated` are upstream's xorm auto-columns (the latter doubles as
 * last-used once the git-HTTP arm lands; AfterLoad's HasUsed gate,
 * deploykey.go:49-52).
 */
export const deployKeys = sqliteTable(
  "deploy_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The shared `public_keys.id` for ssh rows; 0 for token rows (upstream
     *  `KeyID INDEX` — no FK; see above). */
    keyId: integer("key_id").notNull().default(0),
    /** Keys the landed TEXT repositories.id — the repo-scoped convention. */
    repoId: text("repo_id").notNull(),
    /** Caller-chosen title; duplicate-per-repo rejected in code
     *  (checkDeployKeyName), not by constraint — upstream form. */
    name: text("name").notNull(),
    /** Raw KeyType integer; 1 = ssh, 2 = token (upstream NOT NULL DEFAULT 1). */
    keyType: integer("key_type").notNull().default(1),
    /** ssh rows: the public key's "SHA256:…" fingerprint; token rows: the
     *  masked "gdt_xx********yy" rendering (generateToken). */
    fingerprint: text("fingerprint").notNull(),
    /** sha256 hex of the plaintext token; '' for ssh rows (upstream
     *  `TokenHash INDEX` — "sha256 … need[s] no salt", deploykey.go:38). */
    tokenHash: text("token_hash").notNull().default(""),
    /** Raw perm.AccessMode integer; 1 = read, 2 = write (upstream
     *  `NOT NULL DEFAULT 1`). */
    mode: integer("mode").notNull().default(1),
    /** Row creation (upstream `CreatedUnix xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"updated"` — last token/key use once the
     *  git-HTTP arm lands; equals createdAt at insert (HasUsed gate). */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's xorm INDEX trio (deploykey.go:27,28,38).
    index("deploy_keys_key_id_idx").on(t.keyId),
    index("deploy_keys_repo_id_idx").on(t.repoId),
    // Index audit P2 drop: deploy_keys_token_hash_idx (upstream `TokenHash
    // string xorm:"INDEX"`, deploykey.go:36) — ZERO query references: the
    // deploy-token half exists as rows, but no route resolves a token by
    // hash yet (the git-HTTP deploy-token auth arm is unlanded; the API
    // family addresses rows by id/repo). Re-add with that arm.
  ],
);

// ---------------------------------------------------------------------------
// Actions secrets + variables (the inventory batch `wave-api-secrets-variables`
// — upstream `Secret`, gitea/models/secret/secret.go:35-44, and
// `ActionVariable`, gitea/models/actions/variable.go:27-37). Owner-scoped KV
// stores for the CI surface; NO runner required — this is the only
// actions-family surface that works without the actions runtime (SPEC-0012).
// ---------------------------------------------------------------------------

/**
 * Actions secrets (mirrors `Secret`, gitea/models/secret/secret.go:35-44).
 * Scope encoding is upstream's exact rule (the model's own doc comment): a
 * repo-level row carries `owner_id = 0` and `repo_id` set; an org/user-level
 * row carries `owner_id` set and `repo_id` empty; both set, or both empty
 * (global secrets) are unsupported upstream and unrepresentable here.
 *
 * `owner_id`/`repo_id` are PLAIN columns — no FK — exactly like upstream's
 * xorm INDEX tags: the `owner_id = 0` repo-scope sentinel cannot reference
 * users (the FK form is reserved for owner-always-real tables like
 * public_keys/gpg_keys), and `repo_id` keys the landed TEXT repositories.id
 * with the empty string as upstream's 0 sentinel (the webhooks NULL-adaptation
 * is unusable here because NULLs are DISTINCT in SQLite unique indexes — a
 * nullable repo_id would not enforce per-owner name uniqueness). The
 * UNIQUE(owner_repo_name) triple carries the scope + name; `name` is stored
 * UPPERCASE-normalized (InsertEncryptedSecret / InsertVariable).
 *
 * `data` is upstream's LONGTEXT encrypted-data column (SecretDataMaxLength
 * 65536); cf-gitea stores plaintext with the divergence documented in
 * services/secrets-variables.ts — upstream encrypts with the instance
 * SecretKey (EncryptSecret), an instance key model does not exist yet (same
 * seam as webhooks.header_authorization_encrypted, services/hooks.ts:488-491).
 * `description` truncates at 4096 runes (SecretDescriptionMaxLength).
 */
export const secrets = sqliteTable(
  "secrets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** users.id for org/user-scope rows; the 0 sentinel on repo rows
     *  (upstream `OwnerID UNIQUE(owner_repo_name) NOT NULL`). */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id on repo rows; '' (upstream's 0 sentinel) on
     *  org/user rows (upstream `RepoID … NOT NULL DEFAULT 0`). */
    repoId: text("repo_id").notNull().default(""),
    /** Uppercase-normalized at insert and lookup (strings.ToUpper). */
    name: text("name").notNull(),
    /** Secret value; plaintext in cf-gitea (see the table comment). */
    data: text("data").notNull(),
    description: text("description").notNull().default(""),
    /** Row creation (upstream `CreatedUnix xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(owner_repo_name) (secret.go:38,39,40).
    uniqueIndex("secrets_owner_repo_name_uq").on(t.ownerId, t.repoId, t.name),
    // Index audit P2: secrets_owner_idx (upstream's scalar OwnerID INDEX,
    // secret.go:38) is deliberately KEPT beside the uq — the owner-scoped
    // reads bind repo_id alongside owner_id (the uq serves those), but
    // SQLite's cost model can prefer the narrower scalar should a bare
    // owner scan land, so its removal is not plan-dead.
    index("secrets_owner_idx").on(t.ownerId),
    // Upstream's xorm INDEX on RepoID (secret.go:39) — the repo-scope list.
    index("secrets_repo_id_idx").on(t.repoId),
  ],
);

/**
 * Actions variables (mirrors `ActionVariable`,
 * gitea/models/actions/variable.go:27-37) — the plaintext counterpart of the
 * secrets table with the identical scope encoding, name normalization, and
 * sentinel adaptation (see the secrets table comment). `data` is
 * VariableDataMaxLength 65536 RUNES upstream (the insert/update gate counts
 * runes, unlike secrets' bytes); `description` truncates at 4096 runes;
 * values are EOL-normalized to "\n" (NormalizeStringEOL) and `updated_unix`
 * tracks the last PUT.
 */
export const actionVariables = sqliteTable(
  "action_variables",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** users.id for org/user-scope rows; the 0 sentinel on repo rows. */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id on repo rows; '' (upstream's 0 sentinel) on
     *  org/user rows. */
    repoId: text("repo_id").notNull().default(""),
    /** Uppercase-normalized at insert, lookup, and rename. */
    name: text("name").notNull(),
    /** Variable value, EOL-normalized ("\r\n" → "\n"). */
    data: text("data").notNull(),
    description: text("description").notNull().default(""),
    /** Row creation (upstream `CreatedUnix xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Last PUT (upstream `UpdatedUnix xorm:"updated"`); equals createdAt at
     *  insert (the deploy_keys convention). */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(owner_repo_name) (variable.go:30,31,32).
    uniqueIndex("action_variables_owner_repo_name_uq").on(t.ownerId, t.repoId, t.name),
    // Index audit P2: action_variables_owner_idx is deliberately KEPT (not
    // upstream as a scalar — upstream puts the INDEX tag on RepoID,
    // variable.go:31 — and the owner-scoped reads bind repo_id alongside,
    // but the same narrow-scalar cost argument as secrets_owner_idx holds).
    index("action_variables_owner_idx").on(t.ownerId),
    // Upstream's xorm INDEX on RepoID — the repo-scope list.
    index("action_variables_repo_id_idx").on(t.repoId),
  ],
);

/**
 * Scoped-workflow SOURCE registrations (mirrors `ActionScopedWorkflowSource`,
 * gitea/models/actions/scoped_workflow.go:19-32): one row per registered
 * source repository, either under an owner (user/org — `owner_id` carries the
 * users.id; orgs are user rows, SPEC-0007 §3.2) or at the INSTANCE level
 * (`owner_id` 0 — upstream's same sentinel, scoped_workflow.go:22-23). A
 * source's workflow files under the scoped workflow directories of its
 * default branch run on every repository the scope covers (the settings
 * pages over this table: routers/web/shared/actions/scoped_workflows.go,
 * mounted web.go:517-523 at the user/org/admin scopes).
 *
 * The per-workflow merge-gate configs ride `workflow_configs` as the JSON of
 * upstream's `map[string]*ScopedWorkflowConfig` (scoped_workflow.go:28, the
 * `JSON TEXT` column; the value shape is scoped_workflow.go:34-38's
 * `{required, patterns[]}`, keyed by the workflow ENTRY NAME). cf-gitea's
 * writers always store at least `{}` — upstream's nil-map insert (xorm JSON
 * nil → SQL NULL) collapses to the same empty read (`{}` on decode), and a
 * null config VALUE (upstream `*ScopedWorkflowConfig == nil`) round-trips
 * verbatim — the settings merge's documented skip arm.
 *
 * ID-SPACE NOTE (the one adaptation, the owner-actions-config store's
 * id-space twin): upstream `SourceRepoID` is int64; this deployment's
 * repositories.id is TEXT (the SPEC-0003 uuid convention), so the column is
 * TEXT and the handlers' `repo_id` form fields parse as strings (a junk id
 * never matches a row — the FormInt64 junk-to-0 miss twin). The xorm INDEX
 * on SourceRepoID (scoped_workflow.go:25) lands as the scalar repo index;
 * the UNIQUE(owner_repo) pair (scoped_workflow.go:23-25) lands as the
 * composite unique that also arbitrates the duplicate-add race (the
 * AddScopedWorkflowSource re-check arm, scoped_workflow.go:162-167).
 */
export const actionScopedWorkflowSources = sqliteTable(
  "action_scoped_workflow_source",
  {
    /** Row id (upstream `ID int64 xorm:"pk autoincr"`). */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** users.id for org/user-scope rows; the 0 sentinel = instance-level
     *  (upstream `OwnerID … NOT NULL DEFAULT 0`, scoped_workflow.go:23). */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id — the source repository providing the workflow
     *  files (upstream `SourceRepoID int64 INDEX UNIQUE(owner_repo) NOT NULL
     *  DEFAULT 0`, scoped_workflow.go:25 — the TEXT id space is the house
     *  adaptation; the DEFAULT 0 sentinel has no TEXT twin and the writers
     *  always provide the id). */
    sourceRepoId: text("source_repo_id").notNull(),
    /** JSON `Record<string, {required, patterns[]} | null>` keyed by the
     *  workflow entry name (upstream `WorkflowConfigs map[string]*
     *  ScopedWorkflowConfig xorm:"JSON TEXT 'workflow_configs'"`,
     *  scoped_workflow.go:28). */
    workflowConfigs: text("workflow_configs").notNull().default("{}"),
    /** Row creation (upstream `CreatedUnix timeutil.TimeStamp xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Last configs replace (upstream `UpdatedUnix timeutil.TimeStamp
     *  xorm:"updated"`); equals createdAt at insert (the deploy_keys
     *  convention). */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(owner_repo) (scoped_workflow.go:23-25) — the
    // (owner, source) pair is the row's identity and the add-race
    // arbitration point.
    uniqueIndex("action_scoped_workflow_owner_repo_uq").on(t.ownerId, t.sourceRepoId),
    // Upstream's xorm INDEX on SourceRepoID (scoped_workflow.go:25) — the
    // consumer-side probes (GetEffectiveScopedWorkflowSources' SourceRepoID
    // condition, scoped_workflow.go:66).
    index("action_scoped_workflow_source_repo_idx").on(t.sourceRepoId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0004 appendix A — user blocks (inventory batch 9, wave-api-blocks).
// ---------------------------------------------------------------------------

/**
 * User blocks (port of upstream `Blocking`, gitea/models/user/block.go:24-36,
 * table `user_blocking`): `blocker_id` blocks `blockee_id`, the pair is
 * UNIQUE (upstream `UNIQUE(block)`), and the blocker may be an organization
 * (orgs ARE user rows, SPEC-0007 §3.2). Both edges cascade on the user row
 * like the rest of the users-adjacent tables. `note` is the optional block
 * note (upstream `Note string`; the API's `?note=` query param,
 * routers/api/v1/user/block.go:62-65). `created_at` is unix seconds (repo
 * convention) mirroring `CreatedUnix timeutil.TimeStamp xorm:"INDEX created"`;
 * the extra blockee-side index serves `HasBlocking`'s
 * `blockee_id = ? AND blocker_id IN (…)` probes (block.go:56-66) — upstream
 * scans, we index (the follows reverse-index precedent).
 */
export const userBlocking = sqliteTable(
  "user_blocking",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The blocking side — a user OR an organization id (block.go:24-31). */
    blockerId: integer("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The blocked side — always an individual (blocking an org is a 400,
     *  services/user/block.go:97-99). */
    blockeeId: integer("blockee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(block) (block.go:26,28).
    uniqueIndex("user_blocking_block_uq").on(t.blockerId, t.blockeeId),
    index("user_blocking_blockee_idx").on(t.blockeeId),
    // Index audit P2 drop: user_blocking_created_idx (upstream `CreatedUnix
    // timeutil.TimeStamp xorm:"INDEX created"`, block.go:31) — ZERO query
    // references: no route lists blocks by creation time. Re-add with a
    // sorted block-list surface.
  ],
);

// ---------------------------------------------------------------------------
// Repo push mirrors (inventory batch 7, wave-api-push-mirrors — upstream
// `PushMirror`, gitea/models/repo/pushmirror.go:17-28).
// ---------------------------------------------------------------------------

/**
 * Push mirrors (port of upstream `PushMirror`, gitea/models/repo/
 * pushmirror.go:17-28): N rows per repository — each row is one remote the
 * repo pushes itself OUT to, the write-side twin of the 1:1 `repo_mirrors`
 * (pull) table. Upstream's xorm table is `push_mirror` (PushMirrorsIterate's
 * `Table("push_mirror")`); the plural name follows the `repo_mirrors`
 * adaptation.
 *
 * `remote_name` is SERVER-GENERATED at insert ("remote_mirror_" + 10 crypto
 * alphanumerics, routers/api/v1/repo/mirror.go CreatePushMirror — the client
 * never names a push mirror; the {name} path param is an exact-match lookup
 * against stored values), so no UNIQUE(repo_id, remote_name): upstream
 * enforces none and the generated names collide with negligible probability.
 * `remote_address` stores the SANITIZED target URL (userinfo stripped,
 * util.SanitizeURL parity — the credential half lives in
 * `credentials_ciphertext`, the same §4.2 AES-GCM envelope as the pull table,
 * AAD-bound to `(row.id, repo_id)`); it is never echoed anywhere.
 * `interval_seconds` 0 = push only on commit (upstream `Interval
 * time.Duration` zero); `sync_on_commit` defaults true (upstream
 * `xorm:"NOT NULL DEFAULT true"`). `last_update_unix`/`last_error` are the
 * consumer's sync-status pair (UpdatePushMirrorSyncStatus). Upstream keeps
 * the git remote in the repo's config (AddPushMirrorRemote) — cf-gitea has
 * no git-config layer, so this row IS the record and the delete cascade to
 * the stored credentials is simply the row delete (upstream
 * RemovePushMirrorRemote parity).
 */
export const pushMirrors = sqliteTable(
  "push_mirrors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The mirroring repository's `repositories.id` (TEXT adaptation; MANY
     *  rows per repo, upstream `RepoID int64 xorm:"INDEX"`). AAD half of the
     *  credential envelope. */
    repoId: text("repo_id").notNull(),
    /** Server-generated "remote_mirror_<10 alphanumerics>" (upstream
     *  `RemoteName`). */
    remoteName: text("remote_name").notNull(),
    /** Sanitized target URL — userinfo stripped (upstream stores
     *  `util.SanitizeURL(option.RemoteAddress)` in `RemoteAddress
     *  VARCHAR(2048)`). */
    remoteAddress: text("remote_address").notNull(),
    /** Also push on every commit (upstream `SyncOnCommit bool
     *  xorm:"NOT NULL DEFAULT true"`). */
    syncOnCommit: integer("sync_on_commit", { mode: "boolean" }).notNull().default(true),
    /** Push cadence seconds; `0` = commit-triggered only (upstream
     *  `Interval time.Duration`; validated ≥ 10 min unless 0). */
    intervalSeconds: integer("interval_seconds").notNull().default(0),
    /** Row creation (upstream `CreatedUnix timeutil.TimeStamp
     *  xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Last push attempt, success or failure (upstream `LastUpdateUnix
     *  timeutil.TimeStamp xorm:"INDEX last_update"`); null until the first
     *  sync (AsTimePtr → null last_update on the wire). */
    lastUpdateUnix: integer("last_update_unix", { mode: "timestamp" }),
    /** Last failure text, "" when clean (upstream `LastError string
     *  xorm:"text"`). */
    lastError: text("last_error").notNull().default(""),
    /** Not secret; kept for the §3.1 parity with `repo_mirrors` (upstream
     *  embeds it in the remote URL — we never do). */
    credentialsUsername: text("credentials_username"),
    /** AES-256-GCM over the full Authorization header value (§4.2), keyed by
     *  the MIRROR_CREDENTIAL_KEY KEK, AAD-bound to `(row.id, repo_id)`. */
    credentialsCiphertext: text("credentials_ciphertext"),
    /** The enqueue/serialization guard (push-mirror-outbound SPEC §3.2/§4.1):
     *  `idle → queued` (the cron producer), `queued|idle → syncing` (the
     *  consumer claim), back to `idle` on settle — the landed, queue-
     *  redelivery-proven pull pattern (repo_mirrors.sync_state). CHECK'd in
     *  DDL exactly like the pull table's constraint. */
    syncState: text("sync_state", { enum: ["idle", "queued", "syncing"] })
      .notNull()
      .default("idle"),
    /** Next scheduled sync (unix seconds; push-mirror-outbound SPEC §3.2).
     *  `0` = due-now-for-never-synced rows and the only state of
     *  commit-triggered-only mirrors — the cron sweep's
     *  `interval_seconds != 0` filter is the scheduler's on/off switch
     *  (upstream PushMirrorsIterate's `interval != 0`), so a 0 here is due
     *  arithmetic (`0 <= now`) for interval-carrying rows and inert for
     *  interval-0 rows. */
    nextSyncAt: integer("next_sync_at").notNull().default(0),
  },
  (t) => [
    // Upstream's xorm INDEX tags (pushmirror.go:20,27).
    index("push_mirrors_repo_id_idx").on(t.repoId),
    index("push_mirrors_last_update_idx").on(t.lastUpdateUnix),
    // The cron producer's due scan (push-mirror-outbound SPEC §3.2/§4.1).
    index("push_mirrors_next_sync_idx").on(t.nextSyncAt),
    check("push_mirrors_sync_state_check", sql`${t.syncState} IN ('idle', 'queued', 'syncing')`),
  ],
);

// ---------------------------------------------------------------------------
// Project boards (the inventory batch `wave-api-projects-repo` — upstream
// `Project`, gitea/models/project/project.go:85-107, `Column` (physical table
// `project_board`), gitea/models/project/column.go:49-63, `ProjectIssue`,
// gitea/models/project/issue.go:15-25, and `Workflow` (physical table
// `project_workflow`), gitea/models/project/workflows.go:160-169). ONE shared
// store serves all three scopes — repo / org / user: this wave mounts the
// repo scope (`/repos/{owner}/{repo}/projects…`); the org/user stages reuse
// the same tables with different gates. `repo_id` follows the
// secrets-table sentinel convention: TEXT repositories.id on repo rows, ''
// (upstream's 0) on owner-level rows; `owner_id` is upstream's exact inverse
// (0 on repository projects, the users.id on org/user rows).
// ---------------------------------------------------------------------------

/**
 * Projects (mirrors `Project`, project.go:85-107). Enum ints are upstream's
 * raw uint8 columns: `board_type` TemplateType (0 none / 1 basic_kanban /
 * 2 bug_triage, template.go:19-26), `card_type` CardType (0 text_only /
 * 1 images_and_text, column.go:31-36), `type` Type (1 individual /
 * 2 repository / 3 organization, project.go:35-43). Titles truncate to 255
 * display-width chars at write time (NewProject/UpdateProject,
 * `util.EllipsisDisplayString`). No UNIQUE constraint upstream — the
 * (repo_id, type, is_closed) list reads ride the repo_id/owner_id indexes.
 *
 * DEVIATION (this wave): upstream maintains `repository.num_projects` /
 * `num_closed_projects` counters (project.go:282,359-379); the landed
 * repositories table carries no such columns and this batch cannot ALTER it,
 * so the counters are not maintained (nothing in the contract renders them —
 * the repository model has no project count field).
 */
export const projects = sqliteTable(
  "projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Display title, EllipsisDisplayString(255) at write time. */
    title: text("title").notNull(),
    /** Upstream `Description xorm:"TEXT"`, Go zero "" (never NULL). */
    description: text("description").notNull().default(""),
    /** users.id of the owner on org/user projects; 0 on repository projects
     *  (upstream `OwnerID xorm:"INDEX"`). */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id on repo rows; '' (upstream's 0) on owner-level
     *  rows (upstream `RepoID xorm:"INDEX"`). */
    repoId: text("repo_id").notNull().default(""),
    /** users.id of the creator (upstream `CreatorID NOT NULL`). */
    creatorId: integer("creator_id").notNull(),
    isClosed: integer("is_closed", { mode: "boolean" }).notNull().default(false),
    /** Upstream physical column `board_type` (TemplateType). */
    boardType: integer("board_type").notNull().default(0),
    /** CardType. */
    cardType: integer("card_type").notNull().default(0),
    /** Project.Type 1/2/3. */
    type: integer("type").notNull(),
    /** Upstream `ClosedDateUnix` — stamped on EVERY open<->close transition,
     *  including reopen (changeProjectStatus, project.go:404-416), so it only
     *  reads as meaningful while is_closed. */
    closedAtUnix: integer("closed_date_unix", { mode: "timestamp" }),
    /** Upstream `CreatedUnix xorm:"INDEX created"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"INDEX updated"`. */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's xorm INDEX quartet (project.go:87,89,91,94), reduced by the
    // index audit P2 by one:
    // - projects_title_idx (upstream Title INDEX) — dropped (migration 0037):
    //   ZERO query references (titles are rendered, never filtered).
    // - projects_is_closed_idx (upstream IsClosed INDEX) is deliberately
    //   KEPT: the is_closed list predicate rides repo/owner-scoped
    //   conditions (api/services/projects.ts:218), but SQLite's planner can
    //   still pick the scalar for `WHERE repo_id = ? AND is_closed = ?`
    //   (the witness battery observed exactly that plan), so its removal is
    //   not plan-dead.
    index("projects_owner_id_idx").on(t.ownerId),
    index("projects_repo_id_idx").on(t.repoId),
    index("projects_is_closed_idx").on(t.isClosed),
  ],
);

/**
 * Project columns (mirrors `Column`, column.go:49-63; upstream's physical
 * table name is the legacy `project_board` — renamed here to the post-TODO
 * intent, column.go:66-68). `sorting` is upstream's int8 domain (-128..127);
 * appends compute `min(max(sorting)+1, 127)` (NewColumn, column.go:162).
 * The default flag marks the column new issues land in — exactly one per
 * project is enforced procedurally (SetDefaultColumn), not by index; the
 * physical column name is `is_default` because `default` is an SQL keyword
 * (upstream's own xorm column is `` `default` ``).
 */
export const projectColumns = sqliteTable(
  "project_columns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** EllipsisDisplayString(255) at write time. */
    title: text("title").notNull(),
    /** Upstream `Default bool xorm:"NOT NULL DEFAULT false"` — issues not
     *  assigned to a specific column land here (legacy project_issues rows
     *  with column 0 read as this column, issue.go:36-44). */
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    /** int8 domain (-128..127); EditProjectColumnOption rejects outside it. */
    sorting: integer("sorting").notNull().default(0),
    /** `#rrggbb` or "" (upstream `VARCHAR(7)`, ColumnColorPattern
     *  `^#[0-9a-fA-F]{6}$`). */
    color: text("color").notNull().default(""),
    projectId: integer("project_id").notNull(),
    creatorId: integer("creator_id").notNull(),
    /** Upstream `CreatedUnix xorm:"INDEX created"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"INDEX updated"`. */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's `ProjectID xorm:"INDEX NOT NULL"` (column.go:56) plus the
    // created/updated INDEX tags (column.go:61,62). Index audit P2 drops:
    // project_columns_created_idx / project_columns_updated_idx (the upstream
    // timestamp tags) — ZERO query references (columns are listed by project,
    // served by the project_id index; the timestamps are rendered, never
    // filtered or ordered alone).
    index("project_columns_project_id_idx").on(t.projectId),
  ],
);

/**
 * Issue <-> project membership (mirrors `ProjectIssue`,
 * gitea/models/project/issue.go:15-25). Upstream's physical column
 * `project_board_id` carries the post-1.22 column id; rows predating columns
 * store 0 and read as the project's default column (issue.go:36-44) — the
 * default column's membership read therefore claims BOTH its own id and 0
 * (columnIssueIDs). No UNIQUE(project_id, issue_id) upstream — membership is
 * diff-computed in IssueAssignOrRemoveProject, so the pair indexes stay
 * non-unique to mirror it.
 */
export const projectIssues = sqliteTable(
  "project_issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Global issues.id (not the repo-local index). */
    issueId: integer("issue_id").notNull(),
    projectId: integer("project_id").notNull(),
    /** Upstream physical column `project_board_id` (`project_column_id` is
     *  the upstream TODO rename, issue.go:20); 0 = legacy default-column
     *  encoding. NOT NULL DEFAULT 0 upstream. */
    projectColumnId: integer("project_column_id").notNull().default(0),
    /** Position within the column, ascending (int64 upstream). */
    sorting: integer("sorting").notNull().default(0),
  },
  (t) => [
    // Upstream's xorm INDEX trio (issue.go:17,18,21).
    index("project_issues_issue_id_idx").on(t.issueId),
    index("project_issues_project_id_idx").on(t.projectId),
    index("project_issues_column_id_idx").on(t.projectColumnId),
  ],
);

/**
 * Project workflows (mirrors `Workflow`,
 * gitea/models/project/workflows.go:160-169; upstream's physical table
 * `project_workflow`). Automated reactions to project events: `filters` /
 * `actions` are the JSON-serialized WorkflowFilters / WorkflowActions
 * structs (upstream `xorm:"TEXT JSON"`), `event` one of the eight
 * WorkflowEvent string values. Execution (the notifier reacting to item
 * events) is NOT part of this batch — only the CRUD surface is (the 5
 * workflow ops upstream shares across scopes).
 */
export const projectWorkflows = sqliteTable(
  "project_workflows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").notNull(),
    /** WorkflowEvent string (`item_added_to_project`, `pull_request_merged`,
     *  …) — validity is checked at create/update time against the eight
     *  known values. */
    event: text("event").notNull().default(""),
    /** JSON WorkflowFilters ({issue_type, source_column_id,
     *  target_column_id, label_ids}, omitempty upstream). */
    filters: text("filters").notNull().default("{}"),
    /** JSON WorkflowActions ({column_id, add_label_ids, remove_label_ids,
     *  issue_state}, omitempty upstream). */
    actions: text("actions").notNull().default("{}"),
    /** Upstream `Enabled bool xorm:"DEFAULT true NOT NULL"`. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Upstream `CreatedUnix xorm:"created"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"updated"`. */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's `ProjectID xorm:"INDEX"` (workflows.go:162).
    index("project_workflows_project_id_idx").on(t.projectId),
  ],
);

// ---------------------------------------------------------------------------
// Protected tags (inventory batch 8, wave-api-tag-protections — upstream
// `ProtectedTag`, gitea/models/git/protected_tag.go:21-32).
// ---------------------------------------------------------------------------

/**
 * Protected tags (upstream `ProtectedTag`, models/git/protected_tag.go:21-32)
 * — a repo-scoped name pattern plus a control allowlist. The API family is
 * /repos/{owner}/{repo}/tag_protections (api/routes/tag-protections.ts); the
 * enforcement arms are the pre-receive tag walk (routers/private/
 * hook_pre_receive.go preReceiveTag:308-339) and the API tag create/delete
 * path (services/release/release.go:87-102/:376-390).
 *
 * The two allowlists carry upstream's `xorm:"JSON TEXT"` encoding — JSON
 * arrays in TEXT columns. NO UNIQUE(repo_id, name_pattern): upstream declares
 * none on ProtectedTag (unlike ProtectedBranch), so the create collision is
 * the pre-check 403 "Tag protection already exist"
 * (routers/api/v1/repo/tag.go:423-428), not a constraint. The plain repo_id
 * index is the protected_branches precedent, not an upstream port: every read
 * (GetProtectedTags :117-121, the per-push enforcement load) filters by
 * repo_id.
 */
export const protectedTags = sqliteTable(
  "protected_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Keys the landed TEXT repositories.id — the repo-scoped-table
     *  convention (no FK; rows die with the deleteRepository cascade). */
    repoId: text("repo_id").notNull(),
    /** Upstream column `name_pattern` — a glob, or a REGEX when wrapped in
     *  literal slashes (EnsureCompiledPattern, protected_tag.go:36-45). */
    namePattern: text("name_pattern").notNull(),
    /** `AllowlistUserIDs []int64 xorm:"JSON TEXT"` (protected_tag.go:27). */
    allowlistUserIds: text("allowlist_user_ids").notNull().default("[]"),
    /** `AllowlistTeamIDs []int64 xorm:"JSON TEXT"` (protected_tag.go:28). */
    allowlistTeamIds: text("allowlist_team_ids").notNull().default("[]"),
    /** Row creation (upstream `CreatedUnix xorm:"created"`). */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Last edit (upstream `UpdatedUnix xorm:"updated"`). */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Every read filters by repo_id (see the table comment).
    index("protected_tags_repo_idx").on(t.repoId),
  ],
);

// ---------------------------------------------------------------------------
// OAuth2 applications (long-tail batch, wave-api-oauth2-apps — upstream
// `OAuth2Application`, gitea/models/auth/oauth2.go:39-55).
// ---------------------------------------------------------------------------

/**
 * OAuth2 applications (upstream `OAuth2Application`,
 * models/auth/oauth2.go:39-55) — a user-owned OAuth2 client registration
 * (RFC 6749 §2). The API family is /user/applications/oauth2[/{id}]
 * (api/routes/oauth2-apps.ts); the authorize/token flow that CONSUMES these
 * registrations is web-UI territory and stays out of this batch (no
 * oauth2_grant / oauth2_authorization_code tables — oauth2.go:413+, :532+).
 *
 * - `client_id` is a UUID (crypto.randomUUID) for upstream's
 *   uuid.New().String() (oauth2.go:298); UNIQUE per upstream
 *   `xorm:"unique"` (oauth2.go:43).
 * - `client_secret` stores a HASH, never the plaintext (upstream bcrypt,
 *   oauth2.go:213-224; our PBKDF2-SHA256 encoding is documented in
 *   api/services/oauth2-apps.ts). Plaintext exists only inside the
 *   create/update response bodies — never on list/get.
 * - `redirect_uris` carries upstream's `xorm:"redirect_uris JSON TEXT"`
 *   encoding (oauth2.go:51) — a JSON array in a TEXT column.
 */
export const oauth2Applications = sqliteTable(
  "oauth2_application",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Owning user id (upstream `UID xorm:"INDEX"`, oauth2.go:40). */
    uid: integer("uid").notNull(),
    name: text("name").notNull(),
    /** Upstream `ClientID xorm:"unique"` (oauth2.go:43). */
    clientId: text("client_id").notNull().unique(),
    /** The HASH of the current secret — never the plaintext. */
    clientSecret: text("client_secret").notNull(),
    /** Upstream `NOT NULL DEFAULT TRUE` (oauth2.go:49). */
    confidentialClient: integer("confidential_client", { mode: "boolean" }).notNull().default(true),
    /** Upstream `NOT NULL DEFAULT FALSE` (oauth2.go:50). */
    skipSecondaryAuthorization: integer("skip_secondary_authorization", { mode: "boolean" }).notNull().default(false),
    /** JSON array of redirect URIs — upstream `redirect_uris JSON TEXT`. */
    redirectUris: text("redirect_uris").notNull().default("[]"),
    /** Upstream `CreatedUnix xorm:"INDEX created"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"INDEX updated"`. */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's `UID xorm:"INDEX"` — every list filters by uid
    // (models/auth/oauth2_list.go ToConds).
    index("oauth2_application_uid_idx").on(t.uid),
  ],
);

// ---------------------------------------------------------------------------
// The OAuth2 provider flow (SPEC specs/oauth2-provider.md §3 — W1 substrate):
// the two flow tables behind /login/oauth/authorize|access_token. Migration
// 0052 (the SPEC's own number — the tables are inert until the flow waves
// read them). The applications table above is the landed 0026 half.
// ---------------------------------------------------------------------------

/**
 * Upstream OAuth2Grant (gitea/models/auth/oauth2.go:504-514) — the
 * permission of one user for one application. UNIQUE(user, application):
 * one grant per pair, re-consent updates scope in place.
 *
 * Grant scope is DENORMALIZED STATE, the access token carries none of it
 * (SPEC §2.4/§3): the JWT is only a pointer ({gnt, tt, exp}), all authority
 * (user, scope, revocation) resolves from this row at request time — grant
 * deletion / scope UPDATE kills outstanding tokens on the next request
 * without touching any JWT.
 */
export const oauth2Grants = sqliteTable(
  "oauth2_grant",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => oauth2Applications.id, { onDelete: "cascade" }),
    /**
     * Refresh-rotation counter; NOT NULL DEFAULT 1 (oauth2.go:509). Only
     * moved under InvalidateRefreshTokens via the compare-and-increment
     * UPDATE (WHERE counter = old) — a zero-rows answer is the stale-token
     * signal (oauth2.go:545-559). Default OFF upstream: refresh tokens are
     * reusable until expiry and the counter rides inert.
     */
    counter: integer("counter").notNull().default(1),
    /** The mixed scope string (SPEC §2.5) — general + normalized access
     *  scopes, space-joined. Upstream `Scope xorm:"TEXT"` (oauth2.go:510). */
    scope: text("scope").notNull().default(""),
    /** OIDC nonce replayed into the id_token (oauth2.go:511). */
    nonce: text("nonce").notNull().default(""),
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // upstream xorm INDEX unique(user_application) (oauth2.go:506-508)
    uniqueIndex("oauth2_grant_user_application_uq").on(t.userId, t.applicationId),
  ],
);

/**
 * Upstream OAuth2AuthorizationCode (oauth2.go:403-412) — one-time,
 * 10-minute TTL (oauth2AuthorizationCodeValidity, oauth2.go:31, RFC 6749
 * §4.1.2). Consumption IS the DELETE: the row's rowcount is the replay
 * guard (Invalidate, oauth2.go:443-452 — zero affected rows ⇒ already
 * used), a single D1 statement satisfying the transactional-consumption
 * rule with no KV and no flag.
 */
export const oauth2AuthorizationCodes = sqliteTable(
  "oauth2_authorization_code",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    grantId: integer("grant_id")
      .notNull()
      .references(() => oauth2Grants.id, { onDelete: "cascade" }),
    /** `gta_` + 32 crypto-random bytes lowercased base32 unpadded
     *  (GenerateNewAuthorizationCode, oauth2.go:522-542); UNIQUE-indexed for
     *  the token endpoint's lookup (upstream `xorm:"INDEX unique"`). */
    code: text("code").notNull(),
    /** PKCE: "" = no PKCE on this code (oauth2.go:406-407; requiresCode-
     *  Verifier is "method != '' || challenge != ''"). */
    codeChallenge: text("code_challenge").notNull().default(""),
    codeChallengeMethod: text("code_challenge_method").notNull().default(""),
    redirectUri: text("redirect_uri").notNull().default(""),
    /** The 10-minute window boundary; expired is `valid_until <= now`
     *  (IsExpired, oauth2.go:415-419 — zero dies too, upstream defends). */
    validUntil: integer("valid_until", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("oauth2_authorization_code_code_uq").on(t.code),
    index("oauth2_authorization_code_valid_until_idx").on(t.validUntil),
  ],
);

// ---------------------------------------------------------------------------
// User badges (long-tail batch, wave-api-badges-licenses-template — upstream
// `Badge` + `UserBadge`, gitea/models/user/badge.go:16-25).
// ---------------------------------------------------------------------------

/**
 * Badge catalog (upstream `Badge`, models/user/badge.go:16-21) — a slugged
 * decoration an admin can pin on users. The API family is
 * /admin/users/{username}/badges (api/routes/admin-badges.ts); the catalog's
 * own CRUD is upstream WEB-UI territory (routers/web/admin/badges.go, no
 * /api/v1 surface — the frozen contract declares none either), so rows come
 * to exist out-of-band (seed/admin UI) and the API consumes existing slugs.
 *
 * - `slug` is UNIQUE per upstream `xorm:"UNIQUE"` (badge.go:18); it is the
 *   API-facing key (UserBadgeOption.badge_slugs).
 * - `description` / `image_url` are plain xorm strings — NULLable columns.
 */
export const badges = sqliteTable("badge", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  imageUrl: text("image_url"),
});

/**
 * The user <-> badge edge (upstream `UserBadge`, models/user/badge.go:23-25)
 * with upstream's compound `unique_user_badge` index (badge.go:28-33, the
 * v329 migration's dedup + resync) — a user holds a badge at most once. No
 * FK per the schema conventions; edges die with their owner rows.
 */
export const userBadges = sqliteTable(
  "user_badge",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    badgeId: integer("badge_id").notNull(),
    userId: integer("user_id").notNull(),
  },
  (t) => [
    // Upstream's TableIndices unique (badge.go:28-33).
    uniqueIndex("unique_user_badge").on(t.userId, t.badgeId),
  ],
);

// ---------------------------------------------------------------------------
// Repo licenses (long-tail batch, wave-api-badges-licenses-template —
// upstream `RepoLicense`, gitea/models/repo/license.go:15-24).
// ---------------------------------------------------------------------------

/**
 * Per-repo detected licenses (upstream `RepoLicense`,
 * models/repo/license.go:15-24) — the PUSH-time detection product
 * (services/repository/license.go resolveLicenses) that
 * `GET /repos/{owner}/{repo}/licenses` reads (api/routes/repo-licenses.ts).
 * The push pipeline populates it: the onPush settle leg (services/
 * webhooks-push.ts → services/repo-licenses.ts) walks the default-branch
 * tip on create/update and applies the corpus-detected diff.
 *
 * - UNIQUE(path) is the upstream 3-column unique over (repo_id, license,
 *   license_path) (license.go:19-21 + the v346 migration's re-created index;
 *   xorm's physical name there is UQE_repo_license_path).
 * - `commit_id` is the commit the detection ran at (license.go:18) — the
 *   UpdateRepoLicenses diff deletes rows whose commit_id fell behind.
 * - the created/updated unix pair carries upstream's `xorm:"INDEX CREATED"` /
 *   `xorm:"INDEX UPDATED"` (license.go:22-23).
 */
export const repoLicenses = sqliteTable(
  "repo_license",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Keys the landed TEXT repositories.id — the repo-scoped-table
     *  convention (no FK; rows die with the deleteRepository cascade). */
    repoId: text("repo_id").notNull(),
    commitId: text("commit_id"),
    /** SPDX ID the detector matched (upstream `License VARCHAR(255)`). */
    license: text("license").notNull(),
    /** Repo-relative path of the license file (upstream `license_path`
     *  VARCHAR(255) NOT NULL DEFAULT 'LICENSE'). */
    licensePath: text("license_path").notNull().default("LICENSE"),
    /** Upstream `CreatedUnix xorm:"INDEX CREATED"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix xorm:"INDEX UPDATED"`. */
    updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's UNIQUE(path) trio (see the table comment).
    uniqueIndex("repo_license_path_uq").on(t.repoId, t.license, t.licensePath),
    // Index audit P2 drops: repo_license_created_idx / repo_license_updated_idx
    // (upstream's timestamp INDEXes, license.go:22-23) — ZERO query
    // references (the licenses listing reads by repo through the uq's
    // repo_id lead; the timestamps are rendered, never filtered).
  ],
);

// ---------------------------------------------------------------------------
// Activity feeds (long-tail batch, wave-api-feeds — upstream `Action`,
// gitea/models/activities/action.go:135-151; specs/activity-feeds.md).
// ---------------------------------------------------------------------------

/**
 * The instance-wide activity log (upstream `Action`) — one row per RECEIVER
 * per action (the NotifyWatchers fan-out, services/feed/feed.go:32-100: the
 * original row `user_id = act_user_id`, an org row for org-owned repos, one
 * row per repo watcher). Written by the additive hooks inside the landed
 * event emitters (services/repo-events.ts + services/issue-events.ts); read
 * by the three /activities/feeds endpoints (api/routes/activity-feeds.ts).
 *
 * Deviations from upstream (specs/activity-feeds.md §3.1/§3.3):
 * - `repo_id` is the landed TEXT repositories.id (repo-scoped-table
 *   convention, the repo_license precedent; upstream int64). No FK.
 * - Only three of upstream's five composite indexes port (the ones the
 *   endpoints use); the dashboard/heatmap-shaped two land with consumers.
 * - `is_deleted` is schema-faithful and read-filtered, but nothing sets it
 *   true at this tier (upstream has no writer either outside migrations);
 *   repo deletion cascades rows away with the repo row.
 * Rows exist only for action types the landed emitters produce (the wired
 * matrix in the SPEC §3.3); the numeric op_type preserves upstream's
 * ActionType iota (action.go:23-56).
 */
export const actions = sqliteTable(
  "action",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Upstream `UserID xorm:"INDEX"` — the RECEIVER user id. */
    userId: integer("user_id").notNull(),
    /** Upstream `ActionType` int (1..27, action.go:23-56). */
    opType: integer("op_type").notNull(),
    /** Upstream `ActUserID` — the performer. */
    actUserId: integer("act_user_id").notNull(),
    /** TEXT repositories.id (the repo-scoped-table convention). */
    repoId: text("repo_id").notNull(),
    /** Upstream `CommentID xorm:"INDEX"` — 0 when the action has no comment. */
    commentId: integer("comment_id").notNull().default(0),
    /** Upstream `NOT NULL DEFAULT false`; never written true here (see above). */
    isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
    /** Upstream `RefName` — branch/tag of push/tag actions ('' so far). */
    refName: text("ref_name").notNull().default(""),
    /** Repo privacy at action time (upstream `IsPrivate NOT NULL DEFAULT false`). */
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    /** Upstream `Content TEXT` — "index|excerpt" / old repo name / ... */
    content: text("content").notNull().default(""),
    /** Upstream `CreatedUnix xorm:"created"`. */
    createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream's `r_u_d` composite (action.go:159-160).
    index("action_repo_user_deleted_idx").on(t.repoId, t.userId, t.isDeleted),
    // Upstream's `cuIndex` shape (action.go:168-169).
    index("action_user_deleted_created_idx").on(t.userId, t.isDeleted, t.createdAt),
    // Upstream's `au_c_u` composite (action.go:171-172).
    index("action_act_user_created_idx").on(t.actUserId, t.createdAt, t.userId),
    // Index audit P1: the repo-kind feed page — `repo_id = ? AND
    // is_deleted = 0` ordered `created_unix DESC` (api/services/
    // activity-feeds.ts feedCondition:350-356 + getFeedRows' ORDER BY:388).
    // Upstream's `r_u_d` (action.go:159-160, ported above with user_id in
    // slot 2) cannot serve this shape's is_deleted filter or the created
    // order; this composite is the audit's exact (repo_id, is_deleted,
    // created_unix) page shape (plain ASC — SQLite scans backwards).
    index("action_repo_deleted_created_idx").on(t.repoId, t.isDeleted, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Issue content history (specs/issue-content-history.md — upstream
// `ContentHistory`, gitea/models/issues/content_history.go:19-34).
// ---------------------------------------------------------------------------

/**
 * Per-revision snapshots of issue bodies and comment contents — one row per
 * stored revision, filled by the edit-path hooks (specs/issue-content-history.md
 * §3): the FIRST edit lazily back-fills the original content as
 * `is_first_created` (attributed to the row's poster at its creation
 * timestamp), every edit stores the new content, and the 20-revision
 * retention limiter hard-deletes middle rows. `comment_id = 0` is the issue
 * body's namespace (upstream's convention); a comment delete hard-deletes
 * its rows (upstream DeleteComment, comment.go:1215-1219).
 */
export const issueContentHistory = sqliteTable(
  "issue_content_history",
  {
    /** `HistoryID` on the content-history wire payloads. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Who the revision is attributed to (nullable like issues.poster_id —
     *  imported rows have no poster user). */
    posterId: integer("poster_id"),
    issueId: integer("issue_id").notNull(),
    /** 0 = the issue body; otherwise the owning comment's id. */
    commentId: integer("comment_id").notNull().default(0),
    /** `EditedUnix xorm:"INDEX"` — the revision's timestamp. */
    editedAt: integer("edited_unix", { mode: "timestamp" }).notNull(),
    /** The snapshot body; emptied (not nulled) by soft-delete. */
    contentText: text("content_text").notNull(),
    /** The lazily back-filled ORIGINAL revision (first-edit hook). */
    isFirstCreated: integer("is_first_created", { mode: "boolean" }).notNull().default(false),
    /** Soft-delete flag; nothing sets it true until the soft-delete arm lands. */
    isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    // Upstream's three scalar INDEXes (content_history.go:22-26), minus the
    // index audit P2 drop: issue_content_history_edited_idx (upstream
    // `EditedUnix xorm:"INDEX"`, content_history.go:25) — every edited_unix
    // reference orders WITHIN an issue/comment-scoped read (api/services/
    // issues.ts:865, ui/pages/issue-content-fragments.ts:588), served by the
    // issue/comment indexes plus a bounded sort; the scalar never drives a
    // plan.
    index("issue_content_history_issue_idx").on(t.issueId),
    index("issue_content_history_comment_idx").on(t.commentId),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0015 §4.1 — audit events (audit_event).
// ---------------------------------------------------------------------------

/**
 * One row per audit event — the column-for-column port of upstream `Event`
 * (gitea/models/audit/audit_event.go:22-38, table `audit_event`), served by
 * the repo/org settings audit tabs downstream (upstream web.go:1279 + the
 * org twin web.go:1063). The emit seam + action registry live in
 * services/audit.ts; slice-one instrumentation emits `repository:create`
 * (RepoService.create) and `organization:create` (OrgService.createOrg) from
 * inside their write batches, so an audit row commits (or rolls back)
 * atomically with the write it describes (§4.2).
 *
 * Drift vs upstream, reconciled per the SPEC's port instruction:
 * - `scope_id` is TEXT, not int64: upstream's entities (users/orgs/repos)
 *   all carry int64 keys, but OUR `repositories.id` is a client-minted TEXT
 *   UUID (ADR-0001 D3), so a single typed column must be TEXT. Encoding:
 *   repository scope stores the `repositories.id` UUID; user/organization
 *   scope stores the `users.id` as its decimal string (SQLite TEXT affinity
 *   makes the numeric→text conversion explicit in the emitters). `''` is the
 *   system scope (upstream: "zero for system", audit_event.go:30).
 * - `scope_type`/`origin` are plain TEXT (the TS union is the enum; drizzle-kit
 *   emits no CHECK for SQLite enums) — upstream ScopeType (scopes.go:11-16)
 *   and Origin (origin.go:9-14) verbatim.
 * - Upstream's `Message` is rendered from the action's template at emit time
 *   (the DB never stores the template); `Metadata` is a JSON TEXT column
 *   (upstream LONGTEXT JSON), nullable, decoded by the seam.
 */
export const auditEvents = sqliteTable(
  "audit_event",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Hierarchical colon id (`repository:create`, `organization:team:add`,
     *  …) — registered with its message template in services/audit.ts
     *  (upstream `Action`, action.go:65+). */
    action: text("action").notNull(),
    actorId: integer("actor_id").notNull(),
    /** Snapshot at emit time (upstream `ActorName`). */
    actorName: text("actor_name").notNull().default(""),
    /** Credential the actor acted with ("access-token:<id>", …); null when
     *  the write rode a session (upstream `ActorCredential`). */
    actorCredential: text("actor_credential"),
    /** Admin acting as the actor; 0 = no impersonation (upstream
     *  `ImpersonatorID`, audit_event.go:28). */
    impersonatorId: integer("impersonator_id").notNull().default(0),
    impersonatorName: text("impersonator_name"),
    /** 'system' | 'user' | 'organization' | 'repository' (scopes.go:11-16). */
    scopeType: text("scope_type", {
      enum: ["system", "user", "organization", "repository"],
    }).notNull(),
    /** See the drift note above — TEXT UUID (repo) / decimal string
     *  (user/org) / '' (system). */
    scopeId: text("scope_id").notNull().default(""),
    /** Snapshot at emit time (upstream `ScopeName`). */
    scopeName: text("scope_name"),
    /** 'ui' | 'api' | 'cli' | 'system' (origin.go:9-14). */
    origin: text("origin", { enum: ["ui", "api", "cli", "system"] }).notNull(),
    /** Rendered from the action's registered template at emit time. */
    message: text("message").notNull().default(""),
    /** Target-specific details as JSON text (upstream `Metadata`); null when
     *  the message carries everything. */
    metadata: text("metadata"),
    ipAddress: text("ip_address"),
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream-matched scalar `Action INDEX` (audit_event.go:24). Serves the
    // exact-action filter arm AND the family-prefix filter (`action LIKE
    // 'repository:%'` walks the index range [prefix:, prefix;) — upstream
    // ActionFilters' family filtering, action.go:38-54).
    index("idx_audit_event_action").on(t.action),
    // Upstream-matched scalar `ActorID INDEX` (:25) — the actor's own trail
    // (impersonated events belong to both ids upstream; ToConds ORs
    // actor_id/impersonator_id, audit_event.go:182-184).
    index("idx_audit_event_actor").on(t.actorId),
    // Upstream-matched scalar `ImpersonatorID INDEX` (:28).
    index("idx_audit_event_impersonator").on(t.impersonatorId),
    // Upstream-matched scalar `TimestampUnix INDEX` (:37) — the GLOBAL
    // time-ordered page (scope-less listing) and the retention sweep's
    // existence probe / paged delete (`created_unix < cut`).
    index("idx_audit_event_created").on(t.createdUnix),
    // Index decision (SPEC-0015 §4.1 + ratification §7 item 6 — decided at
    // db:generate time against the query plan, per
    // docs/research/d1-index-engineering.md): upstream composes `INDEX(scope)`
    // = (ScopeType, ScopeID) (:30-31) and leaves the created order to its
    // scalar TimestampUnix index, so the paged read `WHERE scope_type = ? AND
    // scope_id = ? ORDER BY created_unix DESC` (the settings tab's keyset
    // pager, mirroring ToOrders' "timestamp_unix DESC, id DESC",
    // audit_event.go:200-205) pays a sort step upstream. COLLAPSE divergence
    // per the research note's class 1: folding `created_unix` as the trailing
    // composite column turns the page into an ordered index range SQLite
    // walks backwards (the issues_repo_pull_closed_created_idx precedent,
    // schema.ts:522-533). The EXPLAIN witness in services/audit.test.ts pins
    // the plan to this index with no sort step.
    index("idx_audit_event_scope_created").on(t.scopeType, t.scopeId, t.createdUnix),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0016 §4.1 — the package registry model (six tables). Column-for-column
// ports of §2.2's upstream structs (gitea/models/packages/{package,
// package_version,package_blob,package_file,package_property,
// package_cleanup_rule}.go) onto D1 types; every UNIQUE constraint is the
// upstream `UNIQUE(s)` arbitration the SPEC §2.2 pinned (constraint-first,
// the org_members_org_user_uq pattern — §4.3: no DO, the D1 UNIQUEs are the
// mutation arbiter). Owner scoping lives ONLY on the packages row; blobs are
// content-addressed and global (§4.2 — dedup across owners is the point).
// ---------------------------------------------------------------------------

/**
 * The package identity row (upstream `Package`, package.go:191-199).
 * `UNIQUE(owner_id, type, lower_name)` is TryInsertPackage's arbitration
 * (one package per owner/type/lower name — package.go:203-213); the
 * duplicate answer is the EXISTING row (the GetOrInsert shape §5.2 pins).
 *
 * Drift vs upstream, reconciled per the audit_event scope_id precedent:
 * `repo_id` is TEXT, not int64 — upstream `RepoID int64` keys its own int64
 * repositories table, but OUR `repositories.id` is a client-minted TEXT UUID
 * (ADR-0001 D3). NULL = global to the owner (upstream 0), and
 * linkPackage/unlinkPackage set/clear it; the index serves the R16 repo-tab
 * source query (`RepoID = ?`, routers/web/repo/packages.go:24-33) and the
 * §5.6 repo-delete unlink arm. `owner_id` stays INTEGER: it keys `users.id`,
 * which is integer on our side too.
 */
export const packages = sqliteTable(
  "packages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** users.id of the owner (a user OR an org — orgs are user rows). */
    ownerId: integer("owner_id").notNull(),
    /** Optional repo link: the TEXT repositories.id UUID; NULL = global
     *  (upstream `RepoID` 0-sentinel, adapted to TEXT — see the drift note). */
    repoId: text("repo_id"),
    /** Registry type — upstream's open 23-constant string set (package.go:33-53);
     *  TEXT, no CHECK list, so ecosystem milestones add types without
     *  migrations (§5.9). */
    type: text("type").notNull(),
    /** Display-cased package name. */
    name: text("name").notNull(),
    /** Case-folded lookup + uniqueness key (upstream `LowerName`). */
    lowerName: text("lower_name").notNull(),
    /** Upstream `SemverCompatible` — display-ordering hint (§5.7). */
    semverCompatible: integer("semver_compatible", { mode: "boolean" }).notNull().default(false),
    isInternal: integer("is_internal", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("packages_owner_type_lower_name_uq").on(t.ownerId, t.type, t.lowerName),
    // Upstream `RepoID int64 xorm:"UNIQUE(s) INDEX"` — the index half; the
    // R16 repo-tab filter and the repo-delete unlink arm both scan it.
    index("packages_repo_id_idx").on(t.repoId),
  ],
);

/**
 * Package versions (upstream `PackageVersion`, package_version.go:27-36).
 * `UNIQUE(package_id, lower_version)` is GetOrInsertVersion's arbitration —
 * a re-publish answers the EXISTING row (the ErrDuplicatePackageVersion
 * sentinel upstream returns with it, package_version.go:48-67; §5.2).
 * `metadata_json` is the per-ecosystem extension payload (upstream LONGTEXT
 * JSON); generic writes none (NULL) in v1 (§5.4).
 */
export const packageVersions = sqliteTable(
  "package_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    packageId: integer("package_id").notNull(),
    /** The doer that published the version (0 = system/unattributed). */
    creatorId: integer("creator_id").notNull().default(0),
    /** Display-cased version string. */
    version: text("version").notNull(),
    /** Case-folded version — the uniqueness half (upstream `LowerVersion`). */
    lowerVersion: text("lower_version").notNull(),
    /** Upstream `CreatedUnix xorm:"INDEX created"` — the §5.7 list order key. */
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
    isInternal: integer("is_internal", { mode: "boolean" }).notNull().default(false),
    /** Per-ecosystem metadata JSON (upstream `MetadataJSON`); NULL in v1. */
    metadataJson: text("metadata_json"),
    /** Bumped by the bare `x + 1` increment on lead-file GET downloads
     *  (upstream IncrementDownloadCounter, package_version.go:76-79; §5.8). */
    downloadCount: integer("download_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("package_versions_package_lower_version_uq").on(t.packageId, t.lowerVersion),
    // Upstream `CreatedUnix xorm:"INDEX created"` — the default list order
    // (`created_unix DESC, id DESC`, §5.7) and the cleanup rules' SortCreatedDesc.
    index("package_versions_created_idx").on(t.createdUnix),
  ],
);

/**
 * Content-addressed blobs (upstream `PackageBlob`, package_blob.go:30-39).
 * The row is the DEDUP record only — the R2 key IS `hash_sha256` (§4.2:
 * `packages/blobs/aa/bb/<sha256>`, no r2_key column — the D1-bare-rows rule;
 * the hash column already names the object, unlike the release-asset uuid
 * keys, because package blobs dedup). Upstream UNIQUEs each hash column
 * (UNIQUE(md5)/UNIQUE(sha1)/UNIQUE(sha256)/UNIQUE(sha512), :32-36); the hash
 * columns stay NULLABLE here (upstream NOT NULL) because our digester
 * computes the three WebCrypto-supported digests (SHA-1/256/512) per upload
 * and MD5 is unavailable in Workers' WebCrypto — generic uploads land
 * hash_md5 NULL, and SQLite unique indexes treat NULLs as distinct so the
 * nullable UNIQUEs stay sound. Dedup lookup is (size, sha256) + the present
 * digests — upstream's size+all-four-hashes GetOrInsertBlob
 * (package_blob.go:52-77) reduced to the columns we always fill.
 */
export const packageBlobs = sqliteTable(
  "package_blobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Byte size (upstream `Size int64 NOT NULL DEFAULT 0`). */
    size: integer("size").notNull().default(0),
    /** hex digests; md5 (and sha1/sha512) nullable — see the table comment. */
    hashMd5: text("hash_md5"),
    hashSha1: text("hash_sha1"),
    /** The R2 key material (`packages/blobs/aa/bb/<hash>`) — NOT NULL. */
    hashSha256: text("hash_sha256").notNull(),
    hashSha512: text("hash_sha512"),
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("package_blobs_md5_uq").on(t.hashMd5),
    uniqueIndex("package_blobs_sha1_uq").on(t.hashSha1),
    uniqueIndex("package_blobs_sha256_uq").on(t.hashSha256),
    uniqueIndex("package_blobs_sha512_uq").on(t.hashSha512),
    // Upstream `CreatedUnix xorm:"created INDEX NOT NULL"` — the cleanup
    // sweep's OLDER_THAN scan (FindExpiredUnreferencedBlobs walks it).
    index("package_blobs_created_idx").on(t.createdUnix),
  ],
);

/**
 * Files inside a version (upstream `PackageFile`, package_file.go:34-43).
 * `UNIQUE(version_id, lower_name, composite_key)` is TryInsertFile's
 * arbitration — a file's identity inside one version; composite_key is the
 * maven/conan-style disambiguator, always `''` (EmptyFileKey) in v1.
 */
export const packageFiles = sqliteTable(
  "package_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    versionId: integer("version_id").notNull(),
    /** The content-addressed blob this file serves (upstream `BlobID INDEX`). */
    blobId: integer("blob_id").notNull(),
    /** Display filename (verbatim; the lower-cased twin is the uq half). */
    name: text("name").notNull(),
    lowerName: text("lower_name").notNull(),
    /** Upstream `CompositeKey` — '' for generic (EmptyFileKey). */
    compositeKey: text("composite_key").notNull().default(""),
    /** Lead files bump the version download counter on GET (upstream
     *  OpenBlobForDownload's IsLead gate, packages.go:655-660). */
    isLead: integer("is_lead", { mode: "boolean" }).notNull().default(false),
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("package_files_version_lower_composite_uq").on(t.versionId, t.lowerName, t.compositeKey),
    // Upstream `BlobID int64 xorm:"INDEX"` — the dedup reference count the
    // sole-sweeper deletion relies on (ratification 4: a content key is
    // deletable only when zero file rows reference its blob id).
    index("package_files_blob_idx").on(t.blobId),
  ],
);

/**
 * Per-ecosystem key-value properties (upstream `PackageProperty`,
 * package_property.go:31-37) — the extension seam (npm dist-tags, container
 * digests, alpine fields all land here in later milestones; §5.4: generic
 * writes none in v1). `ref_type` is upstream's iota: 0=version / 1=file /
 * 2=package (package_property.go:22-27).
 */
export const packageProperties = sqliteTable(
  "package_properties",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 0=version / 1=file / 2=package (upstream PropertyType iota). */
    refType: integer("ref_type").notNull(),
    /** The referenced row's id within `ref_type`. */
    refId: integer("ref_id").notNull(),
    name: text("name").notNull(),
    /** LONGTEXT upstream; TEXT here. */
    value: text("value").notNull(),
  },
  (t) => [
    // SPEC-0016 §4.1's pinned index — every property read/delete resolves by
    // (ref_type, ref_id) (DeleteAllProperties, the descriptor assembly).
    index("package_properties_ref_idx").on(t.refType, t.refId),
    // Upstream `Name string xorm:"INDEX"` (package_property.go:33) — the
    // property-name filter (e.g. container digest lookups, later milestones).
    index("package_properties_name_idx").on(t.name),
  ],
);

/**
 * Per-owner cleanup rules (upstream `PackageCleanupRule`,
 * package_cleanup_rule.go:25-40). `UNIQUE(owner_id, type)` — one rule per
 * owner+type upstream (0 = user-level default owner sentinel). Rules CRUD is
 * DOWNSTREAM (the settings pages); the table lands with the model so the
 * cleanup arm has its inputs (§4.1). Patterns are regex strings compiled
 * case-insensitively anchored at execution time (upstream
 * `(?i)\A…\z`, package_cleanup_rule.go:41-54).
 */
export const packageCleanupRules = sqliteTable(
  "package_cleanup_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** Owner sentinel: users.id, 0 = user-level default (upstream OwnerID). */
    ownerId: integer("owner_id").notNull().default(0),
    /** Registry type the rule sweeps ('' or a type — TEXT per §5.9). */
    type: text("type").notNull(),
    /** Versions newer than this count (by created desc) are always kept. */
    keepCount: integer("keep_count").notNull().default(0),
    /** Keep-regex (case-insensitive, anchored at compile time). */
    keepPattern: text("keep_pattern").notNull().default(""),
    /** Versions younger than this many days are always kept. */
    removeDays: integer("remove_days").notNull().default(0),
    /** Remove-regex — only versions MATCHING it are deletable. */
    removePattern: text("remove_pattern").notNull().default(""),
    /** Match `lower_name/lower_version` instead of bare `lower_version`. */
    matchFullName: integer("match_full_name", { mode: "boolean" }).notNull().default(false),
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
    updatedUnix: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("package_cleanup_rules_owner_type_uq").on(t.ownerId, t.type),
  ],
);

/**
 * In-flight chunked blob uploads (SPEC-0016 M6 — upstream `PackageBlobUpload`,
 * package_blob_upload.go:24-30): the upload-SESSION row of the OCI container
 * registry (POST → PATCH chunks → PUT, routers/api/packages/container/
 * container.go:236-488). One row per `POST /v2/{owner}/{image}/blobs/uploads`;
 * the CHUNK BYTES live in R2 (`packages/uploads/<uuid>/<seq>` — the analog of
 * upstream's `AppDataTempDir("package-upload")` temp file, one object per
 * PATCH since R2 cannot append), so the row carries the two counters the
 * protocol needs: `bytes_received` (the Range answer + the Content-Range
 * offset gate) and `chunk_count` (the ordered chunk enumeration — upstream
 * infers the extent from the file).
 *
 * ONE disclosed column reduction: upstream's `HashStateBytes BLOB` (the
 * serialized MultiHasher resume state, blob_uploader.go:48-53) has NO analog —
 * Workers' WebCrypto digest state is unserializable — so the PUT re-streams
 * the chunks through fresh digests to verify the `?digest=` param (the
 * container service module documents the trade). `updated_unix` keeps
 * upstream's INDEX (FindExpiredBlobUploads' sweep scan, :71-76); `created_unix`
 * stays a plain column (upstream `created` is unindexed). No UNIQUEs beyond
 * the PK — the id is the random session handle (upstream
 * CryptoRandomString(25); ours crypto.randomUUID() per the Workers ID rule).
 */
export const packageBlobUploads = sqliteTable(
  "package_blob_uploads",
  {
    /** The opaque upload uuid (`.../blobs/uploads/<uuid>`, upstream pk ID). */
    id: text("id").primaryKey(),
    /** Running byte total (upstream `BytesReceived NOT NULL DEFAULT 0`). */
    bytesReceived: integer("bytes_received").notNull().default(0),
    /** Ordered R2 chunk-object count (the temp-file extent analog). */
    chunkCount: integer("chunk_count").notNull().default(0),
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
    /** Upstream `UpdatedUnix INDEX NOT NULL` — the expiry sweep's scan key. */
    updatedUnix: integer("updated_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("package_blob_uploads_updated_idx").on(t.updatedUnix),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0018 §4.1 — the system notices model (one table). A column-for-column
// port of §2.2's upstream struct (gitea/models/system/notice.go:29-34,
// `Notice{ID, Type, Description LONGTEXT, CreatedUnix INDEX created}`) onto
// D1 types. The rows are SYSTEM-attributed failure reports — no actor, no
// credential, no owner column (§5.5: nothing cascades; a dead-lettered purge
// notice about repo X deliberately outlives X) — written by the repo-tasks
// DLQ consumer (§3.1's emit seam, repos/dlq.ts) and read/deleted by the
// /-/admin/notices page (§3.1's three routes). No UNIQUEs (an append log —
// upstream has none), no FKs, and the description is bounded AT EMIT (§5.2),
// so the upstream LONGTEXT lands as a plain TEXT.
// ---------------------------------------------------------------------------

/** Upstream `NoticeRepository` (notice.go:23) — repo-subsystem failures
 *  (the purge/import/fork/mirror DLQ families). */
export const SYSTEM_NOTICE_TYPE_REPOSITORY = 1;
/** Upstream `NoticeTask` (notice.go:25) — maintenance-task outcomes (the
 *  demo-sweep/audit-retention riders). */
export const SYSTEM_NOTICE_TYPE_TASK = 2;

export const systemNotices = sqliteTable(
  "system_notices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Upstream `Type NoticeType` — the closed two-value enum stored as an
     *  int upstream too (iota+1); INTEGER here, not TEXT, because the page's
     *  label keys off the number (`admin.notices.type_%d`, notice.go:41-43).
     *  Upstream table name is `notice`; the drizzle plural convention applies
     *  (§4.1). */
    type: integer("type").notNull(),
    /** The RENDERED one-liner — the DB never stores a template (the audit
     *  seam's discipline), bounded at emit to 2000 chars with a visible `…`
     *  (§5.2; upstream LONGTEXT unbounded). */
    description: text("description").notNull(),
    /** Upstream `CreatedUnix xorm:"INDEX created"` — the DESC paged read's
     *  scan key (notice.go:82-88). */
    createdUnix: integer("created_unix", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream `xorm:"INDEX created"` (notice.go:33) — the list's
    // `created_unix DESC, id DESC` order (§5.7: the id tiebreak keeps a
    // same-second DLQ batch in insertion order).
    index("system_notices_created_idx").on(t.createdUnix),
  ],
);

// ---------------------------------------------------------------------------
// SPEC-0012 §4.1 — the Actions control-plane model (twelve tables). A
// column-for-column port of the §4 census (gitea/models/actions/{runner,
// runner_token,run,run_job,run_attempt,task,task_step,task_output,
// tasks_version,artifact,run_job_summary}.go; action_log_chunks is OUR DBFS
// analog, §4.3 — upstream scopes its log chunks inside the generic `dbfs`
// table). The schedule pair (action_schedules + action_schedule_specs) is
// deferred to the scheduled-workflows milestone (SPEC §1.4 — no reader);
// `secrets` + `action_variables` + `commit_statuses` already exist and are
// shared, not re-created.
//
// House adaptations, each the landed precedent:
//  - `repo_id` is TEXT (the repositories.id UUID) with the secrets-table
//    sentinel encoding — '' stands for upstream's 0 (not-repo-scoped) on the
//    scope tables (runners, runner_tokens, tasks_versions); repo-bound rows
//    (runs, jobs, attempts, tasks, steps, artifacts, summaries, log_chunks)
//    carry a real id and are NOT NULL. A nullable repo_id would be unsound
//    wherever it participates in a UNIQUE: NULLs are DISTINCT in SQLite
//    unique indexes (the secrets-table comment).
//  - `owner_id` stays INTEGER (users.id is integer here too) with upstream's
//    0 = global sentinel intact.
//  - upstream `timeutil.TimeStamp` zero sentinels (Started/Stopped/Deleted/
//    LastOnline/LastActive/ExpiredUnix is 0=forever) — nullable INTEGER,
//    NULL = never, EXCEPT expired_unix which keeps the 0-sentinel (the
//    retention arithmetic reads it as a number).
//  - xorm `created`/`updated` auto columns land as `created`/`updated`
//    integer unix seconds (upstream's own column names — the actions tables
//    do not use the `created_unix` spelling of the secrets family).
//  - JSON list columns (agent_labels/needs/runs_on/token_permissions) are
//    TEXT, the issues-schema convention.
//  - workflow_source_repo_id / workflow_repo_id are repo REFERENCES and so
//    take the TEXT adaptation even though they are unread parity columns
//    (SPEC §1.4: the schema columns land, nothing reads them in v1).
// ---------------------------------------------------------------------------

/**
 * A registered runner (upstream `ActionRunner`, runner.go:26-60). Scopes:
 * (0,'') global, (owner,'') org/user, ('',repo)... i.e. repo-level rows carry
 * owner_id=0 + the repo id — upstream's "never both non-zero" rule
 * (runner.go:31-36). The plaintext runner token is never stored:
 * `token_hash` is the salted sha256 hex digest (SPEC-0002 §3 model;
 * upstream salted-pbkdf2 at auth_model.HashToken, interceptor.go:97-107).
 */
export const actionRunners = sqliteTable(
  "action_runners",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** CHAR(36) UNIQUE — minted at Register. */
    uuid: text("uuid").notNull().unique(),
    /** Display name, ellipsized to 255 runes at Register (runner.go:75). */
    name: text("name").notNull().default(""),
    /** Runner version string as advertised by the binary (VARCHAR(64)). */
    version: text("version").notNull().default(""),
    /** users.id; 0 = global (upstream `OwnerID int64 xorm:"index"`). */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id; '' = not repo-scoped (upstream `RepoID` 0). */
    repoId: text("repo_id").notNull().default(""),
    description: text("description").notNull().default(""),
    /** 0 native / 1 docker / 2 VM (upstream `Base int`). */
    base: integer("base").notNull().default(0),
    /** Glob match for which repositories may use this runner. */
    repoRange: text("repo_range").notNull().default(""),
    /** Salted sha256 hex of the runner's polling token (UNIQUE). */
    tokenHash: text("token_hash").notNull().unique(),
    tokenSalt: text("token_salt").notNull().default(""),
    /** Heartbeats — debounced writes (30 s online / 5 s active windows,
     *  interceptor.go:72-84); NULL = never seen (upstream 0). */
    lastOnline: integer("last_online", { mode: "timestamp" }),
    lastActive: integer("last_active", { mode: "timestamp" }),
    /** JSON array of label strings (upstream `AgentLabels []string TEXT`). */
    agentLabels: text("agent_labels").notNull().default("[]"),
    /** One task per lifetime (task.go:77-95 refuses + deletes after). */
    ephemeral: integer("ephemeral", { mode: "boolean" }).notNull().default(false),
    isDisabled: integer("is_disabled", { mode: "boolean" }).notNull().default(false),
    /** Supports the transitional StatusCancelling flow ("cancelling"
     *  capability string, runner.go:70-72). */
    hasCancellingSupport: integer("has_cancelling_support", { mode: "boolean" })
      .notNull()
      .default(false),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
    /** NULL = live (upstream `Deleted` 0 sentinel). */
    deleted: integer("deleted", { mode: "timestamp" }),
  },
  (t) => [
    index("action_runners_owner_id_idx").on(t.ownerId),
    index("action_runners_repo_id_idx").on(t.repoId),
    index("action_runners_last_online_idx").on(t.lastOnline),
    index("action_runners_last_active_idx").on(t.lastActive),
  ],
);

/**
 * A registration token (upstream `ActionRunnerToken`,
 * runner_token.go:26-37). Stored RAW upstream (`GetRunnerToken` looks it up
 * by the presented string, runner_token.go:50-58) and stays raw for parity —
 * unlike the post-registration runner token, which is salted-hash. Reset =
 * create-new-and-deactivate-old: `NewRunnerTokenWithValue` deactivates every
 * same-scope active token in one transaction before inserting the new active
 * one (runner_token.go:75-107), so one active token registers a fleet until
 * the next reset (SPEC §2.2 NOTE — the corrected semantics).
 */
export const actionRunnerTokens = sqliteTable(
  "action_runner_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The RAW token string (UNIQUE — the lookup key). */
    token: text("token").notNull().unique(),
    /** users.id; 0 = global (the same three-scope rule as runners). */
    ownerId: integer("owner_id").notNull().default(0),
    /** TEXT repositories.id; '' = not repo-scoped. */
    repoId: text("repo_id").notNull().default(""),
    /** true = usable; a reset flips same-scope predecessors to false. */
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
    /** NULL = not deleted (upstream `Deleted` 0 sentinel). */
    deleted: integer("deleted", { mode: "timestamp" }),
  },
  (t) => [
    index("action_runner_tokens_owner_id_idx").on(t.ownerId),
    index("action_runner_tokens_repo_id_idx").on(t.repoId),
  ],
);

/**
 * A workflow run (upstream `ActionRun`, run.go:32-76). `UNIQUE(repo_id,
 * index)` is the per-repo run-number arbitration (upstream
 * `unique(repo_index)` over the `action_run_index` named sequence → our
 * `repo_counters.run_index` at M3, SPEC §4.5). `version` is the optimistic
 * lock for concurrent status writes (run.go:67). The three
 * workflow-source/scoped parity columns are unread in v1 (SPEC §1.4).
 */
export const actionRuns = sqliteTable(
  "action_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull().default(""),
    repoId: text("repo_id").notNull(),
    ownerId: integer("owner_id").notNull(),
    /** The workflow file path (the run's workflow identity). */
    workflowId: text("workflow_id").notNull().default(""),
    /** The per-repo run number (UNIQUE with repo_id). */
    index: integer("index").notNull(),
    triggerUserId: integer("trigger_user_id").notNull().default(0),
    /** Deferred scheduled-workflow link (SPEC §1.4). */
    scheduleId: integer("schedule_id").notNull().default(0),
    /** The commit/tag/… ref that caused the run. */
    ref: text("ref").notNull().default(""),
    commitSha: text("commit_sha").notNull().default(""),
    isForkPullRequest: integer("is_fork_pull_request", { mode: "boolean" }).notNull().default(false),
    needApproval: integer("need_approval", { mode: "boolean" }).notNull().default(false),
    /** users.id of the approver. */
    approvedBy: integer("approved_by").notNull().default(0),
    /** The webhook event type that caused the run. */
    event: text("event").notNull().default(""),
    /** The webhook payload JSON. */
    eventPayload: text("event_payload").notNull().default("{}"),
    /** The trigger event from the workflow's `on:` configuration. */
    triggerEvent: text("trigger_event").notNull().default(""),
    /** The 10-value Status enum (models/actions/status.go:15-25). */
    status: integer("status").notNull().default(0),
    /** Optimistic lock (upstream `xorm:"version default 0"`). */
    version: integer("version").notNull().default(0),
    rawConcurrency: text("raw_concurrency").notNull().default(""),
    /** Parity columns, unread in v1 (SPEC §1.4). */
    workflowRepoId: text("workflow_repo_id").notNull().default(""),
    workflowCommitSha: text("workflow_commit_sha").notNull().default(""),
    isScopedRun: integer("is_scoped_run", { mode: "boolean" }).notNull().default(false),
    /** Latest-attempt timing mirrors; NULL = not started/stopped. */
    started: integer("started", { mode: "timestamp" }),
    stopped: integer("stopped", { mode: "timestamp" }),
    /** Legacy-only (pre-attempt runs); v1 always 0. */
    previousDuration: integer("previous_duration").notNull().default(0),
    latestAttemptId: integer("latest_attempt_id").notNull().default(0),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream `unique(repo_index)` — the (repo, run-number) arbitration.
    uniqueIndex("action_runs_repo_index_uq").on(t.repoId, t.index),
    // Upstream `index(repo_status)` = (RepoID, Status).
    index("action_runs_repo_status_idx").on(t.repoId, t.status),
    index("action_runs_owner_id_idx").on(t.ownerId),
    index("action_runs_workflow_id_idx").on(t.workflowId),
    index("action_runs_trigger_user_id_idx").on(t.triggerUserId),
    index("action_runs_ref_idx").on(t.ref),
    index("action_runs_commit_sha_idx").on(t.commitSha),
    // Upstream `Status xorm:"index index(repo_status)"` — scalar + composite.
    index("action_runs_status_idx").on(t.status),
    index("action_runs_approved_by_idx").on(t.approvedBy),
    index("action_runs_latest_attempt_id_idx").on(t.latestAttemptId),
  ],
);

/**
 * A job of a run (upstream `ActionRunJob`, run_job.go:34-130+). The
 * `workflow_payload` is the single-job YAML (act/jobparser.SingleWorkflow
 * bytes) the runner receives at claim. `needs`/`runs_on` are JSON string
 * arrays; `UNIQUE`-less — the claim CAS (`task_id = 0 AND status = waiting`,
 * task.go:392-400) is the concurrency arbiter, exactly as upstream. The
 * reusable-workflow column family is parity-ported, unread in v1 (SPEC
 * §1.4); the composite indexes follow upstream's xorm tag composition
 * (repo_status / pickup / repo_concurrency, run_job.go:36-77).
 */
export const actionRunJobs = sqliteTable(
  "action_run_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    repoId: text("repo_id").notNull(),
    ownerId: integer("owner_id").notNull(),
    commitSha: text("commit_sha").notNull().default(""),
    isForkPullRequest: integer("is_fork_pull_request", { mode: "boolean" }).notNull().default(false),
    /** Display name (VARCHAR(255)). */
    name: text("name").notNull().default(""),
    /** Which attempt this job belongs to; v1 always 1 (SPEC §1.4). */
    attempt: integer("attempt").notNull().default(1),
    /** The single-job YAML payload (BLOB) served at claim time. */
    workflowPayload: blob("workflow_payload").notNull(),
    /** The YAML job key (not the row id). */
    jobId: text("job_id").notNull().default(""),
    /** JSON string arrays (upstream `xorm:"JSON TEXT"`). */
    needs: text("needs").notNull().default("[]"),
    runsOn: text("runs_on").notNull().default("[]"),
    /** The task created by this job in its own attempt; 0 = unclaimed. */
    taskId: integer("task_id").notNull().default(0),
    /** Points at a historical task when a rerun reuses an earlier result. */
    sourceTaskId: integer("source_task_id").notNull().default(0),
    status: integer("status").notNull().default(0),
    rawConcurrency: text("raw_concurrency").notNull().default(""),
    isConcurrencyEvaluated: integer("is_concurrency_evaluated", { mode: "boolean" })
      .notNull()
      .default(false),
    concurrencyGroup: text("concurrency_group").notNull().default(""),
    concurrencyCancel: integer("concurrency_cancel", { mode: "boolean" }).notNull().default(false),
    /** JSON repo_model.ActionsTokenPermissions; NULL = unspecified. */
    tokenPermissions: text("token_permissions"),
    maxParallel: integer("max_parallel").notNull().default(0),
    isMatrixDeferred: integer("is_matrix_deferred", { mode: "boolean" }).notNull().default(false),
    deferredMatrixPayload: blob("deferred_matrix_payload"),
    runAttemptId: integer("run_attempt_id").notNull().default(0),
    attemptJobId: integer("attempt_job_id").notNull().default(0),
    // The reusable-workflow family — parity-ported, unread in v1 (SPEC §1.4).
    workflowSourceRepoId: text("workflow_source_repo_id").notNull().default(""),
    workflowSourceCommitSha: text("workflow_source_commit_sha").notNull().default(""),
    isReusableCaller: integer("is_reusable_caller", { mode: "boolean" }).notNull().default(false),
    isExpanded: integer("is_expanded", { mode: "boolean" }).notNull().default(false),
    callUses: text("call_uses").notNull().default(""),
    reusableWorkflowContent: blob("reusable_workflow_content"),
    reusableWorkflowRef: text("reusable_workflow_ref").notNull().default(""),
    callSecrets: text("call_secrets").notNull().default(""),
    callPayload: text("call_payload").notNull().default(""),
    parentJobId: integer("parent_job_id").notNull().default(0),
    continueOnError: integer("continue_on_error", { mode: "boolean" }).notNull().default(false),
    started: integer("started", { mode: "timestamp" }),
    stopped: integer("stopped", { mode: "timestamp" }),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("action_run_jobs_run_id_idx").on(t.runId),
    // Upstream `index(repo_status)` = (RepoID, Status).
    index("action_run_jobs_repo_status_idx").on(t.repoId, t.status),
    index("action_run_jobs_owner_id_idx").on(t.ownerId),
    index("action_run_jobs_commit_sha_idx").on(t.commitSha),
    // Upstream `index(pickup)` = (TaskID, Status) — the dispatch scan.
    index("action_run_jobs_pickup_idx").on(t.taskId, t.status),
    index("action_run_jobs_status_idx").on(t.status),
    // Upstream `index(repo_concurrency)` = (RepoID, ConcurrencyGroup, Status).
    index("action_run_jobs_repo_concurrency_idx").on(t.repoId, t.concurrencyGroup, t.status),
    index("action_run_jobs_run_attempt_id_idx").on(t.runAttemptId),
    index("action_run_jobs_attempt_job_id_idx").on(t.attemptJobId),
    index("action_run_jobs_is_reusable_caller_idx").on(t.isReusableCaller),
    index("action_run_jobs_parent_job_id_idx").on(t.parentJobId),
  ],
);

/**
 * A single execution attempt of a run (upstream `ActionRunAttempt`,
 * run_attempt.go:17-35, table `action_run_attempt` upstream too). v1 always
 * has exactly attempt = 1 per run (SPEC §1.4 — rerun is v2).
 * `UNIQUE(run_id, attempt)` is upstream `UNIQUE(run_attempt)`.
 */
export const actionRunAttempts = sqliteTable(
  "action_run_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    runId: integer("run_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    triggerUserId: integer("trigger_user_id").notNull().default(0),
    concurrencyGroup: text("concurrency_group").notNull().default(""),
    concurrencyCancel: integer("concurrency_cancel", { mode: "boolean" }).notNull().default(false),
    status: integer("status").notNull().default(0),
    started: integer("started", { mode: "timestamp" }),
    stopped: integer("stopped", { mode: "timestamp" }),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("action_run_attempts_run_attempt_uq").on(t.runId, t.attempt),
    // Upstream `index(repo_concurrency_status)` = (RepoID, ConcurrencyGroup,
    // Status) (run_attempt.go:21,29).
    index("action_run_attempts_repo_concurrency_status_idx").on(t.repoId, t.concurrencyGroup, t.status),
    index("action_run_attempts_status_idx").on(t.status),
  ],
);

/**
 * A claimed task (upstream `ActionTask`, task.go:40-66) — the runner-facing
 * execution unit created at claim time. `token_hash` is the task's polling
 * token (salted sha256 hex, UNIQUE); `log_*` columns mirror upstream's log
 * math (`log_length` = rows, `log_size` = bytes, `log_indexes` = the
 * varint row→offset map, §4.3); `log_filename` is
 * `logFileName(repoFullName, taskID)` — `"<full_name>/<id%256:02x>/<id>.log"`
 * (task.go:657-665, no `.zst` suffix: the LOG_COMPRESSION=none posture,
 * SPEC §4.6 divergence 1).
 */
export const actionTasks = sqliteTable(
  "action_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The claimed job (action_run_jobs.id). */
    jobId: integer("job_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    runnerId: integer("runner_id").notNull().default(0),
    status: integer("status").notNull().default(0),
    started: integer("started", { mode: "timestamp" }),
    stopped: integer("stopped", { mode: "timestamp" }),
    repoId: text("repo_id").notNull(),
    ownerId: integer("owner_id").notNull(),
    commitSha: text("commit_sha").notNull().default(""),
    isForkPullRequest: integer("is_fork_pull_request", { mode: "boolean" }).notNull().default(false),
    /** Salted sha256 hex of the task's polling token (UNIQUE). */
    tokenHash: text("token_hash").notNull().unique(),
    tokenSalt: text("token_salt").notNull().default(""),
    /** The last eight token chars (upstream's recovery surface). */
    tokenLastEight: text("token_last_eight").notNull().default(""),
    /** DBFS-analog filename (see the table comment). */
    logFilename: text("log_filename").notNull().default(""),
    /** true once the log has sealed to R2 (§4.3). */
    logInStorage: integer("log_in_storage", { mode: "boolean" }).notNull().default(false),
    /** Row count (upstream `LogLength int64`). */
    logLength: integer("log_length").notNull().default(0),
    /** Byte size (upstream `LogSize int64`). */
    logSize: integer("log_size").notNull().default(0),
    /** The row→byte-offset map (upstream varint-encoded `LogIndexes`). */
    logIndexes: blob("log_indexes"),
    logExpired: integer("log_expired", { mode: "boolean" }).notNull().default(false),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("action_tasks_runner_id_idx").on(t.runnerId),
    index("action_tasks_status_idx").on(t.status),
    index("action_tasks_started_idx").on(t.started),
    // Upstream `index(stopped_log_expired)` over (Stopped, LogExpired).
    index("action_tasks_stopped_log_expired_idx").on(t.stopped, t.logExpired),
    index("action_tasks_repo_id_idx").on(t.repoId),
    index("action_tasks_owner_id_idx").on(t.ownerId),
    index("action_tasks_commit_sha_idx").on(t.commitSha),
    index("action_tasks_token_last_eight_idx").on(t.tokenLastEight),
    index("action_tasks_updated_idx").on(t.updated),
  ],
);

/**
 * A step of a task (upstream `ActionTaskStep`, task_step.go:17-36).
 * `UNIQUE(task_id, index)` is upstream `unique(task_index)`. `stage` is a
 * runnerv1.StepStage (0 = parsed-from-workflow, not runner-reported);
 * M1a lands the table with the model — step ROWS are inserted by the
 * workflow-parse pipeline (M1b/M3); runner-REPORTED steps ride M1b's
 * UpdateTask. `number` is the step's index in the workflow file for
 * PRE/MAIN/POST stage rows.
 */
export const actionTaskSteps = sqliteTable(
  "action_task_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Display name, truncated at 255 runes. */
    name: text("name").notNull().default(""),
    taskId: integer("task_id").notNull(),
    index: integer("index").notNull(),
    repoId: text("repo_id").notNull(),
    status: integer("status").notNull().default(0),
    logIndex: integer("log_index").notNull().default(0),
    logLength: integer("log_length").notNull().default(0),
    /** runnerv1.StepStage; 0 = unspecified (workflow-parsed). */
    stage: integer("stage").notNull().default(0),
    number: integer("number").notNull().default(0),
    started: integer("started", { mode: "timestamp" }),
    stopped: integer("stopped", { mode: "timestamp" }),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("action_task_steps_task_index_uq").on(t.taskId, t.index),
    index("action_task_steps_index_idx").on(t.index),
    index("action_task_steps_repo_id_idx").on(t.repoId),
    index("action_task_steps_status_idx").on(t.status),
  ],
);

/**
 * A task output (upstream `ActionTaskOutput`, task_output.go:17-23).
 * `UNIQUE(task_id, output_key)` is the upsert-if-absent arbitration
 * (InsertTaskOutputIfNotExist) behind M1b's UpdateTask output caps.
 */
export const actionTaskOutputs = sqliteTable(
  "action_task_outputs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    /** VARCHAR(255) — the cap lives in the writer (M1b). */
    outputKey: text("output_key").notNull(),
    /** MEDIUMTEXT upstream; TEXT here. */
    outputValue: text("output_value").notNull().default(""),
  },
  (t) => [
    uniqueIndex("action_task_outputs_task_key_uq").on(t.taskId, t.outputKey),
    index("action_task_outputs_task_id_idx").on(t.taskId),
  ],
);

/**
 * The per-scope dispatch counter (upstream `ActionTasksVersion`,
 * tasks_version.go:16-24). Scope rows: (0,'') global, (owner,'') owner,
 * (''→0,repo) repo — bumps cascade all three (IncreaseTaskVersion,
 * tasks_version.go:66-86); a missing row self-heals by re-insert at version
 * 1 (tasks_version.go:49-59), and FetchTask bootstraps 0→1 so a runner never
 * reads version 0 (runner.go:179-187). The '' repo_id sentinel keeps the
 * UNIQUE(owner_id, repo_id) arbitration sound (NULLs would be DISTINCT).
 */
export const actionTasksVersions = sqliteTable(
  "action_tasks_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerId: integer("owner_id").notNull().default(0),
    repoId: text("repo_id").notNull().default(""),
    version: integer("version").notNull().default(1),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("action_tasks_versions_owner_repo_uq").on(t.ownerId, t.repoId),
    // Upstream `RepoID int64 xorm:"INDEX UNIQUE(owner_repo)"` — the scalar.
    index("action_tasks_versions_repo_id_idx").on(t.repoId),
  ],
);

/**
 * An uploaded artifact (upstream `ActionArtifact`, artifact.go:62-90).
 * `UNIQUE(run_id, run_attempt_id, artifact_path, artifact_name)` is upstream
 * `unique(runid_attempt_name_path)` — a re-upload of the same identity is
 * UNIQUE-blocked (§5.5). `status`: 1 upload-pending → 2 confirmed →
 * 4 expired → 5 pending-deletion → 6 deleted (3 upload-error reserved,
 * artifact.go:21-29); the retention consumer owns the flips (§4.4).
 * `expired_unix` keeps upstream's 0 = keep-forever sentinel.
 */
export const actionArtifacts = sqliteTable(
  "action_artifacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id").notNull(),
    runAttemptId: integer("run_attempt_id").notNull().default(0),
    runnerId: integer("runner_id").notNull().default(0),
    repoId: text("repo_id").notNull(),
    ownerId: integer("owner_id").notNull().default(0),
    commitSha: text("commit_sha").notNull().default(""),
    /** The R2 object key (actions/artifacts/<run_id>/<artifact_id>, §4.2). */
    storagePath: text("storage_path").notNull().default(""),
    fileSize: integer("file_size").notNull().default(0),
    fileCompressedSize: integer("file_compressed_size").notNull().default(0),
    /** Upstream `ContentEncodingOrType`, column `content_encoding`. */
    contentEncodingOrType: text("content_encoding").notNull().default(""),
    artifactPath: text("artifact_path").notNull().default(""),
    artifactName: text("artifact_name").notNull().default(""),
    status: integer("status").notNull().default(1),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
    /** 0 = kept forever (upstream artifactKeepForever). */
    expiredUnix: integer("expired_unix").notNull().default(0),
  },
  (t) => [
    // Upstream `unique(runid_attempt_name_path)`.
    uniqueIndex("action_artifacts_run_attempt_name_path_uq").on(
      t.runId,
      t.runAttemptId,
      t.artifactPath,
      t.artifactName,
    ),
    index("action_artifacts_run_id_idx").on(t.runId),
    index("action_artifacts_repo_id_idx").on(t.repoId),
    index("action_artifacts_status_idx").on(t.status),
    index("action_artifacts_updated_idx").on(t.updated),
    index("action_artifacts_expired_unix_idx").on(t.expiredUnix),
  ],
);

/**
 * A per-step job summary (upstream `ActionRunJobSummary`,
 * run_job_summary.go:36-49). `UNIQUE(repo_id, run_id, run_attempt_id,
 * job_id, step_index)` is upstream `UNIQUE(summary_key)`; per-step and
 * aggregate 1 MiB caps live in the M1b writer (run_job_summary.go:23-29).
 */
export const actionRunJobSummaries = sqliteTable(
  "action_run_job_summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repoId: text("repo_id").notNull(),
    runId: integer("run_id").notNull(),
    runAttemptId: integer("run_attempt_id").notNull().default(0),
    /** The action_run_jobs.id of the summary's job. */
    jobId: integer("job_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    content: text("content").notNull().default(""),
    contentType: text("content_type").notNull().default("text/markdown"),
    /** Byte length, stored explicitly (the multibyte LENGTH() trap,
     *  run_job_summary.go:44-48). */
    contentSize: integer("content_size").notNull().default(0),
    created: integer("created", { mode: "timestamp" }).notNull(),
    updated: integer("updated", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // Upstream `UNIQUE(summary_key)` (run_job_summary.go:38-42).
    uniqueIndex("action_run_job_summaries_summary_key_uq").on(
      t.repoId,
      t.runId,
      t.runAttemptId,
      t.jobId,
      t.stepIndex,
    ),
  ],
);

/**
 * OUR DBFS analog (§4.3 — no upstream table; upstream scopes log chunks in
 * the generic `dbfs` table): hot log bytes per task, one row per UpdateLog
 * append (the protocol already batches rows per call), `(task_id, seq)`
 * UNIQUE guarding append order. Rows stream-merge into the R2 sealed object
 * `actions/logs/<log_filename>` at `no_more` and are deleted after the
 * object is durable (upstream's remove(), runner.go:354-356). M1a lands the
 * table with the model; the append/seal writers are M1b.
 */
export const actionLogChunks = sqliteTable(
  "action_log_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    /** Append order within the task's log. */
    seq: integer("seq").notNull(),
    bytes: blob("bytes").notNull(),
  },
  (t) => [
    uniqueIndex("action_log_chunks_task_seq_uq").on(t.taskId, t.seq),
    index("action_log_chunks_task_id_idx").on(t.taskId),
  ],
);

// ---------------------------------------------------------------------------
// The instance keystore (SPEC-0012 §4.4's keystore home — the upstream-faithful
// port of the JWT/key material persistence). Upstream keeps NEITHER piece in a
// models table: the HS256 general token-signing secret lives in the SETTING
// STORE (app.ini `[oauth2] JWT_SECRET`, generated once and saved back into the
// config when absent — modules/setting/oauth2.go:129-150, served by
// GetGeneralTokenSigningSecret, :154-164) and the actions OIDC RS256 key lives
// in an AppData FILE (<AppDataPath>/jwt/actions_oidc.pem,
// services/actions/oidc.go:40-54 via LoadOrCreateAsymmetricKey,
// services/oauth2_provider/jwtsigningkey.go:344-413). Our substrate has no
// app.ini and no data dir (SPEC-0018 §1 ratified: no runtime-writable settings
// store), so the D1 database — the deployment-local persistent store — is the
// analog home: one row per material piece, keyed by name.
// ---------------------------------------------------------------------------

/**
 * The instance keystore rows (one per crypto-material piece; write-once in
 * practice — code only ever INSERTs, rotation is the OPERATOR replacing or
 * deleting a row out-of-band + an isolate restart, exactly upstream's "edit
 * app.ini / replace the PEM and restart" semantics; the code never rewrites
 * an existing row).
 *
 * Rows (services/actions/secrets.ts owns the load-or-create behind
 * loadKeystore — the single swap point):
 *
 *   - `general_token_signing_secret` — value:
 *     `{"v":1,"tokenSigningSecret":"<64 hex chars = 32 bytes>"}` (upstream
 *     oauth2.JWT_SECRET's role: the HS256 key for the runtime JWT, the OIDC
 *     request JWT and the artifacts-v4 HMAC).
 *   - `actions_oidc_signing_key` — value: `{"v":1,"oidcPrivateJwk":{…}}` with
 *     the private RSA JWK + `kid` (upstream actions_oidc.pem's role; the
 *     PEM/PKCS8 spelling replaced by JWK JSON — the same material in Web
 *     Crypto's native format).
 *
 * At rest the values are plaintext JSON — the repo's ratified actions-secrets
 * posture (the `secrets` table comment above: "an instance key model does not
 * exist yet"; upstream itself stores the PEM unencrypted on the AppData disk).
 * `name` is the PRIMARY KEY: two rows, point reads, no further indexes. The
 * insert race (two isolates cold-generating concurrently) resolves by
 * on-conflict-do-nothing + read-back — strictly stronger than upstream's
 * temp-file + os.Link publish-complete-only dance (jwtsigningkey.go:389-392):
 * a D1 row is never observable half-written.
 */
export const systemKeystore = sqliteTable("system_keystore", {
  /** Material piece name (`general_token_signing_secret` |
   *  `actions_oidc_signing_key`). */
  name: text("name").primaryKey(),
  /** The material JSON (see the row shapes above). */
  value: text("value").notNull(),
  /** Row creation — the mint time (upstream's file creation / app.ini save). */
  createdAt: integer("created_unix", { mode: "timestamp" }).notNull(),
  /** Equals createdAt unless the OPERATOR rotated the material (the code
   *  never updates a row). */
  updatedAt: integer("updated_unix", { mode: "timestamp" }).notNull(),
});

/**
 * The per-arm cron tick state (usability F3 —
 * docs/usability/findings-latency-health.md): one row per landed scheduled
 * arm (services/cron-state.ts CRON_ARMS owns the census; the Worker's
 * `scheduled` handler upserts it per entry execution and the admin monitor's
 * cron page reads it — "did the crons run today" becomes certifiable from
 * the product surface). Upstream keeps this state IN MEMORY on its Task
 * structs (services/cron/tasks.go TaskTableRow{Name, Spec, Next, Prev,
 * Status, LastMessage, ExecTimes} — a long-lived process, so no table
 * exists upstream); Workers isolates are ephemeral and the cron entries fire
 * in fresh invocations, so the same columns land in D1 instead. It is NOT a
 * general kv store (system_keystore is crypto-material, user/repo_settings
 * are per-principal): one tiny table, one row per arm, written by exactly
 * one writer (the scheduled handler).
 *
 * Column mapping (upstream TaskTableRow → here):
 *   - `arm` — the task name (upstream Name; the registry key).
 *   - `last_success_unix` — the last COMPLETED tick (upstream Prev shows the
 *     run START whether it succeeded or failed; ours records completion,
 *     because the entry-atomic recorder cannot attribute a failed entry's
 *     partially-run arms — the store module header holds the granularity
 *     note). NULL = never succeeded.
 *   - `last_error` / `last_error_unix` — upstream Status("error") +
 *     LastMessage (tasks.go:124-136); NULL = the last recorded tick was
 *     clean. The message is clipped at emit (the system_notices §5.2 bound
 *     discipline, scaled down).
 *   - `runs` — completed-tick count (upstream ExecTimes counts run STARTS,
 *     tasks.go:95-97, manual runs included — our granularity counts recorded
 *     successes, manual runs included via the monitor's run arm).
 */
export const cronState = sqliteTable("cron_state", {
  /** The scheduled arm's registry name (CRON_ARMS[].arm — upstream's task
   *  name where a faithful twin exists; the PRIMARY KEY is the whole row:
   *  one row per arm, point upserts, no further indexes). */
  arm: text("arm").primaryKey(),
  /** Last completed tick, unix seconds; NULL = never succeeded. */
  lastSuccessUnix: integer("last_success_unix", { mode: "timestamp" }),
  /** The entry's last failure one-liner (clipped at emit); NULL = clean. */
  lastError: text("last_error"),
  /** When lastError was written; NULL with a non-null lastError never
   *  happens (the recorder writes the pair). */
  lastErrorUnix: integer("last_error_unix", { mode: "timestamp" }),
  /** Completed-tick count (success upserts only — see the block comment). */
  runs: integer("runs").notNull().default(0),
});

/**
 * Outbound email outbox (specs/email-outbound.md §4, migration 0049). The
 * durable message store of the mailer service: the trigger inserts the
 * shaped-but-unsanitized message (services/mail/register-notify.ts) and the
 * REPO_TASKS consumer arm (services/mail/outbox.ts) applies the send-time
 * transforms (upstream `Message.ToMessage`,
 * gitea/services/mailer/sender/message.go:44-89) and hands the result to the
 * configured transport. The payload lives HERE; the queue message carries
 * only `{kind: "mail-outbox", mailId}` — the SPEC-0005 §3.6 webhook-delivery
 * design (retries read fresh state; the delivery log is complete regardless
 * of queue state). Upstream queues mail too (services/mailer/mailer.go:19,48).
 */
export const emailOutbox = sqliteTable(
  "email_outbox",
  {
    /** Row id — the only thing the queue message carries. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Upstream `Message.Info` (sender/message.go:24) — the log-purpose
     *  one-liner ("UID: 7, register notify"). */
    info: text("info").notNull(),
    /** Upstream `FromAddress` (message.go:25). */
    fromAddress: text("from_address").notNull(),
    /** Upstream `FromDisplayName` (message.go:26); '' = bare address. */
    fromDisplayName: text("from_display_name").notNull().default(""),
    /** Upstream `To` — ONE recipient (message.go:27's leak prevention). */
    toAddr: text("to_addr").notNull(),
    /** Upstream `ReplyTo` (message.go:28); NULL = header omitted. */
    replyTo: text("reply_to"),
    /** Stored UNSANITIZED; sanitize + prefix happen at send (SPEC §4.2). */
    subject: text("subject").notNull(),
    /** Upstream `Body` — the HTML half; text/plain derives at send (§5.6). */
    bodyHtml: text("body_html").notNull(),
    /** JSON `Record<string, string>` — upstream `Message.Headers`
     *  (map[string][]string) reduced to the single-value set the notify
     *  family actually sets (SPEC §4.4). */
    headers: text("headers"),
    /** 'pending' → 'sending' (the consumer's CAS claim) → 'sent' | 'failed'. */
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    /** Send attempts so far (queue redeliveries that reached the transport). */
    attempts: integer("attempts").notNull().default(0),
    /** The last failure one-liner (provider status/body excerpt, capped 1 KiB
     *  at emit); NULL = no failure recorded. */
    lastError: text("last_error"),
    /** Trigger-level idempotency (e.g. `register-notify:<userId>`); UNIQUE —
     *  SQLite permits many NULLs, so un-deduped triggers coexist (SPEC §4.1). */
    dedupeKey: text("dedupe_key"),
    /** Row creation, unix seconds. */
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    /** Send completion, unix seconds; set with status='sent'. */
    sentAt: integer("sent_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("email_outbox_dedupe_key_uq").on(table.dedupeKey)],
);

/**
 * Inbound email dedupe + log (specs/email-inbound.md §5, migration 0054).
 * Email Routing hands the Worker's `email()` handler each message
 * AT-LEAST-ONCE (MTA retries / platform redelivery), so the pipeline
 * INSERTs the row BEFORE any decision and the UNIQUE `dedupe_key` IS the
 * duplicate arbiter (the outbox `dedupe_key` pattern above); the outcome
 * columns then record what the message did. Upstream analogue: the IMAP
 * seen/deleted flag state + `handledSet` + log lines
 * (gitea/services/mailer/incoming/incoming.go:145-256), made durable and
 * queryable — upstream's mailbox-flag dedupe cannot port because there is
 * no mailbox. Rows are written only when `MAIL_INBOUND_ENABLED=true`
 * (the disabled gate writes NOTHING — the gate-off tripwire posture of
 * email-outbound §7.5). Retention is the SPEC §1.3 follow-up.
 */
export const emailInbound = sqliteTable(
  "email_inbound",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Message-ID when present, else sha256 over the stable envelope tuple
     *  (from ‖ to ‖ subject ‖ date ‖ rawSize — RFC 5322 makes Message-ID a
     *  SHOULD; duplicates must collapse either way, SPEC §3.4). UNIQUE —
     *  the at-least-once arbiter; the FIRST row owns the outcome. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Raw Message-ID header, clipped 998 (the RFC line bound). */
    messageId: text("message_id").notNull().default(""),
    /** Envelope pair (`ForwardableEmailMessage.from` / `.to`). */
    fromAddress: text("from_address").notNull(),
    toAddr: text("to_addr").notNull(),
    /** Raw Subject header (RFC 2047 NOT decoded — SPEC §3.3), clipped 998. */
    subject: text("subject").notNull().default(""),
    /** Cloudflare's PREPENDED Authentication-Results (identifier
     *  `mx.cloudflare.net` — sender-supplied ones are untrusted, SPEC
     *  §4.2), clipped 1024; NULL when the identifier does not match. */
    authResults: text("auth_results"),
    /** Decode verdict: 'none' | 'invalid' | 'expired' | 'valid'. */
    tokenStatus: text("token_status", { enum: ["none", "invalid", "expired", "valid"] })
      .notNull()
      .default("none"),
    /** Pipeline verdict (SPEC §6's step outcomes). */
    outcome: text("outcome", {
      enum: [
        "pending",
        "dropped-misconfigured",
        "rejected-oversize",
        "dropped-duplicate",
        "dropped-auto-reply",
        "dropped-no-token",
        "dropped-invalid-token",
        "dropped-expired-token",
        "dropped-permission",
        "dropped-empty",
        "dropped-missing-ref",
        "comment-created",
        "error",
      ],
    })
      .notNull()
      .default("pending"),
    /** The token's doer + resolved reference, when decoded that far. */
    userId: integer("user_id"),
    refType: text("ref_type", { enum: ["issue", "comment"] }),
    refId: integer("ref_id"),
    /** The created comment, on `comment-created`. */
    commentId: integer("comment_id"),
    /** clip(errorText, 1024) on `error` (the outbox lastError discipline). */
    error: text("error"),
    receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp" }),
  },
  (table) => [uniqueIndex("email_inbound_dedupe_key_uq").on(table.dedupeKey)],
);
