# UI Parity Survey — the demand-driven gap inventory

What the vendored upstream serves (page-bearing GETs) at our pin vs what
`uiRouter` claims today. This is the demand-driven phase's input: every gap is
tagged with its demand signal and an effort guess so dispatch can be ranked by
demand-per-effort instead of by route-table order. Companion to
`api-remaining-inventory.md` (the API-side twin). **Fully regenerated
2026-10-26** at HEAD `99d21c5` after the previous edition (written at
landed=28/partial=3/absent=82) drove waves 16-20 + ui-parity-2 to completion
and ui-parity-3 into flight — every row it recommended has since landed.
**Ticked 2026-10-26** at HEAD `5d9122c`: a maintenance pass, not a regen —
the regen's four in-flight rows landed (`ca81d5a`) plus eight ABSENT rows
its own top-5 and bench named (the tags page, the labels page, milestone
detail + edit, the fork form, the two diffpatch-download rows, the avatar
seam), draining IN-FLIGHT to zero and moving the headline to
**48/4/61**; the dispatchable rows are re-ranked below.

- **Pin**: `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919;
  verified `git -C gitea rev-parse HEAD`). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the route table + parser families in
  `apps/worker/src/ui/index.ts` at HEAD `5d9122c` — the header inventory
  (the route-family comment block, `src/ui/index.ts:6-429`) and the
  `ParsedUiRoute` union (line 1270) are the exhaustive family list (a family
  exists iff a parse branch returns it); the pages under
  `apps/worker/src/ui/pages/` (41 files: 39 page modules + 2 test modules)
  and the session router (`src/ui/session.ts`) carry the renders, with the
  `src/web/` seam routers (avatar serving) mounted in `src/index.ts`. The
  WORKING TREE is clean of ui work at measurement time (`git status --short
  -- apps/worker/src/ui/ apps/worker/src/web/` is empty) — no in-flight
  exclusion applies.
- **Reproducing the counts** (exactly these walks):
  1. Upstream: walk the page-bearing GETs out of `gitea/routers/web/web.go`
     (`m.Get`/`m.Combo(...).Get` registrations, grouped into the same 6
     families and 113 rows as the original survey; aux surfaces excluded per
     the preamble) — the row set is pin-stable, unchanged since the last
     edition.
  2. Ours: `grep -n "family:" apps/worker/src/ui/index.ts` (the parse
     branches — 118 at this tick) + `ls apps/worker/src/ui/pages/` (the
     renders — 41 files) at HEAD; `git status --short -- apps/worker/src/ui/
     apps/worker/src/web/` must be empty for the totals to hold (it is at
     `5d9122c`).
  3. API dependencies: `node scripts/check-openapi.mjs` (ends `PASS`) —
     `grep` its `[ok]` lines for the op named per row.
- **Data prerequisites** are read from what is actually landed TODAY: the
  engine boundary (`packages/git-engine/dist-types/repo.d.ts` — `listRefs`,
  `readCommit`, `listLog`, `listTree`, `readDiff`, `readBlob`; blame/snapshot/
  graph remain private DO pages, not boundary RPCs), the merge machinery, the
  landed API services under `apps/worker/src/api/services/`, and the API
  families declared since the last edition — the projects family completed
  all three scopes (repo `fc123b0`, org REG `20512c0`, user REG `c9a7ef7`;
  declared now **490** ops, see the twin inventory's ledger), plus the
  post-490 non-op landings the twin's ledger records.
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
| A site-level + auth | 24 | 10 | 0 | 14 | 0 |
| B owner pages | 16 | 6 | 1 | 9 | 0 |
| C repo code browsing | 25 | 9 | 2 | 14 | 0 |
| D issues + pulls | 22 | 13 | 0 | 9 | 0 |
| E repo settings | 12 | 5 | 0 | 7 | 0 |
| F repo sub-systems | 14 | 5 | 1 | 8 | 0 |
| **total** | **113** | **48** | **4** | **61** | **0** |

(The regen's headline was 36/4/69 + 4 in-flight. This tick: the 4 in-flight
rows landed (`ca81d5a`), and 8 ABSENT rows landed — avatar (`bb67087`,
mounted `98d194d`), tags + labels pages (`0b61554`), milestone detail + edit
+ fork form (`ca4eb58`), the two diffpatch rows (`79ef809`) — for
48/4/61/0.)

## In-flight (excluded from the totals — do not re-dispatch)

Empty at this tick. The regen's in-flight rows — the social trio
(`.../forks`, `.../stars`, `.../watchers`) and the collaboration panel —
landed in `ca81d5a`, and every later UI wave (`bb67087`, `0b61554`,
`ca4eb58`, `79ef809`) committed clean. The tree's only modification at
measurement time was the twin inventory doc.

## Landed since last regen

The regen's entire recommendation tier landed, and this tick's window added
five more UI commits. The deltas below sum 36+4-in-flight → 48 LANDED:

| Slice | Rows landed | Commit |
|---|---|---|
| wave 16 — branches page + protection badge | `GET .../branches` (web.go:1696) | `308b5c8` |
| the PR-commits tab slice | `GET .../pulls/{index}/commits` (web.go:1661) | `ec7da26` |
| wave 18 — the commit view (old #1) | `GET .../commit/{sha}` (web.go:1739) | `b447a7d` |
| wave 19 — repo + org creation (old #2) | `GET /repo/create` (web.go:1098), `GET /org/create` (web.go:972) | `b894055` |
| wave 20 — the releases family (old #4) | `GET .../releases` + `/new` + `/latest` + `/tag/*` (web.go:1505-1520) | `d3c8c4b` |
| ui-parity-2 — org members + repositories (bench) | `GET /org/{org}/members` (web.go:965), `GET /{username}/-/repositories` (web.go:1134) | `06eee50` |
| ui-parity-3 / wave 24 — social trio + collaboration panel (the regen's 4 in-flight rows) | `GET .../forks` (web.go:1759), `.../stars` (web.go:1766), `.../watchers` (web.go:1767), `.../settings/collaboration` (web.go:1194) | `ca81d5a` |
| avatar seam (bench) | `GET /avatar/*`, `/user/avatar/*` (web.go:760,775) — the by-hash serving read + identicon port; mounted at `src/index.ts:69` | `bb67087` + `98d194d` |
| ui-parity-4 — the regen's top-2 | `GET .../tags` (web.go:1496), `GET .../labels` (web.go:1338) | `0b61554` |
| ui-parity-5 — the regen's top-3 + top-5 | `GET .../milestone/{id}` (web.go:1340), `.../milestones/{id}/edit` (web.go:1427), `GET .../fork` (web.go:1490) | `ca4eb58` |
| wave-29 — the regen's top-4 | `GET .../commit/{sha}.{patch|diff}` (web.go:1760), `GET .../pulls/{index}.{diff|patch}` (web.go:1657-1658) | `79ef809` |

Non-UI landings in the same window that moved Data columns below: the
projects family completed all three API scopes (repo `0d5b480`/`fc123b0`,
org `cc6d73e`/REG `20512c0`, user `f38b218`/REG `c9a7ef7` — declared now
490 ops), avatars (`d7f5646`), deploy keys (`4af12a9`), git hooks
(`5b704c5`), tag protections (`a80878c`), oauth2 apps (`42ab6a5`), wiki
(`d3362b1`), feeds (`2ef9359`) — the full op-level ledger is
`api-remaining-inventory.md`.

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
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | LANDED (`src/web/avatar-serving.ts`, mounted `src/index.ts:69` — `/avatars/*` + `/avatar/{hash}` + `/user/avatar/{username}/{size}`; pixel-exact identicon port, default asset via Static Assets `239a4ac`) | landed | core | — |

**A: 24 rows — 10 LANDED, 14 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | ABSENT | landed (`repoListActivityFeeds` family declared `2ef9359`, `renderFeedItems` in `api/services/activity-feeds.ts`; the XML rendering is the work) | admin | M |
| `GET /{username}/-/repositories` (org repo list) | web.go:1134 | LANDED (`pages/org-repos.tsx`, ui-parity-2) | landed | core | — |
| `GET /{username}/-/heatmap` | web.go:1135 | ABSENT | none | admin | M |
| `GET /{username}/-/packages[/...]` | web.go:1108-1128 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET /{username}/-/projects[/...]` | web.go:1137-1163 | ABSENT | landed (projects store 0024 + all three API scopes declared — repo `fc123b0`, org `20512c0`, user `c9a7ef7`; effort M) | authoring | M |
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
| `GET .../commit/{sha}.{patch|diff}` | web.go:1760 | LANDED (`pages/diffpatch-files.ts`, wave-29; mail format without signature per upstream commit.go:430-460) | landed (`diffpatch.ts`) | authoring | — |
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
| `GET .../tags` (list page) | web.go:1496 | LANDED (`pages/tags.tsx`, ui-parity-4; engine-authoritative over `listRefs`, release/tag link arms, `?tag=` prefill; the `/tags/delete` POST write + `/tags/list` aux JSON are unclaimed — re-ranked below) | landed | core | — |
| `GET .../tags/list` | web.go:1499 | ABSENT (aux JSON) | landed | core | S |
| `GET .../lastcommit/*` | web.go:1761 | ABSENT (aux fragment) | landed | core | S |
| `GET .../search` (in-repo code search) | web.go:1768 | ABSENT | none (no grep RPC) | authoring | L |
| `GET .../{_edit|_new|_delete}/*` (editor combos) | web.go:1453-1461 | LANDED at `/{new|edit|delete}/*` (documented divergence at the brief's literal names, `pages/file-editor.tsx`) | landed | authoring | — |
| `GET .../_upload/*` | web.go:1462-1464 | ABSENT | partial | authoring | M |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | ABSENT | landed (diffpatch + merge machinery) | authoring | M |

**C: 25 rows — 9 LANDED, 2 PARTIAL, 14 ABSENT.**

## D. Issues and pulls

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../issues` | web.go:1347 | LANDED (`pages/issues-list.tsx`) | landed | core | — |
| `GET .../pulls` | web.go:1654 | LANDED (same component) | landed | core | — |
| `GET .../issues/{index}` | web.go:1348 | LANDED (`pages/issue-detail.tsx`) | landed | core | — |
| `GET .../pulls/{index}` | web.go:1656 | LANDED (same component; family-mismatch 303 parity) | landed | core | — |
| `GET .../pulls/{index}.{diff|patch}` | web.go:1657-1658 | LANDED (`pages/diffpatch-files.ts`, wave-29; with-signature per upstream patch.go:26-45) | landed (`diffpatch.ts`) | authoring | — |
| `GET .../pulls/{index}/merge_box` | web.go:1659 | ABSENT (fragment) | partial | authoring | S |
| `GET .../pulls/{index}/commits` | web.go:1661-1663 | LANDED (`pages/pull-commits.tsx`, slice `ec7da26`) | landed | authoring | — |
| `GET .../pulls/{index}/files` | web.go:1671 | LANDED (`pages/pull-files.tsx`) | landed | authoring | — |
| `GET .../pulls/{index}/files/{a}..{b}` (range) | web.go:1672 | ABSENT | landed | authoring | S |
| `GET .../compare[/{base}...{head}]` | web.go:1307-1313 | LANDED (`pages/compare.tsx`; `..` two-dot and fork forms unclaimed — documented divergences) | landed | authoring | — |
| `GET .../compare/*.{diff|patch}` | web.go:1309-1310 | ABSENT | landed | authoring | S |
| `GET .../pulls/new/*` (redirect) | web.go:1314 | ABSENT | landed | authoring | S |
| `GET .../issues/new` | web.go:1355 | LANDED (`pages/new-issue.tsx`) | landed | authoring | — |
| `GET .../issues/new/choose` (template chooser) | web.go:1357 | ABSENT | partial | authoring | S |
| `GET .../labels` (list page) | web.go:1338 | LANDED (`pages/repo-labels.tsx`, ui-parity-4; live create/edit/delete writes, org section, issues-facet anchors) | landed | authoring | — |
| `GET .../milestones` | web.go:1339 | LANDED (`pages/milestones.tsx`) | landed | authoring | — |
| `GET .../milestone/{id}` (detail: issues+pulls) | web.go:1340 | LANDED (`pages/milestone-detail.tsx`, ui-parity-5; `?state`/`?labels` facets, progress bar, writer gates) | landed | authoring | — |
| `GET .../milestones/{id}/edit` | web.go:1427 | LANDED (`pages/milestone-detail.tsx` edit form, ui-parity-5) | landed | authoring | — |
| `GET .../issues/search` | web.go:1359 | ABSENT (aux JSON) | landed | authoring | S |
| `GET .../{type}/{index}/info|attachments|content-history/*` | web.go:1321-1330 | ABSENT (fragments) | partial | authoring | M |
| `GET .../comments/{id}/attachments` | web.go:1337 | ABSENT (aux) | partial | authoring | S |
| `GET .../issues/suggestions` | web.go:1341 | ABSENT (aux) | landed | authoring | S |

**D: 22 rows — 13 LANDED, 9 ABSENT.**

## E. Repo settings

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../settings` (basics) | web.go:1185 | LANDED (`pages/settings.tsx`, admin viewer only) | landed | authoring | — |
| `GET .../settings/collaboration` (+write tails) | web.go:1194-1204 | LANDED (`pages/settings-collaboration.tsx`, ui-parity-3 `ca81d5a`; writes over landed services, upstream refusal order, `CanDoerManageOrgRepoCollaborator` port) | landed (`repo-collaborators.ts`) | authoring | — |
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

**E: 12 rows — 5 LANDED, 7 ABSENT.**

## F. Repo sub-systems (releases, wiki, activity, social, packages/projects/actions)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../releases` (+`/tag/*`, `/latest`, feeds) | web.go:1505-1514 | LANDED (`pages/releases.tsx`, wave 20) | landed | core | — |
| `GET .../releases/new`, `/edit/*` | web.go:1516-1520 | PARTIAL — `/new` LANDED (wave 20); `/edit/*` + `/delete` unclaimed | landed (`createRelease` landed) | authoring | S |
| `GET .../releases/download/{tag}/{file}`, `/releases/attachments/{uuid}` | web.go:1513-1514 | ABSENT | landed (`release-assets.ts`) | core | S |
| `GET .../fork` (fork form) | web.go:1490 | LANDED (`pages/repo-fork.tsx`, ui-parity-5; owner options over can-create orgs, `createFork` sequence replay; entry points on the forks page) | landed (`createFork` declared) | authoring | — |
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | ABSENT | landed (wiki 6 ops declared `d3362b1`, `services/wiki.ts` + the sibling engine cell — effort drops L→M) | authoring | M |
| `GET .../activity[/{period}]` | web.go:1628-1631 | ABSENT | partial (feed rows landed `2ef9359`; the stats aggregation stays private on the DO) | core | M |
| `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` | web.go:1633-1646 | ABSENT | partial (aggregation private on the DO) | admin | M |
| `GET .../activity_author_data` | web.go:1683-1687 | ABSENT (aux JSON) | partial | admin | S |
| `GET .../forks` | web.go:1759 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`listForks`) | core | — |
| `GET .../stars` | web.go:1766 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`stars.ts`, `social-lists.ts`) | core | — |
| `GET .../watchers` | web.go:1767 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`repo-watchers.ts`) | core | — |
| `GET .../packages` | web.go:1538-1542 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET .../projects[/...]` | web.go:1544-1563 | ABSENT | landed (projects store 0024 + all three API scopes declared: repo `fc123b0`, org `20512c0`, user `c9a7ef7` — 64 project ops) | authoring | M |
| `GET .../actions[/...]` | web.go:1566-1608 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |

**F: 14 rows — 5 LANDED, 1 PARTIAL, 8 ABSENT.**

## Totals

**113 rows: 48 LANDED, 4 PARTIAL, 61 ABSENT — zero IN-FLIGHT.**

By family (landed/partial/absent): A 10/0/14, B 6/1/9, C 9/2/14, D 13/0/9,
E 5/0/7, F 5/1/8. The landed set now covers every highest-traffic single
page (repo home, file view, commits log, commit detail, branches, tags,
issues/PRs lists + details + both PR side tabs, compare, releases browse +
create, labels, milestone detail/edit, the fork form, the social lists, the
collaboration panel, creation forms, org members/repositories, the avatar
seam). The remaining absence mass concentrates in (a) small page slices and
aux fragments over fully landed data (archive download, blob redirect, the
tags delete write, `load-branches-and-tags`, tree/commit fragments, the
releases edit/delete tail, the compare range + diff-patch shapes), (b)
settings tabs whose APIs just landed (deploy keys, protected tags, git
hooks, org hooks), (c) the owner `/-/` namespace tails whose APIs just
completed (the projects pages; heatmap/packages stay gated), and (d) whole
subsystems with no data model (actions, packages, audit logs) or no engine
RPC (blame, graph, code search, heatmap) that are correctly out of the
demand-driven phase's reach.

## Recommendation — top 5 by demand-per-effort

Every row below is dispatchable now: its API surface is fully declared
(`node scripts/check-openapi.mjs` PASS at HEAD `5d9122c` — greps shown per
row) or needs no API at all. The regen's top 5 all landed; this is the
re-ranked queue.

1. **`GET .../archive/{ref}.{format}`** (web.go:1689-1692, S, core) — the
   code/releases browsing staple and the largest remaining core slice over
   landed data. API dependency: **none** — `services/archive.ts` (landed)
   produces the tarball/zip; the slice is a parse arm + Response streaming.
2. **The tags row's write + aux tails**: `POST /tags/delete` +
   delete-tag controls + `GET .../tags/list` (web.go:1501, 1499, S,
   core/authoring) — the landed tags page (ui-parity-4) renders the list
   but carries no write; upstream's per-tag delete rides
   `reqRepoCodeWriter`. API dependency: `repoListTags`, `repoGetTag`,
   `repoCreateTag`, `repoDeleteTag` — all declared `[ok]`.
3. **`GET .../commit/{sha}/load-branches-and-tags`** (web.go:1740, S, core)
   — the aux JSON the upstream compare/new-release/editor surfaces consume;
   one handler over the landed ref reads. API dependency: **none** —
   `listRefs` (engine boundary) is the data.
4. **`GET .../releases/edit/*` + `POST /releases/delete`** (web.go:1516-1520,
   S, authoring) — the F family's one PARTIAL row's tail (`/new` landed in
   wave 20). API dependency: `repoEditRelease`, `repoDeleteRelease` (and
   the landed `createRelease`) — all declared `[ok]`;
   `pages/releases.tsx` extends.
5. **`GET /{username}/-/projects[/...]`** (web.go:1137-1163, M, authoring) —
   the biggest single remaining authoring surface, now unblocked: all three
   projects API scopes are declared (repo `fc123b0`, org REG `20512c0`,
   user REG `c9a7ef7` — 64 project ops, checker `[ok]`), the
   `projects` store is migration 0024, and `src/api/services/projects.ts`
   models every scope. The repo-scoped sibling (`.../projects`,
   web.go:1544-1563) rides the same slice.

Bench (next tier — dispatch when the pool needs dependency-ready goals; all
data-landed): `.../blob/*` redirect (web.go:1757, S, core — a 303 onto
`/src`), `.../releases/download/{tag}/{file}` +
`/releases/attachments/{uuid}` (web.go:1513-1514, S, core —
`release-assets.ts`), `/{org}/teams/{team}/edit` (web.go:1011, S,
authoring — `orgEditTeam` declared `[ok]`), `.../pulls/new/*` redirect
(web.go:1314, S), the aux fragments `.../blob_excerpt`, `.../branches/list`,
`.../tree-list|tree-view`, `.../lastcommit` (web.go:1735, 1695, 1297-1306,
1761, S, core — `listTree`/`readCommit`), `.../render/*` (web.go:1715, S),
`.../issues/search` + `.../issues/suggestions` aux (web.go:1359, 1341, S),
`.../compare/*.{diff|patch}` + the files range shape (web.go:1309-1310,
1672, S — `diffpatch.ts` + landed compare), `GET /attachments/{uuid}`
(web.go:912, S — the issue-attachment API landed), `.../issues/new/choose`
(web.go:1357, S, partial data), `/repo/search` + `/explore/topics/search`
aux (web.go:1102, 564, S — `repoSearch` declared). M-tier page work over
just-landed APIs, in demand order: the **wiki family** (web.go:1611-1625 —
`repoGetWikiPages`/`repoGetWikiPage`/`repoCreateWikiPage`/
`repoEditWikiPage`/`repoDeleteWikiPage`/`repoGetWikiPageRevisions`, all
declared `[ok]`), the **repo projects pages** (web.go:1544-1563 — rides
top-5 #5's store), **settings/keys** (deploy keys), **settings/tags**
(protected tags), **settings/hooks/git** (git hooks, S), the **org
settings** group (org hooks ops landed), `/{username}.rss/.atom` (feeds
declared), the global `/issues|/pulls|/milestones` inboxes (data partial —
the cross-repo perm filter), the `/user/settings` tab group,
`.../_upload/*` + `.../_diffpatch|_cherrypick` (web.go:1462-1470 — the
machinery is landed), `/repo/migrate` (`services/migrate.ts`).
`/explore/organizations` (web.go:557) needs the missing visible-org search
arm first — data partial, M.
GATED rows (do not dispatch without the feature SPEC): everything
actions/packages (`/-/admin` actions+packages tabs, `settings/actions`,
`.../actions*`, `.../packages`, `/{username}/-/packages` — FEATURE-ABSENT
APIs per the twin inventory's 64 remaining ops), plus the no-RPC pages
(blame, graph, in-repo/explore/`/-/` code search, heatmap, audit_logs). The
`.../raw` + `.../media` web shapes (web.go:1699-1713) stay
PARTIAL-by-divergence — our SSR pages emit tier-1 API raw links
(`links.ts:41`), so the gap only bites official-bundle references and pasted
URLs; close it opportunistically, not as a dedicated goal.
