// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The corpus conformance suite — the port of actionslib v1.5.0
// pkg/exprparser/languageservices_test.go, running the module's own
// testdata/languageservices fixtures (GitHub actions-languageservices'
// expression corpus, compacted to one case per line) through the evaluator
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the submodule's pin).
//
// Upstream's gate is `require.Equal(t, 1020, passed)` (languageservices_
// test.go:69); the same 1020 cases ride the copied testdata/ here, with the
// same eight runnerErrors overrides where actionslib words an error
// differently than languageservices recorded (languageservices_test.go:23-33,
// byte-exact).

import { describe, expect, it } from "vitest";

import { newInterpeter, ParseEvalError, DefaultStatusCheck } from "./interpreter";
import { getEvaluationKind, EvaluationKind, numberValue } from "./kinds";
import { OrderedObject } from "./object";
import { parseJSON } from "./json";

const corpusModules = import.meta.glob("./testdata/languageservices/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface CorpusExpected {
  kind: string;
  value?: unknown;
}

interface CorpusCase {
  expr: string;
  contexts?: unknown;
  result?: CorpusExpected;
  err?: CorpusExpected;
}

// languageservices_test.go:23-33 — the runner's own output where
// languageservices records different text.
const RUNNER_ERRORS: Record<string, string> = {
  "case/case/27":
    "Even number of parameters supplied, requires an odd number of parameters: '('. Located at position 5 within expression: case(true, 'first', false, 'second')",
  "join/join/15": "Too few parameters supplied: '('. Located at position 5 within expression: join()",
  "join/join/16": "Too many parameters supplied: '('. Located at position 5 within expression: join(1, 2, 3)",
  "startsWith/basics/9": "Too many parameters supplied: '('. Located at position 11 within expression: startsWith('true', false, true)",
  "startsWith/basics/10": "Too few parameters supplied: '('. Located at position 11 within expression: startsWith('true')",
  "syntax-errors/parsing-errors/12": "Unrecognized function: 'nonExistentFunction'. Located at position 1 within expression: nonExistentFunction()",
  "syntax-errors/parsing-errors/13":
    "Unrecognized function: 'nonExistentFunction'. Located at position 10 within expression: false && nonExistentFunction()",
  "syntax-errors/memory-errors/0":
    "The maximum allowed memory size was exceeded while evaluating the following expression: " +
    `startswith(format('${"{0}".repeat(40)}', tojson(github)), format('${"{0}".repeat(40)}', tojson(github)))`,
};

function corpusKind(value: unknown): string {
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Null:
      return "Null";
    case EvaluationKind.Boolean:
      return "Boolean";
    case EvaluationKind.Number:
      return "Number";
    case EvaluationKind.String:
      return "String";
    case EvaluationKind.Array:
      return "Array";
    default:
      return "Object";
  }
}

/** corpusEqual mirrors languageservices_test.go:131-145: numbers compare as doubles, everything else after a JSON round trip. */
function corpusEqual(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number") {
    const actualNumber = numberValue(actual);
    return expected === actualNumber || (Number.isNaN(expected) && Number.isNaN(actualNumber));
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(JSON.stringify(actual ?? null));
  } catch {
    return false;
  }
  return deepEqual(expected, decoded);
}

function deepEqual(expected: unknown, actual: unknown): boolean {
  if (expected === actual) {
    return true;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length === actual.length && expected.every((item, i) => deepEqual(item, actual[i]));
  }
  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    if (expectedKeys.length !== Object.keys(actualRecord).length) {
      return false;
    }
    return expectedKeys.every((key) => key in actualRecord && deepEqual(expectedRecord[key], actualRecord[key]));
  }
  return false;
}

/** checkCorpusCase mirrors languageservices_test.go:85-112, returning a failure description or null. */
function checkCorpusCase(testCase: CorpusCase, value: unknown, error: Error | null): string | null {
  const isParseError = error instanceof ParseEvalError;
  if (testCase.err !== undefined) {
    if (error === null) {
      return `expected a ${testCase.err.kind} error, got ${String(value)}`;
    }
    if (testCase.err.kind === "evaluation" && isParseError) {
      return "expected an evaluation error, got " + error.message;
    }
    if (testCase.err.kind !== "evaluation" && !isParseError) {
      return "expected a " + testCase.err.kind + " error, got " + error.message;
    }
    if (error.message !== testCase.err.value) {
      return `expected error '${String(testCase.err.value)}', got '${error.message}'`;
    }
    return null;
  }
  if (error !== null) {
    return "unexpected error: " + error.message;
  }
  const kind = corpusKind(value);
  if (testCase.result === undefined || kind !== testCase.result.kind) {
    return `expected kind ${testCase.result?.kind}, got ${kind} (${String(value)})`;
  }
  if (!corpusEqual(testCase.result.value, value)) {
    return `expected ${JSON.stringify(testCase.result.value ?? null)}, got ${JSON.stringify(value ?? null)}`;
  }
  return null;
}

/** useCorpusContexts mirrors languageservices_test.go:147-162: the case's parsed contexts replace the named-value table. */
function corpusContexts(testCase: CorpusCase): Record<string, unknown> {
  const roots: Record<string, unknown> = {};
  if (testCase.contexts === undefined || testCase.contexts === null) {
    return roots;
  }
  const decoded = parseJSON(JSON.stringify(testCase.contexts));
  if (!(decoded instanceof OrderedObject)) {
    throw new Error("contexts is not an object");
  }
  for (const [name, value] of decoded.all()) {
    roots[name.toLowerCase()] = value;
  }
  return roots;
}

// The corpus files, one case per line, suites sorted per file — the order the
// names (and the runnerErrors keys) are built from.
interface NamedCase {
  name: string;
  testCase: CorpusCase;
}
const namedCases: NamedCase[] = [];
for (const path of Object.keys(corpusModules).sort()) {
  const fileName = path.split("/").pop()!.replace(/\.json$/, "");
  const suites = JSON.parse(corpusModules[path]!) as Record<string, CorpusCase[]>;
  for (const suite of Object.keys(suites).sort()) {
    suites[suite]!.forEach((testCase, index) => {
      const name = `${fileName}/${suite}/${index}`;
      const override = RUNNER_ERRORS[name];
      namedCases.push({
        name,
        testCase: override !== undefined ? { ...testCase, err: { kind: testCase.err?.kind ?? "", value: override } } : testCase,
      });
    });
  }
}

describe("actions-languageservices corpus", () => {
  it("carries exactly upstream's 1020 cases", () => {
    expect(namedCases.length).toBe(1020);
  });

  for (const { name, testCase } of namedCases) {
    it(name, () => {
      const interpeter = newInterpeter({}, { contextRoots: corpusContexts(testCase) });
      const { value, error } = interpeter.evaluate(testCase.expr, DefaultStatusCheck.None);
      const failure = checkCorpusCase(testCase, value, error);
      if (failure !== null) {
        expect.fail(`${failure}\nexpr: ${testCase.expr}`);
      }
    });
  }
});
