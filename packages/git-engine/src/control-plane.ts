/**
 * Receive control plane (SPEC-0001a §3 Step 1).
 *
 * The push data plane (pkt-line parse, pack staging, staging→packs copy) runs
 * in the Worker; the DO keeps refs, the object index, and the receive LEASE.
 * These are the three public RPCs on `RepoCell` (exposed as Workers RPC), and
 * every application outcome crosses the boundary as a tagged union — never a
 * thrown error (transport failures still throw and are retryable-unknown:
 * finalize is idempotent-on-`lease_mismatch` and the lease expiry sweep makes
 * retry safe).
 */
import { ObjCache } from "./git/packstore";
import {
  commitPush,
  latestCommitTime,
  validatePush,
  validRefName,
  CommandResult,
  PushCommand,
} from "./git/protocol";
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

// ---- Step-1 semantics notes (SPEC-0001a §3 Step 1) ------------------------
// - packBytes === 0 means "no pack" (a deletes-only push): finalize skips the
//   ingest and goes straight to the ref transaction. A real pack is never
//   smaller than 32 bytes, so 0 is unambiguous.
// - idxBytes is always 0 in Step 1: idx v2 emission is the Worker's job from
//   Step 2 on (SPEC-0001a §3 Step 2).
// - objectCount is advisory in Step 1 (read off the pack header by the Worker);
//   the DO's own scan re-derives the true count and its structural checks bind.
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
  /** ingest cache budget in bytes (env INGEST_CACHE_MB, default 16 on Workers) */
  ingestCacheBytes: number;
  /** screen every object with SHA-1DC (env SHA1DC === "1") */
  collisionDetect: boolean;
  /** best-effort deletes in the REPO_PACKS bucket (no-op without a binding) */
  deletePackObjects(keys: string[]): Promise<void>;
}

function toCommandResults(results: CommandResult[]): ReceiveCommandResult[] {
  return results.map((r) => ({ ref: r.ref, ok: r.ok, message: r.msg }));
}

/** Control-plane results → protocol CommandResults, for report-status
 * rendering on the Worker side (renderStatus consumes the protocol shape). */
export function asCommandResults(results: ReceiveCommandResult[]): CommandResult[] {
  return toCommandResultsFromInput(results);
}

function toCommandResultsFromInput(results: ReceiveCommandResult[]): CommandResult[] {
  return results.map((r) => ({ ref: r.ref, ok: r.ok, msg: r.message }));
}

/** Sweep expired leases and their staging objects. Runs at every beginReceive
 * (so a crashed holder never blocks past its TTL) and from the alarm. */
export async function sweepExpiredLeases(host: LeaseHost): Promise<void> {
  const expired = host.store.expiredLeases(Date.now());
  for (const lease of expired) {
    host.store.deleteLease(lease.leaseToken);
    if (lease.kind !== "receive") continue;
    try {
      const payload = JSON.parse(lease.payload) as { stagingKey?: string };
      if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
    } catch {
      // a corrupt payload must not keep the lease row alive; it is gone already
    }
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
  store.createLease(leaseToken, "receive", leaseExpiresAt, JSON.stringify({ stagingKey, storageKey }));
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
 * Ingest (from the R2 object the Worker staged and copied — never the request
 * stream), validate connectivity, then apply per-command CAS + multi-ref
 * commit + refs_version bump in ONE transactionSync. The copied packs/ object
 * is recorded in pack_meta with its R2 key; the staging object is swept here so
 * a successful finalize leaves exactly one copy.
 */
export async function finalizeReceive(host: LeaseHost, input: FinalizeReceiveInput): Promise<FinalizeReceiveResult> {
  const { store } = host;
  const lease = store.getLease(input.leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    return { tag: "lease_mismatch" };
  }
  let stagingKey = "";
  try {
    stagingKey = (JSON.parse(lease.payload) as { stagingKey?: string }).stagingKey ?? "";
  } catch {
    // treat as empty; the sweep below then only clears the row
  }

  // unpacker/scan failures force every command to fail (the scan ran here in
  // Step 1; from Step 2 the Worker supplies unpackError for its own scan)
  let unpackError = input.unpackError;
  let packId: number | null = null;
  const hasPack = unpackError === null && input.pack.packBytes > 0;
  if (hasPack) {
    try {
      const ingested = await store.packs.ingestStored(input.pack.packKey, input.pack.packBytes, {
        cache: new ObjCache(host.ingestCacheBytes),
        flush: () => host.storage.sync(),
        collisionDetect: host.collisionDetect,
      });
      packId = ingested.packId;
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  // object-reading validation first (async: R2-backed objects are fetched over
  // the network, which transactionSync cannot await), then the ref writes and
  // version bump under one savepoint — a multi-ref push must not leave half
  // its branches moved. Exactly one receive lease can be in this window.
  const plan = await validatePush(store, input.commands, unpackError, packId);
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
 * removes the staging object. A lease finalize already decided is
 * `lease_mismatch` — finalize is idempotent-on-lease_mismatch, so a Worker
 * retrying after a transport failure can always call this.
 */
export async function releaseReceive(host: LeaseHost, input: ReleaseReceiveInput): Promise<ReleaseReceiveResult> {
  const lease = host.store.getLease(input.leaseToken);
  if (!lease || lease.kind !== "receive") return { tag: "lease_mismatch" };
  host.store.deleteLease(input.leaseToken);
  if (input.sweep) {
    try {
      const payload = JSON.parse(lease.payload) as { stagingKey?: string };
      if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
    } catch {
      // row is gone either way; a corrupt payload leaves no staging to sweep
    }
  }
  return { tag: "released" };
}

/** The zero pack a deletes-only push carries (see the Step-1 notes above). */
export const NO_PACK: FinalizedPack = {
  packKey: "",
  packSha1: ZERO_OID,
  packBytes: 0,
  objectCount: 0,
  idxBytes: 0,
};
