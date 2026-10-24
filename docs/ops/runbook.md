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

Expected at engine milestone M1: 32 passed / 35 failed where the 35 are the
documented headless-UI allowlist (`.github/workflows/ci.yml` enforces the exact
set). New failures = regression.

## Deployment

```bash
pnpm setup:deploy   # idempotent: ensure D1+R2, fill database_id, remote migrations
pnpm deploy         # wrangler deploy from apps/worker
```

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
- **e2e new failures beyond the allowlist**: bisect against the gate/engine
  changes; CI fails the build on any divergence by design.
