/**
 * The OAuth2 grant + authorization-code store (SPEC specs/oauth2-provider.md
 * §3 — W1 substrate): the D1 operations behind the authorize/consent/token
 * flow, ported from gitea/models/auth/oauth2.go's OAuth2Grant and
 * OAuth2AuthorizationCode halves. Routes stay thin (W2/W3 own the handlers);
 * this module is the whole model seam they consume.
 *
 * THE TWO LOAD-BEARING PARITY PIECES:
 *   - ONE-TIME CODE CONSUMPTION IS THE DELETE ROWCOUNT (Invalidate,
 *     oauth2.go:443-452): DELETE by id; zero affected rows is the replay
 *     signal (ErrOAuth2AuthorizationCodeInvalidated) — no flag column, no
 *     KV; a single D1 statement is the whole transaction (SPEC §4.1: two
 *     concurrent redemptions serialize on the row, exactly one sees
 *     changes:1).
 *   - THE 10-MINUTE WINDOW (oauth2AuthorizationCodeValidity, oauth2.go:31,
 *     RFC 6749 §4.1.2): valid_until = now + 600 s; expiry is
 *     `valid_until <= now` (IsExpired, oauth2.go:415-419 — a zero stamp
 *     dies too, upstream defends).
 *
 * The grant is the ONLY server-side token state (SPEC §3): access/refresh
 * JWTs carry {gnt, tt, cnt, exp} and resolve authority from the grant row
 * per request, so revokeGrant/updateGrantScope kill outstanding tokens
 * without touching any JWT.
 *
 * The `gta_` code format (GenerateNewAuthorizationCode, oauth2.go:522-542):
 * prefix + 32 crypto-random bytes lowercased base32 unpadded — the same
 * encoding as the landed `gto_` client-secret half (oauth2-apps.ts:91's
 * base32LowerEncode, module-private there and this module is
 * ownership-separated, so the 16-line encoder is duplicated with this
 * citation; upstream itself spells the encoder once per the same model
 * file for both prefixes).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { oauth2Applications, oauth2AuthorizationCodes, oauth2Grants } from "../../db/schema";

export type OAuth2GrantRow = typeof oauth2Grants.$inferSelect;
export type OAuth2ApplicationRow = typeof oauth2Applications.$inferSelect;
export type OAuth2AuthorizationCodeRow = typeof oauth2AuthorizationCodes.$inferSelect;

/** oauth2AuthorizationCodeValidity (oauth2.go:31) — RFC 6749 §4.1.2. */
export const AUTHORIZATION_CODE_VALIDITY_SECONDS = 10 * 60;

/** The one-time-consumption failure (oauth2.go:15, ErrOAuth2Authorization-
 *  CodeInvalidated): the DELETE's rowcount was zero — the code was already
 *  redeemed (or never existed). */
export class ErrOAuth2AuthorizationCodeInvalidated extends Error {
  constructor() {
    super("oauth2 authorization code already invalidated");
    this.name = "ErrOAuth2AuthorizationCodeInvalidated";
  }
}

/** The stale-counter failure (oauth2.go:16, ErrOAuth2GrantStaleCounter):
 *  the compare-and-increment matched zero rows — under
 *  InvalidateRefreshTokens this is the "token was already used" signal. */
export class ErrOAuth2GrantStaleCounter extends Error {
  constructor() {
    super("oauth2 grant state changed during token refresh");
    this.name = "ErrOAuth2GrantStaleCounter";
  }
}

// ---------------------------------------------------------------------------
// The grant (oauth2.go:504-620)
// ---------------------------------------------------------------------------

/** GetGrantByUserID (oauth2.go:236-245): the user's grant for the
 *  application, or null. */
export async function getGrantByUserID(db: D1Database, userId: number, applicationId: number): Promise<OAuth2GrantRow | null> {
  const row = await drizzle(db)
    .select()
    .from(oauth2Grants)
    .where(and(eq(oauth2Grants.userId, userId), eq(oauth2Grants.applicationId, applicationId)))
    .get();
  return row ?? null;
}

/** GetOAuth2GrantByID (oauth2.go:582-592): null when missing (the access
 *  token's authority anchor — a deleted grant kills its tokens). */
export async function getGrantByID(db: D1Database, id: number): Promise<OAuth2GrantRow | null> {
  const row = await drizzle(db).select().from(oauth2Grants).where(eq(oauth2Grants.id, id)).get();
  return row ?? null;
}

/**
 * CreateGrant (oauth2.go:247-261) with the UNIQUE pair arbitrating the
 * consent race: upstream's consent flow is read-then-create
 * (GrantApplicationOAuth, oauth2_provider.go:443-451); two concurrent
 * first-consents would insert twice against unique(user_application).
 * Here the insert is on-conflict-do-nothing and the read-back returns the
 * winner — same observable state as upstream (one grant per pair), with
 * the race resolved by the index instead of an error. `created` tells the
 * consent handler whether to audit "granted_scope" or diff scopes.
 */
export async function getOrCreateGrant(
  db: D1Database,
  input: { userId: number; applicationId: number; scope: string },
  now: Date,
): Promise<{ grant: OAuth2GrantRow; created: boolean }> {
  const d1 = drizzle(db);
  const existing = await getGrantByUserID(db, input.userId, input.applicationId);
  if (existing !== null) {
    return { grant: existing, created: false };
  }
  await d1
    .insert(oauth2Grants)
    .values({
      userId: input.userId,
      applicationId: input.applicationId,
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const grant = await getGrantByUserID(db, input.userId, input.applicationId);
  if (grant === null) {
    throw new Error("oauth2: grant missing after insert (D1 write failed?)");
  }
  return { grant, created: true };
}

/**
 * UpdateGrantScope (oauth2.go:576-579): the scope column ONLY — verbatim
 * parity including the not-touched updated_unix (upstream's
 * `Cols("scope")` update excludes the auto-time column). Scope changes take
 * effect on the next API request; outstanding JWTs carry no scope (§2.4).
 */
export async function updateGrantScope(db: D1Database, grantId: number, scope: string): Promise<void> {
  await drizzle(db).update(oauth2Grants).set({ scope }).where(eq(oauth2Grants.id, grantId));
}

/** SetNonce (oauth2.go:567-574): the nonce column ONLY (same Cols shape). */
export async function setGrantNonce(db: D1Database, grantId: number, nonce: string): Promise<void> {
  await drizzle(db).update(oauth2Grants).set({ nonce }).where(eq(oauth2Grants.id, grantId));
}

/**
 * IncreaseCounter (oauth2.go:545-559): the compare-and-increment
 * UPDATE (WHERE counter = <seen>) — zero rows ⇒ ErrOAuth2GrantStaleCounter,
 * the optimistic lock behind InvalidateRefreshTokens' "token was already
 * used" (the grant's counter has already moved; the stolen token is dead).
 */
export async function increaseGrantCounter(db: D1Database, grantId: number, seenCounter: number): Promise<void> {
  const result = await drizzle(db)
    .update(oauth2Grants)
    .set({ counter: seenCounter + 1 })
    .where(and(eq(oauth2Grants.id, grantId), eq(oauth2Grants.counter, seenCounter)))
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ErrOAuth2GrantStaleCounter();
  }
}

/** GetOAuth2GrantsByUserID (oauth2.go:594-615): the user's grants INNER
 *  JOINed with their applications (the settings grants section's shape —
 *  application name/creator ride beside each grant). */
export async function listGrantsByUserID(
  db: D1Database,
  userId: number,
): Promise<{ grant: OAuth2GrantRow; application: OAuth2ApplicationRow }[]> {
  const rows = await drizzle(db)
    .select({ grant: oauth2Grants, application: oauth2Applications })
    .from(oauth2Grants)
    .innerJoin(oauth2Applications, eq(oauth2Grants.applicationId, oauth2Applications.id))
    .where(eq(oauth2Grants.userId, userId))
    .all();
  return rows;
}

/** RevokeOAuth2Grant (oauth2.go:617-620): delete the grant scoped to its
 *  owner — the settings revoke POST. Cascade removes the grant's codes
 *  (the FK); outstanding access JWTs die on their next resolve. */
export async function revokeGrant(db: D1Database, grantId: number, userId: number): Promise<boolean> {
  const result = await drizzle(db)
    .delete(oauth2Grants)
    .where(and(eq(oauth2Grants.id, grantId), eq(oauth2Grants.userId, userId)))
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** ScopeContains (oauth2.go:562-564): exact-word membership in the
 *  space-separated grant scope. */
export function grantScopeContains(grantScope: string, scope: string): boolean {
  return grantScope.split(" ").includes(scope);
}

// ---------------------------------------------------------------------------
// The authorization code (oauth2.go:403-501)
// ---------------------------------------------------------------------------

/** Base32 characters, but lowercased (oauth2.go:207-211) — the landed
 *  `gto_` encoder's twin (see the module header for the duplication cite). */
const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

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

/** The `gta_` code value (oauth2.go:526-527): the scanner-friendly prefix
 *  over 32 crypto-random bytes lowercased base32 unpadded (52 chars). */
export function generateAuthorizationCodeValue(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return `gta_${base32LowerEncode(random)}`;
}

/**
 * GenerateNewAuthorizationCode (oauth2.go:522-542): mint the `gta_` value,
 * stamp valid_until = now + 10 minutes, insert. PKCE fields carry the
 * authorize-request's challenge verbatim ("" = no PKCE on this code).
 */
export async function generateAuthorizationCode(
  db: D1Database,
  input: {
    grantId: number;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
  },
  now: Date,
): Promise<OAuth2AuthorizationCodeRow> {
  const validUntil = new Date(now.getTime() + AUTHORIZATION_CODE_VALIDITY_SECONDS * 1000);
  const row = {
    grantId: input.grantId,
    code: generateAuthorizationCodeValue(),
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    redirectUri: input.redirectUri,
    validUntil,
  };
  const inserted = await drizzle(db).insert(oauth2AuthorizationCodes).values(row).returning();
  const code = inserted[0];
  if (code === undefined) {
    throw new Error("oauth2: authorization code insert returned no row (D1 write failed?)");
  }
  return code;
}

/**
 * GetOAuth2AuthorizationByCode (oauth2.go:484-501): the code row plus its
 * grant (the token endpoint needs both); null when either half is missing
 * (upstream returns nil for a code whose grant vanished — the cascade makes
 * that half unreachable here, kept for parity).
 */
export async function getAuthorizationByCode(
  db: D1Database,
  code: string,
): Promise<{ code: OAuth2AuthorizationCodeRow; grant: OAuth2GrantRow } | null> {
  const codeRow = await drizzle(db).select().from(oauth2AuthorizationCodes).where(eq(oauth2AuthorizationCodes.code, code)).get();
  if (codeRow === undefined) {
    return null;
  }
  const grant = await getGrantByID(db, codeRow.grantId);
  if (grant === null) {
    return null;
  }
  return { code: codeRow, grant };
}

/** IsExpired (oauth2.go:415-419): `valid_until <= now`; a zero stamp dies
 *  too (upstream defends; our NOT NULL stamp can't be zero, the check stays
 *  for parity). */
export function isAuthorizationCodeExpired(code: OAuth2AuthorizationCodeRow, now: Date): boolean {
  const validUntilMs = code.validUntil.getTime();
  return validUntilMs === 0 || validUntilMs <= now.getTime();
}

/**
 * Invalidate (oauth2.go:443-452) — THE consumption primitive: DELETE by
 * id; the ROWCOUNT is the one-time guard. Zero rows ⇒
 * ErrOAuth2AuthorizationCodeInvalidated (the code was already redeemed —
 * the token endpoint answers invalid_grant "authorization code already
 * used"). Single statement: D1 serializes concurrent redemptions, exactly
 * one caller sees changes:1 (SPEC §4.1 — the transactional-consumption
 * rule satisfied by the rowcount itself, no KV, no flag).
 */
export async function consumeAuthorizationCode(db: D1Database, codeId: number): Promise<void> {
  const result = await drizzle(db).delete(oauth2AuthorizationCodes).where(eq(oauth2AuthorizationCodes.id, codeId)).run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ErrOAuth2AuthorizationCodeInvalidated();
  }
}
