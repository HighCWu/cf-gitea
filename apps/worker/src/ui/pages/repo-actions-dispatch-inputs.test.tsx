/**
 * The workflow-dispatch-inputs aux fragment's tests (the F-row tail GET #4
 * — the module header's upstream pins): the ref arms (empty → 404, junk
 * prefix → the ServerError class, a full refs/heads|tags name resolved by
 * the engine), the workflow-location arms (absent id → the not-found
 * message, present-but-no-dispatch → the has_no message), the light
 * validation's ErrMsg arms (invalid YAML, jobs-not-a-mapping, all-needs,
 * all-null-jobs), the act model's dispatch-config shapes (sequence/scalar/
 * mapping/null), the declaration-order inputs, and the template render's
 * field arms (choice/boolean/number/string + required + the submit button).
 * Module-loader tests (the pre-mount house pattern) over a stubbed engine
 * read slice.
 */

import { describe, expect, it } from "vitest";

import {
  loadWorkflowDispatchInputsFragment,
  parseWorkflowDispatchInputs,
  renderWorkflowDispatchInputsFragment,
  workflowDispatchInputsLocale,
  type DispatchInputsReads,
} from "./repo-actions-dispatch-inputs";

const REPO = { id: "repo-demo", ownerNamespace: "alice", slug: "demo", defaultBranch: "main" };

/** The stringContaining escape hatch (the routes.test.ts precedent — the
 *  vitest asymmetric-matcher factories return `any`). */
const containing = (text: string): unknown => expect.stringContaining(text);

/** The engine stub over one workflow dir. */
function stubEngine(opts: {
  dir?: string;
  entries?: Array<{ name: string; type: string }>;
  commitExists?: boolean;
  content?: string;
}): DispatchInputsReads & { readRefs: string[] } {
  const readRefs: string[] = [];
  return {
    readRefs,
    readCommit: (id?: string) => {
      readRefs.push(id ?? "HEAD");
      return Promise.resolve(opts.commitExists === false ? null : { oid: id ?? "c".repeat(40) });
    },
    listTree: (_ref?: string, path?: string) =>
      Promise.resolve(
        opts.dir === undefined || path !== opts.dir
          ? null
          : { oid: "tree0", entries: opts.entries ?? [] },
      ),
    readBlob: (_ref: string | undefined, path: string) => {
      void path;
      return Promise.resolve(
        opts.content === undefined ? null : { oid: "blob0", mode: "100644", data: new TextEncoder().encode(opts.content) },
      );
    },
  };
}

const DISPATCH_WORKFLOW = `name: ci
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: "Target environment"
        required: true
        default: "staging"
        type: "choice"
        options:
          - staging
          - production
      dry_run:
        description: "Skip side effects"
        default: "true"
        type: boolean
      threads:
        description: "Worker count"
        default: "4"
        type: number
      note:
        required: false
jobs:
  build:
    steps:
      - run: echo hi
`;

// --- the parse (actionslib WorkflowDispatchConfig/Inputs over the yaml pkg) ---

describe("parseWorkflowDispatchInputs (workflow.go:105-178's shapes)", () => {
  it("lists the inputs in DECLARATION order with the declared fields", () => {
    const parsed = parseWorkflowDispatchInputs(DISPATCH_WORKFLOW);
    expect(parsed.errMsg).toBeNull();
    expect(parsed.dispatch?.inputs.map((i) => i.name)).toEqual(["environment", "dry_run", "threads", "note"]);
    const [environment, dryRun, threads, note] = parsed.dispatch?.inputs ?? [];
    expect(environment).toMatchObject({ required: true, default: "staging", type: "choice", options: ["staging", "production"] });
    expect(dryRun).toMatchObject({ default: "true", type: "boolean" });
    expect(threads).toMatchObject({ default: "4", type: "number" });
    expect(note).toMatchObject({ required: false, default: "", type: "" });
  });

  it("reads a sequence/scalar on: listing (a config with NO inputs)", () => {
    expect(parseWorkflowDispatchInputs("on: [push, workflow_dispatch]\njobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toEqual({ inputs: [] });
    expect(parseWorkflowDispatchInputs("on: workflow_dispatch\njobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toEqual({ inputs: [] });
    expect(parseWorkflowDispatchInputs("on: [push]\njobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toBeNull();
    expect(parseWorkflowDispatchInputs("jobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toBeNull();
  });

  it("treats a non-mapping dispatch entry as the decode failure (no config)", () => {
    expect(parseWorkflowDispatchInputs("on:\n  workflow_dispatch: [nope]\njobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toBeNull();
    // The empty mapping (and a null inputs value) is a config with NO inputs.
    expect(parseWorkflowDispatchInputs("on:\n  workflow_dispatch: {}\njobs:\n  a:\n    steps: [{run: x}]\n").dispatch).toEqual({ inputs: [] });
  });

  it("carries the light-validation ErrMsg arms", () => {
    const broken = parseWorkflowDispatchInputs(":::: not yaml [[[");
    expect(broken.errMsg).toContain("Workflow config file is invalid");
    const noJobs = parseWorkflowDispatchInputs("on: workflow_dispatch\n");
    expect(noJobs.errMsg).toContain("jobs is not a mapping");
    const allNeeds = parseWorkflowDispatchInputs(
      "on: workflow_dispatch\njobs:\n  b:\n    needs: a\n    steps: [{run: x}]\n  a:\n    needs: b\n    steps: [{run: x}]\n",
    );
    expect(allNeeds.errMsg).toBe(workflowDispatchInputsLocale.noJobWithoutNeeds);
    const allNull = parseWorkflowDispatchInputs("on: workflow_dispatch\njobs:\n  a:\n  b:\n");
    expect(allNull.errMsg).toBe(workflowDispatchInputsLocale.noJob);
  });
});

// --- the fragment render (workflow_dispatch_inputs.tmpl) ----------------------

describe("renderWorkflowDispatchInputsFragment", () => {
  it("renders the four field arms + required marks + the submit button", () => {
    const parsed = parseWorkflowDispatchInputs(DISPATCH_WORKFLOW);
    const html = renderWorkflowDispatchInputsFragment({
      curWorkflow: "ci.yml",
      errMsg: null,
      curWorkflowExists: true,
      dispatch: parsed.dispatch,
    });
    expect(html).toContain('id="runWorkflowDispatchModalInputs"');
    expect(html).toContain('<div class="ui field required">');
    // choice → the select with the selected default option (hono renders
    // boolean attributes as the bare `=""` form)
    expect(html).toContain('<select class="ui search selection dropdown" name="environment">');
    expect(html).toContain('<option value="staging" selected="">');
    // boolean → the checkbox, checked on the exact "true" default
    expect(html).toContain('<input type="checkbox" name="dry_run" checked=""/>');
    // number → type=number step=any (the optional field carries no mark)
    expect(html).toContain('<input type="number" step="any" name="threads" value="4"/>');
    // string (no type) → the plain input, the optional field without the mark
    expect(html).toContain('<input name="note" value=""/>');
    // the labels prefer the description
    expect(html).toContain("Target environment:");
    // the submit field (autofocus rides the boolean-attribute form too)
    expect(html).toContain('<button class="ui tiny primary button" autofocus="" type="submit">');
    expect(html).toContain(workflowDispatchInputsLocale.run);
  });

  it("renders the not-found / has-no-dispatch error arms and the ErrMsg alert", () => {
    const missing = renderWorkflowDispatchInputsFragment({
      curWorkflow: "gone.yml",
      errMsg: null,
      curWorkflowExists: false,
      dispatch: null,
    });
    expect(missing).toContain("Workflow &#39;gone.yml&#39; not found.");

    const noDispatch = renderWorkflowDispatchInputsFragment({
      curWorkflow: "ci.yml",
      errMsg: null,
      curWorkflowExists: true,
      dispatch: null,
    });
    expect(noDispatch).toContain("has no workflow_dispatch event trigger");

    const invalid = renderWorkflowDispatchInputsFragment({
      curWorkflow: "ci.yml",
      errMsg: "Workflow config file is invalid. Please check your config file: bad",
      curWorkflowExists: true,
      dispatch: null,
    });
    expect(invalid).toContain("tw-text-red");
    expect(invalid).toContain("octicon-alert");
    expect(invalid).toContain("Please check your config file");
  });
});

// --- the loader (WorkflowDispatchInputs + prepare*Template) --------------------

describe("loadWorkflowDispatchInputsFragment (actions.go:173-204)", () => {
  const base = { repo: REPO };

  it("404s an empty ref and the scoped-source arm's v1 reduction", async () => {
    await expect(loadWorkflowDispatchInputsFragment({ ...base, reads: stubEngine({}), ref: "", workflow: "ci.yml", scopedWorkflowSourceRepoId: 0 }))
      .resolves.toEqual({ status: "not-found" });
    await expect(
      loadWorkflowDispatchInputsFragment({ ...base, reads: stubEngine({}), ref: "refs/heads/main", workflow: "ci.yml", scopedWorkflowSourceRepoId: 7 }),
    ).resolves.toEqual({ status: "not-found" });
  });

  it("throws on a non-full-ref shape and an unresolvable ref (the ServerError arms)", async () => {
    await expect(
      loadWorkflowDispatchInputsFragment({ ...base, reads: stubEngine({}), ref: "main", workflow: "ci.yml", scopedWorkflowSourceRepoId: 0 }),
    ).resolves.toMatchObject({ status: "throw", reason: containing("UnsupportedRefType") });
    await expect(
      loadWorkflowDispatchInputsFragment({
        ...base,
        reads: stubEngine({ commitExists: false }),
        ref: "refs/heads/vanished",
        workflow: "ci.yml",
        scopedWorkflowSourceRepoId: 0,
      }),
    ).resolves.toMatchObject({ status: "throw", reason: containing("GetTagCommit/GetBranchCommit") });
  });

  it("serves the inputs fragment for a dispatchable workflow at the ref", async () => {
    const engine = stubEngine({ dir: ".gitea/workflows", entries: [{ name: "ci.yml", type: "blob" }], content: DISPATCH_WORKFLOW });
    const outcome = await loadWorkflowDispatchInputsFragment({
      ...base,
      reads: engine,
      ref: "refs/heads/main",
      workflow: "ci.yml",
      scopedWorkflowSourceRepoId: 0,
    });
    expect(engine.readRefs).toEqual(["refs/heads/main"]);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.html).toContain('id="runWorkflowDispatchModalInputs"');
    expect(outcome.html).toContain('name="environment"');
  });

  it("renders the not-found message for a workflow absent from the listed set", async () => {
    const engine = stubEngine({ dir: ".gitea/workflows", entries: [{ name: "other.yml", type: "blob" }], content: DISPATCH_WORKFLOW });
    const outcome = await loadWorkflowDispatchInputsFragment({
      ...base,
      reads: engine,
      ref: "refs/heads/main",
      workflow: "ci.yml",
      scopedWorkflowSourceRepoId: 0,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.html).toContain(`Workflow &#39;ci.yml&#39; not found.`);
  });

  it("renders the has-no-dispatch message for a workflow without the trigger", async () => {
    const engine = stubEngine({
      dir: ".github/workflows",
      entries: [{ name: "plain.yml", type: "blob" }],
      content: "on: [push]\njobs:\n  a:\n    steps: [{run: x}]\n",
    });
    const outcome = await loadWorkflowDispatchInputsFragment({
      ...base,
      reads: engine,
      ref: "refs/tags/v1.0.0",
      workflow: "plain.yml",
      scopedWorkflowSourceRepoId: 0,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.html).toContain("has no workflow_dispatch event trigger");
  });

  it("serves the ErrMsg alert for an invalid current workflow", async () => {
    const engine = stubEngine({
      dir: ".gitea/workflows",
      entries: [{ name: "broken.yml", type: "blob" }],
      content: ":::: not yaml [[[",
    });
    const outcome = await loadWorkflowDispatchInputsFragment({
      ...base,
      reads: engine,
      ref: "refs/heads/main",
      workflow: "broken.yml",
      scopedWorkflowSourceRepoId: 0,
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.html).toContain("octicon-alert");
  });
});
