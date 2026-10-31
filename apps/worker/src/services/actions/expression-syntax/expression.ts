// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/expression.go — the
// expression-level validation entry points (gitea.dev/actionslib v1.5.0,
// gitea/go.mod:11). Package syntax scans and parses workflow expressions
// without depending on the model or evaluator.

import { NewValidatingParser } from "./parser";
import { NewExprLexer } from "./lexer";
import type { ExprError } from "./ast";

/** NamedValues are the contexts an expression may read (expression.go:14). */
export const NamedValues = [
  "github",
  "gitea",
  "env",
  "job",
  "jobs",
  "steps",
  "runner",
  "secrets",
  "vars",
  "strategy",
  "matrix",
  "needs",
  "inputs",
];

/** ValidateExpression parses an expression with every context and function,
 * using the status function arity of a "job" or "step" (expression.go:17-22). */
export function ValidateExpression(expression: string, context: string): ExprError | Error | null {
  const { error } = NewValidatingParser(context, isNamedValue).Parse(NewExprLexer(expression));
  return error;
}

/** ValidateTemplate parses every `${{ }}` expression in value, like
 * ValidateExpression (expression.go:25-42). */
export function ValidateTemplate(value: string, context: string): ExprError | Error | null {
  for (;;) {
    const at = value.indexOf("${{");
    if (at < 0) {
      return null;
    }
    const rest = value.slice(at + "${{".length);
    const { end, isLiteral } = ScanExpression(rest);
    if (end < 0) {
      return new Error("unclosed expression");
    }
    if (!isLiteral) {
      const err = ValidateExpression(rest.slice(0, end).trim(), context);
      if (err !== null) {
        return err;
      }
    }
    value = rest.slice(end + "}}".length);
  }
}

/** ValidateCondition parses an `if:` value the way it is evaluated, where a
 * lone quoted literal is the condition itself (expression.go:45-61). */
export function ValidateCondition(value: string, context: string): ExprError | Error | null {
  if (!value.includes("${{")) {
    if (value.trim() === "") {
      return null;
    }
    return ValidateExpression(value, context);
  }
  if (value.startsWith("${{")) {
    const rest = value.slice("${{".length);
    const { end, literal, isLiteral } = ScanExpression(rest);
    if (end >= 0 && isLiteral && rest.slice(end + "}}".length) === "") {
      if (literal.trim() === "") {
        return null;
      }
      return ValidateExpression(literal, context);
    }
  }
  return ValidateTemplate(value, context);
}

function isNamedValue(name: string): boolean {
  return NamedValues.some((namedValue) => namedValue.toLowerCase() === name.toLowerCase());
}

/** ScanExpression returns the closing `}}` offset after `${{`, or -1 if
 * unclosed. isLiteral reports a blank expression or a single quoted string,
 * whose text is literal (expression.go:69-89). All decisions are ASCII, so
 * the unit walk is the byte walk's twin. */
export function ScanExpression(inString_: string): { end: number; literal: string; isLiteral: boolean } {
  let inQuote = false;
  for (let i = 0; i < inString_.length; i++) {
    const character = inString_.charCodeAt(i);
    if (character === 0x27 /* ' */) {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && inString_.startsWith("}}", i)) {
      const expression = inString_.slice(0, i).trim();
      if (expression === "") {
        return { end: i, literal: "", isLiteral: true };
      }
      const quoted = expression.startsWith("'");
      const literal0 = quoted ? expression.slice(1) : expression;
      const closed = literal0.endsWith("'");
      const literal1 = closed ? literal0.slice(0, -1) : literal0;
      if (quoted && closed && !literal1.replaceAll("''", "").includes("'")) {
        return { end: i, literal: literal1.replaceAll("''", "'"), isLiteral: true };
      }
      return { end: i, literal: "", isLiteral: false };
    }
  }
  return { end: -1, literal: "", isLiteral: false };
}
