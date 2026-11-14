# cf-gitea v1.5.9 — Release Notes (the census closes)

**Range**: `8b833f0..8fd4010` — **37 commits** across 2026-11-13 and 11-14,
dispatched on demand after the v1.5.8 freeze's quiet week — the wave that
closes the census at 17/17, drains the B-board's open rows to the three
feature lanes, runs every handoff to its landing, and lands three
platform discoveries into the record.

Deployed as version **`354fd57f-bbf5-4f89-bdee-afe3bea8e6c4`**. Migrations
**0078-0079** remote-applied FIRST (freeze preflight 2026-11-14: both
PENDING remote application — the freeze chain applies them) (0078 — the
TABLEMISS batch: issue_labels
rebuilt with the surrogate id pk, issue_pins rebuilt at upstream struct
order with is_pull, pull_requests.type + changed_protected_files,
package_blob_uploads.hash_state_bytes; 0079 — the team_invites block:
token UNIQUE, the (team_id,email) composite, org/team FK-cascades, the
inviter deliberately FK-less). Composite gate **PASS on the release
tree**: 508 files in phase 1 (505 pass, 2 load-timeout files + 1 assertion
file — all three solo-adjudicated GREEN), every file green across 6 phases
(513 file-runs total, 585s wall; 8 vitest-worker teardown races downgraded
to note per the composite-gate protocol). The gate's first run caught THREE
real reds — all fixed in-wave: two stale-pin families the 11-13 landings
outdated without their batteries re-run (debian's retired MD5/xz-control
reductions incl. the quota-salvage count miscount, and ADMIN88's CTA-fold
heading), and the B-47 walk x invariants interaction (INVFIX: the walk
breached the engine's skipCacheWrite discipline + the workerd DO-RPC
double-report, fixed by the PackLostError null-shape degradation in the
engine). One deploy-blocker caught by the freeze chain itself: the
account-local wrangler.jsonc carried the APP_URL PLACEHOLDER (a residue of
the B87 config rebuild — only the d1 id had been restored); restored,
rebuilt, redeployed before the probe battery. PROBE BATTERY: the first full sweep
(202 probes, 20 batteries) recorded 16 fails + 7 platform warns — ALL 16
traced to a transient network patch between the host and Cloudflare (fetch
failed / gnutls classes, cascading 404s from one fetch-failed repo create);
the six affected batteries re-ran ALL GREEN (0 fails), the mon-qset family
stays the recorded platform-warn class, and the two pre-known cleanup-audit
residues were swept (2 probe-era protected_branches rows + 3 non-standing
action rows; the standing fixture trio restored). The per-run probe PAT was
minted before the battery and SWEPT after (row deleted, table verified
empty, token files shredded).

## The census closes at 17/17

The three doc landings completed the 16-module pass: CENSUS-M15's modules
1+5 (INSTALL 9 rows IN1-IN9; ORGS+TEAMS 22 rows OR1-OR14/TM1-TM8), then
CENSUS-M16's final two modules (API-V1 OVERALL 12 rows MS1-MS12 +
FEDERATION 8 rows FD1-FD8 — with the honest arithmetic correction that
module 3 was still the census's sole remaining unit), then CENSUS-M3FINAL
closed the pass: module 3 (the auth password matrix, §20) graded 16 rows +
1 docs-defect — aligned 9, platform-adapted 2, split 3, deferred-reopened
2 — with the Phase-B platform truths graded inside the matrix and the
board renumbered to B-11..B-88 (78 rows: 17 rule-4 + 56 deferrals + 5
splits). PW17's docs-defect (three stale admin-user-edit docstring blocks)
was fixed in the same wave by ADMIN88. §2 + §22 now stamp **17/17
COMPLETE**; §21's table is the census's output contract — the remaining
open set, not a defect list. The wave's census docs-debt closed too
(CENSUSDOC 133ed08, docs-only): B-58's board/module flips — claimed by
PKGTAILS2's code landing but never landed in the census file — finally
landed at all three stale spots (the module-12 header, §12's PK8 row,
§21's board row, with the pin tallies xz 16/16 + debian 23 + conan 23);
B-37 stamped done-by-fold (module 3's PW6); and §21 gained the
graduation-protocol paragraph — the release record IS the closure
evidence for the stamp-less B-11..B-45 rows, whose honest pre-edit count
is 31 (the earlier '~16' estimate undercounted; per-row stamps
deliberately NOT fabricated) — plus three same-class module-header
riders (module-14's B-65/B-66, module-15's B-67..B-72, module-16's
B-78/B-80/B-81 all flipped LANDED).

## The migration-target zero (TABLEMISS3/4)

The drift-migration backlog closed at **zero open migration targets**
(6 → 0; Reconciliation 4: 29 → 23 tables — 8 MISSING all recorded-absent,
4 RENAME, 4 ours-extra, 7 type). ONE migration (0078, six columns +
PRType) carried the whole batch: both table rebuilds' copy legs
hand-corrected per the 0066/0077 precedent ('id' omitted from the legs;
the generated is_pull literal replaced with a LEFTJOIN-issues COALESCE
backfill), proven by the legacy-rows simulation plus a dropped-scratch
full-chain re-apply. A salvage rollback mid-unit became the seed proof:
the predecessor's un-migrated schema broke 13 seed spots across 11 files,
every seed now carrying its carrier's true discriminator — including two
RAW-SQL inserts the typecheck could not catch. The granted writer leg
(insertIssuePin's isPull) landed with it. B-77's team-invite lane brought
0079; B-72's bot axis confirmed the chain stays there (a TYPE value, no
schema change).

## The B-board's mass landing (28 rows)

**The v1.5.8 open list drained to the feature lanes**: B-58 — the codec/digest
tails resumed from the week-old park (the LZMA2 xz decoder finished, the
Packages.xz store-then-serve encoder, the RFC-1321 MD5 hand build, the
debian/conan service arms); B-59 — the per-unit org-team packages grant
read seam (the "columns migration" framing was a misnomer — the read was
the whole parity); B-61 — webhook provider requesters, the last
wire-visible divergence (`matrix` joins the enum, all nine per-type
formats goldened from upstream's own test files); B-65 COMPLETE — the
three emit-site wirings + the repository-source thread API leg across the
quota kill; B-66 — the SMTP transport arm over real sockets (see the
platform discoveries); B-67 + B-69 — the admin packages write tails and
SendTestMail at upstream's true home (the CONFIG page — the derive at the
pin corrected the placement); B-70 closed by verification, not
re-implementation (the mounts had ridden an earlier fold; the "parked"
messages lagged their trees); B-71 — the admin user↔org removal arms on
the user-detail page; B-73/B-74 — the user:create audit row + /api/healthz
at upstream's path and byte shape; B-76 — team feeds re-landed with the
id-model crux resolved STALE (the action store's repo_id was already
TEXT); B-77 — the team-invite lane, WEB-ONLY upstream, accept-only
redeem, token-is-authority; B-78 — the unknown-path 404 bytes
('404 page not found\n', one tree-wide root registration); B-80 — the API
docs surface (the swagger/openapi3 serves re-based BYTE-EXACT to the
vendored sources, superseding the generated-registry divergence); B-81 —
the attachment allow-list enforced on all four write arms over the landed
Verify port; B-75/B-73's audit-emit residues closed by AUDIT-REC
(repository-delete rides the delete batch; install emits UserCreate;
external-auth derived ABSENT-SURFACE — upstream's OAuth2 source carries no
UserCreate emit at the pin). B-79 — POST /markup's FilePath file mode
dispatches by extension, the RULE-4 silent-ignore closed: markdown-family
extensions (.md/.markdown/.mdown/.mkd/.livemd) render under the landed
file policy, unknown extensions answer the DERIVED 422 "unable to find a
render" (upstream's filename-detection-first order at the pin; extraction
to a markup registry service is the recorded next-wave note when
csv/orgmode/jupyter land) — 8fd4010, the wave's last commit.

**The Phase-C password family** (module 3's splits, all landed): B-82 —
the must-change gate's un-gated surfaces (the oauth2-authorize dance, with
the exact upstream set derived); B-83 — the reset wrong-user refusal
(no-op before the TOTP consume, proven); B-84 — the forgot-REQUEST arm
with the anti-enumeration byte-identity pinned (both branches render
identical bodies); B-85 — the pbkdf2_hi production cap at parse time
(100k; local derives above it, so the refusal is parse-time by a live
asymmetry proof); B-86 — the argon2id + bcrypt VERIFY arms over statically
imported .wasm modules (verify-only; scrypt stands platform-impossible);
B-87 — Phase C's six knobs (the Basic gate's anonymous-proceed OFF arm,
the login form gate, the REAL HIBP PASSWORD_CHECK_PWN arm) plus the
default correction (see the platform discoveries); B-88 — the admin web
user-create page with its own re-render ladder and the CTA fold.

**The L-lanes' first**: B-53 — block_on_codeowner_reviews + the
protected-file merge gates (the CODEOWNERS parser at the pin's discovery
order, the HasAllRequiredCodeownerReviews gate, the protected-file glob
arm, wired into the merge-time walk; the one recorded adaptation: workerd
has no per-match regex timeout — a static safety screen drops
nested-quantifier patterns fail-open per-pattern while the aggregate
2s budget stays fail-closed). B53R2 then closed B-53's remainders
(2)+(3)+(5) (daa5133): the PR-create auto codeowner review arm ported
arm-for-arm (WIP skip, fork-none, base-tip-miss/oversize 500, contain()
over latest-per-reviewer rows, the CODEOWNERS special-doer comments, the
review_request webhook before opened), the merge-box blocker items render
(blocked_by_codeowners + the protected-files blockers), and the settings
page renders and round-trips the protected/unprotected-file patterns plus
the block_on_codeowner_reviews toggle (an edit POST omitting rendered
fields CLEARS them); the push-side file-pattern family rides B52R2's
gate window and the \p{...} u-flag note stands. B-72 — the UserTypeBot
axis (users.type
widens to 'bot'; the web create's bot branch skips the password ladder;
bots never password-authenticate, pinned behaviorally; the 11 union folds
attributed).

## The handoff discipline (HOFF-A / HOFF-B / HOFF-C / GLUE / AUDIT-REC / B75B / MOUNT70)

The wave operationalized the handoff protocol: B-82's two gate handoffs
closed by HOFF-A (the /login/oauth JSON group's doer resolution and the
git-HTTP ACL's flagged-doer arm on both carriers, with the LFS third
landed as the disclosed orchestrator rider; the one pin-fix disclosed —
the arm's 303 followed by SELF.fetch renders 200, so the pin gained
redirect:'manual'). B-87's four threading handoffs closed by HOFF-B (the
renderLoginPage knob on both call-sites plus the POST /login plain-text
403; the policy threading into change/reset; password.ts's configured-spec
as OPTIONAL PARAMS with the constants as the documented default arm; the
admin-create :392 ladder), and the remainder of THAT remainder closed by
SPEC-THREAD — every named call site (install, change-own, apply-reset,
the admin create/edit routes, the edit page, password-auth's rehash
target) now consumes the env-driven configured spec end-to-end — and the
route-glue halves themselves then LANDED by GLUE (e4212fe): middleware's
basicPasswordArm threads the configuredHashSpec reader, the git-HTTPS
chain gains the SHARED EnableBasicAuth knob (OFF ends the chain UNSIGNED
— the request proceeds anonymous, never the failed-credential challenge;
Basic-carried tokens verify before the gate and stay unaffected), POST
/login compares AND rewrites under the configured algo, ui/index's
change-own + apply-password-reset write arms and the adminUserEditSubmit
knobs twin thread their halves, and first-run's install caller threads
the spec with NO policy option (upstream's install validates only
non-empty+match). The route-level pins for those threads routed to GLUE2
(in flight at refresh). The Phase-C surface runs end-to-end. HOFF-C
landed B-72's
five handoffs — the bot axis runs end-to-end: the API edit arm converts
for real (the effective-admin guard, org targets 400 both directions,
the user:type:update emit), the web edit twin (the password field drops
and login_type hides for bots), the impersonate guard LIVE with its
locale, the notification recipient skip carrying the users.type gate on
both recipient exprs, and the admin list's Bot filter and label — with
the landing review's ui/index attribution claimed in-row (no history
surgery, both sides' notes stand). AUDIT-REC closed B-75's +
B-73's audit residues with the request-less callers keeping upstream's
nil-context shape (actor 0 named 'Unknown', origin 'system') and the
repo.ts rider threading every request arm. B75B closed B-75's residue
(b) in the home battery (8462ae7, battery-only): the per-repo
deleted-webhook emission (exactly one repository delivery per swept repo
at the ORG-level hook — pending state, pre-delete full_name render,
sender the doer — while the deleted repo's own repo-scoped hook stays
silent: the shared AFTER-cascade ordering deviation pinned) and the
partial-failure continue (one-repo rejection injected at the RepoService
delete seam — still 202, the doomed row survives, the sibling deletes,
exactly one console.error notice-analog naming org+repo+cause,
success-only audit semantics). MOUNT70's lesson is the
cheapest: B-70's resume unit verified region-by-region instead of
re-implementing — the mounts had already landed. The concurrent-fold rule
(hunk-attribution, both sides disclosed) held through B-67's ui/index
deferral to B-69's landing, B-87's attribution sweep, and B-72's 11
behavior-null union folds.

## The platform discoveries

1. **connect() sockets exist** (B-66R): the SPEC's "Workers cannot open
   outbound TCP" premise is FALSE on the current platform — workerd's
   cloudflare:sockets connect() opens real TCP to host-side listeners
   (miniflare's loopback connector). This enabled the deterministic
   conformance pattern: vitest globalSetup hosts strict SMTP stub
   listeners on ephemeral ports, provide/inject carries the ports into
   workerd — no external network, no DNS. Recorded with it: workerd's TLS
   verifier rejects ANY self-signed cert (no custom trust store), so the
   TLS ladder logic pins over a scripted dial seam while real-CA TLS was
   probe-verified (gmail:465, cloudflare:443). specs/email-outbound.md
   §1.1 corrected in the same commit.
2. **The wasm static shape** (B-86): workerd hard-blocks dynamic wasm;
   statically imported .wasm modules under CompiledWasm module rules are
   wrangler 4.153.0's DEFAULT for *.wasm (the example-file contingency
   never triggered). The trail's findings, now load-bearing:
   hash-wasm's WASMInterface must touch Hash_GetBuffer() once at
   instantiation or Hash_Calculate traps; the binaries are STATEFUL
   across calls on a shared instance (fresh-per-call instantiation); and
   under the vitest workerd, WebAssembly.instantiate(precompiled)
   resolves an EMPTY OBJECT — the synchronous new WebAssembly.Instance is
   the working path. B86's dist smoke through vite rides this release's
   build gate.
3. **The complexity default correction** (B-87, census-level): unset
   PASSWORD_COMPLEXITY means checking OFF upstream (security.go seeds
   ['off']) — the pre-B87 all-classes hardwire had mis-derived
   setupComplexity's INVALID-VALUES FALLBACK as the default. The default
   now matches upstream and the three landed weak-password arms re-pinned.
   The census's 'PASSWORD_CHECK_PWNED' name corrected too — upstream's
   key is PASSWORD_CHECK_PWN.

## After this freeze

The board's open set is the three feature lanes: **B-52** (agit
push-to-propose — in flight as B52R2, with B-53's push-side
file-pattern family riding its gate.ts window; the agit service sits
uncommitted in the tree at refresh) and the xref pair **B-46/B-47**
(the B46 writers unit dispatched and in flight; B-47 rides B-46's
scanner + the push tail window). Everything else is stamped — B-79
included (8fd4010); B-72's sole remainder is the bot-token tails (a
bot's only upstream auth path). In flight at refresh: B52R2 (the agit
lane), GLUE2 (GLUE's route-level pins), UPDAUDIT (opening the wider
UpdateUser column-audit family as census row B-89 — the
user:active/admin/restricted/visibility emits, unemitted tree-wide,
pre-existing), SMALLS4 (the two routed observations — B-84's
register_notify title family and B-77's inviteEmailValid twin), and
B46 (the xref writers). The census docs-debt closed in-wave (CENSUSDOC
133ed08 — see the census section). docs/compat/convergence-backlog.md
is re-issued as the authoritative hand-back. The 04:05 routine keeps
the lights on; units dispatch only on demand.
