/**
 * The auth-source store suite (specs/external-auth-sources.md §8
 * "Store/codec" + the "migration applies" gate): 0056 applies to the test
 * D1 (applyAuthD1Migrations in beforeEach — storage is isolated per test),
 * the 0056 structure is asserted against PRAGMA/sqlite_master
 * (schema.test.ts's idiom), and the store's CRUD + link ops run against the
 * real tables — including the pin behaviors the SPEC pins: the UNIQUE-name
 * arbiter, the ErrSourceInUse refusal, the name-order lists, the
 * provider-keyed link lookup surviving a source rename, and the two FK
 * cascades.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { serializeOAuth2SourceConfig } from "./cfg";
import {
  LoginSourceInUseError,
  LoginSourceNameExistsError,
  LoginSourceNotExistError,
  LoginSourceType,
  countLoginSourceUsers,
  createLoginSource,
  deleteLoginSource,
  ensureExternalLogin,
  findExternalLogins,
  findLoginSources,
  getActiveOAuth2SourceByName,
  getExternalLogin,
  getLoginSource,
  getUserIdByExternalId,
  listActiveOAuth2Sources,
  removeAllExternalLogins,
  removeExternalLogin,
  removeExternalLoginByExternalId,
  updateLoginSource,
} from "./store";

beforeEach(async () => {
  // Per-test storage isolation resets the D1 schema — re-apply (the
  // helper's documented caution); rows also leak across tests in the same
  // workerd instance (audit.test.ts's empirical note), so start emptied.
  await applyAuthD1Migrations();
  for (const table of ["external_login_user", "login_source", "sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const tableColumns = async (table: string): Promise<ColumnInfo[]> =>
  (await env.DB.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>()).results;

const indexRows = async (table: string) =>
  (
    await env.DB
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .bind(table)
      .all<{ name: string; sql: string | null }>()
  ).results;

/** Raw user seed (schema.test.ts's helper shape). */
async function seedUser(name: string): Promise<number> {
  const result = await env.DB
    .prepare("INSERT INTO users (username, username_lower, created_at) VALUES (?, ?, unixepoch())")
    .bind(name, name.toLowerCase())
    .run();
  return Number(result.meta.last_row_id);
}

/** A valid gplus cfg (the codec round-trip proven in cfg.test.ts). */
const gplusCfg = (clientId = "gp-client") =>
  serializeOAuth2SourceConfig({ v: 1, provider: "gplus", clientId, clientSecret: "gp-secret" });

describe("migration 0056 structure (the SPEC §4 tables + the §4.4 session column)", () => {
  it("login_source carries the pin columns in source.go:109-126 order, with the declared defaults", async () => {
    const columns = await tableColumns("login_source");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "INTEGER", 1, 1],
      ["type", "INTEGER", 1, 0],
      ["name", "TEXT", 1, 0],
      ["is_active", "INTEGER", 1, 0],
      ["is_sync_enabled", "INTEGER", 1, 0],
      ["two_factor_policy", "TEXT", 1, 0],
      ["cfg", "TEXT", 1, 0],
      ["created_unix", "INTEGER", 1, 0],
      ["updated_unix", "INTEGER", 1, 0],
    ]);
    const byName = new Map(columns.map((c) => [c.name, c]));
    // xorm `NOT NULL DEFAULT false` / `NOT NULL DEFAULT ''` (:117-119) —
    // drizzle-kit's keyword alias (schema.test.ts's documented equivalence).
    expect(byName.get("is_active")?.dflt_value).toBe("false");
    expect(byName.get("is_sync_enabled")?.dflt_value).toBe("false");
    expect(byName.get("two_factor_policy")?.dflt_value).toBe("''");
  });

  it("login_source has the name arbiter + the is_active reader index", async () => {
    const indexes = await indexRows("login_source");
    const uq = indexes.find((i) => i.name === "login_source_name_uq");
    expect(uq?.sql).toContain("UNIQUE");
    expect(indexes.map((i) => i.name)).toContain("login_source_is_active_idx");
  });

  it("external_login_user has the composite PK, both cascades, and the two reader indexes", async () => {
    const columns = await tableColumns("external_login_user");
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("external_id")?.pk).toBe(1);
    expect(byName.get("login_source_id")?.pk).toBe(2);
    expect(byName.get("user_id")?.notnull).toBe(1);
    expect(byName.get("provider")?.notnull).toBe(1);
    // The v1-empty token columns exist (SPEC §7.8): nullable, no default.
    for (const name of ["access_token", "access_token_secret", "refresh_token", "expires_at"]) {
      expect(byName.get(name)?.notnull).toBe(0);
    }
    const indexes = (await indexRows("external_login_user")).map((i) => i.name);
    expect(indexes).toContain("external_login_user_user_id_idx");
    expect(indexes).toContain("external_login_user_provider_idx");

    const ddl = await env.DB
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_login_user'")
      .first<{ sql: string }>();
    expect(ddl?.sql).toContain("ON DELETE cascade");
  });

  it("sessions gained oauth2_login_state (nullable TEXT — the §4.4 dance column)", async () => {
    const columns = await tableColumns("sessions");
    const col = columns.find((c) => c.name === "oauth2_login_state");
    expect(col).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });
});

describe("login_source CRUD (models/auth/source.go port)", () => {
  it("creates with defaults, sync-enabled honored for OAuth2 and FORCED OFF for non-sync types (source.go:225-228)", async () => {
    const oauth2 = await createLoginSource(d1(), {
      type: LoginSourceType.OAuth2,
      name: "Google",
      isActive: true,
      isSyncEnabled: true,
      cfg: gplusCfg(),
    });
    expect(oauth2.isSyncEnabled).toBe(true); // OAuth2 is sync-capable at :225-228
    expect(oauth2.twoFactorPolicy).toBe("");
    expect(oauth2.isActive).toBe(true);

    // A non-sync-capable type (SMTP 3) forces the flag false even when asked.
    const smtp = await createLoginSource(d1(), {
      type: LoginSourceType.SMTP,
      name: "smtp-source",
      isActive: false,
      isSyncEnabled: true,
      cfg: "{}",
    });
    expect(smtp.isSyncEnabled).toBe(false);
    expect(smtp.createdAt.getTime()).toBe(smtp.updatedAt.getTime());
  });

  it("refuses a duplicate name with the upstream error shape — pre-check AND racy insert (the UNIQUE arbiter)", async () => {
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "GitHub", isActive: true, cfg: gplusCfg() });
    // Serial path: the pre-check's error.
    await expect(
      createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "GitHub", isActive: false, cfg: gplusCfg() }),
    ).rejects.toThrow(LoginSourceNameExistsError);
    // The arbiter itself: a raw insert bypassing the pre-check still fails.
    await expect(
      env.DB.prepare(
        "INSERT INTO login_source (type, name, is_active, is_sync_enabled, two_factor_policy, cfg, created_unix, updated_unix) VALUES (6, 'GitHub', 1, 0, '', '{}', 1, 1)",
      ).run(),
    ).rejects.toThrow();
  });

  it("finds ordered by name with the FindSourcesOptions filters (source.go:256-275)", async () => {
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "zeta", isActive: false, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "alpha", isActive: true, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.LDAP, name: "mid", isActive: true, cfg: "{}" });

    const all = await findLoginSources(d1());
    expect(all.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);

    const active = await findLoginSources(d1(), { isActive: true });
    expect(active.map((s) => s.name)).toEqual(["alpha", "mid"]);

    const oauth2Active = await findLoginSources(d1(), { isActive: true, type: LoginSourceType.OAuth2 });
    expect(oauth2Active.map((s) => s.name)).toEqual(["alpha"]);
  });

  it("getLoginSource: found, missed, and no id-0 Plain synthesis (SPEC §2.1 divergence, module header)", async () => {
    const created = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "s0", isActive: true, cfg: gplusCfg() });
    expect((await getLoginSource(d1(), created.id))?.name).toBe("s0");
    expect(await getLoginSource(d1(), 9999)).toBeNull();
    expect(await getLoginSource(d1(), 0)).toBeNull();
  });

  it("updates with the excluding-self name check (source.go:326-330) and bumps updated_unix", async () => {
    const a = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "first", isActive: true, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "second", isActive: true, cfg: gplusCfg() });

    // Rename onto a sibling's name refuses.
    await expect(updateLoginSource(d1(), a.id, { name: "second" })).rejects.toThrow(LoginSourceNameExistsError);
    // Self-name update is a no-op arm, not a clash.
    const same = await updateLoginSource(d1(), a.id, { name: "first", isActive: false });
    expect(same.isActive).toBe(false);
    expect(same.updatedAt.getTime()).toBeGreaterThanOrEqual(same.createdAt.getTime());

    // cfg replacement rides the same arm.
    const newCfg = serializeOAuth2SourceConfig({ v: 1, provider: "gplus", clientId: "rotated", clientSecret: "s2" });
    const recfg = await updateLoginSource(d1(), a.id, { cfg: newCfg });
    expect((JSON.parse(recfg.cfg) as { clientId: string }).clientId).toBe("rotated");

    await expect(updateLoginSource(d1(), 424242, { isActive: false })).rejects.toThrow(LoginSourceNotExistError);
  });

  it("delete: not-found refuses, in-use refuses with the ErrSourceInUse shape (source.go:389-402)", async () => {
    const source = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "linked", isActive: true, cfg: gplusCfg() });
    await expect(deleteLoginSource(d1(), 424242)).rejects.toThrow(LoginSourceNotExistError);

    const userId = await seedUser("linker");
    await ensureExternalLogin(d1(), {
      externalId: "ext-1",
      loginSourceId: source.id,
      userId,
      provider: "gplus",
      email: "linker@example.com",
    });
    await expect(deleteLoginSource(d1(), source.id)).rejects.toThrow(LoginSourceInUseError);
    expect((await getLoginSource(d1(), source.id))?.id).toBe(source.id);

    await expect(deleteLoginSource(d1(), source.id)).rejects.toThrow(/login source is still used by some users/);
    // Unlink frees the delete.
    await removeAllExternalLogins(d1(), userId);
    await deleteLoginSource(d1(), source.id);
    expect(await getLoginSource(d1(), source.id)).toBeNull();
  });

  it("the FK cascade is the direct-delete safety net (SPEC §4.3) — raw delete takes the links", async () => {
    const source = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "cascade", isActive: true, cfg: gplusCfg() });
    const userId = await seedUser("cascader");
    await ensureExternalLogin(d1(), { externalId: "ext-c", loginSourceId: source.id, userId, provider: "gplus" });

    // The store's guard refuses (previous test); the raw path (future
    // direct-delete arm / substrate safety net) cascades.
    await env.DB.prepare("DELETE FROM login_source WHERE id = ?").bind(source.id).run();
    expect(await getExternalLogin(d1(), source.id, "ext-c")).toBeNull();
  });

  it("user-row deletion sweeps the links (RemoveAllAccountLinks / the user FK cascade)", async () => {
    const source = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "sweep", isActive: true, cfg: gplusCfg() });
    const userId = await seedUser("swept");
    await ensureExternalLogin(d1(), { externalId: "ext-s", loginSourceId: source.id, userId, provider: "gplus" });
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    expect(await getExternalLogin(d1(), source.id, "ext-s")).toBeNull();
  });
});

describe("the name-keyed lookups (oauth2.go:664-677 — the login-flow seam)", () => {
  it("resolves ONLY active OAuth2 sources by name; inactive, wrong-type, and unknown miss", async () => {
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "Active One", isActive: true, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "Sleepy", isActive: false, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.LDAP, name: "NotOauth", isActive: true, cfg: "{}" });

    expect((await getActiveOAuth2SourceByName(d1(), "Active One"))?.name).toBe("Active One");
    expect(await getActiveOAuth2SourceByName(d1(), "Sleepy")).toBeNull();
    expect(await getActiveOAuth2SourceByName(d1(), "NotOauth")).toBeNull();
    expect(await getActiveOAuth2SourceByName(d1(), "nope")).toBeNull();
  });

  it("listActiveOAuth2Sources is the button list: active OAuth2 rows in name order (SPEC §5.6)", async () => {
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "Beta", isActive: true, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "Alpha", isActive: true, cfg: gplusCfg() });
    await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name: "Off", isActive: false, cfg: gplusCfg() });
    const list = await listActiveOAuth2Sources(d1());
    expect(list.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("external_login_user link ops (external_login_user.go port)", () => {
  async function seedLinked(name: string, externalId: string) {
    const source = await createLoginSource(d1(), { type: LoginSourceType.OAuth2, name, isActive: true, cfg: gplusCfg() });
    const userId = await seedUser(name.toLowerCase());
    const link = await ensureExternalLogin(d1(), {
      externalId,
      loginSourceId: source.id,
      userId,
      provider: "gplus",
      email: `${name.toLowerCase()}@example.com`,
      name: "External Name",
      accessToken: "",
      expiresAt: new Date(1_700_000_000),
    });
    return { source, userId, link };
  }

  it("ensureExternalLogin inserts then REFRESHES in place (EnsureLinkExternalToUser, :161-176)", async () => {
    const { source } = await seedLinked("upsert", "ext-u");
    const refreshed = await ensureExternalLogin(d1(), {
      externalId: "ext-u",
      loginSourceId: source.id,
      userId: (await findExternalLogins(d1(), { provider: "gplus" }))[0]!.userId,
      provider: "gplus",
      email: "new@example.com",
      name: "Renamed",
      avatarUrl: "https://a",
    });
    expect(refreshed.email).toBe("new@example.com");
    expect(refreshed.name).toBe("Renamed");
    expect(refreshed.avatarUrl).toBe("https://a");
    // Still exactly one row for the pair.
    expect(await countLoginSourceUsers(d1(), source.id)).toBe(1);
  });

  it("getExternalLogin point-reads the (sourceId, externalId) pair (:83-90)", async () => {
    await seedLinked("point", "ext-p");
    const source = (await getActiveOAuth2SourceByName(d1(), "point"))!;
    expect((await getExternalLogin(d1(), source.id, "ext-p"))?.email).toBe("point@example.com");
    expect(await getExternalLogin(d1(), source.id, "other")).toBeNull();
  });

  it("getUserIdByExternalId is PROVIDER-keyed and survives a source rename (:131-141)", async () => {
    const { source, userId } = await seedLinked("rename-me", "ext-r");
    expect(await getUserIdByExternalId(d1(), "gplus", "ext-r")).toBe(userId);
    // Rename the source — the provider-keyed lookup is the one that must
    // not care (external_login_user.go:57's provider column's reason).
    await updateLoginSource(d1(), source.id, { name: "renamed" });
    expect(await getUserIdByExternalId(d1(), "gplus", "ext-r")).toBe(userId);
    expect(await getUserIdByExternalId(d1(), "github", "ext-r")).toBeNull();
    expect(await getUserIdByExternalId(d1(), "gplus", "missing")).toBeNull();
  });

  it("removal arms: one pair, all pairs, and by external id (:107-124, :133-137)", async () => {
    const { source, userId } = await seedLinked("removal", "ext-1");
    await ensureExternalLogin(d1(), { externalId: "ext-2", loginSourceId: source.id, userId, provider: "gplus" });

    expect(await removeExternalLoginByExternalId(d1(), source.id, "ext-2")).toBe(1);
    expect(await getExternalLogin(d1(), source.id, "ext-2")).toBeNull();
    expect(await removeExternalLogin(d1(), userId, source.id)).toBe(1);
    expect(await removeExternalLogin(d1(), userId, source.id)).toBe(0);

    // Re-seed two links; the user sweep takes both.
    await ensureExternalLogin(d1(), { externalId: "ext-a", loginSourceId: source.id, userId, provider: "gplus" });
    await ensureExternalLogin(d1(), { externalId: "ext-b", loginSourceId: source.id, userId, provider: "gplus" });
    expect(await removeAllExternalLogins(d1(), userId)).toBe(2);
    expect(await countLoginSourceUsers(d1(), source.id)).toBe(0);
  });

  it("findExternalLogins filters (user/source/provider) and orders by external_id (FindExternalUserOptions)", async () => {
    const { source, userId } = await seedLinked("finder", "b-ext");
    await ensureExternalLogin(d1(), { externalId: "a-ext", loginSourceId: source.id, userId, provider: "gplus" });

    const forUser = await findExternalLogins(d1(), { userId });
    expect(forUser.map((l) => l.externalId)).toEqual(["a-ext", "b-ext"]);

    expect((await findExternalLogins(d1(), { loginSourceId: source.id })).length).toBe(2);
    expect((await findExternalLogins(d1(), { provider: "github" })).length).toBe(0);
  });

  it("token columns accept and round-trip (carried for re-pin parity; v1 flows write EMPTY, SPEC §7.8)", async () => {
    const { source } = await seedLinked("tokens", "ext-t");
    const row = (await getExternalLogin(d1(), source.id, "ext-t"))!;
    expect(row.accessToken).toBe("");
    expect(row.expiresAt?.getTime()).toBe(1_700_000_000);
  });
});

function d1(): D1Database {
  return env.DB;
}
