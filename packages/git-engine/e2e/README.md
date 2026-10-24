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
