/**
 * Receive control plane (SPEC-0001a §3 Steps 1-2).
 *
 * The push data plane (pkt-line parse, pack staging, scan, delta resolution,
 * idx emission, staging→packs copy) runs in the Worker; the DO keeps refs,
 * the object INDEX, and the receive LEASE. These are the public RPCs on
 * `RepoCell` (exposed as Workers RPC), and every application outcome crosses
 * the boundary as a tagged union — never a thrown error (transport failures
 * still throw and are retryable-unknown: finalize is idempotent-on-
 * `lease_mismatch` and the lease expiry sweep makes retry safe).
 *
 * Step 2 moves the scan itself into the Worker: index rows arrive through
 * {@link putIndexRows} in bounded control-plane batches, and thin-pack /
 * cross-pack bases resolve through {@link lookupObjects} — the DO never reads
 * pack bytes.
 */
import {
  commitPush,
  latestCommitTime,
  validatePush,
  validRefName,
  CommandResult,
  PushCommand,
} from "./git/protocol";
import { ObjType } from "./git/objects";
import { ZERO_OID } from "./git/util";
import type { GitStore } from "./git/store";
import type { RefUpdate } from "./mod";

/** Per-command outcome, one per input command, in order. */
export interface ReceiveCommandResult {
  ref: string;
  ok: boolean;
  /** ng message on failure: "fetch first", "funny refname", "missing necessary objects" */
  message?: string;
}

/** Open a receive lease. Commands/caps are parsed by the Worker (SPEC-0001 §5). */
export interface BeginReceiveInput {
  commands: PushCommand[];
  capabilities: string[];
  /** remaining byte count (Content-Length minus command section), null when chunked */
  packBytesHint: number | null;
}

export type BeginReceiveOk = {
  tag: "ok";
  leaseToken: string;
  /** repos/<storage_key>/staging/pack-rx-<leaseToken>.pack (SPEC-0001 §3) */
  stagingKey: string;
  /** immutable storage key (r_<id>); the Worker needs it to build R2 keys */
  storageKey: string;
  /** pre-push refs_version, echoed back to finalize for the CAS guard */
  refsVersion: string;
  /** current ref tips, for thin-pack base resolution in the Worker (Step 2) */
  refTips: { name: string; oid: string }[];
  /** unix millis; the Worker must finalize before this or the sweep reclaims */
  leaseExpiresAt: number;
};
export type BeginReceiveBusy = {
  tag: "busy";
  /** value for the 503 Retry-After header (T7: 10) */
  retryAfterSeconds: number;
};
export type BeginReceiveRejected = {
  tag: "rejected";
  /** per-command refname-validation failures (checked BEFORE any byte streams) */
  results: ReceiveCommandResult[];
};
export type BeginReceiveResult = BeginReceiveOk | BeginReceiveBusy | BeginReceiveRejected;

export interface FinalizedPack {
  /** final pack key: repos/<storage_key>/packs/<packName>.pack — the Worker has
   * already copied staging → packs/ BEFORE calling finalize (see ordering note) */
  packKey: string;
  /** the pack's own SHA-1 trailer (computed during the Worker's stream) */
  packSha1: string;
  packBytes: number;
  objectCount: number;
  idxBytes: number;
}

export interface FinalizeReceiveInput {
  leaseToken: string;
  /** refsVersion from beginReceive; mismatch ⇒ ref_conflict (a push landed in between) */
  expectedRefsVersion: string;
  commands: PushCommand[];
  newTips: (string | null)[]; // null = delete command; index-aligned with commands
  pack: FinalizedPack;
  /** unpacker/scan failure text, null on success — forces every command to fail */
  unpackError: string | null;
  /** Worker-side connectivity outcome (SPEC-0001a §3 Step 2): true when the
   * scan's anti-check found a referenced child absent from the pack and the
   * object database. validatePush then rejects every non-delete command with
   * "missing necessary objects" exactly as the deleted packComplete() did. */
  packIncomplete?: boolean;
}

export type FinalizeCommitted = {
  tag: "committed";
  results: ReceiveCommandResult[];
  /** post-commit refs_version (edge cache key, T4) */
  refsVersion: string;
  /** newest committer date, for the Worker's registry upsert */
  commitTime: number;
  /** applied updates for the onPush hook — no truncation, unlike x-ref-updates */
  updates: RefUpdate[];
};
export type FinalizeRefConflict = {
  tag: "ref_conflict";
  /** per-command CAS outcomes ("fetch first" per stale command) */
  results: ReceiveCommandResult[];
};
export type FinalizeLeaseMismatch = { tag: "lease_mismatch" };
export type FinalizeReceiveResult =
  | FinalizeCommitted
  | FinalizeRefConflict
  | FinalizeLeaseMismatch;

/** Abandon a lease (scan failure, client gone, size cap hit). Sweeps staging. */
export interface ReleaseReceiveInput {
  leaseToken: string;
  /** true also removes the staging object's catalog trace (T1 failure path) */
  sweep: boolean;
}
export type ReleaseReceiveResult = { tag: "released" } | { tag: "lease_mismatch" };

// ---- Step-2 index RPCs (SPEC-0001a §3 Step 2) -------------------------------

/**
 * One object of the received pack, scanned and resolved by the Worker. The
 * full dgit `pack_objects` column set — verbatim entry re-emission (serve
 * path) and idx v2 need all of it (SPEC-0001a §8 correction 1).
 */
export interface IndexRow {
  oid: string;
  /** entry start offset in the pack (the type/size header) */
  offset: number;
  /** start of the stored (compressed) region */
  dataOff: number;
  /** length of the stored region (incl. REF_DELTA base oid / ofs bytes) */
  dataLen: number;
  type: ObjType;
  /** inflated object size */
  size: number;
  /** inflated entry size (the delta stream for deltas) */
  entrySize: number;
  /** delta base oid, null for full entries */
  baseOid: string | null;
  /** CRC-32 of the raw stored bytes — the idx v2 field */
  crc32: number;
}

export type LookupObjectHit = {
  found: true;
  /** full R2 key of the pack holding the object ("" for loose hits) */
  packKey: string;
  /** entry start offset, -1 for loose hits */
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  baseOid: string | null;
  /** present ONLY for loose hits: loose content lives in DO SQLite, which the
   * Worker cannot read, so the DO ships it inline; packed hits carry no bytes
   * — the Worker R2-reads their entry range itself (SPEC-0001a §3 Step 2).
   * Loose content beyond LOOSE_LOOKUP_CAP is omitted (the Worker then treats
   * the base as unavailable for deltas; presence still holds for
   * connectivity). */
  data?: Uint8Array;
};
export type LookupObjectResult = LookupObjectHit | { found: false };

/** Lease payload JSON persisted with the receive lease row. */
interface LeasePayload {
  stagingKey?: string;
  storageKey?: string;
  /** allocated when the first IndexRow batch lands (pack_meta keys it later) */
  packId?: number;
}

// ---- Step-1/2 semantics notes -----------------------------------------------
// - packBytes === 0 means "no pack" (a deletes-only push): finalize skips the
//   pack work and goes straight to the ref transaction. A real pack is never
//   smaller than 32 bytes, so 0 is unambiguous.
// - objectCount is the Worker scan's unique-object count and idxBytes the
//   emitted idx v2 length (both real from Step 2 on).
// - unpackError carries the Worker scan's actual failure text — report-status
//   renders it verbatim ("unpack <msg>"), replacing Step 1's generic
//   "unpacker error" placeholder.
// - index rows land BEFORE finalize; a crash between them leaves rows whose
//   pack id has no pack_meta entry — sweepOrphanRows (each finalize) and the
//   lease sweeps reclaim them, mirroring the old ingest-crash story.
// - storageKey is the persisted repo name (meta.repo) until SPEC-0003 supplies
//   the D1-minted r_<id>; R2 keys stay per-repo-namespaced either way.

/**
 * How long a receive lease blocks concurrent pushes (T7). Generous enough for
 * a max-size push at modest bandwidth; a crashed holder recovers earlier via
 * the Worker's releaseReceive on abort, and this TTL is the hard backstop that
 * the begin-time/alarm sweep reclaims.
 */
const RECEIVE_LEASE_TTL_MS = 15 * 60 * 1000;
/** T7: the 503 Retry-After value a busy beginReceive hands back. */
const RECEIVE_BUSY_RETRY_AFTER_SECONDS = 10;

/** What a RepoCell contributes to the lease operations (no request state). */
export interface LeaseHost {
  store: GitStore;
  /** transactionSync / setAlarm */
  storage: DurableObjectStorage;
  /** best-effort deletes in the REPO_PACKS bucket (no-op without a binding) */
  deletePackObjects(keys: string[]): Promise<void>;
}

function toCommandResults(results: CommandResult[]): ReceiveCommandResult[] {
  return results.map((r) => ({ ref: r.ref, ok: r.ok, message: r.msg }));
}

/** Control-plane results → protocol CommandResults, for report-status
 * rendering on the Worker side (renderStatus consumes the protocol shape). */
export function asCommandResults(results: ReceiveCommandResult[]): CommandResult[] {
  return toCommandResults(results);
}

function parseLeasePayload(payload: string): LeasePayload {
  try {
    return JSON.parse(payload) as LeasePayload;
  } catch {
    // a corrupt payload leaves no staging/pack id to sweep; the row is
    // authoritative either way
    return {};
  }
}

/** Sweep expired leases plus their staging objects and orphaned index rows.
 * Runs at every beginReceive (so a crashed holder never blocks past its TTL)
 * and from the alarm. */
export async function sweepExpiredLeases(host: LeaseHost): Promise<void> {
  const expired = host.store.expiredLeases(Date.now());
  for (const lease of expired) {
    host.store.deleteLease(lease.leaseToken);
    if (lease.kind !== "receive") continue;
    const payload = parseLeasePayload(lease.payload);
    if (typeof payload.packId === "number") host.store.packs.sweepPackRows(payload.packId);
    if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
  }
}

/**
 * Open a receive lease. Validates refnames BEFORE any byte streams; a single
 * funny refname rejects the whole command section (there is no partial lease).
 * On success the lease is exclusive: the next beginReceive busy-waits (503
 * Retry-After) until finalize/release/expiry.
 */
export async function beginReceive(host: LeaseHost, input: BeginReceiveInput): Promise<BeginReceiveResult> {
  const { store } = host;
  await sweepExpiredLeases(host);
  if (store.hasActiveReceiveLease(Date.now())) {
    return { tag: "busy", retryAfterSeconds: RECEIVE_BUSY_RETRY_AFTER_SECONDS };
  }
  if (input.commands.some((cmd) => !validRefName(cmd.ref))) {
    return {
      tag: "rejected",
      // the whole push is rejected before any byte streams; the message is
      // git's per-ref wording applied to every command in the section
      results: input.commands.map((cmd) => ({ ref: cmd.ref, ok: false, message: "funny refname" })),
    };
  }
  // meta.repo is persisted by the first HTTP request (the advert always
  // precedes a push); until SPEC-0003 it doubles as the storage key
  const storageKey = store.getMeta("repo") ?? "";
  const leaseToken = crypto.randomUUID().replaceAll("-", "");
  const stagingKey = `repos/${storageKey}/staging/pack-rx-${leaseToken}.pack`;
  const leaseExpiresAt = Date.now() + RECEIVE_LEASE_TTL_MS;
  const payload: LeasePayload = { stagingKey, storageKey };
  store.createLease(leaseToken, "receive", leaseExpiresAt, JSON.stringify(payload));
  try {
    // the sweep backstop: fire shortly after expiry even if no push arrives
    await host.storage.setAlarm(leaseExpiresAt + 1000);
  } catch {
    // alarm store busy under a burst; the next beginReceive sweeps instead
  }
  return {
    tag: "ok",
    leaseToken,
    stagingKey,
    storageKey,
    refsVersion: store.refsVersion(),
    refTips: store.refs().map((r) => ({ name: r.name, oid: r.target })),
    leaseExpiresAt,
  };
}

/**
 * Land one bounded batch of Worker-resolved index rows for the lease's pack.
 * The pack id is allocated on the first batch and persisted in the lease
 * payload, so finalize (and every sweep) can name the rows without another
 * channel. `INSERT OR IGNORE` keeps a duplicate oid's FIRST location — the
 * same semantics the DO's own ingest inserts had.
 */
export async function putIndexRows(host: LeaseHost, leaseToken: string, rows: IndexRow[]): Promise<{ tag: "ok" } | { tag: "lease_mismatch" }> {
  const lease = host.store.getLease(leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    return { tag: "lease_mismatch" };
  }
  if (!rows.length) return { tag: "ok" };
  const payload = parseLeasePayload(lease.payload);
  let packId = payload.packId;
  if (typeof packId !== "number") {
    packId = host.store.packs.nextPackId();
    host.store.updateLeasePayload(leaseToken, JSON.stringify({ ...payload, packId }));
    // rows for this pack are readable from this RPC on: prime the backend to
    // the staging object so DO-side reads over the fresh rows (the ancestry
    // walk in validatePush) resolve through R2, not a missing SQLite backend
    if (payload.stagingKey) host.store.packs.primePack(packId, payload.stagingKey);
  }
  host.store.packs.putRows(packId, rows);
  return { tag: "ok" };
}

/**
 * Resolve oids against the object database for the Worker's thin-pack base
 * resolution and connectivity anti-checks (SPEC-0001a §3 Step 2): packed
 * objects return their pack key + entry range (the Worker R2-reads the bytes
 * itself), loose objects return their content inline. Results are
 * index-aligned with the input. A lost lease has no result variant to return —
 * the push is dead regardless, so it surfaces as an RPC failure (transport
 * class, retryable-unknown).
 */
export async function lookupObjects(host: LeaseHost, leaseToken: string, oids: string[]): Promise<LookupObjectResult[]> {
  const lease = host.store.getLease(leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    throw new Error("receive lease invalid for lookupObjects");
  }
  const out = host.store.lookupObjectsForWorker(oids);
  return out;
}

/**
 * Validate, then apply per-command CAS + multi-ref commit + refs_version bump
 * in ONE transactionSync. The pack was already scanned, resolved and indexed
 * by the Worker (rows landed via putIndexRows); finalize records pack_meta,
 * re-checks CAS, and sweeps the staging object so a successful finalize leaves
 * exactly one copy of the pack bytes.
 */
export async function finalizeReceive(host: LeaseHost, input: FinalizeReceiveInput): Promise<FinalizeReceiveResult> {
  const { store } = host;
  const lease = store.getLease(input.leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    return { tag: "lease_mismatch" };
  }
  const leaseData = parseLeasePayload(lease.payload);
  const stagingKey = leaseData.stagingKey ?? "";
  const packId = typeof leaseData.packId === "number" ? leaseData.packId : null;
  // re-prime the backend cache (it is in-memory and this DO instance may have
  // been recycled since the rows landed): validatePush's ancestry walk reads
  // the fresh rows through the staging object until recordPack re-points at
  // the copied packs/ key
  if (packId !== null && stagingKey) store.packs.primePack(packId, stagingKey);

  // reclaim SQLite debris of crashed ingests: rows whose pack id never
  // reached pack_meta. The lease's own pack (rows landed mid-receive) is kept.
  store.packs.sweepOrphanRows(packId);

  // object-reading validation first (async: the ancestry walk reads stored
  // objects over the network, which transactionSync cannot await), then the
  // ref writes and version bump under one savepoint — a multi-ref push must
  // not leave half its branches moved. Exactly one receive lease can be in
  // this window. The Worker's scan already resolved every delta and ran the
  // connectivity anti-check; validatePush consumes its verdict.
  const plan = await validatePush(store, input.commands, input.unpackError, {
    packId,
    packIncomplete: input.packIncomplete === true,
  });
  const outcome = host.storage.transactionSync(() => {
    // the lease may have been swept/released while the async passes ran
    const live = store.getLease(input.leaseToken);
    if (!live || live.kind !== "receive") return { lost: true as const };
    if (store.refsVersion() !== input.expectedRefsVersion) {
      // a push landed in between: every command is behind ("fetch first")
      return {
        lost: false as const,
        results: input.commands.map((c) => ({ ref: c.ref, ok: false, msg: "fetch first" })),
        changed: false,
        needsGc: false,
      };
    }
    // record the pack catalog entry inside the transaction that first points
    // refs at it. A refs_version mismatch above skips this — the abandoned
    // copy's rows are orphaned and reclaimed by a later sweep.
    const hasPack = input.unpackError === null && input.pack.packBytes > 0;
    if (hasPack) {
      const id = packId ?? store.packs.nextPackId(); // 0-entry packs never allocated one
      store.packs.recordPack(id, input.pack.packBytes, input.pack.packKey);
    }
    // DO-side guard for "no ref may point into unindexed storage": every
    // non-null new tip must be present in the store before the CAS commits
    for (let i = 0; i < plan.decisions.length; i++) {
      const tip = input.newTips[i];
      if (!plan.decisions[i].reject && tip !== null && tip !== undefined && !store.has(tip)) {
        plan.decisions[i] = { ref: plan.decisions[i].ref, expectedOld: plan.decisions[i].expectedOld, reject: "missing necessary objects" };
      }
    }
    const applied = commitPush(store, plan);
    if (applied.changed) {
      store.setMeta("created", "1");
      store.setMeta("last-push", String(Date.now()));
      store.bumpRefsVersion();
    }
    return { lost: false as const, ...applied };
  });
  if (outcome.lost) return { tag: "lease_mismatch" };
  const { results, changed, needsGc } = outcome;

  if (needsGc) {
    store.setMeta("gc-pending", "1");
    try {
      await host.storage.setAlarm(Date.now() + 5 * 60 * 1000);
    } catch (err) {
      console.log(`[receive] gc alarm deferred: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // the lease is decided: drop the row and sweep the staging object (the copy
  // in packs/ stays — on a committed push it IS the pack; on a failed one it
  // is unreferenced bytes the orphan sweep reclaims)
  store.deleteLease(input.leaseToken);
  if (stagingKey) await host.deletePackObjects([stagingKey]);

  // the updates a push actually applied. results[i] is the outcome of
  // commands[i] — the join is by index, not ref name: a crafted request can
  // send two commands for the same ref, and a name join would let the
  // rejected one inherit the applied one's success.
  const updates: RefUpdate[] = input.commands
    .filter((_, i) => results[i]?.ok === true)
    .map((c) => ({ ref: c.ref, old: c.old, new: c.next }));

  if (!changed && results.some((r) => !r.ok && r.msg === "fetch first")) {
    return { tag: "ref_conflict", results: toCommandResults(results) };
  }
  return {
    tag: "committed",
    results: toCommandResults(results),
    refsVersion: store.refsVersion(),
    commitTime: changed ? await latestCommitTime(store) : 0,
    updates,
  };
}

/**
 * Abandon a lease (scan failure, client gone, size cap hit). `sweep` also
 * removes the staging object and any index rows the Worker already pushed. A
 * lease finalize already decided is `lease_mismatch` — finalize is
 * idempotent-on-lease_mismatch, so a Worker retrying after a transport failure
 * can always call this.
 */
export async function releaseReceive(host: LeaseHost, input: ReleaseReceiveInput): Promise<ReleaseReceiveResult> {
  const lease = host.store.getLease(input.leaseToken);
  if (!lease || lease.kind !== "receive") return { tag: "lease_mismatch" };
  host.store.deleteLease(input.leaseToken);
  if (input.sweep) {
    const payload = parseLeasePayload(lease.payload);
    if (typeof payload.packId === "number") host.store.packs.sweepPackRows(payload.packId);
    if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
  }
  return { tag: "released" };
}

/** The zero pack a deletes-only push carries (see the semantics notes above). */
export const NO_PACK: FinalizedPack = {
  packKey: "",
  packSha1: ZERO_OID,
  packBytes: 0,
  objectCount: 0,
  idxBytes: 0,
};
