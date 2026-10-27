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

## Redeploy verification — 2026-10-26 00:01 UTC (08:01 CST), same-deployment-state block (wave-22 series)

Deploy shipped as ONE version: **`5835d8ab-d65a-4824-a239-7d53c01f8627`** (100%,
Created 2026-10-26T00:01:29Z), deployed from tree **`fc123b0` CLEAN**, on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`193cecc7-2b58-475a-9e90-0b28773b2159` (the 2026-10-25 block's v2). Content
shipped (declared **385→434** ops / 267 paths): the wave-22 migrations series —
blocks (0022 `user_blocking`, 8 ops), push-mirrors (0023 `push_mirrors`, 5 ops),
projects×4 tables (0024 `projects`/`project_columns`/`project_issues`/
`project_workflows`), tag-protections (0025 `protected_tags`, 5 ops) — the wiki
family (6 ops, table-free, d3362b1), the **P1 registry rename/delete fix
5e2c418**, git-hooks (4 ops, 12ab90d) and projects-repo stage 1 (21 ops,
0d5b480+fc123b0). Assets rebuilt: **784 files, 14 MB** (same pin
`fc4936884584`). Omissions (recorded honestly, per the window protocol): the
oauth2-apps / badges / repo-licenses+generate-repo / blocks-enforcement waves
were IN FLIGHT at GO time — their files were UNCOMMITTED and therefore NOT in
the deploy tree.

Deploy-tree methodology (new for this run, recorded for the landing review):
the shared working tree at GO carried 4 in-flight siblings' uncommitted hunks
(653 insertions across 13 tracked files + 17 untracked) which `vite build`
would have bundled; since the GO named commit `fc123b0`, the deploy ran from a
detached **`git worktree add`** at exactly that commit — warm
`pnpm install --frozen-lockfile` (230 ms), the prebuilt asset dir copied in
(pin unchanged), `git submodule update --init` inside the worktree (same pin;
the main checkout's submodule untouched, verified pristine after), and
`pnpm gen:icons` (gitignored generated file a fresh worktree lacks). The
worktree (including its copied gitignored `.dev.vars`) was shredded and
removed after the run; the main working tree was never modified by this agent.

Deploy gates — at `fc123b0` (worktree): `pnpm typecheck` **0 errors**;
`check-openapi` **PASS** (declared **434** ops/267 paths ⊆ contract 554 ops/350
paths, tier-1 **78/78 paths, 129/129 ops**); `check-contract` **PASS**
(sha256 `529a3314…`); vitest run of record `--maxWorkers=8`: **2951 passed |
5 skipped (2956), 130 files passed + 1 skipped (131), 0 failed**. First full
run at this tree had 7 fails in 4 files, adjudicated per file (none is a code
regression): `invariants.test.ts` ×3 and `pages-wave7.test.ts` (beforeAll hook
timeout) are the known 8-worker saturation load-flakes and pass solo;
`index.test.ts` ×2 + `push-create.test.ts` ×1 asserted 401/200 but got 403 —
traced to the FRESH WORKTREE lacking the gitignored `.dev.vars` (no
`GIT_TOKEN` → the engine's static-token arm answers its fail-closed 403,
`src/git-http/authorize.ts:51`); with `.dev.vars` present all 4 files pass
solo (97/97) and the full suite re-ran green as recorded above. Gates at
window-open HEAD `51d3c74` (with the projects sibling's untracked files
present): typecheck 0, check-openapi PASS (409 ops/254 paths), contract PASS,
vitest 2926 passed | 3 failed — all 3 in that sibling's own untracked
`projects-repo.test.ts` (its known 3 reds, fixed at its landing 0d5b480,
"26/26"); every committed file passed.

Remote migrations immediately before deploy: **0022_panoramic_bloodstorm,
0023_fresh_captain_america, 0024_past_gressill, 0025_young_nico_minoru** — all
✅; ledger after: "✅ No migrations to apply!" (25/25); `user_blocking`,
`push_mirrors`, `protected_tags`, `projects`, `project_columns`,
`project_issues`, `project_workflows` all verified in remote `sqlite_master`.
No seed rows in these migrations.

`pnpm smoke` equivalent (deploy-smoke.mjs, fresh mint-per-run PAT via 0600
temp file, `--user p0probe`, with `--migrate-check`): **6 pass / 0 fail /
1 skip** (bench-report not requested), `ok: true`. Verbatim key lines:
`[pass] healthz — {"ok":true}`; `[pass] anon-git-surface —
probe-1a7d6632/probe-b3b6a034.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert — advert ok
(165 bytes)`; `[pass] push-lsremote — pushed 8cccb109f8…, authed ls-remote
sees refs/heads/main, anonymous advert 401 Basic challenge`; `[pass] cleanup —
repo p0probe/smoke-102b5ba6 deleted`; `[pass] migrate-check — all 19 expected
tables present (+43 system/aux: … deploy_keys, action_variables, secrets,
user_blocking, push_mirrors, project_columns, project_issues,
project_workflows, projects, protected_tags)` — the 0022-0025 tables verbatim.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`; results
**unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous GET answers **404**
and anonymous `info/refs` answers **401 Basic challenge**
(`www-authenticate: Basic realm="Gitea"`), re-verified this run.

**Registry rename/delete RE-PROBE (the headline — production proof of the P1
fix 5e2c418).** Three full lifecycles (A/B/C), all repos PUBLIC, all
ls-remotes anonymous:

- **Repo A** (`reg10a-a94529`): `POST /api/v1/user/repos`
  `{"private":false,"auto_init":true}` → **201** in 2.6 s (default `main`);
  IMMEDIATE anonymous ls-remote → **exit 0, lists HEAD + refs/heads/main**
  (`103a2ab2dc70…` — create half still holds). Pushed a second ref
  `refs/heads/second` (`e9db9a604c3e…`). `PATCH` rename → **200**
  (`full_name":"p0probe/reg10a-a94529-r2"`); **IMMEDIATE anonymous ls-remote
  on the NEW name lists ALL THREE — HEAD, main, second: THE CARRY IS
  VERIFIED** (pre-fix this advert was empty; REDEPLOY9's symptom 1 closed in
  production). API `/branches` → `main` + `second` (non-empty).
  **Old-name post-rename behavior, recorded verbatim**: `/api/v1/repos/
  p0probe/reg10a-a94529` → **404**, web page → **404**, but anonymous
  `ls-remote` on the OLD name → git prints `warning: 重定向到
  …/p0probe/reg10a-a94529-r2.git/` and lists the same refs (exit 0) — the
  `repo_redirects` row resolves the old name as an HTTP redirect on the git
  path (the fix's documented choice: upstream files repo_redirects too and
  renames the directory in place; cf-gitea redirects rather than serves in
  place — the §2.5.3 row-13 divergence already on record; the API/web 404 on
  the old name is the divergence to note for the registry owner). `DELETE
  /api/v1/repos/p0probe/reg10a-a94529-r2` → **204**; IMMEDIATE anonymous
  ls-remote on the OLD name → **128 `repository not found`** ✓, on the NEW
  name → **still listed all three refs (exit 0)** — see open issue below;
  API GET + page on the new name → **404/404**. Minutes later the new name
  answers **128 not-found** — the queue consumer's backstop purge healed it.
- **Repo B** (`reg10b-a94529`, engine-level DELETE on a renamed repo — the
  REDEPLOY9 finding that the engine DELETE 404'd renamed repos): create 201 →
  pushed `refs/heads/eng` → rename → **`DELETE /p0probe/reg10b-a94529-r2`
  (no /api/v1, Basic auth) → 200 "deleted"** (renamed repo now resolves on
  the engine cleanup path) → IMMEDIATE anonymous ls-remote on the new name
  **128 not-found** ✓ AND on the old name **128 not-found** ✓ — both names
  dead at t+0.
- **Repo C** (`reg10c-cf0186`, reproduction with `wrangler tail` attached,
  delete fired immediately after rename): create 201 → push `refs/heads/tail`
  → rename 200 → API DELETE 204 → IMMEDIATE anonymous ls-remote on the new
  name → **128 not-found** ✓. Tail shows the delete's Registry `remove` ×N,
  RepoCell `markDeleted` ×N and later `destroy` ×N, every event
  `"outcome":"ok"`, `"exceptions":[]`, no `[repos]` error lines.

**New-surface spot probes (light, one pass each).** Blocks: `GET
/user/blocks/{tgt}` → 404 (unblocked), `PUT` → **204**, `GET` → **204**
(blocked), `GET /user/blocks` lists the target, `DELETE` → **204**, `GET` →
**404** (unblocked) — exact upstream codes; the throwaway target user was
created via `POST /admin/users` (201) and purged after (`DELETE
/admin/users/{u}?purge=true` → 204). Tag protections: `POST
…/tag_protections` `{"name_pattern":"v*","whitelist_usernames":["admin"]}` →
created (`"id":1`), then `POST /tags {"tag_name":"v1"}` as the non-whitelisted
owner → **422 `{"message":"user not allowed to create protected tag"}`**
(verbatim upstream text); DELETE protection → 204. Push mirrors: `POST
…/push_mirrors` → **200** (`remote_name":"remote_mirror_UIzTiGAEqM"`), LIST
shows it, GET by name **200**, DELETE **204**, LIST after → 0. Wiki: `POST
…/wiki/new` → **201** (WikiPage JSON with title/sub_url/content_base64), page
read `…/wiki/page/Home` → **200** (also with `.md`), list `GET
…/wiki/pages` → **200** with `last_commit` metadata, missing page → **404**
(anon 404 arm holds); a first-probe read 404'd at t+0 and read fine at t+5 s
(the §2.5.2 settle window, same class as pushes). Cosmetic observation, not
investigated: a dash-heavy page title rendered an `html_url` slug with a
trailing `.-` (`probe22-000df3.-`).

Cleanup proof (API-verified + remote D1): probe/smoke/wiki repos DELETEd →
**204** across the board (smoke repo by the harness); `repositories WHERE
owner_namespace='p0probe'` = **1** (`p0-shallow`, intentionally live);
`reg10%/spot22%/smoke-%/wikiprobe%` = **0**; `repo_redirects` total = **0**
(every rename's redirect row cascaded with its repo); `users LIKE
'p0blocktgt%'` = **0**. Per-run credential: PAT prefix `cfg_0552e6f2` DELETEd
by prefix+user (changes = 1); `personal_access_tokens` joined to p0probe =
**0 rows**; whole-table count = **1** (the standing `admin` bootstrap PAT,
pre-existing). Credential temp files (0600 PAT file + mint stdout/stderr +
probe clones + the worktree's copied `.dev.vars`, all shredded) removed; grep
for the token shape after = no matches.

Environment footnotes (recorded honestly): (1) the local SNI/DNS interference
from the previous window recurred and FLAPPED — `workers.dev` resolved to
non-Cloudflare IPs (`31.13.112.9`, `…face:b00c…`) in three windows
00:02-00:06 UTC; production was unaffected (200s between windows; the deploy
itself landed clean at 00:01) — smoke attempts 1-2 failed on local `fetch
failed` and attempt 3 ran to full pass once three consecutive healthz 200s
confirmed a stable window. (2) One probe-script bug (unquoted space in the
`http.extraHeader` value → git usage exit 129) aborted the first P0 probe
run locally before any request; fixed and re-run — no production effect.
(3) The first wiki list probe used the wrong path (`/wiki` — the endpoint is
`/wiki/pages`, matching upstream); probe bug, not product.

**OPEN ISSUE (carried, narrowed — for the registry-series owner): the
API-delete path still has a nonzero read-after-delete window on a RENAMED
repo's NEW name.** Observed once (repo A): anonymous ls-remote seconds after
the 204 still served all refs; the same lifecycle was clean at t+0 in two
other runs (B engine-path, C API-path under `wrangler tail` with every
registry/cell RPC `outcome:"ok"`), and A's stale entry self-healed via the
queue consumer's backstop purge minutes later. Versus REDEPLOY9 (48 s+
serving): narrowed to a transient, self-healing window. The tombstone
(`markDeleted`) IS awaited before the 204, so a remaining suspect is a stale
read replica on the advert path; suggested next fix: make reads treat a
tombstoned cell as deleted (or double-check D1 existence) so no replica
window can serve. The rename CARRY half and the engine-level DELETE path are
closed in production (A step 5; B step 3).

## Redeploy verification — 2026-10-26 00:34 UTC (08:34 CST), same-deployment-state block (wave-23 series)

Deploy shipped as ONE version: **`8d91c71d-3695-4d5f-a981-74d261c46b53`** (100%,
Created 2026-10-26T00:34:22.354Z), deployed from tree **`fec5c71` CLEAN**, on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`5835d8ab-d65a-4824-a239-7d53c01f8627` (the REDEPLOY10 block's version).
Content shipped (declared **434→447** ops / 275 paths): oauth2-apps (5 ops),
admin badges + repo licenses + template generate (5 ops), activity feeds
(3 ops + the migration-0028 action table wired at the emitter seams), the
blocks-enforcement 403 arms (9 seams, probe-free this run — codes already
recorded in the REDEPLOY10 block), ui-parity-2 pages, and a vitest timeout
bump (no prod effect). Assets rebuilt: **784 files, 13.9 MB** (same pin
`fc4936884584`, identical bundle hashes `index.oLjWPtMl.js` /
`iife.Cpk_pTor.js`).

Deploy-tree methodology (REDEPLOY10's detached-worktree pattern reused):
the shared working tree at GO carried in-flight siblings' uncommitted hunks,
so the deploy ran from a detached **`git worktree add --detach`** at exactly
`fec5c71` — warm `pnpm install --frozen-lockfile` (378 ms), `git submodule
update --init` inside the worktree (same pin `fc4936884584`; the main
checkout's submodule verified pristine after), `pnpm gen:icons` (gitignored
generated file a fresh worktree lacks), the **scratch-dir asset build**
(`build-gitea-assets.mjs --work /tmp/gitea-assets-build-c9pcuh --skip-install`
— warm node_modules, never writes inside `gitea/`) emitted into the worktree's
`public/assets`, and `.dev.vars` copied in. The worktree (including its copied
`.dev.vars`) was removed after the run; the main working tree was never
modified by this agent.

Deploy gates — at `fec5c71` (worktree): `pnpm typecheck` **0 errors** (the
worktree is clean at fec5c71, so the known shared-tree error at
`src/api/routes/repo.ts:612` correctly does NOT appear); `check-openapi`
**PASS** (declared **447** ops/275 paths, tier-1 **78/78 paths, 129/129 ops**);
`check-contract` **PASS** (sha256 `529a3314…`, verbatim match). Vitest run of
record `--maxWorkers=8`: **3053 passed | 5 skipped (3058), 137 files passed +
1 skipped (138), 0 failed**. Adjudication of the first full run (4 fails in 1
file, none a code regression): all four `src/index.test.ts` assertions got
**503 where 404/200 was expected**, and the file reproduced them SOLO — traced
to the FRESH WORKTREE lacking `public/assets`: the UI dispatcher branch runs
before the gate/404-in-shell branches and `pageContext` fails fast with the
documented 503 when the build manifest is absent (`session.ts` §2.3.4,
`AssetBuildError` → `assetsNotBuilt`) — a worktree-setup ORDERING artifact
(REDEPLOY10 copied assets during setup; this run's sequence deferred the asset
build until after vitest). With the built assets in place the full suite ran
green as recorded above; lesson recorded: the asset emit belongs in worktree
setup BEFORE the vitest gate.

Remote migrations immediately before deploy: **0026_sharp_catseye,
0027_first_purple_man, 0028_heavy_cardiac** — all ✅; ledger after: "✅ No
migrations to apply!" (28/28); remote `sqlite_master` verified **`action`,
`badge`, `oauth2_application`, `repo_license`, `user_badge`** plus
**`repositories.is_template`** (pragma count 1). 0026 = oauth2_application +
client_id unique + uid idx; 0027 = badge/repo_license/user_badge + the
is_template column; 0028 = action + its three indexes. No seed rows.

`pnpm smoke` equivalent (deploy-smoke.mjs, fresh mint-per-run PAT via 0600
temp file, `--user p0probe`, with `--migrate-check`): **6 pass / 0 fail /
1 skip** (bench-report not requested), `ok: true`. Verbatim key lines:
`[pass] healthz — {"ok":true}`; `[pass] anon-git-surface —
probe-034e1b59/probe-62fa9c02.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert — advert ok
(165 bytes)`; `[pass] push-lsremote — pushed ce7c506342…, authed ls-remote
sees refs/heads/main, anonymous advert 401 Basic challenge`; `[pass] cleanup —
repo p0probe/smoke-83f384d6 deleted`; `[pass] migrate-check — all 19 expected
tables present (+48 system/aux: … protected_tags, oauth2_application, badge,
repo_license, user_badge, action)` — the wave's five new objects verbatim.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`; results
**unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous API GET answers
**404**, anonymous `info/refs` answers **401 Basic challenge**
(`www-authenticate: Basic realm="Gitea"`), anonymous web page **404**,
re-verified this run (and again after cleanup).

**Registry rename/delete re-probe (3 full lifecycles, all PUBLIC, anonymous
ls-remotes, p0probe-owned; REDEPLOY10's carry-fix re-verified once per
lifecycle).** Every trial: `POST /user/repos` 201 (2.8–3.3 s) → create-advert
poll green (t+4.7–5.3 s, HEAD + refs/heads/main) → `PATCH` rename 200 →
**IMMEDIATE anonymous ls-remote on the NEW name lists ALL refs — THE CARRY
HOLDS in all 3 trials** (e.g. `08fc7d9d…` HEAD + main) → old name post-rename
still serves via the `repo_redirects` redirect (the documented §2.5.3 row-13
divergence) → `DELETE` 204 → old name post-delete **128 not-found** in 2 of 3
trials. **t+0 read-after-delete outcome, honest**: NO trial was clean at
t+0 on the renamed NEW name — the first post-delete poll (~1 s) still served
refs in all three; the new name measured **clean (128) by t+5.4 s (trial b),
t+5.7 s (trial a), t+6.4 s (trial c)** — the same seconds-scale self-healing
residual class REDEPLOY10 narrowed from 48 s+, unchanged in magnitude. Trial
c additionally showed the stale read ONCE on the OLD name (ls-remote exit 0
on the first post-delete probe; the same trial's anon API GET on the new name
was already 404 and both names verified dead by the sweep's end). The tombstone
remains awaited before the 204, so the read-replica suspect from the REDEPLOY10
note stands.

**New-surface spot probes (one pass each, exact codes).** OAuth2 apps:
`POST /user/applications/oauth2` → **201** with `client_secret` appearing
**exactly once** in the body (56-char secret, `client_id`
`b24448f8-4433-48cb-b3bc-75550de4582d`); `GET …/oauth2` list → **200**, secret
**0 occurrences**; `GET …/oauth2/{id}` → **200**, `client_secret` field
rendered **blank**; first `PATCH` attempt without `redirect_uris` → **422
`{"message":"RedirectURIs: Required"}`** (upstream requires the field on
update — correct behavior, probe error); re-created app (id 2), `PATCH` with
`{"name":…,"redirect_uris":[…]}` → **200** with name + uris updated; `DELETE`
→ **204**; `GET` after → **404**. Admin badges (throwaway user created via
`POST /admin/users` → 201; badge DEFINITION seeded via remote D1 — badges are
UI-managed upstream, no creation API): `POST
/admin/users/{u}/badges {"badge_slugs":["probe-badge-reg11"]}` → **204**;
`GET` → **200** `["probe-badge-reg11"]`; `DELETE` → **204**; `GET` after →
**200** `[]`. Activity feeds: repo + issue (#1) + comment created via API (all
201), `GET /repos/p0probe/feedprobe-reg11/activities/feeds` → **200** with
`op_type` rows **`['comment_issue','create_issue','create_repo']`** and
contract-exact row keys `['act_user','act_user_id','comment','comment_id',
'content','created','id','is_private','op_type','ref_name','repo','repo_id',
'user_id']`. Licenses: `GET /repos/{o}/{r}/licenses` → **200 `[]`**
(honest-empty until the detector wave lands); `GET /licenses` (detector
corpus) → **200** with 27 entries. Generate: the happy path was reached only
via a workaround (see open issues) — with the template row's `is_template`
set, `POST /repos/p0probe/tmpl2-reg11/generate
{"name":"gen-reg11d","git_content":true}` from an EMPTY template → **201**
(`full_name":"p0probe/gen-reg11d"`) and the generated repo's git path
answered **exit 0 at t+1 s** (honest empty advert, 0 refs); `git_content`
omitted entirely → **422 `{"message":"must select at least one template
item"}`** (verbatim upstream text, no row created); generate from a
non-empty template → the 500 below.

Cleanup proof (API-verified + remote D1): probe repos DELETEd → **204**
across the board (`feedprobe-reg11`, `tmpl-reg11`, `tmpl2-reg11`,
`gen-reg11d`, and BOTH orphan `creating` rows `gen-reg11`/`gen-reg11b` — the
delete path handled them), plus the 3 stray first-round `admin/reg11{a,b,c}-*`
repos deleted 204; `repositories WHERE owner_namespace='p0probe'` = **1**
(`p0-shallow`, intentionally live); `owner_namespace='admin'` reg11 leftovers
= **0**; `repo_redirects` total = **0**; throwaway badge user purged
(`DELETE /admin/users/p0badgetgt-reg11?purge=true` → **204**; `users LIKE
'p0badgetgt%'` = **0**); `badge` + `user_badge` rows deleted → **0**;
`oauth2_application` = **0**; **15 orphaned `action` rows** (every one
referencing a now-deleted probe repo — see open issue) removed → `action`
total **0**. Per-run credentials: this run minted 3 PATs (2× admin — one
extraction redo, one first-attempt whose stdout was shredded before capture —
and 1× p0probe); all 3 DELETEd by id (changes = 3); `personal_access_tokens`
whole-table count = **1** (the standing `cfg_23077afd` admin bootstrap PAT,
pre-existing) and PATs joined to p0probe = **0 rows**. Credential temp files
(0600 PAT files + mint stdout/stderr + probe clones + reg/oa2/bad/feed/lic/
tmpl/gen response scratch + the worktree's copied `.dev.vars`, all shredded
with the worktree removal); grep for token shapes after = no matches.
`gitea/` submodule pristine; `wrangler deployments list` confirms
`8d91c71d…` the newest at 100%.

Environment footnotes (recorded honestly): (1) this run's registry probes
initially mis-targeted `admin/` — `POST /api/v1/user/repos` creates for the
AUTHENTICATED user, and the run's admin token answered 201 under
`admin/reg11{a,b,c}-…` while the probes watched `p0probe/`; the stray repos
were deleted 204 and the sweep re-run with a p0probe-owned PAT (REDEPLOY10's
registry token was p0probe's — same trap, now written down). (2) The PAT
extraction regex for the `cfg_<8hex>_<32base32>` shape missed (base32
alphabet assumption) and the raw mint output had already been shredded —
re-minted cleanly; the orphaned first token was caught by the final
whole-table PAT audit and deleted. (3) `wrangler` is not resolvable via
`pnpm exec` at the repo root (worker-package dep) — D1/wrangler commands ran
from `apps/worker`.

**OPEN ISSUE 1 (new, for the generate-repo owner): template generate 500s on
the content-copy arm and leaves an orphan `creating` row.**
`POST /repos/{o}/{r}/generate` from a NON-empty template with
`git_content:true` returned **500 `{"message":"internal server error"}`**
deterministically (×2) at production, each attempt AFTER `service.create`
succeeded — both rows (`gen-reg11`, `gen-reg11b`) stranded at
`status='creating'` (both then deleted 204 via the API). `wrangler tail`
attached on a retry shows 8 events, every one `"exceptions":[]`, no
`[repos]` error lines — the failure is application-caught, so the throwing
frame needs code-level debugging; the suspect is the synchronous
`replicateRepoCopy(env, template, fork)` ride in
`api/services/generate-repo.ts` (the fork queue's own async path is the
battle-tested one). The empty-template arm (settle-empty, no copy) 201s, the
template gate and both 422 arms are correct, and the generated repo serves
git immediately — the break is precisely the synchronous copy ride.

**OPEN ISSUE 2 (new, for the repo-edit owner): the PATCH edit handler drops
`template`.** `editRepoOptionSchema` accepts `template` (models/repository.ts)
but the `PATCH /repos/{owner}/{repo}` handler persists only
name/private/default_branch/archived/description/website/has_* — a
`{"template":true}` PATCH answers 200 and silently does NOT write
`repositories.is_template` (verified in remote D1: stayed 0), so upstream's
"mark a repo a template via API" flow is unreachable; this blocks the
generate flow end-to-end via API (this run exercised generate only after a
direct remote-D1 `is_template=1` workaround, disclosed above). Upstream's
updateBasicProperties persists IsTemplate.

**OPEN ISSUE 3 (new, for the activity-feeds owner): repo delete does not mark
`action` rows `is_deleted`.** After the probes' repos were deleted, 15 action
rows lingered with `is_deleted=0` referencing dead repo ids (cleaned by this
run); upstream marks a deleted repo's actions deleted so feeds hide them. The
emitter seams themselves verified correct in production (three op_types,
contract-exact shapes).

**OPEN ISSUE 4 (carried, magnitude re-measured — registry read-after-delete
residual): unchanged in class.** 3/3 API-delete trials on renamed repos
served refs on the first post-delete git probe (~1 s) and healed to 128 by
t+5.4/5.7/6.4 s (plus ONE old-name stale read in trial c). Same
seconds-scale, self-healing, tombstone-awaited-204 window as the REDEPLOY10
note; the suggested fix (treat a tombstoned cell as deleted on the advert
read path, or double-check D1 existence) still stands.

## Redeploy verification — 2026-10-26 02:15–02:55 UTC (10:15–10:55 CST), same-deployment-state block (wave-24/25 series, REDEPLOY12)

Deploy shipped as ONE version: **`f9798804-b916-408e-9249-93ac030a1269`** (100%,
Created 2026-10-26T02:09:37.784Z per `wrangler deployments list`), deployed from
tree **`5ba6183` CLEAN** (detached worktree), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`8d91c71d-3695-4d5f-a981-74d261c46b53` (the REDEPLOY11 block's version).
Content shipped — the tree carries (in order): bb67087+98d194d (avatar-byhash
web seam + mount carve-out), 7f0d5a6 (generate: PATCH template write + copy
retry + failure cleanup), 0b61554 (ui-parity-4: tags + repo labels pages),
528d369 (star/watch counters, migration 0030), fb8a0d1 (invariants fixture
fix — engine red closed), 04a2903 (license repo-edit arm — family complete),
64ade9f (feeds-tail action rows), **45631b7 (settle-is-empty — the coordinator's
GO preference)**, 5ba6183 (schema column-pin first catch-up). Assets rebuilt:
same pin `fc4936884584`, identical bundle hashes `index.oLjWPtMl.js` /
`iife.Cpk_pTor.js`. **Deliberately NOT shipped** (landed after the coordinator's
explicit "deploy 5ba6183 — do NOT hold" confirmation; REDEPLOY13's tree):
3163658 (set-private-zero), 3016c10 (counters-2 num_forks + users.num_stars,
migration 0031), 239a4ac (avatar_default build guards), 69d4927 (avatars docs),
8207da9 (webhooks test reshape), 64e9b1b (delete-counters-fold), e6ccf9c (docs).

Deploy-tree methodology (REDEPLOY10/11 detached-worktree pattern reused;
REDEPLOY11's ordering lesson applied): gates and deploy ran from detached
`git worktree add --detach` at exactly `5ba6183` — warm
`pnpm install --frozen-lockfile`, `git submodule update --init` (pin
`fc4936884584` verified unchanged; main checkout's submodule pristine after),
`pnpm gen:icons`, the **scratch-dir asset build**
(`build-gitea-assets.mjs --work /tmp/gitea-assets-build-rd12b --skip-install`)
emitted into the worktree's `public/assets` **BEFORE the vitest gate** (the
REDEPLOY11 lesson), `.dev.vars` copied in 0600. The worktree (and its copied
`.dev.vars`) was removed after the run; the main working tree was never
modified by this agent.

Deploy gates — at `5ba6183` (worktree): `pnpm typecheck` **0 errors**;
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim match).
Vitest run of record `--maxWorkers=8`: **2904 passed | 5 skipped, 2 failed in
2 files**, plus 17 files orphaned by workerd pool crashes ("Worker exited
unexpectedly") which re-ran SOLO **all green (338 passed | 5 skipped, 0
failed)** — pool instability, not code. The 2 file-level fails, adjudicated:

1. `src/db/schema.test.ts` — `repositories fork_parent parity` — **test-side
   second-order staleness, code correct**: 5ba6183 caught the column LIST up
   to 0029/0030 (size_kb/num_stars/num_watches appended) but the three
   `dflt_value` assertions below still assume the old tail
   (`expected '0' to be 'false'` — the new columns are `DEFAULT 0 NOT NULL`
   per the landed migrations). Coordinator is fixing (their own commit).
2. `src/services/webhooks-push.test.ts` — "a deleted ref emits the delete
   event" — **RESOLVED-NOT-A-BUG (coordinator verdict, 8207da9)**. This run
   bisected it deterministically (green at `e30660d`, `04a2903`, `64ade9f`;
   red at `45631b7`, `5ba6183` — first-bad **45631b7**), which was the
   diagnostic record the fix wave used. Mechanism (upstream-correct): after
   the settle generalization the first-pushed branch IS the default
   (push.go:255-270 pushNewBranch); deleting the default branch is refused
   by pre-receive with upstream's byte-identical text
   (hook_pre_receive.go:143), the engine reports all-ng at HTTP 200, and
   onPush legitimately never fires. The test scenario had become
   upstream-invalid; reshaped + interaction pinned at 8207da9 (19/19 + 93/93).

**Invariants: GREEN at the deploy tree** (fb8a0d1's fixture fix verified in
this run's solo gate too) — the stop condition from the brief was clear.

Remote migrations immediately before deploy (both applied from the worktree at
the deploy tree): **0029_square_banshee** (`repositories.size_kb integer
DEFAULT 0 NOT NULL`) and **0030_curly_gressill** (`num_stars`/`num_watches`,
same shape) — both ✅; ledger after: "✅ No migrations to apply!" (30/30);
remote `pragma_table_info` verified **`size_kb`, `num_stars`, `num_watches`**
present. No seed rows (the single pre-existing repo row p0-shallow carries the
DEFAULT 0s). 0031 (num_forks wave) intentionally NOT applied — its commit
ships with REDEPLOY13.

`pnpm smoke` equivalent (deploy-smoke.mjs, fresh mint-per-run PAT via 0600
temp file — 2 PATs this run, admin + p0probe, both DELETEd by prefix after —
`--user p0probe`, with `--migrate-check`): **6 pass / 0 fail / 1 skip**
(bench-report not requested), `ok: true`. Verbatim key lines:
`[pass] healthz — {"ok":true}`; `[pass] anon-git-surface —
probe-9665b85d/probe-46143794.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert — advert ok
(165 bytes)`; `[pass] push-lsremote — pushed 91010d58c6…, authed ls-remote
sees refs/heads/main, anonymous advert 401 Basic challenge`; `[pass] cleanup —
repo p0probe/smoke-0899ceae deleted`; `[pass] migrate-check — all 19 expected
tables present (+48 system/aux: … oauth2_application, badge, repo_license,
user_badge, action)`.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`;
results **unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1`; `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous API GET **404**,
anonymous `info/refs` **401 Basic challenge** (`www-authenticate: Basic
realm="Gitea"`), anonymous web page **404** — re-verified this run and again
after cleanup.

**Tombstone t+0 production proof (HEADLINE — the e30660d oracle's first
production verification; 3 full lifecycles, all PUBLIC, anonymous ls-remotes,
p0probe-owned).** Per trial: `POST /user/repos` 201 (t+3.2–3.6 s) →
create-settle poll GREEN on poll 1 (2.5–3.4 s later; HEAD +
refs/heads/main) → `PATCH` rename 200 → immediate anonymous ls-remote on the
NEW name lists ALL refs — **THE CARRY HOLDS in 3/3** (identical tip
`c27f540f…`/`992ff7cb…`/`43c72717…`) — this read deliberately seeds the
engine's per-isolate infoMemo (the production-user pattern: a read seconds
before delete) → `DELETE` 204 (t+10.9–12.2 s) → **THE VERY NEXT anonymous
ls-remote on the renamed name answers 128 `remote: repository not found` in
3/3 trials — T+0 CLEAN IN ALL THREE, no sleep** (trial 1 verdict at t+14.2 s
overall / 2.1 s after the DELETE; trial 2 at t+13.4 s; trial 3 at t+14.1 s;
verbatim stderr `remote: repository not found: p0probe/tomb-rd12-rX-…-r`).
Old (pre-rename) name post-delete: anonymous ls-remote **128** and anonymous
API GET **404 `{"message":"not found"}`** in 3/3. **The REDEPLOY10/11
5.4–6.4 s self-healing read-after-delete window is CLOSED in production.**
Probe-script footnote (disclosed): this run's first trial batch (3 repos
`tomb-rd12-{a,b,c}-…`) was wasted by the probe script itself — the
ls-remote URLs omitted the `/p0probe/` owner segment so settle-polls 404'd
forever; all three rows verified `ready` in D1 and were DELETEd 204 via the
API; the corrected batch above is the record. (The evidence summary line
`"create":204` in the probe stdout is a cosmetic script bug reporting the
last response; the step lines carry create 201 / delete 204.)

**Wave-24/25 spot probes (production, one pass each, exact codes).**
Generate-fix: `PATCH /repos/p0probe/tmpl-rd12-… {"template":true}` → **200
with `template:true` IN THE RESPONSE BODY**, and `GET` confirms **persisted**
— REDEPLOY11's OPEN ISSUE 2 (silent drop of `template`) is FIXED in
production. `POST /repos/{o}/{r}/generate {"name":…,"git_content":true}`
from the NON-EMPTY template → **STILL 500** `{"message":"internal server
error"}` (×2 + one tail-attached retry); `wrangler tail` captured the verbatim
application error: `(error) [repos] generate c21de3ee…: content copy failed,
retrying once: finalizeForkImport: object not imported: 02f68bc4ca0e…
(refs/heads/main)` then `api: unhandled error … Error: finalizeForkImport:
object not imported: 02f68bc4ca0e… (refs/heads/main)` — the copy arm's
finalize finds the tip object absent from the adopted packs
(`beginForkImport → listCatalogPage → adoptForkPacks → listRefs →
finalizeForkImport`, ×2 for the retry). The 7f0d5a6 HALF of the fix IS
visible: the tail shows `markDeleted`/`destroy` after the failure and remote
D1 has **0 stranded `status='creating'` rows** (REDEPLOY11's baseline
stranded 2). Counters (528d369): admin `PUT /user/starred/p0probe/cnt-rd12-…`
→ 204, repo payload `stars_count` **0→1**; p0probe `PUT /user/blocks/admin`
→ 204, `stars_count` **1→0** (block cascade); undo (unblock 204 + unstar
204) → 0; watch arm: admin `PUT …/subscription` → 200, `watchers_count`
**0→1**, `DELETE` → 204, **→0**. Avatar-byhash (bb67087+98d194d): `POST
/user/avatar` (1×1 PNG base64) → **204**; `GET /avatars/u_4` → **200
image/png** (the stored object); `GET /avatar/<sha256(email)>` → **303 →
`/assets/img/avatar_default.png`** (the frozen-settings chain — no
`email_hash` table ⇒ email "" ⇒ DefaultAvatarLink); `GET /avatars/<unknown>`
→ **200 image/png** (the bundled fallback PNG arm, 604 bytes); `GET
/user/avatar/p0probe/96` → **303 → `/avatars/u_4?size=96`**;
`DELETE /user/avatar` → 204, after which `/avatars/u_4` serves the fallback
PNG again. UI pages (0b61554): authenticated `GET /{owner}/{repo}/tags` →
**200** with the `small-menu-items` menu + `/releases` link shells (tag rows
absent on a 0-tag repo — correct), `GET /{owner}/{repo}/labels` → **200**
with the `issue-list-navbar` + `small-menu` shells; honest observation: the
writer's "New Label" form did NOT render for the repo owner in production
(unit goldens cover it with a seeded writer grant — flagging for the
ui-parity-4 owner to confirm the production grant arm, low severity: page +
API label CRUD both fine). Registry regression sweep: covered by the 3
tombstone lifecycles above (create→rename carry→delete t+0 all green).

Cleanup proof (API-verified + remote D1): probe repos DELETEd → **204**
across the board (3 broken-trial `tomb-rd12-{a,b,c}`, `tmpl-rd12-…`,
`cnt-rd12-…`, `uir-rd12-…`, `uidom-rd12`, `uidom2-rd12`; the corrected tomb
trials self-cleaned through their own DELETE step) — `repositories WHERE
owner_namespace='p0probe'` = **1** (`p0-shallow`, intentionally live);
`status='creating'` whole-table = **0**; `repo_redirects` = **0**; `stars` =
**0**; `user_blocking` = **0**; **21 `action` rows** (15 op_type=1 create_repo
+ 6 op_type=2 — every one a this-run probe event on now-deleted repos, the
same lingering class as REDEPLOY11's OPEN ISSUE 3) removed → `action` total
**0**. Per-run credentials: 2 PATs minted (admin id 28, p0probe id 29; raw
mint stdout shredded before capture, 0600 token files); both DELETEd by
prefix (`changes = 2`); `personal_access_tokens` whole-table = **1** (the
standing `cfg_23077afd` admin bootstrap PAT, pre-existing). Probe scripts,
token files, tail logs, and scratch outputs all shredded with the worktree
and scratch-dir removal (`/tmp/rd12-*` verified gone). `gitea/` submodule
pristine (0 dirty files, pin `fc4936884584`); `wrangler deployments list`
confirms `f9798804…` at 100%.

**OPEN ISSUE 1 (carried, updated — generate 500 on the content-copy arm,
now with the verbatim producer): unchanged in class, cleaner failure.**
Non-empty-template generate still 500s (see the tail capture above —
`finalizeForkImport: object not imported: <tip> (refs/heads/main)`, retry
exhausted, caught by the handler as an unhandled-error 500). The
cleanupRepository half of 7f0d5a6 works (no stranded rows, `markDeleted` in
the trace); the copy ride itself still cannot see the template's tip object
through `adoptForkPacks`/`listCatalogPage` — suspect the API-created
template's pack lands under a staged/upload key the fork-import catalog
doesn't adopt, vs push-created packs. Owner: generate-repo/queue; the fork
queue's own async path remains the battle-tested alternative.

**OPEN ISSUE 2 (carried from REDEPLOY11 — activity feeds): repo delete does
not mark `action` rows `is_deleted`**; this run again had to sweep 21 probe
rows by hand. Upstream marks a deleted repo's actions deleted so feeds hide
them; the delete-cascade counters fold (64e9b1b, REDEPLOY13's tree) is the
natural place to land it.

**OPEN ISSUE 3 (new, low — ui-parity-4): the labels page's writer "New Label"
form did not render for the repo owner in production** (page 200, shells
correct, form absent). Unit goldens pass with a seeded writer grant, so the
production grant-detection arm is the suspect. Confirm + fix or close as
working-as-intended.

**RESOLVED this deployment (for the record):** (a) tombstone read-after-delete
window — CLOSED (headline, 3/3 t+0); (b) PATCH drops `template` — FIXED
(200 + persists); (c) generate strands `creating` rows — FIXED (0 stranded);
(d) invariants engine red — fixture-side, closed at fb8a0d1; (e) webhooks
delete-event "regression" — RESOLVED-NOT-A-BUG (upstream default-branch
protection; test reshaped at 8207da9); (f) schema.test column pin — caught up
at 5ba6183, `dflt_value` assertions finishing with the coordinator (REDEPLOY13).

## Redeploy verification — 2026-10-26 04:00–05:10 UTC (12:00–13:10 CST), same-deployment-state block (REDEPLOY13)

Deploy shipped as ONE version: **`64bee4f6-ccba-4f88-bf24-d0d26134dea4`** (100%,
Created 2026-10-26T04:25:43.886Z per `wrangler deployments list`), deployed from
tree **`e4ebb9d` CLEAN** (detached worktree), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`f9798804-b916-408e-9249-93ac030a1269` (the REDEPLOY12 block's version).
Content shipped — the post-REDEPLOY12 mass, in order: 6c54c1a (generate/fork
loose-carry fix), b332e14 (push-mirror outbound, migration 0032), 389da18
(repo delete sweeps action rows), 9bda9eb (push-sync orchestrator wiring),
faca961/66f5977 (merge-delete guards), 7c7b683 (owner-labels goldens),
79ef809 (diffpatch downloads), e4ebb9d (vitest contention config — no prod
effect), plus the counters/doc/spec units between. Assets rebuilt: same pin
`fc4936884584`, identical bundle hashes `index.oLjWPtMl.js` / `iife.Cpk_pTor.js`.

Deploy-tree methodology (REDEPLOY10/11/12 detached-worktree pattern reused):
gates and deploy ran from detached `git worktree add --detach` at exactly
`e4ebb9d` — warm `pnpm install --frozen-lockfile`, `git submodule update
--init` (pin `fc4936884584` verified unchanged), `pnpm gen:icons`, the
**scratch-dir asset build** (`build-gitea-assets.mjs --work
/tmp/gitea-assets-build-rd13 --skip-install`) emitted into the worktree's
`public/assets` BEFORE the vitest gate, `.dev.vars` copied in 0600. The
worktree (and its copied `.dev.vars`) was removed after the run; the main
working tree was never modified by this agent. The three re-run units'
uncommitted hunks in the main tree were never touched.

Deploy gates — at `e4ebb9d` (worktree): `pnpm typecheck` **0 errors**;
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim
match). Vitest — the new 30 s/8-worker config (e4ebb9d) ran as configured but
the shared tree was under heavy sibling load (three re-run units in flight);
two full runs: run 1 **3044 passed | 5 skipped, 1 failed** + 15 files orphaned
by workerd pool crashes; run 2 **2910 passed | 5 skipped, 2 failed** + 17
orphaned. Adjudication — every red/orphaned file re-ran SOLO **all green:
18 files, 464/464 passed, 0 failed** (`invariants.test.ts` 17/17 in 7.1 s
solo vs its 30 s timeouts under load; the crash sets differed run-to-run —
pool instability, not code, the same class REDEPLOY12 adjudicated).

Remote migrations immediately before deploy (both applied from the worktree at
the deploy tree): **0031_conscious_snowbird** (`repositories.num_forks integer
DEFAULT 0 NOT NULL`) and **0032_wealthy_siren** (`push_mirrors.sync_state` /
`next_sync_at` / `last_error`) — both ✅. Ledger after: "✅ No migrations to
apply!" — **33/33** (the tree carries 33 migration files; the brief's "32/32"
undercounted by one — 0030 was already live, so this run added exactly 0031+
0032). Remote `pragma_table_info` verified: `repositories` carries
`size_kb, num_stars, num_watches, num_forks`; `push_mirrors` carries
`last_error, sync_state, next_sync_at`.

`pnpm smoke` equivalent (deploy-smoke.mjs, fresh mint-per-run PAT via 0600
temp file — 2 PATs this run, admin id 30 + p0probe id 31, raw mint stdout
shredded before capture; both DELETEd by id after, `changes: 2`,
`personal_access_tokens` back to 1 = the standing admin bootstrap PAT):
first run with `--migrate-check`: **5 pass / 0 fail / 1 skip** (bench-report
not requested), `"ok": true`. Verbatim key lines: `[pass] healthz —
{"ok":true}`; `[pass] anon-git-surface — probe-e23cd7aa/probe-22471cb0.git:
git-upload-pack 404 not-found, git-receive-pack 401 Basic challenge`;
`[pass] receive-advert — advert ok (165 bytes)`; `[pass] push-lsremote —
pushed 94ceb16775…, authed ls-remote sees refs/heads/main, anonymous advert
401 Basic challenge`; `[pass] cleanup — repo p0probe/smoke-7b094ce5 deleted`;
`[pass] migrate-check — all 19 expected tables present (+48 system/aux: …
oauth2_application, badge, repo_license, user_badge, action, push_mirrors)`.
A second smoke run (same PAT, no migrate-check) re-verified 4 pass / 0 fail.

P0 probes re-run against THIS deployment (auth via `http.extraHeader`;
results **unchanged** vs all prior tables):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1` (identical tip); `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous API GET **404**,
anonymous `info/refs` **401 Basic challenge** (`www-authenticate: Basic
realm="Gitea"`), anonymous web page **404** — re-verified again after cleanup.

**Generate re-probe (HEADLINE — 6c54c1a's production verification; REDEPLOY12's
500 is closed at the API layer).** `POST /user/repos` 201 (tmpl-rd13-13937,
auto_init) → REAL PUSH content (LICENSE commit on main via git push, second
ref `refs/heads/dev`; ls-remote shows both refs at tip `cf90b4a2d35f…`) →
`PATCH {"template":true}` → **200 with `"template":true` in the body** →
`POST /repos/p0probe/tmpl-rd13-13937/generate {"name":"gen-rd13-13937",
"git_content":true}` → **201** with `"empty":false` IN THE RESPONSE BODY
(REDEPLOY12: 500 `finalizeForkImport: object not imported`) → follow-up GET
`"empty":false` → generated repo ls-remote lists `refs/heads/main` +
`refs/heads/dev` at the **identical tip `cf90b4a2d35f…`** → contents API on
the generated repo **200**: LICENSE (43 B, base64 content decodes verbatim) +
README.md, `last_commit_sha` = the carried tip → remote D1:
`status='creating'` whole-table **0** (the cleanup half stays clean); the
generated row itself `ready / is_empty=0 / is_template=0`. **But one honest
residual (NEW ISSUE, below): git fetch against the generated repo 500s and
git push is refused `missing necessary objects` — the carried cell serves
API reads but not yet the git wire for the carried objects.**

**Push-mirror lifecycle probe (b332e14+9bda9eb production verification; full
e2e to a real external remote stays OUT of probe scope — no external
credentials).** `POST push_mirrors` with `remote_address=
https://127.0.0.1:9/dummy-unreachable.git` → **401 "Permission denied"** —
the registration-time egress screen refusing the loopback target at the door
(SSRF gate working as designed; lax/strict `MIRROR_ALLOWED_HOST_LIST`). The
gate-passing unreachable URL `https://p0mirror-dummy.invalid/dummy-unreachable.git`
→ **200** (`remote_name=remote_mirror_tM4k0U0hpL`, `last_error=""`,
`last_update=null`, `interval=8h0m0s`, `sync_on_commit=false`) → `POST
push_mirrors-sync` → **200** → first API poll (~3 s): the consumer ATTEMPTED
it, `last_error` = **"mirror target responded 530 for info/refs advertisement
[https://p0mirror-dummy.invalid/dummy-unreachable.git/info/refs?service=
git-receive-pack]"** (verbatim, full URL). Remote D1 after:
`sync_state='idle'` (back from syncing, no stuck state), `next_sync_at=0`.
`DELETE push_mirrors/{name}` → 204; `push_mirrors` table back to 0 rows.

**Merge-guard spot (faca961/66f5977).** Repo mg-rd13-12369, branches
`keeper` + `plain`, PRs 1 and 2 → main. `keeper` protected via POST
branch_protections (201). Merge both with `{"do":"merge",
"delete_branch_after_merge":true}` (first attempt with upstream's `"Do"` key
422'd `invalid request body` — this schema takes lowercase `do`; probe-side
fault, disclosed): protected `keeper` → **merge 200, branch still exists
(200 after)** — the protected-branch arm skips the delete; unprotected
`plain` → **merge 200, branch deleted (404 after)** — the normal
delete-after-merge arm still fires. Exactly the upstream skip-not-error
differential, both merges 200.

**Diffpatch spot (79ef809, web surface).** On the merge commit
`3ef545bcab…` of mg-rd13-12369: `GET /p0probe/mg-rd13-12369/commit/{sha}.diff`
→ **200 `text/plain; charset=utf-8`**, raw git diff body (`diff --git
a/plain.txt …`, no mail header); `GET …commit/{sha}.patch` → **200
`text/plain; charset=utf-8`** with the mail-format header (`From 3ef545bcab…
Mon Sep 17 00:00:00 2001` / `From:` / `Date:` / `Subject: [PATCH]`). Commit
arms byte-shaped per upstream (mail-format-no-signature).

**UI labels owner view — LOGIN-COOKIE methodology (b5facba's lesson applied;
REDEPLOY12's OPEN ISSUE 3 is CLOSED).** Anonymous `GET
/p0probe/tmpl-rd13-13937/labels` → 200 with **0** "New Label" occurrences
(the anonymous render — what a PAT header measures). `POST /login`
(form-urlencoded `user_name=p0probe` + `password=<PAT>`) → **303** +
`gitea_session` cookie. Labels page with the cookie → **200 with 3 "New
Label" occurrences** + `small-menu-items` — the writer-gate owner arm DOES
render in production; REDEPLOY12's observation was the methodology artifact
(the PAT header never logged the session in).

Cleanup proof (API-verified + remote D1): the push mirror DELETEd (204) then
all five probe repos DELETEd → **204** across the board (tmpl-rd13-28599 —
the first aborted script's orphan, tmpl-rd13-13937, gen-rd13-13937 — one
transient curl 000 retried to 204, mirror-rd13-14106, mg-rd13-12369); the
smoke repos self-cleaned through their own DELETE steps.
`repositories WHERE owner_namespace='p0probe'` = **1** (`p0-shallow`,
intentionally live); `status='creating'` whole-table = **0**; **`action`
total = 0 with NO manual sweep this run** — 389da18's repo-delete action
sweep performed in production exactly as landed (REDEPLOY12 needed a
hand-sweep of 21 rows; the open issue is closed); `stars` = **0**;
`push_mirrors` = **0**; `protected_branches` = **0**. Per-run credentials:
2 PATs minted (admin id 30, p0probe id 31; raw mint stdout shredded before
capture, 0600 token files); both DELETEd by id (`changes: 2`);
`personal_access_tokens` whole-table = **1** (the standing `cfg_23077afd`
admin bootstrap PAT, pre-existing). Probe scripts, token files, cookie jars,
tail logs, clone/scratch dirs all shredded (`/tmp/rd13-*` verified gone;
`/tmp/gitea-assets-build-rd13` removed); worktree removed with its copied
`.dev.vars`. `gitea/` submodule pristine (0 dirty files, pin `fc4936884584`);
`wrangler deployments list` confirms `64bee4f6…` at 100%.

**OPEN ISSUE 1 (carried, RE-SCOPED — generate carries refs + API-readable
objects, but the generated cell is not yet git-wire usable).** The 6c54c1a
fix closed REDEPLOY12's 500 at the copy layer (201 + empty:false + both refs
carried at identical tips + 0 stranded rows — all verified above), and the
generated repo's contents API serves the complete closure (LICENSE blob
readable, `last_commit_sha` = the carried tip). But against the GENERATED
repo only: `git clone` (full or `--depth=1`) fails at the upload-pack fetch
command with **HTTP 500** (info/refs 200, ls-refs 200 — the fetch POST 500s,
`wrangler tail` shows outcome ok, NO logs, NO exceptions — a silent
app-level 500 in the DO's uploadPack walk), and `git push` to it is refused
**`! [remote rejected] … (missing necessary objects)`** (the receive-side
connectivity check finds advertised-but-unreadable objects). The TEMPLATE
repo with the identical logical content (auto_init loose + pushed pack)
clones and pushes fine, so the delta is the carry/adoption layout in the
generated cell (adoptForkPacks' adopted packs + carryLooseObjects'
putApiObjects-written loose class) vs what the pack-walk and the receive
connectivity check can read. Owner: repos/fork-task + engine read path.
REDEPLOY12's ISSUE 2 note (push-mirror full e2e needs external credentials)
remains probe-scope-excluded, not an issue.

**RESOLVED this deployment (for the record):** (a) generate 500 on
non-empty-template copy — FIXED at the API layer (201 headline above);
(b) labels "New Label" form absent for the owner in production —
METHODOLOGY artifact, form renders via session login (closed);
(c) repo delete leaves `action` rows for feeds — FIXED (389da18's sweep
validated in production: 0 rows after 5 deletes, no hand-sweep);
(d) push-mirror outbound — LIVE end-to-end through the queue consumer with
verbatim failure recording and clean state transitions.

*(REDEPLOY13, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## Redeploy verification — 2026-10-26 06:05–06:50 UTC (14:05–14:50 CST), same-deployment-state block (REDEPLOY14)

Deploy shipped as ONE version: **`1c834f20-41bb-45f4-8a4a-2e1aaa62d6e6`** (100%,
Created 2026-10-26T06:05:35.847Z per `wrangler deployments list`), deployed from
tree **`8828f43` CLEAN** (detached worktree), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`64bee4f6-ccba-4f88-bf24-d0d26134dea4` (the REDEPLOY13 block's version).
Content shipped — the post-REDEPLOY13 mass, `e4ebb9d..8828f43` in order:
2e3db28 (fork-head after-merge delete ladder), 3169e33 (invariants fixture
diet), ff4172a+aff64a6 (ws1009 research draft, then the built N=2 minimal
repro — mechanism: the fetchWarmModules SNAPSHOT frame, 32 MiB cap measured),
5d9122c+18dd272 (docs: miniflare beta pin hold; compat docs ticked 490/554),
bf8e56f (REDEPLOY13 evidence), 1b41b60 (ui-parity-6 archive download + commit
aux JSON), b74b2d2 (release-notes addendum), ab5d300 (annotated-tag carry,
packed-aware partition + the rename packed-tag drop fix), 889b74a (archive ref
convergence), 8b0ce41 (**the ws1009 contract-import mitigation — 17 runner
deaths → 0**), a16f60e (fork PR creation end-to-end), 9f6b86a/eeb8270/aa95c90
(SPEC/docs), 0466356 (PR head repo render, hidden-head gate port),
945a47d (forks header), cc196d3 (pull-engine follow-ups — carryLooseRefs at
both carry sites; last direct contract import converted; fork-head tests on
the real POST /pulls path), 48101dc (ui-parity-7 — tags delete write +
/tags/list aux + releases edit/delete tail), 4588475 (identity rig),
836f87a (pull payload mode — ToPayloadPullRequest), **8828f43 (THE GO commit:
generate/fork git-wire — replicateRepoCopy brokers §5.3 itself: paged copy →
UNCONDITIONAL loose carry with budgeted packed-commit descent ≤64 →
finalize; the thin-pack + loose-base interior that upload-pack 500'd)**.
Assets rebuilt: same pin `fc4936884584`, identical bundle hashes
`index.oLjWPtMl.js` / `iife.Cpk_pTor.js`.

Deploy-tree methodology (REDEPLOY10–13 detached-worktree pattern reused): the
coordinator's GO named `8828f43`; the worktree was created at exactly that
commit at the re-gate moment (the tree at re-gate IS the deploy tree; no
later commits were folded). Gates and deploy ran from detached `git worktree
add --detach /tmp/rd14-go 8828f43` — warm `pnpm install --frozen-lockfile`,
`git submodule update --init` (pin `fc4936884584` verified unchanged),
`pnpm gen:icons`, the **scratch-dir asset build** (`build-gitea-assets.mjs
--work /tmp/gitea-assets-build-rd14go --skip-install`) emitted into the
worktree's `public/assets` BEFORE the vitest gate, `.dev.vars` copied in 0600.
A pre-GO full gate run also executed at the then-HEAD `945a47d` in a separate
worktree (same recipe) per the brief's "start gates NOW" protocol. Both
worktrees (and their copied `.dev.vars`) were removed after the run; the main
working tree was never modified by this agent; the sibling waves' uncommitted
hunks were never touched.

Deploy gates — at `8828f43` (worktree): `pnpm typecheck` **0 errors**;
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim
match). Vitest run of record: **3413 passed | 1 failed | 5 skipped (3419) in
173.27 s**, files 157 passed | 1 failed | 1 skipped (159).
**`Worker exited unexpectedly` attributions: 0 — the ws1009 crash class is
gone in production-config full-suite runs** (REDEPLOY13: 15–17 orphaned
files per run; this run: none, no solo re-runs needed for crashes). The ONE
failure, adjudicated: `src/api/pull-engine.test.ts > merge
delete_branch_after_merge — the fork-head arms > deletes the FORK's head
branch after the merge` — **30 s timeout under suite load (30004 ms), not
code**: the same file re-ran SOLO **25/25 green, 0 runner deaths** minutes
later; its three sibling fork-head arms passed in-run (22.7 s / 3.6 s /
3.3 s). Pre-GO HEAD gates at `945a47d`: typecheck 0, check:api PASS 490/298
(78/78+129/129), contract sha verbatim, vitest **3386 passed | 5 skipped,
0 failed, 0 runner deaths** (156 files green; the 1 skipped file is
`src/bench-d1.test.ts`, by design).

Remote migrations immediately before deploy: **ledger unchanged — 33 files in
the tree, "✅ No migrations to apply!" (33/33)**; no wave added one (0031/
0032 already remote from REDEPLOY13).

`pnpm smoke` equivalent (deploy-smoke.mjs, --migrate-check, fresh mint-per-run
PATs — 2 this run, admin id 32 + p0probe id 33, raw mint stdout shredded
before capture, 0600 token files; both DELETEd by id after): **6 pass /
0 fail / 1 skip, `ok: true`** (run twice; the second with `--json` for the
record). Verbatim key lines: `[pass] healthz — {"ok":true}`;
`[pass] anon-git-surface — probe-9aa25ee7/probe-23e16a37.git: git-upload-pack
404 not-found, git-receive-pack 401 Basic challenge`; `[pass] receive-advert —
advert ok (165 bytes)`; `[pass] push-lsremote — pushed e1d1f1d647…, authed
ls-remote sees refs/heads/main, anonymous advert 401 Basic challenge`;
`[pass] cleanup — repo p0probe/smoke-ed403e14 deleted`; `[pass]
migrate-check — all 19 expected tables present (+48 system/aux: …
push_mirrors)`; bench-report skip (not requested).

P0 probes re-run against THIS deployment (auth via `http.extraheader`; results
**unchanged** vs all prior tables; disclosed probe fault: the first trio
attempt ran UNAUTHENTICATED and exited 128 at the auth layer — re-run authed
is the record):

| # | Probe | Exit | Outcome |
|---|---|---|---|
| 1 | `git clone --shallow-since="2026-10-20 00:00:00 +0000" …/p0probe/p0-shallow.git` | **128** | no repo dir; `upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)` |
| 2 | `git clone --shallow-exclude=old-base …/p0probe/p0-shallow.git` | **128** | no repo dir; same shape naming `'deepen-not'` |
| 3 | `git clone --depth=1 …/p0probe/p0-shallow.git` | **0** | `.git/shallow` = `502abd2d5561536873088528a9f57f02cd1633e1` (identical tip); `log --oneline | wc -l` = 1; `rev-parse --is-shallow-repository` = `true`; `fsck` clean |

`p0probe/p0-shallow` remains live intentionally; anonymous API GET **404**,
anonymous `info/refs` **401 Basic challenge** (`www-authenticate: Basic
realm="Gitea"`), anonymous web page **404** — re-verified after cleanup.

**Generate git-wire probe (HEADLINE — 8828f43's production verification;
REDEPLOY13's re-scoped OPEN ISSUE 1 is CLOSED, both halves).** Template
`tmpl-rd14-140939`: `POST /user/repos` 201 (auto_init) → REAL PUSH content
(LICENSE on main, second branch `dev`; ls-remote shows both refs, main tip
`fce5f30ca7d6…`) → `PATCH {"template":true}` → **200, `"template":true` in
the body** → `POST /repos/p0probe/tmpl-rd14-140939/generate
{"name":"gen-rd14-140939","git_content":true}` → **201**, follow-up GET
`"empty":false`. Then: **anonymous `git clone` of the GENERATED repo → exit
0** (REDEPLOY13: HTTP 500 on the fetch command) — 2 commits, tip
`fce5f30ca7d6…` IDENTICAL to the template's, LICENSE+README present.
**Anonymous `git clone` of an admin FORK of the template → exit 0** — 2
commits, same identical tip (the first clone attempt raced the async fork
queue at poll 1 and got an empty cell — probe timing, disclosed; after refs
appear the clone is byte-correct). **`PATCH` rename to `gen2-rd14-140939` →
200 → anonymous clone of the RENAMED repo → exit 0** (2 commits) — and the
**authed push-back to the renamed generated repo → exit 0**: a new commit on
main landed, remote `refs/heads/main` = local new tip `754d59ea76ee…`
(REDEPLOY13: push refused `missing necessary objects`). The generated cell is
fully git-wire usable: clone serves the full carried history and receive
accepts new work.

**Fork PR end-to-end (a16f60e + 0466356 + 836f87a + 2e3db28, production
product-path).** Base `p0probe/bp-rd14-140939` (public, auto_init, main tip
`b0330573410c…`); fork to admin → **202** async → row `ready` with the D1
edge verified (`fork_parent` = the base id, base `num_forks`=1; note: the
repo PAYLOAD still renders the stub `fork:false, parent:null` — the known
`TODO(SPEC-0005)` serializer stub, the edge itself is live). Divergent push
to the fork's branch → `POST /repos/p0probe/bp-rd14-140939/pulls` with head
`admin/bpfork-rd14-140939:feat3` (the `owner/name:branch` form) → **201**,
`merge_base` = `b0330573410c…` persisted (computed IN the head cell); first
GET `mergeable:null` (checking) → second GET **`mergeable:true`** (the lazy
base-cell check CAS-writes Mergeable). **Head repo render**: authed GET
renders `head.repo` = the fork (66 keys, `full_name:
admin/bpfork-rd14-140939`, `head.sha` = the fork-side tip, `head.ref =
refs/pull/2/head`); anonymous GET with the fork PUBLIC renders `head.repo`
fully; **flip the fork private → anonymous GET renders `head.repo` null with
`head.repo_id: -1`** — the 0466356 hidden-head sentinel verbatim — while the
authed GET still renders. **Merge → 200** (state closed, merged true,
`merge_commit_sha` `02fcf5cb88eb…`, base main advanced to it). **The
2e3db28 ladder**: a second fork PR merged with
`{"do":"merge","delete_branch_after_merge":true}` → **200 and the fork's
head branch answers 404 after, the fork's `main` survives (200)**. Disclosed
probe faults, product-correct outcomes: (a) my first fork clone raced the
async copy and the branch I pushed was a ROOT commit (no shared history) —
that PR got `merge_base:null`, status Empty(5), `mergeable:false`, and merge
refused **405 `{"message":"Please try again later"}`** — the upstream posture
for a non-mergeable PR, re-proved correct with a properly-parented branch;
(b) the bare `owner:branch` form with a RENAMED fork answers 404 — the
documented in-code divergence (upstream searches the fork edge and answers
400 "does not have a fork"; ours resolves `owner/<base-slug>` by path, which
coincides only for default-named forks; `owner/name:branch` is the exact
production path).

**Annotated-tag carry via fork (ab5d300's production verification; the
materialized-oid divergence is expected and observed).** `POST
/repos/p0probe/tmpl-rd14-140939/tags {"tag_name":"v1-rd14","message":…}`
→ **200** (upstream answers 201 — minor, untracked), annotated object oid
`383765e6cb92…` peeling to `fce5f30ca7d6…`; tag GET renders `message:""`
per the documented toAnnotatedTag deviation. A fork created AFTER the tag
(a first fork 409'd — upstream's one-fork-per-(owner,repo) rule; the stale
pre-tag fork was deleted 204 first) lists **`v1-rd14` with the IDENTICAL
peel `fce5f30ca7d6…`** and a **different tag oid `5c5440a072ea…`** —
exactly the SPEC-0001b §5.3 record: name+peel must match (they do), oid may
differ (it does, re-materialized).

**Tags/releases UI spot — LOGIN-COOKIE methodology (ui-parity-7's production
verification).** `POST /login` (form creds) → 303 + `gitea_session`. Tags
page WITH cookie → **200**: the `v1-rd14` row, the
`action="…/tags/delete"` delete form (the ui-parity-7 delete write), the
`releases/new?tag=v1-rd14` link; ANONYMOUS → **200 with 0 delete forms**
(differential `tags/delete`: owner 1, anon 0). **Release created via the
WEB arm**: `POST …/releases/new` (form post) → **303**, then `GET
/api/v1/releases` lists it (`tag_name v1-rd14`, name, draft:false) — and
see NEW ISSUE 1: the API create arm refuses the same write. Releases LIST
with cookie → 200 with the row + the edit pencil
(`/releases/edit/v1-rd14`); the EDIT page renders the edit form AND the
**`formaction="…/releases/delete"` formmethod=post delete button** (name=id)
— the ui-parity-7 tail verbatim. Anonymous releases page: row readable,
0 edit, 0 delete.

**Registry sweep (one lifecycle).** `POST /user/repos` 201 (t+4.1 s) →
create-settle GREEN on poll 1 (2 refs) → `PATCH` rename 200 → immediate
anonymous ls-remote on the NEW name lists the refs (carry holds, tip
`c6bee6ffeee8…`) → `DELETE` 204 → **T+0 anonymous ls-remote answers 128
`remote: repository not found: p0probe/tomb2-rd14-140939`** (verdict 2.2 s
after the DELETE, no sleep); old name 128 + anonymous API GET 404.

**NEW ISSUE 1 (medium — API release creation is unreachable in production:
the emptiness gate reads `refs_version`, which is never synced).** `POST
/repos/{o}/{r}/releases` answers **422 `{"message":"repo is empty"}`** on a
repo with full history. Root cause: `routes/releases.ts:465` gates on
`found.repo.refsVersion === 0`, but `refs_version` is the observability-only
column that is "deliberately never synced from the engine" — the
codebase's own comment (`services/repository.ts:314-316`) and a
whole-table check prove it: EVERY production repo carries `refs_version=0`
(including push-created `p0-shallow`). So the API create arm 422s for every
repo. The WEB arm (`POST /{o}/{r}/releases/new`) goes straight to
`IssuesService.createRelease` without the gate and works (the 303 create
above, listed via GET). Units pass because test fixtures seed
`refs_version > 0`. Fix: gate on `is_empty` (the real transition column)
or drop the gate. Owner: releases.

**Cleanup proof (API-verified + remote D1).** Probe repos DELETEd → **204**
across the board: `fork-rd14-140939` (the stale pre-tag fork), `tmpl-rd14-…`,
`gen2-rd14-…`, `fork2-rd14-…`, `bp-rd14-…`, `bpfork-rd14-…` (the tomb
lifecycle self-cleaned through its own DELETE step; the smoke repos
self-cleaned). `repositories WHERE owner_namespace IN ('p0probe','admin')`
minus `p0-shallow` = **0**; `status='creating'` whole-table = **0**;
**`action` total = 0 with NO manual sweep** (389da18's delete sweep again
performed in production); `stars` = 0; `repo_redirects` = 0;
`push_mirrors` = 0; `protected_branches` = 0. Per-run credentials: 2 PATs
minted (admin id 32, p0probe id 33; raw mint stdout shredded before capture,
0600 token files); both DELETEd by id (`changes: 2`);
`personal_access_tokens` whole-table = **1** (the standing bootstrap PAT).
Probe scripts, token files, cookie jars, tail logs, clone dirs all shredded
(`/tmp/rd14-probes` removed; `/tmp/gitea-assets-build-rd14` and
`-rd14go` removed); both worktrees removed with their copied `.dev.vars`.
`gitea/` submodule pristine (0 dirty files, pin `fc4936884584`);
`wrangler deployments list` confirms `1c834f20…` at 100%.

**RESOLVED this deployment (for the record):** (a) **generate git-wire
residual — REDEPLOY13's OPEN ISSUE 1 CLOSED** (clone + push-back verified
above, the 8828f43 headline); (b) fork PRs are API-reachable end-to-end in
production (create → render → merge → head-delete ladder); (c) annotated-tag
carry verified through the fork path (name+peel identical, oid divergence
exactly as documented); (d) the ws1009 runner-death class: **0 in both full
gates** (8b0ce41's mitigation holds; the one in-run failure was a load
timeout, solo-green).

**OPEN ISSUES carried:** NEW ISSUE 1 above (API release create 422 on the
refs_version gate — the web arm works); the repo payload's
`fork`/`parent`/`mirror` fields remain the SPEC-0005 serializer stubs
(hardcoded TODO; the fork edge itself is live and verified through forks
list, D1, and the PR path); the bare `owner:branch` PR head form with a
renamed fork answers 404 (documented in-code divergence, upstream answers
400 — cosmetic, the `owner/name:branch` form is the exact path); API tag
create answers 200 where upstream answers 201 (cosmetic, untracked).

*(REDEPLOY14, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## Redeploy verification — 2026-10-26 09:50–10:45 UTC (17:50–18:45 CST), post-REDEPLOY14 fix block (REDEPLOY15)

Deploy shipped as ONE version: **`b9b5c734-a90c-4a98-a04e-f985a5b0fb57`** (100%,
Created 2026-10-26T10:16:12.698Z per `wrangler deployments list`), deployed from
tree **`783ab96` CLEAN** (detached worktree `/tmp/rd15-go`), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`1c834f20-41bb-45f4-8a4a-2e1aaa62d6e6` (the REDEPLOY14 block's version).
Content shipped — the post-REDEPLOY14 mass, `8828f43..783ab96`, 16 commits in
order: 640c202 (SPEC-0001b §5.3 as-built redesign record), 7016ce9 (payload
sites tail — label-detach/assignee/review-submission/review-request emitters to
payload mode), 49de9e9+4ed277d (**the deploy-probes toolkit** — six batteries,
then the mirror battery 6→7; local self-test 65/0/0/0), 5dc924d+d7b8213+5abfe49
(compat survey ticks + SPEC cite refresh), 45bea22+1a7af64 (ui-parity 8/9 —
`/-/projects` LIST, `/blob/*` 303 redirect, tree-list, branches/list), e72ae74
(release-notes addendum 2), efeb2e (REDEPLOY14 evidence), 2bd5388+fa81b96
(pulls payload sites final + the assignee webhook join), **d24dc0f+4619c4f (THE
headline: release create empty-gate `is_empty`, not `refs_version` —
REDEPLOY14's NEW medium closing — plus the honest fixtures correction)**,
783ab96 (checklist item 1 doc). Behavior-bearing in production: the release
gate (verified below), the payload-mode webhook emitters, the two UI waves; the
rest is docs/SPEC/toolkit. Assets rebuilt: same pin `fc4936884584` (submodule
verified unchanged, 0 dirty files).

Deploy-tree methodology (REDEPLOY10–14 detached-worktree pattern): worktree
created at exactly `783ab96`, warm `pnpm install --frozen-lockfile`, `git
submodule update --init` (pin verified), `pnpm gen:icons`, the scratch-dir
asset build (`build-gitea-assets.mjs --work /tmp/gitea-assets-build-rd15go
--skip-install`) emitted into the worktree's `public/assets` BEFORE the vitest
gate, `.dev.vars` copied in 0600. The main working tree was never modified by
this agent (the board wave's in-flight hunks landed via the orchestrator
mid-run; untouched here). Worktree + scratch asset dir + probe scratch removed
after the run.

Deploy gates — at `783ab96` (worktree): `pnpm typecheck` **0 errors**;
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim match —
identical to REDEPLOY14's pin). Vitest run of record: **3418 passed | 4 failed
| 28 skipped (3450) in 181.55 s**, files 4 failed | 156 passed | 1 skipped
(161). **`Worker exited unexpectedly` attributions: 0.** The 4 failures,
adjudicated by solo re-runs: (a) `src/api/compat/suite.test.ts >
POST /repos/{owner}/{repo}/releases (repoCreateRelease) matches its tier-1
fixture` — **DETERMINISTIC, test-only, solo-red too**: the scenario expects 201
but got 422 `{"message":"repo is empty"}` — `suite.test.ts:414-415` seeds the
release repo (id 9004) with `refs_version: 1` (the OLD gate column) but never
`is_empty: false`; 4619c4f fixed `releases.test.ts` (`35 tests ✓` green in-run)
but missed the compat seeding — the production gate is correct and is proven
below; (b) `pull-engine.test.ts` fork-head arm, (c)+(d) `invariants.test.ts` ×2
and `pages-wave6.test.ts` (golden-fixture beforeAll hook) — all three **SOLO
GREEN** on immediate re-run (30 s suite-load timeouts, REDEPLOY14's adjudicated
class).

Remote migrations immediately before deploy: **ledger unchanged — 33 files in
the tree, "✅ No migrations to apply!" (33/33)**; `8828f43..783ab96` touched
zero migration files.

`pnpm smoke` equivalent (deploy-smoke.mjs `--migrate-check`, the run PAT as
Basic password): **6 pass / 0 fail / 1 skip, `ok: true`**. Verbatim key lines:
`[pass] healthz (1993 ms) — {"ok":true}`; `[pass] anon-git-surface (4254 ms) —
probe-9ae7cb34/probe-1e3e0393.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert (615 ms) — advert
ok (165 bytes)`; `[pass] push-lsremote (8534 ms) — pushed c50beb5ba9…, authed
ls-remote sees refs/heads/main, anonymous advert 401 Basic challenge`;
`[pass] cleanup (561 ms) — repo p0probe/smoke-51394246 deleted`; `[pass]
migrate-check (4087 ms) — all 19 expected tables present (+48 system/aux: …
push_mirrors)`; bench-report skip (not requested).

**THE DEPLOY-PROBES TOOLKIT'S PRODUCTION DEBUT** (`scripts/deploy-probes.mjs`
+ its README — REDEPLOY15 is the first production consumer; run from the deploy
worktree, minted per-run PAT in a 0600 token file, base
`https://cf-gitea.hecongw.workers.dev`, user `p0probe`). Battery-by-battery,
verbatim `[pass]` lines:

- **p0** (`--fixture-oid 502abd2d…`) — 4/4 pass, exit 0:
  `[pass] p0-shallow-since (5062 ms) — exit 128 — unsupported fetch argument
  'deepen-since' (only depth-limited shallow fetches are supported)`;
  `[pass] p0-shallow-exclude (5353 ms) — exit 128 — same shape naming
  'deepen-not'`; `[pass] p0-depth-1 (3047 ms) — exit 0 — .git/shallow =
  502abd2d55… (identical tip); depth 1; fsck clean`; `[pass] p0-privacy-anon
  (4911 ms) — anonymous API GET 404, info/refs 401 (Basic realm="Gitea"), web
  page 404 — the fixture stays private`. The toolkit absorbed the brief's
  anonymous-P0 hand-probes wholesale.
- **registry** (`--trials 2`) — 14/14 pass, exit 0: both trials create 201 →
  advert settle (HEAD, refs/heads/main) → rename 200 → IMMEDIATE anonymous
  carry → DELETE 204 → `[pass] tN-tombstone-t0 — exit 128 at t+0 — remote:
  repository not found` → old name dead on both paths (git 128, API 404).
- **generate-e2e** (`--strict-generated-clone`) — 10/10 pass, exit 0:
  template 201 → real push (LICENSE on main + `refs/heads/dev` at
  `4657800679…`) → PATCH template 200 + persisted → generate **201 with
  `"empty":false`** → `[pass] gen-generated-refs (2576 ms) — both carried refs
  at the identical tip 4657800679…`; `[pass] gen-generated-contents (2650 ms) —
  LICENSE round-trips verbatim; last_commit_sha = the carried tip`; **`[pass]
  gen-generated-clone (2602 ms) — clone succeeded (exit 0)`** — the 8828f43
  git-wire fix holds in production under the HARD assert; cleanup 204s.
- **forkpr-e2e** — 8/8 pass, exit 0 (the battery's FIRST production evidence,
  per the README's "no prior evidence block"): base 201 → org 201 → fork 202
  (default slug kept) → settle → fork push (`prbr-bf995651` at `fcfe7c5df1…`) →
  `[pass] forkpr-create-201 (4759 ms) — PR #1 created from head
  prorg-47d0d06e:prbr-bf995651`; `[pass] forkpr-head-chain (1626 ms) — head
  chain ok: prorg-47d0d06e/prbase-e1e3d9ea#prbr-bf995651@fcfe7c5df1… → base
  main (mergeable true, head.ref refs/pull/1/head)`; cleanup deleted fork +
  base + org (204s).
- **ui-login** — 5/5 pass, exit 0: anonymous labels 200 with 0 "New Label";
  `[pass] ui-login-303 (368 ms) — 303 + gitea_session cookie`; `[pass]
  ui-labels-cookie-owner (377 ms) — 200 with 3 "New Label" occurrences +
  small-menu-items — the owner arm renders`; cleanup 204.
- **mirror** — FIRST RUN **4 pass / 1 FAIL** (`mir-sync-settle` 10940 ms —
  "last_error never went non-empty within 10000 ms"), chain-skipping
  row-settled/delete/cleanup. Adjudication, NOT a product regression: the row
  settled at create+12 s — read by hand after the red: `last_error` = **the
  canonical verbatim 530 shape** `mirror target responded 530 for info/refs
  advertisement [https://pmir-85f4cc86.invalid/dummy-unreachable.git/info/refs?service=git-receive-pack]`,
  and remote D1 shows `sync_state='idle'`, `next_sync_at=0` — both skipped
  arms' substance verified true; this deploy range touches zero mirror-path
  files; pure queue-latency variance against the battery's 10 s
  `MIRROR_SETTLE_MS`. Hand-cleaned the leftovers (mirror DELETE 204, list [],
  repo DELETE 204), then **RE-RUN GREEN: 8/8 pass, exit 0** —
  `[pass] mir-ssrf-loopback-refused (2288 ms) — 401 "Permission denied" — the
  loopback target refused at the door; list still empty`; `[pass]
  mir-sync-settle (1265 ms) — last_error names the target — the REDEPLOY13
  verbatim 530 shape`; `[pass] mir-row-settled (5885 ms) — sync_state='idle',
  next_sync_at=0 (--remote)`; delete 204, list [], repo deleted. Settle
  latency: 12 s (red run) vs 1.3 s (green run) — the budget is tight.
- **cleanup-audit** — run last, all pass, exit 0 (with the scratch-PAT
  deviation, see friction): `[pass] audit-query (2567 ms) — owner_repos=1
  creating=0 action=0 stars=0 push_mirrors=0 protected_branches=0
  repo_redirects=0 user_blocking=0 tokens=2`; every independent count green.

Toolkit friction notes for the toolkit owner: (a) `cleanup-audit` is D1-only
but the CLI unconditionally requires `--token-file` (exit 2 without one) — it
forced minting a scratch PAT and running `--expect-tokens 2`, then deleting the
scratch and re-proving the count by hand; (b) `MIRROR_SETTLE_MS` (10 s) is
tight against real production queue latency (observed settle at 12 s once in
two runs); (c) on a `mir-sync-settle` failure the chain-skip leaves the mirror
row AND repo behind with only `[skip] — prior step failed` lines (the
left-behind is the documented red-run convention and the audit catches it, but
a settle-failure cleanup attempt would spare the operator the hand-clean).

**Release-gate production proof (d24dc0f's headline — REDEPLOY14's NEW ISSUE 1
CLOSED in production).** Repo `p0probe/rel-rd15-2285617593` created 201
(auto_init) with a REAL push on top (tip `65341d7209db72149cd3b3691c18118d9881814f`);
`POST /api/v1/repos/p0probe/rel-rd15-2285617593/releases
{"tag_name":"v1-rd15",…}` → **201** (REDEPLOY14: 422
`{"message":"repo is empty"}` on EVERY repo), body renders `id 2,
target_commitish "main"`, and `GET /releases` lists it. Negative arm — the gate
is a gate, not removed: an `auto_init:false` empty repo → POST /releases →
**422 `{"message":"repo is empty"}`** verbatim. Both probe repos DELETEd 204.

Cleanup proof: every battery self-cleaned (registry tombs through their own
DELETE step; generate/forkpr/ui/mirror-run-2/smoke/released-proof/empty-gate
repos all 204; mirror-run-1 leftovers hand-cleaned 204/[]/204 as disclosed).
Per-run credentials: 3 PATs minted this run — id 34 (LOST TO AN OPERATOR SLIP:
the extraction regex `[A-Z2-7]` forgot the base32 alphabet's 8/9, so the token
never reached the file; deleted by id `changes: 1` before any use), id 35 (the
run PAT, used for every battery + smoke + hand-probes; DELETEd by id
`changes: 1`; file shredded), the audit scratch PAT (prefix `cfg_288e4112`;
DELETEd by prefix `changes: 1`; file shredded). Final whole-table
`personal_access_tokens` = **1** (the standing bootstrap PAT), re-verified by
remote D1 count alongside `owner_repos=1` (p0-shallow), `action=0`,
`push_mirrors=0`. Raw mint stdout shredded; worktree, scratch asset dir, and
probe logs removed; `gitea/` pristine (0 dirty files, pin `fc4936884584`).

**RESOLVED this deployment:** REDEPLOY14's NEW ISSUE 1 — API release creation
is reachable in production (the `is_empty` gate: 201 on a pushed repo, 422 on
a genuinely empty one). The ws1009 runner-death class stays at 0.

**OPEN ISSUES carried:** NEW (test-only, medium-low — owner: releases/compat):
the compat tier-1 golden fixture for `repoCreateRelease` 422s under the honest
gate — `src/api/compat/suite.test.ts:414-415` seeds `refs_version: 1` but not
`is_empty: false` for repo 9004; one-line seed fix, production unaffected
(unit file 35/35 + the production proof above). Carried unchanged from
REDEPLOY14: the repo payload's `fork`/`parent`/`mirror` fields remain the
SPEC-0005 serializer stubs; the bare `owner:branch` PR head form with a renamed
fork answers 404 (documented in-code divergence); API tag create answers 200
where upstream answers 201 (cosmetic, untracked).

*(REDEPLOY15, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## Redeploy verification — 2026-10-26 11:05–11:40 UTC (19:05–19:40 CST), post-REDEPLOY15 mass (REDEPLOY16)

Deploy shipped as ONE version: **`941ce4d0-2134-4ec6-8228-8f4523013b22`** (100%,
Created 2026-10-26T11:16:55.606Z per `wrangler deployments list`), deployed from
tree **`2310623` CLEAN** (detached worktree `/tmp/rd16-go`; the in-flight
tree-view/tick units were uncommitted in the main tree and excluded by the
worktree by construction — the orchestrator's GO named 2310623 explicitly), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`b9b5c734-a90c-4a98-a04e-f985a5b0fb57` (the REDEPLOY15 block's version).
Content shipped — the post-REDEPLOY15 mass, `783ab96..2310623`, 10 commits in
order: 9b49cd2 (projects board + write group + workflow tails), 48f873f
(docs tick-4), cdf683a (fileicon asset+lookup layer, enry-premise correction),
3b3a3ae (**the compat releases fixture `isEmpty` seed — REDEPLOY15's NEW
test-only issue closing**), 305ddc8 (REDEPLOY15 evidence), 5fdbc15 (toolkit
polish: D1-only token optional + mirror budget 30 s + failure tail), 5e082cd
+2b5b898 (**the attachments seam + dispatch wiring — the site-level
`/attachments/:uuid` route goes live**, probed below), fdaeaca (wave-ui-parity-10:
releases download tail + the `/render/*` family + fetch-action JSON arms,
probed below), 2310623 (toolkit PAT preflight). Behavior-bearing in production:
the attachments route, the render family, the projects board, the fileicon
layer, the releases download tail; the rest is docs/test/toolkit. Assets
rebuilt: same pin `fc4936884584` (submodule verified unchanged, 0 dirty files).

Deploy-tree methodology (REDEPLOY10–15 detached-worktree pattern): worktree at
exactly `2310623`, warm `pnpm install --frozen-lockfile`, `git submodule
update --init` (pin verified), `pnpm gen:icons`, the scratch-dir asset build
(`build-gitea-assets.mjs --work /tmp/gitea-assets-build-rd16 --skip-install`)
emitted into the worktree's `public/assets` BEFORE the vitest gate, `.dev.vars`
copied 0600. The main working tree was never modified by this agent. Gates ran
at 2310623 pre-GO; the GO landed on the same commit, the worktree re-verified
CLEAN (HEAD `2310623`, 0 tracked changes) and the deploy went straight from the
gated tree. Worktree + scratch asset dir + probe scratch removed after the run.

Deploy gates — at `2310623` (worktree): `pnpm typecheck` **0 errors** (exit 0);
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim match —
identical to REDEPLOY14/15's pin). Vitest run of record: **3536 passed |
2 failed | 5 skipped (3543) in 174.54 s**, files 1 failed | 163 passed |
1 skipped (165). **`Worker exited unexpectedly` attributions: 0.** The 2
failures, adjudicated by solo re-run: both `src/api/pull-engine.test.ts >
merge delete_branch_after_merge — the fork-head arms` (deletes-the-FORK-head /
keeps-the-FORK-default) **30 s test timeouts, SOLO GREEN 25/25 on immediate
re-run** — the REDEPLOY14/15-adjudicated suite-load flake class, nothing new.
Notably **zero compat failures**: REDEPLOY15's deterministic
`repoCreateRelease` fixture red is GONE — 3b3a3ae cured it exactly as claimed.

Remote migrations immediately before deploy: **ledger unchanged — 33 files in
the tree, zero diff `783ab96..2310623` in `src/db/migrations/`, "✅ No
migrations to apply!" (33/33)**.

`pnpm smoke` equivalent (deploy-smoke.mjs `--migrate-check`, the run PAT as
Basic password): **6 pass / 0 fail / 1 skip, exit 0**. Verbatim key lines:
`[pass] healthz (1539 ms) — {"ok":true}`; `[pass] anon-git-surface (2855 ms) —
probe-379aefdf/probe-759b1a2a.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert (260 ms) — advert
ok (165 bytes)`; `[pass] push-lsremote (9109 ms) — pushed 63b85f4648…, authed
ls-remote sees refs/heads/main, anonymous advert 401 Basic challenge`;
`[pass] cleanup (701 ms) — repo p0probe/smoke-77f84f60 deleted`;
`[pass] migrate-check (4089 ms) — all 19 expected tables present (+48
system/aux: … issue_attachments …)`; bench-report skip (not requested).

**THE TOOLKIT'S SECOND PRODUCTION RUN — 7 batteries, with two firsts: the
2310623 PAT-identity preflight's first production appearance (one `GET /user`
before the first HTTP battery; the match passed SILENTLY, by design — the
fast-fail arms have no production trigger to this day) and the 5fdbc15
D1-only-audit affordance's first production exercise (the audit ran TWICE with
NO token file — REDEPLOY15's friction (a) is resolved in production).** The new
`--mirror-settle-ms` default (30000 ms) was in effect. Run from the deploy
worktree, minted per-run PAT in a 0600 token file, base
`https://cf-gitea.hecongw.workers.dev`, user `p0probe`. Battery-by-battery,
verbatim `[pass]` lines:

- **p0** (`--fixture-oid 502abd2d…`) — 4/4 pass, exit 0:
  `[pass] p0-shallow-since (4000 ms) — exit 128 — unsupported fetch argument
  'deepen-since' (only depth-limited shallow fetches are supported)`;
  `[pass] p0-shallow-exclude (2458 ms) — exit 128 — same shape naming
  'deepen-not'`; `[pass] p0-depth-1 (10943 ms) — exit 0 — .git/shallow =
  502abd2d55… (identical tip); depth 1; fsck clean`; `[pass] p0-privacy-anon
  (4706 ms) — anonymous API GET 404, info/refs 401 (Basic realm="Gitea"), web
  page 404 — the fixture stays private`. The brief's P0 trio + anon arms are
  absorbed here.
- **registry** (`--trials 2`) — 14/14 pass, exit 0: both trials create 201 →
  advert settle (HEAD, refs/heads/main) → rename 200 → IMMEDIATE anonymous
  carry → DELETE 204 → `[pass] tN-tombstone-t0 — exit 128 at t+0 — remote:
  repository not found` → old name dead on both paths (git 128, API 404).
- **generate-e2e** (`--strict-generated-clone`) — FIRST RUN **1 pass / 1 FAIL /
  8 skip**: `gen-template-push` died at 5061 ms with
  `gnutls_handshake() failed: The TLS connection was non-properly terminated` —
  adjudicated CLIENT-side, not a product regression: the same local-network
  window that 404'd `wrangler deployments list` minutes earlier (a manual
  healthz loop in the same minute read `SSL_ERROR_SYSCALL` then 200);
  p0's four clones had succeeded seconds before. The red left
  `p0probe/tmpl-85c28975` behind (chain-skip convention; see friction) —
  hand-deleted 204, then **RE-RUN GREEN: 10/10 pass, exit 0** — template 201 →
  real push (LICENSE on main + `refs/heads/dev` at `5bc7d95d9e…`) → PATCH 200 +
  persisted → generate **201 with `"empty":false`** →
  `[pass] gen-generated-refs (2059 ms) — both carried refs at the identical tip
  5bc7d95d9e…`; `[pass] gen-generated-contents (1812 ms) — LICENSE round-trips
  verbatim; last_commit_sha = the carried tip`; **`[pass] gen-generated-clone
  (2686 ms) — clone succeeded (exit 0)`** under the HARD assert (the
  8828f43 git-wire fix holds); cleanup 204s.
- **forkpr-e2e** — 8/8 pass, exit 0 (second production evidence): base 201 →
  org 201 → fork 202 → settle → fork push (`prbr-7b306b60` at `67067b7fc4…`) →
  `[pass] forkpr-create-201 (3333 ms) — PR #1 created from head
  prorg-d2068b92:prbr-7b306b60`; `[pass] forkpr-head-chain (1755 ms) — head
  chain ok: prorg-d2068b92/prbase-ff793ad1#prbr-7b306b60@67067b7fc4… → base
  main (mergeable true, head.ref refs/pull/1/head)`; cleanup deleted fork +
  base + org (204s).
- **mirror** — 8/8 pass, exit 0, FIRST TRY (no red, no tail sweep needed):
  `[pass] mir-ssrf-loopback-refused (2180 ms) — 401 "Permission denied" — the
  loopback target refused at the door; list still empty`; `[pass]
  mir-sync-settle (1065 ms) — last_error names the target — the REDEPLOY13
  verbatim 530 shape: mirror target responded 530 for info/refs advertisement
  [https://pmir-680a2ba5.invalid/dummy-unreachable.git/info/refs?service=git-receive-p…`;
  `[pass] mir-row-settled (2803 ms) — sync_state='idle', next_sync_at=0
  (--remote)`; delete 204, list [], repo deleted. The new 30 s budget never
  came under pressure (settle 1.1 s; REDEPLOY15's 12 s variance did not recur).
- **ui-login** — 5/5 pass, exit 0: anonymous labels 200 with 0 "New Label";
  `[pass] ui-login-303 (288 ms) — 303 + gitea_session cookie`; `[pass]
  ui-labels-cookie-owner (317 ms) — 200 with 3 "New Label" occurrences +
  small-menu-items — the owner arm renders`; cleanup 204.
- **cleanup-audit** — run TWICE, both D1-only WITHOUT any token (first
  production exercise of the 5fdbc15 affordance). Run 1 (`--expect-tokens 2`,
  run PAT still alive), all 10 pass: `[pass] audit-query (3832 ms) —
  owner_repos=1 creating=0 action=0 stars=0 push_mirrors=0
  protected_branches=0 repo_redirects=0 user_blocking=0 tokens=2`. Run 2
  (after the PAT delete, `--expect-tokens 1`), all 10 pass: `[pass] audit-query
  (4127 ms) — owner_repos=1 creating=0 … tokens=1`.

**THE HAND SPOT-PROBES** (where the toolkit lacks arms; one private probe repo
`p0probe/spot-rd16-4177` — auto_init — carried all three):

- **attachments spot — the 2b5b898 route's first production traffic.**
  `POST /api/v1/repos/p0probe/spot-rd16-4177/issues/1/assets?name=hello.txt`
  (multipart) → **201**, body renders `uuid
  a9a17796-df45-4d1b-82ca-5bc662f26a7d`, `size 36`, and the
  `browser_download_url` field. Reader arm: `GET
  /attachments/a9a17796-…` with the run PAT → **200** with the full
  ServeAttachment header matrix, verbatim: `content-type: text/plain;
  charset=utf-8` (the Go sniff table), `content-disposition: inline;
  filename=hello.txt` (upstream's INLINE default), `content-security-policy:
  sandbox allow-scripts allow-modals allow-popups allow-downloads`,
  `x-content-type-options: nosniff`,
  `access-control-expose-headers: Content-Disposition`; body round-tripped
  byte-exact. 404 arms: anonymous GET on the private repo's attachment →
  **404 "Not Found"** (no existence leak); a bogus uuid → **404**. NEW FINDING
  (medium-low, see OPEN ISSUES): the same GET with the owner's **session
  cookie** → 404 on BOTH attachment kinds — the seam's credential walk is
  token-only (`resolveOptionalCredential`; Basic/bearer tokens), session doers
  are invisible to it, so a logged-in browser following `browser_download_url`
  on a PRIVATE repo's asset gets 404 where upstream's session-authenticated web
  route serves the owner. API/token clients and public repos are unaffected.
- **render spot — the fdaeaca family's first production traffic.** `GET
  /p0probe/spot-rd16-4177/render/branch/main/README.md` with the owner session
  → **200** `content-type: text/html; charset=utf-8` +
  `content-security-policy: sandbox allow-scripts allow-forms allow-modals
  allow-popups allow-downloads`, body a rendered fragment (`<h1
  id="user-content-spot-rd16-4177">…`). Non-renderable arm: a `data.bin`
  created via the contents API (201) → `GET …/render/branch/main/data.bin` →
  **400 "Unable to find renderer"** verbatim. Missing path → **404**. Probe
  methodology note for the next runner: the refType literal is REQUIRED —
  `/render/main/README.md` (no `branch/`) is unclaimed by the landed parse and
  falls to the engine 404 exactly as designed; cite the shape as
  `/render/{branch|tag|commit}/{ref}/*`.
- **releases download spot — the fdaeaca tail end-to-end.** `POST …/releases
  {"tag_name":"v1-spot",…}` on the pushed repo → **201** (id 3 — the d24dc0f
  `is_empty` gate stays healthy in production, third consecutive deploy);
  `POST /releases/3/assets?name=rel-asset.txt` → **201** with
  `browser_download_url` = `…/attachments/74be9325-3f2c-483e-a51d-07a2e8f22ed3`;
  the `release_assets` row verified in remote D1 (`release_id 3`, `repo_id`
  set); following the URL with the PAT → **200**, the same header matrix as the
  issue attachment (`inline; filename=rel-asset.txt`, sandbox CSP, nosniff),
  body byte-exact; anonymous → **404** (private).

Cleanup proof: every battery self-cleaned (registry tombs through their own
DELETE step; generate/forkpr/ui/mirror/smoke repos all 204). Spot-probe repos:
`tmpl-85c28975` (the generate red's leftover) hand-deleted 204;
`spot-rd16-4177` deleted 204 after the probes. Per-run credentials: ONE PAT
minted (the mint log's "id 4" line was the STANDING bootstrap PAT's id — the
run PAT was **id 37**, `created_at 11:19:21`; verify the id against
`GET /users/{user}/tokens` before deleting, not the mint line). Deleted by
`DELETE /api/v1/users/p0probe/tokens/37` → **204** (methodology note: token
CRUD requires BASIC auth — the bearer form 401s "auth required"; matches the
route tests). Token + cookie files shredded; raw mint stdout shredded. Final
whole-table `personal_access_tokens` = **1** (the standing bootstrap PAT),
proven by cleanup-audit run 2 alongside `owner_repos=1` (p0-shallow),
`creating=0`, `action=0`, `stars=0`, `push_mirrors=0`. Worktree, scratch asset
dir, and probe logs removed; `gitea/` pristine (0 dirty files, pin
`fc4936884584`).

**RESOLVED this deployment:** REDEPLOY15's OPEN issue (test-only, medium-low) —
the compat tier-1 `repoCreateRelease` golden fixture seeds `isEmpty:false` as
of 3b3a3ae; the gates run shows zero compat failures. REDEPLOY15's toolkit
friction (a) — the audit demanding a PAT — is resolved in production
(5fdbc15's D1-only affordance, exercised twice with no token file). The
ws1009 runner-death class stays at 0.

**OPEN ISSUES carried:** NEW (medium-low — owner: attachments seam):
the site-level `/attachments/:uuid` route authenticates TOKENS only — the
session-cookie doer is invisible to `resolveOptionalCredential`, so private-repo
attachments 404 for the logged-in owner's BROWSER (every `browser_download_url`
click) while API/token clients succeed; the module doc's "cf-gitea has no
sessions" premise is inaccurate as stated (the ui tier demonstrably has
sessions — the ui-login battery lives on them); fix shape: walk the session
cookie in the seam's credential resolution, or route web downloads through the
session tier. NEW (toolkit, low — owner: toolkit): the generate-e2e battery has
no finally-style leftover sweep (only the mirror battery self-cleans) — this
run's red stranded `tmpl-85c28975` behind `[skip]` lines for a hand-clean;
porting the mirror battery's `failureTail` shape would close it. Carried
unchanged: the repo payload's `fork`/`parent`/`mirror` fields remain the
SPEC-0005 serializer stubs; the bare `owner:branch` PR head form with a renamed
fork answers 404 (documented in-code divergence); API tag create answers 200
where upstream answers 201 (cosmetic, untracked).

*(REDEPLOY16, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## Redeploy verification — 2026-10-26 12:04–12:30 UTC (20:04–20:30 CST), post-REDEPLOY16 mass (REDEPLOY17)

Deploy shipped as ONE version: **`b928537a-02e8-486a-8f4d-f3b2c25cb354`** (100%,
Created 2026-10-26T12:04:19.433Z per `wrangler deployments list`), deployed from
tree **`7cd1ce9` CLEAN** (detached worktree `/tmp/rd17-go`; the tree-view unit
landed as `831709f` minutes AFTER the GO was issued and was excluded by the
worktree by construction — the orchestrator's GO named `7cd1ce9` explicitly), on
https://cf-gitea.hecongw.workers.dev. Previous live version:
`941ce4d0-2134-4ec6-8228-8f4523013b22` (the REDEPLOY16 block's version).
Content shipped — the post-REDEPLOY16 mass, `2310623..7cd1ce9`, 4 commits in
order: 64aa06a (docs tick-5), 2d64de1 (the REDEPLOY16 evidence itself), ee88c1b
(**the toolkit generate-e2e failureTail + the GENERIC `--force-red <check-id>`
self-test knob — REDEPLOY16's toolkit OPEN closing, rehearsed in production
below**), 7cd1ce9 (**the attachments credential walk — token-first,
session-cookie fall-through, error-fall-through per the pinned web group, with
the rotation Set-Cookie re-wrapped on the session arm's responses — REDEPLOY16's
medium-low closing, production-proven below**). Behavior-bearing in production:
ONLY the attachments credential walk; the rest is docs/test/toolkit. Assets
rebuilt: same pin `fc4936884584` (submodule verified unchanged, 0 dirty files).

Deploy-tree methodology (REDEPLOY10–16 detached-worktree pattern): worktree at
exactly `7cd1ce9`, warm `pnpm install --frozen-lockfile`, `git submodule update
--init` (pin verified `fc4936884584`), `pnpm gen:icons` (39 icons, 15883
bytes), the scratch-dir asset build (`build-gitea-assets.mjs --work
/tmp/gitea-assets-build-rd17 --skip-install`, 17M into the worktree's
`public/assets`) BEFORE the vitest gate, `.dev.vars` copied 0600. The main
working tree was never modified by this agent (its sole write is this evidence
block). Gates ran at `7cd1ce9` pre-GO; the worktree re-verified CLEAN (HEAD
`7cd1ce9`, 0 tracked changes) immediately before `wrangler deploy` from it.
Worktree + scratch asset dir + probe scratch removed after the run.

Deploy gates — at `7cd1ce9` (worktree): `pnpm typecheck` **0 errors** (exit 0);
`check:api` **PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths,
129/129 ops**); `check:contract` **PASS** (sha256 `529a3314…`, verbatim match —
identical to REDEPLOY14/15/16's pin). Vitest run of record: **3544 passed |
5 skipped (3549), 0 failed**, files **164 passed | 1 skipped (165)**, 86.09 s.
**Zero failures, zero adjudications** — REDEPLOY16's two 30 s suite-load flakes
(merge fork-head arms) did not recur; the fork-head arms passed inline (18.5 s +
13.8 s). Total grew 3543 → 3549 with the mass (7cd1ce9's 32/32 attachments
arms, ee88c1b's toolkit self-tests).

Remote migrations: **ledger unchanged — 33 files in the tree, zero diff
`2310623..7cd1ce9` in `src/db/migrations/`** (verified by git diff pre-deploy).
Methodology deviation, disclosed: the explicit `wrangler d1 migrations apply`
no-op ran POST-deploy from the main tree (whose migrations dir is identical to
`7cd1ce9`'s by the same zero-diff proof) instead of pre-deploy from the
worktree — with zero diff the order is immaterial: **"✅ No migrations to
apply!" (33/33)**, and the smoke's migrate-check (below) independently confirms
the remote schema.

`pnpm smoke` equivalent (deploy-smoke.mjs `--migrate-check`, the run PAT as
Basic password): **6 pass / 0 fail / 1 skip, exit 0**. Verbatim key lines:
`[pass] healthz (2016 ms) — {"ok":true}`; `[pass] anon-git-surface (1808 ms) —
probe-bd670a5d/probe-8658cf38.git: git-upload-pack 404 not-found,
git-receive-pack 401 Basic challenge`; `[pass] receive-advert (258 ms) — advert
ok (165 bytes)`; `[pass] push-lsremote (9133 ms) — pushed 0601858e61…, authed
ls-remote sees refs/heads/main, anonymous advert 401 Basic challenge`;
`[pass] cleanup (610 ms) — repo p0probe/smoke-c8123aa0 deleted`;
`[pass] migrate-check (4799 ms) — all 19 expected tables present (+48
system/aux: … issue_attachments …)`; bench-report skip (not requested).

**THE TOOLKIT'S THIRD PRODUCTION RUN — 7 batteries green, plus the ee88c1b
`--force-red` knob's first PRODUCTION rehearsals (two shapes, below).** The
2310623 PAT-identity preflight passed silently again (one `GET /user`, match,
no output — the fast-fail arms remain production-untriggered). Run from the
deploy worktree, minted per-run PAT in a 0600 token file, base
`https://cf-gitea.hecongw.workers.dev`, user `p0probe`. Battery-by-battery:

- **p0** (`--fixture-oid 502abd2d…`) — 4/4 pass, exit 0:
  `[pass] p0-shallow-since (4139 ms) — exit 128 — unsupported fetch argument
  'deepen-since' (only depth-limited shallow fetches are supported)`;
  `[pass] p0-shallow-exclude (2644 ms) — exit 128 — same shape naming
  'deepen-not'`; `[pass] p0-depth-1 (2664 ms) — exit 0 — .git/shallow =
  502abd2d55… (identical tip); depth 1; fsck clean`; `[pass] p0-privacy-anon
  (5464 ms) — anonymous API GET 404, info/refs 401 (Basic realm="Gitea"), web
  page 404 — the fixture stays private`. The brief's P0 trio + anon arms are
  absorbed here.
- **registry** (`--trials 2`) — 14/14 pass, exit 0: both trials create 201 →
  advert settle (HEAD, refs/heads/main) → rename 200 → IMMEDIATE anonymous
  carry → DELETE 204 → `[pass] tN-tombstone-t0 — exit 128 at t+0 — remote:
  repository not found` → old name dead on both paths (git 128, API 404).
- **generate-e2e** (`--strict-generated-clone`) — **10/10 pass, exit 0, GREEN
  ON THE FIRST TRY this time** (REDEPLOY16's TLS-flake red did not recur):
  template 201 (`tmpl-d3e813d9`) → real push (LICENSE on main + `dev`, both at
  `7b7eee2b0a…`) → PATCH 200 + persisted → generate **201 with
  `"empty":false`** (`gen-9cf767f1`) → refs carried at the identical tip →
  `[pass] gen-generated-contents (2518 ms) — LICENSE round-trips verbatim;
  last_commit_sha = the carried tip`; `[pass] gen-generated-clone (5200 ms) —
  clone succeeded (exit 0)` under the HARD assert; `[pass] gen-cleanup (9584
  ms) — gen-9cf767f1 + tmpl-d3e813d9 deleted`. The green run's failureTail
  no-oped silently, as designed.
- **forkpr-e2e** — 8/8 pass, exit 0 (third production evidence): base 201 →
  org 201 → fork 202 → settle → fork push (`prbr-9065286d` at `3ec825505d…`) →
  `[pass] forkpr-create-201 (3039 ms) — PR #1 created from head
  prorg-462be06a:prbr-9065286d`; `[pass] forkpr-head-chain (1712 ms) — head
  chain ok: prorg-462be06a/prbase-ac3a31c5#prbr-9065286d@3ec825505d… → base
  main (mergeable true, head.ref refs/pull/1/head)`; cleanup deleted fork +
  base + org (204s).
- **mirror** — 8/8 pass, exit 0, FIRST TRY (second consecutive): `[pass]
  mir-ssrf-loopback-refused (2695 ms) — 401 "Permission denied" — the loopback
  target refused at the door; list still empty`; `[pass] mir-sync-settle
  (1108 ms) — last_error names the target — the REDEPLOY13 verbatim 530 shape:
  mirror target responded 530 for info/refs advertisement
  [https://pmir-30a45b1d.invalid/dummy-unreachable.git/info/refs?service=git-receive-p…`;
  `[pass] mir-row-settled (3917 ms) — sync_state='idle', next_sync_at=0
  (--remote)`; delete 204, list [], repo deleted. The 30 s budget never came
  under pressure (settle 1.1 s, third consecutive sub-2 s settle).
- **ui-login** — 5/5 pass, exit 0: anonymous labels 200 with 0 "New Label";
  `[pass] ui-login-303 (621 ms) — 303 + gitea_session cookie`; `[pass]
  ui-labels-cookie-owner (442 ms) — 200 with 3 "New Label" occurrences +
  small-menu-items — the owner arm renders`; cleanup 204.
- **cleanup-audit** — run TWICE, both D1-only without any token. Run 1
  (`--expect-tokens 3` — both run PATs still alive, see cleanup), all 10 pass:
  `[pass] audit-query (2859 ms) — owner_repos=1 creating=0 action=0 stars=0
  push_mirrors=0 protected_branches=0 repo_redirects=0 user_blocking=0
  tokens=3`. Run 2 (after both deletes, `--expect-tokens 1`), all 10 pass:
  `[pass] audit-query (3512 ms) — owner_repos=1 creating=0 … tokens=1`.

**THE HAND SPOT-PROBE — the attachments re-probe: the 7cd1ce9 credential
walk's FIRST PRODUCTION TRAFFIC, and the direct re-test of the arm REDEPLOY16
found 404ing.** One private probe repo `p0probe/spot-rd17-2275e15f`
(auto_init, 201) + issue #1 + `POST …/issues/1/assets?name=hello-rd17.txt`
(multipart) → **201**, `uuid a7c6024a-7d23-430e-bbc3-248df3b2487c`, `size 32`,
`browser_download_url …/attachments/a7c6024a-…`. `POST /login` → **303** +
`gitea_session`. Then, verbatim from the probe:

- **THE FIX ARM — the cookie-only owner GET: 200.** `GET /attachments/a7c6024a-…`
  with ONLY the session cookie → **200** with the full ServeAttachment header
  matrix, verbatim: `content-type: text/plain; charset=utf-8` (the Go sniff
  table), `content-disposition: inline; filename=hello-rd17.txt` (upstream's
  INLINE default), `content-security-policy: sandbox allow-scripts
  allow-modals allow-popups allow-downloads`,
  `x-content-type-options: nosniff`,
  `access-control-expose-headers: Content-Disposition`,
  `etag: W/"a7c6024a-7d23-430e-bbc3-248df3b2487c"`; body round-tripped
  BYTE-EXACT. **REDEPLOY16's window saw this exact arm answer 404 for the
  logged-in owner — the fix is production-proven.**
- **The literal browser click**: following the payload's `browser_download_url`
  field value with the cookie only → **200**, body BYTE-EXACT (the
  REDEPLOY16 OPEN text's exact scenario: "a logged-in browser following
  `browser_download_url` on a PRIVATE repo's asset").
- **Token+session both present → token wins**: the same GET with the token
  header AND the live session cookie → **200**, body byte-exact, and
  **`Set-Cookie` count 0 — no session re-wrap** (upstream skips Session.Verify
  once a token authenticates; the rotation directive rides only the session
  arm's responses, exactly as the landed walk documents).
- Token-only control → **200** (unchanged); anonymous → **404 "Not Found"**
  (no existence leak, private repo); bogus uuid → **404**; dead cookie
  (`gitea_session=deadbeef…`) → **404 with the clear directive present** (the
  error-fall-through arm). Probe repo deleted **204**.

**THE `--force-red` REHEARSALS — the ee88c1b knob's first production exercise,
closing REDEPLOY16's toolkit OPEN text.** Both shapes against production
(real creations, deterministic forced fail, real tail sweeps):

- **Late red** (`generate-e2e --force-red gen-generated-contents`): 7 checks
  pass for real (template `tmpl-a5324edf` + generated `gen-44733ccb` both
  exist), `[fail] gen-generated-contents (0 ms) — FORCED RED`, clone + cleanup
  chain-skip, then **`[tail] gen-leftover-sweep (best-effort failure cleanup)
  — repo p0probe/gen-44733ccb deleted; repo p0probe/tmpl-a5324edf deleted`** —
  BOTH swept, generated-first order, summary `"ok": false` as any red.
- **Early red — the exact REDEPLOY16 incident shape**
  (`--force-red gen-template-push`): `[pass] gen-create-template-201 (2392 ms)
  — created p0probe/tmpl-299fd3d4`, FORCED fail, 9 chain-skips, then
  **`[tail] gen-leftover-sweep … — repo p0probe/tmpl-299fd3d4 deleted`** —
  template-ONLY, **no phantom generated delete** (the incident's leftover
  shape, now self-healing), node exit **1** (captured unmasked — not through a
  grep pipe). The following audit run 1 (above) proves the ground clean:
  `owner_repos=1`, zero `tmpl-*`/`gen-*` survivors.

Cleanup proof: every battery self-cleaned (registry tombs through their own
DELETE step; generate/forkpr/ui/mirror/smoke repos all 204). Force-red
rehearsal repos swept by the tails (both, verbatim above). Spot repo
`spot-rd17-2275e15f` deleted 204 after the
probes. Per-run credentials: TWO tokens minted (ids 38, 39 — the mint log's
"id 4" line is the USER id, not a token id); the first mint's stdout was
shredded before extraction (a regex slip — token shape is `cfg_` + 40 chars,
no `_` separator to anchor on), orphaning token 38 in D1; BOTH were deleted by
id via Basic-auth token CRUD → **204, 204**, and the surviving token verified
**401** after delete. Token + cookie scratch + probe scripts shredded; raw
mint stdout shredded. Final whole-table `personal_access_tokens` = **1** (the
standing bootstrap PAT), proven by cleanup-audit run 2 alongside
`owner_repos=1` (p0-shallow), `creating=0`, `action=0`, `stars=0`,
`push_mirrors=0`. Worktree, scratch asset dir, and probe logs removed;
`gitea/` pristine (0 dirty files, pin `fc4936884584`).

**RESOLVED this deployment — BOTH of REDEPLOY16's OPEN issues:**

1. **(medium-low, the attachments token-only walk)** — closed by 7cd1ce9's
   credential walk (token-first, session fall-through, error-fall-through,
   rotation re-wrap on the session arm); production-proven by the re-probe
   above: the cookie-only owner GET answers **200** with the full header
   matrix and byte-exact body, the `browser_download_url` click **200**s, and
   the both-present arm proves token-wins with zero session re-wrap.
2. **(low, the toolkit generate-e2e leftover sweep)** — closed by ee88c1b's
   `failureTail` + the generic `--force-red` knob; production-proven by both
   rehearsals above (late red → both repos swept; the incident's early-red
   shape → template-only sweep, no phantom, following audit green).

The ws1009 runner-death class stays at 0 (no `Worker exited unexpectedly` in
the run of record).

**OPEN ISSUES carried unchanged:** the repo payload's `fork`/`parent`/`mirror`
fields remain the SPEC-0005 serializer stubs; the bare `owner:branch` PR head
form with a renamed fork answers 404 (documented in-code divergence); API tag
create answers 200 where upstream answers 201 (cosmetic, untracked). NEW
methodology friction (this agent only, no product impact): the bootstrap mint
stdout is the ONLY copy of the token — extract the token BEFORE shredding, and
anchor extraction on the line start (`^\s*cfg_`), not an internal shape
regex; an orphaned mint is recoverable (delete by id via the tokens list), but
avoid minting twice.

*(REDEPLOY17, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## Redeploy verification — 2026-10-26 12:19–13:22 UTC (20:19–21:22 CST), tree-view's first production window + the repo-projects wave + the ?raw deploy incident (REDEPLOY18)

THREE live versions this window — the GO deploy, a production incident it carried, and
the fix-forward: previous live `b928537a-02e8-486a-8f4d-f3b2c25cb354` (REDEPLOY17) →
**`a842cfd8-bf31-4396-8f45-350ddc83b226`** (100%, created 2026-10-26T13:01:30.338Z, at
tree `52a1f52`) → **`abfbf291-355a-44ac-92f2-bac76bece1a1`** (100%, created
2026-10-26T13:15:31.037Z, at tree `981c098` — CURRENT LIVE), on
https://cf-gitea.hecongw.workers.dev. Content shipped, `7cd1ce9..981c098`, 13 commits:
831709f (**tree-view envelope — its FIRST production window, and the window that found
the deploy-path incident below**), 58c6cf0 (page-domain Set-Cookie re-wrap), 7a5861e +
4f59daa + bff7fdc (docs ticks/notes), 96cb9d4 (the REDEPLOY17 evidence), 0db7087
(**blob-excerpt machinery — mechanism-only, NO routes mounted this window; no
production surface exists to probe, noted as such per the GO**) + 3502ee4
(**lastcommit fragment — same mechanism-only posture**) + 7d4c19a (**the toolkit
all-battery failure tails — armed, silent on green, below**), ae32b1a (**repo-scoped
projects — the GO originally excluded it as in-flight; it landed mid-window and the
re-GO carried it**), 4ed30cc + 52a1f52 + 981c098 (**the wrangler Text-rule arc — the
deploy-path incident, below**). 4ed30cc NEVER deployed (its bundle failed at the
loader — nothing uploaded, production stayed on a842cfd8); the live lineage is
b928537a → a842cfd8 → abfbf291. Assets rebuilt both deploys: same pin `fc4936884584`
(submodule verified unchanged, 0 dirty files).

**THE INCIDENT — tree-view's first window found a deploy-tooling gap that four green
vitest runs could never see.** The a842cfd8 GO deploy bundled clean (the 52a1f52 rule
`{"type":"Text","globs":["**/*.svg?raw"]}` fixed 4ed30cc's loader error) but EVERY
`GET /{owner}/{repo}/tree-view/…` answered **500 "Internal Server Error"** (text/plain,
21 bytes) to the cookie-authenticated owner — on the full fixture tree AND on a
minimal one-blob tree; anonymous correctly 404s (no existence leak). `wrangler tail`
caught the exception on exactly the three probed envelope URLs:
`SyntaxError: "[object Object]" is not valid JSON`. Root cause: `fileicon.ts:197-198`
imports `material-icon-rules.json?raw` + `material-icon-svgs.json?raw` (461,498 +
998,898 bytes — the ws1009 `?raw` workaround) and `JSON.parse`s them (:208-209). Vite's
`?raw` returns the raw STRING (all 976 ui tests green in every run); wrangler's esbuild
ignores the `?raw` query, its BUILT-IN `.json` loader returns the already-PARSED
OBJECT, and `JSON.parse(object)` throws on every envelope request (the dynamic fileicon
edge loads before assembly; the throw is caught upstream of the isolate — tail outcome
"ok", HTTP 500). The `.svg?raw` family needed the explicit Text rule because esbuild
has NO default svg loader; the `.json?raw` family slipped through bundling because the
json loader EXISTS — with the wrong semantics for the `?raw` contract. **The lesson,
now recorded in the stanza comment: vite-native affordances (`?raw`) are invisible to
wrangler's esbuild — a `?raw` import needs an explicit `Text` rule whose glob carries
the query, and `?json` + `?raw` silently inverts to parsed-object under esbuild's
default loader.** The incident lived 13:01:30 → 13:15:31 UTC (~14 min). The fix
(981c098): `"globs": ["**/*.svg?raw", "**/*.json?raw"]`.

Deploy-tree methodology (REDEPLOY10–17 detached-worktree pattern): worktree at each
GO commit (moved forward 96cb9d4 → 7d4c19a → 52a1f52 → 981c098 by checkout; one
install, warm store), `git submodule update --init` (pin `fc4936884584` verified),
`pnpm gen:icons` (39 icons, 15883 bytes), the scratch asset build
(`build-gitea-assets.mjs --work /tmp/gitea-assets-build-rd18 --skip-install`, 17M)
BEFORE the vitest gate, `.dev.vars` copied 0600. The main working tree was never
modified by this agent (its sole write is this evidence block); worktree verified
0-tracked-dirty immediately before each `wrangler deploy`. Scratch dry-run bundles
(`--dry-run --outdir`, throwaway config copies, deleted after) proved every stanza
variant BEFORE asking for the commit: `**/*.svg` + fallthrough does NOT match (the
4ed30cc form failed from this worktree where the author's main-tree dry-run hadn't);
`**/*.svg?raw`, `**/*.svg*`, `**/*.svg**` bundle clean; the landed `**/*.json?raw`
extension bundles clean at 6996.25 KiB / gzip 1434.73 KiB (52a1f52 tree) — the
proper-install worktree was the authority both times.

Deploy gates — at 981c098 (final tree): `pnpm typecheck` **0 errors**; `check:api`
**PASS** (declared **490** ops/298 paths, tier-1 **78/78 paths, 129/129 ops**);
`check:contract` **PASS** (sha256 `529a3314…`, verbatim — identical to
REDEPLOY14–17's pin). Same verdicts re-verified at 96cb9d4, 7d4c19a, 4ed30cc and
52a1f52 along the way. Vitest: the box carried sibling-wave load the whole window
(loadavg up to ~12, 27/31 GB used) and FOUR full runs hit the load-flake class —
every failure a 30 s timeout (pull-engine fork-head arms = the documented class,
invariants eviction, lifecycle rename-back, goldens/wave6/wave7/users/issue-events/
webhooks/misc-t3 harness hooks) plus `vitest-pool: Worker cloudflare-pool emitted
error` infra crashes that ATE 3 files' results in the best run. Disjoint failure sets
every time; isolation adjudications all green: 89/89 + 114/114 + 76/76 + 79/79. The
best single run (7d4c19a): **3537 passed | 5 skipped (3542), 0 failed, files 164
passed | 1 skipped (168), 98.87 s** — exit 1 from 3 pool-crash victims only
(users/issue-events/a11y), which then passed 76/76 in isolation. Composite: every
suite file green somewhere, zero product-code failures, zero adjudications against
the diff. The run of record is the composite (the suite never got a quiet box).

Remote migrations: **ledger unchanged — zero diff `7cd1ce9..981c098` in
`src/db/migrations/`** (verified per-GO); explicit `wrangler d1 migrations apply
--remote` at a842cfd8: **"✅ No migrations to apply!" (33/33)**; smoke's
migrate-check independently confirms the remote schema (below).

`pnpm smoke` (deploy-smoke.mjs, run PAT as Basic password): at a842cfd8 with
`--migrate-check` — **6 pass / 0 fail / 1 skip, exit 0** (`healthz {"ok":true}`;
anon-git-surface 404/401 shapes; receive-advert 165 B; push-lsremote pushed `3eeb83c052…`
with the anonymous advert 401; cleanup 204; migrate-check all 19 expected tables
+48 system/aux). Re-run at abfbf291 — **4 pass / 0 fail / 2 skip, exit 0** (schema
unchanged by a config commit; migrate-check not re-requested).

**THE TOOLKIT'S FOURTH PRODUCTION RUN — `all` (7 batteries) at a842cfd8: 65 checks,
64 pass, the ONE red an order-of-operations artifact adjudicated below** (the final
audit counted this run's still-alive PAT: `tokens=2 (expected 1)`). The PAT-identity
preflight passed silently. Mint-per-run PAT in a 0600 file, extracted BEFORE the mint
log was shredded (the REDEPLOY17 lesson, applied cleanly — `^\s+cfg_[0-9a-f]{8}_[A-Z2-7]{32}$`
line anchor, 45-char shape verified). Battery-by-battery:

- **p0** (`--fixture-oid 502abd2d…`) — 4/4: shallow-since/exclude exit 128 naming
  'deepen-since'/'deepen-not'; depth-1 clone `.git/shallow = 502abd2d55…` fsck clean;
  privacy-anon API 404 + info/refs 401 Basic + web 404.
- **registry** (`--trials 3`) — 18/18: three full tombstone lifecycles, each rename
  carry + **t+0 `repository not found`** + old name dead on both paths.
- **generate-e2e** — 10/10 first-try: template push (main + dev at `8d235319b8…`) →
  PATCH 200 persisted → generate 201 `"empty":false` → carried refs identical tip →
  LICENSE round-trips; `[info] gen-generated-clone — clone SUCCEEDED` (run without
  `--strict`, so informational; the issue stays fixed-shaped, as REDEPLOY17 saw).
- **forkpr-e2e** — 8/8: org fork 202, fork push `prbr-094f5778` at `8060f36f1a…`,
  PR #1 from `prorg-…:prbr-…`, head chain mergeable true with `head.ref refs/pull/1/head`;
  fork→base→org cleanup all 204.
- **mirror** — 8/8 first-try (fourth consecutive): loopback 401 "Permission denied"
  at the door; `.invalid` row 200 fresh-wire; sync 200; settle **1293 ms** naming the
  530 shape; `sync_state='idle'`, `next_sync_at=0`; delete 204, list [].
- **ui-login** — 5/5: anon 0 "New Label" → 303 + cookie → owner renders 3 + small-menu-items.
- **cleanup-audit** — 9/10 in-run (`tokens=2`), then **10/10 after the PAT delete**:
  `owner_repos=1 creating=0 action=0 stars=0 push_mirrors=0 protected_branches=0
  repo_redirects=0 user_blocking=0 tokens=1`.

**THE 7d4c19a TAILS — armed, silent, and that is the honest first production posture.**
All-battery self-sweeps (registry rename-aware re-pointing, forkpr fork→base→org
order, ui-login) no-op'd on green runs — zero `[tail]` lines, zero `[skip]` chains,
zero leftovers for the audit to find. No `--force-red` rehearsals this window (the
incident consumed the rehearsal budget; the knob's production proof stands from
REDEPLOY17 and the new tails carry its exact mechanism).

**THE HAND SPOT — tree-view envelope's closing proof at abfbf291 (verbatim from the
probe).** Private fixture `spot-rd18-b1be2f55` (auto_init) + pushed tree: directory
`pkg/` containing `x&y.txt`, `top.txt`, gitlink `submod` (cacheinfo 160000, no
.gitmodules), symlink `link-to-dir` → `pkg`. `POST /login` → 303 + `gitea_session`.
`GET /{owner}/{repo}/tree-view/branch/main` with ONLY the cookie →
- **200** (the 500s gone), **4027 bytes**, `content-type: application/json;charset=utf-8`,
  `cache-control: max-age=0, private, must-revalidate`;
- **sorted-key + escaped JSON byte-proven**: the envelope opens
  `{"fileTreeNodes":[{"entryName":"pkg","entryMode":"tree","entryIcon":"\u003csvg
  viewBox=\"0 0 16 16\" class=\"svg octicon-file-directory-fill\"…` — Go sorted-map key
  order ('f' < 'r'), `<` as `\u003c`, `"` as `\"` (the goJsonString port, not
  JSON.stringify);
- **the svg-mfi pool**: full fixture `[svg-mfi-document, svg-mfi-folder-git,
  svg-mfi-readme]` — 3 members, all `svg-mfi-*`, emitted in SORTED order; minimal repo
  `[svg-mfi-readme]`; the basic octicons stay INLINE (never pool members), exactly the
  module contract;
- **node arms**: `pkg` tree with `entryIconOpen` set; `top.txt`/`README.md` blob;
  `submod` entryMode **commit** with `submoduleUrl` omitted (unresolvable, upstream's
  omitempty arm); `link-to-dir` symlink with NO open icon;
- **`?sub_path=pkg` descends**: `children [x&y.txt]`;
- **latency, honestly**: first request **891 ms** (the dynamic fileicon edge's first
  production load in a cold isolate) vs warm **479 ms, byte-identical** — the dynamic
  chunk cost lands on the first request only;
- anonymous → **404** (the fixture stays private).

**THE SECOND HAND SPOT — repo-projects (ae32b1a) first production traffic.** Probe
repo → `PATCH {"has_projects":true}` → 200 (the fresh-repo default is DISABLED —
the unit toggle's first production exercise) → anonymous `/{owner}/{repo}/projects`
**404** (disabled-unit/no-leak) → API project create **201** → the projects TAB
(cookie) **200 listing the board title** → board `/projects/{id}` (cookie) **200**.
Column verdict, adjudicated against the submodule: a template-less API create renders
an EMPTY board and that is UPSTREAM-EXACT (`models/project/column.go:95`
createDefaultColumnsForProject returns nil for TemplateTypeNone — upstream seeds
columns only for bug-triage/basic-kanban); the STRONGER arm then proved the seeding
port: `template_type:"basic_kanban"` → board renders **To Do / In Progress / Done**
(upstream `setting.Project.ProjectBoardBasicKanbanType`). The wave's writer pages
(create/edit forms) and the workflow tails stay unprobed (time went to the incident).

Cleanup proof: every battery self-cleaned (registry tombs through their own DELETEs;
generate/forkpr/ui/mirror/smoke repos 204). Spot repos all deleted 204
(`spot-rd18-*` ×3 fixture generations, `spot-rd18p-*` ×3, bisect `rd18a/b/c-*`,
`spot-rd18k-*`, `spot-rd18v-*`). Per-run credential: ONE token minted (id 40,
prefix-scrubbed from every log), deleted by id via Basic-auth token CRUD → **204**,
survivor check **401**; final whole-table `personal_access_tokens` = **1** (the
standing bootstrap PAT) proven by the closing audit alongside `owner_repos=1`
(p0-shallow), `creating=0`, `action=0`, `stars=0`, `push_mirrors=0`. Worktree,
scratch asset dir, dry-run outdir, probe scripts, and all logs shredded; `gitea/`
pristine (0 dirty files, pin `fc4936884584`); main tree untouched except this block.

**OPEN ISSUES carried + NEW:**

1. **NEW (medium — observability, no probe impact observed): 16
   `database table is locked: SQLITE_LOCKED` exception records** in this window's
   wrangler tail, with NO request record attached (unattributed to any URL). Every
   probed surface passed; suspects are cron (*/10) overlapping probe pushes or D1
   write contention between concurrent requests. Needs a dedicated look: are these
   surfacing as user-visible 5xx anywhere?
2. **NEW (process, closed-by-convention): the ?raw deploy lesson** — recorded in the
   wrangler.jsonc stanza comment and above; any future `?raw` import (or any new
   module type riding the entry graph) needs its Text-rule glob and a WORKTREE
   `wrangler deploy --dry-run` before the commit lands — main-tree dry-runs with a
   divergent node_modules proved non-authoritative twice this window.
3. Carried unchanged: the repo payload `fork`/`parent`/`mirror` serializer stubs; the
   bare `owner:branch` PR head form with a renamed fork answers 404 (documented
   divergence); API tag create answers 200 where upstream answers 201.
4. Unprobed this window (in-flight, not regressions): repo-projects writer forms +
   workflow tails; blob-excerpt/lastcommit route mounts (mechanism-only this window).

The ws1009 runner-death class stayed at 0 in every full run (the pool errors were
workerd socket deaths at the pool layer, not the 1009 graph-snapshot signature).

*(REDEPLOY18, evidence appended by the redeploy-verification agent; all numbers
verbatim from this run's commands.)*

---

## REDEPLOY19 — the post-18 mass: closures + index window @ `e39adad` (2026-10-26)

GO named commit `e39adad` (the "closures window": the carried-OPEN closures —
payload stubs + parent read-gate + route swaps `3fcbe1a`/`a55a725`, renamed-fork
fork-edge `9ecb3e5`, tag-note `aaea049`; the index window routes `67adfb7`
[blob-excerpt + wiki twin, lastcommit, fetch-attrs flip]; search filters
`e39adad`; docs units). The in-flight org-settings / modules / sweep units were
UNCOMMITTED at GO and excluded by construction (the worktree recipe's whole
point) — they ride REDEPLOY20. Gates ran twice: at window-open HEAD `67adfb7`
(main tree, typecheck 0 / lint 0 / four full-suite runs all adjudicated
infrastructure) and per-GO at `e39adad` in the worktree (below).

**Deploy: version `35e43cef-5b0f-4d28-bea2-1081c48c48ba`, Worker startup
158 ms, at `https://cf-gitea.hecongw.workers.dev`** — from the detached
`git worktree` at exactly `e39adad` (the main tree carried the siblings' 3
dirty paths; the worktree had 0). Proper install (the RD18 standard):
`pnpm install --frozen-lockfile` (185 ms warm store), prebuilt `public/assets`
copied in, `.dev.vars` copied in, `git submodule update --init` inside the
worktree (pin `fc4936884584a419` — identical, the main checkout's submodule
verified pristine after), `pnpm gen:icons` (39 icons regenerated). Worktree,
dry-run outdir, spot script and every log shredded after; the main working
tree untouched by this agent except this block.

**Deploy gates at `e39adad` (worktree):** `pnpm typecheck` **0 errors**;
`check-openapi` **PASS** (declared **490 ops / 298 paths** ⊆ contract; tier-1
**78/78 paths, 129/129 ops**); `check-contract` **PASS** (sha256 `529a3314…`,
matches the README and the pinned submodule swagger verbatim). Vitest: TWO
composites (`--maxWorkers=8` then `=4`) — **0 test failures** (2818 passed +
5 skipped, then 2580 + 5) but 44 files POOL-KILLED in both runs (44–50
`[vitest-pool]: Worker cloudflare-pool emitted error` per run); the 44-file
dead-set ran SOLO: **855 passed + 5 skipped, exit 0**. Combined honest line:
**170 files green + 1 skipped (171), 0 failed anywhere** — the
composite-plus-solo-greens adjudication. Machine load 6.4+ throughout
(in-flight sibling suites running concurrently).

**THE ws1009 CLASS REAPPEARED — this time it IS the death mechanism.** Every
pool death in every full run this window carries the
`WebSocket protocol error; protocolError.statusCode = 1009;
protocolError.description = "Message is too large"` signature (78 / 144 / 12 /
138 hits across the four main-tree full runs; 132 / 150 in the worktree
composites; **0 in the solo group run**). RD18 recorded the class at 0 with
"workerd socket deaths at the pool layer, not the 1009 signature" — that
conclusion does NOT hold for this window: the vitest-pool WebSocket frame cap
is the thing dying, only under heavy machine load, and always solo-green.
The composite+solo adjudication stands, but a runner-side look at the pool's
frame size is now warranted (open issue below).

Remote migrations: **ledger unchanged — zero diff `981c098..e39adad` in
`src/db/migrations/` (33 on disk, verified at both HEADs)**; explicit
`wrangler d1 migrations list --remote`: **"✅ No migrations to apply!"
(33/33)**; smoke's migrate-check independently confirms the remote schema
(below).

**The worktree dry-run bundle verification (the RD18 standard) — clean, and
the ?raw stanza needed nothing:** the `?raw` extension set in the deploy graph
is unchanged since the `981c098` deploy (`*.svg?raw` / `*.json?raw` only; the
one NEW file touching `?raw` since is test-only `suite.test.ts`).
`wrangler deploy --dry-run` at `e39adad`: **index.js 5,726,209 B** + 9 raw
chunks, every Text-rule chunk byte-exact — `material-icon-svgs.json` emitted
at **998,898 B == the source file's size** (the raw-string treatment, not the
parsed-object loader that killed RD18), all chunks referenced from index.js.

**THE TOOLKIT'S FIFTH PRODUCTION RUN — `all` (7 batteries) at
`35e43cef…`: 65 checks, 64 pass, the ONE red the RD18-identical
order-of-operations artifact** (the closing audit counted the run's
still-alive PAT: `tokens=2 (expected 1)`; 10/10 after teardown, below).
Mint-per-run PAT in a 0600 file (two mint incidents — process lesson below),
extracted and shape-verified BEFORE the mint log was shredded. Battery by
battery:

- **p0** (`--fixture-oid 502abd2d…`) — 4/4: shallow-since/exclude exit 128
  naming 'deepen-since'/'deepen-not' (5400/3933 ms); depth-1 clone
  `.git/shallow = 502abd2d55…` fsck clean (4084 ms); privacy-anon API 404 +
  info/refs 401 Basic + web 404.
- **registry** (`--trials 3`) — 18/18: three full tombstone lifecycles, each
  rename carry + **t+0 `repository not found`** + old name dead on both paths.
- **generate-e2e** — 10/10 first-try: template push main+dev at `531efb9367…`
  → PATCH 200 persisted → generate 201 `"empty":false` → carried refs
  identical tip → LICENSE round-trips; **`[info] gen-generated-clone — clone
  SUCCEEDED`** (the carried git-wire issue stays fixed-shaped, third window).
- **forkpr-e2e** — 8/8: org fork 202, fork push `prbr-f686c077` at
  `4390f300c3…`, PR #1 from `prorg-…:prbr-…`, head chain mergeable true with
  `head.ref refs/pull/1/head`; fork→base→org cleanup all 204.
- **mirror** — 8/8 first-try (**fifth consecutive**): loopback 401
  "Permission denied" at the door; `.invalid` row 200 fresh-wire; sync 200;
  settle **1524 ms** naming the 530 shape; `sync_state='idle'`,
  `next_sync_at=0`; delete 204, list [].
- **ui-login** — 5/5: anon 0 "New Label" → 303 + cookie → owner renders 3 +
  small-menu-items.
- **cleanup-audit** — 9/10 in-run (`tokens=2` artifact), **10/10 after the PAT
  teardown**: `owner_repos=1 creating=0 action=0 stars=0 push_mirrors=0
  protected_branches=0 repo_redirects=0 user_blocking=0 tokens=1`.

**THE HAND SPOTS — 34/34 on the final pass (throwaway script, shredded).**

- **THE PAYLOAD SPOT (the `3fcbe1a`/`a55a725` closures, first production
  traffic).** Private fixture `spotpl-d3fef8b3` (auto_init) → fork
  `spotpl-f-d3fef8b3` (202, inherits private) → PATCH the fork
  `{"private":false}` (200 — the fork now READABLE to strangers while the base
  stays private, the exact shape the read-gate exists for) → **owner GET:
  `fork:true` + `parent.full_name` = the base** (the reader arm) → **anonymous
  GET: 200, `fork:true`, `parent` KEY ABSENT** (the stranger-on-private-base
  arm — our "empty is better than wrong" tightening, upstream's FIXME
  conceded). The mirror triple: `POST /repos/migrate` with a `.invalid`
  clone_addr → 201; **detail GET `mirror:true` + `mirror_interval:"8h0m0s"` +
  `mirror_updated` stamped** (the schedule arm live on the detail GETs). ONE
  MINOR FINDING: the **201 born body renders `mirror:false`** — the route
  renders `outcome.repo` (the pre-`registerMirror` snapshot) while the detail
  GET is honest; suggested fix is rendering from the re-read pair the route
  already fetches for the emission (open issue below).
- **THE RENAMED-FORK SPOT (the `9ecb3e5` fork-edge, first production
  traffic) — the cross-owner shape.** Base `sptrf-d3fef8b3` → org
  `sprorg-d3fef8b3` → fork into the org (default slug) → refs settle →
  **PATCH rename the fork** → `POST /repos/{base}/pulls` with the bare
  `sprorg-d3fef8b3:main` head → **201**, and **`head.repo.full_name` = the
  RENAMED fork** (`sprorg-d3fef8b3/sptrf-f2-d3fef8b3`). The pre-rename name
  never existed as a live path at PR time, so this is the name-free fork-edge
  resolution proven — upstream's name-only lookup would have 404'd here. A
  same-owner probe arm (first design iteration) CORRECTLY found the base: the
  bare `owner:branch` grammar short-circuits to the base when head owner ==
  base owner (pulls.ts's same-owner arm) — for a same-owner
  differently-named fork that matches upstream's own name-based lookup
  outcome, so it is documented spot-design, not a bug.
- **THE FRAGMENT SPOT (the `67adfb7` index-window routes, first production
  traffic).** Fixture `spotbe-d3fef8b3` + contents-API commit `notes.txt`
  (10 lines), tip `e936b21f3bf0…`. **blob_excerpt button arm** (gap
  `right−last_right` = 39 > `BLOB_EXCERPT_CHUNK_SIZE` 20): **200, 1526 B,
  `code-expander-button` + `data-fetch-url` + `data-expand-direction`** — the
  expander machinery live. **blob_excerpt merged arm** (gap 4 ≤ 20): 200 with
  the `same-code` rows and **NO buttons** — the fully-merged zeroed-hunk arm,
  upstream-exact. Bogus sha → **404** (the loader's null family).
  **lastcommit (canonical no-slash form): 200, 2663 B, `#repo-files-table`**
  with per-row commit summaries (the `Initial commit`/`add notes` links + age
  cells) — the exact standalone fragment the bundle's htmx morphs. **LATENT
  FINDING: the root-listing SLASH form** (`/lastcommit/{oid}/` — the exact
  bytes the wave-46 component emits for root listings, "the trailing slash
  rides verbatim") **answers 404**: the top-level dispatcher's
  `!pathname.endsWith("/")` gate (src/index.ts:130) routes EVERY repo-scoped
  slash path to the engine before the sub-app's `trimTrailingSlash()` (which
  does 301 correctly for non-repo-scoped paths — `/explore/` → 301) ever sees
  it. Latent only — no page passes `loaderCommitOid` yet — but it must be
  fixed BEFORE the page flip lands (open issue below). The **notready row**:
  a pushed 31-file directory (`ENRICH_MAX` = 30) renders the
  `repo-file-cell message commit-summary notready` cell on the tree page with
  the `data-fetch-*` attrs ABSENT — the landed flip is component-level
  (opt-in `loaderCommitOid`), no page caller passes it yet, exactly the
  committed diff's own note ("callers without the commit id render the
  pre-flip shape").
- **THE WRITER-FORMS SPOT (RD18's unprobed repo-projects tail — closed).**
  Login-cookie methodology end-to-end on `spotprj-d3fef8b3`:
  `PATCH {"has_projects":true}` → 200 → **GET `/projects/new` 200** (the
  writer form renders) → **POST create** (`title`/`template_type=basic_kanban`)
  **303 → the projects tab**, which **lists the title** → the board renders
  **the basic_kanban seed trio To Do / In Progress / Done through the FORM
  path** (RD18 proved the API path + template seeding; the form arm was the
  gap) → **POST `columns/new` 303** → the board renders the new column →
  **POST `/projects/{id}/delete` 303** → the tab no longer lists it. Full
  writer lifecycle 11/11.

`pnpm smoke` (deploy-smoke.mjs, run PAT, `--migrate-check`) at `35e43cef…`:
**6 pass / 0 fail / 1 skip, exit 0** (`healthz {"ok":true}`; anon-git-surface
404/401 shapes; receive-advert 165 B; push-lsremote pushed `8785c6d02a…` with
the anonymous advert 401; cleanup 204; migrate-check all 19 expected tables
+48 system/aux). The P0 trio rode the `p0` battery (4/4 above).

Cleanup proof: every battery self-cleaned (zero `[tail]` lines in the `all`
run; registry tombs through their own DELETEs; generate/forkpr/ui/mirror/smoke
repos 204). Spot repos all deleted 204 (`spotpl-*` ×3, `sptrf-*`/org ×3, 
`spotbe-*`, `spotprj-*`, plus the probe-debug fixture `be2-*`); the renamed
fork's pre-rename slug answering 404 on cleanup is the rename itself proving
the redirect tombstone. Per-run credential: the closing audit's
`personal_access_tokens = 1` (the standing bootstrap PAT) alongside
`owner_repos=1` (p0-shallow), `creating=0`, `action=0`, `stars=0`,
`push_mirrors=0`. Worktree, dry-run outdir, spot script, probe-debug
scratch, and all logs shredded; `gitea/` pristine (0 dirty files, pin
`fc4936884584`); main tree untouched except this block.

**OPEN ISSUES carried + NEW:**

1. **NEW (minor, real — the migrate 201 born body): `mirror:false` on the
   born repo's 201 body.** `routes/mirror.ts` renders the body from
   `outcome.repo` — the `RepoService.create` snapshot BEFORE
   `registerMirror` flips `is_mirror` — while the detail GET (the honest
   arm, and the battery's fresh-wire shape) is correct. One-line-shaped fix:
   render the 201 from the pair the route already re-reads for the emission.
2. **NEW (latent, real — the lastcommit root-listing slash form 404s at the
   dispatcher).** The wave-46 `RepoFilesTable` flip emits
   `{repoLink}/lastcommit/{oid}/{pathEscapeSegments(dirPath)}` — for the ROOT
   listing that is `/lastcommit/{oid}/` WITH a trailing slash
   (view.go:296-297 verbatim). The top-level dispatcher's
   `!pathname.endsWith("/")` gate (src/index.ts:130) hands every repo-scoped
   slash path to the engine (404), so the sub-app's `trimTrailingSlash()`
   (which redirects correctly — `/explore/` → 301) never sees it. NO shipped
   page emits that URL yet (the flip is component-level), but the page flip
   that passes `loaderCommitOid` will ship this 404 for every root listing's
   loader fetch. Fix before that wave: let slash paths whose trimmed form
   `handlesUiRoute` claims into the sub-app (its trim middleware already
   guards laundering), or emit the loader URL slash-free for roots.
3. **NEW (runner health): the ws1009 "Message is too large" class is the
   pool-death mechanism this window** (counts above; RD18 recorded 0 with a
   different signature). Always solo-green; suspected amplifier is machine
   load 6.4+ from concurrent sibling suites. A vitest-pool frame-cap look
   (or a load-adaptive worker count for full runs) is the suggested next
   move for the runner owner.
4. **NEW (process, closed-by-convention): the PAT mint-extraction regex in
   RD18's block (`[A-Z2-7]{32}`) does NOT match the mint alphabet** —
   `bootstrap-admin.mjs` uses `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no
   I/O/0/1); the toolkit's own `--token-file` validator has the correct
   class. Two orphan rows resulted (my first mint shredded unextracted; the
   smoke `--token` argv form + a failed Basic-auth list parse led to a shred
   before the API delete) — both recovered by-id via D1 and both proven by
   the closing audit's `tokens = 1`. Always copy the regex from
   deploy-probes.mjs:1432, never from the evidence prose; extract, VERIFY
   the 45-char shape, delete, THEN shred.
5. Carried unchanged: the repo payload numeric-`id` render (`id:0` for the
   text-id registry keys — `repositoryIdNumber`'s documented TODO(SPEC-0005);
   re-confirmed on create/GET/fork bodies this window, not a regression);
   RD18's SQLITE_LOCKED posture (verdict landed at `280d4ad` — platform-side
   DO-SQLite benign-retry, ignore-with-filter; no new observation this
   window, no tail attached). The carried-OPENs ledger is EMPTY per
   `075f916` and this window PRODUCTION-PROVED the closures: the payload
   stubs + parent read-gate (spot 1), the renamed-fork bare-head (spot 2),
   the tag-note closure (docs-only `aaea049`, no runtime surface).
6. Hygiene note (not this run's): `/tmp/leak-repro/*` — a 2026-10-25 scratch
   from an earlier window — still holds an old-shaped token file; the audit
   proves it revoked (`tokens = 1`), but its owning wave should shred the
   directory.

*(REDEPLOY19, evidence appended by the redeploy-verification agent; all
numbers verbatim from this run's commands.)*

## REDEPLOY20 — the index window + the deferred-matrix polish: deploy-prep evidence @ `03f9e82` (2026-10-27)

This is the PRE-DEPLOY evidence block: the cargo is fully committed and
gate-verified at HEAD `03f9e82`; the live deploy numbers are marked
**TODO (post-deploy)** below and will be pasted by the orchestrator
after the run. The window since the RD19 deploy base `e39adad` is 126
commits (24 to the tick-10 base `b396a41`, then the 102-commit tick-11
window b396a41..`03f9e82`).

**THE CARGO — the two-stage program completed its second stage.** The
module waves (seventeen two-stage page modules across the pre-window
commits — the user-settings tab family, the org blocked-users/actions
tabs, the admin dashboard + monitor group, the four repo-settings
tabs, the wiki family flagship, the sitemap family, the search aux
feeds, the issues aux feeds, the compare byte feeds + files-for-range,
the merge-box fragment, the issue info/attachments/content-history
fragments, the global inbox pages, the .rss/.atom envelopes, the
editor staging family `dc9ff97`, the cherrypick/patch pages, the
branches writer arms, the upload tails) MOUNTED in **fourteen window
commits, sub-waves 2a-2f, 92 routes**: window-2a the user-settings tab
family (8 modules, 19 routes, `0c2b151`), window-2b the org
blocked-users tab + actions secrets/variables (9, `4f2805f`),
window-2c the admin group (7, `e31c0cf`), window-2d both passes (four
repo-settings tabs 13, `b54f709`; the wiki-config arm 2, `46e7e68`),
window-2e in eight slices (sitemap + search aux 6, `84996c6`; the
global inbox 3, `a8818c6`; the .rss/.atom envelopes 1, `1a59af0`; the
repo-scoped aux feeds + fragments 11, `22599e4`; the wiki family 4,
`9516bf1`; editor tails + cherrypick/patch 8, `1d834d6`; the migration
page 2, `62ef380`; the subscriptions/watching tails 2, `5ca1727`) plus
the folds (branches writer arms + pulls/new + the upload endpoints 5,
`635ce2e`); then window-2f — the 13-site shared-navbar swap
(`94c6851`) and the SettingsNav fold (`d32db26`, the scaffold navs
deleted). One deliberate non-mount: the profile `?tab=activity` page
arm (`ec07fb6`) — its seam + rendering vocabulary landed into the
.rss/.atom envelopes instead; the page render is the survey's last S
bench row. Survey headline after the window: **88/7/20, zero rows in
flight** (115 rows; the tick-11 survey edition).

**THE POLISH — the deferred-matrix program walked every mounted page.**
52 matrix/route-arm commits whose subjects tally **1,170 cases** (plus
the appearance tab's route-arms matrix, unnumbered), catching **18
real UI bugs**, all fixed in-window:

- **The dead-route class (FOUR, one lesson):** the mounted wiki family
  unreachable — parse + registration order unshadowed (`a58cad5`);
  `/repo/search` + `/repo/migrate` shadowed by the dynamic owner/repo
  block (`f60e5a8`); the pulls/new redirect dead behind its own parse
  claim + a slice(5) mismatch (`3837c17`); issues/search + suggestions
  under the `/:index` catch (`c4a1723`). Process note recorded in the
  survey: module-green is not route-live — every mount proves its
  routes through the live router, static literals register ahead of
  any dynamic segment that could shadow them.
- **The security pair:** the cherrypick/patch POST arms missing
  sameOriginGuard — CSRF closed (`27aa538`); the session clear-cookie
  directive double-wrapped on EVERY UI page (`dee8cf0`).
- **The wire-format divergence:** PR comments anchored under /issues —
  commentHtmlUrl's is_pull branch (`89589b3`).
- **The rendering-ladder class:** merged PRs say merged —
  GetLastEventLabel's nesting (`6ecb21c`); the comment block's
  archived/locked ladder (`a12ecdf`); archived mirrors render the
  warning ONLY (`cdde728`); archived branches hide the delete button
  (`234ee49`); the conditional Public Access item on the branches +
  collaboration tabs (`364bf92`).
- **The gates/wiring class:** unknown-uid access-mode changes refuse
  (`f8c84fc`); unknown commit-sha refs 404 on the commits page
  (`188f33d`); the repo-scope workflow-delete GET 405 verb-twin
  (`d23ad32`); tags path-keyed edit + delete flash (`01fae9e`); the
  keys SSH delete-miss error line + carried form values (`18383fe`);
  the sitemap idx guards + the repo-search API-Viewer bridge
  (`c2925f2`).
- **The stale-pin sweep (~18 sites):** the sweep doc
  `docs/compat/stale-pin-sweep.md` (five pin lines across four files,
  `04d80b3` — mechanical evaluation of 243 negative literals + 122
  boolean pins against the live parser) plus thirteen more
  pin/golden updates (`e2cade9`, `0c66990`, `5e26d76`, `ef23c5e`,
  `f41237f`, `41bc9ab`, the four repo-settings goldens `2c7c05f`, the
  wave-17 pin flip riding `635ce2e`).

**Pre-deploy gates at HEAD `03f9e82`:**

- `node scripts/check-openapi.mjs`: **PASS** — declared **490 ops /
  298 paths** ⊆ contract; tier-1 **78/78 paths, 129/129 ops**
  (re-run by this agent while writing this block).
- `pnpm typecheck`: **0 errors** tree-wide (re-run by this agent).
- `pnpm lint` (eslint): **0** (the window's closing gate).
- **src/ui full suite: 997/997.** The broader run hit the documented
  contention ceiling — 8 files 30s-timeout under concurrent sibling
  load — and **ALL eight are solo-green**: engine-read 53/53,
  migrate+tags 14/14, push-sync+pull-engine+imports 68/68. (The RD19
  ws1009 pool-death class did not reappear as a failure source this
  window — timeouts only, every one adjudicated solo.)

**Remote migrations: ledger expected UNCHANGED — zero diff
`e39adad..03f9e82` in `src/db/migrations/` (33 on disk, verified;
the window added none).** Expected at deploy: `wrangler d1 migrations
list --remote` → "No migrations to apply" (33/33).
**TODO (post-deploy): paste the actual list output.**

**DEPLOY PLAN (the RD18/RD19 standard) — live numbers TODO
(post-deploy, orchestrator pastes):**

- GO commit: **TODO** (expected `03f9e82` or its landing descendant;
  gates re-run at GO in the detached worktree).
- Detached `git worktree` at the GO commit, `pnpm install
  --frozen-lockfile`, prebuilt `public/assets` copied in, `.dev.vars`
  copied in, `git submodule update --init` (pin `fc4936884584`),
  `pnpm gen:icons`. Worktree shredded after.
- Deploy version id: **TODO**. Worker startup: **TODO ms**. URL:
  **TODO** (`https://cf-gitea.hecongw.workers.dev`).
- `wrangler deploy --dry-run` bundle: **TODO** (index.js bytes + the
  raw-chunk table; the `?raw` extension set unchanged — `*.svg?raw` /
  `*.json?raw` only — spot `material-icon-svgs.json` byte-exact).
- **The NEW battery: `window2-mounts` (the toolkit's 8th, `684f834`,
  22 checks)** — login round-trip via POST /login form (PAT as
  password, the ui-login methodology) then the window's mounts
  first-production-probed: **TODO (paste the 22-check result)**.
- The full `all` toolkit run (8 batteries incl. window2-mounts):
  **TODO (paste per-battery lines)**. Mint-per-run PAT in a 0600
  file; extract, VERIFY the 45-char shape, delete, THEN shred (the
  RD19 mint lesson — copy the regex from deploy-probes.mjs, never
  from evidence prose).
- `pnpm smoke` (--migrate-check): **TODO (paste)** — expected: the
  19 expected tables +48 system/aux, "No migrations to apply".
- Hand spots: **TODO** (suggested: the cherrypick/patch POST CSRF
  guard — a cross-origin POST must now 403; the wiki family end-to-end
  (the dead-route fix's first production traffic); /repo/search +
  /repo/migrate reachability; the upload staging write path).
- Cleanup audit: **TODO** (expected: every battery self-cleaned,
  `personal_access_tokens = 1` standing bootstrap PAT).

**OPEN ISSUES carried + status:**

1. RD19 #1 (the migrate 201 born body rendering `mirror:false`) and
   #2 (the lastcommit root-listing trailing-slash 404) — BOTH FIXED by
   `8a1a03f` (post-RD19-deploy, in this cargo): the born-body
   post-attach re-read + the route-matcher trailing-slash carve.
   **They see first production traffic at REDEPLOY20** — the hand
   spots should re-probe both shapes.
2. RD19 #3 (the ws1009 pool-death class under load): no full-run
   recurrence this window (timeouts only, all solo-green); the
   runner-side vitest-pool frame-cap look remains open for the runner
   owner.
3. Carried unchanged: the repo payload numeric-`id` render
   (TODO(SPEC-0005)); the SQLITE_LOCKED benign-retry posture (verdict
   `280d4ad`); `/tmp/leak-repro/*` shredding (its owning wave).

*(REDEPLOY20, deploy-prep evidence appended by the deploy-prep docs
agent; gates re-run verbatim at `03f9e82` — openapi + typecheck by
this agent, the suite numbers from the window's closing gate run;
live deploy numbers are TODO slots for the orchestrator's post-deploy
paste.)*

**REDEPLOY20 LIVE RESULTS — paste 1 (2026-10-27, deployment of
`a486853`, version id `c4e8a373`, URL `https://cf-gitea.hecongw.workers.dev`;
suites + deploy-prep gates ran in the detached worktree per the plan
above):**

- **Bug #19 found live and fixed in-flight**: UI HTML carried NO
  `Cache-Control`, so the workers.dev edge heuristically cached
  per-viewer pages for minutes — the creating browser saw a stale
  secrets row list while a fresh cookie saw the truth. Fixed by the
  zero-option middleware (`max-age=0, private, must-revalidate` on
  every UI HTML response) inside `a486853` itself; window2-mounts
  went **22/22 once post-fix**.
- **Toolkit re-verify (post-fix, cleanup agent, JSON-captured
  verbatim):** p0 `4/4`; registry `21/21`; generate-e2e
  `9 pass + 1 info` (the known git-wire note); forkpr-e2e `8/8`;
  ui-login `5/5`; mirror `8/8`; window2-mounts `12 pass / 9 skip /
  1 fail` — **deterministic ×3 runs**; cleanup-audit `9 pass / 1
  fail`.
- **Bug #20 — VERDICT REVERSED (root-caused as a PROBE bug, not a
  product write drop): the window2 battery minted lowercase-hex secret
  names while the service stores `normalizedName` (`strings.ToUpper` at
  insert AND lookup — upstream `InsertEncryptedSecret` secrets.go:31) and
  the page renders the stored spelling.** The row was on the page from
  t+0 as `W2SEC_<UPPER>`; the case-sensitive grep hunted the lowercase
  mint and could never match. Cross-evidence: the failure tail's by-name
  API DELETE returned 204 on every red run (the DELETE lookup
  uppercases too — 204 means the row existed); D1 read replication is
  `disabled` (single primary — a stale read was never possible); no
  `age`/`cf-cache-status` markers; manual case-safe probes rendered
  instantly. The earlier "count = 0 after create" reading was measured
  post-sweep. Fix `8a8d35f` (probe mints uppercase + normalizes both
  sides + a pinning test); **no worker change — no redeploy needed for
  this fix**. Both dispatched diagnostic agents independently converged
  on the same root cause; the corrected battery should read 22/22 at
  the wrap re-run.
- Cleanup audit fail explained: `personal_access_tokens` = 2 (the
  standing bootstrap + the **live RD20 run PAT, id 44** — minted per
  the 0600-file rule, deletion deferred only because the in-flight
  diagnosis agents still use it; delete + re-audit at wrap).
  `secrets` is otherwise clean of W2* residue (10 battery rows
  DELETEd via API 204 + one orphan `PROBE_SEC` via D1); two
  `W2DBG_*` diagnosis rows persist pending the bug agent's cleanup.
- **Slots re-captured at the WRAP redeploy** (after the bug-#20 fix
  lands, the same battery set re-runs): worker startup ms, dry-run
  bundle table, `pnpm smoke --migrate-check` paste, the hand-spot
  outputs, `wrangler d1 migrations list --remote` paste (note: the
  content-history wave adds migration `0033` — the wrap deploy will
  apply it remotely), and the two force-red rehearsals (both ran
  RED pre-fix at row-visible, as designed; re-run for the honest
  post-fix verdict).

**REDEPLOY20 LIVE RESULTS — paste 2, FINAL (2026-10-27 late: GO `50479cb`
→ deploy version `d18e6002`; migrations `0033`+`0034` applied remote ✅;
healthz 200 @3.0s cold):**

- **The standing gate passed at GO**: full-suite composite gate (ADR-0006,
  `pnpm test:full`) — phase-1 full run (58 ran / 47 pass / 202 ws1009
  deaths / 0 assertion) + `--solo` adjudication **213 files, 0 fails**;
  total wall 13.7 min, clean tree. Two determinism debts the gate's
  assertion-fatal path caught en route were fixed before GO (wave8's
  stale delete-form pin `4b86214`; mirror/sync's delivery-bleed floors
  `c50fb52` — both the stale "no queue consumer" assumption class).
- **Battery verdict (9 batteries, 60s probe budgets)**: p0 4/4 ·
  registry 21/21 · generate-e2e 9+1i · forkpr-e2e 8/8 · ui-login 5/5 ·
  mirror 8/8 · window2-mounts 22/22 · **window3-mounts green on its
  first mounted run** (the 25-check battery written against the
  pre-mount shapes) · cleanup-audit 9/1. The ONE audit fail is
  `personal_access_tokens = 2` — the run PAT deleted at wrap close
  (this paragraph is the record; the standing bootstrap = 1).
- **Two live findings folded back**: (1) the heavy flows
  (generate --strict, mirror create, t2 rename) legitimately exceed a
  20s probe budget on a fresh deployment — every "timeout" had left its
  repo server-side; budgets now 60s (`run's probe commit`); (2) the
  wiki-raw 304 carries the blanket zero-option Cache-Control (b1bf73a
  wraps every UI response — httpcache's return-before-stamp quirk lives
  only in the module's raw response); the probe pins the deployed truth
  (`ba820b6`).
- **Force-red ×2 rehearsed post-fix**: w2-secret-row-visible and
  w3-wiki-raw-coded-200 both forced red cleanly (fail=1, siblings pass,
  tails swept, zero left_behind).
- ws1009 knowledge closed out this window: the structural ledger, the
  graph sizing + Plan-A falsification, the sanitized upstream issue
  draft, ADR-0006, and the CI gate wired to `pnpm test:full` with
  evidence artifacts. The B lever (sourcemap strip) is queued next.

**REDEPLOY21 LIVE RESULTS (2026-10-28 00:4x, GO `cee057b` → deploy
version `fe6bcca1`; healthz 200 @2.3s; migrations: none pending —
0033/0034 applied at RD20):**

- **The gate at GO**: single-pass strip-mode full suite in the worktree —
  **261 files / 5,831 tests / 0 failed / exit 0** (the second perfect
  single-pass of the night; the contention class formally RETIRED — the
  per-file 90s budgets + the GPG minute-boundary guard were the last two
  real members).
- **The polish cargo deployed** (~60 commits): the settings options
  field set + exact-carry, the branches default-branch select (module +
  mount + route arms), the compare nothingToCompare parity + the
  empty-PR creation loop, the icon.tmpl glyph chain tree-wide, the
  `?q=` alias, the LIKE→instr sweep (11 sites), the R5/R6 a11y fixes
  (scope sweeps + the pencil + the definition-shape rule), the route
  clock + 67 goldens, the census's last slices (comments/attachments
  JSON + issues/new/choose), matrix batches 1-14 (~360 arms total).
- **Battery (9, PAT rd21-run)**: p0 4/4 · registry 21/21 · generate-e2e
  10+1i · forkpr 8/8 · ui-login 5/5 · **mirror 8/8 on the WARM rerun**
  (the first run's mir-sync-settle was the cold-consumer first-sync
  latency — the RD20 cold class, warm-green) · window2 22/22 ·
  window3-mounts green · cleanup-audit 9/1 (the 1 = the live rd21-run
  PAT, deleted at wrap close below).
- **Force-red ×2**: w2-secret-row-visible + w3-wiki-raw-coded-200 both
  forced red cleanly (fail=1, siblings pass, tails swept).
- **Minting incident, disclosed**: the RD21 PAT mint's first attempt
  leaked a plaintext to the orchestrator's terminal (heredoc redirection
  error — the RD20 lesson repeated at one remove). The leaked token was
  NEVER inserted into D1 (the insert failed on wrong columns first) —
  zero server-side exposure; local scratch shredded; the clean mint
  (node -e, stdout never touching the terminal) is the pattern of
  record.
