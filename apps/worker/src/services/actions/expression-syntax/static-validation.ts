// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of the S-tier half of gitea/modules/actions/jobparser/validate.go at
// the pin fc493688 — SPEC-0012 §D2 #9, the detection-time static-validation
// scan (tier S: AST scan only, no evaluation).
//
// Upstream splits the workflow check into a YAML-model half (resolveYamlAliases
// / readWorkflowDoc / ParseRawOn / validateWorkflowStructure / validateJobKinds
// — validate.go:22-46, the model port is the M3 YAML-model row, owned by the
// trigger sibling) and the expression-scan half ported here:
//
//   - unavailableContext    validate.go:66-74  — the expreval.Match named-value
//     scan over the pinned allowed list
//   - validateJobConditions validate.go:54-62  — every job's `if:` against the
//     server-pinned jobConditionContexts (validate.go:19-20: "which github.com
//     decides before the matrix, so without the matrix and strategy contexts")
//   - the run-name arm      validate.go:47-51  — run-name against
//     github/gitea/inputs/vars
//
// The caller extracts the strings from the parsed workflow YAML and passes
// them here; the error strings are upstream's verbatim.

import { type ExprNode, type VariableNode } from "./ast";
import { OrdinalIgnoreCaseEqual } from "./ordinal";
import { Match } from "./subexpr";

/** jobConditionContexts are what github.com gives `jobs.<job_id>.if`, which it
 * decides before the matrix, plus the `gitea` alias (validate.go:19-20). */
export const jobConditionContexts = ["github", "gitea", "needs", "vars", "inputs"] as const;

/** The run-name scan's allowed list (validate.go:48). */
export const runNameContexts = ["github", "gitea", "inputs", "vars"] as const;

/** unavailableContext returns the first variable name the expression reads
 * outside the allowed list, "" when none (validate.go:66-74). A value that
 * does not parse matches (Match defers the error to evaluation), exactly as
 * upstream defers it. */
export function unavailableContext(expression: string, allowed: readonly string[]): string {
  let unavailable = "";
  Match(expression, (node: ExprNode) => {
    const variable = node as VariableNode;
    if (
      variable.kind === "variable" &&
      !allowed.some((name) => OrdinalIgnoreCaseEqual(name, variable.name))
    ) {
      unavailable = variable.name;
    }
    return unavailable !== "";
  });
  return unavailable;
}

/** The static-validation scan surface: the expressions upstream's
 * ValidateWorkflowStatic checks, extracted from the workflow content by the
 * YAML-model half (the caller's side of the seam). Job iteration follows the
 * object's insertion order; Go's map order is random, so WHICH job's error
 * surfaces first differs run-to-run upstream — the error text is the stable
 * parity surface. */
export interface StaticExpressions {
  /** The workflow's `run-name:` value, "" when absent. */
  runName?: string;
  /** job id → the job's `if:` value (upstream IfExpression(job.If.Value)). */
  jobIfs?: Record<string, string>;
}

/** validateStaticExpressions applies upstream's two context scans in upstream
 * order (job conditions first — they run inside readWorkflowDoc,
 * aliases.go:34 — then the run-name arm, validate.go:47-51). Returns the
 * upstream error text, or null when the scan passes. */
export function validateStaticExpressions(expressions: StaticExpressions): string | null {
  for (const [id, ifExpression] of Object.entries(expressions.jobIfs ?? {})) {
    const unavailable = unavailableContext(ifExpression, jobConditionContexts);
    if (unavailable !== "") {
      return `job ${id}: Unrecognized named-value: '${unavailable}'`;
    }
  }
  const unavailable = unavailableContext(expressions.runName ?? "", runNameContexts);
  if (unavailable !== "") {
    return `run-name: Unrecognized named-value: '${unavailable}'`;
  }
  return null;
}
