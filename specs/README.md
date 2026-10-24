# SPEC index

SPEC-first is mandatory (AGENTS.md): every non-trivial feature starts with a SPEC here,
and implementation updates its SPEC in the same change. Status legend: **draft** (written,
not yet ratified for implementation), **accepted** (orchestrator-reviewed, implementable),
**in flight** (being written or implemented).

Status snapshot below: **2026-10-25 03:08 CST**. Three `pnpm check:api` readings —
03:02:41, 03:06:31, 03:08:00 CST — all `PASS` at **77/78 paths, 127/129 ops** (one
short of the 78/78 tier-1 terminal state, so no completion banner yet). REG-MERGE-2
(9877544), the tier-1 tail (6e3c322) and REG-MERGE-3 (a969312) landed since the last
snapshot; the forks route registration (last 2 ops) and the mirror Worker half are
still mid-flight (uncommitted working-tree edits at snapshot time).

| SPEC | Title | Status | Depends on | Owns |
|---|---|---|---|---|
| [0001](0001-storage-engine.md) | Git storage engine (R2 + DO, vendored durable-git) | accepted (amended) · **M1 landed & independently e2e-verified 2026-10-24** | ADR-0001 | engine receive/serve paths, R2/DO layout, quotas, fuzz/bench |
| [0001a](0001a-split-plane-amendment.md) | Split-plane amendment: receive-in-Worker, lease RPCs, key switch, schema, commit builder | accepted · **ALL STEPS landed** (Steps 1-2 with P0 gates G1-G5, deepen-family fail-closed parser per rounds 7-9; Steps 3-4 in 59a0776: storage_key addressing, pack_catalog, lifecycle RPCs, branch-create hotfix; §4 commit builder + serializers in 3b30ba3) | 0001 | M2 design-of-record; exact RPC signatures |
| [0001b](0001b-merge-fork-primitives.md) | Engine merge/fork/diff primitives | accepted · **fully landed incl. fork** — merge base/graph/diff3/tree-merge/rebase/patch-id + mergeability/executeMerge RPCs (3b30ba3), fork catalog-replication RPCs (0223dcb), Worker queue-replication consumer + POST /repos/{owner}/{repo}/forks async service (8fb87a2); PR `mergeable` no longer renders null; the forks ROUTE registration is the last tier-1 op still pending | 0001a, 0005 §3.4, 0004 OQ#4 | merge surface, fork model (full copy + PR relay), copyObjects-free |
| [0002](0002-auth.md) | Authentication (users, PATs, scopes, middleware) | accepted | 0001 (refs), ADR-0001 D3 | D1 users/tokens, auth semantics |
| [0003](0003-repo-lifecycle-git-http.md) | Repo lifecycle & git smart-HTTP adapter, push-create, import channel | accepted · **M1-M5 all landed** (ACL gate, lifecycle, redirects, push-create, delete queue; M5 chunked import channel 09132c1 — server channel + migration 0006 + the chunked/batched clients) | 0001, 0002 | route table, ACL matrix, lifecycle, >1 GiB import |
| [0004](0004-api-v1-core.md) | /api/v1 core: taxonomy, tier-1 (78 paths / 129 ops), contract discipline | accepted · **77/78 paths, 127/129 ops mounted at HEAD** (three check:api readings 2026-10-25 03:02:41 / 03:06:31 / 03:08:00 CST, all PASS — one reading short of the 78/78 terminal state). Landed since the last snapshot: REG-MERGE-2 (9877544 — batch-8 + stragglers + release assets; 73/78, 123/129), the tier-1 tail 6e3c322 (archive/diffpatch/languages/cancel-automerge, the final 4 ops) and REG-MERGE-3 a969312 (tail families registered; GetBlob red root-caused & fixed; 77/78, 127/129); duplicate commit-pull trio dropped (ceb1106). The only remaining op — GET/POST /repos/{owner}/{repo}/forks route registration — is mid-flight (forks service committed 8fb87a2; router wiring uncommitted at snapshot) | 0002, 0003 | API conventions, CI contract stages |
| [0005](0005-issues-prs-webhooks.md) | Issues, PRs, releases, webhooks | accepted · **landed incl. the delivery Queue consumer** (issue/PR/release D1 layer, issues+PR blocks, releases + release assets, webhook delivery consumer) | 0004, 0001a §4 | D1 issue/PR/release/webhook schema, Queues delivery |
| [0006](0006-lfs.md) | Git LFS (batch API, R2 presign/relay, GC) | accepted · **routes + services + git-lfs client e2e landed** (route family + gate interception, LfsStore relay/presign batch, `pnpm test:lfs` 33 checks through the relay, 0e48e77; CI lfs-e2e job b50d2c8) | 0003, 0004 media route | lfs/ prefix, lfs_objects, sweeps |
| [0007](0007-orgs-teams.md) | Organizations & teams (tier-1 org endpoints) | accepted (org-as-user-row; teams deferred to tier-2 with stub) · **landed incl. tier-2 org identity** (org services + migration 0005 org tables + tier-1 org routes; removeMember silent no-op fix 7fb731d; tier-2 list/create/user-orgs/permissions/rename/delete 9c4b64e) | 0002, 0003 §2.5.6, 0004 tier-1 org paths | org storage decision, org grants |
| [0008](0008-ui-tier2.md) | Tier-2 UI: asset reuse, Hono JSX pages, first slice | accepted · **U1-U3+U5 landed** (assets + icon gen U1, shell U2, router module U2.5 mounted 893d3c9, the three repo pages U3 9b35c71, golden DOM snapshots + a11y smoke + determinism U5 9865b1d); U4 auth is deliberately out of this slice — SPEC-0010's gated scope | ADR-0001 D2, ui-tier2-plan, 0004 tier-1 | assets pipeline, DOM contract, page auth |
| [0009](0009-mirrors-import.md) | Mirrors & import (outbound smart-HTTP client, AES-GCM creds) | accepted (draft→reviewed) · **client half landed** — `scripts/mirror-import.mjs` import-from-URL producer (ab56ec9) drives SPEC-0003 §2.6 with a real outbound `git clone --mirror`; the Worker-side mirror half (`src/services/mirror/`: gitclient + sync + tests) is written but UNCOMMITTED at the 03:08 CST snapshot — mid-flight alongside migration 0009 (`repositories.fork_parent`) | 0003 §2.6, 0001a pipeline, 0006 follow-up | mirror sync, import-from-URL, egress policy |
| [0010](0010-ui-session.md) | UI session (PAT login, id:secret cookie, rotation) | draft — GATED (implement on private browsing / first UI write) | 0008 §2.5, 0002 §2.8 | sessions, viewer extension, CSRF stance |

Supporting records: [ADR-0001](../docs/decisions/0001-technical-direction.md) (technical
direction), [ADR-0002](../docs/decisions/0002-contract-freeze.md) (compatibility contract
freeze + re-pin procedure), [tech-route survey](../docs/research/tech-route-survey.md),
[frozen contract](../apps/worker/src/compat/contract/) (guarded by `pnpm check:contract`).

Ordering: engine (0001/0001a) → auth (0002) → git HTTP + lifecycle (0003) → API tier-1
(0004) → issues/PRs/webhooks (0005) → merge/fork (0001b) → LFS (0006). Tier-2/3 API paths,
UI (asset reuse), Actions compat, OAuth2 provider: future SPECs per ADR-0001.
