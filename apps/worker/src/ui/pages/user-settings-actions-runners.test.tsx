/**
 * The user settings Actions RUNNERS sub-tab's tests (the USER-scope twin of
 * org-settings-actions-runners.test.tsx over the M1a runner/token store):
 * the WithAvailable USER cond (doer-owned + global runners list; a
 * repo-scoped runner — even the doer's own repo's — never does; another
 * user's never; an org-owned runner never; the q facet; the sort ladder with
 * the computed status rank), the registration-token block at the (userId,
 * "") scope (first GET CREATES the token; the reuse arm; the reset arm's
 * deactivate+insert rotation scope-guarded against a repo scope AND a rival
 * user's), the edit page's scope guard + recent tasks, every write arm's
 * outcomes, and the DOM contracts (the user settings-actions pageClass, the
 * module-local nav scaffold's active Runners item, the pencil's
 * EditableInContext conditional). The module is COMMITTED-UNMOUNTED — the
 * route matrix rides the index.ts HANDOFF, so the claim pin asserts the
 * unclaimed posture (parseUiRoute null) instead of a mounted matrix.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { env } from "cloudflare:test";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createRunner,
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  insertActionRun,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_SUCCESS,
} from "../../services/actions/model";
import { actionRunnerTokens, actionRunners, actionTasks } from "../../db/schema";
import { handlesUiRoute, parseUiRoute } from "../index";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  deleteUserActionsRunner,
  findUserScopedRunner,
  loadUserSettingsActionsRunnerEditPageData,
  loadUserSettingsActionsRunnersPageData,
  parseUserActionsRunnerDescriptionForm,
  parseUserActionsRunnerDisabledForm,
  renderUserSettingsActionsRunnerEditPage,
  renderUserSettingsActionsRunnersPage,
  resetUserActionsRunnerToken,
  runnerEditableInUser,
  setUserActionsRunnerDisabled,
  updateUserActionsRunnerDescription,
  userSettingsRunnersLocale,
  UserSettingsActionsRunnersPage,
} from "./user-settings-actions-runners";
import { repoSettingsRunnersLocale, RUNNER_IDLE_MS, RUNNER_OFFLINE_MS } from "./repo-settings-actions-runners";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The loaders' fixed clock, 5 s after the T0 heartbeat stamps (the org
// twin's posture: the status ladder reads a T0 stamp ACTIVE only within the
// 10 s lastActive window).
const NOW = new Date(T0.getTime() + 5_000);
const ORIGIN = "https://test.local";
const USER_ID = 1;
const RIVAL_USER_ID = 2;
const RUNNERS_URL = "/user/settings/actions/runners";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: USER_ID, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "action_tasks",
    "action_run_jobs",
    "action_run_attempts",
    "action_runs",
    "action_runners",
    "action_runner_tokens",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', 0, unixepoch())",
  ).run();
  // The rival user (another user-scope owner) and the org row (an org-scope
  // owner — org-owned runners NEVER list at the user scope).
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Ray', unixepoch())",
  ).run();
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
    uuid: `uuid-user-${options.name}-${options.ownerId ?? 0}-${options.repoId ?? ""}`,
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

async function seedUserRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, 'demo', 'main', 'public', unixepoch())",
  ).run();
  return "repo-1";
}

// --- the list (FindRunnerOptions.ToConds over the USER scope) --------------------

describe("loadUserSettingsActionsRunnersPageData (Runners' user arm, runners.go:102-155)", () => {
  it("lists doer-owned + global runners; never a repo-scoped runner (even the doer's own repo's), never another user's, never an org's", async () => {
    const own = await seedRunner({ name: "user-runner", ownerId: USER_ID });
    const global = await seedRunner({ name: "global-runner" });
    await seedRunner({ name: "own-repo-runner", repoId: await seedUserRepo() }); // the doer's OWN repo's runner stays invisible
    await seedRunner({ name: "rival-runner", ownerId: RIVAL_USER_ID }); // another user's
    await seedRunner({ name: "org-runner", ownerId: 7 }); // an org's

    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name).sort()).toEqual(["global-runner", "user-runner"]);
    expect(data.total).toBe(2);
    expect(data.userId).toBe(USER_ID);
    // The registration token rode along (created on the bare GET).
    expect(data.registrationToken).not.toBe("");
    expect(own.id).toBeGreaterThan(0);
    expect(global.id).toBeGreaterThan(0);
  });

  it("the q facet filters by name LIKE", async () => {
    await seedRunner({ name: "fleet-alpha", ownerId: USER_ID });
    await seedRunner({ name: "fleet-beta", ownerId: USER_ID });
    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams({ q: "alpha" }), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["fleet-alpha"]);
    expect(data.query).toBe("alpha");
  });

  it("the sort ladder — the default ranks by computed status, alphabetically by name, newest/oldest by id", async () => {
    const offline = await seedRunner({ name: "z-offline", ownerId: USER_ID });
    await setRunnerTimes(offline.id, new Date(T0.getTime() - RUNNER_OFFLINE_MS * 2), T0);
    const idle = await seedRunner({ name: "m-idle", ownerId: USER_ID });
    await setRunnerTimes(idle.id, T0, new Date(T0.getTime() - RUNNER_IDLE_MS * 2));
    const active = await seedRunner({ name: "a-active", ownerId: USER_ID });
    await setRunnerTimes(active.id, T0, new Date(T0.getTime() - 1_000));

    const byDefault = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    expect(byDefault.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);
    expect(byDefault.runners.map((runner) => runner.status)).toEqual(["active", "idle", "offline"]);

    const byName = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams({ sort: "alphabetically" }), NOW);
    expect(byName.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);

    const byNewest = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams({ sort: "newest" }), NOW);
    expect(byNewest.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]); // creation order

    const byOldest = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams({ sort: "oldest" }), NOW);
    expect(byOldest.runners.map((runner) => runner.row.name)).toEqual(["z-offline", "m-idle", "a-active"]);
  });

  it("the disabled runner sinks within its status rank (is_disabled ASC, ToOrders' arm)", async () => {
    const enabled = await seedRunner({ name: "enabled", ownerId: USER_ID });
    const disabled = await seedRunner({ name: "disabled", ownerId: USER_ID });
    await drizzle(env.DB).update(actionRunners).set({ isDisabled: true }).where(eq(actionRunners.id, disabled.id));
    await setRunnerTimes(enabled.id, T0, new Date(T0.getTime() - 1_000));
    await setRunnerTimes(disabled.id, T0, new Date(T0.getTime() - 2_000));

    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["enabled", "disabled"]);
  });

  it("the rows carry the computed status, labels and the doer/global belongs-to enrichment", async () => {
    await seedRunner({ name: "user-runner", ownerId: USER_ID, labels: ["ubuntu-latest", "self-hosted"] });
    await seedRunner({ name: "global-runner" });
    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    const ownRow = data.runners.find((runner) => runner.row.name === "user-runner")!;
    expect(ownRow.status).toBe("active"); // T0 heartbeats, 5 s ago, fixed NOW
    expect(ownRow.agentLabels).toEqual(["ubuntu-latest", "self-hosted"]);
    expect(ownRow.belongsTo).toEqual({ type: "individual", text: "User", tooltip: "alice" }); // OwnerTypeIndividual
    const globalRow = data.runners.find((runner) => runner.row.name === "global-runner")!;
    expect(globalRow.belongsTo).toEqual({ type: "system-global", text: "Global", tooltip: null });
  });

  it("the registration token is REUSED while active (GetOrCreateActiveRunnerToken at the user scope)", async () => {
    const first = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    const second = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    expect(second.registrationToken).toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(1); // one scope row, reused — never re-minted
    expect(rows[0]!.ownerId).toBe(USER_ID);
    expect(rows[0]!.repoId).toBe(""); // the user scope's repoId arm
  });
});

// --- the token block's arms (runner_token.go semantics at the user scope) --------

describe("the token block's arms (runner_token.go semantics at the user scope)", () => {
  it("the bare GET creates the scope's first token; the reset rotates it", async () => {
    // No token rows yet — the loader CREATES one (runner_token.go:127-134).
    expect(await getLatestRunnerToken(env.DB, USER_ID, "")).toBeNull();
    const first = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    const stored = await getLatestRunnerToken(env.DB, USER_ID, "");
    expect(stored?.isActive).toBe(true);

    // The reset mints a fresh token and deactivates the scope's old one
    // (NewRunnerTokenWithValue's same-scope sweep); other scopes are untouched.
    const next = await resetUserActionsRunnerToken(env.DB, USER_ID);
    expect(next).not.toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.token === first.registrationToken)?.isActive).toBe(false);
    expect(rows.find((row) => row.token === next)?.isActive).toBe(true);

    // The next GET renders the NEW token.
    const reloaded = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    expect(reloaded.registrationToken).toBe(next);
  });

  it("the reset is scope-guarded — a rival user's token AND a repo scope's token are untouched", async () => {
    // Capture the neighbors' tokens BEFORE the reset — the guard's pin is
    // that (2, "") and (0, "repo-1") survive (1, "")'s rotation byte-for-byte
    // (the scopes are per-owner/repo distinct: normalizeTokenScope).
    const rivalsBefore = await getOrCreateActiveRunnerToken(env.DB, RIVAL_USER_ID, "");
    const repoScopeBefore = await getOrCreateActiveRunnerToken(env.DB, 0, "repo-1");
    await getOrCreateActiveRunnerToken(env.DB, USER_ID, "");
    await resetUserActionsRunnerToken(env.DB, USER_ID);
    const rivals = await getLatestRunnerToken(env.DB, RIVAL_USER_ID, "");
    expect(rivals?.isActive).toBe(true);
    expect(rivals?.token).toBe(rivalsBefore.token);
    const repoScope = await getLatestRunnerToken(env.DB, 0, "repo-1");
    expect(repoScope?.isActive).toBe(true);
    expect(repoScope?.token).toBe(repoScopeBefore.token);
  });
});

// --- the write arms --------------------------------------------------------------

describe("findUserScopedRunner + the write arms (findActionsRunner's USER arm)", () => {
  let ownRunnerId: number;
  let globalRunnerId: number;
  let rivalRunnerId: number;

  beforeEach(async () => {
    ownRunnerId = (await seedRunner({ name: "own", ownerId: USER_ID })).id;
    globalRunnerId = (await seedRunner({ name: "global" })).id;
    rivalRunnerId = (await seedRunner({ name: "rival", ownerId: RIVAL_USER_ID })).id;
  });

  it("resolves only the doer's OWN rows — a GLOBAL runner is the NotFound arm (no WithAvailable at the find)", async () => {
    expect((await findUserScopedRunner(env.DB, USER_ID, ownRunnerId))?.id).toBe(ownRunnerId);
    expect(await findUserScopedRunner(env.DB, USER_ID, globalRunnerId)).toBeNull();
    expect(await findUserScopedRunner(env.DB, USER_ID, rivalRunnerId)).toBeNull();
    expect(await findUserScopedRunner(env.DB, USER_ID, 999_999)).toBeNull();
    expect(await findUserScopedRunner(env.DB, USER_ID, 0)).toBeNull();
    expect(runnerEditableInUser({ ownerId: USER_ID }, USER_ID)).toBe(true);
    expect(runnerEditableInUser({ ownerId: 0 }, USER_ID)).toBe(false);
  });

  it("the description update overwrites and reports missing for a foreign/global id", async () => {
    expect(await updateUserActionsRunnerDescription(env.DB, USER_ID, ownRunnerId, "the laptop runner")).toBe("updated");
    expect((await findUserScopedRunner(env.DB, USER_ID, ownRunnerId))?.description).toBe("the laptop runner");
    expect(await updateUserActionsRunnerDescription(env.DB, USER_ID, globalRunnerId, "nope")).toBe("missing");
    expect(await updateUserActionsRunnerDescription(env.DB, USER_ID, rivalRunnerId, "nope")).toBe("missing");
  });

  it("the disabled flip toggles isDisabled both ways", async () => {
    expect(await setUserActionsRunnerDisabled(env.DB, USER_ID, ownRunnerId, true)).toBe("updated");
    expect((await findUserScopedRunner(env.DB, USER_ID, ownRunnerId))?.isDisabled).toBe(true);
    expect(await setUserActionsRunnerDisabled(env.DB, USER_ID, ownRunnerId, false)).toBe("updated");
    expect((await findUserScopedRunner(env.DB, USER_ID, ownRunnerId))?.isDisabled).toBe(false);
    expect(await setUserActionsRunnerDisabled(env.DB, USER_ID, globalRunnerId, true)).toBe("missing");
  });

  it("the delete is a hard delete; a foreign/global/stale id deletes nothing", async () => {
    expect(await deleteUserActionsRunner(env.DB, USER_ID, globalRunnerId)).toBe("missing");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, globalRunnerId))).toHaveLength(1);
    expect(await deleteUserActionsRunner(env.DB, USER_ID, rivalRunnerId)).toBe("missing");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, rivalRunnerId))).toHaveLength(1);
    expect(await deleteUserActionsRunner(env.DB, USER_ID, ownRunnerId)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, ownRunnerId))).toHaveLength(0);
    expect(await deleteUserActionsRunner(env.DB, USER_ID, ownRunnerId)).toBe("missing"); // idempotent-missing
  });
});

// --- the edit page's recent tasks ------------------------------------------------

describe("loadUserSettingsActionsRunnerEditPageData (RunnersEdit, runners.go:158-216)", () => {
  it("answers null for a global runner (the scope guard IS EditableInContext's owner arm)", async () => {
    const global = await seedRunner({ name: "global" });
    expect(await loadUserSettingsActionsRunnerEditPageData(env.DB, USER_ID, global.id, new URLSearchParams(), NOW)).toBeNull();
  });

  it("loads the runner plus its recent tasks, newest first, with the job/repo enrichment and the individual belongs-to", async () => {
    const repoId = await seedUserRepo();
    const runner = await seedRunner({ name: "own", ownerId: USER_ID, description: "desc-1" });
    const { jobRows } = await insertActionRun(
      env.DB,
      {
        repoId,
        ownerId: USER_ID,
        workflowId: ".gitea/workflows/ci.yml",
        index: 1,
        triggerUserId: USER_ID,
        ref: "refs/heads/main",
        commitSha: SHA,
        event: "push",
        eventPayload: "{}",
        triggerEvent: "push",
      },
      [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs: {}") }],
    );
    const claimed = jobRows[0]!;
    // Two tasks on the runner — one finished, one live.
    const finishedAt = new Date(T0.getTime() + 60_000);
    await drizzle(env.DB).insert(actionTasks).values([
      {
        jobId: claimed.id,
        runnerId: runner.id,
        status: ACTION_STATUS_SUCCESS,
        repoId,
        ownerId: USER_ID,
        commitSha: SHA,
        tokenHash: `hash-a-${runner.id}`,
        tokenSalt: "salt",
        started: T0,
        stopped: finishedAt,
        created: T0,
        updated: finishedAt,
      },
      {
        jobId: claimed.id,
        runnerId: runner.id,
        status: ACTION_STATUS_FAILURE,
        repoId,
        ownerId: USER_ID,
        commitSha: SHA,
        tokenHash: `hash-b-${runner.id}`,
        tokenSalt: "salt",
        started: new Date(T0.getTime() + 1_000),
        created: new Date(T0.getTime() + 1_000),
        updated: new Date(T0.getTime() + 1_000),
      },
    ]);

    const data = await loadUserSettingsActionsRunnerEditPageData(env.DB, USER_ID, runner.id, new URLSearchParams(), NOW);
    expect(data).not.toBeNull();
    expect(data!.runner.name).toBe("own");
    expect(data!.tasks).toHaveLength(2);
    expect(data!.tasks.map((task) => task.status)).toEqual([ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS]); // id DESC
    expect(data!.tasks[1]!.jobId).toBe(claimed.id);
    expect(data!.tasks[1]!.repoLink).toBe("/alice/demo");
    expect(data!.tasks[1]!.commitSha).toBe(SHA);
    expect(data!.tasks[1]!.stopped).toEqual(finishedAt);
    expect(data!.tasks[0]!.stopped).toBeNull();
    expect(data!.belongsTo).toEqual({ type: "individual", text: "User", tooltip: "alice" });
  });
});

// --- the forms ------------------------------------------------------------------

describe("the form parsers (the shared scope-neutral readers, user-named delegates)", () => {
  it("the description form parses its single field (absent → empty)", () => {
    expect(parseUserActionsRunnerDescriptionForm(new URLSearchParams({ description: "d" }))).toEqual({ description: "d" });
    expect(parseUserActionsRunnerDescriptionForm(new URLSearchParams())).toEqual({ description: "" });
  });

  it("the disabled form parses the bool spellings; absent is the 400 arm", () => {
    expect(parseUserActionsRunnerDisabledForm(new URLSearchParams({ disabled: "true" }))).toEqual({ disabled: true });
    expect(parseUserActionsRunnerDisabledForm(new URLSearchParams({ disabled: "false" }))).toEqual({ disabled: false });
    expect(parseUserActionsRunnerDisabledForm(new URLSearchParams({ disabled: "1" }))).toEqual({ disabled: true });
    expect(parseUserActionsRunnerDisabledForm(new URLSearchParams({ disabled: "junk" }))).toEqual({ disabled: false });
    expect(parseUserActionsRunnerDisabledForm(new URLSearchParams())).toEqual({ disabled: null });
  });
});

// --- the DOM contracts ------------------------------------------------------------

describe("the page renders (user/settings/actions.tmpl + user/settings/runner_edit.tmpl)", () => {
  it("the runners page carries the user settings-actions pageClass, the scaffold nav's active Runners item and the token panel", async () => {
    const ownRunner = await seedRunner({ name: "user-runner", ownerId: USER_ID, labels: ["ubuntu-latest"], description: "own machine" });
    await seedRunner({ name: "global-runner" });
    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE).
    const html = renderUserSettingsActionsRunnersPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("user settings actions");
    expect(html).toContain(repoSettingsRunnersLocale.runner_manage_panel);
    expect(html).toContain(`Total ${data.total}`);
    // The Actions disclosure is OPEN with Runners active (the scaffold's
    // literal; the shared-nav swap is the HANDOFF).
    expect(html).toContain('<details class="item" open');
    expect(html).toContain(`class="active item" href="${RUNNERS_URL}"`);
    // The token panel: the readonly input + the clipboard hook + the reset form.
    expect(html).toContain(`value="${data.registrationToken}"`);
    expect(html).toContain(`data-clipboard-text="${data.registrationToken}"`);
    expect(html).toContain(`action="${RUNNERS_URL}/reset_registration_token"`);
    // The rows: the own runner's pencil, the global runner's none (the
    // EditableInContext conditional); labels, tooltips.
    expect(html).toContain(`href="${RUNNERS_URL}/${ownRunner.id}"`);
    expect(html).toContain("own machine");
    expect(html).toContain("ubuntu-latest");
    expect(html).toContain("User"); // concept_user_user
    expect(html).toContain('class="ui label green"'); // the active status label
  });

  it("the global rows render Type but NO pencil (the WithAvailable list)", async () => {
    await seedRunner({ name: "global-runner" });
    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    const html = renderToString(<UserSettingsActionsRunnersPage ctx={ctx} data={data} />);
    expect(html).toContain("Global"); // concept_system_global
    expect(html).not.toContain(`href="${RUNNERS_URL}/`); // no edit links at all
    expect(html).toContain('data-sortt-asc="alphabetically"'); // the sort headers ride
  });

  it("the empty list renders the none line", async () => {
    const data = await loadUserSettingsActionsRunnersPageData(env.DB, USER_ID, new URLSearchParams(), NOW);
    const html = renderToString(<UserSettingsActionsRunnersPage ctx={ctx} data={data} />);
    expect(html).toContain(repoSettingsRunnersLocale.none);
  });

  it("the edit page renders the user runners pageClass, the basic-info fields, the three write forms and the tasks table", async () => {
    const runner = await seedRunner({ name: "own", ownerId: USER_ID, description: "desc-1" });
    const data = (await loadUserSettingsActionsRunnerEditPageData(env.DB, USER_ID, runner.id, new URLSearchParams(), NOW))!;
    const html = renderUserSettingsActionsRunnerEditPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("user settings runners"); // runner_edit.tmpl:1 — the user family's DISTINCT class
    expect(html).toContain(userSettingsRunnersLocale.edit_runner); // the Title (actions.runners.edit_runner)
    expect(html).toContain(`${repoSettingsRunnersLocale.runner_title} ${runner.id} own`);
    expect(html).toContain('value="desc-1"');
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}"`); // the description POST
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}/update-runner"`); // the flip POST
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}/delete"`); // the delete POST
    expect(html).toContain('name="disabled" value="true"'); // the flip's next state
    expect(html).toContain(repoSettingsRunnersLocale.task_list_no_tasks);
    expect(html).toContain(`class="active item" href="${RUNNERS_URL}"`);
  });
});

// --- the mounted route claims (flipped at the HANDOFF mount window) ---------

describe("the route claims (flipped at the index.ts HANDOFF mount window)", () => {
  it("all six upstream user runners routes claim their families", () => {
    expect(parseUiRoute("/user/settings/actions/runners")).toMatchObject({ family: "user-settings-actions-runners" });
    expect(parseUiRoute("/user/settings/actions/runners/5")).toMatchObject({ family: "user-settings-actions-runners-edit", id: 5 });
    expect(parseUiRoute("/user/settings/actions/runners/reset_registration_token")).toMatchObject({ family: "user-settings-actions-runners-token-reset" });
    expect(parseUiRoute("/user/settings/actions/runners/5/update-runner")).toMatchObject({ family: "user-settings-actions-runners-update", id: 5 });
    expect(parseUiRoute("/user/settings/actions/runners/5/delete")).toMatchObject({ family: "user-settings-actions-runners-delete", id: 5 });
    expect(parseUiRoute("/user/settings/actions/runners/junk")).toBeNull(); // non-numeric id — the junk arm
    expect(handlesUiRoute("/user/settings/actions/runners")).toBe(true);
    expect(handlesUiRoute("/user/settings/actions/runners/5")).toBe(true);
    expect(handlesUiRoute("/user/settings/actions/runners/reset_registration_token")).toBe(true);
  });

  it("the landed siblings stay claimed (the import is live, the target genuinely unclaimed)", () => {
    expect(parseUiRoute("/user/settings/actions/secrets")?.family).toBe("user-settings-secrets");
    expect(parseUiRoute("/user/settings/actions/variables")?.family).toBe("user-settings-variables");
  });
});
