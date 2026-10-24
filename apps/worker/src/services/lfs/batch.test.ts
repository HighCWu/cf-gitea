/**
 * Batch v1 shaping table on real D1 + R2 (SPEC-0006 §2.2, §4.8): the
 * per-object error/envelope matrix for upload and download, upstream's exact
 * error strings, the already-present ⇒ no-actions rule, adopt, guards, and
 * whole-request parse failures. Both store modes are exercised through the
 * same shaping code (presign via fixed local credentials, no network).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acceptsLfsMediaType,
  buildRelayHrefBase,
  BatchRequestError,
  DEFAULT_LFS_LIMITS,
  LFS_ACCEPT_HEADER,
  LFS_MEDIA_TYPE,
  parseBatchRequest,
  relayDownloadHref,
  relayUploadHref,
  relayVerifyHref,
  shapeBatchObject,
  shapeBatchResponse,
  type BatchShapingContext,
} from "./batch";
import { LfsStateService } from "./state";
import { checksumHeaderFor, lfsKey, PresignLfsStore, RelayLfsStore, sha256Hex, type LfsStore } from "./store";
import { applyLfsObjectsDdl, resetLfsTables } from "./testing";

const REPO_ID = 21;
const STORAGE_KEY = "r_21";

/**
 * Fixture blobs carry their REAL oid — the store enforces sha256(content) ==
 * oid at put time, so "present/adoptable/downloadable" fixtures must be honest
 * hashes. Roles are assigned in beforeAll; the roles map to the §2.2 table:
 * UPLOAD absent → hrefs, PRESENT verified row + blob, ADOPT blob without row,
 * DOWNLOAD verified + blob.
 */
const OID_BAD = "NOT-HEX";
const OID_MISMATCH = "44".repeat(32); // row-only: size-mismatch path, no blob needed
const OID_BIG = "55".repeat(32); // over maxFileSize
const OID_QUOTA = "66".repeat(32); // over quota
const SIZE = 64;

const CONTENT = {
  UPLOAD: new Uint8Array(SIZE).fill(1), // absent — hrefs issued
  PRESENT: new Uint8Array(SIZE).fill(2), // verified row + object in R2
  ADOPT: new Uint8Array(SIZE).fill(3), // object in R2, no row
  DOWNLOAD: new Uint8Array(SIZE).fill(4), // verified + present, download op
};
const OID: Record<keyof typeof CONTENT, string> = { UPLOAD: "", PRESENT: "", ADOPT: "", DOWNLOAD: "" };

const NOW = new Date("2026-10-24T12:00:00Z");
const LIMITS = { maxFileSize: 1024, maxBatchSize: 3, repoQuota: 4096 };
const AUTH = "Basic dG9rZW46";

const ctx: BatchShapingContext = {
  repoId: REPO_ID,
  storageKey: STORAGE_KEY,
  owner: "alice",
  repo: "proj",
  origin: "https://git.example.com",
  authHeader: AUTH,
};
const RELAY_BASE = "https://git.example.com/alice/proj.git/info/lfs";

const state = (): LfsStateService => new LfsStateService(env.DB);
const relay = (): RelayLfsStore => new RelayLfsStore(env.REPO_PACKS);
const presign = (): PresignLfsStore =>
  new PresignLfsStore(
    env.REPO_PACKS,
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDAG/bJEPyPg5m9mQY2glgvmW", accountId: "acct" },
    { bucketName: "cf-gitea-packs", ttlSeconds: 900 },
  );

beforeAll(async () => {
  OID.UPLOAD = await sha256Hex(CONTENT.UPLOAD);
  OID.PRESENT = await sha256Hex(CONTENT.PRESENT);
  OID.ADOPT = await sha256Hex(CONTENT.ADOPT);
  OID.DOWNLOAD = await sha256Hex(CONTENT.DOWNLOAD);
});

beforeAll(applyLfsObjectsDdl);
beforeEach(async () => {
  await resetLfsTables();
  // Rows are wiped above; blobs are re-put per test (deterministic, idempotent).
  await relay().put(lfsKey(STORAGE_KEY, OID.PRESENT), CONTENT.PRESENT, { size: SIZE, expectedSha256Hex: OID.PRESENT });
  await relay().put(lfsKey(STORAGE_KEY, OID.ADOPT), CONTENT.ADOPT, { size: SIZE, expectedSha256Hex: OID.ADOPT });
  await relay().put(lfsKey(STORAGE_KEY, OID.DOWNLOAD), CONTENT.DOWNLOAD, { size: SIZE, expectedSha256Hex: OID.DOWNLOAD });
});

const deps = (store: LfsStore = relay()): Parameters<typeof shapeBatchObject>[3] => ({
  state: state(),
  store,
  limits: LIMITS,
  now: NOW,
});

describe("batch request parsing (whole-request failures)", () => {
  it("400 on malformed JSON", () => {
    expect(() => parseBatchRequest("{not json", LIMITS)).toThrow(new BatchRequestError(400, "Bad Request"));
  });

  it("400 on unknown/missing operation", () => {
    expect(() => parseBatchRequest({ operation: "delete", objects: [] }, LIMITS)).toThrow(BatchRequestError);
    expect(() => parseBatchRequest({}, LIMITS)).toThrow(BatchRequestError);
  });

  it("413 over the batch cap (0 = unlimited, upstream parity)", () => {
    const objects = [{ oid: OID.UPLOAD, size: 1 }, { oid: OID.UPLOAD, size: 1 }, { oid: OID.UPLOAD, size: 1 }, { oid: OID.UPLOAD, size: 1 }];
    expect(() => parseBatchRequest({ operation: "upload", objects }, LIMITS)).toThrow(
      new BatchRequestError(413, "Request Entity Too Large"),
    );
    expect(() => parseBatchRequest({ operation: "upload", objects }, { maxBatchSize: 0 })).not.toThrow();
  });

  it("400 on non-string oid / non-integral size / non-array objects", () => {
    expect(() => parseBatchRequest({ operation: "upload", objects: [{ oid: 5, size: 1 }] }, LIMITS)).toThrow(
      BatchRequestError,
    );
    expect(() => parseBatchRequest({ operation: "upload", objects: [{ oid: OID.UPLOAD, size: 1.5 }] }, LIMITS)).toThrow(
      BatchRequestError,
    );
    expect(() => parseBatchRequest({ operation: "upload", objects: "nope" }, LIMITS)).toThrow(BatchRequestError);
  });

  it("missing objects yields zero results; transfers/ref accepted and ignored", () => {
    const request = parseBatchRequest(
      { operation: "upload", transfers: ["basic"], ref: { name: "refs/heads/main" } },
      LIMITS,
    );
    expect(request).toMatchObject({ operation: "upload", objects: [] });
  });
});

describe("accept media type gate (upstream CheckAcceptMediaType)", () => {
  it("matches the first ;-segment exactly", () => {
    expect(acceptsLfsMediaType(`${LFS_MEDIA_TYPE}`)).toBe(true);
    expect(acceptsLfsMediaType(`${LFS_MEDIA_TYPE};charset=utf-8`)).toBe(true);
    expect(acceptsLfsMediaType("application/json")).toBe(false);
    expect(acceptsLfsMediaType("application/vnd.git-lfs+json ")).toBe(false); // no trimming, upstream-faithful
    expect(acceptsLfsMediaType(null)).toBe(false);
  });
});

describe("upload op per-object table", () => {
  it("invalid pointer → 422 'Oid or size are invalid', no actions", async () => {
    expect(await shapeBatchObject({ oid: OID_BAD, size: 1 }, "upload", ctx, deps())).toEqual({
      oid: OID_BAD,
      size: 1,
      error: { code: 422, message: "Oid or size are invalid" },
    });
    const negative = await shapeBatchObject({ oid: OID.UPLOAD, size: -1 }, "upload", ctx, deps());
    expect(negative.error).toEqual({ code: 422, message: "Oid or size are invalid" });
  });

  it("row exists with another size → 422 'Object <oid> is not <size> bytes'", async () => {
    await state().ensureUploading(REPO_ID, OID_MISMATCH, 999, NOW);
    const result = await shapeBatchObject({ oid: OID_MISMATCH, size: SIZE }, "upload", ctx, deps());
    expect(result.error).toEqual({ code: 422, message: `Object ${OID_MISMATCH} is not ${SIZE} bytes` });
  });

  it("oversize and not stored → 422 'Size must be less than or equal to <max>'", async () => {
    const result = await shapeBatchObject({ oid: OID_BIG, size: 1025 }, "upload", ctx, deps());
    expect(result.error).toEqual({ code: 422, message: "Size must be less than or equal to 1024" });
    // Already-stored objects skip the size guard (upstream `exists` semantics).
    const stored = await shapeBatchObject({ oid: OID.PRESENT, size: SIZE }, "upload", ctx, deps());
    expect(stored.actions).toEqual({});
  });

  it("verified row (or adopt) ⇒ actions {} — the client skips the transfer", async () => {
    await state().insertVerified(REPO_ID, OID.PRESENT, SIZE, NOW);
    expect(await shapeBatchObject({ oid: OID.PRESENT, size: SIZE }, "upload", ctx, deps())).toEqual({
      oid: OID.PRESENT,
      size: SIZE,
      actions: {},
    });

    // Object in R2, row missing → adopt inserts a verified row, still no actions.
    const adopted = await shapeBatchObject({ oid: OID.ADOPT, size: SIZE }, "upload", ctx, deps());
    expect(adopted.actions).toEqual({});
    expect(await state().get(REPO_ID, OID.ADOPT)).toMatchObject({ state: "verified" });
  });

  it("absent object → upload + verify hrefs (relay shapes), row becomes uploading", async () => {
    const result = await shapeBatchObject({ oid: OID.UPLOAD, size: SIZE }, "upload", ctx, deps());
    expect(result.error).toBeUndefined();
    expect(result.actions?.upload).toEqual({
      href: relayUploadHref(RELAY_BASE, OID.UPLOAD, SIZE),
      header: { "Transfer-Encoding": "chunked", Authorization: AUTH },
    });
    expect(result.actions?.verify).toEqual({
      href: relayVerifyHref(RELAY_BASE),
      header: { Accept: LFS_ACCEPT_HEADER, Authorization: AUTH },
    });
    expect(await state().get(REPO_ID, OID.UPLOAD)).toMatchObject({ state: "uploading", size: SIZE });
  });

  it("quota exceeded → 422 'LFS quota exceeded for repository'", async () => {
    // Tight quota under maxFileSize so the quota guard (not the size guard) fires.
    const quotaDeps = deps();
    quotaDeps.limits = { ...LIMITS, repoQuota: 100 };
    await state().insertVerified(REPO_ID, OID.PRESENT, SIZE, NOW); // 64 bytes used
    const result = await shapeBatchObject({ oid: OID_QUOTA, size: 37 }, "upload", ctx, quotaDeps);
    expect(result.error).toEqual({ code: 422, message: "LFS quota exceeded for repository" });
    // Exactly at quota is allowed.
    const fits = await shapeBatchObject({ oid: OID_QUOTA, size: 36 }, "upload", ctx, quotaDeps);
    expect(fits.error).toBeUndefined();
  });

  it("mixed batch: invalid objects never block valid ones (§4.8)", async () => {
    const results = await shapeBatchResponse(
      parseBatchRequest(
        { operation: "upload", objects: [{ oid: OID_BAD, size: 1 }, { oid: OID.UPLOAD, size: SIZE }] },
        LIMITS,
      ),
      ctx,
      deps(),
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.error?.code).toBe(422);
    expect(results[1]?.actions?.upload).toBeDefined();
  });
});

describe("download op per-object table", () => {
  it("invalid pointer → 422; size mismatch vs row → 422", async () => {
    expect((await shapeBatchObject({ oid: "zz", size: 1 }, "download", ctx, deps())).error).toEqual({
      code: 422,
      message: "Oid or size are invalid",
    });
    await state().insertVerified(REPO_ID, OID.DOWNLOAD, 999, NOW);
    const result = await shapeBatchObject({ oid: OID.DOWNLOAD, size: SIZE }, "download", ctx, deps());
    expect(result.error).toEqual({ code: 422, message: `Object ${OID.DOWNLOAD} is not ${SIZE} bytes` });
  });

  it("no row or object missing → 404 'Not Found' (batch-spec code semantics)", async () => {
    expect(await shapeBatchObject({ oid: OID.UPLOAD, size: SIZE }, "download", ctx, deps())).toEqual({
      oid: OID.UPLOAD,
      size: SIZE,
      error: { code: 404, message: "Not Found" },
    });
    // Verified row but object vanished → 404 (not adoptable).
    await state().insertVerified(REPO_ID, OID.UPLOAD, SIZE, NOW);
    expect((await shapeBatchObject({ oid: OID.UPLOAD, size: SIZE }, "download", ctx, deps())).error?.code).toBe(404);
  });

  it("present + verified → download href with Authorization echo (relay mode)", async () => {
    await state().insertVerified(REPO_ID, OID.DOWNLOAD, SIZE, NOW);
    const result = await shapeBatchObject({ oid: OID.DOWNLOAD, size: SIZE }, "download", ctx, deps());
    expect(result.actions?.download).toEqual({
      href: relayDownloadHref(RELAY_BASE, OID.DOWNLOAD),
      header: { Authorization: AUTH },
    });
  });

  it("present without a row adopts, then issues the download href (§3.3)", async () => {
    const result = await shapeBatchObject({ oid: OID.ADOPT, size: SIZE }, "download", ctx, deps());
    expect(result.error).toBeUndefined();
    expect(result.actions?.download?.href).toBe(relayDownloadHref(RELAY_BASE, OID.ADOPT));
    expect(await state().get(REPO_ID, OID.ADOPT)).toMatchObject({ state: "verified" });
  });
});

describe("presign mode hrefs (same shaping code, capability-probe dispatch)", () => {
  it("upload href is a presigned PUT with the checksum header; verify stays on the Worker", async () => {
    const result = await shapeBatchObject({ oid: OID.UPLOAD, size: SIZE }, "upload", ctx, deps(presign()));
    const upload = result.actions?.upload;
    expect(upload?.href).toContain("r2.cloudflarestorage.com/cf-gitea-packs/lfs/r_21/");
    expect(upload?.href).toContain(OID.UPLOAD);
    expect(upload?.header).toEqual({ "x-amz-checksum-sha256": checksumHeaderFor(OID.UPLOAD) });
    expect(upload?.expires_in).toBe(900);
    expect(upload?.expires_at).toBe("2026-10-24T12:15:00Z");
    expect(result.actions?.verify?.href).toBe(relayVerifyHref(RELAY_BASE));
  });

  it("download href is a bare presigned GET without any header", async () => {
    await state().insertVerified(REPO_ID, OID.DOWNLOAD, SIZE, NOW);
    const result = await shapeBatchObject({ oid: OID.DOWNLOAD, size: SIZE }, "download", ctx, deps(presign()));
    const download = result.actions?.download;
    expect(download?.href).toContain("r2.cloudflarestorage.com");
    expect(download?.href).toContain("X-Amz-Signature=");
    expect(download?.header).toBeUndefined();
  });
});

describe("relay href base shape", () => {
  it("appends exactly one .git and percent-encodes owner/repo", () => {
    expect(buildRelayHrefBase({ origin: "https://x/", owner: "a b", repo: "c" })).toBe(
      "https://x/a%20b/c.git/info/lfs",
    );
    expect(buildRelayHrefBase({ origin: "https://x", owner: "o", repo: "r" })).toBe("https://x/o/r.git/info/lfs");
  });
});

describe("default limits", () => {
  it("carry the SPEC defaults", () => {
    expect(DEFAULT_LFS_LIMITS.maxFileSize).toBe(512 * 1024 * 1024);
    expect(DEFAULT_LFS_LIMITS.maxBatchSize).toBe(100);
    expect(DEFAULT_LFS_LIMITS.repoQuota).toBe(10 * 1024 * 1024 * 1024);
  });
});
