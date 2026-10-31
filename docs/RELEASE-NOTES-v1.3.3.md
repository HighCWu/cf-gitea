# cf-gitea v1.3.3 — Release Notes (the parity-convergence wave)

**Range**: `a454bf7..cc40bf6` — **84 commits**, landed 2026-10-31 (the
v1.3.2 freeze `88a04cb` deployed `f22b7bfe`; this wave's base `a454bf7` is
the v1.3.2 notes' FINAL_HEAD). Deployed as **`5a6a6118`** with migrations
**0049–0057** applied remote; the probe battery adjudicated **197/199 then 10/10**
(the two first-run fails were the audit's own stale count expectations — the
battery's runs leave two standing repos/four tokens, the adjusted audit
clean 10/10).

The wave's shape, in one paragraph: **the gap-fill convergence** — the
package registry completed to the pin's FULL 21-protocol surface, the M3
Actions tier finished to its last staged row (the matrix model), the four
"unfillable" classifications were re-adjudicated and three of them built
(email in and out, watch modes, mentions), and the two big v1.4 headliners
(OAuth2 Provider, external auth sources) had their SPECs ratified and their
substrates landed. Seven 1308 quota-death waves were absorbed; salvage and
revert discipline held throughout.

## 1. The package registry: 11 → 21 protocols (parity with the pin)

- **The protocol wave `5721dcc`** — go (a REAL `go mod download` round-trip
  incl. pseudo-versions and client-side go.sum dirhash parity), cargo (the
  sparse index derived from the DB at request time — upstream's own
  repo-absent posture; a REAL `cargo fetch` build accepted our cksum; the
  bare-token publish wall recorded as upstream-parity), swift (RFC 7807
  problem+json; hashicorp/go-version ported and verified against the real
  library), rubygems (**the pin correction**: `metadata.gz` is gzipped YAML
  with `!ruby/object` tags — Marshal is encoder-only at the pin; upstream's
  own byte-vector oracles green). The four-tenant shared-file discipline
  held through `packages-protocols.ts`.
- **The six-minor wave `28a40b5`** — chef, composer, conan (the ~30-arm v1+v2
  revisions protocol), cran, pub, vagrant: the registry carries **21
  protocols = the pin's full set**. Upstream's own `cran.rvserion` key typo
  preserved verbatim.
- **The cleanup rebuild rider `df868d2`** (all four distro families post-loop,
  `cleanup.go:122-147`) + the cargo per-package rider + the sweep twin's
  unification (`RULE_VERSIONS_CAP` retired — the pin's cleanup is unbounded).
- **Two batteries**: `packages-distro` `1af2ae3` and `packages-protocols`
  `d721f6e` + `packages-minor` `822731a` — 17 batteries / 199 probes, incl.
  real go/cargo client arms. The battery caught two real route bugs the
  service-face suites couldn't (the composer p2 Hono folded-label 404-for-
  every-project `94800e1`; chef's items-default) — fixed with route-level
  regression suites.
- `searchVersions` grew upstream's `packageId` option + the paginator fork
  (`120664b`); P3-3's preview reduction retired.

## 2. Actions: M3 finished — the whole SPEC-0012 §D tier map is as-built

- **S `667d349`** — the actionslib syntax layer (185/185; a Go differential
  harness compiled the pinned sources and proved both engines identical,
  error strings byte-for-byte).
- **E `240d67d`** — the evaluator core (1415/1415: the GitHub
  actions-languageservices corpus 1020/1020 — upstream's own gate count —
  plus 394 Go test-table rows).
- **P `0e9b0c1`** — the trigger chain whole (upstream's 62-row
  workflowpattern vector ported row-for-row; a LIVE receive-pack e2e).
- **Call-sites `6cdc698`** — run-name interpolation, the job `if:` gate with
  verbatim invalid-if summaries, workflow-level concurrency incl. the cancel
  arms, `repo_counters.run_index` CAS (migration 0050).
- **The matrix `e7755a4`** — M3's last row: the YAML workflow model port
  (static combos at insert, deferred expansion over needs, job-level
  concurrency), `EvaluateYamlNode` closed.
- **The seam repair** — a mid-flight collision was resolved by the repair
  unit going read-only during its sibling's live edits, then wiring exactly
  the static-validation→invalid-workflow seam (rode `0e9b0c1`).
- Scoped workflows: page layer `9fb8ffd` + store wave `630a6da` (migration
  0051; the surface live end-to-end).
- CAS handoff wave `4870ccb`: all sibling inserters onto `nextRunIndex`;
  rerun's expression-bearing fill wired `8777f7e`.

## 3. Email — both directions

- **Outbound slices 1–5** (`251e0ee`, `b023a85`, `8f800b6`, `25a0e07`,
  `b4f8511`): the HTTP-relay transport decision (the send_email binding
  rejected with evidence), the REPO_TASKS-backed outbox (migration 0049),
  the notify hub with upstream's recipient resolution, seven arms landed
  (comment, new-issue, close/reopen, PR-create, ready-for-review, assigned).
- **Mentions `b4f8511`** — the parser (pin-corrected into the references
  package), team-mention resolution, the onmention lift closing slice-2's
  reduction.
- **Inbound `7191b37`** + the outbound token carriers `020ca54` (migration
  0054): reply-by-mail end-to-end — the HMAC token family split (an
  unsubscribe token can never decode as a reply), MIME bounded extraction,
  the closure proven (a reply to the minted Reply-To creates the comment).

## 4. The re-adjudicated "unfillable" list

- **Watch modes `899db32` + tails `2546bb5`** (migration 0053): the pin's
  five-mode model (Dont/Auto/Custom live with per-type includes), the mail
  resolver mode-aware, four consumer sites fixed.
- **`email_hash` `45e95f9`** (migration 0055): the pin's avatars-package
  lifecycle + the `/avatar/{hash}` resolution.
- **`/assets` fallback target `6902d6f`**: upstream's bare-404/405/preflight
  answers for asset misses (the dispatcher carve).
- **Federation Tier A `d3669b2`**: the honest census — upstream RETRACTED
  activitypub at the pin (`1592576fa5`); the discovery tier + 501 stubs
  landed fail-closed (Tier B staged on product ownership).
- SSH inbound remains the one true platform exclusion (ADR-0001).

## 5. The v1.4 headliners' substrates

- **OAuth2 Provider**: SPEC ratified `78e5f68`; **W1 `ed52dd5`** (migration
  0052: the JWS family zero-dep verified against RFC 7515's fixed vector,
  the grants store with DELETE-rowcount one-time semantics, the five
  builtin applications seeded).
- **External auth sources**: SPEC-0018 re-opened `c750be5` with grounded
  per-type verdicts (LDAP viable-but-deferred on the private-address block;
  PAM/SSPI permanently impossible); **W1 `85d094b`** (migration 0056: the
  login_source/external_login_user tables, the strict cfg-codec, the
  17-entry provider registry).

## 6. Engine

- **attr-macro `599d655`** — P2-8's boundary decision (the matcher is
  engine-side, git's own design) + the macro machinery empirically pinned
  against stock git 2.43.0, gated by a real-git differential check
  (24/24, mutation-checked both ways). Premise correction recorded: the
  board's "engine-side future arm" citation was wrong.
- **P3-4 verified resolved-before-dispatch** `89c5923` (D3's fix + the
  fault-matrix pins all pre-dated the wave; 30/30 e2e family re-verified).
- **P3-2(c) `11f07e2`** — the stored-object writer clocks (mergePerson's
  second wall-read collapsed into the flow clock).

## 7. Process record

Seven 1308 waves; the completion loop held. Notable: the migration-parity
emergency `a067f9e` (a directory-form `git add` swept flying units' meta
snapshots without their SQL — repaired within the minute; the explicit-file
list rule reinforced); one pipe-masked guard on the orchestrator's own
chain (`94800e1`'s type error landed; `b2153bb` the fix and the lesson);
the goldens battery caught the scoped-nav miss (`4c09e09`, 21 files pure
insertions) and the composite gate caught the M3 trigger's object-cache
pollution of the invariants fixtures (`c777523` — the fix rides the
trigger's own upstream unit gate).

## 8. Suites (the freeze gate)

The composite full-suite gate (`--solo`) adjudicated green at the frozen
tree (407/412 in-suite; every residue file solo-green ×2 under the
co-running pool — the ADR-0006 flake precedent, documented); CI green on
the range's test-fix tail (`4d25d9c`, and every commit after `f8630e7`);
the 17-battery probe battery + cleanup-audit against
the deployment — **197/199 → 10/10** (the two first-run fails were the audit's own stale count expectations; the adjusted audit clean).

## 9. The release tail (landed after the freeze fill)

- **github + google provider clients `470ffc9`** (external-auth W3) —
  the factory's simple arms at both legs, the NUMERIC-id pin correction,
  my route fold.
- **OAuth2 W4 `18b78a8` SALVAGED** — the discovery doc, the
  OAUTH2_ENABLED gate wraps, the git-HTTP realm flip
  (`Basic realm="Gitea"` when the provider is on — the GCM builtin flow),
  the audit row, the algorithm/issuer plumbing.
- **External auth W4 `77dfccb` SALVAGED** — the admin auths CRUD + the
  login-page source buttons: OIDC + github + google live end-to-end.
- **The deploy-blocker fix `cc40bf6`** — vite's rolldown chunking spread
  drizzle's internal graph across startup chunks (deploy-bisected to the
  six-minor wave's import volume; invisible to every workerd test); the
  single-chunk pin unblocked the deploy.
- Both W4 units died to the eighth 1308 wave AFTER completing; both
  salvaged whole (the third and fourth posthumous landings today).
