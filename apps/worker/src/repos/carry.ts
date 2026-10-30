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
 *     For a CODE cell, rename/transfer never change the immutable storage
 *     key, so the target's R2 keys EQUAL the source's: R2-backed packs need
 *     NO byte move (adopt's tail verification reads the same key; copying a
 *     key onto itself would stream-read it while overwriting it).
 *     sqlite-location packs rehydrate from the page's inline `packData`,
 *     exactly like the fork consumer.
 *
 * WIKI SIBLING (the wiki-git landing's carry follow-up, specs/wiki.md): the
 * `*.wiki` pair (service.ts moveEngineCell passes the derived names WITH THE
 * PARENT'S D1 storage key) is the one case where the same-key assumption is
 * FALSE. The wiki twin (git-http) forwards pushes with NO x-storage-key, so a
 * wiki cell that received git pushes persists its own COMBINED NAME as the
 * storage key (control-plane.ts resolveStorageKey's meta.repo fallback) and
 * stages its packs NAME-ADDRESSED at `repos/<owner>/<slug>.wiki/` — never the
 * parent's `r_<id>` namespace. The target sibling cannot keep ITS name either:
 * the import lease's beginForkImport validates slash-free keys only (the
 * engine's isValidStorageKey), so the wiki arm re-keys the target onto
 * wikiCarryStorageKey (`<parent key>.wiki` — slash-free, unique and immutable
 * through every rename, collision-free against both other key classes) and
 * BYTE-MOVES every pack (and idx sidecar) from the source cell's prefixes
 * before the page's adopt (copy-before-stage — adopt's tail verification
 * reads the target's keys). Source candidates, in order: the carried key
 * (this wiki was itself carried before — its persisted meta.storage_key) then
 * the name-addressed prefix its pushes staged at; a candidate EQUAL to the
 * destination (rename-back) is skipped — the bytes already sit at the target's
 * key. Loose objects + refs ride the unchanged exact-reconstruction channel
 * (a wiki is small-grained Worker/git content), and the old prefixes stay
 * until the delete purge reclaims them (purge.ts's wiki R2 arms), exactly
 * like a code cell's shared prefix outlives its tombstoned old cell.
 *   - Loose objects (Worker-authored API content: auto_init commits, API
 *     commits, merge/rebase objects — putApiObjects/putRebaseObjects are the
 *     ONLY loose-object writers, and each authored its objects with this
 *     package's serializeCommit/serializeTree). They are reconstructed EXACTLY
 *     from the read RPCs (readCommit → CommitJson, listTree → TreeEntryJson,
 *     readBlob → raw bytes) through the same serializers — a byte-exact round
 *     trip by construction, re-verified by putApiObjects' hashObject check on
 *     landing.
 *
 * CROSS-STORE EDGES (REDEPLOY13, the generated-repo git-wire residual): a
 * stored pack is NOT closed under its objects' references. A push stacked on
 * Worker-authored content sends only closure(new tips) − closure(advertised
 * tips), so the pack's commit PARENT lines and tree ENTRIES legally name
 * objects that stay LOOSE in the source (the delta-base column base_oid is
 * the recorded third edge class, also resolvable loose). "A packed oid's
 * closure needs nothing" is therefore FALSE, and a walk that skips packed
 * oids outright strands the loose interior — the generated cell then serves
 * API reads (tip-resolution only) while the wire dies: uploadPack's walk
 * throws `missing object` on the absent parent, and a later push's
 * anti-check cannot resolve advertised-closure objects. The walk below
 * descends THROUGH packed commits (read-only: the fork already holds their
 * bytes; the read exists only to follow parent edges) until the loose class
 * is reached, bounded by PACKED_WALK_MAX_COMMITS. Two soundness notes:
 *   - every loose object is authored by a LOOSE commit (the putApiObjects
 *     writers always land one), so the loose class is fully reachable from
 *     (loose commits' trees) ∪ (packed commits' loose trees); a packed
 *     SUBTREE can be skipped because any loose object under it hangs just as
 *     legally under its authoring loose commit's tree, which the parent-chain
 *     descent reaches;
 *   - the descent's budget is a documented fidelity limit, not a correctness
 *     bar: a history deeper than PACKED_WALK_MAX_COMMITS above its loose
 *     objects truncates the descent (flagged to the caller, which logs
 *     loudly) and the copy lands with the pre-REDEPLOY13 floor for that
 *     closure — while a fully packed history (no loose anywhere) pays the
 *     small bounded read cost and truncates harmlessly.
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
 * Annotated-tag refs (the refs row's peel column set) carry in two classes:
 *
 *   - PACKED tag tips carry as plain refs — the adopted packs bring the tag
 *     object's true bytes and finalize re-peels from them (byte-identical).
 *   - LOOSE tag tips (Worker-authored: the tags API route is the ONLY loose
 *     tag writer — serializeTag → putApiObjects, always `object <commit>
 *     type commit`) are RE-MATERIALIZED Worker-side through the same
 *     serializeTag: `tag` from the ref name, `object`/`type` from the
 *     byte-true (peeled, commit) pair. `tagger`/`message` are unrecoverable
 *     here (the carry materializes a fresh minimal tag object — readTag
 *     EXISTS since P3-11 for reads, but this write path does not consult
 *     it) — so the materialized tag carries neither (canonical git allows
 *     both absent; the WIRE renders them correctly via the tags service's
 *     readTagData over the ORIGINAL object, services/tags.ts). FIDELITY
 *     LIMIT: the materialized oid
 *     differs from the source's tag oid whenever the original carried a
 *     tagger line or message (the API path always does); the carried tag has
 *     the same name and peels to the SAME commit, while pushed/packed tags
 *     stay byte-identical. A loose tag→tag chain is not producible by any
 *     current surface (the tags API resolves targets through the peel);
 *     should one appear, the same materialization still peels to the same
 *     final commit.
 */

import {
  copyObject,
  serializeCommit,
  serializeTag,
  serializeTree,
  type ApiObject,
  type CatalogPage,
  type CommitJson,
  type Person,
  type TreeEntryJson,
} from "@cf-gitea/git-engine";

import { destroyRepoDO, wikiCarryStorageKey } from "./purge";

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
/** The cross-store descent's own budget (packed-commit readCommit RPCs — see
 *  the module doc's CROSS-STORE EDGES note). Deliberately small: the wire
 *  shapes this fixes are pushes stacked a few commits above Worker-authored
 *  content, and exhaustion must stay cheap because the common fully-packed
 *  history burns the whole budget finding that out. Exhaustion does NOT
 *  throw — a deep packed history must keep forking; the caller gets the
 *  `truncated` flag and logs. */
const PACKED_WALK_MAX_COMMITS = 64;

function fail(stage: string, from: string, to: string, detail: string): never {
  throw new Error(`cell carry ${from} -> ${to} (${stage}): ${detail}`);
}

/** The exported walk's failure arm — `label` is the "fromEngine -> toEngine"
 *  pair, so the text is byte-identical to fail("walk", …) at the carry site. */
function failWalk(label: string, detail: string): never {
  throw new Error(`cell carry ${label} (walk): ${detail}`);
}

/** `repos/<storage_key>/packs/<packKey>.pack` — git/r2keys.ts's packR2Key (the
 *  module is engine-internal; the layout is SPEC-0001 §3's committed contract).
 *  Exported for the fork/generate copy pass (fork-task.ts), which streams pack
 *  bytes across DIFFERENT storage keys and needs the same derivation. */
export function packR2Key(storageKey: string, packKey: string): string {
  return `repos/${storageKey}/packs/${packKey}.pack`;
}

/** `repos/<storage_key>/packs/<packKey>.idx` — git/r2keys.ts's idxR2Key (the
 *  same committed layout, idx sidecar). */
export function idxR2Key(storageKey: string, packKey: string): string {
  return `repos/${storageKey}/packs/${packKey}.idx`;
}

/** Stream-copy the first PRESENT candidate key onto `to` (the wiki arm's two
 *  source prefixes — see the module doc's WIKI SIBLING note; R2ObjectBody.body
 *  is single-read, so probe with head, then let the engine's copyObject do the
 *  FixedLengthStream move). Candidate order is load-bearing: the NAME-ADDRESSED
 *  prefix first (every first carry's real source), the CARRIED key second —
 *  which equals the destination by construction, so reaching it means the
 *  source cell was itself carried before (its persisted meta.storage_key IS
 *  this key) and the bytes already sit at the target's key: a same-key copy
 *  would stream-read while overwriting itself. Exhausting every candidate is
 *  a loud carry failure, never a silent skip (a half-carried wiki must fail
 *  into the caller's destroy-and-log floor instead of adopting refs whose
 *  bytes do not exist). */
async function copyFirstPresent(
  bucket: R2Bucket,
  candidates: string[],
  to: string,
  from: string,
  toName: string,
  what: string,
): Promise<void> {
  for (const key of candidates) {
    if (key === to) return;
    if ((await bucket.head(key)) !== null) {
      await copyObject(bucket, key, to);
      return;
    }
  }
  fail("packs", from, toName, `${what} missing at every source prefix (${candidates.join(", ")})`);
}

/**
 * Carry the full content of the `fromEngine` cell into the `toEngine` cell
 * (which is destroyed and rebuilt first). `storageKey` is the repo's immutable
 * D1 storage key — for a CODE cell both cells address the same R2 prefixes
 * under it; for the WIKI-SIBLING pair (`*.wiki` names, still the PARENT's key
 * per service.ts's call shape) the wiki arm derives the target's key with
 * wikiCarryStorageKey and byte-moves the packs (module doc, WIKI SIBLING).
 * Throws on failure.
 */
export async function carryRepoCell(
  env: Env,
  fromEngine: string,
  toEngine: string,
  storageKey: string,
): Promise<void> {
  if (fromEngine === toEngine) return;
  const fromWiki = fromEngine.endsWith(".wiki");
  if (fromWiki !== toEngine.endsWith(".wiki")) {
    // Structural caller bug (a wiki name must carry to its derived sibling,
    // a code name to its code successor) — fail loudly instead of silently
    // re-keying one side onto the wrong prefix class.
    fail("init", fromEngine, toEngine, "mixed wiki/code cell pair");
  }
  const targetStorageKey = fromWiki ? wikiCarryStorageKey(storageKey) : storageKey;
  // The wiki source's prefixes, most-specific first: the NAME-ADDRESSED
  // prefix its git-HTTP pushes staged at, then the carried key (this wiki was
  // itself carried before — its persisted meta.storage_key; that candidate
  // equals the target's key, which copyFirstPresent reads as "bytes already
  // in place", never as a first-carry shortcut).
  const wikiSourceKeys = fromWiki ? [fromEngine, wikiCarryStorageKey(storageKey)] : [];
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

  const begin = await target.beginForkImport(targetStorageKey);
  if (begin.tag === "invalid") fail("begin", fromEngine, toEngine, begin.reason);

  try {
    const refs = await source.listRefs();

    // 1. Pack catalog: page the source, adopt on the target. A code cell's
    // rename/transfer kept the immutable storage key, so its R2-backed packs
    // are already at the target's keys — no byte move. The WIKI arm re-keyed
    // (targetStorageKey above): copy every pack (and its idx sidecar) from
    // the source's prefixes BEFORE the page's adopt — copy-before-stage,
    // adopt's tail verification reads the target's keys.
    const packed = new Set<string>();
    let cursor = "";
    for (;;) {
      const page = await source.listCatalogPage(cursor, 8192);
      for (const p of page.packs) {
        if (p.rowsFrom !== "") continue; // continuation slice: byte work is done
        if (p.location === "r2") {
          if (fromWiki) {
            await copyFirstPresent(
              bucket,
              wikiSourceKeys.map((key) => packR2Key(key, p.packKey)),
              packR2Key(targetStorageKey, p.packKey),
              fromEngine,
              toEngine,
              `pack ${p.packKey}`,
            );
            if (p.idxBytes > 0) {
              await copyFirstPresent(
                bucket,
                wikiSourceKeys.map((key) => idxR2Key(key, p.packKey)),
                idxR2Key(targetStorageKey, p.packKey),
                fromEngine,
                toEngine,
                `idx sidecar ${p.packKey}`,
              );
            }
          }
          // Code cell: the bytes (and the idx sidecar, when any) sit at the
          // target's own keys already — a self-copy would race its own
          // overwrite.
        } else if (p.packData) {
          // sqlite-location pack: bytes rode the page (DO-local pack_data
          // rehydration) — one plain put into the target's R2 prefix.
          await bucket.put(packR2Key(targetStorageKey, p.packKey), p.packData);
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

    // 2 + 3. Ref partition + the loose class: packed annotated-tag tips carry
    // as plain refs, loose ones re-materialize (module doc's fidelity note),
    // the loose-object completion walk lands the Worker-authored content AND
    // whatever hangs off the packed tips' cross-store edges (CROSS-STORE
    // EDGES above), and HEAD is confined to a carried ref (the engine
    // validates; an annotated-tag HEAD falls back to null — the unborn-HEAD
    // convention).
    const { carried, head, truncated } = await carryLooseRefs(
      source,
      target,
      refs.refs,
      refs.head,
      packed,
      `${fromEngine} -> ${toEngine}`,
    );
    if (truncated) {
      // Documented floor (module doc): the descent died on the budget before
      // proving the closure complete — loud here, the carry still lands.
      console.error(
        `[carry] ${fromEngine} -> ${toEngine}: loose-closure descent truncated after ${PACKED_WALK_MAX_COMMITS} packed commits; the git wire may be incomplete for this cell`,
      );
    }

    // 4. One finalizing transaction: catalog rows landed during adopt; refs +
    // HEAD + refs_version land now and the importing gate clears.
    const fin = await target.finalizeForkImport({ refs: carried, head });
    if (fin.tag === "invalid") fail("finalize", fromEngine, toEngine, fin.reason);
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
 * per-call budget.
 *
 * The walk descends THROUGH packed commits (the CROSS-STORE EDGES module
 * note): a packed commit is read only to follow its parent/tree edges into
 * the loose class — its own bytes are never re-staged (the adopted packs
 * carry them), and its PACKED tree is skipped whole (packed subtrees' loose
 * content hangs under the authoring loose commits the descent reaches).
 * Returns `truncated` when the packed-descent budget expired before the
 * walk's natural end — the caller decides how loudly that surfaces.
 *
 * Exported for the fork/generate copy pass (src/repos/fork-task.ts), which
 * must land the same loose class (auto_init commits, API commits, and the
 * push-stacked-on-auto_init shape — REDEPLOY13's generated-repo wire
 * residual). `label` names the from → to pair in error text. `extraRoots`
 * are additional commit-oid walk roots (carryLooseRefs passes the loose
 * annotated tags' peeled commits — a tag can reach a commit no branch names;
 * packed roots descend like any other).
 */
export async function carryLooseObjects(
  source: CarrySource,
  target: Pick<CarryTarget, "putApiObjects">,
  carried: { name: string; oid: string }[],
  packed: Set<string>,
  label: string,
  extraRoots: string[] = [],
): Promise<{ truncated: boolean }> {
  let rpcs = 0;
  let objects = 0;
  let packedReads = 0;
  let truncated = false;
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
    if (commits.has(oid)) return;
    commits.add(oid);
    const isPacked = packed.has(oid);
    if (isPacked) {
      // Cross-store descent: the fork holds this commit's bytes already — the
      // read exists only to follow its edges into the loose class. Budgeted
      // and truncation-flagged, never thrown (module doc).
      if (++packedReads > PACKED_WALK_MAX_COMMITS) {
        truncated = true;
        return;
      }
    } else {
      spend();
    }
    const commit = await source.readCommit(oid);
    if (commit === null) failWalk(label, `commit unreadable: ${oid}`);
    if (!isPacked) await stage(commitObject(commit));
    if (!packed.has(commit.tree)) {
      // A loose root tree: stage it (no-op when the oid is packed anyway) and
      // walk its entries — this is the arm that reaches a packed commit's
      // LOOSE tree (an empty commit stacked on auto_init) and every loose
      // commit's full tree closure.
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
  for (const root of extraRoots) await walkCommit(root);
  await flush();
  return { truncated };
}

/**
 * The ref partition + loose-class landing for a copy pass, in one call —
 * the shared shape behind the rename/transfer carry (carryRepoCell), the
 * fork/generate completion (fork-task.ts replicateRepoCopy) and the
 * pull-engine cross-repo carries. PACKED annotated-tag tips carry as plain
 * refs (their bytes ride the adopted packs); LOOSE annotated tags
 * re-materialize through serializeTag (the module doc's fidelity note —
 * tagger/message unrecoverable, the materialized oid differs, the peel is
 * identical) and land via putApiObjects before the walk; their peeled
 * commits join the walk roots. Returns the finalize input: `carried` refs,
 * the head confined to a carried ref (null otherwise — the engine's
 * unborn-HEAD convention), and `truncated` (the walk's packed-descent budget
 * expired — callers log; the copy lands with the documented floor).
 */
export async function carryLooseRefs(
  source: CarrySource,
  target: Pick<CarryTarget, "putApiObjects">,
  refs: { name: string; target: string; peeled?: string }[],
  head: string | null,
  packed: Set<string>,
  label: string,
): Promise<{ carried: { name: string; oid: string }[]; head: string | null; truncated: boolean }> {
  const carried: { name: string; oid: string }[] = [];
  const walkable: { name: string; oid: string }[] = [];
  const tagObjects: ApiObject[] = [];
  const tagPeels: string[] = [];
  for (const ref of refs) {
    if (ref.peeled !== undefined && ref.peeled !== ref.target && !packed.has(ref.target)) {
      // Loose annotated tag: re-materialize (module doc). The name comes off
      // the ref (git keeps tag ref and tag-object name identical); object +
      // type are the byte-true (peeled, commit) pair — the tags API route is
      // the only loose-tag writer and always lands that shape.
      const tag = serializeTag({
        object: ref.peeled,
        type: "commit",
        tag: ref.name.slice("refs/tags/".length),
        tagger: null,
        message: "",
      });
      tagObjects.push({ oid: tag.oid, type: tag.type, data: tag.data });
      carried.push({ name: ref.name, oid: tag.oid });
      tagPeels.push(ref.peeled);
      continue;
    }
    carried.push({ name: ref.name, oid: ref.target });
    walkable.push({ name: ref.name, oid: ref.target });
  }
  if (tagObjects.length > 0) {
    // putApiObjects re-verifies every oid on landing (hashObject check) — the
    // materialization's own correctness gate.
    const put = await target.putApiObjects(tagObjects);
    if (put.tag !== "ok") {
      failWalk(
        label,
        `putApiObjects refused the tag materialization (${put.tag}): ${put.tag === "invalid" ? put.reason : `limit ${put.limitBytes}`}`,
      );
    }
  }
  const { truncated } = await carryLooseObjects(source, target, walkable, packed, label, tagPeels);
  return { carried, head: head !== null && carried.some((r) => r.name === head) ? head : null, truncated };
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
