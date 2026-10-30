# cf-gitea v1.3 — Release Notes

Snapshot pre-draft 2026-10-30, HEAD `0f25339` — the v1.3 wave, now
covering the full day and past midnight: **119 commits,
`d68ad62`→`4a45370`** (2026-10-29 06:53 → 2026-10-30 08:50 +0800) — the
freeze HEAD and final count, filled by the 9:00 convergence run;
anything landing after the cut rides the v1.4 backlog
(docs/residuals-v1.3.2.md). These notes were first cut MID-FLIGHT at
`e5e1432` (28 commits, landed as `37758d5`); the same day's second half
landed before the freeze — the five cut-time units inside the hour, the
wiki sibling's full git-HTTP and lifecycle arc, the packages registry's
run from model to maven, SPEC-0019's acceptance and pages, SPEC-0012's
demand-gate lift, the second UI wave, and the survey's climb to
113/1/2 — was appended at `65809c6`; the day's final third — SPEC-0012's
M1a+M1b control plane and the UI's first Actions units, the settings
family's `has_actions` threading, the 500-chrome arm, C9's general page
with its checkbox retirement, the five-family actions-UI window that
mounts the Actions tab, and the docs' final syncs — was recorded in
`345443d`'s own delta sweep; and the day's last stretch — nuget
completing the registry's six protocols with the +1 quota-parity sweep,
the creation-defaults flip, M1c's org window and the run-viewer's deep
arms, both M1b residuals' closure, M2's runner guide, the probe
toolkit's v1.3 battery pair (taking it to fourteen), tick-19, and the
escaped-landing
recoveries — is appended below in the same structure (§1's new
subsections, §2's notes, §3's
tables). This pass appends the pre-draft's own delta — the twelve
commits since `0f25339` besides the pre-draft's own `65deb41` — in the
same structure: the four riders inside its hour (`8155e16`, `0276a82`,
`724434d`, `b5923ed`), the C4 remainder and the commit guard's
CI-parity hardening (`6f07849`, `57ace87`), then the harvest and
morning windows (`92d2e87`→`0b59b91`) through the F-row completion and
the SPEC closure sync. The window opened with the UI gap
census that classified and briefed every remaining survey row, landed
the engine read family at the boundary (grep with a budgeted NFA,
`activityStats`, `contributorStats`, plus the blame RPC), closed ten
census rows in one combined UI landing, shipped the audit-events model
with retention (migration 0038), and ratified four SPECs (0015–0018).
What remains open is named in §4 against the SPECs' own still-open
lists — nothing landed is left uncounted and nothing in flight is
counted as
landed. Every number is quoted from the commit or doc that recorded it;
nothing was re-measured for these notes except the probe toolkit's
plan output (§1's probe subsection quotes the dry-run this pre-draft
ran itself — no live probe ran).

**Cut point.** The v1.2 notes close at the seventh addendum (`8b9be25`, the
RD25 record). This window's first three commits are that release's last
breath — the RD25 postcheck (`d68ad62`, RESTING-STATE-COHERENT), the
push_bytes determinism pin (`5f7caed`), and the postcheck's closable batch
(`173deab`); the census (`b5fd430`) then opened this wave. Everything from
`d68ad62` to `0f25339` is the delta these notes cover: `e5e1432` was the
mid-flight cut (committed at `37758d5`, snapshot that tree), `65809c6`
carried the second half (through `72f40ec`), `345443d` recorded the third
(through `10cfb97`) and is itself the first of the final 16, and the
sections below carry those 16 (`345443d`→`0f25339`) as this pre-draft's
extension. The pre-draft itself landed as `65deb41` — riding in behind
four same-hour riders (`8155e16`→`b5923ed`) and carrying the
probes-README sync (15 rows / 176 probes, three stale texts fixed) —
and the eight commits since (`6f07849`→`0b59b91`) are appended below
in the same structure: **the wave stands at 105 commits,
`d68ad62`→`0b59b91`** (rev-list-count verified 2026-10-30), and
everything from `d68ad62` to `0b59b91` is the delta these notes cover.
The 9:00 convergence
window performs the final cut and tag — it fills the two TODO(final-window)
placeholders (the snapshot line above, §3's tick numbers) — and the
freeze window owns the wave's deploy record.

---

## 1. What v1.3 is

The directive is the census's own: **upstream Gitea serves it → cf-gitea
serves it** (`docs/compat/ui-gap-census-2026-10-29.md`, `b5fd430`). The
survey tick-16 remainder — 22 non-landed rows (17 ABSENT + 5 PARTIAL of
116) — was classified, briefed, and ranked; this window then executed the
top of that board, and by the last survey tick (tick-19, `b7ef7e5` — the
survey's first programmatic walk) the board reads
114 LANDED / 2 PARTIAL / 0 ABSENT — what remains is the actions tails
and the deferred M3-class work (§4). The per-row landing ledger (row →
closing commit, hashes verified) is appended to the census itself; what
follows is the wave view.

### The engine read family (SPEC-0015, accepted `5025476`)

Four capability verdicts with pin-verified upstream cites; §7's six open
questions ratified before any code. Three of the four RPCs and the audit
model landed the same morning; the fourth closed the family the same
evening:

- **M1 — `grep`** (`0644597`): modes exact/words/regexp over a budgeted tree
  walk; `words` is the per-line case-insensitive AND (git-verified), and
  `regexp` runs a step-counted NFA — linear simulation, because native
  backtracking cannot be budgeted in workerd, so catastrophic patterns
  answer linearly. Budgets: 2,000 files / 50 results (upstream's own silent
  cap, flagged in the commit) / 200k scan steps / 2M regexp expansions.
  Oracle `check-grep.mjs` 11/11 against real `git grep`; wired into CI's
  engine-check step (`2a7093d`, 21 checks).
- **M2a — `activityStats`** (`7a310b3`): period-switched first-parent fold
  (merges excluded), committer-time windows, per-author add/del via
  first-parent diffs, 10-minute TTL over `stats_cache`'s `act:<period>`
  namespace. Oracle 10/10 vs real git. The ratified
  `commitCountInAllBranches` cut is tripwire-pinned.
- **M2b — `contributorStats`** (`449400a`): the full-history per-week walk
  (merges excluded from the fold, counted as cap slots), Sunday-anchored
  Unix-ms buckets in each commit's recorded timezone, oldest-name
  precedence, no TTL (the SPEC's fixed-history immutability). Oracle 10/10;
  CI wiring carries 23 checks.
- **M4 — audit events + retention** (`5c8853c`): the `audit_event` D1 table
  (upstream `audit_event.go:22-38`'s shape, migration **0038
  `luxuriant_tempest`**), the `defineAction`/`renderMessage` registry with
  the upstream-verbatim `organization:*`/`repository:*` families,
  batch-composable `auditEventInsert`, slice-one instrumentation on repo/org
  create inside the existing D1 batches (a collision emits nothing — the
  invariant made structural), and 90-day retention as a fail-closed
  `AUDIT_RETENTION_DAYS`-gated producer on the hourly cron with the paged
  idempotent consumer arm in `handleRepoTasks`. 28/28 audit tests; 51/51
  purge/sweep/audit post-folds.
- **M3 — `scanLfsPointers`** landed the same evening (`fdfe73a`) — the
  family completes: size-gated candidate scan over `flattenTree`
  (index-only `typeAndSize`, ≤1024 B, raw bytes — the parse stays
  worker-side per the ratified split), path/oid filters, the M1-family
  budgets. Oracle `check-lfs-pointers` 10/10 vs crafted pointer fixtures;
  the unit was quota-killed after finishing — artifacts verified with the
  orchestrator's own eyes per the crash playbook; CI 25 engine checks.
  The R11 LFS settings family rode `9d7ccd6` the same evening.
- Beside the SPEC, the **blame boundary RPC** landed (`aa1fb29`) — the DO's
  existing blame machinery exposed at the boundary with real-git oracles;
  it is the idiom every new RPC in the family followed.

### The combined UI wave (`77e8567` — ten census rows, one coherent tree)

Nine units landed together (composite 281/281; tree tsc and eslint both
zero): the **fork grammar** on compare (the full upstream
`ParseCompareRouterParam` — two-dot DirectComparison, head-side fork forms,
the writer gate flipped to pulls-read parity); the **blame page** (R08) over
the landed RPC; the **raw/media byte families** (R21/R22) with the
deprecated legacy-guess catch-all and LFS pointer resolution — `links.ts`
switched to upstream's web shapes, retiring the tier-1 API raw-link
divergence; **explore organizations** (R01); the **owner heatmap** web JSON
route + profile widget (R03); the **org issues/pulls/milestones inbox**
(R07, member-ladder scope + team arms); the **org dashboard** and the team
name carrier (R06/R19, the member-only 404-shell posture kept); the **admin
emails/hooks/badges/applications pages** (R18's implementable-now arms); the
**org settings applications tab** (R20's applications arm); and the shell's
**Activity tab** chrome + the repo-activity route wiring (R14). The folds
that came with it: the dispatcher's viewer grant on cross-repo feeds, the
global-inbox past-end pager record, the `EngineClient`
grep/activityStats wrappers (M1/M2a's landing halves), and the
`actUserCond` parenthesization the org-dashboard matrix caught; goldens
regenerated at the merged state under the T0 user-creation pin.

### The Activity page chain (`5f5e167` → `7a310b3` → `77e8567` → `c14359c`)

The repo pulse page landed counts-first (`5f5e167`), was wired with the
shell's Activity tab (`77e8567`), then upgraded to the engine (`c14359c`):
commitCount/authorCount switched to the M2a RPC's first-parent fold and the
numstat trio (changedFiles/additions/deletions) replaced the placeholder;
the all-parents `listLog` walk retired (~70 lines). The D1 issue/PR/release
lists stay — upstream derives those from SQL too. 13/13 with engine-seeded
fixtures; render/tree-view neighbors 53/53.

### The SPEC ledger: four ratified in one window — and two more the same day

**SPEC-0015** accepted (`5025476`). **SPEC-0016 packages** and **SPEC-0017
commit-graph** drafted (`8dd664b` — 23 model types mapped to six D1 tables +
an R2 blob namespace; the SSR-SVG mechanism verdict with the in-DO lane
algorithm) then **accepted** (`0717de7` — fourteen open questions ratified:
two-pass blobs + global dedup + 512 MiB quota + sole-sweeper deletion;
host-the-JS + lane algorithm + hybrid pager + the v1 identity cut).
**SPEC-0018** accepted (`36d9b52`) — the admin (b) arms' verdicts: notices
BUILD (the DLQ emitter maps every fact upstream's emitters carry), config
BUILD as the read-only summary over wrangler vars/bindings with the
secret-hygiene rule, auths OMIT with the reasoned ledger (no login sources
exist; OAuth2 applications are clients, not sources).

The extension then landed all four SPECs' opening milestones the same day —
SPEC-0015's completing M3, SPEC-0016/0017/0018's M1s (below) — and accepted
two more SPECs: **0019** (`49ffb1f`) and **0012** with its demand gate
lifted (`ceb94bf`).

### The cut-time five land (10:34–10:37, the same morning)

All five units the mid-flight cut named in flight landed within the hour:

- **The `graphData` RPC** (`7a21493`, SPEC-0017 M1): the multi-tip walk
  generalized over `walkLog` (`hidePRRefs`; 2000-ref / 200-lane /
  20000-scan budgets), in-DO lane assignment per §3.3 (claim-lowest,
  parent-0 extends, relation rows for wide transitions, 16-class colors),
  pagination as one-walk skip-windows with the total delivered only on
  frontier exhaustion (the hybrid pager contract). Oracle `check-graph`
  14/14 vs real git; the unit was killed by a host crash after finishing —
  artifacts verified with the orchestrator's own eyes (14/14 + five
  neighbor checks + tree tsc).
- **SPEC-0016 M1** (`8cdf44a`): the packages registry's model, generic
  protocol, and cleanup — six D1 tables (migration 0039
  `talented_retro_girl`) plus the notices unit's `system_notices` riding
  the same schema pairing (0040 `gorgeous_nico_minoru`; both already
  applied remote ahead of code by the deploy-day migration pass, additive
  and reader-less until now), the R2 two-pass blob pipeline
  (sharded-sha256 global dedup, 512 MiB streaming cap, spool-then-copy,
  object-first), the 9 management ops + admin list on `/api/v1` with
  upstream's gate stack, the generic PUT/GET/HEAD/DELETE protocol at
  `/api/packages` with quota enforcement, and the probe-gated cleanup
  producer on the hourly cron + the `purge.ts` consumer arm + the example
  vars. 238/238 own+neighbor suites.
- **SPEC-0018 M1** (`7381c0d`): the notices arm — `recordNotice`/
  `listNotices`/`deleteNotices` with Go's ParseInt mirror; the DLQ
  consumer as the slice-one emitter (kind→type map, §5.3's
  nothing-can-reject contract, emit-degraded-to-log fallback) with the
  spam rule pinned behaviorally; the admin notices page (six-column
  checkbox table, delete-selected + delete-all, the AdminFamilyNav System
  Notices item in upstream's position). 37/37 own + 313 neighbors.
- **The three UI pages** (`781d8a3`): R13's audit-log settings pages (both
  arms over M4's `findAuditEvents`, keyset-walked pagination, the
  shared-`udit` idiom with the scope-id encoding keyed to the
  instrumentation); R10's in-repo search page over the landed grep wrapper
  (upstream's no-path-field form honesty, the 50-cap truncation notice,
  chroma-less SSR line cells); R15's three chart pages + `/data` JSON
  routes (the official bundle's Vue components render the mounts; the
  epoch-ms weeks insertion-order bug the matrix caught; recent-commits
  serves code-frequency's bytes upstream-faithfully); the settings
  navbars' Audit Log items + wave49 pins + a11y arrays + the regenerated
  goldens at the merged state. Composite 291/290 + solo-green.
- The same hour's smaller fixes: the **delete-user cascade covers BOTH
  action columns** (`37758d5` — the probe-caught orphan class:
  `act_user_id` rows survived every user deletion, observed live as action
  387 outliving user 55; the regression suite pins both arms, the admin
  census expectation updates, and deploy-probes' DEMO_MODE posture check
  is revised to the §2 invariant's real scope; this commit also carried
  the notes' first cut), the **probe token-count invariant** tracks the
  standing bootstrap SET (`c7ec2fe` — admin + p0probe = 2; the historical
  whole-table=1 encoding predated the second standing user's bootstrap
  and false-fired from 2026-10-29; all 12 batteries green after the
  transient API-fetch cascade cleared), and the **packages unlink 204**
  joins the runtime-only exception registry (`110cf56` — upstream's own
  handler answers StatusNoContent, `package.go:465`, while its swagger
  block documents 201 empty, `:439`; our 204 is runtime-faithful, the
  frozen contract carries the never-emitted 201; check:api PASS with the
  documented warn).

### The wiki arc: the sibling becomes a full citizen (five commits, one evening)

The wiki SPEC's flagged follow-ups closed in sequence the same day:

- **The git-HTTP twin** (`99db2c1`): `{repo}.wiki.git` serves clone AND
  push — upstream `githttp.go:94-101`'s parent-resolution + `:186-189`'s
  write-check posture (no push-create; the wiki-unit gate is the
  documented divergence). The sibling cell forwards through the existing
  smart-HTTP machinery with the parent's ACL; the registry row seeds
  `priv:true` (the index-leak posture). The engine's api-path branch
  closes a pre-existing hole: any valid token could DELETE a wiki cell —
  now the parent's read rows gate wiki JSON and wiki DELETE 404s. 49/49
  with 11 new arms + a REAL round-trip smoke (clone/push/read-back
  against the dev server, anonymous private 401). Its two flagged
  follow-on gaps (R2 carry + purge for pushed wiki packs) were closed
  the same evening, below.
- **The lifecycle completes** (`761c1f4`): sync delete tombstones
  `<name>.wiki` beside every main name (delete.go:335-337's same-sweep
  parity) and `moveEngineCell` carries the wiki sibling with the
  HasWiki-gated no-op (repository.go:329-334, applied at
  transfer.go:316-326/396-399 — the optional probe degrades to the
  lazy-provisioning empty round-trip). 41/41 lifecycle incl. the four
  new arms; repos dir 114/114.
- **The purge cascade** (`0b619be`): the spec-ledger research's
  orphan-class catch — delete a repo and its `owner/slug.wiki` engine
  cell survived forever. Consumer-side derivation (`<name>.wiki` from
  every engine name, same tombstone→destroy→registry phases; R2/D1 arms
  documented absent — the wiki is cell-only by design): old queued
  messages purge their wikis too, redelivery stays idempotent, and a
  redirected name's stranded wiki cell is reclaimed by the same sweep.
  Upstream parity: delete.go:335-337's post-transaction best-effort wiki
  removal. 9/9 with the new main+wiki/redelivery/renamed-orphan/
  never-provisioned arms.
- **The R2 arms** (`2de9def`): the carry re-keys onto
  `<parent-key>.wiki` (slash-free per the engine's storage-key grammar;
  the name-keyed target was unreachable through beginForkImport's
  validator) and streams pack+idx from the name-addressed source
  candidates before each adopt; the purge sweeps both the carried scheme
  and every known name's `.wiki` prefix. It also heals the pre-fix
  latent bug where the wiki carry persisted the PARENT's key onto the
  wiki cell (post-rename wiki pushes would have staged into the parent's
  pack prefix). 42/42 lifecycle + 10/10 purge with the real wiki-twin
  push fixtures (116/116 repos scope).
- **The transfer wiring** (`dc529a0`): the transfer-ACCEPT route wires
  the full engine-dep set — registry + tombstone + carry, the production
  shape the service seam expects — so a transferred repo's cells
  tombstone at the old owner, carry main + wiki sibling to the new one,
  and the registry re-points, instead of stranding until delete (the
  missing half of `moveEngineCell` on API transfers; upstream's accept
  step = transfer.go:106's code-repo rename :308-314 + wiki rename
  :316-327). `wikiExists` left unwired matching the rename path's
  posture (the empty round trip IS lazy provisioning). 5/5 + 29/29 +
  neighbors 46/46 with the route-level carry arm.

### The packages registry arc (SPEC-0016): M1 → M3 → M2 → M5a

- **M3 — pypi and helm** (`8d177aa`): pypi's twine multipart upload
  (bounded streaming scanner, SHA-in-pass, ranged second pass; upstream's
  arm order verbatim — hash mismatch, PEP 425 normalization, 409/quota)
  and the PEP 503 simple index (sha256 fragments, version sort,
  both-direction name normalization); helm's chart tar scanner (gzip +
  root-level Chart.yaml per metadata.go, 32 MiB cap, overwrite-replace),
  prov clearsign, `index.yaml` in upstream's json-tag keys with sorted
  entries, JSON error bodies per-family. The `yaml` dep (one line,
  dedupes to the transitive 2.9.1) rides the atomic commit;
  `routes/packages.ts` untouched — a second sub-app mounts at
  `/api/packages` beside the generic router. 14/14 + 16/16 + neighbors
  82/82.
- **M2's UI window** (`470e946`): the eight-arm registration window —
  SPEC-0016 M2's packages family + SPEC-0019's two code-search routes.
  The packages R04/R16 pages mount (list/redirect/versions/view/
  file-download + the repo tab with the `repoHasPackages` assembler gate
  and the PACKAGES_ENABLED strict-polarity shell); user-code-search and
  explore-code route beside the heatmap/explore twins; the repo-tab
  mount carries the `ae32b1a` constraint (the `/`-static twin outlaws
  the plain pattern — the survey's hono-ordering record). Six stale-row
  test files flip; three goldens regenerate byte-attributed. Composite
  --solo PASS at 299 files; scoped 505/505.
- **The route-test table** (`eba0060`): 38 route-level rows over the
  eight-arm families — the packages subtree's full shape map (the
  versions-literal ordering pin against a seeded version literally named
  "versions", files/007 → PathParamInt64 parity, undecodable-tail
  nulls), five `uiRouter.fetch` its (the seeded happy path incl. the 303
  display-cased redirect + R2-streamed file download,
  PACKAGES_ENABLED=false subtree shells, both repoHasPackages
  polarities through the settings row, the code-search twins). 158/158
  twice.
- **M5a — maven** (`dba7f9c`): the full port — four-layout path
  extraction with SNAPSHOT semantics and chi-parity wildcard slicing,
  checksum PUT as VERIFY-not-store (129B cap, quota-free per upstream's
  arm order), pom metadata on both write arms (hand-built XML reader —
  parent-inherited groupId, license names, dependency coords), legacy
  rename-before-create, the metadata document renderer (Go's EscapeText
  set, omitempty release, header+bytes checksums), and a local RFC-1321
  MD5 (§2 — Workers' WebCrypto lacks MD5; uploads repair the dedup row's
  `hash_md5` idempotently). 33/33 twice + neighbors 82/82. The mount
  block was delivered verbatim for the next window (a proven copy lives
  in the test's local router); npm landed as M4 and the mount itself
  minutes later (below).

### SPEC-0019: federation code search — accepted and landed

The code-search subsystem's SPEC landed as a single accepted document
(`49ffb1f`): v1 adopts capped demand-scan federation over the landed grep
RPC (zero storage/write-path; fresher than upstream's queue-lagged index —
the honest 25-repo cap + truncated-answer math recorded), R2 shards
REJECTED as strictly dominated, the D1 FTS5 store DEFERRED with its four
structural costs and reopen triggers documented; six open questions
ratified per proposals. The pages landed the same evening (`f50c9f7`):
the federation loader (25-repo cap, batches of 5, the ratified seed order
and visibility ladders), the R05 user/org page (20/20), the R02 explore
page with the instance-wide seed (19/19 — the seed posture ratified
as-landed per the upstream-parity rule: the mirror of the discovery
surface IS upstream's `FindUserCodeAccessibleRepoIDs` set; SPEC §3.1's
parenthetical corrected), the explore navbar's Code tab, and the
packages-M2 export interlocks (ProfileTabs, OrgMenu's packagesTab — the
modules' compile dependencies). 81/81 + 158/158 neighbors. This retires
the first cut's §4 gate that kept R02/R05 closed on the indexer-class
subsystem — the grep RPC deliberately did not open them under SPEC-0015;
its own SPEC did.

### SPEC-0012: the demand gate lifts

The rule that lifted it landed first (`ff66ed5`): the **upstream-parity
decision rule** enters AGENTS.md — upstream behavior IS the default
decision; SPECs record it, orchestrators never ask; ask only where
upstream has no answer or the platform forces a choice between equally
faithful adaptations (learned via the SPEC-0012 mis-framing). Then the
acceptance (`ceb94bf`): the 2026-10-24 demand gate LIFTED per that rule
(upstream's own architecture puts execution outside the server — the
control plane is pure parity work); the five-RPC census correction
(UpdateTaskLog/Stage/UploadArtifact do not exist as RPCs — log/artifact
ingestion rides three separate HTTP families); 12 new D1 tables (the
schedule pair deferred; secrets/variables/commit-statuses verified
pre-existing); the DBFS-parity log chunk store; artifacts v1+v4 (proto
in-tree); the OIDC issuer. Four open questions ratified (the expression
evaluator deferred to M3's opening; the hand-rolled codec frozen at
M1a's wire-freeze; no artifact size cap — parity — with a var escape;
the fake-runner harness is the E2E, real-runner smoke is M2 docs
material). M1a dispatched — landed the same evening at `32ef8bf`
(below). The UI half is
drawn by the Actions UI census (`e8f08a2`): 23 routes across the repo
tab's five handler files, the four-scope settings family behind shared
builders, and the load-bearing posture finding — upstream's run viewer
is 100% official-bundle Vue over ONE JSON contract (ViewResponse); our
SSR surface is the mount div (the heatmap precedent at larger scale).
Ten-unit M1c phasing with file ownership drawn: C1/C6/C7 dispatch on
M1a, C3/C4 gate on M1b, C8/C9 anytime (no actions tables), C5 flags on
the emitter, C10 defers with M3.

### The issue-content soft-delete and actor attribution (`90e0d2f`)

The content-history row's last arms: the soft-delete POST arm
(`SoftDeleteContentHistory`'s six guard arms verbatim incl. both
empty-200 quirks, web.go:1391 — the mis-cited 1329 corrected) and the
`actorId` threading through all four write callers (comment/issue-body
edits now attribute their revisions; pulls + issue-t2 the same). 14/14
new smoke arms (owner hide, editor attribution end-to-end, six guards);
neighbors 100/100 + 131/131 with the threading. The route registration
rode the integrator's window and mounted at `9d7ccd6` at upstream's
query-string POST shape, completing the row's arm set.

### The second UI wave: the four-arm window + the PageData mechanism (`9d7ccd6`)

admin-config (the eleven-section read-only summary, REAL/POSTURE rows,
the values-cross-check, secret hygiene — 19/19; SPEC-0018's M2 landing
half); the R09-M2 commit-graph page over the landed `graphData` RPC (SSR
SVG lanes on the 5px/12px grid, the hybrid pager, div-only fragment, the
Commits anchor + the GraphDataResult/engine wrappers landing halves —
23/23, one geometry pin corrected against upstream's own svgcontainer
math; SPEC-0017's M2 landing half); the R11 LFS settings family (four
read-only pages over the scanLfsPointers/parse/join pipeline — 16/16);
the soft-delete route registration (above). The mechanism upgrade
matters beyond the four arms: per-page `window.config.pageData` through
the shell (upstream's head_script channel), the body-inline assignment
retired — 64/80 goldens byte-proven unchanged, 16 regenerated at the
merged state (one line each); four disclosed folds (a11y arrays, the
mirror pin, two test corrections with upstream evidence). Scoped 364/364
+ 80/80.

### The survey: tick-17, the heal, and tick-18 (`45ecd7c` → `72f40ec`)

Tick-17 (`45ecd7c`) rode the home sidebar's search form (R10's deferred
anchor — `home_sidebar_top.tmpl`'s GET form over `{RepoLink}/search`
with the `q` input; the home golden regenerated, 6/6; both units
quota-killed post-completion, artifacts verified with own eyes) and
claimed twelve row flips with headline 107/1/8. Tick-18 (`72f40ec`)
found its predecessor's doc commit had applied only 5 of those 13
claimed row edits — the committed tables stood at 99/4/13 — healed the
eight missing flips (the B settings-tabs row, C blame, C raw, C media,
C search, E settings/audit_logs, F activity, F charts; every landing
commit re-verified against the tree at HEAD), then made its own six
ABSENT→LANDED flips for **113/1/2, zero rows in flight**: `/explore/code`
and `/{username}/-/code` (`470e946`+`f50c9f7`), `/{username}/-/packages`
and the repo packages tab (`470e946`), the graph page (`9d7ccd6` over
the `7a21493` RPC), the settings/lfs row (`9d7ccd6`). The one PARTIAL is
the admin row (its still-absent list shrunk to auths/packages/actions);
the two ABSENT are the actions subsystem rows — SPEC-0012's wave in
flight. Router counts refreshed: 349 route families, 234 page files.
README's implied 109/1/6 (`4c8277d`) confirmed sound through `9d7ccd6` —
the arithmetic was right; what it inherited unseen was tick-17's
unapplied table edits.

### The documentation and ledger wave

`b6b0180` synced the SPEC index to the wave (0015 COMPLETE — five
milestones, five commits; 0016/0017/0018 M1s landed with M2/M3 in
flight; the tier-2 snapshot 500/554 across 306 paths — the +10 is
exactly 0016 M1's ops) plus the header-nit fixes the sync flagged;
`fdae617` ledgered the five unledgered SPECs (activity-feeds `2ef9359`,
issue-content-history `cced424` + the `2f7afe9` mount,
push-mirror-outbound `b332e14` + `9bda9eb` wiring end-to-end,
user-notification-settings `bf69f6c` + mount, wiki `d3362b1` — the
wiki-cells purge gap recorded as its open follow-up, closed twenty
minutes later by `0b619be`); `387812f` restored 0016/0018 from the
whitespace collapse (§2); `9e7d49b` ran the docstring cite-hygiene pass
(nine drifted our-source line cites re-verified and corrected across
seven route files, comment-only; six more verified accurate and left;
one flag for the next window: account-aggregates' schema.ts:432 shifts
when the in-flight repoUnits docstring lands); `4c8277d` refreshed the
README status (wiki twin in the engine row, SPEC-0015 COMPLETE, API
500/554, UI at tick-17 with the post-tick delta named as implied, 26
SPECs) plus the flagged index syncs.

### The packages registry completes its wire: npm, the maven mount, the repair

- **M4 — npm** (`a7d9bb1`): the full route family on the mounted
  sub-app — PUT publish (the creator port with hashicorp go-version's
  full semver validation, attachment+sigstore fallback, tarball scan,
  the repo-link arm with giturl parse, 409-before-quota), the packument
  with normalized-version keys + deterministic JSON + weak ETag/304,
  version metadata, exactly-one-version file downloads,
  unpublish/dist-tags CRUD (the highest-non-prerelease latest fallback
  verified against upstream's own fixture), deprecate via
  attachment-less PUT, search/ping/whoami; errors upstream-verbatim
  `{"error":…}`. 23/23 round-trip + neighbors 145/145; protocol-common
  gains the property seam.
- **The maven family mounts** (`a9fce00`): the M5a unit's delivered
  block transplanted verbatim from its proven local router into the
  ecosystem router beside pypi/helm/npm — all four protocol suites
  green together 86/86 — then **forward-repaired** five minutes later
  (`ff13b96`): the transplant's incomplete rebinding (mavenErrorResponse
  references and two 200-success arms against plainResponse's
  error-status union) fixed properly, the proven error mapper
  transplanted beside helmErrorResponse, the three duplicate class
  imports dropped, 86/86 again. §2 carries the repair's process note.
- The same minutes' **test-env fix** (`27c2502`): UiTestEnv omits
  `PACKAGES_ENABLED` before overriding — wrangler types generates
  LITERAL var types, so the old intersection narrowed to `"true" &
  string` and CI's regenerated Env rejected the `"false"` polarity arm
  (run 40881266593); the Omit-and-replace widening is the correct
  override.

### SPEC-0012 M1a: the Actions control plane lands (`32ef8bf`)

The wire freeze hash-verified against actionslib v1.5.0 (dirhash equals
go.sum:15); migration 0041 `workable_rick_jones`'s twelve `action*`
tables column-for-column (repo_id TEXT with the `''` sentinel, the
composite index families, action_log_chunks as the DBFS analog); the
four procedures — Register (reusable-until-reset per the
draft-correction), Declare (the capabilities header), FetchTask
(answer-immediately, 0→1 bootstrap, the stale-version echo, the
per-isolate pick limiter), Ping — plus the interceptor (constant-time
digest, debounced heartbeats) over the hand-rolled typed codec; the
dispatch CAS (task_id=0 AND status=waiting, the race test) with the
version cascade and self-heal; buildRunnerTask assembles
contexts/secrets/variables/needs per GenerateGiteaContext. The
fake-runner harness speaks real connect/proto against the MOUNTED app —
61/61 + neighbors. The usability pair rides the same entry file:
unclaimed repo-scoped paths answer the full 404 chrome (upstream
web.go:1819's negotiation — HTML shell for browsers, the bare line
otherwise; the gate stays byte-identical) and the empty-repo page is
upstream's empty.tmpl Quick Guide shape.

### The three-unit index window (`a8e065f`)

Census **C8** — the repo Actions secrets/variables settings pair (the
org twin's structure mirrored, the disabled-unit 404 polarity pinned;
59/59 + settings-family 246/246 + twins 300/300); the **loginRedirect
full-URI fix** (upstream's cookie.go:44 RequestURI — 36 call sites +
the gate threading, 207/207 with the query-preservation arm); the
**admin packages list page** (tick-18's last admin-row item: the
9-live-column table over searchVersions, the two blob-size totals,
PACKAGES_ENABLED gating; 15/15×4 + admin-family 182/182 + goldens 80/80
+ route table 159/159). Ten admin goldens regenerate one-line each.

### The settings family threads `has_actions` — and catches its strays (`7125c74`)

Every repo-settings SettingsNav call site now evaluates
`repo_settings.has_actions` (navbar.tmpl:47's conditional per-page, the
C8 options-page precedent mirrored): wiki/public-access/deploy-keys/
collaboration/audit/lfs (×4 loaders)/tags/branches (×3 arms)/githooks/
mirror. Renders stay byte-identical until the unit is enabled (the
default-false posture); ten suites route-level green 341/341, repo-wide
tsc zero. The unit's tree census also caught the two STRAY pypi/helm
protocol tests that `8d177aa`'s staging fallback never picked up
(`api/routes/packages-{pypi,helm}.test.ts` — untracked since; their
suites were green locally but never in CI's tree; §2).

### C9: the Actions general page, its catch, and the checkbox retirement

- **The general settings page** (`6fcb561`, census C9): upstream's gate
  verdict shipped exactly — the page and its unit-toggle POST sit
  OUTSIDE MustEnableActions (web.go:1262-1265's own comment — the
  disabled unit's re-entry), the bare /settings/actions redirect 303s
  to the literal ./actions/general INSIDE the gate (404 while off);
  FormBool faithful (ParseBool ∪ on); the settings nav's General item
  unconditional-in-block per navbar.tmpl:42 with the trio riding
  hasActions; one dead-link pin retired. 19/19 + the settings sweep
  408/409 (the 1 red is the integrator's in-flight parse state,
  provably independent).
- **The unit-row writer fix** (`c1cefaa`, C9's catch): the scan was
  correct all along (task.go:280-284 joins repo_unit type=actions) —
  the writers were the gap. saveRepoSettings, the single choke point
  both the UI toggle and the API PATCH funnel through, now writes the
  repo_units actions row in lockstep with has_actions in the SAME
  db.batch (insert onConflictDoNothing / delete; unit-less saves
  untouched; the unconditional direction write self-heals pre-fix
  stray rows); the service header's default-off misattribution
  corrected (upstream's DefaultRepoUnits enables
  projects/packages/actions at creation). 7/7 new suite incl. the
  end-to-end scopeRepoIds regression + 20/20 + 34/34 + callers 71/71.
- **The options checkbox retires** (`42c2af7`): upstream's toggle lives
  ONLY on actions_general.tmpl — options.tmpl's unit list ends at
  enable_pulls — and the retirement removes the SAVE ARM, not just the
  input (§2: the clobber it prevented); the nav block's stored read
  rides RepoBasicsData.hasActions outside the form (the invalid
  re-render can never spoof it). 32/32 twice + goldens 80/80 (a
  surgical one-span byte edit, python-verified, avoiding a full regen
  sweeping siblings' in-flight renders).

Its two follow-ups were dispatched: the first is the unit-row fix above
(landed in-window as `c1cefaa`); the second — the ActionsConfig store's
migration, unlocking the token-permissions + collaborative-owners
sections `6fcb561` documented-unrendered — flies (§4).

### The five-family actions-UI window: the Actions tab mounts (`0c8da44`)

M1c's integrating window lands the census's dispatch-ready UI families
in one coherent tree: **C1**'s runs list (the `?run_ids` fragment,
MustBeNotEmpty + unit gates); **C2**'s run-viewer subtree (the mount div
+ the ViewResponse JSON contract field-by-field vs view.go, the cancel
CAS with the StopTask handshake, GET/POST resolution asymmetry); **C6**'s
job-queue pair (the admin off-by-one parse fix — `tail.length===2` —
plus its fixture gaps: is_empty, the DOCTYPE via the module renderer,
and a real filterRepoId type bug); **C7**'s runners settings (three
dead-unit fixture bugs fixed: the NOW=T0+30s heartbeat lie, the
cross-repo token assertion, the null shape); C9's general trio (landed
at `6fcb561`, arms fresh) and C8's re-armed pins ride the sweep. The
shell's Actions tab + repoHasActions threading + the admin nav's
Actions group (the union member the queue page needed); ten admin
goldens one-line each; the a11y arrays' Packages debt from `a8e065f`
repaid alongside. Combined sweep 598/598 (C1 51 + C2 38 + C6 26 +
C7 32 + C8 59 + C9 20 + neighbors).

### SPEC-0012 M1b: the ingestion half — the control plane completes (`10cfb97`)

UpdateTask's state machine (the cancelling handshake, outputs' resend
contract, the reported-steps port with in-place relayout); UpdateLog
byte-for-byte (the DBFS chunk store + R2 seal via multipart merge — the
workerd no-concat answer, the zigzag LogIndexes, the gap-refusing seal);
artifacts v1+v4 (md5-tee chunk streaming, the blocklist replay with
contiguous recomputation, HMAC signed URLs); job summaries; the OIDC
issuer (RS256 WebCrypto, GitHub-shaped claims, the token_permissions
grant gate). The fake-runner harness runs the FULL lifecycle as the
standing E2E — 168/168 across the actions family. insertActionRun
chunks at 2 rows (the D1 bind cap, the integrator's routed request);
the rebuild's two self-caught bugs noted (Go-default claim field names;
server-minted absolute URLs in the harness); the keystore divergence
and the retention-var wiring are ledgered for the next waves.

### The 500-chrome onError arm (`3a16685`)

Upstream's errpage.go posture ported (the REAL cite:
renderServerErrorPage's Accept negotiation + the panic-page twin,
mounted tree-wide via ProtocolMiddlewares): browsers get the 500 shell
(minimal-deps per 500.tmpl — no repo header, no flash), curl keeps the
byte-identical plain line now with upstream's zero-options
cache-control, stacks go to the log never the body, and a shell-render
throw falls back to upstream's verbatim render-failure sentence. The
test's throwing-route fixture is REAL (drops issue_attachments
unguarded-read, restores via prepare() — D1 exec can't re-run
multi-line DDL). 58/58.

### The documentation's final syncs (`abab71c`, `b2ff251`)

`abab71c` — the SPEC index's final v1.3 sync: SPEC-0012's row catches
up through the gate lift + M1a with M1b in flight; SPEC-0016 records
M1–M5a landed with M5b in flight; SPEC-0019 gains its row COMPLETE;
SPEC-0017's missed complete-mark flipped (`4c8277d`'s second overclaim
— its message claimed the sync, its diff carried only the 0018 hunk);
activity-feeds recounted 14/27 code-verified; the wiki row records the
git-HTTP twin. The two flagged stale sections folded:
activity-feeds' §3.3 five DEFERRED labels → WIRED, wiki.md's cascade
bullet → CLOSED. check:api re-run at HEAD: 500/554, PASS. `b2ff251` —
the README's v1.3 release refresh: snapshot at `3a16685`; the Actions
paragraph debuts (SPEC-0012's gate lifted per the upstream-parity rule,
M1a's control plane: the four connect-RPC procedures + dispatch CAS
over migration 0041's twelve tables, the actionslib v1.5.0 wire freeze,
the fake-runner oracle, stock act_runner as the self-host runner); the
engine row carries the key-guard; the UI row at tick-18's 113/1/2 with
the a8e065f flips marked implied-pending-next-tick; 500/554 re-verified
PASS. Two TODO(final-window) placeholders await the 06:15 cut (final
HEAD + the final tick numbers) — b2ff251's own marking, then planned
for 06:15; the cut is the 9:00 convergence window as these notes are
written. Every claim unit-verified.

### The packages registry completes its protocols: nuget (M5b) and the +1 quota-parity sweep

- **M5b — nuget** (`e26c862`): the registry's SIXTH protocol family.
  The hand-built zip reader (EOCD + central-directory walk, stored +
  deflate-raw, the zip-bomb gate), the root-nuspec rule with the
  fifth-segment version normalization (`1.04.5.2.5-rc.1+probe` →
  `1.4.5.2-rc.1`), V3's nine-resource service index + registration
  leaves + byte-parity downloads, V2 OData (the Edmx, the
  `Packages(Id=…)` leaf via a prefix wildcard re-pinning upstream's
  regex — Hono cannot compile chi's embedded-param parens,
  probe-verified), the BSJB symbol extractor, the `X-NuGet-ApiKey`
  auth fallback, and the +1 post-insert quota parity upstream's
  transaction ordering produces. 14/14 + the six-protocol sweep
  122/122. SPEC-0016 stands at M1–M5b (M6 container + M7
  index-builder pending).
- **The +1 post-insert quota parity swept the whole family.** npm
  first (`54a8fc4`): upstream inserts THEN checks inside the
  rolling-back transaction (`packages.go:188-191` with the throw at
  `:380-381`, at this pin), so the publish that reaches limit N
  succeeds and only N+1 fails — npm's pre-insert check allowed one
  version MORE at the boundary; the boundary test pins the N-th 201 /
  (N+1)-th 403 / the rollback posture; 24/24 + the superset sweep
  183/183. Then the remaining four in one commit (`4e42c8c`): pypi
  (twine POST), generic (PUT), helm (chart POST + the prov path,
  keeping the family idiom on every publish arm), and maven (after
  the checksum-verify early return, which stays quota-free) all swap
  the dead pre-insert `checkCountQuotaExceeded` for the inline
  `countVersions + 1 > limit` shape (admin bypass, −1 disable);
  `checkCountQuotaExceeded` is deleted from `model.ts` (zero
  occurrences left in src); boundary tests in all four suites;
  superset sweep 156/156. The stale `packages.go:305-312` size cites
  corrected to `:303-306` at the pin. The class, cousin of §2's maven
  MD5 note: port the transaction ORDERING, not just the check — a
  faithful check on the wrong side of the insert is a divergent
  quota.

### The creation defaults flip (`b0e1d88`)

Repo creation now arms upstream's `DefaultRepoUnits` posture per
creationKind — normal: actions + packages armed; fork: both off
(`DefaultForkRepoUnits`); mirror: packages on, actions off — the flags
AND the `repo_units` actions row seeded in the SAME creation batch (one
transaction, so the row and the flag can never diverge). Packages rode
along (it was also default-off); projects stays the documented
divergence; pre-flip repos untouched (creation-time writes only,
upstream's shape). Five new lifecycle tests incl. the lockstep
round-trip on a creation-armed repo; the two UI fixtures the flip
surfaced fixed in-commit; 70/70. The flip's premise reached past its
own commit — §2's premise-death note.

### SPEC-0012's hour of giants: the org window, the run-viewer's deep arms, both M1b residuals, and the guide

- **The org-scope Runners twin** (`3ab7532`, C7's census org arm —
  the M1c org window closes): the org page over the M1a store at the
  `(orgId, '')` scope; the WithAvailable cond ports upstream's org
  polarity (org's own + globals — a repo-scoped runner NEVER lists in
  the org scope, `runners.go`'s ToConds :262-266); the token
  lifecycle with reset scope-guarded; the write arms (edit tasks
  enrichment, the global-runner NotFound arm per findActionsRunner's
  owner pin). Mounted per `web.go:1058` behind the require-owner
  prologue — at org scope upstream's MustEnableActions reduces to the
  instance-level flags (both compile-time true in the landed
  posture). PageClasses upstream-exact per the org family's genuinely
  distinct edit template; the shared OrgSettingsNavbar lights the
  Runners sub-item (`navbar.tmpl:35-37`) before Secrets. 10
  registrations incl. the 405 twins, the reset literal ahead of the
  `{id}` combo (chi static-first). 32 new tests (the org cond
  polarity, token reuse, cross-org isolation, the mounted matrix incl.
  the exact 400 arm); neighbors 147/148 — the one red the pre-existing
  `b0e1d88` fixture premise, fixed separately (§2).
- **C3 + C4 over the run-viewer** (`cd7eec4`): C3 fills ViewResponse's
  two placeholders per `view.go:722-917` — `fullStepsOfTask` is
  FullSteps ported verbatim (the Set up job/Complete job boundary
  synthesis with the firstStep/lastHasRun log-range math, the reported
  layout riding verbatim) with convertToViewModel's cancelling overlay
  + waiting→pending flip; `logs.stepsLog` is the full cursor protocol
  (expanded-only in-range steps, the three-guard validCursor, 1-based
  lines, float-second stamps, same-cursor-empty retry, the logExpired
  purge arm) reading through M1b's `getTaskStepsByTaskId`/
  `readTaskLogs` seams (hot chunks + the R2-sealed read both tested).
  C4's previewLink flip goes LIVE in the same commit as its routes
  (the dead-link rule): `repo-actions-artifacts.tsx` carries
  artifact_preview.tmpl's SSR file browser (depth/selected tree,
  three banners, the sandbox iframe hook) over `view_artifact.go:
  341-390`'s assembly + the SIGNED raw serving (`:392-484`) — HMAC
  gate, Sec-Fetch-Dest document 302, v4 zip central-directory listing
  + stored/deflate-raw inflation, legacy gzip gunzip, 404/413/415
  gates, the helper-script injection. The index.ts mounts (the repo
  preview subtree + the viewer-less root signed-raw family — the HMAC
  is the auth) are GET-only with chi-405 POST twins, digits-only
  `{id}` claims, per-segment-decoded tails with '/' rejoined; 10 new
  parse-table cases pin the claim shapes incl. junk/undecodable
  negatives. 61/61 own (six self-caught expectation bugs + one real
  disposition-regex fix) + parse+matrix 230/230 and 77/77.
- **Both M1b ledgered residuals close** (`3bc5d29`): the
  retention-var wiring — `runRetentionSweep`'s signature tightened
  from `Partial<>` (the deletion hazard: omitted arms silently
  defaulted 90/365/400) to a required triple with 0 = arm off
  (upstream's `<= 0` polarity); `retentionDaysFromEnv` strict-polarity
  parse; `enqueueDueActionsRetention` rides the hourly entry as the
  third sanctioned producer block (gate before the first D1 read, one
  indexed LIMIT-1 probe per armed arm, at most ONE message carrying
  the parsed values — the consumer runs exactly what was armed); the
  zombie pair rides the */10 step entry probe-gated (upstream's
  stop_zombie_tasks is an always-on @every 5m cron with NO retention
  knob, `cron/tasks_actions.go:26-35` — hourly mounting would have
  degraded zombie latency to ~70min); two typed consumer arms in
  `purge.ts`; `wrangler.jsonc.example` gains the strict-polarity trio
  fail-closed (a default deployment NEVER deletes actions data —
  upstream's always-on defaults are opt-in here). The keystore: 
  upstream stores NEITHER crypto piece in a models table (the HS256
  secret in the setting store, `oauth2.go:129-150`; the RS256 key an
  AppData PEM, `oidc.go:40-54`) — the ratified no-app.ini substrate
  makes D1 the analog home: **migration 0042 `rainy_captain_cross`'s
  `system_keystore`** (write-once rows; rotation operator-only,
  exactly upstream's edit-app.ini-and-restart), generate-once-save-back
  with the race loser adopting the winner's material, the kid switched
  to upstream's exact `base64url(SHA-256(SPKI DER))` spelling
  (`util/keypair.go:48-56`), one-time legacy adoption of M1b's R2
  object on a cold D1 miss. Two disclosed boundary touches
  (demo-sweep's disarm pins per the `AUDIT_RETENTION_DAYS` precedent;
  artifacts' persistence assertion moved from the R2 object to the D1
  rows). db:generate no-drift re-verified; 119/119 across six neighbor
  files.
- **M2 — the self-hosted-runner guide** (`0143e10`):
  `docs/guide/actions-runners.md` (447 lines) — what works today (the
  four mount families, the wire freeze + divergences, interceptor
  auth, the six-procedure table, token lifecycle, the dispatch
  payload, ingestion); the act_runner recipe (install/register/labels
  with the exact-match warning, an end-to-end walkthrough, the
  fake-runner as the zero-install smoke); the operator surface; seven
  honest limits — every claim machine-checked against the landed code
  (22 load-bearing cites spot-verified); the draft's pre-flip
  default-off prose was caught mid-flight and rewritten against
  `b0e1d88`'s landing.

### The deploy-probe toolkit grows to fourteen batteries (`49a1502`, `07221df`)

The v1.3 battery pair landed ahead of cleanup-audit: **wiki-git** (a
real clone of the wiki twin — REST page create → the clone asserting
the root commit verbatim → a real push → the three-way read agreement
→ privacy tails → the t+0 tombstone) and **packages-registry** (the
live protocols end-to-end: generic round-trip, the pypi twine multipart
+ PEP 503 anchor, the npm couchdb publish with a hand-built tgz →
packument/tarball/unpublish, helm's index.yaml, maven's generated
metadata.xml — then the D1 row sweep in cascade order + the documented
R2-blob residue note). 14 batteries / 173 probes at the pair's
landing, locally green run-by-run with the failure-tail self-sweep
proven live. The nuget arm then joined the packages battery
(`07221df`) — three chained probes (the V3 publish round-trip via
`X-NuGet-ApiKey` with the fifth-segment normalization exercised, the
V2 OData Edmx/`Packages(Id=…)` pair, the management purge cascade)
with a hand-built stored-entry zip fixture (`zipStoredBytes()` — local
headers + central directory + EOCD, real CRC-32, a root package.nuspec
beside a nested lib/net45 payload the root-nuspec rule must skip),
**176 probes across the 14 batteries** at this pre-draft's own dry-run
(verified again here; no live probe ran — the freeze window's deploy
probe run exercises them for real).

### The escaped-landing recoveries (`d7a6f73`, `c269ff0`)

Two same-hour fix commits closed what the giants' landings left
behind: the **runs-list icon set** — `gen-ui-icons.mjs`'s ALLOWLIST
addition (the action_status circle-fill variants, skip/stop/circle/
blocked/x, octicon-sync standing in for the stroke-based
gitea-running spinner, the dropdown carets, the empty-state/error
glyphs, stopwatch — 13 glyphs the landed C1 runs list requests) had
escaped `0c8da44`'s commit; and the **two `b0e1d88` premise deaths**
in the committed matrices — the audit-logs (`d7a6f73`) and LFS
(`c269ff0`) hasActions-threading tests still built on the 'no
repo_settings row' creation-default premise the flip had invalidated;
both rebuilt on explicit update-based polarity phases (the wave15
idiom), disabled→no Actions block, armed→sub-items lit, the creation
default restored in a finally. `c269ff0` also drops `read.ts`'s dead
drizzle binding and useless-initializer lint errors. 46/46 own-eyes;
LFS family 62/62 + the matrix 17/17.

### The survey reaches tick-19; the as-built records sync (`b7ef7e5`, `d33a413`, `0f25339`)

Tick-19 (`b7ef7e5`) is the survey's first PROGRAMMATIC walk — the
pre-edit run reproduces tick-18 exactly, the post-edit run equals the
headline: **114 LANDED / 2 PARTIAL / 0 ABSENT** of 116 at `e26c862`,
zero rows in flight, the dispatch gate list EMPTY. Two flips off the
actions window: the E settings/actions row LANDED (every page-bearing
GET in `web.go:1262-1278` serves); the F repo-actions row flips
PARTIAL, not LANDED (runs list + job queue + the run-viewer subtree
serve; the six tail GETs stayed unclaimed per C2's own note at the
tick's HEAD). The admin row stays PARTIAL with its absent list shrunk
(packages `a8e065f`, job-queue `0c8da44`; auths + the admin actions
tails remain). specs/README.md's post-giants sync rode the same
commit; the survey's own note hands the root README's refresh to the
release docs. The as-built syncs followed the landings they record:
`d33a413` — SPEC-0012's ledger entries 7 (the keystore home, then
still the R2 stopgap) and 8 (retention-var wiring, then pending), the
as-builts for M1b (fake-runner full lifecycle 168/168), M1c (through
the writers fixes and the creation flip, with the honest still-open
list), M2; SPEC-0016's as-builts for M5b nuget + npm quota parity
(wording corrected to the actual pre-insert `countVersions + 1 >
limit` equivalent) with the four-service sweep recorded LANDED at
landing time; nuget.ts's two stale `packages.go:214-219` cites
corrected to the pin's 188-191/380-381 (comment-only, flagged by two
units). `0f25339` — the post-landing sync an hour later: entries 7
and 8 rewritten RESOLVED against `3bc5d29`'s landed truth (the
keystore arc readable in place — the §4.4 spelled homes → M1b's
R2-object stopgap → the D1 `system_keystore`; the strict-polarity
trio, the hourly producer block, the */10 probe-gated zombie pair, the
two purge.ts arms); the M1c still-open list updated for the three
closures (org runners `3ab7532`, C3+C4 `cd7eec4` with the routes
mounted same-commit per the dead-link rule, both M1b residuals via
`3bc5d29`) — leaving the per-name artifact download/delete pair the
only C4 tail, C5/C10 with M3.

### The pre-draft's four riders (00:57–01:11, `8155e16` → `b5923ed`)

Four units landed in the hour before the pre-draft's own commit — none
of which that snapshot could see:

- **The admin-packages matrix's env override joins the Omit class**
  (`8155e16`): CI red root-caused and killed — the RouteEnv
  intersection omitted ASSETS but NOT PACKAGES_ENABLED, so under CI's
  example-derived literal Env the disabled-posture assign failed
  TS2322 (`admin-packages.matrix.test.tsx:369`); `27c2502`'s exact
  lesson recurring in a younger file. It slipped past the landing
  gates because the orchestrator's LOCAL generated types were stale
  against the example's newer literal — caught by simulating CI's
  typecheck (example-copied config → `wrangler types` → tsc, own
  eyes). 15/15. The stale-local-types class itself went to the guard
  (`57ace87`, below and §2).
- **The `b0e1d88` premise sweep, part two** (`0276a82`): the last two
  dead "no repo_settings row" fixtures rebuilt on explicit
  update-based polarity phases (the `c269ff0`/`d7a6f73` pattern
  verbatim) — settings-mirror.matrix (27/27) and
  settings-collaboration.matrix (35/35) both create fixture repos
  through RepoService.create, so the flip seeded the ARMED row and
  their reduced phases read TRUE (the baseline re-run reproduced the
  orchestrator's 2-failed/164-passed exactly). repo-settings-tags
  (77/77) and repo-settings-wiki (27/27) PASS with their comments now
  mechanically accurate as written: their fixtures hand-INSERT the
  repository rows (no creation pipeline), so no row genuinely exists —
  the refreshed comments document WHY, so a future fixture migration
  will not silently re-break them.
- **The artifact upload-time expiry ceiling** (`724434d` — the
  retention wiring's parked follow-ups closed): the ceiling lands
  where upstream computes it, at the CREATE arms not finalize (the
  unit's pin-verified correction: artifact.go:94-107's artifactExpiry
  is reached only via CreateArtifact — confirm/merge never re-visit
  expiry). Armed, the min-clamp applies to runner-requested AND
  default expiries, reusing the strict-polarity
  `ACTIONS_ARTIFACT_RETENTION_DAYS` parse; un-armed, 0 = no ceiling
  and keep-forever for expiry-less uploads — fail-closed, the default
  deployment never deletes. `dlq.ts` learns the two new message kinds
  (kindLabel via the landed family guards, the type-2 rider list).
  59/59 own-eyes with neighbors.
- **The admin actions group's tail pages** (`b5923ed` — the survey's
  named opportunistic target): the RUNNERS family with upstream's
  ADMIN polarity (the empty cond lists EVERY runner — repo/org/user/
  global; the global `(0,'')` token; `EditableInContext(0,0)=true` so
  globals are editable, the org twin's 404 arms inverted; the bulk arm
  with upstream's exact before-any-write junk 400s and
  FormStringInt64s' voided-parse semantics — any junk comma entry
  nils the whole list); the VARIABLES family at global scope (the
  id→row hop making any scoped id the missing-404); the bare group's
  303 onto `./actions/runners` with LocationRedirect's exact relative
  bytes; and SCOPED-WORKFLOWS documented-reduced (web.go:903 exists
  at the pin but needs the `action_scoped_workflow_source` store +
  the workflow-file parser — no substrate, honest 404, the nav item
  omitted per the dead-link rule). 11 families + 22 registrations
  with chi-405 GET twins; the shared AdminFamilyNav extension
  deliberately deferred to the fold unit. 34/34 + neighbors 85/85.

### The C4 remainder mounts; the commit guard goes CI-parity (`6f07849`, `57ace87`)

- **The per-name runs-artifact download + delete family** (`6f07849`,
  the C4 census remainder §4 had carried): the GET
  (ArtifactsDownloadView, view.go:1201-1279) — attempt-query
  resolution (absent → LatestAttemptID; junk/≤0/unknown → ServerError
  500, not 404); a single UploadConfirmed v4 row streams its stored
  content direct from R2 with ServeUserContentByFile's header chain +
  the minimal single-range port (206/Content-Range, clamp,
  416-vs-400 per Go's ParseInt start/end error split); legacy
  families stream a COMPOSED zip — Deflate entries at each row's
  artifactPath, gzip-on-store rows gunzipped inline, Go archive/zip's
  exact shape — pull-driven ReadableStream entry-by-entry, no
  arrayBuffer anywhere. The DELETE (web.go:1596's writer-gated arm,
  sameOriginGuard-first + RequireUnitWriter's NotFound) marks
  pending-deletion only — the retention sweep owns deletion — and
  answers `{}`, not Cancel's JSONOK. Mounted with chi-405 POST twins;
  the view-suite's unclaimed-tail pin flips in-commit (the dead-link
  rule). 247/247 own-eyes.
- **The commit guard's CI-parity hardening** (`57ace87`; §2 carries
  the story): the guard had typechecked its isolated worktree against
  whatever local `worker-configuration.d.ts` existed while CI
  regenerates from `wrangler.jsonc.example` — a var added to the
  example made the guard blind to exactly CI's literal-type errors
  (the false green under which `8155e16`'s TS2322 shipped). Now a
  candidate touching `apps/worker` gets example→wrangler.jsonc copied
  WORKTREE-ONLY (the account-local config is never read) and
  `wrangler types` run through the worktree binary before tsc;
  tooling hiccups degrade to a loud WARNING — the gate stays tsc's
  verdict, never a tooling red. The repro reconstructed the stale
  shape at `8155e16`^: the OLD guard passes (the false green,
  reproduced), the NEW guard fails with CI's exact error at the exact
  line. Self-test battery 28/28; the first candidate committed
  through the hardened guard was the hardening itself.

### The harvest and morning windows: the admin fold, the golden re-baseline, the real act_runner, the last store — and the F row completes

- **The admin actions pages fold onto the shared family nav**
  (`92d2e87` — `b5923ed`'s defer executed): AdminFamilyNav's Actions
  group carries Runners + Variables before Job queue
  (navbar.tmpl:73-89's exact order, locale keys verified against
  locale_en-US.json); both modules drop their local AdminActionsNav
  scaffolding for AdminFamilyShell (the C6 precedent's shape) with
  the two actions matrix suites' nav pins holding verbatim; the a11y
  arrays gain the two items; the TEN admin goldens each gain the
  one-span Actions-group insertion (byte-identical verified). The
  orchestrator's routed stale-pin fixes: admin-orgs.matrix:268 and
  admin-repos.matrix:348's not-contains `/-/admin/actions` pins had
  been RED AT HEAD since `0c8da44` added the job-queue item (the
  substring always matched its href — the C6 debt the fold surfaced);
  both flipped to the landed-set shape with scoped-workflows the
  remaining negative. 212 passed across the six touched suites
  own-eyes (the 39 repo-page golden reds named a SEPARATE pre-existing
  class — `b0e1d88`'s — and went to a dedicated unit, next).
- **The `b0e1d88` golden re-baseline** (`f1bfff9` — §2's
  golden-fallout story): the 39/80 committed-HEAD red that CI's
  fast-push cancellations had hidden since the flip; re-baselined via
  the established sentinel script (`update-goldens.mjs` — workerd
  tests have no fs, so it empties the goldens, drops the print-mode
  sentinel, extracts the @@GOLDEN:-framed renders from stdout, writes
  back byte-exactly; 80/80 captured; NO fixture change — the armed
  row IS the new true posture, the fixtures ride the real
  RepoService.create pipeline). Pure insertions, one line per file,
  five byte classes verified against the committed gates (§2); goldens
  80/80 + a11y 88/88 own-eyes re-run at landing (168/168 combined).
- **The act_runner real-binary smoke** (`90fa2d4` — the M2 guide's
  proof): `docs/research/act-runner-smoke-2026-10-30.md` — stock
  act_runner **v0.2.13** linux-amd64, sha256-verified against both
  release checksum files, run against the local vite dev Worker.
  **VERDICT: wire-compatible YES** — Register (global token, the
  `:docker://` schema stripped exactly as the guide claims), Declare
  at every daemon start, FetchTask claiming 3/3 seeded runs with the
  exact-match label behavior verified negatively (an ubuntu-labels
  daemon never claims a `runs-on:[smoke]` job), UpdateTask terminal
  SUCCESS (a real debian container running echo, the full
  task/job/run/attempt rollup) and FAILURE (busybox 127, wire-clean),
  UpdateLog hot rows + the no_more R2 seal read back from
  `actions/logs/…`, heartbeats persisting last_online/last_active.
  Four operational findings recorded: seeded payloads must carry
  `runs-on:` (PickPlatform falls back to a multi-GB ubuntu pull
  without it — M3's parser closes the trap); a config with populated
  `runner.labels` CLOBBERS registered labels at daemon start (the
  guide's §2.4 gains the one-source-of-truth warning: `--labels` OR
  the config, not both); dl.gitea.com's classic line redirect
  (0.2.x still hosted, **5.x unverified** — the pin stands); and the
  PRE-EXISTING `/install` first-admin window found DEAD on any
  migrated instance (migration 0003 seeds the assets system user vs
  the empty-users-table premise — tests wipe users so CI cannot see
  it; §4). The guide's §2.7 header now cites the real-binary proof
  above the fake-runner's zero-install framing.
- **The ActionsConfig store** (`97cb70e` — SPEC-0012's last open
  store; C9's dispatched follow-up RESOLVED): upstream `RepoUnit.Config`
  (models/repo/repo_unit.go:32 — the unit-type-specific TEXT JSON
  blob) lands as **migration 0043 `worthless_morlocks`'s nullable
  `repo_units.config`**, only the actions unit carrying one; the
  ActionsConfig per repo_unit_actions.go:76-93 (CollaborativeOwnerIDs,
  TokenPermissionMode, MaxTokenPermissions, OverrideOwnerConfig plus
  the workflow-disable maps) serialized in upstream's exact
  Go-marshal shape by `services/actions/config.ts`; NULL = upstream's
  nil-Config unit, the loader answering the zero value; the column's
  lifetime rides the landed unit-toggle lockstep for free (the
  disable arm deletes the actions row, wiping config — upstream
  ActionsUnitPost's newRepoUnit reset). The general page's two
  documented-unrendered sections (token-permissions +
  collaborative-owners, the cites pinned since `6fcb561`) now render
  and persist through the POST arm. Salvage note: the unit died at
  the 01:44 quota wall mid-flight without its final gates; the
  harvest window applied them at landing (config 24/24, general
  36/36, whole-tree bare tsc exit 0; the tree's quota-killed
  org-packages half-product separately reverted).
- **The F-row tail GETs** (`1ff87d1` — the survey's six, ALL now
  mounted; the F row COMPLETES): salvaged from a quota-killed unit
  (no death notice ever arrived; its four modules tested 46/46 +
  whole-tree tsc zero — the harvest window applied the three gates)
  and mounted from the modules' verbatim HANDOFF recipes: the
  JOB-SCOPED log download (web.go:1589) over M1b's chunk store/R2 —
  raw bytes re-issued without the line parse; the run→workflow-file
  303 (web.go:1591 — upstream renders no page) with BOTH workflow-id
  spellings tolerated (bare upstream + the M1a path-spelled),
  upstream's Base.Redirect 303 not the view arm's 302; the
  shields-style badge.svg (web.go:1606) — both SVG templates ported
  verbatim with the DejaVu advance table, GetWorkflowLatestRun over
  the store, cancelling/pending unmapped → "unknown status",
  anonymous passes (badges are embeddable); the dispatch-modal inputs
  FRAGMENT (web.go:1572 — an HTML fragment, NOT aux JSON) with
  `on.workflow_dispatch` inputs parsed in declaration order. Four
  parse arms, eight registrations with chi-405 POST twins, three
  neighbor pins flipped in-commit (the `/runs/7/logs` pin STAYS —
  upstream has no run-level logs route). 327/327 own-eyes.
- **The SPEC closure sync** (`0b59b91`): SPEC-0012's C9 section
  rewritten as-built (the ActionsConfig open item RESOLVED by
  `97cb70e` — the column nullable, NULL = upstream's nil-Config
  unit), a closures bullet recording the admin tails (`b5923ed`) and
  the survey's F row COMPLETE (`1ff87d1`); the still-open list
  shrinks to its floor — C5 (run-mutations, M3 emitter) + C10 (with
  M3) + the M3 trigger chain behind OQ-1 (§4). The specs index's
  0016 row marks the org packages settings page IN FLIGHT over the
  landed `package_cleanup_rules` table.

---

## 2. Engineering notes — the coherence incident chain

The wave's first hours produced one incident class and the tool that closes
it; recorded here because it changed how commits are made, honestly and
briefly.

The HANDOFF retirement sweep (`8fd9961`) swept two mid-flight artifacts into
commits: the fork unit's compare-parser snapshot (its four typecheck error
classes masked locally by the unit's live-tree fixes — restored at
`75400b5`, call-sites joined at `a48d244`) and, worse, flushed
legitimately-landed router arms off the shared file — the committed tree
404'd the repo-activity route on clean checkout until `b61220b` restored
the committed router's coherence and grafted the missing arm. The standing
fix is **`scripts/verify-commit.mjs`** (`946e2c4`): the staged-state commit
guard verifies exactly what a pathspec commit would land (temp-index
plumbing + an isolated worktree running real tsc, never touching the working
tree or the real index), with a 20-check self-test matrix. It earned its
keep the day it shipped — its real tsc caught the eight fork-era handler
errors that both the pipe-masked worktree check and the vitest composite
had missed (the composite never typechecks across files). CI's eslint then
caught the guard's own header convention (`43a9b39`).

The guard's next incident was a false GREEN (`57ace87`, with `8155e16`
the shipped red that proved it): the guard typechecked its isolated
worktree against whatever local `worker-configuration.d.ts` existed,
while CI regenerates from `wrangler.jsonc.example` — a var added to
the example makes the local file stale and the guard blind to exactly
CI's literal-type errors. The hardening: a candidate touching
`apps/worker` gets example→wrangler.jsonc copied WORKTREE-ONLY (the
account-local config is never read) and `wrangler types` run through
the worktree binary before tsc; tooling hiccups degrade to a loud
WARNING and proceed — the gate stays tsc's verdict, never a tooling
red. The unit's repro reconstructed the stale shape at `8155e16`^ and
showed the old guard pass (the false green, reproduced) and the new
one fail with CI's exact error at CI's exact line; the self-test
battery stands at 28/28 (extended with the regen-proof arm and the
fake-wrangler refusal).

The same morning's determinism work, one line each: the golden harness's
user `created_at` pinned to T0 (`7ba1ed6` — the admin-users date cell was a
daily time-bomb that rotted at midnight); the bench's push_bytes cycle
asymmetry pinned (`5f7caed`) and clone wall/rate floors calibrated above
the measured 4.5× cross-runner noise band — 2,000 ms / 5 MiB/s, after four
CI runs on clone-path-identical code spread 589–2677 ms against a 783 ms
baseline and false-fired the percentage gate (`9db02ab`); the stats
fixtures' conflict-merge construction made content-independent (a CI
runner's git refused to start the merge, the catch swallowed it, and a
fixture commit landed single-parent — run 40800106017 — both fixtures now
build clean merges with MERGE_HEAD asserted, and contributor-stats' checked
in Carol week recomputed) plus the GPG verify tests' bounded
flip-conditioned retry (`e5e1432`); and the demo-sweep cron tripwires pinned
`AUDIT_RETENTION_DAYS` off in test envs so CI's example-restored config
cannot arm the M4 audit producer against the zero-D1 tripwire (`fbc5a7c` —
51/51 reproduced under the armed var; ADR-0005 D3 at test-env level).

The extension's own notes, same discipline:

The **key-guard incident** (`2a8de93`) is the coherence chain's
engine-side sequel: the Step-1 split (2026-10-24) moved
`POST /git-receive-pack` off the cell's fetch handler and silently
dropped dgit v0.0.8's bindR2-first entry — the ONLY `meta.repo` binding
site — so a no-preflight receive on a never-fetched cell staged packs at
the unreachable `repos//` prefix (REPRODUCED 0/5→5/5, twice). The fix
restores upstream's name-binding invariant structurally: a public
`bindRepo` RPC (sealed-cell-guarded, idempotent like the fetch entry)
awaited before `beginReceive` in mod.ts — after the command-section
parse, so malformed bodies never touch the cell; explicit
`x-storage-key` and carried `storage_key` precedence unchanged. A
gate-side 4xx was REJECTED as a narrowing (upstream serves push-create).
Engine checks 27/27 incl. the strict-stub companions; git-http 62/62
(real pushes show doRpcs=4 — the bind riding) + repos 116/116; CI 26
checks. The class: a refactor that moves an entry point must re-verify
the side effects the old path performed — the same day's delete-user
cascade fix (`37758d5`) is the sibling instance, caught by probes rather
than review.

The **maven MD5** note (`dba7f9c`): Workers' WebCrypto lacks MD5, and
maven is the only registry protocol with it on the wire in both
directions — the port carries a local RFC-1321 implementation proven
against the RFC's own vectors AND upstream's pinned integration checksum
(`6bee0ce…`), with uploads repairing the dedup row's `hash_md5`
idempotently.

The **bench floors** moved again (`b859e28`): the overhead wall floor
recalibrates 150→200 ms — inforefs p95's identical-code noise range
extended to 181 ms (run 40829486610, +1083% on a throttled runner; the
failed-job rerun passed, confirming the documented one-slow-poll class
the TOLERANCE CLASSES header has tracked since 40710895496's 131 ms).
The wave's second floor recalibration, after §2's clone wall/rate
floors.

The **crash playbook ran for real** three times in one day, and held:
the graphData unit died by host crash after finishing (`7a21493` —
artifacts verified with the orchestrator's own eyes: 14/14 + five
neighbor checks + tree tsc), and the scanLfsPointers and home-sidebar
units were quota-killed post-completion (`fdfe73a`, `45ecd7c`) — every
artifact verified before the work was counted.

The **doc-repair class** got two same-day instances and a standing
method: the SPEC-header cleanup whose whole-file multi-space collapse
mangled 0016/0018 (573/607 line rewrites for a two-line edit — rebuilt
from the parent, the intended surgical edits reapplied, `387812f`), and
tick-17's survey commit claiming thirteen row edits and applying five
(`72f40ec`'s heal — the eight missing flips verified in-tree, every
landing commit re-verified, before the tables moved). Documentation that
outruns its own verification now has a named repair procedure: re-derive
from the tree, then edit.

The **save-arm clobber that never shipped** (`42c2af7`): retiring the
options form's enable_actions checkbox meant retiring its SAVE ARM, not
just the input — the pre-retirement absent-field-false parse would have
clobbered `has_actions` to 0 on every ordinary options save, silently
reverting the general page's toggle as a side effect of unrelated saves.
The class: a retired input is not a retired write path — a form parse
that defaults absent fields to false is a writer for every field it
names, and input retirement must audit the parse arm. The same unit's
golden update was a surgical one-span byte edit (python-verified) rather
than a full regen, which would have swept the integrator's in-flight
sibling renders into the commit.

The **fourth pipe-masking incident** was self-inflicted (`ff13b96`):
the maven mount (`a9fce00`) landed DESPITE a failing guard — the
committing chain piped the guard's output through tail and the pipe
masked the exit code, the exact class the verify-commit guard exists to
close, now observed in the guard-owner's own chains. The repair landed
five minutes after the mount; the rule is unchanged and now
twice-written: the guard's exit code must gate the commit directly,
never behind a display pipe.

The **stray-tests class** got its first catch (`7125c74`): two protocol
test files (`packages-{pypi,helm}.test.ts`) had been untracked since
`8d177aa` — green locally on every run, absent from CI's tree on every
run, because nothing stages an untracked file. The catch was a tree
census, not a test failure: count what the tree carries against what
the commits claim. An untracked test is a test that does not exist.

The **premise-death and escaped-landing pair** closed the final hour
(`d7a6f73`, `c269ff0`): the creation-defaults flip (`b0e1d88`) changed
a posture that committed tests had encoded, and the deaths surfaced in
three waves — the flip's own commit fixed pages-wave15's default-off
arm and the seedRepo UNIQUE collision, then the audit-logs and LFS
hasActions-threading matrices died on the same 'no repo_settings row'
premise (the flip seeds the ARMED row at create, so a reduced-phase
read of TRUE is no longer reachable by doing nothing); both were
rebuilt on explicit update-based polarity phases (the wave15 idiom),
disabled→no Actions block, armed→sub-items lit, the creation default
restored in a finally. Beside them, the second escaped-landing catch:
the runs-list icon set — 13 glyphs the landed C1 pages request — sat
in `gen-ui-icons.mjs`'s ALLOWLIST uncommitted since `0c8da44`. The
classes: a test that encodes a posture dies when the posture changes
(drive the polarity explicitly, never rest on a creation default), and
a landed page's dependencies are part of the landing (the
verify-commit guard's own class, this time a file the committing
window never staged).

The **golden-fallout class** is the premise-death family's third
member — bytes, not fixtures (`f1bfff9`): the creation-defaults flip
armed fixture repos at create, so the 39 repo-shell goldens generated
in the default-off era failed at committed HEAD from the moment
`b0e1d88` landed — invisible for hours because CI's fast-push
cancellations kept cancelling the very suites that would have shown
the red (the same hiding that carried `92d2e87`'s two stale
not-contains pins — red at HEAD since `0c8da44`'s job-queue href —
through four landings). The re-baseline ran the sentinel script
(workerd tests have no fs: empty the goldens, extract the
@@GOLDEN:-framed renders, write back byte-exactly) and produced pure
insertions, one line per file, in five byte classes verified against
the committed gates (shell.tsx:355/368, settings.tsx:676): the
Actions tab on all 38 repo shells, the Packages tab on the same 38
(the flip armed packages too), the hasActions settings-nav submenu on
the four settings goldens (settings-hook-detail correctly gains none
— its page never threads the flag), enable_packages checked on
team-admin, and ONE disclosed non-posture class —
org-settings-audit-logs's 65-byte Runners sub-item, committed drift
from `3ab7532` hidden inside the same 39-red suite since. The
classes: a posture change re-renders every committed golden built on
the old posture (regenerate at the merged state, and treat committed
drift surfaced by a regen as a finding, not noise); and a cancelled
CI run is not a green one — fast-push cancellations destroy the
evidence, so committed-HEAD red accumulates unseen until someone
re-runs the touched suites at HEAD and counts.

---

## 3. Compatibility notes

### New migrations

| Migration | Content | Commit | Remote |
|---|---|---|---|
| 0038 `luxuriant_tempest` | `audit_event` (+5 indexes incl. the EXPLAIN-witnessed `(scope_type, scope_id, created_unix)` composite) | `5c8853c` | applied remote — swept by the deploy-day migration pass |
| 0039 `talented_retro_girl` | the six `package*` tables (`packages`, `package_versions`, `package_files`, `package_blobs`, `package_properties`, `package_cleanup_rules`) | `8cdf44a` | applied remote ahead of code |
| 0040 `gorgeous_nico_minoru` | `system_notices` | `8cdf44a` (the shared schema pairing) | applied remote ahead of code |
| 0041 `workable_rick_jones` | the twelve `action*` tables (`action_runs`, `action_run_jobs`, `action_run_attempts`, `action_task_steps`, `action_task_outputs`, `action_tasks`, `action_tasks_versions`, `action_runners`, `action_runner_tokens`, `action_artifacts`, `action_log_chunks`, `action_run_job_summaries`) | `32ef8bf` | not recorded applied — the freeze window's deploy owns it |
| 0042 `rainy_captain_cross` | `system_keystore` — the Actions crypto-material home (write-once rows, operator-only rotation, the upstream-exact `base64url(SHA-256(SPKI DER))` kid, one-time legacy adoption of M1b's R2 object) | `3bc5d29` | not recorded applied — the freeze window's deploy owns it (with 0041) |
| 0043 `worthless_morlocks` | `repo_units.config` — nullable TEXT, the ActionsConfig store's home (NULL = upstream's nil-Config unit; only the actions unit carries one) | `97cb70e` | not recorded applied — the freeze window's deploy owns it (with 0041/0042) |

Schema stands at **86 tables** (73 + the twelve `action*` of 0041 +
`system_keystore` of 0042 — counted in the 0042 migration snapshot;
0043's `repo_units.config` is a COLUMN, not a table — the 0043
snapshot recounts to the same 86).
0039/0040's "applied remote ahead of code" is `8cdf44a`'s own record
("both already applied remote ahead of code by the deploy-day migration
pass, additive and reader-less until now"); 0038 — pending at the
mid-flight cut — was necessarily swept by the same pass (a pass that
applies 0039 applies its ancestors by construction). 0041 landed
committed with M1a (`32ef8bf`, all twelve tables in the migration),
0042 with the M1b residuals' closure (`3bc5d29`), and 0043 with the
ActionsConfig store (`97cb70e`); no deploy record this window marks
any of the three applied remote — the freeze window's deploy pass
owns all three.

### Declared-operation count: 500

SPEC-0016 M1's landing moved the count to **500/554 operations declared
across 306 paths** (`check:api` PASS at tick-18's re-run, `72f40ec`,
re-verified three times since — `abab71c`, `b2ff251`, and tick-19's
re-run at `0143e10` (`b7ef7e5`), still 500/554;
tier-1 terminal 78/78 paths, 129/129 ops) — the +10 is exactly the
package family's ops (`b6b0180`'s verified arithmetic). The remaining
54 FEATURE-ABSENT operations are Actions only (SPEC-0012 — M1a's and
M1b's landings are the `/api/actions` + `/api/actions_pipeline` runner
and ingestion surfaces, not `/api/v1` ops, so
the count is unmoved). One intentional divergence is now a documented runtime-only
exception: the packages unlink 204 (`110cf56` — upstream's handler
answers StatusNoContent while its own swagger block documents 201 empty;
our 204 is runtime-faithful, the frozen contract carries the
never-emitted 201).

### UI parity: the survey arithmetic

Tick-16's adjusted 103/2/11 climbed through tick-17 (`45ecd7c` — twelve
row flips across the two window commits, claimed headline 107/1/8) to
tick-18's **113 LANDED / 1 PARTIAL / 2 ABSENT** of 116, zero rows in
flight (`72f40ec`). Tick-18 also healed its predecessor: tick-17's doc
commit had applied only 5 of its 13 claimed row edits (the committed
tables stood at 99/4/13, not the claimed 107/1/8); the eight missing
flips were re-verified in-tree and applied before tick-18's own six
ABSENT→LANDED flips (`/explore/code` and `/{username}/-/code`,
`470e946`+`f50c9f7`; `/{username}/-/packages` and the repo packages
tab, `470e946`; the graph page, `9d7ccd6` over `7a21493`; the LFS
settings row, `9d7ccd6`). The one PARTIAL is the admin row (its
still-absent list shrunk to auths/packages/actions); the two ABSENT are
the actions subsystem rows — SPEC-0012's wave in flight. Router counts
refreshed: 349 route families, 234 page files (`72f40ec`). README's
implied 109/1/6 (`4c8277d`) was confirmed sound through `9d7ccd6`.

Tick-19 (`b7ef7e5`) — the survey's first PROGRAMMATIC walk, its
pre-edit run reproducing tick-18 exactly before applying its own
edits — moved the board to **114 LANDED / 2 PARTIAL / 0 ABSENT** of
116 at `e26c862`, zero rows in flight, the dispatch gate list EMPTY:
the E settings/actions row flipped LANDED (secrets/variables `a8e065f`
+ general `6fcb561` + arms/redirect/runners `0c8da44` — every
page-bearing GET in `web.go:1262-1278` serves), the F repo-actions row
flipped PARTIAL (the runs list + job queue + run-viewer subtree serve;
the six tail GETs — logs/workflow/artifacts-download/preview pair/
badge.svg/workflow-dispatch-inputs — stayed unclaimed at the tick's
HEAD), and the admin row stays PARTIAL with its absent list shrunk
(packages `a8e065f`, job-queue `0c8da44`; auths + the admin actions
tails remain). **Final tick: 115 LANDED / 1 PARTIAL / 0 ABSENT of 116
at `6bf9c17` (tick-21, 2026-10-30 — a zero-flip maintenance tick whose
two window landings completed arms inside already-LANDED rows; the one
PARTIAL is the admin auths page, needs-API-first)**. No tick has run since (tick-21 measured at `6bf9c17`);
the post-tick landings are implied-pending-next-tick, the survey's own
convention: the org runners twin (`3ab7532`), C3's log tail/steps +
C4's artifacts preview and signed raw serving (`cd7eec4`), the C4
census remainder — the per-name artifact download/delete pair
(`6f07849`) —, the admin actions tails with the shared-nav fold
(`b5923ed` + `92d2e87`), and the F-row tail GETs (`1ff87d1`) that
complete the F row. Tick-20 is expected in-flight and has NOT run at
this snapshot's HEAD (`0b59b91`); when it runs, the F row should read
LANDED and the admin row's absent list shrinks further
(scoped-workflows is the documented-reduced honest 404; auths the
OMIT verdict).

---

## 4. Known limitations and the in-flight list

- **54 FEATURE-ABSENT operations**, all Actions — SPEC-0012's rewrite is
  accepted with its demand gate lifted; the packages family's ten ops
  landed declared at `8cdf44a`.
- The **seven units most recently named in flight all landed** the
  same evening: SPEC-0012 M1a (`32ef8bf`) and M1b (`10cfb97`), the npm
  protocol (`a7d9bb1`)
  with the maven mount (`a9fce00`) and its forward repair (`ff13b96`),
  census C8 + the admin packages page + the loginRedirect fix in one
  window (`a8e065f`), and the five-family actions-UI integrator
  (`0c8da44`) — all counted above, none carried.
- **The actions tails LANDED** (they were this pre-draft's working-tree
  in-flight list; every one is now counted): the admin actions
  runners/variables families (`b5923ed`) with the shared-nav fold
  (`92d2e87`), the F-row tail GETs completing the survey's F row
  (`1ff87d1`), the C4 census remainder — the per-name artifact
  download/delete pair (`6f07849`) —, and C9's dispatched follow-up,
  the ActionsConfig store over migration 0043 (`97cb70e` — the
  token-permissions + collaborative-owners sections render and
  persist). **SPEC-0012's M1c census is COMPLETE but for the
  M3-deferred pair** — the residual floor, straight from the SPEC's
  own still-open list: **C5's** rerun + rerun-failed defer to M3's job
  emitter (the census's flagged split — the cancel arm landed inside
  C2's window); **C10's** scoped-workflow pages defer with M3 (the
  admin scoped-workflows page is the documented-reduced honest 404 per
  `b5923ed` — no `action_scoped_workflow_source` store, no
  workflow-file parser); and the **M3 trigger chain** stages behind
  Open question 1 (without it the control plane has no automatic
  producer — jobs arrive via the test-harness insertion seams).
  **SPEC-0016's M6 container + M7 index-builder** remain pending, and
  the **org packages settings page is IN FLIGHT** (the re-dispatched
  unit owns it — the landed substrate is `package_cleanup_rules` from
  migration 0039; do not count it landed).
- **Two honest findings from the act_runner smoke (`90fa2d4`) are
  open items**: the **`/install` first-admin window is DEAD on any
  migrated instance** — migration 0003 seeds the assets system user,
  defeating the empty-users-table premise, and tests wipe users so CI
  cannot see it; UNFIXED at this snapshot, pending the flying fix
  unit (harmless for the live instance, which has users). And
  **act_runner 5.x is UNVERIFIED** — the wire-compatible verdict
  covers v0.2.13 only (0.2.x is still what dl.gitea.com's classic
  line hosts); the guide's pin stands.
- **SPEC-0015 is COMPLETE** (`fdfe73a` closed M3); **SPEC-0019's R02/R05**
  are landed (`f50c9f7` + the `470e946` mounts) — the first cut's §4
  items for both are retired. **SPEC-0016 stands at M1–M5b landed**
  (`e26c862` closed M5b; M6 container + M7 index-builder pending);
  **SPEC-0012's control plane is COMPLETE** (M1a `32ef8bf` + M1b
  `10cfb97`, both ledgered residuals closed by `3bc5d29`) with **M2's
  guide landed and real-binary proven** (`0143e10`; the v0.2.13 smoke
  `90fa2d4` — wire-compatible YES) and **M1c COMPLETE but for the
  M3-deferred pair** (the org window `3ab7532`, the run-viewer's deep
  arms `cd7eec4`, the C4 remainder `6f07849`, the admin tails
  `b5923ed`+`92d2e87`, the F row `1ff87d1`, the ActionsConfig store
  `97cb70e`); the named floor above is what remains; the M3 trigger
  chain stages behind the expression-evaluator question.
- **Deploy posture**: migrations 0039/0040 sit applied-remote ahead of
  code (`8cdf44a`'s deploy-day migration pass record); 0041
  (`32ef8bf`), 0042 (`3bc5d29`) and 0043 (`97cb70e`) are committed but
  no deploy record this window marks any applied — the freeze window
  owns all three. The
  RD25 deployed-reality record in `docs/design/p0-evidence.md` remains
  the last fully-written production verdict; the freeze window owns
  this wave's deploy record. (The probe fix `c7ec2fe` reports all 12
  batteries green against deployed version `4e2fb76b` — a mid-window
  redeploy is implied by that line, but no deploy write-up landed in
  the docs this pass could verify. The toolkit now carries 14
  batteries / 176 probes — `49a1502` + `07221df` — so the freeze
  window's probe run is the new pair's and the nuget arm's first live
  exercise.)
- Carried unchanged from v1.2 §4: the ws1009 residuals (strip-mode trades
  original-position failure-frame mapping; the upstream chunked-frames fix
  remains desirable — ADR-0006's revisit trigger stays armed against
  cloudflare/workers-sdk#16349), git-over-HTTPS-only (ADR-0001), the absent
  `email_hash` table, and no `/assets` fallback target.
