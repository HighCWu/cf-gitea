// Copyright 2022 The Gitea Authors. All rights reserved.
// Copyright 2022 The nektos/act Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/exprparser/functions.go — the built-in
// functions plus the needs-graph helpers the status functions read
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the submodule's pin;
// SPEC-0012 §D5 tier E). The JSON writer lives in json.ts (recorded
// deviation: upstream keeps it in this file; the TS module layering keeps
// both JSON directions together).
//
// §D4 drops glob.go: hashFiles' filesystem matcher has no server caller —
// the working directory is always empty server-side, so the function
// reports "hashFiles is only available in steps" exactly as upstream does
// (functions.go:477-479), and a caller that supplies a working directory is
// an internal error (the runner-side evaluator owns real hashing).

import { OrdinalIgnoreCaseContains, OrdinalIgnoreCaseEqual } from "../expression-syntax/ordinal";
import type { ExprNode } from "../expression-syntax/ast";
import { coerceToString, collectionItems, isPrimitive } from "./kinds";
import { Counter } from "./memory";
import { parseJSON, writeJSON } from "./json";
import type { EvaluationEnvironment, JobShape, RunShape } from "./interpreter";

/** EvaluateArg evaluates one argument node against the caller's memory budget. */
export type EvaluateArg = (node: ExprNode) => unknown;

/** CompareValues is the interpeter's comparison, which contains() borrows for item membership. */
export type CompareValues = (left: unknown, right: unknown) => boolean;

/** matchPrimitiveStrings compares two primitives as strings (functions.go:36-38). */
function matchPrimitiveStrings(search: unknown, item: unknown, match: (search: string, item: string) => boolean): boolean {
  return isPrimitive(search) && isPrimitive(item) && match(coerceToString(search), coerceToString(item));
}

/** containsFunction implements contains() (functions.go:40-64): strings search inside strings, arrays search for members. */
export function containsFunction(args: ExprNode[], evaluateArg: EvaluateArg, compare: CompareValues): unknown {
  const left = evaluateArg(args[0]!);
  const items = collectionItems(left);
  if (!isPrimitive(left) && (items === undefined || items.length === 0)) {
    return false;
  }
  const right = evaluateArg(args[1]!);
  if (isPrimitive(left)) {
    return matchPrimitiveStrings(left, right, OrdinalIgnoreCaseContains);
  }
  for (const item of items!) {
    if (compare(item, right)) {
      return true;
    }
  }
  return false;
}

/** matchStringsFunction implements startsWith/endsWith (functions.go:66-75). */
export function matchStringsFunction(args: ExprNode[], evaluateArg: EvaluateArg, match: (s: string, prefix: string) => boolean): unknown {
  const left = evaluateArg(args[0]!);
  if (!isPrimitive(left)) {
    return false;
  }
  const right = evaluateArg(args[1]!);
  return matchPrimitiveStrings(left, right, match);
}

/**
 * formatFunction implements format() (functions.go:77-190): GitHub's
 * {index} placeholders with {{ }} and }} escapes, each argument evaluated at
 * most once, in placeholder order, under the format's own memory budget.
 */
export function formatFunction(args: ExprNode[], evaluateArg: EvaluateArg): string {
  const value = evaluateArg(args[0]!);
  const input = coerceToString(value);
  interface FormatSegment {
    literal: string;
    replacementIndex: number;
    hasFormatSpecifier: boolean;
  }
  const segments: FormatSegment[] = [];
  const formatMemory = new Counter();
  const appendLiteral = (literal: string): void => {
    if (literal !== "") {
      formatMemory.addSegment(literal);
      segments.push({ literal, replacementIndex: -1, hasFormatSpecifier: false });
    }
  };
  let segment = 0;
  const invalid = (): Error => new Error(`The following format string is invalid: ${input}`);
  for (let index = 0; index < input.length; ) {
    switch (input[index]) {
      case "{":
        if (index + 1 < input.length && input[index + 1] === "{") {
          appendLiteral(input.slice(segment, index + 1));
          index += 2;
          segment = index;
          continue;
        }

        {
          const lbrace = index;
          index++;
          const digitStart = index;
          index = digitsEnd(input, index);
          if (digitStart === index) {
            throw invalid();
          }

          const digits = input.slice(digitStart, index);
          if (!/^[0-9]+$/.test(digits) || digits.length > 3) {
            throw invalid();
          }
          const parsed = Number(digits);
          if (parsed > 0xff) {
            throw invalid();
          }
          const replacementIndex = parsed;

          let hasFormatSpecifier = false;
          if (index < input.length && input[index] === ":") {
            index++;
            for (;;) {
              if (index >= input.length) {
                throw invalid();
              }
              if (input[index] !== "}") {
                hasFormatSpecifier = true;
                index++;
                continue;
              }
              if (index + 1 < input.length && input[index + 1] === "}") {
                hasFormatSpecifier = true;
                index += 2;
                continue;
              }
              index++;
              break;
            }
          } else if (index < input.length && input[index] === "}") {
            index++;
          } else {
            throw invalid();
          }

          if (replacementIndex >= args.length - 1) {
            throw new Error(`The following format string references more arguments than were supplied: ${input}`);
          }
          appendLiteral(input.slice(segment, lbrace));
          segments.push({ literal: "", replacementIndex, hasFormatSpecifier });
          segment = index;
        }
        break;

      case "}":
        if (index + 1 >= input.length || input[index + 1] !== "}") {
          throw invalid();
        }
        appendLiteral(input.slice(segment, index + 1));
        index += 2;
        segment = index;
        break;

      default:
        index++;
    }
  }
  appendLiteral(input.slice(segment));

  let output = "";
  const replacements = new Array<string | undefined>(args.length - 1).fill(undefined);
  for (const part of segments) {
    if (part.replacementIndex < 0) {
      output += part.literal;
      continue;
    }
    let replacement = replacements[part.replacementIndex];
    if (replacement === undefined) {
      replacement = coerceToString(evaluateArg(args[part.replacementIndex + 1]!));
      replacements[part.replacementIndex] = replacement;
    }
    if (part.hasFormatSpecifier) {
      throw new Error(`The following format string contains an invalid format specifier: '${input}'`);
    }
    formatMemory.addSegment(replacement);
    output += replacement;
  }
  return output;
}

/** joinFunction implements join() (functions.go:192-222): an array joins with the separator, a primitive renders alone. */
export function joinFunction(args: ExprNode[], evaluateArg: EvaluateArg): string {
  const value = evaluateArg(args[0]!);
  if (isPrimitive(value)) {
    return coerceToString(value);
  }

  const items = collectionItems(value);
  if (items !== undefined) {
    let separator = ",";
    let output = "";
    const joinMemory = new Counter();
    for (let i = 0; i < items.length; i++) {
      if (i === 1 && args.length > 1) {
        const separatorValue = evaluateArg(args[1]!);
        if (isPrimitive(separatorValue)) {
          separator = coerceToString(separatorValue);
        }
      }
      if (i > 0) {
        joinMemory.add(separator);
        output += separator;
      }
      const item = coerceToString(items[i]);
      joinMemory.add(item);
      output += item;
    }
    return output;
  }
  return "";
}

/** toJSONFunction implements toJSON() (functions.go:224-231): GitHub's own indented rendering under its token budget. */
export function toJSONFunction(value: unknown): string {
  return writeJSON(value);
}

/** fromJSONFunction implements fromJSON() (functions.go:301-308): GitHub stringifies the argument before parsing. */
export function fromJSONFunction(value: unknown): unknown {
  try {
    return parseJSON(coerceToString(value));
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    throw new Error(`Invalid JSON: ${message}`, { cause: thrown });
  }
}

/**
 * evaluateHashFiles reports the function unavailable (functions.go:310-338,
 * minus glob.go per §D4): the server's working directory is always empty, so
 * every server-side evaluation lands on the same pinned error, and a working
 * directory at all means a caller escaped the server contract.
 */
export function evaluateHashFiles(args: unknown[], workingDir: string): string {
  for (let i = 0; i < args.length; i++) {
    const value = coerceToString(args[i]);
    if (i === 0 && value.startsWith("--")) {
      if (!OrdinalIgnoreCaseEqual(value, "--follow-symbolic-links")) {
        throw new Error(`Invalid glob option ${value}, avaliable option: '--follow-symbolic-links'`);
      }
    }
  }
  if (workingDir === "") {
    // otherwise it would hash the files of the process's own directory, like a server's
    throw new Error("hashFiles is only available in steps");
  }
  throw new Error("hashFiles is not implemented in the server evaluator");
}

/** evaluateCaseArgs implements case() lazily in pairs (interpreter.go:1113-1128). */
export function evaluateCaseArgs(args: ExprNode[], evaluateArg: EvaluateArg): unknown {
  for (let i = 0; i < args.length - 1; i += 2) {
    const predicate = evaluateArg(args[i]!);
    if (typeof predicate !== "boolean") {
      throw new Error("case predicate must evaluate to a boolean value");
    }
    if (predicate) {
      return evaluateArg(args[i + 1]!);
    }
  }
  return evaluateArg(args[args.length - 1]!);
}

/** jobById resolves a job id against the run shape (functions.go:351-358). */
function jobById(run: RunShape | undefined, jobId: string): JobShape | undefined {
  if (run === undefined || run.workflow === undefined) {
    return undefined;
  }
  return run.workflow.jobs[jobId];
}

/** currentJob reads the run's own job (functions.go:360-366). */
function currentJob(run: RunShape | undefined): JobShape | undefined {
  if (run === undefined) {
    return undefined;
  }
  return jobById(run, run.jobId);
}

/** needsResultOf matches GitHub's needs context, where a tolerated failure reads as success (model/workflow.go:389-393). */
export function needsResultOf(job: JobShape): string | undefined {
  if (job.result === "failure" && job.continueOnError) {
    return "success";
  }
  return job.result;
}

/**
 * ancestorJobs skips missing jobs and the cycles GitHub rejects during
 * workflow validation (functions.go:369-388).
 */
function ancestorJobs(run: RunShape | undefined, job: JobShape | undefined, visited: Set<string>): JobShape[] {
  if (job === undefined) {
    return [];
  }

  const ancestors: JobShape[] = [];
  for (const need of job.needs ?? []) {
    if (visited.has(need)) {
      continue;
    }
    visited.add(need);

    const parent = jobById(run, need);
    if (parent === undefined) {
      continue;
    }
    ancestors.push(parent);
    ancestors.push(...ancestorJobs(run, parent, visited));
  }

  return ancestors;
}

/** jobSuccess reads whether every ancestor needs result is success (functions.go:390-398). */
export function jobSuccess(run: RunShape | undefined): boolean {
  for (const ancestor of ancestorJobs(run, currentJob(run), new Set<string>())) {
    if (needsResultOf(ancestor) !== "success") {
      return false;
    }
  }
  return true;
}

/** jobStatus defaults to success, as GitHub's `JobContext.Status ?? ActionResult.Success` does (functions.go:401-407). */
export function jobStatus(env: EvaluationEnvironment): string {
  if (env.job === undefined || env.job.status === undefined || env.job.status === "") {
    return "success";
  }
  return env.job.status;
}

/** jobFailure reads whether any ancestor needs result is failure (functions.go:409-417). */
export function jobFailure(run: RunShape | undefined): boolean {
  for (const ancestor of ancestorJobs(run, currentJob(run), new Set<string>())) {
    if (needsResultOf(ancestor) === "failure") {
      return true;
    }
  }
  return false;
}

/** digitsEnd scans the ASCII digits from position (lexer.go:390-395, mirrored from expression-syntax/lexer.ts — see kinds.ts). */
function digitsEnd(text: string, position: number): number {
  while (position < text.length && text.charCodeAt(position) >= 0x30 && text.charCodeAt(position) <= 0x39) {
    position++;
  }
  return position;
}
