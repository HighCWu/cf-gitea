// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Conformance port of actionslib v1.5.0 pkg/internal/syntax/lexer_test.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11) — actionslib's OWN fixtures
// run against the ported lexer. Offsets are UTF-16 units here (Go: bytes);
// the fixtures' ASCII prefixes carry identical numbers, the non-ASCII tail
// tokens carry the unit-adjusted offsets noted inline.

import { describe, expect, it } from "vitest";

import { ExprLexer, TokenKind } from "./lexer";

describe("ExprLexer tokens and positions (lexer_test.go:14-31)", () => {
  it("walks the mixed-source fixture token by token", () => {
    const lexer = new ExprLexer("\n\t'It''s' 0xff\n-2.99e-2 'ø'\n\u00a0 github");
    // Go's byte offsets: 2, 10, 15, 24, 32, end 38. The 'ø' and NBSP runes
    // are single UTF-16 units, so the tail offsets shrink by the byte excess:
    // github 32→30, end 38→36. Lines and columns are rune-counted in Go and
    // unit-per-code-point-counted here — identical.
    const expected: Array<[TokenKind, string, number, number, number]> = [
      [TokenKind.String, "'It''s'", 2, 2, 2],
      [TokenKind.Number, "0xff", 10, 2, 10],
      [TokenKind.Number, "-2.99e-2", 15, 3, 1],
      [TokenKind.String, "'ø'", 24, 3, 10],
      [TokenKind.Ident, "github", 30, 4, 3],
      [TokenKind.End, "", 36, 4, 9],
    ];
    for (const [kind, value, offset, line, column] of expected) {
      const got = lexer.Next();
      expect(lexer.Err()).toBeNull();
      expect(got).toEqual({ kind, value, offset, line, column });
    }
  });
});

describe("ExprLexer number kinds (lexer_test.go:33-66)", () => {
  it.each([
    [TokenKind.Number, "0"],
    [TokenKind.Number, "+1"],
    [TokenKind.Number, "01"],
    [TokenKind.Number, "0x00"],
    [TokenKind.Number, "0x0f"],
    [TokenKind.Number, "0xffffffff"],
    [TokenKind.Number, "0o10"],
    [TokenKind.Number, ".5"],
    [TokenKind.Number, "-.5"],
    [TokenKind.Number, "1."],
    [TokenKind.Number, "1.25"],
    [TokenKind.Number, "2e3"],
    [TokenKind.Number, "1e+2"],
    [TokenKind.Number, "1e01"],
    [TokenKind.Number, "+Infinity"],
    [TokenKind.Number, "-Infinity"],
    [TokenKind.Number, "+infinity"],
    [TokenKind.Number, "-INFINITY"],
    [TokenKind.Ident, "infinity"],
    [TokenKind.Ident, "INFINITY"],
  ] as Array<[TokenKind, string]>)("lexes %j as kind %s", (kind, value) => {
    const lexer = new ExprLexer(value);
    const token = lexer.Next();
    expect(lexer.Err()).toBeNull();
    expect(token.kind).toBe(kind);
    expect(token.value).toBe(value);
    expect(lexer.Next().kind).toBe(TokenKind.End);
  });
});

describe("ExprLexer rejects invalid numbers (lexer_test.go:68-75)", () => {
  it.each(["-0x1", "0b10", "0X10", "0o8", "1.2.3", "-Inf"])("rejects %j", (source) => {
    const lexer = new ExprLexer(source);
    expect(lexer.Next().kind).toBe(TokenKind.End);
    expect(lexer.Err()).not.toBeNull();
  });
});
