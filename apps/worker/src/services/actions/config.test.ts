/**
 * The repo ActionsConfig store's tests (services/actions/config.ts — the
 * SPEC-0012 migration gap): the upstream-shaped JSON serialization (the
 * Go-marshal bytes — nil slices as nulls, omitempty on the tagged three),
 * the FromDB normalization (junk/NULL → permissive), the store round-trip
 * over real D1 INCLUDING the lifetime (disable Actions wipes the config —
 * the unit row's delete is the wipe), the UpdateTokenPermissions decision
 * tree, and the collaborative-owner add/remove arms.
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * models/repo/repo_unit_actions.go + repo_unit.go:261-311,368-370 +
 * routers/web/repo/setting/actions.go:103-191 + models/actions/config.go
 * (the module header carries the full cite set).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { repositories, repoUnits } from "../../db/schema";
import {
  ACTIONS_TOKEN_UNIT_TYPES,
  applyRepoTokenPermissionsForm,
  clampActionsTokenPermissions,
  getDefaultTokenPermissions,
  getMaxTokenPermissions,
  makeActionsTokenPermissions,
  makeRestrictedPermissions,
  makeWriteAllActionsTokenPermissions,
  addRepoActionsCollaborativeOwner,
  loadRepoActionsConfig,
  parseRepoActionsConfig,
  removeRepoActionsCollaborativeOwner,
  saveRepoActionsConfig,
  serializeRepoActionsConfig,
  type RepoActionsConfig,
  type RepoTokenPermissionsForm,
} from "./config";

const T0 = new Date(1_700_000_000 * 1000);

beforeAll(async () => {
  await applyAuthD1Migrations();
});

let repoId: string;

beforeEach(async () => {
  for (const table of ["repo_units", "repo_settings", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, 'demo', 'main', 'public', unixepoch())",
  ).run();
  repoId = "repo-1";
});

/** The actions unit ON (the toggle write — the unit row the config rides). */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repoId, { hasActions: true }, T0);
}

// --- the serialization (ToDB — upstream's exact Go-marshal bytes) -------------

describe("serializeRepoActionsConfig (ActionsConfig.ToDB, repo_unit_actions.go:185-189)", () => {
  it("emits the zero config's Go-marshal bytes — nil slices as nulls, the normalized mode, no omitempty-suppressed keys", () => {
    expect(serializeRepoActionsConfig(parseRepoActionsConfig(null))).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":null,"token_permission_mode":"permissive"}',
    );
  });

  it("emits tagged keys only when set (omitempty) and orders per the struct declaration", () => {
    const cfg: RepoActionsConfig = {
      disabledWorkflows: ["build.yml"],
      disabledScopedWorkflows: { "7": ["w.yml", "a.yml"] },
      collaborativeOwnerIds: [3, 1, 2],
      tokenPermissionMode: "restricted",
      maxTokenPermissions: { unitAccessModes: { 10: 2, 1: 1 }, idToken: true },
      overrideOwnerConfig: true,
    };
    // Go sorts integer-keyed maps numerically (owners 1,2,3; units 1,10) and
    // marshals struct fields in declaration order.
    expect(serializeRepoActionsConfig(cfg)).toBe(
      '{"DisabledWorkflows":["build.yml"],"DisabledScopedWorkflows":{"7":["w.yml","a.yml"]},"CollaborativeOwnerIDs":[1,2,3],' +
        '"token_permission_mode":"restricted","max_token_permissions":{"unit_access_modes":{"1":1,"10":2},"id_token":true},"override_owner_config":true}',
    );
  });

  it("drops an empty unit_access_modes map and a false id_token (the omitempty arms)", () => {
    const cfg = parseRepoActionsConfig(null);
    cfg.maxTokenPermissions = { unitAccessModes: {}, idToken: false };
    expect(serializeRepoActionsConfig(cfg)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":null,"token_permission_mode":"permissive","max_token_permissions":{}}',
    );
  });
});

// --- the parse (FromDB + EnumValue normalization) ------------------------------

describe("parseRepoActionsConfig (ActionsConfig.FromDB + BeforeSet's FromDB(nil))", () => {
  it("normalizes a NULL column to the zero config with mode permissive (repo_unit.go:288-292 + util.go:304-310)", () => {
    expect(parseRepoActionsConfig(null)).toEqual({
      disabledWorkflows: [],
      disabledScopedWorkflows: {},
      collaborativeOwnerIds: [],
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      overrideOwnerConfig: false,
    });
  });

  it("treats junk bytes as the zero config (the ignored Unmarshal error)", () => {
    expect(parseRepoActionsConfig("not json{")).toEqual(parseRepoActionsConfig(null));
  });

  it("normalizes an invalid stored mode to permissive (EnumValue's enums[0])", () => {
    expect(parseRepoActionsConfig('{"token_permission_mode":"junk"}').tokenPermissionMode).toBe("permissive");
    expect(parseRepoActionsConfig("{}").tokenPermissionMode).toBe("permissive");
    expect(parseRepoActionsConfig('{"token_permission_mode":"restricted"}').tokenPermissionMode).toBe("restricted");
  });

  it("round-trips through serialize (the ToDB bytes parse back identical)", () => {
    const cfg: RepoActionsConfig = {
      disabledWorkflows: [],
      disabledScopedWorkflows: {},
      collaborativeOwnerIds: [9],
      tokenPermissionMode: "restricted",
      maxTokenPermissions: makeActionsTokenPermissions(1),
      overrideOwnerConfig: true,
    };
    expect(parseRepoActionsConfig(serializeRepoActionsConfig(cfg))).toEqual(cfg);
  });
});

// --- the defaults the token-mint side will consume ------------------------------

describe("the token-permission defaults (repo_unit_actions.go:46-78,150-174)", () => {
  it("makeWriteAllActionsTokenPermissions: every unit write + id-token (the max default)", () => {
    expect(makeWriteAllActionsTokenPermissions()).toEqual({
      unitAccessModes: Object.fromEntries(ACTIONS_TOKEN_UNIT_TYPES.map((u) => [u, 2])),
      idToken: true,
    });
  });

  it("makeRestrictedPermissions: all none except code/packages/releases read", () => {
    const restricted = makeRestrictedPermissions();
    expect(restricted.unitAccessModes[1]).toBe(1);
    expect(restricted.unitAccessModes[9]).toBe(1);
    expect(restricted.unitAccessModes[4]).toBe(1);
    expect(restricted.unitAccessModes[10]).toBe(0);
    expect(restricted.idToken).toBe(false);
  });

  it("getDefaultTokenPermissions keys on the mode; getMaxTokenPermissions falls back to write-all", () => {
    expect(getDefaultTokenPermissions("restricted")).toEqual(makeRestrictedPermissions());
    expect(getDefaultTokenPermissions("permissive")).toEqual(makeActionsTokenPermissions(2));
    expect(getMaxTokenPermissions({ maxTokenPermissions: null })).toEqual(makeWriteAllActionsTokenPermissions());
    expect(getMaxTokenPermissions({ maxTokenPermissions: makeActionsTokenPermissions(1) })).toEqual(makeActionsTokenPermissions(1));
  });

  it("clampActionsTokenPermissions takes the per-unit min and ANDs the id-token", () => {
    const clamped = clampActionsTokenPermissions(
      { unitAccessModes: { 1: 2, 2: 0 }, idToken: true },
      makeWriteAllActionsTokenPermissions(),
    );
    expect(clamped.unitAccessModes[1]).toBe(2);
    expect(clamped.unitAccessModes[2]).toBe(0);
    expect(clamped.unitAccessModes[10]).toBe(0); // p1's absent key reads Go's zero value → min(0, write)
    expect(clamped.idToken).toBe(true);
  });
});

// --- the store + its lifetime ----------------------------------------------------

describe("loadRepoActionsConfig / saveRepoActionsConfig (GetUnit read + UpdateRepoUnitConfig write)", () => {
  it("answers the normalized zero config while the unit is missing or NULL-configured", async () => {
    expect(await loadRepoActionsConfig(env.DB, repoId)).toEqual(parseRepoActionsConfig(null));
    await enableActions(); // the unit row exists with a NULL config column
    expect(await loadRepoActionsConfig(env.DB, repoId)).toEqual(parseRepoActionsConfig(null));
  });

  it("round-trips a saved config and is repo-scoped", async () => {
    await enableActions();
    const cfg = parseRepoActionsConfig(null);
    cfg.collaborativeOwnerIds = [5];
    cfg.overrideOwnerConfig = true;
    expect(await saveRepoActionsConfig(env.DB, repoId, cfg)).toBe("saved");
    expect(await loadRepoActionsConfig(env.DB, repoId)).toEqual(cfg);
    expect(await loadRepoActionsConfig(env.DB, "repo-other")).toEqual(parseRepoActionsConfig(null));
  });

  it("wipes with the unit: disabling Actions deletes the row and the config with it (UpdateRepositoryUnits' delete arm)", async () => {
    await enableActions();
    const cfg = parseRepoActionsConfig(null);
    cfg.collaborativeOwnerIds = [5];
    await saveRepoActionsConfig(env.DB, repoId, cfg);
    await saveRepoSettings(env.DB, repoId, { hasActions: false }, T0);
    expect(await loadRepoActionsConfig(env.DB, repoId)).toEqual(parseRepoActionsConfig(null)); // fresh — upstream's newRepoUnit(..., nil)
  });

  it("saveRepoActionsConfig answers missing on a unit-less repo (the gate's 404 at the store seam)", async () => {
    const cfg = parseRepoActionsConfig(null);
    cfg.collaborativeOwnerIds = [5];
    expect(await saveRepoActionsConfig(env.DB, repoId, cfg)).toBe("missing");
  });
});

// --- the token_permissions write arm ---------------------------------------------

function form(overrides: Partial<RepoTokenPermissionsForm> = {}): RepoTokenPermissionsForm {
  return {
    overrideOwnerConfig: true,
    tokenPermissionMode: "restricted",
    enableMaxPermissions: true,
    maxUnitAccessModes: Object.fromEntries(ACTIONS_TOKEN_UNIT_TYPES.map((u) => [u, "read"])),
    maxIdToken: "write",
    ...overrides,
  };
}

describe("applyRepoTokenPermissionsForm (UpdateTokenPermissions, actions.go:139-191)", () => {
  it("stores the override flag, the validated mode and the parsed ceiling", async () => {
    await enableActions();
    expect(await applyRepoTokenPermissionsForm(env.DB, repoId, form())).toBe("saved");
    const stored = await loadRepoActionsConfig(env.DB, repoId);
    expect(stored.overrideOwnerConfig).toBe(true);
    expect(stored.tokenPermissionMode).toBe("restricted");
    expect(stored.maxTokenPermissions?.unitAccessModes[1]).toBe(1); // read
    expect(stored.maxTokenPermissions?.idToken).toBe(true); // max_id_token == "write"
  });

  it("refuses an invalid mode with NO save (the :162-167 flash-redirect arm)", async () => {
    await enableActions();
    expect(await applyRepoTokenPermissionsForm(env.DB, repoId, form({ tokenPermissionMode: "junk" }))).toBe("invalid-mode");
    expect(await loadRepoActionsConfig(env.DB, repoId)).toEqual(parseRepoActionsConfig(null)); // untouched
  });

  it("keeps the stored mode/max when NOT overriding (the shouldUpdate gate) but writes the flag", async () => {
    await enableActions();
    await applyRepoTokenPermissionsForm(env.DB, repoId, form()); // restricted + read ceiling
    await applyRepoTokenPermissionsForm(env.DB, repoId, form({ overrideOwnerConfig: false }));
    const stored = await loadRepoActionsConfig(env.DB, repoId);
    expect(stored.overrideOwnerConfig).toBe(false); // the flag always writes
    expect(stored.tokenPermissionMode).toBe("restricted"); // the rest untouched
    expect(stored.maxTokenPermissions?.unitAccessModes[1]).toBe(1);
  });

  it("enable_max_permissions unchecked stores a nil ceiling (the :176 'ignored' arm)", async () => {
    await enableActions();
    await applyRepoTokenPermissionsForm(env.DB, repoId, form({ enableMaxPermissions: false }));
    expect((await loadRepoActionsConfig(env.DB, repoId)).maxTokenPermissions).toBe(null);
  });

  it("parses the radios upstream-style: write/read keywords, junk and absent are none", async () => {
    await enableActions();
    const maxUnitAccessModes: Record<number, string> = {};
    maxUnitAccessModes[1] = "write";
    maxUnitAccessModes[2] = "read";
    maxUnitAccessModes[3] = "junk";
    await applyRepoTokenPermissionsForm(env.DB, repoId, form({ maxUnitAccessModes }));
    const stored = await loadRepoActionsConfig(env.DB, repoId);
    expect(stored.maxTokenPermissions?.unitAccessModes[1]).toBe(2);
    expect(stored.maxTokenPermissions?.unitAccessModes[2]).toBe(1);
    expect(stored.maxTokenPermissions?.unitAccessModes[3]).toBe(0);
    expect(stored.maxTokenPermissions?.unitAccessModes[9]).toBe(0); // absent → none (ParseMaxTokenPermissions' default)
  });

  it("answers missing on a unit-less repo", async () => {
    expect(await applyRepoTokenPermissionsForm(env.DB, repoId, form())).toBe("missing");
  });
});

// --- the collaborative-owner arms -------------------------------------------------

describe("addRepoActionsCollaborativeOwner / removeRepoActionsCollaborativeOwner (actions.go:103-137)", () => {
  it("adds by id, dedupes, removes, and refuses to remove a non-owner", async () => {
    await enableActions();
    expect(await addRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("added");
    expect((await loadRepoActionsConfig(env.DB, repoId)).collaborativeOwnerIds).toEqual([5]);
    expect(await addRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("added"); // contains-guard dedupe
    expect((await loadRepoActionsConfig(env.DB, repoId)).collaborativeOwnerIds).toEqual([5]);
    expect(await addRepoActionsCollaborativeOwner(env.DB, repoId, 6)).toBe("added");
    expect(await removeRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("removed");
    expect((await loadRepoActionsConfig(env.DB, repoId)).collaborativeOwnerIds).toEqual([6]);
    expect(await removeRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("not-an-owner"); // the JSONErrorNotFound arm
  });

  it("answers missing on a unit-less repo (both arms)", async () => {
    expect(await addRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("missing");
    expect(await removeRepoActionsCollaborativeOwner(env.DB, repoId, 5)).toBe("missing");
  });
});

// --- the schema sanity ------------------------------------------------------------

describe("the repo_units.config column", () => {
  it("exists and round-trips raw bytes (migration 0043)", async () => {
    await enableActions();
    await env.DB.prepare("UPDATE repo_units SET config = ? WHERE repo_id = ? AND type = 'actions'")
      .bind('{"CollaborativeOwnerIDs":[42]}', repoId)
      .run();
    const row = await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, repoId)).get();
    expect(row?.config).toBe('{"CollaborativeOwnerIDs":[42]}');
    expect((await drizzle(env.DB).select().from(repositories).all()).length).toBe(1); // sanity: the fixture is single-repo
  });
});
