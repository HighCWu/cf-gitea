// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/lexer.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11). The grammar, operator
// precedence and parser limits implemented here follow GitHub's own
// expression parsers, github.com/actions/languageservices (MIT, Copyright
// GitHub) and github.com/actions/runner (MIT, Copyright (c) 2019 GitHub).
//
// Go's lexer walks byte offsets and decodes runes; this port walks UTF-16
// unit offsets and decodes code points (a surrogate pair is one character,
// one column, as one rune is in Go). ASCII decisions are unit-identical.

import { type ExprError, newLocatedExprError } from "./ast";

/** TokenKind identifies a lexical token (lexer.go:21-45). */
export enum TokenKind {
  Unknown = 0,
  End,
  Ident,
  String,
  Number,
  LeftParen,
  RightParen,
  LeftBracket,
  RightBracket,
  Dot,
  Not,
  Less,
  LessEq,
  Greater,
  GreaterEq,
  Eq,
  NotEq,
  And,
  Or,
  Star,
  Comma,
}

/** Token is one lexical token and its source position (lexer.go:48-54). */
export interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
  line: number;
  column: number;
}

/** NewExprLexer creates an expression lexer (lexer.go:67-69). */
export function NewExprLexer(source: string): ExprLexer {
  return new ExprLexer(source);
}

/** ExprLexer tokenizes one expression, without the `${{ }}` delimiters (lexer.go:57-64). */
export class ExprLexer {
  readonly source: string;
  offset: number;
  line: number;
  column: number;
  last: TokenKind;
  err: ExprError | null;

  constructor(source: string) {
    this.source = source;
    this.offset = 0;
    this.line = 1;
    this.column = 1;
    this.last = TokenKind.Unknown;
    this.err = null;
  }

  /** The code point at the read offset, -1 at end (lexer.go:79-88 peek). */
  peek(): number {
    if (this.offset >= this.source.length) {
      return -1; // Go's utf8.RuneError-at-end stand-in; matches no ASCII check
    }
    const unit = this.source.charCodeAt(this.offset);
    if (unit >= 0xd800 && unit < 0xdc00 && this.offset + 1 < this.source.length) {
      const low = this.source.charCodeAt(this.offset + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        return (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
      }
    }
    return unit;
  }

  /** advance consumes the next code point, which every caller has already found is there (lexer.go:91-103). */
  advance(): void {
    const character = this.peek();
    const size = character > 0xffff ? 2 : 1;
    this.offset += size;
    if (character === 0x0a) {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
  }

  makeToken(kind: TokenKind, startOffset: number, line: number, column: number): Token {
    this.last = kind;
    return {
      kind,
      value: this.source.slice(startOffset, this.offset),
      offset: startOffset,
      line,
      column,
    };
  }

  endToken(): Token {
    return { kind: TokenKind.End, value: "", offset: this.offset, line: this.line, column: this.column };
  }

  failUnexpected(startOffset: number, line: number, column: number): Token {
    if (this.err === null) {
      this.err = newLocatedExprError("Unexpected symbol", this.source, {
        value: this.source.slice(startOffset, this.offset),
        offset: startOffset,
        line,
        column,
      });
    }
    return this.endToken();
  }

  skipWhitespace(): void {
    while (this.offset < this.source.length && isUnicodeSpace(this.peek())) {
      this.advance();
    }
  }

  advanceToTokenBoundary(): void {
    while (this.offset < this.source.length && !isExprTokenBoundary(this.peek())) {
      this.advance();
    }
  }

  lexIdentifier(startOffset: number, line: number, column: number): Token {
    let valid = true;
    while (this.offset < this.source.length && !isExprTokenBoundary(this.peek())) {
      const character = this.peek();
      valid = valid && (isExprLetter(character) || isExprDigit(character) || character === 0x5f /* _ */ || character === 0x2d /* - */);
      this.advance();
    }
    if (!valid) {
      return this.failUnexpected(startOffset, line, column);
    }
    return this.makeToken(TokenKind.Ident, startOffset, line, column);
  }

  lexNumber(startOffset: number, line: number, column: number): Token {
    while (this.offset < this.source.length && (!isExprTokenBoundary(this.peek()) || this.peek() === 0x2e /* . */)) {
      this.advance();
    }

    const value = this.source.slice(startOffset, this.offset);
    if (numberLiteralValue(value) === null) {
      return this.failUnexpected(startOffset, line, column);
    }
    return this.makeToken(TokenKind.Number, startOffset, line, column);
  }

  /** dotStartsNumber reports whether a `.` opens a number, which no token yet,
   * the zero kind, does (lexer.go:254-273). */
  dotStartsNumber(): boolean {
    switch (this.last) {
      case TokenKind.Unknown:
      case TokenKind.Comma:
      case TokenKind.LeftParen:
      case TokenKind.LeftBracket:
      case TokenKind.Not:
      case TokenKind.Less:
      case TokenKind.LessEq:
      case TokenKind.Greater:
      case TokenKind.GreaterEq:
      case TokenKind.Eq:
      case TokenKind.NotEq:
      case TokenKind.And:
      case TokenKind.Or:
        return true;
      default:
        return false;
    }
  }

  lexString(startOffset: number, line: number, column: number): Token {
    this.advance();
    while (this.offset < this.source.length) {
      if (this.peek() !== 0x27 /* ' */) {
        this.advance();
        continue;
      }
      this.advance();
      if (this.offset < this.source.length && this.peek() === 0x27) {
        this.advance();
        continue;
      }
      return this.makeToken(TokenKind.String, startOffset, line, column);
    }
    return this.failUnexpected(startOffset, line, column);
  }

  lexOperator(startOffset: number, line: number, column: number, singleKind: TokenKind, doubleKind: TokenKind): Token {
    this.advance();
    if (this.offset < this.source.length && this.source.charCodeAt(this.offset) === 0x3d /* = */) {
      this.advance();
      return this.makeToken(doubleKind, startOffset, line, column);
    }
    if (singleKind === TokenKind.Unknown) {
      this.advanceToTokenBoundary();
      return this.failUnexpected(startOffset, line, column);
    }
    return this.makeToken(singleKind, startOffset, line, column);
  }

  lexPair(startOffset: number, line: number, column: number, character: number, kind: TokenKind): Token {
    this.advance();
    if (this.offset >= this.source.length || this.source.charCodeAt(this.offset) !== character) {
      this.advanceToTokenBoundary();
      return this.failUnexpected(startOffset, line, column);
    }
    this.advance();
    return this.makeToken(kind, startOffset, line, column);
  }

  /** Next returns the next token (lexer.go:319-322). */
  Next(): Token {
    return this.next();
  }

  next(): Token {
    if (this.err !== null) {
      return this.endToken();
    }
    this.skipWhitespace();
    if (this.offset >= this.source.length) {
      return this.endToken();
    }

    const startOffset = this.offset;
    const line = this.line;
    const column = this.column;
    const character = this.peek();
    if (isExprLetter(character) || character === 0x5f /* _ */) {
      return this.lexIdentifier(startOffset, line, column);
    }
    if (isExprDigit(character) || character === 0x2d /* - */ || character === 0x2b /* + */ || (character === 0x2e /* . */ && this.dotStartsNumber())) {
      return this.lexNumber(startOffset, line, column);
    }

    switch (character) {
      case 0x27 /* ' */:
        return this.lexString(startOffset, line, column);
      case 0x21 /* ! */:
        return this.lexOperator(startOffset, line, column, TokenKind.Not, TokenKind.NotEq);
      case 0x3c /* < */:
        return this.lexOperator(startOffset, line, column, TokenKind.Less, TokenKind.LessEq);
      case 0x3e /* > */:
        return this.lexOperator(startOffset, line, column, TokenKind.Greater, TokenKind.GreaterEq);
      case 0x3d /* = */:
        return this.lexOperator(startOffset, line, column, TokenKind.Unknown, TokenKind.Eq);
      case 0x26 /* & */:
        return this.lexPair(startOffset, line, column, 0x26, TokenKind.And);
      case 0x7c /* | */:
        return this.lexPair(startOffset, line, column, 0x7c, TokenKind.Or);
      case 0x28 /* ( */:
        this.advance();
        return this.makeToken(TokenKind.LeftParen, startOffset, line, column);
      case 0x29 /* ) */:
        this.advance();
        return this.makeToken(TokenKind.RightParen, startOffset, line, column);
      case 0x5b /* [ */:
        this.advance();
        return this.makeToken(TokenKind.LeftBracket, startOffset, line, column);
      case 0x5d /* ] */:
        this.advance();
        return this.makeToken(TokenKind.RightBracket, startOffset, line, column);
      case 0x2e /* . */:
        this.advance();
        return this.makeToken(TokenKind.Dot, startOffset, line, column);
      case 0x2a /* * */:
        this.advance();
        return this.makeToken(TokenKind.Star, startOffset, line, column);
      case 0x2c /* , */:
        this.advance();
        return this.makeToken(TokenKind.Comma, startOffset, line, column);
      default:
        this.advance();
        this.advanceToTokenBoundary();
        return this.failUnexpected(startOffset, line, column);
    }
  }

  /** Err returns the first lexer error (lexer.go:386-388). */
  Err(): ExprError | null {
    return this.err;
  }
}

function isExprLetter(character: number): boolean {
  return (character >= 0x61 && character <= 0x7a) || (character >= 0x41 && character <= 0x5a);
}

function isExprDigit(character: number): boolean {
  return character >= 0x30 && character <= 0x39;
}

function isExprTokenBoundary(character: number): boolean {
  if (isUnicodeSpace(character)) {
    return true;
  }
  return "()[],.!<>=&|}".includes(String.fromCodePoint(character));
}

/** unicode.IsSpace (Latin-1 + the Unicode space/line separators). */
function isUnicodeSpace(character: number): boolean {
  if (character < 0) {
    return false;
  }
  return (
    character === 0x09 ||
    character === 0x0a ||
    character === 0x0b ||
    character === 0x0c ||
    character === 0x0d ||
    character === 0x20 ||
    character === 0x85 ||
    character === 0xa0 ||
    character === 0x1680 ||
    (character >= 0x2000 && character <= 0x200a) ||
    character === 0x2028 ||
    character === 0x2029 ||
    character === 0x202f ||
    character === 0x205f ||
    character === 0x3000
  );
}

/** basePrefix returns the base a 0x or 0o literal is written in, or 0 for a decimal one (lexer.go:174-185). */
function basePrefix(value: string): number {
  if (value.length <= 2) {
    return 0;
  }
  switch (value.slice(0, 2)) {
    case "0x":
      return 16;
    case "0o":
      return 8;
  }
  return 0;
}

/** parseBasePrefixed parses a 0x or 0o literal, which GitHub reads as a signed
 * 32-bit value (lexer.go:188-195). Go's strconv.ParseUint(digits, base, 32)
 * rejects signs, underscores, junk digits and overflow; the strict digit
 * regexes plus the range check reject the same set. */
function parseBasePrefixed(value: string): { value: number; ok: boolean } {
  const base = basePrefix(value);
  if (base === 0) {
    return { value: 0, ok: false };
  }
  const digits = value.slice(2);
  const valid = base === 16 ? /^[0-9a-f]+$/i.test(digits) : /^[0-7]+$/.test(digits);
  if (!valid) {
    return { value: 0, ok: false };
  }
  const unsigned = Number.parseInt(digits, base);
  if (!Number.isFinite(unsigned) || unsigned > 0xffffffff) {
    return { value: 0, ok: false };
  }
  return { value: unsigned | 0, ok: true }; // int32 wrap, as Go's int32(unsigned)
}

/** numberLiteralValue is the one number grammar: the lexer rejects the
 * literals it fails on, the parser reads the value of the ones it accepted
 * (lexer.go:199-221). Returns null for a literal outside the grammar. */
export function numberLiteralValue(value: string): number | null {
  if (/^\+infinity$/i.test(value)) {
    return Number.POSITIVE_INFINITY;
  }
  if (/^-infinity$/i.test(value)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (basePrefix(value) !== 0) {
    const parsed = parseBasePrefixed(value);
    if (!parsed.ok) {
      return null;
    }
    return parsed.value;
  }
  if (!isExprDecimal(value)) {
    return null;
  }
  // Go accepts strconv.ErrRange (the value becomes ±Inf), which is exactly
  // JS Number's overflow behavior for decimal literals.
  return Number(value);
}

function isExprDecimal(value: string): boolean {
  let offset = 0;
  if (offset < value.length && (value.charCodeAt(offset) === 0x2b /* + */ || value.charCodeAt(offset) === 0x2d /* - */)) {
    offset++;
  }
  let digits = digitsEnd(value, offset) - offset;
  offset += digits;
  if (offset < value.length && value.charCodeAt(offset) === 0x2e /* . */) {
    offset++;
    const fraction = digitsEnd(value, offset) - offset;
    digits += fraction;
    offset += fraction;
  }
  if (digits === 0) {
    return false;
  }
  if (offset < value.length && (value.charCodeAt(offset) === 0x65 /* e */ || value.charCodeAt(offset) === 0x45 /* E */)) {
    offset++;
    if (offset < value.length && (value.charCodeAt(offset) === 0x2b /* + */ || value.charCodeAt(offset) === 0x2d /* - */)) {
      offset++;
    }
    const exponent = digitsEnd(value, offset);
    if (exponent === offset) {
      return false;
    }
    offset = exponent;
  }
  return offset === value.length;
}

function digitsEnd(text: string, position: number): number {
  while (position < text.length && text.charCodeAt(position) >= 0x30 && text.charCodeAt(position) <= 0x39) {
    position++;
  }
  return position;
}
