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
**Ticked 2026-10-27** an eleventh time, at HEAD `03f9e82`: the index
window LANDED and the deferred-matrix polish program swept it. The
whole committed-unmounted module wave MOUNTED — fourteen window
commits, sub-waves 2a-2f, **92 routes**: window-2a the user-settings
tab family (8 modules, 19 routes, `0c2b151`), window-2b the org
blocked-users tab + actions secrets/variables (9 routes, `4f2805f`),
window-2c the admin group — dashboard + 4 monitor pages + the cron run
(7 routes, `e31c0cf`), window-2d both passes (four repo-settings tabs,
13 routes, `b54f709`; the wiki-config arm, 2 routes, `46e7e68`), and
window-2e in eight slices (sitemap + the two search aux feeds
`84996c6`, 6 routes; the global inbox `a8818c6`, 3; the .rss/.atom
envelopes `1a59af0`, 1; the repo-scoped aux feeds + fragments
`22599e4`, 11; the wiki family `9516bf1`, 4; editor tails +
cherrypick/patch `1d834d6`, 8, the delete-page swap; the migration
page `62ef380`, 2; the subscriptions/watching tails `5ca1727`, 2) plus
the folds (branches writer arms + the pulls/new redirect + the upload
staging endpoints, `635ce2e`, 5); then window-2f — the 13-site
shared-navbar swap (`94c6851`) and the SettingsNav fold (`d32db26`,
five repo-settings items in, the scaffold navs deleted). ONE module
deliberately did NOT mount: the profile `?tab=activity` page arm
(`ec07fb6`) — its seam and rendering vocabulary landed into the
.rss/.atom envelopes instead (`resolveActivityFeeds` at the user-feed
route); the page render stays unmounted (see In-flight). The
deferred-matrix polish program then walked every landed page: **52
matrix/route-arm commits whose subjects tally 1,170 cases** (plus the
appearance tab's route-arms matrix, unnumbered), catching **18 real
UI bugs** — FOUR dead routes of ONE registration-order class (the
mounted wiki family unreachable, `a58cad5`; `/repo/search` +
`/repo/migrate` shadowed by the dynamic block, `f60e5a8`; the
pulls/new redirect dead behind its own parse claim, `3837c17`;
issues/search + suggestions under the `/:index` catch, `c4a1723`), a
CSRF (the cherrypick/patch POST arms missing sameOriginGuard,
`27aa538`), a global cookie-directive violation (the session
clear-cookie double-wrapped on every UI page, `dee8cf0`), a
wire-format divergence (PR comments anchoring under /issues —
commentHtmlUrl's is_pull branch, `89589b3`), the merged-verb bug
(`6ecb21c`), the comment archived/locked ladder (`a12ecdf`), archived
mirrors rendering the full page (`cdde728`), unknown-uid access-mode
changes accepted (`f8c84fc`), the workflow-delete GET verb-twin
(`d23ad32`), and the long tail (unknown commit-sha refs `188f33d`,
archived-branch delete buttons `234ee49`, tags wiring `01fae9e`, keys
wiring `18383fe`, sitemap idx guards + the repo-search bridge
`c2925f2`, the conditional Public Access item `364bf92`) — plus **~18
stale pins/goldens swept** (the sweep doc
`docs/compat/stale-pin-sweep.md`: five pin lines across four files,
`04d80b3`; plus thirteen more pin/golden updates — `e2cade9`,
`0c66990`, `5e26d76`, `ef23c5e`, `f41237f`, `41bc9ab`, the four
repo-settings goldens `2c7c05f`, the wave-17 pin flip riding
`635ce2e`). The mounted families flip LANDED — with three rows going
PARTIAL instead, each for a stated remainder (the issue fragments:
content-history list/detail unclaimed, no snapshot store; the admin
group: ten-plus admin pages still absent; the user-settings tabs:
account/repos/notifications arms still absent) — for headline
**88/7/20, zero rows in flight** (115 rows). The tick-10 bench queue
landed inside the window in its ENTIRETY (all eight bench rows, every
one also on the bug list's dead-route/wiring classes where it bit) —
the demand-driven dispatchable surface is down to ONE S row: the
profile activity tab arm. The four-dead-route lesson is recorded as a
process note below.

- **Pin**: `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919;
  verified `git -C gitea rev-parse HEAD`). Every `web.go:N` cite is
  `gitea/routers/web/web.go` at that commit unless another file is named.
- **Our side**: the route table + parser families in
  `apps/worker/src/ui/index.ts` at HEAD `03f9e82` — the header inventory
  (the route-family comment block) and the `ParsedUiRoute` union
  (index.ts:2323 at this tick) are the exhaustive family list (a family
  exists iff a parse branch returns it); the pages under
  `apps/worker/src/ui/pages/` (160 files committed at this tick: 87 page
  modules + 73 test modules, up from 87 files total at `b396a41`) and the
  session router (`src/ui/session.ts`) carry the renders, with the
  `src/web/` seam routers (avatar serving, attachments serving) mounted in
  `src/index.ts`. The working tree at measurement time is CLEAN repo-wide
  (`git status --short` empty) — every count reads committed HEAD
  (`git show` / `git ls-tree HEAD`), and the committed tree at `03f9e82`
  is what the numbers describe. The window grew the survey's
  `grep -c "family:"` parse-branch count 186 → 263 and index.ts 7,752 →
  10,054 lines.
- **Reproducing the counts** (exactly these walks):
  1. Upstream: walk the page-bearing GETs out of `gitea/routers/web/web.go`
     (`m.Get`/`m.Combo(...).Get` registrations, grouped into the same 6
     families as the original survey — its 113 rows, +1 from the
     `45bea22` tick's LIST/board split of the `/-/projects` row; aux
     surfaces excluded per the preamble) — the row set is pin-stable
     apart from that split.
  2. Ours (committed HEAD only): `git show HEAD:apps/worker/src/ui/index.ts | grep
     -c "family:"` (the parse branches — 263 at this tick) +
     `git ls-tree HEAD --name-only apps/worker/src/ui/pages/ | wc -l`
     (the renders — 160 files) at `03f9e82`; `git status --short` at the
     measurement is EMPTY repo-wide (see Our side) — anything
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
| A site-level + auth | 24 | 19 | 2 | 3 | 0 |
| B owner pages | 18 | 11 | 2 | 5 | 0 |
| C repo code browsing | 25 | 20 | 2 | 3 | 0 |
| D issues + pulls | 22 | 19 | 1 | 2 | 0 |
| E repo settings | 12 | 9 | 0 | 3 | 0 |
| F repo sub-systems | 14 | 10 | 0 | 4 | 0 |
| **total** | **115** | **88** | **7** | **20** | **0** |

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
This tick: the index window mounted the ENTIRE unmounted-module wave —
92 routes across fourteen window commits (2a-2f, the slice ledger in
the header paragraph) — plus window-2f's nav swap + SettingsNav fold,
and the mounted families flipped: A +8 LANDED (topics/search, sitemap,
the three global inboxes, subscriptions, migrate, repo/search) + 2
PARTIAL (the settings-tabs row, the admin group), B +1 (the
.rss/.atom envelopes), C +2 (_diffpatch/_cherrypick, _upload — the
staging write landed with the page), D +6 LANDED (merge_box, the
files range, the compare byte feeds, pulls/new, issues/search,
suggestions) + 1 PARTIAL (the fragments row: content-history
list/detail unclaimed), E +4 (protected tags, git hooks, deploy keys,
public access), F +2 (the wiki family, activity_author_data) — for
**88/7/20 + 0** at 115 rows.)

## In-flight (excluded from the totals — do not re-dispatch)

**Zero rows and zero sibling-held untracked files are in flight.** The
post-window truth: the two-stage module wave is fully CONSUMED — the
fourteen window commits (2a-2f, 92 routes) mounted every
committed-unmounted module, and the polish matrices behind them are
committed. The ONE deliberate survivor:

- **The profile `?tab=activity` page arm** — `pages/activity-feeds.tsx`
  (`ec07fb6`, glyphs exacted `f696a21`) is complete and committed, but
  the window did NOT mount the page arm: its seam
  (`resolveActivityFeeds`) and rendering vocabulary landed into the
  .rss/.atom envelopes instead (`1a59af0` imports the seam; the page
  render `renderActivityFeedsPage` has no caller outside its module,
  verified at HEAD). The landed `/{username}` row keeps LANDED with a
  tab-arm note; the arm itself is the survey's last S-sized bench row
  (wire the owner-home handler's tab dispatch onto the committed
  renderer).

The previous in-flight chain, for the record: the module wave
(fifteen page modules across thirteen commits, tracked through ticks
9-10) resolved INTO the window (`0c2b151`, `4f2805f`, `e31c0cf`,
`b54f709`, `46e7e68`, `84996c6`, `a8818c6`, `1a59af0`, `22599e4`,
`9516bf1`, `1d834d6`, `62ef380`, `5ca1727`, `635ce2e`); before it the
org settings + teams/edit unit resolved as `8380cf0`, the two fragment
rows as `67adfb7`, the repo-scoped projects row as `ae32b1a`, and the
`tree-list`/`tree-view` fragments row as `831709f`. Every UI wave of
the demand-driven phase (`bb67087`, `0b61554`, `ca4eb58`, `79ef809`,
`1b41b60`, `48101dc`, `45bea22`, `1a7af64`, `9b49cd2`, `cdf683a`,
`fdaeaca`, `831709f`, `ae32b1a`, `67adfb7`, `8380cf0`, `f26d65b`,
`ec07fb6`, `486b9fc`, `5c2812f`, `f4492b2`, `e19c95a`, `aa9bd40`,
`46230c5`, `11738a8`, `97dbbde`, `25affaa`, `54264ae`, `fbbc05b`,
`846a918`, and the fourteen window commits) committed clean.

## Process note — the dead-route class (four occurrences, one lesson)

The polish program's most valuable catch was not any single bug but a
CLASS: **a mounted route can be dead on arrival when its registration
or parse loses the ordering fight against a dynamic sibling**, and
nothing about the module code or the mount diff reveals it — the page
renders green in module-level tests that never traverse the live
router. Four instances, all caught by route-level matrix arms hitting
the real `uiRouter`:

1. `a58cad5` — the whole wiki family (`9516bf1`) was unreachable: the
   parse branch lost to an earlier claim and the registrations sat
   after a catch-all. The flagship module of the wave, dead in
   production shape until the matrix's first route-level arm 404'd.
2. `f60e5a8` — `/repo/search` + `/repo/migrate` GETs registered after
   the dynamic owner/repo block, which shadowed both (`/repo` parses
   as an owner).
3. `3837c17` — the pulls/new redirect: the registration order claim
   plus a `slice(5)` parse mismatch, each invisible at module scope.
4. `c4a1723` — issues/search + suggestions feeding under the
   `/:index` catch instead of ahead of it.

The rule going forward: **every mount commit must prove its routes
through the live router with a request-level arm** (the matrices'
route-level convention — dispatcher-suite plus at least one real
request per registered shape), and **static literals register ahead of
every dynamic segment that could shadow them** (the window commits'
repeated "registered BEFORE the owner/repo parse" notes are this rule
applied). Module-green is not route-live; only the second is done.


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
at 115 rows (the org hooks tab flipped the B remainder row PARTIAL;
everything else was unmounted module machinery, which flips no rows)
→ **88 LANDED + 0** at 115 rows (the index window mounted the whole
module wave — 92 routes across fourteen commits — flipping A +8
LANDED +2 PARTIAL, B +1, C +2, D +6 LANDED +1 PARTIAL, E +4, F +2;
the slice ledger below):

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
| window-2a — the user-settings tab family MOUNTS | the appearance/security/secrets/actions-secrets+variables/hooks/keys/applications/organization tab tails (19 routes, 8 modules; the bare `/user/settings` claim extends down the tabs; shared `userSettingsTabPrologue`) — flips the A tabs row PARTIAL | `0c2b151` |
| window-2b — the org blocked-users tab + actions secrets/variables MOUNT | the B remainder row's blocked_users tab + the org actions-tab secrets/variables surfaces (9 routes) | `4f2805f` |
| window-2c — the admin group MOUNTS | `GET|POST /-/admin` (dashboard) + the stats/cron/queue/stacktrace monitor pages + the cron run (7 routes; shared adminPagePrologue, non-admin 404 shell) — flips the A admin row PARTIAL | `e31c0cf` |
| window-2d pass 1 — four repo-settings tabs MOUNT | githooks (list + per-hook edit GET/POST), protected tags (list/create/edit/delete), deploy keys (add/delete), public access (GET+POST over the codeUnitAnonymousRead seam) — 13 routes; flips four E rows LANDED | `b54f709` |
| window-2d pass 2 — the wiki-config settings arm MOUNTS | `GET|POST .../settings/wiki` (enable radios live, external-wiki/branch/delete honest-absence lines) — 2 routes; the E basics row's settings-side arm live | `46e7e68` |
| window-2e (A) — sitemap + the search aux feeds MOUNT | `/sitemap.xml` + the explore repos/users sub-sitemaps (exact literals before the owner/repo parse) + `/repo/search` + `/explore/topics/search` (6 routes) — flips three A rows; idx guards + the API-Viewer bridge fixed forward `c2925f2` | `84996c6` |
| window-2e (C1) — the global inbox MOUNTS | `/issues` + `/pulls` (shared overview loader) + `/milestones` (3 routes, top-level literals before the owner-home arm) — flips three A rows | `a8818c6` |
| window-2e (B1) — the .rss/.atom envelopes MOUNT | `/{owner}.rss|.atom` (one regex-constrained registration over the activity-feeds seam; gorilla-parity content types) — flips the B row | `1a59af0` |
| window-2e (B2) — the repo-scoped aux feeds + fragments MOUNT | issues/search + suggestions, the info/attachments fragments under BOTH families + the attachments uuid alias + content-history/overview, the merge_box fragment, the committed-range files page, the single-commit page at upstream's `/pulls/{index}/commits/{sha}`, activity_author_data + its period tail, the compare .diff/.patch byte feeds (11 routes) — flips five D rows LANDED + the fragments row PARTIAL + the F activity_author_data row | `22599e4` |
| window-2e (C2a) — the wiki family MOUNTS | the `/{owner}/{repo}/wiki[/...]` page family (4 routes, action-dispatch) — flips the F wiki row; UNREACHABLE on arrival, unshadowed `a58cad5`; the pathJoinRelX empty-join service arm `8f766ac` | `9516bf1` |
| window-2e (C2b) — editor tails + cherrypick/patch MOUNT | the delete-confirm page swap (dedicated page render on the delete family), `GET|POST /upload/*` over the dc9ff97 staging family (the write LIVE), `GET|POST /patch/*` + `/cherrypick/*` (8 routes) — flips two C rows; the cherrypick/patch POST arms gained sameOriginGuard `27aa538` | `1d834d6` |
| window-2e (C3a) — the migration page MOUNTS | `GET|POST /repo/migrate` (2 routes; created → 303 the born repo) — flips the A row; the dead shadowing fixed `f60e5a8` | `62ef380` |
| window-2e (C3b) — the subscriptions/watching tails MOUNT | `/notifications/subscriptions` + `/watching` (2 routes) — flips the A row (the POST purge-page arm documented-unrendered) | `5ca1727` |
| window-2e folds — the branch writer arms + pulls/new + the upload endpoints | `POST /branches/_new/*` + `/branches/rename` (the API create + two-step CAS replay), the pulls/new redirect onto /compare, `POST /upload-file` + `/upload-remove` (5 routes; the wave-17 pin flipped) | `635ce2e` |
| window-2f — the nav swap + the SettingsNav fold | the 13-site shared-navbar swap (every page renders the landed nav) + five repo-settings items folded into SettingsNav, the scaffold navs deleted (no row flips; the four repo-settings goldens re-baselined `2c7c05f`) | `94c6851` + `d32db26` |

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
| `GET /explore/topics/search` | web.go:564 | LANDED (aux JSON feed, window-2e A `84996c6` — optSignIn, no gate; the topic-search aux over the landed topics) | landed (topics) | admin | — |
| `GET /sitemap.xml` + explore sitemaps | web.go:530,554,556 | LANDED (window-2e A `84996c6` — exact literals BEFORE the owner/repo parse, else `/explore/repos/sitemap-1.xml` parses owner=explore; the idx guards + the repo-search API-Viewer bridge fixed forward `c2925f2`) | landed | admin | — |
| `GET /issues` (global inbox) | web.go:568 | LANDED (window-2e C1 `a8818c6` — the shared overview loader with type-arm counts, reqSignIn 303, claimed as a top-level literal BEFORE the owner-home arm; the shadowing fixed `f60e5a8`) | landed | authoring | — |
| `GET /pulls` (global) | web.go:572 | LANDED (same mount `a8818c6`) | landed | authoring | — |
| `GET /milestones` (global) | web.go:573 | LANDED (same mount `a8818c6` — the dashboard milestones loader) | landed | authoring | — |
| `GET /user/login` | web.go:577 | LANDED as `/login` (SPEC-0010 divergence) | landed | core | — |
| `GET /user/sign_up` | web.go:595 | ABSENT | partial (no self-serve registration service verified) | core | M |
| `GET /user/settings` (profile) | web.go:634 | LANDED (`pages/user-settings.tsx`) | landed | authoring | — |
| `/user/settings/{account,appearance,security,applications,keys,organization,repos}` | web.go:641-735 | PARTIAL — window-2a MOUNTED the tab family (`0c2b151`, 8 modules, 19 routes: appearance GET + theme/language POSTs, security, actions secrets+variables with full write arms, hooks list/detail/delete, keys, applications with the one-shot newToken banner, organization — SINGULAR wire path per web.go:740 — with leave; shared `userSettingsTabPrologue`, sameOriginGuard-first POSTs). STILL ABSENT: the account and repos tabs and the settings-level notifications tab (no modules) | partial | authoring | S each (the remaining tabs) |
| `GET /notifications` + `/new` + `/status` + `/purge` | web.go:1785,1788-1789,1791 | LANDED (`pages/notifications.tsx`) | landed | authoring | — |
| `/notifications/subscriptions`, `/watching`, `/purge-page` | web.go:1786-1787,1790 | LANDED (window-2e C3b `5ca1727` — the committed module's loaders + one-template render over both GET arms, 8 issue sorts verbatim, facet tri-states; the POST `/purge-page` write arm (web.go:1790) is the group's one unclaimed member, documented-unrendered like the notifications page's own mark_page_as_read) | partial (the purge-page write arm unclaimed) | authoring | — |
| `/-/admin/*` (dashboard, users, repos, orgs, config, monitor, notices, auths, emails, badges, packages, hooks, applications, actions) | web.go:780-906 | PARTIAL — window-2c MOUNTED the admin group (`e31c0cf`, 7 routes: `GET|POST /-/admin` dashboard + the stats/cron/queue/stacktrace monitor pages + the cron run; shared adminPagePrologue — session → anonymous login-303 → non-admin 404 shell per upstream's hidden-surface posture, web.go:779). STILL ABSENT: the users/repos/orgs/config/notices/auths/emails/badges/packages/hooks/applications/actions pages (the actions+packages tabs stay FEATURE-ABSENT-gated) | partial (user/repo lists + most admin ops declared) | admin | M per page |
| `GET /org/create` | web.go:972 | LANDED (`pages/org-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/create` | web.go:1098 | LANDED (`pages/repo-create.tsx`, wave 19) | landed | authoring | — |
| `GET /repo/migrate` | web.go:1100 | LANDED (window-2e C3a `62ef380` — GET+POST over the two-stage module: reqSignIn 303, owner-list load, the mirror-only form, POST → `migrateRepoFromForm`, created → 303 the born repo's home, invalid → inline re-render with the kept submission; the GETs initially dead behind the dynamic block, fixed `f60e5a8`; the API arm's migrate-201 born-body post-attach fix `8a1a03f`) | landed (`services/migrate.ts`) | authoring | — |
| `GET /repo/search` | web.go:1102 | LANDED (aux JSON feed, window-2e A `84996c6` — reqSignIn 303, SearchAuxParamError → plain-text 422 per upstream ctx.HTTPError (never JSON), count_only fast path; registered ahead of the dynamic block `f60e5a8`; the API-Viewer bridge `c2925f2`) | landed | authoring | — |
| `GET /attachments/{uuid}` | web.go:912 | LANDED (`src/web/attachments-serving.ts` mounted in `src/index.ts` before `uiRouter` with the `isAttachmentServing` carve-out — `5e082cd` + `2b5b898`; the full ServeAttachment walk: issue/PR/release linkage, draft arm, scope-check-after-404s, read:issue vs read:repository; Go sniff table + FormatMediaType + httpcache 304s; streaming. Premise corrected vs this row's old text: upstream defaults INLINE for all — the download arm is dead at frozen settings, the CSP sandbox + forced text/plain is the real mechanism. Credential walk corrected `7cd1ce9`: token first, session-cookie fall-through, error-fall-through (the two-arm order per the pinned web group), rotation Set-Cookie re-wrapped on every response, the browser_download_url owner probe added) | landed | authoring | — |
| `GET /avatar/*`, `/user/avatar/*` | web.go:760,775 | LANDED (`src/web/avatar-serving.ts`, mounted `src/index.ts:69` — `/avatars/*` + `/avatar/{hash}` + `/user/avatar/{username}/{size}`; pixel-exact identicon port, default asset via Static Assets `239a4ac`) | landed | core | — |

**A: 24 rows — 19 LANDED, 2 PARTIAL, 3 ABSENT.**

## B. Owner pages (user / org)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET /{username}` (profile or org home, one handler) | web.go:911 | LANDED (`pages/user-profile.tsx` + `pages/org-home.tsx`; the `?tab=activity` arm's page module is committed but UNMOUNTED — `pages/activity-feeds.tsx`, `ec07fb6`: the window consumed its seam + rendering vocabulary into the .rss/.atom envelopes (`1a59af0`), the page render has no caller; the arm is the survey's last S bench row, see In-flight) | landed | core | — |
| `GET /{username}.rss` / `.atom` (handled inside the sub-route) | web.go:909-911 | LANDED (window-2e B1 `1a59af0` — one regex-constrained registration (the owner-home precedent); `resolveActivityFeeds` org-then-user, visibility-gated, renamed 307, missing 404 shell; gorilla-parity bytes with USER_FEED_CONTENT_TYPES) | landed (`repoListActivityFeeds` family declared `2ef9359`, `renderFeedItems` in `api/services/activity-feeds.ts`) | admin | — |
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
| `/{org}/settings/{hooks,applications,blocked_users}` (+ `audit_logs`; the `packages`/`actions` tabs FEATURE-ABSENT) | web.go:1022-1041,1063,1069-1089 | PARTIAL — the hooks tab LANDED MOUNTED (`pages/org-settings-hooks.tsx`, `54264ae`); window-2b MOUNTED the blocked_users tab (`4f2805f` — block/unblock over `applyOrgBlockedForm`, upstream's exact banner texts) AND the actions-tab secrets/variables surfaces (the org twins of the user settings arms, full write sets). STILL ABSENT: the applications/audit_logs tails (no landed org-scope reads, needs-API-first); upstream's `packages`/`actions` management tabs stay FEATURE-ABSENT-gated (our actions-tab surfaces serve org secrets/variables only) | partial (org hooks ops ALL declared — `orgListHooks`/`orgGetHook`/`orgCreateHook`/`orgEditHook`/`orgDeleteHook`; applications/blocked_users/audit tails' org-scope reads: blocked_users LANDED, applications/audit still missing) | authoring | M per remaining tab |
| `GET /org/{org}/settings/labels` | web.go:1043-1049 | LANDED at `/{org}/labels` (documented divergence; the three POST segments ride upstream's literals) | landed | authoring | — |

**B: 18 rows — 11 LANDED, 2 PARTIAL, 5 ABSENT.**

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
| `GET .../_upload/*` | web.go:1462-1464 | LANDED (window-2e C2b `1d834d6` — `GET|POST /upload/*`: `loadEditorUploadData` + the upload page render, the POST wiring `parseUploadForm` → `commitUploadFromForm` (the `dc9ff97` R2-uuid staging family's first consumer; committed → 303 src/branch/{b}, noop → 303 back, invalid → re-render with carried form) + the staging endpoints `POST /upload-file` + `/upload-remove` mounted `635ce2e` — the writer predicate is the entire authorization, upstream's upload store has no repo column) | landed (the `upload-staging` service + editor store) | authoring | — |
| `GET .../_diffpatch/*`, `_cherrypick/{sha}/*` | web.go:1465-1470 | LANDED (window-2e C2b `1d834d6` — `GET|POST /patch/*` + `/cherrypick/*`: the sha-gated cherrypick suffix parse, the ?cherry-pick-type=revert arm, readCherryPickForm/readPatchForm → the commit fns, ApiError texts re-render with kept forms; the POST arms gained sameOriginGuard `27aa538` — the polish program's CSRF catch) | landed (diffpatch + merge machinery) | authoring | — |

**C: 25 rows — 20 LANDED, 2 PARTIAL, 3 ABSENT.**

## D. Issues and pulls

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../issues` | web.go:1347 | LANDED (`pages/issues-list.tsx`) | landed | core | — |
| `GET .../pulls` | web.go:1654 | LANDED (same component) | landed | core | — |
| `GET .../issues/{index}` | web.go:1348 | LANDED (`pages/issue-detail.tsx`) | landed | core | — |
| `GET .../pulls/{index}` | web.go:1656 | LANDED (same component; family-mismatch 303 parity) | landed | core | — |
| `GET .../pulls/{index}.{diff|patch}` | web.go:1657-1658 | LANDED (`pages/diffpatch-files.ts`, wave-29; with-signature per upstream patch.go:26-45) | landed (`diffpatch.ts`) | authoring | — |
| `GET .../pulls/{index}/merge_box` | web.go:1659 | LANDED (window-2e B2 `22599e4` — the committed fragment module `a9ceff3` mounted; null → EMPTY 200 = the bundle's reload stop signal; `findPullRequestByIndex`'s WithIssue pair decomposed) | landed (the merge machinery + PR model) | authoring | — |
| `GET .../pulls/{index}/commits` | web.go:1661-1663 | LANDED (`pages/pull-commits.tsx`, slice `ec7da26`) | landed | authoring | — |
| `GET .../pulls/{index}/files` | web.go:1671 | LANDED (`pages/pull-files.tsx`; the single-commit page mounted at upstream's `/pulls/{index}/commits/{sha}` — `pull-commit-files`, `22599e4` honoring the `b48757e` mount divergence; `/files/{sha}` stays upstream's pattern miss) | landed | authoring | — |
| `GET .../pulls/{index}/files/{a}..{b}` (range) | web.go:1672 | LANDED (window-2e B2 `22599e4` — the committed-range files page over the landed machinery) | landed | authoring | — |
| `GET .../compare[/{base}...{head}]` | web.go:1307-1313 | LANDED (`pages/compare.tsx`; `..` two-dot and fork forms unclaimed — documented divergences) | landed | authoring | — |
| `GET .../compare/*.{diff|patch}` | web.go:1309-1310 | LANDED (window-2e B2 `22599e4` — the byte feeds branched INSIDE comparePage, the page family's registration owning the route; the parser's compare-feed family routes there before the page drift guard) | landed | authoring | — |
| `GET .../pulls/new/*` (redirect) | web.go:1314 | LANDED (the window-2e folds `635ce2e` — the pure redirect onto /compare with query preserved; initially dead behind its own parse claim + a slice(5) mismatch, fixed `3837c17`) | landed | authoring | — |
| `GET .../issues/new` | web.go:1355 | LANDED (`pages/new-issue.tsx`) | landed | authoring | — |
| `GET .../issues/new/choose` (template chooser) | web.go:1357 | ABSENT | partial | authoring | S |
| `GET .../labels` (list page) | web.go:1338 | LANDED (`pages/repo-labels.tsx`, ui-parity-4; live create/edit/delete writes, org section, issues-facet anchors) | landed | authoring | — |
| `GET .../milestones` | web.go:1339 | LANDED (`pages/milestones.tsx`) | landed | authoring | — |
| `GET .../milestone/{id}` (detail: issues+pulls) | web.go:1340 | LANDED (`pages/milestone-detail.tsx`, ui-parity-5; `?state`/`?labels` facets, progress bar, writer gates) | landed | authoring | — |
| `GET .../milestones/{id}/edit` | web.go:1427 | LANDED (`pages/milestone-detail.tsx` edit form, ui-parity-5) | landed | authoring | — |
| `GET .../issues/search` | web.go:1359 | LANDED (aux JSON feed, window-2e B2 `22599e4` — reqSignIn, param errors → plain 422; hoisted above the `/:index` catch `c4a1723` — the fourth dead-route fix) | landed | authoring | — |
| `GET .../{type}/{index}/info|attachments|content-history/*` | web.go:1321-1330 | PARTIAL — window-2e B2 mounted the fragments under BOTH families (`22599e4`): `/info`, `/attachments`, the `/attachments/{uuid}` 302 alias onto the landed site-level seam, and `content-history/overview`. STILL UNCLAIMED: `content-history/list` + `/detail` (no snapshot store — needs-API-first) | partial | authoring | M (the snapshot store) |
| `GET .../comments/{id}/attachments` | web.go:1337 | ABSENT (aux) | partial | authoring | S |
| `GET .../issues/suggestions` | web.go:1341 | LANDED (aux JSON feed, window-2e B2 `22599e4` — optSignIn, raw q untrimmed; hoisted with the search feed `c4a1723`) | landed | authoring | — |

**D: 22 rows — 19 LANDED, 1 PARTIAL, 2 ABSENT.**

## E. Repo settings

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../settings` (basics) | web.go:1185 | LANDED (`pages/settings.tsx`; window-2d pass 2 `46e7e68` mounted the settings-side WIKI-CONFIG arm at `/settings/wiki` — enable radios live-writes hasWiki via the exact PATCH arm, external-wiki/branch-input/delete-modal rendered as honest-absence lines, the dedicated sub-page + nav item is the mirror-panel divergence posture; PREMISE CORRECTED at dispatch: no `wiki.tmpl` at the pin, the surface is `options.tmpl`'s three pieces) | landed | authoring | — |
| `GET .../settings/collaboration` (+write tails) | web.go:1194-1204 | LANDED (`pages/settings-collaboration.tsx`, ui-parity-3 `ca81d5a`; writes over landed services, upstream refusal order, `CanDoerManageOrgRepoCollaborator` port) | landed (`repo-collaborators.ts`) | authoring | — |
| `GET .../settings/branches` (+`/edit`, `/priority`, `/{id}/delete`) | web.go:1207-1213 | LANDED (`pages/branch-protection.tsx`) | landed | authoring | — |
| `GET .../settings/tags` (protected tags) | web.go:1215-1221 | LANDED (window-2d `b54f709` — list with ?id= edit prefill + ?saved=1 flash, POST create, GET+POST /{id} edit, POST delete; RepoMustNotBeArchived rides the POSTs, missing → 404) | landed (protected_tags 0025 + all 5 `repo*TagProtection` ops declared `a80878c`) | authoring | — |
| `GET .../settings/hooks/git` | web.go:1223-1227 | LANDED (window-2d `b54f709` — GET list, GET+POST edit per hook name; hooks/git claimed explicitly beside the numeric hooks/{id} block; ErrNotValidHook → 404 shell) | landed (git hooks: `repoListGitHooks`/`repoGetGitHook`/`repoEditGitHook`/`repoDeleteGitHook` declared `5b704c5`) | admin | — |
| `GET .../settings/hooks` + `/{id}` + `/{type}/new` | web.go:1229-1239 | LANDED (list, generic add form, per-hook page + test/delete; upstream's per-provider `{type}/new` forms ride our generic form — divergence) | landed | authoring | — |
| `GET .../settings/keys` (deploy keys) | web.go:1241-1247 | LANDED (window-2d `b54f709` — GET+POST add with carried form on invalid, POST delete idempotent 303) | landed (deploy keys 0020; `repoListKeys`/`repoCreateKey`/`repoDeleteKey` declared `4af12a9`) | authoring | — |
| `GET .../settings/lfs[/...]` (files, pointers, locks) | web.go:1249-1261 | ABSENT | partial (LFS server landed; pointer-scan queries missing) | authoring | M |
| `GET .../settings/actions*` | web.go:1262-1278 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |
| `GET .../settings/audit_logs` | web.go:1279 | ABSENT | none | admin | L |
| `GET .../settings/mirror` | (upstream renders inside options.tmpl — divergence noted) | LANDED at the literal (`pages/settings.tsx`) | landed | authoring | — |
| `GET .../settings/public_access` | web.go:1191 | LANDED (window-2d `b54f709` — GET+POST over the `codeUnitAnonymousRead` seam: the page and the git-HTTP gate read the SAME value; the conditional Public Access nav item renders on the branches + collaboration tabs `364bf92`) | landed | authoring | — |

**E: 12 rows — 9 LANDED, 0 PARTIAL, 3 ABSENT.**

## F. Repo sub-systems (releases, wiki, activity, social, packages/projects/actions)

| Upstream route | Cite | Status | Data | Demand | Effort |
|---|---|---|---|---|---|
| `GET .../releases` (+`/tag/*`, `/latest`, feeds) | web.go:1505-1514 | LANDED (`pages/releases.tsx`, wave 20) | landed | core | — |
| `GET .../releases/new`, `/edit/*` | web.go:1516-1520 | LANDED (`pages/releases.tsx`; `/new` wave 20, the `/edit/*` form + write and the formaction `/releases/delete` button + list pencil wave-ui-parity-7 `48101dc` — unconditional web-form writes) | landed | authoring | — |
| `GET .../releases/download/{tag}/{file}`, `/releases/attachments/{uuid}` | web.go:1513-1514 | LANDED (`pages/release-downloads.ts`, wave-ui-parity-10 `fdaeaca`; ServeAttachment for the uuid shape + RedirectDownload for the download shape incl. the `latest` alias; sniff/draft/ETag-304/download-count ports) | landed (`release-assets.ts`) | core | — |
| `GET .../fork` (fork form) | web.go:1490 | LANDED (`pages/repo-fork.tsx`, ui-parity-5; owner options over can-create orgs, `createFork` sequence replay; entry points on the forks page) | landed (`createFork` declared) | authoring | — |
| `GET .../wiki[/...]` (+commit/raw/excerpt) | web.go:1611-1625 | LANDED (window-2e C2a `9516bf1` — the page family mounted, 4 routes, action-dispatch; the sub-pages (`_pages`, `_new`, `_revision`) are case-arms inside the wildcard combo's handler per wiki.go:445-462, exactly as this row's VERIFY-FIRST premise required. The family was UNREACHABLE on arrival — the polish program's first dead-route catch: parse + registration order unshadowed `a58cad5`, the wiki matrix 24/24 green after; the service-side pathJoinRelX empty-join arm fixed `8f766ac` (upstream's empty-input answer). The excerpt twin `wiki-blob-excerpt` was already mounted `67adfb7`) | landed (wiki 6 ops declared `d3362b1`, `services/wiki.ts` + the sibling engine cell) | authoring | — |
| `GET .../activity[/{period}]` | web.go:1628-1631 | ABSENT | partial (feed rows landed `2ef9359`; the stats aggregation stays private on the DO) | core | M |
| `GET .../activity/{contributors|code-frequency|recent-commits}[/data]` | web.go:1633-1646 | ABSENT | partial (aggregation private on the DO) | admin | M |
| `GET .../activity_author_data` | web.go:1683-1687 | LANDED (aux JSON feed, window-2e B2 `22599e4` — both the bare and `/:period` shapes) | landed (the feed rows `2ef9359`) | admin | — |
| `GET .../forks` | web.go:1759 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`listForks`) | core | — |
| `GET .../stars` | web.go:1766 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`stars.ts`, `social-lists.ts`) | core | — |
| `GET .../watchers` | web.go:1767 | LANDED (`pages/repo-social.tsx`, ui-parity-3 `ca81d5a`) | landed (`repo-watchers.ts`) | core | — |
| `GET .../packages` | web.go:1538-1542 | ABSENT | none (no packages system — FEATURE-ABSENT) | admin | L |
| `GET .../projects[/...]` | web.go:1544-1563 | LANDED (`ae32b1a` — the full repo-scoped surface: list + board + `/new` + `/{id}/edit` + the workflow tails over the landed store; the `has_projects` unit toggle MODELED — no divergence. Data-note convention: the Hono constraint `:owner/:repo{[^-].*}/projects` — a static second segment does NOT outrank a param in Hono, so the owner-scoped `/-/projects` shapes and these repo-scoped shapes coexist only via the negative-charset constraint; the landing wave discovered+applied it, recorded here so later route work reuses it) | landed (projects store 0024 + all three API scopes declared: repo `fc123b0`, org `20512c0`, user `c9a7ef7` — 64 project ops) | authoring | — |
| `GET .../actions[/...]` | web.go:1566-1608 | ABSENT | none (no Actions — FEATURE-ABSENT) | admin | L |

**F: 14 rows — 10 LANDED, 0 PARTIAL, 4 ABSENT.**

## Totals

**115 rows: 88 LANDED, 7 PARTIAL, 20 ABSENT — zero IN-FLIGHT; the
counted sums cover all 115 rows.** (The window consumed the module
wave — nothing is excluded; the tick-9 correction of the
tick-8 "111 counted" arithmetic slip stands.)

By family (landed/partial/absent): A 19/2/3, B 11/2/5, C 20/2/3, D
19/1/2, E 9/0/3, F 10/0/4. The landed
set now covers every
highest-traffic single page (repo home, file view, commits log, commit
detail, branches — including the writer arms, tags — including the
delete write, issues/PRs lists + details + both PR side tabs + the
merge box + the files range + the single-commit page, compare with its
byte feeds, the pulls/new redirect, releases browse + create + edit +
delete + the download tail, labels, milestone detail/edit, the fork
form, the social lists, the collaboration panel, creation forms AND
the migration form, org members/repositories, the avatar seam, the
attachments seam, the archive download, `load-branches-and-tags`, the
`/-/projects` index AND its board + write group AND its repo-scoped
twin, the `/blob/*` + `/tree/*` redirects with their fetch-action
arms, `tree-list` AND `tree-view`, `branches/list`, the `/render/*`
family, both code-view fragments, the global inboxes, the sitemap
family, the search/topic/issues/suggestions aux feeds, the .rss/.atom
envelopes, the subscriptions/watching tails, the wiki page family,
the editor tails including the LIVE upload write, cherrypick/patch,
all four new repo-settings tabs (protected tags, git hooks, deploy
keys, public access), the settings wiki-config arm, the user-settings
tab family (8 tabs), the org blocked-users + actions tabs, the org
hooks tab, and the admin dashboard + monitor group. The remaining
absence mass concentrates
in (a) small
page slices over fully landed data (`issues/new/choose` template
chooser, `comments/{id}/attachments`, the compare two-dot/fork form
divergences),
(b) needs-API-first tails (the content-history list/detail snapshot
store, the org applications/audit_logs tabs, `settings/lfs` pointer
scans, `/explore/organizations`'s anonymous search arm,
`/user/sign_up`, the org dashboard/issues group),
(c) the owner `/-/`
namespace tails (heatmap/packages stay gated),
(d) the unmounted remainder of mounted groups — the profile
`?tab=activity` page arm (module committed, the last S bench row),
the admin pages beyond the dashboard/monitor group, the user-settings
account/repos/notifications tabs — and
(e) whole subsystems with no data model (actions, packages, audit
logs) or no engine RPC (blame, graph, code search, heatmap) that are
correctly out of the demand-driven phase's reach.

## Recommendation — re-ranked queue by demand-per-effort

This tick the index window mounted the entire unmounted-module wave
(92 routes, fourteen commits — see In-flight) and the polish program
made every mounted page route-proven (52 matrix commits, 18 real bugs
fixed, ~18 stale pins swept): **the tick-10 bench queue landed in its
ENTIRETY — all eight rows — and the dispatchable surface is down to
ONE S row**, with everything else needs-API-first or gated.
`node scripts/check-openapi.mjs` PASS at
HEAD `03f9e82` (490 ops / 298 paths, tier-1 78/78 paths, 129/129 ops)
— no row below needs an API that isn't declared.

### The one dispatchable row

1. **The profile `?tab=activity` page arm** (B, S) — the module is
   COMPLETE and committed (`pages/activity-feeds.tsx`, `ec07fb6`,
   glyphs exacted `f696a21`); what remains is wiring the owner-home
   handler's tab dispatch onto the committed
   `renderActivityFeedsPage`/`loadActivityFeedsData` (the seam
   `resolveActivityFeeds` is already imported for the .rss/.atom
   envelopes, `1a59af0`). One registration + one handler arm + the
   matrix's route-level arms per the process note — the smallest
   dispatchable row on the board, and the survey's last one with
   landed data.

NEEDS-API-FIRST rows (do not dispatch as UI work): the
`content-history/list` + `/detail` fragment arms (no snapshot store),
`/explore/organizations` (web.go:557 — the anonymous visible-org
search arm is missing), `GET /user/sign_up` (no self-serve
registration service), the org dashboard + issues groups
(web.go:982-991 — no org-scope cross-cut reads), `.../settings/lfs`
(pointer-scan queries missing), `.../activity[/{period}]` + the stats
family (the aggregations stay private on the DO), the org settings
applications/audit_logs tabs (no landed org-scope reads), the
user-settings account/repos/notifications tabs, the admin pages
beyond the mounted dashboard/monitor group (users, repos, orgs,
config, notices, auths, emails, badges, packages, hooks,
applications, actions), and `.../comments/{id}/attachments`
(web.go:1337, data partial).
GATED rows (do not dispatch without the feature SPEC): everything
actions/packages (`settings/actions`, `.../actions*`, `.../packages`,
`/{username}/-/packages`, the admin packages/actions tabs, and the org
settings upstream `packages`/`actions` management tabs —
FEATURE-ABSENT APIs per the twin inventory's 64 remaining ops), plus
the no-RPC pages (blame, graph, in-repo/explore/`/-/` code search,
`/{username}/-/heatmap`, audit_logs) — heatmap specifically stays
put: the contribution grid needs a heat aggregation that exists on
neither the engine boundary nor a landed service, so it is
no-RPC-gated like blame/graph, not a dispatchable S-row.
The fragment gates and the machinery window both RETIRE with this
tick: all three fragment gates closed (`831709f`, `67adfb7` twice)
and the module-wave machinery mounted (`0c2b151` through `635ce2e`).
The
`.../raw` + `.../media` web shapes (web.go:1699-1713) stay
PARTIAL-by-divergence — our SSR pages emit tier-1 API raw links
(`links.ts:41`), so the gap only bites official-bundle references and pasted
URLs; close it opportunistically, not as a dedicated goal.
