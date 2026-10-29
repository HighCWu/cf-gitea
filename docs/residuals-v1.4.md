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

**In flight at doc time — verify before consuming this backlog** (working
tree at `849add4`; do not re-dispatch, do not count as landed until
committed):

- **The user settings packages twin** — untracked
  `apps/worker/src/ui/pages/user-settings-packages.tsx` (+ test + three
  goldens, with `index.ts`/`index.test.ts` mounts among the modified
  files). The survey names it sibling-owned with gate-v4
  (`docs/compat/ui-parity-survey.md`, tick-21 GATED paragraph).
- **The signed-URL preview-tail golden** — the `/preview/{path}` golden was
  the honest exclusion of `d580d1f` ("artifactPreviewRawLink reads
  `Date.now()` with no route-clock seam"); the working tree carries the
  page-clock seam in `apps/worker/src/ui/pages/repo-actions-artifacts.tsx`
  (the ROUTE_CLOCK page-module twin) plus `goldens.test.ts` edits. Expected
  to land before release.
- A survey edit is also in the tree (`docs/compat/ui-parity-survey.md`
  modified — likely the next tick); re-read it before trusting tick-21's
  remaining-set quotes below.

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
   "M3's parser closes the trap"). Size: **L**.

2. **C5's run-mutation remainder: rerun + rerun-failed** (the cancel arm
   landed inside C2's window). Rerun creates a new `ActionRunAttempt` and
   re-emits job rows — emitter territory, so the census flagged it to
   M3 (`docs/research/actions-ui-census.md` C5 row and open question 1;
   `specs/0012-actions-feasibility.md` still-open list: "C5's rerun +
   rerun-failed DEFER to M3's job emitter"). Every M1c census unit is
   landed except this and C10. Size: **M**, gated on item 1.

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
   page clock is the in-flight unit above and NOT re-listed. Sizes:
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

---

## How to consume this board

- Items 1–3 and 7 of P1 are SPEC-0012 work with a stated dependency order:
  OQ-1 decides at M3's opening (its own recorded rule), C5 and C10 land
  behind the emitter/substrate M3 provides. Item 4 (auths) and items 5–6
  (M6/M7) each open with their own SPEC-attachment per the recorded
  rules — none is dispatchable as a bare UI/store unit.
- P2 items are all dispatchable over landed substrate except the
  scoped-workflows pieces (P1-3) and the in-flight twin.
- P3 is the sweep list for gap waves between feature landings; the doc-debt
  item is safe to take anytime.
- Re-verify the in-flight block at the top before dispatching anything
  from P2: both in-flight units touch the packages family this board's
  P2/P3 items reference.
