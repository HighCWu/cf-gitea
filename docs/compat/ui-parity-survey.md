# UI Parity Survey — the demand-driven gap inventory

What the vendored upstream serves (page-bearing GETs) at our pin vs what
`uiRouter` claims today. This is the demand-driven phase's input: every gap is
tagged with its demand signal and an effort guess so dispatch can be ranked by
demand-per-effort instead of by route-table order. Companion to
`api-remaining-inventory.md` (the API-side twin). **Fully regenerated
2026-10-26** at HEAD `99d21c5` after the previous edition (written at
landed=28/partial=3/absent=82) drove waves 16-20 + ui-parity-2 to completion
and ui-parity-3 into flight — every row it recommended has since landed.
**Ticked 2026-10-26** at HEAD `7016ce9`: a maintenance pass, not a regen —
the second today (the previous one, at `5d9122c`, recorded the regen's
four in-flight rows plus eight ABSENT rows landing for 48/4/61). That
tick's entire top-5 has now resolved: wave-ui-parity-6 (`1b41b60`) landed
the archive download + `load-branches-and-tags`, wave-ui-parity-7
(`48101dc`) landed the tags delete write + `/tags/list` aux + the
releases edit/delete tail — the F family's one PARTIAL row flips LANDED —
and the fifth, `/{username}/-/projects`, went IN-FLIGHT (a sibling wave
owns it; excluded from the totals). Headline **52/3/57 + 1 in-flight**;
the dispatchable rows are re-ranked below.
**Ticked 2026-10-26** a third time, at HEAD `45bea22`: the in-flight fifth
resolved — wave-ui-parity-8 (`45bea22`) landed `/{username}/-/projects`'s
LIST surface (upstream's group is a project INDEX, not a board: the page
renders no dead write controls and pins the follower-404 gate divergence).
The row flips LANDED and its board-view + write-group remainder is split
off as a fresh ABSENT follow-up row (web.go:1140-1155), for headline
**53/3/58** (114 rows) with zero rows in flight; the dispatchable rows are
re-ranked below.
**Ticked 2026-10-26** a fourth time, at HEAD `9b49cd2`: wave-ui-parity-9
(`1a7af64`) resolved the old top-5's #1 (the `/blob/*` redirect) and two
of #5's rows (`tree-list`, `branches/list`) — those flip LANDED, except
that the `tree-list`/`tree-view` row flips PARTIAL, not LANDED: its other
half was skipped with a recorded re-dispatch gate. The three SKIPPED
fragments carry their gates (skipped, not faked): `/tree-view/*` is
blocked on the fileicon-asset pass (the ViewFileTreeStore JSON carries
the material-icon theme pool — `material-icon-rules.json` +
`material-icon-svgs.json` + the enry classifier, `gitea/modules/fileicon/`;
that sibling wave's assets were UNTRACKED in the tree at this
measurement — the gate is mid-clear), `/blob_excerpt/{sha}` on
the hunk machinery (the `BuildBlobExcerptDiffSection` expansion + PR code
comments), `/lastcommit/*` on the template port (`tplRepoViewList` over
per-entry GetCommitsInfo). And the `/-/projects` board + write-group
follow-up row — IN-FLIGHT when this tick was dispatched — **landed
mid-tick** as `9b49cd2` (the full owner-board surface: board view,
write forms, workflow tails; its RESUME audit restored the
`repo === "-"` guard so the repo-scoped `/projects` shapes stay
unclaimed) and flips LANDED. Headline **56/4/54** (114 rows, zero in
flight); the dispatchable rows are re-ranked below.
**Ticked 2026-10-26** a fifth time, at HEAD `2310623`: the third tick's
entire top-3 resolved in one window — the attachments serving seam
(`5e082cd` + wiring `2b5b898`) landed the site-level
`/attachments/{uuid}` row (the `src/web/` seam mounted before
`uiRouter`), and wave-ui-parity-10 (`fdaeaca`) landed BOTH of the other
two: the releases download tail (`releases/download/{tag}/{file}` +
the repo-scoped `/releases/attachments/{uuid}` — ServeAttachment +
RedirectDownload incl. the `latest` alias) and the `/render/*` family
(markdown through the landed pipeline; upstream's default config 400s
this family, the divergence ledgered in the row; the degenerate
`blob/{sha}` arm verbatim), plus the fetch-action 200-JSON arm on BOTH
redirect twins — closing that divergence on the already-landed
`/blob/*` + `/tree/*` rows. The `tree-list`/`tree-view` fragments row
flips IN-FLIGHT: a sibling wave owns the `tree-view` half now, and its
SKIP-gate is CLEARED — `cdf683a` landed the fileicon asset+lookup layer
(premise corrected: the pinned fileicon has NO enry dep — pure
rules-JSON + rightmost-dot-first extension walk), so the gate note
below updates from mid-clear to cleared and the row is handed over, not
re-gated. The `9b49cd2` board row was verified already flipped LANDED
by the fourth tick — no double-count. Headline **59/3/51 + 1
in-flight** (113 counted of 114 rows); the remainder is re-ranked below
— it is now nearly all gated/limited rows plus the repo-scoped projects
follow-ups.
**Ticked 2026-10-26** a sixth time, at HEAD `58c6cf0`: the in-flight
tree-view half resolved — the tree-view envelope landed (`831709f`), so
the C-family directory-expansion fragments row flips LANDED **fully**
(both halves: `tree-list` since `1a7af64`, `tree-view` now). The
ws1009 posture extends to the new page: the fileicon module rides the
page's import edge **DYNAMICALLY** (a lazy `import("../fileicon/fileicon")`
boundary), keeping the ~12MB asset graph out of the startup snapshot —
a static re-import re-kills the a11y worker, stash A/B proven; noted in
the row's data note so no later wave "simplifies" it back to static.
And the repo-scoped projects row (F family, web.go:1544-1563 — the
previous tick's re-ranked #1) flips IN-FLIGHT: a sibling wave owns it
now (excluded from the totals, do not re-dispatch). Headline **60/3/50
+ 1 in-flight** (113 counted of 114 rows); the remainder is re-ranked
below — post this tick it is only gated/limited rows plus whatever the
repo-projects wave opens.
**Ticked 2026-10-26** a seventh time, at HEAD `ae32b1a`: the in-flight
repo-scoped projects row resolved — `ae32b1a` landed it fully (list +
board + writes + workflows over the 64-op store), so the F family row
flips LANDED. The row's data note now carries the two things the
landing wave recorded: the `has_projects` unit toggle (MODELED — no
divergence) and the **Hono constraint convention** (`:repo{[^-].*}` —
a static second segment does NOT outrank a param in Hono, so the
owner-scoped `/-/projects` shapes and the repo-scoped `/projects`
shapes coexist only with the negative-charset constraint; discovered
and applied by the landing wave, recorded so later route work reuses
it instead of rediscovering it). And the two remaining fragment-gated
aux rows — `GET .../blob_excerpt/{sha}` and `GET .../lastcommit/*` —
flip IN-FLIGHT: their gates' machinery landed in this same window
(`0db7087` the FULL `BuildBlobExcerptDiffSection` port — the hunk
gate's prerequisite — and `3502ee4` the batched per-path commit-info
loader + the `view_list.tmpl` DOM — the template port's prerequisite),
and a sibling wave mounts the routes now (IN-FLIGHT by dispatch
ownership: the tree was CLEAN at this measurement — both machinery
commits are service/page modules only, and committed HEAD's
`index.ts` carries only the documented-skip handoff comment at line
4662, no mounted route). Headline **61/3/48 + 2 in-flight** (112
counted of 114 rows); the remainder is re-ranked below — with the
last no-gate row landed, every dispatchable row left serializes on
the shared `index.ts` (the structural endpoint, stated plainly in
the Recommendation).

- **Pin**: `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919;
  verified `git -C gitea rev-parse HEAD`). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the route table + parser families in
  `apps/worker/src/ui/index.ts` at HEAD `ae32b1a` — the header inventory
  (the route-family comment block) and the `ParsedUiRoute` union
  (line 1745) are the exhaustive family list (a family exists iff a parse
  branch returns it); the pages under `apps/worker/src/ui/pages/` (54
  files committed: 51 page modules + 3 test modules) and the session
  router (`src/ui/session.ts`) carry the renders, with the `src/web/`
  seam routers (avatar serving, attachments serving) mounted in
  `src/index.ts`. The WORKING TREE at measurement time is CLEAN — the
  repo-projects row's owner committed as `ae32b1a`, and the
  blob_excerpt/lastcommit sibling (the new IN-FLIGHT rows' owner) mounts
  routes in a window after this measurement, so those rows are
  IN-FLIGHT by dispatch ownership, not by tree state; every count below
  reads committed HEAD (`git show` / `git ls-tree HEAD`).
- **Reproducing the counts** (exactly these walks):
  1. Upstream: walk the page-bearing GETs out of `gitea/routers/web/web.go`
     (`m.Get`/`m.Combo(...).Get` registrations, grouped into the same 6
     families as the original survey — its 113 rows, +1 from the
     `45bea22` tick's LIST/board split of the `/-/projects` row; aux
     surfaces excluded per the preamble) — the row set is pin-stable
     apart from that split.
  2. Ours (committed HEAD only): `git show HEAD:apps/worker/src/ui/index.ts | grep
     -c "family:"` (the parse branches — 169 at this tick) +
     `git ls-tree HEAD --name-only apps/worker/src/ui/pages/ | wc -l`
     (the renders — 54 files) at `ae32b1a`; `git status --short --
     apps/worker/src/ui/` must be EMPTY at this tick (the repo-projects
     row committed as `ae32b1a`; the blob_excerpt/lastcommit sibling had
     nothing uncommitted at measurement — see Our side) — anything
     else means HEAD is not the right base.
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
| A site-level + auth | 24 | 11 | 0 | 13 | 0 |
| B owner pages | 17 | 8 | 1 | 8 | 0 |
| C repo code browsing | 25 | 16 | 2 | 5 | 2 |
| D issues + pulls | 22 | 13 | 0 | 9 | 0 |
| E repo settings | 12 | 5 | 0 | 7 | 0 |
| F repo sub-systems | 14 | 8 | 0 | 6 | 0 |
| **total** | **114** | **61** | **3** | **48** | **2** |

(The regen's headline was 36/4/69 + 4 in-flight; the `5d9122c` tick took
it to 48/4/61 + 0. The `7016ce9` tick: wave-ui-parity-6 lands 2 ABSENT rows
(archive, `load-branches-and-tags` — `1b41b60`), wave-ui-parity-7 lands 1
ABSENT row (`/tags/list`) and flips the F family's PARTIAL row
(`48101dc`), and `/{username}/-/projects` goes IN-FLIGHT — for
52/3/57 + 1. The `45bea22` tick: wave-ui-parity-8 flips that row
LANDED (the LIST surface) and splits its board+write remainder off as a
new ABSENT row — for 53/3/58 + 0. The `9b49cd2` tick: wave-ui-parity-9
(`1a7af64`)
lands the `/blob/*` redirect + the `branches/list` row + the tree-list
half of the fragments row (its tree-view half gated — PARTIAL, see the
row), and the board+write row lands as `9b49cd2` mid-tick — for
56/4/54 + 0. The `2310623` tick: the attachments seam (`5e082cd` +
`2b5b898`)
lands the A row, wave-ui-parity-10 (`fdaeaca`) lands the releases-
download (F) and render (C) rows, and the fragments row flips
IN-FLIGHT with the tree-view sibling — for 59/3/51 + 1. This tick:
the tree-view envelope (`831709f`) flips the fragments row fully
LANDED, and the repo-scoped projects row flips IN-FLIGHT with its
sibling wave — for 60/3/50 + 1. The `ae32b1a` tick: the repo-scoped
projects row lands (`ae32b1a` — F +1 LANDED, −1 IN-FLIGHT) and the two
fragment rows (`blob_excerpt`, `lastcommit`) flip IN-FLIGHT with their
route-mounting sibling (C −2 ABSENT, +2 IN-FLIGHT, the machinery gates
cleared by `0db7087`/`3502ee4`) — for 61/3/48 + 2.)

## In-flight (excluded from the totals — do not re-dispatch)

The two fragment rows (both C family) — `GET .../blob_excerpt/{sha}`
(web.go:1735) and `GET .../lastcommit/*` (web.go:1761): their gates'
machinery is LANDED — `0db7087` ported the full
`BuildBlobExcerptDiffSection` hunk expansion (+ the GetExpandDirection
truth-table, FillHiddenCommentIDs, hashFilePathForWebUI) into
`api/services/blob-excerpt.ts`, and `3502ee4` built the batched
per-path commit-info loader + the `view_list.tmpl` DOM into
`pages/repo-lastcommit-fragment.tsx` — and a sibling wave mounts the
routes now. Nothing of that mounting is uncommitted in the tree at
this measurement (committed HEAD's `index.ts` carries only the
documented-skip handoff comment, no route): the rows are IN-FLIGHT by
dispatch ownership — excluded from the totals, do not re-dispatch the
route mounting; the rows flip LANDED when the sibling commits.

The previous tick's in-flight row — the repo-scoped projects row
(web.go:1544-1563, F family) — resolved as `ae32b1a` (list + board +
writes + workflows over the 64-op store; the row is counted LANDED,
F family, carrying the `has_projects` toggle note and the Hono
`:repo{[^-].*}` constraint convention in its data note). Before it,
the `tree-list`/`tree-view` fragments row resolved as `831709f` (the
tree-view envelope; counted LANDED, C family). The regen's in-flight
rows — the social trio (`.../forks`, `.../stars`, `.../watchers`) and
the collaboration panel — landed in `ca81d5a`, and every UI wave since
(`bb67087`, `0b61554`, `ca4eb58`, `79ef809`, `1b41b60`, `48101dc`,
`45bea22`, `1a7af64`, `9b49cd2`, `cdf683a`, `fdaeaca`, `831709f`,
`ae32b1a`) committed clean.

## Landed since last regen

The regen's entire recommendation tier landed, the `5d9122c` tick's window
added five more UI commits, and the ticks' windows added five waves plus
the seam+parity-10 window and this tick's tree-view envelope. The
deltas below sum 36+4-in-flight → 48 LANDED → 56 LANDED → 59 LANDED →
60 LANDED + 1 in-flight → 61 LANDED + 2 in-flight:

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
| wave-ui-parity-6 — the old top-5's #1 + #3 | `GET .../archive/{ref}.{format}` (web.go:1689-1692), `GET .../commit/{sha}/load-branches-and-tags` (web.go:1740) | `1b41b60` |
| wave-ui-parity-7 — the old top-5's #2 + #4 | `POST .../tags/delete` (web.go:1501) + the per-row delete control, `GET .../tags/list` (web.go:1499), `GET .../releases/edit/*` + `POST .../releases/delete` (web.go:1516-1520) | `48101dc` |
| wave-ui-parity-8 — the old top-5's #5 (LIST surface) | `GET /{username}/-/projects` (web.go:1139 — the index; the board+write remainder splits to a new ABSENT row) | `45bea22` |
| wave-ui-parity-9 — the old top-5's #1 + two of #5's rows | `GET .../blob/*` (web.go:1757 — 303 redirect onto `/src/commit`, raw tail+query verbatim), `GET .../tree-list/*` (web.go:1297-1306 — the find-file feed; the row's tree-view half skipped, gated), `GET .../branches/list` (web.go:1695) | `1a7af64` |
| the projects board + write group (landed mid-tick) | `GET /{username}/-/projects/{id}` board view + `/new` + `/{id}/edit` + the workflow tails (web.go:1140-1155 — the full row; the `repo === "-"` guard restored, repo-scoped shapes unclaimed) | `9b49cd2` |
| the attachments serving seam + dispatch wiring | `GET /attachments/{uuid}` (web.go:912 — the site-level seam: `src/web/attachments-serving.ts`, the full ServeAttachment walk (issue/PR/release linkage, draft arm, scope-check-after-404s, read:issue vs read:repository), Go sniff table + FormatMediaType + httpcache 304s, streaming; mounted before `uiRouter` with the `isAttachmentServing` carve-out) | `5e082cd` + `2b5b898` |
| wave-ui-parity-10 — the releases download tail | `GET .../releases/download/{tag}/{file}` + `GET .../releases/attachments/{uuid}` (web.go:1513-1514 — ServeAttachment + RedirectDownload incl. the `latest` alias; sniff/draft/ETag-304/download-count ports) | `fdaeaca` |
| wave-ui-parity-10 — the render family + the fetch-action arms | `GET .../render/{branch|tag|commit|blob}/*` (web.go:1715-1720 — markdown through the landed pipeline as the standalone sandboxed page, the default-config 400 divergence ledgered, the degenerate blob arm verbatim) + the fetch-action 200 `{"redirect": …}` arm on BOTH redirect twins (the `/blob/*` + `/tree/*` divergence closed) | `fdaeaca` |
| the tree-view envelope (the fragments row's final half) | `GET .../tree-view/*` (web.go:1302-1306 — the Go-faithful JSON assembler: field-by-field cites, the `goJsonString` port (JSON.stringify cannot emit Go's escapes), sorted-map key order, empty-never-null; submodule + symlink arms; the path half load-bearing with the `sub_path` chain) | `831709f` |
| the repo-scoped projects row (the LAST no-gate survey row) | `GET .../projects[/...]` (web.go:1544-1563 — the full repo-scoped surface: list + board + `/new` + `/{id}/edit` + the workflow tails over the 64-op store; the `has_projects` unit toggle MODELED — no divergence; the Hono `:repo{[^-].*}` constraint convention — static second segments do NOT outrank params) | `ae32b1a` |

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
| `GET /attachments/{uuid}` | web.go:912 | LANDED (`src/web/attachments-serving.ts` mounted in `src/index.ts` before `uiRouter` with the `isAttachmentServing` carve-out — `5e082cd` + `2b5b898`; the full ServeAttachment walk: issue/PR/release linkage, draft arm, scope-check-after-404s, read:issue vs read:repository; Go sniff table + FormatMediaType + httpcache 304s; streaming. Premise corrected vs this row's old text: upstream defaults INLINE for all — the download arm is dead at frozen settings, the CSP sandbox + forced text/plain is the real mechanism. Credential walk corrected `7cd1ce9`: token first, session-cookie fall-through, error-fall-through (the two-arm order per the pinned web group), rotation Set-Cookie re-wrapped on every response, the browser_download_url owner probe added) | landed | authoring | — |
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | LANDED (`src/web/avatar-serving.ts`, mounted `src/index.ts:69` — `/avatars/*` + `/avatar/{hash}` + `/user/avatar/{username}/{size}`; pixel-exact identicon port, default asset via Static Assets `239a4ac`) | landed | core | — |

**A: 24 rows — 11 LANDED, 13 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | ABSENT | landed (`repoListActivityFeeds` family declared `2ef9359`, `renderFeedItems` in `api/services/activity-feeds.ts`; the XML rendering is the work) | admin | M |
| `GET /{username}/-/repositories` (org repo list) | web.go:1134 | LANDED (`pages/org-repos.tsx`, ui-parity-2) | landed | core | — |
| `GET /{username}/-/heatmap` | web.go:1135 | ABSENT | none | admin | M |
| `GET /{username}/-/packages[/...]` | web.go:1108-1128 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET /{username}/-/projects` (the index) | web.go:1139 | LANDED (`pages/owner-projects.tsx`, wave-ui-parity-8 `45bea22`; upstream's group is a project INDEX, not a board — `?state=` facet, writer-only count toggle, visibility-filtered counts, both empty arms, org-vs-individual chrome; no dead controls — titles plain-text, write controls unrendered; follower-404 gate divergence pinned) | landed (projects store 0024 + all three API scopes declared) | authoring | — |
| `/{username}/-/projects` board + write group (`GET /{id}`, `/{id}/workflows[/{workflow_id}]`, `/new`, `/{id}/edit`) | web.go:1140-1155 (+ board/workflow helpers web.go:327-345) | LANDED (`pages/owner-project-board.tsx` + the `owner-project-*` parse families, `9b49cd2` — landed mid-tick after being dispatched in-flight; the board view with columns+cards, both write forms, the workflow tails, form-POST conventions with kebab/move/drag-drop/JS-builder reductions documented, nothing dead; the LIST landed `45bea22`) | landed (same store) | authoring | — |
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

**B: 17 rows — 8 LANDED, 1 PARTIAL, 8 ABSENT.**

## C. Repo code browsing

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{owner}/{repo}` (repo home) | web.go:1292 | LANDED (`pages/home.tsx`) | landed | core | — |
| `GET .../src/{branch|tag|commit}[/*]` | web.go:1749-1755 | LANDED (`pages/file-view.tsx`) | landed | core | — |
| `GET .../tree/*` (redirect to /src) | web.go:1756 | LANDED (`pages/repo-home.tsx`) | landed | core | — |
| `GET .../blob/*` (redirect to /src/commit) | web.go:1757 | LANDED (`pages/repo-home.tsx` `blobRedirectResponse`, wave-ui-parity-9 `1a7af64`; 303 See Other pasted-blob-URL redirect onto `/src/commit/`, raw tail + query verbatim, resolution-before-redirect — unknown/private repos 404-shell, never redirect; the fetch-action arm landed `fdaeaca` — the divergence closed on BOTH redirect twins: `X-Gitea-Fetch-Action` requests get 200 `{"redirect": …}` JSON instead of the 303, per `services/context/base.go:153-156`) | landed | core | — |
| `GET .../commits/{branch|tag|commit}[/*]` | web.go:1722-1727 | LANDED (`pages/commits.tsx`) | landed | core | — |
| `GET .../commit/{sha}` (commit detail + diff) | web.go:1739 | LANDED (`pages/commit-view.tsx`, wave 18; full-oid resolve, short-prefix 404-shell divergence) | landed | core | — |
| `GET .../commit/{sha}/load-branches-and-tags` | web.go:1740 | LANDED (`pages/commit-contained-refs.ts`, wave-ui-parity-6 `1b41b60`; mergeBase containment in 8-wide batches, honest N+2 posture, name-sort divergence documented) | landed | core | — |
| `GET .../commit/{sha}.{patch|diff}` | web.go:1760 | LANDED (`pages/diffpatch-files.ts`, wave-29; mail format without signature per upstream commit.go:430-460) | landed (`diffpatch.ts`) | authoring | — |
| `GET .../blame/{branch|tag|commit}/*` | web.go:1729-1733 | ABSENT | none (blame is a private DO page, not a boundary RPC) | authoring | L |
| `GET .../graph` | web.go:1738 | ABSENT | none | admin | L |
| `GET .../raw/{branch|tag|commit}/*` | web.go:1707-1713 | PARTIAL — our pages emit the tier-1 API raw route instead (`links.ts:41`, documented divergence); the upstream web shape 404s | landed (`readBlob`) | core | S |
| `GET .../media/{branch|tag|commit}/*` | web.go:1699-1705 | PARTIAL — same divergence (upstream's LFS-aware + SVG-sandboxed media path) | landed | core | S |
| `GET .../render/{branch|tag|commit|blob}/*` | web.go:1715-1720 | LANDED (`pages/render-files.ts`, wave-ui-parity-10 `fdaeaca`; markdown renders through the landed pipeline as the standalone sandboxed page. DIVERGENCE ledgered: upstream's default config 400s this family for .md — markdown is not an EXTERNAL renderer, "Unable to get external renderer" — while ours renders it, per the survey row's contract "rendered blob views over the landed markup pipeline"; every other type answers upstream's "Unable to find renderer" 400 class; the degenerate `blob/{sha}` arm mirrored verbatim) | landed | authoring | — |
| `GET .../blob_excerpt/{sha}` | web.go:1735 | IN-FLIGHT — a sibling wave mounts the route now (see In-flight — excluded from the totals, do not re-dispatch; the hunk-machinery gate CLEARED: `0db7087` ported the full `BuildBlobExcerptDiffSection` expansion — cut from the after-commit BLOB, all rows plain — plus `GetExpandDirection`/`FillHiddenCommentIDs`/`hashFilePathForWebUI` into `api/services/blob-excerpt.ts`; the route itself is not in committed HEAD) | landed | core | S |
| `GET .../tree-list/*`, `/tree-view/*` (directory-expansion fragments) | web.go:1297-1306 | LANDED (`pages/tree-list-aux.ts` + `pages/tree-view-aux.ts`; the `tree-list` half `1a7af64` — the bare recursive path-array feed, natural-sort ported verbatim, batched BFS walk, exclusions per treelist.go:51-64; the `tree-view` half the envelope `831709f` — the Go-faithful assembler with the `goJsonString` port, sorted-map key order, empty-never-null, submodule/symlink arms, path half load-bearing + `sub_path` chain. Data note carries a POSTURE PIN: the fileicon module rides the page's import edge **DYNAMICALLY** (`import("../fileicon/fileicon")` lazy boundary) — that keeps the ~12MB asset graph out of the startup snapshot (ws1009; a static re-import re-kills the a11y worker, stash A/B proven — do not "simplify" it back to static)) | landed (`listTree` + the fileicon lookup) | core | — |
| `GET .../archive/{ref}.{format}` | web.go:1689-1692 | LANDED (`pages/archive-files.ts`, wave-ui-parity-6 `1b41b60`; octet-stream + nosniff both formats, weak-ETag 304, immutable Link to the API route) | landed | core | — |
| `GET .../branches` (list page) | web.go:1696 | LANDED (`pages/branches.tsx`, wave 16) | landed | core | — |
| `GET .../branches/list` | web.go:1695 | LANDED (`pages/branches-list-aux.ts`, wave-ui-parity-9 `1a7af64`; the shared `{results: [...]}` byte shape, default branch hoisted then the store's order — order divergence documented) | landed | core | — |
| `GET .../tags` (list page) | web.go:1496 | LANDED (`pages/tags.tsx`, ui-parity-4; engine-authoritative over `listRefs`, release/tag link arms, `?tag=` prefill; the per-row delete control + `/tags/delete` POST write — dual id/tag carrier, protected-refusal + 409 arms — landed wave-ui-parity-7 `48101dc`) | landed | core | — |
| `GET .../tags/list` | web.go:1499 | LANDED (`pages/tag-list-aux.ts`, wave-ui-parity-7 `48101dc`; the byte-shape `{results: [...]}` feed — pin-finding: nothing upstream fetches it, a shape-parity surface) | landed | core | — |
| `GET .../lastcommit/*` | web.go:1761 | IN-FLIGHT — a sibling wave mounts the route now (see In-flight — excluded from the totals, do not re-dispatch; the template-port gate CLEARED: `3502ee4` built the batched per-path commit-info loader — 1+N `listLog` 8-wide vs upstream's one process, wall-free; merge/`-c` divergence + `PATH_LOG_SCAN` cap + no-cache documented — plus the `view_list.tmpl` DOM into `pages/repo-lastcommit-fragment.tsx`; the route itself is not in committed HEAD) | landed | core | S |
| `GET .../search` (in-repo code search) | web.go:1768 | ABSENT | none (no grep RPC) | authoring | L |
| `GET .../{_edit|_new|_delete}/*` (editor combos) | web.go:1453-1461 | LANDED at `/{new|edit|delete}/*` (documented divergence at the brief's literal names, `pages/file-editor.tsx`) | landed | authoring | — |
| `GET .../_upload/*` | web.go:1462-1464 | ABSENT | partial | authoring | M |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | ABSENT | landed (diffpatch + merge machinery) | authoring | M |

**C: 25 rows — 16 LANDED, 2 PARTIAL, 5 ABSENT, 2 IN-FLIGHT.**

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
| `GET .../releases/new`, `/edit/*` | web.go:1516-1520 | LANDED (`pages/releases.tsx`; `/new` wave 20, the `/edit/*` form + write and the formaction `/releases/delete` button + list pencil wave-ui-parity-7 `48101dc` — unconditional web-form writes) | landed | authoring | — |
| `GET .../releases/download/{tag}/{file}`, `/releases/attachments/{uuid}` | web.go:1513-1514 | LANDED (`pages/release-downloads.ts`, wave-ui-parity-10 `fdaeaca`; ServeAttachment for the uuid shape + RedirectDownload for the download shape incl. the `latest` alias; sniff/draft/ETag-304/download-count ports) | landed (`release-assets.ts`) | core | — |
| `GET .../fork` (fork form) | web.go:1490 | LANDED (`pages/repo-fork.tsx`, ui-parity-5; owner options over can-create orgs, `createFork` sequence replay; entry points on the forks page) | landed (`createFork` declared) | authoring | — |
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | ABSENT | landed (wiki 6 ops declared `d3362b1`, `services/wiki.ts` + the sibling engine cell — effort drops L→M) | authoring | M |
| `GET .../activity[/{period}]` | web.go:1628-1631 | ABSENT | partial (feed rows landed `2ef9359`; the stats aggregation stays private on the DO) | core | M |
| `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` | web.go:1633-1646 | ABSENT | partial (aggregation private on the DO) | admin | M |
| `GET .../activity_author_data` | web.go:1683-1687 | ABSENT (aux JSON) | partial | admin | S |
| `GET .../forks` | web.go:1759 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`listForks`) | core | — |
| `GET .../stars` | web.go:1766 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`stars.ts`, `social-lists.ts`) | core | — |
| `GET .../watchers` | web.go:1767 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`repo-watchers.ts`) | core | — |
| `GET .../packages` | web.go:1538-1542 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET .../projects[/...]` | web.go:1544-1563 | LANDED (`ae32b1a` — the full repo-scoped surface: list + board + `/new` + `/{id}/edit` + the workflow tails over the landed store; the `has_projects` unit toggle MODELED — no divergence. Data-note convention: the Hono constraint `:owner/:repo{[^-].*}/projects` — a static second segment does NOT outrank a param in Hono, so the owner-scoped `/-/projects` shapes and these repo-scoped shapes coexist only via the negative-charset constraint; the landing wave discovered+applied it, recorded here so later route work reuses it) | landed (projects store 0024 + all three API scopes declared: repo `fc123b0`, org `20512c0`, user `c9a7ef7` — 64 project ops) | authoring | — |
| `GET .../actions[/...]` | web.go:1566-1608 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |

**F: 14 rows — 8 LANDED, 0 PARTIAL, 6 ABSENT.**

## Totals

**114 rows: 61 LANDED, 3 PARTIAL, 48 ABSENT — plus 2 IN-FLIGHT (the
`blob_excerpt` + `lastcommit` fragment rows, excluded from the counted
sums, which cover 112 rows).**

By family (landed/partial/absent): A 11/0/13, B 8/1/8, C 16/2/5, D
13/0/9, E 5/0/7, F 8/0/6. The landed
set now covers every
highest-traffic single page (repo home, file view, commits log, commit
detail, branches, tags — including the delete write, issues/PRs lists +
details + both PR side tabs, compare, releases browse + create + edit +
delete + the download tail, labels, milestone detail/edit, the fork
form, the social lists, the collaboration panel, creation forms, org
members/repositories, the avatar seam, the attachments seam, the
archive download, `load-branches-and-tags`, the `/-/projects` index AND
its board + write group AND its repo-scoped twin, the `/blob/*` +
`/tree/*` redirects with their
fetch-action arms, `tree-list` AND `tree-view`, `branches/list`, the
`/render/*`
family). The remaining absence mass concentrates in (a) small
page slices over fully landed data (the compare range +
diff-patch shapes, the pulls/new redirect) — the two aux fragments left
that bucket (their machinery landed `0db7087`/`3502ee4` and their
routes are IN-FLIGHT), (b) settings tabs whose APIs just
landed (deploy
keys, protected tags, git hooks, org hooks), (c) the owner `/-/`
namespace tails (heatmap/packages stay gated), and
(d) whole subsystems with no data model (actions, packages, audit logs)
or no engine RPC (blame, graph, code search, heatmap) that are correctly
out of the demand-driven phase's reach.

## Recommendation — re-ranked queue by demand-per-effort

This tick emptied the no-gate tier: the queue's former #1 — the
repo-scoped projects row — LANDED as `ae32b1a` (list + board + writes +
workflows over the 64-op store; nothing left unclaimed to re-rank),
and the two fragment gates cleared in the same window (their machinery
landed `0db7087`/`3502ee4`; the routes themselves are IN-FLIGHT with a
sibling — do not re-dispatch). The numbered queue's new head is below,
and the structural endpoint is now stated plainly: **every dispatchable
row left mounts new parse families in `apps/worker/src/ui/index.ts`** —
the shared route-table file that, per the exclusive-ownership rule,
only the orchestrator or a designated owner edits. No data gate and no
SPEC gate remains on the dispatchable set; the serialization point is
that one file, and a sibling window wave holds it NOW (mounting the
blob_excerpt/lastcommit routes). Dispatch the head when that window
closes.
`node scripts/check-openapi.mjs` PASS at HEAD `ae32b1a` — no row below
needs an API that isn't declared.

1. **The org settings group + `/{org}/teams/{team}/edit`**
   (web.go:1017-1092, 1011 — M per tab + S, authoring) — the
   settings-tab cluster with fully landed data (org hooks ops landed
   `5b704c5`; `orgEditTeam` declared `[ok]`; `pages/org-teams.tsx`
   extends). GATED ONLY ON `index.ts` — the sibling window wave holds
   the shared route table now; every parse family this cluster needs
   waits for that window to close.

Bench (next tier — dispatch when the pool needs dependency-ready goals; all
data-landed unless noted): `.../pulls/new/*` redirect (web.go:1314, S),
`.../pulls/{index}/merge_box` fragment (web.go:1659, S, data partial),
`.../compare/*.{diff|patch}` + the files range shape (web.go:1309-1310,
1672, S — `diffpatch.ts` + landed compare),
`.../issues/search` + `.../issues/suggestions` aux (web.go:1359, 1341, S —
`issueSearchIssues` declared `[ok]`), `/repo/search` +
`/explore/topics/search` aux (web.go:1102, 564, S — `repoSearch` +
`topicSearch` declared `[ok]`), `.../comments/{id}/attachments`
(web.go:1337, S, data partial), `.../issues/new/choose` (web.go:1357, S,
data partial), `.../settings/hooks/git` (web.go:1223-1227, S, admin —
`repoListGitHooks`/`repoGetGitHook`/`repoEditGitHook`/`repoDeleteGitHook`
all declared `[ok]`), `.../settings/public_access` (web.go:1191, S, data
partial), `.../activity_author_data` (web.go:1683-1687, S, data partial).
M-tier page work over just-landed APIs, in demand order: the **wiki
family** (web.go:1611-1625 —
`repoGetWikiPages`/`repoGetWikiPage`/`repoCreateWikiPage`/
`repoEditWikiPage`/`repoDeleteWikiPage`/`repoGetWikiPageRevisions`, all
declared `[ok]`), **settings/keys** (deploy keys),
**settings/tags**
(protected tags), `/{username}.rss/.atom` (feeds declared), the global
`/issues|/pulls|/milestones` inboxes (data partial — the cross-repo perm
filter), the `/user/settings` tab group, `.../_upload/*` +
`.../_diffpatch|_cherrypick` (web.go:1462-1470 — the machinery is
landed), `/repo/migrate` (`services/migrate.ts`).
`/explore/organizations` (web.go:557) needs the missing visible-org search
arm first — data partial, M.
GATED rows (do not dispatch without the feature SPEC): everything
actions/packages (`/-/admin` actions+packages tabs, `settings/actions`,
`.../actions*`, `.../packages`, `/{username}/-/packages` — FEATURE-ABSENT
APIs per the twin inventory's 64 remaining ops), plus the no-RPC pages
(blame, graph, in-repo/explore/`/-/` code search, the
`/{username}/-/heatmap` tail, audit_logs) — heatmap specifically stays
put: the contribution grid needs a heat aggregation that exists on neither
the engine boundary nor a landed service, so it is no-RPC-gated like
blame/graph, not a dispatchable S-row.
Fragment gates — none left standing: the two former machinery gates
cleared this window and both rows are ROUTES-IN-FLIGHT, not gated —
`.../blob_excerpt/{sha}` (web.go:1735; the hunk machinery landed
`0db7087` — the full `BuildBlobExcerptDiffSection` port) and
`.../lastcommit/*` (web.go:1761; the template port landed `3502ee4` —
the batched per-path loader + the `view_list.tmpl` DOM) are both
IN-FLIGHT with a sibling wave that mounts the routes; do not
re-dispatch, the rows flip LANDED when it commits. The former third
fragment gate, `/tree-view/*` (web.go:1297-1306), is RESOLVED — the
fileicon gate cleared (`cdf683a`), the envelope landed (`831709f`),
the row counted LANDED (its dynamic-import posture is pinned in the
row's data note). The
`.../raw` + `.../media` web shapes (web.go:1699-1713) stay
PARTIAL-by-divergence — our SSR pages emit tier-1 API raw links
(`links.ts:41`), so the gap only bites official-bundle references and pasted
URLs; close it opportunistically, not as a dedicated goal.
