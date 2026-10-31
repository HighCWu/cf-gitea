/**
 * The M3-P trigger suite (SPEC-0012 §6.4's P slice): the glob +
 * workflowpattern differential (upstream's OWN vector table —
 * workflowpattern_test.go TestMatchPattern, ported row-for-row), the `on:`
 * event extraction, the push matchers, the [skip ci] scan on BOTH surfaces,
 * the 1 MiB enumeration cap + first-existing-dir rule, the `${{` insert
 * gate, InsertRun mechanics (run/attempt/job rows, the per-repo index,
 * commit-status creation, the task-version arms), the emitter's needs-graph
 * ordering (implicit-success skip cascade, continue-on-error need, the
 * aggregate refresh, the version wake), the claim-payload `if: always()`
 * rewrite, and the live receive-pack → rows end-to-end arm over the
 * entrypoint's engine composition.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { parseDocument } from "yaml";

import { actionRuns, actionRunJobs, actionRunAttempts, commitStatuses, repoUnits, repositories, users } from "../../db/schema";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_PENDING,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
  ACTION_STATUS_WAITING,
} from "./model";
import { getTasksVersionByScope } from "./model";
import {
  ACTIONS_USER_ID,
  aggregateJobStatus,
  canGithubEventMatch,
  checkJobsOfRun,
  commitStatusEventAndCommit,
  compilePatterns,
  containsExpression,
  createSkippedCommitStatusForFilteredWorkflow,
  createWorkflowCommitStatus,
  detectWorkflowMatch,
  filterPatterns,
  getEventsFromContent,
  insertTriggeredRun,
  isWorkflowPath,
  listWorkflows,
  matchPushEvent,
  parseRawOn,
  runnerWorkflowPayload,
  shouldEventCreateCommitStatus,
  skipPatterns,
  skipWorkflows,
  splitWorkflowPayloads,
  toCommitStatus,
  toCommitStatusDescription,
  workflowStatusContextName,
  type WorkflowEvent,
  type WorkflowTreeReads,
} from "./trigger";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "personal_access_tokens",
  "webhook_deliveries",
  "webhooks",
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_tasks_versions",
  "protected_branches",
  "commit_statuses",
  "repo_units",
  "repo_counters",
  "repo_redirects",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

// ---------------------------------------------------------------------------
// The glob + workflowpattern differential — upstream's OWN vector table
// (modules/actions/workflowpattern/workflow_pattern_test.go TestMatchPattern,
// ported row-for-row: patterns/inputs/skipResult/filterResult).
// ---------------------------------------------------------------------------

const UPSTREAM_PATTERN_CASES: Array<{ patterns: string[]; inputs: string[]; skip: boolean; filter: boolean }> = [
  { patterns: ["*"], inputs: ["path/with/slash"], skip: true, filter: false },
  { patterns: ["path/a", "path/b", "path/c"], inputs: ["meta", "path/b", "otherfile"], skip: false, filter: false },
  { patterns: ["path/a", "path/b", "path/c"], inputs: ["path/b"], skip: false, filter: true },
  { patterns: ["path/a", "path/b", "path/c"], inputs: ["path/c", "path/b"], skip: false, filter: true },
  { patterns: ["path/a", "path/b", "path/c"], inputs: ["path/c", "path/b", "path/a"], skip: false, filter: true },
  { patterns: ["path/a", "path/b", "path/c"], inputs: ["path/c", "path/b", "path/d", "path/a"], skip: false, filter: false },
  { patterns: [], inputs: [], skip: false, filter: false },
  { patterns: ["\\!file"], inputs: ["!file"], skip: false, filter: true },
  { patterns: ["escape\\\\backslash"], inputs: ["escape\\backslash"], skip: false, filter: true },
  { patterns: [".yml"], inputs: ["fyml"], skip: true, filter: false },
  // branches-and-tags doc vectors
  { patterns: ["feature/*"], inputs: ["feature/my-branch"], skip: false, filter: true },
  { patterns: ["feature/*"], inputs: ["feature/your-branch"], skip: false, filter: true },
  { patterns: ["feature/**"], inputs: ["feature/beta-a/my-branch"], skip: false, filter: true },
  { patterns: ["feature/**"], inputs: ["feature/mona/the/octocat"], skip: false, filter: true },
  { patterns: ["main", "releases/mona-the-octocat"], inputs: ["main"], skip: false, filter: true },
  { patterns: ["main", "releases/mona-the-octocat"], inputs: ["releases/mona-the-octocat"], skip: false, filter: true },
  { patterns: ["*"], inputs: ["main"], skip: false, filter: true },
  { patterns: ["*"], inputs: ["releases"], skip: false, filter: true },
  { patterns: ["**"], inputs: ["all/the/branches"], skip: false, filter: true },
  { patterns: ["**"], inputs: ["every/tag"], skip: false, filter: true },
  { patterns: ["*feature"], inputs: ["mona-feature"], skip: false, filter: true },
  { patterns: ["*feature"], inputs: ["feature"], skip: false, filter: true },
  { patterns: ["*feature"], inputs: ["ver-10-feature"], skip: false, filter: true },
  { patterns: ["v2*"], inputs: ["v2"], skip: false, filter: true },
  { patterns: ["v2*"], inputs: ["v2.0"], skip: false, filter: true },
  { patterns: ["v2*"], inputs: ["v2.9"], skip: false, filter: true },
  { patterns: ["v[12].[0-9]+.[0-9]+"], inputs: ["v1.10.1"], skip: false, filter: true },
  { patterns: ["v[12].[0-9]+.[0-9]+"], inputs: ["v2.0.0"], skip: false, filter: true },
  // file-paths doc vectors
  { patterns: ["*"], inputs: ["README.md"], skip: false, filter: true },
  { patterns: ["*"], inputs: ["server.rb"], skip: false, filter: true },
  { patterns: ["*.jsx?"], inputs: ["page.js"], skip: false, filter: true },
  { patterns: ["*.jsx?"], inputs: ["page.jsx"], skip: false, filter: true },
  { patterns: ["**"], inputs: ["all/the/files.md"], skip: false, filter: true },
  { patterns: ["*.js"], inputs: ["app.js"], skip: false, filter: true },
  { patterns: ["*.js"], inputs: ["index.js"], skip: false, filter: true },
  { patterns: ["**.js"], inputs: ["index.js"], skip: false, filter: true },
  { patterns: ["**.js"], inputs: ["js/index.js"], skip: false, filter: true },
  { patterns: ["**.js"], inputs: ["src/js/app.js"], skip: false, filter: true },
  { patterns: ["docs/*"], inputs: ["docs/README.md"], skip: false, filter: true },
  { patterns: ["docs/*"], inputs: ["docs/file.txt"], skip: false, filter: true },
  { patterns: ["docs/**"], inputs: ["docs/README.md"], skip: false, filter: true },
  { patterns: ["docs/**"], inputs: ["docs/mona/octocat.txt"], skip: false, filter: true },
  { patterns: ["docs/**/*.md"], inputs: ["docs/README.md"], skip: false, filter: true },
  { patterns: ["docs/**/*.md"], inputs: ["docs/mona/hello-world.md"], skip: false, filter: true },
  { patterns: ["docs/**/*.md"], inputs: ["docs/a/markdown/file.md"], skip: false, filter: true },
  { patterns: ["**/docs/**"], inputs: ["docs/hello.md"], skip: false, filter: true },
  { patterns: ["**/docs/**"], inputs: ["dir/docs/my-file.txt"], skip: false, filter: true },
  { patterns: ["**/docs/**"], inputs: ["space/docs/plan/space.doc"], skip: false, filter: true },
  { patterns: ["**/README.md"], inputs: ["README.md"], skip: false, filter: true },
  { patterns: ["**/README.md"], inputs: ["js/README.md"], skip: false, filter: true },
  { patterns: ["**/*src/**"], inputs: ["a/src/app.js"], skip: false, filter: true },
  { patterns: ["**/*src/**"], inputs: ["my-src/code/js/app.js"], skip: false, filter: true },
  { patterns: ["**/*-post.md"], inputs: ["my-post.md"], skip: false, filter: true },
  { patterns: ["**/*-post.md"], inputs: ["path/their-post.md"], skip: false, filter: true },
  { patterns: ["**/migrate-*.sql"], inputs: ["migrate-10909.sql"], skip: false, filter: true },
  { patterns: ["**/migrate-*.sql"], inputs: ["db/migrate-v1.0.sql"], skip: false, filter: true },
  { patterns: ["**/migrate-*.sql"], inputs: ["db/sept/migrate-v1.sql"], skip: false, filter: true },
  { patterns: ["*.md", "!README.md"], inputs: ["hello.md"], skip: false, filter: true },
  { patterns: ["*.md", "!README.md"], inputs: ["README.md"], skip: true, filter: true },
  { patterns: ["*.md", "!README.md"], inputs: ["docs/hello.md"], skip: true, filter: true },
  { patterns: ["*.md", "!README.md", "README*"], inputs: ["hello.md"], skip: false, filter: true },
  { patterns: ["*.md", "!README.md", "README*"], inputs: ["README.md"], skip: false, filter: true },
  { patterns: ["*.md", "!README.md", "README*"], inputs: ["README.doc"], skip: false, filter: true },
];

describe("the workflowpattern differential (upstream's TestMatchPattern table)", () => {
  for (const kase of UPSTREAM_PATTERN_CASES) {
    it(`patterns=[${kase.patterns.join(",")}] inputs=[${kase.inputs.join(",")}]`, () => {
      const patterns = compilePatterns(...kase.patterns);
      expect(skipPatterns(patterns, kase.inputs)).toBe(kase.skip);
      expect(filterPatterns(patterns, kase.inputs)).toBe(kase.filter);
    });
  }
});

// ---------------------------------------------------------------------------
// Event extraction (ParseRawOn)
// ---------------------------------------------------------------------------

describe("event extraction (ParseRawOn)", () => {
  it("parses the scalar form", () => {
    expect(getEventsFromContent("on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n")).toEqual([
      { name: "push", acts: {}, schedules: null },
    ]);
  });

  it("parses the sequence form and excludes workflow_call", () => {
    const events = getEventsFromContent("on: [push, workflow_call, pull_request]\njobs: {}\n");
    expect(events.map((e) => e.name)).toEqual(["push", "pull_request"]);
  });

  it("parses the mapping form with filters", () => {
    const events = getEventsFromContent(
      "on:\n  push:\n    branches: [main, 'release/*']\n    paths-ignore: ['**.md']\n  workflow_dispatch:\njobs: {}\n",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      name: "push",
      acts: { branches: ["main", "release/*"], "paths-ignore": ["**.md"] },
      schedules: null,
    });
    expect(events[1]).toEqual({ name: "workflow_dispatch", acts: {}, schedules: null });
  });

  it("parses schedule entries (the machinery stages, the parse lands)", () => {
    const events = getEventsFromContent('on:\n  schedule:\n    - cron: "0 2 * * *"\njobs: {}\n');
    expect(events[0]?.name).toBe("schedule");
    expect(events[0]?.schedules).toEqual([{ cron: "0 2 * * *" }]);
  });

  it("rejects an empty schedule list (upstream's error)", () => {
    const node = parseDocument("on:\n  schedule: []\njobs: {}\n").get("on", true);
    expect(() => parseRawOn(node as never)).toThrow("schedule must contain at least one cron entry");
  });

  it("a workflow with no on: extracts no events", () => {
    expect(getEventsFromContent("name: x\njobs: {}\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The push matchers
// ---------------------------------------------------------------------------

describe("matchPushEvent", () => {
  const push = { ref: "refs/heads/main", before: "1".repeat(40), after: "2".repeat(40) };
  const filesChanged = ["src/app.js", "README.md"];

  it("no filters matches", () => {
    expect(matchPushEvent(push, { name: "push", acts: {}, schedules: null }, null)).toBe("matched");
  });

  it("a branches filter matching → matched; not matching → filteredOut", () => {
    const evt: WorkflowEvent = { name: "push", acts: { branches: ["main", "dev"] }, schedules: null };
    expect(matchPushEvent(push, evt, null)).toBe("matched");
    const other = { ...push, ref: "refs/heads/topic" };
    expect(matchPushEvent(other, evt, null)).toBe("filteredOut");
  });

  it("branches-ignore: a matching ignored branch filters out; a non-matching one matches", () => {
    const evt: WorkflowEvent = { name: "push", acts: { "branches-ignore": ["dev"] }, schedules: null };
    expect(matchPushEvent({ ...push, ref: "refs/heads/dev" }, evt, null)).toBe("filteredOut");
    expect(matchPushEvent(push, evt, null)).toBe("matched");
  });

  it("a tags filter never matches a branch push (filteredOut)", () => {
    const evt: WorkflowEvent = { name: "push", acts: { tags: ["v1"] }, schedules: null };
    expect(matchPushEvent(push, evt, null)).toBe("filteredOut");
    expect(matchPushEvent({ ...push, ref: "refs/tags/v1" }, evt, null)).toBe("matched");
  });

  it("paths: any changed file matching keeps the match; none matching filters out", () => {
    const evt: WorkflowEvent = { name: "push", acts: { paths: ["src/**"] }, schedules: null };
    expect(matchPushEvent(push, evt, filesChanged)).toBe("matched");
    const evt2: WorkflowEvent = { name: "push", acts: { paths: ["docs/**"] }, schedules: null };
    expect(matchPushEvent(push, evt2, filesChanged)).toBe("filteredOut");
  });

  it("paths-ignore: an ignored-only delta filters out", () => {
    const evt: WorkflowEvent = { name: "push", acts: { "paths-ignore": ["**.md"] }, schedules: null };
    expect(matchPushEvent(push, evt, ["README.md"])).toBe("filteredOut");
    expect(matchPushEvent(push, evt, filesChanged)).toBe("matched");
  });

  it("a failed diff walk answers notApplicable", () => {
    const evt: WorkflowEvent = { name: "push", acts: { paths: ["src/**"] }, schedules: null };
    expect(matchPushEvent(push, evt, null)).toBe("notApplicable");
  });

  it("both branch and tag filters need only one to match", () => {
    const evt: WorkflowEvent = { name: "push", acts: { branches: ["main"], tags: ["v1"] }, schedules: null };
    expect(matchPushEvent(push, evt, null)).toBe("matched");
  });
});

describe("canGithubEventMatch + detectWorkflowMatch", () => {
  it("push/create/delete match their own names only", () => {
    expect(canGithubEventMatch("push", "push")).toBe(true);
    expect(canGithubEventMatch("create", "create")).toBe(true);
    expect(canGithubEventMatch("delete", "delete")).toBe(true);
    expect(canGithubEventMatch("push", "create")).toBe(false);
    expect(canGithubEventMatch("issues", "push")).toBe(false);
  });

  it("create/delete events match with no filter evaluation", () => {
    const evt: WorkflowEvent = { name: "create", acts: {}, schedules: null };
    expect(detectWorkflowMatch("create", null, evt, null)).toBe("matched");
    expect(detectWorkflowMatch("push", null, evt, null)).toBe("notApplicable");
  });
});

// ---------------------------------------------------------------------------
// The [skip ci] scan — both surfaces
// ---------------------------------------------------------------------------

describe("skipWorkflows ([skip ci], both surfaces)", () => {
  it("push scans the commit message", () => {
    expect(skipWorkflows("push", "fix: thing [skip ci] detail", null)).toBe(true);
    expect(skipWorkflows("push", "fix: thing", null)).toBe(false);
  });

  it("pull_request scans the PR title", () => {
    expect(skipWorkflows("pull_request", "clean message", "Title [ci skip]")).toBe(true);
    expect(skipWorkflows("pull_request", "clean message", "Title")).toBe(false);
  });

  it("pull_request_sync is a skip event", () => {
    expect(skipWorkflows("pull_request_sync", "[no ci]", null)).toBe(true);
  });

  it("non-skip events never skip", () => {
    expect(skipWorkflows("create", "[skip ci]", null)).toBe(false);
    expect(skipWorkflows("delete", "[skip ci]", null)).toBe(false);
  });

  it("the full upstream string family (modules/setting/actions.go:51)", () => {
    for (const s of ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"]) {
      expect(skipWorkflows("push", `msg ${s}`, null)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Workflow enumeration
// ---------------------------------------------------------------------------

describe("listWorkflows (first-existing-dir + .yml/.yaml + the 1 MiB cap)", () => {
  it(".gitea/workflows wins entirely when both dirs exist (the first-dir break)", async () => {
    const listing = {
      listTree: (_ref: string, path: string): Promise<{ entries: Array<{ name: string; type: "tree" | "blob" | "commit" }> } | null> =>
        path === ".gitea/workflows"
          ? Promise.resolve({ entries: [{ name: "a.yml", type: "blob" as const }] })
          : path === ".github/workflows"
            ? Promise.resolve({ entries: [{ name: "b.yml", type: "blob" as const }] })
            : Promise.resolve(null),
      readBlob: (_ref: string, path: string): Promise<{ data: Uint8Array } | null> =>
        path === ".gitea/workflows/a.yml"
          ? Promise.resolve({ data: new TextEncoder().encode("on: push\njobs: {}\n") })
          : Promise.resolve(null),
    };
    const files = await listWorkflows(listing, "refs/heads/main");
    expect(files.map((f) => f.entryName)).toEqual([".gitea/workflows/a.yml"]);
  });

  it("falls through to .github/workflows when .gitea/workflows is absent", async () => {
    const listing: WorkflowTreeReads = {
      listTree: (_ref, path) =>
        path === ".github/workflows" ? Promise.resolve({ entries: [{ name: "b.yaml", type: "blob" }] }) : Promise.resolve(null),
      readBlob: (_ref, path) =>
        path === ".github/workflows/b.yaml" ? Promise.resolve({ data: new Uint8Array(1) }) : Promise.resolve(null),
    };
    const files = await listWorkflows(listing, "refs/heads/main");
    expect(files.map((f) => f.entryName)).toEqual([".github/workflows/b.yaml"]);
  });

  it("no workflow dir anywhere answers empty", async () => {
    const files = await listWorkflows(
      { listTree: () => Promise.resolve(null), readBlob: () => Promise.resolve(null) },
      "refs/heads/main",
    );
    expect(files).toEqual([]);
  });

  it("a workflow over the 1 MiB cap is dropped, never truncated", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    const listing: WorkflowTreeReads = {
      listTree: (_ref, path) =>
        path === ".github/workflows"
          ? Promise.resolve({ entries: [{ name: "big.yml", type: "blob" }, { name: "ok.yml", type: "blob" }] })
          : Promise.resolve(null),
      readBlob: (_ref, path) => {
        if (path === ".github/workflows/big.yml") return Promise.resolve({ data: big });
        if (path === ".github/workflows/ok.yml") return Promise.resolve({ data: new TextEncoder().encode("on: push\njobs: {}\n") });
        return Promise.resolve(null);
      },
    };
    const files = await listWorkflows(listing, "refs/heads/main");
    expect(files.map((f) => f.entryName)).toEqual([".github/workflows/ok.yml"]);
  });

  it("isWorkflowPath gates on the dirs + extensions", () => {
    expect(isWorkflowPath(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowPath(".gitea/workflows/ci.yaml")).toBe(true);
    expect(isWorkflowPath(".github/workflows/ci.txt")).toBe(false);
    expect(isWorkflowPath("ci.yml")).toBe(false);
    expect(isWorkflowPath(".github/workflow/ci.yml")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ${{ gate + the payload split
// ---------------------------------------------------------------------------

describe("the ${{ insert gate + splitWorkflowPayloads", () => {
  const WF = `name: CI
on:
  push:
    branches: [main]
jobs:
  build:
    name: Build the thing
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: make test
`;

  it("the byte scan classifies expression-ful content", () => {
    expect(containsExpression("if: ${{ always() }}")).toBe(true);
    expect(containsExpression("plain: yml")).toBe(false);
  });

  it("one payload per job, needs erased, name defaulted, header carried", () => {
    const split = splitWorkflowPayloads(WF);
    expect(split.map((j) => j.jobId)).toEqual(["build", "test"]);
    expect(split[0]?.name).toBe("Build the thing");
    expect(split[1]?.needs).toEqual(["build"]);
    const test = split[1];
    expect(test).toBeDefined();
    const text = new TextDecoder().decode(test!.payload);
    // the header rides (name + on)
    expect(text).toContain("name: CI");
    expect(text).toContain("branches:");
    // needs are ERASED from the payload (EraseNeeds)
    expect(text).not.toContain("needs:");
    // the payload carries exactly one job — the test job, never build
    expect(text).toContain("test:");
    expect(text).not.toContain("build:");
    // the display name defaults into the payload (buildMatrixCombos' combo.Name)
    const unnamed = splitWorkflowPayloads("on: push\njobs:\n  solo:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(unnamed[0]?.name).toBe("solo");
    expect(new TextDecoder().decode(unnamed[0]!.payload)).toContain("name: solo");
  });

  it("a malformed jobs mapping throws (upstream 'invalid jobs' → no run)", () => {
    expect(() => splitWorkflowPayloads("on: push\njobs: 42\n")).toThrow();
  });

  it("max-parallel and continue-on-error literals read", () => {
    const split = splitWorkflowPayloads(
      "on: push\njobs:\n  a:\n    strategy:\n      max-parallel: 2\n    continue-on-error: true\n    runs-on: x\n    steps:\n      - run: y\n",
    );
    expect(split[0]?.maxParallel).toBe(2);
    expect(split[0]?.continueOnError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Commit status pieces
// ---------------------------------------------------------------------------

describe("commit status shapes", () => {
  it("toCommitStatus maps the states (commit_status.go:357-370)", () => {
    expect(toCommitStatus(ACTION_STATUS_SUCCESS)).toBe("success");
    expect(toCommitStatus(ACTION_STATUS_FAILURE)).toBe("failure");
    expect(toCommitStatus(3 /* CANCELLED */)).toBe("failure");
    expect(toCommitStatus(ACTION_STATUS_WAITING)).toBe("pending");
    expect(toCommitStatus(ACTION_STATUS_PENDING)).toBe("pending");
    expect(toCommitStatus(ACTION_STATUS_SKIPPED)).toBe("skipped");
  });

  it("toCommitStatusDescription arms", () => {
    const t0 = new Date(1_700_000_000_000);
    expect(toCommitStatusDescription({ status: ACTION_STATUS_SUCCESS, started: t0, stopped: new Date(t0.getTime() + 65_000) })).toBe("Successful in 65s");
    expect(toCommitStatusDescription({ status: ACTION_STATUS_FAILURE, started: t0, stopped: new Date(t0.getTime() + 5_000) })).toBe("Failing after 5s");
    expect(toCommitStatusDescription({ status: ACTION_STATUS_SKIPPED, started: null, stopped: null })).toBe("Skipped");
    expect(toCommitStatusDescription({ status: ACTION_STATUS_WAITING, started: null, stopped: null })).toBe("Waiting to run");
    expect(toCommitStatusDescription({ status: ACTION_STATUS_PENDING, started: null, stopped: null })).toBe("Waiting for needed jobs");
  });

  it("context naming (workflows.go:158-161)", () => {
    expect(workflowStatusContextName("CI", "build", "push")).toBe("CI / build (push)");
  });

  it("ShouldEventCreateCommitStatus allowlist", () => {
    expect(shouldEventCreateCommitStatus("push")).toBe(true);
    expect(shouldEventCreateCommitStatus("release")).toBe(true);
    expect(shouldEventCreateCommitStatus("create")).toBe(false);
    expect(shouldEventCreateCommitStatus("issues")).toBe(false);
  });

  it("push events read head_commit.id; a missing head blocks the status", () => {
    const run = { event: "push", triggerEvent: "push", commitSha: "a".repeat(40) };
    expect(commitStatusEventAndCommit(run, JSON.stringify({ head_commit: { id: "b".repeat(40) } }))).toEqual({
      event: "push",
      commitId: "b".repeat(40),
    });
    expect(commitStatusEventAndCommit(run, "{}")).toEqual({ event: "", commitId: "" });
  });

  it("pull_request events read the head sha; pull_request_target renames", () => {
    const run = { event: "pull_request", triggerEvent: "pull_request", commitSha: "a".repeat(40) };
    const payload = JSON.stringify({ pull_request: { head: { sha: "c".repeat(40) } } });
    expect(commitStatusEventAndCommit(run, payload)).toEqual({ event: "pull_request", commitId: "c".repeat(40) });
    expect(commitStatusEventAndCommit({ ...run, triggerEvent: "pull_request_target" }, payload)).toEqual({
      event: "pull_request_target",
      commitId: "c".repeat(40),
    });
  });
});

// ---------------------------------------------------------------------------
// InsertRun mechanics (D1)
// ---------------------------------------------------------------------------

const REPO_ID = "repo-trigger";
const USER_ID = 42;

async function seedRepo(): Promise<void> {
  await db().insert(users).values({
    id: USER_ID,
    username: "alice",
    usernameLower: "alice",
    status: "active",
    createdAt: new Date(0),
  });
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "alice",
    ownerId: USER_ID,
    slug: "demo",
    visibility: "public",
    isEmpty: false,
  });
  await db().insert(repoUnits).values({ repoId: REPO_ID, type: "actions" });
}

const TIP = "a".repeat(40);
const HEAD = "b".repeat(40);

function runInput(workflowId: string) {
  return {
    repoId: REPO_ID,
    ownerId: USER_ID,
    workflowId,
    triggerUserId: USER_ID,
    ref: "refs/heads/main",
    commitSha: TIP,
    isForkPullRequest: false,
    event: "push",
    eventPayloadJson: JSON.stringify({ head_commit: { id: HEAD } }),
    triggerEvent: "push",
    title: "fix: thing",
    repoOwnerNamespace: "alice",
    repoSlug: "demo",
    appUrl: "https://actions.example.com",
  };
}

const WF_CONTENT = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: make test
`;

describe("insertTriggeredRun (InsertRun rows + index + statuses)", () => {
  it("inserts run + attempt + job rows with the pending/waiting split and posts statuses", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(env.DB, runInput(".github/workflows/ci.yml"), WF_CONTENT);

    expect(run.index).toBe(1);
    expect(run.status).toBe(ACTION_STATUS_WAITING);
    expect(run.workflowId).toBe(".github/workflows/ci.yml");
    expect(run.triggerEvent).toBe("push");

    const attempts = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attempt).toBe(1);
    expect(attempts[0]?.status).toBe(ACTION_STATUS_WAITING);
    expect(run.latestAttemptId).toBe(attempts[0]?.id);

    expect(jobs.map((j) => [j.jobId, j.status])).toEqual([
      ["build", ACTION_STATUS_WAITING],
      ["test", ACTION_STATUS_PENDING],
    ]);
    expect(jobs[0]?.attemptJobId).toBe(1);
    expect(jobs[1]?.attemptJobId).toBe(2);
    // needs erased from the stored payload
    const testPayload = new TextDecoder().decode(jobs[1]!.workflowPayload as Uint8Array);
    expect(testPayload).not.toContain("needs:");

    // commit statuses: the WAITING job posts; the PENDING test job posts
    // nothing (onlyReplace — commit_status.go:174-177: a pending job whose
    // context matches no required glob is suppressed; its status appears
    // when the emitter releases it)
    const statuses = await db().select().from(commitStatuses).where(eq(commitStatuses.sha, HEAD));
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.context).toBe("CI / build (push)");
    expect(statuses[0]?.state).toBe("pending");
    expect(statuses[0]?.creatorId).toBe(ACTIONS_USER_ID);
    expect(statuses[0]?.targetUrl).toContain(`/actions/runs/${run.id}/jobs/`);

    // the waiting job bumps the task version
    expect(await getTasksVersionByScope(env.DB, 0, REPO_ID)).toBe(1);
  });

  it("the per-repo index increments across runs (the HANDOFF interim allocator)", async () => {
    await seedRepo();
    const first = await insertTriggeredRun(env.DB, runInput(".github/workflows/a.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n");
    const second = await insertTriggeredRun(env.DB, runInput(".github/workflows/b.yml"), "on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(first.run.index).toBe(1);
    expect(second.run.index).toBe(2);
  });

  it("an all-pending run (every job has needs) skips the task-version bump", async () => {
    await seedRepo();
    await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      "on: push\njobs:\n  a:\n    needs: b\n    runs-on: x\n    steps:\n      - run: y\n  b:\n    needs: a\n    runs-on: x\n    steps:\n      - run: y\n",
    );
    const jobs = await db().select().from(actionRunJobs);
    expect(jobs.every((j) => j.status === ACTION_STATUS_PENDING)).toBe(true);
    expect(await getTasksVersionByScope(env.DB, 0, REPO_ID)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The emitter needs-graph ordering (D1)
// ---------------------------------------------------------------------------

describe("checkJobsOfRun (needs ordering + skip cascade + aggregates)", () => {
  it("a finished need releases its pending dependent to waiting (the version wake fires)", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(env.DB, runInput(".github/workflows/ci.yml"), WF_CONTENT);
    const build = jobs.find((j) => j.jobId === "build")!;
    const test = jobs.find((j) => j.jobId === "test")!;
    expect(test.status).toBe(ACTION_STATUS_PENDING);
    const versionBefore = await getTasksVersionByScope(env.DB, 0, REPO_ID);

    // build finishes successfully
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_SUCCESS, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));

    await checkJobsOfRun(env.DB, run.id);

    const after = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, test.id));
    expect(after[0]?.status).toBe(ACTION_STATUS_WAITING);
    // the dependent's task-version wake (a job returned to waiting)
    expect(await getTasksVersionByScope(env.DB, 0, REPO_ID)).toBeGreaterThan(versionBefore);
    // the run/attempt aggregate refreshes to waiting (work remains)
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)))[0];
    expect(runRow?.status).toBe(ACTION_STATUS_WAITING);
    // the dependent's status re-posts
    const statuses = await db().select().from(commitStatuses).where(eq(commitStatuses.context, "CI / test (push)"));
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  it("a failed need skips the dependent (the implicit-success cascade) and fails the run", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(env.DB, runInput(".github/workflows/ci.yml"), WF_CONTENT);
    const build = jobs.find((j) => j.jobId === "build")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_FAILURE, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));

    await checkJobsOfRun(env.DB, run.id);

    const test = (await db().select().from(actionRunJobs)).find((j) => j.jobId === "test");
    expect(test?.status).toBe(ACTION_STATUS_SKIPPED);
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)))[0];
    expect(runRow?.status).toBe(ACTION_STATUS_FAILURE);
    // the skipped dependent posts its Skipped status
    const statuses = await db().select().from(commitStatuses).where(eq(commitStatuses.context, "CI / test (push)"));
    expect(statuses[statuses.length - 1]?.state).toBe("skipped");
  });

  it("a failed need with continue-on-error does NOT skip the dependent", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      "on: push\njobs:\n  build:\n    continue-on-error: true\n    runs-on: x\n    steps:\n      - run: make\n  test:\n    needs: build\n    runs-on: x\n    steps:\n      - run: make test\n",
    );
    const build = jobs.find((j) => j.jobId === "build")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_FAILURE, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));

    await checkJobsOfRun(env.DB, run.id);

    const test = (await db().select().from(actionRunJobs)).find((j) => j.jobId === "test");
    expect(test?.status).toBe(ACTION_STATUS_WAITING);
    // the run aggregates: the continued failure counts like success for the run
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)))[0];
    expect(runRow?.status).toBe(ACTION_STATUS_WAITING);
  });

  it("a chained cascade resolves to fixpoint (a→b→c skips propagate)", async () => {
    await seedRepo();
    const { run } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n  b:\n    needs: a\n    runs-on: x\n    steps:\n      - run: y\n  c:\n    needs: b\n    runs-on: x\n    steps:\n      - run: y\n",
    );
    const a = (await db().select().from(actionRunJobs)).find((j) => j.jobId === "a")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_FAILURE, started: now, stopped: now }).where(eq(actionRunJobs.id, a.id));

    await checkJobsOfRun(env.DB, run.id);

    const byId = Object.fromEntries((await db().select().from(actionRunJobs)).map((j) => [j.jobId, j.status]));
    expect(byId["b"]).toBe(ACTION_STATUS_SKIPPED);
    expect(byId["c"]).toBe(ACTION_STATUS_SKIPPED);
  });

  it("a pending dependent of an unfinished need stays pending", async () => {
    await seedRepo();
    const { run } = await insertTriggeredRun(env.DB, runInput(".github/workflows/ci.yml"), WF_CONTENT);
    await checkJobsOfRun(env.DB, run.id);
    const test = (await db().select().from(actionRunJobs)).find((j) => j.jobId === "test");
    expect(test?.status).toBe(ACTION_STATUS_PENDING);
  });

  it("aggregateJobStatus pins the precedence (run_job.go:509-554)", () => {
    expect(aggregateJobStatus([])).toBe(0); // ACTION_STATUS_UNKNOWN — "it shouldn't happen" (v1 never aggregates an empty set)
    expect(aggregateJobStatus([{ status: ACTION_STATUS_SKIPPED, continueOnError: false }])).toBe(ACTION_STATUS_SKIPPED);
    expect(
      aggregateJobStatus([
        { status: ACTION_STATUS_SUCCESS, continueOnError: false },
        { status: ACTION_STATUS_SKIPPED, continueOnError: false },
      ]),
    ).toBe(ACTION_STATUS_SUCCESS);
    expect(aggregateJobStatus([{ status: ACTION_STATUS_FAILURE, continueOnError: false }])).toBe(ACTION_STATUS_FAILURE);
    expect(aggregateJobStatus([{ status: ACTION_STATUS_FAILURE, continueOnError: true }])).toBe(ACTION_STATUS_SUCCESS);
    expect(
      aggregateJobStatus([
        { status: ACTION_STATUS_RUNNING, continueOnError: false },
        { status: ACTION_STATUS_WAITING, continueOnError: false },
      ]),
    ).toBe(ACTION_STATUS_RUNNING);
    expect(aggregateJobStatus([{ status: ACTION_STATUS_PENDING, continueOnError: false }])).toBe(ACTION_STATUS_RUNNING);
    // cancelled + failure (no fail-fast matrix in the mix) → CANCELLED
    // (upstream's hasCancelled arm precedes hasFailure; the fail-fast matrix
    // arm stages with the matrix rows)
    expect(
      aggregateJobStatus([
        { status: ACTION_STATUS_CANCELLED, continueOnError: false },
        { status: ACTION_STATUS_FAILURE, continueOnError: false },
      ]),
    ).toBe(ACTION_STATUS_CANCELLED);
  });
});

// ---------------------------------------------------------------------------
// The claim-payload rewrite (task.go:176-186)
// ---------------------------------------------------------------------------

describe("runnerWorkflowPayload (the if: always() rewrite)", () => {
  it("forces the job if to always(), preserving the job id and steps", () => {
    const stored = new TextEncoder().encode(
      "name: CI\non: push\njobs:\n  build:\n    name: Build\n    if: success()\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n",
    );
    const rewritten = new TextDecoder().decode(runnerWorkflowPayload(stored));
    // the scalar reads back always() however the emitter styles it
    const rewrittenIf = parseDocument(rewritten).getIn(["jobs", "build", "if"]);
    expect(rewrittenIf).toBe("always()");
    expect(rewritten).toContain("name: Build");
    expect(rewritten).toContain("- run: make");
    expect(rewritten).not.toContain("success()");
  });

  it("writes always() even when the job carried no if", () => {
    const stored = new TextEncoder().encode("on: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: y\n");
    const rewritten = new TextDecoder().decode(runnerWorkflowPayload(stored));
    expect(parseDocument(rewritten).getIn(["jobs", "build", "if"])).toBe("always()");
  });

  it("a payload with no job throws (the claim releases)", () => {
    expect(() => runnerWorkflowPayload(new TextEncoder().encode("jobs: {}\n"))).toThrow("payload contains no job");
    expect(() => runnerWorkflowPayload(new TextEncoder().encode("no jobs here\n"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The skipped-status arm + the dedupe short-circuit
// ---------------------------------------------------------------------------

describe("createWorkflowCommitStatus + the skipped-status arm", () => {
  it("an identical (state,url,description) row short-circuits the insert", async () => {
    await seedRepo();
    const input = {
      repoId: REPO_ID,
      commitId: HEAD,
      ctxName: "CI / build (push)",
      workflowId: ".github/workflows/ci.yml",
      state: "pending" as const,
      targetUrl: "https://x/runs/1/jobs/1",
      description: "Waiting to run",
      onlyReplace: false,
    };
    await createWorkflowCommitStatus(env.DB, input);
    await createWorkflowCommitStatus(env.DB, input);
    const rows = await db().select().from(commitStatuses);
    expect(rows).toHaveLength(1);
  });

  it("onlyReplace without a previous row posts nothing (an optional pending job)", async () => {
    await seedRepo();
    await createWorkflowCommitStatus(env.DB, {
      repoId: REPO_ID,
      commitId: HEAD,
      ctxName: "CI / optional (push)",
      workflowId: ".github/workflows/ci.yml",
      state: "pending",
      targetUrl: "https://x/runs/1/jobs/2",
      description: "Waiting for needed jobs",
      onlyReplace: true,
    });
    expect(await db().select().from(commitStatuses)).toHaveLength(0);
  });

  it("CreateSkippedCommitStatusForFilteredWorkflow: a required context posts Skipped, a non-required one posts nothing", async () => {
    await seedRepo();
    // the display name rides the workflow's own `name:` (workflows.go:146-156)
    const content = "name: CI\non: push\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: y\n";
    const payloadJson = JSON.stringify({ head_commit: { id: HEAD } });
    const globs = [
      { match: (s: string) => s.includes("CI / build (push)") },
    ];
    await createSkippedCommitStatusForFilteredWorkflow(env.DB, {
      repoId: REPO_ID,
      event: "push",
      triggerEvent: "push",
      workflowId: ".github/workflows/ci.yml",
      content,
      payloadJson,
      requiredGlobs: globs,
    });
    const rows = await db().select().from(commitStatuses);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("skipped");
    expect(rows[0]?.context).toBe("CI / build (push)");
    expect(rows[0]?.description).toBe("Skipped");
    expect(rows[0]?.targetUrl).toBe("");

    await createSkippedCommitStatusForFilteredWorkflow(env.DB, {
      repoId: REPO_ID,
      event: "push",
      triggerEvent: "push",
      workflowId: ".github/workflows/other.yml",
      content: "on: push\njobs:\n  other:\n    runs-on: x\n    steps:\n      - run: y\n",
      payloadJson,
      requiredGlobs: [],
    });
    expect(await db().select().from(commitStatuses)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The live end-to-end arm: receive-pack → onPush → rows (the entrypoint's
// engine composition — repo-size.test.ts's wiring pattern, extended with the
// Actions consumer beside handleUserPushEvent exactly as src/index.ts does).
// ---------------------------------------------------------------------------

import { createDurableGit, type DurableGitHandler } from "@cf-gitea/git-engine";
import { gitHttpGate } from "../../git-http/gate";
import { authorize } from "../../git-http/authorize";
import { RepoService } from "../../repos/service";
import { seedVerifiedUser, mintFor, basicTokenHeader } from "../../auth/testing/seeds";
import { buildReceivePackBody, ZERO_OID } from "../../repos/testing/git-pack";
import { handleUserPushEvent } from "../webhooks-push";
import { handleActionsPushEvent } from "./trigger";

const wiredEngine = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: async (event, env2) => {
    await handleUserPushEvent(env2, event);
    await handleActionsPushEvent(env2, event);
  },
});

const pendingWaits: Promise<unknown>[] = [];
const ctx: ExecutionContext = {
  waitUntil: (promise) => {
    pendingWaits.push(Promise.resolve(promise));
  },
  passThroughOnException: () => {},
  abort: () => {},
  exports: undefined as never,
  props: undefined,
  tracing: {
    enterSpan: <T, A extends unknown[]>(_name: string, callback: (span: never, ...args: A) => T, ...args: A): T => callback(undefined as never, ...args),
    startActiveSpan: <T, A extends unknown[]>(_name: string, callback: (span: never, ...args: A) => T, ...args: A): T =>
      callback(undefined as never, ...args),
    startSpan: () => undefined as never,
    getActiveSpan: () => undefined,
    Span: class {} as never,
  },
};

async function drainWaits(): Promise<void> {
  for (let round = 0; round < 10 && pendingWaits.length > 0; round++) {
    const batch = pendingWaits.splice(0, pendingWaits.length);
    await Promise.allSettled(batch);
  }
}

/** A commit chain with REAL nested trees (the workflow paths live two dirs
 *  deep — the builder writes proper sub-trees so the engine's path walk
 *  resolves `.gitea/workflows`). */
const TE = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

async function buildChainPack(
  parent: string | null,
  commits: Array<{ message: string; files: Array<{ path: string; content: string }>; time?: number }>,
): Promise<{ tips: string[]; pack: Uint8Array }> {
  const objects = new Map<string, { type: number; body: Uint8Array }>();
  const store = async (type: number, body: Uint8Array): Promise<string> => {
    const typeName = type === OBJ_COMMIT ? "commit" : type === OBJ_TREE ? "tree" : "blob";
    const raw = concatBytes(TE.encode(`${typeName} ${body.length}\0`), body);
    const oid = await sha1Hex(raw);
    if (!objects.has(oid)) objects.set(oid, { type, body });
    return oid;
  };
  interface TreeNode {
    kind: "tree";
    children: Map<string, TreeNode | { kind: "blob"; content: string }>;
  }
  const writeTree = async (node: TreeNode): Promise<string> => {
    const kids = [...node.children.entries()].sort(([a, av], [b, bv]) => {
      const an = av.kind === "tree" ? `${a}/` : a;
      const bn = bv.kind === "tree" ? `${b}/` : b;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const bytes: Uint8Array[] = [];
    for (const [name, child] of kids) {
      if (child.kind === "blob") {
        const oid = await store(OBJ_BLOB, TE.encode(child.content));
        bytes.push(concatBytes(TE.encode(`100644 ${name}\0`), rawOid(oid)));
      } else {
        const oid = await writeTree(child);
        bytes.push(concatBytes(TE.encode(`40000 ${name}\0`), rawOid(oid)));
      }
    }
    return store(OBJ_TREE, concatBytes(...bytes));
  };
  const tips: string[] = [];
  let parentOid = parent;
  for (const commit of commits) {
    const root: TreeNode = { kind: "tree", children: new Map() };
    for (const file of commit.files) {
      const parts = file.path.split("/");
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i]!;
        let child = cur.children.get(seg);
        if (child === undefined || child.kind !== "tree") {
          child = { kind: "tree", children: new Map() };
          cur.children.set(seg, child);
        }
        cur = child;
      }
      const last = parts[parts.length - 1]!;
      cur.children.set(last, { kind: "blob", content: file.content });
    }
    const treeOid = await writeTree(root);
    const person = (who: "author" | "committer") => `${who} Test User <test@example.com> ${commit.time ?? 1_700_000_000} +0000`;
    const commitBody =
      `tree ${treeOid}\n` +
      (parentOid !== null ? `parent ${parentOid}\n` : "") +
      `${person("author")}\n${person("committer")}\n\n${commit.message}\n`;
    const commitOid = await store(OBJ_COMMIT, TE.encode(commitBody));
    parentOid = commitOid;
    tips.push(commitOid);
  }
  const chunks: Uint8Array[] = [TE.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  const digest = await crypto.subtle.digest("SHA-1", concatBytes(...chunks));
  chunks.push(new Uint8Array(digest));
  return { tips, pack: concatBytes(...chunks) };
}

describe("the trigger end-to-end (receive-pack → onPush → action rows)", () => {
  async function seedE2eRepo(slug: string): Promise<{ owner: string; slug: string; repoId: string; userId: number }> {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const row = await new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") }).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: slug,
      isPrivate: false,
    });
    return { owner: row.ownerNamespace, slug: row.slug, repoId: row.id, userId: alice.id };
  }

  async function push(
    owner: string,
    slug: string,
    engine: DurableGitHandler<Env>,
    updates: Array<{ ref: string; oid: string }>,
    pack: Uint8Array,
    token: string,
  ): Promise<Response> {
    const base = `https://example.com/${owner}/${slug}.git`;
    const advert = await gitHttpGate(
      new Request(`${base}/info/refs?service=git-receive-pack`, { headers: { authorization: basicTokenHeader(token) } }),
      env,
      ctx,
      engine,
    );
    expect(advert.status).toBe(200);
    const response = await gitHttpGate(
      new Request(`${base}/git-receive-pack`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
        body: buildReceivePackBody(updates, pack),
      }),
      env,
      ctx,
      engine,
    );
    await drainWaits();
    return response;
  }

  beforeEach(async () => {
    for (const table of [
      "personal_access_tokens",
      "webhook_deliveries",
      "webhooks",
      "action_runs",
      "action_run_jobs",
      "action_run_attempts",
      "action_tasks",
      "action_tasks_versions",
      "commit_statuses",
      "repo_units",
      "repo_counters",
      "repo_redirects",
      "repositories",
      "users",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  });

  it("a push landing a push-triggered workflow inserts the run/job/status rows", async () => {
    const { owner, slug, userId } = await seedE2eRepo("triggered");
    const token = (await mintFor(userId, "t-write", "write:repository")).plaintext;
    const wf = "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed: readme", files: [{ path: "README.md", content: "hi\n" }] },
      { message: "ci: add workflow", files: [{ path: ".gitea/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[1]!;

    const response = await push(
      owner,
      slug,
      wiredEngine,
      [{ ref: "refs/heads/main", oid: tip }],
      pack,
      token,
    );
    expect(response.status).toBe(200);

    const runs = await db().select().from(actionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflowId).toBe(".gitea/workflows/ci.yml");
    expect(runs[0]?.event).toBe("push");
    expect(runs[0]?.triggerEvent).toBe("push");
    expect(runs[0]?.commitSha).toBe(tip);
    expect(runs[0]?.index).toBe(1);
    const eventPayload = JSON.parse(runs[0]?.eventPayload ?? "{}") as { head_commit?: { id?: string } };
    expect(eventPayload.head_commit?.id).toBe(tip);

    const jobRows = await db().select().from(actionRunJobs);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.jobId).toBe("build");
    expect(jobRows[0]?.status).toBe(ACTION_STATUS_WAITING);

    const statuses = await db().select().from(commitStatuses);
    expect(statuses.map((s) => s.context)).toEqual(["CI / build (push)"]);

    // a registered runner can now see the job (the dispatch scan reads it)
    expect(await getTasksVersionByScope(env.DB, 0, runs[0]?.repoId ?? "")).toBeGreaterThan(0);
  });

  it("a [skip ci] commit inserts nothing", async () => {
    const { owner, slug, userId } = await seedE2eRepo("skipci");
    const token = (await mintFor(userId, "t-skip", "write:repository")).plaintext;
    const wf = "name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".gitea/workflows/ci.yml", content: wf }] },
      { message: "docs [skip ci]", files: [{ path: "docs/a.md", content: "x\n" }] },
    ]);
    const tip = tips[1]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    expect(await db().select().from(actionRuns)).toHaveLength(0);
    expect(await db().select().from(commitStatuses)).toHaveLength(0);
  });

  it("an expression-ful workflow waits for the E tier (the ${{ gate) — no run", async () => {
    const { owner, slug, userId } = await seedE2eRepo("expr");
    const token = (await mintFor(userId, "t-expr", "write:repository")).plaintext;
    const wf = 'name: CI\non: push\njobs:\n  build:\n    if: ${{ always() }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".github/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    expect(await db().select().from(actionRuns)).toHaveLength(0);
  });

  it("a branch-filtered workflow (not the pushed branch) posts no run and no skipped status without required checks", async () => {
    const { owner, slug, userId } = await seedE2eRepo("filtered");
    const token = (await mintFor(userId, "t-filt", "write:repository")).plaintext;
    const wf = "name: CI\non:\n  push:\n    branches: [release/*]\njobs:\n  build:\n    runs-on: x\n    steps:\n      - run: y\n";
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".github/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    expect(await db().select().from(actionRuns)).toHaveLength(0);
    // no required checks configured → the skipped-status arm posts nothing
    expect(await db().select().from(commitStatuses)).toHaveLength(0);
  });

  it("a created branch fires the create event against on:create workflows", async () => {
    const { owner, slug, userId } = await seedE2eRepo("created");
    const token = (await mintFor(userId, "t-create", "write:repository")).plaintext;
    const wf = "name: OnCreate\non: create\njobs:\n  greet:\n    runs-on: x\n    steps:\n      - run: y\n";
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".gitea/workflows/create.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/feature", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    const runs = await db().select().from(actionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerEvent).toBe("create");
    expect(JSON.parse(runs[0]?.eventPayload ?? "{}")).toEqual(
      expect.objectContaining({ sha: tip, ref: "feature", ref_type: "branch" }),
    );
    void ZERO_OID;
  });
});
