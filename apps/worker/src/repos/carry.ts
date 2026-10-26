/**
 * Engine-cell carry — the rename/transfer half of the registry-fix wave
 * (P1, production probe 2026-10-25, docs/design/p0-evidence.md §
 * "Registry-fix production probe"). The engine's RepoCells are NAME-addressed
 * (`env.REPO.getByName("owner/repo")`), while a rename/transfer moves only the
 * D1 slug/owner_namespace: post-move requests routed at the NEW combined name
 * resolved a FRESH, EMPTY cell — the new URL served a valid-yet-empty
 * advertisement and the initial commits never followed (probe symptom 1). The
 * documented ENGINE-WAVE fix (a storage-key cell-addressing override) stays
 * open; THIS module is the Worker-side bridge that closes the user-visible
 * gap without engine changes: at rename/transfer time the OLD cell's content
 * is carried into the cell the NEW name resolves, synchronously, before the
 * mutation response returns.
 *
 * Two content classes, two channels — both existing public engine RPCs:
 *
 *   - Packs (everything that arrived by git push): the fork-replication lease
 *     (beginForkImport → listCatalogPage/adoptForkPacks → finalizeForkImport,
 *     SPEC-0001b §5.3 — the same machinery src/repos/fork-task.ts drives).
 *     Rename/transfer never change the immutable storage key, so the target's
 *     R2 keys EQUAL the source's: R2-backed packs need NO byte move (adopt's
 *     tail verification reads the same key; copying a key onto itself would
 *     stream-read it while overwriting it). sqlite-location packs rehydrate
 *     from the page's inline `packData`, exactly like the fork consumer.
 *   - Loose objects (Worker-authored API content: auto_init commits, API
 *     commits, merge/rebase objects — putApiObjects/putRebaseObjects are the
 *     ONLY loose-object writers, and each authored its objects with this
 *     package's serializeCommit/serializeTree). They are reconstructed EXACTLY
 *     from the read RPCs (readCommit → CommitJson, listTree → TreeEntryJson,
 *     readBlob → raw bytes) through the same serializers — a byte-exact round
 *     trip by construction, re-verified by putApiObjects' hashObject check on
 *     landing. The walk skips every oid the pack catalog already covers (a
 *     pack is self-contained, so a packed oid's closure needs nothing), so a
 *     fully-packed repo pays one RPC per ref and zero byte movement.
 *
 * Ordering vs D1 (RepoService.rename/acceptTransfer): the D1 batch (slug/
 * owner flip + redirect rows) lands FIRST — its UNIQUE arbitration has decided
 * the target name is this repo's, which makes the target-cell destroy safe
 * (any content at that name is this repo's own stale incarnation: a
 * rename-back cycle or a purged predecessor). The registry move (upsert new →
 * remove old) runs AFTER the carry, so the new name never advertises an empty
 * cell. A carry failure never fails the D1 mutation: the service logs loudly
 * and the degraded floor is the pre-fix behavior (new name serves empty until
 * a push; receivePack upserts heal the registry).
 *
 * Known corner (documented divergence): ANNOTATED tag objects have no raw-byte
 * read RPC (readCommit peels to the commit), so a ref whose tip is a tag
 * OBJECT cannot be reconstructed. Such refs are excluded from the carried ref
 * set with a loud console.error — a corner of a corner, since tags normally
 * arrive by push (packed tags carry through the pack channel fine).
 */

import {
  serializeCommit,
  serializeTree,
  type ApiObject,
  type CatalogPage,
  type CommitJson,
  type Person,
  type TreeEntryJson,
} from "@cf-gitea/git-engine";

import { destroyRepoDO } from "./purge";

/** Structural source surface (RepoCell RPCs, the fork-task.ts wrapping style
 *  that strips the stub's Promise-intersection types). */
export interface CarrySource {
  listRefs(): Promise<{ head: string | null; refs: { name: string; target: string; peeled?: string }[] }>;
  listCatalogPage(afterPackKey: string, limit: number): Promise<CatalogPage>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listTree(ref?: string, path?: string): Promise<{ oid: string; entries: TreeEntryJson[] } | null>;
  readBlob(ref: string | undefined, path: string): Promise<{ oid: string; mode: string; data: Uint8Array } | null>;
}

/** Structural target surface (the fork-import lease + the loose landing). */
export interface CarryTarget {
  beginForkImport(
    storageKey: string,
  ): Promise<{ tag: "ok"; storageKey: string } | { tag: "invalid"; reason: string }>;
  putApiObjects(
    objects: ApiObject[],
  ): Promise<{ tag: "ok"; stored: number } | { tag: "invalid"; reason: string } | { tag: "too_large"; limitBytes: number }>;
  adoptForkPacks(page: CatalogPage): Promise<{ tag: "ok" } | { tag: "invalid"; reason: string }>;
  finalizeForkImport(input: {
    refs: { name: string; oid: string }[];
    head: string | null;
  }): Promise<{ tag: "ok"; refsVersion: string } | { tag: "invalid"; reason: string }>;
}

/** putApiObjects' per-call byte budget (engine API_COMMIT_MAX_BYTES is 8 MiB);
 *  batch just under it so the budget's own accounting never tips a refusal. */
const PUT_BATCH_BYTES = 7 * 1024 * 1024;
/** PUT batch object-count ceiling (auto-init/API content is small-grained). */
const PUT_BATCH_OBJECTS = 500;
/** Walk budgets: the loose population is Worker-authored and small by nature.
 *  A repo that blows them is packed-history-shaped (the pack channel's job);
 *  exceeding throws → the caller logs → the rename proceeds on its D1 truth
 *  instead of hanging the mutation on an unbounded walk. */
const WALK_MAX_RPC = 400;
const WALK_MAX_OBJECTS = 2000;

function fail(stage: string, from: string, to: string, detail: string): never {
  throw new Error(`cell carry ${from} -> ${to} (${stage}): ${detail}`);
}

/** The exported walk's failure arm — `label` is the "fromEngine -> toEngine"
 *  pair, so the text is byte-identical to fail("walk", …) at the carry site. */
function failWalk(label: string, detail: string): never {
  throw new Error(`cell carry ${label} (walk): ${detail}`);
}

/** `repos/<storage_key>/packs/<packKey>.pack` — git/r2keys.ts's packR2Key (the
 *  module is engine-internal; the layout is SPEC-0001 §3's committed contract). */
function packR2Key(storageKey: string, packKey: string): string {
  return `repos/${storageKey}/packs/${packKey}.pack`;
}

/**
 * Carry the full content of the `fromEngine` cell into the `toEngine` cell
 * (which is destroyed and rebuilt first). `storageKey` is the repo's immutable
 * D1 storage key — both cells address the same R2 prefixes. Throws on failure.
 */
export async function carryRepoCell(
  env: Env,
  fromEngine: string,
  toEngine: string,
  storageKey: string,
): Promise<void> {
  if (fromEngine === toEngine) return;
  const bucket = env.REPO_PACKS;
  if (!bucket) {
    // The sqlite-pack rehydration needs the bucket; without it the carry
    // cannot guarantee content — refuse loudly (the caller logs) rather than
    // half-carry.
    fail("init", fromEngine, toEngine, "REPO_PACKS unbound");
  }
  const sourceCell = env.REPO.getByName(fromEngine);
  const targetCell = env.REPO.getByName(toEngine);
  const source: CarrySource = {
    listRefs: async () => {
      const refs = await sourceCell.listRefs();
      return { head: refs.head, refs: refs.refs.map((r) => ({ name: r.name, target: r.target, ...(r.peeled === undefined ? {} : { peeled: r.peeled }) })) };
    },
    listCatalogPage: (after, limit) => sourceCell.listCatalogPage(after, limit),
    readCommit: (id) => sourceCell.readCommit(id),
    listTree: (ref, path) => sourceCell.listTree(ref, path),
    readBlob: (ref, path) => sourceCell.readBlob(ref, path),
  };
  const target: CarryTarget = {
    beginForkImport: (key) => targetCell.beginForkImport(key),
    putApiObjects: (objects) => targetCell.putApiObjects(objects),
    adoptForkPacks: (page) => targetCell.adoptForkPacks(page),
    finalizeForkImport: (input) => targetCell.finalizeForkImport(input),
  };

  // Reset the target: a stale cell of this same repo (rename-back cycle) or a
  // purged predecessor must not refuse the import (beginForkImport's
  // not-empty / deleted refusals). D1's UNIQUE(owner, slug) already decided
  // the name is this repo's, so nothing live sits there; destroy is the
  // engine's idempotent wipe (re-initializes an empty cell).
  await destroyRepoDO(env, toEngine);

  const begin = await target.beginForkImport(storageKey);
  if (begin.tag === "invalid") fail("begin", fromEngine, toEngine, begin.reason);

  try {
    const refs = await source.listRefs();
    const carried: { name: string; oid: string }[] = [];
    const excluded: string[] = [];
    for (const ref of refs.refs) {
      if (ref.peeled !== undefined && ref.peeled !== ref.target) {
        // Annotated tag: the tag OBJECT's bytes have no read RPC. Excluding
        // the ref keeps the all-or-nothing finalize intact for everything
        // else; logged below (the pack channel carries pushed tags fine).
        excluded.push(ref.name);
        continue;
      }
      carried.push({ name: ref.name, oid: ref.target });
    }

    // 1. Pack catalog: page the source, adopt on the target. Same storage key
    // on both sides ⇒ R2-backed packs are already at the target's keys.
    const packed = new Set<string>();
    let cursor = "";
    for (;;) {
      const page = await source.listCatalogPage(cursor, 8192);
      for (const p of page.packs) {
        if (p.rowsFrom !== "") continue; // continuation slice: byte work is done
        if (p.location === "r2") {
          // The bytes (and the idx sidecar, when any) sit at the target's own
          // keys already — a self-copy would race its own overwrite.
        } else if (p.packData) {
          // sqlite-location pack: bytes rode the page (DO-local pack_data
          // rehydration) — one plain put into the (shared) R2 prefix.
          await bucket.put(packR2Key(storageKey, p.packKey), p.packData);
        } else {
          fail("packs", fromEngine, toEngine, `sqlite pack without inline bytes: ${p.packKey}`);
        }
        if (p.location !== "r2" && p.idxBytes > 0) {
          // The fork consumer copies idx sidecars parent→fork by key; with
          // equal keys an sqlite pack's in-DO idx has no R2 object to copy.
          // The shipped fork path presumes sqlite packs ship idxBytes = 0 —
          // keep that assumption loud instead of silently skipping.
          fail("packs", fromEngine, toEngine, `sqlite pack with R2 idx sidecar is not carryable: ${p.packKey}`);
        }
      }
      for (const p of page.packs) for (const row of p.rows) packed.add(row.oid);
      const adopted = await target.adoptForkPacks(page);
      if (adopted.tag === "invalid") fail("packs", fromEngine, toEngine, adopted.reason);
      cursor = page.nextAfter;
      if (!page.more) break;
    }

    // 2. Loose objects: reconstruct the Worker-authored content the pack
    // catalog does not cover (exact serialize round trip; putApiObjects
    // re-verifies every oid on landing).
    await carryLooseObjects(source, target, carried, packed, `${fromEngine} -> ${toEngine}`);

    // 3. One finalizing transaction: catalog rows landed during adopt; refs +
    // HEAD + refs_version land now and the importing gate clears. HEAD must
    // name a carried ref (the engine validates); an annotated-tag HEAD falls
    // back to null (the engine's unborn-HEAD convention).
    const head = refs.head !== null && carried.some((r) => r.name === refs.head) ? refs.head : null;
    const fin = await target.finalizeForkImport({ refs: carried, head });
    if (fin.tag === "invalid") fail("finalize", fromEngine, toEngine, fin.reason);
    if (excluded.length > 0) {
      console.error(
        `[repos] cell carry ${fromEngine} -> ${toEngine}: annotated-tag refs not carried (no raw-byte read RPC): ${excluded.join(", ")}`,
      );
    }
  } catch (error) {
    // Never leave the target importing-gated: beginForkImport only re-begins
    // while importing, so a half-carried cell would 503 every later push at
    // the new name forever. Destroy the partial state — the degraded floor is
    // the pre-fix fresh-empty cell, and the delete purge owns the lifecycle.
    try {
      await destroyRepoDO(env, toEngine);
    } catch {
      // the purge's destroy covers it later; nothing else to do
    }
    throw error;
  }
}

/**
 * The loose-object completion walk: reconstruct, from the carried refs' tips,
 * every object the pack catalog does not already cover. Commits walk by
 * parent chain; each unpacked commit's trees walk by path; blobs fetch once
 * per unique oid. Objects batch into putApiObjects under the engine's
 * per-call budget. Exported for the fork/generate copy pass
 * (src/repos/fork-task.ts), which must land the same Worker-authored loose
 * class (auto_init commits, API commits — REDEPLOY12's generate 500: the
 * template's ref tips live outside the pack catalog its loop replicates).
 * `label` names the from → to pair in error text.
 */
export async function carryLooseObjects(
  source: CarrySource,
  target: Pick<CarryTarget, "putApiObjects">,
  carried: { name: string; oid: string }[],
  packed: Set<string>,
  label: string,
): Promise<void> {
  let rpcs = 0;
  let objects = 0;
  const spend = () => {
    if (++rpcs > WALK_MAX_RPC) failWalk(label, "RPC budget exceeded");
  };
  const pending = new Map<string, ApiObject>();
  let batchBytes = 0;
  const flush = async () => {
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    batchBytes = 0;
    const put = await target.putApiObjects(batch);
    if (put.tag !== "ok") {
      failWalk(label, `putApiObjects refused (${put.tag}): ${put.tag === "invalid" ? put.reason : `limit ${put.limitBytes}`}`);
    }
  };
  const stage = async (object: ApiObject) => {
    if (packed.has(object.oid) || pending.has(object.oid)) return;
    if (++objects > WALK_MAX_OBJECTS) failWalk(label, "object budget exceeded");
    pending.set(object.oid, object);
    batchBytes += object.data.byteLength;
    if (batchBytes >= PUT_BATCH_BYTES || pending.size >= PUT_BATCH_OBJECTS) await flush();
  };

  const commits = new Set<string>();
  const trees = new Set<string>();
  const entrySpec = (e: TreeEntryJson) => ({ mode: e.mode, name: e.name, oid: e.oid });
  const childPath = (path: string, name: string) => (path === "" ? name : `${path}/${name}`);

  const walkTree = async (commitOid: string, path: string, entries: TreeEntryJson[]): Promise<void> => {
    for (const entry of entries) {
      if (entry.type === "commit") continue; // submodule/gitlink: outside this store
      if (entry.type === "tree") {
        if (packed.has(entry.oid) || trees.has(entry.oid)) continue;
        trees.add(entry.oid);
        spend();
        const sub = await source.listTree(commitOid, childPath(path, entry.name));
        if (sub === null) failWalk(label, `subtree unreadable: ${childPath(path, entry.name)}`);
        await stage({ oid: entry.oid, type: "tree", data: serializeTree(sub.entries.map(entrySpec)).data });
        await walkTree(commitOid, childPath(path, entry.name), sub.entries);
        continue;
      }
      if (packed.has(entry.oid)) continue; // packed blob: the pack channel carries it
      spend();
      const blob = await source.readBlob(commitOid, childPath(path, entry.name));
      if (blob === null) failWalk(label, `blob unreadable: ${childPath(path, entry.name)}`);
      await stage({ oid: blob.oid, type: "blob", data: blob.data });
    }
  };

  const walkCommit = async (oid: string): Promise<void> => {
    if (commits.has(oid) || packed.has(oid)) return; // packed commit ⇒ packed closure
    commits.add(oid);
    spend();
    const commit = await source.readCommit(oid);
    if (commit === null) failWalk(label, `commit unreadable: ${oid}`);
    await stage(commitObject(commit));
    if (!packed.has(commit.tree)) {
      // root packed ⇒ whole tree closure packed (walk nothing)
      trees.add(commit.tree);
      spend();
      const root = await source.listTree(oid, "");
      if (root === null) failWalk(label, `root tree unreadable for ${oid}`);
      await stage({ oid: commit.tree, type: "tree", data: serializeTree(root.entries.map(entrySpec)).data });
      await walkTree(oid, "", root.entries);
    }
    for (const parent of commit.parents) await walkCommit(parent);
  };

  for (const ref of carried) await walkCommit(ref.oid);
  await flush();
}

/** CommitJson → canonical commit bytes: the exact serializeCommit round trip
 *  every loose commit was authored with (personLine fields survive verbatim). */
function commitObject(commit: CommitJson): ApiObject {
  const person = (p: Person): Person => ({ name: p.name, email: p.email, time: p.time, tz: p.tz });
  return {
    oid: commit.oid,
    type: "commit",
    data: serializeCommit({
      tree: commit.tree,
      parents: commit.parents,
      author: person(commit.author),
      committer: person(commit.committer),
      message: commit.message,
    }).data,
  };
}
