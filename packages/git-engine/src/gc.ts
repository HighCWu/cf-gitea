/**
 * Pack garbage collection (SPEC-0011 §2, milestone M3.4): the RETIRED→
 * RECLAIMABLE→DELETED half of the four-state lifecycle. Compaction (M3.3)
 * publishes RETIRED inputs and never deletes; this module is the ONLY writer
 * of 'reclaimable' and the only remover of catalog rows, so the two
 * transitions below have exactly one implementation to review.
 *
 * Transition guards (§2's table, as built):
 *
 * - RETIRED→RECLAIMABLE (GC scan, ONE DO transaction per scan): (a) ZERO live
 *   read leases reference the pack (`hasLiveReadLeaseFor` — the M3.1
 *   substrate; plan+lease are atomic, so a pack being read is lease-protected
 *   at every instant of the read), AND (b) the finalize premise cannot need
 *   it. The spec's original gate is (a); (b) is what the as-built analysis
 *   adds: M3.3's publish re-points identical content in ONE transaction, so
 *   a RETIRED pack whose supersession chain reaches an ACTIVE pack is
 *   premise-safe — a receive finalize's `store.has(tip)` check and every
 *   object read resolve through pack_objects rows, which each publish moved
 *   onto its successor (no row ever names a retired input), so the content
 *   is readable through the ACTIVE pack at the END of the chain — chained
 *   compactions retire the previous successor too, so the walk is
 *   TRANSITIVE (bounded, cycle-guarded; a chain that does not reach ACTIVE
 *   leaves the pack RETIRED this round and is retried). Publish atomicity
 *   makes the walk always-true in practice; the sweeper VERIFIES it anyway
 *   because §2 mandates convergence by catalog state, never by assumption.
 *   The scan is idempotent: the flip is a guarded UPDATE
 *   (`WHERE state = 'retired'`), re-runs converge, and the state re-read
 *   inside the transaction means a row that moved between the listing and
 *   the flip is skipped, not assumed.
 *
 * - RECLAIMABLE→DELETED (GC delete): the catalog row is removed ONLY after
 *   the R2 DELETE returned — an ack must mean deleted, so a host without an
 *   R2 backend never reaches this transition (the caller skips up front, and
 *   the host's delete adapter throws when unbound rather than silently
 *   no-opping). The delete is idempotent-retried: R2 DELETE of a missing
 *   object succeeds, so a crash anywhere before the row removal converges on
 *   the next pass (row still RECLAIMABLE → delete again → remove). A
 *   defensive zero-live-lease re-check runs before the delete too: a live
 *   lease can never legitimately name a RECLAIMABLE pack (the flip required
 *   zero, new plans exclude RECLAIMABLE from `readableCatalogKeys`), so the
 *   re-check is the structural form of fault C's "never grant both the
 *   renewal and the delete". The row removal itself is guarded
 *   (`WHERE state = 'reclaimable'`) inside ONE transaction with the state
 *   re-read. RECLAIMABLE is IRREVERSIBLE in v1 (§2): a late renewal rejects
 *   (`renewAndAuthorizeRead` reads the readable set, which excludes
 *   reclaimable/deleted rows) — the reader's terminate-and-retry posture;
 *   re-marking readable would be an explicit recovery transaction, out of
 *   scope.
 *
 * Clone-cache entries (§4.2) have no catalog rows; their GC is
 * LEASE-DRAIN-ONLY (OQ4 is STILL OPEN — version-window retention vs
 * lease-drain-only was deferred past the design review; v1 adopts the
 * conservative half): an entry is deleted only when (a) the refs_version it
 * serves is no longer the current `reachableVersion()` (a new plan can never
 * name it — planCloneStream keys on the current version), and (b) no live
 * read lease protects it (a stream still reading it holds a cache lease that
 * blocks the delete exactly like a pack lease). In-flight streams are
 * additionally covered by the §4.2 overlap argument — a delete racing a GET
 * completes or fails the fetch whole, never a false success — but the lease
 * gate keeps the common case off that argument entirely.
 *
 * Interaction posture: receives need no exclusion — a RECLAIMABLE/DELETED
 * pack has zero pack_objects rows (the publish re-pointed them all) and zero
 * refs point into it (the finalize premise check resolves tips through the
 * successor), so no receive read can name a deleted pack. Compaction inputs
 * are ACTIVE by construction and GC never touches ACTIVE rows, so a
 * concurrent compaction round and a GC pass serialize on disjoint row sets.
 * The legacy M2 wholesale reset (`gc-pending` → runGc) keeps its own
 * deferral posture and runs before this consumer in the alarm; M3.4 does not
 * change it.
 *
 * Trigger (§2 "GC scan" actor + §5.2 step 5): the DO alarm, compaction's
 * stamp pattern — a compaction round that lands RETIRED inputs stamps
 * `gc_wanted_at` (as does every committed ref change, which stales the
 * clone-cache entry it served), the alarm runs a PASS, and a pass with
 * pending work (lease-blocked rows, undrained cache entries, unretried
 * deletes) keeps the stamp and re-arms — the periodic sweep — until the
 * catalog has no RETIRED/RECLAIMABLE rows and no leased stale cache entries,
 * at which point the stamp is consumed. The manual entry point is
 * `RepoCell.gcNow` (tests/benches/admin), mirroring `compactNow`.
 */
import { cloneCachePrefix, cloneCacheVersionOf, idxR2Key, packR2Key } from "./git/r2keys";
import type { GitStore } from "./git/store";
import { hasLiveReadLeaseFor } from "./read-leases";

/** How long after a pass with pending work the alarm retries. Mirrors
 * COMPACTION_RETRY_MS: pending work is lease-drain or delete-retry, both
 * bounded by real time (READ_LEASE_TTL_MS for a crashed holder's lease), so
 * a 30 s cadence converges a drained repo within one interval of the last
 * release without a standing timer when there is nothing to collect. */
export const GC_RETRY_MS = 30 * 1000;

/** What a GC pass needs from its host (RepoCell contributes the DO storage +
 * the R2 bucket; tests contribute fakes). */
export interface GcHost {
  store: GitStore;
  /** transactionSync (the flip/remove transactions) + setAlarm (the
   * consumer's re-arm, not used by the pass itself) */
  storage: {
    transactionSync<T>(fn: () => T): T;
    setAlarm(at: number | Date): Promise<void>;
  };
  /**
   * Delete R2 objects. MUST throw when no R2 backend is bound: the
   * RECLAIMABLE→DELETED transition removes the catalog row only after this
   * resolves, so a silent no-op would strand bytes while deleting their last
   * index of existence. Idempotent (deleting a missing object is fine).
   */
  deletePackObjects(keys: string[]): Promise<void>;
  /** List R2 object keys under a prefix (paged; the clone-cache scan). */
  listPackObjects(prefix: string): Promise<string[]>;
}

/** One GC pass's outcome. `pending` is the convergence probe the alarm
 * consumer re-arms on — computed by catalog state + the lease-filtered cache
 * listing after the pass ran, never assumed from what the pass did. */
export interface GcCollected {
  tag: "collected";
  /** packs flipped RETIRED→RECLAIMABLE this pass */
  flippedToReclaimable: string[];
  /** packs reclaimed RECLAIMABLE→DELETED this pass (R2 deleted + row gone) */
  deleted: string[];
  /** stale clone-cache entries removed this pass */
  cacheEntriesDeleted: string[];
  /** RETIRED (or RECLAIMABLE, defensively) rows a live read lease still
   * protects — the §6.6 GC isolation gate held; retried next pass */
  blockedByLeases: string[];
  /** RETIRED rows whose successor premise does not verify (the supersession
   * chain does not reach an ACTIVE row this pass) — publish atomicity makes
   * this empty in practice; the sweeper never assumes it */
  premiseUnsafe: string[];
  /** RECLAIMABLE rows whose R2 delete did not complete this pass (host
   * error) — retried idempotently next pass */
  awaitingDeleteAck: string[];
  /** stale clone-cache entries kept because a live lease still reads them */
  cacheEntriesLeased: string[];
  /** true when any work remains after the pass: catalog rows still in
   * RETIRED/RECLAIMABLE, or stale cache entries still lease-held */
  pending: boolean;
}

export type GcPassResult = GcCollected | { tag: "skipped"; reason: string };

/**
 * Run ONE GC pass (SPEC-0011 §2): the RETIRED→RECLAIMABLE scan, then the
 * RECLAIMABLE→DELETED reclamation, then the clone-cache drain. Never throws
 * for application outcomes (tagged unions, per the control-plane RPC
 * discipline); a throw is a transport/engine bug. Bounded by the catalog
 * size for the pack phases and by the clone-cache prefix's key count for the
 * cache phase — a pass never walks pack bytes.
 */
export async function runGcPass(host: GcHost): Promise<GcPassResult> {
  const { store } = host;
  const storageKey = storageKeyOf(store);

  // --- §2 transition 1: RETIRED→RECLAIMABLE (scan, ONE transaction) --------
  // The listing happens outside the txn for paging sanity, but every guard
  // (state re-read, successor premise, zero live leases) re-evaluates INSIDE
  // the txn — the flip cannot interleave with a lease registration/renewal
  // (same serialized control domain, no check-then-act window).
  const retired = store.packs.catalogRowsInState("retired");
  const flippedToReclaimable: string[] = [];
  const blockedByLeases: string[] = [];
  const premiseUnsafe: string[] = [];
  if (retired.length) {
    host.storage.transactionSync(() => {
      for (const row of retired) {
        // the row may have moved since the listing (a foreign writer, a
        // previous crashed pass) — converge by state, never by assumption
        if (store.packs.catalogStateOf(row.packKey) !== "retired") continue;
        if (!successorPremiseHolds(store, row.supersededBy)) {
          // the publish premise does not verify THIS pass: leave RETIRED,
          // retried (the transitive walk makes this unreachable for rows a
          // committed publish wrote; a fabricated/foreign row must not be
          // reclaimed on the assumption it was)
          premiseUnsafe.push(row.packKey);
          continue;
        }
        if (hasLiveReadLeaseFor(store, [row.packKey], Date.now())) {
          // §6.6 GC isolation: a live lease protects this pack — it serves an
          // existing reader (§2) and stays RETIRED (still in the readable set)
          blockedByLeases.push(row.packKey);
          continue;
        }
        store.packs.markPackReclaimable(row.packKey);
        flippedToReclaimable.push(row.packKey);
      }
    });
  }

  // --- §2 transition 2: RECLAIMABLE→DELETED (R2 DELETE ack, then row) ------
  const reclaimable = store.packs.catalogRowsInState("reclaimable");
  const deleted: string[] = [];
  const awaitingDeleteAck: string[] = [];
  for (const row of reclaimable) {
    // defensive re-check (see module header): a live lease must never coexist
    // with the delete — fault C's never-grant-both, structural in GC too
    if (hasLiveReadLeaseFor(store, [row.packKey], Date.now())) {
      blockedByLeases.push(row.packKey);
      continue;
    }
    if (row.location === "r2") {
      try {
        // the ack BEFORE any catalog removal: a crash before this resolves
        // leaves the row RECLAIMABLE and the bytes in place — the retry
        // deletes again (idempotent) and converges
        await host.deletePackObjects([packR2Key(storageKey, row.packKey), idxR2Key(storageKey, row.packKey)]);
      } catch (err) {
        console.log(
          `[gc ${storageKey}] R2 delete for ${row.packKey} failed: ${err instanceof Error ? err.message : String(err)}`
        );
        awaitingDeleteAck.push(row.packKey);
        continue;
      }
    }
    // row removal in ONE transaction, guarded on the state: an already-moved
    // or already-gone row deletes nothing (idempotent re-run)
    host.storage.transactionSync(() => {
      store.packs.deleteReclaimablePack(row.packKey);
    });
    deleted.push(row.packKey);
  }

  // --- §4.2 clone-cache drain (OQ4: lease-drain-only; version-window
  // retention stays OPEN — see the module header) ---------------------------
  const currentVersion = store.reachableVersion();
  const cacheEntriesDeleted: string[] = [];
  const cacheEntriesLeased: string[] = [];
  let cacheKeys: string[] = [];
  try {
    cacheKeys = await host.listPackObjects(cloneCachePrefix(storageKey));
  } catch (err) {
    // an unlistable backend defers the cache phase (the pack phases above
    // already ran); the next pass retries the listing
    console.log(
      `[gc ${storageKey}] clone-cache list failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  for (const key of cacheKeys) {
    const version = cloneCacheVersionOf(key);
    if (version === null) continue; // not a clone-cache object shape: never touch
    if (version === currentVersion) continue; // the hot entry — new plans name it
    if (hasLiveReadLeaseFor(store, [key], Date.now())) {
      // a stream is still reading the stale entry (cache lease, §4.2):
      // drain-gated like a pack lease
      cacheEntriesLeased.push(key);
      continue;
    }
    try {
      await host.deletePackObjects([key]);
      cacheEntriesDeleted.push(key);
    } catch (err) {
      console.log(
        `[gc ${storageKey}] clone-cache delete for ${key} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      cacheEntriesLeased.push(key); // kept — retried next pass (pending)
    }
  }

  // --- convergence probe (by catalog state, never by assumption) ------------
  const pending =
    store.packs.catalogRowsInState("retired").length > 0 ||
    store.packs.catalogRowsInState("reclaimable").length > 0 ||
    cacheEntriesLeased.length > 0;

  return {
    tag: "collected",
    flippedToReclaimable,
    deleted,
    cacheEntriesDeleted,
    blockedByLeases,
    premiseUnsafe,
    awaitingDeleteAck,
    cacheEntriesLeased,
    pending,
  };
}

/** The repo's storage key (the control-plane resolution order, read-only
 * here — GC never persists a key; the receive/plan paths own that). */
function storageKeyOf(store: GitStore): string {
  return store.getMeta("storage_key") ?? store.getMeta("repo") ?? "";
}

/** The finalize-premise check (§2 precondition (b), as built): does the
 * supersession chain from `supersededBy` reach an ACTIVE pack? Each publish
 * re-points every merged object's index row onto its successor, so a
 * successor's retirement moves the content AGAIN — the chain's terminal
 * ACTIVE row is where every read resolves. Intermediate links in ANY
 * non-deleted state are followable (a RECLAIMABLE link passed its own
 * premise: the content it held already lives further up-chain; rows only
 * ever leave the catalog through this module's ack-gated removal, and a
 * flip never strands its dependents — same-pass flips share one
 * transaction). A chain that terminates at a MISSING row is unverifiable
 * this round and the caller retries.
 *
 * Termination: `superseded_by` always names a pack created LATER (a publish
 * merges ACTIVE inputs into a new successor), so the walk is strictly
 * forward in catalog order and cannot cycle; the depth bound is defense
 * against a corrupted catalog, and its failure mode is "leave RETIRED",
 * never "assume safe". */
function successorPremiseHolds(store: GitStore, supersededBy: string | null): boolean {
  let next = supersededBy;
  for (let depth = 0; next; depth++) {
    if (depth >= 64) return false;
    const state = store.packs.catalogStateOf(next);
    if (state === "active") return true;
    if (state === null) return false; // the row is gone — the chain ends in nothing
    next = store.packs.supersededByOf(next);
  }
  return false;
}
