// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/expreval/evaluator.go — the string-level
// evaluator that finds `${{ }}` expressions in a value and evaluates them
// against one interpeter, plus the YAML-node walker EvaluateYamlNode
// (evaluator.go:96-260; gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the
// submodule's pin; SPEC-0012 §D5 tier E).
//
// Not ported here:
//   - ResolveWorkflowCallInputs / EvaluateWorkflowCallOutputs /
//     EvaluateCallerSecrets ride expreval/workflow_call.go — v2-staged
//     (§D2 #12), dropped per §D4.
//
// The subexpression split, Match, Literal, ReadsContext and CallsFunction
// live in the syntax layer (expression-syntax/subexpr.ts, upstream
// subexpr.go) — this module consumes them.
//
// The YAML-node walker maps go-yaml's node kinds onto the `yaml` package's
// (ScalarNode→Scalar, MappingNode→YAMLMap, SequenceNode→YAMLSeq, AliasNode
// resolved by the caller — upstream jobparser expands aliases before
// Parse, aliases.go:53-60). Deviation: go-yaml decodes a replacement back
// into the caller's node in place (Node.Decode(node)); the `yaml` package
// brands node kinds with a read-only symbol, so the walk answers the
// REPLACEMENT for the caller to graft into its slot — an untouched node
// answers null and keeps its style and comments (evaluator.go:124).

import type { Node as YamlNode, YAMLMap, YAMLSeq } from "yaml";
import { isMap, isScalar, isSeq, Pair, Scalar, YAMLMap as YamlMapCtor, YAMLSeq as YamlSeqCtor } from "yaml";

import { splitSubExpressions, Match } from "../expression-syntax/subexpr";
import { coerceToString, isTruthy } from "./kinds";
import { DefaultStatusCheck, isStatusFunctionCallNode, type EvaluateResult, type Interpeter } from "./interpreter";

/** EvaluateFunc evaluates the source of a single expression, without the `${{ }}` delimiters (evaluator.go:19-21). */
export type EvaluateFunc = (input: string, defaultStatusCheck: DefaultStatusCheck) => EvaluateResult;

/** EvalBoolResult is the (boolean, error) pair Go's EvalBool returns. */
export interface EvalBoolResult {
  value: boolean;
  error: Error | null;
}

/**
 * Evaluator evaluates the expressions of a value against one interpeter
 * (evaluator.go:24-30).
 */
export class Evaluator {
  private readonly evaluate: EvaluateFunc;

  /** New returns an Evaluator that evaluates single expressions with the given function (evaluator.go:33-35). */
  constructor(evaluate: EvaluateFunc) {
    this.evaluate = evaluate;
  }

  /** interpolate evaluates every part on its own, so a malformed one cannot restructure its neighbours (evaluator.go:38-56). */
  interpolate(input: string): { value: string; error: Error | null } {
    const split = splitSubExpressions(input);
    if (split.error !== null) {
      return { value: "", error: split.error };
    }
    const parts = split.parts;
    if (parts !== null && parts.length === 1 && !parts[0]!.isExpr) {
      return { value: input, error: null };
    }
    let output = "";
    for (const part of parts) {
      if (!part.isExpr) {
        output += part.text;
        continue;
      }
      const evaluated = this.evaluate(part.text, DefaultStatusCheck.None);
      if (evaluated.error !== null) {
        return { value: "", error: evaluated.error };
      }
      output += coerceToString(evaluated.value);
    }
    return { value: output, error: null };
  }

  /** evaluateScalar keeps the type of a lone expression, so `${{ fromJSON('[1,2]') }}` stays an array (evaluator.go:59-66). */
  evaluateScalar(input: string): EvaluateResult {
    const split = splitSubExpressions(input);
    if (split.error !== null) {
      return { value: undefined, error: split.error };
    }
    const parts = split.parts;
    if (parts.length === 1 && parts[0]!.isExpr) {
      return this.evaluate(parts[0]!.text, DefaultStatusCheck.None);
    }
    const interpolated = this.interpolate(input);
    return { value: interpolated.value, error: interpolated.error };
  }

  /**
   * evalBool reads bare expressions and interpolated strings as conditions,
   * like GitHub's ConvertToIfCondition (evaluator.go:69-93). Blank conditions
   * evaluate the default status check alone.
   */
  evalBool(expr: string, defaultStatusCheck: DefaultStatusCheck): EvalBoolResult {
    const split = splitSubExpressions(expr);
    if (split.error !== null) {
      return { value: false, error: split.error };
    }
    const parts = split.parts;
    if (parts.length === 1) {
      // GitHub reads a lone string literal as a condition, so `${{ 'false' }}` becomes false.
      let condition = parts[0]!.text;
      if (parts[0]!.isLiteral) {
        condition = parts[0]!.literal;
      }
      if (condition.trim() === "") {
        condition = "";
      }
      const evaluated = this.evaluate(condition, defaultStatusCheck);
      if (evaluated.error !== null) {
        return { value: false, error: evaluated.error };
      }
      return { value: isTruthy(evaluated.value), error: null };
    }

    if (defaultStatusCheck !== DefaultStatusCheck.None && !Match(expr, isStatusFunctionCallNode)) {
      const status = this.evaluate("", defaultStatusCheck);
      if (status.error !== null) {
        return { value: false, error: status.error };
      }
      if (!isTruthy(status.value)) {
        return { value: false, error: null };
      }
    }
    const interpolated = this.interpolate(expr);
    if (interpolated.error !== null) {
      return { value: false, error: interpolated.error };
    }
    return { value: isTruthy(interpolated.value), error: null };
  }
}

/** NewEvaluator wraps one interpeter's evaluate into an Evaluator (evaluator.go:33-35). */
export function NewEvaluator(interpeter: Interpeter): Evaluator {
  return new Evaluator((input, defaultStatusCheck) => interpeter.evaluate(input, defaultStatusCheck));
}

// ---------------------------------------------------------------------------
// EvaluateYamlNode (evaluator.go:111-272) — the YAML-value walker
// ---------------------------------------------------------------------------

/**
 * The walk returns a REPLACEMENT the caller grafts (a pair slot, an item
 * slot, a model field), not an in-place overwrite: the `yaml` package brands
 * node kinds with a read-only symbol, so a scalar cannot adopt a
 * collection's payload the way go-yaml's Node.Decode(node) does. An
 * untouched node answers null and keeps its style and comments
 * (evaluator.go:123-124).
 */
export interface YamlNodeEval {
  /** The evaluated replacement, or null when nothing in the node holds an
   *  expression. */
  replacement: YamlNode | null;
  error: Error | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * plainNumbers (evaluator.go:157-184) carries numbers through as numbers:
 * the `yaml` package emits them plainly and re-parses them to the same
 * value. Deviation (the evaluator_test.go "scalar keeps its type and number
 * formatting" fixture pins the values): go-yaml renders float64 1e15 as
 * "1E+15" where this emitter writes "1000000000000000" — the one byte
 * divergence, the parsed value is identical; writing the Go-side coerced
 * TEXT instead would make the package quote it and flip the parsed type to
 * string, which the runner would feel.
 */
function plainNumbers(value: unknown): unknown {
  if (value instanceof Scalar) {
    return value; // an already-encoded node (the walk's own recursion)
  }
  if (Array.isArray(value)) {
    return value.map(plainNumbers);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = plainNumbers(item);
    }
    return out;
  }
  return value;
}

/** encodeValue encodes one evaluated JS value as a yaml node, the way
 *  go-yaml's Node.Encode renders interface{} (a plain style; strings quoted
 *  only when the emitter must). The children a plainNumbers pass already
 *  prepared encode without a second pass. */
function encodeValue(value: unknown): YamlNode {
  return encodePrepared(plainNumbers(value));
}

function encodePrepared(prepared: unknown): YamlNode {
  if (prepared instanceof Scalar) return prepared;
  if (Array.isArray(prepared)) {
    const seq = new YamlSeqCtor();
    for (const item of prepared) seq.items.push(encodePrepared(item));
    return seq;
  }
  if (isPlainObject(prepared)) {
    const map = new YamlMapCtor();
    for (const [key, item] of Object.entries(prepared)) {
      map.items.push(new Pair(encodePrepared(key), encodePrepared(item)));
    }
    return map;
  }
  const scalar = new Scalar(prepared === undefined ? null : prepared);
  if (typeof prepared === "string") scalar.type = "PLAIN";
  return scalar;
}

/** decodeScalarText reads a scalar the way go-yaml's Decode into string does
 *  (decode.go's scalar arm): a !!binary node decodes to its data, every
 *  other scalar to its literal text. The `yaml` package stores parsed JS
 *  values, so the literal text is reconstructed; a text carrying `${{` can
 *  only arrive as a string (or binary) scalar, where the value is exact. */
function decodeScalarText(node: Scalar): string {
  if (node.value === null || node.value === undefined) return "";
  if (typeof node.value === "string") return node.value;
  if (typeof node.value === "boolean") return node.value ? "true" : "false";
  if (typeof node.value === "number") {
    // a number's literal text never carries `${{`; the shortest form suffices
    return String(node.value);
  }
  if (node.value instanceof Uint8Array) return new TextDecoder().decode(node.value);
  // the yaml package decodes !!binary into a {type:"Buffer",data:[...]} record
  if (typeof node.value === "object" && Array.isArray((node.value as { data?: unknown }).data)) {
    return new TextDecoder().decode(Uint8Array.from((node.value as { data: number[] }).data));
  }
  return "";
}

/** keyScalarText reads a mapping key the way Go's k.Decode(&sk) does — a
 *  scalar's literal text; a collection key is not a string (nil there). */
function keyScalarText(node: YamlNode): string | null {
  return isScalar(node) ? decodeScalarText(node) : null;
}

/** insertDirective (evaluator.go:187) — GitHub's undocumented map merge. */
const INSERT_DIRECTIVE = /\${{\s*insert\s*}}/;

/** The mapping walk's error text (evaluator.go:220). */
const INSERT_NON_MAPPING = (valueKind: string) =>
  `failed to insert node ${valueKind} into mapping unexpected type ${valueKind} expected MappingNode`;

/** kindName names a node's kind for the insert-directive error text. */
function kindName(node: YamlNode): string {
  if (isMap(node)) return "MappingNode";
  if (isSeq(node)) return "SequenceNode";
  if (isScalar(node)) return "ScalarNode";
  return "AliasNode";
}

/**
 * evaluateYamlNodeWalk is evaluateYamlNode's recursive body
 * (evaluator.go:125-136): a scalar, mapping or sequence evaluates; an alias
 * (callers expand aliases before Parse) or anything else answers no
 * replacement.
 */
export function evaluateYamlNodeWalk(evaluator: Evaluator, node: YamlNode): YamlNodeEval {
  if (isScalar(node)) return evaluateScalarYamlNode(evaluator, node);
  if (isMap(node)) return { replacement: evaluateMappingYamlNode(evaluator, node), error: null };
  if (isSeq(node)) return { replacement: evaluateSequenceYamlNode(evaluator, node), error: null };
  return { replacement: null, error: null }; // an unevaluated node is reported as no replacement
}

/** evaluateScalarYamlNode (evaluator.go:138-155): a scalar whose text holds
 *  `${{` evaluates and re-encodes; anything else keeps its node. */
function evaluateScalarYamlNode(evaluator: Evaluator, node: Scalar): YamlNodeEval {
  const inText = decodeScalarText(node);
  if (!inText.includes("${{")) {
    return { replacement: null, error: null };
  }
  const res = evaluator.evaluateScalar(inText);
  if (res.error !== null) {
    return { replacement: null, error: res.error };
  }
  return { replacement: encodeValue(res.value), error: null };
}

/** evaluateMappingYamlNode (evaluator.go:189-244): values evaluate in place,
 *  keys after them, and an `${{ insert }}` key splices its evaluated mapping
 *  into the parent. Untouched pairs keep their identity (and comments). */
function evaluateMappingYamlNode(evaluator: Evaluator, node: YAMLMap): YAMLMap | null {
  let ret: YAMLMap | null = null;
  for (let i = 0; i < node.items.length; i++) {
    const pair = node.items[i]!;
    const k = pair.key as YamlNode;
    const v = (pair.value ?? new Scalar(null)) as YamlNode;
    const evaluatedValue = evaluateYamlNodeWalk(evaluator, v);
    if (evaluatedValue.error !== null) {
      throw evaluatedValue.error;
    }
    let ev = evaluatedValue.replacement;
    if (ev === null) {
      ev = v;
    } else if (ret === null) {
      ret = new YamlMapCtor();
      // the entries before the first change are the originals
      ret.items = node.items.slice(0, i);
    }
    const sk = keyScalarText(k);
    // Merge the nested map of the insert directive
    if (sk !== null && INSERT_DIRECTIVE.test(sk)) {
      if (!isMap(ev)) {
        throw new Error(INSERT_NON_MAPPING(kindName(ev)));
      }
      if (ret === null) {
        ret = new YamlMapCtor();
        ret.items = node.items.slice(0, i);
      }
      ret.items.push(...ev.items);
    } else {
      const evaluatedKey = evaluateYamlNodeWalk(evaluator, k);
      if (evaluatedKey.error !== null) {
        throw evaluatedKey.error;
      }
      let ek = evaluatedKey.replacement;
      if (ek !== null && ret === null) {
        ret = new YamlMapCtor();
        ret.items = node.items.slice(0, i);
      }
      if (ek === null) {
        ek = k;
      }
      if (ret !== null) {
        ret.items.push(new Pair(ek, ev));
      }
    }
  }
  return ret;
}

/** evaluateSequenceYamlNode (evaluator.go:246-272): items evaluate in place;
 *  an evaluation that PRODUCED a sequence splices into the parent (GitHub's
 *  undocumented sequence merge), a sequence that was written as one stays
 *  nested. */
function evaluateSequenceYamlNode(evaluator: Evaluator, node: YAMLSeq): YAMLSeq | null {
  let ret: YAMLSeq | null = null;
  for (let i = 0; i < node.items.length; i++) {
    const v = (node.items[i] ?? new Scalar(null)) as YamlNode;
    const wasseq = isSeq(v);
    const evaluated = evaluateYamlNodeWalk(evaluator, v);
    if (evaluated.error !== null) {
      throw evaluated.error;
    }
    const ev = evaluated.replacement;
    if (ev !== null) {
      if (ret === null) {
        ret = new YamlSeqCtor();
        // the items before the first change are the originals
        ret.items = node.items.slice(0, i);
      }
      // GitHub has this undocumented feature to merge a sequence an evaluation produced
      if (isSeq(ev) && !wasseq) {
        ret.items.push(...ev.items);
      } else {
        ret.items.push(ev);
      }
    } else if (ret !== null) {
      ret.items.push(v);
    }
  }
  return ret;
}

/**
 * EvaluateYamlNode evaluates the expressions of a YAML value (evaluator.go:
 * 111-121) and answers the replacement for the caller to graft — a pair
 * slot, an item slot, or a model field. The walk's errors throw inside the
 * collection arms and surface here as the (null-replacement, error) pair.
 */
export function evaluateYamlNode(evaluator: Evaluator, node: YamlNode): YamlNodeEval {
  try {
    return evaluateYamlNodeWalk(evaluator, node);
  } catch (thrown) {
    return { replacement: null, error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }
}
