/**
 * The repo settings Actions RUNNERS sub-tab's tests (the census C7 arm —
 * the repo arm of the four-scope shared builders, the C8 repo harness over
 * the M1a runner/token store): the WithAvailable list contract (repo-owned +
 * owner + global runners list; a sibling repo's never does; the q facet;
 * the sort ladder with the computed status rank), the registration-token
 * block (first GET CREATES the scope token; the reuse arm; the reset arm's
 * deactivate+insert rotation), the edit page's scope guard + recent tasks,
 * every write arm's outcomes — plus the mounted route matrix: the C8 gate's
 * exact polarity (anonymous 303s, signed-in non-admin 404 shells, the
 * disabled-unit 404 even for the admin), the admin's round-trips with the
 * 303 contracts, the cross-origin 403 before any write, and the scope
 * isolation (a foreign/global runner id never resolves to a write).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import {
  createRunner,
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  insertActionRun,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_SUCCESS,
} from "../../services/actions/model";
import { actionRunnerTokens, actionRunners, actionTasks, repositories, users } from "../../db/schema";
import { locale } from "../locale";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  deleteRepoActionsRunner,
  findRepoScopedRunner,
  loadRepoActionsRunnerEditPageData,
  loadRepoActionsRunnersPageData,
  parseRepoActionsRunnerDescriptionForm,
  parseRepoActionsRunnerDisabledForm,
  renderRepoActionsRunnersPage,
  RepoActionsRunnerEditPage,
  RepoActionsRunnersPage,
  repoSettingsRunnersLocale,
  resetRepoActionsRunnerToken,
  runnerEditableInRepo,
  runnerStatusOf,
  RUNNER_IDLE_MS,
  RUNNER_OFFLINE_MS,
  setRepoActionsRunnerDisabled,
  updateRepoActionsRunnerDescription,
} from "./repo-settings-actions-runners";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The loaders' fixed clock, 5 s after the T0 heartbeat stamps: the module's
// status model (runner.go:127-135 — IDLE past the 10 s lastActive window)
// reads a T0 stamp ACTIVE only within this window, so the loader fixtures'
// "T0 heartbeats" posture needs the clock this close.
const NOW = new Date(T0.getTime() + 5_000);
const ORIGIN = "https://test.local";
const REPO_LINK = "/alice/demo";
const RUNNERS_URL = `${REPO_LINK}/settings/actions/runners`;
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;

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
    "repo_settings",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', 0, unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (2, 'bob', 'bob', 'Bob Doe', 0, unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, 'demo', 'main', 'public', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'bob', 2, 'other', 'main', 'public', unixepoch())",
  ).run();
  repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get())!;
});

/** The actions unit ON — the MustEnableActions arm's happy-path posture. */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

async function seedRunner(options: {
  name: string;
  ownerId?: number;
  repoId?: string;
  labels?: string[];
  version?: string;
  description?: string;
}) {
  const created = await createRunner(env.DB, {
    uuid: `uuid-${options.name}-${options.ownerId ?? 0}-${options.repoId ?? ""}`,
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

// --- the status model ---------------------------------------------------------

describe("runnerStatusOf (ActionRunner.Status, runner.go:127-135)", () => {
  it("active within the idle window, idle within the offline window, offline past it — never-seen is offline", () => {
    expect(runnerStatusOf({ lastOnline: NOW, lastActive: NOW }, NOW)).toBe("active");
    expect(runnerStatusOf({ lastOnline: T0, lastActive: new Date(T0.getTime() - RUNNER_IDLE_MS - 1) }, NOW)).toBe("idle");
    expect(runnerStatusOf({ lastOnline: new Date(T0.getTime() - RUNNER_OFFLINE_MS - 1), lastActive: NOW }, NOW)).toBe("offline");
    expect(runnerStatusOf({ lastOnline: null, lastActive: null }, NOW)).toBe("offline");
  });
});

// --- the list (FindRunnerOptions.ToConds/ToOrders over the repo scope) ----------

describe("loadRepoActionsRunnersPageData (Runners' repo arm, runners.go:102-155)", () => {
  it("lists repo-owned + owner + global runners (WithAvailable), never a sibling repo's", async () => {
    await enableActions();
    const own = await seedRunner({ name: "repo-runner", repoId: repo.id });
    const owner = await seedRunner({ name: "owner-runner", ownerId: 1 });
    const global = await seedRunner({ name: "global-runner" });
    await seedRunner({ name: "foreign-runner", ownerId: 2, repoId: "repo-2" });

    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name).sort()).toEqual(["global-runner", "owner-runner", "repo-runner"]);
    expect(data.total).toBe(3);
    // The registration token rode along (created on the bare GET).
    expect(data.registrationToken).not.toBe("");
    expect(own.id).toBeGreaterThan(0);
    expect(owner.id).toBeGreaterThan(0);
    expect(global.id).toBeGreaterThan(0);
  });

  it("the q facet filters by name LIKE", async () => {
    await enableActions();
    await seedRunner({ name: "fleet-alpha", repoId: repo.id });
    await seedRunner({ name: "fleet-beta", repoId: repo.id });
    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams({ q: "alpha" }), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["fleet-alpha"]);
    expect(data.query).toBe("alpha");
  });

  it("the sort ladder — the default ranks by computed status, alphabetically by name, newest by id", async () => {
    await enableActions();
    const offline = await seedRunner({ name: "z-offline", repoId: repo.id });
    await setRunnerTimes(offline.id, new Date(T0.getTime() - RUNNER_OFFLINE_MS * 2), T0);
    const idle = await seedRunner({ name: "m-idle", repoId: repo.id });
    await setRunnerTimes(idle.id, T0, new Date(T0.getTime() - RUNNER_IDLE_MS * 2));
    const active = await seedRunner({ name: "a-active", repoId: repo.id });
    await setRunnerTimes(active.id, T0, new Date(T0.getTime() - 1_000));

    const byDefault = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    expect(byDefault.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);
    expect(byDefault.runners.map((runner) => runner.status)).toEqual(["active", "idle", "offline"]);

    const byName = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams({ sort: "alphabetically" }), NOW);
    expect(byName.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);

    const byNewest = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams({ sort: "newest" }), NOW);
    expect(byNewest.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]); // creation order

    const byOldest = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams({ sort: "oldest" }), NOW);
    expect(byOldest.runners.map((runner) => runner.row.name)).toEqual(["z-offline", "m-idle", "a-active"]);
  });

  it("the disabled runner sinks within its status rank (is_disabled ASC, ToOrders' arm)", async () => {
    await enableActions();
    const enabled = await seedRunner({ name: "enabled", repoId: repo.id });
    const disabled = await seedRunner({ name: "disabled", repoId: repo.id });
    await drizzle(env.DB).update(actionRunners).set({ isDisabled: true }).where(eq(actionRunners.id, disabled.id));
    await setRunnerTimes(enabled.id, T0, new Date(T0.getTime() - 1_000));
    await setRunnerTimes(disabled.id, T0, new Date(T0.getTime() - 2_000));

    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["enabled", "disabled"]);
  });

  it("the rows carry the computed status, labels and the belongs-to enrichment", async () => {
    await enableActions();
    await seedRunner({ name: "repo-runner", repoId: repo.id, labels: ["ubuntu-latest", "self-hosted"] });
    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    const view = data.runners[0]!;
    expect(view.status).toBe("active"); // T0 heartbeats, 5 s ago, fixed NOW
    expect(view.agentLabels).toEqual(["ubuntu-latest", "self-hosted"]);
    expect(view.belongsTo).toEqual({ type: "repository", text: "Repository", tooltip: "alice/demo" });
  });

  it("the registration token is REUSED while active (GetOrCreateActiveRunnerToken)", async () => {
    await enableActions();
    const first = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    const second = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    expect(second.registrationToken).toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(1); // one scope row, reused — never re-minted
  });
});

// --- the write arms -------------------------------------------------------------

describe("the token block's arms (runner_token.go semantics at the repo scope)", () => {
  it("the bare GET creates the scope's first token; the reset rotates it", async () => {
    await enableActions();
    // No token rows yet — the loader CREATES one (runner_token.go:127-134).
    // The model's missing-row shape is null (RunnerTokenRow | null).
    expect(await getLatestRunnerToken(env.DB, 0, repo.id)).toBeNull();
    const first = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    const stored = await getLatestRunnerToken(env.DB, 0, repo.id);
    expect(stored?.isActive).toBe(true);

    // The reset mints a fresh token and deactivates the scope's old one
    // (NewRunnerTokenWithValue's same-scope sweep); other scopes are untouched.
    const next = await resetRepoActionsRunnerToken(env.DB, repo.id);
    expect(next).not.toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.token === first.registrationToken)?.isActive).toBe(false);
    expect(rows.find((row) => row.token === next)?.isActive).toBe(true);

    // The next GET renders the NEW token.
    const reloaded = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    expect(reloaded.registrationToken).toBe(next);
  });

  it("the reset is scope-guarded — another repo's token is untouched", async () => {
    await enableActions();
    // Capture the neighbor's token BEFORE the reset — the guard's pin is
    // that repo-2's row survives repo-1's rotation byte-for-byte (the
    // scopes are per-repo distinct: normalizeTokenScope).
    const theirsBefore = await getOrCreateActiveRunnerToken(env.DB, 0, "repo-2");
    await getOrCreateActiveRunnerToken(env.DB, 0, repo.id);
    await resetRepoActionsRunnerToken(env.DB, repo.id);
    const theirs = await getLatestRunnerToken(env.DB, 0, "repo-2");
    expect(theirs?.isActive).toBe(true);
    expect(theirs?.token).toBe(theirsBefore.token);
  });
});

describe("findRepoScopedRunner + the write arms (findActionsRunner's repo arm)", () => {
  let ownRunnerId: number;
  let globalRunnerId: number;

  beforeEach(async () => {
    await enableActions();
    ownRunnerId = (await seedRunner({ name: "own", repoId: repo.id })).id;
    globalRunnerId = (await seedRunner({ name: "global" })).id;
  });

  it("resolves only the repo's OWN rows — a global runner is the NotFound arm", async () => {
    expect((await findRepoScopedRunner(env.DB, repo.id, ownRunnerId))?.id).toBe(ownRunnerId);
    expect(await findRepoScopedRunner(env.DB, repo.id, globalRunnerId)).toBeNull();
    expect(await findRepoScopedRunner(env.DB, repo.id, 999_999)).toBeNull();
    expect(await findRepoScopedRunner(env.DB, repo.id, 0)).toBeNull();
    expect(runnerEditableInRepo({ repoId: repo.id }, repo.id)).toBe(true);
    expect(runnerEditableInRepo({ repoId: "" }, repo.id)).toBe(false);
  });

  it("the description update overwrites and reports missing for a foreign id", async () => {
    expect(await updateRepoActionsRunnerDescription(env.DB, repo.id, ownRunnerId, "the fleet workhorse")).toBe("updated");
    expect((await findRepoScopedRunner(env.DB, repo.id, ownRunnerId))?.description).toBe("the fleet workhorse");
    expect(await updateRepoActionsRunnerDescription(env.DB, repo.id, globalRunnerId, "nope")).toBe("missing");
  });

  it("the disabled flip toggles isDisabled both ways", async () => {
    expect(await setRepoActionsRunnerDisabled(env.DB, repo.id, ownRunnerId, true)).toBe("updated");
    expect((await findRepoScopedRunner(env.DB, repo.id, ownRunnerId))?.isDisabled).toBe(true);
    expect(await setRepoActionsRunnerDisabled(env.DB, repo.id, ownRunnerId, false)).toBe("updated");
    expect((await findRepoScopedRunner(env.DB, repo.id, ownRunnerId))?.isDisabled).toBe(false);
    expect(await setRepoActionsRunnerDisabled(env.DB, repo.id, globalRunnerId, true)).toBe("missing");
  });

  it("the delete is a hard delete; a foreign/stale id deletes nothing", async () => {
    expect(await deleteRepoActionsRunner(env.DB, repo.id, globalRunnerId)).toBe("missing");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, globalRunnerId))).toHaveLength(1);
    expect(await deleteRepoActionsRunner(env.DB, repo.id, ownRunnerId)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, ownRunnerId))).toHaveLength(0);
    expect(await deleteRepoActionsRunner(env.DB, repo.id, ownRunnerId)).toBe("missing"); // idempotent-missing
  });
});

// --- the edit page's recent tasks ------------------------------------------------

describe("loadRepoActionsRunnerEditPageData (RunnersEdit, runners.go:158-210)", () => {
  it("answers null for a foreign runner (the scope guard IS EditableInContext's repo arm)", async () => {
    await enableActions();
    const global = await seedRunner({ name: "global" });
    expect(await loadRepoActionsRunnerEditPageData(env.DB, repo, global.id, new URLSearchParams(), NOW)).toBeNull();
  });

  it("loads the runner plus its recent tasks, newest first, with the job/repo enrichment", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id });
    const { jobRows } = await insertActionRun(
      env.DB,
      {
        repoId: repo.id,
        ownerId: 1,
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
    // Two tasks on the runner — one finished, one live.
    const finishedAt = new Date(T0.getTime() + 60_000);
    await drizzle(env.DB).insert(actionTasks).values([
      {
        jobId: claimed.id,
        runnerId: runner.id,
        status: ACTION_STATUS_SUCCESS,
        repoId: repo.id,
        ownerId: 1,
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
        repoId: repo.id,
        ownerId: 1,
        commitSha: SHA,
        tokenHash: `hash-b-${runner.id}`,
        tokenSalt: "salt",
        started: T1_OF(T0),
        created: T1_OF(T0),
        updated: T1_OF(T0),
      },
    ]);

    const data = await loadRepoActionsRunnerEditPageData(env.DB, repo, runner.id, new URLSearchParams(), NOW);
    expect(data).not.toBeNull();
    expect(data!.runner.name).toBe("own");
    expect(data!.tasks).toHaveLength(2);
    expect(data!.tasks.map((task) => task.status)).toEqual([ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS]); // id DESC
    expect(data!.tasks[1]!.jobId).toBe(claimed.id);
    expect(data!.tasks[1]!.repoLink).toBe(REPO_LINK);
    expect(data!.tasks[1]!.commitSha).toBe(SHA);
    expect(data!.tasks[1]!.stopped).toEqual(finishedAt);
    expect(data!.tasks[0]!.stopped).toBeNull();
    expect(data!.belongsTo.text).toBe("Repository");
  });

  /** The second-granularity helper (the task fixtures' started stamp). */
  function T1_OF(base: Date): Date {
    return new Date(base.getTime() + 1_000);
  }
});

// --- the forms ------------------------------------------------------------------

describe("the form parsers", () => {
  it("the description form parses its single field (absent → empty)", () => {
    expect(parseRepoActionsRunnerDescriptionForm(new URLSearchParams({ description: "d" }))).toEqual({ description: "d" });
    expect(parseRepoActionsRunnerDescriptionForm(new URLSearchParams())).toEqual({ description: "" });
  });

  it("the disabled form parses the bool spellings; absent is the 400 arm", () => {
    expect(parseRepoActionsRunnerDisabledForm(new URLSearchParams({ disabled: "true" }))).toEqual({ disabled: true });
    expect(parseRepoActionsRunnerDisabledForm(new URLSearchParams({ disabled: "false" }))).toEqual({ disabled: false });
    expect(parseRepoActionsRunnerDisabledForm(new URLSearchParams({ disabled: "1" }))).toEqual({ disabled: true });
    expect(parseRepoActionsRunnerDisabledForm(new URLSearchParams({ disabled: "junk" }))).toEqual({ disabled: false });
    expect(parseRepoActionsRunnerDisabledForm(new URLSearchParams())).toEqual({ disabled: null });
  });
});

// --- the DOM contracts ------------------------------------------------------------

describe("the page renders (runner_list.tmpl / runner_edit.tmpl)", () => {
  it("the runners page carries the settings-actions pageClass, the token panel and the rows", async () => {
    await enableActions();
    const repoRunner = await seedRunner({ name: "repo-runner", repoId: repo.id, labels: ["ubuntu-latest"], description: "own machine" });
    await seedRunner({ name: "owner-runner", ownerId: 1 });
    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE; C1's seededHtml pattern).
    const html = renderRepoActionsRunnersPage({ ...ctx, repo }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("repository settings actions");
    expect(html).toContain(repoSettingsRunnersLocale.runner_manage_panel);
    expect(html).toContain(`Total ${data.total}`);
    // The token panel: the readonly input + the clipboard hook + the reset form.
    expect(html).toContain(`value="${data.registrationToken}"`);
    expect(html).toContain(`data-clipboard-text="${data.registrationToken}"`);
    expect(html).toContain(`action="${RUNNERS_URL}/reset_registration_token"`);
    // The rows: the repo runner's pencil, the owner runner's none (the
    // EditableInContext conditional); labels, tooltips.
    expect(html).toContain(`href="${RUNNERS_URL}/${repoRunner.id}"`);
    expect(html).toContain("own machine");
    expect(html).toContain("ubuntu-latest");
    expect(html).toContain('class="ui label green"'); // the active status label
    expect(() => RepoActionsRunnersPage({ ctx, data })).toThrow("RepoActionsRunnersPage requires ctx.repo");
  });

  it("the owner/global rows render Type but NO pencil (the WithAvailable list)", async () => {
    await enableActions();
    await seedRunner({ name: "owner-runner", ownerId: 1 });
    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    const html = renderToString(<RepoActionsRunnersPage ctx={{ ...ctx, repo }} data={data} />);
    expect(html).toContain("User"); // concept_user_user
    expect(html).not.toContain(`href="${RUNNERS_URL}/`); // no edit links at all
    expect(html).not.toContain('data-sortt-asc=""'); // the sort headers ride
    expect(html).toContain('data-sortt-asc="alphabetically"');
  });

  it("the empty list renders the none line", async () => {
    await enableActions();
    const data = await loadRepoActionsRunnersPageData(env.DB, repo, new URLSearchParams(), NOW);
    const html = renderToString(<RepoActionsRunnersPage ctx={{ ...ctx, repo }} data={data} />);
    expect(html).toContain(repoSettingsRunnersLocale.none);
  });

  it("the edit page renders the basic-info fields, the three write forms and the tasks table", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id, description: "desc-1" });
    const data = (await loadRepoActionsRunnerEditPageData(env.DB, repo, runner.id, new URLSearchParams(), NOW))!;
    const html = renderToString(<RepoActionsRunnerEditPage ctx={{ ...ctx, repo }} data={data} />);
    expect(html).toContain("repository settings actions");
    expect(html).toContain(`${repoSettingsRunnersLocale.runner_title} ${runner.id} own`);
    expect(html).toContain('value="desc-1"');
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}"`); // the description POST
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}/update-runner"`); // the flip POST
    expect(html).toContain(`action="${RUNNERS_URL}/${runner.id}/delete"`); // the delete POST
    expect(html).toContain('name="disabled" value="true"'); // the flip's next state
    expect(html).toContain(repoSettingsRunnersLocale.task_list_no_tasks);
    expect(() => RepoActionsRunnerEditPage({ ctx, data })).toThrow("RepoActionsRunnerEditPage requires ctx.repo");
  });
});

// --- the mounted route arms ---------------------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

async function postRoute(path: string, userId: number, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await sessionCookie(userId),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain(repoSettingsRunnersLocale.runner_manage_panel);
}

describe("the mounted runners routes (the census C7 mount: the minted-session route-level matrix)", () => {
  let bobId: number;

  beforeEach(async () => {
    const [bob] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "bob2", usernameLower: "bob2", status: "active", createdAt: T0 })
      .returning()
      .all();
    if (bob === undefined) throw new Error("non-admin seed failed");
    bobId = bob.id;
  });

  it("the parse claims exactly the six runners shapes", () => {
    expect(parseUiRoute(`${RUNNERS_URL}`)).toMatchObject({ family: "settings-actions-runners", owner: "alice", repo: "demo" });
    expect(parseUiRoute(`${RUNNERS_URL}/reset_registration_token`)).toMatchObject({ family: "settings-actions-runners-token-reset" });
    expect(parseUiRoute(`${RUNNERS_URL}/7`)).toMatchObject({ family: "settings-actions-runners-edit", id: 7 });
    expect(parseUiRoute(`${RUNNERS_URL}/7/update-runner`)).toMatchObject({ family: "settings-actions-runners-update", id: 7 });
    expect(parseUiRoute(`${RUNNERS_URL}/7/delete`)).toMatchObject({ family: "settings-actions-runners-delete", id: 7 });
    // Junk ids and deeper tails never claim; the literal beats the combo.
    expect(parseUiRoute(`${RUNNERS_URL}/junk`)).toBeNull();
    expect(parseUiRoute(`${RUNNERS_URL}/7/extra`)).toBeNull();
    expect(handlesUiRoute(`${RUNNERS_URL}`)).toBe(true);
  });

  it("303s an anonymous GET onto the login round-trip (the settingsGate)", async () => {
    await enableActions();
    const res = await getRoute(RUNNERS_URL, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(RUNNERS_URL)}`);
  });

  it("404-shells a signed-in non-admin (bob) on GET and POST — nothing written", async () => {
    await enableActions();
    await expectNotFoundShell(await getRoute(RUNNERS_URL, bobId));
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/reset_registration_token`, bobId, {}));
    expect(await drizzle(env.DB).select().from(actionRunnerTokens).all()).toHaveLength(0); // nothing minted
  });

  it("404-shells even the ADMIN while the actions unit is disabled (the C8 gate's polarity)", async () => {
    await expectNotFoundShell(await getRoute(RUNNERS_URL, 1));
    await expectNotFoundShell(await getRoute(`${RUNNERS_URL}/1`, 1));
    await enableActions();
    expect((await getRoute(RUNNERS_URL, 1)).status).toBe(200);
    expect((await getRoute(`${RUNNERS_URL}/1`, 1)).status).toBe(404); // the runner row is absent — the scope 404, not the gate's
  });

  it("403s a cross-origin POST before any write (the sameOriginGuard)", async () => {
    await enableActions();
    const res = await postRoute(`${RUNNERS_URL}/reset_registration_token`, 1, {}, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await drizzle(env.DB).select().from(actionRunnerTokens).all()).toHaveLength(0);
  });

  it("the admin's GET creates the scope token and the page renders it (the round-trip)", async () => {
    await enableActions();
    const first = await getRoute(RUNNERS_URL, 1);
    expect(first.status).toBe(200);
    const tokenRow = await getOrCreateActiveRunnerToken(env.DB, 0, repo.id);
    const html = await first.text();
    expect(html).toContain(`value="${tokenRow.token}"`);
    // The second GET reuses the SAME token (no re-mint).
    const second = await getRoute(RUNNERS_URL, 1);
    expect((await second.text())).toContain(`value="${tokenRow.token}"`);
  });

  it("the reset POST rotates the token and 303s back onto the list", async () => {
    await enableActions();
    const before = await getOrCreateActiveRunnerToken(env.DB, 0, repo.id);
    const res = await postRoute(`${RUNNERS_URL}/reset_registration_token`, 1, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    const after = await getLatestRunnerToken(env.DB, 0, repo.id);
    expect(after?.token).not.toBe(before.token);
    expect(after?.isActive).toBe(true);
    const page = await getRoute(RUNNERS_URL, 1);
    expect((await page.text())).toContain(`value="${after?.token}"`);
  });

  it("the description POST persists and 303s onto the list; a foreign id 404-shells", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id });
    const res = await postRoute(`${RUNNERS_URL}/${runner.id}`, 1, { description: "the workhorse" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    expect((await findRepoScopedRunner(env.DB, repo.id, runner.id))?.description).toBe("the workhorse");

    const globalRunner = await seedRunner({ name: "global" });
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/${globalRunner.id}`, 1, { description: "nope" }));
  });

  it("the update-runner POST flips isDisabled; an absent param answers the 400; success 303s onto the edit page", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id });
    const flip = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, { disabled: "true" });
    expect(flip.status).toBe(303);
    expect(flip.headers.get("location")).toBe(`${RUNNERS_URL}/${runner.id}`);
    expect((await findRepoScopedRunner(env.DB, repo.id, runner.id))?.isDisabled).toBe(true);
    // The flip-back arm carries the edit page's shape.
    const flipBack = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, { disabled: "false" });
    expect(flipBack.status).toBe(303);
    expect((await findRepoScopedRunner(env.DB, repo.id, runner.id))?.isDisabled).toBe(false);
    // The missing-parameter arm — upstream's exact 400 text.
    const missing = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, {});
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing 'disabled' parameter");
  });

  it("the delete POST removes the row and 303s onto the list; a foreign id 404-shells", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id });
    const globalRunner = await seedRunner({ name: "global" });
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/${globalRunner.id}/delete`, 1, {}));
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, globalRunner.id))).toHaveLength(1);
    const res = await postRoute(`${RUNNERS_URL}/${runner.id}/delete`, 1, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, runner.id))).toHaveLength(0);
  });

  it("the edit GET renders the runner page through the mount", async () => {
    await enableActions();
    const runner = await seedRunner({ name: "own", repoId: repo.id });
    const res = await getRoute(`${RUNNERS_URL}/${runner.id}`, 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`${repoSettingsRunnersLocale.runner_title} ${runner.id} own`);
    // The POST twins' GETs answer chi's 405.
    expect((await getRoute(`${RUNNERS_URL}/reset_registration_token`, 1)).status).toBe(405);
    expect((await getRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1)).status).toBe(405);
    expect((await getRoute(`${RUNNERS_URL}/${runner.id}/delete`, 1)).status).toBe(405);
    expect((await postRoute(RUNNERS_URL, 1, {})).status).toBe(405); // the list POST twin
  });
});
