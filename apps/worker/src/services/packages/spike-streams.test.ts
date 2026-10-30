// TEMPORARY SPIKE — deleted before landing. Probes workerd's
// Compression/DecompressionStream semantics the M7 index builders depend on.

import { describe, expect, it } from "vitest";

async function bytesFrom(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function gzipOf(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(data);
  void writer.close();
  return bytesFrom(cs.readable as ReadableStream<Uint8Array>);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

describe("spike: workerd compression streams", () => {
  it("round-trips CompressionStream gzip", async () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < data.length; i++) data[i] = i % 7;
    const gz = await gzipOf(data);
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    const back = await bytesFrom(streamOf(gz).pipeThrough(new DecompressionStream("gzip")));
    expect([...back]).toEqual([...data]);
  });

  it("gzip DecompressionStream is SINGLE-MEMBER strict — concatenated members error with trailing bytes (the 2026-10-31 workerd drift, re-pinned)", async () => {
    // Platform re-documentation: the original spike pinned transparent
    // multi-member decompression; the current workerd errors the moment
    // the first member's stream ends with bytes behind it ("Trailing bytes
    // after end of compressed data"). distro-common.ts's concatenated-member
    // walk (the P1-6 index builders) is built AROUND this strict decoder —
    // this pin is the platform contract it relies on.
    const a = new TextEncoder().encode("member-one-payload");
    const b = new TextEncoder().encode("member-two-payload");
    const joined = concat(await gzipOf(a), await gzipOf(b));
    await expect(
      bytesFrom(streamOf(joined).pipeThrough(new DecompressionStream("gzip"))),
    ).rejects.toThrowError(/Trailing bytes|compressed data/);
  });

  it("decompresses a single member followed by garbage (member-split probe)", async () => {
    const a = new TextEncoder().encode("member-one-payload");
    const b = new TextEncoder().encode("member-two-payload");
    const joined = concat(await gzipOf(a), await gzipOf(b));
    const memberOneLength = (await gzipOf(a)).byteLength;
    const truncated = joined.subarray(0, memberOneLength); // exactly member 1
    const withTrailing = joined; // member 1 + more input

    // Exactly one member decodes cleanly.
    const clean = await bytesFrom(streamOf(truncated).pipeThrough(new DecompressionStream("gzip")));
    expect(new TextDecoder().decode(clean)).toBe("member-one-payload");

    // Member 1 followed by a SECOND member: does the decoder stop at member 1
    // end (consumed-count measurable) or continue (multi-member)?
    try {
      const out = await bytesFrom(streamOf(withTrailing).pipeThrough(new DecompressionStream("gzip")));
      console.log("SPLIT-PROBE: decoded", out.byteLength, "bytes (multi-member if", (clean.byteLength * 2).toString(), ")");
      expect(out.byteLength).toBe(clean.byteLength + (await gzipOf(b)).byteLength - b.byteLength + b.byteLength);
    } catch (error) {
      console.log("SPLIT-PROBE: errors after member 1 —", String(error));
    }
  });

  it("deflate-raw stops at stream end (trailing garbage behavior)", async () => {
    const a = new TextEncoder().encode("raw-deflate-payload");
    const gz = await gzipOf(a);
    // gzip member: 10-byte header (no extras), deflate data, 8-byte trailer.
    // Reconstruct the raw deflate slice by decoding [10..len-8] — only valid
    // if header has no extra fields; CompressionStream output is that shape.
    const tail = gz.byteLength;
    const rawDeflate = gz.subarray(10, tail - 8);
    const trailer = gz.subarray(tail - 8, tail);
    const joined = concat(rawDeflate, trailer); // raw deflate + the gzip trailer as "garbage"
    try {
      const out = await bytesFrom(streamOf(joined).pipeThrough(new DecompressionStream("deflate-raw")));
      console.log("DEFLATE-RAW: decoded with trailing garbage:", new TextDecoder().decode(out));
    } catch (error) {
      console.log("DEFLATE-RAW: errors on trailing garbage —", String(error));
    }
  });
});
