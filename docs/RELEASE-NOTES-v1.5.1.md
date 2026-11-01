# cf-gitea v1.5.1 — Release Notes (the dead-route-and-salvage wave)

**Range**: RANGE=<pending> (`1c8279b..FINAL_HEAD`) — **COMMIT_COUNT=<pending>**
commits, landed 2026-11-01 — a single-day window (thirty-two at this draft, the
two notes commits excluded; the pending-fill items in §16 may still join). Deployed
as **`DEPLOY_ID=<pending>`** — FINAL_HEAD=<pending>. Probe battery
**PROBE_COUNTS=<pending>** — the first battery alignment (`d3f8211`) planned
**244** probes (238 → 244, six new) and the second (`ebf21a2`) plans **253**
(nine more); live counts ride the convergence chain.

The wave's shape: **v1.5's own findings drove the work, and a mid-wave restart
was absorbed without losing a line** — the standing-PAT churn v1.5's audit
observed (`0219256`) got its root-cause fix (`8e5c4ea`), the reviewer's
dead-route list got five dispatcher arms re-derived from `web.go` (`6a91a5c`),
and the merge family's error ladders were re-derived against the pin one arm at
a time (`b5b1994`, `01c7dfb`, `80a1ab7`, `de5efaf`, `40d0a6c`). The wave's
second movement closed the standing reviews: the ⑩ authorization review gated
nine write arms (`c3ac813`), the ⑨ admin/org review landed nine API findings,
the settings danger zone, and the org-membership web arms (`7b4ccfc`,
`6b7b517`, `9b45d68`), and the repo, label and
notification surfaces were re-derived against their pins (`02f0f1b`,
`e6b980e`, `c273341`, `14ba724`, `9d72592`, `8b46159`). The wave's third
movement absorbed a SECOND quota-death: the actions and avatar/attachment
batches landed directly (`86b5aee`, `d973408`), and after the death the
V-wave of salvages finished the dead U-units' carried work (`7f2ecd3`,
`6f1008b`, `ebf21a2`, `8994488`, `326904e`), the index.ts bundle landed
(`7d91ccd`), and U21 closed the attributed findings and U14's residual last
(`16ca6c9`). Every fix was re-derived
from the upstream pin BEFORE editing; every unit's suites were re-verified solo
by the orchestrator before commit.

## 1. The wave's story — the mid-wave restart and the salvage protocol

A restart killed the first pool's in-flight units mid-edit. The **salvage
protocol** recovered every one: the dead siblings' carried work was attributed
hunk-by-hunk — **1171 lines verified as carried across the restart boundary**
before any rebuild — and the replacement units FINISHED rather than rewrote.
Six of the landings are labeled salvages (S1, S2, S3, S4, S5, S6); the
protocol's discriminating case is S5 (`0bd7798`): the dead sibling's AES-256-GCM
ticket conversion was verified COMPLETE hunk-by-hunk and kept as-is — the
salvage's own work was the test side only. The tree's transient 4-error tsc
baseline was attributed hunk-by-hunk to S2's in-flight files (`pulls.ts` ×3 +
`pull-merge-box` ×1, recorded at the S1 landing) and cleared to tree-zero by the
S7 landing (`2deece6`) — the baseline never masked an error. Pool discipline
held at the target concurrency of 6 throughout. Dispatch chains closed their own
known-reds in-window: S1 → S7 (the emitter rename) → S9 (the test residue);
S2's known-red rode S13 (`de5efaf`).

**The second movement — the second quota-death and the V-wave salvage.** A
second quota-death killed the wave's back half mid-edit, and the salvage
protocol ran again, this time as a dedicated wave. The landed salvages kept
the dead siblings' carried work essentially WHOLE: V2's landing was "every
hunk was the dead unit's complete landing, verified + one typo repair"
(`7f2ecd3`), V3's "the dead unit's hunks complete, one wrong cite repaired"
(`6f1008b`), V6's "the dead unit's hunks kept + one REPAIR" (`ebf21a2`), and
V5 completed the dead unit's tests over the three code files it had already
reached (`8994488`). V4 is the discriminating case of the second salvage:
it re-verified the dead unit's byte claims against REAL git and found THREE
real defects the dead unit's own verification had missed, fixing them
in-landing (`326904e` — including D10's false-verification honor note, §13).
The salvage mapping: U16 → V2, U17 → V3, U19 → V5, U20 → V6, U18 → V4, U13 →
V1 (the index.ts bundle, `7d91ccd`); U14 and U15 landed directly before the
death (`86b5aee`, `d973408`), and U21 — dispatched with V2's two attributed
findings and U14's ledgered residual — closed all three at the window's edge
(`16ca6c9`). The first restart's disciplines held — the
orchestrator re-verified every salvage's suites solo, and every dead unit's
cross-unit dependency was named in its report so the orchestrator could fold
it into the RIGHT landing (V3's audit goldens; V5's D6-rides-V4, completed
when V4 landed git-models.ts's `toChangedFiles`).

## 2. The five dead dispatcher routes — and the rename's full chain

**S1** (`6a91a5c`) armed five routes, all reviewer-verified
registration/parser drift, each re-derived from upstream `web.go` before
editing:

- **F1 (P1) the package-settings triple-break** — the probe-proven 404 shell:
  the trailing dynamic `:version` registration absorbed
  `/settings/{type}/{name}` as `{type:'settings'}`. Fix: the claim takes
  settings in the TYPE position (`raw[4]`, web.go:1121-1127's sibling group),
  the trailing tail-arm deleted, AND the registration reordered so the settings
  pair LEADS the dynamic patterns (hono answers first registration for
  equal-depth shapes).
- **F2 (P1) upload-file/upload-remove** — the bare length-1 editor tails
  (web.go:1472-1474); the registrations pre-existed, only the dispatcher's
  admission gate was missing; the writer predicate rides the handlers (404
  shell for non-writers), anon 404.
- **F3 (P1) unpin verb-first** — `/{family}/unpin/{index}` (web.go:1404's group
  root); the index-first length-3 arm deleted as upstream's 404.
- **F4 (P1) time-delete four segments** — `/{index}/times/{timeid}/delete`
  (web.go:1379's Post inside the `/times` group); the truncating length-3 arm
  deleted.
- **F5 (P2) cherrypick → `_cherrypick`** — upstream's OWN underscore spelling
  (web.go:1468 `editor_action`; commit_page.tmpl:65 emits it verbatim via
  RefFormActionTemplate); claim + both registrations renamed; the bare spelling
  stays engine-owned (the recorded divergence).
- **F6 (P2) the enroll-ticket clear** — twofaEnrollSubmit's enrolled arm now
  clears the enroll cookie: the sealed ticket still CARRIES the TOTP secret, so
  the activated state must not leave it browser-live (the twofaSubmit twin's
  arm; upstream keeps the pre-enrollment secret server-side).

**The rename's full chain — dispatcher → emitter → tests → docs**: the F5 flip
broke the live emitter on purpose and the chain landed the same window. **S7**
(`2deece6`): `repo-editor-cherrypick.tsx`'s form action now builds the
underscore spelling (whole-file read: no other bare emitters — the redirect
tail, breadcrumb sha link and both cancel hrefs are cherrypick-free); the fork
grammar's `editorLiteral` follows, because upstream passes the underscore string
verbatim into the fork-target action (services/context/repo.go:258-259 via
editor_cherry_pick.go:15's prepareEditorPage) — a bare emission would build a
404-bound URL; smoke pins flipped plus a new mount-level it (writer GET
`/_cherrypick/{sha}/main` → 200 with the admitted action in the HTML; bare →
404 through handlesUiRoute); repo-wide sweep: no live bare-`/cherrypick/`
emitter remains. **S9** (`16b30bb`): the matrix's forward-prefill pin flipped —
it was pinning the BROKEN bare emitter (S1's 35/35 was true only because the
emitter still emitted bare at commit time); the four intentional bare-literal
pins enumerated and left untouched; the compat docs re-counted
(ui-parity-survey.md's window-2e rows annotated with `6a91a5c`;
stale-pin-sweep.md's cherrypick row re-counted 0 → 4, each pin enumerated with
its assertion form).

## 3. The merge family — every ladder re-derived against the pin

- **MWCS schedule ladder** (`b5b1994`, P1): the 409 stub is gone. POST
  `/pulls/{index}/merge` with `merge_when_checks_succeed` now runs the FULL
  mergeable check first — deps arm INCLUDED (check.go:219-223). The ordering
  correction: the dead sibling's draft ran the deps arm BEFORE the gate,
  letting a deps-blocked PR schedule; upstream runs CheckPullMergeable then
  ScheduleAutoMerge (api pull.go:929→994). Answers **201 bare-body** on
  schedule / **409 verbatim ErrAlreadyScheduledToAutoMerge** on a standing row
  (models/pull/automerge.go:43-45), composing S3's insertScheduledAutoMergeRow
  + the type-34 comment + the best-effort REPO_TASKS enqueue; the arm is
  !manualMark-guarded (Manually overrides the check type and returns at the
  mark BEFORE the schedule branch, api pull.go:923-928).
- **Consumer parity** (`80a1ab7`): the Empty inversion healed — both gates now
  refuse everything except Mergeable (services/automerge/automerge.go:143-145
  !IsStatusMergeable; models/issues/pull.go:446-448 has NO Empty arm; the
  schedule-side Empty exemption is check.go:170-172 — pinned: **an Empty PR
  schedules but never auto-merges**). The sha race reordered:
  ensurePullRequestChecked FIRST, then the status gate reads the CAS-refreshed
  headSha (upstream re-reads the live ref inside the gate — automerge.go:165-182
  + commit_status.go:126-135) — pinned: a post-schedule push re-gates at the
  FRESH head sha. The upstream path itself was corrected from `services/pull/`
  to `gitea/services/automerge/`, cites refreshed across ~20 stale refs.
- **manually-merged, both ladders** (`b5b1994`): the flag has a real config
  home (repo-settings AllowManualMerge, default false). API refusal is
  upstream's ACTUAL answer — 400
  `merge strategy is not allowed or is invalid [repo_id: …, strategy: manually-merged]`
  (ErrInvalidMergeStyle unwraps ErrInvalidArgument, merge.go:231-233 +
  util/error.go:24 — the sibling's 405 was the direct path's arm, corrected);
  missing `merge_commit_id` 400 `commit not found in base repository`
  (merge.go:761-771); armed → the mark proceeds
  with EVERY check arm !manualMark-guarded (Manually skips WIP/state/
  protections/deps — check.go:160-165). Web: the invalid_merge_option flash
  (pull.go:1101-1102) then the manual landing, wrong_commit_id mapping
  preserved; the page loader gates styles on the PR-unit allowlist
  (pull_merge_form.go:126-170) with manually-merged appended outside on
  !WIP && !IsChecking && AllowManualMerge (:162-168); empty allowlist → the
  no_merge_desc/helper pair.
- **The core dependency gate** (`01c7dfb`): mergePullRequest refuses unresolved
  dependencies via the shared issueNoDependenciesLeft port (CheckPullMergeable's
  FINAL arm, check.go:218-223; Manually returns BEFORE the gate, so the manual
  mark skips). The status mapping RE-DERIVED against the pin: upstream's merge
  API has NO arm for ErrDependenciesLeft — it falls to APIErrorInternal 500 for
  a user-input condition (pull.go:928-946); the web box flashes
  pr_close_blocked; the issue-close API maps 412. We answer 405 + the locale
  text verbatim — the route's errorForUser-faithful divergence class, both
  layers agree. Cycle disclosure: `./issues` imports this module, both
  directions function-body-only.
- **The ancestor arm** (`de5efaf`): an ancestor head is PullRequestStatusAncestor
  (models/issues/pull.go:106), IsStatusMergeable false, so CheckPullMergeable
  raises ErrNotMergeableState at the `!IsStatusMergeable() && !IsEmpty()` arm
  (check.go:171-173) and the API answers exactly 405 `Please try again later`
  (pull.go:938-939) — NOT ErrHasMerged's `The PR is already merged`. Our
  combined arm split: hasMerged alone keeps the ErrHasMerged body; a dedicated
  Ancestor arm answers the 405 with the !manualMark guard convention, placed
  BEFORE the deps gate (upstream order); pinned with a real-flow seedMainAhead
  setup (main advanced past the feature tip → create 201 → merge 405 verbatim).
- **The state arm hoisted** (`40d0a6c`, S15): routes/pulls.ts gains the hoisted
  STATE arm immediately after the Ancestor arm and BEFORE the deps gate
  (upstream CheckPullMergeable order, check.go:171-173 < :219-223) —
  !manualMark && status not Mergeable/Empty → 405 `Please try again later`, so
  a conflicted PR answers the state text even with open dependencies. The
  `!== Empty` carve-out is load-bearing: the MWCS schedule path schedules Empty
  rows (the direct path's trailing gate rejects them) — zero behavior change
  beyond precedence. Pinned with a real-conflict seed (both sides rewrite
  README.md off the shared root) asserting the deps edge exists and the check
  resolved Conflict; MUTATION-PROVEN (the hoisted arm disabled → exactly the
  pin answers the deps text).
- **The auto-merge row cleanup** (`01c7dfb`): the direct-merge success tail
  deletes a standing scheduled row (merge.go:827-837's DeleteScheduledAutoMerge),
  composed over the table — a reverse import would invert the layer —
  best-effort, idempotent with the consumer's delete.
- **The cancel texts** (`80a1ab7`): the 403 verbatim
  `user has no permission to cancel the scheduled auto merge` (pull.go:1303-1304);
  the missing-PR arm
  corrected to the BARE APIErrorNotFound 404 `not found` (:1279-1282,
  services/context/api.go:137-142) — different from the pulls-route message,
  both 404 arms bare.
- **The web readiness faces** (`b5b1994`): deps — blockedByDependencies renders
  upstream's exact pr_close_blocked string (pull.go:1088-1090) and disables the
  submit (upstream's own box renders no deps item — the sidebar's list is,
  issue_view.go:501-507 — documented as our readiness face); ancestor — the
  sibling verified correct (no_merge_not_ready, preserved under the !manualMark
  guard); prefill — defaultStyle = stored DefaultMergeStyle when allowed else
  first-allowed (pull_merge_form.go:29-46), defaultTitle per SELECTED style via
  composeMergeMessage's own switch.
- **The issue-delete feed cascade** (`80a1ab7`): both DeleteIssueActions arms
  joined to the batch (models/activities/action.go:558-586 via
  services/issue/issue.go:219) — comment-anchored action rows + the create row
  by parameter-bound `LIKE '<index>|%'` (repo_id conjunct; the digit-prefix
  trap pinned: `1|%` must not match `10|…`). The dead sibling's TS2322
  root-caused (an array spread at the tuple's position 0 erases the required
  first element) and repaired as a tuple-typed ternary, upstream arm order kept.
  Consumer trace: no bypass — the merge call flows through pull-engine's core
  gate.

## 4. SECURITY — the clone-count bypass leads

- **THE CLONE-COUNT BYPASS** (`01c7dfb`, found under the brief — the real
  auth-bypass find): the clone-detected write stored the REPLAYED (lower)
  count, rolling the stored counter BACKWARD — a later replay of the original
  higher-count response then passed the monotonic ladder and **MINTED A
  SESSION**: an auth bypass reachable after one clone trigger. Both arms now
  hold the high-water mark and persist only clone_warning (upstream never
  lowers the stored count); the UP-arm 400 → 403 (go-webauthn always verifies
  presence).
- **passkey user-verification enforced server-side** (`01c7dfb`, P1):
  verifyAssertion gains requireUserVerification — passkey true per
  webauthn.go:59's VerificationRequired; 2FA false per webauthn.go:189's
  VerificationPreferred — violation 403 (go-webauthn v0.18.2 ErrVerification).
  Client-requested UV is no longer trusted.
- **THE ⑩ AUTHORIZATION CLASS** (`c3ac813`): nine write arms answered
  non-writers with success or a leaking 404 — now gated. Milestone CRUD and
  repo-label CRUD ride the shared reqRepoWriter gate (canWriteRepository) in
  the landed projects-repo shape, placed after repo resolution and BEFORE id
  resolution — upstream's middleware chain order means a non-writer
  PATCH/DELETE on a missing row answers 403, not 404/204 (the middleware's
  verbatim `user should have a permission to write to a repo`, api.go:392-396;
  the 403s are runtime-only, declared responses unchanged). The issue-label
  add/replace arms answer 403 `write permission is required` verbatim
  (issue_label.go:311, shared by Add/Replace), clear answers the bare 403
  (issue_label.go:292) — issue-404 precedes the gate. The silent-skip class
  healed: a non-writer poster's issue PATCH applies the title but leaves
  milestone and deadline untouched (upstream wraps the deadline parse
  entirely, issue.go:760, and gates the milestone arm at the condition, :789)
  — counters unmoved, no Milestone comment, no webhook; the type-7 comment
  arms these label writes ride (`e6b980e`, §9) compose on all three API
  label routes. One gate deliberately NOT added: upstream's
  mustEnableIssuesOrPulls closes only the /issues subtree — the /labels and
  /milestones groups are siblings outside it and upstream SERVES
  label/milestone APIs on tracker-disabled repos, so wrapping ours would
  diverge (L4, skipped with pin evidence — §16).
- **The AEAD ticket** (`0bd7798`): the restart-dead sibling's AES-256-GCM
  ticket conversion verified COMPLETE hunk-by-hunk (wire-version byte 0x01,
  12B IV, 16B tag, HKDF-SHA256 key derivation, cached CryptoKey, retired-HMAC
  format rejected at the version gate). The salvage's test side: flipped-
  ciphertext-byte tamper arms, and the CONFIDENTIALITY pin — the enroll
  cookie's decoded wire contains the base32 secret neither as readable
  substring nor raw bytes; fresh-IV nondeterminism; round-trip.
- **Session/ticket lifecycle parity** (`0bd7798`, the six fixes): (1)
  dual-enrolled login parks BOTH carriers — the gitea_twofa gate ticket minted
  alongside the webauthn pending carrier (upstream's twofaUid lives in the same
  server session, webauthn.go:40-46 → 2fa.go:36); whichever flow completes
  first clears both. (2) logout clears all pre-auth carriers — gitea_twofa +
  both gitea_webauthn* (auth.go:453-460's whole-session destroy). (3) sign-in
  retires a CROSS-user prior session row at all three mint arms
  (store.go:113-128's regenerate semantics; the same-user row deliberately kept
  alive — documented). (4) the two bare-403 bodies (prohibited account,
  sudo-non-admin) drop the `url` field (api.go:889-893, :135-138 — upstream's
  bodies are message-only maps). (5) impersonation audit rows registered and
  emitted at start (users.go:580 shape) and exit (auth.go:476), catch-and-log
  like upstream's writeEvent. (6) the impersonation EXIT is keyed on
  (id,digest)+impersonator stamp alone (migration 0058) — reachable even for
  prohibited/org targets (services/auth/session.go:31-61 never reads
  ProhibitLogin at load), restoring the admin.
- **The webauthn dual-clear + the limiter verdict** (`452984c`, S10): the
  successful-assertion mint arm appends clearTwofaSetCookie beside its own pair
  — the SPEC-0022 §6 dual-clear contract's webauthn half (upstream's completed
  sign-in regenerates the session whole, auth.go:390-397; the parked twofaUid
  dies with it). THE LIMITER VERDICT: upstream has NO login-failure limiter
  anywhere (grep across routers/ + services/ — its park only regenerates +
  redirects, auth.go:349-368) — so the house rule 'verified password => reset'
  governs, and the webauthn park arm (step-4.5a, both dual-carrier and
  webauthn-only returns) now sinks limiterResetFailOpen like the TOTP arm;
  pinned failureCount 3 → 0 across a parked login.
- **The enroll-ticket clear** (`6a91a5c`, F6 above): the activated 2FA state no
  longer leaves the secret-carrying ticket cookie browser-live.

## 5. Services parity — eight findings (`9031ff5`)

**FEEDS**: (1) the watcher notification-pref filter gates EACH action family at
write time — code-family/default ⇔ IsWatchingAll (mode ≠ Custom AND all three
flags, watch.go:81-84), release ⇔ include_releases, issues ⇔ include_issues,
PRs ⇔ include_pull_requests (feed.go:67-89); the unit-permission conjuncts stay
as the documented deviation; SPEC §3.2's stale no-columns premise narrowed to
the truth — the columns live since migration 0053. (2) a dangling comment_id
renders 0 with no comment object (upstream sets CommentID inside
`if ac.Comment != nil` — convert/activity.go:42-46; SPEC §4's wording corrected
to Go-zero-renders).

**GIT-HTTP**: (3) the mirror-readonly 403 drops http.Error's `\n` and adopts
upstream's exact PlainText headers (text/plain;charset=utf-8 + nosniff). (4)
owner-inactive (:103-107) and archived-push (:124-128) now refuse PRE-auth —
anonymous gets the plain 403 body, not the 401 Basic challenge (neighbor
matrices re-read green). (5) `?go-get=1` answers on `/info/refs` AND both POST
RPCs (githttp.go:63-66, :371, method-gated); the synthetic-HEAD no-meta
posture preserved.

**WEBHOOKS**: (6) X-Gitea-Hook-Installation-Target-Type resolves the OWNER ROW
— org ⇔ organization, user ⇔ user, owner-gone ⇔ default (upstream's owner≠nil
guard; fixes the old always-user); proven by seeding an org hook through the
store layer. (7) the branch-filter glob is a dependency-free 1:1 port of the
ACTUAL pin — `gitea.dev/modules/glob`, Gitea's own 2025 regexp rewrite (NOT
gobwas; go.mod carries no glob dependency): bare Compile = NO separators so `*`
and `**` cross `/`, `?` ⇔ `.`, classes/ranges/negation, nested `{a,b}`
alternation with the void arm, malformed ⇔ null ⇔ DENY (webhook.go:119-122);
every malformed class pinned, including the bare-`]` outside a class
(Go rejects, JS doesn't) asymmetry.

**ENGINE**: (8) the atomic ng text is git 2.43's receive-pack.c:1896
`atomic transaction failed` (binary-verified; the vendored literal appears nowhere in
2.43's ng paths); NOTICE.md's deviation row appended, dist-types regenerated
clean, check-capability-matrix.mjs's stale byte-observation comment re-cited.

**decideDeployKey's archived ordering** — the residual the same landing
flagged — landed upstream-faithful at `452984c` (S10): the gdt_ dispatch DOES
reach the archived arm without an anonymous stage (acl.ts:230 bypasses
decide()), and upstream answers the archived 403 BEFORE GetDoerRepoPermission
(githttp.go:124-128 < :185-193); landed order: owner-inactive 403 →
admin/owner-null 404 mask → pre-grant archived 403 (writes only) → read arm →
write-mode mask — the admin mask stays ahead deliberately (upstream's repo
DELETE has no archived arm, repos are deletable); the stale owner-inactive
cite fixed (:104-107); new gate pin: read-mode key + archived receive → 403
archived body, clone advert 200.

## 6. Codecs and platform (`01c7dfb`)

- **zstd RESOLVED-window gate**: the exponent-only windowLog check let a
  windowLog-27 mantissa-7 frame through at ~240 MiB; the gate now bounds the
  RESOLVED window at (1<<27)+1 per zstd_decompress.c's fParams.windowSize;
  singleSegment bounded.
- **conda URL rule**: upstream's IsValidURL is http/https-ONLY
  (modules/validation/helpers.go:42-51) — an `ftp://` dev_url now CLEARS
  validation (the pin repinned), control bytes rejected; the metadata counter
  is catch+log (packages.go:666-670), with a Proxy-D1 counter-failure test
  proving the blob still serves.
- **admin-monitor**: the free-form degraded log now classifies per SPEC-0021
  §5's binding taxonomy.

## 7. Tooling

- **check-openapi registrations** (`01c7dfb`): the terraform management-delete
  422s + the merge route's 201 (the MWCS schedule success, pull.go:1004-1006)
  registered in RUNTIME_ONLY_RESPONSES; check:api PASS.
- **the transfer 409 declarations** (`02f0f1b`): the declared 409 on the
  transfer-request route fails the contract checker without its
  RUNTIME_ONLY_RESPONSES companion (+8 — the same mechanical necessity
  S4/S10 hit); entry with cite; check:api PASS.
- **bootstrap-admin mint guard** (`8e5c4ea`) — the root-cause fix for v1.5's
  observed standing-PAT churn (2 → 10): the direct-SQL INSERT (name='bootstrap')
  ran unconditionally, so every probe-retry invocation added a row — the D1
  schema deliberately carries NO unique constraint on (user_id, name);
  duplicate-per-user is rejected at the service layer, matching upstream's own
  non-constraint check (access_token.go:129-132). The script now ports the SAME
  rule the API layer enforces (token-service.ts:86-93; AccessTokenByNameExists
  at routers/api/v1/user/app.go:108-117): a pre-INSERT lookup by (user,
  'bootstrap') skips the mint on a hit — exit 1 (the plaintext prints exactly
  once by contract and only the sha256 digest is stored, so a skip cannot
  recover it); stderr names the existing row's id/prefix plus the id-based
  DELETE hint (by-name deletion hits the 0/1/many 422 ladder with stale
  duplicates). **Idempotency PROVEN on local D1**: 0 → run1 mints → 1 → run2
  skips exit 1 → 1 → run3 skips exit 1 → 1 (the old code's 3-row drift is the
  exact mechanism `0219256` observed); scratch cascade-deleted after, orphan
  count 0.
- **the diffpatch cancel pin** (`de5efaf`): S2's known-red healed — the
  cancel-route pin flipped to the BARE 404 `not found` body (upstream's cancel
  handler answers ctx.APIErrorNotFound, unlike the pulls GET routes); 12/12.
- **the packages.ts 422 declarations** (`452984c`, S10): the two terraform
  delete declarations widened {204, 404, 422} (terraformDeleteRefusal,
  apiErrorSchema) — `01c7dfb`'s named follow-up. The brief's
  remove-the-registry-entries letter was mechanically impossible (the check's
  declared-subset-contract rule, check-openapi.mjs:403-411; empirically proven
  exit-1), so the entries stay, rewritten to as-built engaged-exception
  wording — the check emits the two engaged warnings and PASSes.
- **the engine comment** (`452984c`, S10): control-plane.ts's stale
  `atomic push failed` comment re-cited to the constant (NOTICE row 184
  already covers the flip; comment-only, dist-types regenerated clean).

## 8. The repo surface — fork visibility, the transfer ladder, the settings danger zone (`02f0f1b`, `6b7b517`, `8b46159`)

**Fork-visibility coupling** (`02f0f1b`, P2): setVisibility became the full
setRepoVisibility port (services/repository/repository.go:145-205) — a flip
recurses per fork level (row flip → per-repo star/watch zeroing (:172-181) →
best-effort registry priv mirror → the cascade gate
`isPrivate || owner != private` evaluated PER LEVEL, so a private-org fork
flips itself while its subtree stops and a LIMITED-org fork's subtree passes,
:184-200 → children via the fork_parent recursion, migration 0009's column
read directly). The route gained upstream's forcing arm (repo.go:673-679): a
fork's private request is replaced by the base repo's value BEFORE change
detection — an out-of-step base renders a silent no-op re-render; a dangling
forkParent degrades to the fork's own value. Pinned: forced no-op both
directions, 3-level cascade, private-org stop, limited pass, per-level
zeroing.

**The transfer ladder's parity arms** (`02f0f1b`): edit-binding MaxSize checks
after req.valid — description >2048 / website >1024 → 422 `[Field]: MaxSize`
verbatim (api.go:842 over binding.go:39; boundary accepted, nothing
persisted). requestTransfer pre-reads a standing row and answers 409
TransferInProgressError (transfer.go:55-57 verbatim, :113-115) — the
UNIQUE(repo_id) concurrent loser maps to the same error and the original row
is preserved (a re-request with a DIFFERENT target pinned). On accept, the
per-seam verdicts: num_repos is documented-equivalent (users carries no such
column — counts derive from rows) but the seam that exists is ported
(RemoveOrgRepo's team_repo_access delete + per-team numRepos decrement with a
MAX(,0) floor inside the accept batch, org.go:559-588); the
redundant-collaborator drop is ported (the new owner's row + new-org members;
the ghost arm has no upstream seam); the watch transfer is ported (doer +1
Custom-kept, old-org Auto→Dont/else→None, upstream order); old-org label edges
are ported (physical issue_labels rows + the type-7 comment deletes per
transfer.go:267-306, with the foreign-repo + foreign-org conjuncts —
definitions and drifted counters left alone exactly like upstream's raw
deletes). Full-cascade pins: org→user accept (team tally 3→2, doer watch
lands, org watch drops, org+foreign label edges/comments detach while own
survive, the new-owner collaborator dropped, the outsider kept) and the
user→org accept arm. The declared 409's checker fold is in §7.

**The transfer ladder completes — team_ids and the org-admission gate** (V2,
`7f2ecd3`, the U16 salvage): migration 0061_aromatic_meggan carries exactly
the two columns the landing needs — `repo_transfer.team_ids` (text, `[]`
default, the house JSON convention over upstream's `RepoTransfer.TeamIDs`
slice; §15) and `repositories.num_closed_milestones` (the M4 counter, §9).
O3: the route ladder verbatim-checked against the pin — a non-org target with
a present list answers 422 `Teams can only be added to organization-owned
repositories` (an empty array counts: Go's `*TeamIDs != nil`; a bare null is
zod-rejected upstream), an unknown id 422 `team N not found`, a wrong-org id
403 `team N belongs not to org M` — upstream's arm order kept. Valid ids ride
requestTransfer into the pending row; on accept, teams attach per filed team
(guarded num_repos+1 + team_repo_access onConflictDoNothing; a vanished team
drops silently per LoadAttributes :111-121 — verified; includes-all stays
unmaterialized per the landed reduction), pinned incl. idempotent re-attach.
O4: canUserAcceptOrRejectTransfer is the verbatim port of transfer.go:142-160
(verified at the pin — user recipient id-equality :151, org recipient rides
the canCreateOrgRepo owner-bridge :153); the old {owner,target,admin} grant
is GONE — 403 upstream's `permission denied` verbatim, NO admin bypass
(pinned: admin → 403), and the reject route composes the same predicate. V2's
two attributed findings — a stale teams comment at models/repository.ts:375-377
and the private-org transfer anti-enumeration 404 arm NOT implemented
(findUserByName does no visibility filtering — a real parity gap, new ledger) —
LANDED at U21 (`16ca6c9`): the comment rewritten to the as-built ladder, and
the anti-enumeration arm mirroring transfer.go:71-77 exactly (org-typed
target AND not site-admin AND visibility strictly private — LIMITED passes —
AND no org_members row of ANY role → the same `The new owner does not exist
or cannot be found` 404), placed BEFORE the team ladder (:71 < :79) so the
team arms cannot probe org existence; pinned with the full matrix (outsider
404 + no row, +team_ids still 404, member 201 any-role, admin 201
no-membership, limited 201, public 201).

**The repo-settings danger zone** (`6b7b517` — ⑨'s R2): the four
dangerous-operation forms, ported from options.tmpl:804-870 +
setting.go:194-206/:865-1063. TRANSFER START carries dangerous_operation_form's
exact shape (hidden action=transfer, typed full-name confirmation,
new_owner_name) and the full gate order — confirm-name exact
(enterred_invalid_repo_name) → case-folded owner lookup
(enterred_invalid_owner_name) → the blocked-user probe (the API transfer
route's own composition, admin/self skipped) → destination-collision pre-check
(new_owner_has_same_repo, self-arm excluded) → requestTransfer with
OwnerNotAssignableError texts surfaced verbatim. A PENDING-TRANSFER BANNER
renders transfer_started %s over the recipient's DisplayName and swaps the
start form for the abort form while a transfer is in flight (a thin inline
read over repo_transfer+users). CANCEL answers transfer_abort_invalid verbatim
on a miss before cancelTransfer; DELETE rides the confirm-name gate into the
full D1 cascade. Action routing lives in the page module (applyRepoBasics
dispatches into applyRepoDangerAction — upstream posts every arm to the same
/settings URL), so ui/index.ts stayed untouched; archive/unarchive/visibility
were already carried by the merged basics form, not duplicated. Three arms are
blocked on the index.ts follow-up bundle (§16): delete's owner-dashboard
redirect override (the write is upstream-exact and pinned; the landing page is
ours), the doer threading (settingsSubmit passes no viewer — exact for
user-owned repos), and the admin-repos delete button's route registration (the
seam is landed, the button renders nothing until then). The fourth form,
delete-wiki, landed at `8b46159` (below) with its env threading fail-closed.

**The whole-wiki delete arm + the N4 sweep** (`8b46159`, U8): the danger
zone's fifth form — the wiki row between transfer and delete, has_wiki-gated
exactly like upstream's unit-read gate (options.tmpl:873-885), the
dangerous_operation_form shape with a typed FULL repo_name +
confirm_wiki_delete (name-mismatch → enterred_invalid_repo_name; applied →
303 /settings, upstream's JSONRedirect). The storage model was read before
shaping: wiki pages are *.md blobs in the sibling engine cell (the D1 flag is
repo_settings.has_wiki), so deleteWiki first flips has_wiki=false via
saveRepoSettings (upstream removes the TypeWiki unit, setting.go:594), then
runs a best-effort bounded page-walk (BFS over the cell tree, 5000-entry /
depth-16 caps) feeding ONE applyWikiChanges delete set — a single
tree-emptying 'Delete wiki' commit; storage failures are logged, not thrown
(upstream's flash is unconditional). DOCUMENTED DIVERGENCE: upstream's
git.DeleteRepository removes the whole wiki repo including history; ours
empties the tip tree — pages/raw/revisions go not-found, blobs are reclaimed
at repo-delete's cell destroy, and history is retained so a re-enabled wiki
starts empty. NO webhook fires (upstream fires none — only an audit record,
and our audit enum has no wiki arm yet: follow-up dispatched). WIRE GAP,
fail-closed: settingsSubmit passes only the DB handle, so the delete-wiki arm
REFUSES BEFORE ANY WRITE until the one-line env threading lands in ui/index.ts
(§16's bundle). N4, the repo-delete notification sweep: deleteRepository's
issue-scoped batch now sweeps notification_states — our derived model keys on
(user_id, issue_id) with no repo_id column, so the arm joins through the
repo's issue ids exactly like the comments/subscriptions siblings (upstream's
Notification{RepoID} census arm, services/repository/delete.go:170; the
adaptation disclosed in the comment). Pinned: doomed threads' read+unread rows
gone per-issue, a survivor repo's row intact.

**The wiki follow-ups land** (V3, `6f1008b`, the U17 salvage): the
slashed-title quirk (§16's ledgered 500-after-create) is FIXED at the read
side, and the shape is worth recording — writes land the codec's GitPath
segments as tree entry names VERBATIM (buildFileChangeCommit splits on literal
'/'), while every engine read decodes per segment (decodePath), so the flat
stored name was unreachable by any read. ONE helper fixes it: enginePath
(wiki.ts:421) doubles the codec path's only meta-character % — the GitPath is
already QueryEscaped (every % a valid escape, `/` → `%2F`), so the engine's
decode restores the codec's exact bytes and every read becomes
entry-name-equality against the flat stored name (plain names identity).
Applied at all ten engine boundaries in the file (prepareWikiGitPath,
pageBlob, countCommitsForPath, both last-commits, revisions, rawBlob, the
tree descent); the list arm renders decoded slashed titles symmetric for
free. THE AUDIT ARM: registry row `repository:wiki:delete` with the template
verbatim (action.go:151 — verified, positioned between the transfer and
collaborator blocks) and emission in deleteWiki ordered exactly as the pin
(flag reset :366 → sweep :370-376 → audit.Record :378 as the FINAL statement —
OUTSIDE the sweep's try/catch, recording even when the sweep failed);
catch-and-log per event.go:138-141 (the dead unit's :149-152 cite was
FindEvents/metaPairs — repaired in three places). CROSS-UNIT FOLD
(attributed): registering the action grows the audit-logs dropdown's
actionFilters, and the two audit-logs goldens (org-settings, repo-settings)
land IN THIS COMMIT carrying exactly the two new options — the dependency
V3's report named (V1's commit will exclude them).

## 9. Issues and labels — scoped/exclusive semantics, the self-healing recount (`e6b980e`, `14ba724`, `9d72592`)

**Scoped/exclusive labels** (`e6b980e`, SPEC-0023 first — §15): THE ORDERING
RULE, read off the pin (conventional wisdom corrected): exclusive_order is
DISPLAY-ONLY (CompareLabelForDisplay/SortLabelsForDisplay, label.go:196-230 —
scope-less first, scope groups by name, exclusive_order asc with ≤0 last, name
tie-break); the attach/replace tie-break is POSITIONAL —
RemoveDuplicateExclusiveLabels keeps a scoped label only if no LATER request
entry shares its scope ("labels at the end of the array getting preference",
issue_label.go:356-373), the multi-attach loop's last same-scope id wins —
pinned with a descending-order test an order-based tie-break would have
failed. Scope resolution is purely name-based: the last-/ cuts, either half
empty = no scope, and repo and org labels in the same scope exclude each other
(label.go:184-191); creation-time attach stays dedupe-free (upstream NewIssue
calls newIssueLabel directly — documented out of scope). THE ARMS: setLabel
dedupes same-scope removals BEFORE attach (the already-attached short-circuit
first); replaceLabels positionally filters the requested set then diffs (adds
before removes); the type-7 comment seam is COMPOSED — removal ('' content)
and add ('1' content) comments now write on these arms exactly as upstream's
module-private removeIssueLabel statement shape does, which also equips the
API's add/replace/clear arms (§4's authorization block rides the same seam).
The sidebar picker sorts by sortLabelsForDisplay with scope dividers and
per-item data-scope; upstream has NO alt-click semantics, and our no-JS form
collapses to the same resolution server-side via the positional filter.

**The self-healing milestone recount** (`14ba724`, M3): updateMilestone now
runs upstream's two-exec recount in one batch (milestone.go:183-205) — (1) the
fields plus numIssues/numClosedIssues via correlated subselects filtering
milestone_id ALONE (milestone IDs are globally unique PKs; the pin has no repo
conjunction), (2) completeness from the RECOUNTED values in a second statement
— the split is load-bearing: SQLite SET expressions read the pre-update row,
so the old single-statement formula read possibly-drifted values. Direct-D1
drift pins both directions (a 99-heals-to-2/1/50 row on a no-op-ish PATCH;
0-heals on the state flip with closed_date_unix still stamped);
MUTATION-PROVEN (recount stripped → exactly the 2 fail). Upstream's state-flip
updateRepoMilestoneNum stayed out pending the column — M4 has since LANDED
(`7f2ecd3`, below).

**M4 lands** (V2, `7f2ecd3`): migration 0061 adds
`repositories.num_closed_milestones` (integer, DEFAULT 0 — §15), and the
flip-gated third batch statement now recounts BOTH tallies via count(*)
subselects exactly as upstream's updateRepoMilestoneNum (:298-305, called at
the IsClosed flip :165 — both verified at the pin); deleteMilestone gained the
post-delete recount, replacing the drift-prone MAX(,0); createMilestone stays
untouched (upstream increments on open only); the DEFAULT 0 backfill settles
on the next recount, and the poison-row 99/99 self-heal is pinned.

**The attachments OPTIONS 405 twin** (`14ba724`): the attachments serving
router gains the OPTIONS 405 beside the GET (web.go:912's
Methods("GET, OPTIONS") + optionsCorsHandler's deny arm — with CORS disabled
the handler bare-405s every OPTIONS, so a preflight cannot double-count a
download). Pinned: download_count 0 through OPTIONS, 1 on GET; empty body +
Allow: GET, OPTIONS in the house methodNotAllowed shape. The stale "OPTIONS is
not carried" divergence note is rewritten to the deny-arm-carried truth;
MUTATION-PROVEN (route disabled → exactly the 1 fails). The observed residual
— POST /attachments/{uuid} still falls to Hono 404 where chi's method-mismatch
arm 405s — joins the index.ts follow-up bundle (§16).

**The type-7 test accommodation and the regression sweep** (`9d72592`, U10):
the one test whose seed rides setLabel now expects the comment PAIR in order —
the seed's ADD marker (`{type:7, content:'1'}`) before the arm's removal
marker (`{type:7, content:''}`), and the num_comments pin moved 1 → 2 (both
seam paths bump the counter — a latent drift the old run never reached, now
pinned). The sweep: all 15 files that seed through setLabel/replaceLabels or
assert timelines/counter snapshots ran SOLO green — zero genuine bugs, the
only red was the briefed accommodation.

## 10. The notification mailbox — mute-over-union and the retired reductions (`c273341`)

- **N1 (P2) repo-mute outranks EVERY recipient source**: the recipient
  expression wraps the whole arm union with a top-level not-exists over
  repo_watchers(mode=2) (notification_list.go:135-141's
  remove-ignorers-from-toNotify; the watchers arm keeps its own guard) — an
  ignorer who commented, was mentioned, or is the poster loses the thread on
  all three arms (pinned; the mail layer's twin rule confirmed by citation).
- **N2 (P3) the reduction RETIRED, both arms implemented**: issue_assignees
  exists (schema :1818-1827) and pull_reviews carries upstream's
  ReviewType.Request rows exactly (schema :2367-2420), so the recipient
  expression gains the assignee exists-arm and the requested-reviewer arm
  (rr.type=4 AND reviewer_id = the user — team-request rows never qualify a
  user, negative-tested).
- **N3 (P3) the WIP gate**: conjuncts ONLY the repo-watch arm
  (notification_list.go:100) with not(isPull AND title LIKE any WIP prefix)
  from a literal-synced mirror of the mail layer's WIP_PREFIXES (SQLite LIKE's
  ASCII case-insensitivity equals the helper's rule). Pinned: a WIP:/Draft:
  title is dropped for the pure watcher, a comment-participant is still
  reached, a rename off WIP re-qualifies.
- **N6 (P3) documented equivalence**: users.type is the collapsed
  ['user','org'] enum — bot rows cannot exist, upstream's IsTypeBot skip is
  vacuous here.
- **N5 (P3) REFUTED at the pin** (recorded in §16): the transition-pinned
  CommentID is real (notification.go:176-196) but the REST serializer never
  renders it — our fillLastCommentIds already matches upstream's rule.

## 11. Admin and org — the API findings and the membership web arms (`7b4ccfc`, `9b45d68`)

- **A2 (P2) the dead is_2fa_enabled filter revived**: real EXISTS/NOT-EXISTS
  over the two_factor store (migration 0059; the in-twin of upstream's 1:0..1
  LEFT OUTER JOIN, models/user/search.go:141), both polarities, engaged only
  when the param is present.
- **A1a (P2) the third in-tx guard**: a non-purge user DELETE now counts
  package_versions-joined packages (HasOwnerPackages, package.go:342-351) →
  422 verbatim `user still has ownership of packages [uid: N]` beside the
  sibling 422s (admin/user.go:303-311; all three guards re-verified in
  upstream's final tx).
- **A1b (P2) the purge cascade's packages arm**: via the shared
  deletePackageAndReferences seam in upstream order (packages.go:720-750) —
  blob rows and R2 keys deliberately untouched: the hourly cleanup sweep stays
  the SOLE content-key deleter, the exact split upstream's
  RemoveAllPackages+CleanupTask implements (pinned rows-gone /
  blob-survives-with-zero-refs).
- **O2 (P2) the include-all claim corrected**: the reviewer's "PATCH strips
  rows on flip" premise was stale — UpdateTeam's includeAllChanged is ADD-only
  at this pin (team.go:167-174; RemoveAllRepositoriesFromTeam fires only from
  DeleteTeam/web-removeall). Ported faithfully: the flag stored, TRUE fans out
  team_repo_access rows for never-rowed org repos with per-row numRepos bumps;
  the union-vs-rows interaction documented (rows inert while ON, live for the
  OFF aftermath where rowed repos keep access — upstream parity).
- **O5 (P3)**: a present non-empty org email validates → 422
  `email address is invalid: …`; '' clears.
- **O6 (P3)**: both repo-team handlers reordered to teams.go:191-199 — the
  manage-gate 403 precedes the team 404.
- **O7 (P3)**: include_desc rides the ParseBool+'on' rule (base_form.go:61-66)
  — the old `!== 'false'` compare treated 'yes' as true.
- **O9 (P3)**: teamSearch failure → 500
  `{'ok':false,'error':'SearchTeam internal failure'}` verbatim
  (team.go:810-818).
- **O8 (P3) both member riders**: add-member auto-watch (default-true posture
  documented, upstream's goroutine inlined); remove-member reconsider
  (public-or-surviving-grant keeps watches; else unwatch + stopwatches + issue
  subscriptions; assignees ride the same arm).

**The ⑨ P1 — the org/team membership WEB arms** (`9b45d68`, U1): the two
families upstream posts membership actions through are claimed and registered
in ui/index.ts with GET→405 twins — POST `/:owner/teams/:team/action/:action`
and its `/action/repo/:action` sibling (web.go:999-1000, TeamsAction
teams.go:113-254 + TeamsRepoAction :271-314) and POST
`/org/:owner/members/action/:action` (web.go:992, MembersAction
members.go:82-133); `{action}` is upstream's wildcard param (unknown tokens
fall through to the default redirect, teams.go:246-253), and the team segment
carries both carriers. THE BRIEF'S ACTION NAMES CORRECTED AGAINST THE PIN:
add_member/remove_member do not exist upstream — the as-built set is
add|remove|join|leave|remove_invite (+ repo add|remove|addall|removeall). The
ladders compose the existing TeamsService/OrgService seams with zero
duplicated logic: the RequireMember+RequireTeamMember prologue (owners/admins
pass, members need team membership, outsiders a 404 shell, anonymous 303);
join owner-only; leave with checkIsOrgMemberAndRedirect's three-way (:249-262);
remove/add owner-only with the blocked-user and org-target refusal redirects;
remove_invite reduces both arms (no invite store at this pin); the repo
family's owner-gate-before-switch (:272-275) with addall/removeall composing
the single-repo arms over direct enumeration (upstream repo_team.go:72-126 has
no landed service arm — documented); the members family uid-first
(members.go:84-89), private/public self-or-owner, leave-removes-doer → 303 '/'
— upstream's JSON answers reduce to 303s per the house no-session-flash
convention. The buttons carry the verbatim template gates as plain-POST
reductions (members.tmpl:50-71's visibility toggle + Leave/Remove by role —
anonymous renders none; the team detail's sidebar.tmpl:14-23 Leave/Join,
members.tmpl:11-17 owner add + :36-42 Remove, repositories.tmpl:13-28
add/add-all/remove-all with the per-repo remove suppressed under
includesAllRepositories). One disclosed pin flip in pages-wave12.test.ts (the
null-action pin → the as-built claim, the wave-49 precedent pattern).

## 12. The ⑪ material — the actions emitter and the avatar/attachment batch (`86b5aee`, `d973408`)

The ⑪ actions/explore/avatars review's A-findings landed in two units — U14
carried the actions half (A1–A4), U15 the avatar/attachment half (A5–A9) —
all landed, zero deferrals, one residual ledgered. (The ⑨ review's own
A-findings — A1a/A1b/A2 — live in §11; the two letter-series are distinct.)

**The needs-chain emitter wired into completion** (U14, A1 P1): updateTask's
tail now carries the unconditional createCommitStatusForRunJobs for the
completing job (runner.go:263 — verified at the pin; refreshRunStatus was
verified never to post statuses) and checkJobsOfRun for any non-unspecified
report (runner.go:270-276 — verified) — INLINE per SPEC-0012 §4.5's bounded
posture (the trigger insert tail's own inline precedent, trigger.ts:2712);
the trigger↔update cycle is function-level lazy, documented at the import;
updateTask gains appUrl (the routes handler passes appUrlOf(c)); the stale
"M3 replaces the aggregate arm" header promise rewritten; the notifier half
(NotifyWorkflowJob/RunStatusUpdate) documented unported.

**THE E2E** — the confirmation ⑪ explicitly requested: a fake-runner harness
over the real mounted app walks the build+deploy chain with deploy staged
BLOCKED, a poll claims build only, updateTask(result:1) runs OVER THE LIVE
PROTOCOL, deploy flips BLOCKED→WAITING, the next poll claims deploy (the wake
bump's version mismatch), the run reaches SUCCESS with the stopped set, and
each job's status-context lands a latest-row success; a companion service pin
stages deploy PENDING (the producer's needs-unmet arm).
MUTATION-KILLED (the emitter disabled → exactly the 2 fail, 51 pass).

- **A2 (P2)**: generateTaskContext reuses the landed resolutions —
  ref_protected via findRule on refs/heads/ (trigger.ts:1190-1197's own call;
  tags/pull refs false; catch→false per context.go:66-68 — verified),
  triggering_actor = the ATTEMPT's trigger user (runAttemptId → triggerUserId
  → username, '' fallback per :139-143 — verified), actor stays the run's;
  pinned both polarities.
- **A3**: the header contradiction fixed — proto-only per the wire freeze;
  JSON connect unimplemented/501, others 415.
- **A4 — landed, not diverged**: AbortSignal threaded routes FetchTask
  (c.req.raw.signal — workerd aborts on client hangup) → fetchTask →
  tryPickTask → pickTask; aborted after buildRunnerTask →
  releaseTaskForRunner + null (task.go:123-128's ctx.Err() arm — verified;
  null not a throw — no runner remains); mutation-killed. RESIDUAL LEDGERED:
  the claim path's OWN status post (task.go:113-121, after assembly in
  dispatch) remained unported at this landing — first posts via the insert
  tail or the next emitter pass — CLOSED at `16ca6c9` (below).
- Gates, orchestrator re-verified solo: ingest 29/29, routes 24/24 (the
  E2E), dispatch 15/15; trigger 149/149 per report; typecheck zero in owned
  files (6 transient ui errors attributed to U13/U16 in-flight); scoped
  eslint clean.

**The claim residual closes** (U21, `16ca6c9`): pickTask posts the claimed
job's commit status right after buildRunnerTask and BEFORE the disconnect
check — upstream's exact order (task.go:115 precedes the ctx.Err() arm
:123-128; buildRunnerTask returns {task, ctx} so the fresh post-CAS rows
ride back like upstream's job out-param). postClaimCommitStatus composes the
existing seam (commitStatusEventAndCommit + createWorkflowCommitStatus,
86b5aee-style) with log-only swallowing per commit_status.go:29-30 ("not
critical"); CAS-loss/assembly-failure post nothing; the disconnect release
posts first and the re-pick's identical context dedupes. Pinned: claimed →
row exists pre-report (context ci / build (pull_request), pending, In
progress, head sha, targetUrl, creatorId −2); assembly-failure → zero rows;
abort-release → re-claim dedupes to one. (U21 also landed V2's two
transfer findings — §8.) ATTRIBUTED for trigger.ts's owner (dispatched,
§16): toCommitStatus/toCommitStatusDescription omit RUNNING(6)/CANCELLING(8)
despite the comment claiming they ride (RUNNING falls to error/Unknown — the
claim post is the first RUNNING caller, its mapping lives locally pending
that fix; the cancel arms posting CANCELLING hit the same gap); and
trigger.ts:2024's targetUrl template double-slashes under appUrlOf's
origin+trailing-slash (completion-time URLs carry //owner — the dispatch
site joins single-slash). Gates, orchestrator re-verified solo: dispatch
18/18 (+3), repo-edit 62/62 (+6), actions routes E2E 24/24 downstream;
typecheck tree-zero; check:api PASS; scoped eslint clean.

**The avatar/attachment P3 batch** (U15, `d973408`, five landed zero
deferrals):

- **A5**: ALL THREE download-count increments go atomic
  (sql`download_count + 1`, the model.ts:357 precedent) — the
  ServeAttachment issue+release halves and the API blob GET's twin
  (upstream's `UPDATE SET download_count=download_count+1`,
  attachment.go:46-53 — verified at :48); pinned second-GET→2 (house style:
  real-D1 counts, no SQL spies).
- **A6**: goPathBase (the Go path.Base port, one copy in the httplib port
  module; the new api→web import seam noted) at both Content-Disposition
  builds — the reviewer's serve.go:141 cite corrected to
  modules/httplib/serve.go:92 (verified — the path.Base call rides the
  Content-Disposition build there) in the restructured pin (same code);
  slash-name route tests + the full path.Base unit block (''→'.', trailing
  slashes, all-slashes→'/').
- **A7**: the header's default-size cite corrected — issue-attachment 100 MiB
  (setting/attachment.go:19 — verified) vs release-asset 2048
  (setting/repository.go:234 — verified); our SPEC-documented 512 cap
  untouched.
- **A8**: the allowed-types whitelist reduction ledgered in SPEC-0005 §3.3
  with the VERIFIED pin cites (upload.Verify at
  services/attachment/attachment.go:78 over the issue path's AllowedTypes :59
  — both verified; the reviewer's issue_attachment.go:196-198 is
  pre-restructure, no such file at fc493688; both recorded).
- **A9**: the avatar fallback ports both missing arms of
  HandleGenericETagPublicCache (base.go:36-44 — verified, the not-exist
  fallback's cache call; httpcache.go:115 — verified, the
  If-Modified-Since block) — If-Modified-Since when INM absent (strict
  IMF-fixdate, second precision, ≤) and the BARE 304 (Cache-Control only on
  the miss path; the found-object arm's 304s legitimately carry it via
  ServeContent); pinned the four-way matrix.
- Gates, orchestrator re-verified solo: avatar-serving 41/41,
  attachments-serving 46/46, issue-attachments 29/29 (the whole-file
  uncaught-rejection log line attributed to the pre-existing 411 duplex
  test); typecheck EXIT 0; scoped eslint clean. COORDINATION CLEAN:
  attachments-serving.ts was empty-diff at U15's start and carried only
  U15's hunks at landing (U13's 405 twin not yet started).

## 13. The files and diff family — the ⑫ findings (`326904e`, `8994488`)

The ⑫ diff/files review's D-findings landed across two salvage units: V4
(the verbatim-git renderer family, the U18 salvage) and V5 (the
files/compare family, the U19 salvage). The D-ledger state as of this draft:
D1, D3, D9, D10, D11 landed with V4; D4–D8 landed with V5; **D2 and D12
remain pending** (§16).

**The verbatim-git renderer** (V4, `326904e`): the dead wave's
renderUnifiedDiffAsync/DiffBlobSource design kept, the contract verbatim git
bytes — upstream GetPatch is documented "able to be used with `git apply`"
(modules/git/repo_compare.go:73-77 — verified) — and every pinned literal
RECORDED REAL-GIT OUTPUT (git 2.43, reproduced in a scratch repo at authoring
time and copied verbatim; the zstd.test.ts oracle-fixture precedent, since
workerd cannot spawn the binary). THREE real defects were found under the
real-git re-verification and fixed in-landing:

- **D1 (P1)**: mode-only sections emit `old mode`/`new mode` and NOTHING
  else (headers-only sections are git-apply garbage — real git's error
  reproduced; the probe APPLY-OK), the no-newline marker on the lacking
  side, the terminal-eq rewrite byte-identical to git, the synthesized
  newline-only hunk with the 3-line context cap. THE DEFECT FIXED: the hunk
  walk initialized aIdx/bIdx only on the first hunk, so multi-hunk files
  with inter-cluster gaps dragged the counters and silently DROPPED the
  old-side marker (an inapplicable pre-image — the P1's own failure mode);
  per-hunk reset, two-hunk shape verified + APPLY-OK, regression pinned.
- **D3 (P3)**: index lines carry the mode column only when both sides share
  it (new-file bare, mode-only no index at all, the 79-byte
  empty-created-blob shape reproduced); hunkCount omits `,1`; no collateral
  (HTML views format their own headers — compare.matrix/a11y/wave46/
  pull-reviews confirmed safe).
- **D11 (P3)**: merge .patch — upstream's format-patch shape verified at
  modules/git/diff.go:87-99 (`format-patch --no-signature --stdout` over the
  `merge...parent0` query); real-git: a merge is never a mail, a merge-only
  range is ZERO bytes, `[PATCH i/N]` only for N>1. THE DEFECT FIXED: the
  series join was off by one newline on the signed seam ((mail+\n) joined by
  \n, both seams; xxd-recorded).
- **D10 (P3) — HONOR**: parseUnifiedPatch parses file modes through to
  FileChange.mode (create/update/rename arms). The dead unit's comment
  claimed git "fails does not match index" — a FALSE verification claim
  (real git only WARNS, exit 0 even with --index); kept as-built STRICT 422
  fail-closed (a patch claiming a pre-image mode the tree lacks was not
  generated against this tree) with the divergence honestly documented both
  sides; lone/malformed modes mirror git's real refusals.
- **D9 (P3) — IMPLEMENTED**: signoff appends `\nSigned-off-by: name email`
  from the committer identity (temp_repo.go:312-317 verbatim — verified; no
  trailing newline; committer→author→doer fallback = the family's landed
  convention); schema description added; both polarities pinned.
- OPEN NOTES dispatched next (§16): the non-merge single-mail .patch's
  missing final trailing newline (one byte); routes/commits.ts's compare
  .patch still renders merges with the old single-mail shape.
- Gates, orchestrator re-verified solo: git-models-diffrender 19/19 (new),
  diffpatch 17/17, wave29 15/15; collateral green (compare.matrix 25,
  pull-engine 50 aligning with V5's re-pins, a11y 91); typecheck tree-zero;
  check:api PASS; scoped eslint clean.

**The files/compare family** (V5, `8994488`):

- **D6 (P2)**: the ChangedFile vocabulary+URLs — the mapping lives in
  git-models.ts's toChangedFiles, which RODE V4's landing (V5's named
  dependency; now committed, with the route-side consumption at
  pulls.ts:1473 verified — no duplication to fold): status
  `added|deleted|changed|unchanged` per convert.go:1083-1104 (verified —
  never `removed`; 0-add/0-del → `unchanged`), previous_filename omitted
  (upstream omitempty — the explicit null gone), html_url
  `/src/commit/{sha}/{path}` + raw_url `/raw/commit/{sha}/{path}`
  (:1105-1108); the copied/renamed arms are comment-cited unreachable under
  the NOTICE no-rename reduction.
- **D7 (P3)**: X-Total-Count = the TRUE total (SetTotalCountHeader —
  verified at pull.go:1573; the landing's :1568-1569 cite drifted ~4 lines,
  same function, same semantics); the X-HasMore-riding-full-count-under-skip
  quirk is upstream's own shape, kept; the stale setCommitListHeaders
  SO-FAR doc corrected to caller-supplied-per-route.
- **D8 (P3)**: skip-to IMPLEMENTED (findIndex/slice, git's
  unmatching→empty, total stays full); whitespace NOT implementable (the
  seam computes plain hunks only — the declare-and-ignore lie REMOVED, the
  reduction documented with pull.go:1536 + gitdiff.go:1704-1706 cites) +
  the inertness pin.
- **D5 (P3)**: `?stat` dropped, hard-coded Stat:true per compare.go:105-109
  (verified; the cite tightened from the dead unit's :99-105); stat-always +
  `?stat=false`-inert pins.
- **D4 (P2)**: total_commits = the TRUE range count — the cheap counting
  walk EXISTS (countDivergence, engine graph.ts:382 via repo.ts:1382, two
  OidSet closure walks, no materialization — pull-engine.ts:946's own
  precedent): the list stays bounded at COMPARE_COMMIT_BOUND (the
  resource-posture reduction vs upstream's unbounded walk,
  services/git/compare.go:101 — verified), the count honest past the bound,
  failed-walk window-length fallback + exhausted-walk lower bound disclosed;
  SPEC-0004's compare row records the as-built (§15).
- Pins flipped (the dead unit's, verified): page-2 X-Total-Count 3→2,
  removed→deleted, previous_filename null→absent, + the 251-total and
  skip-to tests; V5's own: stat-always, whitespace-inertness. Compat suite:
  ZERO flips (the contract's status is a plain string; the scenario pins 200
  only) — 158/158 untouched.
- Gates, orchestrator re-verified solo: pull-engine 50/50, pulls 30/30,
  compat 158/158; tsc EXIT 0; scoped eslint clean; check:api PASS 554 ops.

## 14. The probe battery alignments (S8 `d3f8211`; V6 `ebf21a2`)

- **The sweep**: every changed surface of the fix wave grepped against all
  pins — only fw-sudo-non-admin-403 touched one (strengthened to the BARE
  `{message}` body assert, `res.json.url === undefined`, per `0bd7798`); the
  MWCS stub text, cancel ladder, logout Set-Cookie shape, cherrypick spelling,
  mirror-403 bytes, pre-auth 403 ordering (the three anonymous-401 pins all
  target active-owner non-archived private repos — the reorder only moves the
  owner-inactive/archived arms), feed comment_id, and the deps/ancestor/manual
  merge arms were all PIN-FREE.
- **The audit arithmetic** (0219256's pattern, enumerated): the impersonation
  rows land in audit_events (migration 0038), which cleanup-audit never counts,
  and no battery flow rides UI impersonation (the sudo pair is the API `Sudo:`
  header — a token-level seam writing no rows) — all 10 expectations stand; the
  personal_access_tokens=10 pin describes the deployed standing set and stays
  (the future churn root-cause is `8e5c4ea`'s guard; `--expect-tokens`
  overrides at re-baseline). The annotation is now IN the battery: the README
  prose and the audit expect-string state the root cause is FIXED
  (`40d0a6c`), keeping the standing-10 claim verbatim.
- **The six new probes** (238 → 244 planned; window3 26→31, branch-protection
  18→19): bp-automerge-roundtrip (the MWCS ladder over a protected PR — 201
  empty, standing-row 409 verbatim, DELETE 204, re-DELETE bare 404; race-free
  by construction: unmet required_approvals keeps the consume-time re-check
  answering the protection SKIP, which leaves the row scheduled);
  w3-upload-staging-roundtrip (multipart 200 uuid → remove 204 → anon 404);
  w3-issue-unpin-204 (verb-first DELETE, idempotent, anon 303 exact-location);
  w3-time-delete-roundtrip (API-seeded 900s → 303 canonical → list empty; the
  four-segment spelling); w3-cherrypick-form-200 (underscore form action 200 +
  bare 404 engine-owned); w3-package-settings-roundtrip (PAT PUT 201 → cookie
  settings-form GET 200 with the registration-reorder shape → anon 404
  write-gate shell → form-delete 303 doubles as cleanup). window3 carries
  probePackage hygiene (the leftover sweep management-deletes on red).
- **The first-run drift watchlist** (all hard reds if they drift): the three
  named arms (the first live engine-cell GET, the repo_name discriminator, the
  protection-skip-leaves-row — verified against the landed ladder text, not a
  live queue).
- Gates: node --check PASS, scoped eslint 0, `--dry-run` renders 244 planned
probes own-eyes; the battery cannot run live pre-deploy — verification rides
the convergence chain.

**The second alignment** (V6, `ebf21a2` — the U20 salvage, 244 → 253, nine
new probes, fixwave-parity 22 → 31): THE REPAIR first — fw-cleanup promised
the danger-zone repo's deletion but its green-path body never deleted it (an
independent battery's red does NOT trigger the failure tail, so the repo
would strand); the cleanup now cancels the pending transfer via the owner's
web cookie then the guarded deleteRepo (a dzGone flag dedupes the tail).
THE SWEEP: every landed surface d3f8211..86b5aee re-verified against every
standing pin (grep + committed-truth reads via `git show HEAD:`) — ZERO
standing-pin drifts (the battery's only label/milestone writes ride the
owner-writer; no battery drives the API transfer route, settings POST,
attachments OPTIONS, notifications list, team search, visibility PATCHes, or
diff payloads). The V-wave's landings post-date the sweep window and ride
the README's convergence pending-markers for adjudication (below). THE NINE
NEW PROBES: fw-admin-2fa-filter (both polarities + the engagement proof),
fw-label-non-writer-403 (the verbatim c3ac813 text), fw-web-session-303,
fw-org-web-gate-404 + fw-org-web-owner-add-303 + fw-org-web-member-leave-303
(9b45d68's web arms with the exact redirects and the org-membership cascade
oracle), fw-danger-transfer-roundtrip (start → banner → cancel),
fw-danger-delete-refusal-200 (the verbatim refusal), fw-danger-delete-303
(the 404-shell divergence pinned as-is; a PENDING marker names the flip if
the delete redirect override lands). README: counts/rows dry-run-matched;
the Convergence-pending-markers section records the in-flight units' likely
impacts (U13's aliases/update_preferences — the bare-cherrypick 404 half of
fw-cherrypick-form-200 is the prime flip candidate; U16's transfer texts —
battery-pin-free, but the fw-danger-* pins move if the WEB texts change;
U18/U19's diff byte shapes — expected no-op, battery-pin-free; the in-flight
ui fold — the fw-danger-delete-303 location flips); the deliberately-not-probed
decisions recorded (U14's actions E2E lives in unit tests; the attachments
OPTIONS twin; U8's whole-wiki delete; U7's mailbox mute). Gates, orchestrator
re-verified: node --check PASS, scoped eslint 0, `--dry-run` renders 253
own-eyes; no JSON; the live run rides the post-deploy verdict with the
four-item first-run drift watchlist. V1's landing (`7d91ccd`) now ARMS one
of the two named flip candidates — the `fw-danger-delete-303` location pin
(the delete redirect override landed) — its adjudication rides the
convergence run; the README's other prime candidate (a `_cherrypick` alias)
did NOT land — V1's aliases are the bare EDITOR spellings
(`_new|_edit|_delete|_upload|_diffpatch`) only, so the bare-cherrypick 404
half of fw-cherrypick-form-200 STANDS.

## 15. SPEC ledger and migrations

- **specs/0023-scoped-labels.md NEW** (`e6b980e`, 224 lines): scoped/exclusive
  label semantics — the display-vs-positional ordering split, name-based scope
  resolution, and the type-7 comment seam (§9).
- **specs/0022-two-factor-webauthn.md NEW** (`0bd7798`, 300 lines): the surface,
  the cookie/TTL/clearing table, the AEAD format, 13 pinned divergences
  including as-built secret-at-rest = encrypted-in-flight; §6's dual-clear
  contract rewritten as-built at `452984c` (the webauthn mint arm landed).
- **SPEC-0004 appendix A** (`de5efaf`): the merge route's
  `{description:'empty'}` 201 declaration stays — it documents our runtime
  truth (upstream answers bare StatusCreated at runtime, pull.go:1004-1006,
  while its swagger declares only {200,403,404,405,409,423}; the omission is
  upstream's).
- **SPEC-0002** (`0bd7798`): the stale 'No 2FA' claims repointed — §4.6 item 10
  → 'No 2FA on the API chain'; SPEC-0010:89, oauth2-provider, and
  external-auth-sources repointed in the same landing.
- **SPEC-0016** (`01c7dfb`): the ftp sentence + the zstd posture rewritten.
- **specs/activity-feeds.md** (`9031ff5`): §3.2's stale no-columns premise
  narrowed; §4's wording corrected to Go-zero-renders.
- **SPEC-0021 referenced** (`01c7dfb`): admin-monitor's degraded-log
  classification per §5's binding taxonomy (no edit to the SPEC itself).
- **compat docs** (`16b30bb`): ui-parity-survey.md's window-2e cherrypick rows
annotated; stale-pin-sweep.md's cherrypick row re-counted (0 → 4 intentional
bare-literal pins, each enumerated) — historical files untouched.
- **SPEC-0004's compare row as-built** (`8994488`, §13): stat is hard-coded
TRUE (`ToCommitOptions{Stat: true}`, compare.go:105-109 — the query has no
stat param; the old `?stat=` read was undeclared and removed) and
total_commits reports the TRUE range count past the COMPARE_COMMIT_BOUND via
countDivergence — the row records the bound and the honest count as-built.
- **SPEC-0005 §3.3** (`d973408`, §12): the upload allowed-types whitelist
reduction ledgered with the verified pin cites (services/attachment/
attachment.go:59,78; the reviewer's pre-restructure cite recorded alongside).
- **SPEC-0012 §4.5 referenced** (`86b5aee`, §12): the actions emitter's
inline posture rides the SPEC's bounded-posture rule (no SPEC edit).
- **MIGRATION 0061_aromatic_meggan** (`7f2ecd3`, the house migration
treatment): exactly TWO statements —
`ALTER TABLE repo_transfer ADD team_ids text DEFAULT '[]' NOT NULL` (the
house JSON convention over upstream's `RepoTransfer.TeamIDs []int64` slice,
transfer.go — verified at :72) and
`ALTER TABLE repositories ADD num_closed_milestones integer DEFAULT 0 NOT
NULL` (the M4 counter) — journal single-entry, the snapshot programmatically
column-diffed against 0060 (only the two columns, nothing stray), LOCAL
applied; the REMOTE application is the orchestrator's at convergence.

## 16. Deferred and pending (as of this draft)

**Pending-fill markers for the convergence**: ⑥=LANDED (`7d91ccd` — the
index.ts bundle's seven arms all in, ⑥'s named follow-ups included; the
flip was authorized on V1's landing) and ⑪=LANDED (in two parts: the A1–A4
actions material via U14 `86b5aee`, §12; the A5–A9 avatar/attachment batch
via U15 `d973408`, §12). No pending markers remain.
**The in-flight units all landed**: ⑨ in three parts (the API findings
`7b4ccfc`, §11; the settings danger zone `6b7b517`, §8; the P1 org/team
membership web arms `9b45d68`, §11), U10's type-7 accommodation (`9d72592`,
§9), U8's whole-wiki delete arm + the N4 sweep (`8b46159`, §8), the
migration-gated O3/O4 at `7f2ecd3` (§8), U14's claim residual and V2's two
attributed findings at U21 (`16ca6c9`, §12/§8), and U13's carrier at V1
(`7d91ccd`, below).

**V1's index.ts bundle — all seven arms** (`7d91ccd`, the U13 salvage, the
dead unit's work structurally complete with 13 drifted cites repaired):
(1 P2) POST `/user/settings/update_preferences` claimed+registered
(Go-strict JSON decode — non-object/wrong-typed 400 `json decode failed\n`
in the http.Error trailing-newline shape, missing field Go-zero false, null
decodes clean) persisting code_view.show_file_tree to user_settings_kv
(setting_options.go:19) + the file-tree toggle pair rendered verbatim
(view_file_tree.tmpl:3-7 hide + the toggle_button show, locale 2645-2646,
repo-view-file-tree.ts:22-24's POST contract; both sidebar icons
allowlisted + generated, 80 icons); the KV read-back feed needs render.tsx —
REPORTED not done, documented in both headers. (2) the bare-spelling editor
aliases `_new|_edit|_delete|_upload|_diffpatch` parse to the SAME families
(web.go:1453-1465, the dead unit's two off-by-one cites repaired) with
GET+POST registrations; file-editor.tsx's divergence note updated. (3) the
org heatmap twins (the 6/7-segment claim, the org-dashboard prologue
verbatim, writeHeatmapJSON's {heatmapData, totalContributions} wire shape;
3 cites repaired incl. OnlyPerformedBy :59; the aggregation-scope deviation
honest and stands). (4) the delete redirect override — action=delete 303s to
`/` (user) or `/org/{name}/dashboard` (DashboardLink, user.go:327-332; cite
repaired :980); delete-wiki KEEPS the settings redirect (setting.go:1002
verified). (5) the doer threading FOLDED with U8's env tail:
applyRepoBasics(c.env.DB, repo, form, doer, c.env) — the delete-wiki arm's
fail-closed wire gap from `8b46159` is CLOSED (pins doerId = the session
user). (6) POST `/-/admin/repos/delete` claimed+registered (the
admin-emails-delete shape; 7 web.go:834 cites repaired to :851) + the Op
column's per-row trash form (list.tmpl:82-87, colCount 10→11; the
missing-id stale-form posture disclosed). (7) the attachments POST-class
405 twin (POST/PUT/DELETE/PATCH → 405 allow: GET, OPTIONS, web.go:912;
U15's hunks untouched). GOLDENS: V1's three byte-identical at HEAD
(render-genuine); the two audit goldens rode V3's `6f1008b` as planned.
A PRE-EXISTING TRIO RED (worktree-proven at clean HEAD: pull-review-signed-in
/ org-team-detail / settings-team-admin — stale vs landed-never-regenerated
features, U1's family) — dispatched to the regen unit (below). HANDOFFS
dispatched: the battery's fw-danger-delete-303 pin flip (this landing arms
it — §14); settings.tsx's now-satisfied follow-up docs; owner-heatmap cite
drifts. Gates, orchestrator re-verified solo: index 328/328 (the
update_preferences battery, heatmap twins, aliases, danger threading +
admin delete battery), file-editor.matrix 19/19, admin-repos.matrix 15/15,
editor-tails 35 + attachments 47 + a11y 91 + shell/render/
header-actions/migrating 92 per report; typecheck tree-zero; gen-icons 80
exit 0; scoped eslint clean over 16 files.

**Dispatched, not landed at this draft**:
- **U21's attributed findings for trigger.ts's owner** (`16ca6c9`, §12):
  the RUNNING(6)/CANCELLING(8) omission in
  toCommitStatus/toCommitStatusDescription (the claim post is the first
  RUNNING caller; the cancel arms posting CANCELLING hit the same gap), and
  trigger.ts:2024's targetUrl double-slash under appUrlOf's
  origin+trailing-slash.
- **V1's handoffs** (`7d91ccd`): the battery pin flip (armed — §14),
  settings.tsx's follow-up docs, the owner-heatmap cite drifts, and the
  pre-existing golden trio's regeneration.
- **V4's two open notes** (§13): the non-merge single-mail .patch's missing
  final trailing newline (one byte); routes/commits.ts's compare .patch
  still rendering merges with the old single-mail shape.

**The ⑫ D-ledger**: D1, D3, D9, D10, D11 landed with V4 (`326904e`) and
D4–D8 landed with V5 (`8994488`) — §13; **D2 and D12 remain pending**.

**Resolved this window** (promoted out of the last draft's list):
- **M4** the num_closed_milestones column + the state-flip recount — landed
  (`7f2ecd3`, §9; migration 0061 — §15).
- **O3/O4** the transfer team_ids + org-accept arms (the 0061-gated ⑨
  residuals) — landed (`7f2ecd3`, §8).
- **The wiki-family quirk** (the slashed-title 500-after-create, ledgered at
  `8b46159`) — landed (`6f1008b`, §8).
- **The audit-enum wiki arm** (`8b46159`'s dispatched follow-up) — landed
  (`6f1008b`, §8).
- **D6's ride on V4** (`8994488`'s named dependency) — complete: V4 landed
  git-models.ts's toChangedFiles and the route-side consumption was already
  committed (`326904e`).
- **The index.ts follow-up bundle's members** — ALL landed at `7d91ccd`
  (above): ⑥'s update_preferences / bare-spelling aliases / org-heatmap
  twins, U4's three blocked arms (the delete redirect override, the doer
  threading, the admin-repos delete registration — §8), the
  POST-attachments 405 residual (`14ba724`, §9), and delete-wiki's env
  threading (the fail-closed wire gap closed).
- **U14's claim residual** (the claim-path status post, task.go:113-121) —
  landed at U21 (`16ca6c9`, §12).
- **V2's two attributed findings** — landed at U21 (`16ca6c9`, §8).

- **S10 LANDED** (`452984c`): all five named residuals closed — the webauthn
  dual-clear (§4), the limiter verdict (§4), acl's decideDeployKey archived
  ordering (§5), the packages.ts 422 declarations (§7), and the engine comment
  (§7); SPEC-0022 §6 rewritten as-built (§15).
- **S13 LANDED** (`de5efaf`): the cancel-pin flip, the ancestor-PR API 405 arm
  (§3), and the 201-declaration note (§15) — all three arms in.
- **S15 LANDED** (`40d0a6c`): S13's ordering residue closed — the state arm
  hoisted before the deps gate (§3), MUTATION-PROVEN; S12's deferred README
  annotation landed with it (the battery's PAT expect-string and the README
  state the churn root-cause is FIXED — §14).
- **Resolved without code, kept as records**:
  - **L4 skipped-with-pin-evidence** (`c3ac813`): upstream's
    mustEnableIssuesOrPulls closes only the /issues subtree — the /labels and
    /milestones groups are siblings outside it and carry no unit check in
    repo/label.go + repo/milestone.go: upstream SERVES label/milestone APIs on
    tracker-disabled repos, so wrapping ours would diverge (the
    Upstream-Parity Decision Rule); evidence recorded in both module headers.
  - **N5 refuted at the pin** (`c273341`): the transition-pinned CommentID is
    real (notification.go:176-196) but the REST serializer never renders it —
    GetLastComment is the newest CommentType.Comment (issue.go:470-483); our
    fillLastCommentIds already matches.
  - **N2 retired** (`c273341`): both recipient arms implemented (§10).
- **The standing-PAT re-baseline**: the six stale retry rows swept and the
  count re-baselined at convergence via `--expect-tokens` (`8e5c4ea` /
  `d3f8211`; the root-cause annotation landed at `40d0a6c`).
- **The squash-message-body prefill reduction**: needs a commit-list seam —
  the documented SPEC-0005 reduction (`b5b1994`).
- **The bare `_cherrypick` divergence** stays as recorded, in narrowed form:
  the bare EDITOR spellings are now ALIASED to the same families
  (`7d91ccd`), but the bare `/cherrypick/{sha}` FORM action remains
  engine-owned (`2deece6`'s mount-level 404 pin; the four intentional
  bare-literal test pins enumerated at `16b30bb`).

**Process records for the next wave**: the salvage protocol has now run
TWICE — hunk-by-hunk attribution FIRST (1171 lines carried whole across the
first restart, S5's complete-as-found AEAD conversion kept rather than
rewritten; the second wave's landed salvages kept the dead units' hunks
essentially whole against their own reports — V1's "structurally complete,
13 drifted cites repaired" the standing example), the transient tsc baseline
attributed hunk-by-hunk to its owner before any commit cites "tree-zero",
and every known-red and attributed finding dispatched IMMEDIATELY (S1 → S7 →
S9; S2's known-red healed at `de5efaf`; S13's residue at `40d0a6c`; V2's two
findings to U21, which landed them same-window; V4's two open notes;
U21's own attributed findings re-dispatched to trigger.ts's owner). The
second wave added two disciplines: the dead units' cross-unit dependencies
were named in their reports and folded into the RIGHT landing (V3's audit
goldens; V5's D6-rides-V4), and V4's real-git re-verification caught a FALSE
verification claim in a dead unit's report (D10's honor note, §13 — the
salvage verifies the dead sibling's CLAIMS, not just its hunks). The
orchestrator's solo re-verify discipline held on all thirty-two landings.
