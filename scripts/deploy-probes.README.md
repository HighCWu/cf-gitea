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
node scripts/deploy-probes.mjs cleanup-audit --d1-scope local --user dpprobe --expect-tokens 5
                                                      # D1-only: --base-url/--token-file optional
```

- Batteries: `p0`, `registry`, `generate-e2e`, `forkpr-e2e`, `mirror`,
  `ui-login`, `window2-mounts`, `window3-mounts`, `fixwave-parity`,
  `cleanup-audit`, `all` (runs them in that order, audit last).
- **The `cleanup-audit` battery is D1-only** (wrangler d1 execute, no HTTP): it
  takes neither `--base-url` nor `--token-file` — a missing token only errors
  when a selected battery actually makes HTTP calls (REDEPLOY15 friction: the
  audit used to demand a PAT, forcing a scratch-mint + delete dance). A
  supplied token file is still validated (0600, mint shape) and scrubbed.
- **PAT-identity preflight**: before any HTTP battery runs, one
  `GET /api/v1/user` with the PAT compares its `login` to `--user`. Repo
  creation is doer-relative (`POST /user/repos` lands in the PAT's own
  namespace) while every follow-up arm addresses `/repos/<--user>/…`, so a
  `--user` that does not match the PAT's login used to create repos and then
  404 every follow-up arm. The mismatch now exits 2 BEFORE anything is
  created — one line naming the actual login, the requested `--user`, and
  both fixes (mint the PAT as that user, or pass the matching `--user`); a
  match passes silently. One request per invocation (cached); a refused PAT
  (`/user` → 401) fails fast in the same shape. The D1-only `cleanup-audit`
  has no HTTP surface and never triggers it.
- Against LOCAL dev: `--base-url http://127.0.0.1:5173 --d1-scope local` for
  the HTTP batteries (the mirror row-settle arm reuses `--d1-scope`); mint the
  PAT with `node scripts/bootstrap-admin.mjs <user>` on local D1, and pass the
  matching `--user`. A local self-test (the seven batteries committed at the
  time — `window2-mounts` landed after) was run green
  from this tree; see "Local self-test fixtures" below.
- `--json` puts only the final JSON summary on stdout (progress to stderr),
  same contract as deploy-smoke.

## PAT conventions (non-negotiable)

- The token is **minted per run** by the operator (e.g.
  `node scripts/bootstrap-admin.mjs p0probe --remote` on remote D1) and written
  to a temp file; the raw mint stdout is shredded. (Exception: the D1-only
  `cleanup-audit` battery reads no HTTP surface and runs without a PAT.)
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
the cleanup shapes, and the push-mirror credential-free arms (~1600-1610);
the REDEPLOY12 tombstone t+0 proof (~1395-1417) and the
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
  sweep (create → rename carry → delete t+0). **Failure cleanup (the
  consistency posture):** a mid-battery red used to leave the trial repo
  behind `[skip]` lines for a hand-clean; a finally-style tail (the
  generate-e2e shape) now best-effort deletes every created-and-not-yet-deleted
  trial repo under the fullName the server last returned — re-pointed by the
  rename, so a red before it sweeps the create name and a red after it the
  renamed one (logged on one `[tail] reg-leftover-sweep` line; failures feed
  `left_behind`, never fatal; a green run no-ops silently).
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
  `status='creating'` == 0 arm lives in cleanup-audit. **Failure cleanup
  (REDEPLOY16 friction):** a mid-battery red (e.g. the TLS flake that
  stranded `tmpl-85c28975` in production) used to chain-skip `gen-cleanup`
  and leave the template — and, once generate answered, the generated — repo
  behind `[skip]` lines for a hand-clean; a finally-style tail (the mirror
  battery's shape, `repoFullName`-tracked) now best-effort deletes the
  generated repo first, then the template (logged on one
  `[tail] gen-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently because `gen-cleanup` already emptied
  both).
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
  evidence. **Failure cleanup (the consistency posture):** a mid-battery red
  used to leave the base/org/fork behind `[skip]` lines for a hand-clean; a
  finally-style tail (the generate-e2e shape, `*FullName`-tracked) now
  best-effort deletes fork first (it hangs off the base and lives in the
  org), then the base, then the org (logged on one
  `[tail] forkpr-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently).
- **mirror** — the push-mirror credential-free arms (REDEPLOY13's evidence,
  ~1600-1610; full e2e to a real external remote stays out of scope — no
  external credentials). A private auto_init source repo (201), then:
  **ARM 1, the SSRF egress gate at registration** — `POST push_mirrors` with
  the loopback target `https://127.0.0.1:9/dummy-unreachable.git` → **401
  "Permission denied"** and the list stays empty (nothing written; https is
  required to reach the gate at all — plain `http://` lands in the 400
  "Invalid mirror protocol" bucket first, and port 9 stays refused under both
  the production lax default and local dev's explicit `127.0.0.1:8443` allow
  entry). **ARM 2, the `.invalid` lifecycle** — the gate-passing unreachable
  `https://pmir-<hex>.invalid/dummy-unreachable.git` registers **200** with
  the fresh-row wire (`last_error` "", `last_update` null, `interval`
  `8h0m0s`, `sync_on_commit` false, `remote_name` `remote_mirror_<10 alnum>`)
  → `push_mirrors-sync` **200** (the enqueue) → poll the mirror (budget
  `--mirror-settle-ms`, default 30 s) until the consumer's failed attempt
  settles: `last_error` non-empty and naming the target advertisement URL
  `[<addr>/info/refs?service=git-receive-pack]` (canonical production text:
  "mirror target responded 530 for info/refs advertisement …"; local dev's
  unresolvable-host fetch reads "request failed" with the same bracketed URL
  — the settle writes `last_error` and `sync_state='idle'` in the same
  update) → the row re-read via wrangler d1 (`--d1-scope`):
  `sync_state='idle'` (no stuck state), `next_sync_at=0` (the failure left
  the fresh row unscheduled) → DELETE **204** and the list back to `[]`.
  Cleanup deletes the probe repo; the audit battery's `push_mirrors` == 0
  expectation stays true. The settle budget: REDEPLOY15 observed a PRODUCTION
  settle at 12 s once in two runs (pure queue-latency variance; the re-run
  settled at 1.3 s) against the debut 10 s default — the default is now 30 s
  (~2.5x the observed worst); tighten for quick local runs with
  `--mirror-settle-ms`. **Failure cleanup (REDEPLOY15 friction):** a
  mid-battery red used to chain-skip the delete arms and strand the mirror
  row + repo behind `[skip]` lines; a finally-style tail now best-effort
  sweeps exactly what the run created and has not already deleted (logged on
  one `[tail] mir-leftover-sweep` line; failures feed `left_behind`, never
  fatal, and a green run no-ops silently) — a red run no longer breaks the
  next audit's `push_mirrors` == 0.
- **ui-login** — the login-cookie methodology (b5facba's lesson; REDEPLOY12's
  OPEN ISSUE 3 closed): a PAT header never logs a session in. Anonymous labels
  page 200 with 0 "New Label" occurrences → `POST /login`
  (form-urlencoded `user_name` + `password=<PAT>`) → 303 + `gitea_session` →
  labels page WITH the cookie 200 with the writer form (canonical 3
  occurrences, `--new-label-count`) + `small-menu-items`. **Failure cleanup
  (the consistency posture):** the battery creates a fixture repo (any repo
  has a labels page), so a mid-battery red no longer leaves it behind
  `[skip]` lines — a finally-style tail (the mirror shape,
  `repoFullName`-tracked) best-effort deletes it (logged on one
  `[tail] ui-leftover-sweep` line; failures feed `left_behind`, never fatal;
  a green run no-ops silently).
- **window2-mounts** — the window-2 mount sweep over the user-settings tab
  family (window-2a 0c2b151: 8 modules / 19 routes; more sub-windows land
  before the deploy, so every tab arm reads the mount state **at run time** —
  a 404 from a tab path is a documented `[warn]`, the not-yet-mounted
  degradation, while anything mounted asserts hard). Login-cookie
  methodology first (`POST /login` → `gitea_session`; a PAT header never
  reads a UI page), then: anonymous GET of all 8 tab paths (appearance,
  security, actions/secrets, actions/variables, hooks, keys, applications,
  organization) → 303 with location **exactly**
  `/login?redirect_to=<encoded path>` (the mounted login shape — upstream's
  `/user/login` form lives at `/login` here); cookie GET of each tab → 200
  text/html carrying that page's pageClass discriminator as the **full class
  attribute** (`class="page-content user settings sshkeys"` etc. — the
  modules' BaseLayout strings, the shape the module tests pin); then the
  mounted write arms — the **secret round-trip** (invalid name → 200
  re-render with the exact ValidateName text; create with CRLF-bearing data →
  303 exactly `/user/settings/actions/secrets`; row + description visible and
  the delete form's hidden numeric id captured; delete by id → the same exact
  303; the name gone; re-delete of the same id → still 303, upstream's
  every-arm-303s idempotency), the **keys add-form negative** (`type=ssh`
  with garbage content → 200 re-render with the exact 422 text "Cannot verify
  your SSH key: invalid key format: illegal base64 data" and a fresh GET
  showing no row), and the **last-owner leave flash** (doer-owned org via
  `POST /api/v1/orgs`, sole-owner leave → 303 exactly
  `/user/settings/organization?error=last-owner`, then the flash page renders
  the `ui negative message` — asserted on the un-escaped tail because
  renderToString HTML-escapes the locale's apostrophes). The EOL note: the
  web write path normalizes CRLF→LF (NormalizeStringEOL) but secret values
  are write-only on every surface (the row renders `******`, the user API is
  PUT/DELETE-only), so the normalization is **not observable** — the POST
  carries CRLF to exercise the arm, the observable asserts are the 303
  targets + the row's name/description. The write arms send a same-origin
  `Origin` header so they exercise §2.8's sameOriginGuard PASS arm. **Failure
  cleanup (the consistency posture):** a finally-style tail best-effort
  deletes the secret **by name** via the user API
  (`DELETE /user/actions/secrets/<name>` — covering the red-before-the-row-id
  edge) and the org (logged on one `[tail] w2-leftover-sweep` line; failures
  feed `left_behind`, never fatal; a green run no-ops silently).
- **window3-mounts** — the window-3 mount sweep over the ~12
  committed-unmounted UI surfaces (the RD20 wrap battery): the releases/tags
  feed tails (`releases.rss|.atom`, `tags.rss|.atom` — exact writeFeed
  content-types + channel titles + the `MustBeNotEmpty` empty-repo 404 arm),
  the wiki raw byte arm (`/wiki/raw/*` — a pushed page's coded + `.md`-alias
  probes, the ETag/304 pair, `text/plain`, the absent-wiki 404), the profile
  stars/watching/followers/following tabs (the mounted `?tab=activity` arm
  rides along), the `/-/admin` users/orgs/repos lists (admin-cookie 200s with
  the pageClass + probe rows, the anonymous login-303 arm), the user-settings
  account/notifications tabs (read-only — the POST arms are NOT probed), the
  milestone list→detail round-trip, and the issue content-history list tail
  (the `{"results":null}` pre-edit empty arm). Login-cookie methodology first
  (`POST /login` → `gitea_session`; a PAT header never reads a UI page); the
  wiki write arm sends a same-origin `Origin` header so it exercises §2.8's
  sameOriginGuard PASS arm. Like window2-mounts, every surface reads the
  mount state AT RUN TIME: a 404 from a not-yet-mounted path is the
  documented `[warn]` degradation (for the profile tabs, a 200 that is still
  the inert repositories view warns the same way), while anything mounted
  asserts hard. Fixtures: one public auto_init probe repo (the feeds'
  non-empty gate, the wiki page, the issue, the milestone) + one empty public
  repo (the feeds' 404 arm) — both DELETEd on green (the issue/milestone/
  wiki-page rows cascade with the repo), so cleanup-audit needs no new
  residue expectations. **Failure cleanup (the consistency posture):** a
  finally-style tail best-effort deletes both repos (logged on one
  `[tail] w3-leftover-sweep` line; failures feed `left_behind`, never fatal;
  a green run no-ops silently). No extra options.
- **fixwave-parity** — the RD23 fix wave's LIVE parity matrix, one probe
  family per landed behavior (each self-cleans): the PR head-sync (a second
  push to an open PR moves `refs/pull/N/head`; the PR row's `head.sha`
  follows and `mergeable` re-resolves) chained into the merged-PR PATCH 412
  (the verbatim "cannot change state of this pull request, it was already
  merged") and the strict `?sha=zzz-ghost` commits 404 over one repo; the
  tag-only FIRST push surviving the create's settle (the row reads back via
  the API, the pushed tag lists); the org-team revoke's masked-404 git cut
  (the member's own minted PAT reads the advert before, answers git 128
  `repository not found` + a masked API GET after, while the owner still
  reads); the private user's anonymous-404 / admin-200 visibility ladder;
  the sudo pair (the admin PAT + `Sudo: <target>` shows the TARGET's login;
  the target's own non-admin PAT + Sudo answers the exact upstream 403
  "Only administrators allowed to sudo."); and the session rotation's full
  cookie directive (the `rotated_at` backdated 25 h via wrangler d1 — the
  toolkit's first D1 WRITE path — then GET /login re-sets the FULL
  `gitea_session` directive, the adopted secret round-trips, and the stale
  pre-rotation secret authenticates nothing). **Independent** (the
  cleanup-audit precedent): every family reports its own verdict — a red
  family never chain-skips the rest of the matrix (pre-RD23 every family
  legitimately reds; the post-deploy run is the verdict). Flags: no extra
  options, but it needs an **ADMIN PAT** (`--user` must be the site admin —
  `POST /admin/users` and the sudo pair) and **wrangler auth for the D1
  arms** (`--d1-scope` picks the database, remote by default — keep it in
  step with `--base-url`). **Failure cleanup (the consistency posture):** a
  finally-style tail best-effort sweeps the repos (org repo, PR repo,
  tag-only repo), then the org, the member user (its PAT rows cascade), and
  the session row via D1 (logged on one `[tail] fw-leftover-sweep` line;
  failures feed `left_behind`, never fatal; a green run no-ops silently).
- **cleanup-audit** — one wrangler d1 execute (`--d1-scope remote|local`,
  default remote) runs the whole count shape; **D1-only, so it runs without
  `--base-url`/`--token-file`**; the checks are INDEPENDENT (one red count
  never hides the rest): probe-user repositories == 1 (the standing
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
- **Every battery that creates server-side state self-cleans on a red** (the
  consistency posture — the orchestrator's REDEPLOY16 decision: the
  cleanup-audit battery exists precisely to prove zero leftovers, so red runs
  self-sweeping beats the old lfs-e2e leave-for-debug convention). Each
  state-creating battery carries a finally-style failureTail that
  best-effort deletes exactly what the run created and has not already
  deleted:
  - `generate-e2e` — generated repo first (it hangs off the template), then
    the template; `[tail] gen-leftover-sweep` (REDEPLOY16 friction).
  - `mirror` — mirror rows first (covering the row whose name the creating
    check never captured), then the probe repo; `[tail] mir-leftover-sweep`
    (REDEPLOY15 friction (c)).
  - `registry` — each trial's repo under the fullName the server last
    returned (re-pointed by the rename); `[tail] reg-leftover-sweep`.
  - `forkpr-e2e` — fork, then base, then org;
    `[tail] forkpr-leftover-sweep`.
  - `ui-login` — its fixture repo; `[tail] ui-leftover-sweep`.
  - `window2-mounts` — its secret by name (the user API DELETE), then its
    org; `[tail] w2-leftover-sweep`.
  - `window3-mounts` — its two probe repos (content + empty);
    `[tail] w3-leftover-sweep`.
  - `fixwave-parity` — its repos, then the org, the member user (its PAT
    rows cascade), and the session row (the D1 delete);
    `[tail] fw-leftover-sweep`.
  One `[tail]` line logs every action; failures feed `left_behind`, never
  fatal; a green run no-ops silently (the battery's own cleanup arms already
  emptied everything, and the gone flags skip the rest). `p0` creates
  nothing — it only reads the standing fixture — so it has no tail by
  construction. The audit battery going green right after a red run is the
  proof.
- Scratch dirs live under `os.tmpdir()` and are removed per battery; the PAT
  file is the operator's to shred.

## Self-testing the failure shapes

- `--force-red <check-id>` forces the named check to record a fail WITHOUT
  running it (the deliberately-bogus step; deterministic, zero cost): the
  chain `[skip]`s the rest and the battery's failureTail sweeps what the run
  created so far. The intended knob for verifying the failure-cleanup tails
  locally — e.g. `generate-e2e --force-red gen-generated-contents` reds after
  both repos exist, and the `[tail] gen-leftover-sweep` line must list both
  deletes; `--force-red gen-template-push` reds after only the template
  exists. An id that matches no check warns on stderr at summary time (the
  forced fail counts in the summary and fails the exit code, as any red).
- The ported tails self-test the same way, one forced-red per battery:
  - `registry --force-red t2-rename-200` — trial 1 completes green, trial 2
    reds after its repo exists under the CREATE name (trial 3 never
    creates), and the `[tail] reg-leftover-sweep` line must list exactly that
    one delete; `--force-red t2-delete-204` reds after the rename instead, so
    the tail sweeps the RENAMED name.
  - `forkpr-e2e --force-red forkpr-fork-push` — reds after base + org + fork
    all exist; the `[tail] forkpr-leftover-sweep` line must list all three
    deletes in tail order (fork, base, org).
  - `ui-login --force-red ui-labels-cookie-owner` — reds after the fixture
    repo exists; the `[tail] ui-leftover-sweep` line must list its delete.
  - `window2-mounts --force-red w2-secret-gone` — reds after the secret row
    exists (create green, delete chain-skipped); the
    `[tail] w2-leftover-sweep` line must list the by-name secret delete.
    `--force-red w2-org-last-owner-flash` reds after the org exists; the tail
    must list the org delete. Forcing an arm before the first creation (e.g.
    `w2-login-303`) leaves nothing to sweep — the tail stays silent.
  The rehearsal convention: each forced-red run is followed by a
  `cleanup-audit` run, and the audit going green is the sweep's proof.
- The mirror battery can also be forced honestly through its real budget
  flag: `--mirror-settle-ms 1` times the sync-settle poll out mid-battery
  (after the repo + mirror row exist) — the original 5fdbc15 self-test
  convention.

## Deliberately not ported (yet)

- The push-mirror FULL e2e to a real external remote (REDEPLOY13's opening
  arm) — no external credentials in probe scope; the `mirror` battery carries
  the credential-free halves (the SSRF egress gate + the `.invalid`
  lifecycle) instead.
- The wrangler-tail attachments (registry/tombstone traces) — the toolkit is
  HTTP/git-only; attach a tail manually when adjudicating a red.

## Local self-test fixtures

The committed tree was verified with a full `all` run against `pnpm dev`
(local D1, migrations applied). Local scratch keeps: the `dpprobe` user
(bootstrap-admin, several local tokens — pass the real count via
`--expect-tokens` for local audits) and its private `p0-shallow` fixture
(tip `8582c5545ac5cbc4eafca46363dd5141c7ae87f9`). Production runs use
`p0probe` and the standing fixture pinned by `--fixture-oid` instead.
