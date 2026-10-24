# mirror-import.mjs — the import-from-URL (mirror clone) client

The **SPEC-0009 §2.6 import producer** for external git URLs: it mirrors an
arbitrary https git source into an empty cf-gitea repository by driving the
**SPEC-0003 §2.6 async chunked import channel** with real git — the same
machinery a user upload drives, fed by an outbound `git clone --mirror`.

Upstream parity note: upstream Gitea runs `git clone --mirror` server-side
(`services/repository/migrate.go:92-102`). cf-gitea has no git binary in the
Worker, so this script is the git-binary half: it clones, splits the history
into self-contained pack windows, and ships them through our own import
channel. The Worker-side producer for *internal* URLs (SPEC-0009's outbound
smart-HTTP client, `apps/worker/src/services/mirror/gitclient.ts`) replaces
the clone+pack half with protocol-level fetch; the channel and manifest shapes
are identical.

## Usage

```sh
node scripts/mirror-import.mjs --source <https-git-url> \
     --target <our-origin-base-url> --user <owner> --token <PAT> \
     [--name <repo>] [--source-token <tok>] [--branch-filter <glob>] \
     [--window-bytes 512m] [--head <branch>] [--timeout 3600] \
     [--resume <import_id>] [--import-token <imp_…>] \
     [--dry-run] [--out <file>] [--pack-dir <dir>] \
     [--api /api/v1] [--keep-temp] [--yes]
```

| flag | meaning |
|---|---|
| `--source` | https git URL to mirror. **https only** — anything else is rejected (SPEC-0009 §1 divergence from upstream, which also accepts http/git/ssh/file). Local paths / `file://` are accepted **only under `--dry-run`** (no server is contacted). |
| `--target` | our origin's base URL (e.g. `https://cf-gitea.example` or `http://localhost:5173` for dev). |
| `--user` | owner namespace on the target; the repo is `<user>/<name>`. |
| `--name` | target repo name. Default: the source URL's last path segment minus `.git`. |
| `--token` | target PAT (`Authorization: token …` for the API, Basic for the git verify). Needs owner/admin on the target repo. |
| `--source-token` | sent to the SOURCE as `http.extraHeader=Authorization: Bearer …` git config — never spliced into the URL (SPEC-0009 §2.2 posture: credentials never appear in URLs, argv, remote config, or logs). |
| `--branch-filter` | glob over bare branch names (`main`, `release/*`, `feat-**`), comma-separated alternations. Narrows `refs/heads/*` only — tags and every other ref namespace always ride along (mirror parity, SPEC-0009 open question 4). |
| `--window-bytes` | byte budget per pack window, default `512m` (the server chunk cap). Accepts `k`/`m`/`g` suffixes. |
| `--head` | default branch to declare; default = the source's HEAD symref, else the first included branch. Must be an included branch. |
| `--timeout` | poll cap in seconds (default 3600). On timeout the import is aborted best-effort. |
| `--resume <id>` | re-enter an existing import (see Resume below). |
| `--import-token` | the one-time chunk-upload token (`imp_…`) shown once at create — required only to re-upload chunks on resume. |
| `--dry-run` | clone + plan + pack, then verify the windowing **locally** (no server calls) — see Dry-run. |
| `--out` / `--pack-dir` | dry-run aids: write the manifest JSON / the window packs to files. |
| `--keep-temp` | keep the temp mirror clone (debugging). |
| `--yes` | skip the confirmation prompt. |

Exit codes: `0` success · `1` failure (clone, plan, upload, poll, verify) ·
`2` usage · `130` interrupted (Ctrl-C aborts the import best-effort).

## What it does

1. `git clone --mirror` the source into a temp dir (all refs, full history).
2. Enumerate refs (`git for-each-ref refs/`) + the HEAD symref.
3. `git rev-list --topo-order --reverse` over every included ref (ref names
   ride stdin — argv-safe on ref-heavy sources).
4. One size probe (pack the first ≤ 200 commits) calibrates bytes/commit;
   the walk is cut into windows of `floor(budget / bytesPerCommit)` commits,
   clamped by the server's `chunk_size_cap`.
5. Per window: `git pack-objects --revs --stdout` with revs
   `<window-tip> ^<previous-window-tip>` — a **non-thin**, self-contained pack
   whose deltas reference only in-pack objects or objects already indexed from
   earlier windows. Oversize windows bisect and rebuild; a **single commit**
   that alone exceeds the budget cannot be split — it is warned about and the
   server's chunk cap stays the authority (SPEC-0009 §4.3.9's client-side twin).
6. Final window(s): everything the *ref tips* still need relative to the last
   boundary — annotated tag objects, non-commit ref targets — split by ref
   subsets when oversize. Each manifest chunk carries a `tip`: a commit IN the
   pack (the server creates `refs/import/<id>/chunk-<n>` at it, making the
   engine's connectivity check the per-chunk verdict — valid in any queue
   delivery order).
7. `POST /api/v1/repos/{o}/{r}/imports` → `PUT` each chunk (relay; headers
   `X-Import-Token`, `Content-Length`, `X-Chunk-Sha1` = the pack digest git
   names the pack after) → `POST …/start` with the manifest → poll
   `GET …/imports/{id}` printing per-chunk checkpoint progress → done/failed.
8. **Acceptance check**: `git ls-remote --symref` the target (Basic auth via
   header injection) and require every manifest ref to match the source oid +
   HEAD to match `manifest.head` (extra target refs warn; missing/mismatched
   fail). This is the SPEC-0009 "mirror == source" property.
9. Clean up the temp clone.

The manifest is exactly the server's strict schema (`{head, refs, chunks:
[{n, bytes, sha1, tip}], totalBytes}`); the client pre-checks the 10k-ref and
1 MiB manifest caps so over-cap sources fail before any upload.

## Resume

Chunk uploads authenticate with the **one-time import token** (shown once at
create, `imp_…`, SPEC-0003 §3.1). That shapes what resume can do:

| state on `--resume` | action |
|---|---|
| `done` | acceptance check only (verify + exit) — no source fetch at all. |
| `indexing` / `finalizing` / `failed` (post-start) | `POST …/start` again with the server's manifest — the SPEC's own remedy, it re-enqueues exactly the missing/failed chunk set (their bytes are still staged; only an *abort* purges). Then poll + verify. |
| `staged`, `--import-token` given | rebuild the plan from a fresh clone; chunks whose sha1+bytes match the server's `staged` record are **skipped**, missing/mismatched chunks are re-uploaded (a PUT overwrite is idempotent). A sha1 difference is a hint the source moved — the re-upload keeps the import consistent. |
| `staged`, no token | rebuild and compare: if every planned chunk is already staged, go straight to start. Otherwise the import is unrecoverable (uploads are token-gated) — the client **aborts it and starts a fresh import** (full re-upload), saying so. |

Ctrl-C (or `SIGTERM`, or a hard failure mid-import) aborts the import
best-effort so the target repo returns to `ready`/empty immediately instead of
waiting for the server's 24 h heartbeat sweep; a second signal exits without
cleanup. A Ctrl-C-aborted import should be restarted **fresh** (do not
`--resume` it — the abort purged the staged bytes while the manifest may still
mark chunks done).

## Dry-run: verifying the windowing without a server

`--dry-run` stops after the pack half and proves it locally, which makes it
usable as a fixture-level test (this is how the windowing was verified; see
below):

1. Every window pack is fed to `git index-pack --stdin` in a scratch bare
   repo — the same install step the server's consumer performs — and the
   pack name git reports must equal the manifest's `sha1`.
2. A temp ref lands at each chunk tip (the server's per-chunk verdict shape).
3. All manifest refs are created, then `git fsck --no-progress` must be clean.
4. Per included branch, `rev-list --count` in the reassembled scratch repo
   must equal the source.

Verified 2026-10-24 (git 2.43, `.bench-fixtures/5m`, seed 42):

| budget | windows | total packed | note |
|---|---|---|---|
| 512 MiB (default) | **1** + final (empty, skipped) | 5.43 MiB | whole fixture in one window |
| 256 KiB | **61** | 7.66 MiB | bisection fired repeatedly; 2 single-commit oversize warnings (binary-blob commits) |

The 256 KiB total exceeding the 5.43 MiB single-window total is inherent:
windows are self-contained deltas, so cross-window shared objects are
re-encoded per window. A full server roundtrip against the same fixture
(default budget, local dev server + a loopback HTTPS source that *requires*
the Bearer token) passed end to end: clone → 1 chunk → start → `done` →
`ls-remote` verify PASS, and a plain `git clone` of the target fsck'd clean
with the source's tip commit and commit count.

## Known limits (deliberate)

- **No LFS mirror** — deferred per SPEC-0009 §1 (needs the SPEC-0006 outbound
  LFS batch-API client). Git-data only.
- **No incremental resync** — this is a one-time import (the migrate flow's
  producer). Periodic re-sync is the pull-mirror sync consumer's job
  (SPEC-0009 §2.6 sync flow); re-running this tool requires a fresh empty
  target repo.
- **One commit per window can exceed any budget** — a single gigantic commit
  cannot be split by the client (the server-side equivalent of SPEC-0009
  §4.3.9); if it exceeds the chunk cap the import fails with the engine's
  early-reject.
- **All refs ride along** — `refs/pull/*` etc. are mirrored (upstream parity);
  use `--branch-filter` to bound the ref count (server cap: 10 000 refs,
  1 MiB manifest).
- **One window pack is held in memory** during upload (≤ the chunk cap);
  lower `--window-bytes` on constrained machines. Refs and commit lists are
  also buffered (10k refs / multi-MB walks are fine).
- **Tag-only sources fail** — the import channel requires at least one
  branch (`manifest.head` must name a `refs/heads/*` entry).
- The target repo must **exist and be empty** (`POST /imports` enforces it,
  SPEC-0003 §2.6); creation happens through the normal repo-create API
  beforehand (or `/repos/migrate` once it lands — the channel is the same).
- Non-`https` sources are rejected (SPEC-0009 §1 divergence); local paths are
  a `--dry-run`-only testing affordance.

## Conformance notes (deviations from the task sketch, matching the landed server)

- Manifest chunks are `{n, bytes, sha1, tip}`: the server's strict schema
  (`apps/worker/src/api/models/imports.ts`) validates `sha1` (pack digest)
  and a per-chunk `tip` — the brief's `sha256`/`refs-reached` sketch is
  realized as `sha1` + `tip` (the tip's reachability is what "refs-reached"
  meant operationally). The schema is `.strict()`: no extra fields.
- The relay PUT path is taken from the POST response's `upload` template
  (`{n}` substituted), not hard-coded.
- Resume's `--import-token` exists because the token is shown once and never
  stored server-side (sha256-hashed, SPEC-0003 §3.1) — without it,
  re-uploads are impossible by design and the client recovers via abort +
  fresh import.
