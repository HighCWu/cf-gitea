# SPEC index

SPEC-first is mandatory (AGENTS.md): every non-trivial feature starts with a SPEC here,
and implementation updates its SPEC in the same change. Status legend: **draft** (written,
not yet ratified for implementation), **accepted** (orchestrator-reviewed, implementable),
**in flight** (being written or implemented).

| SPEC | Title | Status | Depends on | Owns |
|---|---|---|---|---|
| [0001](0001-storage-engine.md) | Git storage engine (R2 + DO, vendored durable-git) | accepted (amended) · **M1 landed & independently e2e-verified 2026-10-24** | ADR-0001 | engine receive/serve paths, R2/DO layout, quotas, fuzz/bench |
| [0001a](0001a-split-plane-amendment.md) | Split-plane amendment: receive-in-Worker, lease RPCs, key switch, schema, commit builder | accepted · Steps 1-2 landed (P0 gates G1-G5 satisfied); Steps 3-4 in flight | 0001 | M2 design-of-record; exact RPC signatures |
| [0001b](0001b-merge-fork-primitives.md) | Engine merge/fork/diff primitives | accepted · corrections 5-8 folded into 0004/0005; 1-4 queued post-M2-S1 | 0001a, 0005 §3.4, 0004 OQ#4 | merge surface, fork model (full copy + PR relay), copyObjects-free |
| [0002](0002-auth.md) | Authentication (users, PATs, scopes, middleware) | accepted | 0001 (refs), ADR-0001 D3 | D1 users/tokens, auth semantics |
| [0003](0003-repo-lifecycle-git-http.md) | Repo lifecycle & git smart-HTTP adapter, push-create, import channel | accepted | 0001, 0002 | route table, ACL matrix, lifecycle, >1 GiB import |
| [0004](0004-api-v1-core.md) | /api/v1 core: taxonomy, tier-1 (78 paths / 129 ops), contract discipline | accepted (draft→tier-1 routes landing) | 0002, 0003 | API conventions, CI contract stages |
| [0005](0005-issues-prs-webhooks.md) | Issues, PRs, releases, webhooks | accepted | 0004, 0001a §4 | D1 issue/PR/release/webhook schema, Queues delivery |
| [0006](0006-lfs.md) | Git LFS (batch API, R2 presign/relay, GC) | accepted | 0003, 0004 media route | lfs/ prefix, lfs_objects, sweeps |
| [0007](0007-orgs-teams.md) | Organizations & teams (tier-1 org endpoints) | accepted (org-as-user-row; teams deferred to tier-2 with stub) | 0002, 0003 §2.5.6, 0004 tier-1 org paths | org storage decision, org grants |
| [0008](0008-ui-tier2.md) | Tier-2 UI: asset reuse, Hono JSX pages, first slice | accepted · U1 TS-half + assets landed; U2 shell in flight | ADR-0001 D2, ui-tier2-plan, 0004 tier-1 | assets pipeline, DOM contract, page auth |
| [0009](0009-mirrors-import.md) | Mirrors & import (outbound smart-HTTP client, AES-GCM creds) | accepted (draft→reviewed) | 0003 §2.6, 0001a pipeline, 0006 follow-up | mirror sync, import-from-URL, egress policy |

Supporting records: [ADR-0001](../docs/decisions/0001-technical-direction.md) (technical
direction), [ADR-0002](../docs/decisions/0002-contract-freeze.md) (compatibility contract
freeze + re-pin procedure), [tech-route survey](../docs/research/tech-route-survey.md),
[frozen contract](../apps/worker/src/compat/contract/) (guarded by `pnpm check:contract`).

Ordering: engine (0001/0001a) → auth (0002) → git HTTP + lifecycle (0003) → API tier-1
(0004) → issues/PRs/webhooks (0005) → merge/fork (0001b) → LFS (0006). Tier-2/3 API paths,
UI (asset reuse), Actions compat, OAuth2 provider: future SPECs per ADR-0001.
