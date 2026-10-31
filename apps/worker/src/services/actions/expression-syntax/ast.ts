// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/ast.go (the hash-pinned
// external evaluator library, gitea/go.mod:11
// `gitea.dev/actionslib v1.5.0 h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00`).
// The grammar, operator precedence and parser limits implemented here follow
// GitHub's own expression parsers, github.com/actions/languageservices
// (MIT, Copyright GitHub) and github.com/actions/runner (MIT, Copyright (c)
// 2019 GitHub).
//
// SPEC-0012 §D5 tier S: the syntax layer only — lexer + parser + AST. There is
// deliberately NO interpreter here (that is tier E).

import { utf16Len } from "./utf16";

/** ExprError describes a lexer or parser error (ast.go:17-30). Go's ExprError
 * carries Message + Error(); the Error base gives the port's callers the
 * standard `.message` surface. */
export interface ExprError extends Error {
  offset: number;
  line: number;
  column: number;
}

export function newExprError(message: string): ExprError {
  return Object.assign(new Error(message), { line: 1, column: 1, offset: 0 });
}

// ast.go:32-42 — Go's strings.ToValidUTF8 echo exists because Go errors cross
// a JSON boundary as byte strings; a JS string is already valid UTF-16, so the
// sanitizer has no work to do here.

/**
 * newLocatedExprError words an error as the runner's ParseException does, the
 * position counted in UTF-16 units from one (ast.go:34-42). Token offsets in
 * this port are UTF-16 unit offsets (Go: byte offsets) — the unit is what a
 * JS string indexes natively, and columns/lines are unit-counted in Go too
 * (one rune = one unit for well-formed input).
 */
export function newLocatedExprError(description: string, source: string, token: { value: string; offset: number; line: number; column: number }): ExprError {
  return Object.assign(
    new Error(
      `${description}: '${token.value}'. Located at position ${utf16Len(source.slice(0, token.offset)) + 1} within expression: ${source}`,
    ),
    { offset: token.offset, line: token.line, column: token.column },
  );
}

/** ExprNode is a node in an expression syntax tree (ast.go:45-47). */
export type ExprNode =
  | VariableNode
  | NullNode
  | BoolNode
  | NumberNode
  | StringNode
  | ObjectDerefNode
  | ArrayDerefNode
  | IndexAccessNode
  | NotOpNode
  | CompareOpNode
  | LogicalOpNode
  | FuncCallNode;

/** VariableNode is a variable access (ast.go:50-54). */
export interface VariableNode {
  kind: "variable";
  name: string;
}

/** NullNode is a null literal (ast.go:57-59). */
export interface NullNode {
  kind: "null";
}

/** BoolNode is a boolean literal (ast.go:62-66). */
export interface BoolNode {
  kind: "bool";
  value: boolean;
}

/**
 * NumberNode is a numeric literal (ast.go:69-74). GitHub canonicalizes every
 * number to a double, so a large integer literal loses precision here exactly
 * as it does there.
 */
export interface NumberNode {
  kind: "number";
  value: number;
}

/** StringNode is a string literal with its quotes and escapes resolved (ast.go:77-81). */
export interface StringNode {
  kind: "string";
  value: string;
}

/** ObjectDerefNode is a property dereference (ast.go:84-89). */
export interface ObjectDerefNode {
  kind: "objectDeref";
  receiver: ExprNode;
  property: string;
}

/** ArrayDerefNode is an object or array filter (ast.go:92-96). */
export interface ArrayDerefNode {
  kind: "arrayDeref";
  receiver: ExprNode;
}

/** IndexAccessNode is an object property or array index access (ast.go:99-104). */
export interface IndexAccessNode {
  kind: "indexAccess";
  operand: ExprNode;
  index: ExprNode;
}

/** NotOpNode is a unary logical-not expression (ast.go:107-111). */
export interface NotOpNode {
  kind: "notOp";
  operand: ExprNode;
}

/** CompareOpNodeKind identifies a comparison operator (ast.go:114-124). */
export enum CompareOpNodeKind {
  Invalid = 0,
  Less = 1,
  LessEq = 2,
  Greater = 3,
  GreaterEq = 4,
  Eq = 5,
  NotEq = 6,
}

/** CompareOpNode is a binary comparison expression (ast.go:127-133). */
export interface CompareOpNode {
  kind: "compareOp";
  op: CompareOpNodeKind;
  left: ExprNode;
  right: ExprNode;
}

/** LogicalOpNodeKind identifies a logical operator (ast.go:136-142). */
export enum LogicalOpNodeKind {
  Invalid = 0,
  And = 1,
  Or = 2,
}

/** LogicalOpNode is a binary logical expression (ast.go:145-151). */
export interface LogicalOpNode {
  kind: "logicalOp";
  op: LogicalOpNodeKind;
  left: ExprNode;
  right: ExprNode;
}

/** FuncCallNode is a function call (ast.go:154-159). */
export interface FuncCallNode {
  kind: "funcCall";
  callee: string;
  args: ExprNode[];
}

/**
 * FindExprNode reports whether match accepts a node in the expression tree
 * (ast.go:162-187).
 */
export function FindExprNode(node: ExprNode, match: (node: ExprNode) => boolean): boolean {
  if (match(node)) {
    return true;
  }
  switch (node.kind) {
    case "objectDeref":
      return FindExprNode(node.receiver, match);
    case "arrayDeref":
      return FindExprNode(node.receiver, match);
    case "indexAccess":
      return FindExprNode(node.index, match) || FindExprNode(node.operand, match);
    case "notOp":
      return FindExprNode(node.operand, match);
    case "compareOp":
      return FindExprNode(node.left, match) || FindExprNode(node.right, match);
    case "logicalOp":
      return FindExprNode(node.left, match) || FindExprNode(node.right, match);
    case "funcCall":
      for (const argument of node.args) {
        if (FindExprNode(argument, match)) {
          return true;
        }
      }
      return false;
    default:
      return false;
  }
}
