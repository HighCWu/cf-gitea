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

## Deploy UX (2026-10-28)

Every claim below was verified against the tree and `git log` at bookkeeping
time; citations name the commit or the code site.

- **The example-file model** (the gitorange installer pattern): the only
  committed configs are `apps/worker/wrangler.jsonc.example` and
  `apps/worker/.dev.vars.example`. The real `wrangler.jsonc` is gitignored
  and account-local — `pnpm setup:deploy` copies the example on first run,
  ensures D1 `cf-gitea` + R2 `cf-gitea-packs`, fills the real `database_id`
  (comment-preserving single-line swap), and applies remote migrations
  (`scripts/setup-deploy.mjs`; read-only drift probe: `-- --check`).
- **The Deploy button** (README "Deploy it", deploy.workers.cloudflare.com):
  clones the repo into the deployer's GitHub account, provisions D1 + R2
  automatically (ids filled in), builds and deploys via Workers Builds —
  works on the free plan. What remains after it finishes:
  1. the secrets — `wrangler secret put GIT_TOKEN` (always);
     `MIRROR_ALLOWED_HOST_LIST` + `MIRROR_CREDENTIAL_KEY` only when mirror
     features are wanted;
  2. the `/install` browser step — with the users table empty, the login
     page offers **Initialize This Instance** (GET/POST `/install`): create
     the admin in the browser and you are signed in. One-shot: the form is
     gone once any account exists (the window also closes on org rows;
     the decision is a single `INSERT ... WHERE NOT EXISTS`, no TOCTOU —
     commit `515a594`, mounted by `df1e362`).
- **APP_URL is optional** (`apps/worker/src/services/webhooks-push.ts:219`:
  `env.APP_URL ?? requestOrigin ?? DEFAULT_APP_URL`): webhook payload URLs
  and the UI's `window.config.appUrl` fall back to the serving request's own
  origin, so a plain workers.dev deploy names itself correctly. Set the var
  only when serving behind a custom domain, or for mirror deployments whose
  payload URLs must name a different public origin.
- **The repo-tasks DLQ** (SPEC-0014 M0 — handler `385f768`, config/dispatch
  `de486aa`): `repo-tasks` carries `dead_letter_queue: repo-tasks-dlq`
  (max_retries 5) with a DLQ consumer (max_retries 1, batch 10 — the
  webhook-delivery DLQ's posture); `index.ts` dispatches `repo-tasks-dlq`
  before the `handleRepoTasks` fallback. The SQLITE_LOCKED purge-drop class
  is now captured and logged verbatim (manual redrive against the log;
  steps idempotent) instead of silently discarded. **Deploy note:** the
  `repo-tasks-dlq` queue itself must exist at deploy time —
  `wrangler queues create repo-tasks-dlq` if the platform does not
  auto-provision consumer-declared queues (`de486aa`'s deploy note).
- **ALLOW_SIGNUP defaults closed** (`apps/worker/src/services/user-accounts.ts`,
  `allowSignup`: absent-safe FALSE unless the var is explicitly `"true"` or
  `"1"` — upstream DISABLE_REGISTRATION's inverted polarity; the example
  config ships `"ALLOW_SIGNUP": "false"`). Self-registration stays off until
  the operator flips it; the admin-init window is the intended first
  account.
