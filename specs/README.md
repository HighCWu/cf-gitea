# SPEC index

SPEC-first is mandatory (AGENTS.md): every non-trivial feature starts with a SPEC here,
and implementation updates its SPEC in the same change. Status legend: **draft** (written,
not yet ratified for implementation), **accepted** (orchestrator-reviewed, implementable),
**in flight** (being written or implemented).

**TIER-1 COMPLETE — 78/78 paths, 129/129 operations** (commit dcb422f,
2026-10-25 03:35 CST; the forks registration landed as REG-MERGE-4).

**TIER-2 — 490/554 frozen-contract operations declared across 298 paths**
(measured this run, 2026-10-28, via `pnpm check:api` — `PASS`; tier-1 remains
terminal at 78/78 paths / 129/129 ops, dcb422f). The port-first matrix is
saturated: the matrix-coverage census's yield curve called it — "ONE more
batch, then SATURATED" — and batch 14 (`cee057b`) executed the census's gap
list, leaving the port-first UI endgame's dispatchable board empty
(`docs/testing/matrix-coverage-census.md`; the survey's tick-15 re-walked the
headline unchanged). What is in flight at any given moment is the ledger rows'
business below — they are the per-SPEC authority; this paragraph carries only
the contract-count snapshot, so it stays count-fresh rather than wave-by-wave.

Prior status snapshot (kept for the record): **2026-10-25 03:08 CST**. Three `pnpm check:api` readings —
03:02:41, 03:06:31, 03:08:00 CST — all `PASS` at **77/78 paths, 127/129 ops** (one
short of the 78/78 tier-1 terminal state, so no completion banner yet). REG-MERGE-2
(9877544), the tier-1 tail (6e3c322) and REG-MERGE-3 (a969312) landed since the last
snapshot; the forks route registration (last 2 ops) and the mirror Worker half are
still mid-flight (uncommitted working-tree edits at snapshot time).

| SPEC | Title | Status | Depends on | Owns |
|---|---|---|---|---|
| [0001](0001-storage-engine.md) | Git storage engine (R2 + DO, vendored durable-git) | accepted (amended) · **M1 landed & independently e2e-verified 2026-10-24** | ADR-0001 | engine receive/serve paths, R2/DO layout, quotas, fuzz/bench |
| [0001a](0001a-split-plane-amendment.md) | Split-plane amendment: receive-in-Worker, lease RPCs, key switch, schema, commit builder | accepted · **ALL STEPS landed** (Steps 1-2 with P0 gates G1-G5, deepen-family fail-closed parser per rounds 7-9; Steps 3-4 in 59a0776: storage_key addressing, pack_catalog, lifecycle RPCs, branch-create hotfix; §4 commit builder + serializers in 3b30ba3) | 0001 | M2 design-of-record; exact RPC signatures |
| [0001b](0001b-merge-fork-primitives.md) | Engine merge/fork/diff primitives | accepted · **fully landed incl. fork** — merge base/graph/diff3/tree-merge/rebase/patch-id + mergeability/executeMerge RPCs (3b30ba3), fork catalog-replication RPCs (0223dcb), Worker queue-replication consumer + POST /repos/{owner}/{repo}/forks async service (8fb87a2); PR `mergeable` no longer renders null; the forks ROUTE registration landed as REG-MERGE-4 — tier-1 terminal | 0001a, 0005 §3.4, 0004 OQ#4 | merge surface, fork model (full copy + PR relay), copyObjects-free |
| [0002](0002-auth.md) | Authentication (users, PATs, scopes, middleware) | accepted | 0001 (refs), ADR-0001 D3 | D1 users/tokens, auth semantics |
| [0003](0003-repo-lifecycle-git-http.md) | Repo lifecycle & git smart-HTTP adapter, push-create, import channel | accepted · **M1-M5 all landed** (ACL gate, lifecycle, redirects, push-create, delete queue; M5 chunked import channel 09132c1 — server channel + migration 0006 + the chunked/batched clients); §2.1 amended — the ACL gate widens to repo-scoped engine JSON/admin paths for D1-resolved repos (70c9c3d, spec amendment 9c2e963) | 0001, 0002 | route table, ACL matrix, lifecycle, >1 GiB import |
| [0004](0004-api-v1-core.md) | /api/v1 core: taxonomy, tier-1 (78 paths / 129 ops), contract discipline | accepted · **tier-1 terminal: 78/78 paths, 129/129 ops mounted** (dcb422f; the last two ops — the forks route registration — landed as REG-MERGE-4, after the tier-1 tail 6e3c322 and REG-MERGE-3 a969312; duplicate commit-pull trio dropped ceb1106). Tier-2 family registrations are tracked in the progress line above | 0002, 0003 | API conventions, CI contract stages |
| [0005](0005-issues-prs-webhooks.md) | Issues, PRs, releases, webhooks | accepted · **landed incl. the delivery Queue consumer** (issue/PR/release D1 layer, issues+PR blocks, releases + release assets, webhook delivery consumer); user pushes emit the push/create/delete family through the engine onPush seam (fff6094), rendered through the shared emitPushFamilyUpdates builder deduped with the mirror path (55f1e99); issue events unified behind one emitIssueEvent seam — API and UI paths identical (32f1ffd) — with emissions grown through 7242825 (comment edit/delete, label, status, release, milestone, assign) and re-audited at HEAD: **20/26 upstream wire types fully emitted, 1 not-emitted-with-feature-present (the wiki family — wiring is the top remaining item)** ([coverage audit](../docs/compat/webhook-event-coverage.md), refresh 4556669) | 0004, 0001a §4 | D1 issue/PR/release/webhook schema, Queues delivery |
| [0006](0006-lfs.md) | Git LFS (batch API, R2 presign/relay, GC) | accepted · **routes + services + git-lfs client e2e landed** (route family + gate interception, LfsStore relay/presign batch, `pnpm test:lfs` 33 checks through the relay, 0e48e77; CI lfs-e2e job b50d2c8) | 0003, 0004 media route | lfs/ prefix, lfs_objects, sweeps |
| [0007](0007-orgs-teams.md) | Organizations & teams (tier-1 org endpoints) | accepted (org-as-user-row) · **landed incl. tier-2 org identity and teams** (org services + migration 0005 org tables + tier-1 org routes; removeMember silent no-op fix 7fb731d; tier-2 list/create/user-orgs/permissions/rename/delete 9c4b64e; teams — the deferred core — 20 ops + migration 0015 c8c47af, REG 96e8625; team grants enforced at the seams per §3.4 — visibility/permissions, git-HTTP, org-repo create, delete cascade 9e23010; ownership guards narrowed to isOrgOwner, tier-2 create grant kept 94cd19e) | 0002, 0003 §2.5.6, 0004 tier-1 org paths | org storage decision, org grants |
| [0008](0008-ui-tier2.md) | Tier-2 UI: asset reuse, Hono JSX pages, first slice | accepted · **U1-U3+U5 landed** (assets + icon gen U1, shell U2, router module U2.5 mounted 893d3c9, the three repo pages U3 9b35c71, golden DOM snapshots + a11y smoke + determinism U5 9865b1d); U4 auth is deliberately out of this slice — SPEC-0010's gated scope | ADR-0001 D2, ui-tier2-plan, 0004 tier-1 | assets pipeline, DOM contract, page auth |
| [0009](0009-mirrors-import.md) | Mirrors & import (outbound smart-HTTP client, AES-GCM creds) | accepted (draft→reviewed) · **landed end-to-end, e2e-suite verified** — import-from-URL producer (ab56ec9) drives SPEC-0003 §2.6 with a real outbound `git clone --mirror`; the Worker-side mirror half (`src/services/mirror/`: gitclient + sync + tests) landed with real-wire parsing fixes (2278fc6 — v2 advert behind the `# service=` preamble, packfile section framing) and population settle (bc9954f — first refs flip `is_empty`, engine HEAD default_branch); §2.7 sync notifications ride the push/create/delete family (61aceb5) through the file-list enricher (66af276); black-box e2e suite — loopback git-http source, 11 scenarios (`pnpm test:mirror`, a38f92e); server-driven migrate — the §2.2 arm `POST /repos/migrate` landed 0fe6b04 (creates the target, drives the right channel), closing the compat repository-row migrate arm by parity analysis (f5406c3) | 0003 §2.6, 0001a pipeline, 0006 follow-up | mirror sync, import-from-URL, egress policy |
| [0010](0010-ui-session.md) | UI session (PAT login, id:secret cookie, rotation) | accepted · **ratified 2026-10-25** (ae89563 — §1.1 entry criteria met: UI waves in flight, schema ownership free); implementation in flight (session module + login page, uncommitted at this writing) | 0008 §2.5, 0002 §2.8 | sessions, viewer extension, CSRF stance |
| [0011](0011-compaction-gc.md) | Pack compaction & GC (read leases, four-state pack lifecycle) | accepted — ratified 2026-10-25 (M2 stability gate met) · **implementation milestones M3.0–M3.4 COMPLETE** with as-built records (§8: journal/baseline 968f4c8, ReadGate segmented serve dc49de5 + e359e44, compaction 934d5a9 + 0303f5d, GC b4bab63 — and the §7.1 closing counter-example **failed to construct: the gate passed** 53fc835; content-path reads lease-covered at the engine RPC boundary 2fce4cd, closing M3.2's known gap); M3.0–M3.5 COMPLETE (M3.5 acceptance-hardening tail 157e74e, 2026-10-25: §7.2 rows 1-5 via check-fault-matrix.mjs 4 checks + the row-4 append to check-compaction, §7.3 correctness tier as check-correctness-tier.mjs 7 checks, capability matrix TEST-GENERATED check-capability-matrix.mjs 18 checks; 15 scripts / 260 checks green at the gate, re-verified 16/269 by docs/research/engine-e2e-health-2026-10-26.md; differential pre-existing — scripts/diff-test.mjs + CI diff-battery, ours-only. Residual: §9's review-facing state-transition table regenerated from code LANDED at docs/design/m3-state-transitions.md — every transition actor/precondition/crash-window cited with its pinning check; its divergence ledger (D1-D6) found one genuine unrecorded gap, the failed-publish lease-pointer destroy (D3), now queued for fix; §7.2 rows 10-11 hold structurally/partially, unpinned by dedicated checks) | 0001/0001a leases, m3-design-inputs, 0003 serve paths | pack states, read leases, publish ordering, fault-injection gate |
| [0012](0012-actions-feasibility.md) | Gitea Actions protocol-compat (act_runner server surface) | draft — gated (surface inventory at the pin verified; ratification gated on §1.1 demand criteria: a concrete CI demand + a runner operator + an M0 wire capture) | 0002, 0004, 0005 (onPush seam), 0006 (R2 relay precedent) | `/api/actions` runner protocol, artifacts v1+v4, OIDC issuer, job summaries, trigger chain, Actions D1 schema |
| [0013](0013-protected-branches.md) | Protected branches & approval-gated merges | accepted — ratified 2026-10-25 (a10374e, §1.1 condition 2: the reviews family pulling the merge gate) · **full M1–M4 landed same day** (0c33d07 → 5906a95: the `protected_branches` table + rule service, merge approval gate, push-time per-ref rejection via the engine hook, the `/branch_protections` 6-op family + Branch render extras) · migrations 0018–0019 applied, deployed | 0003 (git-HTTP gate), 0004, 0005 (PR model), 0007 (team predicates), 0001b (merge-base), reviews family (migration 0018) | `protected_branches` D1 table, rule match/predicate service, merge RPC approval gate, push-time per-ref rejection (engine hook), `/branch_protections` family (6 ops) |

Supporting records: [ADR-0001](../docs/decisions/0001-technical-direction.md) (technical
direction), [ADR-0002](../docs/decisions/0002-contract-freeze.md) (compatibility contract
freeze + re-pin procedure), [ADR-0005](../docs/decisions/0005-verification-strategy.md)
(verification strategy: layer stack + hard-won rules), [webhook event coverage
audit](../docs/compat/webhook-event-coverage.md) (upstream pin vs. emitted set — 18/26
wire types fully emitted, refreshed through 7242825), [release notes
v1.0](../docs/RELEASE-NOTES-v1.0.md) (df973a4; **v1.0 tagged at a2ecd92**, 2026-10-25),
[tech-route survey](../docs/research/tech-route-survey.md),
[frozen contract](../apps/worker/src/compat/contract/) (guarded by `pnpm check:contract`).

Ordering: engine (0001/0001a) → auth (0002) → git HTTP + lifecycle (0003) → API tier-1
(0004) → issues/PRs/webhooks (0005) → merge/fork (0001b) → LFS (0006). Tier-2/3 API paths,
UI (asset reuse), Actions compat, OAuth2 provider: future SPECs per ADR-0001.
