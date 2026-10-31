# SPEC: External auth sources — OAuth2/OIDC login clients over the `login_source` model

Status: draft (written 2026-10-31 for the v1.4 implementation waves; not yet ratified)
Upstream pin: `fc4936884584` (`gitea/` submodule, READ-ONLY)
Reopens: SPEC-0018 §3.3 (the auths omission verdict — its own reopen gate,
"superseded the day a SPEC lands any external login chain", fires with this
document; the amendment recording the re-opening rides §1 and the SPEC-0018
as-built tail). Sibling of [specs/oauth2-provider.md](oauth2-provider.md):
that SPEC's §1 explicitly named "OAuth2 as CLIENT (sign-in *via* a foreign
provider)" out of scope — "a separate future SPEC". This is that SPEC.
Depends on: SPEC-0010 (the session — the mint seam and the callback-state
column pattern), SPEC-0002 (the credential posture this SPEC extends),
SPEC-0007 (users/orgs — the account ladder and the individual-user
predicate), the landed OAuth2 provider substrate (`services/oauth2/jws.ts` —
the WebCrypto JWS verifier this SPEC's ID-token check reuses, landed with
the provider SPEC's W1, migration 0052), SPEC-0018 (the reopened admin-CRUD
forward note — the auths arm is a WEB CRUD, never an API-first ladder).

---

## 1. Problem and scope

cf-gitea has exactly one authentication path: the PAT-as-credential login
(SPEC-0010 §2.2 over SPEC-0002's token model) — no password store, no
external identity, no pluggable login chain (SPEC-0018 §2.3 priced exactly
this absence). Upstream Gitea carries the whole pluggable surface:
`login_source` rows ("an external way for authorizing users",
`models/auth/source.go:109`) over a seven-value type lattice, an
`external_login_user` join, the `/user/oauth2/{provider}` sign-in flow, the
link-account page, and the admin `/-/admin/auths` web CRUD
(`routers/web/web.go:874-880`). SPEC-0018 §3.3 recorded the surface as a
documented omission with an explicit reopening gate; the gate has now fired
(user direction, 2026-10-31 — the surface re-opened for the v1.4 queue), and
this SPEC makes the design call the gate demands.

**The viable-set verdict (§3 adjudicates each type against the platform,
with cites):** the OAuth2 login-source type (upstream type 6) is the v1.4
target — generic OpenID Connect via auto-discovery, plus named GitHub and
Google clients. LDAP (2/5) and SMTP (3) are adjudicated
viable-in-principle / deferred-by-economics-and-fit (outbound TCP exists;
everything else about them argues against v1). PAM (4) and SSPI (7) are
platform-impossible, not deferred — adjudicated with cites so no future
dispatch re-litigates them. Plain (1) is not a login source; it is the
posture cf-gitea already is.

In scope:

- The `login_source` + `external_login_user` D1 tables (§4) and the typed
  config codec for the OAuth2 client source record (§2.2).
- The OAuth2/OIDC client flow: source-button login, the
  `/user/oauth2/{source}` + `/user/oauth2/{source}/callback` routes, the
  state/CSRF dance over SPEC-0010's session, ID-token verification reusing
  the landed `verifyJws`, the userinfo fallback for non-OIDC providers
  (§5).
- The identity resolution + account-linking posture: the
  `external_login_user` lookup chain, the link-account page family
  (`/user/link_account*`, web.go:597-599), the user-settings account-links
  section, the interplay with the `ALLOW_SIGNUP` gate and the zero-user
  admin-init window (§5.5).
- The admin auths surface as the upstream-shape **WEB CRUD**
  (`/-/admin/auths` list/new/edit/delete — §6), with the SPEC-0018
  forward note enforced: **no `/api/v1/admin/auths` family exists upstream
  at the pin or at main** (SPEC-0018 as-built points 1-2 — 350 paths,
  zero auths entries, both swaggers, plus the live main fetch), and
  `check-openapi.mjs` hard-fails any declared path absent from the frozen
  contract — an API ladder would be an invention requiring its own
  reverse-divergence record. The page family rides `adminPagePrologue`.
- The login page's source buttons and the `AdminFamilyNav` auths item
  (both option-gated, goldens byte-stable — §5.6, §6.4).

Out of scope (each recorded so it is not silently re-decided):

- **LDAP (type 2) and DLDAP (type 5)** — deferred, not judged impossible
  (§3.2): outbound TCP + StartTLS exist on Workers (`connect()` from
  `cloudflare:sockets`), but enterprise directories are private-network
  addresses the platform disallows, no BER/ASN.1 LDAP client exists in the
  house substrate, and upstream's LDAP arm carries a sync engine this SPEC
  does not want to owe. Reopens on a concrete deployment need that accepts
  the public-LDAP-only posture.
- **SMTP (type 3)** — deferred (§3.3): same transport class as LDAP
  (`net.Dial("tcp", …)` upstream, `services/auth/source/smtp/auth.go:63`),
  and it resurrects a password-form login the PAT posture deliberately
  replaced (the login page's credential-label divergence,
  `src/ui/pages/login.tsx:1-23`).
- **PAM (type 4) and SSPI (type 7)** — platform-impossible, permanent for
  this substrate (§3.4): PAM is a CGO binding to the host OS's PAM stack
  (`modules/auth/pam/pam.go:6-8`, build tag `pam`,
  `github.com/msteinert/pam/v2`; a stub without the tag); SSPI is the
  Windows Security Support Provider Interface (SPNEGO/IWA —
  `source.go:56` "SPNEGO with SSPI"). workerd runs neither.
- **Plain (type 1)** — not an external source; the internal database auth
  upstream's `GetSourceByID` synthesizes for id 0
  (`source.go:292-299`). cf-gitea's PAT posture IS this type's function;
  no row, no build.
- **Legacy OpenID sign-in** (`EnableOpenIDSignIn`, the OpenID 2.0 surface
  at `routers/web/auth/openid.go`) — distinct from the OIDC **client
  source**; upstream maintains it as a separate legacy system. Out of
  scope; the OIDC-discovery client (§2.3) covers the modern protocol.
- **The group→team claim sync, admin/restricted group claims, SSH
  public-key claim sync** (`GroupClaimName`, `AdminGroup`,
  `GroupTeamMap`, `GroupTeamMapRemoval`, `RestrictedGroup`,
  `SSHPublicKeyClaimName`, `FullNameClaimName` —
  `services/auth/source/oauth2/source.go:24-35`) — upstream's
  deepest OAuth2-source features, all riding the sync engine. Deferred
  whole; the v1 config record carries none of these fields (§4.2).
  `oauth2SignInSync`/`source_sync.go` (the token-refresh cron and the
  invalid_grant user-disable arm) defer with them.
- **Auto-registration** (`[oauth2_client] ENABLE_AUTO_REGISTRATION`,
  default false upstream) — v1 ships upstream's default posture: an
  unknown external identity lands on the link-account page (§5.5); the
  auto-register arm is a recorded follow-up, not silent absence.
- **2FA interplay** (`TwoFactorPolicy`, `handleOAuth2SignIn`'s
  `needs2FA` gate, `oauth.go:351-358`) — cf-gitea has no 2FA; the config
  column is carried as an inert slot (§4.1) so the re-pin finds it.
- **`git credential` OAuth against foreign IdPs** — the provider SPEC's
  builtin applications serve git-credential flows against OUR provider;
  consuming an external IdP for git-HTTP credentials is a later arm,
  recorded here so it is not silently folded into the client flow.
- **The provider client lattice beyond OIDC + GitHub + Google** — the
  config registry records the full upstream provider list with per-provider
  executable status (§2.3); v1 implements three. Adding one is a small
  client module (§2.3's table), not a SPEC.

## 2. Surface (upstream behavior is the default decision; every row carries its pin cite)

### 2.1 The login-source model (`models/auth/source.go`)

- The type lattice, seven values, append-only for wire compatibility
  (`source.go:27-37`): `NoType 0, Plain 1, LDAP 2, SMTP 3, PAM 4, DLDAP 5,
  OAuth2 6, SSPI 7`; display names at `:50-57` ("LDAP (via BindDN)", "LDAP
  (simple auth)", "SMTP", "PAM", "OAuth2", "SPNEGO with SSPI").
- The `Source` struct (`:109-121`, table `login_source`, `:124-126`):
  `ID`, `Type`, `Name` (**UNIQUE**), `IsActive` (indexed),
  `IsSyncEnabled` (indexed), `TwoFactorPolicy` (default `''`), `Cfg`
  (**TEXT** — the JSON-serialized typed config record), `CreatedUnix`,
  `UpdatedUnix`.
- `CreateSource` (`:218-254`): UNIQUE-name pre-check
  (`ErrSourceAlreadyExist`, `:375-387`); **sync forced off for every type
  except LDAP and OAuth2** (`:225-228` — the code contradicts its own
  comment's "only available with LDAP for now"); on an active
  `RegisterableSource` (`:94-97`), `RegisterSource()` runs at create and a
  failure DELETES the row (`:246-252`). For OAuth2 sources this is the
  goth provider registration (`services/auth/source/oauth2/source_register.go:13-22`);
  OIDC-discovery sources fail create eagerly on a bad discovery URL
  (`providers_openid.go:53-58`, wrapped as `ErrOpenIDConnectInitialize`,
  `source_register.go:24-46`). Our substrate needs no runtime provider
  registry (§5.1) — the eager-validate-then-persist discipline stays, the
  register/rollback dance does not.
- `UpdateSource` (`:312-353`): UNIQUE-name check excluding self; OAuth2
  sources keep the pre-update original so a failed re-registration
  restores it (`:314-320, :347-351`) — upstream's failure-atomicity
  posture, ported as validate-before-write (§6.2).
- `ErrSourceInUse` (`:389-402`): the delete arm refuses sources still
  attached to users (`routers/web/admin/auths.go:450`).
- `GetSourceByID` (`:292-309`): id 0 returns a synthesized **active Plain
  source** — the internal database auth is always present upstream.
- `FindSourcesOptions` (`:256-275`): filters `IsActive`/`LoginType`,
  ordered by `name`.

### 2.2 The OAuth2 client source config record

`services/auth/source/oauth2/source.go:15-35` — the JSON blob in `Cfg`:
`Provider` (the goth registry key, e.g. `openidConnect`, `github`,
`gplus`), `ClientID`, `ClientSecret`,
`OpenIDConnectAutoDiscoveryURL`, `CustomURLMapping` (per-provider
auth/token/profile/email URL overrides), `IconURL`, `Scopes []string`,
plus the §1-deferred claim/sync fields. v1 carries: `Provider`,
`ClientID`, `ClientSecret`, `OpenIDConnectAutoDiscoveryURL`,
`CustomURLMapping`, `IconURL`, `Scopes`. The claimed/deferred fields stay
**out** of the record so their absence is structural, not a zero value
that pretends to work.

The lookup the login flow uses resolves by the source's NAME, not the
provider key: `GetActiveOAuth2SourceByAuthName`
(`models/auth/oauth2.go:664-677` — `name = ? AND type = OAuth2 AND
is_active = TRUE`; miss ⇒ a not-exist error). This is why the login
buttons and the registered IdP callback URL both encode the source name
(§5.2).

### 2.3 The provider registry at the pin

Upstream's registry is a fixed set registered at init
(`services/auth/source/oauth2/providers.go:63-68` + the three files):

| Provider key | Display | Kind (pin cite) | v1 executable | Notes |
|---|---|---|---|---|
| `openidConnect` | OpenID Connect | OIDC auto-discovery (`providers_openid.go:67`) | **YES** — the generic arm; `ExternalIDClaim` support (`:55-59`) | scopes default `setting.OAuth2Client.OpenIDConnectScopes` |
| `github` | GitHub | Custom-URL (`providers_custom.go:55-70`) | **YES** | token/auth/profile/email overrides; auto-reg adds `user:email` |
| `gplus` | Google | Simple (`providers_simple.go:72-79`) | **YES** | scopes `email` (+`profile` when auto-reg/avatar); legacy `gplus` key kept for migration parity |
| `gitlab` | GitLab | Custom-URL (`providers_custom.go:71-82`) | deferred (small module — `read_user`, profile URL override) | |
| `gitea` | Gitea | Custom-URL (`providers_custom.go:83-94`) | deferred | required custom URLs |
| `nextcloud` | Nextcloud | Custom-URL (`providers_custom.go:95-106`) | deferred | required custom URLs |
| `mastodon` | Mastodon | Custom-URL (`providers_custom.go:107-117`) | deferred | required instance URL |
| `azureadv2` | Azure AD v2 | Custom-URL (`providers_custom.go:118-137`) | deferred | tenant mapping; upstream steers Azure toward OIDC |
| `aws-cognito` | AWS Cognito | OIDC-based (`providers_custom.go:124-146`) | deferred | rides the OIDC arm when it lands |
| `bitbucket` | Bitbucket | Simple (`providers_simple.go:54-61`) | deferred | scope `account` |
| `dropbox` | Dropbox | Simple (`providers_simple.go:63-68`) | deferred | |
| `facebook` | Facebook | Simple (`providers_simple.go:66-70`) | deferred | |
| `twitter` | Twitter | Simple (`providers_simple.go:80-84`) | deferred | |
| `discord` | Discord | Simple (`providers_simple.go:85-90`) | deferred | scopes identify+email |
| `yandex` | Yandex | Simple (`providers_simple.go:91-100`) | deferred | |
| `azuread` | Azure AD | Simple (`providers_simple.go:101-108`) | deferred | upstream filters the Azure trio toward OIDC (`providers.go:76-79, 110-125`) |
| `microsoftonline` | Microsoft Online | Simple (`providers_simple.go:109-116`) | deferred | same Azure-trio filter |

The admin form lists ONLY the executable set (§6.3) — offering a dropdown
item that cannot complete a login would be the SPEC-0018 §3.3
posture-line failure class. A deferred provider becomes executable by
adding its client module to the registry (§5.1's seam); the table above is
the recorded lattice so "which providers work" is never re-derived.

### 2.4 The login flow (upstream)

- **Routes** (`routers/web/web.go:768-771`): `GET /user/oauth2/{provider}`
  (`auth.SignInOAuth`) and `GET /user/oauth2/{provider}/callback`
  (`auth.SignInOAuthCallback`) — both anonymous-reachable, inside the
  `/user` group.
- **Buttons** (`templates/user/auth/external_auth_methods.tmpl:1-6`): one
  anchor per ACTIVE OAuth2 source —
  `href="{{AppSubUrl}}/user/oauth2/{{$provider.DisplayName | PathEscape}}"`
  with icon + "Sign in with {DisplayName}". The signin template renders
  the divider + block when any external method exists
  (`signin_inner.tmpl:50-56`); the signup page carries the same block
  (`signup_inner.tmpl:52`). Note the href uses the source **display
  name** (= the admin-set `Source.Name`, via
  `AuthSourceProvider.DisplayName`, `providers.go:53-55`).
- **Sign-in start** (`SignInOAuth`, `routers/web/auth/oauth.go:40-69`):
  resolve the active source by name; `rememberAuthRedirectLink`
  (`routers/web/auth/auth.go:165-180` — form `redirect_to`, else a
  same-site Referer that is not under `/user/`) parks the post-login
  destination; then the "direct callback" fast path
  (`oAuth2UserLoginCallback` — an already-valid provider session resumes
  without re-auth, `oauth.go:48-58`), else `Callout` redirects (307) to
  the provider's authorize URL (`source_callout.go:15-31`; the state is a
  fresh UUID parked in the provider session, `init.go:31-34`).
- **Callback** (`SignInOAuthCallback`, `oauth.go:89-268`): provider error
  params (`error`, `error_description`) surface as a flash
  (`:94-101`); `errCallback` codes `access_denied` /
  `temporarily_unavailable` / default redirect to `/user/login` with
  translated flashes (`:111-130`); `RequiredClaimName`/`RequiredClaimValue`
  mismatches answer the prohibit-login page (`source_authenticate.go`
  via `oauth.go:484-496`, `ErrUserProhibitLogin`). Resolution order for
  the external identity (`oauth.go:498-544`): (1)
  `GetIndividualUserByLoginSource(OAuth2, sourceID, externalID)` — the
  users-table columns (`models/user/user.go:111-113`
  `LoginType/LoginSource/LoginName`); (2) the
  `external_login_user` join (`GetExternalLogin(sourceID, externalID)`),
  **with stale-link cleanup** — a link whose user is gone or non-individual
  is deleted (`:520-541`) so the next sign-in can relink; (3) no user ⇒
  the branch ladder: a signed-in Doer ⇒ link to the CURRENT account and
  redirect to settings/security (`:133-141`); else auto-registration
  when enabled (`:144-219` — username extraction
  `extractUserNameFromOAuth2`, `auth.go:434`; missing fields ⇒ the link
  page with a `__giteaAutoRegMissingFields` marker, `:166-203`); else the
  **link-account page** (`showLinkingLogin`, `:244-268` — the
  `(sourceID, gothUser)` pair parked in the session under
  `linkAccountData`, gob-serialized). Success ends in
  `handleOAuth2SignIn` (`:346-420`): sync-on-login, the 2FA gate
  (skipped per `TwoFactorPolicy == "skip"`, `source.go:212-214`), the
  external-link upsert (`EnsureLinkExternalToUser`), the last-login
  update, the **session regeneration** with `KeyUID` +
  `SignInMethodOAuth2` (`:420-424`), then `redirectAfterAuth`.
- **Token/session length trap**: the provider response rides a session
  cookie upstream, clamped at `MaxTokenLength` = `math.MaxInt16`
  (`modules/setting/oauth2.go:110`; the "securecookie: the value is too
  long" arm, `oauth.go:475-481`). Our session-column state is D1-persisted
  (§5.3) — the trap becomes a bounds rule (§7.6).

### 2.5 The link-account page

`web.go:597-599`: `GET /user/link_account`
(`auth.LinkAccount`, `linkaccount.go:37-60`), `POST
/user/link_account_signin` (`LinkAccountPostSignIn`) and `POST
/user/link_account_signup` (`LinkAccountPostRegister`). The page reads
the parked `linkAccountData`; a miss redirects to `/user/login`
(`:42-48`). It renders two arms: sign-in-to-link (the password field —
upstream's `DisablePassword` posture per
`RequireExternalRegistrationPassword`/`AllowOnlyExternalRegistration`,
`:17-18`) and register-new-account (hidden when
`DisableRegistration`, `:39`). The signup arm runs
`extractUserNameFromOAuth2` for the pre-filled username
(`linkaccount.go:67`). Email is taken from the verified provider claim
upstream (`gothUser.Email`).

### 2.6 The external identity store (`models/user/external_login_user.go`)

`ExternalLoginUser` (`:50-70`): composite **PK (`ExternalID`,
`LoginSourceID`)**, `UserID` (indexed), `RawData` (TEXT JSON),
`Provider` (VARCHAR(25), indexed — the goth key, so lookups survive
source renames and cross-source moves), the profile fields (`Email`,
`Name`, `FirstName`, `LastName`, `NickName`, `Description`, `AvatarURL`,
`Location`), and the token fields (`AccessToken`, `AccessTokenSecret`,
`RefreshToken`, `ExpiresAt`) — plaintext TEXT upstream, consumed by the
sync engine this SPEC defers. The resolution helper
`GetUserIDByExternalUserID(provider, externalID)`
(`:131-141`) — provider-keyed. `RemoveAccountLink` (`:107-118`),
`RemoveAllAccountLinks` (`:119-124`, the user-deletion sweep),
`EnsureLinkExternalToUser` (`:161+`, the sign-in upsert).

### 2.7 The admin CRUD (web-only — the SPEC-0018 forward note)

`web.go:874-880`: `GET /-/admin/auths` (`admin.Authentications` — the
`FindAndCount` list, `auths.go:44-56`); `GET|POST /-/admin/auths/new`;
`GET|POST /-/admin/auths/{authid}` (edit); `POST
/-/admin/auths/{authid}/delete`. The create/edit form parses the typed
config per source type (`auths.go:116-233` — the OAuth2 arm is
`:168-209`); upstream has **no** `/api/v1` family for any of this
(SPEC-0018 as-built points 1-2 — verified at the pin and against live
main; the frozen-contract gate `check-openapi.mjs` would hard-fail an
invented family). The admin navbar's Identity & Access group leads with
the auths item (`templates/admin/navbar.tmpl:19`).

### 2.8 The linking semantics upstream makes configurable (and the v1 posture)

- `setting.OAuth2Client.EnableAutoRegistration` (default **false**) —
  auto-create on first external sign-in vs the link-account page.
- `setting.OAuth2Client.AccountLinking` (`modules/setting/oauth2.go:33-49`):
  `disabled` (the linked account erroring instead of linking) / `login`
  (the link page's sign-in arm decides) / `auto` (link on email match).
  **v1 ships `login`-equivalent behavior only** — §7.4 records why
  `auto` (email-matching) is a takeover hazard we do not port.
- `setting.Service.AllowOnlyInternalRegistration` /
  `DisableRegistration` (`modules/setting/service.go:37-38, 148`) — the
  link-page signup arm's gate; our analog is the `ALLOW_SIGNUP` var
  (SPEC-0010 §6.2, inverted polarity, default closed).
- `RegisterEmailConfirm`/`RegisterManualConfirm`
  (`service.go:33-34, 156`) — auto-registered users' activation; moot
  while auto-registration defers.

## 3. Workers-platform adjudication (the per-type verdicts)

Grounded, not assumed: the socket surface was verified in the pinned
dependencies and the platform docs; the compat posture comes from
`apps/worker/wrangler.jsonc.example` (compatibility_date `2026-10-23`,
**no compatibility_flags array** — TCP sockets need none; `connect()` is
a stable runtime API, not a flag).

### 3.1 OAuth2/OIDC client (type 6) — VIABLE, the v1.4 target

Pure HTTPS: the authorize redirect, the code exchange, the discovery
document, the JWKS, and the userinfo endpoints are all `fetch()` — the
same outbound class the mirror client (SPEC-0009, landed with an SSRF
allow-list secret) and the OAuth2 provider's own token machinery use.
ID-token verification reuses the **landed** WebCrypto JWS substrate
(`services/oauth2/jws.ts` — `verifyJws`/`importVerifyKey`/the alg table,
landed with the provider SPEC's W1; RS256/ES256/HS families proven
in-suite). The HS256-IdP corner verifies against the client secret as
the HMAC key — the same key-role split the provider SPEC §2.4 documents
from the other side. No platform caveat applies.

### 3.2 LDAP (2) / DLDAP (5) — viable in principle, DEFERRED (recorded, not judged impossible)

- **What the platform offers**: outbound TCP exists — `connect()`
  imported from `cloudflare:sockets`
  (`@cloudflare/workers-types@5.20261025.1`, `index.d.ts:2245`
  `connect(address: SocketAddress | string, options?: SocketOptions):
  Socket`; the `Socket` interface at `:3876-3892` carries
  `readable`/`writable`, `secureTransport` (`"starttls"`),
  `startTls(options?: TlsOptions)`). LDAP's wire needs (389 plain +
  StartTLS, 636 direct TLS) map onto it.
- **What the platform forbids**: connections to **Cloudflare IP ranges,
  localhost, and private-network IPs are disallowed** (Workers TCP
  Sockets docs — "Outbound TCP sockets to Cloudflare IP ranges are
  blocked"; the disallowed-address troubleshooting list names
  `localhost` and private addresses). Enterprise directories — the
  actual population LDAP serves — are overwhelmingly private-network
  (`ldap.internal.corp`); the addressable set is public-only LDAP, a
  niche of a niche.
- **What the substrate lacks**: upstream's LDAP arm is `go-ldap`
  (`ldap.DialURL("ldap://…"|"ldaps://…")`,
  `services/auth/source/ldap/source_search.go:111-126`) over a ~35-field
  config (`routers/web/admin/auths.go:116-153`) plus BindDN/simple-bind
  search semantics, group/SSH-key sync (`IsSyncEnabled`,
  `source.go:225-228`), and an admin-filter/group-filter grammar. None
  of that has a house port; it is a from-scratch BER/ASN.1 protocol
  client — a different order of work than any landed surface.
- **Verdict**: deferred with an explicit reopen trigger — a concrete
  deployment need whose directory is reachable at a PUBLIC address,
  accepting a hand-built client. Not judged impossible: the mission's
  honest-adjudication bar requires saying that the transport exists;
  the economics and the addressable-set honesty are what defer it.

### 3.3 SMTP (type 3) — viable in principle, DEFERRED

Upstream dials raw TCP (`net.Dial("tcp",
net.JoinHostPort(source.Host, …))`, `services/auth/source/smtp/auth.go:63`,
`smtp.NewClient` `:73`) and speaks SMTP AUTH against the mail host —
port 25 is blocked platform-side (TCP Sockets docs: "By default,
Workers cannot create outbound TCP connections on port `25`"), but
auth-source targets are normally submission ports (465/587), which are
allowed. Deferred for two recorded reasons: the same hand-built-client
economics as LDAP (a from-scratch SMTP client), and the posture
collision — an SMTP source makes the login form a real password form
again, undoing the credential-label divergence the login page documents
(`src/ui/pages/login.tsx:1-23`: the field visibly says "Access Token"
precisely because our credential is a PAT). An SMTP source would need
per-source form relabeling and a second credential grammar in the same
POST. Reopens with LDAP-class economics.

### 3.4 PAM (type 4) and SSPI (type 7) — platform-impossible, permanent

- **PAM**: upstream's arm is a **CGO binding to the host OS's PAM
  stack** — `modules/auth/pam/pam.go:5-8` is build-tagged `//go:build
  pam` over `github.com/msteinert/pam/v2` (`pam.StartFunc` against a
  configured service name), with `pam_stub.go` (`//go:build !pam`,
  `Supported = false`) for every other build. workerd has no host OS
  PAM, no dlopen, no CGO. Not deferred — impossible for this substrate,
  permanently unless the substrate changes.
- **SSPI**: "SPNEGO with SSPI" (`source.go:56`) — the Windows Security
  Support Provider Interface; integrated Windows Authentication is an
  OS API upstream builds Windows-only. Same class as PAM: impossible
  here. (Upstream's own navbar omits the item when the platform cannot
  serve it — the SPEC-0018 §2.4 conditional-navbar precedent;
  `external_auth_methods.tmpl:9-12` gates on `.EnableSSPI`.)
- **Verdict**: never on this substrate; the type lattice keeps their
  numeric values so the schema is re-pin-stable, and the admin form
  never offers them.

### 3.5 The adjudication table (the SPEC's own summary)

| Type (pin value) | Transport at the pin | Workers verdict | Cites |
|---|---|---|---|
| OAuth2 (6) | HTTPS callouts | **BUILD — v1.4 target** | §3.1; `services/auth/source/oauth2/*` |
| OIDC (the `openidConnect` provider) | HTTPS + JWT verify | **BUILD** — the generic arm of type 6 | `providers_openid.go` |
| LDAP (2) / DLDAP (5) | TCP 389/636, StartTLS (`go-ldap`) | DEFERRED (transport exists; private-address ban + client economics) | §3.2; `source_search.go:111-126`; workers-types `index.d.ts:2245, :3876-3892`; platform docs |
| SMTP (3) | TCP (`net.Dial`) + AUTH | DEFERRED (economics + password-form posture collision) | §3.3; `smtp/auth.go:63,73`; port-25 block |
| PAM (4) | Host-OS CGO (`msteinert/pam/v2`) | IMPOSSIBLE (workerd: no OS/CGO) | §3.4; `modules/auth/pam/pam.go:5-8` |
| SSPI (7) | Windows OS API (SPNEGO) | IMPOSSIBLE (Windows-only) | §3.4; `source.go:56` |
| Plain (1) | internal DB auth | NOT A SOURCE — cf-gitea's existing PAT posture | `source.go:292-299` |

## 4. Data model

Drizzle (`src/db/schema.ts`), D1; conventions per SPEC-0002 §3 (unix-second
timestamps, boolean-mode integers). Migration: **the next free number at
dispatch time** (`pnpm db:generate` into `apps/worker/src/db/migrations`;
0054 is the latest landed at writing — do not hard-code a guess into the
dispatch brief).

### 4.1 `login_source` (upstream `login_source`, `source.go:109-126`)

```ts
/** Upstream login_source (models/auth/source.go:109-126) — one external
 *  login chain. type keeps upstream's int lattice (NoType 0 … SSPI 7,
 *  source.go:28-37) so future types never migrate; only OAuth2 (6)
 *  persists in v1. */
export const loginSources = sqliteTable('login_source', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: integer('type').notNull(),                 // 6 only, in v1
  /** UNIQUE — the login-button/callback URL token (§5.2). */
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  /** Inert in v1 (no sync engine); upstream forces it false for non-sync
   *  types at CreateSource (source.go:225-228). */
  isSyncEnabled: integer('is_sync_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Inert slot — no 2FA landed (source.go:116, TwoFactorShouldSkip :212-214). */
  twoFactorPolicy: text('two_factor_policy').notNull().default(''),
  /** The typed config record, JSON — §4.2's shape for type 6. */
  cfg: text('cfg').notNull(),
  createdAt: integer('created_unix', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_unix', { mode: 'timestamp' }).notNull(),
}, (t) => [
  uniqueIndex('login_source_name_uq').on(t.name),
  index('login_source_is_active_idx').on(t.isActive),
]);
```

### 4.2 The cfg record (type 6 only, v1)

```jsonc
// login_source.cfg JSON — the v1 subset of upstream
// services/auth/source/oauth2/source.go:15-35. Deferred fields are
// STRUCTURALLY ABSENT (§1), not zero-valued.
{
  "v": 1,
  "provider": "openidConnect" | "github" | "gplus",
  "clientId": "…",
  "clientSecret": "…",                  // §7.7 records the storage posture
  "discoveryUrl": "…",                  // openidConnect only
  "customUrlMapping": {                 // github only (providers_custom.go:55-70)
    "authUrl": "…", "tokenUrl": "…", "profileUrl": "…", "emailUrl": "…"
  },
  "iconUrl": "…",                       // optional
  "scopes": ["email"]                   // optional; provider defaults otherwise
}
```

### 4.3 `external_login_user` (upstream `external_login_user`, `external_login_user.go:50-70`)

```ts
export const externalLoginUsers = sqliteTable('external_login_user', {
  /** Composite PK exactly upstream (:51, :53). */
  externalId: text('external_id').notNull(),
  loginSourceId: integer('login_source_id').notNull()
    .references(() => loginSources.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** The goth provider key (VARCHAR(25) upstream, indexed :57) — survives
   *  source renames; the provider-keyed lookup (:131-141) reads it. */
  provider: text('provider').notNull(),
  /** Bounded profile snapshot — §7.6's bound, NOT the raw goth payload. */
  email: text('email'),
  name: text('name'),
  nickName: text('nick_name'),
  avatarUrl: text('avatar_url'),
  location: text('location'),
  description: text('description'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  /** Token fields: columns carried for re-pin parity, v1 WRITES EMPTY
   *  (§7.8 — nothing consumes them until the sync engine lands; not
   *  storing unused secrets is the posture). */
  accessToken: text('access_token'),
  accessTokenSecret: text('access_token_secret'),
  refreshToken: text('refresh_token'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
}, (t) => [
  primaryKey({ columns: [t.externalId, t.loginSourceId] }),
  index('external_login_user_user_id_idx').on(t.userId),
  index('external_login_user_provider_idx').on(t.provider),
]);
```

Decisions:

- **No `users.login_type/login_source/login_name` columns in v1.**
  Upstream carries them (`user.go:111-113`) and its OAuth2 resolution
  checks them FIRST (`GetIndividualUserByLoginSource`, `oauth.go:498`) —
  but that dual path exists because LDAP/SMTP/PAM password sources also
  stamp those columns; for an OAuth2-only v1 the `external_login_user`
  join is functionally complete (upstream itself falls through to it,
  `oauth.go:504-521`). One lookup, one join surface; the columns are a
  recorded future addition if a password-source type ever lands.
  `raw_data` is likewise dropped (upstream stores the full goth payload,
  `:53`; v1 persists the bounded profile fields only, §7.6).
- **`ON DELETE CASCADE` both sides**: deleting a source kills its links
  — EXCEPT upstream refuses exactly that (`ErrSourceInUse`,
  `source.go:389-402`, enforced at `auths.go:450`). The FK cascade is
  the substrate-honest safety net for the direct-delete paths (user
  deletion = `RemoveAllAccountLinks` upstream, `:119-124`); the admin
  delete arm still runs the in-use check FIRST and refuses (§6.2) —
  upstream's observable behavior preserved.
- **The vestigial `public_keys.login_source_id`** (schema comment "always
  0 until an LDAP/OAuth2 SPEC lands") — this SPEC is that SPEC, and v1
  still writes 0: the SSH-key claim sync is deferred (§1). The comment
  gains the pointer here (the trigger fired; the CONSUMER still awaits
  the sync arm).

### 4.4 The session column (the dance state)

One additive column, the provider SPEC's `oauth_state` pattern verbatim
(`specs/oauth2-provider.md` §3):

```ts
// sessions table gains (SPEC-0010 §3 extension):
/** External-auth dance state (this SPEC §5.3): JSON
 *  {sourceId, provider, expectedState, externalId, email, name,
 *   nickName, avatarUrl, returnTo} — parked at the /user/oauth2/{source}
 *  redirect, read-and-cleared at the callback; NULL otherwise. Bounded
 *  (§7.6). */
oauth2LoginState: text('oauth2_login_state'),
```

Unlike upstream (which parks the full goth user in a **cookie** session
store, clamped at `MaxTokenLength` 32767, `modules/setting/oauth2.go:110`),
the state lives in the D1 session row: no cookie-size trap, no
server-side session-store dependency — the SPEC-0010 session row already
carries the identity, the TTLs, and the cascade path, and the consent
column of the provider SPEC set the exact precedent.

**W2 as-built amendment:** the row requires a user (`sessions.user_id`
NOT NULL), so the ANONYMOUS dance — the primary leg, started from the
logged-out buttons — cannot park here. The carrier is composite: the row
when a session exists, a short-lived `gitea_oauth2_state` cookie (the
same encoded state, double-submit compare) otherwise; the identity is
never parked client-side either way. The full rationale and the
re-dance contract are recorded in §9 W2's as-built (deviations (a)/(b));
this paragraph's row-only claim is the design intent, the as-built is
the operative arm.

## 5. The flow on our substrate

### 5.1 The client registry seam (no runtime provider objects)

Upstream registers live goth provider objects at source create/update
(`RegisterSource`, §2.1) because its providers are process-lifetime
objects. Ours is **stateless**: each request reconstructs the client
from the source row (`cfg` JSON) + the registry table (§2.3). The seam
is one interface — `resolveProviderClient(cfg) → {authorizeUrl(state,
redirectUri), exchange(code, redirectUri), fetchProfile()}` — with three
v1 implementations (`oidc-client`, `github`, `google`) and a table that
answers "not yet implemented here" for the recorded-deferred keys.
Consequence: the register-then-rollback dance of upstream's
`CreateSource`/`UpdateSource` collapses to **validate-before-persist**
(the OIDC arm fetches + parses the discovery document at admin save;
failure ⇒ the row is not written, upstream's `ErrOpenIDConnectInitialize`
outcome with none of the machinery, §6.2).

### 5.2 Routes and the URL shape

| Route | Handler | Upstream cite |
|---|---|---|
| `GET /user/oauth2/{source}` | resolve the ACTIVE source by name (`is_active` + type 6, §2.2) → park the dance state (§5.3) → 303 to the provider's authorize URL | `web.go:768-770`, `oauth.go:40-69` |
| `GET /user/oauth2/{source}/callback` | verify state → exchange the code → resolve/link/create (§5.4) → mint the session → redirect to the parked `returnTo` | `web.go:771`, `oauth.go:89-268` |
| `GET /user/link_account` | the link page (reads the parked dance identity; a miss redirects to `/user/login`) | `web.go:597`, `linkaccount.go:37-48` |
| `POST /user/link_account_signin` | PAT-as-password verify against the posted username → link → mint | `web.go:598`, `linkaccount.go:63+` |
| `POST /user/link_account_signup` | `ALLOW_SIGNUP`-gated account creation over the shared ladder → link → mint | `web.go:599` |

- **The redirect URI** registered at the IdP is
  `{APP_URL}/user/oauth2/{source-name}/callback` — the source NAME rides
  the URL because the button href and the name-keyed lookup do
  (`external_auth_methods.tmpl:3`; `oauth2.go:664-677`). **Renaming a
  source invalidates the IdP-side registration** — upstream lives with
  this (Name is UNIQUE and the URL encodes it); the admin edit form
  carries a warning line (§6.3). Upstream PathEscape's the name in the
  href; the lookup decodes the same way.
- **Inactive/unknown source names** answer 404 (upstream 500s via
  ServerError, `oauth.go:42-45`; our unclaimed-path/unresolvable-source
  posture is the honest 404 — recorded divergence).
- The login-page buttons and signup-page buttons render from the active
  OAuth2 source list, upstream's `external_auth_methods.tmpl` shape
  (icon-or-fallback + "Sign in with {name}"), under a `sign_in_or`
  divider (`signin_inner.tmpl:51-56`).

### 5.3 The state dance (CSRF for redirects)

1. `GET /user/oauth2/{source}`: generate `expectedState =
   crypto.randomUUID()` (house rule — never `Math.random`; upstream's
   gothic uses a UUID too, `init.go:31-34`); park
   `{sourceId, provider, expectedState, returnTo}` on the session row
   (`oauth2LoginState`, §4.4); 303 to
   `{authorizeUrl}?client_id=…&redirect_uri=…&response_type=code&scope=…&state=…`.
   The OIDC arm adds `nonce` (a second UUID, parked in the same state)
   and reads the discovery document's `authorization_endpoint` —
   discovery fetched per save (§5.1) and cached with the row's
   `updatedAt` as a freshness hint, re-fetched on a 4xx/iss mismatch.
2. The callback: compare the `state` query param to the parked
   `expectedState` (constant-time compare, the house convention);
   mismatch/absent/expired-session ⇒ redirect to `/user/login` with a
   flash, the state column cleared. Upstream's error-param handling
   (`error`/`error_description` → flash + login redirect,
   `oauth.go:94-101, 111-130`) ports verbatim.
3. Exchange: `POST {token_endpoint}` (`application/x-www-form-urlencoded`:
   `grant_type=authorization_code`, `code`, `redirect_uri`,
   `client_id`, `client_secret`) — PKCE is a client-side option
   upstream's goth providers manage internally; v1 sends none (the OIDC
   arm's `S256` support is a recorded follow-up — most admin-configured
   confidential clients do not require it).
4. Identity extraction: OIDC — verify the **id_token** (§5.4) and read
   its claims; GitHub — the profile + email endpoints (the
   CustomURLMapping defaults, `providers_custom.go:55-70`; the email
   endpoint picks the primary/verified address, upstream's goth
   provider behavior); Google — the OIDC arm over
   `https://accounts.google.com` discovery (the `gplus` key kept, the
   scopes defaulted `email` per `providers_simple.go:72-79`).

### 5.4 ID-token verification (the landed machinery)

The OIDC arm verifies the id_token with the landed JWS module —
`verifyJws` + `importVerifyKey` (`services/oauth2/jws.ts`, landed):
JWKS fetched from the discovery document's `jwks_uri`, `kid`-matched
against the token header, `alg` constrained to the token header's
declared alg intersected with the landed alg table (no `none`, no
algorithm confusion — the provider SPEC §4.10 posture, from the
verifier side); claims checked: `iss` equals the discovery document's
`issuer` (exact string), `aud` contains the source's `client_id`,
`exp >= now` and `iat <= now` with zero leeway (`assertApiTimeBounds`
semantics, `services/auth/oauth2.go:53` port), `nonce` equals the
parked value. The subject: `sub` — or the admin-configured
`ExternalIDClaim` fallback upstream carries for OIDC sources
(`providers_openid.go:55-59`, single-claim override); v1 carries the
`ExternalIDClaim` config field for OIDC only (it is a verification
concern, not a sync concern). An HS256-signed id_token (some legacy
IdPs) verifies against the client secret as the HMAC key — the landed
HS family already implements the key-role rule.

### 5.5 Resolution, linking, and the signup interplay

The §2.4 resolution order, adapted:

1. `external_login_user` lookup by `(sourceId, externalId)` — hit ⇒ that
   user signs in (the stale-link cleanup ports: a link whose user row is
   gone or is an org/bot ⇒ delete the link, continue;
   `oauth.go:520-541`).
2. Miss + **signed-in Doer** ⇒ link to the current account (upsert the
   link row), redirect to `/user/settings/security` — upstream
   `oauth.go:133-141`.
3. Miss + anonymous ⇒ **the link-account page** (upstream's default,
   `ENABLE_AUTO_REGISTRATION=false`): park the dance identity in the
   session column (the bounded profile fields + `returnTo`), render the
   two arms:
   - **Sign in to link**: the posted username + password verify as our
     PAT posture (SPEC-0010 §2.2's credential check) — the verified user
     gains the link row, the session mints. Upstream's
     `LinkAccountPostSignIn` semantics; our credential grammar.
   - **Register new account**: gated on `ALLOW_SIGNUP` (SPEC-0010 §6.2 —
     closed ⇒ the tab is absent AND the POST 404s, the gate's exact
     polarity). Open ⇒ the shared account ladder
     (`services/user-accounts.ts`: `usableUsernameError`, the email
     check, the UNIQUE arbiter), username pre-filled from
     `extractUserNameFromOAuth2`'s order (validated
     `preferred_username`/`nickname` → sanitized email local-part →
     `externalId`, `auth.go:434`), email from the provider's verified
     address; created `is_admin=false`, active (upstream's
     `IsActive` posture at `oauth.go:189` — no email-confirm machinery
     exists to withhold activation); link row written; session mints.
   - **The admin-init window guard (the one non-upstream rule):** while
     the zero-user init window is open (SPEC-0010 §6.1,
     `initWindowOpen`), BOTH arms refuse and the flow redirects to
     `/user/login` — the first human must come from the one-shot
     `/install`; an external sign-in must never close the bootstrap
     window on an unadministered instance. Upstream has no analog (its
     install wizard completes before sources can exist); this is a
     bootstrap-posture requirement, recorded as an intentional
     strengthening.
4. **Account-linking modes**: v1 implements the `login` posture only
   (§2.8). Upstream's `auto` mode links on an email match — the takeover
   hazard (a foreign IdP asserting a victim's address links into their
   account) — it is NOT ported; `disabled` mode is subsumed by v1's
   default (an unlinked identity that cannot find its row lands on the
   link page, whose signup arm is `ALLOW_SIGNUP`-gated anyway).
5. Success (either arm, or the direct resolution): the link row upsert
   (`EnsureLinkExternalToUser` semantics — insert or refresh the profile
   fields), `mintSession` (SPEC-0010's seam, `src/ui/session.ts:433`) on
   a FRESH row (upstream regenerates the session at sign-in,
   `oauth.go:420-424` — fixation posture), the dance column cleared,
   redirect to the parked `returnTo` (the `safeRedirectTarget`
   guard, `session.ts:617`).

### 5.6 The login-page integration

`renderLoginPage(options)` gains an OPTIONAL `oauth2Sources` member
(default absent — the §5 golden stays byte-stable, the SPEC-0010 §6.3
option pattern): the divider + anchor block renders only when the list
is non-empty, upstream's markup shape. `GET /login` wires the active
source list (one query — `isActive AND type=6`, ordered by `name`,
§2.1). The signup page carries the same block under its own gate
(upstream `signup_inner.tmpl:52`). No client script — anchors, the
no-JS form rule intact.

## 6. The admin CRUD (WEB, upstream-shaped)

### 6.1 Route family

`/-/admin/auths`, behind `adminPagePrologue` (SPEC-0018 §2.4's gate —
anonymous ⇒ login redirect, non-admin ⇒ the 404 shell) and the
`sameOriginGuard` on every POST:

| Route | Upstream handler | Ours |
|---|---|---|
| `GET /-/admin/auths` | `Authentications` — the `FindAndCount` list (`auths.go:44-56`), ordered by name | same read over §4.1; the list shows type badge, provider, active toggle state, linked-user count |
| `GET /-/admin/auths/new` | `NewAuthSource` (`auths.go`) — the type-picker then the typed form | the OAuth2 form (§6.3); the type picker offers OAuth2 only (the lattice table's honest state) |
| `POST /-/admin/auths/new` | `NewAuthSourcePost` (Bind `AuthenticationForm`) | validate-before-persist (§5.1): OIDC discovery fetch on save; UNIQUE-name arbiter; 303 to the list with flash |
| `GET /-/admin/auths/{id}` | `EditAuthSource` | the form re-rendered; the client secret MASKED (upstream's edit masks too) — show-over/write-only semantics |
| `POST /-/admin/auths/{id}` | `EditAuthSourcePost` | same validation; name-change warning (§5.2's IdP-registration footgun) |
| `POST /-/admin/auths/{id}/delete` | `DeleteAuthSource` — `ErrSourceInUse` refusal (`auths.go:450`) | the in-use check FIRST (a count over §4.3), refuse with upstream's message shape; else delete (the FK cascade takes the links) |

### 6.2 Service layer

`src/services/auth-sources/` — the store (CRUD over §4.1/§4.3 + the
in-use count), the cfg codec (§4.2, versioned `v:1`), the
validate-before-persist entry (the OIDC discovery probe), and the
resolution helpers (`getActiveSourceByName`, the list-for-buttons read).
No D1 transactions needed beyond the single-statement arbiter (the
UNIQUE index is the two-saves race judge, the house convention).

### 6.3 The form (upstream's OAuth2 arm, `auths.go:168-209`, reduced to §4.2)

Fields: source **name** (the URL token — unique, slug-validated),
**provider** dropdown (the executable set: `openidConnect`, `github`,
`gplus` — §2.3's recorded lattice explains the omissions), `client_id`,
`client_secret` (write-only on edit), `is_active`, OIDC-only:
`discoveryUrl`, `externalIdClaim`; GitHub-only: the four custom-URL
overrides (prefilled with the defaults, overridable — upstream's
CustomURLSettings shape); optional: `scopes` (comma-separated),
`iconUrl`. The deferred claim/sync fields (GroupTeamMap etc.) render
NOWHERE — absent, not disabled, per §4.2.

### 6.4 The nav

`AdminFamilyNav` gains the auths item as the Identity & Access group's
first entry (upstream `navbar.tmpl:19`) — **rides the orchestrator's
registration window** (SPEC-0018 §7's shared-file rule;
`src/ui/pages/admin-users.tsx` is family-shared). The SPEC-0018 §3.3
omission note at that file retires when this lands (the note's own
text points here).

## 7. Edge cases, limits, failure modes

1. **Source rename vs the IdP** — the callback URL encodes the source
   name (§5.2); upstream has the same coupling. The edit form warns;
   no rename-lock (parity).
2. **Inactive mid-dance** — the callback re-resolves the source
   (`is_active` required); a source deactivated between authorize and
   callback ⇒ the honest 404 + cleared dance state (upstream
   re-resolves too, `oauth.go:93-103` "first look if the provider is
   still active").
3. **Stale links** — the cleanup arm ports (`oauth.go:520-541`): a link
   to a deleted/non-individual user is removed at sign-in time, never
   blocking a relink.
4. **No email-matching, ever** — resolution is `(sourceId, externalId)`
   only. Upstream's `auto` linking mode (email match) is a takeover
   primitive and is not ported (§5.5.4); a foreign email claim can
   never select an existing account. The email field is profile data,
   copied onto creation, never a lookup key.
5. **Provider outages** — discovery/authorize/exchange failures answer
   the flash + login-redirect arm (upstream's `errCallback` ladder);
   nothing persists half a link; the exchange carries no user-visible
   partial state.
6. **State bounds** — the parked dance JSON carries the bounded profile
   fields only (never the provider tokens, never raw payloads), hard
   cap 8 KiB at write (upstream's `MaxTokenLength` cookie-trap answer,
   §4.4); overflow ⇒ the identity fields truncate and the flow still
   completes (externalId/email/name never truncate).
7. **Client-secret storage** — upstream stores it plaintext in
   `login_source.cfg` (`source.go:117` Cfg TEXT, JSON with ClientSecret
   inline); parity keeps plaintext in D1 (the Upstream-Parity Decision
   Rule; upstream's threat model trusts the DB). The AES-GCM envelope
   exists in-house (SPEC-0009's mirror credentials,
   `MIRROR_CREDENTIAL_KEY`) and is the recorded hardening row (a
   dedicated `AUTH_SOURCE_CREDENTIAL_KEY` secret), not the v1 default —
   OQ-2 adjudicates at ratification. Either way the secret NEVER
   renders on edit (masked, §6.1) and never appears in a list payload.
8. **Token columns written empty** — upstream persists the provider's
   access/refresh tokens on the link row for the sync engine
   (`external_login_user.go:64-68`; the invalid_grant cron consumes
   them, `oauth.go:372-390`); v1 has no sync engine (§1), so v1 writes
   NULL/empty — unused secrets are not stored. The columns exist so the
   sync arm's landing is a code change, not a migration.
9. **Multi-instance Workers** — no per-isolate state: everything is D1
   rows + stateless clients (§5.1); the state dance rides the session
   row, so any isolate serves any leg. The two-isolate dance (authorize
   on A, callback on B) is safe: the state comparison reads the same
   session row.
10. **Clock discipline** — id_token `exp`/`iat` bounds are strict with
    zero leeway (`assertApiTimeBounds` semantics); a skewed IdP minted
    token fails closed. Tests travel via the injectable `now` (the
    house convention).
11. **The auth_failures limiter** — the link-page sign-in arm verifies a
    PAT: it rides the same per-IP/per-account failure limiter as
    `/login` (SPEC-0002 §2.7's `auth_failures`), same budget. The
    OAuth2 arms are unbruteforcable by construction (state + provider
    round-trip) and budget nothing.
12. **CSRF surface** — the dance's CSRF is the `state` param (§5.3);
    every POST (link arms, admin CRUD) rides `sameOriginGuard` (the
    house posture; upstream's pin has none — the recorded
    strengthening, same class as the provider SPEC §4.12).
13. **Documented divergences (complete list)** — (a) inactive/unknown
    source names answer 404, upstream 500s (§5.2); (b) no
    `users.login_type/login_source/login_name` columns — the join
    resolves (§4.3); (c) `raw_data` dropped — bounded profile fields
    only (§4.3); (d) provider token columns carried but written empty
    until a consumer lands (§7.8); (e) `auto` account-linking not
    ported — a recorded security divergence, upstream offers it
    config-off by default as well (§5.5.4); (f) PKCE on the client
    flow deferred (§5.3.3); (g) the admin-init-window guard on the
    link arms — an intentional strengthening (§5.5.3); (h) plaintext
    client secret per upstream parity, envelope as the hardening row
    (§7.7).

## 8. Testing plan

Vitest in workerd with real D1 (`@cloudflare/vitest-plugin`); the IdP is
a **fetch stub** — the client seam (§5.1) accepts an injectable fetch,
so suites drive discovery/JWKS/token/userinfo/id_token from in-test
fixtures (real WebCrypto sign operations for the id_tokens — ES256 and
RS256 both, plus one HS256 arm; the landed JWS tests prove the
primitives, these prove the verifier wiring). The deploy-probes battery
gains the live round-trip arm (§8 tail).

- **Store/codec**: cfg round-trip (versioned), UNIQUE-name race
  (two concurrent saves, one wins), in-use count, delete-refusal
  message shape, validate-before-persist (a bad discovery URL writes
  NO row), the list-for-buttons read's ordering/filters.
- **Flow** (`/user/oauth2/*`): the state dance (parked state,
  expected-state mismatch ⇒ login redirect + cleared column, expired
  session ⇒ same, provider `error` params ⇒ the upstream flash
  mapping); id_token verify matrix (good RS256/ES256/HS256;
  wrong iss; wrong aud; expired; iat-in-future; nonce mismatch; kid
  miss; alg-confusion attempts — `none`, HS-with-public-key;
  ExternalIDClaim override); GitHub-arm profile/email resolution (the
  CustomURLMapping overrides honored); the 8 KiB state bound
  (§7.6); inactive-mid-dance (§7.2).
- **Resolution + linking**: hit on `(sourceId, externalId)`; the
  stale-link cleanup (user deleted; user is an org); the
  signed-in-Doer link arm (+ redirect to settings/security); the
  link-account page (miss ⇒ login redirect; the two arms; the
  `ALLOW_SIGNUP` gate's 404 polarity; the signup ladder reuse —
  taken username/email, the UNIQUE arbiter; **the init-window
  guard** — both arms refuse while `initWindowOpen`); session mint
  freshness (a NEW session row per sign-in — the fixation posture);
  `returnTo` through `safeRedirectTarget`.
- **Admin CRUD**: the gate matrix (anonymous ⇒ login redirect,
  non-admin ⇒ 404 shell, per `adminPagePrologue`); list shape; the
  create/edit/delete arms over the store suite; delete-in-use
  refusal; the secret masking (the edit render contains NO
  clientSecret, the secret-hygiene test); the name-change warning.
- **UI goldens**: the login page DEFAULT render byte-stable
  (`oauth2Sources` absent); the with-sources render (divider +
  anchors, upstream's shape); the link-account page; the admin
  auths pages (SPEC-0008 §5.2 process); a11y smoke.
- **Gates**: `pnpm typecheck`; `pnpm test:full` per ADR-0006 — a
  single-file `pnpm test` pass is never cited as suite-green.
- **Live battery** (deploy-probes): a scripted OIDC stub IdP plus,
  when credentials allow, one real provider (GitHub app with
  loopback-less redirect to the deployed origin) — button GET →
  authorize → callback → link/create → session viewer asserts →
  unlink from settings → relink. The fake-IdP arm is the standing
  E2E (the fake-runner harness pattern, SPEC-0012); the real-provider
  arm is recorded manual-only when no app is provisioned.

## 9. Wave decomposition (dispatchable units)

Dependency order: W1 → W2 → (W3, W4, W5 in part) → W6. All shared-file
edits (`src/index.ts`/`ui/index.ts` mounts, `AdminFamilyNav`,
`wrangler.jsonc.example` if OQ-2 picks the envelope) ride the
orchestrator's registration windows — units hand off, never self-edit
the shared index.

- **W1 — substrate: tables + store + codec** (size **M**). Owns: the
  migration (§4.1/§4.3 + the `sessions.oauth2_login_state` column),
  `db/schema.ts` additions, `services/auth-sources/store.ts` (CRUD +
  in-use count + the button-list read), `services/auth-sources/cfg.ts`
  (the versioned codec), tests. Gates: store/codec suites green, tsc 0,
  eslint clean, migration output = the one new file.

  **As-built (2026-10-31, migration 0056):** all of the above landed, plus
  the provider-registry skeleton (`services/auth-sources/registry.ts`) —
  the §2.3 lattice as data (17 entries, three executable), pulled forward
  from W3's "registry table module" by dispatch; W3 adds the client
  modules against it, it is data-only. Suites:
  `cfg.test.ts` (16) + `store.test.ts` (20, includes the 0056
  structure arms + the migration-apply) + `registry.test.ts` (6) — 42/42.
  Deviations/clarifications recorded: (a) the §4.2 sketch omits
  `externalIdClaim` but §5.4/§6.3 carry it — the codec has it,
  OIDC-only, optional; (b) upstream also indexes
  `created_unix`/`updated_unix` (xorm INDEX, source.go:123-124) — NOT
  carried (every reader orders by `name`; the §4.1 sketch's deliberate
  drop, now explicit); (c) github's four custom-URL default VALUES are
  goth v1.82.0's (gitea/go.mod:60), verified from the goth source
  (providers/github/github.go package vars) — the strings are not in the
  gitea tree (goth is an external module); (d) `GetSourceByID`'s id-0
  Plain synthesis is not ported (no v1 consumer — the module header
  records it); (e) the store's is_sync_enabled forcing ports the CODE of
  source.go:225-228 (LDAP+OAuth2 sync-capable), not its comment.
- **W2 — the OIDC client flow** (depends W1; size **L**). Owns:
  `services/auth-sources/oidc-client.ts` (discovery fetch/parse,
  authorize URL, code exchange, id_token verify over the landed
  `verifyJws` + JWKS fetch, `ExternalIDClaim`), the route module
  `web/oauth2-login.ts` (`GET /user/oauth2/{source}` +
  `/callback`, the state dance, session-column read/write, the
  resolution + link upsert + `mintSession`), the resolution/link
  service (`services/auth-sources/identity.ts` — the §5.5 ladder,
  stale-link cleanup, the init-window guard), tests with the fetch-stub
  IdP. Gates: the flow suite + the verify matrix green.

  **As-built (2026-10-31):** all of the above landed. Suites:
  `oidc-client.test.ts` (35 — the verify matrix with REAL WebCrypto-signed
  id_tokens: RS256/ES256/HS256 good arms; wrong iss/aud; expired;
  iat-future; nonce miss/match; kid miss; the single-key kidless JWKS;
  alg confusion `none` rejected pre-keywork; the RFC 8724 HS arm —
  structurally dead, the HMAC key is ALWAYS the client secret; tamper;
  ExternalIDClaim override; the discovery memo/freshness-hint; the
  authorize parameter set) + `identity.test.ts` (19 — the encoder
  round-trip + §7.6 bound with the never-truncate fields, the dance
  cookie parse, the constant-time compare, the ladder rungs over real D1
  incl. the org-stale cleanup and the structural FK cascade note, the
  link upsert with §7.8-empty token columns, the init-window guard
  predicate) + `web/oauth2-login.test.ts` (18 — both legs end-to-end on
  the stub IdP: the honest 404s, the PathEscape'd-name parity, the
  referer/redirect_to park, both carriers, the errCallback mapping, the
  spent-state arms, the fresh-row mint + last-login bump, the
  prohibited arm, the settings/security link arm, the re-dance
  continuation). Gates with own eyes: the six-file run 114/114 (W1's
  42 + these 72), `session.test.ts` 56/56, tsc zero in the six files,
  scoped eslint clean, `check:api` PASS. Deviations/clarifications
  recorded: (a) **the anonymous-leg state carrier** — §4.4/§5.3 park the
  dance on the session row, but `sessions.user_id` is NOT NULL (W1's
  0013) and the primary dance starts logged-out; upstream's own carrier
  (an anonymous server-side session, gorilla key/data rows with no user
  binding) is impossible on this schema. As-built: the SAME encoded
  state rides the row when a session exists and a short-lived
  `gitea_oauth2_state` cookie (double-submit compare, 10-min Max-Age,
  session-cookie flags) otherwise; planting a known state requires
  setting OUR cookie, which only OUR authorize leg can do (fresh UUID
  each time), so the login-CSRF posture holds; (b) **the identity is
  NEVER parked client-side** — the §5.5.3 link arms verify the
  credential, MINT the session, and re-dance
  (`303 /user/oauth2/{source}?redirect_to=…&oauth2_continue=signin-link
  |signup` — the W5 arms' contract, enforced by
  `externalSignupBlockedByInitWindow` before any credential work); the
  callback completes the link against the IdP-RE-ASSERTED identity and
  lands on the parked `returnTo` (not settings/security — the
  continuation marker discriminates); the link-account page (W5) reads
  the UNTRUSTED redirect hints (`oauth2_source`,
  `oauth2_username_hint`, `redirect_to`) instead of a parked gothUser —
  W5's brief adjusts accordingly; (c) the §4.4 state JSON's identity
  fields stay DEFINED but W2's flow never writes them (nothing parks a
  client-supplied identity); the encoder (fixed key order, 8 KiB,
  externalId/email/name never truncate) is the delivered W1-tail item —
  its first as-written draft had a non-terminating halving loop at the
  1-char fixed point, fixed by dropping the field (caught by the
  never-truncate test's timeout, not by review); (d) the discovery
  memo is keyed `(sourceId, updatedAt)` — the row edit IS the freshness
  hint, a 4xx/iss-mismatch re-verify reads the same document, and any
  isolate fetching once per row version is the §7.9 posture; (e)
  github/gplus rows resolve to the `provider_unavailable` failure arm
  until W3's client modules land; (f) the flash divergence: failures
  redirect `/login?oauth2_error={access_denied|temporarily_unavailable
  |internal|state|prohibited|provider_unavailable}` — FIXED codes only,
  the provider's `error_description` text is dropped (no reflection
  into our UI), the marker is inert until W4 renders it; (g) the
  upstream "direct callback fast path" (oauth.go:48-58) collapses into
  the 303-through-IdP (a live IdP SSO session bounces in one hop; v1
  persists no provider tokens to resume, §7.8); (h) the stale-link
  cleanup's user-gone arm is STRUCTURAL here (the FK cascade removes
  the link with the user row) — the check stays as the belt; the
  org-linked row is the reachable stale case and is tested; (i) no
  session.ts hunks were needed — SPEC-0010's `mintSession` seam (fresh
  row + the batched last-login bump) served verbatim; the mount of
  `oauth2LoginRouter` hands off to the orchestrator's registration
  window.
- **W3 — github + google clients** (depends W2; size **S/M**). Owns:
  `services/auth-sources/providers/github.ts` (profile + email
  endpoints, CustomURLMapping overrides), `providers/google.ts`
  (OIDC-over-google-discovery), the provider registry table module,
  tests. Gates: per-provider suites; the registry answers
  deferred-keys with the recorded status.
- **W4 — admin CRUD + login UI** (depends W1; parallel to W2/W3). Owns:
  `ui/pages/admin-auths.tsx` (list/new/edit/delete + goldens), the
  `/-/admin/auths` route family over the store, the login-page
  `oauth2Sources` option + the signup-page block,
  `renderLoginPage`'s option (login.tsx edit — owned by this unit;
  the byte-stability test rides with it). The `AdminFamilyNav` auths
  item + the `index.ts`/`ui/index.ts` mounts hand off to the
  orchestrator window (SPEC-0018 §7 rule). Gates: admin suites +
  goldens + the login-page byte-stability test.
- **W5 — linking UI + settings** (depends W2; size **M**). Owns:
  `ui/pages/link-account.tsx` (`GET /user/link_account` +
  the two POST arms over §5.5), the account-links section on
  `ui/pages/user-settings-security.tsx` (the linked list, the unlink
  POST, the link-start buttons per active source — upstream
  `accountlinks.tmpl` reduced to the landed page's idioms), the
  unlink service arm, tests + goldens. Gates: the linking suite,
  the settings round-trip. **W2 as-built note:** the page reads W2's
  redirect HINTS (`oauth2_source`, `oauth2_username_hint`,
  `redirect_to` — untrusted, pre-fill only), not a parked identity
  (there is none — §9 W2's as-built (a)/(b)); each POST arm runs
  `externalSignupBlockedByInitWindow` FIRST, verifies its credential,
  mints the session, and re-dances via
  `303 /user/oauth2/{source}?redirect_to=…&oauth2_continue=signin-link|signup`
  — the callback completes the link against the IdP-re-asserted identity.
- **W6 — battery + docs tail** (last; size **S**). Owns: the
  deploy-probes battery arm (§8), the SPEC as-built amendments,
  SPEC-0018 §3.3's ledger-entry edit (the omission paragraph becomes
  the reopened-arm record, per §3.3.4's "edited, not argued with"
  rule), the `public_keys.login_source_id` comment pointer (§4.3),
  the residuals-board row update. Gates: battery green, `pnpm
  check:api` PASS (the web-only family must move no contract count),
  SPEC as-built current.

Shared-file discipline: `wrangler.jsonc.example` gains nothing in v1
unless OQ-2 selects the envelope secret; `admin-users.tsx` is touched
ONLY through the registration window; `user-settings-security.tsx` is
W5-exclusive once dispatched.

## Open questions (resolve at ratification)

1. **Auto-registration now vs later** — ship the link-page-only posture
   (upstream's default) and record `ENABLE_AUTO_REGISTRATION` as a
   follow-up var? Proposal: later — the link page covers both arms;
   the auto-register arm without email-confirm machinery would mint
   unreviewed accounts on any ALLOW_SIGNUP=true instance.
2. **Client-secret storage** — upstream-parity plaintext in cfg (the
   parity default, §7.7) vs the AES-GCM envelope under a dedicated
   `AUTH_SOURCE_CREDENTIAL_KEY` (the SPEC-0009 precedent). Proposal:
   plaintext in v1 (parity; no new required secret), the envelope as
   the recorded hardening row — but this is exactly the class of call
   ratification exists for.
3. **Google under the OIDC arm or as a named simple client** — upstream
   runs `gplus` as a fixed-endpoint simple provider
   (`providers_simple.go:72-79`); ours could serve it through the
   generic OIDC discovery path (Google exposes one). Proposal: named
   client per upstream (the scopes/default behavior then matches the
   pin exactly, including the auto-reg `profile` scope addition when
   that arm lands).
4. **PKCE on the client flow** — send `S256` on OIDC sources
   unconditionally (hardening; some IdPs reject unknown params) or
   defer (upstream's goth providers mostly send none)?
   Proposal: defer, per §5.3.3; revisit when a deployed IdP demands it.
5. **The auths item in `AdminFamilyNav` before any source exists** —
   upstream's zero-source page shows the empty list + the create CTA
   (SPEC-0018 §3.3.1 priced exactly this state); with the CRUD real,
   the item lights unconditionally (parity). Proposal: parity —
   unconditional.
