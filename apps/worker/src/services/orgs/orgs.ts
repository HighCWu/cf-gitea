/**
 * Organization service — SPEC-0007 (M2): org-as-user-row storage, membership,
 * the repo-create grant, rename + namespace redirects, visibility.
 *
 * Raw D1 access per the LFS-SVC pattern (src/services/lfs/state.ts): the org
 * tables are NOT yet in the Drizzle schema (schema.ts is owned by another
 * change), so D1 access goes through thin mappers over raw `D1Database`
 * prepared statements, with the DDL below. TODO(drizzle migration): port
 * `ORG_DDL_STATEMENTS` into `src/db/schema.ts` (a `type` column + org profile
 * columns on `users`, an `orgMembers` table, a `userRedirects` table) and run
 * `pnpm db:generate`; delete `applyOrgsDdl` and the test-side DDL bootstrap
 * once the generated migration exists. Until then tests create the schema
 * from this constant (schema applied in `beforeAll` persists per file).
 * The same TODO covers the two raw reads of tables that DO exist in the
 * landed schema (`users`, `repositories`): the migration owner should switch
 * those statements to Drizzle too so the module stops hand-writing SQL.
 *
 * Storage decision (SPEC-0007 §3.1): organizations are `users` rows with
 * `type='org'` — upstream's own trick (`Organization` is a `user_model.User`
 * alias whose `TableName()` is "user", gitea/models/organization/org.go:76–87).
 * Usernames and org slugs share `UNIQUE(users.username_lower)`; owner lookups
 * (SPEC-0003 §2.1 step 4) stay one type-blind indexed read.
 *
 * Timestamps are unix seconds (repo convention). Booleans are 0/1. The
 * org-scoped queries all carry the `type='org'`/`role='owner'` filters that
 * mirror upstream `GetOrgByName` (org.go:400–413) and the Owners-team
 * collapse (§3.3–3.4).
 */

import {
  LastOrgOwnerError,
  MAX_ORG_NAME_LENGTH,
  OrgMemberUserNotExistError,
  OrgNameCharsInvalidError,
  OrgNameCollisionError,
  OrgNamePatternNotAllowedError,
  OrgNameReservedError,
  OrgNameTooLongError,
  OrgNotExistError,
  type OrgError,
} from "./errors";

/**
 * The future Drizzle migration body (SPEC-0007 §3.2–3.4, §3.6). Kept here as
 * the single source of truth until schema.ts can own the tables (see the
 * module TODO).
 *
 * `users` is ALTERed, not recreated: the landed table (migrations 0001/0003)
 * already carries `id, username, username_lower, email, display_name,
 * is_admin, status, visibility, created_at`. Deviation from SPEC-0007 §3.2
 * recorded: `visibility` is the landed TEXT enum ('public'|'limited'|
 * 'private'), NOT the INTEGER ladder sketched in the SPEC — the service
 * expresses the listing ceiling as an IN-list instead of a range compare.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`; the ALTERs run exactly once per
 * database (the test bootstrap relies on per-file storage isolation).
 */
export const ORG_DDL_STATEMENTS: readonly string[] = [
  // --- users amendments (SPEC-0007 §3.2) -------------------------------------
  // Upstream UserType 0/1 (gitea/models/user/user.go:48–67); reserved
  // variants (2–5) have no cf-gitea equivalent yet.
  `ALTER TABLE users ADD COLUMN type TEXT NOT NULL DEFAULT 'user'`,
  // Type-aware partial index keeps org lookups and user listings cheap.
  `CREATE INDEX IF NOT EXISTS users_type_idx ON users (type)`,
  // Org/user profile columns (upstream user.go:99–165; null for unused
  // profile fields). `avatar_email` is the AvatarEmail hash input; no
  // identicon is generated at create (SPEC-0007 §4.6 divergence).
  `ALTER TABLE users ADD COLUMN full_name TEXT`,
  `ALTER TABLE users ADD COLUMN description TEXT`,
  `ALTER TABLE users ADD COLUMN website TEXT`,
  `ALTER TABLE users ADD COLUMN location TEXT`,
  `ALTER TABLE users ADD COLUMN avatar_email TEXT`,
  `ALTER TABLE users ADD COLUMN use_custom_avatar INTEGER NOT NULL DEFAULT 0`,
  // Maintained member counter (upstream NumMembers, org.go:330–331/537).
  `ALTER TABLE users ADD COLUMN num_members INTEGER NOT NULL DEFAULT 0`,
  // Org-only flag, honored when teams land (upstream user.go:165); stored
  // now so the tier-2 PATCH /orgs/{org} body has a home.
  `ALTER TABLE users ADD COLUMN repo_admin_change_team_access INTEGER NOT NULL DEFAULT 0`,
  // --- org_members (SPEC-0007 §3.3) -------------------------------------------
  // Upstream OrgUser is exactly {ID, UID, OrgID, IsPublic} at the pin
  // (org_user.go:26–31) plus our Owners-team collapse into `role`
  // ('owner' ⟺ membership in the upstream synthetic Owners team at tier 1).
  `CREATE TABLE IF NOT EXISTS org_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_user_uq ON org_members (org_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members (user_id)`,
  // --- user_redirects (SPEC-0007 §3.6) ----------------------------------------
  // Port of upstream `user_redirect` (models/user/redirect.go:33–46). The
  // namespace-wide alias table for user AND org renames — distinct from
  // SPEC-0003's `repo_redirects` (keyed (owner_id, lower_name)); owner
  // renames write here, repo renames there.
  `CREATE TABLE IF NOT EXISTS user_redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lower_name TEXT NOT NULL,
  redirect_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_redirects_lower_uq ON user_redirects (lower_name)`,
];

// ---------------------------------------------------------------------------
// Name rules — port of upstream IsUsableUsername (user.go:622–666) + the
// validity patterns (modules/validation/helpers.go:36–39)
// ---------------------------------------------------------------------------

/** Upstream `validUsernamePattern` (`^[\da-zA-Z][-.\w]*$`). */
const VALID_USERNAME = /^[\da-zA-Z][-.\w]*$/;
/** Upstream `invalidUsernamePattern` — no consecutive or trailing `-._`. */
const INVALID_USERNAME = /[-._]{2,}|[-._]$/;

/**
 * Upstream `reservedUsernames` (user.go:622–660), verbatim. Load-bearing
 * (§4.1): an org named `org` or `invite` breaks upstream routing, so the
 * list is ported whole, not trimmed. Supersedes the reduced repos-side
 * `isReservedOwnerName` ({assets, api}) for the org create path — the union
 * still contains both.
 */
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  ".",
  "..",
  ".well-known",
  "api",
  "metrics",
  "v2",
  "assets",
  "attachments",
  "avatar",
  "avatars",
  "repo-avatars",
  "captcha",
  "login",
  "org",
  "repo",
  "user",
  "explore",
  "issues",
  "pulls",
  "milestones",
  "notifications",
  "favicon.ico",
  "manifest.json",
  "robots.txt",
  "sitemap.xml",
  "ssh_info",
  "swagger.v1.json",
  "openapi3.v1.json",
  "ghost",
  "gitea-actions",
]);

/** Upstream `reservedUserPatterns` — `*`-prefix globs matched on suffixes. */
const RESERVED_USERNAME_SUFFIXES = [".keys", ".gpg", ".rss", ".atom", ".png"];

/**
 * Port of upstream `IsUsableUsername` (user.go:665–666 + db.IsUsableName,
 * models/db/name.go:78–96): returns the typed 422 error the API must map,
 * or null when the name is usable. Checks run case-folded like upstream.
 */
export function usableUsernameError(name: string): OrgError | null {
  if (!VALID_USERNAME.test(name) || INVALID_USERNAME.test(name)) {
    return new OrgNameCharsInvalidError(name);
  }
  const lower = name.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) return new OrgNameReservedError(lower);
  for (const suffix of RESERVED_USERNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) return new OrgNamePatternNotAllowedError(`*${suffix}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rows and options
// ---------------------------------------------------------------------------

export type Visibility = "public" | "limited" | "private";
export type OrgMemberRole = "owner" | "member";

/** The org projection of a `users` row (`type='org'`), §2.3: one storage row
 *  feeds both the API `User` and `Organization` models. */
export interface OrgRecord {
  id: number;
  username: string;
  usernameLower: string;
  email: string | null;
  fullName: string | null;
  description: string | null;
  website: string | null;
  location: string | null;
  avatarEmail: string | null;
  useCustomAvatar: boolean;
  visibility: Visibility;
  numMembers: number;
  repoAdminChangeTeamAccess: boolean;
  createdAt: Date;
}

export interface OrgMembershipRecord {
  id: number;
  orgId: number;
  userId: number;
  isPublic: boolean;
  role: OrgMemberRole;
  createdAt: Date;
}

/** Projected `repositories` row for org-repo listings (SPEC-0007 §2.2 row 2;
 *  the route batch projects the full 71-field Repository from this). */
export interface OrgRepoRow {
  id: string;
  storageKey: string;
  ownerNamespace: string;
  ownerId: number | null;
  slug: string;
  visibility: "public" | "private";
  defaultBranch: string;
  isEmpty: boolean;
  isArchived: boolean;
  status: "ready" | "creating" | "migrating" | "broken";
  createdAt: Date;
  updatedAt: Date | null;
}

export interface CreateOrgInput {
  /** Org slug; display case is preserved, lookups are case-folded. */
  name: string;
  /** Creating user — receives the `role='owner'` membership row in the same
   *  batch (upstream CreateOrganization inserts creator + Owners team, §2.1). */
  ownerId: number;
  visibility?: Visibility;
  fullName?: string | null;
  description?: string | null;
  website?: string | null;
  location?: string | null;
  email?: string | null;
  now?: Date;
}

export interface ListUserOrgsOptions {
  /**
   * Owner-visibility ceiling for the listed orgs — the caller's
   * `DoerViewOtherVisibility(doer, subject)` result (org_list.go:79–90):
   * anonymous/public-only-token ⇒ 'public', restricted ⇒ 'public',
   * regular non-self ⇒ 'limited', self/admin ⇒ 'private'. ALSO decides the
   * membership filter, exactly as upstream: non-public memberships are
   * listed only under a 'private' ceiling (self-list skips `is_public`,
   * org_list.go:57–63 via `queryUserOrgIDs(uid, IncludeVisibility ==
   * private)`). Default 'private' (no filtering — the tier-1
   * `GET /user/orgs` self-list shape).
   */
  maxVisibility?: Visibility;
  page?: number;
  pageSize?: number;
}

export interface ListPage<T> {
  items: T[];
  total: number;
}

/** Authenticated doer context for org-repo listings (§2.2 row 2). The
 *  public-only-token owner gate (`DoerTokenAllowsOwner`, api.go:660–663) is
 *  route middleware, not a service predicate. */
export interface ListOrgReposDoer {
  /** null = anonymous (§4.7: still 200 + public repos on limited/private orgs). */
  id: number | null;
  /** Site admins bypass the membership predicate (upstream admin bypass). */
  isAdmin?: boolean;
}

export interface ListOptions {
  page?: number;
  pageSize?: number;
}

/** Listings always paginate (SPEC-0004 §2.5 / SPEC-0007 §4.12). */
export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 50;

interface UserSqlRow {
  id: number;
  username: string;
  username_lower: string;
  email: string | null;
  full_name: string | null;
  description: string | null;
  website: string | null;
  location: string | null;
  avatar_email: string | null;
  use_custom_avatar: number;
  visibility: string;
  num_members: number;
  repo_admin_change_team_access: number;
  created_at: number;
  type: string;
}

interface MembershipSqlRow {
  id: number;
  org_id: number;
  user_id: number;
  is_public: number;
  role: string;
  created_at: number;
}

interface RepoSqlRow {
  id: string;
  storage_key: string;
  owner_namespace: string;
  owner_id: number | null;
  slug: string;
  visibility: string;
  default_branch: string;
  is_empty: number;
  is_archived: number;
  status: string;
  created_at: number;
  updated_at: number | null;
}

const ORG_COLUMNS = `id, username, username_lower, email, full_name, description, website, location, avatar_email, use_custom_avatar, visibility, num_members, repo_admin_change_team_access, created_at, type`;
/** Same list, qualified for the org_members ⨝ users join. */
const ORG_COLUMNS_U = ORG_COLUMNS.split(",")
  .map((column) => `u.${column.trim()}`)
  .join(", ");
const REPO_COLUMNS = `id, storage_key, owner_namespace, owner_id, slug, visibility, default_branch, is_empty, is_archived, status, created_at, updated_at`;

const toUnix = (date: Date): number => Math.floor(date.getTime() / 1000);
const fromUnix = (seconds: number): Date => new Date(seconds * 1000);

function clampPagination(options: ListOptions = {}): { limit: number; offset: number } {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

function rowToOrg(row: UserSqlRow): OrgRecord {
  return {
    id: row.id,
    username: row.username,
    usernameLower: row.username_lower,
    email: row.email,
    fullName: row.full_name,
    description: row.description,
    website: row.website,
    location: row.location,
    avatarEmail: row.avatar_email,
    useCustomAvatar: row.use_custom_avatar !== 0,
    visibility: row.visibility as Visibility,
    numMembers: row.num_members,
    repoAdminChangeTeamAccess: row.repo_admin_change_team_access !== 0,
    createdAt: fromUnix(row.created_at),
  };
}

function rowToMembership(row: MembershipSqlRow): OrgMembershipRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    isPublic: row.is_public !== 0,
    role: row.role === "owner" ? "owner" : "member",
    createdAt: fromUnix(row.created_at),
  };
}

function rowToRepo(row: RepoSqlRow): OrgRepoRow {
  return {
    id: row.id,
    storageKey: row.storage_key,
    ownerNamespace: row.owner_namespace,
    ownerId: row.owner_id,
    slug: row.slug,
    visibility: row.visibility === "private" ? "private" : "public",
    defaultBranch: row.default_branch,
    isEmpty: row.is_empty !== 0,
    isArchived: row.is_archived !== 0,
    status: row.status as OrgRepoRow["status"],
    createdAt: fromUnix(row.created_at),
    updatedAt: row.updated_at === null ? null : fromUnix(row.updated_at),
  };
}

/** D1 unique-violation probe — the §4.1 shared-namespace race arbiter (same
 *  cause-walk as src/repos/service.ts; drizzle wraps driver errors). */
function isUniqueViolation(error: unknown): boolean {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text.includes("UNIQUE constraint failed");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OrgService {
  constructor(private readonly d1: D1Database) {}

  /**
   * Create an org — the port of upstream `CreateOrganization`
   * (org.go:305–398) reduced to the tier-1 row shape: validate the name
   * (`IsUsableUsername` + the 40-char `CreateOrgOption` cap, §4.12), arbiter
   * the shared namespace on `UNIQUE(users.username_lower)` (§3.1: a username
   * and an org slug can never collide), then ONE D1 batch (= one SQLite
   * transaction): consume any `user_redirect` squatting on the name
   * (org.go:335–337), insert the `users` row (`type='org'`,
   * `num_members=1`), insert the creator's membership row
   * (`role='owner'`, `is_public=false` = upstream `DefaultOrgMemberVisible`,
   * org.go:347–353). No identicon/avatar generation (§4.6 divergence).
   *
   * Not enforced here (caller-level, upstream parity): the
   * `CanCreateOrganization` site-config gate and the admin bypass
   * (org.go:303; `ErrUserNotAllowedCreateOrg`) — tier 1 has no create API,
   * so the gate lands with the T2 route batch.
   */
  async createOrg(input: CreateOrgInput): Promise<OrgRecord> {
    if (input.name.length > MAX_ORG_NAME_LENGTH) throw new OrgNameTooLongError(input.name);
    const nameError = usableUsernameError(input.name);
    if (nameError !== null) throw nameError;

    const lower = input.name.toLowerCase();
    const now = input.now ?? new Date();
    const seconds = toUnix(now);

    // Shared-namespace pre-check (upstream IsUserExist is type-blind,
    // user.go:546–555); the UNIQUE index stays the race arbiter below.
    const existing = await this.d1
      .prepare("SELECT id FROM users WHERE username_lower = ?")
      .bind(lower)
      .first<{ id: number }>();
    if (existing !== null) throw new OrgNameCollisionError(input.name);

    try {
      await this.d1.batch([
        // CreateOrganization pre-deletes redirects at the name (org.go:335–337):
        // creating on a live redirect consumes it (§4.10).
        this.d1.prepare("DELETE FROM user_redirects WHERE lower_name = ?").bind(lower),
        this.d1.prepare(
          `INSERT INTO users (
             username, username_lower, email, display_name, is_admin, status, visibility,
             full_name, description, website, location, avatar_email,
             use_custom_avatar, num_members, repo_admin_change_team_access, type, created_at
           ) VALUES (?, ?, ?, NULL, 0, 'active', ?, ?, ?, ?, ?, NULL, 0, 1, 0, 'org', ?)`,
        ).bind(
          input.name,
          lower,
          input.email ?? null,
          input.visibility ?? "public",
          input.fullName ?? null,
          input.description ?? null,
          input.website ?? null,
          input.location ?? null,
          seconds,
        ),
        // The creator's membership row — upstream inserts OrgUser plus the
        // synthetic Owners team + TeamUser rows (org.go:347–395); tier 1
        // collapses those into role='owner' (§3.3).
        this.d1
          .prepare(
            `INSERT INTO org_members (org_id, user_id, is_public, role, created_at)
             VALUES ((SELECT id FROM users WHERE username_lower = ?), ?, 0, 'owner', ?)`,
          )
          .bind(lower, input.ownerId, seconds),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OrgNameCollisionError(input.name);
      throw error;
    }

    const org = await this.getOrgByUsername(lower);
    if (org === null) throw new OrgNotExistError({ name: lower }); // batch lost — rethrow as 404-shaped
    return org;
  }

  /**
   * Resolve an org by name — type-blind lookup by `username_lower` first
   * (mirroring SPEC-0003 §2.1 step 4 owner resolution / upstream
   * `GetUserByName`, user.go:1131–1134), THEN the `type='org'` check. Null
   * on a miss and on a plain user alike (§4.11: `GET /orgs/{alice}` is a
   * 404-shaped miss, never a user-shaped response). Case-insensitive.
   */
  async getOrgByUsername(name: string): Promise<OrgRecord | null> {
    const lower = name.toLowerCase();
    const row = await this.d1
      .prepare(`SELECT ${ORG_COLUMNS} FROM users WHERE username_lower = ?`)
      .bind(lower)
      .first<UserSqlRow>();
    if (row === null) return null;
    return this.assertOrgRow(row);
  }

  /** Org by id (the redirect-gate flow: `LookupUserRedirect` → id → row). */
  async getOrgById(id: number): Promise<OrgRecord | null> {
    const row = await this.d1
      .prepare(`SELECT ${ORG_COLUMNS} FROM users WHERE id = ?`)
      .bind(id)
      .first<UserSqlRow>();
    if (row === null) return null;
    return this.assertOrgRow(row);
  }

  /** §4.11 type gate shared by both lookups — non-org rows read as misses. */
  private assertOrgRow(row: UserSqlRow): OrgRecord | null {
    // Plain users (and rows predating the migration, which the DDL defaults
    // to 'user') fail the check exactly like upstream GetOrgByName's
    // `type = 1` predicate.
    return row.type === "org" ? rowToOrg(row) : null;
  }

  /**
   * `GET /user/orgs` shape (§2.2 row 1): the caller's memberships, orgs
   * ordered `lower_name ASC` (org_list.go:75–77), full `Organization`
   * projection rows. See `ListUserOrgsOptions` for the visibility +
   * membership-filter semantics (`is_public` is skipped only under a
   * 'private' ceiling — the self-list behavior, org_list.go:57–71).
   */
  async listUserOrgs(userId: number, options: ListUserOrgsOptions = {}): Promise<ListPage<OrgRecord>> {
    const { limit, offset } = clampPagination(options);
    const maxVisibility = options.maxVisibility ?? "private";

    const conds = ["m.user_id = ?", "u.type = 'org'"];
    const binds: (number | string)[] = [userId];
    if (maxVisibility !== "private") {
      // Landed TEXT encoding of the SPEC §3.2 INTEGER ladder: the ceiling is
      // a set membership, not a range compare.
      conds.push(
        maxVisibility === "public"
          ? `u.visibility = 'public'`
          : `u.visibility IN ('public', 'limited')`,
      );
    }
    // Upstream queryUserOrgIDs(uid, includePrivate = IncludeVisibility ==
    // private) — non-public memberships only surface to self/admin lists.
    if (maxVisibility !== "private") conds.push("m.is_public = 1");
    const where = conds.join(" AND ");

    const rows = await this.d1
      .prepare(
        `SELECT ${ORG_COLUMNS_U} FROM org_members m
         INNER JOIN users u ON u.id = m.org_id
         WHERE ${where}
         ORDER BY u.username_lower ASC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<UserSqlRow>();
    const totalRow = await this.d1
      .prepare(
        `SELECT COUNT(*) AS total FROM org_members m
         INNER JOIN users u ON u.id = m.org_id
         WHERE ${where}`,
      )
      .bind(...binds)
      .first<{ total: number }>();
    return {
      items: rows.results.map((row) => rowToOrg(row)),
      total: totalRow?.total ?? 0,
    };
  }

  /**
   * `GET /orgs/{org}/repos` shape (§2.2 row 2, §4.7): the org's repos with
   * **no owner-visibility filter** — the mirrored upstream quirk. An
   * anonymous caller receives the public repos of a limited or private org
   * (200-shaped), unlike `GET /orgs/{org}` (404s via `HasOrgOrUserVisible`)
   * and unlike git HTTP (401-challenges). Private rows are listed only when
   * the doer holds "any unit access" — at tier 1 exactly the org
   * `role='owner'` membership (§3.5) or a site admin; plain members see
   * public rows only, as upstream (no team ⇒ zero repo access).
   */
  async listOrgRepos(
    orgId: number,
    doer: ListOrgReposDoer,
    options: ListOptions = {},
  ): Promise<ListPage<OrgRepoRow>> {
    const { limit, offset } = clampPagination(options);

    const isOwner =
      doer.isAdmin === true ||
      (doer.id !== null &&
        (await this.d1
          .prepare("SELECT id FROM org_members WHERE org_id = ? AND user_id = ? AND role = 'owner'")
          .bind(orgId, doer.id)
          .first<{ id: number }>()) !== null);

    const where = isOwner ? "owner_id = ?" : "owner_id = ? AND visibility = 'public'";
    const rows = await this.d1
      .prepare(`SELECT ${REPO_COLUMNS} FROM repositories WHERE ${where} ORDER BY slug ASC LIMIT ? OFFSET ?`)
      .bind(orgId, limit, offset)
      .all<RepoSqlRow>();
    const totalRow = await this.d1
      .prepare(`SELECT COUNT(*) AS total FROM repositories WHERE ${where}`)
      .bind(orgId)
      .first<{ total: number }>();
    return {
      items: rows.results.map(rowToRepo),
      total: totalRow?.total ?? 0,
    };
  }

  /**
   * The SPEC-0003 row-19 grant (§3.4): at tier 1 `role='owner'` is *exactly
   * equivalent* to upstream's `CanCreateOrgRepo` EXISTS
   * (org_user.go:98–106, `can_create_org_repo OR authorize=owner` through
   * team_user) — a fresh org has one team (Owners, can_create_org_repo) and
   * no tier-1 path creates another. Both callers (POST /orgs/{org}/repos and
   * git push-create) share this predicate. Site-admin bypass is caller-level
   * (`prepareDoerCreateRepoInOrg`, fork.go:97–108), as upstream.
   */
  async canCreateOrgRepo(orgId: number, userId: number): Promise<boolean> {
    const row = await this.d1
      .prepare("SELECT id FROM org_members WHERE org_id = ? AND user_id = ? AND role = 'owner'")
      .bind(orgId, userId)
      .first<{ id: number }>();
    return row !== null;
  }

  /**
   * Add a member — port of upstream `AddOrgUser` (org.go:515–542): silently
   * idempotent (already a member ⇒ false, no counter change), else ONE batch
   * inserting the row and bumping `num_members` in the same transaction.
   * `isPublic` defaults false (`DefaultOrgMemberVisible`); it gates public
   * member listings only — it grants/denies NO repo access (§4.5). `role`
   * defaults 'member'; tier-1 APIs add plain members, ownership is granted
   * only at create (or via this primitive by the future T2 admin surface).
   */
  async addMember(
    orgId: number,
    userId: number,
    options: { role?: OrgMemberRole; isPublic?: boolean; now?: Date } = {},
  ): Promise<boolean> {
    const org = await this.getOrgById(orgId);
    if (org === null) throw new OrgNotExistError({ id: orgId });
    const user = await this.d1
      .prepare("SELECT username FROM users WHERE id = ?")
      .bind(userId)
      .first<{ username: string }>();
    if (user === null) throw new OrgMemberUserNotExistError({ id: userId });

    const existing = await this.findMembership(orgId, userId);
    if (existing !== null) return false;

    const seconds = toUnix(options.now ?? new Date());
    try {
      await this.d1.batch([
        this.d1
          .prepare(
            "INSERT INTO org_members (org_id, user_id, is_public, role, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(orgId, userId, options.isPublic === true ? 1 : 0, options.role ?? "member", seconds),
        this.d1
          .prepare("UPDATE users SET num_members = num_members + 1 WHERE id = ?")
          .bind(orgId),
      ]);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // concurrent add — upstream's in-tx re-check
      throw error;
    }
  }

  /**
   * Remove a member — port of upstream `RemoveOrgUser`
   * (services/org/user.go:36–52): a non-member is a silent no-op (false);
   * the §4.3 last-owner guard runs in the SAME batch as the delete — the
   * conditional `DELETE … WHERE role != 'owner' OR (SELECT COUNT(*) …) > 1`
   * makes the guard race-proof, and the `num_members` decrement is guarded
   * on the row actually being gone (a lost guard decrements nothing).
   * Raises `LastOrgOwnerError` (upstream `ErrLastOrgOwner` → API 500, §4.3).
   */
  async removeMember(orgId: number, userId: number): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1
        .prepare(
          `DELETE FROM org_members
           WHERE org_id = ? AND user_id = ?
             AND (role != 'owner' OR (SELECT COUNT(*) FROM org_members WHERE org_id = ? AND role = 'owner') > 1)`,
        )
        .bind(orgId, userId, orgId),
      this.d1
        .prepare(
          `UPDATE users SET num_members = num_members - 1
           WHERE id = ? AND (SELECT COUNT(*) FROM org_members WHERE org_id = ? AND user_id = ?) = 0`,
        )
        .bind(orgId, orgId, userId),
    ]);
    if ((results[0]?.meta.changes ?? 0) > 0) return true;
    // The guard held the delete: either not a member (false) or the last
    // owner (typed 500, upstream message).
    const member = await this.findMembership(orgId, userId);
    if (member === null) return false;
    throw new LastOrgOwnerError(userId);
  }

  /**
   * Change a membership's role — the demote half of the §4.3 guard ("refuses
   * any membership change that would leave an org with zero owner rows"):
   * promotions always pass; a demote to 'member' is blocked in-batch while
   * the member is the only `role='owner'` row. Non-member ⇒ false.
   */
  async setMemberRole(orgId: number, userId: number, role: OrgMemberRole): Promise<boolean> {
    const result = await this.d1
      .prepare(
        `UPDATE org_members SET role = ?
         WHERE org_id = ? AND user_id = ?
           AND (? = 'owner' OR role != 'owner'
                OR (SELECT COUNT(*) FROM org_members WHERE org_id = ? AND role = 'owner') > 1)`,
      )
      .bind(role, orgId, userId, role, orgId)
      .run();
    if ((result.meta.changes ?? 0) > 0) return true;
    const member = await this.findMembership(orgId, userId);
    if (member === null) return false;
    throw new LastOrgOwnerError(userId);
  }

  /**
   * Rename an org — metadata-only port of upstream `RenameUser`
   * (services/user/user.go:36–116), which serves `POST /orgs/{org}/rename`
   * verbatim (routers/api/v1/org/org.go:342–368). Repos are untouched where
   * it matters: `owner_id` is stable so `repo_redirects` (keyed
   * (owner_id, lower_name)) stay valid and storage keys never move (upstream
   * must rename a directory; we do nothing). The SAME batch flips
   * `username`+`username_lower`, performs the `NewUserRedirect` write rule
   * (models/user/redirect.go:56–73: delete any redirect at the old name,
   * delete any at the new name so the new name resolves directly, insert
   * old→id), and rewrites `repositories.owner_namespace` old→new — our
   * analog of upstream's denormalized `owner_name` rewrite
   * (`UpdateRepositoryOwnerName`), required because the landed git gate
   * resolves `/{owner}/{repo}` against `owner_namespace` (schema.ts: kept in
   * lockstep). `repo_redirects.owner_namespace` rows are NOT rewritten: the
   * old URL was filed under the old name — that is the lookup key.
   *
   * Case-only renames update the display case and write NO redirect row
   * (upstream `onlyCapitalization` branch, user.go:48–59).
   *
   * Future-gate note (§4.4): after a rename, `/oldorg/<anything>` must 307
   * to `/neworg/<anything>` (path+query preserved, owner segment rewritten)
   * BEFORE auth challenges — `lookupUserRedirect` is that seam; the gate
   * 404s instead when the renamed org's visibility doesn't satisfy the doer
   * (context_response.go:28–56).
   */
  async renameOrg(orgId: number, newName: string, options: { now?: Date } = {}): Promise<OrgRecord> {
    const org = await this.getOrgById(orgId);
    if (org === null) throw new OrgNotExistError({ id: orgId });
    if (newName.length > MAX_ORG_NAME_LENGTH) throw new OrgNameTooLongError(newName);
    const nameError = usableUsernameError(newName);
    if (nameError !== null) throw nameError;

    const newLower = newName.toLowerCase();
    if (newName === org.username) return org; // upstream: newUserName == u.Name → nil (exact compare)

    if (newLower === org.usernameLower) {
      // Case-only: display case flips, no redirect row (user.go:48–59).
      await this.d1
        .prepare("UPDATE users SET username = ? WHERE id = ? AND type = 'org'")
        .bind(newName, orgId)
        .run();
      return (await this.getOrgById(orgId)) ?? org;
    }

    // Shared-namespace pre-check (any row is a collision: newLower ≠ own).
    const existing = await this.d1
      .prepare("SELECT id FROM users WHERE username_lower = ?")
      .bind(newLower)
      .first<{ id: number }>();
    if (existing !== null) throw new OrgNameCollisionError(newName);

    const seconds = toUnix(options.now ?? new Date());
    try {
      await this.d1.batch([
        this.d1
          .prepare("UPDATE users SET username = ?, username_lower = ? WHERE id = ? AND type = 'org'")
          .bind(newName, newLower, orgId),
        this.d1.prepare("DELETE FROM user_redirects WHERE lower_name = ?").bind(org.usernameLower),
        this.d1.prepare("DELETE FROM user_redirects WHERE lower_name = ?").bind(newLower),
        this.d1
          .prepare("INSERT INTO user_redirects (lower_name, redirect_user_id) VALUES (?, ?)")
          .bind(org.usernameLower, orgId),
        this.d1
          .prepare("UPDATE repositories SET owner_namespace = ?, updated_at = ? WHERE owner_id = ?")
          .bind(newLower, seconds, orgId),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OrgNameCollisionError(newName);
      throw error;
    }
    return (await this.getOrgById(orgId)) ?? org;
  }

  /**
   * §4.8 visibility flip — `UPDATE users SET visibility` only, with no cache
   * invalidation (API lists are D1-per-request; git HTTP re-checks per
   * request). Anonymous/limited/private effects land through the readers
   * (git gate, org lookups) re-reading the row.
   */
  async setOrgVisibility(orgId: number, visibility: Visibility): Promise<OrgRecord> {
    const result = await this.d1
      .prepare("UPDATE users SET visibility = ? WHERE id = ? AND type = 'org'")
      .bind(visibility, orgId)
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new OrgNotExistError({ id: orgId });
    const org = await this.getOrgById(orgId);
    if (org === null) throw new OrgNotExistError({ id: orgId });
    return org;
  }

  /**
   * The 307 seam (§4.4): resolve an old user/org name to the id it now
   * points at (upstream `LookupUserRedirect`, models/user/redirect.go:48–60).
   * Callers rewrite the request path's owner segment and 307 — after a
   * visibility check on the target (context_response.go:40–47).
   */
  async lookupUserRedirect(nameLower: string): Promise<number | null> {
    const row = await this.d1
      .prepare("SELECT redirect_user_id FROM user_redirects WHERE lower_name = ?")
      .bind(nameLower.toLowerCase())
      .first<{ redirect_user_id: number }>();
    return row === null ? null : row.redirect_user_id;
  }

  /** Membership row (§3.3: membership test = row exists). */
  async getMembership(orgId: number, userId: number): Promise<OrgMembershipRecord | null> {
    return this.findMembership(orgId, userId);
  }

  private async findMembership(orgId: number, userId: number): Promise<OrgMembershipRecord | null> {
    const row = await this.d1
      .prepare("SELECT id, org_id, user_id, is_public, role, created_at FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId)
      .first<MembershipSqlRow>();
    return row === null ? null : rowToMembership(row);
  }
}
