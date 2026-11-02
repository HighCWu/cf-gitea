/**
 * The workflow DISPATCH producer's tests (the ⑲A4 row's service arm —
 * workflow.go:64-199's port): the validation ladder with its
 * upstream messages (the disabled check, the ref resolution arms, the
 * workflow-not-found and has-no-dispatch arms, the light invalid arm), the
 * input processing (boolean coercion, the default fallback, the form-value
 * precedence), the payload shape (the raw ref string verbatim, the
 * stringified inputs, the {}-shaped repository/sender), and the inserted
 * run's skeleton (event/trigger_event workflow_dispatch, the normalized
 * ref, the commit-subject title) with its waiting jobs. The C10 half-stage
 * adds the SCOPED arm's battery (workflow.go:237-268's
 * resolveScopedDispatchContent): the effective-source gate, the source
 * default-branch walk, the opt-out/required disabled check and the run's
 * content-source columns (is_scoped_run / workflow_repo_id /
 * workflow_commit_sha — the first producer of the parity columns).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRuns, repoUnits, repositories, users } from "../../db/schema";
import { ACTION_STATUS_WAITING } from "./model";
import { saveRepoActionsConfig } from "./config";

import { scopedWorkflowSourcesStore } from "./scoped-workflow-sources";
import { dispatchWorkflow, workflowDispatchLocale, type WorkflowDispatchReads } from "./workflow-dispatch";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = ["action_runs", "action_run_jobs", "action_run_attempts", "action_tasks", "action_tasks_versions", "action_scoped_workflow_source", "repo_counters", "repo_units", "repositories", "users"];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const REPO_ID = "repo-dispatch";
const USER_ID = 7;
const T0 = new Date(1_700_000_000 * 1000);
const SHA = "ccccdddddddddddddddddddddddddddddddddddd";

const DISPATCH_WORKFLOW = `name: Greet
on:
  workflow_dispatch:
    inputs:
      greeting:
        description: The greeting
        default: hello
      flag:
        description: The flag
        type: boolean
        default: "true"
jobs:
  build:
    steps: []
`;

const PUSH_ONLY_WORKFLOW = "on: push\njobs:\n  build:\n    steps: []\n";

/** The engine fake — the workflow dir walk + the ref-aware commit read (the
 *  commits map carries the resolvable refs and their subjects; refs/heads/
 *  main resolves by default, any other ref answers null — the miss arm). */
function fakeReads(files: Record<string, string>, commits: Record<string, string> = {}): WorkflowDispatchReads {
  const resolved: Record<string, string> = { "refs/heads/main": "default subject", ...commits };
  const dirNames = new Set(Object.keys(files).map((path) => path.split("/").slice(0, 2).join("/")));
  return {
    readCommit: (id) => {
      const subject = id === undefined ? undefined : resolved[id];
      return subject === undefined
        ? Promise.resolve(null)
        : Promise.resolve({ oid: SHA, subject: subject.split("\n", 1)[0] ?? "" });
    },
    listTree: (_ref, path) =>
      dirNames.has(path ?? "")
        ? Promise.resolve({
            oid: SHA,
            entries: Object.keys(files)
              .filter((p) => p.startsWith(`${path ?? ""}/`))
              .map((p) => ({ name: p.slice((path ?? "").length + 1), type: "blob" })),
          })
        : Promise.resolve(null),
    readBlob: (_ref, path) => {
      const content = files[path];
      return content === undefined
        ? Promise.resolve(null)
        : Promise.resolve({ oid: SHA, mode: "100644", data: new TextEncoder().encode(content) });
    },
  };
}

async function seedRepo(): Promise<void> {
  await db().insert(users).values({ id: USER_ID, username: "alice", usernameLower: "alice", status: "active", createdAt: T0 });
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "alice",
    ownerId: USER_ID,
    slug: "demo",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId: REPO_ID, type: "actions" });
}

function dispatch(reads: WorkflowDispatchReads, patch: Partial<Parameters<typeof dispatchWorkflow>[0]> = {}) {
  return dispatchWorkflow({
    d1: env.DB,
    reads,
    repo: { id: REPO_ID, ownerId: USER_ID, ownerNamespace: "alice", slug: "demo", defaultBranch: "main" },
    workflowId: "ci.yml",
    ref: "refs/heads/main",
    scopedWorkflowSourceRepoId: "",
    sourceEngineFor: () => deadReads(),
    form: {},
    triggerUserId: USER_ID,
    appUrl: "https://test.local",
    ...patch,
  });
}

/** The engine that never resolves — the sourceEngineFor default (the
 *  repo-level arm never calls it; the scoped throw arm proves it). */
function deadReads(): WorkflowDispatchReads {
  return {
    readCommit: () => Promise.resolve(null),
    listTree: () => Promise.resolve(null),
    readBlob: () => Promise.resolve(null),
  };
}

describe("dispatchWorkflow (workflow.go:64-199's repo-level arm, the ⑲A4 producer)", () => {
  beforeEach(seedRepo);

  it("inserts the run with the dispatch skeleton: normalized ref, commit-subject title, event pair, waiting jobs", async () => {
    const outcome = await dispatch(
      fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }, { "refs/heads/main": "Fix the thing\n\nthe body" }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.run.event).toBe("workflow_dispatch");
    expect(outcome.run.triggerEvent).toBe("workflow_dispatch");
    expect(outcome.run.ref).toBe("refs/heads/main"); // the normalized RefName
    expect(outcome.run.title).toBe("Fix the thing"); // MessageTitle
    expect(outcome.run.commitSha).toBe(SHA);
    expect(outcome.run.isForkPullRequest).toBe(false);
    expect(outcome.run.status).toBe(ACTION_STATUS_WAITING);
    // The content-source trio at the repo-level posture (workflow.go:136-137's
    // skeleton: WorkflowRepoID = the repo itself, WorkflowCommitSHA = the run
    // target commit — the two shas stay EQUAL; IsScopedRun false).
    expect(outcome.run.workflowCommitSha).toBe(SHA);
    expect(outcome.run.workflowRepoId).toBe(REPO_ID);
    expect(outcome.run.isScopedRun).toBe(false);
    const jobs = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, outcome.run.id));
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.status).toBe(ACTION_STATUS_WAITING);
    // The persisted row keeps the equal-sha posture (the pin: a repo-level
    // dispatch's workflow_commit_sha = its commit_sha).
    const row = await db().select().from(actionRuns).where(eq(actionRuns.id, outcome.run.id)).get();
    expect(row?.workflowCommitSha).toBe(SHA);
    expect(row?.commitSha).toBe(SHA);
    expect(row?.workflowRepoId).toBe(REPO_ID);
    expect(row?.isScopedRun).toBe(false);
  });

  it("a bare branch ref re-reads as refs/heads/<branch> (workflow.go:113-115's RefNameFromBranch arm); the payload keeps the RAW ref", async () => {
    const outcome = await dispatch(fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }), { ref: "feature" });
    expect(outcome.status).toBe("translatable"); // the fake resolves only refs/heads/main
    if (outcome.status !== "translatable") return;
    expect(outcome.message).toBe(workflowDispatchLocale.targetRefNotExist.replace("%s", "feature"));

    // A resolvable bare branch: readCommit sees refs/heads/feature through
    // the fake's commits map.
    const reads = fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }, { "refs/heads/feature": "branch subject" });
    const ok = await dispatch(reads, { ref: "feature" });
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") return;
    expect(ok.run.ref).toBe("refs/heads/feature");
    const payload = JSON.parse(ok.run.eventPayload) as { ref: string; inputs: Record<string, string> };
    expect(payload.ref).toBe("feature"); // the RAW form string (workflow.go:179)
  });

  it("processes the inputs: booleans coerce, the default fills, the form value wins (view.go:1397-1404 + workflow.go:201-210)", async () => {
    const outcome = await dispatch(fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }), {
      form: { greeting: "hi there", flag: "on" },
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const payload = JSON.parse(outcome.run.eventPayload) as { workflow: string; inputs: Record<string, string>; repository: Record<string, never>; sender: Record<string, never> };
    expect(payload.workflow).toBe("ci.yml");
    expect(payload.inputs.greeting).toBe("hi there");
    expect(payload.inputs.flag).toBe("true"); // the typed bool → CoerceToString
    expect(payload.repository).toEqual({});
    expect(payload.sender).toEqual({});

    // The typed map (the expression surface) carries a REAL boolean.
    const typed = await dispatch(fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }), { form: { flag: "1" } });
    if (typed.status !== "ok") throw new Error("expected ok");
    expect(typed.status).toBe("ok");
    // The empty-form arm: the non-boolean falls back to the declared
    // default; the boolean takes FormBool directly (an absent checkbox is
    // false — the form's checked state carries the default, view.go:1397-1404).
    const defaultForm = await dispatch(fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }));
    if (defaultForm.status !== "ok") throw new Error("expected ok");
    const defaultPayload = JSON.parse(defaultForm.run.eventPayload) as { inputs: Record<string, string> };
    expect(defaultPayload.inputs.greeting).toBe("hello");
    expect(defaultPayload.inputs.flag).toBe("false");
  });

  it("answers the translatable ladder verbatim: not-found, no-dispatch, disabled, invalid", async () => {
    const reads = fakeReads({ ".gitea/workflows/ci.yml": PUSH_ONLY_WORKFLOW });
    // Unknown workflow id.
    const missing = await dispatch(reads, { workflowId: "nope.yml" });
    expect(missing).toEqual({ status: "translatable", message: "Workflow 'nope.yml' not found." });
    // Parsed but no workflow_dispatch declaration.
    const noDispatch = await dispatch(reads);
    expect(noDispatch).toEqual({
      status: "translatable",
      message: "Workflow 'ci.yml' has no workflow_dispatch event trigger.",
    });
    // Disabled via the ActionsConfig store.
    await saveRepoActionsConfig(env.DB, REPO_ID, {
      disabledWorkflows: ["ci.yml"],
      disabledScopedWorkflows: {},
      collaborativeOwnerIds: [],
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      overrideOwnerConfig: false,
    });
    const dispatchReads = fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW });
    const disabled = await dispatch(dispatchReads);
    expect(disabled).toEqual({ status: "translatable", message: workflowDispatchLocale.workflowDisabled });
    // A broken document → the light invalid arm.
    await saveRepoActionsConfig(env.DB, REPO_ID, {
      disabledWorkflows: [],
      disabledScopedWorkflows: {},
      collaborativeOwnerIds: [],
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      overrideOwnerConfig: false,
    });
    const invalid = await dispatch(fakeReads({ ".gitea/workflows/ci.yml": "\t: [broken" }));
    expect(invalid.status).toBe("translatable");
    if (invalid.status === "translatable") {
      expect(invalid.message).toContain("Workflow config file is invalid");
    }
  });

  it("the guards: an empty workflow id or ref throws (the Run handler's ServerError arms); a scoped id without an effective source answers not-found", async () => {
    const reads = fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW });
    expect((await dispatch(reads, { workflowId: "" })).status).toBe("throw");
    expect((await dispatch(reads, { ref: "" })).status).toBe("throw");
    const scoped = await dispatch(reads, { scopedWorkflowSourceRepoId: "src-repo" });
    expect(scoped).toEqual({ status: "translatable", message: "Workflow 'ci.yml' not found." }); // IsScopedWorkflowSourceEffective's miss arm
    // The landed wire: the page's dispatch form always posts "0" — the
    // FormInt64 zero, the REPO-LEVEL arm (scopedSourceRepoParam), so the
    // run dispatches from this repo's own workflow dir.
    const zero = await dispatch(reads, { scopedWorkflowSourceRepoId: "0" });
    expect(zero.status).toBe("ok");
    // A NEGATIVE spelling is repo-level too: upstream parses FormInt64 and
    // arms the scoped branch only when the value is > 0 (workflow.go:79's
    // `isScoped := scopedWorkflowSourceRepoID > 0`) — "-5" dispatches the
    // repo's own workflow dir like the zero arm (the R1-F11 pin).
    const negative = await dispatch(reads, { scopedWorkflowSourceRepoId: "-5" });
    expect(negative.status).toBe("ok");
    if (negative.status === "ok") {
      expect(negative.run.isScopedRun).toBe(false);
      expect(negative.run.workflowRepoId).toBe(REPO_ID); // workflow.go:136 — the repo itself
    }
  });
});

describe("dispatchWorkflow's scoped arm (resolveScopedDispatchContent, workflow.go:237-268 — the C10 half-stage)", () => {
  const SRC_ID = "src-repo";
  const SRC_SHA = "aaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(async () => {
    await seedRepo();
    // the SOURCE repo row (GetRepositoryByID's substrate) — alice/source.
    await db().insert(repositories).values({
      id: SRC_ID,
      storageKey: `r_${SRC_ID}`,
      ownerNamespace: "alice",
      ownerId: USER_ID,
      slug: "source",
      visibility: "public",
    });
  });

  /** The SOURCE engine fake: the scoped-dir walk at the default branch,
   *  resolving to the source's own sha (distinct from the consumer's). */
  function sourceReads(files: Record<string, string>): WorkflowDispatchReads {
    const inner = fakeReads(files);
    return {
      readCommit: async (id) => {
        const row = await inner.readCommit(id);
        return row === null ? null : { oid: SRC_SHA, subject: row.subject };
      },
      listTree: (ref, path) => inner.listTree(ref, path),
      readBlob: (ref, path) => inner.readBlob(ref, path),
    };
  }

  function dispatchScoped(sourceFiles: Record<string, string>, patch: Partial<Parameters<typeof dispatchWorkflow>[0]> = {}) {
    return dispatch(fakeReads({ ".gitea/workflows/ci.yml": DISPATCH_WORKFLOW }), {
      scopedWorkflowSourceRepoId: SRC_ID,
      sourceEngineFor: (fullName) => (fullName === "alice/source" ? sourceReads(sourceFiles) : deadReads()),
      ...patch,
    });
  }

  async function registerSource(ownerId: number, configs: Record<string, { required: boolean; patterns: string[] }> = {}): Promise<void> {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(ownerId, SRC_ID);
    await store.setSourceConfigs(ownerId, SRC_ID, configs);
  }

  it("an effective source dispatches the SOURCE's file: the run records the content source columns (is_scoped_run, workflow_repo_id, workflow_commit_sha)", async () => {
    await registerSource(0); // instance-level
    const outcome = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": DISPATCH_WORKFLOW });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.run.isScopedRun).toBe(true); // workflow.go:262's IsScopedRun
    expect(outcome.run.workflowRepoId).toBe(SRC_ID); // :260's WorkflowRepoID = sourceRepo.ID
    expect(outcome.run.workflowCommitSha).toBe(SRC_SHA); // :261's WorkflowCommitSHA = the source HEAD
    expect(outcome.run.repoId).toBe(REPO_ID); // the run lives in the CONSUMER repo
    expect(outcome.run.commitSha).toBe(SHA); // ... at the consumer's commit
    expect(outcome.run.title).toBe("default subject"); // Title = the CONSUMER commit's MessageTitle
    const row = await db().select().from(actionRuns).where(eq(actionRuns.id, outcome.run.id)).get();
    expect(row?.isScopedRun).toBe(true); // the post-insert UPDATE persisted it
    expect(row?.workflowRepoId).toBe(SRC_ID);
    expect(row?.workflowCommitSha).toBe(SRC_SHA); // the insert's workflowSha input persisted it
    const jobs = await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, outcome.run.id));
    expect(jobs.length).toBe(1);
  });

  it("the insert-time github context splits the shas: workflow_sha carries the SOURCE commit while sha keeps the consumer's (context.go:115)", async () => {
    await registerSource(0); // instance-level
    // run-name interpolates the two context fields at insert (the E2 pass
    // reads the exact github context the residual was recorded against).
    const content = `run-name: "\${{ github.workflow_sha }} \${{ github.sha }}"
on:
  workflow_dispatch:
jobs:
  build:
    steps: []
`;
    const outcome = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": content });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.run.title).toBe(`${SRC_SHA} ${SHA}`); // workflow_sha = the SOURCE HEAD, sha = the CONSUMER commit
    expect(outcome.run.commitSha).toBe(SHA);
    expect(outcome.run.workflowCommitSha).toBe(SRC_SHA);
  });

  it("an OWNER-level registration is equally effective; the workflow entry must exist on the source's default branch", async () => {
    await registerSource(USER_ID); // the consumer owner's own scope
    const ok = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": DISPATCH_WORKFLOW });
    expect(ok.status).toBe("ok");

    const missing = await dispatchScoped({ ".gitea/scoped_workflows/other.yml": DISPATCH_WORKFLOW });
    expect(missing).toEqual({ status: "translatable", message: "Workflow 'ci.yml' not found." }); // :260-267's not-found
  });

  it("the opt-out check: a flagged consumer's dispatch answers disabled; a REQUIRED workflow dispatches anyway (workflow.go:84-99)", async () => {
    await registerSource(0);
    await saveRepoActionsConfig(env.DB, REPO_ID, {
      disabledWorkflows: [],
      disabledScopedWorkflows: { [SRC_ID]: ["ci.yml"] },
      collaborativeOwnerIds: [],
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      overrideOwnerConfig: false,
    });
    const optedOut = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": DISPATCH_WORKFLOW });
    expect(optedOut).toEqual({ status: "translatable", message: workflowDispatchLocale.workflowDisabled });

    // required in the registration → the opt-out is dead (ScopedWorkflowOptedOut)
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SRC_ID, { "ci.yml": { required: true, patterns: ["*"] } });
    const required = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": DISPATCH_WORKFLOW });
    expect(required.status).toBe("ok");
  });

  it("the store/engine failure arms: a registration without a repo row throws (GetRepositoryByID); an unresolvable source HEAD throws (GetBranchExisting)", async () => {
    await registerSource(0); // the registration exists...
    await db().delete(repositories).where(eq(repositories.id, SRC_ID)); // ...but the repositories row does not
    const noRow = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": DISPATCH_WORKFLOW });
    expect(noRow).toEqual({ status: "throw", reason: `workflow dispatch: GetRepositoryByID ${SRC_ID} failed` });

    await db().insert(repositories).values({
      id: "src-empty",
      storageKey: "r_src-empty",
      ownerNamespace: "alice",
      ownerId: USER_ID,
      slug: "empty",
      visibility: "public",
    });
    await scopedWorkflowSourcesStore(env.DB).addSource(0, "src-empty");
    const noHead = await dispatch(fakeReads({}), {
      scopedWorkflowSourceRepoId: "src-empty",
      sourceEngineFor: () => deadReads(),
    });
    expect(noHead).toEqual({ status: "throw", reason: "workflow dispatch: source default branch src-empty@refs/heads/main unresolvable" });
  });

  it("the source file's own validation rides the shared ladder (invalid / no-dispatch on the SOURCE content)", async () => {
    await registerSource(0);
    const invalid = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": "\t: [broken" });
    expect(invalid.status).toBe("translatable");
    if (invalid.status === "translatable") expect(invalid.message).toContain("Workflow config file is invalid");
    const noDispatch = await dispatchScoped({ ".gitea/scoped_workflows/ci.yml": PUSH_ONLY_WORKFLOW });
    expect(noDispatch).toEqual({
      status: "translatable",
      message: "Workflow 'ci.yml' has no workflow_dispatch event trigger.",
    });
  });
});
