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

- Batteries (17): `p0`, `registry`, `generate-e2e`, `forkpr-e2e`, `mirror`,
  `ui-login`, `window2-mounts`, `window3-mounts`, `fixwave-parity`,
  `branch-protection`, `demo`, `wiki-git`, `packages-registry`,
  `packages-distro`, `packages-protocols`, `packages-minor`, `cleanup-audit`,
  `all` (runs the 17 in that order, audit last). `all --dry-run` plans
  **199 probes** across them (the counts in the table below were read off
  that dry-run at this writing; `registry` scales with `--trials`).
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
  the HTTP batteries (the mirror row-settle arm and the packages-registry
  row sweep reuse `--d1-scope`); mint the
  PAT with `node scripts/bootstrap-admin.mjs <user>` on local D1, and pass the
  matching `--user`. A local self-test (the seven batteries committed at the
  time — `window2-mounts` landed after; the toolkit now carries 16) was run green
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
  the token count with `cleanup-audit` — the default expectation is the
  standing bootstrap SET, one token per standing user (admin + p0probe = 2
  since the probe user gained its own bootstrap 2026-10-28; pass
  `--expect-tokens <n>` when the standing set differs, e.g. local scratch
  users).

## Batteries and their canonical expectations

The registry at this writing — 17 batteries, **199 probes** (`all
--dry-run`; `registry`'s count scales with `--trials`, here at its
default 3):

| Battery | Probes | What it verifies | Auth & env |
|---|---|---|---|
| `p0` | 4 | the shallow trio (deepen-since/deepen-not exit 128 with the server text, depth-1 shape, fsck) + the privacy tail; the fixture self-seeds | HTTP — `--base-url` + `--token-file`; `--fixture-oid` pins a standing tip |
| `registry` | 21 | tombstone lifecycles: create → anonymous advert → rename → the carry → delete → t+0 dead on both paths | HTTP |
| `generate-e2e` | 10 | template → real push → PATCH template → generate → carried refs at the identical tip → contents round-trip | HTTP |
| `forkpr-e2e` | 8 | fork into a doer-owned org → cross-repo bare `owner:branch` PR → head chain + `mergeable` | HTTP |
| `mirror` | 8 | push-mirror registration-time SSRF egress gate + the `.invalid` sync-settle lifecycle | HTTP + **wrangler auth** (the row re-read rides `--d1-scope`) |
| `ui-login` | 5 | the login-cookie methodology: anonymous vs owner labels view | HTTP (login cookie) |
| `window2-mounts` | 22 | user-settings tab family: anon 303s, pageClass 200s, the secret round-trip, keys negative, last-owner flash | HTTP (login cookie) |
| `window3-mounts` | 26 | feed tails, wiki raw bytes, profile tabs, admin lists, settings account/notifications, milestone detail, content-history list | HTTP (login cookie) |
| `fixwave-parity` | 22 | the RD23 parity matrix: PR head-sync, merged-PR 412, ghost-404, tag-only push-create, revoke mask, visibility ladder, sudo pair, session-rotation directive | HTTP + **ADMIN PAT** + **wrangler auth** (the rotation backdate + session-row sweep are D1 writes) |
| `branch-protection` | 18 | SPEC-0013 flows: rule CRUD + priority swap, per-ref push rejection, approval gate 405→200, whitelist flag round-trip | HTTP + **ADMIN PAT** (the priority ids and slash-glob arm are pure API — no wrangler) |
| `demo` | 4 | demo posture: committed-config machinery, `DEMO_MODE`-off default, open signup, the §4.4 banner ([warn] pre-M2) | HTTP against the demo instance; the TTL-mechanics arm is LOCAL-only (`--d1-scope local` + `DEMO_MODE=true` in `.dev.vars` against `pnpm dev`) |
| `wiki-git` | 7 | the `.wiki.git` wire: REST page create → real clone carries the root commit → push → read-back → privacy tail → t+0 tombstone | HTTP |
| `packages-registry` | 11 | all SIX protocols end-to-end (generic/pypi/npm/helm/maven/nuget) + the D1 row sweep + repo delete | HTTP + **wrangler auth** (the row sweep rides `--d1-scope`) |
| `packages-distro` | 5 | the M7 distro tail: rpm (hand-built fixture → .repo configs + repomd.xml + primary.xml.gz + repository.key → delete → repodata gone) + arch (.PKGINFO package → packages.db tar + symlink-dance aliases + .sig → delete → index 404 empty) + the D1 husk sweep + repo delete | HTTP + **wrangler auth** (the husk row sweep rides `--d1-scope`) |
| `packages-protocols` | 9 | the SPEC-0016 §7 long tail: go (module zip → list/@latest/.info/.mod/.zip + sumdb 404 + missing-module 404s, + real `go mod download` when the toolchain is on the host) + cargo (.crate container → the {"ok"} shapes + config.json + sparse index + yank/unyank + download, + real `cargo fetch` through the in-script h2c-stripping proxy on plain-HTTP) + swift (login pair → multipart PUT → enumerate + Link → metadata + Digest zip → manifest 200/303 → identifiers) + rubygems (.gem → compact index → specs marshal → byte-parity download → gemspec.rz → yank) + the D1 husk sweep + repo delete | HTTP + **wrangler auth** (the husk row sweep rides `--d1-scope`); the two REAL-CLIENT arms degrade to a documented `[warn]` when `go`/`cargo` is off the probe host |
| `packages-minor` | 9 | the SPEC-0016 §7 minor six: chef (cookbook tar.gz → universe + search + cookbook/version metadata with the 1_0_1 knife quirk → download → protocol version delete) + composer (raw zip PUT ?version= → packages.json/list.json/p2 with the %2F dist url + sha1 → download → management delete) + conan (v2 recipe revision → revisions/latest + the pinned revision-files list {"conanfile.py":null} → pinned download → pinned v2 delete) + cran (DESCRIPTION tar.gz → PACKAGES(.gz) block with the EMPTY MD5sum → download → management delete) + pub (request-upload → multipart → finalize → the normalized enumerate → download → management delete) + vagrant (box PUT → HEAD probe → the provider array + sha512 → download → management delete) + the D1 husk sweep + repo delete | HTTP + **wrangler auth** (the husk row sweep rides `--d1-scope`) |
| `cleanup-audit` | 10 | post-run D1 count shapes (independent counts) | **D1-only** — wrangler auth, `--d1-scope remote\|local` (default remote); takes NEITHER `--base-url` NOR `--token-file` |
| **`all`** | **199** | every battery in registry order, audit last | union of the above |

Expectations are ported from `docs/design/p0-evidence.md` — the REDEPLOY13
block (2026-10-26, ~lines 1507-1697) for the shallow trio, generate, ui-login,
the cleanup shapes, and the push-mirror credential-free arms (~1600-1610);
the REDEPLOY12 tombstone t+0 proof (~1395-1417) and the
REDEPLOY10 registry re-probe (~991-1030) for the registry sweep. `--dry-run`
prints all of them verbatim.

- **p0** — the shallow trio against the user's private fixture
  (`<user>/p0-shallow`, default user `p0probe`): shallow-since and
  shallow-exclude clones exit 128 with the server text naming `'deepen-since'`
  / `'deepen-not'` (only depth-limited shallow fetches are supported);
  `--depth=1` exits 0 with `.git/shallow` == the HEAD tip, exactly 1 commit,
  `is-shallow-repository` true, fsck clean. Auth rides `http.extraHeader` on
  every clone (the evidence methodology). Tail: the fixture stays PRIVATE —
  anonymous API GET 404, anonymous `info/refs` 401 Basic challenge, anonymous
  web page 404. `--fixture-oid` pins the standing tip
  (`502abd2d5561536873088528a9f57f02cd1633e1` in production).
  **Self-fixture (no pre-seeded repo needed — the RD24 papercut closed):**
  before the checks the battery POSTs `/api/v1/user/repos`
  `{"name":"<fixture-repo>","private":true,"auto_init":true}` — the exact
  call the RD24 window made by hand. **201** self-seeds (the run logs one
  `[setup] p0-fixture` line; the create lands the registry entry + the
  auto-init commit synchronously, and an authenticated `info/refs` settle
  poll keeps the first check's clone off the fresh-cell race); **409**
  tolerates the standing fixture a prior run/window created. A self-seeded
  fixture that survives a GREEN run stays — it becomes the user's standing
  fixture (the next run 409s onto it, and `cleanup-audit --expect-owner-repos 1`
  holds). A RED run sweeps the fixture ONLY when this run created it
  (`[tail] p0-leftover-sweep`); a pre-existing fixture is NEVER deleted —
  earlier windows' users own theirs — and an inconclusive create answer
  (neither 201 nor 409) is never deleted either, since the run cannot prove
  it created it. A self-seeded fixture carries a fresh auto_init tip, so
  `--fixture-oid` applies only to the standing fixture (the depth-1 check
  pins the shape unless the oid is passed).
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
- **branch-protection** — the SPEC-0013 protection flows over one scratch
  auto_init repo (the gate-assessment gap 2 closure: the M1–M4 surface is
  deployed, so every redeploy verifies the FLOWS, not just the table's
  `protected_branches == 0` existence). All four arms ride ONE repo:
  **(a) rule CRUD** through `/repos/{owner}/{repo}/branch_protections` — a
  throwaway rule's POST 201 field-faithful echo (priority 1 = MAX+1 on the
  empty repo, the zero config), GET + the priority-sorted LIST, GET of a
  missing rule → the plain shared 404 (the exact-name lookup, no glob
  fall-through), PATCH `{required_approvals, block_on_outdated_branch}` → 200
  echoing both (absent = keep), DELETE 204 → GET 404 (404-after-delete) →
  list `[]`; then **the priority op** — a second rule, POST
  `/branch_protections/priority {"ids":[…]}` → 204, the list order/priorities
  follow the renumber; **(e) the slash-glob wildcard** — a GLOB rule
  `release/v*` (a name the single-segment `{name}` declaration cannot match)
  created → 201 with the addressable id, then GET/PATCH/DELETE address it
  through the LITERAL-slash path (the wildcard routes, upstream's chi
  `m.Group("/*")` + `ctx.PathParam("*")` runtime shape — api.go:1328-1332 +
  branch.go:556): 200 render (`branch_name` `""`, the same id) → 200 PATCH
  echo → 204 delete → 404 after, and the percent-encoded `%2F` form answers
  200 through the declared route. **(b) push-time per-ref rejection** — ONE
  real `git
  push` carrying TWO refs (a fast-forward to the protected main + a create of
  an unprotected sibling): the protected ref answers upstream's per-ref report
  rejection (git exit 1, `! [remote rejected] … (Not allowed to push to
  protected branch main)`; exit 128 would mean a door refusal instead) while
  the sibling LANDS, and ls-remote pins main at the pre-push tip. **(c) the
  merge approval gate** — a PR into the protected branch (`required_approvals:
  1`) merges → **405** with the verbatim ErrNotReadyToMerge text "Does not
  have enough approvals"; an ADMIN-minted second user (the fixwave member
  methodology: `POST /admin/users` → token mint over HTTP BASIC →
  `PUT …/collaborators {"permission":"write"}` → 204) submits an APPROVED
  review that lands `official:true` (write access is official without the
  approvals whitelist — protected_branch.go:264-289), and the SAME merge
  answers **200** (has-merged 204; main advanced past the pre-push tip).
  **(d) the whitelist/enforce-admins round-trip** — a GLOB rule `v*`
  (deprecated `branch_name` renders `""` per isRuleNameSpecial) carrying the
  enforceable flag set (push/force-push/deletion whitelists + merge whitelist
  + bypass allowlist + approvals whitelist, all `[<owner>]`; required_approvals
  2; block_on_outdated_branch, dismiss_stale_approvals,
  block_admin_merge_override; status-check contexts; protected-file patterns)
  → 201 + GET echoing EVERY field (the M4 sanitizer keeps the owner —
  write/any-access — in every list), then PATCH `{"enable_push":false}` shows
  the landed cascade: the push master flips its flags off and the re-conjunction
  clears the deletion pair (enable_deletion + its allowlist + the deletion
  array), while the stored id lists SURVIVE their disabled flags (upstream
  keeps WhitelistUserIDs on a flag-off edit; the render maps ids→names
  regardless — branch.go:894-936) and every absent arm keeps its stored value.
  **Auth: an ADMIN PAT** (`--user` must be the site admin — the member arm)
  only. The priority op is API-addressable now: the BranchProtection render
  exposes the real integer rule id (the cf-gitea addition that closed the
  recorded gap — upstream's `BranchProtection` struct has no id field, yet its
  priority op consumes exactly those row ids), so the probe reads the ids off
  the create echoes/list render and the old `wrangler d1 execute` lookup (and
  its `--d1-scope` coupling) is gone from this battery. **Failure cleanup (the
  consistency posture):** a finally-style
  tail deletes the created rules first (best-effort explicit deletes, so a
  failed repo delete still lands the audit back at `protected_branches == 0`),
  then the repo (its delete cascades the rest), then the member's token
  (HTTP BASIC) + the member user (logged on one `[tail] bp-leftover-sweep`
  line; failures feed `left_behind`, never fatal; a green run no-ops
  silently).
- **demo** — the SPEC-0014 demo-POSTURE battery (§7's named battery) against
  the deployed demo instance (`cf-gitea-demo.aiapp.run` — a default
  self-host deployment reds the signup arm BY DESIGN; it is not a
  self-host-posture battery). Four INDEPENDENT arms (the fixwave posture
  shape — one red never chain-skips the rest): **demo-config-posture** — the
  committed deploy configs (`wrangler.jsonc` + `wrangler.jsonc.example`, the
  source every deploy is cut from, parsed with a string-aware JSONC reader)
  carry the demo machinery: the hourly `0 * * * *` cron entry beside the
  standing 10-minute cadence (§3.1), the repo-tasks consumer's
  `dead_letter_queue: "repo-tasks-dlq"` + the `repo-tasks-dlq` consumer
  entry (M0, §3.0), and `DEMO_MODE` defaulting `"false"` in BOTH — the §2
  hard invariant's config arm (a default deployment never arms). The
  DEPLOYED instance's armed state has no further probe-able HTTP surface
  (queue-consumer registration and log lines are not API-reachable), so the
  deployed halves ride the banner arm here plus the ops-dashboard checks:
  the demo zone's `DEMO_MODE` var on the deploy page, and the hourly
  `[demo-sweep]` log line (Workers → Logs — one line per tick including
  0-eligible). **demo-banner-present** — anonymous `GET /` → 200 carrying
  the §4.4 demo banner: the `id="demo-banner"` notice with the
  "data on this instance is periodically cleaned" text, the
  `id="demo-banner-dismiss"` control, and the
  `cf-gitea-demo-banner-dismissed` sessionStorage dismissal script. **M2 IS
  IN FLIGHT** (the banner+quotas wave lands after M1): until it deploys, a
  miss is the documented `[warn]` degradation (the window2-mounts shape —
  pre-M2 the page legitimately renders no node); anything mounted asserts
  hard against the marker shape specified at this battery's writing, and a
  shape drift at the M2 landing review moves the asserts with it.
  **signup-open** — anonymous `GET /user/sign_up` → 200 carrying the
  registration form (`action="/user/sign_up"` + the `user_name` field): the
  `ALLOW_SIGNUP=true` demo posture (OQ-1's resolved convergence — one
  registration surface for self-host and demo alike; the demo enables the
  var). The route is LANDED (ui/first-run.ts), so the gate's 404-closed
  shape is a posture RED, not a mount-timing warn. **demo-ttl-mechanics** —
  the deep arm, LOCAL-ONLY: with `DEMO_MODE=true` in `.dev.vars` and
  `--d1-scope local` against `pnpm dev`, fabricate the M1 unit's recipe row
  (`POST /user/repos` an auto_init repo, then wrangler d1 `--local` backdates
  `created_at` 73 h past retention and NULLs `owner_id` — the fail-safe
  swept arm, §3.1 step 2, which also makes the verdict independent of the
  PAT owner's `is_admin`), tick the hourly cron through miniflare's
  `/cdn-cgi/local/scheduled?cron=…` trigger surface (forwarded by the vite
  dev server; a deployed worker has no such route), then poll (budget 45 s)
  until the fabricated row is GONE — the producer enqueued
  `{kind:"demo-sweep"}` and the consumer's delete cascade deleted it
  (row-deletion IS the sweep's claim, §3.1). On a DEPLOYED target the arm
  records an ops-note `[info]` and never writes D1 (fabricating rows on
  production is out of a probe's posture; logs are not API-reachable).
  **Failure cleanup (the consistency posture):** the TTL repo is the only
  server-side state any arm creates — a finally-style tail sweeps it D1
  first (the backdate NULLed the owner, so the API delete may not resolve),
  then the best-effort API DELETE (logged on one
  `[tail] demo-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently because the sweep itself already
  deleted the row).
- **wiki-git** — the v1.3 `*.wiki.git` WIRE round-trip over one PRIVATE
  probe repo (49a1502's battery; `99db2c1`'s git-HTTP twin is the server
  side): the wiki REST create (`POST /api/v1/repos/{owner}/{repo}/wiki/new`,
  `content_base64` — no session-cookie dance needed, the PAT carries it),
  then the wire driven like p0 drives the code wire: a REAL authenticated
  `git clone …/{owner}/{repo}.wiki.git` (auth via `http.extraHeader`)
  carries the page's root commit (Home.md bytes verbatim, exactly 1
  commit, the router-defaulted subject `Add "Home"`) → an append commit
  PUSHES back (wiki pushes are served with the parent's write grant) →
  the page API read-back carries the appended bytes → the privacy tail
  proves a PRIVATE parent's wiki twin challenges anonymous readers
  (`info/refs` 401 Basic + ls-remote 128) → DELETE 204 and an
  authenticated ls-remote asserts the tombstone: the wiki cell is dead
  at t+0 (it rode deleteRepository's purge — no wiki residue). Fixtures:
  ONE private auto_init probe repo — a green run deletes it (the wiki
  cell cascades with it), so cleanup-audit needs no new expectations.
  **Failure cleanup (the consistency posture):** a finally-style tail
  sweeps the probe repo under the fullName the create returned (logged
  on one `[tail] wikigit-leftover-sweep` line; failures feed
  `left_behind`, never fatal; a green run no-ops silently).
- **packages-registry** — the v1.3 `/api/packages` protocol families in
  ONE owner-scoped sweep (49a1502's battery, nuget joined at 07221df;
  one probe repo fixture + the run PAT): the generic PUT/GET round-trip
  (+ DELETE version → 204 → 404), the pypi twine multipart upload → the
  PEP 503 simple index (anchor + `#sha256=`) → the file back verbatim,
  the npm couchdb publish PUT (the tarball attachment + sha512
  integrity) → packument + dist-tags + version metadata + the tarball
  back verbatim → the whole-package unpublish (`-rev` → 200), the helm
  Chart.yaml tarball → `index.yaml` entries → the chart back verbatim,
  the maven pom+jar PUTs → the generated `maven-metadata.xml` → the jar
  back verbatim, and the nuget family — the V3 flat-container publish
  (a hand-built stored-entry `.nupkg` whose ROOT `.nuspec` carries the
  fifth-segment version `1.04.5.2.5-rc.1+probe`; every read answers the
  NORMALIZED `1.4.5.2-rc.1`) via the `X-NuGet-ApiKey` fallback → the
  registration leaf + the `.nupkg` back verbatim + the V2
  Edmx/`Packages(Id=..)` pair → the REST management purge (204 → 404s).
  Cleanup is SELF-CLEANING at the row layer: generic/npm/nuget self-clean
  via their protocol/management deletes, while pypi/helm/maven expose no
  protocol delete, so a wrangler d1 sweep (the fixwave/demo D1-arm
  precedent; `--d1-scope` picks the database — needs wrangler auth)
  deletes the probe's package/version/file/property/blob ROWS in
  deletePackageAndReferences' cascade order and asserts zero rows remain;
  the R2 content keys are documented residue (the unreferenced-blob sweep
  is the SOLE content-key deleter, >24 h cleanup cadence). The probe repo
  DELETEs 204 (packages are owner-scoped — the repo delete never touches
  them, which is exactly why the D1 sweep exists). **Failure cleanup (the
  consistency posture):** a finally-style tail sweeps the package rows
  (D1, unless the in-chain sweep already ran) then deletes the probe repo
  under the fullName the create returned (logged on one
  `[tail] pkg-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently).
- **packages-distro** — the M7 distro tail's two protocol families in ONE
  owner-scoped sweep (fbace73's recorded open item; one probe repo vehicle +
  the run PAT; both fixtures GENERATED INLINE — no rpmbuild/pacman on the
  probe host, the byte shapes are the landed suites' own hand-built builders).
  INDEPENDENT (the fixwave posture shape — one red family never hides the
  other; both families are OWNER-scoped, so the arms do not chain):
  **distro-rpm-roundtrip** — PUT a hand-built minimal rpm (`probe-rpm-<hex>`,
  the packages-rpm.test.ts builder shape: 96-byte lead + signature section
  with a REAL SHA-256 digest over the main header + the payload size + the
  alignment pad + the name/version/release/arch/summary tags) → 201; the
  group-less `/rpm.repo` AND the grouped `/rpm/el9.repo` render the exact
  `renderRpmRepositoryConfig` strings off the request origin (the
  `[gitea-<user>]` id, `name=<user> - Gitea`, the baseurl, gpgcheck 1, the
  group-less gpgkey href); `repodata/repomd.xml` carries the three data
  entries (primary/filelists/other, no updateinfo without errata);
  `primary.xml.gz` decompresses to the parsed tags (name/noarch, the
  `epoch="0" ver= rel=` version, the summary); the GROUP-LESS
  `/rpm/repository.key` answers the armored public key
  (`application/pgp-keys` + the repository.key disposition) while the
  group-qualified path 404s (upstream registers the key group-less only);
  DELETE the package → 204 → the emptied group's repomd.xml is GONE at t+0.
  **distro-arch-roundtrip** — PUT a minimal pacman package
  (`probe-arch-<hex>`, `.PKGINFO` + two file members over the shared
  ustar+gzip substrate) → 201; `packages.db` decompresses to ONE gzip
  member's ustar with exactly the `{name}-{version}/files` + `/desc` pair
  (files FIRST, Mode 0o777 — os.ModePerm) whose `%FIELD%` documents carry
  FILENAME/SHA256SUM/PGPSIG/CSIZE(== the upload size)/ISIZE/NAME/BASE/ARCH/
  VERSION/DESC/LICENSE/PROVIDES/DEPENDS while MD5SUM and the empty fields are
  SKIPPED, and the files member lists the package's tar members; the
  symlink-dance normalization (arch.go:186-197 — the aliases ARE the dance,
  there is no literal symlink) serves the IDENTICAL stored bytes under
  `index.db.tar.gz` and `main.db`, and `packages.db.sig` answers non-empty;
  DELETE the version → 204 → the index 404s with the EMPTY body.
  Cleanup is SELF-CLEANING at the protocol layer PLUS one D1 sweep arm (the
  packages-registry precedent — wrangler auth, `--d1-scope`): the protocol
  deletes fold the version + files (upstream's exact DeletePackageFile fold —
  routers/api/packages/rpm/rpm.go:299-302 deletes the VERSION and its
  references; the PACKAGE row itself stays, upstream's own cleanup sweep owns
  orphaned packages too), so the empty package HUSKS the arms leave sweep
  via D1 with the zero-rows assert (`distro-cleanup-rows-d1`,
  deletePackageAndReferences' cascade order scoped to the run's probe names);
  the internal `_rpm`/`_arch` rows + the owner keypair are STANDING
  per-owner infrastructure (the getOrCreate posture — every later run reuses
  them, the p0 standing-fixture precedent) the sweep never touches, and
  unreferenced blob content rides the >24 h cleanup queue as documented
  residue, so cleanup-audit needs no new expectations. **Failure cleanup
  (the consistency posture):** a finally-style tail best-effort
  protocol-DELETEs exactly what the arms uploaded and have not already
  deleted (gone-flagged), then sweeps the package rows (D1, unless the
  in-chain sweep already ran), then deletes the probe repo under the
  fullName the create returned (logged on one
  `[tail] distro-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently).
- **packages-protocols** — the SPEC-0016 §7 protocol long tail's FOUR
  families in ONE owner-scoped sweep (one probe repo vehicle + the run PAT;
  every fixture GENERATED INLINE — the landed suites' hand-built builders, no
  registry tooling required on the probe host). INDEPENDENT (the distro
  posture — one red family never hides the others; every arm self-contains
  its family):
  **proto-go-roundtrip** — PUT `/go/upload` a hand-built module zip (the
  go.dev/ref/mod layout: `{module}@{version}/`-prefixed entries + the root
  go.mod, stored-entry zip) → 201; `@v/list` answers 200
  `text/plain;charset=utf-8` with `v1.0.0\n`; `@latest` and `.info` answer the
  exact `{"Version","Time"}` JSON (RFC3339 Z); `.mod` the stored go.mod text
  verbatim; `.zip` byte parity (octet-stream — NOT sniffed — with the
  `{version}.zip` disposition); the sumdb `/supported` probe answers
  http.NotFound's exact 404 page; the missing-module contract: an unknown
  module's `@v/list` 404s with the EMPTY body, an unknown version's `.info`
  404s "package does not exist"; the management version delete → 204 and the
  read 404s after. **proto-go-client-download** — a REAL
  `GOPROXY=… GONOPROXY=none GONOSUMDB='*' GOFLAGS=-mod=mod go mod download
  <module>@v1.0.0` against a second uploaded module (SPEC-0016's as-built
  client posture: GOPRIVATE would bypass the proxy; GONOSUMDB rides the
  /supported 404) → exit 0 with the module cache holding
  `v1.0.0.info/.mod/.zip` whose contents answer the upload; the dot-bearing
  single-segment module name keeps the management `{name}` param
  one-segment-clean. **proto-cargo-roundtrip** — PUT `api/v1/crates/new` a
  hand-built `.crate` container (uint32-LE metadata length | metadata JSON |
  uint32-LE content length | the .crate bytes; the content a properly-rooted
  `{name}-{version}/` tar+gzip crate — cargo's unpack gate) → `{"ok":true}`;
  the duplicate re-publish is the `{"ok":false}` error shape (409 "package
  version already exists"); `config.json` answers the exact
  `{dl, api, auth-required:false}` document off the request origin; the
  sparse index (`{2}/{2}/{name}`, BuildPackagePath's ≥4-char shard) renders
  the ONE `IndexVersionEntry` NDJSON line whose `cksum` == the stored sha256;
  yank/unyank flip the line's `yanked`; the download rides byte parity under
  the same checksum; management delete → 204 → the zero-version nil-index
  404. **proto-cargo-client-fetch** — a REAL `cargo fetch` in a consumer
  crate (a `{version, registry = "probe"}` dependency against a
  `sparse+…` index) → exit 0 with the fetched cache crate's sha256 == the
  published payload (cargo's cksum gate). On plain-HTTP targets the client
  rides an IN-SCRIPT header-stripping proxy: cargo 1.94 offers
  `Upgrade: h2c`/`HTTP2-Settings` and the miniflare-beta dev dispatch dies on
  them (SPEC-0016's disclosed shim posture — the proxy also rewrites
  config.json's `dl`/`api` onto the proxy origin so the dl download rides it
  too); `https://` targets go direct. **proto-swift-roundtrip** — the login
  pair (any valid credential → the BARE 200 with NO Content-Version;
  anonymous → the 401 Problem document + Content-Version: 1); PUT
  `{scope}/{name}/{version}` (multipart: the source-archive FILE part — a
  zip whose root Package.swift is the shallowest manifest — plus the
  schema.org metadata VALUE part whose `repositoryURLs` become the
  `swift.repository_url` properties) → 201 EMPTY + Content-Version: 1; the
  enumerate answers `{"releases":{"1.0.0":{"url":…}}}` + the
  `Link rel="latest-version"` header (the `.json` twin byte-identical); the
  metadata document carries id = `scope.name` + `resources[0].checksum` ==
  the archive sha256; the `.zip` download carries `Digest: sha256=<hash>`
  byte parity; the manifest answers 200 `text/x-swift` and 303 SeeOther on
  the version-keyed miss (`?swift-version=5.6` with no
  `Package@swift-5.6.swift` — the bare RAW Location); the identifiers
  lookup answers the package id for the uploaded repository URL; management
  delete → 204 → enumerate 404. **proto-rubygems-roundtrip** — POST
  `api/v1/gems` a hand-built `.gem` (tar{data.tar.gz, metadata.gz,
  checksums.yaml.gz} over the gzipped YAML gemspec — the upstream
  integration test's makeRubyGem shape) → 201 EMPTY; the compact index
  (`info/{name}`) renders the `---\n` + the version line with the runtime
  requirement, the stored checksum, and the ruby/rubygems requirement
  tails; `specs.4.8.gz` decompresses to a marshal payload carrying the name
  + version; the `.gem` download is byte parity; the
  `quick/Marshal.4.8/{name}-{version}.gemspec.rz` inflate names the gem;
  the protocol YANK (`DELETE api/v1/gems/yank`, multipart gem_name/version)
  → 200 — upstream's DeletePackage fold, the version row GOES — and the
  compact index 404s after. Cleanup is self-cleaning at the version layer
  PLUS one D1 husk sweep arm (`proto-cleanup-rows-d1`, the
  packages-registry/distro precedent — wrangler auth, `--d1-scope`): the
  go/cargo/swift protocol groups carry NO delete route, so those version
  deletes ride the management API and fold version + files upstream-parity
  (rubygems' yank IS its protocol delete), so the empty package HUSKS sweep
  via D1 with the zero-rows assert; the distro-internal rows
  (`_rpm`/`_arch`/`_debian`/`_alpine` + the owner keypairs) are STANDING
  per-owner infrastructure the sweep never touches, and unreferenced blob
  content rides the >24 h cleanup queue as documented residue. The probe
  repo DELETEs 204 (`proto-cleanup-repo-204`). The two REAL-CLIENT arms
  degrade to a documented `[warn]` when `go`/`cargo` is off the probe host
  (the curl-shape arms still carry the protocol). **Failure cleanup (the
  consistency posture):** a finally-style tail best-effort
  management-deletes exactly what the arms uploaded and have not already
  deleted (the per-family gone flags), then sweeps the package rows (D1,
  unless the in-chain sweep already ran), then deletes the probe repo under
  the fullName the create returned (logged on one
  `[tail] proto-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently).
- **packages-minor** — the SPEC-0016 §7 minor six protocol families in ONE
  owner-scoped sweep (the 28a40b5 wave; one probe repo vehicle + the run PAT;
  every fixture GENERATED INLINE — the landed suites' hand-built builders, no
  registry tooling on the probe host). INDEPENDENT (the protocols posture —
  one red family never hides the others; every arm self-contains its family):
  **pminor-chef-roundtrip** — POST `/chef/api/v1/cookbooks` the multipart
  `tarball` part (a gzip'd tar whose `{cookbook}/metadata.json` member
  carries EXACTLY one "/") → 201 `{}`; `/universe` carries the row
  (`location_type` "opscode", the location_path/download_url pair, the
  dependencies map); `/search?q=` the start/total/items item; the cookbook
  metadata (`category` "" + `deprecated` false + the versions url array); the
  version metadata read through the **1_0_1 knife quirk** (the version
  segment's "_" reads as "."); the download byte parity; the PROTOCOL version
  delete → 200 and the `{"error_messages":[""]}` 404 after.
  **pminor-composer-roundtrip** — PUT `/composer?version=1.0.3` the raw zip
  (the composer.json carries NO version — the query-param fallback) → 201
  EMPTY; `packages.json` answers the exact three-template service index off
  the request origin; `list.json` carries the name; the p2 metadata document
  (`minified` "composer/2.0", the entry's `type` "library" default, the dist
  url with the **%2F-encoded name path** and the stored **sha1 shasum**, the
  empty source triple — no linked repo); the dist download rides the %2F path
  byte parity; the management delete → 204 and the p2
  `{"errors":[{status,message}]}` 404 after. **pminor-conan-roundtrip** —
  PUT `/conan/v2/conans/{name}/{version}/{user}/{channel}/revisions/rev1/
  files/conanfile.py` (the six-field conanfile) → 201; the v2 revisions list
  (the json.Encoder newline, the created-DESC aggregate), the latest probe;
  the pinned revision-files list answering
  `{"files":{"conanfile.py":null}}` (the WebCrypto md5 reduction); the
  pinned-revision
  download byte parity; the v2 PINNED revision DELETE → 200 and the
  revisions 404 `{"message":""}` after. **pminor-cran-roundtrip** — PUT
  `/cran/src` the tar.gz (`{pkg}/DESCRIPTION` shallow member with
  continuation lines) → 201; `PACKAGES` carries the exact field block
  (Package/Version/License/Depends/Imports joined from the continuations/
  NeedsCompilation ALWAYS/`MD5sum: ` rendering the **EMPTY value**); the
  `PACKAGES.gz` twin decompresses to the same block
  (application/x-gzip); the `{Package}_{Version}.tar.gz` download byte
  parity (the Archive/{package}/{filename} path shares the handler); the
  management delete → 204 and the EMPTY-body plain-text 404 after.
  **pminor-pub-roundtrip** — the repository-spec-v2 publish dance: GET
  `versions/new` → `{"url": …, "fields":{}}`; POST the multipart `file` part
  (a tar.gz whose pubspec.yaml carries the **"v"-prefixed** version) → 204
  EMPTY + the Location finalize header; GET finalize →
  `{"success":{"message":""}}`; the enumerate answers the **NORMALIZED**
  "1.2.3" everywhere (v.String()) with the pubspec pass-through carrying the
  RAW "v1.2.3" and the archive_url; the archive download byte parity; the
  management delete → 204 and the `{"error":{code,message}}` 404 after.
  **pminor-vagrant-roundtrip** — PUT `/{box}/1.0.0/probe.box` (a gzip'd tar
  whose info.json carries the description) → 201; the HEAD box probe → 200;
  the enumerate carries the **provider array** (`name` "probe" — the file
  property, original case minus .box — the url, `checksum` == the stored
  **sha512**, `checksum_type` "sha512") and the newest version's
  description; the download byte parity; the management delete → 204 and the
  `{"errors":[""]}` 404 after. Cleanup is self-cleaning at the version layer
  PLUS one D1 husk sweep arm (`pminor-cleanup-rows-d1`, the
  packages-protocols precedent — wrangler auth, `--d1-scope`): chef's
  protocol version delete and conan's pinned-revision delete ARE their
  protocol deletes, the other four ride the management API (fold version +
  files upstream-parity), so the empty package HUSKS sweep via D1 with the
  zero-rows assert; the distro-internal rows + owner keypairs stay standing
  and unreferenced blob content rides the >24 h cleanup queue as documented
  residue. The probe repo DELETEs 204 (`pminor-cleanup-repo-204`). **Failure
  cleanup (the consistency posture):** a finally-style tail best-effort
  management-deletes exactly what the arms uploaded and have not already
  deleted (the per-family gone flags), then sweeps the package rows (D1,
  unless the in-chain sweep already ran), then deletes the probe repo under
  the fullName the create returned (logged on one
  `[tail] pmin-leftover-sweep` line; failures feed `left_behind`, never
  fatal; a green run no-ops silently).
- **cleanup-audit** — one wrangler d1 execute (`--d1-scope remote|local`,
  default remote) runs the whole count shape; **D1-only, so it runs without
  `--base-url`/`--token-file`**; the checks are INDEPENDENT (one red count
  never hides the rest): probe-user repositories == 1 (the standing
  `p0-shallow`, `--expect-owner-repos`), `status='creating'` == 0, `action`
  == 0 (the 389da18 delete sweep — NO hand-sweep), `stars` == 0,
  `push_mirrors` == 0, `protected_branches` == 0, `repo_redirects` == 0,
  `user_blocking` == 0, `personal_access_tokens` == the standing bootstrap
  SET, one per standing user (admin + p0probe = 2 by default since the
  probe user gained its own bootstrap 2026-10-28 — the historical
  whole-table=1 encoding predated the second standing user and false-fired
  from 2026-10-29; `--expect-tokens <n>` overrides). The one honest
  exception to `action == 0`: a push
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
  - `p0` — its SELF-SEEDED fixture only, and only when the run failed;
    `[tail] p0-leftover-sweep`. A pre-existing fixture (the 409 reuse) is
    never touched, and a green run keeps its seed on purpose (it becomes the
    user's standing fixture — the next run 409s onto it).
  - `window2-mounts` — its secret by name (the user API DELETE), then its
    org; `[tail] w2-leftover-sweep`.
  - `window3-mounts` — its two probe repos (content + empty);
    `[tail] w3-leftover-sweep`.
  - `fixwave-parity` — its repos, then the org, the member user (its PAT
    rows cascade), and the session row (the D1 delete);
    `[tail] fw-leftover-sweep`.
  - `branch-protection` — its created rules (best-effort explicit deletes
    first, so a failed repo delete still lands the audit back at
    `protected_branches == 0`), then the repo (its delete cascades the rest),
    then the member's token + the member user;
    `[tail] bp-leftover-sweep`.
  - `demo` — its fabricated TTL repo (D1 `--local` delete first — the
    backdate NULLed the owner so the API delete may not resolve — then the
    best-effort API DELETE); `[tail] demo-leftover-sweep`. (Green runs
    arrive with the row already deleted by the sweep itself.)
  - `wiki-git` — its probe repo (the wiki cell cascades with it);
    `[tail] wikigit-leftover-sweep`.
  - `packages-registry` — its package rows (D1, unless the in-chain
    sweep already ran), then its probe repo;
    `[tail] pkg-leftover-sweep`.
  - `packages-distro` — its uploaded rpm package file, then its arch
    version (both best-effort protocol deletes, gone-flagged — a forced-red
    arm never uploaded anything, so nothing to sweep there), then its
    package rows (D1 — the protocol deletes leave the empty package husks),
    then its probe repo; `[tail] distro-leftover-sweep`.
  - `packages-protocols` — its uploaded go module versions (both), its
    cargo crates (both), its swift version, and its rubygems version (all
    best-effort management deletes, gone-flagged — the rubygems yank counts
    as its own delete — and a forced-red arm never uploaded anything, so
    nothing to sweep there), then its package rows (D1 — the version
    deletes leave the empty package husks), then its probe repo;
    `[tail] proto-leftover-sweep`.
  - `packages-minor` — its uploaded chef cookbook version, composer
    package version, conan recipe version, cran source version, pub
    package version, and vagrant box version (all best-effort management
    deletes, gone-flagged — chef's protocol delete and conan's pinned v2
    delete count as their own deletes, and a forced-red arm never uploaded
    anything, so nothing to sweep there), then its package rows (D1 — the
    version deletes leave the empty package husks), then its probe repo;
    `[tail] pmin-leftover-sweep`.
  One `[tail]` line logs every action; failures feed `left_behind`, never
  fatal; a green run no-ops silently (the battery's own cleanup arms already
  emptied everything, and the gone flags skip the rest). The audit battery
  going green right after a red run is the proof.
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
  - `branch-protection --force-red bp-merge-blocked-405` — reds after the
    repo + the two rules (main + the priority rule) + the PR exist (the
    member arm has not run); the `[tail] bp-leftover-sweep` line must list
    both rule deletes then the repo delete.
    `--force-red bp-approval-official-200` reds after the member + its token
    + the collaborator row exist; the tail must list the rule deletes, the
    repo delete, the token revoke (HTTP BASIC), and the member-user delete.
    Forcing an arm before the first creation (e.g. `bp-repo-create-201`)
    leaves nothing to sweep — the tail stays silent.
  - `ui-login --force-red ui-labels-cookie-owner` — reds after the fixture
    repo exists; the `[tail] ui-leftover-sweep` line must list its delete.
  - `p0 --force-red p0-shallow-since` — the setup self-seeds (or 409s onto
    the standing fixture), the first check reds UNRUN, the rest chain-skip:
    the `[tail] p0-leftover-sweep` line appears ONLY when THIS run created
    the fixture; against a pre-existing fixture the tail stays silent — the
    never-delete guarantee, exercisable under a red too.
  - `window2-mounts --force-red w2-secret-gone` — reds after the secret row
    exists (create green, delete chain-skipped); the
    `[tail] w2-leftover-sweep` line must list the by-name secret delete.
    `--force-red w2-org-last-owner-flash` reds after the org exists; the tail
    must list the org delete. Forcing an arm before the first creation (e.g.
    `w2-login-303`) leaves nothing to sweep — the tail stays silent.
  - `demo` — the TTL arm is ATOMIC (fabricate → tick → poll inside one
    check), so `demo --force-red demo-ttl-mechanics` forces the red WITHOUT
    running any of it: nothing is created and the
    `[tail] demo-leftover-sweep` line legitimately stays silent (the
    documented no-op shape for this battery).
  - `wiki-git --force-red wikigit-clone-root-commit` — reds after the
    probe repo + the wiki page exist (the clone UNRUN); the
    `[tail] wikigit-leftover-sweep` line must list the repo delete.
    `--force-red wikigit-push-append` reds after the clone greened, same
    single-delete tail. Forcing an arm before the create (e.g.
    `wikigit-create-repo-201`) leaves nothing to sweep — the tail stays
    silent.
  - `packages-registry --force-red pkg-npm-publish-packument` — reds
    after the repo + the generic and pypi rows exist (the npm arm itself
    UNRUN; all six probe names are registered at step-list construction,
    so the tail's D1 sweep covers them and the unpublished ones answer
    "already clean"); the `[tail] pkg-leftover-sweep` line must list the
    D1 row sweep + the repo delete. `--force-red pkg-cleanup-repo-204`
    reds after every protocol arm greened and the in-chain row sweep
    already ran — the tail then carries only the repo delete (the
    `rowsSwept` gone-flag skipping the row sweep, the documented shape).
  - `packages-distro --force-red distro-rpm-roundtrip` — the INDEPENDENT
    posture, not the chain: the forced arm reds UNRUN while the OTHER
    steps still run green (create, the arch arm, the husk row sweep — which
    removes the arch arm's empty package husk — and the repo cleanup); the
    `[tail] distro-leftover-sweep` line legitimately stays silent (the rpm
    fixture was never uploaded and everything that WAS created already
    swept itself in-chain; a mid-arm red after the real PUT is what the
    tail's gone-flagged protocol deletes + row sweep cover, and that shape
    is not deterministically forceable).
  - `packages-protocols --force-red proto-go-roundtrip` — the same
    INDEPENDENT posture: the forced arm reds UNRUN while the other steps
    still run green (the create, the go client arm — which uploads its OWN
    module, fetches it with the real client, and deletes it — the cargo
    roundtrip + client arms, the swift arm, the rubygems arm, the husk row
    sweep — which answers "already clean" for the never-uploaded go
    fixture among the registered names — and the repo cleanup); the
    `[tail] proto-leftover-sweep` line legitimately stays silent (nothing
    the run created survived; a mid-arm red after a real PUT is what the
    tail's gone-flagged management deletes + row sweep cover, and that
    shape is not deterministically forceable). The REAL-CLIENT arms need
    the toolchains: on a host without `go`/`cargo` the rehearsal still
    exercises the tail (the arms report the documented `[warn]`, which
    never fails the battery — force a fixture-creating arm like
    `proto-swift-roundtrip` instead to see the forced-red shape on such a
    host).
  - `packages-minor --force-red pminor-chef-roundtrip` — the same
    INDEPENDENT posture: the forced arm reds UNRUN while the other steps
    still run green (the create, the composer/conan/cran/pub/vagrant arms —
    each self-deleting — the husk row sweep — which answers "already clean"
    for the never-uploaded chef fixture among the registered names — and the
    repo cleanup); the `[tail] pmin-leftover-sweep` line legitimately stays
    silent (nothing the run created survived; a mid-arm red after a real PUT
    is what the tail's gone-flagged management deletes + row sweep cover,
    and that shape is not deterministically forceable).
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
(local D1, migrations applied) — the battery set at that verification;
the v1.3 pair landed later and 49a1502's landing window ran its own
local green suite battery-by-battery. Local scratch keeps: the `dpprobe` user
(bootstrap-admin, several local tokens — pass the real count via
`--expect-tokens` for local audits) and its private `p0-shallow` fixture
(tip re-seeded 2026-10-31 by the packages-protocols battery's husk sweep —
the pre-067449a-era husk died, the self-seed rebuilt it; the tip drifts with
re-seeds, never pin local). Production runs use
`p0probe` and the standing fixture pinned by `--fixture-oid` instead. A
fresh scratch user needs NO pre-seeding anymore — the p0 battery
self-seeds its fixture on first contact and keeps it on green (the next
run reuses it via the 409 path).
