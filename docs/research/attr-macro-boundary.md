# The attr-macro boundary decision (P2-8)

Where does `.gitattributes` MACRO ATTRIBUTES expansion belong — the engine's
attribute matcher or the worker-side archive walk? Decision recorded
2026-10-31; implementation: `packages/git-engine/src/git/attributes.ts` +
the worker walk's consumption in `apps/worker/src/api/services/archive.ts`.

## Decision

**Macro expansion belongs in the attribute MATCHER — and the matcher lives in
the engine package** (`src/git/attributes.ts`, exported through mod.ts). The
worker's archive walk threads one macro registry through its per-directory
parses and resolves the EXPANDED rules unchanged.

The first half is git's own design: macros are a gitattributes-language
feature (gitattributes(5) "MACRO ATTRIBUTES" / "DEFINING MACRO ATTRIBUTES"),
implemented in git's attr.c — a libgit layer every consumer (check-attr,
archive, diff) asks for expanded attributes. Expansion never belongs in a
consumer loop, and it is not a blob-byte concern (unlike export-subst's
`$Format:…$` rendering, which is expansion OF the content, not OF the
language).

The second half (which package hosts the matcher) needed the layering
verified, because the board row's premise — "packages/git-engine's
attr-pattern compilation — the 5365236 record names it" — is wrong as-built:
5365236 compiled the matcher IN THE WORKER
(`apps/worker/src/api/services/archive.ts`: parseGitattributes +
compilePattern + ruleMatches + the two resolvers; verified by grep — the
engine had no attribute module in src or dist-types), and the record's
"engine-side expansion is the recorded future arm" phrase referred to
export-SUBST's byte rendering, which 761ff28 then deliberately landed
WORKER-side ("the engine untouched, no NOTICE row owed"). The two sibling
arms prove the worker was the path of least movement; they do not decide the
LANGUAGE's home. The deciding facts:

1. **The repo's established pattern**: every git-semantics re-implementation
   lives engine-side with a real-git tsx check as its gate — blame
   (git/blame.ts + check-blame), merge primitives (merge/* +
   check-merge-graph/tree/engine), patch-id (merge/patchid.ts), object
   serialization (commit/serialize.ts), tag reads (repo.ts readTag +
   check-tag-read). The attributes language is exactly that kind of unit
   (git's attr.c analog), and engine placement makes the new check able to
   drive the REAL matcher under tsx with git as the live oracle — the check
   this arm owes.
2. **Future consumers**: LFS's `filter=lfs` detection, editorconfig/language
   surfaces, and the engine's own (currently attribute-blind) snapshot
   builders all read the same language; worker-private placement forces
   duplication the first time any of them lands.
3. **The engine boundary cost is one export set**: mod.ts gained the five
   matcher symbols + two types; dist-types regenerate via `pnpm typecheck`.
   The sibling-recorded "mod.ts frozen by the P2-8 policy" (NOTICE 2026-10-31
   row, P3-11's TagJson deviation) was a same-window discipline against
   gratuitous re-exports; this arm is the P2-8 policy's own unit landing its
   decided shape (the mission's decided shape is engine-side expansion +
   unchanged worker consumption), so the freeze folds here — recorded in
   NOTICE.md.

## What moved, what changed

- `parseGitattributes`, `ruleMatches`, `exportIgnoreExcluded`,
  `exportSubstActive`, `GitattributesRule` moved VERBATIM from the worker's
  archive service into `src/git/attributes.ts` (pattern compilation and the
  last-match-wins resolution are untouched — 5365236's pinned subset
  posture stands, including the documented `[...]`/brace/escape reductions).
- NEW: the macro registry (`AttrMacros`, `createAttrMacros()` seeded with
  git attr.c's builtin `[attr]binary -diff -merge -text`) and macro
  expansion at parse time (two-pass per file: definitions register from the
  TOP-LEVEL file only, then pattern lines compile with their states —
  direct assignments and macro expansions — resolved per the pinned model
  below). The worker walk's only call-site delta: `parseGitattributes(text,
  prefix, macros)` with one registry threaded root→leaf.

## The pinned expansion model (stock git 2.43.0, fixture repos)

Every arm byte-observed via `git archive HEAD` tar listings and
`git check-attr` (the differential is automated as
`packages/git-engine/e2e/check-archive-attrs.mjs`, 24 checks, mutation-
checked both ways):

1. **Across lines/files**: rules apply root→leaf, file order within a file;
   the LAST matching assignment wins (5365236's model, unchanged).
2. **Within one line**: git's fill walks the line's attribute states from
   LAST to FIRST, first assignment wins; a macro token sets its attribute
   then immediately expands its body with the same right-to-left walk over
   the same filled set. Observed: `f a b` with `[attr]a export-ignore` +
   `[attr]b -export-ignore` → export-ignore UNSET (rightmost macro won);
   `f export-ignore m` + `[attr]m -export-ignore` → UNSET (macro body beat
   the leftward explicit token); `f m export-ignore` + same macro → SET;
   plain duplicates `f export-ignore -export-ignore` → UNSET.
3. **Expansion rides the expanding line's position**: `[attr]m
   export-ignore` / `f m` / `f -export-ignore` keeps the file; the reverse
   order drops it. Macros never preempt later lines.
4. **Definitions are top-level-only** (gitattributes(5)): a `[attr]` line in
   a deeper .gitattributes is ignored — git 2.43 prints a localized
   "not allowed" warning; our matcher skips silently (the walk has no
   stderr channel; the 5365236 `!pattern` posture).
5. **Parse-then-resolve**: a use line ABOVE its `[attr]` definition still
   expands; a REdefinition overwrites (last wins).
6. **Only a SET value expands** ("macro attributes can only be Set"):
   `m=x`, `-m`, `!m` on a path never expand. Undefined names are ordinary
   attributes (no expansion, no effect).
7. **Cycles terminate silently** (`[attr]a b` + `[attr]b a`): no diagnostic,
   no die — git's already-set guard; our seen-set reproduces it.
8. **`!attr` inside a macro body** is the unspecified value and beats an
   earlier set (observed: `*.q export-ignore` + `[attr]m !export-ignore` +
   `f.q m` → unspecified).
9. **The builtin binary macro**: seeds the registry; archive-neutral alone
   (`f.png binary` archives fine); recurses through user chains
   (`[attr]a binary export-ignore` expands binary AND sets export-ignore);
   a user `[attr]binary` line REPLACES it (observed: text/diff become
   unspecified while export-ignore sets).
10. **Directory semantics unchanged**: a directory-level export-ignore (set
    directly or via a macro) prunes the whole subtree — a deeper per-file
    re-include cannot resurrect it (git archive never reads attributes
    inside a pruned subtree; observed: `/dir export-ignore` + a macro
    re-including dir/keep.txt still archives nothing from dir/, even though
    check-attr says unset there).
11. **Macro-carried export-subst is live**: git archive EXPANDS `$Format:%H$`
    when the attribute arrived through a macro or a transitive chain; the
    worker's export-subst rendering consumes our expanded flag unchanged.

## Disclosed behavior deltas (the move)

- Duplicate-token lines (`f export-ignore -export-ignore`) now resolve
  right-to-left like git (the moved code previously took the leftmost) —
  pathological lines, pinned both arms.
- `[attr]` lines compile nothing (as before) but now DEFINE (root file);
  the old white-box pin "macro lines produce no rules" flipped accordingly
  (definitions register; rules still don't compile from definition lines).

## Gates

- `packages/git-engine/e2e/check-archive-attrs.mjs` — 24/24 vs real git
  archive (mutation: left-to-right scan fails the 3 ordering fixtures;
  seen-guard removal fails the cycle fixture).
- `apps/worker/src/api/archive.test.ts` — the 23-test export-subst baseline
  unregressed + the macro route/white-box arms.
- `pnpm typecheck` regenerates dist-types with the new module; NOTICE.md
  records the module addition + the mod.ts unfreeze-for-this-arm.
