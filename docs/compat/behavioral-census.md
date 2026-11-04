# Upstream behavioral census (ADR-0008's durability mechanism)

Date: 2026-11-04. Upstream pin: `fc49368845` (the vendored submodule `gitea/`).
Companion to the 117-table structural census (`docs/research/table-alignment-audit.md`)
— that one measures schema presence against the pin; this one measures
**behavior** against the pin, per ADR-0008: *"upstream's implemented standard
behavior is IN SCOPE by default"* and *"the completion standard is behavioral
equivalence, not code presence — verified against upstream's same-input /
same-precondition outcomes."*

## 1. Methodology (the frame every module row follows)

Each censused surface is one graded row with four cells:

1. **Upstream behavior at the pin** — read from the pinned Go code (route,
   service, struct), with file:line cites. Never from feature names, release
   notes, or docs (ADR-0008 rule 6: judgments derive from the pin's actual
   behavior, per entry point — auth entrypoints especially, since web login,
   API Basic, and git-HTTPS each carry their own 2FA/PAT/password rules).
2. **Our implementation state** — the Worker-side module with file:line cites.
3. **Test evidence** — which landed suite pins the behavior (the suite is the
   regression harness the row rests on; a row without evidence says so).
4. **Grade** — the ADR-0008 re-graded vocabulary:

| Grade | Meaning | Stands or re-opens |
|---|---|---|
| **aligned** | Same input and precondition produce the same external outcome (API/Web-UI/Git-protocol/auth/permission/error semantics). | Stands. |
| **platform-adapted** | Internals differ (D1/R2/DO/WebCrypto/Queues replace Go store, app.ini, server session, cron) but external behavior is equivalent; divergence recorded with a **PLATFORM cite**. | Stands — with its cite, per ADR-0008 rule 5. |
| **strengthened / tightened** | Deliberate safe-direction delta (extra guard, refused legacy input, stronger replay guard) with a SPEC record. | Stands, listed here so the delta is visible in one place. |
| **deferred-reopened** | A recorded deferral (`deferred` / `out-of-scope` / `unsupported` / accepted-and-ignored) covering upstream-standard behavior. Per ADR-0008 rule 5 a deferred record is **not** a permanent exemption: it re-opens as backlog. | Re-opens → §4 backlog batch. |
| **not-yet-censused** | The surface exists in the module but no graded row yet. | Next census pass. |

Two hard rules applied while grading:

- **Silent ignores are contract defects** (ADR-0008 rule 4): any operation a UI
  or API accepts must really execute or explicitly error. Every
  accepted-and-ignored field found in this census is a `deferred-reopened` row,
  never "fine because documented".
- **Platform-adapted requires the cite to actually force the shape.** "We
  chose not to" is not a platform force; those rows re-open.

## 2. The 16-module list

The census is module-by-module; a module is COMPLETE when every surface it
owns carries a graded row with both-side cites, and its recorded divergences
from SPECs and the ledger have been re-graded through §1's vocabulary.

| # | Module | Owner unit | Status |
|---|--------|-----------|--------|
| 1 | install | — | not-yet-censused |
| 2 | auth — beyond password (sessions, PAT scopes, TOTP, WebAuthn, OAuth2 provider+client, OIDC sources, sudo, remember-me, rate limits) | CENSUS-B | **COMPLETE (§3)** — password matrix itself owned by PWD-1-resume, cross-referenced |
| 3 | auth — password matrix (store, web login, reset, admin-set, install init, per-entry-point Basic rules) | PWD-1-resume | in flight (parallel unit) |
| 4 | users + profiles | — | not-yet-censused |
| 5 | orgs + teams | — | not-yet-censused |
| 6 | repos + settings (create/fork/generate/rename/transfer/archive/delete, visibility, permission model, settings surfaces) | CENSUS-B | **COMPLETE (§4)** |
| 7 | git-HTTP + SSH surface | — | not-yet-censused (SPEC-0003 §2.4 ACL matrix pre-verified; SSH surface unported) |
| 8 | issues + labels + milestones | — | not-yet-censused |
| 9 | PRs + reviews + merge | — | not-yet-censused |
| 10 | releases + tags | — | not-yet-censused |
| 11 | actions | — | not-yet-censused |
| 12 | packages | — | not-yet-censused |
| 13 | webhooks | — | not-yet-censused (adjacent evidence: `docs/compat/webhook-event-coverage.md`) |
| 14 | notifications + mail | — | not-yet-censused |
| 15 | admin backend | — | not-yet-censused (SPEC-0018/0020 own the API families) |
| 16 | API-v1 overall surface | — | not-yet-censused (per-route families land inside modules 2–15; `docs/compat/api-remaining-inventory.md` is STALE — see §5.2) |
| 17 | federation | — | not-yet-censused (S-1 follower store landed; delivery lane OQ-gated) |

(Listed as 17 rows: the mandate's 16 modules with the auth module split into
beyond-password / password halves across two units; the split is recorded so
the halves' boundary is auditable. §6 folds them back to the mandate's 16.)

## 3. Module 2 — AUTH beyond password (COMPLETE)

Scope: sessions, PAT scopes, TOTP flows, WebAuthn, OAuth2 provider + client,
OIDC/external sources, sudo, remember-me, rate limits. The password store and
the password sign-in matrix (web login, reset, admin-set, install init,
per-entry-point Basic password rules) are PWD-1-resume's census; rows here
cross-reference it and do not grade it.

### 3.1 Sessions and login plumbing

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| S1 | Web session store | Server-side session store behind the `gitea_session` cookie; ID regenerated at sign-in (`routers/web/auth/auth.go:333` `handleSignIn` → session insert). | `ui/session.ts` D1 row per session, sha256-at-rest secret, `SESSION_COOKIE_NAME = "gitea_session"` byte-compatible, 24 h TTL (`:189-198`). | `apps/worker/src/ui/session.test.ts` (route-level gate ladder, mint, clear set) | platform-adapted (PLATFORM: D1 replaces the server session store; cookie name and lifetime wire-equal) |
| S2 | Session rotation | Session ID regenerated at sign-in only; long-lived sessions keep one ID (`routers/web/auth/auth.go:333` regen path). | 24 h periodic rotation + 60 s stale grace so in-flight requests survive (`ROTATION_INTERVAL_MS`, `STALE_GRACE_MS`, `ui/session.ts:220-226`; `rotateSession` `:523`). | `ui/session.test.ts` rotation + forged-ticket arms | strengthened (recorded — SPEC-0010; strictly narrows the stolen-cookie window) |
| S3 | Remember-me | Separate long-lived cookie `CookieRememberName` carrying `tokenID:secret` (`routers/web/auth/auth.go:127`), validated by `CheckAuthToken` (`services/auth/auth_token.go:36-83`) with the 1-min rotated-cookie stale arm and the compromised-token revocation arm (old-hash use deletes the rotated token, `:66-73`); duration `setting.LogInRememberDays` (default off). | Same cookie carries an extended idle TTL on the ONE session row (`REMEMBER_IDLE_TTL_MS` 31 d, `REMEMBER_MAX_AGE_SECONDS`, `ui/session.ts:206-237`); no second token class. | `ui/session.test.ts` | platform-adapted for the single-cookie variant (PLATFORM: D1 session row carries the authority; upstream's two-token split is a store shape) — **but** the AuthToken stale/revocation semantics (`auth_token.go:60-73`) are behavior upstream implements that ours does not: re-opened as **B-11** |
| S4 | Sign-out | `routers/web/auth/auth.go:469-478` SignOut runs `ExitImpersonatedUser` against the raw session; session destroyed. | Four-directive clear set (valid, cookieless, forged, carriers-present) `ui/session.ts` via `deleteSessionBySecret`; dual-carrier clear on the 2FA path. | `ui/session.test.ts` logout arms | aligned |
| S5 | Prohibited account | API: bare `{message}` 403, no `url` field (`routers/api/v1/api.go:889-893`); git: plain-text 403 (SPEC-0003 row 11). | Same bare body on the middleware arm (`auth/middleware.ts`, pinned in `auth/middleware.test.ts`); SPEC-0022 §4.13 pins the two bare-body exceptions against every other arm's `{message, url}` wrapper. | `auth/middleware.test.ts` | aligned |
| S6 | Sudo (API) | `sudo()` (`routers/api/v1/api.go:111-140`): admin-only; unknown target → `APIErrorNotFound`; non-admin → 403 `"Only administrators allowed to sudo."`; audit `UserImpersonation` recorded; the admin stays attached as impersonator data. | `auth/middleware.ts` sudo arm; byte-compatible error bodies (SPEC-0002 §4.6 non-divergence list: "sudo semantics" kept byte-compatible). | `auth/middleware.test.ts` (admin/non-admin/missing-target), `auth/middleware.test.ts` bare-403 rows | aligned — one sub-check open: the API-sudo audit id (`UserImpersonation`) is not yet verified as emitted on our arm (our registered ids cover the WEB impersonation pair, SPEC-0022 §4.10) → **B-12** |
| S7 | Admin web impersonation | Session-data impersonator stamp; exit unconditional via `ExitImpersonatedUser` (`auth.go:469-478`). | `impersonateSessionUser` + exit-by-secret session (`ui/session.ts:628-746`); exit keys on (id, digest) + `impersonator_user_id` stamp so a prohibited/org target cannot strand the admin; audit pair `user:impersonation:start` / `:exit` emitted (`services/audit.ts` registry). | `ui/pages/admin-users-impersonate.test.ts`, `ui/session.test.ts` impersonation arms | platform-adapted (PLATFORM: exit authority moves from server session data to the stamped D1 row) + strengthened (prohibited-target reachability — SPEC-0022 §4.11) |
| S8 | CSRF / Origin guards | Per-form CSRF token machinery living in the request context (`services/context/context.go`), rendered by the template helpers as a per-form token. | `sameOriginGuard` on state-changing posts (`ui/session.ts:847`; oauth2 consent POST per `specs/oauth2-provider.md` §4.12) — token-free same-origin model. | `ui/session.test.ts` Origin guard; `oauth2-login.test.ts` | platform-adapted (PLATFORM: stateless Workers — no server-side token store to mint per-form tokens from; same-origin satisfies the same request-forgery threat) |
| S9 | Session GC | Session provider GC expires stale provider records (`modules/session/store.go:113-128` — the same store whose regeneration discipline SPEC-0022 §4.12 cites). | `sweepExpiredSessions` (`ui/session.ts:796`) on the cron state machine. | `ui/session.test.ts` | platform-adapted (PLATFORM: cron replaces provider GC) |
| S10 | Redirect sanitization | Post-login redirects validated against the site origin (the sign-in flow's redirect handling, `routers/web/auth/auth.go` — the flow whose `handleSignIn` sits at `:333`). | `safeRedirectTarget` (`ui/session.ts:936`). | `ui/session.test.ts` | strengthened (recorded) |

### 3.2 PATs and token auth

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| S11 | PAT scope grammar | `access_token_scope.go:240-290`: case tables, empty-segment tolerance, write⇒read bitmap implication, `all`/`public-only` composition, child-scope carry; unknown scope errors at creation (`:281-290`). | `auth/scopes.ts` — the tables ported verbatim; parse-time implication; `HasScope` enforcement. | `auth/scopes.test.ts` (ported upstream case tables) | aligned |
| S12 | PAT CRUD API | `/users/{username}/tokens` (`routers/api/v1/user/app.go`, `Name` binding `Required` at `:37`): required name, duplicate-name 400, invalid-scope 400, `sha1` field carries plaintext once. | `api/services/account-keys.ts` over `auth/token-service.ts`; same guards and messages (SPEC-0002 §2.6 table). | `auth/token-service.test.ts`, `api` misc pins | aligned (with three recorded sub-deltas: S13–S15) |
| S13 | PAT expiry | Upstream: **no** expiry — the `AccessToken` struct carries only created/updated stamps (`models/auth/access_token.go:20-31`, no expiry column). | `expires_at` column + expired → 401 with upstream's unknown-credential message (no scope-leaking "expired" text, SPEC-0002 §4.5). | `auth/token-service.test.ts` expiry transitions | strengthened/tightened (recorded — SPEC-0002 §4.6 #4; an extension upstream lacks, error text kept upstream-shaped) |
| S14 | PAT `last_used_at` | Per-auth column update — usage is derived from `UpdatedUnix > CreatedUnix` (`models/auth/access_token.go:33-38`), so every authenticated call moves the column. | 24 h write throttle (`:352` of SPEC-0002; `token-service.ts`); NULL vs Go-zero wire note (SPEC-0002 §4.6 #13): token surfaces render the Go zero time byte-exactly; key surfaces render creation time where upstream renders zero time — the one wire-visible delta, pinned deliberately. | `auth/token-service.test.ts`; `api/routes/misc-t3.test.ts` (`last_used_at == created_at` at mint) | platform-adapted (PLATFORM: D1 write economy) for the throttle; the key-surface zero-time delta is recorded-and-kept (documented simplification) |
| S15 | PAT name > 255 | Upstream binds `Name` as `Required` only (`modules/structs/user_app.go:37`) — a too-long name reaches the store: 500 on a strict backend, silently accepted on SQLite. | Service-layer 422 `"Name: MaxSize(255)"` before any write (SPEC-0002 §4.6 #14). | `auth/token-service.test.ts` | strengthened/tightened (recorded — an invented-but-sane 4xx where upstream produces a 5xx-or-silent-accept) |
| S16 | Query-string token auth (`?token=`, `?access_token=`) | Accepted by default at the pin — the API auth reader explicitly checks both form keys (`routers/api/v1/api.go:931`); deprecated upstream for 1.23+. | Never accepted (SPEC-0002 §4.6 #6). | `auth/httpauth.test.ts` | tightened (recorded — we skip the exact surface upstream itself deprecated) |
| S17 | Token format + hash at rest | 40-hex token; `TokenHash` (sha256) + `TokenSalt` + `TokenLastEight` UNIQUE-indexed columns (`models/auth/access_token.go:25-27`) — salted PBKDF2 + last-8 candidate scan. | Opaque `cfg_<8hex>_<32base32>`, plain sha256 hex, unique prefix index (`auth/token-format.ts`, `auth/digest.ts`, timing-safe compare over raw digests). | `auth/token-format.test.ts`, `parsers.fuzz.test.ts` | platform-adapted (PLATFORM: WebCrypto lacks PBKDF2-with-salted-iteration posture at parity cost; sha256-at-rest + prefix lookup over D1; wire format never exposed — `sha1` field carries plaintext once, same as upstream) |
| S18 | Credential parsing (Basic/Bearer forms) | `modules/auth/httpauth` scheme case-insensitivity, `x-oauth-basic`, empty-password Basic, malformed headers (`httpauth_test.go` cases). | `auth/httpauth.ts` + `auth/parsers` — cases ported. | `auth/httpauth.test.ts`, fuzz corpus | aligned |
| S19 | Git-HTTP auth realm | `Basic realm="Gitea"` with the OAuth2 provider enabled, `Basic realm="Gitea (Basic Auth)"` disabled (`routers/web/repo/githttp.go:152-158`). | `basicChallenge(oauth2FeatureEnabled(env))` (`git-http/respond.ts:33-45`, as-built 18b78a8). | `git-http` gate tests | aligned |
| S20 | Basic token-forms dispatch (API + git) | `services/auth/basic.go:135` `VerifyAuthToken` first; dotted Bearer → OAuth2-access-token lookup then actions-JWT arm. | Same dispatch minus the actions-JWT arm: dotted Bearer resolves through the OAuth2 access-token lookup; an unverifiable dotted value → 401 (SPEC-0002 §4.6 #8). | `auth/token-router.test.ts`, `auth/middleware.test.ts` | aligned for every arm both sides implement; the actions-JWT arm is **deferred-reopened** → **B-13** (rides the Actions compat SPEC) |
| S21 | Basic **password** sign-in (API + git) | `basic.go:148-155`: `UserSignIn(uname, passwd)` behind the `EnableBasicAuth` switch — THE password arm. | Not implemented; Basic is token-forms-only (SPEC-0002 §4.6 #7). **PWD-1-resume's row** — the password store, web login, reset, admin-set, install-init and this per-entry-point Basic arm are one matrix. | (PWD-1) | deferred-reopened (in flight — PWD-1-resume) |
| S22 | Basic password × 2FA gates | `basic.go:157-179`: WebAuthn-enrolled → refuse Basic outright (`"basic authorization is not allowed while WebAuthn enrolled"`); TOTP-enrolled → consume `X-Gitea-OTP` atomically (`validateTOTP`, audit `UserAuthenticationFailTwoFactor`). | None (rides the absent password arm). **PWD-1's matrix**; the API-side `X-Gitea-OTP` acceptance-without-consumption is THIS module's row S23. | (PWD-1) | deferred-reopened (in flight — PWD-1-resume) |
| S23 | `X-Gitea-OTP` on the API chain | Consumed on the Basic-password API arm (`basic.go:169-179`); the token arms do not gate OTP. | Accepted-and-ignored on the API chain (SPEC-0002 §4.6 #10, kept by SPEC-0022 §4). | (none — the ignore is uninstrumented) | **accepted-and-ignored → re-opened as B-14**: today the header is inert exactly where upstream's token arms ignore it too (aligned), but once PWD-1 lands the Basic-password arm this header MUST consume-or-error, not ignore (ADR-0008 rule 4). Tracked so the PWD-1 landing cannot silently re-ignore it |
| S24 | Deploy tokens (git HTTP) | `services/auth/deploy_token.go:27-46`; registered BEFORE Basic (`routers/web/web.go:135-136`); the key user's only permission is `getDeployKeyRepoPermission` (`models/perm/access/repo_permission.go:387-409` — code+wiki units of its own repo at `mode`). | `auth/deploy-token-service.ts`; gate rows 21–23 of SPEC-0003 §2.4 (Basic forms: username-only / `x-oauth-basic` / password; never Bearer); no scope arm (key user holds none — `basic.go:189-197` fall-through mirrored). | `auth/deploy-token-service.test.ts`, git-http gate tests | aligned |

### 3.3 Two-factor (TOTP + WebAuthn) — SPEC-0022's surfaces

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| S25 | TOTP secret at rest | AES-encrypted with md5(SECRET_KEY), base64 stored (`models/auth/twofactor.go:93-106`). | base32 in the clear in D1; the in-flight copy travels only inside the AEAD ticket, never clear (`auth/two-factor.ts`). | `auth/two-factor.test.ts` AEAD confidentiality + rotation arms | platform-adapted (PLATFORM: no `[security] SECRET_KEY` exists to derive the AES key from — D1 is the source of truth; recorded SPEC-0022 §4.1) |
| S26 | TOTP replay guard | Conditional UPDATE over `last_used_passcode` STRING — refuse its second redemption; row lock closes the TOCTOU (`twofactor.go:127-143`). | Conditional UPDATE consuming the matched PERIOD (`last_used_passcode_period`, monotonic `period < matched`) — an older window's code is rejected too (RFC 6238 §5.2's own recommendation); the write is the serialization point exactly like upstream's row lock. | `auth/two-factor.test.ts` consume/replay ladder (older-window rejection) | platform-adapted + strengthened (recorded SPEC-0022 §4.2) |
| S27 | Scratch tokens | Hashed scratch codes, single redemption — generate/verify pair (`models/auth/twofactor.go:67-85`). | salt+hash stored, shown once, burn-on-use. | `auth/two-factor.test.ts` scratch burn | aligned |
| S28 | 2FA pre-auth carrier | Server session parks the half-signed-in state (`routers/web/auth/2fa.go`). | Dual-cookie pair: the sealed AEAD pending ticket + the challenge cookie; both armed at the gate, both cleared at whichever flow completes (`ui/session.ts` + `web/webauthn-ceremony.ts` challenge naming). | `ui/session.test.ts` gate ladder + dual-enroll park | platform-adapted (PLATFORM: stateless Workers — no server session store; same trust shape: possession of the unguessable sealed value) |
| S29 | WebAuthn RP config | RPID=AppDomain, RPOrigins=[FullyQualifiedOrigin(AppURL)] configured once at init (`modules/auth/webauthn/webauthn.go:27-44`). | RP derived per REQUEST (hostname = rpId, origin = exact clientData match; ports never in RP IDs) (`web/webauthn.ts`). | `web/webauthn.test.ts` ceremony core | platform-adapted (PLATFORM: no app.ini — config-time becomes request-time) |
| S30 | WebAuthn ceremony | go-webauthn assertion ladders, sign-count, clone warning — driven through the user adaptor (`modules/auth/webauthn/webauthn.go:57-79`). | `web/webauthn-ceremony.ts` both verify ladders, sign-count CAS, clone-warning ladder. | `web/webauthn-ceremony.test.ts` | aligned |
| S31 | Passkey (discoverable) login | `routers/web/web.go:608-611`: `/user/webauthn/passkey/assertion` + `/passkey/login` (usernameless). | `web/webauthn-ceremony.ts` `BeginDiscoverableLogin` passkey kind (no allowlist, no uid; userHandle decodes back to `users.id`); the challenge-cookie name shared with the assert kind exactly as upstream clobbers its own. | `web/webauthn-ceremony.test.ts` | aligned |
| S32 | COSE algorithm list | go-webauthn default leads with Ed25519 (-8); the offered list is assembled at init (`modules/auth/webauthn/webauthn.go:24-44`). | ES256 (-7) + RS256 (-257) only (`web/webauthn-cose.ts`) — Ed25519-only authenticators register nowhere. | `web/webauthn.test.ts` | platform-adapted (PLATFORM: workerd WebCrypto offers ES256/RS256; recorded SPEC-0022 §4.6) |
| S33 | Attestation | `PreferNoAttestation`, never verified (`webauthn.go:34`). | "none" preference; empty or packed SELF accepted, everything else rejected — formats upstream's own verifier would also fail. | `web/webauthn.test.ts` | aligned |
| S34 | 2FA disable arm | Bare confirm dialog (`templates/user/settings/security/twofa.tmpl`). | Requires a live TOTP passcode or the scratch token, verified WITHOUT consuming either (a disable must not spend the last scratch code). | `auth/two-factor.test.ts` disable arm | strengthened (recorded SPEC-0022 §4.8) |
| S35 | QR render | Data-URI PNG QR — `twofaGenerateSecretAndQr` renders `data:image/png;base64` (`routers/web/user/setting/security/2fa.go:106,143`). | otpauth URI text only; URI bytes are pquerna/otp v1.5.0-exact (sorted, PathEscape'd query, explicit defaults). | `auth/two-factor.test.ts` URI byte pins | deferred-reopened → **B-15**: the pquerna-exact URI is byte-pinned, but upstream's PNG QR is user-visible behavior a pure-JS PNG encoder can serve from a Worker; economics deferral re-opens per ADR-0008 rule 5 |
| S36 | 2FA audit event ids | Emits `UserAuthenticationFailTwoFactor` / `UserTwoFactorEnable` / `UserTwoFactorDisable` / `UserTwoFactorRegenerate` (`routers/web/auth/2fa.go:88`, `services/auth/security/2fa.go:62,100,282`). | The four ids are unregistered and NOT emitted; the IMPERSONATION pair IS registered + emitted. | `services/audit.test.ts` registry contract | deferred-reopened → **B-16** (the audit registry exists; registering four ids is portable work, no platform force) |
| S37 | Sign-in prior-row retirement | Regenerate destroys the presented pre-sign-in session — "an ID known before sign-in is never authenticated" (`modules/session/store.go:113-128` over `auth.go:400-407`). | Verify-and-delete only when the prior row belongs to a DIFFERENT user; a same-user prior row is kept alive (it already authenticates exactly the minted principal). | `ui/session.test.ts` cross-user retirement + same-user keep-alive | tightened where it matches, recorded delta otherwise (SPEC-0022 §4.12 — a deliberate weakening of one upstream invariant, compensated by the row's own TTL/reuse detection; flagged here for visibility, kept per the SPEC record) |

### 3.4 OAuth2 provider + client + external sources

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| S38 | OAuth2 provider endpoints | `routers/web/auth/oauth2_provider.go` (token endpoint binds `AccessTokenForm` at `:506-507`) + `services/oauth2_provider/*` + `routers/web/auth/oauth2_wellknown.go`: authorize, token, introspect, userinfo, JWKS, `.well-known/openid-configuration`; code + refresh grants, PKCE for public clients, RFC 6749 §5.2 error bodies. | `web/oauth2-*.ts` + `services/oauth2/{grants,token,jws,keys}.ts` — full endpoint set; error bodies byte-pinned. | `web/oauth2-*.test.ts`, `services/oauth2/*` suites; upstream's own test vectors ported (SPEC oauth2-provider §5) | aligned (SPEC oauth2-provider.md is canonical; its §4.16 divergence list is re-graded in S39–S45) |
| S39 | Client secret at rest | bcrypt — generate/compare pair (`models/auth/oauth2.go:220,233`). | PBKDF2 (already-landed `oauth2-apps.ts`). | oauth2-apps tests | platform-adapted (PLATFORM: WebCrypto has no bcrypt; PBKDF2 is the available KDF; recorded oauth2-provider §4.16(a)) |
| S40 | JWT signing keys | RSA 4096 + optional EdDSA — `rsa.GenerateKey(…, 4096)` with the ed25519 arm beside it (`services/oauth2_provider/jwtsigningkey.go:354-356`). | RSA 2048; EdDSA rejected-until-proven (workerd Ed25519 exists but zero house experience — oauth2-provider §2.10). | `services/oauth2/keys.test.ts`, `jws.test.ts` round-trips | platform-adapted for RSA width (PLATFORM: Workers CPU cost of 4096 keygen/sign at the parity posture; recorded §4.16(b)); EdDSA gate re-checkable when house Ed25519 experience exists — noted, not re-opened (the gate is "proven", a condition, not a deferral of upstream-standard behavior: upstream signs with RSA by default) |
| S41 | `DEFAULT_APPLICATIONS` config dance | Seeded default OAuth2 applications from config — `OAuth2.DefaultApplications` (the config keys + defaults pinned in `modules/setting/oauth2_test.go:62-73`). | Not ported (oauth2-provider §4.16(d)). | — | deferred-reopened → **B-17** |
| S42 | Consent flow + auto-consent + public-client PKCE | Consent page, first-party auto-consent, public clients REQUIRE PKCE (`routers/web/auth/oauth2_provider.go:296-309`) with the code-verifier check at grant time (`:676-681`); `unsupported_response_type` / `invalid_request` / `unsupported_grant_type` / `invalid_scope` arms. | Same arms (`web/oauth2-login.ts` + grants); `response_type != "code"` ⇒ `unsupported_response_type`; absent PKCE on public ⇒ error per upstream. | `web/oauth2-login.test.ts`, `oauth2-token.test.ts` | aligned |
| S43 | id_token claims | `Picture = AvatarLink` (`services/oauth2_provider/access_token.go:231`, `routers/web/auth/oauth2_provider.go:121`). | `avatarPictureLink` mirrors MakeAbsoluteURL ∘ AvatarLinkWithSize over the R2 bucket (F2, landed 7362128). | `services/oauth2/token.test.ts` | aligned |
| S44 | Consent POST guard | Upstream relies on the per-form CSRF token machinery (`services/context/context.go`, rendered by the template helpers — S8's cite). | `sameOriginGuard` added on consent POST (oauth2-provider §4.16(f)). | `web/oauth2-login.test.ts` | strengthened (recorded) |
| S45 | Token endpoint body parsing | Form binding into `AccessTokenForm` (`routers/web/auth/oauth2_provider.go:506-507`, `web.GetForm` over the web form parser). | form-urlencoded per RFC 6749 is the tested contract; JSON arm accepted when trivially available via the same parser (oauth2-provider §4.16(g)). | `oauth2-token.test.ts` | aligned (recorded narrowing of the test contract, not of behavior) |
| S46 | OAuth2 client login (web, via IdP) | `routers/web/auth/oauth.go` — goth provider matrix. | `services/auth-sources/{github-client,gplus-client,oidc-client}.ts` — hand-built WebCrypto clients (goth is not workerd-portable); the provider matrix below. | `web/oauth2-login.test.ts`, `services/auth-sources` suites | platform-adapted (PLATFORM: goth's net/http + CGO-dependent providers replaced by hand-built clients; the SUPPORTED subset follows) |
| S47 | Supported source providers | goth ships: openid-connect, github, gitlab, gitea, nextcloud, mastodon, azureadv2, aws-cognito, bitbucket, dropbox, facebook, twitter, discord, yandex, azuread, microsoftonline, google, LDAP(2/5), SMTP(3), PAM(4), SSPI(6) (`services/auth/source/{simple,oauth2,openid_connect,pam,sspi,smtp,ldap}`). | Registry + store + identity (`services/auth-sources/`): openid-connect, github, google (+ custom-URL class via OIDC); v1 fields `Provider/ClientID/ClientSecret/CustomURLMapping/IconURL/Scopes`. | `services/auth-sources/*` suites | partially aligned / **the deferred provider classes re-open**: gitlab/gitea/nextcloud/mastodon/azureadv2/aws-cognito/bitbucket/dropbox/facebook/twitter/discord/yandex/azuread/microsoftonline are mere deferrals (`specs/external-auth-sources.md` provider table) → **B-18**; LDAP(2)/DLDAP(5) deferred-with-reopen-trigger (transport exists, private-address ban + client economics — §3.2) → **B-19**; SMTP(3) deferred (§3.3) → **B-20**; PAM(4)/SSPI(6) platform-impossible (no dlopen/no CGO/no Windows SSPI in workerd — §3.4 adjudicated with cites, stands) |
| S48 | Source claim/sync features | GroupTeamMap, SSH-key/P GP claim sync, profile sync on login (`services/auth/source/oauth2/source.go:15-35` + sync engine). | Deferred fields stored 0 / unported (external-auth-sources §1, §5.5.4 — the SSH-key claim sync explicitly deferred). | `services/auth-sources/identity.test.ts` | deferred-reopened → **B-21** |
| S49 | Admin link-unlink arms + init window | Admin can link a user to a source (the admin auth-source family + `services/auth/source_search.go:111-126`); upstream has no admin-init-window guard. | Landed arms with the admin-init-window guard ADDED (strengthening, external-auth-sources divergence (g)); the foreign-email-claim synthesis NOT ported (no v1 consumer — §5.5.4). | admin auth-sources suites | aligned + strengthened (recorded) |
| S50 | Login-source admin CRUD + wire | `source_search.go:111-126` list; the admin page family; the unknown-source posture. | `adminPagePrologue` family; the honest 404 for unknown sources (recorded, external-auth-sources §622-line note); v1 renders `iconUrl`, deferred claim fields stay out of the wire. | admin source suites | aligned (wire) / strengthened (404 posture) |

### 3.5 Rate limiting and hardening (no upstream equivalent at the pin)

Verified at the pin: **upstream ships NO rate limiting on auth surfaces** (no
ratelimit middleware exists in the vendored tree). Everything in this group is
our addition; none of it can violate an upstream contract.

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| S51 | Auth failure limiter | none | 20 failures / 5 min / IP, jittered +0–20 %, cleared on success; git HTTP answers plain 403, API 429/403 (`auth/failure-limiter.ts`). | `auth/failure-limiter.test.ts` | strengthened (recorded SPEC-0002 §4.6 #11) |
| S52 | Login rate limit (web) | none | `loginRateLimited` 429 + Retry-After (`ui/session.ts:919`). | `ui/session.test.ts` | strengthened (recorded) |
| S53 | HTTPSign / reverse-proxy / SSPI auth (API group extras) | Registered upstream API auth-group extras (SPEC-0002 §2.5): HTTPSign (signed requests), reverse-proxy header trust, SSPI (Windows SSO). | None. | — | split: HTTPSign is implementable in workerd → deferred-reopened **B-22** (P4); reverse-proxy trust does not map onto Workers ingress (the trusted proxy IS Cloudflare) → platform-inapplicable, stands with this cite; SSPI requires Windows SSPI → platform-impossible, stands (no CGO/no Windows in workerd) |

**Module tally:** 53 graded rows — aligned 19, platform-adapted 15,
strengthened/tightened 10, deferred-reopened 7 (S21, S22, S23, S35, S36, S41,
S48), 1 split verdict (S53: HTTPSign re-opens as B-22; reverse-proxy/SSPI
stand platform-impossible/inapplicable with their cites) and 1 partial (S47:
aligned provider core with the deferred provider classes re-opened as B-18).
Zero placeholders inside the module; every graded row carries both-side cites.
Password-matrix surfaces (S21/S22) are cross-referenced, not graded here.

## 4. Module 6 — REPOS + SETTINGS (COMPLETE)

Scope: create (user/org/admin + push-create), fork, generate-from-template,
rename/redirect, transfer, archive, delete, visibility, the repo permission
model, and the settings surfaces (PATCH EditRepoOption, unit flags, merge
config, topics, mirror settings, wire counters). Git-HTTP transport rows live
in module 7's future census (SPEC-0003 §2.4 pre-verified them; they are
referenced, not re-graded here).

### 4.1 Create + naming + listings

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| R1 | Repo create (API) | `routers/api/v1/repo/repo.go:236-262` → `CreateRepository` (`services/repository/create.go`): name uniqueness + `ErrRepoAlreadyExist` 409 (`:261-262`), readme/gitignores/license template catalogs 400-validated (`:236-238`), `TrustModel: ToTrustModel(opt.TrustModel)` (`:252`), `ObjectFormatName` (`:254`) validated at init. | `repos/service.ts` `create` (UNIQUE(owner,slug) arbitration, redirect-consume, engine-registry mirror) + `api/services/user-repos.ts` (auto_init scaffolding from the inlined catalogs, `trust_model` stored — FN-4 port, `'default'` stores NULL like upstream's 0). | `repos/lifecycle.test.ts`, `api/routes/user-repos.test.ts`, `api/services/repository.test.ts` | aligned |
| R2 | `issue_labels` on create | Passed through (`repo.go:245`) → built-in label-set initialization at create (`services/repository/create.go` → label templates). | Accepted-and-ignored (`api/models/repository.ts:212` — "leaving `issue_labels` the one accepted-and-ignored option"). | (none — the ignore is uninstrumented) | **accepted-and-ignored → re-opened as B-23** (ADR-0008 rule 4: the label-template catalogs are portable D1 work) |
| R3 | `object_format_name` on create | Empty defaults to sha1 and the named format is handed to `git.InitRepository` — an unsupported format errors the create (`services/repository/create.go:151, 221-222`). | Schema accepts the `sha1\|sha256` enum, but the writer hardcodes `objectFormatName: "sha1"` (`repos/service.ts:437`) — a sha256 request is **accepted and silently produces a sha1 repo**. | (none) | **accepted-and-ignored → re-opened as B-24** — the sha256 engine cell is engine-lane work (binary, no platform force for the REFUSAL arm; upstream-faithful minimum is 422 on unsupported formats, which is what upstream does for unsupported values) |
| R4 | Repo name validation | `AlphaDashDot` + MaxSize(100) binding (`structs/repo.go` create options; web forms likewise). | `isUsableRepoName` / `isReservedOwnerName` (`repos/service.ts:144-164`). | `repos/lifecycle.test.ts` | aligned |
| R5 | Default units at creation | `DefaultRepoUnits` = code, issues, pulls, releases, wiki, **projects**, packages, actions (`models/unit/unit.go:66-75`); forks get `DefaultForkRepoUnits` (no actions/packages); mirrors get packages only (`services/repository/create.go:349-355`). | Creation writer seeds the settings row per-kind since the 2026-10-29 upstream-parity flip (actions+packages for normal creates; forks get neither; mirrors packages only) — **but projects remains false at creation** ("Projects remains the one documented house divergence at creation", `api/services/repo-settings.ts:154`). | `api/services/repository.test.ts` | platform-adapted for the per-kind switch (aligned since the flip); the projects gap is a mere divergence → **re-opened as B-25** (one default flip + the projects route family already landed) |
| R6 | Repo create (web + org + admin arms) | Web `POST /create` → `repo.CreatePost` (`routers/web/web.go:1099`; the org variant `:973`). | `api/routes/user-repos.ts` / `org-repos.ts` / `admin-t2.ts` over the same service. | `org-repos.test.ts`, `admin-t2.test.ts` | aligned (row shared with R1's service) |
| R7 | Push-create (git push to nonexistent repo) | `githttp.go:209-241`: anonymous 401; foreign namespace 404; own-namespace create when enabled; org path via `CanCreateOrgRepo`; **default flags OFF** (`modules/setting/repository.go:146-147`); push-created default private (`DefaultPushCreatePrivate: true`). | Full 20-row matrix landed (SPEC-0003 §2.4 rows 15–20) with default flags **ON** (user; org for repo-create-granted members — recorded default divergence, both configurable). | git-http gate tests | aligned for the matrix mechanics; default flags divergence recorded (a headless-forge posture, config-tunable — stands with the SPEC-0003 record) |
| R8 | Listings (`/user/repos`, `/orgs/{org}/repos`, `/repositories/{id}`, `/repos/search`) | `routers/api/v1/{user,repo,org}/` list arms; search envelope `{data, ok}`. | `api/routes/user-repos.ts`, `org-repos.ts`, `repo.ts` (search + `/repositories/{id}`). | `user-repos.test.ts`, `org-repos.test.ts`, `repositories.test.ts` | aligned |
| R9 | Wire counters (stars/forks/watchers) | Maintained columns, not live counts: `convert/repository.go:219-221` ← `repo.NumStars/NumForks/NumWatches`. | `repositories` columns kept in the same D1 batch as the edge writes (`api/services/repository.ts:940-955`: star.go:45/59, watch.go:153, fork settle bump `fork-task.ts` — upstream fork.go:110-113). | `api/services/repository.test.ts` counters describe | aligned |
| R10 | `branch_count` | `BranchCount: int(branchCount)` (`services/convert/repository.go:222` ← `git_model.CountBranches`, `models/git/branch.go:555-561`) — a COUNT over upstream's **persisted `branch` cache table** (is_deleted=false), maintained at push time. | Engine-borne branches with no D1 cache table: real number only where a producer resolved engine reads (`toApiRepositoryFull` refs/heads slice, `repository.ts:732-769, 961`); **the documented default is 0** on list shapes (`repository.ts:955-961` note; `search-aux.ts:225`, pinned 0 in `repositories.test.ts:189`). | `api/services/repository.test.ts:401-517` ("absent or failed reads stay 0") | **deferred-reopened → B-26**: the parity-review row called it "always 0" — stale; single GETs carry the real number today. Upstream's cache is a TABLE we could port (the branch cache is exactly the D1-shaped artifact the schema lane skips); re-open with the table-port design |
| R11 | `release_counter` | LIVE count per serialize: `convert/repository.go:166` (non-draft, non-tag). | Same semantics: single GETs + list pages via correlated subquery (`repository.ts:962-975`); 0 default only for producers that skipped the read. | `api/services/repository.test.ts` | aligned (same 0-default family as R10 but on a table we already have; the residual rides B-26's producer sweep) |

### 4.2 Rename / transfer / archive / delete / fork / generate

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| R12 | Rename + old-URL redirects | `renameRepo` + redirect table (`models/repo/redirect.go`); old URLs 301 to canonical before auth on git HTTP (`githttp.go:117-119`). | `repos/service.ts` rename with `lookupRedirect` (`:267`); git-HTTP row 13 honored. | `repos/lifecycle.test.ts`, git-http gate tests | aligned |
| R13 | Transfer request | `POST /repos/{owner}/{repo}/transfer` (`transfer.go:113-133`): pending files → **201** with the current Repository (`:126-130`); DIRECT arms (doer-is-admin / self-transfer / org-can-create-repo, `services/repository/transfer.go:458-477`) answer **202** inline; re-request while pending → 409 (`:113-115`). | Always files pending → 201 is the only success code; 409 on re-request (`api/routes/repo.ts:101-112` doc + handler; `TransferInProgressError`). | `repos/lifecycle.test.ts` | aligned for pending+409; the direct-202 arms are a mere deferral (D1-work, no platform force) → **re-opened as B-27** |
| R14 | Transfer accept/decline + pending state | Web POST `/action/{accept_transfer\|reject_transfer}` (`routers/web/web.go:1772`) dispatching through `routers/web/repo/transfer.go:33`; the pending row carries the teams column. | Pending `repo_transfer` row (teams column deferred to SPEC-0005 per SPEC-0003:506). | (accept/decline arms — not verified this pass) | not-yet-censused (sub-surface) — folded into B-27's scope |
| R15 | Archive flip | `updateRepoArchivedState` (`repo.go:985-1005`): mirror refusal + tail-call `CleanRepoScheduleTasks`. | `setRepoArchived` (`api/services/repo-settings.ts:555`) with the mirror refusal + the schedule-clean seam internal to the shared write (`api/routes/repo.ts:681-687`). | `api/routes/repo-edit.test.ts` | aligned |
| R16 | Archived push refusal | git push to archived → 403 "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests." (`githttp.go:124-128`). | SPEC-0003 §2.4 row 10 landed verbatim. | git-http gate tests | aligned |
| R17 | Archive read posture | Archived repos: read-only everywhere — write modes refused at the git gate (`routers/private/serv.go:234`), issue/PR write affordances gated by `!repo.IsArchived` (`routers/web/repo/issue_page_meta.go:117,446`), mirror settings refused (`routers/web/repo/setting/setting.go:280,381`). | Unit-gate 412s honor the archived flag via the same has_* gates (settings load path). | (covered by the unit-gate suites) | aligned |
| R18 | Template flag | `updateBasicProperties` flips `IsTemplate` + persists (`repo.go:699-701`, `:727`); gates generate eligibility (`repo.go:349`). | `setRepoTemplate` / the PATCH `template` arm writes `is_template` D1-only (`api/routes/repo.ts:727-738`). | `api/routes/repo-edit.test.ts` | aligned |
| R19 | Delete | `DeleteRepository` (`services/repository/repository.go:63`) wrapping `DeleteRepositoryDirectly` (`services/repository/delete.go:53`): metadata cascade + storage removal + webhook closure. | §2.5.5 pipeline: D1 cascade → DO tombstone → queue purge + raw-D1 housekeeping (`repos/purge.ts`; `api/routes/repo.ts` deleteRepoRoute). | `repos/purge` suites, `lifecycle.test.ts` | platform-adapted (PLATFORM: R2/DO/Queues replace the Go storage walk; external behavior = repo gone, redirects honored) |
| R20 | Fork create | `POST /repos/{owner}/{repo}/forks`: synchronous fork, `num_forks` bump (`fork.go:110-113`), fork↔base visibility coupling (`repo.go:673-679` — a fork's private is forced to base's), `DefaultForkRepoUnits`. | `api/routes/forks.ts` → queue task → `repos/fork-task.ts` row replication + `settleForkRow` (`num_forks` at settle); duplicate-fork 409 with upstream's message shape (`forks.ts:227`). | `api/routes/forks.test.ts`, `repos/fork-task` suites | platform-adapted (PLATFORM: the synchronous in-process fork becomes a queued task — same external outcomes, asynchrony visible only in intermediate `status='creating'`) |
| R21 | Fork visibility coupling | `repo.go:673-679` (PATCH private on a fork is forced to base's value). | `setRepoVisibility` port: private-flip star/watch zeroing + fork-tree cascade (`api/routes/repo.ts:82-121` doc; `services/stars.ts` `clearRepoStars` — `star.go:94-104`; `services/repo-watchers.ts` `clearRepoWatches` — `watch.go:327-333`). | `api/routes/repo-edit.test.ts` | aligned |
| R22 | Generate from template | `GenerateRepository` (`services/repository/template.go:70-194`): git content = depth-1 default-branch clone + FRESH init commit with `{YEAR}/{REPO_NAME}…` variable substitution in `.gitea/template`-matched files (`generate.go:41-118, 233`); optional units: topics, git hooks, webhooks, avatar, issue labels (`GenerateIssueLabels` `:168-169`), protected branches; LFS copy; repo-count limit; cleanup on failure (`:102-108`). | `api/services/generate-repo.ts`: whole-catalog engine replication (a superset of the default branch, NO variable substitution — byte-faithful copy), git_content honored; the OTHER six option booleans **satisfy IsValid but copy nothing** ("accepted-but-inert", `generate-repo.ts:40-44`); one immediate idempotent retry then upstream's cleanupRepository contract (`:92-108`); no LFS copy; no repo-count limit. | `api/routes/generate-repo.test.ts` | split: create/cleanup/settle arms aligned+platform-adapted; **re-opens: B-28** (variable substitution — upstream's core template-repo behavior), **B-29** (the six inert booleans — rule-4 violations; topics/labels/protected-branches are all D1-copy work over landed tables), **B-30** (depth-1 fresh-commit vs whole-catalog — behavior delta visible in history), **B-31** (LFS copy + repo-count limit) |

### 4.3 Settings surfaces (PATCH + stored settings)

| # | Surface | Upstream at pin | Ours | Evidence | Grade |
|---|---------|-----------------|------|----------|-------|
| R23 | PATCH dispatch shape | `repoEdit` (`repo.go:620-1135`): basic properties → archived → units → mirror, in that order; NO mustNotBeArchived gate on this PATCH (no 423). | Same order in the PATCH handler (`api/routes/repo.ts:680-794`); "upstream registers NO mustNotBeArchived on this PATCH, so 423 is never emitted here" (`:97-98`). | `api/routes/repo-edit.test.ts` | aligned |
| R24 | Applied EditRepoOption fields | name (rename), description, website, private, default_branch, archived, template, the has_* unit flags, the 16-field PR-merge config family, projects_mode, the five mirror fields (`repo.go:620-628, 655-735, 754-989, 1023-1135`). | All applied: rename via the service; description/website + has_* via `saveRepoSettings`; PR-merge config + projects_mode via `repo-settings.ts` (updateRepoUnits port `repo.go:855-989`); mirror fields dispatch `updateMirrorSettings` (`repo.ts:689-725` — non-mirror silent skip is upstream's own posture, `repo.go:1029-1033`). | `api/routes/repo-edit.test.ts`, `repo-settings` suites | aligned |
| R25 | PATCH `has_code` | Applied upstream — `opts.HasCode` adds/deletes the TypeCode unit (`routers/api/v1/repo/repo.go:853-854+`). | **Accepted-and-ignored** ("no store yet — SPEC-0005 sweep", `api/models/repository.ts:264-265` — needs the creation-seeded code-unit row). | (none) | **accepted-and-ignored → re-opened as B-32** |
| R26 | PATCH tracker objects (`external_tracker`, `external_wiki`, `internal_tracker`) | APPLIED with validation: external tracker URL/format validation + unit write or delete (`repo.go:761-783`); internal tracker config (`:785-793`); external wiki URL validation + unit (`:821-835`). | **Accepted per shape and ignored** (`api/models/repository.ts:268-269`). | (none) | **accepted-and-ignored → re-opened as B-33** — three objects × URL-validation arms, all portable D1/unit-row work |
| R27 | STALE DOC (census finding) | — | `api/models/repository.ts:264-267` still lists the five mirror fields under "accepted-and-ignored (no store yet)" while the route APPLIES them since the mirror-settings wave (`api/routes/repo.ts:689-725`) — the docstring contradicts the handler. | (verified in-tree this pass) | not a behavior row — **docs defect recorded here; fix rides B-32's edit** (same docstring block) |
| R28 | PR-merge config validation | `IsUpdateStyleAllowed` (`repo_unit.go:183-191`): default update style must be enabled; squash-message enum (`repo.go:950-952` → `SquashMergeMessage.IsValid` `models/repo/git.go:51-53`) errors as `ErrInvalidArgument` → HTTP 400 (runtime-only status vs the declared {200,403,404,422} — upstream's own declaration included). | `validatePullRequestsUpdateSettings` (`repo-settings.ts:113-126`); the enum check answers 400 via the RUNTIME_ONLY_RESPONSES pattern (`repo.ts:786-794`). | `repo-settings` suites, `repo-edit.test.ts` | aligned (runtime-only 400 recorded per the vendored-contract quirk) |
| R29 | `has_pull_requests=false` short-circuit | The whole config block short-circuits when has_pull_requests is EXPLICITLY false (`mustDeletePullRequestUnit`, `repo.go:843-846`) — the delete persists and the flags silently drop, faithfully. | Same arm (`repo.ts:759-765`). | `repo-edit.test.ts` | aligned |
| R30 | Merge-flag merge against loaded config | Optional-pointer arms mutate the LOADED unit config (`repo.go` updateRepoUnits). | Settings read FIRST; merge + validation against the would-be config (`repo.ts:740-747`). | `repo-edit.test.ts` | aligned |
| R31 | Mirror settings via PATCH | `updateMirror` (`repo.go:1023-1135`): interval re-arms sync (`mirror.go:71-77` ScheduleNextUpdate), credentials update, validation 422s; skipped silently for non-mirrors (`:1029-1033`); source address NOT reachable via EditRepoOption (`structs/repo.go:246-255`). | `updateMirrorSettings` (`services/mirror.ts`): interval re-arms, credentials re-seal the §4.2 envelope (KEK missing = the 500 family), validation refusals = declared-422 family; non-mirror returns null → silent carry-on (`repo.ts:689-725`). | `api/mirror.test.ts`, `repo-edit.test.ts` | aligned + platform-adapted for the credential envelope (PLATFORM: Workers Secrets/KEK replace app.ini-stored credentials) |
| R32 | Topics (PATCH/GET/PUT) | `routers/api/v1/repo/topic.go` family. | `api/routes/topics.ts` + `services/repo-topics.ts`. | `topics.test.ts` | aligned (row shared with module 8's census; verified here for the settings surface) |
| R33 | `require-sign-in-view` instance flag | `Service.RequireSignInView`: anonymous fetch 401 overrides public-repo rows (`githttp.go:132`, test `:186-188` — SPEC-0003 §2.4 row 6). | **Spec'd (SPEC-0003 row 6) but the var never landed** — the anonymous-pull precondition reads only owner/repo visibility (SPEC-0003:153-157 text; no `require-sign-in-view` config surface in `src/api/config.ts`'s service settings). | git-http gate tests (absence uninstrumented) | **deferred-reopened → B-34** (one config var + one gate- precondition line; SPEC-0003's own matrix row 6 is unimplementable until it lands) |
| R34 | Visibility model | `is_private` bool + owner VisibleType public/limited/private; "internal" is owner-limited, not a repo state (`modules/structs/visible_type.go:9-18`, `models/repo/repo.go:186`). | Same model (SPEC-0003:155-157). | git-http + api suites | aligned |
| R35 | Permission model (repo access) | `access_model.GetDoerRepoPermission` (`models/perm/access/repo_permission.go:413`): owner/admin full, collaborator mode, team grants via unit gating. | `api/services/repo-access.ts` (`requireRepoAdmin`, `requireRepoDangerZone`, `requireVisibleRepo`) over D1 grants + team write grants (`team-write-grants.test.ts`, `repo-team-visibility.test.ts`). | `collaborators.test.ts`, `team-write-grants.test.ts` | aligned (API face; git-HTTP face re-verified in module 7's pass) |
| R36 | Danger-zone gating | `reqRepoDangerZone` on transfer/delete (`api.go:1244-1249`). | `requireRepoDangerZone` on the same routes (`repo.ts` delete/transfer routes). | `repo-mutation-registry.test.ts` | aligned |
| R37 | Collaborator add/change/delete | `routers/api/v1/repo/collaborator.go` family with permission modes + 404-on-invisible. | `api/routes/collaborators.ts` + `services/repo-collaborators.ts` (delete also clears on repo delete — `deleteRepoCollaborators` in the delete pipeline). | `collaborators.test.ts` | aligned |
| R38 | Repo-level events on mutation | Webhook `repository` events: created/renamed/deleted/transferred (the `services/webhook` repository-event emitter family firing on the service-layer mutations). | `emitRepoEvent` + `repositoryEventPayload` (`services/repo-events.ts`) fired at rename (`repo.ts:561`), delete (`:895`), fork settle, transfer. | `repo-edit.test.ts`, `webhooks-push.test.ts` | aligned (event coverage audited separately in `docs/compat/webhook-event-coverage.md`) |
| R39 | `?go-get=1` meta | `githttp.go:63-66` — 200 meta, no auth. | Landed (SPEC-0003 row 14). | git-http gate tests | aligned |
| R40 | Repo size / languages / avatars / badges | size from the git walk (`repo_model` size column), primary language (`services/convert/repository.go:186-187`), avatar, badges. | `services/repo-size.ts`, `services/avatars.ts` + identicon fallback, `services/badges.ts`, languages route. | `repo-size.test.ts`, `avatar-serving.test.ts` | aligned-size at the sampled surface / languages full-stats walk is module-16 territory (noted, not graded here) |
| R41 | Default branch change | PATCH `default_branch`: D1 + engine HEAD update (`repo.go:655-698` path persists; git HEAD moves). | D1 write + best-effort engine `setHead` (`repo.ts:87` doc); schedules re-keyed to the new default (`switchSchedulesToDefaultBranch` import at `repo.ts:47`). | `repo-edit.test.ts` | aligned |

**Module tally:** 41 graded rows — aligned 29, platform-adapted 3 (R5, R19,
R20), deferred-reopened 6 (R2→B-23, R3→B-24, R10→B-26, R25→B-32, R26→B-33,
R33→B-34), 1 split verdict (R22 — the generate arms, re-opening B-28..B-31),
1 not-yet sub-surface (R14's accept/decline arms, folded into B-27), and 1
ungraded docs-defect record (R27 — the stale docstring, fix rides B-32's
edit). R7's push-create default-flag divergence stands as a recorded
config-parity posture (SPEC-0003's record). Zero placeholders inside
completed rows; every graded row carries both-side cites.

## 5. The re-graded backlog batch (ADR-0008 rule 5 applied)

Every item below is a recorded deferral re-opened by this census. Grading
rule: platform-forced divergences kept (with cites); mere deferrals and every
accepted-and-ignored input re-opened. Sizes are effort estimates for the
backlog board (S ≤ half day, M ≤ 2 days, L = feature-sized).

| id | Source record | What upstream implements at the pin | Why it re-opens (or stands) | Size |
|----|---------------|--------------------------------------|------------------------------|------|
| B-11 | SPEC-0002 §4.6 adj. / discovered this pass | Remember-me = AuthToken machinery: `ID:secret` cookie (`auth.go:127`), stale-rotation 1-min grace + compromised-token revocation on old-hash use (`auth_token.go:60-73`). | Our single-cookie 31d idle variant lacks the rotation/revocation semantics — a security-relevant behavior, not platform-forced (D1 rows could carry it). | M |
| B-12 | SPEC-0022 §4.10 adjacency | API sudo records audit `UserImpersonation` (`api.go:130`). | Our registered ids cover the WEB impersonation pair; the API-sudo emit is unverified — cheap check-or-add. | S |
| B-13 | SPEC-0002 §4.6 #8 | Dotted-Bearer dispatch's actions-JWT arm (runner/task tokens as API identity). | Mere deferral pending the Actions compat SPEC — rides SPEC-0012's landing. | L (with SPEC-0012) |
| B-14 | SPEC-0002 §4.6 #10 + SPEC-0022 §4 | `X-Gitea-OTP` consumed on the Basic-password arm (`basic.go:169-179`). | Accepted-and-ignored today; rule 4 forbids the ignore once the password arm exists. Gate on PWD-1's landing. | S (gate on PWD-1) |
| B-15 | SPEC-0022 §4.9 | PNG QR render (data-URI) beside the otpauth URI. | Economics deferral; pure-JS PNG encoding is workerd-viable; user-visible behavior. | M |
| B-16 | SPEC-0022 §4.10 | Four 2FA audit ids emitted (`2fa.go:88`, `security/2fa.go:62,100,282`). | The audit registry exists; four registrations are portable work. | S |
| B-17 | oauth2-provider §4.16(d) | `DEFAULT_APPLICATIONS` seeded-applications config dance. | Mere deferral; config plumbing over a landed store. | S |
| B-18 | external-auth-sources provider table | 13 goth simple/custom-URL providers (gitlab, gitea, nextcloud, mastodon, azureadv2, aws-cognito, bitbucket, dropbox, facebook, twitter, discord, yandex, azuread, microsoftonline). | Mere deferrals, each small against the landed client framework; upstream-standard behavior by ADR-0008. | M each, L batch |
| B-19 | external-auth-sources §3.2 | LDAP (2) / DLDAP (5) sources. | Deferred-with-trigger (transport exists; private-address ban is a deployment posture, not a platform force). Re-open with its recorded trigger. | L |
| B-20 | external-auth-sources §3.3 | SMTP (3) auth source. | Deferred (economics + password-form posture collision); re-open per rule 5 — the posture collision resolves once PWD-1 lands real passwords. | L |
| B-21 | external-auth-sources §1, §5.5.4 | Source claim/sync: GroupTeamMap, SSH-key claim sync, profile sync. | Deferred fields ride a landed store; no platform force. | L |
| B-22 | SPEC-0002 §4.6 #9 | HTTPSign (signed-request) auth on the API group. | Implementable in workerd (message signatures over WebCrypto); reverse-proxy trust and SSPI arms STAND as platform-inapplicable/impossible (§3.5 S53 cites). | M |
| B-23 | api/models/repository.ts:212 | `issue_labels` on create initializes the named built-in label set (`repo.go:245` → create.go label templates). | Accepted-and-ignored (rule 4); label catalogs are D1 work. | M |
| B-24 | discovered this pass (repos/service.ts:437) | `object_format_name` validated at init; unsupported → create error. | We accept sha256 and silently build sha1 — rule 4 violation; minimum upstream-faithful arm is the refusal. | S (refusal) / L (sha256 cells, engine lane) |
| B-25 | api/services/repo-settings.ts:154 | `DefaultRepoUnits` includes projects (`unit.go:66-75`). | Our creation seeds projects=false — a recorded house divergence with no platform force; the projects family has landed. | S |
| B-26 | api/services/repository.ts:952-961 + parity-review-api.md:36 | `branch_count` = COUNT over the persisted `branch` cache table (`branch.go:555-561`), push-time maintained. | The cache is exactly the D1-shaped table the schema lane skipped; single GETs already resolve the real number, lists default 0. Port the table + push-time maintenance. | L |
| B-27 | api/routes/repo.ts:101-112 | Transfer DIRECT arms answer 202 inline (admin/self/org-can-create, `transfer.go:458-477`); accept/decline pending arms. | Mere deferral — D1 checks over landed grants; no platform force. Folds R14's uncensused accept/decline arms. | M |
| B-28 | api/services/generate-repo.ts:33-35 | Template variable substitution `{YEAR}/{REPO_NAME}…` in `.gitea/template`-matched files (`generate.go:41-118`). | Mere deferral — "out of slice" is a choice, not a platform force; upstream's core template behavior. | M |
| B-29 | api/services/generate-repo.ts:40-44 | Generate copies topics, git hooks, webhooks, avatar, issue labels, protected branches per the option booleans. | Accepted-but-inert (rule 4): requests succeed claiming copies that never happen. All six targets are D1-copy work over landed tables. | M–L |
| B-30 | api/services/generate-repo.ts:36-39 | Generated git content = depth-1 default-branch snapshot as a FRESH init commit. | We copy the whole catalog — a visible history/content superset, upstream-faithful neither in shape nor in "fresh repo" semantics. Decide port vs recorded-divergence upgrade with the engine lane. | M |
| B-31 | api/services/generate-repo.ts:45-46 | Generate copies LFS pointers (`git_model.CopyLFS`) + enforces repo-count limits (`CanCreateRepoIn`). | Mere deferrals; the limit arm rides the landed quota machinery. | S limit / M LFS |
| B-32 | api/models/repository.ts:264-265 | PATCH `has_code` applied (code unit row). | Accepted-and-ignored (rule 4); needs the creation-seeded code-unit row. Folds R27's stale-docstring fix. | S |
| B-33 | api/models/repository.ts:268-269 | PATCH tracker objects applied WITH validation (`repo.go:761-835`). | Accepted-and-ignored (rule 4) — upstream validates URLs and writes/deletes units. | M |
| B-34 | SPEC-0003 row 6 (:169, :153-157) | `REQUIRE_SIGNIN_VIEW` forces anonymous fetch 401 across the board (`githttp.go:132`). | Spec'd, var never landed — SPEC-0003's own matrix row is unreachable until the config surface exists. | S |

**Batch total: 24 re-graded items (≥ 15 gate met).** Composition: 9 were
accepted-and-ignored or accepted-but-inert inputs (rule-4 violations — the
class ADR-0008 calls worse than absence), 13 mere deferrals, 2 splits where a
sibling arm genuinely stands (B-22's reverse-proxy/SSPI, B-15's platform note
is the QR deferral itself). **Surprises of the sweep**, in order of severity:

1. **The `generate` booleans lie (B-29).** `GenerateRepoOption` carries seven
   booleans; ours honors `git_content` and accepts the other six while
   returning success — the request semantics ("copy my topics/hooks/labels")
   are silently unmet. The rule-4 class, live in a shipped route.
2. **`object_format_name` sha256 is accepted and silently discarded (B-24).**
   The schema enum advertises sha256; the writer hardcodes sha1. The repo's
   own OpenAPI contract promises what the storage does not deliver.
3. **The stale docstring (R27).** `api/models/repository.ts` still documents
   the five mirror fields as accepted-and-ignored three waves after the route
   started applying them — proof the census's "read the code, not the
   comment" rule (ADR-0008 rule 6) earns its keep.
4. **`branch_count`'s fix is a table, not a walk (B-26).** Upstream's number
   is a COUNT over a push-time-maintained cache table — the exact D1 artifact
   — so the "always 0" divergence closes with schema-lane work, and the
   parity-review's `language ""` neighbor stays a separate engine question.
5. **`require-sign-in-view` was spec'd and never landed (B-34).** SPEC-0003's
   ACL matrix carries row 6; the config surface it keys on does not exist —
   the spec row is currently dead letter.
6. **`api-remaining-inventory.md` is stale.** It predates the Actions
   landing; module 16's census must re-derive from routes, not from it.
7. **Upstream has NO rate limiting at the pin.** Our failure limiter and
   login rate limit are pure enhancements — nothing upstream-side to align
   with; they stand as strengthened rows without platform cites.

## 6. Completion protocol + the not-yet-censused modules

**Protocol** (each future module pass follows it): survey the upstream module
at the pin from the route/struct/service code (never feature names); enumerate
our implementation surfaces with file cites; attach the suite that pins each
row; grade through §1's vocabulary; sweep the module's SPEC/ledger deferred
markers through rule 5 (platform-forced keep, deferrals re-open onto §5's
table); tally and mark the module COMPLETE only when no row lacks a cite.
Landing review = the commit point; the census grows module rows in place.

**Standing verdicts this pass already carries for later modules** (graded
evidence landed with earlier units; cited so the next pass does not re-litigate):
- Git-HTTP ACL matrix rows 1–14 + push-create 15–20 + deploy-token 21–23:
  SPEC-0003 §2.4, verified in-tree at the pin's cites (module 7).
- Federation follower store: S-1 (ledger) landed, delivery lane OQ-gated
  (module 17; upstream has no table to port — the architecture never
  mainlined, `#36789 1592576fa5` deleted the inbox arm).
- Wiki patch-series mirror / ghost-interim / gitlink / merge-template /
  squash-body arms: D-1..D-6 all LANDED per the ledger (module 9).
- The password matrix: PWD-1-resume's module; S21/S22/B-14 hold this census's
  cross-references to it.

**Modules 1, 3–17 (mandate numbering 1–16)**: not-yet-censused. Module 3
(password) is in flight on PWD-1-resume; every other module awaits its pass
under the protocol above. The backlog table (§5) is the census's output
contract: items graduate to "landed" rows only when a graded row replaces
them, never by editing the deferral marker in place (ADR-0008 rule 5).


