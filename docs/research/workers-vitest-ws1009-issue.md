# Upstream issue draft — vitest-plugin runner WebSocket 1009 "Message is too large"

Status: DRAFT ONLY — not filed. Prepared 2026-10-26 by the cf-gitea vitest-contention
investigation (wave-31, agent `wave-ws1009-issue-draft`). All numbers below are from
fresh runs on this machine (2 full-suite runs, 6 subset/solo runs) unless marked as
prior measurements.

**Filing target (verified):** `cloudflare/workers-sdk` — the installed package's
repository field points there:

```json
// node_modules/@cloudflare/vitest-plugin/package.json (v1.4.7)
"repository": {
  "type": "git",
  "url": "https://github.com/cloudflare/workers-sdk.git",
  "directory": "packages/vitest-plugin"
}
```

`@cloudflare/vitest-plugin` is the successor of the deprecated
`@cloudflare/vitest-pool-workers` and lives in the same repo
(`packages/vitest-plugin`, marked `"workers-sdk": { "prerelease": true }`).

---

## Proposed title

```
[@cloudflare/vitest-plugin] Runner WebSocket dies with 1009 "Message is too large" on large transformed modules — constant per-run unhandled errors, exit code 1 on fully green suites
```

## Issue body (paste-ready)

### What versions & operating system are you using?

```
OS:            Ubuntu 24.04.2 LTS (x64), kernel 6.14.0-37-generic
CPU/RAM:       32 cores / 31 GB RAM
Node:          v25.9.0
pnpm:          12.13.0
vitest:        5.0.5
vite:          8.3.5
@cloudflare/vitest-plugin: 1.4.7
miniflare:     5.20261019.2-beta
wrangler:      4.152.0 (bundled plugin dependency)
workerd:       1.20261019.1 (binary shipped by the miniflare pin above)
```

### Describe the Bug

In full-suite runs (~150 test files, one isolated workerd runner per file), a
**constant number of per-file runner WebSockets dies mid-startup** with workerd
protocol error 1009. The affected file set is **deterministic across runs**, the
count is **exactly constant per run** (17 in every run we measured, including 9
prior runs at two different `maxWorkers` values), and — crucially — **all test
files still pass**. Vitest nonetheless reports "Errors 17" and the process exits
**1 on a fully green suite**, which breaks CI.

Each death prints the same workerd exception trio on stderr:

```
uncaught exception; exception = kj/compat/http.c++:6208: failed: jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
exception = kj/compat/http.c++:6208: failed: jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
Uncaught exception: kj/compat/http.c++:6208: failed: remote.jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
```

(plus binary-address `stack:` lines from `workerd`), and vitest's end-of-run
summary attributes each one to a file without failing it:

```
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 17 unhandled errors during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-pool]: Worker cloudflare-pool emitted error.
 ❯ EventEmitter.onTaskError vitest/dist/chunks/index.1TqnEahn.js:5915:21
 ...
Caused by: Error: Worker exited unexpectedly during started state while running test file /…/src/api/orgs.test.ts
 ❯ _WebSocket.emitUnexpectedExit vitest/dist/chunks/index.1TqnEahn.js:5388:33
 ...
 ❯ WebSocket.emitClose node_modules/ws/lib/websocket.js:279:10
```

A companion symptom appears 4-5 times per run, always as bare stderr noise:

```
exception = kj/async-io.c++:2008: disconnected: fixed-length pipe ended prematurely
```

and every run ends with:

```
close timed out after 10000ms
Tests closed successfully but something prevents 2 Vite servers from exiting
```

Note that the plugin already suppresses a sibling family of these workerd
messages in `packages/vitest-plugin/src/pool/index.ts`:

```ts
const ignoreMessages = [
	symbolizerWarning,
	// Not user actionable
	// TODO(someday): this is normal operation and really shouldn't error
	"disconnected: operation canceled",
	"disconnected: worker_do_not_log; Request failed due to internal error",
	"disconnected: WebSocket was aborted",
	...
];
```

— i.e. the "disconnected" aftermath of runner death is treated as normal
operation, but the 1009 cause itself is not in the list and surfaces as the
unhandled errors above.

### Reproduction

**Shape** (from our suite; a minimal repo can be built from this recipe):

- ~150 test files run with the plugin's per-file isolation (155 worker spawns
  per run, ~2-3.6 s startup each), `maxWorkers` 8 (same counts with the default
  31 on a 32-core box).
- The suite contains one **very large generated JSON module** imported by API
  tests: `src/compat/contract/v1-swagger.generated.json` — **983,702 bytes**
  raw. Vite 8's dev SSR transform of it produces **657,304 bytes of code plus a
  2,752,623-byte sourcemap ≈ 3.4 MB** of payload for a single module fetch.
- 18 test files import that JSON directly in normal form; the `?raw` import
  form (transformed code = 1,102,279 bytes) is used by 2 other files.

**What happens, with numbers** (two fresh full-suite runs, identical results;
matches 9 earlier runs at different worker counts):

| Metric | Run 1 | Run 2 |
|---|---|---|
| Runner WebSocket 1009 deaths | 17 | 17 |
| Vitest "Errors" (unhandled) | 17 | 17 |
| Test files failed | 0 | 0 |
| Tests passed | 2959 \| 5 skipped | same |
| `fixed-length pipe ended prematurely` lines | 4 | 4 |
| Process exit code | 1 | 1 |

The 17 deaths are attributed to the **same 17 files in both runs** (deterministic):

```
src/services/issue-events.test.ts   src/api/orgs.test.ts
src/api/users.test.ts               src/api/org-repos.test.ts
src/api/statuses.test.ts            src/api/milestones.test.ts
src/api/routes/wiki.test.ts         src/api/labels.test.ts
src/api/routes/hooks-scopes.test.ts src/api/identity.test.ts
src/api/routes/git-hooks.test.ts    src/api/hooks.test.ts
src/api/routes/blocks.test.ts       src/api/follows.test.ts
src/api/routes/avatars.test.ts      src/api/pulls.test.ts
src/api/repositories.test.ts
```

**Correlation with module size, not file size.** The crash set is not the
heaviest test files by source size (crash files span source-size rank 3 to 127
of 153; the repo's two largest files — 124 KB and 88 KB — never crash). It is
instead:

- **17 of the 18 test files that directly import the 983 KB swagger JSON** in
  normal form. The one direct importer that never crashes is
  `src/api/issues.test.ts` (unexplained).
- **Zero** of the 2 files importing it via `?raw` (transformed code alone is
  1,102,279 bytes — larger than the normal form's 657,304 — yet they never
  crash, suggesting the `?raw` path bypasses the module-over-WebSocket transfer
  or ships a smaller message).
- **Zero** of the 26+ files that pull the same JSON transitively through
  `src/api/models/*.ts` — same module bytes, different fetch order/batching at
  runner startup.
- **Zero** in solo and small-subset runs: running the exact crash files alone
  (1 file), as a pair, or as a trio produces **0** 1009 events. The deaths
  require the full-suite context of ~150 concurrent runner spawns.

A practical trigger for a minimal repro is therefore: a project with many test
files where a large (>1 MB transformed, multi-MB with sourcemap) module sits in
the startup import graph of a subset of them, run with enough files to get many
runners spawning at once.

#### Minimal public repro (BUILT — wave-32 update, 2026-10-26)

Built and measured by `wave-ws1009-repro`; the repo is fileable now. Scratch
project at `/tmp/ws1009-repro/` (documented `README.md`), archived (without
`node_modules/`) as **`docs/research/ws1009-repro.tar.gz`** (71 KB). Stack
pinned exactly: vitest 5.0.5, vite 8.3.5, @cloudflare/vitest-plugin 1.4.7,
wrangler 4.152.0 (miniflare 5.20261019.2-beta, workerd 1.20261019.1), Node
v25.9.0, pnpm 12.13.0 (`pnpm-workspace.yaml` with
`allowBuilds: {esbuild: true, workerd: true}` for the postinstall scripts).

Scaffold (all fixture content SYNTHETIC, public-safe):

1. Minimal wrangler config (`name`/`main`/`compatibility_date` only, no
   bindings) + trivial worker + `cloudflareTest({ wrangler: { configPath } })`.
2. One synthetic swagger-shaped JSON, 983,587 B pretty-printed (the real one is
   983,702 B) + a barrel importing it plus 2 synthetic 6.6 MB string-literal
   modules — total shared source ≈ 14.2 MB.
3. `tests/big-01..18.test.ts` — 18 identical files, each importing the barrel
   directly (mirrors the repo's 18 direct importers).

`npx vitest run --maxWorkers 1` — **3/3 identical runs**: exit 1, 51 ×
`protocolError.statusCode = 1009` lines (= **17 events** × 3), **17** "Worker
exited unexpectedly during started state" attributions, deterministic set:
**17 of the 18 files die, ONE survives and passes** (`Test Files 1 passed
(18)`, `Tests 1 passed (1)`). The survivor is the file the scheduler runs
FIRST (stable non-alphabetical order here: big-16; identical across runs).
With `--maxWorkers 8` (repo's setting): 2/2 identical, **10** deaths. The same
crash reproduces with **N=2 test files** (one connector + one crasher sharing
the graph) and even with a single 14 MB shared module + the JSON — the file
count is NOT the trigger.

Measured mechanism (instrumented the plugin's `CloudflarePoolWorker.send` on a
private copy; exact message bytes logged):

- The fatal message is the response to the runner's `fetchWarmModules` RPC: the
  plugin inlines the transformed code of EVERY module in the file's import
  graph that the shared Vite server has already transformed (each module under
  both its `url` and `id` keys; cached code includes the inline sourcemap) and
  ships it as ONE WebSocket message. Measured: 14-pad graph 23,634,553 B →
  passes; 21-pad 33,445,845 B → passes; 22-pad 34,847,465 B → 1009.
- The incoming-message cap of the local workerd on this socket is **32 MiB**
  (33,554,432 B). Measured with a single oversized module fetch: 33,309,508 B
  passes, 33,654,312 B dies. The production limit raised on 2025-10-31 IS in
  the local runtime — item 3 of "Mechanism" below is wrong on this point.
- The cloudflare pool sets `prewarmModules: false`, so a runner's snapshot is
  non-empty only when an EARLIER test file already connected the same graph on
  the shared Vite server. That — not spawn concurrency or suite size — is the
  "full-suite context required" effect (draft open question 3): 2 files
  suffice; a solo file never crashes; N=18 files with only the small JSON in
  the graph never crash even with 100 filler files.
- Per-module fetch responses (fresh transform = code + map in one message) are
  capped at ~4 MB here and cannot crash a runner unless a single transformed
  module nears 32 MiB — the repo's largest single-module fetch (swagger JSON,
  657,304 B code + 2,752,623 B map) was never itself fatal. The draft's
  item-2/mechanism narrative should be rebased on the snapshot message.
- The crash files' tests do NOT pass in this repro: the file silently
  disappears ("Test Files 1 passed (18)" — neither passed nor failed). The
  draft's "Test files failed 0 / all green" is consistent with this (failed = 0
  either way), but the filer should re-verify the repo's own `Test Files` line
  and whether the 2959-test count still includes the 17 attributed files'
  tests; both variants surface identically as unhandled errors + exit 1.
- Open question 4 is resolved by the repro: the ONE surviving direct importer
  is the file the scheduler runs FIRST (its snapshot request arrives before
  the graph is connected — empty snapshot → per-module fetches, each under
  the cap; it is the connector). In the 18-file repro the first-run file is
  big-16 (scheduler order, stable across runs) and exactly it survives; in
  the repo it was evidently `src/api/issues.test.ts`. The crash SET is
  deterministic because the scheduler order is.

### Mechanism (what we can see from the installed plugin)

1. Each test file gets its own runner; the Node pool connects to it over a
   single WebSocket (`connectToMiniflareSocket` → the `RUNNER_OBJECT` Durable
   Object singleton).
2. Every module the in-workerd runner needs is shipped from Node to workerd
   **as one WebSocket message** — in `CloudflarePoolWorker.send()`
   (`src/pool/cloudflare-pool-worker.ts`):
   `this.socket.send(structuredSerializableStringify(toSend))`, where the
   payload is the module-fetch response (transformed `code`, and a `map`), with
   filesystem-cached transforms inlined back in (`inlineCachedModules`).
3. workerd enforces an incoming-WebSocket-message cap and kills the connection
   when a message exceeds it — this is the observed
   `protocolError.statusCode = 1009; description = "Message is too large"`
   from `kj/compat/http.c++`. The documented production cap was raised from
   1 MiB to 32 MiB on 2025-10-31, but the message sizes here (code+map ≈ 3.4 MB
   for the swagger module) demonstrably still trip the cap in the bundled local
   workerd (1.20261019.1) — so either the local runtime retains the old 1 MiB
   limit on this socket path, or a lower internal cap applies.
4. The runner dies "during started state"; the file's test result still
   completes green, and the pool surfaces the death only as an unattributed
   unhandled error. Because the `ignoreMessages` list already filters the
   "disconnected: …" family as "not user actionable", the only trace that a
   runner died is the stray 1009 exception noise — easy to misread as an
   environment problem rather than a payload-size crash.

**Correction (measured, wave-32, 2026-10-26 — see the repro section above):**
item 3's cap estimate is wrong and item 2's "one message per module fetch" is
incomplete. The local workerd enforces the raised **32 MiB** limit on this
socket (measured boundary 33,309,508 B pass / 33,654,312 B die), so the repo's
per-module fetches (≤ ~4 MB) were never fatal. The messages that die are the
`fetchWarmModules` snapshot responses: the whole already-transformed import
graph of the file, inlined by `inlineCachedModules` into one message (aliases
duplicate each module under `url` and `id`), which crosses 32 MiB once the
connected graph holds roughly ≥ ~13 MB of source. The snapshot is empty for
the first file to touch a graph and full for every later file sharing it —
which is what actually requires "full-suite context" and what makes the crash
set deterministic (first-sorting file connects and survives).

### Why this matters

- **False CI failures:** a fully green suite (2959/2959 tests) exits 1 because
  vitest counts the 17 runner deaths as unhandled errors
  (`dangerouslyIgnoreUnhandledErrors` defaults to false). Any project with a
  module of this size cannot get a clean exit from the plugin today.
- **Silent whole-file losses:** when the runner death does land before the
  file finishes on slower setups, the loss surfaces as an unattributed error or
  a timeout in an unrelated-looking place. We found this root cause only after
  chasing whole-file "flakes" across multiple runs; nothing in the output
  points at the oversized module.
- **Suppression asymmetry:** the plugin already hardcodes the "disconnected"
  aftermath as ignorable, so the crash's cause prints as raw KJ noise on
  stderr while its effect is a misleading "Errors 17" summary.

### Suggested fix directions

1. **Chunk large module transfers**: split oversized fetch responses (code and
   sourcemap) into framed chunks over the runner WebSocket and reassemble
   runner-side, removing the per-message cap from the equation.
2. **Raise/relax the incoming-message cap for the local runner socket**: the
   socket is loopback-only plumbing between the pool and the local workerd;
   matching the production 32 MiB limit (or configuring it in miniflare) would
   cover realistic module sizes.
3. **Drop or lazy-serve sourcemaps for module fetches**: in our worst case the
   map is 2.75 MB against 657 KB of code (75%+ of the message). Shipping maps
   only when the runner asks (or stripping them for generated data modules)
   shrinks the largest payloads below any plausible cap.
4. **Loud, attributed failure**: if a 1009 kills a runner anyway, retry the
   file's runner and emit an actionable error ("module payload for file X
   exceeded the runner's WebSocket message limit; N bytes for module Y")
   instead of an unattributed unhandled error — and/or add the
   1009/`fixed-length pipe` signatures to `ignoreMessages` only together with
   that attributed error, never silently.

---

## Filing checklist (for the human/agent that files this)

- **Repo:** cloudflare/workers-sdk (verified from the installed package's
  `repository` field; package dir `packages/vitest-plugin`). Do not file
  against vitest or miniflare — the module-transfer protocol is the plugin's.
- **Template:** `.github/ISSUE_TEMPLATE/bug-template.yaml` ("🐛 Bug Report",
  type: Bug). Required fields: (1) versions/OS — env block above is ready;
  (2) link to a minimal reproduction — **not yet available**; see below;
  (3) description; (4) optional error logs — paste the verbatim 1009 trio and
  the "Worker exited unexpectedly during started state" wrapper.
- **Minimal repro:** **BUILT 2026-10-26** — `docs/research/ws1009-repro.tar.gz`
  (71 KB, synthetic public-safe fixtures; recipe and counts in the
  "Minimal public repro" section above; scratch at `/tmp/ws1009-repro/` with a
  README). Link the tarball (or a published repo unfurled from it) in the
  issue. Still re-verify (a) on the filer's machine and (b) the repo's own
  `Test Files` line for the passed-vs-vanished distinction noted above.
- **Labels:** the template assigns none automatically; leave label choice to
  triage (suggested in text: affects `packages/vitest-plugin`, prerelease).
- **Title:** use the proposed title above.
- **Grep caveats for anyone re-verifying:** the naive
  `grep -cE "1009|Message is too large|pipe.*abort"` counts lines, not events
  (each death prints 3 lines) and false-positives on test durations ending in
  `1009ms` (1 in our run). Use
  `grep -c "protocolError.statusCode = 1009"` (÷3 for events) and
  `grep -c "fixed-length pipe ended prematurely"`.
- **Do not file** from this draft without (a) the fresh-run numbers re-verified
  on the filer's machine and (b) the minimal repro published or waived.

## Data appendix (measurement record, 2026-10-26)

- Full-suite runs (153 test files, 155 spawns/run): run1 12:20, run2 12:24 local
  time; logs kept at `/tmp/ws1009-run1.log`, `/tmp/ws1009-run2.log`
  (scratch, not committed).
  - run1: 51 `protocolError.statusCode = 1009` lines (= 17 events × 3 variants),
    17 "Worker exited unexpectedly during started state" attributions, 4 pipe
    lines, 8 "Network connection lost" lines, "Errors 17", exit 1.
  - run2: identical 17-event count, identical 17-file attribution set,
    4 pipe lines, exit 1.
- Solo runs: `src/api/orgs.test.ts` (61 tests), `src/api/users.test.ts` (13),
  `src/api/compat/suite.test.ts` (158, largest file, `?raw` importer),
  `src/api/issues.test.ts` (72, direct importer, only non-crashing one):
  0 × 1009, exit 0 each.
- Subset runs: orgs+users+labels trio, orgs+users duo: 0 × 1009, exit 0.
- Prior unit (commit e4ebb9d, 2026-10-26): 17 × 1009 events + ~5 pipe aborts
  constant across 9 runs at `maxWorkers` 31 and 8 — count is
  load/worker-count-independent, agreeing with both fresh runs.
- Vite transform measurements (project's own vite 8.3.5, dev SSR transform,
  scratch script):
  - `src/compat/contract/v1-swagger.generated.json`: code 657,304 B +
    map 2,752,623 B = 3,409,927 B.
  - same file `?raw`: code 1,102,279 B (never crashes).
  - `src/api/routes/misc-t2.ts` (496,178 B source): code 497,220 B +
    map 528,295 B = 1,025,515 B (its test never crashes — sits just under the
    1 MiB line, consistent with a 1 MiB cap if maps ship in the message).
  - `src/ui/index.ts`: 229,695 + 335,411 = 565,106 B. `src/services/license-corpus.ts`:
    201,781 + 210,554 = 412,335 B.
- Open questions (explicitly unresolved, included in the draft as such):
  1. Why does the `?raw` form (1.10 MB code) never crash while the smaller
     normal form (657 KB + 2.75 MB map) deterministically does? (Externalized
     by module rules? Map not shipped on that path?)
  2. Why do transitive imports of the same JSON never crash — fetch order or
     response batching differences at runner startup?
  3. Why is full-suite context required (solo/pair/trio runs of crash-set files
     are clean) — is the `cached: true` + `tmp` filesystem-cache inlining path
     shipping larger messages than the fresh-transform path?
  4. Why does `src/api/issues.test.ts` (direct normal importer, second-largest
     file) never crash?
- **Wave-32 resolutions/reframing of the questions above (from the measured
  repro — see the "Minimal public repro" section):**
  1. Reframed: the fatal size is the file's WHOLE connected-graph snapshot
     (fetchWarmModules response), not the single module's fetch response. The
     `?raw` files' graphs simply stayed under 32 MiB; the normal-vs-raw
     per-module size comparison was measuring the wrong message.
  2. Same reframing: transitive importers' graphs (models-only) stayed under
     the cap; additionally the snapshot only includes modules already
     transformed on the shared Vite server when the runner's request arrives.
  3. RESOLVED: not the fs-cache path and not load. The snapshot is non-empty
     only because an earlier file connected the same graph on the SHARED Vite
     server (the pool sets `prewarmModules: false`); 2 files suffice to
     reproduce, solo runs can never crash, and `--isolate=false` (single
     reused runner, stale memoized empty snapshot) does not crash either.
  4. RESOLVED: the surviving direct importer is the file the scheduler runs
     FIRST — its warm-snapshot request arrives before the shared graph is
     connected (empty snapshot, per-module fetches under the cap), so it is
     the connector; every later sharer gets the full over-cap snapshot. The
     18-file repro reproduces exactly this shape (one stable survivor per
     scheduling order; all other direct importers die).
- Environment block: Node v25.9.0, pnpm 12.13.0, Ubuntu 24.04.2 LTS,
  kernel 6.14.0-37-generic x64, 32 cores / 31 GB RAM; vitest 5.0.5,
  vite 8.3.5, @cloudflare/vitest-plugin 1.4.7, miniflare 5.20261019.2-beta,
  wrangler 4.152.0, workerd binary 1.20261019.1.
- Upstream suppression reference: `packages/vitest-plugin/src/pool/index.ts`,
  `ignoreMessages` (verified via GitHub raw fetch of main), which already
  lists the "disconnected: …" family under "// Not user actionable".
- Cloudflare production WS message limit history: 1 MiB → 32 MiB on
  2025-10-31 (developers.cloudflare.com changelog, "increased WebSocket
  message size limit"); messages over the cap close with 1009 — matching the
  observed KJ error, and evidence that the local runner socket does not get
  the raised limit.
