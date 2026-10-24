/**
 * Presign unit vectors (SPEC-0006 §2.3, §5): deterministic SigV4 query
 * signing with fixed credentials + fixed clock — no network. The expected
 * signature is derived independently of aws4fetch (hand-assembled canonical
 * request → HMAC key chain per the SigV4 spec) and pinned as a golden
 * literal, so both the derivation and aws4fetch must agree with it.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  checksumHeaderFor,
  createLfsStore,
  DEFAULT_LFS_URL_TTL_SECONDS,
  hasPresignCredentials,
  LfsKeyError,
  MAX_LFS_URL_TTL_SECONDS,
  PresignLfsStore,
  RelayLfsStore,
  type LfsHref,
} from "./store";
import { InvalidPointerError } from "./pointer";

/** Narrow after an assertion — keeps the tests cast-free. */
function mustBe(link: LfsHref | null): LfsHref {
  if (link === null) throw new Error("expected a presigned link, got null");
  return link;
}

const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDAG/bJEPyPg5m9mQY2glgvmW",
  accountId: "abc123def456",
};
const BUCKET = "cf-gitea-packs";
const NOW = new Date("2026-10-24T00:00:00Z");
const DATETIME = "20261024T000000Z";
const DATE = "20261024";
const TTL = 900;
const HOST = `${CREDENTIALS.accountId}.r2.cloudflarestorage.com`;
const OID = "ab".repeat(32);
const KEY = `lfs/r_7/${OID}`;
const PATH = `/${BUCKET}/${KEY}`;
/** base64 of the oid's raw 32 bytes (0xab × 32) — derived with node -e. */
const CHECKSUM_B64 = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=";
/** Golden SigV4 signature of the PUT canonical request below. */
const GOLDEN_PUT_SIGNATURE = "4051454d8bb157063e29cd9406043033913329e73e5b321c26ecf3fa1b8c4b42";

const store = (): PresignLfsStore => new PresignLfsStore(env.REPO_PACKS, CREDENTIALS, { bucketName: BUCKET });

/**
 * Independent SigV4 query-signature derivation (no aws4fetch): the canonical
 * request pieces are supplied in final encoded form, exactly as the S3 spec
 * prescribes.
 */
async function deriveSignature(args: {
  method: "PUT" | "GET";
  path: string;
  canonicalQuery: string;
  canonicalHeaders: string;
  signedHeaders: string;
  payloadHash: string;
  credentialScope: string;
}): Promise<string> {
  const canonicalRequest = [
    args.method,
    args.path,
    args.canonicalQuery,
    args.canonicalHeaders,
    args.signedHeaders,
    args.payloadHash,
  ].join("\n");
  const encoder = new TextEncoder();
  const canonicalHash = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest));
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    DATETIME,
    args.credentialScope,
    [...new Uint8Array(canonicalHash)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  ].join("\n");
  const hmac = async (key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> =>
    crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(value));
  const kDate = await hmac(encoder.encode(`AWS4${CREDENTIALS.secretAccessKey}`), DATE);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  return [...new Uint8Array(await hmac(kSigning, stringToSign))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("checksum header", () => {
  it("is base64 of the oid's raw bytes", () => {
    expect(checksumHeaderFor(OID)).toBe(CHECKSUM_B64);
    const zeros = checksumHeaderFor("0".repeat(64));
    expect(zeros).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(atob(zeros)).toHaveLength(32);
  });

  it("rejects non-hex oids before any key/header is built", () => {
    expect(() => checksumHeaderFor("NOPE")).toThrow(InvalidPointerError);
  });
});

describe("presigned PUT (checksum bound into the signature)", () => {
  it("matches the independently derived golden vector", async () => {
    const link = mustBe(await store().presignPut({ key: KEY, checksumSha256Base64: CHECKSUM_B64, now: NOW }));

    expect(link.header).toEqual({ "x-amz-checksum-sha256": CHECKSUM_B64 });
    expect(link.expiresIn).toBe(TTL);
    expect(link.expiresAt).toBe("2026-10-24T00:15:00Z");

    const url = new URL(link.href);
    expect(url.origin).toBe(`https://${HOST}`);
    expect(url.pathname).toBe(PATH);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Date")).toBe(DATETIME);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(TTL));
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${CREDENTIALS.accessKeyId}/${DATE}/auto/s3/aws4_request`,
    );
    // Wire form keeps the SigV4 separators percent-encoded.
    expect(url.search).toContain(`X-Amz-Credential=${CREDENTIALS.accessKeyId}%2F${DATE}%2Fauto%2Fs3%2Faws4_request`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host;x-amz-checksum-sha256");

    const signature = url.searchParams.get("X-Amz-Signature") ?? "";
    const derived = await deriveSignature({
      method: "PUT",
      path: PATH,
      // Sorted byte-order query, RFC3986-encoded (canonical form).
      canonicalQuery: [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        `X-Amz-Credential=${CREDENTIALS.accessKeyId}%2F${DATE}%2Fauto%2Fs3%2Faws4_request`,
        `X-Amz-Date=${DATETIME}`,
        `X-Amz-Expires=${TTL}`,
        "X-Amz-SignedHeaders=host%3Bx-amz-checksum-sha256",
      ].join("&"),
      canonicalHeaders: `host:${HOST}\nx-amz-checksum-sha256:${CHECKSUM_B64}\n`,
      signedHeaders: "host;x-amz-checksum-sha256",
      payloadHash: "UNSIGNED-PAYLOAD",
      credentialScope: `${DATE}/auto/s3/aws4_request`,
    });
    expect(derived).toBe(GOLDEN_PUT_SIGNATURE);
    expect(signature).toBe(GOLDEN_PUT_SIGNATURE);
  });

  it("signs a per-key, per-oid credential (mutating the key changes the signature)", async () => {
    const a = new URL((await store().presignPut({ key: KEY, checksumSha256Base64: CHECKSUM_B64, now: NOW }))?.href ?? "");
    const otherOid = "cd".repeat(32);
    const b = new URL(
      (
        await store().presignPut({
          key: `lfs/r_7/${otherOid}`,
          checksumSha256Base64: checksumHeaderFor(otherOid),
          now: NOW,
        })
      )?.href ?? "",
    );
    expect(a.pathname).not.toBe(b.pathname);
    expect(a.searchParams.get("X-Amz-Signature")).not.toBe(b.searchParams.get("X-Amz-Signature"));
  });
});

describe("presigned GET (bearer URL, response overrides signed in)", () => {
  it("signs host-only headers and the response-content overrides", async () => {
    const link = mustBe(
      await store().presignGet({
        key: KEY,
        responseContentDisposition: `attachment; filename="big.bin"`,
        now: NOW,
      }),
    );
    expect(link.header).toBeUndefined();

    const url = new URL(link.href);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(TTL));
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="big.bin"`);
    expect(url.searchParams.get("response-content-type")).toBeNull();

    // Canonical query re-encoded per SigV4 (decode → %20-style encode, byte-order
    // sort): X-Amz-* first (uppercase sorts before lowercase), overrides after.
    const disposition = encodeURIComponent(`attachment; filename="big.bin"`).replace(/[!'()*]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const canonicalQuery = [
      "X-Amz-Algorithm=AWS4-HMAC-SHA256",
      `X-Amz-Credential=${CREDENTIALS.accessKeyId}%2F${DATE}%2Fauto%2Fs3%2Faws4_request`,
      `X-Amz-Date=${DATETIME}`,
      `X-Amz-Expires=${TTL}`,
      "X-Amz-SignedHeaders=host",
      `response-content-disposition=${disposition}`,
    ].join("&");
    const derived = await deriveSignature({
      method: "GET",
      path: PATH,
      canonicalQuery,
      canonicalHeaders: `host:${HOST}\n`,
      signedHeaders: "host",
      payloadHash: "UNSIGNED-PAYLOAD",
      credentialScope: `${DATE}/auto/s3/aws4_request`,
    });
    expect(url.searchParams.get("X-Amz-Signature")).toBe(derived);
  });
});

describe("ttl handling", () => {
  it("defaults to 900 s and validates the range", async () => {
    const defaulted = new URL((await store().presignGet({ key: KEY, now: NOW }))?.href ?? "");
    expect(defaulted.searchParams.get("X-Amz-Expires")).toBe(String(DEFAULT_LFS_URL_TTL_SECONDS));
    await expect(store().presignGet({ key: KEY, ttlSeconds: 0, now: NOW })).rejects.toThrow(RangeError);
    await expect(store().presignGet({ key: KEY, ttlSeconds: MAX_LFS_URL_TTL_SECONDS + 1, now: NOW })).rejects.toThrow(
      RangeError,
    );
    const custom = new URL((await store().presignGet({ key: KEY, ttlSeconds: 60, now: NOW }))?.href ?? "");
    expect(custom.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("store factory / capability probe", () => {
  it("relay store never presigns (null ⇒ callers use relay handlers)", async () => {
    const relay = new RelayLfsStore(env.REPO_PACKS);
    expect(relay.mode).toBe("relay");
    expect(await relay.presignPut({ key: KEY, checksumSha256Base64: CHECKSUM_B64 })).toBeNull();
    expect(await relay.presignGet({ key: KEY })).toBeNull();
  });

  it("auto mode presigns only with complete credentials", () => {
    expect(hasPresignCredentials({ credentials: CREDENTIALS })).toBe(true);
    expect(hasPresignCredentials({ credentials: { ...CREDENTIALS, accountId: "" } })).toBe(false);
    expect(hasPresignCredentials({})).toBe(false);

    const full = { bucket: env.REPO_PACKS, config: { mode: "auto" as const, credentials: CREDENTIALS, bucketName: BUCKET } };
    expect(createLfsStore(full.bucket, full.config).mode).toBe("presign");
    const missing = { bucket: env.REPO_PACKS, config: { mode: "auto" as const, bucketName: BUCKET } };
    expect(createLfsStore(missing.bucket, missing.config).mode).toBe("relay");
  });

  it("explicit presign without credentials is a loud misconfiguration", () => {
    expect(() => createLfsStore(env.REPO_PACKS, { mode: "presign" })).toThrow(LfsKeyError);
    expect(() => createLfsStore(env.REPO_PACKS, { mode: "relay" })).not.toThrow();
  });
});
