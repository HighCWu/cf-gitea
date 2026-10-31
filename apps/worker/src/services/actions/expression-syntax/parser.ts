// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/parser.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11). The grammar, operator
// precedence and parser limits implemented here follow GitHub's own
// expression parsers, github.com/actions/languageservices (MIT, Copyright
// GitHub) and github.com/actions/runner (MIT, Copyright (c) 2019 GitHub).

import {
  CompareOpNodeKind,
  LogicalOpNodeKind,
  newExprError,
  newLocatedExprError,
  type ExprError,
  type ExprNode,
  type BoolNode,
  type CompareOpNode,
  type FuncCallNode,
  type IndexAccessNode,
  type LogicalOpNode,
  type NotOpNode,
  type NullNode,
  type NumberNode,
  type ObjectDerefNode,
  type StringNode,
  type ArrayDerefNode,
} from "./ast";
import { numberLiteralValue, ExprLexer, TokenKind, type Token } from "./lexer";
import { utf16Len } from "./utf16";

/** ExprParser parses an expression token stream (parser.go:18-27). */
export class ExprParser {
  current: Token;
  previous: Token;
  lexer: ExprLexer | null;
  err: ExprError | null;
  /** reject unknown names and wrong arities while parsing, as the runner does */
  private readonly validate: boolean;
  /** "job" or "step", which decides what success() and failure() accept */
  private readonly context: string;
  private readonly isNamedValue: ((name: string) => boolean) | null;

  constructor(validating?: { context: string; isNamedValue: (name: string) => boolean }) {
    this.current = { kind: TokenKind.Unknown, value: "", offset: 0, line: 1, column: 1 };
    this.previous = this.current;
    this.lexer = null;
    this.err = null;
    this.validate = validating !== undefined;
    this.context = validating?.context ?? "";
    this.isNamedValue = validating?.isNamedValue ?? null;
  }

  setError(description: string, token: Token): void {
    if (this.err === null && this.lexer !== null) {
      this.err = newLocatedExprError(description, this.lexer.source, token);
    }
  }

  /** unexpected records the rejection and returns the error that answers for
   * it (Go reads parser.err after the call; the port returns it, typed). */
  unexpected(): ExprError {
    if (this.current.kind === TokenKind.End) {
      if (this.lexer === null || this.lexer.err === null) {
        // otherwise the token the lexer rejected is the error
        this.setError("Unexpected end of expression", this.previous);
      }
    } else {
      this.setError("Unexpected symbol", this.current);
    }
    return this.err ?? newExprError("Unexpected symbol");
  }

  next(): Token {
    const current = this.current;
    this.previous = current;
    this.current = this.lexer !== null ? this.lexer.next() : this.current;
    return current;
  }

  /** cur re-reads the current token through a method call: TS narrows
   * `this.current.kind` across the `next()` mutations, which the Go original's
   * pointer semantics never do — fresh reads keep the comparisons honest. */
  private cur(): Token {
    return this.current;
  }

  private parseIdentifier(): { node: ExprNode; allowed: boolean } | null {
    const identifier = this.next();
    switch (identifier.value) {
      case "null":
        return { node: { kind: "null" } satisfies NullNode, allowed: false };
      case "true":
        return { node: { kind: "bool", value: true } satisfies BoolNode, allowed: false };
      case "false":
        return { node: { kind: "bool", value: false } satisfies BoolNode, allowed: false };
      case "NaN":
        return { node: { kind: "number", value: Number.NaN } satisfies NumberNode, allowed: false };
      case "Infinity":
        return { node: { kind: "number", value: Number.POSITIVE_INFINITY } satisfies NumberNode, allowed: false };
    }
    if (this.current.kind !== TokenKind.LeftParen) {
      if (this.validate && this.isNamedValue !== null && !this.isNamedValue(identifier.value)) {
        this.setError("Unrecognized named-value", identifier);
        return null;
      }
      return { node: { kind: "variable", name: identifier.value }, allowed: true };
    }
    if (this.validate && !(stringsLower(identifier.value) in functionArity)) {
      this.setError("Unrecognized function", identifier);
      return null;
    }

    const open = this.next();
    const args: ExprNode[] = [];
    if (this.cur().kind === TokenKind.RightParen) {
      return this.finishCall(identifier, open, args);
    }
    for (;;) {
      const argument = this.parseBinary(1);
      if (argument === null) {
        return null;
      }
      args.push(argument);
      if (this.cur().kind === TokenKind.RightParen) {
        return this.finishCall(identifier, open, args);
      }
      if (this.cur().kind !== TokenKind.Comma) {
        this.unexpected();
        return null;
      }
      this.next();
    }
  }

  /** finishCall checks arity as the call closes, before reading beyond it,
   * and reports errors on the opening parenthesis (parser.go:133-154). */
  private finishCall(identifier: Token, open: Token, args: ExprNode[]): { node: ExprNode; allowed: boolean } | null {
    this.next();
    const callee = stringsLower(identifier.value);
    // GitHub's job-level schema widens both to `(0,MAX)`, documenting no
    // meaning for the arguments. The unknown-callee fallback is Go's zero
    // struct (the checks only run when validating, and validation rejects
    // unknown callees before this line).
    const arity = { ...(functionArity[callee] ?? { min: 0, max: 0 }) };
    if (this.context === "job" && (callee === "success" || callee === "failure")) {
      arity.max = MAX_ARITY;
    }
    if (this.validate) {
      if (args.length < arity.min) {
        this.setError("Too few parameters supplied", open);
      } else if (args.length > arity.max) {
        this.setError("Too many parameters supplied", open);
      } else if (callee === "case" && args.length % 2 === 0) {
        this.setError("Even number of parameters supplied, requires an odd number of parameters", open);
      }
    }
    if (this.err !== null) {
      return null;
    }
    return { node: { kind: "funcCall", callee: identifier.value, args } satisfies FuncCallNode, allowed: true };
  }

  private parseGroup(): { node: ExprNode; allowed: boolean } | null {
    this.next();
    const expression = this.parseBinary(1);
    if (expression === null) {
      return null;
    }
    if (this.cur().kind !== TokenKind.RightParen) {
      this.unexpected();
      return null;
    }
    this.next();
    return { node: expression, allowed: true };
  }

  private parsePrimary(): { node: ExprNode; allowed: boolean } | null {
    switch (this.current.kind) {
      case TokenKind.Ident:
        return this.parseIdentifier();
      case TokenKind.LeftParen:
        return this.parseGroup();
      case TokenKind.Number: {
        // validated by the lexer
        const value = numberLiteralValue(this.next().value);
        return { node: { kind: "number", value: value ?? Number.NaN } satisfies NumberNode, allowed: false };
      }
      case TokenKind.String: {
        const value = this.next().value;
        return {
          node: { kind: "string", value: value.slice(1, -1).replaceAll("''", "'") } satisfies StringNode,
          allowed: false,
        };
      }
      default:
        this.unexpected();
        return null;
    }
  }

  private parsePostfix(): ExprNode | null {
    const primary = this.parsePrimary();
    if (primary === null) {
      return null;
    }
    let expression = primary.node;
    if (!primary.allowed) {
      return expression;
    }
    for (;;) {
      switch (this.cur().kind) {
        case TokenKind.Dot: {
          this.next();
          if (this.cur().kind === TokenKind.Star) {
            this.next();
            expression = { kind: "arrayDeref", receiver: expression } satisfies ArrayDerefNode;
            continue;
          }
          if (this.cur().kind !== TokenKind.Ident) {
            this.unexpected();
            return null;
          }
          expression = { kind: "objectDeref", receiver: expression, property: this.next().value } satisfies ObjectDerefNode;
          break;
        }
        case TokenKind.LeftBracket: {
          this.next();
          if (this.cur().kind === TokenKind.Star) {
            this.next();
            if (this.cur().kind !== TokenKind.RightBracket) {
              this.unexpected();
              return null;
            }
            this.next();
            expression = { kind: "arrayDeref", receiver: expression } satisfies ArrayDerefNode;
            continue;
          }
          const index = this.parseBinary(1);
          if (index === null) {
            return null;
          }
          if (this.cur().kind !== TokenKind.RightBracket) {
            this.unexpected();
            return null;
          }
          this.next();
          expression = { kind: "indexAccess", operand: expression, index } satisfies IndexAccessNode;
          break;
        }
        default:
          return expression;
      }
    }
  }

  private parseUnary(): ExprNode | null {
    if (this.current.kind !== TokenKind.Not) {
      return this.parsePostfix();
    }
    this.next();
    const operand = this.parseUnary();
    if (operand === null) {
      return null;
    }
    return { kind: "notOp", operand } satisfies NotOpNode;
  }

  private parseBinary(minPrecedence: number): ExprNode | null {
    let expression = this.parseUnary();
    if (expression === null) {
      return null;
    }
    for (;;) {
      const operator = binaryOperators[this.current.kind];
      if (operator === undefined || operator.precedence < minPrecedence) {
        return expression;
      }
      this.next();
      const right = this.parseBinary(operator.precedence + 1);
      if (right === null) {
        return null;
      }
      if (operator.compare === CompareOpNodeKind.Invalid) {
        expression = { kind: "logicalOp", op: operator.logical, left: expression, right } satisfies LogicalOpNode;
      } else {
        expression = { kind: "compareOp", op: operator.compare, left: expression, right } satisfies CompareOpNode;
      }
    }
  }

  /** Err prefers the consumed token's parser error over lexer lookahead, so
   * `bogus @x` reports the unknown name (parser.go:289-294). */
  Err(): ExprError | null {
    if (this.err !== null || this.lexer === null) {
      return this.err;
    }
    return this.lexer.Err();
  }

  /** Parse parses one expression from the lexer (parser.go:332-362). The
   * result holds exactly one of node (no error) or error (no node). */
  Parse(lexer: ExprLexer): { node: ExprNode | null; error: ExprError | null } {
    this.lexer = lexer;
    this.err = null;
    // A UTF-16 unit never spans fewer bytes than one, so a short source
    // cannot exceed the limit. (For a JS string the unit count and the
    // utf16 count coincide; the structure mirrors parser.go:336.)
    if (lexer.source.length > maxGitHubExpressionLength && utf16Len(lexer.source) > maxGitHubExpressionLength) {
      this.err = newExprError(`Exceeded max expression length ${maxGitHubExpressionLength}`);
      return { node: null, error: this.err };
    }
    this.previous = { kind: TokenKind.Unknown, value: "", offset: 0, line: 1, column: 1 };
    this.current = lexer.next();
    const firstErr = this.Err();
    if (firstErr !== null) {
      return { node: null, error: firstErr };
    }
    if (this.current.kind === TokenKind.End) {
      return { node: { kind: "null" } satisfies NullNode, error: null };
    }

    const expression = this.parseBinary(1);
    const parseErr = this.Err();
    if (parseErr !== null) {
      return { node: null, error: parseErr };
    }
    if (expression === null) {
      // unreachable on Go's invariant (parseBinary nil ⇒ parser.err set ⇒ the
      // Err check above returned); typed here for the null-sound port
      return { node: null, error: this.err ?? newExprError("parser returned no expression without an error") };
    }
    if (this.cur().kind !== TokenKind.End) {
      return { node: null, error: this.unexpected() };
    }
    if (expressionDepth(expression) > maxGitHubExpressionDepth) {
      this.err = newExprError(`Exceeded max expression depth ${maxGitHubExpressionDepth}`);
      return { node: null, error: this.err };
    }
    return { node: expression, error: null };
  }
}

const MAX_ARITY = 255; // math.MaxUint8

export const maxGitHubExpressionDepth = 50;
export const maxGitHubExpressionLength = 21000;

/** NewExprParser creates an expression parser (parser.go:35-37). */
export function NewExprParser(): ExprParser {
  return new ExprParser();
}

/** NewValidatingParser creates a parser that rejects unknown named values,
 * functions and arities (parser.go:40-42). */
export function NewValidatingParser(context: string, isNamedValue: (name: string) => boolean): ExprParser {
  return new ExprParser({ context, isNamedValue });
}

/** functionArity is GitHub's own table, enforced while parsing as GitHub does (parser.go:45-59). */
const functionArity: Record<string, { min: number; max: number }> = {
  contains: { min: 2, max: 2 },
  startswith: { min: 2, max: 2 },
  endswith: { min: 2, max: 2 },
  format: { min: 1, max: MAX_ARITY },
  join: { min: 1, max: 2 },
  tojson: { min: 1, max: 1 },
  fromjson: { min: 1, max: 1 },
  hashfiles: { min: 1, max: MAX_ARITY },
  case: { min: 3, max: MAX_ARITY },
  always: { min: 0, max: 0 },
  success: { min: 0, max: 0 },
  cancelled: { min: 0, max: 0 },
  failure: { min: 0, max: 0 },
};

interface BinaryOperator {
  precedence: number;
  compare: CompareOpNodeKind;
  logical: LogicalOpNodeKind;
}

/** Loosest to tightest, every level left-associative, matching GitHub's operator table (parser.go:254-263). */
const binaryOperators: Record<number, BinaryOperator> = {
  [TokenKind.Or]: { precedence: 1, compare: CompareOpNodeKind.Invalid, logical: LogicalOpNodeKind.Or },
  [TokenKind.And]: { precedence: 2, compare: CompareOpNodeKind.Invalid, logical: LogicalOpNodeKind.And },
  [TokenKind.Eq]: { precedence: 3, compare: CompareOpNodeKind.Eq, logical: LogicalOpNodeKind.Invalid },
  [TokenKind.NotEq]: { precedence: 3, compare: CompareOpNodeKind.NotEq, logical: LogicalOpNodeKind.Invalid },
  [TokenKind.Less]: { precedence: 4, compare: CompareOpNodeKind.Less, logical: LogicalOpNodeKind.Invalid },
  [TokenKind.LessEq]: { precedence: 4, compare: CompareOpNodeKind.LessEq, logical: LogicalOpNodeKind.Invalid },
  [TokenKind.Greater]: { precedence: 4, compare: CompareOpNodeKind.Greater, logical: LogicalOpNodeKind.Invalid },
  [TokenKind.GreaterEq]: { precedence: 4, compare: CompareOpNodeKind.GreaterEq, logical: LogicalOpNodeKind.Invalid },
};

function expressionDepth(node: ExprNode): number {
  switch (node.kind) {
    case "objectDeref":
      return 1 + expressionDepth(node.receiver);
    case "arrayDeref":
      return 1 + expressionDepth(node.receiver);
    case "indexAccess":
      return 1 + Math.max(expressionDepth(node.operand), expressionDepth(node.index));
    case "notOp":
      return 1 + expressionDepth(node.operand);
    case "compareOp":
      return 1 + Math.max(expressionDepth(node.left), expressionDepth(node.right));
    case "logicalOp":
      return 1 + Math.max(logicalOperandDepth(node.op, node.left), logicalOperandDepth(node.op, node.right));
    case "funcCall": {
      let depth = 1;
      for (const argument of node.args) {
        depth = Math.max(depth, 1 + expressionDepth(argument));
      }
      return depth;
    }
    default:
      return 1;
  }
}

function logicalOperandDepth(kind: LogicalOpNodeKind, node: ExprNode): number {
  if (node.kind === "logicalOp" && node.op === kind) {
    return Math.max(logicalOperandDepth(kind, node.left), logicalOperandDepth(kind, node.right));
  }
  return expressionDepth(node);
}

/** strings.ToLower over ASCII identifiers (function names are ASCII). */
function stringsLower(value: string): string {
  return value.toLowerCase();
}
