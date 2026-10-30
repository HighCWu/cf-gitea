/**
 * The OWNER-level ActionsConfig store's tests (services/actions/
 * owner-actions-config.ts — the `user_settings_kv` table + the
 * 'actions.config' row): the upstream-shaped JSON serialization (the
 * Go-marshal bytes — omitempty on all three keys, the lexical map-key
 * sort, slices in order), the FromDB normalization (absent row/junk →
 * permissive), the store round-trip over real D1 (the upsert, per-owner
 * isolation, the cascade), and the repo-list reads the owner page rides.
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * models/actions/config.go:20-51 + models/user/setting.go:22-29,186-232 +
 * setting_options.go:26 + models/repo/repo_list.go:844-850 + repo.go:763-780
 * (the module header carries the full cite set).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  SETTINGS_KEY_ACTIONS_CONFIG,
  getOwnerActionsConfig,
  getOwnerRepositoriesByIDs,
  getRepositoryByName,
  parseOwnerActionsConfig,
  serializeOwnerActionsConfig,
  setOwnerActionsConfig,
  type OwnerActionsConfig,
} from "./owner-actions-config";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["user_settings_kv", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (1, 'coalition', 'coalition', 'The Coalition', 'org', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (2, 'alice', 'alice', 'Alice Doe', 'user', unixepoch())",
  ).run();
});

// --- the serialization (the write half — setting.go:227-232's Go marshal) ----

describe("serializeOwnerActionsConfig (SetUserSettingJSON's json.Marshal)", () => {
  it("emits the default config's bytes — the omitempty trio leaves only the normalized mode", () => {
    expect(serializeOwnerActionsConfig(parseOwnerActionsConfig(null))).toBe('{"token_permission_mode":"permissive"}');
  });

  it("orders fields by declaration and the unit map by Go's LEXICAL map-key sort (1, 10, 2)", () => {
    const cfg: OwnerActionsConfig = {
      tokenPermissionMode: "restricted",
      maxTokenPermissions: { unitAccessModes: { 2: 1, 10: 2, 1: 2 }, idToken: true },
      allowedCrossRepoIds: ["repo-7", "repo-2"],
    };
    // Slices marshal IN ORDER (no sort — [7,2] stays [7,2]); the unit map's
    // integer keys sort lexically: "1" < "10" < "2".
    expect(serializeOwnerActionsConfig(cfg)).toBe(
      '{"token_permission_mode":"restricted",' +
        '"max_token_permissions":{"unit_access_modes":{"1":2,"10":2,"2":1},"id_token":true},' +
        '"allowed_cross_repo_ids":["repo-7","repo-2"]}',
    );
  });

  it("drops the embedded omitempty arms — an empty unit map and a false id_token serialize nothing", () => {
    const cfg = parseOwnerActionsConfig(null);
    cfg.maxTokenPermissions = { unitAccessModes: {}, idToken: false };
    expect(serializeOwnerActionsConfig(cfg)).toBe('{"token_permission_mode":"permissive","max_token_permissions":{}}');
  });
});

// --- the parse (FromDB + EnumValue normalization) ------------------------------

describe("parseOwnerActionsConfig (GetUserSettingJSON's FromDB, setting.go:210-232 + config.go:38-45)", () => {
  it("normalizes an absent row (null and \"\") to the default config — mode permissive, max nil, allowed empty", () => {
    expect(parseOwnerActionsConfig(null)).toEqual({ tokenPermissionMode: "permissive", maxTokenPermissions: null, allowedCrossRepoIds: [] });
    expect(parseOwnerActionsConfig("")).toEqual(parseOwnerActionsConfig(null)); // the absent-row "" bytes' road
  });

  it("treats junk bytes as the zero config (the ignored Unmarshal error)", () => {
    expect(parseOwnerActionsConfig("not json{")).toEqual(parseOwnerActionsConfig(null));
  });

  it("normalizes an invalid stored mode to permissive (EnumValue's enums[0], util.go:302-310)", () => {
    expect(parseOwnerActionsConfig('{"token_permission_mode":"custom"}').tokenPermissionMode).toBe("permissive");
    expect(parseOwnerActionsConfig('{"token_permission_mode":"restricted"}').tokenPermissionMode).toBe("restricted");
  });

  it("reads the tagged keys — the permissions object's snake_case arms and the string id list", () => {
    const cfg = parseOwnerActionsConfig(
      '{"token_permission_mode":"restricted","max_token_permissions":{"unit_access_modes":{"1":2,"10":1},"id_token":true},"allowed_cross_repo_ids":["repo-2","repo-9"]}',
    );
    expect(cfg.tokenPermissionMode).toBe("restricted");
    expect(cfg.maxTokenPermissions).toEqual({ unitAccessModes: { 1: 2, 10: 1 }, idToken: true });
    expect(cfg.allowedCrossRepoIds).toEqual(["repo-2", "repo-9"]);
    // A permissions object missing its omitempty arms parses the zero pair.
    expect(parseOwnerActionsConfig('{"max_token_permissions":{}}').maxTokenPermissions).toEqual({ unitAccessModes: {}, idToken: false });
  });
});

// --- the store (real D1 — the KV row's lifetime) --------------------------------

describe("getOwnerActionsConfig / setOwnerActionsConfig (user_settings_kv)", () => {
  it("answers the default config for an owner with no row — the absent-row semantics the page posture pins", async () => {
    const cfg = await getOwnerActionsConfig(env.DB, 1);
    expect(cfg).toEqual({ tokenPermissionMode: "permissive", maxTokenPermissions: null, allowedCrossRepoIds: [] });
  });

  it("round-trips a saved config through the exact Go-marshal bytes", async () => {
    const cfg: OwnerActionsConfig = {
      tokenPermissionMode: "restricted",
      maxTokenPermissions: { unitAccessModes: { 1: 2, 2: 1 }, idToken: false },
      allowedCrossRepoIds: ["repo-9", "repo-3"],
    };
    await setOwnerActionsConfig(env.DB, 1, cfg);
    // The stored bytes are upstream's marshal (one row under the key).
    const stored = await env.DB
      .prepare("SELECT setting_value FROM user_settings_kv WHERE user_id = 1 AND setting_key = ?")
      .bind(SETTINGS_KEY_ACTIONS_CONFIG)
      .first<{ setting_value: string }>();
    expect(stored?.setting_value).toBe(
      '{"token_permission_mode":"restricted","max_token_permissions":{"unit_access_modes":{"1":2,"2":1}},"allowed_cross_repo_ids":["repo-9","repo-3"]}',
    ); // the false id_token is its own omitempty arm — serialized nothing
    expect(await getOwnerActionsConfig(env.DB, 1)).toEqual(cfg);
  });

  it("upserts — a second save replaces the value at the same (user_id, key) tuple", async () => {
    await setOwnerActionsConfig(env.DB, 1, parseOwnerActionsConfig(null));
    const updated: OwnerActionsConfig = { tokenPermissionMode: "restricted", maxTokenPermissions: null, allowedCrossRepoIds: ["repo-5"] };
    await setOwnerActionsConfig(env.DB, 1, updated);
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM user_settings_kv WHERE user_id = 1")
      .first<{ n: number }>();
    expect(count?.n).toBe(1); // the UPDATE arm, never a second row
    expect(await getOwnerActionsConfig(env.DB, 1)).toEqual(updated);
  });

  it("keeps owners isolated — the org row and the user row are distinct tuples", async () => {
    await setOwnerActionsConfig(env.DB, 1, { tokenPermissionMode: "restricted", maxTokenPermissions: null, allowedCrossRepoIds: [] });
    expect((await getOwnerActionsConfig(env.DB, 2)).tokenPermissionMode).toBe("permissive"); // user 2: no row
    await setOwnerActionsConfig(env.DB, 2, { tokenPermissionMode: "permissive", maxTokenPermissions: { unitAccessModes: { 1: 2 }, idToken: true }, allowedCrossRepoIds: [] });
    expect((await getOwnerActionsConfig(env.DB, 1)).tokenPermissionMode).toBe("restricted");
    expect((await getOwnerActionsConfig(env.DB, 2)).maxTokenPermissions).toEqual({ unitAccessModes: { 1: 2 }, idToken: true });
  });

  it("cascades the owner row's delete (the FK — upstream's user-delete sweep)", async () => {
    await setOwnerActionsConfig(env.DB, 1, parseOwnerActionsConfig(null));
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings_kv").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

// --- the repo-list reads (the owner page's second read) --------------------------

describe("getOwnerRepositoriesByIDs / getRepositoryByName (repo_list.go:844-850 + repo.go:763-780)", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'coalition', 1, 'demo', 'main', 'public', unixepoch())",
    ).run();
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'coalition', 1, 'site', 'main', 'private', unixepoch())",
    ).run();
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-x', 'repo-x', 'alice', 2, 'other', 'main', 'public', unixepoch())",
    ).run();
  });

  it("answers an empty id list WITHOUT a query (repo_list.go:845-847's short-circuit)", async () => {
    expect(await getOwnerRepositoriesByIDs(env.DB, 1, [])).toEqual([]);
  });

  it("resolves the owner-pinned id list to the render triple (FullName = owner/repo, Link = /owner/repo)", async () => {
    expect(await getOwnerRepositoriesByIDs(env.DB, 1, ["repo-2", "repo-1"])).toEqual([
      { id: "repo-1", fullName: "coalition/demo", link: "/coalition/demo" },
      { id: "repo-2", fullName: "coalition/site", link: "/coalition/site" },
    ]);
    // A foreign owner's id is invisible through another owner's lens.
    expect(await getOwnerRepositoriesByIDs(env.DB, 1, ["repo-x"])).toEqual([]);
  });

  it("resolves a repo by name within the owner, case-folded; another owner's name misses", async () => {
    expect(await getRepositoryByName(env.DB, 1, "DEMO")).toEqual({ id: "repo-1" }); // lower_name arm
    expect(await getRepositoryByName(env.DB, 1, "site")).toEqual({ id: "repo-2" });
    expect(await getRepositoryByName(env.DB, 1, "other")).toBeNull(); // alice's repo
    expect(await getRepositoryByName(env.DB, 1, "missing")).toBeNull(); // ErrRepoNotExist
  });
});
