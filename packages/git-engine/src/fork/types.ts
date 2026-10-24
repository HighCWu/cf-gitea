/**
 * The SPEC-0001b §5.3 fork-replication RPC contract types, split out per the
 * amendment's NOTICE category 1 (the same split `src/merge/types.ts` holds for
 * §4). `control-plane.ts` hosts the implementations and the LeaseHost
 * delegation; `src/fork/replicate.ts` hosts the Worker-side consumer loop.
 *
 * Fork model (§5.2): a fork is a FULL COPY taken at fork time — the parent's
 * active pack catalog is replicated pack-by-pack (bytes + index rows), then
 * refs + HEAD land in one finalizing transaction. No cross-repo pack sharing,
 * ever (deletion stays a pure prefix purge; compaction stays repo-local).
 *
 * The four RPCs split the work across the two RepoDOs:
 *
 *   parent.listCatalogPage(after, limit)  paged catalog + index-row read
 *   fork.beginForkImport(storageKey)      lease the fork: meta.importing gate
 *   fork.adoptForkPacks(page)             verify copied bytes, insert rows,
 *                                         stage the catalog entry
 *   fork.finalizeForkImport(refs, head)   ONE transaction: catalog + refs +
 *                                         HEAD + refs_version bump, un-gate
 *
 * Pack BYTES never ride the DO→DO control plane for R2-backed packs: the
 * Worker consumer streams `bucket.get(parentKey)` → `bucket.put(forkKey)`
 * (same REPO_PACKS bucket, both keys r2keys.ts-derived). The one exception is
 * `location: "sqlite"` packs (SPEC-0001a §8 correction 2, < 16 MiB, physically
 * unreachable from another DO): their bytes ride `CatalogPackEntry.packData`
 * on the page — bounded by the small-pack threshold — and the consumer
 * rehydrates them into the fork's R2 prefix.
 *
 * Every application outcome is a tagged union — never a thrown error (the
 * split-plane rule, SPEC-0001a §2 Rule 2).
 */
import type { IndexRow } from "../control-plane";
import type { PackState } from "../git/packstore";

/**
 * A pack_catalog row as surfaced by `listCatalogPage`, carrying its slice of
 * index rows. One entry can span several pages when the pack has more rows
 * than the page budget (`rowsComplete: false`; the consumer keeps calling with
 * the returned `CatalogPage.nextAfter` cursor until the pack completes).
 */
export interface CatalogPackEntry {
  /** `pack-<sha1>` — the catalog key and R2 object stem (r2keys.ts) */
  packKey: string;
  /** the parent row's kind, surfaced for provenance ('receive' today,
   * 'compact' from M3, 'fork' for fork-of-fork parents). The fork records its
   * own copies as 'fork' — they never came from a receive lease. */
  kind: string;
  /** the parent row's lifecycle state. Only 'active' rows are EVER listed:
   * superseded/retired packs are compaction debris whose objects the active
   * set already holds (copying them would resurrect unreachable bytes). */
  state: PackState;
  /** where the parent keeps the pack bytes (r2: consumer streams a copy;
   * sqlite: bytes ride `packData` and the consumer rehydrates them) */
  location: "r2" | "sqlite";
  /** the parent's recorded object count — informational; the fork recomputes
   * its own count from the rows it actually holds (an oid's row lives under
   * the first pack that indexed it, so counts can legitimately differ) */
  objectCount: number;
  packBytes: number;
  /** idx v2 sidecar length; 0 when the parent has none */
  idxBytes: number;
  /** this page's slice of the pack's index rows, oid-ordered */
  rows: IndexRow[];
  /** the oid this slice starts AFTER ("" = the pack's first slice). The fork
   * verifies the copied pack bytes exactly once, on the first slice. */
  rowsFrom: string;
  /** true when the slice ends the pack — only then does adoptForkPacks stage
   * the catalog entry for finalize */
  rowsComplete: boolean;
  /** location='sqlite' ONLY: the pack's bytes, read out of the parent's
   * pack_data chunks. Present on the first slice; bounded by the < 16 MiB
   * small-pack threshold (SPEC-0001a §8 correction 2). */
  packData?: Uint8Array;
}

/** One `listCatalogPage` page (SPEC-0001b §5.3). */
export interface CatalogPage {
  packs: CatalogPackEntry[];
  /** true when at least one entry in THIS page has location 'sqlite' — the
   * consumer must rehydrate those bytes instead of streaming an R2 copy */
  hasLocalPacks: boolean;
  /** true when more pages follow */
  more: boolean;
  /** the cursor for the next `listCatalogPage` call (echo verbatim; "" starts
   * over). The consumer never parses it. */
  nextAfter: string;
}

// ---- §5.3 RPC outcomes --------------------------------------------------------

export type BeginForkImportOk = {
  tag: "ok";
  /** the persisted storage key (meta.storage_key) the fork's R2 keys derive from */
  storageKey: string;
};
export type ForkInvalid = { tag: "invalid"; reason: string };
export type BeginForkImportResult = BeginForkImportOk | ForkInvalid;

export type AdoptForkPacksResult = { tag: "ok" } | ForkInvalid;

export interface FinalizeForkImportInput {
  /** the parent's refs, read by the consumer via the parent's listRefs */
  refs: { name: string; oid: string }[];
  /** the parent's HEAD symref target ("refs/heads/main") or null for an
   * empty parent; must name one of `refs` when set */
  head: string | null;
}
export type FinalizeForkImportOk = {
  tag: "ok";
  /** post-commit edge-cache key (T4) — bumped because refs changed */
  refsVersion: string;
};
export type FinalizeForkImportResult = FinalizeForkImportOk | ForkInvalid;
