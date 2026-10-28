# git-lfs client e2e suite (SPEC-0006 §5)

Real `git-lfs` client operations against a running dev Worker — the black-box
layer of SPEC-0006 §5's testing plan (milestone M6). Conventions follow
`packages/git-engine/e2e/e2e.sh` (real client, hard assertions that exit
non-zero, per-check `ok:`/`FAIL:` lines, engine DELETE cleanup); this script is
the ONLY copy and lives at repo level because it spans the Worker app (D1/R2
introspection via wrangler) and the git-lfs client, not the vendored engine.

## How to run

```bash
pnpm test:lfs                       # or: bash scripts/lfs-e2e.sh
bash scripts/lfs-e2e.sh http://127.0.0.1:5173   # explicit base URL
```

- Default target is the local dev server (`pnpm dev`, workerd, bindings from
  `apps/worker/wrangler.jsonc`) at `http://127.0.0.1:5173` — the vite port the
  worker is served through (same convention as the git e2e, see
  `packages/git-engine/e2e/README.md`). When nothing answers at `$BASE/healthz`
  the script starts `pnpm dev` itself and kills it on exit.
- Requirements: `git-lfs` (>= 3), `git`, `curl`, `node`, `pnpm` (wrangler D1/R2
  `--local` introspection), and local migrations applied (`pnpm db:migrate:local`
  — the suite needs the `lfs_objects` table of migration 0005).
- All traffic runs in **relay mode** (SPEC-0006 §2.3): local dev has no R2 S3
  credentials, so `createLfsStore` answers the capability probe with `null` and
  batch hands out Worker-relayed hrefs. That is the day-one deployment shape;
  the presign mode has its own vitest coverage with a stubbed signer.
- The suite bootstraps its own fixtures under the fixed username `lfse2e`
  (admin user + all-scopes PAT via `scripts/bootstrap-admin.mjs` on LOCAL D1,
  plus a `write:issue`-scoped PAT minted with the same algorithm), and deletes
  them again on a green run (`DELETE FROM users` cascades the tokens). A red
  run leaves everything in place for debugging; the next run pre-cleans it.
- Global git/git-lfs config changes (`git lfs install`) are sandboxed into the
  script's scratch `$HOME` — the developer's real config is never touched.

## Run hygiene: interlock, checked deletes, stale-state guard

Ported 2026-10-28 from `scripts/mirror-e2e.sh` (the sweep hardening; the
mirror suite's run proved prior-run leftovers and interleaved invocations
read as PRODUCT failures). Four behaviors, all in `scripts/lfs-e2e.sh`:

1. **Concurrent-run interlock.** At startup the suite takes
   `apps/worker/.wrangler/state/lfs-e2e-run.lock` (an atomic `mkdir`, holding
   the runner pid — its OWN path, beside the other harnesses' locks). A
   second concurrent invocation fails immediately ("another lfs-e2e run is
   in flight") instead of interleaving two runs on the shared `lfse2e`
   namespace, the local D1/R2 state, and the dev-server port. A lock left by
   a SIGKILLed run is reclaimed automatically when its holder pid is gone;
   if you ever need to force-clear while no run is active:
   `rm -rf apps/worker/.wrangler/state/lfs-e2e-run.lock`.
2. **Every setup/cleanup DELETE is checked.** Every pre-clean/cleanup D1
   statement runs through `d1_checked` (wrangler's exit code and its
   `success` flag asserted — the plain `d1()` discarded both, which is how a
   failed pre-clean passed silently in the mirror suite's sweep), the
   wrong-scope PAT INSERT is checked too, and the pre-clean engine DELETE of
   `lfse2e/lfsdemo` must answer `200` (a stale cell existed and was purged —
   logged) or `404` (nothing under that name); anything else — a locked-cell
   500, a worker restarting mid-request (`curl 000`), a bad token — aborts
   the run naming the resource and code.
3. **Absence is verified, not assumed.** A `200` can precede an async cell
   purge that is still in flight (or was dropped), so the name is polled on
   the git surface (`GET /lfse2e/lfsdemo.git/info/refs?service=git-upload-pack`)
   until it reads `404` — the D1 rows are gone by then, so this answers
   through the registry-existence oracle: a registry-known orphan serves
   refs (`200`), clean state `404`s. The cleanup mirrors the same
   verified-purge poll before declaring a green run tidy (while the PAT is
   still valid).
4. **Stale prior-run state is wiped and re-verified, not trusted.** At setup
   the suite counts what it owns (`repositories`/`users` rows under
   `lfse2e`), wipes it with the checked deletes (including the per-repo
   `lfs_objects` sweep), and re-verifies the wipe before section 1 — so a
   crashed or sabotaged run's leftovers cannot poison the next one.

### Pre-server cell-file sweep (own-server runs only)

The mirror suite's product finding applies here too: a completed async cell
purge can leave the cell's sqlite file behind as an empty husk, and a later
engine DELETE of that name answers `HTTP 500 — database table is locked:
SQLITE_LOCKED`, deterministically, across dev-server restarts. When the
suite starts its OWN dev server (the default `pnpm test:lfs` flow — no
server answering at `$BASE`), it first removes ONLY the cell files whose
embedded DO name is under `lfse2e/` — never another suite's cells
(`demo/*`, `mirrore2e/*`, `dpprobe/*`) — making back-to-back green runs
self-sufficient. Requires `sqlite3` (GitHub's ubuntu-latest ships it);
without it the sweep is skipped with a note and the checked DELETEs still
abort loudly on an unwipeable cell. When a server ALREADY answers at
`$BASE` the suite reuses it (documented behavior) and the sweep is SKIPPED
with a note — removing cell files under a live server is what produces the
locked cells in the first place (`scripts/mirror-e2e.README.md` §
stale-state recovery); on that path an unwipeable husk aborts pre-clean
with the recovery pointer. Manual recovery (no dev server may be running):

```bash
for f in apps/worker/.wrangler/state/v3/do/cf-gitea-RepoCell/*.sqlite; do
  n=$(sqlite3 "file:$f?mode=ro" "SELECT name FROM __miniflare_do_name LIMIT 1" 2>/dev/null)
  case "$n" in lfse2e/*) rm -f "$f" "$f-wal" "$f-shm";; esac
done
```

## What is asserted

1. **D1-backed repo via push-create** — a plain first push with the PAT lands
   the `repositories` row (ACL rows 15-20, default private, status settles to
   `ready`); storage key matches `r_<id>`. The LFS pre-push hook fires BEFORE
   the pack upload, so on a nonexistent repo the batch 404s through the
   engine's transitional passthrough — the create push is therefore a
   pointer-free commit, and the LFS pushes come after (which is also the
   natural user flow against push-create).
2. **LFS push of a >100KB `.bin`** — `GIT_TRACE_CURL` must show the relay
   batch POST, `PUT objects/<oid>/<size>` and verify POST; the `lfs_objects`
   D1 row must be `state='verified'` with the right size; the R2 object at
   `lfs/<storage_key>/<oid>` must hash back to the oid (via
   `wrangler r2 object get --local`; the wrangler CLI shares the dev server's
   `apps/worker/.wrangler/state/v3` persist dir, so this reads exactly what
   the server wrote — same mechanism the bootstrap script uses for D1).
3. **Fresh clone smudge** — byte-identical content (sha256), `git lfs fsck`
   clean, and the batch `download` href serves the same bytes.
4. **Adopt / no re-upload** — second push uploads the new object exactly once
   (trace) and does NOT re-upload the known object; a fresh `batch(upload)`
   for the known oid answers `"actions":{}` (git-lfs then skips the transfer,
   SPEC-0006 §3.3); exactly two verified rows.
5. **Auth split (§2.2)** — wrong-scope token on batch upload → plain `403
   Forbidden`; unauthenticated batch on the private repo → `401` +
   `WWW-Authenticate: Basic realm="gitea-lfs"` + the LFS JSON envelope.

## Suggested CI job (not wired yet)

The suite is deliberately not in CI yet — the orchestrator can add a job like
this next pass (mirrors the git e2e job; the only extra requirement is
git-lfs, `apt-get install git-lfs` or the `git-lfs/setup-git-lfs` action):

```yaml
  lfs-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: sudo apt-get update && sudo apt-get install -y git-lfs
      - run: git lfs install
      - run: pnpm db:migrate:local
      # .dev.vars with GIT_TOKEN is required by wrangler.jsonc's
      # secrets.required for local dev (same as the git e2e job).
      - run: echo "GIT_TOKEN=ci-dev-token" > apps/worker/.dev.vars
      - run: pnpm dev & npx wait-on http://127.0.0.1:5173/healthz
      - run: bash scripts/lfs-e2e.sh
```

## Known scope limits

- **Known red on the current tree (suite-found bug, not a suite bug)**: the
  relay upload action in `apps/worker/src/services/lfs/batch.ts` carries
  upstream's `Transfer-Encoding: chunked` hint (`server.go:510-515`), which is
  precisely what makes git-lfs switch to chunked transfer and omit
  `Content-Length` (git-lfs `tq/basic_upload.go:58-59`) — but
  `handleUpload` in `apps/worker/src/lfs/router.ts` answers `411 Length
  Required` without a Content-Length, because the relay store's streaming put
  needs a known length (R2 binding streams + FixedLengthStream). git-lfs
  surfaces it as `LFS: Length Required` and the push dies; every case below
  the first upload cascades. Resolution belongs to the LFS route wave owner:
  drop the hint (git-lfs then sends a concrete length; a cosmetic wire
  divergence from upstream's link shape, zero handler changes) or teach the
  upload handler chunked bodies (buffering — against the streaming rules).
  The suite was verified fully green (33/33) against a throwaway worktree
  where only the hint was removed from the served code.
- Push-create depends on the engine receive path (SPEC-0001 M2 wave); engine
  refactors can transiently break case 1 — the suite reports it exactly
  there.
- Presigned-URL mode (M2's checksum-bound R2 PUTs) is not exercised here: it
  needs `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets and a real R2
  endpoint, neither of which local dev has. The relay shapes are upstream's
  verbatim, which is what the black-box layer pins.
- Locks (`info/lfs/locks/*`) are P2 (501) and untouched by this suite;
  `git lfs lock` users get the honest 501.
- Case 3 of SPEC-0006 §5 (expired-TTL retry) is presign-mode-only — the relay
  hrefs never expire — and case 5/6 (quota 422, fork `fetch --all`, delete
  purge) need the config surfaces and fork wave; they are covered by the
  worker-integration layer and future milestones instead.
- Scratch hygiene: `GIT_TRACE=1` captures contain the e2e PAT inside URLs;
  they stay in the printed scratch workdir and the token is only minted for
  the `lfse2e` fixture user, which green runs delete (cascading the PAT).
