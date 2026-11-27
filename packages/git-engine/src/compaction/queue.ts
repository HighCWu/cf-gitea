import { applyDelta, PackWriter } from "../git/pack";
import type { ObjType } from "../git/objects";
import { OidSet } from "../git/oidset";
import { encodePackRefIndex, extractObjectRefBytes, parsePackRefIndex, walkClosureWithPref, type PackRefEntryInput } from "../git/pref";
import { bundleR2Key } from "../git/r2keys";
import type { RepoBundleMeta } from "../git/store";
import { concat, Sha1, toHex } from "../git/util";
import type { PackCatalogRow } from "../git/packstore";
import type { IndexRow } from "../control-plane";
import { ObjCache } from "../receive/objcache";
import { Crc32, writeIdx } from "../receive/idx";
import { inflateAll } from "../receive/scan";
import { DEFAULT_BUNDLE_MIN_BYTES, formatGitBundleV2Header } from "../upload/bundle";
import { SequentialR2PackReader } from "../upload/stream";

/** 16 MiB R2 multipart parts (10,000 parts => 160 GiB max compacted pack; 16 MiB single-slab stays safe in 128 MiB Workers isolates). */
export const QUEUE_COMPACTION_PART_SIZE = 16 * 1024 * 1024;
/** Max active packs collapsed per Queue compaction round (collapses a 49-pack repo in 1 round). */
export const QUEUE_COMPACTION_MAX_PACKS = 64;
const PREF_CACHE_BYTES = 8 * 1024 * 1024;
const COMPACTION_PAGE_SIZE = 4096;
const STAGE_BATCH_SIZE = 4096;
const SINK_SLAB_PROMOTE_BYTES = 1024 * 1024;

export interface CompactionInputPack extends PackCatalogRow {
  r2Key: string;
}

export interface BeginQueueCompactionInput {
  force?: boolean;
  maxPacks?: number;
}

export type BeginQueueCompactionResult =
  | {
      tag: "ready";
      leaseToken: string;
      expiresAt: number;
      storageKey: string;
      inputs: CompactionInputPack[];
      expectedObjects: number;
      reachableOnly: boolean;
      cleanReachable: boolean;
      allActiveR2: boolean;
      hasLoose: boolean;
      refsVersion: string;
      tipOids: string[];
      tier: number;
      outputPackKey: string;
      outputPackR2Key: string;
      outputIdxR2Key: string;
      outputPrefR2Key: string;
    }
  | { tag: "deferred"; reason: "receive_lease_live" | "compaction_in_flight" }
  | { tag: "skipped"; reason: string; activePacks: number };

export type ReadCompactionPageResult =
  | { tag: "ok"; rows: IndexRow[]; hasMore: boolean }
  | { tag: "rejected"; reason: string };

export type ReadCompactionObjectResult =
  | { tag: "ok"; type: ObjType; data: Uint8Array }
  | { tag: "missing" }
  | { tag: "rejected"; reason: string };

export type StageCompactionRowsResult =
  | { tag: "ok" }
  | { tag: "rejected"; reason: string };

export interface CommitQueueCompactionInput {
  packKey: string;
  packBytes: number;
  idxBytes: number;
  prefBytes: number;
  objectCount: number;
  cleanReachable: boolean;
  tier: number;
}

export type CommitQueueCompactionResult =
  | {
      tag: "committed";
      activePacksRemaining: number;
      cleanReachable: boolean;
      storageKey: string;
      refsVersion: string;
      refs: Array<{ name: string; oid: string }>;
    }
  | { tag: "lease_lost"; reason: string };

export interface QueueCompactionStub {
  beginQueueCompaction(repo: string, opts?: BeginQueueCompactionInput): Promise<BeginQueueCompactionResult>;
  readCompactionInputPage(
    leaseToken: string,
    packKey: string,
    afterOffset: number,
    limit: number,
    reachableOnly: boolean
  ): Promise<ReadCompactionPageResult>;
  readCompactionObject(leaseToken: string, oid: string): Promise<ReadCompactionObjectResult>;
  stageCompactionRows(leaseToken: string, rows: Array<IndexRow & { srcPack: string }>): Promise<StageCompactionRowsResult>;
  commitQueueCompaction(leaseToken: string, output: CommitQueueCompactionInput): Promise<CommitQueueCompactionResult>;
  abortQueueCompaction(leaseToken: string): Promise<void>;
  recordRepoBundle(bundle: RepoBundleMeta): Promise<{ tag: "ok" | "stale" }>;
}

export type QueueCompactionResult =
  | {
      tag: "compacted";
      outputPackKey: string;
      outputPackBytes: number;
      outputIdxBytes: number;
      outputPrefBytes: number;
      objects: number;
      inputs: string[];
      ofsDeltas: number;
      reInflated: number;
      cleanReachable: boolean;
      activePacksRemaining: number;
      moreWork: boolean;
      bundle?: { id: string; r2Key: string; bytes: number };
    }
  | { tag: "deferred"; reason: "receive_lease_live" | "compaction_in_flight" | "lease_lost" }
  | { tag: "skipped"; reason: string; activePacks: number };

export interface RunQueueCompactionOptions {
  bucket: R2Bucket;
  stub: QueueCompactionStub;
  repo: string;
  force?: boolean;
  maxPacks?: number;
  partSize?: number;
  generateBundle?: boolean;
  bundleMinBytes?: number;
}

/**
 * Single-slab buffered-part R2 writer: skips multipart overhead for small writes
 * (< `partSize`) via one `bucket.put()`, and promotes above 1 MiB into a single
 * reusable `partSize` slab so isolate heap never sees a `2 * partSize` `concat()` spike.
 */
class AdaptiveR2Sink {
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private slab: Uint8Array | null = null;
  private slabLen = 0;
  private mp: R2MultipartUpload | null = null;
  private uploadedParts: R2UploadedPart[] = [];
  private totalWritten = 0;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly partSize: number
  ) {}

  private promoteToSlab(): Uint8Array {
    const slab = new Uint8Array(this.partSize);
    let off = 0;
    for (const p of this.pending) {
      slab.set(p, off);
      off += p.length;
    }
    this.pending = [];
    this.pendingLen = 0;
    this.slab = slab;
    this.slabLen = off;
    return slab;
  }

  private async uploadFullSlab(): Promise<void> {
    if (!this.mp) this.mp = await this.bucket.createMultipartUpload(this.key);
    this.uploadedParts.push(await this.mp.uploadPart(this.uploadedParts.length + 1, this.slab!));
    this.slabLen = 0;
  }

  private releaseBuffers(): void {
    this.pending = [];
    this.pendingLen = 0;
    this.slab = null;
    this.slabLen = 0;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    this.totalWritten += chunk.length;
    if (this.slab === null) {
      const promoteAt = Math.min(this.partSize, SINK_SLAB_PROMOTE_BYTES);
      if (this.pendingLen + chunk.length < promoteAt) {
        this.pending.push(chunk.slice());
        this.pendingLen += chunk.length;
        return;
      }
      this.promoteToSlab();
    }
    let off = 0;
    const slab = this.slab!;
    while (off < chunk.length) {
      const fit = Math.min(chunk.length - off, this.partSize - this.slabLen);
      slab.set(chunk.subarray(off, off + fit), this.slabLen);
      this.slabLen += fit;
      off += fit;
      if (this.slabLen === this.partSize) {
        await this.uploadFullSlab();
      }
    }
  }

  async finish(): Promise<number> {
    try {
      if (!this.mp) {
        const body =
          this.slab !== null
            ? this.slab.subarray(0, this.slabLen)
            : this.pendingLen > 0
              ? concat(this.pending)
              : new Uint8Array(0);
        await this.bucket.put(this.key, body);
        return this.totalWritten;
      }
      if (this.slab !== null && this.slabLen > 0) {
        this.uploadedParts.push(
          await this.mp.uploadPart(this.uploadedParts.length + 1, this.slab.subarray(0, this.slabLen))
        );
      }
      await this.mp.complete(this.uploadedParts);
      return this.totalWritten;
    } finally {
      this.releaseBuffers();
    }
  }

  async abort(): Promise<void> {
    this.releaseBuffers();
    if (this.mp) {
      const m = this.mp;
      this.mp = null;
      try {
        await m.abort();
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Queue-worker streaming multi-pack compaction (SPEC-0024 M4.1):
 * - Streams each input pack via 1 sequential `bucket.get()`.
 * - Emits deltas whose base already appeared earlier using compact `OFS_DELTA` headers.
 * - Writes `.pack` (via AdaptiveR2Sink up to 64 MiB parts), `.idx` v2, and `.pref` sidecars.
 * - Commits atomically in 1 DO SQLite transaction via `commitQueueCompaction`.
 */
export async function runQueueCompaction(opts: RunQueueCompactionOptions): Promise<QueueCompactionResult> {
  const { bucket, stub, repo } = opts;
  const partSize = Math.max(5 * 1024 * 1024, opts.partSize ?? QUEUE_COMPACTION_PART_SIZE);
  const plan = await stub.beginQueueCompaction(repo, {
    force: opts.force,
    maxPacks: opts.maxPacks ?? QUEUE_COMPACTION_MAX_PACKS,
  });
  if (plan.tag === "deferred" || plan.tag === "skipped") return plan;

  const packSink = new AdaptiveR2Sink(bucket, plan.outputPackR2Key, partSize);
  let activeSeqReader: SequentialR2PackReader | null = null;
  let committed = false;

  try {
    let entryChunks: Uint8Array[] = [];
    let pos = 0;
    const packSha = new Sha1();
    const recordChunk = (chunk: Uint8Array): void => {
      entryChunks.push(chunk);
      pos += chunk.length;
      packSha.update(chunk);
    };
    const writer = new PackWriter(recordChunk);
    writer.header(plan.expectedObjects);
    for (const c of entryChunks) await packSink.write(c);
    entryChunks = [];

    const prefCache = new ObjCache(PREF_CACHE_BYTES);
    const oidSet = new OidSet(Math.max(1, plan.expectedObjects));
    const entryCrcs = new Uint32Array(plan.expectedObjects);
    const entryOffsets = new Float64Array(plan.expectedObjects);
    const oidEntry: number[] = new Array<number>(plan.expectedObjects);
    const prefEntries: PackRefEntryInput[] = [];
    const stageBatch: Array<IndexRow & { srcPack: string }> = [];

    let emitted = 0;
    let ofsDeltas = 0;
    let reInflated = 0;

    const flushStageBatch = async () => {
      if (!stageBatch.length) return;
      const res = await stub.stageCompactionRows(plan.leaseToken, stageBatch.splice(0, stageBatch.length));
      if (res.tag !== "ok") {
        throw new Error(`compaction lease rejected (${res.reason})`);
      }
    };

    for (const p of plan.inputs) {
      const obj = await bucket.get(p.r2Key);
      if (!obj) throw new Error(`compaction: missing input R2 pack ${p.r2Key}`);
      const seqReader = new SequentialR2PackReader(obj.body);
      activeSeqReader = seqReader;
      try {
        let afterOffset = -1;
        for (;;) {
          const page = await stub.readCompactionInputPage(
            plan.leaseToken,
            p.packKey,
            afterOffset,
            COMPACTION_PAGE_SIZE,
            plan.reachableOnly
          );
          if (page.tag !== "ok") {
            throw new Error(`compaction lease rejected (${page.reason})`);
          }
          if (page.rows.length === 0) break;

          for (const row of page.rows) {
            afterOffset = row.offset;
            const entryOffset = pos;
            entryChunks = [];

            let emittedType = row.type;
            let emittedSize = row.size;
            let emittedEntrySize = row.entrySize;
            let emittedBaseOid = row.baseOid;
            let nonBlobData: Uint8Array | null = null;

            const raw = await seqReader.readAt(row.dataOff, row.dataLen);

            if (row.baseOid === null) {
              writer.rawFull(row.type, row.entrySize, raw);
              if (row.type !== "blob") {
                nonBlobData = inflateAll(raw);
                prefCache.put(row.oid, { type: row.type, data: nonBlobData });
              }
            } else {
              const baseIdx = oidSet.indexOfHex(row.baseOid);
              const baseOff = baseIdx >= 0 ? entryOffsets[baseIdx] : undefined;
              if (baseOff !== undefined) {
                writer.rawOfsDelta(entryOffset - baseOff < 0 ? 0 : row.entrySize, entryOffset - baseOff, raw);
                ofsDeltas++;
                if (row.type !== "blob") {
                  const cachedBase = prefCache.get(row.baseOid);
                  if (cachedBase) {
                    nonBlobData = applyDelta(cachedBase.data, inflateAll(raw));
                  } else {
                    const resolved = await stub.readCompactionObject(plan.leaseToken, row.oid);
                    if (resolved.tag === "rejected") {
                      throw new Error(`compaction lease rejected (${resolved.reason})`);
                    }
                    if (resolved.tag === "missing") {
                      throw new Error(`compaction: missing object ${row.oid}`);
                    }
                    nonBlobData = resolved.data;
                  }
                  prefCache.put(row.oid, { type: row.type, data: nonBlobData });
                }
              } else {
                const resolved = await stub.readCompactionObject(plan.leaseToken, row.oid);
                if (resolved.tag === "rejected") {
                  throw new Error(`compaction lease rejected (${resolved.reason})`);
                }
                if (resolved.tag === "missing") {
                  throw new Error(`compaction: missing object ${row.oid}`);
                }
                writer.object(resolved.type, resolved.data);
                emittedType = resolved.type;
                emittedSize = resolved.data.length;
                emittedEntrySize = resolved.data.length;
                emittedBaseOid = null;
                reInflated++;
                if (resolved.type !== "blob") {
                  nonBlobData = resolved.data;
                  prefCache.put(row.oid, { type: resolved.type, data: nonBlobData });
                }
              }
            }

            if (emitted >= plan.expectedObjects) {
              throw new Error(`compaction object overflow: exceeded expected ${plan.expectedObjects}`);
            }

            const crc = new Crc32();
            for (const c of entryChunks) crc.update(c);
            const headerLen = entryChunks[0]!.length + (entryChunks.length > 2 ? entryChunks[1]!.length : 0);
            const dataLen = entryChunks[entryChunks.length - 1]!.length;

            for (const c of entryChunks) await packSink.write(c);
            entryChunks = [];

            const inserted = oidSet.addHex(row.oid);
            if (!inserted) {
              throw new Error(`compaction duplicate oid in merged inputs: ${row.oid}`);
            }
            entryCrcs[emitted] = crc.get();
            entryOffsets[emitted] = entryOffset;
            oidEntry[emitted] = emitted;

            prefEntries.push({
              oid: row.oid,
              type: emittedType,
              refs:
                nonBlobData !== null
                  ? extractObjectRefBytes(emittedType, nonBlobData)
                  : new Uint8Array(0),
            });

            stageBatch.push({
              oid: row.oid,
              offset: entryOffset,
              dataOff: entryOffset + headerLen,
              dataLen,
              type: emittedType,
              size: emittedSize,
              entrySize: emittedEntrySize,
              baseOid: emittedBaseOid,
              crc32: entryCrcs[emitted]!,
              srcPack: p.packKey,
            });
            if (stageBatch.length >= STAGE_BATCH_SIZE) {
              await flushStageBatch();
            }
            emitted++;
          }

          if (!page.hasMore) break;
        }
      } finally {
        await seqReader.close();
        activeSeqReader = null;
      }
    }

    if (emitted !== plan.expectedObjects) {
      throw new Error(`compaction object count mismatch: emitted ${emitted}, expected ${plan.expectedObjects}`);
    }
    await flushStageBatch();

    const packSha1 = toHex(packSha.digest());
    entryChunks = [];
    writer.finish();
    for (const c of entryChunks) await packSink.write(c);
    entryChunks = [];
    const outputPackBytes = await packSink.finish();

    const idxSink = new AdaptiveR2Sink(bucket, plan.outputIdxR2Key, partSize);
    let idxTail = new Uint8Array(0);
    const outputIdxBytes = await writeIdx(
      async (chunk) => {
        if (chunk.length >= 20) {
          idxTail = chunk.slice(chunk.length - 20);
        } else if (chunk.length > 0) {
          const combined = concat([idxTail, chunk]);
          idxTail = combined.slice(Math.max(0, combined.length - 20));
        }
        await idxSink.write(chunk);
      },
      {
        oids: oidSet,
        oidEntry,
        entryCrcs,
        entryOffsets,
        packSha1,
      }
    );
    await idxSink.finish();
    const idxSha1 = idxTail.length === 20 ? toHex(idxTail) : undefined;

    const prefBytes = encodePackRefIndex({
      entries: prefEntries,
      packBytes: outputPackBytes,
      packSha1,
      idxSha1,
    });
    let effectiveCleanReachable = plan.cleanReachable;
    if (!effectiveCleanReachable && plan.allActiveR2 && !plan.hasLoose && plan.tipOids.length > 0 && emitted > 0) {
      const sortedOids = prefEntries.map((e) => e.oid).sort();
      const prefView = parsePackRefIndex(prefBytes);
      const closure = walkClosureWithPref([{ sortedOids, pref: prefView }], plan.tipOids);
      if (closure.size === emitted) {
        let allPresent = true;
        for (const oid of closure) {
          if (!oidSet.hasHex(oid)) {
            allPresent = false;
            break;
          }
        }
        if (allPresent) effectiveCleanReachable = true;
      }
    }
    // Release per-object ref slices before opening bundleSink.
    prefEntries.length = 0;
    const prefSink = new AdaptiveR2Sink(bucket, plan.outputPrefR2Key, partSize);
    await prefSink.write(prefBytes);
    const outputPrefBytes = await prefSink.finish();

    const commitRes = await stub.commitQueueCompaction(plan.leaseToken, {
      packKey: plan.outputPackKey,
      packBytes: outputPackBytes,
      idxBytes: outputIdxBytes,
      prefBytes: outputPrefBytes,
      objectCount: emitted,
      cleanReachable: effectiveCleanReachable,
      tier: plan.tier,
    });
    if (commitRes.tag !== "committed") {
      await stub.abortQueueCompaction(plan.leaseToken).catch(() => {});
      return { tag: "deferred", reason: "lease_lost" };
    }
    committed = true;

    let bundle: { id: string; r2Key: string; bytes: number } | undefined;
    const minBundleBytes = opts.bundleMinBytes ?? DEFAULT_BUNDLE_MIN_BYTES;
    if (
      opts.generateBundle &&
      commitRes.cleanReachable &&
      commitRes.activePacksRemaining === 1 &&
      outputPackBytes >= minBundleBytes &&
      commitRes.refs.length > 0
    ) {
      const bundleId = `${commitRes.refsVersion}-${plan.outputPackKey}`;
      const bKey = bundleR2Key(commitRes.storageKey, bundleId);
      const bundleSink = new AdaptiveR2Sink(bucket, bKey, partSize);
      try {
        const headerBytes = formatGitBundleV2Header(commitRes.refs);
        await bundleSink.write(headerBytes);
        const packObj = await bucket.get(plan.outputPackR2Key);
        if (!packObj?.body) {
          throw new Error(`bundle: missing compacted pack ${plan.outputPackR2Key}`);
        }
        const reader = packObj.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) await bundleSink.write(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const bundleBytes = await bundleSink.finish();
        const rec = await stub.recordRepoBundle({
          id: bundleId,
          r2Key: bKey,
          refsVersion: commitRes.refsVersion,
          packKey: plan.outputPackKey,
          bytes: bundleBytes,
          createdAt: Date.now(),
        });
        if (rec.tag === "ok") {
          bundle = { id: bundleId, r2Key: bKey, bytes: bundleBytes };
        } else {
          await bucket.delete(bKey).catch(() => {});
        }
      } catch (err) {
        await bundleSink.abort().catch(() => {});
        await bucket.delete(bKey).catch(() => {});
        console.log(
          `[compaction ${repo}] bundle materialization failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      tag: "compacted",
      outputPackKey: plan.outputPackKey,
      outputPackBytes,
      outputIdxBytes,
      outputPrefBytes,
      objects: emitted,
      inputs: plan.inputs.map((i) => i.packKey),
      ofsDeltas,
      reInflated,
      cleanReachable: commitRes.cleanReachable,
      activePacksRemaining: commitRes.activePacksRemaining,
      moreWork: commitRes.activePacksRemaining > 8,
      ...(bundle ? { bundle } : {}),
    };
  } catch (err) {
    if (activeSeqReader) {
      await activeSeqReader.close().catch(() => {});
    }
    if (!committed) {
      await packSink.abort().catch(() => {});
      await stub.abortQueueCompaction(plan.leaseToken).catch(() => {});
    }
    throw err;
  }
}
