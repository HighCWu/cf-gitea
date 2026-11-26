# cf-gitea v1.7.0 — Release Notes (the post-re-pin wave)

**Range**: `3606920..24ff829` — the wave after the v1.6.0 freeze: the engine
hardening batch (the parallel session's git-engine commits), then the
six-unit product wave on the new pin `099abf5db4`, closed by the gate's
own three-red fix batch and a live-found cascade fix. Deployed as version
**`8912f92b-66ab-4a68-bbe7-108a4c0d7a25`** (the demo worker `cf-gitea`; the
production face `cf-gitea-prod` at git.aiapp.run is L39's separate
assembly, untouched by this repo's deploys). Composite gate **PASS** (run
3: phase 1 ran 520 files — 520 green, 2 death-attributed files
solo-adjudicated green; 1462 s wall. Run 1 passed pre-PUSHMIRCAS; run 2
starved mid-suite — 22 leaked workerd processes from run 1's own
teardown-race class pinned the host's memory; the lesson: **pkill the
leaked workerd pool before every gate rerun**). Two migrations this wave:
**0081** (`repo_mirrors.sync_failures`, the pull-mirror backoff) and
**0082** (the `package_properties` composite `(ref_id, name)` index) —
both applied remote before deploy, `migrations list` clean after.

## The engine hardening batch (SPEC 0230's wall and its neighbors)

- **8140240 + 61bbb13**: pull-mirror sync retries back off on consecutive
  failures (`sync_failures` rides migration 0081) instead of re-attempting
  the same failing full pull every cron tick.
- **51eb12e**: the `OAUTH2_ENABLED` 403 gate is group-scoped
  (`/login/oauth/*`), not site-wide — upstream web.go's chi group
  semantics.
- **8c02a5b + 67528e7 + d3d023c + c25af44**: the receive resolver
  resolves cross-pack delta bases mid-chain (windowed thin pushes no
  longer fail "missing delta base"), in batched waves instead of
  single-oid hops, with thin bases classified only after the in-pack
  fixpoint and the indexing phase answering a wall-clock deadline.
- **fe6fc56 + 54ec9ed + 861dd73**: a push holder whose client dies
  releases the receive lease immediately (the agit lane hands the engine
  the request's abort signal); the busy 503 names the blocking lease's
  expiry.
- **10a33c4 + cccb8da**: the M2 GC announces its rounds and skips the
  wholesale loose migration for pack-native stores; compaction advances
  past oversized queue heads and fast-forward pushes stamp compaction,
  with admin endpoints exposing compact/gc.
- **e0cfc51**: finalize reuses classifyReceive's ancestry verdict instead
  of re-walking it.
- **07e8707 + f8f9c57**: receivePack answers as a STREAM once the pack is
  staged — indexing/finalize/ref-commit run as the invocation tail with
  git's official `receive.keepAlive` heartbeat (SPEC 0230), plus the
  black-box sideband acceptance harness. **The freeze's own lesson**:
  this makes a status-only test assertion race the tail — a
  protocol-correct client reads report-status to EOF before acting on a
  push, and the suite's one such shortcut (repo-mutation-registry's
  default-branch case) now drains and pins the ok line (80fd540). A
  suite-wide drain sweep (the zero-drain receive-pack batteries) is
  recorded as backlog.

## The product wave (the new pin's first feature batch)

- **TFMODULE** (ee12365): upstream `5d9bfa1e14`'s terraform MODULE
  registry — the five-route `/-/terraform/modules` surface (versions
  envelope, the signed `X-Terraform-Get` with the HMAC-SHA1 time-limit
  code, the archive, the immutable PUT, the DELETE), the HCL
  scanner/parser pinned against upstream's own `parser_test.go` vectors
  (30/30), and the web view family. SPEC-first:
  `specs/terraform-module-registry.md`. Census row B-91 opened with the
  derivation.
- **CREATEREST** (dd26b83 + a80885a): the creation-restriction storage
  family — `pull_requests_creation_restriction` rides the repo_units
  JSON config store (zero SQL), decode-time 422 on the bindings, the
  always-rendered `internal_tracker` member; B-33 re-graded to an
  S-residue.
- **SPLITTEXT** (cea6126): upstream's exact per-class repo-name reject
  texts, the web retarget doer thread (the `base_changed` cancel
  attribution), and the 44-entry envelope pruning (fold-equivalent ops
  473→475).
- **FEEDOP8** (acbb96d): the op-8 transfer rows render on every read
  surface — the audit found the profile RSS would have THROWN on a
  seeded transfer row (an ADR-0008 violation worse than a skip).
- **PROPINDEX** (73a41c0): migration 0082 — upstream's one composite
  `(ref_id, name)` index replaces our divergent pair, EXPLAIN-pinned
  against both reader WHERE shapes.
- **CITES60** (407bab3): the packages family's residual cite sweep — 508
  verified refreshes across 48 files (the freeze-time "~60 sites"
  estimate was wrong; the family held 527 bucket-(a) rows). The
  repo-wide residual OUTSIDE the family (~7,400 rows / ~730 files) is
  recorded as its own dispatch.
- **GATEUNBLOCK** (80fd540): the gate's three solo reds closed — the
  setHead "regression" root-caused as the SPEC-0230 test-contract bug
  above, the packages option census +1 (TFMODULE's type), and the
  `GATE_MAX_WORKERS` throttle after the systemd-oomd SIGKILL-137 class
  (the default pool dies mid-suite with no JSON report; 4 workers
  completes in ~1460 s).
- **PUSHMIRCAS** (24ff829): `deleteRepository`'s cascade now sweeps
  `push_mirrors` — found LIVE by the probe battery's audit arm (the
  first probe run's `audit-push-mirrors` fail: a deleted repo left its
  push-mirror row behind; upstream's DeleteBeans carries the bean,
  `services/repository/delete.go:175`). The orphaned remote row was
  hand-swept (table verified 0) and the cascade arm is pinned in the
  purge battery's sweep-1 test.

## Posture

The demo face reopens registration (the operator's standing order —
"open signup, data wiped periodically"; the runbook's posture pair):
`ALLOW_SIGNUP=true`, `ENABLE_PASSWORD_SIGNIN_FORM=true` (an open
registration without the password form would mint users who can never
sign in), `DEMO_MODE=true` unchanged. L71's fork-class lesson stays
closed: the same chain builds and deploys this config, so checkout and
deployment are one posture. Prod (`cf-gitea-prod`) keeps its own closed
assembly.

## Probes

Two full-battery runs (the wave earned its own in-flight story):

- **Run 1** (deploy `13e5f510`): the audit arm caught a REAL cascade gap
  — `audit-push-mirrors` fail, a deleted repo's `push_mirrors` row left
  behind (PUSHMIRCAS above; the final deploy carries the fix). The other
  four `left_behind` artifacts were uplink-flake cleanup tails (the
  2026-11-26 evening link dropped fetches intermittently — the same class
  that killed the first deploy attempt): the proto repo deleted 204, the
  packages verified gone, the orphaned mirror row hand-swept (table
  verified 0). The run's full tally is lost to a harness-side `tail`
  pipe — recorded honestly, the audit section survived.
- **Run 2** (the final deploy `8912f92b`): 233 pass, 4 fails, every one
  adjudicated — (1) `demo-config-posture` was a STALE ARM (the
  2026-10-29 revision demanded a `cf-gitea-demo` custom-domain route for
  the armed posture; that domain era ended and the runbook's newer
  posture doctrine — the B87 lesson, 2026-11-14 — characterizes the demo
  face by the `signup-open` + banner arms; the route clause false-fired
  on every deploy since — arm revised with a dated note, committed);
  (2)+(3) `pkg-pypi-upload-simple-index` + `oauth2-introspect` uplink
  transients, both green standalone; (4) `audit-action-rows` 4-vs-3 =
  run-2's own `p0-shallow` leftover from the same flaky window (deleted
  204, the action row cascaded back to the three standing fixtures;
  green standalone).
- **`signup-open`: 200 — the registration form renders anonymously.**
  The reopened demo posture's canary is green on the deployed face.
- The probe PAT was minted-before and SWEPT-after (bootstrap row
  deleted, `personal_access_tokens` verified 0, token file shredded).
