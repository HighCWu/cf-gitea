# Pull-mirror e2e suite (SPEC-0009 §5 black-box layer)

Real git clients against a running dev Worker — the black-box layer of
SPEC-0009 §5's testing plan (milestone M4's e2e item). The **source** side is a
real smart-HTTP endpoint (`apps/worker/test/fixtures/git-http-server.mjs`,
CI-only, shelling `git upload-pack --stateless-rpc [--advertise-refs]` on
loopback — the engine e2e's real-git discipline, SPEC-0001 §6); the **target**
side is the Worker's own git + API surface. Conventions follow
`scripts/lfs-e2e.sh`: real client traffic, hard assertions that exit non-zero,
per-check `ok:`/`FAIL:` lines, wrangler D1 `--local` introspection (the wrangler
CLI shares the dev server's `apps/worker/.wrangler/state/v3` state), full
cleanup on a green run.

## How to run

```bash
pnpm test:mirror                              # or: bash scripts/mirror-e2e.sh
bash scripts/mirror-e2e.sh http://127.0.0.1:5199   # explicit base URL
SHARED_TREE=1 bash scripts/mirror-e2e.sh      # old behavior: run on the live shared tree
DEV_START_ATTEMPTS=150 bash scripts/mirror-e2e.sh   # extend the dev-boot healthz budget (slow CI runners)
SETTLE_ATTEMPTS=180 bash scripts/mirror-e2e.sh      # extend the per-sync mirror settle budget
```

- Default target is `http://127.0.0.1:5199` — the suite starts its OWN dev
  server there and kills it on exit. It deliberately does NOT reuse an
  already-running dev server: it must start the Worker with `SSL_CERT_FILE`
  pointing at the fixture's throwaway CA (below), and only a server it owns
  can get that environment. A server already answering at `$BASE` is a hard
  error with instructions. **Since 2026-10-28 the server it starts runs from
  a disposable scratch checkout by default, not the live tree — see
  § scratch isolation below** (`SHARED_TREE=1` opts back into the old
  shared-tree behavior).
- The source fixture listens on `https://127.0.0.1:8443` (override with
  `SRC_PORT`; whatever it is, `MIRROR_ALLOWED_HOST_LIST` must cover it).
- Requirements: `git`, `curl`, `node`, `openssl` (the per-run TLS identity is
  generated, never committed), `pnpm`, and — for `SHARED_TREE=1` runs only —
  local migrations applied (`pnpm db:migrate:local`; a scratch-isolated run,
  the default, migrates its own fresh state, so the ROOT's migration state
  is irrelevant to it). `sqlite3`
  is optional but recommended: it powers the pre-server stale-cell-file sweep
  (§ run hygiene); without it the sweep is skipped with a note.
- The suite bootstraps its own fixtures under the fixed username `mirrore2e`
  (admin user + all-scopes PAT via `scripts/bootstrap-admin.mjs` on LOCAL D1)
  and deletes them again on a green run (`DELETE FROM users` cascades the
  PATs). A red run leaves everything in place for debugging; the next run's
  pre-clean wipes prior-run state with checked deletes and verifies the wipe
  before section 1 (see "Run hygiene" below). Global git config changes are
  sandboxed into the script's scratch `$HOME`.

## Scratch isolation: the dev server runs from a frozen worktree (default)

Mitigation for `docs/reviews/e2e-sweep-2026-10-28.md` open issue 4 (bitten
again by the RD24 window's LFS healthz race): suites that own a `pnpm dev`
server and run it on the SHARED tree are poisoned by sibling edits — an HMR
reload races the healthz polls and a mid-save PARSE_ERROR window reads as
product failure. Two of three sweep-day mirror runs died exactly there. So
when this suite starts its own dev server, it first materializes a disposable
**scratch checkout** — `git worktree add --detach` at a temp path, frozen at
HEAD — and runs the server from THERE. Sibling agents keep editing the shared
tree; the server's module graph never sees it (verified: a ROOT-tree `touch`
triggers zero HMR events, the same touch inside the scratch reloads).

Fast by design — no install happens (a per-run `pnpm install` would cost
minutes). The honest wall-time delta is ~0.2 s to materialize (worktree add
+ the node_modules copies) plus ~10-15 s for the fresh state's in-place
migration (miniflare boot + the 12 migrations apply once against an empty
D1) — paid once per run, against the shared-tree alternative's poisoning
risk during active waves:

- The workspace root's `node_modules` is re-created inside the scratch as a
  REAL directory of symlinks into the ROOT's store (pnpm 12 refuses to run
  scripts when the dir itself is a symlink, and wants
  `.pnpm-task-run-state-v1` real too), and the `apps/worker` +
  `packages/git-engine` `node_modules` trees are COPIED (~4 MB of symlinks
  and shim files) so pnpm's relative symlinks re-root into THIS tree —
  `@cf-gitea/git-engine` resolves to the scratch's frozen engine copy, not
  the live one. Materialization measures ~0.2 s wall.
- The scratch's `pnpm-workspace.yaml` gains one line,
  `verifyDepsBeforeRun: false` — pnpm 12 otherwise runs a hoist-install
  against the scratch store before every script.
- Gitignored dev files are COPIED in (a watching server must not see them
  change): `wrangler.jsonc`, `.dev.vars`, the generated
  `src/ui/icons.generated.ts`; `public/assets` is created empty (the suite
  pins API/git/healthz, not UI). Because a worktree does not check out the
  `gitea/` submodule, the server starts via
  `pnpm --filter cf-gitea-worker dev` (the root script's predev
  `gen:icons` would read the empty submodule); the generated icons file the
  worker imports comes from the copy above.
- `apps/worker/.wrangler` is a FRESH state, migrated in place inside the
  scratch (`wrangler d1 migrations apply cf-gitea --local`) — the shape a CI
  checkout gets, and deliberately NOT a link or copy of the ROOT's state:
  two workerd processes on one sqlite state poison each other with
  `database is locked: SQLITE_BUSY` (observed 2026-10-28: a sibling's live
  dev server held the ROOT state while a scratch server wrote it — the
  migrate call 500'd and cascaded into 33 failures), and copying sqlite
  files under a live writer risks torn copies. The suite sweeps and seeds
  its own namespace either way, so fresh state costs nothing but the
  migration; the concurrent-run interlock below keeps its lock on the
  PHYSICAL ROOT path, so interlocking is unchanged.

`SHARED_TREE=1` opts back into the old behavior (server on the live shared
tree) — deliberately unguarded: that mode exists FOR quick dirty-tree edit
loops, and the user accepted the poisoning risk by opting in. If scratch
materialization FAILS (worktree registration locked, disk full, ...), an
honest guard decides instead of silently poisoning: a **dirty** shared tree
(`git status --porcelain` non-empty) is REFUSED with a fatal naming the
recovery; a clean tree falls back to it with a note. The forced-failure demo
is one shim away:

```bash
mkdir -p /tmp/guard-demo-shim
cat > /tmp/guard-demo-shim/git <<'EOF'
#!/bin/bash
prev=""
for a in "$@"; do
  if [ "$prev" = "worktree" ] && [ "$a" = "add" ]; then
    echo "simulated: worktree add unavailable" >&2; exit 1
  fi
  prev="$a"
done
exec /usr/bin/git "$@"
EOF
chmod +x /tmp/guard-demo-shim/git
PATH=/tmp/guard-demo-shim:$PATH bash scripts/mirror-e2e.sh   # on a dirty tree: FATAL
```

The suite's own server binds `127.0.0.1` explicitly (`--host 127.0.0.1`):
GitHub runner-images alias `localhost`→`::1`, which makes vite bind
IPv6-only while every healthz poll dials 127.0.0.1
(actions/runner-images#929 — the first CI run lost five dev-server jobs
to exactly this).

Worktree hygiene: the EXIT trap runs `git worktree remove --force` (with an
`rm -rf` fallback), so green and red runs leave no registration behind; a
SIGKILLed run's leftover registration is pruned by the next run's
`git worktree prune`. Dev-boot budgets are env-tunable for slow CI runners:
`DEV_START_ATTEMPTS` (healthz poll seconds, default 120) and, for the mirror
syncs, `SETTLE_ATTEMPTS` (per-sync settle seconds, default 120) — CI exports
them instead of patching the script. In CI (quiet checkout) the isolation is
harmless: the worktree freezes the same commit CI checked out.

## Run hygiene: interlock, checked deletes, stale-state guard

Three harness behaviors landed 2026-10-28 after the sweep
(`docs/reviews/e2e-sweep-2026-10-28.md`, open issues 2 and 4) demonstrated how
prior-run leftovers and interleaved runs read as PRODUCT failures: an orphaned
`mirrore2e/srcseed` cell carrying a stale DO head cascaded into a 17-failure
run, and two concurrent invocations interleaved on the shared namespace into a
41/44 storm. The suite now fails LOUDLY at startup instead.

### 1. Concurrent-run interlock

At startup the suite takes `apps/worker/.wrangler/state/mirror-e2e-run.lock`
(an atomic `mkdir`, holding the runner pid). A second concurrent invocation
fails immediately with "another mirror-e2e run is in flight" instead of
interleaving. A lock left by a SIGKILLed run is reclaimed automatically when
its holder pid is gone; if you ever need to force-clear while no run is
active: `rm -rf apps/worker/.wrangler/state/mirror-e2e-run.lock`.

### 2. Every setup/cleanup DELETE is checked

The sweep proved a failed cleanup was invisible (the old setup discarded both
the wrangler output and the engine DELETE responses — a `SQLITE_LOCKED` 500
dropped a cell wipe silently and cascaded into product-check failures). Now:

- Every pre-clean/cleanup D1 statement runs through `d1_checked`: wrangler's
  exit code and its `success` flag are asserted, and a failure aborts the run
  with the statement, the label naming the resource, and the driver error.
- Every pre-clean engine DELETE must answer `200` (a stale cell existed and
  was purged — logged) or `404` (nothing under that name); anything else —
  a locked-cell 500, a worker restarting mid-request (curl `000`), a bad
  token — aborts with the resource and code named.
- A `200` is trusted only after the git surface CONFIRMS absence: the suite
  polls `GET /mirrore2e/<repo>.git/info/refs?service=git-upload-pack` until
  it reads `404` (up to 10 s). The D1-missing advert answers through the
  registry-existence oracle, so a registry-known orphan cell serves refs
  (`200`) while clean state 404s — the exact stale-cell state that poisoned
  the 2026-10-28 runs cannot slip past this probe. The cleanup mirrors the
  same verified-purge poll before declaring a green run tidy.

### 3. Stale prior-run state: wiped and verified, not trusted

Design choice: **(b) verifiable wipe** rather than refuse-to-start. The suite
already owned a pre-clean phase, so refusing to start would have added a
manual step between every red run and its retry; wiping keeps green runs
self-sufficient while an UNVERIFIABLE wipe (purge dropped, cell locked,
server unhealthy) still aborts the run at startup — naming the resource and
pointing at the recovery below — instead of surfacing mid-run as failures in
product checks. At startup the suite counts and reports what it owns from
prior runs (`repositories`/`users` rows under `mirrore2e`, cells under its
four fixed repo names), wipes it with the checked deletes above, logs what it
wiped, and re-verifies absence before section 1.

Two wipes are involved, in order:

1. **Pre-server cell-file sweep.** A completed async cell purge leaves the
   cell's sqlite file behind as an empty husk, and a later engine DELETE of
   that name answers `HTTP 500 — database table is locked: SQLITE_LOCKED` on
   it, deterministically, across dev-server restarts (reproduced 2026-10-28
   on a quiet fresh server; product-side open issue — see "Known red"). The
   file level is the only reliable wipe, so — before its dev server starts,
   while nothing holds the files open — the suite removes ONLY the cell
   files whose embedded DO name (`__miniflare_do_name`) is under
   `mirrore2e/`, logging each removal. Other suites' cells (`demo/*`,
   `lfse2e/*`, `dpprobe/*`) are never touched. Requires `sqlite3` (preflight
   of the repo's local D1 already implies dev tooling; GitHub's
   ubuntu-latest ships it); without it the sweep is skipped with a note and
   the checked DELETEs still abort loudly on an unwipeable cell.
2. **The checked engine DELETEs + verified absence** (behavior 2 above) for
   everything reachable through the API/git surface — D1-resolvable rows,
   registry-known orphans, cells whose purge raced.

### Stale-state recovery (manual one-liner)

With `sqlite3` present the pre-server sweep makes back-to-back runs
self-sufficient — no manual step. The manual path remains for environments
without sqlite3, or when a cell file cannot be removed because a foreign
process holds it open (the suite aborts naming the file):

```bash
# no dev server may be running (the suite stops its own on exit);
# check ports 5199/8443 are free first
rm -rf apps/worker/.wrangler/state/v3/do/cf-gitea-RepoCell
```

This removes every local repo's DO cell files — dev scratch only (D1 rows and
R2 packs live elsewhere, and each suite's setup re-creates its own fixtures
under a swept namespace, so nothing else needs those cells). Then re-run
`pnpm test:mirror`: the pre-clean re-verifies the slate. If the cell files
are held open by a still-running dev server, stop it first — removing files
under a live server is what produced the locked cells in the first place.

## Dev environment contract (why the extra config)

The egress gate (SPEC-0009 §4.1) admits the loopback fixture only through an
explicit **IP-form allow entry**, and source credentials are stored under a KEK
(§4.2). Both reach the Worker as env from `apps/worker/.dev.vars`:

```
GIT_TOKEN=devtoken                                  # (already in the example)
MIRROR_ALLOWED_HOST_LIST=127.0.0.1:8443             # explicit IP entry: host:port
MIRROR_CREDENTIAL_KEY=<base64 of 32 random bytes>   # openssl rand -base64 32
```

**These keys are inert unless the names are declared in
`apps/worker/wrangler.jsonc`.** Wrangler semantics (verified empirically on
wrangler 4.152 + @cloudflare/vite-plugin 1.65, both dev and preview): when the
Worker config declares a `secrets` block, ONLY declared names are loaded from
`.dev.vars` — undeclared keys never reach the Worker env (`GIT_TOKEN` is
already declared under `secrets.required`, which is why it works today). So
`wrangler.jsonc` must gain:

```jsonc
"secrets": {
  "required": ["GIT_TOKEN", "MIRROR_ALLOWED_HOST_LIST", "MIRROR_CREDENTIAL_KEY"]
}
```

(The values themselves stay dev-local in `.dev.vars`; declaring the names does
not put anything secret in the committed config. `MIRROR_EGRESS_MODE` is
optional — absent means the lax default.)

The suite preflights all three: `.dev.vars` keys present, names declared in
`wrangler.jsonc`, the allow entry covering the fixture address, and migration
0010 applied — each with a copy-paste fix in the failure message.

**TLS trust**: the egress gate is https-only (§1's documented divergence from
upstream), so the fixture serves TLS with a throwaway CA + leaf generated per
run. workerd verifies outbound TLS and honors `SSL_CERT_FILE` /
`SSL_CERT_DIR` (rustls native-certs) as its trust anchor — the suite starts the
dev server with `SSL_CERT_FILE=<scratch>/tls/ca.pem`, which is why it must own
the server process. The fixture's leaf carries `SAN IP:127.0.0.1`, CA:FALSE,
serverAuth; the CA is never written anywhere but the scratch dir.

## Scenario map (SPEC-0009 §5.2-5.7 → the landed surface)

SPEC-0009 §5.2/§5.3 describe upstream's `POST /repos/migrate` (creates the
target); the landed surface is the **into-empty** shape (`POST
/repos/{owner}/{repo}/migrate`, routes/mirror.ts — upstream's create-target
form has no repo-scoped path key outside the frozen SPEC-0004 inventory). The
suite therefore creates the target via `POST /api/v1/user/repos` first; the
initial population rides the enqueued mirror-sync (a delta sync against an
empty repo fetches every advertised tip), so §5.2's migrate and §5.3's first
sync are one flow here. `enable_prune=false` is exercised via a direct D1 flip
until the PATCH mirror-settings surface lands (api/services/mirror.ts defers
it to PATCH).

1. Source repo via `git push` (PAT-authenticated → push-create, D1-backed,
   `status=ready`, `is_empty=false`); the fixture's bare repo is populated
   harness-side with the same refs (a local-path push — never a client scheme).
2. Empty target via the API → `POST migrate` with `mirror=true`, credentials
   in the structured fields, `mirror_interval: "0"` → `202` + sanitized
   `remote_address`, no secrets echoed; poll `GET mirror` until
   `last_sync_at` is set (also proves the dev server delivers
   `MIRROR_SYNC_QUEUE` messages to the consumer — the cron producer never
   fires in dev, and `interval=0` keeps scheduling off).
3. Ref-map equality (`ls-remote` on both sides), fresh clone, `git fsck
   --full`, `rev-list --all --count` equality vs the source.
4. is_empty posture: the first successful sync settles the population (the
   landed `settlePopulatedRepo`, services/mirror/sync.ts — the §2.6 step 4
   shape: `is_empty=false` + default branch, best-effort with self-heal). The
   suite pins the CONSISTENCY contract — the repo JSON's `empty` flag must
   agree with the D1 source of truth — so a regression of that settle surfaces
   here in black-box terms. (Historical note: the suite first ran against a
   tree where the settle was still a documented open item and pinned the
   honest empty=true posture; the settle wave landed mid-flight.)
5. Push to source (dev server + fixture) → `POST mirror-sync` (empty 200,
   upstream `AddPullMirrorToQueue` shape) → delta lands; re-clone + fsck.
6. Force-rewind the source branch (`reset --hard` + `push --force`) → the
   sync applies the rewritten tip; the abandoned commit is unreachable in a
   fresh clone (the `+` refspec semantics, §4.3.2).
7. Prune: upstream-deleted ref disappears with `enable_prune=true`; with the
   column flipped to 0 a deleted ref survives (§4.3.3).
8. v0 fallback: a second migrate against the fixture's `/v0` path (no
   `GIT_PROTOCOL` forwarded → the source speaks v0) — v0 advertisement parse,
   v0 want/have fetch, side-band-64k demux.
9. Read-only: authenticated receive-pack advert → `403 "mirror repository is
   read-only"` (§2.4 row 21); `git push` fails; anonymous reads on the private
   mirror still 401 first (ACL order); non-mirror `mirror-sync` → 400.
10. SSRF gate (§4.1): `http://` and userinfo URLs → `422 "The provided URL is
    invalid."`; a loopback port WITHOUT an allow entry and `*.internal` →
    `422 "You can not import from disallowed hosts."`; no mirror row survives.
11. Source death: fixture killed → next sync records a sanitized `last_error`
    (no credentials, sanitized URL), `sync_state=idle`, and the target still
    serves full clones (mirrors are snapshots, §4.3.4).

## Suggested CI job (not wired yet)

```yaml
  mirror-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate:local
      # .dev.vars (values are CI-local): GIT_TOKEN satisfies
      # wrangler.jsonc's secrets.required; the mirror keys + the wrangler.jsonc
      # declarations (see "Dev environment contract") are REQUIRED — the suite
      # preflights them and fails with the exact missing piece.
      - run: |
          cat > apps/worker/.dev.vars <<'EOF'
          GIT_TOKEN=ci-dev-token
          MIRROR_ALLOWED_HOST_LIST=127.0.0.1:8443
          MIRROR_CREDENTIAL_KEY=OR9xOOi4L+VpTHWpz3d9tCwNWGex2CVu5tSO3Q0vbKE=
          EOF
      # DEV_START_ATTEMPTS: GitHub's 2-core runners have shown the WORKER boot
      # exceed 120 s after vite is ready (first CI run lost five dev-server
      # jobs to it); 300 s matches the workflow's own outer wait budgets.
      - run: DEV_START_ATTEMPTS=300 bash scripts/mirror-e2e.sh
```

(ubuntu-latest ships git, curl, node, openssl; the fixture and dev server are
started and killed by the suite itself, so the job needs no wait-on step.
`openssl rand -base64 32` fresh per CI run is fine too — the value only needs
to be 32 base64 bytes for the AES-256-GCM KEK.)

## Known red

**None on the current tree** — the suite runs fully green against it (the
run-hygiene layer self-heals the environmental state below harness-side;
the isolation wave's full run — 94/0 on a dirty tree under scratch
isolation — also retired the historical section-7 prune red for good:
the mirror-HEAD adoption fix (`071f10b`) is what made those four checks
green, no harness change involved).
The two product gaps the suite found on its first run were both fixed since
(the suite is what surfaced them, so they are kept here for the record); the
third finding below was RESOLVED engine-side on 2026-10-28 (root cause
deeper than the husk shape — see the resolution note):

3. ~~**Engine DELETE 500s (`SQLITE_LOCKED`) on a purged cell's husk file**~~
   **RESOLVED 2026-10-28 (engine fix, `packages/git-engine/src/repo.ts` +
   `e2e/check-delete-husk.mjs`; NOTICE rows same date)** — the root cause
   turned out to be a pinned-dev-runtime defect, not husk-specific: on the
   pinned miniflare-beta/workerd, every `DROP TABLE` against a sqlite-DO
   database created by a PREVIOUS runtime session fails `SQLITE_LOCKED`
   forever (healthy cells merely escape by living and dying in one session).
   The fix makes a content-less cell's DELETE a no-op success — the truthful
   idempotent-delete semantic. The harness's pre-server cell-file sweep stays
   as harmless hygiene; the residual runtime defect (a CONTENT-bearing
   cell's first DELETE after a dev restart still 500s locally) is recorded
   in the NOTICE as an upstream-runtime issue, production behavior
   unverified. Original finding kept below for the record: after a
   successful engine DELETE + async purge completes, the cell's
   sqlite file remained as an empty husk, and EVERY later engine DELETE of
   that name answered `HTTP 500 — database table is locked: SQLITE_LOCKED`,
   deterministically and across dev-server restarts (reproduced 2026-10-28
   on a quiet fresh server for all four `mirrore2e` names). Before the
   run-hygiene hardening this 500 was invisible (the setup discarded the
   response) and cascaded into whole-run failure storms; now the pre-server
   cell-file sweep removes the husk harness-side. The product-side follow-ups
   named in `docs/reviews/e2e-sweep-2026-10-28.md` (open issue 2) — a wipe
   retry/backoff, a DLQ or tombstone-era reaper for dropped purge messages,
   husk cleanup — remain open.
   **Status 2026-10-28: an engine-side fix is in flight** — a sibling unit
   is fixing it in engine storage; nothing has landed at this writing (this
   note is bookkeeping, not a landing claim). Until it lands, the pre-server
   sweep + the checked-DELETE abort above keep runs green harness-side.

1. **v2 advertisement with the `# service=` preamble failed to parse** —
   `apps/worker/src/services/mirror/gitclient.ts` `parseInfoRefsAdvert` only
   recognized the v2 capability advert as the FIRST pkt-line. Real smart-HTTP
   servers (git http-backend and everything modeled on it — i.e. the fixture,
   and every forge a mirror would fetch from) write
   `# service=git-upload-pack` + flush BEFORE the `version 2` advert; the
   parser then fell into the v0 ref-line loop and threw
   `malformed oid in v0 advertisement: 2`, so every mirror sync against a real
   v2 source failed. Real git clients accept both shapes (the preamble is
   required output server-side; clients skip it), and the client's own unit
   fixtures fed v2 WITHOUT the preamble — which is why the unit layer stayed
   green. **Fixed in 2278fc6** (service-header flush consumed, then the v2
   capability-advert path re-detected; packfile section framing corrected
   alongside). Scenarios 2-8 cover the regression.
2. **The `.dev.vars` mirror keys were not declared in `wrangler.jsonc`** (see
   "Dev environment contract") — with `secrets` declared, wrangler loads ONLY
   declared names from `.dev.vars`, so migrate would 422 "You can not import
   from disallowed hosts." even with a correct `MIRROR_ALLOWED_HOST_LIST`.
   **Fixed in 2788d3c** (both names added to `secrets.required`); the suite
   preflights the declaration and fails with the exact instruction if it ever
   regresses.

## Scope limits

- The 500 MiB single-window budget assertion (§5.8) needs the T3
  instrumentation and is not part of this suite (the suite's payloads are
  e2e-scale; the fixture buffers request bodies by design).
- Webhook push events per synced ref delta (§5.3's webhook assertion, §2.7)
  are not asserted: the sync consumer does not drive the notify pipeline yet
  (sync.ts's documented landing wave) — there is nothing to observe.
- `MIRROR_CREDENTIAL_KEY`-absent, wrong-AAD and KEK-rotation paths are unit
  territory (api/mirror.test.ts covers the envelope roundtrip through the
  consumer's own decrypt); the e2e pins the HAPPY credential path end-to-end
  (the fixture requires Basic auth on every request, so every sync decrypts
  and sends the stored credentials).
- The cron producer (`enqueueDueMirrorSyncs`) is not exercised: dev fires no
  crons, and every sync here is driven explicitly (`mirror-sync` POST or the
  migrate enqueue). The producer's due-select/CAS discipline has its own
  worker-integration coverage.
