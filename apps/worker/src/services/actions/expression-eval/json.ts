// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/exprparser/json.go — GitHub's own JSON
// dialect: comments, single-quoted strings, NaN/Infinity/undefined, 0x/0o
// integers and bare property names (json.go:25-363); plus the writer from
// functions.go:233-330 — GitHub's indented rendering, each logical token
// charged against the memory budget (recorded deviation: upstream keeps the
// writer in functions.go, the TS layering keeps both JSON directions in this
// one module; gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the submodule's
// pin).
//
// Go reads numbers with strconv and big.Float; this port reads them with
// BigInt for the exact-range and truncation rules:
//   - a decimal integer that fits int64 converts round-to-nearest, exactly
//     like Go's float64(int64) (JS Number on a BigInt is the same rounding);
//   - a larger integer truncates its mantissa to 53 bits, matching the
//     big.Float{Prec: 53, Mode: ToZero} conversion (the big-integer fixtures
//     pin the pair: truncation for the bare literal, round-to-nearest for
//     the `.0` spelling).

import { coerceToString, EvaluationKind, FilteredArray, getEvaluationKind } from "./kinds";
import { Counter } from "./memory";
import { maxJSONDepth, OrderedObject } from "./object";

const maxJSONNesting = 64;

interface JSONReader {
  input: string;
  position: number;
}

/** parseJSON reads one GitHub-JSON value (json.go:25-32). */
export function parseJSON(input: string): unknown {
  const reader: JSONReader = { input, position: 0 };
  skipWhitespace(reader);
  const comment = readComment(reader);
  if (comment.ok) {
    return comment.text;
  }
  return readValue(reader, 0);
}

function readValue(reader: JSONReader, depth: number): unknown {
  skipIgnorable(reader);
  if (done(reader)) {
    throw new Error("unexpected end of input");
  }
  const character = reader.input[reader.position]!;
  switch (true) {
    case character === "{":
      return readObject(reader, depth + 1);
    case character === "[":
      return readArray(reader, depth + 1);
    case character === '"' || character === "'":
      return readString(reader);
    case character === "t": {
      readLiteral(reader, "true");
      return true;
    }
    case character === "f": {
      readLiteral(reader, "false");
      return false;
    }
    case character === "n": {
      readLiteral(reader, "null");
      return null;
    }
    case character === "u": {
      // GitHub reads `undefined` as an empty string, its template reader's dialect
      readLiteral(reader, "undefined");
      return "";
    }
    case character === "N": {
      readLiteral(reader, "NaN");
      return Number.NaN;
    }
    case character === "I": {
      readLiteral(reader, "Infinity");
      return Number.POSITIVE_INFINITY;
    }
    case character === "-" && reader.input.startsWith("-Infinity", reader.position): {
      readLiteral(reader, "-Infinity");
      return Number.NEGATIVE_INFINITY;
    }
    case character === "-" || character === "." || (character >= "0" && character <= "9"):
      return readNumber(reader);
    default:
      throw new Error(`unexpected character '${character}' at offset ${reader.position}`);
  }
}

function readObject(reader: JSONReader, depth: number): unknown {
  if (depth > maxJSONNesting) {
    throw new Error(`nesting exceeds the maximum of ${maxJSONNesting}`);
  }
  reader.position++;
  const order: string[] = [];
  const properties = new Map<string, unknown>();
  for (;;) {
    skipIgnorable(reader);
    if (done(reader)) {
      throw new Error("unterminated object");
    }
    if (reader.input[reader.position] === "}") {
      reader.position++;
      return foldContextKeys(order, properties);
    }
    const name = readPropertyName(reader);
    skipWhitespace(reader);
    if (done(reader) || reader.input[reader.position] !== ":") {
      throw new Error(`expected ':' after property '${name}'`);
    }
    reader.position++;
    const value = readValue(reader, depth);
    if (!properties.has(name)) {
      order.push(name);
    }
    properties.set(name, value);

    const closed = readSeparator(reader, "}", "object");
    if (closed) {
      return foldContextKeys(order, properties);
    }
  }
}

function readSeparator(reader: JSONReader, closer: string, container: string): boolean {
  skipIgnorable(reader);
  if (done(reader)) {
    throw new Error(`unterminated ${container}`);
  }
  const character = reader.input[reader.position]!;
  if (character === "," || character === closer) {
    reader.position++;
    return character === closer;
  }
  throw new Error(`unexpected character '${character}' at offset ${reader.position}`);
}

/** foldContextKeys rebuilds the parsed properties as one ordered object (json.go:125-135). */
function foldContextKeys(order: string[], properties: Map<string, unknown>): OrderedObject {
  const object = new OrderedObject();
  for (const name of order) {
    object.set(name, properties.get(name));
  }
  return object;
}

function readArray(reader: JSONReader, depth: number): unknown {
  if (depth > maxJSONNesting) {
    throw new Error(`nesting exceeds the maximum of ${maxJSONNesting}`);
  }
  reader.position++;
  const items: unknown[] = [];
  for (;;) {
    skipIgnorable(reader);
    if (done(reader)) {
      throw new Error("unterminated array");
    }
    if (reader.input[reader.position] === "]") {
      reader.position++;
      return items;
    }
    if (reader.input[reader.position] === ",") {
      items.push("");
    } else {
      items.push(readValue(reader, depth));
    }

    const closed = readSeparator(reader, "]", "array");
    if (closed) {
      return items;
    }
  }
}

/** readPropertyName reads a quoted or bare property name (json.go:172-187). */
function readPropertyName(reader: JSONReader): string {
  const character = reader.input[reader.position]!;
  if (character === '"' || character === "'") {
    return readString(reader);
  }
  const start = reader.position;
  while (reader.position < reader.input.length) {
    const codePoint = reader.input.codePointAt(reader.position)!;
    if (codePoint > 0xffff || !(isLetter(codePoint) || isDigit(codePoint) || codePoint === 0x5f || codePoint === 0x24)) {
      break;
    }
    reader.position += codePoint > 0xffff ? 2 : 1;
  }
  if (reader.position === start) {
    throw new Error(`invalid property name at offset ${start}`);
  }
  return reader.input.slice(start, reader.position);
}

function isLetter(codePoint: number): boolean {
  // Unicode letters, the set Go's unicode.IsLetter covers (test with the
  // same class the fixtures reach: the ASCII range and the common blocks).
  return /[\p{L}]/u.test(String.fromCodePoint(codePoint));
}

function isDigit(codePoint: number): boolean {
  return /[\p{Nd}]/u.test(String.fromCodePoint(codePoint));
}

/** readString reads a quoted string with the GitHub escape set (json.go:189-234). */
function readString(reader: JSONReader): string {
  const quote = reader.input[reader.position]!;
  reader.position++;
  let text = "";
  while (!done(reader)) {
    const character = reader.input[reader.position]!;
    if (character === quote) {
      reader.position++;
      return text;
    }
    if (character === "\\") {
      reader.position++;
      if (done(reader)) {
        throw new Error("unterminated string");
      }
      const escape = reader.input[reader.position]!;
      reader.position++;
      switch (escape) {
        case "b":
          text += "\b";
          break;
        case "t":
          text += "\t";
          break;
        case "n":
          text += "\n";
          break;
        case "f":
          text += "\f";
          break;
        case "r":
          text += "\r";
          break;
        case "\\":
        case '"':
        case "'":
        case "/":
          text += escape;
          break;
        case "u":
          text += readUnicodeEscape(reader);
          break;
        default:
          throw new Error(`bad escape sequence \\${escape} at offset ${reader.position - 1}`);
      }
      continue;
    }
    text += character;
    reader.position++;
  }
  throw new Error("unterminated string");
}

/** readUnicodeEscape reads one \u escape, pairing surrogates the way Go's utf16.DecodeRune does (json.go:236-255). */
function readUnicodeEscape(reader: JSONReader): string {
  const unit = readCodeUnit(reader);
  if (unit < 0xd800 || unit > 0xdfff) {
    return String.fromCharCode(unit);
  }
  if (!reader.input.startsWith("\\u", reader.position)) {
    return "\uFFFD";
  }
  const rest = { input: reader.input, position: reader.position + 2 };
  let low: number;
  try {
    low = readCodeUnit(rest);
  } catch {
    return "\uFFFD";
  }
  const character = decodeSurrogate(unit, low);
  if (character !== undefined) {
    reader.position = rest.position;
    return String.fromCodePoint(character);
  }
  return "\uFFFD";
}

function decodeSurrogate(high: number, low: number): number | undefined {
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
    return 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
  }
  return undefined;
}

function readCodeUnit(reader: JSONReader): number {
  if (reader.position + 4 > reader.input.length) {
    throw new Error("unterminated unicode escape");
  }
  const digits = reader.input.slice(reader.position, reader.position + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
    throw new Error(`bad unicode escape \\u${digits} at offset ${reader.position - 2}`);
  }
  reader.position += 4;
  return Number.parseInt(digits, 16);
}

/** readNumber reads one number in GitHub's dialect (json.go:270-303). */
function readNumber(reader: JSONReader): number {
  const start = reader.position;
  while (!done(reader) && !isValueEnd(reader.input.slice(reader.position), ",]}/)\u0000")) {
    reader.position++;
  }
  const text = reader.input.slice(start, reader.position);
  if (text.length > 1 && text[0] === "0" && text[1] !== "." && text[1] !== "e" && text[1] !== "E") {
    const hex = text[1] === "x" || text[1] === "X";
    const digits = hex ? text.slice(2) : text;
    const base = hex ? 16 : 8;
    if (!validDigits(digits, base) || digits.length === 0) {
      throw new Error(`invalid number '${text}' at offset ${start}`);
    }
    const integer = BigInt(hex ? `0x${digits}` : `0o${digits}`);
    if (integer > 0xffffffffffffffffn) {
      throw new Error(`invalid number '${text}' at offset ${start}`);
    }
    // Go casts uint64 → int64, wrapping above 2^63-1.
    const wrapped = integer > 0x7fffffffffffffffn ? integer - 0x10000000000000000n : integer;
    return Number(wrapped);
  }
  const digits = text.startsWith("-") ? text.slice(1) : text;
  if (digits.length > 0 && digitsEnd(digits, 0) === digits.length) {
    if (digits.length <= 19) {
      const integer = BigInt(text);
      if (integer >= -0x8000000000000000n && integer <= 0x7fffffffffffffffn) {
        return Number(integer); // float64(int64): round-to-nearest, which Number on a BigInt is
      }
    }
    if (text.length > 380) {
      throw new Error(`integer '${text}' is too large to parse`);
    }
    return truncateToDouble(BigInt(text));
  }
  if (Number.isNaN(Number(text))) {
    throw new Error(`invalid number '${text}' at offset ${start}`);
  }
  return Number(text);
}

function validDigits(digits: string, base: number): boolean {
  const pattern = base === 16 ? /^[0-9a-f]+$/i : /^[0-7]+$/;
  return pattern.test(digits);
}

function digitsEnd(text: string, position: number): number {
  while (position < text.length && text.charCodeAt(position) >= 0x30 && text.charCodeAt(position) <= 0x39) {
    position++;
  }
  return position;
}

/** truncateToDouble converts a big integer the way big.Float{Prec:53, Mode:ToZero} does: the mantissa truncates. */
function truncateToDouble(value: bigint): number {
  if (value === 0n) {
    return 0;
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const bits = magnitude.toString(2).length;
  if (bits <= 53) {
    return Number(value);
  }
  const shift = BigInt(bits - 53);
  const mantissa = magnitude >> shift;
  const number = Number(mantissa) * 2 ** Number(shift);
  return negative ? -number : number;
}

function isValueEnd(text: string, delimiters: string): boolean {
  const codePoint = text.codePointAt(0)!;
  return isUnicodeSpace(codePoint) || delimiters.includes(String.fromCodePoint(codePoint));
}

/** isUnicodeSpace is Go's unicode.IsSpace (the set JS \s misses only U+0085). */
function isUnicodeSpace(codePoint: number): boolean {
  return (
    codePoint === 0x20 ||
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

/** readLiteral consumes a bare literal and checks the value boundary (json.go:310-322). */
function readLiteral(reader: JSONReader, literal: string): void {
  if (!reader.input.startsWith(literal, reader.position)) {
    throw new Error(`unexpected character '${reader.input[reader.position]}' at offset ${reader.position}`);
  }
  reader.position += literal.length;
  const rest = reader.input.slice(reader.position);
  if (!done(reader) && !isValueEnd(rest, ",]}\u0000") && !rest.startsWith("//") && !rest.startsWith("/*")) {
    throw new Error(`unexpected character '${reader.input[reader.position]}' at offset ${reader.position}`);
  }
}

function done(reader: JSONReader): boolean {
  return reader.position >= reader.input.length;
}

/** skipWhitespace passes NUL and Unicode space (json.go:324-332). */
function skipWhitespace(reader: JSONReader): void {
  while (!done(reader)) {
    const codePoint = reader.input.codePointAt(reader.position)!;
    if (codePoint !== 0 && !isUnicodeSpace(codePoint)) {
      break;
    }
    reader.position += codePoint > 0xffff ? 2 : 1;
  }
}

/** skipIgnorable passes whitespace and comments (json.go:334-341). */
function skipIgnorable(reader: JSONReader): void {
  for (;;) {
    skipWhitespace(reader);
    const comment = readComment(reader);
    if (!comment.ok) {
      return;
    }
  }
}

/** readComment reads one // or slash-star comment (json.go:343-362). */
function readComment(reader: JSONReader): { text: string; ok: boolean } {
  const rest = reader.input.slice(reader.position);
  if (rest.startsWith("//")) {
    let body = rest.slice(2);
    const end = body.search(/[\r\n]/);
    if (end >= 0) {
      body = body.slice(0, end);
    }
    reader.position += 2 + body.length;
    return { text: body, ok: true };
  }
  if (!rest.startsWith("/*")) {
    return { text: "", ok: false };
  }
  const end = rest.indexOf("*/");
  if (end < 0) {
    return { text: "", ok: false };
  }
  reader.position += 2 + end + 2;
  return { text: rest.slice(2, end), ok: true };
}

// ---------------------------------------------------------------------------
// The writer (functions.go:233-330).

/** maxWriterDepth stops a self-referential context from recursing until the stack dies (functions.go:243-244, the shared maxJSONDepth). */

interface JSONWriter {
  output: string;
  memory: Counter;
  tokenStart: number;
}

/** charge bills everything written since the last call as one token (functions.go:252-256). */
function charge(writer: JSONWriter): void {
  const token = writer.output.slice(writer.tokenStart);
  writer.tokenStart = writer.output.length;
  writer.memory.add(token);
}

/** writeJSON renders one value GitHub's way (functions.go:224-231, 258-330). */
export function writeJSON(value: unknown): string {
  const writer: JSONWriter = { output: "", memory: new Counter(), tokenStart: 0 };
  writeJSONValue(writer, value, 0, 0);
  return writer.output;
}

function writeJSONValue(writer: JSONWriter, value: unknown, indent: number, hops: number): void {
  if (hops > maxJSONDepth) {
    throw new Error("value nests too deeply");
  }
  if (value === null || value === undefined) {
    writer.output += "null";
    charge(writer);
    return;
  }
  if (value instanceof OrderedObject) {
    const entries: [string, unknown][] = [...value.all()];
    writeJSONObject(writer, entries, indent, hops);
    return;
  }

  switch (getEvaluationKind(value)) {
    case EvaluationKind.Boolean:
      writer.output += value === true ? "true" : "false";
      break;
    case EvaluationKind.String:
      writeJSONString(writer, value as string);
      break;
    case EvaluationKind.Number:
      writer.output += coerceToString(value);
      break;
    case EvaluationKind.Array: {
      writeJSONArray(writer, value, indent, hops);
      return;
    }
    case EvaluationKind.Object: {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => [key, record[key]] as [string, unknown]);
      writeJSONObject(writer, entries, indent, hops);
      return;
    }
    default:
      writer.output += "{}";
  }
  charge(writer);
}

function writeJSONArray(writer: JSONWriter, value: unknown, indent: number, hops: number): void {
  const items = value instanceof FilteredArray ? value.items : (value as unknown[]);
  if (items.length === 0) {
    writer.output += "[]";
    charge(writer);
    return;
  }

  writer.output += "[";
  charge(writer);
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      writer.output += ",";
    }
    writer.output += "\n";
    writer.output += "  ".repeat(indent + 1);
    writeJSONValue(writer, items[i], indent + 1, hops + 1);
  }
  writer.output += "\n";
  writer.output += "  ".repeat(indent);
  writer.output += "]";
  charge(writer);
}

function writeJSONObject(writer: JSONWriter, entries: [string, unknown][], indent: number, hops: number): void {
  if (entries.length === 0) {
    writer.output += "{}";
    charge(writer);
    return;
  }

  writer.output += "{";
  charge(writer);
  for (let i = 0; i < entries.length; i++) {
    const [key, entryValue] = entries[i]!;
    if (i > 0) {
      writer.output += ",";
    }
    writer.output += "\n";
    writer.output += "  ".repeat(indent + 1);
    writeJSONString(writer, key);
    charge(writer);
    writer.output += ": ";
    writeJSONValue(writer, entryValue, indent + 1, hops + 1);
  }
  writer.output += "\n";
  writer.output += "  ".repeat(indent);
  writer.output += "}";
  charge(writer);
}

/** writeJSONString escapes the two controls GitHub escapes and nothing else — HTML stays raw (functions.go:315-330). */
function writeJSONString(writer: JSONWriter, value: string): void {
  writer.output += '"';
  for (const character of value) {
    switch (character) {
      case '"':
      case "\\":
        writer.output += "\\";
        writer.output += character;
        break;
      case "\b":
        writer.output += "\\b";
        break;
      case "\f":
        writer.output += "\\f";
        break;
      case "\n":
        writer.output += "\\n";
        break;
      case "\r":
        writer.output += "\\r";
        break;
      case "\t":
        writer.output += "\\t";
        break;
      default: {
        const codePoint = character.codePointAt(0)!;
        if (codePoint < 0x20) {
          writer.output += `\\u00${Number(codePoint).toString(16).padStart(2, "0")}`;
        } else {
          writer.output += character;
        }
      }
    }
  }
  writer.output += '"';
}
