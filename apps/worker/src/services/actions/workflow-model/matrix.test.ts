// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The matrix model suite — the 1:1 port of actionslib v1.5.0
// pkg/model/matrix_test.go's TestGetMatrixes, TestJobMatrix and
// TestGetMatrixesCombinationLimit tables (the fixture rows in source order),
// over the module's own readJob helper (workflow_test.go:792-798's
// yaml.Unmarshal into a Job, whose strategy slots the expansion functions
// read).
//
// One adapted row: "an invalid sequence value reports its axis" — the error
// text carries go-yaml's own resolver wording ("go-yaml load error in
// resolver"); the `yaml` package words the same unreadable tag "Unresolved
// tag", so the row asserts the axis-naming prefix plus the unresolved tag.

import type { Node as YamlNode } from "yaml";
import { isMap } from "yaml";
import { describe, expect, it } from "vitest";

import { MAX_MATRIX_COMBINATIONS, getMatrixes, jobMatrix, matrixCombinations } from "./matrix";
import { parseWorkflowDocument } from "./yaml-nodes";

/** readJob (workflow_test.go:792-798) — a job body parse returning the two
 *  strategy slots the model's expansion functions read: the strategy node
 *  (RawStrategy) and its matrix node (RawMatrix). */
function readJobSlots(jobYaml: string): { strategy: { present: boolean; node: YamlNode }; rawMatrix: YamlNode | undefined } {
  const { doc } = parseWorkflowDocument(jobYaml);
  const warning = doc.warnings[0];
  if (warning !== undefined) {
    throw new Error(warning.message.split("\n")[0] ?? warning.message);
  }
  const strategyNode = doc.get("strategy", true) as YamlNode | undefined;
  let rawMatrix: YamlNode | undefined;
  if (strategyNode !== undefined && isMap(strategyNode)) {
    rawMatrix = (strategyNode).get("matrix", true);
  }
  return { strategy: { present: strategyNode !== undefined, node: (strategyNode ?? null) as YamlNode }, rawMatrix };
}

function getMatrixesOf(jobYaml: string): Array<Record<string, unknown>> {
  const { strategy, rawMatrix } = readJobSlots(jobYaml);
  return getMatrixes(strategy, rawMatrix);
}

function combinationsOf(jobYaml: string) {
  const { strategy, rawMatrix } = readJobSlots(jobYaml);
  return matrixCombinations(strategy, rawMatrix);
}

interface GetMatrixesCase {
  name: string;
  job: string;
  want?: Array<Record<string, unknown>>;
  wantNames?: unknown[][];
  wantErr?: string;
}

const GET_MATRIXES_CASES: GetMatrixesCase[] = [
  {
    name: "no strategy runs the job once",
    job: "runs-on: ubuntu-latest\n",
    want: [{}],
  },
  {
    name: "multiple keys expand with the first varying slowest",
    job: "strategy:\n  matrix:\n    os: [ubuntu-22.04, ubuntu-20.04]\n    version: [10, 12, 14]\n",
    want: [
      { os: "ubuntu-22.04", version: 10 },
      { os: "ubuntu-22.04", version: 12 },
      { os: "ubuntu-22.04", version: 14 },
      { os: "ubuntu-20.04", version: 10 },
      { os: "ubuntu-20.04", version: 12 },
      { os: "ubuntu-20.04", version: 14 },
    ],
  },
  {
    name: "arrays retain scalar value types",
    job: "strategy: {matrix: {os: [ubuntu-latest], version: [1.19], node: [14, 16], count: [42], enabled: [true], optional: [null]}}\n",
    want: [
      { os: "ubuntu-latest", version: 1.19, node: 14, count: 42, enabled: true, optional: null },
      { os: "ubuntu-latest", version: 1.19, node: 16, count: 42, enabled: true, optional: null },
    ],
  },
  {
    name: "an invalid sequence value reports its axis",
    job: "strategy: {matrix: {os: [!!int nope]}}\n",
    wantErr: "Unresolved tag: tag:yaml.org,2002:int",
  },
  {
    name: "a duplicate axis is rejected before expansion",
    job: "strategy:\n  matrix: {a: [1, 2], a: [3, 4]}\n",
    wantErr: `Matrix key "a" is defined more than once`,
  },
  {
    name: "a duplicate include is rejected before expansion",
    job: "strategy:\n  matrix: {include: [{os: ubuntu}], include: [{os: windows}]}\n",
    wantErr: `Matrix key "include" is defined more than once`,
  },
  {
    name: "a duplicate exclude is rejected before expansion",
    job: "strategy:\n  matrix: {os: [ubuntu, windows], exclude: [{os: ubuntu}], exclude: [{os: windows}]}\n",
    wantErr: `Matrix key "exclude" is defined more than once`,
  },
  {
    name: "the documented include example",
    job: `
strategy:
  matrix:
    fruit: [apple, pear]
    animal: [cat, dog]
    include:
      - color: green
      - color: pink
        animal: cat
      - fruit: apple
        shape: circle
      - fruit: banana
      - fruit: banana
        animal: cat
`,
    want: [
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ],
    wantNames: [
      ["apple", "cat"],
      ["apple", "dog"],
      ["pear", "cat"],
      ["pear", "dog"],
      ["banana"],
      ["banana", "cat"],
    ],
  },
  {
    name: "names list decoded scalars in YAML order, include-only keys with the axes first",
    job: "strategy:\n  matrix:\n    zeta: [&z z]\n    alpha: [{&k b: 2, a: [x, {c: null}], e: {}}]\n    v: [<<, a]\n    w: [{<<: {y: merged, a: old}, a: new}]\n    x: [{2: two, 1: one}]\n    include: [{*k : 3, a: 1, alpha: *z, zeta: other}]\n",
    want: [
      {
        zeta: "z",
        alpha: { b: 2, a: ["x", { c: null }], e: {} },
        v: "a",
        w: { y: "merged", a: "new" },
        x: { "2": "two", "1": "one" },
      },
      { b: 3, a: 1, alpha: "z", zeta: "other" },
    ],
    wantNames: [["z", 2, "x", null, "a", "new", "merged", "two", "one"], ["z", "other", 3, 1]],
  },
  {
    name: "include and exclude match with expression equality and include only their extra keys",
    job: "strategy:\n  matrix:\n    os: [linux, macos]\n    node: [1]\n    cfg: [{a: 1, b: [x, y]}]\n    exclude: [{OS: MACOS}]\n    include: [{os: LINUX, node: '1', cfg: {a: true, b: [x]}, extra: e}, {Os: windows, extra: w}]\n",
    want: [
      { os: "linux", node: 1, cfg: { a: 1, b: ["x", "y"] }, extra: "e" },
      { Os: "windows", extra: "w" },
    ],
    wantNames: [["linux", 1, 1, "x", "y"], ["windows", "w"]],
  },
  {
    name: "an include-only matrix is its includes",
    job: "strategy:\n  matrix:\n    include:\n      - os: ubuntu\n      - os: windows\n",
    want: [{ os: "ubuntu" }, { os: "windows" }],
  },
  {
    name: "exclude drops the matching combinations",
    job: "strategy:\n  matrix:\n    os: [ubuntu, windows]\n    version: [10, 12]\n    exclude:\n      - os: windows\n        version: 10\n",
    want: [
      { os: "ubuntu", version: 10 },
      { os: "ubuntu", version: 12 },
      { os: "windows", version: 12 },
    ],
  },
  {
    name: "a fully excluded matrix runs once with an empty matrix context",
    job: "strategy:\n  matrix: {os: [ubuntu], exclude: [{os: ubuntu}]}\n",
    want: [{}],
  },
  {
    name: "an include adds back an excluded combination",
    job: "strategy:\n  matrix:\n    os: [ubuntu]\n    exclude:\n      - os: ubuntu\n    include:\n      - os: ubuntu\n",
    want: [{ os: "ubuntu" }],
  },
  {
    name: "an empty include list is rejected",
    job: "strategy:\n  matrix:\n    include: []\n",
    wantErr: "Matrix must define at least one vector",
  },
  {
    name: "an empty matrix is rejected",
    job: "strategy:\n  matrix: {}\n",
    wantErr: "Matrix must define at least one vector",
  },
  {
    name: "an empty vector is rejected",
    job: "strategy:\n  matrix:\n    os: []\n",
    wantErr: `Matrix vector "os" does not contain any values`,
  },
  {
    name: "a null matrix is rejected",
    job: "strategy:\n  matrix:\n",
    wantErr: `Matrix "" is not a map of matrix keys to values`,
  },
  {
    name: "an unevaluated axis expression is rejected before expansion",
    job: "strategy:\n  matrix:\n    os: ${{ fromJSON(inputs.oses) }}\n",
    wantErr: `Matrix vector "os" is not a list of values`,
  },
  {
    name: "evaluated text retains expression delimiters through axes and nested include and exclude aliases",
    job: `\
strategy:
  matrix:
    text: &texts [&text '\${{ literal }}', &excluded excluded]
    copy: *texts
    include: [{config: {version: [*text]}}]
    exclude: [{text: *excluded}]
`,
    want: [
      { text: "${{ literal }}", copy: "${{ literal }}", config: { version: ["${{ literal }}"] } },
      { text: "${{ literal }}", copy: "excluded", config: { version: ["${{ literal }}"] } },
    ],
  },
  {
    name: "an unevaluated whole-matrix expression is rejected",
    job: "strategy:\n  matrix: ${{ fromJson(needs.setup.outputs.matrix) }}\n",
    wantErr: `Matrix "\${{ fromJson(needs.setup.outputs.matrix) }}" is not a map of matrix keys to values`,
  },
  {
    name: "an unevaluated whole-strategy expression is rejected",
    job: "strategy: ${{ fromJson(inputs.strategy) }}\n",
    wantErr: `Strategy "\${{ fromJson(inputs.strategy) }}" is not a map of strategy keys to values`,
  },
  {
    name: "an exclude naming no matrix key is rejected",
    job: "strategy:\n  matrix:\n    os: [ubuntu]\n    exclude:\n      - platform: windows\n",
    wantErr: `Matrix exclude key "platform" does not match any key within the matrix`,
  },
  {
    name: "an include that is not a list is rejected",
    job: "strategy:\n  matrix:\n    os: [ubuntu]\n    include: ${{ fromJson(vars.INCLUDE) }}\n",
    wantErr: "Matrix include is not a list of maps of matrix keys to values",
  },
  {
    name: "an include entry that is not a map is rejected",
    job: "strategy:\n  matrix:\n    os: [ubuntu]\n    include: [ubuntu]\n",
    wantErr: `Matrix include entry "ubuntu" is not a map of matrix keys to values`,
  },
  {
    name: "a nested object value is rejected",
    job: "strategy:\n  matrix:\n    config:\n      os: ubuntu\n",
    wantErr: `Matrix vector "config" is not a list of values`,
  },
  {
    name: "a nested object with a non-string key is rejected",
    job: "strategy:\n  matrix: {config: {1: ubuntu}}\n",
    wantErr: `Matrix vector "config" is not a list of values`,
  },
  {
    name: "a list of objects remains a valid axis",
    job: "strategy:\n  matrix: {config: [{os: ubuntu}]}\n",
    want: [{ config: { os: "ubuntu" } }],
  },
];

describe("TestGetMatrixes (pkg/model/matrix_test.go, row-for-row)", () => {
  for (const tc of GET_MATRIXES_CASES) {
    it(tc.name, () => {
      let got: Array<Record<string, unknown>> | null = null;
      let err: Error | null = null;
      try {
        got = getMatrixesOf(tc.job);
      } catch (thrown) {
        err = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
      if (tc.wantErr !== undefined) {
        expect(err).not.toBeNull();
        expect(err!.message).toContain(tc.wantErr);
        expect(got).toBeNull();
        return;
      }
      expect(err).toBeNull();
      expect(got).toEqual(tc.want);
      if (tc.wantNames !== undefined) {
        const combinations = combinationsOf(tc.job);
        for (let i = 0; i < tc.wantNames.length; i++) {
          expect(combinations[i]!.nameValues).toEqual(tc.wantNames[i]);
        }
      }
    });
  }
});

describe("TestJobMatrix (pkg/model/matrix_test.go)", () => {
  it("a no-strategy job answers the empty map", () => {
    const { strategy, rawMatrix } = readJobSlots("runs-on: ubuntu-latest\n");
    expect(jobMatrix(strategy, rawMatrix)).toEqual({});
  });

  it("a scalar axis rejects like GetMatrixes", () => {
    const { strategy, rawMatrix } = readJobSlots("strategy:\n  matrix:\n    os: ubuntu-latest\n");
    expect(() => jobMatrix(strategy, rawMatrix)).toThrow(`Matrix vector "os" is not a list of values`);
    expect(() => getMatrixes(strategy, rawMatrix)).toThrow(`Matrix vector "os" is not a list of values`);
  });
});

describe("TestGetMatrixesCombinationLimit (pkg/model/matrix_test.go)", () => {
  const axis = (name: string, count: number): string =>
    `    ${name}: [${Array.from({ length: count }, (_, i) => String(i)).join(", ")}]\n`;

  it("exactly the limit expands", () => {
    const got = getMatrixesOf(`strategy:\n  matrix:\n${axis("a", 16)}${axis("b", 16)}`);
    expect(got.length).toBe(MAX_MATRIX_COMBINATIONS);
  });

  it("one over the limit rejects", () => {
    expect(() => getMatrixesOf(`strategy:\n  matrix:\n${axis("a", 16)}${axis("b", 17)}`)).toThrow(
      "exceeding the limit of 256",
    );
  });

  it("include-only over the limit rejects", () => {
    const includes = Array.from({ length: MAX_MATRIX_COMBINATIONS + 1 }, () => "      - os: ubuntu\n").join("");
    expect(() => getMatrixesOf(`strategy:\n  matrix:\n    include:\n${includes}`)).toThrow("exceeding the limit of 256");
  });
});
