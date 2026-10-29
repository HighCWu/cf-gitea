/**
 * The Actions JOB QUEUE pages' tests (the census C6 arm — the C8 repo
 * settings harness over the M1a store): the queue query's ordering contract
 * (run_job_queue.go:45-48 — active-first-by-started, then queued-by-updated,
 * then id; the reusable-caller exclusion; the auto-refresh page clamp), the
 * `?status=` filter arms, the instance scope's filter options, the runner
 * name enrichment, both page shells' DOM contracts and the `?refresh=1`
 * fragment posture — plus the mounted route arms: the repo arm's read gate
 * ladder (anonymous 200 on a public repo with the unit ON, the empty-repo
 * 404, the disabled-unit 404, the fragment morph body) and the admin arm's
 * prologue (anonymous 303, non-admin 404 shell, the admin's 200 + filters).
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
  insertActionRun,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_RUNNING,
  type RunJobRow,
} from "../../services/actions/model";
import { actionRunJobs, actionTasks, repositories } from "../../db/schema";
import { locale } from "../locale";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  actionsQueueLocale,
  actionsQueueRefreshIntervalMs,
  actionsStatusIcon,
  actionsStatusLocaleText,
  actionsStatusToString,
  findJobQueueJobs,
  getTaskRunnerNames,
  loadJobQueuePageData,
  renderJobQueueFragment,
  renderRepoActionsJobQueuePage,
  RepoActionsJobQueuePage,
  RepoActionsQueueSidebar,
} from "./repo-actions-queue";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const T1 = new Date(T0.getTime() + 1_000);
const T2 = new Date(T0.getTime() + 2_000);
const T3 = new Date(T0.getTime() + 3_000);
const T5 = new Date(T0.getTime() + 5_000);
const ORIGIN = "https://test.local";
const REPO_LINK = "/alice/demo";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: true };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;
let otherRepo: RepoRow;

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
  // alice is the site admin (the admin arm's happy path) AND repo-1's owner;
  // bob is a plain viewer owning repo-2 (the admin filter's second scope).
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', 1, unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (2, 'bob', 'bob', 'Bob Doe', 0, unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, 'demo', 'main', 'public', 0, unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-2', 'repo-2', 'bob', 2, 'other', 'main', 'public', 0, unixepoch())",
  ).run();
  repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get())!;
  otherRepo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-2")).get())!;
});

/** The actions unit ON — the MustEnableActions arm's happy-path posture. */
async function enableActions(repoId: string = repo.id): Promise<void> {
  await saveRepoSettings(env.DB, repoId, { hasActions: true }, T0);
}

/** One run with the named jobs (the M1a staged insert — run waiting, attempt
 *  1, waiting jobs). */
async function seedRun(repoRow: RepoRow, index: number, jobs: Array<{ name: string; runsOn?: string[] }>): Promise<RunJobRow[]> {
  const { jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: repoRow.id,
      ownerId: repoRow.ownerId ?? 1,
      workflowId: ".gitea/workflows/ci.yml",
      index,
      triggerUserId: repoRow.ownerId ?? 1,
      ref: "refs/heads/main",
      commitSha: SHA,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: `run ${index}`,
    },
    jobs.map((job) => ({
      jobId: job.name,
      name: job.name,
      runsOn: job.runsOn ?? ["ubuntu-latest"],
      workflowPayload: new TextEncoder().encode("jobs: {}"),
    })),
  );
  return jobRows;
}

/** The job's queue-relevant columns (the statuses/times the dispatch would
 *  write — seeded directly, the fake-runner harness's posture without the
 *  wire). */
async function setJob(
  jobId: number,
  fields: { status?: number; started?: Date | null; updated?: Date; taskId?: number; isReusableCaller?: boolean },
): Promise<void> {
  await drizzle(env.DB).update(actionRunJobs).set(fields).where(eq(actionRunJobs.id, jobId));
}

/** A claimed task for the runner-name cell (action_tasks seeded directly —
 *  the UNIQUE token hash carries the ids). */
async function seedTask(runnerId: number, jobId: number): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(actionTasks)
    .values({
      jobId,
      runnerId,
      status: ACTION_STATUS_RUNNING,
      repoId: repo.id,
      ownerId: 1,
      commitSha: SHA,
      tokenHash: `seed-hash-${runnerId}-${jobId}`,
      tokenSalt: "seed-salt",
      created: T0,
      updated: T0,
    })
    .returning({ id: actionTasks.id });
  return rows[0]!.id;
}

async function seedRunner(name: string, ownerId: number, repoId: string, labels: string[] = ["ubuntu-latest"]) {
  return createRunner(env.DB, {
    uuid: `uuid-${name}-${ownerId}-${repoId}`,
    name,
    version: "1.0.0",
    ownerId,
    repoId,
    agentLabels: labels,
    ephemeral: false,
    hasCancellingSupport: false,
  });
}

// --- the query (models/actions/run_job_queue.go) --------------------------------

describe("findJobQueueJobs (the ordering contract, run_job_queue.go:45-48)", () => {
  it("orders active-first-by-started, then queued-by-updated, then id — and skips reusable callers", async () => {
    await enableActions();
    const jobs = await seedRun(repo, 1, [
      { name: "waiting-late" }, // A
      { name: "waiting-early" }, // B
      { name: "running" }, // C
      { name: "cancelling" }, // D
      { name: "reusable" }, // E — never queues
    ]);
    const [a, b, c, d, e] = jobs;
    await setJob(a!.id, { updated: T3 });
    await setJob(b!.id, { updated: T1 });
    await setJob(c!.id, { status: ACTION_STATUS_RUNNING, started: T5, updated: T5 });
    await setJob(d!.id, { status: ACTION_STATUS_CANCELLING, started: T2, updated: T2 });
    await setJob(e!.id, { isReusableCaller: true, updated: T0 });

    const { jobs: rows, total } = await findJobQueueJobs(env.DB, { repoId: repo.id }, 1);
    expect(total).toBe(4); // the reusable caller never counts
    expect(rows.map((row) => row.name)).toEqual(["cancelling", "running", "waiting-early", "waiting-late"]);
  });

  it("the ?status= filter arms — running covers cancelling, waiting demands unclaimed", async () => {
    await enableActions();
    const jobs = await seedRun(repo, 1, [
      { name: "waiting" },
      { name: "running" },
      { name: "cancelling" },
    ]);
    await setJob(jobs[1]!.id, { status: ACTION_STATUS_RUNNING, started: T1, updated: T1 });
    await setJob(jobs[2]!.id, { status: ACTION_STATUS_CANCELLING, started: T2, updated: T2 });

    const running = await findJobQueueJobs(env.DB, { repoId: repo.id, status: "running" }, 1);
    expect(running.total).toBe(2);
    expect(running.jobs.map((row) => row.name).sort()).toEqual(["cancelling", "running"]);

    const waiting = await findJobQueueJobs(env.DB, { repoId: repo.id, status: "waiting" }, 1);
    expect(waiting.total).toBe(1);
    expect(waiting.jobs[0]!.name).toBe("waiting");

    // A claimed waiting job (task_id != 0) leaves the queued set.
    const task = await seedRunner("claimer", 0, "");
    const taskId = await seedTask(task.id, jobs[0]!.id);
    await setJob(jobs[0]!.id, { taskId });
    const afterClaim = await findJobQueueJobs(env.DB, { repoId: repo.id, status: "waiting" }, 1);
    expect(afterClaim.total).toBe(0);
  });

  it("clamps the page to the last (a shrunk queue never renders empty)", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "only" }]);
    // Page 99 of a one-row queue resolves to page 1's row.
    const { jobs } = await findJobQueueJobs(env.DB, { repoId: repo.id }, 99);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe("only");
  });

  it("the instance scope spans repos and takes the owner filter", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "alice-job" }]);
    await seedRun(otherRepo, 1, [{ name: "bob-job" }]);

    const all = await findJobQueueJobs(env.DB, {}, 1);
    expect(all.total).toBe(2);
    const ownerScoped = await findJobQueueJobs(env.DB, { ownerId: 2 }, 1);
    expect(ownerScoped.total).toBe(1);
    expect(ownerScoped.jobs[0]!.name).toBe("bob-job");
  });
});

describe("getTaskRunnerNames (task.go:165-185)", () => {
  it("maps claimed tasks to runner names and misses cleanly", async () => {
    const runner = await seedRunner("fleet-1", 0, "");
    const jobs = await seedRun(repo, 1, [{ name: "claimed" }, { name: "unclaimed" }]);
    const taskId = await seedTask(runner.id, jobs[0]!.id);
    await setJob(jobs[0]!.id, { taskId });

    const names = await getTaskRunnerNames(env.DB, [taskId, 999_999]);
    expect(names.get(taskId)).toBe("fleet-1");
    expect(names.has(999_999)).toBe(false);
    expect(await getTaskRunnerNames(env.DB, [])).toEqual(new Map());
  });
});

// --- the page data + DOM contracts ------------------------------------------------

describe("loadJobQueuePageData (RenderJobQueue, job_queue.go:37-130)", () => {
  it("the repo scope pins the repo, hides the repo column and enriches the rows", async () => {
    await enableActions();
    const runner = await seedRunner("fleet-1", 0, "");
    const jobs = await seedRun(repo, 1, [{ name: "build", runsOn: ["ubuntu-latest"] }]);
    const taskId = await seedTask(runner.id, jobs[0]!.id);
    await setJob(jobs[0]!.id, { taskId, status: ACTION_STATUS_RUNNING, started: T1, updated: T1 });
    // A sibling repo's queue row never leaks into the repo scope.
    await seedRun(otherRepo, 1, [{ name: "bob-job" }]);

    const data = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams());
    expect(data.showRepoColumn).toBe(false);
    expect(data.jobs).toHaveLength(1);
    const row = data.jobs[0]!;
    expect(row.name).toBe("build");
    expect(row.runnerName).toBe("fleet-1");
    expect(row.runIndex).toBe(1);
    expect(row.commitSha).toBe(SHA);
    expect(row.repoFullName).toBe("alice/demo");
    expect(row.repoLink).toBe(REPO_LINK);
    expect(row.runsOn).toEqual(["ubuntu-latest"]);
    // The refresh link carries page + refresh=1 over the repo path.
    expect(data.refreshLink).toBe(`${REPO_LINK}/actions/job_queue?page=1&refresh=1`);
    expect(data.refreshIntervalMs).toBe(3_000);
  });

  it("the refresh interval arms — 3s with activity, 12s idle (the prod port)", () => {
    expect(actionsQueueRefreshIntervalMs(true)).toBe(3_000);
    expect(actionsQueueRefreshIntervalMs(false)).toBe(12_000);
  });

  it("the admin scope shows the repo column and computes the filter options", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "alice-job" }]);
    await seedRun(otherRepo, 1, [{ name: "bob-job" }]);

    const data = await loadJobQueuePageData(env.DB, { kind: "admin" }, new URLSearchParams());
    expect(data.showRepoColumn).toBe(true);
    expect(data.total).toBe(2);
    expect(data.filterOwners.map((owner) => owner.name).sort()).toEqual(["alice", "bob"]);
    expect(data.filterRepos.map((entry) => entry.fullName).sort()).toEqual(["alice/demo", "bob/other"]);

    // The repo_id filter narrows to that repo and names the dropdown.
    const filtered = await loadJobQueuePageData(env.DB, { kind: "admin" }, new URLSearchParams({ repo_id: "repo-2" }));
    expect(filtered.total).toBe(1);
    expect(filtered.jobs[0]!.name).toBe("bob-job");
    expect(filtered.filterRepoName).toBe("bob/other");
    expect(filtered.refreshLink).toBe("/-/admin/actions/job_queue?repo_id=repo-2&page=1&refresh=1");
  });

  it("the ?status= facet survives into the refresh link; junk resets to all", async () => {
    await enableActions();
    const statusData = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams({ status: "waiting" }));
    expect(statusData.filterStatus).toBe("waiting");
    expect(statusData.refreshLink).toContain("status=waiting");
    const junk = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams({ status: "success" }));
    expect(junk.filterStatus).toBe("");
  });
});

describe("the fragment + page renders (job_queue_list.tmpl / job_queue.tmpl / admin actions.tmpl)", () => {
  it("the fragment is exactly the morph-target div — no base layout", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "build" }]);
    const data = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams());
    const fragment = renderJobQueueFragment(data);
    expect(fragment.startsWith('<div id="actions-job-queue"')).toBe(true);
    expect(fragment).not.toContain("<!DOCTYPE html>");
    expect(fragment).not.toContain("<html");
    expect(fragment).toContain('data-global-init="initActionJobQueueList"');
    expect(fragment).toContain(`data-job-queue-refresh-link="${REPO_LINK}/actions/job_queue?page=1&amp;refresh=1"`);
    expect(fragment).toContain('data-job-queue-refresh-interval="3000"');
    // The morph root id + the run/repo/commit cells.
    expect(fragment).toContain(actionsQueueLocale.job_queue);
    expect(fragment).toContain("build");
    expect(fragment).toContain(`href="${REPO_LINK}/commit/${SHA}"`);
  });

  it("the empty queue renders the no-jobs line and the idle interval", async () => {
    await enableActions();
    const data = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams());
    expect(data.refreshIntervalMs).toBe(12_000);
    const fragment = renderJobQueueFragment(data);
    expect(fragment).toContain(actionsQueueLocale.no_jobs);
    expect(fragment).toContain('data-job-queue-refresh-interval="12000"');
  });

  it("the repo page shell carries the repository actions pageClass + the sidebar", async () => {
    await enableActions();
    const data = await loadJobQueuePageData(env.DB, { kind: "repo", repoId: repo.id, repoLink: REPO_LINK }, new URLSearchParams());
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE; C1's seededHtml pattern).
    const html = renderRepoActionsJobQueuePage({ ...ctx, repo }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("repository actions");
    expect(html).toContain('class="flex-container-main"');
    // The sidebar's Management menu with the active Job-queue item.
    expect(html).toContain(actionsQueueLocale.management);
    expect(html).toContain(`href="${REPO_LINK}/actions/job_queue"`);
    expect(() => RepoActionsJobQueuePage({ ctx, data })).toThrow("RepoActionsJobQueuePage requires ctx.repo");
  });

  it("the sidebar renders the Management menu only (the C1 dead-link reduction)", () => {
    const sidebar = renderToString(<RepoActionsQueueSidebar repoLink={REPO_LINK} />);
    expect(sidebar).toContain(actionsQueueLocale.job_queue);
    // The workflows menu renders NOTHING — its All-Workflows item targets
    // the unlanded runs list (the module header's reduction; C1's page is
    // the target when it lands).
    expect(sidebar).not.toContain("All Workflows");
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

async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain(actionsQueueLocale.job_queue);
}

describe("the mounted queue routes (the census C6 mount: the minted-session route-level matrix)", () => {
  it("the parse claims exactly the two literal paths", () => {
    expect(parseUiRoute("/alice/demo/actions/job_queue")).toMatchObject({ family: "repo-actions-job-queue", owner: "alice", repo: "demo" });
    expect(parseUiRoute("/-/admin/actions/job_queue")).toMatchObject({ family: "admin-actions-job-queue" });
    // The sibling tails stay unclaimed (C5's, the badge route's);
    // `/actions/runs/{run}` is claimed by the landed C2 run-viewer family
    // (actions-run-view — that unit's own suite pins its shapes).
    expect(parseUiRoute("/alice/demo/actions/job_queue/extra")).toBeNull();
    expect(parseUiRoute("/-/admin/actions")).toBeNull();
    expect(parseUiRoute("/-/admin/actions/runners")).toBeNull();
    expect(handlesUiRoute("/alice/demo/actions/job_queue")).toBe(true);
  });

  it("the repo arm answers 200 for an ANONYMOUS viewer on a public repo (optSignIn read arm)", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "build" }]);
    const res = await getRoute(`${REPO_LINK}/actions/job_queue`, null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository actions");
    expect(html).toContain("build");
  });

  it("the repo arm 404-shells the empty repo (repo.MustBeNotEmpty)", async () => {
    await enableActions();
    await drizzle(env.DB).update(repositories).set({ isEmpty: true }).where(eq(repositories.id, repo.id));
    await expectNotFoundShell(await getRoute(`${REPO_LINK}/actions/job_queue`, null));
  });

  it("the repo arm 404-shells while the actions unit is disabled (MustEnableActions)", async () => {
    // No repo_settings row: has_actions defaults FALSE — even the admin 404s.
    await expectNotFoundShell(await getRoute(`${REPO_LINK}/actions/job_queue`, 1));
    await enableActions();
    expect((await getRoute(`${REPO_LINK}/actions/job_queue`, 1)).status).toBe(200);
  });

  it("the repo arm's ?refresh=1 answers the fragment ALONE (the morph body)", async () => {
    await enableActions();
    await seedRun(repo, 1, [{ name: "build" }]);
    const res = await getRoute(`${REPO_LINK}/actions/job_queue?refresh=1&status=waiting`, null);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith('<div id="actions-job-queue"')).toBe(true);
    expect(body).not.toContain("<!DOCTYPE html>");
    // The refresh link preserves the status facet (the morph's next hop).
    expect(body).toContain("status=waiting");
  });

  it("the repo arm's POST answers chi's 405", async () => {
    await enableActions();
    const res = await fetchUi(`${REPO_LINK}/actions/job_queue`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("the admin arm 303s an anonymous GET onto the login round-trip and 404-shells a non-admin", async () => {
    const anon = await getRoute("/-/admin/actions/job_queue", null);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/actions/job_queue")}`);
    // bob: signed in, not a site admin — the hidden-surface 404 shell.
    await expectNotFoundShell(await getRoute("/-/admin/actions/job_queue", 2));
  });

  it("the admin arm renders the instance queue for the site admin — repo column, both repos", async () => {
    await seedRun(repo, 1, [{ name: "alice-job" }]);
    await seedRun(otherRepo, 1, [{ name: "bob-job" }]);
    const res = await getRoute("/-/admin/actions/job_queue", 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin actions");
    expect(html).toContain("alice-job");
    expect(html).toContain("bob-job");
    // The instance scope's filter dropdowns rendered (the repo column scope).
    expect(html).toContain(actionsQueueLocale.filter_owner_no_select);
    expect(html).toContain(actionsQueueLocale.filter_repo_no_select);
  });

  it("the admin arm's ?repo_id= filter narrows the queue and names the dropdown", async () => {
    await seedRun(repo, 1, [{ name: "alice-job" }]);
    await seedRun(otherRepo, 1, [{ name: "bob-job" }]);
    const res = await getRoute("/-/admin/actions/job_queue?repo_id=repo-2", 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("bob-job");
    expect(html).not.toContain("alice-job");
    expect(html).toContain("bob/other");
  });

  it("the admin arm's ?refresh=1 answers the fragment ALONE", async () => {
    await seedRun(repo, 1, [{ name: "alice-job" }]);
    const res = await getRoute("/-/admin/actions/job_queue?refresh=1", 1);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.startsWith('<div id="actions-job-queue"')).toBe(true);
    expect(body).not.toContain("<!DOCTYPE html>");
  });
});

// --- the status vocabulary (models/actions/status.go + action_status.tmpl) ---------

describe("the status vocabulary", () => {
  it("actionsStatusToString spells all ten statuses", () => {
    expect(actionsStatusToString(1)).toBe("success");
    expect(actionsStatusToString(2)).toBe("failure");
    expect(actionsStatusToString(3)).toBe("cancelled");
    expect(actionsStatusToString(4)).toBe("skipped");
    expect(actionsStatusToString(5)).toBe("waiting");
    expect(actionsStatusToString(6)).toBe("running");
    expect(actionsStatusToString(7)).toBe("blocked");
    expect(actionsStatusToString(8)).toBe("cancelling");
    expect(actionsStatusToString(9)).toBe("pending");
    expect(actionsStatusToString(0)).toBe("unknown");
    expect(actionsStatusToString(42)).toBe("unknown");
  });

  it("actionsStatusLocaleText carries the en-US values", () => {
    expect(actionsStatusLocaleText(5)).toBe("Waiting");
    expect(actionsStatusLocaleText(6)).toBe("Running");
    expect(actionsStatusLocaleText(8)).toBe("Canceling");
  });

  it("actionsStatusIcon follows action_status.tmpl with the allowlist stand-ins", () => {
    expect(actionsStatusIcon(1)).toEqual({ name: "octicon-check", class: "tw-text-green" });
    expect(actionsStatusIcon(5)).toEqual({ name: "octicon-dot-fill", class: "tw-text-yellow" });
    expect(actionsStatusIcon(6)).toEqual({ name: "octicon-clock", class: "tw-text-yellow rotate-clockwise" });
    expect(actionsStatusIcon(8)).toEqual({ name: "octicon-clock", class: "tw-text-yellow" });
    expect(actionsStatusIcon(2)).toEqual({ name: "octicon-info", class: "tw-text-red" });
  });
});
