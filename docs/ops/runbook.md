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

Expected score, as of 2026-10-24 23:15 CST: **34 passed / 35 failed**, where the
35 are the documented headless-UI allowlist (enforced as an exact-set gate by
`.github/workflows/ci.yml`). History: at engine M1 the split was 32/35; commit
59a0776 (SPEC-0001a Steps 3-4 + branch-create hotfix) added two zero-object-pack
regression checks — both pass, so the pass line moved 32 → 34 while the
allowlist rows stayed unchanged at 35 (69 checks total). New failures = regression.

## Differential testing (git-CLI battery, `pnpm diff:test`)

```bash
pnpm diff:test -- --ours http://127.0.0.1:5173 --token <PAT>
# optionally against a real Gitea (or any git smart-HTTP server):
pnpm diff:test -- --ours http://127.0.0.1:5173 --token <PAT> \
  --theirs https://gitea.example.com --theirs-token <PAT>
```

Runs the SAME real git-CLI commands (read + write batteries in
`scripts/diff-cases/`, 10 cases) against "ours" (local dev or the deployed
Worker) and, when `--theirs` is given, a reference server; the stored reports
must differ only in ways the declared compatibility rules allow
(`scripts/diff-cases/rules.mjs`). Without `--theirs` the run is an ours-only
baseline snapshot for a future `--compare`. Reports land in
`scripts/diff-report-*.json` (gitignored — compare pairs against the committed
rules, not against the repo). Harness landed in 48903f8; not wired into CI.

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

## Import / mirror clients

Landed vs in flight, as of 2026-10-24 23:15 CST (parallel import wave was
mid-flight — verify with `git status` before relying on this split):

- **`scripts/import-client.mjs`** — chunked import client, the SPEC-0003 §2.6
  producer side: splits a repo's history into self-contained topo-ordered
  commit windows (non-thin packs), uploads them through the Worker-relayed
  chunk endpoint, starts the import with a validated manifest, polls until the
  server lands the refs. Zero npm dependencies (git plumbing + fetch). **In
  flight** — uncommitted at snapshot; depends on the server-side channel
  (`apps/worker` imports routes/services + migration 0006) landing first.
- **`scripts/import-batched-push.sh`** — client-side batched push, the
  SPEC-0003 §2.7 fallback that needs no server changes: advances the branch
  tip through topo-ordered windows so each push transfers only the thin-pack
  delta since the previous tip. **In flight** — uncommitted at snapshot.
- **SPEC-0009 mirror sync** (outbound smart-HTTP client, AES-GCM creds): spec
  only — no client code landed yet.

Use either import path for histories above the proxy body cap (see the 413
entry under Troubleshooting).

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
