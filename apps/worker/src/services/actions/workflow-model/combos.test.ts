// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The combo suite — the port of the submodule's jobparser tests over the
// pin fc493688, with the copied testdata/ (jobparser/testdata, 1:1):
//
//   - TestParse's nine testdata rows: the fixtures ride 1:1; the comparison
//     adapts from go-yaml's encoder bytes to a semantic deep-equal over the
//     same documents — the payload bytes are the module's documented
//     deviation (the `yaml` package re-serialization, "byte identity is not
//     load-bearing", trigger.ts's platform-adaptation header). The two
//     null_job rows ride as the invalid-jobs rejection.
//   - TestParseDefersDynamicMatrix, TestParseWholeValueExpressions (its
//     runner-view arm over the raw interpeter), TestParseJobNames,
//     TestJobFieldsWithoutMatrix, TestExpandMatrixWithNeeds,
//     TestRejectsUnevaluatedMatrixFilters and
//     TestParseRawSingleWorkflowRoundTripsDeferredPlaceholder — row-for-row.
//   - The implementation-derived block (no upstream fixtures) pins the
//     strategy reads, the escapes, the runs-on table and the cap.
//
// TestParseInterpolatesRunName stays with the trigger suite (the E2
// interpolation is wired at the insert call-site there, trigger.test.ts).

import { Document, type Node as YamlNode, parseAllDocuments, Scalar, type YAMLMap } from "yaml";
import { describe, expect, it } from "vitest";

import { evaluateYamlNode, Evaluator } from "../expression-eval/evaluator";
import { newInterpeter } from "../expression-eval/interpreter";
import {
  buildMatrixCombosInto,
  encodeMatrix,
  expandMatrixWithNeeds,
  maxParallelOfCombo,
  marshalComboPayload,
  parseRawSingleWorkflow,
  parseWorkflowCombos,
  resolveStrategy,
  type WorkflowJobCombo,
} from "./combos";
import {
  decodeJobModel,
  escapeExpressions,
  getContinueOnError,
  hasDeferredMatrix,
  jobNeeds,
  newJobEvaluatorFromStrategy,
  jobRunsOn,
  parseStrategyNode,
  replaceScalars,
  runsOnFromNode,
  runsOnProblem,
  strategyFailFast,
  strategyMaxParallel,
  unescapeExpressions,
  type JobModel,
} from "./job";
import { matrixCombinations, matrixOf } from "./matrix";
import type { MatrixNode } from "./yaml-nodes";
import { parseWorkflowDocument } from "./yaml-nodes";

/** ReadTestdata (testdata_test.go) — workerd reads no filesystem, so the
 *  fixtures ride Vite's raw glob (the corpus.test.ts pattern). */
const TESTDATA = import.meta.glob("./testdata/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
});

function readTestdata(name: string): string {
  const text = TESTDATA[`./testdata/${name}`];
  if (text === undefined) {
    throw new Error(`testdata ${name} not found`);
  }
  return text;
}

/** The server-planning parse (Parse with a git context). */
function parse(content: string, vars: Record<string, string> = {}): WorkflowJobCombo[] {
  const { combos, error } = parseWorkflowCombos(content, { gitContext: {}, vars, inputs: undefined });
  expect(error).toBeNull();
  return combos;
}

/** The semantic payload shape the testdata .out documents carry. */
function payloadShapes(combos: WorkflowJobCombo[]): unknown[] {
  return combos.map((combo) => {
    expect(combo.payload).not.toBeNull();
    return parseDocumentOf(new TextDecoder().decode(combo.payload!));
  });
}

function parseDocumentOf(text: string): unknown {
  const docs = parseAllDocuments(text);
  const first = docs[0]!;
  expect(first.errors).toEqual([]);
  return first.toJS();
}

function expectedShapes(outYaml: string): unknown[] {
  return parseAllDocuments(outYaml).map((doc) => {
    expect(doc.errors).toEqual([]);
    return doc.toJS() as unknown;
  });
}

/** yamlScalar builds one plain scalar node. */
function yamlScalar(value: string): YamlNode {
  const scalar = new Scalar(value);
  scalar.type = "PLAIN";
  return scalar;
}

/** strategySlotOf re-wraps a strategy model as the model reads' slot. */
function strategySlotOf(job: { strategy: JobModel["strategy"] }): MatrixNode {
  return { present: job.strategy.node !== undefined, node: job.strategy.node! };
}

const STRATEGY_MODEL = (over: Partial<JobModel["strategy"]>): JobModel["strategy"] => ({
  failFastString: "",
  maxParallelString: "",
  rawMatrix: undefined,
  jobIndex: 0,
  jobTotal: 0,
  rawExpression: undefined,
  node: undefined,
  ...over,
});

describe("TestParse (the testdata rows, compared semantically)", () => {
  for (const name of [
    "multiple_jobs",
    "multiple_matrix",
    "has_needs",
    "has_with",
    "has_secrets",
    "empty_step",
    "job_name_with_matrix",
    "prefixed_newline",
    "continue_on_error_expr",
  ]) {
    it(name, () => {
      const combos = parse(readTestdata(`${name}.in.yaml`));
      const got = payloadShapes(combos);
      const want = expectedShapes(readTestdata(`${name}.out.yaml`));
      expect(combos.length).toBeGreaterThan(0);
      expect(got).toEqual(want);
      for (const combo of combos) {
        expect(combo.jobId).not.toBe("");
      }
    });
  }

  for (const name of ["null_job_implicit", "null_job_explicit"]) {
    it(`${name} errors (the invalid-jobs rejection)`, () => {
      const { error } = parseWorkflowCombos(readTestdata(`${name}.in.yaml`), { gitContext: {}, vars: {}, inputs: undefined });
      expect(error).not.toBeNull();
    });
  }
});

describe("TestParseDefersDynamicMatrix (row-for-row)", () => {
  const workflow = (needs: string, strategy: string): string => `
on: push
jobs:
  setup:
    steps: [{run: echo}]
  build:
    ${needs}
    ${strategy}
    steps: [{run: echo}]
`;
  const expr = (text: string): string => "${{ " + text + " }}"; // template-literal-safe expression text
  const seq = (text: string): string => '["${{ ' + text + ' }}"]';

  for (const tt of [
    { name: "needs outputs", needs: "needs: setup", strategy: `strategy:\n      matrix:\n        os: [a, b]\n        version: ${expr("fromJson(needs.setup.outputs.v)")}`, deferred: true, want: 1 },
    { name: "static", needs: "needs: setup", strategy: "strategy:\n      matrix: {os: [a, b], version: [1, 2]}", deferred: false, want: 4 },
    { name: "max-parallel over needs outputs", needs: "needs: setup", strategy: `strategy:\n      max-parallel: ${expr("needs.setup.outputs.limit")}\n      matrix: {os: [a, b], version: [1, 2]}`, deferred: true, want: 1 },
    { name: "fail-fast without matrix", needs: "needs: setup", strategy: `strategy:\n      fail-fast: ${expr("needs.setup.outputs.fast")}`, deferred: true, want: 1 },
    { name: "whole strategy without matrix", needs: "needs: setup", strategy: `strategy: ${expr("fromJSON(needs.setup.outputs.strategy)")}`, deferred: true, want: 1 },
    { name: "expression without needs", needs: "", strategy: `strategy:\n      matrix:\n        os: [a, b]\n        version: ["${expr("github.sha")}"]`, deferred: false, want: 2 },
    { name: "expression over another context", needs: "needs: setup", strategy: `strategy:\n      matrix:\n        os: [a, b]\n        version: ["${expr("github.sha")}"]`, deferred: false, want: 2 },
    { name: "needs inside a string literal", needs: "needs: setup", strategy: `strategy:\n      matrix:\n        os: [a, b]\n        version: ${seq("format('needs.setup.outputs.v {0}', github.sha)")}`, deferred: false, want: 2 },
    { name: "vars", needs: "needs: setup", strategy: `strategy:\n      matrix:\n        os: [a, b]\n        version: ${expr("fromJSON(vars.VERSIONS)")}`, deferred: false, want: 4 },
  ]) {
    it(tt.name, () => {
      const combos = parse(workflow(tt.needs, tt.strategy), { VERSIONS: "[1, 2]" });
      const builds = combos.filter((combo) => combo.jobId === "build");
      expect(builds.length).toBe(tt.want);
      expect(hasDeferredMatrix(builds[0]!.job)).toBe(tt.deferred);
    });
  }
});

describe("TestParseWholeValueExpressions", () => {
  const EXPR_PREFIX = "${{";
  const workflow = (needs: string, source: string): string => [
    "on: push",
    "env: ${{ fromJSON(vars.ENV) }}",
    "jobs:",
    "  setup:",
    "    runs-on: ubuntu-latest",
    "    steps: [{run: echo}]",
    "  build:",
    ...(needs ? [`    ${needs}`] : []),
    "    runs-on: " + EXPR_PREFIX + " matrix.os }}",
    "    strategy: " + EXPR_PREFIX + ` fromJSON(${source}) }}`,
    "    services: " + EXPR_PREFIX + " fromJSON(vars.SERVICES) }}",
    "    defaults:",
    "      run: " + EXPR_PREFIX + " fromJSON(vars.DEFAULTS) }}",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with: " + EXPR_PREFIX + " fromJSON(vars.WITH) }}",
  ].join("\n");

  const strategy = `{"max-parallel": 1, "matrix": {"os": ["a", "b-${"$"}{{ secrets.X }}"]}}`;
  const OS = ["a", "b-" + "${$".replace("$", "$") + "{{ secrets.X }}"];
  void OS;

  /** runnerView — the runner-side read-back (the raw interpeter with the
   *  secrets context the server never has). */
  const runnerView = (job: JobModel): unknown[] => {
    const runner = new Evaluator((input, dsc) => newInterpeter({ secrets: { X: "leaked" } }, {}).evaluate(input, dsc));
    const strategyNode = job.strategy.rawMatrix!;
    const evaluatedMatrix = evaluateYamlNode(runner, strategyNode);
    expect(evaluatedMatrix.error).toBeNull();
    if (evaluatedMatrix.replacement !== null) {
      job.strategy.rawMatrix = evaluatedMatrix.replacement;
    }
    const runsOn = job.rawRunsOn!;
    const evaluatedRunsOn = evaluateYamlNode(runner, runsOn);
    expect(evaluatedRunsOn.error).toBeNull();
    if (evaluatedRunsOn.replacement !== null) {
      job.rawRunsOn = evaluatedRunsOn.replacement;
    }
    const parsed = matrixOf(strategySlotOf(job), job.strategy.rawMatrix);
    const matrixes = parsed === null ? [{}] : matrixCombinations(strategySlotOf(job), job.strategy.rawMatrix).map((c) => c.values);
    const name = runner.interpolate(job.name);
    expect(name.error).toBeNull();
    return [matrixes[0]!["os"], name.value, runsOnFromNode(job.rawRunsOn)];
  };

  const payloads = (needs: string, source: string, vars: Record<string, string>): string[] => {
    const combos = parse(workflow(needs, source), vars);
    return combos
      .filter((combo) => combo.jobId === "build")
      .map((combo) => new TextDecoder().decode(combo.payload!));
  };

  const planning = { STRATEGY: strategy };
  const osArm = (index: number): string => ["a", "b-${{ secrets.X }}"][index]!;

  it("plans two evaluated combos the runner reads back", () => {
    const planned = payloads("", "vars.STRATEGY", planning);
    expect(planned.length).toBe(2);
    for (const raw of ['max-parallel: "1"', "env: ${{ fromJSON(vars.ENV) }}", "services: ${{ fromJSON(vars.SERVICES) }}", "run: ${{ fromJSON(vars.DEFAULTS) }}", "with: ${{ fromJSON(vars.WITH) }}"]) {
      expect(planned[0]).toContain(raw);
    }
    for (let index = 0; index < planned.length; index++) {
      const os = osArm(index);
      const { job } = parseRawSingleWorkflow(planned[index]!);
      expect(runnerView(job)).toEqual([os, `build (${os})`, [os]]);
      const reparsed = parseWorkflowCombos(planned[index]!, { gitContext: {}, vars: {}, inputs: undefined });
      expect(reparsed.error).toBeNull();
      expect(reparsed.combos.length).toBe(1);
    }
  });

  it("a nil git context defers to one placeholder", () => {
    const { combos, error } = parseWorkflowCombos(workflow("", "vars.STRATEGY"), { gitContext: undefined, vars: planning, inputs: undefined });
    expect(error).toBeNull();
    expect(combos.filter((c) => c.jobId === "build").length).toBe(1);
  });

  it("the deferred arm expands over the needs outputs", () => {
    const deferred = payloads("needs: setup", "needs.setup.outputs.strategy", planning);
    expect(deferred.length).toBe(1);
    const { job: placeholder } = parseRawSingleWorkflow(deferred[0]!);
    const expanded = expandMatrixWithNeeds({
      jobId: "build",
      job: placeholder,
      gitContext: {},
      results: {
        build: { needs: ["setup"] },
        setup: { result: "success", outputs: { strategy } },
      },
      vars: undefined,
      inputs: undefined,
      maxCombinations: 256,
    });
    expect(expanded.error).toBeNull();
    expect(expanded.combos.length).toBe(2);
    expect(expanded.combos[0]!.job.strategy.maxParallelString).toBe("1");
    const second = expandSecondWithPayload(deferred[0]!, expanded.combos[1]!.job);
    expect([unescapeExpressions(expanded.combos[1]!.job.name), jobRunsOn(expanded.combos[1]!.job)]).toEqual([
      "build (" + osArm(1) + ")",
      [osArm(1)],
    ]);
    void second;
  });

  /** expandSecondWithPayload marshals the expanded combo over the stored
   *  header (matrix.go's applyCombo) and reads it back through the runner
   *  view — the round-trip the Go test rides. */
  function expandSecondWithPayload(storedPayload: string, combo: JobModel): unknown {
    const { header } = parseRawSingleWorkflow(storedPayload);
    const payload = new TextDecoder().decode(marshalComboPayload(header, combo, { eraseNeeds: true }));
    const { job } = parseRawSingleWorkflow(payload);
    return runnerView(job);
  }

  it("a scalar strategy output rejects", () => {
    const { error } = parseWorkflowCombos(workflow("", "vars.STRATEGY"), {
      gitContext: {},
      vars: { STRATEGY: `"a"` },
      inputs: undefined,
    });
    expect(error?.message).toContain("is not a map of strategy keys to values");
  });
});

describe("TestParseJobNames", () => {
  it("names trim, fold, and suffix like github.com", () => {
    const D = "${{";
    const result = parse(
      [
        "on: push",
        "jobs:",
        "  scalars:",
        "    strategy: {matrix: {value: [[1.0, true, false, 0, 1000000000000000, '', null, {os: linux}], ['', null]]}}",
        "    steps: [{run: echo}]",
        "  trimmed:",
        "    name: '  Trimmed  '",
        "    strategy: {matrix: {v: [a]}}",
        "    steps: [{run: echo}]",
        "  blank:",
        "    name: '   '",
        "    steps: [{run: echo}]",
        "  folded:",
        `    name: "${D} ' Folded' }}"`,
        "    strategy: {matrix: {v: [a]}}",
        "    steps: [{run: echo}]",
        "  computed:",
        `    name: ${D} format('  {0}  ', matrix.missing) }}`,
        "    strategy: {matrix: {v: [a]}}",
        "    steps: [{run: echo}]",
        "  padded:",
        `    name: ${D} format('  {0}  ', matrix.v) }}`,
        "    strategy: {matrix: {v: [a]}}",
        "    steps: [{run: echo}]",
      ].join("\n"),
    );
    const names: Record<string, string[]> = {};
    for (const combo of result) {
      names[combo.jobId] = names[combo.jobId] ?? [];
      // DisplayName: the unescaped stored name (ellipsis is a no-op here)
      names[combo.jobId]!.push(unescapeExpressions(combo.job.name));
    }
    expect(names).toEqual({
      scalars: ["scalars", "scalars (1, true, false, 0, 1E+15, linux)"],
      trimmed: ["Trimmed (a)"],
      blank: ["blank"],
      folded: [" Folded (a)"],
      computed: ["computed"],
      padded: ["a"],
    });
  });
});

describe("TestJobFieldsWithoutMatrix", () => {
  const D = "${{";
  const workflow = [
    "on: push",
    "jobs:",
    "  seed:",
    "    steps: [{run: echo}]",
    "  build:",
    `    name: build-${D} github.ref_name }}`,
    `    continue-on-error: ${D} fromJSON(vars.CONTINUE) }}`,
    "    steps: [{run: echo}]",
    "  target:",
    "    needs: seed",
    `    name: target-${D} needs.seed.outputs.runner }}`,
    `    runs-on: ${D} needs.seed.outputs.runner }}`,
    `    continue-on-error: ${D} needs.seed.outputs.tolerate == 'true' }}`,
    `    strategy: ${D} fromJSON(needs.seed.outputs.strategy) }}`,
    "    steps: [{run: echo}]",
  ].join("\n");

  const parseWith = (continueOnError: string): Map<string, WorkflowJobCombo> => {
    const { combos, error } = parseWorkflowCombos(workflow, {
      gitContext: { ref_name: "main" }, // &model.GithubContext{RefName: "main"}
      vars: { CONTINUE: continueOnError },
      inputs: undefined,
    });
    expect(error).toBeNull();
    return new Map(combos.map((combo) => [combo.jobId, combo]));
  };

  it("build interpolates name and continue-on-error", () => {
    const workflows = parseWith("true");
    const build = workflows.get("build")!;
    expect([build.job.name, getContinueOnError(build.job.rawContinueOnError)]).toEqual(["build-main", true]);
    const payload = new TextDecoder().decode(parseWith(`"${D} true }}"`).get("build")!.payload!);
    expect(payload).toContain("${{ '$' }}{{ true }}");
  });

  it("target defers, then expands over the completed needs", () => {
    const workflows = parseWith("true");
    const placeholder = workflows.get("target")!;
    expect(hasDeferredMatrix(placeholder.job)).toBe(true);
    const expanded = expandMatrixWithNeeds({
      jobId: "target",
      job: placeholder.job,
      gitContext: {},
      results: {
        target: { needs: ["seed"] },
        seed: { result: "success", outputs: { runner: "ubuntu-latest", tolerate: "true", strategy: `{"fail-fast":false,"max-parallel":3}` } },
      },
      vars: undefined,
      inputs: undefined,
      maxCombinations: 256,
    });
    expect(expanded.error).toBeNull();
    expect(expanded.combos.length).toBe(1);
    const combo = expanded.combos[0]!.job;
    expect([
      unescapeExpressions(combo.name),
      runsOnFromNode(combo.rawRunsOn),
      getContinueOnError(combo.rawContinueOnError),
      combo.strategy.maxParallelString,
    ]).toEqual(["target-ubuntu-latest", ["ubuntu-latest"], true, "3"]);
  });
});

describe("TestExpandMatrixWithNeeds", () => {
  /** expandMax — matrixYAML is the YAML value of the `matrix:` key, so a
   *  case can replace the whole node (jobparser_test.go:408-426). */
  const expandMax = (matrixYaml: string, maxCombinations: number) => {
    // the Go test unmarshals "matrix:"+matrixYAML straight into a Strategy
    const { doc } = parseWorkflowDocument("matrix:" + matrixYaml);
    const strategyNode = doc.contents as YamlNode;
    const job: JobModel = {
      id: "build",
      name: "build",
      rawNeeds: yamlScalar("setup"),
      rawRunsOn: yamlScalar("${{ matrix.os || 'ubuntu-latest' }}"),
      rawIf: "",
      rawContinueOnError: undefined,
      strategy: parseStrategyNode(strategyNode),
      rawConcurrency: undefined,
      uses: "",
      node: strategyNode as YAMLMap,
    };
    return expandMatrixWithNeeds({
      jobId: "build",
      job,
      gitContext: {},
      results: {
        build: { needs: ["setup"] },
        setup: {
          result: "success",
          outputs: {
            versions: `["1.20", "1.21"]`,
            os: `["linux", "darwin"]`,
            include: `[{"os":"linux","fast":true},{"os":"windows","fast":false}]`,
            empty: "[]",
            limit: "3",
          },
        },
      },
      vars: undefined,
      inputs: undefined,
      maxCombinations,
    });
  };
  const expand = (matrixYaml: string) => expandMax(matrixYaml, 256);

  it("expands the product and interpolates runs-on", () => {
    const got = expand("\n  os: ${{ fromJson(needs.setup.outputs.os) }}\n  version: ${{ fromJson(needs.setup.outputs.versions) }}\nmax-parallel: ${{ needs.setup.outputs.limit }}\n");
    expect(got.error).toBeNull();
    const indexes: Record<string, number> = {};
    for (const combo of got.combos) {
      indexes[combo.job.name] = combo.job.strategy.jobIndex;
      expect(["linux", "darwin"]).toContain(runsOnFromNode(combo.job.rawRunsOn)[0]);
      expect(combo.job.strategy.maxParallelString).toBe("3");
      expect(combo.job.strategy.jobTotal).toBe(4);
    }
    expect(indexes).toEqual({
      "build (linux, 1.20)": 0,
      "build (linux, 1.21)": 1,
      "build (darwin, 1.20)": 2,
      "build (darwin, 1.21)": 3,
    });
  });

  it("static and dynamic dimensions expand together, once", () => {
    const got = expand("\n  os: [linux, darwin]\n  version: ${{ fromJson(needs.setup.outputs.versions) }}\n");
    expect(got.error).toBeNull();
    expect(got.combos.length).toBe(4);
  });

  it("include-only matrix expands", () => {
    const got = expand("\n  include: ${{ fromJson(needs.setup.outputs.include) }}\n");
    expect(got.error).toBeNull();
    expect(got.combos.length).toBe(2);
  });

  for (const tt of [
    { name: "empty vector", matrix: "\n  version: ${{ fromJson(needs.setup.outputs.empty) }}\n", errHas: `Matrix vector "version" does not contain any values` },
    { name: "empty include", matrix: "\n  include: ${{ fromJson(needs.setup.outputs.empty) }}\n", errHas: "Matrix must define at least one vector" },
    { name: "whole matrix not a mapping", matrix: " ${{ fromJson(needs.setup.outputs.empty) }}\n", errHas: `Matrix "" is not a map of matrix keys to values` },
  ]) {
    it(`${tt.name} errors`, () => {
      const got = expand(tt.matrix);
      expect(got.error?.message).toContain(tt.errHas);
    });
  }

  it("fully excluded matrix runs once without matrix values", () => {
    const got = expand("\n  os: [linux]\n  exclude:\n    - os: linux\n");
    expect(got.error).toBeNull();
    expect(got.combos.length).toBe(1);
    expect(got.combos[0]!.job.name).toBe("build");
    expect(got.combos[0]!.job.strategy.jobTotal).toBe(1);
  });

  it("unresolved need errors", () => {
    const got = expand("\n  v: ${{ fromJson(needs.missing.outputs.v) }}\n");
    expect(got.error?.message).toContain("evaluate matrix");
  });

  it("invalid strategy field errors", () => {
    const got = expand("\n  os: [linux]\nmax-parallel: ${{ fromJSON('bad') }}\n");
    expect(got.error?.message).toContain("evaluate strategy");
  });

  it("too many combinations errors", () => {
    const got = expandMax("\n  version: ${{ fromJson(needs.setup.outputs.versions) }}\n", 1);
    expect(got.error?.message).toContain("exceeding the limit of 1");
  });
});

describe("TestRejectsUnevaluatedMatrixFilters", () => {
  for (const filter of ["include", "exclude"]) {
    it(filter, () => {
      const { error } = parseWorkflowCombos(
        `name: t\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        os: [a]\n        ${filter}: \${{ fromJson(vars.MATRIX) }}\n    steps: [{run: echo}]\n`,
        { gitContext: {}, vars: { MATRIX: `"a"` }, inputs: undefined },
      );
      expect(error?.message).toContain("is not a list of maps");
    });
  }
});

describe("TestParseRawSingleWorkflowRoundTripsDeferredPlaceholder", () => {
  const workflow = (matrix: string): string => `
on: push
jobs:
  setup:
    steps: [{run: echo}]
  build:
    needs: setup
    runs-on: ubuntu-latest
    strategy:
      matrix:
        ${matrix}
    steps: [{run: echo}]
`;
  for (const [name, matrix] of Object.entries({
    "include expression": "include: ${{ fromJson(needs.setup.outputs.m) }}",
    "static vector and expression": "os: [a, b]\n        version: ${{ fromJson(needs.setup.outputs.m) }}",
    "single expression vector": "version: ${{ fromJson(needs.setup.outputs.m) }}",
  })) {
    it(name, () => {
      const planned = parse(workflow(matrix));
      let payloadText: string | null = null;
      for (const combo of planned) {
        if (combo.jobId !== "build") continue;
        expect(hasDeferredMatrix(combo.job)).toBe(true);
        // SetJob(id, job.EraseNeeds()) then Marshal
        const { doc } = parseWorkflowDocument(workflow(matrix));
        void doc;
        const erased = { ...combo.job };
        erased.rawNeeds = undefined;
        const header: Array<[string, YamlNode]> = [["name", yamlScalar("t")]];
        payloadText = new TextDecoder().decode(marshalComboPayload(header, erased, { eraseNeeds: true }));
      }
      expect(payloadText).not.toBeNull();
      const { job } = parseRawSingleWorkflow(payloadText!);
      expect(job.name).toBe("build");
      expect(jobNeeds(job.rawNeeds)).toEqual([]);
      expect(hasDeferredMatrix(job)).toBe(false);
      const reparsed = parseWorkflowCombos(payloadText!, { gitContext: undefined, vars: {}, inputs: undefined });
      expect(reparsed.error).toBeNull();
      expect(reparsed.combos.length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Implementation-derived rows (no upstream fixtures) — marked as such
// ---------------------------------------------------------------------------

describe("the strategy reads (implementation-derived: Strategy.MaxParallel/GetFailFast)", () => {
  it("max-parallel truncates and saturates, 0 means unlimited", () => {
    expect(strategyMaxParallel(STRATEGY_MODEL({})).limit).toBe(0);
    expect(strategyMaxParallel(STRATEGY_MODEL({ maxParallelString: "2.9" })).limit).toBe(2);
    expect(strategyMaxParallel(STRATEGY_MODEL({ maxParallelString: "1e10" })).limit).toBe(0x7fffffff);
    expect(strategyMaxParallel(STRATEGY_MODEL({ maxParallelString: "4x" })).error?.message).toContain("expected a number");
    expect(maxParallelOfCombo("j", STRATEGY_MODEL({ maxParallelString: "1e10" }))).toBe(256);
  });

  it("fail-fast defaults true on junk, reads the spellings", () => {
    expect(strategyFailFast(STRATEGY_MODEL({}))).toBe(true);
    expect(strategyFailFast(STRATEGY_MODEL({ failFastString: "false" }))).toBe(false);
    expect(strategyFailFast(STRATEGY_MODEL({ failFastString: "False" }))).toBe(false);
    expect(strategyFailFast(STRATEGY_MODEL({ failFastString: "0" }))).toBe(false);
    expect(strategyFailFast(STRATEGY_MODEL({ failFastString: "junk" }))).toBe(true);
    expect(strategyFailFast(STRATEGY_MODEL({ failFastString: "${{ needs.a.outputs.f }}" }))).toBe(true);
  });

  it("resolveStrategy escapes the evaluated scalars", () => {
    const strategy = STRATEGY_MODEL({ failFastString: "${{ true }}", maxParallelString: "2" });
    const evaluator = newJobEvaluatorFromStrategy({
      jobId: "j",
      strategy,
      matrix: {},
      gitContext: {},
      results: {},
      vars: {},
      inputs: undefined,
    });
    expect(resolveStrategy(strategy, evaluator)).toBeNull();
    expect(strategy.failFastString).toBe(escapeExpressions("true"));
    expect(strategy.maxParallelString).toBe("2");
  });

  it("encodeMatrix bakes single-value axes", () => {
    const node = encodeMatrix({ os: "linux", n: 2 })!;
    const doc = new Document(node);
    const toJS = doc.toJS() as Record<string, unknown[]>;
    expect(toJS).toEqual({ os: ["linux"], n: [2] });
  });

  it("buildMatrixCombosInto rejects over the caller's cap", () => {
    const matrixNode = encodeMatrix({ a: ["x", "y"] })!;
    const src: JobModel = {
      id: "build",
      name: "build",
      rawNeeds: undefined,
      rawRunsOn: undefined,
      rawIf: "",
      rawContinueOnError: undefined,
      strategy: STRATEGY_MODEL({ rawMatrix: matrixNode, node: matrixNode }),
      rawConcurrency: undefined,
      uses: "",
      node: matrixNode as YAMLMap,
    };
    const matrixes = [
      { values: { a: 1 }, nameValues: [1] },
      { values: { a: 2 }, nameValues: [2] },
    ];
    const got = buildMatrixCombosInto("build", src, matrixes, { gitContext: {}, vars: undefined, inputs: undefined, maxCombinations: 1 });
    expect(got.error?.message).toContain("exceeding the limit of 1");
  });

  it("runsOnProblem rides the validate.go table", () => {
    const problem = (text: string): string => {
      const { doc } = parseWorkflowDocument(`runs-on: ${text}`);
      return runsOnProblem(doc.get("runs-on", true) as YamlNode);
    };
    expect(problem("x")).toBe("");
    expect(problem("[]")).toBe("");
    expect(problem("{}")).toBe("");
    expect(problem("{group: org/g, labels: [a, 1]}")).toBe("");
    expect(problem("{group: '${{ vars.G }}'}")).toBe("");
    expect(problem("~")).toBe(`Unexpected value ''`);
    expect(problem("['']")).toBe(`Unexpected value ''`);
    expect(problem("[[a]]")).toBe("A sequence was not expected");
    expect(problem("{labels: {a: b}}")).toBe("A mapping was not expected");
    expect(problem("{foo: x}")).toBe(`Unexpected value 'foo'`);
    expect(problem("{group: org/}")).toBe(`Invalid runs-on group name 'org/'.`);
    expect(problem("{group: a/b/c}")).toBe(
      `Invalid runs-on group name 'a/b/c'. Please use 'organization/' or 'enterprise/' prefix to target a single runner group.`,
    );
  });

  it("matrixOf answers null for a job that declares no strategy", () => {
    const { doc } = parseWorkflowDocument("runs-on: ubuntu-latest\n");
    const strategyNode = doc.get("strategy", true) as YamlNode | undefined;
    expect(matrixOf({ present: strategyNode !== undefined, node: strategyNode! }, undefined)).toBeNull();
  });

  it("replaceScalars walks keys and values (go-yaml's Content walk includes keys)", () => {
    const { doc } = parseWorkflowDocument("a: x\nb:\n  - y\n");
    const node = doc.contents as YamlNode;
    replaceScalars(node, (text) => text.toUpperCase());
    const items = ((doc.contents as YAMLMap).items ?? []) as Array<{ key: Scalar; value: unknown }>;
    expect(items[0]!.key.value).toBe("A");
    expect((items[0]!.value as Scalar).value).toBe("X");
    expect(((items[1]!.value as YAMLMap).items[0] as unknown as Scalar).value).toBe("Y");
  });
});

describe("decodeJobModel reads the model fields (implementation-derived)", () => {
  it("name/needs/runs-on/if/continue-on-error/concurrency read from the job map", () => {
    const { doc } = parseWorkflowDocument(
      "name: my job\nneeds: [a, b]\nruns-on: ubuntu-latest\nif: always()\ncontinue-on-error: true\nconcurrency: {group: g}",
    );
    const job = decodeJobModel(doc.contents as YAMLMap);
    expect(job.name).toBe("my job");
    expect(jobNeeds(job.rawNeeds)).toEqual(["a", "b"]);
    expect(runsOnFromNode(job.rawRunsOn)).toEqual(["ubuntu-latest"]);
    expect(job.rawIf).toBe("always()");
    expect(getContinueOnError(job.rawContinueOnError)).toBe(true);
    expect(job.rawConcurrency).toBeDefined();
  });
});
