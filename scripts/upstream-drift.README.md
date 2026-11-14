# upstream-drift — the Gitea Upstream Drift Analyzer

One committed home for the recurring "what does a re-pin break?" question, so
every `gitea/` submodule re-pin runs the same mapping instead of hand-walking
the diff. Node-run, zero npm deps (plain Node >= 20 + system git), read-only
over `gitea/` and `apps/worker/src/`. It automates what the behavioral census
([docs/compat/behavioral-census.md](docs/compat/behavioral-census.md)) does
manually: mapping an upstream re-pin's changes onto OUR landed pages/tests
through the upstream citation anchors the codebase carries in its comments and
test descriptions.

## How to run

```bash
node scripts/upstream-drift.mjs --from <sha> --to <sha> [--html out.html]
node scripts/upstream-drift.mjs --current                # recorded gitlink vs working submodule HEAD
node scripts/upstream-drift.mjs --selftest               # 39 inline-fixture checks + a real temp-git fixture
```

`--from`/`--to` take any two commits resolvable inside `gitea/` (short shas,
`HEAD~N`, `fc49368845~10`). The markdown report goes to stdout; `--html`
additionally writes a styled standalone HTML file (no JS, prints fine).

Wiring (orchestrator-owned `package.json`, not yet landed): add
`"drift": "node scripts/upstream-drift.mjs"` to the root scripts, then use
`pnpm drift --from <sha> --to <sha>`.

## What it does

1. **Diff the controller-side surface**: `git diff` over `templates/**/*.tmpl`
   + `routers/` + `services/` + `models/` between the two submodule commits
   (`--no-renames`, so a rename degrades to a D+A pair — exactly the bucket-(c)
   model).
2. **Build the citation index**: scan `apps/worker/src/**/*.{ts,tsx}` for the
   established cite conventions —
   - explicit: `header.tmpl:107`, `routers/web/repo/milestone.go:35`,
     `issue_list.go:661/672` (slash-separated multi-lines),
     `services/issue/pull.go:253-310` (ranges),
     `errpage.go:114/118-122` (mixed), `security/2fa.go:62,100,282` (commas);
   - bare shorthand: `(:82-85 ...)` bound to the nearest explicit path cite in
     the same comment block (trailing `//` comments on code lines participate;
     `https://` and `12:30` shapes are guarded).
   Explicit cites are scanned on ALL lines — the suites carry them inside test
   descriptions (`it("... (container.go:116-130)")`) — shorthand only inside
   comment segments. ~27.8k cite sites across ~1k files at the current pin.
3. **Map drift to cites**: `-U0` hunk headers give the changed line ranges;
   each cited line is classified on the side its cites are valid at:
   - *inside a changed hunk* → **(b) CITED REGION CHANGED** — the ported
     behavior may diverge; re-derive;
   - *intact but shifted* → **(a) CITED-LINE MOVED** — refresh the cite and
     re-check the derivation (the report names the position on the other side
     of the window);
   - **(c) FILE ADDED/REMOVED** — new surface (review for port scope) or
     removed surface (our cites are dead: re-derive or retire the port).

   Zero-count hunks follow git's convention (`-s,0` = insertion after old line
   s; `+s,0` = deletion after new line s) — the selftest asserts the exact
   boundary semantics against a real temp-git fixture.

   **Cite side** is picked automatically: `to == submodule HEAD` → cites are
   TO-side (the census derives them against the pin; baseline direction);
   `from == HEAD` → cites are FROM-side (forward re-pin analysis); neither →
   TO-side with an explicit approximation warning in the report.

4. **Resolve cites to upstream files** by suffix match against the cite-side
   tree; ambiguous basenames (`packages.go` has 7 candidates) narrow by
   line-count plausibility, then by *window narrowing* (a unique in-window
   candidate wins, marked). Genuinely unattributable ambiguous cites whose
   candidates changed get their own honest table instead of a silent drop.
   Cites to out-of-scope paths (`modules/...`) are counted as unresolved in
   the diagnostics, never misattributed.

## The report

Per-bucket tables (`upstream file` → `our file:line-of-cite` → `census hint` →
`suggested task`), plus: a summary (files touched per status, cite-index
health, affected counts), an informational table of changed upstream surface
NO cite covers (unported or predating the cites — board-glance material),
**tests likely in scope** (name-stem matching: `issues-list.tsx` ↔
`issues-list.matrix.test.tsx`), and **census-board hints** (`pages family:
<stem>` for `src/ui/pages` hits, owning module dir otherwise).

The baseline artifact — a real window (`fc49368845~10 → fc49368845`, ten
commits before the pin) — lives at
[docs/compat/upstream-drift-baseline.md](docs/compat/upstream-drift-baseline.md)
and doubles as the tool's worked example.

## Validation (three legs, rerunnable)

1. `--selftest` (exit 0 = green): hunk parser (omitted/zero counts),
   classification math on both cite sides, the full citation grammar, the
   path resolver, and an end-to-end run of the real diff plumbing inside a
   temp git repo created and removed under `$TMPDIR`.
2. Hand-verified against a real submodule window (2026-11-14, HEAD~5..HEAD):
   three sampled files checked by reading `git diff -U0` and `git show` —
   the reported shifts are content-verified (`milestone_list.go` cited
   78-92 moved -6; old 72-86 byte-identical to new 78-92; `issue_list.go`
   661 moved -1; `milestone.go` `:35` correctly untouched while `139-200`
   lands in bucket (b)).
3. The baseline artifact above is itself a real-window run with the summary
   numbers reproducible by rerunning the command in its preamble.

## Limits (recorded honestly)

- Cites are line-anchored: a cite whose derivation changed CONTENT but not
  line numbers only surfaces when the hunk overlaps the cited lines — bucket
  (b)'s "re-derive" task is a heuristic trigger, not a proof of divergence.
- Window narrowing attributes an ambiguous cite to a changed candidate; when
  several candidates changed the row moves to the unattributable table.
- The index health section reports unbound shorthands and unresolved tokens;
  they are never silently dropped, but they are also never guessed.
- Shell quoting: paths are read with `core.quotepath=off` and forced
  `a/`/`b/` prefixes (config-proof against `diff.noprefix`).
