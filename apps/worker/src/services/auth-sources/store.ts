/**
 * The login_source store + the external_login_user link ops — the W1
 * substrate of specs/external-auth-sources.md (§4 data model, §6.2 service
 * layer). This is the port of `models/auth/source.go` and
 * `models/user/external_login_user.go`; routes (W2/W4/W5) read through
 * here, never hand-write the queries.
 *
 * ## What ports and what collapses
 *
 *   - `CreateSource` (source.go:218-254): the UNIQUE-name pre-check
 *     (ErrSourceAlreadyExist) ports verbatim; the register-then-rollback
 *     dance (:246-252 — RegisterSource failure DELETES the row) collapses
 *     to validate-before-persist ONE LEVEL UP (the admin flow probes the
 *     OIDC discovery document before calling here — SPEC §5.1), so this
 *     layer never needs to roll back. The `IsSyncEnabled` forcing
 *     (:225-228 — false for every type except LDAP/OAuth2) ports: the store
 *     forces it off for any type outside that set, today exactly OAuth2.
 *   - `UpdateSource` (source.go:312-353): the name-uniqueness check
 *     EXCLUDING SELF ports; the OAuth2 original-restore
 *     (:314-320, :347-351) collapses with the same validate-before-persist
 *     move.
 *   - `DeleteSource` + `ErrSourceInUse` (source.go:389-402, enforced at
 *     routers/web/admin/auths.go:450): the in-use check runs FIRST and
 *     refuses — upstream's observable behavior — even though the FK
 *     cascade would take the links (the cascade is the substrate safety net
 *     for direct-delete paths only, SPEC §4.3).
 *   - `GetSourceByID` (source.go:292-309): id 0 synthesizes an active Plain
 *     source upstream ("the internal database auth is always present").
 *     NOT ported — v1 has no Plain-row consumer (the PAT posture IS the
 *     plain auth; SPEC §3.5); id 0 is simply a miss here.
 *   - `FindSourcesOptions` (source.go:256-275): `is_active`/`type` filters,
 *     ordered by `name` (ToOrders :274).
 *   - `GetActiveOAuth2SourceByAuthName` (models/auth/oauth2.go:664-677):
 *     `name = ? AND type = OAuth2 AND is_active = TRUE`; a miss is a
 *     not-exist (null here — the route layer answers the 404, SPEC §5.2).
 *
 * Concurrency: no transactions — the `login_source_name_uq` UNIQUE index is
 * the two-saves race judge (the house convention, SPEC §6.2): the pre-check
 * gives the upstream-shaped error on the serial path, and the insert's
 * constraint violation maps to the same error on the racy path.
 */

import { and, asc, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { externalLoginUsers, loginSources } from "../../db/schema";

/** Upstream auth.Type lattice values (models/auth/source.go:28-37). Only
 *  OAuth2 persists in v1; the constants exist so callers never raw-digit
 *  the type column. */
export const LoginSourceType = {
  NoType: 0,
  Plain: 1,
  LDAP: 2,
  SMTP: 3,
  PAM: 4,
  DLDAP: 5,
  OAuth2: 6,
  SSPI: 7,
} as const;

/** Types whose IsSyncEnabled may stay on (source.go:225-228). */
const SYNC_CAPABLE_TYPES: readonly number[] = [LoginSourceType.LDAP, LoginSourceType.OAuth2];

export type LoginSourceRow = typeof loginSources.$inferSelect;
export type ExternalLoginRow = typeof externalLoginUsers.$inferSelect;
export type NewExternalLogin = typeof externalLoginUsers.$inferInsert;

// -- errors (the source.go error ladder, message shapes verbatim) ------------

/** ErrSourceAlreadyExist (source.go:375-387). */
export class LoginSourceNameExistsError extends Error {
  /** The clashing name (`sourceName` — `name` is Error.prototype's). */
  public readonly sourceName: string;
  constructor(sourceName: string) {
    super(`login source already exists [name: ${sourceName}]`);
    this.sourceName = sourceName;
    this.name = "LoginSourceNameExistsError";
  }
}

/** ErrSourceNotExist (source.go:355-373). */
export class LoginSourceNotExistError extends Error {
  constructor(public readonly id: number) {
    super(`login source does not exist [id: ${id}]`);
    this.name = "LoginSourceNotExistError";
  }
}

/** ErrSourceInUse (source.go:389-402) — the delete arm's refusal. */
export class LoginSourceInUseError extends Error {
  constructor(public readonly id: number) {
    super(`login source is still used by some users [id: ${id}]`);
    this.name = "LoginSourceInUseError";
  }
}

// -- login_source CRUD --------------------------------------------------------

export interface CreateLoginSourceInput {
  type: number;
  name: string;
  isActive: boolean;
  isSyncEnabled?: boolean;
  /** Defaults '' (the inert 2FA slot, source.go:116). */
  twoFactorPolicy?: string;
  /** The pre-serialized cfg JSON — the codec (cfg.ts) owns the shape; the
   *  store treats it opaque, exactly as xorm's TEXT column does. */
  cfg: string;
}

/**
 * `CreateSource` (source.go:218-254) minus the register/rollback dance
 * (validate-before-persist happens in the caller — SPEC §5.1). The
 * is_sync_enabled forcing ports (:225-228). Both timestamps set here
 * (upstream's xorm created/updated auto-columns).
 */
export async function createLoginSource(d1: D1Database, input: CreateLoginSourceInput): Promise<LoginSourceRow> {
  const db = drizzle(d1);
  // Pre-check for the upstream-shaped serial path (:223-227)...
  const existing = await db.select({ id: loginSources.id }).from(loginSources).where(eq(loginSources.name, input.name)).get();
  if (existing) throw new LoginSourceNameExistsError(input.name);

  const now = new Date();
  const isSyncEnabled =
    input.isSyncEnabled === true && SYNC_CAPABLE_TYPES.includes(input.type)
      ? true // the type-gate ports: sync stays off unless the type is sync-capable
      : false;
  try {
    return await db
      .insert(loginSources)
      .values({
        type: input.type,
        name: input.name,
        isActive: input.isActive,
        isSyncEnabled,
        twoFactorPolicy: input.twoFactorPolicy ?? "",
        cfg: input.cfg,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => {
        const row = rows[0];
        if (!row) throw new Error("createLoginSource: insert returned no row");
        return row;
      });
  } catch (err) {
    // ...the UNIQUE index is the racy path's judge (two concurrent creates,
    // one wins) — map the constraint violation to the same upstream error.
    if (err instanceof Error && err.message.includes("UNIQUE")) throw new LoginSourceNameExistsError(input.name);
    throw err;
  }
}

export interface UpdateLoginSourcePatch {
  name?: string;
  isActive?: boolean;
  isSyncEnabled?: boolean;
  twoFactorPolicy?: string;
  /** The replacement cfg JSON (opaque here). */
  cfg?: string;
}

/**
 * `UpdateSource` (source.go:312-353): the name check EXCLUDES SELF
 * (:326-330); the failure-atomicity restore collapses to the caller's
 * validate-before-persist (SPEC §5.1). Not-found ⇒ LoginSourceNotExistError.
 */
export async function updateLoginSource(d1: D1Database, id: number, patch: UpdateLoginSourcePatch): Promise<LoginSourceRow> {
  const db = drizzle(d1);
  const current = await db.select().from(loginSources).where(eq(loginSources.id, id)).get();
  if (!current) throw new LoginSourceNotExistError(id);

  if (patch.name !== undefined && patch.name !== current.name) {
    const clash = await db
      .select({ id: loginSources.id })
      .from(loginSources)
      .where(and(eq(loginSources.name, patch.name), ne(loginSources.id, id)))
      .get();
    if (clash) throw new LoginSourceNameExistsError(patch.name);
  }

  const type = current.type; // type never changes on update (upstream has no arm for it)
  const isSyncEnabled =
    patch.isSyncEnabled === true && SYNC_CAPABLE_TYPES.includes(type) ? true : patch.isSyncEnabled === false ? false : current.isSyncEnabled;

  const rows = await db
    .update(loginSources)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(patch.isSyncEnabled !== undefined ? { isSyncEnabled } : {}),
      ...(patch.twoFactorPolicy !== undefined ? { twoFactorPolicy: patch.twoFactorPolicy } : {}),
      ...(patch.cfg !== undefined ? { cfg: patch.cfg } : {}),
      updatedAt: new Date(),
    })
    .where(eq(loginSources.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new LoginSourceNotExistError(id);
  return row;
}

/** The in-use count — the delete arm's guard input (auths.go:450). */
export async function countLoginSourceUsers(d1: D1Database, id: number): Promise<number> {
  const db = drizzle(d1);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(externalLoginUsers)
    .where(eq(externalLoginUsers.loginSourceId, id));
  return row?.n ?? 0;
}

/**
 * The delete arm: the in-use check runs FIRST and refuses
 * (ErrSourceInUse — auths.go:450's behavior preserved despite the FK
 * cascade, SPEC §4.3); the cascade then takes any links on the allowed
 * path. Not-found ⇒ LoginSourceNotExistError.
 */
export async function deleteLoginSource(d1: D1Database, id: number): Promise<void> {
  const db = drizzle(d1);
  const current = await db.select({ id: loginSources.id }).from(loginSources).where(eq(loginSources.id, id)).get();
  if (!current) throw new LoginSourceNotExistError(id);

  const linked = await countLoginSourceUsers(d1, id);
  if (linked > 0) throw new LoginSourceInUseError(id);

  await db.delete(loginSources).where(eq(loginSources.id, id));
}

/**
 * `GetSourceByID` (source.go:292-309) minus the id-0 Plain synthesis
 * (module header — no v1 consumer).
 */
export async function getLoginSource(d1: D1Database, id: number): Promise<LoginSourceRow | null> {
  const db = drizzle(d1);
  return (await db.select().from(loginSources).where(eq(loginSources.id, id)).get()) ?? null;
}

export interface FindLoginSourcesOptions {
  /** FindSourcesOptions.IsActive (optional.Option[bool] upstream). */
  isActive?: boolean;
  /** FindSourcesOptions.LoginType (NoType means "no filter" upstream —
   *  mirrored: undefined means no filter). */
  type?: number;
}

/** `FindSources` over FindSourcesOptions (source.go:256-275), ordered by
 *  `name` (ToOrders :274). */
export async function findLoginSources(d1: D1Database, options: FindLoginSourcesOptions = {}): Promise<LoginSourceRow[]> {
  const db = drizzle(d1);
  const filters = [];
  if (options.isActive !== undefined) filters.push(eq(loginSources.isActive, options.isActive));
  if (options.type !== undefined && options.type !== LoginSourceType.NoType) filters.push(eq(loginSources.type, options.type));
  const query = db.select().from(loginSources);
  return query
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(loginSources.name));
}

/**
 * `GetActiveOAuth2SourceByAuthName` (models/auth/oauth2.go:664-677) —
 * `name = ? AND type = OAuth2 AND is_active = TRUE`; null on a miss (the
 * caller answers the honest 404, SPEC §5.2). This is THE login-flow
 * lookup: the button href and the IdP callback both carry the source NAME.
 */
export async function getActiveOAuth2SourceByName(d1: D1Database, name: string): Promise<LoginSourceRow | null> {
  const db = drizzle(d1);
  return (
    (await db
      .select()
      .from(loginSources)
      .where(and(eq(loginSources.name, name), eq(loginSources.type, LoginSourceType.OAuth2), eq(loginSources.isActive, true)))
      .get()) ?? null
  );
}

/** The login-buttons read (SPEC §5.6): active OAuth2 sources, name order —
 *  `getActiveOAuth2SourceByName`'s filter as a list. */
export async function listActiveOAuth2Sources(d1: D1Database): Promise<LoginSourceRow[]> {
  return findLoginSources(d1, { isActive: true, type: LoginSourceType.OAuth2 });
}

// -- external_login_user link ops ---------------------------------------------

/**
 * `GetExternalLogin` (external_login_user.go:83-90) — the (sourceId,
 * externalId) point read; the resolution ladder's step 1 (SPEC §5.5.1).
 */
export async function getExternalLogin(d1: D1Database, loginSourceId: number, externalId: string): Promise<ExternalLoginRow | null> {
  const db = drizzle(d1);
  return (
    (await db
      .select()
      .from(externalLoginUsers)
      .where(and(eq(externalLoginUsers.loginSourceId, loginSourceId), eq(externalLoginUsers.externalId, externalId)))
      .get()) ?? null
  );
}

/**
 * `EnsureLinkExternalToUser` (external_login_user.go:161-176) — the
 * sign-in upsert: insert, or a FULL profile refresh when the (sourceId,
 * externalId) row exists. The composite PK is the race arbiter (a
 * double-fire callback loses one insert to the constraint — the caller
 * retries as the refresh arm).
 */
export async function ensureExternalLogin(d1: D1Database, link: NewExternalLogin): Promise<ExternalLoginRow> {
  const db = drizzle(d1);
  const keys = and(eq(externalLoginUsers.loginSourceId, link.loginSourceId), eq(externalLoginUsers.externalId, link.externalId));
  const existing = await db.select().from(externalLoginUsers).where(keys).get();
  if (existing) {
    const rows = await db.update(externalLoginUsers).set(link).where(keys).returning();
    const row = rows[0];
    if (!row) throw new Error("ensureExternalLogin: update returned no row");
    return row;
  }
  const rows = await db.insert(externalLoginUsers).values(link).onConflictDoNothing().returning();
  const row = rows[0];
  if (!row) {
    // Lost a race with a concurrent insert — fall to the refresh arm.
    const updated = await db.update(externalLoginUsers).set(link).where(keys).returning();
    const refreshed = updated[0];
    if (!refreshed) throw new Error("ensureExternalLogin: lost insert race and refresh found no row");
    return refreshed;
  }
  return row;
}

/**
 * `RemoveAccountLink` (external_login_user.go:107-118) — one (user,
 * source) pair; returns the deleted row count (upstream surfaces
 * ErrExternalLoginUserNotExist on 0; the count return keeps the caller's
 * 404 decision local, W5's arm).
 */
export async function removeExternalLogin(d1: D1Database, userId: number, loginSourceId: number): Promise<number> {
  const db = drizzle(d1);
  const rows = await db
    .delete(externalLoginUsers)
    .where(and(eq(externalLoginUsers.userId, userId), eq(externalLoginUsers.loginSourceId, loginSourceId)))
    .returning({ externalId: externalLoginUsers.externalId });
  return rows.length;
}

/** `RemoveAllAccountLinks` (external_login_user.go:119-124) — the
 * user-deletion sweep (the FK cascade's explicit twin for service paths). */
export async function removeAllExternalLogins(d1: D1Database, userId: number): Promise<number> {
  const db = drizzle(d1);
  const rows = await db
    .delete(externalLoginUsers)
    .where(eq(externalLoginUsers.userId, userId))
    .returning({ externalId: externalLoginUsers.externalId });
  return rows.length;
}

/** `RemoveExternalLoginByExternalID` (external_login_user.go:133-137) —
 * the stale-link cleanup's delete (SPEC §5.5.1). */
export async function removeExternalLoginByExternalId(d1: D1Database, loginSourceId: number, externalId: string): Promise<number> {
  const db = drizzle(d1);
  const rows = await db
    .delete(externalLoginUsers)
    .where(and(eq(externalLoginUsers.loginSourceId, loginSourceId), eq(externalLoginUsers.externalId, externalId)))
    .returning({ userId: externalLoginUsers.userId });
  return rows.length;
}

/**
 * `GetUserIDByExternalUserID` (external_login_user.go:131-141) — the
 * PROVIDER-keyed lookup: survives source renames and cross-source moves
 * (the provider column's reason to exist). Null on a miss.
 */
export async function getUserIdByExternalId(d1: D1Database, provider: string, externalId: string): Promise<number | null> {
  const db = drizzle(d1);
  const row = await db
    .select({ userId: externalLoginUsers.userId })
    .from(externalLoginUsers)
    .where(and(eq(externalLoginUsers.provider, provider), eq(externalLoginUsers.externalId, externalId)))
    .get();
  return row?.userId ?? null;
}

export interface FindExternalLoginsOptions {
  /** FindExternalUserOptions.UserID (> 0 filters upstream). */
  userId?: number;
  loginSourceId?: number;
  provider?: string;
}

/** `FindExternalUsers` over FindExternalUserOptions
 *  (external_login_user.go:178-215), ordered by `external_id` (ToOrders
 *  :213). The settings page's linked-accounts list rides the userId filter
 *  (W5). */
export async function findExternalLogins(d1: D1Database, options: FindExternalLoginsOptions = {}): Promise<ExternalLoginRow[]> {
  const db = drizzle(d1);
  const filters = [];
  if (options.userId !== undefined) filters.push(eq(externalLoginUsers.userId, options.userId));
  if (options.loginSourceId !== undefined) filters.push(eq(externalLoginUsers.loginSourceId, options.loginSourceId));
  if (options.provider !== undefined) filters.push(eq(externalLoginUsers.provider, options.provider));
  const query = db.select().from(externalLoginUsers);
  return query
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(externalLoginUsers.externalId));
}
