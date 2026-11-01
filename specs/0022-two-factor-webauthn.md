# SPEC-0022: Two-factor authentication (TOTP) + WebAuthn security keys

Status: **accepted — as-built record** (the surface landed through the
auth-session waves; this SPEC captures the shipped behavior, the recorded
divergences from the vendored upstream pin, and the security model).
Date: 2026-11-01.

Upstream findings are against the vendored submodule (`gitea/`, read-only,
pin `v29.0.0-dev-208-gfc493688`). Landed-code findings are against
`apps/worker/src/**` as of 2026-11-01.

Related: SPEC-0002 (the API auth chain, `X-Gitea-OTP`), SPEC-0010 (the web
session, `gitea_session`, §2.4 verification), SPEC-0015 (the audit seam),
specs/oauth2-provider.md + specs/external-auth-sources.md (the deferred
2FA interplay slots this SPEC fills for the local-password posture).

## 1. Problem and scope

Upstream gates a password sign-in behind a second factor: TOTP passcodes
(`routers/web/auth/2fa.go`, `models/auth/twofactor.go`) and WebAuthn
security keys/passkeys (`routers/web/auth/webauthn.go`,
`models/auth/webauthn.go`, the go-webauthn library surface). Our login
credential is a PAT (SPEC-0010 §1.3), and the web flow previously minted a
session straight from a verified PAT. This SPEC covers:

- the `two_factor` store seam + the TOTP enrollment/verify/disable flows
  (`apps/worker/src/auth/two-factor.ts` over migration 0059);
- the WebAuthn credential store + ceremony core
  (`apps/worker/src/web/webauthn-store.ts`, `webauthn-ceremony.ts`,
  `webauthn-cose.ts`, `webauthn-cbor.ts` over migration 0060);
- the LOGIN GATE: an enrolled doer's POST /login parks pre-auth instead of
  minting (`apps/worker/src/ui/session.ts` — upstream `auth.go:330-368`);
- the 2FA gate routes GET/POST `/user/two_factor{,/scratch}`
  (session.ts — upstream `web.go:600-604` over 2fa.go);
- the WebAuthn ceremony routes + settings surface
  (`apps/worker/src/web/webauthn.ts`, the settings page module);
- the dual-carrier pre-auth posture (a dual-enrolled user carries BOTH the
  WebAuthn pending carrier and the TOTP gate ticket — §3.3);
- the audit rows `user:impersonation:start`/`:exit` (the admin
  impersonation pair that shares the login/Logout arms — SPEC-0015).

Out of scope: SMS/DUO/other upstream 2FA source types (no source plugin
surface); the enforced-2FA posture (`setting.TwoFactorAuthEnforced` has no
var here); password sign-in itself (SPEC-0010 §1.3 — the gate arms ride the
PAT login until passwords land, at which point the arms carry over
unchanged); the upstream `KeyUserHasTwoFactorAuth` session key (its only
reader guards the enforced posture, which does not exist — the module
header records the omission).

## 2. API surface

### 2.1 The login gate (upstream handleTwoFactorRequired + TwoFactorPost)

- POST /login with a verified PAT: a doer with enrolled WebAuthn
  credentials 303s `/user/webauthn`; otherwise a doer with a TOTP
  enrollment 303s `/user/two_factor`; otherwise the session mints directly.
  Upstream's order (auth.go:349-368: `HasTwoFactorOrWebAuthn` →
  handleTwoFactorRequired → hasWebAuthn ? /user/webauthn :
  /user/two_factor) is preserved — the TOTP gate answers only users the
  WebAuthn check passes through.
- The parked principal travels in pre-auth cookies, NOT the session
  (upstream parks `twofaUid`/`twofaRemember` in its server-side session;
  our D1 session rows require a signed-in user — the carriers are §3.3's
  cookies).
- **DUAL enrollment**: upstream sets `twofaUid` BEFORE the hasWebAuthn
  branch, so both prompts share one server session and the webauthn page's
  TOTP fallback (web/webauthn-page.tsx arms `/user/two_factor`) reaches a
  live gate (webauthn.go:40-46 reads `twofaUid`, 2fa.go:36 renders on it).
  Two cookies cannot share one jar slot, so the dual park arms BOTH
  carriers on the 303 (`gitea_webauthn` pending + `gitea_twofa` gate), and
  whichever flow completes first clears both (the TOTP arms clear all
  pre-auth carriers; the WebAuthn mint arm clears its own pair — the
  `gitea_twofa` clear on the WebAuthn side is the WebAuthn unit's landed
  follow-up).

### 2.2 The 2FA gate routes (2fa.go over web.go:600-604)

- GET /user/two_factor, GET /user/two_factor/scratch — the passcode /
  scratch-code pages in the anonymous shell. Authority ladder: a fully
  signed-in visitor 303s `/` (performAutoLogin's arm, auth.go:208-227);
  a valid GATE ticket renders; anything else is the 500 shell — upstream's
  `ctx.ServerError("UserSignIn", errors.New("not in 2FA session"))`
  (2fa.go:36-39/103-106).
- POST /user/two_factor (2fa.go:45-92) — verify AND CONSUME the passcode
  (the §4 replay guard), then mint the session and land on the ticket's
  validated redirect (SPEC-0010 §2.2 step 6's target rules carry the
  `redirect_to` through the gate). Failure re-renders at 200 with the
  inline message (the house posture; upstream has no failure limiter on
  TwoFactorPost either — the unforgeable ticket is the gate).
- POST /user/two_factor/scratch (2fa.go:112-164) — verify the scratch
  code, BURN it (regenerate), mint, 303 `/user/settings/security`.
- The POSTs carry the §2.8 layer-2 Origin check (SPEC-0010).
- Enrollment/management lives in the settings security page
  (`/user/settings/security` — upstream `security/2fa.go`): generate a
  secret, show the otpauth URI, verify once to activate, show the scratch
  token once; regenerate scratch; disable. DISABLE REQUIRES A LIVE CODE
  (a TOTP passcode or the scratch token, verified WITHOUT consuming
  either) — upstream's form is a bare confirm dialog; the recorded
  divergence (§4).

### 2.3 The WebAuthn surface (routers/web/auth/webauthn.go + settings/security/webauthn.go)

- GET /user/webauthn — the prompt page (the pending carrier is the
  authority; its JS drives the assertion against the ceremony routes).
- The ceremony route group (assertion options POST, assertion verify POST,
  registration options + verify under settings) — `web/webauthn.ts` maps
  upstream's handler statuses verbatim (the WebAuthnError arms).
- Settings: register (options + verify + reserved nickname, the 409 name
  arms), list, rename, delete (`webauthn-store.ts`'s op set = upstream
  `models/auth/webauthn.go`).

## 3. Data model

### 3.1 D1 tables

- `two_factor` (migration 0059): upstream's `two_factor` table
  (`models/auth/twofactor.go`) — `user_id` UNIQUE, `secret` (base32),
  `scratch_salt`, `scratch_hash`, `last_used_passcode_period` (upstream
  `last_used_passcode` — §4's replay-guard divergence), created/updated.
- `webauthn_credentials` (migration 0060): upstream's `webauthn_credential`
  — `user_id`, `name`+`lower_name` (case-folded UNIQUE composites),
  `credential_id` (blob, UNIQUE per user), `public_key` (blob), `attestation_type`,
  `aaguid` (blob), `sign_count`, `transports` (JSON), `clone_warning`,
  created/updated (unix seconds).

### 3.2 Key material

The shared `general_token_signing_secret` `system_keystore` row (the
landed instance secret playing upstream's JWT_SECRET/SECRET_KEY role)
keys the ticket AEAD (§3.3). Rotation is operator-only (the oauth2
keys.ts posture): outstanding tickets die with the secret — a user
mid-flow re-authenticates.

### 3.3 The pre-auth carriers (security model)

Upstream parks pre-auth state in the SERVER session (`twofaUid`,
`twofaRemember`, `twofaSecret`/`twofaUri`, `webauthnAssertion`,
`webauthnRegistration`, `webauthnPasskeyAssertion`). Our session rows
carry no arbitrary keys and the assertion ceremony runs pre-auth, so the
state travels in cookies sealed/signed by the instance secret:

| Cookie | Carrier | Content | TTL | Cleared at |
|---|---|---|---|---|
| `gitea_twofa` | AES-256-GCM sealed (§3.4) | `{kind: gate, userId, remember, redirectTo, iat}` or `{kind: enroll, secret, iat}` | 24 h Max-Age (upstream's pre-auth session lives the store lifetime) | flow completion (mint), logout, spec §3.3 dual-clear |
| `gitea_webauthn` | HMAC-signed state | `pending` (uid, remember, redirect) or `reg` (challenge + nickname) | 600 s (pending), 60 s (reg) | ceremony completion, logout |
| `gitea_webauthn_challenge` | HMAC-signed state | `assert` / `passkey` (challenge + allowlist) | 60 s | ceremony completion, logout |

Flags: HttpOnly, Secure, SameSite=Lax, Path=/ (the SetSiteCookie posture).
Logout appends ALL FOUR clears (session + three carriers) — upstream's
HandleSignOut destroys the whole server session (auth.go:453-460), so the
carriers die with it; here each dies by its own Max-Age=0. A gate ticket of
the wrong kind never verifies (the two flows never cross-authenticate);
the TOTP gate ticket verifies ONLY against `gitea_twofa`, the webauthn
ceremony only against its own carriers.

### 3.4 The ticket AEAD (the enrollment-secret confidentiality fix)

The `gitea_twofa` value is `base64url(0x01 ‖ iv(12) ‖ AES-256-GCM(json))`
— ONE opaque token. The AES-256-GCM key is HKDF-SHA256(salt
`cf-gitea:twofa-ticket`, info `cf-gitea:twofa-pending-ticket-aead-v1`,
256 bits) over the instance secret; each mint draws a fresh random IV;
integrity is GCM's own authentication tag (the earlier HMAC-over-payload
shape folded into it — tampering fails the AEAD decrypt, one mechanism).
Confidentiality is the point: the ENROLL payload carries the TOTP shared
secret, which upstream never lets leave the server (security/2fa.go:145-152
parks `twofaSecret` in the session) — the earlier integrity-only HMAC
shape leaked it to the cookie jar. The version byte retires the old
`body.mac` format at decode (no transition window: outstanding pre-AEAD
cookies are simply dead — the holder re-authenticates).

## 4. Edge cases, limits, failure modes, and the recorded divergences

Each carries its pin; upstream behavior is the default decision — these are
the deliberate differences:

1. **SECRET AT REST**: upstream AES-encrypts the stored secret with
   md5(SECRET_KEY) and stores base64 (twofactor.go:93-106); our `two_factor.secret`
   stores the base32 in the clear — the landed schema's own decision (D1 is
   the source of truth; no [security] SECRET_KEY var exists to encrypt
   with). The IN-FLIGHT copy is as-built encrypted instead: the enrollment
   secret travels only inside the §3.4 AEAD ticket, never in the clear
   (upstream parks it server-side, security/2fa.go:145-152).
2. **REPLAY GUARD**: upstream stores the last-used PASSCODE STRING and
   refuses its second redemption (twofactor.go:127-143 — the conditional
   UPDATE over `last_used_passcode`, the row lock closing the TOCTOU); we
   consume the matched PERIOD (`last_used_passcode_period`) with a
   monotonic `period < matched` conditional UPDATE — strictly stronger (an
   OLDER window's code is rejected too, RFC 6238 §5.2's own
   recommendation) and the write is the serialization point exactly like
   upstream's row lock.
3. **THE PRE-AUTH CARRIER**: upstream uses its server session; ours is the
   §3.3/§3.4 cookie pair (same trust shape: possession of the unguessable
   sealed value is the authority to continue the flow). TTLs are
   cookie-declared rather than store-lifetime.
4. **DUAL-CARRIER PARK** (§2.1): two cookies instead of one shared server
   session; both armed at the gate, both cleared at whichever flow
   completes first.
5. **RP DERIVATION**: upstream configures RPID=AppDomain,
   RPOrigins=[FullyQualifiedOrigin(AppURL)] once at init
   (modules/auth/webauthn/webauthn.go:27-44); a Worker has no app.ini —
   the RP is derived per REQUEST (hostname = rpId, origin = the exact
   clientData match; ports never appear in an RP ID).
6. **COSE ALGS**: the creation options offer ES256 (-7) + RS256 (-257)
   only; go-webauthn's default list leads with Ed25519 (-8). Authenticators
   fall back to the offered pair; Ed25519-only keys register nowhere.
7. **ATTESTATION**: "none" preference, empty-statement or packed
   SELF-attestation accepted, everything else rejected — upstream never
   verifies attestation (AttestationPreference PreferNoAttestation,
   webauthn.go:34), so certified-statement formats would fail upstream's
   own verification too.
8. **DISABLE REQUIRES A CODE**: upstream's disable is a bare confirm
   dialog (security/twofa.tmpl); ours also demands a live TOTP passcode or
   the scratch token, verified WITHOUT consuming either (a disable must
   not spend the user's last scratch code).
9. **NO QR**: upstream renders a data-URI PNG QR (security/2fa.go's
   twofaGenerateSecretAndQr); we render the otpauth URI text only (a
   barcode/PNG encoder is no trivial dependency — authenticator apps
   accept the pasted URI). The URI bytes are pquerna/otp v1.5.0-exact
   (sorted, PathEscape'd query, all defaults explicit).
10. **AUDIT**: upstream emits UserAuthenticationFailTwoFactor /
    UserTwoFactorEnable / UserTwoFactorDisable / UserTwoFactorRegenerate
    (2fa.go:88, security/2fa.go:62,100,282) — the ids are unregistered in
    the landed audit registry and NOT emitted (the account-link unload
    precedent). The IMPERSONATION pair IS registered and emitted:
    `user:impersonation:start` at the admin flip (users.go:580's Record —
    actor the admin, scope the target, an org target scoping
    `organization` per ScopeFromUser) and `user:impersonation:exit` at
    SignOut's restore (auth.go:476's RecordAs — actor the admin, scope the
    target). A failed audit insert logs and never fails the flow (upstream
    writeEvent's posture).
11. **EXIT REACHABILITY**: upstream's session Verify checks only
    `IsIndividual()` (services/auth/session.go:31-61 — no ProhibitLogin
    read) and SignOut runs ExitImpersonatedUser against the raw session
    regardless of the doer (auth.go:469-478), so an admin can always step
    out of an impersonation. Our §2.4 verify keeps the doer-status/type
    check (SPEC-0010's authority posture), so the logout exit arm keys on
    the (id, digest) presentation + the `impersonator_user_id` stamp
    alone — a prohibited or org-typed TARGET can never strand the admin.
12. **SIGN-IN PRIOR-ROW RETIREMENT**: upstream Regenerate destroys the
    presented pre-sign-in session ("an ID known before sign-in is never
    authenticated", modules/session/store.go:113-128 over auth.go:400-407);
    we verify-and-delete the presented row only when it belongs to a
    DIFFERENT user — a same-user prior row is kept alive deliberately (it
    already authenticates exactly the principal the new mint grants; its
    own TTL, logout, and reuse detection own the rest).
13. **BARE 403 BODIES** (shared chain, recorded here for the gate's
    neighbors): the sudo-non-admin (api.go:135-138) and
    prohibited-account (api.go:889-893) 403s are bare `{message}` JSON —
    no APIError `url` field — exactly upstream's literal ctx.JSON shape;
    every other error arm keeps the `{message, url}` APIError wrapper.

## 5. Testing plan (the landed suites)

- `apps/worker/src/auth/two-factor.test.ts` (real D1): enrollment
  round-trip (scratch shown once, only salt+hash stored), the consume/
  replay ladder over the PERIOD guard (older-window rejection), the
  scratch burn, the disable arm's code requirement, the pending-ticket
  codec — round-trip, TTL boundary (iat+24 h inclusive-expiry), kind
  separation, tamper (flipped ciphertext byte → GCM tag failure),
  truncation, junk, the RETIRED HMAC format rejected at the version gate,
  operator secret-rotation death, and AEAD CONFIDENTIALITY (the cookie
  carries the base32 secret neither as a readable substring nor as raw
  bytes anywhere in the decoded wire; fresh IV per mint), the §2.3 cookie
  flag set, and the pquerna-exact otpauth URI bytes.
- `apps/worker/src/ui/session.test.ts` (real D1, route-level): the gate
  ladder (not-enrolled byte-unchanged; enrolled 303 + no mint; the page
  arms; passcode/scratch success + failure re-renders; the replay guard
  end-to-end; the Origin guard; the forged-ticket 500 shell), the
  DUAL-ENROLL park (303 /user/webauthn with BOTH carriers; the TOTP
  fallback page renders 200 from the webauthn prompt; TOTP success clears
  both carriers + mints), logout's four-directive clear set (valid,
  cookieless, forged, carriers-present arms), cross-user re-login row
  retirement + the same-user keep-alive, the impersonation exit (restore,
  /-/admin, cookie stays), the exit audit row, the PROHIBITED-target exit
  reachability, and the org-target exit row's `organization` scope.
- `apps/worker/src/web/webauthn.test.ts`: the ceremony core (options
  builders, both verify ladders, the clone-warning ladder, the sign-count
  CAS) and the store op set.
- `apps/worker/src/auth/middleware.test.ts`: the two BARE 403 bodies
  (`{message}` only — sudo-non-admin, prohibited-account) against every
  other arm's `{message, url}` wrapper.
- `apps/worker/src/ui/pages/admin-users-impersonate.test.ts`: the flip,
  the refusal (no audit row), the unknown-user arm (no audit row), the
  org-target audit row, the widened target slice.
- `apps/worker/src/services/audit.test.ts`: the registry contract over
  the extended `user:*` family.

## 6. Landed-state notes

- The WebAuthn-side half of the dual-clear contract (the mint arm in
  `web/webauthn.ts` clearing `gitea_twofa` alongside its own carriers) is
  the WebAuthn unit's follow-up — session.ts's TOTP arms already clear all
  pre-auth carriers, and logout clears all four.
- `X-Gitea-OTP` (SPEC-0002 §2.2/§4.6) stays accepted-and-ignored: the API
  chain authenticates PATs, which are already single-proof credentials;
  upstream's OTP check guards Basic-with-password, which does not exist
  here.
