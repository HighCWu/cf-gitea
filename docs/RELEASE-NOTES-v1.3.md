# cf-gitea v1.3 — Release Notes

Snapshot 2026-10-29, HEAD `72f40ec` — the v1.3 wave, now covering the
full day: 61 commits, `d68ad62`→`72f40ec`, all on 2026-10-29
(06:53 – 21:21 +0800). These notes were first cut MID-FLIGHT at
`e5e1432` (28 commits, landed as `37758d5`); the same day's second half
landed before the freeze — the five cut-time units inside the hour, the
wiki sibling's full git-HTTP and lifecycle arc, the packages registry's
run from model to maven, SPEC-0019's acceptance and pages, SPEC-0012's
demand-gate lift, the second UI wave, and the survey's climb to
113/1/2 — and is appended below in the same structure (§1's new
subsections, §2's notes, §3's tables). The window opened with the UI gap
census that classified and briefed every remaining survey row, landed
the engine read family at the boundary (grep with a budgeted NFA,
`activityStats`, `contributorStats`, plus the blame RPC), closed ten
census rows in one combined UI landing, shipped the audit-events model
with retention (migration 0038), and ratified four SPECs (0015–0018).
What still flies is named in §4 (SPEC-0012's M1a, the npm protocol +
the maven mount, census C8, the admin packages page, the loginRedirect
fix) — nothing in flight is counted as landed. Every number is quoted
from the commit or doc that recorded it; nothing was re-measured for
these notes.

**Cut point.** The v1.2 notes close at the seventh addendum (`8b9be25`, the
RD25 record). This window's first three commits are that release's last
breath — the RD25 postcheck (`d68ad62`, RESTING-STATE-COHERENT), the
push_bytes determinism pin (`5f7caed`), and the postcheck's closable batch
(`173deab`); the census (`b5fd430`) then opened this wave. Everything from
`d68ad62` to `72f40ec` is the delta these notes cover: `e5e1432` was the
mid-flight cut (committed at `37758d5`, snapshot that tree), and the
sections below carry the day's remaining 33 commits as the extension. The
next window performs the final cut and tag; the in-flight units in §4 land
into it, and the freeze window owns the wave's deploy record.

---

## 1. What v1.3 is

The directive is the census's own: **upstream Gitea serves it → cf-gitea
serves it** (`docs/compat/ui-gap-census-2026-10-29.md`, `b5fd430`). The
survey tick-16 remainder — 22 non-landed rows (17 ABSENT + 5 PARTIAL of
116) — was classified, briefed, and ranked; this window then executed the
top of that board, and by the day's last survey tick the board reads
113 LANDED / 1 PARTIAL / 2 ABSENT (`72f40ec`) — what remains is the
actions subsystem now being built (§4). The per-row landing ledger (row →
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
  in the test's local router); npm rides the working tree (§4).

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
material). M1a dispatched — in flight at notes time (§4). The UI half is
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

---

## 3. Compatibility notes

### New migrations

| Migration | Content | Commit | Remote |
|---|---|---|---|
| 0038 `luxuriant_tempest` | `audit_event` (+5 indexes incl. the EXPLAIN-witnessed `(scope_type, scope_id, created_unix)` composite) | `5c8853c` | applied remote — swept by the deploy-day migration pass |
| 0039 `talented_retro_girl` | the six `package*` tables (`packages`, `package_versions`, `package_files`, `package_blobs`, `package_properties`, `package_cleanup_rules`) | `8cdf44a` | applied remote ahead of code |
| 0040 `gorgeous_nico_minoru` | `system_notices` | `8cdf44a` (the shared schema pairing) | applied remote ahead of code |

Schema stands at **73 tables** (66 + six `package*` + `system_notices`).
0039/0040's "applied remote ahead of code" is `8cdf44a`'s own record
("both already applied remote ahead of code by the deploy-day migration
pass, additive and reader-less until now"); 0038 — pending at the
mid-flight cut — was necessarily swept by the same pass (a pass that
applies 0039 applies its ancestors by construction). The working tree
carries the uncommitted migration 0041 `workable_rick_jones`
(`action_artifacts` — SPEC-0012 M1a's first of twelve actions tables);
not counted here.

### Declared-operation count: 500

SPEC-0016 M1's landing moved the count to **500/554 operations declared
across 306 paths** (`check:api` PASS at tick-18's re-run, `72f40ec`;
tier-1 terminal 78/78 paths, 129/129 ops) — the +10 is exactly the
package family's ops (`b6b0180`'s verified arithmetic). The remaining
54 FEATURE-ABSENT operations are Actions only (SPEC-0012, M1a in
flight). One intentional divergence is now a documented runtime-only
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

---

## 4. Known limitations and the in-flight list

- **54 FEATURE-ABSENT operations**, all Actions — SPEC-0012's rewrite is
  accepted with its demand gate lifted; the packages family's ten ops
  landed declared at `8cdf44a`.
- **Five units in flight** (working tree, uncommitted — none counted
  anywhere in these notes or the README): **SPEC-0012 M1a** (the actions
  model — `services/actions/` + migration 0041 `workable_rick_jones`,
  `action_artifacts` first of the twelve), **SPEC-0016's npm protocol**
  with the **maven mount** riding (`routes/packages-protocols.ts` grows
  the mount block — the proven copy `dba7f9c` delivered verbatim),
  **census C8** (the repo settings Actions secrets/variables pages —
  the census's anytime row, no actions tables needed), the **admin
  packages page** (its list op has been declared since M1), and the
  **loginRedirect query-string fix** (the anonymous redirect now carries
  `url.search`). Sibling riders in the same tree: the empty-repo page's
  upstream Quick Guide render and the `not-found-response` module.
- **SPEC-0015 is COMPLETE** (`fdfe73a` closed M3); **SPEC-0019's R02/R05**
  are landed (`f50c9f7` + the `470e946` mounts) — the first cut's §4
  items for both are retired.
- **Deploy posture**: migrations 0039/0040 sit applied-remote ahead of
  code (`8cdf44a`'s deploy-day migration pass record). The RD25
  deployed-reality record in `docs/design/p0-evidence.md` remains the
  last fully-written production verdict; the freeze window owns this
  wave's deploy record. (The probe fix `c7ec2fe` reports all 12
  batteries green against deployed version `4e2fb76b` — a mid-window
  redeploy is implied by that line, but no deploy write-up landed in the
  docs this pass could verify.)
- Carried unchanged from v1.2 §4: the ws1009 residuals (strip-mode trades
  original-position failure-frame mapping; the upstream chunked-frames fix
  remains desirable — ADR-0006's revisit trigger stays armed against
  cloudflare/workers-sdk#16349), git-over-HTTPS-only (ADR-0001), the absent
  `email_hash` table, and no `/assets` fallback target.
