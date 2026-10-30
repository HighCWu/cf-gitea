# Residual backlog — v1.3.2 candidates

Generated at HEAD `849add4`, in the v1.3 freeze window (2026-10-30). This file
consolidates the open items that v1.3's closing documents carry scattered:
the release notes' §4 (`docs/RELEASE-NOTES-v1.3.md`), the SPEC index's
still-open clauses (`specs/README.md`), the ui-parity survey's tick-21
remaining set (`docs/compat/ui-parity-survey.md`), the act_runner smoke's
findings (`docs/research/act-runner-smoke-2026-10-30.md`), and the small
flagged reductions recorded in landed page modules. It is a dispatch board,
not a decision record: every item cites its source, nothing here ratifies a
new design, and items gated on a SPEC say so.

**Updated at the v1.3.1 convergence snapshot `e4b9f66`** (2026-10-30, the
post-v1.3-tag wave recorded in `docs/RELEASE-NOTES-v1.3.1.md`): the six
parity reviews' and the link crawl's newly-known-open items are folded into
the board below. The wave's own landed fixes are NOT residuals — where a
v1.3.1 commit closed a piece of an item, the item says so. The freeze-time
in-flight block below is resolved: the user settings packages twin and the
signed-URL preview-tail golden (with its route-clock seam) both landed in
`74df9ad`, and the survey edit landed in the v1.3 final window.

**Updated at the post-v1.3.1 parity-wave snapshot `95cdcaf`** (2026-10-30,
the window since `0fdc267`): the doc-time in-flight block that lived here
is RESOLVED — every row landed inside the window, each landing verified
at its hash (see the landed record below) — and the window's
newly-recorded open items (the commit bodies' documented divergences,
staged arms, and follow-ups) are folded into the board as new rows, under
a fresh, much smaller in-flight block.

**In flight at this update** (snapshot `95cdcaf`; sibling units are
landing these as you read this — do not re-dispatch blindly, do not count
as landed until committed):

- **The ~15 model.ts cite renumbers** — the mechanical upstream-cite
  drift from `e4b9f66`'s insertions, the cite-audit pass's open finding
  (`ae1de6d`) — sibling in flight (the working tree's uncommitted
  `models/issue.ts` hunks).
- **The E9 deferral record** — review-api E9's two drifts
  (comment-create's missing locked-issue 403 gate + the accepted empty
  body; the P2-6(e) honorable mentions) — sibling in flight right now.
- **The archive POST-arm pin unit** — the verification record's
  coverage-gap finding: `4e6d1cc`'s HIGH-parity archive POST fix has ZERO
  pins anywhere (the GET arm is well pinned) — the pin unit is dispatched
  (`635a573`).

Landed in the same window, for the record (no longer open): the
production serializer-identity swap — `GET /user` now delegates to the
canonical converter shape (`cf269f4`), closing review-api drift 1; the
`username` compat key (drift 2, same commit); the branch list order
(drift 8, `7f9241e`).

Landed in the window since `0fdc267`, resolving the doc-time block and
its board mirrors (no longer open): the topics/licenses converter swap +
the identities swap + the counts seam's serializer half (`58283bd`), the
`GET /users/{username}` counts wiring (`40120ae`) and its no-binding
degrade (`9f883d0`), the issue/pull unit gates (`ddf3b2a`), the packages
D-4/D-5/D-6 batch (`41eada6`), the release sha tail (`efd1916`) completed
by the UpdateRelease port (`29ecd1d`), repoEdit's merge-config fields +
the assigned_by service half (`7047639`) with the assigned_by route
wiring (`4f8ade7`), the LFS locking family (`7b589c7`), archive
export-ignore + zip DEFLATE (`5365236`), the pypi multipart mojibake
(`2757a9e`), and the LFS batch/upload/verify envelope trailing-newline
reconciliation (`95cdcaf` — the locks wave's recorded INFO, fixed in the
same window that recorded it); the `/install` first-admin window had
already been fixed at `16a63b6` (humans-not-rows — P3-5c records it).
The window's verification record (`635a573` — 98 suites, 2,551 results,
all green, pinned at `29ecd1d`) rides alongside; its coverage gaps are
board rows now.

---

## P1 — feature completion

1. **The M3 trigger chain (SPEC-0012), staged behind Open question 1.**
   Without M3 the Actions control plane has no automatic producer — runs
   arrive only through the test-harness insertion seams
   (`specs/0012-actions-feasibility.md` §3 and the still-open list at §7's
   as-built tail; `specs/README.md` SPEC-0012 row; release notes §4).
   Scope per the SPEC's milestone table: the notifier census §2.9 wired to
   the `onPush`/create/delete seams via repo-tasks messages, workflow
   detection + matchers, the YAML model port, `InsertRun` + run numbering,
   the job emitter + max-parallel + concurrency, commit statuses (+ the
   skipped-status arm), `[skip ci]`, cycle break. **OQ-1 sits in front of
   all of it** (§8.1): upstream evaluates `if:`/concurrency/matrix
   expressions with actionslib's Go `expreval`/`exprparser` — no JS
   equivalent; the candidates (hand-ported subset with visible insert-time
   rejection / full library port / WASM) are recorded, (a) is the working
   proposal, and the decision is explicitly deferred to M3's opening — this
   backlog carries the question forward, it does not resolve it. Closes the
   guide's honest limit #1 ("nothing watches pushes, PRs, or releases",
   `docs/guide/actions-runners.md` §4) and, per the smoke's finding 1, the
   M3 spec must carry the **runs-on/PickPlatform trap note**: the claim
   payload's `runs-on:` drives the runner's image pick, so seeded or
   M3-parsed payloads must carry it or runners fall back to a multi-GB
   ubuntu pull (`docs/research/act-runner-smoke-2026-10-30.md` §5.1 —
   "M3's parser closes the trap"). **v1.3.1 amendment** (`e4b9f66`, the
   module header's disclosed stage): the always-on sweeps (endless tasks,
   abandoned jobs, ephemeral-runner cleanup) and the cancel mapping
   LANDED in v1.3.1, shrinking this item's sweep scope to zero — but the
   **notify/commit-status tails and the reusable-caller cascade** are
   explicitly staged to M3 (no v1 row carries parent_job_id>0), so the
   SPEC's M3 table gains them as named rows. Size: **L**.

2. **C5's run-mutation remainder: rerun + rerun-failed** (the cancel arm
   landed inside C2's window). Rerun creates a new `ActionRunAttempt` and
   re-emits job rows — emitter territory, so the census flagged it to
   M3 (`docs/research/actions-ui-census.md` C5 row and open question 1;
   `specs/0012-actions-feasibility.md` still-open list: "C5's rerun +
   rerun-failed DEFER to M3's job emitter"). Every M1c census unit is
   landed except this and C10. **v1.3.1 addition**: the actions review's
   lower-ranked "rerun artifact inheritance latent" observation
   (`docs/usability/parity-review-actions.md`) belongs to the same
   emitter work — a rerun's artifacts must resolve to the new attempt.
   Size: **M**, gated on item 1.

3. **C10's scoped-workflows pages and their substrate.** Upstream's
   `action_scoped_workflow_source` store + workflow-file parser do not
   exist here, so the admin scoped-workflows page is the documented-reduced
   honest 404 with the nav item omitted (`b5923ed`, recorded in release
   notes §4), and the user/org sub-tabs are recorded reductions (survey
   tick-21). The census defers the pages to "the scoped-workflows
   SPEC-attachment (post-M3)" (`docs/research/actions-ui-census.md` C10
   row). Related honest note: the ActionsConfig store carries
   `DisabledWorkflows`/`DisabledScopedWorkflows` for round-trip fidelity
   but has no write arms for them — "their write arms are the workflow-list
   pages, not this store's settings arms"
   (`apps/worker/src/services/actions/config.ts:14-16`). Size: **L**
   (store + parser + pages; needs its SPEC-attachment first).

4. **The admin auths row — needs-API-first, verdict tension recorded.**
   The survey's ONE remaining PARTIAL row: no admin login-source read
   family is declared, so the page cannot be dispatched as UI work
   (`docs/compat/ui-parity-survey.md` tick-20/tick-21 remaining-set
   paragraphs; the recommendation section: "NEEDS-API-FIRST rows ... the
   admin auths page"). SPEC-0018 §3.3's standing verdict is OMIT —
   "no page, no store" with an explicit reopen gate ("superseded the day a
   SPEC lands any external login chain"), because no login-source substrate
   exists and a 100%-posture page fails the dead-link rule
   (`specs/0018-admin-config-notices-auths.md` §3.3; the omission also
   recorded in `specs/README.md`'s SPEC-0018 row). No new decision here:
   either the verdict stands (zero work; the row stays the recorded
   divergence) or a future login-source SPEC reopens it — and that SPEC is
   the prerequisite, which is what makes this needs-API-first. Size: **L**
   if reopened; **S** to leave as documented divergence.

5. **SPEC-0016 M6 — the container (OCI) registry.** The seventh protocol
   family, and "the only milestone that may need new infrastructure
   posture": JWT token flow, chunked blob uploads with an upload-state
   machine (the pre-read question — R2 multipart-upload handles vs a D1
   upload-rows model — is explicitly deferred to the M6 SPEC-attachment),
   manifests, `PropertyDigest` file properties, GC-aware deletes
   (`specs/0016-packages.md` §7 M6 + §8.6; `specs/README.md` SPEC-0016 row:
   "M6 container + M7 index-builder pending"). Size: **L**.

6. **SPEC-0016 M7 — the index-builder family** (debian/alpine/rpm/arch
   metadata index renders; cargo LAST — the git-backed `_cargo_index` repo
   needs the owner-scoped files-service write path). Demand-driven, "size L
   each" (`specs/0016-packages.md` §7 M7). The landed org packages page
   already renders the cargo honest-absence and does not route cargo's
   initialize/rebuild tails for exactly this reason
   (`apps/worker/src/ui/pages/org-settings-packages.tsx` header note +
   documented-reductions section; the omission recorded in
   `specs/README.md`'s 0016 row and commit `6bf9c17`). Size: **L** each,
   demand-gated.

7. **The `/api/v1` Actions registry-management ops — the 54
   FEATURE-ABSENT contract operations.** The declared contract stands at
   500/554 ops and "the remaining 54 FEATURE-ABSENT operations are Actions
   only" — M1a/M1b landed the `/api/actions` + `/api/actions_pipeline`
   wire, not the `/api/v1` family (`docs/RELEASE-NOTES-v1.3.md` §3;
   `specs/README.md` tier-2 paragraph). The surface is drawn in
   `specs/0012-actions-feasibility.md` §2.8 (secrets/variables/runners/
   registration-token/runs/jobs listing at repo+org+user scopes, the
   workflows enable/disable + dispatches extras, the job-logs endpoint) and
   the underlying stores all exist (secrets, action_variables, runners —
   the UI settings pages serve over them today). Landing it converts the
   count to terminal and unblocks API-first clients. Size: **M**.

## P2 — parity polish

1. **The user actions settings group's remaining sub-tabs**: the bare
   `/user/settings/actions` redirect and the general page (upstream
   `web.go:721-732`); scoped-workflows rides P1 item 3. Runners joined
   secrets/variables at `72af05a`, so the group serves today — these two
   pieces are the recorded reduction named at tick-21
   (`docs/compat/ui-parity-survey.md` tick-21 paragraph and the remaining
   set at the recommendation section). Polish-class only: "recorded
   reductions inside LANDED rows ... polish-class only if a future
   dispatch wants them" (same source). Size: **S**.

2. **The org actions settings tab's remaining pieces**: the general page +
   bare redirect + scoped-workflows, the recorded reduction inside the
   LANDED B settings row — the org tab serves secrets/variables and
   runners (`3ab7532`) today (`docs/compat/ui-parity-survey.md` B row,
   line-level note; tick-21 remaining set). The general page is the C9
   page's org twin; scoped-workflows rides P1 item 3. Size: **S**.

3. **The admin scoped-workflows page** (listed for traceability; consumed
   by P1 item 3): the honest 404 with the omitted nav item is the
   documented reduction from the admin actions tails landing (`b5923ed`,
   `92d2e87`'s stale-pin fixes keep it as the negative pin)
   (`docs/RELEASE-NOTES-v1.3.md` §4; `docs/compat/ui-parity-survey.md`
   tick-20 note "scoped-workflows is the documented-reduced honest 404").
   No standalone work — see item P1-3. Size: — (rides P1-3).

4. **Wiki unit gating — the standing out-of-scale divergence.** The wiki
   API, its git-HTTP twin, and the web-UI family treat every repo as
   wiki-enabled: "the landed API layer consults no `repo_units` rows yet;
   every repo is treated wiki-enabled (the landed convention)"
   (`specs/wiki.md` §1; the divergence documented at the twin's landing,
   `specs/README.md` wiki row: "unit gating is the remaining future
   batch"). Upstream gates on `mustEnableUnit(unit.TypeWiki)`
   (`specs/wiki.md` §1, `api.go:1391` cite). Matters because the
   `repo_units` infrastructure now exists (the actions/packages units write
   it in lockstep — `specs/README.md` SPEC-0012 row, `c1cefaa`), so the
   gate's substrate is no longer missing; still out-of-scale for a polish
   wave (touches API + git-HTTP + web-UI layers). Size: **M**.

5. **The archived-release release-create arm keeps 201** (`6b2bedc`'s
   disclosed divergence): upstream's create handler maps the
   archived-repo failure to a bare 500 (`release.go:283`'s posture);
   the pinned posture here keeps the 201. Recorded as a deliberate
   divergence, listed so a future parity pass either ports the 500 arm or
   re-affirms ours in SPEC-0004 §2.3. Size: **S** (decision + one arm).

6. **The review-api semantic-drift remainder** — what the post-v1.3.1
   wave did not close (source: `docs/usability/parity-review-api.md`
   Top-10 + honorable mentions; drifts 1/2/8 landed in v1.3.1 — see the
   header note; drifts 3/4/10 and the single-repo half of 9 landed in the
   window since `0fdc267` — see the header note): (a) drift 5's repoEdit
   merge flags LANDED (`7047639` — the fifteen fields merge over the
   settings overlay, `has_pull_requests:false` deletes the row, the
   update-style trio 400s verbatim) with one accepted-and-ignored
   remainder: `has_code` stays a no-op because it needs the
   creation-seeded code unit row (the loader is ready); (b) drift 6's
   `assigned_by` half LANDED (`7047639`'s service filter + `4f8ade7`'s
   wiring on both list arms) — sibling `mentioned_by` still has no
   mention data (the resolved no-rows sentinel); (c) the single-PR GET
   omits `additions`/`deletions`/`changed_files`, and `review_comments`
   never emits (drift 7); (d) `/repos/search` and the list paths keep the
   query-flat sync render — fork `parent` omitted, mirror schedule
   zeroed, no topics/licenses (drift 9's list half); (e) honorable
   mentions kept on the ledger: `mergeable: null` while checking,
   review-list `X-Total-Count` counts only visible rows, transfer 202 vs
   201, auto-init repos missing `gitignores`/`license` files, user email
   never rendered (upstream's noreply placeholder), comment-create
   accepts an empty body and misses the locked-issue 403 (E9 — the
   in-flight deferral), annotated tag `message` always empty (see
   P3-11), `default_branch`'s gate updated by `7047639`: an unknown
   target on a non-empty repo now silently KEEPS the old default and read
   errors degrade to skip where upstream 500s (the house
   never-fail-the-write posture, documented). Sizes: **S–M** each; the
   whole remainder is a dispatchable batch.

7. **The review-webui rendering remainder** — source:
   `docs/usability/parity-review-webui.md` top-drifts list; the New-PR
   button, empty-repo anon arm, branches order, and collaborator grants
   LANDED in v1.3.1 (`d52361b`, `56df8a6`, `7f9241e`). Still open:
   the branch selector as a bare Fomantic dropdown where upstream is the
   `initRepoBranchTagSelector` Vue island (~20 data attrs — affects
   home/file-view/commits); the repo home right row lacks
   Go-to-file/New-PR/Add-File; the issues list lacks the `#issue-filters`
   skeleton + Labels/Milestones buttons (their pages exist); the merge box
   lacks `initRepoPullMergeBox` and renders nothing closed; issue-detail
   timeline `event-{id}` on both div and anchor (upstream splits
   `issuecomment-{id}`/`event-{id}`); releases omit Source Code archives
   although `/archive` serves (stale reduction — partially related to the
   POST arm `4e6d1cc` mounted); the header's Issues tab misses
   `octicon-issue-opened` and the admin Settings tab is absent although
   settings pages landed. Sizes: **S** each except the two Vue islands
   (**M**).

8. **The review-git protocol remainder** — source:
   `docs/usability/parity-review-git.md`; the archive POST arm and the
   GCM realm LANDED in v1.3.1 (`4e6d1cc`, `85fa2ff`); the LFS locking
   family and the archive attribute semantics LANDED in the window since
   `0fdc267` (`7b589c7`'s four-route family + the D1-race-safe unique
   index; `5365236`'s export-ignore + zip STORE→DEFLATE). Still open
   (engine-scope items separated in the review): receive-pack caps lack
   atomic/push-options/report-status-v2; export-subst stays parsed but
   not substituted in archives — blobs stream byte-identical with
   `$Format:…$` literals surviving, and `[attr]`-macro patterns sit
   outside the compiled matcher subset — the engine-side expansion is the
   recorded future arm (`5365236`); protocol-v2 lacks fetch=filter
   (partial clone fatal) and ls-refs=unborn; the ladder-ordering drifts
   (403-before-auth arms, the wiki-doesn't-exist pkt-line, dumb-HTTP
   absent — documented). Sizes: **M** each; several are engine-boundary
   decisions first.

9. **The review-packages D-4/D-5/D-6 tail — LANDED (`41eada6`).** D-4's
   nuget service-index trio serves unauthenticated (the `none` protocol
   mode), D-5's three quota 403 sentinels byte-match upstream, D-6's
   serve-content port carries the whole cache/nosniff/CSP/Accept-Ranges/
   304/filename* set (`docs/usability/parity-review-packages.md` fix-order
   tail; D-1/D-2/D-3 landed `3571fe8`). Kept on the ledger from the same
   landing: multi-range requests answer a full 200 where Go answers
   multipart/byteranges — the documented divergence (upstream's own
   ServeUserContentByReader takes the same minimal posture). Size: **S**
   if the multi-range arm is ever dispatched.

10. **Amendment to item 7 (the review-webui remainder) — the two named
    Vue-scope drifts landed in the convergence tail (2026-10-30), read
    item 7's other rows as still open.** (a) The merge box: the
    conversation page now renders the FULL upstream card — the landed
    `pull-merge-box.tsx` fragment rendered INLINE via a loader-level
    `loadPullMergeBoxData` call (`PullMergeBoxFragment` exported beside
    `pullMergeBoxFragmentHtml`, byte-identical by construction; upstream
    view_content.tmpl:67-72) — so `initRepoPullMergeBox` is armed and
    closed-unmerged PRs get the ClosedInfo pair (the residual's "renders
    nothing closed" half). Still open from that row: the merge FORM and
    the delete/update-branch buttons remain write-action deferrals (the
    fragment module's own documented reduction set). (b) The branch
    selector: the island container (`branch_dropdown.tmpl`'s
    `data-global-init="initRepoBranchTagSelector"` + the ~20 attrs + the
    pre-mount dummy) replaced the bare Fomantic dropdown — the menu (tab
    strip, filter, view-all) is the official bundle's client-DOM render
    fed by the landed `/branches/list` + `/tags/list` aux feeds. Two
    attrs stay "false"/empty as documented reductions pending call-site
    threading: `data-allow-create-new-ref` (no writer signal at the
    call sites) and `data-enable-feed` (no `/rss/branch` route), and
    `data-current-repo-default-branch` stays empty (no default-branch
    input — the menu's "default" label degrades off). Item 7's OTHER
    rows (Go-to-file/Add-File home row, `#issue-filters` skeleton,
    timeline `event-{id}` anchor split, releases Source-Code archive
    rows, header tab strip icons/Settings tab) remain open as written.

11. **Amendment to item 7 — the timeline anchor split, the issues/pulls
    rows, and the header tab strip LANDED in the v1.3.2 window
    (2026-10-30); item 7's other rows stay open as written.** (a) The
    timeline id split (top-drift 4): every `div.timeline-item.event` now
    carries `issuecomment-{id}` (HashTag, comment.go:553-561 —
    comments.tmpl:81/94/107) while the inner time anchor keeps
    `event-{id}` (EventTag, the locale strings' `<a id="%[1]s"
    href="#%[1]s">` embed, locale_en-US.json:1558-1559/1903-1904) — the
    duplicate-id invalid DOM is gone and `#issuecomment-N` deep links
    into events work; the merge event (type 28, comments.tmpl:107-116)
    additionally links the sha as `.ui.sha` over
    `{repoLink}/commit/{sha}` (ShortSha's 10-rune truncate, tool.go:31)
    and keeps its time PLAIN — the matrix's old "merge line carries the
    #event anchor" pin carried a premise the pin's own template refutes
    (the merge locale sentence formats no anchor), corrected in the
    same window. (b) The issues/pulls rows: PR rows render the upstream
    `.branches` pair (issuelist.tmpl:78-96 — base + the 12px
    `gitea-double-chevron-left` + head, each a
    `/src/branch/{PathEscapeSegments}` link with `truncated-name`
    spans; both hrefs against this repo — no forks, so upstream's
    cross-repo `OwnerName:` prefix arm is dead), the branch pair riding
    the loader's existing batched PR read (optional fields — the
    sibling row-builders' posture unchanged), and the row milestone is
    the upstream LINK (issuelist.tmpl:98-104 — `/milestone/{id}` +
    14px `octicon-milestone` + `gt-ellipsis`; the module header's
    "no milestone page" reduction was stale — the page landed ca4eb58).
    (c) The header tab strip (Top-10 #10): the Issues tab carries
    `octicon-issue-opened` (header.tmpl:105 — the text-degradation note
    retired; the glyph was granted with wave 4's multi-path Icon), the
    projects tab renders upstream's own `octicon-project`
    (header.tmpl:150 — the symlink glyph stays on the org/projects
    PAGES, project.go:161-166's own choice), and the admin Settings tab
    landed (header.tmpl:184-190 — `item-flex-space` + `octicon-tools`,
    active via the settings pages' shared `repository settings*`
    pageClass, upstream .PageIsRepoSettings), gated on the static first
    arm of `isRepositoryAdmin` (site admin + case-folded owner,
    repository.ts:120-122) — the D1 arms (admin-mode collaborator,
    Owners-team bridge) need the ctx grant this sync shell cannot pay
    (the viewerCanCreatePull disclosure; those viewers keep the routes,
    the settingsGate prologue admits them). The cf-gitea "Created
    \<date\>" secondary-info retired (no upstream analog at any pin).
    Icons: the generator allowlist gained `octicon-project`,
    `octicon-tools`, `gitea-double-chevron-left` (the first gitea-
    namespaced glyph; 73 entries). Goldens regenerated via the sentinel
    (41 files, token deltas = exactly the five shapes above). Still
    open from item 7, unchanged: the Go-to-file/Add-File home row
    (pages/home.tsx), the `#issue-filters` toolbar skeleton + the
    Labels/Milestones buttons (list.tmpl:25-56 — the New buttons are
    in, the wrapper/checkboxes/filters are not), the releases
    Source-Code archive rows (pages/releases.tsx), and the Code tab's
    ref-preserving href (header.tmpl:100-101 — needs the current
    BranchName/RefTypeNameSubURL threaded through the ui/index.ts ctx
    assembly).

## P3 — hardening, tooling, and the small flagged items

1. **act_runner 5.x (the `gitea/runner` line) is UNVERIFIED.** The
   wire-compatible verdict covers stock act_runner v0.2.13 only; the
   displayed download tree is the 5.x line and the guide's 0.2.x pin
   stands (`docs/research/act-runner-smoke-2026-10-30.md` verdict section
   "Not exercised (honest scope)" + finding 3; `docs/RELEASE-NOTES-v1.3.md`
   §4 "act_runner 5.x is UNVERIFIED"; the pin kept prominent in
   `docs/guide/actions-runners.md` §2.3). A repeat of the smoke against a
   5.x binary — same procedure, same record shape — is the whole item.
   Size: **S** (manual smoke + guide/spec sync).

2. **The ROUTE_CLOCK seam's remaining candidates.** The seam un-skipped
   the admin-monitor-cron golden (`df348c8`); the wallclock audit's
   follow-up list names what is left
   (`docs/research/render-wallclock-audit.md` §Recommended follow-ups):
   (a) the harness route-clock hop for the feed XML goldens — the loaders
   take `now` but the `ui/index.ts` call sites hardcode `new Date()`
   (releases/tags/user atom+rss); (b) the API-tier route clocks (`toApiCron`
   in `api/routes/admin-degenerate.ts:339`, the heatmap minute-cutoffs) —
   only if API JSON goldens ever land; (c) the class-(c) stored-object
   writers: `wikiPerson`'s clock into wiki commits and the
   `mergePerson`/`mergePersonOf` twins ignoring `MergeInput.now` — needs
   engine-level object writes, "a wave of its own". The artifacts-preview
   page clock LANDED in v1.3.1 (`74df9ad`, the ARTIFACT_PREVIEW_CLOCK seam
   + the signed-URL tail golden) and is no longer a candidate. Sizes:
   (a) **S**, (b) **S**, (c) **M**.

3. **The cleanup-rule preview's PackageID-filter upgrade note.** Upstream's
   preview pins per-package `SearchVersions{PackageID}`; the landed page
   reduces it to the unique key (`ownerId + type + exact lowerName`) over
   `searchVersions`, and the paginator-less `Find` stands in as
   `RULE_PREVIEW_VERSIONS_LIMIT = 10_000` — the module's own recorded seam,
   to upgrade if `searchVersions` ever grows a packageId option
   (`apps/worker/src/ui/pages/org-settings-packages.tsx` header lines
   92-97, the constant at :729, the loader comment at :783-791; the twin
   re-exports it in `apps/worker/src/ui/pages/user-settings-packages.tsx`).
   Size: **S** (conditional on the store growing the option).

4. **SPEC-0011's queued engine residual: D3 + the unpinned rows.** The
   state-transition ledger found one genuine unrecorded gap — the
   failed-publish lease-pointer destroy (D3), "now queued for fix" — and
   §7.2 rows 10-11 hold structurally/partially, unpinned by dedicated
   checks (`specs/README.md` SPEC-0011 row; the ledger itself:
   `docs/design/m3-state-transitions.md`). Size: **M** (fix + two checks).

5. **Doc-debt sweep (stale rows found while consolidating — see the
   report's flags):** (a) `specs/README.md`'s issue-content-history row
   still declares the soft-delete POST arm + actorId threading as standing
   follow-ups, but `90e0d2f` landed both (release notes, "The
   issue-content soft-delete and actor attribution"); (b) the same row's
   activity-feeds neighbor still says "the matrix doc still labels the five
   newer arms DEFERRED", but `abab71c` folded those labels to WIRED in
   `specs/activity-feeds.md` §3.3; (c) `docs/RELEASE-NOTES-v1.3.md` §4
   lists the `/install` first-admin window as UNFIXED, but `16a63b6` fixed
   it after that snapshot (humans-not-rows; the fix recorded in
   `specs/README.md`'s SPEC-0010 row). All three are comment-only syncs.
   Size: **S**.

6. **Carried unchanged from v1.2 §4** (`docs/RELEASE-NOTES-v1.3.md` §4
   last bullet, quoting v1.2): the ws1009 residuals (strip-mode trades
   original-position failure-frame mapping; the upstream chunked-frames
   fix remains desirable — ADR-0006's revisit trigger stays armed against
   cloudflare/workers-sdk#16349), git-over-HTTPS-only (ADR-0001), the
   absent `email_hash` table, and no `/assets` fallback target. Recorded,
   not re-sized; each is a future SPEC's call. Size: **S–L** depending on
   which reopens.

7. **The serializer counts tail + the language side-store.** The counts
   seam LANDED in the window since `0fdc267`: `followers_count`/
   `following_count` render the requester-visible live totals (the
   documented `ApiUserFollowCounts` divergence — a private follower never
   counts for a viewer who cannot see them; `58283bd` + the `GET /user`
   self wiring `40120ae`, with the no-binding degrade `9f883d0`). Still
   open from the same TODO(SPEC-0005): `last_login` — the D1 row has NO
   column (definitive over schema + migrations 0001-0044); the render
   site documents the authed-gate shape and the TODO re-scoped to the
   missing column (`58283bd`). Alongside it, `language` renders `''` on
   BOTH serializers by decision: there is no users column for it —
   upstream keeps the language in a side store, and the review graded the
   drift cosmetic (`cf269f4`'s in-comment note;
   `docs/usability/parity-review-api.md`). Landing either needs the store
   decision first (a SPEC-0005 call). Size: **M** (store + two
   serializers).

8. **The review-actions lower-ranked drifts** (source:
   `docs/usability/parity-review-actions.md` ranked list, below the five
   v1.3.1 fixed): expired-hot-log appends accepted; v4 EXPIRED rows
   admitted; the twirp legacy raw-token arm absent; the retention
   fail-closed default stays the documented divergence (the sweeps
   themselves landed — `e4b9f66`). Each is a small guard or arm on the
   landed stores; the twirp arm is compatibility surface. Sizes: **S**
   each.

9. **The Oct 31 watch item — sweep-fire observation + the two upstream
   filings.** The 9:00 handover record's close-out line
   (`docs/run-pending-9am-task.md:88`) instructs: observe the sweep-fires
   at Oct 31 11:00 UTC — D1 orphan action rows should stay 0 (the
   latency/health baseline read 0/0, `560f0df`) — and keep watching
   cloudflare/workers-sdk#16548 (our filed DDL defect,
   `docs/research/workerd-ddl-cross-session-locked.md`) and #16349
   (P3-6's ws1009 trigger). v1.3.1 tripled the sweep surface same-day
   (`e4b9f66`'s three producers), so the first post-wiring observation
   covers both the old retention arms and the new endless/abandoned/
   ephemeral arms. A check, not a work item; file findings as residuals
   if red. Size: **S** (observation + record).

10. **`/raw` LFS resolution follow-up.** v1.3.1 landed the file-view LFS
    badge and CORRECTED the premise: upstream `/raw` does NOT resolve LFS
    at the pin (`web.go:1705-1712` wires `SingleDownload`;
    `SingleDownloadOrLFS` is the `/media` group only) — the landed posture
    is correct and pinned (`f561d92`'s dated correction note + the
    pointer-parity regression pin). The disclosed follow-up surface for
    v1.3.2: the `/media`-family content resolution + size + link flip, if
    that surface is ever dispatched. Size: **M** (a new route family).

11. **The annotated-tag read-tag RPC (engine boundary).** The tags API's
    `message` is always empty because the engine boundary carries no
    read-tag RPC (`readCommit` peels; `parseTag` unexported; only the
    write-side `serializeTag`) — F8 of the git-e2e wave, flagged to the
    engine owner (`1677dbb`; the deviation recorded in the git-models/
    routes headers; finding origin `27353a2`). Needs the boundary
    decision (a `readTag` RPC or a peeled-tag sidecar) first. Size: **M**
    (engine + API), **engine-owner**.

12. **The `/user/settings` remaining serial pair** — the perf lever
    `06b3384` explicitly left on the table: verifySession's
    read-and-discard of the full users row plus the navbar bell's unread
    COUNT ride serially after it; a viewer-level carry would dedupe
    (4→2 round trips, ~0.7s more at the observed production latency).
    Lives in `resolveUiSession` (`ui/index.ts`) — orchestrator-owned
    dispatch. Size: **S–M**.

13. **Guide notes from the production sweeps.** (a) Pre-`b0e1d88` repos
    carry no armed `repo_settings` row, so `/api/v1`-created or
    migrated-in repos 404 the Actions tab until the settings toggle arms —
    expected behavior, but the guide/README should say so (`560f0df`
    finding F7, orchestrator adjudication). (b) The two client footguns
    recorded for the packages guide: npm 11's nerfDart drops the registry
    URL's last path segment without a trailing slash (ENEEDAUTH with a
    working token), and the maven DELETE needs the encoded
    `group%3Aartifact` name (`b9f537a`'s informational section). Size:
    **S** (docs only).

14. **The release rename-onto-existing-tag 500.** Upstream's
    UpdateRelease carries no row-collision check on a tag rename — it
    would write duplicate release rows for one tag; ours answers 500 off
    the `releases_repo_tag_uq` unique index instead (`29ecd1d`'s
    documented divergence). A future parity pass either drops the index
    to match upstream's duplicate-row semantics or re-affirms the 500 in
    SPEC-0004's release row (the same decide-or-reaffirm shape as P2-5).
    Size: **S** (decision + one arm).

15. **The unit-gates' documented divergences** (`ddf3b2a`'s module
    header): the pulls gate's IsEmpty arm is omitted — our `is_empty` is
    mirror-maintained only and including it would 404 every pushed repo's
    pulls family, so it is staged behind isEmpty maintenance; the
    DELETE-comment arm keeps its pre-existing 423-on-archived where
    upstream's arm is ungated; the TypeCode reader arm is vacuous (every
    repo carries code); reactions' 403-class narrowing is out of scope.
    Each is a small arm on the landed gate; the IsEmpty piece is the
    staged one. Sizes: **S** each.

---

## How to consume this board

- Items 1–3 and 7 of P1 are SPEC-0012 work with a stated dependency order:
  OQ-1 decides at M3's opening (its own recorded rule), C5 and C10 land
  behind the emitter/substrate M3 provides. Item 4 (auths) and items 5–6
  (M6/M7) each open with their own SPEC-attachment per the recorded
  rules — none is dispatchable as a bare UI/store unit.
- The v1.3.1 additions (P2-5 through P2-10, P3-7 through P3-13) and the
  parity-wave additions (P3-14, P3-15) are mostly dispatchable small
  batches over landed substrate; P2-8's engine-scope items and P3-11 need
  their boundary decisions first. Verify the in-flight block at the top
  BEFORE dispatching any of them — the doc-time block it replaced is
  fully resolved (the header note), and the current three items are
  sibling-owned.
- P2 items are all dispatchable over landed substrate except the
  scoped-workflows pieces (P1-3).
- P3 is the sweep list for gap waves between feature landings; the doc-debt
  item is safe to take anytime. P3-9 is a dated observation, not a work
  queue — clear it after the Oct 31 11:00 UTC check.
