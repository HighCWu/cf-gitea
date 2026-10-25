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
