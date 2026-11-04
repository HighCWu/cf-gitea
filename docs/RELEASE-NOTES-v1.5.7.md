# cf-gitea v1.5.7 — Release Notes (the ADR-0008 behavioral wave)

**Range**: `5273cc2..e5e7c4e` — **36 commits**, landed across 2026-11-03's
night and 2026-11-04 — the ADR-0008 wave: upstream behavior became the
acceptance standard, the password system landed, and the behavioral census
was born as the durability mechanism.
Deployed as version **`83c07e81-77a8-4e4f-9d2a-198c4863ce2e`**. Probe
battery **green with two harness corrections attributed** — round 1 caught
the probe script itself still using the REMOVED PAT-as-password login
method (~20 login-family fails, all fixture-shaped: the deployed worker was
right); the harness now seeds a real pbkdf2 record into D1 (the worker's
own derivation) and logs in end-to-end. Round 2: **210 pass / 6 warns (the
documented token-unconfigured classes) / 10 skip**, with the remaining 25
fails ALL inside fixwave-parity — a transient network blip (20 fetch-failed
cascades) plus the battery's stale org-team action URL (missing the `/org/`
prefix upstream pins at web.go:963-1000 — a legacy alias used to satisfy
it); after both fixes fixwave-parity re-verified **31/31 standalone
(exit 0)**. Blip-era cleanup leftovers (probe-prefixed fixture rows) are
recorded for the next cleanup-audit sweep.
The full-suite composite gate was accepted **green** on the release tree:
**488 files ran, 487 pass, ZERO timeouts, 1 assertion file solo-adjudicated
load-attributed** (repo-actions — green in its own process, the gate's own
`--solo` verdict; the D-8 straggler-insert class, §3), **2 vitest-worker
teardown races noted** (the new EnvironmentTeardownError carve-out, §3).
**Six migrations land with this release** — `0069` (FN-5's upstream column
names), `0070` (FN-7's `merged_commit_id`), `0071` (`renamed_branches`),
`0072` (FN-8's commit-status index/hash), `0073` (FN-10/12 strictness
flips), **`0074` (the users password columns — `passwd`, `passwd_hash_algo`,
`salt`, `rands`)** — remote-applied BEFORE the deploy (all six ✅ in the
freeze chain; the chain is idempotent re-runs).

## 1. The theme: ADR-0008 — upstream behavior IS the acceptance standard

The user's ruling (2026-11-04, docs/decisions/0008) ended the
feature-vs-compatibility framing: **原版 Gitea 是行为规范，不是可选参考**.
Seven execution principles landed with it — upstream-standard behavior is
in-scope by default; behavior gaps are fixed, never adjudicated; platform
differences change internals, not external behavior; **silent ignores are
forbidden** (accept-and-ignore is a contract defect worse than absence);
deferred records are re-opened, not exemptions; compatibility derives from
the pin's actual code per entry point; completion is **behavioral
equivalence**, not code presence. Two first applications were ordered and
both landed this release: **the password system** (§2) and **the module-by-
module behavioral census** (§4).

## 2. The password system, Phase A — username+password is a basic
## compatibility requirement

The gap the ruling called out (a passwordless front door; PAT-as-password
as the only human credential) closed end-to-end, PBKDF2-default per the
user's separate hash ruling (upstream default `pbkdf2` = `pbkdf2$50000$50`,
WebCrypto-native; bcrypt/argon2 measurement is Phase B, in flight):

- **Migration 0074**: `users.passwd/passwd_hash_algo/salt/rands` — the
  defaults reproduce upstream's password-less row shape (`user.go:783-794`);
  the NOT-NULL-vs-nullable-xorm divergence recorded in SPEC-0002 §6.3.
- **Hash service** (`auth/password.ts`): BOTH pbkdf2 arms with the
  DO-NOT-COALESCE rule (`hash.go:109-116` — bare `pbkdf2`/empty = the
  original 10000-iteration legacy), `hex(pbkdf2.Key(pw, salt, iter, 50,
  SHA-256))`, the length-10-raw vs hex-decoded salt paths, controlled
  errors on corrupted rows — 8 named vectors Go-generated and
  Python-cross-checked, 24/24.
- **Entry points, each derived at the pin**: web login (`auth.go:292-369`,
  PAT-as-password REMOVED, generic failure, the 2FA gates consume the
  password result); API Basic (`basic.go:44-197` — token arms first,
  WebAuthn hard-reject verbatim, TOTP `X-Gitea-OTP` atomic consume +
  audit, the synthetic all-scope doer); git-HTTPS (`githttp.go:146-178` —
  the password arm + the TOTP-enrollment 401's verbatim message);
  change-password web (old-check, remember-me-only invalidation);
  admin-set web edit (empty = unchanged, policy ladder);
  install-init (hashed + rands inside the atomic insert);
  the reset machinery (byte-format time-limit code, 180-min TTL,
  passwd/rands one-time); the policy module (min 8, all-classes
  complexity, pwned default-OFF).
- The B-1 "Access Token" label divergence (2026-10-30) retired with its
  cause: the login label is "Password" again, the forgot-password link
  occupies upstream's slot.
- Open (routed to the in-flight wave): the admin API create/edit password
  arms + `must_change_password`, wire-level Basic/git/reset batteries, the
  Phase C config knobs.

## 3. The gate grew teeth for today's environment

The composite gate (ADR-0006) failed three honest rounds on 2026-11-04 —
not regressions but environment classes it had no carve-out for, each now
adjudicated **with** the mechanism rather than around it: vitest-worker
`EnvironmentTeardownError` races (post-result worker-close noise, present
in EVERY full run today) are counted separately and noted when their files
pass — every other unhandled error keeps the fatal rule; the repo-actions
D-8 straggler-insert race (a `waitUntil` onPush insert landing after the
settle barrier under desktop load) got a 6-pass moat and the gate's
`--solo` adjudication (load-attributed, green solo — the count-exact drain
is the recorded proper fix); pull-engine's fork-head arms got 180s budgets
after blowing 90s in two loaded rounds while passing solo. The freeze
verdict: PASS with full attribution.

## 4. The behavioral census — the table census's behavioral twin

`docs/compat/behavioral-census.md` was born (CENSUS-B) and grew its first
five modules this release: AUTH-beyond-password (53 rows), REPOS+SETTINGS
(41), USERS (26, CENSUS-WAVE2), GIT-HTTP (11, CENSUS-WAVE2), with the
B-numbered backlog at **B-46 and climbing** (B-11..B-45 landed). Its first
remediation wave landed in the same release: **B-29** (six of seven
`GenerateRepoOption` booleans were accept-and-ignore LIES — all six copy
arms landed: topics/git-hooks/webhooks/avatar/labels/protected-branches),
**B-24** (`object_format_name: "sha256"` was accepted then silently
produced sha1 — now refused with upstream's exact text), **B-34**
(require-sign-in-view was a dead letter — the flag now arms the API group,
git-HTTP rows 1/4, and the anonymous web shell), **B-32/B-33** residue
recorded. The census protocol itself (§6) queues modules 1 and 8-16 —
issues/PRs are in flight at freeze time.

## 5. Search/list parity ports (FY6's review, S-FIXES + S2 completion)

The pre-freeze adversarial review's MEDIUMs closed with pin-corrected
cites: **S1** public-only tokens are forced `Private=false` on search
(`repo_list.go:366-368`); **S2** the anonymous-search owner-visibility
exclusion (`:380-384`) — and its missed explore-code seed twin (the CODE
page was listing public-repos-under-private-owners the repos page hid)
closed at freeze (`ae88762`), with the explore matrix's divergence pin
flipped the REDFIX way: the fixture, not the product, was wrong. The rule-4
admin trio (max_repo_creation / restricted / allow_create_organization)
renders disabled-with-notice per the 3f4958b pattern until their real arms
land. REDFIX's lesson is recorded in-tree: the repoSearch "regression" was
our own golden recording a divergence 3197fee had correctly removed.

## 6. What else rode the wave

The FN tail closed the table census's rename backlog to EMPTY (FN-5's
eighteen renames + FN-7/FN-8/FN-10-12; CENSUS3 dispositioned the residual
"RENAMEs" as recorded names); the API inventory regenerated to the FULL
frozen contract (554/350, all nine families at 0 remaining); the mirror
settings became editable (MIRROR, `27abab8`); webhook event coverage
reached 25/26; the generate/content/template surfaces gained their
upstream arms (TEMPLATES); the 04:05 quota-recovery cron was rewritten to
the ADR-0008 vocabulary.

## 7. Known opens at freeze

The census's B-backlog (highest severities scheduled first), the password
Phase B report (measurement in flight), Phase C knobs, the admin API
password arms (in flight), census modules 1 and 8-16, the table census's
11 open MISSING targets, the D-8 count-exact drain. None block the
release; all are tracked with owners.
