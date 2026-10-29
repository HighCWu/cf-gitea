/**
 * The repo-settings service's write contract on real D1 — the Actions
 * unit-row lockstep in particular (the C9 unit-row gap's regression pin).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef: the owner-scope
 * runner scan gates on the repo_unit row (models/actions/task.go:280-284 —
 * the `repo_unit.type = unit.TypeActions` join; the row IS the enabled
 * state, models/repo/repo.go:385-387 UnitEnabled → getUnitsByRepoID), and
 * the unit's writers maintain the row (ActionsUnitPost,
 * routers/web/repo/setting/actions.go:67-93 → UpdateRepositoryUnits,
 * services/repository/setting.go:19-52: enable inserts the row, disable
 * deletes it). Our scan port (services/actions `scopeRepoIds`) reads the
 * same row, so a has_actions save that left the row unwritten left the scan
 * blind to every production repo — this suite pins the flag+row lockstep
 * AND the end-to-end link (toggle → row → the scan's scope).
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { actionRunners, repoUnits, repositories } from "../../db/schema";
import { scopeRepoIds, type RunnerRow } from "../../services/actions/model";
import { loadRepoSettings, saveRepoSettings } from "./repo-settings";

const T0 = new Date("2026-02-03T04:05:06Z");
const OWNER_ID = 1;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_units", "repo_settings", "action_runners", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, status, created_at) VALUES (1, 'alice', 'alice', 'active', unixepoch())",
  ).run();
  for (const id of ["repo-1", "repo-2"]) {
    await drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "alice",
      ownerId: OWNER_ID,
      slug: id,
      visibility: "public",
      createdAt: T0,
    });
  }
});

/** The repo's unit rows (the actions row is the scan's gate). */
async function unitTypes(repoId: string): Promise<string[]> {
  return (await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, repoId)).all()).map((r) => r.type);
}

/** An owner-scoped runner row over the seeded owner (scopeRepoIds' input). */
async function seedOwnerRunner(): Promise<RunnerRow> {
  const rows = await drizzle(env.DB)
    .insert(actionRunners)
    .values({
      uuid: crypto.randomUUID(),
      ownerId: OWNER_ID,
      tokenHash: "repo-settings-test-runner",
      created: T0,
      updated: T0,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("runner seed failed");
  return row;
}

describe("saveRepoSettings — the Actions unit-row lockstep (ActionsUnitPost's UpdateRepositoryUnits arm)", () => {
  it("enable inserts the repo_units actions row with the flag", async () => {
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect((await loadRepoSettings(env.DB, "repo-1")).hasActions).toBe(true);
    expect(await unitTypes("repo-1")).toEqual(["actions"]);
  });

  it("disable deletes the row with the flag (upstream's deleteUnitTypes arm)", async () => {
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect((await loadRepoSettings(env.DB, "repo-1")).hasActions).toBe(false);
    expect(await unitTypes("repo-1")).toEqual([]);
  });

  it("is idempotent both ways (insert conflict-tolerant, delete zero-rows)", async () => {
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect(await unitTypes("repo-1")).toEqual(["actions"]);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect(await unitTypes("repo-1")).toEqual([]);
  });

  it("is repo-scoped — the neighbor's row and flag never move", async () => {
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect(await unitTypes("repo-2")).toEqual([]);
    expect((await loadRepoSettings(env.DB, "repo-2")).hasActions).toBe(false);
  });

  it("a unit-less save never touches the row (the description PATCH's shape)", async () => {
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    await saveRepoSettings(env.DB, "repo-1", { description: "hello" }, T0);
    expect(await unitTypes("repo-1")).toEqual(["actions"]);
  });

  it("an explicit-false save heals a stray pre-fix row (upstream rewrites the unit list unconditionally)", async () => {
    // The pre-fix divergence: a row with no backing write (e.g. a test seed).
    await drizzle(env.DB).insert(repoUnits).values({ repoId: "repo-1", type: "actions" });
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect(await unitTypes("repo-1")).toEqual([]);
  });
});

describe("the C9 unit-row gap, end to end: toggle → row → the scan's scope", () => {
  it("an owner runner's scopeRepoIds sees the repo only while the unit is enabled", async () => {
    const runner = await seedOwnerRunner();
    // The reported gap's polarity: a production repo (flag never written,
    // row absent) is invisible to the owner-scope scan.
    expect(await scopeRepoIds(env.DB, runner)).toEqual([]);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect(await scopeRepoIds(env.DB, runner)).toEqual(["repo-1"]);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect(await scopeRepoIds(env.DB, runner)).toEqual([]);
  });
});
