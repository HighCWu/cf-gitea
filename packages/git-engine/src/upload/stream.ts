import { concat, isOid, te } from "../git/util";
import { FLUSH, pkt } from "../git/pktline";
import { PackWriter } from "../git/pack";
import type { ObjType } from "../git/objects";
import { READ_RENEW_MARGIN_MS, type ReleaseReadResult, type RenewReadResult } from "../read-leases";

const SIDEBAND_CHUNK = 32 * 1024;

/** Git official `uploadpack.keepAlive` packet: 5-byte zero-data band-1 frame. */
export const UPLOAD_KEEPALIVE_FRAME = te.encode("0005\x01");
export const DEFAULT_UPLOAD_KEEPALIVE_MS = 20_000;
export const WORKER_UPLOAD_PAGE_SIZE = 4096;
export const WORKER_UPLOAD_RENEW_BYTES = 32 * 1024 * 1024;

export function uploadKeepaliveMs(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_UPLOAD_KEEPALIVE_MS;
  return Math.min(Math.max(n, 50), 30_000);
}

export function uploadSidebandFrames(band: number, payload: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += SIDEBAND_CHUNK) {
    const chunk = payload.subarray(off, off + SIDEBAND_CHUNK);
    const framed = new Uint8Array(chunk.length + 1);
    framed[0] = band;
    framed.set(chunk, 1);
    frames.push(pkt(framed));
  }
  return frames;
}

export interface WorkerUploadPackMeta {
  packKey: string;
  /** R2 object key (`repos/<storageKey>/packs/<packKey>.pack`), or null if sqlite-backed. */
  r2Key: string | null;
  location: "r2" | "sqlite";
  packBytes: number;
  objectCount: number;
  reachableCount: number;
  indexedCount: number;
}

export type PlanWorkerWarmCloneResult =
  | {
      tag: "leased";
      planId: string;
      expiresAt: number;
      total: number;
      packs: WorkerUploadPackMeta[];
      hasLoose: boolean;
      /** Non-null when a single clean R2 pack holds the entire reachable closure. */
      passthroughPackKey: string | null;
      passthroughR2Key: string | null;
    }
  | { tag: "miss" };

export interface WorkerPackedEntry {
  oid: string;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjType;
  entrySize: number;
  baseOid: string | null;
  baseInPack: boolean;
}

export interface WorkerLooseEntry {
  oid: string;
  type: ObjType;
  data: Uint8Array;
}

export type ReadWarmClonePageResult =
  | { tag: "ok"; rows: WorkerPackedEntry[]; hasMore: boolean }
  | { tag: "rejected"; reason: string };

export type ReadWarmLoosePageResult =
  | { tag: "ok"; rows: WorkerLooseEntry[]; hasMore: boolean }
  | { tag: "rejected"; reason: string };

export type ReadUploadObjectResult =
  | { tag: "ok"; type: ObjType; data: Uint8Array }
  | { tag: "missing" }
  | { tag: "rejected"; reason: string };

export interface WorkerUploadStub {
  renewAndAuthorizeRead(planId: string, packKey: string | null, byteRange?: null): Promise<RenewReadResult>;
  releaseReadLease(planId: string): Promise<ReleaseReadResult>;
  readWarmClonePage(
    planId: string,
    packKey: string,
    afterOffset: number,
    limit: number,
  ): Promise<ReadWarmClonePageResult>;
  readWarmLoosePage(planId: string, afterOid: string, limit: number): Promise<ReadWarmLoosePageResult>;
  readUploadObject(planId: string, oid: string): Promise<ReadUploadObjectResult>;
}

/**
 * Forward-only reader over a single streaming `R2.get()` body.
 * Skips gaps between selected pack entries without buffering whole packs and
 * yields O(1) subarray slices inside each R2 stream chunk.
 */
export class SequentialR2PackReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private cur: Uint8Array | null = null;
  private curOff = 0;
  private pos = 0;
  private closed = false;
  private bytesSinceLease = 0;

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly onBytesThreshold?: () => Promise<void>,
    private readonly renewThresholdBytes = WORKER_UPLOAD_RENEW_BYTES,
  ) {
    this.reader = body.getReader();
  }

  private async pullNextChunk(): Promise<boolean> {
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.cur = null;
        this.curOff = 0;
        return false;
      }
      if (!value || value.length === 0) continue;
      this.bytesSinceLease += value.length;
      if (this.onBytesThreshold && this.bytesSinceLease >= this.renewThresholdBytes) {
        this.bytesSinceLease = 0;
        await this.onBytesThreshold();
      }
      this.cur = value;
      this.curOff = 0;
      return true;
    }
  }

  private async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (!this.cur || this.curOff >= this.cur.length) {
        const ok = await this.pullNextChunk();
        if (!ok) throw new Error(`unexpected EOF skipping ${left} bytes at pack offset ${this.pos}`);
        continue;
      }
      const avail = this.cur.length - this.curOff;
      const take = Math.min(avail, left);
      this.curOff += take;
      this.pos += take;
      left -= take;
    }
  }

  async readAt(dataOff: number, dataLen: number): Promise<Uint8Array> {
    if (dataOff < this.pos) {
      throw new Error(`non-monotonic pack read: requested offset ${dataOff} < current ${this.pos}`);
    }
    if (dataOff > this.pos) {
      await this.skip(dataOff - this.pos);
    }
    const out = new Uint8Array(dataLen);
    let written = 0;
    while (written < dataLen) {
      if (!this.cur || this.curOff >= this.cur.length) {
        const ok = await this.pullNextChunk();
        if (!ok) throw new Error(`unexpected EOF reading ${dataLen - written} bytes at pack offset ${this.pos}`);
        continue;
      }
      const avail = this.cur.length - this.curOff;
      const take = Math.min(avail, dataLen - written);
      out.set(this.cur.subarray(this.curOff, this.curOff + take), written);
      this.curOff += take;
      this.pos += take;
      written += take;
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cur = null;
    try {
      await this.reader.cancel();
    } catch {
      // stream already drained or errored
    }
  }
}

export interface StreamWorkerWarmCloneOptions {
  bucket: R2Bucket;
  stub: WorkerUploadStub;
  plan: Extract<PlanWorkerWarmCloneResult, { tag: "leased" }>;
  v2: boolean;
  sideband: boolean;
  noProgress: boolean;
  keepaliveMs: number;
  signal?: AbortSignal | null;
}

/**
 * Worker-side uploadPack stream for warm full clones (SPEC-0024 M4.0):
 * - Zero-copy single-pack passthrough (`worker-passthrough`) when one clean R2 pack
 *   covers the entire reachable set (1 R2.get total).
 * - Multi-pack sequential streaming (`worker-stream`) using at most 1 R2.get per pack.
 * - Stream opens immediately with preamble + optional `0005\x01` keepalive; rejects
 *   mid-stream lease denials before any `FLUSH` (SPEC-0011 Property A).
 */
export function streamWorkerWarmFullClone(opts: StreamWorkerWarmCloneOptions): Response {
  const { bucket, stub, plan, v2, sideband, noProgress, keepaliveMs, signal } = opts;
  const passthrough = plan.passthroughR2Key !== null && plan.passthroughPackKey !== null;

  const headers: Record<string, string> = {
    "content-type": "application/x-git-upload-pack-result",
    "cache-control": "no-cache",
    "x-upload-plane": passthrough ? "worker-passthrough" : "worker-stream",
  };

  let leaseExpiresAt = plan.expiresAt;
  const ensureLeaseValid = async (packKey: string | null): Promise<void> => {
    if (!plan.planId) return;
    if (Date.now() < leaseExpiresAt - READ_RENEW_MARGIN_MS) return;
    const r = await stub.renewAndAuthorizeRead(plan.planId, packKey, null);
    if (r.tag !== "authorized") {
      throw new Error(`read lease rejected (${r.reason}); terminating — re-fetch`);
    }
    leaseExpiresAt = r.expiresAt;
  };
  const forceRenewLease = async (packKey: string | null): Promise<void> => {
    if (!plan.planId) return;
    const r = await stub.renewAndAuthorizeRead(plan.planId, packKey, null);
    if (r.tag !== "authorized") {
      throw new Error(`read lease rejected (${r.reason}); terminating — re-fetch`);
    }
    leaseExpiresAt = r.expiresAt;
  };
  const releaseLeaseBestEffort = async (): Promise<void> => {
    if (!plan.planId) return;
    try {
      await stub.releaseReadLease(plan.planId);
    } catch {
      // expiry sweep is the backstop
    }
  };
  const checkAborted = (): void => {
    if (signal?.aborted) throw new Error("client aborted upload-pack stream");
  };

  let ctrlRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let ended = false;
  let inPull = false;
  let framesSinceTick = false;
  let activeReader: { close(): Promise<void> } | null = null;

  const timer =
    sideband && keepaliveMs > 0
      ? setInterval(() => {
          if (ended || !inPull || !ctrlRef) return;
          if (framesSinceTick) {
            framesSinceTick = false;
            return;
          }
          try {
            ctrlRef.enqueue(UPLOAD_KEEPALIVE_FRAME);
          } catch {
            ended = true;
          }
        }, keepaliveMs)
      : null;

  const stopTimer = () => {
    ended = true;
    if (timer !== null) clearInterval(timer);
  };

  const enqueue = (ctrl: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void => {
    framesSinceTick = true;
    ctrl.enqueue(chunk);
  };

  const preamble = pkt(v2 ? "packfile\n" : "NAK\n");

  if (passthrough) {
    let rawReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let opened = false;
    let started = false;
    let bytesRead = 0;
    let bytesSinceRenew = 0;

    activeReader = {
      close: async () => {
        if (!rawReader) return;
        const r = rawReader;
        rawReader = null;
        try {
          await r.cancel();
        } catch {
          // best effort
        }
      },
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        ctrlRef = ctrl;
        started = true;
        enqueue(ctrl, preamble);
        if (sideband && !noProgress) {
          for (const f of uploadSidebandFrames(2, te.encode(`Enumerating objects: ${plan.total}, done.\n`))) {
            enqueue(ctrl, f);
          }
        }
      },
      pull: async (ctrl) => {
        inPull = true;
        try {
          checkAborted();
          if (!opened) {
            opened = true;
            await ensureLeaseValid(plan.passthroughPackKey);
            const obj = await bucket.get(plan.passthroughR2Key!);
            if (!obj) {
              throw new Error(`missing passthrough R2 pack ${plan.passthroughR2Key}`);
            }
            rawReader = obj.body.getReader();
          }
          if (bytesSinceRenew >= WORKER_UPLOAD_RENEW_BYTES || Date.now() >= leaseExpiresAt - READ_RENEW_MARGIN_MS) {
            bytesSinceRenew = 0;
            await forceRenewLease(plan.passthroughPackKey);
          }
          const { done, value } = await rawReader!.read();
          checkAborted();
          if (done) {
            if (!started || bytesRead < 32) {
              throw new Error(`truncated passthrough R2 pack ${plan.passthroughR2Key} (${bytesRead} bytes)`);
            }
            stopTimer();
            rawReader = null;
            await releaseLeaseBestEffort();
            if (sideband) enqueue(ctrl, FLUSH);
            ctrl.close();
            return;
          }
          if (value && value.length > 0) {
            bytesRead += value.length;
            bytesSinceRenew += value.length;
            if (sideband) {
              for (const f of uploadSidebandFrames(1, value)) enqueue(ctrl, f);
            } else {
              enqueue(ctrl, value);
            }
          }
        } catch (err) {
          stopTimer();
          await activeReader?.close();
          await releaseLeaseBestEffort();
          ctrl.error(err);
        } finally {
          inPull = false;
        }
      },
      cancel: async () => {
        stopTimer();
        await activeReader?.close();
        await releaseLeaseBestEffort();
      },
    });
    return new Response(stream, { headers });
  }

  // Multi-pack sequential streaming merge (at most 1 R2.get per pack).
  const pending: Uint8Array[] = [];
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  const flushBuffered = () => {
    if (!bufferedLen) return;
    const payload = concat(buffered);
    buffered = [];
    bufferedLen = 0;
    if (sideband) pending.push(...uploadSidebandFrames(1, payload));
    else pending.push(payload);
  };
  const writer = new PackWriter((chunk) => {
    buffered.push(chunk);
    bufferedLen += chunk.length;
    if (bufferedLen >= SIDEBAND_CHUNK) flushBuffered();
  });

  let packIdx = 0;
  let packOpened = false;
  let afterOffset = -1;
  let pageRows: WorkerPackedEntry[] = [];
  let pageCursor = 0;
  let pageHasMore = true;
  let seqReader: SequentialR2PackReader | null = null;
  let looseDone = !plan.hasLoose;
  let afterOid = "";
  let looseRows: WorkerLooseEntry[] = [];
  let looseCursor = 0;
  let looseHasMore = plan.hasLoose;
  let emitted = 0;
  let finished = false;

  activeReader = {
    close: async () => {
      if (seqReader) {
        const r = seqReader;
        seqReader = null;
        await r.close();
      }
    },
  };

  const emitOneEntry = async (): Promise<boolean> => {
    while (packIdx < plan.packs.length) {
      const p = plan.packs[packIdx]!;
      if (!packOpened) {
        packOpened = true;
        afterOffset = -1;
        pageRows = [];
        pageCursor = 0;
        pageHasMore = true;
        await ensureLeaseValid(p.packKey);
        if (p.location === "r2") {
          if (!p.r2Key) throw new Error(`missing r2Key for R2 pack ${p.packKey}`);
          const obj = await bucket.get(p.r2Key);
          if (!obj) throw new Error(`missing R2 pack ${p.r2Key}`);
          seqReader = new SequentialR2PackReader(obj.body, () => ensureLeaseValid(p.packKey));
        }
      }
      if (pageCursor >= pageRows.length) {
        if (!pageHasMore) {
          if (seqReader) {
            await seqReader.close();
            seqReader = null;
          }
          packIdx++;
          packOpened = false;
          continue;
        }
        const page = await stub.readWarmClonePage(plan.planId, p.packKey, afterOffset, WORKER_UPLOAD_PAGE_SIZE);
        if (page.tag === "rejected") {
          throw new Error(`read lease rejected (${page.reason}); terminating — re-fetch`);
        }
        pageRows = page.rows;
        pageHasMore = page.hasMore;
        pageCursor = 0;
        if (pageRows.length === 0) {
          pageHasMore = false;
          continue;
        }
      }
      const entry = pageRows[pageCursor++]!;
      afterOffset = entry.offset;
      if (!isOid(entry.oid)) throw new Error(`invalid oid in upload plan: ${entry.oid}`);
      if (p.location === "r2" && seqReader) {
        if (!entry.baseOid || entry.baseInPack) {
          const raw = await seqReader.readAt(entry.dataOff, entry.dataLen);
          if (!entry.baseOid) writer.rawFull(entry.type, entry.entrySize, raw);
          else writer.rawDelta(entry.entrySize, entry.baseOid, raw);
        } else {
          // External delta base is unreachable: inflate full object via DO with read lease.
          await seqReader.readAt(entry.dataOff, entry.dataLen);
          const obj = await stub.readUploadObject(plan.planId, entry.oid);
          if (obj.tag === "rejected") throw new Error(`read lease rejected (${obj.reason}); terminating — re-fetch`);
          if (obj.tag === "missing") throw new Error(`missing object ${entry.oid}`);
          writer.object(obj.type, obj.data);
        }
      } else {
        // sqlite-backed pack or missing reader: fetch inflated object via DO under read lease.
        const obj = await stub.readUploadObject(plan.planId, entry.oid);
        if (obj.tag === "rejected") throw new Error(`read lease rejected (${obj.reason}); terminating — re-fetch`);
        if (obj.tag === "missing") throw new Error(`missing object ${entry.oid}`);
        writer.object(obj.type, obj.data);
      }
      emitted++;
      return true;
    }

    if (!looseDone) {
      for (;;) {
        if (looseCursor < looseRows.length) {
          const l = looseRows[looseCursor++]!;
          afterOid = l.oid;
          writer.object(l.type, l.data);
          emitted++;
          return true;
        }
        if (!looseHasMore) {
          looseDone = true;
          break;
        }
        const page = await stub.readWarmLoosePage(plan.planId, afterOid, 64);
        if (page.tag === "rejected") {
          throw new Error(`read lease rejected (${page.reason}); terminating — re-fetch`);
        }
        looseRows = page.rows;
        looseHasMore = page.hasMore;
        looseCursor = 0;
        if (looseRows.length === 0) {
          looseDone = true;
          break;
        }
      }
    }
    return false;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      ctrlRef = ctrl;
      enqueue(ctrl, preamble);
      if (sideband && !noProgress) {
        for (const f of uploadSidebandFrames(2, te.encode(`Enumerating objects: ${plan.total}, done.\n`))) {
          enqueue(ctrl, f);
        }
      }
      writer.header(plan.total);
      flushBuffered();
      for (const c of pending) enqueue(ctrl, c);
      pending.length = 0;
    },
    pull: async (ctrl) => {
      inPull = true;
      try {
        checkAborted();
        let drained = false;
        for (let n = 0; n < 64; n++) {
          const hadMore = await emitOneEntry();
          checkAborted();
          if (!hadMore) {
            drained = true;
            break;
          }
        }
        if (drained && !finished) {
          if (emitted !== plan.total) {
            throw new Error(`reachable set drifted mid-clone: emitted ${emitted}, declared ${plan.total}`);
          }
          finished = true;
          writer.finish();
          flushBuffered();
          if (sideband) pending.push(FLUSH);
        } else {
          flushBuffered();
        }
        for (const c of pending) enqueue(ctrl, c);
        pending.length = 0;
        if (finished) {
          stopTimer();
          await activeReader?.close();
          await releaseLeaseBestEffort();
          ctrl.close();
        }
      } catch (err) {
        stopTimer();
        await activeReader?.close();
        await releaseLeaseBestEffort();
        ctrl.error(err);
      } finally {
        inPull = false;
      }
    },
    cancel: async () => {
      stopTimer();
      await activeReader?.close();
      await releaseLeaseBestEffort();
    },
  });
  return new Response(stream, { headers });
}
