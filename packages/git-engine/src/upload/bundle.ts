import { bundleR2Key, isValidStorageKey } from "../git/r2keys";
import { FLUSH, pkt } from "../git/pktline";
import { concat, isOid, td, te } from "../git/util";
import {
  ResumableR2PackStream,
  WORKER_PASSTHROUGH_SEGMENT_BYTES,
  type ResumableR2PackStreamOptions,
} from "./stream";

export const DEFAULT_BUNDLE_MIN_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BUNDLE_TOKEN_TTL_SEC = 900;

export interface BundleTokenPayload {
  /** Engine repo name (`owner/repo` or `repo`) bound to request path. */
  r: string;
  /** Immutable storage key (`r_<id>` or repo name) for R2 lookup. */
  s: string;
  /** Bundle ID (`<refsVersion>-<packKey>`). */
  b: string;
  /** Expiration epoch seconds. */
  e: number;
}

/** Strict-ish non-negative integer parser for `BUNDLE_MIN_BYTES` (default 64 MiB). */
export function parseBundleMinBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_BUNDLE_MIN_BYTES;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_BUNDLE_MIN_BYTES;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_BUNDLE_MIN_BYTES;
}

/** Token TTL parser in seconds (default 900s, clamped `[60, 3600]`). */
export function parseBundleTokenTtlSec(raw: string | undefined): number {
  if (!raw) return DEFAULT_BUNDLE_TOKEN_TTL_SEC;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_BUNDLE_TOKEN_TTL_SEC;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_BUNDLE_TOKEN_TTL_SEC;
  return Math.min(3600, Math.max(60, parsed));
}

/**
 * Format a Git bundle v2 header (`# v2 git bundle\n`, `<oid> <ref>\n` lines, blank `\n`).
 * Emits `HEAD` first when present, followed by remaining refs sorted lexicographically by name.
 */
export function formatGitBundleV2Header(refs: ReadonlyArray<{ name: string; oid: string }>): Uint8Array {
  let headEntry: { name: string; oid: string } | null = null;
  const others: Array<{ name: string; oid: string }> = [];
  const seen = new Set<string>();

  for (const r of refs) {
    if (!r || typeof r.name !== "string" || !r.name || r.name.includes("\n") || !isOid(r.oid)) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    if (r.name === "HEAD") {
      headEntry = { name: "HEAD", oid: r.oid };
    } else {
      others.push({ name: r.name, oid: r.oid });
    }
  }

  others.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const ordered = headEntry ? [headEntry, ...others] : others;
  if (ordered.length === 0) {
    throw new Error("cannot format git bundle v2 header with no valid refs");
  }

  const lines = ["# v2 git bundle\n"];
  for (const r of ordered) {
    lines.push(`${r.oid} ${r.name}\n`);
  }
  lines.push("\n");
  return te.encode(lines.join(""));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(b64u: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64u)) return null;
  const padLen = (4 - (b64u.length % 4)) % 4;
  const b64 = b64u.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padLen);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

/** Mint an HMAC-SHA256 signed download token (`<payloadB64>.<sigB64>`). */
export async function signBundleToken(payload: BundleTokenPayload, secret: string): Promise<string> {
  if (!secret) throw new Error("BUNDLE_SIGNING_SECRET is required to sign bundle tokens");
  const payloadB64 = bytesToBase64Url(te.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(payloadB64)));
  return `${payloadB64}.${bytesToBase64Url(sig)}`;
}

function isSafeStorageKeyPath(value: string): boolean {
  if (!value || value.includes("..")) return false;
  const segments = value.split("/");
  return segments.length >= 1 && segments.length <= 2 && segments.every((seg) => isValidStorageKey(seg));
}

/** Verify an HMAC-SHA256 signed download token and validate payload bounds and expiration. */
export async function verifyBundleToken(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<BundleTokenPayload | null> {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const sigBytes = base64UrlToBytes(sigB64);
  if (!sigBytes) return null;

  const key = await importHmacKey(secret, "verify");
  const verified = await crypto.subtle.verify("HMAC", key, sigBytes, te.encode(payloadB64));
  if (!verified) return null;

  const rawPayload = base64UrlToBytes(payloadB64);
  if (!rawPayload) return null;

  let parsed: Partial<BundleTokenPayload>;
  try {
    parsed = JSON.parse(td.decode(rawPayload)) as Partial<BundleTokenPayload>;
  } catch {
    return null;
  }

  if (
    typeof parsed.r !== "string" ||
    !parsed.r ||
    parsed.r.includes("..") ||
    typeof parsed.s !== "string" ||
    !isSafeStorageKeyPath(parsed.s) ||
    typeof parsed.b !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.b) ||
    parsed.b.includes("..") ||
    typeof parsed.e !== "number" ||
    !Number.isFinite(parsed.e) ||
    parsed.e <= nowSec
  ) {
    return null;
  }

  return {
    r: parsed.r,
    s: parsed.s,
    b: parsed.b,
    e: parsed.e,
  };
}

/** Render Git Protocol v2 `command=bundle-uri` response carrying a single signed base bundle. */
export function renderBundleUriResponse(bundleUrl: string, creationTokenSec: number): Uint8Array {
  return concat([
    pkt("bundle.version=1\n"),
    pkt("bundle.mode=all\n"),
    pkt(`bundle.base.uri=${bundleUrl}\n`),
    pkt(`bundle.base.creationToken=${creationTokenSec}\n`),
    FLUSH,
  ]);
}

/** Empty `command=bundle-uri` reply when no active bundle is advertised. */
export function emptyBundleUriResponse(): Uint8Array {
  return FLUSH;
}

/** Parse a single HTTP `Range: bytes=...` header against `totalSize`. */
export function parseHttpByteRange(
  header: string,
  totalSize: number
): { kind: "ok"; start: number; end: number } | { kind: "invalid" } {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return { kind: "invalid" };
  const trimmed = header.trim();
  const unitMatch = /^bytes=(.+)$/i.exec(trimmed);
  if (!unitMatch) return { kind: "invalid" };
  const spec = unitMatch[1]!.trim();
  if (!spec || spec.includes(",")) return { kind: "invalid" };

  const dash = spec.indexOf("-");
  if (dash < 0) return { kind: "invalid" };
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();

  if (!startStr && !endStr) return { kind: "invalid" };

  // Suffix range: bytes=-N
  if (!startStr) {
    if (!/^\d+$/.test(endStr)) return { kind: "invalid" };
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "invalid" };
    const start = Math.max(0, totalSize - suffix);
    return { kind: "ok", start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(startStr)) return { kind: "invalid" };
  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return { kind: "invalid" };

  if (!endStr) {
    return { kind: "ok", start, end: totalSize - 1 };
  }

  if (!/^\d+$/.test(endStr)) return { kind: "invalid" };
  const rawEnd = Number(endStr);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) return { kind: "invalid" };
  const end = Math.min(rawEnd, totalSize - 1);
  return { kind: "ok", start, end };
}

function streamSegmentedBundleBody(
  bucket: R2Bucket,
  key: string,
  startOffset: number,
  length: number,
  signal: AbortSignal | undefined,
  streamOpts?: ResumableR2PackStreamOptions
): ReadableStream<Uint8Array> {
  const readerStream = new ResumableR2PackStream(bucket, key, length, () => Promise.resolve(), {
    ...streamOpts,
    startOffset,
  });
  return new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      try {
        if (signal?.aborted) {
          throw new Error("client aborted bundle download stream");
        }
        const value = await readerStream.nextChunk();
        if (signal?.aborted) {
          throw new Error("client aborted bundle download stream");
        }
        if (value === null) {
          if (readerStream.bytesRead() !== length) {
            throw new Error(`truncated bundle download ${key} (${readerStream.bytesRead()}/${length} bytes)`);
          }
          await readerStream.close();
          ctrl.close();
          return;
        }
        ctrl.enqueue(value);
      } catch (err) {
        console.error("[bundle-download] stream error:", err instanceof Error ? err.message : String(err));
        await readerStream.close();
        ctrl.error(err);
      }
    },
    cancel: async () => {
      await readerStream.close();
    },
  });
}

/** Serve `GET` or `HEAD` for a verified bundle download directly from R2 with `Range` / `206` support. */
export async function serveBundleDownload(
  req: Request,
  bucket: R2Bucket,
  storageKey: string,
  bundleId: string,
  streamOpts?: ResumableR2PackStreamOptions
): Promise<Response> {
  const key = bundleR2Key(storageKey, bundleId);
  const segmentBytes = Math.max(1, Math.trunc(streamOpts?.segmentBytes ?? WORKER_PASSTHROUGH_SEGMENT_BYTES));
  const baseHeaders: Record<string, string> = {
    "content-type": "application/x-git-bundle",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=900",
    "x-content-type-options": "nosniff",
  };

  if (req.method === "HEAD") {
    const head = await bucket.head(key);
    if (!head) return new Response("not found\n", { status: 404 });
    const headers = new Headers(baseHeaders);
    headers.set("content-length", String(head.size));
    if (head.httpEtag) headers.set("etag", head.httpEtag);
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = req.headers.get("range");
  if (rangeHeader !== null) {
    const head = await bucket.head(key);
    if (!head) return new Response("not found\n", { status: 404 });
    const parsed = parseHttpByteRange(rangeHeader, head.size);
    if (parsed.kind === "invalid") {
      return new Response("range not satisfiable\n", {
        status: 416,
        headers: {
          "content-range": `bytes */${head.size}`,
          "x-content-type-options": "nosniff",
        },
      });
    }
    const len = parsed.end - parsed.start + 1;
    const headers = new Headers(baseHeaders);
    headers.set("content-range", `bytes ${parsed.start}-${parsed.end}/${head.size}`);
    headers.set("content-length", String(len));
    if (len <= segmentBytes) {
      const obj = await bucket.get(key, { range: { offset: parsed.start, length: len } });
      if (!obj) return new Response("not found\n", { status: 404 });
      if (obj.httpEtag) headers.set("etag", obj.httpEtag);
      return new Response(obj.body, { status: 206, headers });
    }
    if (head.httpEtag) headers.set("etag", head.httpEtag);
    return new Response(streamSegmentedBundleBody(bucket, key, parsed.start, len, req.signal, streamOpts), {
      status: 206,
      headers,
    });
  }

  const head = await bucket.head(key);
  if (!head) return new Response("not found\n", { status: 404 });
  const headers = new Headers(baseHeaders);
  headers.set("content-length", String(head.size));
  if (head.size <= segmentBytes) {
    const obj = await bucket.get(key);
    if (!obj) return new Response("not found\n", { status: 404 });
    if (obj.httpEtag) headers.set("etag", obj.httpEtag);
    return new Response(obj.body, { status: 200, headers });
  }
  if (head.httpEtag) headers.set("etag", head.httpEtag);
  return new Response(streamSegmentedBundleBody(bucket, key, 0, head.size, req.signal, streamOpts), {
    status: 200,
    headers,
  });
}
