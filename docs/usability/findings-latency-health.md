# Production latency + health smoke — findings (2026-10-30)

- Target: `https://cf-gitea.hecongw.workers.dev` (production, LAX colo observed via `cf-ray`)
- Window: 2026-10-30 ~00:52–01:25 UTC
- Method: `curl -w` timings (3 samples/page URL, 5 samples/API endpoint), anonymous and
  `p0probe` session classes (the deploy-probes `ui-login` cookie idiom), wrangler D1 remote
  reads for the cron/queue ground. GET-only — no state was mutated on the instance.
- Auth: per-run PAT minted for `p0probe` (`bootstrap-admin.mjs p0probe --remote`), 0600
  temp file, mint stdout shredded; PAT + this run's session rows deleted after the run.
- Related: `scripts/deploy-probes.README.md` (probe conventions), `docs/ops/runbook.md`.

**Vantage caveat (read before the tables).** The probe client's DNS+TCP+TLS setup to the
edge measured **~1.60–1.72 s** (`time_pretransfer` of the static asset: 1.616/1.695/1.723 s;
`/api/v1/version` raw p50 1.74 s is essentially that floor). Raw TTFB below therefore
carries ~1.6–1.7 s of client-side connection overhead. The platform-meaningful number is
the derived **server-side column** (raw TTFB minus that floor). The mission's ">1.5 s p50"
flag rule is applied to raw numbers as instructed — it fires table-wide from this vantage
and is NOT, by itself, a production regression claim.

## 1. Page timings (3 samples each; p95* = max of 3 at n=3)

| URL | Class | Codes | TTFB p50 | TTFB p95* | Total p50 | Total p95* | ≈ server-side p50 |
|---|---|---|---|---|---|---|---|
| `/` | anon | 200 | 2.408 s | 2.475 s | 2.408 s | 2.486 s | ~0.44 s |
| `/explore/repos` | anon | 200 | 2.466 s | 3.824 s | 2.487 s | 3.824 s | ~0.47 s (max ~1.79 s) |
| `/explore/users` | anon | 200 | 2.147 s | 2.224 s | 2.168 s | 2.247 s | ~0.42 s |
| `/login` (GET) | anon | 200 | 2.011 s | 2.080 s | 2.023 s | 2.088 s | ~0.37 s |
| `/user/sign_up` | anon | 200 | 1.920 s | 1.960 s | 1.920 s | 1.960 s | ~0.89 s |
| `/{owner}/{repo}` home (public) | anon | 200 | 1.873 s | 1.914 s | 1.911 s | 1.930 s | ~0.4 s |
| `…/src/branch/main` (public tree) | anon | 200 | 1.838 s | 2.202 s | 1.859 s | 2.234 s | ~0.4 s |
| `…/commits/branch/main` (public) | anon | 200 | 1.726 s | 2.356 s | 1.825 s | 2.375 s | ~0.4 s |
| `/notifications` | session | 200 | 2.146 s | 3.031 s | 2.146 s | 3.031 s | ~0.39 s |
| `/user/settings` | session | 200 | **3.171 s** | **3.969 s** | **3.871 s** | **3.995 s** | **~1.39 s (max ~1.94 s)** |
| `/{owner}/-/packages` | session | 200 | 2.578 s | 2.747 s | 2.617 s | 2.789 s | ~0.58 s |
| `/{owner}/{repo}` home (private) | session | 200 | 2.650 s | 3.459 s | 2.702 s | 3.512 s | ~0.61 s (max ~1.38 s) |
| `…/src/branch/main` (private tree) | session | 200 | 2.065 s | 2.124 s | 2.081 s | 2.161 s | ~0.4 s |
| `…/commits/branch/main` (private) | session | 200 | 2.084 s | 2.284 s | 2.124 s | 2.344 s | ~0.4 s |
| `/-/admin` | admin session | 200 | 2.399 s | 2.413 s | 2.427 s | 2.443 s | ~0.42 s |
| `/-/admin/repos` | admin session | 200 | 1.782 s | 2.032 s | 1.811 s | 2.051 s | ~0.36 s |
| `/-/admin/monitor/cron` | admin session | 200 | 1.696 s | 1.870 s | 1.717 s | 1.889 s | ~0.32 s |
| `/assets/js/index.*.js` (594 KB) | anon asset | 200 | 1.991 s | 2.067 s | 3.012 s | 3.285 s | ~0.33 s (total adds ~1 s last-mile download) |
| mid-suite 404 (repo deleted under us) | anon | 404 | 2.001 s | 2.223 s | 2.013 s | 2.234 s | ~0.39 s |

Notes on provenance: two public probe fixtures visible at recon vanished mid-run
(sibling-window cleanup / demo-instance volatility — §6 F5), so the public-repo rows were
re-taken against a live fixture and the private rows against the standing `p0probe/p0-shallow`.
The `/login` and `/user/sign_up` rows of the first pass carried the session cookie and
correctly 303'd; the table rows are the clean anonymous re-samples (200).

**Flag rule outcome (raw p50 > 1.5 s): all 17 page URLs flag** — but with ~1.6–1.7 s of
that being probe-vantage connection setup, the honest platform-side reading is:

- Every page's server-side p50 sits at **0.3–0.9 s** except `/user/settings` (~1.4 s) and
  the private repo home on one sample (~1.38 s max 1.94 s was settings).
- **F1 (HIGH, latency): `/user/settings` is the slow page** — raw p50 3.17 s / total 3.87 s,
  server-side ~1.4 s p50 with a 1.94 s ceiling, 3–4x every other page's server time. It is
  the one row whose server-side cost alone would breach a 1.5 s budget on a far-vantage
  client. Worth a profile by the settings-page owner (it aggregates profile/password/keys/
  applications data on one render).

## 2. API timing spot-check (5 endpoints × 5 samples)

| Endpoint | Codes | TTFB p50 | TTFB max | ≈ server-side (raw − ~1.7 s floor) |
|---|---|---|---|---|
| `/api/v1/version` | 200×5 | 1.740 s | 1.796 s | ~0.05–0.09 s (edge floor) |
| `/api/v1/user/repos?limit=10` | 200×5 | 2.416 s | 3.147 s | ~0.75 s |
| `/api/v1/repos/p0probe/p0-shallow/issues?state=all&type=issues` | 200×5 | 2.506 s | 3.072 s | ~0.85 s |
| `/api/v1/repos/search?q=link&limit=10` | 200×5 | 2.476 s | 2.590 s | ~0.80 s |
| `/api/v1/repos/p0probe/linkcrawl` | 200×5 | 2.476 s | 2.588 s | ~0.80 s |

All 200s, no errors, tight p50s. DB-touching API reads carry ~0.7–0.85 s server-side —
consistent with the page numbers; nothing pathological. `version` proves the isolate/wire
floor is healthy.

## 3. Cold-start vs warm

75 s with no requests from this client, then the same URL (`/`):

| Sample | TTFB | Total |
|---|---|---|
| cold-ish (first hit after idle) | 2.765 s | 2.765 s |
| warm 1 | 2.352 s | 2.359 s |
| warm 2 | 2.084 s | 2.084 s |
| warm 3 | 2.459 s | 2.473 s |

**No isolate-cache penalty is observable** — the cold hit sits inside the warm band. Honest
caveat: this is a shared demo instance and sibling probe windows were actively creating
repos/orgs during the run (audit_event rows at 01:04), so the "cold" hit is cold only for
this client; the isolate was likely kept alive by background traffic. Conclusion stands
directionally: server-side cost (~0.4 s) is per-request work, not cold-start overhead.

## 4. Header correctness + 404/500 shapes

Correct:

- **Assets**: `cache-control: public, max-age=31536000, immutable` + ETag on hashed
  `/assets/js|css|fonts/*` — exactly the committed `apps/worker/public/_headers` posture.
- **Pages**: `cache-control: max-age=0, private, must-revalidate` on every HTML page, the
  303s, and both 404 classes — no HTML caching anywhere.
- **Session cookie**: `HttpOnly; Secure; SameSite=Lax` on the login 303's `gitea_session`.
- **HTML 404 shape**: `404` + `text/html; charset=UTF-8`, full shell
  (`<title>Page Not Found - cf-gitea</title>`), no-cache — the carve's not-found shell,
  not a bare text line.
- **API 404s**: known-route miss answers `application/json`
  `{"message":"not found","url":"…/api/swagger"}` (upstream APIError shape; message casing
  differs from upstream's mixed-case texts — cosmetic). Unmatched `/api/v1/*` routes answer
  `text/plain` `404 Not Found` — chi-shaped (upstream's default chi body is
  `404 page not found`; same class, minor text diff).
- **500 posture** (from code, not force-able on production): `app.onError`
  (`apps/worker/src/index.ts:88-106`) answers browsers with a 500 shell
  (`renderServerErrorShellResponse`, the upstream `renderPanicErrorPage` twin) and non-HTML
  clients with the plain `Internal Server Error` line; error + stack go to logs only.

**F2 (MEDIUM, security headers): the response-header hardening class is absent on every
class checked** (page, asset, HTML 404, API error): no `X-Content-Type-Options: nosniff`,
no `Content-Security-Policy`, no `X-Frame-Options`/`frame-ancestors`, no HSTS. Upstream
parity refs: `gitea/services/context/base.go:134` sets `nosniff` on error/plain renders and
`base.go:206-210` (`SetHeaderContentSecurityPolicyGeneral`) sets a CSP header on pages.
The HTML carries `<meta name="referrer" content="same-origin">`, so referrer policy exists
— the header class does not. Suggest a shared header-setting middleware pass for a future
wave (not fixed here — smoke only).

**F3 (MEDIUM, monitoring gap): "did the scheduled arms run today?" is unanswerable from the
product surface.** The `/-/admin/monitor/cron` page lists only `Update Mirrors`
(`*/10 * * * *`) with `Executions 0` and `Previous Time —`; the hourly producers (demo
sweep, audit-retention, packages-cleanup, actions-retention — `src/services/demo-sweep.ts`
`handleScheduledCron`) are not listed and no execution state is recorded. Individual cron
ticks leave no D1 trace by design; the operator evidence is the `[demo-sweep]` /
`[repo-tasks]` Workers log lines, which are not API-reachable. This smoke therefore
certifies the D1 ground state below, not tick-by-tick cron execution.

## 5. Cron/queue health — D1 ground (wrangler d1, remote, 01:05–01:15 UTC)

Verdict: **HEALTHY — every proxy clean; nothing stranded, nothing overstayed.**

Honest note first: `repo_tasks_dlq` / `webhook_delivery_dlq` are **Cloudflare Queues DLQs**
(`wrangler.jsonc` consumers), not D1 tables — no D1 tables of those names exist. The
D1-visible DLQ ledger is `system_notices` (SPEC-0018 §4.1: the DLQ consumers write one row
per dead letter). Queue backlog depth itself is a platform metric, not wrangler-d1-visible.

| Check | Result | Reading |
|---|---|---|
| `system_notices` (DLQ ledger) | **0 rows** | repo-tasks-dlq and webhook-delivery-dlq have never dead-lettered through to the ledger |
| `action_runs` / `action_tasks` | **0 / 0** | no Actions activity; actions-retention has nothing stranded and nothing to prune — the fail-closed (unarmed) posture intact |
| `repo_mirrors` / `push_mirrors` | **0 / 0** | the */10 producer's due-set is empty; no stuck `sync_state` rows possible |
| Demo sweep eligibility (the exact producer predicate: `created_at < now−72h AND owner NULL/dangling OR owner.is_admin=false`) | 1 repo past cutoff, **admin-owned → exempt**; **0 eligible, 0 overstayed** | the armed sweep is consistent: nothing older than retention except an exempt standing fixture (`p0probe/p0-shallow`, admin-owned) |
| `audit_event` | 173 rows, oldest 2026-10-29T02:02Z, newest **01:04:17Z today** | the audit seam is live and writing; `AUDIT_RETENTION_DAYS=90` → nothing prunable yet (retention untested by age — expected this early) |
| `repositories` | all rows `status='ready'`, none `'creating'` | no stuck creates |

Scheduled-arms config: `crons ["*/10 * * * *", "0 * * * *"]` are deployed (the admin monitor
page renders the mirror cadence from live config). Per F3, tick-level proof lives only in
Workers logs.

## 6. Uptime certificate

20 consecutive pings of `/` at 5 s intervals, ~01:19–01:21 UTC:
**20/20 HTTP 200, 0 failures.** Raw TTFB range 1.606–2.964 s (vantage-inclusive), no
5xx, no resets, no timeouts.

## Findings summary

| # | Severity | Finding |
|---|---|---|
| F1 | HIGH (latency) | `/user/settings` server-side ~1.4 s p50 (raw p50 3.17 s, max 3.97 s) — 3–4x every other page; the only URL whose server-side cost alone threatens a 1.5 s budget for far clients |
| F2 | MEDIUM (headers) | No `nosniff` / `CSP` / `X-Frame-Options` / HSTS on any response class (upstream sets nosniff on error renders, base.go:134, and CSP on pages, base.go:206-210) |
| F3 | MEDIUM (observability) | Cron monitor lists only `Update Mirrors` with `Executions 0 / Previous —`; hourly producers unlisted; no UI/D1 trace of scheduled ticks (logs only) — cron execution is uncertifiable from the product |
| F4 | LOW (latency, vantage-caveated) | Raw TTFB p50 > 1.5 s on all 17 URLs as measured; ~1.6–1.7 s is probe-client connection setup. Platform-side p50 0.3–0.9 s is acceptable; do not read the raw flags as a production regression |
| F5 | LOW (ops note) | Demo-instance volatility: two public probe fixtures vanished mid-suite (sibling cleanup / demo sweeps). Timing suites against this instance should pin their own fixture and verify codes per-sample |
| F6 | LOW (parity, cosmetic) | Unmatched API 404 body text `404 Not Found` vs upstream chi's `404 page not found`; API known-route 404 message lowercase `not found`. Shape/status/content-type all correct |
| F7 | OPEN (observation) | `/{owner}/{repo}/actions` answers the 404 shell for some repos (verified 404 on `p0probe/p0-shallow` + `p0probe/linkcrawl` at 01:2x, was 200 on `p0probe/probe08565824916` at 00:58 before that repo was deleted) — likely repo-state-dependent (actions unit/workflow data); for the actions feature owner to adjudicate, not a latency matter |

## Honest notes / method disclosure

- Read-only smoke: the only writes were the per-run PAT row (deleted after), one session
  row (deleted after), and this doc. No repos, issues, or settings were created or modified.
- n=3 per page URL and n=5 per API endpoint: "p95" is the max at these n; treat p95* as a
  worst-sample indicator, not a distribution tail.
- The first pass applied the session cookie to every URL (harness bug); the affected anon
  rows (`/login`, `/user/sign_up` 303s) were re-taken clean and the table uses those. The
  session'd rows are unaffected in kind (cookie intended there).
- The mid-suite fixture deletion changed which repos the public-repo rows measured; rows
  were re-taken against a live public fixture within the same window.
- Server-side ≈ `time_starttransfer − time_pretransfer` (main suite recorded pretransfer;
  derived columns elsewhere use the ~1.6–1.7 s floor from repeated minimums).
- A follow-up probe of `/-/admin/notices` (admin UI) was not separately timed; its ledger
  ground (0 rows) is certified via D1 above.
- PAT hygiene: mint stdout shredded immediately; token file (0600) and cookie file shredded
  after the run; the per-run PAT (`cfg_dea255b1…`) deleted from `personal_access_tokens`
  (verified: the standing bootstrap set of exactly 2 — admin + p0probe — remains). Two of
  this run's login-attempt session rows were deleted by id; one earlier login attempt lands
  inside an ambiguous 00:55–00:57 cluster that cannot be attributed with certainty against
  sibling windows' logins, so it was left to age out at its 24 h expiry rather than risk
  killing another window's live session.
- Concurrent-activity disclosure: sibling probe windows were live during the run (four
  per-run PATs present at recon were gone by cleanup — their owners' deletes, not this
  run's; `uxprobe1397` repo/org creates logged at 01:04). Counts and repo lists quoted
  here are point-in-time reads.
