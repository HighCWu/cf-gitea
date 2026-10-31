/**
 * The GitHub provider client — the `github` arm of the login-source client
 * seam (specs/external-auth-sources.md §5.1/§9 W3). Stateless like the OIDC
 * arm: the client rebuilds from the source row's cfg record per request.
 *
 * ## Wire parity (upstream = goth v1.82.0's github provider — an EXTERNAL
 * module, not in the gitea tree; sources read from the v1.82.0 tag, the
 * W1-recorded precedent for github's URL values)
 *
 *   - The pin's arm: `providers_custom.go:55-70` — the CustomURLSettings
 *     table (four `availableAttribute` entries over goth's package vars)
 *     OverrideWith'd with the source's CustomURLMapping, then
 *     `github.NewCustomisedURL(clientID, secret, callbackURL, custom.AuthURL,
 *     custom.TokenURL, custom.ProfileURL, custom.EmailURL, scopes...)`. The
 *     `user:email` scope add rides `EnableAutoRegistration` (:63-65) —
 *     deferred (SPEC §1), so v1 sends the source's own scopes only, NONE by
 *     default (the registry's `defaultScopes: []`).
 *   - Endpoint defaults: goth v1.82.0 providers/github/github.go:28-33 —
 *     AuthURL `https://github.com/login/oauth/authorize`, TokenURL
 *     `https://github.com/login/oauth/access_token`, ProfileURL
 *     `https://api.github.com/user`, EmailURL
 *     `https://api.github.com/user/emails`. Carried through the REGISTRY's
 *     GITHUB_URLS (the recorded lattice is the single source of the values;
 *     this module reads them from `getProviderDescriptor("github")`).
 *   - Authorize redirect: x/oauth2 v0.27.0 `Config.AuthCodeURL` (goth's
 *     `BeginAuth` → `config.AuthCodeURL(state)`, github.go:91-97) —
 *     `response_type=code`, `client_id`, `redirect_uri`, `scope`
 *     (space-joined, OMITTED when the source carries no scopes — x/oauth2
 *     sets the key only for a non-empty list, unlike the OIDC arm's `openid`
 *     default), `state`. No `nonce` — that parameter is the OIDC dance's
 *     id_token replay guard and has no github arm.
 *   - Code exchange: goth's `Session.Authorize` → `config.Exchange`
 *     (github/session.go:26-39) — x/oauth2 POSTs the token endpoint form
 *     encoded. SPEC §5.3.3 fixes our body shape for every arm:
 *     `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`,
 *     `client_secret` (client_secret_post). x/oauth2's AuthStyle autodetect
 *     would try HTTP Basic first for github and retry in-params on refusal;
 *     GitHub's endpoint documents and accepts the in-params form, so the
 *     observable outcome is identical (recorded adaptation, SPEC W3 marks).
 *   - Profile fetch: `FetchUser` (github.go:100-155) — GET the profile URL
 *     with `Authorization: Bearer <token>` (:117), non-200 is an error
 *     (:124-126). Mapping per `userFromReader` (:157-182): external id =
 *     **`strconv.Itoa(u.ID)` — the NUMERIC user id as a decimal string**
 *     (:178); `NickName = login` (:174); `Email = email` (the PUBLIC profile
 *     address, :175); `Name = name`; `AvatarURL = avatar_url`; bio and
 *     location are mapped by goth but have NO slot in our bounded
 *     `ExternalIdentityProfile` (the landed §4.3 slice — identity.ts —
 *     carries neither; recorded in the W3 marks). `FirstName`/`LastName`
 *     stay null: goth's github provider sets neither.
 *   - The email arm: `github.go:143-153` — ONLY when the profile email is
 *     empty AND the granted scopes include `user` or `user:email`
 *     (TrimSpace equality, :145), then `getPrivateMail` (:184-215): GET the
 *     email URL with the Bearer header, non-200 is an error (:196-198), and
 *     the FIRST list entry with `primary && verified` wins (:209-213); no
 *     such entry ⇒ `ErrNoVerifiedGitHubPrimaryEmail` (:36-38, :214) — the
 *     FetchUser call FAILS upstream, so the login fails here too (the
 *     `no-verified-email` code, the route's default failure arm).
 *   - Custom URL overrides: `CustomURLSettings.OverrideWith`
 *     (urlmapping.go:60-74) — a non-empty source override wins, else the
 *     attribute's default value. The cfg codec already drops empty strings
 *     (cfg.ts), so `override ?? default` is the exact semantics.
 */

import type { OAuth2SourceConfig } from "./cfg";
import type { ExternalIdentityProfile } from "./identity";
import { getProviderDescriptor, type CustomUrlSettings } from "./registry";

/** The outbound fetch seam (SPEC §8 — the stub IdP in tests, global fetch
 *  in production; the OIDC arm's `FetchImpl` twin). */
export type FetchImpl = typeof fetch;

/** A github-arm failure with a stable machine-readable code — the route
 *  layer maps every code to the same user-facing failure arm (upstream's
 *  errCallback default) exactly as it does `OidcVerifyError`; tests and
 *  logs key on the code. */
export class GithubClientError extends Error {
  constructor(
    public readonly code:
      | "token-fetch"
      | "token-shape"
      | "profile-fetch"
      | "profile-shape"
      | "email-fetch"
      | "email-shape"
      | "no-verified-email"
      | "external-id-missing",
    message: string,
  ) {
    super(message);
    this.name = "GithubClientError";
  }
}

/** An exchange result — the bounded identity slice the ladder consumes.
 *  v1 carries NO provider tokens forward (SPEC §7.8: the link row's token
 *  columns stay empty until a sync consumer lands), so the access token is
 *  not part of the result. */
export interface GithubExchangeResult {
  identity: ExternalIdentityProfile;
}

/** One URL of the github family: a non-empty source override wins
 *  (OverrideWith's len>0 + Available arm, urlmapping.go:60-74 — github's
 *  four attributes are all `availableAttribute`, so Available is always
 *  true), else the registry's goth-v1.82.0 default value. */
function resolveGithubUrl(field: keyof CustomUrlSettings, override: string | undefined): string {
  if (override !== undefined && override.length > 0) return override;
  const value = getProviderDescriptor("github")?.customUrlSettings?.[field].value;
  if (value === undefined || value.length === 0) {
    // Unreachable while the registry's github entry keeps its URL table —
    // a data edit that drops it must fail loudly, never authorize against "".
    throw new Error(`github provider descriptor carries no ${field} default`);
  }
  return value;
}

/**
 * The provider authorize URL for a dance (x/oauth2 `AuthCodeURL`'s
 * parameter set — see the header). `state` is the route layer's dance UUID;
 * there is NO nonce on this arm.
 */
export function buildGithubAuthorizeUrl(cfg: OAuth2SourceConfig, redirectUri: string, state: string): string {
  const authUrl = resolveGithubUrl("authUrl", cfg.customUrlMapping?.authUrl);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
  });
  // x/oauth2 sets `scope` only when the list is non-empty — github's v1
  // default is NO scope param (the auto-reg `user:email` add is deferred,
  // providers_custom.go:63-65).
  const scopes = cfg.scopes ?? [];
  if (scopes.length > 0) params.set("scope", scopes.join(" "));
  params.set("state", state);
  const joiner = authUrl.includes("?") ? "&" : "?";
  return `${authUrl}${joiner}${params.toString()}`;
}

/** The scope gate of the email arm (github.go:144-146's TrimSpace
 *  equality). */
function grantsEmailScope(scopes: string[]): boolean {
  return scopes.some((scope) => scope.trim() === "user" || scope.trim() === "user:email");
}

/** userFromReader's profile slice (github.go:157-182) — the fields the
 *  bounded identity carries. Missing/empty strings normalize to null. */
function claimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Exchange the authorization code and resolve the identity — the callback
 * leg for a `github` source. Wire order is goth's `FetchUser`: token POST
 * → profile GET (Bearer) → the scope-gated email arm. Every failure mode
 * throws `GithubClientError` with its code.
 */
export async function exchangeGithubCode(options: {
  fetchImpl: FetchImpl;
  cfg: OAuth2SourceConfig;
  redirectUri: string;
  code: string;
}): Promise<GithubExchangeResult> {
  const { fetchImpl, cfg } = options;

  // -- the token exchange (SPEC §5.3.3's fixed body shape; header note) ----
  const tokenUrl = resolveGithubUrl("tokenUrl", cfg.customUrlMapping?.tokenUrl);
  let tokenResponse: Response;
  try {
    tokenResponse = await fetchImpl(tokenUrl, {
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
    throw new GithubClientError("token-fetch", `token endpoint fetch failed: ${String(error)}`);
  }
  if (!tokenResponse.ok) {
    throw new GithubClientError("token-fetch", `token endpoint answered ${String(tokenResponse.status)}`);
  }
  let tokenPayload: unknown;
  try {
    tokenPayload = await tokenResponse.json();
  } catch {
    throw new GithubClientError("token-shape", "token endpoint response is not valid JSON");
  }
  const accessToken = (tokenPayload as Record<string, unknown>).access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GithubClientError("token-shape", "token endpoint response carries no access_token");
  }

  // -- the profile fetch (github.go:112-126: Bearer header, 200 required) --
  const profileUrl = resolveGithubUrl("profileUrl", cfg.customUrlMapping?.profileUrl);
  let profileResponse: Response;
  try {
    profileResponse = await fetchImpl(profileUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    throw new GithubClientError("profile-fetch", `profile endpoint fetch failed: ${String(error)}`);
  }
  if (!profileResponse.ok) {
    throw new GithubClientError("profile-fetch", `profile endpoint answered ${String(profileResponse.status)}`);
  }
  let profile: unknown;
  try {
    profile = await profileResponse.json();
  } catch {
    throw new GithubClientError("profile-shape", "profile endpoint response is not valid JSON");
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new GithubClientError("profile-shape", "profile endpoint response is not a JSON object");
  }
  const record = profile as Record<string, unknown>;
  // The external id: strconv.Itoa(u.ID) (github.go:178) — the NUMERIC user
  // id as a decimal string, NOT the login (login → NickName). A payload
  // without a numeric id is a malformed profile, not an identity (goth
  // would coerce a missing field to "0" through Go's zero value — the
  // honest failure is recorded in the W3 marks).
  if (typeof record.id !== "number" || !Number.isInteger(record.id)) {
    throw new GithubClientError("external-id-missing", "github profile carries no numeric id");
  }

  // -- the email arm (github.go:143-153 — scope-gated, primary+verified) ---
  let email = claimString(record.email);
  if (email === null && grantsEmailScope(cfg.scopes ?? [])) {
    email = await fetchPrimaryVerifiedEmail(fetchImpl, resolveGithubUrl("emailUrl", cfg.customUrlMapping?.emailUrl), accessToken);
  }

  return {
    identity: {
      externalId: String(record.id),
      email,
      name: claimString(record.name),
      nickName: claimString(record.login),
      avatarUrl: claimString(record.avatar_url),
      // goth's github provider sets neither (userFromReader) — null always.
      firstName: null,
      lastName: null,
    },
  };
}

/** getPrivateMail (github.go:184-215): first `primary && verified` entry in
 *  list order; no such entry ⇒ ErrNoVerifiedGitHubPrimaryEmail (:214) —
 *  upstream FAILS the FetchUser, so the login fails here (the
 *  `no-verified-email` arm). */
async function fetchPrimaryVerifiedEmail(fetchImpl: FetchImpl, emailUrl: string, accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(emailUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    throw new GithubClientError("email-fetch", `email endpoint fetch failed: ${String(error)}`);
  }
  if (!response.ok) {
    throw new GithubClientError("email-fetch", `email endpoint answered ${String(response.status)}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new GithubClientError("email-shape", "email endpoint response is not valid JSON");
  }
  if (!Array.isArray(raw)) {
    throw new GithubClientError("email-shape", "email endpoint response is not a JSON array");
  }
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const mail = entry as Record<string, unknown>;
    if (mail.primary === true && mail.verified === true && typeof mail.email === "string" && mail.email.length > 0) {
      return mail.email;
    }
  }
  throw new GithubClientError("no-verified-email", "github list carries no primary verified email (ErrNoVerifiedGitHubPrimaryEmail)");
}
