# cf-gitea v1.4 — Release Notes (the two-headliner wave)

**Range**: `58fd5cb..0d172ac` — **14 commits**, landed 2026-10-31 late
evening through 2026-11-01 midnight (the v1.3.3 tag `58fd5cb` is the base).
Deployed as **`b7ea786e`**; no new migrations (0057 `issue_user` was applied
remote with v1.3.3); the probe battery adjudicated **217/219 → 10/10** (the
two first-run fails were the audit's own stale count expectations — the
auth-oauth2 battery's runs leave two standing repos/five standing tokens;
the adjusted audit clean 10/10).

The wave's shape: **the two v1.4 headliners finished whole** — the OAuth2
Provider and External Auth Sources SPECs both reached W1–W6 complete — plus
the review mail family, the mentions follow-ups, and the documentation-debt
sweep. Eight 1308 quota-death waves were absorbed across the two days; the
salvage discipline landed four posthumous units whole.

## 1. OAuth2 Provider — W1–W6 complete ("Sign in with cf-gitea")

- **W1 `ed52dd5`** (v1.3.3's tail): the JWS family zero-dep (verified
  byte-for-byte against RFC 7515 appendix A.3's fixed vector), the grants
  store with DELETE-rowcount one-time semantics, the five builtin
  applications seeded.
- **W2+W3 `469fab9`**: the token endpoint (RFC 6749 §5.2 bodies byte-exact,
  both grant types, PKCE, the no-default-rotation trap) + the Bearer-dots
  dispatch feeding the LANDED apiScopeGate unchanged; the ten-step authorize
  ladder with the consent page and the sessions.oauth_state CAS dance. My
  integration fix at landing: the shared containsRedirectURI's IPv6 re-spell
  (W2's cross-unit find).
- **W4 `18b78a8`** (posthumous salvage): the discovery doc, the
  OAUTH2_ENABLED gate wraps, the **git-HTTP realm flip** (`Basic
  realm="Gitea"` when on — the GCM builtin-app flow), the audit row, the
  algorithm/issuer plumbing.
- **W5 `b91dd1c`**: the settings pages' OAuth2 halves in three chromes —
  the secret-shown-ONCE posture byte-exact, and the load-bearing discovery:
  upstream's web EditSave does NOT rotate the client secret (the model
  update never touches it); the web save carries a page-local UPDATE —
  routing through the rotating API service would kill every deployed
  integration's stored secret on a plain rename.
- **W6 `4754bdc`**: the auth-oauth2 probe battery — the scripted
  third-party client end-to-end (PKCE consent dance → exchange → Bearer
  dispatch → offline JWKS WebCrypto verification → refresh with the
  no-rotation counter pin → introspect → revoke-kills-token).

## 2. External Auth Sources — W1–W6 complete (OIDC + GitHub + Google login)

- **W1 `85d094b`** (v1.3.3's tail): the login_source/external_login_user
  tables (migration 0056), the strict cfg-codec, the 17-entry provider
  registry.
- **W2 `85103d1`**: the OIDC client flow + the identity ladder straight to
  external_login_user (no email-match auto-link — the ratified takeover
  guard), the state dance over the composite carrier.
- **W3 `470ffc9`**: the github + google clients (the pin correction:
  github's external id is the NUMERIC id, not the login; goth v1.82.0's
  URL values verified from source) — my route fold at both legs.
- **W4 `77dfccb`** (posthumous salvage): the admin auths CRUD + the
  login-page source buttons — OIDC + github + google live end-to-end.
- **W5 `b91dd1c`** (landed with OAuth2 W5): the link-account pages (both
  arms, the admin-init-window guard BEFORE any credential work), the
  settings-security account-links section (no last-link guard at the pin,
  test-pinned), the re-dance contract with untrusted hints.
- **W6 + the carve `0d172ac`**: the battery's ext arms + the
  dispatcher-conjunction carve (the `isUserAuthPath` twin of isLoginPath;
  "user" is a reserved username upstream — the family can never shadow an
  /owner/repo pair; six dispatcher arms).

## 3. The mail review family `7234eb4`

PullRequestReview (the verdict line + kept body), PullRequestCodeComment
(the mentions-ONLY batch — a non-mentioned watcher gets nothing), the
review-request pair (type-27's nil reply payload), and the team-add fold
(the poster skipped, each member through the same receiver's gates). The
SPEC §14.6 flip rode the mentions sibling's commit — the disclosed
fold-in. The armed-env tripwire extended.

## 4. The mentions follow-ups `b8d2171`

NewIssueUsers seed whole (the full GetRepoAssignees port with the org-team
arm; the mark-read arm adjudicated STAGED — upstream's only is_read
consumer feeds a field the pin never renders), the global `assigned`
search flag across all three surfaces, dropStarsFor's latent count flaw
fixed (the watch-tails fix's twin).

## 5. The documentation-debt sweep `fef637b` + `b950913`

P3-5's three stale claims closed with verified hashes; ALL SEVEN
DISCLOSED-HASH placeholders filled; the demo-sweep header + index.ts
hourly comments rewritten from the real artifacts; the board's
protocol-count rows reconciled to 21/21.

## 6. The freeze gate and process

The composite gate on the quiet frozen tree: 414/418 in-suite with every
residue file solo-green (the four-file adjudication documented; the one
teardown race attributed to vitest-worker). CI's own gate run red on ONE
solo re-run of a file that passes 16/16 on both trees — recorded as the
same load-flake class (the CI runner's own concurrent solo pair). The
deploy chain: build → deploy `b7ea786e` green first try (the drizzle
single-chunk pin from cc40bf6 carried); the 219-probe battery then the
adjusted audit 10/10; PAT hygiene done.

**Process records for the next wave**: the sequential-landing chain (two
W5 waves sharing ui/index.ts landed together per the guard's own
dependency finding); the shared-file sweep attribution (the §14.6 flip);
the grant's six-unit pool discipline held through the whole release.
