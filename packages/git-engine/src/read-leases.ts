/**
 * DO read leases (SPEC-0011 §3, milestone M3.1) — the `kind = 'read'` rows of
 * the existing `leases` table, protecting a fetch plan's R2-read dependency
 * set while it is in flight.
 *
 * Why no schema migration: the leases table (`lease_token` PK, `kind` free
 * string, `expires_at`, `payload` JSON) already represents everything a read
 * lease needs — the protected pack-key set, the plan generation id and the
 * expiry all ride the payload/expiry columns (SPEC-0011 §3.2). `kind='read'`
 * coexists with `receive` (excluded from each other's checks) and the reserved
 * `compaction`. Adding nothing, there is no REPO_MIGRATIONS step — per the
 * M3.0 contract, schema changes land as journal steps and non-changes land as
 * nothing (never another version bump).
 *
 * The four protocol properties implemented here (SPEC-0011 §3, adopted from
 * m3-design-inputs rounds 4-5):
 *
 * 1. ATOMIC PLAN+LEASE (§3.1): `planFetch` reads the catalog (the plan's
 *    dependency set) and inserts the lease row inside ONE `store.tx(...)`
 *    transaction, closing the register-after-check race — a GC transition
 *    either lands entirely before the transaction (the pack is excluded from
 *    the dependency set: never a dependency of a new plan) or entirely after
 *    it (the pack is protected by a live lease: never reclaimable while
 *    depended on). The quartet's lease-before-read + validate-before-plan.
 * 2. DURABILITY (§3.2): rows persist in DO SQLite — a DO restart preserves
 *    unexpired leases (same table, same journal-guarded schema); renewal and
 *    GC eligibility evaluate in the same serialized control domain.
 * 3. INLINE RENEWAL (§3.3): `renewAndAuthorizeRead(planId, packKey,
 *    byteRange)` is the authorization gate every R2 GET segment passes
 *    inline before it starts. RECLAIMABLE is irreversible (§2): a renewal
 *    for a pack that left the readable set (reclaimable/deleted/row gone)
 *    is REJECTED — the reader's terminate-and-retry posture, never a
 *    false-success. `byteRange` is accepted for signature compatibility but
 *    NOT persisted: mid-pack resume is explicitly out of scope for v1 (§3.5).
 * 4. RELEASE ON LAST READ (§3.4): `releaseReadLease` drops the row when all
 *    dependent R2 reads completed and no future read will target the
 *    protected packs — after the last Range GET (segmented path) or at
 *    stream end (fast path) — decoupling GC from HTTP transfer time.
 *    Buffered bytes streaming to a slow client need no pack protection.
 *
 * Fencing honesty (round 4): R2 does not check DO tokens — the Worker's
 * pre-read check IS the enforcement point; under Property A a missed check
 * can fail a fetch but cannot corrupt one. The overlap-safety rewording
 * (round 5) holds: renewal proves t_GET-start < t_expiry, never t_GET-end;
 * a GET spanning expiry completes or fails whole — never false success.
 */
import type { GitStore } from "./git/store";
import type { LeaseRow } from "./git/store";

/** How long one read-lease registration/renewal stays valid. Deliberately
 * short: renewal is per segment/per batch inline (no timer shape — SPEC-0011
 * §3.3), so a live stream keeps its lease indefinitely by renewing, while a
 * crashed holder's lease dies within this window and the expiry sweep (which
 * already scans every lease row at beginReceive and from the alarm) reclaims
 * it. A slow client is bounded by renewals, not by this TTL (Q2's resolution:
 * keep the stream alive indefinitely via renewal; bound GC latency after a
 * crash to the TTL). */
export const READ_LEASE_TTL_MS = 60 * 1000;

/** A renewal is issued once the confirmed coverage drops below this margin —
 * i.e. at every segment boundary past half-life. With TTL 60s every R2 read
 * segment starts with >= 30s of Worker-confirmed coverage; the check runs
 * INLINE before the segment's first byte is requested, so a slow renewal
 * back-pressures the client instead of racing GC (the Worker paces the
 * stream). */
export const READ_RENEW_MARGIN_MS = READ_LEASE_TTL_MS / 2;

/** The read-lease payload (SPEC-0011 §3.2): the protected pack key set, the
 * plan generation id, and (redundantly, for sweep diagnostics) the creation
 * expiry. `cache` marks keys that are NOT pack_catalog rows — the clone
 * cache's versioned whole-pack objects (SPEC-0011 §4.2): their safety rests
 * on immutability + the overlap argument, so renewal checks lease liveness
 * and membership but not a catalog state (there is no catalog row to check). */
export interface ReadLeasePayload {
  v: 1;
  /** the protected pack keys — catalog keys (`pack-<sha1>`) or, when `cache`,
   * clone-cache object keys. Sorted, deduped. */
  packKeys: string[];
  /** the plan generation id — the catalog/ref generation the plan was
   * computed against (refs_version). Diagnostic + fencing aid; the row's
   * lease_token IS the plan id. */
  generation: string;
  /** clone-cache keys: renewal skips the pack_catalog state gate */
  cache?: boolean;
}

function parseReadLeasePayload(payload: string): ReadLeasePayload | null {
  try {
    const p = JSON.parse(payload) as ReadLeasePayload | null;
    if (!p || p.v !== 1 || !Array.isArray(p.packKeys)) return null;
    return p;
  } catch {
    return null;
  }
}

/** A live read lease as the serve paths and (M3.4) GC see it. */
export interface LiveReadLease {
  planId: string;
  expiresAt: number;
  payload: ReadLeasePayload;
}

/** All live read leases (unexpired), payloads parsed; corrupt payloads are
 * skipped (a row whose payload cannot be read protects nothing and blocks
 * nothing — the sweep reclaims it at expiry). */
export function liveReadLeases(store: GitStore, now: number): LiveReadLease[] {
  const out: LiveReadLease[] = [];
  for (const row of store.readLeases(now)) {
    const payload = parseReadLeasePayload(row.payload);
    if (payload) out.push({ planId: row.leaseToken, expiresAt: row.expiresAt, payload });
  }
  return out;
}

/** GC eligibility substrate (M3.4 consumes; M3.1 pins the posture): true when
 * any live read lease protects ANY of `packKeys`. A RETIRED→RECLAIMABLE
 * transition must consult this in the same DO and never flips a pack a live
 * lease still protects (SPEC-0011 §2, §6.6 GC isolation). */
export function hasLiveReadLeaseFor(store: GitStore, packKeys: string[], now: number): boolean {
  const want = new Set(packKeys);
  for (const lease of liveReadLeases(store, now)) {
    for (const k of lease.payload.packKeys) if (want.has(k)) return true;
  }
  return false;
}

export type PlanFetchResult =
  | { tag: "leased"; planId: string; expiresAt: number; packKeys: string[] }
  | { tag: "rejected"; reason: string };

/** The Worker fast path's plan+lease outcome (RepoCell.planCloneStream): the
 * versioned clone-cache key with its whole-stream read lease, or a miss (the
 * negotiation shape is not an exact full clone — no lease is taken and the
 * request falls through to the DO serve path, which plans its own). */
export type PlanCloneStreamResult =
  | { tag: "leased"; key: string; planId: string; expiresAt: number }
  | { tag: "miss" };

export interface PlanFetchOptions {
  /** The plan generation id recorded in the payload (the refs/catalog
   * generation the plan was computed against). */
  generation: string;
  /** Explicit protected set — the fast path's single clone-cache key (with
   * `cache: true`). Omit to derive the dependency set from the catalog: every
   * readable (active or retired) pack, the conservative whole-catalog set the
   * negotiated-closure serve path may read (send-set packs, cross-pack delta
   * bases, plan-time peel reads). Over-protection only delays GC of packs
   * that are anyway not reclaimable; under-protection could strand a live
   * plan. */
  packKeys?: string[];
  /** The explicit set is clone-cache keys, not catalog rows (§4.2). */
  cache?: boolean;
  /** Override the registration TTL (tests, and future policy knobs). */
  ttlMs?: number;
}

/**
 * planFetch's body WITHOUT the transaction wrapper — for callers that are
 * ALREADY inside `store.tx` (RepoCell.planCloneStream runs the probe's
 * ref-state read and the lease insert in ONE transaction; transactionSync
 * must never nest). Everyone else uses `planFetch`.
 */
export function planFetchInsideTransaction(store: GitStore, opts: PlanFetchOptions): PlanFetchResult {
  const ttl = opts.ttlMs ?? READ_LEASE_TTL_MS;
  const packKeys =
    opts.packKeys !== undefined
      ? [...new Set(opts.packKeys)].sort()
      : store.packs.readableCatalogKeys();
  if (packKeys.length === 0) {
    // nothing to protect — no R2-backed dependency exists (loose-only repo
    // or an empty catalog); the serve paths run guard-free
    return { tag: "leased", planId: "", expiresAt: 0, packKeys: [] };
  }
  const planId = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = Date.now() + ttl;
  const payload: ReadLeasePayload = {
    v: 1,
    packKeys,
    generation: opts.generation,
    ...(opts.cache ? { cache: true } : {}),
  };
  store.createLease(planId, "read", expiresAt, JSON.stringify(payload));
  return { tag: "leased", planId, expiresAt, packKeys };
}

/**
 * Register the read lease for one fetch plan — ATOMICALLY with the catalog
 * read that selects the protected set (SPEC-0011 §3.1). Everything inside the
 * single `store.tx` transaction: the dependency-set selection (an explicit
 * list, or the readable-catalog keyset query), and the lease INSERT. A
 * concurrent compaction/GC transition in the same DO serializes either fully
 * before (excluded from the set) or fully after (blocked by the lease) —
 * there is no register-after-check window.
 *
 * A repo whose plan reads no packs (loose-only; nothing to protect)
 * short-circuits to `planId: ""` with no row written — the serve paths treat
 * an empty plan id as "no lease guard" and skip renewal/release.
 */
export function planFetch(store: GitStore, opts: PlanFetchOptions): PlanFetchResult {
  let out: PlanFetchResult = { tag: "rejected", reason: "planFetch did not run" };
  store.tx(() => {
    out = planFetchInsideTransaction(store, opts);
  });
  return out;
}

export type RenewReadResult =
  | { tag: "authorized"; expiresAt: number }
  | { tag: "rejected"; reason: string };

export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * The inline renewal + authorization gate (SPEC-0011 §3.3): awaited before an
 * R2 GET segment starts. Checks — all inside ONE transaction, so a GC
 * transition cannot interleave between the checks and the extension:
 *
 * - the plan's lease row exists, is kind='read', and is UNEXPIRED (an expired
 *   lease is dead: the expiry sweep may have reclaimed dependencies — reject;
 *   the reader terminates and re-fetches);
 * - when `packKey` is given, it is in the protected set, and (non-cache
 *   leases) its catalog row is still READABLE (active or retired). A
 *   RECLAIMABLE/DELETED/missing row rejects: RECLAIMABLE is irreversible in
 *   v1 (§2) — this is the late-renewal rejection posture of fault (A)/(C);
 * - when `packKey` is null (plan-level renewal), EVERY non-cache pack in the
 *   protected set must still be readable — the whole plan is dead the moment
 *   any dependency left the readable set;
 * - cache leases (§4.2) check membership only: clone-cache packs have no
 *   catalog row; their safety is immutability + the overlap argument.
 *
 * On success the lease is EXTENDED to now + ttl and the new expiry is
 * returned — that confirmed expiry is what covers the next segment.
 */
export function renewAndAuthorizeRead(
  store: GitStore,
  planId: string,
  packKey: string | null,
  byteRange?: ByteRange | null,
  opts: { ttlMs?: number } = {}
): RenewReadResult {
  if (!planId) return { tag: "rejected", reason: "no read lease held" };
  void byteRange; // v1: no mid-pack resume (§3.5) — the range names context only
  let out: RenewReadResult = { tag: "rejected", reason: "renewAndAuthorizeRead did not run" };
  store.tx(() => {
    const row: LeaseRow | null = store.getLease(planId);
    if (!row || row.kind !== "read") {
      out = { tag: "rejected", reason: "unknown plan (released or swept)" };
      return;
    }
    const now = Date.now();
    if (row.expiresAt <= now) {
      out = { tag: "rejected", reason: "lease expired" };
      return;
    }
    const payload = parseReadLeasePayload(row.payload);
    if (!payload) {
      out = { tag: "rejected", reason: "corrupt lease payload" };
      return;
    }
    const readable = payload.cache ? null : new Set(store.packs.readableCatalogKeys());
    if (packKey !== null) {
      if (!payload.packKeys.includes(packKey)) {
        out = { tag: "rejected", reason: `pack not protected by plan ${planId}` };
        return;
      }
      if (!payload.cache && !readable!.has(packKey)) {
        // RECLAIMABLE is irreversible (§2): the dependency left the readable
        // set — never re-authorize a read against it
        out = { tag: "rejected", reason: `pack no longer readable: ${packKey}` };
        return;
      }
    } else if (!payload.cache) {
      // plan-level renewal: every catalog dependency must still be readable
      for (const k of payload.packKeys) {
        if (!readable!.has(k)) {
          out = { tag: "rejected", reason: `plan dependency no longer readable: ${k}` };
          return;
        }
      }
    }
    const expiresAt = now + (opts.ttlMs ?? READ_LEASE_TTL_MS);
    // extend: createLease is an upsert on lease_token — same row, new expiry
    store.createLease(planId, "read", expiresAt, row.payload);
    out = { tag: "authorized", expiresAt };
  });
  return out;
}

export type ReleaseReadResult = { tag: "released" };

/**
 * Release the read lease (SPEC-0011 §3.4): call when all dependent R2 reads
 * completed AND no future read will target the protected packs — after the
 * last Range GET (segmented path) or at stream end (fast path). NOT the HTTP
 * response lifetime: buffered bytes may still be streaming to a slow client
 * while the packs become reclaimable. Idempotent: releasing an unknown or
 * already-released plan is `released` (terminate/cancel paths and the expiry
 * sweep race benignly). A post-release renewal is rejected ("no future
 * reads" is enforced, not assumed).
 */
export function releaseReadLease(store: GitStore, planId: string): ReleaseReadResult {
  if (planId) store.deleteLease(planId);
  return { tag: "released" };
}
