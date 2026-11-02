# cf-gitea v1.5.4 — Release Notes (the K wave: polish, completion, and the cleanest gate yet)

**Range**: RANGE=`8631d71..ed7867f` — **COMMIT_COUNT=14** commits, landed
across 2026-11-03's morning — the seventeen-unit K wave. Deployed
as **`DEPLOY_ID=fc0fdcd8`** (version `fc0fdcd8-6e7f-44f0-9ee6-b5d5ad9ea5ec`).
Probe battery **253 planned all green** — the first run answered 233/12/6:
ten failures were the transient-uplink window (fetch-timeouts across the
packages-protocols/minor batteries; every one green on targeted rerun), one
their cascade, and two audit-count drifts root-caused to ONE orphaned
fixture repo the failed window left behind (`admin/proto-9a1f6449` — the
battery's own cleanup 204'd it, the audit rows cascaded, the battery
re-ran green; the 0219256 playbook). The six warns are the documented
token-unconfigured classes. The full-suite composite gate passed on its
FIRST round: **476/476 files, ZERO assertion failures, ZERO timeouts** —
the cleanest result in the project's history (every prior release needed
the adjudication dance); the single unhandled rejection is the
`87621de` teardown known class on an all-passing file. **No migrations.**

The wave's shape: **the ledger's true open set drained to the gated rows.**
The morning's ledger refresh (K8) counted 111 rows = 101 landed + 8 open +
2 in-flight; this wave landed fourteen of those sixteen (the two couplings
landed jointly), and the K-wave residuals it surfaced were themselves
landed by follow-on units within the same wave. What remains open is two
gated rows (S-1 ActivityPub follower store — migration-gated; S-4 the
monitor live-loop — operator-secrets-gated), the scoped banner/sidebar
(DR-1(c), recorded), and B3's org route-shape split — all recorded with
cites in the ledger.

## 1. The headlines

- **The project workflow notifier is IMPLEMENTED** (K1+K6, `9a3eae1`): the
  five ports over upstream's reducer 1:1 (the holds-repo predicate, the
  once-per-event snapshot re-fetch, per-action log-and-continue, the
  `viaWorkflow` re-entrancy mark), emissions at the column add/remove/move,
  the projects diff (removals-first), the close/reopen transition (merge
  closes silent — the merge emits `pull_request_merged` instead), and the
  official review arms; 20-test battery + 3 e2e. The SPEC record became
  the as-built.
- **The project render is batched** (the coupled landing's other half):
  one creators read + one GROUP BY counts per page, zero-read rendering —
  the five query-shape witnesses that carried the unbatched ripple DROPPED
  back (24→18, 23→19; page-independence restored).
- **The scoped-workflow surface is whole** (K4/K11/K12/K14): the store
  trio and effective-source reads, the web toggle with the
  required-refusal, the dispatch's source resolution with the parity
  columns, the runs-list row filter (TEXT param — the pin's own decision),
  the rerun twin, `github.workflow_sha` carrying the SOURCE commit, and
  the API dispatch arm — while the API TOGGLE's absence is pinned as the
  pin's decision (upstream's API is repo-level only).
- **The actions audit family is complete** (K5/K7/K9): the
  `actions:workflow:{enable,disable,dispatch}` trio with web AND API arms,
  the credential derivation, and the impersonator threading (the
  id-only-derives-to-name helper; the vanished-row degrade documented).
- **LFS presign is armable** (K3): `LFS_STORE_PRESIGN` strict polarity +
  the S3 triple; the ServeDirect arm reachable for the first time; the
  runbook section landed (K13).
- **The UI strips are universal** (K2/K10/K13): all six deferred consumer
  pages armed; the packages-tab active posture adjudicated by the pin
  (upstream has NO TabName=packages — IsPackagesPage drives it) and the
  org arm threaded through OrgMenu's default-true prop.
- **R16(f): the release reactions family** (K15, `ed7867f`) — the last
  open ⑭ row: the web-only POST ladder (the 403-not-500 divergence is
  upstream's own), the service seam over the 0002 table, the
  reaction-bar render, 24 write-ladder tests.
- **The paperwork caught up** (K8/K16/K17): the ledger's whole-board
  refresh (111 = 101+8+2, five stale rows caught), oauth2-provider's SPEC
  flipped to as-built with eight sections repaired, and the SPEC-0002/0003
  staleness batch retired (including the honest rewrite of divergence 8 to
  the divergence that actually remains).

## 2. The discipline record

Zero quota deaths this wave — but the salvage discipline still earned its
keep: two coupled landings (K1+K6 over the shared issues.ts; K11+K12 over
the shared SPEC §6) with hunk-by-hunk attribution; one name collision
caught at collection (the mail module's same-named export — aliased); one
in-flight type flip (K4's scoped param) reconciled BY DESIGN at the fold;
and every orchestrator hunk set (thirteen folds this wave) applied
against verified anchors with disclosure in the landing commits.

## 3. Deploy and probe evidence

Deployed as **`fc0fdcd8`** from `dist/` built at `ed7867f` (the drizzle
single-chunk pin verified). The probe battery's twelve first-run failures
were all attributed within the hour: ten transient-uplink fetch-timeouts
(re-run green), their one cascade, and the orphan-fixture audit drift
(cleaned by the battery's own DELETE, cascaded, re-run green). The PAT
posture held (mint → battery → row deleted, table at 0, files shredded).
No migrations; the D1 schema is unchanged since `0061` (v1.5.1).
