/**
 * The WebAuthn test-vector builders — the FIXED synthetic authenticator the
 * suites drive in place of real hardware (no authenticator in CI, the
 * mission's constraint). Everything here is deterministic structure over
 * test-generated WebCrypto keys: fixed challenges/origins/ids, hand-assembled
 * authenticator data and CBOR attestation objects, and signatures computed
 * over exactly the bytes the verify ladders read (authData ‖ SHA256(
 * clientDataJSON)). TEST-ONLY — imported solely by the webauthn suites; the
 * CBOR/COSE encoders here are deliberately INDEPENDENT of the production
 * encodeCoseKey so a broken encoder cannot self-confirm.
 */

// ---------------------------------------------------------------------------
// A minimal CBOR encoder (fixture-side — the decoder's independent twin)
// ---------------------------------------------------------------------------

export function cborEncode(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeInto(value, chunks);
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeInto(value: unknown, chunks: Uint8Array[]): void {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0) {
      chunks.push(head(0, value));
    } else if (Number.isInteger(value)) {
      chunks.push(head(1, -1 - value));
    } else {
      throw new Error("fixtures: floats not needed");
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    chunks.push(head(3, bytes.length));
    chunks.push(bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    chunks.push(head(2, value.length));
    chunks.push(value);
    return;
  }
  if (Array.isArray(value)) {
    chunks.push(head(4, value.length));
    for (const item of value) encodeInto(item, chunks);
    return;
  }
  if (value instanceof Map) {
    chunks.push(head(5, value.size));
    for (const [key, item] of value) {
      encodeInto(key, chunks);
      encodeInto(item, chunks);
    }
    return;
  }
  throw new Error("fixtures: unsupported value");
}

function head(major: number, value: number): Uint8Array {
  const m = major << 5;
  if (value < 24) return new Uint8Array([m | value]);
  if (value < 0x100) return new Uint8Array([m | 24, value]);
  if (value < 0x10000) return new Uint8Array([m | 25, value >> 8, value & 0xff]);
  return new Uint8Array([m | 26, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

/** A raw CBOR map with INTEGER keys in ARBITRARY (non-canonical) order —
 *  exercises the decoder's order-independence. */
export function cborMapUnsorted(entries: Array<[number, number | Uint8Array | string]>): Uint8Array {
  return cborEncode(new Map<CborInput, CborInput>(entries.map(([k, v]) => [k, v as CborInput])));
}

type CborInput = number | Uint8Array | string | Map<CborInput, CborInput>;

// ---------------------------------------------------------------------------
// The ceremony fixtures
// ---------------------------------------------------------------------------

export const FIXTURE_RP_ID = "test.local";
export const FIXTURE_ORIGIN = "https://test.local";
export const FIXED_CHALLENGE_B64 = "Zml4ZWQtY2hhbGxlbmdlLTMyLWJ5dGVzIQ"; // "fixed-challenge-32-bytes!"-shaped
export const FIXED_AAGUID = new Uint8Array(16).fill(0xab);

export function makeChallenge(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i;
  return bytes;
}

export function clientDataJson(type: "webauthn.create" | "webauthn.get", challengeB64: string, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge: challengeB64, origin, crossOrigin: false }));
}

/** A COSE EC2/P-256 key map (canonical order) — built from raw coordinates. */
export function coseEc2Key(x: Uint8Array, y: Uint8Array): Uint8Array {
  return cborEncode(
    new Map<CborInput, CborInput>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

/** A COSE RSA key map from raw n/e. */
export function coseRsaKey(n: Uint8Array, e: Uint8Array): Uint8Array {
  return cborEncode(
    new Map<CborInput, CborInput>([
      [1, 3],
      [3, -257],
      [-1, n],
      [-2, e],
    ]),
  );
}

export interface AuthDataOptions {
  rpId: string;
  flags: number;
  signCount?: number;
  attested?: { aaguid: Uint8Array; credentialId: Uint8Array; coseKey: Uint8Array };
  extensions?: Map<CborInput, CborInput>;
  /** Append junk after the structure (the trailing-bytes reject arm). */
  trailingJunk?: number;
}

/** Authenticator data: rpIdHash ‖ flags ‖ signCount ‖ [attested] ‖ [ext]. */
export async function buildAuthData(options: AuthDataOptions): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rpId)));
  const count = options.signCount ?? 0;
  const fixed = new Uint8Array(37);
  fixed.set(rpIdHash, 0);
  fixed[32] = options.flags;
  fixed[33] = (count >>> 24) & 0xff;
  fixed[34] = (count >>> 16) & 0xff;
  fixed[35] = (count >>> 8) & 0xff;
  fixed[36] = count & 0xff;
  const chunks: Uint8Array[] = [fixed];
  if (options.attested !== undefined) {
    const len = new Uint8Array(2);
    len[0] = (options.attested.credentialId.length >> 8) & 0xff;
    len[1] = options.attested.credentialId.length & 0xff;
    chunks.push(options.attested.aaguid, len, options.attested.credentialId, options.attested.coseKey);
  }
  if (options.extensions !== undefined) chunks.push(cborEncode(options.extensions));
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total + (options.trailingJunk ?? 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

// ---------------------------------------------------------------------------
// Key pairs (WebCrypto — the real verify surface)
// ---------------------------------------------------------------------------

export interface EcFixture {
  privateKey: CryptoKey;
  /** The parsed COSE key (what the ladders carry). */
  cose: { kty: "EC2"; x: Uint8Array; y: Uint8Array };
  /** The canonical COSE bytes to embed in attested credential data. */
  coseBytes: Uint8Array;
}

export async function makeEcFixture(): Promise<EcFixture> {
  // workers-types' generateKey widens to CryptoKey | CryptoKeyPair — the
  // fixtures' call shapes are fixed, so the assertion is local and exact.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const x = base64UrlDecode(publicKey.x!);
  const y = base64UrlDecode(publicKey.y!);
  return {
    privateKey: pair.privateKey,
    cose: { kty: "EC2", x, y },
    coseBytes: coseEc2Key(x, y),
  };
}

export interface RsaFixture {
  privateKey: CryptoKey;
  cose: { kty: "RSA"; n: Uint8Array; e: Uint8Array };
  coseBytes: Uint8Array;
}

export async function makeRsaFixture(): Promise<RsaFixture> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const n = base64UrlDecode(publicKey.n!);
  const e = base64UrlDecode(publicKey.e!);
  return {
    privateKey: pair.privateKey,
    cose: { kty: "RSA", n, e },
    coseBytes: coseRsaKey(n, e),
  };
}

export async function signWith(fixture: EcFixture | RsaFixture, data: Uint8Array): Promise<Uint8Array> {
  const algorithm = fixture.cose.kty === "EC2" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return new Uint8Array(await crypto.subtle.sign(algorithm, fixture.privateKey, data));
}

// ---------------------------------------------------------------------------
// The response bodies (exactly the vendored JS's POST shapes)
// ---------------------------------------------------------------------------

export interface CreationBodyOptions {
  credentialId: Uint8Array;
  authData: Uint8Array;
  clientData: Uint8Array;
  fmt?: string;
  attStmt?: Map<CborInput, CborInput>;
  transports?: string[];
}

export function buildCreationResponse(options: CreationBodyOptions): Record<string, unknown> {
  const attestationObject = cborEncode(
    new Map<CborInput, CborInput>([
      ["fmt", options.fmt ?? "none"],
      ["attStmt", options.attStmt ?? new Map()],
      ["authData", options.authData],
    ]),
  );
  const id = base64UrlEncode(options.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      attestationObject: base64UrlEncode(attestationObject),
      clientDataJSON: base64UrlEncode(options.clientData),
      ...(options.transports !== undefined ? { transports: options.transports } : {}),
    },
  };
}

export interface AssertionBodyOptions {
  credentialId: Uint8Array;
  authData: Uint8Array;
  clientData: Uint8Array;
  signature: Uint8Array;
  userHandle?: Uint8Array | null;
}

export function buildAssertionResponse(options: AssertionBodyOptions): Record<string, unknown> {
  const id = base64UrlEncode(options.credentialId);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: base64UrlEncode(options.authData),
      clientDataJSON: base64UrlEncode(options.clientData),
      signature: base64UrlEncode(options.signature),
      userHandle: options.userHandle === null || options.userHandle === undefined ? "" : base64UrlEncode(options.userHandle),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared byte codecs (duplicated from the module — the fixtures must not
// import the code under test beyond the TYPE)
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
