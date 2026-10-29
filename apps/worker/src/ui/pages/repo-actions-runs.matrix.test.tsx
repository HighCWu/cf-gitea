/**
 * The repo Actions RUNS LIST's tests (the census C1 arm — the C8 twin's
 * harness over a seeded M1a store): the pure-helper matrix (the
 * AggregateJobStatus precedence table, calculateDuration, the Go duration
 * shape, the query/ref/workflow parsers), the loader matrix over real D1
 * with a FAKE engine (the rollup seam, the five filters, pagination, the
 * partial-refresh contract, the refresh meta, IsRefDeleted, the
 * no-matching-online-runner RunErrors arm), the DOM contract of the full
 * page and the `?run_ids=` fragment, and the minted-session route-level
 * matrix (the READ group's optSignIn posture — anonymous 200s on the
 * enabled public repo where the settings pages 303'd; the disabled-unit
 * 404 polarity; the POST 405; the claim pin).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { insertActionRun } from "../../services/actions/model";
import { actionRunJobs, actionRunners, actionRuns, repositories } from "../../db/schema";
import { locale } from "../locale";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { EngineClient } from "../engine";
import type { Viewer } from "../viewer";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_CANCELLING,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
} from "../../services/actions/model";
import {
  actionStatusIcon,
  aggregateJobStatus,
  calculateDurationSeconds,
  formatDuration,
  loadRepoActionsRunsData,
  parseActionRunQuery,
  prettyRefOf,
  refLinkOf,
  refShortName,
  refTooltipOf,
  renderRepoActionsRunsFragment,
  renderRepoActionsRunsPage,
  repoActionsRunsLocale,
  runRefKind,
  STATUS_INFO_LIST,
  statusName,
  workflowInfoFromContent,
  ACTIONS_RUNS_PAGE_SIZE_DEFAULT,
  ACTIONS_RUNS_PAGE_SIZE_MAX,
  type ActionRunListQuery,
  type RepoActionsRunsData,
} from "./repo-actions-runs";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const NOW_SECONDS = 1_800_000_000; // the loader's fixed route clock
const ORIGIN = "https://test.local";

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
    "action_run_jobs",
    "action_run_attempts",
    "action_runs",
    "action_tasks",
    "action_runners",
    "action_runner_tokens",
    "action_tasks_versions",
    "repo_settings",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedRepo("demo");
});

async function seedRepo(slug: string): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, ?, 'main', 'public', 0, unixepoch())",
  )
    .bind(slug)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The Actions unit ON — the MustEnableActions arm's happy path. */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

const PAYLOAD = new Uint8Array([1]); // the staged insert's blob is unread here

interface SeedRunSpec {
  index: number;
  workflowId?: string;
  title?: string;
  ref?: string;
  commitSha?: string;
  triggerUserId?: number;
  eventPayload?: string;
  jobs?: Array<{ jobId: string; runsOn?: string[]; status?: number; started?: Date | null; stopped?: Date | null }>;
}

/** Seed one run through the LANDED staged insert (the M1a seam), then apply
 *  the spec's job-status/timing overrides the way the dispatch path would
 *  (the jobs advance; the run's own status column deliberately STAYS
 *  waiting — the rollup seam's whole point). Returns the run row id. */
async function seedRun(spec: SeedRunSpec): Promise<number> {
  const { run, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: repo.id,
      ownerId: 1,
      workflowId: spec.workflowId ?? "ci.yml",
      index: spec.index,
      triggerUserId: spec.triggerUserId ?? 1,
      ref: spec.ref ?? "refs/heads/main",
      commitSha: spec.commitSha ?? "1234567890abcdef1234567890abcdef12345678",
      event: "push",
      eventPayload: spec.eventPayload ?? "{}",
      triggerEvent: "push",
      title: spec.title ?? "the run title",
    },
    (spec.jobs ?? []).map((job) => ({
      jobId: job.jobId,
      name: job.jobId,
      runsOn: job.runsOn ?? [],
      workflowPayload: PAYLOAD,
    })),
  );
  for (const [position, job] of (spec.jobs ?? []).entries()) {
    if (job.status === undefined && job.started === undefined && job.stopped === undefined) continue;
    const row = jobRows[position];
    if (row === undefined) continue;
    await drizzle(env.DB)
      .update(actionRunJobs)
      .set({
        status: job.status ?? ACTION_STATUS_WAITING,
        started: job.started ?? null,
        stopped: job.stopped ?? null,
      })
      .where(eq(actionRunJobs.id, row.id));
    // The run row's started/stopped are the LATEST-ATTEMPT TIMING MIRRORS
    // (db/schema.ts) — upstream's emitter keeps them in sync with the
    // attempt; the M1a seed mirrors the first job's stamps the same way.
    if (job.started !== undefined || job.stopped !== undefined) {
      await drizzle(env.DB)
        .update(actionRuns)
        .set({
          ...(job.started !== undefined ? { started: job.started } : {}),
          ...(job.stopped !== undefined ? { stopped: job.stopped } : {}),
        })
        .where(eq(actionRuns.id, run.id));
    }
  }
  return run.id;
}

/** A runner row through the model (the Register seam). */
async function seedRunner(labels: string[], onlineAgoSeconds: number): Promise<void> {
  await drizzle(env.DB).insert(actionRunners).values({
    uuid: `uuid-${labels.join("-")}-${onlineAgoSeconds}`,
    name: "runner-1",
    version: "1.0.0",
    ownerId: 0,
    repoId: "",
    agentLabels: JSON.stringify(labels),
    ephemeral: false,
    hasCancellingSupport: false,
    tokenHash: `hash-${labels.join("-")}-${onlineAgoSeconds}`,
    tokenSalt: "salt",
    lastOnline: new Date((NOW_SECONDS - onlineAgoSeconds) * 1000),
    lastActive: new Date((NOW_SECONDS - onlineAgoSeconds) * 1000),
    created: T0,
    updated: T0,
  });
}

/** The fake engine — the loader's only git seam. Workflows + branch refs
 *  are per-test state. */
function fakeEngine(options: { branches?: string[]; workflowFiles?: Record<string, string> } = {}): EngineClient {
  const files = options.workflowFiles ?? {};
  const firstFile = Object.keys(files)[0];
  const dirName = firstFile === undefined ? null : firstFile.split("/").slice(0, 2).join("/");
  const branches = options.branches ?? ["main"];
  return {
    listRefs: () =>
      Promise.resolve({
        head: branches[0] ?? null,
        refs: branches.map((name) => ({ name: `refs/heads/${name}`, target: "0".repeat(40) })),
      }),
    readCommit: () => Promise.resolve(null),
    listLog: () => Promise.resolve(null),
    listTree: (_ref, path) => {
      if (dirName === null || path !== dirName) return Promise.resolve(null);
      return Promise.resolve({
        oid: "0".repeat(40),
        entries: Object.keys(files)
          .filter((p) => p.startsWith(`${path}/`))
          .map((p) => ({ name: p.slice(path.length + 1), mode: "100644", type: "blob" as const, oid: "1".repeat(40) })),
      });
    },
    readBlob: (_ref, path) => {
      const content = files[path];
      if (content === undefined) return Promise.resolve(null);
      return Promise.resolve({ oid: "1".repeat(40), mode: "100644", data: new TextEncoder().encode(content) });
    },
    listTreeCommits: () => Promise.resolve({ commits: [] }),
    blame: () => Promise.resolve(null),
    grep: () => Promise.resolve(null),
    activityStats: () => Promise.resolve(null),
    contributorStats: () => Promise.resolve(null),
    graphData: () => Promise.resolve(null),
    scanLfsPointers: () => Promise.resolve(null),
  };
}

const emptyEngine = fakeEngine();

function baseQuery(patch: Partial<ActionRunListQuery> = {}): ActionRunListQuery {
  return {
    workflow: "",
    scopedWorkflowSourceRepoId: 0,
    actor: 0,
    status: 0,
    branch: "",
    page: 1,
    limit: ACTIONS_RUNS_PAGE_SIZE_DEFAULT,
    refreshRunIds: [],
    partialRefresh: false,
    ...patch,
  };
}

async function loadData(
  patch: Partial<ActionRunListQuery> = {},
  engine: EngineClient = emptyEngine,
  requestUri = "/alice/demo/actions",
): Promise<RepoActionsRunsData> {
  return loadRepoActionsRunsData({
    d1: env.DB,
    engine,
    repo,
    query: baseQuery(patch),
    requestUri,
    canWriteActions: true,
    nowSeconds: NOW_SECONDS,
  });
}

// --- the pure helpers --------------------------------------------------------

describe("aggregateJobStatus (run_job.go:642-688's precedence table)", () => {
  const job = (status: number, continueOnError = false): { status: number; continueOnError: boolean } => ({ status, continueOnError });

  it("answers unknown on no jobs and keeps the terminal arms exact", () => {
    expect(aggregateJobStatus([])).toBe(0);
    expect(aggregateJobStatus([job(ACTION_STATUS_SUCCESS)])).toBe(ACTION_STATUS_SUCCESS);
    expect(aggregateJobStatus([job(ACTION_STATUS_SKIPPED)])).toBe(ACTION_STATUS_SKIPPED);
    expect(aggregateJobStatus([job(ACTION_STATUS_FAILURE)])).toBe(ACTION_STATUS_FAILURE);
    expect(aggregateJobStatus([job(ACTION_STATUS_CANCELLED)])).toBe(ACTION_STATUS_CANCELLED);
  });

  it("all-skipped outranks all-success-or-skipped; a continued failure counts as success", () => {
    expect(aggregateJobStatus([job(ACTION_STATUS_SKIPPED), job(ACTION_STATUS_SKIPPED)])).toBe(ACTION_STATUS_SKIPPED);
    expect(aggregateJobStatus([job(ACTION_STATUS_SUCCESS), job(ACTION_STATUS_SKIPPED)])).toBe(ACTION_STATUS_SUCCESS);
    expect(aggregateJobStatus([job(ACTION_STATUS_FAILURE, true), job(ACTION_STATUS_SUCCESS)])).toBe(ACTION_STATUS_SUCCESS);
    // A NON-continued failure still fails the run beside successes.
    expect(aggregateJobStatus([job(ACTION_STATUS_FAILURE), job(ACTION_STATUS_SUCCESS)])).toBe(ACTION_STATUS_FAILURE);
  });

  it("the live statuses outrank the terminal ones in upstream's order", () => {
    expect(aggregateJobStatus([job(ACTION_STATUS_CANCELLING), job(ACTION_STATUS_RUNNING)])).toBe(ACTION_STATUS_CANCELLING);
    expect(aggregateJobStatus([job(ACTION_STATUS_RUNNING), job(ACTION_STATUS_WAITING)])).toBe(ACTION_STATUS_RUNNING);
    expect(aggregateJobStatus([job(ACTION_STATUS_WAITING), job(ACTION_STATUS_BLOCKED)])).toBe(ACTION_STATUS_WAITING);
    expect(aggregateJobStatus([job(ACTION_STATUS_BLOCKED), job(ACTION_STATUS_CANCELLED)])).toBe(ACTION_STATUS_BLOCKED);
    expect(aggregateJobStatus([job(ACTION_STATUS_PENDING)])).toBe(ACTION_STATUS_RUNNING); // pending = still in progress
    expect(aggregateJobStatus([job(ACTION_STATUS_CANCELLED), job(ACTION_STATUS_FAILURE)])).toBe(ACTION_STATUS_CANCELLED);
  });
});

describe("calculateDurationSeconds (utils.go:73-90) + formatDuration (Go's shape)", () => {
  it("a not-started run carries only the legacy previous-duration", () => {
    expect(calculateDurationSeconds(null, null, ACTION_STATUS_WAITING, 100, NOW_SECONDS, 30)).toBe(30);
    expect(calculateDurationSeconds(0, null, ACTION_STATUS_SUCCESS, 100, NOW_SECONDS)).toBe(0);
  });

  it("a done run measures started→stopped with the updated fallback on a regressive stop", () => {
    expect(calculateDurationSeconds(100, 190, ACTION_STATUS_SUCCESS, 200, NOW_SECONDS)).toBe(90);
    expect(calculateDurationSeconds(100, null, ACTION_STATUS_SUCCESS, 190, NOW_SECONDS)).toBe(90);
    expect(calculateDurationSeconds(100, 50, ACTION_STATUS_SUCCESS, 190, NOW_SECONDS)).toBe(90); // fallback
    expect(calculateDurationSeconds(100, 50, ACTION_STATUS_SUCCESS, 40, NOW_SECONDS)).toBe(0); // fallback predates too
  });

  it("a live run measures started→now, clamped", () => {
    expect(calculateDurationSeconds(NOW_SECONDS - 45, null, ACTION_STATUS_RUNNING, null, NOW_SECONDS)).toBe(45);
    expect(calculateDurationSeconds(NOW_SECONDS + 30, null, ACTION_STATUS_WAITING, null, NOW_SECONDS)).toBe(0);
  });

  it("formatDuration renders Go time.Duration.String()'s whole-second shape", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(60)).toBe("1m0s");
    expect(formatDuration(90)).toBe("1m30s");
    expect(formatDuration(3600)).toBe("1h0m0s");
    expect(formatDuration(3661)).toBe("1h1m1s");
  });
});

describe("parseActionRunQuery (prepareWorkflowList's Form semantics)", () => {
  it("parses the five filters with junk→0 and the page floor", () => {
    expect(parseActionRunQuery(new URLSearchParams("workflow=ci.yml&actor=7&status=2&branch=main&page=3&limit=10"))).toEqual({
      workflow: "ci.yml",
      scopedWorkflowSourceRepoId: 0,
      actor: 7,
      status: 2,
      branch: "main",
      page: 3,
      limit: 10,
      refreshRunIds: [],
      partialRefresh: false,
    });
    const junk = parseActionRunQuery(new URLSearchParams("actor=junk&page=-4&limit=9999&scoped_workflow_source_repo_id=abc"));
    expect(junk.actor).toBe(0); // FormInt64 junk → 0 → no filter
    expect(junk.status).toBe(0);
    expect(junk.page).toBe(1); // floors at 1
    expect(junk.limit).toBe(ACTIONS_RUNS_PAGE_SIZE_MAX); // caps at 50
    expect(junk.scopedWorkflowSourceRepoId).toBe(0);
    expect(parseActionRunQuery(new URLSearchParams()).limit).toBe(ACTIONS_RUNS_PAGE_SIZE_DEFAULT); // 30
  });

  it("run_ids presence (even empty) is the fragment discriminator; tokens are numeric-only", () => {
    expect(parseActionRunQuery(new URLSearchParams("run_ids=1,2,x,3")).partialRefresh).toBe(true);
    expect(parseActionRunQuery(new URLSearchParams("run_ids=1,2,x,3")).refreshRunIds).toEqual([1, 2, 3]);
    expect(parseActionRunQuery(new URLSearchParams("run_ids=")).partialRefresh).toBe(true); // Form.Has
    expect(parseActionRunQuery(new URLSearchParams("run_ids=")).refreshRunIds).toEqual([]);
    expect(parseActionRunQuery(new URLSearchParams()).partialRefresh).toBe(false);
  });
});

describe("the ref helpers (run.go:120-147)", () => {
  it("kinds + short names", () => {
    expect(runRefKind("refs/heads/main")).toBe("branch");
    expect(runRefKind("refs/tags/v1.0")).toBe("tag");
    expect(runRefKind("refs/pull/5/head")).toBe("pull");
    expect(runRefKind("1234567890abcdef1234567890abcdef12345678")).toBe("commit");
    expect(runRefKind("weird")).toBe("other");
    expect(refShortName("refs/heads/feature/x")).toBe("feature/x");
    expect(refShortName("refs/tags/v1.0")).toBe("v1.0");
    expect(refShortName("refs/pull/5/head")).toBe("5");
  });

  it("links + pretty refs + the payload tooltip", () => {
    expect(refLinkOf("/alice/demo", "refs/heads/main")).toBe("/alice/demo/src/branch/main");
    expect(refLinkOf("/alice/demo", "refs/tags/v1.0")).toBe("/alice/demo/src/tag/v1.0");
    expect(refLinkOf("/alice/demo", "refs/pull/5/head")).toBe("/alice/demo/pulls/5");
    expect(refLinkOf("/alice/demo", "1234567890abcdef1234567890abcdef12345678")).toBe("/alice/demo/src/commit/1234567890abcdef1234567890abcdef12345678");
    expect(prettyRefOf("refs/pull/5/head")).toBe("#5");
    expect(prettyRefOf("refs/heads/main")).toBe("main");
    expect(refTooltipOf("refs/pull/5/head", JSON.stringify({ pull_request: { title: "The PR title" } }))).toBe("The PR title");
    expect(refTooltipOf("refs/heads/main", "{}")).toBe("main");
    expect(refTooltipOf("refs/heads/main", "not-json")).toBe("main");
  });
});

describe("workflowInfoFromContent (actions.go:206-234's shape, the light arm)", () => {
  it("the name key wins, else the file name; a valid file carries no error", () => {
    expect(workflowInfoFromContent("ci.yml", "name: Build\nci: true\njobs:\n  build:\n    steps: []\n")).toEqual({
      entryName: "ci.yml",
      displayName: "Build",
      errMsg: null,
    });
    expect(workflowInfoFromContent("ci.yml", "on: push\njobs:\n  build:\n    steps: []\n")).toEqual({
      entryName: "ci.yml",
      displayName: "ci.yml",
      errMsg: null,
    });
  });

  it("unparseable YAML, a non-mapping root and a jobs-less root carry the invalid helper text", () => {
    expect(workflowInfoFromContent("bad.yml", "\t: [broken").errMsg).toContain("Workflow config file is invalid");
    expect(workflowInfoFromContent("bad.yml", "- just\n- a\n- list\n").errMsg).toContain("not a mapping");
    expect(workflowInfoFromContent("bad.yml", "name: No jobs here\n").errMsg).toContain("jobs is not a mapping");
  });
});

describe("statusName + STATUS_INFO_LIST (status.go / GetStatusInfoList)", () => {
  it("names and the 8-entry filter list (unknown excluded)", () => {
    expect(statusName(ACTION_STATUS_SUCCESS)).toBe("success");
    expect(statusName(999)).toBe("unknown");
    expect(STATUS_INFO_LIST.map((info) => info.statusName)).toEqual([
      "success",
      "failure",
      "cancelled",
      "skipped",
      "waiting",
      "running",
      "blocked",
      "cancelling",
    ]);
    expect(actionStatusIcon("success", "circle-fill").name).toBe("octicon-check-circle-fill");
    expect(actionStatusIcon("failure", "plain").name).toBe("octicon-x");
    expect(actionStatusIcon("running", "plain").name).toBe("octicon-sync"); // the gitea-running stand-in
  });
});

// --- the loader over seeded D1 -------------------------------------------------

describe("loadRepoActionsRunsData (the rollup + filters over the M1a store)", () => {
  it("orders by index DESC regardless of the insert order", async () => {
    await seedRun({ index: 2 });
    await seedRun({ index: 1 });
    await seedRun({ index: 3 });
    const data = await loadData();
    expect(data.runs.map((run) => run.index)).toEqual([3, 2, 1]);
    expect(data.total).toBe(3);
  });

  it("rolls the run status UP from the latest-attempt jobs (the M1a seam) — the column stays stale", async () => {
    const successId = await seedRun({
      index: 1,
      jobs: [
        { jobId: "a", status: ACTION_STATUS_SUCCESS, started: new Date((NOW_SECONDS - 100) * 1000), stopped: new Date((NOW_SECONDS - 50) * 1000) },
        { jobId: "b", status: ACTION_STATUS_SKIPPED },
      ],
    });
    const failedId = await seedRun({
      index: 2,
      jobs: [{ jobId: "a", status: ACTION_STATUS_FAILURE, started: new Date((NOW_SECONDS - 10) * 1000) }],
    });
    const data = await loadData();
    const byId = new Map(data.runs.map((run) => [run.id, run]));
    expect(byId.get(successId)?.status).toBe(ACTION_STATUS_SUCCESS);
    expect(byId.get(failedId)?.status).toBe(ACTION_STATUS_FAILURE);
    // The jobless run keeps its column value.
    const joblessId = await seedRun({ index: 3 });
    const data2 = await loadData();
    expect(data2.runs.find((run) => run.id === joblessId)?.status).toBe(ACTION_STATUS_WAITING);
  });

  it("filters by the ROLLED-UP status (the module header's deviation)", async () => {
    await seedRun({
      index: 1,
      jobs: [{ jobId: "a", status: ACTION_STATUS_SUCCESS }],
    });
    await seedRun({ index: 2 }); // column waiting, no jobs → still waiting
    const successes = await loadData({ status: ACTION_STATUS_SUCCESS });
    expect(successes.total).toBe(1);
    expect(successes.runs[0]?.index).toBe(1);
    expect(successes.isFiltered).toBe(true);
    const waiting = await loadData({ status: ACTION_STATUS_WAITING });
    expect(waiting.total).toBe(1);
    expect(waiting.runs[0]?.index).toBe(2);
  });

  it("filters by workflow, actor, and branch; IsFiltered tracks exactly the three params", async () => {
    await seedRun({ index: 1, workflowId: "ci.yml", triggerUserId: 1 });
    await seedRun({ index: 2, workflowId: "deploy.yml", triggerUserId: 2, ref: "refs/heads/feature" });
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, created_at) VALUES (2, 'bob', 'bob', unixepoch())",
    ).run();

    expect((await loadData({ workflow: "ci.yml" })).runs.map((run) => run.index)).toEqual([1]);
    expect((await loadData({ actor: 2 })).runs.map((run) => run.index)).toEqual([2]);
    expect((await loadData({ actor: 2 })).isFiltered).toBe(true);
    expect((await loadData({ branch: "feature" })).runs.map((run) => run.index)).toEqual([2]);
    expect((await loadData({ branch: "ghost" })).runs).toEqual([]);
    expect((await loadData({ workflow: "ci.yml", actor: 2 })).runs).toEqual([]); // conjunctive
    const unfiltered = await loadData();
    expect(unfiltered.isFiltered).toBe(false);
  });

  it("paginates index-DESC over the filtered set with the Older/Newer more-flag", async () => {
    for (const index of [1, 2, 3, 4]) {
      await seedRun({ index });
    }
    const page1 = await loadData({ limit: 2, page: 1 });
    expect(page1.runs.map((run) => run.index)).toEqual([4, 3]);
    expect(page1.more).toBe(true);
    expect(page1.total).toBe(4);
    const page2 = await loadData({ limit: 2, page: 2 });
    expect(page2.runs.map((run) => run.index)).toEqual([2, 1]);
    expect(page2.more).toBe(false);
    const beyond = await loadData({ limit: 2, page: 3 });
    expect(beyond.runs).toEqual([]);
    expect(beyond.more).toBe(false);
  });

  it("the partial-refresh arm answers the requested ids in REQUEST order, repo-scoped, misses dropped", async () => {
    const id1 = await seedRun({ index: 1 });
    const id2 = await seedRun({ index: 2 });
    await seedRun({ index: 3 });
    // A rival repo's run id — the isolation arm.
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-2', 'repo-2', 'alice', 1, 'rival', 'main', 'public', 0, unixepoch())",
    ).run();
    const rival = await insertActionRun(env.DB, {
      repoId: "repo-2",
      ownerId: 1,
      workflowId: "ci.yml",
      index: 1,
      triggerUserId: 1,
      ref: "refs/heads/main",
      commitSha: "a".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    }, []);
    const data = await loadRepoActionsRunsData({
      d1: env.DB,
      engine: emptyEngine,
      repo,
      query: baseQuery({ partialRefresh: true, refreshRunIds: [id2, rival.run.id, id1, 999] }),
      requestUri: "/alice/demo/actions?workflow=ci.yml",
      canWriteActions: true,
      nowSeconds: NOW_SECONDS,
    });
    expect(data.runs.map((run) => run.id)).toEqual([id2, id1]); // request order, rival + stale dropped
    expect(data.total).toBe(2);
    expect(data.more).toBe(false); // the fragment never pages
    expect(data.refreshLink).toBe("/alice/demo/actions?workflow=ci.yml&run_ids=" + encodeURIComponent(`${id2},${id1}`));
  });

  it("an EMPTY run_ids param is still the fragment arm (Form.Has) and answers the empty list", async () => {
    await seedRun({ index: 1 });
    const data = await loadData({ partialRefresh: true, refreshRunIds: [] });
    expect(data.runs).toEqual([]);
    expect(data.pageBlock).toBeNull();
    expect(data.refreshIntervalMs).toBe(0);
  });

  it("the refresh meta: 3s with an active rolled-up run, 12s idle, 0 with no rows; the link carries the page's ids", async () => {
    const activeId = await seedRun({ index: 1 }); // waiting
    const doneId = await seedRun({
      index: 2,
      jobs: [{ jobId: "a", status: ACTION_STATUS_SUCCESS }],
    });
    const active = await loadData();
    expect(active.refreshIntervalMs).toBe(3000);
    // The page rows ride index DESC — index 2's rowid leads.
    expect(active.refreshLink).toBe(`/alice/demo/actions?run_ids=${encodeURIComponent(`${doneId},${activeId}`)}`);
    // The empty arm: the jobless run falls back to its COLUMN status (no
    // attempt jobs) — complete both.
    await drizzle(env.DB).update(actionRunJobs).set({ status: ACTION_STATUS_SUCCESS });
    await drizzle(env.DB).update(actionRuns).set({ status: ACTION_STATUS_SUCCESS });
    const idle = await loadData();
    expect(idle.refreshIntervalMs).toBe(12000);
    // The empty arm.
    await drizzle(env.DB).delete(actionRuns);
    const none = await loadData();
    expect(none.refreshIntervalMs).toBe(0);
    expect(none.refreshLink).toBe("/alice/demo/actions?run_ids=");
  });

  it("flags a deleted branch ref (loadIsRefDeleted) and leaves tags/shas alone", async () => {
    await seedRun({ index: 1, ref: "refs/heads/main" });
    await seedRun({ index: 2, ref: "refs/heads/feature" });
    await seedRun({ index: 3, ref: "refs/tags/v1" });
    const engine = fakeEngine({ branches: ["main"] });
    const data = await loadData({}, engine);
    const byIndex = new Map(data.runs.map((run) => [run.index, run]));
    expect(byIndex.get(1)?.isRefDeleted).toBe(false);
    expect(byIndex.get(2)?.isRefDeleted).toBe(true);
    expect(byIndex.get(3)?.isRefDeleted).toBe(false);
    expect(byIndex.get(2)?.prettyRef).toBe("feature");
  });

  it("the RunErrors arm: a waiting job with no matching ONLINE runner carries the upstream text", async () => {
    const noRunnerId = await seedRun({ index: 1, jobs: [{ jobId: "build", runsOn: ["ubuntu-latest"] }] });
    const offlineRunnerId = await seedRun({ index: 2, jobs: [{ jobId: "build", runsOn: ["ubuntu-latest"] }] });
    const byIdOf = (data: RepoActionsRunsData): Map<number, (typeof data.runs)[number]> =>
      new Map(data.runs.map((run) => [run.id, run]));
    await seedRunner(["ubuntu-latest"], 120); // stale — outside RunnerOfflineTime
    let data = await loadData();
    let byId = byIdOf(data);
    expect(byId.get(noRunnerId)?.errorMessage).toBe("No matching online runner with label: ubuntu-latest");
    expect(byId.get(offlineRunnerId)?.errorMessage).toBe("No matching online runner with label: ubuntu-latest");

    // A fresh, matching runner clears both.
    await seedRunner(["ubuntu-latest"], 10);
    data = await loadData();
    byId = byIdOf(data);
    expect(byId.get(noRunnerId)?.errorMessage).toBeNull();
    expect(byId.get(offlineRunnerId)?.errorMessage).toBeNull();

    // A label mismatch still errors on an OTHERWISE-online fleet; a DONE
    // run never errors.
    const macId = await seedRun({ index: 3, jobs: [{ jobId: "build", runsOn: ["macos-14"] }] }); // waiting
    const doneId = await seedRun({ index: 4, jobs: [{ jobId: "build", runsOn: ["macos-14"], status: ACTION_STATUS_SUCCESS }] });
    await seedRunner(["windows-latest"], 5); // online, but mismatches macos-14
    data = await loadData();
    byId = byIdOf(data);
    expect(byId.get(macId)?.errorMessage).toBe("No matching online runner with label: macos-14");
    expect(byId.get(noRunnerId)?.errorMessage).toBeNull(); // the fresh ubuntu runner from block 2 matches
    expect(byId.get(doneId)?.errorMessage).toBeNull();
  });

  it("durations roll from the rolled-up status: a running job measures to the route clock", async () => {
    await seedRun({
      index: 1,
      jobs: [{ jobId: "a", status: ACTION_STATUS_RUNNING, started: new Date((NOW_SECONDS - 90) * 1000) }],
    });
    const data = await loadData();
    expect(data.runs[0]?.status).toBe(ACTION_STATUS_RUNNING);
    expect(data.runs[0]?.durationText).toBe("1m30s");
  });

  it("joins the trigger user (display-name fallback) and degrades a missing user to the Ghost arm", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, created_at) VALUES (2, 'bob', 'bob', unixepoch())",
    ).run(); // display_name NULL → the username fallback
    await seedRun({ index: 1, triggerUserId: 2 });
    await seedRun({ index: 2, triggerUserId: 42 }); // no such user
    const data = await loadData();
    const byIndex = new Map(data.runs.map((run) => [run.index, run]));
    expect(byIndex.get(1)?.triggerUser).toEqual({ username: "bob", displayName: "bob", homeLink: "/bob" });
    expect(byIndex.get(2)?.triggerUser).toBeNull();
  });

  it("the full-page block: workflows from the engine, other-workflow orphans, actors self-on-top, branches sorted", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Builder', unixepoch())",
    ).run();
    await seedRun({ index: 1, workflowId: "ci.yml", triggerUserId: 2 });
    await seedRun({ index: 2, workflowId: "legacy.yml" });
    const engine = fakeEngine({
      branches: ["main", "develop"],
      workflowFiles: {
        ".gitea/workflows/ci.yml": "name: Build\nci: true\njobs:\n  build:\n    steps: []\n",
      },
    });
    const data = await loadData({}, engine);
    const block = data.pageBlock;
    if (block === null) throw new Error("full page expected");
    expect(block.workflows).toEqual([{ entryName: "ci.yml", displayName: "Build", errMsg: null }]);
    expect(block.otherWorkflows).toEqual(["legacy.yml"]);
    expect(block.actors.map((actor) => actor.displayName)).toEqual(["Alice Doe", "Bob Builder"]); // viewer NOT trigger → display-name order
    expect(block.runBranches).toEqual(["develop", "main"]);
    expect(block.hasWorkflowsOrRuns).toBe(true);
    // The workflow names map feeds the rows' body line.
    expect(data.workflowNames).toEqual({ "ci.yml": "Build" });

    // MakeSelfOnTop: alice's own trigger run puts her first.
    await seedRun({ index: 3, workflowId: "legacy.yml", triggerUserId: 1 });
    const data2 = await loadData({}, engine);
    expect(data2.pageBlock?.actors.map((actor) => actor.displayName)).toEqual(["Alice Doe", "Bob Builder"]);

    // A parse-broken workflow file surfaces the error arm and is NOT a name.
    const broken = fakeEngine({
      workflowFiles: { ".gitea/workflows/ci.yml": "\t: [broken" },
    });
    const data3 = await loadData({}, broken);
    expect(data3.pageBlock?.workflows[0]?.errMsg).toContain("Workflow config file is invalid");
    expect(data3.pageBlock?.workflows[0]?.displayName).toBe("ci.yml");
  });

  it("HasWorkflowsOrRuns is false only when nothing exists — the empty arm's discriminator", async () => {
    const nothing = await loadData();
    expect(nothing.pageBlock?.hasWorkflowsOrRuns).toBe(false);
    const engine = fakeEngine({ workflowFiles: { ".github/workflows/other.yml": "on: push\njobs:\n  a:\n    steps: []\n" } });
    const withWorkflow = await loadData({}, engine);
    expect(withWorkflow.pageBlock?.hasWorkflowsOrRuns).toBe(true);
    const withRuns = await loadData(); // the seeded run from beforeEach is gone; seed one
    expect(withRuns.pageBlock?.hasWorkflowsOrRuns).toBe(false);
    await seedRun({ index: 1 });
    const nowRuns = await loadData();
    expect(nowRuns.pageBlock?.hasWorkflowsOrRuns).toBe(true);
  });

  it("reads the SECOND workflow dir when the first is absent (WorkflowDirs' miss-continue)", async () => {
    const engine = fakeEngine({ workflowFiles: { ".github/workflows/other.yml": "on: push\njobs:\n  a:\n    steps: []\n" } });
    const data = await loadData({}, engine);
    expect(data.pageBlock?.workflows.map((wf) => wf.entryName)).toEqual(["other.yml"]);
  });

  it("runs of other repos never appear (the repo-scope read arm)", async () => {
    await seedRun({ index: 1 });
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-2', 'repo-2', 'alice', 1, 'rival', 'main', 'public', 0, unixepoch())",
    ).run();
    await insertActionRun(env.DB, {
      repoId: "repo-2",
      ownerId: 1,
      workflowId: "ci.yml",
      index: 1,
      triggerUserId: 1,
      ref: "refs/heads/main",
      commitSha: "a".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    }, []);
    const data = await loadData();
    expect(data.total).toBe(1);
    expect(data.runs.every((run) => run.link.startsWith("/alice/demo/"))).toBe(true);
  });
});

// --- the DOM -----------------------------------------------------------------

describe("the runs list DOM (list.tmpl + runs_list.tmpl)", () => {
  async function seededHtml(engine: EngineClient = emptyEngine, patch: Partial<ActionRunListQuery> = {}): Promise<string> {
    const data = await loadData(patch, engine);
    // repoHasActions rides the resolved ctx in production (resolveUiRequest's
    // threading); the component-level render passes it explicitly.
    return renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, data);
  }

  it("renders the page discriminator, the ACTIVE Actions tab, and the row contract", async () => {
    await seedRun({
      index: 3,
      title: "Fix the thing",
      jobs: [{ jobId: "a", status: ACTION_STATUS_SUCCESS }],
    });
    const html = await seededHtml();
    expect(html).toContain("repository actions"); // layout_head's pageClass (list.tmpl:6)
    // The navbar's Actions tab, active (header.tmpl:130-139's shape).
    expect(html).toContain('class="active item" href="/alice/demo/actions" data-shortcut-keys="g a"');
    expect(html).toContain("octicon-play");
    // The runs_list container + the morph contract.
    expect(html).toContain('data-global-init="initActionRunsList"');
    expect(html).toContain('data-action-runs-refresh-interval="12000"');
    expect(html).toMatch(/data-action-runs-refresh-link="\/alice\/demo\/actions\?run_ids=\d+"/);
    expect(html).toMatch(/id="action-run-item-\d+"/);
    expect(html).toContain('data-status="success"');
    expect(html).toContain("data-morph-whole");
    expect(html).toContain("octicon-check-circle-fill");
    // The title link + the body line (workflow name — no cur workflow —
    // the run number, the short-sha commit link, the pushed-by join).
    expect(html).toContain('href="/alice/demo/actions/runs/');
    expect(html).toContain("Fix the thing");
    expect(html).toContain("<b>ci.yml #3</b>:</span>");
    expect(html).toContain('href="/alice/demo/commit/1234567890abcdef1234567890abcdef12345678">1234567890</a>');
    expect(html).toContain(`${repoActionsRunsLocale.pushed_by} <a href="/alice">Alice Doe</a>`);
    // The ref chip + the meta row.
    expect(html).toContain('href="/alice/demo/src/branch/main"');
    expect(html).toContain("main");
    expect(html).toContain("octicon-stopwatch");
    expect(html).toContain("<relative-time");
  });

  it("a selected workflow drops the per-row workflow-name prefix (list.tmpl's CurWorkflow arm)", async () => {
    await seedRun({ index: 1 });
    const html = await seededHtml(emptyEngine, { workflow: "ci.yml" });
    expect(html).toContain("<b>#1</b>:");
    expect(html).not.toContain("<b>ci.yml #1</b>:");
  });

  it("an empty title renders the empty_commit_message fallback", async () => {
    await seedRun({ index: 1, title: "" });
    const html = await seededHtml();
    expect(html).toContain(`>${repoActionsRunsLocale.empty_commit_message}</a>`);
  });

  it("the deleted-ref chip is a line-through span without a link", async () => {
    await seedRun({ index: 1, ref: "refs/heads/feature" });
    const engine = fakeEngine({ branches: ["main"] });
    const html = await seededHtml(engine);
    expect(html).toContain("run-list-ref gt-ellipsis tw-line-through");
    expect(html).not.toContain('href="/alice/demo/src/branch/feature"');
  });

  it("the RunErrors arm renders the alert icon with the message tooltip", async () => {
    await seedRun({ index: 1, jobs: [{ jobId: "build", runsOn: ["ubuntu-latest"] }] });
    const html = await seededHtml();
    expect(html).toContain('data-tooltip-content="No matching online runner with label: ubuntu-latest"');
    expect(html).toContain("octicon-alert");
  });

  it("the filter menu carries the full five-param query on every item and marks the selected", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Builder', unixepoch())",
    ).run();
    await seedRun({ index: 1, triggerUserId: 2, ref: "refs/heads/feature" });
    await seedRun({ index: 2, ref: "refs/heads/main" });
    const engine = fakeEngine({ branches: ["main", "feature"] });
    const data = await loadData({ status: ACTION_STATUS_SUCCESS, workflow: "ci.yml" }, engine);
    const html = renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, data);
    // The actor items: the reset arm and the joined actor.
    expect(html).toContain('href="/alice/demo/actions?workflow=ci.yml&amp;scoped_workflow_source_repo_id=0&amp;actor=0&amp;status=1&amp;branch="');
    expect(html).toContain('href="/alice/demo/actions?workflow=ci.yml&amp;scoped_workflow_source_repo_id=0&amp;actor=2&amp;status=1&amp;branch="');
    // The status items carry their numeric value; the branch items the name.
    expect(html).toContain('href="/alice/demo/actions?workflow=ci.yml&amp;scoped_workflow_source_repo_id=0&amp;actor=0&amp;status=0&amp;branch="');
    expect(html).toContain('href="/alice/demo/actions?workflow=ci.yml&amp;scoped_workflow_source_repo_id=0&amp;actor=0&amp;status=1&amp;branch=feature"');
    expect(html).toContain('data-test-id="filter-branch"'); // upstream's own test hook (list.tmpl:60)
    expect(html).toContain("All actors"); // actors_no_select
    expect(html).toContain("All status");
    expect(html).toContain("All branches");
  });

  it("the sidebar lists the workflows with display names and the Other-workflows disclosure", async () => {
    await seedRun({ index: 1, workflowId: "legacy.yml" });
    const engine = fakeEngine({
      branches: ["main"],
      workflowFiles: { ".gitea/workflows/ci.yml": "name: Build\njobs:\n  a:\n    steps: []\n" },
    });
    const html = await seededHtml(engine);
    expect(html).toContain("All Workflows"); // sidebar.tmpl:3
    expect(html).toContain('data-tooltip-content="Build"');
    expect(html).toContain("Other workflows"); // sidebar.tmpl:39
    expect(html).toContain("legacy.yml");
    // The Management section (job queue) renders nothing — C6's route is
    // unlanded (the dead-link rule, the module header).
    expect(html).not.toContain("actions/job_queue");
  });

  it("the empty states: no_workflows arm (with the writer's quick start), no_runs and no_results", async () => {
    const empty = await seededHtml();
    expect(htmlToContain(empty, repoActionsRunsLocale.no_workflows)).toBe(true);
    expect(empty).toContain("octicon-no-entry");
    // The chrome's apostrophe renders escaped (the twins' DOM convention).
    expect(empty).toContain("Don&#39;t know how to start with Gitea Actions? See"); // canWriteActions → the quick-start line
    expect(empty).toContain("https://docs.gitea.com/usage/actions/quickstart/");
    expect(empty).toContain(repoActionsRunsLocale.no_workflows_documentation_prefix);
    // Runs exist but nothing matches the filter → no_results inside the list.
    await seedRun({ index: 1 });
    const filtered = await seededHtml(emptyEngine, { status: ACTION_STATUS_FAILURE });
    expect(filtered).toContain(repoActionsRunsLocale.no_results);
    expect(filtered).toContain("0 workflow runs"); // the count header over the FILTERED total
    // A WORKFLOW exists but no runs do → the shell + the runs list's
    // no_runs arm (HasWorkflowsOrRuns rides the workflow).
    const workflowEngine = fakeEngine({ workflowFiles: { ".gitea/workflows/ci.yml": "on: push\njobs:\n  a:\n    steps: []\n" } });
    await drizzle(env.DB).delete(actionRuns);
    const workflowOnly = await loadData({}, workflowEngine);
    const workflowOnlyHtml = renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, workflowOnly);
    expect(workflowOnly.pageBlock?.hasWorkflowsOrRuns).toBe(true);
    expect(workflowOnlyHtml).toContain(repoActionsRunsLocale.no_runs);
    // A run exists unfiltered (workflows absent) → the shell + the count header.
    await seedRun({ index: 1 });
    const idle = await seededHtml();
    expect(idle).toContain("1 workflow run"); // the count header (TrN's singular)
    // And a second run flips the plural.
    await seedRun({ index: 2 });
    const plural = await seededHtml();
    expect(plural).toContain("2 workflow runs");
  });

  it("the pager renders Newer/Older with the carried filter set and disappears on a short first page", async () => {
    for (const index of [1, 2, 3]) {
      await seedRun({ index });
    }
    const page1 = renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, await loadData({ limit: 2, page: 1 }));
    expect(page1).toContain("Older");
    expect(page1).not.toContain("Newer");
    expect(page1).toMatch(/href="\/alice\/demo\/actions\?[^"]*page=2/);
    const page2 = renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, await loadData({ limit: 2, page: 2 }));
    expect(page2).toContain("Newer");
    expect(page2).not.toContain("Older");
    const single = renderRepoActionsRunsPage({ ...ctx, repo, repoHasActions: true }, await loadData());
    expect(single).not.toContain("pagination menu"); // base/paginate's short-circuit
  });

  it("the scheduled arm replaces the commit line (runs_list.tmpl:28-35)", async () => {
    await seedRun({ index: 1 });
    await drizzle(env.DB).update(actionRuns).set({ scheduleId: 9 });
    const html = await seededHtml();
    expect(html).toContain(repoActionsRunsLocale.scheduled);
    expect(html).not.toContain(repoActionsRunsLocale.pushed_by);
  });

  it("the fragment render is the bare runs_list div — no document shell", async () => {
    await seedRun({ index: 1 });
    const data = await loadData({ partialRefresh: true, refreshRunIds: [(await loadData({ partialRefresh: true, refreshRunIds: [1] })).runs[0]?.id ?? 0] });
    const fragment = renderRepoActionsRunsFragment(data, "/alice/demo");
    expect(fragment.startsWith("<div")).toBe(true);
    expect(fragment).not.toContain("<!DOCTYPE");
    expect(fragment).not.toContain("<html");
    expect(fragment).toContain('data-global-init="initActionRunsList"');
    expect(fragment).toContain('class="flex-divided-list items-with-main run-list"');
  });

  it("throws without a resolved repo (the repo pages' ctx.repo contract)", async () => {
    const data = await loadData();
    expect(() => renderRepoActionsRunsPage(ctx, data)).toThrow("RepoActionsRunsPage requires ctx.repo");
    expect(() => renderRepoActionsRunsPage({ ...ctx, repo: undefined }, data)).toThrow("RepoActionsRunsPage requires ctx.repo");
  });
});

function htmlToContain(html: string, needle: string): boolean {
  return html.includes(needle);
}

// --- the mounted route arms (the census C1 mount; the C8 twin's
//     minted-session route-level pattern) ---------------------------------------

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
  expect(html).not.toContain("run-list"); // never the re-rendered list
}

describe("the mounted repo actions route (the census C1: the minted-session route-level matrix)", () => {
  it("answers an ANONYMOUS GET at 200 on the enabled public repo (optSignIn — the READ group's posture)", async () => {
    await enableActions();
    const res = await getRoute("/alice/demo/actions", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository actions");
    expect(html).toContain(repoActionsRunsLocale.no_workflows); // the empty DO has no workflow files
    // The navbar's Actions tab rides the same request (the repoHasActions
    // threading) — rendered, and ACTIVE on its own page.
    expect(html).toContain('class="active item" href="/alice/demo/actions" data-shortcut-keys="g a"');
  });

  it("404-shells while the actions unit is disabled — even the admin (MustEnableActions' repo-unit arm)", async () => {
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false);
    await expectNotFoundShell(await getRoute("/alice/demo/actions", 1));
    await expectNotFoundShell(await getRoute("/alice/demo/actions", null)); // anonymous too
    await enableActions();
    expect((await getRoute("/alice/demo/actions", 1)).status).toBe(200);
  });

  it("404-shells an EMPTY repo (MustBeNotEmpty) even with the unit enabled", async () => {
    await enableActions();
    await drizzle(env.DB).update(repositories).set({ isEmpty: true }).where(eq(repositories.id, repo.id));
    await expectNotFoundShell(await getRoute("/alice/demo/actions", 1));
  });

  it("404-shells an invisible repo for anonymous (the resolution arm — RepoAssignment)", async () => {
    await enableActions();
    await drizzle(env.DB).update(repositories).set({ visibility: "private" }).where(eq(repositories.id, repo.id));
    await expectNotFoundShell(await getRoute("/alice/demo/actions", null));
    // The owner still reads it.
    expect((await getRoute("/alice/demo/actions", 1)).status).toBe(200);
  });

  it("answers a POST with chi's 405 (GET-only upstream)", async () => {
    await enableActions();
    const res = await fetchUi("/alice/demo/actions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await sessionCookie(1) },
      body: new URLSearchParams({ run_ids: "1" }).toString(),
    });
    expect(res.status).toBe(405);
  });

  it("the `?run_ids=` fragment arm answers the BARE fragment through the mount (no document shell)", async () => {
    await enableActions();
    const runId = await seedRun({ index: 1 });
    const res = await getRoute(`/alice/demo/actions?run_ids=${runId}`, 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<div")).toBe(true);
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).toContain(`id="action-run-item-${runId}"`);
    expect(html).toMatch(/data-action-runs-refresh-link="\/alice\/demo\/actions\?run_ids=\d+"/);
  });

  it("the disabled-unit fragment arm 404-shells too (the gate fronts both arms)", async () => {
    const runId = await seedRun({ index: 1 });
    await expectNotFoundShell(await getRoute(`/alice/demo/actions?run_ids=${runId}`, 1));
  });

  it("the sibling actions tails stay unclaimed → the engine's 404 (the family interface's claim note)", async () => {
    await enableActions();
    // NOTE: `/actions/job_queue` is NOT in this list — the C6 sibling's
    // unit claims it in flight (its family already parses in the shared
    // index window), and `/actions/runs/{run}` is claimed the same way by
    // the landed C2 run-viewer family (actions-run-view — that unit's own
    // suite pins its shapes); this pin holds only THIS family's fidelity:
    // the bare literal plus the junk tails upstream's chi answers 404.
    for (const path of [
      "/alice/demo/actions/run",
      "/alice/demo/actions/disable",
      "/alice/demo/actions/enable",
      "/alice/demo/actions/workflow-dispatch-inputs",
      "/alice/demo/actions/extra",
    ]) {
      expect(parseUiRoute(path)).toBeNull();
      expect(handlesUiRoute(path)).toBe(false);
      await expectNotFoundShell(await getRoute(path, 1));
    }
  });
});

// --- the route claim pin (parse ↔ registration — the C8 twin's pin) -----------

describe("the route claim pin (the repo family claims exactly the bare /actions literal)", () => {
  it("parses the family; junk shapes stay unclaimed", () => {
    expect(parseUiRoute("/alice/demo/actions")).toEqual({ family: "repo-actions-runs", owner: "alice", repo: "demo" });
    expect(handlesUiRoute("/alice/demo/actions")).toBe(true);
    // `/alice/actions` is a REPO root (owner alice, repo "actions") — a
    // different family's claim entirely, never this one.
    expect(parseUiRoute("/alice/actions")?.family).not.toBe("repo-actions-runs");
  });
});
