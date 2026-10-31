// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Unit tests for expression.go's Validate/Scan surface. actionslib ships NO
// fixture file for expression.go (the package's tests are lexer_test.go,
// ordinal_test.go and parser_test.go — ported verbatim in their own files);
// these cases derive from the implementation arms themselves, each cited.

import { describe, expect, it } from "vitest";

import { ScanExpression, ValidateCondition, ValidateExpression, ValidateTemplate } from "./expression";

describe("ValidateExpression (expression.go:17-22)", () => {
  it("accepts every named value and known function", () => {
    // the full context registry (expression.go:14) — env/secrets/steps ARE
    // valid here; the server-pinned RESTRICTION is static-validation's scan
    expect(ValidateExpression("github.event_name == 'push'", "job")).toBeNull();
    expect(ValidateExpression("contains(needs.build.outputs.x, 'y')", "job")).toBeNull();
    expect(ValidateExpression("fromJSON('[]')", "step")).toBeNull();
    expect(ValidateExpression("success() && failure()", "job")).toBeNull();
    expect(ValidateExpression("env.X == 'y' && secrets.S", "job")).toBeNull();
  });

  it("rejects unknown named values (parser.go:99-102)", () => {
    expect(ValidateExpression("foobar.X == 'y'", "job")?.message).toBe(
      "Unrecognized named-value: 'foobar'. Located at position 1 within expression: foobar.X == 'y'",
    );
  });

  it("rejects unknown functions (parser.go:105-108)", () => {
    expect(ValidateExpression("toUpper('x')", "job")?.message).toContain("Unrecognized function");
  });

  it("rejects wrong arities on the opening paren (parser.go:132-149)", () => {
    expect(ValidateExpression("contains('a')", "job")?.message).toBe(
      "Too few parameters supplied: '('. Located at position 9 within expression: contains('a')",
    );
    expect(ValidateExpression("always(1)", "job")?.message).toBe(
      "Too many parameters supplied: '('. Located at position 7 within expression: always(1)",
    );
    // the case function demands an odd argument count (parser.go:147-149);
    // two args hit the minimum first, four reach the even check
    expect(ValidateExpression("case('a', 'b')", "job")?.message).toBe(
      "Too few parameters supplied: '('. Located at position 5 within expression: case('a', 'b')",
    );
    expect(ValidateExpression("case('a', 'b', 'c', 'd')", "job")?.message).toBe(
      "Even number of parameters supplied, requires an odd number of parameters: '('. Located at position 5 within expression: case('a', 'b', 'c', 'd')",
    );
    expect(ValidateExpression("case('a', 'b', 'c')", "job")).toBeNull();
  });

  it("widens success/failure arity at the job level (parser.go:137-140)", () => {
    expect(ValidateExpression("success('anything')", "job")).toBeNull();
    expect(ValidateExpression("success('anything')", "step")?.message).toBe(
      "Too many parameters supplied: '('. Located at position 8 within expression: success('anything')",
    );
    expect(ValidateExpression("failure(1)", "job")).toBeNull();
  });
});

describe("ValidateTemplate (expression.go:25-42)", () => {
  it("validates every ${{ }} expression", () => {
    expect(ValidateTemplate("Hello ${{ 'World' }}", "job")).toBeNull();
    expect(ValidateTemplate("${{ github.x }} ${{ vars.y }}", "job")).toBeNull();
    expect(ValidateTemplate("bad ${{ foobar.X }}", "job")?.message).toContain("Unrecognized named-value: 'foobar'");
  });

  it("skips quoted-literal expressions (expression.go:35-39)", () => {
    expect(ValidateTemplate("${{ 'env.X' }}", "job")).toBeNull();
  });

  it("rejects an unclosed expression (expression.go:32-34)", () => {
    expect(ValidateTemplate("${{ github.x", "job")?.message).toBe("unclosed expression");
  });

  it("accepts plain text", () => {
    expect(ValidateTemplate("no expressions here", "job")).toBeNull();
  });
});

describe("ValidateCondition (expression.go:45-61)", () => {
  it("takes a bare expression as the condition", () => {
    expect(ValidateCondition("github.event_name == 'push'", "job")).toBeNull();
    expect(ValidateCondition("foobar.X", "job")?.message).toContain("Unrecognized named-value");
  });

  it("takes the empty condition", () => {
    expect(ValidateCondition("", "job")).toBeNull();
    expect(ValidateCondition("  ", "job")).toBeNull();
  });

  it("takes a lone blank quoted literal as no condition (expression.go:53-56)", () => {
    expect(ValidateCondition("${{ '' }}", "job")).toBeNull();
    expect(ValidateCondition("${{ '  ' }}", "job")).toBeNull();
  });

  it("validates a non-blank lone literal's TEXT as the condition (expression.go:56-58)", () => {
    // upstream validates the literal text itself, so an arbitrary quoted
    // string is NOT automatically fine — the text must parse as an
    // expression against the context
    expect(ValidateCondition("${{ 'fine' }}", "step")?.message).toContain("Unrecognized named-value: 'fine'");
  });

  it("templates a mixed condition", () => {
    expect(ValidateCondition("${{ success() }} and ${{ github.x }}", "job")).toBeNull();
    expect(ValidateCondition("${{ success() }} and ${{ foobar.x }}", "job")?.message).toContain(
      "Unrecognized named-value: 'foobar'",
    );
  });
});

describe("ScanExpression (expression.go:69-89)", () => {
  it.each([
    [" }}", 1, "", true], // a blank expression is a literal
    ["'a''b' }}", 7, "a'b", true], // a quoted literal, '' unescaped
    [" true }}", 6, "", false], // a real expression
    ["github.x }}", 9, "", false], // a real expression
    ["'a' && 'b' }}", 11, "", false], // a quoted literal plus more is not literal
  ] as Array<[string, number, string, boolean]>)("scans %j → end %d literal %j isLiteral %j", (input, end, literal, isLiteral) => {
    expect(ScanExpression(input)).toEqual({ end, literal, isLiteral });
  });

  it("reports unclosed input", () => {
    expect(ScanExpression("no braces here")).toEqual({ end: -1, literal: "", isLiteral: false });
    expect(ScanExpression("'a' && ")).toEqual({ end: -1, literal: "", isLiteral: false });
    // the }} inside a quoted stretch is not a terminator (expression.go:73-75)
    expect(ScanExpression("'unmatched }} more")).toEqual({ end: -1, literal: "", isLiteral: false });
  });
});
