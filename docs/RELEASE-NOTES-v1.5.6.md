# cf-gitea v1.5.6 — Release Notes (the table-alignment wave)

**Range**: RANGE=`f032241..<release HEAD>` — **COMMIT_COUNT=48** commits, landed
across 2026-11-03's day and evening — the ADR-0007 schema-parity wave and
its adversarial-review loops.
Deployed as **`DEPLOY_ID=9cb84065`** (version
`9cb84065-24fa-4f2c-a335-cdc725d35078`). Probe battery **253 planned, all green on the release run (exit 0 — zero
FAIL-class) with 6 warns** (the documented token-unconfigured classes; under
the NEW four-way monitor taxonomy, see §3). The full-suite composite gate was accepted **green-with-adjudication on R3**:
480 files, 477 pass, ZERO assertion failures (R1's 15 assert-files and R2's 9
fully dispositioned: two REAL FN-4 blast regressions fixed — the D1
result-set-column-cap 500ing the notifications wide query, and TEN
batched-description readers still on the retired repo_settings store — plus
thirteen stale-pin re-pins), 3 timeout-files solo-exonerated ×2 deterministic
(webhooks, pull-engine — the v1.5.3-documented class; gitlink-dir-diff), and
the `87621de` EnvironmentTeardownError known unhandled class.
**Seven migrations land with this release** — `0062` (the Actions schedule
registry), `0063` (the federation follower store), `0064` (the PRStatus
stored-enum swap, data-only), `0065` (FN-3's `review_state.updated_files`),
`0066` (FN-6's repo_units completion), `0067` (FN-2's comment
mutation-metadata columns), `0068` (FN-4's repositories port columns) —
**the migration chain must apply BEFORE the new worker serves traffic**
(§3).

The wave's shape: **the user's ADR-0007 ruling — "对齐 gitea 的表结构，除平
台实在做不到的" — made upstream's table structures the default decision, and
everything else followed.** The ruling's first applications landed (FS's
`federation_followers` 0063, FM's two-table schedule registry 0062 with the
F7 CAS, FU's PRStatus realignment 0064), FN's whole-board table audit was
re-derived on disk after a session compaction ate the chat report (FW), the
pre-freeze adversarial review (FY) found a P1 in the new federation surface
and FT closed it before the freeze, and the Go-parity escaper campaign
completed its UI sweep (FP → FX → GA → GB). FQ unified the org route shape
(B3, the ⑲ axis's last survivor), FO landed DR-1(c) (the last K4 residual),
and FV rebuilt the monitor platform's auth posture (S-4's code half). A
second pre-freeze review loop (FY2) then returned a ready-for-freeze
verdict with two MEDIUMs, both found-then-routed — the cron case-sensitivity
bug fixed at GE's landing (`b17885e`) and the FN-5 false-drifts withdrawn
by GI (`4e3eddd`) — and GK's migration smoke proved the chain from-zero
GREEN and idempotent (§2). The wave's tail closed the census loop itself:
FN-6 completed repo_units (0066), GN dispositioned FN-9, and the cite-audit
pass GL had queued EXECUTED (`704cd7b`) — the audit doc's final tallies are
machine-re-grepped and every inherited cite re-verified (§1, §4).

## 1. The user-visible headlines

- **Table structures now align with upstream by default** (ADR-0007
  `76b4235`): upstream tables are the default exactly as upstream behavior
  is; every divergence is classified platform-adapted / intentional-recorded
  / drift, drift is a defect class, and this ADR is the standing migration
  grant for the drift class — each fix its own generated migration + SPEC
  record. "Avoids a migration" is no longer a justification.
- **ActivityPub follows persist** (FS `62a855f`+`20e109e`, migration 0063):
  the ledger's S-1 — a verified Follow now writes `federation_followers`
  (idempotent re-follow, silent Undo removal, user-delete cascade via FK);
  Accept/204 response bytes unchanged. Upstream at the pin has nothing to
  port (the follow architecture never merged mainline; #36789 deleted the
  inbox arm), so the alignment target is our SPEC's recorded fallback arm —
  intentional-recorded-with-predecessor per ADR-0007 §2. The delivery lane
  and any follower READER stay OQ-5-gated (don't-invent).
- **Scheduled workflows get upstream's two-table registry** (FM `1f4c94b`,
  migration 0062): `action_schedule` + `action_schedule_spec` (the singular
  upstream RegisterModel names, column-for-column with house adaptations)
  replace W14's stateless "tree is the registry" design; the schedule dedupe
  race (R1-F7, the v1.5.5 P2 record) is closed by a true CAS — the consumer's
  advance-UPDATE carries the read prev/next in its WHERE, so a redelivered
  message and a duplicate enqueue can no longer both insert; the
  `schedule_unix` probe and the hourly tree-scan producer are retired. The
  port includes robfig-cron parsing with the real @every phase delay and
  TZ=/CRON_TZ= through workerd Intl, the push-chain trigger at upstream's
  exact notify position, and the producer moved to the */10 step entry (the
  1m→10m floor replaces W14's 60m).
- **The schedule lifecycle completes at upstream's shape** (FZ `fd1fa58` —
  SPEC-0012 §D7's two recorded seams WIRED): changing a repo's Actions unit
  now registers/cleans schedules exactly as upstream's UpdateRepositoryUnits
  does — the DeleteScheduleTaskByRepo + DetectAndHandleSchedules pair fires
  after the settings batch commits, and a unit DISABLE additionally runs
  CleanRepoScheduleTasks post-tx; archiving a repo now cleans its schedule
  rows (shared setRepoArchived; unarchive cleans nothing — upstream's own
  else-branch). The brief's "periodic cleanup" premise was corrected on the
  record: upstream has NO periodic cleanup, the clean is EVENT-DRIVEN at
  four seams; the directed `clean_repo_schedule_tasks` cron (hourly,
  probe-gated) sweeps only residue — schedule rows of archived or
  actions-unit-less repos, never enabled repos. Take-alongs disclosed (the
  purge consumer arm, the repo API archive/PATCH threading, the ui
  settings-submit threading, one trigger.test reseed — the now-wired enable
  arm's delete half was wiping the just-registered rows, upstream's own
  behavior); the admin-monitor-cron golden re-baselined with exactly one
  added census row.
- **PRStatus reads with upstream's semantics** (FU `6337ab0`, migration
  0064): our stored Mergeable/ManuallyMerged values were swapped against
  upstream's iota (`pull.go:100-107`), so rows read with flipped meaning;
  0064 is a data-only CASE swap (2↔3, the position-stable values pass
  through) — production rows carry the swapped semantics until it applies.
- **The whole-board table census is on disk** (FW `263d83c`):
  `docs/research/table-alignment-audit.md` — upstream 117 tables vs our 107,
  adjudicated at the landing 47 aligned / 22 intentional-recorded / 26
  drift / 22 missing-table + 12 ours-extras (tallies as re-derived at
  `263d83c`; corrected in-wave to 46 / 23 / 26 / 22 by FN-13's issue_watch
  flip + GI's reconciliation, and re-grepped to the FINAL **46 / 26 / 23 /
  22 = 117** by GL-resume's cite-audit `704cd7b` — see the FN-13/GI and
  consolidation bullets below), with the drift backlog FN-1..FN-14
  (API-visible first). The re-derived numbers supersede the compaction-lost
  remembered ~115/60/4.
- **The per-file viewed map lands** (FN-3 `e6a5a70`, migration 0065 —
  ADR-0007's third drift application, the audit's recommended opener):
  `review_state.updated_files` (TEXT NOT NULL DEFAULT '{}' — one ALTER; the
  DEFAULT is the recorded house adaptation covering pre-map cursor rows).
  Upstream's ReviewState is one row per (user, pull, commit_sha); the port's
  write arm merges same-sha posts per-key and seeds a new-sha row from the
  newest other-commit row, so **viewed marks INHERIT across a push**; the
  read arm serves changed-since-cursor when the cursor is stale; the merge
  box consumes nothing (grep-proven); upstream's SyncUserSpecificDiff
  GET-side write is deliberately NOT ported (recorded in the SPEC: the
  recompute covers the stale-cursor window). New SPEC:
  `specs/table-alignment-fn3-review-state.md`.
- **The record-not-migrate families are dispositioned** (FN-13 `89f946c`):
  per ADR-0007's own test, every intentional-recorded divergence now
  carries its SPEC — zero silent reclassifications. The ~386-column
  ours-stricter NOT-NULL arm is intentional-recorded on the REAL ground
  (effective-shape parity: xorm writes Go zero values on INSERT and NULL
  reads back as the zero value — explicitly NOT platform-adapted);
  users.email/avatar_email rides SPEC-0002 §4.6 item 16; the 16
  created_at/updated_at pairs and the 7-member uid→user_id family are
  recorded with mass rename DECLINED (zero API surface reads SQL names);
  7 association tables get per-table name records (SPEC-0005 §3.2's new
  schema-wide block + audit §7). Two OURS-LOOSER inversions were REFUSED
  reclassification and stay drift: issue_subscriptions' timestamps → FN-12,
  issue_pins.repo_id → FN-10.
- **The census was cleaned and reconciled in-wave** (GI `4e3eddd`): the
  issues.title side-find CONFIRMED at the pin (upstream's column is
  literally `name` via an explicit xorm tag — a real drift the census had
  called aligned; FN-5 recorded as its carrier); FY2's two false drifts
  verified and WITHDRAWN (upstream's RedirectURIs column IS redirect_uris —
  the `redirect_ur_is` quirk never existed; package_blob's hash fields
  carry explicit overrides, and ours' NULLable md5/sha1/sha512 is a real
  recorded divergence → intentional-recorded, not aligned; disclosed
  deviation from the dispatch's aligned instruction). A method rule enters
  the audit's §1 (check the xorm tag's first token before classifying any
  gonic rename — quoted tokens pin legacy names). Tallies after GI's three
  moves: 46 aligned + 23 intentional-recorded + 26 drift + 22 missing =
  117 (the pre-GI 47/26 headline was stale after FN-13's flip) — since
  re-grepped to the FINAL 46/26/23/22 by GL-resume's cite-audit (below);
  the §4 drift-column figure dropped 69 → 65 (+1 issues.title RENAME, −5
  false RENAMEs withdrawn — executing the old FN-5 would have BROKEN
  parity).
- **FN-2's derivation lands as a plan, and the census loses one column**
  (GJ `c6bb42f`): the audit's "MISSING patch_quoted + OURS-EXTRA patch"
  pair was WRONG — upstream's persisted column IS `patch`
  (PatchQuoted string xorm:"LONGTEXT patch", comment.go:330 — a bare-token
  column override, the method rule's newest instance; Patch itself is
  xorm:"-"), so ours `comments.patch` is PARITY: the comment
  mutation-metadata family is SEVEN columns, not eight, no DDL for that
  pair. The full write/read verdict matrix (~130 lines, every cell both-
  side cited) lands in the audit's §4: project_id/old_project_id, time_id,
  assignee_team_id, comment_meta_data → PORT (with the type-30 content=''
  flip — today's JSON leaks into the timeline API body);
  original_author/original_author_id were staged PORT-WHEN-READ deferred
  to FN-9 — GN's disposition (below) then ruled them
  intentional-recorded-absent, leaving **FN-2-proper a FIVE-column port**.
  The port plan is staged as SPEC-0005 §7 (221 lines, PLAN-ONLY: the DDL,
  four write seams, three backfills, a 12-test battery design, four open
  judgment calls) — the report IS the FN-2-proper brief. The audit's own
  leftover folds (§3.1 comment row, §5 bullet, Headline) LANDED with the
  cite-audit pass (`704cd7b` §7.9 — the draft's "they still say
  8-cols/patch_quoted" caveat is satisfied).
- **The schedule residuals close and the cron names register** (GE
  `b17885e` — FZ's two recorded §D7 residuals + FY2's MEDIUM): the
  push-path carve-out's EVENT DRIFT is closed with upstream's own
  two-caller split (the carve-out routes through the standalone
  registration with event schedule/null payload — so `github.event_name`
  no longer sees `push` on a schedule-created run — while the fused push
  twin keeps push/payload pinned; the carve-out also moved ABOVE the unit
  gate per FY2's ordering flag, matching upstream's notify order);
  SwitchSchedulesToDefaultBranch is PORTED with its premise corrected (it
  lives in services/actions/clear_tasks.go:65-77, not models) — delete →
  cancel-live-runs-on-the-old-ref → unit-gated re-register from the new
  default, wired at the API-PATCH, web-form, and RENAME arms; and the
  rename port closes a PRE-EXISTING gap (our rename never re-pointed
  repositories.default_branch nor HEAD — both now follow; disclosed
  residual: no cross-store tx). FY2's cron case-sensitivity MEDIUM is
  fixed: parseIntOrName lowercases before the table probe, so MON/Jan/SUN
  register where they silently registered nothing.
- **The non-UI escaper census** (GC `70a1673`): 16 sites ported to the
  Go-parity encoders (git-models zipball/tarball + toReference,
  workflowWire urls, oauth2-login's callbackRedirectUri — GB's flagged
  tail, the packages family's tarball/version/name/file urls each at its
  own PathEscape arity, packages-protocols, actions-artifacts'
  content-disposition, issue-attachments + archive download names); a
  real SHAPE bug found under the port cite — our toReference DOUBLED the
  segment (`/git/tags/refs/tags/v1` where upstream renders
  `/git/refs/tags/v1`) — fixed, and the fixed URLs now actually resolve
  (disclosed response-bytes change); the family guard pins generalize
  FX's pattern (~60 segments, byte-equality + gate-disjointness); no-change
  verdicts recorded per class (fixed enums, already-Go-exact, the
  query family KEPT decode-equivalent, self-consistent carriers,
  non-parity surfaces). The two route-level packages test files the
  landing's pathspec missed followed as the addendum `428e3e7` (helm
  index urls + npm's goPathEscape, the Go-exact differential pins;
  orchestrator pathspec miss, GC credit).
- **repo_units completes against upstream's RepoUnit** (FN-6 `65fda19`,
  migration 0066 — ADR-0007's fourth drift application): the `id`
  surrogate pk (repo_unit.go:43 — non-referencing pk, ADDED per the
  audit's id-family rule, no reader upstream either, shape parity), the
  `created_unix` stamp (repo_unit.go:47 — xorm auto-fills at insert; ours
  stamps the create batch, and 0066 backfills carried rows from parent
  repositories.created_at), and `everyone_access_mode` (repo_unit.go:49
  NOT NULL DEFAULT 0 → TEXT enum none|read|write DEFAULT 'none' —
  PORTED port-when-read with both arms cited: upstream's writer is
  UpdateRepoUnitPublicAccess via PublicAccessPost and the READER is the
  permission calculator's everyone arm repo_permission.go:231-234; ours
  has no such surface, nothing invented). The natural (repo_id, type) pk
  survives as `repo_units_repo_type_uq` — ours-stricter vs upstream's
  non-unique index, load-bearing as the ON CONFLICT target of every unit
  upsert (repo-settings.ts:399/:419/:436, compatibility verified). The
  landing self-caught a real defect: drizzle's generated rebuild copied
  the NEW columns from the OLD table by double-quoted name — SQLite's
  double-quoted-string rule turned them into LITERAL strings (first apply
  carried created_unix typeof text, everyone_access_mode =
  'everyone_access_mode'); the test suites had passed because fresh test
  D1s carry no pre-0066 rows — the LOCAL-APPLY gate on real carried rows
  caught it, fixed in the migration text, end state PRAGMA-verified. The
  landing also carries GK's snapshot-naming fix (0065's meta file renamed
  to `0065_snapshot.json` BEFORE generating; the id/prevId chain
  verified). Its recorded follow-up folded same-day (`8925a3b`): the
  three unit-insert arms now stamp createdAt (actions :399, pull_requests
  :417, projects :435 — upstream xorm auto-fills CreatedUnix at every
  insert, repo_unit.go:47; onConflict arms leave the original stamp
  untouched, xorm's reinsert-preserve).
- **The 0065 snapshot rename completes in history** (`8a91597`): FN-6's
  landing carried only the new path in its pathspec, leaving the git-mv's
  staged delete behind — this commit deletes the OLD name
  (`meta/0065_review-state-updated-files.json`), completing GK's
  convention fix; content already at `meta/0065_snapshot.json`.
- **FN-9 dispositioned recorded-absent, and the issues twin RESERVED**
  (GN `1a53a7c`): the original_author/original_author_id family's ONLY
  writer is the forge-metadata importer — every write is an
  ExternalUserRemappable impl (issue/comment/review/reaction/release,
  five remap methods) and every caller is gitea_uploader.go's remapUser;
  the lifecycle is import-time-only and permanent (mapped-local is
  actively CLEARED, unmapped records PosterID = the migrating doer). Our
  surface has NO importer and its single entry point REFUSES one
  (SPEC-0009 §1 defers forge-metadata migration, §2.2 contracts the 422
  refusal); no spec/ledger/roadmap schedules one; and observable parity
  holds at the empty arm — every reader keys off non-empty and degrades
  to the plain local arm we ship (ToAuthor's ghost fallback, ~15
  templates, roleDescriptor, IsPoster, review aggregation, the reaction
  pseudo-user + its delete-guards). Port-when-read and recorded-absent
  share one trigger (imported content existing), so the row CLOSES with
  the trigger named: a future SPEC-0009 forge-metadata extension owns
  the family end-to-end, its landing points pre-derived (audit §7.11).
  The issues.original_author twin (present-but-unwritten) is RESERVED per
  the house precedent — removal would cost a table-rebuild for state the
  importer SPEC would re-add; recorded normatively in SPEC-0005 §9
  (headed RECORD). FN-2's DEFER-vs-LAND open item resolves to DEFER
  citing §9.
- **The four-family audit consolidation closes the census loop**
  (`704cd7b` — GS + GR + GL-resume + GM-resume, deliberately bundled
  through the shared file's concurrent-edit windows): **GL-resume §7.9**
  EXECUTES the cite-audit pass GI had queued — 410 cite targets verified
  at the pin, 77 inherited corrections re-verified with zero rejects, two
  further fixes (one a file-misattribution: exact line, wrong same-named
  file), the cite-drift PATTERN ROOT recorded in three types (the
  dominant ~85%: session-scratch parsers), all folds residue-grepped
  clean, and the Headline MACHINE-RE-GREPPED to the FINAL tallies
  **46 aligned + 26 intentional-recorded + 23 drift + 22 missing = 117**
  (the three review/reaction/release original_author cells moved
  drift→intentional-recorded per GN's §7.11; recorded-absent corrected
  6→8 — exactly why FN-2 ports five); **GR** dispositioned repositories'
  26-column residual — 18 drift ports + 4 standing-record folds + 4
  staged folds (the slug/owner_namespace UNRECORDED folds are the
  finding), one additive no-rebuild migration staged, one TYPE row
  withdrawn (close_issues_via_commit_in_any_branch has our mode wrapper);
  **GS §3.3** scrutinized the no-reader arm — renamed_branch's trigger is
  LIVE-HARD (both rename writers landed but persist no log; stale
  /src/branch/{old} deep links silently serve the DEFAULT branch's
  content — a wrong-content gap), commit_status_summary's PR-rollup
  hypothesis REFUTED (upstream's merge box computes from raw rows; the
  summary serves only the repo-list badge — perf-only, LOW), and
  app_state's old function-covered ground corrected as factually wrong
  (its two consumers are platform-absent); **GM-resume §7.10 + SPEC-0005
  §8** finalized FN-5 at **18 renames (17 columns + 1 table)** — 16
  re-verified + 2 sweep adds (repo_transfer.new_owner_id→recipient_id,
  review_state.issue_id→pull_id), every member a CHEAP rename under the
  property-kept contract (only schema.ts's 18 column-name strings
  change; zero app-code edits; production has zero raw-SQL bindings; the
  must-edit surface is ~26 raw-SQL fixture lines across 6 test files),
  with the migration shape EVIDENCED: drizzle-kit detects renames and
  emits ALTER TABLE RENAME COLUMN (non-TTY fails LOUD, never silent
  drop+add) — §8 staged PLAN-ONLY.
- **The federation signer-binding P1 closed before the freeze** (FT
  `9e4fc2a`, found by FY's pre-freeze review): both inbox arms now key to
  the VERIFIED signature's keyId — previously a validly-signed remote actor
  could fabricate a follow attributed to any IRI or remove another actor's
  stored row; valid-path Accept bytes are unchanged, and the false
  "the pair key bounds a stranger's Undo to a no-op" claim is corrected in
  code, tests, and SPEC §5 (the old claim explicitly marked WRONG).
- **Org routes unify at upstream's shape** (FQ `336030d`, ledger B3 — the
  ⑲ axis's last survivor): every org surface now lives under `/org/:owner`
  (teams, settings subpages, labels at `/org/:owner/settings/labels`,
  worktime) — parse claims, the 92 uiRouter registrations, the 42 redirect
  targets, and every href producer emit the canonical bytes; the retired
  bare paths are upstream-faithfully repository paths now (404, no
  redirect), claim-pinned; 7 org-family goldens re-baselined byte-surgically.
- **The scoped-workflow banner and sidebar groups** (FO `5854a88`, ledger
  DR-1(c) — the last K4 residual): the runs page ports
  `prepareScopedWorkflows` (one walk per source), the dispatch banner gets
  its exact repo-level/scoped split gated on `IsScopedWorkflowOptedOut`, and
  the dispatch-inputs fragment's TEXT-id arm replaces the v1 404-reduction
  with upstream's failure shape (every failed arm renders not-found over
  HTTP 200).
- **The escaper campaign's UI sweep completed** (FP `049c09a` → FX
  `c28498f` → GA `c1d91fd` → GB `a2e992e`, all Go-probe-verified against the
  local go1.25.1): the four feed-XML local copies swapped to the released
  Go-parity port (SW-2); artifacts downloadUrl + content-disposition
  rewritten Go-exact (FX's shared-port latent `{`,`}` isTokenChar bug found
  and fixed in GA, the 84-line local copy deleted); ref-path sites ported to
  `PathEscapeSegments`; and the name-segment family — **two real routing
  fixes**: team names and badge slugs are charset-UNgated both sides, so
  `$&+:=@`-carrying names no longer 404 or break routing.
- **Blocked users lose the follow button** (FP `049c09a`): the profile
  follow button gates on the landed `isBlockedBy` seam in BOTH profile
  loaders (upstream's `{{if not .UserBlocking}}`); the org pages deliberately
  do NOT gate — upstream never gates org follow on blocking (recorded, not
  gated).
- **The monitor platform's one-time-auth redesign** (FV `b8beef4`, ledger
  S-4's code half): `scripts/setup-monitor-auth.mjs` — one-time token
  intake, per-scope dry-run validation with a four-way verdict, 0600
  `.monitor-auth.json` store; the battery's blanket warn-skip is retired
  into the honest four-way taxonomy (missing-auth warn / permission-denied
  FAIL / api-unsupported warn / failure FAIL) with PERSISTED-RESTORE on the
  `/set` loop; NO coverage reduction — all six monitor checks keep live
  paths, 253 probes unchanged. What remains is OPERATIONAL (§4).
- **The monitor battery's CLI contract cleanup + the 0600 write-window**
  (GH `01fff06`, then `c3e4f14`): `--base-url`/`--token-file` are now
  optional for a monitor-only invocation — monitor-platform's HTTP goes to
  the Cloudflare API (MONITOR_CF_API_BASE) with the CLOUDFLARE_* env / the
  persisted store and NEVER reads the pair, so demanding unused inputs when
  no CF auth exists was worse than the taxonomy's own designed
  missing-auth `[warn]` (a documented DEVIATION from the brief's
  store-gated conditionality; the Worker-origin batteries still demand the
  pair; a supplied token file is still validated 0600 + mint-shape and
  scrubbed). ZERO probe-path changes — the four-way taxonomy and all 253
  plans are byte-identical; the test battery grew 28 → 31 assertions. And
  the store write now PRE-CHMODS before the token bytes land (writeFile's
  mode option applies only at creation, so a pre-existing loose 0644 file
  received the bytes while still loose — FY2's LOW nit, landed as a
  disclosed orchestrator fold with FY2 credit; 31-assertion battery
  all-pass re-run).
- **The stale-comment/cite tail** (FY's findings, landed as docs: `03a35f1`
  and `4d79e56`): FQ's two route-ladder comment corrections, SPEC-0013's
  three DR-1(c) pin-range corrections (re-derived at the pin), and the four
  stale person.go cite ranges (see §2 for the correction chain).

The wave's tail — every unit the preparation listed as in-flight LANDED,
plus the follow-on units their reports routed (all adversarially reviewed
or orchestrator-verified before landing):

- **The serve pipeline is upstream's** (GP `ad84516`): the attachments
  routes ride ServeUserContentByFile's decision table — sniffed type ->
  INLINE over the RESOLVED type (SVG -> attachment only when rendering is
  disabled — the frozen default keeps every class inline, both arms
  pinned), the CSP sandbox tri-split, nosniff, the octet floor; the
  archive arm keeps upstream's own attachment word and gains the weak-ETag
  304 (`W/"oid-format-true"`, 304 carries ETag+Link). Four
  predecessor-defect fixes rode the resume (Go-exact date validation —
  Feb 31 fails, no JS rollover; the empty-INM IMS consult; the bare-405
  OPTIONS; the router's duplicated sniff pipeline collapsed onto the
  shared one). GV `71e228a` added the two upstream ROUTE twins (the
  release twin with its reqRepoReleaseReader unit gate — a DISABLED unit
  grants nobody — replacing wave-41's reduced pipeline via mount-order
  shadowing; the compat twin genuinely new), GX `ea49214` consolidated the
  packages serve-content onto the shared ServeSetHeaders family (four
  encoder drifts closed, ~100 duplicated lines deleted, a one-table
  equivalence pin), and GY `205f5ab` wired the actions log sites (both
  gain the nosniff + sandbox CSP the old hardcoded sets omitted).
- **Branch renames rewrite protected rules** (GT `44cc8fa`): upstream's
  rename-tx arm ported exactly — exact-named rules rename in place
  (branch_name only), a different rule claiming the target silently skips
  (upstream's own posture), wildcards are NEVER rewritten, and renaming
  ONTO a protected name now refuses (the bypass this closes); GW
  `6b25bb3` rendered the flash families on the page (one banner surface,
  success renders, the create family's missing/error arms deliberately
  silent).
- **The comment mutation-metadata columns** (FN-2 `87ef914`, migration
  0067): project_id/old_project_id/time_id/assignee_team_id/
  comment_meta_data ported with every writer seam threaded and the
  timeline readers de-hardcoded — the type-30/31 payloads move from
  content JSON into columns (today's JSON leaks into the timeline API
  body), time_id stamps the batch-mate row, the column-move metadata
  gains project_title (ours omitted it); two conservative backfills; the
  original_author pair stays intentional-recorded-absent (FN-9 `1a53a7c`:
  its only writer is the forge-metadata importer our surface refuses by
  contract — the four-leg ground; the issues twin RESERVED).
- **The repositories port columns** (FN-4 `5afe965`, migration 0068 — the
  audit's biggest single-table residual): 18 columns + one index, every
  writer leg by surface owner — description/website move OUT of
  repo_settings into the row (every reader flipped), the four counters
  (actions runs pair at the refreshRunStatus chokepoint; projects pair at
  create/close/reopen/delete), the size split (git_size + lfs_size,
  size_kb widened to their sum), archived_unix both ways, topics
  maintained in-batch ASC-sorted with lists rendering the column (the
  topics half of the list divergence CLOSED), trust_model from the form,
  template_id TEXT per the id-family rule. GU `5ab15b9` landed the RECORD
  half first (SPEC-0001 §4.1's as-built table + the fold records —
  applying GR's addendum with four cite corrections and DISPROVING one of
  its errata before it could mislead FN-4).
- **The freeze consolidation itself** (`b36aa65`): the ledger's §7.5 —
  114 rows = 112 LANDED + 2 open, 0 in-flight — with FY3's freeze-ready
  verdict (its review re-verified every landing's stats and re-grepped
  the audit's final tallies 46/26/23/22) and FY3's one precision fold
  (GS's renamed_branch claim: the TYPED shape 404s, only the LEGACY arm
  serves wrong content — corrected in the audit and the staged port plan).

## 2. The discipline record

- **The P1 loop worked as designed**: FY's adversarial review of the NEW
  federation surface found the signer-binding hole (a validly-signed remote
  actor could forge attribution); the orchestrator verified it at the pin;
  FT closed it (`9e4fc2a`) with a 6-test cross-signer battery; and the hole's
  enabling false claim — "the pair key bounds a stranger's Undo to a no-op"
  (it bounds the INBOX OWNER, never the sender) — was corrected everywhere it
was written (code comment, SPEC §5 restated with the old claim marked
WRONG, the test comment re-phrased). Found by review, fixed, and the
review's LOW findings tracked to disposition.
- **The second review loop (FY2) closed the same way**: the ready-for-freeze
  verdict came back with two MEDIUMs, both found-then-routed rather than
  sat on — the cron case-sensitivity bug → GE, whose landing (`b17885e`)
  fixed it (parseIntOrName lowercases before the table probe — MON/Jan/SUN
  register where they silently registered nothing), and the FN-5
  false-drifts → GI, whose landing (`4e3eddd`) re-verified both at the pin
  and WITHDREW them with a method rule (executing the old FN-5 would have
  broken parity); GI's landing also disclosed a concurrent-edit window —
  FN-3's annotations landed in the audit doc mid-unit and were re-read and
  folded around, sibling hunks untouched (GJ's landing disclosed the same
  discipline under fire: three lost read-edit races spliced via an
  abort-on-change-guarded atomic write; the GI landing swept GJ's
  committed block under its window — post-verified verbatim intact — and
  the wave-end consolidation `704cd7b` bundled four complete families
  through GS/GR/GL/GM's overlapping windows with the same abort-on-change
  guards firing and retrying clean, after GM's predecessor died
  quota-dead with no progress file — §7.10 was rebuilt fresh on GI's
  withdrawal record). FY2's LOW batch is dispositioned at GE's landing
  (§4).
- **GK's migration smoke proved the chain deployable before the freeze**: a
  from-zero apply (fresh state, 0062 → 0065) went GREEN; a re-apply proved
  the chain IDEMPOTENT; the remote pending list showed 0065 listed-pending
  until applied (the deploy-order gate is real, not nominal); and the smoke
  caught a real defect — FN-3's migration snapshot was committed as
  `meta/0065_review-state-updated-files.json` against drizzle's
  `NNNN_snapshot.json` convention (0061–0064 all carry `_snapshot`; the
  journal's own tag is unaffected — it names the SQL file). RESOLVED in
  the wave's tail: the rename landed in two halves (`65fda19` carried the
  new path — with the id/prevId chain verified before generating; the
  staged delete followed as `8a91597`).
- **Disclosed attribution corrections and folds** (the first two are
  hunk-attribution corrections, all four disclosed in-commit):
  (1) `336030d` (FQ) corrects the record on `5854a88` (FO's landing): the
  bulk of `ui/index.ts`'s route rewrite rode FO's landing as a pathspec
  sweep over the shared file while FQ was mid-flight — those ~490 index.ts
  lines are FQ's work, disclosed at the time, the attribution formally
  carried in FQ's landing message.
  (2) `4d79e56` corrects FT's landing message over-claim ("Also lands FY's
  two stale person.go cite corrections"): FT did not carry them. The
  correction verified both revisions — at `1592576fa5^` Person spans :21-86
  and PersonInbox :89-106 (the 204 black hole at :105); at the pin
  `fc493688` person.go is a 14-line NotImplemented stub (:12-14). The old
  ranges (:20-79 / :81-96) matched no reachable revision — pre-reduction
  layout drift.
  (3) `01fff06` (GH) carries a disclosed orchestrator fold: the stale
  pair-carrying printNextSteps invocation at setup-monitor-auth.mjs:558
  (reported outside GH's ownership; the file was free).
  (4) `c3e4f14` is itself a disclosed orchestrator fold with FY2 credit
  (the 0600 pre-chmod fix, FY2's LOW nit on FV's store write).
  (5) `428e3e7` is a disclosed orchestrator pathspec miss made good: the
  two route-level packages test files GC's landing missed, landed after,
  GC credit.
- **Compaction loss → re-derivation, not reconstruction from memory**: FN's
  table-audit chat report was lost to a session compaction; FW re-derived
  the whole census from the two sources of truth (117 RegisterModel calls;
  our 107 sqliteTable definitions) into
  `docs/research/table-alignment-audit.md` (750 lines, 222 both-side cites,
  the method reproducible in-doc) — and explicitly SUPERSEDED the remembered
  ~115/60/4 numbers, which had undercounted missing tables by ignoring
  non-reader tables. Only FN-1's row was carried from the lost report, and
  it was re-verified against the same sources first.
- **The migrations-serialization rule**: schema-touching units serialize on
  the migrations journal (one at a time). The wave's own demonstration:
  FS staged its 0063 via hunk-split construction around FM's in-flight
  schema.ts tables (the two FM hunks excluded, the worktree restored intact
  for FM; the journal's 62-gap recorded cosmetic), FM's regeneration
  re-verified FS's 0063 byte-identical — and FN-6's landing handled the
  same discipline's sharpest case: a coordinator interrupt mid-unit
  (renaming 0065's snapshot BEFORE generating 0066, so the next generate
  would not have diffed against 0064), plus a self-caught drizzle
  rebuild defect the fresh-D1 test suites structurally could not see
  (caught by the local-apply gate on real carried rows — §1's FN-6
  bullet).
- **Gate-line arithmetic**: FY flagged that `049c09a`'s committed gate line
  ("41/41 + 91/91 across the seven files") mis-states the arithmetic; the
  corrected reading: FP's own scope was 41/41 (user-profile.matrix) + 35
  across the other four files = 76 total — the committed "91/91" was FO's
  suite count bleeding into FP's message (adjacent landings, minutes apart);
  all suites were green, only the arithmetic was wrong. This record carries
  the corrected line.

## 3. Gate, deploy, and probe evidence

- Full-suite composite gate: accepted green-with-adjudication on R3 — 480
  files / 477 pass / ZERO asserts; R1 (465/15) and R2 (470/9) fully
  dispositioned (the two FN-4 regressions + the seed/pin migrations, commits
  `a606ecc` + the round-2 batch); 3 timeouts solo ×2 (webhooks, pull-engine,
  gitlink-dir-diff); the 87621de teardown class (activity-author-data.smoke).
- Build: `pnpm build` clean (vite, 161ms); the drizzle single-chunk pin verified.
- Deploy: **`9cb84065`** (version `9cb84065-24fa-4f2c-a335-cdc725d35078`),
  the full trigger/queue table mounted; the migration chain 0062→0068 applied
  remote FIRST (`pnpm db:migrate:remote` — all seven ✅, "No migrations to
  apply!" on verify). DEPLOY-ORDER
  NOTE: the migration chain 0062 → 0063 → 0064 → 0065 → 0066 applies
  BEFORE the new worker serves traffic (`pnpm db:migrate:remote` first —
  0064 is data-only and production pull_requests rows carry the swapped
  Mergeable/ManuallyMerged semantics until it applies, per `6337ab0`'s own
  deploy note; the committed chain spans SEVEN migrations, 0062 through
  0068). GK's smoke
  verified the command end-to-end: from-zero GREEN, re-apply idempotent
  (§2). Gate adjudication note (GC's landing, historical): the
  gate/branch-protection-push/tag-protection-push reds in GC's battery
  were FN-6's in-flight 0066 not yet applied to the local dev D1 — FN-6
  has since LANDED (`65fda19`); adjudicate the composite gate against the
  post-0066 state.
  Migration
  tooling note from the same commit: `pnpm db:generate` cannot pass `--`
  through to drizzle-kit (pnpm's brocli swallow) — custom migrations invoke
  `pnpm exec drizzle-kit generate --custom` directly.
- Probes: **the release run: 253 planned, exit 0 (zero FAIL), 6 warns** —
  run
  under FV's NEW taxonomy: the monitor warn class is now four-way
  (missing-auth `[warn]` pre-authorization / permission-denied 401-403 FAIL
  / api-unsupported 405-415-410-451-501 + entitlement-403 `[warn]` /
  everything else FAIL); the blanket warn-skip is retired, warn-never-fails
  preserved, and `--dry-run` still plans 253. Until the operator runs the
  one-time setup (§4), the monitor checks warn missing-auth BY DESIGN.
  CLI contract (`01fff06`): for a monitor-only selection
  `--base-url`/`--token-file` are UNCONDITIONALLY optional (the
  monitor-platform checks never read the pair — the pair-less no-auth
  scenario now exercises the designed missing-auth warn); a supplied token
  file is still validated 0600 + mint-shape and scrubbed. The probe-path
  diff is empty.
  (The oauth2-userinfo baseline was already re-based in v1.5.5 — the probe
  expects the PAT 200 with the OIDC shape, per FJ's M2 as-built.)
- PAT posture: minted via bootstrap-admin (v156probe) → battery runs →
  row deleted by sha256 + token file shredded (the standing discipline).
  EVIDENCE-RERUN DISCLOSURE: the release run's tally was captured through a
  tail pipe (only the audit tail survived), so a full-capture rerun was run
  for the record; its 8 fails are ALL double-run/transient classes,
  each dispositioned — the fw-pr trio healed on targeted rerun; the org-web
  trio is the double-run-non-idempotent class (run 1's add/leave arms
  consumed the shared org fixture's state — the battery cleans sessions but
  not the org; the SAME build served run 1 all-green); wikigit was the
  transient-uplink window (TLS handshake → fetch failed, ×3 attempts — the
  v1.5.3 class) then green; and audit-action-rows was a stale CALIBRATION
  re-baselined 2->3 (the third STANDING p0-shallow fixture's create event —
  the v1.5.1 comment's own predicted mechanism) plus one p0probe-namespace
  orphan repo hand-swept (children-then-row, the battery's DELETE-arm
  network-window miss). The calibration change rides this commit.

## 4. The recorded remainders

- **S-4's operator half** (the row stays open BY DESIGN): the one-time
  `node scripts/setup-monitor-auth.mjs` + the first live-green
  monitor-platform battery. Until then the warn class persists by design —
  never "permanently closed". Wrangler-OAuth intake is UNVERIFIED offline
  (paste-only, recorded as such); Secrets Store documented DECLINED.
- **FV's two PROVISIONAL heuristics** for that first live run to confirm:
  the dry-write 404→write-scope verdict (a dry PUT at a NIL-UUID queue —
  authz-before-existence makes 404 the scope-pass) and the entitlement-403
  regex for api-unsupported.
- **The receiving-side decodeURI note** (GB `a2e992e`): hono's `getPath`
  decodeURI means a name carrying a literal `%` or `?#` mismatches after
  decode REGARDLESS of sender escaping — a platform-level receiving-side
  note for future route-shape work.
- **The query-family equivalence table** (FX `c28498f`): the QueryEscape vs
  encodeURIComponent sites are recorded functionally-equivalent
  (space/plus decode-equal) — FX's cite table rides the freeze inputs and
  stands as the recorded disposition.
- **049c09a's gate-arithmetic correction** (FY-flagged): carried corrected
  in §2 with the orchestrator fill; the commit message's "41/41 + 91/91"
  is not the authority.
- **The FN-2..FN-14 backlog**: durable in
  `docs/research/table-alignment-audit.md`, API-visible first. LANDED this
  wave: FN-1 `6337ab0` · FN-3 `e6a5a70` (0065) · FN-13 `89f946c` (the
  record unit — no DDL; its refused reclassifications QUEUE:
  issue_pins.repo_id → FN-10, issue_subscriptions' created_unix/updated_unix
  → FN-12) · FN-6 `65fda19` (0066 — repo_units id/created_unix/
  everyone_access_mode; the unit-insert stamp follow-up folded same-day
  `8925a3b`) · FN-9 DISPOSITIONED `1a53a7c` (intentional-recorded-absent,
  the original_author family — SPEC-0005 §9 RECORD; the issues twin
  RESERVED; closes rather than parks: the trigger is imported content
  existing, owned by any future SPEC-0009 forge-metadata extension).
  FN-2's derivation LANDED as a plan (GJ `c6bb42f`): the family is SEVEN
  columns (the patch_quoted claim was wrong — upstream's persisted column
  IS `patch`, ours PARITY), and GN's disposition trims FN-2-proper to
  FIVE PORT columns (project_id/old_project_id, time_id,
  assignee_team_id, comment_meta_data), with the write/read matrix and
  the port plan staged as SPEC-0005 §7 PLAN — FN-2-proper is IN FLIGHT at
  the freeze (migration 0067 staged, uncommitted). FN-5 is FINALIZED at
  18 renames (17 columns + 1 table) by GM-resume (`704cd7b`, SPEC-0005
  §8 PLAN-ONLY — the drizzle RENAME-COLUMN shape evidenced; the
  must-edit surface ~26 raw-SQL fixture lines across 6 test files); its
  post-GI truth stands: the two false members (redirect_ur_is,
  hash_m_d5) never existed and are withdrawn, the sweep added
  repo_transfer.new_owner_id→recipient_id and
  review_state.issue_id→pull_id. GR's repositories 26-column disposition
  and GS's §3.3 no-reader findings (renamed_branch LIVE-hard;
  commit_status_summary refuted; app_state ground corrected) ride
  `704cd7b`. The cite-audit pass GI queued (audit §7.8) EXECUTED as §7.9
  (`704cd7b`): 410 cites verified, the Headline machine-re-grepped to the
  FINAL **46/26/23/22 = 117** — any 47/22, 46/23, or 46/23/26/22 figure
  quoted elsewhere is stale. Honest flags carried in the audit: the id
  family is intentional-recorded, not platform-forced; the staged
  slug/owner_namespace folds need records (GR's finding);
  deleted_branches (ours-extra) needs its record folded into the next
  schema-touching SPEC. GS's port plans are staged in /tmp (the audit
  records them as such).
- **FM's two recorded unwired seams are WIRED** (FZ `fd1fa58`): the
  settings-change arm (when the unit update includes the actions unit,
  DeleteScheduleTaskByRepo + DetectAndHandleSchedules fire after the
  settings batch commits — upstream's UpdateRepositoryUnits
  `setting.go:20-64`, the in-tx pair log-and-continue; a DISABLE
  additionally runs CleanRepoScheduleTasks post-tx) and
  CleanRepoScheduleTasks — whose brief premise FZ corrected on the record:
  upstream has NO periodic cleanup; the clean is EVENT-DRIVEN at four
  seams (unit-disable, archive at repo.go:1002/web setting.go:1023, and
  the instance-wide UnitGlobalDisabled notify arm). The directed
  `clean_repo_schedule_tasks` cron (hourly, probe-gated,
  extension-name convention) sweeps only RESIDUE — schedule rows of
  archived or actions-unit-less repos, never enabled repos — covering the
  global-disable seam our surface has no writer for plus a clean that
  threw. §D7's open seams then CLOSED and SHRANK (GE `b17885e`):
  SwitchSchedulesToDefaultBranch is PORTED (premise corrected — it lives
  in services/actions/clear_tasks.go:65-77, not models; wired at the
  API-PATCH/web-form/RENAME arms; the rename arm closes the pre-existing
  default_branch/HEAD gap, disclosed residual: no cross-store tx), and
  the push-path carve-out's event divergence is CLOSED (upstream's own
  two-caller split: the carve-out registers schedule/null via the
  standalone, the fused push twin keeps push/payload; the carve-out moved
  above the unit gate per upstream's notify order; the standalone gained
  upstream's zero-detection early return). What STAYS open in §D7:
  org/user-level unit writers (no counterpart in our surface). GE also
  recorded next-wave: the rename arm fires no DeleteRef/CreateRef
  notifies (upstream branch.go:492-493 — webhook census territory,
  pre-existing).
- **FY2's LOW batch — DISPOSITIONED at GE's landing** (`b17885e`): the
  carve-out unit-gate-order flag (the carve-out moved ABOVE the unit gate;
  the FM port's own comment had claimed no-unit-gate while the code gated
  it), the event hardcode (the two-caller split above), the
  deleteScheduleTaskByRepo comment (now states the real specs-first
  divergence :90-102 instead of false parity), and the header miscite
  (FY2's :75 miscite resolved — no literal cite existed in the landed
  files; every CleanRepoScheduleTasks cite now the verified
  :59-63/models :104-123). The ONE item GE's message does not name: the
  unrecorded unarchive arm — reconcile it against the tree at the freeze.
- **GK's freeze notes — both resolved**: 0065 stayed listed-pending in the
  remote pending list until applied (the deploy-order gate is real, not
  nominal — carried as §3's deploy-order rule); and the snapshot-naming
  deviation LANDED (`65fda19` + `8a91597`) — nothing left to record as
  deliberate.
- **The escaper campaign's tabled no-change verdicts** (GB, then GC's
  census landed `70a1673`): the username/repo-name/numeric-id sibling
  sites are charset-gated or fixed-charset both sides (no-change, tabled);
  the four OAuth2-name sites are runtime no-ops under SPEC §6.3's slug
  gate but byte-parity if it lifts; GB's flagged
  `web/oauth2-login.ts:184` tail is PORTED (GC — the callbackRedirectUri
  at providers.go:225). GC's no-change classes are recorded per-class
  with cites (fixed enums, already-Go-exact ports, the query family KEPT
  decode-equivalent with INFO rows, self-consistent carriers, non-parity
  surfaces); its MOVED PINS are disclosed (archive/issue-attachments test
  assertions that pinned the OLD divergent bytes now carry differential
  twins).
- **Federation**: the delivery lane + any follower READER stay OQ-5-gated
  (FS/S-1's don't-invent posture).
