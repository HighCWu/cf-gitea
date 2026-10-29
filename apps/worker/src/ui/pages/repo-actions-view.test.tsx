/**
 * The run-viewer subtree's tests (the census C2 arm — the C8 settings-actions
 * harness's minted-session route-level pattern over seeded M1a rows): the
 * parse/claim pin, the resolution matrix (id-vs-index, latest, by_id/by_index,
 * the ≥256 job-id arm), the mount shell's attribute contract, the ViewResponse
 * JSON pinned against view.go's field list, the attempts/jobs param arms with
 * their 404/500 fidelities, the cancel arm's gates + write reduction, and the
 * gate postures (the tab-region read gate — anonymous readers pass; the
 * writer gate 404-shells). The C3 arms (currentJob.steps + logs.stepsLog over
 * M1b's task/log store — FullSteps, the cursor protocol, the expired-log arm)
 * and the C4 arms (the artifacts panel data's previewLink flip + the preview
 * page/raw-serving module over seeded R2 objects) extend the same file per
 * the census's C3/C4 ownership rows.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { locale } from "../locale";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { actionArtifacts, actionLogChunks, actionRunAttempts, actionRunJobs, actionRuns, actionTaskSteps, actionTasks, repositories } from "../../db/schema";
import {
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
  ellipsisDisplayString,
  createRunner,
  insertActionRun,
  type TaskRow,
} from "../../services/actions/model";
import { updateLog, updateTaskByState } from "../../services/actions/update";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  actionStatusDisplay,
  buildViewResponse,
  convertToViewModel,
  EXPIRED_LOG_MESSAGE,
  fullStepsOfTask,
  goDurationString,
  parseViewRequest,
  renderRepoActionsViewPage,
  repoActionsViewDetailLocale,
  repoActionsViewLocale,
  resolveRunForView,
  type ViewResponse,
} from "./repo-actions-view";
import {
  ARTIFACT_PREVIEW_MAX_FILES,
  artifactPreviewLocale,
  artifactPreviewRawLink,
  artifactPreviewSignature,
  encodeContentDispositionInline,
  formatPreviewCount,
  insertArtifactPreviewHelperScript,
  loadArtifactPreviewPageData,
  normalizeArtifactPreviewPath,
  renderArtifactPreviewPage,
  serveArtifactPreviewContent,
  serveArtifactPreviewRaw,
  sniffPreviewContentType,
} from "./repo-actions-artifacts";

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
    "action_log_chunks",
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
    // C4-flipped previewLink (signed viewer, size ≤ the 10 MiB gate).
    expect(summaryBody.artifacts).toHaveLength(2);
    const artifactRows = await drizzle(env.DB)
      .select({ id: actionArtifacts.id, name: actionArtifacts.artifactName })
      .from(actionArtifacts);
    const distRowId = Math.min(
      ...artifactRows.filter((row) => row.name === "dist").map((row) => row.id),
    );
    const dist = summaryBody.artifacts.find((art) => art.name === "dist")!;
    expect(dist.size).toBe(150);
    expect(dist.status).toBe("completed");
    expect(dist.expiresUnix).toBe(0);
    expect(dist.previewLink).toBe(`/alice/demo/actions/artifacts/${distRowId}/preview`);
    // The expired name carries the link too (upstream gates on size only).
    const oldRowId = Math.min(...artifactRows.filter((row) => row.name === "old").map((row) => row.id));
    const old = summaryBody.artifacts.find((art) => art.name === "old")!;
    expect(old.status).toBe("expired");
    expect(old.expiresUnix).toBe(1);
    expect(old.previewLink).toBe(`/alice/demo/actions/artifacts/${oldRowId}/preview`);

    // Anonymous viewers get NO preview link (the isSigned arm) — the roll-up
    // and every other field ride unchanged.
    const anon = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, null, {});
    const anonBody = await anon.json<ViewResponse>();
    expect(anonBody.artifacts.find((art) => art.name === "dist")!.previewLink).toBeUndefined();
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

// --- the C3 arms (currentJob.steps + logs.stepsLog over M1b's store) ---------

describe("the C3 arms — FullSteps (modules/actions/task_state.go)", () => {
  /** A minimal task row (the fields FullSteps reads); steps insert through
   *  the schema when a test needs stored rows. */
  function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
    const now = new Date(1_700_000_000 * 1000);
    return {
      id: 1,
      jobId: 1,
      attempt: 1,
      runnerId: 1,
      status: 6, // running
      started: now,
      stopped: null,
      repoId: "repo-demo",
      ownerId: 1,
      commitSha: "",
      isForkPullRequest: false,
      tokenHash: "",
      tokenSalt: "",
      tokenLastEight: "",
      logFilename: "o/r/ab/t.log",
      logInStorage: false,
      logLength: 5,
      logSize: 100,
      logIndexes: null,
      logExpired: false,
      created: now,
      updated: now,
      ...overrides,
    };
  }

  function stepRow(overrides: Partial<typeof actionTaskSteps.$inferSelect> & { id: number }): typeof actionTaskSteps.$inferSelect {
    const now = new Date(1_700_000_000 * 1000);
    return {
      taskId: 1,
      index: overrides.id,
      repoId: "repo-demo",
      name: "",
      status: 0,
      logIndex: 0,
      logLength: 0,
      stage: 0,
      number: 0,
      started: null,
      stopped: null,
      created: now,
      updated: now,
      ...overrides,
    };
  }

  it("synthesizes Set up job / Complete job around parsed steps (task_state.go:16-95)", () => {
    const started = new Date(1000);
    const task = taskRow({ status: 6, started, logLength: 5 });
    const steps = [
      stepRow({ id: 0, name: "Checkout", status: 1, logIndex: 0, logLength: 2, started, stopped: new Date(3000), updated: new Date(3000) }),
      stepRow({ id: 1, name: "Build", status: 2 /* failure */, logIndex: 2, logLength: 3, started: new Date(3000), stopped: new Date(5000), updated: new Date(5000) }),
    ];
    const full = fullStepsOfTask(task, steps);
    expect(full.map((s) => s.name)).toEqual(["Set up job", "Checkout", "Build", "Complete job"]);
    // preStep: success, its log range = the first run step's LogIndex, its
    // stop = that step's start.
    const [pre, , , post] = full;
    expect(pre).toMatchObject({ status: 1, logIndex: 0, logLength: 0, started, stopped: started });
    // The last run step FAILED → postStep has started (running), its range
    // spanning the tail of the task's log.
    expect(post).toMatchObject({ status: 6, logIndex: 5, logLength: 0, started: new Date(5000), stopped: null });
  });

  it("a fully-done task colors postStep with the task's status (task_state.go:85-88)", () => {
    const started = new Date(1000);
    const stopped = new Date(6000);
    const task = taskRow({ status: 1 /* success */, started, stopped, logLength: 5 });
    const steps = [
      stepRow({ id: 0, name: "Checkout", status: 1, logIndex: 0, logLength: 5, started, stopped, updated: stopped }),
      stepRow({ id: 1, name: "Build", status: 4 /* skipped */, logIndex: 5, logLength: 0, started: null, stopped: null, updated: stopped }),
    ];
    const [, , , post] = fullStepsOfTask(task, steps);
    expect(post).toMatchObject({ status: 1, stopped });
  });

  it("fullStepsOfEmptySteps renders the task's own log range (task_state.go:97-127)", () => {
    const started = new Date(1000);
    const stopped = new Date(6000);
    // A done SUCCESS task: both steps success.
    const [pre, post] = fullStepsOfTask(taskRow({ status: 1, started, stopped }), []);
    expect(pre).toMatchObject({ name: "Set up job", status: 1, logLength: 5, started, stopped });
    expect(post).toMatchObject({ name: "Complete job", status: 1, logIndex: 5, started: stopped });
    // A running task: preStep running, postStep waiting.
    const [livePre, livePost] = fullStepsOfTask(taskRow({ status: 6, started, stopped: null }), []);
    expect(livePre?.status).toBe(6);
    expect(livePost?.status).toBe(5);
    // A done FAILED task: preStep failure, postStep cancelled (upstream's
    // "else cancelled" arm).
    const [failPre, failPost] = fullStepsOfTask(taskRow({ status: 2, started, stopped }), []);
    expect(failPre?.status).toBe(2);
    expect(failPost?.status).toBe(3);
  });

  it("a runner-reported layout rides verbatim (steps[0].IsReport())", () => {
    const task = taskRow({});
    const steps = [
      stepRow({ id: 0, name: "Set up", stage: 1, status: 1 }),
      stepRow({ id: 1, name: "Main", stage: 4, number: 1, status: 6 }),
    ];
    const full = fullStepsOfTask(task, steps);
    expect(full.map((s) => s.name)).toEqual(["Set up", "Main"]);
  });
});

describe("the C3 arms — convertToViewModel over the M1b log store (view.go:835-917)", () => {
  /** The M1b seeding idioms (ingest.test.ts's claimTask + the service
   *  writers): a runner, a claimed task, the job flipped onto it. */
  async function claimTask(seeded: Awaited<ReturnType<typeof seedRun>>, jobOrdinal = 0): Promise<{ taskId: number; runnerId: number }> {
    const runner = await createRunner(env.DB, {
      uuid: crypto.randomUUID(),
      name: "view-runner",
      version: "test",
      ownerId: 0,
      repoId: "",
      agentLabels: ["ubuntu-latest"],
      ephemeral: false,
      hasCancellingSupport: false,
    });
    const job = seeded.jobRows[jobOrdinal]!;
    const now = new Date();
    const rows = await drizzle(env.DB)
      .insert(actionTasks)
      .values({
        jobId: job.id,
        attempt: 1,
        runnerId: runner.id,
        status: 6,
        started: now,
        repoId: job.repoId,
        ownerId: job.ownerId,
        commitSha: job.commitSha,
        tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        tokenSalt: "s",
        tokenLastEight: "viewc03",
        logFilename: `alice/demo/${(Math.floor(Math.random() * 255) + 1).toString(16).padStart(2, "0")}/t.log`,
        created: now,
        updated: now,
      })
      .returning();
    const task = rows[0]!;
    await drizzle(env.DB)
      .update(actionRunJobs)
      .set({ taskId: task.id, status: ACTION_STATUS_RUNNING, started: now })
      .where(eq(actionRunJobs.id, job.id));
    return { taskId: task.id, runnerId: runner.id };
  }

  beforeEach(async () => {
    await enableActions();
  });

  it("answers the steps list and the stepped log lines each cursor still needs", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build", name: "build" }] });
    const claim = await claimTask(seeded);

    // The runner reports its own layout: setup (done) + build (running).
    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 1, startedAt: { seconds: 1700000000, nanos: 0 }, stoppedAt: { seconds: 1700000002, nanos: 0 }, logIndex: 0, logLength: 2, name: "Set up", stage: 1, number: 0 },
        { id: 1, result: 0, startedAt: { seconds: 1700000002, nanos: 0 }, stoppedAt: undefined, logIndex: 2, logLength: 3, name: "Build", stage: 4, number: 1 },
      ],
    });
    // Five log rows: two setup, three build.
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1700000000, nanos: 0 }, content: "setup a" },
        { time: { seconds: 1700000001, nanos: 0 }, content: "setup b" },
      ],
      noMore: false,
    });
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 2,
      rows: [
        { time: { seconds: 1700000002, nanos: 0 }, content: "build one" },
        { time: { seconds: 1700000003, nanos: 0 }, content: "build two" },
        { time: { seconds: 1700000004, nanos: 0 }, content: "build three" },
      ],
      noMore: false,
    });

    const taskRows = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, claim.taskId));
    const stepRows = await drizzle(env.DB).select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId)).orderBy(actionTaskSteps.index);
    const { steps, logs } = await convertToViewModel(
      env,
      [
        { step: 0, cursor: 0, expanded: true },
        { step: 1, cursor: 0, expanded: true },
        { step: 1, cursor: 1, expanded: true }, // the incremental tail
        { step: 2, cursor: 0, expanded: true }, // out of range → skipped
        { step: 0, cursor: 0, expanded: false }, // collapsed → skipped
      ],
      taskRows[0]!,
      stepRows,
    );

    // The steps list: the reported names, the success/running wire spellings.
    // Durations ride applyState's report wall clock (upstream stamps
    // started/stopped = now, ignoring the reported instants) — 0s both.
    expect(steps.map((s) => ({ summary: s.summary, status: s.status, duration: s.duration }))).toEqual([
      { summary: "Set up", status: "success", duration: "0s" },
      { summary: "Build", status: "running", duration: "0s" },
    ]);

    // The logs: three entries (the out-of-range and collapsed cursors dropped).
    expect(logs).toHaveLength(3);
    expect(logs[0]).toEqual({
      step: 0,
      cursor: 2,
      lines: [
        { index: 1, message: "setup a", timestamp: 1700000000 },
        { index: 2, message: "setup b", timestamp: 1700000001 },
      ],
    });
    expect(logs[1]!.lines.map((line) => line.message)).toEqual(["build one", "build two", "build three"]);
    expect(logs[1]!.cursor).toBe(3);
    // The incremental cursor: rows 3..4, line indexes 2..3, cursor caught up.
    expect(logs[2]).toEqual({
      step: 1,
      cursor: 3,
      lines: [
        { index: 2, message: "build two", timestamp: 1700000003 },
        { index: 3, message: "build three", timestamp: 1700000004 },
      ],
    });
  });

  it("a cursor outrunning the stored log answers the SAME cursor with empty lines", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seeded);
    // Steps claim five lines; only two rows exist yet — the "task data older
    // than step data" retry shape.
    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 1, startedAt: { seconds: 1, nanos: 0 }, stoppedAt: { seconds: 2, nanos: 0 }, logIndex: 0, logLength: 5, name: "All", stage: 4, number: 1 },
      ],
    });
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1, nanos: 0 }, content: "a" },
        { time: { seconds: 2, nanos: 0 }, content: "b" },
      ],
      noMore: false,
    });
    const taskRows = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, claim.taskId));
    const stepRows = await drizzle(env.DB).select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId));
    const { logs } = await convertToViewModel(env, [{ step: 0, cursor: 2, expanded: true }], taskRows[0]!, stepRows);
    expect(logs).toEqual([{ step: 0, cursor: 2, lines: [] }]);
  });

  it("the log-expired arm answers the purge line on the first fetch only", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seeded);
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 0,
      rows: [{ time: { seconds: 1, nanos: 0 }, content: "gone" }],
      noMore: false,
    });
    await drizzle(env.DB).update(actionTasks).set({ logExpired: true }).where(eq(actionTasks.id, claim.taskId));
    const taskRows = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, claim.taskId));
    const stepRows = await drizzle(env.DB).select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId));

    const first = await convertToViewModel(env, [{ step: 0, cursor: 0, expanded: true }], taskRows[0]!, stepRows);
    // No steps reported → the synthesized Set up/Complete pair; the expired
    // arm replaces the log read with the one purge line.
    expect(first.steps.map((s) => s.summary)).toEqual(["Set up job", "Complete job"]);
    expect(first.logs).toEqual([
      { step: 0, cursor: 1, lines: [{ index: 1, message: EXPIRED_LOG_MESSAGE, timestamp: taskRows[0]!.updated.getTime() / 1000 }] },
    ]);
    const second = await convertToViewModel(env, [{ step: 0, cursor: 1, expanded: true }], taskRows[0]!, stepRows);
    expect(second.logs).toEqual([]);
  });

  it("the route-level POST wires steps + stepsLog through the ViewResponse", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build", name: "build" }] });
    const claim = await claimTask(seeded);
    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 1, startedAt: { seconds: 1700000000, nanos: 0 }, stoppedAt: { seconds: 1700000001, nanos: 0 }, logIndex: 0, logLength: 1, name: "Set up", stage: 1, number: 0 },
      ],
    });
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 0,
      rows: [{ time: { seconds: 1700000000, nanos: 0 }, content: "hello from the runner" }],
      noMore: false,
    });

    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`, 1, {
      logCursors: [{ step: 0, cursor: 0, expanded: true }],
    });
    expect(res.status).toBe(200);
    const body = await res.json<ViewResponse>();
    expect(body.state.currentJob.title).toBe("build");
    expect(body.state.currentJob.steps).toEqual([
      { summary: "Set up", status: "success", duration: "0s" }, // applyState stamps started=stopped=now
    ]);
    expect(body.logs.stepsLog).toEqual([
      { step: 0, cursor: 1, lines: [{ index: 1, message: "hello from the runner", timestamp: 1700000000 }] },
    ]);

    // The summary view (no job param) keeps the EMPTY currentJob/logs arrays —
    // view.go's findCurrentJobByPathParam nil arm — even with a live task.
    const summary = await postJson(`/alice/demo/actions/runs/${seeded.run.id}`, 1, {
      logCursors: [{ step: 0, cursor: 0, expanded: true }],
    });
    const summaryBody = await summary.json<ViewResponse>();
    expect(summaryBody.state.currentJob.steps).toEqual([]);
    expect(summaryBody.logs.stepsLog).toEqual([]);
  });

  it("a waiting job without a task keeps the empty arrays (the C2 shell shape)", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const res = await postJson(`/alice/demo/actions/runs/${seeded.run.id}/jobs/${seeded.jobRows[0]!.id}`, 1, {
      logCursors: [{ step: 0, cursor: 0, expanded: true }],
    });
    const body = await res.json<ViewResponse>();
    expect(body.state.currentJob.steps).toEqual([]);
    expect(body.logs.stepsLog).toEqual([]);
  });

  it("the sealed-log read rides the same cursor arm (log_in_storage flipped)", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const claim = await claimTask(seeded);
    await updateTaskByState(env.DB, claim.runnerId, {
      id: claim.taskId,
      result: 0,
      startedAt: undefined,
      stoppedAt: undefined,
      steps: [],
      reportedSteps: [
        { id: 0, result: 1, startedAt: { seconds: 1, nanos: 0 }, stoppedAt: { seconds: 2, nanos: 0 }, logIndex: 0, logLength: 2, name: "All", stage: 4, number: 1 },
      ],
    });
    await updateLog(env, claim.runnerId, {
      taskId: claim.taskId,
      index: 0,
      rows: [
        { time: { seconds: 1, nanos: 0 }, content: "hot a" },
        { time: { seconds: 2, nanos: 0 }, content: "hot b" },
      ],
      noMore: true, // seal to R2
    });
    const taskRows = await drizzle(env.DB).select().from(actionTasks).where(eq(actionTasks.id, claim.taskId));
    expect(taskRows[0]!.logInStorage).toBe(true);
    const chunks = await drizzle(env.DB).select().from(actionLogChunks).where(eq(actionLogChunks.taskId, claim.taskId));
    expect(chunks).toHaveLength(0); // the chunk rows dropped after the seal
    const stepRows = await drizzle(env.DB).select().from(actionTaskSteps).where(eq(actionTaskSteps.taskId, claim.taskId));
    const { logs } = await convertToViewModel(env, [{ step: 0, cursor: 0, expanded: true }], taskRows[0]!, stepRows);
    expect(logs[0]!.lines.map((line) => line.message)).toEqual(["hot a", "hot b"]);
  });
});

// --- the C4 arms (the artifacts panel data + the preview module) --------------

describe("the C4 arms — the preview page module (pages/repo-actions-artifacts.tsx)", () => {
  /** Seed one confirmed artifact row; returns its row. */
  async function seedArtifact(opts: {
    runId: number;
    runAttemptId: number;
    name: string;
    path: string;
    size?: number;
    status?: number;
    encoding?: string;
  }): Promise<{ id: number; storagePath: string }> {
    const storagePath = `actions/artifacts/${opts.runId}/${Math.floor(Math.random() * 1e9)}`;
    const rows = await drizzle(env.DB)
      .insert(actionArtifacts)
      .values({
        runId: opts.runId,
        runAttemptId: opts.runAttemptId,
        runnerId: 0,
        repoId: repo.id,
        ownerId: 1,
        commitSha: SHA,
        storagePath,
        fileSize: opts.size ?? 7,
        fileCompressedSize: opts.size ?? 7,
        contentEncodingOrType: opts.encoding ?? "",
        artifactPath: opts.path,
        artifactName: opts.name,
        status: opts.status ?? 2, // UploadConfirmed
        created: T0,
        updated: T0,
        expiredUnix: 0,
      })
      .returning({ id: actionArtifacts.id });
    return { id: rows[0]!.id, storagePath };
  }

  /** A minimal readable zip (local headers + central directory + EOCD). */
  async function makeZip(entries: Array<{ name: string; data: string; method: 0 | 8 }>): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      let payload = encoder.encode(entry.data);
      if (entry.method === 8) {
        const deflated = await new Response(
          new Response(new Uint8Array(payload)).body!.pipeThrough(new CompressionStream("deflate-raw")),
        ).arrayBuffer();
        payload = new Uint8Array(deflated);
      }
      const header = new Uint8Array(30 + nameBytes.length);
      const hView = new DataView(header.buffer);
      hView.setUint32(0, 0x04034b50, true);
      hView.setUint16(4, 20, true);
      hView.setUint16(8, entry.method, true);
      hView.setUint32(18, payload.length, true); // compressed
      hView.setUint32(22, encoder.encode(entry.data).length, true); // uncompressed
      hView.setUint16(26, nameBytes.length, true);
      header.set(nameBytes, 30);
      parts.push(header, payload);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cView = new DataView(cd.buffer);
      cView.setUint32(0, 0x02014b50, true);
      cView.setUint16(4, 20, true);
      cView.setUint16(6, 20, true);
      cView.setUint16(10, entry.method, true);
      cView.setUint32(20, payload.length, true);
      cView.setUint32(24, encoder.encode(entry.data).length, true);
      cView.setUint16(28, nameBytes.length, true);
      cView.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += header.length + payload.length;
    }
    const cdStart = offset;
    const cdBytes = central.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const eView = new DataView(eocd.buffer);
    eView.setUint32(0, 0x06054b50, true);
    eView.setUint16(8, entries.length, true);
    eView.setUint16(10, entries.length, true);
    eView.setUint32(12, cdBytes, true);
    eView.setUint32(16, cdStart, true);
    const total = cdStart + cdBytes + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of [...parts, ...central, eocd]) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  async function putObject(key: string, bytes: Uint8Array): Promise<void> {
    await env.REPO_PACKS.put(key, bytes);
  }

  beforeEach(async () => {
    await enableActions();
  });

  it("the signed link composes the root raw URL with a one-hour expiry", async () => {
    const link = await artifactPreviewRawLink(env, 42);
    const match = /^\/-\/actions\/artifacts\/42\/(\d+)\/([A-Za-z0-9_-]+)\/$/.exec(link);
    expect(match).not.toBeNull();
    const expires = Number(match![1]);
    const now = Math.floor(Date.now() / 1000);
    expect(expires).toBeGreaterThan(now + 55 * 60);
    expect(expires).toBeLessThan(now + 65 * 60);
    // The signature verifies round-trip; a forged one does not.
    expect(await artifactPreviewSignature(env, 42, expires)).toBe(match![2]);
    expect(await artifactPreviewSignature(env, 43, expires)).not.toBe(match![2]);
  });

  it("the legacy artifact's preview data builds the tree, the selected arm, and the content URL", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const first = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "a/b.txt", size: 100 });
    await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "a/c.txt", size: 50 });

    const outcome = await loadArtifactPreviewPageData(env, repo, first.id, "a/b.txt");
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    const data = outcome.data;
    // The attempt arm rewrites runUrl (upstream appends /attempts/N).
    expect(data.runUrl).toBe(`/alice/demo/actions/runs/${seeded.run.id}/attempts/1`);
    expect(data.runIndex).toBe(1);
    expect(data.runAttempt).toBe(1);
    expect(data.artifactName).toBe("dist");
    expect(data.downloadUrl).toBe(`/alice/demo/actions/runs/${seeded.run.id}/artifacts/dist?attempt=1`);
    expect(data.previewFiles).toEqual([
      { path: "a", name: "a", link: "", depth: 0, selected: false },
      {
        path: "a/b.txt",
        name: "b.txt",
        link: `/alice/demo/actions/artifacts/${first.id}/preview/a/b.txt`,
        depth: 1,
        selected: true,
      },
      {
        path: "a/c.txt",
        name: "c.txt",
        link: `/alice/demo/actions/artifacts/${first.id}/preview/a/c.txt`,
        depth: 1,
        selected: false,
      },
    ]);
    expect(data.previewContentUrl).toMatch(new RegExp(`^/-/actions/artifacts/${first.id}/\\d+/[A-Za-z0-9_-]+/a/b\\.txt$`));
    expect(data.previewTooLarge).toBe(false);
    expect(data.requestedPathMissing).toBe(false);

    // A requested path OUTSIDE the listing (not truncated) → the missing
    // banner and no content URL.
    const missing = await loadArtifactPreviewPageData(env, repo, first.id, "a/zzz.txt");
    if (missing.outcome !== "ok") return;
    expect(missing.data.requestedPathMissing).toBe(true);
    expect(missing.data.previewContentUrl).toBe("");
  });

  it("the raw serving: legacy rows (plain + gzip-on-store) and the document redirect", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const plain = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "b.txt", size: 7 });
    await putObject(plain.storagePath, new TextEncoder().encode("hello b"));

    // Plain row.
    const ok = await serveArtifactPreviewRaw(env, {
      artifactId: plain.id,
      expires: Math.floor(Date.now() / 1000) + 600,
      signature: await artifactPreviewSignature(env, plain.id, Math.floor(Date.now() / 1000) + 600),
      tail: "b.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello b");
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");

    // A top-level navigation 302s to the repo preview page (the generated-
    // content redirect arm), escaping the path segments.
    const expiresDoc = Math.floor(Date.now() / 1000) + 600;
    const doc = await serveArtifactPreviewRaw(env, {
      artifactId: plain.id,
      expires: expiresDoc,
      signature: await artifactPreviewSignature(env, plain.id, expiresDoc),
      tail: "a/b.txt",
      secFetchDest: "document",
      helperScriptSrc: null,
    });
    expect(doc.status).toBe(302);
    expect(doc.headers.get("location")).toBe(`/alice/demo/actions/artifacts/${plain.id}/preview/a/b.txt`);

    // Gzip-on-store row: the legacy gunzip arm.
    const raw = new TextEncoder().encode("gzipped contents");
    const gzipped = new Uint8Array(
      await new Response(new Response(new Uint8Array(raw)).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
    );
    const gz = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "c.txt", size: raw.length, encoding: "gzip" });
    await putObject(gz.storagePath, gzipped);
    const expiresGz = Math.floor(Date.now() / 1000) + 600;
    const servedGz = await serveArtifactPreviewRaw(env, {
      artifactId: gz.id,
      expires: expiresGz,
      signature: await artifactPreviewSignature(env, gz.id, expiresGz),
      tail: "c.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(servedGz.status).toBe(200);
    expect(await servedGz.text()).toBe("gzipped contents");
  });

  it("the v4 zip artifact: the listing reads the central directory, the raw arm inflates entries", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const zipBytes = await makeZip([
      { name: "docs/readme.txt", data: "readme body", method: 0 },
      { name: "main.js", data: "console.log('hi');", method: 8 },
    ]);
    const art = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist-v4", path: "unused", size: zipBytes.length, encoding: "application/zip" });
    await putObject(art.storagePath, zipBytes);

    // The listing: both entries, directories synthesized, sorted.
    const listing = await loadArtifactPreviewPageData(env, repo, art.id, "");
    expect(listing.outcome).toBe("ok");
    if (listing.outcome !== "ok") return;
    expect(listing.data.previewFiles.map((file) => `${file.path}|${file.depth}`)).toEqual(["docs|0", "docs/readme.txt|1", "main.js|0"]);
    expect(listing.data.previewContentUrl).toBe(""); // no requested path

    // The stored entry serves verbatim with its well-known mime.
    const expiresStored = Math.floor(Date.now() / 1000) + 600;
    const stored = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires: expiresStored,
      signature: await artifactPreviewSignature(env, art.id, expiresStored),
      tail: "docs/readme.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(stored.status).toBe(200);
    expect(await stored.text()).toBe("readme body");

    // The deflated entry inflates (the platform deflate-raw arm) and the .js
    // extension rides the well-known content type.
    const expiresDeflated = Math.floor(Date.now() / 1000) + 600;
    const deflated = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires: expiresDeflated,
      signature: await artifactPreviewSignature(env, art.id, expiresDeflated),
      tail: "main.js",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(deflated.status).toBe(200);
    expect(deflated.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await deflated.text()).toBe("console.log('hi');");

    // A missing entry inside a valid zip 404s.
    const expiresMiss = Math.floor(Date.now() / 1000) + 600;
    const miss = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires: expiresMiss,
      signature: await artifactPreviewSignature(env, art.id, expiresMiss),
      tail: "nope.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(miss.status).toBe(404);
  });

  it("a broken v4 zip falls back to the row's own path (the ErrFormat arm)", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const fallbackBytes = new TextEncoder().encode("definitely not a zip");
    const art = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "bin", path: "single/file.bin", size: fallbackBytes.length, encoding: "application/zip" });
    await putObject(art.storagePath, fallbackBytes);

    const listing = await loadArtifactPreviewPageData(env, repo, art.id, "");
    if (listing.outcome !== "ok") return;
    expect(listing.data.previewFiles.map((file) => file.path)).toEqual(["single", "single/file.bin"]);

    const expires = Math.floor(Date.now() / 1000) + 600;
    const served = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires,
      signature: await artifactPreviewSignature(env, art.id, expires),
      tail: "single/file.bin",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("definitely not a zip");
  });

  it("the raw gates: a forged signature and a stale expiry 404; a foreign repo's artifact errors", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const art = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "b.txt" });
    const expires = Math.floor(Date.now() / 1000) + 600;

    const forged = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires,
      signature: await artifactPreviewSignature(env, art.id + 1, expires), // signed for another artifact
      tail: "b.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(forged.status).toBe(404);

    const stale = await serveArtifactPreviewRaw(env, {
      artifactId: art.id,
      expires: Math.floor(Date.now() / 1000) - 10,
      signature: await artifactPreviewSignature(env, art.id, Math.floor(Date.now() / 1000) - 10),
      tail: "b.txt",
      secFetchDest: "empty",
      helperScriptSrc: null,
    });
    expect(stale.status).toBe(404);

    // Repo scoping on the PAGE arm: another repo's artifact is the error arm.
    const savedRepo = repo;
    repo = await seedRepo("other");
    const foreign = await loadArtifactPreviewPageData(env, repo, art.id, "");
    expect(foreign.outcome).toBe("error");
    repo = savedRepo;

    // A missing artifact row: the page arm errors (upstream's ServerError).
    expect((await loadArtifactPreviewPageData(env, repo, art.id + 999, "")).outcome).toBe("error");
  });

  it("serveArtifactPreviewContent enforces the per-file cap and the sniffer gate", () => {
    // Over MaxDisplayFileSize → 413 (checked before any read — size comes
    // from the zip metadata / the row).
    expect(serveArtifactPreviewContent("big.bin", new Uint8Array(0), 8 * 1024 * 1024 + 1, { helperScriptSrc: null }).status).toBe(413);
    // Binary content (NUL bytes) → 415.
    expect(serveArtifactPreviewContent("bin.bin", new Uint8Array([0, 1, 2, 3]), 4, { helperScriptSrc: null }).status).toBe(415);
    // Text serves inline with the disposition; PNG magic serves as an image.
    const text = serveArtifactPreviewContent("notes.txt", new TextEncoder().encode("plain notes"), 11, { helperScriptSrc: null });
    expect(text.headers.get("content-disposition")).toBe("inline; filename=notes.txt");
    const png = serveArtifactPreviewContent("i.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 8, { helperScriptSrc: null });
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it("the helper-script injection rides the first structural tag (view_artifact.go:261-306)", () => {
    const src = "/assets/js/external-render-helper.abc123.js";
    // After <head>.
    const withHead = new TextEncoder().encode("<html><head><title>t</title></head><body></body></html>");
    const injectedHead = new TextDecoder().decode(insertArtifactPreviewHelperScript(withHead, src));
    expect(injectedHead).toBe(`<html><head><script crossorigin src="${src}"></script><title>t</title></head><body></body></html>`);
    // No <head>: before <body>, wrapped in a synthesized head.
    const bodyOnly = new TextEncoder().encode("<html><body>hi</body></html>");
    const injectedBody = new TextDecoder().decode(insertArtifactPreviewHelperScript(bodyOnly, src));
    expect(injectedBody).toBe(`<html><head><script crossorigin src="${src}"></script></head><body>hi</body></html>`);
    // No insertion point: prepended.
    const bare = new TextEncoder().encode("just text");
    const injectedBare = new TextDecoder().decode(insertArtifactPreviewHelperScript(bare, src));
    expect(injectedBare).toBe(`<script crossorigin src="${src}"></script>just text`);
  });

  it("the sniffer covers the preview gate's signature families", () => {
    const enc = new TextEncoder();
    expect(sniffPreviewContentType(enc.encode("<svg xmlns='x'>"))).toBe("image/svg+xml");
    expect(sniffPreviewContentType(enc.encode("<?xml version='1.0'?><!DOCTYPE svg><svg>"))).toBe("image/svg+xml");
    expect(sniffPreviewContentType(enc.encode("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(sniffPreviewContentType(enc.encode("GIF89a...."))).toBe("image/gif");
    expect(sniffPreviewContentType(enc.encode("plain text"))).toBe("text/plain; charset=utf-8");
    expect(sniffPreviewContentType(new Uint8Array([0, 1, 2, 3]))).toBe("application/octet-stream");
  });

  it("the path helpers port PathJoinRelX/PathEscapeSegments exactly", () => {
    expect(normalizeArtifactPreviewPath("a/b/../c")).toBe("a/c");
    expect(normalizeArtifactPreviewPath("/abs/path")).toBe("abs/path");
    expect(normalizeArtifactPreviewPath("back\\slash\\win")).toBe("back/slash/win");
    expect(normalizeArtifactPreviewPath(".")).toBe("");
    expect(normalizeArtifactPreviewPath("..")).toBe("");
    expect(normalizeArtifactPreviewPath("")).toBe("");
  });

  it("the preview page renders the DOM contract (artifact_preview.tmpl)", async () => {
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const art = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "dist", path: "a/b.txt", size: 3 });
    await putObject(art.storagePath, new TextEncoder().encode("abc"));
    const outcome = await loadArtifactPreviewPageData(env, repo, art.id, "a/b.txt");
    if (outcome.outcome !== "ok") throw new Error("preview data failed");
    const html = renderArtifactPreviewPage(ctx, outcome.data);

    // The page-content discriminator classes + the back link + the download
    // button.
    expect(html).toContain("page-content repository actions");
    expect(html).toContain(`href="/alice/demo/actions/runs/${seeded.run.id}/attempts/1"`);
    expect(html).toContain(formatPreviewCount(artifactPreviewLocale.backToRunAttempt, 1, 1));
    expect(html).toContain(`href="/alice/demo/actions/runs/${seeded.run.id}/artifacts/dist?attempt=1"`);
    // The file tree: the directory row (no link) and the selected file row.
    expect(html).toContain(`style="--depth: 0"`);
    expect(html).toContain(`class="item flex-text-block artifact-preview-item active"`);
    expect(html).toContain(`title="a/b.txt"`);
    // The sandboxed iframe with the bundle's only hook on this page.
    expect(html).toContain(`data-global-init="initExternalRenderIframe"`);
    expect(html).toContain(`referrerpolicy="no-referrer"`);
    expect(html).toMatch(new RegExp(`data-src="/-/actions/artifacts/${art.id}/\\d+/[A-Za-z0-9_-]+/a/b\\.txt"`));
    // The preview title (the fixture ctx carries no repo, so the suffix is
    // the instance name — the route ctx appends owner/repo like C2's shell).
    expect(html).toContain("<title>Preview - cf-gitea</title>");
  });

  it("the truncated listing inserts the requested path instead of the missing banner", async () => {
    // The cap is 2000 — seed the artifact's listing through the module
    // constant directly (a 2001-path zip) and request a path beyond it.
    const seeded = await seedRun(1, { jobs: [{ jobId: "build" }] });
    const paths = Array.from({ length: ARTIFACT_PREVIEW_MAX_FILES + 1 }, (_, i) => `f${String(i).padStart(5, "0")}.txt`);
    const zipBytes = await makeZip(paths.map((p) => ({ name: p, data: "x", method: 0 as const })));
    const art = await seedArtifact({ runId: seeded.run.id, runAttemptId: seeded.attempt.id, name: "many", path: "unused", size: zipBytes.length, encoding: "application/zip" });
    await putObject(art.storagePath, zipBytes);

    const outcome = await loadArtifactPreviewPageData(env, repo, art.id, "f00000.txt"); // sorts first — pushed OUT by the cap
    if (outcome.outcome !== "ok") return;
    expect(outcome.data.previewFilesTruncated).toBe(true);
    // The requested file re-enters at its sorted position; no missing banner.
    expect(outcome.data.requestedPathMissing).toBe(false);
    expect(outcome.data.previewFiles.some((file) => file.path === "f00000.txt" && file.selected)).toBe(true);
    expect(outcome.data.previewFiles).toHaveLength(ARTIFACT_PREVIEW_MAX_FILES);
  });

  it("encodeContentDispositionInline spells the RFC 2231 pair for exotic names", () => {
    expect(encodeContentDispositionInline("plain.txt")).toBe("inline; filename=plain.txt");
    expect(encodeContentDispositionInline("with space.txt")).toBe(`inline; filename="with space.txt"`);
    const exotic = encodeContentDispositionInline("résumé.txt");
    expect(exotic).toContain("filename=r_sum_.txt");
    expect(exotic).toContain(`filename*=UTF-8''r%C3%A9sum%C3%A9.txt`);
  });
});
