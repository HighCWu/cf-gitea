import { and, asc, desc, eq, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";

import { repoMirrors, repositories, users, type TeamAccessMode } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import type { Permission, Repository } from "../models/repository";
import type { User } from "../models/user";
import { OrgService } from "../../services/orgs/orgs";
import { renderGoDuration } from "./mirror";
import type { RepoSettings } from "./repo-settings";

/**
 * Repo-metadata reads backing the tier-1 `Repository` routes (SPEC-0004
 * §2.4 rows: repoGet / repoSearch / repoGetByID / userListRepos /
 * userCurrentListRepos). Everything reads the EXISTING D1 tables
 * (`repositories`, `users`); upstream columns that do not exist yet render
 * documented zero/defaults with `TODO(SPEC-0005)` markers instead of
 * inventing schema — the schema owner closes them when SPEC-0005 lands.
 *
 * The converter mirrors upstream `convert.innerToRepo`
 * (gitea/services/convert/repository.go) reduced to D1-only data, keeping the
 * vendored pin's runtime values for unit/PR-configuration defaults.
 *
 * Access model (SPEC-0007 §3.5 enforcement): the visibility/permission
 * predicates take an optional resolved team/owner `TeamAccessMode` — the
 * doer's org-repo grant (`doerRepoAccessMode` below, over the shared
 * `OrgService.teamRepoAccessMode` predicate + the Owners-team bridge). The
 * sync signatures stay back-compatible (callers that have not resolved a
 * grant keep the reduced owner/admin matrix); the `*WithTeams` resolvers and
 * the git-HTTP gate (git-http/acl.ts) pass the mode so a team-granted member
 * sees a private org repo upstream-style (GetDoerRepoPermission,
 * models/perm/access/repo_permission.go — read ⇒ pull, write/admin/owner ⇒
 * push, admin/owner ⇒ admin; AccessMode ranks, access_mode.go:17–22).
 */

/** D1 row of the `repositories` table (src/db/schema.ts). */
export type RepositoryRow = typeof repositories.$inferSelect;
/** D1 row of the `users` table (src/db/schema.ts). */
export type UserRow = typeof users.$inferSelect;
/** D1 row of the `repo_mirrors` table — the 1:1 pull-mirror schedule
 * (src/db/schema.ts, SPEC-0009 §3.1; upstream `Mirror`,
 * models/repo/mirror.go:23-38). */
export type RepoMirrorRow = typeof repoMirrors.$inferSelect;

/**
 * `{origin}/api/v1/repos/{owner}/{repo}` — upstream `Repository.APIURL`
 * (models/repo/repo.go:362–365); the prefix of every repo-scoped API URL
 * (labels, statuses, …).
 */
export function apiRepositoryUrl(pair: RepositoryWithOwner, origin: string): string {
  return `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
}

/** A repository row paired with its owner's user row (inner join — org-owned
 * repositories have no users row yet and stay invisible until orgs land). */
export interface RepositoryWithOwner {
  repo: RepositoryRow;
  owner: UserRow;
}

/**
 * The requesting identity for a conversion: the resolved `User` when a token
 * middleware ran, `null` for anonymous callers, plus the instance origin the
 * URLs are built against.
 */
export interface Viewer {
  origin: string;
  requester: User | null;
}

/** Requester accessor for optional-auth routes (middleware absent → null). */
export function viewerOf(c: Context<ApiEnv>): Viewer {
  const requester: User | undefined = c.get("authUser");
  return { origin: new URL(c.req.url).origin, requester: requester ?? null };
}

/**
 * Go's zero `time.Time` serialization — upstream emits this exact string for
 * timestamps that have no value (mirror times on non-mirrors, unset logins…).
 * It is the documented zero-default for our not-yet-existing timestamp
 * columns.
 */
export const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * Upstream's default branch for new repositories
 * (gitea/modules/setting/repository.go `Repository.DefaultBranch = "main"`).
 * Kept for callers that need the instance default; the converter renders the
 * row's `default_branch` column (SPEC-0003 §3.1, editable via repoEdit).
 */
export const DEFAULT_BRANCH = "main";

/** Upstream's default PR/unit configuration values (repo_unit.go defaults). */
const DEFAULT_MERGE_STYLE = "merge";
const DEFAULT_UPDATE_STYLE = "merge";
const DEFAULT_SQUASH_MERGE_MESSAGE = "PR_BODY";

/** Case-folded login of the requester, or null when anonymous. */
function requesterLoginLower(viewer: Viewer): string | null {
  return viewer.requester?.login?.toLowerCase() ?? null;
}

function isRepositoryOwner(viewer: Viewer, row: RepositoryRow): boolean {
  return requesterLoginLower(viewer) === row.ownerNamespace;
}

/**
 * Whether the viewer may see the repository at all. Private repositories are
 * invisible to everyone but the owner and site admins; the routes turn this
 * into the upstream anti-enumeration 404 (SPEC-0004 §2.4 gotcha).
 *
 * `teamMode` (optional, pre-resolved via `doerRepoAccessMode`): a non-'none'
 * org grant — an org team's effective mode or the Owners-team bridge — makes
 * the private repo visible to the grantee (upstream members read through
 * their team's unit access). Absent/null keeps the reduced matrix, so
 * callers that never resolved a grant behave exactly as before.
 */
export function canViewRepository(viewer: Viewer, row: RepositoryRow, teamMode?: TeamAccessMode | null): boolean {
  if (row.visibility === "public") {
    return true;
  }
  if (teamMode !== undefined && teamMode !== null && teamMode !== "none") {
    return true;
  }
  return viewer.requester !== null && (viewer.requester.is_admin === true || isRepositoryOwner(viewer, row));
}

/**
 * The doer's effective access mode over a repository from its ORG side —
 * `max(org-owner bridge arm, team arm)`: an `org_members.role='owner'` row
 * IS the upstream Owners team (authorize=owner, includes-all;
 * SPEC-0007 §3.3) and any covering team's grant comes through the shared
 * `OrgService.teamRepoAccessMode` predicate. 'none' for user-owned repos and
 * unaffiliated doers. This is the single repository-service predicate the
 * git-HTTP gate (git-http/acl.ts) consumes, so gate and API visibility
 * cannot drift.
 */
export async function doerRepoAccessMode(
  d1: D1Database,
  row: Pick<RepositoryRow, "id" | "ownerId">,
  userId: number,
): Promise<TeamAccessMode> {
  const orgs = new OrgService(d1);
  if (row.ownerId !== null && (await orgs.isOrgOwner(row.ownerId, userId))) {
    return "owner";
  }
  return orgs.teamRepoAccessMode(row, userId);
}

/**
 * Route-facing grant resolution: the doer's org/team access mode over the
 * repo, or null when the sync matrix already decides (anonymous, site admin,
 * the repo's own owner — arms checked without touching D1) or no team grant
 * exists ('none'). The ONE resolution a route feeds to BOTH
 * `canViewRepository` and `toApiRepository`, so the visibility check and the
 * embedded permissions block cannot disagree (upstream renders `ToRepo` with
 * the doer's resolved AccessMode, models/perm/access/repo_permission.go).
 */
export async function viewerTeamAccessMode(
  d1: D1Database,
  viewer: Viewer,
  row: RepositoryRow,
): Promise<TeamAccessMode | null> {
  if (viewer.requester === null || viewer.requester.is_admin === true || isRepositoryOwner(viewer, row)) {
    return null;
  }
  // The API `User.id` mirrors upstream's optional int64; a resolved doer
  // always carries one (the auth middlewares project the D1 row).
  const userId = viewer.requester.id;
  if (userId === undefined) return null;
  const mode = await doerRepoAccessMode(d1, row, userId);
  return mode === "none" ? null : mode;
}

/**
 * `canViewRepository` with the org/team grant resolved from D1 — the
 * async seam the route guards resolve through (SPEC-0007 §3.5). The pure
 * matrix answers first, so the hot arms (public repos, the repo's own owner,
 * site admins) cost no extra D1; only a first-pass miss pays the
 * `doerRepoAccessMode` lookup. The sync overload above stays for callers
 * that pass a pre-resolved mode or need the pure matrix.
 */
export async function canViewRepositoryWithTeams(
  d1: D1Database,
  viewer: Viewer,
  row: RepositoryRow,
): Promise<boolean> {
  if (canViewRepository(viewer, row)) return true;
  const teamMode = await viewerTeamAccessMode(d1, viewer, row);
  return canViewRepository(viewer, row, teamMode);
}

/**
 * Embedded `permissions` block (upstream `api.Permission` from the doer's
 * access mode). `teamMode` (optional, `doerRepoAccessMode`) maps the org
 * grant onto the block upstream-style: read ⇒ pull; write/admin/owner ⇒
 * push (+pull); admin/owner ⇒ admin. TODO(SPEC-0005): collaborators are
 * layered by the repo-access guards, not here.
 */
export function repositoryPermissions(
  viewer: Viewer,
  row: RepositoryRow,
  teamMode?: TeamAccessMode | null,
): Permission {
  if (viewer.requester !== null && (viewer.requester.is_admin === true || isRepositoryOwner(viewer, row))) {
    return { admin: true, push: true, pull: true };
  }
  if (teamMode !== undefined && teamMode !== null && teamMode !== "none") {
    const ranked = teamMode === "admin" || teamMode === "owner";
    return { admin: ranked, push: ranked || teamMode === "write", pull: true };
  }
  return { admin: false, push: false, pull: row.visibility === "public" };
}

/** `repositoryPermissions` with the org/team grant resolved from D1. */
export async function repositoryPermissionsWithTeams(
  d1: D1Database,
  viewer: Viewer,
  row: RepositoryRow,
): Promise<Permission> {
  const teamMode = await viewerTeamAccessMode(d1, viewer, row);
  return repositoryPermissions(viewer, row, teamMode);
}

/**
 * `Repository.owner` / embedded creators (upstream `ToUserWithAccessMode`,
 * which hardcodes `authed=false`: admin/active/login fields stay Go-zero even
 * for the owner). The primary email shows only to the user themself or a site
 * admin (upstream hides private emails behind a placeholder we do not render
 * yet). Exported for the converters that embed a `User` (commit-status
 * creator), matching upstream `convert.ToUser`.
 */
export function apiUserFromRow(row: UserRow, viewer: Viewer): User {
  const authed =
    viewer.requester !== null &&
    (viewer.requester.is_admin === true || requesterLoginLower(viewer) === row.usernameLower);
  return {
    id: row.id,
    login: row.username,
    type: "User",
    login_name: "",
    source_id: 0,
    full_name: row.displayName ?? "",
    email: authed ? (row.email ?? "") : "",
    avatar_url: `${viewer.origin}/avatars/${row.usernameLower}`, // TODO(SPEC-0005): avatar storage
    html_url: `${viewer.origin}/${row.username}`,
    language: "",
    is_admin: false,
    last_login: GO_ZERO_TIME, // TODO(SPEC-0005): last-login tracking
    created: row.createdAt.toISOString(),
    restricted: false,
    active: false,
    prohibit_login: false,
    location: "",
    website: "",
    description: "",
    visibility: "public", // TODO(SPEC-0005): user visibility column
    followers_count: 0, // TODO(SPEC-0005): social counters
    following_count: 0,
    // Upstream renders the maintained column (convert ToUser → StarredRepos,
    // modules/structs/user.go:60; models/user/user.go:155), not a live count:
    // the star/unstar batches bump it beside the edge (services/stars.ts,
    // star.go:48/62), as does the block cascade (services/blocks.ts).
    starred_repos_count: row.numStars,
  };
}

/**
 * Upstream `Repository.id` is int64; the D1 registry keys repositories with
 * text ids. Numeric text ids pass through; anything else renders the
 * documented 0. TODO(SPEC-0005): settle the id format with the registry
 * owner.
 */
function repositoryIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * The async arms of the converter, resolved by `toApiRepositoryFull` and
 * folded in by `toApiRepository`'s optional `relations` parameter. Both are
 * null-safe: an absent/unreadable base and a missing mirror row simply omit
 * / zero-default, exactly like upstream's nil `parent` and zero mirror
 * times.
 */
export interface RepositoryRenderRelations {
  /** The fork base's RENDERED payload — already permission-gated by
   * `resolveParentRepository` (do not pass an ungated pair). */
  parent?: Repository | null;
  /** The repo's 1:1 `repo_mirrors` row (`findMirrorByRepoId`), feeding the
   * mirror_interval/mirror_updated/mirror_last_sync_at triple. */
  mirrorRow?: RepoMirrorRow | null;
}

/**
 * Upstream `innerToRepo`'s parent arm
 * (gitea/services/convert/repository.go:46-57): `GetBaseRepo` loads the
 * fork base by `repo.ForkID` UNCONDITIONALLY (models/repo/repo.go:541-552 —
 * the only gate is base-row existence, no permission check) and renders it
 * through the `isParent=true` recursion (repository.go:57), which never
 * nests a grandparent. Upstream's own FIXME concedes the handling is wrong
 * — the parent embeds the CURRENT repo's permission (:52-56, "Maybe the
 * right way is setting the permission of the parent repo to nil, empty is
 * better than wrong") — and a base that goes private after forking leaks
 * through every fork payload.
 *
 * This resolver is the "empty is better than wrong" reading: the base
 * renders only when the doer can READ it — the landed visibility helpers
 * (`viewerTeamAccessMode` + `canViewRepository` resolved on the BASE row,
 * so an org-team grant on the base admits the parent too). A reader gets
 * the full base payload (its own `parent` stays omitted — the isParent
 * shape, plus the base's honest permission block instead of upstream's
 * current-repo one); a stranger on a private base gets the field omitted.
 * A dangling edge (deleted base the cascade missed) also degrades to
 * omitted, where upstream would nil the WHOLE payload
 * (repository.go:47-50). null = omit.
 */
export async function resolveParentRepository(
  d1: D1Database,
  viewer: Viewer,
  row: Pick<RepositoryRow, "forkParent">,
): Promise<Repository | null> {
  if (row.forkParent === null) {
    return null;
  }
  const base = await findRepositoryById(d1, row.forkParent);
  if (base === null) {
    return null;
  }
  const baseTeamMode = await viewerTeamAccessMode(d1, viewer, base.repo);
  if (!canViewRepository(viewer, base.repo, baseTeamMode)) {
    return null;
  }
  // The isParent recursion: render the base WITHOUT its own parent arm
  // (toApiRepository only nests when handed relations).
  return toApiRepository(viewer, base, undefined, baseTeamMode);
}

/**
 * The repo's 1:1 pull-mirror row (upstream `GetMirrorByRepoID`,
 * models/repo/mirror.go:80-88 — the UNIQUE `repo_id` is the ≤1 assumption).
 */
export async function findMirrorByRepoId(
  d1: D1Database,
  repoId: string,
): Promise<RepoMirrorRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(repoMirrors)
    .where(eq(repoMirrors.repoId, repoId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `toApiRepository` with both async arms resolved (upstream `innerToRepo`'s
 * GetBaseRepo + GetMirrorByRepoID passes): a fork renders `fork: true` plus
 * the `parent` payload when the doer can read the base (omitted otherwise),
 * and a mirror renders the real mirror_interval/mirror_updated/
 * mirror_last_sync_at from its repo_mirrors row. The single-repo GETs
 * (routes/repo.ts repoGet / repoGetByID) are the callers that SHOULD use
 * this — the wiring is the route owner's one-line swap from
 * `toApiRepository` (this module does not own the routes); until then the
 * routes render the sync shape (booleans honest, `parent`/schedule at the
 * zero-defaults). List/search paths keep the query-flat sync render
 * (booleans still honest, schedule fields at the zero-defaults — see
 * `toApiRepository`'s docstring). `mirrorRow` is only
 * read when `row.isMirror` (upstream gates the read on IsMirror too,
 * repository.go:160-170).
 */
export async function toApiRepositoryFull(
  d1: D1Database,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  settings?: RepoSettings,
  teamMode?: TeamAccessMode | null,
): Promise<Repository> {
  const [parent, mirrorRow] = await Promise.all([
    resolveParentRepository(d1, viewer, pair.repo),
    pair.repo.isMirror ? findMirrorByRepoId(d1, pair.repo.id) : Promise.resolve(null),
  ]);
  return toApiRepository(viewer, pair, settings, teamMode, { parent, mirrorRow });
}

/**
 * D1 → wire converter mirroring `convert.innerToRepo` for a stock repository
 * with upstream's default unit configuration (code/issues/pulls/wiki/releases
 * enabled; projects/packages/actions disabled — upstream `DefaultUnits`).
 * The fork/mirror booleans render the landed columns (`fork_parent` /
 * `is_mirror` — upstream `Fork: repo.IsFork` / `Mirror: repo.IsMirror`,
 * services/convert/repository.go:208/210; our single nullable `fork_parent`
 * column encodes both `IsFork` and `ForkID`, models/repo/repo.go:198-199).
 * The upstream-`omitempty` reference fields that stay nil for our data
 * (`external_tracker`, `external_wiki`, `repo_transfer`) and
 * `default_target_branch` (empty string) are omitted, exactly like Go;
 * `parent` renders only when the caller resolved a READABLE fork base
 * (`resolveParentRepository` below — upstream renders it whenever
 * `GetBaseRepo` loads the row, repository.go:46-57, with no permission
 * check; ours gates, see there).
 *
 * `settings` overlays the repo-edit stored subset (services/repo-settings.ts
 * — description/website/has_*) when the caller loaded it; list/search paths
 * keep the upstream defaults (the settings row is the not-yet-swept column
 * store, same discipline as the TODO(SPEC-0005) zero-defaults below).
 * `teamMode` (optional, `doerRepoAccessMode`) feeds the embedded
 * `permissions` block — the sync converters without it render the reduced
 * matrix. `relations` (optional) carries the async arms the single-repo
 * resolver (`toApiRepositoryFull`) resolved: the rendered readable fork
 * base and the 1:1 `repo_mirrors` row. Without it the mirror booleans are
 * still honest (pure columns) but the mirror schedule fields render the
 * upstream zero-defaults (`""` / Go-zero time) — the documented list-shape
 * divergence (upstream runs the same arms on list entries; ours resolves
 * them only for single-repo GETs to keep the lists query-flat).
 */
export function toApiRepository(
  viewer: Viewer,
  pair: RepositoryWithOwner,
  settings?: RepoSettings,
  teamMode?: TeamAccessMode | null,
  relations?: RepositoryRenderRelations,
): Repository {
  const { repo: row, owner } = pair;
  const ownerNamespace = encodeURIComponent(row.ownerNamespace);
  const slug = encodeURIComponent(row.slug);
  const htmlUrl = `${viewer.origin}/${ownerNamespace}/${slug}`;
  const apiUrl = `${viewer.origin}/api/v1/repos/${ownerNamespace}/${slug}`;
  const sshHost = new URL(viewer.origin).hostname;
  const createdIso = row.createdAt.toISOString();
  // The async arms (`toApiRepositoryFull`): the pre-gated fork-base payload
  // and the 1:1 pull-mirror row. `parent` is Go-omitempty — a null/unreadable
  // base omits the field entirely (upstream `Parent: parent`, :209, nil when
  // the base is missing).
  const parent = relations?.parent ?? null;
  const mirrorRow = relations?.mirrorRow ?? null;
  return {
    id: repositoryIdNumber(row.id),
    owner: apiUserFromRow(owner, viewer),
    name: row.slug,
    full_name: `${row.ownerNamespace}/${row.slug}`,
    description: settings?.description ?? "", // TODO(SPEC-0005): description column (repo_settings until the sweep)
    // Upstream `IsEmpty` — the dedicated D1 column (SPEC-0003 §3.1) that both
    // real transitions flip: the push-create settle (git-http/gate.ts §2.5.2)
    // and the import settle (repos/imports/service.ts settleDone). D1's
    // refs_version is observability-only — deliberately never synced from the
    // engine (gate.ts §2.5.2) — so it cannot proxy "has content": an imported
    // repo keeps refs_version 0 while holding a full history.
    empty: row.isEmpty,
    private: row.visibility === "private",
    // Upstream `Fork: repo.IsFork` (convert/repository.go:208; models/repo/
    // repo.go:198). Our fork edge is the single nullable `fork_parent` column
    // (IsFork + ForkID folded together, schema.ts) — set by the fork settle
    // (repos/fork-task.ts settleForkRow), cleared by the delete cascade's
    // child reset (repos/service.ts), so non-null IS a fork.
    fork: row.forkParent !== null,
    ...(parent !== null ? { parent } : {}),
    template: row.isTemplate, // is_template (migration 0027) — templates + generate (routes/generate-repo.ts)
    // Upstream `Mirror: repo.IsMirror` (convert/repository.go:210;
    // models/repo/repo.go:189) — the pure `is_mirror` column.
    mirror: row.isMirror,
    // Upstream renders `Size: int(repo.Size / 1024)` (convert/repository.go:207
    // — Go integer division = the KB integer). Upstream's stored Size folds
    // LFS in (models/repo/update.go:110 `Size: gitSize + lfsSize`); ours is
    // the GIT footprint only — upstream CalRepositorySize's scope
    // (modules/git/size.go:15-39, the git-dir walk) mapped onto the repo's R2
    // `repos/<storage_key>/` prefix and settled into the column by
    // services/repo-size.ts at upstream's recompute points (push/fork/
    // generate). 0 = empty repo; the column backfills 0 until the next
    // settle leg.
    size: row.sizeKb,
    language: "", // TODO(SPEC-0005): engine language statistics
    languages_url: `${apiUrl}/languages`,
    html_url: htmlUrl,
    url: apiUrl,
    // Upstream never assigns api.Repository.Link (repo.go:77) — the wire
    // value is the empty string; kept faithful instead of "fixing" it.
    link: "",
    ssh_url: `git@${sshHost}:${ownerNamespace}/${slug}.git`,
    clone_url: `${htmlUrl}.git`,
    original_url: "",
    website: settings?.website ?? "", // TODO(SPEC-0005): website column (repo_settings until the sweep)
    // Upstream renders the maintained columns, not live counts:
    // convert/repository.go:219-221 — `Stars: repo.NumStars` / `Forks:
    // repo.NumForks` / `Watchers: repo.NumWatches` (models/repo/repo.go:
    // 168/169/167). The columns are kept in the same D1 batch as the
    // star/watch edge writes (upstream star.go:45/59, watch.go:153;
    // services/stars.ts + services/repo-watchers.ts) and by the block
    // cascade (services/blocks.ts); num_forks is bumped at the fork settle
    // (repos/fork-task.ts settleForkRow — upstream fork.go:110-113).
    stars_count: row.numStars,
    forks_count: row.numForks,
    watchers_count: row.numWatches,
    branch_count: 0, // TODO(SPEC-0001/0005): engine refs snapshot count
    // SPEC-0005 §3.2 maintained counters (updated by the issue/PR services).
    open_issues_count: row.numIssues,
    open_pr_counter: row.numPulls,
    release_counter: 0, // TODO(SPEC-0005): releases table
    default_branch: row.defaultBranch,
    created_at: createdIso,
    updated_at: createdIso, // TODO(SPEC-0005): updated_unix column (starts == created)
    archived: row.isArchived,
    archived_at: GO_ZERO_TIME,
    permissions: repositoryPermissions(viewer, row, teamMode),
    has_code: true,
    has_issues: settings?.hasIssues ?? true,
    internal_tracker: {
      enable_time_tracker: true,
      allow_only_contributors_to_track_time: true,
      enable_issue_dependencies: true,
    },
    has_wiki: settings?.hasWiki ?? true,
    has_pull_requests: settings?.hasPullRequests ?? true,
    has_projects: settings?.hasProjects ?? false,
    projects_mode: "all",
    has_releases: settings?.hasReleases ?? true,
    has_packages: settings?.hasPackages ?? false,
    has_actions: settings?.hasActions ?? false,
    ignore_whitespace_conflicts: false,
    // PR-unit defaults from upstream DefaultPullRequestsConfig + ToRepo.
    allow_merge_commits: true,
    allow_rebase: true,
    allow_rebase_explicit: true,
    allow_squash_merge: true,
    allow_fast_forward_only_merge: true,
    allow_merge_update: true,
    allow_rebase_update: true,
    allow_manual_merge: true,
    autodetect_manual_merge: false,
    default_delete_branch_after_merge: false,
    default_merge_style: DEFAULT_MERGE_STYLE,
    default_update_style: DEFAULT_UPDATE_STYLE,
    squash_merge_commit_message: DEFAULT_SQUASH_MERGE_MESSAGE,
    default_allow_maintainer_edit: true,
    avatar_url: "",
    internal: false,
    // The mirror schedule triple upstream gates on BOTH arms
    // (convert/repository.go:161-170): only `if repo.IsMirror` AND a
    // `GetMirrorByRepoID` row exists do the real values render, else the
    // zero-defaults (`""` / Go-zero). Mapping onto repo_mirrors
    // (SPEC-0009 §3.1): `Interval time.Duration` (mirror.go:27) →
    // `interval_seconds` through the whole-second Go-duration renderer
    // ("8h0m0s"); `UpdatedUnix` (mirror.go:30, bumped on every schedule
    // update) → `updated_at`; `LastSyncUnix` (mirror.go:32, null until the
    // first successful sync) → `last_sync_at`. Without the resolved row the
    // zero-defaults stand (every non-mirror, mirrors before their first
    // touch, and the query-flat list paths).
    mirror_interval:
      mirrorRow !== null ? renderGoDuration(mirrorRow.intervalSeconds) : "",
    mirror_updated:
      mirrorRow !== null ? mirrorRow.updatedAt.toISOString() : GO_ZERO_TIME,
    mirror_last_sync_at:
      mirrorRow !== null && mirrorRow.lastSyncAt !== null
        ? new Date(mirrorRow.lastSyncAt * 1000).toISOString()
        : GO_ZERO_TIME,
    topics: [], // TODO(SPEC-0005): topics table
    licenses: [], // TODO(SPEC-0005): licenses detection
    object_format_name: "sha1",
  };
}

// ---------------------------------------------------------------------------
// D1 reads (Drizzle ORM only)
// ---------------------------------------------------------------------------

function repositoryWithOwnerQuery(d1: D1Database) {
  return drizzle(d1)
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace));
}

/** `/repos/{owner}/{repo}` — case-insensitive owner + exact slug. */
export async function findRepositoryByPath(
  d1: D1Database,
  owner: string,
  slug: string,
): Promise<RepositoryWithOwner | null> {
  const rows = await repositoryWithOwnerQuery(d1)
    .where(and(eq(repositories.ownerNamespace, owner.toLowerCase()), eq(repositories.slug, slug)))
    .limit(1);
  return rows[0] ?? null;
}

/** `/repositories/{id}` — the registry's text id, verbatim. */
export async function findRepositoryById(d1: D1Database, id: string): Promise<RepositoryWithOwner | null> {
  const rows = await repositoryWithOwnerQuery(d1).where(eq(repositories.id, id)).limit(1);
  return rows[0] ?? null;
}

/** User row by (case-insensitive) username, or null. */
export async function findUserByName(d1: D1Database, username: string): Promise<UserRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.usernameLower, username.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

function findUserById(d1: D1Database, id: number): Promise<UserRow | null> {
  return drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

// ---------------------------------------------------------------------------
// Go-style form parsing (gitea services/context/base_form.go)
// ---------------------------------------------------------------------------

/** `FormString` — first raw value, "" when absent. */
export function formString(params: URLSearchParams, key: string): string {
  return params.get(key) ?? "";
}

/** `FormTrim` — first value, space-trimmed, "" when absent. */
export function formTrim(params: URLSearchParams, key: string): string {
  return formString(params, key).trim();
}

/** `FormInt64` — strconv.ParseInt, 0 on absence/garbage. */
export function formInt64(params: URLSearchParams, key: string): number {
  const raw = formString(params, key);
  if (!/^-?\d+$/.test(raw)) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** `FormBool` value rule — ParseBool plus "on": true for 1/t/T/true/TRUE/True/on. */
export function formBoolValue(raw: string): boolean {
  return ["1", "t", "T", "true", "TRUE", "True", "on", "ON", "On"].includes(raw);
}

/** `FormBool` — first value through the FormBool value rule, false when absent. */
export function formBool(params: URLSearchParams, key: string): boolean {
  return formBoolValue(formString(params, key));
}

// ---------------------------------------------------------------------------
// Repository listing / search
// ---------------------------------------------------------------------------

export interface RepositoryListOptions {
  /** Effective (already clamped) pagination. */
  page: number;
  limit: number;
}

/**
 * Sort/order validation mirroring upstream `ResolveSortOrder` +
 * `repo_model.OrderByMap` (routers/api/v1/utils/sort.go): order is validated
 * only when `sort` is set, invalid values are 422s with Go-%q messages
 * (`JSON.stringify` matches %q for plain words). Sorts backed by columns the
 * D1 registry does not have yet (`updated`, `size`, `git_size`, `lfs_size`,
 * `stars`, `forks`) resolve to id order — every value is equal-zero, so this
 * mirrors the upstream ordering on empty data. TODO(SPEC-0005): real columns.
 */
export function repositoryOrderBy(sort: string, order: string): SQL[] {
  if (sort === "") {
    // Upstream default: db.SearchOrderByAlphabetically ("name ASC").
    return [asc(repositories.slug)];
  }
  const direction = order === "" ? "asc" : order;
  if (direction !== "asc" && direction !== "desc") {
    throw new ApiError(422, `Invalid sort order: ${JSON.stringify(direction)}`);
  }
  const ascending = direction === "asc";
  switch (sort) {
    case "alpha":
      // "owner_name ASC|DESC, name ASC|DESC"
      return [
        ascending ? asc(repositories.ownerNamespace) : desc(repositories.ownerNamespace),
        ascending ? asc(repositories.slug) : desc(repositories.slug),
      ];
    case "created":
      return [ascending ? asc(repositories.createdAt) : desc(repositories.createdAt)];
    case "id":
      return [ascending ? asc(castIdNumber()) : desc(castIdNumber())];
    case "updated":
    case "size":
    case "git_size":
    case "lfs_size":
    case "stars":
    case "forks":
      // No D1 column yet: all keys equal-zero → deterministic id order.
      return [ascending ? asc(castIdNumber()) : desc(castIdNumber())];
    default:
      throw new ApiError(422, `Invalid sort mode: ${JSON.stringify(sort)}`);
  }
}

/** Upstream orders by the int64 id; our text id sorts numerically via CAST. */
function castIdNumber(): SQL {
  return sql`CAST(${repositories.id} AS INTEGER)`;
}

/**
 * WHERE conditions shared by the list routes: what the requester may see.
 * `includePrivate` false (anonymous or `private=false`) → public only;
 * otherwise public plus the requester's own private repositories plus the
 * org repos a team grant covers (SPEC-0007 §3.5 — the SQL twin of
 * `doerRepoAccessMode !== 'none'`), and admins see all. TODO(SPEC-0005):
 * collaborator visibility (the row-level seam resolves it; the list WHERE
 * does not yet).
 */
function visibilityConditions(viewer: Viewer, includePrivate: boolean): SQL[] {
  if (!includePrivate || viewer.requester === null) {
    return [eq(repositories.visibility, "public")];
  }
  if (viewer.requester.is_admin === true) {
    return [];
  }
  const teamArm = viewer.requester.id === undefined ? [] : [teamGrantCondition(viewer.requester.id)];
  return [
    or(
      eq(repositories.visibility, "public"),
      eq(repositories.ownerNamespace, requesterLoginLower(viewer) ?? ""),
      ...teamArm,
    ) as SQL,
  ];
}

/**
 * The list-side team-grant EXISTS — a repo passes when a team of the org
 * owning it has the requester among its `team_members` AND covers the repo
 * (`includes_all_repositories` or a `team_repo_access` row) AND its
 * EFFECTIVE mode is not 'none' (`max(authorize, units_map values)` — the
 * same units collapse `OrgService.teamRepoAccessMode` computes row-wise, so
 * the list never shows a repo the per-repo seam would 404, and never hides
 * one it admits). `json_each(NULL)` yields no rows, so plain-permission
 * teams (units_map null) fall through to the `authorize` arm.
 */
function teamGrantCondition(userId: number): SQL {
  return sql`EXISTS (
    SELECT 1 FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE t.org_id = ${repositories.ownerId}
      AND tm.user_id = ${userId}
      AND (
        t.authorize <> 'none'
        OR EXISTS (
          SELECT 1 FROM json_each(t.units_map) ju
          WHERE ju.value IN ('read', 'write', 'admin', 'owner')
        )
      )
      AND (
        t.includes_all_repositories = 1
        OR EXISTS (
          SELECT 1 FROM team_repo_access tra
          WHERE tra.team_id = t.id AND tra.repo_id = ${repositories.id}
        )
      )
  )`;
}

export interface RepoSearchOptions extends RepositoryListOptions {  keyword: string;
  topicOnly: boolean;
  includeDesc: boolean;
  uid: number;
  exclusive: boolean;
  priorityOwnerId: number;
  teamId: number;
  starredBy: number;
  /** Upstream `private` resolved against the requester (`ctx.IsSigned && …`). */
  includePrivate: boolean;
  /** `is_private` tri-state filter; null = all. */
  isPrivate: boolean | null;
  /** `template` / `archived` tri-state filters; null = all. */
  template: boolean | null;
  archived: boolean | null;
  mode: "fork" | "source" | "mirror" | "collaborative" | "";
  sort: string;
  /** Raw `order` value; "" defaults to asc, invalid values 422 in repositoryOrderBy. */
  order: string;
}

/**
 * `/repos/search` mirroring `repo_model.SearchRepositoryCondition` on the
 * D1-only registry. Documented divergences (columns/tables that do not exist
 * yet — all TODO(SPEC-0005)):
 *  - `includeDesc`: no description column — keyword matches name only.
 *  - `topic=true`: no topics table — keyword never matches, results empty.
 *  - `starredBy`: no stars table — always empty.
 *  - `team_id`: no teams — always empty.
 *  - `mode`: fork/mirror/source filter the landed columns (upstream
 *    repo.go:163-176 → repo_list.go:500-513): `fork` ≡ `is_fork` (our
 *    `fork_parent IS NOT NULL`), `mirror` ≡ `is_mirror`, `source` ≡ neither.
 *    `collaborative` (`is_mirror=false` + the collaborator edge upstream)
 *    still matches nothing — no collaborator edges (TODO below).
 *  - `template`/`archived`: no columns — `true` matches nothing, `false` all.
 *  - `priority_owner_id`: implemented as a CASE-WHEN ordering prefix.
 */
export async function searchRepositories(
  d1: D1Database,
  viewer: Viewer,
  opts: RepoSearchOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const conditions: SQL[] = visibilityConditions(viewer, opts.includePrivate);

  if (opts.isPrivate !== null) {
    conditions.push(eq(repositories.visibility, opts.isPrivate ? "private" : "public"));
  }
  // No template/archived rows exist: `true` matches nothing, `false` is all.
  const noMatch = sql`0 = 1`;
  if (opts.template === true) {
    conditions.push(noMatch);
  }
  if (opts.archived === true) {
    conditions.push(noMatch);
  }
  switch (opts.mode) {
    case "fork":
      // Upstream: `is_fork = true` (repo_list.go:500-513 via opts.Fork);
      // our fork edge is the single nullable column.
      conditions.push(isNotNull(repositories.forkParent));
      break;
    case "mirror":
      // `is_mirror = true`.
      conditions.push(eq(repositories.isMirror, true));
      break;
    case "source":
      // `is_fork = false AND is_mirror = false` (repo.go:165-167).
      conditions.push(
        and(isNull(repositories.forkParent), eq(repositories.isMirror, false)) as SQL,
      );
      break;
    case "collaborative":
      // Upstream: is_mirror=false AND Collaborate=true (repo.go:172-174) —
      // the collaborator edge the list WHERE does not model yet.
      conditions.push(noMatch);
      break;
    case "":
      break;
  }
  if (opts.starredBy > 0) {
    conditions.push(noMatch); // TODO(SPEC-0005): stars table
  }
  if (opts.teamId > 0) {
    conditions.push(noMatch); // TODO(SPEC-0005): teams
  }
  if (opts.uid > 0) {
    // Ownership is the only "owns or contributes to" edge that exists.
    const uidUser = await findUserById(d1, opts.uid);
    conditions.push(uidUser === null ? noMatch : eq(repositories.ownerNamespace, uidUser.usernameLower));
  }
  if (opts.topicOnly) {
    conditions.push(noMatch); // TODO(SPEC-0005): topics table
  } else if (opts.keyword !== "") {
    // Comma-separated keywords, case-insensitive substring match on the repo
    // name; "owner/repo" (exactly one slash) also matches owner+name pairs.
    // SQLite LIKE is case-insensitive for ASCII, matching upstream's
    // lower_name LIKE. TODO(SPEC-0005): description column for includeDesc.
    const keywordConditions: SQL[] = [];
    for (const part of opts.keyword.split(",")) {
      const needle = `%${part.toLowerCase()}%`;
      keywordConditions.push(like(repositories.slug, needle));
      const slash = part.indexOf("/");
      if (slash > 0 && part.indexOf("/", slash + 1) === -1) {
        keywordConditions.push(
          and(
            like(repositories.ownerNamespace, `%${part.slice(0, slash).toLowerCase()}%`),
            like(repositories.slug, `%${part.slice(slash + 1).toLowerCase()}%`),
          ) as SQL,
        );
      }
    }
    conditions.push(or(...keywordConditions) as SQL);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const db = drizzle(d1);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(repositories)
    .where(where);
  const total = Number(totalRows[0]?.value ?? 0);

  const orderBy: SQL[] = repositoryOrderBy(opts.sort, opts.order);
  if (opts.priorityOwnerId > 0) {
    // Upstream: "CASE WHEN owner_id = ? THEN 0 ELSE owner_id END, <order>".
    const priorityUser = await findUserById(d1, opts.priorityOwnerId);
    if (priorityUser !== null) {
      orderBy.unshift(
        sql`(CASE WHEN ${repositories.ownerNamespace} = ${priorityUser.usernameLower} THEN 0 ELSE 1 END)`,
      );
    }
  }

  const items = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(...orderBy)
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);

  return { items, total };
}

/**
 * `/users/{username}/repos` (`GetUserRepositories`, "id ASC"): public
 * repositories of the user, or all of them when the viewer is the user
 * themself or a site admin.
 */
export async function listUserRepositories(
  d1: D1Database,
  ownerLower: string,
  viewer: Viewer,
  opts: RepositoryListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const includePrivate =
    viewer.requester !== null &&
    (viewer.requester.is_admin === true || requesterLoginLower(viewer) === ownerLower);
  const where = and(
    eq(repositories.ownerNamespace, ownerLower),
    ...visibilityConditions(viewer, includePrivate),
  );
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(repositories).where(where);
  const items = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    // Upstream GetUserRepositories orders "id ASC" (int64); our text id sorts
    // numerically via CAST.
    .orderBy(asc(castIdNumber()))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

/**
 * `/user/repos` (`ListMyRepos`): everything the authenticated user owns,
 * including private (`SearchRepoOptions{OwnerID: doer, Private: true}`,
 * default "name ASC" ordering). The identity comes from the auth middleware;
 * a token user without a D1 row owns nothing (empty list).
 */
export async function listOwnedRepositories(
  d1: D1Database,
  viewer: Viewer,
  opts: RepositoryListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  if (viewer.requester === null) {
    return { items: [], total: 0 };
  }
  const where = eq(repositories.ownerNamespace, requesterLoginLower(viewer) ?? "");
  const db = drizzle(d1);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(repositories).where(where);
  const items = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(asc(repositories.slug))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}
