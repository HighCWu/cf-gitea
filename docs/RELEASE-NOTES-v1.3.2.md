# cf-gitea v1.3.2 — Release Notes (the registry wave)

**Range**: `ce1b51c..FINAL_HEAD_TBD` — **FINAL_COUNT_TBD commits** (30 at
this document's snapshot, HEAD `1a38996`, taken 2026-10-31 in the early
hours +0800 while commits were still landing hourly — the freeze fill
resolves both markers). v1.3.1 tagged `4a5d6bd` (the freeze fill itself);
the board retarget `ce1b51c` — which opened this window by turning
`docs/residuals-v1.3.2.md` into the next dispatch list — sits at the
range's base and is excluded, so every commit below is the post-retarget
wave, landed 2026-10-30 23:31 through the snapshot. This document reads
together with `docs/RELEASE-NOTES-v1.3.1.md`, which it does not replace:
the archive git-semantics wave, the packages D-rows, and the api review's
E9 / collaborators / repoEdit items are v1.3.1 landings and are not
re-covered here (the two HIGH pre-deploy smoke finds closed inside the
v1.3.1 frozen range itself — deploy-token LFS admission `d99c150`,
collaborators PUT `4fcf60c` — before its tag).

The wave's shape: the Actions registry-management explosion — five
landings that move the declared `/api/v1` contract from 500 to 540 of 554
operations (P1-7 through P1-12) — the seventh packages protocol (the OCI
container registry, walked end-to-end with a real docker 28.1.1 daemon),
the git engine's receive-pack caps trio plus protocol-v2 partial clone,
the schema chain (migrations 0046–0048: the upload store, `last_login`,
the owner-settings KV home), the actions-settings General pages going
live at both scopes including their write arms, and the board's P2/P3
polish rows. Salvage discipline continued: two units finished their work
and died before reporting (rerun `613aa31`, workflows-extras `df85f21`)
and landed as-found with the green suites as the verification — the rerun
one through a premature-commit revert pair (`fd2cfdd`, reverted
`6945cee`). One commit's own pathspec miss was caught within the minute
(`26ce795`), and the container walk's live find (the root `onError`
passthrough) was fixed in the same landing that found it.

## 1. Git and engine

- **Receive-pack advertises and honors atomic pushes, push-options, and
  report-status-v2** (`e454a75`, the git review's P2-8 receive-pack
  pair, byte-observed on stock git 2.43.0 under GIT_TRACE_PACKET). The
  v0 advertisement now carries upstream's capability set (`report-status
  report-status-v2 delete-refs side-band-64k atomic ofs-delta
  push-options object-format=sha1`, minus two disclosed residuals —
  `quiet` unadvertised and the dgit agent identity). Push-options are
  advertised unconditionally per upstream Gitea's own
  `receive.advertisePushOptions=true` (`modules/git/config.go:40-42`),
  and the section grammar was corrected by observation, not by the
  brief's guess: no count pkt-line, no trailing LF, EOF-mid-section ends
  it (git's `read_push_options` bug-compat); options surface on
  ValidatePushContext/PushEvent as the `GIT_PUSH_OPTION_*` channel's
  equivalent. ATOMIC is a write-free verdict pass in commitPush — any
  reject or CAS-fail writes nothing, failed commands keep their
  messages, siblings answer `atomic push failed`, and the all-fail case
  surfaces as the existing ref_conflict shape; hook rejections under
  atomic funnel the existing all-rejected path. report-status-v2 is
  honored with zero option lines (no proc-receive — upstream's own
  posture); extraRefUpdates stay best-effort outside the guarantee.
- **Protocol v2 grows partial clone** (`e454a75`, same landing). The v2
  advertisement reads `version 2 / ls-refs=unborn / fetch=shallow
  filter (+agent)`; the unborn arm answers
  `unborn HEAD symref-target:<head>` byte-identically. BlobFilter parses
  `blob:none` and `blob:limit=<n>` (strict `>` boundary byte-verified)
  and hooks pack collection at the blob leaf only — promised blobs stay
  unmarked, a directly-wanted blob always ships (the lazy-fetch
  carve-out), and omitted delta bases re-emit whole. Under a filter the
  want gate relaxes to upstream's has-object rule (observed on stock
  git); unfiltered requests keep the stricter advertised-tips posture,
  and both full-clone fast paths exclude filtered requests. Real-client
  acceptance: `git clone --filter=blob:none` end-to-end including the
  lazy-fetch checkout round (fsck --strict clean), the
  `--filter=blob:limit=100` boundary, and `git push --atomic` + `-o`
  echo over HTTP — the stale-atomic failure byte-identical against
  reference http-backend (a stock-client quirk, disclosed). NOTICE
  carries both units' rows; the full 29-script engine sweep PASS=29
  including the new `check-receive-caps` (12) and
  `check-protocol-v2-partial` (7).
- **Annotated tags become readable across the engine boundary**
  (`7ba451a`, the board's P3-11). The engine gains a public
  `readTag(id)` RPC beside readCommit (the id is a RAW OID, never a ref
  name — resolveRef would shadow a tag with a same-named branch; a
  missing oid or non-tag object answers null; exactly one store.get,
  spy-pinned) plus `splitTagSignature`, the line-faithful port of
  upstream's trailing-signature-armor strip applied to EVERY tag read.
  Consumption: the tags service reads annotated tags' payload+tagger and
  lightweight tags' target-commit message, and all four wire surfaces
  land the data — ListTags/GetTag/CreateTag render `message`, and
  `GET /git/tags/{sha}` renders `message` + `tagger` (RFC3339) while
  still 404ing a lightweight sha. A new engine check `check-tag-read`
  (7/7, real git fixture with a handcrafted signed-armor tag object)
  joined ci.yml (30 scripts). NOTICE row appended, including the TagJson
  not-re-exported deviation (mod.ts frozen by the P2-8 policy).

## 2. Packages

- **The container (OCI) registry is live — the seventh protocol, walked
  end-to-end with a real docker daemon** (`bf7be9e`, SPEC-0016 M6).
  Upstream's `ContainerRoutes` mounts at the `/v2` ROOT (the router
  carve `segments[0] !== "v2"` keeps every `/v2/{owner}/…` out of the
  git-HTTP gate; `wrangler.jsonc.example` gains `run_worker_first
  "/v2/*"`). The surface per the pin: the ping/token/_catalog/
  `{username}`/* families with per-arm write/read gates; `GET /v2/token`
  mints the HS256 JWT (+24h expiry, anonymous = the Ghost -1 token)
  behind the Bearer realm handshake with HasAnyScope
  (read/write:package) gating; the blob flow POST(mount / single-?digest=
  / session) → PATCH chunks with the Content-Range offset gate and the
  stream-after-first-write arm → PUT digest-verified, session removed
  only on success; manifests at the 10MiB cap with the
  config-blob-exists → BLOB_UNKNOWN arm, the image-index flow, and the
  DELETE-AND-RECREATE overwrite that keeps the download count, Metadata,
  and the count-quota post-insert. The session store is the
  SPEC-attachment decision's upstream-faithful split: D1
  `package_blob_uploads` (migration `0046`, upstream's row shape minus
  the serializable hash state — disclosed: PUT re-streams chunks through
  fresh digests) + R2 chunk objects `packages/uploads/<uuid>/<seq>`, one
  object per PATCH (R2 multipart rejected — its 5MiB non-terminal floor
  breaks real small-chunk pushes); PATCH counters advance atomically
  under an expected-chunk-count guard; 512MiB per-chunk spool cap.
  ACCEPTANCE: the real-daemon walk — docker login → push `alpine:smoke`
  (the whole chunk dance) → pull at the same digest → run with byte
  parity; curl verification of tags/list, _catalog, the manifest HEAD
  headers (docker-content-digest + ETag + resolved content-type),
  ghost-token anonymous pull 200, anonymous DELETE 401. Suites: container
  36/36; the six-protocol neighbors 81+92+88. (The packages review's
  D-rows and serve-content port are v1.3.1 landings — see that
  document's §5.)

## 3. API

- **The Actions registry-management gap closes in five landings — the
  declared contract moves 500 → 540 of 554** (the board's P1-7 triage
  and its remainder rows P1-8 through P1-12; check:api PASS at each step,
  every new op exact-set ⊆ the frozen contract).
  - **The 15 runner-management ops** (`fbcfe5e`, P1-7's named gap). The
    triage first: of the row's 54 declared-missing ops, 23 were already
    landed (the secrets/variables batch), 15 are the runners family and
    land here, and 39 defer as the additive rows P1-8..P1-12. List/get/
    delete/patch + registration-token at repo/org/user scopes, over the
    landed actions model primitives (imported, never modified): the
    FindRunnerOptions default order (status-rank CASE with NULL→0
    COALESCE, is_disabled, last_online DESC, id ASC —
    `runner.go:286-315`), the coarse online/offline status + busy=ACTIVE
    + indexed custom labels, the registration-token REUSE semantics
    (POST is not a reset), PATCH's 404-before-422 order with the
    equal-value no-op and the real flip's task-version bump,
    FormOptionalBool's disabled=yes-parses-false quirk, the per-scope
    403 texts, and a global runner foreign in every non-admin context.
  - **The runs/jobs listings at all three scopes** (`f88f8ee`, P1-8, 6
    ops, contract 515→521). The gate discovery: this pair rides the
    reqReaderCheck arm, unlike the 403'd runner families — repo
    reqRepoReader (any authed viewer lists a public repo), org
    reqOrgMembership (a plain MEMBER lists), user plain reqToken + the
    landed rejectPublicOnly posture. The shared section ported with
    per-function anchors: the status words including
    blocked+needApproval→waiting, the sort/order 422 matrix
    (order-before-mode, absent-sort-ignores-order), the embedded
    repository's ZERO-permission block (ToRepo with AccessModeNone,
    doer-independent), the run's pull_requests arms (push-open-PR /
    PR-ref / exclude), and toApiWorkflowJob's NULL times → Go zero.
    Pins +18. Header deviations recorded (§9).
  - **The artifacts quartet + the raw fifth arm** (`ed5e26f`, P1-10,
    contract 521→525). getArtifacts (the full render with the
    keep-forever epoch sentinel, name filter, the silent page/limit
    clamp with NO pagination headers, the FinalizedArtifactsV4 filter,
    anti-enumeration 404, the reqRepoReader(TypeActions) 403 with the
    repo-admin OR-bypass); getArtifact (the v4 200; the miss family's
    lowercase text vs the v3 fallthrough's UPPERCASE — both pinned);
    deleteArtifact (204 + the CONFIRMED→pending-deletion flip, the
    upstream quirk that an EXPIRED v4 row 204s with NO flip, anonymous
    403 — upstream carries no reqToken here, the group-gate ORDER
    pinned); downloadArtifact (302 to the 60-min HMAC-tag-api signature,
    Go's redirect anchor body, the X-Gitea-Fetch-Action {redirect} JSON
    flip, expired 404 before the v3 404). The fifth arm,
    DownloadArtifactRaw, registers OUTSIDE all swagger groups exactly as
    upstream declares no block for it — a plain route, byte-exact through
    the ServeUserContentByFile chain with single-range 206 and the
    sig-verify ORDER (bad sig 404 before expired-link 401).
  - **The admin Actions family** (`ad8aff8`, P1-12, 7 ops, contract
    525→532; the stale "no-runner-tables" reduction retired). The shared
    runner/runs families delegating at ownerID=0/repoID=0 behind
    scope-admin → reqToken → reqSiteAdmin: the ADMIN-polarity runner
    census (repo/org/user/global rows all list), the GLOBAL registration
    token reused while active, the ID-only get (the twins' foreign arm
    does not exist here), delete 204, patch with the 404-before-422
    order, and the runs/jobs listings with no scope cond (every repo's
    rows, global id DESC). The 401/403 stay runtime-only per the
    /admin/cron precedent.
  - **The repo workflows-extras family** (`df85f21`, P1-9, 8 ops,
    contract 532→540). The workflows list/get/runs + disable/enable
    (the store riding the LANDED ActionsConfig repo_units.config) +
    dispatch (the inputs validation) + getWorkflowJob + job-logs (the
    log chunk store read with upstream's content type). Salvage-as-found
    from the fourth 1308 wave — the unit finished its work and suite
    (repo-actions 32/32 on the tree) but died before reporting; the
    verification is the green suite, tree tsc 0, and the guard (§8).
- **The transfer arm answers its TRUE statuses** (`51fe30d`, P2-6's
  remainder, part A). The pin answers **201 Created on the PENDING arm**
  (`transfer.go:126-130`) and 202 only on the direct arm — our
  202-on-pending had the SPEC's own comment's statuses swapped; the
  route flips, the runtime-only 201 entries land in BOTH tables (the
  declared 202 stays for the unexercised direct arm), and the compat
  harness gains the runtimeOnlyModelRef capability (runtime-only SUCCESS
  bodies body-validated against the contract model; first user the
  repoTransfer 201 scenario).
- **The pull-reviews list headers match upstream's pair** (`51fe30d`,
  part B). The premise was half-stale — X-Total-Count already existed;
  the real delta is upstream's SetTotalCountHeader = count +
  `Access-Control-Expose-Headers` append (`base.go:73-77`) with NO Link
  on ListPullReviews (`pull_review.go:98-103`) — we over-sent Link and
  lacked the expose; the exact pair now pins both ways.
- **The PR diff-stat trio mounts everywhere servable** (`51fe30d` part C
  + `77f712d`, P2-6 closed WHOLE). Upstream's block sits inside the
  single toAPIPullRequest UNGATED on isPayload (`pull.go:31-34`), so
  every single AND payload conversion fills
  `additions`/`deletions`/`changed_files` when servable. `51fe30d`
  mounted GET /pulls/{index} (over the engine's truncated-flag; the omit
  arms: null merge base, truncation — no upstream equivalent — and
  engine failures caught); `77f712d` mounted the rest: the CREATE 201
  (one MergeBase resolution feeding both the body and the opened
  payload; the equal-tips empty diff renders 0/0/0), the EDIT arm (a
  handler-local lazy memo feeds the body + all four payload renders, at
  most ONE engine read per PATCH, never paid on the 403/409/412 arms),
  BY-BASEHEAD, and the webhook payloads (merge-closed from the checked
  row's persisted mergeBase, the assign, the label-detach one-liner).
  Honestly unmounted (verified shapes, recorded — §8): the payload
  converter's remaining call sites in issues.ts and pull-reviews.ts and
  the no-Context services sites, each a recorded one-liner or small
  refactor.
- **The schema chain's API half lands** (`6aadbfc`, one landing over
  entangled files). (a) **`last_login`**: migration `0047`'s column
  serves the upstream render gate (`convert/user.go:82,113-121`) —
  self/admin see the instant, other viewers Go-zero, NULL → Go zero
  time — with the premise correction that upstream's session VERIFY
  never bumps the row (read-only CheckAuthToken), so mintSession stamps
  it in the SAME db.batch as the session insert and verification never
  touches it. (b) **`mergeable`**: the premise inverted at the pin — a
  non-nullable bool (`pull.go:65`), checking renders FALSE,
  ancestor/empty pass, WIP-title false, merged keeps status;
  mergeableOfRow lands and the contract de-nullables. (c) **`auto_init`**:
  README + .gitignore (the `# ---> name` join) + LICENSE (the placeholder
  engine license ported verbatim, catalogs vendored under api/data —
  import.meta.glob proven empty outside the worker root); unknown readme
  → pre-create 400, unknown gitignores/license → the init-failure 500 +
  cleanupRepository rollback riding the delete pipeline. (d) **email
  placeholder**: GetPlaceholderEmail's `{id}+{lower}@` noreply shape for
  non-authed viewers. `tag_message` verified already-fine (no such field
  at the pin).
- **Archived-repo release arms answer upstream's bare 500** (`0b39750`,
  P2-5; the v1.3.1-recorded 201 divergence retired). The chain verified
  hunk-by-hunk: the /releases subtree carries only mustEnableUnit —
  mustNotBeArchived NEVER runs for releases, no 423 exists at any level;
  the gate lives INSIDE createTag, after the duplicate check, before the
  draft gate (drafts refused too), reached by BOTH create and update —
  and neither upstream handler maps it, so both fall to the bare 500
  with the prod-blanked body. Ours implements the same gate in the same
  positions; pins flipped (201 → 500+body+no-ref-no-row; draft-create
  500s; 409 outranks the archived 500; archived edit 500s row-untouched;
  archived publish-from-draft 500s pre-tag-arm). SPEC-0005 §2.3
  rewritten.
- **The tag converters fold to the canonical ToTag shape** (`1ed3c74`,
  P3-11's open item). The converters take the readTagData output as a
  render-arms param (Message from the arms, Tagger through ToCommitUser,
  UTC RFC3339); the landed call sites keep compiling via a second
  overload whose spread-override renders the same wire bytes today, so
  the fold is invisible until the spreads retire.
- **The admin-auths row resolves to omission** (`faeec92`, P1-4; docs
  only). The needs-API-first premise verified UNSATISFIABLE at the
  source: upstream's /admin group mounts exactly
  cron/orgs/packages/users/emails/unadopted/hooks/actions, both vendored
  swagger JSONs parse to 350 paths with zero `/admin/auths*`, and the
  contract fetched LIVE from upstream main carries the same 350 paths —
  a web-search claim of /admin/auths endpoints disproved by the live
  fetch. SPEC-0018's as-built amendment records the four evidence
  points; the reopen gate (WEB CRUD when the external-login-chain SPEC
  lands, never an API ladder) is unchanged.
- **Not re-covered here — closed in the v1.3.1 window**: the E9
  comment-body/locked-issue gates (`d2fd6f0`), the collaborators PUT's
  unknown-permission semantics (`4fcf60c`), and repoEdit's fifteen
  merge-config fields + `assigned_by` (`7047639`, `4f8ade7`) — that
  document's §3 carries them.

## 4. Actions

- **Rerun + rerun-failed land, as a salvage with a revert story**
  (`613aa31`, the board's P1-2). The unit died at the 1308 wall AFTER
  finishing — suites green on the tree (rerun + run-viewer 84/84
  own-eyes) but before reporting. The surviving implementation is
  complete: the rerun service (`rerun.ts`, 659 lines) + its 521-line
  suite + the run-viewer page's mutation buttons, following upstream's
  `run.go` semantics, with the artifact-inheritance arm (rerun-failed
  keeps succeeded jobs' artifacts, resolving to the new attempt). The
  first landing (`fd2cfdd`) rode a chain-masking incident before its
  dependency landed and was reverted at `6945cee`; `613aa31` is the
  clean re-landing after the webui cluster's shell landed (`7e72149`),
  and the guard's only failure (untracked-module inclusion order) was
  staged and passed.
- **The scoped-workflows substrate's M3-independent pure layer**
  (`e24455c`, the board's P1-3, decomposed at the pin). The pages need
  not the M3 trigger chain but TWO independent substrates, either
  blocking alone (the `action_scoped_workflow_source` store and the
  parser's YAML half — the named M3 row). LANDED:
  `services/actions/scoped-workflows.ts`, upstream-verbatim
  (`scoped_workflow.go:18-41` + `scoped_workflows.go:31-195`) —
  SCOPED_WORKFLOW_DIRS (`.gitea/scoped_workflows`, the never-overlap
  rule), the path/context-name helpers, shouldEventCreateCommitStatus's
  six-event allowlist (upstream's own duplicated-truth TODO carried),
  parsePatternLines, buildScopedWorkflowInfos (the live+orphan merge),
  applyScopedWorkflowRequiredForm (fail-fast patterns-empty refusal,
  live-unchecked-with-patterns kept as history, orphan drops,
  required-orphan kept) — parameterized over parsed files/liveSet/
  configs so the staged store and pages consume it unchanged. STAGED
  with cites: the schema table port, the store service, the three page
  modules + route recipes, and the M3 arms (P1-13's rows). Until they
  land, the admin scoped-workflows page stays the documented honest 404
  and the nav folds stay folded OFF (the dead-link rule).

## 5. Web UI

- **The actions settings group's General pages go live end-to-end at
  both scopes** (`6bdd91f` + `180b409` + `4bffff0`, the board's P2-1 +
  P2-2 + P2-12, one whole). The PAGES (`6bdd91f`): GET
  `/{org}/settings/actions` and `/user/settings/actions` redirect 303 to
  the general page (upstream's misc.LocationRedirect convention, the
  bare-org URL mirrored exactly), the general pages render the NO-SETTING
  OwnerActionsConfig posture — upstream's own render for any owner
  without a saved row — with byte-level fidelity pinned; the navbars put
  General FIRST, and the settings-nav unions gain actions-general at
  both scopes (8 goldens re-baselined with token deltas verified, the
  neighbor pin flips disclosed). The MOUNTS (`180b409`, the handoff
  executed per its recipe): four routes, parse arms literal-first
  (the bare `actions` before `actions/runners`), both family unions
  extended, four parse-table pins. THE WRITES (`4bffff0`, the
  owner-store wave): upstream's own answer is a GENERIC KV —
  `user_setting` is a composite-unique key/value row upstream already
  carrying eight keys including ActionsConfig — so `user_settings_kv`
  lands column-for-column (migration `0048`; the FK cascade covers both
  owner scopes since upstream orgs are users rows), with the Go-exact
  serializer pinned. The POST port (`general.go:100-161`) follows
  upstream arm-for-arm: the absent-row permissive load, the add arm
  (within-owner resolution, the miss refusing with NOTHING stored,
  append-if-absent, the empty-name-saves no-op), the remove arm (the
  TEXT-repo-id sentinel adaptation disclosed), the permissions arm
  (EnumValue-valid gate only — an INVALID mode silently KEEPS stored
  values, the no-refusal arm pinned), the upsert + saved outcome; the
  loaders went async over the store. Suites: the store 15/15, org 16/16,
  user 7/7, index + org-actions neighbors 280/280; whole-tree tsc 0.
- **The wiki tab gates on the loaded unit state** (`a803843` +
  `4a04d46`, P2-4's web-UI arm). The pin dictates an INVERTED polarity:
  upstream's DefaultRepoUnits INCLUDES TypeWiki, so absent = render,
  explicit false = hide (the inverted twin of the has-actions/packages
  trio). The shell's tab region renders on `ctx.repoHasWiki !== false`;
  the render-time wiring rides resolveUiRequest's EXISTING settings read
  — zero extra D1 — so a settings-disabled wiki loses its tab on every
  repo page while enabled/unsaved repos render byte-identically (the
  goldens' no-regen posture held). Route-side was verified already
  correct (wikiPrologue 404-shells a disabled wiki). REMAINING: the API
  + git-HTTP arms (§8).
- **The review-webui rendering remainder** (`7e72149`, P2-7, three
  drifts closed). (1) The timeline id split: the row div carries
  `issuecomment-{id}` (HashTag) while the inner time anchor keeps
  `event-{id}` (EventTag) — the duplicate-id invalid DOM is gone and
  `#issuecomment-N` deep links land; the merge event renders upstream's
  sha link with ShortSha's 10 runes — with a premise correction: the old
  pin asserted an #event anchor on the merge line, but the pin's merge
  locale formats no anchor (unlike reopen/close). (2) The issues/pulls
  rows: PR rows render the upstream `.branches` pair (base + double-
  chevron + head, `/src/branch/` links; the cross-repo OwnerName arm
  dead without forks — disclosed) and the milestone cell is upstream's
  LINK (the module's "no milestone page" note was stale — the page had
  landed). (3) The header strip: the Issues tab's octicon-issue-opened,
  the Projects tab's octicon-project, the ADMIN SETTINGS TAB (gated on
  the static arms of isRepositoryAdmin; the D1 arms keep the
  viewerCanCreatePull disclosure precedent), and the cf-gitea
  "Created \<date\>" line retired (no upstream analog). Goldens: 41
  files regenerated, every token accounted. DEFERRED (recorded): the
  Code tab's ref-preserving href needs ctx assembly in index.ts.
- **LFS file views link /media, not /raw** (`cd895f6`, P3-10's verified
  tail). Upstream overwrites RawFileLink for LFS-pointed files
  (`view_file.go:210-212`) and EVERY template consumer reads the
  overwritten value, so the single rawLink composition flips wholesale;
  the /media family was already landed — zero route changes. Pins: the
  flipped links live-fetch 200; README/NOTES/logo/broken.bin keep /raw
  (broken.bin the malformed-pointer guard). Goldens byte-identical.

## 6. Infrastructure and database

- **Three new migrations**: `0046` `package_blob_uploads` (the container
  registry's upload store, `bf7be9e`), `0047` `users.last_login_at`
  (P3-7's column, `26ce795` + `6aadbfc`), and `0048` `user_settings_kv`
  (the owner-store wave's table, `26ce795` + `4bffff0`). The schema
  hunks for all three rode `bf7be9e` atomically as disclosed riders, and
  `26ce795` is the journal-consistency pair: `bf7be9e` committed
  `_journal.json`'s three entries but the 0047/0048 migration FILES rode
  untracked (a pathspec miss caught within the minute — every test's
  applyD1Migrations walks the journal, and a missing file breaks the
  whole suite); the commit lands only the two generated SQL+snapshot
  pairs.
- **The root onError passthrough fix** (found and fixed inside
  `bf7be9e`'s walk). The live docker walk exposed that the root
  `app.onError` lacked the hono/http-exception passthrough — every
  protocol family's THROWN 401 challenge rendered 500 live while their
  vitest parents honored it. One line at the override's top.
- **The UI request prologue parallelizes** (`e8ef89d`, P3-12's residue,
  with a premise correction). The board row's named page-loader pair was
  ALREADY parallel; the true residue sat in resolveUiRequest's prologue —
  loadManifest awaited BEFORE resolveViewer (whose chain owns
  verifySession's users-row read) serially on every UI request. Now a
  Promise.all pair (the manifest is independent; the bell count still
  follows the viewer). Behavior-identical; the 8 settings-nav golden
  reds at landing time were the actions-subtabs sibling's in-flight tabs
  — attributed, not this change.

## 7. Docs, board, and tests

- The board reconciliation (`84773c1`): every row hash-verified (57
  distinct), the window's landings folded in — P1-2, P1-3's substrate,
  P1-4, P2-1/P2-2's pages+mounts, P2-4's web-UI arm, P2-5 (strikes),
  P2-7 (narrowed), P2-8, P3-10 (strikes), P3-12 (strikes) — with the
  staged tails riding the new rows P1-13, P2-12, P2-13. Two stale spec
  lines fixed: SPEC-0005 §4.11's sha1-null tail and SPEC-0004's
  blanket-423 (the release family is the bare-500 exception).
- The residuals rename's missing half (`aa45f8e`): `ce1b51c`'s pathspec
  commit carried the new board file but not the git-mv deletion, leaving
  both files at HEAD; the old file's deletion folded as its own fix.
- The landed waves' stragglers (`1a38996`): three pathspec misses
  collected as coherent riders — the CreateRepoOption docstring (the
  auto_init landing note), the org-repos create-route comment (the
  500-rollback cites), and the P3-7 mint-stamp pin (the last_login
  mint/never-verify arm's missing test). Docs + one test; tree tsc stays
  0 with the P1-11 revert done.
- Window scale at the snapshot: 170 files changed, +50.4k/-1.2k lines —
  the majority goldens, tests, and the vendored auto-init catalogs.

## 8. In flight at the doc snapshot

Honest block — none of these is counted landed; each cites where the
record says so:

- **P1-11 — the runs deep family (14 ops)**: the sibling unit landed
  half-done (9 tsc errors) inside the fourth 1308 wave and its
  actions-runs files were reverted to keep the tree green; `df85f21`
  records the revert and the post-reset re-dispatch. The rerun trio of
  that family rides the LANDED rerun service (`613aa31`) when it
  returns.
- **The wiki gates rerun**: the wiki unit-gating batch across the API +
  git-HTTP layers — P2-4's remaining arms (`a803843`'s record: "API +
  git-HTTP stay the remainder"; the board sizes it M over the existing
  `repo_units` substrate). Re-dispatched; nothing committed at the
  snapshot.
- **P1-6 — SPEC-0016 M7, the index-builder family** (debian/alpine/rpm/
  arch metadata index renders; cargo LAST, demand-gated): the board's
  next packages dispatch, in the queue at doc time; nothing in the
  commit record.
- **The diff-stat one-liners (P2-13's tail)**: `77f712d`'s honestly
  unmounted list — the payload converter's call sites in issues.ts
  (:452/:507/:581) and pull-reviews.ts (:810/:1803), one-line follow-ups
  each, plus the env-taking wrapper the no-Context sites in services/
  {issues,webhooks-push}.ts need (a small shared-service refactor).
- **Carried, still uncommitted at the snapshot**: P2-13's E9 deferral
  record and the ~15 model.ts cite renumbers (carried from the previous
  board's block).
- For the record: the board's own in-flight block (written at snapshot
  `0b39750`) has since RESOLVED inside this window — the store/schema
  wave (`26ce795`, `6aadbfc`), the owner-store wave (`4bffff0`), and
  P3-11's engine wave (`7ba451a`, `1ed3c74`) all landed; the archive
  POST-arm pin unit it carried had already landed in v1.3.1 (`e9a6595`).

## 9. Compatibility notes

- **Three new migrations**: `0046`, `0047`, `0048`. v1.3.1's deploy
  applied through `0045`; apply the three with this deploy as usual
  (`pnpm db:migrate:remote`).
- **Behavior changes to test against**: repo transfer's pending arm now
  answers **201** (was 202; the direct arm keeps the declared 202)
  (`51fe30d`); PR payloads carry `mergeable` as a non-nullable boolean —
  false while checking, not null (`6aadbfc`); auto-init repo-create
  answers 400 for an unknown readme and 500-with-rollback for unknown
  gitignore/license templates (`6aadbfc`); user payloads render
  `last_login` (self/admin the instant, others Go-zero) and non-authed
  viewers see the noreply email placeholder (`6aadbfc`); archived-repo
  release create/edit now answer the bare 500 where ours answered 201
  (`0b39750`); the tags wire carries `message` (and `tagger` on
  /git/tags/{sha}) where it hardcoded empty (`7ba451a`, `1ed3c74`);
  receive-pack advertises atomic/push-options/report-status-v2 and honors
  them (`e454a75`); protocol-v2 serves partial clone (fetch=filter) and
  the unborn ls-refs arm (`e454a75`); the `/v2` container API is mounted
  at the root (`bf7be9e`); the actions-settings General pages accept
  POSTs where they were engine-owned 404s (`4bffff0`); the wiki tab
  hides on settings-disabled repos (`a803843`, `4a04d46`); LFS file
  views link /media (`cd895f6`); the PR diff-stat trio renders on the
  read/create/edit/by-basehead arms and several webhooks (`51fe30d`,
  `77f712d`); ListPullReviews drops Link and adds
  Access-Control-Expose-Headers (`51fe30d`).
- **Specs amended in-window**: SPEC-0004, SPEC-0005, SPEC-0016,
  SPEC-0018, plus the specs/README rows (the wiki unit-gating posture,
  the 0016 M6 as-built).

## 10. Known limitations

The consolidated board is `docs/residuals-v1.3.2.md` (reconciled at
`84773c1`; §8's in-flight items are sibling-owned — verify before
dispatching). The wave's own disclosed tails:

- Receive-pack: `quiet` stays unadvertised and the agent identity keeps
  the dgit shape (both disclosed residuals); extraRefUpdates sit outside
  the atomic guarantee; the stale-atomic failure over HTTP is a stock
  git client quirk, byte-identical against reference http-backend
  (`e454a75`).
- Archives: export-subst stays parsed but not substituted and `[attr]`
  macro patterns sit outside the compiled matcher subset — the
  engine-side expansion is the recorded future arm (carried P2-8).
- Container: PUT re-streams chunks through fresh digests (the upload
  row carries no serializable hash state); R2 multipart is rejected for
  its 5MiB non-terminal floor; `/v2` sits outside the frozen API
  contract by construction, documented in the SPEC-0016 as-built
  (`bf7be9e`).
- Artifacts: the 401/403 stay runtime-only per the /admin/cron precedent
  (declaring 403 would hard-fail check:api — upstream's own doc-comment
  gap) (`ad8aff8`, `ed5e26f`).
- The runs/jobs family's header deviations: the org jobs contract omits
  sort/order while the handler resolves them; exclude_pull_requests is
  read at every scope; the scoped-workflow branch is dead until P1-3's
  store lands (`f88f8ee`).
- `review_comments` stays omitted (no producer) (`51fe30d`,
  `77f712d`).
- The P1-9 landing is salvage-as-found: verification is the green suite,
  tree tsc 0, and the guard — the unit's full report never arrived
  (`df85f21`).
- The webui remainder keeps four S pieces (the Go-to-file/New-PR/Add-File
  home row, the `#issue-filters` toolbar skeleton, the releases
  Source-Code archive rows, the Code tab's ref-preserving href)
  (`7e72149`; board P2-7), and the wiki gate's API + git-HTTP arms are
  in flight (§8).
- The scoped-workflows pages and nav folds stage behind the store +
  parser substrates (P1-3/P1-13); the honest 404 stands in the meantime
  (`e24455c`).
- Carried from before: `language` renders `''` on both user serializers
  until the side store exists (a SPEC-0005 call), release
  rename-onto-existing-tag answers 500 off the unique index where
  upstream would write duplicates, and the unit-gates' documented
  divergences (the IsEmpty arm, the vacuous TypeCode read) stage behind
  isEmpty maintenance.
