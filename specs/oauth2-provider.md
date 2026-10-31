# SPEC: OAuth2 Provider (+ OIDC discovery) — "Sign in with cf-gitea" for third-party apps

Status: draft (written for the v1.4 implementation waves; not yet ratified)
Upstream pin: fc4936884584 (`gitea/` submodule)
Supersedes: SPEC-0002 §2.8's "OAuth2 provider deferred to a later SPEC" note (that
SPEC's deferral clause is retired when this lands)

## 1. Problem and scope

cf-gitea has no OAuth2 authorization-server surface: third-party applications cannot
redirect a user through an authorize dance, and cannot mint API tokens via the OAuth
flow. Upstream Gitea carries the provider whole — authorize/consent, the token
endpoint (authorization_code + refresh_token, PKCE), OIDC id_token issuance, JWKS +
discovery, introspection, and a userinfo endpoint (`gitea/routers/web/web.go:617–631`,
`oauth2_wellknown.go`). This SPEC ports it.

**Already landed (this SPEC extends, not re-implements):**

- The `oauth2_application` table (migration 0026) and the whole application CRUD
  service (`src/api/services/oauth2-apps.ts` — secret generation/hash, redirect-URI
  validation, list/get/create/update/delete) behind the frozen-contract
  `/user/applications/oauth2` family (`src/api/routes/oauth2-apps.ts`, 5 ops).
- The user/org/admin settings application pages exist in reduced forms:
  `ui/pages/user-settings-applications.tsx` (the PAT half; its module header records
  "the `/oauth2` subgroup inside it is NOT ours" — the OAuth2 halves of
  `applications.tmpl` are explicitly deferred to this SPEC), `ui/pages/org-settings-applications.tsx`
  (R20-a create/delete), `ui/pages/admin-applications.tsx` (the global list).

**In scope:** the flow — `oauth2_grant`, `oauth2_authorization_code` tables; the
per-instance signing key; `/login/oauth/authorize|grant|access_token|userinfo|keys|introspect`;
`/.well-known/openid-configuration`; the consent page over SPEC-0010's session; the
Bearer-JWT auth method for `/api/v1` + git HTTP; scope normalization over SPEC-0002's
grammar; the user-settings OAuth2 subgroup (list/edit/regenerate/delete/grants+revoke);
the builtin-application seed + lock; the `OAUTH2_ENABLED` gate and the git-HTTP
Basic-realm flip.

**Out of scope (recorded, not silently dropped):**

- **OAuth2 as CLIENT** (sign-in *via* a foreign provider — upstream `web.go:768`
  `/{provider}` + `/{provider}/callback`, `services/auth/source/oauth2/*`,
  `MaxTokenLength` which upstream only enforces on the consumer side
  `routers/web/auth/oauth.go:476`). A separate future SPEC.
- Device flow, client-credentials grant, dynamic client registration — absent from
  the pin (the token endpoint accepts only `authorization_code` and `refresh_token`,
  `routers/web/auth/oauth2_provider.go:553–563`); no invention.
- OIDC `prompt=none`/session management/front-channel logout — absent from the pin.
- WebAuthn interplay `webAuth.AllowOAuth2` (`web.go:630`) — cf-gitea has no WebAuthn
  yet; the middleware slot is recorded so the re-pin picks it up.

## 2. Surface (upstream behavior is the default decision; every row carries its pin cite)

### 2.1 Route inventory

| Route | Methods | Handler (pin) | Notes |
|---|---|---|---|
| `/login/oauth/authorize` | GET, POST | `auth.AuthorizeOAuth` (`routers/web/auth/oauth2_provider.go:224`) | behind `reqSignIn` — anonymous browsers are redirected to login and back (`web.go:623`) |
| `/login/oauth/grant` | POST | `auth.GrantApplicationOAuth` (`oauth2_provider.go:405`) | the consent form POST; also `reqSignIn` |
| `/login/oauth/access_token` | POST, OPTIONS | `auth.AccessTokenOAuth` (`oauth2_provider.go:506`) | token issuance; CORS middleware slot |
| `/login/oauth/userinfo` | GET, POST, OPTIONS | `auth.InfoOAuth` (`oauth2_provider.go:96`) | requires an OAuth2 access token (not a PAT) with `read:user` |
| `/login/oauth/keys` | GET, OPTIONS | `auth.OIDCKeys` (`oauth2_provider.go:482`) | the JWKS (one key) |
| `/login/oauth/introspect` | POST, OPTIONS | `auth.IntrospectOAuth` (`oauth2_provider.go:146`) | RFC 7662; caller authenticates with client credentials |
| `/.well-known/openid-configuration` | GET | `auth.OIDCWellKnown` (`routers/web/auth/oauth2_wellknown.go:16`) | registered at `web.go:531–532`; 404 when the provider is disabled |

The whole `/login/oauth` group sits behind the feature gate (`oauth2Enabled`,
`web.go:373–378, 631`): `setting.OAuth2.Enabled` false ⇒ **403** on every endpoint in
the group. The CORS middleware slot (`optionsCorsHandler`, `web.go:61–87`) is
config-gated upstream ([cors] disabled by default): plain OPTIONS without an
`Access-Control-Request-Method` header answers **405**, and no CORS headers are added.

Request forms (`services/forms/user_form.go:108–151`):

- `AuthorizationForm` (authorize): `response_type, client_id, redirect_uri, state,
  scope, nonce, code_challenge_method (S256|plain), code_challenge`.
- `GrantApplicationForm` (consent POST): `client_id (required), granted (bool),
  redirect_uri, state, scope, nonce`.
- `AccessTokenForm` (token): `grant_type, client_id, client_secret, redirect_uri,
  code, refresh_token, code_verifier` — upstream's `web.Bind` accepts the RFC 6749
  `application/x-www-form-urlencoded` shape and JSON.
- `IntrospectTokenForm`: `token`.

### 2.2 The authorize dance (consent over the UI session)

Happy path, upstream semantics (`oauth2_provider.go:224–479`):

1. **Pre-check** (`oauthDoerAuthorizePreCheck`, :211): two-factor-required doers get
   the `access_denied` error redirect (cf-gitea has no 2FA yet — the slot is kept as a
   no-op predicate so the re-pin finds it).
2. Load the application by `client_id`; unknown ⇒ `unauthorized_client`
   "Client ID not registered".
3. **Redirect URI check** — `ContainsRedirectURI` (`models/auth/oauth2.go:164–205`):
   exact match after ASCII-lowercasing and trailing-slash trim, against every
   registered URI; **public clients** additionally accept a loopback
   `http://127.0.0.1:port` variant with the port stripped (RFC 8252 §7.3 port
   variance, :195–205). Mismatch ⇒ `invalid_request` "Unregistered Redirect URI".
4. `response_type != "code"` ⇒ `unsupported_response_type`.
5. **PKCE** (:271–317): `S256` and `plain` accepted; the challenge + method are
   stashed in the **session**; `unsupported` methods ⇒ `invalid_request`; **absent
   PKCE on a public client** ⇒ `invalid_request` "PKCE is required for public
   clients" (RFC 7636 §4.4.1 / RFC 8252 §8.1 — cite verbatim in the handler).
6. Load the user's existing grant for the app (`GetGrantByUserID`); empty requested
   scope defaults to the granted scope (:325–327); normalize
   (`NormalizeGrantScope`, §2.5); diff added/removed scopes.
7. **Auto-consent** (:339–359): confidential client (or
   `SkipSecondaryAuthorization`) + existing grant + unchanged scope ⇒ generate a
   fresh authorization code immediately and 303-redirect. **Public clients always
   see the consent page** (RFC 6749 §10.2 — untrusted clients re-authorize every
   time).
8. **Consent page** (`templates/user/auth/grant.tmpl`): application name, creator
   link (owner user or instance name), requested scopes, added-scope callout,
   redirect-notice; a form POSTing `client_id/state/scope/nonce/redirect_uri` plus
   `granted=true|false` to `/login/oauth/grant`. Before rendering, the handler
   stashes `client_id`, `redirect_uri`, `state` in the session (:378–395).
9. **POST /grant** (:405–479): the session's `client_id/state/redirect_uri` must
   equal the form's, else plain **400**. `granted=false` ⇒ `access_denied`
   "the request is denied" redirect. Otherwise create the grant (first consent) or
   update its scope; store `nonce` when present; generate the code; 303 redirect to
   `redirect_uri?code=…&state=…`.

Error rendering (`handleAuthorizeError`, :734–752): when a validated redirect URI is
known, the error rides the redirect as `error`, `error_description`, `state` query
params (303); otherwise the `grant_error` page renders at **400** (redirect URI never
trusted, so nothing leaks). `handleServerError` funnels unexpected failures into the
same shape as `server_error`.

### 2.3 The token endpoint

`AccessTokenOAuth` (`oauth2_provider.go:506–564`):

- **Client authentication**: form `client_id`/`client_secret`; if either is missing,
  the `Authorization: Basic` header is parsed (RFC 6749 §2.3.1 — credentials are
  form-urlencoded inside Basic, `parseClientSecretBasic`, :134–143); a body value
  that disagrees with the Basic header ⇒ `invalid_request`. No client secret at all
  is legitimate for public clients.
- Errors are RFC 6749 §5.2 JSON at **400** with `error` +
  `error_description` (`AccessTokenError`, `services/oauth2_provider/access_token.go:26–55`):
  `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`,
  `unsupported_grant_type`, `invalid_scope`.

**authorization_code** (`handleAuthorizationCode`, :633–720):

1. Load app by client_id (miss ⇒ `invalid_client`).
2. Confidential clients MUST present a valid secret (`ValidateClientSecret`, bcrypt
   upstream / PBKDF2 here — §3.3); failure ⇒ `unauthorized_client` "invalid client
   secret" ("invalid empty client secret" when blank).
3. A presented `redirect_uri` must be in the registered list
   (`unauthorized_client` "unexpected redirect URI").
4. Load the code (miss ⇒ `unauthorized_client` "client is not authorized"); expired
   ⇒ invalidate + `invalid_grant` "authorization code expired" (codes live **10
   minutes**, RFC 6749 §4.1.2 — `oauth2.go:31`).
5. PKCE verify (`ValidateCodeChallenge`, `oauth2.go:470–482`): a code that carries a
   challenge requires a verifier; `S256` = BASE64URL-ENCODE(SHA256(ASCII(verifier))),
   `plain` = verifier; comparison is constant-time. Failure ⇒ `unauthorized_client`
   "failed PKCE code challenge".
6. The code's stored `redirect_uri` must equal the presented one when non-empty ⇒
   else `invalid_grant` "redirect_uri differs from the original authorization
   request".
7. The code's grant must belong to the presenting app ⇒ else `invalid_grant`
   "invalid grant".
8. **One-time consumption** (`Invalidate`, `oauth2.go:443–452`): DELETE by id;
   zero affected rows ⇒ `invalid_grant` "authorization code already used" — the
   replay guard is the DELETE's rowcount itself, not a flag.
9. Mint the token response (§2.4).

**refresh_token** (`handleRefreshToken`, :566–631):

1. Client authentication as above (confidential clients must authenticate — RFC 6749
   §6).
2. Parse the refresh JWT (`ParseToken`); wrong kind (an access token presented as a
   refresh) ⇒ `unauthorized_client` "unable to parse refresh token".
3. The grant must still exist (`invalid_grant` "grant does not exist") and belong to
   the app (`invalid_grant` "refresh token belongs to a different client").
4. `InvalidateRefreshTokens` (default **false**): when ON, a used refresh token is
   detected by comparing the grant's `Counter` with the token's `cnt` claim —
   mismatch or `cnt=0` ⇒ `unauthorized_client` "token was already used" (`:617–624`).
   When OFF (the default) refresh tokens are reusable until expiry and every refresh
   mints a fresh access+refresh pair with the same counter.
5. Mint the token response.

**Success response** (`AccessTokenResponse`, `access_token.go:69–76`):
`access_token` (JWT), `token_type: "bearer"`, `expires_in` (default 3600 s),
`refresh_token` (JWT), `id_token` (present iff the grant scope contains `openid`),
`scope` (the normalized grant scope string).

**Expiry units** (implementation trap): `AccessTokenExpirationTime` 3600 is seconds
(`access_token.go:164`), but the refresh expiry multiplies its setting by `60*60` —
the default `RefreshTokenExpirationTime: 730` (`modules/setting/oauth2.go:106`) is
consumed as **hours** (`access_token.go:181`), i.e. ≈ 30.4 days. Port the arithmetic,
not the config comment.

### 2.4 The token shapes (JWT claims, verbatim from the pin)

`services/oauth2_provider/token.go:29–34` — one claims struct for both:

- **Access token**: `{gnt: <grant id>, tt: 0, exp}` — **no** `iss`/`sub`/`aud`/`jti`.
  The token is a *pointer* to the grant row; all authority (user, scope, revocation)
  is resolved from D1 at request time, so grant deletion/scope change kills
  outstanding access tokens immediately.
- **Refresh token**: `{gnt, tt: 1, cnt: <grant counter>, exp}`.
- **id_token** (`OIDCToken`, `token.go:67–86`): `iss`, `aud` = client_id, `sub` =
  user id, `exp` = access-token expiry, `nonce` (from the grant), then per scope:
  `profile` ⇒ `name, preferred_username, profile (HTML URL), picture, website,
  locale, updated_at`; `email` ⇒ `email, email_verified` (= account activation);
  `groups` ⇒ org and `org:team` names (`GetOAuthGroupsForUser`,
  `access_token.go:278–302`; `public-only` scope restricts to public orgs).
  Signed with the **client key**: asymmetric algs use the server key; the HS family
  uses the **client secret** as the HMAC key (`AccessTokenOAuth`'s `clientKey`
  construction, `oauth2_provider.go:539–551`) — so an HS256 deployment's id_tokens
  are client-verifiable while the JWKS deliberately publishes no secret
  (`hmacSigningKey.ToJWK` returns `kty/alg` only, `jwtsigningkey.go:69–74`).

`ParseToken` (`token.go:37–56`) rejects any token whose `alg` header differs from the
configured signing method — no algorithm-confusion. API-side validation adds
`exp >= now` **and** `iat <= now` with zero leeway
(`GetOAuthAccessTokenScopeAndUserID`, `services/auth/oauth2.go:53`) — strict clock
parity, no skew allowance.

**Issuer** (`NewJwtRegisteredClaimsFromUser`, `access_token.go:136–152`):
`[oauth2] JWT_CLAIM_ISSER` or the instance `AppURL` minus the trailing slash —
identical to the OIDC discovery `issuer` and the prefix rule
(openid-connect-discovery §4: the issuer MUST equal the URL used to fetch
`/.well-known/openid-configuration`).

### 2.5 Scopes

Grant scope is one space-separated string mixing two families
(`splitGrantScopes`, `access_token.go:87–119`):

- **General (OIDC) scopes**: `openid`, `profile`, `email`, `groups`
  (`GeneralScopesSupported`, :78–85) — these drive id_token/userinfo claims and are
  stored verbatim.
- **Access scopes**: the SPEC-0002 grammar (`read:`/`write:` over the nine
  categories, `all`, `no-token-scope`, `public-only`), comma-joinable inside one
  space-separated word (`read:repository,write:issue`), normalized through the same
  upstream bitmap normalizer cf-gitea already ported
  (`models/auth/access_token_scope.go` / our `scope-gate` module).

Rules to port exactly:

- Requests with **no access-scope word** retain the legacy default: the grant's API
  authority is **`all`** (`GrantAdditionalScopes` returns `AccessTokenScopeAll`,
  "grants without access scopes retain the legacy default", :127–134 — since 1.22).
- But normalization that discards every invalid scope leaves **`no-token-scope`**,
  deliberately NOT `all` (:110–118) — a garbage scope must never accidentally grant
  everything.
- `userinfo` additionally requires `read:user` (`oauth2_provider.go:103–114`,
  403 + `WWW-Authenticate: Bearer` when missing).
- Introspection reports `NormalizeGrantScope(grant.Scope)`.

### 2.6 userinfo, introspection, JWKS, discovery

- **userinfo** (`InfoOAuth`): authenticates ONLY via the OAuth2 auth method — a PAT
  (or a session) is not enough; the pin checks `ctx.Data["AuthedMethod"] ==
  (&auth_service.OAuth2{}).Name()` (:97). Response: `{sub: <user id>, name,
  preferred_username, email, picture, groups}` (`userInfoResponse`, :86–93).
- **introspection** (`IntrospectOAuth`): caller must present
  `client_secret_basic` (Basic only — no form credentials); unauthenticated ⇒ 401 +
  `WWW-Authenticate: Basic realm="Gitea OAuth2"` (RFC 7662 §2.1). Invalid/foreign
  tokens answer **200 `{active:false}`** (never an error — RFC 7662 §2.2), and a
  token belonging to a different client's grant also answers inactive
  (:191–196). Active response: `{active:true, scope, username, iss, sub, aud}` —
  `exp` omitted (nil) (:169–208).
- **JWKS** (`OIDCKeys`): `{"keys":[{kty, alg, kid, use:"sig", …public members}]}` —
  RSA ⇒ `n`/`e` base64url raw; EC ⇒ `crv`/`x`/`y`; oct ⇒ no secret members.
- **discovery** (`OIDCWellKnown`): `issuer`, `authorization_endpoint`,
  `token_endpoint`, `jwks_uri`, `userinfo_endpoint`, `introspection_endpoint` (all
  AppURL-absolute), `response_types_supported: ["code"]`,
  `id_token_signing_alg_values_supported: [<the configured alg>]` (exactly one),
  `subject_types_supported: ["public"]`, `scopes_supported` = the four general
  scopes, the `claims_supported` list (:42–58), `code_challenge_methods_supported:
  ["plain","S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`.

### 2.7 The auth method on /api/v1 and git HTTP

Upstream's API auth group tries OAuth2 first (`buildAuthGroup`,
`routers/api/v1/api.go:849–857`). The OAuth2 method (`services/auth/oauth2.go`):

- Token extraction: `Authorization: Bearer`, or `token`/`access_token` query params
  (query disabled by `DISABLE_QUERY_AUTH_TOKEN` — our posture: cf-gitea already
  accepts Bearer; the query-param arm is an upstream-compat surface our resolveAuth
  does not carry for PATs, so it stays unported — a recorded divergence, consistent
  with SPEC-0002 §2.2).
- **Dispatch on shape** (:110–151): a token containing "." is a JWT — try the
  Actions-JWT path, then `GetOAuthAccessTokenScopeAndUserID` (:30–58: signature must
  verify against the instance key, kind must be access, grant must exist, exp/iat
  bounds strict); the doer carries the grant's scope (via `GrantAdditionalScopes`)
  and credential kind `oauth2-grant`. A dotless token is a PAT (our `cfg_` row
  lookup, unchanged).
- Effect: the **landed `apiScopeGate` needs no change** — the OAuth2 token resolves
  to (doer, scope) before the gate reads it, exactly like a PAT. The gate's
  `admin:application`-scoped `/user/applications/oauth2` family therefore also
  accepts OAuth2 tokens whose grant scope carries `admin:application`.
- git HTTP: `CheckRepoScopedToken` (SPEC-0002 §2.6's `repository`-category 403)
  works identically — the grant scope feeds the same permission seam.
- **userinfo's `read:user` check** reads the same resolved scope
  (`user_model.GetDoerTokenScope`, `oauth2_provider.go:106–114`).

### 2.8 The settings UI surface (the deferred halves)

`templates/user/settings/applications.tmpl` renders, gated on `.EnableOAuth2`
(`applications.tmpl:5`):

- The **applications_oauth2_list** section: the user's OAuth2 applications with
  create link; each row's edit/delete.
- The **applications_oauth2_edit** page (`user/settings/applications_oauth2_edit.tmpl`):
  name, redirect URIs (textarea, one per line), confidential-client and
  skip-secondary-authorization checkboxes; on create/update the page shows the
  client secret plaintext once; **regenerate secret** POSTs
  `/{id}/regenerate_secret`; delete POSTs `/{id}/delete`.
- The **grants_oauth2** section: the user's authorized grants (application, scope,
  granted/updated timestamps) with per-grant **revoke**
  (`POST /{id}/revoke/{grantId}` — `RevokeOAuth2Grant`, `web.go:688`).

Upstream route group (`web.go:680–689`): `GET/POST /user/settings/applications/oauth2/{id}`,
`POST .../{id}/regenerate_secret`, `POST .../oauth2` (create), `POST .../{id}/delete`,
`POST .../{id}/revoke/{grantId}` — all behind `oauth2Enabled`.

The org twin shares the handlers (`OAuth2CommonHandlers`, `routers/web/user/setting/oauth2_common.go`)
— cf-gitea's landed org-settings page already carries create/delete; this SPEC's UI
wave adds the edit/regenerate/grants arms there only if the landed page's brief
recorded them as staged (check at implementation; the user page is the required arm).

Admin's global applications arm (`web.go:888–897`, uid=0 rows) exists upstream;
cf-gitea's landed `admin-applications.tsx` is the list-only reduction (its header
records the write arms as unported) — the write arms remain out of scope here unless
the implementation wave finds them trivial over the shared service.

### 2.9 Builtin applications (the git-credential ergonomics)

Upstream seeds five fixed-client-ID applications at startup
(`BuiltinApplications`, `models/auth/oauth2.go:68–101`; `Init`, :103–157, driven by
`[oauth2] DEFAULT_APPLICATIONS`, default all five): `git-credential-oauth`,
`git-credential-manager` (GCM), `tea`, `gitea-app`, `gitea-vscode` — each with
hard-coded redirect URIs (`http://127.0.0.1` loopback pairs, the mobile app's
`com.gitea.app://oauth/callback`, the vscode deep links). These exist so
`git credential` OAuth (GCM's flow, git-credential-manager#1442) works out of the
box, which is also why the git-HTTP realm flips (§2.11).

Port decisions (Workers adaptation, recorded):

- **Seed via migration** (INSERT OR IGNORE on the `client_id` UNIQUE index) with the
  exact client IDs and redirect URI lists above, `uid=0`, confidential_client=false
  (they are native apps).
- **Locked semantics** carried as the same fixed client-ID set constant:
  edit/update/delete/refuse for builtin IDs (upstream `UpdateOAuth2Application` /
  `DeleteOAuth2Application` lock checks, `oauth2.go:330–334, 391–396`).
- The config-driven add/remove dance (`Init`'s `DEFAULT_APPLICATIONS` reconciliation)
  is **not** ported — cf-gitea has no runtime settings seam; the seeded set is the
  upstream default set. Removing one is a future migration/edit concern, recorded
  here so it is not silently re-decided.

### 2.10 The signing key

Upstream (`services/oauth2_provider/jwtsigningkey.go`):

- `[oauth2] JWT_SIGNING_ALGORITHM`, default **RS256** (`modules/setting/oauth2.go:108`);
  accepted set: HS256/384/512, RS256/384/512, ES256/384/512, EdDSA
  (`CreateJWTSigningKey`, :240–295). `EdDSA` keys are Ed25519; ES384/ES512 pick
  P-384/P-521; RS keys generate at **4096** bits (:354).
- Key persistence: PEM PKCS#8 under AppDataPath `jwt/private.pem`
  (`LoadOrCreateAsymmetricKey`, :344–413) — created on first use, published
  atomically (temp file + `os.Link`).
- `kid` = base64url(SHA-256 over the public key fingerprint —
  `util.CreatePublicKeyFingerprint`, `util/keypair.go:48–56`), set into every token
  header (`PreProcessToken`).
- HS algs use `[oauth2] JWT_SECRET` (the general signing secret, :305–311).
- **Actions OIDC uses a separate key** (`jwt/actions_oidc.pem`,
  `services/actions/oidc.go:45`) — two distinct keypairs per instance.

cf-gitea adaptation (decisions):

- **Native WebCrypto JWS, zero dependencies.** The signer module implements
  compact-JWS sign/verify over the WebCrypto algorithms cf-gitea already proves in
  production code paths: `RSASSA-PKCS1-v1_5` (Actions OIDC id_tokens
  `services/actions/secrets.ts` — RS256 sign + JWKS publish + the fake-runner E2E;
  distro-common's `rsaSign`/`importRsaPrivateKey`), `ECDSA` (ES256) and `HMAC`
  (HS256) are the same primitive family (`crypto.subtle.sign/verify` with
  `importKey("jwk")`). **EdDSA is deferred** (workerd Ed25519 exists but zero house
  precedent; non-default upstream config arm) — the algorithm table validates the
  full upstream set but rejects `EdDSA` with the recorded-deferrence error until a
  wave proves it.
- **`OAUTH2_SIGNING_ALGORITHM` var** (default "RS256") validated at startup against
  the upstream set; anything outside it fails closed (the Actions OIDC signer's
  posture).
- **RSA modulus 2048, not upstream's 4096** — the recorded Workers-cost divergence,
  matching the landed Actions OIDC and distro-common keys (both 2048; 4096-bit
  WebCrypto keygen is the slow path on workerd). Documented in §4 like its
  predecessors.
- **Key storage: a `system_keystore` row** — `oauth2_signing_key`, NOT
  `user_settings_kv`. Rationale: `user_settings_kv` is per-principal material (the
  debian keypair precedent is owner-scoped); the OAuth2 signing key is instance-wide
  crypto material, exactly the tenant the landed `system_keystore` table was created
  for (schema.ts:4248–4259, migration 0042; the Actions OIDC key's row
  `actions_oidc_signing_key` is the direct precedent). Upstream parity holds: the
  OAuth2 key and the Actions OIDC key remain **distinct rows** (upstream :45 keeps
  distinct files). Row JSON shape mirrors the Actions row: `{v:1, alg,
  oidcPrivateJwk-style privateJwk + kid}`. Generation is get-or-create on first use
  with insert-or-nothing + read-back arbitration (the schema comment's
  "strictly stronger than upstream's temp-file + os.Link" dance — a D1 row is never
  observable half-written).
- **No key rotation UI in v1.** Upstream has none either (rotation = replace the
  file/restart); rotation invalidates all outstanding tokens (the keystore table's
  operator-only-update posture records this).
- **HS deployments**: `JWT_SECRET`'s role is served by the existing
  `general_token_signing_secret` keystore row (the landed `tokenSigningSecret`
  piece — `secrets.ts` module header) exactly as upstream reuses `GetGeneralTokenSigningSecret`.
  RS256 stays the default and the recommended arm; the discovery document publishes
  only the configured alg, so HS deployments get upstream's (deliberately broken for
  third-party OIDC clients) JWKS-for-oct behavior — parity preserved, don't "fix" it.

> **As-built (W1, 2026-10-31):** the key lives at `services/oauth2/keys.ts`
> and the JWS primitives at `services/oauth2/jws.ts`. Three implementation
> discoveries recorded: (1) workerd validates a JWK's `key_ops` against the
> requested usages on `importKey`, so every import strips the transport
> members (`key_ops`/`ext`) and the public-JWK half never inherits the
> private key's `["sign","verify"]` — pinned in-suite; (2) the stored row's
> alg is family-checked against the configured one and a mismatch fails
> closed with "rotate the keystore row" named (upstream's startup
> type-check analog, jwtsigningkey.go:240–295); (3) the HS arm reuses the
> Actions module's 32-byte-hex recipe on a cold shared row
> (insert-or-nothing + read-back — whichever module reaches it first wins,
> the loser adopts), and never touches the `oauth2_signing_key` row.

### 2.11 The gate + the git-HTTP realm flip

- Upstream gate: `setting.OAuth2.Enabled` (default **true**); `oauth2Enabled`
  middleware ⇒ 403 on the whole `/login/oauth` group (`web.go:373–378, 631`);
  `OIDCWellKnown` self-gates to 404 (`oauth2_wellknown.go:17–20`); the settings
  template hides the OAuth2 sections on `.EnableOAuth2` false
  (`applications.tmpl:5`).
- cf-gitea gate: the **`OAUTH2_ENABLED` wrangler var**, strict polarity, default
  `"true"` (parity with the upstream default; the house env-var pattern —
  `ALLOW_SIGNUP`, `PACKAGES_ENABLED` in wrangler.jsonc.example). False ⇒ 403 on
  `/login/oauth/*`, 404 on `/.well-known/openid-configuration`, the settings OAuth2
  sections + navbar item hidden, and (see below) the git-HTTP realm reverts.
- **The realm flip (changes a landed constant):** git-HTTP's 401 challenge is
  currently pinned to the OAuth2-**disabled** arm
  (`Basic realm="Gitea (Basic Auth)"`, SPEC-0002 §2.6 + SPEC-0003 §2.4 row — chosen
  when no provider existed so GCM's OAuth2 attempt was broken on purpose). Upstream
  switches on the gate (`routers/web/repo/githttp.go:146–159`): provider enabled ⇒
  `Basic realm="Gitea"` (GCM then drives its builtin OAuth2 application —
  git-credential-manager#1442); disabled ⇒ the current constant. This SPEC flips
  that string per the `OAUTH2_ENABLED` var and updates the SPEC-0003 matrix row +
  the landed realm test to the conditional form. **The flip is only meaningful once
  the builtin applications exist (§2.9) — seed + flip land in the same wave.**

## 3. Data model

Drizzle schema (`src/db/schema.ts`), D1; conventions per SPEC-0002 §3 (unix-second
timestamps, boolean-mode integers). **Migration: 0052** (next after the landed
0051), one drizzle-generated drop carrying all three pieces below (the two new
tables are inert until the flow waves read them; the sessions column is additive).

```ts
/** Upstream OAuth2Grant (gitea/models/auth/oauth2.go:504–514) — the
 *  permission of one user for one application. UNIQUE(user, application):
 *  one grant per pair, re-consent updates scope in place. */
export const oauth2Grants = sqliteTable('oauth2_grant', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  applicationId: integer('application_id').notNull()
    .references(() => oauth2Applications.id, { onDelete: 'cascade' }),
  /** Refresh-rotation counter; NOT NULL DEFAULT 1 (oauth2.go:509). Only
   *  moved under InvalidateRefreshTokens via the compare-and-increment
   *  UPDATE (WHERE counter = old) — a zero-rows answer is the stale-token
   *  signal (oauth2.go:545–559). */
  counter: integer('counter').notNull().default(1),
  /** The mixed scope string (§2.5) — general + normalized access scopes,
   *  space-joined. */
  scope: text('scope').notNull().default(''),
  /** OIDC nonce replayed into the id_token (oauth2.go:511). */
  nonce: text('nonce').notNull().default(''),
  createdAt: integer('created_unix', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_unix', { mode: 'timestamp' }).notNull(),
}, (t) => [
  // upstream xorm INDEX unique(user_application) (oauth2.go:506–508)
  uniqueIndex('oauth2_grant_user_application_uq').on(t.userId, t.applicationId),
]);

/** Upstream OAuth2AuthorizationCode (oauth2.go:403–412) — one-time, 10-minute
 *  TTL. Consumption IS the DELETE (rowcount 0 ⇒ replay). */
export const oauth2AuthorizationCodes = sqliteTable('oauth2_authorization_code', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  grantId: integer('grant_id').notNull()
    .references(() => oauth2Grants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  /** PKCE: "" = no PKCE on this code. */
  codeChallenge: text('code_challenge').notNull().default(''),
  codeChallengeMethod: text('code_challenge').notNull().default(''),
  redirectUri: text('redirect_uri').notNull().default(''),
  validUntil: integer('valid_until', { mode: 'timestamp' }).notNull(),
}, (t) => [
  uniqueIndex('oauth2_authorization_code_code_uq').on(t.code),
  index('oauth2_authorization_code_valid_until_idx').on(t.validUntil),
]);

// sessions table gains one additive column (SPEC-0010 §3 extension):
//   /** OAuth2 authorize-dance state (this SPEC §2.2): JSON
//     {client_id, redirect_uri, state, scope, nonce, code_challenge,
//      code_challenge_method} between GET /authorize and POST /grant;
//     read-and-cleared by /grant; NULL otherwise. */
//   oauthState: text('oauth_state'),
```

Decisions:

- **Grant scope is denormalized state, the token carries none of it** — parity
  (§2.4): revocation is a row delete, scope change is an UPDATE; both take effect on
  the next API request without touching outstanding JWTs.
- **`ON DELETE CASCADE` on grant_id/application_id**: upstream deletes codes and
  grants explicitly inside `deleteOAuth2Application`'s transaction
  (`oauth2.go:356–383`) and `DeleteOAuth2RelictsByUserID`; D1 foreign-key cascade
  collapses the same observable state into the schema (the
  `oauth2Applications`-referencing FK matches the landed table's ownership; drop the
  explicit cascade statements from the ported delete path).
- **The consent state lives on the session row, not KV, not a hidden field**
  (§2.2/§3 sessions column). Upstream stashes it in the session store
  (`oauth2_provider.go:271–295, 378–395`) and re-checks it at POST /grant
  (:411–415) — binding consent to the live session is the security property
  (a captured consent page is useless after logout/session rotation). A separate
  short-TTL table was considered and rejected: SPEC-0010's session row already has
  the identity, the idle-TTL and the cascade path; one nullable column is the
  minimal upstream-faithful home. The JWT signing key never enters this state.
- **Code format**: upstream's `gta_` prefix + 32 crypto-random bytes lowercased
  base32 unpadded (`GenerateNewAuthorizationCode`, `oauth2.go:522–542`) — reuse the
  landed `base32LowerEncode` from `services/oauth2-apps.ts`; the column is
  UNIQUE-indexed for the token endpoint's lookup.
- **No access-token/refresh-token tables** — parity: the JWTs are stateless; the
  grant row is the only server-side state (upstream stores nothing per-token; the
  `Access_token` table upstream is the PAT table, unrelated).
- **No `oauth2_grant`-scope validation against the application** — parity: the
  frozen contract defines no application-level scope field (the landed
  `oauth2-apps.ts` header records this); requested scopes are normalized
  (invalid words dropped) and stored on the grant.

### 3.1 DDL sketch (migration 0052, drizzle-generated shape)

```sql
CREATE TABLE `oauth2_grant` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` integer NOT NULL,
  `application_id` integer NOT NULL,
  `counter` integer DEFAULT 1 NOT NULL,
  `scope` text DEFAULT '' NOT NULL,
  `nonce` text DEFAULT '' NOT NULL,
  `created_unix` integer NOT NULL,
  `updated_unix` integer NOT NULL,
  FOREIGN KEY (`application_id`) REFERENCES `oauth2_application`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE UNIQUE INDEX `oauth2_grant_user_application_uq` ON `oauth2_grant` (`user_id`,`application_id`);

CREATE TABLE `oauth2_authorization_code` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `grant_id` integer NOT NULL,
  `code` text NOT NULL,
  `code_challenge` text DEFAULT '' NOT NULL,
  `code_challenge_method` text DEFAULT '' NOT NULL,
  `redirect_uri` text DEFAULT '' NOT NULL,
  `valid_until` integer NOT NULL,
  FOREIGN KEY (`grant_id`) REFERENCES `oauth2_grant`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE UNIQUE INDEX `oauth2_authorization_code_code_uq` ON `oauth2_authorization_code` (`code`);
CREATE INDEX `oauth2_authorization_code_valid_until_idx` ON `oauth2_authorization_code` (`valid_until`);

ALTER TABLE `sessions` ADD `oauth_state` text;
```

Plus the builtin-application seed rows (§2.9) appended to the same migration with
`INSERT OR IGNORE` (exact client IDs + redirect URIs from
`models/auth/oauth2.go:68–101`).

> **As-built (W1, 2026-10-31):** migration landed as `0052_redundant_zarek`
> (drizzle-generated from the §3 schema exactly — both tables + the
> `sessions.oauth_state` ALTER — with the §2.9 seed appended as five
> `INSERT OR IGNORE` statements keyed on the `client_id` UNIQUE index,
> `uid=0`, `confidential_client=0`, empty `client_secret`, `unixepoch()`
> stamps; the seed lines carry the upstream cite inline). A repo-watch
> sibling's migration lands after this one and numbers 0053 — expected.

## 4. Edge cases, limits, failure modes

1. **Code replay** — the DELETE rowcount is the guard (§2.3 step 8): second
   presentation ⇒ `invalid_grant` "authorization code already used". Race: two
   concurrent redemptions — D1 serializes the DELETE; exactly one gets `changes:1`.
   No transaction needed beyond the single statement (the "transactional
   consumption on D1, NOT KV" rule satisfied by the rowcount itself).
2. **Expired code** — invalidated on discovery (`:668–675`); a code one second past
   `valid_until` dies; `valid_until` zero (never happens here, upstream defends) dies.
3. **PKCE mismatch matrix** — verifier missing on a challenged code, wrong verifier,
   wrong method spelling at authorize (anything outside `S256|plain` including
   uppercase), public client without PKCE ⇒ all `invalid_request` at authorize /
   `unauthorized_client` at exchange, per §2.2/§2.3. S256 computation:
   BASE64URL(SHA256(ASCII(verifier))) — no padding (`oauth2.S256ChallengeFromVerifier`
   semantics, RFC 7636 §4.2).
4. **redirect_uri** — three distinct checks (registered-list membership at authorize;
   equality with the code's stored value at exchange; registered-list membership at
   exchange when presented). Loopback port-stripping applies ONLY to public clients
   and ONLY at the membership check — the equality check compares raw strings.
5. **Client-secret failures** — confidential client + wrong/empty secret at either
   grant type ⇒ `invalid_client`/`unauthorized_client` with the two distinct
   messages (`:577–589` vs `:642–652` — refresh says `invalid_client`,
   authorization_code says `unauthorized_client`; port verbatim). PBKDF2 verify is
   ~100k-iteration CPU per token-exchange attempt — acceptable at exchange frequency,
   and the auth_failures limiter (SPEC-0002 §2.7) bounds brute-force. Basic-header
   credentials are form-urlencoded before comparison (RFC 6749 §2.3.1;
   `parseClientSecretBasic`).
6. **Refresh reuse** — default (InvalidateRefreshTokens=false): reusable; the
   `cnt` claim rides along inert. If the var is ever set true: the
   compare-and-increment UPDATE (WHERE counter = old) is the optimistic lock; a
   stale `cnt` ⇒ `unauthorized_client` "token was already used" and the grant's
   counter has already moved — the stolen token is dead.
7. **Clock skew** — zero leeway both directions (§2.4); a client clock in the past
   (iat > now) rejects just like an expired exp. No config knob (upstream has none).
8. **Grant deletion / scope update kills live tokens** — the access JWT's only
   authority anchor is `gnt`; userinfo/introspection/API all fail after deletion.
   Deleting an application cascades grants and codes (§3 FK).
9. **Signing-key loss/rotation** — tokens signed by a replaced key stop verifying
   (single-key JWKS; upstream identical). The keystore row is write-once by code;
   operator rotation is a manual D1 edit (documented in the row's comment) — the
   Actions OIDC posture verbatim.
10. **`alg` confusion** — `ParseToken` analog pins the expected alg before verify;
    `none`/`HS256`-with-public-key attacks are structurally excluded.
11. **Open redirects** — every error path either renders `grant_error` (no
    redirect) or redirects only to a URI that passed `ContainsRedirectURI`;
    `redirect_uri` from the POST /grant form must equal the session-stashed one
    (§2.2 step 9) before it is ever redirected to.
12. **Consent-page CSRF** — POST /grant is session-authenticated AND must match the
    session-stashed `client_id/state/redirect_uri`; the landing also rides the
    SPEC-0010 `sameOriginGuard` like every other UI POST. (Upstream's CSRF story at
    the pin: none — SPEC-0002 §2.8 records the pin dropped the CSRF token; our
    sameOriginGuard is the house posture, a disclosed strengthening.)
13. **Anonymous/2FA** — `reqSignIn` redirects anonymous browsers to the login page
    (the dance resumes via SPEC-0010's `redirect_to`); the 2FA pre-check slot is a
    no-op predicate until 2FA exists.
14. **Multi-instanceWorkers** — the signing key is a D1 row: every isolate verifies
    and signs with the same material; no per-isolate key drift (the R2/file-based
    upstream dance exists precisely because Gitea can share a data dir across
    processes — D1's row arbitration is the strictly-stronger analog, already argued
    in the keystore table's comment).
15. **Disabled gate** — every endpoint 403/404 (§2.11); the settings sections hide;
    the git-HTTP realm reverts to `Basic realm="Gitea (Basic Auth)"`; seeded builtin
    rows become unreachable (no authorize endpoint) but remain in the table.
16. **Documented divergences (complete list)** — (a) client-secret hashing PBKDF2
    instead of bcrypt (already landed in `oauth2-apps.ts`; §1's module header is the
    authority); (b) RSA 2048 vs 4096 (§2.10); (c) EdDSA rejected-until-proven
    (§2.10); (d) `DEFAULT_APPLICATIONS` config dance not ported (§2.9); (e) no
    query-param token extraction on `/api/v1` (§2.7, consistent with SPEC-0002);
    (f) sameOriginGuard added on consent POST (§4.12); (g) the token endpoint
    accepts form-urlencoded per RFC 6749 — upstream's JSON arm is accepted too when
    trivially available via the same body parser, but form is the contract tested.
    Each is recorded here per AGENTS.md; the SPEC is their canonical home.

## 5. Testing plan

Vitest in workerd with real D1 (`@cloudflare/vitest-plugin`, ADR-0001 D4). Time
travels via injectable `now` (the house convention). Fixtures: upstream's own test
vectors — `models/auth/oauth2_test.go` (grant/code/secret semantics),
`services/oauth2_provider/jwtsigningkey_test.go` (key/kid/JWK shapes),
`additional_scopes_test.go` (scope normalization), `routers/web/auth/oauth2_provider_test.go`
(handler arms), `routers/web/auth/oauth2_wellknown_test.go`.

- **JWS unit** (`services/oauth2/*`): sign→verify round-trip for RS256/ES256/HS256
  over real WebCrypto; `kid` equals base64url(SHA-256(SPKI DER)) (the Actions row's
  exact recipe); alg-pinning rejects a token whose header alg differs; a tampered
  payload fails; expired/`iat`-in-future tokens fail with zero leeway; the HS
  id_token path signs with the client secret and the JWKS omits secret material.
- **Keystore**: get-or-create races (concurrent first-use) answer one row (the
  insert-or-nothing + read-back); the Actions row is untouched — two distinct rows,
  two distinct kids.
- **Grant/code store**: create-grant idempotence on the UNIQUE pair; scope update;
  nonce set; code insert + 10-minute TTL boundary; consumption DELETE returns the
  row once, second call is the replay signal; expired-code invalidation.
- **Token endpoint matrix** (§2.3): happy authorization_code (form + Basic client
  auth + the disagreement arm); confidential-without-secret,
  wrong-secret/empty-secret messages verbatim per grant type; unknown client_id;
  unregistered redirect_uri at exchange; redirect_uri != the code's;
  cross-client code; replay; expired; PKCE S256 (computed with WebCrypto in-suite)
  + plain + missing-verifier + wrong-verifier; refresh happy path (fresh pair, same
  counter), wrong-kind (access-as-refresh), foreign-client refresh, counter-mismatch
  under InvalidateRefreshTokens=true incl. the stale-CAS zero-rows arm;
  `unsupported_grant_type`; the full RFC 6749 §5.2 error body shape at 400.
- **Token response shape**: `expires_in` 3600, `scope` normalized string,
  `id_token` presence iff `openid`, id_token claims per scope (profile/email/groups
  with org:team names), `iss` = AppURL sans trailing slash, `aud` = client_id,
  `sub` = user id, `nonce` echoed; refresh token `cnt` carried.
- **Scope normalization table** — port the upstream fixtures: general scopes kept
  verbatim; comma-joined access words expanded; empty access part ⇒ `all`
  authority; all-invalid ⇒ `no-token-scope`; `public-only` interplay.
- **Authorize dance** (handler-level, session-less core exercised with the session
  harness): the §2.2 decision table (unknown client, bad redirect URI,
  unsupported response_type/challenge method, public-no-PKCE, auto-consent path,
  consent path, denied path with the `access_denied` redirect, session-mismatch 400,
  added-scope diff), plus the golden DOM snapshot for the consent page (SPEC-0008
  §5.2 process) and the `grant_error` page.
- **userinfo/introspect/keys/well-known**: userinfo with a PAT ⇒ 401 (not an OAuth2
  token); with an OAuth2 token lacking `read:user` ⇒ 403; groups content;
  introspection's Basic-only 401, inactive-200 for junk/foreign tokens, active shape
  without exp; JWKS members per key type; discovery against the exact upstream key
  set (`oauth2_wellknown.go:25–67`), issuer equality.
- **Auth-method integration**: `/api/v1/user` with an OAuth2 Bearer JWT resolves the
  doer + grant scope through the landed `apiScopeGate` (scope-gate matrix stays
  green unchanged); a refresh token (kind 1) as Bearer ⇒ 401; git HTTP
  `info/refs` with a `read:repository` grant pulls a public/private repo per the
  SPEC-0003 matrix; the realm flip assertion per `OAUTH2_ENABLED` polarity.
- **Gate**: `OAUTH2_ENABLED="false"` ⇒ 403 on the group, 404 on discovery, hidden
  settings sections, realm reverts.
- **Builtin seed**: the five rows exist post-migration with the exact client IDs;
  edit/delete of a builtin ID is refused; GCM-shaped flow (loopback redirect_uri
  with port) passes membership for public clients.
- **Live battery (deploy-probes arm, the house real-client round-trip)**: a scripted
  third-party client — generate a PKCE verifier/challenge, drive GET
  `/login/oauth/authorize` for a seeded builtin client, approve via the consent POST
  (session cookie captured by the probe), follow the 303, exchange the code at
  `/access_token` (form + Basic both), call `/api/v1/user` with the access token,
  call `/userinfo`, fetch `/keys` and verify the access token's signature offline
  against the JWKS, refresh, introspect, revoke the grant in the settings UI and
  watch the token die. This is the packages-protocols battery pattern (real client
  bytes end-to-end). A real headless `git credential` OAuth run is recorded as
  manual-only (needs an interactive browser) — the probe's scripted client stands in
  for the protocol bytes.

## 6. Wave decomposition (dispatchable units for the v1.4 implementation waves)

Dependency order: W1 → (W2, W3) → W4 → W5; W6 rides each wave's gates plus the
final battery. `src/index.ts`/`ui/index.ts` mount registrations ride the
orchestrator's registration windows (house rule — units hand off mounts, they do
not edit the shared index themselves).

- **W1 — substrate: tables, keystore, signer, store** (migration 0052 owner).
  Owns: the migration (two tables + `sessions.oauth_state` + builtin seed rows),
  `db/schema.ts` additions, `services/oauth2/keys.ts` (keystore row
  `oauth2_signing_key`, get-or-create, kid, JWKS render),
  `services/oauth2/jws.ts` (compact JWS sign/verify, alg table, EdDSA-rejects),
  `services/oauth2/grants.ts` (grant/code store: create/update-scope/set-nonce/
  find/consume/increase-counter + the `gta_` code format reusing the landed base32).
  Gates: JWS/keystore/store suites green, tsc 0, eslint clean, `pnpm db:generate`
  output = 0052 only.
  **LANDED 2026-10-31** — migration `0052_redundant_zarek` (as-built note in
  §3.1), the three services + suites under `services/oauth2/`; suites green
  (jws 24/24, keys, grants — counts in the wave report), tsc 0 in W1 files,
  eslint clean. One disclosed deviation: the `gta_` base32 encoder is
  duplicated from `oauth2-apps.ts:91` (module-private there, this module is
  ownership-separated — upstream itself spells the encoder once per model
  file). ES256's JOSE-raw signature alignment is pinned in-suite against
  RFC 7515 appendix A.3's fixed vector.
- **W2 — token endpoint + auth method** (depends W1). Owns:
  `web/oauth2-token.ts` (or `ui/` per the mount family — the orchestrator's
  registration window decides the file home): POST `/login/oauth/access_token`
  (§2.3 both grant types, client auth, PKCE verify, error bodies),
  `POST /login/oauth/introspect`, `GET/POST /login/oauth/userinfo`,
  `GET /login/oauth/keys`; the auth-method extension in `src/auth` (Bearer-with-
  dots dispatch + `GetOAuthAccessTokenScopeAndUserID` port) feeding the landed
  `apiScopeGate` unchanged. Gates: token-matrix + userinfo/introspect suites; the
  scope-gate matrix untouched-green.
- **W3 — authorize + consent** (depends W1). Owns: GET/POST
  `/login/oauth/authorize` + POST `/login/oauth/grant` handlers, the session-state
  column read/write via the SPEC-0010 session seam, `ui/pages/oauth2-grant.tsx`
  (consent page + `grant_error`, golden DOM snapshots), the
  `ContainsRedirectURI` port (with the public-client loopback arm) as a shared
  service (consumable by W2's exchange check). Gates: dance decision-table suite,
  goldens, a11y smoke.
- **W4 — discovery, gate, realm flip** (depends W2). Owns: GET
  `/.well-known/openid-configuration`; the `OAUTH2_ENABLED` var plumbing
  (strict polarity, example-config entry), the endpoint gating, the settings
  template/navbar gate value, the git-HTTP realm conditional + the SPEC-0003 matrix
  row update + the landed realm test flip (the disclosed integration hunk —
  attribute it in the wave brief so the commit message says so). Gates:
  discovery-shape suite, gate suite, the git-HTTP suite re-baselined for the
  conditional realm.
- **W5 — settings UI halves** (depends W1; parallel to W2–W4). Owns: the
  `applications.tmpl` OAuth2 halves on the user settings page (list section, edit
  page with the secret-shown-once arm, regenerate-secret POST, delete), the grants
  section + revoke POST; extends `user-settings-applications.tsx` within its
  recorded deferral note (the note retires with this wave); org page's
  edit/regenerate arms only if its brief staged them. Gates: goldens + a11y +
  the CRUD round-trip suite over the landed service.
- **W6 — the battery + docs tail** (last). Owns: the deploy-probes OAuth2 battery
  arm (§5 live battery), the upstream-fixture sweep across all suites, the SPEC's
  as-built amendments, the SPEC-0002 §2.8 deferral-note retirement. Gates: full
  battery green, `pnpm check:api` PASS, SPEC as-built current.

Shared-file discipline: `wrangler.jsonc.example` (`OAUTH2_ENABLED`,
`OAUTH2_SIGNING_ALGORITHM`) and the git-HTTP realm constant are the two cross-wave
shared hunks — W4 owns both; W1–W3/W5 never touch them.

## Open questions (resolve before or during implementation)

1. **Route file home for `/login/oauth/*`** — the UI router (SPEC-0010's
   `sessionRouter` family, where `/login` lives) vs a dedicated `web/` module.
   Recommend the UI router family: the authorize endpoints ARE session-bound UI
   pages; the token/introspect/userinfo/keys arms are stateless JSON and can sit in
   the same family with `resolveUiSession` skipped. Decide at W2/W3 dispatch.
2. **Org settings edit/regenerate arms** — landed org page carries create/delete
   only; confirm at W5 dispatch whether its brief staged the remaining arms (the
   upstream org twin shares all handlers).
3. **`iat` enforcement on refresh tokens** — upstream checks `iat` only in the API
   auth path (`services/auth/oauth2.go:53`), not in `ParseToken` at the refresh
   flow; port the asymmetry verbatim (no smoothing).
4. **Admin global-applications write arms** — out of scope (§2.8) unless the W5
   wave finds them trivial over the shared service; keep the landed list-only
   reduction recorded either way.
