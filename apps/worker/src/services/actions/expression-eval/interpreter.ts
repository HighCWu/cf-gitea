// Copyright 2022 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/exprparser/interpreter.go — the evaluator of
// one `${{ }}` expression against the contexts and the functions GitHub
// Actions defines (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the
// submodule's pin; SPEC-0012 §D5 tier E).
//
// Deviations from the Go original, each pinned by the fixtures:
//   - Go inspects values through reflect (struct fields, pointer chains,
//     TextMarshaler); this port's values are plain JS values, so the
//     struct-walk arms are absent — typed step statuses arrive as the
//     strings GitHub marshals them to.
//   - Collection identity (interpreter.go:869-907 plus referencePath
//     :909-933) reduces to JS reference identity: Go needs the referencePath
//     spelling because a struct reaches an expression as a copy, while JS
//     hands the evaluator the original reference — every identity fixture
//     (same-struct, distinct-empty-arrays, needs.a == needs.b, the nil-map
//     pairs) verdicts identically through `===`.
//   - A Go nil map reads as an Object-kind empty container; the environment
//     models an absent map slot as one memoized NilContext per slot
//     (kinds.ts), so `secrets == secrets` / `secrets != env` hold.

import {
  CompareOpNodeKind,
  FindExprNode,
  LogicalOpNodeKind,
  type ExprError,
  type ExprNode,
  type FuncCallNode,
} from "../expression-syntax/ast";
import { ExprLexer } from "../expression-syntax/lexer";
import { NewValidatingParser } from "../expression-syntax/parser";
import {
  OrdinalIgnoreCaseCompare,
  OrdinalIgnoreCaseEqual,
  OrdinalIgnoreCaseHasPrefix,
  OrdinalIgnoreCaseHasSuffix,
} from "../expression-syntax/ordinal";
import { Evaluation, ERR_EXPRESSION_TOO_LARGE } from "./memory";
import { coerceToNumber, coerceToString, EvaluationKind, FilteredArray, getEvaluationKind, isTruthy, NilContext, numberValue, parseNumber } from "./kinds";
import { asOrderedObject, plainValue } from "./object";
import {
  containsFunction,
  evaluateCaseArgs,
  evaluateHashFiles,
  formatFunction,
  fromJSONFunction,
  joinFunction,
  jobFailure,
  jobStatus,
  jobSuccess,
  matchStringsFunction,
  needsResultOf,
  toJSONFunction,
} from "./functions";

/**
 * EvaluationEnvironment is the context table one evaluation reads
 * (interpreter.go:26-40). Every slot is optional: a map slot left undefined
 * reads as upstream's nil map (a NilContext), `github`/`job` left undefined
 * read as null, and `jobs` left undefined errors on resolution
 * ("Unavailable context: jobs") — the exact upstream dispositions.
 */
export interface EvaluationEnvironment {
  github?: unknown;
  env?: unknown;
  /** job is upstream's JobContext: the status the status functions read, plus any container the workflow carries. */
  job?: ({ status?: string } & Record<string, unknown>) | undefined;
  jobs?: unknown;
  steps?: unknown;
  runner?: unknown;
  secrets?: unknown;
  vars?: unknown;
  strategy?: unknown;
  matrix?: unknown;
  needs?: unknown;
  inputs?: unknown;
  /** hashFiles replaces the disabled filesystem globber — the runner-side hook (interpreter.go:39). */
  hashFiles?: (args: unknown[]) => unknown;
}

/** Needs is one entry of the needs context (interpreter.go:42-45). */
export interface Needs {
  outputs?: Record<string, string>;
  result?: string;
}

/**
 * RunShape is the slice of the workflow model the evaluator walks: the job
 * id, the jobs' needs lists, their results and outputs. The YAML model port
 * wraps this at the call sites; the evaluator never parses YAML.
 */
export interface RunShape {
  jobId: string;
  workflow?: {
    jobs: Record<string, JobShape>;
  } | undefined;
}

/** JobShape is one job of the run shape: the needs list, the result and the outputs. */
export interface JobShape {
  needs?: string[];
  result?: string;
  outputs?: Record<string, string>;
  continueOnError?: boolean;
}

/** needsContext builds the job's needs context, skipping needs the workflow does not define (interpreter.go:48-63). */
export function needsContext(run: RunShape | undefined): Record<string, Needs> {
  const needs: Record<string, Needs> = {};
  if (run === undefined || run.workflow === undefined) {
    return needs;
  }
  const current = run.workflow.jobs[run.jobId];
  if (current === undefined) {
    return needs;
  }
  for (const id of current.needs ?? []) {
    const job = run.workflow.jobs[id];
    if (job !== undefined) {
      needs[id] = { outputs: job.outputs, result: needsResultOf(job) };
    }
  }
  return needs;
}

/**
 * StrategyContextInput is the slice of the model's Strategy the context
 * reads: the parsed fail-fast, the parsed max-parallel, and whether a raw
 * matrix is present. Parsing those out of the YAML model belongs to the
 * model port; the assembly rules here are upstream's.
 */
export interface StrategyContextInput {
  failFast: boolean;
  maxParallel: number;
  hasRawMatrix: boolean;
}

/** strategyContext omits job-index and job-total when total is 0, meaning unknown (interpreter.go:66-81). */
export function strategyContext(strategy: StrategyContextInput | undefined, index: number, total: number): Record<string, unknown> {
  const failFast = strategy?.failFast ?? true;
  let maxParallel = strategy?.maxParallel ?? 0;
  if (total > 0) {
    if (maxParallel === 0 || !(strategy?.hasRawMatrix ?? false)) {
      maxParallel = total;
    }
    return { "fail-fast": failFast, "job-index": index, "job-total": total, "max-parallel": maxParallel };
  }
  if (maxParallel > 0) {
    return { "fail-fast": failFast, "max-parallel": maxParallel };
  }
  return { "fail-fast": failFast };
}

/** Config scopes one interpeter (interpreter.go:83-87). */
export interface Config {
  /** run carries the needs graph success()/failure() walk. */
  run?: RunShape | undefined;
  /** workingDir backs hashFiles' filesystem glob; empty means the function is unavailable — the server's own posture (SPEC-0012 §D1). */
  workingDir?: string;
  /** context is "job" or "step", which decides what success() and failure() read. */
  context?: string;
  /**
   * contextRoots replaces the whole named-context table — validation and
   * resolution both consult it — which is how upstream's corpus test injects
   * the per-case contexts (languageservices_test.go:147-162). Production
   * callers leave it unset.
   */
  contextRoots?: Record<string, unknown>;
}

/** DefaultStatusCheck is the check an expression without its own status function runs under (interpreter.go:89-111). */
export enum DefaultStatusCheck {
  None = "",
  Success = "success",
  Always = "always",
  Canceled = "cancelled",
  Failure = "failure",
}

/** The named values an expression may read (interpreter.go:238-257). */
const NAMED_VALUE_NAMES = new Set([
  "github", "gitea", "env", "job", "jobs", "steps", "runner", "secrets", "vars", "strategy", "matrix", "needs", "inputs",
]);

/** The map-typed contexts: a slot left undefined reads as upstream's nil map. */
const MAP_CONTEXTS = new Set(["env", "steps", "runner", "secrets", "vars", "strategy", "matrix", "needs", "inputs"]);

function isStatusFunction(loweredCallee: string): boolean {
  return loweredCallee === "success" || loweredCallee === "always" || loweredCallee === "cancelled" || loweredCallee === "failure";
}

function statusCheckNode(defaultStatusCheck: DefaultStatusCheck): FuncCallNode {
  return { kind: "funcCall", callee: defaultStatusCheck, args: [] };
}

/** callsStatusFunction reports whether the expression asks its own status question (interpreter.go:180-182). */
export function callsStatusFunction(exprNode: ExprNode): boolean {
  return FindExprNode(exprNode, isStatusFunctionCallNode);
}

/** isStatusFunctionCallNode reports whether the node itself is a status function call (interpreter.go:185-188). */
export function isStatusFunctionCallNode(node: ExprNode): boolean {
  return node.kind === "funcCall" && isStatusFunction(node.callee.toLowerCase());
}

/**
 * ParseEvalError carries a syntax-layer ExprError through the Error surface,
 * so a caller can tell a parse error from an evaluation error the way
 * upstream's errors.As(err, &parseError) does.
 */
export class ParseEvalError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  constructor(err: ExprError) {
    super(err.message);
    this.name = "ParseEvalError";
    this.offset = err.offset;
    this.line = err.line;
    this.column = err.column;
  }
}

/** EvaluateResult is the (value, error) pair Go's Evaluate returns. */
export interface EvaluateResult {
  value: unknown;
  error: Error | null;
}

/** Interpeter evaluates the source of one expression (interpreter.go:113-116). */
export interface Interpeter {
  evaluate(input: string, defaultStatusCheck: DefaultStatusCheck): EvaluateResult;
}

/** newInterpeter builds an interpeter over the environment and config (interpreter.go:124-129). */
export function newInterpeter(env: EvaluationEnvironment | undefined, config: Config): Interpeter {
  return new InterpeterImpl(env ?? {}, config);
}

class InterpeterImpl implements Interpeter {
  private readonly env: EvaluationEnvironment;
  private readonly config: Config;
  private readonly nilContexts = new Map<string, NilContext>();

  constructor(env: EvaluationEnvironment, config: Config) {
    this.env = env;
    this.config = config;
  }

  /** isNamedValue is the parse-time gate (interpreter.go:259-262); the corpus roots replace the table. */
  private readonly isNamedValue = (name: string): boolean => {
    if (this.config.contextRoots !== undefined) {
      return name.toLowerCase() in this.config.contextRoots;
    }
    return NAMED_VALUE_NAMES.has(name.toLowerCase());
  };

  /**
   * evaluate evaluates one expression (interpreter.go:131-163). An empty
   * input asks defaultStatusCheck on its own, which is what a value that
   * carries no expression of its own runs under.
   */
  evaluate(input: string, defaultStatusCheck: DefaultStatusCheck): EvaluateResult {
    const memory = Evaluation.newEvaluation();

    if (input === "" && defaultStatusCheck !== DefaultStatusCheck.None) {
      return { value: this.evaluateNode(statusCheckNode(defaultStatusCheck), memory), error: null };
    }

    const parser = NewValidatingParser(this.config.context ?? "", this.isNamedValue);
    const parsed = parser.Parse(new ExprLexer(input));
    if (parsed.error !== null) {
      return { value: null, error: new ParseEvalError(parsed.error) };
    }
    let exprNode: ExprNode = parsed.node!;

    if (defaultStatusCheck !== DefaultStatusCheck.None && !callsStatusFunction(exprNode)) {
      exprNode = {
        kind: "logicalOp",
        op: LogicalOpNodeKind.And,
        left: statusCheckNode(defaultStatusCheck),
        right: exprNode,
      };
    }

    let error: Error | null = null;
    let evaluated: unknown;
    try {
      evaluated = this.evaluateNode(exprNode, memory);
    } catch (thrown) {
      const asError = thrown instanceof Error ? thrown : new Error(String(thrown));
      if (asError.message === ERR_EXPRESSION_TOO_LARGE) {
        error = new Error(`${ERR_EXPRESSION_TOO_LARGE} while evaluating the following expression: ${input}`);
      } else {
        error = asError;
      }
      evaluated = null; // Go returns the nil interface alongside the error
    }
    if (evaluated instanceof FilteredArray) {
      evaluated = evaluated.items;
    }
    const plain = plainValue(evaluated);
    return { value: plain.value, error };
  }

  /** evaluateNode charges a node's result against the budget (interpreter.go:192-201). */
  private evaluateNode(exprNode: ExprNode, memory: Evaluation): unknown {
    const value = this.evaluateNodeCore(exprNode, memory);
    memory.charge(value);
    return value;
  }

  private evaluateNodeCore(exprNode: ExprNode, memory: Evaluation): unknown {
    switch (exprNode.kind) {
      case "variable":
        return this.evaluateVariable(exprNode.name);
      case "bool":
        return exprNode.value;
      case "null":
        return null; // Go's single nil: a miss, a null literal and an absent context all read the same
      case "number":
        return exprNode.value;
      case "string":
        return exprNode.value;
      case "indexAccess":
        return this.evaluateIndexAccess(exprNode, memory);
      case "objectDeref":
        return this.evaluateObjectDeref(exprNode, memory);
      case "arrayDeref":
        return this.evaluateArrayDeref(exprNode, memory);
      case "notOp":
        return !isTruthy(this.evaluateNode(exprNode.operand, memory.nested()));
      case "compareOp":
        return this.evaluateCompare(exprNode, memory);
      case "logicalOp":
        return this.evaluateLogicalCompare(exprNode, memory);
      case "funcCall":
        return this.evaluateFuncCall(exprNode, memory);
    }
  }

  /** evaluateVariable resolves one named context (interpreter.go:264-270). */
  private evaluateVariable(name: string): unknown {
    if (this.config.contextRoots !== undefined) {
      const root = this.config.contextRoots[name.toLowerCase()];
      return root === undefined ? null : root;
    }
    const lowered = name.toLowerCase();
    switch (lowered) {
      case "github":
      case "gitea": // compatible with Gitea
        return this.env.github ?? null;
      case "job":
        return this.env.job ?? null;
      case "jobs":
        if (this.env.jobs === undefined) {
          throw new Error("Unavailable context: jobs");
        }
        return this.env.jobs;
      default:
        if (MAP_CONTEXTS.has(lowered)) {
          return this.mapContext(lowered);
        }
        throw new Error(`Unavailable context: ${name}`);
    }
  }

  /** mapContext hands back the slot's value, or its memoized nil-map sentinel. */
  private mapContext(name: string): unknown {
    const value = (this.env as Record<string, unknown>)[name];
    if (value !== undefined) {
      return value;
    }
    let nil = this.nilContexts.get(name);
    if (nil === undefined) {
      nil = new NilContext(name);
      this.nilContexts.set(name, nil);
    }
    return nil;
  }

  /** evaluateIndexAccess reads left[index] (interpreter.go:272-288): the index is only asked when the operand is a container. */
  private evaluateIndexAccess(node: Extract<ExprNode, { kind: "indexAccess" }>, memory: Evaluation): unknown {
    const left = this.evaluateNode(node.operand, memory.nested());

    let right: unknown;
    const leftKind = getEvaluationKind(left);
    if (leftKind === EvaluationKind.Object || leftKind === EvaluationKind.Array) {
      right = this.evaluateNode(node.index, memory.nested());
    }

    return this.projectIndex(left, { value: right, isName: false }, memory);
  }

  /** projectIndex reads left[index]; a filtered array projects item by item (interpreter.go:314-336). */
  private projectIndex(left: unknown, index: IndexKey, memory: Evaluation): unknown {
    if (left instanceof FilteredArray) {
      const result: unknown[] = [];
      for (const item of left.items) {
        const found = this.getIndexValue(item, index);
        if (!found.found) {
          continue;
        }
        memory.chargeProjected(1);
        result.push(found.value === undefined ? null : found.value);
      }
      return new FilteredArray(result);
    }
    const found = this.getIndexValue(left, index);
    if (!found.found) {
      return null;
    }
    return found.value === undefined ? null : found.value;
  }

  /** getIndexValue reads one value's index (interpreter.go:340-357). */
  private getIndexValue(left: unknown, index: IndexKey): { found: true; value: unknown } | { found: false } {
    const kind = getEvaluationKind(left);
    switch (kind) {
      case EvaluationKind.Object: {
        const property = indexKeyName(index);
        if (!property.found) {
          return { found: false };
        }
        return this.getObjectProperty(left, property.name);
      }
      case EvaluationKind.Array: {
        const position = indexKeyPosition(index);
        const items = left instanceof FilteredArray ? left.items : (left as unknown[]);
        if (!position.found || position.position >= items.length) {
          return { found: false };
        }
        return { found: true, value: items[position.position] };
      }
      default:
        return { found: false };
    }
  }

  /** evaluateObjectDeref reads receiver.property (interpreter.go:379-386). */
  private evaluateObjectDeref(node: Extract<ExprNode, { kind: "objectDeref" }>, memory: Evaluation): unknown {
    const left = this.evaluateNode(node.receiver, memory.nested());
    return this.projectIndex(left, { property: node.property, isName: true }, memory);
  }

  /** evaluateArrayDeref evaluates the `*` filter (interpreter.go:388-404). */
  private evaluateArrayDeref(node: Extract<ExprNode, { kind: "arrayDeref" }>, memory: Evaluation): unknown {
    const left = this.evaluateNode(node.receiver, memory.nested());

    const result = new FilteredArray([]);
    if (left instanceof FilteredArray) {
      for (const item of left.items) {
        appendCollectionValues(result, item, memory);
      }
      return result;
    }
    appendCollectionValues(result, left, memory);
    return result;
  }

  /**
   * getObjectProperty reads one property off an object (interpreter.go:406-452):
   * an ordered object resolves through its case-folded index; a plain object
   * prefers the exact key, then the byte-wise smallest case-insensitive match
   * (the deterministic-lookup pin — "PATH" beats "Path" beats "path").
   */
  private getObjectProperty(left: unknown, property: string): { found: true; value: unknown } | { found: false } {
    const ordered = asOrderedObject(left);
    if (ordered !== undefined) {
      return ordered.get(property);
    }
    if (left !== null && typeof left === "object") {
      const record = left as Record<string, unknown>;
      if (property in record) {
        return { found: true, value: record[property] };
      }
      let matchedKey: string | undefined;
      let matched: unknown;
      for (const key of Object.keys(record)) {
        if (OrdinalIgnoreCaseEqual(key, property) && (matchedKey === undefined || key < matchedKey)) {
          matchedKey = key;
          matched = record[key];
        }
      }
      if (matchedKey !== undefined) {
        return { found: true, value: matched };
      }
      return { found: false };
    }
    return { found: false };
  }

  /** evaluateCompare evaluates one comparison (interpreter.go:656-686). */
  private evaluateCompare(node: Extract<ExprNode, { kind: "compareOp" }>, memory: Evaluation): unknown {
    const left = this.evaluateNode(node.left, memory.nested());
    const right = this.evaluateNode(node.right, memory.nested());
    return this.compareValues(left, right, node.op);
  }

  /** compareValues coerces then compares (interpreter.go:688-705). */
  private compareValues(left: unknown, right: unknown, kind: CompareOpNodeKind): boolean {
    const coerced = coerceTypes(left, right);
    const equal = this.equalValues(coerced.left, coerced.right, coerced.leftKind, coerced.rightKind);
    switch (kind) {
      case CompareOpNodeKind.Eq:
        return equal;
      case CompareOpNodeKind.NotEq:
        return !equal;
      case CompareOpNodeKind.Less:
      case CompareOpNodeKind.Greater:
        return this.compareOrderedValues(coerced.left, coerced.right, coerced.leftKind, coerced.rightKind, kind);
      case CompareOpNodeKind.LessEq:
        return equal || this.compareOrderedValues(coerced.left, coerced.right, coerced.leftKind, coerced.rightKind, CompareOpNodeKind.Less);
      case CompareOpNodeKind.GreaterEq:
        return equal || this.compareOrderedValues(coerced.left, coerced.right, coerced.leftKind, coerced.rightKind, CompareOpNodeKind.Greater);
      default:
        return false;
    }
  }

  /** equalValues compares same-kind values for equality (interpreter.go:810-830). */
  private equalValues(left: unknown, right: unknown, leftKind: EvaluationKind, rightKind: EvaluationKind): boolean {
    if (leftKind !== rightKind) {
      return false;
    }
    switch (leftKind) {
      case EvaluationKind.Null:
        return true;
      case EvaluationKind.Boolean:
        return left === right;
      case EvaluationKind.Number:
        return this.compareNumber(numberValue(left), numberValue(right), CompareOpNodeKind.Eq);
      case EvaluationKind.String:
        return this.compareString(left as string, right as string, CompareOpNodeKind.Eq);
      case EvaluationKind.Object:
      case EvaluationKind.Array:
        return collectionReferenceEqual(left, right);
      default:
        return false;
    }
  }

  /** compareOrderedValues orders same-kind values (interpreter.go:832-854). */
  private compareOrderedValues(left: unknown, right: unknown, leftKind: EvaluationKind, rightKind: EvaluationKind, kind: CompareOpNodeKind): boolean {
    if (leftKind !== rightKind) {
      return false;
    }
    switch (leftKind) {
      case EvaluationKind.Boolean:
        if (kind === CompareOpNodeKind.Less) {
          return left === false && right === true;
        }
        return left === true && right === false;
      case EvaluationKind.Number:
        return this.compareNumber(numberValue(left), numberValue(right), kind);
      case EvaluationKind.String:
        return this.compareString(left as string, right as string, kind);
      default:
        return false;
    }
  }

  /** compareString orders strings case-insensitively (interpreter.go:977-989). */
  private compareString(left: string, right: string, kind: CompareOpNodeKind): boolean {
    const comparison = OrdinalIgnoreCaseCompare(left, right);
    switch (kind) {
      case CompareOpNodeKind.Less:
        return comparison < 0;
      case CompareOpNodeKind.Greater:
        return comparison > 0;
      case CompareOpNodeKind.Eq:
        return comparison === 0;
      default:
        return false;
    }
  }

  /** compareNumber orders numbers (interpreter.go:991-1002). */
  private compareNumber(left: number, right: number, kind: CompareOpNodeKind): boolean {
    switch (kind) {
      case CompareOpNodeKind.Less:
        return left < right;
      case CompareOpNodeKind.Greater:
        return left > right;
      case CompareOpNodeKind.Eq:
        return left === right;
      default:
        return false;
    }
  }

  /** normalizeNumber normalizes -0, which GitHub also renders as "0" (interpreter.go:1028-1033). */
  private normalizeNumber(value: unknown): unknown {
    if (typeof value === "number" && value === 0) {
      return 0;
    }
    return value;
  }

  /** evaluateLogicalCompare evaluates && and ||, returning a value rather than a boolean (interpreter.go:1035-1051). */
  private evaluateLogicalCompare(node: Extract<ExprNode, { kind: "logicalOp" }>, memory: Evaluation): unknown {
    const left = this.evaluateNode(node.left, memory.nested());

    if (isTruthy(left) === (node.op === LogicalOpNodeKind.Or)) {
      return this.normalizeNumber(left);
    }

    const right = this.evaluateNode(node.right, memory.nested());
    return this.normalizeNumber(right);
  }

  /** evaluateFuncCall dispatches one call (interpreter.go:1053-1111). */
  private evaluateFuncCall(node: FuncCallNode, memory: Evaluation): unknown {
    const callee = node.callee.toLowerCase();
    const evaluateArg = (argument: ExprNode): unknown => this.evaluateNode(argument, memory.nested());
    switch (callee) {
      case "case":
        return this.evaluateCase(node, memory);
      case "format":
        return formatFunction(node.args, evaluateArg);
      case "join":
        return joinFunction(node.args, evaluateArg);
      case "contains":
        return containsFunction(node.args, evaluateArg, (left, right) => this.compareValues(left, right, CompareOpNodeKind.Eq));
      case "startswith":
        return matchStringsFunction(node.args, evaluateArg, OrdinalIgnoreCaseHasPrefix);
      case "endswith":
        return matchStringsFunction(node.args, evaluateArg, OrdinalIgnoreCaseHasSuffix);
    }

    const args: unknown[] = [];
    for (const argument of node.args) {
      args.push(evaluateArg(argument));
    }

    switch (callee) {
      case "tojson":
        return toJSONFunction(args[0]);
      case "fromjson":
        return fromJSONFunction(args[0]);
      case "hashfiles":
        if (this.env.hashFiles !== undefined) {
          return this.env.hashFiles(args);
        }
        return evaluateHashFiles(args, this.config.workingDir ?? "");
      case "always":
        return true;
      // a cancellation is a property of the run, so both scopes read the job status
      case "cancelled":
        return jobStatus(this.env) === "cancelled";
      case "success":
      case "failure":
        switch (this.config.context) {
          case "job":
            return callee === "success" ? jobSuccess(this.config.run) : jobFailure(this.config.run);
          case "step":
            return jobStatus(this.env) === callee;
          default:
            throw new Error(`Context '${this.config.context}' must be one of 'job' or 'step'`);
        }
      default:
        throw new Error(`TODO: '${node.callee}' not implemented`);
    }
  }

  /** evaluateCase evaluates case() lazily in pairs (interpreter.go:1113-1128). */
  private evaluateCase(node: FuncCallNode, memory: Evaluation): unknown {
    return evaluateCaseArgs(node.args, (argument) => this.evaluateNode(argument, memory.nested()));
  }
}

/** IndexKey is what an index access or a property dereference names (interpreter.go:292-310). */
interface IndexKey {
  property?: string;
  value?: unknown;
  isName: boolean;
}

/** indexKeyName reads the index as an object property (interpreter.go:298-303). */
function indexKeyName(key: IndexKey): { found: true; name: string } | { found: false } {
  if (key.isName) {
    return { found: true, name: key.property! };
  }
  return stringIndex(key.value);
}

/** indexKeyPosition reads the index as an array position (interpreter.go:305-310). */
function indexKeyPosition(key: IndexKey): { found: true; position: number } | { found: false } {
  const number = key.isName ? parseNumber(key.property!) : coerceToNumber(key.value);
  return numberIndex(number);
}

/** numberIndex bounds an array position (interpreter.go:359-368). */
function numberIndex(number: number): { found: true; position: number } | { found: false } {
  if (Number.isNaN(number) || number < 0) {
    return { found: false };
  }
  number = Math.floor(number);
  if (number > 0x7fffffff) {
    return { found: false };
  }
  return { found: true, position: number };
}

/** stringIndex reads an index name off a primitive (interpreter.go:370-377). */
function stringIndex(value: unknown): { found: true; name: string } | { found: false } {
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Null:
    case EvaluationKind.Boolean:
    case EvaluationKind.Number:
    case EvaluationKind.String:
      return { found: true, name: coerceToString(value) };
    default:
      return { found: false };
  }
}

/** coerceTypes brings two values to one evaluation kind (interpreter.go:718-743). */
function coerceTypes(left: unknown, right: unknown): { left: unknown; right: unknown; leftKind: EvaluationKind; rightKind: EvaluationKind } {
  for (;;) {
    const leftKind = getEvaluationKind(left);
    const rightKind = getEvaluationKind(right);
    if (leftKind === rightKind) {
      return { left, right, leftKind, rightKind };
    }
    if (leftKind === EvaluationKind.Number && rightKind === EvaluationKind.String) {
      return { left, right: coerceToNumber(right), leftKind, rightKind: EvaluationKind.Number };
    }
    if (leftKind === EvaluationKind.String && rightKind === EvaluationKind.Number) {
      return { left: coerceToNumber(left), right, leftKind: EvaluationKind.Number, rightKind };
    }
    if (leftKind === EvaluationKind.Boolean || leftKind === EvaluationKind.Null) {
      left = coerceToNumber(left);
      continue;
    }
    if (rightKind === EvaluationKind.Boolean || rightKind === EvaluationKind.Null) {
      right = coerceToNumber(right);
      continue;
    }
    return { left, right, leftKind, rightKind };
  }
}

/** collectionReferenceEqual compares container identity — JS reference equality; see the header note (interpreter.go:869-887). */
function collectionReferenceEqual(left: unknown, right: unknown): boolean {
  return left === right;
}

/** appendCollectionValues projects one value into a filtered array (interpreter.go:480-526). */
function appendCollectionValues(result: FilteredArray, value: unknown, memory: Evaluation): void {
  const ordered = asOrderedObject(value);
  if (ordered !== undefined) {
    memory.chargeProjected(ordered.length);
    for (const item of ordered.values()) {
      result.items.push(item);
    }
    return;
  }
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Object: {
      // GitHub projects a map in insertion order, which a Go map lacks, so
      // sorting stands in (interpreter.go:489-504); JS keys are strings, so
      // the default sort is the byte-wise order Go compares with.
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      memory.chargeProjected(keys.length);
      for (const key of keys) {
        result.items.push(record[key]);
      }
      return;
    }
    case EvaluationKind.Array: {
      const items = value instanceof FilteredArray ? value.items : (value as unknown[]);
      memory.chargeProjected(items.length);
      for (const item of items) {
        result.items.push(item);
      }
      return;
    }
    default:
      return;
  }
}
