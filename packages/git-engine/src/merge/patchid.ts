/**
 * Patch identity for rebase skip decisions (SPEC-0001b §3/§4.5): a re-
 * implementation of `git patch-id` semantics — a SHA-1 over each changed
 * path's name, status and mode plus its added/removed lines (indentation
 * kept, inner whitespace runs collapsed, trailing whitespace dropped), so the
 * same change made at another place in a file — or next to different lines —
 * carries the same identity. Binary, submodule and over-cap changes count by
 * their blob ids instead.
 *
 * Fresh port of the algorithm (~60 LOC) with attribution per SPEC-0001b §3:
 * gitorange `worker/src/git/patch-id.ts:22-70` (changesPatchId), which is
 * itself a re-implementation of `git patch-id`. Changes from the source: the
 * line diff comes from the engine's Myers core (git/diff.ts) instead of the
 * `diff` npm package, and the changed-path list comes from treeChanges
 * (src/merge/tree.ts) instead of GitService.diffTrees.
 */
import { te, sha1hex } from "../git/util";
import { diffLines } from "../git/diff";
import { isGitlinkMode } from "../git/objects";
import type { TreeChange, ObjectReads } from "./tree";

/** Above this (both sides together) a file's change counts by its blob ids. */
const MAX_PATCH_BYTES = 1024 * 1024;

/** A changed line as identity sees it: indentation kept, inner whitespace
 * runs as one space, no trailing whitespace. */
function normalize(line: string): string {
  const kept = line.trimEnd(); // a whitespace-only line counts as empty
  const indent = /^\s*/.exec(kept)![0];
  return indent + kept.slice(indent.length).replace(/\s+/g, " ");
}

function isBinaryData(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

/** The patch identity of one tree-scope change list (order-independent). */
export async function changesPatchId(store: ObjectReads, changes: TreeChange[]): Promise<string> {
  const parts: string[] = [];
  for (const ch of [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    parts.push(`${ch.status} ${ch.new?.mode ?? ch.old?.mode ?? ""} ${ch.path}`);
    if (ch.old && isGitlinkMode(ch.old.mode)) {
      parts.push(`${ch.old.oid} ${ch.new?.oid ?? ""}`);
      continue;
    }
    const a = ch.old ? await store.get(ch.old.oid) : null;
    const b = ch.new ? await store.get(ch.new.oid) : null;
    const aData = a?.type === "blob" ? a.data : null;
    const bData = b?.type === "blob" ? b.data : null;
    const size = (aData?.length ?? 0) + (bData?.length ?? 0);
    if (size > MAX_PATCH_BYTES || (aData && isBinaryData(aData)) || (bData && isBinaryData(bData))) {
      parts.push(`${ch.old?.oid ?? ""} ${ch.new?.oid ?? ""}`);
      continue;
    }
    const ops = diffLines(aData ? td(aData) : "", bData ? td(bData) : "");
    if (ops === null) {
      // Myers overflow (40k+ lines): fall back to blob ids like a huge change
      parts.push(`${ch.old?.oid ?? ""} ${ch.new?.oid ?? ""}`);
      continue;
    }
    for (const op of ops) {
      if (op.tag === "add") parts.push(`+${normalize(op.line)}`);
      else if (op.tag === "del") parts.push(`-${normalize(op.line)}`);
    }
  }
  return sha1Hex(parts.join("\n"));
}

function td(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function sha1Hex(text: string): string {
  return sha1hex(te.encode(text));
}
