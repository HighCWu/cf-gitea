# git-engine e2e suite

Real `git` client operations against a running Worker — the pattern adopted from
upstream durable-git's `scripts/e2e.sh` (vendored verbatim at
`packages/git-engine/scripts/e2e.sh` in upstream; the verbatim duplicate was
removed, `e2e.sh` here is the same script with an adapted 8-line header and is
the ONLY copy in this repo). This suite is the correctness gate required by
`specs/0001-storage-engine.md` §6: every e2e push must be followed by a clean
`git fsck`.

Status: **wired** (SPEC-0001 M1). The script body is byte-identical to the
adapted header version; only the invocation adapts (base URL, token, PATH
shim). CI runs it in `.github/workflows/ci.yml`.

## How it is wired

1. `pnpm dev` runs the app Worker in workerd via `@cloudflare/vite-plugin`,
   with bindings from `apps/worker/wrangler.jsonc` (single source of truth per
   AGENTS.md). The vite dev server listens on `http://127.0.0.1:5173` (vite
   default — the worker is served through the vite port, not wrangler's 8787).
2. The Worker entry (`apps/worker/src/index.ts`) exports the Durable Object
   classes (`RepoCell`, `Registry`) from `@cf-gitea/git-engine` and delegates
   every `/:owner/:repo[.git]/...` request to
   `createDurableGit({ authorize, ui: false, namespaces: true })`. The DO
   namespaces are bound as `REPO` and `REGISTRY` (see the engine's
   `src/env.ts`). `PACK_CACHE` (R2 full-clone fast path) is intentionally not
   bound yet (SPEC-0001 §10 defers the clone cache); the engine degrades to
   the DO path.
3. Auth: the authorize hook (`apps/worker/src/git-http/authorize.ts`) opens
   public reads and gates pushes/admin/private reads on the `GIT_TOKEN`
   secret. Locally the value comes from `.dev.vars` (copy
   `.dev.vars.example`; the file is gitignored), which wrangler dev, the vite
   dev server and the vitest plugin all read because wrangler.jsonc declares
   `secrets.required = ["GIT_TOKEN"]`.
4. `namespaces: true` routes repositories as two-segment `owner/name` names
   (Gitea-style), while the byte-identical script body pushes flat
   single-segment names (`demo.git`). The invocation bridges the two by
   passing a base URL with an owner segment:
   `e2e.sh http://127.0.0.1:5173/demo devtoken` makes every `$BASE/<name>`
   resolve to the engine repo `demo/<name>`.
5. Progress shim: git only displays server sideband progress (the
   `remote: ...` lines) when stderr is a tty, and the script scrapes those
   lines from command substitutions and pipes (section 4 "incremental fetch
   is small", section 5 "sideband progress") — against any server, GitHub
   included. `shim/` is prepended to `PATH`; its `git` appends `--progress`
   to fetch/clone (client-side display only — the protocol exchange and the
   assertions are unchanged).
6. CI (`.github/workflows/ci.yml`, job `e2e`): starts `pnpm dev`, waits for
   `GET /healthz`, then runs the suite with the shim on PATH. Requires `git`
   (≥ 2.22), `curl`, `perl`, `tar`, `unzip` — all preinstalled on
   `ubuntu-latest`.

```bash
# local run
pnpm dev &   # wait for http://127.0.0.1:5173/healthz
PATH="$PWD/packages/git-engine/e2e/shim:$PATH" \
  packages/git-engine/e2e/e2e.sh http://127.0.0.1:5173/demo devtoken
```

## Sections and applicability (verified 2026-10-24, engine at M1)

The suite's protocol core carries over and passes:

- 1: push (create-by-push) — pass
- 2: full clone + `fsck --strict` + content/tags — pass
- 3: shallow clone, deepen, `--unshallow`, fsck — pass
- 4: incremental fetch stays small (thin negotiation) — pass
- 5: sideband progress (`remote:` lines) — pass
- 6: force push + `/gc` reclaiming stranded objects — pass (the `/gc` admin
  call is dgit-specific; our compaction design is alarm/queue-driven per
  SPEC §5 and will get its own check)
- 7: branch create/delete, non-fast-forward rejection — pass
- 12: private repos, authed/anonymous clone semantics — pass, except one
  headless-mode check (below)
- 13: repo deletion — pass
- 14: auth hard checks (401/404 semantics) — pass

Sections expected to be **replaced, not reused** (they exercise upstream
dgit's cgit-style web UI and admin endpoints, which cf-gitea swaps for the
official Gitea frontend + `/api/v1`, SPEC-0001 out-of-scope list) fail by
design while the engine runs headless (`ui: false`):

- 8: snapshots (`/snapshot/*.tar.gz|zip`) — engine pages 404
- 9: `/patch/` + `/rawdiff/` round-trips — same; becomes Gitea-API checks
- 10: UI pages, markdown/highlight/atom rendering — 404 by design
- 11: `/config` PUT works (admin, engine-owned) but its assertions read the
  dgit index page — 404 by design
- 12, one check: "private UI needs auth" expects the dgit UI's 401; headless
  returns 404 for pages before the auth gate. The protocol semantics of the
  same section (private clone 401/authed clone) pass.

Those become Gitea-API-level checks in a later SPEC, or are covered by the
official Gitea UI itself. CI asserts the failure set stays exactly this
documented set — any new failing check fails the build.

## SPEC-0001b merge-primitive checks (tsx, no server needed)

The merge/graph primitives add three tsx-run check scripts alongside
`check-deepen-parse.mjs` — plain Node, no dev server: a `node:sqlite` adapter
(`helpers/lib.mjs`) runs the real `GitStore` + control-plane (real
BEGIN/COMMIT transactions), and real `git` fixture repositories provide the
oracles (`git merge-base`, `git rev-list --topo-order/--left-right`,
`git merge-file`, `git merge-tree --write-tree`, `git rebase`).

```bash
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1)
node "$TSX" packages/git-engine/e2e/check-merge-graph.mjs   # §4.1 graph primitives (14 checks)
node "$TSX" packages/git-engine/e2e/check-merge-tree.mjs    # §4.2 tree merge + diff3 vs git (25 checks)
node "$TSX" packages/git-engine/e2e/check-merge-engine.mjs  # §4.3-4.5/4.8 RPC semantics (29 checks)
```

Notes on the oracles (see the scripts' headers for details):

- `git merge-tree --write-tree` embeds conflict-marker file content in its
  CONFLICTED tree (the tree a real merge leaves in the worktree); our plan
  drops conflicted paths instead (a conflicted merge is never landed), so the
  tree-oid equality holds for CLEAN merges and the conflicted-file list for
  all. Marker byte-exactness is proven per-file by the `git merge-file` cases.
- criss-cross fixtures have TWO valid merge bases; the engine's deterministic
  pick (newest committer time, then smaller oid) is asserted to be a member of
  `git merge-base --all`'s set and stable across calls.
- The §4.6 read-only rule is asserted by an object-count + refs + refs_version
  snapshot around every read RPC (including `rebaseOnto`).

## G3 cache-unreachability check (tsx, no dev server)

`check-cache-unreachable.mjs` — the P0 direct-evidence gate: drives the real
serve fast path through `createDurableGit().fetch` with counting stubs and
asserts the poisoned deepen-since request makes ZERO `planCloneStream` RPCs
(the M3.1 plan+lease probe that replaced the bare `currentPackKey` —
SPEC-0011 §3) and zero R2 interactions (control: the legal full clone makes
exactly one plan RPC and one R2 get, with the lease renewed inline and
released at the last read). Mutation-tested — see the script header and
NOTICE.md.

```bash
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1)
node "$TSX" packages/git-engine/e2e/check-cache-unreachable.mjs   # 15 checks
```

## M3.1 read-lease check (tsx, no dev server)

`check-read-leases.mjs` — the SPEC-0011 §3 gate over a real GitStore
(node:sqlite, real transactions) plus the real serve-path pieces: atomic
plan+lease (register-after-check window proven closed by rollback), the
readable-catalog dependency set (active + retired, never reclaimable),
renewal extension and every rejection posture (expired = fault A,
reclaimable = fault C, foreign pack, unknown plan), release-on-last-read +
idempotence + post-release read refusal, the GC-eligibility substrate,
fault B (DO restart on a file-backed SQLite: unexpired leases survive and
still block deletion), the expiry sweep, DO-arm integration (lease-before-
first-byte, cancel/error release, never a false success), the fast-path
re-framing loop (renew inline before segments, release at the last R2 read
under a slow client, rejected renewal terminates without the success tail),
and the real `RepoCell` RPC surface.

```bash
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1)
node "$TSX" packages/git-engine/e2e/check-read-leases.mjs   # 25 checks
```

The five CONTENT checks are the content-path coverage that closes the M3.2
as-built record's known gap (reads OUTSIDE the two upload-pack arms):
`readBlob` acquires and releases the read lease around the read (counting
stub), a concurrent GC pass at the R2 seam is flip-blocked by the live lease
(§6.6) and a drained pack reclaims only after release (the post-reclaim read
refuses whole), a lease past its renew margin plus a mid-renewal reclaim
rejects the gate and fails the RPC whole (fault A/C, never a partial answer),
ls-refs peels and `listRefs` peels run under one lease, and a loose-only repo
(empty catalog) stays guard-free.
