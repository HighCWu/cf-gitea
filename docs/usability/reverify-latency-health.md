# Production re-verification — latency + health smoke (2026-10-30)

Re-run of `docs/usability/findings-latency-health.md` against the FIXED deployment.

- Target: `https://cf-gitea.hecongw.workers.dev` (production; `cf-ray` tail `-LAX`, same colo as the original run)
- Deployment: version `bd9dda74-6390-4984-aaf7-ca9f7b135aff` at 100% (`wrangler deployments list`, created 2026-10-30T02:57:34Z). `/api/v1/version` = `29.0.0+dev-208-gfc49368845` (unchanged submodule pin).
- Window: 2026-10-30 ~03:36–03:53 UTC
- Method: identical to the original — `curl -w` timings (3 samples/page URL, 6 for `/user/settings`, 5/API endpoint), anonymous / `p0probe` session classes (the `ui-login` cookie idiom), wrangler D1 remote reads for the ground state. The derived **server-side column** is per-sample `time_starttransfer − time_pretransfer` (the original main table's derivation).
- Auth: per-run PAT minted for `p0probe` (`bootstrap-admin.mjs p0probe --remote`), 0600 temp file, mint stdout shredded; PAT + this run's session row deleted after the run (full ledger in §7).
- Purpose: verify the three fixes that landed after the original smoke — F1 (`/user/settings` latency), F2 (security headers), F3 (cron observability) — plus the standing health checks.

**Vantage caveat (same as the original).** The probe client's edge connection setup measured ~1.35–2.0 s `time_pretransfer` this run (repeated minimums ~1.35–1.46 s; the original quoted ~1.6–1.7 s). Raw TTFB below carries that floor; the platform-meaningful number is again the server-side column. The ">1.5 s p50" flag rule applied to raw numbers still fires table-wide from this vantage and is not a production regression claim.

**Concurrency disclosure (read before the tables).** At least two sibling probe windows were LIVE during this run: three non-standing p0probe PATs not belonging to this run were present and actively authenticating (tokens ending in use 03:44–03:46 UTC), and `audit_event` logged `repository:create` at 03:41:57Z and `organization:create` at 03:45:38Z — mid-timing-suite. The numbers below therefore carry background load the original only had in part; nothing observed is attributable to them, but tails are noisier.

## 1. Page timings — F1 re-verification

**Verdict: F1 FIXED.** `/user/settings` server-side p50 is now **~0.48 s** (n=6), inside the expected 0.4–0.7 s band, versus the original **~1.39 s p50 / 1.94 s max**. The page now sits inside the pack instead of 3–4x above it.

Before/after for the flagged row (all other columns unchanged in kind):

| `/user/settings` (session) | TTFB p50 | TTFB max | Total p50 | server-side p50 | server-side max |
|---|---|---|---|---|---|
| original (n=3, 00:52–01:25 UTC) | 3.171 s | 3.969 s | 3.871 s | ~1.39 s | ~1.94 s |
| **re-verify (n=6, 03:36–03:53 UTC)** | **2.360 s** | **3.523 s** | **2.382 s** | **0.478 s** | 1.544 s |

One of six settings samples still spiked (1.54 s server-side) — see the tail note below the table.

Full table (3 samples each unless noted; all codes verified 200 per sample):

| URL | Class | Codes | TTFB p50 | TTFB max | Total p50 | ≈ server-side p50 | ss max |
|---|---|---|---|---|---|---|---|
| `/` | anon | 200×3 | 1.645 s | 1.764 s | 1.656 s | 0.27 s | 0.37 s |
| `/explore/repos` | anon | 200×3 | 2.294 s | 2.576 s | 2.322 s | 0.38 s | 0.57 s |
| `/explore/users` | anon | 200×3 | 2.087 s | 2.444 s | 2.123 s | 0.39 s | 0.40 s |
| `/login` (GET) | anon | 200×3 | 2.359 s | 2.395 s | 2.372 s | 0.38 s | 0.53 s |
| `/user/sign_up` | anon | 200×3 | 2.247 s | 2.885 s | 2.256 s | 0.37 s | 0.39 s |
| `/{owner}/{repo}` home (public) | anon | 200×3 | 2.493 s | 2.580 s | 2.768 s | 0.65 s | 0.80 s |
| `…/src/branch/main` (public tree) | anon | 200×3 | 1.785 s | 1.892 s | 1.814 s | 0.41 s | 0.50 s |
| `…/commits/branch/main` (public) | anon | 200×3 | 1.735 s | 2.079 s | 1.764 s | 0.36 s | 0.41 s |
| `/notifications` | session | 200×3 | 1.943 s | 2.488 s | 1.943 s | 0.47 s | 0.49 s |
| `/user/settings` | session | 200×6 | 2.360 s | 3.523 s | 2.382 s | **0.48 s** | 1.54 s |
| `/{owner}/-/packages` | session | 200×3 | 2.637 s | 2.796 s | 2.826 s | 0.64 s | 0.75 s |
| `/{owner}/{repo}` home (private) | session | 200×3 | 2.797 s | 3.852 s | 3.029 s | 0.76 s | 1.91 s |
| `…/src/branch/main` (private tree) | session | 200×3 | 2.642 s | 2.660 s | 2.850 s | 0.82 s | 0.88 s |
| `…/commits/branch/main` (private) | session | 200×3 | 2.803 s | 3.112 s | 3.290 s | 0.72 s | 1.26 s |
| `/-/admin` | admin session | 200×3 | 2.189 s | 2.905 s | 2.336 s | 0.43 s | 0.51 s |
| `/-/admin/repos` | admin session | 200×3 | 2.592 s | 2.722 s | 2.639 s | 0.50 s | 0.82 s |
| `/-/admin/monitor/cron` | admin session | 200×3 | 2.168 s | 2.481 s | 2.202 s | 0.41 s | 0.51 s |
| `/assets/js/index.*.js` (~594 KB) | anon asset | 200×3 | 2.585 s | 2.857 s | 3.555 s | 0.49 s | 0.68 s |

Reading:

- Server-side p50 now spans **0.27–0.82 s** across all 17 page URLs — no page stands apart. `/user/settings` (0.48 s) is unremarkable between `/notifications` (0.47 s) and `/-/packages` (0.64 s).
- **Residual tail pattern (unchanged in kind, no longer settings-specific):** single-sample server-side spikes appeared on session-class pages this run — settings 1.54 s (1 of 6), private repo home 1.91 s (1 of 3), private commits 1.26 s (1 of 3) — while all other samples sat at 0.26–0.88 s. The original saw the same shape (settings 1.94 s, private home 1.38 s tails). With sibling windows writing repos/orgs mid-run, these tails are consistent with D1 write contention from concurrent sessions; they do not affect any p50. Not re-flagged as F1 — F1 was a p50 claim and the p50 is fixed.
- Raw TTFB p50 still flags >1.5 s on every URL (F4 posture unchanged: vantage floor + honest server-side column above).
- Provenance: the public rows were taken against this run's own fixture `p0probe/reverify-fixture` (created for the suite, deleted after — see §7); the private rows against the standing `p0probe/p0-shallow`. No public repo existed on the instance at run start (`/api/v1/repos/search` anonymous = `[]`), the F5 volatility recurring exactly as documented.

## 2. API spot-check (3 endpoints × 5 samples, all 200)

| Endpoint | TTFB p50 | TTFB max | ≈ server-side p50 | ss max |
|---|---|---|---|---|
| `/api/v1/version` | 1.773 s | 2.294 s | 0.30 s | 0.37 s |
| `/api/v1/user/repos?limit=10` | 1.913 s | 2.221 s | 0.41 s | 0.47 s |
| `/api/v1/repos/p0probe/p0-shallow/issues?state=all&type=issues` | 2.484 s | 2.954 s | 0.53 s | 0.86 s |

No errors, tight p50s; DB-touching reads sit at the same ~0.4–0.5 s server-side band as the pages. Nothing pathological; `version` proves the isolate/wire floor is healthy.

## 3. Header correctness — F2 re-verification

**Verdict: F2 FIXED.** `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN` are present on **every response class checked** (the original smoke found their total absence), and `Content-Security-Policy` rides the HTML classes. Observed matrix:

| Response class | Code | Content-Type | nosniff | X-Frame-Options | CSP | cache-control |
|---|---|---|---|---|---|---|
| HTML page (anon `/`) | 200 | text/html | yes | SAMEORIGIN | **yes** | max-age=0, private, must-revalidate |
| HTML page (session `/user/settings`) | 200 | text/html | yes | SAMEORIGIN | **yes** | max-age=0, private, must-revalidate |
| HTML 404 shell (ghost repo / unmatched web route) | 404 | text/html | yes | SAMEORIGIN | **yes** | max-age=0, private, must-revalidate |
| Repo-subpage 404 (`/{repo}/nonexistent`) | 404 | text/plain | yes | SAMEORIGIN | — (non-HTML) | — |
| Asset (`/assets/js/index.*.js`) | 200 | text/javascript | yes | SAMEORIGIN | — (non-HTML) | public, max-age=31536000, immutable |
| API 200 (`/api/v1/version`) | 200 | application/json | yes | SAMEORIGIN | — (non-HTML) | — |
| API 404 JSON (known-route miss) | 404 | application/json | yes | SAMEORIGIN | — (non-HTML) | — |
| Unmatched `/api/v1/*` 404 | 404 | text/plain | yes | SAMEORIGIN | — (non-HTML) | max-age=0, private, must-revalidate |
| 303 login redirect (anon `/notifications`) | 303 | — | yes | SAMEORIGIN | — | — |

- The CSP value is `default-src * data: blob:;script-src * 'unsafe-inline';style-src * 'unsafe-inline';` — upstream's general-policy shape at the pin with the one **documented** adaptation (nonce → `'unsafe-inline'`; `apps/worker/src/web/security-headers.ts`, which cites `context_template.go:116-141` / `base.go:205-210` and the SPEC-0008 §4.14 nonce-less inline artifacts as the reason). Capability-equivalent to upstream per that module's goldens-conformance argument.
- **HSTS remains absent** — unchanged, and correct per upstream parity: upstream sets no `Strict-Transport-Security` at the pin (the module header documents the string does not occur in the Go tree); TLS posture belongs to the edge. Same posture as the original smoke.
- The original's F2 suggestion ("shared header-setting middleware") landed exactly so: the headers ride every class including the non-Hono exits (the git gate, the 404 shell, `app.onError`).
- Note (new observation, not a regression claim): the 404 for a missing page inside an EXISTING repo answers bare `text/plain;charset=UTF-8` `not found` (no HTML shell, no cache-control), while a ghost-repo or unmatched-route 404 answers the full HTML shell (`text/html; charset=UTF-8`, `<title>Page Not Found - cf-gitea</title>`). Both carry nosniff + XFO. The original only certified the HTML-shell variants; whether the repo-subpage seam predates this deploy was not established — recorded for the UI owner's awareness only.

## 4. Cron observability — F3 re-verification

**Verdict: F3 FIXED.** `/-/admin/monitor/cron` (session'd) now lists **all seven arms** — the original page showed only `Update Mirrors` with `Executions 0 / Previous —`. Rendered rows (verbatim, 03:50 UTC):

| Arm | Schedule | Next | Previous | Executions | Result |
|---|---|---|---|---|---|
| Update Mirrors | `*/10 * * * *` | Oct 30, 2026 03:50:00 | Oct 30, 2026 03:40:17 | 5 | (clean) |
| Update Push Mirrors | `*/10 * * * *` | Oct 30, 2026 03:50:00 | Oct 30, 2026 03:40:17 | 5 | (clean) |
| Stop actions zombie tasks | `*/10 * * * *` | Oct 30, 2026 03:50:00 | Oct 30, 2026 03:40:17 | 5 | (clean) |
| Demo Sweep | `0 * * * *` | Oct 30, 2026 04:00:00 | Oct 30, 2026 03:00:21 | 1 | (clean) |
| Delete audit events older than the retention period | `0 * * * *` | Oct 30, 2026 04:00:00 | Oct 30, 2026 03:00:21 | 1 | (clean) |
| Clean up expired packages | `0 * * * *` | Oct 30, 2026 04:00:00 | Oct 30, 2026 03:00:21 | 1 | (clean) |
| Clean up expired actions' resources | `0 * * * *` | Oct 30, 2026 04:00:00 | Oct 30, 2026 03:00:21 | 1 | (clean) |

- No row shows the "—" never-fired posture: every arm has fired since the 02:57:34Z deploy — exactly 5 ticks for the */10 trio (03:00→03:40) and 1 for the hourly quartet (03:00) — so the page is answering from real recorded state, not the empty default. ("—" on a 0-run row remains the correct shape for arms that haven't fired since a deploy; it simply didn't apply here.)
- Cross-checked against the D1 ground (`cron_state`, migration 0044): all 7 arms present, `runs` 5/5/5/1/1/1/1 matching the page, `last_success_unix` 03:40:17Z (*/10 trio) and 03:00:21Z (hourly quartet), **`last_error` empty on every row**. Page and store agree.
- Committed config truth unchanged: `wrangler.jsonc.example` carries the two entries `crons: ["*/10 * * * *", "0 * * * *"]` covering all seven arms.
- "Did the crons run today?" is now answerable from the product surface — the F3 gap is closed. Residual (unchanged from the module's own disclosure): per-tick Workers-log detail stays out of the product; the page certifies last-success/runs/error per arm, which is what the finding asked for.

## 5. Cron/queue health — D1 ground (wrangler d1, remote, 03:46–03:50 UTC)

**Verdict: HEALTHY — every proxy clean, nothing stranded, nothing overstayed** (same table as the original, re-run):

| Check | Result | Reading |
|---|---|---|
| `system_notices` (DLQ ledger) | **0 rows** | repo-tasks-dlq / webhook-delivery-dlq have never dead-lettered through to the ledger — including through this run's concurrent sibling create/delete churn |
| `action_runs` / `action_tasks` | **0 / 0** | no Actions activity; actions-retention has nothing stranded and nothing to prune; the fail-closed (unarmed) posture intact |
| `repo_mirrors` / `push_mirrors` | **0 / 0** | the */10 producer's due-set is empty; no stuck `sync_state` rows possible |
| Demo sweep eligibility (`created_at < now−72h`) | 1 repo past cutoff — `p0probe/p0-shallow`, **admin-owned → exempt** | **0 eligible, 0 overstayed**; the armed sweep consistent, same reading as the original run |
| `audit_event` | 207 rows (was 173), oldest 2026-10-29T02:02:41Z, newest **2026-10-30T03:45:38Z** | the audit seam is live and writing today (newest event ~50 s before the query); `AUDIT_RETENTION_DAYS=90` → nothing prunable yet (retention still untested by age, expected this early) |
| `repositories` | all rows `status='ready'`, none `'creating'` (6 at read time) | no stuck creates |

## 6. Uptime certificate

20 consecutive pings of `/` at 5 s intervals, ending 03:52:44 UTC: **20/20 HTTP 200, 0 failures.** Raw TTFB range 1.742–4.849 s (vantage-inclusive; the 4.85 s max is one tail sample against live sibling traffic), no 5xx, no resets, no timeouts. Matches the original's 20/20.

## 7. PAT / state hygiene ledger

- Per-run PAT minted for `p0probe` (`bootstrap-admin.mjs p0probe --remote`), written to a 0600 temp file, mint stdout shredded immediately. Identity preflight: `GET /api/v1/user` → `p0probe` (admin).
- **Mint-tooling incident, disclosed:** the operator's token-capture regex used the wrong base32 alphabet (the mint format's 32-char tail draws from `A-HJ-NP-Z2-9` — `I`/`O` excluded, `L` included), so three early mints printed a token the capture failed to store. The unusable plaintext rows were deleted by exact id+prefix after attribution: row 113 (`cfg_705aa44b`, proven this run's by elimination — the adjacent row 112 was authenticated with 69 s of its mint, which only its own minter could have done) and rows 116/117 (`cfg_8f913ad4`, `cfg_8a766c6e`, timestamped inside this run's failed attempts). The working run PAT was row 118 (`cfg_2da32138`).
- This run created exactly one repo: the public timing fixture `p0probe/reverify-fixture` (auto_init) — needed because zero public repos existed at run start (F5 recurrence) and the public rows of the timing table would otherwise have been unmeasurable. Deleted via the API at cleanup: **204**, tombstone verified (page 404, `repositories` back to the sibling-driven count). The original run's GET-only discipline is thereby deviated from in this one disclosed, self-cleaned way.
- The run's session row (login ~03:37 UTC) was deleted by exact id (`sessions.id` derived from the run's own cookie, digest-checked before delete; `changes: 1`).
- Token/cookie/mint files shredded (`shred -u`); the timing TSV retained only as doc input.
- Post-cleanup ground: exactly the standing bootstrap set remains attributable to this run's users — admin `cfg_23077afd` + p0probe `cfg_a93bbf96` — plus one row owned by a still-live sibling window (`cfg_fe89447f`, authenticated minutes earlier; not this run's to delete, left for its owner per the original run's attribution discipline).

## Findings summary (delta against the original)

| # | Original | Re-verify verdict |
|---|---|---|
| F1 | HIGH — `/user/settings` server-side ~1.39 s p50, 3–4x every page | **FIXED** — 0.478 s p50 (n=6), inside the pack (0.27–0.82 s); one 1.54 s tail sample noted, same session-class tail pattern as the private repo pages |
| F2 | MEDIUM — no nosniff/CSP/X-Frame-Options on any class | **FIXED** — nosniff + `X-Frame-Options: SAMEORIGIN` on every class checked (8 classes), CSP on both HTML 200s and the HTML 404 shell, value matching the documented upstream-shape adaptation (`src/web/security-headers.ts`); HSTS correctly absent (upstream parity) |
| F3 | MEDIUM — cron monitor listed 1 arm, `Executions 0 / Previous —` | **FIXED** — all 7 arms with verbatim schedules, computed Next, real Previous timestamps, live run counts (5×3 + 1×4), clean Result column; cross-checked against `cron_state` (zero errors) |
| F4 | LOW — raw TTFB p50 > 1.5 s table-wide | UNCHANGED posture — still pure probe-vantage floor (~1.35–2.0 s pretransfer this run); server-side 0.27–0.82 s |
| F5 | LOW — fixture volatility | RECURRED — zero public repos at run start; this run pinned its own fixture and verified codes per-sample, then removed it |
| F6 | LOW — API 404 text cosmetics | Not re-adjudicated (out of this run's scope); no relevant surface change observed in passing |
| F7 | OPEN — `/{repo}/actions` 404 for some repos | Spot-checked: still 404 on `p0probe/p0-shallow` (session) — same repo-state-dependent shape as the original; remains with the actions owner |

**No new HIGH/MEDIUM findings. No blockers.**

## Honest notes / method disclosure

- n=3 per page URL (n=6 for `/user/settings`, n=5 per API endpoint): "p95" reported as max, a worst-sample indicator, not a distribution tail — same caveat as the original.
- Server-side ≈ `time_starttransfer − time_pretransfer` per sample, median reported — the original main table's derivation (its API table subtracted a flat floor; this run uses the per-sample form everywhere, so the API rows are not byte-comparable to the original §2 — the bands agree).
- All 17 page URLs + asset ran (54 samples, all 200, no re-takes needed); the original's informal mid-suite-404 row was not re-timed.
- Sibling windows were live throughout (three foreign p0probe PATs authenticating; repo/org creates logged at 03:41:57Z and 03:45:38Z). Per-sample code checks caught no interference; tails are plausibly inflated by it.
- The cron monitor page was fetched once for the row census (plus its 3 timing samples); the `cron_state` cross-read is a separate D1 read, not a second page fetch.
- Read-only smoke except the three disclosed writes: the PAT rows (own, deleted), the session row (deleted), and the public fixture repo (created + deleted 204, tombstone verified). No issues, settings, or other users' state touched.
