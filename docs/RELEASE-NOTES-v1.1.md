# cf-gitea v1.1 — Release Notes

Snapshot 2026-10-26, HEAD `5ba6183` — the 2026-10-26 session (46 commits,
`9f92950`→`5ba6183`, 02:14–09:55 +0800): API batch 6 closes, the declared
surface crosses 88%, and the registry/lifecycle P1s close in code and in
production. Every number below is either re-measured from this tree this run
(marked **measured**) or anchored to the commit that recorded it. Production
evidence lives in `docs/design/p0-evidence.md`.

---

## 1. What v1.1 is

v1.0 froze a working forge; v1.1 fills the API toward the frozen contract's
feature wall and hardens storage lifecycle. The declared `/api/v1` surface
grew **385→490 of 554 operations (88.4%) across 298 of 350 paths** (measured
this run: `node scripts/check-openapi.mjs` PASS at `5ba6183`; tier-1 steady at
78/78 paths, 129/129 operations). The remaining 64 are FEATURE-ABSENT — they
need Gitea Actions or the package registry to exist first (§4). Per-batch
deltas are in §3.

### API surface landed this window

- **Project boards — batch 6 complete (64 ops, one store, three scopes)**.
  Repo scope 21 ops (`0d5b480`, REG `fc123b0`) over migration 0024's four
  tables with upstream's gate order 404→401→403→423→422; org scope 21
  (`cc6d73e`, REG `20512c0`) adding the orgAssignment 404/307 chain,
  `reqProjectsUnitAccess` 404-never-403 and owner-only workflows; user scope
  22 (`f38b218`, REG `c9a7ef7`) with doer-owned ids, reqToken-only writes and
  `GET /users/{username}/projects` visibility-filtered counts.
- **User/org blocks** — 8-op surface with cascade + exact upstream validation
  arms (`1934664`, migration 0022), then enforcement in two waves: 403 arms on
  9 seams — issue create/edit/comment, assignees, comment assets,
  collaborators, fork (`f5c0384`, `isUserBlockedBy` port + site-admin bypass)
  — and the 8-site tail: follow both directions, star, watch, reactions,
  transfer, pulls create + live PATCH-assignees, org-team add-member, and the
  receive-pack blocked-pusher gate with upstream's hook text verbatim
  (`f2e1710`). Production-verified surface codes at REDEPLOY10.
- **Push mirrors** — 5 ops CRUD + sync trigger on the mirror lane (`8f0aa90`,
  migration 0023). Production-verified CRUD cycle at REDEPLOY10.
- **Tag protections** — 5 ops CRUD + tag create/delete/push enforcement
  (`a80878c`, migration 0025). Production-verified: a non-whitelisted owner's
  protected-tag create answers 422 "user not allowed to create protected tag"
  verbatim (REDEPLOY10).
- **Wiki** — 6 ops over a sibling engine cell per `specs/wiki.md`, table-free
  (`d3362b1`). Production-verified create/read/list/404 arms at REDEPLOY10
  (one t+0 read 404'd and read fine at t+5 s — the documented §2.5.2 settle
  window, same class as pushes).
- **Git hooks** — 4 ops, degenerate sample surface + R2-persisted edits
  (`githooks/<repo_id>/<hook_name>`), table-free (`5b704c5`, REG `12ab90d`
  with 9 RUNTIME_ONLY gate entries). API surface; no production probe yet.
- **OAuth2 applications** — 5 CRUD ops, PBKDF2-SHA256 secret hashing + `gto_`
  tokens (`42ab6a5`, migration 0026); CRUD-only boundary recorded,
  authorize/token flow out of scope. Production-verified secret handling at
  REDEPLOY11: secret appears exactly once on create, zero times on list, blank
  on get; 422 "RedirectURIs: Required" on an update without uris; DELETE→404.
- **Admin badges, repo licenses endpoint, template generate** — admin badges
  ×3 + `repoGetLicenses` (detection glue, honest-empty until populated) +
  `generateRepo` over the extracted `replicateRepoCopy`; the repository
  payload surfaces `template` (`f328d06`, migration 0027). Production-verified
  at REDEPLOY11 with two open issues the same session then fixed in code
  (§2, §4).
- **Activity feeds** — SPEC-first `action` table (migration 0028) + 3 feed ops
  (`GET /repos|/orgs|/users …/activities/feeds`) with 10 action types wired at
  the emitter seams (`2ef9359`, `specs/activity-feeds.md`); the tail wave adds
  create/close/reopen/merge_pull_request + publish_release — **15 wired types
  total** — with merge discriminated by rendered payload and the assignee
  verdict pinned DO-NOT-WIRE (upstream's action enum 1–27 has no assign type)
  (`64ade9f`). Feed emission production-verified at REDEPLOY11
  (`comment_issue`/`create_issue`/`create_repo`, contract-exact row keys).
- **License detection** — verbatim `gitea/options/license` corpus (14 SPDX
  ids), LCS coverage 0.85 + specificity rules, onPush settle leg
  (`57429a5`); then three more population arms — mirror-sync, migrate-import,
  default-branch-create (rename arm deliberately not wired; upstream doesn't
  either) (`03d5fe4`); then the default-branch PATCH re-scan at the landed tip
  (`04a2903`) — the family is complete at **5/5 population arms**. Verified by
  the workerd E2E battery (push→row→`GET /licenses`); landed after the last
  deploy, so production verification rides REDEPLOY12.

### Storage and repo lifecycle

- **Registry rename-carry + delete purge** (`5e2c418`) — registry cells follow
  renames and die with the repo; closed the session-opening P1. Production:
  REDEPLOY10's three-lifecycle probe listed ALL refs on the new name
  immediately after rename in every trial; engine-level DELETE on a renamed
  repo answered 200 with both names dead at t+0.
- **The tombstone oracle** (`e30660d`) — closes the seconds-scale
  read-after-delete residual (the REDEPLOY10/11 open issue: stale refs served
  ~1 s, healed by t+5.4–6.4 s). Root cause: the vendored engine's per-isolate
  `infoMemo` (20 s TTL) memoizes a deleted repo's info; reads that find D1
  missing now consult the Registry fresh and answer the engine's byte-identical
  404. t+0 no-sleep tests; red proven by oracle-disable. In code, not yet
  production-verified (REDEPLOY12).
- **First-push settle generalized** (`45631b7`) — every empty repo, including
  API-created ones, clears `is_empty` and adopts the pushed default branch via
  the gate's own `waitUntil` settle (push.go:255-270
  `updateRepositoryForPush` semantics); the undo arm and created-webhook stay
  creating-only.
- **Repo size accounting** (`3c58cce`) — R2 prefix accounting
  (`repos/<key>/`, 500-page cap, degraded-never-throws) with settle legs at
  push/fork/generate; `repositories.size_kb` (migration 0029); the payload
  size TODO closes.
- **Star/watch counters** (`528d369`) — `num_stars`/`num_watches`
  (migration 0030) maintained in-edge-batch with NOT EXISTS/EXISTS guards and
  a floor of 0; the block-cascade counter audit fixed; payload renders the
  columns.
- **Generate robustness** (`7f0d5a6`) — one idempotent copy retry +
  upstream-parity `cleanupRepository` on failure (no stranded `creating`
  rows — closes REDEPLOY11 OPEN ISSUE 1) and the PATCH `template` write wired
  (closes OPEN ISSUE 2, making "mark a repo a template via API" reachable).
  In code after the last deploy; production verification rides REDEPLOY12.

### Web UI (server-rendered)

- **Avatar serving chain** — pixel-exact identicon port (28 block drawers,
  124 colors, indexed-PNG encoder), `/avatars/*` + `/avatar/{hash}` +
  `/user/avatar/{username}/{size}`, and the HashEmail→303 chain at frozen
  settings (`bb67087`); dispatched via a mount-before-uiRouter carve-out so
  avatar paths are never repo-scoped (`98d194d`).
- **ui-parity waves** — org members + `/-/repositories` (`06eee50`); the
  forks/stars/watchers trio + settings/collaboration panel with upstream
  refusal order and the `CanDoerManageOrgRepoCollaborator` port (`ca81d5a`);
  the engine-authoritative tags page + repo labels management with live
  writes (`0b61554`). The regenerated survey (`578857a`, at `99d21c5`) counts
  **36 LANDED / 4 PARTIAL / 69 ABSENT / 4 in-flight of 113** upstream
  page-bearing GETs; the two waves after it land those 4 in-flight rows plus
  tags and labels — **42 LANDED** (`docs/compat/ui-parity-survey.md`).

### Infrastructure and quality

- Vitest `testTimeout` 5s→20s — mass timeout flakes under >100-worker
  full-suite contention; three runs, zero real assertion failures; files pass
  solo (`412facc`).
- Invariants fixture fix with a bisect record — the license settle leg
  (`57429a5`) legitimately warmed the DO object cache, violating the fixture's
  cold-cache contract; bisected 9f92950→ca81d5a, first-bad `57429a5`; the
  engine is correct (no NOTICE entry); fix proven at first-bad, 3×
  determinism at HEAD (`fb8a0d1`).
- AGENTS.md pre-commit checklist item 6 — hunk-by-hunk diff review of
  multi-writer files after the foreign-hunk incident folded into `9f92950`
  (`205a23b`).

---

## 2. Production verification

Two full deploy windows shipped this session, each from a clean detached
worktree (the REDEPLOY10 methodology: the shared tree carries in-flight
siblings' uncommitted hunks, so GO deploys run from `git worktree add --detach`
at exactly the named commit — submodule untouched, worktree shredded after).

### Deploy lineage

| Version | When (UTC) | Tree | What it carried |
|---|---|---|---|
| `193cecc7-2b58-…` (previous window's v2, this window's baseline) | 2026-10-25 18:38 | `9f92950` clean | secrets/variables (23 ops, declared 362→385), migrations 0020/0021 remote |
| **REDEPLOY10** `5835d8ab-d65a-4824-a239-7d53c01f8627` | 2026-10-26 00:01 | `fc123b0` clean | declared **385→434**: blocks (0022), push-mirrors (0023), projects×4 (0024) + repo scope 21 ops, tag protections (0025), wiki, git-hooks, the registry P1 fix `5e2c418`; vitest 2951 passed / 5 skipped; smoke 6/0/1; migrations 0022–0025 remote (verified in `sqlite_master`) |
| **REDEPLOY11** `8d91c71d-3695-4d5f-a981-74d261c46b53` | 2026-10-26 00:34 | `fec5c71` clean | declared **434→447**: oauth2-apps (0026), badges/licenses/generate (0027), feeds (0028), the blocks-enforcement 403 arms, ui-parity-2 pages; vitest **3053 passed / 5 skipped**, 137 files + 1 skipped, 0 failed; smoke 6/0/1; migrations 0026–0028 remote (verified); P0 probes unchanged |
| REDEPLOY12 | **in flight at writing — not shipped** *(shipped after writing — `f9798804` @ `5ba6183`, see the addendum below)* | post-`5ba6183` | will carry the tombstone oracle, star/watch counters, repo size, the generate fixes, license detection, the feeds tail, and ui-parity-3/4 (migrations 0029/0030 already applied remote ahead of it) |

Migrations 0022–0030 are applied remote (0022–0025 via REDEPLOY10 and
0026–0028 via REDEPLOY11, both verified in the evidence blocks; 0029–0030
applied after the last evidence block, per the session record — their
evidence block ships with REDEPLOY12). 0031 is in flight, uncommitted (§4).
*(Superseded: 0031 and 0032 are committed and applied remote — see the
addendum below.)*

### Addendum — REDEPLOY12/13 shipped; the post-490 wave (appended 2026-10-26, wave-32)

The body of these notes was written mid-window and marked REDEPLOY12 "in
flight"; it pre-dated the entire post-490 wave. Both remaining deploy windows
have since shipped. This addendum brings the notes current without rewriting
them; evidence is verbatim in `docs/design/p0-evidence.md` (the REDEPLOY12
and REDEPLOY13 redeploy-verification blocks).

**REDEPLOY12 shipped** — `f9798804-b916-408e-9249-93ac030a1269` (100%,
2026-10-26 02:09 UTC) from tree `5ba6183` clean: the avatar serving chain,
the generate robustness fixes, ui-parity-4, star/watch counters (migration
0030), the invariants fixture fix, the license-detection family (5/5
population arms), the feeds tail, and the first-push settle generalization.
Production closed the **tombstone oracle** (read-after-delete at t+0, 3/3)
and PATCH-template persistence; migrations 0029/0030 applied remote (ledger
30/30). Two adjudicated file-level reds, neither code: the schema.test
column pin (second-order staleness, caught up at `5ba6183`) and the webhooks
delete-event scenario (RESOLVED-NOT-A-BUG — after settle generalization the
first-pushed branch IS the default and its delete is refused
upstream-identically; reshaped at `8207da9`). One finding carried forward:
the labels page's "New Label" form did not render for the repo owner in
production (resolved by REDEPLOY13, below).

**REDEPLOY13 shipped** — `64bee4f6-ccba-4f88-bf24-d0d26134dea4` (100%,
2026-10-26 04:25 UTC) from tree `e4ebb9d` clean: the post-REDEPLOY12 mass —
`6c54c1a` (generate/fork loose-carry from auto_init templates), `b332e14` +
`9bda9eb` (push-mirror outbound end-to-end, migration 0032), `389da18` (repo
delete sweeps action rows), `faca961`/`66f5977` (merge-delete guards ×3),
`7c7b683` (owner-view labels goldens), `79ef809` (diffpatch downloads),
`e4ebb9d` (vitest contention config — test-infra only, no prod effect),
`ca4eb58` (ui-parity-5), plus the counters wave (`3163658`, `3016c10`,
`207b566`, `64e9b1b` — migration 0031). Gates at the deploy tree: typecheck
0 errors; `check:api` PASS — declared surface **still 490 ops / 298 paths**
(the post-490 wave adds zero declared ops; the surface sits at the
pre-Actions/packages ceiling, §4); `check:contract` PASS (frozen sha
verbatim). Migrations **0031_conscious_snowbird**
(`repositories.num_forks`) and **0032_wealthy_siren**
(`push_mirrors.sync_state`/`next_sync_at`/`last_error`) applied remote —
ledger **33/33**, `pragma_table_info` verified. Smoke 5 pass / 0 fail /
1 skip (with `--migrate-check`), a second run 4/0/0; P0 shallow probes 3/3
unchanged. Vitest ran under heavy sibling load — two full runs (3044 passed/
5 skipped/1 failed and 2910/5/2, plus 15 and 17 files orphaned by workerd
pool crashes); every red or orphaned file re-ran SOLO all green — **18
files, 464/464, 0 failed** — pool instability, not code.

Production closures this deploy, verbatim from the evidence block:

- **Generate at the API layer** (`6c54c1a` verified; REDEPLOY12's 500 on the
  copy arm is closed): generate → **201** with `"empty":false` in the
  response body; both refs carried at the identical tip; the contents API
  serves LICENSE + README with `last_commit_sha` = the carried tip;
  `status='creating'` whole-table **0** — zero stranded rows. **One honest
  re-scoped residual (tracked open)**: the generated repo's git wire —
  `git fetch` 500s at the upload-pack fetch POST and `git push` is refused
`missing necessary objects`, while API reads serve the full closure. The
delta is the carry/adoption layout in the generated cell; owner:
repos/fork-task + the engine read path. *(Superseded: closed by `8828f43` —
the Worker-brokered §5.3 copy pass with an unconditional loose carry; see
Addendum 2.)*
- **The labels production finding — a methodology artifact, closed**: the
  PAT header never logs a session in (anonymous on pages, upstream parity).
  Via `POST /login` + the `gitea_session` cookie the owner view renders the
  writer form (0 vs 3 "New Label" occurrences, anonymous vs cookie), and the
  arm is byte-pinned by goldens minted through the real session path
  (`7c7b683`). **Login-cookie probes are the standard for page-level probes
  from now on.**
- **Push-mirror outbound lifecycle — first production verification**
  (`b332e14` + `9bda9eb`): the registration-time SSRF gate refuses a
  loopback target with 401 at the door; a gate-passing unreachable target
  registers 200, and within **~3 s** of the sync trigger the queue consumer
  ATTEMPTED it — `last_error` recorded verbatim ("mirror target responded
  530 for info/refs advertisement …", full URL), `sync_state` back to
  `idle`, `next_sync_at=0`; DELETE → 204, `push_mirrors` back to 0 rows.
- **The action-row sweep — zero hand-sweeps** (`389da18`): after five probe
  repo deletes, the `action` table totalled **0 with no manual sweep** — the
  faithful upstream arm is hard-delete (`delete.go:155-157` DeleteBeans; no
  `is_deleted=1` writer exists at the pin), closing REDEPLOY12's 21-row
  hand-sweep class and the open issue behind it.
- **Merge-delete guards ×3** (`faca961` default-branch head + `66f5977`
  shared-head-open-PR and protected-branch arms): the production spot proved
  the upstream skip-not-error differential — merging with
  `delete_branch_after_merge` into a protected branch: merge 200, branch
  still exists (200 after); unprotected branch: merge 200, branch deleted
  (404 after). Both merges 200.
- **Diffpatch downloads** (`79ef809`): `.diff`/`.patch` on commit and PR
  answer 200 `text/plain` with upstream's byte shapes (commit =
  mail-format-no-signature; PR = with-signature).

Landed in code after the deploy (ride the next deploy, not production
verified): **fork-head after-merge delete** (`2e3db28` — the full guard
ladder runs against the HEAD repo; the fork's own cell CAS-deletes; 25/25);
the **invariants fixture diet** (`3169e33` — sized to workerd's 4-chunk raw
LRU so a deletion target provably goes cold: 21→18 pushes, walk-test
outliers 2–3 s → ~0.5 s); the **WS-1009 investigation** (`ff4172a` — an
upstream-ready DRAFT at `docs/research/workers-vitest-ws1009-issue.md`: the
workerd pool-crash class is a deterministic 17-file set driven by direct
imports of the 983 KB contract JSON rendering a ~3.4 MB SSR payload; `?raw`
immune; four open questions; NOT filed — the dedicated repro unit is in
flight, alongside the shipped local mitigation `e4ebb9d`); and the
**miniflare-beta verdict** (`1970076` + `5d9122c`): the transitive
`miniflare 5.20261019.2-beta` trio is upstream's coordinated exact pin
(wrangler/vite-plugin/vitest-plugin all lock it; no stable 5.x exists;
forcing 4.x mismatches our compatibility_date's workerd) — DO-NOTHING,
recorded as an intentional hold in AGENTS.md, revisit at miniflare 5 GA
(analysis in `docs/research/miniflare-beta-pin.md`).

Compat tick at `18dd272` (survey re-run at `5d9122c`): the API inventory is
unchanged at 64 remaining, all FEATURE-ABSENT (Actions 54 + package registry
10 — the §4 ceiling); the UI survey moves to **48 LANDED / 4 PARTIAL /
61 ABSENT of 113** with a new top-5 (archive, tags write tails,
load-branches-and-tags, releases edit/delete, `/-/projects`).

Still in flight at this addendum's writing (uncommitted sibling units in
the tree, unowned by these notes): **loose-tag-carry, fork-pr-creation,
ui-parity-6, contract-import-mitigation, ws1009-repro** *(all five have
since landed — see Addendum 2)*. Superseded body
lines: §3's migration row for 0031 ("in flight, uncommitted") — committed
with the counters wave and applied remote via REDEPLOY13; §4's counter-work
bullet and action-rows limitation — shipped and production-verified as
above; §4's ride-REDEPLOY12 list — resolved by REDEPLOY12/13.

### What production proved this window

- Deploy gates at both GO trees: `pnpm typecheck` 0 errors; `check-openapi`
  PASS; `check-contract` PASS (frozen swagger sha verbatim); smoke
  **6 pass / 0 fail / 1 skip** both runs, including the migrate-check leg.
- **P0 shallow probes 3/3, unchanged** across both deployments
  (`--shallow-since`/`--shallow-exclude` rejected with protocol-shaped ERR
  exit 128; `--depth=1` clones 1 commit, `fsck` clean).
- New-surface spot probes, exact codes: blocks PUT/GET/DELETE 204/204/204
  cycle, tag-protection 422 verbatim, push-mirror CRUD cycle, wiki
  201/200/200/404 (REDEPLOY10); oauth2 secret-once/zero/blank, badges
  204/200/204/`[]`, feeds 200 with contract-exact keys, `GET /licenses`
  honest-empty `[]`, generate 201 (via an `is_template` D1 workaround — the
  PATCH-template gap it exposed is fixed by `7f0d5a6`) plus the verbatim 422
  "must select at least one template item" (REDEPLOY11).
- Registry: rename-carry verified 3/3 lifecycles at REDEPLOY10 and re-verified
  3/3 at REDEPLOY11; the read-after-delete residual measured t+5.4–6.4 s at
  REDEPLOY11, root-caused to the engine memo, and closed in code by
  `e30660d` (production close-out pending REDEPLOY12).
- Every probe repo/row/PAT cleaned and audited per run (remote-D1 counts
  recorded in the evidence blocks; `gitea/` submodule pristine).

---

## 3. Compatibility notes

### New migrations (this window)

| Migration | Content | Commit | Remote |
|---|---|---|---|
| 0022 `panoramic_bloodstorm` | `user_blocking` | `640d805`/`1934664` | REDEPLOY10 ✅ |
| 0023 `fresh_captain_america` | `push_mirrors` | `640d805`/`8f0aa90` | REDEPLOY10 ✅ |
| 0024 `past_gressill` | `projects`, `project_columns`, `project_issues`, `project_workflows` | `640d805`/`0d5b480` | REDEPLOY10 ✅ |
| 0025 `young_nico_minoru` | `protected_tags` | `640d805`/`a80878c` | REDEPLOY10 ✅ |
| 0026 `sharp_catseye` | `oauth2_application` | `579e872`/`42ab6a5` | REDEPLOY11 ✅ |
| 0027 `first_purple_man` | `badge`, `user_badge`, `repo_license` + `repositories.is_template` | `579e872`/`f328d06` | REDEPLOY11 ✅ |
| 0028 `heavy_cardiac` | `action` (+3 indexes) | `579e872`/`2ef9359` | REDEPLOY11 ✅ |
| 0029 `square_banshee` | `repositories.size_kb` | `3c58cce` | ✅ (session record) |
| 0030 `curly_gressill` | `repositories.num_stars`, `repositories.num_watches` | `528d369` | ✅ (session record) |
| 0031 `conscious_snowbird` | `repositories.num_forks`, `users.num_stars` | **in flight, uncommitted** *(committed + applied via REDEPLOY13 — see the §2 addendum)* | applied ✅ |

Schema stands at **64 tables** (`apps/worker/src/db/schema.ts`,
migrations 0000–0030; 0029–0031 are column-only). New SPECs this window:
`specs/wiki.md`, `specs/activity-feeds.md`.

### Declared-operation count, 385→490

Measured this run (`node scripts/check-openapi.mjs` PASS at `5ba6183`):
**490 operations across 298 paths**, 88.4% of the frozen contract (554 ops /
350 paths); tier-1 78/78 paths, 129/129 ops.

| Milestone | REG commit | Ops | declared |
|---|---|---|---|
| window open (secrets/variables) | `9f92950` | — | 385 |
| blocks + push-mirrors + tag-protections + wiki | `51d3c74` | 24 | 409 |
| git-hooks (4 ops + 9 RUNTIME_ONLY gate entries) | `12ab90d` | 4 | 413 |
| projects repo scope (batch 6 stage 1) | `fc123b0` | 21 | 434 |
| oauth2-apps + badges/licenses/generate + activity-feeds | `fec5c71` | 13 | 447 |
| projects org scope (batch 6 stage 2) | `20512c0` | 21 | 468 |
| projects user scope (batch 6 stage 3) | `c9a7ef7` | 22 | **490** |

The REG deltas sum to the window's +105 declared. The issue, notification,
miscellaneous and settings families have **zero** remaining — fully declared.

---

## 4. Known limitations (honest list)

- **64 FEATURE-ABSENT operations** (`docs/compat/api-remaining-inventory.md`):
  the Gitea **Actions runtime, 54 ops** (repository 33, organization 7, user
  7, admin 7 — runners/runs/jobs/artifacts/tasks/registration tokens; no
  CI-runtime tables exist in the schema) and the **package registry, 10 ops**
  (9 `/packages/*` + `GET /admin/packages`; no package tables — R2 is the
  candidate store and needs a SPEC per AGENTS.md). Both are demand-gated on
  their own SPEC. Everything declarable short of them is declared.
- **Counter work in flight at writing (uncommitted)** — set-private counter
  zeroing + `repositories.num_forks` (migration 0031 sits untracked; the
  service/route hunks are in the tree). Not shipped, not counted above.
  *(Superseded: shipped via REDEPLOY13 — see the §2 addendum.)*
- **`email_hash` table** — `/avatar/{hash}` cannot resolve a hash back to an
  email until a schema wave adds the table; `getEmailForHash` resolves empty
  (the upstream `!has` arm) by design for now (`apps/worker/src/services/avatars.ts`).
- **No `/assets` fallback target** — the assets config uses
  `not_found_handling: "none"`, so a missing static asset falls through to the
  Worker and answers 404/503 rather than a dedicated fallback page.
- **Repo delete does not mark `action` rows `is_deleted`** (REDEPLOY11
  OPEN ISSUE 3, still open — the feeds read filters `is_deleted = 0` rows but
  nothing sets the flag on delete; upstream hides a deleted repo's actions).
  *(Superseded: resolved by `389da18`'s hard-delete sweep, production-verified
  at REDEPLOY13 — see the §2 addendum.)*
- **Git over HTTPS only.** SSH is structurally out on Workers (ADR-0001) —
  carried from v1.0.
- Not yet production-verified (landed after REDEPLOY11, ride REDEPLOY12): the
  tombstone oracle, first-push settle generalization, repo size, star/watch
  counters, the generate fixes, license detection, the feeds tail, ui-parity
  3/4, and the avatar serving chain. *(Superseded: REDEPLOY12/13 shipped and
  verified these — see the §2 addendum; the one open residual — the
  generated repo's git-wire fetch/push — was fixed by `8828f43`, see
  Addendum 2.)*

### Addendum 2 — the git-wire residual closed; the in-flight list landed (appended 2026-10-26, wave-38)

Addendum 1 closed with REDEPLOY13's headline residual — the generated
repo's git wire — "tracked open", and with five sibling units in flight.
Both statements are stale as of HEAD `5dc924d`; every hash below is
`git cat-file -e` verified at that tree.

**The git-wire residual — closed** (`8828f43`). Root cause: the copied
cell's packs are NOT closure-complete (thin + loose-base) alongside its
loose objects, and the engine's finalize validated ref tips only — so a
push stacked on `auto_init` skipped the loose INTERIOR silently:
upload-pack answered 500 at the fetch POST and receive-pack refused
`ng missing necessary objects`. The fix keeps the engine untouched
(NOTICE-free): `replicateRepoCopy` brokers §5.3 itself — paged R2→R2 copy →
UNCONDITIONAL loose carry with budgeted packed-commit descent (≤64) →
finalize; red→green verified verbatim in both directions. The as-built
redesign record — the ≤64 budget/truncation fidelity limit and the
deliberately-NOT-taken engine-side alternative — is SPEC-0001b §5.3
(`640c202`), superseding the original catalog-replication text.

**Addendum 1's in-flight list, landed**: loose-tag-carry `ab5d300`
(packed-aware annotated-tag partition — fork/generate/rename drop zero
tags; loose tips re-materialize with the documented fidelity limit);
fork-pr-creation `a16f60e` (cross-repo heads end-to-end — fork PRs are
API-reachable); contract-import-mitigation `8b0ce41` + `cc196d3` (one
`?raw`+parse helper, `frozen-contract.ts`, replaces every direct
contract-JSON import — the ws1009 runner-crash class eliminated full-suite,
17 deaths → 0); ws1009-repro `aff64a6` (N=2 minimal repro; the true
mechanism measured: the `fetchWarmModules` SNAPSHOT frame, whole
transformed graph in one WS message, 32 MiB cap); ui-parity-6 `1b41b60`
(archive download + commit load-branches-and-tags aux JSON).

New infrastructure since Addendum 1:

- **Identity rig** (`4588475`) — `seedIdentity` mints REAL tokens through
  TokenService with row-projected identity (hand-rolled drift killed);
  `identityAuthResolver` layers over the stock test stub with a
  byte-identical default arm — unlocks stranger-arm and multi-identity
  differentials.
- **Payload mode** (`836f87a`, tail `7016ce9`) — upstream's
  `ToPayloadPullRequest` ported (webhook/label/milestone payloads render
  `head.repo` regardless of doer; hidden fork at `AccessModeNone`), then
  the tail emitters (label-detach, assignee, review-submission,
  review-request) switched; API serializers stay single/list.
- **Deploy-probes toolkit** (`49de9e9`) — six canonical batteries
  (p0/registry/generate-e2e/forkpr-e2e/ui-login/cleanup-audit) with
  evidence-anchored expectations, 0600 token discipline + secret
  scrubbing, `--dry-run`/`--json`; local self-test 45/45. REDEPLOY waves
  are its first production consumers.

Compat tick 3 (`5dc924d`, survey re-run at `7016ce9`): the CURRENT
reproducible UI headline is **52 LANDED / 3 PARTIAL / 57 ABSENT + 1
in-flight of 113** (row-by-row recount) — Addendum 1's 48/4/61 stands as
that tick's time-correct snapshot. The declared API surface is unchanged
at **490 ops / 298 paths** (ledger window `5d9122c..7016ce9`: zero new
ops — the §4 pre-Actions/packages ceiling holds).

**REDEPLOY14** — in flight at this addendum's writing (deploying),
expected to carry the wave recorded above (`8828f43`→`5dc924d`); its
evidence block lands in `docs/design/p0-evidence.md` after the run.

### What production proved this window
