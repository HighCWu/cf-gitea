# Matrix coverage census — the deferred-matrix polish program's saturation assessment

Written 2026-10-27 by wave-129 (`wave-matrix-census`), at a tree whose committed HEAD is
`97a638b` (polish matrix batch 10) and whose working tree carries sibling-owned batch
11-13 edits (see §2.4). This is the census the program runs BEFORE dispatching batch 14
blindly: what did the port-first mode defer (the denominator), what do the suites pin
now (the numerator), and what is actually left (the gap list, in three classes). The
census exists to prevent both premature stopping and make-work batches.

Method: every number below was read out of the tree, not carried over. Sources:
`docs/compat/ui-parity-survey.md` (tick-14, 116 rows), `docs/compat/api-remaining-inventory.md`
(490/554 declared), `docs/compat/stale-pin-sweep.md`, `docs/testing/suite-stability.md`,
`docs/research/render-wallclock-audit.md`, the module headers' own degradation notes,
and mechanical `grep -cE '^\s*(it|test)\('` counts over every committed `*.test.ts(x)`
under `apps/worker/src` (260 files, 5,175 arms). Arm counts are honest approximations:
`it(`/`test(` call sites, subject-tally numbers cited where the survey already tallied them.

## 1. The denominator — what the port-first mode deferred

### 1.1 The survey's rows (the page-bearing GET denominator)

`ui-parity-survey.md` at tick-14 stands at **116 rows: 91 LANDED, 5 PARTIAL, 20 ABSENT,
zero in flight**. The dispatchable board is EMPTY — the survey's own Recommendation says
exactly this: every row dispatchable as pure UI work over landed data is LANDED; the
remainder is needs-API-first, feature-gated, or no-RPC-gated. The 25 non-LANDED rows,
classified:

- **Needs-API-first (7 ABSENT rows)** — the page needs a read that no landed service
  provides: `/explore/organizations` (no anonymous visible-org search arm),
  `/user/sign_up` (no self-serve registration), the org `dashboard[/{team}]` row, the
  org `issues|pulls|milestones` row (no org-scope cross-cut reads), `.../settings/lfs`
  (pointer-scan queries), `.../activity[/{period}]` and the
  `activity/{contributors|code-frequency|recent-commits}` stats row (aggregations
  private on the DO). The 5 PARTIAL rows carry more of the same class inside them: the
  org settings `applications`/`audit_logs` tabs (no landed org-scope reads), the admin
  pages beyond the mounted dashboard/monitor/listings group (config, notices, auths,
  emails, badges, hooks, applications, actions — most admin *ops* are declared; the
  page reads are not), and the notifications `purge-page` write arm.
- **Feature-gated (4 ABSENT rows)** — everything Actions/Packages: `settings/actions*`,
  `.../actions*`, `.../packages`, `/{username}/-/packages`. (The admin and org-settings
  packages/actions management tabs ride the PARTIAL rows above.) The API twin shows the
  same wall: the raw contract diff is **64 undeclared ops, ALL FEATURE-ABSENT**
  (490/554 declared, 298 paths, tier-1 78/78 paths and 129/129 ops,
  `node scripts/check-openapi.mjs` PASS).
- **No-RPC-gated (7 ABSENT rows)** — the engine boundary has no RPC: blame, graph,
  `/explore/code`, `/{username}/-/code`, in-repo `.../search`, `/{username}/-/heatmap`,
  `settings/audit_logs`. `packages/git-engine/dist-types/repo.d.ts` exposes `listRefs`,
  `readCommit`, `listLog({path,ofs,n})`, `listTree`, `readDiff`, `readBlob` — no grep,
  no blame, no graph. These rows cannot be served, so their only honest matrix posture
  is the 404/unclaimed pin — which several suites already carry.
- **Data-partial S rows (2 ABSENT rows — the only not-obviously-gated ones)**:
  `GET .../issues/new/choose` (the template chooser; needs a repo-file template read)
  and `GET .../comments/{id}/attachments` (the comment-attachment API is landed; the
  fragment page is not). Both are named in §4(a).
- **Divergence-postured PARTIALs (the 5)** — notifications `purge-page` write arm
  (one unclaimed POST), the admin group's absent page list (above), the org settings
  applications/audit tails (above), the `.../raw` + `.../media` web shapes
  (deliberate: our pages emit tier-1 API raw links, `links.ts:41`; "close it
  opportunistically, not as a dedicated goal" per the survey), and the
  `/{org}/teams/{team}` name-vs-id linking divergence.

### 1.2 The deferred-arm mass (what the polish program was deferring)

The port-first endgame (modules → mounts → the mount window `2f7afe9`+`484eb92`) left
every landed page carrying **deferred characterization arms** — behavior shapes the page
renders that no suite pinned. Tick-11's walk alone was "52 matrix/route-arm commits whose
subjects tally 1,170 cases", catching 18 real bugs (four dead routes of one
registration-order class, a CSRF, a global cookie violation, a wire-format divergence,
and a long tail — the process note in the survey). That is the demand the polish
program's numbered batches have been working through.

### 1.3 The module headers' documented degradations (the render-side deferral ledger)

Representative, all read in-tree: `issue-detail.tsx` (reactions/context menus/
comment-header chrome "not rendered"; milestone plain-text per the dead-link rule —
see gap (a1) below; the reduced status-button grant), `releases.tsx` (reactions block,
ahead/behind line, `add_tag_msg`, tag-only + generate-notes buttons unrendered; the
num_releases label skipped), `branches.tsx` (per-branch feed + download-source-archive
buttons unrendered; the archived-row arms), `file-view.tsx` (raw links target the tier-1
API raw route — the raw/media divergence), `org-settings.tsx` (`max_repo_creation`
honest-absent; team `repo_access` radios dead-control-unrendered), `notifications-subscriptions`
(the purge-page POST documented-unrendered), `settings.tsx` (two upstream forms merged
into one POST — `88cbd17`'s disclosed reduction), `tree-view-aux`/fileicon (the dynamic
import boundary — ws1009 posture, do not re-static it). These sections are the census's
render-side deferral ledger; each entry is either pinned by a matrix arm or listed in §4.

## 2. The numerator — what is pinned now

### 2.1 UI suites (matrix + smoke + waves), by survey family

`grep -cE '^\s*(it|test)\('` over `apps/worker/src/ui` (130 test files, **2,737 arms**):

| Family | Files | Arms | Representative suites |
|---|---|---|---|
| A site-level + auth + admin + user-settings | 28 | ~681 | explore 28, dashboard 19, admin users/orgs/repos/monitor 25+12+12+33, user-settings 8 tabs ~320 total, notifications 26+26, session 44, sitemap 8 |
| B owner pages (profile/org) | 16 | ~359 | user-profile 34, org home 22, org members/repos/teams 24+19+27, org settings 21+14+57+39, activity feeds 51, profile tabs 35 |
| C repo code browsing | 11 | ~210 | commits 27, branches 18, tree-view 31, wiki 24+4+5, file editor 19+33+2, render 17, lastcommit 11, migrate 21 |
| D issues + pulls | 16 | ~311 | issues list/detail/new 25+25+12, pulls files 25+1+31, compare 18+15, labels 28, milestones 29+12, aux feeds/fragments 18+28+22+11 |
| E repo settings | 9 | ~270 | basics 30, collaboration 34, mirror 26, tags 75, githooks 33+12, deploy keys 21, public access 13, wiki 26 |
| F repo sub-systems | 6 | ~94 | releases 30+7+7, forks 26, projects 17, tags feed 7 |
| Cross-cutting (router/waves/goldens/a11y) | 44 | ~812 | index/session/manifest 68, `pages-wave*` ×40 ~600, goldens 11, a11y 25 |

Issues family worked example (the mission's format): 5 files, ~114 arms
(`issues.test.ts` 72 + `routes/issue-tables-t2` 42) on the API side, plus the D-family UI
suites above.

### 2.2 API + service suites

`src/api` (incl. `routes/` + `services/` + `compat/`): 77 files, ~1,614 arms,
of which `src/api/routes` 846 (41 files), `src/api/services` 63, and the compatibility
suites (`src/api/compat/`) 43 arms over the frozen contract fixtures;
`src/issues` 33, `src/services` 305, `src/repos` 81,
`src/webhooks` 48, `src/git-http` 45, `src/auth` 118, `src/invariants` 17, `src/lfs` 37,
`src/db` 23. Webhook event coverage is 22/26 wire types fully emitted, 4/26
N/A-feature-absent (`docs/compat/webhook-event-coverage.md`) — zero NOT-EMITTED rows.

### 2.3 Goldens, a11y, probes

- **67 committed goldens** (`src/ui/__tests__/goldens/`: 64 HTML + `releases-feed.rss` +
  `tags-feed.rss` + `user-feed-alice.rss`; plus the session `login.html`). The
  wallclock-audit arc is CLOSED: the route clock seam (`df348c8`) landed the last admin
  golden, the fixed-time wiki writer (`a9fe3b6`) landed the last wallclock skip, and the
  final golden batch (`86d2de7`) + the three feed envelopes (`abd512f`) brought the
  count to 66→67.
- **a11y** sweeps every `GOLDEN_CASES` entry (25 arms) plus the R5/R6 structural net
  (zero bare `th` in real data tables; the thead-less admin tables classified
  structurally per `ff3b4fb`).
- **deploy-probes** (`scripts/deploy-probes.mjs`): 9 batteries (p0, registry,
  generate-e2e, forkpr-e2e, mirror, ui-login, window2-mounts, window3-mounts,
  cleanup-audit), ~91 probe ids — the live-deploy verification layer above the suites.

### 2.4 The polish batches themselves

Committed and numbered: batches 2-10 (`00692c9`, `b98c42e`, `06828bf`, `cc2eee1`,
`b61a5e8`, `3b24651`, `48b5f26`, `3d8b941`, `97a638b`) — **229 deferred arms** by their
own subjects (23+24+23+23+25+27+25+31+28). Batches 11-13 are the sibling-owned edits in
the working tree at census time (~25 test files, ~90 new `it(`/`test(` lines: pull-files,
user-profile, user-settings keys/variables, admin monitor/users, explore, labels,
milestones, org-labels, issue-content-fragments, activity-author-data, plus several API
suites). The earlier unnumbered wave (the ~40 "… deferred matrix — N/N, no real bugs"
commits from `28b71b9` through `9cbd98d`) is the tick-11 tally's bulk. Total program:
**~1,490 subject-tallied matrix/route arms**, of which the live suites carry 2,737
`it(`-level arms (the two counting bases differ; both are reported so neither is
over-claimed).

### 2.5 Yield curve — the saturation signal

The program's own yield is the strongest census datum. Ticks 11-12: 18 real UI bugs
caught across ~1,170 subject-tallied arms (~1 per 65). Ticks 13-14: the matrix batches
add "coverage only — zero product fixes, zero row changes" (the survey's tick-14 words
for batches 6-8; batches 9-10 likewise carry no product fix — their bodies disclose only
folded sibling hunks and one retired RED-witness prose). The defect-per-arm ratio has
fallen from ~1 bug per 65 arms (tick-11) to **zero bugs across the last five committed
batches (136 arms, batches 6-10)**. A characterization program whose last 136 arms
found nothing is sampling a pinned-down surface.

## 3. Template spot-checks — 10 upstream families vs our pins

| # | Upstream family | Shapes it carries | Our posture | Pinned? |
|---|---|---|---|---|
| 1 | `repo/issue/sidebar/milestone_list.tmpl` | the selected milestone is a LINK to `/milestone/{id}` (lines 27/36/49) | **plain text** (`issue-detail.tsx:1006`), rationale "no milestone page" | YES — batch 10 pins the no-link arm, but the rationale is STALE (the page landed ui-parity-5) → gap (a1) |
| 2 | `shared/reactions.tmpl` (+ its 5 consumers) | reaction badges + counts, picker gated `and $allowed ctx.IsSigned (not archived)` | unrendered; `issue-t2` has the reactions API landed | YES as negatives (issue-detail matrix pins render-nothing) — the API-over-UI gap is real but web-write shapes are JS islands upstream (§2.5 reduction class) |
| 3 | `repo/view_file.tmpl` | `?display=source\|rendered` toggle, unicode-escape prompt, file_info block, copy-content disabled arm | variant auto-classified, query ignored; copy + line counts landed | **NO pin on the query** → gap (a3); escape prompt unrendered-unpinned |
| 4 | `repo/commits_table.tmpl` | keyword-search box + dropdown, follow-rename checkbox, diff-compare header, signature badges | list + `?path=` + pager landed; search unrendered (engine `listLog` has no grep) | **NO** — commits.matrix has zero arms on search/follow-rename/sign badges → gap (a3) |
| 5 | `repo/branch/list.tmpl` | divergence bar, Included badge, compare arms, latest-PR link, deleted-branch row, writer pair | fully ported (`branches.tsx` header) | YES — branches.matrix pins all the named arms incl. the 0/0 NaN posture; feed/archive buttons documented-unrendered, absence pin minor-missing |
| 6 | `repo/release/list.tmpl` | attachments rows, external-link flag, reactions, count | attachments + edit pencil + delete landed; reactions/ahead-line unrendered (documented) | YES — batch 10 pins the attachment-row bytes; absences documented in the module header |
| 7 | `home.tmpl` (dashboard) | activity feed + repo list + collaboration placeholders | landed | YES — dashboard.matrix 19 + goldens |
| 8 | `explore/*` | repo_list, users, orgs | repos/users landed; orgs ABSENT (needs-API-first) | YES — explore.matrix 28 + both goldens; orgs absence pinned as unclaimed |
| 9 | `org/team.tmpl` + team detail | members + repositories + name-keyed links | landed id-keyed (documented divergence) | YES — org-team-detail golden + org-teams.matrix 27 |
| 10 | `repo/diff/{box,stats}.tmpl` (via pulls/files) | stats bar, BIN mark, split view, whitespace family | stats + BIN landed; split/whitespace documented-not-honored | YES — pull-files.matrix 25 + batch 9's BINARM world pins the degraded bodies |

Spot-check yield: 7 of 10 families are pinned to the shape level; the three finds
(reactions-API/UI posture, `display=` query, commits search chrome) feed §4.

## 4. The gap list — three classes

### (a) REAL gaps worth work

The list is SHORT. One coherent batch covers it, plus four named new-surface slices
that sit outside the matrix program's charter but are the only dispatchable UI work
left anywhere:

1. **(a1) The issue sidebar milestone divergence + its stale rationale.** Upstream links
   the selected milestone to `/{owner}/{repo}/milestone/{id}`
   (`gitea/templates/repo/issue/sidebar/milestone_list.tmpl:49`); ours renders plain text
   (`src/ui/pages/issue-detail.tsx:1006`) and the header note (lines 68-69, 910) still
   argues "no milestone page; the dead-link rule wins" — but `milestone/{id}` LANDED at
   ui-parity-5 (`ca4eb58`) and has its own matrix + golden. Fix: emit the link, flip the
   two stale notes, flip batch 10's no-link arm to the link shape. One commit, 2-3 arms.
2. **(a2) Stale degradation notes.** The same header's line ~119 lists content history
   among the "not rendered" chrome — the content-history list/detail fragments LANDED
   (`cced424` + the window mount). Sweep the module headers' degradation sections
   against what landed since they were written (issue-detail is the known case; verify
   the peers at dispatch). Docs + arm-comment flips only.
3. **(a3) Absence pins for never-pinned upstream chrome.** Three shapes are unrendered
   AND unpinned — the exact class the dead-route lesson says is dangerous:
   - the commits page's search box + follow-rename checkbox + signature badges
     (`commits_table.tmpl:29-40`; engine-gated — the pin documents that the absence is
     permanent until an engine grep RPC exists);
   - the file view's `?display=source|rendered` query (`view_file.tmpl:41-44`) — ours
     ignores it; pin that the query is a no-op so a later refactor cannot silently
     half-honor it;
   - the branches page's per-branch feed/archive buttons (documented in `branches.tsx`
     lines 170-172; give the matrix one explicit absence arm).
4. **Three S tails over landed/partial data** (new-surface slices, one wave each — the
   survey's own last no-gate candidates; NOT matrix-arm work):
   - `GET .../comments/{id}/attachments` fragment (web.go:1337 — the comment-attachment
     API is landed; the fragment page is not);
   - `GET .../issues/new/choose` template chooser (web.go:1357 — `readBlob` over the
     known template paths, honest-absence lines when the repo has none);
   - the notifications subscriptions `purge-page` POST write arm (web.go:1790 — the
     store landed with the subscriptions tab).
5. **The compare two-dot + fork-form claim** — upstream SERVES `compare/{base}..{head}`
   and the `{owner}/{repo}:{head}` fork forms (web.go:1307-1313); we 404 them by
   documented divergence and the matrix pins that contract
   (`compare.matrix.test.tsx:285,574`). This is the one remaining place where upstream
   renders a real page family and we render nothing. It is an M slice (cross-repo
   compare rides the fork head-repo machinery `services/pulls-head-repo` already has),
   needs a deliberate decision, and should not be dispatched as an arm batch.

**Batch list: exactly ONE more matrix batch (batch 14)** = (a1) + (a2) + (a3): the
milestone link fix, the stale-note sweep, and the three absence-pin sets. Estimated
10-20 arms plus 2-3 product/comment flips. After it, the matrix program is SATURATED:
every landed page's rendered shapes are pinned, the yield curve says the remaining
deferred-arm pool is empty, and items (a4)/(a5) are new-surface decisions, not
characterization.

### (b) Unlanded-surface negatives — nothing more to do

Every ABSENT/PARTIAL survey row's negative posture is already pinned or is a
one-arm-formality of no information value: the unclaimed routes 404 through the
engine-owned shell, and the suites already carry parse-level "does not claim" tables
(`index.test.ts`'s it.each table, the wave suites' `toBeNull()` pins — audited
mechanically by the stale-pin sweep: 243 negative literals + 122 boolean pins
evaluated against the live parser, five stale pins found and swept `04d80b3`, nothing
else contradicts the parser). Re-pinning an unlanded feature's 404 a second time in a
second suite is make-work. The needs-API-first and feature-gated rows return only when
their API/feature lands — at which point the survey row, not a matrix batch, is the
dispatch vehicle.

### (c) Unseedable / unpinnable — cited, and now discharged

- **Wallclock class**: `docs/research/render-wallclock-audit.md` classified every
  render-path clock site; classes (a)/(b) got seams, class (c) (clocks stamped into
  STORED objects — wiki commits, merge commits) got the fixed-time wiki writer
  (`a9fe3b6`) and the route clock (`df348c8`, 7 rendered-byte call sites, 20 write-path
  stamps deliberately left). The audit's own "Golden surfaces this unlocks" list is now
  fully landed — 67 goldens, zero skips. **The class is empty.**
- **Storage-contract class**: rendered bytes that depend on stored rows are pinned via
  direct D1 seeds with fixed stamps (the goldens' `T0` fixtures; the audit's
  "(a-via-seeds)" class — "goldens seed D1 directly with fixed stamps, so these never
  block"). The one stored-object holdout (wiki commit stamps) was the (c) case above,
  now closed. Remaining write-path stamps (20 sites named by the route-clock commit)
  are JSON/metadata that no current golden reads — pinning them would pin nothing.
- **Suite-infrastructure class**: the ws1009 full-suite instability is structural and
  upstream-filed (cloudflare/workers-sdk#16515); the composite gate (`pnpm test:full`,
  `scripts/full-suite-gate.mjs`, ADR-0006) is the standing verdict
  (`docs/testing/suite-stability.md`). Solo-mode immunity is proven; batch re-runs never
  converge (measured). No matrix arm can fix this; no matrix arm needs to.

## 5. Verdict

**ONE more batch (batch 14), then SATURATED.**

- Batch 14 is concrete and small: gap (a1) the sidebar-milestone link fix + its stale
  notes and arm flip; (a2) the degradation-note sweep; (a3) the three absence-pin sets
  (commits search chrome, the file-view `display=` query, the branches feed/archive
  buttons). Do not dispatch batch 15.
- The three S tails in (a4) and the compare claim in (a5) are new-surface slices —
  they belong to the ui-parity/dispatch lane (with a SPEC for the compare claim), not
  to the matrix program. If the program's charter is read to include them, they are at
  most three single slices; they do not reopen the arm pipeline.
- The broader honesty statement: the deferred mass that remains — 20 ABSENT + 4 of the
  5 PARTIAL survey rows and the API twin's 64 undeclared ops — is not unpinned
  carelessness; it is gated on features, APIs, and engine RPCs that do not exist, and
  the suites already pin those surfaces' absence. The program's yield curve (zero real
  findings across the last 159 committed arms) and this census's spot-checks agree:
  the surface is pinned to the shape level everywhere it can be, the two audits that
  defined "unpinnable" have both closed their last items, and the only real defects
  left in the tree are the five named in class (a).
