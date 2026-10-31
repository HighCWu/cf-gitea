/**
 * The M3 trigger suite (SPEC-0012 §6.4): the P slice (the glob +
 * workflowpattern differential over upstream's OWN vector table —
 * workflowpattern_test.go TestMatchPattern, ported row-for-row, the `on:`
 * event extraction, the push matchers, the [skip ci] scan on BOTH surfaces,
 * the 1 MiB enumeration cap + first-existing-dir rule, InsertRun mechanics,
 * the emitter's needs-graph ordering, the claim-payload `if: always()`
 * rewrite, and the live receive-pack → rows end-to-end arm over the
 * entrypoint's engine composition) plus the E-tier call-site arms (§D5
 * E2/E3/E4): run-name interpolation, the job `if:` gate at insert and
 * emitter (the invalid-`if:` summaries), the workflow-level concurrency
 * gate, the repo_counters.run_index CAS, and the static-invalid →
 * FAILED-run seam through the real receive-pack harness.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { parseDocument } from "yaml";

import {
  actionRunJobSummaries,
  actionRuns,
  actionRunJobs,
  actionRunAttempts,
  actionTaskOutputs,
  actionVariables,
  commitStatuses,
  repoCounters,
  repoUnits,
  repositories,
  users,
} from "../../db/schema";
import {
  ACTION_STATUS_BLOCKED,
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
  evaluateJobIfExpression,
  evaluateRunConcurrency,
  filterPatterns,
  getEventsFromContent,
  insertTriggeredRun,
  isWorkflowPath,
  listWorkflows,
  marshalRawConcurrency,
  matchPushEvent,
  parseRawOn,
  readWorkflowRawConcurrency,
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
  "action_run_job_summaries",
  "action_task_outputs",
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

  it("the E-tier reads: run-name, job rawConcurrency, hasMatrix (the E5 gate flag)", () => {
    const split = splitWorkflowPayloads(
      `run-name: Deploy \${{ github.ref_name }}
on: push
concurrency:
  group: prod
  cancel-in-progress: true
jobs:
  build:
    concurrency:
      group: build-\${{ github.ref }}
    strategy:
      matrix:
        os: [linux, mac]
    runs-on: x
    steps:
      - run: y
  solo:
    runs-on: x
    steps:
      - run: y
`,
    );
    // the run-name rides RAW (the interpolation happens at insert, after
    // run.ID exists — run.go's insert-before-parse order)
    expect(split.every((j) => j.runName === "Deploy ${{ github.ref_name }}")).toBe(true);
    // the workflow-level concurrency is NOT per-job
    expect(split[0]?.rawConcurrency).toBe("group: build-${{ github.ref }}\n");
    // the matrix job flags (the staged E5 gate)
    expect(split[0]?.hasMatrix).toBe(true);
    expect(split[1]?.hasMatrix).toBe(false);
    expect(split[1]?.rawConcurrency).toBe("");
    // `matrix:` null is not a matrix (the empty-strategy shape upstream
    // resolves to one combo)
    const nullMatrix = splitWorkflowPayloads("on: push\njobs:\n  a:\n    strategy:\n      matrix:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(nullMatrix[0]?.hasMatrix).toBe(false);
  });

  it("a bool `if:` decodes to its text (the RawConcurrency string-field contract)", () => {
    const split = splitWorkflowPayloads("on: push\njobs:\n  a:\n    if: false\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(split[0]?.rawIf).toBe("false");
  });

  it("readWorkflowRawConcurrency + marshalRawConcurrency (model.go:288-293, workflow.go:1201-1228)", () => {
    expect(readWorkflowRawConcurrency("on: push\njobs: {}\n")).toBeNull();
    // mapping form: group + cancel-in-progress (bool → its text)
    expect(readWorkflowRawConcurrency("concurrency:\n  group: prod\n  cancel-in-progress: true\njobs: {}\n")).toEqual({
      group: "prod",
      cancelInProgress: "true",
      rawExpression: "",
    });
    // bare scalar → the RawExpression arm (UnmarshalYAML tries the string first)
    expect(readWorkflowRawConcurrency("concurrency: deploy-main\njobs: {}\n")).toEqual({
      group: "",
      cancelInProgress: "",
      rawExpression: "deploy-main",
    });
    // marshal: omitempty struct order; the expression renders as a plain scalar
    expect(marshalRawConcurrency({ group: "prod", cancelInProgress: "true", rawExpression: "" })).toBe('group: prod\ncancel-in-progress: "true"\n');
    expect(marshalRawConcurrency({ group: "", cancelInProgress: "", rawExpression: "${{ github.ref }}-build" })).toBe("${{ github.ref }}-build\n");
  });

  it("evaluateRunConcurrency interpolates the server env (concurrency.go:32-35's nil-job set)", () => {
    const github = { ref: "refs/heads/main", ref_name: "main" };
    expect(evaluateRunConcurrency(github, { group: "prod", cancelInProgress: "false", rawExpression: "" }, {})).toEqual({
      group: "prod",
      cancel: false,
    });
    expect(evaluateRunConcurrency(github, { group: "deploy-${{ github.ref_name }}", cancelInProgress: "true", rawExpression: "" }, {})).toEqual({
      group: "deploy-main",
      cancel: true,
    });
    // the whole-value expression re-decodes as the RawExpression arm (no cancel)
    expect(evaluateRunConcurrency(github, { group: "", cancelInProgress: "", rawExpression: "${{ github.ref_name }}-build" }, {})).toEqual({
      group: "main-build",
      cancel: false,
    });
    // YAML 1.2 truthiness only (ParseYamlBool)
    expect(evaluateRunConcurrency(github, { group: "g", cancelInProgress: "yes", rawExpression: "" }, {}).cancel).toBe(false);
  });

  it("evaluateJobIfExpression pins the restricted-context re-check and the verdicts", () => {
    const github = { ref_name: "main", env: { FORBIDDEN: "x" } };
    // success verdict under the implicit success default
    expect(evaluateJobIfExpression({ jobId: "b", rawIf: "success()", githubContext: github, results: { b: {} }, vars: undefined })).toEqual({
      value: true,
      invalidSummary: null,
    });
    // the defensive unavailableContext arm (a stored job before validation)
    expect(evaluateJobIfExpression({ jobId: "b", rawIf: "${{ env.FORBIDDEN }}", githubContext: github, results: {}, vars: undefined })).toEqual({
      value: false,
      invalidSummary: "job b: Unrecognized named-value: 'env', update the workflow and trigger a new run",
    });
    // a bare condition reads as one expression (IfExpression's wrap)
    expect(evaluateJobIfExpression({ jobId: "b", rawIf: "false", githubContext: github, results: {}, vars: undefined }).value).toBe(false);
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

  it("the per-repo index rides the repo_counters.run_index CAS (GetNextResourceIndex's named-sequence shape)", async () => {
    await seedRepo();
    const first = await insertTriggeredRun(env.DB, runInput(".github/workflows/a.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n");
    const second = await insertTriggeredRun(env.DB, runInput(".github/workflows/b.yml"), "on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(first.run.index).toBe(1);
    expect(second.run.index).toBe(2);
    const counters = await db().select().from(repoCounters);
    expect(counters).toHaveLength(1);
    expect(counters[0]?.runIndex).toBe(2);
    expect(counters[0]?.issueIndex).toBe(0);
  });

  it("a stale counter self-heals to the repo max before the bump (the never-rewind repair)", async () => {
    await seedRepo();
    const first = await insertTriggeredRun(env.DB, runInput(".github/workflows/a.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(first.run.index).toBe(1);
    // simulate a pre-column repo: the counter at 0 while a run row sits at 1
    await db().update(repoCounters).set({ runIndex: 0 }).where(eq(repoCounters.repoId, REPO_ID));
    const second = await insertTriggeredRun(env.DB, runInput(".github/workflows/b.yml"), "on: push\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(second.run.index).toBe(2);
    // a counter AHEAD of the rows never rewinds either
    await db().update(repoCounters).set({ runIndex: 9 }).where(eq(repoCounters.repoId, REPO_ID));
    const third = await insertTriggeredRun(env.DB, runInput(".github/workflows/c.yml"), "on: push\njobs:\n  c:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(third.run.index).toBe(10);
  });

  it("E2 — a run-name interpolates over the commit-subject title (github/vars/inputs)", async () => {
    await seedRepo();
    const { run } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/deploy.yml"),
      `run-name: Deploy \${{ github.ref_name }} by \${{ github.actor }}
on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(run.title).toBe("Deploy main by alice");
    // vars come from the action_variables store (GetVariablesOfRun's merge);
    // github.event reads the stored payload
    await db().insert(actionVariables).values({ ownerId: 0, repoId: REPO_ID, name: "ENV_NAME", data: "production", createdAt: new Date(0), updatedAt: new Date(0) });
    const withVars = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/env.yml"),
      `run-name: "[\${{ vars.ENV_NAME }}] \${{ github.event.head_commit.id }}"
on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(withVars.run.title).toBe(`[production] ${HEAD}`);
  });

  it("E2 — a run-name evaluation error aborts the insert (no run; the counter rolls back)", async () => {
    await seedRepo();
    await expect(
      insertTriggeredRun(
        env.DB,
        runInput(".github/workflows/bad.yml"),
        `run-name: "\${{ fromJSON('not json') }}"
on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: y
`,
      ),
    ).rejects.toThrow(/interpolate run-name/);
    expect(await db().select().from(actionRuns)).toHaveLength(0);
    expect(await db().select().from(actionRunAttempts)).toHaveLength(0);
    // the consumed index rolled back — the next run is 1 again
    const next = await insertTriggeredRun(env.DB, runInput(".github/workflows/ok.yml"), "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n");
    expect(next.run.index).toBe(1);
  });

  it("E4 — a literal workflow-level concurrency blocks the second run of the group", async () => {
    await seedRepo();
    const wf = (cancel: string) => `on: push\nconcurrency:\n  group: prod\n  cancel-in-progress: ${cancel}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n`;
    const first = await insertTriggeredRun(env.DB, runInput(".github/workflows/one.yml"), wf("false"));
    expect(first.run.status).toBe(ACTION_STATUS_WAITING);
    expect((await db().select().from(actionRunAttempts))[0]?.concurrencyGroup).toBe("prod");

    const second = await insertTriggeredRun(env.DB, runInput(".github/workflows/two.yml"), wf("false"));
    expect(second.run.status).toBe(ACTION_STATUS_BLOCKED);
    expect(second.jobs[0]?.status).toBe(ACTION_STATUS_BLOCKED);
    // the blocked run never wakes a runner
    expect(await getTasksVersionByScope(env.DB, 0, REPO_ID)).toBe(1);
    // rawConcurrency stored (run.go:83-89)
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, second.run.id)))[0];
    expect(runRow?.rawConcurrency).toContain("group: prod");
  });

  it("E4 — cancel-in-progress clears the group's unfinished members and starts", async () => {
    await seedRepo();
    const wf = (cancel: string) => `on: push\nconcurrency:\n  group: prod\n  cancel-in-progress: ${cancel}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: y\n`;
    const first = await insertTriggeredRun(env.DB, runInput(".github/workflows/one.yml"), wf("false"));
    const blocker = await insertTriggeredRun(env.DB, runInput(".github/workflows/two.yml"), wf("false"));
    expect(blocker.run.status).toBe(ACTION_STATUS_BLOCKED);

    const third = await insertTriggeredRun(env.DB, runInput(".github/workflows/three.yml"), wf("true"));
    // cancel=true clears the unfinished entries (the holder + the blocked
    // waiter — getConcurrencyEntriesToReplace's unfinished arm) and starts
    expect(third.run.status).toBe(ACTION_STATUS_WAITING);
    const byRun = await db().select().from(actionRunJobs);
    expect(byRun.filter((j) => j.runId === first.run.id).every((j) => j.status === ACTION_STATUS_CANCELLED)).toBe(true);
    const blockerJobs = byRun.filter((j) => j.runId === blocker.run.id);
    expect(blockerJobs.every((j) => j.status === ACTION_STATUS_CANCELLED)).toBe(true);
    const thirdJobs = byRun.filter((j) => j.runId === third.run.id);
    expect(thirdJobs.every((j) => j.status === ACTION_STATUS_WAITING)).toBe(true);
    // the cancelled runs settled to cancelled aggregates (the
    // UpdateRunJob refresh piggyback, run_job.go:542)
    const runRows = await db().select().from(actionRuns);
    expect(runRows.find((r) => r.id === first.run.id)?.status).toBe(ACTION_STATUS_CANCELLED);
    expect(runRows.find((r) => r.id === blocker.run.id)?.status).toBe(ACTION_STATUS_CANCELLED);
    expect(runRows.find((r) => r.id === third.run.id)?.status).toBe(ACTION_STATUS_WAITING);
  });

  it("E4 — a concurrency evaluation error aborts the insert (no run)", async () => {
    await seedRepo();
    await expect(
      insertTriggeredRun(
        env.DB,
        runInput(".github/workflows/bad.yml"),
        `on: push
concurrency:
  group: "\${{ fromJSON('nope[') }}"
jobs:
  a:
    runs-on: x
    steps:
      - run: y
`,
      ),
    ).rejects.toThrow(/evaluate concurrency/);
    expect(await db().select().from(actionRuns)).toHaveLength(0);
  });

  it("E3 — decideJobIf: a false `if:` inserts the job SKIPPED; a passing one waits", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  never:
    if: \${{ github.ref_name == 'nope' }}
    runs-on: x
    steps:
      - run: y
  always:
    if: \${{ always() }}
    runs-on: x
    steps:
      - run: y
  bare-false:
    if: false
    runs-on: x
    steps:
      - run: y
`,
    );
    const byId = Object.fromEntries(jobs.map((j) => [j.jobId, j.status]));
    expect(byId["never"]).toBe(ACTION_STATUS_SKIPPED);
    expect(byId["always"]).toBe(ACTION_STATUS_WAITING);
    expect(byId["bare-false"]).toBe(ACTION_STATUS_SKIPPED);
  });

  it("E3 — an invalid `if:` skips the job and writes its summary (helper.go:123-156)", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      "on: push\njobs:\n  bad:\n    if: ${{ env.FORBIDDEN }}\n    runs-on: x\n    steps:\n      - run: y\n",
    );
    expect(jobs[0]?.status).toBe(ACTION_STATUS_SKIPPED);
    const summaries = await db().select().from(actionRunJobSummaries);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.jobId).toBe(jobs[0]?.id);
    expect(summaries[0]?.stepIndex).toBe(0);
    expect(summaries[0]?.content).toContain("Error when evaluating `if` for job `bad`.");
    expect(summaries[0]?.content).toContain("Unrecognized named-value: 'env'");
    expect(summaries[0]?.contentType).toBe("text/markdown");
    // the run settles skipped (all jobs skipped)
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)))[0];
    expect(runRow?.status).toBe(ACTION_STATUS_SKIPPED);
  });

  it("E3 — a runtime evaluation error in `if:` takes the same invalid-summary arm (resolveJobIf's wrap)", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  bad:
    if: "\${{ fromJSON('not json') }}"
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(jobs[0]?.status).toBe(ACTION_STATUS_SKIPPED);
    const summaries = await db().select().from(actionRunJobSummaries);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toContain("Error when evaluating `if` for job `bad`.");
  });

  it("E3 — a skipped insert kick resolves the dependents (needPostCommitEmit, run.go:172-178)", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  gate:
    if: "\${{ false }}"
    runs-on: x
    steps:
      - run: y
  dependent:
    needs: gate
    runs-on: x
    steps:
      - run: y
`,
    );
    const byId = Object.fromEntries(jobs.map((j) => [j.jobId, j.status]));
    // the insert tail ran the emitter: gate skipped → dependent skipped
    expect(byId["gate"]).toBe(ACTION_STATUS_SKIPPED);
    expect(byId["dependent"]).toBe(ACTION_STATUS_SKIPPED);
  });

  it("E4 — a job-level concurrency node stores raw AND evaluates at insert (the fill model)", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  a:
    concurrency:
      group: build-\${{ github.ref }}
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(jobs[0]?.status).toBe(ACTION_STATUS_WAITING);
    expect(jobs[0]?.rawConcurrency).toContain("group: build-${{ github.ref }}");
    expect(jobs[0]?.isConcurrencyEvaluated).toBe(true);
    expect(jobs[0]?.concurrencyGroup).toBe("build-refs/heads/main");
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
// The E5 matrix arms (the model port wired at insert + the emitter)
// ---------------------------------------------------------------------------

describe("insertTriggeredRun E5 (matrix expansion + combos + job-level concurrency)", () => {
  it("static combos expand with interpolated name/runs-on/continue-on-error and the baked strategy", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  build:
    name: build-\${{ matrix.os }}
    strategy:
      matrix:
        os: [linux, mac]
        version: [1.20]
    runs-on: \${{ matrix.os }}
    continue-on-error: \${{ matrix.os == 'mac' }}
    steps:
      - run: make
`,
    );
    expect(jobs).toHaveLength(2);
    const byRunsOn = new Map(jobs.map((j) => [(JSON.parse(j.runsOn) as string[])[0] as string, j]));
    const linux = byRunsOn.get("linux");
    const mac = byRunsOn.get("mac");
    expect(linux?.name).toBe("build-linux");
    expect(mac?.name).toBe("build-mac");
    expect(linux?.continueOnError).toBe(false);
    expect(mac?.continueOnError).toBe(true);
    // the payload's baked matrix + job-index/job-total (the runner's own view)
    const linuxPayload = new TextDecoder().decode(linux!.workflowPayload as Uint8Array);
    expect(linuxPayload).toContain("- linux");
    expect(linuxPayload).toContain("job-total: 2");
    expect(linuxPayload).not.toContain("job-index"); // the zero index omits (the .out.yaml parity)
    const macPayload = new TextDecoder().decode(mac!.workflowPayload as Uint8Array);
    expect(macPayload).toContain("job-index: 1");
    expect(macPayload).toContain("job-total: 2");
    expect(linuxPayload).toContain("name: build-linux"); // the runner keeps the expression escapes' evaluation
    expect(linuxPayload).not.toContain("needs:"); // insertRunJob's EraseNeeds
    expect(linux?.status).toBe(ACTION_STATUS_WAITING);
    expect(linux?.isMatrixDeferred).toBe(false);
  });

  it("a needs-reading matrix plans as the deferred placeholder; the emitter expands it when the need finishes", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  setup:
    steps: [{run: echo}]
  build:
    needs: setup
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: \${{ fromJSON(needs.setup.outputs.oses) }}
    steps:
      - run: make
`,
    );
    const placeholder = jobs.find((j) => j.jobId === "build");
    expect(placeholder).toBeDefined();
    expect(placeholder?.isMatrixDeferred).toBe(true);
    expect(placeholder?.deferredMatrixPayload).not.toBeNull();
    expect(placeholder?.status).toBe(ACTION_STATUS_PENDING); // waiting on setup

    // setup finishes (its task outputs carry the matrix values)
    await db()
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_SUCCESS, stopped: new Date(), taskId: 77 })
      .where(eq(actionRunJobs.jobId, "setup"));
    await db().insert(actionTaskOutputs).values({
      taskId: 77,
      outputKey: "oses",
      outputValue: `["linux","mac"]`,
    });
    await db()
      .update(actionRuns)
      .set({ status: ACTION_STATUS_WAITING })
      .where(eq(actionRuns.id, run.id));
    await checkJobsOfRun(env.DB, run.id);

    const after = await db().select().from(actionRunJobs).orderBy(actionRunJobs.id);
    const expanded = after.filter((j) => j.jobId === "build");
    expect(expanded).toHaveLength(2);
    expect(expanded.every((j) => j.isMatrixDeferred === false)).toBe(true);
    expect(expanded.map((j) => (JSON.parse(j.runsOn) as string[])[0] as string).sort()).toEqual(["linux", "mac"]);
    const setup = after.find((j) => j.jobId === "setup");
    expect(setup?.status).toBe(ACTION_STATUS_SUCCESS);
  });

  it("a matrix expansion failure terminal-fails the placeholder (the D5 late posture)", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  setup:
    steps: [{run: echo}]
  build:
    needs: setup
    strategy:
      matrix:
        os: \${{ fromJSON(needs.setup.outputs.oses) }}
    runs-on: x
    steps: [{run: echo}]
`,
    );
    const placeholder = jobs.find((j) => j.jobId === "build");
    expect(placeholder?.isMatrixDeferred).toBe(true);
    await db()
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_SUCCESS, stopped: new Date() })
      .where(eq(actionRunJobs.jobId, "setup"));
    // the output is NOT a JSON array of values → the expansion fails late
    await db()
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_SUCCESS, stopped: new Date(), taskId: 78 })
      .where(eq(actionRunJobs.jobId, "setup"));
    await db().insert(actionTaskOutputs).values({
      taskId: 78,
      outputKey: "oses",
      outputValue: `{"a":1}`,
    });
    await checkJobsOfRun(env.DB, run.id);
    const after = await db().select().from(actionRunJobs);
    const build = after.find((j) => j.jobId === "build");
    expect(build?.status).toBe(ACTION_STATUS_FAILURE);
  });

  it("a job-level concurrency cancel-in-progress clears the group's earlier job", async () => {
    await seedRepo();
    const first = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  a:
    concurrency:
      group: shared
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(first.jobs[0]?.status).toBe(ACTION_STATUS_WAITING);
    const second = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  b:
    concurrency:
      group: shared
      cancel-in-progress: true
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(second.jobs[0]?.isConcurrencyEvaluated).toBe(true);
    expect(second.jobs[0]?.concurrencyGroup).toBe("shared");
    const jobs = await db().select().from(actionRunJobs);
    const a = jobs.find((j) => j.jobId === "a");
    expect(a?.status).toBe(ACTION_STATUS_CANCELLED); // cancel-in-progress cleared the group's holder
  });

  it("a job-level concurrency group blocks a second entrant (plain concurrency)", async () => {
    await seedRepo();
    const first = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  a:
    concurrency:
      group: serial
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(first.jobs[0]?.concurrencyGroup).toBe("serial");
    const second = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  b:
    concurrency:
      group: serial
    runs-on: x
    steps:
      - run: y
`,
    );
    expect(second.jobs[0]?.status).toBe(ACTION_STATUS_BLOCKED);
  });

  it("a PENDING job with a concurrency node stores it unevaluated (the emitter resolves it)", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  setup:
    steps: [{run: echo}]
  build:
    needs: setup
    concurrency:
      group: g-\${{ needs.setup.outputs.v }}
    runs-on: x
    steps: [{run: echo}]
`,
    );
    const build = jobs.find((j) => j.jobId === "build");
    expect(build?.status).toBe(ACTION_STATUS_PENDING);
    expect(build?.rawConcurrency).toContain("group: g-");
    expect(build?.isConcurrencyEvaluated).toBe(false);
    expect(build?.concurrencyGroup).toBe("");
  });

  it("max-parallel blocks the combos over the limit at insert (applyMaxParallel)", async () => {
    await seedRepo();
    const { jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  build:
    strategy:
      max-parallel: 1
      matrix:
        os: [a, b, c]
    runs-on: x
    steps: [{run: echo}]
`,
    );
    expect(jobs).toHaveLength(3);
    const waiting = jobs.filter((j) => j.status === ACTION_STATUS_WAITING);
    const blocked = jobs.filter((j) => j.status === ACTION_STATUS_BLOCKED);
    expect(waiting).toHaveLength(1);
    expect(blocked).toHaveLength(2);
  });

  it("a stored runs-on that fails the schema fails the job with its summary (the runs-on arm)", async () => {
    await seedRepo();
    const { jobs, run } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  a:
    runs-on: [[deep]]
    steps: [{run: echo}]
`,
    );
    expect(jobs[0]?.status).toBe(ACTION_STATUS_FAILURE);
    const summaries = await db().select().from(actionRunJobSummaries);
    expect(summaries.some((s) => s.content.includes("runs-on") && s.runId === run.id)).toBe(true);
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

  it("E3 — the emitter evaluates a non-empty `if:` against needs results and outputs", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: make
  on-ok:
    needs: build
    if: \${{ needs.build.result == 'success' }}
    runs-on: x
    steps:
      - run: y
  on-fail:
    needs: build
    if: "\${{ failure() }}"
    runs-on: x
    steps:
      - run: y
  on-output:
    needs: build
    if: \${{ needs.build.outputs.tag == 'v1' }}
    runs-on: x
    steps:
      - run: y
`,
    );
    const build = jobs.find((j) => j.jobId === "build")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_SUCCESS, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));
    // build's task outputs feed needs.build.outputs
    await db().update(actionRunJobs).set({ taskId: 777 }).where(eq(actionRunJobs.id, build.id));
    await db().insert(actionTaskOutputs).values({ taskId: 777, outputKey: "tag", outputValue: "v1" });

    await checkJobsOfRun(env.DB, run.id);

    const byId = Object.fromEntries((await db().select().from(actionRunJobs)).map((j) => [j.jobId, j.status]));
    expect(byId["on-ok"]).toBe(ACTION_STATUS_WAITING);
    expect(byId["on-fail"]).toBe(ACTION_STATUS_SKIPPED); // nothing failed → failure() is false
    expect(byId["on-output"]).toBe(ACTION_STATUS_WAITING);
    expect(await db().select().from(actionRunJobSummaries)).toHaveLength(0);
  });

  it("E3 — an invalid `if:` at the emitter writes the summary and skips (evaluateJobIf helper.go:123-131)", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: make
  bad:
    needs: build
    if: "\${{ fromJSON('oops[') }}"
    runs-on: x
    steps:
      - run: y
`,
    );
    const build = jobs.find((j) => j.jobId === "build")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_SUCCESS, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));

    await checkJobsOfRun(env.DB, run.id);

    const byId = Object.fromEntries((await db().select().from(actionRunJobs)).map((j) => [j.jobId, j.status]));
    expect(byId["bad"]).toBe(ACTION_STATUS_SKIPPED);
    const summaries = await db().select().from(actionRunJobSummaries);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toContain("Error when evaluating `if` for job `bad`.");
    // the run aggregates: success + skipped → success
    const runRow = (await db().select().from(actionRuns).where(eq(actionRuns.id, run.id)))[0];
    expect(runRow?.status).toBe(ACTION_STATUS_SUCCESS);
  });

  it("E3 — a failed need skips a bare-`if:` dependent and an if-true dependent still runs", async () => {
    await seedRepo();
    const { run, jobs } = await insertTriggeredRun(
      env.DB,
      runInput(".github/workflows/ci.yml"),
      `on: push
jobs:
  build:
    runs-on: x
    steps:
      - run: make
  implicit:
    needs: build
    runs-on: x
    steps:
      - run: y
  explicit-always:
    needs: build
    if: "\${{ always() }}"
    runs-on: x
    steps:
      - run: y
`,
    );
    const build = jobs.find((j) => j.jobId === "build")!;
    const now = new Date();
    await db().update(actionRunJobs).set({ status: ACTION_STATUS_FAILURE, started: now, stopped: now }).where(eq(actionRunJobs.id, build.id));

    await checkJobsOfRun(env.DB, run.id);

    const byId = Object.fromEntries((await db().select().from(actionRunJobs)).map((j) => [j.jobId, j.status]));
    expect(byId["implicit"]).toBe(ACTION_STATUS_SKIPPED);
    expect(byId["explicit-always"]).toBe(ACTION_STATUS_WAITING);
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

  it("an expression-ful `if:` now decides (the E tier): always() inserts and starts the job", async () => {
    const { owner, slug, userId } = await seedE2eRepo("expr");
    const token = (await mintFor(userId, "t-expr", "write:repository")).plaintext;
    const wf = 'name: CI\non: push\njobs:\n  build:\n    if: ${{ always() }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".github/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    const runs = await db().select().from(actionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.title).toBe("seed"); // no run-name → the commit subject stands
    const jobRows = await db().select().from(actionRunJobs);
    expect(jobRows[0]?.status).toBe(ACTION_STATUS_WAITING);
  });

  it("a run-name renders through the evaluator end-to-end", async () => {
    const { owner, slug, userId } = await seedE2eRepo("runname");
    const token = (await mintFor(userId, "t-run", "write:repository")).plaintext;
    const wf = 'run-name: "CI for ${{ github.ref_name }}"\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".gitea/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    const runs = await db().select().from(actionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.title).toBe("CI for main");
  });

  it("a matrix workflow flows end-to-end (the E5 gate un-narrowed): one job row per combination", async () => {
    const { owner, slug, userId } = await seedE2eRepo("matrix");
    const token = (await mintFor(userId, "t-matrix", "write:repository")).plaintext;
    const wf =
      "name: CI\non: push\njobs:\n  build:\n    strategy:\n      matrix:\n        os: [linux, mac]\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: make\n";
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: ".gitea/workflows/ci.yml", content: wf }] },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);
    const runs = await db().select().from(actionRuns);
    expect(runs).toHaveLength(1);
    const jobs = await db().select().from(actionRunJobs).orderBy(actionRunJobs.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => JSON.parse(j.runsOn) as string[])).toEqual([["linux"], ["mac"]]);
    expect(jobs.map((j) => j.name)).toEqual(["build (linux)", "build (mac)"]);
    for (const job of jobs) {
      expect(job.isMatrixDeferred).toBe(false);
      // the payload's baked strategy carries the single-value matrix + the combo index
      const text = new TextDecoder().decode(job.workflowPayload as Uint8Array);
      expect(text).toContain("job-total: 2");
    }
  });

  it("the static-validation seam: a push landing a context-violating workflow records its FAILED run (error verbatim) while a clean workflow still matches", async () => {
    const { owner, slug, userId } = await seedE2eRepo("seam");
    const token = (await mintFor(userId, "t-seam", "write:repository")).plaintext;
    // bad.yml reads `env` in a job `if:` — jobConditionContexts excludes it
    // (validate.go:19-20); good.yml is plain push CI.
    const badWf = 'name: Bad\non: push\njobs:\n  bad:\n    if: ${{ env.FORBIDDEN }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n';
    const goodWf = "name: Good\non: push\njobs:\n  ok:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
    const { tips, pack } = await buildChainPack(null, [
      {
        message: "seed: both workflows",
        files: [
          { path: ".gitea/workflows/bad.yml", content: badWf },
          { path: ".gitea/workflows/good.yml", content: goodWf },
        ],
      },
    ]);
    const tip = tips[0]!;
    const response = await push(owner, slug, wiredEngine, [{ ref: "refs/heads/main", oid: tip }], pack, token);
    expect(response.status).toBe(200);

    const runs = await db().select().from(actionRuns).orderBy(actionRuns.id);
    expect(runs).toHaveLength(2);
    const badRun = runs.find((r) => r.workflowId === ".gitea/workflows/bad.yml");
    const goodRun = runs.find((r) => r.workflowId === ".gitea/workflows/good.yml");
    expect(badRun).toBeDefined();
    expect(goodRun).toBeDefined();

    // the invalid arm: FAILED with started/stopped pinned (invalid_workflow.go:48-79)
    expect(badRun?.status).toBe(ACTION_STATUS_FAILURE);
    expect(badRun?.started).not.toBeNull();
    expect(badRun?.stopped).not.toBeNull();
    expect(badRun?.title).toBe("seed: both workflows");
    expect(badRun?.triggerEvent).toBe("push");
    expect(badRun?.index).toBeGreaterThan(0);

    // the summary carries the parse error verbatim (invalid_workflow.go:81)
    const summaries = await db().select().from(actionRunJobSummaries).where(eq(actionRunJobSummaries.runId, badRun?.id ?? 0));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.contentType).toBe("text/markdown");
    expect(summaries[0]?.content).toBe(
      "**Invalid workflow file: .gitea/workflows/bad.yml**\n\n```\njob bad: Unrecognized named-value: 'env'\n```\n",
    );
    expect(summaries[0]?.contentSize).toBe(new TextEncoder().encode(summaries[0]?.content ?? "").length);

    // the clean workflow ran the whole trigger chain: run + waiting job +
    // commit status + a pickable task version
    expect(goodRun?.status).toBe(ACTION_STATUS_WAITING);
    const goodJobs = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, goodRun?.id ?? 0));
    expect(goodJobs).toHaveLength(1);
    expect(goodJobs[0]?.jobId).toBe("ok");
    expect(goodJobs[0]?.status).toBe(ACTION_STATUS_WAITING);
    const statuses = await db().select().from(commitStatuses);
    expect(statuses.map((s) => s.context)).toEqual(["Good / ok (push)"]);
    expect(await getTasksVersionByScope(env.DB, 0, goodRun?.repoId ?? "")).toBeGreaterThan(0);
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
