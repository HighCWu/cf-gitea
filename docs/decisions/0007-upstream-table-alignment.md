# ADR-0007: Table structures align with upstream by default (the schema-layer parity rule)

Status: accepted · Date: 2026-11-03 · Extends the standing Upstream-Parity
Decision Rule (AGENTS.md) from behavior to the schema layer — the schema-side
sibling of ADR-0002 (contract freeze). Ruled by the user 2026-11-03:
"对齐 gitea 的表结构，除平台实在做不到的" — *align the table structures with
Gitea's, except where the platform genuinely cannot.*

## Context

Upstream parity has so far been a behavior rule. ADR-0002 froze the API
contract at the submodule pin, and the standing decision rule says upstream
behavior IS the default decision — an upstream-faithful implementation is not
a decision point and never goes to the user. The **schema layer had no such
rule**: D1 tables were designed per feature, and "avoids a migration" often
acted as the tiebreaker. Nothing recorded said tables owe upstream anything.

The case that surfaced the gap: **W14's Actions schedule chain** (`6ae87ab`)
was deliberately designed stateless — "the default-branch tree is the
registry". Schedule dedupe rides a synthesized `schedule_unix` dedupe key and
a **probe-then-insert** in `services/actions/trigger.ts`, chosen specifically
to avoid a migration. The v1.5.5 review sweep's R1 found the cost (finding F7,
recorded at FF `7e40aa6`): upstream's schedule surface is **table-keyed** —
`gitea/models/actions/schedule.go` + `schedule_spec.go` define
`ActionSchedule` rows with per-spec rows created by
`CreateScheduleTaskBySchedules` — and a probe-then-insert cannot reach that
shape. FF's record states the general fact, not a one-off: **"every
migration-free CAS shape needs a migration."** Fixing F7 therefore required a
migration grant, and the question stopped being about F7: is schema parity a
per-feature decision point, or a standing default like behavior parity? The
user ruled on 2026-11-03, and ruled the general case along with F7's fix
route: **route B** — migrate to upstream's table structure — rather than keep
the migration-free CAS.

## Decision

1. **Upstream table structures are the default decision, exactly as upstream
   behavior is.** New tables follow upstream's model — columns, keys,
   constraints, row lifecycle — wherever D1/SQLite can express it. A design
   that renames, merges, splits, or substitutes a column must justify the
   divergence in its SPEC the same way a behavior divergence does. "It avoids
   a migration" is not a justification; under this ruling a migration is the
   ordinary cost of parity, paid like any other implementation cost (Drizzle
   schema change → `pnpm db:generate` → migration lands only in
   `apps/worker/src/db/migrations`, per AGENTS.md).
2. **The classification vocabulary.** Every schema divergence from upstream
   is exactly one of:
   - **platform-adapted** — the Workers platform genuinely cannot express
     upstream's shape (D1/SQLite semantics, workerd limits, the no-server-side
     -copy class of binding gaps). The adaptation is the standing posture and
     is recorded in the SPEC with the platform reason. This is the ruling's
     own exception ("除平台实在做不到的") — it must cite the platform, not
     convenience.
   - **intentional-recorded** — upstream has an answer; we chose differently
     on a ground worth keeping and wrote it down (the schema-adjacent
     precedents: the PAT last-used touch throttle over upstream's every-call
     update, SPEC-0002 §2.7; our TEXT `repositories.id` id space vs upstream's
     int64, the id-space fact K11 pinned in `3ed025d`). These stand while the
     record stands.
   - **drift** — accidental divergence: nobody decided it, nothing records it,
     it is simply not upstream's shape (W14's probe-then-insert dedupe is the
     founding specimen). Drift is a defect class; the fix lands as upstream's
     shape.
3. **The migration-threshold protocol.** A schema fix crosses the migration
   threshold ONLY under an explicit grant — **this ADR IS that grant for the
   drift class**: a drift fix never needs to re-ask. The grant authorizes the
   class, not unreviewed DDL — each fix still lands as its own generated
   migration plus its own SPEC record (the SPEC-first workflow is unchanged;
   a drift fix is a design-level change, not a trivial fix).
   Platform-adapted and intentional-recorded divergences do not migrate:
   there is nothing to align to. Re-classifying one as drift (a record
   withdrawn, a platform limit lifted) re-opens it under this grant.

## Considered and rejected

- **Keep-stateless-where-possible as a general rule** (the W14 tiebreaker
  made universal) — falsified by F7 itself: an application-level CAS
  substitutes read-then-write probing for constraint-level guarantees, and
  the schedule dedupe race is exactly the class FD's automerge fix
  (`28cccf9`) closed on the behavior side. Divergence debt also compounds:
  every later consumer re-learns the local shape — K11's TEXT id-space parse
  pins are that price already paid.
- **Big-bang schema alignment** (rewrite every table to upstream's shape now)
  — rejected: the ruling is a default for new work and a queue for found
  drift, not a rewrite mandate. A drift fix migrates when it reaches behavior
  or unblocks parity work (F7 does both); intentional-recorded postures stay
  standing.

## Consequences

- **FM's in-flight migration 0062 is the first application**: the upstream
  schedule tables (route B, user-ruled) land over the probe-then-insert,
  closing SW-1 (the v1.5.2 ledger §7.3).
- **FN's table audit (in flight, read-only) builds the drift backlog under
  this vocabulary**: every table comes out classified platform-adapted /
  intentional-recorded / drift; drift rows queue behind FM as their own
  migration + SPEC units. The audit is the mechanism by which the standing
  default actually reaches the existing schema.
- **S-1 is unlocked**: the ActivityPub follower store's blocking dependency —
  MIGRATION-GATED on an explicit grant (the v1.5.2 ledger §3) — is satisfied
  by this ruling. It queues for the next wave and lands as its own migration
  + SPEC like any drift-class unit.
- **The per-feature question is retired.** "Should this feature get a table?"
  is answered by upstream's model, never re-asked and never escalated; the
  remaining decision points are exactly the AGENTS.md rule's two: upstream
  has no schema answer for the surface, or the platform makes upstream's
  shape impossible and multiple equally faithful adaptations exist.
- **A divergence without a record is drift.** The intentional-recorded class
  gives the posture-vs-drift boundary a test: if the SPEC does not record it,
  it is drift and the grant above applies.
