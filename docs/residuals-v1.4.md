# Residual backlog — v1.4 candidates

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

**In flight at doc time — verify at tag** (snapshot `e4b9f66`; sibling
units are landing these as you read this — do not re-dispatch blindly, do
not count as landed until committed, re-check each against the tag):

- **Topics/licenses on the repo payloads** — the full converter
  (`toApiRepositoryFull`, with the stored `topics` + `licenses`, fork
  `parent`, and real mirror schedule) already sits in the tree; the
  single-repo route swap from the sync converter is the route owner's
  one-liner (`apps/worker/src/api/services/repository.ts` docstring; the
  review's drifts 3+9: `docs/usability/parity-review-api.md` Top-10).
- **The packages small items** — review-packages D-4 (nuget's three
  service-index endpoints still require auth where upstream leaves them
  open, verified open at `packages-protocols.ts`), D-5 (the three quota
  403 strings), D-6 (the downloads' cache/nosniff/CSP/Accept-Ranges/304/
  filename* header set) (`docs/usability/parity-review-packages.md`).
- **The api unit gates** — issue/pull routes still ignore
  `has_issues`/`has_pull_requests` (200 vs upstream 404) and any reader
  can set labels/milestone on issue create (verified open:
  `apps/worker/src/api/routes/issues.ts:132-133`) — review-api drift 10.
- **The serializer counts** — `followers_count`/`following_count` always 0
  and `last_login` the zero time on every User payload
  (`repository.ts:474,483-484`, TODO(SPEC-0005)) — review-api drift 4.
- **The release sha tail** — `sha1`/`num_commits` stay unwritten on
  release rows (`6b2bedc`'s disclosed engine-wave tail,
  `release.go:150-157`).
- **The identities swap** — the auth test rig's contract-`User` projection
  swapping from the convention-synced private copy to the canonical
  `authUserToApiUser` (the test-twin of `cf269f4`'s production seam; the
  rig's copy had already drifted — no `username` key, hardcoded
  visibility/URLs). Uncommitted in the working tree at snapshot time
  (`apps/worker/src/auth/testing/identities.ts` + its test).

Landed in the same window, for the record (no longer open): the
production serializer-identity swap — `GET /user` now delegates to the
canonical converter shape (`cf269f4`), closing review-api drift 1; the
`username` compat key (drift 2, same commit); the branch list order
(drift 8, `7f9241e`).

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

6. **The review-api semantic-drift remainder** — what v1.3.1 did not close
   (source: `docs/usability/parity-review-api.md` Top-10 + honorable
   mentions; drifts 1/2/8 landed — see the header note; 3/4/10 are the
   in-flight block): (a) repoEdit's PR-merge configuration
   accepted-and-ignored — clients disabling merge styles read the old
   defaults back and actual merge gating never changes (drift 5);
   (b) `assigned_by` issue filter returns empty though the assignee table
   landed; sibling `mentioned_by` has no mention data yet (drift 6);
   (c) the single-PR GET omits `additions`/`deletions`/`changed_files`,
   and `review_comments` never emits (drift 7); (d) `/repos/search` and
   the list paths keep the query-flat sync render — fork `parent` omitted,
   mirror schedule zeroed, no topics/licenses (drift 9's list half; the
   single-repo half is the in-flight swap); (e) honorable mentions kept on
   the ledger: `mergeable: null` while checking, review-list
   `X-Total-Count` counts only visible rows, transfer 202 vs 201,
   auto-init repos missing `gitignores`/`license` files, user email never
   rendered (upstream's noreply placeholder), comment-create accepts an
   empty body and misses the locked-issue 403, annotated tag `message`
   always empty (see P3-11), `default_branch` applied without an
   existence gate. Sizes: **S–M** each; the whole remainder is a
   dispatchable batch.

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
   GCM realm LANDED in v1.3.1 (`4e6d1cc`, `85fa2ff`). Still open
   (engine-scope items separated in the review): receive-pack caps lack
   atomic/push-options/report-status-v2; `.gitattributes`
   export-ignore/export-subst un-honored in archives + our zips STORE
   (upstream shells to real git archive); LFS locks → 501 (upstream
   implements the family); protocol-v2 lacks fetch=filter (partial clone
   fatal) and ls-refs=unborn; the ladder-ordering drifts (403-before-auth
   arms, the wiki-doesn't-exist pkt-line, dumb-HTTP absent — documented).
   Sizes: **M** each; several are engine-boundary decisions first.

9. **The review-packages D-4/D-5/D-6 tail — in-flight at doc time, verify
   at tag.** D-4: nuget's three service-index endpoints require auth where
   upstream deliberately leaves them open (`api.go:342-346`); D-5: the
   three quota 403 strings differ from upstream's sentinels; D-6: downloads
   lack upstream's cache/nosniff/CSP/Accept-Ranges/304/filename* set
   (`docs/usability/parity-review-packages.md` fix-order tail; D-1/D-2/D-3
   landed `3571fe8`). Size: **S** as one batch.

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

7. **The serializer counts tail + the language side-store.**
   `followers_count`/`following_count` always 0 and `last_login` the zero
   time on every User payload — TODO(SPEC-0005), owned by the serializer
   unit (in-flight at doc time, verify at tag; `cf269f4`, `7f9241e`).
   Alongside it, `language` renders `''` on BOTH serializers by decision:
   there is no users column for it — upstream keeps the language in a side
   store, and the review graded the drift cosmetic
   (`cf269f4`'s in-comment note; `docs/usability/parity-review-api.md`).
   Landing either needs the store decision first (a SPEC-0005 call).
   Size: **M** (store + two serializers); the counts alone **S** if the
   in-flight unit lands them.

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
    v1.4: the `/media`-family content resolution + size + link flip, if
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

---

## How to consume this board

- Items 1–3 and 7 of P1 are SPEC-0012 work with a stated dependency order:
  OQ-1 decides at M3's opening (its own recorded rule), C5 and C10 land
  behind the emitter/substrate M3 provides. Item 4 (auths) and items 5–6
  (M6/M7) each open with their own SPEC-attachment per the recorded
  rules — none is dispatchable as a bare UI/store unit.
- The v1.3.1 additions (P2-5 through P2-9, P3-7 through P3-13) are mostly
  dispatchable small batches over landed substrate; P2-8's engine-scope
  items and P3-11 need their boundary decisions first. Verify the
  in-flight block at the top BEFORE dispatching any of them — four of the
  five in-flight items overlap this board's P2/P3 rows.
- P2 items are all dispatchable over landed substrate except the
  scoped-workflows pieces (P1-3).
- P3 is the sweep list for gap waves between feature landings; the doc-debt
  item is safe to take anytime. P3-9 is a dated observation, not a work
  queue — clear it after the Oct 31 11:00 UTC check.
