// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The job/strategy model port — SPEC-0012 §D5 tier E, the E5 YAML workflow
// model. Sources (the submodule's pin fc493688):
//   - gitea/modules/actions/jobparser/model.go — Job/Strategy decode,
//     RunsOn/ContinueOnError reads, strategy.context, newJobEvaluator,
//     EvaluateConcurrency
//   - gitea/modules/actions/jobparser/jobparser.go — HasDeferredMatrix,
//     escape/unescapeExpressions, replaceScalars, matrixName, jobName
//   - gitea/modules/actions/jobparser/validate.go:164-219 — runsOnProblem
//   - actionslib v1.5.0 pkg/model/workflow.go — RunsOn*FromNode, RunsOnNode,
//     Strategy.MaxParallel/GetFailFast, nodeAsStringSlice
// Fixture discipline: the fixture rows of jobparser's model_test.go and
// jobparser_test.go port 1:1 in ./combos.test.ts; rows without fixtures are
// implementation-derived and marked as such.

import type { Node as YamlNode, YAMLMap, YAMLSeq } from "yaml";
import { isMap, isScalar, isSeq, Pair, Scalar as ScalarCtor, YAMLMap as YamlMapCtor, YAMLSeq as YamlSeqCtor } from "yaml";

import { Evaluator, evaluateYamlNode, NewEvaluator } from "../expression-eval/evaluator";
import { coerceToString } from "../expression-eval/kinds";
import type { ServerJobResult } from "../expression-eval";
import {
  needsContext,
  newInterpeter,
  strategyContext,
  type Interpeter,
  type RunShape,
  type StrategyContextInput,
} from "../expression-eval/interpreter";
import { Literal, ReadsContext } from "../expression-syntax/subexpr";
import { getMatrixes } from "./matrix";
import { decodeScalarText, decodeYamlValue, resolveAlias, textScalar, textSeq, yamlEntryPairs } from "./yaml-nodes";

export { textScalar, textSeq };

/** hasExpression (jobparser.go:33-35). */
export function hasExpression(value: string): boolean {
  return value.includes("${{");
}

/**
 * StrategyModel is jobparser's Strategy (model.go:224-231): the two scalar
 * fields, the raw matrix node (undefined when absent — a null `matrix:` IS a
 * node), the job-index/total buildMatrixCombos bakes, the whole-value
 * `strategy: ${{ }}` expression node (UnmarshalYAML's scalar arm,
 * model.go:235-241), and the strategy node itself for the model reads.
 */
export interface StrategyModel {
  failFastString: string;
  maxParallelString: string;
  rawMatrix: YamlNode | undefined;
  jobIndex: number;
  jobTotal: number;
  rawExpression: YamlNode | undefined;
  node: YamlNode | undefined;
}

/** parseStrategyNode decodes the job's `strategy:` node (model.go:235-241). */
export function parseStrategyNode(node: YamlNode | undefined): StrategyModel {
  const empty: StrategyModel = {
    failFastString: "",
    maxParallelString: "",
    rawMatrix: undefined,
    jobIndex: 0,
    jobTotal: 0,
    rawExpression: undefined,
    node: undefined,
  };
  if (node === undefined) {
    return empty;
  }
  const resolved = resolveAlias(node) ?? node;
  if (!isMap(resolved)) {
    // the whole-value `strategy: ${{ }}` scalar arm; a collection decodes
    // into the same slot (upstream's struct Decode would error at read)
    return { ...empty, rawExpression: resolved, node: resolved };
  }
  let rawMatrix: YamlNode | undefined;
  for (const [key, value] of yamlEntryPairs(resolved)) {
    if (decodeScalarText(key) === "matrix") {
      rawMatrix = value;
    }
  }
  return {
    failFastString: mapStringField(resolved, "fail-fast"),
    maxParallelString: mapStringField(resolved, "max-parallel"),
    rawMatrix,
    jobIndex: 0,
    jobTotal: 0,
    rawExpression: undefined,
    node: resolved,
  };
}

/** A mapping's scalar field as its string-field decode ("" when absent). */
function mapStringField(map: YAMLMap, key: string): string {
  for (const [k, v] of yamlEntryPairs(map)) {
    if (decodeScalarText(k) === key) return decodeScalarText(v);
  }
  return "";
}

/** MaxParallel (workflow.go:430-441) reads max-parallel like GitHub, a
 *  number truncated and saturated to an int32 where 0 means no limit. */
export function strategyMaxParallel(strategy: StrategyModel): { limit: number; error: Error | null } {
  if (strategy.maxParallelString === "") {
    return { limit: 0, error: null };
  }
  const text = strategy.maxParallelString;
  const limit = Number.parseFloat(text);
  if (Number.isNaN(limit) || !Number.isFinite(limit) || /[xX]/.test(text)) {
    return { limit: 0, error: new Error(`invalid max-parallel ${JSON.stringify(text)}, expected a number`) };
  }
  return { limit: Math.trunc(Math.min(Math.max(limit, 0), 0x7fffffff)), error: null };
}

/** parseBool is Go's strconv.ParseBool acceptance set. */
function parseBool(text: string): boolean | null {
  switch (text) {
    case "1":
    case "t":
    case "T":
    case "true":
    case "TRUE":
    case "True":
      return true;
    case "0":
    case "f":
    case "F":
    case "false":
    case "FALSE":
    case "False":
      return false;
    default:
      return null;
  }
}

/** GetFailFast (workflow.go:443-446) defaults to true for an omitted or invalid value, including an unevaluated expression. */
export function strategyFailFast(strategy: StrategyModel): boolean {
  const parsed = parseBool(strategy.failFastString);
  return parsed === null || parsed;
}

/**
 * strategyContextInput is jobparser's strategy.context (model.go:254-263):
 * combination 0 of 1 without a matrix as on GitHub, and no job-index for an
 * unexpanded matrix.
 */
export function strategyContextInput(strategy: StrategyModel | undefined): { input: StrategyContextInput | undefined; index: number; total: number } {
  if (strategy === undefined) {
    return { input: undefined, index: 0, total: 0 };
  }
  const fields: StrategyContextInput = {
    failFast: strategyFailFast(strategy),
    maxParallel: strategyMaxParallel(strategy).limit,
    hasRawMatrix: strategy.rawMatrix !== undefined,
  };
  if (strategy.rawMatrix === undefined && strategy.rawExpression === undefined) {
    return { input: fields, index: 0, total: 1 };
  }
  return { input: fields, index: strategy.jobIndex, total: strategy.jobTotal };
}

/**
 * JobModel is jobparser's Job (model.go:94-113), the slice the server's
 * insert/expansion paths read: the display name, the raw nodes for
 * needs/runs-on/continue-on-error/concurrency, the strategy, the `if:` text,
 * and the uses field. The whole job node rides for payload surgery (the
 * combo bake re-writes it).
 */
export interface JobModel {
  /** The job's YAML key (SetJob's map key). */
  id: string;
  name: string;
  rawNeeds: YamlNode | undefined;
  rawRunsOn: YamlNode | undefined;
  rawIf: string;
  rawContinueOnError: YamlNode | undefined;
  strategy: StrategyModel;
  rawConcurrency: YamlNode | undefined;
  uses: string;
  node: YAMLMap;
}

/** decodeJobModel reads one job mapping into the model (Job's field decode). */
export function decodeJobModel(jobNode: YAMLMap): JobModel {
  let name = "";
  let rawNeeds: YamlNode | undefined;
  let rawRunsOn: YamlNode | undefined;
  let rawIfNode: YamlNode | undefined;
  let rawContinueOnError: YamlNode | undefined;
  let strategyNode: YamlNode | undefined;
  let rawConcurrency: YamlNode | undefined;
  let uses = "";
  for (const [key, value] of yamlEntryPairs(jobNode)) {
    switch (decodeScalarText(key)) {
      case "name":
        name = decodeScalarText(value);
        break;
      case "needs":
        rawNeeds = value;
        break;
      case "runs-on":
        rawRunsOn = value;
        break;
      case "if":
        rawIfNode = value;
        break;
      case "continue-on-error":
        rawContinueOnError = value;
        break;
      case "strategy":
        strategyNode = value;
        break;
      case "concurrency":
        rawConcurrency = value;
        break;
      case "uses":
        uses = decodeScalarText(value);
        break;
    }
  }
  return {
    id: "",
    name,
    rawNeeds,
    rawRunsOn,
    rawIf: rawIfNode === undefined ? "" : decodeScalarText(rawIfNode),
    rawContinueOnError,
    strategy: parseStrategyNode(strategyNode),
    rawConcurrency,
    uses,
    node: jobNode,
  };
}

/** needs (workflow.go:493-495 over nodeAsStringSlice:579-598). */
export function jobNeeds(node: YamlNode | undefined): string[] {
  return nodeAsStringSlice(node);
}

/** RunsOnLabelsFromNode (workflow.go:522-536). */
export function runsOnLabelsFromNode(rawRunsOn: YamlNode | undefined): string[] {
  if (rawRunsOn === undefined) return [];
  const resolved = resolveAlias(rawRunsOn) ?? rawRunsOn;
  if (!isMap(resolved)) {
    return nodeAsStringSlice(rawRunsOn);
  }
  for (const [key, value] of yamlEntryPairs(resolved)) {
    if (decodeScalarText(key) === "labels") {
      return nodeAsStringSlice(value);
    }
  }
  return [];
}

/** RunsOnGroupFromNode (workflow.go:539-551). */
export function runsOnGroupFromNode(rawRunsOn: YamlNode | undefined): string {
  if (rawRunsOn === undefined) return "";
  const resolved = resolveAlias(rawRunsOn) ?? rawRunsOn;
  if (!isMap(resolved)) {
    return "";
  }
  for (const [key, value] of yamlEntryPairs(resolved)) {
    if (decodeScalarText(key) === "group") {
      return decodeScalarText(value);
    }
  }
  return "";
}

/** RunsOn is the jobparser read (model.go:171-178): the labels Gitea
 *  matches runners against, unescaped like DisplayName. */
export function jobRunsOn(job: JobModel): string[] {
  return runsOnFromNode(job.rawRunsOn).map(unescapeExpressions);
}

/** RunsOnFromNode (workflow.go:513-520) — the labels followed by the group. */
export function runsOnFromNode(rawRunsOn: YamlNode | undefined): string[] {
  const labels = runsOnLabelsFromNode(rawRunsOn);
  const group = runsOnGroupFromNode(rawRunsOn);
  if (group !== "") {
    return [...labels, group];
  }
  return labels;
}

/** nodeAsStringSlice (workflow.go:579-598): a scalar or a string sequence;
 *  a non-string element is a Decode error → nil upstream, [] here. */
function nodeAsStringSlice(node: YamlNode | undefined): string[] {
  if (node === undefined) return [];
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    if (resolved.value === null || resolved.value === undefined) return [];
    return [decodeScalarText(resolved)];
  }
  if (isSeq(resolved)) {
    const out: string[] = [];
    for (const item of (resolved).items) {
      const value = decodeYamlValue((item ?? new ScalarCtor(null)) as YamlNode);
      if (typeof value === "string") {
        out.push(value);
      } else if (value === null || value === undefined) {
        out.push("");
      } else {
        return [];
      }
    }
    return out;
  }
  return [];
}

/** RunsOnNode (workflow.go:556-573) — the inverse of the FromNode reads: a
 *  single label scalarizes, a group re-wraps, otherwise the label list. */
export function runsOnNode(labels: string[], group: string): YamlNode {
  if (group !== "") {
    const map = new YamlMapCtor();
    if (labels.length > 0) {
      map.items.push(new Pair(textScalar("labels"), textSeq(labels)));
    }
    map.items.push(new Pair(textScalar("group"), textScalar(group)));
    return map;
  }
  if (labels.length === 1) {
    return textScalar(labels[0]!);
  }
  return textSeq(labels);
}

/** GetContinueOnError (model.go:117-126): a literal bool or an
 *  already-evaluated expression node; anything else false. */
export function getContinueOnError(node: YamlNode | undefined): boolean {
  if (node === undefined) return false;
  const resolved = resolveAlias(node) ?? node;
  if (!isScalar(resolved)) return false;
  return resolved.value === true;
}

/** runsOnProblem (validate.go:164-219) — github.com's schema error for a runs-on, "" if valid. */
export function runsOnProblem(node: YamlNode | undefined): string {
  if (node === undefined) return "";
  const resolved = resolveAlias(node) ?? node;
  if (!isMap(resolved)) {
    return runsOnLabelsProblem(resolved);
  }
  for (const [key, value] of yamlEntryPairs(resolved)) {
    const keyText = decodeScalarText(key);
    let problem: string;
    switch (keyText) {
      case "labels":
        problem = runsOnLabelsProblem(resolveAlias(value) ?? value);
        break;
      case "group":
        problem = runsOnGroupProblem(resolveAlias(value) ?? value);
        break;
      default:
        problem = `Unexpected value '${keyText}'`;
    }
    if (problem !== "") {
      return problem;
    }
  }
  return "";
}

function runsOnLabelsProblem(node: YamlNode): string {
  if (!isSeq(node)) {
    return nonEmptyStringProblem(node);
  }
  for (const label of (node).items) {
    const problem = nonEmptyStringProblem(resolveAlias((label ?? new ScalarCtor(null)) as YamlNode) ?? (label as YamlNode));
    if (problem !== "") {
      return problem;
    }
  }
  return "";
}

function runsOnGroupProblem(node: YamlNode): string {
  const value = decodeScalarText(node);
  const problem = nonEmptyStringProblem(node);
  if (problem !== "" || hasExpression(value)) {
    return problem;
  }
  const slash = value.indexOf("/");
  if (slash >= 0) {
    const prefix = value.slice(0, slash);
    const name = value.slice(slash + 1);
    if (name === "") {
      return `Invalid runs-on group name '${value}'.`;
    }
    if (name.includes("/") || !["org", "organization", "ent", "enterprise"].includes(prefix)) {
      return `Invalid runs-on group name '${value}'. Please use 'organization/' or 'enterprise/' prefix to target a single runner group.`;
    }
  }
  return "";
}

/** nonEmptyStringProblem (validate.go:212-219) — github.com's non-empty-string, which also accepts non-string scalars. */
function nonEmptyStringProblem(node: YamlNode): string {
  if (isSeq(node)) return "A sequence was not expected";
  if (isMap(node)) return "A mapping was not expected";
  if (isScalar(node) && (decodeScalarText(node) === "" || node.value === null)) return "Unexpected value ''";
  return "";
}

// ---------------------------------------------------------------------------
// The interpolation escapes (jobparser.go:180-221)
// ---------------------------------------------------------------------------

/** escapedExpression (jobparser.go:205). */
export const ESCAPED_EXPRESSION = "${{ '$' }}{{";

/** escapeExpressions (jobparser.go:208-210) — GitHub never evaluates the result of an evaluation again. */
export function escapeExpressions(value: string): string {
  return value.split("${{").join(ESCAPED_EXPRESSION);
}

/** unescapeExpressions (jobparser.go:212-214). */
export function unescapeExpressions(value: string): string {
  return value.split(ESCAPED_EXPRESSION).join("${{");
}

/** replaceScalars (jobparser.go:216-221) rewrites every scalar's text in place. */
export function replaceScalars(node: YamlNode, replace: (text: string) => string): void {
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    if (typeof resolved.value === "string") {
      resolved.value = replace(resolved.value);
    }
    return;
  }
  if (isMap(resolved)) {
    for (const pair of (resolved).items) {
      if (pair.key !== undefined && pair.key !== null) replaceScalars(pair.key as YamlNode, replace);
      if (pair.value !== undefined && pair.value !== null) replaceScalars(pair.value as YamlNode, replace);
    }
    return;
  }
  if (isSeq(resolved)) {
    for (const item of (resolved).items) {
      replaceScalars(item as YamlNode, replace);
    }
  }
}

// ---------------------------------------------------------------------------
// The deferred-matrix scan (jobparser.go:19-31)
// ---------------------------------------------------------------------------

/** nodeMatches (jobparser.go:26-31) walks a node's scalar texts. */
export function nodeMatches(node: YamlNode | undefined, match: (value: string) => boolean): boolean {
  if (node === undefined) return false;
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    return match(decodeScalarText(resolved));
  }
  if (isMap(resolved)) {
    for (const pair of (resolved).items) {
      if (pair.key !== undefined && pair.key !== null && nodeMatches(pair.key as YamlNode, match)) return true;
      if (pair.value !== undefined && pair.value !== null && nodeMatches(pair.value as YamlNode, match)) return true;
    }
    return false;
  }
  if (isSeq(resolved)) {
    return (resolved).items.some((child) => nodeMatches(child as YamlNode, match));
  }
  return false;
}

/** expressionReadsNeeds (jobparser.go:61-67). */
export function expressionReadsNeeds(value: string): boolean {
  return ReadsContext(value, "needs");
}

/**
 * HasDeferredMatrix (jobparser.go:20-24) reports whether the job's strategy,
 * name, runs-on or continue-on-error need outputs before they can be
 * resolved.
 */
export function hasDeferredMatrix(job: JobModel): boolean {
  return (
    jobNeeds(job.rawNeeds).length > 0 &&
    (nodeMatches(job.strategy.rawMatrix, expressionReadsNeeds) ||
      expressionReadsNeeds(decodeScalarText(job.strategy.rawExpression)) ||
      expressionReadsNeeds(job.strategy.maxParallelString) ||
      expressionReadsNeeds(job.strategy.failFastString) ||
      expressionReadsNeeds(job.name) ||
      nodeMatches(job.rawRunsOn, expressionReadsNeeds) ||
      nodeMatches(job.rawContinueOnError, expressionReadsNeeds))
  );
}

// ---------------------------------------------------------------------------
// The job interpeter assembly (jobparser/interpeter.go:16-65)
// ---------------------------------------------------------------------------

/**
 * newJobInterpeter is the server-side interpeter factory (interpeter.go)
 * with the strategy context's index/total assembly: github, needs, strategy,
 * matrix, inputs contexts only, Context "job", WorkingDir "" (hashFiles
 * self-disables, §D1).
 */
export function newJobInterpeter(input: {
  jobId: string;
  strategy: StrategyModel | undefined;
  matrix: Record<string, unknown> | undefined;
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
}): Interpeter {
  const run: RunShape = { jobId: input.jobId, workflow: { jobs: {} } };
  for (const [id, result] of Object.entries(input.results)) {
    run.workflow!.jobs[id] = { needs: result.needs, result: result.result, outputs: result.outputs };
  }
  const { input: strategyInput, index, total } = strategyContextInput(input.strategy);

  const env = {
    github: input.gitContext,
    job: {},
    strategy: strategyContext(strategyInput, index, total),
    matrix: input.matrix,
    needs: needsContext(run),
    inputs: input.inputs,
    vars: input.vars,
  };

  return newInterpeter(env, {
    run,
    workingDir: "",
    context: "job",
  });
}

/** evaluatorOf wraps one interpeter into an Evaluator (evaluator.go:33-35). */
export function evaluatorOf(interpeter: Interpeter): Evaluator {
  return NewEvaluator(interpeter);
}

/** newJobEvaluatorFromStrategy evaluates against explicit strategy/matrix —
 *  buildMatrixCombos' per-combo evaluator (jobparser.go:241). */
export function newJobEvaluatorFromStrategy(input: {
  jobId: string;
  strategy: StrategyModel;
  matrix: Record<string, unknown>;
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
}): Evaluator {
  return evaluatorOf(
    newJobInterpeter({
      jobId: input.jobId,
      strategy: input.strategy,
      matrix: input.matrix,
      gitContext: input.gitContext,
      results: input.results,
      vars: input.vars,
      inputs: input.inputs,
    }),
  );
}

/**
 * newJobEvaluator evaluates against a stored job's contexts, with its single
 * matrix combination (model.go:297-313): the payload's baked matrix reads
 * back with its escapes undone (replaceScalars(unescapeExpressions)), then
 * expands — combination 0 is the combination.
 */
export function newJobEvaluator(input: {
  jobId: string;
  job: JobModel | undefined;
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
}): { evaluator: Evaluator; matrix: Record<string, unknown> | undefined; error: Error | null } {
  let strategy: StrategyModel | undefined;
  let matrix: Record<string, unknown> | undefined;
  if (input.job !== undefined) {
    strategy = input.job.strategy;
    if (input.job.strategy.rawMatrix !== undefined) {
      const rawMatrix = cloneWithUnescapedScalars(input.job.strategy.rawMatrix);
      try {
        const combos = getMatrixes(
          { present: true, node: input.job.strategy.node ?? rawMatrix },
          rawMatrix,
        );
        const first = combos[0];
        if (first !== undefined && Object.keys(first).length > 0) {
          matrix = first;
        }
      } catch (thrown) {
        return { evaluator: evaluatorOf(newJobInterpeter({ jobId: input.jobId, strategy: undefined, matrix: undefined, gitContext: input.gitContext, results: input.results, vars: input.vars, inputs: input.inputs })), matrix: undefined, error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
      }
    }
  }
  return {
    evaluator: evaluatorOf(
      newJobInterpeter({
        jobId: input.jobId,
        strategy,
        matrix,
        gitContext: input.gitContext,
        results: input.results,
        vars: input.vars,
        inputs: input.inputs,
      }),
    ),
    matrix,
    error: null,
  };
}

/** cloneWithUnescapedScalars deep-copies a node with every scalar's escapes
 *  undone (newJobEvaluator's CloneYamlNode + replaceScalars pair). */
function cloneWithUnescapedScalars(node: YamlNode): YamlNode {
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    const scalar = new ScalarCtor(typeof resolved.value === "string" ? unescapeExpressions(resolved.value) : resolved.value);
    if (resolved.type !== undefined) scalar.type = resolved.type;
    if (resolved.tag !== undefined) scalar.tag = resolved.tag;
    return scalar;
  }
  if (isMap(resolved)) {
    const map = new YamlMapCtor();
    for (const pair of (resolved).items) {
      map.items.push(
        new Pair(
          cloneWithUnescapedScalars(pair.key as YamlNode),
          cloneWithUnescapedScalars((pair.value ?? new ScalarCtor(null)) as YamlNode),
        ),
      );
    }
    return map;
  }
  const seq = new YamlSeqCtor();
  for (const item of (resolved as YAMLSeq).items) {
    seq.items.push(cloneWithUnescapedScalars((item ?? new ScalarCtor(null)) as YamlNode));
  }
  return seq;
}

/**
 * evaluateJobConcurrency is jobparser.EvaluateConcurrency (model.go:315-335):
 * the job-level fill model — the raw concurrency node encodes, evaluates in
 * place against the stored job's contexts, and re-decodes into the
 * RawConcurrency strings.
 */
export function evaluateJobConcurrency(input: {
  rc: { group: string; cancelInProgress: string; rawExpression: string };
  jobId: string;
  job: JobModel;
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
}): { group: string; cancel: boolean; error: Error | null } {
  const { evaluator, error } = newJobEvaluator({
    jobId: input.jobId,
    job: input.job,
    gitContext: input.gitContext,
    results: input.results,
    vars: input.vars,
    inputs: input.inputs,
  });
  if (error !== null) {
    return { group: "", cancel: false, error };
  }
  let node = encodeRawConcurrency(input.rc);
  const evaluatedNode = evaluateYamlNode(evaluator, node);
  if (evaluatedNode.error !== null) {
    return { group: "", cancel: false, error: new Error(`failed to evaluate concurrency: ${evaluatedNode.error.message}`) };
  }
  if (evaluatedNode.replacement !== null) {
    node = evaluatedNode.replacement;
  }
  const evaluated = decodeRawConcurrency(node);
  if (evaluated === null) {
    return { group: "", cancel: false, error: new Error("failed to unmarshal evaluated concurrency") };
  }
  if (evaluated.rawExpression !== "") {
    return { group: evaluated.rawExpression, cancel: false, error: null };
  }
  return { group: evaluated.group, cancel: parseYamlBool(evaluated.cancelInProgress), error: null };
}

/** encodeRawConcurrency marshals the RawConcurrency struct the way its
 *  MarshalYAML does (workflow.go:1219-1228) — the whole value is a scalar
 *  when RawExpression carries it, else the omitempty mapping. */
function encodeRawConcurrency(rc: { group: string; cancelInProgress: string; rawExpression: string }): YamlNode {
  if (rc.rawExpression !== "") {
    return textScalar(rc.rawExpression);
  }
  const map = new YamlMapCtor();
  if (rc.group !== "") map.items.push(new Pair(textScalar("group"), textScalar(rc.group)));
  if (rc.cancelInProgress !== "") map.items.push(new Pair(textScalar("cancel-in-progress"), textScalar(rc.cancelInProgress)));
  return map;
}

/** decodeRawConcurrency reads the evaluated node back into the struct
 *  (workflow.go's UnmarshalYAML: the string arm first, then the mapping). */
function decodeRawConcurrency(node: YamlNode): { group: string; cancelInProgress: string; rawExpression: string } | null {
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    return { group: "", cancelInProgress: "", rawExpression: decodeScalarText(resolved) };
  }
  if (isMap(resolved)) {
    return {
      group: mapStringField(resolved, "group"),
      cancelInProgress: mapStringField(resolved, "cancel-in-progress"),
      rawExpression: "",
    };
  }
  return null;
}

/** ReadRawConcurrencyNode reads a stored `concurrency:` node into the
 *  RawConcurrency strings (the UnmarshalYAML contract: the string arm first,
 *  then the mapping). The trigger stores the node text and reads it back
 *  through this before the fill model. */
export function readRawConcurrencyNode(node: YamlNode | undefined): { group: string; cancelInProgress: string; rawExpression: string } | null {
  if (node === undefined) return null;
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    return { group: "", cancelInProgress: "", rawExpression: decodeScalarText(resolved) };
  }
  if (isMap(resolved)) {
    return {
      group: mapStringField(resolved, "group"),
      cancelInProgress: mapStringField(resolved, "cancel-in-progress"),
      rawExpression: "",
    };
  }
  return null;
}

/** ParseYamlBool (modules/util/util.go:25-27) — YAML 1.2's true spellings. */
export function parseYamlBool(s: string): boolean {
  return s === "true" || s === "True" || s === "TRUE";
}

// ---------------------------------------------------------------------------
// The combo naming (jobparser.go:315-347)
// ---------------------------------------------------------------------------

/** matrixName (jobparser.go:336-347) formats the name suffix, skipping null and empty values. */
export function matrixName(values: unknown[]): string {
  const names: string[] = [];
  for (const value of values) {
    const name = coerceToString(value);
    if (name !== "") {
      names.push(name);
    }
  }
  if (names.length === 0) {
    return "";
  }
  return ` (${names.join(", ")})`;
}

/** jobName (jobparser.go:316-333) trims names, gives plain text and lone
 *  string literals the suffix, and blank names the job ID. */
export function jobName(input: { name: string; jobId: string; suffix: string; evaluator: Evaluator; evaluate: boolean }): { name: string; error: Error | null } {
  let name = input.name.trim();
  const literal = Literal(name);
  if (literal.ok) {
    let text = literal.text;
    if (text === "") {
      text = input.jobId;
    }
    return { name: escapeExpressions(text + input.suffix), error: null };
  }
  if (!input.evaluate) {
    return { name, error: null };
  }
  const evaluated = input.evaluator.interpolate(name);
  name = evaluated.value.trim();
  if (name === "") {
    name = input.jobId;
  }
  return { name: escapeExpressions(name), error: evaluated.error };
}
