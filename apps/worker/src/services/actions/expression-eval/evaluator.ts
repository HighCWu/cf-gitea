// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/expreval/evaluator.go — the string-level
// evaluator that finds `${{ }}` expressions in a value and evaluates them
// against one interpeter (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the
// submodule's pin; SPEC-0012 §D5 tier E).
//
// Not ported here, with the stage that owns each arm:
//   - EvaluateYAMLNode (evaluator.go:96-260) walks go-yaml nodes; the YAML
//     model is the model port's seam (upstream caller: jobparser), so this
//     arm lands with that tier — the string-level EvaluateScalar and
//     Interpolate it is written against are delivered here.
//   - ResolveWorkflowCallInputs / EvaluateWorkflowCallOutputs /
//     EvaluateCallerSecrets ride expreval/workflow_call.go — v2-staged
//     (§D2 #12), dropped per §D4.
//
// The subexpression split, Match, Literal, ReadsContext and CallsFunction
// live in the syntax layer (expression-syntax/subexpr.ts, upstream
// subexpr.go) — this module consumes them.

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
