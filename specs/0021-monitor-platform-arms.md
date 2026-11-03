# SPEC-0021 — The Monitor Platform Arms (Cloudflare-native adapters)

Status: **RATIFIED (as-built)** — the design was frozen by the orchestrator's
user (2026-11-01, four production-hardening supplements) before
implementation; this document records the frozen design and the as-built.
The security model, taxonomy, and verification split were re-baselined to
the as-built on 2026-11-03 (the user-ruled one-time-authorization redesign:
一次授权、自动配置、集中管理、后续无人工干预 — one-time authorization,
automatic configuration, centralized management, unattended thereafter);
the adjudicated corrections of that redesign (the permission truth, the
Secrets-Store decline, the honest taxonomy, the wrangler-OAuth status) are
recorded where they belong below.

## 1. Problem and scope

Upstream Gitea's admin monitor carries four arms our port had recorded as
platform reductions: the queue `/set` (worker-pool concurrency), `perftrace`,
`pprof`, and `diagnosis`. Platform research (2026-11-01) established that
Cloudflare now exposes official equivalents — the Queues consumer
configuration API and the on-demand production Profiling API — so the
posture moves from "Go-native impossible" to **Cloudflare-native adapter**.
The **goroutine dump remains the sole final platform reduction** (no Go
runtime exists under workerd).

In scope: the admin monitor's `/set` + profiling + diagnosis arms as
adapters over the official Cloudflare APIs; the environment-status
dimension; the deploy-probe verification battery (rides the convergence).
Out of scope: goroutine dumps; the `/set` conflict-detection on concurrent
admin edits (a documented follow-up note).

## 2. The verified API surface (live docs, 2026-11-01)

- **Queue consumer read/write** —
  `GET/PUT /accounts/{account_id}/queues/{queue_id}/consumers/{consumer_id}`.
  **PUT, not PATCH** ("Replaces a Queue consumer, or creates it if it does
  not exist") — therefore **read-modify-write is mandatory**: GET the full
  config, change ONLY `max_concurrency`, PUT back preserving
  `batch_size`/`max_retries`/`dead_letter_queue`/`max_wait_time_ms`/
  `retry_delay`. Worker-variant body `{type:"worker", script_name, …,
  settings:{…}}`; `max_concurrency: null` = the platform-max auto arm.
  Token: Queues Write (+ Read).
- **Profiling** —
  `POST /accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}/profile`
  with `{"duration_ms", "profile_type": "cpu"|"heap"}` returning a
  **gzipped pprof file**. Requires a live instance with traffic; rate
  limits apply. Token: **Workers Scripts Read** (the corrected permission
  truth, 2026-11-03: the profiler endpoint does NOT need account-scoped
  read — the scripts-read scope alone answers it).
- **Traces** — `observability.traces.enabled` is already on in our
  wrangler config; perftrace's request-tracing dimension links to the
  platform surface (on-demand query is not exposed to Workers code — the
  section states the enabled posture honestly).

## 3. The closed loop (`/set`)

read → modify → **GET-verify the effective value** → surface BOTH the
runtime value and the wrangler-declared value (a deploy re-applies the
declared config — the drift is real and must be visible to the admin).

## 4. Security model (as-built, 2026-11-03 — the one-time-authorization redesign)

The architecture is 一次授权、自动配置、集中管理、后续无人工干预: the
operator authorizes ONCE; every later probe run configures and drives
itself; the credentials live in one local store; no further manual steps.

- **The credentials** — two SEPARATE minimal-privilege Cloudflare API
  tokens (the corrected permission truth): `CLOUDFLARE_QUEUES_TOKEN` =
  Queues Read + Write (the `/set` loop), `CLOUDFLARE_PROFILE_TOKEN` =
  **Workers Scripts Read ONLY** (the profiler; account-scoped read was the
  old answer and over-asked — declined). Account/queue/consumer/worker IDs
  stay env/allowlist variables — IDs NEVER come from requests (unchanged).
- **Intake is the operator-pasted token** — `scripts/setup-monitor-auth.mjs`
  collects the tokens with the terminal echo suppressed (or `--from-env`
  for scripted bootstrap), validates them with dry-run API calls (below),
  and persists the store. **The wrangler OAuth flow's ability to mint a
  scoped API token is UNVERIFIED** (correction 5): it was never exercised
  while authoring this redesign — no Cloudflare account credentials were
  available in the authoring environment — so the design does NOT rely on
  it and offers NO such path; the fallback ruled by the adjudication (the
  operator-pasted token) IS the implementation. If that flow is ever
  empirically verified, it may join as an ADDITIONAL intake, never a
  replacement.
- **Dry-run validation at intake, four-way** — every probe verdict names
  one class: `ok` / `permission-denied` (401/403, never relabeled) /
  `api-unsupported` (405/415/410/451/501, or a 403 whose envelope names
  entitlement/availability rather than scope) / `failure` (network,
  unexpected status, unresolving configured id). Per scope: Queues READ
  (GET the configured consumer, or the queues list when no allowlist
  exists yet); Queues WRITE — a **dry PUT against a NIL UUID queue id**:
  authorization is evaluated before resource existence, so 403 = scope
  missing while 404 = nothing to mutate = the scope passed (nothing can
  exist at the nil id, so the call cannot mutate anything); the pass is
  labeled PROVISIONAL and the battery's real PUT re-proves it. Profiler
  READ — GET `/accounts/{a}/workers/scripts` + an informational
  worker-name membership note.
- **The store** — repo-root `.monitor-auth.json`, written with mode 0600
  (verified after the write), GITIGNORED: runtime state, never committed,
  secrets never in source/config/specs. `deploy-probes.mjs
  monitor-platform` loads it when the `CLOUDFLARE_*` env names are absent;
  **env wins field-by-field** when both exist. `--check` re-validates
  non-interactively (no writes). Exit codes: 0 all scopes ok; 1 a verdict
  not ok; 2 usage; **3 missing-auth** (no store and no env credentials —
  the distinct pre-authorization class, decided BEFORE any network call).
- **Evaluated and DECLINED — Cloudflare Secrets Store**
  (`secrets_store_secrets` binding; correction 3): it exists, but it is
  overkill for a single-worker deployment holding two probe tokens — an
  extra binding plus an extra managed-secret lifecycle for state one 0600
  file already holds. Re-evaluate only if the tokens become
  multi-worker/multi-tenant.
- **Worker-side secrets stay as designed** — the deployed adapters still
  read the two tokens as Worker secrets (`wrangler secret put
  CLOUDFLARE_QUEUES_TOKEN` / `wrangler secret put
  CLOUDFLARE_PROFILE_TOKEN`); the 0600 store arms the PROBE side only.
  **Rotation**: re-run `node scripts/setup-monitor-auth.mjs --force` (the
  file is rewritten 0600 in place), re-run `--check` until both scopes
  answer ok, then delete the old token in the Cloudflare dashboard.

## 5. The taxonomy (as-built — the four-way classification, 2026-11-03)

The blanket warn-skip is REPLACED (correction 4: no "permanently closed"
promises — an honest taxonomy). Every arm reports its class distinctly;
the class word leads the check's detail; exit codes follow the battery's
standing convention (warn never fails, fail exits non-zero):

- **missing-auth** → `[warn]` (the honest unconfigured arm): no probe
  credentials at all — no env names, no usable store. Never claimed green;
  the detail names the one-time fix. This is the PRE-AUTHORIZATION state,
  not a release verdict, and it is never promised away: it returns the
  moment credentials are absent or broken again.
- **permission-denied** → `[fail]`: 401/403 (token invalid, expired, or
  mis-scoped) — NEVER relabeled "platform unsupported". An entitlement-
  naming 403 is api-unsupported instead (the plan gap is not a token
  fault).
- **api-unsupported** → `[warn]` (distinct, honest, never a pass): the
  endpoint/capability itself is absent for this account — 405/415/410/451/
  501, or the entitlement-marked 403 above.
- **failure** → `[fail]`: network unreachable, 429 after its bounded
  retries, 400 rejected request, 404 unresolving configured id, read-back
  mismatch, unexpected status.
- The environment-condition arm keeps its carve-out: a profile POST whose
  400-family body names no live instance is the `[warn]` environment-
  condition (never fake-green) — a documented detail class beside the four.
- 429 → bounded retry then report (unchanged); read-back mismatch → fail
  (unchanged); RESTORE failure → a BLOCKING red (unchanged).

## 6. The two status dimensions

- **Implementation status**: 集成待验证 → 已实现 (flips only when the
  deploy-probe battery passes against a live deployment).
- **Environment status**: 可用 / 未配置 / 权限不足 / 平台暂不可用 —
  surfaced in the Monitor UI so an admin can tell code-missing from
  deployment-config-missing.

## 7. Verification split (as-built)

Module tests pin the honest degraded arms + exact request literals via
mocked fetch. The REAL-API closed loops live in the deploy-probe battery:
the `/set` probe does GET-save → **PERSISTED-RESTORE** → modify → verify →
finally-restore → re-verify; restore failure is a BLOCKING red;
serial-locked (two probes never touch one consumer). PERSISTED-RESTORE
(the crash-safety net): the saved original config is written to disk
(0600, OUTSIDE the battery's scratch dir, NO secrets — ids + config + a
hand-restore recipe) BEFORE the mutation, and the restore runs on ANY exit
path — the restore steps cover success/assertion-failure/throw; a
SIGINT/SIGTERM guard performs the restore PUT mid-loop before exiting
130/143; a battery failure-tail retries an unverified restore; a hard kill
(SIGKILL) leaves the snapshot on disk for hand-restore. The mutation never
fires when the persist fails, and the snapshot is deleted only when the
restore is verified. The pprof probe validates CONTENT (non-empty → gunzip
→ pprof protobuf parses), size/duration/retry capped, secrets and binary
never logged. The probe battery rides the v1.5 convergence chain.
The battery's taxonomy/restore/auth logic is exercised end-to-end by
`scripts/setup-monitor-auth.test.mjs` against a LOCAL stub of the
Cloudflare API (the `MONITOR_CF_API_BASE` origin seam + the
`MONITOR_AUTH_FILE` store-path seam — point them only at stubs/paths you
own): every taxonomy class, the persisted-store fallback, the
0600-persistence, the exact two-PUT wire shape (modify + restore), the
SIGINT guard restore (exit 130), and the SIGKILL hand-restore snapshot.
