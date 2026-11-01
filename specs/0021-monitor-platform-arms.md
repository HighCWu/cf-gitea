# SPEC-0021 — The Monitor Platform Arms (Cloudflare-native adapters)

Status: **RATIFIED (as-built)** — the design was frozen by the orchestrator's
user (2026-11-01, four production-hardening supplements) before
implementation; this document records the frozen design and the as-built.

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
  limits apply. Token: a profiling scope.
- **Traces** — `observability.traces.enabled` is already on in our
  wrangler config; perftrace's request-tracing dimension links to the
  platform surface (on-demand query is not exposed to Workers code — the
  section states the enabled posture honestly).

## 3. The closed loop (`/set`)

read → modify → **GET-verify the effective value** → surface BOTH the
runtime value and the wrangler-declared value (a deploy re-applies the
declared config — the drift is real and must be visible to the admin).

## 4. Security model

- Two SEPARATE minimal-privilege tokens as Worker secrets:
  `CLOUDFLARE_QUEUES_TOKEN`, `CLOUDFLARE_PROFILE_TOKEN` (+ account/queue/
  consumer/worker IDs as env allowlist vars — IDs NEVER come from requests).
- Admin-gated routes; value range validation (1–250 or null); an audit row
  per change (operator, before, after, API result, timestamp).

## 5. The taxonomy (binding)

Token-unconfigured-and-disabled → skip/warn. 401/403 → **fail** (never
"platform unsupported"). 400 → fail. Read-back mismatch → fail. 429 →
bounded retry then report. No-active-profile-instance → environment-
condition, never fake-green.

## 6. The two status dimensions

- **Implementation status**: 集成待验证 → 已实现 (flips only when the
  deploy-probe battery passes against a live deployment).
- **Environment status**: 可用 / 未配置 / 权限不足 / 平台暂不可用 —
  surfaced in the Monitor UI so an admin can tell code-missing from
  deployment-config-missing.

## 7. Verification split

Module tests pin the honest degraded arms + exact request literals via
mocked fetch. The REAL-API closed loops live in the deploy-probe battery:
the `/set` probe does GET-save → modify → verify → **finally-restore →
re-verify**; restore failure is a BLOCKING red; serial-locked (two probes
never touch one consumer). The pprof probe validates CONTENT (non-empty →
gunzip → pprof protobuf parses), size/duration/retry capped, secrets and
binary never logged. The probe battery rides the v1.5 convergence chain
(the unit's death to the 1308 quota wave left it unwritten — the adapter
and its tests landed first under this SPEC's own two-stage rule).
