/**
 * Receive pass 1 (SPEC-0001a §3 Step 2): the pack scanner.
 *
 * ONE streaming read of the staged pack walks every entry exactly once —
 * pack header, per-entry type/size varints, REF_DELTA/ofs-delta base
 * references, the compressed region (pako `Inflate`, zlib wrapper, 16 KiB
 * chunks), per-entry CRC-32 over the raw stored bytes, and the pack's own
 * SHA-1 trailer through a 20-byte sliding window. Entries are handed to the
 * visitor as they stream, so delta resolution (receive/delta.ts) runs eagerly
 * in file order — git clients always write a delta after its base — and the
 * whole scan never buffers more than one entry.
 *
 * Bounds (SPEC-0001 §7 fuzz surface): inflated output must match the
 * header-declared entry size exactly, and a zlib stream can never
 * legitimately exceed ~1032:1, so output past `consumed * 1000 + 64 KiB` is
 * rejected as a decompression bomb. Full entries are handed over buffered up
 * to MAX_HANDOVER_FULL (trees/commits must be parseable for the connectivity
 * anti-check; bigger objects are stream-hashed and dropped); delta streams up
 * to MAX_HANDOVER_DELTA are handed over inline, anything larger defers to the
 * straggler pass. A pack declaring more than MAX_PACK_ENTRIES entries is
 * rejected up front (allocation limit).
 */
import pako from "pako";
import { td, toHex, Sha1 } from "../git/util";
import { Sha1Dc, Sha1CollisionError } from "../git/sha1";
import { NUM_TYPE, objectHeader, ObjType } from "../git/objects";
import { Crc32 } from "./idx";

export const INFLATE_CHUNK = 16 * 1024;

/** zlib's worst legitimate ratio is ~1032:1; anything past this is a bomb. */
const BOMB_RATIO = 1000;
const BOMB_SLACK = 64 * 1024;
/** full entries up to this size are handed to the visitor buffered */
export const MAX_HANDOVER_FULL = 64 * 1024 * 1024;
/** delta streams up to this size are handed over inline (applyDelta materializes them anyway) */
export const MAX_HANDOVER_DELTA = 8 * 1024 * 1024;
/** fuzz bound (SPEC-0001 §7 allocation limits) */
export const MAX_PACK_ENTRIES = 4_000_000;

/** Chunked inflate of a fully-buffered region (straggler delta streams). */
export function inflateAll(data: Uint8Array): Uint8Array {
  const inf = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
  inf.push(data, true);
  if (inf.err) throw new Error(`inflate failed: ${inf.msg}`);
  return inf.result as Uint8Array;
}

// Ingest is strictly sequential, so scratch hashers serve every object. The
// SHA-1DC pair is used only when collision detection is enabled; the plain
// streaming hasher covers the flag-off huge-object path. (Relocated from
// git/packstore.ts — pure machinery, no DO state.)
const scratchSha = new Sha1Dc();
const streamSha = new Sha1Dc();
const streamShaPlain = new Sha1();

/**
 * Finish a SHA-1DC hash, refusing anything carrying a SHA-1 collision-attack
 * block. This is git's post-SHAttered rule: the id is still plain SHA-1, but
 * an object built to collide never enters the database.
 */
export function finishOid(h: Sha1Dc): string {
  const oid = toHex(h.digest());
  if (h.collision) throw new Sha1CollisionError(oid);
  return oid;
}

/**
 * Hash a fully-materialized object. With collision detection off (default) the
 * id comes from native crypto.subtle — byte-identical to plain SHA-1 but ~24x
 * faster than the JS hasher; with it on, SHA-1DC screens every block. The
 * object is already in memory here, so the one-shot header+data buffer adds no
 * unbounded allocation.
 */
export async function hashObjectAsync(type: ObjType, data: Uint8Array, cd: boolean): Promise<string> {
  if (cd) return finishOid(scratchSha.reset().update(objectHeader(type, data.length)).update(data));
  const header = objectHeader(type, data.length);
  const buf = new Uint8Array(header.length + data.length);
  buf.set(header);
  buf.set(data, header.length);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", buf)));
}

/**
 * Streaming reader over a pack body. Chunks arrive from the network and are
 * consumed front-first; `window()` exposes the front chunk whole (the inflate
 * loop pushes it and reports how much it consumed), `exact()` copies small
 * spans across chunk boundaries.
 */
class StreamedReader {
  pos = 0;
  private chunks: Uint8Array[] = [];
  private eof = false;

  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.chunks.length) return true;
    if (this.eof) return false;
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.eof = true;
        return false;
      }
      if (value && value.length) {
        this.chunks.push(value);
        return true;
      }
    }
  }

  async byte(): Promise<number> {
    if (!(await this.fill())) throw new Error("unexpected end of pack");
    const c = this.chunks[0];
    const b = c[0];
    if (c.length === 1) this.chunks.shift();
    else this.chunks[0] = c.subarray(1);
    this.pos++;
    return b;
  }

  /** The whole front chunk (non-empty), or null once the body is exhausted. */
  async window(): Promise<Uint8Array | null> {
    if (!(await this.fill())) return null;
    return this.chunks[0];
  }

  /** Advance past `n` bytes of the front window (the inflater consumed them). */
  advance(n: number): void {
    let left = n;
    while (left > 0) {
      const c = this.chunks[0];
      if (c.length <= left) {
        this.chunks.shift();
        left -= c.length;
      } else {
        this.chunks[0] = c.subarray(left);
        left = 0;
      }
    }
    this.pos += n;
  }

  /** Read exactly `n` bytes (copies across chunk boundaries). */
  async exact(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      if (!(await this.fill())) throw new Error("unexpected end of pack");
      const c = this.chunks[0];
      const take = Math.min(c.length, n - off);
      out.set(c.subarray(0, take), off);
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
      off += take;
      this.pos += take;
    }
    return out;
  }
}

interface EntryMeta {
  index: number;
  /** entry start (the type/size header) */
  offset: number;
  /** start of the compressed region */
  dataOff: number;
  /** length of the compressed region (incl. REF_DELTA base oid / ofs bytes) */
  dataLen: number;
  /** header-declared inflated size (content size, or delta-stream size) */
  entrySize: number;
  /** CRC-32 of the raw stored bytes (header through compressed end) */
  crc32: number;
}

export interface FullEntry extends EntryMeta {
  kind: "full";
  objType: ObjType;
  oid: string;
  /** buffered content, null when stream-hashed (over MAX_HANDOVER_FULL) */
  content: Uint8Array | null;
}

export interface DeltaEntry extends EntryMeta {
  kind: "delta";
  /** REF_DELTA base oid (type 7), null otherwise */
  refBase: string | null;
  /** ofs-delta base entry offset (type 6), -1 otherwise */
  ofsBase: number;
  /** inflated delta stream, null when over MAX_HANDOVER_DELTA (straggler pass re-reads it) */
  data: Uint8Array | null;
}

export type PackEntry = FullEntry | DeltaEntry;

export interface PackSource {
  /** ONE streaming GET of the staged object */
  body: ReadableStream<Uint8Array>;
  /** exact byte size of the object (the R2 object size) */
  size: number;
}

export interface WalkOptions {
  /** screen every object with SHA-1DC (env SHA1DC === "1") */
  collisionDetect?: boolean;
  /** called once the header is parsed (before the first entry) */
  onHeader?: (count: number, version: number) => void;
  /** periodic progress text ("Indexing objects: n/total") */
  onProgress?: (msg: string) => void;
}

export interface WalkResult {
  packSha1: string;
  version: number;
  count: number;
}

/**
 * Walk every entry of the pack exactly once, handing each to `visit` as it
 * streams. Verifies the pack signature, version, per-entry structure and
 * bounds, the entry count against the byte length, and the trailing SHA-1.
 */
export async function walkPack(
  src: PackSource,
  visit: (entry: PackEntry) => Promise<void>,
  opts: WalkOptions = {}
): Promise<WalkResult> {
  if (src.size < 32) throw new Error("pack too small");
  const reader = src.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const r = new StreamedReader(reader);
  const cd = opts.collisionDetect ?? false;
  // the pack's own SHA-1: everything except the 20-byte trailer, via a
  // sliding window so the trailer is never hashed as content
  const sha = new Sha1();
  let tail = new Uint8Array(0);
  const absorb = (data: Uint8Array) => {
    let joined = data;
    if (tail.length) {
      joined = new Uint8Array(tail.length + data.length);
      joined.set(tail);
      joined.set(data, tail.length);
    }
    if (joined.length > 20) {
      sha.update(joined.subarray(0, joined.length - 20));
      tail = joined.slice(joined.length - 20);
    } else {
      tail = joined.slice();
    }
  };
  try {
    const magic = await r.exact(4);
    absorb(magic);
    if (td.decode(magic) !== "PACK") throw new Error("bad pack signature");
    let version = 0;
    for (const b of await r.exact(4)) {
      absorb(new Uint8Array([b]));
      version = (version << 8) | b;
    }
    let count = 0;
    for (const b of await r.exact(4)) {
      absorb(new Uint8Array([b]));
      count = (count << 8) | b;
    }
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
    if (count > MAX_PACK_ENTRIES) throw new Error(`pack declares ${count} objects; refusing`);
    opts.onHeader?.(count, version);

    for (let i = 0; i < count; i++) {
      const entryOffset = r.pos;
      const crc = new Crc32();
      const take = async (n: number): Promise<Uint8Array> => {
        const b = await r.exact(n);
        absorb(b);
        crc.update(b);
        return b;
      };
      const byte = async (): Promise<number> => (await take(1))[0];

      let hdr = await byte();
      const type = (hdr >> 4) & 7;
      let entrySize = hdr & 15;
      let shift = 4;
      while (hdr & 0x80) {
        hdr = await byte();
        entrySize += (hdr & 0x7f) * 2 ** shift;
        shift += 7;
      }
      let refBase: string | null = null;
      let ofsBase = -1;
      if (type === 6) {
        let hb = await byte();
        let off = hb & 0x7f;
        while (hb & 0x80) {
          hb = await byte();
          off = (off + 1) * 128 + (hb & 0x7f);
        }
        ofsBase = entryOffset - off;
        if (off <= 0 || ofsBase < 12) throw new Error(`bad delta base offset at ${entryOffset}`);
      } else if (type === 7) {
        refBase = toHex(await take(20));
      } else if (!NUM_TYPE[type]) {
        throw new Error(`bad object type ${type} at ${entryOffset}`);
      }

      const dataOff = r.pos;
      const isFull = type >= 1 && type <= 4;
      const objType = isFull ? NUM_TYPE[type] : null;
      const handover = isFull ? entrySize <= MAX_HANDOVER_FULL : entrySize <= MAX_HANDOVER_DELTA;
      const content = handover ? new Uint8Array(entrySize) : null;
      if (isFull && !handover) {
        (cd ? streamSha : streamShaPlain).reset().update(objectHeader(objType!, entrySize));
      }
      let inflated = 0;
      let consumed = 0;
      const inf = new pako.Inflate({ chunkSize: INFLATE_CHUNK });
      const anyInf = inf as unknown as {
        onData: (c: Uint8Array) => void;
        err: number;
        msg: string;
        ended: boolean;
        strm: { avail_in: number };
      };
      anyInf.onData = (c: Uint8Array) => {
        const prev = inflated;
        inflated += c.length;
        if (inflated > entrySize) throw new Error(`entry at ${entryOffset} inflates past its declared size`);
        if (content) content.set(c, prev);
        else if (isFull) (cd ? streamSha : streamShaPlain).update(c);
      };
      for (;;) {
        if (anyInf.ended) break;
        const win = await r.window();
        if (win === null || win.length === 0) throw new Error(`truncated pack entry at ${entryOffset}`);
        inf.push(win, false);
        if (anyInf.err) throw new Error(`inflate failed at ${dataOff}: ${anyInf.msg}`);
        const used = anyInf.ended ? win.length - anyInf.strm.avail_in : win.length;
        r.advance(used);
        const slice = used === win.length ? win : win.subarray(0, used);
        absorb(slice);
        crc.update(slice);
        consumed += used;
      }
      if (inflated !== entrySize) throw new Error(`entry size mismatch at ${entryOffset}`);
      // bomb guard, evaluated at stream end: no valid zlib stream exceeds
      // ~1032:1 cumulatively, so anything past ~1000:1 is a decompression
      // bomb (SPEC-0001 §2/§7). The check must NOT run per chunk — a single
      // back-reference block legitimately expands thousands-to-one at a chunk
      // boundary before later blocks even the ratio out.
      if (inflated > consumed * BOMB_RATIO + BOMB_SLACK) {
        throw new Error(`inflate output bound exceeded at ${entryOffset}`);
      }
      const dataLen = r.pos - dataOff;

      if (isFull) {
        const oid = handover
          ? await hashObjectAsync(objType!, content!, cd)
          : cd
            ? finishOid(streamSha)
            : toHex(streamShaPlain.digest());
        await visit({
          kind: "full", index: i, offset: entryOffset, dataOff, dataLen,
          entrySize, crc32: crc.get(), objType: objType!, oid, content,
        });
      } else {
        await visit({
          kind: "delta", index: i, offset: entryOffset, dataOff, dataLen,
          entrySize, crc32: crc.get(), refBase, ofsBase, data: handover ? content : null,
        });
      }
      // yield to the event loop so a long scan cannot starve the isolate
      if ((i & 8191) === 8191) await new Promise((res) => setTimeout(res, 0));
      if (opts.onProgress && i % 100000 === 99999) {
        opts.onProgress(`Indexing objects: ${i + 1}/${count}\n`);
      }
    }

    if (r.pos !== src.size - 20) throw new Error("pack has trailing data or bad object count");
    const trailer = await r.exact(20);
    // the sliding window held the last 20 bytes back; absorb the trailer so
    // the digest covers data[0..size-20) — the pack's own SHA-1 (same idiom
    // as the staging path, which absorbs the whole stream)
    absorb(trailer);
    const packSha1 = toHex(sha.digest());
    if (toHex(trailer) !== packSha1) throw new Error("pack checksum mismatch");
    if ((await r.window()) !== null) throw new Error("pack has trailing data or bad object count");
    return { packSha1, version, count };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the body may already be closed or errored
    }
  }
}
