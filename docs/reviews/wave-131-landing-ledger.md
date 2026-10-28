# Wave-131 Landing Ledger — RD23 and the post-deploy index wave

The wave-131 record: the **RD23 deploy window** (2026-10-28 morning +0800)
and the landings that followed it in the same morning. RD23 carried the
wave-130 fix wave into production together with migration 0035; the landings
after it — the P0+P1 index wave (`b04a465`, migration 0036) and matrix batch
fifteen (`7c3b7c47`) — ride the NEXT window (RD24, PENDING at this doc's
writing). Successor to `docs/reviews/wave-130-parity-review.md` (house
format inherited); that doc owns the fix wave's full scoreboard and is
referenced, not duplicated.

Provenance: every hash below was verified against `git log` at HEAD
`7c3b7c4` (working tree clean); the battery arithmetic is derived from the
committed probe inventory in `scripts/deploy-probes.mjs`; the RD23 deploy
facts (deploy version, remote migration, battery verdict) are the
orchestrator's record cross-checked against the tree — the dedicated
evidence append in `docs/design/p0-evidence.md` does not exist yet (its tail
ends at the REDEPLOY22 block, line 3253) and is the orchestrator's to land.
Unverifiable-from-repo items are marked as such inline.

## 1. RD23 — the deploy

- **Worker**: deploy version `a54c6adb`. Not a git object in this repo —
  correct per the lineage convention (the deploy VERSION id is wrangler's,
  distinct from the GO tree commit; the same relation as RD22's
  GO `5f3c26f` → version `73158aa8`, recorded in the fourth addendum of
  `docs/RELEASE-NOTES-v1.2.md` and the REDEPLOY22 evidence block,
  `p0-evidence.md:3243`).
- **Timing**: the morning of 2026-10-28 (+0800), bounded on both sides by
  committed evidence — after `29e3a43` (09:31, whose fixwave-parity live
  smoke ran against the standing RD22 deploy) and before `b04a465` (09:37,
  a post-RD23 landing per the orchestrator's record).
- **Schema**: **migration 0035 `spooky_galactus` applied remotely** — the
  wave's only schema change, the additive
  `ALTER TABLE sessions ADD remember integer DEFAULT false NOT NULL`
  (the file is one statement). This closes the fourth addendum's explicit
  deferral: "which rides the NEXT deploy window (REDEPLOY22 carried none)"
  (`docs/RELEASE-NOTES-v1.2.md:482-485`).
- **Deploy-probe battery verdict: 112 passed / 1 item.** The 1 item is the
  cleanup-audit's `audit-personal-access-tokens` arm — the per-run PAT was
  still alive at audit time and was deleted at wrap close (the standing
  instrument pattern: RD21's "cleanup-audit 9/1 (the 1 = the live rd21-run
  PAT, deleted at wrap close)", `p0-evidence.md:3231-3232`; RD22's "the
  live run-PAT audit item (deleted at wrap)", `p0-evidence.md:3246-3248`;
  the RD20 footnote in `docs/RELEASE-NOTES-v1.2.md` §4). A deliberate
  audit-instrument step, NOT a product failure.
- **Arithmetic reconciliation (derived, offered for the evidence block)**:
  the nine standing batteries' committed check inventory totals exactly
  113 — p0 4, registry 21 (7 arms x 3 trials), generate-e2e 10, forkpr-e2e
  8, mirror 8, ui-login 5, window2-mounts 22, window3-mounts 25,
  cleanup-audit 10 (`scripts/deploy-probes.mjs`, per-battery `id:` census).
  112 passed + 1 item = 113: the standing batteries went fully green except
  the run-PAT item, with no mirror chain-skips this window (RD22's 108/2
  carried the mirror cold-settle item; RD23 had none). The fixwave-parity
  battery's 22 checks are accounted SEPARATELY (it is `independent: true`
  per family by design, `deploy-probes.mjs:2941`) — its formal post-deploy
  green run is part of the RD24 verdict plan (§5).

## 2. What RD23 carried — the wave-130 fix wave (pointer)

**30 landed findings / 7 deliberate keeps, across 15 commits
(`28df818` → `bd6d257`)**. The authoritative scoreboard — the L1–L30 table
with per-finding commits, the K1–K7 keeps with rationales, the credits, and
the gate record — is `docs/reviews/wave-130-parity-review.md` (committed at
`6165474`); this ledger does not duplicate it. The production proof those
landings now have is the fixwave-parity battery (§3), whose families exist
precisely to assert the wave's live shapes against the deployed worker.

## 3. The verification battery RD23 introduced

Two commits landed into the tree immediately before the window and are the
deploy's verification instrument:

| Commit | What | Key facts |
|---|---|---|
| `29e3a43` | **fixwave-parity** — the toolkit's 10th battery, 22 checks over the fix wave's live shapes: PR head-sync → merged-PR 412 → ghost-404, tag-only push-create survival, the org-team revoke with its masked-404 git cut, the private-user visibility ladder, the sudo pair, the session rotation's full cookie directive | `fw-org-member-preaccess` (`deploy-probes.mjs:2616`) is the post-deploy discriminator — "row-19's git grant rides the next deploy". Live smoke vs the standing RD22 deploy read **20/1 — every fix-wave arm already green, the one red IS the pending org-grant deploy** |
| `f963ef8` | the probe README's battery list brought current — all 10 batteries + the two new entries' canonical expectations and failure-tail enumerations | docs-only |

The battery needs an ADMIN PAT and wrangler auth for its D1 arms (the
rotation backdate is the toolkit's first D1 WRITE path); every family
self-cleans with a force-red-proven tail (`deploy-probes.README.md:251-279`,
committed at `f963ef8`).

## 4. Post-RD23 landings

| Commit | Landing | Gate (verbatim from the commit message) |
|---|---|---|
| `b04a465` | **perf(db): the P0+P1 index wave** — migration `0036_fantastic_whirlwind`, 10 indexes (labels repo+org, the issues list page's filter+order composite, the two poster heatmaps — issues' is COVERING, reactions' target composite, milestones, repositories.owner_id, the action repo-feed order, issue_subscriptions issue-side) + the always-on rows_read witness in `bench-d1.test.ts`. Headline witness numbers: reactions target 250→6, issues list page 480→30, subscriptions 200→3. Upstream-matched where an upstream index exists; divergences documented at each index's schema comment | "101/101 +5 bench-skips x2; openapi PASS" |
| `7c3b7c47` | **matrix batch fifteen** — route-level pins of the fix wave's seams at the level users actually hit: the PR-head sync's user surface (created refs fire NO sync; the UPDATE push moves the pages newest-first over the moved range; the outdated blocker lands off the synced `commits_behind` — `pull-files.matrix.test.tsx`), the sudo seam from BOTH sides (`?sudo=` inert on web URLs via `user-profile.matrix.test.ts`; cookie-only credentials + sudo on the API → 403 via `users.test.ts`), the org-revoke UI half (`org-members.matrix.test.tsx`: the members page drops the row through the one mutation entry, the settings orgs list flips empty, the LastOrgOwnerError refusal keeps both pages). The user-visibility UI half and the compare-empty page arm verified ALREADY pinned — skipped, no gap | "133/133 across the four suites, tsc 0, eslint clean (own eyes)" |

The engineering record of the index wave — audit method, the D1
cached-plan and DDL-`exec()` platform facts, the witness protocol — is
`docs/research/d1-index-engineering.md` (same wave).

## 5. PENDING — the orchestrator finalizes

- **Migration 0037 (the P2 index sweep + dead drops) — LANDED** (`7dc607f`):
  as-built `0037_smart_blizzard.sql` — 8 index adds, 9 verified-dead drops,
  the veto witness (was IN FLIGHT at this ledger's reference HEAD
  `7c3b7c4`; content matched the orchestrator's brief — the audit's P2
  tier plus the removal of dead indexes).
- **RD24 deploy — PENDING.** Payload: migrations 0036 + 0037 (both
  post-RD23 landings ride it). Verdict arm per the orchestrator: the
  fixwave-parity battery's `fw-org-member-preaccess` check going green.
- **Evidence appends — PENDING.** The RD23 block in
  `docs/design/p0-evidence.md` (tail currently ends at REDEPLOY22,
  `p0-evidence.md:3253`) and the RELEASE-NOTES fifth addendum.

One tension flagged for the orchestrator (recorded, not resolved, per this
ledger's verify-then-write rule): `29e3a43`'s own comment calls
`fw-org-member-preaccess` the discriminator for the deploy carrying row-19's
git grant — from that commit's vantage, the next deploy was RD23 itself, so
the arm's first green was already available to RD23's battery run, while
RD23's recorded verdict (112/1, §1) reconciles with the NINE standing
batteries only. The clean reading is that RD23's probe run exercised the
standing batteries (113 checks, 112+1) and the fixwave-parity battery's
formal green run is being held for RD24's post-deploy evidence — but that
is an inference; the orchestrator's RD24 evidence block should state which
run first recorded the arm green.

## 6. Verification notes

- Hashes `b04a465`, `7c3b7c47`, `29e3a43`, `f963ef8`, `6165474`,
  `28df818`→`bd6d257` (range endpoints), `5f3c26f`, `7bec99e`, `73158aa8`-as-non-object:
  verified via `git log` / `git show` / `git cat-file` at HEAD `7c3b7c4`.
- Migration filenames `0035_spooky_galactus.sql` / `0036_fantastic_whirlwind.sql`
  verified in `apps/worker/src/db/migrations/`; 0037 verified ABSENT.
- Battery per-check counts verified against the committed `id:` census in
  `scripts/deploy-probes.mjs`; the 113 total and the 112+1 reconciliation
  are derived from that census (§1), not quoted from a run log.
- The witness headline pairs 250→6 / 480→30 / 200→3 are quoted from the
  `b04a465` commit message; the pairs 60→13 / 550→441 come from the run's
  `##INDEX_WITNESS_JSON##` record via the orchestrator (not tree-printed)
  and are independently consistent with the committed corpus arithmetic —
  see `docs/research/d1-index-engineering.md` §3 for the derivation and the
  one corpus-annotation drift found there (`reactions: 300` vs 250 seeded).
