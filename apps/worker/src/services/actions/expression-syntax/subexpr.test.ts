// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Conformance port of actionslib v1.5.0 pkg/expreval/subexpr_test.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11) — actionslib's OWN fixtures
// against the ported scan API. TestPartsCallStatusFunction rides
// exprparser.IsStatusFunctionCall (interpreter.go:184-189), a pure node
// predicate on the interpreter side of the split (tier E lands the caller);
// the predicate is replicated here exactly so the fixture runs whole.

import { describe, expect, it } from "vitest";

import type { ExprNode, FuncCallNode } from "./ast";
import { CallsFunction, Literal, ReadsContext, partsMatch, splitSubExpressions, type Part } from "./subexpr";

// interpreter.go:165-172,184-189 — the status-function name set.
function isStatusFunction(loweredCallee: string): boolean {
  return loweredCallee === "success" || loweredCallee === "always" || loweredCallee === "cancelled" || loweredCallee === "failure";
}

function isStatusFunctionCall(node: ExprNode): boolean {
  const call = node as FuncCallNode;
  return call.kind === "funcCall" && isStatusFunction(call.callee.toLowerCase());
}

const expr = (text: string): Part => ({ text, literal: "", isExpr: true, isLiteral: false });
const text = (literal: string): Part => ({ text: literal, literal: "", isExpr: false, isLiteral: false });
const quoted = (source: string, held: string): Part => ({ text: source, literal: held, isExpr: true, isLiteral: true });

describe("splitSubExpressions (subexpr_test.go:15-50)", () => {
  it.each([
    ["Hello World", [text("Hello World")]],
    ["${{ true }}", [expr("true")]],
    ["${{ true }} ${{ false }}", [expr("true"), text(" "), expr("false")]],
    ["Hello ${{ 'World' }}", [text("Hello "), quoted("'World'", "World")]],
    ["${{ }}", [quoted("", "")]],
    ["${{ 'a' 'b' }}", [expr("'a' 'b'")]],
    ["${{ '}}' }}", [quoted("'}}'", "}}")]],
    ["${{ 'a${{b' }}", [quoted("'a${{b'", "a${{b")]],
    ["${{ '''}}''' }}", [quoted("'''}}'''", "'}}'")]],
    ["${{ '''' }}", [quoted("''''", "'")]],
    // subexpr_test.go:36-38 — the double quotes are INSIDE the single-quoted
    // expression string, so they hide nothing from the quote scan; the
    // backslashes in the second row are Go raw-string literals kept verbatim
    ["${{ fromJSON('\"}}\"') }}", [expr("fromJSON('\"}}\"')")]],
    ["${{ fromJSON('\"\\}}\\\"') }}", [expr("fromJSON('\"\\}}\\\"')")]],
    ["${{ fromJSON('\"''}}\"') }}", [expr("fromJSON('\"''}}\"')")]],
    ["${{ 1) && (2 }}", [expr("1) && (2")]],
  ] as Array<[string, Part[]]>)("splits %j", (input, want) => {
    const { parts, error } = splitSubExpressions(input);
    expect(error).toBeNull();
    expect(parts).toEqual(want);
  });

  it.each(["${{ 1", "${{ 'a' }} ${{ b", "${{ 'a }}"])("rejects unclosed %j", (input) => {
    const { error } = splitSubExpressions(input);
    expect(error?.message).toContain("unclosed expression");
  });
});

describe("partsMatch against status functions (subexpr_test.go:52-65)", () => {
  it.each([
    ["${{ !cancelled() && github.event_name == 'push' }}", true],
    ["${{ github.event_name == 'push' }}", false],
    ["${{ always() }} and ${{ 'more' }}", true],
  ])("scans %j → %j", (input, want) => {
    const { parts, error } = splitSubExpressions(input);
    expect(error).toBeNull();
    expect(parts).not.toBeNull();
    if (parts === null) return;
    expect(partsMatch(parts, isStatusFunctionCall)).toBe(want);
  });
});

describe("CallsFunction (subexpr_test.go:67-82)", () => {
  it.each([
    ["${{ always() }}", ["always", "failure", "cancelled"], true],
    ["${{ ALWAYS() }}", ["always"], true],
    ["${{ success() }}", ["always", "failure", "cancelled"], false],
    ["always()", ["always"], false],
    ["${{ 1) && (2 }}", ["always"], true],
    ["${{ 'a }}", ["always"], true],
  ] as Array<[string, string[], boolean]>)("scans %j for %j → %j", (input, names, want) => {
    expect(CallsFunction(input, ...names)).toBe(want);
  });
});

describe("Literal (subexpr_test.go:84-94)", () => {
  it.each([
    ["plain", "plain"],
    ["${{ 'it''s' }}", "it's"],
    ["${{ '' }}", ""],
  ])("extracts %j → %j", (input, want) => {
    const { text: got, ok } = Literal(input);
    expect(ok).toBe(true);
    expect(got).toBe(want);
  });

  it.each(["${{ matrix.os }}", "a ${{ 'b' }}", "${{ 'a }}"])("refuses %j", (input) => {
    const { ok } = Literal(input);
    expect(ok).toBe(false);
  });
});

describe("ReadsContext (subexpr_test.go:96-102)", () => {
  it("finds the named context", () => {
    expect(ReadsContext("${{ needs.build.result }}", "needs")).toBe(true);
  });

  it("matches context names case-insensitively", () => {
    expect(ReadsContext("${{ NEEDS.build.result }}", "needs")).toBe(true);
  });

  it("finds the context inside surrounding text", () => {
    expect(ReadsContext("prefix ${{ matrix.os }} suffix", "matrix")).toBe(true);
  });

  it("misses other contexts", () => {
    expect(ReadsContext("${{ matrix.os }}", "needs")).toBe(false);
    expect(ReadsContext("no expression here", "needs")).toBe(false);
  });
});
