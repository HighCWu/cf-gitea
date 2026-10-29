/**
 * Organization service — SPEC-0007 (M2): org-as-user-row storage, membership,
 * the repo-create grant, rename + namespace redirects, visibility.
 *
 * D1 access goes through Drizzle ORM (src/db/schema.ts: the SPEC-0007 columns
 * on `users`, `orgMembers`, `userRedirects` — migration 0005), per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `ORG_DDL_STATEMENTS` below is kept only as the historical record of the
 * pre-migration bootstrap — the generated migration is authoritative now,
 * including its recorded deviation: `users.visibility` is the landed TEXT
 * enum (migration 0003), NOT the INTEGER ladder sketched in SPEC-0007 §3.2;
 * the service expresses the listing ceiling as an IN-list instead of a range
 * compare. Raw reads of `users`/`repositories` (both long landed) go through
 * Drizzle too, so the module no longer hand-writes any SQL.
 *
 * Storage decision (SPEC-0007 §3.1): organizations are `users` rows with
 * `type='org'` — upstream's own trick (`Organization` is a `user_model.User`
 * alias whose `TableName()` is "user", gitea/models/organization/org.go:76–87).
 * Usernames and org slugs share `UNIQUE(users.username_lower)`; owner lookups
 * (SPEC-0003 §2.1 step 4) stay one type-blind indexed read.
 *
 * Timestamps are unix seconds (repo convention, `mode: "timestamp"`). The
 * org-scoped queries all carry the `type='org'`/`role='owner'` filters that
 * mirror upstream `GetOrgByName` (org.go:400–413) and the Owners-team
 * collapse (§3.3–3.4). Multi-statement mutations are ONE `db.batch([...])`
 * (a single SQLite transaction on D1, the repos/issues service discipline);
 * `UNIQUE(users.username_lower)` / `UNIQUE(org_members.org_id, user_id)` are
 * the race arbiters — the loser catches the unique violation (drizzle wraps
 * the driver error; see `isUniqueViolation`).
 */

import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import {
  orgMembers,
  repositories,
  teamMembers,
  teamRepoAccess,
  teams,
  userRedirects,
  users,
  type TeamAccessMode,
} from "../../db/schema";
import { AuditActions, auditEventInsert, type AuditOrigin } from "../audit";
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
 * SUPERSEDED by migration 0005 (`users` amendments, `org_members` and
 * `user_redirects` in src/db/schema.ts) — kept only so pre-migration scratch
 * databases can still be bootstrapped by hand. Do not extend; change the
 * schema + regenerate instead (AGENTS.md).
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
  /** Upstream `CreateOrgOption.RepoAdminChangeTeamAccess`
   *  (modules/structs/org.go:46–48) — carried through Create verbatim
   *  (routers/api/v1/org/org.go:278). */
  repoAdminChangeTeamAccess?: boolean;
  /** SPEC-0015 §4.2: the audit event's origin hint. Service-level v1 default
   *  "api" (the current call sites are API routes); the downstream audit wave
   *  threads the real per-request origin. */
  origin?: AuditOrigin;
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

/** The org projection of a `users` row as selected from Drizzle — OrgRecord
 *  plus the `type` discriminator the §4.11 type gate reads. */
interface OrgUserRow extends OrgRecord {
  type: "user" | "org";
}

/** Shared projection: the org columns of `users` (the landed table's
 *  `display_name`/`is_admin` are not part of the org projection). */
const ORG_USER_SELECTION = {
  id: users.id,
  username: users.username,
  usernameLower: users.usernameLower,
  email: users.email,
  fullName: users.fullName,
  description: users.description,
  website: users.website,
  location: users.location,
  avatarEmail: users.avatarEmail,
  useCustomAvatar: users.useCustomAvatar,
  visibility: users.visibility,
  numMembers: users.numMembers,
  repoAdminChangeTeamAccess: users.repoAdminChangeTeamAccess,
  createdAt: users.createdAt,
  type: users.type,
};

/** Membership projection (§3.3: membership test = row exists). */
const MEMBERSHIP_SELECTION = {
  id: orgMembers.id,
  orgId: orgMembers.orgId,
  userId: orgMembers.userId,
  isPublic: orgMembers.isPublic,
  role: orgMembers.role,
  createdAt: orgMembers.createdAt,
};

/** Repo projection for §2.2 row 2 listings. */
const REPO_SELECTION = {
  id: repositories.id,
  storageKey: repositories.storageKey,
  ownerNamespace: repositories.ownerNamespace,
  ownerId: repositories.ownerId,
  slug: repositories.slug,
  visibility: repositories.visibility,
  defaultBranch: repositories.defaultBranch,
  isEmpty: repositories.isEmpty,
  isArchived: repositories.isArchived,
  status: repositories.status,
  createdAt: repositories.createdAt,
  updatedAt: repositories.updatedAt,
};

function clampPagination(options: ListOptions = {}): { limit: number; offset: number } {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { limit: pageSize, offset: (page - 1) * pageSize };
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
  private readonly db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

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
   * org.go:347–353) — the membership's `org_id` is a scalar subquery on the
   * just-inserted row, keeping the whole create one transaction. No
   * identicon/avatar generation (§4.6 divergence).
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

    // Shared-namespace pre-check (upstream IsUserExist is type-blind,
    // user.go:546–555); the UNIQUE index stays the race arbiter below.
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, lower))
      .get();
    if (existing !== undefined) throw new OrgNameCollisionError(input.name);

    try {
      await this.db.batch([
        // CreateOrganization pre-deletes redirects at the name (org.go:335–337):
        // creating on a live redirect consumes it (§4.10).
        this.db.delete(userRedirects).where(eq(userRedirects.lowerName, lower)),
        this.db.insert(users).values({
          username: input.name,
          usernameLower: lower,
          email: input.email ?? null,
          displayName: null,
          isAdmin: false,
          status: "active",
          visibility: input.visibility ?? "public",
          fullName: input.fullName ?? null,
          description: input.description ?? null,
          website: input.website ?? null,
          location: input.location ?? null,
          avatarEmail: null,
          useCustomAvatar: false,
          numMembers: 1,
          repoAdminChangeTeamAccess: input.repoAdminChangeTeamAccess === true,
          type: "org",
          createdAt: now,
        }),
        // The creator's membership row — upstream inserts OrgUser plus the
        // synthetic Owners team + TeamUser rows (org.go:347–395); tier 1
        // collapses those into role='owner' (§3.3).
        this.db.insert(orgMembers).values({
          orgId: sql`(select id from users where username_lower = ${lower})`,
          userId: input.ownerId,
          isPublic: false,
          role: "owner",
          createdAt: now,
        }),
        // SPEC-0015 §4.2 slice-one: the `organization:create` audit row rides
        // the SAME batch — atomic with the users row it describes (a name
        // collision throws before/inside the batch and the audit row rolls
        // back with it). The org's numeric id is allocated by the insert
        // above, so scope_id resolves through the same scalar subquery the
        // membership row uses, cast to text (the schema's scope_id drift
        // note: decimal string for numeric entities); actor_name snapshots
        // the creator's username through its own subquery (upstream
        // ActorName, audit_event.go:26).
        auditEventInsert(this.db, {
          action: AuditActions.OrganizationCreate,
          actorId: input.ownerId,
          actorName: sql`(select username from users where id = ${input.ownerId})`,
          scopeType: "organization",
          scopeId: sql`(select cast(id as text) from users where username_lower = ${lower})`,
          scopeName: input.name,
          origin: input.origin ?? "api",
          vars: { scope: input.name },
          timestamp: now,
        }),
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
    const row = await this.db
      .select(ORG_USER_SELECTION)
      .from(users)
      .where(eq(users.usernameLower, lower))
      .get();
    if (row === undefined) return null;
    return this.assertOrgRow(row);
  }

  /** Org by id (the redirect-gate flow: `LookupUserRedirect` → id → row). */
  async getOrgById(id: number): Promise<OrgRecord | null> {
    const row = await this.db.select(ORG_USER_SELECTION).from(users).where(eq(users.id, id)).get();
    if (row === undefined) return null;
    return this.assertOrgRow(row);
  }

  /** §4.11 type gate shared by both lookups — non-org rows read as misses. */
  private assertOrgRow(row: OrgUserRow): OrgRecord | null {
    // Plain users (and rows predating migration 0005, which the column
    // default sets to 'user') fail the check exactly like upstream
    // GetOrgByName's `type = 1` predicate.
    return row.type === "org" ? row : null;
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

    const conds: SQL[] = [eq(orgMembers.userId, userId), eq(users.type, "org")];
    if (maxVisibility !== "private") {
      // Landed TEXT encoding of the SPEC §3.2 INTEGER ladder: the ceiling is
      // a set membership, not a range compare.
      conds.push(
        maxVisibility === "public"
          ? eq(users.visibility, "public")
          : inArray(users.visibility, ["public", "limited"]),
      );
      // Upstream queryUserOrgIDs(uid, includePrivate = IncludeVisibility ==
      // private) — non-public memberships only surface to self/admin lists.
      conds.push(eq(orgMembers.isPublic, true));
    }
    const where = and(...conds);

    const rows = await this.db
      .select(ORG_USER_SELECTION)
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.orgId))
      .where(where)
      .orderBy(asc(users.usernameLower))
      .limit(limit)
      .offset(offset);
    const totalRow = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.orgId))
      .where(where)
      .get();
    return {
      items: rows.map((row) => row),
      total: totalRow?.total ?? 0,
    };
  }

  /**
   * `GET /orgs/{org}/repos` shape (§2.2 row 2, §4.7): the org's repos with
   * **no owner-visibility filter** — the mirrored upstream quirk. An
   * anonymous caller receives the public repos of a limited or private org
   * (200-shaped), unlike `GET /orgs/{org}` (404s via `HasOrgOrUserVisible`)
   * and unlike git HTTP (401-challenges). Private rows are listed when the
   * doer holds "any unit access" — the org `role='owner'` membership (the
   * Owners-team bridge, §3.3), a covering team's grant (§3.5), or a site
   * admin; members without a covering team see public rows only, as
   * upstream (no team ⇒ zero repo access). Upstream resolves the same set
   * row-wise: `ListOrgRepos` → `listUserRepos` keeps repos where
   * `GetDoerRepoPermission(...).HasAnyUnitAccess()` (routers/api/v1/user/
   * repo.go:41–45), whose team resolution is `GetUserRepoTeams`
   * (models/perm/access/repo_permission.go:483) — so the list honors team
   * access upstream, and this WHERE is not a divergence.
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
        (await this.db
          .select({ id: orgMembers.id })
          .from(orgMembers)
          .where(
            and(
              eq(orgMembers.orgId, orgId),
              eq(orgMembers.userId, doer.id),
              eq(orgMembers.role, "owner"),
            ),
          )
          .get()) !== undefined);

    // The §3.5 team arm of the "any unit access" filter — the SQL twin of
    // the row-wise `teamRepoAccessMode` collapse above (and of api/services/
    // repository.ts `teamGrantCondition`, d496ab8's /repos/search twin): a
    // repo passes when a team of THIS org has the doer among its
    // `team_members`, its EFFECTIVE mode is not 'none'
    // (`max(authorize, units_map values)` — json_each(NULL) yields no rows,
    // so plain-permission teams fall through to the `authorize` arm), and it
    // covers the repo (`includes_all_repositories` or a `team_repo_access`
    // row). Scoped to the bound `orgId` (the WHERE already pins
    // `owner_id`), so the list never shows a repo the per-repo seam would
    // 404, and never hides one it admits.
    const teamArm =
      doer.id === null || isOwner
        ? []
        : [
            sql`EXISTS (
              SELECT 1 FROM teams t
              JOIN team_members tm ON tm.team_id = t.id
              WHERE t.org_id = ${orgId}
                AND tm.user_id = ${doer.id}
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
            )`,
          ];
    const where = isOwner
      ? eq(repositories.ownerId, orgId)
      : and(eq(repositories.ownerId, orgId), or(eq(repositories.visibility, "public"), ...teamArm));
    const rows = await this.db
      .select(REPO_SELECTION)
      .from(repositories)
      .where(where)
      .orderBy(asc(repositories.slug))
      .limit(limit)
      .offset(offset);
    const totalRow = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(repositories)
      .where(where)
      .get();
    return {
      items: rows.map((row) => row),
      total: totalRow?.total ?? 0,
    };
  }

  /**
   * The SPEC-0003 row-19 grant (§3.4), widened to the tier-2 team arm:
   *
   *   role='owner' (the Owners-team bridge, §3.3) OR EXISTS(team t
   *     JOIN team_members tm … WHERE t.org_id=? AND tm.user_id=?
   *     AND (t.can_create_org_repo OR t.authorize='owner'))
   *
   * — the verbatim port of upstream's EXISTS query (org_user.go:98–106,
   * `can_create_org_repo OR authorize=owner` through team_user; our join
   * table is `team_members`, SPEC-0007 §3.5). At tier 1 the role predicate
   * was *exactly equivalent* to upstream's reachable state space (a fresh
   * org has one team — Owners, can_create_org_repo — and no tier-1 path
   * created another); with teams landed the team arm becomes reachable via
   * POST /orgs/{org}/teams.
   *
   * CALLERS NOTE (upstream distinction this widening exposes): the org
   * OWNERSHIP guards (`requireOrgOwnership`, `IsOrganizationOwner`) must
   * stay on `isOrgOwner` below — upstream's CanCreateOrgRepo deliberately
   * grants repo creation to non-owner teams without conferring ownership
   * (org_user.go:66–77 vs 98–106). Both callers (POST /orgs/{org}/repos and
   * git push-create) share this predicate. Site-admin bypass is caller-level
   * (`prepareDoerCreateRepoInOrg`, fork.go:97–108), as upstream.
   */
  async canCreateOrgRepo(orgId: number, userId: number): Promise<boolean> {
    if (await this.isOrgOwner(orgId, userId)) return true;
    const row = await this.db
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
      .where(
        and(eq(teams.orgId, orgId), or(eq(teams.canCreateOrgRepo, true), eq(teams.authorize, "owner"))),
      )
      .get();
    return row !== undefined;
  }

  /**
   * `IsOrganizationOwner` (org_user.go:66–77) under the Owners-team bridge:
   * membership in the org's owner team ⟺ `org_members.role='owner'`
   * (SPEC-0007 §3.3 — no owners team row exists to join through). This is
   * the OWNERSHIP predicate the reqOrgOwnership-grade guards belong on —
   * deliberately narrower than `canCreateOrgRepo`, whose team arm grants
   * repo creation without ownership (org_user.go:98–106).
   */
  async isOrgOwner(orgId: number, userId: number): Promise<boolean> {
    const row = await this.db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(
        and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.role, "owner")),
      )
      .get();
    return row !== undefined;
  }

  /**
   * The teams-module enforcement slice (SPEC-0007 §3.5, extracted here so
   * every seam reads one predicate — the routes/org-teams.ts module header's
   * gate-level integration note): the doer's MAXIMUM effective access mode
   * over the repo from org teams, upstream `perm.AccessMode`
   * (perm/access_mode.go:17–22). A team grants when the doer is a
   * `team_members` row of a team in the repo's org whose EFFECTIVE mode is
   * not 'none' — `max(authorize, unitsMap values)`; the units collapse makes
   * the map's strongest unit the team's blanket mode (no unit ACL exists to
   * narrow it) — and covers the repo either through `includes_all_repositories`
   * or an explicit `team_repo_access` row (the read-side union of the landed
   * `doerHasTeamRepoAccess`, repo_team.go:253–255). 'none' when no team
   * grants: org OWNERSHIP grants through `isOrgOwner`, not here (the bridge
   * has no owners team row — callers compose the arms, see
   * api/services/repository.ts `doerRepoAccessMode`).
   */
  async teamRepoAccessMode(repo: { id: string; ownerId: number | null }, userId: number): Promise<TeamAccessMode> {
    if (repo.ownerId === null) return "none";
    const rows = await this.db
      .select({
        id: teams.id,
        authorize: teams.authorize,
        unitsMap: teams.unitsMap,
        includesAll: teams.includesAllRepositories,
      })
      .from(teams)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(and(eq(teams.orgId, repo.ownerId), eq(teamMembers.userId, userId)))
      .all();
    const rank: Record<TeamAccessMode, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };
    let best: TeamAccessMode = "none";
    for (const team of rows) {
      // Effective mode = max(authorize, the unit overrides) — the units_map
      // collapse of upstream's team_unit rows (team.go:204–219, schema.ts
      // `teams.unitsMap`).
      let effective = team.authorize;
      if (team.unitsMap !== null) {
        for (const mode of Object.values(JSON.parse(team.unitsMap) as Record<string, string>)) {
          const parsed: TeamAccessMode =
            mode === "read" || mode === "write" || mode === "admin" || mode === "owner" ? mode : "none";
          if (rank[parsed] > rank[effective]) effective = parsed;
        }
      }
      if (effective === "none" || rank[effective] <= rank[best]) continue;
      const covered = team.includesAll
        ? true
        : (
            await this.db
              .select({ id: teamRepoAccess.id })
              .from(teamRepoAccess)
              .where(and(eq(teamRepoAccess.teamId, team.id), eq(teamRepoAccess.repoId, repo.id)))
              .get()
          ) !== undefined;
      if (covered) best = effective;
    }
    return best;
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
    const user = await this.db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (user === undefined) throw new OrgMemberUserNotExistError({ id: userId });

    const existing = await this.findMembership(orgId, userId);
    if (existing !== null) return false;

    const now = options.now ?? new Date();
    try {
      await this.db.batch([
        this.db.insert(orgMembers).values({
          orgId,
          userId,
          isPublic: options.isPublic === true,
          role: options.role ?? "member",
          createdAt: now,
        }),
        this.db
          .update(users)
          .set({ numMembers: sql`${users.numMembers} + 1` })
          .where(eq(users.id, orgId)),
      ]);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false; // concurrent add — upstream's in-tx re-check
      throw error;
    }
  }

  /**
   * Remove a member — port of upstream `RemoveOrgUser`
   * (services/org/user.go:22–104): a non-member is a silent no-op (false) via
   * the pre-batch membership check (upstream's `!has → return nil`,
   * user.go:31–35). That check is load-bearing for the counter: the batch's
   * `(SELECT COUNT(*) …) = 0` decrement guard is ALSO true for a row that
   * never existed, so without the pre-check removing a never-member would
   * decrement `num_members`. The service owns that semantics — callers need
   * no pre-check. The §4.3 last-owner guard then runs in the SAME batch as
   * the delete — the conditional
   * `DELETE … WHERE role != 'owner' OR (SELECT COUNT(*) …) > 1` makes the
   * guard race-proof, and for a real last owner the row survives so the
   * count guard skips the decrement. Raises `LastOrgOwnerError` (upstream
   * `ErrLastOrgOwner` → API 500, §4.3).
   *
   * The §3.5 team sweep (upstream's "Delete member in their teams" loop,
   * user.go:88–96 via `removeTeamMember`, team.go:312–352): EVERY
   * `team_members` row of this org goes with the membership, each swept
   * team's `num_members` decremented by its own guarded statement (the
   * org-teams.ts `removeTeamMember` batch shape, minus the org_members arm).
   * This is security-load-bearing, not bookkeeping: every grant predicate
   * (`teamRepoAccessMode`, the org-repos team arm, the feeds cond, the git
   * push gate via `doerRepoAccessMode`) reads `team_members` WITHOUT
   * re-checking org membership, so a row surviving here leaves a removed
   * member reading and pushing until separately removed from each team.
   * Statement order chains the guards: the sweep's delete carries the same
   * membership-gone guard as the counter, so the last-owner guard holding
   * the first delete keeps every team row AND counter in place (upstream's
   * whole-tx rollback shape). The swept-team id list is read before the
   * batch (upstream `GetUserOrgTeams`); a team-add racing the batch loses
   * its row (the delete is org+user-scoped) but keeps that team's counter
   * at +1 — the maintained counter is advisory, the grants are not.
   */
  async removeMember(orgId: number, userId: number): Promise<boolean> {
    if ((await this.findMembership(orgId, userId)) === null) return false;
    const sweptTeams = await this.db
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
      .where(eq(teams.orgId, orgId))
      .all();
    const results = await this.db.batch([
      this.db
        .delete(orgMembers)
        .where(
          and(
            eq(orgMembers.orgId, orgId),
            eq(orgMembers.userId, userId),
            sql`(role != 'owner' or (select count(*) from org_members where org_id = ${orgId} and role = 'owner') > 1)`,
          ),
        )
        .returning({ userId: orgMembers.userId }),
      this.db
        .update(users)
        .set({ numMembers: sql`${users.numMembers} - 1` })
        .where(
          and(
            eq(users.id, orgId),
            sql`(select count(*) from org_members where org_id = ${orgId} and user_id = ${userId}) = 0`,
          ),
        ),
      // The sweep — runs only when the membership delete above landed (the
      // same `… = 0` guard, evaluated after that delete in this transaction).
      this.db.delete(teamMembers).where(
        and(
          eq(teamMembers.orgId, orgId),
          eq(teamMembers.userId, userId),
          sql`(select count(*) from org_members where org_id = ${orgId} and user_id = ${userId}) = 0`,
        ),
      ),
      // One guarded counter per swept team (org-teams.ts:635-643's shape).
      ...sweptTeams.map((team) =>
        this.db
          .update(teams)
          .set({ numMembers: sql`${teams.numMembers} - 1` })
          .where(
            and(
              eq(teams.id, team.id),
              sql`(select count(*) from team_members where team_id = ${team.id} and user_id = ${userId}) = 0`,
            ),
          ),
      ),
    ]);
    if (results[0].length > 0) return true;
    // The guard held the delete: the last owner (typed 500, upstream
    // message) — or, only in a race, the row vanished between the pre-check
    // and the batch, which stays a silent no-op. The sweep above is chained
    // to the same guard, so nothing team-scoped moved either.
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
    const updated = await this.db
      .update(orgMembers)
      .set({ role })
      .where(
        and(
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.userId, userId),
          // `${role}` binds the requested role; bare `role` reads the row's
          // current value — the demote guard (§4.3).
          sql`(${role} = 'owner' or role != 'owner' or (select count(*) from org_members where org_id = ${orgId} and role = 'owner') > 1)`,
        ),
      )
      .returning({ userId: orgMembers.userId });
    if (updated.length > 0) return true;
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
      await this.db
        .update(users)
        .set({ username: newName })
        .where(and(eq(users.id, orgId), eq(users.type, "org")));
      return (await this.getOrgById(orgId)) ?? org;
    }

    // Shared-namespace pre-check (any row is a collision: newLower ≠ own).
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, newLower))
      .get();
    if (existing !== undefined) throw new OrgNameCollisionError(newName);

    const now = options.now ?? new Date();
    try {
      await this.db.batch([
        this.db
          .update(users)
          .set({ username: newName, usernameLower: newLower })
          .where(and(eq(users.id, orgId), eq(users.type, "org"))),
        this.db.delete(userRedirects).where(eq(userRedirects.lowerName, org.usernameLower)),
        this.db.delete(userRedirects).where(eq(userRedirects.lowerName, newLower)),
        this.db.insert(userRedirects).values({ lowerName: org.usernameLower, redirectUserId: orgId }),
        this.db
          .update(repositories)
          .set({ ownerNamespace: newLower, updatedAt: now })
          .where(eq(repositories.ownerId, orgId)),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OrgNameCollisionError(newName);
      throw error;
    }
    return (await this.getOrgById(orgId)) ?? org;
  }

  /**
   * Delete an org — the port of upstream `DeleteOrganization` + the
   * `deleteOrganization` cascade it wraps (services/org/org.go:58–88 +
   * 29–52): the caller-level repository guard first (upstream answers the
   * count>0 case with `ErrUserOwnRepos` INSIDE the tx — the API route maps
   * every error through `APIErrorInternal`, so the message never surfaces),
   * then ONE D1 batch: the membership rows (`OrgUser`), the §3.5 team rows
   * (`teams`/`team_members`/`team_repo_access`, migration 0015 — swept
   * explicitly, child tables first; upstream deletes the team beans in the
   * same cascade, org.go:29–52), any redirect rows pointing at or squatting
   * the org's names (upstream relies on the `user_redirect.redirect_user_id`
   * FK cascade; deleting by the lower_name too keeps the namespace
   * immediately reusable), and the `users` row itself (`type='org'`-guarded;
   * the team tables also carry `ON DELETE CASCADE` FKs to it — the explicit
   * sweep keeps the deletion visible in the batch, not implicit in the
   * cascade). `team_repo_access.repo_id` declares no FK, so its rows are
   * swept first and only by `org_id`. Unmodeled upstream beans (secrets,
   * actions runners, packages) have no tables yet. Returns false when the
   * org row is already gone.
   */
  async deleteOrg(orgId: number): Promise<boolean> {
    const org = await this.getOrgById(orgId);
    if (org === null) return false;
    const repoCount = await this.db
      .select({ total: sql<number>`count(*)` })
      .from(repositories)
      .where(eq(repositories.ownerId, orgId))
      .get();
    if ((repoCount?.total ?? 0) > 0) {
      // Upstream `ErrUserOwnRepos` (models/repo ErrUserOwnRepos{UID}) —
      // deliberately an UNTYPED error: the API surface routes it through
      // APIErrorInternal → the blank-message 500, never a 4xx.
      throw new Error(`organization owns repositories [uid: ${orgId}]`);
    }
    await this.db.batch([
      this.db.delete(teamRepoAccess).where(eq(teamRepoAccess.orgId, orgId)),
      this.db.delete(teamMembers).where(eq(teamMembers.orgId, orgId)),
      this.db.delete(teams).where(eq(teams.orgId, orgId)),
      this.db.delete(orgMembers).where(eq(orgMembers.orgId, orgId)),
      this.db.delete(userRedirects).where(eq(userRedirects.redirectUserId, orgId)),
      this.db.delete(userRedirects).where(eq(userRedirects.lowerName, org.usernameLower)),
      this.db.delete(users).where(and(eq(users.id, orgId), eq(users.type, "org"))),
    ]);
    return true;
  }

  /**
   * §4.8 visibility flip — `UPDATE users SET visibility` only, with no cache
   * invalidation (API lists are D1-per-request; git HTTP re-checks per
   * request). Anonymous/limited/private effects land through the readers
   * (git gate, org lookups) re-reading the row.
   */
  async setOrgVisibility(orgId: number, visibility: Visibility): Promise<OrgRecord> {
    const updated = await this.db
      .update(users)
      .set({ visibility })
      .where(and(eq(users.id, orgId), eq(users.type, "org")))
      .returning({ id: users.id });
    if (updated.length === 0) throw new OrgNotExistError({ id: orgId });
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
    const row = await this.db
      .select({ redirectUserId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, nameLower.toLowerCase()))
      .get();
    return row?.redirectUserId ?? null;
  }

  /** Membership row (§3.3: membership test = row exists). */
  async getMembership(orgId: number, userId: number): Promise<OrgMembershipRecord | null> {
    return this.findMembership(orgId, userId);
  }

  private async findMembership(orgId: number, userId: number): Promise<OrgMembershipRecord | null> {
    const row = await this.db
      .select(MEMBERSHIP_SELECTION)
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .get();
    return row ?? null;
  }
}
