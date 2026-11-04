# cf-gitea v1.5.8 — Release Notes (the convergence freeze)

**Range**: `0543c9b..bf6bb67` — **30+ commits** across 2026-11-04's
afternoon and evening — the convergence wave: the census's B-backlog
drained to the user-set line, four quota-kill salvage cycles landed at
zero loss, and the pool went to zero by the user's order.

Deployed as version **`fdc0b73c-0d99-4b71-ae53-ebfe8068bf49`**. Migrations
**0075-0077** remote-applied FIRST (must_change_password; users.is_restricted;
the table-census MISSING batch — issue_dependency.updated_unix,
gpg_keys.emails, repo_transfer's two columns, the repo_collaborators id
rebuild). Composite gate **PASS** on the release tree: 496 files, 495
pass, 1 solo-adjudicated load flake, 0 timeouts; the gate's six REAL
regression catches this wave (password-ladder fixtures, the secrets
at-rest envelope pins, the is_tag-mint idempotency guards, B-55's claimed
tails, B-54's stamp sourcing, B-70's nav fold) were all root-caused and
fixed — the gate did exactly what it was built for.

## The B-board's day (the convergence line's ledger)

**Landed**: B-48/B-49 (+PR-create assignees) — the issue/PR create fields
that were bound-and-dropped now run upstream's full ladders; B-50 — PR
base retarget with the verbatim error texts (including upstream's `%sm`
typo); B-51 — merge-upstream fully rewritten from the stale 404 stub; B-54
— the is_tag release-row mint arms (push + API + adopt + the tags-page
universe), with the ROOT-CAUSE find that push-created repos silently
skipped every tag arm; B-55/B-56 — the release web write tails
(generate-notes, streaming attachments, approve-all-checks); B-57 — the
actions-secret AEAD envelope at rest (wire-invisible, 60-test battery
unchanged); B-62/B-63/B-64 — the webhooks wave (the Actions events pair,
the replay arm across all four scopes, the Authorization header envelope);
B-65 (receiver half) — the three mailNotifier receivers incl. the actions
email-preference reader; B-70 (page half) — the admin audit viewer.

**Parked mid-build, designs preserved** (docs/compat/convergence-backlog.md
is the authoritative hand-back): B-58 (the xz decoder half), B-65's thread
leg + emit wirings, B-70's route mounts, B-59 (a ~20-line read seam, no
migration needed).

## The census at convergence

**13/17 modules COMPLETE** (257+ graded rows, both-side cites); the board
**B-11..B-72** (62 rows) with the day's 15 landings stamped; modules
1/3/5/16-17 honestly not-yet-censused; the L-class feature lanes (agit,
codeowner gates, bot users) archived as scheduled work, not compatibility
defects. The operational truth of the day: ADR-0008's standard made the
backlog GROW by design — 27 new rows opened by the census's own sweep —
and the drain rate matched it.

## The salvage discipline (four quota kills, zero loss)

Four windows killed 19 agent-runs mid-flight; every one resumed from its
/tmp progress note (the quota-death convention), with the tree verified at
each salvage (the one half-broken pair rolled back; the rest landed as
resume bases). The shared-file deferral pattern (ui/index.ts's three-way
landing) held the moving-target rule throughout.

## After this freeze

The 04:05 routine keeps the lights on; units dispatch only on demand —
the user's usage-driven reports are the trigger.
