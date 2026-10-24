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

## Still pending (not this wave)

- Production deploy + post-deploy `--shallow-since` /
  `--shallow-exclude` probes against
  https://cf-gitea.hecongw.workers.dev (reviewer package: P0 diff + this file
  + post-deploy CLI exit states + `.git/shallow` results).

Reviewer package (per the external review's request): P0 diff + these
probe outputs + post-deploy CLI exit states + `.git/shallow` results.
