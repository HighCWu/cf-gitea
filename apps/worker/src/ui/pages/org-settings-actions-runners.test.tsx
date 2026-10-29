/**
 * The org settings Actions RUNNERS sub-tab's tests (the census C7 arm's ORG
 * scope — the org twin of repo-settings-actions-runners.test.tsx over the
 * M1a runner/token store): the WithAvailable ORG cond (org-owned + global
 * runners list; a repo-scoped runner — even the org's own repo's — never
 * does; another org's never; the q facet; the sort ladder with the computed
 * status rank), the registration-token block at the (orgId, "") scope (first
 * GET CREATES the token; the reuse arm; the reset arm's deactivate+insert
 * rotation scope-guarded against a repo scope AND a rival org's), the edit
 * page's scope guard + recent tasks, every write arm's outcomes — plus the
 * mounted route matrix: the require-owner gate's exact polarity (anonymous
 * 303s, a signed-in member 404-shells, a non-member 404-shells — nothing
 * written), the owner's round-trips with the 303 contracts, the cross-origin
 * 403 before any write, and the cross-org scope isolation (a foreign org's
 * runner id never resolves to a read or a write through either org's URLs).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createRunner,
  getLatestRunnerToken,
  getOrCreateActiveRunnerToken,
  insertActionRun,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_SUCCESS,
} from "../../services/actions/model";
import { actionRunnerTokens, actionRunners, actionTasks, orgMembers, users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { locale } from "../locale";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  deleteOrgActionsRunner,
  findOrgScopedRunner,
  loadOrgActionsRunnerEditPageData,
  loadOrgActionsRunnersPageData,
  orgSettingsRunnersLocale,
  parseOrgActionsRunnerDescriptionForm,
  parseOrgActionsRunnerDisabledForm,
  renderOrgActionsRunnerEditPage,
  renderOrgActionsRunnersPage,
  resetOrgActionsRunnerToken,
  runnerEditableInOrg,
  setOrgActionsRunnerDisabled,
  updateOrgActionsRunnerDescription,
  OrgActionsRunnersPage,
} from "./org-settings-actions-runners";
import { repoSettingsRunnersLocale, RUNNER_IDLE_MS, RUNNER_OFFLINE_MS } from "./repo-settings-actions-runners";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The loaders' fixed clock, 5 s after the T0 heartbeat stamps (the repo
// twin's posture: the status ladder reads a T0 stamp ACTIVE only within the
// 10 s lastActive window).
const NOW = new Date(T0.getTime() + 5_000);
const ORIGIN = "https://test.local";
const ORG_ID = 7;
const ORG_LINK = "/coalition";
const RUNNERS_URL = `${ORG_LINK}/settings/actions/runners`;
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

const org: OrgRecord = {
  id: ORG_ID,
  username: "coalition",
  usernameLower: "coalition",
  email: null,
  fullName: "The Coalition",
  description: null,
  website: null,
  location: null,
  avatarEmail: null,
  useCustomAvatar: false,
  visibility: "public",
  numMembers: 2,
  repoAdminChangeTeamAccess: false,
  createdAt: T0,
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
    "org_members",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', 0, unixepoch())",
  ).run();
  // The org's users-table row (id = ORG_ID, the type-org member) — the
  // loaders' belongsTo enrichment joins it (Owner.Type → Organization).
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
    uuid: `uuid-org-${options.name}-${options.ownerId ?? 0}-${options.repoId ?? ""}`,
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

async function seedOrgRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'coalition', 7, 'demo', 'main', 'public', unixepoch())",
  ).run();
  return "repo-1";
}

// --- the list (FindRunnerOptions.ToConds over the ORG scope) --------------------

describe("loadOrgActionsRunnersPageData (Runners' org arm, runners.go:102-155)", () => {
  it("lists org-owned + global runners; never a repo-scoped runner (even the org's own repo's), never another org's", async () => {
    const own = await seedRunner({ name: "org-runner", ownerId: ORG_ID });
    const global = await seedRunner({ name: "global-runner" });
    await seedRunner({ name: "own-repo-runner", repoId: await seedOrgRepo() }); // the org's OWN repo's runner stays invisible
    await seedRunner({ name: "rival-runner", ownerId: 8 }); // another org's
    await seedRunner({ name: "user-runner", ownerId: 1 }); // a plain user's

    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name).sort()).toEqual(["global-runner", "org-runner"]);
    expect(data.total).toBe(2);
    // The registration token rode along (created on the bare GET).
    expect(data.registrationToken).not.toBe("");
    expect(own.id).toBeGreaterThan(0);
    expect(global.id).toBeGreaterThan(0);
  });

  it("the q facet filters by name LIKE", async () => {
    await seedRunner({ name: "fleet-alpha", ownerId: ORG_ID });
    await seedRunner({ name: "fleet-beta", ownerId: ORG_ID });
    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams({ q: "alpha" }), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["fleet-alpha"]);
    expect(data.query).toBe("alpha");
  });

  it("the sort ladder — the default ranks by computed status, alphabetically by name, newest/oldest by id", async () => {
    const offline = await seedRunner({ name: "z-offline", ownerId: ORG_ID });
    await setRunnerTimes(offline.id, new Date(T0.getTime() - RUNNER_OFFLINE_MS * 2), T0);
    const idle = await seedRunner({ name: "m-idle", ownerId: ORG_ID });
    await setRunnerTimes(idle.id, T0, new Date(T0.getTime() - RUNNER_IDLE_MS * 2));
    const active = await seedRunner({ name: "a-active", ownerId: ORG_ID });
    await setRunnerTimes(active.id, T0, new Date(T0.getTime() - 1_000));

    const byDefault = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    expect(byDefault.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);
    expect(byDefault.runners.map((runner) => runner.status)).toEqual(["active", "idle", "offline"]);

    const byName = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams({ sort: "alphabetically" }), NOW);
    expect(byName.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]);

    const byNewest = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams({ sort: "newest" }), NOW);
    expect(byNewest.runners.map((runner) => runner.row.name)).toEqual(["a-active", "m-idle", "z-offline"]); // creation order

    const byOldest = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams({ sort: "oldest" }), NOW);
    expect(byOldest.runners.map((runner) => runner.row.name)).toEqual(["z-offline", "m-idle", "a-active"]);
  });

  it("the disabled runner sinks within its status rank (is_disabled ASC, ToOrders' arm)", async () => {
    const enabled = await seedRunner({ name: "enabled", ownerId: ORG_ID });
    const disabled = await seedRunner({ name: "disabled", ownerId: ORG_ID });
    await drizzle(env.DB).update(actionRunners).set({ isDisabled: true }).where(eq(actionRunners.id, disabled.id));
    await setRunnerTimes(enabled.id, T0, new Date(T0.getTime() - 1_000));
    await setRunnerTimes(disabled.id, T0, new Date(T0.getTime() - 2_000));

    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    expect(data.runners.map((runner) => runner.row.name)).toEqual(["enabled", "disabled"]);
  });

  it("the rows carry the computed status, labels and the org/global belongs-to enrichment", async () => {
    await seedRunner({ name: "org-runner", ownerId: ORG_ID, labels: ["ubuntu-latest", "self-hosted"] });
    await seedRunner({ name: "global-runner" });
    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    const orgRow = data.runners.find((runner) => runner.row.name === "org-runner")!;
    expect(orgRow.status).toBe("active"); // T0 heartbeats, 5 s ago, fixed NOW
    expect(orgRow.agentLabels).toEqual(["ubuntu-latest", "self-hosted"]);
    expect(orgRow.belongsTo).toEqual({ type: "organization", text: "Organization", tooltip: "coalition" });
    const globalRow = data.runners.find((runner) => runner.row.name === "global-runner")!;
    expect(globalRow.belongsTo).toEqual({ type: "system-global", text: "Global", tooltip: null });
  });

  it("the registration token is REUSED while active (GetOrCreateActiveRunnerToken at the org scope)", async () => {
    const first = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    const second = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    expect(second.registrationToken).toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(1); // one scope row, reused — never re-minted
    expect(rows[0]!.ownerId).toBe(ORG_ID);
    expect(rows[0]!.repoId).toBe(""); // the org scope's repoId arm
  });
});

// --- the token block's arms (runner_token.go semantics at the org scope) --------

describe("the token block's arms (runner_token.go semantics at the org scope)", () => {
  it("the bare GET creates the scope's first token; the reset rotates it", async () => {
    // No token rows yet — the loader CREATES one (runner_token.go:127-134).
    expect(await getLatestRunnerToken(env.DB, ORG_ID, "")).toBeNull();
    const first = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    const stored = await getLatestRunnerToken(env.DB, ORG_ID, "");
    expect(stored?.isActive).toBe(true);

    // The reset mints a fresh token and deactivates the scope's old one
    // (NewRunnerTokenWithValue's same-scope sweep); other scopes are untouched.
    const next = await resetOrgActionsRunnerToken(env.DB, ORG_ID);
    expect(next).not.toBe(first.registrationToken);
    const rows = await drizzle(env.DB).select().from(actionRunnerTokens).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.token === first.registrationToken)?.isActive).toBe(false);
    expect(rows.find((row) => row.token === next)?.isActive).toBe(true);

    // The next GET renders the NEW token.
    const reloaded = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    expect(reloaded.registrationToken).toBe(next);
  });

  it("the reset is scope-guarded — a rival org's token AND a repo scope's token are untouched", async () => {
    // Capture the neighbors' tokens BEFORE the reset — the guard's pin is
    // that (8, "") and (0, "repo-1") survive (7, "")'s rotation byte-for-byte
    // (the scopes are per-owner/repo distinct: normalizeTokenScope).
    const rivalsBefore = await getOrCreateActiveRunnerToken(env.DB, 8, "");
    const repoScopeBefore = await getOrCreateActiveRunnerToken(env.DB, 0, "repo-1");
    await getOrCreateActiveRunnerToken(env.DB, ORG_ID, "");
    await resetOrgActionsRunnerToken(env.DB, ORG_ID);
    const rivals = await getLatestRunnerToken(env.DB, 8, "");
    expect(rivals?.isActive).toBe(true);
    expect(rivals?.token).toBe(rivalsBefore.token);
    const repoScope = await getLatestRunnerToken(env.DB, 0, "repo-1");
    expect(repoScope?.isActive).toBe(true);
    expect(repoScope?.token).toBe(repoScopeBefore.token);
  });
});

// --- the write arms --------------------------------------------------------------

describe("findOrgScopedRunner + the write arms (findActionsRunner's ORG arm)", () => {
  let ownRunnerId: number;
  let globalRunnerId: number;
  let rivalRunnerId: number;

  beforeEach(async () => {
    ownRunnerId = (await seedRunner({ name: "own", ownerId: ORG_ID })).id;
    globalRunnerId = (await seedRunner({ name: "global" })).id;
    rivalRunnerId = (await seedRunner({ name: "rival", ownerId: 8 })).id;
  });

  it("resolves only the org's OWN rows — a GLOBAL runner is the NotFound arm (no WithAvailable at the find)", async () => {
    expect((await findOrgScopedRunner(env.DB, ORG_ID, ownRunnerId))?.id).toBe(ownRunnerId);
    expect(await findOrgScopedRunner(env.DB, ORG_ID, globalRunnerId)).toBeNull();
    expect(await findOrgScopedRunner(env.DB, ORG_ID, rivalRunnerId)).toBeNull();
    expect(await findOrgScopedRunner(env.DB, ORG_ID, 999_999)).toBeNull();
    expect(await findOrgScopedRunner(env.DB, ORG_ID, 0)).toBeNull();
    expect(runnerEditableInOrg({ ownerId: ORG_ID }, ORG_ID)).toBe(true);
    expect(runnerEditableInOrg({ ownerId: 0 }, ORG_ID)).toBe(false);
  });

  it("the description update overwrites and reports missing for a foreign/global id", async () => {
    expect(await updateOrgActionsRunnerDescription(env.DB, ORG_ID, ownRunnerId, "the fleet workhorse")).toBe("updated");
    expect((await findOrgScopedRunner(env.DB, ORG_ID, ownRunnerId))?.description).toBe("the fleet workhorse");
    expect(await updateOrgActionsRunnerDescription(env.DB, ORG_ID, globalRunnerId, "nope")).toBe("missing");
    expect(await updateOrgActionsRunnerDescription(env.DB, ORG_ID, rivalRunnerId, "nope")).toBe("missing");
  });

  it("the disabled flip toggles isDisabled both ways", async () => {
    expect(await setOrgActionsRunnerDisabled(env.DB, ORG_ID, ownRunnerId, true)).toBe("updated");
    expect((await findOrgScopedRunner(env.DB, ORG_ID, ownRunnerId))?.isDisabled).toBe(true);
    expect(await setOrgActionsRunnerDisabled(env.DB, ORG_ID, ownRunnerId, false)).toBe("updated");
    expect((await findOrgScopedRunner(env.DB, ORG_ID, ownRunnerId))?.isDisabled).toBe(false);
    expect(await setOrgActionsRunnerDisabled(env.DB, ORG_ID, globalRunnerId, true)).toBe("missing");
  });

  it("the delete is a hard delete; a foreign/global/stale id deletes nothing", async () => {
    expect(await deleteOrgActionsRunner(env.DB, ORG_ID, globalRunnerId)).toBe("missing");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, globalRunnerId))).toHaveLength(1);
    expect(await deleteOrgActionsRunner(env.DB, ORG_ID, rivalRunnerId)).toBe("missing");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, rivalRunnerId))).toHaveLength(1);
    expect(await deleteOrgActionsRunner(env.DB, ORG_ID, ownRunnerId)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, ownRunnerId))).toHaveLength(0);
    expect(await deleteOrgActionsRunner(env.DB, ORG_ID, ownRunnerId)).toBe("missing"); // idempotent-missing
  });
});

// --- the edit page's recent tasks ------------------------------------------------

describe("loadOrgActionsRunnerEditPageData (RunnersEdit, runners.go:158-216)", () => {
  it("answers null for a global runner (the scope guard IS EditableInContext's owner arm)", async () => {
    const global = await seedRunner({ name: "global" });
    expect(await loadOrgActionsRunnerEditPageData(env.DB, org, global.id, new URLSearchParams(), NOW)).toBeNull();
  });

  it("loads the runner plus its recent tasks, newest first, with the job/repo enrichment and the org belongs-to", async () => {
    const repoId = await seedOrgRepo();
    const runner = await seedRunner({ name: "own", ownerId: ORG_ID, description: "desc-1" });
    const { jobRows } = await insertActionRun(
      env.DB,
      {
        repoId,
        ownerId: ORG_ID,
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
        repoId,
        ownerId: ORG_ID,
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
        ownerId: ORG_ID,
        commitSha: SHA,
        tokenHash: `hash-b-${runner.id}`,
        tokenSalt: "salt",
        started: new Date(T0.getTime() + 1_000),
        created: new Date(T0.getTime() + 1_000),
        updated: new Date(T0.getTime() + 1_000),
      },
    ]);

    const data = await loadOrgActionsRunnerEditPageData(env.DB, org, runner.id, new URLSearchParams(), NOW);
    expect(data).not.toBeNull();
    expect(data!.runner.name).toBe("own");
    expect(data!.tasks).toHaveLength(2);
    expect(data!.tasks.map((task) => task.status)).toEqual([ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS]); // id DESC
    expect(data!.tasks[1]!.jobId).toBe(claimed.id);
    expect(data!.tasks[1]!.repoLink).toBe("/coalition/demo");
    expect(data!.tasks[1]!.commitSha).toBe(SHA);
    expect(data!.tasks[1]!.stopped).toEqual(finishedAt);
    expect(data!.tasks[0]!.stopped).toBeNull();
    expect(data!.belongsTo).toEqual({ type: "organization", text: "Organization", tooltip: "coalition" });
  });
});

// --- the forms ------------------------------------------------------------------

describe("the form parsers (the shared scope-neutral readers, org-named delegates)", () => {
  it("the description form parses its single field (absent → empty)", () => {
    expect(parseOrgActionsRunnerDescriptionForm(new URLSearchParams({ description: "d" }))).toEqual({ description: "d" });
    expect(parseOrgActionsRunnerDescriptionForm(new URLSearchParams())).toEqual({ description: "" });
  });

  it("the disabled form parses the bool spellings; absent is the 400 arm", () => {
    expect(parseOrgActionsRunnerDisabledForm(new URLSearchParams({ disabled: "true" }))).toEqual({ disabled: true });
    expect(parseOrgActionsRunnerDisabledForm(new URLSearchParams({ disabled: "false" }))).toEqual({ disabled: false });
    expect(parseOrgActionsRunnerDisabledForm(new URLSearchParams({ disabled: "1" }))).toEqual({ disabled: true });
    expect(parseOrgActionsRunnerDisabledForm(new URLSearchParams({ disabled: "junk" }))).toEqual({ disabled: false });
    expect(parseOrgActionsRunnerDisabledForm(new URLSearchParams())).toEqual({ disabled: null });
  });
});

// --- the DOM contracts ------------------------------------------------------------

describe("the page renders (org/settings/actions.tmpl + org/settings/runners_edit.tmpl)", () => {
  it("the runners page carries the org settings-actions pageClass, the shared nav's active Runners item and the token panel", async () => {
    const orgRunner = await seedRunner({ name: "org-runner", ownerId: ORG_ID, labels: ["ubuntu-latest"], description: "own machine" });
    await seedRunner({ name: "global-runner" });
    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE).
    const html = renderOrgActionsRunnersPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("organization settings actions");
    expect(html).toContain(repoSettingsRunnersLocale.runner_manage_panel);
    expect(html).toContain(`Total ${data.total}`);
    // The org navbar's Actions disclosure is OPEN with Runners active.
    expect(html).toContain('<details class="item" open');
    expect(html).toContain(`class="active item" href="${RUNNERS_URL}"`);
    // The token panel: the readonly input + the clipboard hook + the reset form.
    expect(html).toContain(`value="${data.registrationToken}"`);
    expect(html).toContain(`data-clipboard-text="${data.registrationToken}"`);
    expect(html).toContain(`action="${RUNNERS_URL}/reset_registration_token"`);
    // The rows: the org runner's pencil, the global runner's none (the
    // EditableInContext conditional); labels, tooltips.
    expect(html).toContain(`href="${RUNNERS_URL}/${orgRunner.id}"`);
    expect(html).toContain("own machine");
    expect(html).toContain("ubuntu-latest");
    expect(html).toContain("Organization");
    expect(html).toContain('class="ui label green"'); // the active status label
  });

  it("the global rows render Type but NO pencil (the WithAvailable list)", async () => {
    await seedRunner({ name: "global-runner" });
    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    const html = renderToString(<OrgActionsRunnersPage ctx={ctx} data={data} />);
    expect(html).toContain("Global"); // concept_system_global
    expect(html).not.toContain(`href="${RUNNERS_URL}/`); // no edit links at all
    expect(html).toContain('data-sortt-asc="alphabetically"'); // the sort headers ride
  });

  it("the empty list renders the none line", async () => {
    const data = await loadOrgActionsRunnersPageData(env.DB, org, new URLSearchParams(), NOW);
    const html = renderToString(<OrgActionsRunnersPage ctx={ctx} data={data} />);
    expect(html).toContain(repoSettingsRunnersLocale.none);
  });

  it("the edit page renders the org runners pageClass, the basic-info fields, the three write forms and the tasks table", async () => {
    const runner = await seedRunner({ name: "own", ownerId: ORG_ID, description: "desc-1" });
    const data = (await loadOrgActionsRunnerEditPageData(env.DB, org, runner.id, new URLSearchParams(), NOW))!;
    const html = renderOrgActionsRunnerEditPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("organization settings runners"); // runners_edit.tmpl:1 — the org family's DISTINCT class
    expect(html).toContain(orgSettingsRunnersLocale.edit_runner); // the Title (actions.runners.edit_runner)
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

describe("the mounted org runners routes (the census C7 org mount: the minted-session route-level matrix)", () => {
  /** The route world's REAL users-table rows (the `org` fixture above is the
   *  module-level render input; the routes resolve through OrgService): the
   *  coalition org (the file-level beforeEach's id-7 row) with alice as
   *  owner and bob as a plain member, plus the rival org (carol's) and dave
   *  (no membership anywhere) for the gate/scope arms. Ids are captured at
   *  seed time — never hardcoded. */
  interface OrgWorld {
    coalitionId: number;
    rivalsId: number;
    bobId: number;
    daveId: number;
  }

  let world: OrgWorld;

  beforeEach(async () => {
    // The file-level beforeEach re-seeded alice (1) + coalition (7); this
    // stage seeds the rest of the world.
    const coalition = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "coalition")).get();
    const [rivals] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "rivals", usernameLower: "rivals", type: "org", status: "active", createdAt: T0 })
      .returning()
      .all();
    const [bob] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "bob", usernameLower: "bob", status: "active", createdAt: T0 })
      .returning()
      .all();
    const [carol] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "carol", usernameLower: "carol", status: "active", createdAt: T0 })
      .returning()
      .all();
    const [dave] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "dave", usernameLower: "dave", status: "active", createdAt: T0 })
      .returning()
      .all();
    if (coalition === undefined || rivals === undefined || bob === undefined || carol === undefined || dave === undefined) {
      throw new Error("org world seed failed");
    }
    await drizzle(env.DB)
      .insert(orgMembers)
      .values([
        { orgId: coalition.id, userId: 1, role: "owner", createdAt: T0 }, // alice owns coalition
        { orgId: coalition.id, userId: bob.id, role: "member", createdAt: T0 }, // inside, but no ownership
        { orgId: rivals.id, userId: carol.id, role: "owner", createdAt: T0 },
      ])
      .run();
    world = { coalitionId: coalition.id, rivalsId: rivals.id, bobId: bob.id, daveId: dave.id };
  });

  it("the parse claims exactly the six runners shapes", () => {
    expect(parseUiRoute(RUNNERS_URL)).toMatchObject({ family: "org-actions-runners", owner: "coalition" });
    expect(parseUiRoute(`${RUNNERS_URL}/reset_registration_token`)).toMatchObject({ family: "org-actions-runners-token-reset" });
    expect(parseUiRoute(`${RUNNERS_URL}/7`)).toMatchObject({ family: "org-actions-runners-edit", id: 7 });
    expect(parseUiRoute(`${RUNNERS_URL}/7/update-runner`)).toMatchObject({ family: "org-actions-runners-update", id: 7 });
    expect(parseUiRoute(`${RUNNERS_URL}/7/delete`)).toMatchObject({ family: "org-actions-runners-delete", id: 7 });
    // Junk ids and deeper tails never claim; the literal beats the combo.
    // The /user/settings/actions/runners shape FLIPPED at 72af05a — the
    // user twin's own suite pins its mounted matrix; this org suite only
    // asserts the org block's junk arms.
    expect(parseUiRoute(`${RUNNERS_URL}/junk`)).toBeNull();
    expect(parseUiRoute(`${RUNNERS_URL}/7/extra`)).toBeNull();
    expect(parseUiRoute(`/user/settings/actions/runners`)).toMatchObject({ family: "user-settings-actions-runners" });
    expect(handlesUiRoute(RUNNERS_URL)).toBe(true);
  });

  it("303s an anonymous GET onto the login round-trip (the org resolved first)", async () => {
    const res = await getRoute(RUNNERS_URL, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(RUNNERS_URL)}`);
  });

  it("404-shells a signed-in member (bob) on GET and POST — nothing written", async () => {
    await expectNotFoundShell(await getRoute(RUNNERS_URL, world.bobId));
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/reset_registration_token`, world.bobId, {}));
    expect(await drizzle(env.DB).select().from(actionRunnerTokens).all()).toHaveLength(0); // nothing minted
  });

  it("404-shells a signed-in non-member (dave) — the requireOrgOwnership posture", async () => {
    await expectNotFoundShell(await getRoute(RUNNERS_URL, world.daveId));
    await expectNotFoundShell(await getRoute(`${RUNNERS_URL}/1`, world.daveId));
  });

  it("403s a cross-origin POST before any write (the sameOriginGuard)", async () => {
    const res = await postRoute(`${RUNNERS_URL}/reset_registration_token`, 1, {}, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await drizzle(env.DB).select().from(actionRunnerTokens).all()).toHaveLength(0);
  });

  it("the owner's GET creates the scope token and the page renders it (the round-trip)", async () => {
    const first = await getRoute(RUNNERS_URL, 1);
    expect(first.status).toBe(200);
    const tokenRow = await getOrCreateActiveRunnerToken(env.DB, world.coalitionId, "");
    const html = await first.text();
    expect(html).toContain(`value="${tokenRow.token}"`);
    // The second GET reuses the SAME token (no re-mint).
    const second = await getRoute(RUNNERS_URL, 1);
    expect((await second.text())).toContain(`value="${tokenRow.token}"`);
  });

  it("the reset POST rotates the token and 303s back onto the list", async () => {
    const before = await getOrCreateActiveRunnerToken(env.DB, world.coalitionId, "");
    const res = await postRoute(`${RUNNERS_URL}/reset_registration_token`, 1, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    const after = await getLatestRunnerToken(env.DB, world.coalitionId, "");
    expect(after?.token).not.toBe(before.token);
    expect(after?.isActive).toBe(true);
    const page = await getRoute(RUNNERS_URL, 1);
    expect((await page.text())).toContain(`value="${after?.token}"`);
  });

  it("the description POST persists and 303s onto the list; a rival-org id 404-shells", async () => {
    const runner = await seedRunner({ name: "own", ownerId: world.coalitionId });
    const res = await postRoute(`${RUNNERS_URL}/${runner.id}`, 1, { description: "the workhorse" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    expect((await findOrgScopedRunner(env.DB, world.coalitionId, runner.id))?.description).toBe("the workhorse");

    const rivalRunner = await seedRunner({ name: "rival", ownerId: world.rivalsId });
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/${rivalRunner.id}`, 1, { description: "nope" }));
    expect((await findOrgScopedRunner(env.DB, world.rivalsId, rivalRunner.id))?.description).toBe("");
  });

  it("the update-runner POST flips isDisabled; an absent param answers the 400; success 303s onto the edit page", async () => {
    const runner = await seedRunner({ name: "own", ownerId: world.coalitionId });
    const flip = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, { disabled: "true" });
    expect(flip.status).toBe(303);
    expect(flip.headers.get("location")).toBe(`${RUNNERS_URL}/${runner.id}`);
    expect((await findOrgScopedRunner(env.DB, world.coalitionId, runner.id))?.isDisabled).toBe(true);
    // The flip-back arm carries the edit page's shape.
    const flipBack = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, { disabled: "false" });
    expect(flipBack.status).toBe(303);
    expect((await findOrgScopedRunner(env.DB, world.coalitionId, runner.id))?.isDisabled).toBe(false);
    // The missing-parameter arm — upstream's exact 400 text.
    const missing = await postRoute(`${RUNNERS_URL}/${runner.id}/update-runner`, 1, {});
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("missing 'disabled' parameter");
  });

  it("the delete POST removes the row and 303s onto the list; a global id 404-shells and survives", async () => {
    const runner = await seedRunner({ name: "own", ownerId: world.coalitionId });
    const globalRunner = await seedRunner({ name: "global" });
    await expectNotFoundShell(await postRoute(`${RUNNERS_URL}/${globalRunner.id}/delete`, 1, {}));
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, globalRunner.id))).toHaveLength(1);
    const res = await postRoute(`${RUNNERS_URL}/${runner.id}/delete`, 1, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(RUNNERS_URL);
    expect(await drizzle(env.DB).select().from(actionRunners).where(eq(actionRunners.id, runner.id))).toHaveLength(0);
  });

  it("the edit GET renders the runner page through the mount", async () => {
    const runner = await seedRunner({ name: "own", ownerId: world.coalitionId });
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

  it("the cross-org scope isolation — coalition's rows never render or resolve through the rivals' URLs", async () => {
    const runner = await seedRunner({ name: "coalition-fleet-1", ownerId: world.coalitionId });
    const carolId = await sessionOwnerCarolId();
    // Carol owns rivals: her GET of the rivals list never shows coalition rows.
    const rivalsList = await getRoute("/rivals/settings/actions/runners", carolId);
    expect(rivalsList.status).toBe(200);
    expect(await rivalsList.text()).not.toContain("coalition-fleet-1");
    // And the coalition runner's id is unwritable through the rivals' URLs.
    await expectNotFoundShell(await postRoute(`/rivals/settings/actions/runners/${runner.id}`, carolId, { description: "hijack" }));
    expect((await findOrgScopedRunner(env.DB, world.coalitionId, runner.id))?.description).toBe("");
    // The rivals list mints ITS OWN scope token, never coalition's.
    const rivalsToken = await getLatestRunnerToken(env.DB, world.rivalsId, "");
    expect(rivalsToken).not.toBeNull();
    expect(rivalsToken!.ownerId).toBe(world.rivalsId);
  });

  /** Carol's user id, captured from the seeded world (the rivals org's owner). */
  async function sessionOwnerCarolId(): Promise<number> {
    const carol = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "carol")).get();
    if (carol === undefined) throw new Error("carol missing");
    return carol.id;
  }
});
