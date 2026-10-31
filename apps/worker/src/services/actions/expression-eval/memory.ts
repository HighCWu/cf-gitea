// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/exprparser/memory.go — GitHub's evaluation
// memory budget (EvaluationContext.cs / MemoryCounter.cs / EvaluationMemory),
// which stops an expression from assembling a result far larger than the
// contexts it reads (gitea.dev/actionslib v1.5.0, gitea/go.mod:11, the
// submodule's pin).
//
// SPEC-0012 §D5 tier E: the evaluator core. Every budget reports the same
// error, in GitHub's own wording; the exact limit and sizing constants are
// the pinned observable (the memory-cap fixtures read at 524275/524276 bytes
// and the token counts 29125/29126 — see memory.test port).

import { isPrimitive } from "./kinds";
import { utf16Len } from "../expression-syntax/utf16";

/** errExpressionTooLarge is what every budget reports, in GitHub's wording (memory.go:13). */
export const ERR_EXPRESSION_TOO_LARGE = "The maximum allowed memory size was exceeded";

/** maxExpressionMemory is GitHub's EvaluationContext.cs budget, applied independently by counter and ledger (memory.go:16). */
const maxExpressionMemory = 1 << 20;

/** minObjectSize and stringOverhead are GitHub's own rough sizing from MemoryCounter.cs (memory.go:19-22). */
const minObjectSize = 24;
const stringOverhead = 26;

/** referenceSize is IntPtr.Size on the 64-bit runner — what a projected element costs (memory.go:24). */
const referenceSize = 8;

/** stringSize charges for .NET's UTF-16 storage plus object overhead, matching GitHub (memory.go:28-30). */
export function stringSize(value: string): number {
  return stringOverhead + 2 * utf16Len(value);
}

/**
 * Counter is GitHub's per-node MemoryCounter (memory.go:33-46): it charges
 * every occurrence of a repeated value, so a format string built from the
 * same segment twice pays twice.
 */
export class Counter {
  private used = 0;

  add(value: string): void {
    this.used += stringSize(value);
    if (this.used > maxExpressionMemory) {
      throw new Error(ERR_EXPRESSION_TOO_LARGE);
    }
  }

  /** addSegment skips empty gaps between format placeholders, matching GitHub (memory.go:44-49). */
  addSegment(value: string): void {
    if (value === "") {
      return;
    }
    this.add(value);
  }
}

/**
 * Evaluation shares one budget within a single Evaluate call
 * (memory.go:49-79), so concurrent evaluations stay independent — the
 * interpreter threads it through the node walk by nesting it one level per
 * child.
 */
export class Evaluation {
  private readonly depth: number;
  private readonly ledger: Ledger;

  private constructor(depth: number, ledger: Ledger) {
    this.depth = depth;
    this.ledger = ledger;
  }

  static newEvaluation(): Evaluation {
    return new Evaluation(0, new Ledger());
  }

  /** nested returns the budget as a child node sees it, one level deeper (memory.go:60-62). */
  nested(): Evaluation {
    return new Evaluation(this.depth + 1, this.ledger);
  }

  /**
   * charge replaces a primitive's subtree cost, since descendants cannot stay
   * reachable through it (memory.go:65-72).
   */
  charge(value: unknown): void {
    if (typeof value === "string") {
      this.ledger.add(this.depth, stringSize(value), true);
      return;
    }
    this.ledger.add(this.depth, minObjectSize, isPrimitive(value));
  }

  /** chargeProjected batches reference charges, failing at the same limit as charging elements individually (memory.go:75-77). */
  chargeProjected(count: number): void {
    this.ledger.add(this.depth, count * referenceSize, false);
  }
}

/** shallowDepths is how many nesting levels a ledger tallies without reaching the heap (memory.go:80-81). */
const shallowDepths = 16;

/**
 * Ledger is GitHub's EvaluationMemory (memory.go:84-113): it accumulates
 * siblings' costs per depth and drops the subtrees a primitive replacement
 * made unreachable.
 */
class Ledger {
  private readonly shallow: number[] = new Array<number>(shallowDepths).fill(0);
  private deep: number[] = [];
  private active = 0; // one past the deepest depth still holding a charge
  private total = 0;

  private tally(depth: number): number {
    if (depth < shallowDepths) {
      return this.shallow[depth]!;
    }
    while (this.deep.length <= depth - shallowDepths) {
      this.deep.push(0);
    }
    return this.deep[depth - shallowDepths]!;
  }

  add(depth: number, bytes: number, trim: boolean): void {
    if (trim) {
      while (this.active > depth + 1) {
        this.active--;
        const cleared = this.clear(this.active);
        this.total -= cleared;
      }
    }
    this.active = Math.max(this.active, depth + 1);
    this.tallyAdd(depth, bytes);
    this.total += bytes;
    if (this.total > maxExpressionMemory) {
      throw new Error(ERR_EXPRESSION_TOO_LARGE);
    }
  }

  private clear(depth: number): number {
    if (depth < shallowDepths) {
      const previous = this.shallow[depth]!;
      this.shallow[depth] = 0;
      return previous;
    }
    while (this.deep.length <= depth - shallowDepths) {
      this.deep.push(0);
    }
    const previous = this.deep[depth - shallowDepths]!;
    this.deep[depth - shallowDepths] = 0;
    return previous;
  }

  private tallyAdd(depth: number, bytes: number): void {
    if (depth < shallowDepths) {
      this.shallow[depth] = this.shallow[depth]! + bytes;
      return;
    }
    while (this.deep.length <= depth - shallowDepths) {
      this.deep.push(0);
    }
    this.deep[depth - shallowDepths] = this.deep[depth - shallowDepths]! + bytes;
  }
}
