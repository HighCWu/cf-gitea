# Remaining API Inventory — EMPTY: the frozen contract fully declared

Refill ammunition for the wave pool: every operation the frozen contract
declares that our `/api/v1` spec does not, classified by what it would take to
declare it, then ranked into dispatchable batches. Companion to
`ui-parity-survey.md` (the web-UI gap inventory) — this file is the API-side
equivalent. **Fully regenerated 2026-11-04** at HEAD `868f3e6`
(`868f3e6d28419de57e5b3a7a3344cc52df6515e1`) after the previous edition (regen
at `fec5c71`, declared=490,
then eight maintenance ticks through `f696a21` the same day) sat stale through
the v1.3 wave: every reading it carried — **490/298, 64 ops FEATURE-ABSENT,
"the actions/packages feature wall"** — is dead. This regen finds the frozen
contract **fully declared**: the raw diff is **zero**, the dispatchable pool is
empty, and there is nothing genuinely unmounted left to re-baseline. The
64-op wall emptied in two features:

- **Package registry, 10 ops** — SPEC-0016 M1 (`8cdf44a`) declared the nine
  `/packages/*` operations plus `GET /admin/packages` (490→500).
- **Actions runtime, 54 ops** — SPEC-0012's gate lifted, then the six-commit
  board arc `fbcfe5e` → `f88f8ee` → `ed5e26f` → `ad8aff8` → `df85f21` →
  `d22cb51` declared the runners, runs/jobs listings, artifacts, admin, and
  runs-deep families, reaching **full declaration (554/554)** at `d22cb51`.

The full ladder with per-family reconciliation is below; the historical
sections at the bottom are frozen at the old edition's last honest measurement
and kept as record only.

- **Sources / method**: frozen contract
  `apps/worker/src/compat/contract/v1-swagger.generated.json` (**554**
  operations across **350** paths: repository 229, user 98, organization 88,
  issue 72, admin 33, miscellaneous 14, package 9, notification 7, settings 4 —
  re-walked at this regen, unchanged) minus the declared set that
  `node scripts/check-openapi.mjs` reports (**554** operations across **350**
  paths, measured 2026-11-04 in the working tree at HEAD `868f3e6`; checker
  ends `PASS`, tier-1 coverage 78/78 paths, 129/129 operations). Raw diff:
  **0 undeclared**, and the reverse subtraction is also **0** — no declared op
  sits outside the contract either (all 554 shared ops carry the contract's
  own operationId, so both subtractions are unambiguous set operations on
  `METHOD path`). Every family — repository, organization, user, admin,
  package, issue, notification, miscellaneous, settings — is **fully
  declared**.
- **Reproducing the diff** (the numbers above fall out of exactly these two
  commands, run from the repo root):
  1. `node scripts/check-openapi.mjs` — prints `declared: 554 operation(s)
     across 350 path(s)`, every declared op as `[ok] <METHOD> <path>
     (<operationId>)`, the tier-1 line `78/78 paths, 129/129 operations`, and
     `PASS`. The checker hard-fails any declared op missing from the contract,
     so declared ⊆ contract.
  2. `node -e` walking `paths` of the contract JSON with the checker's HTTP
     method set (`get put post delete options head patch`), printing
     `<tag> | <METHOD> <path> | <operationId>` per op (554 rows); subtract the
     checker's 554 → **0 rows remain**, both directions.
- **Upstream pin**: `fc4936884584a41931906553d96c2601d750e6ef`
  (v1.22.0-rc1-3919-gfc49368845); every `gitea/…` cite below is that commit.
  Verified unchanged at this regen (`git -C gitea rev-parse HEAD`).
- **Landed-store references**: `apps/worker/src/db/schema.ts` (**109 tables**,
  migrations 0000–0073 on disk), route modules under
  `apps/worker/src/api/routes/`, services under
  `apps/worker/src/{services,api/services,repos,issues,webhooks}/`.

## Classification legend

- **IMPLEMENTABLE-NOW** — table-free, or rides an already-migrated store. The
  batch only writes route/service code (plus spec declaration).
- **TABLE-DEPENDENT** — needs new D1 table(s) (or a column). The missing store
  is named with its upstream model pointer; the batch owns one migration
  (numbers are **provisional** — migrations run 0000–0073 today; assign
  next-free at merge, drizzle journal regenerated then). The class is
  empty at this regen.
- **RUNTIME-ONLY** — declarable only with documented runtime-only response
  exceptions (the `RUNTIME_ONLY_RESPONSES` table in `scripts/check-openapi.mjs`,
  shared file — orchestrator applies or designates), typically because the
  upstream behavior is degenerate on Workers (no filesystem, no signing key).
- **FEATURE-ABSENT** — gated on a whole feature (actions runtime, package
  registry) that needs its own SPEC; listed with the pointer, not batched.
  The class is empty at this regen — both of its former members landed.

## Family summary (remaining)

| Class | repository | organization | user | admin | package | issue | notification | miscellaneous | settings | **total** |
|---|---|---|---|---|---|---|---|---|---|---|
| IMPLEMENTABLE-NOW | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| TABLE-DEPENDENT | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| RUNTIME-ONLY | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| FEATURE-ABSENT | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| **total** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** |

Declared **554/554** — the ceiling itself. There is no remaining
declaration work at this upstream pin; any future rows here require the
frozen contract to grow (an upstream pin bump), not route work.

---

## The wall's closure — how the last 64 declared

Each row is a committed landing; the declared-count deltas are the commits'
own messages, and the ops reconcile exactly against the old edition's
per-family tables (repository 33, organization 7, user 7, admin 8,
package 9 = 64):

| Ops | Family slice | Commit | Declared |
|---|---|---|---|
| 10 | **packages** — the nine `/packages/*` ops + `GET /admin/packages` (SPEC-0016 M1: the model, generic protocol, cleanup; the registry has grown far past the API since — CommonRoutes closed 23/23 groups at `ce9facc`) | `8cdf44a` | 490→500 |
| 15 | **runner management × repo/org/user** (list/get/delete/patch + registration-token per scope — the board's P1-7 triage first) | `fbcfe5e` | 500→515 |
| 6 | **runs/jobs listings × repo/org/user** (getWorkflowRuns + listWorkflowJobs twins — P1-8) | `f88f8ee` | 515→521 |
| 4 | **repo artifacts quartet** (getArtifacts/getArtifact/downloadArtifact/deleteArtifact + the undeclared raw fifth arm — P1-10) | `ed5e26f` | 521→525 |
| 7 | **admin Actions family** (runners census/jobs/runs/token at the global 0-scope — P1-12; retired the old edition's stale "no-runner-tables" reduction) | `ad8aff8` | 525→532 |
| 8 | **repo workflows-extras** (workflows list/get/runs, disable/enable, dispatch, getWorkflowJob, job-logs — P1-9) | `df85f21` | 532→540 |
| 14 | **repo runs DEEP family** (tasks, run get/delete, attempts, attempt/recent jobs, logs, artifacts-of-run, approve/cancel/force-cancel, the rerun trio — P1-11; **full declaration reached here**) | `d22cb51` | 540→554 |

Note: the 490→500 packages jump is also recorded in the v1.3 index syncs
`4c8277d`/`b6b0180` — "the ten packages ops declared; remaining 54 = Actions
only". Per-family reconciliation:
repository 33 = 5 (runners) + 2 (runs/jobs) + 4 (artifacts) + 8
(workflows-extras) + 14 (runs-deep); organization 7 = 5 + 2; user 7 = 5 + 2;
admin 8 = 7 (Actions) + 1 (`adminListPackages`); package 9. Feature pointers:
actions = `specs/0012-actions-feasibility.md` (the upstream-parity gate lift +
control-plane milestones), packages = `specs/0016-packages.md`.

---

## In-flight

Empty — no undeclared operation is in flight, by definition: the diff is zero.
At this regen's measurement (`868f3e6`, working tree) the tree carried this
doc's own edit plus concurrent in-flight edits that carry zero declaration
surface (behavior work on already-declared ops — e.g. the repo-search
ordering arm — and test/UI files); the checker reports 554/350 `PASS` in
exactly this tree state (re-run at measurement). FN-10/FN-12's migration 0073
(`868f3e6`) is store strictness behind already-declared ops.

## Dispatchable batches

**None.** Nothing is undeclared. The API-declaration campaign this doc drove
(318 → 490 → 554) is complete at the `fc49368845` pin; remaining API work is
parity-deepening WITHIN declared operations — behavior arms, wire shapes,
runtime-only exception honest-keeping (the `[warn] (b)` lines the checker
already documents) — which belongs to the census/SPEC lanes, not to this
inventory. Re-baseline this doc only when the upstream pin (and with it the
frozen contract) moves.

---

## Historical ledger — the previous editions' record (frozen 2026-10-26, HEAD `f696a21`, declared 490/298)

Everything below is the prior edition's landing ledger, kept as history. Its
"stays at 490/298" claims were true only through `f696a21` — the
`f696a21..868f3e6` window (the v1.3 release freeze `88a04cb`, the v1.3.x
docs/board waves, and the closure ladder above) then emptied the wall this
doc once ranked. The previous edition's own header (eight maintenance ticks,
its 64-op FEATURE-ABSENT tables, its stale "actions/packages feature-absent"
headline — the claim this regen retires) is recoverable from git history at
the tick-8 docs commit `075f916`.

### Landed since the `c4577a7` edition (318 → 490)

The previous edition (commit `c4577a7`, declared=318) listed 11 numbered
batches + 4 long-tail candidates. **All 15 landed**, and both batches the
regen left live landed after it. REG deltas below are the committed
`declared X→Y` jumps (they sum: 318 + 172 = 490; rows 1–9 are the previous
edition's ledger, 10–11 landed after the `99d21c5` regen):

| # | Batch | Ops | Store / migration | Feature commit(s) | REG commit (declared) |
|---|---|---|---|---|---|
| 1 | `wave-api-hooks-scopes` (15) + `wave-api-admin-degenerate` (5) + the free `repoMirrorSync` declaration (1) | 21 | table-free; RUNTIME_ONLY gate entries ×9 | `5b704c5`-era modules (hooks-scopes, admin-degenerate) | `4e90180` (318→339) |
| 2 | `wave-api-avatars` | 6 | R2 avatar store, table-free | `d7f5646` | `8afcfdd` (339→345) |
| 3 | `wave-api-tokens-times-aggregates` + `admin-org-extras` (batch 1's remaining 12; `repoMirrorSync` went with #1) | 12 | table-free | `bfccc02` | `76e8ca4` (345→357) |
| 4 | `wave-api-deploy-keys` | 5 | `deploy_keys` (0020) | `4af12a9` | `a01c464` (357→362) |
| 5 | `wave-api-secrets-variables` | 23 | `secrets` + `action_variables` (0021) | `a5506d2` | `9f92950` (362→385) |
| 6 | `wave-api-blocks` (8, 0022) + `wave-api-push-mirrors` (5, 0023) + `wave-api-tag-protections` (5, 0025) + `wave-api-wiki` (6, table-free) | 24 | see left | `1934664` / `8f0aa90` / `a80878c` / `d3362b1` | `51d3c74` (385→409) |
| 7 | `wave-api-git-hooks` | 4 | table-free (R2-persisted edits) | `5b704c5` | `12ab90d` (409→413) |
| 8 | `wave-api-projects-repo` **stage 1** (repo scope) | 21 | `projects`/`project_columns`/`project_issues`/`project_workflows` (0024) | `0d5b480` | `fc123b0` (413→434) |
| 9 | `wave-api-oauth2-apps` (5, 0026) + `wave-api-badges-licenses-template` (5, 0027) + `wave-api-feeds` (3, 0028) | 13 | see left | `42ab6a5` / `f328d06` / `2ef9359` | `fec5c71` (434→447) |
| 10 | `wave-api-projects-org` stage 2 (the regen's in-flight batch) | 21 | rides the stage-1 store (0024) — no migration | `cc6d73e` | `20512c0` (447→468) |
| 11 | `wave-api-projects-user` stage 3 (the regen's one dispatchable batch) | 22 | rides the stage-1 store (0024) — no migration | `f38b218` | `c9a7ef7` (468→490) |

Non-op landings in the same window: `wave-22 tables` (`640d805`), `wave-23
tables` (`579e872`), `wave-blocks-enforcement` (`f5c0384` — 403 arms on 9
existing seams), engine-registry lifecycle fixes (`4f574e9`, `1da8f56`,
`5e2c418`), ui waves (`06eee50`), vitest timeout raise (`412facc`).

### After the 490 line — post-regen landings (zero new ops through `f696a21`)

Everything merged after REG `c9a7ef7` carried no new declarations through the
old edition's last measurement — the checker stayed at 490/298 (re-run at
that tick's HEAD `f696a21`). The units, grouped:

- **API parity**: blocks-enforcement-2 tail (`f2e1710` — the regen's
  in-flight arm set), license arms (`03d5fe4` + `04a2903` — the regen's
  in-flight license-detection), merge-delete guards (`faca961` +
  `66f5977`), starred-totals render (`207b566`), repo-delete action sweep
  (`389da18`), push-mirror outbound + orchestrator wiring (`b332e14` +
  `9bda9eb`), generate loose-carry (`6c54c1a`) + cleanup (`7f0d5a6`),
  first-push settle (`45631b7`), set-private-zero (`3163658`),
  star/watch counters (`528d369`), counters-2 (`3016c10`), delete-counters
  fold (`64e9b1b`), feeds-tail action rows (`64ade9f`), repo size
  (`3c58cce`), registry tombstone oracle (`e30660d`). The
  `5d9122c..7016ce9` window adds: merge-delete ladder completion
  (`2e3db28` — the fork-head after-merge delete; joins `faca961` +
  `66f5977` above), fork PR creation (`a16f60e` — cross-repo heads
  end-to-end: parseHead grammar + fork edge, anti-enumeration CanRead
  404s, merge-base computed in the head cell), PR head repo render
  (`0466356` — upstream's hidden-head gate, one visibility resolution
  feeding gate + perms), pull payload mode (`836f87a` — the
  ToPayloadPullRequest port: hidden forks render head.repo with
  AccessModeNone perms), annotated-tag carry (`ab5d300` — packed-aware
  partition; fixes both fork-generate and rename, which dropped even
  packed tags), archive ref convergence (`889b74a`), the payload sites
  tail (`7016ce9` — label-detach/assignee/review-submission/
  review-request emitters), and the generate/fork git-wire fix
  (`8828f43` — replicateRepoCopy brokers the §5.3 copy with UNCONDITIONAL
  loose carry; closes the generated-repo wire residual `bf8e56f`
  re-scoped OPEN). The `7016ce9..9b49cd2` window adds the release create
  empty-gate fix (`d24dc0f` — the gate switched from the never-synced
  `refs_version` observability column, which reads 0 on every production
  repo and 422'd every API release create, to `is_empty`; found by
  REDEPLOY14) + its fixtures correction (`4619c4f` — honest `isEmpty`
  seeding; discloses that `d24dc0f`'s own run was really 10-failed/25-passed
  behind a grep-masked exit code and brings the suite to the true 35/35;
  the gate change stands verified). The `9b49cd2..2310623` window adds
  nothing here — no spec-bearing landing; neither does the
  `2310623..58c6cf0` window; neither does the `58c6cf0..ae32b1a`
  window — its two api-side landings (`0db7087` the blob-excerpt
  machinery, `3502ee4` the lastcommit fragment) are UI-fragment
  services over already-declared reads, spec-bearing zero. The
  `ae32b1a..67adfb7` window adds the payload-stub arc (`3fcbe1a` —
  fork/mirror rendered from the existing columns; parent under OUR
  read-gate, the upstream FIXME's base-existence gate conceded to leak
  private bases so our tightening is the documented intentional
  divergence; mirror triple gated on row existence; search mode arms
  fork/mirror/source + collaborative honest-noMatch) and the repo GET
  full-payload swaps (`a55a725` — the two one-line `toApiRepositoryFull`
  swaps; parent + mirror schedule live on the detail GETs, lists keep
  the flat shape as the documented divergence), plus the renamed-fork
  PR head (`9ecb3e5` — the FindHeadRepo port: the bare arm resolves
  the FORK EDGE first, name-free and rename-immune by construction,
  path acceptance as fallback, chain climb maxLevel 10, flat-404
  anti-enumeration kept; the GET bare form rename-immune vs upstream's
  name-only — intentional, documented). The `67adfb7..f696a21` window
  adds the search filters (`e39adad` — the template/archived tri-state
  arms over the EXISTING repo search/list ops at upstream
  exact-equality, repo_list.go:391/520; `original_url` rendered
  NOT-mirror-gated — the plain-imports correction, create.go:236 — via
  the `SanitizedOriginalUrl` port with the WHATWG parse-fail→""
  divergence; zero new declarations) and the stuck-syncing sweep
  (`833961d` — both cron producers CAS-reclaim syncing rows older than
  the receive-lease TTL then re-enqueue same-tick via the landed
  two-step claim; push claims stamp `last_update_unix`; the NULL arm
  heals pre-deploy wedges on the first tick — behavior on the landed
  mirror ops, zero declarations, recorded as SPEC-0009 §2.6 +
  push-mirror-outbound §9.3 by `2e11713`/`edf5da1`).
- **Migrations 0029–0032** landed with them (`size_kb`, `num_stars`/
  `num_watches`, `num_forks` + `users.num_stars`, push-mirror sync state) —
  still 64 tables at the time; these are store work behind already-declared
  ops. (The store has since grown to 109 tables across migrations
  0000–0073, incl. the actions model's twelve tables and the packages
  registry's six — the closure ladder's stores.)
- **UI parity + web seams**: avatar-byhash seam (`bb67087` + mount
  `98d194d`, default-asset guards `239a4ac`), ui-parity-4 (`0b61554` —
  tags + labels pages), ui-parity-5 (`ca4eb58` — milestone detail/edit +
  fork form), the four diffpatch downloads (`79ef809`), the ui-parity-3
  rows landed (`ca81d5a`) — the row-level ledger is
  `ui-parity-survey.md`. The `5d9122c..7016ce9` window adds
  wave-ui-parity-6 (`1b41b60` — the archive download +
  `load-branches-and-tags` aux JSON) and wave-ui-parity-7 (`48101dc` —
  the tags delete write + `/tags/list` aux + the releases edit/delete
  tail). The `7016ce9..9b49cd2` window adds wave-ui-parity-9 (`1a7af64`
  — the `/blob/*` redirect + `tree-list` + `branches/list`) and the
  projects board (`9b49cd2`); the `9b49cd2..2310623` window adds the
  fileicon asset+lookup layer (`cdf683a` — the `/tree-view` gate's
  prerequisite, now committed), the attachments serving seam + its
  dispatch wiring (`5e082cd` + `2b5b898`), and wave-ui-parity-10
  (`fdaeaca` — the releases download tail, the `/render/*` family, the
  fetch-action 200-JSON arms on both redirect twins). The
  `2310623..58c6cf0` window adds the tree-view envelope (`831709f` —
  the C-family fragments row's final half: the Go-faithful assembler
  with the `goJsonString` port, submodule/symlink arms; the ws1009
  posture extended — fileicon rides a DYNAMIC import edge, ~12MB out
  of the startup snapshot, static re-kills the a11y worker) and the
  attachments credential walk + its page-domain consumer re-wrap
  (`7cd1ce9` + `58c6cf0` — token-first/session-cookie-fall-through
  order per the pinned web group, rotation Set-Cookie re-wrapped on
  every response and again at the consumer, the browser_download_url
  owner probe added). The `58c6cf0..ae32b1a` window adds the
  repo-scoped projects row (`ae32b1a` — list + board + writes +
  workflows over the 64-op store; the `has_projects` toggle MODELED —
  no divergence; the Hono `:repo{[^-].*}` constraint convention
  discovered+applied and recorded), the blob-excerpt machinery
  (`0db7087` — the full `BuildBlobExcerptDiffSection` port, services
  only, route handoff documented) and the lastcommit fragment
  (`3502ee4` — the batched per-path commit-info loader + the
  `view_list.tmpl` DOM, route handoff documented; both fragments'
  routes ride a sibling's `index.ts` window). The
  `ae32b1a..67adfb7` window adds the index window itself (`67adfb7` —
  BOTH fragment routes mounted: blob-excerpt stage-3, fragment +
  expand buttons + anchors, with the WIKI TWIN discovered at
  web.go:1618 (`/{owner}/{repo}/wiki/blob_excerpt/{sha}`) mounted
  beside it via the wiki-cell swap + `hasWiki` gate; lastcommit
  HANDOFF-exact per the `3502ee4` mount plan; the file-list
  fetch-attrs flip — four attrs verbatim, opt-in `loaderCommitOid`;
  the survey's two IN-FLIGHT fragment rows flip LANDED there). The
  `67adfb7..f696a21` window adds the org settings group + teams/edit
  (`8380cf0` — the survey's FINAL numbered row: the options combo +
  avatar pair + danger-zone writes as three details-forms over the
  landed org APIs, teams/edit over every landed `editTeam` field,
  `max_repo_creation` honest-absent, `repo_access`
  dead-control-unrendered; the settings tabs split off as their own
  ABSENT survey row), the notifications WIP-draft glyph (`8786651` —
  upstream's IsWorkInProgress is a pure title-prefix check and the
  landed item carries title, so the draft arm renders), and the
  UNMOUNTED page modules (`f26d65b` repo-migrate, `ec07fb6`
  activity-feeds + its glyph allowlist exact `f696a21` — complete
  modules whose mounts ride a window; the `notification-subscriptions`
  module and the org-settings-hooks follow-up were still uncommitted
  in the tree at measurement; all spec-bearing zero).
- **Test/docs**: vitest contention config (`e4ebb9d`), release notes
  (`1c44086`), P0 deploy evidence (`d28d953`, `3d76cc6`), push-mirror SPEC
  (`998a4de`), schema-docstring catch-up (`e6ccf9c`). The
  `5d9122c..7016ce9` window adds: the ws1009 mitigation (`8b0ce41` — the
  `?raw` frozen-contract helper eliminating the 17-runner-death crash
  class) and its sweep completion (`cc196d3` — the last direct contract
  import converted), the SPEC-0001b §5.3.1 as-built repo-copy divergence
  record (`aa95c90` — 14 rows) + the §5.3 annotated-tag fidelity record
  (`eeb8270`), the forks `num_forks` header fix (`945a47d`), the archive
  service-doc convergence note (`9f6b86a`), the auth identity rig
  (`4588475`), ws1009 research (`ff4172a` draft + `aff64a6` measured
  repro), the invariant fixture diet (`3169e33`), P0 deploy evidence
  (`bf8e56f`), the release-notes addendum (`b74b2d2`), and the SPEC-0001b
  §5.3 as-built redesign record (`640c202` — the Worker brokers the copy
  pass, loose closure unconditional). The `9b49cd2..2310623` window adds
  the releases fixture isEmpty seeding (`3b3a3ae`), P0 deploy evidence
  (`305ddc8` — the toolkit's debut: 7 scripted batteries, generate
  strict-clone PASS, the first forkpr-e2e production evidence, the
  release-gate CLOSED 201/422), and the tick-4 docs commit (`48f873f`).
  The `2310623..58c6cf0` window adds P0 deploy evidence (`2d64de1` —
  deploy 941ce4d0 @ `2310623`: board+fileicon+attachments+render+
  releases-download first production traffic, the toolkit 7/7 +
  silent-pass preflight debut; its NEW medium-low finding — the
  attachments token-only walk, cookie-session owner 404s — is exactly
  what `7cd1ce9` then cured) and the tick-5 compat docs commit
  (`64aa06a`). The `58c6cf0..ae32b1a` window adds the tick-6 compat
  docs commit (`7a5861e`), the RELEASE-NOTES-v1.1 Addendum 3
  (`4f59daa`), and P0 deploy evidence (`96cb9d4` — deploy b928537a @
  `7cd1ce9`: the attachments cookie-fix proven, BOTH 16-OPENs closed
  with production proof incl. the `--force-red` rehearsal shapes,
  7/7 batteries first-try). The `ae32b1a..67adfb7` window adds the
  tick-7 compat docs commit (`bff7fdc`), the tag-create carried note
  CLOSED WRONG (`aaea049` — the contract declares 200 per upstream's
  own swagger, tag.go:185-197, while upstream's runtime drifts to 201
  (:230); we follow the declaration, in-place citation so the note
  can't regenerate) + its two phrasing alignments (`42a88c8`),
  the bare-head divergence comment refresh (`30995e2` — the
  fork-edge-first shape), the engine e2e health sweep (`ac3afd7` —
  16/16 scripts, 269/269 checks), the SPEC-0011 M3.5 count annotation
  (`84cf4c9`), and P0 deploy evidence (`baf28bb` — the RD18
  ?raw-incident arc closed; its NEW OPEN, 16 SQLITE_LOCKED tail
  exceptions, is P0-ledger scope, not an API carry). The
  `67adfb7..f696a21` window adds the SQLITE_LOCKED verdict docs
  (`280d4ad` — DO-SQLite in the workerd format, NOT D1's D1_ERROR;
  request-less = RepoCell alarm events; benign-retry
  stamp-and-reconverge, no lost write, the SPEC-0011 single-writer
  HOLDING on thrown paths; the syncing-wedge fix brief that became
  `833961d`) and the tick-8 compat docs commit (`075f916`).
- **Tooling**: the `9b49cd2..2310623` window adds the toolkit polish
  (`5fdbc15` — token optional for D1-only batteries, `MIRROR_SETTLE_MS`
  10s→30s + `--mirror-settle-ms`, the generic failureTail with the
  mirror sweep) and the toolkit PAT preflight (`2310623` — one
  `GET /user` per invocation, three fast-fail arms, zero repo creation
  on mismatch). The `2310623..58c6cf0` window adds the generate-e2e
  failureTail (`ee88c1b` — template+generated sweep on red,
  fullName-tracked, green runs silent, plus the GENERIC
  `--force-red <check-id>` deterministic failure-shape knob; the
  REDEPLOY16 incident shape force-reproduced exactly, following audit
  green). The `58c6cf0..ae32b1a` window adds the toolkit tails
  (`7d4c19a` — the registry battery's rename-aware fullName
  re-pointing, the forkpr fork→base→org order, ui-login; all three
  self-sweep on red; per-battery forced-red rehearsals with
  following-audit-green proofs; p0 creates nothing, explicit). The
  `ae32b1a..67adfb7` window adds the wrangler esbuild loader fixes
  (`4ed30cc` + `52a1f52` — the `**/*.svg?raw` Text rule, proven
  minimal; `981c098` — `**/*.json?raw` joins it after wrangler's
  built-in .json loader PARSED the object and 500'd every tree-view
  envelope in production; the ?raw-needs-a-glob lesson is the
  REDEPLOY18 arc's record).
