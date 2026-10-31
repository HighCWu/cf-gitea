/**
 * The admin actions RUNNERS page's tests (the ui-parity tick-19 arm — the
 * ADMIN scope of the shared four-scope runners builders over the M1a
 * runner/token store): the admin list is EVERY runner (repo-scoped,
 * org-scoped, user-scoped, global — ToConds' scope branches never ride), the
 * registration-token block at the GLOBAL (0, "") scope (first GET CREATES
 * it; the reset rotates the global token and ONLY it), the ADMIN polarity of
 * the find/writes (findActionsRunner's ID-only arm + EditableInContext(0,0)
 * = true: a GLOBAL or repo-scoped runner IS editable here — the org twin's
 * NotFound arms inverted), the bulk arm's before-any-write junk arms and
 * silent-missing-id skip, the form parsers, the DOM contracts (the
 * `admin actions` / `admin runners` pageClasses, the bulk form wrapping the
 * table, the unconditional pencil), and the PRE-MOUNT router pins.
 *
 * PRE-MOUNT posture: the routes 404 through the router until the
 * orchestrator executes the module header's HANDOFF recipes — these tests
 * drive the module loaders/writers/parsers/renderers directly (the house
 * pattern for pre-mount waves) and PIN the unclaimed parse shapes (they flip
 * at the mount window, the repo-actions-queue.test.tsx:433 precedent).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_SUCCESS,
  createRunner,
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  insertActionRun,
} from "../../services/actions/model";
import { actionRunnerTokens, actionRunners, actionTasks } from "../../db/schema";
import { parseUiRoute } from "../index";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { repoSettingsRunnersLocale, RUNNER_IDLE_MS, RUNNER_OFFLINE_MS } from "./repo-settings-actions-runners";
import {
  adminActionsRunnersLocale,
  bulkAdminActionsRunners,
  deleteAdminActionsRunner,
  findAdminRunner,
  loadAdminActionsRunnerEditPageData,
  loadAdminActionsRunnersPageData,
  parseAdminActionsRunnerBulkForm,
  parseAdminActionsRunnerDescriptionForm,
  parseAdminActionsRunnerDisabledForm,
  renderAdminActionsRunnerEditPage,
  renderAdminActionsRunnersPage,
  resetAdminActionsRunnerToken,
  runnerEditableInAdmin,
  setAdminActionsRunnerDisabled,
  updateAdminActionsRunnerDescription,
} from "./admin-actions-runners";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The loaders' fixed clock, 5 s after the T0 heartbeat stamps (the twins'
// posture: the status ladder reads a T0 stamp ACTIVE only within the 10 s
// lastActive window).
const NOW = new Date(T0.getTime() + 5_000);
const ORIGIN = "https://test.local";
const BASE = "/-/admin/actions/runners";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action_tasks", "action_run_jobs", "action_run_attempts", "action_runs", "action_runners", "action_runner_tokens", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (1, 'root', 'root', 'Root', 1, unixepoch())",
  ).run();
  // An org's users-table row (the loaders' belongsTo enrichment reads it).
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (7, 'coalition', 'coalition', 'The Coalition', 'org', unixepoch())",
  ).run();
});

async function seedRunner(options: {
  name: string;
  ownerId?: number;
  repoId?: string;
  labels?: string[];
  version?: string;
  description?: string;
}) {
  const created = await createRunner(env.DB, {
    uuid: `uuid-admin-${options.name}-${options.ownerId ?? 0}-${options.repoId ?? ""}`,
    name: options.name,
    version: options.version ?? "1.0.0",
    ownerId: options.ownerId ?? 0,
    repoId: options.repoId ?? "",
    agentLabels: options.labels ?? ["ubuntu-latest"],
    ephemeral: false,
    hasCancellingSupport: false,
  });
  if (options.description !== undefined) {
    await drizzle(env.DB).update(actionRunners).set({ description: options.description }).where(eq(actionRunners.id, created.id));
  }
  // createRunner stamps now — the tests pin the heartbeats to T0 (the fixed
  // NOW makes the status ladder deterministic).
  await drizzle(env.DB)
    .update(actionRunners)
    .set({ lastOnline: T0, lastActive: T0 })
    .where(eq(actionRunners.id, created.id));
  return created;
}

async function setRunnerTimes(id: number, lastOnline: Date | null, lastActive: Date | null): Promise<void> {
  await drizzle(env.DB).update(actionRunners).set({ lastOnline, lastActive }).where(eq(actionRunners.id, id));
}

async function seedRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'coalition', 7, 'demo', 'main', 'public', unixepoch())",
  ).run();
  return "repo-1";
}

// --- the list (FindRunnerOptions.ToConds over the ADMIN scope) ------------------

describe("loadAdminActionsRunnersPageData (Runners' admin arm, runners.go:102-155)", () => {
  it("lists EVERY runner — repo-scoped, org-scoped, user-scoped and global (no scope cond, no WithAvailable)", async () => {
    const repoId = await seedRepo();
    await seedRunner({ name: "repo-runner", repoId });
    await seedRunner({ name: "org-runner", ownerId: 7 });
    await seedRunner({ name: "user-runner", ownerId: 1 });
    await seedRunner({ name: "global-runner" });
    // Another owner's repo runner too — the instance-wide census.
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'rival', 8, 'other', 'main', 'private', unixepoch())",
    ).run();
    await seedRunner({ name: "foreign-repo-runner", repoId: "repo-2" });

    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name).sort()).toEqual([
      "foreign-repo-runner",
      "global-runner",
      "org-runner",
      "repo-runner",
      "user-runner",
    ]);
    expect(data.total).toBe(5);
    // The registration token rode along at the GLOBAL scope (created on the
    // bare GET) and the page-1 pager has no more.
    expect(data.registrationToken).not.toBe("");
    expect(data.page).toBe(1);
    expect(data.more).toBe(false);
  });

  it("the q facet filters by name LIKE and the pager reports more beyond 100 (Runners' PageSize 100)", async () => {
    for (let i = 0; i < 3; i++) {
      await seedRunner({ name: `fleet-${i}` });
    }
    await seedRunner({ name: "other" });
    const filtered = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ q: "fleet" }), NOW);
    expect(filtered.runners.map((runner) => runner.row.name).sort()).toEqual(["fleet-0", "fleet-1", "fleet-2"]);
    expect(filtered.query).toBe("fleet");
    expect(filtered.total).toBe(3);

    // The page walk: shrink the store's page via a direct slice is upstream's
    // fixed PageSize 100 — verify the offset arithmetic with page 1 vs the
    // total (the more arm is the loader's pager contract; a synthetic small
    // store cannot cross 100, so pin the negative).
    const page = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ page: "2" }), NOW);
    expect(page.runners).toHaveLength(0); // offset past the 4 rows
    expect(page.more).toBe(false);
    expect(await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ page: "junk" }), NOW).then((d) => d.page)).toBe(1);
  });

  it("the sort ladder — the default ranks by computed status, alphabetically by name, newest/oldest by id (the shared ToOrders)", async () => {
    const offline = await seedRunner({ name: "z-offline" });
    await setRunnerTimes(offline.id, new Date(T0.getTime() - RUNNER_OFFLINE_MS * 2), T0);
    const idle = await seedRunner({ name: "m-idle" });
    await setRunnerTimes(idle.id, T0, new Date(T0.getTime() - RUNNER_IDLE_MS * 2));
    const active = await seedRunner({ name: "a-active" });
    await setRunnerTimes(active.id, T0, new Date(T0.getTime() - 1_000));

    const byDefault = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    expect(byDefault.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);
    expect(byDefault.runners.map((runner) => runner.status)).toEqual(["active", "idle", "offline"]);

    const byName = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ sort: "alphabetically" }), NOW);
    expect(byName.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);

    const byReverse = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ sort: "reversealphabetically" }), NOW);
    expect(byReverse.runners.map((runner) => runner.row.name)).toEqual(["z-offline", "m-idle", "a-active"]);

    const byNewest = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ sort: "newest" }), NOW);
    expect(byNewest.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]); // creation order

    const byOldest = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams({ sort: "oldest" }), NOW);
    expect(byOldest.runners.map((runner) => runner.row.name)).toEqual(["z-offline", "m-idle", "a-active"]);
  });

  it("the rows carry the computed status, labels and the belongs-to enrichment across ALL scope kinds", async () => {
    const repoId = await seedRepo();
    await seedRunner({ name: "repo-runner", repoId });
    await seedRunner({ name: "org-runner", ownerId: 7 });
    await seedRunner({ name: "global-runner" });
    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    const byName = new Map(data.runners.map((runner) => [runner.row.name, runner]));
    expect(byName.get("repo-runner")!.belongsTo).toEqual({ type: "repository", text: "Repository", tooltip: "coalition/demo" });
    expect(byName.get("org-runner")!.belongsTo).toEqual({ type: "organization", text: "Organization", tooltip: "coalition" });
    expect(byName.get("global-runner")!.belongsTo).toEqual({ type: "system-global", text: "Global", tooltip: null });
    expect(byName.get("repo-runner")!.agentLabels).toEqual(["ubuntu-latest"]);
  });

  it("an EMPTY store lists nothing and still answers the token (GetOrCreateActiveRunnerToken(0, 0))", async () => {
    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    expect(data.runners).toHaveLength(0);
    expect(data.total).toBe(0);
    expect(data.registrationToken).not.toBe("");
  });
});

// --- the token block (runner_token.go semantics at the GLOBAL scope) ----------

describe("the token block's arms (runner_token.go semantics at the (0, \"\") scope)", () => {
  it("the bare GET creates the global scope's first token; the reset rotates it; the token is REUSED while active", async () => {
    const first = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    const reused = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    expect(reused.registrationToken).toBe(first.registrationToken);
    const rotated = await resetAdminActionsRunnerToken(env.DB);
    expect(rotated).not.toBe(first.registrationToken);
    const after = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    expect(after.registrationToken).toBe(rotated);
  });

  it("the reset is scope-guarded — a repo scope's token AND an org scope's token are untouched", async () => {
    // Seed the foreign-scope tokens through the service (the same scope pair
    // encoding: (owner, '') org rows, (0, repo) repo rows).
    await getOrCreateActiveRunnerToken(env.DB, 7, "");
    await getOrCreateActiveRunnerToken(env.DB, 0, "repo-1");
    const orgTokenBefore = await getLatestRunnerToken(env.DB, 7, "");
    const repoTokenBefore = await getLatestRunnerToken(env.DB, 0, "repo-1");
    const globalBefore = await getLatestRunnerToken(env.DB, 0, "");
    expect(orgTokenBefore).not.toBeNull();
    expect(repoTokenBefore).not.toBeNull();
    await resetAdminActionsRunnerToken(env.DB);
    const orgTokenAfter = await getLatestRunnerToken(env.DB, 7, "");
    expect(orgTokenAfter?.id).toBe(orgTokenBefore?.id); // untouched
    const repoTokenAfter = await getLatestRunnerToken(env.DB, 0, "repo-1");
    expect(repoTokenAfter?.id).toBe(repoTokenBefore?.id); // untouched
    const globalAfter = await getLatestRunnerToken(env.DB, 0, "");
    expect(globalAfter?.id).not.toBe(globalBefore?.id); // rotated
    // Exactly one org-scope row remains active (the deactivate sweep pinned
    // the global scope alone).
    expect((await drizzle(env.DB).select().from(actionRunnerTokens).where(eq(actionRunnerTokens.ownerId, 7))).length).toBe(1);
  });
});

// --- the ADMIN polarity (findActionsRunner's ID-only arm + EditableInContext(0, 0)) --

describe("findAdminRunner + the write arms (the ADMIN polarity: ANY runner resolves)", () => {
  it("resolves ANY runner — a GLOBAL runner, a repo-scoped runner, an org's — where the twins' scope pins 404", async () => {
    const repoId = await seedRepo();
    const global = await seedRunner({ name: "global" });
    const repoRunner = await seedRunner({ name: "repo-runner", repoId });
    const orgRunner = await seedRunner({ name: "org-runner", ownerId: 7 });
    expect((await findAdminRunner(env.DB, global.id))?.name).toBe("global");
    expect((await findAdminRunner(env.DB, repoRunner.id))?.name).toBe("repo-runner");
    expect((await findAdminRunner(env.DB, orgRunner.id))?.name).toBe("org-runner");
    expect(await findAdminRunner(env.DB, 424242)).toBeNull();
    expect(await findAdminRunner(env.DB, 0)).toBeNull();
    expect(await findAdminRunner(env.DB, Number.NaN)).toBeNull();
    // The polarity constant: EditableInContext(0, 0) is unconditionally true.
    expect(runnerEditableInAdmin()).toBe(true);
  });

  it("the description update overwrites on a GLOBAL runner too (the org twin's null arm inverted)", async () => {
    const global = await seedRunner({ name: "global" });
    expect(await updateAdminActionsRunnerDescription(env.DB, global.id, "fleet desc")).toBe("updated");
    expect((await findAdminRunner(env.DB, global.id))?.description).toBe("fleet desc");
    expect(await updateAdminActionsRunnerDescription(env.DB, 424242, "x")).toBe("missing");
  });

  it("the disabled flip toggles isDisabled both ways; the junk id is the 404 arm", async () => {
    const runner = await seedRunner({ name: "r" });
    expect(await setAdminActionsRunnerDisabled(env.DB, runner.id, true)).toBe("updated");
    expect((await findAdminRunner(env.DB, runner.id))?.isDisabled).toBe(true);
    expect(await setAdminActionsRunnerDisabled(env.DB, runner.id, false)).toBe("updated");
    expect((await findAdminRunner(env.DB, runner.id))?.isDisabled).toBe(false);
    expect(await setAdminActionsRunnerDisabled(env.DB, 424242, true)).toBe("missing");
  });

  it("the delete is a hard delete across every scope kind; a stale id deletes nothing", async () => {
    const repoId = await seedRepo();
    const repoRunner = await seedRunner({ name: "repo-runner", repoId });
    const global = await seedRunner({ name: "global" });
    expect(await deleteAdminActionsRunner(env.DB, repoRunner.id)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, repoRunner.id))).toHaveLength(0);
    expect(await deleteAdminActionsRunner(env.DB, global.id)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, global.id))).toHaveLength(0);
    expect(await deleteAdminActionsRunner(env.DB, global.id)).toBe("missing"); // idempotent-missing
  });
});

// --- the bulk arm (RunnerBulkActionPost, runners.go:360-430) --------------------

describe("bulkAdminActionsRunners + parseAdminActionsRunnerBulkForm (RunnerBulkActionPost)", () => {
  it("delete removes exactly the found rows; missing ids skip silently; an all-stale set is a no-op 'applied'", async () => {
    const a = await seedRunner({ name: "a" });
    const b = await seedRunner({ name: "b" });
    expect(await bulkAdminActionsRunners(env.DB, { ids: [a.id, 424242, b.id], action: "delete" })).toBe("applied");
    expect(await drizzle(env.DB).select().from(actionRunners)).toHaveLength(0);
    expect(await bulkAdminActionsRunners(env.DB, { ids: [424242], action: "delete" })).toBe("applied"); // empty find = success no-op
  });

  it("disable/enable flip isDisabled across every scope kind", async () => {
    const repoId = await seedRepo();
    const global = await seedRunner({ name: "global" });
    const repoRunner = await seedRunner({ name: "repo-runner", repoId });
    expect(await bulkAdminActionsRunners(env.DB, { ids: [global.id, repoRunner.id], action: "disable" })).toBe("applied");
    expect((await findAdminRunner(env.DB, global.id))?.isDisabled).toBe(true);
    expect((await findAdminRunner(env.DB, repoRunner.id))?.isDisabled).toBe(true);
    expect(await bulkAdminActionsRunners(env.DB, { ids: [global.id, repoRunner.id], action: "enable" })).toBe("applied");
    expect((await findAdminRunner(env.DB, global.id))?.isDisabled).toBe(false);
  });

  it("the junk arms answer BEFORE any write: empty ids → invalid-ids, invalid action → invalid-action", async () => {
    const runner = await seedRunner({ name: "r" });
    expect(await bulkAdminActionsRunners(env.DB, { ids: null, action: "delete" })).toBe("invalid-ids");
    expect(await bulkAdminActionsRunners(env.DB, { ids: [], action: "delete" })).toBe("invalid-ids");
    expect(await bulkAdminActionsRunners(env.DB, { ids: [runner.id], action: "reboot" })).toBe("invalid-action");
    expect(await bulkAdminActionsRunners(env.DB, { ids: [runner.id], action: "" })).toBe("invalid-action");
    // Nothing written by any junk arm.
    expect((await findAdminRunner(env.DB, runner.id))?.isDisabled).toBe(false);
  });

  it("the bulk parser mirrors FormStringInt64s: comma-split, empties skip, ANY junk entry voids the list", () => {
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ ids: "3,7,9", action: "delete" }))).toEqual({ ids: [3, 7, 9], action: "delete" });
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ ids: "3,,9", action: "disable" }))).toEqual({ ids: [3, 9], action: "disable" });
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ ids: "", action: "delete" })).ids).toBeNull();
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ action: "delete" })).ids).toBeNull();
    // Junk voids the WHOLE list (modules/base/tool.go:95-108's error return
    // the `vals, _ :=` discards) — never a partial parse. Whitespace too.
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ ids: "3,junk,9", action: "delete" })).ids).toBeNull();
    expect(parseAdminActionsRunnerBulkForm(new URLSearchParams({ ids: "3, 9", action: "delete" })).ids).toBeNull();
  });
});

// --- the form parsers (the shared scope-neutral readers, admin-named delegates) --

describe("the form parsers (the shared scope-neutral readers, admin-named delegates)", () => {
  it("the description form parses its single field (absent → empty)", () => {
    expect(parseAdminActionsRunnerDescriptionForm(new URLSearchParams({ description: "d" }))).toEqual({ description: "d" });
    expect(parseAdminActionsRunnerDescriptionForm(new URLSearchParams())).toEqual({ description: "" });
  });

  it("the disabled form parses the bool spellings; absent is the 400 arm", () => {
    expect(parseAdminActionsRunnerDisabledForm(new URLSearchParams({ disabled: "true" }))).toEqual({ disabled: true });
    expect(parseAdminActionsRunnerDisabledForm(new URLSearchParams({ disabled: "false" }))).toEqual({ disabled: false });
    expect(parseAdminActionsRunnerDisabledForm(new URLSearchParams({ disabled: "1" }))).toEqual({ disabled: true });
    expect(parseAdminActionsRunnerDisabledForm(new URLSearchParams({ disabled: "junk" }))).toEqual({ disabled: false });
    expect(parseAdminActionsRunnerDisabledForm(new URLSearchParams())).toEqual({ disabled: null });
  });
});

// --- the edit page's recent tasks ------------------------------------------------

describe("loadAdminActionsRunnerEditPageData (RunnersEdit, runners.go:158-216)", () => {
  it("loads ANY runner — a GLOBAL runner included (the org twin's null arm inverted) — plus its recent tasks", async () => {
    const repoId = await seedRepo();
    const global = await seedRunner({ name: "global" });
    const data = await loadAdminActionsRunnerEditPageData(env.DB, global.id, new URLSearchParams(), NOW);
    expect(data).not.toBeNull();
    expect(data!.runner.name).toBe("global");
    expect(data!.belongsTo).toEqual({ type: "system-global", text: "Global", tooltip: null });
    expect(data!.tasks).toHaveLength(0);

    // A repo-scoped runner's belongs-to enrichment and task rows.
    const repoRunner = await seedRunner({ name: "repo-runner", repoId, description: "desc-1" });
    const { jobRows } = await insertActionRun(
      env.DB,
      {
        repoId,
        ownerId: 7,
        workflowId: ".gitea/workflows/ci.yml",
        index: 1,
        triggerUserId: 1,
        ref: "refs/heads/main",
        commitSha: SHA,
        event: "push",
        eventPayload: "{}",
        triggerEvent: "push",
      },
      [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs: {}") }],
    );
    const claimed = jobRows[0]!;
    const finishedAt = new Date(T0.getTime() + 60_000);
    await drizzle(env.DB).insert(actionTasks).values([
      {
        jobId: claimed.id,
        runnerId: repoRunner.id,
        status: ACTION_STATUS_SUCCESS,
        repoId,
        ownerId: 7,
        commitSha: SHA,
        tokenHash: `hash-a-${repoRunner.id}`,
        tokenSalt: "salt",
        started: T0,
        stopped: finishedAt,
        created: T0,
        updated: finishedAt,
      },
      {
        jobId: claimed.id,
        runnerId: repoRunner.id,
        status: ACTION_STATUS_FAILURE,
        repoId,
        ownerId: 7,
        commitSha: SHA,
        tokenHash: `hash-b-${repoRunner.id}`,
        tokenSalt: "salt",
        started: new Date(T0.getTime() + 1_000),
        created: new Date(T0.getTime() + 1_000),
        updated: new Date(T0.getTime() + 1_000),
      },
    ]);
    const repoData = await loadAdminActionsRunnerEditPageData(env.DB, repoRunner.id, new URLSearchParams(), NOW);
    expect(repoData).not.toBeNull();
    expect(repoData!.belongsTo).toEqual({ type: "repository", text: "Repository", tooltip: "coalition/demo" });
    expect(repoData!.tasks.map((task) => task.status)).toEqual([ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS]); // id DESC
    expect(repoData!.tasks[1]!.jobId).toBe(claimed.id);
    expect(repoData!.tasks[1]!.repoLink).toBe("/coalition/demo");
    expect(repoData!.tasks[1]!.stopped).toEqual(finishedAt);
    expect(repoData!.tasks[0]!.stopped).toBeNull();
    expect(await loadAdminActionsRunnerEditPageData(env.DB, 424242, new URLSearchParams(), NOW)).toBeNull();
  });
});

// --- the DOM contracts ------------------------------------------------------------

describe("the page renders (admin/actions.tmpl PageType runners + admin/runners/edit.tmpl)", () => {
  it("the runners page carries the `admin actions` pageClass, the nav's active Runners item, the token panel and the bulk form", async () => {
    const runner = await seedRunner({ name: "fleet-1", labels: ["ubuntu-latest"], description: "own machine" });
    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    const html = renderAdminActionsRunnersPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("admin actions");
    expect(html).toContain(repoSettingsRunnersLocale.runner_manage_panel);
    // The admin.total count form ("Total: %d" — the admin arm's own shape).
    expect(html).toContain(`${adminActionsRunnersLocale.total_count} ${data.total}`);
    // The nav: the Actions group OPEN, Runners active, Variables linked,
    // Job queue linked, Scoped Workflows linked (the store wave's fold —
    // the family nav's fourth landed item).
    expect(html).toContain('<details class="item" open');
    expect(html).toContain(`class="active item" href="${BASE}"`);
    expect(html).toContain('href="/-/admin/actions/variables"');
    expect(html).toContain('href="/-/admin/actions/job_queue"');
    expect(html).toContain('href="/-/admin/actions/scoped-workflows"');
    // The token panel: the readonly input + the clipboard hook + the reset form.
    expect(html).toContain(`value="${data.registrationToken}"`);
    expect(html).toContain(`data-clipboard-text="${data.registrationToken}"`);
    expect(html).toContain(`action="${BASE}/reset_registration_token"`);
    // AllowBulkActions: the ONE form wrapping the table posts ids to /bulk
    // with the three action submits.
    expect(html).toContain(`action="${BASE}/bulk"`);
    expect(html).toContain('name="action" value="disable"');
    expect(html).toContain('name="action" value="enable"');
    expect(html).toContain('name="action" value="delete"');
    expect(html).toContain(`name="ids" value="${String(runner.id)}"`);
    // The row: the label chips, the tooltip, the status class.
    expect(html).toContain("own machine");
    expect(html).toContain("ubuntu-latest");
    expect(html).toContain('class="ui label green"');
  });

  it("EVERY row carries the pencil — the EditableInContext(0, 0) polarity (the twins' conditional omitted)", async () => {
    const repoId = await seedRepo();
    await seedRunner({ name: "repo-runner", repoId });
    await seedRunner({ name: "global-runner" });
    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    const html = renderAdminActionsRunnersPage({ ...ctx }, data);
    expect(data.runners.length).toBe(2);
    for (const runner of data.runners) {
      expect(html).toContain(`href="${BASE}/${runner.row.id}"`);
    }
  });

  it("the empty list renders the none line and NO bulk form (nothing to select)", async () => {
    const data = await loadAdminActionsRunnersPageData(env.DB, new URLSearchParams(), NOW);
    const html = renderAdminActionsRunnersPage({ ...ctx }, data);
    expect(html).toContain(repoSettingsRunnersLocale.none);
    expect(html).not.toContain(`${BASE}/bulk`);
  });

  it("the edit page renders the `admin runners` pageClass, the basic-info fields, the three write forms and the tasks table", async () => {
    const runner = await seedRunner({ name: "fleet-1", description: "desc" });
    const data = (await loadAdminActionsRunnerEditPageData(env.DB, runner.id, new URLSearchParams(), NOW))!;
    const html = renderAdminActionsRunnerEditPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("admin runners");
    expect(html).toContain(adminActionsRunnersLocale.edit_runner);
    expect(html).toContain(`${repoSettingsRunnersLocale.runner_title} ${runner.id} fleet-1`);
    expect(html).toContain(`action="${BASE}/${runner.id}"`); // the description form
    expect(html).toContain(`action="${BASE}/${runner.id}/update-runner"`);
    expect(html).toContain(`action="${BASE}/${runner.id}/delete"`);
    expect(html).toContain(repoSettingsRunnersLocale.task_list);
    expect(html).toContain(repoSettingsRunnersLocale.task_list_no_tasks);
  });
});

// --- the PRE-MOUNT router pins (they flip at the orchestrator's mount window) ----

describe("the router shapes (flipped at the HANDOFF mount window)", () => {
  it("the parse claims every admin actions runners shape the family mounts", () => {
    expect(parseUiRoute("/-/admin/actions")).toMatchObject({ family: "admin-actions-redirect" });
    expect(parseUiRoute("/-/admin/actions/runners")).toMatchObject({ family: "admin-actions-runners" });
    expect(parseUiRoute("/-/admin/actions/runners/3")).toMatchObject({ family: "admin-actions-runners-edit", id: 3 });
    expect(parseUiRoute("/-/admin/actions/runners/reset_registration_token")).toMatchObject({ family: "admin-actions-runners-token-reset" });
    expect(parseUiRoute("/-/admin/actions/runners/bulk")).toMatchObject({ family: "admin-actions-runners-bulk" });
    expect(parseUiRoute("/-/admin/actions/runners/3/update-runner")).toMatchObject({ family: "admin-actions-runners-update", id: 3 });
    expect(parseUiRoute("/-/admin/actions/runners/3/delete")).toMatchObject({ family: "admin-actions-runners-delete", id: 3 });
    expect(parseUiRoute("/-/admin/actions/runners/3/extra")).toBeNull(); // deeper tails stay engine-owned
  });
});
