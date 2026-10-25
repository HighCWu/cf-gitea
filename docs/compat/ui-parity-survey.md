# UI Parity Survey — the demand-driven gap inventory

What the vendored upstream serves (page-bearing GETs) at our pin vs what
`uiRouter` claims today. This is the demand-driven phase's input: every gap is
tagged with its demand signal and an effort guess so dispatch can be ranked by
demand-per-effort instead of by route-table order.

- **Pin**: `fc4936884584` (v1.22.0-rc1-3919). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the parser families and landed pages documented in the
  `apps/worker/src/ui/index.ts` header inventory (`src/ui/index.ts:6-235`),
  the pages under `apps/worker/src/ui/pages/`, and the session router
  (`src/ui/session.ts:731-735`).
- **Data prerequisites** are read from what is actually landed TODAY:
  engine boundary reads (`packages/git-engine/dist-types/repo.d.ts:309-320`:
  `listRefs`, `readCommit`, `listLog`, `listTree`, `readDiff`, `readBlob` —
  blame/snapshot/graph are PRIVATE pages on the DO, not boundary RPCs), the
  merge machinery (`repo.d.ts:208-244`), and the landed services under
  `apps/worker/src/api/services/`.
- POST actions are out of scope except where a landed page's write already
  rides the same URL; upstream's aux surfaces (`/devtest/*` — web.go:1799-1817,
  `/-/ws` — web.go:615, `/api/swagger` — web.go:305, robots/captcha/metrics,
  go-get, the git-protocol and LFS families) are likewise out of scope.

## Legend

**Status**
- **LANDED** — our router claims the family and renders the page (divergences noted).
- **PARTIAL** — claimed but incomplete, or served at a divergent shape noted here.
- **ABSENT** — upstream serves a page; we 404 (engine-owned) it.

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

## A. Site-level and auth

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /` (dashboard / landing) | web.go:529 | LANDED (`pages/dashboard.tsx`) | landed | core | — |
| `GET /explore` (redirect) | web.go:550-552 | LANDED | landed | core | — |
| `GET /explore/repos` | web.go:553 | LANDED (`pages/explore.tsx`) | landed | core | — |
| `GET /explore/users` | web.go:555 | LANDED | landed | core | — |
| `GET /explore/organizations` | web.go:557 | ABSENT | landed (org search) | core | S |
| `GET /explore/code` | web.go:558-563 | ABSENT | none (no grep RPC) | authoring | L |
| `GET /explore/topics/search` | web.go:564 | ABSENT (aux JSON) | landed (topics) | admin | S |
| `GET /sitemap.xml` + explore sitemaps | web.go:530,554,556 | ABSENT | landed | admin | M |
| `GET /issues` (global inbox) | web.go:568 | ABSENT | partial (cross-repo perm filter missing) | authoring | M |
| `GET /pulls` (global) | web.go:572 | ABSENT | partial | authoring | M |
| `GET /milestones` (global) | web.go:573 | ABSENT | partial | authoring | M |
| `GET /user/login` | web.go:577 | LANDED as `/login` (SPEC-0010 divergence) | landed | core | — |
| `GET /user/sign_up` | web.go:595 | ABSENT | partial (no self-serve registration service verified) | core | M |
| `GET /user/settings` (profile) | web.go:634 | LANDED (`pages/user-settings.tsx`) | landed | authoring | — |
| `/user/settings/{account,appearance,security,applications,keys,organization,repos}` | web.go:641-735 | ABSENT (keys data landed via `account-keys.ts`) | partial | authoring | M each |
| `GET /notifications` + `/new` + `/status` + `/purge` | web.go:1785,1788-1789,1791 | LANDED (`pages/notifications.tsx`) | landed | authoring | — |
| `/notifications/subscriptions`, `/watching`, `/purge-page` | web.go:1786-1787,1790 | ABSENT | partial | authoring | M |
| `/-/admin/*` (dashboard, users, repos, orgs, config, monitor, notices, auths, emails, badges, packages, hooks, applications, actions) | web.go:780-906 | ABSENT (whole family) | partial (user/repo lists exist) | admin | L |
| `GET /org/create` | web.go:972 | ABSENT | landed (`POST /orgs`) | authoring | S |
| `GET /repo/create` | web.go:1098 | ABSENT | landed (`POST /user/repos`) | authoring | S |
| `GET /repo/migrate` | web.go:1100 | ABSENT | landed (`services/migrate.ts`) | authoring | M |
| `GET /repo/search` | web.go:1102 | ABSENT (aux JSON feed) | landed | authoring | S |
| `GET /attachments/{uuid}` | web.go:912 | ABSENT | partial (issue-attachments API landed) | authoring | S |
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | ABSENT | none (no avatar storage) | core | S |

**A: 24 rows — 7 LANDED, 17 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | ABSENT | partial | admin | M |
| `GET /{username}/-/repositories` (org repo list) | web.go:1134 | ABSENT | landed (`org-repos.ts`) | core | S |
| `GET /{username}/-/heatmap` | web.go:1135 | ABSENT | none | admin | M |
| `GET /{username}/-/packages[/...]` | web.go:1108-1128 | ABSENT | none (no packages system) | admin | L |
| `GET /{username}/-/projects[/...]` | web.go:1137-1163 | ABSENT | none (no projects model) | authoring | L |
| `GET /{username}/-/code` (global code search) | web.go:1166 | ABSENT | none (no grep RPC) | authoring | L |
| `GET /org/{org}/members` | web.go:965 | ABSENT | landed (`orgs.ts` members API, api/routes/orgs.ts:250) | core | S |
| `GET /org/{org}/dashboard[/{team}]` (+heatmap) | web.go:982-985 | ABSENT | partial | authoring | M |
| `GET /org/{org}/issues|pulls|milestones[/{team}]` | web.go:986-991 | ABSENT | partial | authoring | M |
| `GET /{org}/teams` | web.go:993 | LANDED (`pages/org-teams.tsx`, owner gate) | landed | authoring | — |
| `GET /{org}/teams/{team}` (+`/repositories` web.go:998) | web.go:997-998 | PARTIAL — landed id-keyed detail (upstream links by team NAME); repositories list merged into the detail slice | landed | authoring | — |
| `GET /{org}/teams/new` | web.go:1009 | LANDED | landed | authoring | — |
| `GET /{org}/teams/{team}/edit` | web.go:1011 | ABSENT | partial | authoring | S |
| `GET /{org}/settings` (+hooks, packages, blocked_users, applications) | web.go:1017-1092 | ABSENT (whole group except labels below) | partial | authoring | M per tab |
| `GET /org/{org}/settings/labels` | web.go:1043-1049 | LANDED at `/{org}/labels` (documented divergence; the three POST segments ride upstream's literals) | landed | authoring | — |

**B: 16 rows — 5 LANDED, 1 PARTIAL, 10 ABSENT.**

## C. Repo code browsing

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{owner}/{repo}` (repo home) | web.go:1292 | LANDED (`pages/home.tsx`) | landed | core | — |
| `GET .../src/{branch|tag|commit}[/*]` | web.go:1749-1755 | LANDED (`pages/file-view.tsx`) | landed | core | — |
| `GET .../tree/*` (redirect to /src) | web.go:1756 | LANDED (`pages/repo-home.tsx`) | landed | core | — |
| `GET .../blob/*` (redirect to /src/commit) | web.go:1757 | ABSENT (redirect only) | landed | core | S |
| `GET .../commits/{branch|tag|commit}[/*]` | web.go:1722-1727 | LANDED (`pages/commits.tsx`) | landed | core | — |
| `GET .../commit/{sha}` (commit detail + diff) | web.go:1739 | ABSENT | landed (`readCommit` + `readDiff`, repo.d.ts:311,319) | **core** | **M** |
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
| `GET .../branches` (list page) | web.go:1696 | ABSENT | landed (`listRefs`, branches API) | **core** | **S** |
| `GET .../branches/list` | web.go:1695 | ABSENT (aux JSON) | landed | core | S |
| `GET .../tags` (list page) | web.go:1496 | ABSENT | landed (`listRefs`, tags API) | **core** | **S** |
| `GET .../tags/list` | web.go:1499 | ABSENT (aux JSON) | landed | core | S |
| `GET .../lastcommit/*` | web.go:1761 | ABSENT (aux fragment) | landed | core | S |
| `GET .../search` (in-repo code search) | web.go:1768 | ABSENT | none (no grep RPC) | authoring | L |
| `GET .../{_edit|_new|_delete}/*` (editor combos) | web.go:1453-1461 | LANDED at `/{new|edit|delete}/*` (documented divergence at the brief's literal names, `pages/file-editor.tsx`) | landed | authoring | — |
| `GET .../_upload/*` | web.go:1462-1464 | ABSENT | partial | authoring | M |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | ABSENT | landed (diffpatch + merge machinery) | authoring | M |

**C: 25 rows — 5 LANDED, 2 PARTIAL, 18 ABSENT.**

## D. Issues and pulls

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../issues` | web.go:1347 | LANDED (`pages/issues-list.tsx`) | landed | core | — |
| `GET .../pulls` | web.go:1654 | LANDED (same component) | landed | core | — |
| `GET .../issues/{index}` | web.go:1348 | LANDED (`pages/issue-detail.tsx`) | landed | core | — |
| `GET .../pulls/{index}` | web.go:1656 | LANDED (same component; family-mismatch 303 parity) | landed | core | — |
| `GET .../pulls/{index}.{diff|patch}` | web.go:1657-1658 | ABSENT | landed (`diffpatch.ts`) | authoring | S |
| `GET .../pulls/{index}/merge_box` | web.go:1659 | ABSENT (fragment) | partial | authoring | S |
| `GET .../pulls/{index}/commits` | web.go:1661-1663 | ABSENT | landed (`listCommitsRange`, repo.d.ts:217) | **authoring** | **S** |
| `GET .../pulls/{index}/files` | web.go:1671 | LANDED (`pages/pull-files.tsx`) | landed | authoring | — |
| `GET .../pulls/{index}/files/{a}..{b}` (range) | web.go:1672 | ABSENT | landed | authoring | S |
| `GET .../compare[/{base}...{head}]` | web.go:1307-1313 | LANDED (`pages/compare.tsx`; `..` two-dot and fork forms unclaimed — documented divergences) | landed | authoring | — |
| `GET .../compare/*.{diff|patch}` | web.go:1309-1310 | ABSENT | landed | authoring | S |
| `GET .../pulls/new/*` (redirect) | web.go:1314 | ABSENT | landed | authoring | S |
| `GET .../issues/new` | web.go:1355 | LANDED (`pages/new-issue.tsx`) | landed | authoring | — |
| `GET .../issues/new/choose` (template chooser) | web.go:1357 | ABSENT | partial | authoring | S |
| `GET .../labels` (list page) | web.go:1338 | ABSENT | landed (labels API, api/routes/labels.ts:77) | authoring | S |
| `GET .../milestones` | web.go:1339 | LANDED (`pages/milestones.tsx`) | landed | authoring | — |
| `GET .../milestone/{id}` (detail: issues+pulls) | web.go:1340 | ABSENT | landed | authoring | S |
| `GET .../milestones/{id}/edit` | web.go:1427 | ABSENT | landed | authoring | S |
| `GET .../issues/search` | web.go:1359 | ABSENT (aux JSON) | landed | authoring | S |
| `GET .../{type}/{index}/info|attachments|content-history/*` | web.go:1321-1330 | ABSENT (fragments) | partial | authoring | M |
| `GET .../comments/{id}/attachments` | web.go:1337 | ABSENT (aux) | partial | authoring | S |
| `GET .../issues/suggestions` | web.go:1341 | ABSENT (aux) | landed | authoring | S |

**D: 22 rows — 7 LANDED, 15 ABSENT.**

## E. Repo settings

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../settings` (basics) | web.go:1185 | LANDED (`pages/settings.tsx`, admin viewer only) | landed | authoring | — |
| `GET .../settings/collaboration` | web.go:1194 | ABSENT | landed (`repo-collaborators.ts`) | authoring | S |
| `GET .../settings/branches` (+`/edit`, `/priority`, `/{id}/delete`) | web.go:1207-1213 | LANDED (`pages/branch-protection.tsx`) | landed | authoring | — |
| `GET .../settings/tags` (protected tags) | web.go:1215-1221 | ABSENT | partial (no protected-tag model verified) | authoring | M |
| `GET .../settings/hooks/git` | web.go:1223-1227 | ABSENT | none (git hooks are repo files) | admin | S |
| `GET .../settings/hooks` + `/{id}` + `/{type}/new` | web.go:1229-1239 | LANDED (list, generic add form, per-hook page + test/delete; upstream's per-provider `{type}/new` forms ride our generic form — divergence) | landed | authoring | — |
| `GET .../settings/keys` (deploy keys) | web.go:1241-1247 | ABSENT | partial (user SSH keys landed; deploy-key model unverified) | authoring | M |
| `GET .../settings/lfs[/...]` (files, pointers, locks) | web.go:1249-1261 | ABSENT | partial (LFS server landed; pointer-scan queries missing) | authoring | M |
| `GET .../settings/actions*` | web.go:1262-1278 | ABSENT | none (no Actions) | admin | L |
| `GET .../settings/audit_logs` | web.go:1279 | ABSENT | none | admin | L |
| `GET .../settings/mirror` | (upstream renders inside options.tmpl — divergence noted) | LANDED at the literal (`pages/settings.tsx`) | landed | authoring | — |
| `GET .../settings/public_access` | web.go:1191 | ABSENT | partial | authoring | S |

**E: 12 rows — 4 LANDED, 8 ABSENT.**

## F. Repo sub-systems (releases, wiki, activity, social, packages/projects/actions)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../releases` (+`/tag/*`, `/latest`, feeds) | web.go:1505-1514 | ABSENT | landed (`releases.ts`, `release-assets.ts`) | **core** | **M** |
| `GET .../releases/new`, `/edit/*` | web.go:1516-1520 | ABSENT | landed (`createRelease` landed) | authoring | M |
| `GET .../releases/download/{tag}/{file}`, `/releases/attachments/{uuid}` | web.go:1513-1514 | ABSENT | landed | core | S |
| `GET .../fork` (fork form) | web.go:1490 | ABSENT | landed (`createFork`, `forks.ts`) | authoring | S |
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | ABSENT | none (no wiki storage) | authoring | L |
| `GET .../activity[/{period}]` | web.go:1628-1631 | ABSENT | partial | core | M |
| `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` | web.go:1633-1646 | ABSENT | partial (aggregation private on the DO) | admin | M |
| `GET .../activity_author_data` | web.go:1683-1687 | ABSENT (aux JSON) | partial | admin | S |
| `GET .../forks` | web.go:1759 | ABSENT | landed (`listForks`) | core | S |
| `GET .../stars` | web.go:1766 | ABSENT | landed (`stars.ts`, `social-lists.ts`) | core | S |
| `GET .../watchers` | web.go:1767 | ABSENT | landed (`repo-watchers.ts`) | core | S |
| `GET .../packages` | web.go:1538-1542 | ABSENT | none (no packages system) | admin | L |
| `GET .../projects[/...]` | web.go:1544-1563 | ABSENT | none (no projects model) | authoring | L |
| `GET .../actions[/...]` | web.go:1566-1608 | ABSENT | none (no Actions) | admin | L |

**F: 14 rows — 14 ABSENT.**

## Totals

**113 rows: 28 LANDED, 3 PARTIAL, 82 ABSENT.**

By family: A 7/17, B 5/1/10, C 5/2/18, D 7/15, E 4/8, F 0/14 (landed/absent;
partial in the middle where present). The landed set already covers the
highest-traffic single pages (repo home, file view, commits log, issues/PRs
lists + details, dashboard, explore, notifications, the main authoring writes);
the absence mass concentrates in (a) the browsing dead-ends one click off
landed pages (commit detail, branches, tags, releases), (b) creation forms,
and (c) whole subsystems (actions, packages, projects, wiki, admin) that have
no data model and are correctly out of the demand-driven phase's reach.

## Recommendation — top 5 by demand-per-effort

1. **`GET .../commit/{sha}`** (web.go:1739, M, core) — the commits log and the
   PR files view both dead-end without it; it is the single largest core-browsing
   hole that sits entirely on landed reads (`readCommit` + `readDiff` —
   `readDiff`'s default-second-parent semantic IS the commit diff, repo.d.ts:318),
   and `pages/pull-files.tsx` already owns a diff renderer to reuse.
2. **`GET /repo/create` + `GET /org/create`** (web.go:1098, 972, S, authoring) —
   the product's front door: sessions landed, so signed-in users exist who can
   only create repos/orgs through the raw API. Both POST services are landed
   (`POST /user/repos`, `POST /orgs`); this is one form slice.
3. **`GET .../branches` + `GET .../tags`** (web.go:1696, 1496, S, core) — the
   two standard repo tabs, both one `listRefs` read away; the repo home's
   branch switcher and the settings/branches page already reference the
   concepts. Parser + list pages + tests, nothing else.
4. **`GET .../releases` family** (web.go:1505-1526, M, core + authoring) —
   release browsing is table stakes for any repo users actually consume, and
   the whole data side is landed (list/find/create/assets), so the family is
   page work only. The navbar's Releases tab currently 404s.
5. **`GET .../pulls/{index}/commits`** (web.go:1661, S, authoring) — the review
   workflow's middle tab; `listCommitsRange` (repo.d.ts:217) is landed for
   exactly this shape and the commits page component is reusable.

Bench (next tier, all S, all data-landed — dispatch when the pool needs
dependency-ready goals): `/{username}/-/repositories` (web.go:1134),
`/org/{org}/members` (web.go:965), `.../forks|stars|watchers` trio
(web.go:1759, 1766, 1767), `.../settings/collaboration` (web.go:1194),
`/explore/organizations` (web.go:557). The `.../raw` + `.../media` web shapes
(web.go:1699-1713) stay PARTIAL-by-divergence — our SSR pages emit tier-1 API
raw links (`links.ts:41`), so the gap only bites official-bundle references and
pasted URLs; close it opportunistically, not as a dedicated goal.
