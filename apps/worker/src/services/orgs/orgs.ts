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

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { orgMembers, repositories, userRedirects, users } from "../../db/schema";
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
          repoAdminChangeTeamAccess: false,
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

    const where = isOwner
      ? eq(repositories.ownerId, orgId)
      : and(eq(repositories.ownerId, orgId), eq(repositories.visibility, "public"));
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
   * The SPEC-0003 row-19 grant (§3.4): at tier 1 `role='owner'` is *exactly
   * equivalent* to upstream's `CanCreateOrgRepo` EXISTS
   * (org_user.go:98–106, `can_create_org_repo OR authorize=owner` through
   * team_user) — a fresh org has one team (Owners, can_create_org_repo) and
   * no tier-1 path creates another. Both callers (POST /orgs/{org}/repos and
   * git push-create) share this predicate. Site-admin bypass is caller-level
   * (`prepareDoerCreateRepoInOrg`, fork.go:97–108), as upstream.
   */
  async canCreateOrgRepo(orgId: number, userId: number): Promise<boolean> {
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
   * (services/org/user.go:36–52): a non-member is a silent no-op (false);
   * the §4.3 last-owner guard runs in the SAME batch as the delete — the
   * conditional `DELETE … WHERE role != 'owner' OR (SELECT COUNT(*) …) > 1`
   * makes the guard race-proof, and the `num_members` decrement is guarded
   * on the row actually being gone (a lost guard decrements nothing).
   * Raises `LastOrgOwnerError` (upstream `ErrLastOrgOwner` → API 500, §4.3).
   */
  async removeMember(orgId: number, userId: number): Promise<boolean> {
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
    ]);
    if (results[0].length > 0) return true;
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
