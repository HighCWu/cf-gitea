# cf-gitea v1.5.2 — Release Notes (the review-sweep and hard-blocker wave)

**Range**: RANGE=`c9e4d7c..7da229b` — **COMMIT_COUNT=17**
commits (the notes commits excluded from the narrative count), landed across
2026-11-02 — a single-day wave. Deployed
as **`DEPLOY_ID=ac8815c4`** (version `ac8815c4-f615-4c1e-a2c1-138ecc6244ec`).
Probe battery
**PROB_COUNTS=245 pass / 0 fail / 6 warn (253 planned)** — **first-try green,
zero adjudication needed**: the same battery that answered 245/0/6 at v1.5.1
answered 245/0/6 again on the new build (the six warns are the documented
token-unconfigured classes — queue-settings ×4 and pprof ×2, unmounted account
credentials). The full-suite composite gate was accepted
**green-with-adjudication on the R2-R4 record** after the same pattern as
v1.5.1: 466 files, 462-463 passing in every round, and every red file
across all three rounds solo-exonerated or a documented known class (§8).
**No migrations this wave** — the schema is unchanged since `0061`; the
deploy is a pure code ship.

The wave's shape: **a six-unit non-overlapping review sweep against the
upstream pin drove everything** — six review units (㉑-㉖) returned ~65
findings with file:line cites, relayed verbatim into the fix pool; sixteen fix
waves (W1-W16) landed them one owner at a time; and the wave's second movement
closed the **four hard blockers** that stood between cf-gitea and full
team-usability: LFS write authorization (`3ab5c4c`), the Actions rerun/approve
buttons (`0ad4356`), scheduled workflow triggers and required status checks
(`6ae87ab`). The wave's third movement was the gate's own first-run red: four
expectation-drift pins, a wiki seed-push race, and one REAL engine defect —
the ObjCache walk-blindness that W5's created-ref ancestry walk introduced,
found by the invariant checker and fixed with a surgical `skipCacheWrite`
threading (`76b5c8c`), the wave's only engine-behavior change, disclosed and
approved mid-flight.

## 1. The wave's story — the review sweep, the ledger, and the four blockers

The wave opened with the second quota-death recovery of the week: the pool was
reconstituted at the standing concurrency of 6 and dispatched as **six
non-overlapping review units**, each re-deriving its surface against the
submodule pin (`gitea/` @ fc493688) and returning findings with upstream
file:line cites. The orchestrator relayed every finding verbatim into
`/tmp/v152-findings.md` (226 lines, ~65 findings) and built
**`docs/compat/v1.5.2-ledger.md`** — the 86+15-row dispatch-ready backlog board
that now governs the remaining parity work (waves A-J). The sixteen landing
waves each took exclusive file ownership, re-derived every arm from the pin
BEFORE editing, and were solo re-verified by the orchestrator before commit —
the standing discipline.

The wave's discriminating events:

- **A premise correction is a finding too.** W3's "1 MiB blob cap" finding
  inverted on inspection: upstream itself caps at **10 MiB**
  (`setting.API.DefaultMaxBlobSize`, api.go:21) — our threshold was the
  unsanctioned one. Same wave, W2's "duplicate re-enqueue" finding dissolved
  the same way (both schedule arms already enqueue inline). The rule holds:
  upstream behavior IS the default decision, in both directions.
- **The upstream-parity rule decided the schedule architecture for free.**
  W14's "external runner decision" was not a decision: upstream's own
  architecture puts execution outside the server, so the control-plane port
  (registry = the default-branch tree, stateless producer/consumer over
  REPO_TASKS) is pure parity work — recorded in SPEC-0013, never escalated.
- **The engine change was forced by evidence, not preference.** W16's
  instrumentation PROVED the ObjCache poisoning three ways before the fix was
  drafted; the fix is opt-in at exactly two scan call sites, and the normal
  serve paths keep full cache writes.

## 2. The four hard blockers (the "fully usable" gates)

The wave opened with the question "how far is cf-gitea from fully usable?" —
the answer named four gaps, and this wave closed all four:

1. **LFS write authorization** (`3ab5c4c`, W12) — `authorizeLfs` and
   `authorizeLfsLocks` now resolve the exact repository-service grant the
   git-HTTP gate consumes: the `doerRepoAccessMode` fold (org-owner bridge +
   SPEC-0007 teams + SPEC-0005 collaborator rows), with `readGrant` imported
   from the ONE shared predicate (`git-http/acl.ts:286-307` — the §2.6
   one-copy discipline now spans git-HTTP, pages, and LFS). Write
   collaborators and org-team write members get the full upload ladder;
   read-mode collaborators download but cannot upload; outsiders get the 401
   challenge on both arms. Upstream pin: server.go:544-557.
2. **Actions rerun/approve** (`0ad4356`, W13) — the four POST routes
   (`actions-run-rerun`, `rerun-failed`, `job-rerun`, `approve`) mounted at
   exact literal claims; one `actionsRunRerun` handler serves the trio
   through the landed `rerunActionRun` service; the NEW
   `services/actions/approve.ts` ports upstream's approve.go v1 stage
   (need_approval flip, BLOCKED→WAITING release via CAS, the wake). Every UI
   button on the run view now lands. Divergence recorded:
   `RequireUnitWriter` 404-shells both anonymous and non-writer
   (permission.go:54-60) — upstream-faithful, no login 303.
3. **Scheduled workflow triggers** (`6ae87ab`, W14) — the full stateless
   chain: `enqueueDueActionSchedules` (one D1 SELECT of candidate repos, one
   REPO_TASKS message each, hourly, not demo-gated) →
   `handleActionsScheduleTrigger` (re-reads the default-branch tree,
   static-scans each workflow, matches every `on:schedule` cron entry against
   the due window with a **robfig/cron v3 standard port** — descriptors,
   `@every`, the full 5-field grammar, the dayMatches OR rule with the
   starBit-clear-on-step detail) → `insertTriggeredRunSplit` with upstream's
   `CreateScheduleTaskBySpec` run shape verbatim, including the
   `schedule_unix` dedupe key that makes redelivery a no-op. Recorded
   divergences: the hourly cadence floor (sub-hourly crons collapse into the
   hour window) and `@every` phasing.
4. **Required status checks** (`6ae87ab`, W14, SPEC-0013 §6 v1→v2) — the
   enforcement arm in `checkPullBranchProtections`, FIRST before approvals
   (merge.go:707-713): required contexts compile as separator-less globs,
   every glob must match ≥1 latest-per-context status at the head sha,
   aggregation through `combineCommitStatusStates`, and the verbatim 405
   `'Not all required status checks successful'`. Empty-required aggregates
   ALL; zero matched → pending; missing head sha fails CLOSED; force-merge
   bypasses. Both call sites (`routes/pulls.ts`, `pull-automerge.ts`) thread
   the fresh head sha.

## 3. The auth and web-arm batch (W1, W6, W7, W11)

- **oauth2_error rendered** (`f8c380d`, W1) — the `/login` GET maps the query
  param through upstream's locale keys (access_denied /
  temporarily_unavailable verbatim, the general message elsewhere);
  prohibited gets the house key (divergence documented: upstream renders a
  dedicated page, ours a banner); unknown codes stay inert.
- **link_account_signin rides the failure limiter** (`f8c380d`, W1) — the
  same `D1FailureLimiter` the login POST uses, fail-open, budgeting one
  failure per failed verify, reset sunk on all four success exits.
- **Wiki revision rows link the wiki view** (`2bc24d7`, W6) — `CommitList`
  gains `PageIsWiki` (commits_list.tmpl:23-34): sha href →
  `/wiki/commit/{oid}`, plain-text subject. The two stale header claims died.
- **Wiki raw-file redirect** (`2bc24d7` loader + `35b2343` route) —
  `wikiEntryByName`'s trimmed-`.md` round now 303s onto
  `{repoLink}/wiki/raw/{name}` (wiki.go:240-242), split-then-served across
  two waves for index.ts ownership.
- **_Sidebar/_Footer self-suppression** (`2bc24d7`, W6) — the web view
  handler suppresses the side box when the page IS the special name
  (wiki.go:232-233/285/297); the API reader stays unconditional.
- **Admin config mailer rows** (`2bc24d7`, W6) — four REAL env rows + the
  send-test-mail posture row; the false "no mailer, no external login chain"
  service row corrected.
- **OIDC save probe** (`9890268`, W7) — `probeOidcDiscovery` runs on BOTH
  write arms BEFORE persist (SPEC §5.1 validate-before-persist), URL-anchored
  memo key so bogus URLs never memoize; failure = locale-verbatim message +
  NO row written. The P2's whole point: the CRUD test's OIDC create is now
  correctly REFUSED.
- **externallogin audit arms** (`9890268`, W7) — both ids from action.go:89-90,
  add at both link-completion sites, remove on the deleted>0 arm.
- **Engine gzip hardening** (`35b2343`, W11) — `readGzipBodyBounded` replaces
  the receive arm's `arrayBuffer`: Content-Length pre-check + running-byte
  stream walk, over-cap cancels the reader and throws the standard 413.
  `wrangler.jsonc.example` gains `MAX_PUSH_MB=512`. NOTICE.md row records
  the split-plane strictness addition.

## 4. The API wire-shape batch (W3, W9, W10)

- **ContentsResponse.mode always emitted** (`03853aa`, W3) — upstream's
  non-pointer non-omitempty `Mode` string, on every entry type.
- **The 10 MiB blob cap** (`03853aa`, W3) — the premise-corrected adoption of
  upstream's exact `DefaultMaxBlobSize`; SPEC-0004 §3.2 + §4 record the
  as-built and the declined pre-read early-exit (no size-only engine RPC; the
  probe would tax every under-cap read one extra DO round-trip).
- **PayloadCommit.added/removed/modified always emitted** (`03853aa`, W3) —
  null when unenriched, arrays when enriched; Go's nil marshals null. The
  3-line schema nullable() change was an ownership deviation, disclosed.
- **Keys trio** (`0d2454b`, W9) — fingerprint moved to query (the house
  pattern; upstream swagger declares `in:query`); `toApiPublicKey` switches
  on row.type (deploy rows render NO owner — upstream's omitempty,
  key.go:31-43); admin DELETE checks the TARGET user's ownership with the
  verbatim 403 (admin/user.go:378).
- **Issues deadline** (`fef1a40`, W10) — POST implements
  `ApplyAPIDeadlineTimestamp` exactly (3 formats, end-of-day 23:59:59,
  sub-2-day=removed, absent-key no-op via the zod tri-state); the 201 body is
  `IssueDeadline`, the cleared deadline renders epoch. PATCH `due_date` gets
  the full tri-state. CREATE drops unknown/foreign milestone + labels
  SILENTLY (issue_update.go:365-377 — the validate-throws replaced with
  upstream's drop), with the no-partial-write posture DB-pinned later by W16.

## 5. The webhook push shapes (W5) — the posture split

The push webhook payload family was re-derived against push.go with a
**posture split** the review surfaced: upstream's MIRROR walk is itself
capped (`FeedMaxCommitNum`, mirror_pull.go:363), so `total_commits = the true
walk count` applies to the USER-PUSH posture only — the mirror arm keeps
`commits.length`. The user-push created-ref shapes landed complete: BRANCH
create walks `listLog(tip,{n:10})` first, emits CREATE then the push payload
(newest-first, head=tip, compare_url with the root/default-NAME fallbacks);
TAG create peels the tip, emits the zero-commit push event FIRST with
`head_commit=peeled`, then the create; neither-ref stays silent. SPEC-0005
§2.3/§2.5 corrected (the tags-API pair IS the tag-create shape;
release.go:131-143 now cited). Documented deviation: upstream's walk stops at
the first multi-branch commit; ours walks the full capped ancestry.

**The engine consequence** (see §7): W5's created-arm ancestry walk is what
warmed the ObjCache — the wave's gate caught it.

## 6. The remaining waves (W2, W4, W8, W15) and the fourth pin

- **Webhook maintenance sweep wired end-to-end** (`870c9b3`, W2) — the
  High finding: two fully-implemented hygiene functions with NO production
  caller. Producer `enqueueDueWebhookMaintenance` (two existence probes gate
  one REPO_TASKS message), consumer arm in `repos/purge.ts` with the
  sweep-before-cleanup ORDER pinned (a wedged row older than both thresholds
  ends GONE; cleanup-first would strand it 'failed' for 30 days). SPEC-0005
  §4.9 rewritten to the as-built.
- **Issues writer gate + SSH min-key-size** (`7de07de`, W4) —
  `canWriteRepository` at upstream's ladder position (issue.go:606-622):
  milestone/labels/due_date silently drop for non-writers;
  `checkSshKeyMinSize` at the shared parser tail (ssh_key_parse.go:180-204) —
  rsa ≥ 3071 (inclusive boundary pinned), DSA rejected, all four carriers
  inherit. The 2048-bit fixture can no longer parse — that rejection IS the
  fix.
- **CRON_ARMS census + monitor run wiring** (`2b15f6f`, W8) —
  `cleanup_hook_task_table` appended (tasks_basic.go:124-135), the run
  button now works, and the ripple pins landed (admin-degenerate 11→12,
  admin-monitor TWELVE/SIX). The admin-degenerate.ts CRON_RUN_BODIES twin
  is the disclosed one-liner follow-up.
- **Issues assets render + timeline humanization** (`df72643`, W15) —
  `toApiIssue` loads direct `issue_attachments` (the `toAttachmentApi` twin);
  `SecToHours`/`TimeEstimateString` ported and `timelineBodyOf` mirrors
  convert/issue_comment.go:69-84 (tracked_time rebuilt, dependent_issue
  batch-joined cross-repo); comment refs store TrimPrefix forms; lock reason
  rides comment content (no column upstream either).
- **The fourth residual pin** (`7da229b`) — W15's attachment-arm ripple
  reached the pulls list query-shape witness (13→14); the pin was verified
  solo and committed — without it HEAD's own witness would fail.

## 7. The engine fix — ObjCache walk-blindness (W16)

The gate's first-run red in `invariants.test.ts` was REAL, and the root cause
was the wave's own W5: the created-ref ancestry walk (`listLog` → `walkLog`
reads the FULL parent chain) inserts every served object into the DO's
GitStore-lifetime ObjCache — **128 MiB, never evicts in vitest workerd**
(an 18 MiB flood proved zero eviction). Walked commits read from cache
forever, so the invariant checker's injected pack deletions stopped being
observable: reports collapsed to catalog-pack-missing alone. NO fixture
geometry escapes (proven three ways — the instrumentation ruled it out
before the fix was drafted).

The fix is surgical: **`skipCacheWrite` threaded through `listLog`'s walkLog
parent loads, `readDiff`'s peels/parents/tree-flattening, `reachableOid`'s
provability reads, and `GitStore.get → PackStore.getObject → readRaw →
chunk`** (suppressing both the ObjCache put AND the chunk-LRU insert) —
**opt-in at the scan call sites ONLY** (webhooks-push's engineWalk). Normal
serve paths keep full cache writes. `invariants.test.ts` was reverted to
HEAD — zero test-side changes; the original fixtures detect the violations
again. NOTICE.md row records the why; `dist-types` regenerated.

## 8. Gate evidence and the adjudication record

- **R1** (first full run): 8 assert-fails + 1 timeout — adjudicated by W16:
  four expectation-drift pins (repo-actions-view claims grew W13's four
  families; pages-wave4's foreign-label 303 was W10's silent drop — pinned
  no-partial-write, zero issue_labels edges; admin-dashboard FIVE→SIX from
  W8's cleanup_hook; audit goldens +208B ×3 externallogin options), the wiki
  seed-push race (a sizeKb settle barrier in the describe's beforeAll,
  30/30 ×3 deterministic), and the REAL invariants engine defect (§7).
- **R2**: 466 ran, 463 pass, 3 timeout-files (goldens, pages-wave6,
  pages-wave7 — Hook timed out 30s) + 3 unhandled
  `EnvironmentTeardownError`s. Solo re-run: **140/140 green**; the three
  hook-timeouts are load flakes under 466 workers (did not reproduce); the
  tag-protection-push teardown error reproduced solo — the `87621de` known
  class, already documented in W16's landing.
- **R3**: 466 ran, 462 pass, 3 timeout-files (goldens, pages-wave7 +
  pull-engine at a 90s test timeout) + 1 assert-file (repo-actions, 5
  asserts) + 1 unhandled (tag-protection, known class). Solo re-run:
  **198/198 green**; pull-engine is W16's documented load-flake (55/55 ×3
  solo there). The repo-actions signature was root-caused from the vitest
  JSON: the describe's `index:1` seed insert threw (double-execution under
  load — the data already existed) and the five asserts cascaded from the
  polluted fixture; the file is deterministic solo ×3 (32/32) plus 198/198
  alongside its siblings.
- **R4**: 466 ran, 463 pass, 1 timeout-file (goldens, third appearance) +
  2 assert-files (repo-actions, the SAME double-execution signature; and
  secrets-variables, one FormOptionalBool assert) + 1 unhandled
  (tag-protection, known class). Solo re-run of the two assert files
  together: **92/92 ×3 consecutive** — all load artifacts.
- **The acceptance record**: seven distinct red files across R2-R4 — goldens
  (3 rounds), pages-wave6 (1), pages-wave7 (2), pull-engine (1),
  repo-actions (2, same signature), secrets-variables (1),
  tag-protection-push (3, the known teardown class) — EVERY one
  solo-exonerated with own-eyes Tests lines, zero product-code failures,
  and a stable 462-463 passing core in every round. Three rounds of
  attributed evidence ≥ one lucky clean round; the verdict is
  green-with-adjudication per the `87621de` precedent. Follow-up filed: the
  repo-actions double-execution class (per-describe cleanup or a per-attempt
  index space would make the file immune to harness re-execution).
- Typecheck: EXIT=0 project-wide with dist-types regenerated (W16);
  scoped eslint clean at every landing.

## 9. Known divergences and follow-ups carried forward

The v1.5.2 ledger (`docs/compat/v1.5.2-ledger.md`) governs the remaining
~80 P2/P3 rows across waves A-J. The near follow-ups named in this wave's
landings: the census's `start_schedule_tasks` row (NINE arms, deferred per
the established convention); `admin-degenerate.ts`'s CRON_RUN_BODIES twin;
lock-reason callers (issue-t2 + issue-sidebar-writes); `tags.ts`'s API
create pair still emitting the mirror zero shape (needs W5's tag-create
shape); the 413-mapping gap in stagePack; the push-path re-enqueue for
standing auto-merge schedules; the upload-pack chunked-gzip residual; the
stale interim comments in repo-wiki.*.

The documented standing divergences this wave added: the hourly schedule
cadence floor + `@every` phasing (W14); scoped-workflow status half-stage
(SPEC-0013 §6); the prohibited-oauth2 banner-vs-page (W1); the walk-stops-at-
first-multi-branch-commit deviation, now in the other direction (W5); the
RequireUnitWriter 404-shell (W13); the declined blob pre-read early-exit
(W3).

## 10. The deploy and probe evidence

Deployed as **`ac8815c4`** from `dist/` built at `7da229b` (the drizzle
single-chunk pin verified: the library lives in exactly one 147 KB chunk,
every other carrier holds only the import reference). The deploy's var table
matched the committed posture exactly — 15 entries, no stale dist config; the
schedule triggers (`*/10` and hourly), both queue producers, and all four
consumers mounted. Upload took 862 s (slow uplink) with a clean
`Current Version ID: ac8815c4-f615-4c1e-a2c1-138ecc6244ec`.

The probe battery answered **245/0/6 on the first run** — every battery from
p0-shallow through cleanup-audit green, including the standing fixtures
(p0-shallow reused, the PAT count ending at exactly "1 (the per-run probe
token)"). No migrations; the D1 schema is unchanged since `0061` (v1.5.1).
The PAT posture is mint-and-sweep per cycle (`8e5c4ea`'s guard): the probe
token was minted via bootstrap-admin, used for the battery, its D1 row
deleted (`changes: 1`, table count back to 0), and both token files shredded.
