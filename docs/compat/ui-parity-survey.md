# UI Parity Survey — the demand-driven gap inventory

What the vendored upstream serves (page-bearing GETs) at our pin vs what
`uiRouter` claims today. This is the demand-driven phase's input: every gap is
tagged with its demand signal and an effort guess so dispatch can be ranked by
demand-per-effort instead of by route-table order. Companion to
`api-remaining-inventory.md` (the API-side twin). **Fully regenerated
2026-10-26** at HEAD `99d21c5` after the previous edition (written at
landed=28/partial=3/absent=82) drove waves 16-20 + ui-parity-2 to completion
and ui-parity-3 into flight — every row it recommended has landed or is in
flight (see the ledger below).

- **Pin**: `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919;
  verified `git -C gitea rev-parse HEAD`). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the route table + parser families in
  `apps/worker/src/ui/index.ts` at HEAD `99d21c5` — the header inventory
  (`src/ui/index.ts:6-322`) and the `ParsedUiRoute` union are the exhaustive
  family list (a family exists iff a parse branch returns it); the pages under
  `apps/worker/src/ui/pages/` (35 modules) and the session router
  (`src/ui/session.ts`) carry the renders. The WORKING TREE is excluded:
  ui-parity-3's wave-24 wiring (`index.ts` +258 uncommitted lines,
  `repo-social.tsx` + `settings-collaboration.tsx` untracked) is in flight and
  counted in the In-flight section, not the totals.
- **Reproducing the counts** (exactly these walks):
  1. Upstream: walk the page-bearing GETs out of `gitea/routers/web/web.go`
     (`m.Get`/`m.Combo(...).Get` registrations, grouped into the same 6
     families and 113 rows as the original survey; aux surfaces excluded per
     the preamble) — the row set is pin-stable, unchanged since the last
     edition.
  2. Ours: `grep -n "family:" apps/worker/src/ui/index.ts` (the parse
     branches) + `ls apps/worker/src/ui/pages/` (the renders) at HEAD;
     `git status --short -- apps/worker/src/ui/` names the in-flight files to
     exclude.
  3. API dependencies: `node scripts/check-openapi.mjs` (ends `PASS`) —
     `grep` its `[ok]` lines for the op named per row.
- **Data prerequisites** are read from what is actually landed TODAY: the
  engine boundary (`packages/git-engine/dist-types/repo.d.ts` — `listRefs`,
  `readCommit`, `listLog`, `listTree`, `readDiff`, `readBlob`; blame/snapshot/
  graph remain private DO pages, not boundary RPCs), the merge machinery, the
  landed API services under `apps/worker/src/api/services/`, and the API
  families declared since the last edition (avatars `d7f5646`, deploy keys
  `4af12a9`, git hooks `5b704c5`, tag protections `a80878c`, projects store
  `0d5b480`/`fc123b0` (+ org scope in flight), oauth2 apps `42ab6a5`, wiki
  `d3362b1`, feeds `2ef9359` — see the twin inventory's ledger).
- POST actions are out of scope except where a landed page's write already
  rides the same URL; upstream's aux surfaces (`/devtest/*` — web.go:1799-1817,
  `/-/ws` — web.go:615, `/api/swagger` — web.go:305, robots/captcha/metrics,
  go-get, the git-protocol and LFS families) are likewise out of scope.

## Legend

**Status**
- **LANDED** — our router claims the family and renders the page (divergences noted).
- **PARTIAL** — claimed but incomplete, or served at a divergent shape noted here.
- **ABSENT** — upstream serves a page; we 404 (engine-owned) it.
- **IN-FLIGHT** — an owning agent has it in the tree uncommitted; excluded
  from the totals, do not re-dispatch (see In-flight).

**Data** — what the page would sit on: **landed** (service/engine read exists
today), **partial** (sibling service exists, a query/model piece is missing),
**none** (no model or no engine boundary RPC).

**Demand** — **core** (anonymous/reader browsing: code, history, releases,
discovery), **authoring** (signed-in contributor workflows: issues, PRs,
editor, settings, creation), **admin** (instance administration and long tail).

**Effort** — **S** (one wave-style slice: parser family + page over landed
services), **M** (multi-page family, new D1 queries/aggregation, or an engine
call whose plumbing doesn't exist yet in the UI layer), **L** (needs a new data
model or a new engine-boundary RPC / whole subsystem).

## Family summary

| Family | rows | LANDED | PARTIAL | ABSENT | IN-FLIGHT |
|---|---|---|---|---|---|
| A site-level + auth | 24 | 9 | 0 | 15 | 0 |
| B owner pages | 16 | 6 | 1 | 9 | 0 |
| C repo code browsing | 25 | 7 | 2 | 16 | 0 |
| D issues + pulls | 22 | 9 | 0 | 13 | 0 |
| E repo settings | 12 | 4 | 0 | 7 | 1 |
| F repo sub-systems | 14 | 1 | 1 | 9 | 3 |
| **total** | **113** | **36** | **4** | **69** | **4** |

(The previous edition's headline 28/3/82 was table-accurate; its B and D
family summary lines each miscounted one landed row — the tables below are
the corrected walk. Delta: +8 LANDED (repo/org create, `/-/repositories`,
org members, commit view, branches, PR-commits tab, releases), +1 PARTIAL
(releases new-vs-edit split), −4 to IN-FLIGHT.)

## In-flight (excluded from the totals — do not re-dispatch)

### ui-parity-3 / pages wave 24 — 4 rows (uncommitted)

`apps/worker/src/ui/pages/repo-social.tsx` and
`apps/worker/src/ui/pages/settings-collaboration.tsx` sit untracked in the
tree, with the wave-24 wiring (+258 lines) uncommitted in
`apps/worker/src/ui/index.ts`:

- **`GET .../forks`** (web.go:1759), **`GET .../stars`** (web.go:1766),
  **`GET .../watchers`** (web.go:1767) — the social-list trio, one module over
  `listForks` + `social-lists.ts`/`repo-watchers.ts` (all landed); the
  previous edition's bench tier, third-ranked row.
- **`GET .../settings/collaboration`** (web.go:1194) — the collaborators
  panel (+ its `access_mode`/`delete`/team write tails, web.go:1194-1204),
  over the landed `repo-collaborators.ts`; the previous edition's bench tier.

Until these commit, `index.ts` at HEAD does NOT claim the four families and
the pages 404-shell — the totals above are the honest serving state.

## Landed since last regen

The previous edition's entire recommendation tier landed: its top 5 (one row
excepted) and its bench, in seven UI commits — the deltas below sum
28→36 LANDED (plus the 4 in-flight rows its bench named):

| Slice | Rows landed | Commit |
|---|---|---|
| wave 16 — branches page + protection badge | `GET .../branches` (web.go:1696) | `308b5c8` |
| the PR-commits tab slice | `GET .../pulls/{index}/commits` (web.go:1661) | `ec7da26` |
| wave 18 — the commit view (old #1) | `GET .../commit/{sha}` (web.go:1739) | `b447a7d` |
| wave 19 — repo + org creation (old #2) | `GET /repo/create` (web.go:1098), `GET /org/create` (web.go:972) | `b894055` |
| wave 20 — the releases family (old #4) | `GET .../releases` + `/new` + `/latest` + `/tag/*` (web.go:1505-1520) | `d3c8c4b` |
| ui-parity-2 — org members + repositories (bench) | `GET /org/{org}/members` (web.go:965), `GET /{username}/-/repositories` (web.go:1134) | `06eee50` |
| ui-parity-3 / wave 24 (bench: social trio + collaboration) | 4 rows — see In-flight | in tree |

Non-UI landings in the same window that moved Data columns below: avatars
(`d7f5646`), deploy keys (`4af12a9`), git hooks (`5b704c5`), tag protections
(`a80878c`), projects repo scope (`0d5b480`, REG `fc123b0`) + org scope (in
flight), oauth2 apps (`42ab6a5`), wiki (`d3362b1`), feeds (`2ef9359`) — the
full op-level ledger is `api-remaining-inventory.md` (declared 318→447).

## A. Site-level and auth

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /` (dashboard / landing) | web.go:529 | LANDED (`pages/dashboard.tsx`) | landed | core | — |
| `GET /explore` (redirect) | web.go:550-552 | LANDED | landed | core | — |
| `GET /explore/repos` | web.go:553 | LANDED (`pages/explore.tsx`) | landed | core | — |
| `GET /explore/users` | web.go:555 | LANDED | landed | core | — |
| `GET /explore/organizations` | web.go:557 | ABSENT | partial (org rows + `adminGetAllOrgs` landed, admin-gated; no anonymous visible-org search arm — `OrgService` has no explore listing, verified) | core | M |
| `GET /explore/code` | web.go:558-563 | ABSENT | none (no grep RPC) | authoring | L |
| `GET /explore/topics/search` | web.go:564 | ABSENT (aux JSON) | landed (topics) | admin | S |
| `GET /sitemap.xml` + explore sitemaps | web.go:530,554,556 | ABSENT | landed | admin | M |
| `GET /issues` (global inbox) | web.go:568 | ABSENT | partial (cross-repo perm filter missing) | authoring | M |
| `GET /pulls` (global) | web.go:572 | ABSENT | partial | authoring | M |
| `GET /milestones` (global) | web.go:573 | ABSENT | partial | authoring | M |
| `GET /user/login` | web.go:577 | LANDED as `/login` (SPEC-0010 divergence) | landed | core | — |
| `GET /user/sign_up` | web.go:595 | ABSENT | partial (no self-serve registration service verified) | core | M |
| `GET /user/settings` (profile) | web.go:634 | LANDED (`pages/user-settings.tsx`) | landed | authoring | — |
| `/user/settings/{account,appearance,security,applications,keys,organization,repos}` | web.go:641-735 | ABSENT (keys via `account-keys.ts`, oauth2 apps via migration 0026 landed) | partial | authoring | M each |
| `GET /notifications` + `/new` + `/status` + `/purge` | web.go:1785,1788-1789,1791 | LANDED (`pages/notifications.tsx`) | landed | authoring | — |
| `/notifications/subscriptions`, `/watching`, `/purge-page` | web.go:1786-1787,1790 | ABSENT | partial | authoring | M |
| `/-/admin/*` (dashboard, users, repos, orgs, config, monitor, notices, auths, emails, badges, packages, hooks, applications, actions) | web.go:780-906 | ABSENT (whole family) | partial (user/repo lists + most admin ops declared) | admin | L |
| `GET /org/create` | web.go:972 | LANDED (`pages/org-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/create` | web.go:1098 | LANDED (`pages/repo-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/migrate` | web.go:1100 | ABSENT | landed (`services/migrate.ts`) | authoring | M |
| `GET /repo/search` | web.go:1102 | ABSENT (aux JSON feed; `repoSearch` declared) | landed | authoring | S |
| `GET /attachments/{uuid}` | web.go:912 | ABSENT | partial (issue-attachments API landed) | authoring | S |
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | ABSENT | partial (R2 avatar store + write ops landed `d7f5646`; the by-hash public serving read is the missing arm) | core | S |

**A: 24 rows — 9 LANDED, 15 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | ABSENT | landed (`repoListActivityFeeds` family declared `2ef9359`, `renderFeedItems` in `api/services/activity-feeds.ts`; the XML rendering is the work) | admin | M |
| `GET /{username}/-/repositories` (org repo list) | web.go:1134 | LANDED (`pages/org-repos.tsx`, ui-parity-2) | landed | core | — |
| `GET /{username}/-/heatmap` | web.go:1135 | ABSENT | none | admin | M |
| `GET /{username}/-/packages[/...]` | web.go:1108-1128 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET /{username}/-/projects[/...]` | web.go:1137-1163 | ABSENT | landed (projects store 0024 + repo scope 21 ops `0d5b480`, org scope in flight — effort drops L→M) | authoring | M |
| `GET /{username}/-/code` (global code search) | web.go:1166 | ABSENT | none (no grep RPC) | authoring | L |
| `GET /org/{org}/members` | web.go:965 | LANDED (`pages/org-members.tsx`, ui-parity-2) | landed | core | — |
| `GET /org/{org}/dashboard[/{team}]` (+heatmap) | web.go:982-985 | ABSENT | partial | authoring | M |
| `GET /org/{org}/issues|pulls|milestones[/{team}]` | web.go:986-991 | ABSENT | partial | authoring | M |
| `GET /{org}/teams` | web.go:993 | LANDED (`pages/org-teams.tsx`, owner gate) | landed | authoring | — |
| `GET /{org}/teams/{team}` (+`/repositories` web.go:998) | web.go:997-998 | PARTIAL — landed id-keyed detail (upstream links by team NAME); repositories list merged into the detail slice | landed | authoring | — |
| `GET /{org}/teams/new` | web.go:1009 | LANDED | landed | authoring | — |
| `GET /{org}/teams/{team}/edit` | web.go:1011 | ABSENT | landed (`orgEditTeam` declared; org-teams.tsx extends) | authoring | S |
| `GET /{org}/settings` (+hooks, packages, blocked_users, applications) | web.go:1017-1092 | ABSENT (whole group except labels below; org hooks ops landed — the hooks tab is page work) | partial | authoring | M per tab |
| `GET /org/{org}/settings/labels` | web.go:1043-1049 | LANDED at `/{org}/labels` (documented divergence; the three POST segments ride upstream's literals) | landed | authoring | — |

**B: 16 rows — 6 LANDED, 1 PARTIAL, 9 ABSENT.**

## C. Repo code browsing

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{owner}/{repo}` (repo home) | web.go:1292 | LANDED (`pages/home.tsx`) | landed | core | — |
| `GET .../src/{branch|tag|commit}[/*]` | web.go:1749-1755 | LANDED (`pages/file-view.tsx`) | landed | core | — |
| `GET .../tree/*` (redirect to /src) | web.go:1756 | LANDED (`pages/repo-home.tsx`) | landed | core | — |
| `GET .../blob/*` (redirect to /src/commit) | web.go:1757 | ABSENT (redirect only) | landed | core | S |
| `GET .../commits/{branch|tag|commit}[/*]` | web.go:1722-1727 | LANDED (`pages/commits.tsx`) | landed | core | — |
| `GET .../commit/{sha}` (commit detail + diff) | web.go:1739 | LANDED (`pages/commit-view.tsx`, wave 18; full-oid resolve, short-prefix 404-shell divergence) | landed | core | — |
| `GET .../commit/{sha}/load-branches-and-tags` | web.go:1740 | ABSENT (aux JSON) | landed | core | S |
| `GET .../commit/{sha}.{patch|diff}` | web.go:1760 | ABSENT | landed (`diffpatch.ts`) | authoring | S |
| `GET .../blame/{branch|tag|commit}/*` | web.go:1729-1733 | ABSENT | none (blame is a private DO page, not a boundary RPC) | authoring | L |
| `GET .../graph` | web.go:1738 | ABSENT | none | admin | L |
| `GET .../raw/{branch|tag|commit}/*` | web.go:1707-1713 | PARTIAL — our pages emit the tier-1 API raw route instead (`links.ts:41`, documented divergence); the upstream web shape 404s | landed (`readBlob`) | core | S |
| `GET .../media/{branch|tag|commit}/*` | web.go:1699-1705 | PARTIAL — same divergence (upstream's LFS-aware + SVG-sandboxed media path) | landed | core | S |
| `GET .../render/{branch|tag|commit|blob}/*` | web.go:1715-1720 | ABSENT | landed | authoring | S |
| `GET .../blob_excerpt/{sha}` | web.go:1735 | ABSENT (aux fragment) | landed | core | S |
| `GET .../tree-list/*`, `/tree-view/*` (directory-expansion fragments) | web.go:1297-1306 | ABSENT | landed (`listTree`) | core | S |
| `GET .../archive/{ref}.{format}` | web.go:1689-1692 | ABSENT | landed (`services/archive.ts`) | core | S |
| `GET .../branches` (list page) | web.go:1696 | LANDED (`pages/branches.tsx`, wave 16) | landed | core | — |
| `GET .../branches/list` | web.go:1695 | ABSENT (aux JSON) | landed | core | S |
| `GET .../tags` (list page) | web.go:1496 | ABSENT | landed (`listRefs`; `repoListTags` declared) | **core** | **S** |
| `GET .../tags/list` | web.go:1499 | ABSENT (aux JSON) | landed | core | S |
| `GET .../lastcommit/*` | web.go:1761 | ABSENT (aux fragment) | landed | core | S |
| `GET .../search` (in-repo code search) | web.go:1768 | ABSENT | none (no grep RPC) | authoring | L |
| `GET .../{_edit|_new|_delete}/*` (editor combos) | web.go:1453-1461 | LANDED at `/{new|edit|delete}/*` (documented divergence at the brief's literal names, `pages/file-editor.tsx`) | landed | authoring | — |
| `GET .../_upload/*` | web.go:1462-1464 | ABSENT | partial | authoring | M |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | ABSENT | landed (diffpatch + merge machinery) | authoring | M |

**C: 25 rows — 7 LANDED, 2 PARTIAL, 16 ABSENT.**

## D. Issues and pulls

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../issues` | web.go:1347 | LANDED (`pages/issues-list.tsx`) | landed | core | — |
| `GET .../pulls` | web.go:1654 | LANDED (same component) | landed | core | — |
| `GET .../issues/{index}` | web.go:1348 | LANDED (`pages/issue-detail.tsx`) | landed | core | — |
| `GET .../pulls/{index}` | web.go:1656 | LANDED (same component; family-mismatch 303 parity) | landed | core | — |
| `GET .../pulls/{index}.{diff|patch}` | web.go:1657-1658 | ABSENT | landed (`diffpatch.ts`) | authoring | S |
| `GET .../pulls/{index}/merge_box` | web.go:1659 | ABSENT (fragment) | partial | authoring | S |
| `GET .../pulls/{index}/commits` | web.go:1661-1663 | LANDED (`pages/pull-commits.tsx`, slice `ec7da26`) | landed | authoring | — |
| `GET .../pulls/{index}/files` | web.go:1671 | LANDED (`pages/pull-files.tsx`) | landed | authoring | — |
| `GET .../pulls/{index}/files/{a}..{b}` (range) | web.go:1672 | ABSENT | landed | authoring | S |
| `GET .../compare[/{base}...{head}]` | web.go:1307-1313 | LANDED (`pages/compare.tsx`; `..` two-dot and fork forms unclaimed — documented divergences) | landed | authoring | — |
| `GET .../compare/*.{diff|patch}` | web.go:1309-1310 | ABSENT | landed | authoring | S |
| `GET .../pulls/new/*` (redirect) | web.go:1314 | ABSENT | landed | authoring | S |
| `GET .../issues/new` | web.go:1355 | LANDED (`pages/new-issue.tsx`) | landed | authoring | — |
| `GET .../issues/new/choose` (template chooser) | web.go:1357 | ABSENT | partial | authoring | S |
| `GET .../labels` (list page) | web.go:1338 | ABSENT | landed (labels API fully declared: `issueListLabels`/`issueGetLabel`/`issueCreateLabel`/`issueEditLabel`/`issueDeleteLabel`) | authoring | S |
| `GET .../milestones` | web.go:1339 | LANDED (`pages/milestones.tsx`) | landed | authoring | — |
| `GET .../milestone/{id}` (detail: issues+pulls) | web.go:1340 | ABSENT | landed (`issueGetMilestone` declared; issues list `?milestones=` filter) | authoring | S |
| `GET .../milestones/{id}/edit` | web.go:1427 | ABSENT | landed (`issueEditMilestone` declared) | authoring | S |
| `GET .../issues/search` | web.go:1359 | ABSENT (aux JSON) | landed | authoring | S |
| `GET .../{type}/{index}/info|attachments|content-history/*` | web.go:1321-1330 | ABSENT (fragments) | partial | authoring | M |
| `GET .../comments/{id}/attachments` | web.go:1337 | ABSENT (aux) | partial | authoring | S |
| `GET .../issues/suggestions` | web.go:1341 | ABSENT (aux) | landed | authoring | S |

**D: 22 rows — 9 LANDED, 13 ABSENT.**

## E. Repo settings

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../settings` (basics) | web.go:1185 | LANDED (`pages/settings.tsx`, admin viewer only) | landed | authoring | — |
| `GET .../settings/collaboration` (+write tails) | web.go:1194-1204 | IN-FLIGHT (ui-parity-3, `settings-collaboration.tsx`) | landed (`repo-collaborators.ts`) | authoring | — |
| `GET .../settings/branches` (+`/edit`, `/priority`, `/{id}/delete`) | web.go:1207-1213 | LANDED (`pages/branch-protection.tsx`) | landed | authoring | — |
| `GET .../settings/tags` (protected tags) | web.go:1215-1221 | ABSENT | landed (protected_tags 0025 + all 5 `repo*TagProtection` ops declared `a80878c` — effort re-checked M: list+form+enforcement-badge page work) | authoring | M |
| `GET .../settings/hooks/git` | web.go:1223-1227 | ABSENT | landed (git hooks: `repoListGitHooks`/`repoGetGitHook`/`repoEditGitHook`/`repoDeleteGitHook` declared `5b704c5`) | admin | S |
| `GET .../settings/hooks` + `/{id}` + `/{type}/new` | web.go:1229-1239 | LANDED (list, generic add form, per-hook page + test/delete; upstream's per-provider `{type}/new` forms ride our generic form — divergence) | landed | authoring | — |
| `GET .../settings/keys` (deploy keys) | web.go:1241-1247 | ABSENT | landed (deploy keys 0020; `repoListKeys`/`repoCreateKey`/`repoDeleteKey` declared `4af12a9`) | authoring | M |
| `GET .../settings/lfs[/...]` (files, pointers, locks) | web.go:1249-1261 | ABSENT | partial (LFS server landed; pointer-scan queries missing) | authoring | M |
| `GET .../settings/actions*` | web.go:1262-1278 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |
| `GET .../settings/audit_logs` | web.go:1279 | ABSENT | none | admin | L |
| `GET .../settings/mirror` | (upstream renders inside options.tmpl — divergence noted) | LANDED at the literal (`pages/settings.tsx`) | landed | authoring | — |
| `GET .../settings/public_access` | web.go:1191 | ABSENT | partial | authoring | S |

**E: 12 rows — 4 LANDED, 7 ABSENT, 1 IN-FLIGHT.**

## F. Repo sub-systems (releases, wiki, activity, social, packages/projects/actions)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../releases` (+`/tag/*`, `/latest`, feeds) | web.go:1505-1514 | LANDED (`pages/releases.tsx`, wave 20) | landed | core | — |
| `GET .../releases/new`, `/edit/*` | web.go:1516-1520 | PARTIAL — `/new` LANDED (wave 20); `/edit/*` + `/delete` unclaimed | landed (`createRelease` landed) | authoring | S |
| `GET .../releases/download/{tag}/{file}`, `/releases/attachments/{uuid}` | web.go:1513-1514 | ABSENT | landed (`release-assets.ts`) | core | S |
| `GET .../fork` (fork form) | web.go:1490 | ABSENT | landed (`createFork` declared, `forks.ts`) | authoring | S |
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | ABSENT | landed (wiki 6 ops declared `d3362b1`, `services/wiki.ts` + the sibling engine cell — effort drops L→M) | authoring | M |
| `GET .../activity[/{period}]` | web.go:1628-1631 | ABSENT | partial (feed rows landed `2ef9359`; the stats aggregation stays private on the DO) | core | M |
| `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` | web.go:1633-1646 | ABSENT | partial (aggregation private on the DO) | admin | M |
| `GET .../activity_author_data` | web.go:1683-1687 | ABSENT (aux JSON) | partial | admin | S |
| `GET .../forks` | web.go:1759 | IN-FLIGHT (ui-parity-3, `repo-social.tsx`) | landed (`listForks`) | core | — |
| `GET .../stars` | web.go:1766 | IN-FLIGHT (ui-parity-3) | landed (`stars.ts`, `social-lists.ts`) | core | — |
| `GET .../watchers` | web.go:1767 | IN-FLIGHT (ui-parity-3) | landed (`repo-watchers.ts`) | core | — |
| `GET .../packages` | web.go:1538-1542 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET .../projects[/...]` | web.go:1544-1563 | ABSENT | landed (projects store 0024 + repo scope landed, org scope in flight — effort drops L→M) | authoring | M |
| `GET .../actions[/...]` | web.go:1566-1608 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |

**F: 14 rows — 1 LANDED, 1 PARTIAL, 9 ABSENT, 3 IN-FLIGHT.**

## Totals

**113 rows: 36 LANDED, 4 PARTIAL, 69 ABSENT — plus 4 IN-FLIGHT (ui-parity-3,
excluded from the tally).**

By family (landed/partial/absent + in-flight): A 9/0/15, B 6/1/9, C 7/2/16,
D 9/0/13, E 4/0/7 +1, F 1/1/9 +3. The landed set now covers every
highest-traffic single page (repo home, file view, commits log, commit
detail, branches, issues/PRs lists + details + both PR side tabs, compare,
releases browse + create, creation forms, org members/repositories). The
remaining absence mass concentrates in (a) small page slices over fully
landed data (tags page, labels page, milestone detail/edit, patch/diff
downloads, archive, fork form), (b) settings tabs whose APIs just landed
(deploy keys, protected tags, git hooks, org hooks), and (c) whole subsystems
with no data model (actions, packages, audit logs) or no engine RPC (blame,
graph, code search, heatmap) that are correctly out of the demand-driven
phase's reach.

## Recommendation — top 5 by demand-per-effort

Every row below is dispatchable now: its API surface is fully declared
(`node scripts/check-openapi.mjs` PASS — greps shown per row) or needs no API
at all.

1. **`GET .../tags`** (web.go:1496, S, core) — the surviving half of the old
   #3 and the last core browsing tab: one `listRefs` read (engine boundary,
   landed) and the branches page (`pages/branches.tsx`, wave 16) as the
   template. API dependency: **none for the page**; the tier-1 feed
   (`repoListTags`, `repoGetTag`) is already declared `[ok]`.
2. **`GET .../labels`** (web.go:1338, S, authoring) — the repo labels
   management page, the last issues-family gap with landed data.
   API dependency: `issueListLabels`, `issueGetLabel`,
   `issueCreateLabel`, `issueEditLabel`, `issueDeleteLabel` — all declared
   `[ok]`. `pages/org-labels.tsx` (wave 14) is the template, including the
   POST-write pattern.
3. **`GET .../milestone/{id}` + `.../milestones/{id}/edit`** (web.go:1340,
   1427, S, authoring) — the milestone row's dead-ends: the detail page is
   the issues list filtered to the milestone, the edit form extends
   `pages/milestones.tsx` (wave 6). API dependency: `issueGetMilestone`,
   `issueEditMilestone` — both declared `[ok]`; the issue query rides the
   declared ListIssues `?milestones=` filter.
4. **`GET .../commit/{sha}.{patch|diff}` + `GET .../pulls/{index}.{diff|patch}`**
   (web.go:1760, 1657-1658, S, authoring) — the patch-mail workflow's two
   downloads; upstream has no tier-1 API op for either, so this is pure UI:
   `services/diffpatch.ts` (landed) + the renderers `commit-view.tsx` /
   `pull-files.tsx` already own. Parser note: the dotted tail currently
   404-shells inside the commit-view family's non-hex arm — the slice claims
   the literal shapes ahead of it.
5. **`GET .../fork`** (web.go:1490, S, authoring) — the fork form, one page
   + POST over landed machinery. API dependency: `createFork` — declared
   `[ok]` (202/403/404/409/422 arms), `services/forks.ts` landed. Distinct
   from the forks LIST page, which is ui-parity-3's in-flight territory.

Bench (next tier — dispatch when the pool needs dependency-ready goals; all
data-landed, no API work): `.../blob/*` redirect (web.go:1757, S, core —
a 303 onto `/src`), `.../archive/{ref}.{format}` (web.go:1689, S, core —
`services/archive.ts`), `.../releases/download/{tag}/{file}` +
`/releases/attachments/{uuid}` (web.go:1513-1514, S, core —
`release-assets.ts`), `/{org}/teams/{team}/edit` (web.go:1011, S,
authoring — `orgEditTeam` declared `[ok]`), `.../pulls/new/*` redirect
(web.go:1314, S), `.../blob_excerpt` + `tree-list|tree-view` fragments
(web.go:1735, 1297-1306, S, core — `listTree`), `.../render/*` (web.go:1715,
S). M-tier page work over just-landed APIs, in demand order: the **wiki
family** (web.go:1611-1625 — `repoGetWikiPages`/`repoGetWikiPage`/
`repoCreateWikiPage`/`repoEditWikiPage`/`repoDeleteWikiPage`/
`repoGetWikiPageRevisions`, all declared `[ok]`), the **repo projects
pages** (store 0024 landed), **settings/keys** (deploy keys),
**settings/tags** (protected tags), **settings/hooks/git** (git hooks, S),
the **org settings** group (org hooks ops landed), `/{username}.rss/.atom`
(feeds), `/{username}/-/projects` + `/explore/organizations` (the latter
needs the missing visible-org search arm first — data partial, M).
GATED rows (do not dispatch without the feature SPEC): everything
actions/packages (`/-/admin` actions+packages tabs, `settings/actions`,
`.../actions*`, `.../packages`, `/{username}/-/packages` — FEATURE-ABSENT
APIs per the twin inventory's 64 remaining ops), plus the no-RPC pages
(blame, graph, in-repo/explore code search, heatmap, audit_logs). The
`.../raw` + `.../media` web shapes (web.go:1699-1713) stay
PARTIAL-by-divergence — our SSR pages emit tier-1 API raw links
(`links.ts:41`), so the gap only bites official-bundle references and pasted
URLs; close it opportunistically, not as a dedicated goal.
