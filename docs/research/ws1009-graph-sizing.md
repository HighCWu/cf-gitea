# ws1009 graph sizing — per-module measurement of the fatal warm-snapshot message

Measured 2026-10-27 (14:55-15:25 local) by wave-126 agent `wave-ws1009-sizing`.
Companions: `docs/research/workers-vitest-ws1009-issue.md` (mechanism + repro),
`docs/research/ws1009-upstream-issue-draft.md` (filing-ready draft),
`docs/testing/suite-stability.md` (the 204-death ledger this sizing feeds).

**Purpose.** The suite-stability ledger's stopgap #2 ("shrink the app-entry
import graph back under the snapshot boundary") needs to know where the ~32 MiB
actually sits before anyone spends refactors. This document measures, per
module and per `apps/worker/src` area, (a) source bytes on disk, (b) transformed
bytes, (c) contribution to the single `fetchWarmModules` WebSocket message —
and splits the **common graph** (pulled into nearly every test file's snapshot)
from **test-local** graph. Nothing here was implemented; measurement + plan only.

**Tree basis.** Cache entries were written by vitest runs against the working
tree whose content became HEAD `7097785` (the mount-window commit `2f7afe9`
landed at 15:23 with exactly the measured `ui/index.ts` bytes — 556,193 B /
10,563 lines; the measured cache entry for it is from 14:55:41). Residual
in-flight edits at write time: 5 files, +40/-80 lines, all `ui/` (a follow-up
window; `ui/index.ts` +22 lines). 260 test files on disk, 259 with cache
entries (`src/ui/__tests__/goldens.test.ts` has none and is excluded).

---

## 1. Mechanism recap (verified against the installed sources, this run)

The fatal message is the pool's response to a runner's `fetchWarmModules` RPC:

- vitest 5.0.5 (`dist/chunks/index.1TqnEahn.js`) walks the environment module
  graph of the requested test file (+ setup files — the config has none),
  includes every node with a transform result that has an on-disk cache copy
  (`transformResult.__vitestTmp`; `fsModuleCache` defaults to **true**), and
  registers **the same entry under both `warm[url]` and `warm[id]`** — every
  module rides the message **twice** (no string dedup in the serializer).
- `@cloudflare/vitest-plugin` 1.4.7 `inlineCachedModules`
  (`dist/pool/index.mjs`) then replaces `{cached:true, tmp}` with
  `code = readFileSync(tmp)`: the **entire cache file** = transformed code +
  inline `sourceMappingURL=data:application/json;base64,…` + a
  `\n//# vitestCache=<base64 metadata>` tail (imports graph + module type).
  There is **no separate `map` field** on warm entries — the sourcemap ships
  inside the escaped code string.
- workerd kills the runner socket above **32 MiB = 33,554,432 B** per message
  (measured pair: 33,309,508 B passes, 33,654,312 B dies — wave-32).
- A module is only in a snapshot if an earlier runner actually **fetched** it.
  Dynamic imports that no test executed have no transform result and **drop
  out of the snapshot** (fetched per-module, ≤ ~4 MB, when first executed).
  This is why the `?raw`/dynamic postures are load-bearing and why the
  snapshot tracks the *statically-reachable-and-actually-loaded* graph.

## 2. Method (honest disclosure)

The vitest fs module cache at `node_modules/.vitest-cache/` (5,071 files,
443 MB, written by this week's runs) stores **byte-exactly the string the pool
ships as `code`**. So instead of re-transforming anything, the measurement:

1. Parses every cache file's base64 metadata tail (vitest's devalue-style flat
   format) → `file`, `id`, `url`, `imports {urls, ids}` per module; dedups to
   the **newest-mtime entry per module id** (the cache accumulates eras;
   stale generations are normal).
2. For each of the 259 test files: BFS over `imports.urls` to rebuild its
   import graph. **Static vs dynamic edges are separated by extracting the
   `__vite_ssr_dynamic_import__("url")` calls out of each transformed module's
   code** (the SSR transform's marker) — the metadata does not record edge
   type. Only static edges count for startup snapshots (§1, last bullet).
3. Models the message as the exact JSON of the warm map
   (`{file,id,url,invalidate,moduleType,code}` per alias, `url`+`id` keys) and
   measures it with `JSON.stringify` byte lengths (the serializer escapes
   JSON-style; wave-32's pad deltas confirm the ×2 alias duplication).
4. **Validation** — replaying wave-126's real scheduler order
   (`/tmp/wave126/order.txt`, simulating "earlier surviving files connect the
   graph") against the observed 204-death ledger (`/tmp/wave126/doomed.txt`):
   the full-graph model predicts 236 deaths recalling **202/204**; the
   static-edge model predicts 231 recalling **201/204** (30 over-predicted —
   expected: today's post-window tree is bigger than the wave-126 baseline
   tree, and the sim assumes full connectivity). ~99% recall / ±15% precision
   is ample for sizing decisions. Median steady-state message: 44.9-48.2 MB
   across models, i.e. ~1.4x over the cap for a typical test file.

Scripts (scratch, reproducible): `/tmp/ws1009-sizing/{scan-cache,analyze,aggregate,simulate,core-freq,final-tables}.mjs`
with intermediates under `/tmp/ws1009-sizing/out/`. Re-run order and runtime:

```bash
cd /tmp/ws1009-sizing
node scan-cache.mjs     # seconds — parse .vitest-cache metadata (5,070 files)
node analyze.mjs        # minutes — full-graph model + wave-126 order simulation
node simulate.mjs       # minutes — static-edge model, core tables, interventions
node core-freq.mjs      # minutes — frequency-based common core + notable modules
```

(Requires a populated `node_modules/.vitest-cache` — i.e. a full-suite run on
the tree being sized. Re-measure after any graph change by re-running the
suite once, then these scripts.)

## 3. Where the bytes are

### 3.1 Per area (non-test source; transformed = newest cache entry bytes; core wire = contribution to a typical doomed API test's snapshot message)

| area | src files | src KB | transformed modules | transformed KB | core modules | core wire MB |
|---|---:|---:|---:|---:|---:|---:|
| `ui/` | 132 | 4,715 | 185 | 11,629 | 119 | **19.56** |
| `api/` | 154 | 3,447 | 152 | 9,391 | 147 | **17.65** |
| `services/` | 27 | 724 | 27 | 1,931 | 25 | 3.83 |
| `repos/` | 7 | 152 | 7 | 426 | 6 | 0.82 |
| `db/` (schema.ts; migrations not in graph) | 37 | 3,785 | 1 | 392 | 1 | 0.78 |
| `compat/` (swagger JSON, 20 files only) | 2 | 963 | 3 | 5,310 | 0 | (2.50 local) |
| `git-http/` | 6 | 88 | 6 | 242 | 6 | 0.48 |
| `auth/` | 15 | 65 | 14 | 197 | 11 | 0.34 |
| `issues/` | 5 | 55 | 5 | 154 | 4 | 0.30 |
| `webhooks/` | 4 | 52 | 4 | 148 | 1 | 0.12 |
| `lfs/` | 1 | 30 | 1 | 81 | 1 | 0.16 |
| `web/` | 2 | 65 | 2 | 182 | (233/259) | 0.36 |
| `invariants/` | 3 | 31 | 3 | 81 | 0 | 0 |
| `src/index.ts` | 1 | 11 | 1 | 30 | 1 | 0.06 |
| `packages/git-engine` (inlined source) | — | — | 40 | 2,007 | 0 | 0 |
| node_modules (all, incl. zod/hono/pako) | — | — | ~460 | ~14,000 | **0** | **0** |

Key reads:

- **The wire cost is ~4x source** for core modules (transform ~2x + inline
  sourcemap ~1.6x + url/id aliasing ×2, minus TypeScript type erasure).
- **node_modules contributes ZERO to the fatal message**: zod, hono, pako,
  drizzle, markdown-it are all externalized (`shouldExternalize`); externals
  ride the snapshot as ~100-200 B `{externalize}` stubs. The graph is
  **entirely first-party code** (plus inlined `packages/git-engine` source,
  which today also sits at 0 — dynamic-only from the engine entry).
- The heaviest single data modules are already OUT of the common core:
  `material-icon-svgs.json?raw` (1.94 MB wire) and
  `material-icon-rules.json?raw` (1.24 MB) appear in exactly **1** test file's
  static graph (`fileicon.test.ts`); the swagger JSON `?raw` (2.49 MB) in
  **20** (the files importing `compat/contract/frozen-contract.ts` — the old
  17-death crash set). The ledger's "fileicon posture is load-bearing" claim
  is confirmed and can now be stated precisely: the dynamic boundary is
  `tree-view-aux.ts:188` (`import("../fileicon/fileicon")`); the two JSONs
  are **static** `?raw` imports *inside* `fileicon.ts` — so any change that
  makes them normal-form JSON (or statically imports fileicon from the UI
  barrel's startup path) would put ~3.2 MB of escaped JSON into every UI
  test's snapshot. Do not revert.

### 3.2 The single-graph message: common vs local

- **Common core** (statically reachable from ≥90% of test files):
  **321 modules, 44.05 MB wire** (raw per alias: 7.89 MB code + **13.09 MB
  inline sourcemap** + 0.30 MB metadata tail; ×2 aliases + ~1.5 MB escaping /
  entry overhead = 44.05 MB). Sourcemaps are **61.5% of the raw payload**.
- **Test-local**: 349 further modules totaling 50.21 MB *spread across all
  files* — dominated by the swagger `?raw` (2.49 MB × 20 files), the two icon
  JSONs (3.2 MB × 1 file), `tier1-fixtures.json` (0.95 MB × 2), and the
  largest test files themselves (`compat/suite.test.ts` 0.74 MB,
  `api/issues.test.ts` 0.58 MB wire each).
- A typical doomed API test (ref `src/api/orgs.test.ts`): **333 modules,
  47.65 MB** — ui 19.57 + api 18.12 + services 3.84 + compat 2.50 + the rest
  ~3.6 MB. **Test-local modules are noise; the common core is the problem.**

### 3.3 Top contributors inside the common core

| wire MB | map KB | code KB | module | why it is core |
|---:|---:|---:|---|---|
| 3.02 | 1,004 | 506 | `src/ui/index.ts` | the UI barrel — 556 KB source, statically mounted by `src/index.ts` (line: `import { handlesUiRoute, uiRouter } from "./ui"`) |
| 2.33 | 688 | 486 | `src/api/routes/misc-t2.ts` | 496 KB generated-ish route module, statically registered by `api/router.ts` |
| 0.93 | 274 | 197 | `src/services/license-corpus.ts` | license text corpus (via `services/repo-licenses.ts`) |
| 0.78 | 241 | 150 | `src/db/schema.ts` | needed everywhere (D1) — hard to defer |
| 0.52 | 145 | 103 | `src/ui/pages/owner-project-board.tsx` | re-exported by the UI barrel |
| 0.47 | 154 | 80 | `src/api/routes/org-teams.ts` | `api/router.ts` registration |
| 0.46 | 150 | 81 | `src/api/routes/issue-tables-t2.ts` | idem |
| 0.46 | 149 | 78 | `src/api/routes/repo-extras-t2.ts` | idem |
| 0.44 | 116 | 94 | `src/ui/pages/repo-projects.tsx` | UI barrel |
| 0.44 | 140 | 77 | `src/api/routes/pulls.ts` | idem |
| 0.42 | 123 | 83 | `src/ui/pages/global-inbox.tsx` | UI barrel |
| 0.42 | 136 | 73 | `src/api/routes/pull-reviews.ts` | api router |
| 0.42 | 121 | 80 | `src/ui/pages/branch-protection.tsx` | UI barrel |
| 0.41 | 131 | 70 | `src/api/routes/issues.ts` | api router |
| 0.40 | 104 | 82 | `src/ui/pages/settings.tsx` | UI barrel |

The tail is long: the core's 19.56 MB ui share is ~3 MB barrel + ~16.5 MB of
119 page/component modules; the api share is 2.7 MB of `misc-t2/t3` + ~15 MB
of ~145 route/model modules. **No single module fixes this; the fix is
structural (cut a mount), not cosmetic (shrink a file).**

## 4. Shrink plan (ranked by MB saved × risk; nothing implemented)

### A. De-static the UI mount at the app entry — **FALSIFIED 2026-10-27 (wave-ws1009-fix-a): implemented, behavior-preserving, all gates green — and the death count stayed 204 (195/204 doomed-set overlap). The static-edge model is wrong at this boundary.**

`fetchWarmModules` BFS-walks `node.importedModules` with **dynamic edges
included once executed**: the plugin's virtual `cloudflare:test` module
imports `src/index` (the main module), so the lazy UI edge sits on that
universal node and re-enters every later file's warm message the moment
any file executes a UI request (measured: all-edges BFS from a SELF test
= 344 modules, uiHit true, over cap on the wire). No within-ownership
shape avoids this — the main-module edge is required by the deployed
worker's import. The change was REVERTED at landing review (lazy-mount
complexity in the entry carried for no ws1009 gain; its deploy
code-splitting side benefit was unmeasured and does not justify the
risk surface). Do not spend waves C/D/E expecting death reductions from
graph shape alone; the surviving levers are B (sourcemaps, −26 MB) and
the upstream fix.

`src/index.ts` statically imports `./ui` (the 556 KB barrel), `./ui/session`,
`./web/avatar-serving`, `./web/attachments-serving` only to mount them on the
Hono root. Making those four mounts lazy (`app.route` over a dynamically
imported sub-app behind a cached promise, resolved on first UI-classified
request; `handlesUiRoute` already gates the dispatch point) removes ui+web
from the static graph of every test that doesn't import them itself.

- Measured (sim, static-edge model, cap 33,554,432): median message
  44.87 → **24.62 MB**, p90 24.80, **max 28.98** (`api/compat/suite.test.ts`),
  predicted deaths **0/259** (UI-area files max 24.88 MB — they import the
  pages directly, so they keep their graphs).
- Files touched: `src/index.ts` (mount style); ideally nothing else.
- Risk (medium-low): (1) middleware/registration order — avatar/attachments
  must keep winning over the `/:owner/:repo` parser shape (the comments in
  `src/index.ts` document this); (2) `handlesUiRoute` must consult the lazy
  router without importing it, or the lazy boundary must wrap both; (3) the
  engine's `ui:false` interplay and 404 semantics for misses; (4) one-time
  cold cost on first UI request. UI tests keep passing (they own their
  imports); `index.test.ts` exercises the mount and will fetch the UI
  per-module — fine (each fetch ≤ ~4 MB).
- Post-A headroom: ~4.6 MB under the cap at the worst file — roughly 10+
  waves at the current growth rate (the mount window alone added ~0.3 MB of
  wire to ui-heavy graphs).

### B. Stop shipping dev-transform sourcemaps in the vitest run — **−26 MB from the core; the single biggest byte family (61.5% of raw payload)**

13.09 MB of the core's 21.28 MB per-alias payload is inline sourcemaps
(generated by vite's dev-SSR transform; `fsModuleCache` then bakes them into
the cache files that ship verbatim). Dropping maps at transform time halves
the message: core 44 → ~17 MB wire, and makes A optional rather than
urgent. No first-class vite/vitest knob was found for dev-SSR map emission;
the two concrete routes are (a) a `vitest.config.ts` plugin that post-processes
transforms (`transform(code, id) → { code, map: null }` at the right
`enforce` phase) or cleans the fs cache writes, and (b) the upstream fix
direction already drafted (`ws1009-upstream-issue-draft.md`, "lazy-serve
sourcemaps"). Risk (low for CI, medium philosophically): stack traces in test
failures lose original-position mapping; source-map-dependent tooling
(coverage remapping, if any) would need checking. This is config-side, so it
was measured, not applied (`vitest.config.ts` intentionally untouched — the
suite-stability A/B discipline).

### C. `misc-t2.ts` (+`misc-t3.ts`) aux-split or lazy registration — **−2.68 MB core**

`api/routes/misc-t2.ts` (496 KB source) is one statically-registered module;
`api/router.ts` imports it directly. Options: split into per-family aux
fragments (the repo's established `tree-view-aux` pattern) or register behind
a dynamic-import seam like A. Alone it moves nothing (sim: 231 → 231 deaths —
the gap is ~11 MB, a 2.3 MB cut cannot cross it); **after A** it is the
largest single headroom lever (median 24.62 → 22.29 MB). Risk (medium):
route registration order and the `pnpm check:api` frozen-contract coverage;
404 semantics if registration becomes lazy.

### D. `license-corpus.ts` → `?raw` + lazy parse — **−0.93 MB core**

197 KB code + 274 KB map for a text corpus. Same treatment as
`frozen-contract.ts`: ship the string via `?raw` (no sourcemap), parse on
first use inside `services/repo-licenses.ts`. Risk (low): pure data module.

### E. Defer `frozen-contract.ts` parsing — **−2.49 MB for exactly the ~20 files that reach it**

The swagger `?raw` (1,076 KB code, no map — the wave-31 fix held) plus
`parseSwagger2Contract` runs at module load. 20 test files' graphs carry the
JSON (18 through `frozen-contract.ts` — its only importers are test files —
plus 2 direct). A lazy accessor (`await import(...)` inside the assertion
helpers) keeps the 2.49 MB out of those files' startup snapshots (post-A the
worst of them, `compat/suite.test.ts` at 28.98 MB, drops to ~26.5 MB).
Risk (low): tests-only surface; keep the module as the single import point
(its docstring already mandates that).

### F. Explicitly NOT recommended

- **Any change to the fileicon JSONs / their dynamic posture** — measured at
  1/259 files; the ledger's warning stands (§3.1).
- **Chasing node_modules** — externalized already; zero wire bytes.
- **`db/schema.ts` deferral** — needed on every D1 code path; 0.78 MB is not
  worth the contortion.
- **vitest knobs** (`maxWorkers`, `isolate`, `dangerouslyIgnoreUnhandledErrors`)
  — rejected with measurements in `docs/testing/suite-stability.md`.
- The upstream fix (chunked transfer / 32 MiB cap parity / lazy sourcemaps in
  `@cloudflare/vitest-plugin`) remains the preferred resolution; A is the
  stopgap that makes the suite usable before it lands.

### Recommended order

**A first** (structural, one-file diff, sim-clean at 0/259 deaths), then **B**
if a config-side map strip is acceptable, then **C+D** as headroom top-ups the
next time a wave lands. Re-run §2's scripts after each landing — the boundary
moves with every wave.
