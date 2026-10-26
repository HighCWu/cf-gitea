# Stale-pin sweep — window-mount invalidation audit (2026-10-26)

The seven window mounts each invalidated old negative pins that ad hoc fixes
caught (wave-49 blocked_users, wave-9 sitemap, wave-53 user-hooks, wave-14
keys+tags, the ui-router index pins). This sweep asks whether any REMAINING
test assertions still pin paths or families that `parseUiRoute`
(`apps/worker/src/ui/index.ts:2390`) has since claimed. Answer: **yes — five
stale pin lines across four files** (four `toBeNull()` pins and one
positive-form family pin), detailed below. Nothing else in the UI test tree
contradicts the parser's current claims.

## Method

1. **Mechanical evaluation.** Every `parseUiRoute(...)`/`handlesUiRoute(...)`
   assertion carrying a path literal in the 110 test files under
   `apps/worker/src/ui` was evaluated against the live parser (the module
   bundled with the workspace esbuild into a scratch directory outside the
   repo). Assertion forms covered: `toBeNull()` / `toBe(null)` /
   `toEqual(null)`, `.not.toBeNull()`, `toBe(false)` / `toBe(true)` on both
   the parser and the dispatcher gate, positive family pins
   (`toBe("<family>")`, `toEqual({ family: ... })`), `it.each` "does not
   claim" tables, and `[path, null]` parse-table rows (single- and
   multi-line). Totals: 243 literals in negative assertions + 122
   `handlesUiRoute` boolean pins + the positive-family table.
2. **One full run**: `pnpm vitest run src/ui` (all 110 files, workerd).
3. **Solo reruns** of every suite that failed or crashed in the full run, to
   separate stale pins from the documented contention noise (failures that
   pass solo are not pins).

All line numbers below are against the sweep-time tree; `git status` was
checked and none of the cited files carries uncommitted changes (the 29 dirty
paths are sibling waves' page modules).

## Findings — the remaining stale pins

### 1–2. `apps/worker/src/ui/__tests__/pages-wave10.test.ts:236-237`

Test: *"leaves the deeper notifications tails and the same-cased namespace
alone"* (line 233).

```ts
expect(parseUiRoute("/notifications/subscriptions")).toBeNull();  // :236
expect(parseUiRoute("/notifications/watching")).toBeNull();       // :237
```

- **Invalidated by**: window-2e C3b, commit `5ca1727` ("mount the
  subscriptions/watching tails") — `parseUiRoute` now returns
  `{ family: "notification-subscriptions" }` (index.ts:2446) and
  `{ family: "notification-watching" }` (index.ts:2447).
- **Evidence**: the sibling `pages/notifications-subscriptions.matrix.test.tsx`
  already carries the UPDATED pins — its header says "Window-2e C3b mounted
  both tails — the unclaimed pins updated to the claimed shapes exactly as
  the header's mount-wave note promised". The wave-10 file's original pin was
  the one missed. Fails solo (`AssertionError: expected { Object (family) }
  to be null; received { family: "notification-subscriptions" }`).
- **Suggested fix**: flip the two lines to the claimed shapes
  (`toEqual({ family: "notification-subscriptions" })` /
  `{ family: "notification-watching" }`), exactly as the matrix file did — or
  drop them in favor of the matrix file's pins (which also cover the deeper
  `/subscriptions/extra`, `/watching/deeper` tails this test's comment
  worried about).

### 3. `apps/worker/src/ui/__tests__/pages-wave15.test.ts:241`

Test: *"leaves junk tails and the rest of the settings space with the
engine"* (line 236).

```ts
expect(parseUiRoute("/octo/hello/settings/keys")).toBeNull();  // :241
```

- **Invalidated by**: window-2d pass 1, commit `b54f709` ("mount four
  repo-settings tabs") — `parseUiRoute` returns
  `{ family: "settings-keys", owner, repo }` (index.ts:3041). The same
  wave's fix amended `index.test.ts`'s does-not-claim table (its NOTE names
  "window-2d (b54f709)" and the wiki matrix's escalation) but missed this
  twin in the wave-15 suite. Fails solo (`received { family:
  "settings-keys", owner: "octo", repo: "hello" }`).
- **Suggested fix**: delete the line — the block's junk-tail intent is served
  by its other four branches pins — or flip it to
  `toEqual({ family: "settings-keys", owner: "octo", repo: "hello" })`. The
  claim pins for the family live in
  `pages/repo-settings-deploy-keys.smoke.test.tsx` (which already pins the
  deeper `/settings/keys/extra` tail as null).

### 4. `apps/worker/src/ui/__tests__/pages-wave19.test.ts:122`

Test: *"leaves every other /repo and /org tail with their families
(upstream's shadowing order)"* (line 115).

```ts
expect(parseUiRoute("/repo/migrate")?.family).toBe("home");  // :122
```

- **Invalidated by**: window-2e C3a, commit `62ef380` ("mount the migration
  page") — `parseUiRoute("/repo/migrate")` now returns
  `{ family: "repo-migrate" }` (index.ts:2538-2540) instead of falling
  through to the owner/repo `home` family. This is the positive-form variant
  of the stale-pin pattern: not a `toBeNull()` pin but a pin on the OLD
  shadowing family. The wave's fix updated the `/repo/create` and
  `/org/create` pins directly above (lines 109-113 now expect
  `repo-create`/`org-create`) but missed this "other tails" twin. Fails solo
  (`expected 'repo-migrate' to be 'home'`).
- **Suggested fix**: flip to `toBe("repo-migrate")` and update the comment —
  upstream's static `/repo/migrate` registration is now the claimed shape,
  and the shadowed-repo story moves to the `pages/repo-migrate.test.ts`
  claim pins (which pass solo).

### 5. `apps/worker/src/ui/pages/branches.matrix.test.tsx:357`

Test: *"parses the rename write tail to null — engine-owned until the mount
wave (the HANDOFF)"* (line 350).

```ts
expect(parseUiRoute(`/${OWNER}/w100br/branches/rename`)).toBeNull();  // :357
```

- **Invalidated by**: window-2e folds, commit `635ce2e` ("the branches writer
  arms, pulls/new redirect, upload endpoints") — `parseUiRoute` returns
  `{ family: "branch-rename", owner, repo }` (index.ts:3222). The test is a
  declared HANDOFF pin ("the mount wave flips them deliberately") whose
  mount arrived without the flip. Fails solo (`received { family:
  "branch-rename", owner: "w100gal", repo: "w100br" }`).
- **Suggested fix**: flip per the test's own mount-wave note —
  `toEqual({ family: "branch-rename", owner: OWNER, repo: "w100br" })` —
  keeping or renaming the describe block ("the unmounted POST arms" no
  longer describes a mounted arm).

## Families checked — no remaining pins

Every path family from the sweep brief was searched among negative-pinned
literals; counts are pins evaluated against the live parser:

| Family | Pins found | Verdict |
| --- | --- | --- |
| `settings/hooks/git` (githooks) | 0 | clean — no pin ever written |
| `settings/tags` (+ delete/detail) | 0 | clean — wave-14 fix caught all copies |
| `settings/keys` | 3 | **1 stale** (finding 3); the 2 deeper-tail pins valid |
| `settings/public_access` | 2 | valid (deeper `/extra` tail only) |
| `settings/wiki` (+ `/wikis` misspelling) | 3 | valid |
| `upload` (file-upload family) | 0 | clean |
| `patch/` (editor-patch) | 0 | clean |
| `cherrypick/` | 0 | clean |
| `repo/migrate` | — | **1 stale positive-form pin** (finding 4); `repo-migrate.test.ts` claim pins themselves pass solo |
| `repo/search` (search aux) | 0 | clean |
| `issues/search`, `issues/suggestions` (aux feeds) | 0 | clean |
| `activity_author_data` | 0 | clean |
| `merge_box` | 0 | clean |
| `/issues`, `/pulls` (incl. top-level literals) | 17 | valid (deeper/unclaimed tails: `/pulls/new`, `/pulls/labels`, `/files/reviews*`, `-1.diff`, `abc.diff`, `7.exe`, `7.diff/x`, `issues/1/commits`, `request_review/*`) |
| `/milestones` (incl. top-level) | 7 | valid (deeper write tails `/{id}`, `/{id}/close`, `/delete`) |
| `notifications/subscriptions`, `notifications/watching` | 4 | **2 stale** (findings 1–2); the matrix file's 2 deeper-tail pins valid |
| `.rss` / `.atom` (owner + releases/tags tails) | 2 | valid (`releases/.rss`, `tags.rss` — both genuinely unclaimed) |
| `sitemap.xml` | 0 | clean — the wave-9 fix caught all copies (index.test.ts's NOTE documents it) |
| `wiki` non-excerpt tails | 0 | clean — the unshadow fix (`a58cad5`) flipped the wiki matrix, no stale residue |

Beyond the brief's list, the full mechanical sweep covered every other
claimed family; the only additional contradiction class found was
`handlesUiRoute` boolean pins (122 literal pins — zero contradictions) and
positive `toBeNull` pins (`.not.toBeNull()` forms — all consistent).

## Non-literal (loop/variable) pin sites — all verified clean

Nine sites build paths in loops or variables and were enumerated by hand,
their arrays evaluated through the live parser:

- `pages/admin-monitor.test.tsx:711-712` — `["/-/admin/monitor",
  "/-/admin/monitor/statz", "/-/admin/monitor/stats/extra"]` — all unclaimed.
- `pages/org-settings.matrix.test.tsx:583-589` — misspelling/deeper tails
  (`renamed`, `avatar/upload`, `delete/confirm`, `visibility/private`) — all
  unclaimed.
- `pages/settings-collaboration.matrix.test.tsx:734-741` — deeper collab
  tails + `/collaborations` misspelling — all unclaimed.
- `pages/user-profile.matrix.test.ts:357-361` — top-level literals,
  reserved owners, `.keys`/`.gpg` — all unclaimed.
- `pages/pull-files.matrix.test.tsx:457,469,473,476` — single sha on
  `/files`, range under `/commits`, uppercase-hex variants — all unclaimed
  (the range/single-commit grammars are lowercase-hex only,
  `pages/pull-files-single-commit.ts:105`).
- `__tests__/pages-wave2.test.ts:174-188` and `ui/index.test.ts:156-191`
  it.each "does not claim" tables — every literal still unclaimed (the two
  window-claimed pins were already removed; the NOTE at index.test.ts:185
  documents that practice).

Template-literal paths with interpolation were checked at their real values
(`commit/${"a".repeat(64)}.diff` → `commit-diffpatch`;
`commit/${"a".repeat(64)}/load-branches-and-tags` → `commit-contained-refs` —
both match their tests' expectations).

## Full-run classification (`pnpm vitest run src/ui`, 2026-10-26)

Full run: **822 tests — 4 failed, 818 passed**, plus 75 unhandled
"Worker exited unexpectedly during started state" errors (contention: 111
isolate workers spawned; crashed files report no results). Every failure and
every crash that touches this sweep's scope was solo-rerun:

| Suite | Full run | Solo run | Verdict |
| --- | --- | --- | --- |
| `__tests__/pages-wave15.test.ts` | 1 failed | 1 failed (24 pass) | **STALE PIN** (finding 3) |
| `__tests__/pages-wave19.test.ts` | 1 failed | 1 failed (17 pass) | **STALE PIN** (finding 4) |
| `pages/branches.matrix.test.tsx` | 1 failed | 1 failed (11 pass) | **STALE PIN** (finding 5) |
| `__tests__/pages-wave10.test.ts` | worker crashed (assertions never ran) | 1 failed (17 pass) | **STALE PINS** (findings 1–2) |
| `pages/activity-feeds.matrix.test.tsx` | 1 failed (`comment_pull` anchor: `/issues/9#…` vs expected `/pulls/9#…`) | 35/35 PASS | contention noise — not a pin, not a real failure |
| `pages/notifications-subscriptions.matrix.test.tsx` | worker crashed | 20/20 PASS | noise (its pins are the updated ones) |
| `pages/repo-migrate.test.ts` | worker crashed | 21/21 PASS | noise |
| 72 other files' worker crashes | no results | — | contention noise (crash spread over suites with no sweep relevance) |

Bottom line: **four failing assertions solo — exactly the four stale-pin
tests of findings 1–5** (wave10's single test holds two pin lines) — and
nothing else in the tree contradicts the parser.

## Sweep method notes

- The scanner treated `.not.toBeNull()` as a positive pin (one false
  positive at `notifications-subscriptions.matrix.test.tsx:275` before the
  `.not.` guard — kept here so the next sweep does not repeat it).
- Scratches (esbuild bundle, scanner scripts) live outside the repo; no test
  file or source file was touched by this sweep. `node
  scripts/check-openapi.mjs` re-verified PASS after the sweep (no code
  changed).
- Suggested fixes are proposals only — test files are outside this wave's
  ownership.
