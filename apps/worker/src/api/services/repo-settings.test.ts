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
import { actionRunners, actionSchedules, actionScheduleSpecs, repoSettings, repoUnits, repositories } from "../../db/schema";
import { scopeRepoIds, type RunnerRow } from "../../services/actions/model";
import { loadRepoSettings, saveRepoSettings } from "./repo-settings";

const T0 = new Date("2026-02-03T04:05:06Z");
const OWNER_ID = 1;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_units", "repo_settings", "action_runners", "action_schedule_spec", "action_schedule", "repositories", "users"]) {
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

describe("the settings-change arm (setting.go:27-51 — the §D7 wiring)", () => {
  /** The registry rows the arm acts on (direct seeds — the registration
   *  lifecycle is schedule.test.ts's arm). */
  async function seedScheduleRows(repoId: string): Promise<void> {
    const schedule = await drizzle(env.DB)
      .insert(actionSchedules)
      .values({
        title: "ci",
        specs: JSON.stringify(["0 * * * *"]),
        repoId,
        ownerId: OWNER_ID,
        workflowId: "ci.yml",
        triggerUserId: -2,
        ref: "refs/heads/main",
        commitSha: "a".repeat(40),
        event: "push",
        eventPayload: "{}",
        content: "on: schedule",
        created: T0,
        updated: T0,
      })
      .returning({ id: actionSchedules.id });
    await drizzle(env.DB).insert(actionScheduleSpecs).values({
      repoId,
      scheduleId: schedule[0]!.id,
      spec: "0 * * * *",
      next: new Date(T0),
      prev: null,
      created: T0,
      updated: T0,
    });
  }

  it("ENABLE deletes the registry rows before the re-walk (setting.go:32-35's in-tx pair, delete half)", async () => {
    await seedScheduleRows("repo-1");
    // env threaded (the production callers all do) — the detect runs against
    // a fixture repo with no default branch and skips silently
    // (notifier_helper.go:672-676's GetCommit miss arm).
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0, { env });
    expect(await drizzle(env.DB).select().from(actionSchedules).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(actionScheduleSpecs).all()).toHaveLength(0);
    // The unit write stands.
    expect(await unitTypes("repo-1")).toEqual(["actions"]);
  });

  it("ENABLE without a threaded env still runs the delete half (the re-walk skip is logged, not fatal)", async () => {
    await seedScheduleRows("repo-1");
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect(await drizzle(env.DB).select().from(actionSchedules).all()).toHaveLength(0);
    expect(await unitTypes("repo-1")).toEqual(["actions"]);
  });

  it("DISABLE runs CleanRepoScheduleTasks: the registry rows go (setting.go:55-58)", async () => {
    await seedScheduleRows("repo-1");
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect(await drizzle(env.DB).select().from(actionSchedules).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(actionScheduleSpecs).all()).toHaveLength(0);
    expect(await unitTypes("repo-1")).toEqual([]);
  });

  it("the arm is repo-scoped: the neighbor's registry rows never move", async () => {
    await seedScheduleRows("repo-2");
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect(await drizzle(env.DB).select().from(actionSchedules).all()).toHaveLength(1);
  });

  it("a unit-less save never fires the arm (the description PATCH's shape)", async () => {
    await seedScheduleRows("repo-1");
    await saveRepoSettings(env.DB, "repo-1", { description: "hello" }, T0);
    expect(await drizzle(env.DB).select().from(actionSchedules).all()).toHaveLength(1);
  });
});

describe("the C9 unit-row gap at the re-pin: toggle → row → the scan's scope", () => {
  it("the unit row no longer scopes the scan — the owner scope lists every owner repo; the CLAIM gate enforces the unit (#40106)", async () => {
    const runner = await seedOwnerRunner();
    // The PRE-repin pin asserted the gap's old polarity (a repo with no
    // repo_units row invisible to the owner-scope scan). Upstream #40106
    // moved pickup onto JobQueueOptions (run_job_queue.go:26-33 at the
    // 099abf5db4 pin) and DROPPED the repo_unit join from the scan: the
    // scope is ALL the owner's repos, and the Actions-unit check lives at
    // CLAIM time — a disabled repo's waiting jobs are CANCELLED there, not
    // silently skipped (services/actions/model.ts scopeRepoCondition's doc;
    // the claim arm's battery pins the cancel — model.test.ts "the
    // repo_unit join is GONE"). The saveRepoSettings toggle keeps writing/
    // deleting the row (the lockstep tests above) but must not move the
    // scan scope in either direction.
    expect((await scopeRepoIds(env.DB, runner))?.sort()).toEqual(["repo-1", "repo-2"]);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: true }, T0);
    expect((await scopeRepoIds(env.DB, runner))?.sort()).toEqual(["repo-1", "repo-2"]);
    await saveRepoSettings(env.DB, "repo-1", { hasActions: false }, T0);
    expect((await scopeRepoIds(env.DB, runner))?.sort()).toEqual(["repo-1", "repo-2"]);
  });
});

describe("the FN-4 identity ports (migration 0068 — SPEC-0001 §4.1)", () => {
  it("saveRepoSettings writes description/website to the repositories row, not the legacy store", async () => {
    await saveRepoSettings(env.DB, "repo-1", { description: "row-borne", website: "https://row.test" }, T0);
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
    expect(row?.description).toBe("row-borne");
    expect(row?.website).toBe("https://row.test");
    // The legacy repo_settings columns stay untouched (the store retired —
    // their NOT NULL DEFAULT '' rows keep satisfying the old inserts).
    const settings = await drizzle(env.DB).select().from(repoSettings).where(eq(repoSettings.repoId, "repo-1")).get();
    expect(settings?.description).toBe("");
    expect(settings?.website).toBe("");
    // Partial patches keep the other field.
    await saveRepoSettings(env.DB, "repo-1", { website: "https://next.test" }, T0);
    const again = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
    expect(again?.description).toBe("row-borne");
    expect(again?.website).toBe("https://next.test");
  });

  it("setRepoArchived stamps archived_unix (SetArchiveRepoState: now on archive, 0 on unarchive)", async () => {
    const { setRepoArchived } = await import("./repo-settings");
    await setRepoArchived(env.DB, "repo-1", true, T0);
    let row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
    expect(row?.archivedUnix).toBe(Math.floor(T0.getTime() / 1000));
    expect(row?.isArchived).toBe(true);
    // The API render folds 0 to the epoch render (AsTime(0)) — the unarchive
    // stamp resets to 0, never a stale instant.
    await setRepoArchived(env.DB, "repo-1", false, T0);
    row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
    expect(row?.archivedUnix).toBe(0);
    expect(row?.isArchived).toBe(false);
  });
});

describe("the PullRequestsConfig.CreationRestriction store (the CREATEREST family — repo.go:856's apply-side member)", () => {
  /** The stored pull_requests unit row's config JSON (Go marshal names). */
  async function prUnitConfig(repoId: string): Promise<string | null> {
    const row = await drizzle(env.DB)
      .select()
      .from(repoUnits)
      .where(eq(repoUnits.repoId, repoId))
      .all()
      .then((rows) => rows.find((r) => r.type === "pull_requests"));
    return row?.config ?? null;
  }

  it("the default renders reader everywhere — the missing-row fallback and DEFAULT_PULL_REQUESTS_CONFIG (repo_unit.go:168)", async () => {
    const settings = await loadRepoSettings(env.DB, "repo-1");
    expect(settings.prUnit.CreationRestriction).toBe("reader");
  });

  it("a PATCH partial persists the member on the unit row's Go-marshal key and round-trips (repo.go:856's merged write)", async () => {
    // A bare restriction PATCH alone (upstream's non-nil opt makes `changed`
    // true → the unit row rewrites even with no other flag in the body).
    await saveRepoSettings(env.DB, "repo-1", { prUnit: { CreationRestriction: "member" } }, T0);
    const stored = await prUnitConfig("repo-1");
    expect(stored).toContain('"CreationRestriction":"member"');
    const settings = await loadRepoSettings(env.DB, "repo-1");
    expect(settings.prUnit.CreationRestriction).toBe("member");
    // The merge keeps the other members' stored-or-default values (the
    // optional.AssignPtrValue arm mutates the LOADED config, repo.go:836-861).
    expect(settings.prUnit.AllowMerge).toBe(true);
    // A second write over the stored value.
    await saveRepoSettings(env.DB, "repo-1", { prUnit: { CreationRestriction: "writer" } }, T0);
    expect((await loadRepoSettings(env.DB, "repo-1")).prUnit.CreationRestriction).toBe("writer");
  });

  it("an empty stored value re-arms to reader (FromDB's IfZero tail, repo_unit.go:182); a corrupted blob keeps the default", async () => {
    await drizzle(env.DB)
      .insert(repoUnits)
      .values({ repoId: "repo-1", type: "pull_requests", config: '{"CreationRestriction":""}', createdAt: T0 });
    expect((await loadRepoSettings(env.DB, "repo-1")).prUnit.CreationRestriction).toBe("reader");
    // Corrupted JSON is ignored wholesale — the defaults stand (upstream's
    // lenient unmarshal, "don't let corrupted database value cause
    // unnecessary 500 error").
    await drizzle(env.DB)
      .update(repoUnits)
      .set({ config: "{not json" })
      .where(eq(repoUnits.repoId, "repo-1"));
    const settings = await loadRepoSettings(env.DB, "repo-1");
    expect(settings.prUnit.CreationRestriction).toBe("reader");
    expect(settings.prUnit.AllowMerge).toBe(true);
  });

  it("has_pull_requests=false deletes the stored restriction with the row (the deleteUnitTypes arm); re-enable restarts at reader", async () => {
    await saveRepoSettings(env.DB, "repo-1", { prUnit: { CreationRestriction: "writer" } }, T0);
    expect((await loadRepoSettings(env.DB, "repo-1")).prUnit.CreationRestriction).toBe("writer");
    await saveRepoSettings(env.DB, "repo-1", { hasPullRequests: false }, T0);
    expect(await prUnitConfig("repo-1")).toBeNull();
    expect((await loadRepoSettings(env.DB, "repo-1")).prUnit.CreationRestriction).toBe("reader");
    // Re-enable reseeds the default config (mustInsertPullRequestUnit,
    // repo.go:837-839 — "Unit doesn't exist yet but is being enabled").
    await saveRepoSettings(env.DB, "repo-1", { hasPullRequests: true }, T0);
    expect((await loadRepoSettings(env.DB, "repo-1")).prUnit.CreationRestriction).toBe("reader");
  });
});
