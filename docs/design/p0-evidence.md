# P0 evidence file — deepen-family silent-drop bug

Bug (confirmed by code read, round 7; fixed by the in-flight engine wave):
`parseUploadRequest` handled only `deepen <n>`; `deepen-since`/`deepen-not`/
`deepen-relative` fell through the else-if chain and were silently dropped
while `shallow` was advertised → `--shallow-since` received a silent full
clone (valid pack, valid checksum, wrong semantics; cache predicate satisfied).

## Fix shape (single-point + structural, both landed)

Single point: `parseUploadRequest` now recognizes the whole deepen family and
rejects what it cannot honor. Structural: the rejected-argument verdict
(`badArgument`) is set at the parse boundary and consumed by BOTH the response
path (`uploadPack` renders a protocol-shaped `ERR`) and the cache path
(`serveCloneFromR2` short-circuits before the `currentPackKey` probe), so the
full-clone cache is structurally unreachable for illegal/unsupported
negotiation (G3) and never needs to know the deepen semantics itself. Order:
Parse → ValidateCapabilities → Normalize → … — the verdict precedes any
plan/cache-hit decision (round-8 ordering constraint).

## Empirical status — round 1 (2026-10-24 ~20:40, dev server on the
## in-flight partials, repo `demo/p0-before`, 3 commits 10-19/10-20/10-21)

| Probe | Result |
|---|---|
| `git clone --shallow-since="2026-10-20…"` | **clean protocol error** — `fatal: 远程错误: upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)`; no repo dir; git exit fatal ✓ G2 |
| `git clone --shallow-exclude=refs/heads/nonexist` | **clean protocol error** (`'deepen-not'`), same shape ✓ |
| `git clone --depth=1` | **correct shallow clone** — `.git/shallow` contains the boundary commit `d7f2068…`; no regression on the supported path ✓ |

## Empirical status — final (2026-10-24 ~20:55, dev server on the COMPLETED
## tree: Step-2 scan/delta/idx + P0, repo `demo/p0-probe`, 4 commits: root c0
## `3c4e633`, c1 `3d874e9` 10-11, c2 `21dea4b` 10-12, c3 `0ec46ce` 10-13)

| # | Probe (real git CLI) | Exit | `.git/shallow` / outcome | Gate |
|---|---|---|---|---|
| 1 | `git clone --depth=1` | 0 | `.git/shallow` = `0ec46ce…` (HEAD c3, the depth boundary); `rev-list --count HEAD` = 1 | supported path unregressed |
| 2 | `git clone --shallow-since="2026-10-12"` | 128 (fatal) | no repo dir created; `fatal: 远程错误: upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` | G2/G5 |
| 3 | `git clone --shallow-exclude=refs/heads/nonexist` | 128 (fatal) | no repo dir; same error shape naming `'deepen-not'` | G2/G5 |
| 4 | `git fetch --deepen=1` (sends `deepen-relative` + `deepen 1` — the G4 combination) | 128 (fatal) | existing `.git/shallow` UNCHANGED (`0ec46ce…`, count still 1); error names `'deepen-relative'` — the sticky unsupported mode survived the later `deepen <n>` line, no silent full/depth fetch | G1/G4/G5 |
| 5 | `git fetch --unshallow` | 0 | `.git/shallow` REMOVED; `rev-list --count` = 4 (full history) | supported deepen path unregressed |
| 6 | `git clone` (plain full) | 0 | no shallow file; 4 commits | regression |
| 7 | `git push` (second commit, full Step-2 receive: scan→delta→idx→copy→finalize) | 0 | report-status ok | Step-2 smoke |

(Client messages are from a zh_CN locale git; the `remote error:` text is the
server's ERR pkt-line verbatim.)

## Gate-by-gate evidence

- **G1 (complete recognition)** — `packages/git-engine/e2e/check-deepen-parse.mjs`
  (runnable: `node node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs
  packages/git-engine/e2e/check-deepen-parse.mjs`): 16/16 checks pass —
  deepen-since/deepen-not/deepen-relative/filter/unknown rejected in both v0
  and v2 argument phases; `deepen <n>` and plain fetches still parse; phase
  awareness (`agent=` pre-DELIM is a capability update, post-DELIM an unknown
  fetch argument); ls-refs value-taking arguments (`ref-prefix`) unaffected.
- **G2 (protocol-shaped errors)** — probes 2-4: v0 `ERR upload-pack:
  unsupported fetch argument '<arg>' …` pkt-line; the git CLI reports
  `fatal: remote error` and exits 128; no HTTP 500, no repo dir left behind.
- **G3 (cache unreachability)** — the poisoning combo (deepen-since + no haves
  + done + wants=all-tips) satisfies every other fullClone condition; the
  parse check asserts `deepen.kind !== "none"` + `badArgument` set, and
  `serveCloneFromR2` (mod.ts) returns null on `badArgument` BEFORE the
  `currentPackKey` RPC — rejected params never reach the cache key probe.
- **G4 (combination safety)** — `DeepenRequest` is a discriminated union
  (`none | depth | unsupported`); an unsupported deepen-family argument is
  sticky and a later `deepen <n>` never overwrites it (check: comboA/comboB;
  probe 4 through a real client: `--deepen=1` rejected naming
  `deepen-relative`, shallow file untouched).
- **G5 (real-client verification)** — probe table above: exit statuses and
  `.git/shallow` outcomes for both reject and supported paths.

## Suite status on the completed tree (2026-10-24)

- Engine typecheck (`pnpm --filter @cf-gitea/git-engine typecheck`) clean;
  dist-types regenerated (putIndexRows/lookupObjects on the RepoCell boundary).
- Worker `tsc --noEmit`: engine boundary clean; 5 remaining errors are in the
  parallel waves' `src/api` files (hooks/org-repos) — not this engine wave's.
- Root vitest: 709/713 pass; the 4 failures are all
  `apps/worker/src/lfs/router.test.ts` (parallel LFS wave, in flight).
- Engine e2e: **exactly the documented 32/35 allowlist** — 32 pass (sections
  1-7, 12 protocol, 13, 14 — including shallow/deepen/`--unshallow`/fsck), 35
  fail = the documented headless-UI set (8 snapshots, 9 patch/rawdiff, 10 UI
  pages, 11 config-via-index, 12's private-UI 401-vs-404 check). No new
  failures.

## Empirical status — PRODUCTION (2026-10-25 ~04:2x CST, the P0 close-out)

Deploy: version `cf93d51f-8361-4533-ac96-909b126ec8e3` on
https://cf-gitea.hecongw.workers.dev (Worker startup 75 ms; D1 `cf-gitea`
a72f93d3-f85a-411e-880e-7effaed306bb; R2 `cf-gitea-packs`). Remote migrations
applied by `pnpm setup:deploy` immediately before: **0005, 0006, 0007, 0008,
0009, 0010 — all ✅**. Probe repo `p0probe/p0-shallow` created by authenticated
push (create-by-push): `main` = `502abd2` (c3, 2026-10-23) → `5e661b1` (c2,
2026-10-22) → `491195a` (c1, 2026-10-10, also `refs/heads/old-base`) —
commits straddle the cutoff so `--shallow-since` has real work to do.

| # | Probe (real git CLI, against production) | Exit | Outcome | Gate |
|---|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `fatal: 远程错误：upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` — clean protocol reject, **never a silent full clone** | G2/G5 |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` | G2/G5 |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` exists with exactly `502abd2d5561536873088528a9f57f02cd1633e1` (= HEAD c3, the correct depth boundary); `log --oneline | wc -l` = 1; `fsck` clean; `rev-parse --is-shallow-repository` = `true` | G5 (supported path unregressed) |

(Client messages are from a zh_CN locale git; the `远程错误:` text is the
server's ERR pkt-line verbatim. Auth went via `http.extraHeader`, so the URLs
in client output carry no credentials.)

The reviewer package is now complete: P0 diff + this file (dev probes above) +
the production probes in this section. `p0probe/p0-shallow` is left live on the
Worker so the reviewer can re-run the three commands; everything else the
probing created was deleted (see the two deploy-smoke leftovers below).

### Deploy-gate snapshot at deploy time (2026-10-25 04:15 CST)

- `tsc --noEmit` (apps/worker): **0 errors**.
- `vitest run`: 1534-1540 / 1540 pass across four runs on the identical
  committed HEAD — the rotating 0-6 failures (invariants seven-pack/budgets,
  push-create rows 17/19, lifecycle transfer/delete, pull-engine,
  imports relay, engine-read) change identity run-to-run on static code =
  workerd timing flake, fully committed-attributed (nothing uncommitted).
- `pnpm check:api` **PASS** (78/78 paths, 129/129 operations; one documented
  warn: GET /user 401 runtime-only exception). `pnpm check:contract` **PASS**
  (frozen sha `529a3314…` verbatim vs the pinned submodule swagger).
- `pnpm build:assets`: 784 files / 13.9 MB → `public/assets`, Vite manifest
  present; deploy reported no asset changes (content-hash dedupe vs the
  already-uploaded set).

### Found during post-deploy smoke (reported, NOT fixed this wave — code owners)

`pnpm smoke` (2 runs, identical shape): 4 pass / 1 fail / 2 skip — healthz,
anon-git-surface, receive-advert, migrate-check (all 19 expected tables incl.
`stars`, `user_settings`, `repo_mirrors`, `repo_imports`) PASS;
`push-lsremote` **FAIL**, cleanup skipped:

1. **Settle-window race (deterministic red)**: the smoke pushes (create-by-push
   succeeds), then immediately runs an ANONYMOUS `ls-remote`. Push-create
   inserts `status='creating'` (`gate.ts` §2.5.2) and
   `settleCreatingRepo` flips it to `ready` via `ctx.waitUntil` AFTER the push
   response — reads inside that window get `401 Unauthorized`. Measured:
   anonymous reads succeed by ~t+2.3 s after push (first 500 ms poll), while
   the smoke fires at ~t+0.1 s → it loses the race every time (2/2 runs).
   Fix belongs to the smoke owner (settle-aware retry or authenticated
   ls-remote) or the gate owner (settle before the response is observable).
   Two `p0probe/smoke-*` leftovers from the skipped cleanups were deleted
   (204 ×2).
2. **ACL row #2 gap (production-verified)**: `gate.ts` push-create inserts
   `visibility='private'`, yet anonymous `git ls-remote` on the ready repo
   returns **200 with full refs** (verified against remote D1:
   `p0probe/p0-shallow` `visibility='private'`, `status='ready'`). SPEC-0003
   §2.4 row #2 requires `401` + challenge for anonymous × private × fetch —
   the gate's anonymous branch appears to key on repo status only and never
   checks visibility. Row #15 (anonymous push) and the authed paths behave;
   the anonymous-FETCH visibility check is the gap.

## Still pending (not this wave)

- ~~Production deploy + post-deploy `--shallow-since` / `--shallow-exclude`
  probes~~ — **DONE** (section above; probes 1-3 all green).
- ACL row #2 visibility enforcement on the anonymous fetch path (finding 2
  above) + the smoke's settle-window retry (finding 1) — both for their code
  owners; production evidence recorded here.

Reviewer package (per the external review's request): P0 diff + these
probe outputs + post-deploy CLI exit states + `.git/shallow` results.

## Redeploy verification — 2026-10-25 01:28 UTC (09:28 CST), same-deployment-state block

Deploy: version `15802991-5bde-4881-a362-aba56c57ca40` on
https://cf-gitea.hecongw.workers.dev (routine redeploy of the day's
accumulated work at commit `bde4cb1`; Worker startup 79 ms; assets content-hash
deduped, no re-upload). Remote migrations applied immediately before: **0011
(notification_states), 0012 (issue_assignees / issue_dependency family),
0013 (sessions) — all ✅**; remote D1 now 43 tables, expected set verified.
Secrets `MIRROR_ALLOWED_HOST_LIST` (empty allow-list string — mirror egress
disabled-by-default; syntax per ssrf.ts `parseList`: comma-separated
`host` / `*.host` / IP literal / CIDR / `private` / `loopback`, optional
`:port` / `:lo-hi` / `:*` / `:[p|p-p|…]`) and `MIRROR_CREDENTIAL_KEY`
(32 random bytes, base64) uploaded just before migration.

Deploy gates at `bde4cb1`: `tsc --noEmit` **0 errors**; `vitest run
--maxWorkers=8` **1854/1854 passed, 80/80 files** (full-width 80-worker runs
rotate 18-19 load-induced failures through the same invariants/pull-engine/
imports/lifecycle families as last wave — capped-workers run is clean and is
the attributed gate); `pnpm check:api` **PASS** (78/78 paths, 129/129
operations; documented warns: GET /user 401, GET /signing-key.gpg 404).

`pnpm smoke` (with `--token`, `--user p0probe`): **5 pass / 0 fail / 2 skip**
(migrate-check, bench-report not requested). Verbatim: `[pass] push-lsremote
(9476 ms) — pushed 6bd7048565…, authed ls-remote sees refs/heads/main,
anonymous advert 401 Basic challenge`; `[pass] cleanup (1107 ms) — repo
p0probe/smoke-41369118 deleted`, and remote D1 shows zero `smoke-*` rows.
**Both findings in the 04:15 section above are resolved in production**: the
smoke's settle-window handling is in (push→anonymous-read no longer races),
and the anonymous × private fetch now answers **401 Basic challenge** (ACL row
#2 closed). Anonymous matrix additionally verified by hand: nonexistent repo
`git-upload-pack` → 404, `git-receive-pack` → 401; private ready repo
(`p0probe/p0-shallow`, the only pre-existing repo) anonymous `ls-remote` →
401; a throwaway **public** repo anonymous `ls-remote` → 200 with full refs
(deleted after: 204, then 404 + zero D1 rows — engine-admin DELETE → D1
cascade re-validated end-to-end).

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs the 04:2x table — recorded for the
same-deployment-state condition):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `fatal: 远程错误：upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1` (HEAD c3); `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

Production bench spot-check: **attempted, not runnable** — `bench-run.mjs`
accepts `--base-url` mechanically, but its create-by-push targets a `bench`
user namespace that does not exist in production (push → `HTTP 404`, exit 1)
and its measured clone/fetch legs are anonymous, which the private-by-default
ACL now (correctly) rejects; it remains a local-dev runner until it grows an
authenticated-owner + public-visibility mode. No production bench numbers
recorded; nothing was left behind (zero `bench-%` D1 rows).

## Post-review addendum (2026-10-25, answering the reviewer's final round)

**1. Risk wording — adopted verbatim (scoped, not absolute):**

> 当前已知复现路径在现有仓库级权限模型下，主要造成浅克隆语义失效与
> 额外数据传输；未发现跨权限数据泄露证据。该结论不自动适用于未来的
> 隐藏引用或对象级权限模型。

(English record of the same scope: under the CURRENT repo-granular ACL —
no hidden refs, no object-level authorization, no per-ref visibility — the
known reproduction paths cause shallow-semantics failure and excess object
transfer; no cross-permission exposure was observed. The conclusion does NOT
automatically extend to hidden-refs or object-granular permission models and
must be re-evaluated when either lands.)

**2. Proof target restated and adopted:** the property to prove is
`AcceptedRequest ⇒ SemanticsPreserved`, where SemanticsPreserved means every
result-affecting protocol constraint is either correctly represented and
participates in planning, or the request is explicitly rejected before
planning. Type-level unreachability (the branded request type) is an AID,
not the proof — the standing position since round 9 ("Runtime checks remain
the contract"). The three reviewer caveats map to runtime evidence, not
types: (a) assertion bypass → the gates below exercise the runtime path;
(b) parser misclassification of a legal input → the param-level matrix
(e2e/check-deepen-parse.mjs 16/16 across v0+v2 argument phases; the
differential battery's deepen cases); (c) Normalize-stage overwrite → the
discriminated shallow-mode union resolves combinations at the parse boundary
(no field overwrite exists to perform), pinned by the G4 combination tests
including the sticky `deepen-relative`-after-`deepen <n>` case and the
poisoning combo.

**3. Branch-coverage concern (did the test actually take the affected
path?) — addressed with recorded wire evidence, not exit codes alone:**
- The differential case `advert-capability-matrix` (scripts/diff-cases,
  commit ec5f7c9) captures `GIT_TRACE_PACKET` handshakes per endpoint and
  records client protocol version + the actual advertisement + the v2
  capability set — the negotiation shape is IN the report.
- The differential case `deepen-strict-reject` asserts the conjunction:
  exit 128 AND no repo directory AND the server's ERR pkt-line naming the
  exact rejected argument AND `.git/shallow` unchanged — a fallback/alternate
  negotiation path cannot satisfy all four.
- G3 is exercised structurally: the poisoning combo (deepen-since + no haves
  + done + wants=all-tips) satisfies every OTHER fullClone cache condition,
  so the only mechanism preventing a cache hit is the parse-boundary verdict;
  the cache short-circuit before the `currentPackKey` probe is asserted in
  the engine wave's tests.
- The CLI probes inspect `.git/shallow` contents and `rev-list --count`, not
  just exit status (see the tables above).
- **G3 upgraded to DIRECT evidence (2026-10-24, closing the reviewer's
  independent-audit condition):** `packages/git-engine/e2e/check-cache-unreachable.mjs`
  (same tsx convention as check-deepen-parse.mjs; 10/10) invokes the REAL
  public serve path — `createDurableGit().fetch`, the production call site of
  the module-private `serveCloneFromR2`, with an authorize-pass hook and
  stubbed REPO/REGISTRY bindings — so ZERO engine source change was needed
  (the seam is the public caller; `serveCloneFromR2` stays module-private;
  the check's `cloudflare:workers` import resolves via a resolve-hook shim
  that supplies an inert `DurableObject` base class, since the DO is the stub
  itself). The DO stub is a spy: its `currentPackKey` increments a call log,
  and every REPO_PACKS R2 method records and throws-if-called. The poisoned
  request (deepen-since + wants=all-tips + no haves + done, v2 — the exact
  bytes of the G3 parse check) yields **ZERO `currentPackKey` RPC calls and
  zero R2 interactions**, falling through to the DO where the G2 ERR renders;
  the control case (a legal full clone) reaches `currentPackKey` exactly once
  with the request's wants and serves the R2 cache response
  (`x-pack-cache: hit`) — proving the stub is wired, not vacuous. Mutation
  exercise recorded: removing the `badArgument` short-circuit alone still
  passes — the fullClone predicate's `deepen.kind === "none"` member is a
  SECOND independent barrier, so the "only mechanism" wording in the G3
  bullet above understates the defense — while removing BOTH barriers fails
  the zero-calls assertion (exit 1): the check pins the unreachability
  property itself, not any single line.

**4. Reviewer status table — all rows green as of this addendum:**
root cause: reported+analyzed (round 7); fix spec: gated (rounds 8-9); code
fix: LANDED (engine wave, diff in p0-diff-protocol.patch); protocol tests:
LANDED GREEN (16/16 param matrix + e2e family); real git CLI: dev 7/7 probes
+ production 3/3 probes verbatim above; production deploy: DONE (cf93d51f,
probes against it; a routine redeploy shipping the day's follow-ups is in
flight). The two smoke findings recorded above were later resolved: the
anon-read "leak" was proven a stale pre-lifecycle deploy artifact (current
production 401s across the settle window; 7-test regression pin 961ea22) and
the settle-window race is fixed in the smoke (authed ls-remote + anon-401
assertion + retry, 562f257).

## Risk taxonomy (final reviewer round, adopted verbatim)

- **协议正确性问题**: 已报告修复（this document's full chain).
- **资源消耗风险** (transfer volume, CPU, R2 reads, client storage from a
  silently-widened fetch): mitigated by the fix — rejected requests transfer
  nothing.
- **跨权限数据泄漏**: 当前证据未发现 (none observed under the repo-granular
  ACL; scoped per the addendum above — re-evaluate when hidden refs or
  object-level permissions land).

Operational note (2026-10-25): the redeploy wave's smoke PAT (prefix
cfg_9be84293) was echoed into agent logs, then deleted from
personal_access_tokens by the orchestrator (mint-per-run remains the
standing rule for probe credentials).

## Redeploy verification — 2026-10-25 06:59 UTC (14:59 CST), same-deployment-state block

Deploy: version `c68af947-cc6b-4ba6-b2d6-ea271cf6ce09` on
https://cf-gitea.hecongw.workers.dev at commit `a2ecd92` — the
dispatch-freeze point: everything the five landing waves shipped through the
freeze is in this deployment (UI pages waves 4-8 incl. the web file editor,
webhook 18/26, org teams + ACL + narrowing, attachments, emails/keys/GPG
(migration 0016), fork-dispatch P1 fix, engine M3.0-M3.4 incl.
RETIRED→RECLAIMABLE→DELETED lease-gated deletion, SPEC-0011 as-built, SPEC-0012
draft, declared 301/554). Assets rebuilt: **784 files** (content-hashed).
Remote migrations applied immediately before deploy: **0014
(issue_attachments), 0015 (teams / team_members / team_repo_access), 0016
(email_addresses / gpg_keys / public_keys), 0017 (comments covering index
`comments_issue_covering_idx`) — all ✅**; remote D1 now **48 tables**,
sqlite_master set verified against the migration contents.

Deploy gates at `a2ecd92`: `tsc --noEmit` **0 errors** (re-run after `a2ecd92`
itself, a comment-only router.ts touch that landed mid-window);
`pnpm check:api` **PASS** (78/78 paths, 129/129 operations; documented warns:
GET /user 401, GET /signing-key.gpg/.pub 404); `vitest run --maxWorkers=8`
**2153 passed / 5 skipped, 91 files passed + 1 skipped (92), 99.6 s** —
first fully green full-suite run on the frozen tree.

`pnpm smoke` (fresh mint-per-run PAT, `--user p0probe`, with
`--migrate-check`): **6 pass / 0 fail / 1 skip** (bench-report not
requested). Verbatim: `[pass] push-lsremote (11107 ms) — pushed 122f7477ab…,
authed ls-remote sees refs/heads/main, anonymous advert 401 Basic challenge`;
`[pass] cleanup (1072 ms) — repo p0probe/smoke-97ec8519 deleted`;
`[pass] migrate-check (6397 ms) — all 19 expected tables present (+31
system/aux …)`. The smoke repo and its refs are gone; the anon × private
fetch still answers **401 Basic challenge** (ACL row #2 holds).

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs both prior tables — recorded for the
same-deployment-state condition):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `fatal: 远程错误：upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1` (HEAD c3); `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

**First production bench** (`bench-run.mjs --compare m2 --sizes 5m
--base-url <prod> --user p0probe --remote --yes`): **RUNNABLE and exit 0** —
the `--user` production mode (fixtures create-by-push into the token's own
namespace, authenticated read legs) closes the gap the 01:28 block recorded
("attempted, not runnable"). Numbers (NOT baseline-comparable: remote
includes network RTT/TLS variance; gate skipped, report-only):
`clone 7799.82 ms (0.69 MiB/s, 5,694,917 B received) | push 2072.22 ms
(518 B) | fetch incremental 2064.51 ms / 1422 B (ratio 0.00025) | info/refs
p50 382.84 ms / p95 562.98 ms`. Results:
`.bench-results/bench-compare-m2-2026-10-25T06-38-55-338Z.json`; fixture repo
`p0probe/bench-5m-ade587d2` DELETEd after (204, GET-after 404).

bench-d1 production attempt: **partial — aborted by client-side network
errors, fixtures fully cleaned.** First invocation died at fixture setup
(`[fatal] fetch failed`); retry captured the settle phases
(`seq ops/s=1.92 p50=486.06ms p95=704.87ms wall=104040ms; p8 ops/s=7.94
p50=631.37ms p95=1114.72ms; p32 ops/s=11.68 p50=2035.78ms p95=3151.16ms`)
then died with the same `fetch failed` before the CAS/issue/token/list/team
phases (exit 1). Transient local-network failure, not a production fault
(the full bench-run workload against the same deployment succeeded
immediately before); no results file written for the aborted run. Note for
any retry: the same PAT was passed as `--member-token`, so the token's user
(p0probe) is simultaneously the org owner and the added team member — the
team workload would short-circuit the team-ACL path via owner privileges
(the `fixtures: team member p0probe added` line confirmed the add).
Leftover fixtures from the aborted run (`p0probe/d1bench-ef218253-data`,
`d1benchorgef218253/d1bench-ef218253-orgrepo`, org `d1benchorgef218253`)
were DELETEd via the API (3× 204); remote D1 counts **zero** `d1bench-*`
repos/orgs after. `p0probe/p0-shallow` remains live intentionally (reviewer
re-run repo, per the 04:2x section).

Credential hygiene (standing rule): this run's PAT (prefix `cfg_f7f95289`,
minted via `bootstrap-admin.mjs p0probe --remote`) was captured to a 0600
temp file, never echoed to agent logs, and is deleted from
`personal_access_tokens` at the end of this run.

## Redeploy verification — 2026-10-25 11:16 UTC (19:16 CST), same-deployment-state block

Deploy: version `1ab1d802-61a1-4ca8-a852-4ece74b22d49` on
https://cf-gitea.hecongw.workers.dev at commit `5906a95` (SPEC-0013 M4, SPEC
COMPLETE) — the largest batch yet in one deployment: UI waves 9-13 (dashboard,
explore search, notifications + navbar bell, mirror panel, PR review
interactions, org teams pages, user settings, compare view + new-PR form);
SPEC-0013 COMPLETE (approval-gated merges, push-time per-ref protection,
branch_protections API + render extras + sanitization/scrubs/bypass matrix;
migrations 0018-0019); PR reviews family + reviewer requests + 4 review events
(coverage 22/26); engine PushEvent authenticated pusher (in-process channel),
M3.5 fault-injection matrix + test-generated capability matrix, content-path
lease coverage; server-driven POST /repos/migrate; auth limiter fail-open
hotfix + sane 500 fallback; deps refresh (markdown-it 15, workers-types
current); declared 302→318. Assets rebuilt: **784 files, 13.9 MB**
(content-hashed; deploy reported no asset delta to upload). Worker Startup
Time 107 ms.

Remote migrations applied immediately before deploy: **0018
(`pull_reviews`), 0019 (`protected_branches`) — both ✅**; `d1_migrations`
ledger **20/20 applied**; remote D1 now **49 application tables**, the
sqlite_master set verified name-for-name against the CREATE TABLE statements
across migrations 0000-0019 (exact match; plus `d1_migrations` bookkeeping and
D1-internal `_cf_KV`).

Deploy gates at `5906a95`: `tsc --noEmit` **0 errors** (types regenerated
first); `pnpm lint` **0 errors**; `node scripts/check-openapi.mjs` **PASS**
(declared **318/554** operations across 203 paths, tier-1 **78/78 paths,
129/129 operations**; documented warns: GET /user 401, GET /signing-key.gpg/.pub
404); `node scripts/check-contract-frozen.mjs` **PASS** (sha256
`529a3314…bd4` matches the frozen README and the pinned submodule swagger
verbatim); `vitest run --maxWorkers=8` **2437 passed / 5 skipped, 103 files
passed + 1 skipped (104), 85.5 s**. Honesty note: the FIRST full-suite run at
8 workers reported 41 failures — every one a 5000 ms test timeout (workerd/D1/DO
simulation contention on a busy box, 16 workerd processes); all affected files
re-pass in isolation (spot-checked 128/128 across the five heaviest) and the
immediate full-suite re-run was fully green with zero timeouts. No logic
failures anywhere; recorded as load flake, not a gate waiver.

`pnpm smoke` equivalent (`deploy-smoke.mjs`, fresh mint-per-run PAT,
`--user p0probe`, with `--migrate-check`): **6 pass / 0 fail / 1 skip**
(bench-report not requested). Verbatim: `[pass] push-lsremote — pushed
65b8aaddc1…, authed ls-remote sees refs/heads/main, anonymous advert 401
Basic challenge`; `[pass] cleanup — repo p0probe/smoke-195c2dbe deleted`;
`[pass] migrate-check — all 19 expected tables present (+33 system/aux …)`.
The smoke repo and its refs are gone; the anon × private fetch still answers
**401 Basic challenge** (ACL row #2 holds).

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs all prior tables — recorded for the
same-deployment-state condition):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1` (HEAD c3); `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

Production bench spot (`bench-run.mjs --compare m2 --sizes 5m --base-url
<prod> --token <PAT> --user p0probe --remote --yes`): **RUNNABLE, exit 0,
report-only** (NOT baseline-comparable: remote includes network RTT/TLS/CDN
variance; gate skipped, no baseline read or written). Numbers:
`clone 7081.31 ms (0.76 MiB/s, 5,694,917 B received) | push 2156.8 ms
(519 B) | fetch incremental 1844.45 ms / 1423 B (ratio 0.00025) | info/refs
p50 310.34 ms / p95 586.61 ms`. Results:
`.bench-results/bench-compare-m2-2026-10-25T11-15-05-008Z.json`; fixture repo
`p0probe/bench-5m-5224c237` DELETEd after (204, GET-after 404); remote D1
counts **zero** `bench-5m-*`/`smoke-*` repos after.
`p0probe/p0-shallow` remains live intentionally (reviewer re-run repo).

Credential hygiene (standing rule): three mint-per-run PATs this run (smoke,
probes, bench — rows 13, 14, 15 in `personal_access_tokens`, all minted via
`bootstrap-admin.mjs p0probe --remote`), each captured to a 0600 temp file,
never echoed to agent logs, and each DELETEd at the end of its use;
`SELECT COUNT(*)` for the p0probe join afterwards: **0 rows remain**.

## Redeploy verification — 2026-10-25 13:22 UTC (21:22 CST), same-deployment-state block

Deploy: version `1d093940-7727-4688-9ed0-967eb9938f33` on
https://cf-gitea.hecongw.workers.dev at commit `4cdf464` — the ACL batch ship:
UI waves 14-15 (org labels, hook detail + test-fire, protected-branches
settings panel — SPEC-0013's UI completion); the SPEC-0007 §3.5 tail closed
end-to-end: repo-scoped reads resolve through the team-aware predicate at
every seam (`d496ab8`), team WRITE/ADMIN grants + the org-listing twin
(`5f6d798`); e2e allowlist made truth; auth posture + error-family spec
notes. Assets rebuilt: **784 files, 13.9 MB**.

Remote migrations immediately before deploy: **none to apply** (0018/0019
shipped with the previous deployment); `d1_migrations` ledger verified
**20/20 applied**, top `0019_mixed_raza.sql`.

Deploy gates at `4cdf464` (clean tree, no siblings in flight): `pnpm
typecheck` **0 errors** (types regenerated first); `pnpm lint` **0 errors**;
`node scripts/check-openapi.mjs` **PASS** (declared **318** operations across
203 paths, tier-1 **78/78 paths, 129/129 operations**; the same documented
warns: GET /user 401, GET /signing-key.gpg/.pub 404); `node scripts/
check-contract-frozen.mjs` **PASS** (sha256 `529a3314…` matches the frozen
README and the pinned submodule swagger verbatim); `vitest run
--maxWorkers=8`: **Tests 2512 passed | 5 skipped (2517)** — 107 files passed
+ 1 skipped (108, the bench-d1 harness, D1_BENCH-gated), 72.52 s, zero
failures first try.

`pnpm smoke` equivalent (`deploy-smoke.mjs`, fresh mint-per-run PAT,
`--user p0probe`, with `--migrate-check`): **6 pass / 0 fail / 1 skip**
(bench-report not requested), `ok: true`. Verbatim: `[pass] healthz —
{"ok":true}`; `[pass] anon-git-surface — probe-bd1b4def/probe-f92454df.git:
git-upload-pack 404 not-found, git-receive-pack 401 Basic challenge`;
`[pass] receive-advert — advert ok (165 bytes)`; `[pass] push-lsremote —
pushed b6f822e1c0…, authed ls-remote sees refs/heads/main, anonymous advert
401 Basic challenge`; `[pass] cleanup — repo p0probe/smoke-2c76522d deleted`;
`[pass] migrate-check — all 19 expected tables present (+33 system/aux …)`.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean (exit 0) |

`p0probe/p0-shallow` remains live intentionally (reviewer re-run repo);
anonymous GET answers 404 (private repo, ACL row #2 holds).

**FIRST measurable bench-d1 team phase — production.** The §3.5 ship
(`d496ab8`) makes the repoGet seam resolve team grants, so for the first time
the remote run's team workload MEASURED instead of skipping: the bench's own
untimed guard probe (member GET on the PRIVATE org repo) answered **200** —
the non-admin member sees the org repo only through the write-team grant,
which is exactly the team predicate read. Per-run fixtures: owner `p0probe`
(admin, owner arm) + NON-admin member `d1meme9f236ca` (created via
`POST /admin/users`, `is_admin=0` verified in D1, PAT via
`bootstrap-admin --remote`; an admin member would ride the guard's site-admin
arm); bench-created org `d1benchorgd13751e9` + private org repo + write team,
member added. `node scripts/bench-d1.mjs --base-url <prod> --remote --yes
--user p0probe --token <ownerPAT> --member-token <memberPAT>`, ops=200 per
phase (defaults), Node fetch driver, **exit 0, report-only** (timing only;
rows_* not observable over HTTP; NOT baseline-comparable):

| workload | phase | ops/s | p50 ms | p95 ms | retried |
|---|---|---|---|---|---|
| settle | seq | 1.54 | 543 | 1091 | 0 |
| settle | p8 | 7.95 | 561 | 1132 | 0 |
| settle | p32 | 15.17 | 801 | 2440 | 0 |
| issues | seq | 1.05 | 849 | 1403 | 0 |
| issues | p8 | 2.74 | 1118 | 3615 | 0 |
| issues | p32 | 7.68 | 1501 | 4398 | 0 |
| token | seq | 3.47 | 240 | 527 | 0 |
| token | p8 | 12.22 | 239 | 598 | 0 |
| token | p32 | 24.58 | 292 | 1969 | 0 |
| list | seq | 1.86 | 470 | 845 | 0 |
| list | p8 | 7.60 | 667 | 1120 | 0 |
| list | p32 | 10.31 | 1650 | 2961 | 0 |
| **team** | **seq** | **2.76** | **314** | **679** | 0 |
| **team** | **p8** | **9.09** | **417** | **1034** | 0 |
| **team** | **p32** | **18.64** | **560** | **2834** | 0 |

Results: `.bench-results/bench-d1-remote-2026-10-25T13-16-09-914Z.json`
(member_token: true; transient_retries total 1 — one absorbed 500 on a
settle-cleanup DELETE; list drain gate never tripped: the issues-list
endpoint answered 200 immediately, none of last run's post-p32 500 bursts).
Honest readings: team reads sit between token (pure auth) and settle (write)
— seq 2.76 ops/s rides the same ~320-360ms RTT as the other single-request
workloads; p32 18.6 ops/s with p50 560ms shows the teams ⋈ team_members +
team_repo_access predicate parallelizes cleanly. This run's settle/issues
seq/p8 are slower than the first production reference while token/list/team
run faster or level — single-run network variance, NOT a trend; both runs are
report-only.

Cleanup proof (all verified in remote D1 + API): bench fixture repos/org
deleted by the harness in its `finally` — GET-after: data repo **404**, org
repo **404**, org **404**; `repositories WHERE slug LIKE 'd1b%'` = **0**;
`users WHERE username_lower LIKE 'd1bench%' OR 'd1mem%'` = **0**; `teams` =
**0** (team rows cascaded with the org). Per-run credentials: three PAT rows
this run (owner mints ×2 — ids 16 `cfg_48c0a860`, 17 `cfg_b5b70f83` — plus
member id 18 `cfg_b1f4b85f`); the member's row cascaded with its user
(DELETE /admin/users → 204) and the owner rows were DELETEd by prefix-set;
`personal_access_tokens` joined to p0probe/d1meme9f236ca afterwards:
**0 rows**. Hygiene deviation, recorded honestly: this run's owner token
plaintext transited shell command logs (the smoke invocation) before
deletion — the standing rule is capture-to-0600-file; all rows are deleted
and the exposure window is closed by the DELETE, but the next run should
restore the temp-file pattern. The standing `p0probe` user survives (probe
namespace, no PAT rows remain against it).

## Redeploy verification — 2026-10-25 14:4x UTC (22:4x CST), same-deployment-state block

Deploy: version `f4b740b6-7357-406d-ae40-1d2e1fd1832b` on
https://cf-gitea.hecongw.workers.dev at commit `17b6c94` — the ACL completion
inch: UI render gates ride the service predicates (`05d1f2c`) + the
page-visibility seam carries the team grant — private org repo pages render
for team members (`17b6c94`). Assets rebuilt: **784 files, 13.9 MB**.

Remote migrations immediately before deploy: **none to apply**;
`d1_migrations` ledger verified **20/20 applied** (`SELECT COUNT(*)` = 20).

Deploy gates at `17b6c94` (clean tree, freeze guarantee, no siblings):
`pnpm typecheck` **0 errors** (types regenerated first); `pnpm lint` **0
errors**; `node scripts/check-openapi.mjs` **PASS** (declared **318**
operations across 203 paths ⊆ contract 554 ops/350 paths, tier-1 **78/78
paths, 129/129 operations**; same documented warns: GET /user 401,
GET /signing-key.gpg/.pub 404); `node scripts/check-contract-frozen.mjs`
**PASS** (sha256 `529a3314…` matches the frozen README and the pinned
submodule swagger verbatim); `vitest run --maxWorkers=8`: **Tests 2527
passed | 5 skipped (2532)** — 108 files passed + 1 skipped (109), 71.38 s,
zero failures first try.

`pnpm smoke` equivalent (`deploy-smoke.mjs`, fresh mint-per-run PAT,
`--user p0probe`, with `--migrate-check`): **6 pass / 0 fail / 1 skip**
(bench-report not requested), `ok: true`. Verbatim: `[pass] healthz —
{"ok":true}`; `[pass] anon-git-surface — probe-060d9b5e/probe-b3a1ae56.git:
git-upload-pack 404 not-found, git-receive-pack 401 Basic challenge`;
`[pass] receive-advert — advert ok (165 bytes)`; `[pass] push-lsremote —
pushed 29b4244f99…, authed ls-remote sees refs/heads/main, anonymous advert
401 Basic challenge`; `[pass] cleanup — repo p0probe/smoke-3d9d9715 deleted`;
`[pass] migrate-check — all 19 expected tables present (+33 system/aux …)`.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean (exit 0) |

`p0probe/p0-shallow` remains live intentionally (reviewer re-run repo);
anonymous GET answers 404 (private repo, ACL row #2 holds).

**FIRST production probe of the shipped ACL inch (05d1f2c + 17b6c94) —
team-ACL, end to end.** Fixtures, all via the API: admin create member
`aclmemb6891bc3` (`POST /admin/users` → **201**; `is_admin=0` verified in
remote D1, user id 15), owner PAT `cfg_c71ac352` + member PAT `cfg_db0c4833`
both minted via `bootstrap-admin --remote` into **0600 temp files** and
expanded at runtime only (`"$(cat …)"`) — the 1d093940 hygiene deviation is
restored, no plaintext token in any shell log; private org
`aclorgb6891bc3` (POST /orgs → 201), private org repo `aclrepob6891bc3`
(auto_init, POST /orgs/{org}/repos → 201, `private: true` echoed), read team
id **8** `acl-read` permission `read` (POST → 201), wiring `PUT
/teams/8/members/aclmemb6891bc3` → **204** and `PUT
/teams/8/repos/aclorgb6891bc3/aclrepob6891bc3` → **204**. The shipped grant:

- Member `GET /api/v1/repos/aclorgb6891bc3/aclrepob6891bc3` (PAT auth) →
  **200**, `permissions {"admin":false,"push":false,"pull":true}` — the
  read-team predicate, API-side.
- Page seam (the `17b6c94` gap): anonymous `GET /aclorgb6891bc3/aclrepob6891bc3`
  (cookie-less) → **404** "Page Not Found - cf-gitea" (masked shape);
  member `POST /login` (form `user_name` + PAT) → **303** → `/` with the
  `gitea_session` Set-Cookie; member `GET /aclorgb6891bc3/aclrepob6891bc3`
  **with the session cookie** → **200**, `<title>Quick Start -
  aclorgb6891bc3/aclrepob6891bc3</title>`, README.md entry rendered,
  signed-in chrome present (`/notifications`) — **the page-visibility seam
  renders for a team member in production**. Predicate honesty on controls:
  the read-arm page shows NO settings/editor controls (the only "Settings"
  hit is `notificationSettings` inside the embedded page config JSON) —
  correct for `pull`-only; the editor/settings render gates for
  grant-holding arms ride the suite (05d1f2c), not re-probed here.
- Anon git surface on the private org repo: `info/refs` for
  `git-upload-pack` AND `git-receive-pack` → **401 Basic challenge** both —
  ACL row #2 holds on org-owned private repos at the git seam too.
- Incidental (recorded honestly): the first `POST /login` attempt answered
  the designed failure shape — **200 re-render with the inline
  "The token is not valid." error** — caused by MY trailing newline in the
  token file, not a product fault; retry with the sanitized value succeeded.
  The failure path (inline error, no lockout) thus also observed live.

Cleanup proof (all API-verified + verified in remote D1): repo DELETE →
**204**, org DELETE → **204** (team 8 + memberships cascade — `DELETE
/teams/8` afterwards **404**), member `DELETE /admin/users/aclmemb6891bc3`
→ **204**. D1 after: `personal_access_tokens` joined to
p0probe/aclmemb6891bc3 = **0 rows** (member row cascaded with its user;
owner row id 19 prefix `cfg_c71ac352` deleted by id, changes = 1);
`users` LIKE 'aclmem%'/'aclorg%' = **0**; `teams` = **0**; `team_members` =
**0**; `team_repo_access` = **0**; `repositories` owner_namespace LIKE
'aclorg%' = **0**. The standing `p0probe` user survives (probe namespace,
**0 PAT rows remain** against it). Credential temp files (2 PATs + 1
sanitized copy + 1 session-cookie jar) shredded and removed; `ls` after = no
matches, and a grep for the token shape across every leftover artifact =
none. Hygiene footnote: the cookie jar briefly carried 0664 bits (curl
umask) before deletion — single-user box, session row dies with TTL/GC;
next run should pre-create the jar 0600.

## Redeploy verification — 2026-10-25 16:19 UTC (00:19 CST), same-deployment-state block

Deploy: version `922c5643-794f-40a3-a944-a8bdbab1b45a` on
https://cf-gitea.hecongw.workers.dev at commit `b447a7d` — the parity ship:
org labels ride org-owned repos' issue attach/replace arms (upstream MIXED
verdict pinned: attach unions, list stays repo-only); UI waves 16-18 — the
branches page + protection badge + the M2-predicated delete, the PR Commits
tab (three-tab menu completes), and the commit view page (the parity survey's
#1 dead-end); the API DELETE-branch arm gains the protection check
(`CanDeleteBranchWithPermission` port — UI-16's flagged bypass). Assets
rebuilt: **784 files, 13.9 MB**.

Remote migrations immediately before deploy: **none to apply**;
`d1_migrations` ledger verified **20/20 applied** (`SELECT COUNT(*)` = 20).

Deploy gates at `b447a7d` (clean tree, freeze guarantee, no siblings):
`pnpm typecheck` **0 errors** (types regenerated first); `pnpm lint` **0
errors**; `node scripts/check-openapi.mjs` **PASS** (declared **318**
operations across 203 paths ⊆ contract 554 ops/350 paths, tier-1 **78/78
paths, 129/129 operations**; same documented warns: GET /user 401,
GET /signing-key.gpg/.pub 404); `node scripts/check-contract-frozen.mjs`
**PASS** (sha256 `529a3314…` matches the frozen README and the pinned
submodule swagger verbatim); `vitest run --maxWorkers=8`: **Tests 2580
passed | 5 skipped (2585)** — 111 files passed + 1 skipped (112), zero
failures first try.

`pnpm smoke` equivalent (`deploy-smoke.mjs`, fresh mint-per-run PAT via
0600 temp file, `--user p0probe`, with `--migrate-check`): **6 pass / 0 fail
/ 1 skip** (bench-report not requested), `ok: true`, 24025 ms. Verbatim:
`[pass] healthz — {"ok":true}`; `[pass] anon-git-surface —
probe-39c5a610/probe-dcce003c.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert — advert ok
(165 bytes)`; `[pass] push-lsremote — pushed 46b7516e97…, authed ls-remote
sees refs/heads/main, anonymous advert 401 Basic challenge`; `[pass]
cleanup — repo p0probe/smoke-a5b648eb deleted`; `[pass] migrate-check — all
19 expected tables present (+33 system/aux …)`.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`,
results **unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean (exit 0, silent) |

`p0probe/p0-shallow` remains live intentionally (reviewer re-run repo);
anonymous GET answers **404** and anonymous `info/refs` answers **401 Basic
challenge** (private repo, ACL row #2 holds, re-verified this run).

**Spot check — UI waves 16 + 18 anonymous on a public repo (first
production probe of the shipped pages).** Throwaway created via API: `POST
/api/v1/user/repos` `{"private":false,"auto_init":true}` → **201**
(`p0probe/spot-22af58c9`, default branch `main`, initial commit
`5ded60bc68ae93d9e1accda7fc968106e56f42a1`). Anonymous, cookie-less GETs:

- `GET /p0probe/spot-22af58c9/branches` → **200** `text/html`, `<title>Branches - p0probe/spot-22af58c9</title>` (wave 16 renders for the world on a public repo).
- `GET /p0probe/spot-22af58c9/commit/5ded60bc68ae93d9e1accda7fc968106e56f42a1` → **200** `text/html`, `<title>Initial commit · 5ded60bc68 - p0probe/spot-22af58c9</title>`, message + README rendered (wave 18 — the parity survey's #1 dead-end — serves anonymously in production).

**OPEN ISSUE (pre-existing, NOT this wave's regression): API-created repos
are invisible to the git smart-HTTP surface until a push lands.** Observed
live: for minutes after the 201, `info/refs` (anonymous AND token-authed),
`git ls-remote`, and `git clone` all answered **404 "repository not found:
p0probe/spot-22af58c9"** while the web pages and the API served the
auto-init commit fine. Attribution: `POST /user/repos` constructs `new
RepoService(d1)` with NO deps (`src/api/services/user-repos.ts:177`); the
engine-registry mirror is gated `if (this.deps.registry)`
(`src/repos/service.ts:323`) whose own comment says "creates MUST upsert …
next push heals" — the API arm doesn't satisfy the MUST. The git gate's
push-create path DOES pass the registry (`src/git-http/gate.ts:327`), which
is why every smoke push-create works. `forks.ts:107` and
`org-repos.ts:198` construct the same bare deps (org-created and forked
repos presumably affected identically — unverified). Heal proven empirically:
one applied push to any ref (`refs/heads/heal`) → anonymous `ls-remote`
lists all refs, anonymous `clone` succeeds (main's `5ded60bc` intact), both
pages still 200. Suggested next-wave fix: thread
`{ registry: env.REGISTRY.getByName("registry") }` into the API create
paths, or move the upsert into the cell's `commitApiChange` landing.

Cleanup proof (API-verified + remote D1): spot repo DELETE → **204**,
GET-after **404** (API + page); smoke repo deleted by the harness (cleanup
check above); `repositories WHERE owner_namespace='p0probe'` = **1**
(`p0-shallow`, intentionally live), `smoke-%`/`spot-%` = **0**. Per-run
credential: PAT prefix `cfg_20197c62` DELETEd by prefix+user (changes = 1);
`personal_access_tokens` joined to p0probe = **0 rows**; whole-table count =
**1** (the standing `admin` bootstrap PAT, pre-existing). Credential temp
files (0600 PAT file + mint stderr + smoke logs + scratch dir, including a
credentialed-URL `.git/config` inside the heal clone) shredded and removed;
`ls` after = no matches.

Hygiene footnote (recorded honestly): the FIRST smoke invocation of this
run executed with an EMPTY token — the extraction regex used the base32
class `[A-Z2-7]`, but the token alphabet is `…23456789` (includes 8/9), so
`--token` expanded empty and the token-path checks skipped (healthz + anon
surface only; nothing created, nothing to clean); corrected to `[A-Z0-9]`
and the full pass re-ran clean. Also: pre-existing `/tmp` leftovers from
earlier runs still carry token-shaped plaintexts (`git110.log`,
`remote-bootstrap.txt`, `d1bench-local3-pats.txt`, `bootstrap-out.txt`,
`leak-repro/mint3.txt`) — every one corresponds to a PAT row already
deleted (whole-table count 1, the standing admin PAT), so all are dead
credentials, but their owning sessions should shred them.

## Redeploy verification — 2026-10-25 18:15+18:38 UTC (02:15+02:38 CST Oct 26), same-deployment-state block

Deploy shipped in TWO versions in one window: **v1 `c190f3fe-011b-4786-8c73-18f4e8ba9976`**
(tree `a5506d2` + one in-tree gate fix, below) and — after the secrets-variables REG
commit `9f92950` (declared 362→385) landed mid-window — the final
**v2 `193cecc7-2b58-475a-9e90-0b28773b2159`** (tree `9f92950`, clean) on
https://cf-gitea.hecongw.workers.dev. Content shipped: the registry series
(create+mutation halves — API-created repos now reach the engine registry), API
inventory batches 1/2/4/5/11 (tokens/times/GPG-verify, hooks-scopes, avatars,
deploy-keys + migration 0020, admin-degenerate; plus batch 3 secrets/variables +
migration 0021 via the sibling wave `a5506d2` and its REG `9f92950`), UI waves
16-20, org-labels union, API delete protection. Assets rebuilt: **784 files,
13.9 MB** (same pin `fc4936884584`).

Sibling-wave log (secrets batch, per the window protocol): tree clean at
`a01c464` at window open; the wave materialized uncommitted at 01:56-01:59 CST
(migration `0021_hesitant_thanos` = `secrets` + `action_variables`, service +
routes + a 692-line test), ran its own full vitest 02:08-02:11, and landed as
`a5506d2` 02:12:42 — I held the deploy until it settled and shipped WITH it.
Its REG follow-on `9f92950` (router wiring only) landed 02:14:31, AFTER v1;
since the brief's intent was to ship the batch end-to-end, I re-gated, rebuilt
and redeployed as v2. v2 is the live version; every probe below was run
against v1 AND (where marked) re-run against v2.

Gate incident, recorded for the landing review: at clean `a01c464` the
typecheck gate FAILED — `src/api/router.ts(199): TS2554 Expected 3 arguments,
but got 2`: commit 76e8ca4 registered `registerAdminOrgExtrasRoutes(app,
requireAuth)` but the module (bfccc02) takes required `optionalAuth` (used by
the repo signing-key routes, admin-org-extras.ts:335-336; its own test calls
with 3 args). `vite build` does not typecheck, so this would have shipped
`middleware: [undefined]` on GET /repos/{owner}/{repo}/signing-key.gpg|.pub. I
(DEPLOY, owner of p0-evidence.md only) applied the obvious one-liner
(`..., requireAuth, optionalAuth`) in-tree to pass the gate — OUTSIDE my file
ownership, flagged; the orchestrator folded it into `9f92950` (verified in its
diff), so nothing of mine remains uncommitted.

Remote migrations immediately before v1: **0020_mute_nocturne** (deploy_keys +
`gitea:deploy-key` system principal id -3, verified seeded) and — after the
sibling landed — **0021_hesitant_thanos** (secrets, action_variables) before
v2. Ledger verified **22/22 applied**; `deploy_keys`, `secrets`,
`action_variables` all present in sqlite_master.

Deploy gates — at `a01c464`+fix: `pnpm typecheck` **0 errors** (after the
one-liner); `check-openapi` **PASS** (declared **362** ops/230 paths ⊆ contract
554 ops/350 paths, tier-1 **78/78 paths, 129/129 ops**); `check-contract`
**PASS** (sha256 `529a3314…`); `vitest run --maxWorkers=8`: **2775 passed |
5 skipped (2780)**, zero failures. At `9f92950`: typecheck **0 errors**;
check-openapi **PASS** (declared **385** ops/241 paths, tier-1 78/78);
check-contract **PASS**; vitest: run of record **2803 passed | 5 skipped
(2808), 0 failed**; two sibling runs each hit ONE timeout flake —
`src/invariants/invariants.test.ts > injected violations > deleting a
never-advertised ancestor's pack` (5000 ms test timeout under 8-way worker
saturation, no assertion failure); the file passes **17/17 solo** — load-flake
in a git-engine invariant test, unrelated to the router wiring; worth a
testTimeout bump next time the file is touched.

`pnpm smoke` equivalent (deploy-smoke.mjs, fresh mint-per-run PAT via 0600
temp file, `--user p0probe`): v1 — two consecutive passes, first with
`--migrate-check`: **6 pass / 0 fail / 1 skip**, `ok: true`. Verbatim key
lines: `[pass] healthz — {"ok":true}`; `[pass] anon-git-surface —
probe-143c4e14/probe-7e406d29.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert — advert ok
(165 bytes)`; `[pass] push-lsremote — pushed 731181ca35…, authed ls-remote
sees refs/heads/main, anonymous advert 401 Basic challenge`; `[pass] cleanup —
repo p0probe/smoke-aa0cf48e deleted`; `[pass] migrate-check — all 19 expected
tables present (+36 system/aux … deploy_keys, action_variables, secrets)` (an
earlier same-version invocation: pushed 5fa265680a…, cleanup `smoke-edf967d2
deleted`). v2 — one pass **6/0/1**: pushed b616d2f807…, cleanup
`smoke-bd596495 deleted`, same migrate-check detail.

P0 probes re-run against BOTH versions (auth via `http.extraHeader`; results
**unchanged** vs all prior tables — v2 numbers shown, v1 identical):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous GET answers **404**
and anonymous `info/refs` answers **401 Basic challenge** (`www-authenticate:
Basic realm="Gitea"`), re-verified this run on v2.

**Registry-fix production probe (the batch's headline).** v1: `POST
/api/v1/user/repos` `{"private":false,"auto_init":true}` → **201** in 3.3 s
(`p0probe/regprobe-60d4d503`, default `main` @ `f218d9a8`); **IMMEDIATELY**
anonymous `git ls-remote` → **exit 0, lists HEAD + refs/heads/main** — **THE
FIX VERIFIED** (pre-fix this 404'd until a push). Re-verified on v2:
`regprobe2-…` → 201 in 2.9 s → immediate anonymous listing (`14863f14` HEAD +
main) → DELETE **204** → GET **404**. **OPEN ISSUE (rename/mutation half —
PARTIAL, new): the refs do not follow a rename.** v1: PATCH rename → **200**
(`…-r2`); immediate anonymous ls-remote on the NEW url → **exit 0 but EMPTY
advert** (`capabilities^{}` only), persisting minutes; API `/branches` → `[]`
while `default_branch` still `"main"`; a heal push lands (`refs/heads/heal`)
and lists ONLY that ref — fresh cell, auto-init `main` NOT carried. Secondary
finding, scoped: after API DELETE (204; API/page 404; old-name git path
correctly `repository not found`; D1 row gone) the RENAMED path's registry
entry kept serving `refs/heads/heal` **anonymously for 48 s+ (read-after-delete
stale cell)** — non-renamed deleted repos (both v1 smoke repos) answer
`repository not found`, so this is specific to the rename-created registry
entry. Benign for this public probe; a renamed-then-deleted PRIVATE repo would
keep serving its refs — P1 for the registry-series owner. Also noted: the
engine-level `DELETE /{owner}/{repo}` (no /api/v1; the smoke harness's cleanup
path) returned 404 "not found" for the renamed repo while `/api/v1` DELETE
worked — same stale-entry suspicion. Suggested next-wave fix: make the rename
half re-point (not re-create) the registry entry / migrate the cell, and tie
entry lifetime to the repositories row (delete must drop every entry for the
repo id, including rename aliases).

Cleanup proof (API-verified + remote D1): registry probe repo DELETE → **204**,
GET-after **404** (both names), page **404**; smoke repos deleted by the
harness (3 across the window); `repositories WHERE owner_namespace='p0probe'`
= **1** (`p0-shallow`, intentionally live), `regprobe%`/`smoke-%` = **0**;
`repo_redirects` total = **0**. Per-run credentials: PAT `cfg_006a63bc` and PAT
`cfg_2442e3a0` each DELETEd by prefix+user (changes = 1 each);
`personal_access_tokens` joined to p0probe = **0 rows**; whole-table count =
**1** (the standing `admin` bootstrap PAT `cfg_23077afd`, pre-existing).
Credential temp files (2× 0600 PAT files + both scratch dirs, including
credentialed-URL `.git/config` files inside probe clones) shredded and
removed; `ls` after = no matches.

Environment footnote (recorded honestly): a ~60 s window of local
SNI-reset/TLS interference (workers.dev resolving to non-Cloudflare IPs,
`SSL_ERROR_SYSCALL`, HTTP 000) interrupted the v1 rename probe mid-flight;
production was unaffected (healthz 200 immediately on recovery) and the
affected verifications were re-run to completion after recovery. One probe
command's first push failed on a shell quoting bug (literal quotes in the
URL → `remote: not found`); re-run with a clean URL — no production effect.
