# cf-gitea v1.5 — Release Notes (the census-and-completion wave)

**Range**: `0d172ac..<FINAL_HEAD — FILLED AT FREEZE>` — **<COMMIT COUNT — FILLED AT
FREEZE>** commits, landed 2026-11-01 through <DATE — FILLED AT FREEZE>.
Deployed as **`<DEPLOY ID — FILLED AT FREEZE>`**; migrations: **0058
`sessions.impersonator_user_id`** (the impersonation chain, `9c929dc`) and
**0059 — the four completion-substrate tables** (deleted_branches,
review_state, pull_auto_merges, two_factor — one migration by design so the
feature units dispatched schema-free in parallel); probe battery
**<N/232 + audit — FILLED AT FREEZE>**.

The wave's shape: **the upstream-parity CENSUS ran and its findings drove the
work, and the completion directive closed the window whole** — the `/api/v1`
surface verified effectively FULL (the one API gap found, compare's slashed
basehead, closed same-window; two flagged divergences reconciled at
`aa8c072`), the ranked 20-gap web list **fully adjudicated — every closed gap
live, and every honest reduction with a buildable substrate went REAL over
migration 0059** (branch restore, viewed-files, merge-when-checks-succeed)
plus the bzip2 encoder lifting conda's third codec wall. The package surface
completed at **23 of 23** protocol families. Three 1308 quota-death waves
were absorbed; every dead unit's work was recovered — whole, completed, or
landed as-found.

## 1. The census and its completion

A read-only census unit enumerated upstream's `/api/v1` route groups and web
families against the tree and returned a ranked 20-gap list with pin cites.
Two standing myths died: the six-minor wave's "FULL 21-protocol parity" claim
(never true — the pin carries 22 CommonRoutes groups + container = 23), and
several "absent" families that had in fact landed (the .well-known trio).
Every correction was annotated in place, history preserved.

**The completion ledger** — every ranked gap adjudicated by freeze:

- **#1 issue writes** — closed WHOLE in two parts: the sidebar's ten write
  arms (`c1391ce` + `7187797`) and the timeline's sixteen write families
  (`a93ba94` + the `41bd994` fold; the L cluster both parts live).
- **#2 merge-box** — the six POST seams (`ad4df5d`, mounted `20f7290`; the
  brief correction: web.go:1667 is not a title edit; the merged box renders
  again).
- **#3 code-comment conversations** — the new_comment fragment, the POST, the
  resolve toggle (`bc89d05` + the `02a6cf5` fold, two upstream-truth
  corrections at landing).
- **#5 packages UI** — the settings page (the pin has NO visibility radio —
  annotated), the guarded version-delete, the terraform lock buttons
  (`178aea1` + `20f7290`).
- **#6 attachments** — the streaming dropzone upload + remove ladder
  (`00f8e49` + `20f7290`), the dangling arm salvaged whole (`8964f37`), the
  dropzone fold-back (`561bf3c`).
- **#7 + #8 milestone/label tails** — the `?state={action}` status combo
  (upstream's quirk verbatim), delete, and the repo+org template-initialize
  pair (`3265258` + `20f7290`).
- **#10 branch feeds** — (b) the per-branch RSS/Atom pair (`70d4220` + the
  `86c1cac` fold); (a) restore adjudicated a reduction at `70d4220` — then
  **LIFTED** (§4).
- **#11 migration status** — salvaged whole from a quota death (`a0f3f40`),
  mounted (`4fed38f`), and the migrating repo HOME joined at `1a6d955`
  (view.go:178-202's census row — the poller page over the landed
  retry/cancel endpoints, nine lines of wiring).
- **#12 compare wildcard** — slashed baseheads reach the API compare route
  (`063db9b`).
- **#13 fork-to-edit** — the editor family's FORK seam: the prompt render,
  branch resolution, WillSubmitToFork overlay, and the `/_fork` POST over the
  landed fork service (`8ffcc24` salvage; the module header's recipe is the
  fold). POST-only registration at upstream's underscore literal
  (web.go:1450) — a GET misses to the plain 404 where chi 405s (the recorded
  house divergence); the gate's non-writer split renders fork.tmpl's prompt
  to a reader without a fork and the fork-targeting editor to a reader with
  one, exactly upstream's reader flow.
- **#14 blocked-users** — the user-scope twin (`20f7290`).
- **#16 well-known tails** — change-password, passkey-endpoints, the static
  fallback (`7538a40`; the census's "absent" premise was itself stale — the
  honest scope finding recorded).
- **#17 admin monitor** — the queue-management tails (the detail page, the
  purge arm via the QUEUE_PURGE_BODIES registry, per-arm reductions recorded;
  `d0fc34f`) + the json-aux and worktime mounts (`65fbda5`, `0cf8fd1`) + the
  PLATFORM arms (`6cc57d8`, §5).
- **#18 admin avatar pair** — the migration-free half (`2a00e28`); the
  impersonate arm's STOP ruling superseded by the sanctioned recipe executed
  whole (`9c929dc`, §4).
- **#19 web JSON twins** — stopwatches + the user JSON aux arms
  (`8ffcc24` + the `65fbda5` fold).
- **#20 org worktime** — the range-grain page (`eb8df05` + `0cf8fd1`).
- The remaining rows adjudicated as recorded reductions (§4) or superseded by
  earlier landings — each with its reopen trigger where one exists. The
  census's recommendation #3 (the never-dispatched misc trio) landed too:
  /-/web-theme, the banner dismiss, /-/markup (`6d74118` + the `a6f46f6`
  dispatcher carve). The admin user EDIT page (be89414 + the `07c969b` fold)
  closed the admin users group's last piece.

## 2. The package surface completes — 23/23 (SPEC-0016)

- **terraform** (`b6c6cb8`): the GitLab-compatible state backend —
  serial-versioned tfstate, the 423 lock JSON in Go struct field order, the
  pre-body `?ID=` gate, latest-serial delete 403, empty-body 404s; the DELETE
  guards + pin-helper seam extraction closed at `c40099a`.
- **conda** (`ce9facc`): the 22nd CommonRoutes group. `.tar.bz2` uploads ride
  the landed bzip2 decoder; `.conda` (zstd) stays the recorded reduction
  (wall 2) — and wall 3 was **LIFTED** post-landing (§4).
- **chef X-Ops auth** (`b6c6cb8`): the four-version signature family over
  RSA (1.0/1.1 raw-RSA via BigInt — WebCrypto has no raw RSA), the
  `chef.public_pem` keypair store, `pathClean` byte-exact.
- **composer `.tar.bz2`** (`f758d5b`): the recorded reduction LIFTED by a
  493-line zero-dependency bzip2 decoder ported from Go's compress/bzip2
  (randomized blocks rejected exactly like Go's stdlib; cross-checked 29/29
  against system bzip2).
- **zip CRC32** (`963b9b4`): every zip-reading family now verifies member
  CRCs at data EOF exactly like Go's archive/zip — SPEC-0016's last open
  item closed.

## 3. The web write-arm wave (the folds)

The window's dominant pattern: units build self-contained write modules with
in-header mount recipes; the orchestrator folds them into `ui/index.ts` in
its own window (the b91dd1c handoff pattern, now executed over a dozen
times). Beyond the census ledger's folds (§1):

- **the misc trio fold** (`a6f46f6`): the /-/ dash-prefix dispatcher carve
  (the isWellKnown twin — without it /-/* fell to the repo gate) + the three
  family mounts.
- **the branch-feed fold** (`86c1cac`) and **the restore fold** (`cee4da2`):
  the POST-only registration, the flash wiring, the engine round-trip pin
  flipped live (the D1 row's sha through the POST → the ref BACK at that
  sha).
- **the automerge fold** (`79a94f9`): the viewed-files claim, the files-page
  viewer dispatch, and the hourly cron entry's auto-merge due-scan producer
  (the row IS the claim; the census arm gained `auto_merge_due_scan`) — with
  the API cancel flip following (`ae07531`).
- **the five-recipe fold** (`0cf8fd1`): monitor queue-management, the avatar
  seams, the worktime/detail pages.
- **the admin-edit fold** (`07c969b`) and **the migration-status fold**
  (`4fed38f`): the /-/ pseudo-segment claim's first exercise.
- **the attachments fold-back** (`561bf3c`): the comment form renders the
  dropzone (view_content.tmpl:155-159's placement); the viewed-files
  stays-engine-owned pin flipped to the live claimed arm.

## 4. The reductions go REAL — migration 0059's four tables

The completion directive: every honest reduction with a buildable substrate
becomes REAL. One migration carries all four tables (`5d88a87`); each landed
with its consumer chain:

- **deleted_branches → branch restore** (`2242ed9` + the `cee4da2` fold):
  the 70d4220 reduction's 3-step reopen trigger executed whole — the delete
  arm writes the row pre-CAS (tip sha off the same listRefs snapshot the CAS
  base reads; the (repo,name) upsert so re-delete overwrites), the list
  renders the deleted rows (upstream's push-sync un-flag observable), and
  restore replays PushManaged as commitApiChange(ZERO_OID → stored sha) with
  the outcome ladder — the protected-refusal arm refuses EARLIER than
  upstream, closing the protection-defeating path; the CREATE-event webhook
  fans out. The REAL delete→restore engine round-trip is pinned (row sha =
  pushed tip → restore → ref back AT that sha).
- **review_state → viewed-files** (`58f9890` + the `79a94f9` fold): one row
  per (user, pull) at the head sha the marks were made at; the write seam
  accepts BOTH the bundle's JSON and the no-JS urlencoded form (any-true
  marks at sha, all-false clears); the files page renders the summary +
  per-file labels; the 41bd994-era review_state STOP retired.
- **pull_auto_merges → merge-when-checks-succeed** (`58f9890` + `79a94f9` +
  `ae07531`): the MWCS arm replaces the merge-box refusal (schedules on
  Mergeable-or-Empty per check.go:172, ignores protections — the Auto type's
  one relaxation), the cancel arm is real (the scheduler cancels freely;
  anyone else needs the merge-right check), and the cron CONSUMER is
  upstream's handlePullRequestAutoMerge ladder arm-for-arm (RED → row STAYS,
  the stored quick-check, protections with approvals-hold-at-green, webhook +
  feed re-issued); the API DELETE stub's "this backend NEVER schedules one"
  doc retired by the full upstream ladder.
- **two_factor → TOTP enrollment substrate** (secret + scratch pair + the
  replay-guard period; WebAuthn lands its own shape with its own unit): the
  consumer wave was in flight at this document's pass — the settings-security
  enrollment arm rides it <UPDATED AT FREEZE if landed>.

## 5. The bzip2 encoder and the monitor platform arms

- **the bzip2 ENCODER** (`64b79fd` + the `63e4aef` tail): conda wall 3
  LIFTED — `repodata.json.bz2` serves for real. No Go-stdlib reference
  exists (Go ships no writer; upstream rides klauspost), so correctness is
  the ROUND-TRIP CONTRACT: doubled-string prefix-doubling-SA BWT + RLE1 +
  MTF/RUNA-RUNB + grouped length-limited Huffman, a 24-arm + 200-case fuzz
  battery passing through BOTH the landed decoder AND system bzip2 1.0.8 -d
  byte-for-byte. The algorithm record is the keeper: the tempting
  sentinel-Sort construction is NOT rotation order — the unit's first build
  failed exactly there. SPEC-0016's wall 3 reopen trigger exercised; wall 2
  (zstd) stays the recorded reduction.
- **the monitor PLATFORM arms** (`6cc57d8`, salvaged whole + completed; the
  unit died mid-edit one iteration ahead of its test file): the Cloudflare
  API seam with LIVE-VERIFIED shapes (PUT not PATCH per the official update
  endpoint; read-modify-write preserving batch_size/max_retries/DLQ), the
  queue-concurrency /set closed loop with audit rows, the pprof profile
  trigger — **SPEC-0021 written by the orchestrator** (the unit died before
  it): the frozen design, the verified shapes, and the TWO-STAGE
  VERIFICATION rule (in-window tests, then the deploy-probe battery at
  convergence per its §7).

## 6. Mentions and read-tracking

- **mark-read pair** (`4fc19c2`): both upstream write surfaces of
  SetIssueReadBy — the view seam (both families, one call) and the merge arm
  (the placement divergence pinned).
- **assignees read unifies** (`92ed5bf`): listRepoAssignees delegates to the
  full port; the org-owner row disappears, unit-gated team members appear.

## 7. The standing surfaces brought live

- **oauth2Enabled end-to-end** (`1378636` + `391aa05`): the inert navbar
  gates went real — 23 page modules, ~66 route sites, `OAUTH2_ENABLED=false`
  now collapses every org/admin navbar arm-first.
- **admin-auths mounted** (`e5798b8`): the 77dfccb salvage's module was
  unreachable dead code behind its navbar links — five arms live now.
- **the impersonation chain** (`9c929dc`): 2a00e28's sanctioned recipe
  executed whole — migration 0058's `sessions.impersonator_user_id` (null-
  able), the admin impersonate + admin-return session arms, the display-only
  banner (authority stays the target's, verbatim upstream).
- **compare wildcard** (`063db9b`): census #12 — slashed baseheads
  (`feature/x...main`) reach the API compare route.
- **chef regenerate_keypair web arm** (`8a084d0`): the private key streams
  once (the secret-once posture); the upstream template ships NO confirm
  dialog — pinned.
- **the admin avatar pair** (`2a00e28` + `9c929dc`): census #18 closed by
  the impersonation chain above.

## 8. The three quota-death waves — the salvage record

Three 1308 quota-death waves hit the window; the salvage discipline recovered
every one:

1. **The first death**: the migration-status unit — salvaged WHOLE
   (`a0f3f40`, the files complete as-found), mounted at `4fed38f`, then
   extended by the migrating repo home (`1a6d955`).
2. **The second death** killed two units. The fork-to-edit + web-JSON-twins
   unit died with four half-built files — a dedicated salvage unit completed
   them whole (`8ffcc24`: the module was already complete, the fixes were two
   tsc errors and test-side re-points; the dead unit's file-editor/
   repo-editor-tails overlay edits validated complete against the pin). The
   monitor platform unit died MID-EDIT one iteration ahead of its test file —
   the orchestrator completed it and wrote the SPEC-0021 it died before
   (`6cc57d8`).
3. **The third death**: the attachments dangling-arm unit — found COMPLETE
   and green on the tree, landed as-found (`8964f37`: the unlinked
   (issueId=0) attachment row serves to its UPLOADER ONLY per upstream's
   TypeInvalid arm — the just-uploaded dropzone preview works; strangers and
   anonymous get the indistinguishable 404), with the dropzone fold-back
   riding the same day (`561bf3c`).

## 9. Probes and process

- The **packages-terraform battery** (`6f9d637`): 13 chained probes
  (219→232, 18→19 batteries) — including the honest finding that upstream
  has NO lock-info GET endpoint.
- **The truth-sweep** (`f2f2e34` + `882551e`): the false parity claims
  annotated in three v1.3.3 spots and v1.4's; the wave-49 stale pin healed.
- **The federation/compare reconciliation** (`aa8c072`): both flagged
  divergences reconciled, all five method arms ported per the
  Upstream-Parity Decision Rule; the OPTIONS item's SPEC supersession
  recorded (`7e53196`).

**Process records for the next wave**:

- **The guard-pipe override, twice** (`50d18b3`, the empty record commit):
  the 64b79fd landing's guard FAIL was overridden by the operator's own
  `guard | tail && commit` chain — the pipe swallowed the FAIL exit exactly
  as the standing rule records. The commit itself was proven sound three
  ways in-window (the stash roundtrip, the separated re-run, the batteries).
  The lesson is now explicit: **the pipe-masking rule applies to the GUARD
  command itself** — guard output goes to a file or the terminal, NEVER
  through a pipe in the same `&&` chain as the commit. The separated-guard
  discipline held on every subsequent landing (`63e4aef`'s GUARD_EXIT=0
  record is the pattern).
- **The comment footgun** (`86c1cac`'s fold lessons): a doc comment carrying
  `{branch}/*/{rss` CLOSED its own block comment early — the `*/` inside a
  doc comment is a live footgun. Reworded at the fold; every fold window
  since checks its comments for accidental terminators.
- **The full-disk incident**: the guard's first run failed on a 100% disk —
  40G of regenerable tool caches cleared mid-guard (`86c1cac`).
- **The guard's own catches held**: an unstaged-new-file TS2307, a
  folded-but-uncommitted module (the blocked module folded before its files
  landed), and two cast mistakes across the window — the discipline held.
