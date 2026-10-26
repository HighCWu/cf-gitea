# deploy-probes — the REDEPLOY probe battery toolkit

One committed home for the recurring REDEPLOY verification probes, so every
redeploy wave runs the same checks with less drift instead of hand-rolling them
per deploy. Node-run, zero npm deps (stdlib `fetch` + real `git`), conventions
mirror `scripts/deploy-smoke.mjs`: per-check `  [pass] <id> (<ms> ms) — <detail>`
lines (the shape the evidence blocks quote) + a final JSON summary, exit
non-zero iff any check FAILS.

## How to run

```bash
node scripts/deploy-probes.mjs <battery> --base-url https://<worker>.workers.dev \
  --token-file /tmp/pat-0600            # mint-per-run, mode 0600
node scripts/deploy-probes.mjs all --dry-run          # print every probe + its canonical expectation
node scripts/deploy-probes.mjs p0 --dry-run           # single battery plan
```

- Batteries: `p0`, `registry`, `generate-e2e`, `forkpr-e2e`, `ui-login`,
  `cleanup-audit`, `all` (runs them in that order, audit last).
- Against LOCAL dev: `--base-url http://127.0.0.1:5173 --d1-scope local` for
  the audit; mint the PAT with `node scripts/bootstrap-admin.mjs <user>` on
  local D1. A local self-test (all six batteries) was run green from this tree;
  see "Local self-test fixtures" below.
- `--json` puts only the final JSON summary on stdout (progress to stderr),
  same contract as deploy-smoke.

## PAT conventions (non-negotiable)

- The token is **minted per run** by the operator (e.g.
  `node scripts/bootstrap-admin.mjs p0probe --remote` on remote D1) and written
  to a temp file; the raw mint stdout is shredded.
- `--token-file` enforces **mode 0600** (a looser file is refused before any
  request) and the mint shape `cfg_<8hex>_<32base32>`.
- The token is **never echoed**: every progress line, detail, and the JSON
  summary are scrubbed against it — and against the `gitea_session` value the
  ui-login battery captures.
- After the run the operator DELETEs the per-run PAT (by id/prefix) and re-checks
  the token count with `cleanup-audit --expect-tokens 1` (the standing
  bootstrap PAT).

## Batteries and their canonical expectations

Expectations are ported from `docs/design/p0-evidence.md` — the REDEPLOY13
block (2026-10-26, ~lines 1507-1697) for the shallow trio, generate, ui-login,
and the cleanup shapes; the REDEPLOY12 tombstone t+0 proof (~1395-1417) and the
REDEPLOY10 registry re-probe (~991-1030) for the registry sweep. `--dry-run`
prints all of them verbatim.

- **p0** — the shallow trio against the standing private fixture
  (`<user>/p0-shallow`, default user `p0probe`): shallow-since and
  shallow-exclude clones exit 128 with the server text naming `'deepen-since'`
  / `'deepen-not'` (only depth-limited shallow fetches are supported);
  `--depth=1` exits 0 with `.git/shallow` == the HEAD tip, exactly 1 commit,
  `is-shallow-repository` true, fsck clean. Auth rides `http.extraHeader` on
  every clone (the evidence methodology). Tail: the fixture stays PRIVATE —
  anonymous API GET 404, anonymous `info/refs` 401 Basic challenge, anonymous
  web page 404. `--fixture-oid` pins the standing tip
  (`502abd2d5561536873088528a9f57f02cd1633e1` in production).
- **registry** — N tombstone lifecycles (`--trials`, default 3; the REDEPLOY12
  proof ran 3/3): create public repo (201) → anonymous advert settles (exit 0,
  HEAD + main) → PATCH rename (200) → IMMEDIATE anonymous ls-remote on the NEW
  name lists ALL refs (the carry) → DELETE (204) → **THE VERY NEXT** anonymous
  ls-remote on the renamed name answers 128 `repository not found` (single-shot,
  NO sleep — the closed read-after-delete window stays closed) → the old name
  is dead on both paths (git 128, API 404). Doubles as the registry regression
  sweep (create → rename carry → delete t+0).
- **generate-e2e** — template → REAL PUSH (LICENSE commit on the auto_init
  main + second ref `refs/heads/dev`) → `PATCH {"template":true}` (200 with
  `"template":true` in the body, persisted) → `POST …/generate
  {"git_content":true}` (201 with `"empty":false` in the body) → follow-up GET
  `empty:false` → the generated repo lists main+dev at the IDENTICAL carried
  tip → contents API 200 with LICENSE decoding verbatim and
  `last_commit_sha` = the carried tip. `gen-generated-clone` reports
  **[warn]** while the carried REDEPLOY13 git-wire issue is open (the
  generated cell serves API reads but not the git wire); it reports [info]
  when a clone succeeds (the issue is fixed — seen on the post-REDEPLOY13
  tree) and pass/fails hard under `--strict-generated-clone`. The
  `status='creating'` == 0 arm lives in cleanup-audit.
- **forkpr-e2e** — base repo (201) → doer-owned org (`POST /orgs`, 201) →
  fork INTO the org (202, upstream's CreateFork accepted code, the DEFAULT
  slug kept: `<org>/<base>`) → the fork's refs settle (async copy) → push a
  branch to the fork → `POST /pulls` with the bare cross-repo `owner:branch`
  head (201; the head-branch existence read runs in the FORK cell) → GET the
  PR: `head.label` = the branch, `head.sha` = the fork tip,
  `head.repo.full_name` = `<org>/<base>`, base = main, `mergeable` a boolean
  (never a stuck null; the landed payload renders `head.ref` as
  `refs/pull/N/head`). The bare `owner:branch` form resolves
  (owner, base-slug) per the landed `resolveHeadRepo` — the default-slug
  org fork is the upstream-default shape that coincides with it (the landed
  divergence note in `apps/worker/src/api/routes/pulls.ts`). No prior
  evidence block exists for this battery (the fork-PR create landed at
  a16f60e, post-REDEPLOY13) — the next REDEPLOY run is its first production
  evidence.
- **ui-login** — the login-cookie methodology (b5facba's lesson; REDEPLOY12's
  OPEN ISSUE 3 closed): a PAT header never logs a session in. Anonymous labels
  page 200 with 0 "New Label" occurrences → `POST /login`
  (form-urlencoded `user_name` + `password=<PAT>`) → 303 + `gitea_session` →
  labels page WITH the cookie 200 with the writer form (canonical 3
  occurrences, `--new-label-count`) + `small-menu-items`.
- **cleanup-audit** — one wrangler d1 execute (`--d1-scope remote|local`,
  default remote) runs the whole count shape; the checks are INDEPENDENT (one
  red count never hides the rest): probe-user repositories == 1 (the standing
  `p0-shallow`, `--expect-owner-repos`), `status='creating'` == 0, `action`
  == 0 (the 389da18 delete sweep — NO hand-sweep), `stars` == 0,
  `push_mirrors` == 0, `protected_branches` == 0, `repo_redirects` == 0,
  `user_blocking` == 0, `personal_access_tokens` == 1 (the standing bootstrap
  PAT, `--expect-tokens`). The one honest exception to `action == 0`: a push
  to the still-live fixture (the local seed flow) leaves its own action rows —
  production probe runs only clone it, so the canonical whole-table 0 holds.

## Leftovers and hygiene

- Every battery deletes what it creates (204s); a failed cleanup is reported
  as **[warn]** + `left_behind` in the summary (documented, never fatal), and
  the next run's `cleanup-audit` is what proves the ground back to the
  canonical shape.
- A red run may leave its repos in place for debugging (the lfs-e2e
  convention); the next run names fresh random repos (`reg-`, `tmpl-`/`gen-`,
  `prbase-`/`prorg-`, `ui-` prefixes), so pre-cleanup is a `cleanup-audit`
  away.
- Scratch dirs live under `os.tmpdir()` and are removed per battery; the PAT
  file is the operator's to shred.

## Deliberately not ported (yet)

- The push-mirror lifecycle probe (REDEPLOY13): full e2e to a real external
  remote stays out of probe scope (no external credentials); the
  registration-time SSRF-gate arm (loopback 401 / `.invalid` 200 + sync
  `last_error`) is a natural future subcommand.
- The wrangler-tail attachments (registry/tombstone traces) — the toolkit is
  HTTP/git-only; attach a tail manually when adjudicating a red.

## Local self-test fixtures

The committed tree was verified with a full `all` run against `pnpm dev`
(local D1, migrations applied). Local scratch keeps: the `dpprobe` user
(bootstrap-admin, several local tokens — pass the real count via
`--expect-tokens` for local audits) and its private `p0-shallow` fixture
(tip `8582c5545ac5cbc4eafca46363dd5141c7ae87f9`). Production runs use
`p0probe` and the standing fixture pinned by `--fixture-oid` instead.
