// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/model/matrix.go — the matrix expansion over
// an evaluated `strategy.matrix` node (gitea.dev/actionslib v1.5.0,
// gitea/go.mod:11, the submodule's pin; SPEC-0012 §D5 tier E, the E5 model
// port). Fixture discipline: pkg/model/matrix_test.go's TestGetMatrixes,
// TestJobMatrix and TestGetMatrixesCombinationLimit tables port 1:1 in
// ./matrix.test.ts.
//
// Platform adaptation: go-yaml nodes map onto the `yaml` package's (Scalar /
// YAMLMap / YAMLSeq); go-yaml's Decode-into-`any` maps onto decodeYamlValue
// (job.ts), which also expands the merge keys a go-yaml Decode applies and
// drops the merge-tagged scalars a sequence decode drops (the matrix_test.go
// "names list decoded scalars in YAML order" fixture pins both). Alias nodes
// are resolved by resolveYamlAliases before a job reaches this module, so
// the resolveAlias arm answers its own input.

import type { Node as YamlNode } from "yaml";
import { isMap, isScalar, isSeq } from "yaml";

import { type MatrixNode, cloneNode, decodeYamlValue, parseWorkflowDocument, resolveAlias, textScalar, yamlEntryPairs } from "./yaml-nodes";

/** MaxMatrixCombinations (matrix.go:16) — GitHub's documented hard maximum of matrix combinations per job. */
export const MAX_MATRIX_COMBINATIONS = 256;

/** matrixAxis (matrix.go:19) is one declared `strategy.matrix` key with its values. */
interface MatrixAxis {
  name: string;
  values: unknown[];
  node: YamlNode | null;
}

/** matrix (matrix.go:24) keeps axes in YAML declaration order for GitHub's first-axis-slowest expansion. */
interface ParsedMatrix {
  axes: MatrixAxis[];
  include: Array<Record<string, unknown>>;
  includeNodes: (YamlNode | null)[];
  exclude: Array<Record<string, unknown>>;
}

/** MatrixCombination (matrix.go:29) is an expanded combination with the scalars its default job name lists, in order. */
export interface MatrixCombination {
  values: Record<string, unknown>;
  nameValues: unknown[];
}

/** The module's error shape: upstream words every rejection
 *  "the workflow is not valid. …" — the message text is load-bearing
 *  (jobparser wraps it verbatim into "Parse: %w" / insert aborts). */
export class MatrixModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixModelError";
  }
}

/**
 * matrixOf (matrix.go:34-100) decodes the evaluated RawMatrix into its axes,
 * include and exclude entries, in declaration order. A job that declares no
 * strategy (or a strategy with no matrix) has no matrix, which is not an
 * error — null answers. A whole-value `strategy:` scalar that never got
 * evaluated (the deferred-expressions arm) rejects before the matrix reads.
 */
export function matrixOf(rawStrategy: MatrixNode, rawMatrix: YamlNode | undefined): ParsedMatrix | null {
  if (rawStrategy.present && !isMap(resolveAlias(rawStrategy.node))) {
    throw new MatrixModelError(
      `the workflow is not valid. Strategy ${JSON.stringify(nodeScalarText(rawStrategy.node))} is not a map of strategy keys to values`,
    );
  }
  if (!rawStrategy.present || rawMatrix === undefined) {
    return null;
  }
  const matrixNode = resolveAlias(rawMatrix);
  if (!isMap(matrixNode)) {
    throw new MatrixModelError(
      `the workflow is not valid. Matrix ${JSON.stringify(nodeScalarText(rawMatrix))} is not a map of matrix keys to values`,
    );
  }

  const parsed: ParsedMatrix = { axes: [], include: [], includeNodes: [], exclude: [] };
  const seen = new Set<string>();
  for (const [nameNode, valueNode] of yamlEntryPairs(matrixNode)) {
    const name = nodeScalarText(nameNode);
    if (seen.has(name)) {
      throw new MatrixModelError(`the workflow is not valid. Matrix key ${JSON.stringify(name)} is defined more than once`);
    }
    seen.add(name);
    switch (name) {
      case "include":
      case "exclude": {
        const entries = matrixEntries(name, valueNode);
        if (name === "include") {
          parsed.include = entries;
          const resolved = resolveAlias(valueNode);
          parsed.includeNodes = (resolved !== undefined && isSeq(resolved) ? (resolved.items as YamlNode[]) : []).map((item) =>
            cloneNode(item),
          );
        } else {
          parsed.exclude = entries;
        }
        break;
      }
      default: {
        const resolved = resolveAlias(valueNode) ?? valueNode;
        if (!isSeq(resolved)) {
          throw new MatrixModelError(
            `the workflow is not valid. Matrix vector ${JSON.stringify(name)} is not a list of values`,
          );
        }
        const values = decodeYamlValue(resolved);
        if (!Array.isArray(values)) {
          // decodeYamlValue of a sequence node is always an array; the guard
          // mirrors upstream's Decode error arm, unreachable over a sequence
          throw new MatrixModelError(`the workflow is not valid. Matrix key ${JSON.stringify(name)}: decode error`);
        }
        parsed.axes.push({ name, values, node: cloneNode(resolved) });
      }
    }
  }
  if (parsed.axes.length === 0 && parsed.include.length === 0) {
    throw new MatrixModelError("the workflow is not valid. Matrix must define at least one vector");
  }
  return parsed;
}

/** nodeScalarText reads a node the way go-yaml's `.Value` field carries it —
 *  the literal scalar text, "" for a collection. */
function nodeScalarText(node: YamlNode | undefined): string {
  if (node === undefined) return "";
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    if (resolved.value === null || resolved.value === undefined) return "";
    if (typeof resolved.value === "string") return resolved.value;
    if (typeof resolved.value === "boolean") return resolved.value ? "true" : "false";
    if (typeof resolved.value === "number") return String(resolved.value);
    return "";
  }
  return "";
}

/** matrixEntries (matrix.go:105-118) decodes an `include` or `exclude`, which GitHub requires to be a list of maps. */
function matrixEntries(name: string, node: YamlNode): Array<Record<string, unknown>> {
  const resolved = resolveAlias(node) ?? node;
  if (!isSeq(resolved)) {
    throw new MatrixModelError(
      `the workflow is not valid. Matrix ${name} is not a list of maps of matrix keys to values`,
    );
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const item of resolved.items as YamlNode[]) {
    const entry = decodeYamlValue(item);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MatrixModelError(
        `the workflow is not valid. Matrix ${name} entry ${JSON.stringify(nodeScalarText(item))} is not a map of matrix keys to values`,
      );
    }
    entries.push(entry as Record<string, unknown>);
  }
  return entries;
}

/**
 * Matrix (matrix.go:123-150) decodes the evaluated RawMatrix into its axes,
 * include and exclude entries. Axis values must be sequences, as in
 * GetMatrixes. The returned record does not preserve the declaration order
 * used by GetMatrixes.
 */
export function jobMatrix(rawStrategy: MatrixNode, rawMatrix: YamlNode | undefined): Record<string, unknown[]> {
  const parsed = matrixOf(rawStrategy, rawMatrix);
  if (parsed === null) {
    return {};
  }
  const val: Record<string, unknown[]> = {};
  for (const axis of parsed.axes) {
    val[axis.name] = axis.values;
  }
  const entriesOf: Array<[string, Array<Record<string, unknown>> | null]> = [
    ["include", parsed.include],
    ["exclude", parsed.exclude],
  ];
  for (const [name, entries] of entriesOf) {
    if (entries !== null) {
      val[name] = entries.map((entry) => entry);
    }
  }
  return val;
}

/** GetMatrixes (matrix.go:153-162) expands evaluated matrix sequences in declaration order, rejecting excludes with undeclared keys. */
export function getMatrixes(rawStrategy: MatrixNode, rawMatrix: YamlNode | undefined): Array<Record<string, unknown>> {
  return matrixCombinations(rawStrategy, rawMatrix).map((combination) => combination.values);
}

/**
 * MatrixCombinations (matrix.go:165-227) is GetMatrixes with each
 * combination's NameValues. Errors throw (a MatrixModelError) — upstream
 * surfaces them through Parse/ExpandMatrixWithNeeds, which abort the
 * insert or fail the job late (the D5 posture).
 */
export function matrixCombinations(rawStrategy: MatrixNode, rawMatrix: YamlNode | undefined): MatrixCombination[] {
  const parsed = matrixOf(rawStrategy, rawMatrix);
  if (parsed === null) {
    return [{ values: {}, nameValues: [] }];
  }

  let product = 1;
  const declaredKeys = new Set<string>();
  for (const axis of parsed.axes) {
    if (axis.values.length === 0) {
      throw new MatrixModelError(
        `the workflow is not valid. Matrix vector ${JSON.stringify(axis.name)} does not contain any values`,
      );
    }
    declaredKeys.add(axis.name.toLowerCase());
    product *= axis.values.length;
    if (product > MAX_MATRIX_COMBINATIONS) {
      throw tooManyCombinations(product);
    }
  }

  for (const exclude of parsed.exclude) {
    for (const key of Object.keys(exclude)) {
      if (!declaredKeys.has(key.toLowerCase())) {
        throw new MatrixModelError(
          `the workflow is not valid. Matrix exclude key ${JSON.stringify(key)} does not match any key within the matrix`,
        );
      }
    }
  }

  const combinations: MatrixCombination[] = [];
  for (const combination of cartesianProduct(parsed.axes, product)) {
    if (!parsed.exclude.some((exclude) => matchesMatrixKeys(combination.values, exclude, declaredKeys))) {
      combinations.push(combination);
    }
  }

  const extra: MatrixCombination[] = [];
  for (let i = 0; i < parsed.include.length; i++) {
    const include = parsed.include[i]!;
    let matched = false;
    for (const combination of combinations) {
      if (matchesMatrixKeys(combination.values, include, declaredKeys)) {
        for (const [key, value] of Object.entries(include)) {
          if (!declaredKeys.has(key.toLowerCase())) {
            combination.values[key] = value;
          }
        }
        matched = true;
      }
    }
    if (!matched) {
      extra.push({
        values: include,
        nameValues: includeNameValues(include, parsed.includeNodes[i] ?? null, declaredKeys),
      });
    }
  }
  combinations.push(...extra);

  if (combinations.length === 0) {
    return [{ values: {}, nameValues: [] }];
  }
  if (combinations.length > MAX_MATRIX_COMBINATIONS) {
    throw tooManyCombinations(combinations.length);
  }
  return combinations;
}

/** includeNameValues (matrix.go:229-240): the axes first, then the include-only keys, each in node order. */
function includeNameValues(include: Record<string, unknown>, node: YamlNode | null, declaredKeys: Set<string>): unknown[] {
  const axes: Record<string, unknown> = {};
  const others: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(include)) {
    if (declaredKeys.has(key.toLowerCase())) {
      axes[key] = value;
    } else {
      others[key] = value;
    }
  }
  return appendScalars(appendScalars([], axes, node), others, node);
}

/**
 * appendScalars (matrix.go:243-272) appends the scalars of value, ordering
 * mapping keys like node, which value was decoded from. Leftover keys sort
 * (Go's slices.Sorted(maps.Keys)); merge-key pairs the decoder dropped are
 * skipped the same way.
 */
function appendScalars(scalars: unknown[], value: unknown, node: YamlNode | null): unknown[] {
  const resolved = resolveAlias(node);
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const remaining: Record<string, unknown> = { ...record };
    if (resolved !== undefined && isMap(resolved)) {
      for (const [keyNode, itemNode] of yamlEntryPairs(resolved)) {
        const key = nodeScalarText(keyNode);
        if (key === "<<") continue; // the decoder dropped the merge pair
        if (key in remaining) {
          const item = remaining[key];
          delete remaining[key];
          appendScalars(scalars, item, itemNode);
        }
      }
    }
    for (const key of Object.keys(remaining).sort()) {
      appendScalars(scalars, remaining[key], null);
    }
    return scalars;
  }
  if (Array.isArray(value)) {
    const resolvedSeq = resolved !== undefined && isSeq(resolved) ? resolved : null;
    const items = resolvedSeq ? (resolvedSeq.items as YamlNode[]) : null;
    for (let i = 0; i < value.length; i++) {
      appendScalars(scalars, value[i], items !== null && items.length === value.length ? items[i]! : null);
    }
    return scalars;
  }
  scalars.push(value);
  return scalars;
}

/** errTooManyCombinations (matrix.go:342-344). */
function tooManyCombinations(count: number): MatrixModelError {
  return new MatrixModelError(
    `the workflow is not valid. Matrix expands to ${count} combinations, exceeding the limit of ${MAX_MATRIX_COMBINATIONS}`,
  );
}

/** matchesMatrixKeys (matrix.go:347-354): only declared keys filter. */
function matchesMatrixKeys(combination: Record<string, unknown>, entry: Record<string, unknown>, declaredKeys: Set<string>): boolean {
  for (const [key, filter] of Object.entries(entry)) {
    if (declaredKeys.has(key.toLowerCase()) && !matchesFilter(propertyFold(combination, key), filter)) {
      return false;
    }
  }
  return true;
}

/** matchesFilter (matrix.go:359-384) compares each scalar of filter with the value at its path using expression equality. */
function matchesFilter(value: unknown, filter: unknown): boolean {
  if (filter !== null && typeof filter === "object" && !Array.isArray(filter)) {
    const object = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    for (const [key, item] of Object.entries(filter)) {
      if (!matchesFilter(object === undefined ? undefined : propertyFold(object, key), item)) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(filter)) {
    const array = Array.isArray(value) ? (value as unknown[]) : undefined;
    for (let i = 0; i < filter.length; i++) {
      const element = array !== undefined && i < array.length ? array[i] : undefined;
      if (!matchesFilter(element, filter[i])) {
        return false;
      }
    }
    return true;
  }
  return looseEqual(value, filter);
}

/** propertyFold (matrix.go:387-396) reads a key case-insensitively. */
function propertyFold(object: Record<string, unknown>, key: string): unknown {
  if (key in object) {
    return object[key];
  }
  const lowered = key.toLowerCase();
  for (const [name, value] of Object.entries(object)) {
    if (name.toLowerCase() === lowered) {
      return value;
    }
  }
  return undefined;
}

/**
 * looseEqual (matrix.go:399-407) is the expression `==` of exprparser, which
 * model cannot import, for a matrix value and a filter scalar.
 */
function looseEqual(value: unknown, scalar: unknown): boolean {
  if (typeof value === "string" && typeof scalar === "string") {
    return value.toLowerCase() === scalar.toLowerCase();
  }
  return toNumber(value) === toNumber(scalar);
}

/** toNumber (matrix.go:410-430) — the expression layer's numeric coercion. */
function toNumber(value: unknown): number {
  switch (typeof value) {
    case "undefined":
      return 0; // Go's nil
    case "boolean":
      return value ? 1 : 0;
    case "number":
      return value;
    case "string": {
      const text = value.trim();
      if (text === "") {
        return 0;
      }
      const number = Number(text);
      if (!Number.isNaN(number)) {
        return number;
      }
      return Number.NaN;
    }
    default:
      if (value === null) return 0;
      return Number.NaN;
  }
}

/**
 * cartesianProduct (matrix.go:433-451) expands the axes into combinations
 * with the first axis varying slowest, which is the order GitHub documents
 * and lists the resulting jobs in.
 */
function cartesianProduct(axes: MatrixAxis[], product: number): MatrixCombination[] {
  if (axes.length === 0) {
    return [];
  }
  const combinations: MatrixCombination[] = [];
  for (let ordinal = 0; ordinal < product; ordinal++) {
    const combination: MatrixCombination = { values: {}, nameValues: [] };
    let stride = product;
    for (const axis of axes) {
      stride = Math.floor(stride / axis.values.length);
      const index = Math.floor(ordinal / stride) % axis.values.length;
      combination.values[axis.name] = axis.values[index];
      appendScalars(
        combination.nameValues,
        axis.values[index],
        axis.node !== null && isSeq(axis.node) && (axis.node.items as YamlNode[]).length === axis.values.length
          ? (axis.node.items as YamlNode[])[index]!
          : null,
      );
    }
    combinations.push(combination);
  }
  return combinations;
}

/** ReadJobYaml parses one job's YAML text the way the model tests' readJob
 *  helper does (workflow_test.go:792-798 — yaml.Unmarshal into a Job) and
 *  returns its `strategy:` node. Aliases expand at parse (the fixture table
 *  rides anchors); merge keys stay for decodeYamlValue to apply, exactly the
 *  model layer's own readWorkflow arm. An unresolvable tag (!!int nope) is a
 *  warning in the `yaml` package where go-yaml errors at Decode — the model
 *  decode arm treats it as its Decode error (the "invalid sequence value"
 *  fixture). */
export function readStrategyNode(jobYaml: string): MatrixNode {
  const { doc, error } = parseWorkflowDocument(jobYaml);
  if (error !== null) {
    throw error;
  }
  const warning = doc.warnings[0];
  if (warning !== undefined) {
    throw new Error(warning.message.split("\n")[0] ?? warning.message);
  }
  const strategy = doc.get("strategy", true) as YamlNode | undefined;
  return { present: strategy !== undefined, node: strategy ?? textScalar("") };
}
