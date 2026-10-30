# cf-gitea v1.3.1 — Release Notes (the convergence supplement)

**Range**: `fe6d1a8..FINAL_HEAD_TBD` — **FINAL_COUNT_TBD commits** (46 at the
doc-time snapshot, HEAD `e4b9f66`). v1.3 tagged `fe6d1a8`; every commit below
landed after that tag, the same day (2026-10-30). This document is the
convergence supplement the v1.3 notes' close-out pointed at; read it together
with `docs/RELEASE-NOTES-v1.3.md`, which it does not replace.

The wave's shape: six read-only parity reviews (`d605d3e` auth, `9032c92`
api, `e9358fd` webui, `db020f9` git, `27654cb` actions, `3646b72` packages),
a session-authenticated link crawl of the deployed instance (`71f56f2`, 428
URLs), and the five-wave usability findings/reverify sweep (`bac61a8`,
`1e17fca`, `b9f537a`, `27353a2`, `560f0df`, re-verified in `4c7e076`,
`72cc1e0`, `1703bc6`) — each read-only record followed by its fix wave,
organized below by user-visible surface. A word on method: several fix units
died at the concurrency wall with their work complete in the tree; the
orchestrator verified the surviving work against the pin, completed its pins,
and landed it — those commits say so explicitly.

## 1. Git and auth

- **Deploy-key tokens work over git-HTTP** (`85fa2ff`). `gdt_`-prefixed
  256-bit deploy tokens ride Basic auth only, act as the actor for their own
  repo's code+wiki units at the key's mode, zero-permission 404 on foreign
  repos, and touch last-used through SPEC-0002 §2.7's 24h throttle. Before
  this fix a deploy key was a D1 row with no credential path.
- **The Basic realm stops fighting GCM** (`85fa2ff`). The git-HTTP challenge
  now emits upstream's OAuth2-disabled realm, `Basic realm="Gitea (Basic
  Auth)"` (`githttp.go:152-158`) — the parity review had flagged our
  always-upstream-shaped realm as GCM-hostile: Git Credential Manager entered
  a doomed OAuth2 round-trip + 401 loop before falling back to a PAT. It no
  longer tries.
- **Sessions idle-slide instead of dying at 24h absolute** (`69036c8`).
  Upstream's only expiry check is a re-armed idle clock; ours now mirrors it —
  24h idle for non-remember logins, 31 days idle with "remember me", re-armed
  on every authenticated request. Active users are no longer logged out
  mid-session. Cookie rotation moved to its own 24h clock and is now actually
  reachable (the review's H2: with both clocks anchored at mint, rotation
  could never fire on a still-valid session). SPEC-0010 §2.3 amended in-change.
- **Signup and login disclose the token flow** (`058d76e`). The signup page
  no longer shows password fields that would be silently discarded — the
  PAT-only posture (SPEC-0002's ratified divergence) renders as upstream's
  `DisablePassword` shape with an upfront notice. Login relabels its field
  "Access Token" with a helper where upstream's forgot-password slot sits.
  The wire is untouched; password managers still retain the PAT.

## 2. Actions

- **OIDC audience and subject are byte-exact** (`e3b55a8`). The default
  audience was malformed (`https://hostowner` — AppURL's trailing slash
  stripped then concatenated); it now composes `https://host/owner` with the
  owner Go-path-escaped, and the immutable subject reads
  `repo:owner@ownerId/slug@repoId` instead of interpolating the full repo
  name into the owner segment (`oidc.go:173-182`). Every audience/subject-
  keyed OIDC consumer unbroken; issuer and all three call sites carry the
  same shape.
- **The dispatch bind ceiling is gone** (`e3b55a8`). Owner-runner scans used
  to materialize every scoped repo id into one `inArray`, breaching D1's
  100-bind limit past ~95 repos — every `FetchTask` 500'd. The scope
  condition now mirrors upstream's `jobCond` leg-for-leg: an IN over the
  `repo_unit` subquery, one bind for the owner id at any repo count.
- **Cancel mapping and the three always-on sweeps wired** (`e4b9f66`).
  `UpdateTask` answers the 60s cancelling handshake with upstream's
  CANCELLING→CANCELLED status map instead of echoing `result=UNSPECIFIED`;
  the terminal stopTask carries the piggybacked ephemeral-delete,
  tasks_version bump, and log archival (upstream's `stopTasks` loop,
  `clear_tasks.go:151-193`). Three sweeps ported from upstream's nightly
  Cleanup: endless tasks (RUNNING past 3h) stop as FAILURE, abandoned jobs
  (waiting/blocked/pending past 24h) cancel through the task_id=0 CAS, and
  ephemeral-runner cleanup runs unconditionally. Platform mapping follows the
  ratified retention shape — one indexed existence probe + at most one queue
  message per sweep; crons enqueue, consumers work. Disclosed: the
  notify/commit-status tails and the reusable-caller cascade remain M3
  (module-header note; tracked in `docs/residuals-v1.4.md`).

## 3. API

- **`GET /user` answers row truth, and every User payload carries
  `username`** (`cf269f4`, completing `1703bc6`). The auth serializer no
  longer renders hardcoded defaults: `visibility`, `type`,
  `starred_repos_count`, absolute `avatar_url`/`html_url` come from the row
  in upstream's `ToUser(doer, doer)` self-viewer shape. The `username`
  compat key — upstream adds it at runtime via `MarshalJSON`
  (`structs/user.go:67-73`, invisible to swagger) — renders from the login
  column on every User payload, with the contract harness teaching the
  field-level RUNTIME_ONLY class.
- **The profile quartet projects from the row everywhere** (`a5936fe`).
  `description`/`website`/`location` render on the tier-1 readers
  (`GET /users/{username}`, `/user`, `/users/search`, the repo listings'
  embedded owner) and on every issue/pull/release/commit actor payload,
  instead of hardcoded empty strings. NULL still renders `''` per upstream's
  zero value.
- **A release with a fresh `tag_name` now creates its git tag**
  (`6b2bedc`). Upstream's create-tag arm ported arm-for-arm:
  target_commitish resolution (absent → default branch), ride-an-existing-tag
  without duplication, 422 on protected tag names, 404 with no row when the
  target can't resolve, annotated tags when `tag_message` is set, drafts
  deferring the write to publish. The web create form rides the same
  wrapper. Disclosed: `sha1`/`num_commits` stay unwritten (the engine-wave
  tail) and the archived-repo arm keeps our 201 where upstream maps its
  failure to a bare 500 — both recorded in `docs/residuals-v1.4.md`.
- **Token scopes gate the whole `/api/v1` tree** (`56109ec`). The
  `requireScope` port was mounted only on the token-CRUD router — a
  `read:user`-only or scopeless token passed every other endpoint, writes
  included (the auth review's H1). The gate now mounts once at the router
  top with upstream's group table (`api.go:1009-1872`): method-derived
  levels exactly upstream, anonymous credentials pass to the route's own
  401, and the 403 body is byte-identical to the old one. **Behavior
  change**: scopeless tokens now fail every gated path.
- **The PR merge surface accepts upstream's casing and composes default
  messages** (`2854fb4`). `{"Do":"merge"}` and friends parse again —
  upstream's swagger documents the PascalCase keys and the runtime accepts
  both via a custom `UnmarshalJSON` (`repo_form.go:419-463`), so go-sdk/tea
  clients can merge PRs; the alias layer preserves the exact `IfZero`
  precedence and leaves the emitted OpenAPI byte-identical. Merge commits
  compose upstream's default messages ("Merge pull request '#{title}'
  (#{index}) from {head} into {base}", squash `{title} (#{index})`, rebase
  empty). No `.gitea/default_merge_message` template resolution — recorded
  divergence.
- **Smaller contract fixes**: repo-create echoes the sent `description`
  (the settings-row serialization gap, `1677dbb`); the release detail
  surface carries the two-item Releases/Tags sub-menu upstream renders on
  every list render (`1677dbb`); `merged_commit_sha` was verified live under
  its real key (the finding's premise corrected, `4c7e076`).

## 4. Web UI

- **The pulls list has its New Pull Request button** (`d52361b`,
  `56df8a6`). Upstream's list-header button over `MakeDefaultCompareLink`
  (`repo.go:56-66`): writers get the live compare link, signed-in
  non-owners get upstream's exact disabled class, anonymous gets the
  login round-trip (mission-directed, disclosed). The static-arms limit
  was retired in the same window: real `canWriteRepo` grants thread
  through the dispatch, so a write-granted collaborator sees the live
  button and the Quick Guide.
- **The empty-repo page branches on writer state** (`d52361b`, pins
  completed `9c4c71a`). The writer Quick Guide leaked to every viewer;
  non-writers now get upstream's single `repo.empty_message` segment
  (`empty.tmpl:74`), exactly the pin.
- **`/api/swagger` exists** (`c69f901`). The link every logged-in user
  sees from their token settings page was dead; the standalone OpenAPI
  viewer page mounts beside the static block, serving both upstream JSON
  arm names (`/swagger.v1.json`, `/openapi3.v1.json`) from the runtime
  registry document — the live 500-operation contract, not a frozen copy.
  Disclosed: upstream serves Swagger-2.0 at the first name; our registry
  emits one OpenAPI 3.0.3 doc and both names serve it.
- **The link crawl's dead links are fixed** (`b6abd2a`, findings
  `71f56f2`). The admin-orgs settings pencil emits the mounted
  `/{org}/settings` shape (it emitted upstream's unmounted alias — 404 for
  every org); activity-page release rows emit the existence-gated
  `/src/tag/{tag}` shape, a D1-only release rendering its title plain; the
  admin-users list stops linking profiles defined to 404 (prohibited
  identities and the synthetic deploy-key row render as plain text).
- **The archive button works** (`4e6d1cc`). Upstream's web UI POSTs
  `/{owner}/{repo}/archive/*` first and aborts on non-JSON; our router
  registered the family GET-only, so no web archive download ever started.
  The POST arm now answers upstream's fast-path `{"complete":true}`
  (`web.go:1691`, `repo.go:381-390`) behind the same-origin guard.
- **The branches page sorts like upstream** (`7f9241e`). The list was
  name-byte-order; it now reads tip commits for the filtered universe and
  sorts commit_time DESC, name ASC — the pin's only order
  (`branch_list.go:89-99`), degraded tips at time 0. The review's
  followers-count premise was verified against the pin first and found
  already upstream-exact; the unit added the missing edge pins instead.
- **The wiki tab, LFS badge, and the header trio land** (`f561d92`). The
  repo header gains the Wiki tab (`header.tmpl:162-166`, unconditional per
  the ratified every-repo-enabled divergence); file views show the LFS
  badge per upstream's 1024-byte pointer probe (`file_info.tmpl:14`);
  Watch/Star/Fork render the upstream trio with the action POST family
  behind them; the clone panel and empty-repo combo follow
  `clone_panel.tmpl`. Wiki URLs with trailing slashes — shapes upstream
  itself emits — reach the sub-app again (`8fdee92`; the parent
  dispatcher's blanket no-trailing-slash admission refused them).
- **Signup/login, demo quota, cleanup rules**: the token-flow disclosure
  (`058d76e`, §1); the web repo-create path enforces the demo quota through
  the API's own helper, re-rendering with upstream's
  `reach_limit_of_creation` banner instead of bypassing (`65f95f1`); the
  packages cleanup-rule create/edit gate was tautological (a boolean-record
  keyed on `Object.keys`) and blocked every create/save on both scopes —
  now a real aggregate check (`f8362b1`).
- **Security headers ship** (`cebefa0`). `X-Content-Type-Options: nosniff`
  and `X-Frame-Options: SAMEORIGIN` tree-wide, upstream's CSP shape on
  HTML responses, no HSTS (upstream sets none). The one documented
  divergence: `unsafe-inline` in the nonce's slot — our ratified
  nonce-less inline artifacts would otherwise kill the official bundle's
  boot. Set-if-absent, body-by-reference, 204/304-safe.
- **`/user/settings` p50 drops ~3x** (`06b3384`, verified `72cc1e0`:
  1.39s → 0.478s). The page's four sequential D1 reads were attributed with
  a recording proxy; the loader's two independent reads run concurrently
  now (the appearance tab's twin folded in). The remaining
  verifySession→navbar serial pair is recorded as the next lever.
- **The cron monitor certifies "did the crons run"** (`64ebfa9`). All
  seven landed arms render with upstream locale names and schedules, plus
  real per-arm tick state — previous run, executions, result, next time —
  from the new `cron_state` store (migration 0044; upstream's in-process
  `TaskTableRow` landed in D1 because Workers crons keep no memory).

## 5. Packages

- **Duplicate uploads 409, always** (`3571fe8`, review `3646b72` D-1).
  Generic and pypi answered 201 for an identical-bytes re-upload where
  upstream's `TryInsertFile` 409s any duplicate regardless of bytes;
  maven/nuget were already correct. The idempotent arm is retired.
- **Unknown-length bodies stream** (`3571fe8`, D-2). A missing
  Content-Length answered 411 where upstream's Go server streams chunked —
  `curl -T -` was broken. Uploads now spool through a bounded R2 multipart
  (8MiB parts, the 512MiB cap enforced on the streamed count), with
  FixedLengthStream kept as the declared-length fast path. All seven 411
  preconditions retired; each family's real terminal answer (scan 400,
  corrupt-gzip 500, tarball 400, zip 400) pinned on the streaming arm.
- **The pypi integrity gate closes** (`3571fe8`, D-3). A missing
  `sha256_digest` published instead of answering upstream's 400
  hash-mismatch — an integrity-gate bypass; the absent-digest arm now
  matches the mismatch arm.
- **The user-scope Packages settings twin mounts** (`74df9ad`), the held-back
  v1.3 landing: the org module's owner-agnostic logic re-exported under
  user-facing names, mounted in the user settings block with the
  nav-tab fold, goldens, and a11y entries. The artifacts preview's
  signed-URL golden lands behind the ROUTE_CLOCK-shaped page clock seam
  (null = exact wall clock; production byte-identical).

## 6. Verification records (read-only, no code)

The wave's evidence base, all committed under `docs/usability/`:

- The six parity reviews: `d605d3e` (auth: two HIGH + one MEDIUM, all fixed
  above), `9032c92` (api: the 15-endpoint semantic review), `e9358fd`
  (webui: no hard bundle-JS breakage; the drifts are silently-absent
  behaviors), `db020f9` (git: one adapter-owned HIGH — the archive button),
  `27654cb` (actions: the wire freeze sound, five semantic drifts), and
  `3646b72` (packages: no happy-path blocker, six ranked drifts).
- The usability findings waves: `bac61a8` (web-form journeys 6/7),
  `1e17fca` (the signup password decoy — fixed `058d76e`), `b9f537a`
  (packages+actions production verification, all pass), `27353a2` (real-git
  E2E — the two HIGH merge blockers fixed `2854fb4`), `560f0df` (latency +
  health smoke).
- The reverify closure: `4c7e076` (git-e2e 9/9), `72cc1e0` (latency/health
  F1-F3 all fixed), `1703bc6` (web-forms 7/7 + first-run five verdicts).
- The link crawl and the runbook handover record: `71f56f2` (428 URLs,
  28 404s classified; the N2 release-tag finding fixed `6b2bedc`).

## 7. Engineering notes

- Test-only and lint landings: the dispatch bare-404 audit shapes pinned
  (`e92f786`), the empty-repo arm flip's missed pins closed (`9c4c71a`),
  the audit sort-arrow negative scoped to the table header (`0bd9bac`),
  and two dead-import recoveries (`c77effe`, `c8fbda2`).
- Window scale: 218 files changed, +24.5k/-0.9k lines — the majority
  goldens, tests, and the `docs/usability/` records.

## 8. Compatibility notes

- **One new migration**: `0044` (the `cron_state` table). Apply with the
  deploy as usual (`pnpm db:migrate:remote`).
- **Behavior changes to test against**: scopeless/read-limited tokens now
  403 on gated `/api/v1` paths (`56109ec`); duplicate package files now
  409 (`3571fe8`); chunked (no Content-Length) package uploads are
  accepted (`3571fe8`); sessions expire on idle, not at an absolute 24h
  (`69036c8`); the git-HTTP Basic realm string changed (`85fa2ff`); OIDC
  audience/subject values changed to the upstream-correct shapes —
  consumers keying on the old malformed values must re-bind (`e3b55a8`);
  release creation with a fresh `tag_name` now writes the ref (`6b2bedc`);
  signup no longer accepts password fields (`058d76e`).
- **Specs amended in-window**: SPEC-0002, SPEC-0003, SPEC-0004, SPEC-0005,
  SPEC-0010, SPEC-0012.

## 9. Known limitations

The consolidated v1.4 backlog is `docs/residuals-v1.4.md` (updated in this
window). The wave's own disclosed tails: the Actions notify/commit-status
tails and reusable-caller cascade stage to M3 (`e4b9f66`); release
`sha1`/`num_commits` stay unwritten and the archived-repo release arm keeps
its 201 (`6b2bedc`); `language` renders `''` on both user serializers until
the side store exists (`cf269f4`); API-side `followers_count`/
`following_count`/`last_login` remain the recorded SPEC-0005 follow-up
(`cf269f4`, `7f9241e`).
