// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Conformance port of actionslib v1.5.0 pkg/internal/syntax/parser_test.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11) — actionslib's OWN fixtures,
// including the runner limits and the fuzz seed invariants (the Go fuzz
// engine's seed corpus becomes a fixed invariant table; the generated
// mutations are the fuzzer's job, not the port's).

import { describe, expect, it } from "vitest";

import { CompareOpNodeKind, LogicalOpNodeKind, type ExprNode, type NumberNode } from "./ast";
import { ExprLexer } from "./lexer";
import { NewExprParser, maxGitHubExpressionDepth, maxGitHubExpressionLength } from "./parser";

function parseTestExpression(source: string): ExprNode {
  const { node, error } = NewExprParser().Parse(new ExprLexer(source));
  expect(error).toBeNull();
  return node!;
}

describe("ExprParser literals (parser_test.go:29-64)", () => {
  it("parses the empty expression to a null node", () => {
    expect(parseTestExpression("").kind).toBe("null");
  });

  it("unescapes doubled quotes", () => {
    const node = parseTestExpression("'a''b''c'");
    expect(node).toEqual({ kind: "string", value: "a'b'c" });
  });

  it.each([
    ["42", 42],
    ["-12", -12],
    ["+12", 12],
    ["01", 1],
    ["0xff", 255],
    ["0xffffffff", -1],
    ["0o17", 15],
    ["0o37777777777", -1],
    ["1.25", 1.25],
    [".5", 0.5],
    ["1.", 1],
    ["2e3", 2000],
    ["-2.99e-2", -2.99e-2],
    ["6E+4", 60000],
    ["1e02", 100],
    ["9007199254740993", 9007199254740992],
  ] as Array<[string, number]>)("reads %s as %d", (source, value) => {
    const node = parseTestExpression(source) as NumberNode;
    expect(node.kind).toBe("number");
    expect(node.value).toBe(value);
  });

  it("keeps the special float names", () => {
    expect(Number.isNaN((parseTestExpression("NaN") as NumberNode).value)).toBe(true);
    expect((parseTestExpression("Infinity") as NumberNode).value).toBe(Number.POSITIVE_INFINITY);
    expect((parseTestExpression("+Infinity") as NumberNode).value).toBe(Number.POSITIVE_INFINITY);
    expect((parseTestExpression("-Infinity") as NumberNode).value).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("ExprParser postfix chain (parser_test.go:66-94)", () => {
  it("builds steps['Build'].outputs[0].Name.*.value", () => {
    const root = parseTestExpression("steps['Build'].outputs[0].Name.*.value");
    expect(root).toMatchObject({ kind: "objectDeref", property: "value" });
    if (root.kind !== "objectDeref") return;

    const filter = root.receiver;
    expect(filter).toMatchObject({ kind: "arrayDeref" });
    if (filter.kind !== "arrayDeref") return;

    const name = filter.receiver;
    // the tree keeps the spelling, lookups ignore case
    expect(name).toMatchObject({ kind: "objectDeref", property: "Name" });
    if (name.kind !== "objectDeref") return;

    const zero = name.receiver;
    expect(zero).toMatchObject({ kind: "indexAccess" });
    if (zero.kind !== "indexAccess") return;
    expect(zero.index).toEqual({ kind: "number", value: 0 });

    const outputs = zero.operand;
    expect(outputs).toMatchObject({ kind: "objectDeref", property: "outputs" });
    if (outputs.kind !== "objectDeref") return;

    const build = outputs.receiver;
    expect(build).toMatchObject({ kind: "indexAccess" });
    if (build.kind !== "indexAccess") return;
    expect(build.index).toEqual({ kind: "string", value: "Build" });
    expect(build.operand).toEqual({ kind: "variable", name: "steps" });
  });

  it("builds github.event.labels[*].name", () => {
    const property = parseTestExpression("github.event.labels[*].name");
    expect(property).toMatchObject({ kind: "objectDeref", property: "name" });
    if (property.kind !== "objectDeref") return;
    const filter = property.receiver;
    expect(filter).toMatchObject({ kind: "arrayDeref" });
    if (filter.kind !== "arrayDeref") return;
    expect(filter.receiver).toMatchObject({ kind: "objectDeref", property: "labels" });
  });

  it("builds foo[*] over a bare variable", () => {
    const filter = parseTestExpression("foo[*]");
    expect(filter).toMatchObject({ kind: "arrayDeref" });
    if (filter.kind !== "arrayDeref") return;
    expect(filter.receiver).toEqual({ kind: "variable", name: "foo" });
  });
});

describe("ExprParser functions (parser_test.go:96-107)", () => {
  it("parses an empty status call", () => {
    const empty = parseTestExpression("success()");
    expect(empty).toEqual({ kind: "funcCall", callee: "success", args: [] });
  });

  it("nests calls", () => {
    const outer = parseTestExpression("format('x', contains(env.key, 'y'))");
    expect(outer).toMatchObject({ kind: "funcCall", callee: "format" });
    if (outer.kind !== "funcCall") return;
    expect(outer.args).toHaveLength(2);
    expect(outer.args[0]).toEqual({ kind: "string", value: "x" });
    const inner = outer.args[1];
    expect(inner).toBeDefined();
    if (inner === undefined) return;
    expect(inner).toMatchObject({ kind: "funcCall", callee: "contains" });
    if (inner.kind !== "funcCall") return;
    expect(inner.args).toHaveLength(2);
  });
});

describe("ExprParser precedence (parser_test.go:109-126)", () => {
  it("binds ! tighter than == tighter than && tighter than ||", () => {
    const root = parseTestExpression("!a == b && c || d");
    expect(root).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.Or });
    if (root.kind !== "logicalOp") return;
    const and = root.left;
    expect(and).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.And });
    if (and.kind !== "logicalOp") return;
    const equality = and.left;
    expect(equality).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Eq });
    if (equality.kind !== "compareOp") return;
    expect(equality.left).toMatchObject({ kind: "notOp" });
    if (equality.left.kind !== "notOp") return;
    expect(equality.left.operand).toEqual({ kind: "variable", name: "a" });
  });

  it("keeps < and > on one level, == above them", () => {
    const equality = parseTestExpression("a < b == c > d");
    expect(equality).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Eq });
    if (equality.kind !== "compareOp") return;
    expect(equality.left).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Less });
    expect(equality.right).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Greater });
  });

  it("groups override precedence", () => {
    const grouped = parseTestExpression("(a || b) && c");
    expect(grouped).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.And });
    if (grouped.kind !== "logicalOp") return;
    expect(grouped.left).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.Or });
  });
});

describe("ExprParser runner syntax (parser_test.go:128-138)", () => {
  it("dereferences a grouped literal", () => {
    const grouped = parseTestExpression("('x').length");
    expect(grouped).toMatchObject({ kind: "objectDeref", property: "length" });
  });

  it.each(["'x'[0]", "true.foo", "true()", "-0x1", "true}}", "true}}junk", "${{ true", "true }"])("rejects %j", (source) => {
    const { error } = NewExprParser().Parse(new ExprLexer(source));
    expect(error).not.toBeNull();
  });
});

describe("ExprParser runner limits (parser_test.go:140-154)", () => {
  it("accepts expressions at the depth and length limits", () => {
    expect(parseTestExpression("!".repeat(maxGitHubExpressionDepth - 1) + "true")).not.toBeNull();
    expect(parseTestExpression("true && ".repeat(maxGitHubExpressionDepth) + "true")).not.toBeNull();
    expect(parseTestExpression("a".repeat(maxGitHubExpressionLength))).not.toBeNull();
    expect(parseTestExpression("'" + "ø".repeat(maxGitHubExpressionLength - 2) + "'")).not.toBeNull();
  });

  it.each([
    ["a".repeat(maxGitHubExpressionLength + 1)],
    ["'" + "\u{1D11E}".repeat(maxGitHubExpressionLength / 2) + "'"],
    ["!".repeat(maxGitHubExpressionDepth) + "true"],
  ])("rejects the over-limit expression %j...", (source) => {
    const { error } = NewExprParser().Parse(new ExprLexer(source));
    expect(error).not.toBeNull();
  });
});

describe("ExprParser associativity (parser_test.go:156-172)", () => {
  it("left-associates the relational level", () => {
    const relational = parseTestExpression("1 < 2 < 3");
    expect(relational).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Less });
    if (relational.kind !== "compareOp") return;
    expect(relational.left).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Less });
    expect((relational.right as NumberNode).value).toBe(3);
  });

  it("left-associates the equality level", () => {
    const equality = parseTestExpression("2 == 1 == false");
    expect(equality).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Eq });
    if (equality.kind !== "compareOp") return;
    expect(equality.left).toMatchObject({ kind: "compareOp", op: CompareOpNodeKind.Eq });
  });

  it("left-associates the logical levels", () => {
    const and = parseTestExpression("a && b && c");
    expect(and).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.And });
    if (and.kind !== "logicalOp") return;
    expect(and.left).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.And });
    expect(and.right).toEqual({ kind: "variable", name: "c" });

    const or = parseTestExpression("a || b || c");
    expect(or).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.Or });
    if (or.kind !== "logicalOp") return;
    expect(or.left).toMatchObject({ kind: "logicalOp", op: LogicalOpNodeKind.Or });
    expect(or.right).toEqual({ kind: "variable", name: "c" });
  });
});

describe("ExprParser error position (parser_test.go:174-177)", () => {
  it("locates the rejected token within the expression", () => {
    const { error } = NewExprParser().Parse(new ExprLexer("\n  a b"));
    expect(error?.message).toBe("Unexpected symbol: 'b'. Located at position 6 within expression: \n  a b");
  });
});

describe("ExprParser fuzz-seed invariants (parser_test.go:179-198)", () => {
  // FuzzExprParser's seed corpus; the invariant (exactly one of node/error,
  // error bounds within the source) holds for every fixed seed.
  const seeds = [
    "",
    "true",
    "'a''b'",
    "github.event.pull_request.number",
    "!(a && b) || c[*].d",
    "format('{0}{1}', 0x1f, -Infinity)",
    "a[1]['b'].c.*",
    "'ø\u{1D11E}'",
    "((((1))))",
    "}}",
    "${{",
    "'a",
    "1 <",
    "\u00ff",
  ];

  it.each(seeds)("parse %j yields a node or a bounded error", (source) => {
    const { node, error } = NewExprParser().Parse(new ExprLexer(source));
    if (node === null) {
      expect(error).not.toBeNull();
    } else {
      expect(error).toBeNull();
    }
    if (error !== null) {
      expect(error.message).not.toBe("");
      expect(error.offset).toBeGreaterThanOrEqual(0);
      expect(error.offset).toBeLessThanOrEqual(source.length);
      expect(error.line).toBeGreaterThanOrEqual(1);
      expect(error.column).toBeGreaterThanOrEqual(1);
    }
  });
});
