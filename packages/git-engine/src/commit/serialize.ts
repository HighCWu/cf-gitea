/**
 * Git object serializers — the write side of hashObject/parseTree/parseCommit
 * (SPEC-0001a §4: "upstream lacks tree/commit/tag serializers ... a
 * src/commit/serialize.ts module: entries→sorted tree bytes, commit/tag
 * serialization"). Consumers: the API commit builder (putApiObjects/
 * commitApiChange) and the merge/rebase landing (SPEC-0001b §4.4/§4.5), which
 * construct commits without a push.
 *
 * Everything here is pure: bytes in, canonical bytes + oid out. The tree sort
 * is git's canonical ordering — entries compared by name with directories
 * treated as `name + "/"` (byte-wise on the UTF-8 encoding) — asserted against
 * real `git mktree` output by the merge check fixtures (e2e/check-merge-tree.mjs).
 */
import { te, concat, sha1hex, fromHex } from "../git/util";
import { hashObject, isTreeMode, type ObjType, type Person, type TreeEntry } from "../git/objects";

/** A tree entry as the serializer accepts it. Mode "040000" is normalized to
 * the canonical "40000"; oids are lowercase hex. */
export type SerializeTreeEntry = Pick<TreeEntry, "mode" | "name" | "oid">;

/** Byte-wise comparison of the sort key (directories count as name + "/"). */
function compareEntries(a: SerializeTreeEntry, b: SerializeTreeEntry): number {
  const ka = te.encode(sortKey(a));
  const kb = te.encode(sortKey(b));
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return ka.length - kb.length;
}

function sortKey(e: SerializeTreeEntry): string {
  return isTreeMode(e.mode) ? `${e.name}/` : e.name;
}

/** Canonical tree bytes: `<mode> <name>\0<20 raw oid bytes>` per sorted entry. */
export function serializeTree(entries: SerializeTreeEntry[]): { oid: string; type: ObjType; data: Uint8Array } {
  const sorted = [...entries].sort(compareEntries);
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    const mode = isTreeMode(e.mode) ? "40000" : e.mode;
    if (!/^(100644|100755|120000|160000|40000|040000)$/.test(mode) || !/^[0-9a-f]{40}$/.test(e.oid)) {
      throw new Error(`serializeTree: malformed entry ${mode} ${e.name}`);
    }
    parts.push(te.encode(`${mode} ${e.name}\0`), fromHex(e.oid));
  }
  return finish("tree", concat(parts));
}

export interface CommitSpec {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  /** Full commit message. A missing trailing newline is added (git convention). */
  message: string;
}

export function serializeCommit(spec: CommitSpec): { oid: string; type: ObjType; data: Uint8Array } {
  if (!/^[0-9a-f]{40}$/.test(spec.tree)) throw new Error("serializeCommit: malformed tree oid");
  for (const p of spec.parents) {
    if (!/^[0-9a-f]{40}$/.test(p)) throw new Error("serializeCommit: malformed parent oid");
  }
  const lines: string[] = [`tree ${spec.tree}`];
  for (const p of spec.parents) lines.push(`parent ${p}`);
  lines.push(`author ${personLine(spec.author)}`);
  lines.push(`committer ${personLine(spec.committer)}`);
  const message = spec.message.endsWith("\n") || spec.message === "" ? spec.message : `${spec.message}\n`;
  return finish("commit", concat([te.encode(lines.join("\n")), te.encode("\n\n"), te.encode(message)]));
}

export interface TagSpec {
  object: string;
  type: ObjType;
  tag: string;
  tagger: Person | null;
  message: string;
}

export function serializeTag(spec: TagSpec): { oid: string; type: ObjType; data: Uint8Array } {
  if (!/^[0-9a-f]{40}$/.test(spec.object)) throw new Error("serializeTag: malformed object oid");
  const lines: string[] = [`object ${spec.object}`, `type ${spec.type}`, `tag ${spec.tag}`];
  if (spec.tagger) lines.push(`tagger ${personLine(spec.tagger)}`);
  const message = spec.message.endsWith("\n") || spec.message === "" ? spec.message : `${spec.message}\n`;
  return finish("tag", concat([te.encode(lines.join("\n")), te.encode("\n\n"), te.encode(message)]));
}

/** `Name <email> 1234567890 +0100` — the parsePerson input format, verbatim. */
export function personLine(p: Person): string {
  return `${p.name} <${p.email}> ${p.time} ${p.tz}`;
}

/** The canonical empty tree — constant across all git repositories. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Convenience constructor for the shared empty tree. */
export function emptyTree(): { oid: string; type: ObjType; data: Uint8Array } {
  return serializeTree([]);
}

function finish(type: ObjType, data: Uint8Array): { oid: string; type: ObjType; data: Uint8Array } {
  return { oid: hashObject(type, data), type, data };
}

/** The engine's one-shot SHA-1 over object bytes, re-exported for callers that
 * pre-compute oids Worker-side (putApiObjects re-verifies with this). */
export function hashObjectOid(type: ObjType, data: Uint8Array): string {
  return sha1hex(concat([te.encode(`${type} ${data.length}\0`), data]));
}
