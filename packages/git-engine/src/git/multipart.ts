import { concat } from "./util";

/** In-progress R2 multipart upload for one pack object (clone cache or raw store). */
export interface MultipartPackUpload {
  uploadPart(data: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

/** Uniform multipart part size. R2 requires every part but the last to be the
 * same size and >= 5 MiB; 16 MiB parts cap a pack at 16 MiB * 10,000 = 160 GiB
 * while holding at most one part in isolate memory at a time. */
export const R2_PART_SIZE = 16 * 1024 * 1024;
/** 64 MiB push ingest part size (SPEC-0024 D2, up to 10,000 * 64 MiB = 640 GiB). */
export const R2_PUSH_PART_SIZE = 64 * 1024 * 1024;

/** Threshold above which pending chunks promote into a single reusable `partSize` slab. */
const SLAB_PROMOTE_BYTES = 1024 * 1024;

/**
 * Buffers a streamed pack into fixed-size R2 multipart parts using a single
 * lazily allocated `partSize` slab (eliminating `2 * partSize` `concat()` spikes
 * inside 128 MiB Workers isolates). Input slices are copied out immediately
 * because upstream stream readers reuse buffers. `uploadPart` must finish
 * reading `data` before resolving.
 */
export class MultipartCapture {
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private slab: Uint8Array | null = null;
  private slabLen = 0;
  private overflow: Uint8Array[] = [];
  private failed = false;
  private completed = false;
  constructor(
    private mp: MultipartPackUpload,
    private readonly partSize = R2_PART_SIZE
  ) {}

  /** True once a part upload or complete/abort has failed (no R2 object exists). */
  get aborted(): boolean {
    return this.failed;
  }

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

  private refillSlab(): void {
    const slab = this.slab;
    if (!slab || this.overflow.length === 0) return;
    while (this.overflow.length > 0 && this.slabLen < this.partSize) {
      const head = this.overflow[0]!;
      const room = this.partSize - this.slabLen;
      if (head.length <= room) {
        slab.set(head, this.slabLen);
        this.slabLen += head.length;
        this.overflow.shift();
      } else {
        slab.set(head.subarray(0, room), this.slabLen);
        this.slabLen = this.partSize;
        this.overflow[0] = head.subarray(room);
      }
    }
  }

  private releaseBuffers(): void {
    this.pending = [];
    this.pendingLen = 0;
    this.slab = null;
    this.slabLen = 0;
    this.overflow = [];
  }

  push(chunk: Uint8Array): void {
    if (this.failed || chunk.length === 0) return;
    if (this.slab === null) {
      const promoteAt = Math.min(this.partSize, SLAB_PROMOTE_BYTES);
      if (this.pendingLen + chunk.length < promoteAt) {
        this.pending.push(chunk.slice());
        this.pendingLen += chunk.length;
        return;
      }
      this.promoteToSlab();
    }
    const slab = this.slab!;
    if (this.overflow.length === 0 && this.slabLen < this.partSize) {
      const fit = Math.min(chunk.length, this.partSize - this.slabLen);
      slab.set(chunk.subarray(0, fit), this.slabLen);
      this.slabLen += fit;
      if (fit < chunk.length) {
        this.overflow.push(chunk.slice(fit));
      }
      return;
    }
    this.overflow.push(chunk.slice());
  }

  async drain(): Promise<void> {
    while (!this.failed && this.slab !== null && this.slabLen === this.partSize) {
      try {
        await this.mp.uploadPart(this.slab);
      } catch {
        await this.abort();
        return;
      }
      this.slabLen = 0;
      this.refillSlab();
    }
  }

  async finish(): Promise<void> {
    if (this.failed) return;
    await this.drain();
    if (this.failed) return;
    try {
      if (this.slab !== null) {
        if (this.slabLen > 0) await this.mp.uploadPart(this.slab.subarray(0, this.slabLen));
      } else if (this.pendingLen > 0) {
        await this.mp.uploadPart(concat(this.pending));
      }
      await this.mp.complete();
      this.completed = true;
    } catch {
      await this.abort();
    }
    this.releaseBuffers();
  }

  async abort(): Promise<void> {
    if (this.failed || this.completed) return;
    this.failed = true;
    this.releaseBuffers();
    try {
      await this.mp.abort();
    } catch {
      // best effort: an un-aborted multipart auto-expires
    }
  }
}

/** Begin a raw R2 multipart upload under `key`. Returns null (caller falls back)
 * if R2 refuses — celld deliberately makes createMultipartUpload throw. */
export async function beginRawMultipart(
  bucket: R2Bucket,
  key: string
): Promise<MultipartPackUpload | null> {
  try {
    const mp = await bucket.createMultipartUpload(key);
    const parts: R2UploadedPart[] = [];
    return {
      uploadPart: async (data) => {
        parts.push(await mp.uploadPart(parts.length + 1, data));
      },
      complete: async () => {
        await mp.complete(parts);
      },
      abort: async () => {
        await mp.abort();
      },
    };
  } catch {
    return null;
  }
}
