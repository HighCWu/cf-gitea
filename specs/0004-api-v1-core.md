# SPEC-0004: `/api/v1` Core — path taxonomy, priority core, and contract discipline

Status: **draft** — pending decisions from SPEC-0002 (auth/token scopes) and SPEC-0003
(repo lifecycle / git HTTP routes). Date: 2026-10-24.
Implements ADR-0001 decisions D2 (tiered compatibility, Tier-1 product contract) and
D3 (architecture allocation, swagger-checked routes).
References: `docs/decisions/0001-technical-direction.md`, `specs/0001-storage-engine.md`,
`specs/0002-auth.md` (drafted separately), `specs/0003-repo-lifecycle-git-http.md` (drafted
separately). Authoritative contract: the vendored
`gitea/templates/swagger/v1-swagger.generated.json` (OpenAPI 2.0, 350 paths, 554
operations, 233 schema definitions). All numbers in this SPEC were extracted from that
file programmatically; path/op counts are exact for the vendored pin and must be
re-verified whenever the submodule pin is bumped (ADR D5).

## 1. Problem and scope

The Gitea `/api/v1` REST surface is the Tier-1 product contract (ADR D2): CLI tools,
the Go/JS/Python SDKs, release automation, CI status reporters, and terraform-style
provisioners all consume it; it is what makes cf-gitea a *headless Gitea*. 350 paths
and 554 operations is too much to build at once, and not all of it earns its cost:
whole feature areas (Actions, packages, projects) are deferred by ADR. This SPEC
fixes, before any router is written:

1. A complete, auditable taxonomy of **all 350 paths** (appendix A), so "what is
   deferred" is a query, not an opinion.
2. The **priority core** (~80 paths, tier 1) that real clients exercise, with a
   one-line justification each, a per-path mapping to our storage layers, and the
   upstream behavior quirks the vendored swagger exposes.
3. The **wire conventions** every route must follow (errors, pagination, timestamps,
   auth), extracted from the contract rather than invented.
4. The **compatibility discipline** (ADR D3 / flare-forge rule): routes declared with
   `@hono/zod-openapi` are CI-checked against the vendored swagger; served routes
   without a contract entry fail CI; response schemas are diffed against the contract.

In scope:

- Classification and tiering of the full 350-path surface (appendix A).
- Tier-1 route design: per-path data source, auth scope link, caching, upstream gotchas.
- Cross-cutting response conventions and the contract-check CI machinery.

Out of scope (their own SPECs or explicitly deferred, see §2.5):

- Token issuance/semantics and the ACL matrix (SPEC-0002); git smart-HTTP routes and
  repo create-by-push (SPEC-0003); the D1 schemas for issues/PRs/releases/webhooks in
  full detail (SPEC-0005) — this SPEC only flags the tables tier 1 needs; UI (SPEC-0006).

## 2. API surface

### 2.1 Contract facts

- Swagger 2.0, `basePath: /GITEA-API-APP-SUBURL/api/v1` (template placeholders; our
  mount point is `/api/v1`), `consumes/produces: application/json` (plus
  `multipart/form-data` on the three attachment-upload endpoints and raw text on
  diff/patch/archive endpoints).
- 350 paths, 554 operations. Method census: GET 269, POST 122, DELETE 95, PATCH 41,
  PUT 27.
- Swagger tags: `repository` (the bulk), `user`, `organization`, `issue`,
  `miscellaneous`, `admin`, `notification`, `package`, `settings`. Tags alone do not
  give a useful build order — §2.2 classifies by subject instead.

### 2.2 Path taxonomy (all 350 paths)

Categories (a)–(g) are the contract buckets; (h)–(j) are carved out of "misc" so the
catch-all stays small and the deferred feature areas are visible as first-class rows.
Counts are paths; one path may carry several operations.

| Cat | Category | Paths | Notes |
|---|---|---:|---|
| a | identity, auth & directory (users, orgs, teams, tokens, keys, follows, profile) | 61 | D1-only per ADR D3 (`users/orgs/teams`) |
| b | repository metadata CRUD & social (repo core, search, transfer, forks, topics, collaborators, deploy keys, avatars, stars/watch, mirrors, signing-key) | 45 | D1 registry + a few engine interactions |
| c | git object reads (contents/raw/media/archive, branches, tags, commits, git refs/trees/blobs/tags, compare, languages, editorconfig) | 27 | engine-backed (SPEC-0001) |
| d | issues, PRs, comments, releases, labels, milestones, statuses, time tracking, attachments | 70 | D1-backed (SPEC-0005), engine-assisted for tags/diffs |
| e | webhooks (repo/org/user/admin hooks, deliveries, tests, git-hooks config) | 9 | D1 + Queue delivery; git-hooks are config-file-backed |
| f | admin & instance settings | 22 | deferred |
| g | misc utilities (version, markdown/markup, gitignore/label/license templates, signing keys, topic search) | 13 | cheap, several tier 1 |
| h | Gitea Actions (runs, jobs, runners, artifacts, secrets, variables, workflows) | 55 | deferred — largest single deferred block |
| i | package registry | 7 | deferred |
| j | projects (kanban) & wiki | 38 | deferred (D1-backed later) |
| k | notifications | 3 | deferred (needs its own scope category) |
| | **total** | **350** | 554 operations |

### 2.3 Tiering and the priority core

Tiers are assigned at **path** granularity (a path's operations ship together unless a
method is explicitly deferred in the mapping table):

- **Tier 1 (78 paths, 129 operations)** — the priority core below; ships with the
  SPEC-0001/0002/0003 foundations. This is the set the compat suite (§5) enumerates.
- **Tier 2 (137 paths)** — the remainder of categories (a)–(e): full identity/orgs,
  remaining repo metadata, remaining object reads, remaining issue/PR surface. Landed
  by SPEC-0005 and follow-ups until category parity.
- **Tier 3 (135 paths)** — categories (f)–(k): admin, Actions, packages, projects,
  wiki, notifications, settings. Explicitly deferred (§2.5). As-built exception: the
  table-free `admin` subset (8 ops) has landed (`src/api/routes/admin-t2.ts` — its
  module header carries the documented deviations). `DELETE /admin/users/{username}`
  distinguishes `purge` like upstream's `DeleteUser` (services/user/user.go:139–295):
  non-purge keeps the owned-repos/membership 422 guards; purge drives the user's
  repos through the SPEC-0003 §2.5.5 `deleteRepository` cascade (the demo sweep's
  consumer path) and removes memberships — a last-owner org deleted through
  SPEC-0007's cascade — before the census batch and row delete
  (`deleteUserCascade`, `src/services/user-accounts.ts`). The DEMO_MODE sweep
  (SPEC-0014) stays the fail-safe backstop for hand-D1 user deletes.

The tier-1 selection is justified against four real client families: the official
SDK surface (`code.gitea.io/sdk/gitea` — every tier-1 path has at least one SDK
method: `GetRepo`, `ListRepoBranches`, `GetContents`, `CreateFile`, `ListReleases`,
`CreateRelease`, `MergePullRequest`, `CreateStatus`, `CreateRepoHook`, …), release/pull
automation (tags + releases + assets + PR merge), CI checkout/status tooling
(raw/contents/archive reads + statuses), and terraform-style repo management
(repo CRUD, topics, collaborators, transfer, org repos, labels, milestones).

#### Tier-1 justifications (one line per path)

- `GET /version` — every SDK client pings it first (`gitea.ServerVersion`); cheapest capability check.
- `GET /user` — token → identity resolution; the first authenticated call of every tool.
- `GET /users/{username}` — owner resolution for automation and frontends.
- `GET /users/search` — name → user lookup (invite/assign flows, terraform data lookups).
- `GET /users/{username}/repos` — public repo listing per owner (SDK `ListUserRepos`, CI discovery).
- `GET/POST /user/repos` — "my repos" list and repo creation (`ListMyRepos`/`CreateRepo`; terraform `gitea_repository`).
- `GET /user/orgs` — current user's org memberships (SDK `ListMyOrgs`).
- `GET/PATCH /user/settings` — account settings for API-driven frontends (`GetUserSettings`).
- `GET /user/starred`, `GET/PUT/DELETE /user/starred/{owner}/{repo}` — star social set used by SDK/tea.
- `POST /markdown`, `POST /markdown/raw` — issue/comment body rendering for every API frontend (tea previews, bots).
- `GET /orgs/{org}/repos` (+`POST`) — org repo listing and org-repo creation (terraform `gitea_org`+repo provisioning). The path's `DELETE` (delete *all* org repos) is **not** implemented.
- `GET/PATCH/DELETE /repos/{owner}/{repo}` — the repo object itself; the single most-consumed endpoint in the API.
- `GET /repos/search` — repo discovery by keyword (terraform, tea, listing UIs).
- `GET /repositories/{id}` — repo by numeric id (SDK `GetRepoByID`, webhook payloads reference it).
- `GET/PUT /repos/{owner}/{repo}/topics` — topics read/replace (terraform, badge/label tooling).
- `GET /repos/{owner}/{repo}/collaborators`, `GET/PUT/DELETE /repos/{owner}/{repo}/collaborators/{collaborator}` — collaborator ACL management (repo-admin automation).
- `POST /repos/{owner}/{repo}/transfer` — ownership transfer automation (`TransferRepo`, returns 202).
- `GET/POST /repos/{owner}/{repo}/forks` — fork listing/creation (SDK `CreateFork`, 202 upstream).
- `GET /repos/{owner}/{repo}/languages` — language stats (SDK `GetRepoLanguages`, badges).
- `GET/POST /repos/{owner}/{repo}/branches`, `GET/PUT/DELETE/PATCH /repos/{owner}/{repo}/branches/{branch}` — branch list/create/get/ref-CAS-update/delete/rename; release automation creates branches, CI reads them, PUT is a direct map to the engine's ref CAS.
- `GET/POST /repos/{owner}/{repo}/tags`, `GET/DELETE /repos/{owner}/{repo}/tags/{tag}` — tag list/create/get/delete; the release story (sdk `CreateTag`/`ListRepoTags`).
- `GET /repos/{owner}/{repo}/git/tags/{sha}` — annotated tag object read (`GetAnnotatedTag`).
- `GET /repos/{owner}/{repo}/commits` — commit listing with `since`/`until`/`path` and changelog generation (`ListRepoCommits`).
- `GET /repos/{owner}/{repo}/git/commits/{sha}` — single commit (`GetSingleCommit`; accepts a ref, not only a sha).
- `GET /repos/{owner}/{repo}/git/commits/{sha}.{diffType}` — commit diff/patch download (`GetCommitDiff`/`GetCommitPatch`; CI patch-apply flows).
- `GET /repos/{owner}/{repo}/commits/{sha}/pull` — commit → PR resolution for changelog tooling (`GetCommitPullRequest`).
- `GET /repos/{owner}/{repo}/compare/{basehead}` — release-notes/changelog diffs between refs (`CompareCommits`).
- `GET /repos/{owner}/{repo}/git/refs`, `GET /repos/{owner}/{repo}/git/refs/{ref}` — raw ref reads, straight from the RepoDO refs table (`ListAllGitRefs`/`GetRepoRefs`).
- `GET /repos/{owner}/{repo}/git/trees/{sha}` — recursive tree listing (`GetTrees`; note `per_page`, not `limit`).
- `GET /repos/{owner}/{repo}/git/blobs/{sha}` — blob read (`GetBlob`; base64 content).
- `GET /repos/{owner}/{repo}/contents`, `GET /repos/{owner}/{repo}/contents/{filepath}` — directory listing / file+dir read (`ListContents`/`GetContents`); the default branch is the implicit `ref`.
- `POST/PUT/DELETE /repos/{owner}/{repo}/contents/{filepath}` — single-file create/update/delete committing through the engine (`CreateFile`/`UpdateFile`/`DeleteFile`); the "edit on the web/API" story.
- `POST /repos/{owner}/{repo}/contents` — multi-file change in one commit (`ChangeFiles`; site-generator bots).
- `POST /repos/{owner}/{repo}/diffpatch` — apply a patch as a commit (`ApplyRepoDiffPatch`; bot workflows).
- `GET /repos/{owner}/{repo}/raw/{filepath}` — raw file bytes (`GetRawFile`; install scripts, CI fetches).
- `GET /repos/{owner}/{repo}/media/{filepath}` — raw-or-LFS variant (`GetRawFileOrLFS`; forward-compatible with the LFS SPEC).
- `GET /repos/{owner}/{repo}/archive/{archive}` — tarball/zip of a ref (`GetArchive`; release assets, vendoring, CI caches).
- `GET /repos/{owner}/{repo}/editorconfig/{filepath}` — editorconfig resolution (`GetEditorConfig`; API frontends).
- `GET /repos/{owner}/{repo}/issue_templates` — issue template discovery (`GetIssueTemplates`; issue bots).
- `GET/POST /repos/{owner}/{repo}/issues`, `GET/PATCH/DELETE /repos/{owner}/{repo}/issues/{index}` — issue basics (`ListIssues`/`CreateIssue`/`GetIssue`/`EditIssue`/`DeleteIssue`); `index` is the per-repo sequence, not a global id.
- `GET /repos/{owner}/{repo}/issues/comments`, `GET/PATCH/DELETE /repos/{owner}/{repo}/issues/comments/{id}` — repo-wide comment feed and single-comment ops (`ListRepoIssueComments`/`GetIssueComment`/…).
- `GET/POST /repos/{owner}/{repo}/issues/{index}/comments` — per-issue comment read/create (`ListIssueComments`/`CreateIssueComment`).
- `GET/PUT/POST/DELETE /repos/{owner}/{repo}/issues/{index}/labels` — issue label get/replace/add/clear (triage bots: `GetIssueLabels`/`ReplaceIssueLabels`/…).
- `GET /repos/{owner}/{repo}/issues/{index}/timeline` — issue event stream (comment + event feed; API frontends).
- `GET /repos/issues/search` — cross-repo issue query (dashboards, `SearchIssues`).
- `GET/POST /repos/{owner}/{repo}/labels`, `GET/PATCH/DELETE /repos/{owner}/{repo}/labels/{id}` — label CRUD (terraform `gitea_label`).
- `GET/POST /repos/{owner}/{repo}/milestones`, `GET/PATCH/DELETE /repos/{owner}/{repo}/milestones/{id}` — milestone CRUD (terraform `gitea_milestone`).
- `GET/POST /repos/{owner}/{repo}/pulls`, `GET/PATCH /repos/{owner}/{repo}/pulls/{index}` — PR list/create/get/edit (automation core).
- `GET /repos/{owner}/{repo}/pulls/{base}/{head}` — PR lookup by refs (`GetPullRequestByBaseHead`; bots resolve "the PR for this branch").
- `GET /repos/{owner}/{repo}/pulls/{index}.{diffType}` — PR diff/patch (`GetPullRequestDiff`/`GetPullRequestPatch`).
- `GET /repos/{owner}/{repo}/pulls/{index}/commits` — PR commits (`ListPullRequestCommits`; changelogs).
- `GET /repos/{owner}/{repo}/pulls/{index}/files` — PR changed files (`ListPullRequestFiles`; review bots).
- `GET/POST /repos/{owner}/{repo}/pulls/{index}/merge` — is-merged check and merge execution (`IsPullRequestMerged`/`MergePullRequest`; automerge tooling). The path's `DELETE` (cancel scheduled automerge) may ship in tier 2.
- `POST /repos/{owner}/{repo}/merge-upstream` — fork upstream sync (`MergeUpstream`; dependabot-style flows).
- `GET/POST /repos/{owner}/{repo}/releases`, `GET /repos/{owner}/{repo}/releases/latest`, `GET/DELETE /repos/{owner}/{repo}/releases/tags/{tag}`, `GET/PATCH/DELETE /repos/{owner}/{repo}/releases/{id}` — the release lifecycle (`ListReleases`…`DeleteReleaseByTag`); the "latest" lookup is what `curl | bash` install scripts resolve.
- `GET/POST /repos/{owner}/{repo}/releases/{id}/assets` — release asset list/upload (release tooling like goreleaser-style flows; multipart).
- `GET /repos/{owner}/{repo}/assignees` — valid-assignee list for issue automation (SDK `GetAssignees`).
- `GET/POST /repos/{owner}/{repo}/statuses/{sha}`, `GET /repos/{owner}/{repo}/commits/{ref}/statuses`, `GET /repos/{owner}/{repo}/commits/{ref}/status` — CI status reporting and gating (`CreateStatus`/`ListStatuses`/`GetCombinedStatus`).
- `GET/PUT/DELETE /repos/{owner}/{repo}/subscription` — watch/unwatch a repo (SDK `CheckRepoWatch`/`WatchRepo`/`UnwatchRepo`).
- `GET/POST /repos/{owner}/{repo}/hooks`, `GET/PATCH/DELETE /repos/{owner}/{repo}/hooks/{id}` — webhook CRUD (`CreateRepoHook`/…; the integration surface every SaaS automation uses).
- `POST /repos/{owner}/{repo}/hooks/{id}/tests`, `GET /repos/{owner}/{repo}/hooks/{id}/deliveries` — webhook fire-test and delivery log (`TestWebhook`; setup debugging).

### 2.4 Tier-1 mapping to layers, auth, cache, and upstream gotchas

Data source legend: **D1** = Drizzle tables only; **engine** = RepoDO/R2 via the
SPEC-0001 storage interface; **both** = orchestrates engine + D1. Auth scope column
names the SPEC-0002 token scope category enforced when a token is presented
(`read:`/`write:`); reads on public resources are anonymous upstream, and every
scoped route also accepts basic auth — the ACL matrix (401 vs 403 vs 404) is
SPEC-0003's. Cache column: `refs_version` = edge Cache API entry keyed by the repo's
`refs_version` (SPEC-0001 §5), invalidated on every push; **none** = serve from D1
each time.

| Path (tier-1 methods) | Source | Scope (SPEC-0002) | Cache | Upstream gotchas visible in the contract |
|---|---|---|---|---|
| `GET /version` | config | none (anon) | none | Returns only `{version}`; the string we report is an open question (D5 pin). |
| `GET /user` | D1 | `read:user` | none | Anonymous → 401; returns `User` with email visible only to self/admin. |
| `GET /users/{username}` | D1 | none / `read:user` | none | 404 for absent **and** private-restricted users (indistinguishable). Landed: the `users.visibility` ladder (`IsUserVisibleToViewer` reduction, api/services/user.ts) gates every row — org rows included. |
| `GET /users/search` | D1 | none (anon) | none | Response is `{data: User[], ok: bool}` — `ok` is always `true`; total count only via `X-Total-Count` header. Upstream gotchas landed: `Types: [UserTypeIndividual]` (orgs never answer) + `BuildCanSeeUserCondition` (anonymous → public rows only; signed-in → +limited+self; admin → all). |
| `GET /users/{username}/repos` | D1 | `read:repository` | none | Only public repos unless self/token grants more; paginated. |
| `GET /user/repos` | D1 | `read:repository` | none | Accepts `affiliation`-style filters upstream; paginated. |
| `POST /user/repos` | both | `write:repository` | n/a | 201; `auto_init` triggers an initial commit through the engine; duplicate name → conflict per upstream handler. |
| `GET /user/orgs` | D1 | `read:organization` | none | Scope check covers **two** categories upstream (organization + repository). |
| `GET/PATCH /user/settings` | D1 | `read:user` / `write:user` | none | Public-only tokens are rejected here (upstream `rejectPublicOnly`). |
| `GET /user/starred` | D1 | `read:repository` | none | Feature-flagged upstream (`ENABLEDStars`); 404 when disabled. |
| `GET/PUT/DELETE /user/starred/{owner}/{repo}` | D1 | `read:`/`write:repository` | none | PUT/DELETE → 204 empty. |
| `POST /markdown` | misc | any valid token | none | 401/403 anonymous; input `MarkdownOption{Text, Mode, Context, Wiki}`. |
| `POST /markdown/raw` | misc | any valid token | none | Body is the raw markdown text, not JSON. |
| `GET /orgs/{org}/repos` | D1 | `read:organization` | none | Paginated. |
| `POST /orgs/{org}/repos` | both | `write:organization` | n/a | 201; the same path's `DELETE` (delete *all* org repos, 202) is **not** implemented. |
| `GET /repos/{owner}/{repo}` | D1 (+engine for size/branch counters) | `read:repository` | none | 71-field `Repository`; `empty:true` until first push drives many client behaviors; `permissions` block embedded. |
| `PATCH /repos/{owner}/{repo}` | D1 | `write:repository` | none | 39 optional fields, partial update; rename via `name`; archived repo → 423. |
| `DELETE /repos/{owner}/{repo}` | both | `write:repository` | n/a | 204; must also purge R2/DO storage (SPEC-0003 lifecycle). |
| `GET /repos/search` | D1 | none (anon) | none | 17 query params incl. `sort` enum with `git_size`/`lfs_size`; `mode` ∈ fork/source/mirror/collaborative. |
| `GET /repositories/{id}` | D1 | `read:repository` (token required upstream) | none | Requires token upstream (`reqToken`). |
| `GET/PUT /repos/{owner}/{repo}/topics` | D1 | `read:`/`write:repository` | none | PUT **replaces** the whole list; invalid names → 422 with `invalidTopics` (swagger models it as a header — same quirk as errors). |
| `GET /repos/{owner}/{repo}/collaborators` | D1 | `read:repository` (repo admin) | none | Paginated; permission checked is admin-mode, not writer. |
| `GET/PUT/DELETE /repos/{owner}/{repo}/collaborators/{collaborator}` | D1 | `read:`/`write:repository` (admin) | none | PUT body `Body: permission string`; DELETE → 204. |
| `POST /repos/{owner}/{repo}/transfer` | D1 | `write:repository` (owner) | n/a | **202 Accepted** — async, pending transfer; not the final state. |
| `GET/POST /repos/{owner}/{repo}/forks` | D1 + engine strategy | `read:`/`write:repository` | n/a | POST → **202** (async fork); object-sharing model between fork parents is a SPEC-0003/0005 decision. |
| `GET /repos/{owner}/{repo}/languages` | engine (persist result in D1) | `read:repository` | D1 after first compute | Upstream computes async in background; response is a map `language → int64 bytes`. |
| `GET/POST /repos/{owner}/{repo}/branches` | engine + D1 (protection flags) | `read:`/`write:repository` | `refs_version` | POST → **201**; `CreateBranchRepoOption` has both `old_branch_name` and `old_ref_name`; list sends `X-Total-Count`. |
| `GET /repos/{owner}/{repo}/branches/{branch}` | engine | `read:repository` | `refs_version` | Branch names with `/` must survive routing (URL-encoded); includes `user_can_push`/`user_can_merge`. |
| `PUT /repos/{owner}/{repo}/branches/{branch}` | engine | `write:repository` | invalidates `refs_version` | **Ref CAS**: `{old_commit_id, new_commit_id, force}` → 204; 409 on CAS mismatch. Direct map to RepoDO ref transaction. |
| `DELETE /repos/{owner}/{repo}/branches/{branch}` | engine | `write:repository` | invalidates `refs_version` | 204; default-branch delete → 403. |
| `PATCH /repos/{owner}/{repo}/branches/{branch}` | both | `write:repository` | invalidates `refs_version` | Rename; if it was the default branch, repo metadata updates too. |
| `GET/POST /repos/{owner}/{repo}/tags` | engine | `read:`/`write:repository` | `refs_version` | POST returns **200** (not 201) with `Tag`; 405 on an empty repo; list documents "default maximum page size is 50". |
| `GET/DELETE /repos/{owner}/{repo}/tags/{tag}` | engine | `read:`/`write:repository` | `refs_version` | GET merges lightweight + annotated views into `Tag`; DELETE → 204, 405 variants exist. |
| `GET /repos/{owner}/{repo}/git/tags/{sha}` | engine | `read:repository` | `refs_version` | Annotated tag **objects only** — lightweight tags → 404 (documented in the param). |
| `GET /repos/{owner}/{repo}/commits` | engine | `read:repository` | `refs_version` (short TTL) | `stat`/`verification`/`files` default **true** (expensive enrichment); `limit` ignored when `path` is set; empty repo → **409** `EmptyRepository` error body. |
| `GET /repos/{owner}/{repo}/git/commits/{sha}` | engine | `read:repository` | `refs_version` | Param is "a git ref **or** commit sha" — ref resolution required, not just oid lookup. |
| `GET /repos/{owner}/{repo}/git/commits/{sha}.{diffType}` | engine | `read:repository` | Cache API | `diffType` ∈ `diff`\|`patch`; response is raw text (swagger type `string`). |
| `GET /repos/{owner}/{repo}/commits/{sha}/pull` | D1 | `read:repository` | none | Joins engine sha → D1 PR head sha; 404 when no PR. |
| `GET /repos/{owner}/{repo}/compare/{basehead}` | engine | `read:repository` | Cache API | `basehead` = `base...head` (three-dot) or `base..head`; `output=diff\|patch` returns raw text instead of JSON. As-built divergences (2026-10-28, the engine review's range-order fix): the JSON commit list renders NEWEST-first like upstream's git-log order (the engine walk is oldest-first and the route reverses it); a null merge base (unrelated histories) answers EARLY EMPTY — zero commits, empty raw diff (compare.go:91-93; the engine's budget-exhausted merge-base walk reports the same null base and takes the same EMPTY shape, the documented exhaustion posture, SPEC-0001b §6). |
| `GET /repos/{owner}/{repo}/git/refs` | engine (RepoDO refs) | `read:repository` | `refs_version` | Returns `Reference[]` array even for a single ref; this is the direct refs-table read. |
| `GET /repos/{owner}/{repo}/git/refs/{ref}` | engine | `read:repository` | `refs_version` | Matches "part or full name" — suffix matching may return several refs in one array. |
| `GET /repos/{owner}/{repo}/git/trees/{sha}` | engine | `read:repository` | `refs_version` | Paginated with **`page` + `per_page`** (not `limit`!); `recursive=true` + `truncated` flag in the response body. |
| `GET /repos/{owner}/{repo}/git/blobs/{sha}` | engine | `read:repository` | Cache API | `content` is base64 with `encoding:"base64"`; LFS pointers surface `lfs_oid`/`lfs_size`. |
| `GET /repos/{owner}/{repo}/contents` | engine | `read:repository` | `refs_version` | Directory → **array**, file → **object** (union response by target type). |
| `GET /repos/{owner}/{repo}/contents/{filepath}` | engine | `read:repository` | `refs_version` | `type` ∈ file/dir/symlink/submodule; `content` base64; enriches `last_commit_sha`/`last_committer_date`. |
| `POST /repos/{owner}/{repo}/contents/{filepath}` | both | `write:repository` | invalidates `refs_version` | **201**; body needs `content` (base64); optional `branch`, `new_branch`, `author`, `committer`, `dates`, `signoff`, `force_push`. |
| `PUT /repos/{owner}/{repo}/contents/{filepath}` | both | `write:repository` | invalidates `refs_version` | 200/201 both declared; requires `sha` of the replaced file (CAS); `from_path` = rename. |
| `DELETE /repos/{owner}/{repo}/contents/{filepath}` | both | `write:repository` | invalidates `refs_version` | Returns **200** with `FileDeleteResponse` (not 204); requires `sha`. |
| `POST /repos/{owner}/{repo}/contents` | both | `write:repository` | invalidates `refs_version` | Batch `files[]` of `{operation: create\|update\|delete, path, content, sha}` in one commit. |
| `POST /repos/{owner}/{repo}/diffpatch` | engine | `write:repository` | invalidates `refs_version` | Body `UpdateFileOptions`-like with `content` = patch text; engine-side apply (am) — new engine capability, see open questions. |
| `GET /repos/{owner}/{repo}/raw/{filepath}` | engine | `read:repository` | Cache API | Legacy `{ref}/{filepath}` **path-embedded ref** parsing plus a `ref` query param — route ambiguity rules needed (slash-bearing branch names). |
| `GET /repos/{owner}/{repo}/media/{filepath}` | engine | `read:repository` | Cache API | Same handler family as raw; LFS-aware (redirect/pointer resolution) — depends on LFS SPEC. |
| `GET /repos/{owner}/{repo}/archive/{archive}` | engine | `read:repository` | Cache API + clone-cache | `{archive}` = `REF.tar.gz` or `REF.zip` — ref embedded with format suffix; streaming CPU-bound (SPEC-0001 budget). |
| `GET /repos/{owner}/{repo}/assignees` | D1 | `read:repository` | none | Valid assignees = collaborators + owner; feeds the issue-assign automation. |
| `GET /repos/{owner}/{repo}/editorconfig/{filepath}` | engine (file read) | `read:repository` | `refs_version` | Reads `.editorconfig` from the repo tree and resolves the section for `filepath`. |
| `GET /repos/{owner}/{repo}/issue_templates` | engine (file read) | `read:repository` | `refs_version` | Reads `.gitea/ISSUE_TEMPLATE/` from the tree — D1-free. |
| `GET/POST /repos/{owner}/{repo}/issues` | D1 | `read:`/`write:issue` | none | POST → **201**; **412** when the repo has issues disabled; `index` is per-repo sequence; `type=pulls` makes the list double as PR listing. As-built divergence (2026-10-28, the api review's S2 policy decision — kept intentional): our POST **validates** the `milestone`/`labels` refs — an unknown or foreign-repo milestone → 404 `milestone does not exist [id: X, repo_id: Y]`, an unknown/inapplicable label → 404 (issues service `validateMilestone`/`validateLabels`, `src/issues/service.ts:455-471`; both arms pinned in `api/issues.test.ts`) — where upstream **silently drops** them (`models/issues/issue_update.go:371` "Assume milestone is invalid and drop silently", `:426` "Silently drop invalid labels"). Deliberate: fail-loud beats silent-drop for an API born without upstream's history — a client that mistypes a ref learns immediately instead of receiving a 201 whose payload quietly lacks it. |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/issues/{index}` | D1 | `read:`/`write:issue` | none | PATCH returns **201** (upstream quirk, keep it); **412** issues-disabled. |
| `GET /repos/{owner}/{repo}/issues/comments` | D1 | `read:issue` | none | Repo-wide feed; paginated. |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/issues/comments/{id}` | D1 | `read:`/`write:issue` | none | Comment id is **global**, not per-issue (separate id space from issue index). |
| `GET/POST /repos/{owner}/{repo}/issues/{index}/comments` | D1 | `read:`/`write:issue` | none | POST → 201; `since`/`before` RFC3339 filters. |
| `GET/PUT/POST/DELETE /repos/{owner}/{repo}/issues/{index}/labels` | D1 | `read:`/`write:issue` | none | Verb semantics: PUT = replace all, POST = add, DELETE = clear all (no id in path). |
| `GET /repos/{owner}/{repo}/issues/{index}/timeline` | D1 | `read:issue` | none | Mixed comment + event stream; upstream event types are an implicit contract (fixture them). |
| `GET /repos/issues/search` | D1 | `read:issue` | none | Cross-repo; `type`/`state`/`labels` filters; 422 validation errors. |
| `GET/POST /repos/{owner}/{repo}/labels` | D1 | `read:`/`write:issue` | none | Color must match `#RRGGBB` else 422. |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/labels/{id}` | D1 | `read:`/`write:issue` | none | Label id is repo-scoped. |
| `GET/POST /repos/{owner}/{repo}/milestones` | D1 | `read:`/`write:issue` | none | `state` defaults to **open**. |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/milestones/{id}` | D1 | `read:`/`write:issue` | none | id is repo-scoped numeric. |
| `GET/POST /repos/{owner}/{repo}/pulls` | both | `read:`/`write:repository` | none | `state` defaults to **open**; POST validates base/head refs against the engine. |
| `GET/PATCH /repos/{owner}/{repo}/pulls/{index}` | D1 | `read:`/`write:repository` | none | PR and issue index spaces are **shared** (a PR *is* an issue upstream); PATCH → 412 variants. |
| `GET /repos/{owner}/{repo}/pulls/{base}/{head}` | D1 + engine ref check | `read:repository` | none | Two extra path params — route must not collide with `/{index}` (upstream uses type discrimination). |
| `GET /repos/{owner}/{repo}/pulls/{index}.{diffType}` | engine | `read:repository` | Cache API | Raw text diff/patch; `.{diffType}` dot-suffix path parameter. |
| `GET /repos/{owner}/{repo}/pulls/{index}/commits` | engine + D1 | `read:repository` | Cache API | `CommitList` is one of the only two swagger responses that declare the `X-Page`/`X-Total-Count` header family. As-built divergence (2026-10-28, the engine review's range-order fix): the list is NEWEST-first with newest-side pagination (upstream page 1 = the newest `limit` commits, git-log order over merge_base..head) — the engine's oldest-first walk is reversed behind a bounded window (250) and the page slices the reversed order; `X-Total-Count` keeps the so-far approximation. |
| `GET /repos/{owner}/{repo}/pulls/{index}/files` | engine | `read:repository` | Cache API | `ChangedFileList` — the other response declaring `X-Total-Count`/`X-Page`… headers. |
| `GET/POST /repos/{owner}/{repo}/pulls/{index}/merge` | both | `read:`/`write:repository` | n/a | POST body `do` enum `merge|rebase|rebase-merge|squash|fast-forward-only|manually-merged`; not-mergeable → **405** (empty); DELETE (cancel automerge) may slip to tier 2. |
| `POST /repos/{owner}/{repo}/merge-upstream` | both | `write:repository` | invalidates `refs_version` | Fast-forwards/merges upstream branch for forks; returns `{merge_style, …}`. |
| `GET/POST /repos/{owner}/{repo}/releases` | D1 (+engine when release creates a missing tag) | `read:`/`write:repository` | none | POST → **201**; creating a release for a nonexistent tag creates the tag (`target_commitish`, default branch when absent — the shared tag-store service, SPEC-0005 §2.3 as-built); 409 duplicate (before any git write); an existing git tag rides; unresolvable target → **404** `target not found` with no row; protected tag → **422** `release tag name is protected […]`; drafts create no tag; `tag_message` → annotated tag. |
| `GET /repos/{owner}/{repo}/releases/latest` | D1 | `read:repository` | none | Excludes drafts and prereleases — the install-script contract. |
| `GET/DELETE /repos/{owner}/{repo}/releases/tags/{tag}` | D1 | `read:`/`write:repository` | none | Resolve release by tag name; DELETE by tag → 204. |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/releases/{id}` | D1 | `read:`/`write:repository` | none | Release id is **global**, not per-repo (like comment ids). |
| `GET/POST /repos/{owner}/{repo}/releases/{id}/assets` | D1 + R2 | `read:`/`write:repository` | none | POST consumes `multipart/form-data` **or** `application/octet-stream`; must stream (AGENTS rule); over-limit → **413**. |
| `GET/POST /repos/{owner}/{repo}/statuses/{sha}` | D1 | `read:`/`write:repository` | none | POST state enum includes `warning`/`skipped`; sha may be a ref; the CI reporting endpoint. |
| `GET /repos/{owner}/{repo}/commits/{ref}/statuses` | D1 | `read:repository` | none | Sort enum `oldest|recentupdate|leastupdate|leastindex|highestindex`; state filter enum. |
| `GET /repos/{owner}/{repo}/commits/{ref}/status` | D1 | `read:repository` | none | **Combined** status (worst-of aggregation) — distinct model `CombinedStatus`. |
| `GET/PUT/DELETE /repos/{owner}/{repo}/subscription` | D1 | `read:`/`write:repository` | none | Watch state; PUT returns **200 with `WatchInfo`** (not 204); DELETE → 204. |
| `GET/POST /repos/{owner}/{repo}/hooks` | D1 | `read:`/`write:repository` (admin) | none | `CreateHookOption.active` defaults to **false**; `type` enum of 10 providers; `config` is a free map (`url`, `content_type`, `secret`). |
| `GET/PATCH/DELETE /repos/{owner}/{repo}/hooks/{id}` | D1 | `read:`/`write:repository` (admin) | none | id repo-scoped; PATCH is full-ish update of type/config/events. |
| `POST /repos/{owner}/{repo}/hooks/{id}/tests` | D1 + Queue | `write:repository` (admin) | n/a | Fires a test delivery — Queue consumer owns the outbound HTTP (subrequest budget). |
| `GET /repos/{owner}/{repo}/hooks/{id}/deliveries` | D1 | `read:repository` (admin) | none | Delivery log rows must be written by the Queue consumer. |

### 2.5 Response conventions (extracted from the contract)

- **Error body**: runtime body is `{"message": string, "url": string}` (upstream
  `APIError` struct, `modules/structs/miscellaneous.go`). **Swagger quirk to preserve,
  not copy**: the contract declares `message`/`url` as response *headers* (named
  responses `error`/`forbidden`/`unauthorized`/`validationError`/`repoArchivedError`)
  because of swagger-go's generation from Go struct tags. Our zod schemas emit the
  JSON body; the CI diff treats the header-declared fields as body fields
  (§5, known-diff list). `notFound`, `empty`, `conflict` have **no body** (204-style
  empty on 404/405/409 respectively). `invalidTopicsError` (422) adds `invalidTopics: string[]`.
- **Status-code census** (operations): 200×330, 204×150, 404×463, 403×178, 422×132,
  400×112, 201×87, 423×60, 409×33, 401×10, 500×5, 405×6, 202×4, 205×3, 412×3,
  413×3, plus one each of 302/303/304. Notable semantics: **423** = repo archived
  (all 60 are mutations); **405** on `POST tags`/merge/teams = empty-repo / not-mergeable
  / wrong-repo-mode, *not* method-unsupported; **409** includes `EmptyRepository`
  (commit/status ops on a repo with no commits); **412** = feature disabled
  (issues/projects off); **202** = async accepted (fork, transfer, org-wide delete);
  **205** = notifications read; PATCH issue returning **201**; POST tag returning **200**.
- **Pagination**: 118 operations take `page` (1-based) + `limit` (integer query
  params, no defaults declared in the contract). Upstream runtime defaults
  (`modules/setting/api.go`): `page=1`, `limit=30` (`DefaultPagingNum`), clamped to
  `MaxResponseItems=50`; these values are published by `GET /settings/api`
  (`GeneralAPISettings`, tier 3) and must match ours. **Exceptions**: `GET git/trees/{sha}`
  uses `page` + `per_page` and reports `truncated` in the body; two responses
  (`CommitList`, `ChangedFileList`) are the only ones that declare the `X-Page`,
  `X-PageCount`, `X-PerPage`, `X-Total-Count`, `X-HasMore` header family in the
  contract — even though upstream sends `X-Total-Count` on every list at runtime.
- **Runtime list headers (not in the swagger, required by clients)**: `Link:
  <url>; rel="next", …; rel="last", …; rel="first", …; rel="prev"` (emitted only for
  the relations that exist, `services/context/api.go SetLinkHeader`) and
  `X-Total-Count`, both listed in `Access-Control-Expose-Headers`. Our contract test
  asserts these separately from the schema diff (§5).
- **Timestamps**: RFC3339 / `date-time` strings — 108 properties across the 233
  definitions (`created_at`, `updated_at`, `archived_at`, `Commit.created`, …).
  Git-identity dates (`CommitUser.date`) are plain strings carrying the git author
  date. D1 columns store UTC; serialization is `toISOString()`.
- **Common models** (shape-frozen by the diff): `Repository` (71 props, incl. the
  `permissions` block, `empty`, `default_branch`, counters), `User` (23 props; email
  visibility rules), `Commit` (RepoCommit + author/committer `User` + `stats`/`files`),
  `PayloadCommit` (branch/tag responses), `Branch` (wraps `PayloadCommit` + protection
  flags), `Tag` (`commit: CommitMeta`), `ContentsResponse` (21 props incl. `_links`,
  base64 `content`), `GitTreeResponse` (`tree[]`, `truncated`, `total_count`).
- **Auth surface in the contract**: `securityDefinitions` = BasicAuth,
  AuthorizationHeaderToken (`Authorization: token <token>`), deprecated query params
  `access_token`/`token` (removal announced for Gitea 1.23 — we do **not** implement
  the query-param forms), `Sudo` header/`sudo` param (admin impersonation), TOTP
  header. SPEC-0002 owns token semantics; scope categories are
  `all, read|write:{activitypub, admin, misc, notification, organization, package,
  issue, repository, user}` (`models/auth/access_token_scope.go`), enforced per route
  group upstream (`tokenRequiresScopes`).

### 2.6 Explicitly deferred (tier 3)

- **admin/** (22 paths): user/org/repo administration, cron, emails, unadopted repos,
  Actions administration. Requires the admin scope category and instance-level tables.
- **settings/** (4 paths): instance settings introspection (also needed by clients to
  discover pagination limits — revisit at tier 2 of misc).
- **notifications** (3 paths): needs the `notification` scope category and the
  notifications tables; also the only place upstream uses 205.
- **activitypub**: zero paths in the vendored contract (upstream registers the routes
  as `NotImplemented` stubs and omits them from the swagger) — documented as never
  until upstream ships it.
- **Gitea Actions** (55 paths), **packages** (7), **projects + wiki** (38): separate
  SPECs; see appendix A for the exact path lists.

## 3. Data model deltas

This SPEC consumes SPEC-0002 (`users`, `tokens`, org/team tables) and SPEC-0003
(`repositories` registry with `storage_key`, `refs_version`, `visibility`) unchanged.
Deltas and pull-forwards it forces:

1. **SPEC-0005 tables pulled forward into the tier-1 build**: tier 1 ships issue,
   comment, label, milestone, release, release-attachment, webhook, and commit-status
   reads/writes. SPEC-0005 must define (at minimum): `issues` (per-repo `index`
   sequence **and** global row id — both appear in the API), `comments` (global id),
   `labels`, `milestones`, `releases` (global id, tag join), `attachments` (R2 key
   layout for release assets), `hooks` + `hook_deliveries` (Queue-consumer log),
   `commit_statuses`, `issue_labels`, `stars`, `watch` (`subscription`), `topics`
   (string list or table), `collaborators` (or reuse SPEC-0002's ACL table).
2. **Counters**: `Repository` exposes `branch_count`, `open_issues_count`,
   `open_pr_counter`, `release_counter`, `stars_count`, `watchers_count`,
   `forks_count`. Decide maintained columns vs computed-on-read (recommendation:
   maintained for the issue/PR counters which are D1-cheap, computed for
   `branch_count` from the RepoDO refs snapshot).
3. **`refs_version` cache keys**: tier-1 engine reads (branches, tags, refs, trees,
   blobs, contents, raw, archive, commits) key their Cache API entries by
   `repositories.refs_version` per SPEC-0001 §5. The API layer never invents cache
   keys outside that scheme.
4. **Engine delta — API-side commits**: `POST/PUT/DELETE contents`, `POST contents`
   (batch), `POST diffpatch`, `POST branches`, `POST tags`, and release-implied tag
   creation construct commits **without** a git push. SPEC-0001's receive path must
   expose an internal "commit-builder" entry point on the RepoDO (tree write → commit
   write → ref CAS) reusing pack indexing; this is the largest engine amendment
   implied by tier 1 and is called out in the open questions.
5. **No new D1 tables are invented here** — the table list above is a requirement
   spec for SPEC-0005, not a schema. Drizzle migrations land with SPEC-0005.

## 4. Edge cases, limits, failure modes

- **Path-parameter ambiguity**: branch/tag/ref names may contain `/` and dots;
  `raw/{filepath}` and `media/{filepath}` embed the ref *inside* the path
  (`{ref}/{filepath}` legacy form). Routing must (a) treat `branches/{branch}`,
  `tags/{tag}`, `git/refs/{ref}` as greedy tail segments (URL-decoded), and
  (b) resolve `{ref}/{filepath}` by the upstream algorithm: try `refs/heads/<pfx>`,
  `refs/tags/<pfx>`, then commit-sha prefix; prefer the `ref` query param when present.
- **`.{diffType}` suffix routes** (`git/commits/{sha}.{diffType}`,
  `pulls/{index}.{diffType}`): the suffix is part of the last path segment — zod
  route patterns must capture `(.+)\.(diff|patch)` without swallowing filenames that
  contain dots.
- **Union response shapes**: `contents` returns an object for a file and an array for
  a directory (and the same endpoint family is the only place this happens). Clients
  depend on it; the zod schema must be a discriminated union, not a normalization.
- **Pagination clamps** (upstream `services/convert/utils.go ToCorrectPageSize`):
  `page <= 0` → `1`; `limit <= 0` → `DefaultPagingNum` (30); `limit > MaxResponseItems`
  → `50` — clamped silently, never a 422. `git/trees` `per_page` has its own cap
  (extract the exact value from an oracle run against a real instance).
- **Archived repos**: every mutation on an archived repo → **423** with the error
  body. This includes contents writes, branch/tag creation, PR merge, release edits
  (60 operations carry `repoArchivedError`).
- **Empty repos**: reads that need objects return 404 (branches list is empty 200),
  but commit/status endpoints return **409** `EmptyRepository`, and `POST tags` →
  **405**. The `Repository.empty` flag drives client behavior and must be accurate
  from create-by-push (SPEC-0003).
- **Feature-disabled repos**: issues/PR endpoints on a repo with `has_issues=false`
  → **412**; external-tracker repos can legitimately have issues disabled while PRs
  stay on.
- **Attachment uploads**: release/issue assets accept `multipart/form-data` or
  raw octet-stream; bodies must stream to R2 (never buffer; AGENTS rule); over-limit
  → 413; comment/issue attachments exist in the swagger but are tier 2.
- **Webhook delivery**: `hooks/{id}/tests` and real deliveries run in a Queue
  consumer with its own subrequest budget; delivery records feed
  `hooks/{id}/deliveries`. Delivery timeouts must not block the API response (204-style).
- **Error-body quirk**: when diffing against the vendored contract, `error`-family
  responses are header-declared; see §2.5 — the compat checker carries an explicit
  conversion note, never a silent skip.
- **Anonymous vs 401/403/404**: the ACL matrix (when a missing token is 401 vs a
  lacking permission 403 vs anti-enumeration 404) is SPEC-0003's; tier-1 routes must
  call into that single decision point, not re-implement it.

## 5. Testing plan

Contract discipline (ADR D3, flare-forge rule) has three CI stages, all using the
**frozen vendored contract** (`gitea/templates/swagger/v1-swagger.generated.json`,
pinned per ADR D5; copied verbatim into `src/compat/contract/` by a regeneration
script — never edited, never hand-patched):

1. **Route-contract check (static)**: the Hono app exposes its route registry
   (`@hono/zod-openapi` `openAPIDocument()` plus a manifest of raw routes). A CI job
   normalizes both sides (method + concrete path template, `{param}` syntax, mount
   prefix `/api/v1`) and asserts: every served route exists in the vendored contract;
   every *tier-1* contract path exists in the served registry. A served route with no
   contract entry **fails CI**; a tier-1 path with no route fails CI.
2. **Response-schema diff (static)**: for tier-1 operations, compare our declared
   zod response schemas against the contract's status codes and schema shapes
   (the 2.0 contract is converted once to JSON Schema at pin time). Rules: status
   codes must be a **subset** of the contract's for the operation (extra codes are a
   failure); response model fields must cover the contract's required fields with
   matching types/names; additive optional fields are allowed and must be documented
   in the SPEC. The `error`-family header→body conversion (§2.5) and the two
   `X-*` header families are encoded as explicit, commented exceptions in the checker.
3. **Compat suite (dynamic)**: `@cloudflare/vitest-pool-workers` suite that boots the
   Worker with real local D1/DO/R2, seeds fixtures (a user, a repo created by API,
   pushed content via the git e2e path from SPEC-0001's harness), then **enumerates
   every tier-1 operation** asserting: status code, `Content-Type`, body shape against
   golden fixtures (captured once from a real Gitea instance in ADR-D4 oracle mode and
   checked in as fixtures), pagination headers (`Link` relations, `X-Total-Count`) on
   list endpoints, and the error body shape `{message, url}`. Anonymous/private/403/404
   matrix cases come from SPEC-0003's table.

Non-contract tests (behavioral): unit tests per service module; the pagination clamp
defaults (30/50) asserted against `GET /settings/api` values once tier-2 misc lands;
archive/zip streaming under the vitest pool with size fixtures. The oracle-mode runner
(ADR D4) stays a manual/nightly job, not a merge gate.

## 6. Open questions (resolve with SPEC-0002/0003, or at implementation)

1. **`/version` string**: report the pinned upstream Gitea version (D5, maximum
   client compatibility — SDKs gate behavior on it) or a cf-gitea-specific version?
   Recommendation: pinned upstream version string, with the real version discoverable
   later via a non-contract header if needed.
   **Resolved 2026-10-24 (orchestrator review): pinned upstream version string**,
   format matched to upstream's runtime version composition at the current pin;
   single constant so a re-pin updates one line.
2. **Engine commit-builder surface** (§3.4): the contents-write, branch/tag-create,
   and diffpatch endpoints need a Worker→RepoDO API to construct commits outside a
   receive-pack. Amend SPEC-0001 with this entry point (tree/commit object writes +
   ref CAS through the same lease/CAS machinery) before implementing those routes.
   **Resolved 2026-10-24: designed in `specs/0001a-split-plane-amendment.md`** (same
   engine-surface design pass as the M2 split-plane work).
3. **Release asset storage**: R2 bucket + key layout and max asset size (413
   threshold); shared with the LFS SPEC's presign pattern?
4. **Fork object sharing** (§2.4 `POST forks` 202): lazy shared packs vs copy; owner
   of the decision is SPEC-0003/0005.
   **Resolved 2026-10-24 (`specs/0001b-merge-fork-primitives.md` §5): full copy at
   fork time, queue-driven** (R2 server-side pack copies + catalog row replication);
   no cross-repo pack sharing — sharing breaks SPEC-0003 §2.5.5's prefix purge and
   M3 compaction. Related (0001b §10.8): `pulls/{index}.{diffType}` and `/files` are
   composed reads — the API service module owns the composition (mergeability check
   supplies the merge-base); the engine never sees PR rows.
5. **Milestone/label/issue id scoping details** (repo-scoped vs global id spaces)
   must be settled in SPEC-0005's schema before the issue routes are written — the
   contract forces *both* to exist (`issues/{index}` per-repo vs `comments/{id}` global).
6. **Tree `per_page` cap and combined-status aggregation order**: extract from oracle
   run against a real 1.22 instance rather than from the swagger (undocumented).
7. **Tier-2 pull-forward**: `/settings/api` (4 paths) is cheap and publishes the
   pagination limits clients read — candidate to promote into tier 1 late; decision
   deferred.

## Appendix A: full path taxonomy

All 350 paths of the vendored contract, with methods, category (§2.2), and tier
(§2.3). T2 = tier 2 (categories a–e remainder), T3 = tier 3 (deferred f–k). Generated
programmatically from `gitea/templates/swagger/v1-swagger.generated.json`; regenerate
with the same script on re-pin.

| Path | Methods | Cat | Tier |
|---|---|---|---|
| `/admin/actions/jobs` | GET | h | T3 |
| `/admin/actions/runners` | GET | h | T3 |
| `/admin/actions/runners/registration-token` | POST | h | T3 |
| `/admin/actions/runners/{runner_id}` | GET,DELETE,PATCH | h | T3 |
| `/admin/actions/runs` | GET | h | T3 |
| `/admin/cron` | GET | f | T3 |
| `/admin/cron/{task}` | POST | f | T3 |
| `/admin/emails` | GET | f | T3 |
| `/admin/emails/search` | GET | f | T3 |
| `/admin/hooks` | GET,POST | f | T3 |
| `/admin/hooks/{id}` | GET,DELETE,PATCH | f | T3 |
| `/admin/orgs` | GET | f | T3 |
| `/admin/packages` | GET | f | T3 |
| `/admin/unadopted` | GET | f | T3 |
| `/admin/unadopted/{owner}/{repo}` | POST,DELETE | f | T3 |
| `/admin/users` | GET,POST | f | T3 |
| `/admin/users/{username}` | DELETE,PATCH | f | T3 |
| `/admin/users/{username}/badges` | GET,POST,DELETE | f | T3 |
| `/admin/users/{username}/keys` | POST | f | T3 |
| `/admin/users/{username}/keys/{id}` | DELETE | f | T3 |
| `/admin/users/{username}/orgs` | POST | f | T3 |
| `/admin/users/{username}/rename` | POST | f | T3 |
| `/admin/users/{username}/repos` | POST | f | T3 |
| `/gitignore/templates` | GET | g | T3 |
| `/gitignore/templates/{name}` | GET | g | T3 |
| `/label/templates` | GET | g | T3 |
| `/label/templates/{name}` | GET | g | T3 |
| `/licenses` | GET | g | T3 |
| `/licenses/{name}` | GET | g | T3 |
| `/markdown` | POST | g | T1 |
| `/markdown/raw` | POST | g | T1 |
| `/markup` | POST | g | T3 |
| `/notifications` | GET,PUT | k | T3 |
| `/notifications/new` | GET | k | T3 |
| `/notifications/threads/{id}` | GET,PATCH | k | T3 |
| `/org/{org}/repos` | POST | a | T2 |
| `/orgs` | GET,POST | a | T2 |
| `/orgs/{org}` | GET,DELETE,PATCH | a | T2 |
| `/orgs/{org}/actions/jobs` | GET | h | T3 |
| `/orgs/{org}/actions/runners` | GET | h | T3 |
| `/orgs/{org}/actions/runners/registration-token` | POST | h | T3 |
| `/orgs/{org}/actions/runners/{runner_id}` | GET,DELETE,PATCH | h | T3 |
| `/orgs/{org}/actions/runs` | GET | h | T3 |
| `/orgs/{org}/actions/secrets` | GET | h | T3 |
| `/orgs/{org}/actions/secrets/{secretname}` | PUT,DELETE | h | T3 |
| `/orgs/{org}/actions/variables` | GET | h | T3 |
| `/orgs/{org}/actions/variables/{variablename}` | GET,PUT,POST,DELETE | h | T3 |
| `/orgs/{org}/activities/feeds` | GET | a | T2 |
| `/orgs/{org}/avatar` | POST,DELETE | a | T2 |
| `/orgs/{org}/blocks` | GET | a | T2 |
| `/orgs/{org}/blocks/{username}` | GET,PUT,DELETE | a | T2 |
| `/orgs/{org}/hooks` | GET,POST | a | T2 |
| `/orgs/{org}/hooks/{id}` | GET,DELETE,PATCH | a | T2 |
| `/orgs/{org}/labels` | GET,POST | a | T2 |
| `/orgs/{org}/labels/{id}` | GET,DELETE,PATCH | a | T2 |
| `/orgs/{org}/members` | GET | a | T2 |
| `/orgs/{org}/members/{username}` | GET,DELETE | a | T2 |
| `/orgs/{org}/projects` | GET,POST | j | T3 |
| `/orgs/{org}/projects/{id}` | GET,DELETE,PATCH | j | T3 |
| `/orgs/{org}/projects/{id}/columns` | GET,POST | j | T3 |
| `/orgs/{org}/projects/{id}/columns/move` | POST | j | T3 |
| `/orgs/{org}/projects/{id}/columns/{column_id}` | GET,DELETE,PATCH | j | T3 |
| `/orgs/{org}/projects/{id}/columns/{column_id}/default` | POST | j | T3 |
| `/orgs/{org}/projects/{id}/columns/{column_id}/issues` | GET | j | T3 |
| `/orgs/{org}/projects/{id}/columns/{column_id}/issues/{issue_id}` | POST,DELETE | j | T3 |
| `/orgs/{org}/projects/{id}/issues/{issue_id}/move` | POST | j | T3 |
| `/orgs/{org}/projects/{id}/workflows` | GET,POST | j | T3 |
| `/orgs/{org}/projects/{id}/workflows/{workflow_id}` | GET,DELETE,PATCH | j | T3 |
| `/orgs/{org}/public_members` | GET | a | T2 |
| `/orgs/{org}/public_members/{username}` | GET,PUT,DELETE | a | T2 |
| `/orgs/{org}/rename` | POST | a | T2 |
| `/orgs/{org}/repos` | GET,POST | a | T1 |
| `/orgs/{org}/teams` | GET,POST | a | T2 |
| `/orgs/{org}/teams/search` | GET | a | T2 |
| `/packages/{owner}` | GET | i | T3 |
| `/packages/{owner}/{type}/{name}` | GET,DELETE | i | T3 |
| `/packages/{owner}/{type}/{name}/-/latest` | GET | i | T3 |
| `/packages/{owner}/{type}/{name}/-/link/{repo_name}` | POST | i | T3 |
| `/packages/{owner}/{type}/{name}/-/unlink` | POST | i | T3 |
| `/packages/{owner}/{type}/{name}/{version}` | GET,DELETE | i | T3 |
| `/packages/{owner}/{type}/{name}/{version}/files` | GET | i | T3 |
| `/repos/issues/search` | GET | d | T1 |
| `/repos/migrate` | POST | b | T2 |
| `/repos/search` | GET | b | T1 |
| `/repos/{owner}/{repo}` | GET,DELETE,PATCH | b | T1 |
| `/repos/{owner}/{repo}/actions/artifacts` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/artifacts/{artifact_id}` | GET,DELETE | h | T3 |
| `/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/jobs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/jobs/{job_id}` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/jobs/{job_id}/logs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runners` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runners/registration-token` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runners/{runner_id}` | GET,DELETE,PATCH | h | T3 |
| `/repos/{owner}/{repo}/actions/runs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}` | GET,DELETE | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/approve` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/artifacts` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/attempts/{attempt}/jobs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/cancel` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/force-cancel` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/jobs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/jobs/{job_id}/rerun` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/logs` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/rerun` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/runs/{run}/rerun-failed-jobs` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/secrets` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/secrets/{secretname}` | PUT,DELETE | h | T3 |
| `/repos/{owner}/{repo}/actions/tasks` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/variables` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/variables/{variablename}` | GET,PUT,POST,DELETE | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}` | GET | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable` | PUT | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` | POST | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable` | PUT | h | T3 |
| `/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` | GET | h | T3 |
| `/repos/{owner}/{repo}/activities/feeds` | GET | b | T2 |
| `/repos/{owner}/{repo}/archive/{archive}` | GET | c | T1 |
| `/repos/{owner}/{repo}/assignees` | GET | d | T1 |
| `/repos/{owner}/{repo}/assignees/{assignee}` | GET | d | T2 |
| `/repos/{owner}/{repo}/avatar` | POST,DELETE | b | T2 |
| `/repos/{owner}/{repo}/branch_protections` | GET,POST | b | T2 |
| `/repos/{owner}/{repo}/branch_protections/priority` | POST | b | T2 |
| `/repos/{owner}/{repo}/branch_protections/{name}` | GET,DELETE,PATCH | b | T2 |
| `/repos/{owner}/{repo}/branches` | GET,POST | c | T1 |
| `/repos/{owner}/{repo}/branches/{branch}` | GET,PUT,DELETE,PATCH | c | T1 |
| `/repos/{owner}/{repo}/collaborators` | GET | b | T1 |
| `/repos/{owner}/{repo}/collaborators/{collaborator}` | GET,PUT,DELETE | b | T1 |
| `/repos/{owner}/{repo}/collaborators/{collaborator}/permission` | GET | b | T2 |
| `/repos/{owner}/{repo}/commits` | GET | c | T1 |
| `/repos/{owner}/{repo}/commits/{ref}/status` | GET | c | T1 |
| `/repos/{owner}/{repo}/commits/{ref}/statuses` | GET | c | T1 |
| `/repos/{owner}/{repo}/commits/{sha}/pull` | GET | c | T1 |
| `/repos/{owner}/{repo}/compare/{basehead}` | GET | c | T1 |
| `/repos/{owner}/{repo}/contents` | GET,POST | c | T1 |
| `/repos/{owner}/{repo}/contents-ext/{filepath}` | GET | b | T2 |
| `/repos/{owner}/{repo}/contents/{filepath}` | GET,PUT,POST,DELETE | c | T1 |
| `/repos/{owner}/{repo}/diffpatch` | POST | b | T1 |
| `/repos/{owner}/{repo}/editorconfig/{filepath}` | GET | c | T1 |
| `/repos/{owner}/{repo}/file-contents` | GET,POST | c | T2 |
| `/repos/{owner}/{repo}/forks` | GET,POST | b | T1 |
| `/repos/{owner}/{repo}/git/blobs/{sha}` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/commits/{sha}` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/commits/{sha}.{diffType}` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/notes/{sha}` | GET | c | T2 |
| `/repos/{owner}/{repo}/git/refs` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/refs/{ref}` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/tags/{sha}` | GET | c | T1 |
| `/repos/{owner}/{repo}/git/trees/{sha}` | GET | c | T1 |
| `/repos/{owner}/{repo}/hooks` | GET,POST | e | T1 |
| `/repos/{owner}/{repo}/hooks/git` | GET | e | T2 |
| `/repos/{owner}/{repo}/hooks/git/{id}` | GET,DELETE,PATCH | e | T2 |
| `/repos/{owner}/{repo}/hooks/{id}` | GET,DELETE,PATCH | e | T1 |
| `/repos/{owner}/{repo}/hooks/{id}/deliveries` | GET | e | T1 |
| `/repos/{owner}/{repo}/hooks/{id}/deliveries/{uuid}` | GET | e | T2 |
| `/repos/{owner}/{repo}/hooks/{id}/tests` | POST | e | T1 |
| `/repos/{owner}/{repo}/issue_config` | GET | d | T2 |
| `/repos/{owner}/{repo}/issue_config/validate` | GET | d | T2 |
| `/repos/{owner}/{repo}/issue_templates` | GET | d | T1 |
| `/repos/{owner}/{repo}/issues` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/issues/comments` | GET | d | T1 |
| `/repos/{owner}/{repo}/issues/comments/{id}` | GET,DELETE,PATCH | d | T1 |
| `/repos/{owner}/{repo}/issues/comments/{id}/assets` | GET,POST | d | T2 |
| `/repos/{owner}/{repo}/issues/comments/{id}/assets/{attachment_id}` | GET,DELETE,PATCH | d | T2 |
| `/repos/{owner}/{repo}/issues/comments/{id}/reactions` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/pinned` | GET | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}` | GET,DELETE,PATCH | d | T1 |
| `/repos/{owner}/{repo}/issues/{index}/assets` | GET,POST | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/assets/{attachment_id}` | GET,DELETE,PATCH | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/assignees` | POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/assignees/{assignee}` | GET | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/blocks` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/comments` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/issues/{index}/comments/{id}` | DELETE,PATCH | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/deadline` | POST | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/dependencies` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/labels` | GET,PUT,POST,DELETE | d | T1 |
| `/repos/{owner}/{repo}/issues/{index}/labels/{id}` | DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/lock` | PUT,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/pin` | POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/pin/{position}` | PATCH | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/reactions` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/stopwatch/delete` | DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/stopwatch/start` | POST | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/stopwatch/stop` | POST | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/subscriptions` | GET | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/subscriptions/check` | GET | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/subscriptions/{user}` | PUT,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/timeline` | GET | d | T1 |
| `/repos/{owner}/{repo}/issues/{index}/times` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/issues/{index}/times/{id}` | DELETE | d | T2 |
| `/repos/{owner}/{repo}/keys` | GET,POST | b | T2 |
| `/repos/{owner}/{repo}/keys/tokens` | POST | b | T2 |
| `/repos/{owner}/{repo}/keys/{id}` | GET,DELETE | b | T2 |
| `/repos/{owner}/{repo}/labels` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/labels/{id}` | GET,DELETE,PATCH | d | T1 |
| `/repos/{owner}/{repo}/languages` | GET | c | T1 |
| `/repos/{owner}/{repo}/licenses` | GET | b | T2 |
| `/repos/{owner}/{repo}/media/{filepath}` | GET | c | T1 |
| `/repos/{owner}/{repo}/merge-upstream` | POST | b | T1 |
| `/repos/{owner}/{repo}/milestones` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/milestones/{id}` | GET,DELETE,PATCH | d | T1 |
| `/repos/{owner}/{repo}/mirror-sync` | POST | b | T2 |
| `/repos/{owner}/{repo}/new_pin_allowed` | GET | b | T2 |
| `/repos/{owner}/{repo}/notifications` | GET,PUT | b | T2 |
| `/repos/{owner}/{repo}/projects` | GET,POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}` | GET,DELETE,PATCH | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns` | GET,POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns/move` | POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns/{column_id}` | GET,DELETE,PATCH | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/default` | POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues` | GET | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/columns/{column_id}/issues/{issue_id}` | POST,DELETE | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/issues/{issue_id}/move` | POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/workflows` | GET,POST | j | T3 |
| `/repos/{owner}/{repo}/projects/{id}/workflows/{workflow_id}` | GET,DELETE,PATCH | j | T3 |
| `/repos/{owner}/{repo}/pulls` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/pulls/comments/{id}/resolve` | POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/comments/{id}/unresolve` | POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/pinned` | GET | d | T2 |
| `/repos/{owner}/{repo}/pulls/{base}/{head}` | GET | d | T1 |
| `/repos/{owner}/{repo}/pulls/{index}` | GET,PATCH | d | T1 |
| `/repos/{owner}/{repo}/pulls/{index}.{diffType}` | GET | d | T1 |
| `/repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies` | POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/commits` | GET | c | T1 |
| `/repos/{owner}/{repo}/pulls/{index}/files` | GET | d | T1 |
| `/repos/{owner}/{repo}/pulls/{index}/merge` | GET,POST,DELETE | d | T1 |
| `/repos/{owner}/{repo}/pulls/{index}/requested_reviewers` | POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/reviews` | GET,POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/reviews/{id}` | GET,POST,DELETE | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments` | GET | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/dismissals` | POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/reviews/{id}/undismissals` | POST | d | T2 |
| `/repos/{owner}/{repo}/pulls/{index}/update` | POST | d | T2 |
| `/repos/{owner}/{repo}/push_mirrors` | GET,POST | b | T2 |
| `/repos/{owner}/{repo}/push_mirrors-sync` | POST | b | T2 |
| `/repos/{owner}/{repo}/push_mirrors/{name}` | GET,DELETE | b | T2 |
| `/repos/{owner}/{repo}/raw/{filepath}` | GET | c | T1 |
| `/repos/{owner}/{repo}/releases` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/releases/latest` | GET | d | T1 |
| `/repos/{owner}/{repo}/releases/tags/{tag}` | GET,DELETE | c | T1 |
| `/repos/{owner}/{repo}/releases/{id}` | GET,DELETE,PATCH | d | T1 |
| `/repos/{owner}/{repo}/releases/{id}/assets` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}` | GET,DELETE,PATCH | d | T2 |
| `/repos/{owner}/{repo}/reviewers` | GET | d | T2 |
| `/repos/{owner}/{repo}/signing-key.gpg` | GET | b | T2 |
| `/repos/{owner}/{repo}/signing-key.pub` | GET | b | T2 |
| `/repos/{owner}/{repo}/stargazers` | GET | b | T2 |
| `/repos/{owner}/{repo}/statuses/{sha}` | GET,POST | d | T1 |
| `/repos/{owner}/{repo}/subscribers` | GET | b | T2 |
| `/repos/{owner}/{repo}/subscription` | GET,PUT,DELETE | b | T1 |
| `/repos/{owner}/{repo}/tag_protections` | GET,POST | b | T2 |
| `/repos/{owner}/{repo}/tag_protections/{id}` | GET,DELETE,PATCH | b | T2 |
| `/repos/{owner}/{repo}/tags` | GET,POST | c | T1 |
| `/repos/{owner}/{repo}/tags/{tag}` | GET,DELETE | c | T1 |
| `/repos/{owner}/{repo}/teams` | GET | b | T2 |
| `/repos/{owner}/{repo}/teams/{team}` | GET,PUT,DELETE | b | T2 |
| `/repos/{owner}/{repo}/times` | GET | d | T2 |
| `/repos/{owner}/{repo}/times/{user}` | GET | d | T2 |
| `/repos/{owner}/{repo}/topics` | GET,PUT | b | T1 |
| `/repos/{owner}/{repo}/topics/{topic}` | PUT,DELETE | b | T2 |
| `/repos/{owner}/{repo}/transfer` | POST | b | T1 |
| `/repos/{owner}/{repo}/transfer/accept` | POST | b | T2 |
| `/repos/{owner}/{repo}/transfer/reject` | POST | b | T2 |
| `/repos/{owner}/{repo}/wiki/new` | POST | j | T3 |
| `/repos/{owner}/{repo}/wiki/page/{pageName}` | GET,DELETE,PATCH | j | T3 |
| `/repos/{owner}/{repo}/wiki/pages` | GET | j | T3 |
| `/repos/{owner}/{repo}/wiki/revisions/{pageName}` | GET | j | T3 |
| `/repos/{template_owner}/{template_repo}/generate` | POST | b | T2 |
| `/repositories/{id}` | GET | b | T1 |
| `/settings/api` | GET | f | T3 |
| `/settings/attachment` | GET | f | T3 |
| `/settings/repository` | GET | f | T3 |
| `/settings/ui` | GET | f | T3 |
| `/signing-key.gpg` | GET | g | T3 |
| `/signing-key.pub` | GET | g | T3 |
| `/teams/{id}` | GET,DELETE,PATCH | a | T2 |
| `/teams/{id}/activities/feeds` | GET | a | T2 |
| `/teams/{id}/members` | GET | a | T2 |
| `/teams/{id}/members/{username}` | GET,PUT,DELETE | a | T2 |
| `/teams/{id}/repos` | GET | a | T2 |
| `/teams/{id}/repos/{org}/{repo}` | GET,PUT,DELETE | a | T2 |
| `/token` | GET,DELETE | a | T2 |
| `/topics/search` | GET | g | T3 |
| `/user` | GET | a | T1 |
| `/user/actions/jobs` | GET | h | T3 |
| `/user/actions/runners` | GET | h | T3 |
| `/user/actions/runners/registration-token` | POST | h | T3 |
| `/user/actions/runners/{runner_id}` | GET,DELETE,PATCH | h | T3 |
| `/user/actions/runs` | GET | h | T3 |
| `/user/actions/secrets/{secretname}` | PUT,DELETE | h | T3 |
| `/user/actions/variables` | GET | h | T3 |
| `/user/actions/variables/{variablename}` | GET,PUT,POST,DELETE | h | T3 |
| `/user/applications/oauth2` | GET,POST | a | T2 |
| `/user/applications/oauth2/{id}` | GET,DELETE,PATCH | a | T2 |
| `/user/avatar` | POST,DELETE | a | T2 |
| `/user/blocks` | GET | a | T2 |
| `/user/blocks/{username}` | GET,PUT,DELETE | a | T2 |
| `/user/emails` | GET,POST,DELETE | a | T2 |
| `/user/followers` | GET | a | T2 |
| `/user/following` | GET | a | T2 |
| `/user/following/{username}` | GET,PUT,DELETE | a | T2 |
| `/user/gpg_key_token` | GET | a | T2 |
| `/user/gpg_key_verify` | POST | a | T2 |
| `/user/gpg_keys` | GET,POST | a | T2 |
| `/user/gpg_keys/{id}` | GET,DELETE | a | T2 |
| `/user/hooks` | GET,POST | e | T2 |
| `/user/hooks/{id}` | GET,DELETE,PATCH | e | T2 |
| `/user/keys` | GET,POST | a | T2 |
| `/user/keys/{id}` | GET,DELETE | a | T2 |
| `/user/orgs` | GET | a | T1 |
| `/user/projects` | GET,POST | j | T3 |
| `/user/projects/{id}` | GET,DELETE,PATCH | j | T3 |
| `/user/projects/{id}/columns` | GET,POST | j | T3 |
| `/user/projects/{id}/columns/move` | POST | j | T3 |
| `/user/projects/{id}/columns/{column_id}` | GET,DELETE,PATCH | j | T3 |
| `/user/projects/{id}/columns/{column_id}/default` | POST | j | T3 |
| `/user/projects/{id}/columns/{column_id}/issues` | GET | j | T3 |
| `/user/projects/{id}/columns/{column_id}/issues/{issue_id}` | POST,DELETE | j | T3 |
| `/user/projects/{id}/issues/{issue_id}/move` | POST | j | T3 |
| `/user/projects/{id}/workflows` | GET,POST | j | T3 |
| `/user/projects/{id}/workflows/{workflow_id}` | GET,DELETE,PATCH | j | T3 |
| `/user/repos` | GET,POST | b | T1 |
| `/user/settings` | GET,PATCH | a | T1 |
| `/user/starred` | GET | b | T1 |
| `/user/starred/{owner}/{repo}` | GET,PUT,DELETE | b | T1 |
| `/user/stopwatches` | GET | d | T2 |
| `/user/subscriptions` | GET | b | T2 |
| `/user/teams` | GET | a | T2 |
| `/user/times` | GET | d | T2 |
| `/users/search` | GET | a | T1 |
| `/users/{username}` | GET | a | T1 |
| `/users/{username}/activities/feeds` | GET | a | T2 |
| `/users/{username}/followers` | GET | a | T2 |
| `/users/{username}/following` | GET | a | T2 |
| `/users/{username}/following/{target}` | GET | a | T2 |
| `/users/{username}/gpg_keys` | GET | a | T2 |
| `/users/{username}/heatmap` | GET | a | T2 |
| `/users/{username}/keys` | GET | a | T2 |
| `/users/{username}/orgs` | GET | a | T2 |
| `/users/{username}/orgs/{org}/permissions` | GET | a | T2 |
| `/users/{username}/projects` | GET | j | T3 |
| `/users/{username}/repos` | GET | a | T1 |
| `/users/{username}/starred` | GET | a | T2 |
| `/users/{username}/subscriptions` | GET | a | T2 |
| `/users/{username}/tokens` | GET,POST | a | T2 |
| `/users/{username}/tokens/{token}` | DELETE | a | T2 |
| `/version` | GET | g | T1 |


**Error-family note (2026-10-25, d598626)**: untyped internal 500s render
the constant "internal server error" (upstream's user-facing string,
helper.go:41 / context.go:272) — the empty-message 500 that faithfully
mirrored upstream's prod-blanked APIErrorInternal (api.go:117-130) proved
undebuggable in production (the D1-bench finding). Deliberate exceptions
that still render "": the typed ApiError(500, "") seams (collaborators
inactive-account, pulls StringsToInt64s) — upstream declares those exact
bodies in the frozen contract.
