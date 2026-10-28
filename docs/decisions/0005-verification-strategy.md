# ADR-0005: Verification strategy — the layer stack and four hard-won rules

Status: accepted · Date: 2026-10-25 · Expands ADR-0001 D4 ("Testing") into the
as-built verification architecture.

## Context

ADR-0001 D4 sketched four testing ideas (vitest-pool-workers, black-box git e2e,
API conformance, fuzzing). Milestones M1–M6 turned that sketch into a six-layer
stack, and four separate incidents wrote rules that no single layer's pass/fail
line could have produced on its own. This ADR records both: what each layer is
for, and why the rules between layers are the way they are. Everything cited
here is a file or commit in the tree.

## The layer stack (bottom-up)

1. **Unit — vitest in workerd** (`apps/worker/vitest.config.ts`,
   `@cloudflare/vitest-plugin`, real local D1/R2/DO bindings from
   `wrangler.jsonc`; migrations injected as the `TEST_MIGRATIONS` binding and
   applied per test file). Route families run two ways: full-worker `SELF`
   requests (integration, e.g. `src/git-http/gate.test.ts`) and standalone
   Hono mounts per route family (the `tier2-extras.test.ts` convention —
   "one standalone app per family"). Mandate: handler/service semantics
   against real bindings, fast, per-test storage isolation.
2. **Golden DOM + a11y** (`src/ui/__tests__/`): byte-exact committed goldens
   (`goldens.test.ts`) rendered through the real route path with fixed seed
   fixtures (same oids/dates on every machine) under a synthetic asset
   manifest, so any byte difference is real DOM drift; plus an accessibility
   smoke over the committed golden bytes (`a11y.test.ts`, no browser) with
   unit pins on the hand-rolled walker (`a11y.ts`) so the smoke cannot
   silently mis-parse. Mandate: the HTML we serve is exactly the HTML we
   reviewed.
3. **Black-box e2e** — real clients against a running dev server, in the
   engine e2e's real-git discipline (`packages/git-engine/e2e/`, adopted per
   ADR-0001 D4): `scripts/lfs-e2e.sh` (`pnpm test:lfs`; real `git-lfs`, 33
   checks, wrangler `--local` D1/R2 introspection of the server's own state);
   `scripts/mirror-e2e.sh` (`pnpm test:mirror`, landed a38f92e) — 11 scenarios
   whose SOURCE side is a real smart-HTTP endpoint
   (`apps/worker/test/fixtures/git-http-server.mjs` shelling
   `git upload-pack --stateless-rpc` on loopback TLS with a per-run throwaway
   CA), covering sync, delta sync, force-rewind, prune, v0 fallback, read-only
   enforcement, the SSRF egress gate, and source death. Mandate: what the real
   client sees on the wire.
4. **Differential battery** (`scripts/diff-test.mjs` + `scripts/diff-cases/`,
   `pnpm diff:test`): 20 cases (clone-fresh, clone-fsck, the shallow family,
   the push family, advert-capability-matrix, …) — the SAME deterministic
   repos, the SAME git CLI commands, against ours and optionally theirs (any
   Gitea / smart-HTTP server). Each case records git exit codes, refs
   (local + ls-remote), `.git/shallow`, and object/commit counts. In compare
   mode every divergence must be explained by a declared rule
   (`scripts/diff-cases/rules.mjs`); enforced rules additionally flag a
   VIOLATION when a side's own outcome is unacceptable even when both sides
   agree. `silent-full-clone` — exit 0, no shallow boundary — is never
   acceptable on either side (the P0 class of `docs/design/p0-evidence.md`).
   The advertised capability matrix is test-generated, not hand-maintained
   (Round-8 consistency gate `AdvertisedFeature ⇒ ParsedAndHandled`,
   `docs/design/m3-design-inputs.md`). Mandate: compatibility claims that
   survive contact with a second server.
5. **Production probes** — `scripts/deploy-smoke.mjs` (`pnpm smoke`) asserts,
   post-deploy, that the anonymous upload-pack advert 401-challenges on the
   private smoke repo (SPEC-0003 §2.4 row 2) with a settle-aware retry; the
   P0 close-out probes recorded real-git exit codes and `.git/shallow`
   verdicts against the live Worker (`docs/design/p0-evidence.md`, gates
   G1–G5; the probe repo is left live so a reviewer can re-run them).
   Mandate: the deployed artifact, not the tree, is what users hit.
6. **CI bench baselines** — `scripts/bench-baselines/` holds two
   machine-scoped records, per bench-run.mjs's BASELINE POLICY (baselines
   compare local-vs-local; a baseline is only comparable on the machine that
   recorded it): `m2.json` (recorded 2026-10-24 on the dev box, milestone m2,
   5 MiB fixture, local workerd: clone 14.2 MiB/s · push 192 ms ·
   incremental ratio 0.000245 · info/refs p50 12.5 ms) stays the dev-box
   reference, and CI gates on its own `ci.json`, self-bootstrapped by the
   `benchmark` job — the first run with `ci.json` absent RECORDS it (report
   pass) and uploads it for committing, every run after compares against it
   and fails on >10% regression. This replaced the original
   `--compare m2` wiring (2026-10-28, runs 40693290410/40695317569): those
   runs also exposed that the job had NEVER executed its compare leg — the
   fixture create-by-push 500'd on the fresh runner's unmigrated local D1
   first — but the m2 comparison was machine-relative by construction (a
   2-core runner vs the dev box), and the alternatives were rejected:
   softening the gate with a CI multiplier bakes one machine ratio into a
   gate that should outlive runner generations, and skipping the compare in
   CI (report-only) would leave the deployment platform — the only place
   the product actually runs — unmeasured, defeating ADR-0001 annex's "CI
   gate enforced". Mandate: performance claims are pinned, not remembered.

## Decisions

### D1 — Black-box e2e exists because fixture-shape bugs are invisible to unit tests

The gitclient incident (2278fc6): the mirror client's unit fixtures fed the
v2 capability advertisement WITHOUT the `# service=` preamble that every real
smart-HTTP server sends, so `parseV2Advert` failed to re-detect v2 against
real servers (and the packfile-section framing was wrong too) — while every
unit stayed green. The mirror e2e suite (a38f92e), running against a real
`git upload-pack`, caught both. **Rule: a wire-format parser gets real-shape
fixtures or black-box verification — ideally both.** A fixture that
"conveniently" omits a real framing detail tests the parser against a
protocol that does not exist.

### D2 — vitest does not typecheck cross-file

793f88d landed three tsc errors (a 2-arg `parseV2Advert` call; a cast-free
readonly-array enrich pattern in `sync.ts`) that green vitest runs (50/50,
67/67 on the affected scopes) never surfaced: the transform erases types
without checking them, and cross-file contracts are exactly what a
single-file transform cannot see — the webhooks-push wave's `tsc --noEmit`
caught them. **Rule: `pnpm typecheck` is a separate mandatory gate** (it is
a CI job in `.github/workflows/ci.yml`); a landing that ran only vitest has
not run its gates, no matter how green the summary line reads.

### D3 — wrangler vars leak into the test runtime

fb1c1c5 bound `APP_URL` in `wrangler.jsonc` so webhook payloads carry the
real origin — which silently flipped three hardcoded
`http://localhost:3000` expectations in `sync.test.ts` and
`webhooks-push.test.ts`. Config is a test input whether tests admit it or
not. **Rule: tests read the configured value** (the `EXPECTED_ORIGIN`
pattern: `env.APP_URL ?? upstream default`) **instead of asserting defaults
that the config can change.** A config change may move expectations only
when the expectations are derived from the config.

### D4 — Security verification is repro-first, fixture-verdict-second

The anonymous private-repo read finding (961ea22): production probes plus a
workerd reproduction showed the serving branch was the DEPLOY wave's stale
build (HEAD 419c811 predated repo lifecycle f052c64) — the smoke's push had
created the repo engine-side only and the gate's D1-miss passthrough reached
the engine's public-read branch. The verdict was **deploy skew, not a code
defect**, and the durable fix was the pin, not a patch: a 194-line
`gate.test.ts` regression matrix across the §2.5.2 settle window (row 2
holds before AND after `status='creating'` → `'ready'`). **Rule: reproduce
on the real deployment before assigning a verdict; then pin the security
property with a regression matrix regardless of the verdict** — a security
property that only the current tree happens to satisfy is still unpinned.

## Consequences

- **Cost.** ~1.5k vitest tests (with rotating workerd timing flakes on static
  code — failure identity changes run-to-run, fully committed-attributed, see
  the deploy-gate snapshot in `docs/design/p0-evidence.md`); the engine e2e
  with its exact-failure-set allowlist gate; two e2e suites that each own
  their dev server (mirror-e2e must own it for `SSL_CERT_FILE`); a ~10 s diff
  battery per endpoint (20 cases, measured); a benchmark CI stage on every
  push. Six layers is not free; each was bought by an incident above.
- **Interruptible by design.** Diff runs persist per-run JSON reports
  (`scripts/diff-report-*.json`, gitignored) and every repo carries a unique
  per-run slug (`difftest-<hex>-<case>`), so a session killed mid-battery
  (provider quota, crash) leaves leftovers that never collide with a rerun;
  `--compare` judges two stored reports with zero git re-runs. Resume from
  artifacts, not re-payment.
- **What layers do NOT promise.** Unit green ≠ typechecked (D2) ≠
  wire-correct (D1); a goldens pass promises byte-stability, not browser
  behavior (no browser in the loop); the diff battery's ours-only run is a
  baseline snapshot — compatibility is only proven once a theirs run compares
  clean; and per SPEC-0011 (draft, unratified), availability-under-GC is
  explicitly NOT promised — v1 chooses safety (Property A): a completed fetch
  is complete and parseable; lease failure is never reported as success.
- **Standing rule: every new protocol surface lands with a differential
  case.** The push family arrived as `push-lifecycle`/`push-tags-move`/
  `push-atomic`; the capability matrix as `advert-capability-matrix`. A
  surface without a case is a claim the battery cannot check.
