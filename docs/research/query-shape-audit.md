# Query-shape audit — the hot request paths (post index-wave follow-up)

Static, READ-ONLY audit of D1 roundtrip counts and per-row loops on the hot
surfaces, written as the input to the perf wave that follows the index wave
(b04a465). Method: every finding was traced by reading the route handler →
service call chain in the source; no dev server was run and no source files
were touched. Every claim cites `file:line` at the current pin.

Companion context: the index wave removed full-table scans (its rows_read
witness lives in `apps/worker/src/bench-d1.test.ts`); this audit targets the
shape of the queries themselves — how MANY roundtrips a request pays, and
where a list page turns into 1 + N.

## Landing status (2026-10-28)

The fix wave this audit seeded landed the same day. Every hash below was
verified against `git log` at bookkeeping time; the findings themselves are
left as-written (they are the record of the shapes that motivated the fixes).

| Row(s) | Status | Commit |
| --- | --- | --- |
| A1, A4, B2, A10 (the S half) | LANDED | `c614daa` — perf(ui,api): the S-grade N+1 collapse — label batch, dead-batch wire, parallel tree walks |
| A2, A3, A6, B1 | LANDED | `fbd0826` — perf(api): the M-grade list batching — page-independent render contexts, 92-242 roundtrips to 8-10 |
| A5 | LANDED | `42a07cf` — perf(api): A5 timeline batching — the mixed stream goes page-batched, 21→7 at seed |
| A7 | LANDED | `57794e7` — perf(api): tier-2 preload adoption — thirteen more list surfaces go page-independent (both A7 comment lists) |
| A8 | PENDING | in flight at this writing — `57794e7` left the feeds render per-row by design |
| A9 | PENDING | in flight at this writing — the `orgs.ts` per-team coverage-probe loop is unchanged at HEAD |

A10 caveat: only the S-difficulty fix landed (`enrichTreeCommits` runs
concurrent via `Promise.all`, `c614daa`); the real fix — the batched
`listTreeCommits` engine RPC (the L half) — is still open.

## Realistic N (what "seeded demo data" means here)

There is no bulk demo seed script; the realistic N values come from the fixed
page sizes the demo traffic actually serves:

| Surface | Constant | Value | Cite |
| --- | --- | --- | --- |
| UI issues/pulls list page | `ISSUES_PAGE_SIZE` | 20 | `apps/worker/src/ui/pages/issues-list.tsx:86` |
| UI org members page | `ORG_MEMBERS_PAGE_SIZE` | 20 | `apps/worker/src/ui/pages/org-members.tsx:100` |
| UI user profile repo list | `USER_PROFILE_PAGE_SIZE` | 15 | `apps/worker/src/ui/pages/user-profile.tsx:120` |
| UI issue timeline cap | `TIMELINE_LIMIT` | 500 | `apps/worker/src/ui/pages/issue-detail.tsx:226` |
| UI repo-home enrichment budget | `ENRICH_MAX` | 30 | `apps/worker/src/ui/page-data.ts:34` |
| API default / max page | `DEFAULT_PAGING_NUM` / `MAX_RESPONSE_ITEMS` | 30 / 50 | `apps/worker/src/api/pagination.ts:9-10` |
| API commits walk bound | `COMMIT_WALK_BOUND` | 500 | `apps/worker/src/api/routes/commits.ts:62` |
| Bench witness page | list shape | 20 candidates | `apps/worker/src/bench-d1.test.ts:36-43` |

So below, "N" is 20 for the UI issue list, 30 (max 50) for API lists, and the
bench has already measured the UI list shape at "22 queries per op at the
default page size of 20" (`bench-d1.test.ts:43`) — independent confirmation
that the loop shapes counted here are what production executes.

## The fixed per-request baseline (counted once, not a finding)

Every repo-scoped UI page pays this prologue before its loader
(`apps/worker/src/ui/index.ts:4081-4098`, `resolveUiRequest`):

1. session verify — one `sessions ⋈ users` join
   (`apps/worker/src/ui/session.ts:248-253`);
2. the navbar unread-notification count, signed-in viewers only — one
   aggregate over the derived-thread joins
   (`apps/worker/src/ui/pages/notifications.tsx:367-387`, called at
   `apps/worker/src/ui/index.ts:4046-4052`);
3. repo resolution — one `repositories ⋈ users` join
   (`apps/worker/src/ui/repo-view.ts:44-78` via
   `apps/worker/src/git-http/acl.ts:58-89`), plus the grant arms only when the
   cheap ACL matrix misses (`viewerTeamAccessMode` → `doerRepoAccessMode`,
   `apps/worker/src/api/services/repository.ts:152-193`);
4. the Projects unit flag — one PK read
   (`apps/worker/src/ui/index.ts:4096`).

= 4 fixed D1 roundtrips (2 for anonymous). Reasonable; the audit's formulas
below exclude this baseline. API routes pay `requireVisibleRepo` instead:
1 join + grant arms only on a first-pass miss
(`apps/worker/src/api/services/repo-access.ts:47-57`).

---

## A. Confirmed N+1 loops (per-row selects inside loops)

### A1. UI issues/pulls list — per-row label join (the bench-witnessed one) — **LANDED `c614daa`**

- **Route**: `GET /{owner}/{repo}/issues` and `/{owner}/{repo}/pulls`
  (`apps/worker/src/ui/index.ts:8707-8710`).
- **Chain**: `uiPage` → `loadIssuesListData`
  (`apps/worker/src/ui/pages/issues-list.tsx:203-296`) → per item
  `issueLabelRows(d1, issue.id)` (`issues-list.tsx:240-248`) → one
  `issue_labels ⋈ labels` select per issue
  (`apps/worker/src/api/services/issues.ts:135-144`).
- **Formula**: `1-2` (milestone filter resolution,
  `services/issues.ts:591-616`) `+ 6` (three `listRepoIssues` calls — page +
  open-tab count + closed-tab count — each a `count(*)` plus a select,
  `issues-list.tsx:234-238` over `services/issues.ts:685-697`) `+ N` (label
  joins) `+ 3` (batched PR flags / milestones / posters,
  `issues-list.tsx:250-283`) = **9 + N** (+1-2 with the milestone filter).
- **Realistic N**: 20 → **~29 D1 roundtrips per page view**. The bench
  measured the shape: "22 queries per op at the default page size of 20"
  (`apps/worker/src/bench-d1.test.ts:36-43`).
- **Fix shape**: one `issue_labels ⋈ labels` select with
  `inArray(issueLabels.issueId, pageIssueIds)`, grouped in memory — the exact
  pattern the same loader already uses for PR merged flags
  (`issues-list.tsx:252-263`). Bonus: the two tab counts can fold into one
  `GROUP BY is_closed` instead of two extra `listRepoIssues` calls.
- **Difficulty**: S.

### A2. API `GET /repos/{owner}/{repo}/issues` — per-issue `toApiIssue` — **LANDED `fbd0826`**

- **Chain**: `apps/worker/src/api/routes/issues.ts:917-965`; render at
  `:964` — `Promise.all(items.map((issue) => toApiIssue(...)))`. Each
  `toApiIssue` (`apps/worker/src/api/services/issues.ts:244-287`) runs:
  poster select (`:245` via `:185-196`), label join (`:246`), pin-order select
  (`:247` via `:228-236`), milestone select when set (`:248-256`), and a
  `pull_requests` select for PR rows (`:257` via `:199-222`).
- **Formula**: `2` (count + page, `services/issues.ts:688-696`) `+ 0-3`
  (filter resolutions: label names, milestone entries, poster id) `+ N ×
  (3 + milestone?1 + pull?1)` = **2 + N × 3..5**.
- **Realistic N**: 30 (max 50) → **~92-152 D1 roundtrips** per default page.
- **Fix shape**: batch each arm across the page — posters by
  `inArray(users.id)`, labels by `inArray(issueLabels.issueId)`, pins,
  milestones, and PR rows likewise; pass per-issue maps into a render
  function. Upstream batches the same loads on its list paths
  (`LoadAttributes`-style), so parity holds.
- **Difficulty**: M.

### A3. API `GET /repos/{owner}/{repo}/pulls` — per-PR `toApiPullRequest` (heaviest list) — **LANDED `fbd0826`**

- **Chain**: `apps/worker/src/api/routes/pulls.ts:864-915`, render at `:914`.
  Each `toApiPullRequest` (`apps/worker/src/api/services/pulls.ts:396-470`)
  = `toApiIssue` (`:405` → A2's 3-5) + merger row select for merged PRs
  (`:417-423`) + `headBranchInfo` (`:461`; cross-repo fork heads pay
  `findRepositoryById` + `viewerTeamAccessMode` at `:349-351`, same-repo
  heads are free at `:339-347`).
- **Formula**: `2` + `N × (4..8)` = **~122-242 D1 roundtrips** at N=30.
- **Fix shape**: the A2 page-batch, plus batched merger ids and head-repo
  pairs; the visibility mode for head repos can reuse one grant resolution
  per distinct head repo.
- **Difficulty**: M-L.

### A4. API `GET /repos/{owner}/{repo}/commits` — per-commit diff + duplicate email lookups — **LANDED `c614daa`**

- **Chain**: `apps/worker/src/api/routes/commits.ts:197-251`; the route
  batches author emails ONCE (`usernamesByEmail`, `:247`, one
  `inArray(lower(email))` select, `apps/worker/src/api/services/git-models.ts:85-102`),
  then renders each commit via `toApiCommit` (`:248-250`). But `toApiCommit`
  ignores its `usernames` parameter (declared `git-models.ts:188`, never read
  in the body `:190-241`) and instead re-queries the users table TWICE per
  commit — author and committer (`findUserRowByEmail`, `:224-227`, select at
  `:104-113`). Separately, `stat`/`files` default TRUE (`:169`), so every
  list entry also pays one engine `readDiff` RPC per commit (`:208`).
- **Formula**: `1-2` engine RPCs (start-ref resolve + `listLog`) `+ 1` batched
  email select (wasted) `+ N × (2 D1 + 1 engine RPC)`. At N=30:
  **~61 D1 roundtrips + ~32 engine RPCs**.
- **Fix shape**: use the already-fetched map for usernames, and one
  full-row `inArray(lower(email))` select per page for the `User` blocks
  (extend `usernamesByEmail` to return rows). The per-commit `readDiff` is
  engine-bound and already parallel (`Promise.all`); a `diff` precompute key
  exists (`git-models.ts:173`) if a batched RPC lands later.
- **Difficulty**: S.

### A5. API `GET /repos/{owner}/{repo}/issues/{index}/timeline` — serial per-row metadata — **LANDED `42a07cf`**

- **Chain**: `apps/worker/src/api/routes/issues.ts:1558-1576`; the render
  loop at `:1567-1572` is a **serial** `await toTimelineComment` per row.
  Each `toTimelineComment`
  (`apps/worker/src/api/services/issues.ts:391-468`) selects the poster
  (`:398`) plus up to 4 metadata rows — old milestone, milestone, label,
  assignee (`:402-435`, parallel within the row).
- **Formula**: `1` (page select, `:786-793` — no count) `+ R × (1..5)`.
  R = 30 (default limit) → **~31-151 D1 roundtrips, serially awaited**
  (wall clock compounds: each row waits for the previous).
- **Fix shape**: collect poster ids and per-type metadata ids across the
  page first, batch each with `inArray`, then render from maps; parallelize
  the loop (`Promise.all`) as the minimal variant.
- **Difficulty**: M.

### A6. API `GET /repos/issues/search` — serial per-row repo re-resolution — **LANDED `fbd0826`**

- **Chain**: `apps/worker/src/api/routes/issues.ts:1581-1653`; the render
  loop `:1646-1652` re-resolves the repo pair PER ISSUE
  (`findRepositoryById`, `:1647`) before `toApiIssue` (`:1651`), all serial.
  Every issue in the page typically lives in one of a handful of repos, so
  the same rows are re-read up to 30 times.
- **Formula**: `1` (`visibleRepoIds`) `+ 0-4` filters `+ 2` (count+page) `+
  N × (4..6)` → **~123-182 D1 roundtrips, serial**.
- **Fix shape**: one `inArray(repositories.id, distinctRepoIds)` pair fetch +
  the A2 page-batch; `Promise.all` the render.
- **Difficulty**: M.

### A7. API comment lists — per-comment poster select — **LANDED `57794e7`**

- **Routes**: `GET /repos/{owner}/{repo}/issues/comments`
  (`apps/worker/src/api/routes/issues.ts:1070-1079`, render `:1078`) and
  `GET /repos/{owner}/{repo}/issues/{index}/comments` (`:1386-1396`, render
  `:1395`). Each `toApiComment`
  (`apps/worker/src/api/services/issues.ts:295-316`) selects the poster row
  (`:302`).
- **Formula**: `2` (count+page / issue lookup) `+ C × 1`. C = 30 on a default
  comment page → **~32 roundtrips**; an active issue's thread scales with the
  thread length.
- **Fix shape**: one batched poster select for the page (upstream's
  `comments.LoadPosters` is the same fix).
- **Difficulty**: S.

### A8. Activity feed render — per-distinct-repo pairs + per-comment posters — **PENDING** (in flight, 2026-10-28)

- **Chain**: `apps/worker/src/api/services/activity-feeds.ts:490-558`
  (`renderFeedItems`, shared by the `/activities/feeds` API family and the UI
  feeds pages). Act users ARE batched (`:498-500`), but repositories resolve
  through `findRepositoryById` per distinct repo id (`:502-509`), and each
  live comment renders through `toApiComment` (`:520-530`) with its own
  poster select (A7).
- **Formula**: `2` (`getFeedRows`, `:384-397`) `+ 1` (act users) `+ R`
  (distinct repos ≤ page size 20) `+ 2` (comments + issues batches) `+ C`
  (posters) → **~25-45 roundtrips** for a 20-row feed page.
- **Fix shape**: `inArray(repositories.id, repoIds)` pair fetch (the join
  query already exists, `repository.ts:662-665`); batch comment posters.
- **Difficulty**: S-M.

### A9. `OrgService.teamRepoAccessMode` — per-team coverage probes — **PENDING** (in flight, 2026-10-28)

- **Chain**: `apps/worker/src/services/orgs/orgs.ts:710-750`. After one
  teams ⋈ team_members select (`:712-722`), the loop runs a
  `team_repo_access` probe PER TEAM without `includes_all` (`:738-746`).
  This predicate sits inside `doerRepoAccessMode`
  (`repository.ts:152-167`), which every private/limited-grant resolution
  runs — the API route guards, the git-HTTP gate, and the UI repo resolution.
- **Formula**: `1 + T` (T = the viewer's teams in the repo's org; 1-3 in
  demo data, unbounded in general).
- **Fix shape**: reuse the SQL EXISTS twin already written for the list side
  (`teamGrantCondition`, `apps/worker/src/api/services/repository.ts:839-860`)
  as one query, or `inArray` the coverage rows.
- **Difficulty**: S-M.

### A10. Repo home page — serial per-entry engine RPCs (not D1, but the biggest wall-clock N) — **LANDED (S half) `c614daa`**; the batched `listTreeCommits` RPC (the L half) stays open

- **Chain**: `GET /{owner}/{repo}` → `loadHomeData`
  (`apps/worker/src/ui/pages/home.tsx:74-114`) → `enrichTreeCommits`
  (`apps/worker/src/ui/page-data.ts:38-56`): a **serial** `for...await`
  loop issuing one `engine.listLog` RPC per directory entry, capped at
  `ENRICH_MAX = 30` (`page-data.ts:34`). Plus `listRefs` + `readCommit` +
  `listTree` + `readBlob` (4 more RPCs, `home.tsx:84-99`).
- **Formula**: `4 + min(entries, 30)` engine RPCs, the 30 **sequential** —
  each a same-DO round trip; wall time is the sum.
- **Fix shape**: this is the documented interim fallback for the missing
  batched `listTreeCommits` engine RPC (`page-data.ts:19-33`); the real fix
  is that RPC at the engine boundary (L). The cheap fix is
  parallelizing the loop (`Promise.all`), S. Same serial shape in the
  sub-directory loader (`pages/file-view.tsx` uses the same helper).
- **Difficulty**: S (parallelize) / L (batched engine RPC).

---

## B. Redundant re-fetches (same row selected twice in one request)

### B1. `toApiPullRequest` → `toApiIssue` re-selects the PR row it already holds — **LANDED `fbd0826`**

`apps/worker/src/api/services/pulls.ts:405` calls `toApiIssue` while holding
the `pull_requests` row in hand, and `toApiIssue` unconditionally re-selects
it through `pullRequestMetaOf`
(`apps/worker/src/api/services/issues.ts:199-222`, called at `:257`). +1 per
PR row on every pulls list (A3) and single GET. Fix: let `toApiIssue` accept
an optional preloaded PR row (or split a "meta" parameter). Difficulty: S.

### B2. The commits list's batched email map is thrown away — **LANDED `c614daa`**

Covered in A4: the route pays one batched `usernamesByEmail` select
(`apps/worker/src/api/routes/commits.ts:247`) whose result `toApiCommit`
never reads (`apps/worker/src/api/services/git-models.ts:188` is a dead
parameter), then re-queries per author/committer per commit (`:224-227`).
2N selects replaceable by 0. Difficulty: S.

### B3. Issue-detail signed-in grants read the collaborator row up to 3× and the repo pair 2×

For a signed-in viewer, the detail page runs
`resolveIssueDetailAccess` (`apps/worker/src/ui/pages/issue-detail.tsx:422-446`):

1. `collaboratorModeOf` (`:435`) — collaborator row read #1;
2. `canAdminRepo` (`:438`) → `sessionRepoGrant`
   (`apps/worker/src/ui/pages/settings.tsx:317-318` →
   `apps/worker/src/ui/repo-grants.ts:56-68`) re-resolves the repo pair with
   `findRepositoryById` (`repo-grants.ts:63`) even though the router already
   resolved it (`apps/worker/src/ui/index.ts:4088`), then
   `isRepositoryAdmin` (`apps/worker/src/api/services/repo-access.ts:68-84`)
   reads the collaborator row again (`:77`) AND re-resolves the team mode
   (`:81` → `doerRepoAccessMode` → `collaboratorModeOf`,
   `apps/worker/src/api/services/repository.ts:161-164`) — collaborator read
   #3.

Fix: resolve `doerRepoAccessMode` once per request and thread the mode;
`sessionRepoGrant` should accept the already-resolved pair. Difficulty: M
(signature threading across the bridge).

### B4. Pull-files loader re-reads the repo pair by id

`apps/worker/src/ui/pages/pull-files.tsx:266-271` re-reads the pair the
router already resolved (documented in-code as a deliberate cheap re-read).
One extra query per PR-files view; the fix is threading the pair through.
Difficulty: S.

### B5. Follower/following counts fetch a row page to discard it

The profile and activity pages need only totals but call
`listFollowers`/`listFollowing` with `pageSize: 1`
(`apps/worker/src/ui/pages/user-profile.tsx:304-307`,
`apps/worker/src/ui/pages/activity-feeds.tsx:631-634`); each runs count(*) +
a 1-row select (`apps/worker/src/api/services/follows.ts:180-196`). Two
wasted selects per view. Fix: count-only helpers. Difficulty: S.

---

## C. Fetch-all-then-slice / fetch-more-than-needed shapes

### C1. API commits `since`/`until` arm walks the bound then slices

`apps/worker/src/api/routes/commits.ts:224-235`: with `?since`/`?until`, one
`listLog` walks `COMMIT_WALK_BOUND = 500` commits (`:62`), filters by date in
memory, then slices the page. Bounded and documented (the engine has no
date-filtered log RPC) — recorded as an accepted bound, but it is the
heaviest single RPC in the API surface when those params are used.

### C2. Activity page's issue-title read fetches all issues of the page's repos

`apps/worker/src/ui/pages/activity-feeds.tsx:566-575`: the batched title read
selects EVERY issue of the referenced repos (`inArray(issues.repoId, ...)`)
and post-filters to the referenced `(repoId, index)` pairs (`:572-575`). For
the demo repo with a growing issue corpus this reads hundreds of rows to
title ≤ 20. Fix: add `inArray(issues.index, referencedIndexes)` alongside the
repo filter (a tuple IN is unnecessary — the post-filter keeps exactness).
Difficulty: S.

### C3. UI issue timeline fetches up to 500 rows

`apps/worker/src/ui/pages/issue-detail.tsx:309-320` fetches the timeline
with `TIMELINE_LIMIT = 500` (`:226`) — upstream renders the full timeline
unpaginated, so this is a documented cap, not a regression. Listed for
completeness: it is the widest single read on the detail page.

---

## Verified clean (batched or bounded — no fix needed)

These hot paths were traced and already batch correctly; listed because
"clean" is a finding too:

- **Org members page + `GET /orgs/{org}/members`**: one joined page select +
  one count (`apps/worker/src/ui/pages/org-members.tsx:139-200`,
  `apps/worker/src/api/services/orgs.ts:194-221`); owner-prompt is one PK
  read (`org-members.tsx:125-129`).
- **User profile page**: page + count + ONE batched description read +
  the two follow counts (`apps/worker/src/ui/pages/user-profile.tsx:266-318`).
- **Signed-in dashboard**: one owned page, one watched join, batched
  descriptions, one joined activity query
  (`apps/worker/src/ui/pages/dashboard.tsx:185-243`).
- **Repo list APIs** (`/repos/search`, `/users/{u}/repos`, `/user/repos`):
  count + page with query-flat list rendering (the fork/mirror arms resolved
  per-entry only on single GETs, by design —
  `apps/worker/src/api/services/repository.ts:900-1015, 1022-1048, 1056-1076`,
  the documented list-shape divergence at `:484-488`).
- **Org repos listing** (`OrgService.listOrgRepos`): the team grant is one
  EXISTS fragment in the WHERE, no per-row grants
  (`apps/worker/src/services/orgs/orgs.ts:560-637`).
- **Collaborator/assignee lists**: page-of-ids then ONE batched users read
  (`apps/worker/src/api/services/repo-collaborators.ts:116-196`).
- **UI issue-detail core loader** (anonymous path): issue + PR + labels +
  timeline + milestone in parallel, then ONE batched person-name read
  (`apps/worker/src/ui/pages/issue-detail.tsx:294-339`); review sidebar is
  one joined select
  (`apps/worker/src/ui/pages/pull-reviews.tsx:282-308`).
- **PR commits page**: two row reads, batched person names, bounded engine
  RPCs (`apps/worker/src/ui/pages/pull-commits.tsx:121-184`).
- **Commits page (UI)**: bounded RPCs, no D1 beyond the prologue
  (`apps/worker/src/ui/pages/commits.tsx:47-88`).
- **Activity feed's page-module lookups**: repo ids and issue titles are
  batched reads (the title read's over-fetch is C2; the shape itself is
  batched) (`apps/worker/src/ui/pages/activity-feeds.tsx:536-576`).
- **Activity-author-data**: the branch scan uses the 8-wide DO batching
  convention and one batched email→user read
  (`apps/worker/src/ui/pages/activity-author-data.ts:282-325`).
- **Session verification**: one joined read per request
  (`apps/worker/src/ui/session.ts:236-312`).

---

## Ranked fix queue

Ranked by (requests-frequented × N) — how often the surface is hit × how many
extra roundtrips each hit pays. "Difficulty" is the agent-estimate band S/M/L.

| # | Finding | Route / surface | Formula | N (demo) | Queries today | Fix shape | Diff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A2 | `GET /api/v1/repos/{o}/{r}/issues` | 2 + N×3..5 | 30 | ~92-152 | page-batch posters/labels/pins/milestones/PR rows (`issues.ts:964`) | M |
| 2 | A3 | `GET /api/v1/repos/{o}/{r}/pulls` | 2 + N×4..8 | 30 | ~122-242 | A2 batch + mergers + head-repo pairs (`pulls.ts:914`) | M-L |
| 3 | A1 | UI `/{o}/{r}/issues` + `/pulls` | 9 + N | 20 | ~29 (bench: 22-shape) | one `inArray` label join + `GROUP BY is_closed` tab counts (`issues-list.tsx:240-248`) | S |
| 4 | A4 | `GET /api/v1/repos/{o}/{r}/commits` | 2N D1 + N RPCs | 30 | ~61 D1 + 32 RPCs | use the dead `usernames` map; one full-row email batch (`git-models.ts:224-227`) | S |
| 5 | A6 | `GET /api/v1/repos/issues/search` | 2 + N×4..6 serial | 30 | ~123-182 | batch repo pairs + A2 batch + parallelize (`issues.ts:1646-1652`) | M |
| 6 | A10 | UI `/{o}/{r}` (repo home) | 4 + min(entries,30) RPCs serial | 30 | 34 DO hops, serial | `Promise.all` now; batched `listTreeCommits` RPC as the real fix (`page-data.ts:38-56`) | S / L |
| 7 | A5 | `GET /api/v1/.../issues/{i}/timeline` | 1 + R×(1..5) serial | 30 | ~31-151 serial | batch posters + metadata, parallelize (`issues.ts:1567-1572`) | M |
| 8 | B3 | UI `/{o}/{r}/issues/{i}` (signed-in) | +5-7 avoidable | 1 | 3× collaborator + 2× pair | resolve the mode once, thread the pair (`issue-detail.tsx:422-446`) | M |
| 9 | A8 | `/activities/feeds` + UI feeds | 5 + R + C | 20 | ~25-45 | `inArray` repo pairs + comment posters (`activity-feeds.ts:502-530`) | S-M |
| 10 | A7 | comment list APIs | 2 + C | 30 | ~32 | one batched poster select (`issues.ts:302`) | S |
| 11 | A9 | grant resolution (all private paths) | 1 + T | 1-3 | per resolution | reuse the `teamGrantCondition` EXISTS (`orgs.ts:738-746`) | S-M |
| 12 | B1 | pulls list + GET | +N | 30 | inside #2 | preload the PR row into `toApiIssue` (`issues.ts:199-222`) | S |
| 13 | C2 | UI activity page | over-reads issues of R repos | R×corpus | rows_read, not count | add the index `IN` filter (`activity-feeds.tsx:567-575`) | S |
| 14 | B5 | profile + activity pages | +2 | 1 | 2 wasted selects | count-only follow helpers (`user-profile.tsx:304-307`) | S |
| 15 | B4 | UI PR files | +1 | 1 | 1 re-read | thread the resolved pair (`pull-files.tsx:266-271`) | S |

Items 1-6 land the wave's worth: the two heaviest API lists drop from
O(page × 5) to O(page-independent constant + page), the UI issue list drops
to a fixed ~8, the commits list loses its 2N, and the repo home's worst
serial wall-clock fan-out halves at minimum. Items 7-15 are small,
independent, and can ride any wave that touches the owning file.
