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

**Updated at the v1.3.2 reconciliation snapshot `0b39750`** (2026-10-31,
the window since `ce1b51c`): the window's landings are folded in — P1-2
(`613aa31`), P1-3's substrate (`e24455c`), P1-4 (`faeec92` — resolved to
the documented divergence, the SPEC-0018 amendment), P2-1/P2-2's pages +
mounts (`6bdd91f` + `180b409`), P2-4's web-UI arm (`a803843` +
`4a04d46`), P2-5 (`0b39750` — strikes), P2-7 (`7e72149` — narrowed to
the deferred Code-tab href + the still-open rows), P2-8 (`e454a75`),
P3-10 (`cd895f6` — strikes), P3-12 (`e8ef89d` — strikes) — and the
landings' staged tails ride new rows (P1-13: the scoped-workflows M3
rows; P2-12: the owner-store KV prerequisite; P2-13: the P2-6 tail items
in flight). The two stale spec lines the P2-5 unit flagged are fixed in
place: SPEC-0005 §4.11's `sha1`-null tail (the fill landed with the
UpdateRelease tag wave) and SPEC-0004 §4's blanket-423 (the release
family is the bare-500 exception — upstream swagger carries ZERO
release-family `repoArchivedError` ops of the 60).

**In flight at this update** (snapshot `0b39750`; sibling units are
landing these as you read this — do not re-dispatch blindly, do not count
as landed until committed; the carried items from the `95cdcaf` block
are still uncommitted and keep their places):

- **The store/schema wave** — the working tree's uncommitted `schema.ts`
  + migrations 0046/0047: `0047` is `users.last_login_at` (P3-7's half —
  the column is labeled P3-7 in the schema), `0046` is the
  `package_blob_uploads` M6 upload store (P1-5's SPEC-0016 substrate —
  recorded here only as the wave's rider; P1-5 itself is not reconciled
  in this pass).
- **The owner-store wave — LANDED at `4bffff0`** (2026-10-31, verified
  against the tree): the `user_settings_kv` home (schema `bf7be9e`,
  migration 0048 `26ce795`) + the OwnerActionsConfig store
  (`services/actions/owner-actions-config.ts`) + the two actions-settings
  POST arms (P2-12) — the bullet is closed; see the P2-12 row.
- **P3-11's annotated-tag read-tag RPC** — the engine-boundary wave is
  uncommitted in the tree (`packages/git-engine` `src/repo.ts` +
  `src/git/objects.ts` modified, the new `e2e/check-tag-read.mjs` check).
- **The P2-6 tail items** (P2-13): the E9 deferral record + the ~15
  model.ts cite renumbers (carried from the `95cdcaf` block, still
  uncommitted) + the tree's uncommitted repo-init-templates unit (the
  (d) auto-init gitignores/license files arm).
- **The archive POST-arm pin unit** — carried: the verification record's
  coverage-gap finding, `4e6d1cc`'s HIGH-parity archive POST fix has
  ZERO pins anywhere (the GET arm is well pinned) — the pin unit is
  dispatched (`635a573`), still uncommitted.

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

**The cron-census drift — found and closed (2026-10-31, the admin wave's
open item 2).** The scheduled dispatcher's sanctioned-arm extensions grew
past the arm census without joining it: services/cron-state.ts's
CRON_ARMS carried the original 7 arms while handleScheduledCron
(services/demo-sweep.ts) had grown to 10 producer calls — the parity-review
sweep blocks (SPEC-0012 §4.5's FIFTH/SIXTH sanctioned extensions) landed
producers whose census rows never followed. The drift's actual harm: the
scheduled handler's tick recorder keys armsForEntry off the census, so the
three stragglers' `cron_state` tick rows were silently SKIPPED (their arms
were invisible in the admin cron list, the monitor page, and the tick
store alike). Absorbed per the census's own join rule ("a scheduled arm
added to handleScheduledCron joins THIS table in the same change"):
`stop_endless_tasks` (upstream tasks_actions.go:38, step entry),
`cancel_abandoned_jobs` (upstream tasks_actions.go:46, hourly entry) and
`cleanup_ephemeral_runners` (no upstream registered task — upstream folds
it into cleanup_actions's body, cleanup.go:34-39; ours decouples it as the
always-on ungated producer, parity-review item 3c — hourly entry, the
update_push_mirrors naming precedent). Runnability unchanged: all three
are actions-family arms (producers in services/actions/sweeps.ts, sibling
ownership), so the CRON_RUN_BODIES runnable maps stay at the same five
arms and the new rows render listed-but-unrunnable (404 like unknown),
matching stop_zombie_tasks/cleanup_actions's adjudicated posture. No
board row flips — this closes a flag, not a listed residual.

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
   SPEC's M3 table gains them as named rows. **OQ-1 RESOLVED 2026-10-31**
   (the decision-record addendum at the tail of
   `specs/0012-actions-feasibility.md`, §D1-D6 — a DECISION RECORD, no code
   ratified): upstream's server-side evaluation surface is fixed and
   enumerable — four value-producing call-site families (run-name
   interpolation, static-matrix combos, job `if:`, run+job concurrency) plus
   three AST-scan-only uses (static context validation, deferred-matrix
   detection, the cancel-arm function scan), all over a context set the
   server itself pins to github/gitea/needs/strategy/matrix/vars/inputs
   (`env`/`job`/`steps`/`runner`/`secrets` nil server-side, `hashFiles`
   self-disabled; job `if:` further restricted to
   github/gitea/needs/vars/inputs by upstream's own static validation) — and
   the runner evaluates NOTHING job-level (the claim payload rewrites job
   `if:` to literal `always()`, `services/actions/task.go:176-186`;
   act_runner's step-level evaluator observed live in our smoke,
   `docs/research/act-runner-smoke-2026-10-30.md:137-138`). The evaluator is
   actionslib's own minimal rewrite (13 built-in functions, NOT nektos/act's
   engine), measured at ~3.7k server-relevant non-test Go lines with
   `glob.go`+`workflow_call.go` droppable — the verdict closes OQ-1
   (b)-shaped (port the evaluator core wholesale; option (a)'s
   grammar-subset reading is REFUTED — upstream restricts only contexts,
   never grammar, and a static-parse failure already rejects the whole run
   at insert, `run.go:121-123`). **M3 consequence: the row decomposes into
   tiers, and only one waits on the evaluator** — P (pure parity: notifier
   census, `[skip ci]`, workflow detection + the expression-free
   `workflowpattern` matchers, InsertRun mechanics, the emitter's
   needs-graph/slots, commit statuses, the claim-payload rewrite —
   dispatchable NOW, produces runs end-to-end for expression-free
   workflows), S (syntax-layer only: detection-time static validation + the
   push invalid-workflow failed-run arm — needs the 1.1k-line parser, not
   the interpreter), E (the evaluator core ≈2.6k lines + its four call-site
   rows, conformance-tested against actionslib's own testdata). The "no
   automatic producer" honest limit narrows accordingly: a P+S unit arms the
   full trigger chain for workflows without `${{` (upstream's own
   `${{`-byte-scan classification at `workflows.go:134` is the coverage
   gate), with the expression-ful gap documented until E lands. Size:
   **L** (one wave, or split into P+S + E dispatch units — a dispatch call,
   per §D5). **AS-BUILT 2026-10-31: all three tiers landed** — P
   (`0e9b0c1`), S (`667d349`), E evaluator core (`240d67d`), and the E-tier
   call-sites wired in `trigger.ts` (run-name at insert, the job `if:` gate
   at insert+emitter with the invalid-`if:` job summaries, the
   workflow-level concurrency gate at run creation incl. the cancel arms
   and the blocked-run wake; `repo_counters.run_index` CAS replaces the
   MAX+1 interim; the static-invalid → FAILED-run push seam exercised
   end-to-end). **Remaining STAGED inside this row CLOSED 2026-10-31 (the
   E5 model-port wave)**: the YAML workflow model landed as
   `apps/worker/src/services/actions/workflow-model/` (actionslib
   `pkg/model`'s MatrixCombinations + jobparser's Job/Strategy decode,
   `Strategy.resolve`/`buildMatrixCombos`/`ExpandMatrixWithNeeds`, over
   expreval's `EvaluateYamlNode` in `expression-eval/evaluator.ts` — the
   recorded seam) and `trigger.ts` wired the arms: static combos expand at
   insert into one row per combination (the baked strategy matrix +
   interpolated name/runs-on/continue-on-error), needs-reading matrices
   plan as deferred placeholders the emitter expands over the completed
   needs (`ExpandMatrixWithNeeds`, terminal-fail on expansion error), the
   job-level concurrency fill model evaluates at insert and at the emitter
   (cancel-or-block per group, the admitted-group gate, the full
   checkRunConcurrency collection), and the insert-time max-parallel slot
   map plus the runs-on schema arm ride the combo loop. A
   `strategy.matrix` workflow flows end-to-end. Schedules (§1.4), the
   other notifier hooks, and the reusable-workflow family keep their own
   staged rows.

2. **C5's run-mutation remainder: rerun + rerun-failed — LANDED
   (`613aa31`), including the v1.3.1 artifact-inheritance addition.** The
   rerun pair follows upstream's `run.go` semantics per this row's cite:
   the service module (`apps/worker/src/services/actions/rerun.ts`) +
   suite + the run-viewer page's mutation buttons, with the
   artifact-inheritance arm (rerun-failed keeps succeeded jobs' artifacts
   downloadable, resolving to the new attempt) this row's addition named.
   Landed as a salvage from a unit that died at the 1308 wall AFTER
   finishing but before reporting — the verification is the green suites
   on the tree (rerun + run-viewer 84/84 own-eyes, tree tsc 0, guard
   PASS); the premature `fd2cfdd` landing was reverted at `6945cee` and
   this is the clean re-landing. The census's M3-emitter gate did not
   bind — the pair landed against the still-open M3, following upstream's
   `run.go` semantics per this row's cite. Every M1c census unit is now
   landed except C10 (P1-3). Size: — (landed).

3. **C10's scoped-workflows pages and their substrate — the
   M3-independent pure layer LANDED (`e24455c`); store + parser + pages
   STAGED with cites.** The landing verified the board's post-M3 verdict
   in substance via a dependency decomposition: the pages need not the
   M3 trigger chain but TWO independent substrates, either blocking
   alone. LANDED: `apps/worker/src/services/actions/scoped-workflows.ts`
   — upstream-verbatim (`scoped_workflow.go:18-41` +
   `scoped_workflows.go:31-195`): `SCOPED_WORKFLOW_DIRS`
   (`.gitea/scoped_workflows`, the never-overlap rule), the
   path/context-name helpers (outer-TrimSpace semantics pinned),
   `shouldEventCreateCommitStatus`'s six-event allowlist (+ upstream's
   own duplicated-truth TODO carried), `parsePatternLines`,
   `buildScopedWorkflowInfos` (the live+orphan merge, orphans sorted,
   null configs skipped), `applyScopedWorkflowRequiredForm` (fail-fast
   patterns-empty refusal, live-unchecked-with-patterns kept as history,
   orphan drops, required-orphan kept) — parameterized over parsed
   files/liveSet/configs so the staged store and pages consume it
   unchanged (suite 24/24; actions family 235/235; the full dependency
   map in the module header). LANDED THIS WAVE (`9fb8ffd`): the
   PAGES + the parse assembly — `apps/worker/src/ui/pages/
   actions-scoped-workflows.tsx` (the scope-neutral core: the
   `ScopedWorkflowSourcesStore` seam, each method citing its upstream op;
   the `parseScopedWorkflowFiles` walk + `deriveScopedStatusContexts`
   assembled over the landed M3-P exports — `getEventsFromContent` +
   `splitWorkflowPayloads` — with the E-tier matrix/expression preview
   reduction documented; the GET assembly `loadScopedWorkflowsPageData`
   with the missing-repo-row skip; the three POST appliers
   `applyScopedWorkflowAdd/Required/Remove` porting
   `ScopedWorkflowAdd`/`ScopedWorkflowSetRequired`/`ScopedWorkflowRemove`
   over the seam; the form parsers; the shared body rendering
   `scoped_workflows.tmpl` byte-level, the space-before-missing-label
   included) + the three frames (`org-settings-actions-scoped-workflows` /
   `user-settings-actions-scoped-workflows` /
   `admin-actions-scoped-workflows`, the owner-general twins' split) +
   their suite (the DOM contract, the parse assembly, the appliers over a
   store fake + real local D1). STILL STAGED (the store HANDOFF): the
   `action_scoped_workflow_source` schema table port + the drizzle
   `ScopedWorkflowSourcesStore` implementation (src/db + services/actions
   were ownership-forbidden to the pages unit — the core header carries
   the exact port spec per op), the `ui/index.ts` mounts (four routes x
   three scopes — the recipes are the core's HANDOFF tail; the routes
   stay the documented honest 404s until the store lands), and the nav
   folds (the sub-items stay the recorded dead items; the fold hunks ride
   the same tail). Until the store lands, the admin scoped-workflows page
   stays the documented-reduced honest 404 with the nav item omitted
   (`b5923ed`, recorded in release notes §4; survey tick-21's user/org
   sub-tab reductions stand), and the nav folds stay folded OFF (the
   dead-link rule — no fold until the routes serve; P2-3's honest 404
   stands). The ActionsConfig
   `DisabledWorkflows`/`DisabledScopedWorkflows` note
   (`apps/worker/src/services/actions/config.ts:14-16`) is unchanged.
   Size: **S** (the store port + the mount/flip window — everything else
   landed).

4. **The admin auths row — RESOLVED to the documented divergence
   (`faeec92`, the S arm; SPEC-0018's as-built amendment).** The verdict
   tension is settled: the needs-API-first premise verified
   UNSATISFIABLE at the source — the upstream `/admin` group at the pin
   mounts exactly cron/orgs/packages/users/emails/unadopted/hooks/
   actions (`api.go:1814-1867`, every verb walked; no `auths.go` among
   admin/'s 11 files), BOTH vendored swagger JSONs parse to 350 paths
   with zero `/admin/auths*`, and the contract fetched LIVE from
   upstream main today carries the same 350 paths (a web-search claim of
   `/admin/auths` endpoints disproved by the live fetch — the dispatch
   premise's likely origin). The web page exists (`web.go:874-880` over
   login_source CRUD + four typed backend parsers) and is exactly what
   SPEC-0018 §2.3 priced as the missing substrate; mechanically
   forbidden besides: check-openapi's assertion hard-fails any declared
   path absent from the frozen at-pin contract, so an invented family
   fails the repo's own gate. The OMIT verdict stands (zero code,
   upstream-alignment discipline enforced). Forward note from the
   amendment: the reopened arm, when the external-login-chain SPEC
   lands, is the upstream-shape WEB CRUD, not an API ladder — upstream's
   own auths management has no API to mirror. Size: — (resolved; the
   reopen gate unchanged in SPEC-0018 §3.3).

5. **SPEC-0016 M6 — the container (OCI) registry — LANDED (2026-10-31, the
   /v2 OCI root; `specs/0016-packages.md`'s "As-built — M6 container/OCI"
   section carries it — the SEVENTH protocol at that landing).** "The only
   milestone that may need new infrastructure posture": JWT token flow,
   chunked blob uploads with an upload-state machine (the pre-read
   question resolved — the `package_blob_uploads` D1 row + per-chunk R2
   objects, migration 0046; R2's native multipart handles were REJECTED by
   the as-built), manifests, `PropertyDigest` file properties, GC-aware
   deletes (`specs/0016-packages.md` §7 M6 + §8.6; the SPEC-README row's
   "M6 container + M7 index-builder pending" quote is retired — M6 and
   M7's debian/alpine/rpm/arch halves all landed). The registry's count
   now stands at TWENTY-ONE protocols (the six-minor wave `28a40b5` —
   full parity per its record). Size: — (resolved).

6. **SPEC-0016 M7 — the index-builder family** (debian/alpine/rpm/arch
   metadata index renders; cargo LAST — the git-backed `_cargo_index` repo
   needs the owner-scoped files-service write path). Demand-driven, "size L
   each" (`specs/0016-packages.md` §7 M7). The landed org packages page
   already renders the cargo honest-absence and does not route cargo's
   initialize/rebuild tails for exactly this reason
   (`apps/worker/src/ui/pages/org-settings-packages.tsx` header note +
   documented-reductions section; the omission recorded in
   `specs/README.md`'s 0016 row and commit `6bf9c17`).
   **Landed slice 2026-10-31 — rpm, half two of M7** (COMMITTED `fbace73`
   — the dual-tenant wave salvaged complete from the sixth wall, both units
   died post-completion pre-report; the verification is the green suites on
   the tree, 38/38 rpm+arch own-eyes): `services/packages/rpm.ts` + the rpm route arms in
   `api/routes/packages-protocols.ts` — the binary header reader (header.go
   ported: lead/sig/header sections + the SHA-256/SHA-1 digest gates), the
   tag extraction, the createrepo-shaped repodata build over the stored-
   index posture (primary/filelists/other(/updateinfo).xml.gz + repomd.xml
   + the GPG-detached repomd.xml.asc from the shared OpenPGP signer), the
   group-grammar wildcard routes, the errata arm. Pinned 17/17 in
   `packages-rpm.test.ts` (the core fixture is upstream's own
   rpmsign-signed test rpm, every metadata_test.go value asserted), the
   live battery verified the real clients this host carries (rpm -qp parse
   parity, an rpmbuild-built rpm round-tripped byte-identical, gpg "Good
   signature" on repomd.xml.asc against the served repository.key; dnf/
   createrepo absent — disclosed); the as-built is in
   `specs/0016-packages.md`'s M7 section. Reductions documented there: the
   upload `?sign=true` re-sign arm unported (MD5 + region-rewrite), the
   empty-group arm narrowed to the family's per-key delete.
   **Landed slice 2026-10-31 — arch, half three of M7** (COMMITTED
   `fbace73` — the dual-tenant wave's second half, sharing
   `packages-protocols.ts` with the rpm unit above — hunks attributed per
   family; 8/8 own-eyes, debian+alpine neighbors 20/20 unregressed):
   `services/packages/arch.ts` + the arch route arms — the pacman
   `.db` tar builder (the `{name}-{version}/files`+`/desc` pairs in
   repository.go's files-first order, the be_sync.c 23-field layout,
   `joinFields`' newline-forgery gates), the vercmp.go port (upstream's
   own vercmp_test.go table pinned) with its registry consumer (the
   index's highest-version fold, repository.go:225-235), the
   `<repository:*>` PathGroup grammar (chi's catch-all: EMPTY +
   multi-segment repositories; the symlink-dance resolved as the six
   filename spellings' normalization to one stored `packages.db`), the
   any-arch merge + serving fallback, the SignData/repository.key arms
   over the shared OpenPGP signer. Pinned 21/21 in
   `packages-rpm.test.ts`'s sibling `packages-arch.test.ts` (upstream's
   vercmp_test.go + metadata_test.go vectors, the integration test's
   six-name sweep + KeepLastVersion fold + `with/slash`/empty-repository
   arms, real WebCrypto verification of BOTH signature arms against the
   n/e parsed out of the served repository.key armor); pacman/repo-add/
   makepkg are NOT installed on this host (disclosed — the apk
   precedent); the as-built is in `specs/0016-packages.md`'s M7 section.
   Reductions documented there: .pkg.tar.zst/.xz → 400 unsupported (no
   codec in the substrate), the 64 MiB sign window (WebCrypto cannot
   stream the RFC 4880 framing), the omitted %MD5SUM% (the debian
   precedent), the pinned index member order, `arch.key.created`.
   Still open in this row: the cargo tail only; the cleanup rebuild-arm
   wiring (cleanup.go:115-145's BuildAllRepositoryFiles family —
   debian/alpine/rpm/arch builders are exported and un-wired) and the
   deploy-probes distro arms ride the orchestrator's wiring wave
   (fbace73's recorded re-dispatch items).
   Size: **L** for cargo, demand-gated; — for the four non-git families.

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

   **Slice landed 2026-10-31 — the runner-management family (15 ops, the
   runners/registration-token gap this row named):** the `/api/v1` runner
   family is declared and served at all three scopes — getRepoRunners /
   repoCreateRunnerRegistrationToken / getRepoRunner / deleteRepoRunner /
   updateRepoRunner + the org and user twins — over the landed
   `action_runners` + `action_runner_tokens` control-plane store
   (`apps/worker/src/api/routes/secrets-variables.ts`'s runners section,
   service mapping in `apps/worker/src/api/services/secrets-variables.ts`,
   storage via `apps/worker/src/services/actions/model.ts`; upstream
   anchors routers/api/v1/shared/runners.go + models/actions/runner.go).
   Pins: 42/42 in the family suite (every declared arm + the runtime-only
   401/403/422 codes + the two 404 shapes — the not-exist text vs
   EditableInContext's "No permission…" foreign-scope text); check-openapi
   PASS with the declared count at **515/554, 39 remaining**. The three
   slices that predate this row's dispatch (secrets/variables at
   repo/org/user, 23 ops) were already inside the 500. The remaining 39
   are additive rows P1-8 through P1-12 below.

8. **The `/api/v1` Actions runs/jobs listing trio — 6 ops (P1-7's
   remainder, slice 1 of 5).** `getWorkflowRuns` +
   `listWorkflowJobs` at repo scope, `getOrgWorkflowRuns` +
   `getOrgWorkflowJobs` at org, `getUserWorkflowRuns` +
   `getUserWorkflowJobs` at user — the addActionsRoutes tail
   (`m.Get("/runs", reqToken(), reqReaderCheck, act.ListWorkflowRuns)` /
   `m.Get("/jobs", …)`, `routers/api/v1/api.go:992-993`; org arm
   `api.go:1738-1742` via `reqOrgMembership`; user arm
   `api.go:1135-1136`).
   Handlers delegate to shared.ListRuns/ListJobs
   (`routers/api/v1/shared/action.go:35-228`) over the LANDED
   `action_runs`/`action_run_jobs` stores — the code needs no M3 (an empty
   store lists empty), but a DEMAND review should ride P1-1's M3 so the
   wire has real rows to render; the `ActionWorkflowRun`/`ActionWorkflowJob`
   wire shapes + the status/conclusion string mapping are the bulk
   (`modules/structs/repo_actions.go:95-215`,
   `services/convert/convert.go` ToActionWorkflowRun/Job). Size: **S-M**.

9. **The repo-level Actions extras — 8 ops (P1-7's remainder, slice 2 of
   5).** The workflows family: `ActionsListRepositoryWorkflows` /
   `ActionsGetWorkflow` / `ActionsListWorkflowRuns` /
   `ActionsDisableWorkflow` / `ActionsEnableWorkflow` /
   `ActionsDispatchWorkflow` (`api.go:1255-1263`; handlers
   `routers/api/v1/repo/action.go:859-1238`, the workflow reader over the
   git tree + `actions_service.EnableOrDisableWorkflow`,
   `services/actions/workflow.go:30-45`, whose store IS the landed
   ActionsConfig — the disabled-workflow list
   `apps/worker/src/services/actions/config.ts` already carries); plus
   `getWorkflowJob` + `downloadActionsRunJobLogs` (`api.go:1264-1267`;
   handlers `repo/action.go:1702-1752` + `repo/actions_run.go:15-51`, the
   log download riding the landed DBFS logs store). Dispatches ride the
   landed dispatch service (`apps/worker/src/services/actions/dispatch.ts`)
   but need the M3-free workflow-parse half (the YAML name/event reader the
   repo-actions-workflow UI module already sketches). Gated on P1-1 only
   for data, not code. Size: **M**.

10. **The `/api/v1` artifacts family — 4 ops (P1-7's remainder, slice 3
    of 5).** `getArtifacts` / `getArtifact` / `deleteArtifact` /
    `downloadArtifact` over `/repos/{owner}/{repo}/actions/artifacts[…]`
    (`api.go:1371-1376`; handlers
    `repo/action.go:1863-2151` incl. the signed download-URL build
    `buildSignature`/`buildSigURL`, action.go:2010-2025). The artifact
    store + the `/api/actions_pipeline` wire are LANDED
    (`apps/worker/src/services/actions/artifacts*.ts`) — this is the
    /api/v1 rendering (the `ActionArtifact` wire + `ActionArtifactsResponse`,
    `modules/structs/repo_actions.go:160-183`) plus the delete arm and the
    signed-URL download the v4 pipeline already mints. Size: **S-M**.

11. **The runs deep family — 14 ops (P1-7's remainder, slice 4 of 5).**
    `GetWorkflowRun`, `ListActionTasks`, `deleteActionRun`,
    `approveWorkflowRun`, `cancelWorkflowRun`, `forceCancelWorkflowRun`,
    `listWorkflowRunJobs`, `getArtifactsOfRun`,
    `getWorkflowRunAttempt`, `listWorkflowRunAttemptJobs`,
    `rerunWorkflowJob`, `getWorkflowRunLogs`, `rerunWorkflowRun`,
    `rerunFailedWorkflowRun` — the `/repos/{owner}/{repo}/actions/runs/{run}[…]`
    + `/actions/tasks` group (`api.go:1348-1379`; handlers
    `repo/action.go:786-858` tasks, `:1239-1814` runs). Cancels/approvals
    mutate run/job status over the LANDED model; the rerun trio rides the
    LANDED rerun service (`apps/worker/src/services/actions/rerun.ts`).
    M3-independent as code, demand-gated with it for data. Size: **M**.

12. **The admin Actions family — 7 ops (P1-7's remainder, slice 5 of 5;
    the documented reduction's premise is now stale).**
    `getAdminRunners`, `adminCreateRunnerRegistrationToken`,
    `getAdminRunner`, `deleteAdminRunner`, `updateAdminRunner`,
    `listAdminWorkflowRuns`, `listAdminWorkflowJobs` (`api.go:1856-1867`,
    the reqSiteAdmin group; handlers `routers/api/v1/admin/actions.go` over
    the same shared runners.go mapping). Declared-undeclared by the
    admin-t2 batch when "no runner tables" existed
    (`apps/worker/src/api/routes/admin-t2.ts` header: "the Actions
    runner/run families (`/admin/actions/*` — no runner tables)") — the
    runner tables EXIST since SPEC-0012 M1b and this landing made the
    shared runner mapping serve, so the reduction's reason is gone; what
    remains is pure registration + the admin-scope (0,0) lookups
    (EditableInContext's admin arm, runner.go:162-164). Size: **S**.

13. **The scoped-workflows M3 rows — recorded by P1-3's substrate
    landing (`e24455c`), staged behind P1-1.** The pure layer landed
    M3-free, but three staged arms ride the M3 trigger chain and are
    named rows for the M3 SPEC-attachment alongside P1-1's
    notify/commit-status/reusable-caller rows: (a) the parser's YAML
    half — `GetEventsFromContent` + `deriveScopedStatusContexts` ride
    jobparser (upstream's own `scoped_workflow.go` parse arm): the
    SETTINGS-PAGE half of this arm is now LANDED (`9fb8ffd` — P1
    item 3's parse assembly over M3-P's `getEventsFromContent` +
    `splitWorkflowPayloads`, the matrix/expression context-preview
    reduction documented on the core module), while the TRIGGER half
    (scoped-run detection/matching on consuming events) rides the store
    + the M3 seams; (b) the merge-gate arm —
    `applyScopedWorkflowRequiredForm`'s inputs (the live set, the
    config) come from the store + parse, so required/orphan
    adjudication activates only when both exist (the page-side applier
    is landed and pinned over the seam; activation waits the store
    HANDOFF); (c) the notifier arm — `shouldEventCreateCommitStatus`'s
    six-event allowlist fires from the M3 event seams, not before. The
    schema table port and the store service are M3-INDEPENDENT (the
    pages unit's HANDOFF — the seam interface + port spec landed in the
    core header). Cites: `e24455c`'s module-header dependency map +
    `9fb8ffd`'s core header. Size: — (the trigger half rides
    P1-1's M3 + the store wave; listed so the M3 SPEC-attachment does
    not miss them).

14. **The OAuth2 provider — the v1.4 queue opener; SPEC written
    (2026-10-31, `specs/oauth2-provider.md`, draft pending ratification).**
    The provider surface upstream carries whole (`routers/web/web.go:617–631`:
    authorize/grant/access_token/userinfo/keys/introspect + the
    `.well-known/openid-configuration` arm) with the application CRUD already
    landed on our side (migration 0026, the 5-op `/user/applications/oauth2`
    family, the reduced settings pages). The SPEC records the flow design —
    `oauth2_grant`/`oauth2_authorization_code` tables (migration 0052 sketch),
    the per-instance signing key as a `system_keystore` row beside the Actions
    OIDC key (WebCrypto JWS, RS256 default, no dependencies), the consent page
    over SPEC-0010's session, the Bearer-JWT auth method feeding the landed
    `apiScopeGate` unchanged, the builtin-application seed, and the
    `OAUTH2_ENABLED` gate — including the one landed-constant change, the
    git-HTTP Basic-realm flip to `realm="Gitea"` when the provider is enabled
    (`githttp.go:146–159`; the current constant is the OAuth2-disabled arm
    SPEC-0002 §2.6 chose deliberately). Six-wave decomposition in the SPEC's
    §6; dispatches after ratification. Size: **L** (six waves, SPEC-attached).

15. **The external auth sources — the SPEC-0018 §3.3 reopen gate FIRES;
    SPEC written (2026-10-31, `specs/external-auth-sources.md`, draft
    pending ratification).** The user re-opened the surface for the v1.4
    queue; the SPEC delivers the design pass the gate demanded. The
    viable-set verdict, each type adjudicated against the platform with
    cites (`source.go:28-37`'s seven-value lattice): OAuth2/OIDC client
    sources BUILD — plain HTTPS + JWT verification over the LANDED
    `services/oauth2/jws.ts` substrate (the provider SPEC's W1), the
    generic `openidConnect` discovery arm plus named GitHub/Google
    clients; LDAP/DLDAP viable-in-principle but DEFERRED (outbound TCP
    exists — `connect()` from `cloudflare:sockets`, workers-types
    `index.d.ts:2245`/`:3876-3892` with `startTls` — but the platform
    disallows private-network/localhost addresses, where enterprise
    directories live, and no BER/ASN.1 client exists in-house); SMTP
    DEFERRED (same economics + it resurrects a password-form login the
    PAT posture replaced); PAM/SSPI platform-IMPOSSIBLE, permanent
    (host-OS CGO `modules/auth/pam/pam.go:5-8`; the Windows SSPI API,
    `source.go:56`). The design: `login_source` + `external_login_user`
    D1 tables (upstream `source.go:109-126` / `external_login_user.go:50-70`),
    the `sessions.oauth2_login_state` dance column (the provider SPEC's
    `oauth_state` column pattern), `/user/oauth2/{source}` +
    `/callback` with a UUID state dance, the link-account family
    (`/user/link_account*`, `web.go:597-599`) with the `ALLOW_SIGNUP`
    gate and a recorded admin-init-window guard (an external sign-in
    never closes the one-shot `/install`), and the admin `/-/admin/auths`
    WEB CRUD — the SPEC-0018 as-built forward note enforced: web-only,
    NO `/api/v1` family (none exists upstream at the pin or main;
    `check-openapi` would hard-fail the invention). Security postures
    recorded: no email-match linking (upstream's `auto` mode is a
    takeover hazard, not ported), provider-token columns carried but
    written empty until a consumer lands, bounded dance state (the
    upstream `MaxTokenLength` cookie-trap answered with a D1 column).
    Six-wave decomposition in §9 (W1 tables/store, W2 OIDC flow, W3
    github+google, W4 admin CRUD + login buttons, W5 linking + settings,
    W6 battery + the SPEC-0018 ledger edit). Size: **L** (six waves,
    SPEC-attached; dispatches after ratification).

16. **The federation (ActivityPub) surface — the design pass; SPEC written
    (2026-10-31, `specs/federation.md`, draft pending ratification).** The
    honest census is the headline: the pin's gated surface is tiny and
    upstream retracted its implementation (PR #36789, `1592576fa5` — 1083
    lines deleted: actor, signature middleware, delivery client, per-user
    keypairs, nodeinfo-data, all tests; "wait until the whole design is
    stable and usable"). What the gate actually serves at `fc493688`:
    `GET /.well-known/nodeinfo` + a full real webfinger
    (`webfinger.go:38-122`) behind `federationEnabled` with
    `Enabled=false` default (`federation.go:23`), and the API side is
    registered-but-501 stubs (`api.go:1007-1010`; `NotImplemented` is the
    activitypub package's entire content). The SPEC therefore splits the
    queue item in two: **Tier A — the parity-committed discovery tier**
    (one S wave, zero schema, the `FEDERATION_ENABLED` fail-closed var,
    the exact disabled arm: web 404 / API unmounted; the frozen contract
    gains nothing — the paths are absent from the pin's swagger), and
    **Tier B — the deleted upstream architecture staged as
    design-complete-but-gated** (person actor over numeric-ID IRIs,
    RSA-3072 keypairs in `user_settings_kv` per the debian.ts precedent,
    hand-rolled zero-dependency draft-cavage verify over WebCrypto, the
    remote-key TTL cache as the recorded divergence, delivery on the
    producer→Queue→DLQ idiom, the inbox a faithful 204 black hole).
    Moderation: nothing to port — `federation_block` never existed
    upstream (Forgejo-only; checked `git log --all -S` in the submodule).
    Six open questions recorded; the decisive one (OQ-5): no upstream
    anchor exists for ANY fediverse feature, so beyond-parity building
    needs a product owner, and the delivery wave does not dispatch until
    it has cargo. Size: **S** (Tier A, one wave) / **L** (Tier B, five
    waves, gated on ratification).

## P2 — parity polish

1. **The user actions settings group's remaining sub-tabs — LANDED
   whole: the pages + mounts (`6bdd91f` + `180b409`), the write arms
   (`4bffff0`, the owner-store wave — P2-12 closed).** The bare
   `/user/settings/actions` redirect answers 303 with the LITERAL
   `./actions/general` bytes (upstream `web.go:722`'s
   misc.LocationRedirect — the adminActionsGroupRedirect convention) and
   the general page rides `userSettingsTabPrologue` + the reuse twin over
   the owner store (the loader reads
   `services/actions/owner-actions-config.ts`, the absent row answering
   the fresh posture) — mounted literal-first in the parse arms (the
   bare `actions` before `actions/runners`), four parse-table pins (the
   nesting-bug guard class). The pages render the NO-SETTING
   OwnerActionsConfig posture — upstream's own render for any owner
   without a saved user_setting row (`setting.go:210-232`'s absent-row
   FromDB → permissive; `general.go:78-79`'s write-all max; the
   empty-list short-circuit) — with byte-level fidelity pinned. The POST
   arm is LIVE (`4bffff0`): `POST /user/settings/actions/general` parses
   both forms, applies over the store (the `applyOwnerActionsGeneralForms`
   port of `UpdateGeneralSettings`, `general.go:100-161`), answers the
   :125 JSONError 400 literal on an unknown add target (nothing stored)
   and 303s back onto the page URL; the `6bdd91f`-era engine-owned-404
   reduction is retired. The route-level matrix (guard-first, the
   anonymous login 303, the doer-keyed scoping) is pinned in the page
   suite. Scoped-workflows at this scope: the page module LANDED
   MOUNTED LIVE by the store wave 630a6da (12 routes x 3 scopes; the page layer `9fb8ffd` — P1 item 3's user frame; the
   sub-tab stays the dead nav item and the routes the honest 404s until
   the store HANDOFF + mount flip). Settings-nav/goldens: both unions
   gained actions-general, 8 golden files re-baselined with token deltas
   verified. Size: — (closed).

2. **The org actions settings tab's remaining pieces — LANDED whole: the
   general page + bare redirect (`6bdd91f` + `180b409`), the write arms
   (`4bffff0`, the owner-store wave — P2-12 closed).** `GET
   /{org}/settings/actions` 303s the literal `./actions/general` bytes
   (`web.go:1052`'s twin) and `GET /{org}/settings/actions/general` rides
   `resolveOrgTeamsRequest` (the owner prologue) + the shared
   `loadOrgActionsGeneralPageData` — the shared core (locale, fresh-data,
   loaders, the `ParseMaxTokenPermissions` port `general.go:25-44`) lives
   in `org-settings-actions-general.tsx`, the user page is the reuse twin
   (the packages-twin aliasing style); the navbars put General FIRST
   (user `navbar.tmpl:43-45` href `/user/settings/actions/general`, org
   `:32-34` upstream's own BARE `{OrgLink}/settings/actions` — the
   redirect URL mirrored exactly). The POST arm is LIVE (`4bffff0`):
   `POST /{org}/settings/actions/general` runs the same
   `applyOwnerActionsGeneralForms` port over the ORG's owner id — the
   require-owner prologue on the write (anonymous 303s to login, a
   signed-in non-owner 404-shells), the :125 JSONError 400 on an unknown
   add target (nothing stored), the 303 back onto the page URL; the
   route-level matrix is pinned in the org page suite (the org-vs-user
   scoping included). Scoped-workflows rides P1 item 3 (the org frame
   LANDED + MOUNTED (9fb8ffd pages, 630a6da store+routes); the dead-item posture
   stands until the store wave). Size: — (closed).

3. **The admin scoped-workflows page** (listed for traceability; consumed
   by P1 item 3): the honest 404 with the omitted nav item is the
   documented reduction from the admin actions tails landing (`b5923ed`,
   `92d2e87`'s stale-pin fixes keep it as the negative pin)
   (`docs/RELEASE-NOTES-v1.3.md` §4; `docs/compat/ui-parity-survey.md`
   tick-20 note "scoped-workflows is the documented-reduced honest 404").
   The admin FRAME landed (9fb8ffd) and MOUNTED by the store wave (630a6da) — P1
   item 3); the 404 + the omitted nav item stand until the store
   HANDOFF + mount flip. Size: — (rides P1-3's store window).

4. **Wiki unit gating — the web-UI arm LANDED (`a803843` + `4a04d46`);
   the API + git-HTTP arms stay.** The standing divergence narrowed to
   the loaded-false window on the web UI: the shell's wiki tab now gates
   on `ctx.repoHasWiki !== false` (ui-context gains `repoHasWiki`, the
   inverted polarity documented — `DefaultRepoUnits` INCLUDES TypeWiki,
   `unit.go:67-77`, so absent = render, explicit false = hide; the
   upstream pin `header.tmpl:165-169` wraps the tab in
   `Permission.CanRead(TypeWiki)`, `repo_permission.go:134-136`'s
   per-repo unit read AT RENDER TIME), wired render-time by
   `resolveUiRequest`'s EXISTING settings read (`4a04d46` — zero extra
   D1; a settings-disabled wiki loses its tab on every repo page;
   enabled/unsaved repos render identically, goldens no-regen held).
   Route-side was already correct (`wikiPrologue` loads settings fresh
   every request and 404-shells `!hasWiki` — MustEnableWiki parity, the
   arms pinned at `wiki.matrix:352`). REMAINING: the API layer consults
   no `repo_units` rows yet — every repo is treated wiki-enabled (the
   landed convention; `specs/wiki.md` §1, the `api.go:1391`
   `mustEnableUnit(unit.TypeWiki)` cite) — and the git-HTTP twin carries
   the same posture (`specs/README.md` wiki row: "unit gating is the
   remaining future batch"). The `repo_units` substrate exists (the
   actions/packages units write it in lockstep — `c1cefaa`), so the gate
   is a plain batch across the two remaining layers. Size: **M** (API +
   git-HTTP only).

5. **The archived-release release arms — LANDED to upstream's bare 500
   (`0b39750`); the 201 divergence retired, the decide-or-reaffirm
   settled.** The chain verified hunk-by-hunk at the pin: the /releases
   subtree carries only `mustEnableUnit(TypeReleases)`
   (`api.go:1408-1429`) — `mustNotBeArchived` NEVER runs for releases,
   no 423 exists at any level; the gate lives INSIDE `createTag`
   (`release.go:75-78`, `rel.Repo.MustNotBeArchived` →
   ErrRepoIsArchived) AFTER the duplicate check and BEFORE the
   `!IsDraft` gate — drafts are refused too — reached by BOTH
   CreateRelease (`:187`) and UpdateRelease (`:269`, unconditional,
   draft states included); NEITHER API handler maps it (create falls to
   APIErrorInternal `:285-287`, edit the bare `:379-382`) → the bare 500
   with the prod-blanked body (`context/api.go:117-130`), which ours
   renders through the `ef2c049` untyped-throw convention. Implemented:
   the archived gate in `createReleaseWithGitTag` (after the 409, before
   the draft block) and `editRelease` (step 0); pins flipped (201 →
   500+body+no-ref-no-row; draft-create 500s; 409 outranks the archived
   500; archived edit 500s row-untouched; archived publish-from-draft
   500s pre-tag-arm). SPEC-0005 §2.3 rewritten + §4.14's matrix row;
   releases 56/56, compat 172/172, check:api PASS. Size: — (landed).

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

7. **The review-webui rendering remainder — LANDED COMPLETE (`c732812`,
   the row's last four S pieces; read items 10 and 11 for the earlier
   landed drifts' detail).** Source:
   `docs/usability/parity-review-webui.md` top-drifts list; the New-PR
   button, empty-repo anon arm, branches order, and collaborator grants
   LANDED in v1.3.1 (`d52361b`, `56df8a6`, `7f9241e`); the two Vue
   islands (merge box, branch selector) LANDED per item 10; the timeline
   anchor split, the issues/pulls rows, and the header tab strip's four
   pieces LANDED at `7e72149` per item 11 (with the merge-line anchor
   premise corrected there). The four REMAINING S pieces all LANDED at
   `c732812`, each verified at the pin: (1) the home row's Go-to-File +
   Add-File (view_content.tmpl:75-105 — the search container verbatim
   over the landed wave-39 aux, the writer-gated Add-File dropdown, plus
   the writer-only #new-pull-request anchor); (2) the issues list's
   `#issue-filters` skeleton + Labels/Milestones buttons (list.tmpl:25-26
   live routes, filters.tmpl's toolbar skeleton with the select-all
   checkbox disclosed inert until rows carry checkboxes, the hidden
   #issue-actions twin); (3) the releases Source-Code pair
   (release/list.tmpl:78-89 verbatim, gated !isDraft, serving list AND
   detail — the module's stale "web archive route does not exist"
   reduction corrected in place: wave-32's GET + `4e6d1cc`'s POST both
   serve; the tags page's twin stale note + mount closed by its owner in
   the same window, tag/list.tmpl:36-39); (4) the Code tab's
   ref-preserving href (header.tmpl:100-101 — branchName +
   refTypeNameSubURL threaded through UiContext and resolveUiRequest's 34
   pure insertions; the disclosed cost: one doubled listRefs on those
   page loads; no-ref pages' plain href IS upstream's landing per
   web.go:1760-1761). Pins: render 28/28 (+4), issues matrix 37/37 (+4),
   releases 35/35, code-tab-ref 6/6 NEW (mounted, real receive-pack
   seed), goldens 91/91 (7 files re-baselined, pure insertions; icons
   allowlist 76), a11y 88/88. Size: — (landed).

8. **The review-git protocol remainder — the receive-pack caps pair and
   the protocol-v2 pair LANDED (`e454a75`); export-subst LANDED
   (`761ff28`); the attr-macro arm and the ladder-ordering drifts
   stay.** Source:
   `docs/usability/parity-review-git.md`; the archive POST arm and the
   GCM realm LANDED in v1.3.1 (`4e6d1cc`, `85fa2ff`); the LFS locking
   family and the archive attribute semantics LANDED in the window since
   `0fdc267` (`7b589c7`; `5365236`). LANDED at `e454a75` (byte-observed
   on stock git 2.43.0 under GIT_TRACE_PACKET; the full 29-script engine
   sweep PASS=29, worker git-http 119/119, real-client acceptance incl.
   `git clone --filter=blob:none` end-to-end with the lazy-fetch checkout
   round and `git push --atomic` + `-o echo` over HTTP — the stale-atomic
   failure byte-identical against reference http-backend, a stock-client
   quirk disclosed; NOTICE carries both units' rows): receive-pack
   advertises + honors atomic/push-options/report-status-v2 (push-options
   advertised UNCONDITIONALLY per upstream's
   `receive.advertisePushOptions=true`, `modules/git/config.go:40-42`;
   the section grammar has NO count pkt-line and NO trailing LF,
   EOF-mid-section ends it — git's read_push_options bug-compat; ATOMIC
   via a WRITE-FREE verdict pass in commitPush, hook rejections funnel
   the all-rejected path; report-status-v2 honored with zero option
   lines — upstream's own no-proc-receive posture; extraRefUpdates stay
   best-effort outside the guarantee) and protocol-v2 answers
   ls-refs=unborn byte-identically + parses fetch=filter
   blob:none/blob:limit=<n> (strict > boundary byte-verified; promised
   blobs stay unmarked with the directly-wanted-blob lazy-fetch
   carve-out; under a filter the want gate relaxes to upstream's
   has-object rule; both full-clone fast paths exclude filtered
   requests). **LANDED slice 2026-10-31 — export-subst (`761ff28`, the
   staged arm salvaged complete from the sixth wall, 23/23 own-eyes on
   the tree):** the pretty-format expansion over the ARCHIVE COMMIT's
   fields, worker-side (`api/services/export-subst.ts` + the walk's
   hook in `api/services/archive.ts` — the engine untouched, the
   recorded "verify no NOTICE row was owed" open item resolved by that
   same fact): the empirically-observed placeholder set (%H %h %T %P,
   the author/committer identities incl. %aI/%cI RFC3339 and %aD/%cD,
   %s %f %b, the %d/%D ref decorations resolved against the walk's ref
   context, the %%/%n literals), the multi-line marker semantics, and
   the UNTERMINATED-marker steal (an open `$Format:` consumes to the
   next `$` — git's observed behavior, the disposition pinned);
   substituted at the walk's blob stream, export-ignore unchanged;
   archive.test 16→23 (each placeholder class from a fixture commit).
   STILL OPEN (engine-scope items separated in the review): the
   ladder-ordering drifts (403-before-auth arms, the
   wiki-doesn't-exist pkt-line, dumb-HTTP absent — documented).
   **LANDED slice 2026-10-31 — the attr-macro arm (`599d655`):** the
   engine-boundary decision
   recorded (`docs/research/attr-macro-boundary.md`): macro expansion
   belongs in the attribute MATCHER, and the matcher is ENGINE-side —
   `src/git/attributes.ts`, the attr.c analog, the language moved verbatim
   out of the worker's archive walk (the board's "packages/git-engine's
   attr-pattern compilation" premise was wrong as-built — 5365236 compiled
   worker-side; the decision doc corrects it against the layering pattern:
   every git-semantics re-implementation lives engine-side with a real-git
   tsx gate) — the walk threads one macro registry root→leaf and resolves
   expanded rules unchanged. Every arm pinned against stock git 2.43.0
   fixture repos (builtin `binary` seed + user override, top-level-only
   definitions, right-to-left within-line first-assignment-wins, silent
   cycle stop, value/unset/`!` non-expansion, redefinition last-wins,
   `!attr` bodies, dir-prune-beats-macro-reinclude) and
   differential-checked live by the new engine gate
   `check-archive-attrs` (24/24 vs real `git archive`, mutation-checked
   both ways); macro-carried export-subst flows into the landed expansion
   unchanged. archive.test 23→31 (route-level macro repo + white-box
   arms; the "macros are outside the subset" pin flipped). NOTICE rows
   recorded (module + mod.ts export set — the P3-11-recorded mod.ts
   freeze folds for this arm, its own policy unit). Size: **M**.

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
    rows are now ALL LANDED (the timeline anchor split + the header tab
    strip at `7e72149` per item 11; the remaining four pieces at
    `c732812` per item 7 — nothing of item 7 is open).

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
    open from item 7: NOTHING — the four remaining pieces (the
    Go-to-file/Add-File home row, the `#issue-filters` toolbar skeleton
    + the Labels/Milestones buttons, the releases Source-Code archive
    rows, and the Code tab's ref-preserving href) LANDED at `c732812`
    (item 7's record — the row is closed).

12. **The owner-store KV prerequisite — LANDED (`4bffff0`, the
    owner-store wave; the schema hunk rode `bf7be9e`, migration 0048
    `26ce795`).** Upstream persists OwnerActionsConfig as a user_setting
    KV row (`config.go:38-46`) — upstream's own answer is the GENERIC KV
    (setting.go:22-29, eight keys on the one table, setting_options.go), so
    the landed home is `user_settings_kv` (column-for-column) + the
    store service `services/actions/owner-actions-config.ts`
    (Get/Set/parse/serialize, the Go-marshal bytes, the absent-row
    FromDB→permissive default; the one adaptation: the allowed ids are
    this deployment's TEXT repositories.id). Both general pages' POST
    arms are LIVE over it (upstream posts both forms to the page URL):
    the `applyOwnerActionsGeneralForms` port of UpdateGeneralSettings
    (`general.go:100-161` — the within-owner add resolution + the :125
    JSONError early return, the remove-all arm, the no-refusal
    EnumValue arm, the save) mounted at both scopes with the
    guard-first prologues, and the route-level matrices pinned in both
    page suites. The `6bdd91f`/`180b409`-era engine-owned-404 reduction
    and the org module's HANDOFF tail are retired.
    Size: **S–M** (one store wave + two POST arms — closed).

13. **Amendment to item 6 — the tail's in-flight arms at this update
    (sibling-owned; do not re-dispatch; not landed until committed).**
    (a) The E9 deferral record — comment-create's missing locked-issue
    403 gate + the accepted empty body, the (e) honorable mentions — the
    deferral-record unit is in flight (carried from the `95cdcaf` block,
    still uncommitted). (b) The ~15 model.ts cite renumbers (the
    cite-audit pass's mechanical drift finding, `ae1de6d`) — still in
    flight. (c) The (d) auto-init files honorable mention (auto-init
    repos missing `gitignores`/`license` files) — the tree's uncommitted
    repo-init-templates unit (`apps/worker/src/api/services/repo-init-templates.ts`
    + the `src/api/data` gitignore/license catalogs + their consumer
    wiring) matches it and is in flight. Each lands against item 6's
    ledger; no new decision.

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
   the admin-monitor-cron golden (`df348c8`) and made the feed XML goldens
   landable; the wallclock audit's follow-up list tracks the family
   (`docs/research/render-wallclock-audit.md` §Recommended follow-ups):
   (a) the harness route-clock hop for the feed XML goldens — LANDED
   <pending> (the orchestrator fills the landing hash): the `ui/index.ts`
   call sites read `routeNow()` (`df348c8`), the RSS trio landed as
   `abd512f`, and the `.atom` twins (releases/tags/user) closed the audit's
   list — six route-driven feed goldens over the pinned clock; (b) the
   API-tier route clocks (`toApiCron` in `api/routes/admin-degenerate.ts:339`,
   the heatmap minute-cutoffs) — only if API JSON goldens ever land; (c) the
   class-(c) stored-object writers: `wikiPerson`'s clock into wiki commits
   and the `mergePerson`/`mergePersonOf` twins ignoring `MergeInput.now` —
   needs engine-level object writes, "a wave of its own". The
   artifacts-preview page clock LANDED in v1.3.1 (`74df9ad`, the
   ARTIFACT_PREVIEW_CLOCK seam + the signed-URL tail golden) and is no
   longer a candidate. Sizes: (a) — (landed), (b) **S**, (c) **M**.

3. **The cleanup-rule preview's PackageID-filter upgrade note — LANDED
   (2026-10-31).** The note's condition held: `searchVersions` grew the
   `packageId` option — upstream's filter verbatim
   (`PackageSearchOptions.PackageID`, package_version.go:194; ToConds'
   `package.id = :id` arm at :222-224 over the SearchVersions INNER JOIN
   :309-315) — and both settings-pages loaders pass it directly (the
   shared/packages.go:158-162 option set), retiring the unique-key
   reduction AND the `RULE_PREVIEW_VERSIONS_LIMIT = 10_000` stand-in (the
   constant is gone from org-settings-packages.tsx and from the twin's
   re-export). The paginator question pinned: upstream does NOT paginate
   the preview (the :158-162 call passes no `Paginator` →
   searchVersionsBySession :297-306's paginator-less `Find`, and
   cleanup_rules/preview.tmpl ranges the full survivor table — no pager),
   and the landed page already rendered that shape — so `searchVersions`
   mirrored upstream's fork rather than rebuilding the page: page/limit
   passed rides the FindAndCount shape (unchanged for every landed
   caller — verified all pass both), absent runs the unbounded Find with
   count = the row length. Parity pins: model.test.ts (packageId
   selectivity within owner+type, the undefined/0 no-filter defaults, the
   12-row unbounded arm) and both settings-pages suites (the
   12-candidate preview rows, identical before/after).

4. **SPEC-0011's queued engine residual: D3 + the unpinned rows — RESOLVED
   before dispatch (`6545edd` the D3 fix + `849885e` the rows 10-11 pins,
   2026-10-28); verified and closed 2026-10-31.** The row was written
   against the ledger's ORIGINAL state; the D3 engine-fix unit and the
   rows-10/11 pin unit had already landed by the time P3-4 dispatched, and
   the ledger was amended in place (its D3 entry reads FIXED, §5 reads
   PINNED for both rows). The dispatching unit's premise was stale; per
   the brief's stale clause it verified instead of re-fixing: the
   `published` flag gates the lease release exactly as recorded
   (`compaction.ts:216,242,277`), NOTICE.md rows 142-144 carry the
   deviations, and the pins exist — check-compaction §5.3 graceful
   lease_lost + graceful mid-write failure (`e2e/check-compaction.mjs:674`,
   `:723`, mutation-tested per NOTICE.md:143) and check-fault-matrix §7.2
   rows 10/11 (`e2e/check-fault-matrix.mjs:823`, `:917`). The row's
   still-open remainder (ledger §6 item 3, the three M3.5 scripts missing
   from `e2e/README.md`'s list) also landed — `f9a63ec` added the
   check-fault-matrix / check-correctness-tier / check-capability-matrix
   section. Gates own-eyes 2026-10-31: the FULL 30-script engine e2e
   family PASS=30 FAIL=0 (incl. check-compaction 10/10, check-fault-matrix
   6/6, and the receive-path scripts check-correctness-tier 7/7,
   check-receive-caps 12/12, check-push-origin 6/6), engine `tsc
   -p tsconfig.build.json` clean + dist-types regenerated, root `pnpm
   typecheck` exit 0. Nothing remains of this row.

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
   absent `email_hash` table — **that arm RESOLVED in flight (2026-10-31,
   uncommitted at write time)**: migration 0055 adds the table
   (models/avatars/avatar.go:32-37's shape — `hash` PK, the
   `(email, hash_type)` composite unique); services/avatars.ts lands both
   lifecycle halves (saveEmailHash avatar.go:72-86 with the
   insert-discard swallow, getEmailForHash avatar.go:58-69 — a Worker has
   no process cache, so the D1 read IS the GetEmailForHash lookup); and
   the `/avatar/{hash}` route (src/web/avatar-serving.ts) flips from the
   hard-coded empty to the resolved arm, with the
   `ctx.ServerError` plain-text 500 for lookup failures. At the frozen
   picture settings the observable redirect is unchanged (hit and miss
   converge on the default avatar — upstream is identical at its own
   defaults), and the write path's production callers are upstream's
   federated fast-link surfaces (avatar.go:122-130) — frozen off here, so
   rows populate when those surfaces land (the ui avatar-by-email template
   helper, the contributors graph). The v1.1/v1.2 release-note lines
   carrying the old "resolves empty by design" wording are historical
   records, left as written. Still carried: no `/assets` fallback target.
   Recorded, not re-sized; each is a future SPEC's call. Size: **S–L**
   depending on which reopens.

7. **The serializer counts tail + the language side-store — the
   `last_login` half is IN FLIGHT via the store/schema wave; the
   language half stays a store decision.** The counts seam LANDED in the
   window since `0fdc267`: `followers_count`/`following_count` render
   the requester-visible live totals (the documented
   `ApiUserFollowCounts` divergence — a private follower never counts
   for a viewer who cannot see them; `58283bd` + the `GET /user` self
   wiring `40120ae`, with the no-binding degrade `9f883d0`). The
   `last_login` half — the D1 row had NO column (definitive over schema
   + migrations 0001-0044 at `58283bd`'s write time) — now rides the
   IN-FLIGHT store/schema wave: the working tree's uncommitted migration
   `0047_fancy_chronomancer.sql` adds `users.last_login_at` (the column
   labeled P3-7 in the schema diff; upstream's `User.LastLoginUnix`,
   set at session MINT not per-request verify, rendered authed-gated).
   NOT landed until committed — see the in-flight block. The `language`
   half is untouched by the wave: `language` renders `''` on BOTH
   serializers by decision (no users column; upstream keeps it in a side
   store; the review graded the drift cosmetic — `cf269f4`'s in-comment
   note; `docs/usability/parity-review-api.md`) and still needs the
   store decision first (a SPEC-0005 call). Size: **M** for the language
   store (the last_login half rides the in-flight wave).

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

10. **`/raw` LFS resolution follow-up — LANDED (`cd895f6`); the
    disclosed v1.3.2 surface is closed.** v1.3.1 landed the file-view
    LFS badge and corrected the premise (upstream `/raw` does NOT
    resolve LFS at the pin — `SingleDownloadOrLFS` is the `/media` group
    only). The follow-up's link flip landed: upstream overwrites
    `RawFileLink` for LFS-pointed files (`view_file.go:210-212` —
    `ctx.Repo.RepoLink + /media/ + RefTypeNameSubURL +
    PathEscapeSegments(TreePath)`) and EVERY template consumer reads the
    overwritten value (`view_file.tmpl:2/:49/:64/:100/:123-135`), so the
    single `rawLink` composition flipped wholesale (`file-content.tsx:190`
    over `links.ts`'s `mediaFileLink` mirror); the `/media` family was
    already landed (`77e8567`, family media-file) — zero route changes.
    Pins +2 (big.bin + ghost.bin view links `/media/branch/main/...`,
    each flipped link live-fetches 200; README/NOTES/logo/broken.bin
    keep `/raw` — broken.bin the malformed-pointer guard). One ownership
    deviation disclosed + coordinator-blessed mid-flight: the
    composition lives in `file-content.tsx` over `links.ts`'s helper,
    not the dispatch's named `file-view.tsx`. Goldens byte-identical
    (none of the golden fixtures render an LFS view); 17/17 + 91/91 +
    a11y 88/88. Size: — (landed).

11. **The annotated-tag read-tag RPC (engine boundary) — IN FLIGHT at
    this update; do not re-dispatch.** The tags API's `message` is
    always empty because the engine boundary carries no read-tag RPC
    (`readCommit` peels; `parseTag` unexported; only the write-side
    `serializeTag`) — F8 of the git-e2e wave, flagged to the engine
    owner (`1677dbb`; the deviation recorded in the git-models/routes
    headers; finding origin `27353a2`). The boundary wave is NOW
    uncommitted in the working tree (`packages/git-engine`
    `src/repo.ts` + `src/git/objects.ts` modified, the new
    `e2e/check-tag-read.mjs` check) — held, not counted landed until
    committed; the boundary-decision premise stays as the record.
    Size: **M** (engine + API), **engine-owner** (in flight).

12. **The `/user/settings` remaining serial pair — LANDED as the
    true-residue fix (`e8ef89d`), with a premise correction.** The row's
    named page-loader pair was ALREADY parallel (`loadUserSettingsPageData`
    is a Promise.all with the `06b3384`-era F1 cite — the premise
    stale); the true residue sat in `resolveUiRequest`'s prologue:
    `loadManifest` awaited BEFORE `resolveViewer` (whose chain owns
    verifySession's users-row read) serially on every UI request. Now a
    Promise.all pair (the manifest is independent; the bell count still
    follows the viewer — it needs `viewer.id`). Behavior-identical;
    session/wave12/index/goldens neighbors green (the 8 settings-nav
    golden reds in the live tree at landing time were the
    actions-subtabs sibling's in-flight tabs — attributed, not that
    change). Size: — (landed).

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

16. **The SPEC-0016 long-tail `go` family — LANDED (2026-10-31, the
    registry carried TWELVE protocols at that landing).** The Go module
    proxy protocol
    (`routers/api/packages/goproxy/goproxy.go` + `modules/packages/
    goproxy/metadata.go` at the pin): the five read arms (`@latest`,
    `@v/list`, `.info`/`.mod`/`.zip`) + `PUT /go/upload` + the sumdb probe
    404, the x/mod/semver.IsValid version gate (pseudo-versions are
    canonical semver with a prerelease), the go.mod text as a version
    property, no new tables. Verified live with a real `go` client (mod
    download + unpinned `go get` via `@latest`, the go.sum h1 equals
    x/mod dirhash over our zip); suite 22/22, neighbors 58/58, check:api
    PASS. The as-built (endpoint map, the 404/410 posture, reductions,
    both live batteries) is `specs/0016-packages.md`'s go section. The
    §2.1 long-tail row RESOLVED since this landing: cargo + swift +
    rubygems at the protocol wave `5721dcc` (FIFTEEN), chef + composer +
    conan + cran + pub + vagrant at the six-minor wave `28a40b5` — the
    registry carries TWENTY-ONE protocols, the wave's declared FULL PARITY
    with the pin's package surface. Record note for the wave's owner: of
    that landing-time ten-family list, conda + terraform remain
    module-absent on our side (the pin routes both — `api.go:263`
    `/conda/*` and `:474` `/terraform/state`) — whether they sit inside
    the wave's parity claim is its own record to adjudicate. Size: —
    (resolved).

---

## How to consume this board

- Items 1–3 and 7 of P1 are SPEC-0012 work with a stated dependency order:
  OQ-1 is RESOLVED (2026-10-31 — the decision-record addendum at the tail of
  `specs/0012-actions-feasibility.md`; see the P1-1 row's amendment for the
  P/S/E tier decomposition), so M3's P+S tiers are dispatchable without any
  open question in front of them, and C5 and C10 land behind the
  emitter/substrate M3 provides. Item 4 (auths) and items 5–6
  (M6/M7) each open with their own SPEC-attachment per the recorded
  rules — none is dispatchable as a bare UI/store unit.
- The v1.3.1 additions (P2-5 through P2-10, P3-7 through P3-13) and the
  parity-wave additions (P3-14, P3-15) are mostly dispatchable small
  batches over landed substrate; P2-8's remaining attr-macro arm and
  P3-11 need their boundary decisions first. Verify the in-flight block
  at the top BEFORE dispatching any of them — the doc-time block it
  replaced is fully resolved (the header note), and the block's items
  (the store/schema wave, the owner-store wave, P3-11's engine wave, the
  P2-6 tail items, the archive pin unit) are sibling-owned.
- P2 items are all dispatchable over landed substrate except the
  scoped-workflows pieces (P1-3).
- P3 is the sweep list for gap waves between feature landings; the doc-debt
  item is safe to take anytime. P3-9 is a dated observation, not a work
  queue — clear it after the Oct 31 11:00 UTC check.
