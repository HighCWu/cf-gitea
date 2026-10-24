/**
 * gzip request bodies — SPEC-0003 §2.3/§4.6.
 *
 * Upstream wraps the RPC body in a gzip reader when
 * `Content-Encoding: gzip` and answers 400 on malformed gzip
 * (githttp.go:397-405). cf-gitea streams `request.body` through the
 * workerd-native `DecompressionStream("gzip")` — zero-copy, never buffered —
 * plus a counting transform that aborts at the decompressed-size cap, which
 * upstream's unbounded reader does not have.
 */

/** Decompressed-size cap (§4.6): receive quota × small factor, default
 *  1.1 GiB. Aborts the stream; a client cannot force unbounded memory. */
export const MAX_GUNZIP_BYTES = Math.round(1.1 * 1024 * 1024 * 1024);

/**
 * workerd types `Request.body`/`Response.body` loosely (`ReadableStream<any>`);
 * every body this adapter touches is a byte stream. Plain `as` (no `any`
 * introduction, no `as unknown as`).
 */
export function asByteStream(body: ReadableStream): ReadableStream<Uint8Array> {
  return body as ReadableStream<Uint8Array>;
}

/**
 * Pipe an encoded body through gzip decompression with a byte cap. The
 * returned stream errors (and the upstream read aborts) when the decompressed
 * size exceeds `cap` or the payload is not valid gzip.
 */
export function gunzipCapped(body: ReadableStream<Uint8Array>, cap: number = MAX_GUNZIP_BYTES): ReadableStream<Uint8Array> {
  let total = 0;
  const counting: TransformStream<Uint8Array, Uint8Array> = new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) {
        controller.error(new Error(`decompressed body exceeds ${cap} byte cap`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(counting);
}

/**
 * Surface the first read of `stream` before the caller commits to it: the
 * returned stream replays the whole (already-started) stream, while errors on
 * the very first chunk — malformed gzip headers, cap-aborted prefixes — throw
 * here, so the gate can answer a clean 400 before invoking the engine
 * ("400 before any storage write", §4.6). Later errors propagate through the
 * returned stream to the engine's read as a failed body.
 */
export async function withVerifiedStart<T>(stream: ReadableStream<T>): Promise<ReadableStream<T>> {
  const reader = stream.getReader();
  const first = await reader.read(); // throws on malformed gzip / early abort

  const replay: TransformStream<T, T> = new TransformStream();
  const writer = replay.writable.getWriter();
  void (async () => {
    try {
      if (!first.done) await writer.write(first.value);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return replay.readable;
}
