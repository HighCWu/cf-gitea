# SPEC-0013 gate assessment — the ledger says "draft — gated", the tree says otherwise

Date: 2026-10-28 · Question: has SPEC-0013's §1.1 ratification gate effectively fired,
and what is the true implementation state? The `specs/README.md` ledger row (line 49)
still reads "draft — gated … ratification gated on §1.1: a concrete branch-protection
demand, or the landed-but-idle reviews family pulling the merge gate", while the tree
carries what looks like the full implementation. This document establishes reality.

Method note: read-only pass over the tree, `git log`/`git show` on the owning paths,
a scoped vitest run of the five branch-protection test files (see §1.6), and a
surface-level anchor check against the `gitea/` submodule at its pin. Everything is
cited file:line; claims I could not verify in tree are marked as recorded (not
re-verified) or unverifiable.

## Verdict in one line

**The gate fired, the SPEC was ratified (a10374e, 2026-10-25), and the FULL scope
(M1–M4) landed, deployed, and tested on the same day — the ledger row is stale, and
it is not alone: the SPEC file itself is internally stale in three places.**
Recommendation: **RATIFY** (retroactive bookkeeping commit to make the paper trail
match the tree — details in §4).

## 1. Implementation reality map

Every capability in the SPEC's "Owns" line exists in tree, deployed.

### 1.1 The `protected_branches` D1 table — EXISTS

- Schema: `apps/worker/src/db/schema.ts:2035-2060` — `protectedBranches`
  (`repo_id` TEXT per the repo-scoped convention, `rule_name`, `priority`, `rules`
  JSON, `created_unix`/`updated_unix`; UNIQUE(repo_id, rule_name) at :2057, repo
  index at :2060).
- Migration: `apps/worker/src/db/migrations/0019_mixed_raza.sql:1-12` (table + both
  indexes). Applied to REMOTE D1 per the deploy record
  (`docs/design/p0-evidence.md:414-416` — "0018 (`pull_reviews`), 0019
  (`protected_branches`) — both ✅; `d1_migrations` ledger 20/20 applied").
- Deploy probe coverage: existence only. `scripts/deploy-probes.mjs:166` asserts
  `protected_branches == 0` in the cleanup audit (a population check that the table
  exists and was swept) — the protection FLOWS are not probed by the standing probe
  script (see §4 gap 2).

### 1.2 The rule match/predicate service — EXISTS

`apps/worker/src/services/branch-protection.ts` (1,072 lines), all exports verified:

- Glob machinery: `isRuleNameSpecial` :297, `compileRuleName` :417, `ruleMatches`
  :433; `listRepoRules` :455 / `findRule` :477 (first-match over the priority →
  plain-before-glob → created ordering).
- Config vocabulary: `ProtectedBranchConfig` :104-139 with the single
  camelCase→upstream-snake_case mapping `RULE_CONFIG_JSON_KEYS` :183-218
  (`can_push` … `block_admin_merge_override` — upstream's exact json keys verbatim,
  `protected_branch.go:45-80`); `serializeRuleConfig` :222, `parseRuleConfig` :231,
  `emptyRuleConfig` :142. The §6 "stored and echoed but not enforced" fields
  (`enable_status_check`, `protected_file_patterns`, `require_signed_commits`, …)
  are all present in the mapping — stored, rendered by the API, never enforced.
- All six upstream predicate ports: `canUserPush` :567, `canUserForcePush` :576,
  `canUserDelete` :587, `isUserMergeWhitelisted` :603, `canBypassBranchProtection`
  :615, `isUserOfficialReviewer` :630.
- Approval counting (the reviews payoff): `grantedApprovalsCount` :650,
  `mergeBlockedByRejectedReview` :675, `mergeBlockedByOfficialReviewRequests` :693,
  `mergeBlockedByOutdatedBranch` :704, composed by `checkPullBranchProtections` :724.
- Rule-change recompute: `recomputeOfficialForRule` :765 (the §2.3(g) port).
- M4 breadth: `sanitizeUserWhitelist` :874, `sanitizeApprovalWhitelist` :894,
  `sanitizeTeamWhitelist` :911, `sanitizeRuleWhitelists` :928,
  `scrubUserFromAllRules` :1018, `scrubTeamFromOrgRules` :1046; the deploy-key /
  Actions pseudo-id constants :96-97.
- Tests: `apps/worker/src/services/branch-protection.test.ts` (756 lines; 45 tests,
  verified passing live — §1.6), including the nine-cell bypass matrix recorded in
  the M4 as-built (SPEC §"As-built — M4").

### 1.3 The merge-RPC approval gate — EXISTS

`apps/worker/src/api/routes/pulls.ts`, POST merge:

- Merge-whitelist arm FIRST (upstream `IsUserAllowedToMerge` ordering): findRule
  :1574 → `isUserMergeWhitelisted` :1577 → 403 "User not allowed to merge PR" :1578
  (the SPEC-0013 §3.3 comment block at :1570-1573 cites its upstream source).
- The 405 family AFTER the mergeable precondition: "manually merged" skip :1613,
  `checkPullBranchProtections` :1614-1617 (fed the commits-behind count surfaced by
  the lazy mergeability check :1599), `force_merge` clears only through
  `canBypassBranchProtection` :1619-1625, 405 with the failure text verbatim :1627.
  The verbatim text contract is documented at :51-53 and pinned by
  `apps/worker/src/api/routes/pull-merge-protection.test.ts` (387 lines, landed with
  M1 in 0c33d07; part of the §1.6 scoped run).
- Post-landing consumer: the merge-delete guard's protected-branch arm (66f5977,
  2026-10-26) calls the landed predicate for `CanDeleteBranchWithPermission`
  (branch.go:573-578) — implementation continues to attract dependents.

### 1.4 Push-time per-ref rejection (engine hook) — EXISTS, including the vendored-engine deviation

- Engine seam: `packages/git-engine/src/mod.ts` — the hook types :211-233
  (`ClassifiedPushCommand`, verdict, context), the fail-closed contract-violation
  message :830-858, the invocation between scan and finalize :1145-1153, and the
  per-call `EngineCallOptions.validatePush` field :1305 (NOT `DurableGitOptions` —
  mirror/import/transitional receives carry no hook by construction).
- Classification RPC: `packages/git-engine/src/control-plane.ts:173`+ and
  `packages/git-engine/src/repo.ts:901` (`classifyReceive` — create/delete are wire
  facts, ff-vs-force by real ancestry over lease-staged rows, one RPC per push).
- Worker wiring: `apps/worker/src/git-http/gate.ts:727-750` threads the callback on
  the same in-process channel as `pusher`.
- Deviation ledger: `packages/git-engine/NOTICE.md:137-139` — the 2026-10-25 M2
  entries (classifyReceive RPC, repo.ts method, the full mod.ts seam contract with
  index-aligned verdicts, fail-closed semantics, per-ref rejection filtering). The
  AGENTS.md vendored-deviation discipline was followed.
- Tests: `apps/worker/src/git-http/branch-protection-push.test.ts` (7 tests,
  verified passing live — §1.6; upstream reject texts + the default-branch-delete
  absolute arm + the no-callback mirror/import boundary); engine contract e2e
  `packages/git-engine/e2e/check-validate-push.mjs` (real receive flow over real DO
  RPCs + in-memory R2; constructed commits — "real git is not needed here" per its
  header comment).

### 1.5 The `/branch_protections` API family (6 ops) + Branch render extras — EXISTS

`apps/worker/src/api/routes/branch-protections.ts` (979 lines), all six upstream
operationIds verbatim:

| Op | Location |
|---|---|
| `repoListBranchProtection` | :524-533 (GET …/branch_protections) |
| `repoCreateBranchProtection` | :556-565 (POST; new-rule priority 0 → MAX+1 at :663-671, the upstream `UpdateProtectBranch` arm) |
| `repoGetBranchProtection` | :688-697 (GET …/{name}) |
| `repoEditBranchProtection` | :715-724 (PATCH …/{name}) |
| `repoDeleteBranchProtection` | :894-904 (DELETE, 204) |
| `repoUpdateBranchProtectionPriories` | :933-947 (POST …/branch_protections/priority) |

- Registered in the frozen contract: REG 6e6a703 ("declared 312→318"); the frozen
  swagger declares the paths at
  `apps/worker/src/compat/contract/v1-swagger.generated.json:8322, 8408, 8460`.
  Route tests: `apps/worker/src/api/routes/branch-protections.test.ts` (686 lines;
  29 tests per the M4 as-built, part of the §1.6 scoped run).
- Branch render extras: `apps/worker/src/api/routes/branches.ts` —
  `loadBranchProtectionContext` :182, the extras object :212-218
  (`user_can_push` / `user_can_merge` / `effective_branch_protection_name` /
  `protected` / `required_approvals`), consumed by the branches listing :360 and the
  single-branch read :547; model fields at `apps/worker/src/api/models/git.ts:209-216`.
- Deployed-instance exercise (one-off, manual): `docs/design/p0-evidence.md:1617-1626`
  — POST branch_protections → **201**, then the protected-vs-unprotected
  merge-delete skip differential verified live on
  `https://cf-gitea.hecongw.workers.dev`.

### 1.6 Reviews interplay — EXISTS (the reviews family is no longer idle)

- The reviews family itself: migration 0018 (`apps/worker/src/db/migrations/
  0018_long_jigsaw.sql:1` — `pull_reviews`), routes
  `apps/worker/src/api/routes/pull-reviews.ts` — both landed before ratification
  (the SPEC's own dependency line, and 0018 is in the applied-migrations record,
  `docs/design/p0-evidence.md:414`).
- The whitelist arm closed: `isOfficialReviewer` at
  `apps/worker/src/api/routes/pull-reviews.ts:375` (the doc comment at :369 names the
  `enable_approvals_whitelist` arms) — the exact gap the SPEC was written to fill,
  called from the submit/dismiss/undismiss paths (:700, :876, :938).
- Head-push staleness + dismissal: `markStaleReviewsOnPush` at
  `apps/worker/src/services/webhooks-push.ts:1129`, `dismiss_stale_approvals` arm
  :1232, wired into the push seam :1300; tests `apps/worker/src/services/
  push-stale.test.ts` (293 lines, part of the §1.6 run). The 2026-10-28 fix waves
  140fc0b/809d0be further hardened the stale-marking path (gate-free readDiff).
- UI consumers: the settings panel `apps/worker/src/ui/pages/branch-protection.tsx`
  (1,296 lines, 4cdf464 "pages wave 15 — protected-branches settings panel") with
  `apps/worker/src/ui/__tests__/pages-wave15.test.ts` (738 lines) + the
  `settings-branches.html` golden; and the PR files matrix pins the enforcement
  behavior — `apps/worker/src/ui/pages/pull-files.matrix.test.tsx:1194` (the
  outdated-blocker scenario) seeding a real `protected_branches` row with
  `blockOnOutdatedBranch: true` at :1499-1511 through the landed service functions.

### 1.7 Live verification (this assessment)

Scoped run, 2026-10-28, workerd bindings, five files — `branch-protection.test.ts`,
`branch-protections.test.ts`, `pull-merge-protection.test.ts`,
`branch-protection-push.test.ts`, `push-stale.test.ts`: **5 files, 102/102 passed**
(8.2 s). This is a scope run, not the full suite (ADR-0006 discipline); the full-suite
green claim for the M4 state is recorded, not re-verified here, in
`docs/design/p0-evidence.md:427` (2437 passed / 5 skipped at 5906a95).

## 2. Ledger drift verdict — DRIFT CONFIRMED, and the ledger was never the moving document for this SPEC

Reconstruction from `git log`:

1. `7aecd7d` (2026-10-25) "docs(spec): SPEC-0013 draft … (gated, research-only)"
   created BOTH the SPEC and the ledger row — this commit is the **last time the
   ledger row was touched**.
2. `a10374e` (2026-10-25 16:32 CST) "docs(spec): SPEC-0013 ratified — the reviews
   family's deferred merge-blocking is the live pull" flipped the SPEC's status
   header to "accepted — ratified 2026-10-25" **and touched only the SPEC file**
   (1 file changed, +5/−3). The ledger row was not flipped in the same change.
3. The implementation then landed the same day, M1→M4: `0c33d07` (M1, 17:18),
   `d7fdc49` (M2), `e2dabfd` + `1312fdb` + `6e6a703` (M3 + REG), `5906a95` (M4
   "SPEC COMPLETE", 18:56) — under three hours gate-to-complete. Each as-built
   section was appended to the SPEC file (289c101, 7a109ba, 078c338, and the M4
   section inside the 5906a95 feat commit). None of these touched the ledger.
4. Result: `specs/README.md:49` has said "draft — gated" for three days while the
   SPEC header, the git history, the deploy record, and the frozen-contract REG all
   say accepted-and-landed.

Why it happened (process finding, not mystery): the project's ledger is maintained
in bursty "panorama" commits (`f70f5e6`, `3783e86`, …) that refresh coverage
numbers, and the SPEC-first rule says "implementation updates its SPEC in the same
change" — which was honored for the SPEC file but has no enforcing step for the
INDEX row. A feature ratified and completed inside one working session produced
five SPEC-file doc commits and zero ledger commits. The drift is discoverable
exactly the way this assessment discovered it (SPEC says one thing, index another),
which is the failure mode the ledger exists to prevent. **The finding: the ledger
row update needs an owner at ratification time, not at the next panorama sweep.**

Two adjacent staleness points in the SPEC file itself, discovered on the same pass:

- The header (specs/0013-protected-branches.md:3-7) still says "Implementation
  begins at M1" — written at ratification, never refreshed after M4; the as-built
  sections below it say "SPEC COMPLETE" (:576). Internally inconsistent reading.
- §1.3 (:99) still lists "Tier-2 settings UI" as OUT of scope, yet the settings
  panel landed anyway (4cdf464, §1.6) and the parity survey records it as LANDED
  (`docs/compat/ui-parity-survey.md:861`). A real scope growth without a §1.3
  amendment — the same "update the SPEC in the same change" rule, second violation,
  milder (the panel is additive UI over the landed API, not a design change).

## 3. Gate evaluation (§1.1's two fire conditions)

**(a) Concrete branch-protection demand — NOT the condition that fired; no external
demand signal is recorded.** The ratification diff (a10374e) cites condition 2 only.
Searches across `docs/` and `specs/` found no user/project demand record for branch
protection: the only in-tree mentions are implementation, deploy evidence, and the
parity survey. The closest thing to a demand signal is post-hoc and operator-side:
the deployed instance exercised the API family in the merge-guard spot
(p0-evidence.md:1617-1626) — a probe run, not a user asking. Verdict: condition (a)
never fired and did not need to; §1.1 is an ANY-of gate.

**(b) The landed-but-idle reviews family pulling the merge gate — FIRED, explicitly
and with the exact rationale §1.2 anticipated.** The reviews family was landed
(pull_reviews, migration 0018; the dismissal API arms) with merge-blocking deferred
"for want of this surface" — the SPEC's own Fills-line cites the deferred gap twice
(pull-reviews.ts and the schema comment). At ratification that idle-but-armed
surface was judged the live pull; the judgment was correct by the strongest
available test: **the family is no longer idle.** Since M1, `official` /
`stale` / `dismissed` are consumed by the merge gate's approval count
(checkPullBranchProtections :724 fed from pulls.ts:1614), recomputed on rule change
(:765), flipped and dismissed on head pushes (webhooks-push.ts:1129-1300), and
rendered/edited through the UI panel. Nothing further is needed for this condition —
it fired and has been fully consumed.

## 4. Recommendation: RATIFY (retroactive — ratify the landed state and close the paper trail)

The gate legitimately fired on condition (b); the full owned scope (table, service,
merge gate, engine hook, 6-op API family, reviews interplay) landed in M1–M4, is
deployed to the remote instance with migrations applied, and 102/102 scoped tests
pass today. There is nothing to un-build. What remains is bookkeeping and the two
verification layers the SPEC's §7 plan promised but the tree doesn't carry:

| # | Gap | Size | Notes |
|---|---|---|---|
| 1 | Flip the ledger row `specs/README.md:49` to accepted/landed (mirroring the SPEC header), refresh the SPEC header's "Implementation begins at M1" to point at the as-built sections, and amend §1.3 to record the landed Tier-2 settings panel (4cdf464) as an accepted scope growth | **S** | One docs commit; owner = orchestrator (this assessment unit is read-only). Closes all three drift findings of §2. |
| 2 | Standing deploy-probe family for branch protections — `scripts/deploy-probes.mjs` only asserts `protected_branches == 0` (:166); the only live exercise is the one-off merge-guard spot (p0-evidence.md:1617-1626). Add create/list/edit/priority/delete + one merge-gate 405 arm to the probe script so every redeploy verifies the feature, not just the table's existence | **M** | Follows the existing probe patterns (push_mirrors at :1605-1615 is the model). |
| 3 | Real-git-client e2e for the protected push path — SPEC §7's "E2e (real git client)" row. Today: engine-contract e2e with constructed commits (`packages/git-engine/e2e/check-validate-push.mjs`, explicitly not real git) + worker-level vitest (`branch-protection-push.test.ts`). A `scripts/protected-push-e2e.sh` in the `mirror-e2e.sh`/`lfs-e2e.sh` pattern (real `git push` / `git push -f` against a protected ref, report-status assertions) would land the declared layer | **M** | CI gains one job, mirroring the existing lfs-e2e job precedent. |
| 4 | Fold one branch-protection reviewer into the next parity-review wave — the wave-130 scoreboard (`docs/reviews/wave-130-parity-review.md`, 141 lines) records NO branch-protection-specific review (grep for 0013/branch finds nothing), so the only parity passes on record are the SPEC's own as-built sections. A single sweep converting the recorded divergences (below) into verified keeps would close the loop | **S** | See §5 for the divergence list to hand the reviewer. |

No action (by design, §6): status checks, protected-file patterns,
`require_signed_commits`, codeowner reviews, auto-merge schedule, priority
drag-order UI conveniences — stored/echoed by the contract, deliberately unenforced
(`RULE_CONFIG_JSON_KEYS` :183-218 carries them; nothing reads them for enforcement).

## 5. Upstream anchor check (pin `fc4936884584` — verified: submodule HEAD matches the SPEC header's pin)

Surface present at the pin: `gitea/models/git/protected_branch.go`,
`gitea/models/git/protected_branch_list.go`, `gitea/services/pull/protected_branch.go`.
**Note: `gitea/routers/api/v1/repo/branch_protection.go` does NOT exist at this
pin** — the six handlers live in `gitea/routers/api/v1/repo/branch.go`
(`GetBranchProtection` :543, `ListBranchProtections` :587,
`CreateBranchProtection` :651, `EditBranchProtection` :854,
`DeleteBranchProtection` :1209; the priority op follows). The SPEC's §2.2 route
table cites branch.go line numbers, consistent with the pin — no
`routers/api/v1/repo/branch_protection.go` was ever expected at this pin.

Parity highlights bearing on ratification (anchor-level only; see gap 4 for the
missing dedicated review):

- Matches upstream: the rule model shape (one row per rule, `rule_name` glob,
  single config JSON under upstream's exact snake_case keys — service :104-139 +
  :183-218 vs `protected_branch.go:45-80`); first-match ordering and the
  plain-case-insensitive/glob split (findRule :477 vs `Match`/`EqualFold`); all six
  predicates (§1.2 vs `protected_branch.go:135-289`); the approval-counting
  semantics including the `ignore_stale_approvals` arm (`grantedApprovalsCount`
  :650 vs `models/issues/pull.go:770-785`); the merge 405 texts verbatim
  (pulls.ts:51-53 vs `ErrNotReadyToMerge` rendering); the push reject texts and the
  default-branch-delete absolute arm (branch-protection-push.test.ts names vs
  `hook_pre_receive.go:140-267`); the six-op API family with verbatim operationIds
  and the priority-0→MAX+1 create arm; M4's save-side sanitization ports
  (updateUserWhitelist/updateApprovalWhitelist/updateTeamWhitelist analogs).
- Recorded divergences (all documented in the SPEC as-built sections or code
  comments — hand this list to gap 4's reviewer):
  1. `effective_branch_protection_name` renders unconditionally where upstream
     gates on IsAdmin (branches.ts:106 comment; test-pinned per the M3 as-built).
  2. A vanished whitelist principal is DROPPED on save where upstream errors the
     whole save (M4 as-built, "Recorded normalization").
  3. The principal-deletion scrub sweeps all SIX user/team arrays where upstream
     sweeps five (upstream predates the bypass allowlist — M4 as-built).
  4. The engine `validatePush` hook sits post-scan/pre-finalize (the only place
     ancestry is classifiable) rather than upstream's pre-receive, and has NO
     PR-merge escape hatch — our merges never traverse receive-pack (SPEC §4.8;
     NOTICE.md:139).
  5. `syncCommitDivergence` not ported; lazy mergeability re-heals divergence
     (M1 as-built, documented, revisit-on-UI).
  6. §6 omissions enforced nowhere: status checks, protected-file patterns,
     signed commits, codeowner reviews, auto-merge deferral semantics.

## 6. Surprising findings (beyond the ledger itself)

1. Gate-to-complete in one afternoon: ratified 16:32, M1 17:18, M4 "SPEC COMPLETE"
   18:56 (2026-10-25) — the SPEC estimated ~5.5 waves; the actual burn was
   dramatically under that (calibration data point for future wave estimates).
2. The Tier-2 settings UI landed despite §1.3 declaring it out of scope (§2, second
   staleness point) — scope grew silently upward, which is the benign direction but
   still an unamended SPEC.
3. The tasking assumption that "the parity review's wave-130 already did a pass" on
   this surface is NOT borne out: the wave-130 scoreboard contains no
   branch-protection findings at all (gap 4).
4. v1.0 was tagged (a2ecd92, 14:22 CST) BEFORE the entire SPEC-0013 implementation —
   the feature is entirely post-v1.0; `docs/RELEASE-NOTES-v1.0.md` correctly has no
   row for it, and the primary landed-evidence record is the deploy block
   (p0-evidence.md:396-429).
5. The merge gate's position was corrected relative to the SPEC draft: §3.3's
   original plan placed the 405 family "after the write check and before the
   mergeable precondition", but the landed code (as-built M1) runs it AFTER the
   mergeable precondition (:1607, so the commits-behind count is available) with
   the auto-merge 409 before it — the as-built records this ordering, the §3.3
   body text was never amended. Third minor staleness point for the gap-1 commit.
