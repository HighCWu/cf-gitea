/**
 * The OIDC provider client — the `openidConnect` arm of the login-source
 * client seam (specs/external-auth-sources.md §5.1). Stateless: every
 * request rebuilds the client from the source row's cfg record, exactly the
 * consequence upstream avoids with its process-lifetime goth provider
 * objects (`CreateGothProvider`, providers_openid.go:36-59 — upstream
 * constructs ONCE at source registration and the construction itself
 * fetches + parses the discovery document, so a bad discovery URL fails the
 * source eagerly, :53-58). We cannot keep process-lifetime objects (AGENTS
 * Workers rules — any isolate serves any leg, SPEC §7.9), so the discovery
 * document is fetched per use and MEMOIZED against the source row's
 * `updatedAt` freshness hint (SPEC §5.3.1): a cached document survives
 * while the row is unedited and is re-fetched on a row edit, a non-2xx, or
 * an issuer mismatch. The same memo key covers the JWKS (§5.4).
 *
 * ## Wire parity (upstream = goth v1.82.0's openidConnect provider — an
 * EXTERNAL module, not in the gitea tree; cited "goth v1.82.0
 * providers/openidConnect" per W1's precedent for github's URL values)
 *
 *   - Discovery URL join: a URL already ending in
 *     `.well-known/openid-configuration` is used verbatim; anything else
 *     gains the `/.well-known/openid-configuration` suffix (goth's
 *     `New()`; the pin's own fake-IdP test serves the document at
 *     `srv.URL + "/.well-known/openid-configuration"` —
 *     tests/integration/auth_oauth2_test.go:289).
 *   - Authorize redirect: `response_type=code`, `client_id`,
 *     `redirect_uri`, scope (space-joined), `state`, `nonce` — goth's
 *     `GetAuthURL` (source_callout.go:15-31 issues the 307 — our route
 *     layer answers 303, the house redirect default, session.ts seeOther).
 *   - Code exchange: POST {token_endpoint},
 *     application/x-www-form-urlencoded, grant_type=authorization_code +
 *     code + redirect_uri + client_id + client_secret (goth's FetchUser;
 *     SPEC §5.3.3 — no PKCE in v1, the recorded follow-up).
 *   - id_token verification: the landed JWS substrate
 *     (`services/oauth2/jws.ts`) — `verifyJws`/`importVerifyKey` with the
 *     JWKS fetched from the discovery document's `jwks_uri` and `kid`- or
 *     single-key-matched. THIS is the verifier goth historically lacks
 *     (the pin's own fake IdP signs `alg:none` tokens because goth
 *     base64-decodes the payload without checking the signature —
 *     auth_oauth2_test.go:305-315's comment); §5.4 makes real verification
 *     the recorded hardening, and `alg:none` REJECTED here is deliberate.
 *   - Claims checked (SPEC §5.4): `iss` == the discovery `issuer` (exact
 *     string), `aud` contains the source's client_id, `exp`/`iat` strict
 *     with zero leeway (`assertApiTimeBounds` semantics over the verifier's
 *     own exp/nbf gate — upstream's API path runs the same two-gate shape),
 *     `nonce` == the parked value. Subject: `sub`, or the admin's
 *     `externalIdClaim` single-claim override (providers_openid.go:55-59).
 *   - Identity extraction from the verified claims: email, name,
 *     given_name/family_name, preferred_username|nickname, picture — the
 *     standard-claim set goth maps onto its User struct.
 *
 * The github/gplus client modules (SPEC §9 W3, landed:
 * `github-client.ts`/`gplus-client.ts`) hang off the same
 * `resolveOAuth2Client` seam — the union below carries their kinds; the
 * rest of the lattice answers the recorded not-implemented status.
 */

import { assertApiTimeBounds, importVerifyKey, verifyJws, type JwsAlgorithm, type JwsHeader } from "../oauth2/jws";
import { parseOAuth2SourceConfig, type OAuth2SourceConfig } from "./cfg";

/** The outbound fetch seam (SPEC §8 — the mirror gitclient pattern): the
 *  stub IdP in tests, global fetch in production. */
export type FetchImpl = typeof fetch;

/** One JWKS key entry — the wire members plus `kid` (workerd's JsonWebKey
 *  interface omits it; the JOSE key selection needs it). */
export interface JwksKey extends JsonWebKey {
  kid?: string;
}

/** A fetched+parsed discovery document — the fields the client consumes. */
export interface OidcDiscovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** A parsed, verified id_token's identity slice (SPEC §4.4's bounded
 *  profile fields — the only claims the flow carries forward). */
export interface OidcIdentity {
  externalId: string;
  email: string | null;
  name: string | null;
  nickName: string | null;
  avatarUrl: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** A verification failure with a stable machine-readable code (the route
 *  layer maps every code to the same user-facing failure arm — upstream's
 *  errCallback default — but tests and logs key on the code). */
export class OidcVerifyError extends Error {
  constructor(
    public readonly code:
      | "discovery-fetch"
      | "discovery-shape"
      | "issuer-mismatch"
      | "jwks-fetch"
      | "jwks-key-miss"
      | "token-fetch"
      | "token-shape"
      | "id-token-missing"
      | "alg-unsupported"
      | "signature"
      | "claims"
      | "nonce"
      | "external-id-missing",
    message: string,
  ) {
    super(message);
    this.name = "OidcVerifyError";
  }
}

// ---------------------------------------------------------------------------
// The discovery fetch + memo (SPEC §5.3.1's freshness-hint cache)
// ---------------------------------------------------------------------------

/** goth's join rule: verbatim when already the well-known path (goth v1.82.0
 *  providers/openidConnect New). */
export function discoveryDocumentUrl(discoveryUrl: string): string {
  const WK = ".well-known/openid-configuration";
  if (discoveryUrl.endsWith(WK)) return discoveryUrl;
  return discoveryUrl.replace(/\/+$/, "") + "/" + WK;
}

interface DiscoveryCacheEntry {
  /** The exact cache key — source id + the row's updatedAt instant, so a
   *  cfg edit (including the discovery URL itself) invalidates naturally. */
  key: string;
  document: OidcDiscovery;
  /** The raw JWKS document memoized under the same key — the verify arm
   *  needs it microseconds after the discovery read. */
  jwks: { keys: JwksKey[] } | null;
}

/** Module-level memo — a read-through fetch cache keyed by
 *  (sourceId, updatedAt), never request state (keys are immutable per row
 *  version; the keys.ts signing-key caches are the house precedent,
 *  `resetOAuth2KeyCachesForTests`). Any isolate may hold a stale document
 *  only while the ROW is unchanged — the freshness hint is the row itself. */
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/** Test seam — clears the memo (keys.ts's reset idiom). */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}

function parseDiscoveryDocument(raw: unknown): OidcDiscovery {
  if (typeof raw !== "object" || raw === null) {
    throw new OidcVerifyError("discovery-shape", "discovery document is not a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[field] !== "string" || doc[field].length === 0) {
      throw new OidcVerifyError("discovery-shape", `discovery document is missing ${field}`);
    }
  }
  return {
    issuer: doc.issuer as string,
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
    jwksUri: doc.jwks_uri as string,
  };
}

/**
 * Fetch (or memo-hit) the discovery document for a source row. `rowKey`
 * binds the memo to the row's (id, updatedAt) pair; any caller holding the
 * same pair shares the isolate's copy. Network failure (non-2xx) and shape
 * failure throw `OidcVerifyError` with `discovery-fetch`/`discovery-shape`.
 */
export async function fetchOidcDiscovery(
  fetchImpl: typeof fetch,
  rowKey: string,
  discoveryUrl: string,
): Promise<{ document: OidcDiscovery; entry: DiscoveryCacheEntry }> {
  const cached = discoveryCache.get(rowKey);
  if (cached) return { document: cached.document, entry: cached };

  let response: Response;
  try {
    response = await fetchImpl(discoveryDocumentUrl(discoveryUrl), { redirect: "follow" });
  } catch (error) {
    throw new OidcVerifyError("discovery-fetch", `discovery document fetch failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new OidcVerifyError("discovery-fetch", `discovery document fetch answered ${String(response.status)}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new OidcVerifyError("discovery-shape", "discovery document is not valid JSON");
  }
  const document = parseDiscoveryDocument(raw);
  const entry: DiscoveryCacheEntry = { key: rowKey, document, jwks: null };
  discoveryCache.set(rowKey, entry);
  return { document, entry };
}

// ---------------------------------------------------------------------------
// The authorize redirect (SPEC §5.3.1 — goth GetAuthURL's parameter set)
// ---------------------------------------------------------------------------

/**
 * The provider authorize URL for a dance. `state`/`nonce` are the two
 * UUIDs the route layer generated; `scopes` defaults to the standard OIDC
 * set upstream uses when neither the setting nor the source config names
 * any (`OpenIDConnectScopes` default empty + source.Scopes empty ⇒ goth
 * sends… its provider default `openid` — goth appends "openid" when no
 * scope was configured). We mirror: `scopes` empty ⇒ ["openid"].
 */
export function buildOidcAuthorizeUrl(
  document: OidcDiscovery,
  cfg: OAuth2SourceConfig,
  redirectUri: string,
  state: string,
  nonce: string,
): string {
  const scopes = cfg.scopes !== undefined && cfg.scopes.length > 0 ? cfg.scopes : ["openid"];
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    nonce,
  });
  const joiner = document.authorizationEndpoint.includes("?") ? "&" : "?";
  return `${document.authorizationEndpoint}${joiner}${params.toString()}`;
}

// ---------------------------------------------------------------------------
// The code exchange + id_token verify (SPEC §5.3.3/§5.4)
// ---------------------------------------------------------------------------

export interface OidcExchangeResult {
  identity: OidcIdentity;
  /** The verified header — surfaced for tests/audit. */
  header: JwsHeader;
}

const ID_TOKEN_ALGS: readonly JwsAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "HS256",
  "HS384",
  "HS512",
];

async function fetchJwks(
  fetchImpl: typeof fetch,
  entry: DiscoveryCacheEntry,
  jwksUri: string,
): Promise<{ keys: JwksKey[] }> {
  if (entry.jwks !== null) return entry.jwks;
  let response: Response;
  try {
    response = await fetchImpl(jwksUri, { redirect: "follow" });
  } catch (error) {
    throw new OidcVerifyError("jwks-fetch", `jwks fetch failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new OidcVerifyError("jwks-fetch", `jwks fetch answered ${String(response.status)}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new OidcVerifyError("jwks-fetch", "jwks document is not valid JSON");
  }
  const keys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new OidcVerifyError("jwks-fetch", "jwks document carries no keys array");
  }
  const entries: JwksKey[] = [];
  for (const key of keys) {
    if (typeof key !== "object" || key === null || Array.isArray(key)) {
      throw new OidcVerifyError("jwks-fetch", "jwks key entry is not an object");
    }
    entries.push(key as JwksKey);
  }
  entry.jwks = { keys: entries };
  return entry.jwks;
}

/** kid- or single-key-match (SPEC §5.4: `kid`-matched against the token
 *  header; a keyless JWKS with exactly one key matches when the header
 *  carries no kid — the single-IdP-key deployment shape). */
function selectJwk(keys: JwksKey[], header: JwsHeader): JwksKey | null {
  const headerKid = header.kid;
  if (headerKid !== undefined) {
    return keys.find((k) => k.kid === headerKid) ?? null;
  }
  const usable = keys.filter((k) => k.kid === undefined || keys.length === 1);
  if (usable.length === 1) return usable[0]!;
  return null;
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The verified-claims → identity slice (the standard claim set goth maps
 *  onto goth.User; the bounded fields of SPEC §4.4). */
function identityFromClaims(claims: Record<string, unknown>, externalIdClaim?: string): OidcIdentity {
  // The subject: `sub`, or the admin's single-claim override
  // (providers_openid.go:55-59 — "the admin explicitly chooses one claim
  // (e.g. `oid` for Azure AD)"; goth's UserIdClaims fallback list, here a
  // single entry).
  const override = externalIdClaim !== undefined ? claimString(claims, externalIdClaim) : null;
  const externalId = override ?? claimString(claims, "sub");
  if (externalId === null) {
    throw new OidcVerifyError(
      "external-id-missing",
      externalIdClaim !== undefined
        ? `id_token carries neither ${externalIdClaim} nor sub`
        : "id_token carries no sub claim",
    );
  }
  return {
    externalId,
    email: claimString(claims, "email"),
    name: claimString(claims, "name"),
    nickName: claimString(claims, "preferred_username") ?? claimString(claims, "nickname"),
    avatarUrl: claimString(claims, "picture"),
    firstName: claimString(claims, "given_name"),
    lastName: claimString(claims, "family_name"),
  };
}

/**
 * Exchange the authorization code and verify the id_token — the callback
 * leg's identity resolution (SPEC §5.3.3 + §5.4). `discovery` comes from
 * `fetchOidcDiscovery` (the route layer holds the source row, so the
 * freshness hint rides the same call); `expectedNonce` is the parked
 * dance nonce (undefined only for provider arms that never mint one).
 *
 * Every failure mode of the matrix (SPEC §8 "Flow") throws
 * `OidcVerifyError` with its code: wrong iss, wrong aud, expired,
 * iat-in-future, nonce mismatch, kid miss, alg confusion (`none`,
 * HS-with-public-key — `importVerifyKey` refuses a JWK where the alg
 * family wants the raw secret), tampered signature.
 */
export async function exchangeOidcCode(options: {
  fetchImpl: typeof fetch;
  document: OidcDiscovery;
  entry: DiscoveryCacheEntry;
  cfg: OAuth2SourceConfig;
  redirectUri: string;
  code: string;
  expectedNonce: string | undefined;
  nowSec?: number;
}): Promise<OidcExchangeResult> {
  const { fetchImpl, document, entry, cfg } = options;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);

  // -- the exchange (goth's FetchUser POST; SPEC §5.3.3) --------------------
  let response: Response;
  try {
    response = await fetchImpl(document.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: options.code,
        redirect_uri: options.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
  } catch (error) {
    throw new OidcVerifyError("token-fetch", `token endpoint fetch failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new OidcVerifyError("token-fetch", `token endpoint answered ${String(response.status)}`);
  }
  let tokenPayload: unknown;
  try {
    tokenPayload = await response.json();
  } catch {
    throw new OidcVerifyError("token-shape", "token endpoint response is not valid JSON");
  }
  const idToken = (tokenPayload as Record<string, unknown>).id_token;
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new OidcVerifyError("id-token-missing", "token endpoint response carries no id_token");
  }

  // -- the header pre-read (the alg pin + kid, before any key work) ---------
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new OidcVerifyError("signature", "id_token is not a compact JWS");
  }
  let header: JwsHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecodeJson(parts[0]!))) as JwsHeader;
  } catch {
    throw new OidcVerifyError("signature", "id_token header is not valid JSON");
  }
  // `none` and any non-table alg die HERE (no key fetch, no verify) — the
  // pin's fake IdP's alg:none tokens are exactly the rejected shape (SPEC
  // §5.4's "no `none`" + the landed alg table, provider SPEC §4.10).
  const alg = ID_TOKEN_ALGS.find((candidate) => candidate === header.alg);
  if (alg === undefined) {
    throw new OidcVerifyError("alg-unsupported", `id_token alg ${JSON.stringify(header.alg)} is not supported`);
  }

  // -- the key (JWKS from the discovery document, kid-matched) --------------
  const jwks = await fetchJwks(fetchImpl, entry, document.jwksUri);
  const jwk = selectJwk(jwks.keys, header);
  if (jwk === null) {
    throw new OidcVerifyError("jwks-key-miss", "no JWKS key matches the id_token header");
  }
  let key: CryptoKey;
  try {
    key = await importVerifyKey(alg, alg.startsWith("HS") ? cfg.clientSecret : jwk);
  } catch (error) {
    // e.g. the HS-with-public-key confusion attempt — the landed import
    // refuses a JWK where the family wants the raw secret.
    throw new OidcVerifyError("alg-unsupported", `verify key import refused: ${String(error)}`);
  }

  // -- the signature + the verifier's exp/nbf gate (zero leeway) ------------
  let verified;
  try {
    verified = await verifyJws({ alg, key, token: idToken, nowSec });
  } catch (error) {
    // The landed verifier's own claim gate (golang-jwt semantics) rejects
    // expiry/not-yet-valid before any claim of ours runs — those map to the
    // claims arm; everything else (malformed, tampered) stays a signature
    // failure.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("expired") || message.includes("not valid yet")) {
      throw new OidcVerifyError("claims", `id_token time bounds rejected: ${message}`);
    }
    throw new OidcVerifyError("signature", `id_token verification failed: ${message}`);
  }

  // -- the claim gates (SPEC §5.4, in order) --------------------------------
  // iss == the discovery issuer, EXACT string.
  if (verified.claims.iss !== document.issuer) {
    throw new OidcVerifyError("issuer-mismatch", `id_token iss ${JSON.stringify(verified.claims.iss)} != discovery issuer`);
  }
  // aud contains the source's client_id (string or array form).
  const aud = verified.claims.aud;
  const audience = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a): a is string => typeof a === "string") : [];
  if (!audience.includes(cfg.clientId)) {
    throw new OidcVerifyError("claims", `id_token aud does not include the source client_id`);
  }
  // exp/iat strict, zero leeway (assertApiTimeBounds semantics — the second,
  // independent gate upstream's API path runs over the verifier's own).
  try {
    assertApiTimeBounds(verified.claims, nowSec);
  } catch (error) {
    throw new OidcVerifyError("claims", `id_token time bounds rejected: ${String(error)}`);
  }
  // nonce equals the parked value (when the dance minted one).
  if (options.expectedNonce !== undefined && verified.claims.nonce !== options.expectedNonce) {
    throw new OidcVerifyError("nonce", "id_token nonce does not match the parked dance nonce");
  }

  return { identity: identityFromClaims(verified.claims, cfg.externalIdClaim), header: verified.header };
}

/** Local base64url decode for the header/payload pre-read (jws.ts's decoder
 *  is module-private — this mirrors it byte-for-byte). */
function base64UrlDecodeJson(value: string): Uint8Array {
  const std = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The client seam (SPEC §5.1) — W2's executable slice
// ---------------------------------------------------------------------------

/** The resolved client for a source row. W3 added the `github` and `gplus`
 *  arms — the client modules (`github-client.ts`/`gplus-client.ts`) hang
 *  off this union; the route layer dispatches per kind (the simple arms are
 *  discovery-less: fixed endpoints from the registry/goth wire values vs
 *  the OIDC arm's well-known join). Unknown-but-valid provider keys
 *  (recorded-deferred lattice entries, SPEC §2.3) still answer the
 *  not-implemented status (the flow's failure arm — the same
 *  flash-and-login-redirect ladder, upstream errCallback default). */
export type OAuth2Client =
  | { kind: "oidc"; cfg: OAuth2SourceConfig }
  | { kind: "github"; cfg: OAuth2SourceConfig }
  | { kind: "gplus"; cfg: OAuth2SourceConfig }
  | { kind: "not-implemented"; provider: string; cfg: OAuth2SourceConfig };

/** Parse the row's cfg and resolve the client. An unparsable row is a dead
 *  source (the codec's contract) — the caller answers its 404/failure arm. */
export function resolveOAuth2Client(cfgJson: string): OAuth2Client {
  const cfg = parseOAuth2SourceConfig(cfgJson);
  if (cfg.provider === "openidConnect") return { kind: "oidc", cfg };
  if (cfg.provider === "github") return { kind: "github", cfg };
  if (cfg.provider === "gplus") return { kind: "gplus", cfg };
  return { kind: "not-implemented", provider: cfg.provider, cfg };
}
