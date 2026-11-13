# The convergence backlog (v1.5.8 freeze, 2026-11-04)

The user-ordered convergence line: census modules complete + S/M drain, the
L-class feature lanes archived here (not compatibility gaps), the pool to
zero after the freeze. This document is the authoritative hand-back list —
everything below is DESIGNED and RECORDED, nothing is lost, and each item
names its resume point.

## 1. The census's honest final state (13/17 modules COMPLETE)

Modules 2 (auth), 4 (repos), 5 (users), 6? — see §2's table for the exact
COMPLETE set (auth, repos, users, git-http, issues, PRs, releases+tags,
actions, packages, webhooks, notifications+mail, admin = 13).

**Not-yet-censused (4)**: module 1 (install), module 3 (the auth password
matrix — its §2 row carries a stale in-flight owner marker), module 5's
orgs+teams half (module 5 in the mandate numbering), modules 16-17
(federation, API-v1). CENSUS-M3's orientation notes are in
/tmp/CENSUS-M3-progress.md (assignment resolution: 1 + orgs/teams next).

## 2. The B-board's open rows at freeze (from B-11..B-72)

**Landed this convergence**: B-48, B-49 (+ the PR-create assignees
beyond-brief arm), B-50, B-51, B-54, B-55, B-56, B-57, B-62, B-63, B-64,
B-65 (receiver half), B-70 (page half) — plus v1.5.7's B-24/29/34.

**Parked mid-build (designs complete, resume points named)**:
- **B-58** (codec/digest tails) — the ENCODER (Packages.xz store-then-serve)
  + md5 were green; the LZMA2 DECODER half was mid-build at the stop. Files
  preserved verbatim in /tmp/pkgtails-parked/ (xz.ts, xz-encode.ts, md5.ts,
  xz.test.ts — the decoder's 9 pins included); debian.ts/conan.ts rolled
  back (their edits depended on the parked helpers).
- **B-65's remainder** — the repository-source thread's API leg (complete
  design in /tmp/MAILNOTIF2-progress.md step 4: read-time derivation over
  repo_transfer, user_settings_kv state, negative-id threads, the zod enum
  widening, two-leg top-K merge) + the per-arm receiver test file + the
  THREE emit-site wirings (releases.ts publish arms / repo.ts transfer
  route / update.ts refreshRunStatus tail — one line each, named in the
  receivers' doc comments).
- **B-70 — CLOSED 2026-11-13**: the mounts had already landed (they rode
  the f8fe5ac fold; c13b23c/90b1526's "parked/NOT flipped" messages lagged
  their trees); the resume unit verified every region (import/family/parse/
  handlers/registrations), the battery pins the full surface, and the AD11
  cell carries the ANSWERED stamp. Nothing remains.
- **B-59 — CLOSED 2026-11-13**: the seam landed (teamPackagesUnitMode +
  the blanket-write guard over teams.units_map, 6 pins green); the
  "columns migration" framing was a misnomer — the column already existed.

**Open, not started**: B-52 (agit refs/for/* — L, feature lane), B-53
(block_on_codeowner_reviews + protected-file merge gates — L, feature
lane), B-66 (SMTP transport arm — the connect()-era premise recheck), B-67
(admin-packages web write tails), B-68 (dashboard maintenance-ops), B-69
(SendTestMail), B-71 (admin user↔org removal arms), B-72 (bot users axis —
L, feature lane), B-61 (provider webhook request formats + the matrix type
— M, the one WIRE-VISIBLE divergence left on the board).

## 3. The standing cruft list (small, recorded, non-blocking)

- The audit doc's residual cite-convention debt (38 notes, M10-era).
- The golden files WHWAVE2 flagged for their owning units
  (admin-hooks.html + the releases/tags set — DOM-consistent but
  un-rebaselined).
- IDCHAIN's two fidelity seams (the test rig's identityUserFromRow; the
  UI-explore requester at api/services/search.ts:108).
- The probe battery's blip-era fixture rows (the next cleanup-audit run
  sweeps them).
- The production PBKDF2-iteration-cap probe (PWD-3's ready-made harness
  arm, un-run — the 50k default is documented-safe by the platform cap).

## 4. The L-class feature lanes (explicitly NOT convergence blockers)

B-52 agit push-to-propose; B-53 codeowner/protected-file merge gates;
B-72 the UserTypeBot axis. Each is a feature-sized port with a pin
derivation already on its census row — scheduled work, not compatibility
defects.

**The standing rule after this freeze**: the 04:05 routine keeps the
lights on (drift checks, the cleanup-audit); units dispatch only on
demand — the user's usage-driven reports are the trigger.
