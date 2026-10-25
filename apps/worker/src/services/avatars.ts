import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../db/schema";

/**
 * Custom avatars over the shared REPO_PACKS bucket (the remaining-API
 * inventory's `wave-api-avatars` batch — docs/compat/api-remaining-inventory.md
 * Batch 4, six table-free ops). Upstream ports:
 *
 *   - handlers  routers/api/v1/user/avatar.go, org/avatar.go, repo/avatar.go
 *               (base64 body → service call → 204);
 *   - services  services/user/avatar.go + services/repository/avatar.go
 *               UploadAvatar / DeleteAvatar;
 *   - processor modules/avatar/avatar.go ProcessAvatarImage (the
 *               image.DecodeConfig whitelist + the width/height/origin caps).
 *
 * R2 layout (the brief's `avatars/` key prefix, keyed by owner/repo id — the
 * storage-service boundary rule, AGENTS.md):
 *
 *   avatars/u_<users.id>       — user AND org avatars (orgs ARE user rows,
 *                                SPEC-0007; upstream's org arm delegates to
 *                                user_service.UploadAvatar(org.AsUser()),
 *                                org/avatar.go:46 — one users-row id space);
 *   avatars/<repositories.storage_key> — repo avatars (the immutable `r_<id>`
 *                                key, schema.ts; upstream uses a separate
 *                                storage.RepoAvatars + content-hash names).
 *
 * Documented divergences (all upstream keeps columns we do not):
 *   - Upstream names each stored file by HashAvatar(id, data) and keeps it in
 *     `users.avatar` / `repositories.avatar`; cf-gitea has no avatar-hash
 *     column, so the key is DETERMINISTIC per principal id and a re-upload
 *     overwrites (upstream leaves stale hash files behind). "Custom avatar
 *     set" = the R2 key's existence (the brief's divergence note) plus
 *     users.use_custom_avatar for the user/org arms.
 *   - ProcessAvatarImage stores inputs under MaxOriginSize (262 144 B, the
 *     AVATAR_MAX_ORIGIN_SIZE default, modules/setting/picture.go:52) VERBATIM
 *     and RESIZES larger inputs to a ≤512 px PNG. There is no image pipeline
 *     on Workers, so nothing is ever resized: under-cap inputs behave
 *     byte-identically to upstream (stored as-is), at-or-over-cap inputs are
 *     REJECTED (400) where upstream would resize-and-accept.
 *   - The width/height caps and the type whitelist are the settings defaults
 *     (AVATAR_MAX_WIDTH/HEIGHT 4096, picture.go:49–50); cf-gitea has no
 *     settings model to override them yet. Their failure arm (and the
 *     unknown-format arm) is upstream's APIErrorInternal (user/avatar.go:39–43)
 *     — thrown here as untyped errors, which giteaErrorHandler renders as the
 *     landed prod convention `500 {"message":"internal server error"}` with
 *     the cause logged (errors.ts header — upstream blanks the message too).
 *
 * Memory discipline: the base64 body is bounded twice — the routes reject a
 * declared Content-Length over MAX_AVATAR_WIRE_BYTES (512 KiB — the JSON
 * envelope of the largest acceptable image is ~350 KiB) BEFORE any body is
 * read, and MAX_AVATAR_ORIGIN_BYTES bounds the decoded bytes for
 * undeclared-length bodies. The Go base64 decoder is ported STRICTLY
 * (StdEncoding: padding required, whitespace rejected) so the 400 arm's
 * `illegal base64 data at input byte N` matches upstream's
 * base64.CorruptInputError text (user/avatar.go:33–37).
 */

/** AVATAR_MAX_WIDTH default (modules/setting/picture.go:49). */
export const MAX_AVATAR_WIDTH = 4096;
/** AVATAR_MAX_HEIGHT default (modules/setting/picture.go:50). */
export const MAX_AVATAR_HEIGHT = 4096;
/** AVATAR_MAX_ORIGIN_SIZE default (modules/setting/picture.go:52). */
export const MAX_AVATAR_ORIGIN_BYTES = 262144;
/**
 * Wire-level request cap (a cf-gitea bound, not an upstream one): the largest
 * image this module accepts decodes from ≤ 349 540 base64 chars, so any
 * declared body beyond 512 KiB cannot contain one — rejected before the JSON
 * envelope is read (413; undeclared runtime-only response class).
 */
export const MAX_AVATAR_WIRE_BYTES = 512 * 1024;

/** Thrown on Go-parity base64 failure → the route family's 400 arm. */
export class AvatarBase64Error extends Error {
  constructor(readonly inputByte: number) {
    super(`illegal base64 data at input byte ${inputByte}`);
    this.name = "AvatarBase64Error";
  }
}

/** Thrown at-or-over MAX_AVATAR_ORIGIN_BYTES — the documented no-resize 400. */
export class AvatarOriginTooLargeError extends Error {
  constructor() {
    super(`image origin size exceeds the ${MAX_AVATAR_ORIGIN_BYTES} byte cap (upstream resizes; cf-gitea has no image pipeline)`);
    this.name = "AvatarOriginTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Strict StdEncoding base64 (Go encoding/base64 parity)
// ---------------------------------------------------------------------------

const STD_ALPHABET = /^[A-Za-z0-9+]$/;

function stdAlphabetByte(ch: string): boolean {
  return ch === "/" || STD_ALPHABET.test(ch);
}

/**
 * Strict StdEncoding decode: standard alphabet only, correct `=` padding on
 * the final quantum, no whitespace — every deviation throws
 * AvatarBase64Error with the offending input index (the CorruptInputError
 * text's N; exotic truncations report the padding boundary, matching Go's
 * quantum walk closely enough for the wire message's shape).
 */
export function decodeStrictBase64(raw: string): Uint8Array {
  const length = raw.length;
  let index = 0;
  for (; index + 4 <= length; index += 4) {
    let pads = 0;
    for (let offset = 0; offset < 4; offset++) {
      const at = index + offset;
      const ch = raw[at]!;
      if (stdAlphabetByte(ch)) {
        if (pads > 0) throw new AvatarBase64Error(at); // data after padding
      } else if (ch === "=") {
        // Padding only closes the FINAL quantum: the first '=' (offset 2)
        // must sit at length-2 (its partner follows), the second at
        // length-1. Anything earlier is a mid-string pad.
        const requiredIndex = offset === 2 ? length - 2 : length - 1;
        if (offset < 2 || at !== requiredIndex) throw new AvatarBase64Error(at);
        pads++;
      } else {
        throw new AvatarBase64Error(at);
      }
    }
    if (pads === 3) throw new AvatarBase64Error(index + 3); // "x===" is invalid
  }
  const rest = length - index;
  if (rest === 1) throw new AvatarBase64Error(index); // dangling char (needs "==")
  if (rest > 0) throw new AvatarBase64Error(length); // unpadded final quantum
  const binary = atob(raw); // provably strict-clean after the walk above
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// image.DecodeConfig for the four accepted formats (png/jpeg/gif/webp)
// ---------------------------------------------------------------------------

export interface AvatarImageConfig {
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readU32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function readU16BE(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function readU16LE(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function pngConfig(bytes: Uint8Array): AvatarImageConfig | null {
  // 8-byte signature + IHDR chunk header (len/type) + width/height.
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  return { contentType: "image/png", width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

function gifConfig(bytes: Uint8Array): AvatarImageConfig | null {
  if (bytes.length < 10) return null;
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return { contentType: "image/gif", width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
}

function jpegConfig(bytes: Uint8Array): AvatarImageConfig | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  // Walk the marker segments until an SOFn carries the dimensions (Go's
  // scan reads exactly this far, fill bytes included); bounded by the input
  // length — a truncated stream reads as unknown format.
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte before the marker — resync (Go's decoder tolerates it)
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2; // standalone markers
      continue;
    }
    const segmentLength = readU16BE(bytes, at + 2);
    if (segmentLength < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (at + 2 + segmentLength > bytes.length || segmentLength < 7) return null;
      // SOF payload: precision(1) height(2) width(2).
      const base = at + 4;
      return { contentType: "image/jpeg", width: readU16BE(bytes, base + 3), height: readU16BE(bytes, base + 1) };
    }
    at += 2 + segmentLength;
  }
  return null;
}

function webpConfig(bytes: Uint8Array): AvatarImageConfig | null {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return null;
  if (String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8 ") {
    // Lossy: frame tag(3) + start code 9D 01 2A, then 14-bit dims (LE).
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      contentType: "image/webp",
      width: readU16LE(bytes, 26) & 0x3fff,
      height: readU16LE(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    // Lossless: signature 0x2F then packed 14-bit width-1 / height-1.
    if (bytes[20] !== 0x2f) return null;
    const bits = readU16LE(bytes, 21) | (bytes[23]! << 16);
    return {
      contentType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    // Extended: flags(4) then 24-bit LE canvas-minus-one dims.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { contentType: "image/webp", width, height };
  }
  return null;
}

/**
 * `image.DecodeConfig` over the four formats upstream's ProcessAvatarImage
 * accepts (modules/avatar/avatar.go:53 — "only accept known types
 * explicitly"; gif/jpeg/png are stdlib, webp is golang.org/x/image). Null
 * covers both "unknown format" and truncated/corrupt headers — the same
 * failure class upstream's DecodeConfig errors produce.
 */
export function decodeImageConfig(bytes: Uint8Array): AvatarImageConfig | null {
  if (bytes.length >= 12) {
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    if (riff) return webpConfig(bytes);
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return pngConfig(bytes);
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return gifConfig(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegConfig(bytes);
  return null;
}

/**
 * The ProcessAvatarImage port MINUS the resize pass (module header): sniff
 * the format, enforce the 4096×4096 caps, enforce the origin-size cap.
 * Returns the input VERBATIM (under the caps every accepted input is stored
 * as-is upstream too, avatar.go:69–71) plus the sniffed content type for the
 * R2 object's metadata. Dimension/unknown-format overflow is upstream's
 * APIErrorInternal arm — thrown untyped so the landed 500 convention
 * renders it; the origin-size cap is cf-gitea's own 400 (no resize pass).
 */
export function processAvatarImage(data: Uint8Array): { data: Uint8Array; contentType: AvatarImageConfig["contentType"] } {
  if (data.length >= MAX_AVATAR_ORIGIN_BYTES) {
    throw new AvatarOriginTooLargeError();
  }
  const config = decodeImageConfig(data);
  if (config === null) {
    // Upstream: image.DecodeConfig error, wrapped by UploadAvatar
    // (services/user/avatar.go:24) and answered via APIErrorInternal.
    throw new Error("UploadAvatar: failed to process avatar image: image: unknown format");
  }
  if (config.width > MAX_AVATAR_WIDTH) {
    throw new Error(`UploadAvatar: failed to process avatar image: image width is too large: ${config.width} > ${MAX_AVATAR_WIDTH}`);
  }
  if (config.height > MAX_AVATAR_HEIGHT) {
    throw new Error(`UploadAvatar: failed to process avatar image: image height is too large: ${config.height} > ${MAX_AVATAR_HEIGHT}`);
  }
  return { data, contentType: config.contentType };
}

// ---------------------------------------------------------------------------
// Storage — the R2 half keyed by principal id, the D1 half for user/org rows
// ---------------------------------------------------------------------------

/** Which store row the avatar attaches to (the three upstream scopes). */
export type AvatarTarget =
  | { kind: "user" | "org"; principalId: number }
  | { kind: "repo"; storageKey: string };

const AVATAR_ID_RE = /^\d+$/;
/** The repositories.storage_key shape (`r_<id>`, schema.ts). */
const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The R2 object key (module header layout). User and org avatars share the
 * `u_` namespace (orgs ARE users rows — one id space); repo avatars key on
 * the repo's immutable storage key. Every segment is format-gated so the
 * `avatars/` prefix can never be escaped.
 */
export function avatarKey(target: AvatarTarget): string {
  if (target.kind === "repo") {
    if (!STORAGE_KEY_RE.test(target.storageKey)) {
      throw new Error(`invalid repo storage key: ${target.storageKey}`);
    }
    return `avatars/${target.storageKey}`;
  }
  if (!AVATAR_ID_RE.test(String(target.principalId))) {
    throw new Error(`invalid avatar principal id: ${target.principalId}`);
  }
  return `avatars/u_${target.principalId}`;
}

export interface UploadAvatarInput {
  bucket: R2Bucket;
  d1: D1Database;
  target: AvatarTarget;
  /** The already-validated image bytes (processAvatarImage's output). */
  data: Uint8Array;
  contentType: string;
}

/**
 * The UploadAvatar port (services/user/avatar.go:21–43,
 * services/repository/avatar.go:21–56): store the bytes, then flip the
 * custom-avatar marker. Order note — upstream writes the D1 columns inside a
 * tx and saves the file inside it (file failure rolls the row back); the
 * Worker has no cross-store tx, so the object lands FIRST and a failed
 * marker write deletes it again (release-assets' "confirmed bytes need their
 * row" discipline, mirrored): the settled state can be "object present,
 * marker true" or "nothing" — never a dangling object, never a marker
 * without bytes. The repo scope has no marker column — key existence IS the
 * marker (the brief's documented divergence).
 */
export async function uploadAvatar(input: UploadAvatarInput): Promise<void> {
  const key = avatarKey(input.target);
  await input.bucket.put(key, input.data, { httpMetadata: { contentType: input.contentType } });
  if (input.target.kind === "repo") {
    return;
  }
  try {
    await drizzle(input.d1)
      .update(users)
      .set({ useCustomAvatar: true })
      .where(eq(users.id, input.target.principalId));
  } catch (error) {
    await input.bucket.delete(key);
    throw error;
  }
}

/**
 * The DeleteAvatar port (services/user/avatar.go:46–69,
 * services/repository/avatar.go:59–78): clear the marker, then delete the
 * bytes. Upstream skips the file delete when no avatar column value is
 * stored and tolerates a missing file; the R2 delete of an absent key is a
 * success no-op, so the unconditional form matches both tolerances. The
 * marker clears even when the object was already gone (upstream warns and
 * still answers 204 — user/avatar.go upstream DeleteAvatar has no 404 arm).
 */
export async function deleteAvatar(bucket: R2Bucket, d1: D1Database, target: AvatarTarget): Promise<void> {
  if (target.kind !== "repo") {
    await drizzle(d1)
      .update(users)
      .set({ useCustomAvatar: false })
      .where(eq(users.id, target.principalId));
  }
  await bucket.delete(avatarKey(target));
}

/**
 * Whether the custom avatar object exists — the repo scope's "avatar set"
 * predicate (module header divergence note) and the future GET arm's
 * existence check.
 */
export async function avatarExists(bucket: R2Bucket, target: AvatarTarget): Promise<boolean> {
  return (await bucket.head(avatarKey(target))) !== null;
}
