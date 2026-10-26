import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { oauth2Applications } from "../../db/schema";
import { ApiError } from "../errors";

/**
 * The OAuth2 application service — upstream `OAuth2Application` CRUD
 * (gitea/models/auth/oauth2.go) behind the `/user/applications/oauth2`
 * family (routes/oauth2-apps.ts, migration 0026's `oauth2_application`).
 * Upstream anchors, per function:
 *
 *   - detectInvalidOAuth2ApplicationRedirectURI
 *                        — forms.DetectInvalidOAuth2ApplicationRedirectURI
 *                          (services/forms/user_form.go:256-263): each URI
 *                          must carry a "scheme:" (strings.Cut finds the
 *                          colon) and pass IsValidURL
 *                          (modules/validation/helpers.go:42-50 —
 *                          url.ParseRequestURI + http/https scheme + valid
 *                          port). Upstream also allows
 *                          `setting.OAuth2.CustomSchemes` scheme names
 *                          (modules/setting/oauth2.go:102); cf-gitea has no
 *                          settings seam and the upstream default is empty,
 *                          so the custom-scheme arm is NOT ported (documented
 *                          divergence).
 *   - generateClientSecret — OAuth2Application.GenerateClientSecret
 *                          (oauth2.go:213-224): 32 crypto-random bytes,
 *                          lowercased base32 without padding, "gto_" prefix
 *                          (the scanner-grab aid), HASH stored, plaintext
 *                          returned exactly once. Upstream hashes with
 *                          bcrypt.DefaultCost (oauth2.go:217); Workers ship
 *                          no bcrypt, so the hash is PBKDF2-SHA256
 *                          (100k iterations, 16-byte random salt, 32-byte
 *                          derived key) stored as the self-describing
 *                          `pbkdf2-sha256$<iter>$<salt-b64url>$<hash-b64url>`
 *                          string — verifyClientSecret keeps the encoding
 *                          future-token-flow-verifiable. Divergence recorded
 *                          here and in the schema comment.
 *   - createOAuth2Application — CreateOAuth2Application
 *                          (oauth2.go:294-308: UUID client_id, insert) +
 *                          GenerateClientSecret (oauth2.go:213-224). Upstream
 *                          writes the row and then the secret column in two
 *                          statements; ours folds the hash into the single
 *                          INSERT — identical observable state.
 *   - getOAuth2ApplicationById — GetOAuth2ApplicationByID
 *                          (oauth2.go:272-282).
 *   - updateOAuth2Application — UpdateOAuth2Application
 *                          (oauth2.go:321-352): load, UID check, overwrite
 *                          name/redirect_uris/flags, then the handler
 *                          regenerates the secret (app.go
 *                          UpdateOauth2Application) so every PATCH rotates
 *                          the client secret. Upstream's UID mismatch is a
 *                          PLAIN error (oauth2.go:328) that its handler maps
 *                          to APIErrorInternal (500) — only
 *                          ErrOAuthApplicationNotFound is a 404
 *                          (routers/api/v1/user/app.go UpdateOauth2Application).
 *   - deleteOAuth2Application — DeleteOAuth2Application
 *                          (oauth2.go:386-401): delete WHERE (id, uid), 0
 *                          rows → ErrOAuthApplicationNotFound. Upstream also
 *                          cascades oauth2_grant + oauth2_authorization_code
 *                          rows (oauth2.go:403-409); those tables are
 *                          authorize/token-flow territory and do not exist in
 *                          this batch — nothing to cascade.
 *   - listOAuth2Applications — FindOAuth2ApplicationsOptions
 *                          (models/auth/oauth2_list.go:12-33): uid filter,
 *                          `id DESC` ordering, paginated.
 *
 * SCOPE BOUNDARY (settled) — CRUD ONLY. The OAuth2 authorize/token flow is
 * web-UI territory: no token issuance, no grants, no authorization codes, no
 * ContainsRedirectURI matching (oauth2.go:164-193 — consumed by /login/oauth/
 * authorize, not by this family). The API contract
 * (`v1-swagger.generated.json`) defines NO `scopes` field on
 * OAuth2Application/CreateOAuth2ApplicationOptions in this pin — scopes live
 * on OAuth2Grant (oauth2.go:510), so there is no application-level scope
 * validation to port; the confidential-client flag IS ported exactly
 * (NOT NULL DEFAULT TRUE, oauth2.go:49).
 */

/** The wire `OAuth2Application` row (services/convert/convert.go:1053-1064). */
export type OAuth2AppRow = typeof oauth2Applications.$inferSelect;

// ---------------------------------------------------------------------------
// Secret generation + hashing (oauth2.go:213-232, bcrypt swapped for PBKDF2).
// ---------------------------------------------------------------------------

/** Base32 characters, but lowercased (oauth2.go:207). */
const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";
const PBKDF2_ITERATIONS = 100_000;
const HASH_PREFIX = "pbkdf2-sha256";

function base32LowerEncode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_LOWER[(value << (5 - bits)) & 31];
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(encoded: string): Uint8Array {
  const std = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/**
 * GenerateClientSecret's encoding half (oauth2.go:213-222): 32 random bytes
 * → lowercased base32 (52 chars, no padding) behind the "gto_" prefix, plus
 * the at-rest hash (PBKDF2-SHA256 — see the module header). The plaintext is
 * returned exactly once and NEVER logged or stored.
 */
export async function generateClientSecret(): Promise<{ plaintext: string; hash: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = `gto_${base32LowerEncode(random)}`;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(plaintext, salt, PBKDF2_ITERATIONS);
  const hash = `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
  return { plaintext, hash };
}

/**
 * ValidateClientSecret (oauth2.go:232-234), over the PBKDF2 encoding.
 * Constant-time comparison; unparseable hashes simply fail.
 */
export async function verifyClientSecret(hash: string, plaintext: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) {
    return false;
  }
  const iterations = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }
  const salt = base64UrlDecode(parts[2] ?? "");
  const expected = base64UrlDecode(parts[3] ?? "");
  const derived = await pbkdf2(plaintext, salt, iterations);
  if (derived.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < derived.length; i++) {
    diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Redirect URI validation (services/forms/user_form.go:256-263).
// ---------------------------------------------------------------------------

/** IsValidURL (modules/validation/helpers.go:42-50) — the WHATWG parser
 *  rejects relative URIs and non-numeric ports by throwing, which folds
 *  Go's url.ParseRequestURI + validPort arms into the protocol check. */
function isValidURL(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * DetectInvalidOAuth2ApplicationRedirectURI — returns the FIRST invalid URI
 * or "" (user_form.go:256-263). The upstream custom-scheme arm
 * (setting.OAuth2.CustomSchemes) is not ported — see the module header.
 */
export function detectInvalidOAuth2ApplicationRedirectURI(uris: string[]): string {
  for (const u of uris) {
    const hasScheme = u.includes(":");
    if (!hasScheme || !isValidURL(u)) {
      return u;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// CRUD (models/auth/oauth2.go).
// ---------------------------------------------------------------------------

export interface CreateOAuth2ApplicationOpts {
  uid: number;
  name: string;
  redirectUris: string[];
  confidentialClient: boolean;
  skipSecondaryAuthorization: boolean;
}

/**
 * CreateOAuth2Application + GenerateClientSecret (oauth2.go:294-308,
 * :213-224): UUID client_id, one INSERT carrying the secret HASH, plaintext
 * surfaced exactly once. An insert failure takes the handler's 400 arm
 * ("error creating oauth2 application", user/app.go CreateOauth2Application);
 * a secret failure would take "error creating application secret" — crypto
 * failures surface as 400 exactly like upstream.
 */
export async function createOAuth2Application(
  d1: D1Database,
  opts: CreateOAuth2ApplicationOpts,
  now: Date,
): Promise<{ row: OAuth2AppRow; secret: string }> {
  const { plaintext, hash } = await generateClientSecret();
  try {
    const inserted = await drizzle(d1)
      .insert(oauth2Applications)
      .values({
        uid: opts.uid,
        name: opts.name,
        clientId: crypto.randomUUID(),
        clientSecret: hash,
        confidentialClient: opts.confidentialClient,
        skipSecondaryAuthorization: opts.skipSecondaryAuthorization,
        redirectUris: JSON.stringify(opts.redirectUris),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { row: inserted[0]!, secret: plaintext };
  } catch {
    // Upstream maps ANY create error to the 400 arm (user/app.go:
    // CreateOauth2Application) — the insert failure included.
    throw new ApiError(400, "error creating oauth2 application");
  }
}

/** GetOAuth2ApplicationByID (oauth2.go:272-282) — null on miss. */
export async function getOAuth2ApplicationById(d1: D1Database, id: number): Promise<OAuth2AppRow | null> {
  const rows = await drizzle(d1).select().from(oauth2Applications).where(eq(oauth2Applications.id, id)).limit(1);
  return rows[0] ?? null;
}

export type UpdateOAuth2ApplicationResult =
  | { kind: "ok"; row: OAuth2AppRow; secret: string }
  | { kind: "not_found" }
  | { kind: "uid_mismatch" };

/**
 * UpdateOAuth2Application + the handler's secret rotation
 * (oauth2.go:321-352, user/app.go UpdateOauth2Application): load by id, UID
 * check, overwrite name/redirect_uris/flags, regenerate the secret. The
 * upstream two-statement sequence (row UPDATE then secret-column UPDATE) is
 * folded into one UPDATE carrying the new hash. `uid_mismatch` is upstream's
 * plain "UID mismatch" error (oauth2.go:328) — the route renders it as its
 * APIErrorInternal 500 arm, NOT a 404.
 */
export async function updateOAuth2Application(
  d1: D1Database,
  opts: { id: number; uid: number; name: string; redirectUris: string[]; confidentialClient: boolean; skipSecondaryAuthorization: boolean },
  now: Date,
): Promise<UpdateOAuth2ApplicationResult> {
  const existing = await getOAuth2ApplicationById(d1, opts.id);
  if (existing === null) {
    return { kind: "not_found" };
  }
  if (existing.uid !== opts.uid) {
    return { kind: "uid_mismatch" };
  }
  const { plaintext, hash } = await generateClientSecret();
  const updated = await drizzle(d1)
    .update(oauth2Applications)
    .set({
      name: opts.name,
      confidentialClient: opts.confidentialClient,
      skipSecondaryAuthorization: opts.skipSecondaryAuthorization,
      redirectUris: JSON.stringify(opts.redirectUris),
      clientSecret: hash,
      updatedAt: now,
    })
    .where(eq(oauth2Applications.id, opts.id))
    .returning();
  return { kind: "ok", row: updated[0]!, secret: plaintext };
}

/**
 * DeleteOAuth2Application (oauth2.go:386-401): delete WHERE (id, uid); 0 rows
 * → ErrOAuthApplicationNotFound (false here). The grant/auth-code cascade
 * (oauth2.go:403-409) has no counterpart — see the module header.
 */
export async function deleteOAuth2Application(d1: D1Database, id: number, uid: number): Promise<boolean> {
  const deleted = await drizzle(d1)
    .delete(oauth2Applications)
    .where(and(eq(oauth2Applications.id, id), eq(oauth2Applications.uid, uid)))
    .returning();
  return deleted.length > 0;
}

/** FindOAuth2ApplicationsOptions (oauth2_list.go:12-33) — uid filter,
 *  `id DESC`, paginated. */
export async function listOAuth2Applications(
  d1: D1Database,
  uid: number,
  page: number,
  limit: number,
): Promise<{ rows: OAuth2AppRow[]; total: number }> {
  const totals = await drizzle(d1).select({ value: count() }).from(oauth2Applications).where(eq(oauth2Applications.uid, uid));
  const rows = await drizzle(d1)
    .select()
    .from(oauth2Applications)
    .where(eq(oauth2Applications.uid, uid))
    .orderBy(desc(oauth2Applications.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total: totals[0]?.value ?? 0 };
}

/**
 * ToOAuth2Application (services/convert/convert.go:1053-1064). `clientSecret`
 * is whatever the caller renders: the plaintext exactly once on create/patch,
 * "" everywhere else (user/app.go ListOauth2Applications "Hide secret on
 * application list" / GetOauth2Application's blank).
 */
export function toApiOAuth2Application(
  row: OAuth2AppRow,
  clientSecret: string,
): {
  id: number;
  name: string;
  client_id: string;
  client_secret: string;
  confidential_client: boolean;
  skip_secondary_authorization: boolean;
  redirect_uris: string[];
  created: string;
} {
  return {
    id: row.id,
    name: row.name,
    client_id: row.clientId,
    client_secret: clientSecret,
    confidential_client: row.confidentialClient,
    skip_secondary_authorization: row.skipSecondaryAuthorization,
    redirect_uris: JSON.parse(row.redirectUris) as string[],
    created: row.createdAt.toISOString(),
  };
}
