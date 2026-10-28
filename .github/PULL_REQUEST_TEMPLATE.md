<!--
Thank you for the PR. One logical change per PR; the checklist below is the
landing gate (distilled from AGENTS.md's verification discipline).
-->

## What & why

<!-- Describe the change and the reason for it. If it fixes an issue, link it. -->

**SPEC**: <!-- For a non-trivial feature or design-level fix: link the SPEC in specs/
(written or updated IN THIS SAME CHANGE — see CONTRIBUTING.md). Write "N/A — trivial"
for typos and small refactors. -->

## Checklist

- [ ] `pnpm test:full` green — the composite gate is the ONLY "suite is green"
      verdict ([ADR-0006](https://github.com/HighCWu/cf-gitea/blob/main/docs/decisions/0006-full-suite-composite-gate.md));
      quote the actual `Tests` summary line under "Testing evidence" below.
      (A plain `pnpm test` pass is the fast loop for one file/scope — cite it as
      exactly that, never as suite-green.)
- [ ] `pnpm typecheck` and `pnpm lint` pass (`tsc --noEmit` is its own gate —
      vitest does not typecheck across files).
- [ ] API surface touched? `pnpm check:api` and `pnpm check:contract` pass, and the
      behavior matches upstream Gitea (or the intentional divergence is documented
      in the SPEC).
- [ ] Schema touched? A generated Drizzle migration is included (`pnpm db:generate`);
      no hand-written SQL in route handlers.
- [ ] Nothing inside `gitea/` changed — it is a read-only upstream reference; PRs
      touching the submodule or its pointer will be declined.
- [ ] No generated artifacts committed (`dist/`, `dist-types/`, `.wrangler/`,
      `worker-configuration.d.ts`, generated icon/type files). `pnpm-lock.yaml`
      updated only when dependencies actually change, kept at latest stable.
- [ ] All code, comments, docs, and the commit message are in English.

## Testing evidence

<!-- Paste output, not paraphrase: the `Tests ` line from `pnpm test:full` (or the
exact scope a `pnpm test` run covered), plus any e2e suite you ran
(`pnpm test:lfs` / `pnpm test:mirror`) and the relevant commands run.
Example: `Tests  268 files / 5,9xx tests / 0 failed` -->
