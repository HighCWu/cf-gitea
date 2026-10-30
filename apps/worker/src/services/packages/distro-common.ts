/**
 * Shared substrate for the SPEC-0016 M7 index-builder families (debian.ts,
 * alpine.ts) — the byte-level and crypto primitives upstream reaches its Go
 * stdlib for (archive/tar, compress/gzip, the blakesmith/ar reader, the
 * ProtonMail go-crypto OpenPGP signer) re-implemented on the Workers
 * platform's own primitives:
 *
 *  - gzip COMPRESSION through CompressionStream("gzip"), decompression through
 *    DecompressionStream("gzip"). workerd's decoder is STRICTLY single-member
 *    (a second member or any trailing byte errors "Trailing bytes after end of
 *    compressed data" — probe-verified on the pinned workerd), so concatenated
 *    members (an .apk's signature||control||data stream layout) are walked by
 *    decoding prefix windows and locating each member's end with its CRC32 +
 *    ISIZE trailer (RFC 1952 §2.3.1) plus the next member's magic — no third-
 *    party inflate dependency (the nuget hand-built zip reader posture).
 *  - a minimal ustar WRITER (the APKINDEX.tar.gz / .SIGN.RSA entries) and
 *    READER (the .deb control.tar, the .apk .PKGINFO member) — helm.ts keeps a
 *    private reader; this is the self-owned twin so the two index families
 *    stay independent of helm.
 *  - per-owner repository signing keys in the generic `user_settings_kv`
 *    store (schema.ts — the landed upstream `user_setting` KV parity table;
 *    upstream keys land there via SetUserSetting, services/packages/keypair.go:
 *    18-43, under keys `debian.key.private/public` / `alpine.key.private/
 *    public` — the constants upstream's modules/packages/<family>/metadata.go carry).
 *    RSA-2048 RSASSA-PKCS1-v1_5 (upstream generates 4096 — util.GenerateKeyPair
 *    for alpine, packet.Config RSABits for debian; 2048 is the documented
 *    Workers-cost divergence the actions OIDC issuer already carries,
 *    services/actions/secrets.ts:269-280).
 *  - a minimal OpenPGP v4 signer for the debian family: RSA-SHA256 signature
 *    packets, the armor + CRC24 framing, the clearsign (InRelease) and armored
 *    detached (Release.gpg) forms, and the transferable public key (key +
 *    userid + self-certification) the repository.key arm serves — the subset
 *    gpgv/apt verify. The RSA operation itself rides WebCrypto
 *    RSASSA-PKCS1-v1_5 (OpenPGP RSA signatures ARE PKCS#1 v1.5 over the RFC
 *    4880 hash framing, so the WebCrypto output is the wire form).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageBlobs, packageFiles, packageProperties, packageVersions, packages, userSettingsKv } from "../../db/schema";

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + (Array.isArray(part) ? part.length : part.byteLength), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    if (Array.isArray(part)) {
      out.set(part, offset);
      offset += part.length;
    } else {
      out.set(part, offset);
      offset += part.byteLength;
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// CRC32 (RFC 1952) — the gzip trailer predicate for the member walk.
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i] ?? 0;
    const entry = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = entry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-24 (RFC 4880 §6.1) — the armor checksum line. */
export function crc24(bytes: Uint8Array): Uint8Array {
  const crc = new Uint8Array(3);
  let value = 0xb704ce;
  for (const byte of bytes) {
    value ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      value <<= 1;
      if (value & 0x1000000) value ^= 0x1864cfb;
    }
  }
  crc[0] = (value >> 16) & 0xff;
  crc[1] = (value >> 8) & 0xff;
  crc[2] = value & 0xff;
  return crc;
}

// ---------------------------------------------------------------------------
// gzip — CompressionStream("gzip") for one-shot compression, and the
// concatenated-member walk over the strict single-member decoder.
// ---------------------------------------------------------------------------

/** Drain a readable stream, keeping every chunk emitted BEFORE a possible
 *  stream error (the strict gzip decoder emits the full first member and
 *  THEN errors on trailing bytes — the payload survives the error). */
async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<{ chunks: Uint8Array[]; error: unknown }> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let error: unknown = undefined;
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (cause) {
      error = cause;
      break;
    }
    if (read.done) break;
    chunks.push(read.value);
  }
  return { chunks, error };
}

/** Decompress ONE pass of bytes; returns the payload plus the trailing-bytes
 *  flag (the decoder rejects input past the first member's end with the
 *  "Trailing bytes after end of compressed data" TypeError). CRITICAL workerd
 *  semantics (spike-verified): when the decoder errors, the chunks it already
 *  produced are NOT delivered — a trailing-error pass yields NO output. So a
 *  trailing pass answers `trailing` with an empty payload and the member walk
 *  re-probes with exact-length windows (see walkGzipMembers). */
async function gzipDecodePass(bytes: Uint8Array): Promise<{ payload: Uint8Array; error: "none" | "trailing" | "short" | "bad" }> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const decoded = streamBytes(ds.readable);
  void writer.write(bytes).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const { chunks, error } = await decoded;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (error === undefined) {
    if (payload.byteLength === 0) return { payload, error: "bad" };
    return { payload, error: "none" };
  }
  if (error instanceof TypeError && /trailing bytes/i.test(error.message)) return { payload, error: "trailing" };
  // workerd's truncation spelling: "Called close() on a decompression stream
  // with incomplete data" (probe-calibrated); the rest are spec spellings.
  if (/incomplete data|unexpected end|truncated/i.test(error instanceof Error ? error.message : "")) {
    return { payload, error: "short" };
  }
  return { payload, error: "bad" };
}

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(data).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const { chunks, error } = await streamBytes(cs.readable);
  if (error !== undefined) throw error instanceof Error ? error : new Error("compression stream failed");
  return concatBytes(...chunks);
}

/** One walked member: the raw bytes (the .apk checksum hashes THESE) and the
 *  decompressed payload. */
export interface GzipMember {
  raw: Uint8Array;
  payload: Uint8Array;
}

/** Grow-then-bisect an exact-length window for the member at `position`.
 *  workerd's decoder only emits output when the pass is CLEAN, and a window
 *  is clean exactly when it ends at the member boundary (short → "unexpected
 *  end", long → "trailing bytes", exact → clean + payload). A clean window
 *  therefore pins BOTH the payload and the member's raw end: end = position +
 *  windowLength. */
async function decodeMemberWindow(bytes: Uint8Array, position: number): Promise<{ payload: Uint8Array; length: number }> {
  const available = bytes.byteLength - position;
  const probe = async (window: number): Promise<{ payload: Uint8Array; error: "none" | "trailing" | "short" | "bad" }> =>
    gzipDecodePass(bytes.subarray(position, position + window));
  // GROW: geometric until "trailing" (boundary inside the window) or a clean
  // exact fit at the input end.
  let hi = Math.min(512, available);
  let pass = await probe(hi);
  while (pass.error === "short" && hi < available) {
    hi = Math.min(hi * 8, available);
    pass = await probe(hi);
  }
  if (pass.error === "none") {
    return { payload: pass.payload, length: hi };
  }
  if (pass.error !== "trailing") {
    throw new Error("invalid gzip member");
  }
  // BISECT: three-way discrimination pins the exact boundary. lo spans the
  // full range below the first known-long window (members can be far smaller
  // than the initial grow step — a 512-byte probe trailing on a ~60-byte
  // member is the NORMAL shape).
  let lo = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midPass = await probe(mid);
    if (midPass.error === "none") return { payload: midPass.payload, length: mid };
    if (midPass.error === "short") {
      lo = mid + 1;
    } else if (midPass.error === "trailing") {
      hi = mid - 1;
    } else {
      throw new Error("invalid gzip member");
    }
  }
  throw new Error("gzip member boundary not found");
}

/**
 * Walk the concatenated gzip members contained in `bytes` (the .apk layout:
 * signature stream || control stream || data stream, per the apk file format).
 * Each member's exact raw extent comes from the exact-length clean window
 * (see decodeMemberWindow), which is also what the upstream checksum needs:
 * FileMetadata.Checksum hashes the RAW member bytes (the tee'd reader in
 * modules/packages/alpine/metadata.go:79-108).
 */
export async function walkGzipMembers(bytes: Uint8Array): Promise<GzipMember[]> {
  const members: GzipMember[] = [];
  let position = 0;
  while (position + 10 <= bytes.byteLength && bytes[position] === 0x1f && bytes[position + 1] === 0x8b) {
    const { payload, length } = await decodeMemberWindow(bytes, position);
    members.push({ raw: bytes.subarray(position, position + length), payload });
    position += length;
  }
  return members;
}

// ---------------------------------------------------------------------------
// ustar — the writer (APKINDEX.tar.gz entries) and reader (.deb control.tar,
// .apk .PKGINFO). Upstream: Go archive/tar with plain Name/Mode/Size headers
// (the USTAR flavor); alpine's writeGzipStream (services/packages/alpine/
// repository.go:331-351) writes entries with Mode 0o600 and — for the
// signature entry — NO trailing end blocks (addTarEnd=false), so the
// signature stream and the index stream concatenate into one archive.
// ---------------------------------------------------------------------------

export interface TarEntry {
  name: string;
  mode: number;
  data: Uint8Array;
}

function writeOctal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** The ustar header (checksum included). `name` must fit 100 bytes. */
function tarHeader(name: string, mode: number, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const nameBytes = asciiBytes(name);
  if (nameBytes.byteLength > 100) throw new Error("tar member name too long");
  header.set(nameBytes, 0);
  header.set(asciiBytes(writeOctal(mode, 8)), 100);
  header.set(asciiBytes(writeOctal(0, 8)), 108); // uid
  header.set(asciiBytes(writeOctal(0, 8)), 116); // gid
  header.set(asciiBytes(writeOctal(size, 12)), 124);
  header.set(asciiBytes(writeOctal(0, 12)), 136); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder = spaces
  header[156] = 0x30; // typeflag '0'
  header.set(asciiBytes("ustar\0"), 257);
  header.set(asciiBytes("00"), 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(asciiBytes(checksum), 148);
  return header;
}

function tarEndBlocks(): Uint8Array {
  return new Uint8Array(1024); // two zero blocks
}

/** The tar archive; `addEnd` appends the two zero end blocks (upstream's
 *  writeGzipStream addTarEnd). */
export function buildTar(entries: TarEntry[], addEnd: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.name, entry.mode, entry.data.byteLength), entry.data);
    const padding = (512 - (entry.data.byteLength % 512)) % 512;
    if (padding > 0) parts.push(new Uint8Array(padding));
  }
  if (addEnd) parts.push(tarEndBlocks());
  return concatBytes(...parts);
}

/** Null-terminated latin1 field. */
function tarField(bytes: Uint8Array, start: number, length: number): string {
  let end = start;
  const stop = start + length;
  while (end < stop && bytes[end] !== 0) end++;
  return new TextDecoder("latin1").decode(bytes.subarray(start, end));
}

function tarSize(bytes: Uint8Array, start: number, length: number): number {
  const text = tarField(bytes, start, length).trim();
  if (text === "") return 0;
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("malformed tar size");
  return size;
}

/** The tar reader: the regular-file members of one archive (the upstream
 *  walkers only ever read regular files and skip the rest). */
export function readTarMembers(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    if ((bytes[offset] ?? 0) === 0) break; // the end block(s)
    const size = tarSize(bytes, offset + 124, 12);
    const typeflag = bytes[offset + 156] ?? -1;
    const name = tarField(bytes, offset, 100);
    const prefix = tarField(bytes, offset + 345, 155);
    const fullName = prefix !== "" ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    if (dataStart + size > bytes.byteLength) throw new Error("truncated tar member");
    if (typeflag === 0x30 || typeflag === 0) {
      entries.push({ name: fullName, mode: 0o600, data: bytes.slice(dataStart, dataStart + size) });
    }
    offset = dataStart + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ar — the .deb container (upstream reads blakesmith/ar; deb(5): the global
// "!<arch>\n" magic, 60-byte member headers, two-byte member alignment).
// ---------------------------------------------------------------------------

export interface ArMember {
  name: string;
  data: Uint8Array;
}

function readArMemberHeader(bytes: Uint8Array, offset: number): { name: string; size: number } {
  if (offset + 60 > bytes.byteLength) throw new Error("truncated ar header");
  const latin1 = new TextDecoder("latin1");
  const nameRaw = latin1.decode(bytes.subarray(offset, offset + 16));
  const name = nameRaw.slice(0, nameRaw.indexOf("\0")).replace(/\/\s*$/, "").trim();
  const sizeText = latin1.decode(bytes.subarray(offset + 48, offset + 58)).trim();
  const size = Number.parseInt(sizeText, 10);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("malformed ar size");
  return { name, size };
}

/** The ar members of an in-memory archive (the debian-binary + control members
 *  live in the small upload prefix; the walk never touches data.tar). */
export function readArMembers(bytes: Uint8Array): ArMember[] {
  const magic = "!<arch>\n";
  if (bytes.byteLength < 8 || new TextDecoder("latin1").decode(bytes.subarray(0, 8)) !== magic) {
    throw new Error("not an ar archive");
  }
  const members: ArMember[] = [];
  let offset = 8;
  while (offset + 60 <= bytes.byteLength) {
    const { name, size } = readArMemberHeader(bytes, offset);
    const dataStart = offset + 60;
    if (dataStart + size > bytes.byteLength) throw new Error("truncated ar member");
    members.push({ name, data: bytes.slice(dataStart, dataStart + size) });
    offset = dataStart + size + (size % 2); // two-byte alignment pad
  }
  return members;
}

// ---------------------------------------------------------------------------
// RSA owner keypairs — user_settings_kv (the upstream user_setting home),
// RSASSA-PKCS1-v1_5 2048 (the documented Workers-cost divergence).
// ---------------------------------------------------------------------------

function pemEncode(label: string, der: Uint8Array): string {
  const base64 = bytesToBase64(der);
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function pemDecode(pem: string, label: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(pem);
  const captured = match?.[1];
  if (captured === undefined) throw new Error(`PEM ${label} block not found`);
  return base64ToBytes(captured.replace(/\s+/g, ""));
}

export interface RsaKeyPairPems {
  privatePem: string;
  publicPem: string;
  /** The private CryptoKey (imported, sign-ready) — not persisted. */
  privateKey: CryptoKey;
  /** The public SPKI DER (the alpine fingerprint material; the OpenPGP MPIs). */
  publicSpki: Uint8Array;
  /** The public JWK (n/e for the OpenPGP key packet). */
  publicJwk: JsonWebKey;
}

/** Generate an RSA signing pair and render both PEM arms (PKCS#8 private /
 *  SPKI public — upstream stores OpenPGP/PKCS#1 PEMs; the wire arms only ever
 *  parse the PUBLIC half, whose SPKI form both families serve). */
export async function generateRsaPems(hash: "SHA-1" | "SHA-256"): Promise<RsaKeyPairPems> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("RSA keygen did not return a pair");
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // exportKey's union answer — narrow per arm (secrets.ts's instanceof throws).
  if (!(pkcs8 instanceof ArrayBuffer) || !(spki instanceof ArrayBuffer) || jwk instanceof ArrayBuffer) {
    throw new Error("unexpected RSA export form");
  }
  return {
    privatePem: pemEncode("PRIVATE KEY", new Uint8Array(pkcs8)),
    publicPem: pemEncode("PUBLIC KEY", new Uint8Array(spki)),
    privateKey: pair.privateKey,
    publicSpki: new Uint8Array(spki),
    publicJwk: jwk,
  };
}

/** Import a stored PKCS#8 PEM back to a sign-ready key (the algorithm
 *  literal inline — secrets.ts's posture). */
export function importRsaPrivateKey(privatePem: string, hash: "SHA-1" | "SHA-256"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemDecode(privatePem, "PRIVATE KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash },
    false,
    ["sign"],
  );
}

/** The SPKI DER of a stored public PEM (the alpine key-id material). */
export function rsaPublicSpki(publicPem: string): Uint8Array {
  return pemDecode(publicPem, "PUBLIC KEY");
}

/** The public key fingerprint: SHA-256 over the SPKI DER (upstream
 *  CreatePublicKeyFingerprint, util/keypair.go:48-56 — the alpine
 *  .SIGN.RSA-<owner>@<fingerprint>.rsa.pub filename material). */
export async function rsaKeyFingerprint(publicPem: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", rsaPublicSpki(publicPem))));
}

/** RSASSA-PKCS1-v1_5 over `data` (the message is hashed by WebCrypto — for
 *  alpine the digest IS the signed message per upstream's
 *  rsa.SignPKCS1v15(sha1-sum) equivalent; for OpenPGP the caller passes the
 *  full RFC 4880 hash framing). */
export async function rsaSign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data));
}

// ---------------------------------------------------------------------------
// The owner keypair store — user_settings_kv (upstream `user_setting`;
// services/packages/keypair.go:18-43's GetOrCreateKeyPair: read → generate on
// the miss → re-read inside the lock → store both arms). The D1 composite
// UNIQUE(user_id, setting_key) arbitrates the concurrent-generation race — a
// losing insert re-reads and answers the winner's pair, the loser's generated
// key silently discarded exactly like upstream's globallock dance.
// ---------------------------------------------------------------------------

async function readKvSetting(d1: D1Database, ownerId: number, key: string): Promise<string | null> {
  const row = await drizzle(d1)
    .select({ settingValue: userSettingsKv.settingValue })
    .from(userSettingsKv)
    .where(and(eq(userSettingsKv.userId, ownerId), eq(userSettingsKv.settingKey, key)))
    .get();
  return row?.settingValue ?? null;
}

async function writeKvSettings(d1: D1Database, ownerId: number, entries: { key: string; value: string }[]): Promise<void> {
  const db = drizzle(d1);
  await db
    .insert(userSettingsKv)
    .values(entries.map((entry) => ({ userId: ownerId, settingKey: entry.key, settingValue: entry.value })))
    .onConflictDoUpdate({
      target: [userSettingsKv.userId, userSettingsKv.settingKey],
      set: { settingValue: sql`excluded.setting_value` },
    })
    .run();
}

export interface OwnerRepositoryKeys {
  privatePem: string;
  publicPem: string;
  /** The sign-ready imported private key. */
  privateKey: CryptoKey;
  /** The alpine fingerprint (SHA-256 of the SPKI) / debian key material. */
  publicSpki: Uint8Array;
}

/**
 * `GetOrCreateKeyPair` (keypair.go:18-43) — the owner's long-lived repository
 * signing pair under the family's `*.key.private` / `*.key.public` setting
 * keys. Absent arms → generate → store (conflict-safe: re-read answers the
 * concurrent winner). The private arm stays in the store; every consumer
 * imports it per request (no module-level key state — the Workers rules).
 */
export async function getOrCreateOwnerKeyPair(
  d1: D1Database,
  ownerId: number,
  settingKeyPrivate: string,
  settingKeyPublic: string,
  hash: "SHA-1" | "SHA-256",
  settingKeyCreated?: string,
): Promise<OwnerRepositoryKeys & { creationTime?: number }> {
  let privatePem = await readKvSetting(d1, ownerId, settingKeyPrivate);
  let publicPem = await readKvSetting(d1, ownerId, settingKeyPublic);
  let createdRaw = settingKeyCreated === undefined ? "" : ((await readKvSetting(d1, ownerId, settingKeyCreated)) ?? "");
  if (privatePem === null || publicPem === null || (settingKeyCreated !== undefined && createdRaw === "")) {
    const generated = await generateRsaPems(hash);
    const created = Math.floor(Date.now() / 1000);
    const entries = [
      { key: settingKeyPrivate, value: generated.privatePem },
      { key: settingKeyPublic, value: generated.publicPem },
      ...(settingKeyCreated !== undefined ? [{ key: settingKeyCreated, value: String(created) }] : []),
    ];
    await writeKvSettings(d1, ownerId, entries);
    // Re-read: a concurrent generation may have won the upsert race — the
    // stored pair is authoritative either way.
    privatePem = await readKvSetting(d1, ownerId, settingKeyPrivate);
    publicPem = await readKvSetting(d1, ownerId, settingKeyPublic);
    if (privatePem === null || publicPem === null) {
      throw new Error("repository key pair vanished after upsert");
    }
  }
  if (settingKeyCreated !== undefined) {
    createdRaw = (await readKvSetting(d1, ownerId, settingKeyCreated)) ?? "";
  }
  return {
    privatePem,
    publicPem,
    privateKey: await importRsaPrivateKey(privatePem, hash),
    publicSpki: rsaPublicSpki(publicPem),
    ...(settingKeyCreated !== undefined ? { creationTime: Number.parseInt(createdRaw, 10) } : {}),
  };
}

// ---------------------------------------------------------------------------
// The internal repository version + the stored-index discipline
// ---------------------------------------------------------------------------

export interface InternalRepositoryVersion {
  pkg: typeof packages.$inferSelect;
  version: typeof packageVersions.$inferSelect;
}

/**
 * `GetOrCreateInternalPackageVersion` (services/packages/packages.go:464-500)
 * — the housekeeping package (`_debian`/`_alpine` + `_repository`) whose
 * files ARE the registry indices, both rows `is_internal` (excluded from the
 * management lists, quotas and the UI by every landed filter). model.ts's
 * getOrInsert shapes pin isInternal:false, and model.ts is not this unit's —
 * this is the local twin over the same tables and UNIQUE arbitrations (the
 * same re-select on a lost insert race).
 */
export async function getOrCreateInternalPackageVersion(
  d1: D1Database,
  ownerId: number,
  packageType: string,
  repositoryPackage: string,
  repositoryVersion: string,
): Promise<InternalRepositoryVersion> {
  const db = drizzle(d1);
  const lowerName = repositoryPackage.toLowerCase();
  let pkg = await db
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, ownerId), eq(packages.type, packageType), eq(packages.lowerName, lowerName)))
    .get();
  if (pkg === undefined) {
    const inserted = await db
      .insert(packages)
      .values({
        ownerId,
        type: packageType,
        name: repositoryPackage,
        lowerName,
        semverCompatible: false,
        isInternal: true,
      })
      .onConflictDoNothing()
      .returning();
    pkg =
      inserted[0] ??
      (await db
        .select()
        .from(packages)
        .where(and(eq(packages.ownerId, ownerId), eq(packages.type, packageType), eq(packages.lowerName, lowerName)))
        .get());
    if (pkg === undefined) throw new Error("internal package insert raced and the identity lookup then missed");
  }
  const lowerVersion = repositoryVersion.toLowerCase();
  let version = await db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.lowerVersion, lowerVersion)))
    .get();
  if (version === undefined) {
    const inserted = await db
      .insert(packageVersions)
      .values({
        packageId: pkg.id,
        creatorId: ownerId,
        version: repositoryVersion,
        lowerVersion,
        createdUnix: new Date(),
        isInternal: true,
        metadataJson: "null",
        downloadCount: 0,
      })
      .onConflictDoNothing()
      .returning();
    version =
      inserted[0] ??
      (await db
        .select()
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.lowerVersion, lowerVersion)))
        .get());
    if (version === undefined) throw new Error("internal version insert raced and the identity lookup then missed");
  }
  return { pkg, version };
}

export interface StoreRepositoryFileInput {
  /** The internal version's id (the index files' owner row). */
  versionId: number;
  filename: string;
  compositeKey: string;
  /** The full built bytes — index renders are bounded small (the whole point
   *  of the cached posture), so this is in-memory, not a stream. */
  content: Uint8Array;
  properties: Record<string, string>;
  now?: Date;
}

/**
 * `AddFileToPackageVersionInternal` with `OverwriteExisting: true`
 * (packages.go:216-222 + :277-329) — the quota-free internal file write: the
 * content blob is deduped/object-first (the landed blobs.ts discipline), a
 * same-key file row with DIFFERENT bytes is deleted (with its properties —
 * model.ts's deletePackageFile) and re-inserted, an identical-blob row is
 * kept (one less write, the same end state).
 */
export async function storeRepositoryFile(d1: D1Database, bucket: R2Bucket, input: StoreRepositoryFileInput): Promise<void> {
  const db = drizzle(d1);
  const now = input.now ?? new Date();
  // All three WebCrypto digests in one pass (the blobs.ts discipline — the
  // Release checksum sections read sha1/sha512 off these rows).
  const digestBytes = await Promise.all([
    crypto.subtle.digest("SHA-1", input.content as unknown as BufferSource),
    crypto.subtle.digest("SHA-256", input.content as unknown as BufferSource),
    crypto.subtle.digest("SHA-512", input.content as unknown as BufferSource),
  ]);
  const sha1 = bytesToHex(new Uint8Array(digestBytes[0]));
  const sha256 = bytesToHex(new Uint8Array(digestBytes[1]));
  const sha512 = bytesToHex(new Uint8Array(digestBytes[2]));
  const insertedBlob = await db
    .insert(packageBlobs)
    .values({ size: input.content.byteLength, hashSha256: sha256, hashSha1: sha1, hashSha512: sha512, createdUnix: now })
    .onConflictDoNothing()
    .returning()
    .all();
  const blob =
    insertedBlob[0] ??
    (await db.select().from(packageBlobs).where(eq(packageBlobs.hashSha256, sha256)).get());
  if (blob === undefined) {
    throw new Error("package blob insert raced and the dedup lookup then missed");
  }
  const created = insertedBlob.length > 0;
  const contentKey = packageBlobContentKey(sha256);
  const objectPresent = (await bucket.head(contentKey)) !== null;
  if (created || !objectPresent) {
    await bucket.put(contentKey, input.content);
  }
  const lowerName = input.filename.toLowerCase();
  const existing = await db
    .select()
    .from(packageFiles)
    .where(
      and(
        eq(packageFiles.versionId, input.versionId),
        eq(packageFiles.lowerName, lowerName),
        eq(packageFiles.compositeKey, input.compositeKey),
      ),
    )
    .get();
  if (existing !== undefined) {
    if (existing.blobId !== blob.id) {
      await deletePackageFileWithProperties(d1, existing.id);
    } else {
      return; // identical bytes already stored — nothing to do
    }
  }
  const insertedRows = await db
    .insert(packageFiles)
    .values({
      versionId: input.versionId,
      blobId: blob.id,
      name: input.filename,
      lowerName,
      compositeKey: input.compositeKey,
      isLead: false,
      createdUnix: now,
    })
    .onConflictDoNothing()
    .returning()
    .all();
  const row = insertedRows[0];
  if (row === undefined) {
    // A concurrent rebuild won the row — its bytes are the same render over
    // the same model state; keep the winner.
    return;
  }
  const entries = Object.entries(input.properties);
  if (entries.length > 0) {
    await db
      .insert(packageProperties)
      .values(entries.map(([name, value]) => ({ refType: PropertyType.File, refId: row.id, name, value })))
      .run();
  }
}

/** `DeletePackageFile` (the file row + its property rows). */
async function deletePackageFileWithProperties(d1: D1Database, fileId: number): Promise<void> {
  const db = drizzle(d1);
  await db
    .delete(packageProperties)
    .where(and(eq(packageProperties.refType, PropertyType.File), eq(packageProperties.refId, fileId)))
    .run();
  await db.delete(packageFiles).where(eq(packageFiles.id, fileId)).run();
}

/**
 * The empty-repository arm of every upstream builder (`buildPackagesIndex`'s
 * len==0 branch, alpine repository.go:164-174; debian repository.go:155-174):
 * the index file for the key is deleted, nothing is created.
 */
export async function deleteRepositoryFile(
  d1: D1Database,
  versionId: number,
  filename: string,
  compositeKey: string,
): Promise<boolean> {
  const db = drizzle(d1);
  const existing = await db
    .select()
    .from(packageFiles)
    .where(
      and(
        eq(packageFiles.versionId, versionId),
        eq(packageFiles.lowerName, filename.toLowerCase()),
        eq(packageFiles.compositeKey, compositeKey),
      ),
    )
    .get();
  if (existing === undefined) return false;
  await deletePackageFileWithProperties(d1, existing.id);
  return true;
}

/** The file+blob pair for a stored repository file (the serving path). */
export async function openRepositoryFile(
  d1: D1Database,
  versionId: number,
  filename: string,
  compositeKey: string,
): Promise<{ file: typeof packageFiles.$inferSelect; blob: typeof packageBlobs.$inferSelect } | null> {
  return (
    (await drizzle(d1)
      .select({ file: packageFiles, blob: packageBlobs })
      .from(packageFiles)
      .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
      .where(
        and(
          eq(packageFiles.versionId, versionId),
          eq(packageFiles.lowerName, filename.toLowerCase()),
          eq(packageFiles.compositeKey, compositeKey),
        ),
      )
      .get()) ?? null
  );
}

/** The upstream PropertyType iota (package_property.go:22-27) — model.ts
 *  exports it; this local constant keeps the module dependency-free. */
export const PropertyType = { Version: 0, File: 1, Package: 2 } as const;

/** The R2 content key (blobs.ts is not importable here without a cycle — the
 *  same 2/2-shard spelling, KeyToRelativePath content_store.go:69-71 under
 *  packages/). */
export function packageBlobContentKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`invalid package blob sha256: ${sha256}`);
  }
  return `packages/blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** WebCrypto verify — the alpine signature self-check the suites run against
 *  the served public key (the real crypto verification). */
export async function rsaVerify(publicSpki: Uint8Array, hash: "SHA-1" | "SHA-256", signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    publicSpki,
    { name: "RSASSA-PKCS1-v1_5", hash },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
}

// ---------------------------------------------------------------------------
// OpenPGP v4 (RFC 4880) — the debian family's subset: RSA-SHA256 signature
// packets, armor, clearsign, armored detached signatures, and the transferable
// public key gpgv consumes from repository.key.
// ---------------------------------------------------------------------------

const PGP_PUBKEY_ALGO_RSA = 1;
const PGP_HASH_SHA256 = 8;

interface OpenPgpKeyMaterial {
  /** The SPKI DER — n/e MPIs parse out of it (SPKI = SEQ { AlgId, BIT STRING
   *  { RSAPublicKey ::= SEQ { n, e } } }; the walk finds the BIT STRING). */
  publicSpki: Uint8Array;
  privateKey: CryptoKey;
  /** The v4 fingerprint (SHA-1 over 0x99 || len || key-packet). */
  fingerprint: Uint8Array;
  /** The key id — the fingerprint's last 8 bytes. */
  keyId: Uint8Array;
  /** The serialized v4 public-key packet (also the transferable key's body). */
  publicKeyPacket: Uint8Array;
  creationTime: number;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** MPI (RFC 4880 §3.2): u16 bit count + big-endian bytes without leading
 *  zero bits. */
function mpi(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && (bytes[start] ?? 0) === 0) start++;
  const first = bytes[start] ?? 0;
  // clz32 of a byte value (≤ 255) is 24..31; the leading-zero count within
  // the first byte is clz32(first) - 24.
  const bits = (bytes.length - start) * 8 - (Math.clz32(first) - 24);
  return concatBytes(u16(bits), bytes.subarray(start));
}

/** Parse n/e out of an RSA SPKI DER (SEQ { SEQ { OID, NULL }, BIT STRING {
 *  SEQ { INTEGER n, INTEGER e } } }). */
function rsaPublicMpIs(spki: Uint8Array): { n: Uint8Array; e: Uint8Array } {
  let offset = 0;
  const at = (index: number): number => spki[index] ?? -1;
  const readLength = (): number => {
    const byte = at(offset++);
    if (byte & 0x80) {
      const count = byte & 0x7f;
      let length = 0;
      for (let i = 0; i < count; i++) length = (length << 8) | at(offset++);
      return length;
    }
    return byte;
  };
  const expectTag = (tag: number): void => {
    if (at(offset++) !== tag) throw new Error("malformed SPKI DER");
  };
  expectTag(0x30); // outer SEQUENCE
  readLength(); // its length (payload follows)
  expectTag(0x30); // algorithm identifier
  const algLength = readLength();
  offset += algLength; // skip the rsaEncryption OID + NULL
  expectTag(0x03); // BIT STRING
  const bitStringLength = readLength();
  void bitStringLength;
  offset += 1; // the unused-bits octet
  expectTag(0x30); // RSAPublicKey SEQUENCE
  readLength();
  const readInteger = (): Uint8Array => {
    expectTag(0x02);
    const length = readLength();
    const value = spki.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const n = readInteger();
  const e = readInteger();
  return { n, e };
}

/** The v4 public-key packet: 04 || creation u32 || 01 || MPI(n) || MPI(e). */
function buildPublicKeyPacket(spki: Uint8Array, creationTime: number): Uint8Array {
  const { n, e } = rsaPublicMpIs(spki);
  return concatBytes([0x04], u32(creationTime), [PGP_PUBKEY_ALGO_RSA], mpi(n), mpi(e));
}

/** New-format packet header (RFC 4880 §4.2.2) — one- or two-byte length. */
function packetHeader(tag: number, bodyLength: number): Uint8Array {
  const first = 0xc0 | (tag & 0x3f);
  if (bodyLength < 192) return new Uint8Array([first, bodyLength]);
  if (bodyLength <= 8383) {
    const encoded = bodyLength - 192;
    return new Uint8Array([first, 192 + (encoded >> 8), encoded & 0xff]);
  }
  return concatBytes(new Uint8Array([first, 255]), u32(bodyLength));
}

/** Load the OpenPGP key material from the generated RSA arms (the fingerprint
 *  is upstream's SHA-1-over-key-packet v4 form — NOT the alpine SPKI one). */
export async function loadOpenPgpKey(spki: Uint8Array, privateKey: CryptoKey, creationTime: number): Promise<OpenPgpKeyMaterial> {
  const publicKeyPacket = buildPublicKeyPacket(spki, creationTime);
  const fingerprintInput = concatBytes([0x99], u16(publicKeyPacket.byteLength), publicKeyPacket);
  const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-1", fingerprintInput));
  return {
    publicSpki: spki,
    privateKey,
    fingerprint,
    keyId: fingerprint.subarray(12),
    publicKeyPacket,
    creationTime,
  };
}

interface SubpacketArea {
  area: Uint8Array;
  length: number;
}

function subpacketArea(subpackets: Uint8Array[]): SubpacketArea {
  const area = concatBytes(...subpackets);
  return { area, length: area.byteLength };
}

function subpacketCreationTime(creationTime: number): Uint8Array {
  return concatBytes([0x05, 0x02], u32(creationTime));
}

function subpacketIssuerFingerprint(fingerprint: Uint8Array): Uint8Array {
  return concatBytes([255, 0, 0, 0, 22], [0x21, 0x04], fingerprint);
}

function subpacketIssuerKeyId(keyId: Uint8Array): Uint8Array {
  return concatBytes([0x09, 0x10], keyId);
}

/**
 * Sign `document` with RSA-SHA256: the hash covers document || prefix ||
 * trailer (RFC 4880 §5.2.4), the RSA operation is PKCS#1 v1.5 over that hash
 * input (WebCrypto's RSASSA-PKCS1-v1_5 output IS the wire form). `sigType`
 * selects the signature flavor: 0x00 binary document (the detached
 * Release.gpg), 0x01 canonical text document (the clearsign InRelease — the
 * clearsign framework REQUIRES the text type, gpgv rejects a binary-type
 * packet inside the cleartext frame).
 */
export async function openPgpSignaturePacket(
  key: OpenPgpKeyMaterial,
  document: Uint8Array,
  creationTime: number,
  sigType: number,
): Promise<Uint8Array> {
  const hashed = subpacketArea([subpacketCreationTime(creationTime), subpacketIssuerFingerprint(key.fingerprint)]);
  const unhashed = subpacketArea([subpacketIssuerKeyId(key.keyId)]);
  const prefix = concatBytes([0x04, sigType, PGP_PUBKEY_ALGO_RSA, PGP_HASH_SHA256], u16(hashed.length), hashed.area);
  const trailer = concatBytes([0x04, 0xff], u32(6 + hashed.length));
  const hashInput = concatBytes(document, prefix, trailer);
  const signature = await rsaSign(key.privateKey, hashInput);
  const left16 = new Uint8Array(await crypto.subtle.digest("SHA-256", hashInput)).subarray(0, 2);
  const body = concatBytes(
    prefix,
    u16(unhashed.length),
    unhashed.area,
    left16,
    mpi(signature),
  );
  return concatBytes(packetHeader(2, body.byteLength), body);
}

/** The armor framing (RFC 4880 §6): base64 at 76 columns + the CRC-24 line. */
export function openPgpArmor(label: string, body: Uint8Array): string {
  const base64 = bytesToBase64(body);
  const lines: string[] = [];
  for (let offset = 0; offset < base64.length; offset += 76) {
    lines.push(base64.slice(offset, offset + 76));
  }
  const checksum = bytesToBase64(crc24(body)).slice(0, 4);
  return `-----BEGIN ${label}-----\n\n${lines.join("\n")}\n=${checksum}\n-----END ${label}-----\n`;
}

/** Armored detached signature (Release.gpg — upstream ArmoredDetachSign). */
export async function openPgpArmoredDetachedSign(key: OpenPgpKeyMaterial, document: Uint8Array, creationTime: number): Promise<string> {
  const packet = await openPgpSignaturePacket(key, document, creationTime, 0x00);
  return openPgpArmor("PGP SIGNATURE", packet);
}

/** Dash-escape a cleartext document (RFC 4880 §7.1): lines starting with "-"
 *  gain a "- " prefix. */
function dashEscapeLines(text: string): string[] {
  return text.split("\n").map((line) => (line.startsWith("-") ? `- ${line}` : line));
}

/**
 * The clearsigned message (InRelease — upstream clearsign.Encode). The
 * document is normalized to end with a newline first (the framework appends
 * one when missing). The HASH covers the dash-escaped text canonicalized to
 * CRLF **minus the final trailing newline** — that newline is the body/
 * signature SEPARATOR in the cleartext frame and is not signed data (gpg's
 * own framing — cross-verified against gpg's clearsign of the same body: the
 * candidate whose digest prefix matched gpg's verified signature was
 * crlf-without-trailing). The rendered message keeps \n endings.
 */
export async function openPgpClearsign(key: OpenPgpKeyMaterial, text: string, creationTime: number): Promise<string> {
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  const escaped = dashEscapeLines(normalized);
  const renderedBody = escaped.join("\n");
  const canonical = renderedBody.replace(/\n/g, "\r\n");
  const hashSource = canonical.endsWith("\r\n") ? canonical.slice(0, -2) : canonical;
  const packet = await openPgpSignaturePacket(key, asciiBytes(hashSource), creationTime, 0x01);
  const message = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${renderedBody}`;
  return `${message}${openPgpArmor("PGP SIGNATURE", packet)}`;
}

/** The transferable public key (RFC 4880 §11.1): key packet + userid +
 *  self-certification (type 0x13) — the repository.key arm's body, parseable
 *  by gpg --import / apt signed-by. */
export async function openPgpTransferablePublicKey(key: OpenPgpKeyMaterial, userid: string, creationTime: number): Promise<string> {
  const uidBytes = asciiBytes(userid);
  const hashed = subpacketArea([subpacketCreationTime(creationTime), subpacketIssuerFingerprint(key.fingerprint)]);
  const unhashed = subpacketArea([subpacketIssuerKeyId(key.keyId)]);
  const prefix = concatBytes([0x04, 0x13, PGP_PUBKEY_ALGO_RSA, PGP_HASH_SHA256], u16(hashed.length), hashed.area);
  const trailer = concatBytes([0x04, 0xff], u32(6 + hashed.length));
  const certificationInput = concatBytes(
    [0x99],
    u16(key.publicKeyPacket.byteLength),
    key.publicKeyPacket,
    [0xb4],
    u32(uidBytes.byteLength),
    uidBytes,
    prefix,
    trailer,
  );
  const signature = await rsaSign(key.privateKey, certificationInput);
  const left16 = new Uint8Array(await crypto.subtle.digest("SHA-256", certificationInput)).subarray(0, 2);
  const sigBody = concatBytes(prefix, u16(unhashed.length), unhashed.area, left16, mpi(signature));
  // RFC 4880 §11.1 packet ORDER: key || USERID || self-certification (the
  // gpg-import path tolerates a trailing uid, but gpgv/apt's strict ring
  // parser rejects a certification with no preceding uid packet).
  const body = concatBytes(
    packetHeader(13, uidBytes.byteLength),
    uidBytes,
    packetHeader(2, sigBody.byteLength),
    sigBody,
  );
  return openPgpArmor("PGP PUBLIC KEY BLOCK", concatBytes(packetHeader(6, key.publicKeyPacket.byteLength), key.publicKeyPacket, body));
}
