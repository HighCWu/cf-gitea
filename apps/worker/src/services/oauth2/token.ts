/**
 * The OAuth2 token service (SPEC specs/oauth2-provider.md §2.3-§2.5, §2.7 —
 * W2): the mint of the access/refresh/id_token trio, the grant-scope
 * normalization family, the PKCE verify, the introspection/userinfo claim
 * assembly and the API auth-method resolution — the model seam behind
 * web/oauth2-token.ts's routes and src/auth's Bearer-dots dispatch.
 *
 * THE MEMBER-ORDER DISCIPLINE (the failed unit's signature): every JSON
 * object this module builds spells its members in the GO STRUCT FIELD ORDER
 * of the pin's struct — JSON.stringify preserves insertion order, Go's
 * encoding/json/v2 preserves declaration order — so responses are
 * byte-compatible:
 *   - AccessTokenResponse (access_token.go:69-76): access_token, token_type,
 *     expires_in, refresh_token, id_token (omitempty), scope (omitempty).
 *   - AccessTokenError (:47-50): error, error_description.
 *   - Token claims (token.go:29-34): gnt, tt, cnt (omitempty — an access
 *     token's zero counter is OMITTED, a refresh token's rides), then the
 *     golang-jwt RegisteredClaims members iss/sub/aud/exp/nbf/iat/jti
 *     (omitempty — here only exp and iat ever carry).
 *   - OIDCToken (token.go:67-86): the embedded RegisteredClaims first (iss,
 *     sub, aud, exp, then iat stamped by SignToken), then nonce, the profile
 *     family, email/email_verified, groups — ALL omitempty, including
 *     email_verified (a Go bool omitempty: FALSE is OMITTED — the claim
 *     appears only when the account is verified).
 *   - the userinfo struct (oauth2_provider.go:86-93): sub, name,
 *     preferred_username, email, picture, groups — NONE omitempty, and the
 *     pin's json handler formats nil slices as null (modules/json/jsonv2.go
 *     FormatNilSliceAsNull), so an org-less user renders "groups":null.
 *   - the introspection struct (oauth2_provider.go:169-174): active, scope
 *     (omitempty), username (omitempty), then RegisteredClaims (iss, sub,
 *     aud — exp is explicitly nil upstream and stays omitted).
 *
 * THE NO-DEFAULT-ROTATION TRAP (§2.3 step 4 / §4.6): upstream's
 * InvalidateRefreshTokens defaults FALSE — a used refresh token is
 * REUSABLE until expiry and every refresh mints the pair with the SAME
 * grant counter (the `cnt` claim rides inert). The compare-and-increment
 * runs ONLY when the flag is on (NewAccessTokenResponse,
 * access_token.go:155-162). Ported both arms; production keeps the default
 * (the flag has no cf-gitea var — consistent with the DEFAULT_APPLICATIONS
 * decision, SPEC §2.9), tests drive the ON arm through the service option.
 *
 * THE EXPIRY-UNITS TRAP (§2.3): the access expiry 3600 is SECONDS
 * (access_token.go:164) but the refresh expiry multiplies the 730 default
 * by 60*60 — HOURS (access_token.go:181, ≈30.4 days). The arithmetic is
 * ported verbatim from the upstream defaults (no settings seam).
 *
 * Byte-shape conventions of the pin's JSON writer (modules/json/jsonv2.go
 * + services/context/base.go:114-120): compact, NO trailing newline, no
 * HTML escaping, struct order preserved, maps sorted alphabetically, nil
 * slices null. Response builders here return plain objects in the exact
 * member order; the route layer stringifies.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { normalizeScope as normalizeAccessTokenScope } from "../../auth/scopes";
import { oauth2Applications, orgMembers, teamMembers, teams, userSettings, users } from "../../db/schema";
import {
  getGrantByID,
  grantScopeContains,
  increaseGrantCounter,
  type OAuth2ApplicationRow,
  type OAuth2AuthorizationCodeRow,
  type OAuth2GrantRow,
} from "./grants";
import { assertApiTimeBounds, importSigningKey, importVerifyKey, signJws, verifyJws, type JwsAlgorithm } from "./jws";
import { isSymmetricAlgorithm, loadOAuth2SigningKey, type OAuth2SigningKeyRef } from "./keys";

/** access_token.go:164 — `[oauth2] ACCESS_TOKEN_EXPIRATION_TIME` upstream
 *  default, consumed as seconds. */
export const ACCESS_TOKEN_EXPIRATION_SECONDS = 3600;
/** modules/setting/oauth2.go:106 — RefreshTokenExpirationTime default 730,
 *  consumed as HOURS (access_token.go:181 multiplies by 60*60). */
export const REFRESH_TOKEN_EXPIRATION_HOURS = 730;
export const REFRESH_TOKEN_EXPIRATION_SECONDS = REFRESH_TOKEN_EXPIRATION_HOURS * 60 * 60;

/** The upstream TokenKind constants (token.go:21-26). */
export const KIND_ACCESS_TOKEN = 0;
export const KIND_REFRESH_TOKEN = 1;

// ---------------------------------------------------------------------------
// The feature gate (the `setting.OAuth2.Enabled` role) — strict polarity,
// ONLY the exact string "false" disables (the DEMO_MODE/PACKAGES_ENABLED
// class); default true is upstream's (modules/setting/oauth2.go:104).
// W4's var plumbing reuses THIS helper; the API dispatch reads it at
// services/auth/oauth2.go:32-34's position.
// ---------------------------------------------------------------------------

export function oauth2FeatureEnabled(env: { OAUTH2_ENABLED?: string }): boolean {
  return env.OAUTH2_ENABLED !== "false";
}

// ---------------------------------------------------------------------------
// Grant-scope normalization (§2.5) — access_token.go:78-134 verbatim.
// ---------------------------------------------------------------------------

/** A `users` row (orgs ARE user rows in this model — the schema note). */
export type OAuth2UserRow = typeof users.$inferSelect;

/** GeneralScopesSupported (access_token.go:78-85). */
export const GENERAL_SCOPES_SUPPORTED = ["openid", "profile", "email", "groups"] as const;

/**
 * splitGrantScopes (access_token.go:87-119): the space-separated grant scope
 * mixes OIDC general scopes (kept verbatim, in first-appearance order) with
 * comma-joinable access words run through the landed scope normalizer
 * (invalid words DROPPED silently — the err == nil filter). No access word
 * at all ⇒ "" (the caller decides the legacy default); access words that
 * all normalize away collapse to `no-token-scope`, deliberately NOT all
 * (:110-118 — a garbage scope must never accidentally grant everything).
 */
export function splitGrantScopes(grantScopes: string): { generalScopes: string[]; accessScope: string } {
  const generalScopes: string[] = [];
  const accessScopes: string[] = [];
  let hasAccessScopes = false;
  for (const scope of grantScopes.split(" ")) {
    if (scope === "") continue;
    if ((GENERAL_SCOPES_SUPPORTED as readonly string[]).includes(scope)) {
      generalScopes.push(scope);
      continue;
    }
    hasAccessScopes = true;
    for (const accessWord of scope.split(",")) {
      try {
        const normalized = normalizeAccessTokenScope(accessWord);
        for (const part of normalized.split(",")) {
          if (part !== "") accessScopes.push(part);
        }
      } catch {
        // upstream: `if normalizedScope, err := ...Normalize(); err == nil` —
        // an invalid word is dropped, never fatal (access_token.go:101-103).
      }
    }
  }
  if (!hasAccessScopes) {
    return { generalScopes, accessScope: "" };
  }
  // an unparseable joined set stays "" — the no-token-scope guard below
  // (access_token.go:114-118, the error-ignoring `_` assignment upstream)
  let accessScope: string;
  try {
    accessScope = normalizeAccessTokenScope(accessScopes.join(","));
  } catch {
    accessScope = "";
  }
  return { generalScopes, accessScope: accessScope === "" ? "no-token-scope" : accessScope };
}

/**
 * NormalizeGrantScope (access_token.go:122-125): the grant scope string as
 * stored — general scopes verbatim + the normalized access scope, joined by
 * single spaces. userinfo/introspection report THIS form.
 */
export function normalizeGrantScope(grantScopes: string): string {
  const { generalScopes, accessScope } = splitGrantScopes(grantScopes);
  const accessParts = accessScope === "" ? [] : [accessScope];
  return [...generalScopes, ...accessParts].join(" ");
}

/**
 * GrantAdditionalScopes (access_token.go:128-134): the API authority of a
 * grant as a comma-joined scope string. Grants WITHOUT an access-scope word
 * retain the legacy default `all` ("grants without access scopes retain the
 * legacy default", :127-134 — since 1.22); an all-invalid set stays
 * `no-token-scope`. The string feeds ScopeSet.parseLenient on the auth side.
 */
export function grantAdditionalScopes(grantScopes: string): string {
  const { accessScope } = splitGrantScopes(grantScopes);
  if (accessScope === "") {
    return "all"; // grants without access scopes retain the legacy default
  }
  return accessScope;
}

// ---------------------------------------------------------------------------
// The issuer (access_token.go:136-152)
// ---------------------------------------------------------------------------

/**
 * Upstream `setting.AppURL` equivalent — the `APP_URL` var (webhooks-push
 * posture) else the request origin, in the AppURL shape (trailing slash).
 * Reused by the issuer (which strips it again) and the userinfo picture /
 * id_token profile URLs.
 */
export function oauth2AppUrl(envAppUrl: string | undefined, requestOrigin: string): string {
  const raw = envAppUrl === undefined || envAppUrl.trim() === "" ? requestOrigin : envAppUrl.trim();
  return `${raw.replace(/\/+$/, "")}/`;
}

/**
 * NewJwtRegisteredClaimsFromUser's issuer half (access_token.go:142-145):
 * `[oauth2] JWT_CLAIM_ISSUER` or the AppURL minus the trailing slash —
 * identical to the discovery issuer (openid-connect-discovery §4; the SPEC
 * §2.4 cite). The `OAUTH2_JWT_CLAIM_ISSUER` var's reader lives HERE so W4's
 * plumbing and the introspection/id_token builders share one source.
 */
export function oauth2Issuer(
  env: { OAUTH2_JWT_CLAIM_ISSUER?: string; APP_URL?: string },
  requestOrigin: string,
): string {
  const configured = env.OAUTH2_JWT_CLAIM_ISSUER;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return oauth2AppUrl(env.APP_URL, requestOrigin).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// PKCE (models/auth/oauth2.go:448-482)
// ---------------------------------------------------------------------------

/**
 * S256ChallengeFromVerifier (golang.org/x/oauth2): BASE64URL-ENCODE(
 * SHA256(ASCII(verifier))) — raw url encoding, NO padding (RFC 7636 §4.2).
 * The fixed appendix-B vector is pinned in-suite.
 */
export async function s256ChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bin = String.fromCharCode(...new Uint8Array(digest));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * deriveCodeChallenge (oauth2.go:452-467): S256 and plain only; an unknown
 * stored method fails (false), which fails validation below.
 */
export async function deriveCodeChallenge(method: string, verifier: string): Promise<string | null> {
  if (method === "S256") {
    return await s256ChallengeFromVerifier(verifier);
  }
  if (method === "plain") {
    return verifier;
  }
  return null;
}

/**
 * ValidateCodeChallenge (oauth2.go:470-482): a code without a challenge
 * accepts ANY verifier (requiresCodeVerifier — method and challenge both
 * empty); a challenged code requires a non-empty verifier AND a stored
 * method; comparison is constant-time.
 */
export async function validateCodeChallenge(code: OAuth2AuthorizationCodeRow, verifier: string): Promise<boolean> {
  const requiresVerifier = code.codeChallengeMethod !== "" || code.codeChallenge !== "";
  if (!requiresVerifier) {
    return true;
  }
  if (verifier === "" || code.codeChallengeMethod === "") {
    return false;
  }
  const expected = await deriveCodeChallenge(code.codeChallengeMethod, verifier);
  if (expected === null) {
    return false;
  }
  return constantTimeEquals(expected, code.codeChallenge);
}

/** Go subtle.ConstantTimeCompare's JS twin over ASCII strings. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The signing-material seam over keys.ts (the routes' + dispatch's single
// entry: load-or-create the instance key and import the CryptoKeys).
// ---------------------------------------------------------------------------

export interface OAuth2SigningMaterial {
  alg: JwsAlgorithm;
  ref: OAuth2SigningKeyRef;
  /** The key that signs/verifies ACCESS + REFRESH tokens (the server key). */
  serverSignKey: CryptoKey;
  serverVerifyKey: CryptoKey;
  /** kid — stamped into token headers ONLY for asymmetric keys (the HMAC
   *  PreProcessToken is a no-op, jwtsigningkey.go:69-74). */
  kid?: string;
}

export async function loadOAuth2SigningMaterial(db: D1Database, configuredAlgorithm?: string): Promise<OAuth2SigningMaterial> {
  const ref = await loadOAuth2SigningKey(db, configuredAlgorithm);
  const alg = ref.alg;
  if (ref.kind === "symmetric") {
    return {
      alg,
      ref,
      serverSignKey: await importSigningKey(alg, ref.secretHex),
      serverVerifyKey: await importVerifyKey(alg, ref.secretHex),
    };
  }
  return {
    alg,
    ref,
    serverSignKey: await importSigningKey(alg, ref.privateJwk),
    serverVerifyKey: await importVerifyKey(alg, ref.publicJwk),
    kid: ref.kid,
  };
}

/**
 * The id_token's CLIENT key (§2.4): asymmetric algs sign with the SERVER
 * key; the HS family signs with the CLIENT SECRET as the HMAC key
 * (oauth2_provider.go:539-551 — CreateJWTSigningKey(serverAlg,
 * []byte(clientSecret))). A client key that cannot import (workerd rejects
 * empty HMAC material — upstream signs a degenerate empty-key HMAC there)
 * THROWS: the route maps it to upstream's own create-key failure arm,
 * invalid_request "Error creating signing key" (:543-551). Recorded in the
 * SPEC as-built (RS256 default unaffected).
 */
export async function importClientKey(
  material: OAuth2SigningMaterial,
  clientSecret: string,
): Promise<{ key: CryptoKey; kid?: string }> {
  if (!isSymmetricAlgorithm(material.alg)) {
    return { key: material.serverSignKey, kid: material.kid };
  }
  return { key: await importSigningKey(material.alg, clientSecret) };
}

// ---------------------------------------------------------------------------
// The token trio mint (access_token.go:154-275)
// ---------------------------------------------------------------------------

/** The RFC 6749 §5.2 error (access_token.go:47-50) — member order pinned. */
export interface AccessTokenErrorShape {
  error: string;
  error_description: string;
}

/** The RFC 6749 §5.2 error codes (access_token.go:30-42). */
export const ACCESS_TOKEN_ERROR_CODES = {
  invalidRequest: "invalid_request",
  invalidClient: "invalid_client",
  invalidGrant: "invalid_grant",
  unauthorizedClient: "unauthorized_client",
  unsupportedGrantType: "unsupported_grant_type",
  invalidScope: "invalid_scope",
} as const;

export function accessTokenError(error: keyof typeof ACCESS_TOKEN_ERROR_CODES, description: string): AccessTokenErrorShape {
  return { error: ACCESS_TOKEN_ERROR_CODES[error], error_description: description };
}

export type AccessTokenResponseOrError = { ok: true; response: Record<string, unknown> } | { ok: false; error: AccessTokenErrorShape };

export interface MintTokenTrioInput {
  /** The D1 handle — the rotation arm re-reads the grant's counter through
   *  it (request state passed explicitly; no module-level handles). */
  db: D1Database;
  grant: OAuth2GrantRow;
  /** The application row — loaded only when the grant scope carries openid
   *  (NewAccessTokenResponse's GetOAuth2ApplicationByID arm). */
  application: OAuth2ApplicationRow;
  /** The subject user row (GetUserByID's arm, :208). */
  user: OAuth2UserRow;
  material: OAuth2SigningMaterial;
  /** The id_token's HMAC key when the deployment alg is symmetric (the
   *  client secret). RS/ES deployments pass the server key via `material`. */
  clientKey?: { key: CryptoKey; kid?: string };
  /** The issuer string (oauth2Issuer). */
  issuer: string;
  /** URL base for the profile/picture claims (the AppURL shape, trailing
   *  slash). */
  appUrl: string;
  now: Date;
  /** The InvalidateRefreshTokens posture — upstream default FALSE (the
   *  no-default-rotation trap, module header). */
  invalidateRefreshTokens?: boolean;
}

/**
 * NewAccessTokenResponse (access_token.go:154-275): the signed trio plus
 * the response envelope. Member order per the module header.
 */
export async function mintTokenTrio(input: MintTokenTrioInput): Promise<AccessTokenResponseOrError> {
  const { grant, application, user, material, issuer, appUrl, now } = input;
  const invalidateRefreshTokens = input.invalidateRefreshTokens ?? false;
  const nowSec = Math.floor(now.getTime() / 1000);

  if (invalidateRefreshTokens) {
    // grant.IncreaseCounter (oauth2.go:545-559) via the landed
    // compare-and-increment; a stale counter is the stolen-token signal.
    try {
      await increaseCounterForRotation(input.db, grant);
    } catch {
      return { ok: false, error: accessTokenError("invalidGrant", "cannot increase the grant counter") };
    }
  }

  const accessExpiration = nowSec + ACCESS_TOKEN_EXPIRATION_SECONDS;
  const refreshExpiration = nowSec + REFRESH_TOKEN_EXPIRATION_SECONDS;

  const accessToken = await signJws({
    alg: material.alg,
    key: material.serverSignKey,
    // Token{GrantID, Kind, RegisteredClaims} — member order gnt, tt, exp,
    // iat (the zero counter omits, iat stamped by SignToken, token.go:60).
    claims: { gnt: grant.id, tt: KIND_ACCESS_TOKEN, exp: accessExpiration },
    kid: material.kid,
    nowSec,
  });
  const refreshToken = await signJws({
    alg: material.alg,
    key: material.serverSignKey,
    // cnt rides (omitempty keeps it when non-zero — grant.Counter is ≥ 1).
    claims: { gnt: grant.id, tt: KIND_REFRESH_TOKEN, cnt: grant.counter, exp: refreshExpiration },
    kid: material.kid,
    nowSec,
  });

  let signedIdToken = "";
  if (grantScopeContains(grant.scope, "openid")) {
    const idToken = await buildIdTokenClaims({
      db: input.db,
      grant,
      application,
      user,
      issuer,
      appUrl,
      exp: accessExpiration,
      nowSec,
    });
    const client = input.clientKey ?? { key: material.serverSignKey, kid: material.kid };
    try {
      signedIdToken = await signJws({ alg: material.alg, key: client.key, claims: idToken.claims, kid: client.kid, nowSec });
    } catch {
      return { ok: false, error: accessTokenError("invalidRequest", "cannot sign token") };
    }
  }

  // AccessTokenResponse member order (access_token.go:69-76): id_token and
  // scope are omitempty — omitted when empty.
  const response: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_EXPIRATION_SECONDS,
    refresh_token: refreshToken,
  };
  if (signedIdToken !== "") {
    response.id_token = signedIdToken;
  }
  const scope = normalizeGrantScope(grant.scope);
  if (scope !== "") {
    response.scope = scope;
  }
  return { ok: true, response };
}

/** The rotation half under InvalidateRefreshTokens — the landed CAS
 *  (increaseGrantCounter) re-read afterward so the minted `cnt` carries the
 *  MOVED counter (upstream mutates the struct in place, oauth2.go:545-559).
 */
async function increaseCounterForRotation(db: D1Database, grant: OAuth2GrantRow): Promise<void> {
  await increaseGrantCounter(db, grant.id, grant.counter);
  const updated = await getGrantByID(db, grant.id);
  if (updated !== null) {
    grant.counter = updated.counter;
  }
}

/**
 * OIDCToken claims (token.go:67-86 + access_token.go:223-256) — member
 * order per the module header. All omitempty members are OMITTED when
 * empty; email_verified appears ONLY when true (Go bool omitempty).
 */
export async function buildIdTokenClaims(input: {
  db: D1Database;
  grant: OAuth2GrantRow;
  application: OAuth2ApplicationRow;
  user: OAuth2UserRow;
  issuer: string;
  appUrl: string;
  exp: number;
  nowSec: number;
}): Promise<{ claims: Record<string, unknown> }> {
  const { grant, application, user, issuer, appUrl } = input;
  const claims: Record<string, unknown> = {
    iss: issuer,
    sub: String(user.id),
    aud: [application.clientId],
    exp: input.exp,
    // iat rides here (the embedded RegisteredClaims position — SignToken's
    // stamp lands between exp and nonce in the marshal).
    iat: input.nowSec,
  };
  if (grant.nonce !== "") {
    claims.nonce = grant.nonce;
  }
  if (grantScopeContains(grant.scope, "profile")) {
    if (displayNameOf(user) !== "") claims.name = displayNameOf(user);
    claims.preferred_username = user.username;
    claims.profile = `${appUrl}${user.username}`;
    claims.picture = `${appUrl}avatars/${user.usernameLower}`;
    if ((user.website ?? "") !== "") claims.website = user.website;
    const language = await languageOf(input.db, user.id);
    if (language !== "") claims.locale = language;
    // updated_at (user.UpdatedUnix, omitempty): the users table carries no
    // updated stamp in cf-gitea's model — the zero stamp omits, upstream's
    // omitempty does the same for never-touched rows. Recorded adaptation.
  }
  if (grantScopeContains(grant.scope, "email")) {
    const email = user.email ?? "";
    if (email !== "") claims.email = email;
    if (user.status === "active") claims.email_verified = true;
  }
  if (grantScopeContains(grant.scope, "groups")) {
    const onlyPublicGroups = includesPublicOnly(grant.scope);
    const groups = await getOAuthGroupsForUser(input.db, user.id, onlyPublicGroups);
    if (groups !== null) {
      claims.groups = groups;
    }
  }
  return { claims };
}

/** The `public-only` bit of a grant's access scope (the
 *  `accessTokenScope.PublicOnly()` arm, access_token.go:245). */
function includesPublicOnly(grantScope: string): boolean {
  return grantAdditionalScopes(grantScope)
    .split(",")
    .some((word) => word === "public-only");
}

/** DisplayName (user.go:524-532): the full name when set, else the login. */
function displayNameOf(user: OAuth2UserRow): string {
  const fullName = user.displayName ?? "";
  return fullName !== "" ? fullName : user.username;
}

/** The `Language` preference — the landed user_settings side row (the five
 *  upstream preference columns; the default "" omits the locale claim). */
async function languageOf(db: D1Database, userId: number): Promise<string> {
  const row = await drizzle(db).select({ language: userSettings.language }).from(userSettings).where(eq(userSettings.userId, userId)).get();
  return row?.language ?? "";
}

// ---------------------------------------------------------------------------
// GetOAuthGroupsForUser (access_token.go:278-302)
// ---------------------------------------------------------------------------

/**
 * GetOAuthGroupsForUser (access_token.go:278-302): "org" and "org:team"
 * strings for the user. Orgs are the user's org_user memberships joined to
 * their org rows (FindOrgOptions, org_list.go:65-72): public-only mode
 * requires is_public membership AND a public org; the private mode includes
 * every membership at any org visibility. Ordered lower_name ASC (ToOrders).
 * Teams are ALL the org's teams (OrgList.LoadTeams) filtered to the user's
 * membership (team.IsMember), emitted `org.Name + ":" + team.LowerName` in
 * row order. Nil stays NIL — the caller's JSON renders `null` for a
 * user in no orgs (FormatNilSliceAsNull).
 */
export async function getOAuthGroupsForUser(db: D1Database, userId: number, onlyPublicGroups: boolean): Promise<string[] | null> {
  const d1 = drizzle(db);
  const membershipFilters = onlyPublicGroups
    ? and(eq(orgMembers.userId, userId), eq(orgMembers.isPublic, true), eq(users.type, "org"), eq(users.visibility, "public"))
    : and(eq(orgMembers.userId, userId), eq(users.type, "org"));
  const orgs = await d1
    .select({ id: users.id, username: users.username, usernameLower: users.usernameLower })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.orgId))
    .where(membershipFilters)
    .orderBy(users.usernameLower)
    .all();
  if (orgs.length === 0) {
    return null;
  }
  const orgTeams = await d1
    .select({ id: teams.id, orgId: teams.orgId, lowerName: teams.lowerName })
    .from(teams)
    .where(
      inArray(
        teams.orgId,
        orgs.map((org) => org.id),
      ),
    )
    .orderBy(teams.id)
    .all();
  const teamIds = orgTeams.map((team) => team.id);
  const memberships =
    teamIds.length === 0
      ? []
      : await d1
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds)))
          .all();
  const memberTeamIds = new Set(memberships.map((row) => row.teamId));

  const groups: string[] = [];
  for (const org of orgs) {
    groups.push(org.username);
    for (const team of orgTeams) {
      if (team.orgId === org.id && memberTeamIds.has(team.id)) {
        groups.push(`${org.username}:${team.lowerName}`);
      }
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The userinfo response (oauth2_provider.go:86-132)
// ---------------------------------------------------------------------------

/**
 * userInfoResponse (oauth2_provider.go:86-93) — member order sub, name,
 * preferred_username, email, picture, groups; groups is null when the user
 * is in no orgs (the pin's nil-slice-as-null JSON). The caller supplies the
 * resolved doer row and the public-only bit (IsPublicOnlyDoer — the
 * resolved scope's restriction).
 */
export async function buildUserInfoResponse(
  db: D1Database,
  user: OAuth2UserRow,
  options: { appUrl: string; onlyPublicGroups: boolean },
): Promise<Record<string, unknown>> {
  const groups = await getOAuthGroupsForUser(db, user.id, options.onlyPublicGroups);
  return {
    sub: String(user.id),
    name: displayNameOf(user),
    preferred_username: user.username,
    email: user.email ?? "",
    picture: `${options.appUrl}avatars/${user.usernameLower}`,
    groups,
  };
}

// ---------------------------------------------------------------------------
// The application lookup (GetOAuth2ApplicationByClientID, oauth2.go:261-268)
// ---------------------------------------------------------------------------

export type OAuth2AppRow = typeof oauth2Applications.$inferSelect;

/** GetOAuth2ApplicationByClientID (oauth2.go:261-268): null on miss (the
 *  caller renders upstream's ErrOAuthClientIDInvalid arms). */
export async function getOAuth2ApplicationByClientID(db: D1Database, clientId: string): Promise<OAuth2AppRow | null> {
  const row = await drizzle(db).select().from(oauth2Applications).where(eq(oauth2Applications.clientId, clientId)).get();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The API auth-method resolution (services/auth/oauth2.go:30-58)
// ---------------------------------------------------------------------------

export interface ResolvedOAuth2Credential {
  user: OAuth2UserRow;
  grant: OAuth2GrantRow;
  /** GrantAdditionalScopes(grant.Scope) — the API authority string. */
  scope: string;
  grantId: number;
}

/**
 * GetOAuthAccessTokenScopeAndUserID's port (:30-58), returning the full
 * resolution the middleware needs. Order verbatim: the enabled gate, the
 * "." shape gate, ParseToken (verifyJws — the alg pin + golang-jwt default
 * claim validator), the grant lookup, the KIND check (a refresh token is
 * NOT an access credential), the STRICT time bounds (assertApiTimeBounds —
 * exp >= now && iat <= now, zero leeway), then the scope. Any failure
 * answers null (the caller's 401).
 *
 * NOTE the actions-JWT arm of upstream's dotted dispatch
 * (services/auth/oauth2.go:113-119) is NOT ported — cf-gitea's API has no
 * Actions-user identity (the runner protocol carries its own gate); recorded
 * alongside the query-param divergence (SPEC §2.7 / §4.16).
 */
export async function resolveOAuth2AccessTokenCredential(
  db: D1Database,
  accessToken: string,
  options: {
    enabled: boolean;
    configuredAlgorithm?: string;
    now: Date;
  },
): Promise<ResolvedOAuth2Credential | null> {
  if (!options.enabled) {
    return null;
  }
  // JWT tokens require a ".", if the token isn't like that, return early.
  if (!accessToken.includes(".")) {
    return null;
  }
  const material = await loadOAuth2SigningMaterial(db, options.configuredAlgorithm);
  const nowSec = Math.floor(options.now.getTime() / 1000);
  let claims: Record<string, unknown>;
  try {
    const verified = await verifyJws({ alg: material.alg, key: material.serverVerifyKey, token: accessToken, nowSec });
    claims = verified.claims;
  } catch {
    return null;
  }
  const grantId = typeof claims.gnt === "number" ? claims.gnt : Number.NaN;
  if (!Number.isInteger(grantId)) {
    return null;
  }
  const grant = await getGrantByID(db, grantId);
  if (grant === null) {
    return null;
  }
  if (claims.tt !== KIND_ACCESS_TOKEN) {
    return null;
  }
  try {
    assertApiTimeBounds(claims, nowSec);
  } catch {
    return null;
  }
  const user = await drizzle(db).select().from(users).where(eq(users.id, grant.userId)).get();
  if (user === undefined || user.type !== "user") {
    // the doer must be an individual (userFromToken's IsIndividual gate,
    // services/auth/oauth2.go:122-124)
    return null;
  }
  return { user, grant, scope: grantAdditionalScopes(grant.scope), grantId: grant.id };
}
