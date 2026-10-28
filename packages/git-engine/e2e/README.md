# git-engine e2e suite

Real `git` client operations against a running Worker — the pattern adopted from
upstream durable-git's `scripts/e2e.sh` (vendored verbatim at
`packages/git-engine/scripts/e2e.sh` in upstream; the verbatim duplicate was
removed, `e2e.sh` here is the same script with an adapted 8-line header and is
the ONLY copy in this repo). This suite is the correctness gate required by
`specs/0001-storage-engine.md` §6: every e2e push must be followed by a clean
`git fsck`.

Status: **wired** (SPEC-0001 M1). The script body was byte-identical to the
adapted header version until 2026-10-28's run-hygiene hardening (below);
only the invocation adapts beyond that (base URL, token, PATH shim). Every
body deviation is recorded in `NOTICE.md` ("Local adaptations", 2026-10-28
`e2e/e2e.sh` row). CI runs it in `.github/workflows/ci.yml`.

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

## Run hygiene: interlock, checked deletes, stale-state guard

Ported 2026-10-28 from `scripts/mirror-e2e.sh` (the sweep hardening; the
mirror suite's run proved prior-run leftovers and interleaved invocations
read as PRODUCT failures). Three behaviors, all in `e2e.sh`:

1. **Concurrent-run interlock.** At startup the suite takes
   `apps/worker/.wrangler/state/engine-e2e-run.lock` (an atomic `mkdir`,
   holding the runner pid — the suite's OWN path, beside the other
   harnesses' locks). A second concurrent invocation fails immediately
   ("another engine e2e run is in flight") instead of interleaving two runs
   on the fixed `demo` owner segment. A lock left by a SIGKILLed run is
   reclaimed automatically when its holder pid is gone; if you ever need to
   force-clear while no run is active:
   `rm -rf apps/worker/.wrangler/state/engine-e2e-run.lock`.
2. **Every teardown DELETE is checked.** The clean-slate DELETEs (`demo`,
   `private-repo`, `old-date-repo` — the third added by the hardening: prior
   runs leave it behind) and section 13's repo teardown must answer `200`
   (stale state existed and was purged — logged) or, pre-clean only, `404`
   (nothing under that name); anything else aborts the run with the repo and
   code named. A `200` is trusted only after the git surface CONFIRMS
   absence: the suite polls `GET /<name>.git/info/refs?service=git-upload-pack`
   until it reads `404` (the registry-existence oracle — a registry-known
   orphan serves refs, clean state 404s). Section 13's absence probe also
   MOVED: the old trailing-slash page probe was vacuous here (the headless
   engine 404s page-shaped requests before auth even for a LIVE repo), so
   deletion is now proven on the git surface instead.
3. **Stale prior-run state is wiped and re-verified, not trusted.** The
   pre-clean wipes everything reachable under the suite's fixed names and
   re-verifies absence before section 1, so a crashed or red run cannot
   poison the next one with a non-fast-forwardable ref map.

### Stale-state recovery (manual one-liner)

A completed async cell purge can leave the cell's sqlite file behind as an
empty husk, and a later engine DELETE of that name answers
`HTTP 500 — database table is locked: SQLITE_LOCKED` on it, deterministically
and across dev-server restarts (the mirror suite's product finding,
reproduced 2026-10-28 on this suite's own `demo/demo`). This suite
DELIBERATELY does not sweep cell files itself: its contract runs against an
ALREADY-RUNNING dev server it does not own (CI starts it), and removing cell
files under a live server is what produces the locked cells in the first
place (`scripts/mirror-e2e.README.md` § stale-state recovery). When the
checked DELETE aborts with a 500: stop the dev server, clear ONLY this
suite's own cell files, and re-run:

```bash
# no dev server may be running (check the port first)
for f in apps/worker/.wrangler/state/v3/do/cf-gitea-RepoCell/*.sqlite; do
  n=$(sqlite3 "file:$f?mode=ro" "SELECT name FROM __miniflare_do_name LIMIT 1" 2>/dev/null)
  case "$n" in demo/*) rm -f "$f" "$f-wal" "$f-shm";; esac
done
```

This touches only cells named `demo/*` — never another suite's
(`lfse2e/*`, `mirrore2e/*`, `dpprobe/*`). CI is unaffected: its
`.wrangler/state` starts fresh every job, so husks cannot exist there.

## Sections and applicability (verified 2026-10-24, engine at M1)

The suite's protocol core carries over and passes:

- 1: push (create-by-push) — pass
- 2: full clone + `fsck --strict` + content/tags — pass
- 3: shallow clone, deepen, `--unshallow`, fsck — pass
- 4: incremental fetch stays small (thin negotiation) — pass
- 5: sideband progress (`remote:` lines) — pass
- 6: force push + `/gc` reclaiming stranded objects — pass (the `/gc` admin
  call is dgit-specific; compaction/GC is alarm/queue-driven per SPEC-0011
  and has its own tsx checks, `check-compaction.mjs` / `check-gc.mjs`)
- 7: branch create/delete, non-fast-forward rejection — pass
- 12: private repos, authed/anonymous clone semantics — pass, except one
  headless-mode check (below)
- 13: repo deletion — pass
- 14: auth hard checks (401/404 semantics) — pass

Sections that fail **permanently, by design** (re-verified 2026-10-25, after
the Tier-2 UI (SPEC-0008) and sessions (SPEC-0010) landed: 34 passed /
35 failed, and the failure set is exactly the CI allowlist —
`.github/workflows/ci.yml`, job `e2e`). They exercise upstream dgit's
cgit-style web UI, which cf-gitea replaced for good: the engine is created
with `ui: false` (see "How it is wired" above), so the dgit pages these
checks scrape do not exist and will never come back:

- 8: snapshots (`/snapshot/*.tar.gz|zip`) — engine pages 404
- 9: `/patch/` + `/rawdiff/` round-trips — same (the Gitea API/UI own this
  surface now)
- 10: UI pages, markdown/highlight/atom rendering — 404 by design
- 11: `/config` PUT works (admin, engine-owned) but its assertions read the
  dgit index page — 404 by design
- 12, one check: "private UI needs auth" expects the dgit UI's 401. The 401
  is unreachable for good, for two compounding reasons — WHERE the probe
  lands and WHAT answers it. Its URL keeps dgit's trailing slash
  (`GET /demo/private-repo/`), and the worker dispatcher pins every
  trailing-slash repository URL to the engine passthrough (SPEC-0008 §4
  item 13: the Tier-2 UI only claims canonical slash-less URLs), so neither
  the uiRouter nor SPEC-0010 sessions can ever answer this request. The
  headless engine then 404s page-shaped requests BEFORE its auth gate (the
  leak-avoidance posture recorded in the gate: "nothing can leak there"),
  so the observed code is 404, not 401. The protocol semantics of the same
  section (private clone 401/authed clone) pass.

The page-level coverage these sections used to provide lives in the Tier-2
UI suite (`apps/worker/src/ui/*.test.ts`, SPEC-0008 §5) and the Gitea API
contract (SPEC-0004, `pnpm check:api`) — not in this suite, which is
deliberately pinned to the engine passthrough. CI asserts the failure set
stays exactly this documented set — any new failing check fails the build.

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

## M3.5 fault-matrix / correctness-tier / capability-matrix checks (tsx, no dev server)

Three SPEC-0011 §7 M3.5 scripts — plain Node under tsx, no dev server: a real
`GitStore` over `node:sqlite` (`helpers/lib.mjs`, real BEGIN/COMMIT), real
`git` as the oracle where a client is involved.

- `check-fault-matrix.mjs` — SPEC-0011 §7.2's fault-injection matrix,
  completion tail: over a REAL GitStore, the REAL uploadPack DO arm streaming
  through a range-aware in-memory R2 bucket stub, and the REAL
  `runCompaction`/`runGcPass` — a real compaction publish lands MID-STREAM
  between segment GETs (row 1), a GC pass mid-transfer of a paced fetch is
  fully lease-blocked with row 12's early-release overlap pinned on the same
  timeline (rows 2+12), a real mid-stream lease expiry rejects the renewal and
  abandons the stream before the flush tail (row 3), and the crash-after-
  publish mid-delete retry convergence on a REAL publish (row 5; row 4's one
  missing assertion is appended to the landed `check-compaction.mjs` §5.3,
  which also now carries the two D3 graceful-failure-exit checks, `6545edd`).
- `check-correctness-tier.mjs` — SPEC-0011 §7.3's correctness-tier CI
  additions as engine checks (none existed as automated checks before M3.5):
  drives the REAL Worker-side receive flow — `createDurableGit().fetch` with
  the real parsePushRequest/stagePack/scan/finalizeReceive pipeline, the DO
  RPCs over node:sqlite, R2 staged in memory — plus real `git` as the
  serve-path oracle: the size-parametrized push-boundary trio (under-cap
  lands; over-cap DECLARED length is a 413 before any DO RPC or R2 write;
  over-cap UNDECLARED aborts mid-stream with every command rejected and zero
  refs moved), newTip-exists-tree-missing injection, finalize-success-
  response-lost retry convergence, full clone with cross-pack delta bases
  (`git index-pack` WITHOUT --fix-thin accepts, `git verify-pack -v` depth,
  fsck clean), incremental fetch on REF_DELTA + negotiated haves (exact
  new-object set, fsck clean).
- `check-capability-matrix.mjs` — the capability matrix, TEST-GENERATED
  (round 8's consistency gate; never hand-maintained): derives the
  advertised-capability tables from the LIVE handshakes (v0 upload-pack, v0
  receive-pack, protocol v2 `advertisement()` over a real store) and
  mechanically requires every advertised feature to map onto a REGISTERED
  PROOF that drives the real serve/control paths — an edit that advertises a
  capability without a handler proof FAILS, and a proof whose behavior drifts
  FAILS too; contrapositive pins keep `filter` unadvertised-and-rejected and
  unknown fetch arguments fail-closed.

```bash
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1)
node "$TSX" packages/git-engine/e2e/check-fault-matrix.mjs      # 6 checks
node "$TSX" packages/git-engine/e2e/check-correctness-tier.mjs  # 7 checks
node "$TSX" packages/git-engine/e2e/check-capability-matrix.mjs # 18 checks (test-generated at run time)
```

## Cursor-drain discipline tripwire (tsx, no dev server, static)

`check-drain-discipline.mjs` — the static tripwire for the workerd defect the
cursor-drain fix (29b966f) closed at the product seam: on a sqlite-backed
Durable Object, ONE un-drained `SqlStorage` SELECT cursor bricks every
subsequent `DROP TABLE` of an existing table for the whole runtime session
(`SQLITE_LOCKED`; `docs/research/workerd-ddl-cross-session-locked.md` — the
DDL distillation; workerd#959 — the defect persists upstream, so only the
discipline prevents a future `.exec(<SELECT>)` from re-bricking DDL
cross-session). EVERY `sql.exec(<SELECT>)` cursor must drain; only DDL/DML
may discard.

The script scans every `.exec(` site under `packages/git-engine/src/**` and
prints the full site table + census each run:

- Sites are found on a comment- AND string-blanked view of each file
  (character-granularity — a comment that merely mentions `sql.exec(` cannot
  become a phantom site), with balanced-generic calls like `.exec<Row>(`
  included (a bare `.exec(` grep misses those).
- Receivers: `sql`-ending (this.sql, this.ctx.storage.sql, the migrations
  `sql: SqlStorage` param) are SqlStorage sites; regex-literal receivers and
  the mod.ts URLPattern `pattern` are the excluded RegExp family; ANY other
  receiver fails closed so a new unknown receiver is looked at.
- Statement-head classification (the census's taxonomy): SELECT family =
  SELECT/WITH/VALUES (any statement of a multi-statement literal); DDL/DML =
  CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/REPLACE/transaction/PRAGMA-family.
  Interpolated templates classify by the STATIC text before the first `${`
  (`SELECT 1 FROM ${name}` → SELECT; `DROP TABLE IF EXISTS ${t}` → DDL); an
  interpolated head fragment naming no keyword FAILS CLOSED — never guessed.
  Bare-identifier arguments resolve through the src const map (the baseline
  SQL constants) before classifying.
- Every SELECT-bearing site must prove a full drain in the same statement
  (across lines/comments): `.toArray()` (the engine idiom), `.one()` (the
  guaranteed single-row aggregate shape), or full iteration
  (`[...exec()]` / a direct for..of with no break/return). `.next()` (one
  row), `.raw()` (its own cursor needs its own drain), and a bare discard
  FAIL naming file:line. Fail-closed is the contract: an unprovable shape is
  a failure, and the remedy is the `.toArray()` idiom (or a deliberate,
  documented extension of the rule set).

Every run self-tests the tripwire itself: the exact mutation class (a bare
`sql.exec(`SELECT 1`)` discard), the fail-closed interpolation arm and the
`.next()` arm must FAIL; a DDL discard and a drained SELECT must stay green.
Scanner-sanity floors keep the census from regressing vacuously (a parse
change that silently drops sites fails the floors). CI-able: exits 0/1 under
the tsx runner — to wire later, append the invocation below to the CI step
that runs the other tsx checks (left to the maintainers; `.github/` is not
this unit's file). An external mutation is witnessed by passing a scratch
file as an extra argv path: extra files are scanned in addition to src/** and
any failing site in them fails the run naming file:line (never commit one).

```bash
TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1)
node "$TSX" packages/git-engine/e2e/check-drain-discipline.mjs   # 4 checks (tree) + selftest; prints the site census
```
