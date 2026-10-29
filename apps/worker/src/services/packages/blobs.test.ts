/**
 * The package blob store battery (SPEC-0016 §6 storage plan) over the real
 * local REPO_PACKS binding: the format-gated key construction (invalid
 * segments throw before any R2 call), the PASS-1 spool-and-hash (digests
 * verified against crypto.subtle, the cap checked BEFORE and DURING
 * streaming, the lying-Content-Length mismatch, the spool deleted on every
 * failure path), the PASS-2 copy (content key bytes, spool gone), and the
 * D1 dedup pair.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PACKAGE_BLOB_BYTES,
  PackageBlobTooLargeError,
  PackageSizeMismatchError,
  copySpoolToContentKey,
  getBlobById,
  getOrInsertBlob,
  packageBlobContentKey,
  packageBlobSpoolKey,
  spoolAndHash,
} from "./blobs";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const bucket = () => env.REPO_PACKS;
const spoolPrefix = "packages/tmp/";
const blobPrefix = "packages/blobs/";

async function listKeys(prefix: string): Promise<string[]> {
  const listed = await bucket().list({ prefix });
  return listed.objects.map((object) => object.key);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const text = (s: string) => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// Key construction — format gates BEFORE any R2 call
// ---------------------------------------------------------------------------

describe("key construction", () => {
  it("shards the sha256 key aa/bb/<sha256>", () => {
    const sha = "aabb" + "0".repeat(60);
    expect(packageBlobContentKey(sha)).toBe(`packages/blobs/aa/bb/${sha}`);
  });

  it("throws on a non-sha256 segment (length, alphabet) before any R2 call", () => {
    expect(() => packageBlobContentKey("short")).toThrow(/invalid package blob sha256/);
    expect(() => packageBlobContentKey("A".repeat(64))).toThrow(/invalid package blob sha256/); // uppercase is not our digest form
    expect(() => packageBlobContentKey(`../${"0".repeat(58)}`)).toThrow(/invalid package blob sha256/);
  });

  it("throws on a malformed upload uuid", () => {
    expect(() => packageBlobSpoolKey("../../etc/passwd")).toThrow(/invalid package upload uuid/);
    expect(packageBlobSpoolKey("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "packages/tmp/01234567-89ab-cdef-0123-456789abcdef",
    );
  });
});

// ---------------------------------------------------------------------------
// PASS 1 — spool-and-hash
// ---------------------------------------------------------------------------

describe("spoolAndHash", () => {
  beforeEach(async () => {
    await bucket().delete(await listKeys(spoolPrefix));
    await bucket().delete(await listKeys(blobPrefix));
  });

  it("streams once, lands the spool, and computes the digests in the same pass", async () => {
    const payload = text("hello packages");
    const spoolKey = packageBlobSpoolKey("11111111-2222-3333-4444-555555555555");
    const spooled = await spoolAndHash({
      bucket: bucket(),
      content: streamOf([payload]),
      declaredLength: payload.byteLength,
      spoolKey,
    });
    expect(spooled.size).toBe(payload.byteLength);
    expect(spooled.sha256).toBe(await sha256Hex(payload));
    // The three WebCrypto digests are all computed (md5 stays NULL by design).
    const stored = await bucket().get(spoolKey);
    expect(stored).not.toBeNull();
    const round = await stored?.arrayBuffer();
    expect(new Uint8Array(round ?? new ArrayBuffer(0))).toEqual(payload);
  });

  it("zero-byte bodies spool an empty object", async () => {
    const spooled = await spoolAndHash({ bucket: bucket(), content: streamOf([]), declaredLength: 0 });
    expect(spooled.size).toBe(0);
    expect(spooled.sha256).toBe(await sha256Hex(new Uint8Array(0)));
  });

  it("413 BEFORE streaming when the declared length exceeds the cap (no object created)", async () => {
    const overCap = MAX_PACKAGE_BLOB_BYTES + 1;
    await expect(
      spoolAndHash({ bucket: bucket(), content: streamOf([]), declaredLength: overCap }),
    ).rejects.toThrow(PackageBlobTooLargeError);
    expect(await listKeys(spoolPrefix)).toEqual([]);
  });

  it("413 DURING streaming when the chunks pass the cap mid-body (spool deleted)", async () => {
    // Cap override keeps the fixture tiny; two chunks of 6 bytes vs cap 10.
    await expect(
      spoolAndHash({
        bucket: bucket(),
        content: streamOf([text("123456"), text("789012")]),
        declaredLength: 12,
        maxBytes: 10,
      }),
    ).rejects.toThrow(PackageBlobTooLargeError);
    expect(await listKeys(spoolPrefix)).toEqual([]);
  });

  it("declared/actual mismatch errors the pipe (→ PackageSizeMismatchError) and deletes the spool", async () => {
    await expect(
      spoolAndHash({ bucket: bucket(), content: streamOf([text("12345")]), declaredLength: 10 }),
    ).rejects.toThrow(PackageSizeMismatchError);
    expect(await listKeys(spoolPrefix)).toEqual([]);
  });

  it("the default cap is the SPEC-0005 512 MiB posture", () => {
    expect(MAX_PACKAGE_BLOB_BYTES).toBe(512 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// PASS 2 — the bounded copy
// ---------------------------------------------------------------------------

describe("copySpoolToContentKey", () => {
  beforeEach(async () => {
    await bucket().delete(await listKeys(spoolPrefix));
    await bucket().delete(await listKeys(blobPrefix));
  });

  it("streams the spool to the sharded content key and deletes the spool", async () => {
    const payload = text("second-pass bytes");
    const spoolKey = packageBlobSpoolKey("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const spooled = await spoolAndHash({
      bucket: bucket(),
      content: streamOf([payload]),
      declaredLength: payload.byteLength,
      spoolKey,
    });
    await copySpoolToContentKey(bucket(), spooled.spoolKey, spooled.sha256);
    expect(await listKeys(spoolPrefix)).toEqual([]);
    const content = await bucket().get(packageBlobContentKey(spooled.sha256));
    expect(content).not.toBeNull();
    const round = new Uint8Array((await content?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(round).toEqual(payload);
    expect(await sha256Hex(round)).toBe(spooled.sha256);
  });

  it("a vanished spool throws (and the spool-delete no-ops)", async () => {
    await expect(
      copySpoolToContentKey(bucket(), packageBlobSpoolKey("99999999-8888-7777-6666-555555555555"), "f".repeat(64)),
    ).rejects.toThrow(/vanished/);
  });
});

// ---------------------------------------------------------------------------
// The D1 dedup pair
// ---------------------------------------------------------------------------

describe("getOrInsertBlob / getBlobById", () => {
  it("inserts once and answers the winner's row on a lost race (the UNIQUE arbitration)", async () => {
    const first = await getOrInsertBlob(env.DB, { size: 3, sha256: "e".repeat(64) });
    expect(first.created).toBe(true);
    const winner = await getOrInsertBlob(env.DB, { size: 3, sha256: "e".repeat(64) });
    expect(winner.created).toBe(false);
    expect(winner.row.id).toBe(first.row.id);
    expect((await getBlobById(env.DB, first.row.id))?.hashSha256).toBe("e".repeat(64));
  });

  it("getBlobById misses for an unknown id", async () => {
    expect(await getBlobById(env.DB, 424242)).toBeNull();
  });
});
