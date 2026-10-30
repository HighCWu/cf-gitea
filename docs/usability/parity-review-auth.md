# Parity review — auth, sessions, web security

READ-ONLY parity audit, 2026-10-30. Subject: our `apps/worker/src/auth/**`,
`src/ui/session.ts`, `src/api/auth.ts`, `src/web/security-headers.ts` (plus the
consumers that exercise them: `src/index.ts` mounts, `src/git-http/{acl,respond,gate}.ts`,
`src/ui/{viewer,repo-view,first-run}.ts`) against upstream Gitea at the vendored
pin `fc4936884584a41931906553d96c2601d750e6ef` (`gitea/services/auth/`,
`gitea/services/context/`, `gitea/routers/api/v1/api.go`, `gitea/routers/web/`,
`gitea/models/auth/`, `gitea/modules/setting/{session,security,oauth2}.go`).
Method: source-level comparison only — no fixes, no runtime probes, nothing
committed. The ratified PAT-only credential model (SPEC-0002) is treated as the
baseline; this review covers everything around it.

Drifts ranked by security/usability impact for a public instance are in
["Top drifts, ranked"](#top-drifts-ranked).

---

## 1. Session cookie attributes and remember-me arithmetic

**Verdict: flags aligned; expiry arithmetic DIVERGES (bug). Severity: HIGH.**

Cookie surface (`src/ui/session.ts:152-162` vs upstream
`modules/web/middleware/cookie.go:58-76` + `modules/setting/session.go:36-76`):

| Attribute | Ours | Upstream | Match |
|---|---|---|---|
| Name | `gitea_session` | `gitea_session` (session.go:61) | yes |
| HttpOnly | always | hardcoded `true` (cookie.go:72) | yes |
| Secure | always | `COOKIE_SECURE`, default derives from `https://` AppURL (session.go:64) | yes-in-effect (Workers origins are https) |
| SameSite | `Lax` always | default `Lax` (session.go:39,68-76) | yes |
| Path | `/` | `IfZero(CookiePath, "/")` (cookie.go:69) | yes |
| Domain | n/a (single origin) | configurable | documented n/a |
| Value | raw `id:secret` | `url.QueryEscape(value)` | equivalent (both cookie-octet-safe) |

The remember-me **cookie** arithmetic matches: `remember` → `Max-Age=2678400`
(31 d = `LOGIN_REMEMBER_DAYS` default, `modules/setting/security.go` `MustInt(31)`;
`session.ts:92`), no `remember` → session cookie. Upstream re-issues the remember
cookie with the full 31 d TTL after every token regeneration
(`routers/web/auth/auth.go:127`); we re-set it with the row's persisted `remember`
bit on rotation (`session.ts:222-228`, SPEC-0010 §2.3).

**The drift — the remember-me/rotation arithmetic never fires.** Our row TTL and
rotation interval are both exactly 24 h and both anchor to the same instant
(`session.ts:71-75`; `mintSession` sets `rotatedAt = expiresAt - 24h`). Step 2 of
`verifySession` rejects `expiresAt <= now` (line 259) while step 5 rotates only when
`now - rotatedAt >= 24h` (line 297) — the two windows touch at exactly one instant
that the expiry check has already consumed, so **rotation is unreachable in natural
operation** (the tests can only exercise it by back-dating `rotatedAt`,
`session.test.ts:499-504`). Consequences, vs upstream:

- Every web session — `remember` checked or not — hard-dies 24 h after mint while
  the browser keeps a 31-day cookie. Upstream splits the roles: the server session
  store dies after 24 h idle (`Maxlifetime` 86400, session.go:38) **but** the
  remember token (`gitea_remember`, 31 d, expiry re-armed to *now + 31 d on every
  use* — `services/auth/auth_token.go:80`) silently re-authenticates. Net: an
  upstream remembered user stays signed in up to 31 idle days; ours is logged out
  every 24 h.
- Reuse detection (`auth_token.go:55-65`, ported verbatim at `session.ts:266-281`
  including the 60 s stale-grace and the compromise delete) is dead code in
  production for the same reason — nothing ever rotates.

SPEC-0010 §2.3 states the intent ("an actively used session keeps living, an idle
one dies after 24 h"); the arithmetic contradicts the SPEC. Even with the window
bug fixed, a second-order drift remains: our rotation re-arms only +24 h
(`session.ts:340`) where upstream re-arms +31 d per use (`auth_token.go:80`) — a
user active every 36 h still gets logged out.

Also aligned: remember-token mechanics ported one-for-one (`id:secret` pairs, sha256
at rest, CAS-guarded rotation, per-use rotation intent, `CryptoRandomString(10)` id,
32-byte hex secret = `generateTokenAndHash`, alphabet and rejection-sampling id
generator match `modules/util`); documented divergence — upstream's two cookies
(`gitea_session` store + `gitea_remember` token) collapsed into one `gitea_session`
carrying `id:secret` (SPEC-0010 §2.3).

## 2. CSRF posture

**Verdict: aligned with upstream's token-less posture, plus a strictly-stronger
layer 2. Severity: none (positive divergence).**

Upstream has **no CSRF tokens** — they were dropped (`services/context/context.go:179-180`,
"we have dropped the csrf token"); the posture rests on the SameSite=Lax session
cookie. Ours: SameSite=Lax (layer 1, identical) **plus** a server-side Origin
header check (Referer fallback) rejecting cross-origin writes with 403
(`sameOriginGuard`, `session.ts:457-472`), carried by every non-GET UI route —
login, logout, first-run install/signup, and the entire hand-written UI write
surface (~200 call sites in `ui/index.ts`), and absent headers are *not* treated
as cross-origin (matching how non-browser clients behave). `?redirect_to=` is
validated path-absolute same-origin only (`safeRedirectTarget`, `session.ts:534-541`),
vs upstream's open-redirect guard `IsCurrentGiteaSiteURL`
(`routers/web/auth/auth.go:163-176`) — equivalent posture. No token scheme to
diverge on. Upstream-faithful and stronger.

## 3. PAT semantics (format, lookup, digest, last-eight)

**Verdict: format diverges (RATIFIED), lookup/digest mechanics coherent; two
recorded field-level deltas. Severity: LOW (all ratified or cosmetic).**

| Aspect | Ours (`src/auth/token-format.ts`, `token-service.ts`) | Upstream (`models/auth/access_token.go`) |
|---|---|---|
| Token value | `cfg_<8hex>_<32base32>`, 160-bit secret, 45 chars | 40-hex (20 random bytes), 160-bit |
| Lookup | UNIQUE 12-char prefix (first 12 chars) → 1 row | `token_last_eight` index → candidate scan |
| At rest | unsalted SHA-256 hex of the value, timing-safe raw-byte compare | PBKDF2-SHA256 (10 000 iters, 50 B, per-token 10-char salt) via `HashToken` (`models/auth/twofactor.go:79-82`) |
| Min-length gate | `len < 8` → unknown (upstream `GetAccessTokenBySHA` gate, access_token.go:91) | same |
| `token_last_eight` field | last 8 chars of the **public prefix** (derivable at list time, `auth/router.ts:55`) | last 8 chars of the **secret** (stored column) |
| Expiry | cf-gitea extension (`expiresAt`); expired ≡ unknown, same 401 | upstream PATs never expire |
| last_used | throttled to 1 write/24 h (`LAST_USED_THROTTLE_MS`) | `UpdatedUnix` bumped on **every** authenticated request (basic.go:100-103, oauth2.go:144-147) |

The value/digest divergence is the ratified SPEC-0002 §3 design; with 160 bits of
entropy the unsalted-SHA-256 vs salted-PBKDF2 difference is not exploitable
(nothing brute-forceable to grind), and the prefix lookup buys O(1) verification.
The `token_last_eight` value semantics differ on the wire (ours shows 8 *public*
chars; upstream shows 8 secret chars) — recorded in SPEC-0002 §3; cosmetic.
`last_used_at: null` also differs from upstream's zero-time
`"0001-01-01T00:00:00Z"` for never-used tokens (Go `time.Time` zero marshal) —
cosmetic. Our 255-char name cap and prefix-collision retry are additions with no
upstream counterpart (upstream binding caps are absent for token names).

Mint ordering and errors match upstream `CreateAccessToken`
(`routers/api/v1/user/app.go:106-155`) check-for-check: duplicate name 400
"access token name has been used already" → scope normalize 400
"invalid access token scope provided: …" → empty 400 "access token must have a
scope" → child-scope escalation 403 "cannot create an access token with a broader
scope than the authenticating token" → `EnforcePublicOnlyFrom` carry-down. All six
messages byte-identical (`auth/errors.ts`).

Scope grammar (`src/auth/scopes.ts` vs `models/auth/access_token_scope.go`): the
exact 19 scope strings, `all`/`no-token-scope`/`public-only` literals, the
write⇒read bitmap, normalization order (public-only first, write before read per
category), the `all` literal collapse, `Normalize`'s `no-token-scope` special case,
`HasPermissionScope`, `CanCreateChildScope` (public-only ignored as a restriction)
and `EnforcePublicOnlyFrom` are all ported 1:1, error text
`invalid access token scope: <s>` included.

## 4. Scope enforcement points — which routes check which scopes

**Verdict: MAJOR GAP on `/api/v1`; correct on token CRUD, git-HTTP, LFS,
packages. Severity: HIGH.**

Upstream wraps essentially every API route group in `tokenRequiresScopes(...)`
(`routers/api/v1/api.go:1009-1872`: activitypub, notification, user, issue,
repository, organization, package, admin categories per group, e.g. `/notifications`
→ notification:1051, `/users` tree → user:1075/1093, `/repos` tree → repository:1554,
issues → issue:1693, packages → package:1715, admin → admin:1867) and
`CheckRepoScopedToken` on git-HTTP (`services/context/permission.go:78-83`).

Ours — the gate exists and is byte-faithful (`requireScope` in
`auth/middleware.ts:216-234`: method-derived read/write level, `required=[…space
joined…]` Go `%v` slice rendering, `token scope=` echo, anonymous pass-through) —
but is **mounted only on the token-CRUD router** (`auth/router.ts:83-84`,
`user` category, matching upstream's `/users/{username}/tokens` wiring at
api.go:1060-1071). Grep confirms zero other `requireScope` call sites; the route
files themselves say so (`api/routes/admin-t2.ts:62`: "tokenRequiresScopes /
rejectPublicOnly → standing deferral like every landed module (SPEC-0002 scope
gates pending)").

What *is* enforced today:

- Token CRUD: `read:user`/`write:user` (router.ts:83) — correct and complete.
- git-HTTP: `read:repository`/`write:repository` row 7 (`git-http/acl.ts:291-294`)
  — matches `CheckRepoScopedToken`.
- LFS + all `/api/packages` protocol families: `read:package`/`write:package`
  (`api/routes/packages.ts:259,275,821`, `packages-protocols.ts:265`, LFS seam).
- Site-admin identity: `requireSiteAdmin` on all admin routes (correct), and the
  `public-only` restriction bit via 18 `rejectPublicOnly` mounts in `index.ts:183-204`
  mirroring upstream's arms one-for-one — including the POST-only variants
  (POST /user/repos, POST /orgs, migrate, generate; GET siblings stay visible,
  api.go:1181) — plus the `userAssignment` masked-404 arm
  (`rejectPublicOnlyUserAssignment`, services/context/user.go:61-64).

What is NOT enforced: `issue`, `repository`, `notification`, `organization`,
`activitypub` and `admin` scope categories on the main `/api/v1` families. A token
minted `read:user`-only — or the literally scope-less `no-token-scope` — currently
passes every non-admin, non-package endpoint whose repo-level visibility ACL holds,
including writes (issues, labels, releases, repo settings), because
`createTokenAuthMiddleware` checks identity only (`api/auth.ts:102-111`). Upstream
answers such requests 403 `token does not have at least one of required scope(s)`.
This widens the blast radius of any leaked low-scope token from "profile reads" to
"full repo write surface" and makes scope Minting UI promises (settings page scope
picker) unenforced. It is a *known standing deferral*, but from a parity standpoint
it is the single largest auth drift on the books.

## 5. Token auth precedence across the three surfaces

**Verdict: aligned. Severity: none.**

- **API `/api/v1`**: upstream auth group = OAuth2 → HTTPSign → Basic, with the web
  Session method deliberately absent (api.go:847-856 `buildAuthGroup`) — a session
  cookie never authenticates the API. Ours: `resolveAuth` at `/api/v1/*`
  (`index.ts:154`) reads only the `Authorization` header (`token`/`Bearer`/Basic
  token-forms; parser is a faithful port of `modules/auth/httpauth/httpauth.go`
  including case-insensitive schemes, exactly-two-fields, malformed ⇒ anonymous;
  Basic token forms user-as-token / `x-oauth-basic` / password-as-token mirror
  `services/auth/basic.go:44-68`). Session cookies are invisible to the API
  (SPEC-0010 §2.9 boundary, `src/ui/session.ts:29-34`). One fallback parser
  (`api/auth.ts:31-37`) accepts only the `token` scheme — it is the standalone/test
  seam, shadowed by `resolveAuth`'s `c.var.auth` in production.
- **git-HTTP**: upstream runs the *web* auth group (ReverseProxy → OAuth2 →
  DeployToken → Basic → Session → SSPI, `routers/web/web.go:118-152`) — notably
  deploy tokens (basic.go pattern, `services/auth/deploy_token.go:27-28`) and even
  session cookies can drive git. Ours: Authorization-header PAT only
  (`git-http/acl.ts:114-118`); session never authorizes git (documented boundary).
  Deploy-token credentials are NOT accepted on the git surface (see drift D4).
- **Web UI**: upstream pages authenticate via Session (cookie store) with the
  token methods reserved to "sessionless" route families; ours: `gitea_session`
  verification only (`ui/viewer.ts`), PAT logins mint sessions, PAT headers are
  ignored by the page mux. Aligned in effect.
- Account-status gate: prohibited → 403 "This account is prohibited from signing
  in, please contact your site administrator." matches upstream
  `verifyAuthWithOptionsAPI` (api.go:877-894) byte-for-byte, as do the 401 body
  `invalid username, password or token` (api.go:862-875), `token is required`
  (reqToken), `auth required` (reqBasicOrRevProxyAuth — reduced to Basic-only, no
  reverse-proxy auth), and `doer should be the site admin or be same as the
  contextUser` (reqSelfOrAdmin). `sudo()` matches api.go:111-146 including the
  doer swap that keeps the *admin token's* scope attached (api.go:129-139), the
  `Only administrators allowed to sudo.` 403 and the masked 404 for unknown
  targets. IsBasicAuth semantics match the upstream `AuthedMethod == "basic"`
  rule (`services/auth/group.go:63-64`): Basic-carried tokens pass
  `requireBasicAuth`, bearer-form tokens do not.
- `?token=`/`?access_token=` query auth: upstream still honors these by default
  (`DisableQueryAuthToken` defaults **false**, `modules/setting/security.go:224`;
  `services/auth/oauth2.go:80-97`) with an `X-Gitea-Warning` deprecation header
  (api.go:938-942). Ours is header-only (`api/auth.ts:25-28` claims "removal
  announced for 1.23" — at this pin they still work upstream). Security-positive
  divergence; old scripts using query tokens break. LOW.

## 6. Login rate limiting / lockout

**Verdict: ours is an ADDITION; upstream at this pin has no login lockout.
Severity: none (positive), one operational caveat.**

The brief's "upstream has MaxAttempts" does not hold for auth: `MAX_ATTEMPTS`
exists only for **migrations** (`modules/setting/migrations.go:24`); the sign-in
path (`routers/web/auth/auth.go:291-363`, `services/auth/signin.go`) has no
attempt counting, lockout, or throttling — upstream logs failures and offers
optional captcha (`EnableCaptcha` + `RequireCaptchaForLogin`). Ours adds a real
per-IP limiter on every credential-testing path (API `resolveAuth`, git-HTTP ACL,
UI login): ≥20 failures in 5 min ⇒ block, with deterministic ±20% per-IP jitter,
success-reset, stale-window lazy rotation (`auth/failure-limiter.ts`); API/UI
answer 429 + `Retry-After` (SPEC-0002 §2.7; message "too many authentication
failures, retry later" is unpinned by SPEC — upstream has no equivalent to copy),
git-HTTP answers its 403 plain-text shape. Two caveats worth recording:

- **Fail-open on limiter backend errors** (deliberate, amendment d598626 /
  finding ef2c049: `limiterCheckFailOpen` etc.): a broken limiter never 500s the
  request it guards; credential verification stays fail-closed. Sound trade, but
  it means brute-force protection silently degrades to zero during D1 incidents —
  worth an observability alert on the `failure-limiter:` error log line.
- **Limiter-key skew**: `resolveAuth` keys on `CF-Connecting-IP` only
  (`middleware.ts:120`) while the git/UI paths fall back to `X-Forwarded-For`
  first-hop (`acl.ts:170-173`, `session.ts:481-487`). On Cloudflare both resolve
  identically; on non-CF hosts (tests, self-host proxies) an attacker could split
  buckets. Cosmetic today.

## 7. 401/403/404 decision tables for private repos, per surface

**Verdict: aligned; existence hidden on all three surfaces. Severity: none.**

- **API**: upstream `repoAssignment` answers unknown owner / unknown repo / no
  unit access with bare 404 (api.go:141-224); ours `requireVisibleRepo` folds
  missing and invisible into one 404 "not found" (`api/services/repo-access.ts:46-54`)
  — the anti-enumeration seam. The `userAssignment` masked-404 carries upstream's
  exact `user redirect does not exist [name: …]` body for public-only tokens
  resolving limited/private users — self included (`middleware.ts:285-305`,
  `services/context/user.go:57-64`).
- **git-HTTP**: matrix rows mirror `httpBase` (`routers/web/repo/githttp.go:62-261`):
  anonymous on non-public ⇒ 401 `Basic realm="Gitea"` challenge (realm matches
  upstream's OAuth2-enabled branch, its default, `modules/setting/oauth2.go:104`;
  SPEC-0002 §2.6 pins it for GCM); unknown credential ⇒ same 401 (identity never
  established); known token missing `read:repository` ⇒ 403 "Forbidden"
  (`CheckRepoScopedToken`, permission.go:79-83); prohibited doer ⇒ 403 "Your
  account is disabled."; prohibited owner ⇒ 403 "Repository cannot be accessed…"
  (githttp.go:117-119); no read grant / public-only-masked / write-without-grant
  ⇒ 404 "Repository not found" (existence + write capability both hidden);
  archived push ⇒ upstream's exact 403 text; mirror push ⇒ 403 "mirror repository
  is read-only" (githttp.go:202-205, incl. the wiki variant). Pre-auth 301 for
  renamed repos preserved. One ordering nuance: upstream checks scope (row 7)
  *before* account status for tokens, ours matches (acl.ts:294-301).
- **UI**: invisible repo ⇒ full-chrome 404 shell, headerless (`ui/repo-view.ts:24-26`,
  `ui/not-found-response.tsx` mirroring upstream's `NotFound` + `IsRepo=false`
  rule); missing/prohibited owner invisible to every viewer; pages never 401.
  Upstream web behavior (`ctx.NotFound`, services/context/repo.go) is exactly this
  convention.
- Login redirect after auth: upstream `redirect_after_auth` honors `redirect_to`
  with same-site validation; ours `safeRedirectTarget` — see §2.

## 8. Security headers

**Verdict: values match upstream defaults exactly; one documented CSP
adaptation. Severity: LOW (accepted, documented).**

Verified against `routers/common/middleware.go:48-64` (SecurityHeadersHandler,
tree-wide at routers/init.go) and `modules/setting/security.go:26-28`:

- `X-Content-Type-Options: nosniff` — exact default match.
- `X-Frame-Options: SAMEORIGIN` — exact default match.
- Placement: every response leaving the Worker (`app.use("*")` in `index.ts:145`,
  plus direct stamps on the non-Hono exits and `onError`) — matches upstream's
  "every response that leaves Gitea" semantics, API included.
- CSP: upstream's general policy is
  `default-src * data: blob:;script-src * 'nonce-<32-hex>';style-src * 'unsafe-inline';`
  (`services/context/context_template.go:134-141`, emitted as head-meta on pages
  and as a response header at its two call sites, `base.go:205-210`). Ours emits
  the same shape on every `text/html` response with the nonce replaced by
  `'unsafe-inline'` (`web/security-headers.ts:83-84`) — a **documented,
  capability-equivalent adaptation** (SPEC-0008 §4.14 ships nonce-less inline
  artifacts; the module header records the cross-ownership reasoning). Net
  strength vs upstream: `script-src *` already allows any host, so the delta is
  "inline scripts allowed" vs "nonce'd scripts allowed" — upstream's own policy is
  allow-all-by-design (`context_template.go:128-133`). Acceptable; a nonce
  retrofit would be the parity-restoring follow-up.
- HSTS: upstream sets none at the pin (string absent from the Go tree); ours sets
  none. Match (edge/zone territory).
- Superset nuance: upstream carries CSP on pages via meta tag; ours uses a real
  header on all HTML — same enforcement domain, no drift risk identified.

## 9. OAuth2 / federation / other credential methods

**Verdict: OAuth2 authorization flows ABSENT (documented gap); app-CRUD slice
landed faithfully. Severity: LOW (gap is deliberate and recorded).**

- **Landed**: the OAuth2 application CRUD family (5 frozen ops,
  `api/routes/oauth2-apps.ts` over migration 0026) — upstream-faithful secret
  handling: crypto-random `gto_`-prefixed secret, hashed at rest (PBKDF2-SHA256
  here vs bcrypt upstream — noted in the file header), plaintext rendered exactly
  once (create 201 / patch 200, which always rotates), blanked on list/get,
  foreign app = indistinguishable 404, redirect-URI validation ported. Explicitly
  CRUD-only: no authorize/token endpoints, no grants, no codes.
- **Absent (recorded gap)**: upstream's built-in OAuth2 provider flows
  (`/login/oauth/authorize`, `/login/oauth/access_token`, OAuth2Grant scopes,
  JWT access tokens via `services/auth/oauth2.go`), the OAuth2 *auth method* on
  API/git (bearer JWTs — our bearer form resolves against the PAT store instead),
  HTTPSign, reverse-proxy auth, SSPI, LDAP/PAM/SMTP sources, 2FA/TOTP/WebAuthn
  (upstream refuses plain-password git for 2FA users, githttp.go:159-167 — moot
  with no password store), deploy-token git credentials, passkeys, webhooks-free
  federation. All fold into the ratified PAT-only model; the only externally
  visible seams are (a) CI setups that provision OAuth2 apps or deploy tokens for
  git clones cannot (see D4), and (b) Gitea's git-401 realm hints GCM at an
  OAuth2 endpoint that does not exist — the GCM OAuth attempt will fail and fall
  back to Basic, where the PAT works.

---

## Top drifts, ranked

1. **HIGH (security) — API token scopes unenforced outside token CRUD / git / LFS
   / packages** (§4). A `read:user`-only or `no-token-scope` token can call the
   entire non-admin `/api/v1` surface, writes included, subject only to repo
   visibility. Upstream gates every group (`tokenRequiresScopes`, api.go:1009-1872);
   our gate exists and is byte-faithful but mounts in exactly one place; route
   files record it as a "standing deferral". Biggest single gap for a public
   instance.
2. **HIGH (usability) — session rotation unreachable; every web login dies after
   exactly 24 h, `remember` notwithstanding** (§1). `SESSION_TTL_MS ==
   ROTATION_INTERVAL_MS` anchored at the same instant makes the rotation window
   empty; reuse detection is consequently dead code; upstream remembered users
   get 31 idle days (re-armed per use), ours get 24 h flat. Contradicts
   SPEC-0010 §2.3's own stated behavior ("an actively used session keeps
   living").
3. **MEDIUM (CI usability) — deploy-token credentials are not accepted on
   git-HTTP** (§5, §9). Upstream's web auth group admits them before Basic
   (`services/auth/deploy_token.go`); ours answers 401 and counts a limiter
   failure. Deploy keys exist in the API family only. Common CI read-only clone
   pattern breaks.
4. **LOW-MEDIUM (compat) — `?token=`/`?access_token=` query auth absent** (§5).
   Upstream still honors them by default at this pin (deprecation-warned); the
   in-code justification ("removed in 1.23") overstates the pin's behavior.
   Security-positive; old scripts break.
5. **LOW (documented) — CSP nonce → `'unsafe-inline'`** (§8). Capability-equivalent
   within upstream's deliberately allow-all policy; strictly weaker than a nonce
   on inline scripts only.
6. **LOW (ratified) — PAT format/digest at rest** (`cfg_…`, unsalted SHA-256,
   prefix lookup) vs upstream (40-hex, salted PBKDF2-10k, last-8 index), and the
   `token_last_eight`/`last_used_at` field-value deltas (§3). Ratified SPEC-0002
   design; entropy equivalence argued; wire-visible only in those two fields.
7. **LOW (operational) — failure limiter fails open + key skew** (§6). The
   fail-open trade is sound and documented; add alerting on its error line, and
   unify the IP extraction (`CF-Connecting-IP` only vs XFF fallback) for
   non-CF-hosted deployments.
8. **INFO (recorded gaps)** — OAuth2 authorization flows and all other upstream
   credential methods absent (§9); GET /logout exists upstream (web.go:765) where
   ours is POST-only (deliberate prefetch-footgun hardening, §2/§7); upstream's
   bare `{"message"}` 403 JSONs (sudo, account-status) gain our `url` field
   (`apiErrorResponse`) — supersets of upstream's wire shape.

**Aligned-and-verified highlights** (no action): cookie flag matrix; CSRF
token-less posture + layer-2 Origin guard; scope grammar byte-port (strings,
bitmap, normalization, `all` collapse, mint-time child-scope/public-only rules,
400/403 precedence and messages); token-CRUD wiring and middleware order
(scope → contextUser → selfOrAdmin → basicAuth; anonymous GET ⇒ 403 not 401, as
upstream); httpauth parser and Basic token forms; auth precedence per surface
(no session on API/git); sudo scope retention; prohibited-account gate; the
git-HTTP matrix and its masked-404 column; API/UI anti-enumeration 404s;
security-header values; remember-cookie 31-day arithmetic; no HSTS on either
side.
