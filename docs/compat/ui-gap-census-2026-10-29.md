# UI Gap Census — 2026-10-29 (dispatchable)

Input for the new directive: **upstream Gitea serves it → cf-gitea serves it.**
The UI parity survey (`docs/compat/ui-parity-survey.md`, tick-16 at HEAD
`59b1c3c`) closed the demand-driven phase with **94/5/17** over 116 rows — its
remaining **17 ABSENT + 5 PARTIAL = 22 non-landed rows** are the complete
residual, and this census classifies, briefs, and ranks every one of them.
Upstream findings are against the vendored pin
`fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919); every
`web.go:N` cite is `gitea/routers/web/web.go` at that pin. Our side is
committed HEAD: the engine boundary
(`packages/git-engine/dist-types/repo.d.ts`), the D1 schema
(`apps/worker/src/db/schema.ts`), the landed services
(`apps/worker/src/api/services/`, `apps/worker/src/lfs/`), the UI pages
(`apps/worker/src/ui/pages/`), and the declared OpenAPI surface (490 ops —
`node scripts/check-openapi.mjs` PASS at the survey's tick).

## Reconciliation — the dispatch brief's scan vs the survey tables

The dispatching note said "14 ABSENT + 3 PARTIAL". The survey's tables carry
**17 ABSENT + 5 PARTIAL**. Deltas, so no row is lost and none is
double-dispatched:

- The scan's `.../blob_excerpt/{sha}` is **LANDED** (`67adfb7`, with its wiki
  twin) — do not re-dispatch.
- Four genuine ABSENT rows were missing from the scan: `/{username}/-/code`
  (web.go:1166), `/org/{org}/dashboard[/{team}]` (web.go:982-985),
  `.../settings/lfs[/...]` (web.go:1249-1261), `.../search` (in-repo code
  search, web.go:1768).
- Two genuine PARTIAL rows were missing from the scan: `/-/admin/*`
  (web.go:780-906) and `/{org}/teams/{team}` (web.go:997-998).

This census covers all **22** survey rows.

## Classification legend

- **(a) IMPLEMENTABLE-NOW** — pure UI/backend parity over landed tables and
  the landed engine boundary; the only missing pieces are service reads /
  page modules / route mounts. No new engine capability. Dispatch-ready
  briefs below.
- **(b) NEEDS-API** — the backing read does not exist yet; the row names the
  prerequisite chain. Two sub-shapes, both named per row:
  - **needs-engine-RPC** — the read must be added to the engine boundary
    (the survey's "no-RPC-gated" rows; several of the missing computations
    already exist INSIDE the DO as private cgit-style pages — see R08, R14).
  - **needs-model** — a new D1 table + write instrumentation (SPEC-first per
    the repo workflow).
- **(c) FEATURE-GATED** — packages/actions: the API surface is
  FEATURE-ABSENT (64 ops: actions runtime 54 + package registry 10 per
  `docs/compat/api-remaining-inventory.md`), the D1 tables do not exist, and
  the implementation gate is SPEC-0012 (`specs/0012-actions-feasibility.md`,
  `draft — gated`: nothing built until the §1.1 entry criteria — a concrete
  CI demand + a runner operator + a wire capture — fire). Packages has no
  SPEC and needs its own gate first.
- **(d) COSMETIC-DIVERGENCE** — a deliberate upstream reduction to revisit.
  Two of these (R02, R05) actually match upstream's DEFAULT config posture
  (the repo code indexer is opt-in and disabled by default, so upstream's
  own default install redirects those pages away); two (R21, R22) are
  byte-serving shapes we reduced to tier-1 API links and are cheap to close
  now under the new directive.

**Headline: 22 rows — 5 wholly (a) IMPLEMENTABLE-NOW, 3 more rows carrying
(a) arms; 7 (b) NEEDS-API (2 of them share one prerequisite); 4 (c)
FEATURE-GATED; 4 (d) COSMETIC-DIVERGENCE.** No (a) row needs a SPEC first;
every (b) row names its first commit.

---

## (a) IMPLEMENTABLE-NOW — ready-to-dispatch work briefs

### R01 — `GET /explore/organizations` (ABSENT) — size S/M — impact #4

- Upstream: web.go:557 → `explore.Organizations`
  (`gitea/routers/web/explore/org.go:17`): org cards over VISIBLE orgs —
  public for anonymous, +limited/+private when signed in (`VisibleType`
  switch at org.go:31-34); `?q=` name/full-name search; sort orders
  newest/oldest/alphabetically/reversealphabetically;
  `Explore.DisableOrganizationsPage` redirects to `/explore` (default OFF —
  the page serves at default config).
- Ours: org rows landed (`users` table, `type='org'`, `visibility` enum
  public/limited/private, `users_type_idx` type-aware index);
  `adminGetAllOrgs` is admin-gated; no anonymous viewer-scoped listing.
- Brief: new loader `searchExploreOrgs` (visibility filter exactly per
  org.go:31-34: `visibility='public'` for anonymous, all three for a signed-in
  viewer — upstream has NO per-viewer membership relaxation here), `?q=` on
  lower_name/display_name via the instr() substring shape (the
  `c91f689` LIKE-cap class), the four sort orders, org cards with
  repo/member counters (landed counter columns); extend
  `apps/worker/src/ui/pages/explore.tsx` with the Organizations tab + the
  tab strip's Orgs item (upstream renders the strip from
  `explore/user/header`; ours renders Repositories/Users only); route as an
  exact literal `/explore/organizations` registered BEFORE the dynamic
  owner/repo parse (the `f60e5a8` dead-route rule), plus a request-level
  route arm per the process note. Effort: S for the query + page arm, M with
  the tab-strip fold and matrix.

### R03 — `GET /{username}/-/heatmap` (ABSENT) — size S/M — impact #3

- Upstream: web.go:1135 → `user.DashboardHeatmap`
  (`gitea/routers/web/user/heatmap.go:50`): a JSON endpoint, not a page —
  `{"heatmapData": [[unixTs, count]...], "totalContributions": N}` with
  15-minute buckets (`created_unix / 900 * 900`), the trailing
  `(366+7)`-day window, viewer-visibility gate (`IsUserVisibleToViewer`),
  `EnableUserHeatmap` (default ON). The profile and org-dashboard templates
  embed a `<div>` + `HeatmapURL` and the client widget
  (`web_src/js/features/heatmap.ts` → the ActivityGraph component) fetches
  and renders the grid.
- Ours: the aggregation EXISTS — `GET /users/{username}/heatmap`
  (userGetHeatmapData, `apps/worker/src/api/routes/user-read-t2.ts:68`) over
  the landed `action` table and `activity-feeds` service, upstream-exact
  (models/activities/user_heatmap.go:22-77 port, including the 900-second
  bucket and the window). `pages/activity-feeds.tsx` deliberately does not
  render the heatmap arm ("no heatmap pipeline" — now false).
- Brief: two pieces. (1) The web JSON route `GET /{username}/-/heatmap`: a
  thin adapter family over the SAME service read, answering the web pair
  shape (`[[ts,count]...]` + total — NOT the API's `[{timestamp,
  contributions}]` object shape), with the visibility 404 gate; registered
  as an exact constrained tail in the `/-*` namespace (the
  `:segment{...}`-constraint convention from `ae32b1a`, before the owner
  home arm). (2) The widget arm: render the contribution grid into
  `pages/activity-feeds.tsx`'s heatmap slot — our pages are SSR, upstream's
  widget is client React; port as an SSR SVG/CSS grid over the same buckets
  (the tooltip interaction is the only loss, a documented reduction) or a
  div + inline fetch script if the wave prefers upstream's fetch flow —
  template-policy call, see Open Issues #5. Effort: S for the JSON route,
  M with the widget.

### R06 — `GET /org/{org}/dashboard[/{team}]` (ABSENT) — size M — impact #6

- Upstream: web.go:982-985 → `user.Dashboard` under
  `context.OrgAssignment(RequireMember: true, RequireTeamMember: true)` —
  MEMBER-ONLY; the dashboard page rendered over the org (activity feed of
  the org's repos, org heatmap arm with the org semantics — actions by ALL
  users in org-owned repos, `OnlyPerformedBy=false`,
  user_heatmap.go:36-39 — and the team variant filtering through the team).
- Ours: the `action` table + feeds read landed; the user dashboard page
  landed; the org heatmap arm (org-scoped collation) does not exist — the
  API heatmap route is user-scoped only.
- Brief: (1) org-scope feed collation — parameterize the landed feeds read
  by the org's repo set (member-visibility subquery, the
  `activity-feeds.ts` SQL-subquery idiom that dodges D1's 100-param cap);
  (2) the org-arm heatmap read (`GetUserHeatmapDataByOrgTeam` port — same
  900s buckets, `OnlyPerformedBy=false`, optional team filter through
  `teamRepoAccess`); (3) the dashboard page arm under an org-membership
  gate (orgMembers join — upstream's RequireMember 404s non-members; do not
  soften to public). Reuse `pages/dashboard.tsx`'s collation vocabulary +
  `pages/org-*.tsx` chrome. Effort: M. Depends on R03's widget only if the
  heatmap arm renders inside the dashboard — dispatch R03 first or ship the
  dashboard with the feed-only template arm (upstream degrades the same way
  when `EnableUserHeatmap=false`).

### R07 — `GET /org/{org}/issues|pulls|milestones[/{team}]` (ABSENT) — size M — impact #7

- Upstream: web.go:986-991 → `user.Issues` / `user.Pulls` /
  `user.Milestones` (`gitea/routers/web/user/home.go:139,329,342` →
  `buildIssueOverview`): the issue-overview page scoped to the org's repos,
  member-only, `?team=` filtering the repo set through the team, sort
  default `recentupdate` (unlike the repo list), the poster/assignee facet
  arms.
- Ours: the global inbox `/issues` `/pulls` `/milestones` landed
  (`a8818c6` — the shared overview loader with type-arm counts); `issues`,
  `teams`, `teamRepoAccess`, `orgMembers` tables landed; the ORG-scope
  cross-cut read does not exist.
- Brief: parameterize the global-inbox overview loader with a repo-set
  scope: org arm = every repo of the org visible to the member (membership
  gate + private-repo visibility, the SPEC-0005 posture); team arm =
  `teamRepoAccess` rows (+ `includesAllRepositories`); milestones arm
  joins org-scope milestones. New exact-literal routes under the org
  namespace, registered before the dynamic parse, request-level arms per
  the process note. Effort: M (the loader parameterization is the bulk; the
  team filter adds the `teamRepoAccess` join).

### R19 — `GET /{org}/teams/{team}` (+`/{team}/repositories`) PARTIAL → LANDED — size S — impact #12

- Upstream: web.go:997-998 — the team page resolves by team NAME (lowercased;
  `teams.lowerName` is UNIQUE per org in our schema) and the
  `/{team}/repositories` tail is a separate sub-list.
- Ours: landed detail resolves by numeric ID and merges the repositories
  list into the detail slice (the survey's recorded divergence).
- Brief: add the name-keyed resolution arm on the landed detail page
  (lower_name lookup, 404 shell on miss), accept BOTH carriers (id stays for
  our internal links; name matches upstream's links and bookmarks), and
  either split the repositories sub-list to its own tail or keep the merged
  slice and record the divergence — upstream's page shows members +
  repositories together, so the merged slice is the closer port; the
  separable win is name-keyed resolution. Effort: S.

### R18 — `/-/admin/*` PARTIAL — the (a) arms: emails, hooks, badges, applications — size M per page — impact #10

- Upstream: web.go:780-906; still-absent pages config / notices / auths /
  emails / badges / packages / hooks / applications / actions (survey row's
  STILL ABSENT list).
- Ours: the backing READS exist for four of them — admin emails
  (`GET /admin/emails` + `/admin/emails/search` declared,
  `api/routes/misc-t3.ts:389,407`), admin hooks (`/admin/hooks` family
  declared, `api/routes/hooks-scopes.ts:379-464`), admin badges (the
  per-user badge family declared, `api/routes/admin-badges.ts`; the badge
  CATALOG table is in the schema — its CRUD is upstream web-only, and the
  admin badges page IS that catalog UI), and global oauth2 applications (a
  read over the landed `oauth2Applications` table — upstream admin
  applications is the instance-wide app list).
- Brief: four page modules over the declared services, folding their nav
  items into the landed AdminFamilyNav (the `2f7afe9` consolidation), each
  with a scoped-th a11y pass (the `132fec0`/`ec2dd70` convention) and a
  golden. Badges needs the catalog write forms (web-only upstream — no API
  contract to match; follow the admin-orgs listing shape). The remaining
  arms of this row are classified separately below (config/notices/auths →
  (b); packages/actions → (c)). Effort: M per page; dispatch as one wave or
  four S slices.

### R20 — `/{org}/settings/{hooks,applications,blocked_users}`(+`audit_logs`) PARTIAL — the (a) arm: applications — size S — impact #11

- Upstream: web.go:1022-1041 — the org settings applications tab manages
  org-OWNED oauth2 applications (owner id = the org's id).
- Ours: `oauth2Applications` landed with `uid` = owner id (org rows use the
  same column upstream); the landed user-settings applications module
  manages uid=session-user only; no org-scope read.
- Brief: extend the oauth2 service with the org-scope read (list where
  `uid = org.id`) + create/delete arms behind an org-admin gate (the landed
  org settings prologue), then a `pages/org-settings-applications.tsx`
  module in the `org-settings-*` idiom (the `54264ae`/`4f2805f` tab
  pattern). The audit_logs arm is (b) below; the upstream
  packages/actions management tabs are (c). Effort: S.

**Partial-row bookkeeping:** R18 and R20 stay PARTIAL until ALL their arms
close; the (a) arms above shrink the survey's still-absent lists but flip no
status by themselves (the tick-10 unmounted-module convention applies to
arms, and these are mounted work anyway).

---

## (b) NEEDS-API — named prerequisites first, then UI

### R08 — `GET .../blame/{branch|tag|commit}/*` (ABSENT) — size M after the RPC — impact #2

- Upstream: web.go:1729-1733 → `repo.RefBlame`
  (`gitea/routers/web/repo/blame.go`): per-line blame page — row numbers,
  per-line commit sidebar (sha, message, age, avatar stack), previous-sha
  links, code with highlighting; huge files render in parts.
- Ours: **the blame machinery already exists INSIDE the DO** — the exported
  `blame(history)` function (`dist-types/git/blame.d.ts:20`), the private
  `pathHistory` walker ("first-parent history of a path (for blame)",
  repo.d.ts:427), and a complete private `blamePage` (the vendored engine's
  own cgit UI). What is missing is ONLY the boundary RPC.
- Two-step: (1) engine — expose `readBlame(ref, path, opts?)` at the
  boundary returning line/commit pairs + per-sha commit metadata, with an
  explicit walk budget (the `PATH_LOG_SCAN` discipline) and a part/offset
  option for the page's huge-file chunking; regenerate `dist-types/` via
  `pnpm typecheck`. (2) UI — the `blame` parse family + `pages/blame.tsx`
  (sidebar + code grid over the RPC, part links) + the file-view Blame
  anchor (`pages/file-view.tsx` currently renders no blame link — the
  dead-link rule). No API route needed beyond the RPC (upstream's page is
  web-only).

### R09 — `GET .../graph` (ABSENT) — size L — impact #9

- Upstream: web.go:1738 → `repo.Graph` (`gitea/routers/web/repo/commit.go:106`):
  the commit-graph page — SVG lanes (color/monochrome), paginated, branch
  filter (`?branch=`), hide-PR-refs, file filter; data from the gitgraph
  service (`git log --graph` parsing + lane assignment).
- Ours: no DAG-position machinery anywhere; the boundary's `listLog` walks
  one tip; `CommitJson` carries parents (the raw material is there).
- Two-step: (1) engine — a `graphData(ref, {limit, page, refs?, hidePRRefs?})`
  RPC: date-ordered multi-parent walk inside the DO (budget-capped, the
  `walkLog` frontier discipline) + lane/position assignment computed
  in-DO so the page gets render-ready rows. (2) UI — `pages/graph.tsx`
  rendering the lanes (SSR SVG) over the RPC + the Commits-page "Commit
  Graph" anchor. L sized for the walk + layout algorithm; the upstream
  file filter arm can honest-absent on the first slice.

### R10 — `GET .../search` in-repo code search (ABSENT) — size L — impact #8

- Upstream: web.go:1768 → `repo.Search` (`gitea/routers/web/repo/search.go:22`):
  the in-repo code-search page; **requires `Indexer.RepoIndexerEnabled`**
  — at upstream's DEFAULT config the results arm is disabled (the page
  renders with the indexer-off notice), matching our absence today.
- Ours: no content-search capability on the boundary or in any service.
- Two-step: (1) engine — a bounded `grep(ref, {pattern, isFuzzy, path})`
  RPC: tree walk + line scan inside the DO with hard budgets (files/bytes/
  matches — the engine's existing scan-cap conventions); case-insensitive
  substring matches upstream's non-indexer fallback shape. (2) UI —
  `pages/repo-search.tsx` (result cards → file+line links) + the search
  anchor beside find-file, with the indexer-off-equivalent honest-absence
  if a repo exceeds budget. Shares its engine work with R02/R05 (the
  explore/user code-search pages) — one grep RPC serves all three.

### R11 — `GET .../settings/lfs[/...]` (ABSENT) — size M — impact #13

- Upstream: web.go:1249-1261 — the LFS settings group: `LFSFiles` (paged
  meta-object list per repo), `LFSFileGet` (detail + `FindLFSFile` — every
  in-tree path referencing the oid), `LFSDelete`, `LFSPointerFiles` (scan
  refs for pointer files), `LFSAutoAssociate`, `LFSFileFind`, and the
  locks trio.
- Ours: the LFS server + locks are LANDED (SPEC-0006 — `src/lfs/` includes
  the locks API; `lfsObjects` table has repo_id + oid). Missing: the
  pointer-scan family — no read maps refs → pointer files, and no paged
  per-repo meta-object listing for the UI.
- Two-step: (1) reads — paged `lfsObjects` query by repo_id (plain D1);
  the pointer scan = refs → tree walk over blobs under the pointer size cap,
  parse + match against `lfsObjects` — engine-shaped (a budgeted
  `scanLfsPointers(ref)` RPC, or a bounded service walk over `listTree` +
  `readBlob` for small repos; SPEC-first if the RPC, per the workflow's
  design-level rule). (2) UI — the settings LFS page family (list, detail
  + find, pointers, locks — locks ride the LANDED store) as
  `pages/settings-lfs*.tsx` + the SettingsNav item (currently omitted, the
  dead-link rule). The `FindLFSFile` reverse map (oid → referencing paths)
  needs the same scan inverted; it may honest-absent on slice one.

### R14 — `GET .../activity[/{period}]` (ABSENT) — size M/L — impact #5

- Upstream: web.go:1628-1631 → `repo.Activity`
  (`gitea/routers/web/repo/activity.go:22`): the "pulse" page — per-period
  stats (daily/halfweekly/weekly/monthly/quarterly/semiyearly/yearly) over
  the code+issues+pulls+releases units, gated on reading ANY of them.
- Ours: feed rows + the per-author COMMIT-COUNT aggregation landed
  (`activity-author-data` family, `pages/activity-author-data.ts` — top-10
  authors per window over the engine walk). Missing: the full
  `CodeActivityStats` — additions/deletions per author (the `--shortstat`
  walk), the issues/PRs/release counters (computable from landed D1 rows),
  and the page.
- Two-step: (1) reads — the add/del-per-author walk is engine-shaped: the
  DO's private `computeStats` (repo.ts:2459, cached per tip+period,
  `MAX_STATS_SCAN`-bounded) already aggregates commits per author; extend
  it (or add a sibling RPC) to fold `readDiff`-shaped add/del totals into
  the same cached record and expose it at the boundary
  (`activityStats(ref, period)`). The issue/PR/release counters are plain
  D1 aggregates over landed tables (service, no engine). (2) UI —
  `pages/repo-activity.tsx` (stats cards + top-authors + the recent-activity
  feed from the landed feeds read) + the repo navbar Activity item +
  `/{period}` window arms. Effort M with the counts-only degradation, L
  with the full shortstat RPC.

### R15 — `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` (ABSENT) — size L — impact #14

- Upstream: web.go:1633-1646 (`reqUnitCodeReader`): three chart pages +
  their `/data` JSON tails. `GetContributorStats`
  (`gitea/services/repository/contributors_graph.go:80`): per-author per-WEEK
  additions/deletions/commits over `git log --shortstat --no-merges`,
  cached 10 minutes, generated ASYNC with a 5-second await and an
  `ErrAwaitGeneration` retry posture. `recent-commits` reuses the
  code-frequency data.
- Ours: none of the per-week add/del machinery; shares R14's prerequisite.
- Two-step: (1) engine — the contributor-stats RPC (per-author weekly
  add/del/commits, cached like `computeStats`; the async-generate +
  await-generation posture maps onto a DO-computed cached payload — decide
  synchronous-with-budget vs upstream's async-await posture in the SPEC).
  (2) UI — the three pages + the `/data` JSON tails (the exact
  `ContributorData`/`WeekData` shapes, contributors_graph.go:41-58) + the
  Activity page's tab anchors. Charts: upstream renders client-side
  chart.js; our SSR vocabulary needs the render-policy call (Open Issues
  #6). Serialize after R14 (same RPC family, the page tabs hang off the
  Activity surface).

### R13 — `GET .../settings/audit_logs` (ABSENT) + the R20 audit arm — size L — impact #15

- Upstream: web.go:1279 → `repo_setting.ViewAuditLogs`; the org twin
  web.go:1069 → `org_setting.ViewAuditLogs`; a SHARED renderer
  (`routers/web/shared/audit`) over the `models/audit` subsystem
  (`gitea/models/audit/audit_event.go` — scope-typed events:
  ScopeOrganization / ScopeRepository / …, actor, action, payload,
  origin). One model serves the repo tab, the org tab, AND the user
  settings arm upstream.
- Ours: no audit store, no instrumentation — a genuine needs-model row.
- Two-step: (1) SPEC-first (`specs/audit-events.md` per the workflow): the
  D1 `audit_event` table (scope_type/scope_id/actor_id/action/payload/
  created_unix + the indexes the paged read needs), the emit seam (which
  settings/admin writes instrument first — keep slice one to the upstream
  event classes the settings pages actually read), the retention story.
  (2) UI — the shared paged read service + `pages/settings-audit-logs.tsx`
  (repo) and the org tab arm (`org-settings-audit.tsx`), folding the
  SettingsNav items. One model, two mounted surfaces. L sized for the
  model + instrumentation; the pages themselves are M once the store
  exists.

### R18/R20 remaining (b) arms — admin config / notices / auths — size M/L per page — impact #16

- Upstream: admin config (instance settings), notices (system notices),
  auths (authentication sources). Ours: none of the three stores exist
  (schema list confirmed — no system_notice, no login_source, no
  system-settings KV).
- Two-step: needs-model for notices (small D1 KV + admin writes + the page);
  config can be a page over our actual landed config (`src/api/config.ts` +
  wrangler posture) rendered with honest-absence lines for upstream's
  inapplicable sections — divergence ledgered, arguably (a)-with-reduction;
  auths is likely N/A for cf-gitea (a single built-in auth method — no
  login sources) and should get an explicit policy call (honest-absence
  page vs omission) rather than a store (Open Issues #7).

---

## (c) FEATURE-GATED — packages/actions (SPEC-0012 posture)

Four whole rows + three arm-riders. NOT dispatchable; the gate is
SPEC-0012 §1.1 (`specs/0012-actions-feasibility.md` — draft-gated: nothing
built until a concrete CI demand + a runner operator + a wire capture).
The package registry has no SPEC and needs its own gate first. The API
ledger (`docs/compat/api-remaining-inventory.md`): actions runtime 54 ops +
package registry 10 ops, all FEATURE-ABSENT, no D1 tables
(`schema.ts` has no actions/package tables — only `repositories.hasActions`
/ `hasPackages` unit toggles). The UI pages are downstream of their APIs:
`/api/actions` runner protocol + `/api/actions_pipeline` + the D1 runs/
jobs/runners schema come first, then `pages/*-actions*.tsx` /
`pages/*-packages*.tsx`.

- **R04** `GET /{username}/-/packages[/...]` — web.go:1108-1128 — user
  packages index (+ version/detail tails).
- **R12** `GET .../settings/actions*` — web.go:1262-1278 — repo Actions
  settings (general/runners/secrets/variables; the secrets/variables
  ARM landed already for user+org settings — only the Actions-runtime
  pieces are gated).
- **R16** `GET .../packages` — web.go:1538-1542 (packagesEnabled) — repo
  packages index + cleanup rules (+ cargo arms upstream).
- **R17** `GET .../actions[/...]` — web.go:1566-1608 — the workflow-run
  surface (list/runs/jobs/logs/artifacts + enable/disable).
- Arm-riders: the admin packages/actions tabs (inside R18) and the org
  settings packages/actions management tabs (inside R20) — same gate.

---

## (d) COSMETIC-DIVERGENCE — deliberate reductions to revisit

### R21 — `GET .../raw/{branch|tag|commit}/*` (+`/raw/blob/{sha}`) PARTIAL → close — size S — impact #1

- Upstream: web.go:1707-1713 (`SingleDownload` / `DownloadByID` — plain
  byte serving with Basic/OAuth2 auth allowed). Ours: our SSR pages emit
  the tier-1 API raw links instead (`links.ts:41` — documented divergence);
  the upstream WEB shape 404s, so every pasted raw URL and every
  official-bundle reference breaks.
- Close recipe: a serving page family over the landed `readBlob` — the
  `render`/`archive`/`release-downloads` byte-serve idiom
  (`pages/archive-files.ts` weak-ETag/Content-Disposition conventions),
  mime type per upstream's raw posture (text/* plain, octet-stream else),
  registered before the dynamic parse with the process-note route arm.
  Then switch `links.ts:41` to the web shape. S.

### R22 — `GET .../media/{branch|tag|commit}/*` (+`/media/blob/{sha}`) PARTIAL → close — size S/M — impact #13b

- Upstream: web.go:1699-1705 (`SingleDownloadOrLFS` / `DownloadByIDOrLFS`) —
  raw serving that RESOLVES LFS pointers to media bytes, with the
  SVG-sandbox CSP posture for `image/svg+xml`.
- Close recipe: the R21 family with the LFS-aware arm — pointer detection
  + resolution through the LANDED LFS store (the `src/lfs/` read path) —
  and the SVG CSP header. S/M (the LFS resolution read is landed; the
  pointer-scan prerequisite is NOT needed for media serving, only for the
  settings page R11).

### R02 — `GET /explore/code` (ABSENT) and R05 — `GET /{username}/-/code` (ABSENT) — no independent work — impact #17

- Upstream: both are gated on `Indexer.RepoIndexerEnabled` — at DEFAULT
  config `/explore/code` redirects to `/explore` (code.go:29-32) and
  `/-/code` redirects to the profile (code.go:25-27). **Our absence
  matches upstream's default-config behavior**; these rows only open with
  the code-search subsystem (R10's grep RPC + an indexer-class store — a
  subsystem, not a page). Revisit together with R10; do not dispatch
  standalone.

---

## Impact ranking (what a Gitea user would notice first)

Ranked by visibility × demand ÷ remaining effort. The top five are the
recommended dispatch order; ties break toward no-prerequisite rows.

| # | Row | Class | Size | Why it bites |
|---|-----|-------|------|--------------|
| 1 | R21 `.../raw/*` | (d) | S | Every pasted raw URL and official-bundle reference 404s — core demand, cheapest fix in the census |
| 2 | R08 blame | (b, engine) | M | The Blame button on every file view is missing; the algorithm already sits inside the DO — only the RPC + page remain |
| 3 | R03 heatmap | (a) | S/M | The contribution graph is on every profile; the aggregation is ALREADY LANDED as an API route — only the web shape + widget remain |
| 4 | R01 explore orgs | (a) | S/M | The explore Orgs tab — core anonymous discovery; org rows are landed |
| 5 | R14 repo activity | (b, engine) | M/L | The repo navbar Activity (pulse) page — core demand per the survey; count-based degradation shippable first |
| 6 | R06 org dashboard | (a) | M | Org members land on it from the org header; member-only |
| 7 | R07 org issues/pulls/milestones | (a) | M | The org overview tabs hang off the dashboard strip |
| 8 | R10 in-repo search | (b, engine) | L | The repo search button; matches upstream default-off, but the button+page are expected |
| 9 | R09 graph | (b, engine) | L | The Commits-page Graph button |
| 10 | R18 admin (a) arms | (a) | M/page | Admin-only: emails, hooks, badges, applications pages |
| 11 | R20 org applications arm | (a) | S | Org admins only |
| 12 | R19 teams name-keyed | (a) | S | URL-shape correctness for upstream-shaped links |
| 13 | R11 settings/lfs | (b) | M | LFS-using repo admins only; locks already landed |
| 13b | R22 media | (d) | S/M | Pasted media URLs; rides R21's family |
| 14 | R15 activity charts | (b, engine) | L | Tabs inside Activity; reachable only after R14 |
| 15 | R13 audit_logs (+R20 arm) | (b, model) | L | Compliance tail; SPEC-first |
| 16 | R18 admin config/notices/auths arms | (b) | M/L | Instance-admin tail; auths likely N/A |
| 17 | R02 + R05 code search (explore, user) | (d) | — | Matches upstream default config; opens only with R10's subsystem |
| 18 | R04/R12/R16/R17 (+arm-riders) | (c) | — | SPEC-0012 gate; not dispatchable by this directive |

**Dispatch order recommendation:** R21 → R03 → R01 → R19 (three no-risk
S-class wins, two of them top-5 impact) in one wave; R08 in parallel with
the engine RPC slice; R14/R06/R07 as the second wave; the (b)-engine family
(R09/R10/R15/R11) SPEC-first; R13 behind its audit SPEC; (c) untouched.

---

## Open issues for the orchestrator

1. **Scan reconciliation** — the dispatch brief's 14+3 quick scan omits four
   ABSENT and two PARTIAL survey rows and counts one LANDED row
   (`blob_excerpt`); this census's 22-row set is authoritative. Any dispatch
   must not re-dispatch `blob_excerpt` (LANDED `67adfb7`).
2. **Engine-RPC discipline** — R08/R09/R10/R14/R15 add boundary RPCs: each
   must carry an explicit walk budget (the `PATH_LOG_SCAN`/`MAX_STATS_SCAN`
   conventions), regenerate `dist-types/` via `pnpm typecheck`, and probably
   deserve SPEC-first treatment (design-level per the repo workflow) —
   R15's async-generate-vs-synchronous posture especially.
3. **SPEC-first candidates** — audit-events model (R13), the grep subsystem
   (R10/R02/R05), the contributor-stats RPC (R15), the LFS pointer scan
   (R11). The (a) rows need no SPEC.
4. **Render-policy calls** — heatmap widget (SSR grid vs upstream's
   client-fetch flow, R03), activity charts (SSR SVG vs inline JSON+script,
   R14/R15), graph SVG (R09). Upstream renders all three client-side; our
   SSR vocabulary diverges by construction — decide once, apply tree-wide.
5. **Admin auths page** — likely N/A (single auth method); policy call:
   honest-absence page vs nav omission (the dead-link rule cuts the other
   way for a surface upstream always shows).
6. **Admin config page** — renderable from landed config with
   honest-absence sections; a divergence-ledger call whether that counts as
   parity or waits for a system-settings store.
7. **`index.ts` serialization** — every UI mount rides the shared
   `index.ts` (10,764 lines, the survey's structural endpoint); batch the
   (a) wave's mounts into one registration window and prove each route
   through the live router (the dead-route process note: four incidents of
   one class).
8. **`/-*` namespace constraint** — the heatmap tail registration must reuse
   the `:owner{...}` negative-charset constraint convention (`ae32b1a`) so
   it does not shadow the landed `/-/projects` shapes.
9. **Member-only posture** — R06/R07 are `RequireMember: true` upstream;
   keep the 404-for-non-members posture rather than softening to public
   visibility (the survey's divergence-ledger discipline).

---

## Landing ledger (2026-10-29)

Appended 2026-10-29 at HEAD `e5e1432`; every hash below was verified against
`git log` before writing. Ten census rows closed (nine whole-row flips plus
R20's applications arm), five units in flight, five SPEC'd — row → closing
commit:

| Row | Census class | Disposition | Commit(s) |
|---|---|---|---|
| R01 `GET /explore/organizations` | (a) | **LANDED** | `77e8567` (the `explore-organizations` family over the visibility-ladder org listing) |
| R03 `GET /{username}/-/heatmap` | (a) | **LANDED** | `77e8567` (the web JSON route + the SSR widget arm in the profile feed) |
| R06 `GET /org/{org}/dashboard[/{team}]` | (a) | **LANDED** | `77e8567` (member-gated 404-shell posture kept; the `/dashboard/-/heatmap` tail stays unclaimed — a recorded reduction) |
| R07 `GET /org/{org}/issues\|pulls\|milestones[/{team}]` | (a) | **LANDED** | `77e8567` (the org-inbox family, member-ladder scope + the team arm) |
| R08 `GET .../blame/...` | (b, engine) | **LANDED** | boundary RPC `aa1fb29`; page + the file-view Blame anchor `77e8567` |
| R14 `GET .../activity[/{period}]` | (b, engine) | **LANDED** | page counts-first `5f5e167` → `activityStats` RPC `7a310b3` (SPEC-0015 M2a) → shell Activity tab + route wiring `77e8567` → the engine upgrade (numstat trio) `c14359c` |
| R19 `GET /{org}/teams/{team}` name-keyed | (a) | **LANDED** | `77e8567` (the name carrier; the merged members+repositories slice stays, the census's recorded closer-port call) |
| R20 applications arm ("R20a") | (a) | **LANDED** | `77e8567` (`org-settings-applications.tsx` behind the org-admin gate; row R20 itself stays PARTIAL — its audit arm is R13's) |
| R21 `GET .../raw/...` | (d) | **LANDED** | `77e8567` (the raw-file family incl. the deprecated legacy-guess catch-all; `links.ts` switched to the upstream web shape — the tier-1 API link divergence is retired) |
| R22 `GET .../media/...` | (d) | **LANDED** | `77e8567` (the media-file family with LFS pointer resolution through the landed store) |
| R10 in-repo code search | (b, engine) | RPC **LANDED**; page **IN FLIGHT** | RPC `0644597` (SPEC-0015 M1: exact/words/regexp, the regexp arm a step-counted NFA, all four budgets explicit); page `pages/repo-search.tsx` uncommitted at append time |
| R13 `.../settings/audit_logs` (+R20 arm) | (b, model) | Model **LANDED**; page **IN FLIGHT** | Model `5c8853c` (SPEC-0015 M4: `audit_event` table, migration 0038, emit seam, 90-day retention); page `pages/settings-audit-logs.tsx` uncommitted |
| R15 activity charts | (b, engine) | RPC **LANDED**; pages **IN FLIGHT** | RPC `449400a` (SPEC-0015 M2b `contributorStats`); pages `pages/repo-charts.tsx` uncommitted |
| R09 `GET .../graph` | (b, engine) | **SPEC'D**; RPC **IN FLIGHT** | SPEC-0017 accepted (`0717de7`, draft `8dd664b`); the `graphData` RPC is in the working tree, absent at HEAD |
| R11 `.../settings/lfs[/...]` | (b) | **SPEC'D**; pages not yet dispatched | The pointer-scan prerequisite is SPEC-0015's M3 (`5025476`, accepted; M3 pending at the boundary) |
| R04 / R16 packages | (c) | **SPEC'D**; M1 **IN FLIGHT** | SPEC-0016 accepted (`8dd664b` draft, `0717de7`); M1 routes + services + migration 0039 uncommitted; the R04/R16 UI pages stay downstream of the API |
| R18/R20 remaining (b) arms — admin config/notices/auths | (b) | **SPEC'D**; nothing built | SPEC-0018 accepted (`36d9b52`: notices BUILD, config BUILD read-only, auths OMIT) |
| R02 + R05 code search (explore, user) | (d) | **UNCHANGED** | The grep RPC deliberately does not open them (SPEC-0015 out-of-scope: the indexer-class subsystem is the gate) |
| R12 + R17 Actions settings/run surface | (c) | **UNCHANGED** | The SPEC-0012 demand gate stands |

Ledger arithmetic: the survey's tick-16 headline **94/5/17** moves to
**103 LANDED / 2 PARTIAL / 11 ABSENT** of 116 when the survey's next formal
tick re-walks programmatically — nine whole-row flips (six ABSENT → LANDED:
R01/R03/R06/R07/R08/R14; three PARTIAL → LANDED: R19/R21/R22), R18 and R20
staying PARTIAL with their landed arms recorded above. The tick itself is
not part of this ledger; per-row status remains the survey's authority until
it runs.
