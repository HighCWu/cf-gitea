# The convergence backlog (v1.5.9 freeze, 2026-11-14 — current through 8fd4010)

Supersedes the v1.5.8 freeze issue (2026-11-04). The v1.5.8 open list
drained to the three feature lanes in the 2026-11-13/14 wave (28 board
rows landed — B-79 the last, 8fd4010; the census closed at 17/17); this
document is the re-issued authoritative hand-back — everything below is
DESIGNED and RECORDED, nothing is lost, and each item names its resume
point.

## 1. The census's final state (17/17 COMPLETE — the census is closed)

All 16 mandate modules ran their pass: modules 1+5 (CENSUS-M15), 16+17
(CENSUS-M16, with the honest-arithmetic correction), and module 3 — the
auth password matrix, §20 — closed the census (CENSUS-M3FINAL: 16 graded
rows + 1 docs-defect, PW17 fixed in-wave by ADMIN88). The board stands at
**B-11..B-88** (78 rows) with 28 rows landed in this wave alone
(B-53, B-58, B-59, B-61, B-65, B-66, B-67, B-68, B-69, B-70, B-71, B-72,
B-73, B-74, B-75, B-76, B-77, B-78, B-79, B-80, B-81, B-82, B-83, B-84,
B-85, B-86, B-87, B-88). §21's table is now the census's output
contract: the open rows below ARE the compatibility backlog.

**Census docs-debt CLOSED (CENSUSDOC 133ed08, docs-only)**: B-58's three
stale spots fixed (§2's module-12 header, §12's PK8 row, §21's B-58
board row — stamped LANDED with the full derivation and the pin tallies
xz 16/16 + debian 23 + conan 23); B-37 stamped done-by-fold (module 3's
PW6). §21 gained the graduation-protocol paragraph: the release record
IS the closure evidence for the stamp-less rows, whose honest pre-edit
count is **31** (B-11..B-45 stragglers — the earlier '~16' estimate
undercounted; v1.5.7's note asserts "B-11..B-45 landed"; per-row stamps
deliberately NOT fabricated — the protocol graduates rows via graded
module rows). Three same-class module-header riders rode the same
commit: module-14's "B-65/B-66 re-open" and module-15's "B-67..B-72
re-open" and module-16's re-open clause all flipped LANDED (B-79 was
module-16's one open row at CENSUSDOC time — since landed, 8fd4010; its
census row flip rides UPDAUDIT's commit window, per that commit's
disclosure).

## 2. The open rows (the whole remaining board)

**NONE.** The 2026-11-14 wave drained the board to zero: B-52 (agit —
B52R2, 1846b7f + the engine-seam landing 4c7ca97), B-46 (the xref writers,
284c47b), B-47 (push-integrated closes, 83ce0ac), B-79 (8fd4010), and every
§3 hand-off closed in-wave (see git log 8462ae7..83ce0ac). What remains on
the rows is RECORDED optional tails, not open defects: B-52's type-29 push
comment / review-stale maintenance / StartPullRequestCheckImmediately;
B-46's comment arms (comment.go:920/:1204/:1234) + routes/pulls.ts origin
threading; B-47's ref-comment xref scan rides B-46's same remainder.

## 3. The hand-off queue (the wave's recorded remainders, each with its owner)

- **B-75's residue (b)** (ff42b41): CLOSED by B75B (8462ae7) — both
  unpinned bulk-sweep behaviors pinned in the admin-org-extras battery:
  the per-repo deleted-webhook emission (one repository delivery per
  swept repo at the ORG hook; the deleted repo's own hook silent) and
  the partial-failure continue (still 202, the doomed row survives, one
  notice-analog line, success-only audit semantics).
- **SPEC-THREAD's route-glue handoffs** (27fb508): CLOSED by GLUE
  (e4212fe) — every env->reader half now threads at the route layer
  (middleware.ts's basicPasswordArm; the git-HTTPS chain's SHARED
  EnableBasicAuth knob — OFF ends the chain UNSIGNED, the request
  proceeds anonymous; session.ts's POST /login; ui/index.ts's
  changeOwnPassword/applyPasswordReset/adminUserEditSubmit;
  first-run.ts's install caller, no policy option). The route-level
  PINS for those threads are GLUE2's dispatch — in flight.
- **B-53's precise remainders** (e722325, recorded on the row):
  (2)+(3)+(5) CLOSED by B53R2 (daa5133) — the PR-create auto codeowner
  review-request arm ported arm-for-arm (pull.go:253-310; the CODEOWNERS
  special-doer comments, the review_request webhook before opened), the
  ui merge-box blocker items render, and the settings page renders +
  round-trips the protected/unprotected-file patterns and the
  block_on_codeowner_reviews toggle (an edit POST omitting rendered
  fields CLEARS them). Remaining: (1) the push-side file-pattern family
  (hook_pre_receive.go:210-260) — rides B52R2's gate.ts window; (4) the
  `\p{...}` character-classes-without-u-flag dead-rule note — covered
  by B52R2's task-4 check.
- **B-72's remainder after HOFF-C** (bf6bdaa — the five handoffs LANDED:
  the API edit conversion, the web twin, the live impersonate guard, the
  notification recipient gate, the admin list filters): two opens — the
  bot-token tails (a bot's only upstream auth path — feature lane) and
  the wider UpdateUser column-audit family HOFF-C routed as a census
  row (user:active/admin/restricted/visibility emits unemitted
  tree-wide, pre-existing): UPDAUDIT is opening it as row **B-89** (in
  flight). The notification refusal's 403-vs-404 delta stays the
  established recorded model (in-test note only).
- **B-84's routed observation** (699e765): register_notify's title
  re-escape/DotEscape family — SMALLS4 in flight on it.
- **B-77's routed note** (df9e82c): the inviteEmailValid twin could
  unify with misc-t3's port — SMALLS4 in flight on it.

## 4. The standing cruft list (small, recorded, non-blocking)

- (CLOSED 2026-11-14, AUDITDOC) The audit doc's residual cite-convention
  debt (38 notes, M10-era): the flagged class lives in the webhook audit
  doc (`docs/compat/webhook-event-coverage.md`) — its pre-M10
  "Upstream emission" cells cited bare function names
  (`PushCommits:660→:668`) against the column header's implied
  notifier.go, plus three dangling `:NN` shorthand picks
  (`pull_request_comment`). All 24 flagged cells normalized to the
  post-M10 cite convention (one in-cell `services/webhook/notifier.go`
  anchor per cell, `:NN` shorthand after; word-diff verified 38 removed
  span pairs ↔ 38 added, all cite spans, zero claim-text movement), and
  all 54 cite-sites re-derived against the read-only pin fc493688 —
  every symbol present (zero [cite-verified-symbol-gone]), every
  function-start line EXACT, with two stale arm tails corrected
  (DeleteIssue's issues-arm `:341`→`:338` and PR-arm `:326`→`:320` —
  the pin's PrepareWebhooks calls sit at 338/320). The 38 figure was
  CENSUS-M14's census-corpus tally (2026-11-13; 40 at CENSUS-M10); the
  audit doc's own inventory today is 54 flagged sites (51 bare-function
  + 3 dangling shorthand) — post-M10 row rewrites moved the count in
  both directions since M10, and the checker's exact per-item list was
  never committed, so the delta is recorded honestly rather than
  force-matched.
- (CLOSED 2026-11-14, GOLDENS) The golden files WHWAVE2 flagged for
  their owning units (admin-hooks.html + the releases/tags set —
  DOM-consistent but un-rebaselined): the rebaseline actually landed in
  ff18a23 35 minutes after WHWAVE2's flag (WHWAVE2 itself regenerated
  ONLY settings-hook-detail.html — its print-mode run captured 1 of 97
  cases; ff18a23 then ran the full update-goldens.mjs over all nine
  flagged files). Re-verified byte-exact against the current tree
  (goldens.test.ts scoped run + a sentinel print-mode sweep with every
  render diffed against the committed bytes): all nine (admin-hooks,
  releases, releases-writer, release-detail, release-new,
  releases-feed.rss/.atom, tags-feed.rss/.atom) are IDENTICAL to the
  current DOM through the whole 11-13/14 landing wave, and a11y.test.ts's
  release-family consumption is green (91/91). Nothing to rebaseline; no
  lenient matching exists to mask staleness — the harness is byte-exact
  (goldens.test.ts's renderGoldenCase throws on the first differing
  byte).
- (CLOSED 2026-11-14, IDCHAIN-SEAMS — seam 1 in full; seam 2's owned
  boundary closed, its UI delivery leg ESCALATED below) IDCHAIN's two
  fidelity seams:
  (1) The test rig's `identityUserFromRow` (auth/testing/identities.ts) no
  longer hand-builds a 14-field `AuthUser` literal — it delegates to the
  PRODUCTION constructor (`rowToUser` → `authUserToApiUser`), so the rig
  resolves through the exact shape production's `resolveAuth` carries and
  the row→identity mapping cannot drift again (the old copy had already
  omitted `lastLoginAt` and — IDCHAIN's named gap — the `restricted` carry,
  making rig identities silently read non-restricted where production
  identities carried the flag). Pinned: identities.test.ts's restricted-row
  re-projection arm.
  (2) The UI-explore requester seam (api/services/search.ts) renders the
  flag at the owned boundary: `ExploreDoer` gained `restricted?` and the
  `searchExploreRepos` `Viewer.requester` construction now carries
  `restricted: doer.restricted === true`, so a doer that delivers the flag
  rides `searchRepositories`' restricted arc (repo_list.go:661-703
  composition) exactly like the API's `viewerOf` requesters. The restricted
  pin EXPOSED a second divergence in the same hand-built slice: it dropped
  `requester.id` — the grant arms' join key (`teamGrantCondition`/
  `collaboratorGrantCondition`/`publicInPrivateOrgCondition` all join on
  it, silently skipped via the `userId === undefined` guards) — so
  collaborator/team grants and the private-org-public arm were dead on the
  explore surface for EVERY signed-in doer; the close now renders
  `id: doer.id` too. Pinned: the filters battery's restricted describe
  (delivered flag drops limpub/pubinpriv through the explore surface while
  the granted rows survive; absent flag reads false, upstream's zero value
  — both polarities pinned).
  ESCALATED (the seam's delivery leg — outside the closing unit's ownership
  grant, recorded per the stop rule) — (CLOSED 2026-11-14, IDCHAIN-SEAM3)
  the UI session chain dropped `users.is_restricted` at every hop —
  `ui/session.ts`'s `SessionUser` (built at verifySession and
  lookupValidSession, both with the full row in hand), `ui/viewer.ts`'s
  `Viewer` user arm + `resolveViewer`, and `explore.tsx`'s `exploreDoer` —
  so a restricted session doer's /explore/repos read the NON-restricted
  composition and saw limited-owner-public / private-org-public rows
  upstream would hide (the leak polarity). CLOSED per the recorded recipe,
  additively: `SessionUser.restricted` (required, both construction sites
  render the row column), `Viewer.restricted?` riding ONLY when true (the
  `impersonatorUserId` conditional-spread precedent — unarmed viewers keep
  the exact pre-restricted shape, exact-shape consumers never see the key),
  and `exploreDoer` rendering `restricted: viewer.restricted === true` into
  `searchExploreRepos` (the c6b9763 receiving arm). Pins: the END-TO-END
  restricted-doer arm in explore.matrix.test.ts (a restricted session's
  real-cookie /explore/repos hides the limited-owner public and the member's
  private-org public while the own row and the non-restricted control's rows
  survive — the leak polarity's close, riding the filters battery's
  both-polarities service pin) and the session battery's carry pins
  (verifySession/lookupValidSession return the row flag; resolveViewer
  projects it only-when-true with the exact-shape negative). The filters
  battery's absent-flag=false arm remains the API-level both-polarity pin.
- The probe battery's blip-era fixture rows (the next cleanup-audit run
  sweeps them).

- (NEW 2026-11-14, GOLDENS — ESCALATED to the owning units, deliberately
  NOT rebaselined) Four goldens OUTSIDE the WHWAVE2 set are RED in the
  current tree (goldens.test.ts scoped: 4 failed | 93 passed) and will
  red the freeze's full-suite gate if they stay:
  (1) admin-monitor-cron.html + admin-monitor.test.tsx (5 its red) — a
  REAL module-graph regression, not DOM drift: HOFF-A (2634e67, 11-14)
  added git-http/acl.ts's import of mustChangePasswordArm from
  ui/session, closing the cycle cron-state -> demo-sweep -> mirror/sync
  -> git-http/gate -> git-http/acl -> ui/session -> ui/index ->
  ui/pages/admin-monitor -> cron-state; under it DEMO_SWEEP_CRON
  resolves undefined inside CRON_ARMS, so all TEN hourly-entry rows
  render empty Schedule/Next cells (the page battery's loader its fail
  on the same undefined). The fix is breaking the cycle (re-home the
  must-change-password probe out of ui/session, or re-point the acl
  arm's import); regenerating the golden alone would mask it. The
  committed sources of the page (admin-monitor.tsx, cron-state.ts,
  demo-sweep.ts) are unchanged since the golden was minted.
  (2) admin-users.html — intended DOM drift: ADMIN88's CTA header fold
  (565f814, the list.tmpl:6 Create User Account button + the
  flex-text-block header); regenerate by the admin-family owner.
  (3)+(4) org-settings-audit-logs.html + repo-settings-audit-logs.html
  — intended DOM drift: the audit-filter dropdown gained the post-11-04
  action registrations (user:create 76ac134/B-73;
  user:password:resetrequest 699e765/B-84; user:type bf6bdaa/HOFF-C;
  user:status:active/restricted/admin + user:visibility:update
  8e5e6c1/UPDAUDIT); regenerate by the audit-pages owner. These three
  are stale-but-loyal (the bytes faithfully record the landed DOM);
  only (1) masks nothing — it is the loud witness of the cycle.

(CLOSED since the v1.5.8 issue: the production PBKDF2-iteration-cap
probe — B-85 landed the parse-time 100k cap guard with the
real-Go-digest fixture row as its pin; the probe harness arm is moot.
And §1's census docs-debt — CENSUSDOC 133ed08 landed the B-58 flips,
the B-37 stamp, and the graduation protocol.)

## 5. The L-class feature lanes (ALL LANDED 2026-11-14)

B-52 agit push-to-propose (1846b7f/4c7ca97), B-46 the xref writers
(284c47b), B-47 the push-close scanner (83ce0ac). The census board
B-11..B-89 stands fully drained at the v1.5.9 freeze.

**The standing rule after this freeze**: the 04:05 routine keeps the
lights on (drift checks, the cleanup-audit); units dispatch only on
demand — the user's usage-driven reports are the trigger.
