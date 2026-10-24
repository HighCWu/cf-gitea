/**
 * Three-way line merge — the diff3 reconciliation of SPEC-0001b §4.2, built on
 * the engine's Myers core (`git/diff.ts diffLines`) rather than a new
 * dependency (the node-diff3 replacement the SPEC's port decision locked:
 * "our `diff.ts` already has the Myers core, and the diff3 reconciliation is
 * differential-tested against `git merge-file`").
 *
 * Model: each side's diff against the base yields base-anchored change
 * regions; regions from the two sides are grouped when their base intervals
 * overlap or touch (changes with zero unchanged lines between them conflict,
 * matching git's xdl_merge); a group where both sides produced the same
 * content merges clean, any other group emits a conflict hunk with
 * `<<<<<<<`/`>>>>>>>` markers (labels ours/theirs — branch names supplied by
 * the caller; the default git style: no base section between the markers).
 *
 * Pure functions only: no store access, no IO.
 */
import { diffLines, type DiffOp } from "../git/diff";

export interface Diff3Region {
  /** base line interval [start, end) this side replaces (`end === start` for
   * a pure insertion, `lines.length === 0` for a pure deletion) */
  start: number;
  end: number;
  /** the side's replacement lines */
  lines: string[];
}

export interface Diff3Result {
  /** merged file content as lines (caller joins and re-adds the newline) */
  lines: string[];
  /** true when at least one conflict hunk was emitted */
  conflict: boolean;
}

/** Convert one side's diff ops into base-anchored regions (sorted by start). */
export function toRegions(base: string[], side: string[], ops: DiffOp[]): Diff3Region[] {
  void base;
  void side;
  const out: Diff3Region[] = [];
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].tag === "eq") {
      bi++;
      i++;
      continue;
    }
    const start = bi;
    const lines: string[] = [];
    while (i < ops.length && ops[i].tag !== "eq") {
      if (ops[i].tag === "del") bi++;
      else lines.push(ops[i].line);
      i++;
    }
    out.push({ start, end: bi, lines });
  }
  return out;
}

/**
 * The three-way merge. Returns null when either Myers pass exceeded its
 * budget (diffLines overflow) — the caller classifies that as a conflict
 * ("null ⇒ conflict", §4.2), same as gitorange's size gate.
 */
export function diff3(
  base: string[],
  ours: string[],
  theirs: string[],
  labels: { ours: string; theirs: string }
): Diff3Result | null {
  const opsOurs = diffLines(base.join("\n"), ours.join("\n"));
  if (opsOurs === null) return null;
  const opsTheirs = diffLines(base.join("\n"), theirs.join("\n"));
  if (opsTheirs === null) return null;
  return diff3FromOps(base, toRegions(base, ours, opsOurs), toRegions(base, theirs, opsTheirs), labels);
}

/** Region-precomputed variant (the tree merge reuses one diff pass). */
export function diff3FromOps(
  base: string[],
  oursRegions: Diff3Region[],
  theirsRegions: Diff3Region[],
  labels: { ours: string; theirs: string }
): Diff3Result {
  type Tagged = Diff3Region & { side: 0 | 1 };
  const all: Tagged[] = [
    ...oursRegions.map((r) => ({ ...r, side: 0 as const })),
    ...theirsRegions.map((r) => ({ ...r, side: 1 as const })),
  ].sort((x, y) => x.start - y.start || x.end - y.end);

  const out: string[] = [];
  let conflict = false;
  let pos = 0; // next base line not yet emitted
  let k = 0;
  const MARK_O = `<<<<<<< ${labels.ours}`;
  const MARK_SEP = "=======";
  const MARK_C = `>>>>>>> ${labels.theirs}`;

  while (k < all.length) {
    let gs = all[k].start;
    let ge = all[k].end;
    const group: Tagged[] = [all[k]];
    k++;
    // overlap or touch (zero unchanged lines between) ⇒ one conflict group
    while (k < all.length && all[k].start <= ge) {
      ge = Math.max(ge, all[k].end);
      group.push(all[k]);
      k++;
    }
    // stable gap before the group: identical on both sides, emit from base
    for (let p = pos; p < gs; p++) out.push(base[p]);
    const hasOurs = group.some((r) => r.side === 0);
    const hasTheirs = group.some((r) => r.side === 1);
    const oursPart = expand(group.filter((r) => r.side === 0), gs, ge, base);
    const theirsPart = expand(group.filter((r) => r.side === 1), gs, ge, base);
    if (!hasTheirs) {
      out.push(...oursPart); // only ours touched this range (deletion ⇒ empty)
    } else if (!hasOurs) {
      out.push(...theirsPart); // only theirs touched this range
    } else if (sameLines(oursPart, theirsPart)) {
      out.push(...oursPart); // both sides made the same change
    } else {
      conflict = true;
      out.push(MARK_O, ...oursPart, MARK_SEP, ...theirsPart, MARK_C);
    }
    pos = ge;
  }
  for (; pos < base.length; pos++) out.push(base[pos]);
  return { lines: out, conflict };
}

/** One side's content for base range [gs, ge): the side's regions spliced
 * into the unchanged base lines. */
function expand(regions: Diff3Region[], gs: number, ge: number, base: string[]): string[] {
  const out: string[] = [];
  let p = gs;
  for (const r of regions) {
    while (p < r.start) out.push(base[p++]);
    out.push(...r.lines);
    if (r.end > p) p = r.end;
  }
  while (p < ge) out.push(base[p++]);
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
