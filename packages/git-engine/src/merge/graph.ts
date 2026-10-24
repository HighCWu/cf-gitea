/**
 * Commit-graph primitives (SPEC-0001b §4.1): merge-base, ancestor test with an
 * honest budget signal, `base..head` range listing, and one-walk divergence
 * counts. Pure reads over GitStore — no durable writes (§4.6).
 *
 * Fresh code (SPEC-0001b §3): gitorange's `GitService.mergeBase` walks a
 * FIRST-PARENT-ONLY chain of the base side — an approximation with a known
 * wrong-answer class (a merge base behind a base-side merge commit is missed;
 * g1t's merge_base.rs documents the production bug this class caused,
 * g1t#365). The implementation below is git's paint-down-to-common-ancestors
 * shape: a bounded two-sided walk with per-commit PARENT1/PARENT2 flag
 * painting, STALE marking of everything under a found common, and a
 * domination filter over the candidate set.
 *
 * Budgets: MERGE_BASE_MAX_VISITS commit visits per walk (OidSet-backed,
 * ~2 MB worst case at 50k). Every exported function returns (or carries) an
 * `exhausted` bit: true means the budget ran out BEFORE the answer was
 * determined, so callers must not treat a false/partial result as definitive
 * (SPEC-0005 maps this to status `error` for re-check).
 */
import { GitStore } from "../git/store";
import { OidSet } from "../git/oidset";
import { Commit, parseCommit, parseTag } from "../git/objects";
import type { CommitJson } from "../repo";

/** Commit visits one graph walk may spend before reporting exhaustion. */
export const MERGE_BASE_MAX_VISITS = 50_000;

/** Result of a bounded graph walk. `exhausted: true` means the budget ran out
 * BEFORE the answer was determined — callers must not treat `false`/partial
 * results as definitive (SPEC-0005 maps this to status `error` for re-check). */
export interface WalkAnswer<T> {
  value: T | null; // null = not found / not determinable
  exhausted: boolean; // visit budget consumed
}

/** Walk options; tests override the budget to exercise exhaustion without
 * building a 50k-commit repository. */
export interface WalkOpts {
  maxVisits?: number;
}

/** Commit-object cache for one walk: every visited commit is read exactly once. */
export class CommitReader {
  private cache = new Map<string, Commit | null>();
  constructor(private store: GitStore) {}

  async commit(oid: string): Promise<Commit | null> {
    const hit = this.cache.get(oid);
    if (hit !== undefined) return hit;
    const obj = await this.store.get(oid);
    const c = obj?.type === "commit" ? parseCommit(obj.data) : null;
    this.cache.set(oid, c);
    return c;
  }
}

/** Ancestor verdict from one bounded closure walk. */
interface AncestorAnswer {
  found: boolean;
  exhausted: boolean;
}

/** Is `anc` reachable from `desc` over parent edges (or equal)? Bounded DFS. */
async function isAncestorOid(reader: CommitReader, anc: string, desc: string, maxVisits: number): Promise<AncestorAnswer> {
  if (anc === desc) return { found: true, exhausted: false };
  const seen = new OidSet(256);
  const stack = [desc];
  seen.addHex(desc);
  let visits = 0;
  while (stack.length) {
    if (visits++ >= maxVisits) return { found: false, exhausted: true };
    const c = await reader.commit(stack.pop()!);
    if (!c) continue;
    for (const p of c.parents) {
      if (p === anc) return { found: true, exhausted: false };
      if (seen.addHex(p)) stack.push(p);
    }
  }
  return { found: false, exhausted: false };
}

/** Full closure of `tip` over parent edges: the set plus its budget verdict. */
async function parentClosure(reader: CommitReader, tip: string, maxVisits: number): Promise<{ set: OidSet; exhausted: boolean }> {
  const set = new OidSet(256);
  const stack = [tip];
  set.addHex(tip);
  let visits = 0;
  while (stack.length) {
    if (visits++ >= maxVisits) return { set, exhausted: true };
    const c = await reader.commit(stack.pop()!);
    if (!c) continue;
    for (const p of c.parents) {
      if (set.addHex(p)) stack.push(p);
    }
  }
  return { set, exhausted: false };
}

/**
 * Best common ancestor of two commits (git merge-base semantics: none of the
 * common ancestors is an ancestor of another). `a`/`b` are refs or oids,
 * resolved like readDiff's ids (full refs — including refs/pull/* — accepted;
 * see resolveCommitish). Unrelated histories ⇒ `{ value: null,
 * exhausted: false }` — a real answer, distinct from exhaustion.
 *
 * When the paint leaves several undominated candidates (a criss-cross has
 * two), the deterministic pick among the equally-best candidates is newest
 * committer time, ties by the smaller oid — documented in the fixture README.
 */
export async function mergeBase(store: GitStore, a: string, b: string, opts: WalkOpts = {}): Promise<WalkAnswer<string>> {
  const oa = await resolveCommitish(store, a);
  const ob = await resolveCommitish(store, b);
  if (!oa || !ob) return { value: null, exhausted: false };
  if (oa === ob) return { value: oa, exhausted: false };
  const maxVisits = opts.maxVisits ?? MERGE_BASE_MAX_VISITS;
  const reader = new CommitReader(store);
  const ca = await reader.commit(oa);
  const cb = await reader.commit(ob);
  if (!ca || !cb) return { value: null, exhausted: false };

  const P1 = 1;
  const P2 = 2;
  const STALE = 4;
  const RESULT = 8;
  const flags = new Map<string, number>();
  const flagOf = (oid: string): number => flags.get(oid) ?? 0;

  // newest-committer-date frontier (git's commit_list_insert_by_date), a
  // binary heap; ties break by oid for determinism
  const heap: { oid: string; time: number; stale: boolean }[] = [];
  const less = (x: { oid: string; time: number }, y: { oid: string; time: number }): boolean =>
    x.time !== y.time ? x.time > y.time : x.oid < y.oid;
  const push = (node: { oid: string; time: number; stale: boolean }): void => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p])) {
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      } else break;
    }
  };
  const pop = (): { oid: string; time: number; stale: boolean } | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  // count of in-heap entries pushed while non-stale — git's
  // queue_has_nonstale termination test without an O(n) scan
  let nonstale = 0;
  const enqueue = (oid: string, bits: number, time: number): void => {
    const next = flagOf(oid) | bits;
    flags.set(oid, next);
    const stale = (next & STALE) !== 0;
    if (!stale) nonstale++;
    push({ oid, time, stale });
  };

  enqueue(oa, P1, ca.committer.time);
  enqueue(ob, P2, cb.committer.time);

  const commons: string[] = [];
  let visits = 0;
  let interrupted = false;
  while (heap.length > 0) {
    if (nonstale === 0) break; // everything left can only reach painted commons
    if (visits++ >= maxVisits) {
      interrupted = true;
      break;
    }
    const node = pop()!;
    if (node.stale) nonstale--;
    const f = flagOf(node.oid);
    let carry = f & (P1 | P2);
    if ((f & (P1 | P2)) === (P1 | P2)) {
      if ((f & RESULT) === 0) {
        flags.set(node.oid, f | RESULT);
        commons.push(node.oid);
      }
      // parents of a common are stale unless they gain a new side flag
      carry |= STALE;
    } else if ((f & STALE) !== 0) {
      carry |= STALE;
    }
    const c = await reader.commit(node.oid);
    if (!c) continue;
    for (const p of c.parents) {
      const pf = flagOf(p);
      if ((pf & carry) === carry) continue;
      const pc = await reader.commit(p);
      if (!pc) continue;
      enqueue(p, carry, pc.committer.time);
    }
  }

  if (!commons.length) return { value: null, exhausted: interrupted };

  // Domination filter: keep the candidates no other candidate descends from.
  // The candidate set is tiny (1 for straightline history, 2+ for criss-cross);
  // a budget-starved domination walk conservatively keeps its candidate.
  let candidates = commons;
  if (candidates.length > 1) {
    const keep: string[] = [];
    for (const c of candidates) {
      let dominated = false;
      for (const other of candidates) {
        if (other === c) continue;
        if ((await isAncestorOid(reader, c, other, maxVisits)).found) {
          dominated = true;
          break;
        }
      }
      if (!dominated) keep.push(c);
    }
    candidates = keep;
  }
  let best = candidates[0];
  let bestTime = (await reader.commit(best))?.committer.time ?? 0;
  for (const c of candidates.slice(1)) {
    const t = (await reader.commit(c))?.committer.time ?? 0;
    if (t > bestTime || (t === bestTime && c < best)) {
      best = c;
      bestTime = t;
    }
  }
  return { value: best, exhausted: interrupted };
}

/**
 * Is `anc` an ancestor of (or equal to) `desc`? Same walk budget. Accepts refs
 * or oids (resolveCommitish). `protocol.ts isAncestor` (receive's force-push
 * check) is LEFT ALONE — its boolean-with-silent-cap is correct for that
 * caller (a false negative only marks a push forced, which GC handles) and
 * vendored diffs stay minimal (SPEC-0001b §4.1).
 */
export async function isAncestorEx(store: GitStore, anc: string, desc: string, opts: WalkOpts = {}): Promise<WalkAnswer<boolean>> {
  const maxVisits = opts.maxVisits ?? MERGE_BASE_MAX_VISITS;
  const a = await resolveCommitish(store, anc);
  const d = await resolveCommitish(store, desc);
  if (!a || !d) return { value: false, exhausted: false };
  const answer = await isAncestorOid(new CommitReader(store), a, d, maxVisits);
  return { value: answer.found, exhausted: answer.exhausted && !answer.found };
}

/**
 * Commits in `head` but not `base` (range `base..head`), parents before
 * children (topological pass — the date-ordered `walkLog` frontier can invert
 * side-branch order, gitorange `rebase.ts:104-128` documents the fix), oldest
 * first, capped at `limit`; `more` when the cap truncated. `page` (0-based)
 * slices further down the same topological order. Null when `head` (or `base`)
 * does not resolve to a commit. Ties in the topological order break by oldest
 * committer time, then smaller oid (deterministic).
 */
export async function listCommitsRange(
  store: GitStore,
  base: string,
  head: string,
  limit: number,
  page = 0,
  opts: WalkOpts = {}
): Promise<{ commits: CommitJson[]; more: boolean } | null> {
  if (limit <= 0) return { commits: [], more: false };
  if (page < 0) page = 0;
  const maxVisits = opts.maxVisits ?? MERGE_BASE_MAX_VISITS;
  const baseOid = await resolveCommitish(store, base);
  const headOid = await resolveCommitish(store, head);
  if (!headOid || !baseOid) return null;

  const reader = new CommitReader(store);
  const excluded = (await parentClosure(reader, baseOid, maxVisits)).set;

  // collect the in-range set; the topological order over it is decided below
  const inRange: string[] = [];
  const inSet = new OidSet(256);
  const frontier = [headOid];
  inSet.addHex(headOid);
  let visits = 0;
  while (frontier.length) {
    if (visits++ >= maxVisits) break;
    const oid = frontier.pop()!;
    if (excluded.hasHex(oid)) continue; // head itself may sit behind base
    const c = await reader.commit(oid);
    if (!c) continue;
    inRange.push(oid);
    for (const p of c.parents) {
      if (excluded.hasHex(p)) continue;
      if (inSet.addHex(p)) frontier.push(p);
    }
  }
  if (!inRange.length) return { commits: [], more: false };

  // Kahn's algorithm over the collected subgraph: parents before children.
  // Ready set picks the smallest (committer time, oid) so the emission order
  // is oldest-first and deterministic.
  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const oid of inRange) {
    const c = (await reader.commit(oid))!;
    let n = 0;
    for (const p of c.parents) {
      if (inSet.hasHex(p)) {
        n++;
        children.set(p, [...(children.get(p) ?? []), oid]);
      }
    }
    pending.set(oid, n);
  }
  const ready: string[] = inRange.filter((oid) => pending.get(oid) === 0);
  const ordered: string[] = [];
  const timeCache = new Map<string, number>();
  const timeOf = async (oid: string): Promise<number> => {
    let t = timeCache.get(oid);
    if (t === undefined) {
      t = (await reader.commit(oid))?.committer.time ?? 0;
      timeCache.set(oid, t);
    }
    return t;
  };
  while (ready.length) {
    let bi = 0;
    let bt = await timeOf(ready[0]);
    for (let i = 1; i < ready.length; i++) {
      const t = await timeOf(ready[i]);
      if (t < bt || (t === bt && ready[i] < ready[bi])) {
        bi = i;
        bt = t;
      }
    }
    const oid = ready.splice(bi, 1)[0]!;
    ordered.push(oid);
    for (const child of children.get(oid) ?? []) {
      const n = pending.get(child) ?? 0;
      pending.set(child, n - 1);
      if (n - 1 === 0) ready.push(child);
    }
  }

  const start = page * limit;
  const pageOids = ordered.slice(start, start + limit);
  const commits: CommitJson[] = [];
  for (const oid of pageOids) {
    const c = await reader.commit(oid);
    if (!c) continue;
    commits.push({
      oid,
      tree: c.tree,
      parents: c.parents,
      author: c.author,
      committer: c.committer,
      subject: c.subject,
      message: c.message,
    });
  }
  return { commits, more: ordered.length > start + limit };
}

/**
 * `git rev-list --left-right --count base head` equivalent, one walk:
 * ahead = |base..head| (commits in head not in base), behind = |head..base|
 * (commits in base not in head). Both closures share one CommitReader; each
 * is budget-bounded, and `exhausted` is reported when either was truncated
 * (the counts are then a lower bound, not definitive).
 */
export async function countDivergence(store: GitStore, base: string, head: string, opts: WalkOpts = {}): Promise<WalkAnswer<{ ahead: number; behind: number }>> {
  const maxVisits = opts.maxVisits ?? MERGE_BASE_MAX_VISITS;
  const baseOid = await resolveCommitish(store, base);
  const headOid = await resolveCommitish(store, head);
  if (!baseOid || !headOid) return { value: null, exhausted: false };
  const reader = new CommitReader(store);
  const baseSide = await parentClosure(reader, baseOid, maxVisits);
  const headSide = await parentClosure(reader, headOid, maxVisits);
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < baseSide.set.size; i++) {
    if (!headSide.set.hasHex(baseSide.set.atHex(i))) behind++;
  }
  for (let i = 0; i < headSide.set.size; i++) {
    if (!baseSide.set.hasHex(headSide.set.atHex(i))) ahead++;
  }
  return { value: { ahead, behind }, exhausted: baseSide.exhausted || headSide.exhausted };
}

/**
 * Resolve a commit-ish the way the content methods do: `refs/heads/<h>`, then
 * `refs/tags/<h>`, then `h` verbatim (so `refs/pull/7/head` resolves), then a
 * raw 40-hex oid; the target is peeled through tag objects to a commit.
 * Unlike the UI's resolveRef there is NO reachability gate: these RPCs are
 * called by the trusted same-account Worker (SPEC-0001a §4.2's trust note),
 * and refs/pull/* must resolve by name. Pure reads (§4.6): no peeled-memo
 * writes on this path.
 */
export async function resolveCommitish(store: GitStore, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  for (const cand of [`refs/heads/${id}`, `refs/tags/${id}`, id]) {
    const oid = store.getRef(cand);
    if (oid) return peelToCommitOid(store, oid);
  }
  // a bare oid (readDiff's servable shape, minus the UI reachability gate)
  return peelToCommitOid(store, id);
}

/** Follow tag objects down to a commit (bounded, pure — no memo writes; the
 * read-only rule §4.6). Returns null for missing objects / non-tag chains. */
export async function peelToCommitOid(store: GitStore, oid: string): Promise<string | null> {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = await store.get(cur);
    if (!obj) return null;
    if (obj.type === "commit") return cur;
    if (obj.type === "tag") {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}
