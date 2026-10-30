# cf-gitea v1.3.1 — Release Notes (the convergence supplement)

**Range**: `fe6d1a8..FINAL_HEAD_TBD` — **FINAL_COUNT_TBD commits** (75 at the
refresh snapshot, HEAD `affe9a3`; the doc's original snapshot was 46 at
`e4b9f66`). v1.3 tagged `fe6d1a8`; every commit below
landed after that tag, the same day (2026-10-30). This document is the
convergence supplement the v1.3 notes' close-out pointed at; read it together
with `docs/RELEASE-NOTES-v1.3.md`, which it does not replace. It landed as
`0fdc267` at the 46-commit snapshot and was refreshed at the window's tail
to cover the grown range.

The wave's shape: six read-only parity reviews (`d605d3e` auth, `9032c92`
api, `e9358fd` webui, `db020f9` git, `27654cb` actions, `3646b72` packages),
a session-authenticated link crawl of the deployed instance (`71f56f2`, 428
URLs), and the five-wave usability findings/reverify sweep (`bac61a8`,
`1e17fca`, `b9f537a`, `27353a2`, `560f0df`, re-verified in `4c7e076`,
`72cc1e0`, `1703bc6`) — each read-only record followed by its fix wave,
organized below by user-visible surface. A word on method: several fix units
died at the concurrency wall with their work complete in the tree; the
orchestrator verified the surviving work against the pin, completed its pins,
and landed it — those commits say so explicitly. The window's second half —
everything after the `0fdc267` snapshot — folds in the LFS locking family,
the packages D-4/5/6 + serve-content wave, the api review's remainder (unit
gates, E9, `assigned_by`, repoEdit merge fields, the counts seam, the
release family whole), the webui merge box + branch-selector island, the
archive git-semantics wave, and the pre-deploy verification chain (the
convergence verification record, the gate pre-run, both local smokes) with
the tag runbook.

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
- **LFS file locking is live** (`7b589c7`). The git review's locks-501
  MEDIUM closed upstream-exact: list/create/verify/unlock with
  `CheckAcceptMediaType` 415s, scope levels (list/verify Read,
  create/unlock Write), signed auth on all four (anonymous 401s even on
  public repos, realm `gitea-lfs`), the `?id=`/`?path=`/cursor paging arms
  with upstream's page-number cursor quirk, duplicate-create 409 echoing
  the existing lock (case-insensitive via a D1-race-safe `lower_path`
  unique index — migration `0045`), and upstream's unlock
  bug-compatibility kept: every delete error maps to one 500 (the pin has
  no 404/403 arm). The 501 is retired; SPEC-0006 §2.7 rewritten as LANDED.
- **LFS JSON envelopes drop the trailing newline** (`95cdcaf`). The locks
  wave's recorded INFO, reconciled family-wide: batch/upload/verify bodies
  and error arms match the pin's newline-free jsonv2 encoder
  byte-for-byte; Go's own plain-text 404/500 shapes kept as-is.

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
- **The `/user` counts seam renders, degrades, and pins** (`58283bd`, wired
  `40120ae`, degrade `9f883d0`, pin `93e9c0b`). Upstream renders the raw
  `NumFollowers`/`NumFollowing` columns (`convert/user.go:107-111`); our
  row has no counter columns, so the seam renders the requester-visible
  live totals — a private follower never counts for a viewer who can't see
  them (the documented divergence). `GET /users/{username}` rides the async
  twin; `GET /user` re-reads the row for the self view (every follower
  counts, private included); lists stay flat. The whole seam is
  best-effort: no binding, a lookup miss, or a counts read degrades to the
  auth middleware's sync render instead of 500-ing. The same landing
  renders topics/licenses from their stored sets (the converter's
  hardcoded `[]` retired) and deletes the stale identities serializer
  copy.
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
  wrapper. Disclosed: the archived-repo arm keeps our 201 where upstream
  maps its failure to a bare 500 — recorded in `docs/residuals-v1.4.md`;
  the `sha1`/`num_commits` tail has since closed (`efd1916`, below).
- **The release family is whole** (`efd1916`, `29ecd1d`). The kept-open
  tail closed: the row fills `sha1`/`num_commits`/`created` from the TAGGED
  COMMIT (committer time — "an old commit does not become the latest
  release"; `num_commits` capped at the engine's 5,000-commit scan, the
  documented honest-partial arm). UpdateRelease ported whole: every
  published edit re-runs createTag (edit-created tags are always
  lightweight; publish-from-draft finally lands its tag; a post-edit draft
  zeroes `published_unix` — the withdraw arm), the fill rides every
  published edit, and the notify fork emits "published" only when a tag
  was actually created. Upstream never deletes the old ref on rename (the
  old tag stays orphaned), and our `releases_repo_tag_uq` unique index
  answers 500 on rename-onto-existing-tag where upstream would write
  duplicate rows — recorded (`docs/residuals-v1.4.md` P3-14).
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
- **The issue/pull family carries upstream's unit gates** (`ddf3b2a`, the
  api review's item 10 + the auth review §7). `/issues` closes with
  mustEnableIssuesOrPulls and `/pulls` with mustAllowPulls +
  reqRepoReader(TypeCode) at upstream's exact chain position — a disabled
  unit is unreadable to everyone including owner and site-admin, both
  gates answer the exact 404 `{message:'not found',url:swagger}`, and
  mustNotBeArchived keeps its 423. `/labels` and `/milestones` verified
  ungated upstream and pinned so. **Behavior change**: the archived-repo
  pulls-CREATE pin flipped 423→404 (the group gate shadows the 423 over
  the whole `/pulls` subtree). Documented divergences: the IsEmpty arm
  omitted until isEmpty maintenance lands, the TypeCode read vacuous, the
  pre-existing DELETE-comment 423-on-archived kept as-is.
- **E9: comment bodies are required and locked issues refuse non-writers**
  (`d2fd6f0`). Create and edit both carry upstream's Required binding —
  absent or empty body answers 422 in middleware before the handler (two
  additive runtime-only response rows; neither op's swagger declared 422)
  — and the lock check sits after requireIssue before the blocked-user
  arm: non-writer 403 with upstream's exact locale message,
  collaborator-writer and site-admin pass.
- **repoEdit carries the fifteen merge-config fields; `assigned_by`
  filters both list arms** (`7047639`, `4f8ade7`). The `pull_requests`
  unit row stores the Go-marshal PullRequestsConfig JSON
  (`has_pull_requests:false` deletes the row, re-enable at defaults;
  flags-only PATCHes merge over the loaded config), `projects_mode` rides
  the projects row, the update-style trio's verbatim 400s gate on the
  caller touching one of the three fields, and the repo render reads all
  fifteen wire keys from the settings overlay — **disclosed behavior
  change**: `allow_manual_merge` now renders false (the pre-wave true was
  upstream's unit-less fallback, the wrong one of its two postures).
  Bonus, upstream-faithful: an unknown `default_branch` target on a
  non-empty repo silently keeps the old default (upstream 500s on read
  errors; ours degrades to skip). `assigned_by` resolves through the
  `issue_assignees` subquery (upstream's numeric-arm INNER JOIN) on the
  repo-scoped list and global `/repos/issues/search`; `mentioned_by`
  stays the empty-set sentinel — no mention store.
- **Smaller contract fixes**: repo-create echoes the sent `description`
  (the settings-row serialization gap, `1677dbb`); the release detail
  surface carries the two-item Releases/Tags sub-menu upstream renders on
  every list render (`1677dbb`); `merged_commit_sha` was verified live under
  its real key (the finding's premise corrected, `4c7e076`).

## 4. Web UI

- **The merge box mounts and the branch selector becomes the island**
  (`91b7909`, the webui review's top drifts 5 and 1). The conversation
  page mounts the full merge card server-side: OPEN PRs get the whole
  card (checking line, blockers, status-check section, command-line
  instructions — `pull_merge_box.go:89-191` verified faithful),
  closed-unmerged PRs get upstream's ClosedInfo pair (the "renders
  nothing closed" residual is gone), merged PRs render nothing (upstream's
  `ShowMergeBox=false`). The branch selector is rewritten to
  `branch_dropdown.tmpl`'s island shape — `data-global-init` +
  `initRepoBranchTagSelector` and the ~20 `data-*` attrs, the menu the
  official bundle's client-DOM render over the already-landed
  `/branches/list` + `/tags/list` aux endpoints. Documented reductions:
  `allow-create-new-ref` and `enable-feed` false, no server-rendered menu
  items — exactly upstream's own page shape.
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
- **Archive downloads became git-archive semantics** (`5365236`, the git
  review's archive MEDIUM). export-ignore honored with git's exact
  precedence (tree-only `.gitattributes`, deeper beats shallower, last
  matching line wins, subtree pruning, the re-include arms), zip entries
  DEFLATE (method 8, raw CRC-32, honest sizes) instead of STORE, and
  export-subst parsed but not substituted — the documented disposition,
  since git expands `$Format:…$` through machinery we don't have
  engine-side yet.
- **The archive POST arm is pinned whole and gains upstream's empty-repo
  gate** (`e9a6595`). The four arms pinned (the signed-in fast path,
  guard-first 403, the 404 ladder, the anonymous POST on the fast path —
  the group's gates are auth methods, no reqSignIn), and the pin unit's
  probe caught a real divergence: a never-pushed repo's POST answered 200
  where upstream's `MustBeNotEmpty` group gate 404s both arms — the check
  is in, and the never-pushed repo now 404s like its GET twin.
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
- **The packages review's D-4/D-5/D-6 close** (`41eada6`). The nuget
  service index (`/`, `/index.json`, `/$metadata`) is deliberately
  unauthenticated upstream — ours now matches, anonymous 200 even for
  private owners (**behavior change**; unknown owners still 404); the
  three quota 403 sentinels byte-match upstream's texts; and a
  serve-content port brings `ctx.ServeContent`'s whole header/byte-serving
  set to every download arm (nosniff, the CSP family, Cache-Control,
  Content-Disposition through the byte-verified port, RFC 7232
  preconditions including the `If-None-Match:*` 304, single-range 206
  with normal/suffix/open-ended/clamped Content-Range, the 416 shape).
  One documented divergence: multi-range serves a full 200 where Go
  answers multipart/byteranges.
- **The pypi unicode-filename mojibake is fixed** (`2757a9e`). The
  multipart header decode was latin1 — a UTF-8 `ü` stored as `Ã¼` and
  GET-by-sent-name 404'd. The decode is UTF-8 now (red-first pin), the
  remaining latin1 sites (helm/npm tar-member headers, maven's label
  sniff) verified correct usages.
- **A zero-start Range slices too** (`f3e9f63`). The pre-deploy smoke's
  fix-before-deploy find: `bytes=0-9`/`bytes=0-0` answered 206 with the
  FULL body under the full content-length — the composer's `start > 0`
  guard was a falsy-zero check. Every 206 slices now (serve-content
  24/24), closing the first-segment corruption resumable clients would
  hit.

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

The post-snapshot chain adds the window's own verification layer:

- The convergence verification record (`635a573`): 98 suites, 2,551
  results, all green, run in a detached worktree pinned at `29ecd1d`
  (auth 392, actions 196, api 310, ui 700, packages 191, plus the
  supplemental sweeps). Two coverage gaps found and closed in-window: the
  archive POST pins (`e9a6595`) and the counts degrade pin (`93e9c0b`).
- The composite gate's pre-run verdict (`8e1d44c`): PASS at `d2fd6f0`,
  zero real reds — 342 files, 7,740 passed + 42 skipped, 0 ws1009 deaths;
  the three phase-1 reds all adjudicated solo-green (ADR-0006's harness
  classes). The tag-time final run still executes at the release HEAD.
- Both pre-deploy local smokes. The git-surface smoke (`6766af5`; six
  surfaces PASS with real git 2.43.0 / git-lfs 3.4.1) surfaced TWO HIGH
  fix-before-deploy finds — `gdt_` deploy tokens are REJECTED by the LFS
  endpoints (upstream mounts the LFS routes WITH AllowDeployToken,
  `web.go:1777`), killing every deploy-token clone of an LFS repo at
  smudge; and `PUT /repos/{o}/{r}/collaborators/{user}` 500s for
  write/admin/empty permission, so collaborators cannot be added via the
  API — both fixes in flight at the refresh snapshot, to land before the
  tag. The api/ui smoke (`d21beb5`; five surfaces PASS) found one real
  bug — the zero-start Range, fixed `f3e9f63` before deploy — and
  recorded three LOW findings.
- The docs chain: the v1.3.1 tag runbook (`873def4`; eight verified
  steps, four precedent corrections — including that REMOTE needs BOTH
  0044 and 0045, both postdating v1.3's deploy), the residuals
  post-landing reconciliation (`dc0a5bf`; all 48 hashes verified, every
  in-flight row resolved with its hash, the board extended P2-10,
  P3-14, P3-15), the guides freshness sweep (`ae1de6d`), the cite audit
  (`48d4929`; 25 renumber pairs, machine-verified), the specs index
  refresh (`9a6804c`; seven rows, cat-file-verified), and the README
  status-table refresh (`affe9a3`).

## 7. Engineering notes

- Test-only and lint landings: the dispatch bare-404 audit shapes pinned
  (`e92f786`), the empty-repo arm flip's missed pins closed (`9c4c71a`),
  the audit sort-arrow negative scoped to the table header (`0bd9bac`),
  the counts degrade arm's dedicated pin (`93e9c0b`), and two
  dead-import recoveries (`c77effe`, `c8fbda2`).
- Window scale: 218 files changed, +24.5k/-0.9k lines at the `e4b9f66`
  snapshot; 278 files, +42.3k/-1.7k at the refresh — the majority
  goldens, tests, and the `docs/usability/` records.

## 8. Compatibility notes

- **Two new migrations**: `0044` (the `cron_state` table) and `0045` (the
  `lfs_locks` table). Apply with the deploy as usual
  (`pnpm db:migrate:remote`); both postdate v1.3's deploy, which applied
  only 0041-0043 (`873def4`).
- **Behavior changes to test against**: scopeless/read-limited tokens now
  403 on gated `/api/v1` paths (`56109ec`); duplicate package files now
  409 (`3571fe8`); chunked (no Content-Length) package uploads are
  accepted (`3571fe8`); sessions expire on idle, not at an absolute 24h
  (`69036c8`); the git-HTTP Basic realm string changed (`85fa2ff`); OIDC
  audience/subject values changed to the upstream-correct shapes —
  consumers keying on the old malformed values must re-bind (`e3b55a8`);
  release creation with a fresh `tag_name` now writes the ref (`6b2bedc`)
  and every published release edit re-runs createTag with `created_at`
  filled from the tagged commit (`29ecd1d`, `efd1916`); signup no longer
  accepts password fields (`058d76e`); LFS locks answer upstream-exact
  where the family 501'd (`7b589c7`) and LFS JSON bodies lost their
  trailing newline (`95cdcaf`); the nuget service index answers
  anonymously, private owners included (`41eada6`); the issue/pull family
  404s on disabled units and archived-repo pulls-CREATE flipped 423→404
  (`ddf3b2a`); comment create/edit with an absent or empty body now 422
  and locked issues 403 non-writer comments (`d2fd6f0`);
  `allow_manual_merge` renders false (`7047639`); archive zips carry
  DEFLATE entries and honor export-ignore (`5365236`); a never-pushed
  repo's archive request 404s both arms (`e9a6595`).
- **Specs amended in-window**: SPEC-0002, SPEC-0003, SPEC-0004, SPEC-0005,
  SPEC-0006, SPEC-0010, SPEC-0012, SPEC-0016.

## 9. Known limitations

The consolidated v1.4 backlog is `docs/residuals-v1.4.md` (updated in this
window; the post-landing reconciliation `dc0a5bf` resolved every
in-flight-at-doc-time row and extended the board). The wave's own disclosed
tails: the Actions notify/commit-status tails and reusable-caller cascade
stage to M3 (`e4b9f66`); the archived-repo release arm keeps its 201
(`6b2bedc`; the `sha1`/`num_commits` tail has since closed, `efd1916`);
`language` renders `''` on both user serializers until the side store
exists (`cf269f4`); API-side `last_login` remains the recorded SPEC-0005
follow-up — the D1 row has no column (`cf269f4`, `58283bd`; the follower/
following counts themselves landed, §3). New in the second half: the two
HIGH pre-deploy smoke finds (deploy-token LFS rejection, the collaborators
PUT 500) have their fixes in flight at the refresh snapshot, to land
before the tag (`6766af5`); export-subst is parsed but not substituted
(`5365236`); package downloads answer a full 200 on multi-range requests
(`41eada6`); release rename-onto-existing-tag 500s on our unique index
where upstream would write duplicates, and every rename orphans the old
ref as upstream does (`29ecd1d`); and the unit gates' documented
divergences (the IsEmpty arm, the vacuous TypeCode read) stage behind
isEmpty maintenance (`ddf3b2a`, P3-15).
