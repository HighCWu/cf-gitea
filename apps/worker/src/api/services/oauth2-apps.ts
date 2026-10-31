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
 * SCOPE BOUNDARY (settled; amended by W3 2026-10-31) — CRUD ONLY. The
 * OAuth2 authorize/token flow is web-UI territory: no token issuance, no
 * grants, no authorization codes. (The W3 wave moved `containsRedirectURI`
 * HERE — oauth2.go:164-205's membership check is a pure application-row
 * predicate both flow halves consume: the authorize handler at
 * /login/oauth/authorize and the token endpoint's exchange check — the
 * original note excluded it because no flow consumer existed yet; see
 * specs/oauth2-provider.md §6 W3.) The API contract
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
// Redirect-URI membership (oauth2.go:164-205) — the authorize-dance check
// (SPEC specs/oauth2-provider.md §2.2 step 3, W3): exact match after
// normalization against every registered URI; PUBLIC clients additionally
// accept the port-stripped loopback variant (RFC 8252 §7.3).
// ---------------------------------------------------------------------------

/** util.ToLowerASCII's fold — ASCII letters only (the call site is
 *  oauth2.go:200; JS `toLowerCase()` is Unicode-aware and would fold
 *  non-ASCII letters Go leaves alone). */
function toLowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** normalizeRedirectURIForComparison (oauth2.go:199-201): ASCII-lowercase
 *  plus ONE trailing-slash trim (Go's strings.TrimSuffix removes a single
 *  suffix occurrence — "a//" keeps its final slash). */
function normalizeRedirectURIForComparison(redirectURI: string): string {
  const lowered = toLowerAscii(redirectURI);
  return lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
}

/** net.ParseIP + IsLoopback over the dotted-quad and plain-IPv6 textual
 *  forms (oauth2.go:203-216's hostname arm): IPv4 loopback = 127.0.0.0/8,
 *  IPv6 loopback = ::1 exactly. Leading-zero IPv4 octets are refused
 *  (Go's net.ParseIP rejects them since 1.17 — "127.0.0.01" is not an IP). */
function isLoopbackIP(host: string): boolean {
  if (host.includes(":")) {
    // IPv6: expand the :: shorthand to a fixed 8-group form, then require
    // the all-zero address with a 1 in the last group (::1).
    const halves = host.split("::");
    if (halves.length > 2) return false;
    const parseGroups = (part: string): string[] | null => {
      if (part === "") return [];
      const groups = part.split(":");
      for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      }
      return groups;
    };
    const left = parseGroups(halves[0] ?? "");
    const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
    if (left === null || right === null) return false;
    const middle: string[] = new Array<string>(8 - left.length - right.length).fill("0");
    const groups = [...left, ...middle, ...right];
    if (groups.length !== 8) return false;
    return groups.slice(0, 7).every((g) => parseInt(g, 16) === 0) && parseInt(groups[7] ?? "", 16) === 1;
  }
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  let firstOctet = -1;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const value = Number(part);
    if (value > 255) return false;
    if (firstOctet === -1) firstOctet = value;
  }
  return firstOctet === 127;
}

/** normalizePublicClientRedirectURI (oauth2.go:203-216): the presented URI
 *  must parse, carry the http scheme and a NON-EMPTY port, and sit on a
 *  loopback IP; the match candidate is the same URI with the port stripped
 *  (Go sets Host = Hostname and re-renders — IPv6 re-brackets, an empty
 *  path renders slash-less). Null when any arm fails (no candidate added). */
function normalizePublicClientRedirectURI(redirectURI: string): string | null {
  let u: URL;
  try {
    u = new URL(redirectURI);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || u.port === "") return null;
  // WHATWG keeps the brackets in `hostname` for IPv6; the IP parse wants the
  // bare address (Go's Hostname() also de-brackets).
  const bareHost = u.hostname.startsWith("[") && u.hostname.endsWith("]") ? u.hostname.slice(1, -1) : u.hostname;
  if (!isLoopbackIP(bareHost)) return null;
  const path = u.pathname === "/" ? "" : u.pathname;
  // The re-spell uses the BARE address (brackets OFF): Go's url.URL.String()
  // with Host = Hostname() over a text IPv6 host renders the bare form, so a
  // presented `http://[::1]:3456/` lands on `http://::1` and matches a
  // registered `http://::1/` — the pin's fixture (oauth2_test.go:87-106,
  // the W2 wave's find: WHATWG's hostname KEEPS the brackets).
  return `${u.protocol}//${bareHost}${path}${u.search}${u.hash}`;
}

/**
 * ContainsRedirectURI (oauth2.go:164-193): the registered-list membership
 * check behind the authorize ladder's "Unregistered Redirect URI" arm and
 * the token endpoint's exchange check. Exact match ONLY (RFC 6819 §5.2.3.3
 * — no dynamic parts): every candidate is ASCII-lowercased and trailing-
 * slash-trimmed before comparison. Non-confidential (public) clients get
 * the one RFC 8252 §7.3 port variance: a loopback http URI with an explicit
 * port also matches its port-stripped form, so a native app presenting
 * `http://127.0.0.1:<ephemeral>` lands on the seeded `http://127.0.0.1`.
 * The equality check downstream (code vs presented URI) compares RAW
 * strings — this normalization never applies there (SPEC §4.4).
 */
export function containsRedirectURI(app: OAuth2AppRow, redirectURI: string): boolean {
  const registered = JSON.parse(app.redirectUris) as string[];
  const candidates = [redirectURI];
  if (!app.confidentialClient) {
    const loopback = normalizePublicClientRedirectURI(redirectURI);
    if (loopback !== null) candidates.push(loopback);
  }
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeRedirectURIForComparison(candidate);
    for (const uri of registered) {
      if (normalizeRedirectURIForComparison(uri) === normalizedCandidate) {
        return true;
      }
    }
  }
  return false;
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
