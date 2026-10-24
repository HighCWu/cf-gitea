/**
 * Three-way tree merge (SPEC-0001b §4.2) — a STRUCTURAL PORT of gitorange
 * `worker/src/git/service.ts` `mergeTrees` (391-443) + `mergeFile` (446-498)
 * @ b3d5b08 (Apache-2.0), recorded in NOTICE.md per NOTICE category 3.
 *   Changes from the source (Gitea-parity and split-plane deltas): the store
 *   is the engine's GitStore (async `store.get`) instead of the Artifacts
 *   client; the line merge is our Myers-based diff3 (src/merge/diff3.ts)
 *   instead of the node-diff3 npm package; conflicts carry a typed `kind`
 *   (content/delete_edit/add_add_binary/mode/file_dir/too_large) the source's
 *   string list did not; competing mode changes are a `mode` conflict (the
 *   source silently kept ours'); caps are enforced as a hard `overflow` stop
 *   (MAX_MERGE_FILES changed paths) or per-file `too_large` conflicts
 *   (MAX_MERGE_FILE_BYTES, the source's 1 MiB gate) instead of throwing.
 *   Deliberate divergence from git merge-recursive (documented §4.2): no
 *   rename detection — a renamed file is delete+add.
 *
 * planTreeMerge WRITES NOTHING: the MergePlan's candidate objects stay in
 * memory; the caller decides to store them (executeMerge) or discard them
 * (checkMergeability) per the §4.6 read-only rule.
 */
import { ObjType, parseTree, isTreeMode, isGitlinkMode, TreeEntry, hashObject } from "../git/objects";
import { isBinary, diffLines } from "../git/diff";
import { emptyTree, serializeTree, EMPTY_TREE_OID } from "../commit/serialize";
import { diff3FromOps, toRegions } from "./diff3";

/** Text merge limits; larger or binary files stay conflicts (gitorange
 * parity, service.ts:56: MAX_MERGE_BYTES = 1 MiB). */
export const MAX_MERGE_FILE_BYTES = 1024 * 1024;

/** Changed-path cap: a merge touching more paths than this is an error, not
 * a conflict (§4.2 — the plan reports `overflow`). */
export const MAX_MERGE_FILES = 20_000;

/** Test overrides for the caps (fixture-reachable without 20k-path repos). */
export interface MergeCaps {
  maxFiles?: number;
  maxFileBytes?: number;
}

/** Conflicting path record (mirrors what the API's conflicted_files needs). */
export interface MergeConflictPath {
  path: string;
  kind: "content" | "delete_edit" | "add_add_binary" | "mode" | "file_dir" | "too_large";
}

/** One object the merge derived; the caller stores these (content-addressed,
 * so a lost CAS leaves ordinary unreferenced loose objects for the sweep). */
export interface MergeObject {
  oid: string;
  type: ObjType;
  data: Uint8Array;
}

/** In-memory candidates produced by a three-way merge. WRITES NOTHING — the
 * caller decides to store (executeMerge) or discard (checkMergeability).
 * `tree` is "" only when `overflow` is set (no plan exists). */
export interface MergePlan {
  /** root tree of the merge result; the canonical empty-tree sha when every
   * path resolved to deletion */
  tree: string;
  /** new blobs/trees to store (deduped by oid) — empty for clean fast cases */
  objects: MergeObject[];
  conflicts: MergeConflictPath[];
  /** hard stop: changed-path cap or diff budget blown — not a conflict, an error */
  overflow: string | null;
}

/** A changed path between two trees (also the patch-identity input, §3). */
export interface TreeChange {
  path: string;
  status: "added" | "removed" | "modified";
  old: { oid: string; mode: string } | null;
  new: { oid: string; mode: string } | null;
}

const isRegularFile = (mode: string): boolean => mode === "100644" || mode === "100755";

/** The only store surface the merge algorithms need (GitStore satisfies it
 * structurally; the rebase replay passes a memory overlay so its unstored
 * intermediate trees read back without any durable write, §4.6). */
export interface ObjectReads {
  get(oid: string): Promise<{ type: ObjType; data: Uint8Array } | null>;
}

/** In-memory overlay over a store: reads hit the overlay first. */
export function memoryOverlay(
  store: ObjectReads,
  mem: Map<string, { type: ObjType; data: Uint8Array }> = new Map()
): ObjectReads & { mem: Map<string, { type: ObjType; data: Uint8Array }> } {
  return {
    mem,
    get: async (oid: string) => mem.get(oid) ?? (await store.get(oid)),
  };
}

async function readTree(store: ObjectReads, oid: string | null): Promise<TreeEntry[]> {
  if (oid === null) return [];
  const obj = await store.get(oid);
  return obj?.type === "tree" ? parseTree(obj.data) : [];
}

/**
 * Flat path → (oid, mode) map of every non-gitlink leaf under a tree — the
 * computeDiff shape (repo.ts flattenTree), used by the patch-identity path
 * and the tests' oracle comparisons. Gitlinks are skipped (they are refs, not
 * content this engine can diff).
 */
export async function flattenTree(
  store: ObjectReads,
  treeOid: string | null,
  prefix = "",
  out: Map<string, { oid: string; mode: string }> = new Map()
): Promise<Map<string, { oid: string; mode: string }>> {
  for (const e of await readTree(store, treeOid)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (isTreeMode(e.mode)) await flattenTree(store, e.oid, p, out);
    else if (!isGitlinkMode(e.mode)) out.set(p, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/**
 * Tree-scope change list between two root trees (null = absent), recursive,
 * status-tracked — the patchid/rebase input and the tests' oracle shape.
 */
export async function treeChanges(store: ObjectReads, oldTree: string | null, newTree: string | null): Promise<TreeChange[]> {
  const a = await flattenTree(store, oldTree);
  const b = await flattenTree(store, newTree);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: TreeChange[] = [];
  for (const p of paths) {
    const o = a.get(p) ?? null;
    const n = b.get(p) ?? null;
    if (o && n && o.oid === n.oid && o.mode === n.mode) continue;
    out.push({
      path: p,
      status: !o ? "added" : !n ? "removed" : "modified",
      old: o,
      new: n,
    });
  }
  return out;
}

/**
 * Three-way merge of root trees. base/ours/theirs are tree oids (null =
 * absent, e.g. root commits or delete side). Caps: MAX_MERGE_FILES = 20_000
 * changed paths, MAX_MERGE_FILE_BYTES = 1 MiB per file content merge
 * (gitorange parity, service.ts:56), diff budgets inherited from diff.ts
 * (null ⇒ conflict). See the module header for the port attribution.
 */
export async function planTreeMerge(
  store: ObjectReads,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  caps: MergeCaps = {}
): Promise<MergePlan> {
  const maxFiles = caps.maxFiles ?? MAX_MERGE_FILES;
  const maxFileBytes = caps.maxFileBytes ?? MAX_MERGE_FILE_BYTES;
  const state = {
    objects: new Map<string, MergeObject>(),
    conflicts: [] as MergeConflictPath[],
    changedPaths: 0,
    overflow: null as string | null,
  };

  const keep = (o: MergeObject): void => {
    state.objects.set(o.oid, o);
  };

  /**
   * The recursive reconciliation. Returns the merged subtree oid; null means
   * the subtree resolved to empty, which DELETES the entry (a tree that
   * becomes empty disappears — git semantics). Overflow returns null with
   * state.overflow set (checked at every level).
   */
  const mergeTrees = async (base: string | null, ours: string | null, theirs: string | null, prefix: string): Promise<string | null> => {
    if (state.overflow) return null;
    if (ours === theirs) return ours;
    if (base === ours) return theirs;
    if (base === theirs) return ours;

    const [b, o, t] = await Promise.all([readTree(store, base), readTree(store, ours), readTree(store, theirs)]);
    const bm = new Map(b.map((e) => [e.name, e]));
    const om = new Map(o.map((e) => [e.name, e]));
    const tm = new Map(t.map((e) => [e.name, e]));
    const result: TreeEntry[] = [];
    for (const name of new Set([...bm.keys(), ...om.keys(), ...tm.keys()])) {
      if (state.overflow) return null;
      const be = bm.get(name);
      const oe = om.get(name);
      const te = tm.get(name);
      const path = prefix ? `${prefix}/${name}` : name;
      const same = (x?: TreeEntry, y?: TreeEntry): boolean =>
        (!x && !y) || (!!x && !!y && x.oid === y.oid && x.mode === y.mode);
      let pick: TreeEntry | undefined;
      if (same(oe, te)) pick = oe;
      else if (same(be, oe)) pick = te;
      else if (same(be, te)) pick = oe;
      else if ((!oe || isTreeMode(oe.mode)) && (!te || isTreeMode(te.mode)) && (oe || te)) {
        // all present sides at this name are trees (or absent): recurse. A
        // blob base under two trees (file → dir on both sides) recurses with
        // base null — both sides replaced the file by a directory.
        const merged = await mergeTrees(be && isTreeMode(be.mode) ? be.oid : null, oe?.oid ?? null, te?.oid ?? null, path);
        if (merged) result.push({ name, mode: "40000", oid: merged });
        continue;
      } else {
        const merged = await mergeFile(path, be, oe, te);
        if (merged) result.push({ name, mode: merged.mode, oid: merged.oid });
        continue;
      }
      if (pick && !same(be, pick)) {
        state.changedPaths++;
        if (state.changedPaths > maxFiles) {
          state.overflow = `merge touches more than ${maxFiles} changed paths`;
          return null;
        }
        result.push({ name: pick.name, mode: pick.mode, oid: pick.oid });
      } else if (pick) {
        result.push({ name: pick.name, mode: pick.mode, oid: pick.oid });
      }
    }
    if (!result.length) return null;
    const made = serializeTree(result);
    keep(made);
    return made.oid;
  };

  /**
   * A file both sides changed: a clean line merge, or a conflict with its
   * kind. Both sides must be regular files (the base is optional — add/add);
   * symlinks and gitlinks compare by oid — one-sided picks were already taken
   * above, so reaching here with one means both sides changed it.
   */
  const mergeFile = async (
    path: string,
    be: TreeEntry | undefined,
    oe: TreeEntry | undefined,
    te: TreeEntry | undefined
  ): Promise<{ mode: string; oid: string } | null> => {
    state.changedPaths++;
    if (state.changedPaths > maxFiles) {
      state.overflow = `merge touches more than ${maxFiles} changed paths`;
      return null;
    }
    // file/dir and file/symlink clashes at one name
    if ((oe && isTreeMode(oe.mode) && te && !isTreeMode(te.mode)) || (te && isTreeMode(te.mode) && oe && !isTreeMode(oe.mode))) {
      state.conflicts.push({ path, kind: "file_dir" });
      return null;
    }
    if (!isRegularFile(oe?.mode ?? "") || !isRegularFile(te?.mode ?? "")) {
      // delete/edit: one side removed (or is a symlink/gitlink) while the
      // other changed; or both-changed symlink/gitlink (compared by oid —
      // one-sided picks never reach here). Two both-non-file sides are a
      // plain content conflict.
      const bothSpecial =
        !!oe && !!te && !isRegularFile(oe.mode) && !isRegularFile(te.mode) && !isTreeMode(oe.mode) && !isTreeMode(te.mode);
      state.conflicts.push({ path, kind: bothSpecial ? "content" : "delete_edit" });
      return null;
    }
    if (be && !isRegularFile(be.mode)) {
      // base was a tree/symlink/gitlink and both sides made regular files
      state.conflicts.push({ path, kind: "content" });
      return null;
    }
    // competing mode changes are a conflict (both changed the mode, to
    // different values — the source kept ours' silently; §4.2 classifies it)
    if (be && oe && te && be.mode !== oe.mode && be.mode !== te.mode && oe.mode !== te.mode) {
      state.conflicts.push({ path, kind: "mode" });
      return null;
    }
    const [bb, ob, tb] = await Promise.all([
      be ? store.get(be.oid) : Promise.resolve(null),
      store.get(oe!.oid),
      store.get(te!.oid),
    ]);
    const bData = bb?.type === "blob" ? bb.data : new Uint8Array(0);
    const oData = ob?.type === "blob" ? ob.data : null;
    const tData = tb?.type === "blob" ? tb.data : null;
    if (!oData || !tData) {
      state.conflicts.push({ path, kind: "content" });
      return null;
    }
    if (isBinary(bData) || isBinary(oData) || isBinary(tData)) {
      state.conflicts.push({ path, kind: be ? "content" : "add_add_binary" });
      return null;
    }
    if (bData.length > maxFileBytes || oData.length > maxFileBytes || tData.length > maxFileBytes) {
      state.conflicts.push({ path, kind: "too_large" });
      return null;
    }
    const oursText = td(oData);
    const theirsText = td(tData);
    const baseText = td(bData);
    const oursOps = diffLines(baseText, oursText);
    const theirsOps = diffLines(baseText, theirsText);
    if (oursOps === null || theirsOps === null) {
      // diff budget blown ⇒ conflict, never a partial line merge (§4.2)
      state.conflicts.push({ path, kind: "too_large" });
      return null;
    }
    const baseLines = splitLines(baseText);
    const merged = diff3FromOps(
      baseLines,
      toRegions(baseLines, splitLines(oursText), oursOps),
      toRegions(baseLines, splitLines(theirsText), theirsOps),
      { ours: "ours", theirs: "theirs" }
    );
    if (merged.conflict) {
      state.conflicts.push({ path, kind: "content" });
      return null;
    }
    // Trailing-newline convention: ours' when it has content or changed the
    // file, theirs' when ours is empty (add/add onto an empty file). Real git
    // files end in a newline — the fixture oracles hold exactly.
    const trailing = oursText !== "" ? oursText.endsWith("\n") : theirsText.endsWith("\n");
    const text = merged.lines.length ? merged.lines.join("\n") + (trailing ? "\n" : "") : "";
    const blob: MergeObject = { oid: hashObject("blob", enc.encode(text)), type: "blob", data: enc.encode(text) };
    keep(blob);
    // one-sided mode change wins (be && ours kept base's mode ⇒ theirs' mode)
    const outMode = be && oe && te && oe.mode === be.mode ? te.mode : oe!.mode;
    return { mode: outMode, oid: blob.oid };
  };

  let tree = await mergeTrees(base, ours, theirs, "");
  if (state.overflow) tree = null;
  // an all-deleted merge points at the canonical empty tree — serialize it
  // once so the landing has the object (asserted == EMPTY_TREE_OID in fixtures)
  if (tree === null && !state.overflow) {
    const empty = emptyTree();
    keep(empty);
    tree = empty.oid;
  }
  return {
    tree: tree ?? "",
    objects: [...state.objects.values()],
    conflicts: state.conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    overflow: state.overflow,
  };
}

/** Split file text into lines WITHOUT the trailing empty element (the
 * trailing newline is tracked separately by the caller). */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const enc = new TextEncoder();

function td(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
