# Parity review — git smart-HTTP + LFS wire behavior vs upstream Gitea

READ-ONLY parity review, 2026-10-30. Upstream pin: `fc49368845` (the vendored
`gitea/` submodule; version banner "29.0.0+dev"). Subject: our adapter
(`apps/worker/src/git-http/**`, `apps/worker/src/lfs/router.ts`,
`apps/worker/src/services/lfs/**`, the `gitHttpGate` pipeline, and the
`/archive` web family) vs upstream (`routers/web/githttp.go`,
`routers/web/repo/githttp.go`, `routers/common/lfs.go`, `services/lfs/`,
`services/context/`, `models/repo/archiver.go`, `modules/git/archive.go`).

Scope note: the vendored engine (`packages/git-engine`) is a given. Where the
wire bytes are produced by the engine and merely forwarded by the adapter,
findings are marked **[engine-scope]** — recorded because they are
wire-visible to every client, but not adapter fixes. The raw/media LFS
resolution divergence is already documented elsewhere and skipped per brief.

Method: source-level comparison against the pin, cross-checked empirically
where cheap (real `git 2.43.0` `upload-pack`/`receive-pack --advertise-refs`
runs for the empty-repo advertisement bytes; the vendored UI's archive JS
read directly). Nothing was fixed or committed.

---

## 0. Verdict

The adapter is a faithful port of upstream's wire contract, and visibly built
from upstream's source line-by-line (error strings, header sets, ordering
comments, and upstream bug-compatible quirks are ported verbatim). The
four-route smart-HTTP surface, the ACL ladder's 401/403/404 semantics, the
LFS batch/upload/verify/download envelopes, and the archive GET surface are
**aligned** with upstream at the pin. The drifts found are concentrated in:

1. the archive **POST** half (InitiateDownload) — breaks the vendored web
   UI's archive button (the one HIGH finding);
2. capability-set gaps in the engine's advertisements (`--atomic`,
   `push-options`, protocol-v2 `filter`/`unborn`) — **[engine-scope]**;
3. `.gitattributes` export rules absent from archive building;
4. a family of **ordering** drifts where upstream decides a check before
   auth and we decide after (or vice versa) — same texts, different status
   codes on some anonymous requests.

| # | Severity | Surface | Drift |
|---|----------|---------|-------|
| D1 | **HIGH** | archive | `POST /{owner}/{repo}/archive/*` not answered with `{"complete":true}` — vendored UI archive button fails (§7.5) |
| D2 | MEDIUM | receive-pack | `atomic` / `push-options` / `report-status-v2` not advertised — `git push --atomic` fails client-side **[engine-scope]** (§2.3) |
| D3 | MEDIUM | archive | `.gitattributes` `export-ignore`/`export-subst` not honored; zip is STORE (uncompressed) (§7.3–7.4) |
| D4 | MEDIUM | auth | 401 realm is always `Gitea` with no OAuth2 behind it → GCM attempts a doomed OAuth2 flow (§3.4); no password Basic auth (documented deferral) |
| D5 | MEDIUM | LFS | locks family answers 501 (upstream implements it) (§5.6) |
| D6 | LOW-MED | protocol v2 | `ls-refs=unborn`, `fetch=filter/wait-for-done`, `server-option`, `object-format` missing **[engine-scope]** (§1.4) |
| D7 | LOW | ladder | status-order drifts: archived/owner-prohibited/redirect/content-type/batch-cap vs auth ordering (§3.3) |
| D8 | LOW | wiki | uninitialized wiki advertises an empty repo; upstream answers the `ERR wiki doesn't exist…` pkt-line (§1.5) |
| D9 | LOW | dumb HTTP | `/objects/**`, `/objects/info/packs`, `git-upload-archive`, service-less `/info/refs` not served (§1.6, §2.4) |
| D10 | LOW | advertisement | `Expires`/`Pragma` missing from `info/refs` responses (only `cache-control: no-cache`) **[engine-scope]** (§1.3) |

---

## 1. `GET /info/refs` — the advertisement

### 1.1 Routing, service parse, protocol strings — **Aligned**

- Route set: upstream registers `GET,OPTIONS /info/refs`
  (`routers/web/githttp.go:16`) under `/{username}/{reponame}`; the gate
  claims `info/refs` per `parse.ts:46-82` with the same `.git`-suffix trim
  (upstream `strings.TrimSuffix`, `githttp.go:96`), per-segment decode, and
  the `.wiki` strip (upstream `githttp.go:94-101`; our
  `splitWikiRepoName`, `parse.ts:193-197`).
- Unknown/missing `service` → bare 400 no body: upstream
  `githttp.go:82-84` (`ctx.Resp.WriteHeader(400)`); ours `infoRefsOp` +
  `bareBadRequest` (`parse.ts:208-213`, `respond.ts:162-164`). Byte-identical.
  - Sub-difference: a **missing** service (`/info/refs` with no `?service=`)
    is upstream's dumb-HTTP arm (`githttp.go:472-481`), not the 400 — see
    §1.6/D9. The 400 is correct only for an *unknown* service value.
- `?go-get=1` short-circuit before auth and existence: upstream
  `githttp.go:63-66` → `EarlyResponseForGoGetMeta`
  (`services/context/repo.go:406-417`); ours `gate.ts:180-182` →
  `goGetMeta` (`respond.ts:182-189`). Same plain-text 200, single
  `<meta name="go-import" …>` line, HTML-escaped content, import =
  `<host>/<owner>/<repo>`, clone = `<origin>/<owner>/<repo>.git`
  (upstream `ComposeGoGetImport`/`ComposeHTTPSCloneURL`,
  `models/repo/repo.go:613-614`). **Aligned** — including the divergence
  that ours serves it only on `info/refs`, while upstream's httpBase answers
  go-get on *every* git route (negligible: go-get tooling only requests
  `info/refs`).
- Advertisement content-type: `application/x-git-<service>-advertisement`
  both sides (upstream `githttp.go:490`; engine `repo.ts:666-667`, forwarded
  gate-cleared).
- `# service=git-<service>` pkt-line + flush + ref data: identical framing
  (upstream `pktLineWriteText`/`pktLineWriteFlush`, `githttp.go:439-459,518-520`;
  engine `protocol.ts:76-83`; upstream counts the appended `\n` in the
  pkt-line length — the engine's `pkt()` takes the already-terminated
  string; same bytes).
- 301 redirect before any auth for a renamed repo: upstream
  `githttp.go:117-122` → `RedirectToRepo` forces 301 *for git clients*
  (`services/context/repo.go:439-441`, tail + query preserved); ours
  `gate.ts:204-205` → `redirectPermanent` (`respond.ts:84-105`), 301,
  `.git` suffix + tail + query preserved. **Aligned** (upstream's test
  comment `tests/integration/git_smart_http_test.go:139` is cited in our
  `respond.ts`).

### 1.2 Empty-repo / unborn-HEAD advertisement — **Aligned (v0)**

Empirically verified against real git 2.43: an empty repo's v0
`upload-pack --advertise-refs` is `<zero-oid> capabilities^{}` + caps +
flush — exactly what the engine emits (`protocol.ts:84-87`), and the same
shape our `dummyAdvertisement` hand-renders for push-create
(`respond.ts:144-155`, caps matched to the engine's real receive set — a
consistency upstream gets for free by running the real binary,
`githttp.go:268-300`). `symref=HEAD:<head>` is advertised even when unborn
(engine `protocol.ts:70`, `store.head()` defaults `refs/heads/main`), like
real git. The production e2e (docs/usability/findings-git-e2e.md §2)
confirms: empty clone warns and lands on unborn `main`.

### 1.3 Cache headers on the advertisement — **Divergence, LOW [engine-scope]**

Upstream `GetInfoRefs` runs `setHeaderNoCache` (`githttp.go:317-321,470`):
`Expires: Fri, 01 Jan 1980…`, `Pragma: no-cache`,
`Cache-Control: no-cache, max-age=0, must-revalidate`. The engine answers
with only `cache-control: no-cache` (`repo.ts:666-668`) and the gate
forwards it. `respond.ts` carries the full triple (`NO_CACHE_HEADERS`) for
the responses the adapter itself builds (HEAD file, dummy advert) — the
engine-built advertisement is the gap. No modern client caches these, but
a corporate proxy honoring only `Expires` could cache a ref advertisement.

### 1.4 Protocol v2 capability strings — **Divergence, LOW-MEDIUM [engine-scope]**

The adapter's part is correct: `SAFE_GIT_PROTOCOL_HEADER` is upstream's
exact regex (`githttp.go:339-341` vs `parse.ts:227`), invalid `Git-Protocol`
headers are dropped, valid ones reach the engine
(`prepareEngineRequest`, `gate.ts:919-951`), and the engine negotiates v2
for upload-pack (`repo.ts:664`). The engine's v2 capability block
(`protocol.ts:61`) is `version 2`, agent, `ls-refs`, `fetch=shallow` — real
git also sends `ls-refs=unborn`, `fetch=shallow wait-for-done`,
`server-option`, `object-format=sha1` (verified empirically):

- `ls-refs=unborn` missing → a v2 client cannot learn the default branch of
  an **empty** repo (v0 still carries it via `symref=`; production e2e
  observed `main` on empty clone, so impact is not currently realized).
- `fetch=filter` missing → `git clone --filter=blob:none` /
  `--depth`+partial-clone CI patterns fail outright ("filter capability not
  supported") — the largest v2 gap for CI-type clients.
- `object-format` missing → clients assume sha1; harmless today.

### 1.5 Existing row, missing/empty storage (wiki case) — **Divergence, LOW**

Upstream answers a storage-less repo's `info/refs` with **200 + an `ERR`
pkt-line** ("repository doesn't exist" / wiki variant, `githttp.go:492-507`),
which git surfaces as a friendly fatal message. Ours: a D1-resolved repo
always has a seeded engine cell, so the reachable case is the **uninitialized
wiki**: `handleWikiGitRoute` seeds the registry row on reads
(`gate.ts:473`, `ensureWikiRegistryRow`) and the client gets an *empty*
advertisement (clone of `x.wiki.git` succeeds as an empty repo) where
upstream errors with "wiki doesn't exist, please initialize the wiki by
creating a new page first". Behavioral, not protocol-correctness: low.

### 1.6 Dumb-HTTP family — **Divergence, LOW (documented)**

Upstream also serves `GET /HEAD`, `/objects/info/packs`,
`/objects/info/{file}`, `/objects/{xx}/{hash…}`, `/objects/pack/*.pack|.idx`
(`routers/web/githttp.go:17-24`) with `setHeaderNoCache`/`CacheForever`. The
gate claims only the four smart routes; everything else passes to the
headless engine's 404. No modern git falls back to dumb HTTP unless smart
fails once. The `text/plain; charset=utf-8` service-less listing
(`githttp.go:472-481`) is the same family. Documented in SPEC-0003 §2.2.

### 1.7 Ref advertisement order, peeled tags — **Aligned / cosmetic gap [engine-scope]**

Upstream advertises HEAD first, then refs in the ref-backend's sorted order;
peeled annotated tags appear inline as `refs/tags/v1^{}` lines. Engine:
HEAD first, `ORDER BY name` (`store.ts:507-516`), no inline `^{}` peel
lines (peeled targets are validated server-side for wants instead,
`protocol.ts:93-111`). Order matches; missing `^{}` lines are cosmetic
(clients peel locally; `include-tag` is not advertised either side needs
it for). No client-visible failure observed.

---

## 2. `POST /git-upload-pack` / `POST /git-receive-pack`

### 2.1 Content types and framing — **Aligned**

- Request content-type must be exactly `application/x-git-<service>-request`
  → bare 400: upstream `githttp.go:376-381`; ours `gate.ts:244-247` +
  `rpcRequestContentType` (`parse.ts:218-220`). Byte-identical.
- Response content-type `application/x-git-<service>-result`: upstream
  `githttp.go:393`; engine `protocol.ts:190,775` (upload) and `mod.ts:1293`
  (receive). **Aligned.**
- `Content-Encoding: gzip` — upstream special-cases exactly `"gzip"`
  (`githttp.go:397-405`, malformed → 400); ours trims/lowercases before
  comparing (`parse.ts:230-232`) and decompresses with a cap +
  verified-start, mapping malformed input to the same bare 400
  (`gate.ts:932-945`, `gzip.ts`). Slightly more lenient accept; identical
  failure code. **Aligned.**
- Streaming: both sides stream request and response bodies; no
  `arrayBuffer()` on the pack path (gate `forwardToEngine` passthrough,
  `gate.ts:924`).

### 2.2 Auth-before-content-type ordering — **Divergence, LOW (see §3.3)**

Upstream runs httpBase (full auth) *before* the content-type check
(`serviceRPC`: `githttp.go:371-381`) — an anonymous POST with a wrong
content-type gets **401**; ours checks content-type first → **400**
(`gate.ts:244`). Same for the missing-service 400 vs upstream's auth-first
ladder. Text/status bodies identical once authenticated.

### 2.3 Receive capabilities (`report-status`, `atomic`, `push-options`) — **Divergence, MEDIUM [engine-scope]**

Engine receive caps: `report-status delete-refs ofs-delta side-band-64k
agent=dgit/0.3` (`protocol.ts:71-72`; mirrored exactly in
`dummyAdvertisement`). Real git receive-pack additionally advertises
`report-status-v2`, `quiet`, **`atomic`**, **`push-options`**,
`object-format=sha1`. Consequences with real clients:

- `git push --atomic` → client-side fatal "the receiving end does not
  support --atomic push" (hard failure; some CI pipelines push
  branch+tag atomically);
- `git push --push-option=…` → same class of failure (Gitea/CI workflows
  using push options);
- verdict rejections render as `ng` report-status lines
  (`gate.ts:1038-1052` texts = upstream hook texts) — aligned where it
  exists.

### 2.4 `POST /git-upload-archive` — **Absent, LOW**

Upstream serves the git `upload-archive` service (`routers/web/githttp.go:15`,
`githttp.go:435-437`, allowed in `serviceRPC`) — i.e. `git archive
--remote=https://…`. The gate does not claim the route; the headless engine
404s it pre-auth. Rare client feature; recorded as D9.

---

## 3. The auth ladder (Basic / PAT / token precedence; 401 vs 403)

### 3.1 Credential parsing and precedence — **Aligned**

- Header parsing is a stated port of `modules/auth/httpauth`
  (`httpauth.ts`): case-insensitive schemes, `token`/`bearer` bearer form,
  Basic with token-as-password; the token candidate applies upstream's
  Basic forms — username-is-token when password is empty or
  `x-oauth-basic` (upstream `services/auth/basic.go:44-68`; ours
  `basicAuthTokenCandidate`, `httpauth.ts:79-82`). `Authorization: token
  <sha>` (PAT header form) accepted both sides.
- Not implemented (upstream has them): real-password Basic sign-in
  (SPEC-0002 §4.6.7 deferral) and OAuth2 — a **valid** upstream
  username/password pair authenticates git-HTTP; ours 401s. Upstream's 2FA
  401 arm (`githttp.go:168-178`) has no live counterpart because passwords
  never authenticate (N/A, not a drift in behavior for token clients).

### 3.2 Status codes and texts — **Aligned**

| Condition | Upstream | Ours |
|---|---|---|
| Anonymous, not anonymous-readable | 401 + `WWW-Authenticate` (`githttp.go:149-160`) | 401 + challenge (`acl.ts:284-289` → `basicChallenge`) |
| Invalid/expired/revoked credential | auth chain fails → 401 challenge | 401 challenge + limiter failure record (`acl.ts:187-192`) |
| Token lacking `read:`/`write:repository` scope | `CheckRepoScopedToken` → `HTTPError(403)` (`githttp.go:163-166`, `permission.go:16-31`) → plain "Forbidden\n" | `scopeForbidden()` = plain `403 "Forbidden\n"`, no `WWW-Authenticate` (`respond.ts:48-50`) |
| Prohibited doer | 403 "Your account is disabled." (`githttp.go:180-183`) | `accountDisabled()` identical text (`respond.ts:52-55`) |
| Prohibited owner | 403 "Repository cannot be accessed. …" (`githttp.go:103-107`) | `ownerUnavailable()` identical text (`respond.ts:57-60`) |
| Push to archived | 403 "This repo is archived. …" (`githttp.go:124-128`) | `repositoryArchived()` identical text (`respond.ts:62-66`) |
| Push to mirror | 403 "mirror repository is read-only" (`githttp.go:202-205`) | identical (`gate.ts:272-277`) |
| No read grant on invisible repo | 404 "Repository not found" (`githttp.go:197-200`) | `repositoryNotFound()` identical (`respond.ts:38-41`) |
| Write-visible-but-unauthorized | 404 (same mask) | 404 (`acl.ts:338`) |
| Failure-limited | (no upstream equivalent) | 403 + `Retry-After` (SPEC-0002 §2.7, additive) |

Anonymous-read computation matches upstream's two arms: public repo + public
owner (`githttp.go:132-136`), then the anonymous *unit* permission arm
(`githttp.go:138-145` → our `codeUnitAnonymousRead`, `acl.ts:99-107`).
Write-always-needs-identity matches (anonymous write → challenge,
`acl.ts:288`). Wiki pushes keep write checks (upstream
`githttp.go:186-189`); wiki reads use the parent — with the documented gap
that private-parent anonymous wiki read needs a wiki-unit row we don't
model (`gate.ts:335-352`, deliberate).

### 3.3 Ordering drifts inside the ladder — **Divergence, LOW (D7)**

Same decisions, different position in the pipeline; each changes the status
an anonymous or malformed request observes:

1. **Archived repo, anonymous push**: upstream 403-archived *before* the
   401 challenge (`githttp.go:124-128` precedes the ladder); ours 401
   first (archived is decided inside `decide`, `acl.ts:332`). Git clients
   prompt for credentials before reporting the archived refusal.
2. **Prohibited owner**: upstream 403 before repo lookup, redirect, and
   auth (`githttp.go:103-107`); ours after token verify/scope
   (`acl.ts:301`), and a renamed repo under a prohibited owner 301s first
   (`gate.ts:204`) where upstream 403s.
3. **Content-type/service 400 vs auth** (§2.2).
4. **LFS batch cap vs auth** (§5.2).
5. `?go-get=1` answered on `info/refs` only; upstream answers on all four
   git routes (`githttp.go:63`).

None of these breaks a credential-carrying client; they change what
*anonymous probing* observes.

### 3.4 401 realm — **Divergence, MEDIUM (documented; D4)**

Upstream picks the realm by OAuth2 enablement: `Basic realm="Gitea"` (GCM's
signal to attempt its built-in OAuth2 application) only when OAuth2 is on;
otherwise `Basic realm="Gitea (Basic Auth)"` specifically to *avoid* the
GCM OAuth2 attempt (`githttp.go:152-158`). Ours always sends
`realm="Gitea"` (`respond.ts:34-36`; SPEC-0002 §2.6 pins it) with no
OAuth2 endpoints behind it, and no password auth either. A Git Credential
Manager user's first attempt runs a doomed OAuth2 flow, then basic prompts
fail (no password path) until they mint a PAT. The LFS surface uses
upstream's `realm="gitea-lfs"` correctly (§5.1).

---

## 4. Clone of empty repos / HEAD file

- **Unborn advertisement**: §1.2 — v0 aligned byte-for-byte; v2 hint gap
  D6. HEAD-file endpoint: upstream serves the on-disk `HEAD` file,
  `text/plain` + no-cache triple (`routers/web/githttp.go:17`,
  `githttp.go:524-537`); ours synthesizes `ref: refs/heads/<head>` from the
  engine's resolution with the D1 `default_branch` unborn fallback, same
  content type + triple (`gate.ts:215-231,1182-1191`,
  `respond.ts:195-200`). **Aligned.**
- **First push settles `is_empty`/`default_branch`** like upstream's
  `pushNewBranch` (`services/repository/push.go:255-270`), including the
  tag-only arm leaving the repo empty-unborn (`gate.ts:1193-1369`). Behind
  the wire; supports the clone posture. **Aligned.**
- Push-create probe on a missing repo serves the dummy receive
  advertisement for GET (`gate.ts:635`, `respond.ts:144-155`) = upstream's
  `dummyInfoRefs` (`githttp.go:229-233,268-300`). Caps are the engine's
  (so no `atomic`, consistent with §2.3). **Aligned** shape.

---

## 5. LFS (`/{owner}/{repo}(.git)?/info/lfs/*`)

### 5.1 Route family, error shapes, challenge — **Aligned**

Registration set matches upstream's table exactly (`routers/common/lfs.go:
14-31` vs `parseLfsRoute`, `router.ts:138-194`): POST `objects/batch`, PUT
`objects/{oid}/{size}`, GET `objects/{oid}` and `objects/{oid}/{filename}`,
POST `verify`, `locks/*`, and the `m.Any("/*", NotFound)` catch-all — ours
renders the stdlib plain-text `404 page not found` (`lfsNotFound`,
`router.ts:247-252`), not the LFS JSON envelope, exactly like upstream.
Method mismatches fall to the catch-all both sides (e.g. POST
`objects/{oid}` → 404). Error envelope `{"message": <status text>}` with
`application/vnd.git-lfs+json` (`writeStatusMessage`, `server.go:530-540`
vs `lfsError`, `router.ts:227-232`), success `{"message":"OK"}\n`
(`writeStatus(200)` vs `lfsError(200)`), the 401 challenge
`WWW-Authenticate: Basic realm="gitea-lfs"` + JSON body
(`server.go:632-635` vs `lfsChallenge`). Media type and the verify
workaround Accept header byte-identical (`modules/lfs/shared.go:16-18` vs
`batch.ts:28,33`). **Aligned.**

### 5.2 Batch API — **Aligned with three deliberate divergences**

- Order: 415 accept check → decode 400 ("Bad Request") → unknown operation
  400 → (auth) → per-object 200 envelope, object errors never fail the
  request: upstream `server.go:104-112,192-303`; ours `handleBatch`
  (`router.ts:494-542`) + `parseBatchRequest` (`batch.ts:114-170`).
  Per-object error strings verbatim: 422 "Oid or size are invalid", 422
  "Object <oid> is not <size> bytes", 422 "Size must be less than or equal
  to <max>", 404 "Not Found" (`server.go:230-291` vs `batch.ts:272-316`).
- Href shapes: relay base `<origin>/<owner>/<repo>.git/info/lfs`
  (`getRequestContext`/`RepoGitURL`, `server.go:429-438` vs
  `buildRelayHrefBase`, `batch.ts:213-215`); download
  `…/objects/{oid}`, upload `…/objects/{oid}/{size}`, verify `…/verify`
  (`server.go:89-101` vs `batch.ts:217-227`); `Authorization` echoed into
  relay links, omitted when empty (`Link.WithHeader` skip-empty vs
  `withAuth`, `batch.ts:233-235`); verify link carries the legacy Accept
  workaround (`server.go:516-520`). Presigned (ServeDirect-style) links
  carry no Authorization, with `expires_at`/`expires_in` wire names. 
  **Aligned.**
- Already-present upload → empty actions map `{}` (client skips transfer):
  `server.go:280` / git-lfs tq vs `batch.ts:296-303`. Cross-repo
  proof-of-possession tightening (bytes present but unlinked → require
  re-upload) matches upstream's own 2024 hardening (`server.go:261-270`),
  repo-scoped instead of global — strictly safer. **Aligned.**
- Divergence 1 (documented, LOW): `MaxBatchSize` is checked **before**
  auth in ours (`parseBatchRequest` in `handleBatch`), upstream checks
  after (`server.go:219-222`); an oversized anonymous batch gets 413 where
  upstream 401-challenges. Also the 10 MiB body cap (upstream unbounded) —
  hardening, same 413.
- Divergence 2 (documented, LOW): upstream hints `Transfer-Encoding:
  chunked` on upload links (`server.go:510-515`) so git-lfs may send
  unknown-length bodies; ours drops the hint because the relay PUT
  requires `Content-Length` (411 otherwise) — `batch.ts:329-336`,
  documented, verified end-to-end.
- Divergence 3 (deliberate extension, LOW): verify **adopts** a missing
  meta row when the bytes prove themselves (state-machine §3.3 self-heal);
  upstream verify 404s without a meta row (`server.go:440-460`) — ours is
  more forgiving after a lost batch write; upload/verify both flip
  `uploading → verified` like upstream's `NewLFSMetaObject` at PUT time.
- Added (not upstream): per-repo quota 422 "LFS quota exceeded for
  repository" (`batch.ts:314-316`), additive object-level error.
- 404-before-auth for a nonexistent repo: upstream looks the repo up
  first (`server.go:462-468`); ours resolves via the gate's D1 pipeline and
  D1-missing repos pass through to the engine (transitional population).
  Net wire behavior for D1-backed repos is the same statuses.

### 5.3 Upload verb — **Aligned**

PUT `objects/{oid}/{size}`: pointer-from-path validation → 422 (upstream
`server.go:306-321`; note upstream's missing-`return` bug after the size
parse 422 is not ported — ours answers one 422), auth (write), size-proof:
bytes present + linked + size-agreeing skip the body check; otherwise a
single-pass hash-and-forward put proves `sha256(content) == oid` and
deletes on mismatch → 422 with upstream's mismatch texts
(`router.ts:571-628`; upstream `uploadOrVerify`, `server.go:326-371`).
**Aligned** (modulo the 411-for-missing-Content-Length above).

### 5.4 Download verb — **Aligned (bug-compatible)**

Range parsing replicates upstream's regex and its quirks —
`bytes=(\d+)-(\d*).*`, 416 when `from >= size`, end accepted only when
`candidate >= from && candidate < size-1` (so `bytes=0-<size-1>` is
ignored and serves the full tail — upstream's exact behavior,
`server.go:114,130-151` vs `parseRange`, `router.ts:698-711`); 206 +
`Content-Range` + `Access-Control-Expose-Headers: Content-Range`;
`Content-Length` = `X-Gitea-LFS-Content-Length` = served length
(`server.go:170-174`); `Content-Type: application/octet-stream`;
`Content-Disposition` from the base64url `{filename}` segment with
decode-failure ⇒ param ignored (`server.go:176-183` vs
`decodeFilenameSegment`/`contentDisposition`, RFC 5987 form for non-ascii
matching `EncodeContentDispositionAttachment`). Row-missing → JSON 404
("Not Found"). **Aligned.**

### 5.5 Batch auth outcomes — **Documented divergence, LOW**

Upstream's LFS routes **challenge (401 + gitea-lfs)** where git-HTTP
404-masks an unauthorized-visible repo (`server.go:470-473` + the
`authenticate` false arm); ours mirrors that deliberately
(`authorizeLfs`, `router.ts:268-368`, SPEC-0006 §2.2 note) — the 404-mask
is *not* carried over from §3.2. Scope 403, disabled 403, owner 403,
archived-write 403, public-only-token masking: all present and shaped as
in §3.2. **Aligned with the documented 401-vs-404 difference.**

### 5.6 Locks — **Divergence, MEDIUM (D5)**

Upstream implements the git-lfs locks API (list/create/verify/unlock,
`services/lfs/locks.go`, routes `routers/common/lfs.go:22-27`) — including
its quirky 401-with-"You must have pull access to list locks" bodies. Ours
answers every `info/lfs/locks*` request with a plain **501**
(`router.ts:432`), pre-auth, documented as P2. `git lfs lock`/`locks`
users get a hard capability error; push/pull/LFS-transfer flows never
touch locks, so no data path is affected.

---

## 6. Raw/media semantics

Skipped per brief (documented divergence: `raw` does not LFS-resolve).

---

## 7. Archives (`/{owner}/{repo}/archive/{ref}.{zip|tar.gz|bundle}`)

### 7.1 Paths and parsing — **Aligned**

Suffix split order `.zip` / `.tar.gz` / `.bundle`, unknown suffix → 400
"unknown format: …" plain text (`models/repo/archiver.go:52-63` vs
`parseArchiveName`, `archive.ts:61-66`; web handler classes
`routers/web/repo/repo.go:352-374` vs `archive-files.ts:120-163`); ref
resolution branch → tag(peeled) → 40-hex, else 404 "unrecognized
repository reference: …" (`archiver.go:86-100` vs `resolveArchiveRef`,
`archive.ts:84-91`); `?path=` subpath filter; the bare `/archive` tail
claims the 400 arm like chi's `/*`; empty repo → the MustBeNotEmpty 404
(`web.go:1692`). **Aligned.**

Sub-differences (LOW):
- **Short SHAs**: upstream resolves via `GetCommit` → `ConvertToGitID`
  (short hashes work); ours requires the full 40-hex. A user copying a
  7-char sha into an archive URL gets a 404.
- **`.bundle`**: upstream streams a real git bundle (third format);
  ours parses it then refuses with the 400 class — documented
  (`archive.ts:56-64,380-382`).

### 7.2 Response header matrix — **Aligned**

`application/octet-stream` + `nosniff` for both formats (upstream's
ServeSetHeaders empty-ContentType arm), attachment disposition
`{slug}-{ref-with-dashes}.{ext}`, Nix immutable `Link` header keyed by the
resolved commit oid, weak ETag `W/"{oid}-{fmt}-true"`, If-None-Match → 304
with `private, max-age=21600`, 200 `Cache-Control: max-age=0, private,
must-revalidate` (the overwrite-order subtlety is reproduced knowingly —
`archive-files.ts:165-234`). **Aligned.**

### 7.3 `.gitattributes` export rules — **Divergence, MEDIUM (D3)**

Upstream archives are produced by the real `git archive`
(`modules/git/archive.go:26-37`), which honors `export-ignore` and
`export-subst` from `.gitattributes` (in any tree directory). Ours walks
the full tree and includes every blob (`collectArchiveEntries`) with no
attribute evaluation. Repos that use `export-ignore` (excluding tests,
CI configs, fixtures from source archives) get those files in our
archives — content-visible difference for every archive consumer.

### 7.4 Compression and layout — **Divergence, LOW**

zip entries are **STORE** (method 0 — CPU-for-bytes trade, documented
SPEC-0004 posture) where `git archive --format=zip` deflates; downloads
are correspondingly larger (256 MiB total-bytes cap bounds it). No zip
directory entries; tar entries use ustar with the commit's committer time
(upstream: same mtime source), prefix lowercased like
`PrefixArchiveFiles` default (`archive.go:27-29`). Unpackers don't care;
only size/bytes differ.

### 7.5 `POST /archive/*` (InitiateDownload) — **Divergence, HIGH (D1)**

Upstream registers `m.Post("/*", repo.InitiateDownload)` beside the GET
(`web.go:1689-1690`); with `StreamArchives` defaulting true
(`modules/setting/repository.go:159`) it answers **200 JSON
`{"complete":true}`** unconditionally (`repo.go:381-392`). The vendored
UI's archive button POSTs the archive link first and requires
`response.ok` + `complete:true` before `window.location.assign` on the GET
(`gitea/web_src/js/features/repo-common.ts:12-33`). Ours registers GET
only (`ui/index.ts:15204-15205`; the POST half "stays engine-owned",
`ui/index.ts:5431-5432`), and neither the ui router nor the engine answers
`{"complete":true}` — the POST 404s, the button shows the
"Failed to download the archive" toast, and **no download starts**, for
every viewer of every non-empty repo. Direct GET URLs (curl/wget/API)
work; the web UI path is broken. This is the review's one HIGH finding.

---

## 8. Top drifts, ranked by real-client impact

1. **D1 — Web UI archive button broken** (HIGH; every web user): POST
   `/archive/*` must answer `{"complete":true}`; today it 404s and the
   vendored UI aborts before the GET. (§7.5)
2. **D2 — `git push --atomic` / `--push-option` fail** (MEDIUM; CI,
   release automation): receive-pack advertisement lacks the
   capabilities; client-side hard failure. [engine-scope] (§2.3)
3. **D3 — `export-ignore`/`export-subst` ignored in archives** (MEDIUM;
   archive consumers): archives carry files upstream excludes. (§7.3)
4. **D4 — GCM hostile realm posture** (MEDIUM; new contributors on
   Windows/macOS): `realm="Gitea"` triggers GCM's OAuth2 attempt with no
   OAuth2 and no password fallback — confusing loop until a PAT exists.
   Upstream avoids this deliberately when OAuth2 is off. (§3.4)
5. **D5 — LFS locks 501** (MEDIUM; teams using file locking): honest
   capability signal, but a hard error for `git lfs lock` users. (§5.6)
6. **D6 — protocol-v2 gaps** (LOW-MEDIUM; partial-clone CI): no
   `fetch=filter` (partial clone fatal), no `ls-refs=unborn` (empty-repo
   default-branch hint lost over v2). [engine-scope] (§1.4)
7. **D7 — ladder ordering drifts** (LOW; anonymous probes and error UX):
   archived-403-vs-401, owner-prohibited-before-redirect/auth,
   content-type-400-before-auth, batch-cap-before-auth. (§3.3, §2.2)
8. **D8 — uninitialized wiki clones as an empty repo** (LOW): upstream's
   friendly `ERR wiki doesn't exist…` pkt-line absent. (§1.5)
9. **D9 — dumb-HTTP + upload-archive absent** (LOW; legacy/rare clients).
   (§1.6, §2.4)
10. **D10 — advertisement cache triple incomplete** (LOW; proxy edge).
    [engine-scope] (§1.3)

Also recorded (INFO): D1-missing read 404 body is the engine's
`repository not found: <name>\n` vs upstream's `Repository not found`
(git's own "repository … not found" message masks it); upload-pack v0
capability set is narrower than git's (`thin-pack`, `include-tag`,
`ofs-delta`, `side-band`, `multi_ack`, `deepen-*` absent — all
optional-to-negotiate, no observed client failure) [engine-scope].

---

## 9. What is byte-level aligned (for the record)

401 challenge shape and texts; 403/404 texts and their no-WWW-Authenticate
rule; bare 400s (unknown service, content-type mismatch, malformed gzip);
301 redirect semantics incl. tail/query/`.git` preservation and
before-auth ordering; go-get meta line; empty-repo v0 advertisement bytes
(empirically matched to git 2.43); HEAD file shape; dummy push-create
advertisement; LFS media types, accept checks, envelope bodies, all four
batch/upload/verify/download href shapes, the Authorization-echo and
skip-empty rule, Range semantics including upstream's off-by-one quirks,
`X-Gitea-LFS-Content-Length`, content-disposition encoding; archive 400 /
404 classes, ETag/304/Link/cache matrix, archive naming; failure-limiter
behavior as an additive extra that never changes a parity outcome.
