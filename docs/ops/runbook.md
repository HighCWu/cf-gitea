# Operating runbook

Everything an operator needs to run cf-gitea end to end. Prereqs: Node ≥22,
pnpm (version from `packageManager`), git ≥2.22, `git submodule update --init`.

## Daily development

```bash
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # GIT_TOKEN dev fallback
pnpm dev            # vite dev on :5173, real local D1/DO/R2 in workerd
pnpm typecheck && pnpm lint && pnpm test                 # gates (CI-parity)
pnpm check:api && pnpm check:contract                    # contract checks
```

Local D1 state lives under `apps/worker/.wrangler/` (miniflare persistence —
`wrangler d1 execute cf-gitea --local` and `pnpm dev` share it). Reset it by
deleting that directory, then `pnpm db:migrate:local`.

## First user bootstrap (the users table starts empty)

```bash
node scripts/bootstrap-admin.mjs <username> [email]          # local D1
node scripts/bootstrap-admin.mjs <username> [email] --remote # production
```

Creates the admin user if missing and mints an all-scopes PAT; the plaintext
prints exactly once (only its sha256 digest is stored). Then:

```bash
git remote add origin http://<user>:<PAT>@<host>/<user>/<repo>.git   # push = create
curl -H "Authorization: token <PAT>" <host>/api/v1/user
```

The git authorize hook verifies PATs first; the `GIT_TOKEN` static secret is a
dev/e2e fallback only (removed with SPEC-0003's full gate). Rotate a leaked PAT
by minting a new one via the token API and deleting the old row.

## e2e suite (real git client)

```bash
pnpm dev &   # wait for /healthz
PATH="$PWD/packages/git-engine/e2e/shim:$PATH" \
  packages/git-engine/e2e/e2e.sh http://127.0.0.1:5173/demo devtoken
```

Expected score, as of 2026-10-25 02:20 CST: **34 passed / 35 failed**, where the
35 are the documented headless-UI allowlist (enforced as an exact-set gate by
`.github/workflows/ci.yml`). History: at engine M1 the split was 32/35; commit
59a0776 (SPEC-0001a Steps 3-4 + branch-create hotfix) added two zero-object-pack
regression checks — both pass, so the pass line moved 32 → 34 while the
allowlist rows stayed unchanged at 35 (69 checks total). The SPEC-0001b
merge/fork/invariants waves added their gates as separate tsx check scripts
(`packages/git-engine/e2e/check-merge-*.mjs`, `check-fork-replicate.mjs`,
`check-catalog-rpc.mjs`, `check-deepen-parse.mjs`), not e2e.sh rows, so this
score has not moved since. New failures = regression.

## Differential testing (git-CLI battery, `pnpm diff:test`)

```bash
pnpm diff:test -- --ours http://127.0.0.1:5173 --token <PAT>
# optionally against a real Gitea (or any git smart-HTTP server):
pnpm diff:test -- --ours http://127.0.0.1:5173 --token <PAT> \
  --theirs https://gitea.example.com --theirs-token <PAT>
```

Runs the SAME real git-CLI commands (read + write batteries in
`scripts/diff-cases/`, 10 cases — 6 read + 4 write) against "ours" (local dev or
the deployed Worker) and, when `--theirs` is given, a reference server; the
stored reports must differ only in ways the declared compatibility rules allow
(`scripts/diff-cases/rules.mjs`). Without `--theirs` the run is an ours-only
baseline snapshot for a future `--compare`. Reports land in
`scripts/diff-report-*.json` (gitignored — compare pairs against the committed
rules, not against the repo). Harness landed in 48903f8; the `--theirs` compare
mode has been exercised for real (compare reports from 2026-10-24 runs exist
alongside ours-only baselines). Not wired into CI — run it before claiming a
compatibility regression is fixed.

## LFS e2e (real git-lfs client, `pnpm test:lfs`)

```bash
pnpm test:lfs                        # or: bash scripts/lfs-e2e.sh [base-url]
```

33 checks exercising the REAL `git-lfs` binary against a running dev Worker:
D1-backed push-create, >100 KB LFS push asserted via `GIT_TRACE_CURL` (batch /
PUT / verify, `lfs_objects` row flipping to `verified`, R2 object hashing back
to the oid), fresh-clone smudge byte-identity, no-reupload on re-push. All
traffic goes through the relay store (local dev has no R2 S3 credentials).
Requires `git-lfs` on PATH. Details: `scripts/lfs-e2e.README.md` (landed in
0e48e77; CI wiring deliberately not in the script — the README carries the
suggested job).

## Import / mirror clients (final state, 2026-10-25 02:20 CST)

All three clients are landed and committed; the Worker-side mirror-sync half of
SPEC-0009 is the only outstanding piece of this family.

- **`scripts/import-client.mjs`** — chunked import client, the SPEC-0003 §2.6
  producer side: splits a repo's history into self-contained topo-ordered
  commit windows (non-thin packs), uploads them through the Worker-relayed
  chunk endpoint, starts the import with a validated manifest, polls until the
  server lands the refs. Zero npm dependencies (git plumbing + fetch).
  **Landed** in 09132c1 together with the server-side channel
  (`apps/worker` imports routes/services + migration 0006).
- **`scripts/import-batched-push.sh`** — client-side batched push, the
  SPEC-0003 §2.7 fallback that needs no server changes: advances the branch
  tip through topo-ordered windows so each push transfers only the thin-pack
  delta since the previous tip. **Landed** in 09132c1.
- **`scripts/mirror-import.mjs`** — the SPEC-0009 §2.6 import-from-URL
  producer (ab56ec9, README in `scripts/mirror-import.README.md`): a real
  outbound `git clone --mirror` of any https source, split into pack windows
  and driven through the SAME import channel as a user upload. https-only by
  policy (§1 divergence); credentials never in URLs/argv/logs; `--dry-run`
  plans locally; `--resume <id>` re-enters an import.
- **SPEC-0009 mirror sync, Worker half** (outbound smart-HTTP client,
  `services/mirror/gitclient.ts`, AES-GCM creds): **not landed** — spec only.
  Until it exists, scheduled pull-mirroring means running `mirror-import.mjs`
  from a cron/CI machine.

Use either import path for histories above the proxy body cap (see the 413
entry under Troubleshooting).

## Repository invariant checker

The periodic-prover item from the external review
(`docs/design/m3-design-inputs.md`): for every repository, prove that every
advertised ref points at an existing, readable object, that reachable closures
are complete, that a terminal push leaves no dangling staging, and that the
DO's `pack_catalog` and the REPO_PACKS bucket agree in both directions
(c91135d + 53276b7). Code: `apps/worker/src/invariants/` (`check.ts` per-repo
walker over the engine's public read RPCs + R2 probes; `run-all.ts` the
fleet-wide sweep). Exercised today by the vitest suite
(`apps/worker/src/invariants/invariants.test.ts` — healthy-repo passes,
injected-violation detection, budget/partial semantics); **the production
wiring below is not connected yet** (no consumer guard in
`apps/worker/src/repos/purge.ts`, no cron in `wrangler.jsonc` as of
2026-10-25 02:20 CST).

Two invocation shapes, both bounded per invocation (crons enqueue, consumers
do the work):

- `enqueueRepoInvariantChecks(env)` — pages the `repositories` table and
  sends one REPO_TASKS message per repo (`{kind: "invariant-check",
  engineName, storageKey}`). Consuming needs one guard clause at the top of
  the shared consumer's message loop (`src/repos/purge.ts`):

  ```ts
  import { isInvariantCheckMessage, handleInvariantCheckMessage } from "./invariants/run-all";
  // inside the batch loop, before the purge/import dispatch:
  if (isInvariantCheckMessage(message.body)) {
    await handleInvariantCheckMessage(env, message.body);
    message.ack();
    continue;
  }
  ```

- `runAllInvariantChecks(env, { maxRepos })` — enumerate + check inline, for
  an admin endpoint or a small fleet. Cron wiring sketch for `wrangler.jsonc`
  (every 6 h) plus the scheduled handler:

  ```jsonc
  "triggers": { "crons": ["0 0,6,12,18 * * *"] }
  // export default { …, async scheduled(_event, env, _ctx) {
  //   await enqueueRepoInvariantChecks(env, {});
  // } }
  ```

Semantics an operator should know: repos in `creating`/`migrating` status are
skipped (engine cells not settled yet); content violations are reported and
acked (facts, not failures) — only transport-class faults throw so the queue
retries; `partial: true` in a report means a budget stopped the proof early,
so `ok` asserts less, never more. Detection horizon: the DO's GitStore cache
keeps every commit that was EVER a ref tip readable until the cell recycles,
so ref-tip-level faults on such commits surface only after eviction — trees,
blobs, never-advertised ancestors, and catalog↔R2 mismatches are observed
immediately.

## Deployment

```bash
pnpm setup:deploy   # idempotent: ensure D1+R2, fill database_id, remote migrations
pnpm build          # REQUIRED before deploy: wrangler deploys dist/cf_gitea's
                    # generated config — a stale dist carries the old wrangler
                    # state (a pre-fill dist caused a placeholder-database_id
                    # deploy failure on first attempt)
pnpm deploy         # wrangler deploy from apps/worker
```

Live (first deploy 2026-10-24): **https://cf-gitea.hecongw.workers.dev** —
smoke-verified end to end: remote admin bootstrap, PAT-authenticated
create-by-push, `ls-remote`, Basic-auth token API, `last_used_at` updates.

Cloud resources and IDs: `docs/ops/deploy-notes.md`. Secrets: `GIT_TOKEN` is
declared required in wrangler.jsonc (`wrangler secret put GIT_TOKEN`) — used
only as the dev-fallback credential until SPEC-0003's ACL lands; do not rely on
it for real access control in production, mint PATs instead.

## Benchmarks

```bash
pnpm bench  # see scripts/bench-run.mjs —  fixtures via scripts/gen-bench-fixtures.mjs
```

Baselines live in `scripts/bench-baselines/<milestone>.json` (committed);
transient results in `.bench-results/` (gitignored). Official baselines record
per engine milestone (M2 lands the first).

## Troubleshooting

- **401 on git ops with a valid-looking PAT**: the token was printed once at
  mint; if lost, mint another. Check the user exists and is `active`.
- **`no such table` from the worker in dev**: run `pnpm db:migrate:local`.
- **Contract check fails after a submodule move**: that is ADR-0002's re-pin
  procedure, not a bug — see `apps/worker/src/compat/contract/README.md`.
- **Push fails with HTTP 413 (content too large)**: the Cloudflare proxy caps
  request bodies (~100 MB on non-Enterprise plans) before the Worker runs —
  verified empirically 2026-10-24 (110 MiB push → 413). Route histories above
  the cap through the import channel (SPEC-0003 §2.6; presigned R2 uploads
  bypass the proxy) or negotiate a higher plan body limit.
- **e2e new failures beyond the allowlist**: bisect against the gate/engine
  changes; CI fails the build on any divergence by design.
