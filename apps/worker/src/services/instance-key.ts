/**
 * The instance-key AEAD envelope for at-rest secret data (census B-57, the
 * A14 at-rest arm): upstream stores actions secret `data` AES-encrypted with
 * the instance SecretKey — EncryptSecret → sha256(SecretKey) → AES-256-CFB
 * over base64(plaintext) with a random 16-byte IV prepended, hex-spelled
 * (modules/secret/secret.go:57-66, 20-34) — and DecryptSecret reverses it on
 * every read (models/secret/secret.go:155-190, the task's secret map).
 *
 * CIPHER ADAPTATION (PLATFORM): WebCrypto offers no CFB mode, so the envelope
 * is AES-256-GCM — strictly stronger than upstream's CFB (the GCM tag IS the
 * integrity mechanism; upstream's unauthenticated CFB ciphertext is silently
 * malleable). Key derivation keeps upstream's SHA-256-over-the-instance-key
 * SHAPE but lands on the tree's established recipe (auth/two-factor.ts:212-255,
 * the ticket AEAD): HKDF-SHA256 over the instance signing secret with a fixed
 * non-secret domain-separated info string, 256 output bits, AES-GCM.
 *
 * KEY HOME: the EXISTING `general_token_signing_secret` system_keystore row
 * (services/actions/secrets.ts KEYSTORE_SECRET_ROW — the `[oauth2]
 * JWT_SECRET` / `[security] SECRET_KEY` role): the instance-scoped crypto
 * material the tree already carries. The row read is module-LOCAL (this
 * module's own copy of the load-or-generate arm) — the tree's decoupling
 * convention (auth/two-factor.ts:303-308 re-declares it from
 * services/oauth2/keys.ts for the same reason; oauth2/keys.ts:53-71 is
 * itself a re-declaration): a consumer reads the shared row through its own
 * generate-once insert-or-nothing + read-back arm, so the modules stay
 * decoupled and every consumer converges on one row's material regardless
 * of which consumer warmed it. No R2 legacy-adoption arm here (same posture
 * as two-factor.ts — deployments predating migration 0042 adopt through the
 * Actions keystore loader's own loads).
 *
 * ENVELOPE (the format-swap decision — NO migration): the SAME `secrets.data`
 * TEXT column now carries `v1:<base64url(iv || ciphertext||tag)>` — a
 * version prefix the reader dispatches on. Rows written before this change
 * hold legacy PLAINTEXT: a value without the `v1:` prefix is returned
 * as-is by the read arm (transparent legacy read), and every write path
 * (createOrUpdateSecret) stores the envelope — transparent upgrade-on-write,
 * so legacy rows convert the next time their secret is edited. Upstream has
 * no legacy arm of its own (it has always encrypted), so the arm's shape is
 * ours; the version prefix is the same wire-version discipline as
 * two-factor.ts's ticket byte (0x01) and the keystore rows' `v` member.
 *
 * ROTATION: OPERATOR-ONLY, exactly the keystore's semantics (the row
 * header in services/actions/secrets.ts: "replace or delete the row
 * out-of-band and restart") — the code never rewrites the row. After a
 * rotation every previously written envelope fails to open (the reader's
 * skip arm engages — upstream's identical failure shape: DecryptSecret
 * errors "maybe SECRET_KEY is wrong" and GetSecretsOfTask logs + SKIPS the
 * secret, models/secret/secret.go:180-185), and new writes seal under the
 * new key.
 *
 * WIRE-INVISIBILITY: the API never returns secret `data` (the `Secret`
 * wire shape, modules/structs/secret.go:10-17 — name/description/created_at
 * only), so the at-rest format is invisible to the contract; the 60-test
 * secrets-variables routes battery stays byte-identical across this change.
 *
 * KNOWN EDGE (documented, accepted): a LEGACY plaintext value that happens
 * to begin with the literal characters `v1:` would misdispatch to the
 * envelope arm and fail the floor gate. New writes are always enveloped, so
 * only pre-change rows are exposed, and a real secret payload starting with
 * exactly `v1:` plus 12+ bytes of valid base64url is not a realistic token
 * shape; such a row fails closed (the skip arm), never leaks.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { systemKeystore } from "../db/schema";

/**
 * The shared instance-secret row (the `[security] SECRET_KEY` role) —
 * services/actions/secrets.ts's KEYSTORE_SECRET_ROW value, re-declared per
 * the decoupling convention (see the module header).
 */
const GENERAL_TOKEN_SIGNING_SECRET_ROW = "general_token_signing_secret";

/**
 * The envelope prefix — the reader's dispatch key. `v1` is the only
 * version; a future re-key or format lands `v2:` (or a fresh prefix) beside
 * the same TEXT column.
 */
export const INSTANCE_ENVELOPE_PREFIX = "v1:";

/** GCM nonce (WebCrypto's recommended length) + tag lengths. */
const ENVELOPE_IV_BYTES = 12;
const ENVELOPE_TAG_BYTES = 16;

/** HKDF salt/info — fixed, non-secret domain separators (two-factor.ts:225-228's
 *  posture); the entropy is entirely the instance secret. The info string is
 *  versioned so a future derivation change is a distinct key domain. */
const HKDF_SALT = "cf-gitea:instance-secret-at-rest";
const HKDF_INFO = "cf-gitea:actions-secret-at-rest-aead-v1";

/** The signing-secret row's payload spelling (the keystore `v` field is the
 *  rows' own format version; 1 = the only D1 spelling). */
interface SecretPiece {
  v: number;
  tokenSigningSecret: string;
}

function assertSecretPiece(value: unknown): SecretPiece {
  if (typeof value !== "object" || value === null || typeof (value as SecretPiece).tokenSigningSecret !== "string") {
    throw new Error("instance-key: keystore secret piece malformed");
  }
  return value as SecretPiece;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The instance secret (the shared keystore row) — module-local, cached per
// isolate (the isolate's copy of upstream's process-wide SECRET_KEY var).
// ---------------------------------------------------------------------------

const signingSecretCache = new Map<string, Promise<string>>();
const aeadKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * TEST-ONLY: drop the module-level signing-secret + AEAD-key caches — the
 * simulated isolate restart (the rotation semantics' second half; the
 * two-factor.ts resetTwofaSigningSecretCache precedent). Never call from a
 * request path.
 */
export function resetInstanceKeyCacheForTests(): void {
  signingSecretCache.clear();
  aeadKeyCache.clear();
}

/** Load-or-generate the signing secret row (generate-once insert-or-nothing
 *  + read-back arbitration — a concurrent cold load loses the insert race
 *  and ADOPTS the winner's material; the keystore header's posture). */
async function loadSigningSecretHex(d1: D1Database): Promise<string> {
  const cached = signingSecretCache.get(GENERAL_TOKEN_SIGNING_SECRET_ROW);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<string> => {
    const db = drizzle(d1);
    const row = await db
      .select()
      .from(systemKeystore)
      .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
      .get();
    if (row !== undefined) {
      try {
        return assertSecretPiece(JSON.parse(row.value)).tokenSigningSecret;
      } catch (error) {
        throw new Error(`instance-key: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} is not valid JSON`, {
          cause: error,
        });
      }
    }
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    let secretHex = "";
    for (const b of secretBytes) secretHex += b.toString(16).padStart(2, "0");
    const now = new Date();
    await db
      .insert(systemKeystore)
      .values({ name: GENERAL_TOKEN_SIGNING_SECRET_ROW, value: JSON.stringify({ v: 1, tokenSigningSecret: secretHex }), createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const rowAfter = await db
      .select()
      .from(systemKeystore)
      .where(eq(systemKeystore.name, GENERAL_TOKEN_SIGNING_SECRET_ROW))
      .get();
    if (rowAfter === undefined) {
      throw new Error(`instance-key: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} missing after insert (D1 write failed?)`);
    }
    try {
      return assertSecretPiece(JSON.parse(rowAfter.value)).tokenSigningSecret;
    } catch (error) {
      throw new Error(`instance-key: keystore row ${GENERAL_TOKEN_SIGNING_SECRET_ROW} is not valid JSON`, { cause: error });
    }
  })();
  signingSecretCache.set(GENERAL_TOKEN_SIGNING_SECRET_ROW, promise);
  promise.catch(() => signingSecretCache.delete(GENERAL_TOKEN_SIGNING_SECRET_ROW));
  return promise;
}

/** The AES-256-GCM envelope key: HKDF-SHA256(salt, info) over the raw
 *  instance secret bytes, 256 bits — cached alongside the secret (the
 *  two-factor.ts:232-255 recipe). */
async function loadEnvelopeKey(d1: D1Database): Promise<CryptoKey> {
  const secretHex = await loadSigningSecretHex(d1);
  const cached = aeadKeyCache.get(secretHex);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<CryptoKey> => {
    const ikm = await crypto.subtle.importKey("raw", hexToBytes(secretHex), "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new TextEncoder().encode(HKDF_SALT),
        info: new TextEncoder().encode(HKDF_INFO),
      },
      ikm,
      256,
    );
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  aeadKeyCache.set(secretHex, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// The envelope arms
// ---------------------------------------------------------------------------

/**
 * Seal plaintext for the `secrets.data` column: `v1:<base64url(iv || AES-256-GCM(
 * plaintext))>` (WebCrypto appends the 128-bit tag to the ciphertext —
 * two-factor.ts:257-276's wire shape, text-prefixed instead of byte-prefixed
 * because this column is TEXT and the reader dispatches on the prefix).
 * Every call produces a fresh IV, so two seals of the same plaintext differ
 * (upstream's random-IV property, modules/secret/secret.go:27-30).
 */
export async function encryptInstanceSecretData(d1: D1Database, plaintext: string): Promise<string> {
  const key = await loadEnvelopeKey(d1);
  const iv = crypto.getRandomValues(new Uint8Array(ENVELOPE_IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: ENVELOPE_TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const wire = new Uint8Array(ENVELOPE_IV_BYTES + sealed.length);
  wire.set(iv, 0);
  wire.set(sealed, ENVELOPE_IV_BYTES);
  return INSTANCE_ENVELOPE_PREFIX + base64UrlEncode(wire);
}

/**
 * Open a stored `secrets.data` value — THE VERSION DISPATCH:
 *   - no version prefix at all → legacy PLAINTEXT, returned as-is (the
 *     transparent legacy read arm; upgrade-on-write converts the row on its
 *     next edit);
 *   - `v1:` → the floor gate (IV + the GCM tag alone) then AEAD-open; any
 *     malformed/tampered/wrong-key value THROWS — callers decide the skip
 *     arm (upstream's log-and-continue, models/secret/secret.go:180-185;
 *     dispatch.ts's getSecretsOfTask engages it);
 *   - any OTHER versioned prefix (`vN:` with N != 1 — a newer build's
 *     envelope) → throws unknown-envelope-version: an older build must not
 *     silently serve a newer format's envelope string as the secret value.
 */
export async function decryptInstanceSecretData(d1: D1Database, stored: string): Promise<string> {
  if (!stored.startsWith(INSTANCE_ENVELOPE_PREFIX)) {
    if (/^v[0-9]+:/.test(stored)) {
      throw new Error(`instance-key: unknown envelope version in stored value (newer build's format?)`);
    }
    return stored;
  }
  const wire = base64UrlDecode(stored.slice(INSTANCE_ENVELOPE_PREFIX.length));
  if (wire === null || wire.length < ENVELOPE_IV_BYTES + ENVELOPE_TAG_BYTES) {
    throw new Error("instance-key: envelope malformed (v1 floor gate)");
  }
  const key = await loadEnvelopeKey(d1);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: wire.slice(0, ENVELOPE_IV_BYTES), tagLength: ENVELOPE_TAG_BYTES * 8 },
      key,
      wire.slice(ENVELOPE_IV_BYTES),
    );
  } catch (error) {
    throw new Error("instance-key: envelope failed to open (wrong key after rotation, or tampered)", { cause: error });
  }
  return new TextDecoder().decode(plain);
}
