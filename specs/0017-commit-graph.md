# SPEC-0017: The commit-graph page — the `graphData` engine RPC and `GET .../graph`

Status: **accepted** (ratified 2026-10-29, orchestrator — decisions appended at §8) (R09-SPEC unit, 2026-10-29 — for orchestrator ratification) ·
Date: 2026-10-29 · Fills census row R09
([docs/compat/ui-gap-census-2026-10-29.md](../docs/compat/ui-gap-census-2026-10-29.md):
`GET .../graph` (ABSENT), size L, the two-step: an in-DO lane/position RPC +
the UI page and the Commits-page anchor). Depends on: SPEC-0001/0001a (engine,
the content-path read lease), SPEC-0001b (the merge primitives whose merge
commits are the graph's interesting rows), SPEC-0003 §2.5 (ACL gate over
engine RPCs), the landed blame
RPC as the boundary idiom (R08) and the landed grep RPC as the
budget-constants idiom (R10 — SPEC-0015 §3.1, already at the boundary,
`packages/git-engine/dist-types/repo.d.ts:499-503`). The heatmap JSON route
(`apps/worker/src/ui/pages/owner-heatmap.ts` + its `index.ts` registration) is
the UI precedent this page follows — with one load-bearing difference recorded
in §2: the graph's client refresh fetches an HTML FRAGMENT of the page itself,
not JSON, so the fragment arm is part of the route, not a sibling data route.

Owns: one engine boundary RPC (`graphData`) with its budget constants and the
multi-tip walk it needs, the `pages/graph.tsx` page + its route family (the
`/{owner}/{repo}/graph` GET including the `?div-only=true` fragment arm), the
Commits-page "Commit Graph" anchor, and the five `repo.commit_graph*` locale
keys. No D1 schema, no new tables.

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY, pin
`fc4936884584a41931906553d96c2601d750e6ef` — v1.22.0-rc1-3919-gfc493688). Every
`web.go:N` cite is `gitea/routers/web/web.go` at that pin; engine findings are
against `packages/git-engine/src/**` as of 2026-10-29.

---

## 1. Problem and scope

The census's R09 row: upstream serves a commit-graph page — SVG lanes
(color/monochrome), paginated, branch filter (`?branch=`), hide-PR-refs, file
filter — backed by a gitgraph service that runs `git log --graph` and parses
the ASCII art into lanes. We have no git binary and no DAG-position machinery
anywhere: the boundary's `listLog` walks one tip (`packages/git-engine/src/repo.ts:1258`),
and while `CommitJson` carries parents (repo.ts:197-205 — the raw material the
census names), nothing computes lanes, columns, or colors.

In scope:

- **The `graphData` boundary RPC** (§3): the census's step 1 — a date-ordered
  multi-parent walk inside the DO (budget-capped, the `walkLog` frontier
  discipline generalized to N tips) with lane/position assignment computed
  in-DO, so the page receives render-ready rows.
- **The `GET .../graph` page** (§4): the census's step 2 — SSR SVG lanes over
  the RPC + the rev-list rows + pagination + the branch/hide-PR filters + the
  Commits-page anchor.
- **Edge cases** (§5) and **tests** (§6).

Out of scope (each named so it is not silently re-decided):

- **The `?file=` path filter arm** (upstream `ctx.FormStrings("file")`,
  commit.go:129, fed to the walk as `--` pathspecs, graph.go:47-49): v1
  honest-absent — the census already carved this out ("the upstream file
  filter arm can honest-absent on the first slice"). The UI renders no file
  input; a `?file=` param is ignored (Open question 5).
- **Per-commit identity enrichment on graph rows** — upstream's
  `LoadAndProcessCommits` joins email→user, builds avatar stacks, computes
  signature verification and per-commit CI status
  (graph_models.go:96-144). v1 rows carry git identities only (Open
  question 4); the enrichment is D1-side work that does not change the RPC.
- **Any API v1 surface** — upstream's `/api/v1` has no graph endpoint; this
  is a web-only family. The API-side engine wrapper
  (`apps/worker/src/api/services/engine.ts`) is untouched.
- **Upstream's commit-status badges and sign badges on graph rows**
  (`repo/commit_sign_badge`, graph/commits.tmpl:9-11): rides the identity
  enrichment cut.

## 2. Upstream mechanism vs our substrate

### 2.1 The upstream mechanism at the pin

**Route.** `m.Get("/graph", repo.Graph)` (web.go:1738) in a bare group with
`repo.MustBeNotEmpty` (web.go:1737-1744) — note there is NO
`context.RepoRefByType` middleware on this route: the URL carries no ref
suffix, ever. The handler is `repo.Graph` (`gitea/routers/web/repo/commit.go:106`).

**Handler arms** (commit.go:107-173):

- `mode` — `strings.ToLower(ctx.FormTrim("mode"))`, anything but
  `"monochrome"` normalizes to `"color"` (commit.go:110-113). It selects a CSS
  class, not a data shape.
- `hide-pr-refs` — `ctx.FormBool` (commit.go:115); `branch` —
  `ctx.FormStrings` (commit.go:117), each entry prefixed to
  `refs/heads/…` unless already `refs/`-prefixed (commit.go:120-127);
  `file` — `ctx.FormStrings` (commit.go:129).
- **Count with a bad-ref retry**: `GetCommitGraphsCount` (commit.go:130-142);
  on error with selected branches it retries with `branchRefs = nil` — the
  comment names the cause ("fatal: bad revision" for a deleted branch) and
  keeps the retry as harmless. A second failure is a ServerError 500.
- The walk: `gitgraph.GetCommitGraph(ctx, gitRepo, page, 0, hidePRRefs,
  branchRefs, files)` (commit.go:144-150) — `maxAllowedColors` passed as **0**
  (the parser then seeds a two-entry color pool, graph.go:63-70; see below).
- `graph.LoadAndProcessCommits` (commit.go:151-154) — the enrichment pass.
- `AllRefs` = `GitRepo.GetRefs` (commit.go:158-164) for the branch dropdown.
- `div-only` + pager: `ctx.FormBool("div-only")` (commit.go:166-173) — when
  set, the response is `tplGraphDiv` (the `#git-graph-body` INNER content
  only); otherwise the full `tplGraph` page. The pager is
  `NewPagerBuilder(...).TotalCount(graphCommitsCount).
  PerPageLimit(setting.UI.GraphMaxCommitNum).CurPage(page)` with
  `div-only` stripped from the pager params (commit.go:167-169).

**The count.** `GetCommitGraphsCount`
(`gitea/services/context/repo.go:284-298`) is a cached
`rev-list --count`: with no selected refs it is `AllCommitsCount` —
`git rev-list [--exclude=refs/pull/*] --all --count`
(`gitea/modules/git/commit2.go:71-89`, the exclude at :73-75); with selected
refs it is `CommitsCount` over those revisions. Cache key
`git-commits-graph-count:<repoID>:<hidePRRefs>` hashed with the refs+files
blob (repo.go:288-290). The pager's total counts COMMITS, and page size is
`setting.UI.GraphMaxCommitNum` — default **100**
(`gitea/modules/setting/ui.go:23`, `:95`).

**The walk invocation** (`gitea/services/repository/gitgraph/graph.go:20-49`):

```
git log --graph --date-order --decorate=full
    [--exclude=refs/pull/*]          # only when hidePRRefs (graph.go:32-34)
    [--tags --branches]              # only when refs is empty (graph.go:36-38)
    --find-copies --find-renames --date=iso-strict
    -n <GraphMaxCommitNum * page>
    --pretty=format:DATA:^%D^%H^%ad^%h^%s
    [<refs…>] [-- <files…>]
```

Two semantics worth pinning exactly:

- The default tip set is `--tags --branches` (graph.go:36-38) — **NOT
  `--all`**: remote-tracking refs and `refs/pull/*` are NOT walked unless
  explicitly selected. `--exclude=refs/pull/*` (graph.go:32-34,
  `git.PullPrefix = "refs/pull/"`, `gitea/modules/git/ref.go:21`) only ever
  bites ref EXPANSION, so on the default walk it is a no-op; it matters for
  the count (`--all` side) and for the render-side chip rule (below).
- Pagination is a single walk answering pages 1..N at once: `-n 100*page` with
  `commitsToSkip = 100*(page-1)` consumed INSIDE the parse stream
  (graph.go:52, :71-82). The skip loop still feeds every skipped line through
  `parser.ParseGlyphs` (graph.go:81) — **lane/flow state survives the page
  boundary**, and only lines whose `*` precedes `DATA:` decrement the skip
  counter (graph.go:77-80), i.e. pure-graph lines are free. After the skip,
  the first `*`-bearing line starts the rows (graph.go:84-96) and every
  subsequent line — with or without a commit — becomes one row (graph.go:98-104,
  `row++`).

**The parser** (`gitea/services/repository/gitgraph/parser.go`) — a stateful
glyph-flow machine. Each output line is split on `DATA:` (parser.go:47-53);
the glyph prefix drives flow bookkeeping per column (`|`/`*` → setUpFlow,
`/` → setOutFlow, `\` → setInFlow, `_` → setRightFlow, `.`/`-` → setLeftFlow,
default → newFlow; parser.go:167-188), with hand-derived preference orders per
glyph (parser.go:243-257, :260-283, :286-307, :310-324, :327-336). Each
in-use column carries a flow id and a color; `newFlow` allocates a fresh flow
id and takes the next color from a rotating pool (parser.go:211-240) that
`releaseUnusedColors` recycles (parser.go:100-143). A line with glyphs but no
`*` still lands as a row — a `RelationCommit` placeholder (parser.go:94-96;
`Row == -1` marks it, graph_models.go:204-207, :276-279). A `*` commits the
line's `DATA:` payload via `NewCommit` (graph_models.go:218-237): `%D`
decorations split on `, ` with `tag: ` and `HEAD -> ` prefixes stripped
(graph_models.go:239-257), `%H` full oid, `%ad` author date parsed as RFC3339
(`--date=iso-strict`; parse failure → epoch, graph_models.go:209-215), `%h`
short oid, `%s` subject. The model accumulates per-flow glyph lists and
per-commit coordinates into `Graph{Flows, Commits, Min/MaxRow/Column}`
(graph_models.go:37-55, :58-91), and colors surface as
`Flow.ColorNumber` with `Color16() = ColorNumber % 16`
(graph_models.go:170-173).

**The templates — SSR SVG, not client-side JSON.** `templates/repo/graph.tmpl`
renders the full page: `#git-graph-container` (the mode class on it,
graph.tmpl:5), the `#flow-select-refs-dropdown` fomantic
multiple-selection dropdown whose items are the `...flow-hide-pr-refs`
sentinel plus every `AllRefs` entry grouped pull/tags/remotes/heads with
`data-value="{{.Name}}"` — the FULL ref name (graph.tmpl:9-42), the
`#flow-color-monochrome`/`#flow-color-colored` buttons (graph.tmpl:43-44), and
`#git-graph-body` holding three children (graph.tmpl:47-51):
`repo/graph/svgcontainer` + `repo/graph/commits` + `base/paginate`.

- `svgcontainer.tmpl` renders ONE `<svg>` from the parsed model:
  `viewbox="MinColumn*5 MinRow*12 Width*5+5 Height*12"`, `width="Width*10+10px"`
  — i.e. 5px per column / 12px per row in user units, rendered at 2x so each
  logical row is 24px on screen, matching the rev-list rows
  (`#git-graph-container li { height: 24px }`, web_src/css/features/gitgraph.css:26-33).
  Each flow is one `<g class="flow-group flow-color-16-{Color16}">` whose
  `<path d>` is assembled from its glyphs (`*`/`|` → `M col*5+5 row*12 v12`;
  `/` → `M col*5+10 row*12 l-10 12`; `\` → `M col*5 row*12 l10 12`;
  `-`/`.` → `M col*5 row*12+12 h5`; `_` → `M col*5 row*12+12 h10`), plus one
  `<circle r="2.5">` per commit at `(col*5+5, row*12+6)`.
- `commits.tmpl` (graph) renders the parallel `<ul id="rev-list">`: one `<li>`
  per row, `data-flow` tied to the SVG group, relation-only rows an empty
  `<span>` (graph/commits.tmpl:5-6), real rows carrying the sign badge, the
  rendered subject, ref chips per group — the pull chip SURFACED only when
  `not HidePRRefs` or the ref is explicitly selected
  (graph/commits.tmpl:17-41, the gate at :21) — the avatar stack and the full
  author time (:43-47).

**The JS** (`web_src/js/features/repo-graph.ts`, registered
`web_src/js/index.ts:7` + `:134` — it runs on every page load and returns
early unless `#git-graph-container` exists, repo-graph.ts:6-7):

- Color mode is pure client CSS: `toggleColorMode` flips `monochrome`/`colored`
  classes on the container and the buttons, `history.replaceState`s `?mode=`,
  and rewrites every pagination link's href (repo-graph.ts:11-32). The
  monochrome stroke/fill override is one CSS rule
  (gitgraph.css:82-84 → `--color-secondary-dark-5`); the 16 color classes map
  to `--color-series-16-N` (gitgraph.css:87-166).
- Filter changes are **HTML-over-the-wire**: `loadGitGraph` GETs the page URL
  with `div-only=true` and swaps `elGraphBody.innerHTML` with the response
  TEXT (repo-graph.ts:34-50). No JSON route exists anywhere in this family.
- The dropdown is fomantic: selected values seed from the URL's `branch` params
  plus the hide-PR sentinel, and `onAdd`/`onRemove` rewrite the URL params and
  re-fetch the fragment (repo-graph.ts:52-84).

Note the non-null assertions at repo-graph.ts:9-10 and :34 — once
`#git-graph-container` exists, the bundle EXPECTS the buttons, the dropdown
and `#git-graph-body` to exist with it; a partial DOM throws during init. A
page either reproduces the full structure or omits the container entirely.

**Mechanism verdict (the census's render-policy note corrected):** the census
§"Open issues" item 4 says upstream renders the graph client-side. At the pin
it does NOT: the SVG and the rows are SERVER-rendered from the parsed `git
log --graph` stream; only the REFRESH is client-driven, and it is a plain HTML
fragment swap (`div-only=true`), not a JSON data route. The heatmap (R03) is
the JSON case — the official bundle fetches `/-/heatmap` and renders the grid
itself; the graph is the HTML-partial case. Our page follows upstream's own
shape (§4), which also decides the census's "decide once, apply tree-wide"
question for this row: SSR the SVG, host the official JS, and serve the
fragment arm the JS fetches.

### 2.2 Our substrate (verified) and the gap

- **The walk.** `walkLog` (`packages/git-engine/src/repo.ts:1874-1903`) is a
  frontier walk: `peelToCommit` the tip, seed the frontier, per iteration sort
  by committer time DESC (`frontier.sort((a, b) => b.commit.committer.time -
  a.commit.committer.time)`, repo.ts:1891 — a STABLE sort per ES2019+, so
  date ties keep insertion order), pop, filter, push unseen parents
  (repo.ts:1896-1899), bounded by `MAX_LOG_SCAN = 5000` pops or
  `PATH_LOG_SCAN = 2000` for path filters (repo.ts:121, :123, :1884). It
  starts from ONE tip; the graph needs N tips seeded into one frontier — a
  generalization, not a rewrite (the dedup and sort machinery is identical;
  `walkTreeCommits` repo.ts:1905-1948 already demonstrates the
  same-walk-different-answer pattern).
- **The commit data.** `CommitJson` (repo.ts:197-205) carries oid, tree,
  `parents: string[]`, author and committer `Person{name, email, time, tz}`
  (`packages/git-engine/src/git/objects.ts:24-30`), subject, message —
  everything the rows need except decorations.
- **Decorations.** `listRefs()` → `RefsResult{head, refs: [{name, target,
  peeled?}]}` (repo.ts:192-195; boundary `repo.d.ts:42-46, :430`) — the
  target→refs map is a fold the RPC performs; `head` gives the HEAD chip;
  `peeled` resolves annotated tags.
- **Budget constants family** (repo.ts:118-165): LOG_PAGE 50, MAX_LOG_SCAN
  5000, PATH_LOG_SCAN 2000, MAX_STATS_SCAN 2000, MAX_DIFF_BLOB 512 KiB, plus
  the SPEC-0015 grep family (MAX_GREP_FILES/…, repo.ts:137-159) as the
  documented-constants idiom. New graph constants join this block (§3).
- **The boundary idiom** — the blame RPC
  (repo.ts:1385-1390 entry: `this.rpcBind()` →
  `this.withContentLease(async (gate) => …)` → `resolveRef` → `peelToCommit`;
  declaration repo.d.ts:457-477) and the grep RPC after it (repo.d.ts:479-503)
  fix the shape every new RPC follows: null on hard-absence, `truncated` on a
  budget exit — never null for budget ("a budget-bounded WALK is not `null`",
  repo.d.ts:464-468).
- **The UI seam.** `apps/worker/src/ui/engine.ts` — the `EngineClient`
  interface (ui/engine.ts:46-64) enumerates every boundary read explicitly and
  wraps each in `safe()` (null on transport failure, ui/engine.ts:68); new
  RPCs append to this interface AND its implementation. The worker loads the
  official bundle's JS on every page (`ctx.assets.iifeUri`,
  `apps/worker/src/ui/shell.tsx:128`) — the DOM-parity posture the heatmap
  ride proved (its `#user-heatmap` div + `data-heatmap-url` feed the bundle's
  `initHeatmap`; the JSON route:
  `apps/worker/src/ui/pages/owner-heatmap.ts` +
  `apps/worker/src/ui/index.ts:1886-1896` family, `:3362-3369` parser claim,
  `:8190-8207` handler).
- **The page conventions.** The commits page
  (`apps/worker/src/ui/pages/commits.tsx`): page size 50
  (commits.tsx:27), `?page=N → ofs=(N-1)*50` via `parsePageNumber`
  (`apps/worker/src/ui/page-data.ts:296-301`), Newer/Older links driven by
  `LogResult.more` (commits.tsx:90-112), the `repo-button-row` the anchor
  joins (commits.tsx:133-135). Route families claim literal heads in
  `matchRepoRoute` — `head === "commits"` at index.ts:4360 is the pattern the
  `head === "graph"` claim copies.

**The gap, precisely:** nothing computes lanes/columns/colors; nothing walks
more than one tip at the boundary; no `/graph` route, page, anchor, or locale
keys exist. The census's two-step stands, with one correction to its step-1
sketch recorded in §3 (the `ref` parameter).

## 3. The `graphData` RPC contract

Follows the blame/grep idiom exactly (§2.2): `this.rpcBind()` at entry, the
whole read inside `this.withContentLease(async (gate) => …)`, `resolveRef`/
`peelToCommit` for every tip, and the availability ladder — `null` on
hard-absence, `truncated` on any budget exit, never `null` for budget.

**Signature** (PROPOSAL — deviates from the census sketch
`graphData(ref, {limit, page, refs?, hidePRRefs?})`; the reason: the page URL
carries no ref (§2.1) and upstream's walk is multi-ref by construction, so a
lone `ref` parameter has no upstream meaning; the parameter list collapses
into one opts object):

```ts
graphData(opts?: {
  refs?: string[];        // full ref names (or bare branch names, the
                          // handler's commit.go:120-127 normalization applies
                          // at the PAGE layer; the RPC takes full names)
  page?: number;          // 1-based; default 1
  limit?: number;         // commits per page; default 100, clamped 1..100
  hidePRRefs?: boolean;   // drop refs/pull/* tips (default false)
}): Promise<GraphDataResult | null>;
```

### 3.1 Tips

- `refs` absent/empty → the DEFAULT tip set: every `refs/heads/*` and
  `refs/tags/*` from `listRefs()` — the `--tags --branches` semantics
  (graph.go:36-38). Remotes and pull refs are excluded unless explicitly
  named (the dropdown lists pull/tags/remotes/heads items with full-ref
  `data-value`s — graph.tmpl:19-38).
- `hidePRRefs` → `refs/pull/*` tips are dropped from the tip set (the
  `--exclude=refs/pull/*` analog, graph.go:32-34); explicitly named pull refs
  SURVIVE the filter, matching upstream where `--exclude` never touches
  explicit revs — the render-side chip rule (§4.2) carries the visible part.
- Resolution: each tip `resolveRef` → `peelToCommit` (annotated tags peel);
  unresolvable tips are SKIPPED silently. If EVERY requested tip is
  unresolvable, the RPC falls back to the default tip set — upstream's
  bad-ref retry (commit.go:130-142) — and only an empty repo (no refs at
  all, unborn HEAD) returns `null` (the page 404-shells; `MustBeNotEmpty`
  upstream, web.go:1737).
- Dedup: tips resolving to the same oid seed once; their decorations merge.

### 3.2 The walk (in-DO, budget-capped)

The `walkLog` frontier generalized to N seeds — the census's "walkLog frontier
discipline":

1. Seed the frontier with every tip's `{oid, commit}`; `seen` = tip oids.
2. Loop: sort the frontier by committer time DESC (the stable-sort tie rule,
   repo.ts:1891 — the `--date-order` analog; git sorts by committer date
   too), pop, assign the row (§3.3), then push each unseen parent
   (`loadCommit` under the gate).
3. Budgets (new constants in repo.ts's block, documented like the grep
   family):
   - `MAX_GRAPH_SCAN = 20000` pops per request — the walk ALWAYS starts at
     row 0 and pages are skip-windows inside one walk (upstream's
     `-n 100*page` + in-stream skip, graph.go:41, :52, :71-82); a page-N
     request walks `(N-1)*limit` skip pops + up to `limit` row pops. Past the
     cap the walk stops with `truncated: true` (the honest-partial rule;
     repo.d.ts:464-468's "budget-bounded WALK is not null").
   - `MAX_GRAPH_REFS = 500` tips seeded — a repo with more heads+tags walks
     the first 500 (listRefs order) and flags `truncated`.
   - `MAX_GRAPH_LANES = 128` simultaneously-open lanes — lane allocation
     beyond the cap stops the walk with `truncated` (rows so far are
     returned). Upstream is unbounded (the parser grows flows freely); the
     cap bounds the row-edge arrays a pathological repo would produce.
   - `limit` clamped 1..100 (upstream's `GraphMaxCommitNum`, ui.go:95 — we do
     not expose the setting; the default is the upstream default).
4. Skip mechanics: skip `(page-1)*limit` COMMIT pops — pure-lane rows do not
   count toward the skip (upstream counts only `*`-lines, graph.go:77-80).
   Lane state accumulates across the skip exactly as upstream's parser state
   does (graph.go:81), so page N's lanes continue page N-1's seamlessly.
5. The count: the walk continues past the page window after the rows fill —
   count-only pops (lane assignment stops at the window; a pop past it is one
   small commit read) until the frontier empties or the cap trips.
   Exhaustion inside `MAX_GRAPH_SCAN` yields the exact total commit count
   (`total`); the cap tripping first yields `total: null` + `truncated`
   (upstream's count is `rev-list --count` — a FULL walk,
   repo.go:291-297 — which we cannot afford unbounded; the honest answer is
   the null total, not a fake one). No cache v1 — the answer is page-shaped
   and tip-set-shaped (query-keyed, the grep rule); upstream caches only the
   count (repo.go:288-290) and we have no count to cache when total is null.

### 3.3 Lane assignment (the in-DO layout)

PROPOSAL — a standard lane-assignment over the parent graph at pop time (the
git `graph.c` model), NOT a port of upstream's glyph parser: the parser
parses ASCII art git already drew; we have no git to draw it, so porting it
would mean first SYNTHESIZING the art — a pointless detour. The visual output
is equivalent (lanes, dots, diagonal bends on the same 5px/12px grid); the
geometry differences are ledger-noted in Open question 2.

State: `lanes: Array<{ target: string; color: number } | null>` — slot i is
lane column i; `target` is the oid the lane currently descends toward;
`color` the lane's color NUMBER (monotonic counter — unique per lane like
upstream's flow ids feeding `ColorNumber`, graph_models.go:170-173; the CSS
class is `color % 16`, the `Color16` analog). Per popped commit C:

1. **Land the commit.** Collect lanes whose `target === C.oid`. If any, C's
   column = the LOWEST such lane (merge convergence draws to the leftmost
   incoming lane); those lane slots are cleared. If none, C is a new tip
   line: allocate the lowest free slot with a fresh color.
2. **Emit the row** for C: `column` = its slot; `edges` = one
   `{from, to, color}` per lane crossing this row — vertical continuations
   (`from === to`) for every still-open lane, plus the transition edges
   placed in step 3.
3. **Place the parents** (order = `C.parents` order):
   - Parent 0: if C's vacated slot is still free, extend it there (the
     straight-line fast path); otherwise allocate the lowest free slot.
   - Parents 1..n: if the parent oid is ALREADY some open lane's target,
     emit a bend edge from C's column to that lane's column and do NOT
     allocate (two children converging on one parent share the lane);
     otherwise allocate the lowest free slot to the right and set its
     target. Every edge moves at most ONE column per row; a shift that
     cannot happen this row (target slot occupied by a wider merge) waits a
     row.
4. **Relation rows**: when a pop leaves transitions that cannot be expressed
   within the commit row (an octopus fanning wide while other lanes also
   shift), the walk emits extra rows with `commit: null` carrying only
   edges — upstream's `RelationCommit` placeholder rows (parser.go:94-96),
   which its renderer also draws as empty list rows (graph/commits.tmpl:5-6).
   Relation rows never count toward `limit` or the skip (§3.2.4).
5. **Row index/geometry**: `rows[i]` maps to SVG row `minRow + i` — the page
   computes `minColumn`/`minRow`/`width`/`height` from the rows exactly as
   `Graph.Width()`/`Height()` do (graph_models.go:48-55); the engine need not
   carry them.

### 3.4 The answer

```ts
interface GraphDataResult {
  refs: string[];   // the tip set actually walked (resolved full names)
  rows: GraphRow[];
  total: number | null;  // exact commit count when the walk exhausted
                         // within MAX_GRAPH_SCAN, else null (§3.2.5)
  truncated: boolean;    // any budget exit: scan/refs/lanes caps
}
interface GraphRow {
  commit: {
    oid: string;
    subject: string;
    author: Person;      // git identity (objects.ts:24-30)
    committer: Person;   // the walk's sort key, carried for the page
    parents: string[];
    refs: { name: string; group: string }[];  // decorations, RefGroup'd
  } | null;              // null = relation-only row (§3.3.4)
  column: number;        // the dot's column (relation rows: -1)
  color: number;         // the commit lane's color number (class = %16)
  edges: { from: number; to: number; color: number }[];  // crossing THIS row
}
```

- Decorations: built from `listRefs()` at walk start — `refs` grouped by the
  upstream `RefGroup` rule (`heads|tags|remotes|pull|for`,
  `gitea/modules/git/ref.go:191-208`); the HEAD chip derives from
  `RefsResult.head` matching a branch target (upstream strips `HEAD -> ` from
  `%D`, graph_models.go:250-251 — ours never emits it, same visual).
  Tag decorations target the PEELED commit so the chip lands on the row the
  commit occupies.
- The ladder: `null` ONLY for the empty-repo case (§3.1); budget exits answer
  `truncated`; a transport failure throws (the seam's `safe()` catches, the
  page 500-shells — the ui/engine.ts posture).

## 4. The page, the route, and the anchor

### 4.1 Route family

One family claims the depth: `family: "graph"` with `{owner, repo}` — the
`/{owner}/{repo}/graph` literal head (`head === "graph"`, the commits claim's
pattern at index.ts:4360), appended to the family union (the heatmap
precedent: index.ts:2816 union member + `:3362-3369` parser claim + the
handler). One handler serves BOTH arms:

- Default: the full page (upstream `tplGraph`, commit.go:173).
- `?div-only=true`: ONLY the `#git-graph-body` inner content — the SVG
  container, the rev list, the pager; no shell, no header, no container
  chrome (upstream `tplGraphDiv`, commit.go:170-173 — the official JS fetches
  exactly this, repo-graph.ts:38-46). The pager must NOT carry `div-only` in
  its links (upstream `RemoveParam`, commit.go:169).

Query params parsed: `page` (`parsePageNumber`), `mode` (`color|monochrome`,
commit.go:110-113 normalization), `hide-pr-refs` (truthy string), `branch`
(multi-value — Hono's `c.req.queries("branch")`; each entry normalized to
`refs/heads/…` unless `refs/`-prefixed, commit.go:120-127). `file` accepted
and IGNORED (§1). The repo must be non-empty (the 404 shell on the unborn
ladder — the commits page's `CommitsNotFound` family, commits.tsx:40-47).

ACL: the route joins the commits family's posture (upstream gates this group
with `MustBeNotEmpty` only, web.go:1737 — no unit middleware beyond the repo
load); the engine RPC is a repo-scoped engine JSON path under the SPEC-0003
§2.5 gate, no new gate work.

### 4.2 Page shape (DOM parity — the official JS is the enhancement layer)

PROPOSAL: reproduce upstream's structure so the loaded bundle's
`initRepoGraphGit` wires it (the heatmap's DOM-parity posture, §2.2), because
the bundle loads on every page anyway (shell.tsx:128) and its init function
activates on `#git-graph-container` alone (repo-graph.ts:6-7). The required
DOM, upstream ids verbatim:

- `#git-graph-container.ui.segment` carrying the `monochrome` class when
  `?mode=monochrome` (graph.tmpl:5; the JS toggles it live).
- `#flow-color-monochrome` and `#flow-color-colored` buttons with the
  upstream active-class rule (graph.tmpl:43-44).
- `#flow-select-refs-dropdown` — the fomantic
  `ui multiple selection search dropdown` with hidden input, default text
  (`repo.commit_graph.select`), and one `.item[data-value]` per choice: the
  `...flow-hide-pr-refs` sentinel first, then all refs from the engine's
  `listRefs()` grouped pull/tags/remotes/heads, `data-value` = the FULL ref
  name (graph.tmpl:9-42 — note the sentinel's `...` prefix is part of the
  data-value).
- `#git-graph-body` wrapping the SVG container div (`#rel-container`), the
  rev list (`#rev-container > ul#rev-list`), and the pager.

Without JS the page is still fully usable for reading; filter CHANGES need
the JS (upstream's own posture — the fomantic dropdown has no noscript form).
Open question 1 records the fallback.

**The SVG**: server-rendered from `GraphDataResult` with upstream's exact
geometry (svgcontainer.tmpl:2-18): `viewbox` from the rows'
min-column/min-row/width/height at 5px/12px units, `width` = columns*10+10px
(the 2x scale aligns the 12px logical rows with the 24px list rows,
gitgraph.css:26-33 + :54-58); one `<g class="flow-group flow-color-16-{c}">`
per color class present, its `<path d>` assembled from the rows' edges —
`from === to` → `M {col*5+5} {row*12} v 12`; `to = from+1` →
`M {col*5} {row*12} l 10 12` (the `\` glyph's geometry); `to = from-1` →
`M {col*5+10} {row*12} l -10 12` (`/`); `stroke-width="1" fill="none"`.
Circles `r="2.5"` at `(column*5+5, row*12+6)` per commit row. Our one-step
edge rule (§3.3.3) never produces horizontal `h` segments — upstream's
`_`/`.` glyphs exist only for git's multi-column bends, which our relation
rows decompose (ledger note, Open question 2).

**The rev list**: one `<li>` per row in row order (the SVG/list alignment is
positional); relation rows an empty span; commit rows carry the subject
linked to `/{owner}/{repo}/commit/{oid}`, ref chips per group (heads →
`/src/branch/{short}`, tags → the tag chip, remotes → `/src/commit/{oid}`,
pull → `/pulls/{index}` — rendered only when NOT hide-pr-refs or the ref is
explicitly selected, the graph/commits.tmpl:21 rule), the author NAME and the
full author time (upstream's `AvatarStackWithNames` + `DateUtils.FullTime`,
graph/commits.tmpl:43-47 — the avatar/user-chip enrichment is cut, Open
question 4). Locale keys (extracted from
`gitea/options/locale/locale_en-US.json`): `repo.commit_graph` = "Commit
Graph", `repo.commit_graph.select` = "Select branches",
`repo.commit_graph.hide_pr_refs` = "Hide Pull Requests",
`repo.commit_graph.monochrome` = "Mono", `repo.commit_graph.color` = "Color"
— added beside the `commitsLocale` pattern
(`apps/worker/src/ui/components/commit-list.tsx:24-38`).

**Pagination** (Open question 3): `total` known → the numbered pager
(upstream `base/paginate` + PagerBuilder, navPageNum 5,
`gitea/services/context/pagination.go:28-46`; current clamped to totalPages,
`gitea/modules/paginator/paginator.go:45-49`); `total: null` → the
commits-page Newer/Older pair (commits.tsx:90-112) — `truncated` on the
current answer hides Older and shows the bound note. All pager links carry
`mode`/`branch`/`hide-pr-refs` (the JS rewrites `mode` into pager hrefs live,
repo-graph.ts:21-29 — our SSR hrefs must already carry the current params so
the rewrite is a no-op parity).

**The anchor**: commits.tsx's `repo-button-row-left` (commits.tsx:133-135)
gains the upstream Commit Graph button — `{{.RepoLink}}/graph`,
`octicon-git-branch`, locale `repo.commit_graph` (upstream
`templates/repo/commits.tmpl:19-21`), beside the BranchSelector.

**File ownership note for M2** (the census's index.ts serialization warning):
`index.ts` (family union + parser claim + handler), `ui/engine.ts` (the
`graphData` wrapper), and `commits.tsx` (the anchor) are each shared or
neighbor-owned files — they land in ONE registration window per the
orchestrator's batch rule, with the commits-page owner's sign-off on the
anchor hunk.

## 5. Edge cases and limits

- **Merge octopii** (parents > 2): each extra parent takes its own lane
  (§3.3.3); wide fan-outs decompose across commit + relation rows. The page
  never draws horizontal segments (§4.2); upstream's `_`/`.` glyph rules
  (parser.go:310-336) exist precisely for the shapes our one-step rule
  splits into extra rows — visually equivalent, mechanically different.
- **Date ties**: our pop order is the frontier's stable sort (repo.ts:1891) —
  insertion-ordered on equal committer timestamps; git's `--date-order` has
  its own tie behavior. Commit ORDER on exact ties may differ from git's
  (and upstream's page is only as deterministic as git's). Ledger-ready:
  visible only in equal-timestamp commits; fixtures for oracle tests use
  distinct timestamps (§6).
- **Huge graphs**: past `MAX_GRAPH_SCAN` (20000 pops ≈ page 200 at 100/page)
  a deeper page answers `{rows: [], total: null, truncated: true}` — the page
  renders the bound note and no Older link. Upstream has NO page cap at all
  (verified: the handler's `ctx.FormInt("page")` is unclamped,
  commit.go:144; the paginator clamps only to totalPages,
  paginator.go:45-47) — the mission's "50-page cap" does not exist upstream;
  our budget cap is the honest stand-in for git's free walk.
- **Wide graphs**: past `MAX_GRAPH_LANES` (128) the answer truncates at the
  pop where allocation failed; the rendered width is bounded by the lane cap
  (128 * 10px + 10 = 1290px — inside the `#rel-container` scroll,
  gitgraph.css:54-58).
- **Unborn/empty repo**: `graphData` returns `null` → the page 404-shells
  (upstream never reaches the handler: `MustBeNotEmpty`, web.go:1737).
- **Bad/deleted branch param**: skipped tips; all-bad → the default tip set
  (upstream's retry, commit.go:130-142); the page NEVER 500s on a stale
  `?branch=` value, it just re-renders unfiltered (matching upstream's
  "a retry isn't harmful" comment).
- **Annotated tags as tips**: peel before seeding (`peelToCommit`); tag
  decorations land on the peeled row via the `peeled` field.
- **A merge commit whose parents are not date-ordered** (committer time of
  parent[1] newer than parent[0]): the frontier order handles it — parents
  pop when their time comes; lane targets keep them converged regardless of
  parent-array order (the upstream parser has no such problem because git
  already drew it; our algorithm must place lanes independent of parent
  order — parent[0]'s straight-line preference is a RENDER preference only).
- **`div-only` with unknown params**: the fragment arm answers whatever the
  full handler computed — no separate validation surface (upstream renders
  tplGraphDiv from the same data, commit.go:170-173).
- **The `...flow-hide-pr-refs` sentinel**: a literal item value; the page
  treats any `branch` param starting with `...` as the sentinel (it never
  reaches the RPC — the JS maps it to `hide-pr-refs=true`,
  repo-graph.ts:53-55, :63-65, :77-79).

## 6. Testing plan

**Engine — `packages/git-engine/e2e/check-graph.mjs`** (the seeded-real-packs
idiom; `check-blame.mjs` / `check-tree-commits.mjs` / `check-grep.mjs`
precedents). Fixture: a seeded repo with a linear run, a side branch, a
two-parent merge, one octopus (3+ parents), annotated + lightweight tags, a
cross-branch interleaving with DISTINCT committer timestamps, plus a
`refs/pull/1/head` ref.

- ORACLE: run real `git log --graph --date-order --pretty=format:...` against
  the same fixture in the harness (the seed packs come from real git — the
  blame/tree-commits checks already shell out for seeding) and assert:
  (a) our pop sequence equals git's commit sequence exactly on the distinct-
  timestamp fixture; (b) our `column` equals the `*` column in git's art on
  the linear/branch/merge portion (leftmost-free placement agrees with git
  there); the octopus rows are asserted against a hand-computed expected map
  checked into the check (our transition model need not match git's glyph
  choices row-for-row); (c) the page-slicing identity below.
- The page-slicing property: `rows(graphData({page:2}))` continues page 1's
  lanes — the row-0-to-skip lane-state identity (§3.2.4, the upstream
  graph.go:71-82 property); a commit's column is INDEPENDENT of the page it
  appears on.
- hidePRRefs: the pull ref's tip excluded from the default walk, INCLUDED
  when explicitly in `refs`; the default walk excludes a `refs/remotes/*`
  tip (the `--tags --branches` rule, graph.go:36-38).
- Decorations: heads/tags/remotes/pull groups on the right commits; the
  annotated tag lands on the peeled target; HEAD chip material.
- The ladder: empty repo `null`; unresolvable named refs skipped; ALL-bad
  refs → default-set fallback; `truncated` on each cap (a fixture with >100
  commits for the scan-cap windowing and a >128-lane synthetic for the lane
  cap); `total` exact when the fixture fits the scan, `null` when paged past
  the cap.
- Colors: unique per lane, class = %16, first commit on color 1.

**Worker vitest** (real bindings, the `applyD1Migrations` + `ensureSeededRepo`
idiom of `apps/worker/src/api/engine-read.test.ts`):

- Page matrix: 200 full page with ALL five JS-selector ids present
  (`#git-graph-container`, the two color buttons, the dropdown,
  `#git-graph-body`); `?mode=monochrome` class on the container; the SVG
  geometry (viewBox numbers) for a golden fixture; `?div-only=true` answers
  the fragment only (no `<html>`, no repo header) and its pager links carry
  no `div-only`; `?branch=deleted-branch` re-renders unfiltered (200, never
  500); `?branch=real-branch` narrows rows; `?hide-pr-refs=true` hides pull
  chips; empty repo 404.
- The anchor: the commits page renders the Commit Graph button linking
  `/graph` with the octicon + label.
- The seam: `EngineClient.graphData` appended (ui/engine.ts:46-64) resolves
  null on a throwing RPC.
- Gates: `pnpm typecheck` regenerates `dist-types/` (the boundary rule);
  `pnpm test:full` per ADR-0006 — a single-file pass is never cited as
  suite-green.

## 7. Milestones

- **M1 — the `graphData` RPC** (size L; census R09's "L sized for the walk +
  layout algorithm" — this is the algorithm half): engine walk + lane
  assignment + budgets + `GraphDataResult` types + `check-graph.mjs` +
  dist-types regen. Engine-only unit — the seam wrapper does NOT ride M1
  (SPEC-0015's dispatch note pattern: the boundary RPC lands with its check;
  the consumer wrapper folds into the page unit's combined landing, keeping
  `ui/engine.ts` ownership single). No D1 migration.
- **M2 — the page unit** (size L in total, the render half is most of it):
  `pages/graph.tsx` (page + fragment renderer + SVG assembly), the route
  family (index.ts union + parser claim + handler — the orchestrator's
  registration window), the `ui/engine.ts` wrapper, the commits.tsx anchor
  (with the commits-page owner's sign-off), the five locale keys, the worker
  vitest matrix. M2 after M1 (the page renders from the RPC's shape).

Entry criteria: this SPEC ratified; M1 lands as an engine unit (RPC + check
together — a boundary RPC without its check does not land), M2 as the worker
unit in one index.ts registration window.

## 8. Open questions (resolve at ratification)

1. **Host the official JS or self-contained SSR?** Hosting means the fomantic
   dropdown markup + the `div-only` arm and full parity with upstream's
   filter UX; self-contained means a plain form-GET filter bar (checkbox
   list + submit) and no fragment arm. PROPOSAL: host — the bundle loads on
   every page (shell.tsx:128), the container ids activate it for free, and
   the heatmap ride proved the DOM-parity posture; the form-GET bar can be
   added later WITHOUT removing the ids if the fomantic dropdown proves
   brittle in our shell.
2. **Lane-geometry parity class**: our DAG lane algorithm vs a port of
   upstream's glyph parser (which would require synthesizing git's ASCII art
   first). PROPOSAL: the lane algorithm (§3.3); ledger the mechanical
   divergence (no `_`/`.` horizontal segments — relation rows instead; color
   numbers monotonic rather than pool-recycled; identical 16-class wrap).
   Visual parity on the 5px/12px grid is the bar, glyph-identity is not.
3. **Pager posture**: hybrid (numbered when `total` delivered; Newer/Older +
   bound note when `total: null`) vs always-Newer/Older (the commits-page
   uniformity) vs an engine count pass with its own cap. PROPOSAL: hybrid —
   most repos exhaust the frontier inside 20k pops and get upstream's exact
   numbered shape; huge repos get the honest Older-only form the commits
   page already standardized.
4. **Identity enrichment on rows** (email→user chips, avatar stack, sign
   badges, CI status — graph_models.go:96-144): PROPOSAL: cut from v1 (rows
   carry git identities; the enrichment is D1-side and can land later with
   NO RPC change — the data is already in `GraphDataResult.rows[].commit`).
   Confirm the cut matches the census's L sizing (walk + layout, not
   identity join).
5. **The `?file=` arm**: PROPOSAL: honest-absent v1 (accepted, ignored — the
   census's own carve-out); revisit only with a consumer.
6. **The census signature deviation**: the census sketched
   `graphData(ref, {limit, page, refs?, hidePRRefs?})`; §3 proposes
   `graphData(opts?: { refs?; page?; limit?; hidePRRefs? })` because the
   page URL has no ref and upstream's walk is multi-ref by construction
   (§2.1). Ratify the opts shape (or reinstate a `ref` default-tip parameter
   if a future consumer needs a single-tip graph).

### Ratification (2026-10-29, orchestrator)

All six resolved per their proposals: (1) host the official JS (the heatmap
DOM-parity precedent; the form-GET bar remains a no-ids-removal fallback);
(2) the lane algorithm with the mechanical divergence ledgered — visual
parity on the 5px/12px grid is the bar, glyph-identity is not; (3) the
hybrid pager; (4) identity enrichment cut from v1 (the RPC carries the git
identities; the D1 join lands later with no RPC change); (5) `?file=`
honest-absent; (6) the `graphData(opts)` shape ratified — no `ref`
parameter; a single-tip default graph is `refs` with one entry.
