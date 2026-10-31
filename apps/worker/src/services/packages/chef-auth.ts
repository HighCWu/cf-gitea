/**
 * The Chef X-Ops signed-header authentication (SPEC-0016 — the six-minor
 * wave's recorded reduction, now ported). Upstream routers/api/packages/
 * chef/auth.go at the pin, verified byte-for-byte against upstream's own
 * integration test (tests/integration/api_packages_chef_test.go's
 * signRequest) and mixlib-authentication's signedheaderauth (the file's
 * doc comment cites rfc065 + signedheaderauth.rb):
 *
 * - The method is APPLICABLE only when `X-Ops-Userid` is present
 *   (auth.go:93-100 — the empty header answers (nil, nil), the auth
 *   group's not-applicable pair). A present header names the USER:
 *   GetUserByName (auth.go:99), the `users.username_lower` lookup here.
 * - The verification key is the per-USER `chef.public_pem` user setting
 *   (auth.go:102-111 → modules/packages/chef/metadata.go:21's
 *   `SettingPublicPem = "chef.public_pem"`) — read BEFORE the timestamp
 *   arm (auth.go:67 precedes :72), PEM-decoded and parsed as a PKIX
 *   public key, rejected unless RSA (auth.go:81-84).
 * - The timestamp window: `X-Ops-Timestamp` is RFC3339 (auth.go:113-134)
 *   and |now − ts| > 10 min (auth.go:34's `maxTimeDifference`) fails.
 * - `X-Ops-Sign` carries `version=(\d+\.\d+)`; {1.0, 1.1, 1.2, 1.3} are
 *   accepted (auth.go:147-151); an `algorithm=(\w+)` parameter must be
 *   `sha1` — or `sha256` WITH version 1.3 only (auth.go:155-158).
 * - The signature arrives base64'd across the `X-Ops-Authorization-N`
 *   headers, chunk-joined in index order with NO gaps (auth.go:181-205 —
 *   `k > len(tmp)` is the gap error).
 * - The canonical check data (auth.go:207-239): for 1.3
 *   `Method/Path/X-Ops-Content-Hash/X-Ops-Sign:version/X-Ops-Timestamp/
 *   X-Ops-UserId/X-Ops-Server-API-Version` over `path.Clean(URL.Path)`
 *   with the RAW username; for 1.0-1.2 the `Hashed Path` shape
 *   (sha1+base64 of the cleaned path) with the sha1+base64 USERNAME for
 *   1.1/1.2 (raw for 1.0).
 * - The signature versions (auth.go:241-280): 1.3 = RSASSA-PKCS1-v1_5
 *   over SHA-256, 1.2 = RSASSA-PKCS1-v1_5 over SHA-1 (WebCrypto's
 *   RSASSA-PKCS1-v1_5 verify hashes the message itself, the exact
 *   `rsa.VerifyPKCS1v15` composition), 1.0/1.1 = the RAW RSA
 *   private_encrypt composition — signature^e mod n, the PKCS#1 v1.5
 *   type-1 padding stripped by scanning for the 0xFF 0x00 boundary from
 *   index 2 (auth.go:264-273), the remainder byte-compared with the
 *   check data (auth.go:275) — ported over BigInt (WebCrypto has no raw
 *   RSA primitive; the public operation is e=65537-cheap).
 *
 * Every failure — lookup, key, timestamp, version, signature — is the
 * SAME auth-group error path: services/auth/group.go:44-63 remembers the
 * first method error and verifyAuth answers
 * `ctx.HTTPError(401, "Failed to authenticate user")` (api.go:82-85),
 * Go http.Error's plain-text shape. The method never blocks the standard
 * credential pass: upstream runs chef.Auth LAST in
 * `{OAuth2, Basic, nuget.Auth, Auth, chef.Auth}` (api.go:96-102), so
 * Basic/token credentials WIN (the integration test uploads with
 * AddBasicAuth, api_packages_chef_test.go:296) and X-Ops only fires when
 * they yield no user.
 *
 * The key-pair store arm: upstream exposes the SET through the user
 * settings page — POST /user/settings/packages/chef/regenerate_keypair
 * (web.go:718 → routers/web/user/setting/packages.go:103-119) generates
 * a pair (util.GenerateKeyPair, KeyBits=4096 — metadata.go:20), stores
 * ONLY the public PEM under the user setting and streams the private PEM
 * back as the `application/x-pem-file` download `{user}.priv`. This
 * module carries the same set/get pair on the landed `user_settings_kv`
 * store (the distro-common signing-key precedent) plus the generate
 * helper; the web POST handler is mounted by the web arm.
 */

import { base64ToBytes, bytesToBase64 } from "./distro-common";
import { userSettingsKv, users } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { rowToUser } from "../../auth/token-service";
import type { AuthUser } from "../../auth/auth-context";

/** modules/packages/chef/metadata.go:21. */
export const CHEF_PUBLIC_PEM_SETTING = "chef.public_pem";

/** metadata.go:20 — KeyBits = 4096. */
export const CHEF_KEY_BITS = 4096;

/** routers/api/packages/chef/auth.go:34 — 10 * time.Minute. */
const MAX_TIME_DIFFERENCE_MS = 10 * 60 * 1000;

/**
 * The method's error type — every arm folds into the auth group's 401
 * "Failed to authenticate user" plain-text body (auth.go's error returns
 * through group.go:52-63 → api.go:82-85). The message is diagnostic only;
 * it never reaches the wire.
 */
export class ChefAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChefAuthError";
  }
}

// ---------------------------------------------------------------------------
// The chef.public_pem store arm — user_settings_kv (upstream `user_setting`,
// models/user/setting.go) — the distro-common owner-keypair precedent.
// ---------------------------------------------------------------------------

/** GetSetting(ctx, u.ID, SettingPublicPem) (auth.go:103) — null on the miss. */
export async function getChefPublicPem(d1: D1Database, userId: number): Promise<string | null> {
  const row = await drizzle(d1)
    .select({ settingValue: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, userId), eq(userSettingsKv.settingKey, CHEF_PUBLIC_PEM_SETTING)))
    .get();
  return row?.settingValue ?? null;
}

/** SetUserSetting(ctx, ctx.Doer.ID, SettingPublicPem, pub) (setting packages.go:110). */
export async function setChefPublicPem(d1: D1Database, userId: number, publicPem: string): Promise<void> {
  await drizzle(d1)
    .insert(userSettingsKv)
    .values({ userId, settingKey: CHEF_PUBLIC_PEM_SETTING, settingValue: publicPem })
    .onConflictDoUpdate({
      target: [userSettingsKv.userId, userSettingsKv.settingKey],
      set: { settingValue: publicPem },
    })
    .run();
}

function pemEncode(label: string, der: Uint8Array): string {
  const base64 = bytesToBase64(der);
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * GenerateChefKeyPair's port (user/setting/packages.go:104 →
 * util.GenerateKeyPair(KeyBits)): the pair's PRIVATE arm renders as
 * PKCS#1 `RSA PRIVATE KEY` PEM (util/keypair.go:26-31 — byte-faithful;
 * the PKCS#8 WebCrypto export is unwrapped to the inner RSAPrivateKey
 * DER) and the PUBLIC arm as the SPKI `PUBLIC KEY` PEM
 * (util/keypair.go:33-42 — the exact stored format). The WebCrypto JWK
 * rides along for tests (d/n are not expressible without it).
 */
export async function generateChefKeyPair(
  modulusLength: number = CHEF_KEY_BITS,
): Promise<{ privatePem: string; publicPem: string; privateJwk: JsonWebKey; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("RSA keygen did not return a pair");
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(pkcs8 instanceof ArrayBuffer)) throw new Error("unexpected RSA export form");
  const pkcs8Bytes = new Uint8Array(pkcs8);
  const rsapDer = unwrapPkcs8ToRsapPrivateKey(pkcs8Bytes);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (!(spki instanceof ArrayBuffer)) throw new Error("unexpected RSA export form");
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (privateJwk instanceof ArrayBuffer) throw new Error("unexpected RSA export form");
  return {
    privatePem: pemEncode("RSA PRIVATE KEY", rsapDer),
    publicPem: pemEncode("PUBLIC KEY", new Uint8Array(spki)),
    privateJwk,
    publicKey: pair.publicKey,
  };
}

/** The inverse wrap: PKCS#8 SEQUENCE(version, algid, OCTET STRING) → the
 *  RSAPrivateKey DER inside the OCTET STRING (a fixed 3-element walk). */
function unwrapPkcs8ToRsapPrivateKey(pkcs8: Uint8Array): Uint8Array {
  const readLength = (bytes: Uint8Array, offset: number): { length: number; headerSize: number } => {
    const first = bytes[offset];
    if (first === undefined) throw new Error("truncated DER");
    if (first < 0x80) return { length: first, headerSize: 1 };
    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + 1 + count > bytes.byteLength) throw new Error("malformed DER length");
    let length = 0;
    for (let i = 0; i < count; i++) {
      const byte = bytes[offset + 1 + i];
      if (byte === undefined) throw new Error("truncated DER");
      length = (length << 8) | byte;
    }
    return { length, headerSize: 1 + count };
  };
  const skipTlv = (bytes: Uint8Array, offset: number): { tag: number; content: Uint8Array; next: number } => {
    const tag = bytes[offset];
    if (tag === undefined) throw new Error("truncated DER");
    const { length, headerSize } = readLength(bytes, offset + 1);
    const start = offset + 1 + headerSize;
    if (start + length > bytes.byteLength) throw new Error("truncated DER content");
    return { tag, content: bytes.subarray(start, start + length), next: start + length };
  };
  const outer = skipTlv(pkcs8, 0);
  if (outer.tag !== 0x30) throw new Error("PKCS#8 is not a SEQUENCE");
  let cursor = 0;
  let octetString: Uint8Array | null = null;
  while (cursor < outer.content.byteLength) {
    const tlv = skipTlv(outer.content, cursor);
    if (tlv.tag === 0x04) octetString = tlv.content;
    cursor = tlv.next;
  }
  if (octetString === null) throw new Error("PKCS#8 carries no OCTET STRING");
  return octetString.slice();
}

// ---------------------------------------------------------------------------
// The verification primitives (auth.go, in upstream's exact order)
// ---------------------------------------------------------------------------

export interface ChefXOpsHeaders {
  /** The request headers — lowercased names (the Workers Headers shape). */
  get(name: string): string | null;
  keys(): IterableIterator<string> | string[];
}

export interface ChefVerifyKey {
  /** The modulus n / exponent e (the raw-RSA arms). */
  modulus: bigint;
  exponent: bigint;
  /** The SPKI DER (re-import per hash for the 1.2/1.3 arms). */
  spki: Uint8Array;
}

/**
 * getUserPublicKey's parse (auth.go:102-111): PEM decode (any label — Go's
 * pem.Decode ignores the label, :108), SPKI import (ParsePKIXPublicKey),
 * the RSA-only gate (auth.go:81-84's "public key is not a RSA key"). The
 * n/e extraction rides the JWK export for the 1.0/1.1 raw-RSA arms.
 */
export async function parseChefPublicKey(publicPem: string): Promise<ChefVerifyKey> {
  const der = pemBlockDecode(publicPem);
  let verifyKey: CryptoKey;
  try {
    verifyKey = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
  } catch {
    throw new ChefAuthError("public key is not a RSA key");
  }
  let jwk: JsonWebKey;
  try {
    const exported = await crypto.subtle.exportKey("jwk", verifyKey);
    if (exported instanceof ArrayBuffer) throw new Error("unexpected JWK export form");
    jwk = exported;
  } catch {
    throw new ChefAuthError("public key is not a RSA key");
  }
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new ChefAuthError("public key is not a RSA key");
  }
  return {
    modulus: base64UrlToBigInt(jwk.n),
    exponent: base64UrlToBigInt(jwk.e),
    spki: der,
  };
}

/** auth.go:108's pem.Decode — the FIRST PEM block, label ignored. */
function pemBlockDecode(pem: string): Uint8Array {
  const match = /-----BEGIN [^-]+-----([A-Za-z0-9+/=\s]*)-----END [^-]+-----/.exec(pem);
  const body = match?.[1];
  if (body === undefined) throw new ChefAuthError("no PEM block found");
  const compact = body.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new ChefAuthError("invalid PEM base64");
  }
  return base64ToBytes(compact);
}

function base64UrlToBigInt(value: string): bigint {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = base64ToBytes(padded);
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

/** big.Int.Bytes() — minimal big-endian, empty for zero. */
function bigIntToBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** modExp — signature^e mod n; the public exponent is small (65537), so the
 *  square-and-multiply walk is cheap on the 2048/4096-bit modulus. */
function modExp(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let acc = base % modulus;
  let exp = exponent;
  while (exp > 0n) {
    if (exp & 1n) result = (result * acc) % modulus;
    acc = (acc * acc) % modulus;
    exp >>= 1n;
  }
  return result;
}

/** auth.go:113-134 — the RFC3339 parse and the ±10 min window. */
export function verifyChefTimestamp(headerValue: string | null, now: Date): void {
  if (headerValue === null || headerValue === "") {
    throw new ChefAuthError("X-Ops-Timestamp header missing");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(headerValue)) {
    throw new ChefAuthError(`invalid X-Ops-Timestamp: ${headerValue}`);
  }
  const ts = Date.parse(headerValue);
  if (Number.isNaN(ts)) throw new ChefAuthError(`invalid X-Ops-Timestamp: ${headerValue}`);
  const diff = Math.abs(now.getTime() - ts);
  if (diff > MAX_TIME_DIFFERENCE_MS) throw new ChefAuthError("time difference");
}

const CHEF_SIGN_VERSIONS = ["1.0", "1.1", "1.2", "1.3"] as const;
export type ChefSignVersion = (typeof CHEF_SIGN_VERSIONS)[number];

/** auth.go:136-161 — the X-Ops-Sign version/algorithm gate. */
export function getChefSignVersion(headerValue: string | null): ChefSignVersion {
  if (headerValue === null || headerValue === "") {
    throw new ChefAuthError("X-Ops-Sign header missing");
  }
  const versionMatch = /version=(\d+\.\d+)/.exec(headerValue);
  const version = versionMatch?.[1];
  if (version === undefined) throw new ChefAuthError("invalid X-Ops-Sign header");
  if (!(CHEF_SIGN_VERSIONS as readonly string[]).includes(version)) {
    throw new ChefAuthError("unsupported version");
  }
  const algorithmMatch = /algorithm=(\w+)/.exec(headerValue);
  if (algorithmMatch !== null && algorithmMatch[1] !== "sha1" && !(algorithmMatch[1] === "sha256" && version === "1.3")) {
    throw new ChefAuthError("unsupported algorithm");
  }
  return version as ChefSignVersion;
}

/** Go base64.StdEncoding.DecodeString — strict: padded quanta only. */
function strictBase64Decode(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new ChefAuthError("invalid X-Ops-Authorization headers");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ChefAuthError("invalid X-Ops-Authorization headers");
  // base64ToBytes rides the forgiving atob; the validation above already
  // pinned the strict alphabet + padding (the pad is droppable for it).
  const body = value.endsWith("==") ? value.slice(0, -2) : value.endsWith("=") ? value.slice(0, -1) : value;
  return base64ToBytes(body);
}

/**
 * getAuthorizationData (auth.go:181-205): the `X-Ops-Authorization-N`
 * headers joined in index order — a gap (k > count) is the error, and a
 * zero index cannot address the slice (upstream's map would panic; the
 * port folds it into the same invalid-headers error).
 */
export function getChefAuthorizationSignature(headers: ChefXOpsHeaders): Uint8Array {
  const valueList = new Map<number, string>();
  for (const name of headers.keys()) {
    // The wire lowercases (Workers Headers); upstream's authorizationPattern
    // matches the canonical name — equivalent set.
    const match = /^x-ops-authorization-(\d+)$/.exec(name);
    if (match !== null) valueList.set(Number(match[1]), headers.get(name) ?? "");
  }
  const chunks: string[] = Array.from({ length: valueList.size }, () => "");
  for (const [index, value] of valueList) {
    if (index === 0 || index > chunks.length) throw new ChefAuthError("invalid X-Ops-Authorization headers");
    chunks[index - 1] = value;
  }
  return strictBase64Decode(chunks.join(""));
}

/** Go path.Clean (src/path/path.go Clean) — the lexical walk, byte-exact
 *  (the rooted slash appends UPFRONT, so "/" and "//" stay "/"; the ".."
 *  arm pops THROUGH the separator slash, Go's backing-array cursor). */
export function pathClean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const n = path.length;
  let out = rooted ? "/" : "";
  let r = rooted ? 1 : 0;
  let dotdot = rooted ? 1 : 0;
  while (r < n) {
    if (path[r] === "/") {
      r++;
    } else if (path[r] === "." && (r + 1 === n || path[r + 1] === "/")) {
      r++;
    } else if (path[r] === "." && path[r + 1] === "." && (r + 2 === n || path[r + 2] === "/")) {
      r += 2;
      if (out.length > dotdot) {
        out = out.slice(0, -1);
        while (out.length > dotdot) {
          const dropped = out.charAt(out.length - 1);
          out = out.slice(0, -1);
          if (dropped === "/") break;
        }
      } else if (!rooted) {
        if (out.length > 0) out += "/";
        out += "..";
        dotdot = out.length;
      }
    } else {
      if ((rooted && out.length !== 1) || (!rooted && out.length !== 0)) out += "/";
      while (r < n && path[r] !== "/") {
        out += path[r];
        r++;
      }
    }
  }
  if (out.length === 0) return "."; // out.w == 0 (the relative "."/"./" inputs)
  return out;
}

/** auth.go:207-239 — the canonical check data for the signature version. */
export async function buildChefCheckData(
  version: ChefSignVersion,
  method: string,
  cleanPath: string,
  headers: ChefXOpsHeaders,
): Promise<Uint8Array> {
  let username = headers.get("x-ops-userid") ?? "";
  if (version !== "1.0" && version !== "1.3") {
    username = bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(username))));
  }
  let data: string;
  if (version === "1.3") {
    data = [
      `Method:${method}`,
      `Path:${cleanPath}`,
      `X-Ops-Content-Hash:${headers.get("x-ops-content-hash") ?? ""}`,
      `X-Ops-Sign:version=${version}`,
      `X-Ops-Timestamp:${headers.get("x-ops-timestamp") ?? ""}`,
      `X-Ops-UserId:${username}`,
      `X-Ops-Server-API-Version:${headers.get("x-ops-server-api-version") ?? ""}`,
    ].join("\n");
  } else {
    const hashedPath = bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(cleanPath))));
    data = [
      `Method:${method}`,
      `Hashed Path:${hashedPath}`,
      `X-Ops-Content-Hash:${headers.get("x-ops-content-hash") ?? ""}`,
      `X-Ops-Timestamp:${headers.get("x-ops-timestamp") ?? ""}`,
      `X-Ops-UserId:${username}`,
    ].join("\n");
  }
  return new TextEncoder().encode(data);
}

/** auth.go:241-280 — the version dispatch. */
async function verifyChefSignature(
  version: ChefSignVersion,
  signature: Uint8Array,
  data: Uint8Array,
  key: ChefVerifyKey,
): Promise<void> {
  if (version === "1.3" || version === "1.2") {
    const hash = version === "1.3" ? "SHA-256" : "SHA-1";
    let verifyKey: CryptoKey;
    try {
      verifyKey = await crypto.subtle.importKey(
        "spki",
        key.spki,
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"],
      );
    } catch {
      throw new ChefAuthError("public key is not a RSA key");
    }
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", verifyKey, signature, data);
    if (!valid) throw new ChefAuthError("could not verify signature");
    return;
  }
  // 1.0/1.1 — verifyDataOld (auth.go:255-280): the raw RSA operation, the
  // PKCS#1 v1.5 type-1 padding stripped by the 0xFF 0x00 scan from index 2,
  // the remainder compared with the check data.
  const decrypted = bigIntToBytes(modExp(bytesToBigInt(signature), key.exponent, key.modulus));
  let skip = 0;
  for (let i = 2; i < decrypted.byteLength; i++) {
    if (i + 1 >= decrypted.byteLength) break;
    if (decrypted[i] === 0xff && decrypted[i + 1] === 0x00) {
      skip = i + 2;
      break;
    }
  }
  const tail = decrypted.subarray(skip);
  if (tail.byteLength !== data.byteLength) throw new ChefAuthError("could not verify signature");
  for (let i = 0; i < tail.byteLength; i++) {
    if (tail[i] !== data[i]) throw new ChefAuthError("could not verify signature");
  }
}

export interface ChefXOpsVerifyInput {
  headers: ChefXOpsHeaders;
  method: string;
  /** The DECODED request path (Go's req.URL.Path) — cleaned internally. */
  urlPath: string;
  now: Date;
}

/**
 * Auth.Verify's crypto half (auth.go:72-90) — timestamp → version →
 * authorization data → check data → signature. The key PARSE ran earlier
 * (upstream reads the setting + parses before the timestamp, auth.go:67
 * preceding :72); the caller passes the parsed key.
 */
export async function verifyChefXOpsRequest(input: ChefXOpsVerifyInput, key: ChefVerifyKey): Promise<void> {
  verifyChefTimestamp(input.headers.get("x-ops-timestamp"), input.now);
  const version = getChefSignVersion(input.headers.get("x-ops-sign"));
  const signature = getChefAuthorizationSignature(input.headers);
  const checkData = await buildChefCheckData(version, input.method, pathClean(input.urlPath), input.headers);
  await verifyChefSignature(version, signature, checkData, key);
}

export interface ChefXOpsAuthResult {
  /** The verified doer (the group's user). null + null = NOT APPLICABLE
   *  (no X-Ops-Userid header — auth.go:63-65's nilnil). */
  user: AuthUser | null;
  /** The first method error (group.go:52-57's retErr) — folds into the
   *  route's 401 "Failed to authenticate user" plain-text body. */
  error: ChefAuthError | null;
}

/**
 * Auth.Verify's full walk (auth.go:58-91): the X-Ops-Userid applicability
 * probe, the GetUserByName lookup, the `chef.public_pem` read + PKIX/RSA
 * parse (BEFORE the timestamp — auth.go:67 precedes :72), then the crypto
 * half. Uses the standard credentials' row→user converter so the returned
 * doer is the same shape the token seam produces.
 */
export async function authenticateChefXOps(d1: D1Database, request: Request, now: Date = new Date()): Promise<ChefXOpsAuthResult> {
  const username = request.headers.get("x-ops-userid");
  if (username === null || username === "") {
    return { user: null, error: null }; // not applicable (auth.go:63-65)
  }
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.usernameLower, username.toLowerCase()))
    .limit(1)
    .get();
  if (row === undefined) {
    return { user: null, error: new ChefAuthError("user not found") }; // GetUserByName's error
  }
  const user = rowToUser(row);
  const publicPem = await getChefPublicPem(d1, row.id);
  if (publicPem === null) {
    return { user: null, error: new ChefAuthError("the user has no chef public key") }; // GetSetting's ErrNotExist
  }
  let key: ChefVerifyKey;
  try {
    key = await parseChefPublicKey(publicPem);
  } catch (error) {
    return { user: null, error: error instanceof ChefAuthError ? error : new ChefAuthError("public key parse failed") };
  }
  const url = new URL(request.url);
  let urlPath = url.pathname;
  try {
    urlPath = decodeURIComponent(urlPath); // Go's req.URL.Path is the decoded form
  } catch {
    // malformed escapes keep the encoded form (Go's RawPath fallback)
  }
  try {
    await verifyChefXOpsRequest(
      { headers: request.headers, method: request.method, urlPath, now },
      key,
    );
  } catch (error) {
    return { user: null, error: error instanceof ChefAuthError ? error : new ChefAuthError("verification failed") };
  }
  return { user, error: null };
}
