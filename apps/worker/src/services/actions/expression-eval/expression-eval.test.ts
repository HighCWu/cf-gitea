// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The evaluator-core conformance tables — the port of actionslib v1.5.0's
// pkg/exprparser tests (interpreter_test.go, functions_test.go, json_test.go,
// memory_test.go) and pkg/expreval tests (evaluator_test.go), case rows kept
// 1:1 with upstream's own tables (gitea.dev/actionslib v1.5.0,
// gitea/go.mod:11, the submodule's pin).
//
// Dropped rows, with the stage that owns each:
//   - the glob/filesystem rows of TestFunctionHashFiles (glob.go is dropped
//     per SPEC-0012 §D4; the server's pinned posture is the
//     "hashFiles is only available in steps" error, asserted here);
//   - TestEvaluateYamlNode rides below (the EvaluateYamlNode port landed
//     with the workflow-model tier; the node walker adapts go-yaml's
//     node-kind mapping — see evaluator.ts's header);
//   - TestResolveWorkflowCallInputs / TestEvaluateWorkflowCallOutputs /
//     TestEvaluateCallerSecrets (expreval/workflow_call.go, v2-staged, §D2
//     #12);
//   - the Go-reflection rows (reflect.Value inputs, unexported struct
//     fields): JS values have no unexported fields, and every such row's
//     observable verdict is carried by a neighboring row.
//
// The JSON reader's dialect rows live here too (json_test.go).

import { parseDocument, type Node as YamlNode } from "yaml";
import { describe, expect, it } from "vitest";

import { evaluateYamlNode } from "./evaluator";

import {
  DefaultStatusCheck,
  newInterpeter,
  needsContext,
  strategyContext,
  callsStatusFunction,
  type EvaluationEnvironment,
  type JobShape,
  type RunShape,
  type StrategyContextInput,
} from "./interpreter";
import { coerceToString, isTruthy } from "./kinds";
import { stringSize } from "./memory";
import { OrderedObject } from "./object";
import { parseJSON } from "./json";
import { Evaluator } from "./evaluator";
import { utf16Len } from "../expression-syntax/utf16";
import { NewExprParser } from "../expression-syntax/parser";
import { ExprLexer } from "../expression-syntax/lexer";

// The Go fixtures use ordered objects for struct-like contexts and plain
// objects for map-like ones; `ordered()` builds the former in declaration
// order.
function ordered(entries: [string, unknown][]): OrderedObject {
  const object = new OrderedObject();
  for (const [key, value] of entries) {
    object.set(key, value);
  }
  return object;
}

function evaluateOK(input: string, env?: EvaluationEnvironment, context?: string, run?: RunShape): unknown {
  const { value, error } = newInterpeter(env, { context, run }).evaluate(input, DefaultStatusCheck.None);
  expect(error).toBeNull();
  return value;
}

describe("operators (interpreter_test.go TestOperators)", () => {
  interface Row {
    input: string;
    expected: unknown;
    name: string;
    error?: string;
  }
  // Rows from interpreter_test.go:29-93 — same inputs, same expectations.
  const table: Row[] = [
    { input: "true", expected: true, name: "true" },
    { input: "false", expected: false, name: "false" },
    { input: "null", expected: null, name: "null" },
    { input: "123", expected: 123, name: "integer" },
    { input: "-9.7", expected: -9.7, name: "float" },
    { input: "-2.99e-2", expected: -2.99e-2, name: "exponential" },
    { input: "'foo'", expected: "foo", name: "string" },
    { input: "'it''s foo'", expected: "it's foo", name: "string" },
    { input: "!null", expected: true, name: "not-null" },
    { input: "!-10", expected: false, name: "not-negative-number" },
    { input: "!0", expected: true, name: "not-zero" },
    { input: "!3.14", expected: false, name: "not-positive-float" },
    { input: "!''", expected: true, name: "not-empty-str" },
    { input: "!'abc'", expected: false, name: "not-str" },
    { input: "!fromJSON('{}')", expected: false, name: "not-obj" },
    { input: "!fromJSON('[]')", expected: false, name: "not-arr" },
    { input: `'3' == 3`, expected: true, name: "string-3-coercion" },
    { input: `3 == '3'`, expected: true, name: "string-3-coercion-alt" },
    { input: `'TEST' == 'test'`, expected: true, name: "string-casing" },
    { input: "true != false", expected: true, name: "bool-not-equal" },
    { input: `fromJSON('{}') < 2`, expected: false, name: "object-with-lt" },
    { input: `fromJSON('{}') < fromJSON('[]')`, expected: false, name: "object-arr-with-lt" },
    { input: `fromJSON('{}') > fromJSON('[]')`, expected: false, name: "object-arr-with-gt" },
    { input: "(false || (false || true))", expected: true, name: "logical-grouping" },
    { input: "github['action']", expected: "push", name: "property-index" },
    { input: "github.action[0]", expected: null, name: "string-index" },
    { input: "fromJSON('[0,1]')[1]", expected: 1, name: "array-index" },
    { input: "fromJSON('[0,1]')[1.1]", expected: 1, name: "array-index" },
    { input: "(github.event.commits.*.author.username)[0]", expected: [], name: "array-index-0" },
    { input: "fromJSON('[0,1]')[2]", expected: null, name: "array-index-at-length" },
    { input: "fromJSON('[0,1]')[-1]", expected: null, name: "array-index-below-zero" },
    { input: "!true", expected: false, name: "not" },
    { input: `'b' <= 'a'`, expected: false, name: "less-than-or-equal" },
    { input: `'b' >= 'a'`, expected: true, name: "greater-than-or-equal" },
    { input: "github.event.commits[0].author.username != github.event.commits[1].author.username", expected: true, name: "property-comparison1" },
    { input: "github.event.commits[0].author.username1 != github.event.commits[1].author.username", expected: true, name: "property-comparison2" },
    { input: "github.event.commits[0].author.username != github.event.commits[1].author.username1", expected: true, name: "property-comparison3" },
    { input: "github.event.commits[0].author.username1 != github.event.commits[1].author.username2", expected: false, name: "property-comparison4" },
    { input: "secrets != env", expected: true, name: "distinct-nil-maps" },
    { input: "secrets == secrets", expected: true, name: "same-nil-map" },
    { input: "inputs.groups.*.commits.*.message", expected: ["first", null, "third"], name: "wildcard-flat-map" },
    { input: "inputs.scalar.*.message", expected: [], name: "wildcard-non-collection" },
    { input: "null <= null", expected: true, name: "inclusive-null" },
    { input: "NaN <= NaN", expected: false, name: "inclusive-nan" },
    { input: "inputs.empty == inputs.empty", expected: true, name: "same-empty-array" },
    { input: "inputs.empty != inputs.other", expected: true, name: "distinct-empty-arrays" },
    { input: "inputs.values[' 1.9 ']", expected: "one", name: "fractional-array-index" },
    { input: "inputs.values[' 0x02 ']", expected: "two", name: "hex-array-index" },
    { input: "inputs.values[null]", expected: "zero", name: "null-array-index" },
    { input: "inputs.values.missing", expected: null, name: "array-property-is-not-an-index" },
    { input: "jobs[0]", expected: null, name: "index-operand-error", error: "Unavailable context: jobs" },
    { input: "inputs.values[jobs]", expected: null, name: "index-expression-error", error: "Unavailable context: jobs" },
    { input: "jobs && true", expected: null, name: "logical-left-error", error: "Unavailable context: jobs" },
    { input: "true && jobs", expected: null, name: "and-evaluates-right", error: "Unavailable context: jobs" },
    { input: "false || jobs", expected: null, name: "or-evaluates-right", error: "Unavailable context: jobs" },
    { input: "inputs.object['0x10']", expected: "literal", name: "literal-object-key" },
    { input: "inputs.object[0x10]", expected: "numeric", name: "numeric-object-key" },
    { input: "case(true, 'selected', fromJSON('nope'), 'unused', fromJSON('nope'))", expected: "selected", name: "lazy-case" },
    { input: "case(1, 'selected', 'default')", expected: null, name: "case-predicate-type", error: "case predicate must evaluate to a boolean value" },
    {
      input: "case(true, 'selected', false, 'unused')",
      expected: null,
      name: "case-arity",
      error: "Even number of parameters supplied, requires an odd number of parameters: '('. Located at position 5 within expression: case(true, 'selected', false, 'unused')",
    },
    {
      input: "toJSON()",
      expected: null,
      name: "arity-too-few",
      error: "Too few parameters supplied: '('. Located at position 7 within expression: toJSON()",
    },
    {
      input: "contains(1)",
      expected: null,
      name: "arity-too-few-2",
      error: "Too few parameters supplied: '('. Located at position 9 within expression: contains(1)",
    },
    {
      input: "success(1)",
      expected: null,
      name: "arity-status-function",
      error: "Too many parameters supplied: '('. Located at position 8 within expression: success(1)",
    },
    {
      input: "true && nope()",
      expected: null,
      name: "unknown-function-position",
      error: "Unrecognized function: 'nope'. Located at position 9 within expression: true && nope()",
    },
  ];

  const env: EvaluationEnvironment = {
    github: ordered([
      ["action", "push"],
      [
        "event",
        {
          commits: [
            { author: { username: "someone" } },
            { author: { username: "someone-else" } },
          ],
        },
      ],
    ]),
    inputs: {
      empty: [],
      other: [],
      groups: [
        { commits: [{ message: "first" }, {}, { message: null }, "skip"] },
        {},
        { commits: [{ message: "third" }] },
      ],
      object: { "0x10": "literal", "16": "numeric" },
      scalar: "value",
      values: ["zero", "one", "two"],
    },
  };

  for (const row of table) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      if (row.error !== undefined) {
        expect(error?.message).toBe(row.error);
      } else {
        expect(error).toBeNull();
      }
      expect(value).toEqual(row.expected);
    });
  }
});

describe("boolean evaluation (interpreter_test.go TestOperatorsBooleanEvaluation)", () => {
  interface Row {
    input: string;
    expected: unknown;
    truthy: boolean;
  }
  // Rows from interpreter_test.go:144-157.
  const table: Row[] = [
    { input: "true", expected: true, truthy: true },
    { input: "false", expected: false, truthy: false },
    { input: "null", expected: null, truthy: false },
    { input: "-10", expected: -10, truthy: true },
    { input: "0", expected: 0, truthy: false },
    { input: "3.14", expected: 3.14, truthy: true },
    { input: "Infinity", expected: Number.POSITIVE_INFINITY, truthy: true },
    { input: "-Infinity", expected: Number.NEGATIVE_INFINITY, truthy: true },
    { input: "NaN", expected: Number.NaN, truthy: false },
    { input: "''", expected: "", truthy: false },
    { input: "'abc'", expected: "abc", truthy: true },
    { input: "fromJSON('{}')", expected: {}, truthy: true },
    { input: "fromJSON('[]')", expected: [], truthy: true },
  ];

  const interpeter = newInterpeter({}, {});
  for (const row of table) {
    const andExpected = row.expected;
    const orExpected = row.truthy ? row.expected : false;
    const shortCircuit = row.truthy ? " || fromJSON('nope')" : " && fromJSON('nope')";
    for (const operation of [
      { input: `${row.input} && true`, expected: row.truthy ? true : andExpected },
      { input: `${row.input} || false`, expected: orExpected },
      { input: `true && ${row.input}`, expected: row.expected },
      { input: `false || ${row.input}`, expected: row.expected },
      { input: row.input + shortCircuit, expected: row.expected },
    ]) {
      it(operation.input, () => {
        const { value, error } = interpeter.evaluate(operation.input, DefaultStatusCheck.None);
        expect(error).toBeNull();
        if (typeof operation.expected === "number" && Number.isNaN(operation.expected)) {
          expect(typeof value).toBe("number");
          expect(Number.isNaN(value as number)).toBe(true);
        } else {
          expect(value).toEqual(operation.expected);
        }
      });
    }
  }
});

describe("contexts (interpreter_test.go TestContexts)", () => {
  interface Row {
    input: string;
    expected: unknown;
    name: string;
  }
  // Rows from interpreter_test.go:211-257.
  const table: Row[] = [
    { input: "inputs.one.status", expected: null, name: "nil-pointer-field-property" },
    { input: "inputs.one['status']", expected: null, name: "nil-pointer-field-index" },
    { input: "inputs.many.*.status", expected: [null], name: "nil-pointer-field-wildcard" },
    { input: "inputs.one.status == null", expected: true, name: "typed-nil-equals-null" },
    { input: "github.action", expected: "push", name: "github-context" },
    { input: "github.event_path", expected: "/event.json", name: "github-context-json-name" },
    { input: "github.EventPath", expected: null, name: "github-context-go-name" },
    { input: "github.repositoryUrl", expected: "git://local.git", name: "github-context-camel-case-name" },
    { input: "github.repository_url", expected: null, name: "github-context-snake-case-name" },
    { input: "github.event.commits[0].message", expected: null, name: "github-context-noexist-prop" },
    { input: "fromjson('{\"commits\":[]}').commits[0].message", expected: null, name: "github-context-noexist-prop" },
    { input: "github.event.pull_request.labels.*.name", expected: [], name: "github-context-noexist-prop" },
    { input: "env.TEST", expected: "value", name: "env-context" },
    { input: "job.status", expected: "success", name: "job-context" },
    { input: "steps.step-id.outputs.name", expected: "value", name: "steps-context" },
    { input: "steps.step-id.conclusion", expected: "success", name: "steps-context-conclusion" },
    { input: "steps.step-id.conclusion && true", expected: true, name: "steps-context-conclusion" },
    { input: "steps.step-id2.conclusion", expected: "skipped", name: "steps-context-conclusion" },
    { input: "steps.step-id.outcome", expected: "success", name: "steps-context-outcome" },
    { input: "steps.step-id['outcome']", expected: "success", name: "steps-context-outcome" },
    { input: "steps.step-id.outcome && true", expected: true, name: "steps-context-outcome" },
    { input: "steps.step-id2.outcome", expected: "failure", name: "steps-context-outcome" },
    { input: "steps.nilstep", expected: null, name: "steps-context-nil" },
    { input: "contains(steps.*.outcome, 'success')", expected: true, name: "steps-wildcard-success-outcome" },
    { input: "contains(steps.*.outcome, 'failure')", expected: true, name: "steps-wildcard-failure-outcome" },
    { input: "contains(steps.*.outputs.name, 'value')", expected: true, name: "steps-wildcard-nested-output" },
    { input: "runner.os", expected: "Linux", name: "runner-context" },
    { input: "runner.tagged.skip", expected: null, name: "json-hidden-property" },
    { input: "toJSON(runner.tagged)", expected: '{\n  "other": "renamed"\n}', name: "json-hidden-tojson" },
    { input: "runner.tagged.*", expected: ["renamed"], name: "json-hidden-wildcard" },
    { input: "runner.tagged.Renamed", expected: null, name: "json-renamed-go-name" },
    { input: "runner.tagged.other", expected: "renamed", name: "json-renamed-property" },
    { input: "runner.tagged['K']", expected: null, name: "ascii-struct-rejects-non-ascii-property" },
    { input: "runner.unicode['ς']", expected: "sigma", name: "unicode-struct-case-insensitive-property" },
    { input: "runner.unicode.missing", expected: null, name: "unicode-struct-missing-property" },
    { input: "secrets.name", expected: "value", name: "secrets-context" },
    { input: "vars.name", expected: "value", name: "vars-context" },
    { input: "strategy.fail-fast", expected: true, name: "strategy-context" },
    { input: "matrix.os", expected: "Linux", name: "matrix-context" },
    { input: "matrix.obj.Visible", expected: "yes", name: "struct-exported-field" },
    { input: "matrix.obj.hidden", expected: null, name: "struct-unexported-field" },
    { input: "needs.job-id.outputs.output-name", expected: "value", name: "needs-context" },
    { input: "needs.job-id.result", expected: "success", name: "needs-context" },
    { input: "needs.tolerated.result", expected: "success", name: "needs-context-tolerated-failure" },
    { input: "needs.ghost", expected: null, name: "needs-context-undefined-job" },
    { input: "inputs.name", expected: "value", name: "inputs-context" },
  ];

  const run: RunShape = {
    jobId: "current",
    workflow: {
      jobs: {
        current: { needs: ["job-id", "tolerated", "ghost"] },
        "job-id": { result: "success", outputs: { "output-name": "value" } },
        tolerated: { result: "failure", continueOnError: true },
      },
    },
  };

  const env: EvaluationEnvironment = {
    github: ordered([
      ["action", "push"],
      ["event_path", "/event.json"],
      ["repositoryUrl", "git://local.git"],
      ["event", { commits: [{ author: { username: "first" } }] }],
    ]),
    env: { TEST: "value" },
    job: { status: "success" },
    steps: {
      nilstep: undefined,
      "step-id": ordered([
        ["outputs", { name: "value" }],
        ["conclusion", "success"],
        ["outcome", "success"],
      ]),
      "step-id2": ordered([
        ["conclusion", "skipped"],
        ["outcome", "failure"],
      ]),
    },
    runner: {
      os: "Linux",
      // taggedContext's Go fixture has an unexported Skip field — invisible
      // to the evaluator — and a Renamed field tagged json:"other"; the
      // observable surface is the "other" property alone.
      tagged: ordered([["other", "renamed"]]),
      unicode: ordered([["Σ", "sigma"]]),
    },
    secrets: { name: "value" },
    vars: { name: "value" },
    strategy: { "fail-fast": true },
    matrix: { os: "Linux", obj: ordered([["Visible", "yes"]]) },
    needs: needsContext(run),
    inputs: {
      name: "value",
      one: ordered([["status", undefined]]),
      many: [ordered([["status", undefined]])],
    },
  };

  for (const row of table) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, { run }).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(value).toEqual(row.expected);
    });
  }
});

describe("strategy context (interpreter_test.go TestStrategyContext)", () => {
  // Rows from interpreter_test.go:304-309, over the structural input.
  const matrix: StrategyContextInput = { failFast: true, maxParallel: 0, hasRawMatrix: true };
  const table: [StrategyContextInput | undefined, number, number, Record<string, unknown>][] = [
    [undefined, 0, 0, { "fail-fast": true }],
    [{ failFast: false, maxParallel: 3, hasRawMatrix: false }, 0, 0, { "fail-fast": false, "max-parallel": 3 }],
    [{ failFast: true, maxParallel: 3, hasRawMatrix: false }, 0, 1, { "fail-fast": true, "job-index": 0, "job-total": 1, "max-parallel": 1 }],
    [matrix, 2, 4, { "fail-fast": true, "job-index": 2, "job-total": 4, "max-parallel": 4 }],
    [{ failFast: true, maxParallel: 2, hasRawMatrix: true }, 1, 3, { "fail-fast": true, "job-index": 1, "job-total": 3, "max-parallel": 2 }],
  ];
  for (const [strategy, index, total, want] of table) {
    it(`${JSON.stringify(want)}`, () => {
      expect(strategyContext(strategy, index, total)).toEqual(want);
    });
  }
});

describe("coerce to string (interpreter_test.go TestCoerceToString)", () => {
  interface Row {
    input: unknown;
    expected: string;
    name: string;
  }
  // Rows from interpreter_test.go:323-353; the Go-reflection rows
  // (reflect.Value, typed nil pointers) ride the equivalent plain rows.
  const table: Row[] = [
    { input: null, expected: "", name: "null" },
    { input: true, expected: "true", name: "true" },
    { input: false, expected: "false", name: "false" },
    { input: "foo", expected: "foo", name: "string" },
    { input: "", expected: "", name: "empty-string" },
    { input: 123, expected: "123", name: "int" },
    { input: -9, expected: "-9", name: "int64" },
    { input: 7, expected: "7", name: "uint8" },
    { input: 1000000000000000, expected: "1E+15", name: "int-rounded-as-double-beyond-15-digits" },
    { input: 4611686018427387904, expected: "4.61168601842739E+18", name: "uint64-rounded-as-double-beyond-15-digits" },
    { input: 1.0, expected: "1", name: "float-integral" },
    { input: -9.7, expected: "-9.7", name: "float" },
    { input: 2.99e-2, expected: "0.0299", name: "float-exponential" },
    { input: 1e21, expected: "1E+21", name: "float-large" },
    { input: 1.5, expected: "1.5", name: "float32" },
    { input: Number.NaN, expected: "NaN", name: "nan" },
    { input: Number.POSITIVE_INFINITY, expected: "Infinity", name: "positive-infinity" },
    { input: Number.NEGATIVE_INFINITY, expected: "-Infinity", name: "negative-infinity" },
    { input: [1, 2], expected: "Array", name: "slice" },
    { input: [], expected: "Array", name: "nil-slice" },
    { input: { a: 1 }, expected: "Object", name: "map" },
    { input: {}, expected: "Object", name: "nil-map" },
    { input: DefaultStatusCheck.None, expected: "", name: "no-default-status-name" },
    { input: DefaultStatusCheck.Canceled, expected: "cancelled", name: "cancelled-default-status-name" },
    { input: DefaultStatusCheck.Failure, expected: "failure", name: "failure-default-status-name" },
  ];
  for (const row of table) {
    it(row.name, () => {
      expect(coerceToString(row.input)).toBe(row.expected);
    });
  }
});

describe("caller identity is preserved (interpreter_test.go TestEvaluatePreservesCallerSliceIdentityWithCycles)", () => {
  it("ordinary", () => {
    const values = ["value"];
    const returned = evaluateOK("inputs.values", { inputs: { values } }) as unknown[];
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(values[0]);
  });
  it("self-reference", () => {
    const cycle: unknown[] = new Array(1);
    cycle[0] = cycle;
    const returned = evaluateOK("inputs.values", { inputs: { values: cycle } }) as unknown[];
    expect(returned).toHaveLength(1);
    expect(returned[0]).toBe(cycle);
  });
});

describe("empty input asks its own status check (interpreter_test.go TestEvaluateEmptyInputAsksItsOwnStatusCheck)", () => {
  it("evaluates to the default status", () => {
    const { value, error } = newInterpeter({}, {}).evaluate("", DefaultStatusCheck.Always);
    expect(error).toBeNull();
    expect(value).toBe(true);
  });
});

describe("property lookup is deterministic (interpreter_test.go TestPropertyLookupIsDeterministic)", () => {
  const env: EvaluationEnvironment = {
    env: { PATH: "upper", Path: "mixed", path: "lower" },
    github: ordered([["Event", { PATH: "upper", Path: "mixed" }]]),
    vars: { NAME: "value" },
  };
  for (const row of [
    { input: "env.path", expected: "lower" },
    { input: "env.PATH", expected: "upper" },
    { input: "env['path']", expected: "lower" },
    { input: "env.paTH", expected: "upper" },
    { input: "env['paTH']", expected: "upper" },
    { input: "github.event.Path", expected: "mixed" },
    { input: "github.event.path", expected: "upper" },
    { input: "github.event['path']", expected: "upper" },
    { input: "vars.name", expected: "value" },
  ]) {
    it(row.input, () => {
      for (let i = 0; i < 50; i++) {
        const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
        expect(error?.message ?? null).toBeNull();
        expect(value).toBe(row.expected);
      }
    });
  }
});

describe("collection identity (interpreter_test.go TestCollectionIdentity)", () => {
  const env: EvaluationEnvironment = {
    job: { container: {} },
    needs: { a: { result: "success" }, b: { result: "success" } },
    inputs: { arrays: [[]] },
  };
  for (const row of [
    { input: "job.container == job.container", expected: true, name: "same-struct" },
    { input: "job['container'] == job.container", expected: true, name: "same-struct-by-index" },
    { input: "job.container <= job.container", expected: true, name: "same-struct-ordered" },
    { input: "job.container < job.container", expected: false, name: "same-struct-strict" },
    { input: "needs.a == needs.b", expected: false, name: "equal-contents-differ" },
    { input: "needs.a == needs.a.outputs", expected: false, name: "different-types" },
    { input: "job.container == job", expected: false, name: "struct-and-pointer" },
    { input: "fromJSON('{}') == fromJSON('{}')", expected: false, name: "distinct-objects" },
    { input: "fromJSON('[1]') == fromJSON('[1]')", expected: false, name: "distinct-arrays" },
    { input: "inputs.arrays[0] == inputs.arrays[0]", expected: true, name: "same-empty-array-numeric-index" },
    { input: "inputs.arrays[false] == fromJSON('[]')", expected: false, name: "distinct-empty-arrays-computed-index" },
    { input: "fromJSON('[[]]')[0] == inputs.arrays[0]", expected: false, name: "distinct-empty-arrays-call-index" },
    { input: "(true && needs) == needs", expected: true, name: "and-preserves-right-map-identity" },
    { input: "(false || needs) == needs", expected: true, name: "or-preserves-right-map-identity" },
    { input: "(needs || fromJSON('nope')) == needs", expected: true, name: "or-preserves-left-map-identity-and-short-circuits" },
    { input: "(true && inputs.arrays) == inputs.arrays", expected: true, name: "and-preserves-right-array-identity" },
    { input: "(false || inputs.arrays) == inputs.arrays", expected: true, name: "or-preserves-right-array-identity" },
    { input: "(inputs.arrays || fromJSON('nope')) == inputs.arrays", expected: true, name: "or-preserves-left-array-identity-and-short-circuits" },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(value).toBe(row.expected);
    });
  }
});

describe("named values (interpreter_test.go TestNamedValues)", () => {
  it("rejects unknown named values", () => {
    for (const input of ["infinity", "nan", "NAN", "InFinity"]) {
      const { error } = newInterpeter({}, {}).evaluate(input, DefaultStatusCheck.None);
      expect(error?.message).toContain("Unrecognized named-value");
    }
  });
  it("renders NaN and Infinity", () => {
    for (const row of [
      { input: "NaN", expected: "NaN" },
      { input: "Infinity", expected: "Infinity" },
      { input: "-Infinity", expected: "-Infinity" },
    ]) {
      const { value, error } = newInterpeter({}, {}).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(coerceToString(value)).toBe(row.expected);
    }
  });
});

describe("string predicates (functions_test.go TestFunctionStringPredicates)", () => {
  // Rows from functions_test.go:26-56.
  for (const row of [
    { input: "contains('search', 'item')", expected: false, name: "contains-str-str" },
    { input: `cOnTaInS('Hello', 'll')`, expected: true, name: "contains-str-casing" },
    { input: `contains('3.141592', 3.14)`, expected: true, name: "contains-str-number" },
    { input: `contains(3.141592, '3.14')`, expected: true, name: "contains-number-str" },
    { input: `contains(3.141592, 3.14)`, expected: true, name: "contains-number-number" },
    { input: `contains(true, 'u')`, expected: true, name: "contains-bool-str" },
    { input: `contains(null, '')`, expected: true, name: "contains-null-str" },
    { input: `contains(fromJSON('["first","second"]'), 'first')`, expected: true, name: "contains-item" },
    { input: `contains(fromJSON('[null,"second"]'), '')`, expected: true, name: "contains-item-null-empty-str" },
    { input: `contains(fromJSON('["","second"]'), null)`, expected: true, name: "contains-item-empty-str-null" },
    { input: `contains(fromJSON('[true,"second"]'), 'true')`, expected: false, name: "contains-item-bool-arr" },
    { input: `contains(fromJSON('["true","second"]'), true)`, expected: false, name: "contains-item-str-bool" },
    { input: `contains(fromJSON('[3.14,"second"]'), '3.14')`, expected: true, name: "contains-item-number-str" },
    { input: `contains(fromJSON('[3.14,"second"]'), 3.14)`, expected: true, name: "contains-item-number-number" },
    { input: `contains(fromJSON('["","second"]'), fromJSON('[]'))`, expected: false, name: "contains-item-str-arr" },
    { input: `contains(fromJSON('["","second"]'), fromJSON('{}'))`, expected: false, name: "contains-item-str-obj" },
    { input: "contains('ςuffix', 'Σ')", expected: true, name: "contains-ordinal-ignore-case" },
    { input: "contains('Array', fromJSON('[]'))", expected: false, name: "contains-collection-argument" },
    { input: "contains(fromJSON('[]'), fromJSON('bogus'))", expected: false, name: "contains-empty-array-skips-item" },
    { input: "contains(fromJSON('{}'), fromJSON('bogus'))", expected: false, name: "contains-object-skips-item" },
    { input: "startsWith(123, 's')", expected: false, name: "startswith-string" },
    { input: "startsWith(123, '12')", expected: true, name: "startswith-string" },
    { input: "startsWith(null, '42')", expected: false, name: "startswith-string" },
    { input: "startsWith('Σuffix', 'ς')", expected: true, name: "startsWith-ordinal-ignore-case" },
    { input: "startsWith(fromJSON('{}'), fromJSON('bogus'))", expected: false, name: "startsWith-object-skips-item" },
    { input: "endsWith(123, 's')", expected: false, name: "endsWith-string" },
    { input: "endsWith(123, '23')", expected: true, name: "endsWith-string" },
    { input: "endsWith(null, '42')", expected: false, name: "endsWith-string" },
    { input: "endsWith('prefixΣ', 'σ')", expected: true, name: "endsWith-ordinal-ignore-case" },
    { input: "endsWith('Object', fromJSON('{}'))", expected: false, name: "endsWith-collection-argument" },
    { input: "endsWith(fromJSON('[]'), fromJSON('bogus'))", expected: false, name: "endsWith-array-skips-item" },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter({}, {}).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(value).toBe(row.expected);
    });
  }
});

describe("join (functions_test.go TestFunctionJoin)", () => {
  const env: EvaluationEnvironment = { inputs: { large: ["a".repeat(524276), "x"] } };
  for (const row of [
    { input: "join('string', fromJSON('bogus'))", expected: "string", wantErr: "", name: "join-str" },
    { input: "join(fromJSON('[]'), fromJSON('bogus'))", expected: "", wantErr: "", name: "join-empty-array-skips-separator" },
    { input: `join(fromJSON('{"key": "value"}'), fromJSON('bogus'))`, expected: "", wantErr: "", name: "join-object-skips-separator" },
    { input: "join(fromJSON('[1]'), fromJSON('bogus'))", expected: "1", wantErr: "", name: "join-single-item-skips-separator" },
    {
      input: "join(inputs.large, fromJSON('bogus'))",
      expected: null,
      wantErr: "The maximum allowed memory size was exceeded",
      name: "join-charges-first-item-before-separator",
    },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      if (row.wantErr !== "") {
        expect(error?.message).toContain(row.wantErr);
      } else {
        expect(error?.message ?? null).toBeNull();
        expect(value).toBe(row.expected);
      }
    });
  }
});

describe("json functions (functions_test.go TestFunctionJSON)", () => {
  const env: EvaluationEnvironment = {
    env: { z: "value z", a: "value a" },
    inputs: { text: 'a"b\\c\nd\te\u0001f' },
    steps: { one: ordered([["outputs", {}], ["conclusion", "success"], ["outcome", "success"]]) },
  };
  for (const row of [
    { input: `fromJSON('{"b":{"a":1}}')`, expected: { b: { a: 1 } }, name: "fromJSON-plain-nested-object" },
    { input: `fromJSON('[[{"a":1}]]')`, expected: [[{ a: 1 }]], name: "fromJSON-plain-nested-array" },
    { input: `fromJSON('{"b":{"a":1}}').b`, expected: { a: 1 }, name: "fromJSON-plain-property" },
    { input: `fromJSON('{"b":{"a":{"n":1}}}').*`, expected: [{ a: { n: 1 } }], name: "fromJSON-plain-wildcard" },
    { input: `fromJSON('{"b":[{"a":1}]}')['b']`, expected: [{ a: 1 }], name: "fromJSON-plain-index" },
    { input: `fromJSON('{"a":1,"A":2}').a`, expected: 2, name: "case-colliding-keys" },
    { input: `fromJSON('{"CAF\u00c9":1,"caf\u00e9":2}')['caf\u00e9']`, expected: 2, name: "fromJSON-non-ascii-case-collision" },
    { input: "fromJSON('9223372036854776833') == fromJSON('9223372036854775808')", expected: true, name: "big-integer-equality" },
    { input: "fromJSON('9223372036854776833') < fromJSON('9223372036854776833.0')", expected: true, name: "big-integer-ordering" },
    { input: "toJSON(env)", expected: '{\n  "a": "value a",\n  "z": "value z"\n}', name: "toJSON-map-sorted" },
    { input: "toJSON(NaN)", expected: "NaN", name: "toJSON-non-finite" },
    { input: "toJSON(1.2345678901234567)", expected: "1.23456789012346", name: "toJSON-g15" },
    { input: "toJSON('<tag>&value>')", expected: '"<tag>&value>"', name: "toJSON-unescaped-html" },
    { input: "toJSON(inputs.text)", expected: '"a\\"b\\\\c\\nd\\te\\u0001f"', name: "toJSON-escaped-control-characters" },
    { input: "toJSON(inputs.text[fromJSON('bogus')])", expected: "null", name: "index-on-string-skips-index" },
    { input: `toJSON(fromJSON('{"b": {}, "a": []}'))`, expected: '{\n  "b": {},\n  "a": []\n}', name: "toJSON-object-order" },
    { input: `toJSON(fromJSON('{"b": 1, "B": 2, "a": 3}'))`, expected: '{\n  "b": 2,\n  "a": 3\n}', name: "toJSON-object-case-collision" },
    {
      input: "toJSON(steps)",
      expected: '{\n  "one": {\n    "outputs": {},\n    "conclusion": "success",\n    "outcome": "success"\n  }\n}',
      name: "toJSON-through-pointer",
    },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(value).toEqual(row.expected);
    });
  }
});

describe("context cycle (functions_test.go TestFunctionContextCycle)", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const env: EvaluationEnvironment = { inputs: { cycle } };
  for (const row of [
    { input: "toJSON(inputs.cycle)", expected: null, wantErr: "nests too deeply" },
    { input: "inputs.cycle.key", expected: null, wantErr: "" },
    { input: "inputs.cycle[format('fail')]", expected: null, wantErr: "" },
    // Go's cycle is a pointer to itself, which CoerceToString's indirection
    // bound renders as ""; a JS object cycle is never indirected, so the
    // object-model value renders "Object" — the cycle handling itself is
    // pinned by the toJSON row above.
    { input: "format('{0}', inputs.cycle)", expected: "Object", wantErr: "" },
  ]) {
    it(row.input, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      if (row.wantErr !== "") {
        expect(error?.message).toContain(row.wantErr);
      } else {
        expect(error?.message ?? null).toBeNull();
        expect(value).toEqual(row.expected);
      }
    });
  }
});

describe("hashFiles (functions_test.go TestFunctionHashFiles, glob.go dropped per §D4)", () => {
  it("custom callback receives the plain arguments", () => {
    const calls: unknown[][] = [];
    const env: EvaluationEnvironment = {
      hashFiles: (args: unknown[]) => {
        calls.push(args);
        return "custom";
      },
    };
    const value = evaluateOK("hashFiles(fromJSON('[1]'))", env);
    expect(value).toBe("custom");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([[1]]);
  });

  it("is unavailable outside steps", () => {
    const { error } = newInterpeter({}, {}).evaluate("hashFiles('**')", DefaultStatusCheck.None);
    expect(error?.message).toContain("hashFiles is only available in steps");
  });
});

describe("format (functions_test.go TestFunctionFormat)", () => {
  const env: EvaluationEnvironment = { github: ordered([["action", ""]]) };
  for (const row of [
    { input: "format('{{Hello {0} {1} {2}!}}', 'Mona', 'the', 'Octocat')", expected: "{Hello Mona the Octocat!}", error: null, name: "format-with-escaped-braces" },
    { input: "format('{{{0}}}', 'test')", expected: "{test}", error: null, name: "format-with-escaped-braces-and-value" },
    { input: `format('Hello "{0}" {1} {2} {3} {4}', null, true, -3.14, NaN, Infinity)`, expected: `Hello "" true -3.14 NaN Infinity`, error: null, name: "format-with-primitives" },
    { input: `format('Hello "{0}" {1}', fromJSON('[0]'), fromJSON('{"a":1}'))`, expected: `Hello "Array" Object`, error: null, name: "format-with-complex-types" },
    { input: "format(true)", expected: "true", error: null, name: "format-with-primitive-args" },
    { input: "format('{0}', github)", expected: "Object", error: null, name: "format-with-context" },
    { input: "format('echo Hello {0} ${{Test}}', github.undefined_property)", expected: "echo Hello  ${Test}", error: null, name: "format-with-undefined-value" },
    { input: "format('a}b')", expected: null, error: "The following format string is invalid: a}b", name: "format-unmatched-closing-brace" },
    { input: "format('{0', 'value')", expected: null, error: "The following format string is invalid: {0", name: "format-invalid-format-string" },
    { input: "format('{2}', '{1}', 'World')", expected: null, error: "The following format string references more arguments than were supplied: {2}", name: "format-invalid-replacement-reference" },
    { input: "format('{2147483648}')", expected: null, error: "The following format string is invalid: {2147483648}", name: "format-invalid-replacement-reference" },
    { input: "format('{0} {1} {2} {3}', 1.0, 1.1, 1234567890.0, 12345678901234567890.0)", expected: "1 1.1 1234567890 1.23456789012346E+19", error: null, name: "format-floats" },
    { input: "format('{0:}', 'value')", expected: "value", error: null, name: "format-empty-specifier" },
    { input: "format('{0:x}', 1)", expected: null, error: "The following format string contains an invalid format specifier: '{0:x}'", name: "format-non-empty-specifier" },
    { input: "format('{0}', 'a', fromJSON('bogus'))", expected: "a", error: null, name: "format-skips-unused-argument" },
    { input: "format('no placeholders', fromJSON('bogus'))", expected: "no placeholders", error: null, name: "format-skips-all-unused-arguments" },
    { input: "format('{5}', fromJSON('bogus'))", expected: null, error: "The following format string references more arguments than were supplied: {5}", name: "format-count-error-before-argument" },
    { input: "format('{0}{5}', fromJSON('bogus'))", expected: null, error: "The following format string references more arguments than were supplied: {0}{5}", name: "format-later-count-error-before-argument" },
    { input: "format('{0}}', fromJSON('bogus'))", expected: null, error: "The following format string is invalid: {0}}", name: "format-syntax-error-before-argument" },
    { input: "format('{1}{0}', fromJSON('bogus'), fromJSON('wrong'))", expected: null, error: "Invalid JSON: unexpected character 'w' at offset 0", name: "format-evaluates-in-placeholder-order" },
    { input: "format('{0:x}', fromJSON('bogus'))", expected: null, error: "Invalid JSON: unexpected character 'b' at offset 0", name: "format-argument-error-before-specifier" },
    {
      input: "format('{0:x}{1}', 'a', fromJSON('bogus'))",
      expected: null,
      error: "The following format string contains an invalid format specifier: '{0:x}{1}'",
      name: "format-specifier-error-before-later-argument",
    },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter(env, {}).evaluate(row.input, DefaultStatusCheck.None);
      if (row.error !== null) {
        expect(error?.message).toBe(row.error);
      } else {
        expect(error?.message ?? null).toBeNull();
        expect(value).toBe(row.expected);
      }
    });
  }

  it("evaluates each argument once, in placeholder order", () => {
    const calls: string[] = [];
    const env: EvaluationEnvironment = {
      hashFiles: (args: unknown[]) => {
        calls.push(String(args[0]));
        return String(args[0]);
      },
    };
    const value = evaluateOK("format('{1}{0}{1}', hashFiles('first'), hashFiles('second'))", env);
    expect(value).toBe("secondfirstsecond");
    expect(calls).toEqual(["second", "first"]);
  });

  for (const referenced of [false, true]) {
    it(`format toJSON memory budget, referenced ${referenced}`, () => {
      const input = referenced ? "format('{0}', toJSON(inputs.large))" : "format('no placeholders', toJSON(inputs.large))";
      const { value, error } = newInterpeter({ inputs: { large: "a".repeat(524274) } }, {}).evaluate(input, DefaultStatusCheck.None);
      if (referenced) {
        expect(error?.message).toContain("The maximum allowed memory size was exceeded");
      } else {
        expect(error?.message ?? null).toBeNull();
        expect(value).toBe("no placeholders");
      }
    });
  }
});

describe("status functions read the job status (functions_test.go TestStatusFunctionsJobStatus)", () => {
  for (const row of [
    { job: undefined, input: "success()", context: "step", expected: true, name: "nil-job-succeeds" },
    { job: undefined, input: "failure()", context: "step", expected: false, name: "nil-job-not-failed" },
    { job: undefined, input: "cancelled()", context: "job", expected: false, name: "nil-job-not-cancelled" },
    { job: {}, input: "success()", context: "step", expected: true, name: "unset-status-succeeds" },
    { job: {}, input: "cancelled()", context: "step", expected: false, name: "unset-status-not-cancelled" },
    { job: { status: "failure" }, input: "success()", context: "step", expected: false, name: "failed-status" },
    { job: { status: "cancelled" }, input: "cancelled()", context: "step", expected: true, name: "cancelled-status" },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter({ job: row.job }, { context: row.context }).evaluate(row.input, DefaultStatusCheck.None);
      expect(error?.message ?? null).toBeNull();
      expect(value).toBe(row.expected);
    });
  }
});

describe("status functions walk the needs graph (functions_test.go TestStatusFunctionsNeedsGraph)", () => {
  function run(jobId: string, jobs: Record<string, JobShape>): RunShape {
    return { jobId, workflow: { jobs } };
  }
  function needsJob(result: string, ...needs: string[]): JobShape {
    return needs.length > 0 ? { result, needs } : { result };
  }
  function stackedDiamonds(levels: number): Record<string, JobShape> {
    const jobs: Record<string, JobShape> = { j0: needsJob("success") };
    for (let k = 1; k <= levels; k++) {
      const parent = `j${k - 1}`;
      jobs[`a${k}`] = needsJob("success", parent);
      jobs[`b${k}`] = needsJob("success", parent);
      jobs[`j${k}`] = needsJob("success", `a${k}`, `b${k}`);
    }
    return jobs;
  }
  const failingDiamonds = stackedDiamonds(50);
  failingDiamonds["j0"]!.result = "failure";

  for (const row of [
    { run: run("a", { a: needsJob("", "b"), b: needsJob("failure") }), input: "failure()", statusCheck: DefaultStatusCheck.None, expected: true, name: "ancestor-failed" },
    {
      run: run("a", { a: needsJob("", "b"), b: needsJob("success", "c"), c: needsJob("success") }),
      input: "success()",
      statusCheck: DefaultStatusCheck.None,
      expected: true,
      name: "ancestor-of-ancestor-succeeded",
    },
    { run: run("a", { a: needsJob("success", "b"), b: needsJob("success", "a") }), input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "cycle-success" },
    { run: run("a", { a: needsJob("success", "b"), b: needsJob("success", "a") }), input: "failure()", statusCheck: DefaultStatusCheck.None, expected: false, name: "cycle-failure" },
    { run: run("a", { a: needsJob("success", "b"), b: needsJob("success", "a") }), input: "", statusCheck: DefaultStatusCheck.Success, expected: true, name: "cycle-default-status-check" },
    { run: run("j50", stackedDiamonds(50)), input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "stacked-diamonds-success" },
    { run: run("j50", failingDiamonds), input: "failure()", statusCheck: DefaultStatusCheck.None, expected: true, name: "stacked-diamonds-failure" },
    { run: run("a", { a: needsJob("", "ghost") }), input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "unknown-need-skipped" },
    { run: run("a", { a: needsJob("", "ghost"), ghost: undefined as unknown as JobShape }), input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "empty-need-skipped" },
    { run: run("nope", {}), input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "unknown-job-id" },
    { run: { jobId: "a" }, input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "nil-workflow" },
    { run: undefined, input: "success()", statusCheck: DefaultStatusCheck.None, expected: true, name: "nil-run" },
    { run: undefined, input: "failure()", statusCheck: DefaultStatusCheck.None, expected: false, name: "nil-run-failure" },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter({}, { run: row.run, context: "job" }).evaluate(row.input, row.statusCheck);
      expect(error?.message ?? null).toBeNull();
      expect(value).toBe(row.expected);
    });
  }
});

describe("status function arity (functions_test.go TestStatusFunctionArity)", () => {
  for (const row of [
    { input: "success('ci-complete')", context: "job", expected: true, error: "", name: "job-success-takes-arguments" },
    { input: "failure('a', 'b')", context: "job", expected: false, error: "", name: "job-failure-takes-arguments" },
    {
      input: "success('x')",
      context: "step",
      expected: null,
      error: "Too many parameters supplied: '('. Located at position 8 within expression: success('x')",
      name: "step-success-rejects-arguments",
    },
    {
      input: "failure('x')",
      context: "step",
      expected: null,
      error: "Too many parameters supplied: '('. Located at position 8 within expression: failure('x')",
      name: "step-failure-rejects-arguments",
    },
    {
      input: "always('x')",
      context: "job",
      expected: null,
      error: "Too many parameters supplied: '('. Located at position 7 within expression: always('x')",
      name: "always-rejects-arguments",
    },
    {
      input: "cancelled('x')",
      context: "job",
      expected: null,
      error: "Too many parameters supplied: '('. Located at position 10 within expression: cancelled('x')",
      name: "cancelled-rejects-arguments",
    },
  ]) {
    it(row.name, () => {
      const { value, error } = newInterpeter({}, { context: row.context }).evaluate(row.input, DefaultStatusCheck.None);
      if (row.error !== "") {
        expect(error?.message).toBe(row.error);
      } else {
        expect(error?.message ?? null).toBeNull();
        expect(value).toBe(row.expected);
      }
    });
  }
});

describe("calls status function (functions_test.go TestCallsStatusFunction)", () => {
  for (const row of [
    { input: "always()", want: true },
    { input: "ALWAYS()", want: true },
    { input: "!cancelled() && github.event_name == 'push'", want: true },
    { input: "contains(github.event.head_commit.message, failure())", want: true },
    { input: "'failure()'", want: false },
    { input: "github.event_name == 'push'", want: false },
    { input: "successful()", want: false },
  ]) {
    it(row.input, () => {
      const parsed = NewExprParser().Parse(new ExprLexer(row.input));
      expect(parsed.error).toBeNull();
      expect(callsStatusFunction(parsed.node!)).toBe(row.want);
    });
  }
});

describe("nil environment (functions_test.go TestNewInterpeterNilEnvironment)", () => {
  it("evaluates against a nil environment", () => {
    const { value, error } = newInterpeter(undefined, { context: "step" }).evaluate("github.event_name", DefaultStatusCheck.None);
    expect(error).toBeNull();
    expect(value).toBeNull();
  });
});

describe("string size (memory_test.go TestStringSize)", () => {
  it("charges UTF-16 units plus overhead", () => {
    expect(stringSize("")).toBe(26);
    expect(stringSize("abc")).toBe(32);
    expect(stringSize("é")).toBe(28); // two bytes are one UTF-16 unit
    expect(stringSize("😀")).toBe(30); // four bytes are a surrogate pair
    expect(stringSize("abcdefgh" + "é€😀".repeat(3) + "xy")).toBe(70);
    expect(utf16Len("é\u0080😀")).toBe(4);
  });
});

describe("memory cap (memory_test.go TestMemoryCap)", () => {
  const repeatValue = (count: number, value: unknown): unknown[] => new Array(count).fill(value);
  const leaf: Record<string, number> = {};
  const middle: Record<string, Record<string, number>> = {};
  const top: Record<string, Record<string, Record<string, number>>> = {};
  for (let i = 0; i < 60; i++) {
    leaf[String(i)] = i;
    middle[String(i)] = leaf;
    top[String(i)] = middle;
  }
  const repeated = "{0}".repeat(5);

  for (const row of [
    { value: "a".repeat(524275), name: "read at the cap", input: "inputs.value", wantErr: false },
    { value: "a".repeat(524276), name: "read over the cap", input: "inputs.value", wantErr: true },
    { value: "\u0080".repeat(524276), name: "invalid utf-8 over the cap", input: "inputs.value", wantErr: true },
    { value: "a".repeat(524275), name: "copy at the cap", input: "format(inputs.value)", wantErr: false },
    { value: "a".repeat(524276), name: "copy over the cap", input: "format(inputs.value)", wantErr: true },
    { value: "a".repeat(262131), name: "repeat at the cap", input: "format('{0}{0}', inputs.value)", wantErr: false },
    { value: "a".repeat(262132), name: "repeat over the cap", input: "format('{0}{0}', inputs.value)", wantErr: true },
    { value: "a".repeat(524273), name: "tojson at the cap", input: "toJSON(inputs.value)", wantErr: false },
    { value: "a".repeat(524274), name: "tojson over the cap", input: "toJSON(inputs.value)", wantErr: true },
    { value: repeatValue(29125, 1), name: "tojson tokens at the cap", input: "toJSON(inputs.value)", wantErr: false },
    { value: repeatValue(29126, 1), name: "tojson tokens over the cap", input: "toJSON(inputs.value)", wantErr: true },
    { value: repeatValue(14980, "aaaaaaaa"), name: "join at the cap", input: "join(inputs.value, '-')", wantErr: false },
    { value: repeatValue(14981, "aaaaaaaa"), name: "join over the cap", input: "join(inputs.value, '-')", wantErr: true },
    { value: repeatValue(131063, 1), name: "project at the cap", input: "inputs.value.*", wantErr: false },
    { value: repeatValue(131064, 1), name: "project over the cap", input: "inputs.value.*", wantErr: true },
    { value: top, name: "chain within the cap", input: "inputs.value.*.*", wantErr: false },
    { value: top, name: "chain over the cap", input: "inputs.value.*.*.*", wantErr: true },
    {
      value: "a".repeat(60000),
      name: "sibling within the cap",
      input: `startswith(format('${repeated}', inputs.value), 'a')`,
      wantErr: false,
    },
    {
      value: "a".repeat(60000),
      name: "siblings over the cap",
      input: `startswith(format('${repeated}', inputs.value), format('${repeated}', inputs.value))`,
      wantErr: true,
    },
  ]) {
    it(row.name, () => {
      const { error } = newInterpeter({ inputs: { value: row.value } }, {}).evaluate(row.input, DefaultStatusCheck.None);
      if (row.wantErr) {
        expect(error?.message).toContain("The maximum allowed memory size was exceeded");
      } else {
        expect(error?.message ?? null).toBeNull();
      }
    });
  }
});

describe("memory per evaluation (memory_test.go TestMemoryPerEvaluation)", () => {
  it("concurrent evaluations stay independent", () => {
    const env: EvaluationEnvironment = { inputs: { value: "a".repeat(400000) } };
    const interpeter = newInterpeter(env, {});
    // Eight re-entrant rounds over the one interpeter: every evaluate starts
    // from a fresh budget, the pin upstream makes with eight goroutines.
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 8; i++) {
        const { value, error } = interpeter.evaluate("format('{0}', inputs.value)", DefaultStatusCheck.None);
        expect(error?.message ?? null).toBeNull();
        expect(value).toHaveLength(400000);
      }
    }
  });
});

describe("interpeter strings (expreval evaluator_test.go)", () => {
  const evaluator = new Evaluator(
    (input, defaultStatusCheck) =>
      newInterpeter(
        {
          github: ordered([["event_name", "push"]]),
          env: { SOMETHING_TRUE: "true", SOMETHING_FALSE: "false" },
          job: { status: "success" },
          vars: { CASE_INSENSITIVE_VAR: "value" },
          matrix: { os: "ubuntu", n: 1000000000000000 },
          strategy: {},
        },
        { context: "step" },
      ).evaluate(input, defaultStatusCheck),
  );

  it("interpolates (TestInterpolate)", () => {
    for (const row of [
      { in: " text ", out: " text " },
      { in: " ${text} ", out: " ${text} " },
      { in: " ${{          1                         }} to ${{2}} ", out: " 1 to 2 " },
      { in: " ${{  (false   ||  '}}'  )    }} to ${{2}} ", out: " }} to 2 " },
      { in: "${{ vars.case_insensitive_var }}", out: "value" },
      { in: "${{ env.SOMETHING_TRUE }} && ${{ env.SOMETHING_FALSE }}", out: "true && false" },
      { in: "${{ 1.0 }}", out: "1" },
      { in: "build-${{ matrix.n }}", out: "build-1E+15" },
      { in: "${{ null }}", out: "" },
      { in: "a${{ }}b", out: "ab" },
      { in: "${{ fromJSON('[1,2]') }}", out: "Array" },
      { in: " ${{ fromJSON('{\"a\":1}') }} ", out: " Object " },
    ]) {
      const { value, error } = evaluator.interpolate(row.in);
      expect(error?.message ?? null).toBeNull();
      expect(value).toBe(row.out);
    }
    const broken = evaluator.interpolate("run ${{ 1) && (2 }} now");
    expect(broken.error).not.toBeNull();
    const unclosed = evaluator.interpolate("run ${{ 1 now");
    expect(unclosed.error?.message).toContain("unclosed expression");
  });

  it("evaluates scalars (TestEvaluateScalar)", () => {
    const scalar = evaluator.evaluateScalar("${{ fromJSON('[1,2]') }}");
    expect(scalar.error).toBeNull();
    expect(scalar.value).toEqual([1, 2]);

    const mixed = evaluator.evaluateScalar("a ${{ 1 }}");
    expect(mixed.error).toBeNull();
    expect(mixed.value).toBe("a 1");

    const unclosed = evaluator.evaluateScalar("${{ 'unclosed }}");
    expect(unclosed.error?.message).toContain("unclosed expression");
  });

  it("evaluates bools (TestEvalBool)", () => {
    for (const row of [
      { in: "github.event_name == 'push'", want: true },
      { in: "github.event_name == 'pull_request'", want: false },
      { in: "${{ matrix.os == 'ubuntu' }}", want: true },
      { in: "", want: true },
      { in: "a ${{ 1 }}", want: true },
      { in: "${{ '' }} ", want: true },
      { in: " ", want: true },
      { in: "\n  \n", want: true },
      { in: "${{ 'false' }}", want: false },
      { in: "${{ 'true' }}", want: true },
      { in: "${{ '' }}", want: true },
      { in: "${{ 'github.event_name == ''push''' }}", want: true },
    ]) {
      const { value, error } = evaluator.evalBool(row.in, DefaultStatusCheck.Success);
      expect(error?.message ?? null, row.in).toBeNull();
      expect(value, row.in).toBe(row.want);
    }
    const unknown = evaluator.evalBool("${{ 'abc' }}", DefaultStatusCheck.Success);
    expect(unknown.error?.message).toContain("Unrecognized named-value: 'abc'");
  });

  it("applies the default status check (TestEvalBoolStatusCheck)", () => {
    const failed = new Evaluator(
      (input, defaultStatusCheck) =>
        newInterpeter(
          {
            github: ordered([["event_name", "push"]]),
            job: { status: "failure" },
          },
          { context: "step" },
        ).evaluate(input, defaultStatusCheck),
    );

    let result = failed.evalBool("a ${{ 'b' }}", DefaultStatusCheck.Success);
    expect(result.error?.message ?? null).toBeNull();
    expect(result.value).toBe(false);

    result = failed.evalBool("${{ always() }} and ${{ 'more' }}", DefaultStatusCheck.Success);
    expect(result.error?.message ?? null).toBeNull();
    expect(result.value).toBe(true);

    result = failed.evalBool("a ${{ 'b' }}", DefaultStatusCheck.None);
    expect(result.error?.message ?? null).toBeNull();
    expect(result.value).toBe(true);
  });
});

describe("json reader dialect (json_test.go)", () => {
  it("reads GitHub's JSON dialect", () => {
    expect(parseJSON("1")).toBe(1);
    // A value that opens with a comment IS the comment text — the reader's
    // entry answers a leading comment before reading any value, exactly as
    // json.go:25-32 does.
    expect(parseJSON("// c\n1")).toBe(" c");
    expect(parseJSON("/* c */ 1")).toBe(" c ");
    expect(parseJSON("'str'")).toBe("str");
    expect(parseJSON("NaN")).toBeNaN();
    expect(parseJSON("Infinity")).toBe(Number.POSITIVE_INFINITY);
    expect(parseJSON("-Infinity")).toBe(Number.NEGATIVE_INFINITY);
    expect(parseJSON("undefined")).toBe("");
    // Objects read as the ordered object the evaluator resolves through —
    // json_test.go:20 asserts the same *orderedObject type.
    const object = parseJSON("{a:1}");
    expect(object).toBeInstanceOf(OrderedObject);
    expect((object as OrderedObject).get("a")).toEqual({ found: true, value: 1 });
    expect(parseJSON("[1,,2]")).toEqual([1, "", 2]);
    expect(parseJSON("0x10")).toBe(16);
    // Go reads a leading-0 number as octal (ParseUint(text, 8, 64) takes no
    // prefix under an explicit base), so "017" is 15 and "0o17" is invalid.
    expect(parseJSON("017")).toBe(15);
    expect(() => parseJSON("0o17")).toThrow(/invalid number '0o17' at offset 0/);
    expect(parseJSON("9223372036854775807")).toBe(Number("9223372036854775807"));
    expect(parseJSON("9223372036854775808")).toBe(9223372036854775808);
  });

  it("rejects malformed input", () => {
    expect(() => parseJSON("{")).toThrow();
    expect(() => parseJSON("[1,]")).not.toThrow(); // trailing separators read as empty strings
    expect(() => parseJSON("bogus")).toThrow(/unexpected character 'b' at offset 0/);
  });
});

describe("truthiness (interpreter.go IsTruthy)", () => {
  function nameOf(input: unknown): string {
    if (input === null) {
      return "null";
    }
    switch (typeof input) {
      case "string":
        return JSON.stringify(input);
      case "number":
      case "boolean":
        return `${input}`;
      case "object":
        return Array.isArray(input) ? "[]" : "{}";
      default:
        return typeof input;
    }
  }
  for (const row of [
    { input: null, want: false },
    { input: undefined, want: false },
    { input: true, want: true },
    { input: false, want: false },
    { input: "", want: false },
    { input: "abc", want: true },
    { input: 0, want: false },
    { input: -10, want: true },
    { input: Number.NaN, want: false },
    { input: {}, want: true },
    { input: [], want: true },
  ]) {
    it(`truthiness of ${nameOf(row.input)}`, () => {
      expect(isTruthy(row.input)).toBe(row.want);
    });
  }
});

// ---------------------------------------------------------------------------
// TestEvaluateYamlNode (pkg/expreval/evaluator_test.go:125-185, row-for-row)
// ---------------------------------------------------------------------------

describe("TestEvaluateYamlNode (the YAML-node walker)", () => {
  /** testEvaluator (evaluator_test.go:16-30): the bare environment. */
  const interpeter = newInterpeter({}, {});
  const evaluator = new Evaluator((input, check) => interpeter.evaluate(input, check));

  for (const tt of [
    {
      name: "scalar keeps its type and number formatting",
      // the parsed VALUES are the fixture parity; the 1e15 row is the recorded byte
      // divergence (go-yaml renders "1E+15", this emitter "1000000000000000" — same parsed
      // number; see evaluator.ts's header)
      input: "value: ${{ fromJSON('[1234567,1e15,{\"id\":2500000}]') }}\n",
      want: ["value:", "  - 1234567", "  - 1000000000000000", "  - id: 2500000"],
    },
    {
      name: "untouched value keeps its style",
      input: "value: 'plain'\n",
      want: ["value: 'plain'"],
    },
    {
      name: "an evaluated entry does not strip the comments around it",
      input: "a: 1 # before\nb: ${{ 1 }}\nc: 3 # after\n",
      want: ["a: 1 # before", "b: 1", "c: 3 # after"],
    },
    {
      name: "insert directive merges the nested map",
      input: "a: 1\n${{ insert }}: ${{ fromJSON('{\"b\":2}') }}\n",
      want: ["a: 1", "b: 2"],
    },
    {
      name: "an evaluated sequence merges into its parent",
      input: "- a\n- ${{ fromJSON('[\"b\",\"c\"]') }}\n",
      want: ["- a", "- b", "- c"],
    },
    {
      name: "a nested sequence stays nested",
      input: "- a\n- - ${{ 'b' }}\n",
      want: ["- a", "- - b"],
    },
    {
      name: "binary scalar evaluates its decoded expression",
      input: "value: !!binary JHt7IDEgfX0=\n",
      want: ["value: 1"],
    },
  ] as Array<{ name: string; input: string; want: string[] }>) {
    it(tt.name, () => {
      const doc = parseDocument(tt.input);
      expect(doc.errors).toEqual([]);
      const node = doc.contents as YamlNode;
      const outcome = evaluateYamlNode(evaluator, node);
      expect(outcome.error).toBeNull();
      expect(tt.name === "untouched value keeps its style" ? outcome.replacement === null : outcome.replacement !== null).toBe(true);
      // the replacement is grafted back (the caller's slot — here the doc root)
      if (outcome.replacement !== null) {
        doc.contents = outcome.replacement as typeof doc.contents;
      }
      const lines = (doc.toString({ lineWidth: 0 })).replace(/\n$/, "").split("\n");
      expect(lines).toEqual(tt.want);
    });
  }

  it("an untouched value answers no replacement", () => {
    const doc = parseDocument("value: 'plain'\n");
    const outcome = evaluateYamlNode(evaluator, doc.contents as YamlNode);
    expect(outcome.error).toBeNull();
    expect(outcome.replacement).toBeNull();
  });

  it("TestEvaluateYamlNodeInsertNonMapping — an insert of a non-mapping errors", () => {
    const doc = parseDocument("${{ insert }}: ${{ 'text' }}\n");
    const outcome = evaluateYamlNode(evaluator, doc.contents as YamlNode);
    expect(outcome.error?.message).toContain("expected MappingNode");
  });
});
