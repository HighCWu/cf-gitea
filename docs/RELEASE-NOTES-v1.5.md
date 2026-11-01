# cf-gitea v1.5 — Release Notes (the census-and-completion wave)

**Range**: `0d172ac..0219256` — **77 commits**, landed 2026-11-01 — a
single-day window. Deployed as **`5e47f009`** — FIRST-TRY GREEN (the drizzle
single-chunk pin carried through the 9.1 MB bundle; all three migrations
applied remote BEFORE the deploy); migrations: **0058
`sessions.impersonator_user_id`** (the impersonation chain, `9c929dc`),
**0059 — the four completion-substrate tables** (deleted_branches,
review_state, pull_auto_merges, two_factor — one migration by design so the
feature units dispatched schema-free in parallel), and **0060
`webauthn_credentials`** (the WebAuthn grant, `b8ff967`); probe battery
**226/226 green after the audit adjustments at `0219256`** (6 `[warn]`
skips: the monitor-platform battery's token-unconfigured class + the
go/cargo toolchain-off class; the three first-run fails were all
expectation drift, adjudicated — the census-#7 label count, the
self-seeding fixture's action row, the enumerated standing-token set; the
monitor-platform live closed loop rides the deploy probe per SPEC-0021's
two-stage rule).

The wave's shape: **the upstream-parity CENSUS ran and its findings drove the
work, and the completion directive closed the window whole** — the `/api/v1`
surface verified effectively FULL (the one API gap found, compare's slashed
basehead, closed same-window; two flagged divergences reconciled at
`aa8c072`), the ranked 20-gap web list **fully adjudicated — every closed gap
live, and every honest reduction with a buildable substrate went REAL over
migration 0059** (branch restore, viewed-files, merge-when-checks-succeed)
plus the bzip2 encoder lifting conda's third codec wall — the second fell to
the zstd decoder before freeze (§7). The package surface completed at
**23 of 23** protocol families. Three 1308 quota-death waves were absorbed;
every dead unit's work was recovered — whole, completed, or landed as-found.

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
  PLATFORM arms (`6cc57d8`, §6).
- **#18 admin avatar pair** — the migration-free half (`2a00e28`); the
  impersonate arm's STOP ruling superseded by the sanctioned recipe executed
  whole (`9c929dc`, §11).
- **#19 web JSON twins** — stopwatches + the user JSON aux arms
  (`8ffcc24` + the `65fbda5` fold).
- **#20 org worktime** — the range-grain page (`eb8df05` + `0cf8fd1`).
- The remaining rows adjudicated as recorded reductions (§4) or superseded by
  earlier landings — each with its reopen trigger where one exists. The
  census's recommendation #3 (the never-dispatched misc trio) landed too:
  /-/web-theme, the banner dismiss, /-/markup (`6d74118` + the `a6f46f6`
  dispatcher carve). The admin user EDIT page (be89414 + the `07c969b` fold)
  closed the admin users group's last piece — though the fold's arm was
  brace-nested and never reachable until the `1b17b08` repair (§12).

## 2. The package surface completes — 23/23 (SPEC-0016)

- **terraform** (`b6c6cb8`): the GitLab-compatible state backend —
  serial-versioned tfstate, the 423 lock JSON in Go struct field order, the
  pre-body `?ID=` gate, latest-serial delete 403, empty-body 404s; the DELETE
  guards + pin-helper seam extraction closed at `c40099a`.
- **conda** (`ce9facc`): the 22nd CommonRoutes group. `.tar.bz2` uploads ride
  the landed bzip2 decoder; `.conda` (zstd) was the recorded reduction
  (wall 2) — and BOTH walls fell post-landing: wall 3 (§6's encoder) and
  wall 2 (§7's decoder).
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
  replay-guard period; WebAuthn landed its own shape with its own unit and
  its own migration): the consumer wave RESOLVED — the full TOTP chain, the
  WebAuthn grant, and the settings-security arms are §5.

## 5. The auth trio completes — two-factor end-to-end

The `two_factor` substrate's consumer wave landed whole, joined by the
WebAuthn grant and the last settings-security arm — the trio the security
page now renders:

- **TOTP** (`228b16e`, the core + the gate pages): pquerna/otp v1.5.0 math
  verbatim — HMAC-SHA1, the dynamic truncation, base32 leniency, the ±1
  window probing [T, T+1, T-1] and returning the MATCHED period — plus the
  EXACT scratch crypto (HashToken's PBKDF2-SHA256 10000it/50B hex, the
  ambiguity-free base32, the CryptoRandomString(10) salt): RFC-6238's six
  SHA1 fixed vectors BYTE-EXACT, RFC-4226's table, an independently computed
  PBKDF2 pin. The seam (`auth/two-factor.ts`): verify-once activation with
  the scratch pair shown once, `validateAndConsumeTotp` behind the
  CONDITIONAL-UPDATE replay guard (upstream's TOCTOU closure — period-based,
  strictly stronger than upstream's string compare), scratch verify/burn,
  disable, the pquerna-exact otpauth URI, and the pending-state ticket codec
  (HMAC-SHA256 over the shared keystore secret — the keys.ts precedent). The
  gate pair (twofa.tmpl + twofa_scratch.tmpl in the user-signin shell) and
  the enroll page over the settings layout. The landing was SPLIT by the
  predicted coordination clause — the session.ts and settings-page files
  rode the WebAuthn sibling's reconciliation.
- **the settings-four mount** (`1b17b08`): handlesUiRoute is the ADMISSION
  gate — three new parse families + union members were required, or the
  routes were born dead; the route battery carries a real TOTP code
  end-to-end (enroll → scratch notice → row, regenerate, disable
  wrong/valid).
- **WebAuthn** (`b8ff967`): migration **0060 `webauthn_credentials`** (the
  sanctioned grant — upstream's exact columns from webauthn.go:45-58 plus
  transports; the (user_id,lower_name) unique and the credential_id unique
  for ByCredID). The challenge state is the documented equivalent of
  go-webauthn's server-side SessionData — our D1 sessions require a
  signed-in user but the assertion is pre-auth — so HMAC-SIGNED COOKIES over
  the shared keystore secret, a TWO-NAME split proven load-bearing in live
  testing (gitea_webauthn pending/reg vs gitea_webauthn_challenge
  assert/passkey — upstream's separate twofaUid/webauthnAssertion keys; the
  one-name first draft CLOBBERED the pending identity at challenge issue),
  single-use cleared on consumption, and the sign-count CAS making replay
  rejection DURABLE for counter credentials (zero-counter keys keep
  go-webauthn's own no-signal posture; clone_warning MAINTAINED as the
  durable record). The stack is zero-dependency: CBOR, COSE ES256/RS256
  verify with the Go-varint userHandle, both ceremony ladders over fixed
  synthetic vectors (no real authenticator in CI); web.go:658-675's five
  login arms + the settings quartet + 405 twins; the
  .user.signin.webauthn-prompt DOM wire contract and the live security-page
  section. Attestation accepts none+packed-SELF only (Gitea never verifies
  chains); algs fail-closed at enroll (an unverifiable stored key = a
  lockout); RP derived per-request.
- **the session composition + the consolidated auth fold** (`b8ff967` +
  `1b17b08`): session.ts composes WebAuthn 4.5a then TOTP 4.5b — upstream
  handleTwoFactorRequired's exact branch. The fold's probe RESHAPED the
  recipe: the oauth2LoginRouter-beside placement does NOT work (uiRouter's
  dynamic repo-page pair outranks statics in later mounts per the 9d77172
  RegExpRouter rule — two-segment GETs 404'd in-shell), so BOTH
  webauthnRouter and sessionRouter moved into the pre-uiRouter block, with
  the three isUserAuthPath carve arms (webauthn + the settings quartet
  prefix + two_factor — probe-confirmed the two_factor arm required, the
  sessionRouter owns the family).
- **the account_link dead-route arm** (`1268884`): the W5 unlink arm —
  POST /user/settings/security/account_link, the `1b17b08` referral and the
  final ce76247-class find of the completion wave. Deadness was probe-PROVEN
  before the fix (handlesUiRoute false + parse null + the registered
  handler's own prologue answering the null-parse 404 — registration/parser
  drift); the Remove button's target was always correct (:592) — the 404 was
  purely dispatcher admission. The battery: the live round-trip over a
  seeded external_login_user row (POST the Remove form's exact body → 303 +
  row gone; the stale-id re-POST → the 200 'was not found' re-render, no
  500), the anonymous 303, cross-origin 403, the GET 405 twin.

## 6. The bzip2 encoder and the monitor platform arms

- **the bzip2 ENCODER** (`64b79fd` + the `63e4aef` tail): conda wall 3
  LIFTED — `repodata.json.bz2` serves for real. No Go-stdlib reference
  exists (Go ships no writer; upstream rides klauspost), so correctness is
  the ROUND-TRIP CONTRACT: doubled-string prefix-doubling-SA BWT + RLE1 +
  MTF/RUNA-RUNB + grouped length-limited Huffman, a 24-arm + 200-case fuzz
  battery passing through BOTH the landed decoder AND system bzip2 1.0.8 -d
  byte-for-byte. The algorithm record is the keeper: the tempting
  sentinel-Sort construction is NOT rotation order — the unit's first build
  failed exactly there. SPEC-0016's wall 3 reopen trigger exercised; wall 2
  (zstd) followed at `7b9aead` (§7).
- **the monitor PLATFORM arms** (`6cc57d8`, salvaged whole + completed; the
  unit died mid-edit one iteration ahead of its test file): the Cloudflare
  API seam with LIVE-VERIFIED shapes (PUT not PATCH per the official update
  endpoint; read-modify-write preserving batch_size/max_retries/DLQ), the
  queue-concurrency /set closed loop with audit rows, the pprof profile
  trigger — **SPEC-0021 written by the orchestrator** (the unit died before
  it): the frozen design, the verified shapes, and the TWO-STAGE
  VERIFICATION rule (in-window tests, then the deploy-probe battery at
  convergence per its §7). The arms went LIVE at the `cd6ea38` fold (§12);
  the battery's in-window half landed at `f1130e2` (§14).

## 7. The last codec — the zstd decoder, and conda's walls all fall

- **the zstd DECODER** (`7b9aead`): conda wall 2 REVERSED and ADOPTED — the
  completion directive's largest codec: a 1364-line decode-only
  whole-buffer port of the Zstandard spec (the v0.4.3 doc + facebook/zstd
  v1.5.7's C sources as the bit-level reference): frame headers,
  Raw/RLE/Compressed blocks, the literal sections (X1 Huffman, 1-or-4
  interleaved BACKWARD streams behind the 6-byte jump table), the FSE
  tables (the C's byte-ceil description length, step-spread build,
  predefined/RLE/FSE/repeat modes), sequences in the reference's exact bit
  order with the full repeat-offset rotation (the ll0 shift, the repeat1-1
  arm), byte-by-byte OVERLAP copies, and XXH-64 in-module (the published
  vectors + the CLI's stored checksums). Dictionaries and legacy frames
  REJECTED (the bz2 randomized-block stance); skippable pass-through,
  concatenated frames, windowLog ≤ 27, output ≤ 1 GiB. THE CROSS-CHECK:
  system zstd v1.5.7 — an authoring harness of 77 arms, 77-passed
  byte-for-byte (levels 1/3/9/19/ultra-22 × 12 shapes: incompressible 70k,
  300k RLE, period-3 overlap, the 128K block cap, --rsyncable, --long=27) —
  and the harness is WHY four decoder bugs (backward-reader byte order, a
  mul-limb carry past 2^32, the weight-stream size, Huffman peek-vs-consume)
  never reached a commit. The conda arm: a family-local EOCD/zip walk
  (stored+deflate, CRC32-gated — the nuget reader NOT reused, its errors
  are nuget-typed), parseCondaPackageConda over the first info-*.tar.zst
  member, real round-trip .conda uploads authored with python
  tarfile+zstandard+zipfile.
- **the zstd tail** (`799b27e`): the wall-2 staleness swept — the route arm
  FLIPPED to the now-correct 500 (bzip2 bytes under a .conda name are a
  CORRUPT ZIP — CondaArchiveError falls through condaUploadError's 400
  classes to the plain 500, upstream's ParsePackageConda zip-failure arm;
  proven by the passing flip's stack), the title retitled to the
  corrupt-zip semantics, four stale comment rewordings.
- **CONDA'S THREE WALLS NOW ALL ADOPTED** — wall 1 (the bzip2 decoder,
  `f758d5b` — §2's composer arm), wall 3 (§6's encoder), wall 2 (this
  decoder) — the package surface fully real end-to-end.

## 8. The cargo index mirror — M7's deferred half goes real

- **the mirror** (`e4d7e49`): SPEC-0016 M7's deferred half, the last cargo
  item — the per-owner `_cargo-index` engine cell mirroring the D1 sparse
  reads. The adjudications: (1) INCREMENTAL per write, never a rebuild
  (upstream's UpdatePackageIndexIfExists rewrites exactly ONE package file,
  index.go:198-208; RebuildIndex is the separate operator port) — with ONE
  deliberate divergence: a last-version death REMOVES the file where
  upstream leaves it stale (the nil-index no-op at :203-205), so the mirror
  matches the sparse face's own 404s and RebuildIndex's output; (2) THE
  HIDING: upstream does NOT hide the repo (a real visible row at the pin) —
  ours is the wiki-sibling rowless cell (no D1 row, invisible to
  listings/index/git-gate by construction; the git-URL face 404s as a
  future wiki-pattern seam; owner renames strand-heal on re-init); (3)
  best-effort hooks where upstream fails-and-rolls-back the publish (logs +
  heals next write — disclosed). Plus the COLLISION GUARD: a user row at
  the address FREEZES all mirror arms (upstream would commit into the
  user's repo). The tree builder does NOT reuse buildFileChangeCommit (its
  level map drops 2+-level creates; index paths are 3 deep); CAS with one
  conflict retry; the exact json.Encoder newline bytes. 16 real-cell tests:
  upload → the exact NDJSON line + cksum == payload sha256; the
  1.0.10-before-1.0.2 string-sort rewrite; yank flips; delete with
  dir-chain collapse + surviving siblings; the collision freeze; rebuild
  purge.
- **the threading** (`cd6ea38`): the write-hooks go LIVE — the publish/yank
  arms thread cargoIndex bindings, the cleanup rider threads the struct
  (PackagesCleanupEnv widened; partial test envs keep the upstream
  repo-absent no-op), and the settings surface wires: the cargo.tmpl-exact
  section renders in both packages settings pages (the prior NOT-RENDERED
  adjudication's reason — no index service — expired at `e4d7e49`), four
  POST handlers + 405 twins; three route arms proving publish→mirror,
  yank→flag, cleanup-rider→rewrite.

## 9. ActivityPub Tier B — porting the pre-stub parent

- **the decisive finding** (`4b6245e`): THE PIN ITSELF IMPLEMENTS NOTHING —
  four 501 stubs; upstream RETRACTED its whole ActivityPub implementation
  (`1592576fa5`, PR #36789, −1083 lines — verified in the submodule: "Mark
  unused&immature activitypub as 'not implemented'"). "Port what the pin
  implements" therefore resolves to the PRE-STUB PARENT the SPEC's §2.5
  preserved as the reference — the research moved before a line was ported.
- **the port**: the Person actor (the user-id variant; the deprecated
  username-form upstream itself marked remove-in-1.20 NOT carried); the
  inbox (verified Follow → the inline Accept, NOTHING PERSISTED — the
  follower store is the remaining tier needing a migration grant; the 204
  black hole for non-Follow); the draft-cavage HTTP-Signature verifier
  (keyId-as-IRI → the outbound actor fetch → SPKI import →
  RSASSA-PKCS1-v1_5/SHA-256; upstream's error/rejected split —
  fetch/doc/PEM failures 500, every Verify-stage failure 403; the three
  fail-closed arms the SPEC committed: Digest-vs-body, Date ±60s,
  rsa-sha256 only); the lazy RSA-3072 keypair store on user_settings_kv
  (the debian upsert+reread race posture). Chi-exact dispatch (bare-405
  pre-tree → registration gate → method 405+Allow → scope gate → handler);
  unregistered activitypub paths native-404; /api/v1/nodeinfo keeps its 501
  (out of scope). The signature module (`services/federation/httpsig.ts`):
  the grammar (quoted params/OWS/escapes), the canonical string incl.
  (created)/(expires), the bounded remote fetch (Accept: ActivityStreams,
  the MaxSize cap, the fetchImpl seam — fetch-per-verification until OQ-4's
  cache resolves), and the deleted client.go signer half as the fixture
  seam. Six divergences recorded in SPEC §6.2.1.

## 10. Mentions and read-tracking

- **mark-read pair** (`4fc19c2`): both upstream write surfaces of
  SetIssueReadBy — the view seam (both families, one call) and the merge arm
  (the placement divergence pinned).
- **assignees read unifies** (`92ed5bf`): listRepoAssignees delegates to the
  full port; the org-owner row disappears, unit-gated team members appear.

## 11. The standing surfaces brought live

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

## 12. The final sweeps — the wave closes whole

- **the straggler clears** (`cd6ea38`): audit items 31+32, the last
  unexecuted recipes. (31) the monitor PLATFORM-ARMS FOLD — the recipe's
  /set parse claim was SEGMENT-SWAPPED (its own registration, upstream
  web.go:807's group order, and the handlesUiRoute-before-Hono admission
  gate all put qid at segment 3, the literal at 4 — probe-verified before
  folding upstream-faithful); the three families + five registrations land
  with 17 route-level tests over the mocked-fetch seams (§6's arms finally
  live). (32) the cargo write-hooks live (§8). Two SIBLING DEFECTS found
  probe-proven and referred — both the ce76247 parse-reachability class:
  the landed admin-monitor-queue remove-all claim is segment-swapped (the
  rendered form 404s), and admin-user-edit is brace-nested inside the
  detail arm at ~4307 (the `07c969b` fold's placement bug — never
  reachable).
- **the THREE dead routes found and armed** (the ce76247 class — each
  probe-proven dead, then fixed): the remove-all segment swap and the
  admin-user-edit unnesting (`1b17b08`, with the swapped-shape-stays-null
  pin and the full be89414 gate ladder), and account_link (`1268884`, §5) —
  the final find of the wave. With the third armed, the completion pool
  emptied and the freeze began.
- **the stale-docs sweep** (`88df8a8`): 14 flips across 10 files,
  documentation-only (mechanically verified — every ± diff line is a
  comment line), each flip citing its landing hash and verified against
  index.ts reality BEFORE editing: the three mandated (the file-editor's
  non-writer-404 sentence → the `f9907f9` forkArm split with the
  archived-precedes note kept; the repo-editor-fork's Wiring HANDOFF →
  LANDED mount record; the issue-timeline-writes' three viewed-files STOP
  notes → the `79a94f9` landed record) plus eleven self-found; the
  inspected-and-still-true list stands as the unit's audit record.
- **the consolidated auth fold** (`1b17b08`, §5): the probe-reshaped mount
  placement — both auth routers into the pre-uiRouter block; THREE goldens
  re-baselined, each delta verified a pure insertion attributable to its
  named landing (the merged security page, the dropzone, the census row).

## 13. The three quota-death waves — the salvage record

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

## 14. Probes and process

- The **packages-terraform battery** (`6f9d637`): 13 chained probes
  (219→232, 18→19 batteries) — including the honest finding that upstream
  has NO lock-info GET endpoint.
- **The monitor-platform battery** (`f1130e2`): SPEC-0021 §7's verification
  half implemented EXACTLY — ARM 1 the /set CLOSED LOOP over ONE
  serial-locked consumer (read-save → the modify-PUT preserving every field
  verbatim → triple GET-verify at 500ms, the PUT echo never trusted →
  FINALLY-RESTORE running even when arms are red; RESTORE FAILURE = blocking
  red); ARM 2 the pprof CONTENT probe (bounded duration 1000-5000ms →
  non-empty → the 10MiB content-length+streamed cap → gunzip under a 64MiB
  bomb guard → the minimal protobuf walk, wire tags only — NO parser
  linked). The taxonomy: 401/403 FAIL with the explicit token-mis-scoped
  message; the profile-only no-live-instance 400 → [warn]
  environment-condition; unconfigured → all six [warn]-skips with ZERO
  network (proven against a local sink). The honest class: DIRECT-API
  against api.cloudflare.com with the adapter modules' exact shapes mirrored
  as literals — the admin UI routes rode the then-pending fold of the
  `6cc57d8` arms (landed at `cd6ea38`); the live closed loop is exactly what
  flips SPEC-0021's second stage at the deploy probe. Batteries 19→20,
  probes 232→238.
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
