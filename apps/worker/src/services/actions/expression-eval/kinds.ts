// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0's value model — the evaluation-kind machinery the
// interpreter, the functions and the memory budget all share
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the submodule's pin).
// The Go originals live in pkg/exprparser/interpreter.go
// (getEvaluationKind :745-764, coerceToNumber :766-782, parseNumber :784-808,
// numberValue :856-867, CoerceToString :935-975, IsTruthy :1004-1026) and
// functions.go (isPrimitive :20-34); the file split here is a layering one —
// a TS module cycle would otherwise run through memory/functions/json —
// recorded in this header.
//
// SPEC-0012 §D5 tier E: the evaluator core. The value model is JS-idiomatic:
// Go's reflect kinds become the ECMAScript types, with three explicit
// stand-ins for Go values JS has no literal for —
//   - FilteredArray: Go's `filteredArray []any` (interpreter.go:122), the
//     distinct type a `.*` wildcard projects;
//   - NilContext: a Go nil map, which reads as an OBJECT-kind empty container
//     (truthy, "Object" when coerced, distinct from null) — one sentinel per
//     environment slot so the identity comparisons upstream pins hold
//     (`secrets == secrets` true, `secrets != env` true);
//   - numbers are IEEE doubles exactly as Go's float64 (GitHub canonicalizes
//     every number to a double).

// The lexer helpers parseNumber consumes (digitsEnd, isExprDecimal,
// parseBasePrefixed) are exported to this layer upstream by
// syntax/export.go's alias table; the syntax port keeps them module-private,
// so they are mirrored here byte-for-byte from
// expression-syntax/lexer.ts:344-432 (their upstream home: lexer.go:166-252,
// 390-429). When the syntax module exports them, swap these for the import.
// digitsEnd scans the ASCII digits from position (lexer.go:390-395).
function digitsEnd(text: string, position: number): number {
  while (position < text.length && text.charCodeAt(position) >= 0x30 && text.charCodeAt(position) <= 0x39) {
    position++;
  }
  return position;
}

// isExprDecimal reports whether value is a plain decimal literal
// (lexer.go:397-424): optional sign, digits, optional fraction, optional
// exponent, nothing else.
function isExprDecimal(value: string): boolean {
  let offset = 0;
  if (offset < value.length && (value.charCodeAt(offset) === 0x2b || value.charCodeAt(offset) === 0x2d)) {
    offset++;
  }
  let digits = digitsEnd(value, offset) - offset;
  offset += digits;
  if (offset < value.length && value.charCodeAt(offset) === 0x2e) {
    offset++;
    const fraction = digitsEnd(value, offset) - offset;
    digits += fraction;
    offset += fraction;
  }
  if (digits === 0) {
    return false;
  }
  if (offset < value.length && (value.charCodeAt(offset) === 0x65 || value.charCodeAt(offset) === 0x45)) {
    offset++;
    if (offset < value.length && (value.charCodeAt(offset) === 0x2b || value.charCodeAt(offset) === 0x2d)) {
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

// parseBasePrefixed parses a 0x or 0o literal as a signed 32-bit value
// (lexer.go:349-370); the int32 wrap is Go's int32(unsigned) cast.
function parseBasePrefixed(value: string): number | null {
  if (value.length <= 2) {
    return null;
  }
  const base = value.slice(0, 2) === "0x" ? 16 : value.slice(0, 2) === "0o" ? 8 : 0;
  if (base === 0) {
    return null;
  }
  const digits = value.slice(2);
  const valid = base === 16 ? /^[0-9a-f]+$/i.test(digits) : /^[0-7]+$/.test(digits);
  if (!valid) {
    return null;
  }
  const unsigned = Number.parseInt(digits, base);
  if (!Number.isFinite(unsigned) || unsigned > 0xffffffff) {
    return null;
  }
  return unsigned | 0;
}

/**
 * FilteredArray is the result of a `.*` projection (interpreter.go:122, Go's
 * `filteredArray []any`). It stays a distinct type until Evaluate returns, so
 * an index over it projects item by item instead of reading one value.
 */
export class FilteredArray {
  readonly items: unknown[];
  constructor(items: unknown[]) {
    this.items = items;
  }
}

/**
 * NilContext stands in for a Go nil map the environment holds for a context
 * slot it does not populate. Upstream's nil map is an Object-kind container —
 * truthy, coercing to "Object", equal to itself and distinct from every other
 * slot's nil — which JS `undefined` (Null kind) would not reproduce. The
 * interpreter memoizes one sentinel per slot, so `secrets == secrets` and
 * `secrets != env` both evaluate exactly as upstream's nil maps do.
 */
export class NilContext {
  constructor(readonly name: string) {}
}

/** EvaluationKind mirrors interpreter.go:707-716. */
export enum EvaluationKind {
  Null,
  Boolean,
  Number,
  String,
  Object,
  Array,
}

/** getEvaluationKind classifies a value the way GitHub's evaluator does (interpreter.go:745-764). */
export function getEvaluationKind(value: unknown): EvaluationKind {
  if (value === null || value === undefined) {
    return EvaluationKind.Null;
  }
  switch (typeof value) {
    case "boolean":
      return EvaluationKind.Boolean;
    case "number":
      return EvaluationKind.Number;
    case "string":
      return EvaluationKind.String;
    default:
      return value instanceof FilteredArray || Array.isArray(value) ? EvaluationKind.Array : EvaluationKind.Object;
  }
}

/** isPrimitive mirrors functions.go:20-34 — everything but the containers. */
export function isPrimitive(value: unknown): boolean {
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Null:
    case EvaluationKind.Boolean:
    case EvaluationKind.Number:
    case EvaluationKind.String:
      return true;
    default:
      return false;
  }
}

/** collectionItems reads an array-kind value's elements, or undefined for anything else. */
export function collectionItems(value: unknown): unknown[] | undefined {
  if (value instanceof FilteredArray) {
    return value.items;
  }
  return Array.isArray(value) ? value : undefined;
}

/** numberValue reads a value already known to be a number (interpreter.go:856-867). */
export function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

/** coerceToNumber follows GitHub's numeric coercion table (interpreter.go:766-782). */
export function coerceToNumber(value: unknown): number {
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Null:
      return 0;
    case EvaluationKind.Boolean:
      return value === true ? 1 : 0;
    case EvaluationKind.Number:
      return value as number;
    case EvaluationKind.String:
      return parseNumber(value as string);
    default:
      return Number.NaN;
  }
}

/**
 * parseNumber matches .NET's Double.TryParse as GitHub applies it
 * (interpreter.go:784-808): decimal forms first, then the base-prefixed
 * integers, then a case-insensitive signed Infinity.
 */
export function parseNumber(value: string): number {
  value = value.trim();
  if (value === "") {
    return 0;
  }
  if (isExprDecimal(value)) {
    const number = Number(value);
    // Go accepts ParseFloat's ErrRange result (an infinity), which Number
    // produces for the same overflow; a NaN never arises from this grammar.
    if (!Number.isNaN(number)) {
      return number;
    }
  }
  const integer = parseBasePrefixed(value);
  if (integer !== null) {
    return integer;
  }
  // .NET's Double.TryParse matches Infinity case-insensitively, with an optional sign.
  let sign = 1;
  let unsigned = value;
  if (unsigned.startsWith("-")) {
    sign = -1;
    unsigned = unsigned.slice(1);
  } else if (unsigned.startsWith("+")) {
    unsigned = unsigned.slice(1);
  }
  if (unsigned.toLowerCase() === "infinity") {
    return sign * Number.POSITIVE_INFINITY;
  }
  return Number.NaN;
}

/**
 * CoerceToString follows the operator table GitHub documents
 * (interpreter.go:935-975). Numbers render through Go's
 * strconv.FormatFloat(number, 'G', 15, 64) — GitHub canonicalizes every
 * number to a double, so 1000000000000000 renders as "1E+15".
 */
export function coerceToString(value: unknown): string {
  switch (getEvaluationKind(value)) {
    case EvaluationKind.Null:
      return "";
    case EvaluationKind.Boolean:
      return value === true ? "true" : "false";
    case EvaluationKind.String:
      return value as string;
    case EvaluationKind.Number: {
      const number = value as number;
      if (number === 0) {
        return "0"; // normalizes -0
      } else if (number === Number.POSITIVE_INFINITY) {
        return "Infinity";
      } else if (number === Number.NEGATIVE_INFINITY) {
        return "-Infinity";
      }
      return formatG15(number);
    }
    case EvaluationKind.Array:
      return "Array";
    default:
      return "Object"; // every other kind evaluates as an object, a context pointer included
  }
}

/**
 * formatG15 renders one double the way Go's
 * strconv.FormatFloat(number, 'G', 15, 64) does: fifteen significant digits,
 * trailing zeros stripped, scientific notation when the decimal exponent is
 * below -4 or at 15 or beyond, an uppercase E and a two-digit exponent.
 */
export function formatG15(number: number): string {
  if (Number.isNaN(number)) {
    return "NaN";
  }
  const negative = number < 0;
  // toExponential(14) yields exactly fifteen significant digits, correctly
  // rounded from the double — the digits Go's shortest-15 rounding produces.
  const scientific = Math.abs(number).toExponential(14);
  const e = scientific.indexOf("e");
  const digits = scientific.slice(0, e).replace(".", "");
  const exponent = Number(scientific.slice(e + 1));
  let rendered: string;
  if (exponent < -4 || exponent >= 15) {
    let mantissa = digits[0]!;
    const fraction = digits.slice(1).replace(/0+$/, "");
    if (fraction !== "") {
      mantissa += "." + fraction;
    }
    const sign = exponent < 0 ? "-" : "+";
    rendered = `${mantissa}E${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  } else if (exponent < 0) {
    const fraction = ("0".repeat(-exponent - 1) + digits).replace(/0+$/, "");
    rendered = `0.${fraction}`;
  } else {
    const head = digits.slice(0, exponent + 1);
    const fraction = digits.slice(exponent + 1).replace(/0+$/, "");
    rendered = fraction === "" ? head : `${head}.${fraction}`;
  }
  return negative ? `-${rendered}` : rendered;
}

/** IsTruthy follows GitHub's truth table (interpreter.go:1004-1026). */
export function isTruthy(input: unknown): boolean {
  switch (getEvaluationKind(input)) {
    case EvaluationKind.Null:
      return false;
    case EvaluationKind.Boolean:
      return input === true;
    case EvaluationKind.String:
      return input !== "";
    case EvaluationKind.Number: {
      const number = input as number;
      return number !== 0 && !Number.isNaN(number);
    }
    case EvaluationKind.Object:
    case EvaluationKind.Array:
      return true;
    default:
      return false;
  }
}
