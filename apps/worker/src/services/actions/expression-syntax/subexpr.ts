// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/expreval/subexpr.go — the AST-scan API the
// S tier's call sites ride (gitea.dev/actionslib v1.5.0, gitea/go.mod:11).
// Package expreval shares workflow expression splitting, interpolation and
// truthiness between Gitea and the runner; only the scan half is ported here
// (the evaluator is tier E). The Go original routes its node types through
// the exprparser re-export shim; in this port the AST types are the local
// ast.ts union directly.

import { FindExprNode, type ExprNode, type FuncCallNode, type VariableNode } from "./ast";
import { ScanExpression } from "./expression";
import { OrdinalIgnoreCaseEqual } from "./ordinal";
import { NewExprParser } from "./parser";
import { NewExprLexer } from "./lexer";

/** part holds literal text or expression source, with quoted text folded as
 * in GitHub's template reader (subexpr.go:17-22). */
export interface Part {
  text: string;
  literal: string;
  isExpr: boolean;
  isLiteral: boolean;
}

/** splitSubExpressions splits in the way GitHub's template reader does,
 * rejecting an unclosed expression as it does (subexpr.go:26-51). */
export function splitSubExpressions(input: string): { parts: Part[]; error: null } | { parts: null; error: Error } {
  if (!input.includes("${{")) {
    return { parts: [{ text: input, literal: "", isExpr: false, isLiteral: false }], error: null };
  }

  const parts: Part[] = [];
  let rest = input;
  for (;;) {
    const start = rest.indexOf("${{");
    if (start < 0) {
      if (rest !== "") {
        parts.push({ text: rest, literal: "", isExpr: false, isLiteral: false });
      }
      return { parts, error: null };
    }
    if (start > 0) {
      parts.push({ text: rest.slice(0, start), literal: "", isExpr: false, isLiteral: false });
    }
    const after = rest.slice(start + "${{".length);
    const scan = ScanExpression(after);
    if (scan.end < 0) {
      return { parts: null, error: new Error("unclosed expression") };
    }
    parts.push({
      text: after.slice(0, scan.end).trim(),
      literal: scan.literal,
      isExpr: true,
      isLiteral: scan.isLiteral,
    });
    rest = after.slice(scan.end + "}}".length);
  }
}

/** Match reports whether any `${{ }}` expression in value holds a node the
 * predicate accepts. A value that does not parse counts as a match, so the
 * caller defers the error to the evaluation, which reports it against the
 * real values (subexpr.go:56-62). */
export function Match(value: string, match: (node: ExprNode) => boolean): boolean {
  const split = splitSubExpressions(value);
  if (split.error !== null) {
    return true;
  }
  return partsMatch(split.parts, match);
}

/** Literal returns the text of a value that is plain text or a lone string
 * literal expression (subexpr.go:65-75). */
export function Literal(value: string): { text: string; ok: boolean } {
  const split = splitSubExpressions(value);
  if (split.error !== null || split.parts.length !== 1) {
    return { text: "", ok: false };
  }
  const first = split.parts[0]!;
  if (first.isLiteral) {
    return { text: first.literal, ok: true };
  }
  return { text: first.text, ok: !first.isExpr };
}

/** ReadsContext reports whether value reads the named context, without
 * exposing the AST (subexpr.go:78-83). */
export function ReadsContext(value: string, contextName: string): boolean {
  return Match(value, (node) => {
    const variable = node as VariableNode;
    return variable.kind === "variable" && OrdinalIgnoreCaseEqual(variable.name, contextName);
  });
}

/** partsMatch reports whether any expression part holds a node the predicate
 * accepts (subexpr.go:86-100). Exported for the conformance fixture, which
 * calls it directly (Go: same package). */
export function partsMatch(parts: Part[], match: (node: ExprNode) => boolean): boolean {
  for (const part of parts) {
    if (!part.isExpr) {
      continue;
    }
    const { node, error } = NewExprParser().Parse(NewExprLexer(part.text));
    if (error !== null) {
      return true;
    }
    if (FindExprNode(node!, match)) {
      return true;
    }
  }
  return false;
}

/** CallsFunction reports whether any `${{ }}` expression in value calls one
 * of the named functions (subexpr.go:103-110). */
export function CallsFunction(value: string, ...names: string[]): boolean {
  return Match(value, (node) => {
    const call = node as FuncCallNode;
    return call.kind === "funcCall" && names.some((name) => OrdinalIgnoreCaseEqual(name, call.callee));
  });
}
