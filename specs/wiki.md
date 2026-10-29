# SPEC: Repository Wiki API (batch 10 — `wave-api-wiki`)

Status: implemented (this change). Upstream pin `fc4936884584a41931906553d96c2601d750e6ef`.

## 1. Problem and scope

The frozen contract declares six repository-wiki operations that our `/api/v1`
does not yet serve (inventory Batch 10, `docs/compat/api-remaining-inventory.md`):

| Operation | `METHOD /repos/{owner}/{repo}/…` | Contract codes |
|---|---|---|
| `repoGetWikiPages` | `GET wiki/pages` | 200, 404 |
| `repoGetWikiPage` | `GET wiki/page/{pageName}` | 200, 404 |
| `repoGetWikiPageRevisions` | `GET wiki/revisions/{pageName}` | 200, 404 |
| `repoCreateWikiPage` | `POST wiki/new` | 201, 400, 403, 404, 423 |
| `repoEditWikiPage` | `PATCH wiki/page/{pageName}` | 200, 400, 403, 404, 423 |
| `repoDeleteWikiPage` | `DELETE wiki/page/{pageName}` | 204, 403, 404, 423 |

Upstream implements the wiki as a **sibling git repository** — no tables
(`gitea/services/wiki/wiki.go`, `repo.WikiStorageRepo()`; the wiki data lives in
`{repo}.wiki.git` next to the repo). Our port is therefore **table-free**: every
page is a `.md` blob in the wiki cell, history is the cell's git log, and all
metadata (title, urls, last commit) is derived at read time.

**In scope**: the six API operations above, the wiki storage cell convention,
the upstream page-name↔file-path codec, lazy provisioning on first write, and
the upstream commit-message templates.

**Out of scope** (recorded, not built here):
- **git-HTTP serving of the wiki repo** (`owner/repo.wiki.git` clone/push):
  LANDED by the follow-up gate batch (it owns `src/git-http/**`): the git
  gate now resolves the PARENT repository for `*.wiki` URLs and serves the
  sibling cell through the ordinary smart-HTTP machinery — clone AND push
  (upstream keeps write checks on wiki pushes, githttp.go:186-189), no wiki
  push-create (githttp.go:215-218), the wiki inheriting the parent's
  visibility, no parent settle, no D1 storage key on wiki forwards, and a
  self-healing priv=1 engine-registry seed so protocol/api reads stop 404ing
  the cell. The authoritative design record (forwarding deltas, the
  engine-path `.wiki` handling, the R2 carry/purge follow-ups) is — LANDED 2026-10-29 (the carried <parent-key>.wiki scheme; slash-free per the engine storage-key grammar)
  `handleWikiGitRoute`'s module doc in `src/git-http/gate.ts`.
- **Web-UI wiki pages** (`/{owner}/{repo}/wiki/...` HTML).
- **Repo-delete cascade**: `src/repos/purge.ts` does not yet tombstone/destroy
  the sibling `.wiki` cell — deleting a repo orphans its wiki storage. Flagged
  to the purge owner; no `src/repos/**` file is touched by this batch.
- **Unit gating** (`mustEnableUnit(unit.TypeWiki)`, api.go:1391): the landed
  API layer consults no `repo_units` rows yet; every repo is treated as
  wiki-enabled (the landed convention).
- **Notifications** (`notify_service.NewWikiPage/EditWikiPage/DeleteWikiPage`,
  wiki.go router tail): the landed wiki write paths emit no webhook/event —
  no wiki event type exists in the landed emitters.

## 2. API surface

Contract authority: `apps/worker/src/compat/contract/v1-swagger.generated.json`
(definitions `WikiPage`, `WikiPageMetaData`, `WikiCommit`, `WikiCommitList`,
`CreateWikiPageOptions`; note the upstream `commiter` typo — one `t` — in
`WikiCommit`). Upstream handlers: `gitea/routers/api/v1/repo/wiki.go`; route
group api.go:1389–1396.

Auth/permission gates (api.go:1389–1396):
- Reads (`GET pages`, `GET page`, `GET revisions`): repo-assignment visibility
  only → `optionalAuth` + `requireVisibleRepo` (invisible = missing = 404).
- Writes (`POST new`, `PATCH page`, `DELETE page`): `reqToken()` →
  `mustNotBeArchived` → `reqRepoWriter(unit.TypeWiki)` → `optionalAuth` is not
  used; requireAuth (401), `assertNotArchived` (423, before the write grant —
  upstream orders the archive gate first), `canWriteRepository` (403,
  upstream's exact `reqRepoWriter` message via the landed
  `services/contents.applyFileChanges` convention).

Payload shapes (ported from `modules/structs/repo_wiki.go`):
- `WikiCommit` = `{sha, author: CommitUser, commiter: CommitUser, message}`;
  `CommitUser` = `{name, email, date}` with `date` in Go `RFC3339` UTC
  (seconds precision, `Z` suffix — `convert.ToWikiCommit`, convert/wiki.go).
- `WikiPageMetaData` = `{title, html_url, sub_url, last_commit}`; `title` is
  the display title (`wiki_service.WebPathToUserTitle`), `sub_url` the raw
  WebPath, `html_url` = repo HTML URL + `/wiki/` + sub_url.
- `WikiPage` = metadata fields + `content_base64` (base64 of the raw blob) +
  `commit_count` + `sidebar` + `footer` (the `_Sidebar`/`_Footer` pages,
  **also base64** — upstream feeds them through the same
  `wikiContentsByEntry` base64 helper, wiki.go router; `""` when absent or
  over the blob cap).
- `WikiCommitList` = `{commits: WikiCommit[], count}`.
- `CreateWikiPageOptions` = `{title (required, TrimSpace), content_base64,
  message}` — the same body for create and edit.

Behavior per operation (all upstream cites `routers/api/v1/repo/wiki.go`):
- **`repoGetWikiPages`**: top-level tree listing of the wiki cell
  (`commit.Tree().ListEntries` — NOT recursive; subdirectory pages are not
  listed upstream either). Pagination: `page = max(formInt(page),1)`;
  `limit = formInt(limit)`, `limit <= 1 → 30` (`DefaultPagingNum`,
  modules/setting/api.go) — **no max-50 clamp** (this route does its own
  skip/maxNum, not `ToCorrectPageSize`). The `skip`/`maxNum` window slices the
  ENTRY INDEX (upstream quirk: non-regular and non-`.md` entries consume
  pagination slots and the totals but never render —
  `!entry.IsRegular()` + `GitPathToWebPath` error both `continue`).
  `X-Total-Count` and `Link` use the FULL entry count (`len(entries)`),
  including directories — upstream's `SetLinkHeader(len(entries))` +
  `SetTotalCountHeader(len(entries))` quirk, kept verbatim.
- **`repoGetWikiPage`**: resolve `pageName` (WebPath codec §4) → blob at the
  git path (fallback probe of the QueryUnescaped path,
  `findEntryForFile`); 404 when the page, branch, or wiki cell does not
  exist. Blob cap `DefaultMaxBlobSize = 10 485 760` bytes
  (modules/setting/api.go): larger blobs render `content_base64: ""` (not an
  error). `commit_count` = commits touching the git path (`FileCommitsCount`).
  `last_commit` = newest commit touching the path (`GetCommitByPath`).
- **`repoGetWikiPageRevisions`**: paged log of the page's git path, page size
  `CommitsRangeSize = 50` (`CommitsByFileAndRange`, modules/git/repo_commit.go:
  `--skip=(page-1)*50 --max-count=51` for `more` detection). Response
  `WikiCommitList` with `count` = total commits touching the path;
  `X-Total-Count` set; **no Link header** (upstream FIXME kept). Empty
  `pageName` falls back to `Home` (upstream).
- **`repoCreateWikiPage`**: `wikiName = UserTitleToWebPath("", title)`;
  default message `Add %q(title)`; base64 decode failure → 400 `illegal
  base64 data at input byte N` (Go `CorruptInputError` text,
  `decodeStrictBase64`); reserved segment → 400 `wiki title is reserved: …`
  (`ErrWikiReservedName`); existing page (either the WebPath+.md or the coded
  git path exists — `prepareGitPath` dual lookup) → 400 `wiki page already
  exists [title: <gitPath>]` (`ErrWikiAlreadyExist`, models/repo/wiki.go).
  Answers 201 with the created `WikiPage`.
- **`repoEditWikiPage`**: `oldWikiName` from the path, `newWikiName =
  UserTitleToWebPath("", title)` (empty title → keep old). Default message
  `Update %q(newWikiName)`. Semantics of upstream `updateWikiPage(isNew=false)`:
  a **rename** (old path removed, new written) and/or in-place content
  update; a **missing old page is an UPSERT** (upstream removes the old index
  entry only when it exists, then adds the new one — editing a nonexistent
  page creates it); a rename onto an existing page replaces its content
  (no collision error). Reserved NEW name → upstream `updateWikiPage`
  validates and the router maps the error to `APIErrorInternal` → **500**
  (wiki.go router: `ctx.APIErrorInternal(err)`) — mirrored (runtime-only
  status). Answers 200 with the resulting `WikiPage`.
- **`repoDeleteWikiPage`**: missing page (or unborn wiki) → 404
  (`util.ErrNotExist` → `APIErrorAuto`); success → 204. Message template
  `Delete page %q(wikiName)` (services/wiki/wiki.go) — DELETE takes no body,
  so the message is not overridable.

Runtime-only response emissions (contract-undeclared; for the orchestrator's
`RUNTIME_ONLY_RESPONSES` ledger, the landed contents/avatars-family posture —
declared sets stay EXACTLY the contract's):
- 401 on the three writes (`reqToken`); 422 on a schema-invalid body (the
  bind-hook class; upstream Go bind 422s too) and on the engine's change-size
  budget refusal (cf-gitea bound, upstream has no wiki write cap); 500 for
  internal errors (incl. the reserved-name-on-edit arm above); 409 on a lost
  ref CAS race (the engine's `ref_conflict`, same mapping as the contents
  write family).

Commit-message templates (Go `%q` quoting ported — `"` `\` `\n` `\r` `\t`
escapes, other control chars as `\xHH`):
- create: user message, else `Add "<title>"` (the RAW trimmed form title).
- edit: user message, else `Update "<newWikiName>"` (the WebPath).
- delete: always `Delete page "<wikiName>"` (the WebPath).

## 3. Storage: the wiki engine cell

Upstream keeps the wiki at `repos/{owner}/{repo}.wiki.git` — a REAL git repo
(`services/wiki/wiki.go`: `InitWiki` creates it with the repo's object format
and `repo.DefaultWikiBranch`, which defaults to the repo's default branch,
models/repo/repo.go:309-310; pushes go to `repo.Name+".wiki"`).

**Our convention: a sibling engine cell named `<ownerNamespace>/<slug>.wiki`.**
The landed repo cell is addressed by the combined D1 name
`ownerNamespace/slug` (`src/api/services/engine.ts engineRepoName`; DO id
`env.REPO.getByName(name)` — `src/repos/service.ts` engineName convention).
The wiki cell appends `.wiki` to the SAME name: `env.REPO.getByName(
"owner/slug.wiki")`, mirroring upstream's `repo.Name+".wiki"` push target.
The name cannot collide with a real repo cell: `RESERVED_REPO_NAME_SUFFIXES`
(`src/repos/service.ts`) already forbids `*.wiki` repo names D1-wide, so
`owner/x.wiki` is permanently free engine namespace.

- **Lazy provisioning**: no init RPC. A Durable Object cell comes into
  existence on its first RPC; the wiki "exists" once its default-branch ref
  exists. The first page write builds a ROOT commit (no parents — upstream
  `hasDefaultBranch=false` commits with no parent, wiki.go) and lands it with
  `commitApiChange({ref: refs/heads/<defaultBranch>, expectedOldOid:
  ZERO_OID})` (the engine's create-on-empty CAS base). The engine auto-seats
  HEAD on the first branch (control-plane.ts commitApiChange), so the cell is
  clone-ready once the gate serves it.
- **Default branch**: the REPO's `defaultBranch` from D1 (upstream
  `DefaultWikiBranch` defaults to the repo default; we follow the live value).
- **Empty-wiki reads are not errors**: `GET wiki/pages` on a repo with no
  wiki cell / unborn branch answers `200 []` (empty list); `GET wiki/page/…`
  and `GET wiki/revisions/…` answer 404 — the mission's contract with
  upstream's `findWikiRepoCommit` behavior (a missing branch is a
  not-exist-class failure on the single-page reads, while the list endpoint
  renders the empty tree).
- **No engine-registry row** for the wiki cell: the registry feeds the
  public index (`Registry.list`) and the git gate's fetch authorization —
  registering `owner/slug.wiki` would leak wiki cells into the site index
  while the gate 404s wiki URLs anyway. Reads/writes ride direct cell RPCs,
  which need no registration. Registering the wiki cell belongs to the batch
  that teaches the gate to serve `*.wiki.git` clones.
- **No D1 state**: zero tables/columns. The wiki is discoverable only through
  the engine cell, exactly like upstream (whose only wiki D1 state is
  `default_wiki_branch`, which we already carry as `repositories.default_branch`
  semantics).
- **Write serialization**: upstream takes a `globallock` per repo
  (`wiki_working_%d`, wiki.go). Our serialization is the cell itself: the
  write path is listRefs → build → `putApiObjects` → `commitApiChange` CAS
  (`expectedOldOid` = observed tip), so two concurrent wiki writes resolve by
  CAS — the loser answers 409 (runtime-only), never a torn tree.

## 4. Page-name ↔ file-path codec (services/wiki/wiki_path.go, ported exactly)

Concepts (upstream comments kept): **Display Segment** (the user-visible
title), **WebPath** (the API/route form), **GitPath** (`<WebPath-coded>.md`).

- `hasDashMarker(s)`: suffix `".-"`. A segment ending `.-` opts out of the
  dash↔space conversion.
- `unescapeSegment(s)`: dash marker → strip it; else `-`→` `; then
  QueryUnescape (`+`→` `, `%XX` decode; decode failure keeps the original —
  upstream's "safe to return the original" arm).
- `escapeSegToWeb(s, hadDashMarker)`: dash marker was present, or `s`
  contains `-`, or `s` ends `.md` → append `.-`; else ` `→`-`; then
  QueryEscape (space→`+`; Go's unreserved set `A-Za-z0-9-_.~` left bare —
  note `!'()*` ARE escaped, unlike `encodeURIComponent`).
- `webPathToGitPath(webPath)`: a WebPath already ending `.md` is used
  (PathUnescaped) directly as the git path (the raw-file escape hatch);
  otherwise per-segment unescape/escape round trip (idempotence guard),
  `%20`→` ` and `+`→` ` (space is legal in git paths), join `/`, append
  `.md`.
- `gitPathToWebPath(gitPath)`: must end `.md` (else invalid-filename → the
  pages list skips the entry); trim, per-segment round trip, join.
- `userTitleToWebPath(base, title)`: TrimSpace, `escapeSegToWeb(title,
  false)`, `PathJoinRelX(base, …)`; empty/`.` → `"unnamed"`.
- `webPathFromRequest(pathParam)`: `PathJoinRelX` then `/`→`%2F` (the legacy
  always-%2F subdirectory encoding).
- `webPathToUserTitle(webPath)`: dir = dirname, display = basename; strip a
  `.md` suffix; PathUnescape + unescapeSegment → the display title.
- `validateWebPath(webPath)`: every segment's unescaped form must not be in
  `reservedWikiNames = {_pages, _new, _edit, raw}` → 400 on create.
- `pathJoinRelX`: port of `util.PathJoinRelX` (backslashes→slashes, each
  element `Clean("/"+e)`, joined, leading `/` stripped, `/`→`.`).

`Home` is the conventional first page but nothing special-cases it (only the
revisions endpoint's empty-name fallback, above).

## 5. Edge cases, limits, failure modes

- **Empty wiki / unborn branch** — reads per §3; DELETE → 404;
  POST/PATCH create the branch (root commit).
- **Missing page** — GET page/revisions 404; DELETE 404; PATCH upserts;
  POST 400 already-exists is checked against BOTH candidate paths
  (WebPath`.md` and the coded GitPath — `prepareGitPath`'s dual lookup).
- **Rename collision** — PATCH old→new where new exists: upstream merges
  (old removed, new content replaced, no error). Ported.
- **Non-UTF8 page content** — bytes are opaque: `content_base64` is base64 of
  the raw blob regardless of encoding (upstream `GetBlobContentBase64`).
- **Blob cap** — 10 MiB `DefaultMaxBlobSize`: larger pages render empty
  `content_base64`/`sidebar`/`footer` but keep metadata.
- **Engine change budget** — a wiki write the engine refuses as too large →
  422 (runtime-only; upstream has no cap — documented divergence).
- **Lost CAS race** — concurrent wiki writes: loser 409 (runtime-only).
- **Reserved names** — create: 400 `wiki title is reserved: <seg>`; edit:
  500 (upstream's `APIErrorInternal` arm, wiki.go router).
- **Invalid base64** — 400 `illegal base64 data at input byte N` (strict
  StdEncoding, Go parity via the landed avatars decoder).
- **Engine transport failure on reads** — resolves `null` → 404/empty per
  the `engineReads` posture; on writes it throws → the 500 handler (never a
  fabricated 4xx).

## 6. Testing plan

Colocated `apps/worker/src/api/routes/wiki.test.ts` (the batch family's
local-mount pattern — `engine-read.test.ts`):

1. **Real engine cycle** — seed a repo through the LANDED receive flow
   (`ensureSeededRepo`, real pack push), then exercise
   create → pages-list → page-read → edit(rename + content) →
   revisions → delete against the sibling `.wiki` cell: 201 body shape
   (title/sub_url/html_url/base64 content/commit_count=1/last_commit),
   provisioning visible via the cell's refs (root commit, no parents), the
   commit-message templates verbatim, rename leaving no old blob, revision
   count/page semantics, delete → 204 → 404, and the storage-key convention
   (`owner/slug.wiki` cell exists; the repo cell untouched).
2. **Empty-wiki reads** — list `200 []` (+ headers), page/revisions 404,
   DELETE 404, PATCH upsert.
3. **Gates** — anonymous write 401; non-collaborator write 403 (exact
   `reqRepoWriter` message); archived repo 423 before the write grant;
   invisible repo 404 on every operation.
4. **Contract arms** — create-existing 400 (exact `ErrWikiAlreadyExist`
   text), reserved title 400, invalid base64 400 (Go text), missing title
   422 (runtime-only class).
5. **Codec unit checks** — spaces→`-`, dash-marker round trip, `.md` WebPath
   passthrough, QueryEscape parity (`%25`, `+`), reserved segments, `%2F`
   request form, `unnamed` fallback.
6. **Contract declaration check** — in-test: every operationId/method/path
   against the frozen contract JSON and the declared response sets ⊆ the
   contract's codes (the batch's `check:api` seam while router.ts
   registration is the orchestrator's).
