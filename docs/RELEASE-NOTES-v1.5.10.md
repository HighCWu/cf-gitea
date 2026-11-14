# cf-gitea v1.5.10 — Release Notes (the recorded-tails wave)

**Range**: `303ad6f..3105311` — 10 commits, 2026-11-14's evening wave: the
census rows' recorded remainders drained to zero. Deployed as version
**`c12b6e7a-f2ab-437c-ba48-9d29fb542d2b`** (the previous deploy d1997ad4 carried
the same day's tab fixes; this wave adds the tail landings). Composite gate
**PASS** (509 test files; one load-flagged file solo-adjudicated green;
650s wall — the first two runs caught REAL fallout of the wave's own
intended landings and both were fixed in-gate: the stale one-row type-29
pin + a race in its replacement (now waitFor-deterministic, 3x
stability-checked), and four goldens + their a11y twin rebaselined for the
tab-active fixes the earlier hotfix deploys had carried without a gate
pass — the recorded lesson: DOM-touching hotfixes owe a golden regen
check BEFORE deploy). No migrations this wave (the chain stays at 0079).

## The wave (every item a census row's recorded remainder)

- **PULLORG** (3a68592): the PR surface's arms thread the request origin as
  AppURL — full-URL cross-repo references in PR bodies/titles now scan
  (B-46's origin-threading tail).
- **ENGSEAM** (98b6190): the engine's `listCommitsRange` gains the
  `skipCacheWrite` seam — the INVFIX cache-discipline class is closed for
  BOTH push-walk arms; the engine contract check grew to 10/10 with a
  falsification control.
- **AUDITCTX + AUDITCTX2** (1c2a900, 574236e): the audit rows' request
  context — `actorCredential` (PAT/grant kinds via the R3-M3 single copy)
  and the client IP (`CF-Connecting-IP`, the platform's RemoteAddr
  equivalent; the limiter's sentinel can never leak into the column) —
  threaded across the API arms, the web edit arm, the own-password arms,
  and the totp-fail row (B-89's open (3) closed end-to-end).
- **AGIT3T + AGIT29C** (0c995a9, f3922ba): the agit lane's three optional
  tails (the update-arm type-29 push comment + review stale/dismiss
  maintenance + the immediate check) plus the CREATE arm's first type-29
  comment — with two derivation corrections recorded honestly (the check
  is update-arm-only; old is the base tip, never ZERO_OID).
- **XREFCMT** (5d92f2e): the comment xref arms (create/edit-neuter/delete,
  type-5 rows, the no-same-repo-merger-exception bite) — and B-47's ride
  honestly DISCONFIRMED at the pin (upstream scans nothing for push-walk
  ref comments; our writer was already exact).
- **TAILS2** (3105311): the github-flow first type-29 comment (the
  route-side shape won by necessity — the service-side shape is
  architecturally impossible) + the last audit next-touches.
- **DRIFTNEXT** (e0b1d0a): the forward drift preview — the next re-pin's
  map (pin → origin/main = 196 commits; 7,519 cite-moves / 2,319
  region-changes / 71 file add-removes over 875 of our files), pre-arming
  ADR-0009's five-category hours protocol.

## Probes (243 checks, 20 batteries)

Deploy c12b6e7a verified: the first sweep's 7 fails fully attributed —
4 transient-network cascades (mirror x2, auth-oauth2 x2, the fixwave
org-web chain riding wrangler d1's own network path; every affected
battery re-ran green standalone — fixwave needed three runs through
today's flaky uplink), ONE probe-side harness gap (bp-member-setup-204s
still carried the pre-PWD-4 password-less create body — v1.5.8 fixed the
fw-user-create twin and missed this one; fixed in the harness, battery
green), and ONE posture arm (signup-open: the probe expects the DEMO
posture's ALLOW_SIGNUP=true; the account-local config rebuild after the
B87 incident restored the SAFE default false — this arm reds by design
until the operator chooses to reopen signup). The probe PAT was
minted-before and SWEPT-after (row deleted, table verified empty, token
files shredded).

## Standing record

The census board remains fully drained; what this wave leaves recorded
(all next-window items, none blocking): agit.ts's stale module-header
remainder note, session.ts:965's XFF-first clientIp derivation (the session
owner's call), and the ADR-0009 data protocol awaiting the first real
re-pin.
