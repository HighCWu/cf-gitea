/**
 * Rebase replay (SPEC-0001b §4.5) — a PARTIAL PORT of gitorange
 * `worker/src/git/rebase.ts:271-445` @ b3d5b08 (Apache-2.0), simplified for
 * Gitea parity per §3 and recorded in NOTICE.md: the retained structure is
 * the topological ordering of the own-commit set (Kahn's algorithm — the
 * breadth-first range walk can put a side branch's commit before its own
 * parent), the patch-identity skip against what `onto` gained since the merge
 * base, author/author-date/message preservation with the caller's committer,
 * and the conflict stop. DROPPED from the source: merge-commit carry-over
 * (Gitea `rebase` = plain `git rebase` flatten — merge commits contribute no
 * separate edits) and the AI-resolution trailer machinery (product-specific).
 *
 * `rebaseOnto` is read-only + in-memory (§4.6): the replayed objects come
 * back in the outcome; the caller stores them through putRebaseObjects (the
 * putApiObjects re-exposure) and lands the refs via executeMerge style
 * fast-forward-only with the §4.4 choreography.
 */
import { GitStore } from "../git/store";
import { parseCommit } from "../git/objects";
import { serializeCommit } from "../commit/serialize";
import { mergeBase, listCommitsRange, resolveCommitish } from "./graph";
import { planTreeMerge, treeChanges, memoryOverlay, splitLines, type MergeObject } from "./tree";
import { changesPatchId } from "./patchid";
import type { RebaseOntoInput, RebaseOutcome, RebasedCommit } from "./types";

/** At most this many of a branch's own commits are replayed in one rebase
 * (gitorange MAX_REBASE_COMMITS parity). */
export const MAX_REBASE_COMMITS = 100;

/** The newest commits that reached the target since the merge base, checked
 * for patch identity (gitorange MAX_UPSTREAM parity). */
const MAX_UPSTREAM = 500;

/**
 * Replay `head`'s own commits (since its merge base with `onto`) onto `onto`.
 * Each commit is a three-way tree merge (base: its parent's tree; ours: the
 * replay so far; theirs: the commit's tree) and keeps its author, author date
 * and message; the committer is the input's. Merge commits are flattened
 * (their trees are the merge of their parents from the replay's point of
 * view — a merge commit replays as the diff of its first-parent chain, like
 * `git rebase`'s flatten). Commits whose patch identity matches one that
 * reached `onto` since the merge base are skipped, as are commits whose
 * replay changes nothing. First conflict stops with the offending original
 * oid and its conflict paths. Writes nothing.
 */
export async function rebaseOnto(store: GitStore, opts: RebaseOntoInput): Promise<RebaseOutcome> {
  const maxCommits = opts.maxCommits ?? MAX_REBASE_COMMITS;
  const headOid = await resolveCommitish(store, opts.head);
  const ontoOid = await resolveCommitish(store, opts.onto);
  if (!headOid) return { tag: "invalid", reason: `head does not resolve to a commit: ${opts.head}` };
  if (!ontoOid) return { tag: "invalid", reason: `onto does not resolve to a commit: ${opts.onto}` };

  const mb = await mergeBase(store, ontoOid, headOid);
  if (mb.exhausted) return { tag: "invalid", reason: "merge-base walk exhausted" };
  if (mb.value === ontoOid) return { tag: "up_to_date" };

  // own commits, topological (parents before children), capped
  const range = await listCommitsRange(store, mb.value ?? ontoOid, headOid, maxCommits + 1);
  if (range === null) return { tag: "invalid", reason: "range walk failed" };
  if (range.commits.length > maxCommits) return { tag: "too_many", count: range.commits.length };

  // identities of what reached the target since the merge base (patch ids),
  // prefiltered by changed-path set like the source (only commits touching
  // exactly the paths one of ours touches can carry the same change)
  const own = range.commits;
  const ownChanges = new Map<string, Awaited<ReturnType<typeof treeChanges>>>();
  const ownPaths = new Set<string>();
  for (const c of own) {
    const changes = await treeChanges(store, await parentTree(store, c.oid, c.parents), c.tree);
    ownChanges.set(c.oid, changes);
    for (const ch of changes) ownPaths.add(ch.path);
  }
  const landed = new Set<string>();
  if (mb.value !== null) {
    const upstream = await listCommitsRange(store, mb.value, ontoOid, MAX_UPSTREAM);
    if (upstream !== null) {
      for (const u of upstream.commits) {
        if (u.parents.length > 1) continue; // merge commits carry no patch
        const changes = await treeChanges(store, await parentTree(store, u.oid, u.parents), u.tree);
        if (!changes.some((ch) => ownPaths.has(ch.path))) continue;
        landed.add(await changesPatchId(store, changes));
      }
    }
  }

  const objects = new Map<string, MergeObject>();
  const keep = (made: MergeObject[]): void => {
    for (const o of made) objects.set(o.oid, o);
  };

  // the replay reads through a MEMORY OVERLAY: each iteration's merged tree
  // exists only in the plan (rebaseOnto writes nothing, §4.6) but is the next
  // iteration's "ours" side
  const view = memoryOverlay(store);

  const commits: RebasedCommit[] = [];
  let skipped = 0;
  let tip = ontoOid;
  let tree = (await loadTree(store, ontoOid)) ?? "";
  for (const c of own) {
    const changes = ownChanges.get(c.oid)!;
    const id = await changesPatchId(store, changes);
    if (landed.has(id)) {
      skipped++; // the target already has this change (git's patch-id skip)
      continue;
    }
    const plan = await planTreeMerge(view, await parentTree(store, c.oid, c.parents), tree, c.tree);
    if (plan.overflow) return { tag: "invalid", reason: plan.overflow };
    if (plan.conflicts.length) {
      return { tag: "conflict", atOriginal: c.oid, conflicts: plan.conflicts, commits };
    }
    keep(plan.objects);
    for (const o of plan.objects) view.mem.set(o.oid, { type: o.type, data: o.data });
    const merged = plan.tree;
    if (merged === tree) {
      skipped++; // nothing of it is left to apply
      continue;
    }
    const commit = serializeCommit({
      tree: merged,
      parents: [tip],
      author: c.author, // author + author date preserved
      committer: opts.committer,
      message: c.message,
    });
    keep([{ oid: commit.oid, type: commit.type, data: commit.data }]);
    commits.push({ original: c.oid, rebased: commit.oid });
    tip = commit.oid;
    tree = merged;
  }
  return { tag: "rebased", headOid: tip, commits, skipped, objects: [...objects.values()] };
}

async function parentTree(store: GitStore, oid: string, parents: string[]): Promise<string | null> {
  if (!parents.length) return null;
  const obj = await store.get(parents[0]);
  return obj?.type === "commit" ? parseCommit(obj.data).tree : null;
}

async function loadTree(store: GitStore, oid: string): Promise<string | null> {
  const obj = await store.get(oid);
  return obj?.type === "commit" ? parseCommit(obj.data).tree : null;
}

/** splitLines re-export for the tests' fixtures (single definition). */
export { splitLines };
