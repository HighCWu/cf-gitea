# cf-gitea v1.6.0 — Release Notes (the re-pin wave)

**Range**: `029fdd7..085884b` — 27 commits, 2026-11-20's re-pin campaign:
the vendored `gitea/` submodule moves `fc49368845` → `099abf5db4` (231
upstream commits) with every family's drift delta landed, gated, and
census-graded. Deployed as version **`f38a4d58-7b49-496a-ad48-e8adc148c3f1`**
(the demo worker `cf-gitea`; the production face `cf-gitea-prod` at
git.aiapp.run was assembled separately per L39 and is untouched by this
repo's deploys). Composite gate **PASS** (run 3: phase 1 ran 510 files —
507 green, 2 death-attributed files and 3 assert-files solo-adjudicated;
all 5 phase-2 solos green; 627s wall. Runs 1–2 caught the in-gate fallout
recorded below and it was fixed, never skipped). One migration this wave:
**0080** (`repositories.latest_release_id`, the make-latest release
pointer — applied remote before deploy, `migrations list` clean after).

## The wave (the first re-pin; ADR-0009's hours archive is
`docs/compat/adr-0009-first-repin-archive.md` — 53.2h recorded, category
(i) share ≈20%, the template-engine POC trigger does NOT fire)

- **REPIN-ROUTES** (0a97aed, 63df8f6): the api.go route-table re-pin —
  statuses leave `/repos` for their own top-level group, scope-table rows,
  the route families' cites re-anchored; HANDOFF1B (8594d11) lands the
  scope-handoffs (pure category (iv)+(v) — the scope tables are 100%
  behavior+test).
- **REPIN-ISSUE** (57a4619): the issue family's delta; the orphaned
  errors.ts hunk folded.
- **ADMINUSER2** (086679d, 513542e): the user family's re-pin + the
  settings-regen audit fold.
- **ACTIONS2** (7ed8e18): the actions family (quota-killed predecessor's
  verified landing).
- **RELEASE2** (5e4de1b): the release family's delta + migration 0080 —
  the make_latest/latest-release-pointer feature (a5201dc427), the webhook
  `changes` payload, the remove-audit row, RedirectDownload pointer pins.
- **CODESRCH2** (f38e277): the NEW code-search API pair (repo
  `GET …/code/search` + global `GET /search/code`) — the git-grep
  real-read, no indexer.
- **PULL2** (6e2c586) + **aac3c6e**: the pull family's delta COMPLETE
  (the campaign's biggest family) + the PRStatus.Unrelated schema
  adoption.
- **REPIN-REPO** (441b5c5) + **ROUTESWAP** (1150e4e): the repo family's
  69-row delta (the Repository wire growth, latest_commit_status
  narrowing, archive/unarchive audit arms) + the create-arm error-ladder
  swap (duplicate 409 text; reserved/pattern names 400-on-create).
- **ORGWIRE** (9f9b47f): six org-slice audit emits wired.
- **REPIN-NOTIFY** (655c504): the bot notification skips REMOVED (bots
  receive rows exactly like users) + the auto-cancel reason mechanic.
- **REPIN-WATCH** (3831c20): the negative result — the watch listings
  ride ToConds paths byte-stable; zero behavioral code.
- **WATCHSHELL** (c9ef680): upstream #40338's watch-menu element swap
  (four RepoHeaderWatch items are buttons now).
- **REPIN-OAUTH** (e3e0b8c, 9678cb9): the oauth2+password family — the
  TOTP limiter (5 attempts / 15-min window) on the web arms + the audit
  sweep + the LAST tsc debt cleared.
- **TWOFALIM** (cb2cbfb): the PRIORITY security handoff — the same TOTP
  limiter now guards the API Basic and git arms (they ran UNLIMITED).
- **TRANSFERHOOK** (f67e9b9): the repository TRANSFERRED webhook fires
  (the stale NullNotifier claim retired) + the feed's ActionTransferRepo.
- **REPIN-PKG** (c9202b1): the packages family — the OnAfterRemovePackage
  index rebuild, package-file properties, the helm 256 MiB inflate cap,
  OCI v1.1 image grammar, chef nil-dependency, cleanup-rule titles.
- **SMALLS6** (9dbbd33) + **353b4f8**: seven consolidated handoffs
  (collision 409 text, auto-cancel wirings, DisableAutoMergeIfNotWriter,
  pending-submit timeline skip, RepositoryBranchDefault audit,
  RedirectDownload, the classifier export) + the units' wider sweeps.
- **08b1d2b**: 21 goldens regenerated at the new pin (97/97 green).
- **CHECKER** (09c2b92): the contract gates re-aligned for upstream
  5671c5192d's 1,001-ref swagger default-fold — the fold-equivalence rule
  + the vendored-copy re-baseline.
- **GATEFIX** (085884b): the freeze gate's 13 files triaged green —
  fixtures regenerated, stale pins rewritten, and TWO real bugs fixed:
  the PullRequest serializer now renders `auto_merge` (the full converter
  family with the batched page preload) and the token-regenerate arm's
  duplicate audit row removed.

## The L71 freeze-chain close (2026-11-21)

The chain 085884b paused on resumed under the operator's MVP-autonomy
policy: test:full → 0080 remote → build → deploy → probes → pointer+NOTES
→ ADR-0009 archive (this file + `docs/compat/adr-0009-first-repin-archive.md`
+ the `gitea` gitlink bump riding this commit). The gate's first run
caught REAL fallout the narrower gates had missed, all fixed in-gate:
the tier2-extras pinned-pulls statement-count witness (12→13: GATEFIX's
auto_merge page batch), and — the recorded lesson — the vitest workers
read the ACCOUNT-LOCAL wrangler.jsonc, so the suite's ambient posture is
now pinned in `vitest.config.ts` (form ON, signup OFF) instead of riding
the deployable config (the L71 alignment flip had re-classed
first-run/webauthn mid-gate; session's login golden pinned the over-pin).
Deployment vars carried the explicit closed overrides
(`--var ALLOW_SIGNUP:false --var ENABLE_PASSWORD_SIGNIN_FORM:false`) —
the DEPLOY.md 10.13 fork class (the checkout's local config had drifted
to "true"/"true") is closed in the same wave: the local file is aligned
to the deployed faces and `docs/ops/deploy-notes.md` records the standing
redeploy discipline.

## Probe results (the L71 post-deploy battery — anonymous, zero-credential)

Production `git.aiapp.run` (cf-gitea-prod, L39's assembly — must be
UNCHANGED by this wave; every arm matched its recorded shape):

| Probe | Expected | Observed |
|---|---|---|
| GET / | 200 | 200 |
| GET /healthz | 200 | 200 `{"ok":true}` |
| GET /user/sign_up | 404 (closed) | 404 |
| GET /user/login | 404 (repo-scoped shape) | 404 |
| GET /login | 200, no password form | 200, 0 form fields |
| POST /login (form fields) | 403 `Forbidden\n` | 403 `Forbidden\n` |
| GET /api/v1/version | 200 | 200 |
| GET /api/v1/repos/<absent>/pulls | 404 | 404 |
| git-HTTP info/refs on absent repo | 404 | 404 |
| GET /user/oauth2/DomonAI (SSO head) | 303 → domon.ai authorize | 303, `client_id=git_DomonAI`, PKCE + state + exact callback intact |
| GET /user/link_account?oauth2_source=DomonAI | 200 (signin arm) | 200 |

Deployed demo face `cf-gitea.hecongw.workers.dev` (version
`f38a4d58…` — the aligned closed posture, was sign_up 200 pre-deploy):

| Probe | Expected | Observed |
|---|---|---|
| GET /healthz | 200 | 200 `{"ok":true}` |
| GET / | 200 | 200 |
| GET /user/sign_up | 404 (closed) | 404 (was 200) |
| GET /login | 200, no password form | 200, 0 form fields |
| POST /login (form fields) | 403 `Forbidden\n` | 403 `Forbidden\n` |
| GET /api/v1/version | 200 | 200 |
| GET /api/v1/repos/p0probe/bp-2112933d | 200 (public) | 200 |
| GET …/pulls (the auto_merge-bearing payload) | 200 `[]` | 200 `[]` |
| git-HTTP info/refs public repo | 200 | 200 |
| git-HTTP info/refs private repo anonymous | 401 | 401 |
| git-HTTP info/refs absent repo | 404 | 404 |
| `deploy-smoke.mjs` battery | pass | pass (healthz + anon-git-surface) |

Zero-credential, zero-account, zero-acceptance-repo contact throughout:
the git-HTTP arms read an absent-repo shape plus the demo instance's own
public probe repos (p0probe fixtures, untouched); no PAT, no cookie, no
POST that can mutate (the 403 arm precedes validation by design).
