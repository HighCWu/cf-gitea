# Upstream issue draft — `@cloudflare/vitest-plugin`: runner WebSocket 1009 "Message is too large" on whole-graph warm-module snapshots

> **FILED 2026-10-27: https://github.com/cloudflare/workers-sdk/issues/16515** (re-verified against 1.4.8 before filing — signature unchanged: 17/10 death events). This document is the archival draft; the filed body additionally carries the 1.4.8 re-verification block.

Status: **DRAFT ONLY — not filed.** The orchestrator/user files it; no `gh`/network
write happens from agents. Prepared 2026-10-27. This document condenses the
mechanism history in `docs/research/workers-vitest-ws1009-issue.md` and the
at-scale ledger in `docs/testing/suite-stability.md` into ONE filing-ready,
fully sanitized issue (no product, repo-layout, or private references survive —
the "Issue body" section below is paste-ready verbatim). Versions in the
environment table were re-verified against `pnpm-lock.yaml` at HEAD `3a9b311`.

---

## Proposed title

```
[@cloudflare/vitest-plugin] Runner WebSocket dies with 1009 "Message is too large": the per-file warm-module snapshot (the whole transformed import graph) is sent as a single WebSocket message
```

Shorter alternative if the template prefers concise titles:

```
[@cloudflare/vitest-plugin] Warm-module snapshot exceeds the 32 MiB WebSocket message cap on large import graphs — runners die deterministically with 1009, files silently vanish, exit 1
```

---

## Issue body (paste-ready)

### What versions & operating system are you using?

| Component | Version |
|---|---|
| OS | Ubuntu 24.04.2 LTS (x64), kernel 6.14.0-37-generic |
| CPU / RAM | 32 cores / 31 GB RAM |
| Node | v25.9.0 |
| pnpm | 12.13.0 |
| vitest | 5.0.5 |
| vite | 8.3.5 |
| @cloudflare/vitest-plugin | 1.4.7 |
| wrangler | 4.152.0 |
| miniflare | 5.20261019.2-beta (the coordinated exact pin bundled by wrangler/the Cloudflare vite+vitest plugins) |
| workerd | 1.20261019.1 (binary shipped by the miniflare pin above) |

### Describe the Bug

In a project whose test files share a sufficiently large import graph (≈13-14 MB
of source is enough — see the payload math below), every test file except the
first one the scheduler runs **dies at runner startup** with a workerd protocol
error: the runner's WebSocket closes with **1009 "Message is too large"**. The
affected file set is **deterministic** (identical across runs), the death count
is constant per configuration, and the files **neither pass nor fail — they
silently disappear from the run** while vitest counts each death as an unhandled
error and the process **exits 1**.

Each death prints the same workerd exception trio on stderr:

```
uncaught exception; exception = kj/compat/http.c++:6208: failed: jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
exception = kj/compat/http.c++:6208: failed: jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
Uncaught exception: kj/compat/http.c++:6208: failed: remote.jsg.Error: WebSocket protocol error; protocolError.statusCode = 1009; protocolError.description = Message is too large
```

and vitest's summary attributes each death to a file that was never failed:

```
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 17 unhandled errors during the run.

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-pool]: Worker cloudflare-pool emitted error.
Caused by: Error: Worker exited unexpectedly during started state while running test file /tmp/ws1009-repro/tests/big-05.test.ts

 Test Files  1 passed (18)
      Tests  1 passed (1)
     Errors  17 errors
```

Note what is missing: **17 of 18 files ran nothing at all** — no failure, no
skip, no trace in the `Test Files`/`Tests` counts. The only signals are the
`Errors 17` line (which fails CI via exit code 1) and raw KJ noise on stderr.

**This scales with the codebase, not with any single file.** In a real-world
TypeScript suite we watched this go from **17 of 153 test files** dying
deterministically in every run to **204 of 258 files (79%)** the next day, after
ordinary feature work added a few more MB of modules to the shared import graph.
Zero of the doomed files contained a failing test — every one of them passes
when run solo or in small batches, because a small batch never crosses the
message cap. Nothing in vitest's output points at the actual cause (an
oversized pool-to-runner message); it presents as a green suite that exits 1,
plus unattributable `Worker exited unexpectedly during started state` errors.

### Reproduction

Self-contained; all fixture content is synthetic. Full recipe + generators
below; a ready-to-run project is archived and can be published on request.

**1. Scaffold** a fresh project with these exact files:

`package.json`:

```json
{
  "name": "ws1009-repro",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.4.7",
    "vite": "8.3.5",
    "vitest": "5.0.5",
    "wrangler": "4.152.0"
  },
  "pnpm": { "onlyBuiltDependencies": ["esbuild", "workerd"] }
}
```

`pnpm-workspace.yaml` (pnpm 12 refuses workerd/esbuild postinstall scripts
without it; pnpm generates the stub on first install — set both to `true`):

```yaml
allowBuilds:
  esbuild: true
  workerd: true
```

`wrangler.jsonc`:

```jsonc
{
  "name": "ws1009-repro",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-19"
}
```

`vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 8 },
});
```

`src/index.ts` (trivial entry; the bug is in the test transport, not worker code):

```ts
export default {
  fetch(): Response {
    return new Response("ok");
  },
};
```

**2. Generate the synthetic graph** — one ~1 MB pretty-printed JSON module plus
two 6.6 MB string-literal modules, all imported by 18 identical test files:

```python
#!/usr/bin/env python3
# gen.py — synthetic fixtures, no real content
import json, os

TARGET_JSON = 983_587   # raw bytes of src/contract.json
PADS, PAD_BYTES = 2, 6_600_000
TEST_FILES = 18

paths, i = {}, 0
while True:
    paths[f"/synthetic/resource{i:05d}"] = {"get": {
        "summary": f"synthetic operation {i}", "operationId": f"op{i}",
        "parameters": [{"name": f"param{j}", "in": "query",
                        "schema": {"type": "string"}} for j in range(6)],
        "responses": {"200": {"description": "ok",
            "content": {"application/json": {"schema": {"type": "object"}}}}},
    }}
    doc = {"openapi": "3.0.0", "info": {"title": "synthetic", "version": "1.0.0"},
           "paths": paths}
    if len(json.dumps(doc, indent=2).encode()) >= TARGET_JSON:
        break
    i += 1
open("src/contract.json", "w").write(json.dumps(doc, indent=2))

os.makedirs("src/pad", exist_ok=True)
for f in os.listdir("src/pad"): os.remove(os.path.join("src/pad", f))
lines = []
for k in range(1, PADS + 1):
    with open(f"src/pad/p{k:03d}.ts", "w") as f:
        f.write(f"// Synthetic padding module {k} (repro fixture, no real content)\n")
        f.write(f'export const pad{k:03d} = "{"x" * PAD_BYTES}";\n')
    lines.append(f'export {{ pad{k:03d} }} from "./pad/p{k:03d}";')
lines.append('import contract from "./contract.json";')
lines.append("export { contract };")
open("src/graph.ts", "w").write("\n".join(lines) + "\n")

os.makedirs("tests", exist_ok=True)
for t in range(1, TEST_FILES + 1):
    with open(f"tests/big-{t:02d}.test.ts", "w") as f:
        f.write(
            'import { it, expect } from "vitest";\n'
            'import { pad001, contract } from "../src/graph";\n\n'
            'it("loads the shared graph", () => {\n'
            "  expect(pad001.length).toBeGreaterThan(0);\n"
            "  expect(Object.keys(contract.paths).length).toBeGreaterThan(0);\n"
            "});\n"
        )
```

```bash
mkdir -p src && python3 gen.py
pnpm install
```

**3. Run:**

```bash
npx vitest run --maxWorkers 1
# exit 1; 51 lines of "protocolError.statusCode = 1009" (= 17 events x 3 lines);
# 17 "Worker exited unexpectedly during started state" attributions;
# "Test Files 1 passed (18)" — 17 files ran nothing. Identical across 3 runs.
# The survivor (big-16 here) is the file the scheduler happens to run FIRST.

npx vitest run --maxWorkers 8
# exit 1; 30 x 1009 lines (= 10 events); identical across 2 runs.
```

**Controls that pin the boundary** (all in the archived repro):

| Variant | Warm-snapshot bytes | Outcome |
|---|---|---|
| 21 pads x 600 KB shared graph | 33,445,845 | pass, exit 0 (108,587 B under the cap) |
| 22 pads x 600 KB shared graph | 34,847,465 | 1009, exit 1 |
| 18 files, 2 x 6.6 MB pads + 1 MB JSON | > cap | 17 deaths (mw1) / 10 deaths (mw8), deterministic |
| 2 files only (one connector + one crasher), same graph | > cap | 1 death — suite size is NOT the trigger |
| 2 files, one 14 MB module + JSON | > cap | 1 death |
| 18 files, JSON-only (small) graph + 100 filler files | < cap | 0 deaths — a large graph TOTAL, not any single module, is the trigger |
| `--isolate=false` | stale empty snapshot memoized | no crash (single reused runner fetched the snapshot before the graph was connected) |

### Measured mechanism

We instrumented the pool's send path on a private copy of the plugin and logged
exact message bytes:

1. Each test file gets its own workerd runner; the Node pool talks to it over a
   single WebSocket (the `RUNNER_OBJECT` Durable Object singleton).
2. The cloudflare pool sets `prewarmModules: false`, so the **first** test file
   to touch a given import graph receives an **empty warm snapshot** and fetches
   its modules one by one (per-module responses measured ≤ ~4 MB here — far
   under any cap). It connects the graph on the shared Vite server and survives.
3. **Every subsequent file sharing that graph gets the whole already-transformed
   graph as ONE WebSocket message**: the `fetchWarmModules` response, assembled
   in `CloudflarePoolWorker.send()` / `inlineCachedModules()`, contains the
   transformed `code` (with inline sourcemap) of every module already
   transformed on the server, and each module appears **twice** under both its
   `url` and `id` keys. Measured expansion: **~2.34x the transformed code**, so
   a connected graph of ~13-14 MB of source crosses the line.
4. workerd caps incoming WebSocket messages at **32 MiB (33,554,432 B)** — the
   raised production limit is present in the local runtime. Both probes straddle
   it exactly: single-module fetch 33,309,508 B passes / 33,654,312 B dies;
   warm snapshot 33,445,845 B passes / 34,847,465 B dies.
5. The over-cap message closes the socket with 1009; the runner dies "during
   started state" and its file silently vanishes from the run. Determinism
   follows from scheduler order: the first-scheduled file is always the
   connector (empty snapshot), the rest always receive the full over-cap
   snapshot. Solo and small-batch runs can never crash — the one file is always
   the connector.

### Why the existing configuration knobs don't help

- **`maxWorkers`**: the death count is structural, not load-raced — constant
  across 9 real-suite runs at `maxWorkers` 31 and 8; in the repro, `--maxWorkers 1`
  kills MORE files (17) than `--maxWorkers 8` (10), because with sequential
  scheduling every file after the connector receives the full snapshot. No
  value fixes the class.
- **`isolate: false`**: dodges the crash in the repro only as a side effect —
  the single reused runner memoizes the empty snapshot it fetched before the
  graph was connected and keeps fetching per-module. At real-suite scale an A/B
  still left 186 runner deaths, and it changes runner-reuse/storage semantics
  globally. Not a mitigation.
- **`dangerouslyIgnoreUnhandledErrors: true`**: flips the exit code to 0 while
  79% of the files silently never run. Strictly worse.
- **Timeout raises**: the timeouts are downstream churn of the constant
  runner-replacement storm, not an independent failure class.

### Suggested fix directions

1. **Chunk the warm-module snapshot**: frame the `fetchWarmModules` payload into
   chunks safely under the message cap and reassemble runner-side. This keeps
   warm-start benefits and removes the cap from the equation entirely.
2. **Per-module messages / cap-aware fallback**: if the serialized snapshot
   exceeds a safe threshold, fall back to a sequence of per-module messages (or
   plain per-module fetches — measured ≤ ~4 MB each here). Cheap to detect with
   a size check before `socket.send()`.
3. **Shrink the payload**: de-duplicate the `url`/`id` aliasing and drop or
   lazy-serve inline sourcemaps in snapshots (in our worst single module the map
   was 2.75 MB against 657 KB of code). Lowers the effective ceiling ~4x but
   doesn't remove it — best combined with 1 or 2.
4. **Document the limit and fail loudly per-file**: if an over-cap message is
   unavoidable, retry the file's runner and emit an actionable, attributed error
   ("warm-module payload for test file X is N bytes; exceeds the 32 MiB runner
   WebSocket message cap") instead of an unattributed unhandled error while the
   file silently vanishes. Note the pool already suppresses the
   `disconnected: …` aftermath in `ignoreMessages` as "not user actionable", so
   today the 1009 cause survives only as raw KJ noise while the effect is a
   misleading `Errors N` summary.

### Impact

- **Green suites fail CI**: every affected run exits 1 on unhandled errors even
  with 0 test failures — or, with the unhandled errors suppressed, silently
  loses coverage.
- **It gets worse as the project grows**: the crash set is every sharer of an
  over-cap graph, so it grows with ordinary feature work. We measured 17/153
  files one day and 204/258 (79%) the next, with no config change.
- **The loss is silent and misleading**: affected files neither pass nor fail;
  the only traces are an `Errors N` summary line and raw workerd KJ exceptions
  on stderr. Root-causing this took instrumenting the plugin's send path.
- **It blocks the plugin for exactly its target use case**: any sufficiently
  large codebase (≈14 MB of shared graph source is enough) cannot run its full
  suite through `@cloudflare/vitest-plugin` today.

---

## Filing checklist (internal — not pasted upstream)

- **Target repo:** `cloudflare/workers-sdk`, package dir `packages/vitest-plugin`
  (verified from the installed package's `repository` field). Do not file
  against vitest or miniflare — the message protocol is the plugin's.
- **Template:** `.github/ISSUE_TEMPLATE/bug-template.yaml` ("🐛 Bug Report").
  Required fields map 1:1 to the body above: versions/OS (table), link to a
  minimal repro, description, optional logs (paste the verbatim 1009 trio and
  the "Worker exited unexpectedly during started state" wrapper).
- **Minimal repro link:** publish before filing — extract
  `docs/research/ws1009-repro.tar.gz` (synthetic public-safe fixtures, README
  inside) to a public GitHub repo and link it; the recipe in the body is
  self-contained either way.
- **Labels:** the workers-sdk template assigns none automatically; leave label
  choice to triage. Mention in the text that this affects
  `packages/vitest-plugin` (marked prerelease in its package.json).
- **Re-verify before filing:**
  1. Check the latest released `@cloudflare/vitest-plugin`; if > 1.4.7, re-run
     the repro against it and update the versions table.
  2. Re-run the two commands in the recipe on the filer's machine and confirm
     the counts (17/10 deaths, exit 1) before pasting.
  3. Confirm the boundary pair numbers unchanged on the filer's workerd build.
- **Suggested gh command** (explicit `--title`/`--body-file` bypasses the web
  form — acceptable, or paste section-wise into the 🐛 Bug Report form):

```bash
gh issue create --repo cloudflare/workers-sdk \
  --title '[@cloudflare/vitest-plugin] Runner WebSocket dies with 1009 "Message is too large": the per-file warm-module snapshot (the whole transformed import graph) is sent as a single WebSocket message' \
  --body-file /tmp/ws1009-issue-body.md
```

- **Grep caveats for re-verification:** each death prints 3
  `protocolError.statusCode = 1009` lines (÷3 for events) plus one
  `Worker exited unexpectedly during started state while running test file X`
  attribution; naive `grep -c "1009"` also false-positives on test durations
  ending in `1009ms`.
