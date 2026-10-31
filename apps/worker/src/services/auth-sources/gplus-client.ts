/**
 * The Google provider client — the `gplus` arm of the login-source client
 * seam (specs/external-auth-sources.md §5.1/§9 W3). Named simple provider
 * per the ratified OQ-3 (upstream runs `gplus` as a fixed-endpoint simple
 * provider — NOT through the generic OIDC discovery arm — so the scopes and
 * defaults match the pin exactly). Stateless like the sibling arms.
 *
 * ## Wire parity (upstream = the pin's gplus arm + goth v1.82.0's google
 * provider — an EXTERNAL module, not in the gitea tree; sources read from
 * the v1.82.0 tag, the W1-recorded precedent for github's URL values)
 *
 *   - The pin's arm: `providers_simple.go:71-79` — the legacy key kept for
 *     migration parity (:72 "named gplus due to legacy gplus -> google
 *     migration"); constructor scopes `[]string{"email"}` CONCATENATED ahead
 *     of the source's own scopes (`CreateGothProvider`,
 *     providers_simple.go:32-37 — provider defaults first, source scopes
 *     appended, never deduplicated or replaced); the `profile` scope add
 *     rides `UpdateAvatar || EnableAutoRegistration` (:74-76) — deferred
 *     (SPEC §1), so the v1 wire scope list is exactly
 *     `["email", ...(source scopes)]`.
 *   - Endpoints: goth v1.82.0 providers/google/endpoint.go delegates to
 *     x/oauth2 v0.27.0 `google.Endpoint` (gitea pins goth v1.82.0,
 *     go.mod:60; goth pins x/oauth2 v0.27.0, goth go.mod:16) — AuthURL
 *     `https://accounts.google.com/o/oauth2/auth`, TokenURL
 *     `https://oauth2.googleapis.com/token`, AuthStyle
 *     `AuthStyleInParams` (x/oauth2 google/google.go:25-30). The
 *     `endpoint_legacy.go` arm (accounts.google.com/o/oauth2/token) is
 *     `!go1.9`-build-tagged and structurally dead.
 *   - Authorize redirect: x/oauth2 v0.27.0 `Config.AuthCodeURL` over goth's
 *     `BeginAuth` (google.go:69-75) WITH goth's fixed authCodeOption
 *     `oauth2.AccessTypeOffline` (google.go:29-34, "We can get a refresh
 *     token from Google by this option") — so the parameter set is
 *     `response_type=code`, `client_id`, `redirect_uri`, `scope`
 *     (space-joined), `state`, `access_type=offline`. No `nonce` — the OIDC
 *     dance's id_token replay guard has no simple-provider arm.
 *   - Code exchange: POST the token endpoint form encoded — Google's pinned
 *     `AuthStyleInParams` IS the SPEC §5.3.3 body shape exactly
 *     (`grant_type=authorization_code`, `code`, `redirect_uri`,
 *     `client_id`, `client_secret` in the form body; no adaptation, unlike
 *     github's Basic-first autodetect).
 *   - Profile fetch: `FetchUser` (google.go:88-137) — GET
 *     `https://www.googleapis.com/oauth2/v2/userinfo` (:17
 *     `endpointProfile`) with the access token as a URL QUERY parameter
 *     (:103 `endpointProfile + "?access_token=" + url.QueryEscape(...)` —
 *     the pinned wire shape, carried verbatim), non-200 is an error
 *     (:109-111).
 *   - Identity mapping (google.go:118-134): external id = the `id` STRING
 *     (:130); `NickName = Name` (:127 — goth maps the display name onto the
 *     nickname slot for Google, there is no login handle); `Email = email`;
 *     `FirstName = given_name`; `LastName = family_name`; `AvatarURL =
 *     picture`. Upstream treats an empty `UserID` as a missing field
 *     (oauth.go:147 `if gothUser.UserID == ""`) — an identity without its
 *     external id cannot resolve a link at all on our ladder, so the empty
 *     case fails the exchange (`external-id-missing`, the OIDC arm's
 *     parallel code) instead of reaching the link page.
 */

import type { OAuth2SourceConfig } from "./cfg";
import type { ExternalIdentityProfile } from "./identity";

/** The outbound fetch seam (SPEC §8 — the stub IdP in tests, global fetch
 *  in production; the sibling arms' `FetchImpl` twin). */
export type FetchImpl = typeof fetch;

/** x/oauth2 v0.27.0 google.Endpoint (via goth v1.82.0 endpoint.go) — the
 *  simple provider's fixed endpoints; gplus carries NO CustomURLSettings
 *  (registry: `customUrlSettings: null`, providers_base.go:53-56) and the
 *  cfg codec rejects a customUrlMapping on this key (cfg.ts). */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** goth google.go:17 endpointProfile. */
const GOOGLE_PROFILE_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** A gplus-arm failure with a stable machine-readable code — the route
 *  layer maps every code to the same user-facing failure arm (upstream's
 *  errCallback default) exactly as it does `OidcVerifyError`; tests and
 *  logs key on the code. */
export class GplusClientError extends Error {
  constructor(
    public readonly code:
      | "token-fetch"
      | "token-shape"
      | "profile-fetch"
      | "profile-shape"
      | "external-id-missing",
    message: string,
  ) {
    super(message);
    this.name = "GplusClientError";
  }
}

/** An exchange result — the bounded identity slice the ladder consumes.
 *  v1 carries NO provider tokens forward (SPEC §7.8), so the access token
 *  is not part of the result even though Google grants refresh tokens
 *  (access_type=offline asks for one; nothing consumes it in v1). */
export interface GplusExchangeResult {
  identity: ExternalIdentityProfile;
}

/** The wire scope list: the constructor's `["email"]` default CONCATENATED
 *  ahead of the source's scopes (providers_simple.go:32-37 — append, never
 *  replace; the `profile` add is deferred, :74-76). */
function wireScopes(cfg: OAuth2SourceConfig): string[] {
  return ["email", ...(cfg.scopes ?? [])];
}

/**
 * The provider authorize URL for a dance (x/oauth2 `AuthCodeURL` +
 * goth's `access_type=offline` option — see the header). `state` is the
 * route layer's dance UUID; there is NO nonce on this arm.
 */
export function buildGplusAuthorizeUrl(cfg: OAuth2SourceConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: wireScopes(cfg).join(" "),
    state,
    access_type: "offline",
  });
  const joiner = GOOGLE_AUTH_URL.includes("?") ? "&" : "?";
  return `${GOOGLE_AUTH_URL}${joiner}${params.toString()}`;
}

/** Missing/empty strings normalize to null (the OIDC arm's claimString
 *  semantics). */
function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Exchange the authorization code and resolve the identity — the callback
 * leg for a `gplus` source. Wire order is goth's `FetchUser`: token POST →
 * userinfo GET (token as the query param). Every failure mode throws
 * `GplusClientError` with its code.
 */
export async function exchangeGplusCode(options: {
  fetchImpl: FetchImpl;
  cfg: OAuth2SourceConfig;
  redirectUri: string;
  code: string;
}): Promise<GplusExchangeResult> {
  const { fetchImpl, cfg } = options;

  // -- the token exchange (Google's pinned AuthStyleInParams == SPEC
  //    §5.3.3's body shape exactly) ----------------------------------------
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(GOOGLE_TOKEN_URL, {
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
    throw new GplusClientError("token-fetch", `token endpoint fetch failed: ${String(error)}`);
  }
  if (!tokenResponse.ok) {
    throw new GplusClientError("token-fetch", `token endpoint answered ${String(tokenResponse.status)}`);
  }
  let tokenPayload: unknown;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    throw new GplusClientError("token-shape", "token endpoint response is not valid JSON");
  }
  const accessToken = (tokenPayload as Record<string, unknown>).access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GplusClientError("token-shape", "token endpoint response carries no access_token");
  }

  // -- the profile fetch (google.go:103 — the token rides the QUERY STRING,
  //    the pinned wire shape, not a Bearer header) --------------------------
  let profileResponse: Response;
  try {
    profileResponse = await fetchImpl(`${GOOGLE_PROFILE_URL}?access_token=${encodeURIComponent(accessToken)}`);
  } catch (error) {
    throw new GplusClientError("profile-fetch", `profile endpoint fetch failed: ${String(error)}`);
  }
  if (!profileResponse.ok) {
    throw new GplusClientError("profile-fetch", `profile endpoint answered ${String(profileResponse.status)}`);
  }
  let profile: unknown;
  try {
    profile = await profileResponse.json();
  } catch {
    throw new GplusClientError("profile-shape", "profile endpoint response is not valid JSON");
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new GplusClientError("profile-shape", "profile endpoint response is not a JSON object");
  }
  const record = profile as Record<string, unknown>;
  // googleUser.ID is a string (google.go:78); an empty id is upstream's
  // missing-field arm (oauth.go:147) — here it fails the exchange, because
  // an identity with no external id cannot resolve or link.
  const externalId = claimString(record.id);
  if (externalId === null) {
    throw new GplusClientError("external-id-missing", "google userinfo carries no id");
  }
  const name = claimString(record.name);

  return {
    identity: {
      externalId,
      email: claimString(record.email),
      name,
      // google.go:127 — `user.NickName = u.Name` (no login handle exists).
      nickName: name,
      avatarUrl: claimString(record.picture),
      firstName: claimString(record.given_name),
      lastName: claimString(record.family_name),
    },
  };
}
