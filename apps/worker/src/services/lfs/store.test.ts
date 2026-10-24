/**
 * Relay store integration on the real R2 binding (SPEC-0006 §5): roundtrip,
 * single-pass hash/size enforcement with object cleanup on mismatch, and the
 * stored-checksum contract the adopt path (§3.3) relies on.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  LfsHashMismatchError,
  LfsKeyError,
  LfsSizeMismatchError,
  lfsKey,
  RelayLfsStore,
  sha256Hex,
} from "./store";
import { InvalidPointerError } from "./pointer";

/**
 * Fixtures pair content with its REAL oid — the store enforces
 * sha256(content) == oid, so test oids must be honest hashes. Digesting is
 * async, so the pairs are derived in beforeAll.
 */
const CONTENT_A = new Uint8Array(1024).fill(7);
const CONTENT_B = new Uint8Array(32).fill(11);
const CONTENT_RANGED = new Uint8Array(2048).fill(9);
let OID_A = "";
let OID_B = "";
let OID_RANGED = "";
const KEY_A = (): string => lfsKey("r_1", OID_A);
const KEY_RANGED = (): string => lfsKey("r_1", OID_RANGED);

const store = (): RelayLfsStore => new RelayLfsStore(env.REPO_PACKS);

const bytes = (fill: number, length: number): Uint8Array => new Uint8Array(length).fill(fill);

/** Narrow after an assertion — keeps the tests cast-free. */
function mustBeBody(body: R2ObjectBody | R2Object | null): R2ObjectBody {
  if (body === null) throw new Error("expected an object body, got null");
  if (!("body" in body)) throw new Error("expected a readable body");
  return body;
}

beforeAll(async () => {
  OID_A = await sha256Hex(CONTENT_A);
  OID_B = await sha256Hex(CONTENT_B);
  OID_RANGED = await sha256Hex(CONTENT_RANGED);
});

beforeEach(async () => {
  await env.REPO_PACKS.delete(KEY_A());
  await env.REPO_PACKS.delete(KEY_RANGED());
});

describe("lfsKey", () => {
  it("builds lfs/<storage_key>/<oid> and gates both segments", () => {
    expect(lfsKey("r_42", OID_A)).toBe(`lfs/r_42/${OID_A}`);
    expect(() => lfsKey("../escape", OID_A)).toThrow(LfsKeyError);
    expect(() => lfsKey("r_42", "ZZ")).toThrow(InvalidPointerError);
    expect(() => lfsKey("r_42", OID_A.toUpperCase())).toThrow(InvalidPointerError);
  });
});

describe("roundtrip (buffer body)", () => {
  it("puts, heads, gets and deletes with the checksum bound", async () => {
    expect(await sha256Hex(CONTENT_A)).toBe(OID_A); // fixture sanity: content ⟷ oid

    await store().put(KEY_A(), CONTENT_A, { size: CONTENT_A.byteLength, expectedSha256Hex: OID_A });
    expect(await env.REPO_PACKS.head(KEY_A())).not.toBeNull();

    const stat = await store().head(KEY_A());
    expect(stat).toEqual({ size: 1024, sha256Hex: OID_A });

    const body = mustBeBody(await store().get(KEY_A()));
    expect(await sha256Hex(new Uint8Array(await body.arrayBuffer()))).toBe(OID_A);

    await store().delete(KEY_A());
    expect(await store().head(KEY_A())).toBeNull();
    expect(await store().get(KEY_A())).toBeNull();
  });

  it("missing objects read as null, not 404 errors", async () => {
    expect(await store().head(lfsKey("r_1", OID_B))).toBeNull();
    expect(await store().get(lfsKey("r_1", OID_B))).toBeNull();
  });
});

describe("streaming put (single-pass hash-and-forward)", () => {
  const streamOf = (content: Uint8Array, chunks: number): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const step = Math.ceil(content.byteLength / chunks);
        for (let i = 0; i < content.byteLength; i += step) {
          controller.enqueue(content.subarray(i, i + step));
        }
        controller.close();
      },
    });

  it("streams a multi-chunk body through a FixedLengthStream with the hash verified", async () => {
    await store().put(KEY_A(), streamOf(CONTENT_A, 4), {
      size: CONTENT_A.byteLength,
      expectedSha256Hex: OID_A,
    });
    const stat = await store().head(KEY_A());
    expect(stat?.size).toBe(CONTENT_A.byteLength);
    expect(stat?.sha256Hex).toBe(OID_A);
  });

  it("hash mismatch deletes the object and throws the upstream message", async () => {
    const content = bytes(3, 1024); // sha256 ≠ OID_A
    await expect(store().put(KEY_A(), streamOf(content, 1), { size: 1024, expectedSha256Hex: OID_A })).rejects.toThrow(
      new LfsHashMismatchError(),
    );
    expect(await env.REPO_PACKS.head(KEY_A())).toBeNull();
  });

  it("lying Content-Length aborts the put and deletes the object", async () => {
    const content = bytes(3, 1000);
    await expect(store().put(KEY_A(), streamOf(content, 1), { size: 1024, expectedSha256Hex: OID_A })).rejects.toThrow(
      LfsSizeMismatchError,
    );
    expect(await env.REPO_PACKS.head(KEY_A())).toBeNull();
  });

  it("buffer-body mismatch is caught before storage, typed, and clean", async () => {
    await expect(store().put(KEY_A(), bytes(5, 512), { expectedSha256Hex: OID_A })).rejects.toThrow(
      LfsHashMismatchError,
    );
    expect(await env.REPO_PACKS.head(KEY_A())).toBeNull();
  });
});

describe("range get", () => {
  it("serves a byte range for resume support", async () => {
    await store().put(KEY_RANGED(), CONTENT_RANGED, {
      size: CONTENT_RANGED.byteLength,
      expectedSha256Hex: OID_RANGED,
    });
    const ranged = mustBeBody(await store().get(KEY_RANGED(), { range: { offset: 100, length: 50 } }));
    expect(ranged.size).toBe(CONTENT_RANGED.byteLength);
    const slice = new Uint8Array(await ranged.arrayBuffer());
    expect(slice).toHaveLength(50);
    expect(slice[0]).toBe(9);
  });
});
