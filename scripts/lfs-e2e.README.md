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
