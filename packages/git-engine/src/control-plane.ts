/**
 * Receive control plane (SPEC-0001a §3 Steps 1-2) and repo lifecycle RPCs
 * (SPEC-0003 §2.5.5).
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
 *
 * Step 3 pins the storage_key contract: every R2 key is built by
 * src/git/r2keys.ts from ONE immutable storage key, resolved per receive as
 *
 *   1. `input.storageKey` — the Worker's explicit value, and
 *   2. meta.storage_key   — the persisted one, else
 *   3. meta.repo          — the legacy name-addressed fallback.
 *
 * The resolution is persisted to meta.storage_key on first touch (meta.repo
 * migrates transparently; today the repo name IS the storage key until
 * SPEC-0003 supplies the D1-minted r_<id>). The WORKER→DO transport for (1)
 * is the `x-storage-key` HTTP request header on POST /git-receive-pack:
 * cf-gitea's git-http gate sets it from the D1 `repositories.storage_key`
 * row before delegating; the engine's receive flow reads it and passes it
 * here. Absent header ⇒ the fallback chain (documented behavior, not an
 * error) so the stock dgit Worker keeps working without it.
 */
import {
  commitPush,
  latestCommitTime,
  validatePush,
  validRefName,
  CommandResult,
  PushCommand,
} from "./git/protocol";
import { ObjType, hashObject, parseCommit } from "./git/objects";
import { ZERO_OID, isOid, toHex } from "./git/util";
import { isValidStorageKey, packR2Key, stagingKey as buildStagingKey, packName as catalogPackName } from "./git/r2keys";
import type { PackState } from "./git/packstore";
import type { GitStore } from "./git/store";
import type { RefUpdate } from "./mod";
import { serializeCommit, serializeTag, personLine } from "./commit/serialize";
import { mergeBase as graphMergeBase, listCommitsRange as graphListCommitsRange, countDivergence as graphCountDivergence, resolveCommitish } from "./merge/graph";
import { checkMergeability as classifyMergeability, executeMerge as runExecuteMerge } from "./merge/engine";
import { rebaseOnto as runRebaseOnto } from "./merge/rebase";
import type {
  ExtraRefUpdate,
  CheckMergeabilityInput,
  CheckMergeabilityResult,
  ExecuteMergeInput,
  ExecuteMergeResult,
  RebaseOntoInput,
  RebaseOutcome,
  DeleteApiRefInput,
  DeleteApiRefResult,
} from "./merge/types";
import type { MergeObject } from "./merge/tree";
import type {
  CatalogPage,
  CatalogPackEntry,
  BeginForkImportResult,
  AdoptForkPacksResult,
  FinalizeForkImportInput,
  FinalizeForkImportResult,
} from "./fork/types";

// the SPEC-0001b §4 RPC contract types ride the control-plane boundary (the
// dist-types generation consumes this module's exports)
export type {
  CheckMergeabilityInput,
  CheckMergeabilityResult,
  DeleteApiRefInput,
  DeleteApiRefResult,
  ExecuteMergeInput,
  ExecuteMergeResult,
  ExtraRefUpdate,
  MergeabilityStatus,
  MergeStyle,
  RebaseOntoInput,
  RebaseOutcome,
  RebasedCommit,
} from "./merge/types";
export type { MergeConflictPath, MergeObject, MergePlan, TreeChange } from "./merge/tree";
// the SPEC-0001b §5.3 fork-replication contract types ride the same boundary
export type {
  AdoptForkPacksResult,
  BeginForkImportResult,
  CatalogPage,
  CatalogPackEntry,
  FinalizeForkImportInput,
  FinalizeForkImportOk,
  FinalizeForkImportResult,
  ForkInvalid,
} from "./fork/types";

/** Per-call budget for one putApiObjects/putRebaseObjects call — total bytes
 * across the objects, default 8 MiB (SPEC-0001a §4.3: API_COMMIT_MAX_BYTES). */
export const API_COMMIT_MAX_BYTES = 8 * 1024 * 1024;

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
  /**
   * OPTIONAL immutable storage key (r_<id>) from the Worker's D1 row
   * (SPEC-0001a §3 Step 3; transported as the `x-storage-key` request header
   * — see the module doc). Absent/invalid ⇒ meta.storage_key, else meta.repo.
   * The chosen value is persisted to meta.storage_key so alarm/sweep paths
   * can rebuild keys without a request.
   */
  storageKey?: string | null;
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
/** A fork import is in flight (meta.importing, SPEC-0001b §5.3): pushes are
 * refused until the replication loop finalizes. Distinct from `busy` so the
 * Worker can answer 503 with an import-aware retry hint instead of spinning
 * on a lease that will never free. */
export type BeginReceiveImporting = { tag: "importing" };
export type BeginReceiveRejected = {
  tag: "rejected";
  /** per-command refname-validation failures (checked BEFORE any byte streams) */
  results: ReceiveCommandResult[];
};
export type BeginReceiveResult =
  | BeginReceiveOk
  | BeginReceiveBusy
  | BeginReceiveImporting
  | BeginReceiveRejected;

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
  /** PR-head (and similar housekeeping) ref updates applied in the SAME
   * transaction as `commands` (SPEC-0001b §4.7), CAS'd per entry, but
   * EXCLUDED from `results` (which stays index-aligned with the client's
   * commands — report-status must never name a ref the client did not send)
   * and INCLUDED in `updates` (hooks/webhooks see them). An entry whose CAS
   * mismatches (or whose object is missing) is skipped — housekeeping never
   * fails the user's push; the Queue worker's next check re-syncs the ref. */
  extraRefUpdates?: ExtraRefUpdate[];
}

export type FinalizeCommitted = {
  tag: "committed";
  results: ReceiveCommandResult[];
  /** post-commit refs_version (edge cache key, T4; formal meta key per
   * SPEC-0001 §4 — bumped inside the commit transaction) */
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
  /** the pack NAME (pack-<sha1>, r2keys.ts) — set by the Worker's first
   * putIndexRows batch; pack_catalog keys the rows by it at finalize */
  packName?: string;
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
//   pack name has no pack_catalog entry — sweepOrphanRows (each finalize) and
//   the lease sweeps reclaim them, mirroring the old ingest-crash story.
// - storageKey: until SPEC-0003 supplies the D1-minted r_<id>, the persisted
//   repo name doubles as the storage key; R2 keys stay per-repo-namespaced
//   either way and every construction goes through src/git/r2keys.ts.

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
  /**
   * Range-read the TAIL of an R2 object. fork replication's adopt/finalize
   * verify a copied pack's 20-byte SHA-1 trailer against its catalog key —
   * the same name↔bytes check receive's finalize does against the r2keys.ts
   * derivation. Optional: hosts without an R2 backend (stock dgit / celld)
   * cannot verify, and adoptForkPacks/finalizeForkImport fail closed without
   * it (fork replication requires the bucket, exactly like receive does).
   */
  readPackTail?(r2Key: string, len: number): Promise<Uint8Array | null>;
  /**
   * The repo's registry bookkeeping (registry.remove), for destroy()'s
   * remove hook. Optional: the stock dgit Worker may run without a registry.
   */
  removeFromRegistry?(name: string): Promise<void>;
}

function toCommandResults(results: CommandResult[]): ReceiveCommandResult[] {
  return results.map((r) => ({ ref: r.ref, ok: r.ok, message: r.msg }));
}

/** Control-plane results → protocol CommandResults, for report-status
 * rendering on the Worker side (renderStatus consumes the protocol shape).
 * The inverse of toCommandResults: ReceiveCommandResult carries `message`,
 * CommandResult carries `msg` — mapping via the other direction drops the
 * ng text and report-status renders a literal "undefined". */
export function asCommandResults(results: ReceiveCommandResult[]): CommandResult[] {
  return results.map((r) => ({ ref: r.ref, ok: r.ok, msg: r.message }));
}

function parseLeasePayload(payload: string): LeasePayload {
  try {
    return JSON.parse(payload) as LeasePayload;
  } catch {
    // a corrupt payload leaves no staging/pack name to sweep; the row is
    // authoritative either way
    return {};
  }
}

/**
 * The repo's storage key (SPEC-0001a §3 Step 3): `explicit` when valid, else
 * the persisted meta.storage_key, else meta.repo. The resolution is persisted
 * to meta.storage_key on first touch, so later request-less paths (alarm
 * sweeps, GC, clone-cache probes) rebuild identical keys.
 */
function resolveStorageKey(store: GitStore, explicit?: string | null): string {
  const chosen =
    (explicit && isValidStorageKey(explicit) ? explicit : null) ??
    store.getMeta("storage_key") ??
    store.getMeta("repo") ??
    "";
  if (chosen && store.getMeta("storage_key") !== chosen) {
    // migrate meta.repo → meta.storage_key on first touch (clean cutover: the
    // legacy meta.repo key is retained for the UI/registry name, which the
    // storage key may legitimately differ from once SPEC-0003 lands)
    store.setMeta("storage_key", chosen);
  }
  return chosen;
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
    if (payload.packName) host.store.packs.sweepPackRows(payload.packName);
    if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
  }
}

/** True when the repo is tombstoned (meta.deleted, markDeleted below). */
function isDeleted(store: GitStore): boolean {
  return store.getMeta("deleted") === "1";
}

/** True while a fork catalog import is in flight (meta.importing, §5.3). */
function isImporting(store: GitStore): boolean {
  return store.getMeta("importing") === "1";
}

/**
 * Open a receive lease. Validates refnames BEFORE any byte streams; a single
 * funny refname rejects the whole command section (there is no partial lease).
 * A tombstoned repo (markDeleted) rejects the push outright — deleted repos
 * never take leases (SPEC-0003 §2.5.5 step 2). On success the lease is
 * exclusive: the next beginReceive busy-waits (503 Retry-After) until
 * finalize/release/expiry.
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
  if (isDeleted(store)) {
    return {
      tag: "rejected",
      results: input.commands.map((cmd) => ({ ref: cmd.ref, ok: false, message: "repository deleted" })),
    };
  }
  if (isImporting(store)) {
    // a fork's catalog is being replicated into this repo (§5.3): no push can
    // race it, so the client sees a clean refusal instead of missing objects
    return { tag: "importing" };
  }
  const storageKey = resolveStorageKey(store, input.storageKey);
  const leaseToken = crypto.randomUUID().replaceAll("-", "");
  const stagingKey = buildStagingKey(storageKey, leaseToken);
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
    refTips: store.refs().map((r) => ({ name: r.name, oid: r.oid })),
    leaseExpiresAt,
  };
}

/**
 * Land one bounded batch of Worker-resolved index rows for the lease's pack.
 * `packName` (r2keys.packName(packSha1)) is the deterministic catalog key the
 * Worker already derives from the staged pack's trailer; the FIRST batch
 * records it in the lease payload, so finalize (and every sweep) can name the
 * rows without another channel. Rows are keyed under that name from the start
 * — no integer pack id exists anymore (SPEC-0001a §3 Step 4: pack_catalog is
 * string-keyed). `INSERT OR IGNORE` keeps a duplicate oid's FIRST location.
 */
export async function putIndexRows(
  host: LeaseHost,
  leaseToken: string,
  packName: string,
  rows: IndexRow[]
): Promise<{ tag: "ok" } | { tag: "lease_mismatch" }> {
  const lease = host.store.getLease(leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    return { tag: "lease_mismatch" };
  }
  if (!rows.length) return { tag: "ok" };
  const payload = parseLeasePayload(lease.payload);
  if (payload.packName && payload.packName !== packName) {
    // one lease = one pack; a second name under the same lease is a caller bug
    return { tag: "lease_mismatch" };
  }
  if (!payload.packName) {
    if (!isValidPackName(packName)) return { tag: "lease_mismatch" };
    host.store.updateLeasePayload(leaseToken, JSON.stringify({ ...payload, packName }));
    // rows for this pack are readable from this RPC on: prime the backend to
    // the staging object so DO-side reads over the fresh rows (the ancestry
    // walk in validatePush) resolve through R2, not a missing catalog row
    if (payload.stagingKey) host.store.packs.primePack(packName, payload.stagingKey);
  }
  host.store.packs.putRows(packName, rows);
  return { tag: "ok" };
}

/** pack-<40 hex> — the only shape putIndexRows accepts as a pack name. */
function isValidPackName(name: string): boolean {
  return /^pack-[0-9a-f]{40}$/.test(name);
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
 * by the Worker (rows landed via putIndexRows); finalize records pack_catalog,
 * re-checks CAS, and sweeps the staging object so a successful finalize leaves
 * exactly one copy of the pack bytes. A repo tombstoned mid-flight aborts
 * here: the lease is released, the staging object swept, and every command
 * fails (SPEC-0003 §2.5.5 §4.2 — the Worker's retry then hits the tombstone
 * rejection at beginReceive, so the client always sees a sideband failure).
 */
export async function finalizeReceive(host: LeaseHost, input: FinalizeReceiveInput): Promise<FinalizeReceiveResult> {
  const { store } = host;
  const lease = store.getLease(input.leaseToken);
  if (!lease || lease.kind !== "receive" || lease.expiresAt <= Date.now()) {
    return { tag: "lease_mismatch" };
  }
  if (isDeleted(store)) {
    store.deleteLease(input.leaseToken);
    const dead = parseLeasePayload(lease.payload);
    if (dead.packName) store.packs.sweepPackRows(dead.packName);
    if (dead.stagingKey) await host.deletePackObjects([dead.stagingKey]);
    return { tag: "lease_mismatch" };
  }
  const leaseData = parseLeasePayload(lease.payload);
  const stagingKey = leaseData.stagingKey ?? "";
  const packName = leaseData.packName ?? null;
  // re-prime the backend cache (it is in-memory and this DO instance may have
  // been recycled since the rows landed): validatePush's ancestry walk reads
  // the fresh rows through the staging object until recordPack re-points at
  // the copied packs/ key
  if (packName && stagingKey) store.packs.primePack(packName, stagingKey);

  // reclaim SQLite debris of crashed ingests: rows whose pack name never
  // reached pack_catalog. The lease's own pack (rows landed mid-receive) is
  // kept.
  store.packs.sweepOrphanRows(packName);

  // object-reading validation first (async: the ancestry walk reads stored
  // objects over the network, which transactionSync cannot await), then the
  // ref writes and version bump under one savepoint — a multi-ref push must
  // not leave half its branches moved. Exactly one receive lease can be in
  // this window. The Worker's scan already resolved every delta and ran the
  // connectivity anti-check; validatePush consumes its verdict.
  const plan = await validatePush(store, input.commands, input.unpackError, {
    packKey: packName,
    packIncomplete: input.packIncomplete === true,
  });
  const outcome = host.storage.transactionSync(() => {
    // the lease may have been swept/released/tombstoned while the async
    // passes ran (SPEC-0003 §4.2: the tombstone check sits INSIDE the commit
    // transaction)
    const live = store.getLease(input.leaseToken);
    if (!live || live.kind !== "receive" || isDeleted(store)) return { lost: true as const };
    if (store.refsVersion() !== input.expectedRefsVersion) {
      // a push landed in between: every command is behind ("fetch first")
      return {
        lost: false as const,
        results: input.commands.map((c) => ({ ref: c.ref, ok: false, msg: "fetch first" })),
        changed: false,
        needsGc: false,
        extraApplied: [] as RefUpdate[],
      };
    }
    // record the pack catalog entry inside the transaction that first points
    // refs at it. A refs_version mismatch above skips this — the abandoned
    // copy's rows are orphaned and reclaimed by a later sweep. The catalog
    // key is the pack NAME; the Worker's copy key is verified against the
    // r2keys.ts derivation, so a namespace fork can never be committed over.
    const hasPack = input.unpackError === null && input.pack.packBytes > 0;
    if (hasPack) {
      // A zero-object pack (the tips the server already has — e.g. pushing a
      // second branch that points at a known commit) never lands an index
      // row, so the lease payload carries no pack name. Derive it from the
      // pack's own trailer hash — exactly the name the Worker used for the
      // final R2 keys. A pack WITH objects must have landed rows through
      // putIndexRows (any row-landing failure sets unpackError, which
      // already forces hasPack false); a missing name there stays a reject.
      const name = packName ?? (input.pack.objectCount === 0 ? catalogPackName(input.pack.packSha1) : null);
      if (!name || !isValidPackName(name)) {
        return {
          lost: false as const,
          results: input.commands.map((c) => ({ ref: c.ref, ok: false, msg: "unpacker error" })),
          changed: false,
          needsGc: false,
          extraApplied: [] as RefUpdate[],
        };
      }
      const derived = packR2Key(leaseData.storageKey ?? "", name);
      if (input.pack.packKey !== derived) {
        return {
          lost: false as const,
          results: input.commands.map((c) => ({ ref: c.ref, ok: false, msg: "unpacker error" })),
          changed: false,
          needsGc: false,
          extraApplied: [] as RefUpdate[],
        };
      }
      store.packs.recordPack(name, input.pack.packBytes, input.pack.idxBytes);
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
    // PR-head (and similar housekeeping) choreography rides the SAME
    // transaction (SPEC-0001b §4.7): CAS per entry, best-effort — an entry
    // whose CAS mismatches or whose object is missing is skipped (never
    // fails the user's push; the Queue worker re-syncs). Excluded from
    // `results` (index-aligned with the client's commands only), included in
    // `updates`.
    const extraApplied: RefUpdate[] = [];
    for (const x of input.extraRefUpdates ?? []) {
      if (!validRefName(x.ref)) continue;
      const cur = store.getRef(x.ref) ?? ZERO_OID;
      if (cur !== x.expectedOldOid) continue;
      if (x.newOid !== null && !store.has(x.newOid)) continue;
      if (x.newOid === null) {
        if (cur !== ZERO_OID) store.delRef(x.ref);
      } else {
        store.setRef(x.ref, x.newOid);
      }
      extraApplied.push({ ref: x.ref, old: x.expectedOldOid, new: x.newOid ?? ZERO_OID });
    }
    if (applied.changed || extraApplied.length) {
      if (applied.changed) {
        store.setMeta("created", "1");
        store.setMeta("last-push", String(Date.now()));
      }
      store.bumpRefsVersion();
    }
    return { lost: false as const, ...applied, extraApplied };
  });
  if (outcome.lost) return { tag: "lease_mismatch" };
  const { results, changed, needsGc } = outcome;

  if (needsGc) {
    store.setMeta("gc-pending", "1");
    // the formal M3 trigger key (SPEC-0001 §4): written alongside the M2
    // gc-pending flag; compaction consumes it, nothing reads it yet
    store.setMeta("compaction_wanted_at", String(Date.now()));
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
  // rejected one inherit the applied one's success. The PR-head extras that
  // rode the same transaction are appended here (hooks/webhooks see them;
  // report-status results never name them).
  const updates: RefUpdate[] = [
    ...input.commands
      .filter((_, i) => results[i]?.ok === true)
      .map((c) => ({ ref: c.ref, old: c.old, new: c.next })),
    ...outcome.extraApplied,
  ];

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
    if (payload.packName) host.store.packs.sweepPackRows(payload.packName);
    if (payload.stagingKey) await host.deletePackObjects([payload.stagingKey]);
  }
  return { tag: "released" };
}

// ---- repo lifecycle RPCs (SPEC-0003 §2.5.5) ---------------------------------

export type MarkDeletedResult = { tag: "ok" };

/**
 * Tombstone the repo (delete pipeline step 2, AFTER the D1 row is gone).
 * Sets meta.deleted=1 in one transaction; idempotent. Effects:
 *   - beginReceive refuses new leases ("repository deleted");
 *   - finalizeReceive on a repo tombstoned mid-flight aborts inside its commit
 *     transaction, releases the lease, and sweeps the staging object;
 *   - reads/refs keep answering until destroy() (nothing can reach them once
 *     the D1 row is gone, and refs never dangle because they live here).
 * Deliberately does NOT wait out an active receive lease: the pipeline's step
 * 1 already removed the D1 row, so any in-flight push is doomed regardless.
 */
export function markDeleted(host: LeaseHost): MarkDeletedResult {
  host.storage.transactionSync(() => {
    host.store.setMeta("deleted", "1");
  });
  return { tag: "ok" };
}

export type DestroyResult = { tag: "ok" };

/**
 * Destroy the repo cell (delete pipeline step 4, AFTER the R2 prefix purge —
 * this does NOT touch R2): one transactional wipe (SQLite schema dropped and
 * re-created empty — Rule 3, no blockConcurrencyWhile), alarm cleared, then
 * the registry row removed via the host hook. Idempotent: destroying a
 * destroyed (or never-created) cell re-initializes an empty one. The caller
 * should have called markDeleted first (SPEC-0003 §2.5.5 order: D1 row →
 * tombstone → queue purge → destroy), but destroy does not require it.
 */
export async function destroy(host: LeaseHost): Promise<DestroyResult> {
  const name = host.store.getMeta("repo") ?? host.store.getMeta("storage_key") ?? "";
  // one transaction: the whole wipe (drop + re-create) is atomic for callers
  host.storage.transactionSync(() => {
    host.store.wipe();
  });
  try {
    await host.storage.deleteAlarm();
  } catch {
    // no alarm set, or the alarm store is busy — nothing to sweep either way
  }
  if (host.removeFromRegistry && name) {
    try {
      await host.removeFromRegistry(name);
    } catch (err) {
      // best effort: the queue consumer removes the row independently
      console.log(`[destroy ${name}] registry remove failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { tag: "ok" };
}

export type SetHeadResult =
  | { tag: "ok"; head: string }
  | { tag: "invalid"; reason: string }
  | { tag: "not_found" };

/**
 * Default-branch setter (SPEC-0003 §2.5.2: later explicit default-branch
 * changes update DO meta.head via CAS). Accepts a bare branch name or a full
 * `refs/heads/...` ref; anything else (tags, invalid names) is `invalid`. The
 * branch may be unborn on an empty repo (the instance default), but on a repo
 * with branches the target must exist — `not_found` otherwise. Bumps
 * refs_version: HEAD changes the advertisement (symref capability, HEAD
 * advert line) and the clone-cache key.
 */
export function setHead(host: LeaseHost, branch: string): SetHeadResult {
  const { store } = host;
  const refName = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  if (!validRefName(refName)) {
    return { tag: "invalid", reason: `not a valid branch name: ${branch}` };
  }
  const short = refName.slice("refs/heads/".length);
  if (!short) {
    return { tag: "invalid", reason: `not a branch name: ${branch}` };
  }
  const branches = store.refs().filter((r) => r.name.startsWith("refs/heads/"));
  if (branches.length > 0 && !branches.some((b) => b.name === refName)) {
    return { tag: "not_found" };
  }
  host.storage.transactionSync(() => {
    store.setHead(refName);
    store.bumpRefsVersion();
  });
  return { tag: "ok", head: refName };
}

/** The zero pack a deletes-only push carries (see the semantics notes above). */
export const NO_PACK: FinalizedPack = {
  packKey: "",
  packSha1: ZERO_OID,
  packBytes: 0,
  objectCount: 0,
  idxBytes: 0,
};

// ---- API-side commit builder (SPEC-0001a §4) ---------------------------------
// Objects are constructed Worker-side (data plane) and land here: re-verified,
// stored into the loose objects/chunks tables, then the ref moves via CAS in
// one transactionSync. The builder takes NO receive lease (§4.5) — correctness
// rests on CAS + content addressing, the same posture executeMerge reuses for
// the SPEC-0001b landing.

/** One canonical git object built in the Worker. `data` is the canonical git
 * serialization (NOT zlib-deflated — storage deflation is GitStore.put's job). */
export interface ApiObject {
  /** Worker-computed sha1(header + content); the DO re-verifies before storing */
  oid: string;
  type: ObjType;
  data: Uint8Array;
}

export type PutApiObjectsResult =
  | { tag: "ok"; stored: number }
  | { tag: "too_large"; limitBytes: number }
  | { tag: "invalid"; reason: string }; // oid/type mismatch or oversized object

export interface CommitApiChangeInput {
  /** full ref name; must pass the same refname validation as receive */
  ref: string;
  /** CAS base: the ref tip the caller built on; ZERO_OID = create-on-empty */
  expectedOldOid: string;
  /** target oid; must already be stored (by putApiObjects, or pre-existing) */
  newOid: string;
}

export type CommitApiCommitted = {
  tag: "committed";
  ref: string;
  oldOid: string; // actual pre-commit tip (== expectedOldOid)
  newOid: string;
  /** post-commit refs_version — same edge-cache key a push bumps (T4) */
  refsVersion: string;
  /** newest committer date, for the Worker's registry upsert */
  commitTime: number;
};
export type CommitApiRefConflict = {
  tag: "ref_conflict";
  /** current tip, so the caller can retry atop it (SPEC-0004 maps to 409) */
  currentOid: string;
};
export type CommitApiInvalid = { tag: "invalid"; reason: string };
export type CommitApiImporting = { tag: "importing" };
export type CommitApiChangeResult =
  | CommitApiCommitted
  | CommitApiRefConflict
  | CommitApiInvalid
  | CommitApiImporting;

/**
 * Verify + store a batch of Worker-built objects. Idempotent (content-
 * addressed; an existing oid is a no-op), so retries and concurrent writers
 * are safe. Every object is re-hashed BEFORE storing — a Worker oid/type
 * mismatch is `invalid`, never a corrupted store entry. Partial writes from a
 * transport failure are harmless: unreferenced loose objects are reclaimed by
 * the sweep (GC today, M3 compaction).
 */
export async function putApiObjects(host: LeaseHost, objects: ApiObject[]): Promise<PutApiObjectsResult> {
  let total = 0;
  for (const o of objects) total += o.data.length;
  if (total > API_COMMIT_MAX_BYTES) return { tag: "too_large", limitBytes: API_COMMIT_MAX_BYTES };
  for (const o of objects) {
    if (!isOid(o.oid)) return { tag: "invalid", reason: `malformed oid: ${o.oid.slice(0, 12)}…` };
    if (hashObject(o.type, o.data) !== o.oid) {
      return { tag: "invalid", reason: `oid/type mismatch for ${o.oid.slice(0, 12)}…` };
    }
  }
  for (const o of objects) host.store.put(o.oid, o.type, o.data);
  return { tag: "ok", stored: objects.length };
}

/**
 * One CAS ref landing in a single transactionSync (SPEC-0001a §4.3): refname
 * validation → presence check (`store.has(newOid)`; for a commit target also
 * its root tree) → CAS → ref write (+ the tag peel cached on the refs row for
 * tag targets, computed BEFORE the transaction — transactionSync cannot await)
 * → `refs_version` bump → the commitPush HEAD fixup → commitTime. Cannot
 * delete refs: branch/PR ref deletes route to deleteApiRef (SPEC-0001b §4.8).
 */
export async function commitApiChange(host: LeaseHost, input: CommitApiChangeInput): Promise<CommitApiChangeResult> {
  const { store } = host;
  // a fork import in flight gates every ref-moving landing (§5.3)
  if (isImporting(store)) return { tag: "importing" };
  if (!validRefName(input.ref)) return { tag: "invalid", reason: `funny refname: ${input.ref}` };
  if (!isOid(input.newOid)) return { tag: "invalid", reason: "malformed new oid" };
  if (!store.has(input.newOid)) return { tag: "invalid", reason: `object not stored: ${input.newOid.slice(0, 12)}…` };
  const meta = store.typeAndSize(input.newOid);
  if (!meta) return { tag: "invalid", reason: `object not readable: ${input.newOid.slice(0, 12)}…` };
  if (meta.type === "commit") {
    const obj = await store.get(input.newOid);
    const tree = obj?.type === "commit" ? parseCommit(obj.data).tree : null;
    if (!tree || !store.has(tree)) {
      return { tag: "invalid", reason: `root tree not stored for ${input.newOid.slice(0, 12)}…` };
    }
  }
  // tag targets cache their peeled commit on the refs row at write time
  let peeled: string | null = null;
  if (meta.type === "tag") peeled = await store.peeledRefTarget(input.ref, input.newOid);

  const current = store.getRef(input.ref) ?? ZERO_OID;
  if (current !== input.expectedOldOid) return { tag: "ref_conflict", currentOid: current };

  host.storage.transactionSync(() => {
    store.setRef(input.ref, input.newOid);
    if (peeled && peeled !== input.newOid) store.setRefPeeled(input.ref, input.newOid, peeled);
    if (store.getRef(store.head()) === null) {
      const branches = store.refs().filter((r) => r.name.startsWith("refs/heads/"));
      const preferred =
        branches.find((b) => b.name === "refs/heads/main") ??
        branches.find((b) => b.name === "refs/heads/master") ??
        branches[0];
      if (preferred) store.setHead(preferred.name);
    }
    store.bumpRefsVersion();
  });
  return {
    tag: "committed",
    ref: input.ref,
    oldOid: current,
    newOid: input.newOid,
    refsVersion: store.refsVersion(),
    commitTime: await latestCommitTime(store),
  };
}

/**
 * CAS ref delete (SPEC-0001b §4.8) — the counterpart commitApiChange lacks.
 * One transactionSync: refname validation → CAS (`current === expectedOid`) →
 * `delRef` → `refs_version` bump. Delete idempotence: a ref already gone
 * returns `ref_conflict` with `currentOid: null` when the caller expected a
 * value (the caller-friendly "already deleted, nothing to do"), and `deleted`
 * when the caller's CAS base was ZERO_OID (the create-absent expectation is
 * satisfied by absence). Serves PR creation-failure cleanup, issue-delete
 * cascade and merged-head-branch deletion; real branch deletes go through
 * the same RPC from the SPEC-0004 branch service.
 */
export async function deleteApiRef(host: LeaseHost, input: DeleteApiRefInput): Promise<DeleteApiRefResult> {
  const { store } = host;
  if (!validRefName(input.ref)) return { tag: "invalid", reason: `funny refname: ${input.ref}` };
  if (!isOid(input.expectedOid)) return { tag: "invalid", reason: "malformed expected oid" };
  let outcome: { deleted: boolean; current: string | null };
  host.storage.transactionSync(() => {
    const current = store.getRef(input.ref);
    if (current === null) {
      outcome = { deleted: input.expectedOid === ZERO_OID, current: null };
      if (input.expectedOid === ZERO_OID) store.bumpRefsVersion();
      return;
    }
    if (current !== input.expectedOid) {
      outcome = { deleted: false, current };
      return;
    }
    store.delRef(input.ref);
    store.bumpRefsVersion();
    outcome = { deleted: true, current: null };
  });
  const r = outcome!;
  if (r.deleted) return { tag: "deleted", refsVersion: store.refsVersion() };
  return { tag: "ref_conflict", currentOid: r.current };
}

// ---- merge surface RPCs (SPEC-0001b §4.1, §4.3-§4.5, §4.8) --------------------
// Thin LeaseHost delegations; the algorithms live in src/merge/*.ts. All the
// read paths (mergeBase/listCommitsRange/countDivergence/checkMergeability/
// rebaseOnto) are pure reads — §4.6's rule that checks never write.

/** §4.1 merge-base over refs or oids; `missing` names the unresolvable side. */
export async function mergeBase(
  host: LeaseHost,
  a: string,
  b: string
): Promise<{ tag: "ok"; base: string | null; exhausted: boolean } | { tag: "missing"; which: "a" | "b" }> {
  const oa = await resolveCommitish(host.store, a);
  if (!oa) return { tag: "missing", which: "a" };
  const ob = await resolveCommitish(host.store, b);
  if (!ob) return { tag: "missing", which: "b" };
  const r = await graphMergeBase(host.store, oa, ob);
  return { tag: "ok", base: r.value, exhausted: r.exhausted };
}

/** §4.1 `base..head`, topological, oldest first, `page` 0-based. Null when
 * either side does not resolve to a commit. */
export async function listCommitsRange(
  host: LeaseHost,
  base: string,
  head: string,
  limit: number,
  page = 0
): Promise<{ commits: import("./repo").CommitJson[]; more: boolean } | null> {
  return graphListCommitsRange(host.store, base, head, limit, page);
}

/** §4.1 `rev-list --left-right --count base head` in one walk. */
export async function countDivergence(
  host: LeaseHost,
  base: string,
  head: string
): Promise<{ tag: "ok"; ahead: number; behind: number; exhausted: boolean } | { tag: "missing" }> {
  const ob = await resolveCommitish(host.store, base);
  const oh = await resolveCommitish(host.store, head);
  if (!ob || !oh) return { tag: "missing" };
  const r = await graphCountDivergence(host.store, ob, oh);
  if (r.value === null) return { tag: "missing" };
  return { tag: "ok", ahead: r.value.ahead, behind: r.value.behind, exhausted: r.exhausted };
}

/** §4.3 read-only mergeability classification (writes nothing — §4.6). */
export async function checkMergeability(host: LeaseHost, input: CheckMergeabilityInput): Promise<CheckMergeabilityResult> {
  return classifyMergeability(host.store, input);
}

/** §4.4 merge execution: one landing primitive, styles as parameters. */
export async function executeMerge(host: LeaseHost, input: ExecuteMergeInput): Promise<ExecuteMergeResult> {
  return runExecuteMerge(host, input);
}

/** §4.5 rebase replay (read-only + in-memory). */
export async function rebaseOnto(host: LeaseHost, input: RebaseOntoInput): Promise<RebaseOutcome> {
  return runRebaseOnto(host.store, input);
}

/** §4.5 the replay's objects, through putApiObjects' budgets and verification
 * (same result family; the `stored` count collapses into `ok`). */
export type PutRebaseObjectsResult =
  | { tag: "ok" }
  | { tag: "too_large"; limitBytes: number }
  | { tag: "invalid"; reason: string };

export async function putRebaseObjects(host: LeaseHost, objects: MergeObject[]): Promise<PutRebaseObjectsResult> {
  const r = await putApiObjects(host, objects);
  if (r.tag === "ok") return { tag: "ok" };
  if (r.tag === "too_large") return r;
  return r;
}

// ---- fork catalog replication RPCs (SPEC-0001b §5.3) ---------------------------
// The parent side reads (listCatalogPage) are pure; the fork side
// (beginForkImport/adoptForkPacks/finalizeForkImport) is the replication
// lease. Pack bytes never cross this boundary for 'r2' packs — the Worker
// consumer streams bucket.get(parentKey) → bucket.put(forkKey) — with the one
// documented exception of inline packData for location='sqlite' packs. The
// crash story is idempotent re-run: rows are keyed (INSERT OR IGNORE), R2
// copies overwrite, staging is replaced, and only finalize's single
// transactionSync makes any of it visible (catalog + refs together).

/** Hard cap on the index rows one listCatalogPage returns (a page stays well
 * under the DO RPC message budget; the consumer tunes `limit` below it). */
export const FORK_PAGE_MAX_ROWS = 65536;

/**
 * Paged read of the parent's ACTIVE pack catalog with each pack's index rows
 * (§5.3 copy loop's parent side). `afterPackKey` is the PREVIOUS page's
 * `nextAfter` cursor (engine-produced, opaque: "" starts the listing). `limit`
 * is the page's index-row budget, clamped to [1, FORK_PAGE_MAX_ROWS]; a pack
 * with more rows than fit is split across pages (rowsComplete: false) and the
 * continuation rides the returned cursor. Only state='active' rows are ever
 * listed — non-active states are compaction debris a fork must not copy.
 */
export function listCatalogPage(host: LeaseHost, afterPackKey: string, limit: number): CatalogPage {
  const { store } = host;
  const budget = Math.min(Math.max(1, Math.floor(limit) || 1), FORK_PAGE_MAX_ROWS);
  const packs: CatalogPackEntry[] = [];
  let hasLocalPacks = false;

  // cursor shapes: "<packKey>" resumes AFTER that pack; "<packKey> <oid>"
  // continues that pack's rows after <oid> (pack names cannot contain spaces)
  let resumePack = afterPackKey;
  let resumeOid = "";
  const sp = afterPackKey.indexOf(" ");
  if (sp > 0) {
    resumePack = afterPackKey.slice(0, sp);
    resumeOid = afterPackKey.slice(sp + 1);
  }

  const entryOf = (row: {
    packKey: string; kind: string; state: PackState; location: "r2" | "sqlite";
    objectCount: number; packBytes: number; idxBytes: number;
  }, rows: IndexRow[], rowsFrom: string, rowsComplete: boolean): CatalogPackEntry => {
    const entry: CatalogPackEntry = {
      packKey: row.packKey, kind: row.kind, state: row.state, location: row.location,
      objectCount: row.objectCount, packBytes: row.packBytes, idxBytes: row.idxBytes,
      rows, rowsFrom, rowsComplete,
    };
    if (row.location === "sqlite" && rowsFrom === "") {
      // the small-pack bytes are DO-local (pack_data chunks): they ride the
      // page for the consumer to rehydrate into the fork's R2 prefix — bounded
      // by the < 16 MiB threshold (SPEC-0001a §8 correction 2)
      entry.packData = store.packs.sqlitePackBytes(row.packKey);
      hasLocalPacks = true;
    }
    return entry;
  };

  let remaining = budget;
  let nextAfter = resumePack;

  if (resumeOid !== "") {
    // continuation of a pack split across pages
    const got = store.packs.indexRowsAfter(resumePack, resumeOid, remaining + 1);
    const slice = got.slice(0, remaining);
    const complete = got.length <= remaining;
    const row = store.packs.activeCatalogRow(resumePack);
    if (!row) {
      // the pack vanished between pages (parent compaction): skip it — the
      // idempotent re-run re-lists from scratch and converges
      return { packs, hasLocalPacks, more: store.packs.hasActiveCatalogAfter(resumePack), nextAfter: resumePack };
    }
    packs.push(entryOf(row, slice, resumeOid, complete));
    remaining -= slice.length;
    if (!complete) {
      return {
        packs,
        hasLocalPacks,
        more: true,
        nextAfter: `${resumePack} ${slice[slice.length - 1].oid}`,
      };
    }
  }

  for (;;) {
    if (remaining <= 0) {
      // budget spent exactly on a pack boundary: probe for a follower
      return { packs, hasLocalPacks, more: store.packs.hasActiveCatalogAfter(nextAfter), nextAfter };
    }
    const row = store.packs.activeCatalogAfter(nextAfter, 1)[0];
    if (!row) return { packs, hasLocalPacks, more: false, nextAfter };
    const got = store.packs.indexRowsAfter(row.packKey, "", remaining + 1);
    const slice = got.slice(0, remaining);
    const complete = got.length <= remaining;
    packs.push(entryOf(row, slice, "", complete));
    remaining -= slice.length;
    if (!complete) {
      return { packs, hasLocalPacks, more: true, nextAfter: `${row.packKey} ${slice[slice.length - 1].oid}` };
    }
    nextAfter = row.packKey;
  }
}

/**
 * Open the replication lease on the FORK (§5.3 step 2): persists the fork's
 * storage key, sets meta.importing=1 — gating beginReceive / commitApiChange /
 * executeMerge with their `importing` variants — and clears any crashed
 * attempt's staging rows. Idempotent during the import (the consumer's re-run
 * re-begins); refused on a tombstoned repo and on a repo that already
 * finalized an import (refs/catalog present), so a post-finalize retry cannot
 * gate a live repo's writes forever.
 */
export function beginForkImport(host: LeaseHost, storageKey: string): BeginForkImportResult {
  const { store } = host;
  if (!isValidStorageKey(storageKey)) {
    return { tag: "invalid", reason: `invalid storage key: ${storageKey.slice(0, 24)}` };
  }
  if (isDeleted(store)) return { tag: "invalid", reason: "repository deleted" };
  if (!isImporting(store)) {
    // a fork target must be an EMPTY DO: any ref, catalog row, index row or
    // loose object means an import already finalized here — a re-begin would
    // gate a live repo's writes forever (the consumer's post-finalize retry
    // reads this as "already done")
    if (store.hasAnyContent()) {
      return {
        tag: "invalid",
        reason: "fork target is not empty (import already finalized?)",
      };
    }
  }
  host.storage.transactionSync(() => {
    store.setMeta("storage_key", storageKey);
    store.setMeta("importing", "1");
    store.packs.clearForkStaging();
  });
  return { tag: "ok", storageKey };
}

/**
 * Adopt one catalog page on the FORK (§5.3 step 3's fork side): verifies the
 * consumer's copied pack bytes against their keys (first slice only), lands
 * the page's index rows (idempotent INSERT OR IGNORE), and — when the slice
 * completes a pack — stages its catalog entry for finalize. The consumer MUST
 * have copied/rehydrated both .pack and .idx under the fork's prefix BEFORE
 * this call (copy-before-stage, the receive path's ordering); a missing or
 * mismatched object is `invalid`, never a partial commit.
 */
export async function adoptForkPacks(host: LeaseHost, page: CatalogPage): Promise<AdoptForkPacksResult> {
  const { store } = host;
  if (!isImporting(store)) return { tag: "invalid", reason: "no fork import in progress (beginForkImport first)" };
  const storageKey = store.getMeta("storage_key");
  if (!storageKey) return { tag: "invalid", reason: "fork has no persisted storage key" };
  for (const entry of page.packs) {
    if (!isValidPackName(entry.packKey)) {
      return { tag: "invalid", reason: `malformed pack key: ${entry.packKey.slice(0, 24)}` };
    }
    if (entry.location === "sqlite" && entry.rowsFrom === "" && !entry.packData) {
      return { tag: "invalid", reason: `sqlite pack without inline bytes: ${entry.packKey}` };
    }
    if (entry.rowsFrom === "") {
      const tail = await host.readPackTail?.(packR2Key(storageKey, entry.packKey), 20);
      // the pack's 20-byte TRAILER is its own SHA-1 — the name's hash, verbatim
      if (!tail || toHex(tail) !== entry.packKey.slice("pack-".length)) {
        return { tag: "invalid", reason: `pack bytes missing or not matching ${entry.packKey}` };
      }
    }
    if (entry.rows.length) store.packs.putRows(entry.packKey, entry.rows);
    if (entry.rowsComplete) {
      // the fork's own count: rows actually keyed under this pack (an oid's
      // row lives under the FIRST pack that indexed it — exactly what
      // recordPack would write for the same row set)
      store.packs.stageForkPack(entry.packKey, store.packs.countPackRows(entry.packKey), entry.packBytes, entry.idxBytes);
    }
  }
  return { tag: "ok" };
}

/**
 * Finalize the import on the FORK (§5.3 step 4): re-verifies every staged
 * pack's bytes against its key, then ONE transactionSync inserts the
 * pack_catalog rows (kind='fork' — these never came from a receive lease),
 * writes refs (+ tag peels cached on the rows) and meta.head, clears
 * meta.importing, and bumps refs_version. Nothing is servable before this
 * transaction: a crash anywhere earlier leaves rows-without-catalog (the
 * sweeps' debris class) and the consumer's idempotent re-run completes it.
 */
export async function finalizeForkImport(
  host: LeaseHost,
  input: FinalizeForkImportInput
): Promise<FinalizeForkImportResult> {
  const { store } = host;
  if (!isImporting(store)) return { tag: "invalid", reason: "no fork import in progress (beginForkImport first)" };
  const seen = new Set<string>();
  for (const r of input.refs) {
    if (!validRefName(r.name)) return { tag: "invalid", reason: `funny refname: ${r.name}` };
    if (!isOid(r.oid)) return { tag: "invalid", reason: `malformed oid for ${r.name}` };
    if (seen.has(r.name)) return { tag: "invalid", reason: `duplicate ref: ${r.name}` };
    seen.add(r.name);
  }
  let headRef: string | null = null;
  if (input.head !== null) {
    headRef = input.head.startsWith("refs/") ? input.head : `refs/heads/${input.head}`;
    if (!validRefName(headRef)) return { tag: "invalid", reason: `invalid head: ${input.head}` };
    if (!input.refs.some((r) => r.name === headRef)) {
      return { tag: "invalid", reason: `head does not name a copied ref: ${input.head}` };
    }
  }
  // async validation BEFORE the transaction (transactionSync cannot await):
  // every ref tip must exist in the adopted object set
  for (const r of input.refs) {
    if (!store.has(r.oid)) return { tag: "invalid", reason: `object not imported: ${r.oid.slice(0, 12)}… (${r.name})` };
  }
  // tag tips cache their peeled commit on the refs row at write time (same
  // as commitApiChange)
  const peeled = new Map<string, string>();
  for (const r of input.refs) {
    if (!r.name.startsWith("refs/tags/")) continue;
    const p = await store.peeledRefTarget(r.name, r.oid);
    if (p && p !== r.oid) peeled.set(r.name, p);
  }
  // "verifying pack names still match their row keys" (§5.3 step 4): the
  // staged packs' 20-byte SHA-1 trailers against their catalog keys
  const staged = store.packs.stagedForkPacks();
  const storageKey = store.getMeta("storage_key") ?? "";
  for (const s of staged) {
    const tail = await host.readPackTail?.(packR2Key(storageKey, s.packKey), 20);
    if (!tail || toHex(tail) !== s.packKey.slice("pack-".length)) {
      return { tag: "invalid", reason: `staged pack bytes missing or not matching ${s.packKey}` };
    }
  }
  let refsVersion = "";
  host.storage.transactionSync(() => {
    for (const s of staged) {
      store.packs.recordPack(s.packKey, s.packBytes, s.idxBytes, "fork");
    }
    store.packs.clearForkStaging();
    for (const r of input.refs) {
      store.setRef(r.name, r.oid);
      const p = peeled.get(r.name);
      if (p) store.setRefPeeled(r.name, r.oid, p);
    }
    if (headRef) store.setHead(headRef);
    store.setMeta("importing", "0");
    store.bumpRefsVersion();
    refsVersion = store.refsVersion();
  });
  return { tag: "ok", refsVersion };
}

/** serializeCommit/serializeTag/personLine re-exports: the Worker-side
 * builders construct the canonical bytes these RPCs verify and store. */
export { serializeCommit, serializeTag, personLine };

// ---- invariants read RPCs -----------------------------------------------------
// Read-only, lease-free catalog reads for the Worker's invariants checker
// (apps/worker/src/invariants). Same tagged-union discipline as every RPC
// above — application outcomes never throw across the boundary — and no
// receive lease is taken or consulted: the checker runs unattended and must
// never contend with a push. Distinct from the fork replication's
// listCatalogPage: that one serves the copy loop (active rows + index rows +
// sqlite bytes); this one is the raw catalog view the checker cross-checks
// against R2, and it must list NON-active rows too (a superseded row's
// object may legitimately be gone — flagging it would be noise).

/** Hard cap on one listPackCatalog page. */
export const LIST_PACK_CATALOG_MAX_LIMIT = 500;
/** Page size when ListPackCatalogInput.limit is omitted. */
export const LIST_PACK_CATALOG_DEFAULT_LIMIT = 200;

/** One pack_catalog row of the checker's paged catalog read. Field names
 * mirror the catalog table's columns verbatim (the raw catalog view, not an
 * engine-internal record); `created_at` is unix millis. */
export interface PackCatalogEntry {
  pack_key: string;
  kind: string;
  state: string;
  location: string;
  object_count: number;
  pack_bytes: number;
  created_at: number;
}

export interface ListPackCatalogInput {
  /** Keyset cursor: the previous page's nextCursor (the last pack_key
   * served), or null/absent for the first page. Order is pack_key. */
  cursor?: string | null;
  /** Page size, 1..LIST_PACK_CATALOG_MAX_LIMIT (default 200). */
  limit?: number;
}

export type ListPackCatalogOk = {
  tag: "ok";
  rows: PackCatalogEntry[];
  /** Pass as the next call's cursor; null when the walk is exhausted. */
  nextCursor: string | null;
};
export type ListPackCatalogError = { tag: "error"; reason: string };
export type ListPackCatalogResult = ListPackCatalogOk | ListPackCatalogError;

/**
 * Paged read over the WHOLE pack catalog — every lifecycle state, pack_key
 * order. Pure SQLite read; nothing is written and no lease is involved.
 * `limit` outside 1..LIST_PACK_CATALOG_MAX_LIMIT and a `cursor` that is not
 * a pack key (pack-<40 hex>) come back as { tag: "error", reason } rather
 * than throwing, per the boundary discipline.
 */
export function listPackCatalog(host: LeaseHost, input: ListPackCatalogInput): ListPackCatalogResult {
  const limit = input.limit ?? LIST_PACK_CATALOG_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_PACK_CATALOG_MAX_LIMIT) {
    return { tag: "error", reason: `limit must be an integer in 1..${LIST_PACK_CATALOG_MAX_LIMIT}` };
  }
  const cursor = input.cursor ?? null;
  if (cursor !== null && !isValidPackName(cursor)) {
    return { tag: "error", reason: "cursor is not a pack key (pack-<40 hex>)" };
  }
  // one probe row past the page decides nextCursor
  const rows = host.store.packs.catalogPage(cursor, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    tag: "ok",
    rows: page.map((r) => ({
      pack_key: r.packKey,
      kind: r.kind,
      state: r.state,
      location: r.location,
      object_count: r.objectCount,
      pack_bytes: r.packBytes,
      created_at: r.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.packKey : null,
  };
}

