# Deployment notes (cloud resources)

Provisioned 2026-10-24 by the orchestrator (account already authenticated via wrangler;
names verified non-colliding with the account's other projects).

| Resource | Name | ID / notes |
|---|---|---|
| D1 database | `cf-gitea` | `database_id: a72f93d3-f85a-411e-880e-7effaed306bb` — replace the placeholder in `apps/worker/wrangler.jsonc` at Wave-3 integration |
| R2 bucket | `cf-gitea-packs` | binding `REPO_PACKS` (packs, staging, clone-cache, later LFS `lfs/` prefix) |

Local dev/tests do NOT use these (workerd miniflare provides local D1/DO/R2). They are
needed for `pnpm db:migrate:remote` and `pnpm deploy`.

One-command bootstrap (idempotent — detects/creates both resources, fills the real
`database_id` into `apps/worker/wrangler.jsonc`, applies remote migrations):

```bash
pnpm setup:deploy        # then: pnpm deploy
pnpm setup:deploy -- --check   # read-only drift check (CI/orchestration)
```

First remote migration: `pnpm db:migrate:remote`. First deploy: `pnpm deploy`.
