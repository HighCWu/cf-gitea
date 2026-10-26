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
**Ticked 2026-10-26** an eighth time, at HEAD `67adfb7`: the index
window CLOSED — `67adfb7` mounts BOTH fragment routes in one commit
(the wave-46 handoff resolved: `blob_excerpt` stage-3 — fragment +
expand buttons + anchors — over the `0db7087` machinery, with the
WIKI TWIN discovered at web.go:1618 — `/{owner}/{repo}/wiki/blob_excerpt/{sha}`
— mounted beside it as the `wiki-blob-excerpt` family with the
wiki-cell swap + `hasWiki` gate; `lastcommit` HANDOFF-exact per the
`3502ee4` mount plan, plus the file-list fetch-attrs flip — four
attrs verbatim, opt-in `loaderCommitOid`), so the two in-flight
fragment rows flip LANDED and the fragment-gates story ends (all
three gates resolved — see the Recommendation). And the numbered
queue's final row — the org settings group + `/{org}/teams/{team}/edit`,
dispatched as ONE unit — goes IN-FLIGHT: a sibling wave owns it now
(excluded from the totals, do not re-dispatch; the tree is CLEAN at
this measurement — IN-FLIGHT by dispatch ownership, exactly the
convention the fragment rows used last tick). Headline **63/3/46 +
2 in-flight** (111 counted of 114 rows); the numbered queue is
empty — what remains is the in-flight pair, the bench, and the
gated/limited rows.
**Ticked 2026-10-26** a ninth time, at HEAD `f696a21`: the numbered
queue's final row LANDED — `8380cf0` mounts the org settings group +
`/{org}/teams/{team}/edit` as ONE commit (the wave-49 module: the
options combo + the avatar write pair + the danger-zone
rename/delete/visibility arms as three details-forms over the landed
org APIs — `orgEdit`/`renameOrg`/`orgDelete`/`orgUpdateAvatar`/
`orgDeleteAvatar`/`orgEditTeam`/`orgDeleteTeam`; `max_repo_creation`
honest-absent, the team form's `repo_access` radios
dead-control-unrendered because the landed editTeam arm ignores the
field), so BOTH in-flight rows flip LANDED — the teams/edit row
whole, the settings row with its per-tab remainders split off as a
fresh ABSENT row (the `/{org}/settings/{hooks,applications,
blocked_users}` tabs + `audit_logs`, web.go:1022-1041,1063,1069-1089;
the
`packages`/`actions` tabs stay FEATURE-ABSENT-gated) — for headline
**65/3/47, zero in-flight** (115 rows; also recorded: the previous
tick's "111 counted" was an arithmetic slip — its own sums give
63+3+46 = 112 counted). And the UNMOUNTED modules —
`repo-migrate` (`f26d65b`), `activity-feeds` (`ec07fb6`; untracked in
the tree when this tick was dispatched, landed mid-tick, its glyph
allowlist exacted as `f696a21`) and `notification-subscriptions`
(UNTRACKED in the tree at this measurement — the dispatch's third
module, materializing mid-tick) — are IN-FLIGHT-machinery: complete
page modules whose mounts ride a window wave (see In-flight); their
rows stay ABSENT-with-machinery-note or LANDED-with-note per the
convention. The numbered queue is EMPTY and now fully LANDED — the
dispatchable surface is bench+gated only.
**Ticked 2026-10-26** a tenth time, at HEAD `b396a41` (the module
wave's final UI commit is `846a918`; a non-UI keys refactor landed
after it and moves no surveyed count — pages 87, branches 186, both
verified at each): the large
two-stage module wave landed UNMOUNTED — complete page modules,
committed, awaiting the `index.ts` window. Landed in the window:
`repo-migrate` (`f26d65b`), `activity-feeds` (`ec07fb6`, glyphs exacted
`f696a21`), `notification-subscriptions` (`486b9fc`),
`repo-settings-wiki` (`5c2812f` — BRIEF PREMISE CORRECTED: no
`wiki.tmpl` at the pin, the settings surface is `options.tmpl`'s three
pieces), `repo-editor-tails` (`f4492b2` — delete confirm + upload DOM),
`user-settings-security`+`-secrets` (`e19c95a`),
`user-settings-webhooks` (`aa9bd40` — premise corrected to
`hooks.tmpl`), `user-settings-keys`+`-applications` (`46230c5`),
`user-settings-organizations` (`11738a8`), and — committed MID-TICK
while this survey was being written, exactly the tick-9 precedent —
`user-settings-variables` (`97dbbde`), `org-settings-blocked`
(`25affaa`), `org-settings-actions` (secrets + variables,
`fbbc05b`) and `user-settings-appearance` (`846a918`). At the final
measurement ZERO UI modules remain untracked — the wave is fully in
committed HEAD, none of it mounted. The ONE mounted
landing is the org settings **hooks tab** (`54264ae` — list/create/
edit/delete over the org-hooks family, the wave-49 navbar + parser
ripples committed with the unit): it flips the B remainder row
`/{org}/settings/{hooks,applications,blocked_users}`(+`audit_logs`)
from ABSENT to **PARTIAL** — the hooks tab serves, the
blocked_users and actions tabs' modules are committed-unmounted, the
applications/audit arms have no landed org-scope reads, and the
packages/actions upstream surfaces stay FEATURE-ABSENT-gated. The RD19
fixes (`8a1a03f` — migrate-201 born-body post-attach + the lastcommit
trailing-slash carve) ride the same window. No row flips LANDED —
unmounted modules do not flip rows per the convention — for headline
**65/4/46, zero rows in flight** (115 rows). The bench queue is
re-ranked below with per-row template + handler premises verified at
the pin.

- **Pin**: `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919;
  verified `git -C gitea rev-parse HEAD`). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the route table + parser families in
  `apps/worker/src/ui/index.ts` at HEAD `b396a41` — the header inventory
  (the route-family comment block) and the `ParsedUiRoute` union
  (line 1892) are the exhaustive family list (a family exists iff a parse
  branch returns it); the pages under `apps/worker/src/ui/pages/` (87
  files committed: 71 page modules + 16 test modules) and the session
  router (`src/ui/session.ts`) carry the renders, with the `src/web/`
  seam routers (avatar serving, attachments serving) mounted in
  `src/index.ts`. The working tree at measurement time is CLEAN under
  `apps/worker/src/ui/` (a sibling's transient hunk to
  `pages/user-settings-keys.tsx` committed as the non-UI keys refactor
  `b396a41` while this survey was written) — every count reads
  committed HEAD (`git show` / `git ls-tree HEAD`), and the committed
  tree at `b396a41` is what the numbers describe. The unmounted-module
  wave added NO parse branches (186 before and after — the two-stage
  convention holding under load).
- **Reproducing the counts** (exactly these walks):
  1. Upstream: walk the page-bearing GETs out of `gitea/routers/web/web.go`
     (`m.Get`/`m.Combo(...).Get` registrations, grouped into the same 6
     families as the original survey — its 113 rows, +1 from the
     `45bea22` tick's LIST/board split of the `/-/projects` row; aux
     surfaces excluded per the preamble) — the row set is pin-stable
     apart from that split.
  2. Ours (committed HEAD only): `git show HEAD:apps/worker/src/ui/index.ts | grep
     -c "family:"` (the parse branches — 186 at this tick) +
     `git ls-tree HEAD --name-only apps/worker/src/ui/pages/ | wc -l`
     (the renders — 87 files) at `b396a41`; `git status --short --
     apps/worker/src/ui/` at the measurement is CLEAN (see Our side) — anything
     spec-bearing or unfamiliar means HEAD is not the right base.
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
| B owner pages | 18 | 10 | 2 | 6 | 0 |
| C repo code browsing | 25 | 18 | 2 | 5 | 0 |
| D issues + pulls | 22 | 13 | 0 | 9 | 0 |
| E repo settings | 12 | 5 | 0 | 7 | 0 |
| F repo sub-systems | 14 | 8 | 0 | 6 | 0 |
| **total** | **115** | **65** | **4** | **46** | **0** |

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
cleared by `0db7087`/`3502ee4`) — for 61/3/48 + 2. The `67adfb7` tick:
the index window closed — both fragment rows flip LANDED (C −2
IN-FLIGHT, +2 LANDED) and the numbered queue's final row (org settings
+ teams/edit, one dispatch unit) flips IN-FLIGHT with its sibling
(B −2 ABSENT, +2 IN-FLIGHT) — for 63/3/46 + 2. The `f6ce45f` tick: that final
row LANDED as `8380cf0` (B −2 IN-FLIGHT, +2 LANDED) and the settings
row's per-tab remainders split off as a fresh ABSENT row (B +1 row,
+1 ABSENT) — for 65/3/47 + 0 (that tick also corrected the previous
tick's "111 counted" arithmetic slip — its sums give 112).
This tick: the org hooks tab lands MOUNTED (`54264ae`), flipping the B
remainder row ABSENT → PARTIAL (B −1 ABSENT, +1 PARTIAL); the rest of
the window is the UNMOUNTED module wave, which flips NO rows per the
convention — for **65/4/46 + 0** at 115 rows.)

## In-flight (excluded from the totals — do not re-dispatch)

**Zero rows and zero sibling-held untracked files are in flight.** The
one row-state change this window is
the B remainder row flipping PARTIAL on its hooks tab's MOUNTED
landing (`54264ae` — counted, not in flight). The module wave's last
two siblings — `org-settings-actions` (`fbbc05b`) and
`user-settings-appearance` (`846a918`) — COMMITTED mid-tick while this
survey was being written (the tick-9 precedent twice over), so the
wave is fully in committed HEAD and nothing is excluded.

What IS in flight is **machinery, not rows**: the large
two-stage module wave — fifteen complete page modules across thirteen
commits, COMMITTED unmounted,
mounts riding an `index.ts` window wave (do not re-dispatch the
module work):

- `repo-migrate` (`f26d65b`) — the `/repo/migrate` form; the row drops
  to an S mount; the API arm gained the migrate-201 born-body
  post-attach fix (`8a1a03f`).
- `activity-feeds` (`ec07fb6`, glyphs exacted `f696a21`) — the landed
  `/{username}` row's `?tab=activity` arm over the 14-type feed matrix.
- `notification-subscriptions` (`486b9fc`) — the subscriptions tails
  `/notifications/subscriptions`, `/watching`, `/purge-page`
  (web.go:1786-1787,1790).
- `repo-settings-wiki` (`5c2812f`) — the settings-side wiki-config arm
  (enable/external/delete over `options.tmpl`'s three pieces; the
  dedicated sub-page + nav item is the documented mirror-panel
  divergence posture).
- `repo-editor-tails` (`f4492b2`) — the editor delete-confirm page arm
  and the `_upload` DOM (write documented-unrendered — the R2 uuid
  staging family does not exist yet).
- The user/org settings tab modules: `user-settings-security` +
  `user-settings-secrets` (`e19c95a`), `-webhooks` (`aa9bd40`, premise
  corrected to `hooks.tmpl`), `-keys` + `-applications` (`46230c5`),
  `-organizations` (`11738a8`), `-variables` (`97dbbde`),
  `-appearance` (`846a918`), `org-settings-blocked` (`25affaa`) and
  `org-settings-actions` (secrets + variables, `fbbc05b`) — the A tabs
  row and the B remainder row carry the notes.
- `org-settings-hooks` (`54264ae`) — the EXCEPTION that mounted in its
  own commit: the B remainder row's hooks tab is LIVE (the
  `org-settings-hooks` parse family is in committed `index.ts`).

The shared `index.ts` serializes every mount; the window waves are the
orchestrator's. Until a mount lands, the affected rows keep their
statuses per the convention: `/repo/migrate` and the subscriptions
tails stay ABSENT-with-machinery-note, the tabs rows stay ABSENT (A)
/ PARTIAL (B) with machinery notes, the landed `/{username}` row keeps
LANDED with a tab-arm note.

The previous in-flight chain, for the record: the org settings +
teams/edit unit resolved as `8380cf0`; the two fragment rows
(`blob_excerpt`, `lastcommit`, both C family) resolved as `67adfb7`;
before them the repo-scoped projects row resolved as `ae32b1a`
(counted LANDED, F family), and before it the
`tree-list`/`tree-view` fragments row resolved as `831709f` (counted
LANDED, C family). The regen's in-flight rows — the social trio
(`.../forks`, `.../stars`, `.../watchers`) and the collaboration
panel — landed in `ca81d5a`, and every UI wave since (`bb67087`,
`0b61554`, `ca4eb58`, `79ef809`, `1b41b60`, `48101dc`, `45bea22`,
`1a7af64`, `9b49cd2`, `cdf683a`, `fdaeaca`, `831709f`, `ae32b1a`,
`67adfb7`, `8380cf0`, `f26d65b`, `ec07fb6`, `486b9fc`, `5c2812f`,
`f4492b2`, `e19c95a`, `aa9bd40`, `46230c5`, `11738a8`, `97dbbde`,
`25affaa`, `54264ae`, `fbbc05b`, `846a918`) committed clean.

## Landed since last regen

The regen's entire recommendation tier landed, the `5d9122c` tick's window
added five more UI commits, and the ticks' windows added five waves plus
the seam+parity-10 window, the tree-view envelope, the index window,
and the final numbered row's own window — then the UNMOUNTED module
wave. The
deltas below sum 36+4-in-flight → 48 LANDED → 56 LANDED → 59 LANDED →
60 LANDED + 1 in-flight → 61 LANDED + 2 in-flight → 63 LANDED + 2
in-flight (the fragment pair landed, the org-settings pair went
in-flight) → 65 LANDED + 0 (the final numbered row
landed; its tab remainders split off as a new row) → **65 LANDED + 0**
at 115 rows (this window's mounted landing flips the B remainder row
PARTIAL; everything else is unmounted module machinery, which flips no
rows):

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
| the index window — both fragment routes + the wiki twin | `GET .../blob_excerpt/{sha}` (web.go:1735 — stage-3: the fragment render + expand buttons + anchors over the `0db7087` hunk machinery) + `GET .../wiki/blob_excerpt/{sha}` (web.go:1618 — the WIKI TWIN discovered mid-mount, the `wiki-blob-excerpt` family with the wiki-cell swap + `hasWiki` gate) + `GET .../lastcommit/*` (web.go:1761 — HANDOFF-exact per the `3502ee4` mount plan; the file-list fetch-attrs flip — four attrs verbatim, opt-in `loaderCommitOid` — rides the same commit) | `67adfb7` |
| the org settings group + teams/edit (the FINAL numbered row) | `GET|POST /{org}/settings` (web.go:1018-1019 — the options combo over `orgEdit` incl. `repo_admin_change_team_access` + the visibility modal's write) + the avatar pair (web.go:1020-1021 — multipart bridged through `processAvatarImage`/`uploadAvatar`) + the danger-zone writes (web.go:1065-1067 — rename/delete/visibility as `<details>` disclosure forms, the dialog reduction; `max_repo_creation` honest-absent) + `GET|POST /{org}/teams/{team}/edit` + the team delete (web.go:1011-1013 — every landed `editTeam` field; the `repo_access` radios dead-control-unrendered, the landed arm ignores the field; per-unit teams render their stored units) — the settings TAB remainders split to the fresh ABSENT row below | `8380cf0` |
| repo-migrate module (UNMOUNTED — the S mount rides a window wave) | `GET /repo/migrate` page module (`pages/repo-migrate.tsx` — the Git-variant field matrix, owner select on the write's own strict predicate, mirror-checked degradation, queue-birth semantics; HANDOFF-exact) | `f26d65b` |
| activity-feeds module (UNMOUNTED — the `?tab=activity` arm) | the landed `/{username}` row's activity tab (the 14-type wired feed matrix per feeds.tmpl+util_misc+action.go, the fall-through degradation, private-visibility + pagination-20) | `ec07fb6` |
| the feeds glyphs exacted | the five allowlist additions (issue-reopened/comment-discussion/file-diff/question/rss), the degradation stand-ins swapped per the module's structured sites | `f696a21` |
| notification-subscriptions module (UNMOUNTED) | `/notifications/subscriptions` + `/watching` + `/purge-page` page module (both arms per notification_subscriptions.tmpl, 8 issue sorts verbatim, facet tri-states, the OPEN-case quirk) | `486b9fc` |
| org settings hooks tab (MOUNTED — flips the B remainder row PARTIAL) | `GET|POST /{org}/settings/hooks[/{id}]` (web.go:1033-1044 — list/create/edit/delete over the org-hooks family, scope-agnostic `editRepoHook` reused; the org list h4 'Settings' QUIRK kept verbatim; no test/replay arms — no upstream org route; the wave-49 navbar + parser ripples committed with the unit) | `54264ae` |
| repo settings wiki module (UNMOUNTED — the settings-side wiki-config arm) | the E settings row's wiki pieces (enable_wiki live-writes hasWiki via the exact PATCH arm; external-wiki/branch-input/delete-modal documented-unrendered; PREMISE CORRECTED: no wiki.tmpl at the pin — options.tmpl's advanced block + danger item + modal) | `5c2812f` |
| repo editor tails module (UNMOUNTED) | the `_delete` confirm page arm (wired-ready onto the landed delete arm) + the `_upload` DOM (write documented-unrendered — no R2 uuid staging family) | `f4492b2` |
| user settings security + secrets modules (UNMOUNTED) | `/user/settings/security` (2FA/webauthn/openid surfaces per the pin's group) + `/user/settings/secrets` | `e19c95a` |
| user settings webhooks module (UNMOUNTED — premise corrected to hooks.tmpl) | `/user/settings/hooks` page module | `aa9bd40` |
| user settings keys + applications modules (UNMOUNTED) | `/user/settings/keys` + `/user/settings/applications` (oauth2 + tokens) | `46230c5` |
| user settings organizations module (UNMOUNTED) | `/user/settings/organization` | `11738a8` |
| user settings variables module (UNMOUNTED — committed mid-tick) | the user settings variables tab | `97dbbde` |
| org settings blocked-users module (UNMOUNTED — committed mid-tick) | the B remainder row's blocked_users tab | `25affaa` |
| org settings actions module (UNMOUNTED — committed mid-tick; secrets + variables) | the B remainder row's actions-tab surfaces (org-scope secrets + variables) | `fbbc05b` |
| user settings appearance module (UNMOUNTED — committed mid-tick) | the A tabs row's appearance tab | `846a918` |

Non-UI landings in the same window that moved Data columns below: the
projects family completed all three API scopes (repo `0d5b480`/`fc123b0`,
org `cc6d73e`/REG `20512c0`, user `f38b218`/REG `c9a7ef7` — declared now
490 ops), avatars (`d7f5646`), deploy keys (`4af12a9`), git hooks
(`5b704c5`), tag protections (`a80878c`), oauth2 apps (`42ab6a5`), wiki
(`d3362b1`), feeds (`2ef9359`) — the full op-level ledger is
`api-remaining-inventory.md` — plus, in this module-wave window, the
RD19 fixes (`8a1a03f`: the migrate-201 born-body post-attach — a born
migration's body is attached after the row exists — and the lastcommit
trailing-slash carve; both ride the pages the unmounted modules mount
onto).

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
| `/user/settings/{account,appearance,security,applications,keys,organization,repos}` | web.go:641-735 | ABSENT — MACHINERY LANDED for most tabs: the two-stage tab modules are committed UNMOUNTED — security + secrets (`e19c95a`), webhooks (`aa9bd40`, premise corrected to hooks.tmpl), keys + applications (`46230c5`), organizations (`11738a8`), variables (`97dbbde`), appearance (`846a918`), and actions (secrets + variables, `fbbc05b`); NO module yet for the account/repos tabs or the settings-level notifications tab (the mount rides a window wave, see In-flight; keys via `account-keys.ts` and oauth2 apps via migration 0026 already landed on the data side) | partial | authoring | M each |
| `GET /notifications` + `/new` + `/status` + `/purge` | web.go:1785,1788-1789,1791 | LANDED (`pages/notifications.tsx`) | landed | authoring | — |
| `/notifications/subscriptions`, `/watching`, `/purge-page` | web.go:1786-1787,1790 | ABSENT — MACHINERY LANDED: the two-stage page module is committed UNMOUNTED (`pages/notification-subscriptions.tsx`, `486b9fc` — both arms per notification_subscriptions.tmpl: the dashboard issuelist + the watching search/repo-list; 8 issue sorts verbatim, facet tri-states honored while JS dropdowns unrendered, the OPEN-case quirk ported; the mount rides a window wave, see In-flight) | partial | authoring | M |
| `/-/admin/*` (dashboard, users, repos, orgs, config, monitor, notices, auths, emails, badges, packages, hooks, applications, actions) | web.go:780-906 | ABSENT (whole family) | partial (user/repo lists + most admin ops declared) | admin | L |
| `GET /org/create` | web.go:972 | LANDED (`pages/org-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/create` | web.go:1098 | LANDED (`pages/repo-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/migrate` | web.go:1100 | ABSENT — MACHINERY LANDED: the two-stage page module is committed UNMOUNTED (`pages/repo-migrate.tsx`, `f26d65b` — the Git-variant field matrix, HANDOFF-exact; the mount rides a window wave, see In-flight; the API arm it rides gained the migrate-201 born-body post-attach fix, `8a1a03f`) | landed (`services/migrate.ts`) | authoring | S (the mount) |
| `GET /repo/search` | web.go:1102 | ABSENT (aux JSON feed; `repoSearch` declared) | landed | authoring | S |
| `GET /attachments/{uuid}` | web.go:912 | LANDED (`src/web/attachments-serving.ts` mounted in `src/index.ts` before `uiRouter` with the `isAttachmentServing` carve-out — `5e082cd` + `2b5b898`; the full ServeAttachment walk: issue/PR/release linkage, draft arm, scope-check-after-404s, read:issue vs read:repository; Go sniff table + FormatMediaType + httpcache 304s; streaming. Premise corrected vs this row's old text: upstream defaults INLINE for all — the download arm is dead at frozen settings, the CSP sandbox + forced text/plain is the real mechanism. Credential walk corrected `7cd1ce9`: token first, session-cookie fall-through, error-fall-through (the two-arm order per the pinned web group), rotation Set-Cookie re-wrapped on every response, the browser_download_url owner probe added) | landed | authoring | — |
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | LANDED (`src/web/avatar-serving.ts`, mounted `src/index.ts:69` — `/avatars/*` + `/avatar/{hash}` + `/user/avatar/{username}/{size}`; pixel-exact identicon port, default asset via Static Assets `239a4ac`) | landed | core | — |

**A: 24 rows — 11 LANDED, 13 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`; the `?tab=activity` arm's page module is landed-unmounted — `pages/activity-feeds.tsx`, `ec07fb6`, the mount rides a window wave, see In-flight) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | ABSENT | landed (`repoListActivityFeeds` family declared `2ef9359`, `renderFeedItems` in `api/services/activity-feeds.ts`; the landed activity-feeds page module `ec07fb6` adds the rendering vocabulary; the XML envelopes are the work) | admin | M |
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
| `GET|POST /{org}/teams/{team}/edit` (+ the team delete write) | web.go:1011-1013 | LANDED (`pages/org-settings.tsx`'s edit arm, `8380cf0` — new.tmpl's edit form over every landed `editTeam` field: name, description, the visibility radio triple, permission radios checked by the team's `authorize` (blanket read/write/admin — the landed enum has no `none`), stored per-unit teams rendering their unit rows with `units_present=1` and form-convert semantics per upstream's ParseAccessMode-first order; the `repo_access` radios dead-control-unrendered — the landed arm ignores the field; the red Delete Team button a real form POST, the confirm dialog reduced) | landed (`orgEditTeam`/`orgDeleteTeam` declared) | authoring | — |
| `GET|POST /{org}/settings` (options) + the avatar pair + the danger-zone writes | web.go:1017-1021,1065-1067 | LANDED (`pages/org-settings.tsx`, wave 49 `8380cf0` — the options combo over `orgEdit`: full_name/email/description/website/location + `repo_admin_change_team_access` + the visibility modal's write; the avatar pair multipart-bridged through the landed avatar pipeline (`processAvatarImage`/`uploadAvatar`); rename/delete/visibility as three `<details>` disclosure forms — the dialog reduction, every control live; `max_repo_creation` honest-absent, no landed key nor column; the navbar's unlanded tabs render nothing, the dead-link rule) | landed (`orgEdit`/`renameOrg`/`orgDelete`/`orgUpdateAvatar`/`orgDeleteAvatar` declared) | authoring | — |
| `/{org}/settings/{hooks,applications,blocked_users}` (+ `audit_logs`; the `packages`/`actions` tabs FEATURE-ABSENT) | web.go:1022-1041,1063,1069-1089 | PARTIAL — the hooks tab LANDED MOUNTED (`pages/org-settings-hooks.tsx`, `54264ae` — list/create/edit/delete over the org-hooks family, scope-agnostic `editRepoHook` reused; the org list h4 'Settings' QUIRK kept verbatim :151; no test/replay arms — no upstream org route / no landed arm, documented); the blocked_users tab's module is committed UNMOUNTED (`pages/org-settings-blocked.tsx`, `25affaa`); the applications/audit_logs tails have no landed org-scope reads (needs-API-first); the `packages`/`actions` upstream surfaces stay FEATURE-ABSENT-gated per the twin inventory (the actions tab's module — secrets + variables — is committed-unmounted, `fbbc05b`) | partial (org hooks ops ALL declared — `orgListHooks`/`orgGetHook`/`orgCreateHook`/`orgEditHook`/`orgDeleteHook`; applications/blocked_users/audit tails have no landed org-scope reads) | authoring | M per remaining tab |
| `GET /org/{org}/settings/labels` | web.go:1043-1049 | LANDED at `/{org}/labels` (documented divergence; the three POST segments ride upstream's literals) | landed | authoring | — |

**B: 18 rows — 10 LANDED, 2 PARTIAL, 6 ABSENT.**

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
| `GET .../blob_excerpt/{sha}` | web.go:1735 | LANDED (`pages/repo-blob-excerpt-fragment.tsx` + the `blob-excerpt` parse family, `67adfb7` — stage-3 mount over the `0db7087` machinery: the fragment render + the expand buttons + the anchors arms; the WIKI TWIN discovered at web.go:1618 — `/{owner}/{repo}/wiki/blob_excerpt/{sha}` — mounted in the same commit as the `wiki-blob-excerpt` family with the wiki-cell swap + `hasWiki` gate, giving the F family's wiki row its excerpt arm while its page surface stays ABSENT) | landed | core | — |
| `GET .../tree-list/*`, `/tree-view/*` (directory-expansion fragments) | web.go:1297-1306 | LANDED (`pages/tree-list-aux.ts` + `pages/tree-view-aux.ts`; the `tree-list` half `1a7af64` — the bare recursive path-array feed, natural-sort ported verbatim, batched BFS walk, exclusions per treelist.go:51-64; the `tree-view` half the envelope `831709f` — the Go-faithful assembler with the `goJsonString` port, sorted-map key order, empty-never-null, submodule/symlink arms, path half load-bearing + `sub_path` chain. Data note carries a POSTURE PIN: the fileicon module rides the page's import edge **DYNAMICALLY** (`import("../fileicon/fileicon")` lazy boundary) — that keeps the ~12MB asset graph out of the startup snapshot (ws1009; a static re-import re-kills the a11y worker, stash A/B proven — do not "simplify" it back to static)) | landed (`listTree` + the fileicon lookup) | core | — |
| `GET .../archive/{ref}.{format}` | web.go:1689-1692 | LANDED (`pages/archive-files.ts`, wave-ui-parity-6 `1b41b60`; octet-stream + nosniff both formats, weak-ETag 304, immutable Link to the API route) | landed | core | — |
| `GET .../branches` (list page) | web.go:1696 | LANDED (`pages/branches.tsx`, wave 16) | landed | core | — |
| `GET .../branches/list` | web.go:1695 | LANDED (`pages/branches-list-aux.ts`, wave-ui-parity-9 `1a7af64`; the shared `{results: [...]}` byte shape, default branch hoisted then the store's order — order divergence documented) | landed | core | — |
| `GET .../tags` (list page) | web.go:1496 | LANDED (`pages/tags.tsx`, ui-parity-4; engine-authoritative over `listRefs`, release/tag link arms, `?tag=` prefill; the per-row delete control + `/tags/delete` POST write — dual id/tag carrier, protected-refusal + 409 arms — landed wave-ui-parity-7 `48101dc`) | landed | core | — |
| `GET .../tags/list` | web.go:1499 | LANDED (`pages/tag-list-aux.ts`, wave-ui-parity-7 `48101dc`; the byte-shape `{results: [...]}` feed — pin-finding: nothing upstream fetches it, a shape-parity surface) | landed | core | — |
| `GET .../lastcommit/*` | web.go:1761 | LANDED (the `lastcommit` parse family mounted HANDOFF-exact per the `3502ee4` wave's documented plan, `67adfb7`; the loader posture carries over — batched per-path commit-info, 1+N `listLog` 8-wide vs upstream's one process, wall-free; merge/`-c` divergence + `PATH_LOG_SCAN` cap + no-cache documented; the file-list fetch-attrs flip — four attrs verbatim, opt-in `loaderCommitOid` — landed in the same commit so the listing page drives the same loader; the trailing-slash carve (`8a1a03f` — the LATENT trailing-slash 404 found by RD19 fixed in the route matcher) | landed | core | — |
| `GET .../search` (in-repo code search) | web.go:1768 | ABSENT | none (no grep RPC) | authoring | L |
| `GET .../{_edit|_new|_delete}/*` (editor combos) | web.go:1453-1461 | LANDED at `/{new|edit|delete}/*` (documented divergence at the brief's literal names, `pages/file-editor.tsx`) | landed | authoring | — |
| `GET .../_upload/*` | web.go:1462-1464 | ABSENT — DOM MACHINERY LANDED: the editor-tails module renders the upload page (`pages/repo-editor-tails.tsx`, `f4492b2` — full dropzone data contract, max-file 5 / max-size 50 MB defaults, the common_breadcrumb PageIsUpload arm; the WRITE is documented-unrendered — no R2 uuid staging store, no `/upload-file`+`/upload-remove` arms, no `UploadRepoFiles` create-op); the mount gives DOM parity, the write needs-API-first | partial | authoring | M (the staging family) |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | ABSENT | landed (diffpatch + merge machinery) | authoring | M |

**C: 25 rows — 18 LANDED, 2 PARTIAL, 5 ABSENT.**

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
| `GET .../settings` (basics) | web.go:1185 | LANDED (`pages/settings.tsx`, admin viewer only; the settings-side WIKI-CONFIG arm is landed-unmounted — `pages/repo-settings-wiki.tsx`, `5c2812f`: enable_wiki live-writes hasWiki via the exact PATCH arm, external-wiki/branch-input/delete-modal documented-unrendered, the dedicated sub-page + nav item is the mirror-panel divergence posture; PREMISE CORRECTED at dispatch: no `wiki.tmpl` at the pin, the surface is `options.tmpl`'s three pieces) | landed | authoring | — |
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
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | ABSENT (the page family — two aux arms serve already: the excerpt fragment `/wiki/blob_excerpt/{sha}` mounted `67adfb7` beside the repo twin with the wiki-cell swap + `hasWiki` gate, see the C-family row; no wiki page surface yet. VERIFY-FIRST premise for dispatch — the wiki/webhooks lesson: the templates all exist at the pin (`templates/repo/wiki/{start,view,pages,new,revision}.tmpl`, verified) and the handlers are `repo.Wiki`/`WikiPost` (web.go:1611-1625), BUT the sub-pages (`_pages`, `_new`, `_revision`) are NOT web.go registrations — they are case-arms inside the wildcard combo's handler (wiki.go:445-462, `?action=_pages` redirects), so the brief must be re-derived from wiki.go at the pin, not from the route table; the settings twin's naive template premise was already corrected once (`5c2812f`)) | landed (wiki 6 ops declared `d3362b1`, `services/wiki.ts` + the sibling engine cell — effort drops L→M) | authoring | M |
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

**115 rows: 65 LANDED, 4 PARTIAL, 46 ABSENT — zero IN-FLIGHT; the
counted sums cover all 115 rows.** (The module wave's last two
siblings committed mid-tick — nothing is excluded; the tick-9
correction of the
tick-8 "111 counted" arithmetic slip stands.)

By family (landed/partial/absent): A 11/0/13, B 10/2/6, C 18/2/5, D
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
family, both code-view fragments — `blob_excerpt/{sha}` (with the
wiki twin) and `lastcommit/*` — AND the org owner
family's core: the org settings options+avatar+danger-zone arms, the
team edit form, and — since this tick — the org settings HOOKS tab
(`54264ae`, the B remainder row's first mounted arm). The remaining
absence mass concentrates
in (a) small
page slices over fully landed data (the compare range +
diff-patch shapes, the pulls/new redirect) — the two aux fragments left
that bucket when their routes mounted (`67adfb7`),
(b) settings tabs whose APIs just
landed (deploy
keys, protected tags, git hooks — repo- AND org-scope, the org hooks
tab having landed this window),
(c) the owner `/-/`
namespace tails (heatmap/packages stay gated),
(d) the committed-unmounted module mounts — thirteen commits carrying
fifteen page modules: migrate, the profile
activity tab, the subscriptions tails, the
settings-wiki arm, the editor tails, and ten user/org settings tab
modules — the machinery rides a window wave (see In-flight), and
(e) whole subsystems with no data model (actions, packages, audit logs)
or no engine RPC (blame, graph, code search, heatmap) that are correctly
out of the demand-driven phase's reach.

## Recommendation — re-ranked queue by demand-per-effort

This tick the UNMOUNTED module wave landed (fifteen committed page
modules across thirteen commits — see In-flight) and the org hooks tab
mounted (`54264ae`, flipping the B
remainder row PARTIAL): **the numbered queue stays EMPTY and fully
LANDED — zero rows in flight; the dispatchable surface is the verified
bench queue below plus the gated rows, nothing else.** The structural
endpoint stands: every remaining mount edits
`apps/worker/src/ui/index.ts` — the shared route-table file that, per
the exclusive-ownership rule, only the orchestrator or a designated
owner edits — so module dispatch stays TWO-STAGE (a page module
committed unmounted + its mount riding a window wave), and the window
itself is the orchestrator's.
`node scripts/check-openapi.mjs` PASS at
HEAD `b396a41` — no row below needs an API that isn't declared.

Machinery in flight (not a dispatch target — the module work is DONE
or sibling-held, the mounts ride a window wave; do not re-dispatch):

- **The unmounted-module wave** (all committed — fifteen page modules
  across thirteen commits): `repo-migrate`
  (`f26d65b` — the `/repo/migrate` row drops to an S mount),
  `activity-feeds` (`ec07fb6` + glyph exact `f696a21` — the profile
  `?tab=activity` arm), `notification-subscriptions` (`486b9fc` — the
  subscriptions tails, web.go:1786-1787,1790), `repo-settings-wiki`
  (`5c2812f` — the settings wiki-config arm), `repo-editor-tails`
  (`f4492b2` — delete confirm + upload DOM), `user-settings-security`
  + `-secrets` (`e19c95a`), `-webhooks` (`aa9bd40`), `-keys` +
  `-applications` (`46230c5`), `-organizations` (`11738a8`),
  `-variables` (`97dbbde`), `org-settings-blocked` (`25affaa`),
  `org-settings-actions` (`fbbc05b`), `-appearance` (`846a918`).
  One `index.ts` window mounts the batch; the affected rows carry
  their machinery notes (see In-flight).

### The bench queue — genuinely dispatchable NOW

Eight rows, re-verified at the pin this tick (template path + handler
cite checked in the submodule; data ops declared per `check-openapi`
PASS; no sibling holds the files). Dispatch order by demand-per-effort;
each is two-stage module work (mount rides the window):

1. **`GET .../pulls/new/*` redirect** (D, S) — handler
   `repo.PullsNewRedirect` (web.go:1314, verified); no template (a
   redirect onto `/compare` with the query preserved). Ready because
   compare + pulls are landed and the upstream handler is a pure
   redirect — the smallest dispatchable row on the board.
2. **`GET .../compare/*.{diff|patch}` + `GET .../pulls/{index}/files/{a}..{b}`**
   (D, S, one unit) — handlers `repo.DownloadCompareDiff`/
   `repo.DownloadComparePatch` (web.go:1309-1310) +
   `repo.ViewPullFilesForRange` (web.go:1672), verified; no templates
   (byte feeds). Ready because `pages/diffpatch-files.ts` (the mail
   format machinery) and both landing pages are landed — pure shape
   work over landed machinery.
3. **`GET .../issues/search` + `GET .../issues/suggestions` aux**
   (D, S, one unit) — handlers `repo.SearchRepoIssuesJSON`
   (web.go:1359) + `repo.IssueSuggestions` (web.go:1341), verified;
   `issueSearchIssues` declared `[ok]`, suggestions over the landed
   issue tables; both aux JSON feeds (template-free parity surfaces).
4. **`GET .../pulls/{index}/merge_box` fragment** (D, S) — handler
   `repo.ViewPullMergeBox` (web.go:1659 → issue_view.go:459);
   template `gitea/templates/repo/issue/view_content/pull_merge_box.tmpl`
   verified at the pin. Data partial-but-serviceable: the merge
   machinery and PR model are landed; the fragment renders the box
   alone — DOM parity over landed state.
5. **`GET /repo/search` + `GET /explore/topics/search` aux**
   (A, S, one unit) — handlers `repo.SearchRepo` (web.go:1102) +
   `explore.TopicSearch` (web.go:564), verified; `repoSearch` +
   `topicSearch` declared `[ok]`; aux JSON feeds.
6. **`GET .../settings/hooks/git`** (E, S, admin) — handlers
   `repo_setting.GitHooks`/`GitHooksEdit`/`GitHooksEditPost`
   (web.go:1223-1227, verified); templates
   `gitea/templates/repo/settings/githooks.tmpl` +
   `githook_edit.tmpl` verified at the pin; all four git-hook ops
   declared (`5b704c5`). Ready because the org twin JUST landed the
   scope-agnostic pattern (`54264ae` — `editRepoHook` reuse, the
   no-test/replay-arm posture documented).
7. **`GET .../settings/tags` (protected tags)** (E, M) — handlers
   `repo_setting.ProtectedTags` + new/edit/delete posts
   (web.go:1215-1221, verified; the template constant is
   `repo/settings/tags`, protected_tag.go:27); template
   `gitea/templates/repo/settings/tags.tmpl` verified at the pin;
   protected_tags 0025 + all five `repo*TagProtection` ops declared
   (`a80878c`) — list + form + enforcement-badge page work over fully
   landed data.
8. **The wiki page family** (F, M) — **VERIFY-FIRST premise** (the
   wiki/webhooks lesson): handlers `repo.Wiki`/`WikiPost` combos
   (web.go:1611-1625, verified) and templates
   `gitea/templates/repo/wiki/{start,view,pages,new,revision}.tmpl`
   verified at the pin; all six wiki ops declared (`d3362b1`) +
   `services/wiki.ts` + the engine cell. BUT the sub-pages
   (`_pages`/`_new`/`_revision`) are case-arms inside the wildcard
   combo's handler (wiki.go:445-462), not web.go registrations — the
   dispatch brief MUST be re-derived from wiki.go at the pin before
   writing (the settings twin's naive template premise was corrected
   once already, `5c2812f`). Verify first, then it is plain M page
   work over landed ops.

M-tier remainder (dispatchable after the queue above, data landed
unless noted): `.../_diffpatch|_cherrypick` (web.go:1465-1470 —
templates `repo/editor/cherry_pick.tmpl` + `patch.tmpl` verified at
the pin, diffpatch + merge machinery landed), **settings/keys** (deploy
keys — `settings/keys.tmpl`+`deploy_keys.tmpl` verified, ops landed
`4af12a9`), `/{username}.rss/.atom` (feeds declared + the
activity-feeds module's rendering vocabulary; the XML envelopes are
the work), `GET /sitemap.xml` + explore sitemaps (web.go:530,554,556 —
XML over landed listings), the global `/issues|/pulls|/milestones`
inboxes (data partial — the cross-repo perm filter),
`.../comments/{id}/attachments` (web.go:1337, data partial),
`.../issues/new/choose` (web.go:1357, data partial),
`.../settings/public_access` (web.go:1191 — template
`settings/public_access.tmpl` verified at the pin; data partial),
`.../activity_author_data` (web.go:1683-1687, data partial),
`.../{type}/{index}/info|attachments|content-history/*` fragments
(web.go:1321-1330, data partial).
NEEDS-API-FIRST rows (do not dispatch as UI work): 
`/explore/organizations` (web.go:557 — the anonymous visible-org
search arm is missing), `GET /user/sign_up` (no self-serve
registration service), the org dashboard + issues groups
(web.go:982-991 — no org-scope cross-cut reads), `.../settings/lfs`
(pointer-scan queries missing), `.../activity[/{period}]` + the
stats family (the aggregations stay private on the DO), and the
`_upload` WRITE (the R2 uuid staging family).
The `/repo/migrate` MOUNT and the rest of the unmounted-module batch
are NOT bench rows — they ride the machinery window above.
GATED rows (do not dispatch without the feature SPEC): everything
actions/packages (`/-/admin` actions+packages tabs, `settings/actions`,
`.../actions*`, `.../packages`, `/{username}/-/packages`, and the org
settings `packages`/`actions` tabs of the remainder row —
FEATURE-ABSENT
APIs per the twin inventory's 64 remaining ops), plus the no-RPC pages
(blame, graph, in-repo/explore/`/-/` code search, the
`/{username}/-/heatmap` tail, audit_logs) — heatmap specifically stays
put: the contribution grid needs a heat aggregation that exists on neither
the engine boundary nor a landed service, so it is no-RPC-gated like
blame/graph, not a dispatchable S-row.
Fragment gates — CLOSED, all three; this section retires with the tick.
The first gate, `/tree-view/*` (web.go:1297-1306), cleared when the
fileicon asset+lookup layer landed (`cdf683a` — premise corrected: the
pinned fileicon has NO enry dep) and closed when the envelope mounted
(`831709f` — counted LANDED, its dynamic-import posture pinned in the
row's data note). The second, `.../blob_excerpt/{sha}` (web.go:1735),
cleared when `0db7087` ported the full `BuildBlobExcerptDiffSection`
hunk expansion and closed when `67adfb7` mounted the route (stage-3:
fragment + buttons + anchors, plus the wiki twin at web.go:1618). The
third, `.../lastcommit/*` (web.go:1761), cleared when `3502ee4` landed
the batched per-path loader + the `view_list.tmpl` DOM and closed when
`67adfb7` mounted the route HANDOFF-exact. No gate — data, SPEC, or
fragment — stands anywhere on the survey; what remains is the
machinery window (the eleven-module batch), the verified bench queue
above, and the
gated/limited rows below.
The
`.../raw` + `.../media` web shapes (web.go:1699-1713) stay
PARTIAL-by-divergence — our SSR pages emit tier-1 API raw links
(`links.ts:41`), so the gap only bites official-bundle references and pasted
URLs; close it opportunistically, not as a dedicated goal.
