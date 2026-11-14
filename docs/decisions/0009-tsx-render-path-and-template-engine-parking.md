# ADR-0009: The TSX render path stays; the Go-template engine route is conditionally parked

**Status**: Accepted (2026-11-14)
**Context**: the 2026-11-14 tab-active regression (6b88549) prompted an
architecture review of the view layer ("we reuse upstream's .tmpl, don't
we?" — no; see below), including an external assessment (two rounds) that
proposed a Go `html/template` compatibility engine as an alternative to the
hand-ported TSX pages. This ADR records the decision, what was rejected,
the re-open protocol, and the data-collection obligation.

## Background (the facts the decision rests on)

- The web UI is a from-scratch Hono JSX port (`src/ui/pages/*.tsx`, hundreds
  of pages). Upstream `.tmpl` files are the DERIVATION REFERENCE, cited as
  `file:line` anchors in comments and test descriptions (27,820 cite sites
  per the DRIFT index) — not the runtime.
- Go `html/template` cannot run on Workers; more importantly, Gitea's
  templates CALL Go methods (`{{.Repository.Link}}`, `{{ctx.Locale.Tr}}`,
  `{{.Permission.CanRead ...}}`), so any JS engine needs a ViewModel adapter
  layer whose cost is comparable to the page ports it would replace (the
  adapters ARE the controllers' context, ported). Estimate from port
  experience: adapters ≈ 60–80% of per-page port cost — TO BE MEASURED, not
  assumed (see the protocol below).
- The port is complete and verified: census 17/17, byte-contract goldens,
  per-page matrix batteries, v1.5.9 frozen and deployed.
- Upstream re-pins have NOT happened yet in this project's life (the pin is
  deliberate); there is ZERO re-pin cost data. Both "TSX is cheaper long
  term" and "template engine is cheaper long term" are currently
  extrapolations.

## Decision

1. **The TSX production path stays.** No migration, no dual render paths
   (a dual-render production architecture is permanently rejected — a future
   switch would be a migration, never a coexistence).
2. **No template-engine work now**: no engine clones, no forks, no
   compatibility POC — until the re-open condition below fires. Unwaiting
   costs nothing.
3. **The structural investments landed instead** (this decision's execution):
   - TABSWEEP (4c15155): the tab-active convention class closed with a
     32-case structural guard (`repo-tab-strip.test.tsx`) + 3 latent fixes.
   - DRIFT (3e3c0bf): `pnpm drift` — the upstream drift analyzer (citation
     index × pin-window diff → severity-bucketed task lists), with the
     real-window baseline committed at
     `docs/compat/upstream-drift-baseline.md`.
4. **The re-open protocol (data-triggered, evidence-gated):**
   - At every re-pin: run `pnpm drift --current`, and record ACTUAL hours in
     five categories: (i) pure template-structure sync, (ii) ViewModel
     adaptation, (iii) helpers/locals, (iv) permission/behavior changes,
     (v) test/golden repair.
   - **Trigger (investigation, NOT migration)**: if category (i) exceeds
     ~50% of TSX-side maintenance hours across 1–2 consecutive re-pins, a
     bounded POC is authorized — with the explicit understanding that
     structure-share is NOT savings-share (much of (i) — golden
     re-derivation, DOM-contract review — is owed under the template route
     too).
   - **POC gates** (all must pass before any migration discussion):
     (a) upstream `.tmpl` unmodified; (b) runs in workerd; (c) contextual
     HTML escaping PROVEN against a two-tier oracle; (d) adapter cost
     measured in real hours; (e) NET automatable savings demonstrably
     positive after engine maintenance, security verification, and
     migration cost.
   - **Two-tier oracle** (the POC's correctness standard): our TSX byte
     goldens prove regression-compatibility of the frozen product behavior;
     a separate small Go-side test program running real `html/template`
     proves the engine's SEMANTICS (scoping, pipelines, contextual
     escaping). The former cannot substitute for the latter; escaping
     security especially is proven only by the second tier. POC-time
     prerequisite: a local Go toolchain for the oracle program.
5. **This discussion closes now.** Future re-opens cite this ADR and start
   from the recorded data, not from first principles.

## Consequences

- The next re-pin is the first data point; until the second, no architecture
  argument reopens (the 04:05 routine and drift runs continue regardless).
- Known costs accepted: per-page convention risks (the tab-active class) are
  mitigated structurally by pin-nets, not by engine unification; upstream
  structure changes are auto-DETECTED by goldens and ported deliberately.
- The INVFIX/TABSWEEP pattern (structural pin-nets per convention class) is
  the standing answer to "upstream enforces it structurally, we enforce it
  by convention" — a class of guard, not a one-off.
