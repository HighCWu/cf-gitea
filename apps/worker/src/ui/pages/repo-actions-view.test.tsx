/**
 * The run-viewer subtree's tests (the census C2 arm — the C8 settings-actions
 * harness's minted-session route-level pattern over seeded M1a rows): the
 * parse/claim pin, the resolution matrix (id-vs-index, latest, by_id/by_index,
 * the ≥256 job-id arm), the mount shell's attribute contract, the ViewResponse
 * JSON pinned against view.go's field list, the attempts/jobs param arms with
 * their 404/500 fidelities, the cancel arm's gates + write reduction, and the
 * gate postures (the tab-region read gate — anonymous readers pass; the
 * writer gate 404-shells).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { locale } from "../locale";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { actionRunAttempts, actionRunJobs, actionRuns, repositories } from "../../db/schema";
import {
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  ellipsisDisplayString,
  insertActionRun,
} from "../../services/actions/model";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  actionStatusDisplay,
  buildViewResponse,
  goDurationString,
  parseViewRequest,
  renderRepoActionsViewPage,
  repoActionsViewDetailLocale,
  repoActionsViewLocale,
  resolveRunForView,
  type ViewResponse,
} from "./repo-actions-view";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";
const WORKFLOW_ID = ".github/workflows/ci.yml";
const SHA = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode("jobs: {}\n");

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
    "action_run_job_summaries",
    "action_artifacts",
    "action_task_steps",
    "action_tasks",
    "action_run_jobs",
    "action_run_attempts",
    "action_runs",
    "action_runners",
    "action_tasks_versions",
    "repo_settings",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedRepo("demo");
});

async function seedRepo(slug: string, isEmpty = false): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES (?, ?, 'alice', 1, ?, 'main', 'public', ?, unixepoch())",
  )
    .bind(`repo-${slug}`, `repo-${slug}`, slug, isEmpty)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, `repo-${slug}`)).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

/** Seed one run through the M1a staged insert (run + attempt 1 + waiting
 *  jobs + the tasks_version bump); `index` is the per-repo run number. */
async function seedRun(
  index: number,
  opts: {
    title?: string;
    ref?: string;
    event?: string;
    eventPayload?: string;
    triggerEvent?: string;
    needApproval?: boolean;
    jobs?: Array<{ jobId: string; name?: string; needs?: string[]; runsOn?: string[] }>;
  } = {},
) {
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: repo.id,
      ownerId: 1,
      workflowId: WORKFLOW_ID,
      index,
      triggerUserId: 1,
      ref: opts.ref ?? "refs/heads/main",
      commitSha: SHA,
      event: opts.event ?? "push",
      eventPayload: opts.eventPayload ?? "{}",
      triggerEvent: opts.triggerEvent ?? "push",
      title: opts.title,
    },
    (opts.jobs ?? [{ jobId: "build" }]).map((job) => ({
      jobId: job.jobId,
      name: job.name,
      needs: job.needs,
      runsOn: job.runsOn,
      workflowPayload: PAYLOAD,
    })),
  );
  return { run, attempt, jobRows };
}

/** Force a (run, attempt) pair onto a terminal/running status so the
 *  duration and boolean derivations have deterministic shapes. */
async function setStatus(
  runId: number,
  attemptId: number,
  status: number,
  opts: { started?: Date; stopped?: Date; jobStatus?: number } = {},
): Promise<void> {
  await drizzle(env.DB).update(actionRuns).set({ status, started: opts.started ?? null, stopped: opts.stopped ?? null }).where(eq(actionRuns.id, runId));
  await drizzle(env.DB)
    .update(actionRunAttempts)
    .set({ status, started: opts.started ?? null, stopped: opts.stopped ?? null })
    .where(eq(actionRunAttempts.id, attemptId));
  if (opts.jobStatus !== undefined) {
    await drizzle(env.DB)
      .update(actionRunJobs)
      .set({ status: opts.jobStatus, started: opts.started ?? null, stopped: opts.stopped ?? null })
      .where(eq(actionRunJobs.runId, runId));
  }
}

// --- the parse/claim pin -------------------------------------------------------

describe("the route claim pin (the runs subtree claims exactly its shapes)", () => {
  it("parses the three view shapes + the cancel write", () => {
    expect(parseUiRoute("/alice/demo/actions/runs/7")).toEqual({
      family: "actions-run-view",
      owner: "alice",
      repo: "demo",
      run: "7",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/attempts/2")).toEqual({
      family: "actions-run-view",
      owner: "alice",
      repo: "demo",
      run: "7",
      attempt: "2",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/jobs/9")).toEqual({
      family: "actions-run-view",
      owner: "alice",
      repo: "demo",
      run: "7",
      job: "9",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/7/cancel")).toEqual({
      family: "actions-run-cancel",
      owner: "alice",
      repo: "demo",
      run: "7",
    });
    expect(parseUiRoute("/alice/demo/actions/runs/latest")).toEqual({
      family: "actions-run-view",
      owner: "alice",
      repo: "demo",
      run: "latest",
    });
  });

  it("leaves the sibling tails and every deeper/junk shape unclaimed", () => {
    for (const path of [
      "/alice/demo/actions/runs", // the bare /runs has no upstream route
      "/alice/demo/actions/runs/7/rerun", // C5's emitter-dependent tail
      "/alice/demo/actions/runs/7/rerun-failed",
      "/alice/demo/actions/runs/7/approve",
      "/alice/demo/actions/runs/7/delete",
      "/alice/demo/actions/runs/7/workflow",
      "/alice/demo/actions/runs/7/logs",
      "/alice/demo/actions/runs/7/artifacts/some-name",
      "/alice/demo/actions/runs/7/attempts/2/extra", // deeper than any shape
      "/alice/demo/actions/runs/7/jobs/9/extra",
      "/alice/demo/actions/run/1", // upstream's singular /run — unlanded
      "/alice/demo/actions/disable",
      "/alice/demo/actions/workflow-dispatch-inputs",
    ]) {
      expect(parseUiRoute(path)).toBeNull();
      expect(handlesUiRoute(path)).toBe(false);
    }
    // The bare /actions tab and /actions/job_queue are the C1/C6 siblings'
    // claims — disjoint from this family.
    expect(parseUiRoute("/alice/demo/actions")).toEqual({ family: "repo-actions-runs", owner: "alice", repo: "demo" });
    expect(parseUiRoute("/alice/demo/actions/job_queue")).toEqual({
      family: "repo-actions-job-queue",
      owner: "alice",
      repo: "demo",
    });
    expect(handlesUiRoute("/alice/demo/actions/runs/7")).toBe(true);
    expect(handlesUiRoute("/alice/demo/actions/runs/7/cancel")).toBe(true);
  });
});

// --- the resolution matrix (resolveCurrentRunForView's port) -------------------

describe("resolveRunForView (the ID-vs-index disambiguation, view.go:75-260)", () => {
  let runIndex5: Awaited<ReturnType<typeof seedRun>>;
  let runIndex7: Awaited<ReturnType<typeof seedRun>>;

  beforeEach(async () => {
    await enableActions();
    // Indexes deliberately FAR from any possible row id (the sqlite
    // AUTOINCREMENT counter survives the beforeEach wipes): run A carries
    // index 1001, run B index 1002 — every ambiguous URL resolves
    // deterministically, whichever absolute ids the store hands out.
    runIndex5 = await seedRun(1001);
    runIndex7 = await seedRun(1002);
  });

  it("resolves the row id first (best-effort ID-first on the job-less paths)", async () => {
    const outcome = await resolveRunForView(env.DB, repo.id, String(runIndex5.run.id), "", false, false, "/alice/demo");
    expect(outcome.outcome).toBe("run");
    if (outcome.outcome === "run") expect(outcome.run.id).toBe(runIndex5.run.id);
  });

  it("resolves latest as the index-newest run", async () => {
    const outcome = await resolveRunForView(env.DB, repo.id, "latest", "", false, false, "/alice/demo");
    expect(outcome.outcome).toBe("run");
    if (outcome.outcome === "run") expect(outcome.run.id).toBe(runIndex7.run.id);
  });

  it("redirects a legacy index URL onto the canonical id URL (302 Found)", async () => {
    const outcome = await resolveRunForView(env.DB, repo.id, "1001", "", false, false, "/alice/demo");
    expect(outcome).toEqual({ outcome: "redirect", location: `/alice/demo/actions/runs/${runIndex5.run.id}` });
  });

  it("by_id=1 forces the ID reading; by_index=1 forces the index reading", async () => {
    const byId = await resolveRunForView(env.DB, repo.id, "1001", "", true, false, "/alice/demo");
    expect(byId).toEqual({ outcome: "not-found" }); // no run ROW id 1001
    const byIndex = await resolveRunForView(env.DB, repo.id, String(runIndex5.run.id), "", false, true, "/alice/demo");
    expect(byIndex).toEqual({ outcome: "not-found" }); // no run INDEX equals that row id
  });

  it("answers not-found for junk, zero, and missing runs", async () => {
    expect((await resolveRunForView(env.DB, repo.id, "junk", "", false, false, "/alice/demo")).outcome).toBe("not-found");
    expect((await resolveRunForView(env.DB, repo.id, "0", "", false, false, "/alice/demo")).outcome).toBe("not-found");
    expect((await resolveRunForView(env.DB, repo.id, "99", "", false, false, "/alice/demo")).outcome).toBe("not-found");
  });

  it("job URLs probe the job id and prefer the ID reading when both are valid", async () => {
    const jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runId, runIndex5.run.id));
    const firstJob = jobs[0]!;

    // The job id belongs to runNum's own row → the ID reading wins outright.
    const byJobId = await resolveRunForView(env.DB, repo.id, String(runIndex5.run.id), String(firstJob.id), false, false, "/alice/demo");
    expect(byJobId.outcome).toBe("run");

    // The job belongs to another run and no run carries that index → 404.
    const otherJobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runId, runIndex7.run.id));
    const foreignJob = otherJobs[0]!;
    const miss = await resolveRunForView(env.DB, repo.id, String(runIndex5.run.id), String(foreignJob.id), false, false, "/alice/demo");
    expect(miss.outcome).toBe("not-found");

    // The index reading: /runs/{index}/jobs/{ordinal} redirects onto the
    // canonical job URL (run index 1002's ordinal 0).
    const ordinal = await resolveRunForView(env.DB, repo.id, "1002", "0", false, false, "/alice/demo");
    expect(ordinal).toEqual({
      outcome: "redirect",
      location: `/alice/demo/actions/runs/${runIndex7.run.id}/jobs/${foreignJob.id}`,
    });

    // An ordinal beyond the run's job count answers not-found.
    const beyond = await resolveRunForView(env.DB, repo.id, "1002", "3", false, false, "/alice/demo");
    expect(beyond.outcome).toBe("not-found");
  });

  it("treats job segments ≥ MaxJobNumPerRun as job IDs (no index probe)", async () => {
    // Seed a job with an explicit ≥256 id on run A (the autoincrement never
    // reaches it in a fresh store).
    await drizzle(env.DB)
      .insert(actionRunJobs)
      .values({
        id: 300,
        runId: runIndex5.run.id,
        repoId: repo.id,
        ownerId: 1,
        name: "big-id-job",
        attempt: 1,
        workflowPayload: PAYLOAD,
        jobId: "big",
        status: ACTION_STATUS_WAITING,
        runAttemptId: runIndex5.attempt.id,
        created: T0,
        updated: T0,
      });
    const outcome = await resolveRunForView(env.DB, repo.id, String(runIndex5.run.id), "300", false, false, "/alice/demo");
    expect(outcome.outcome).toBe("run");
  });
});

// --- the mounted route arms ------------------------------------------------------

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

async function postJson(path: string, userId: number | null, body: unknown, origin = ORIGIN): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
      ...(userId === null ? {} : { cookie: await sessionCookie(userId) }),
    },
    body: JSON.stringify(body),
  });
}

async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain("repo-action-view");
}

describe("the mount page (GET — the view.tmpl + view_component.tmpl shell)", () => {
  beforeEach(async () => {
    await enableActions();
  });

  it("renders the mount div with the id, the two data attributes, and the locale set", async () => {
    const { run } = await seedRun(1, { title: "Fix the login bug" });
    const res = await getRoute(`/alice/demo/actions/runs/${run.id}`, 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="repo-action-view"');
    expect(html).toContain('data-job-id="0"');
    expect(html).toContain(`data-actions-view-url="/alice/demo/actions/runs/${run.id}"`);
    // Spot-check the locale attribute set (the full set rides the component
    // render pin below).
    expect(html).toContain(`data-locale-cancel="${repoActionsViewLocale.cancel}"`);
    expect(html).toContain(`data-locale-status-waiting="${repoActionsViewLocale.statusWaiting}"`);
    expect(html).toContain(`data-locale-graph-reset-view="${repoActionsViewLocale.graphResetView}"`);
    // The page shell: .page-content.repository over the repo header (no
    // actions tab strip yet — no activeTab).
    expect(html).toContain("page-content repository");
    expect(html).toContain("/alice/demo");
    // The browser tab title: run - workflow (no job arm).
    expect(html).toContain("<title>Fix the login bug - .github/workflows/ci.yml - alice/demo</title>");
  });

  it("the attempt and job arms shape data-job-id and data-actions-view-url", async () => {
    const { run, jobRows } = await seedRun(1, { title: "Fix the login bug", jobs: [{ jobId: "build", name: "build (1)" }] });
    const jobId = jobRows[0]!.id;

    const attemptRes = await getRoute(`/alice/demo/actions/runs/${run.id}/attempts/1`, 1);
    expect(attemptRes.status).toBe(200);
    const attemptHtml = await attemptRes.text();
    expect(attemptHtml).toContain(`data-actions-view-url="/alice/demo/actions/runs/${run.id}/attempts/1"`);
    expect(attemptHtml).toContain('data-job-id="0"');

    const jobRes = await getRoute(`/alice/demo/actions/runs/${run.id}/jobs/${jobId}`, 1);
    expect(jobRes.status).toBe(200);
    const jobHtml = await jobRes.text();
    expect(jobHtml).toContain(`data-actions-view-url="/alice/demo/actions/runs/${run.id}/jobs/${jobId}"`);
    expect(jobHtml).toContain(`data-job-id="${jobId}"`);
    // The tab title joins the job name first (view.go:299-306).
    expect(jobHtml).toContain("<title>build (1) - Fix the login bug - .github/workflows/ci.yml - alice/demo</title>");

    // A junk attempt segment parses to PathParamInt64's 0 → the bare run URL
    // (upstream's switch default).
    const junkRes = await getRoute(`/alice/demo/actions/runs/${run.id}/attempts/junk`, 1);
    expect(junkRes.status).toBe(200);
    expect(await junkRes.text()).toContain(`data-actions-view-url="/alice/demo/actions/runs/${run.id}"`);
  });

  it("the component render carries the whole locale attribute set in upstream order", () => {
    const html = renderRepoActionsViewPage(ctx, {
      jobId: 3,
      actionsViewUrl: "/alice/demo/actions/runs/1/jobs/3",
      title: "t",
    });
    expect(html).toContain('id="repo-action-view"');
    expect(html).toContain('data-job-id="3"');
    for (const [attr, value] of [
      ["data-locale-approve", repoActionsViewLocale.approve],
      ["data-locale-rerun-all", repoActionsViewLocale.rerunAll],
      ["data-locale-latest-attempt", repoActionsViewLocale.latestAttempt],
      ["data-locale-attempt", repoActionsViewLocale.attempt],
      ["data-locale-runs-scheduled", repoActionsViewLocale.runsScheduled],
      ["data-locale-summary", repoActionsViewLocale.summary],
      ["data-locale-all-jobs", repoActionsViewLocale.allJobs],
      ["data-locale-job-summaries", repoActionsViewLocale.jobSummaries],
      ["data-locale-status-cancelling", repoActionsViewLocale.statusCancelling],
      ["data-locale-status-blocked", repoActionsViewLocale.statusBlocked],
      ["data-locale-artifacts-title", repoActionsViewLocale.artifactsTitle],
      // The apostrophe renders escaped (the JSX attribute convention).
      ["data-locale-confirm-delete-artifact", "Are you sure you want to delete the artifact &#39;%s&#39;?"],
      ["data-locale-download-logs", repoActionsViewLocale.downloadLogs],
      ["data-locale-copy-output", repoActionsViewLocale.copyOutput],
      ["data-locale-workflow-dependencies", repoActionsViewLocale.workflowDependencies],
      ["data-locale-graph-zoom-in", repoActionsViewLocale.graphZoomIn],
    ] as const) {
      expect(html).toContain(`${attr}="${value}"`);
    }
  });

  it("the legacy index URL 302s onto the canonical id URL on GET (view.go:123-128)", async () => {
    const { run } = await seedRun(5);
    const res = await getRoute("/alice/demo/actions/runs/5", 1);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/alice/demo/actions/runs/${run.id}`);
  });

  it("the gate ladder: the unit flag off 404-shells, an empty repo 404-shells, a missing run 404s, a foreign repo's run 404s", async () => {
    const { run } = await seedRun(1);

    // MustEnableActions (repo_settings.has_actions DEFAULT false).
    await saveRepoSettings(env.DB, repo.id, { hasActions: false }, T0);
    await expectNotFoundShell(await getRoute(`/alice/demo/actions/runs/${run.id}`, 1));
    await enableActions();

    // repo.MustBeNotEmpty (the group middleware's empty-repo arm).
    await drizzle(env.DB).update(repositories).set({ isEmpty: true }).where(eq(repositories.id, repo.id));
    await expectNotFoundShell(await getRoute(`/alice/demo/actions/runs/${run.id}`, 1));
    await drizzle(env.DB).update(repositories).set({ isEmpty: false }).where(eq(repositories.id, repo.id));

    await expectNotFoundShell(await getRoute("/alice/demo/actions/runs/999", 1));
    await expectNotFoundShell(await getRoute("/alice/demo/actions/runs/junk", 1));

    // Repo scoping: another repo's run id never resolves here.
    const savedRepo = repo;
    repo = await seedRepo("other");
    const foreignRun = await seedRun(1);
    repo = savedRepo;
    await expectNotFoundShell(await getRoute(`/alice/demo/actions/runs/${foreignRun.run.id}`, 1));
  });

  it("an anonymous GET of a public repo's run renders the shell (optSignIn + the read grant)", async () => {
    const { run } = await seedRun(1);
    const res = await getRoute(`/alice/demo/actions/runs/${run.id}`, null);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="repo-action-view"');
  });
});

// --- the ViewResponse JSON (POST — the view.go:291-417 contract) -----------------

describe("the ViewResponse JSON (POST — pinned against view.go's field list)", () => {
  it("answers the full summary shape for a waiting run with two jobs", async () => {
    await enableActions();
    const seeded = await seedRun(1, {
      title: "Fix the login bug",
      jobs: [
        { jobId: "build", name: "build", runsOn: ["ubuntu-latest"] },
        { jobId: "test", name: "test", needs: ["build"], runsOn: ["ubuntu-latest"] },
      ],
    });
    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, 1, { logCursors: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const body = await res.json<ViewResponse>();

    // The run block — the field list mirrors ViewResponse.state.run exactly.
    expect(body.state.run.repoId).toBe(repo.id); // the TEXT id spelling
    expect(body.state.run.link).toBe(`/alice/demo/actions/runs/${seeded.run.id}`);
    expect(body.state.run.viewLink).toBe(`/alice/demo/actions/runs/${seeded.run.id}`);
    expect(body.state.run.index).toBe(1);
    expect(body.state.run.title).toBe("Fix the login bug");
    expect(body.state.run.titleHTML).toContain("Fix the login bug");
    expect(body.state.run.status).toBe("waiting");
    expect(body.state.run.done).toBe(false);
    expect(body.state.run.canCancel).toBe(true); // the writer (alice)
    expect(body.state.run.canApprove).toBe(false);
    expect(body.state.run.canRerun).toBe(false); // !done
    expect(body.state.run.canRerunFailed).toBe(false);
    expect(body.state.run.canDeleteArtifact).toBe(false);
    expect(body.state.run.workflowID).toBe(WORKFLOW_ID);
    expect(body.state.run.workflowLink).toBe(`/alice/demo/actions/?workflow=${encodeURIComponent(WORKFLOW_ID)}`);
    expect(body.state.run.canViewWorkflowFile).toBe(true);
    expect(body.state.run.isSchedule).toBe(false);
    expect(body.state.run.runAttempt).toBe(1);
    expect(body.state.run.triggerEvent).toBe("push");
    expect(body.state.run.duration).toBe("0s"); // never started
    expect(typeof body.state.run.triggeredAt).toBe("number");

    // The attempts block (attempt 1, current + latest).
    expect(body.state.run.attempts).toHaveLength(1);
    const attemptItem = body.state.run.attempts[0]!;
    expect(attemptItem).toMatchObject({
      attempt: 1,
      status: "waiting",
      done: false,
      link: `/alice/demo/actions/runs/${seeded.run.id}`,
      current: true,
      latest: true,
      triggerUserName: "Alice Doe",
      triggerUserLink: "/alice",
    });

    // The jobs block — id ASC, the needs/canRerun derivations.
    expect(body.state.run.jobs).toHaveLength(2);
    expect(body.state.run.jobs[0]).toMatchObject({
      link: `/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`,
      jobId: "build",
      name: "build",
      status: "waiting",
      canRerun: false,
      parentJobID: 0,
      isReusableCaller: false,
    });
    expect(body.state.run.jobs[0]!.needs).toBeUndefined(); // no needs → the field stays absent (omitempty)
    expect(body.state.run.jobs[1]!.needs).toEqual(["build"]);

    // The commit block: ShortSha(10), the commit link, the pusher, the
    // branch (PrettyRef + the engine refs read — no git seeded → deleted).
    expect(body.state.run.commit.shortSHA).toBe(SHA.slice(0, 10));
    expect(body.state.run.commit.link).toBe(`/alice/demo/commit/${SHA}`);
    expect(body.state.run.commit.pusher.displayName).toBe("Alice Doe");
    expect(body.state.run.commit.pusher.link).toBe("/alice");
    expect(body.state.run.commit.branch).toEqual({
      name: "main",
      link: "/alice/demo/src/branch/main",
      isDeleted: true, // the branch-existence read misses (no git fixture)
    });
    expect(body.state.run.pullRequest).toBeUndefined(); // a push run, no PR payload

    // The currentJob shell (no job param → empty strings) + the C3 arms'
    // empty arrays.
    expect(body.state.currentJob).toEqual({ title: "", detail: "", steps: [] });
    expect(body.logs.stepsLog).toEqual([]);

    // No artifacts/summaries seeded → the empty arrays (never null).
    expect(body.artifacts).toEqual([]);
    expect(body.state.run.jobSummaries).toBeUndefined(); // omitempty
  });

  it("derives the writer-only booleans: anonymous sees none of them", async () => {
    await enableActions();
    const { run } = await seedRun(1);
    const res = await postJson(`/alice/demo/actions/runs/${run.id}`, null, {});
    expect(res.status).toBe(200);
    const body = await res.json<ViewResponse>();
    expect(body.state.run.canCancel).toBe(false);
    expect(body.state.run.canRerun).toBe(false);
    expect(body.state.run.canDeleteArtifact).toBe(false);
  });

  it("a done run flips done/canRerun and the durations spell Go's format", async () => {
    await enableActions();
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }, { jobId: "side", name: "side" }] });
    const started = new Date(T0.getTime() + 1000);
    const stopped = new Date(T0.getTime() + 6000);
    await setStatus(seeded.run.id, seeded.attempt.id, ACTION_STATUS_SUCCESS, {
      started,
      stopped,
      jobStatus: ACTION_STATUS_SUCCESS,
    });
    // The second job failed without continue-on-error → the run would fail;
    // keep the aggregate consistent with upstream's per-row reads: set it
    // success too, then flip ONE job to failure via the row (the builder
    // reads the attempt's status for run.status; canRerunFailed reads jobs).
    await drizzle(env.DB)
      .update(actionRunJobs)
      .set({ status: 2, started, stopped }) // failure
      .where(eq(actionRunJobs.jobId, "side"));

    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, 1, {});
    const body = await res.json<ViewResponse>();
    expect(body.state.run.done).toBe(true);
    expect(body.state.run.status).toBe("success"); // the ATTEMPT's stored status
    expect(body.state.run.canRerun).toBe(true);
    expect(body.state.run.canRerunFailed).toBe(true); // a failed job exists
    expect(body.state.run.canCancel).toBe(false); // done
    expect(body.state.run.canDeleteArtifact).toBe(true);
    expect(body.state.run.duration).toBe("5s"); // started→stopped, Go's spelling
    expect(body.state.run.jobs[0]!.duration).toBe("5s");
  });

  it("the job arm scopes currentJob (title + the waiting detail) and the summaries/artifacts scopes", async () => {
    await enableActions();
    const seeded = await seedRun(1, {
      jobs: [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest"] }],
    });
    // Artifacts: one name with two rows (the GROUP BY roll-up sums the size),
    // one expired row of another name.
    const attemptId = seeded.attempt.id;
    await env.DB.prepare(
      `INSERT INTO action_artifacts (run_id, run_attempt_id, repo_id, owner_id, file_size, artifact_path, artifact_name, status, created, updated, expired_unix)
       VALUES (?, ?, ?, 1, 100, 'a/b.txt', 'dist', 2, unixepoch(), unixepoch(), 0),
              (?, ?, ?, 1, 50, 'a/c.txt', 'dist', 2, unixepoch(), unixepoch(), 0),
              (?, ?, ?, 1, 30, 'a/d.txt', 'old', 4, unixepoch(), unixepoch(), 1)`,
    )
      .bind(seeded.run.id, attemptId, repo.id, seeded.run.id, attemptId, repo.id, seeded.run.id, attemptId, repo.id)
      .run();
    // Job summaries: two steps of one job (grouped into one item), plus a
    // workflow-level row (jobId 0).
    await env.DB.prepare(
      `INSERT INTO action_run_job_summaries (repo_id, run_id, run_attempt_id, job_id, step_index, content, content_type, created, updated)
       VALUES (?, ?, ?, ?, 0, '### Step zero', 'text/markdown', unixepoch(), unixepoch()),
              (?, ?, ?, ?, 1, '### Step one', 'text/markdown', unixepoch(), unixepoch()),
              (?, ?, ?, 0, 0, 'Workflow failed to parse', 'text/markdown', unixepoch(), unixepoch())`,
    )
      .bind(
        repo.id, seeded.run.id, seeded.attempt.id, seeded.jobRows[0]!.id,
        repo.id, seeded.run.id, seeded.attempt.id, seeded.jobRows[0]!.id,
        repo.id, seeded.run.id, seeded.attempt.id,
      )
      .run();

    // No runner seeded → the waiting detail names the no-runner arm.
    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`, 1, {});
    expect(res.status).toBe(200);
    const body = await res.json<ViewResponse>();
    expect(body.state.currentJob.title).toBe("build");
    expect(body.state.currentJob.detail).toBe(repoActionsViewDetailLocale.noRunnerOnline);
    expect(body.state.currentJob.steps).toEqual([]);

    // Summaries scope to the job arm's job; the workflow-level row (jobId 0)
    // joins only the summary view, and consecutive same-job rows group.
    const summaryView = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, 1, {});
    const summaryBody = await summaryView.json<ViewResponse>();
    expect(summaryBody.state.run.jobSummaries).toHaveLength(2); // the workflow row + the build group
    expect(summaryBody.state.run.jobSummaries![0]).toMatchObject({ jobId: 0, jobName: WORKFLOW_ID });
    expect(summaryBody.state.run.jobSummaries![1]!.jobId).toBe(seeded.jobRows[0]!.id);
    expect(summaryBody.state.run.jobSummaries![1]!.jobName).toBe("build");
    expect(summaryBody.state.run.jobSummaries![1]!.summaryHTML).toContain("Step zero");
    expect(summaryBody.state.run.jobSummaries![1]!.summaryHTML).toContain("Step one");

    // Artifacts: the name roll-up (sum 150 completed, 30 expired) and the
    // C4-gated previewLink stays ABSENT (the dead-link note).
    expect(summaryBody.artifacts).toHaveLength(2);
    const dist = summaryBody.artifacts.find((art) => art.name === "dist")!;
    expect(dist.size).toBe(150);
    expect(dist.status).toBe("completed");
    expect(dist.expiresUnix).toBe(0);
    expect("previewLink" in dist).toBe(false);
    const old = summaryBody.artifacts.find((art) => art.name === "old")!;
    expect(old.status).toBe("expired");
    expect(old.expiresUnix).toBe(1);
  });

  it("a pull_request event payload surfaces the PR nav and the fork-branch name", async () => {
    await enableActions();
    const payload = {
      number: 37,
      pull_request: {
        head: {
          label: "contributor:patch-1",
          ref: "patch-1",
          repo: { id: 99, full_name: "contributor/fork", name: "fork", owner: { login: "contributor" }, html_url: "https://test.local/contributor/fork" },
        },
      },
    };
    const seeded = await seedRun(1, {
      ref: "refs/pull/37/head",
      event: "pull_request",
      eventPayload: JSON.stringify(payload),
      triggerEvent: "pull_request",
    });
    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, 1, {});
    const body = await res.json<ViewResponse>();
    expect(body.state.run.pullRequest).toEqual({ index: "#37", link: "/alice/demo/pulls/37" });
    // The payload head names "contributor:patch-1" (the label's owner prefix;
    // the link composes from the head repo).
    expect(body.state.run.commit.branch.name).toBe("contributor:patch-1");
    // A bare head ref carries no RefType → RefWebLinkPath is empty (the
    // exact port), so the link composes "/src/" bare.
    expect(body.state.run.commit.branch.link).toBe("/contributor/fork/src/");
    expect(body.state.run.commit.branch.isDeleted).toBe(false);
  });

  it("the approval posture: needApproval flips canApprove + the currentJob detail", async () => {
    await enableActions();
    const seeded = await seedRun(1, {
      jobs: [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest"] }],
    });
    // needApproval rides no M1a insert input — the store-side column flips
    // directly (the M3 producer arm's write).
    await drizzle(env.DB).update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, seeded.run.id));
    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`, 1, {});
    const body = await res.json<ViewResponse>();
    expect(body.state.run.canApprove).toBe(true);
    expect(body.state.currentJob.detail).toBe(repoActionsViewDetailLocale.needApproval);
  });

  it("the attempts arm resolves the explicit attempt; a missing one answers the 500 (the ServerError arm)", async () => {
    await enableActions();
    const seeded = await seedRun(1);
    const ok = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/attempts/1`, 1, {});
    expect(ok.status).toBe(200);
    const okBody = await ok.json<ViewResponse>();
    expect(okBody.state.run.runAttempt).toBe(1);

    // A junk attempt number parses to 0 → the latest-attempt default.
    const junk = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/attempts/junk`, 1, {});
    expect(junk.status).toBe(200);

    // A nonexistent attempt number is upstream's ServerError → the 500 chrome.
    const missing = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/attempts/9`, 1, {});
    expect(missing.status).toBe(500);
  });

  it("the job arms: the ≥256 foreign job answers the 500; the same-run job resolves", async () => {
    await enableActions();
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const ok = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`, 1, {});
    expect(ok.status).toBe(200);

    // A stale/foreign job id ≥ MaxJobNumPerRun rides the pure-ID path, then
    // the run-scoped lookup misses → upstream's ServerError.
    const stale = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/999999`, 1, {});
    expect(stale.status).toBe(500);
  });

  it("the GET/POST resolution asymmetry: an index URL POSTs 404, only the GET redirects", async () => {
    await enableActions();
    await seedRun(5);
    const post = await postJson("/alice/demo/actions/runs/5", 1, {});
    expect(post.status).toBe(404); // ID-based only — no row id 5
    const get = await getRoute("/alice/demo/actions/runs/5", 1);
    expect(get.status).toBe(302); // the GET disambiguates-and-redirects
  });

  it("parseViewRequest reads the polling body (cursors accepted, junk tolerated)", () => {
    expect(parseViewRequest('{"logCursors":[{"step":1,"cursor":5,"expanded":true}]}')).toEqual({
      logCursors: [{ step: 1, cursor: 5, expanded: true }],
    });
    expect(parseViewRequest("{}")).toEqual({ logCursors: [] });
    expect(parseViewRequest("not json")).toEqual({ logCursors: [] });
    expect(parseViewRequest("")).toEqual({ logCursors: [] });
  });

  it("rejects a cross-origin POST with 403 before any read (the sameOriginGuard posture)", async () => {
    await enableActions();
    const { run } = await seedRun(1);
    const res = await postJson(`/alice/demo/actions/runs/${run.id}`, 1, {}, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });
});

// --- the cancel arm (the C5-adjacent write) --------------------------------------

describe("the cancel arm (POST runs/{run}/cancel — CancelRun's v1 reduction)", () => {
  beforeEach(async () => {
    await enableActions();
  });

  it("404-shells an anonymous viewer and a non-writer (RequireUnitWriter's NotFound)", async () => {
    const { run } = await seedRun(1);
    // bob: a signed-in non-collaborator — the public repo resolves for the
    // read, the writer gate 404-shells the write.
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, created_at) VALUES (2, 'bob', 'bob', unixepoch())",
    ).run();
    const anon = await fetchUi(`/alice/demo/actions/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: "{}",
    });
    expect(anon.status).toBe(404);
    const bob = await fetchUi(`/alice/demo/actions/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: await sessionCookie(2) },
      body: "{}",
    });
    expect(bob.status).toBe(404);
    const statuses = await drizzle(env.DB).select().from(actionRunJobs);
    expect(statuses.every((job) => job.status === ACTION_STATUS_WAITING)).toBe(true); // nothing written
  });

  it("rejects a cross-origin cancel with 403 (the guard rides first)", async () => {
    const { run } = await seedRun(1);
    const res = await fetchUi(`/alice/demo/actions/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: await sessionCookie(1) },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("cancels waiting jobs, settles the attempt + run to cancelled, and answers JSONOK", async () => {
    const seeded = await seedRun(1, {
      jobs: [{ jobId: "build" }, { jobId: "test", needs: ["build"] }],
    });
    const res = await fetchUi(`/alice/demo/actions/runs/${seeded.run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: await sessionCookie(1) },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true }); // ctx.JSONOK's dummy

    const jobs = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runId, seeded.run.id));
    expect(jobs.every((job) => job.status === 3 /* cancelled */)).toBe(true);
    expect(jobs.every((job) => job.stopped !== null)).toBe(true);
    const attempt = (await drizzle(env.DB).select().from(actionRunAttempts).where(eq(actionRunAttempts.id, seeded.attempt.id)))[0]!;
    expect(attempt.status).toBe(3);
    expect(attempt.stopped).not.toBeNull();
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.run.id)))[0]!;
    expect(stored.status).toBe(3);
  });

  it("the StopTask handshake: a cancelling-capable runner stays cancelling", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    // A runner WITH cancelling support, fresh task contact (last_online via
    // the seed's unixepoch(); the report timeout reads the TASK's updated).
    await env.DB.prepare(
      `INSERT INTO action_runners (uuid, name, owner_id, repo_id, agent_labels, has_cancelling_support, token_hash, last_online, created, updated)
       VALUES ('uuid-cap', 'cap', 0, '', '["ubuntu-latest"]', 1, 'runner-hash-cap', unixepoch(), unixepoch(), unixepoch())`,
    ).run();
    // The claimed task: runner 1 (the store's first autoincrement row),
    // updated one second ago — inside the 1-minute report window.
    await env.DB.prepare(
      `INSERT INTO action_tasks (id, job_id, attempt, runner_id, status, repo_id, owner_id, token_hash, created, updated)
       VALUES (900, ?, 1, 1, 6, ?, 1, 'task-hash-900', unixepoch(), strftime('%s','now') - 1)`,
    )
      .bind(seeded.jobRows[0]!.id, repo.id)
      .run();
    await drizzle(env.DB)
      .update(actionRunJobs)
      .set({ taskId: 900, status: ACTION_STATUS_RUNNING })
      .where(eq(actionRunJobs.id, seeded.jobRows[0]!.id));

    const res = await fetchUi(`/alice/demo/actions/runs/${seeded.run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: await sessionCookie(1) },
      body: "{}",
    });
    expect(res.status).toBe(200);

    // The task + job ride the CANCELLING handshake (the runner acknowledges
    // later — StopTask's StatusCancelling arm, task.go:473-494).
    const taskStatus = await env.DB.prepare("SELECT status FROM action_tasks WHERE id = 900").first<{ status: number }>();
    expect(taskStatus?.status).toBe(8);
    const job = (await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.id, seeded.jobRows[0]!.id)))[0]!;
    expect(job.status).toBe(8);
    const runAfter = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.run.id)))[0]!;
    expect(runAfter.status).toBe(8); // the aggregate mirrors cancelling
  });

  it("a done run answers JSONOK and changes nothing (the no-cancellable-jobs arm)", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    await setStatus(seeded.run.id, seeded.attempt.id, ACTION_STATUS_SUCCESS, {
      started: T0,
      stopped: new Date(T0.getTime() + 5000),
      jobStatus: ACTION_STATUS_SUCCESS,
    });
    const res = await fetchUi(`/alice/demo/actions/runs/${seeded.run.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: await sessionCookie(1) },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json<{ ok: boolean }>()).toEqual({ ok: true });
    const stored = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, seeded.run.id)))[0]!;
    expect(stored.status).toBe(ACTION_STATUS_SUCCESS); // untouched
  });

  it("the cancel POST resolves ID-based too (an index URL 404s like the JSON twin)", async () => {
    await seedRun(5);
    const res = await fetchUi("/alice/demo/actions/runs/5/cancel", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: await sessionCookie(1) },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("the cancel GET answers chi's 405 (the audit arm's convention)", async () => {
    const { run } = await seedRun(1);
    const res = await getRoute(`/alice/demo/actions/runs/${run.id}/cancel`, 1);
    expect(res.status).toBe(405);
  });
});

// --- the builder/formatter units ---------------------------------------------------

describe("the builder + formatter units (the census's byte-shape golden source)", () => {
  it("goDurationString spells Go's time.Duration.String over whole seconds", () => {
    expect(goDurationString(0)).toBe("0s");
    expect(goDurationString(5000)).toBe("5s");
    expect(goDurationString(60000)).toBe("1m0s");
    expect(goDurationString(65000)).toBe("1m5s");
    expect(goDurationString(3600_000)).toBe("1h0m0s");
    expect(goDurationString((1 * 3600 + 23 * 60 + 45) * 1000)).toBe("1h23m45s");
    expect(goDurationString((2 * 3600) * 1000)).toBe("2h0m0s");
    expect(goDurationString(-5)).toBe("0s"); // never negative
  });

  it("calculateDurationMs ports calculateDuration's fallback arms", async () => {
    const { calculateDurationMs } = await import("./repo-actions-view");
    const start = new Date(1000);
    const stop = new Date(6000);
    const updated = new Date(9000);
    expect(calculateDurationMs(null, null, 1, updated)).toBe(0); // no start
    expect(calculateDurationMs(start, stop, 1, updated)).toBe(5000); // done: start→stop
    expect(calculateDurationMs(start, null, 1, updated)).toBe(8000); // done, no stop: the updated fallback
    expect(calculateDurationMs(start, new Date(500), 1, updated)).toBe(8000); // backwards stop → the fallback
    // Running: now-truncated — the start rides 2.5 s behind the real clock,
    // so the count is 2.5 s within a jitter window (the truncated seconds).
    const liveStart = new Date(Date.now() - 2500);
    const live = calculateDurationMs(liveStart, null, 6, new Date());
    expect(live).toBeGreaterThanOrEqual(2000);
    expect(live).toBeLessThan(3500);
  });

  it("actionStatusDisplay carries the LocaleString spellings", () => {
    expect(actionStatusDisplay(5)).toBe("Waiting");
    expect(actionStatusDisplay(6)).toBe("Running");
    expect(actionStatusDisplay(8)).toBe("Canceling");
    expect(actionStatusDisplay(1)).toBe("Success");
    expect(actionStatusDisplay(99)).toBe("Unknown");
  });

  it("buildViewResponse marks the current job not-found when the path job misses the resolved attempt", async () => {
    await enableActions();
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const outcome = await buildViewResponse(env.DB, seeded.run, { attempt: seeded.attempt, jobs: seeded.jobRows }, {
      env,
      repo,
      canWriteActions: true,
      isSigned: true,
      attemptRaw: "",
      jobRaw: String(seeded.jobRows[0]!.id + 500), // not among the resolved jobs
    });
    expect(outcome.outcome).toBe("not-found"); // view.go:735-737's arm
  });

  it("insertActionRun ellipsizes the title (the store-side Title arm rides the response title)", () => {
    const long = "x".repeat(300);
    expect(ellipsisDisplayString(long, 255)).toHaveLength(255);
    expect(ellipsisDisplayString(long, 255).endsWith("…")).toBe(true);
  });
});
