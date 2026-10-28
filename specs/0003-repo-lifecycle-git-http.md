# SPEC-0003: Repo Lifecycle & Git Smart HTTP (Worker adapter, push-create, import channel)

Status: draft · Date: 2026-10-24 · Implements ADR-0001 D3 (Worker route layer + repository
registry) for the git-HTTP half; storage semantics live in SPEC-0001, auth primitives in
SPEC-0002. Upstream reference: submodule pin `fc4936884584` (v29.0.0-dev era; ADR-0001 D5
re-pin is tracked separately — file citations below are from the current pin).

## 1. Problem and scope

SPEC-0001 built the engine (pkt-line, packs, leases, ref CAS) but deliberately left out
everything a real git client touches first: the URL routes, the auth/ACL gate, repo
existence and lifecycle, and a path for histories larger than the 1 GiB/push quota
(SPEC-0001 §6 T1). This SPEC is the **Worker-side adapter layer**: thin Hono routes that
parse a git smart-HTTP request, call SPEC-0002 auth, invoke the SPEC-0001 engine, and map
results back onto git-protocol responses and upstream-compatible status codes. It also
owns the repository lifecycle that the git protocol depends on (create incl.
create-by-push, rename, transfer, delete, visibility) and the async chunked import
channel for >1 GiB histories.

In scope:

- Git smart-HTTP route table (`/info/refs`, `git-upload-pack`, `git-receive-pack`) with
  request parsing, gzip handling, `Git-Protocol` negotiation, streaming response, and
  error mapping to upstream status codes (§2.1–2.3).
- The ACL matrix: anonymous/public/private × read/write × push-create, with exact
  401 / 403 / 404 semantics (§2.4).
- Repo lifecycle and its storage effects: create, push-create, rename (+ redirects),
  transfer, delete (queue-driven purge), visibility model, default branch handling (§2.5).
- Async chunked import channel (>1 GiB): presigned R2 upload, Queue-driven chunked
  indexing, DO checkpointing, final ref CAS (§2.6).
- Client-side batched-push fallback script (no server changes) (§2.7).
- Edge cases: create-by-push races, push during delete, orphaned staging, `.git`
  normalization, case sensitivity, gzip bodies (§4).

Out of scope: auth/token mechanics (SPEC-0002), the engine itself (SPEC-0001),
`/api/v1` REST surface for repos beyond the lifecycle/import endpoints defined here —
response schemas for the 350-path swagger contract are SPEC-0004 — LFS (0006), wiki git
endpoints (`*.wiki` URLs are excluded, like SSH: documented exclusion), mirrors,
`git-upload-archive` (excluded; divergence documented in §2.2), dumb-HTTP object
endpoints (§2.2).

## 2. API surface

### 2.1 Route table (Hono)

Upstream registers git HTTP under `/{username}/{reponame}` with `.git` handled inside
`{reponame}` (`gitea/routers/web/githttp.go:12-25`, wired at `routers/web/web.go:1782`);
there is no separate `.git` route group — `httpBase` does
`strings.TrimSuffix(ctx.PathParam("reponame"), ".git")` (`routers/web/repo/githttp.go:96`).
cf-gitea matches with one normalized pattern per service; the `.git` suffix is trimmed
in the route adapter before lookup (§4.4):

| Method(s) | Route | Handler | Engine call |
|---|---|---|---|
| GET, HEAD, OPTIONS | `/:owner/:repo(.git)?/info/refs` | advertisement (`?service=git-upload-pack\|git-receive-pack`) | DO `advertiseRefs` |
| POST, OPTIONS | `/:owner/:repo(.git)?/git-upload-pack` | fetch data plane | worker-side v2 fetch (SPEC-0001 §5) |
| POST, OPTIONS | `/:owner/:repo(.git)?/git-receive-pack` | push data plane | lease → stream → index → `finalizeReceive` (SPEC-0001 §5) |
| GET, OPTIONS | `/:owner/:repo(.git)?/HEAD` | synthetic `ref: refs/heads/<head>` from DO `meta.head`, `text/plain`, no-cache | DO meta read |

**Amendment (2026-10-25, defense-in-depth wave — commit 70c9c3d):** the gate's claim
widens beyond the four git routes. Repository-scoped ENGINE JSON/admin paths —
`/api/*` (JSON content reads) and the admin shapes (PUT `config`/`description`,
POST `gc`, DELETE of the repo root) — for **D1-resolved** repositories run the same
§2.4 matrix (JSON reads through the read rows; admin shapes through the WRITE rows:
the Worker API is the sanctioned admin channel). Rationale: the engine's own
authorize hook decides those paths from the registry's best-effort `priv` mirror
(`seedRepoExtras` → `registry.setConfig`); a drifted or failed sync must never
serve a private repo's JSON refs anonymously while the git routes correctly 401.
D1 row missing → a `repo_redirects` row 301s to the canonical path (row 13), else
the request passes through verbatim (the transitional population, unchanged).
Page/unknown shapes stay passthrough for everyone: the engine headless-404s them
BEFORE its authorize hook. The LFS family (SPEC-0006 §2.1) keeps its own branch.

Route handlers stay thin per AGENTS.md ("Routes are thin"): each handler runs the shared
`gitHttpGate` pipeline — parse → auth (SPEC-0002) → resolve repo (D1) → authorize →
engine invoke → respond — implemented once in `src/services/githttp/`, with per-service
plumbing only.

Adapter responsibilities, in order:

1. **`go-get=1` short-circuit**: `?go-get=1` on `info/refs` returns `200` with the
   `<meta name="go-import" …>` body regardless of repo existence or access
   (upstream `routers/web/repo/githttp.go:63-66`,
   `services/context/repo.go:401-417` — go-get ignores `.netrc`, so the meta must be
   served without auth).
2. **Service parse**: `info/refs` service from `?service=`; RPCs from the path. Unknown
   service → `400` (upstream `githttp.go:82-84`).
3. **Auth**: call SPEC-0002 with `mode = read|write` derived from the service
   (`upload-pack` → read, `receive-pack` → write), credential presence, and the
   repo identity. SPEC-0002 returns one of `{ anonymous, principal }`; §2.4 maps it.
4. **Repo resolution**: D1 lookup `(owner_id, lower_name)` case-insensitively, redirect
   check on miss (§2.5.3). Owner from D1 users (SPEC-0002 tables).
5. **Engine invocation + streaming response**: never `request.arrayBuffer()` (AGENTS.md);
   `receive-pack` streams the body into the R2 stager; responses stream out.

### 2.2 Response conventions (upstream-faithful)

Content types and cache headers ported from `routers/web/repo/githttp.go`:

| Response | Content-Type | Cache headers | Body framing |
|---|---|---|---|
| `info/refs` advertisement (v0/v1) | `application/x-git-upload-pack-advertisement` / `application/x-git-receive-pack-advertisement` (`:490`) | `Expires: Fri, 01 Jan 1980 00:00:00 GMT`, `Pragma: no-cache`, `Cache-Control: no-cache, max-age=0, must-revalidate` (`setHeaderNoCache`, `:317-321`) | pkt-line `# service=git-upload-pack\n` + `0000` flush + advertise-refs payload (`:517-520`, `pktLineWriteText` `:439-454`) |
| `info/refs` v2 (client sent `Git-Protocol: version=2`) | same advertisement type | same | `# service=…` + flush + v2 capability advertisement (SPEC-0001 §5 serve path) |
| RPC result | `application/x-git-upload-pack-result` / `application/x-git-receive-pack-result` (`:393`) | no-cache triple | streamed, chunked, no Content-Length |
| Dummy empty advertisement (push-create probe, §2.5.2) | `application/x-git-receive-pack-advertisement` | no-cache triple (`:293-296`) | `# service=git-receive-pack` + flush + empty-repo `capabilities^{}` payload (upstream caches this statically, `dummyInfoRefs` `:268-300`) |
| `HEAD` file | `text/plain` | no-cache triple | `ref: refs/heads/<default_branch>\n` |

Upstream also serves dumb-HTTP endpoints (`HEAD`, `objects/info/packs`, loose objects,
pack files, `GetTextFile`/`GetLooseObject`/…, `githttp.go:17-24`) with
`Cache-Control: public, max-age=31536000` (`setHeaderCacheForever`, `:323-329`). **Not
built**: no modern git client negotiates dumb HTTP; documented divergence — those URLs
return `404` plain text. `info/refs` **without** `?service=` (legacy dumb probe,
`githttp.go:472-481`) returns `400` instead of upstream's dumb listing — same
divergence class. `git-upload-archive` (`POST` route upstream `:15`) returns `404` in
v1; real support is a later SPEC (needs server-side tree→tar streaming).

Error protocol detail: for a repo whose storage does not exist yet (e.g. wiki-style
lazily-initialized repos), upstream returns `200` with a pkt-line
`ERR repository doesn't exist` instead of an HTTP error
(`routers/web/repo/githttp.go:498-507`; test
`tests/integration/git_smart_http_test.go:56-59`). cf-gitea adopts this for the
engine-level "no such repo" case after the ACL gate passes (can only happen in a
delete race, §4.2).

### 2.3 Request parsing

- **Content-Type**: RPC POSTs must carry `application/x-git-{upload,receive}-pack-request`
  exactly, else `400` (upstream `:376-381`).
- **gzip**: upstream wraps the body in a gzip reader when
  `Content-Encoding: gzip` and answers `400` on malformed gzip (`:397-405`). cf-gitea
  pipes `request.body` through `new DecompressionStream("gzip")` (workerd-native,
  zero-copy) — but with a **counting transform that aborts at the decompressed-size cap**
  (§4.7), which upstream's unbounded reader does not have. Other content-encodings pass
  through untouched (upstream only special-cases `gzip`).
- **Git-Protocol header**: forwarded to the engine only if it matches upstream's strict
  regex `^[0-9a-zA-Z]+=[0-9a-zA-Z]+(:[0-9a-zA-Z]+=[0-9a-zA-Z]+)*$` (`safeGitProtocolHeader`,
  `:339-341`, `:347-350`); this is the v0/v2 negotiation switch for fetch.
- **Streaming rules**: receive-pack body goes to the R2 stager with `FixedLengthStream`
  when `Content-Length` is known (SPEC-0001 §5); fetch responses re-frame sideband from
  R2 GET bodies. The Worker never buffers a pack.

### 2.4 ACL matrix (401 vs 403 vs 404)

Conventions adopted from git-on-cloudflare (goc) as recorded in SPEC-0001 §2 hard rules
and ADR-0001 D3: unauthenticated → `401` with a Basic challenge; authenticated but
lacking the grant on an **invisible** repo → `404` (existence hidden); authenticated
with a defective **credential** (bad token, wrong scope) → `403` (identity was
established, so hiding is pointless). Upstream implements exactly this split in
`httpBase` (`routers/web/repo/githttp.go:62-261`) and it is pinned by
`tests/integration/git_smart_http_test.go` (scope violations → `403` at `:113-124`;
private repo with public-only token → `404` at `:132`).

Anonymous pull precondition (upstream `:130-146`): owner visibility must be **public**
and repo **not private**, unless the instance sets require-sign-in-view, or the repo
grants anonymous read on its code unit. Visibility model: repo is `is_private` bool;
owner is public/limited/private (§2.5.6) — "internal" is owner-limited, not a separate
repo state (upstream `modules/structs/visible_type.go:9-18`, `models/repo/repo.go:186`).

Full matrix (F = fetch `upload-pack`/`info/refs?service=git-upload-pack`,
P = push `receive-pack`):

| # | Caller | Repo | Op | Response | Upstream cite |
|---|---|---|---|---|---|
| 1 | anonymous | public repo, public owner | F | 200 advertisement | `:132-135` |
| 2 | anonymous | private or missing repo, or limited/private owner | F | `401` + `WWW-Authenticate: Basic realm="Gitea"` | `:150-160` |
| 3 | anonymous | any | P | `401` + challenge (push always needs identity) | `:149-160` |
| 4 | anonymous unit-read granted | private repo | F | 200 | `:138-145`, test `:163-189` |
| 5 | anonymous unit-read granted | private repo | P | `401` (unit read never grants write) | test `:184` |
| 6 | any | require-sign-in-view instance | F | `401` (overrides #1/#4) | `:132`, test `:186-188` |
| 7 | authenticated, token lacks `read:repository` / `write:repository` scope for the op | any | F/P | `403` | `:163-166` (CheckRepoScopedToken), test `:110-128` |
| 8 | authenticated, valid scope, repo visible to them, **no write grant** (non-collaborator on public repo, read-only collaborator) | existing | P | `404` "Repository not found" (existence known, write capability hidden) | `:197-199` |
| 9 | authenticated, valid scope, **no read grant** (private repo, not collaborator) | existing | F/P | `404` "Repository not found" | `:197-199`, test `:130-133` |
| 10 | authenticated | archived repo | P | `403` "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests." | `:124-128` |
| 11 | authenticated, account disabled/prohibited | any | F/P | `403` "Your account is disabled." | `:180-183` |
| 12 | basic-auth password of a 2FA-enrolled user (not a token) | any | F/P | `401` + upstream's explanatory plain text | `:168-178` |
| 13 | anyone, renamed old URL | — | F/P | `301` to canonical path **before** auth (git clients must see the redirect before a challenge) | `:117-119`, test comment `:139` |
| 14 | anyone | `?go-get=1` | F | `200` meta, no auth | `:63-66` |

Push-create authorization (P on **nonexistent** repo; upstream `:209-241`):

| # | Caller | Condition | Response |
|---|---|---|---|
| 15 | anonymous | — | `401` + challenge (never reaches push-create logic) |
| 16 | authenticated user | user namespace is **not their own** | `404` (upstream: `PushCreateRepo` error → `Status(404)`, `:235-239`) |
| 17 | authenticated user | own namespace, push-create enabled | create then proceed to receive (§2.5.2) |
| 18 | authenticated user | own namespace, push-create disabled | `403` "Push to create is not enabled for users." (`:224-227`) |
| 19 | authenticated member | org namespace, has org repo-create grant, push-create-org enabled | create (upstream gate `organization.CanCreateOrgRepo`, `services/repository/repository.go:87-96`) |
| 20 | authenticated member | org namespace without grant, or org push-create disabled | `403` "Push to create is not enabled for organizations." (`:220-223`) / `404` per #16 |

Note the upstream ordering quirk we keep: the enable-flag checks (#18/#20) run **before**
the dummy advertisement, and the `GET /info/refs?service=git-receive-pack` probe on a
nonexistent repo returns the **dummy empty advertisement** only when a push-create path
is plausibly available and the caller authenticated (`:229-233`); the real permission
check happens at POST time. Wiki push-create is refused (`:215-218`); wikis are excluded
here anyway.

Divergence from upstream defaults (documented per AGENTS.md): upstream ships
`ENABLE_PUSH_CREATE_USER`/`ENABLE_PUSH_CREATE_ORG` **false**
(`modules/setting/repository.go:146-147`); cf-gitea defaults user-namespace push-create
**on** and org push-create **on for users holding the org repo-create grant** (a
headless forge's primary create path; ADR-0001 names create-by-push as a 0003
deliverable), both configurable. Push-created repos default private
(upstream `DefaultPushCreatePrivate: true`, `modules/setting/repository.go:137`).

### 2.5 Repo lifecycle

#### 2.5.1 Create (API)

Mirrors upstream `CreateRepositoryDirectly`
(`services/repository/create.go:201-…`) in two steps with reversed failure semantics
for the cloud (no local filesystem to clean):

1. D1 transaction: insert `repositories` row — `storage_key = 'r_' || id` allocated
   from the insert (implementation note: D1 cannot reference the autoincrement id in
   the same statement — insert, read `last_row_id`, then `UPDATE … SET
   storage_key='r_'||id`, all inside one transaction; immutable thereafter; renames/
   transfers never touch it — ADR-0001 D3),
   `lower_name`, `is_private`, `default_branch` = instance default (`main`),
   `is_empty = true` (unless auto-init), `status = 'ready'`, `refs_version = 0`.
   `UNIQUE(owner_id, lower_name)` is the arbitration point for every create path.
2. Cold-start the RepoDO (`idFromName(storage_key)`): write `meta.head`,
   `refs_version=0`. Empty repos advertise `capabilities^{}` with
   `symref=HEAD:refs/heads/<default>` (SPEC-0001 §5). If step 2 fails after step 1
   committed, the row remains with `status='ready'`, `is_empty=true` — the DO is created
   lazily on first git/API touch, so no compensating delete is needed (upstream needs
   `cleanupRepository` because storage is a directory; ours is an empty DO namespace).

Upstream creates a physical empty repo on disk at create time; upstream `info/refs`
checks `IsRepositoryExist` and can `ERR` if storage is missing (`githttp.go:492-507`).
In cf-gitea the DO *is* the storage and is implicit, so that error path only fires on
deleted-mid-request races (§4.2).

#### 2.5.2 Create-by-push (push-create)

Upstream flow (`routers/web/repo/githttp.go:209-241`,
`services/repository/repository.go:83-108`): on `POST /git-receive-pack` for a
nonexistent repo, after ACL rows #15–#20, create the repo **before** reading the pack,
then run the normal receive. The preceding `GET /info/refs` got the dummy empty
advertisement (§2.2), so the client believes the repo exists and sends zero-id
create commands — no protocol special-casing needed. cf-gitea is identical; the create
is §2.5.1 step 1 + a `status='creating'` guard column so a crash between create and
finalize cannot leave a half-usable repo that looks empty-but-ready: if the receive
fails without a single ref committed, the repo row is deleted again (D1 conditional on
`status='creating' AND is_empty`); once the first `finalizeReceive` lands, status flips
to `ready` in the same D1 update that records `is_empty=false`.

First push and the default branch: upstream sets `DefaultBranch = <pushed branch>` and
`IsEmpty = false` on the first non-empty branch push, and rewrites HEAD on disk if the
branch differs from the instance default (`services/repository/push.go:255-264`,
`pushNewBranch`). cf-gitea does the same inside the `finalizeReceive` D1 update:
`is_empty=false`, `default_branch=<the recorded HEAD branch>`, where the adoption
prefers the engine's own HEAD resolution — the `commitPush` fixup's main → master →
first-branch pick over the whole command plan (`git/protocol.ts:1615-1623`; the
receive-path stand-in for upstream's first-pushed-branch op, since a single
`commitPush` application has no per-op order to read) — taken when it names a landed
branch, with the alphabetically first branch as the HEAD-less/unborn fallback. The DO
`meta.head` already carries the engine's pick; the settle re-points it via the engine's
`setHead` RPC only on the fallback arm's divergence (no separate round trip on the
common path). Later explicit default-branch changes (API, 0004)
update D1 + DO `meta.head` via CAS. v0 advertisements of an empty repo carry
`symref=HEAD:refs/heads/<default>`; v2 uses `unborn` in `ls-refs` (SPEC-0001 §5).

#### 2.5.3 Rename

Upstream `ChangeRepositoryName` (`services/repository/transfer.go:408`, core
`changeRepositoryName` `:368-404`): validate `IsUsableRepoName`, check collision
case-insensitively, **rename the on-disk directory**, then insert a redirect row. In
cf-gitea storage is `storage_key`-addressed, so rename is metadata-only:

1. Validate name with the ported upstream rules (`models/repo/repo.go:72-89`):
   `^[-.\w]+$`, no `..`, not in reserved `{".", "..", "-"}`, not matching reserved
   patterns `*.wiki`, `*.git`, `*.rss`, `*.atom` — note `*.git` reservation is what
   makes §4.4's suffix trim unambiguous.
2. D1 transaction: `DELETE` any existing redirect at `(owner_id, new_lower_name)`
   (upstream `NewRedirect` does this first, `models/repo/redirect.go:81-92`), update
   `name`/`lower_name`, insert `repo_redirects(owner_id, lower_name=old, redirect_repo_id=id)`.
   The unique constraint aborts a collision (`409` at API level).
3. RepoDO untouched (refs/packs keyed by `storage_key`); `refs_version` untouched (edge
   cache keys never see names).

Old URLs answer `301` to the canonical path, preserving the rest of the URL, **before
any auth challenge** (upstream `:117-119`, `services/context/repo.go:420-436`; the
ordering is required by git clients, per the upstream test comment at
`tests/integration/git_smart_http_test.go:139`). Redirects apply to git HTTP and later
to web/API lookups alike, exactly like upstream `LookupRedirect`
(`models/repo/redirect.go:67-79`).

#### 2.5.4 Transfer

Upstream runs a pending-transfer state (`repo_transfer` table) and on accept moves the
storage directory, deletes any redirect shadowing the new location, and registers a
redirect **under the old owner** (`services/repository/transfer.go:320-354`:
`NewRedirect(oldOwner.ID, repo.ID, repo.Name, repo.Name)`). cf-gitea:

- `POST` transfer request → `repo_transfer` row (doer, target owner, target teams
  later); repo stays usable; the pending state is visible to collaborators (0005 for
  notifications).
- Accept: D1 transaction — update `owner_id`, delete redirect at
  `(new_owner_id, lower_name)` (shadow rule above), insert redirect
  `(old_owner_id, lower_name) → repo_id`, delete the transfer row, `status='ready'`.
  Storage untouched (`storage_key` immutable); RepoDO untouched (ownership lives in D1;
  the DO never resolved ownership).
- Visibility re-check is implicit: the ACL matrix reads `owner.visibility` fresh from
  D1 on every request, so a transfer to a private owner immediately hides the repo from
  anonymous readers (no cache invalidation needed — the 60 s refs edge cache is keyed by
  `refs_version` + a visibility-class byte computed per-request, §4.6).
- Reject/cancel: delete the `repo_transfer` row.

#### 2.5.5 Delete

Upstream deletes **all DB rows in one transaction first**, then removes storage files
after commit, converting storage failures into admin notices
(`services/repository/delete.go:53-394`; the ordering comment at `:324-326`: "We should
always delete the files after the database transaction succeed. If we delete the file
but the database rollback, the repository will be broken."). cf-gitea adopts the same
ordering with a queue in the middle:

1. **D1 transaction**: delete the repo row and dependents (issues/PRs/releases/etc. as
   they exist per 0004/0005 tables), all `repo_redirects` pointing at the repo, pending
   `repo_transfer`. The row is gone → every subsequent git request 404s at repo
   resolution, and a same-name repo can be re-created immediately (it gets a **new**
   `storage_key`; no name-based storage reuse, unlike upstream where the directory name
   is reused and stale-directory collisions must be guarded).
2. **DO tombstone** (fast, synchronous): RepoDO RPC `markDeleted` — sets
   `meta.deleted=1`; `acquireReceiveLease` refuses new leases for tombstoned repos and
   `finalizeReceive` on a repo tombstoned mid-flight aborts, releases the lease, and
   reports sideband failure (§4.2). Refs never dangle because refs live in the DO.
3. **Queue purge**: enqueue `{storage_key}`; the consumer (own subrequest budget,
   SPEC-0001 §6 T3 discipline) deletes the R2 prefixes
   `repos/<storage_key>/` (packs, staging, clone-cache) and `imports/<storage_key>/`
   by paged `list` + batch delete, checkpointing progress in the message/queue state;
   finishes with `RepoDO.destroy()` (drop SQLite rows + delete the DO namespace). A
   purge that dies mid-way is retried by queue redelivery; steps are idempotent.
   Storage errors never fail the user-facing delete — they land in an admin
   notices-equivalent log table (upstream `system_model.CreateNotice`,
   `delete.go:328-342`).
4. `refs_version` has no delete semantics: the repo row (and its cache keys) is already
   unreachable.

#### 2.5.6 Visibility model

- `repositories.is_private` (bool, upstream-compatible) × `users.visibility`
  ∈ {public, limited, private} (SPEC-0002) → effective ACL per §2.4. No third repo-level
  state: upstream "internal" is owner-limited visibility
  (`modules/structs/visible_type.go:9-18`).
- Anonymous fetch allowed iff owner public ∧ repo public ∧ ¬require-sign-in-view (row 1);
  limited owners expose their public repos to any authenticated principal only.
- Flipping visibility (API) is a D1 update + `waitUntil` edge-cache purge of the
  repo's refs-cache class; worst case stale-allowed window is the 60 s refs cache TTL,
  and RPC/data-plane paths re-check D1 every time (cache only ever hides the
  advertisement, never the pack fetch, which is authorized per request).

### 2.6 Async chunked import channel (>1 GiB histories)

This is the SPEC-0001 §6 T1 escape hatch, owned here. Design goal: move a huge history
into cf-gitea as N independent packs without any single request indexing more than the
engine quota.

**Producers** (client side, ships as `scripts/import-chunked.mjs`): `git pack-objects`
per batch window (topo-order commit windows and/or byte target ~512 MiB), producing
self-contained (non-thin) packs + a manifest of `ref → oid` and which batch reached
which ref. Any HTTP client can replay this; the script is a convenience, the protocol
below is the contract.

**Endpoints** (owner-or-admin scoped via SPEC-0002; declared here, swagger-shaped in
0004):

- `POST /api/v1/repos/{owner}/{repo}/imports` — target repo must exist, `is_empty=true`,
  not archived, no active import. Creates `repo_imports` row (`state='staged'`),
  sets repo `status='migrating'` (upstream status value exists for exactly this,
  `models/repo/repo.go:146-149`), returns `{import_id, chunk_size_cap, upload}`.
- Per chunk: response to the POST (and `GET …/imports/{id}` on resume) carries either a
  **presigned R2 PUT URL** for
  `imports/<storage_key>/<import_id>/chunk-<NNNN>.pack` (R2 binding presign if
  available at implementation time) or, fallback, a Worker-relayed
  `PUT …/imports/{id}/chunks/<n>` that streams straight into an R2 multipart part —
  same bytes either way, single streaming write, never buffered.
- `POST …/imports/{id}/start` — validates the manifest (chunk list, sizes, `ref → oid`
  map, declared head), enqueues one Queue message per chunk.

**Indexing pipeline** (Queue consumer; DO checkpointing):

1. Consumer claims chunk N: verifies pack trailer SHA-1 while streaming the R2 body
   once, runs the SPEC-0001 two-pass index + idx v2 write into the repo's normal
   catalog as `kind='import'`, `state='staged'` (never `active` — refs may not point
   into unindexed storage, SPEC-0001 §5 connectivity rule).
2. On success: RepoDO `importCheckpoint(import_id, chunk=N)` — durable progress record
   in DO SQLite (`imports_checkpoints`, below). State machine (D1 mirrors DO for
   observability; **DO is authoritative**):
   `staged → indexing(chunk N) → staged(chunk N done) → … → finalizing → done | failed`.
3. All chunks staged → `finalizing`: connectivity check from the manifest's ref tips
   across all staged packs (engine primitive; same reachability walk as receive) → one
   DO CAS transaction marks every import pack `active`, writes **all** refs from the
   manifest in one multi-ref commit (zero-id creates; `oldOid` = zero), bumps
   `refs_version`, and sets `meta.head` — the same atomic finalize shape as a push.
   Then D1: `is_empty=false`, `default_branch=manifest.head`, `status='ready'`,
   import `state='done'`. Clones before this instant see an empty repo (correct: no
   refs advertised); after it, a normal repo.
4. Chunk failure → `state='failed'` + error; previously staged chunks and their
   checkpoints are kept, so `POST …/start` retries only the missing/failed chunk set.
   `POST …/imports/{id}/abort` purges `imports/<storage_key>/<import_id>/` and staged
   catalog rows, resets repo `status='ready'` (still empty).
5. Sweep: RepoDO alarm / Queue delay sweep abandons imports with no heartbeat for 24 h
   (`state='failed'`, reason `timeout`) and eventually purges them; orphaned
   `imports/` prefixes with no D1 row are reclaimed by the periodic orphan sweep
   (SPEC-0001 §1).

**Limits**: chunk ≤ 1 GiB (engine pack quota, SPEC-0001 §6 T1 — a chunk *is* a push
from the engine's perspective); total import size and chunk count configurable
(default 50 GiB / 200 chunks — sized to keep the DO catalog's ~100 B/object row volume
inside DO storage limits, T6); manifest ≤ 1 MiB (ref count cap 10k); one active import
per repo; repos with an active import refuse `receive-pack` with
`409 Conflict` (text "import in progress") after auth — fetch stays allowed.
**Observability**: `GET …/imports/{id}` returns state, per-chunk checkpoint list,
bytes staged, error text; state transitions emit log events (wrangler observability is
on per AGENTS.md).

### 2.7 Fallback: client-side batched push (no server changes)

`scripts/import-batched-push.sh` — for users who cannot or do not want the import
channel (e.g. before it ships). Exploits thin packs: advance the branch tip through
topo-ordered commit windows so each push transfers only the delta since the previous
tip (the engine accepts thin packs, SPEC-0001 §5):

```sh
# window = every 500th commit + final tip
git rev-list --reverse --topo-order main | awk 'NR % 500 == 0' > tips
echo "$(git rev-parse main)" >> tips
while read -r tip; do
  git push --force origin "+$tip:refs/import/batched-tmp"   # same target each time: thin delta vs prior tip
done < tips
git push --force origin main:main && git push origin :refs/import/batched-tmp
```

Properties and limits: each push re-runs connectivity/indexing (linear cost in number
of windows, but each within quota); force-push bumps `refs_version` per window (edge
cache thrash is fine — importer-only); repos with huge single-tree blobs still exceed
per-push quota in one window and must shrink the window; concurrent pushes hit the
lease's `503 Retry-After` (SPEC-0001 §6 T7) — the script is single-threaded. The
temporary ref is deleted at the end; a crashed run leaves `refs/import/batched-tmp` at
the last good tip, which the next run force-overwrites.

## 3. Data model

### 3.1 D1 (additions beyond SPEC-0001 §4 sketch and SPEC-0002 users/tokens)

`repositories` (fills in the sketch SPEC-0001 §4 references to 0002/0003):

| column | type / notes |
|---|---|
| `id` | integer PK autoincrement |
| `storage_key` | text unique, `'r_' || id` (immutable; all R2 + DO addressing) |
| `owner_id` | → users.id |
| `name` / `lower_name` | text; `UNIQUE(owner_id, lower_name)` — the create/rename/push-create arbitration point |
| `is_private` | bool (upstream `models/repo/repo.go:186`) |
| `default_branch` | text, default `main` |
| `is_empty`, `is_archived` | bool |
| `status` | `'ready' \| 'creating' \| 'migrating'` (+ `'broken'` reserved) — mirrors upstream `RepositoryStatus` (`models/repo/repo.go:146-149`) |
| `backend` | text default `'self-hosted'` (ADR-0001 D3 future adapter routing) |
| `refs_version` | integer — **denormalized mirror** of the authoritative DO `meta.refs_version`, updated by the Worker after each `finalizeReceive`; used only for API ETags/observability, never for cache keying (those read the DO) — documented exception to "do not duplicate state" (AGENTS.md) because the DO cannot write D1 |
| timestamps | `created_at`, `updated_at` |

`repo_redirects`: `id PK`, `owner_id`, `lower_name`, `redirect_repo_id`,
`UNIQUE(owner_id, lower_name)` — port of upstream `repo_redirect`
(`models/repo/redirect.go:27-33`).

`repo_transfer`: `id PK`, `repo_id` unique, `doer_id`, `new_owner_id`, `created_at`
(pending-transfer state; teams column deferred to 0005).

`repo_imports`: `id PK`, `repo_id`, `import_token` (random, URL-safe — chunk upload
auth without full token re-send; stored sha256-hashed like PATs, plaintext shown once
in the POST response), `state`
(`staged|indexing|finalizing|done|failed`), `manifest` (JSON: chunks, sizes,
`refs` map, head), `total_bytes`, `error`, `heartbeat_at`, `created_at`.

`repo_units` (minimal now, extended in 0005): `repo_id`, `type` (`'code'` only for
now), `anonymous_access_mode` (`none|read`) — backs ACL row #4/#5 (upstream
`RepoUnit.AnonymousAccessMode`, test `:178`).

Not modeled: upstream's `repository.num_stars/num_forks/watch` counters and issue
tables (0004/0005).

### 3.2 R2 keys (additions to SPEC-0001 §3 layout)

```
imports/<storage_key>/<import_id>/chunk-<NNNN>.pack   # uploaded chunks (presigned PUT or Worker relay)
```

Purge prefixes on delete (§2.5.5): `repos/<storage_key>/` and
`imports/<storage_key>/`. No name-derived keys exist anywhere: rename/transfer never
touch R2.

### 3.3 Durable Objects

One RepoDO per repo, `idFromName(storage_key)` (SPEC-0001 §2). Additions this SPEC:

- `meta.deleted` tombstone + `markDeleted` / `destroy` RPCs (§2.5.5).
- `imports_checkpoints(import_id PK, done_chunks, updated_at)` SQLite table +
  `importCheckpoint` / `importFinalize` RPCs; `importFinalize` reuses the
  `finalizeReceive` transaction shape (multi-ref CAS + catalog activation +
  `refs_version` bump).
- `status='creating'` handshake: `finalizeReceive` returns `first_push` so the Worker
  flips D1 status/`is_empty`/`default_branch` atomically with its post-commit D1 write
  (§2.5.2).

Queue: one consumer for purge (§2.5.5 step 3) + one for import indexing (§2.6); both
respect their own subrequest budgets and checkpoint progress for redelivery
(SPEC-0001 §6 T3 discipline).

## 4. Edge cases, limits, failure modes

| # | Case | Behavior |
|---|---|---|
| 4.1 | **Concurrent create-by-push** — two POSTs to the same nonexistent repo | Both pass the not-exists check; D1 `UNIQUE(owner_id, lower_name)` lets exactly one insert win. Loser catches the unique violation, **re-reads the row, and proceeds with a normal receive** against the now-existing empty repo (its commands are zero-id creates; the winner's in-flight push is disjoint until both finalize, where the DO lease serializes them — loser may get `503 Retry-After` per T7, which git retries). Never surface the race as an error to a legitimate same-namespace pusher. |
| 4.2 | **Push during delete** | Delete order: D1 row → DO tombstone → R2 purge → DO destroy. A push before step 1 404s at repo resolution. A push holding a lease when `markDeleted` lands: `finalizeReceive` aborts (tombstone check inside the DO transaction), staging swept, client sees sideband failure. Worst case, a finalize that raced the tombstone commits refs into a DO whose R2 packs are purged moments later — end state is still "repo gone", no dangling *reachable* state, because nothing can advertise those refs (row deleted, DO destroyed last). |
| 4.3 | **Push during rename/transfer** | Nothing: lease, staging, packs, DO are all `storage_key`-addressed; D1 reads are per-request. In-flight push completes under the new name's canonical URLs via redirect. |
| 4.4 | **`.git` suffix normalization** | Trim exactly one trailing `.git` (case-sensitive, like upstream `:96`; git clients always send lowercase). Repo names ending `.git` are reserved (`models/repo/repo.go:77`), so `/{o}/{r}.git/...` is unambiguous. A repo literally named `foo` is cloneable at both `/foo/...` and `/foo.git/...`; no redirect is emitted between them (upstream doesn't either). `.wiki` URLs: excluded — `404` (wikis are a later SPEC). |
| 4.5 | **Case sensitivity** | Owner and repo lookups are lowercased (`lower_name` columns; upstream `GetRepositoryByName`, `models/repo/repo.go:763-769`). `GET /Alice/Repo` serves `/alice/repo` with **no** redirect for git HTTP (upstream behavior); the canonical-cased name appears in API/UI surfaces only. |
| 4.6 | **gzip request bodies** | `Content-Encoding: gzip` → `DecompressionStream("gzip")` with a counting transform capped at the receive quota × small factor (default 1.1 GiB) → exceed = abort stream, `400` (upstream: unbounded `gzip.NewReader`, `400` on malformed only, `:397-405`). Malformed gzip header → `400` before any storage write. Unknown encodings: pass through (match upstream). |
| 4.7 | **Oversize push** | `Content-Length` > quota → early reject per SPEC-0001 §6 T1 (sideband fatal, no refs touched); chunked bodies abort at the quota boundary with the same sideband error. |
| 4.8 | **Recreate after delete** | New repo at the same name gets a fresh `id`/`storage_key`; old redirects are gone (deleted in §2.5.5 step 1), old clone URLs hit the new repo or 404 — never old data. In-flight purge of the old key runs concurrently; prefixes cannot collide (distinct `storage_key`). |
| 4.9 | **Import vs concurrent push** | Active import ⇒ `receive-pack` → `409` after auth (§2.6). Import on non-empty repo refused at `POST`. Push-create racing an import is impossible (import requires an existing repo). |
| 4.10 | **Orphaned staging** | receive staging: SPEC-0001 lease-expiry sweep. Import chunks: heartbeat sweep (24 h) + prefix orphan sweep for `imports/` without a D1 row. Abort paths purge their own prefixes. |
| 4.11 | **Redirect shadowing** | Rename onto a name that has a redirect: redirect deleted first (upstream `NewRedirect`, `models/repo/redirect.go:83-85`). Creating a repo at a name that is a live redirect: create succeeds and deletes the redirect (upstream: redirect rows are not in the repo namespace, `IsUsableRepoName` doesn't consult them — ported as-is). |
| 4.12 | **Trail-slash / encoding oddities** | Path traversal probes (`/objects/info/../../…`) → `404`/`400` like upstream's test (`git_smart_http_test.go:69-79`); Hono route params never contain `/`, and no route serves filesystem paths. |
| 4.13 | **HEAD probe on empty repo** | `info/refs` (v0) advertises `capabilities^{}` + `symref=HEAD:…`; `GET /HEAD` returns the unborn `ref: refs/heads/<default>` text. Neither triggers engine errors. |
| 4.14 | **Credential quality** | Bad token (unknown) → `401` (challenge, identity not established); known token lacking scope → `403` (§2.4 rows 7/9 split). SPEC-0002 owns the mechanics; the matrix here pins the mapping. |

## 5. Testing plan

Unit/worker tests (`@cloudflare/vitest-pool-workers`, real local D1/DO):

- Route table + normalization: `.git` suffix, case-insensitive owner/repo, `go-get`,
  unknown service `400`, missing Content-Type `400`, bad `Git-Protocol` header dropped.
- ACL matrix §2.4 as a table-driven test (all 20 rows, asserting status + bodies +
  `WWW-Authenticate` presence/absence).
- Error mapping: lease `503`+`Retry-After`, `oldOid` mismatch → sideband `fetch first`,
  gzip-cap abort, tombstoned finalize.
- Lifecycle: create/push-create D1 state transitions incl. `status='creating'` crash
  recovery; rename redirect insert/delete/shadow rules; transfer shadow + visibility
  flip; delete ordering (row → tombstone → queue message), recreate-with-fresh-key.
- Import state machine: per-chunk checkpoint, resume-after-failure, abort purge,
  heartbeat timeout, `409` on concurrent receive.

E2e with real git clients (extends the SPEC-0001 §6 checklist; black-box via HTTPS):

1. Anonymous clone of a public repo; `401`+challenge then token clone of a private one.
2. Push-create: `git push` to a nonexistent own-namespace URL → creates repo, `git ls-remote` shows the branch; wrong-namespace push-create → `404`; disabled flag → `403`.
3. Rename: clone via old URL → `301` → clone succeeds (assert git client follows); push via old URL works post-rename.
4. Transfer: clone via old owner URL post-transfer; anonymous access drops per new owner visibility.
5. Delete: push racing delete → clean client-side failure; clone post-delete → `404`; recreate same name → empty repo, `git fsck` clean after first push.
6. Archived repo push → `403` with upstream message text; clone still works.
7. First-push default branch: push `trunk` first → `git clone` checks out `trunk`, `HEAD` endpoint agrees.
8. Chunked import: split a >1 GiB fixture into ~512 MiB packs, run the channel, kill the consumer after chunk 2 → resume → done; verify `git clone` + `git fsck` + `git rev-list --count` equal the source; concurrent push during import → `409`.
9. Batched-push fallback script on a 5 GiB fixture → `git fsck` clean, ref deleted afterwards.
10. Protocol: v0 clone, v2 (`Git-Protocol: version=2`) fetch, shallow + unshallow, thin push, force push, atomic multi-ref, ref delete, `capabilities^{}` empty-repo clone — each × {anonymous, token-read, token-write} where applicable.
11. Conformance: port upstream `tests/integration/git_smart_http_test.go` expectations (status codes, `ERR wiki…` shape for the excluded-wiki case, redirect-before-401 ordering) as an automated diff.

Benchmark note: none here beyond SPEC-0001 §9 — this SPEC adds no data-plane work; the
gate adapter must add < one event-loop pass per chunk (verified by the T3/T4
instrumentation already in CI).

## 6. Open questions (resolve at implementation)

- R2 presigned URLs from the binding (`createPresignedUrl`) — availability/stability at
  implementation time decides §2.6's presigned vs relayed-chunk default; the protocol
  keeps both behind the same manifest.
- Do we serve upstream's exact plain-text error bodies (e.g. "Repository not found\n")
  or generic text? Default: copy upstream strings (some scripts grep them), revisit if
  any leak policy-sensitive wording.
- Import channel for *external* URLs (upstream migrate) — needs outbound fetch of
  arbitrary git remotes; deferred, the chunk protocol already covers the data path.
- Whether `409` vs `503` is friendlier for receive-during-import, given stock git
  retries `503` but surfaces `409` immediately. Default `409`: an operator is mid-import;
  silent retry loops would hide it.

## Milestones

M1 route table + adapter + ACL matrix (rows 1–14) over a stubbed engine · M2 lifecycle
(create/rename/transfer/delete + redirects) with D1 migrations · M3 push-create end-to-end ·
M4 delete purge queue + tombstones · M5 import channel (presign → checkpoint → finalize) +
scripts · M6 e2e/conformance suite green.
