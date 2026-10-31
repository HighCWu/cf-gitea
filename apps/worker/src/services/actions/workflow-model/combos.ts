// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The Parse-level combo arm — SPEC-0012 §D5 tier E, the E5 YAML workflow
// model (gitea/modules/actions/jobparser/jobparser.go over the submodule's
// pin fc493688): Strategy.resolve, buildMatrixCombos, ExpandMatrixWithNeeds,
// encodeMatrix, and the workflow split that mirrors Parse's per-job
// placeholder-or-combos decision.
//
// Fixture discipline: jobparser_test.go's TestParseDefersDynamicMatrix,
// TestParseWholeValueExpressions, TestParseJobNames, TestJobFieldsWithout-
// Matrix, TestExpandMatrixWithNeeds, TestRejectsUnevaluatedMatrixFilters and
// the testdata round-trip rows port 1:1 in ./combos.test.ts.

import type { Node as YamlNode, YAMLMap, YAMLSeq } from "yaml";
import { Document, isMap, isScalar, isSeq, Pair, Scalar, YAMLMap as YamlMapCtor, YAMLSeq as YamlSeqCtor } from "yaml";

import type { Evaluator } from "../expression-eval/evaluator";
import { evaluateYamlNode } from "../expression-eval/evaluator";
import type { ServerJobResult } from "../expression-eval";
import { MAX_MATRIX_COMBINATIONS, matrixCombinations, type MatrixCombination } from "./matrix";
import {
  decodeJobModel,
  escapeExpressions,
  hasDeferredMatrix,
  jobName,
  matrixName,
  newJobEvaluatorFromStrategy,
  nodeMatches,
  replaceScalars,
  runsOnFromNode,
  runsOnNode,
  runsOnProblem,
  strategyMaxParallel,
  textScalar,
  type JobModel,
  type StrategyModel,
} from "./job";
import { cloneNode, decodeScalarText, rejectMergeKeys, resolveAlias, resolveYamlAliases, yamlEntryPairs, type MatrixNode } from "./yaml-nodes";

/** IfExpression (jobparser.go:37-43) — an `if:` that omits `${{ }}` is evaluated as one expression anyway. */
export function ifExpression(value: string): string {
  return hasExpressionStr(value) ? value : `${"${{"} ${value} }}`;
}

function hasExpressionStr(value: string): boolean {
  return value.includes("${{");
}

/**
 * resolveStrategy (jobparser.go:181-203) evaluates strategy values once and
 * escapes expression-like results for the runner. The whole-value
 * `strategy: ${{ }}` arm decodes the evaluated node into a FRESH strategy
 * (decodeRawNode's `var value Value; *out = value` — workflow.go:1091-1102),
 * so a scalar evaluation rejects as "strategy is not a map of strategy keys
 * to values".
 */
export function resolveStrategy(strategy: StrategyModel, evaluator: Evaluator): Error | null {
  if (strategy.rawExpression !== undefined) {
    let node = cloneNode(strategy.rawExpression);
    const evaluatedNode = evaluateYamlNode(evaluator, node);
    if (evaluatedNode.error !== null) {
      return new Error(`strategy: ${evaluatedNode.error.message}`);
    }
    if (evaluatedNode.replacement !== null) {
      node = evaluatedNode.replacement;
    }
    const decoded = decodeStrategyNode(node);
    if (decoded.rawExpression !== undefined) {
      return new Error("strategy is not a map of strategy keys to values");
    }
    strategy.failFastString = decoded.failFastString;
    strategy.maxParallelString = decoded.maxParallelString;
    strategy.rawMatrix = decoded.rawMatrix;
    strategy.node = decoded.node;
    strategy.jobIndex = 0;
    strategy.jobTotal = 0;
    strategy.rawExpression = undefined;
  } else {
    const evaluatedFailFast = evaluator.interpolate(strategy.failFastString);
    if (evaluatedFailFast.error !== null) {
      return new Error(`evaluate strategy: ${evaluatedFailFast.error.message}`);
    }
    strategy.failFastString = evaluatedFailFast.value;
    const evaluatedMaxParallel = evaluator.interpolate(strategy.maxParallelString);
    if (evaluatedMaxParallel.error !== null) {
      return new Error(`evaluate strategy: ${evaluatedMaxParallel.error.message}`);
    }
    strategy.maxParallelString = evaluatedMaxParallel.value;
    if (strategy.rawMatrix !== undefined) {
      const evaluatedMatrix = evaluateYamlNode(evaluator, strategy.rawMatrix);
      if (evaluatedMatrix.error !== null) {
        return new Error(`evaluate matrix: ${evaluatedMatrix.error.message}`);
      }
      if (evaluatedMatrix.replacement !== null) {
        strategy.rawMatrix = evaluatedMatrix.replacement;
      }
    }
  }
  strategy.failFastString = escapeExpressions(strategy.failFastString);
  strategy.maxParallelString = escapeExpressions(strategy.maxParallelString);
  return null;
}

/** decodeStrategyNode reads an evaluated node into a fresh StrategyModel
 *  (Strategy's UnmarshalYAML over rawStrategy). */
function decodeStrategyNode(node: YamlNode): StrategyModel {
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    return { failFastString: "", maxParallelString: "", rawMatrix: undefined, jobIndex: 0, jobTotal: 0, rawExpression: resolved, node: resolved };
  }
  const strategy: StrategyModel = {
    failFastString: "",
    maxParallelString: "",
    rawMatrix: undefined,
    jobIndex: 0,
    jobTotal: 0,
    rawExpression: undefined,
    node: resolved,
  };
  if (isMap(resolved)) {
    for (const [key, value] of yamlEntryPairs(resolved)) {
      switch (decodeScalarText(key)) {
        case "fail-fast":
          strategy.failFastString = decodeScalarText(value);
          break;
        case "max-parallel":
          strategy.maxParallelString = decodeScalarText(value);
          break;
        case "matrix":
          strategy.rawMatrix = value;
          break;
        case "job-index":
          strategy.jobIndex = numberField(value);
          break;
        case "job-total":
          strategy.jobTotal = numberField(value);
          break;
      }
    }
  }
  return strategy;
}

function numberField(node: YamlNode): number {
  const n = Number(decodeScalarText(node));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** encodeMatrix (jobparser.go:302-313): each combination becomes a
 *  single-value-per-axis mapping; an empty combination is no node. */
export function encodeMatrix(matrix: Record<string, unknown>): YamlNode | undefined {
  const keys = Object.keys(matrix);
  if (keys.length === 0) {
    return undefined;
  }
  const map = new YamlMapCtor();
  for (const key of keys) {
    const seq = new YamlSeqCtor();
    seq.items.push(valueNodeOf(matrix[key]));
    map.items.push(new Pair(textScalar(key), seq));
  }
  return map;
}

/** valueNodeOf encodes one matrix value back into a node (the inverse of
 *  decodeYamlValue for the shapes matrices carry). */
function valueNodeOf(value: unknown): YamlNode {
  if (value === null || value === undefined) {
    const scalar = textScalar("");
    scalar.value = null;
    return scalar;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const map = new YamlMapCtor();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      map.items.push(new Pair(textScalar(key), valueNodeOf(item)));
    }
    return map;
  }
  if (Array.isArray(value)) {
    const seq = new YamlSeqCtor();
    for (const item of value) seq.items.push(valueNodeOf(item));
    return seq;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return new Scalar(value); // the JS type is the node's; the emitter writes it plainly
  }
  return textScalar(value as string);
}

/** A parsed single-job outcome of the model split — one per matrix
 *  combination, the shape upstream's Parse returns as []*SingleWorkflow.
 *  parseWorkflowCombos fills payload; expandMatrixWithNeeds leaves it null
 *  (upstream's caller holds the stored header and marshals — matrix.go's
 *  applyCombo over baseSWF.CloneHeader()). */
export interface WorkflowJobCombo {
  jobId: string;
  job: JobModel;
  /** True when the job planned as the deferred placeholder (one row, the
   *  emitter expands over the completed needs). */
  deferred: boolean;
  payload: Uint8Array | null;
}

/**
 * parseWorkflowCombos is jobparser.Parse's job-split slice over one workflow:
 * aliases resolve and merge keys reject first (aliases.go), then each job
 * either plans as the deferred placeholder (HasDeferredMatrix) or resolves
 * its strategy and expands into one combo per matrix combination
 * (jobparser.go:113-144). A git context is what makes the strategy resolve
 * at planning time (jobparser.go:123); the trigger always passes one.
 */
export function parseWorkflowCombos(
  content: string,
  opts: { gitContext: unknown; vars: Record<string, string> | undefined; inputs: Record<string, unknown> | undefined; eraseNeeds?: boolean },
): { combos: WorkflowJobCombo[]; error: Error | null } {
  const { doc, error } = parseResolved(content);
  if (error !== null) {
    return { combos: [], error };
  }
  const header = workflowHeaderPairs(doc);
  const combos: WorkflowJobCombo[] = [];
  const jobsNode = doc.get("jobs", true) as YamlNode | undefined;
  if (jobsNode === undefined || !isMap(resolveAlias(jobsNode) ?? jobsNode)) {
    return { combos: [], error: new Error("invalid jobs") };
  }
  for (const [jobIdNode, jobValue] of yamlEntryPairs((resolveAlias(jobsNode) ?? jobsNode) as YAMLMap)) {
    const jobId = decodeScalarText(jobIdNode);
    const jobMap = resolveAlias(jobValue) ?? jobValue;
    if (!isMap(jobMap)) {
      return { combos: [], error: new Error("invalid jobs") };
    }
    const job = decodeJobModel(jobMap);
    job.id = jobId;
    const split = splitJobIntoCombos(jobId, job, opts, header);
    if (opts.eraseNeeds === true) {
      // insertRunJob's SetJob(id, job.EraseNeeds()) — the stored payload
      // drops needs; the Task wire's `needs` field serves them
      for (const combo of split.combos) {
        combo.payload = marshalComboPayload(header, combo.job, { eraseNeeds: true });
      }
    }
    if (split.error !== null) {
      return { combos: [], error: split.error };
    }
    combos.push(...split.combos);
  }
  return { combos, error: null };
}

/** workflowHeaderPairs reads the payload header the marshal discipline
 *  carries — the workflow-global fields the runner parses (the module's
 *  payload order: name, on, env, defaults, permissions). */
function workflowHeaderPairs(doc: Document): Array<[string, YamlNode]> {
  const out: Array<[string, YamlNode]> = [];
  for (const key of ["name", "on", "env", "defaults", "permissions"]) {
    const node = doc.get(key, true) as YamlNode | undefined;
    if (node !== undefined) {
      out.push([key, node]);
    }
  }
  return out;
}

/** parseResolved is resolveYamlAliases + rejectMergeKeys (aliases.go:54-60). */
function parseResolved(content: string): { doc: Document; error: Error | null } {
  const resolved = resolveYamlAliases(content);
  if (resolved.error !== null) {
    return resolved;
  }
  const problem = rejectMergeKeys(resolved.doc.contents as YamlNode | undefined);
  if (problem !== null) {
    return { doc: resolved.doc, error: problem };
  }
  return resolved;
}

/**
 * parseRawSingleWorkflow (jobparser.go:46-59) decodes a stored payload into
 * its header pairs and the single job as stored, without expanding or
 * evaluating it again. An empty name defaults to the job id (Parse does the
 * same, and callers use the name as the display name).
 */
export function parseRawSingleWorkflow(payloadText: string): { header: Array<[string, YamlNode]>; job: JobModel; error: Error | null } {
  const { doc, error } = parseResolved(payloadText);
  if (error !== null) {
    return { header: [], job: undefined as unknown as JobModel, error };
  }
  const jobsNode = doc.get("jobs", true) as YamlNode | undefined;
  if (jobsNode === undefined || !isMap(resolveAlias(jobsNode) ?? jobsNode)) {
    return { header: [], job: undefined as unknown as JobModel, error: new Error("payload contains no job") };
  }
  const items = ((resolveAlias(jobsNode) ?? jobsNode) as YAMLMap).items;
  const first = items[0];
  if (first === undefined) {
    return { header: [], job: undefined as unknown as JobModel, error: new Error("payload contains no job") };
  }
  const id = decodeScalarText(first.key as YamlNode);
  const jobMap = resolveAlias(first.value as YamlNode) ?? (first.value as YamlNode);
  if (!isMap(jobMap)) {
    return { header: [], job: undefined as unknown as JobModel, error: new Error("payload contains no job") };
  }
  const header = workflowHeaderPairs(doc);
  const job = decodeJobModel(jobMap);
  job.id = id;
  if (job.name === "") {
    job.name = id; // Parse defaults it the same way, and callers use it as the job's display name
  }
  return { header, job, error: null };
}

/** splitJobIntoCombos is Parse's per-job body (jobparser.go:114-136). */
function splitJobIntoCombos(
  jobId: string,
  job: JobModel,
  opts: { gitContext: unknown; vars: Record<string, string> | undefined; inputs: Record<string, unknown> | undefined },
  header: Array<[string, YamlNode]>,
): { combos: WorkflowJobCombo[]; error: Error | null } {
  if (
    hasDeferredMatrix(job) ||
    (opts.gitContext === undefined &&
      (job.strategy.rawExpression !== undefined || nodeMatches(job.strategy.rawMatrix, hasExpressionStr)))
  ) {
    const placeholder = cloneJobModel(job);
    if (placeholder.name === "") {
      placeholder.name = jobId;
    }
    return {
      combos: [{ jobId, job: placeholder, deferred: true, payload: marshalComboPayload(header, placeholder) }],
      error: null,
    };
  }
  const evaluator = newJobEvaluatorFromStrategy({
    jobId,
    strategy: job.strategy,
    matrix: {},
    gitContext: opts.gitContext,
    results: {},
    vars: opts.vars,
    inputs: opts.inputs,
  });
  const resolveError = resolveStrategy(job.strategy, evaluator);
  if (resolveError !== null) {
    return { combos: [], error: new Error(`job ${JSON.stringify(jobId)}: ${resolveError.message}`) };
  }
  let combos: MatrixCombination[];
  try {
    combos = matrixCombinations(strategyNodeOf(job.strategy), job.strategy.rawMatrix);
  } catch (thrown) {
    return { combos: [], error: new Error(`Parse: ${thrown instanceof Error ? thrown.message : String(thrown)}`) };
  }
  return buildMatrixCombosInto(jobId, job, combos, { ...opts, header });
}

function strategyNodeOf(strategy: StrategyModel): MatrixNode {
  return { present: strategy.node !== undefined, node: strategy.node ?? textScalar("") };
}

/** BuildMatrixOpts is the interpeter assembly every combo builder passes. */
export interface BuildMatrixOpts {
  gitContext: unknown;
  results?: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
  maxCombinations?: number;
  /** The payload header the marshal carries; absent → payloads stay null. */
  header?: Array<[string, YamlNode]>;
}

/**
 * buildMatrixCombosInto is buildMatrixCombos (jobparser.go:225-274): one Job
 * per matrix combination from src, baking the combination into the strategy
 * and interpolating the name, runs-on and continue-on-error with it.
 */
export function buildMatrixCombosInto(
  jobId: string,
  src: JobModel,
  matrixes: MatrixCombination[],
  opts: BuildMatrixOpts,
): { combos: WorkflowJobCombo[]; error: Error | null } {
  const maxCombinations = opts.maxCombinations ?? MAX_MATRIX_COMBINATIONS;
  if (matrixes.length > maxCombinations) {
    return {
      combos: [],
      error: new Error(`matrix expands to ${matrixes.length} combinations, exceeding the limit of ${maxCombinations}`),
    };
  }
  const names = matrixes.map((matrix) => matrixName(matrix.nameValues));
  const order = matrixes.map((_, index) => index);
  order.sort((a, b) => {
    const ka = names[a]!;
    const kb = names[b]!;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const combos: WorkflowJobCombo[] = [];
  for (const index of order) {
    const matrix = matrixes[index]!.values;
    const combo = cloneJobModel(src);
    combo.strategy.rawMatrix = encodeMatrix(matrix);
    if (combo.strategy.rawMatrix !== undefined) {
      replaceScalars(combo.strategy.rawMatrix, escapeExpressions);
    }
    if (src.strategy.rawMatrix !== undefined) {
      combo.strategy.jobIndex = index;
      combo.strategy.jobTotal = matrixes.length;
    }
    const evaluator = newJobEvaluatorFromStrategy({
      jobId,
      strategy: combo.strategy,
      matrix,
      gitContext: opts.gitContext,
      results: opts.results ?? {},
      vars: opts.vars,
      inputs: opts.inputs,
    });
    const named = jobName({
      name: combo.name,
      jobId,
      suffix: names[index]!,
      evaluator,
      evaluate: Object.keys(matrix).length > 0 || opts.gitContext !== undefined,
    });
    if (named.error !== null) {
      return { combos: [], error: new Error(`interpolate name for job ${JSON.stringify(jobId)}: ${named.error.message}`) };
    }
    combo.name = named.name;
    if (opts.gitContext !== undefined && opts.gitContext !== null) {
      // callers without one don't read runs-on (jobparser.go:245)
      const rawRunsOn = src.rawRunsOn === undefined ? undefined : cloneNode(src.rawRunsOn);
      if (rawRunsOn !== undefined) {
        const evaluatedRunsOn = evaluateYamlNode(evaluator, rawRunsOn);
        if (evaluatedRunsOn.error !== null) {
          return { combos: [], error: new Error(`interpolate runs-on for job ${JSON.stringify(jobId)}: ${evaluatedRunsOn.error.message}`) };
        }
        const runsOnNodeEvaluated = evaluatedRunsOn.replacement ?? rawRunsOn;
        if (runsOnProblem(runsOnNodeEvaluated) !== "") {
          combo.rawRunsOn = rawRunsOn;
        } else {
          const runsOn = runsOnFromNode(runsOnNodeEvaluated).map(escapeExpressions);
          combo.rawRunsOn = runsOnNode(runsOn, "");
        }
      }
    }
    if (combo.rawContinueOnError !== undefined) {
      let continueNode = cloneNode(combo.rawContinueOnError);
      const evaluatedContinue = evaluateYamlNode(evaluator, continueNode);
      if (evaluatedContinue.error !== null) {
        return { combos: [], error: new Error(`evaluate continue-on-error for job ${JSON.stringify(jobId)}: ${evaluatedContinue.error.message}`) };
      }
      if (evaluatedContinue.replacement !== null) {
        continueNode = evaluatedContinue.replacement;
      }
      combo.rawContinueOnError = continueNode;
      // the decode arm (jobparser.go:263-270): a bool node re-encodes
      // normalized; anything else keeps its expression text escaped
      const asBool = scalarBool(continueNode);
      if (asBool === null) {
        replaceScalars(continueNode, escapeExpressions);
      } else {
        (continueNode as Scalar).value = asBool;
      }
    }
    combos.push({
      jobId,
      job: combo,
      deferred: false,
      payload: opts.header === undefined ? null : marshalComboPayload(opts.header, combo),
    });
  }
  return { combos, error: null };
}

/** scalarBool reads a node as the bool Go's Decode(&bool) yields — only a
 *  boolean-typed node decodes; null answers for everything else. */
function scalarBool(node: YamlNode): boolean | null {
  const resolved = resolveAlias(node) ?? node;
  if (!isScalar(resolved)) return null;
  return typeof resolved.value === "boolean" ? resolved.value : null;
}

/**
 * expandMatrixWithNeeds (jobparser.go:165-178) returns one Job per
 * combination of job's matrix, resolved against the completed needs in
 * results. The results map must also describe jobID itself, which is where
 * the interpeter reads the job's own needs from. maxCombinations caps how
 * many combinations may be built — the values come from a needs output at
 * runtime, so the cap has to be enforced before one Job is materialized per
 * combination.
 */
export function expandMatrixWithNeeds(input: {
  jobId: string;
  job: JobModel;
  gitContext: unknown;
  results: Record<string, ServerJobResult>;
  vars: Record<string, string> | undefined;
  inputs: Record<string, unknown> | undefined;
  maxCombinations: number;
}): { combos: WorkflowJobCombo[]; error: Error | null } {
  const job = cloneJobModel(input.job);
  const evaluator = newJobEvaluatorFromStrategy({
    jobId: input.jobId,
    strategy: job.strategy,
    matrix: {},
    gitContext: input.gitContext,
    results: input.results,
    vars: input.vars,
    inputs: input.inputs,
  });
  const resolveError = resolveStrategy(job.strategy, evaluator);
  if (resolveError !== null) {
    return { combos: [], error: resolveError };
  }
  let matrixes: MatrixCombination[];
  try {
    matrixes = matrixCombinations(strategyNodeOf(job.strategy), job.strategy.rawMatrix);
  } catch (thrown) {
    return { combos: [], error: new Error(`ExpandMatrixWithNeeds: ${thrown instanceof Error ? thrown.message : String(thrown)}`) };
  }
  return buildMatrixCombosInto(input.jobId, job, matrixes, {
    gitContext: input.gitContext,
    vars: input.vars,
    inputs: input.inputs,
    results: input.results,
    maxCombinations: input.maxCombinations,
  });
}

/** cloneJobModel is Job.Clone (model.go:128-152): the field set copies; the
 *  nodes the bake rewrites re-clone on demand. */
function cloneJobModel(job: JobModel): JobModel {
  return {
    id: job.id,
    name: job.name,
    rawNeeds: job.rawNeeds,
    rawRunsOn: job.rawRunsOn,
    rawIf: job.rawIf,
    rawContinueOnError: job.rawContinueOnError,
    strategy: { ...job.strategy },
    rawConcurrency: job.rawConcurrency,
    uses: job.uses,
    node: job.node,
  };
}

/**
 * marshalComboPayload renders the single-job payload for one combo —
 * SetJob's map-marshal (alphabetized job fields) over the workflow header
 * the module's payload discipline carries, with needs erased
 * (insertRunJob's SetJob(id, job.EraseNeeds()), run.go:195-202).
 */
export function marshalComboPayload(header: Array<[string, YamlNode]>, combo: JobModel, opts: { eraseNeeds?: boolean } = {}): Uint8Array {
  const jobNode = cloneNode(combo.node) as YAMLMap;
  // insertRunJob's SetJob(id, job.EraseNeeds()) erases; Parse's own
  // SetJob (jobparser.go:139) keeps them — the fixtures compare that shape
  if (opts.eraseNeeds === true) {
    jobNode.items = jobNode.items.filter((pair) => decodeScalarText(pair.key as YamlNode) !== "needs");
  }
  // SingleWorkflow.jobs' nil-step filter (model.go:50-58): a null step
  // (`-` with no value) drops from the payload the marshal re-encodes
  for (const pair of jobNode.items) {
    if (decodeScalarText(pair.key as YamlNode) !== "steps") continue;
    const steps = pair.value as YAMLSeq | undefined;
    if (steps !== undefined && isSeq(steps)) {
      steps.items = steps.items.filter(
        (item) => item !== undefined && item !== null && !(isScalar(item) && item.value === null),
      );
    }
  }
  setMapKey(jobNode, "name", textScalar(combo.name));
  // the strategy: the baked matrix + job-index/job-total, omitted when fully
  // empty (the struct's omitempty fields all zero)
  if (
    combo.strategy.rawMatrix !== undefined ||
    combo.strategy.maxParallelString !== "" ||
    combo.strategy.failFastString !== "" ||
    combo.strategy.jobIndex !== 0 ||
    combo.strategy.jobTotal !== 0
  ) {
    const strategyMap = new YamlMapCtor();
    if (combo.strategy.failFastString !== "") {
      strategyMap.items.push(new Pair(textScalar("fail-fast"), textScalar(combo.strategy.failFastString)));
    }
    if (combo.strategy.maxParallelString !== "") {
      strategyMap.items.push(new Pair(textScalar("max-parallel"), textScalar(combo.strategy.maxParallelString)));
    }
    if (combo.strategy.rawMatrix !== undefined) {
      strategyMap.items.push(new Pair(textScalar("matrix"), combo.strategy.rawMatrix));
    }
    if (combo.strategy.jobIndex !== 0) {
      strategyMap.items.push(new Pair(textScalar("job-index"), new Scalar(combo.strategy.jobIndex)));
    }
    if (combo.strategy.jobTotal !== 0) {
      strategyMap.items.push(new Pair(textScalar("job-total"), new Scalar(combo.strategy.jobTotal)));
    }
    setMapKey(jobNode, "strategy", strategyMap);
  }
  if (combo.rawRunsOn !== undefined) {
    setMapKey(jobNode, "runs-on", combo.rawRunsOn);
  }
  if (combo.rawContinueOnError !== undefined) {
    const continueNode = combo.rawContinueOnError;
    // the normalized bool arm re-encodes (jobparser.go:263-270); an
    // unevaluated expression keeps its escaped text
    setMapKey(jobNode, "continue-on-error", continueNode);
  }
  // SetJob's marshal order: the job's fields alphabetize (a Go map marshal)
  jobNode.items.sort((a, b) => {
    const ka = decodeScalarText(a.key as YamlNode);
    const kb = decodeScalarText(b.key as YamlNode);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const doc = new Document();
  const headerNode = new YamlMapCtor();
  for (const [key, node] of header) {
    headerNode.items.push(new Pair(textScalar(key), cloneNode(node)));
  }
  const jobs = new YamlMapCtor();
  jobs.items.push(new Pair(textScalar(combo.id), jobNode));
  headerNode.items.push(new Pair(textScalar("jobs"), jobs));
  doc.contents = headerNode;
  return new TextEncoder().encode(doc.toString({ lineWidth: 0 }));
}

/** setMapKey replaces or appends one mapping entry. */
function setMapKey(map: YAMLMap, key: string, value: YamlNode): void {
  for (const pair of map.items) {
    if (decodeScalarText(pair.key as YamlNode) === key) {
      pair.value = value;
      return;
    }
  }
  map.items.push(new Pair(textScalar(key), value));
}

/** maxParallelOfCombo is services/actions parseMaxParallel (max_parallel.go:
 * 12-18): the strategy string's number, 0 meaning unlimited, capped at
 * MaxJobNumPerRun; an unevaluated expression on a deferred placeholder warns
 * through as unlimited. */
export function maxParallelOfCombo(jobId: string, strategy: StrategyModel): number {
  const { limit, error } = strategyMaxParallel(strategy);
  if (error !== null && !strategy.maxParallelString.includes("${{")) {
    console.error(`[actions-workflow-model] job ${jobId}: ${error.message}, treating as unlimited`);
  }
  return Math.min(limit, MAX_MATRIX_COMBINATIONS);
}
