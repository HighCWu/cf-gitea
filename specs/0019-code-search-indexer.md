# SPEC-0019: Code search beyond one repo — the R02/R05 revisit, the grep-federation v1, and the indexer-class substrate verdict

Status: **accepted** (ratified 2026-10-29, orchestrator — decisions at §8) — awaiting ratification (decisions at §8) ·
Date: 2026-10-29 · The UI gap census's revisit row:
[docs/compat/ui-gap-census-2026-10-29.md](../docs/compat/ui-gap-census-2026-10-29.md)
R02 `GET /explore/code` + R05 `GET /{username}/-/code` — "no independent work
— they ride the code-search subsystem (R10's grep RPC + an indexer-class
store — a subsystem, not a page). Revisit together with R10; do not dispatch
standalone." The revisit is now due: R10's substrate half LANDED
(SPEC-0015 M1 grep RPC, commit `0644597`) and its page half LANDED
(`781d8a3`, `pages/repo-search.tsx`). Depends on: SPEC-0015 §3.1 (the grep
RPC contract — modes, budgets, the honesty fields), SPEC-0008 §3.2 (the
tier-2 page data-sourcing rules — pages never self-fetch), the census's
R02/R05/R10 rows, and SPEC-0014 §3 / the landed REPO_TASKS consumer idiom
(cited in §4.2 for the deferred indexer's write path).

Owns: the substrate VERDICT for code search beyond one repository (§2.4 —
the four options analyzed), the v1 federated search surface (§3 — the
`/{username}/-/code` and `/explore/code` pages over the landed grep RPC, the
shared federation loader), and the DEFERRED indexer-class sketch (§4.2 —
recorded so it is not silently re-decided). Owns NO new engine RPC, NO new
D1 table, NO new storage namespace: the whole v1 rides what already landed.

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY,
pin `fc4936884584` — v1.22.0-rc1-3919-gfc493688). Every `web.go:N` /
`code.go:N` / `indexer.go:N` cite is at that pin; our-substrate findings are
against `apps/worker/src/**`, `packages/git-engine/dist-types/**`, and
`apps/worker/wrangler.jsonc.example` as of 2026-10-29. Platform facts about
D1/FTS5 are external (cited inline with their issue/doc sources, checked
2026-10-29).

---

## 1. Problem and scope

The census's R02/R05 row is class (d) "matches upstream default config" —
at DEFAULT upstream config both pages are shells that redirect away
(§2.2): `/explore/code` → `/explore` and `/{username}/-/code` → the
profile. The census therefore ranked them **impact #17, last**, and gated
them on "the code-search subsystem (R10's grep RPC + an indexer-class
store)". The gate's first half has since landed; the second half — an
indexer-class store — has never been designed on our substrate. This SPEC
is that gate. It answers three questions:

1. **What does upstream's indexed code search actually do?** (§2.1-§2.3 —
   the bleve subsystem: queue, content extraction, the two handlers, the
   config posture that makes all three pages default-off.)
2. **Which substrate can serve search beyond one repo on Workers, at what
   cost?** (§2.4 — the four candidates analyzed: D1 FTS5, R2 shards,
   demand-scan federation, honest-absent.)
3. **What ships now vs later?** (§3 + §7 — v1 is the federated grep page
   pair with an explicit fan-out cap; the indexer-class store is DEFERRED
   with recorded reopen triggers, not committed.)

In scope: the two web pages, the shared federation loader behind them, the
visibility filtering of the fan-out seeds, the honesty surface (the cap
notice), and the tests (§6).

Out of scope (each named so it is not silently re-decided):

- **The indexer-class store** — no FTS5 table, no R2 shard format, no
  index-on-push write path ships in v1. §2.4 records why each candidate
  loses or defers; §4.2 sketches the deferred design so a future wave
  starts from evidence, not scratch.
- **Any new engine RPC** — the landed `grep(ref, opts)` (SPEC-0015 §3.1)
  is the entire data plane. Federation composes N calls to the EXISTING
  RPC; nothing in `packages/git-engine/` changes.
- **Ranked/fuzzy/scoped-query semantics** — no global relevance score, no
  language facet, no `?l=` filter, no pagination across the union (§3.3's
  divergence ledger). These are indexer-class features; they arrive only
  with the deferred store.
- **The issue indexer** (upstream's sister subsystem,
  `gitea/modules/indexer/issues/`) — different data, already served by D1
  queries on our substrate; untouched.
- **`setting.Service.Explore.DisableCodePage`** (the admin kill-switch,
  `gitea/modules/setting/service.go:96`,
  `custom/conf/app.example.ini:1012`) — no config surface in v1; the pages
  carry no var gate (the fan-out cap is their natural bound). Revisit with
  the deferred indexer if ever.

## 2. The subsystem — upstream cites, our substrate, the gap

### 2.1 The indexer: a queue-fed bleve engine, one document per file

Upstream's code search is a SECOND copy of repository content, tokenized
into a bleve index on local disk. The moving parts
(`gitea/modules/indexer/code/`):

- **The engine seam** (`indexer.go`): a process-global atomic indexer
  handle (`indexer.go:29-35`) that starts as a dummy answering
  "indexer is not ready" (`internal/indexer.go:42-60`) — every consumer
  guards on `IsAvailable` (`indexer.go:252-255`, the
  `CodeIndexerUnavailable` template data at `explore/code.go:90-93`).
  `Init()` (`indexer.go:102-242`) builds the bleve or elasticsearch
  implementation, creates a UNIQUE queue `code_indexer`
  (`indexer.go:141`), and — when the index is fresh — back-populates it by
  walking every repository ID downward in pages of 50
  (`populateRepoIndexer`, `indexer.go:259-313`, over the
  `repo_indexer_status` left-join, `models/repo/repo_indexer.go:40-66`).
  The queue's handler runs `index()` per message: resolve the default
  branch sha, diff since the last indexed sha (`git.go:28-45` — genesis =
  full `ls-tree -r`, increment = `diff --name-status` with the force-push
  fallback to genesis at `git.go:105-111`), filter through the indexability
  rules (`git.go:47-63` — regular/executable only, EXCLUDE/INCLUDE globs),
  then batch upsert.
- **The extraction** (`bleve/bleve.go`): per file — skip vendored paths
  when `REPO_INDEXER_EXCLUDE_VENDORED` (default true, `bleve.go:161`);
  **skip and DELETE anything over `MAX_FILE_SIZE` (default 1 MiB)**
  (`bleve.go:179-181` — the big-file posture is "not in the index", not
  "truncated"); sniff binary and store EMPTY content for non-text
  (`bleve.go:190-194` — the filename still indexes); transcode
  `ToUTF8DropErrors` (`bleve.go:204`); detect the language via go-enry
  (`bleve.go:205`). One bleve document per (repo, filename):
  `RepoIndexerData{RepoID, CommitID, Filename, Content, Language,
  UpdatedAt}` (`bleve.go:52-60`). The analyzer is a CUSTOM tokenizer
  (`token_code.go`) that splits code identifiers — camelCase, snake_case,
  `a.b.c` — plus unicodenorm + lowercase (`bleve.go:100-127`); the
  filename gets a path tokenizer (`token_path.go`). This tokenizer
  asymmetry matters at §2.4(a): FTS5 has no such code tokenizer.
- **The search** (`bleve.go:258-406`): modes are **exact** (match-phrase
  over the code analyzer) and **words** (match-AND; fuzzy exists but is
  self-admittedly broken, `bleve.go:280-282`) — NO regexp on the indexed
  path (`SupportedSearchModes` = `SearchModesExactWords()`,
  `indexer.go:315-321` + `modules/indexer/indexer.go:21-31`). The keyword
  query is a disjunction of content match and FILENAME PREFIX match
  boosted 10× (`bleve.go:265-267`, `:289`), conjoined with the repo-ID
  filter (`:291-300`) — scoping to a repo set is a filter over the ONE
  global index, which is why the global page is cheap upstream. Results
  carry the language facet (`:323-325`, `:382-405`) that feeds the pages'
  language picker, plus highlight locations re-cut into ±1 line context
  (`modules/indexer/code/search.go:37-61`, `:90-130`).
- **The write triggers** (`services/indexer/notify.go`): the notifier
  pushes `{RepoID}` onto the queue on `MigrateRepository`/`AdoptRepository`
  (`notify.go:77-85`), on **default-branch** `PushCommits`/`SyncPushCommits`
  (`notify.go:87-111` — `opts.RefFullName.IsBranch() &&
  BranchName() == repo.DefaultBranch`), on `ChangeDefaultBranch`
  (`:113-120`), and on `DeleteRepository` (`:70-75` — the index entry
  deletion). Non-default branches NEVER re-index.
- **The freshness contract**: the index lags the push by the queue drain
  time (async by design — upstream accepts a stale index; `bleve.go`'s
  `CommitID`/`UpdatedAt` are per-document stamps, not a consistency
  mechanism). Contrast with our grep: it scans the CURRENT tip and can
  never be stale (§2.4(c)).

### 2.2 The two handlers: both REQUIRE the indexer; both redirect at default config

**R02 — `GET /explore/code`** (`web.go:558` → `explore.Code`,
`routers/web/explore/code.go:25`):

- The gate: `!setting.Indexer.RepoIndexerEnabled ||
  setting.Service.Explore.DisableCodePage` → redirect to `/explore`
  (`code.go:26-29`). At DEFAULT config (indexer off, §2.3) the page IS a
  redirect — our absence matches upstream's default behavior (the
  census's class-(d) call).
- With the indexer on: an empty `q` renders the bare form (`code.go:40-43`);
  otherwise the repo scope is `FindUserCodeAccessibleRepoIDs(ctx, doer)`
  (`code.go:61` — code-unit visibility, `models/repo/repo_list.go:744-748`;
  guests and non-admins pass the list INTO the search as the `RepoIDs`
  filter, admins search unfiltered, `code.go:55-66`), then ONE indexed
  search over that filter (`code.go:75-84`), deleted-repo results cleaned
  (`code.go:110-120`), pager at `setting.UI.RepoSearchPagingNum` = 20
  (`code.go:126`; `modules/setting/ui.go:90`).

**R05 — `GET /{username}/-/code`** (`web.go:1166` → `user.CodeSearch`,
`routers/web/user/code.go:25`):

- The gate: `!Indexer.RepoIndexerEnabled` → redirect to the context
  user's profile home (`code.go:26-29` — note: the `DisableCodePage`
  kill-switch does NOT apply here).
- Route group carries `reqAnyRepoUnitAccess(unit.TypeCode,
  perm.AccessModeRead, false)` + `individualPermsChecker`
  (`web.go:1165-1167`).
- With the indexer on: the repo scope is
  `FindUserCodeAccessibleOwnerRepoIDs(ctx, ctx.ContextUser.ID, ctx.Doer)`
  (`code.go:55` — `repo_list.go:749-753`, the owner-scoped twin of R02's
  query), then the same `PerformSearch` shape, pager at 20.

Both render the shared search combo (`routers/common/codesearch.go:13-33`
`PrepareCodeSearch` — `q`, `l` (language), `search_mode`; the mode
dropdown lists the INDEXER's exact/words, never regexp) and both display
per-repo header cards — R02's results span many repos (`RepoMaps` loaded
for the card headers, `code.go:102-108`), R05's the same shape scoped to
one owner. The template pair is `templates/explore/code.tmpl` /
`templates/user/code.tmpl`.

### 2.3 The config posture: `REPO_INDEXER_ENABLED` defaults false

`gitea/modules/setting/indexer.go`: `RepoIndexerEnabled: false`
(`indexer.go:43`, the ini key `REPO_INDEXER_ENABLED` → `MustBool(false)`,
`indexer.go:78`; `app.example.ini:1624` ships it commented off). The rest
of the block: `RepoIndexerRepoTypes` = sources,forks,mirrors,templates
(`:44`, `:79`), `REPO_INDEXER_TYPE` = bleve (`:80`), include/exclude glob
lists (`:88-89`), `REPO_INDEXER_EXCLUDE_VENDORED` default true (`:90`),
**`MAX_FILE_SIZE` default 1 MiB** (`:49`, `:91`),
`STARTUP_TIMEOUT` 30 s (`:92`). The default posture is deliberate: the
bleve index is a heavyweight local-directory artifact (per-process, not
shared-disk safe) that a small instance is not expected to pay for. R10's
page already renders this fork honestly: with the indexer off, upstream's
in-repo page still WORKS on the `git grep` fallback
(`gitgrep.PerformSearch`) and shows the
"better results if site administrator enables Repository Indexer" notice
— the exact notice our landed R10 page carries
(`apps/worker/src/ui/pages/repo-search.tsx:121-124`).

### 2.4 The substrate question — four options, analyzed

The census's gate names "an indexer-class store" as R02/R05's
prerequisite. The candidates, with evidence:

**(a) A D1 FTS5 content index, fed by the grep-scan machinery — viable,
heavy, DEFERRED.**

FTS5 IS available on our substrate: D1 is SQLite and honors
`CREATE VIRTUAL TABLE … USING fts5(...)` including external-content
tables — confirmed against the platform (workerd issue #1540 documents
fts5 working while the `fts5vocab` virtual table is
blocked; community deployments run production FTS5 search on D1). But the
costs are structural, not incidental:

- **Size ceiling**: D1 caps a database at **10 GB** (Workers Paid;
  500 MB free), shared with ALL relational metadata. An FTS5 code index
  stores (a tokenized copy of) file content — upstream stores the WHOLE
  file per document (`bleve.go:52-60`), and even a 64 KB-per-file cap
  puts a mid-size org's corpus in the gigabytes. D1 row/blob cap is
  2 MB and the 100-bound-parameter limit constrains batch inserts
  (D1 limits doc, checked 2026-10-29). The index would be the single
  largest D1 tenant, for derived data.
- **The duplication rule**: ADR-0001's split — D1 is the source of truth
  for metadata, R2 for blobs, "do not duplicate state across them" — an
  FTS5 content index duplicates BLOB bytes (or large derivatives) into
  the metadata store. It is defensible only as explicit derived state
  with its own lifecycle; that is a bigger architectural step than a
  page pair justifies.
- **The write path is a second indexing engine**: genesis = walk every
  file of every repo (upstream's `populateRepoIndexer`,
  `indexer.go:259-313`), which on our boundary means thousands of
  budgeted DO reads — a new engine RPC at minimum (the grep RPC answers
  MATCHES, not full content) — plus steady-state incremental updates on
  every default-branch push (the onPush seam,
  `apps/worker/src/services/webhooks-push.ts` module doc — the seam
  exists) and on mirror syncs, through the serialized REPO_TASKS
  consumer. Doable; a subsystem of R10's size on its own.
- **The tokenizer gap**: upstream's search quality rests on the custom
  code tokenizer (`token_code.go` — camelCase/snake_case splitting) and
  the path tokenizer. FTS5 offers only built-in tokenizers (unicode61,
  ascii, porter, trigram); the code-identifier split is unavailable, so
  words-mode parity is lost at the analyzer level before any ranking
  question arises. The trigram tokenizer (substring search, the
  exact-mode analog) is the credible v1 posture — sketched at §4.2.
- **Adoption caveats to record now**: `wrangler d1 export` crashes on
  databases containing FTS5 virtual tables
  (cloudflare/developer-platform#11) — a backup/restore hazard for every
  self-hosted deployment, not just the ones that opt in; and Time-Travel/
  point-in-time restore interplay with virtual tables is undocumented.
  Both must be resolved (or consciously accepted) before the store ships.

Verdict: the ONLY credible indexer-class store on this substrate, and it
buys a global ranked index whose demand signal (census impact #17, last)
does not yet pay for its footprint. DEFERRED with reopen triggers
(§8 question 4); the sketch lives at §4.2.

**(b) R2-stored pre-built shards with worker-side merge — REJECTED.**

Per-repo shard files (inverted index or pre-tokenized content) under a
new R2 namespace, fetched and merged per query. Analysis:

- The query is still O(N repos): the worker fetches N shards, parses N
  payloads, merges — the SAME fan-out shape as option (c), plus a write
  path, a staleness window (shards lag pushes until re-written —
  upstream accepts this; our grep does not have to), and per-query parse
  CPU against `limits.cpu_ms`.
- It wins only where a precomputed structure answers queries the
  budgeted scan cannot (fuzzy ranking, facets) — the indexer-class
  features that option (a) serves better inside the transactional store.
- R2 GET latency × N on the request path is no better than N DO greps,
  and the DO greps need zero infrastructure.

Strictly dominated by (c) for v1 and by (a) for the indexer-class end
state. No staging slot.

**(c) Demand-scan federation — N repos × the landed grep RPC. ADOPTED
for v1, honestly capped.**

The page resolves the visibility-filtered repo set (R05: the owner's
repos the doer can see, the `FindUserCodeAccessibleOwnerRepoIDs`
analogue, `repo_list.go:749-753`; R02: the instance-visible set,
`repo_list.go:744-748`) and calls `grep(defaultBranch, {q, mode})` per
repo (`packages/git-engine/dist-types/repo.d.ts:738` — the SPEC-0015 §3.1
contract: exact/words/regexp, ≤50 result blocks, `truncated` honesty,
budgets 2,000 blobs / 200,000 line-steps per call), rendering the union
grouped by repo. Evidence for and against:

- FOR: zero new storage, zero write path, zero staleness (the scan reads
  the CURRENT tip — strictly fresher than upstream's queue-lagged index);
  the substrate is landed and production-tested (R10's page rides it);
  the honest-truncation contract already exists, so per-repo partial
  answers are representable.
- AGAINST (the honest math): each repo is one DO call (one subrequest) —
  the subrequest budget is 50 on Workers Free, 1,000 on Paid, so the
  fan-out needs a CAP well under 50 to keep free deployments working
  (§8 question 2 proposes 25); latency is bounded-batch parallel
  greps (§8 question 6 proposes chunks of 5); each answer is
  budget-truncated (a 2,000-blob repo yields a PARTIAL scan — the
  honesty notice renders); there is NO global ranking (the union is
  grouped by repo, not scored — upstream's bleve `-score` sort is
  unavailable); and the set itself must be capped — a 500-repo
  instance cannot be scanned per query at any budget.
- The demand side: the census ranks R02+R05 **#17 of 17** — "matches
  upstream default config; opens only with R10's subsystem". Real code
  search across MANY repos is an indexer-shaped need; search across ONE
  user's handful of repos (R05, the typical self-host's actual shape)
  is not. Federation serves the small-N arms honestly and refuses the
  large-N arm with a visible notice instead of silently.

**(d) Honest-absent for the global arm + grep-only for the per-repo arm —
the CURRENT posture; superseded for R05, retained as R02's fallback.**

Today R02/R05 don't exist and R10 is landed. Against upstream's DEFAULT
config this is exact parity (both pages redirect away, §2.2). The census's
own R10 precedent — "matches upstream default-off, but the button+page are
expected" — argues the user-visible page is worth having when the
substrate already exists. Option (d) survives only as the disposition IF
ratification prefers the upstream-default redirect for R02 (§8 question 1's
alternative arm) and as the over-cap behavior class (a redirect/notice, not
a broken page).

### 2.5 What already landed (the v1 builds on exactly this)

- The grep RPC: `RepoCell.grep(ref, opts)` — modes exact/words/regexp,
  ≤50 result blocks (`MAX_GREP_RESULT_FILES`), 2,000-blob and 200,000
  line-step scan budgets, the step-counted NFA for regexp, binary blobs
  skipped (the pinned divergence from upstream's empty-lines blocks),
  `total` = the honest pre-cap count + `truncated` flag
  (`packages/git-engine/dist-types/repo.d.ts:19-38`, `:718-746`).
- The per-repo page: `pages/repo-search.tsx` (R10) — the mode
  parse/display split, the capped pager over blocks, the truncation
  notice arms, the escaped-line cell markup (chroma absent — the
  documented reduction) (`apps/worker/src/ui/pages/repo-search.tsx`).
- The client seam: `engineClient(env, repoName)` builds one
  null-on-failure client per repo; `env.REPO.getByName(name)` addresses
  the cell (`apps/worker/src/ui/engine.ts:100-101`) — a federation
  loader composes these per repo.
- The visibility idioms: the profile page's owner-repo visibility
  filter (`doerCanViewPrivate`, `apps/worker/src/api/services/orgs.ts:59`;
  the `user-profile.tsx` query) and the explore listing's
  visibility-switch ordering (the `explore.tsx` org listing, sort
  `newest` default) — the fan-out seeds reuse both shapes.
- The config posture: `limits.cpu_ms: 300000` (the 5-min CPU maximum;
  waiting on DO calls is free — wall is unbounded while the client is
  connected), so a 25-grep fan-out is a latency problem, never a CPU
  violation (`apps/worker/wrangler.jsonc.example:12-14`).

**The gap**: no page exists at either route; no loader composes grep
across repos; no document records why there is no indexer store.

## 3. The v1 surface (PROPOSAL)

### 3.1 The shared federation loader

A new worker-side module (page-adjacent, the `search-aux.ts` idiom) that
both pages call:

1. Resolve the repo set: owner-scoped (R05) or instance-visible (R02) via
   the D1 visibility idioms of §2.5 — the doer-visible subset only,
   anonymous sees genuinely-public repos (public repo + public owner,
   upstream's `the explore-listing mirror (public-repo-under-limited-owner visible — upstream's FindUserCodeAccessibleRepoIDs surface; ratified as-landed 2026-10-29: the code page is never narrower than the instance's discovery surface for the same viewer)` shape,
   `repo_list.go:755-763`).
2. Order `updated_unix DESC, id DESC` (§8 question 3) and truncate to the
   fan-out cap (§8 question 2: 25), keeping the FULL count for the
   over-cap notice.
3. Execute bounded-batch parallel greps (§8 question 6: chunks of 5)
   against `engineClient(env, name).grep(defaultBranch, {q, mode})` —
   mode exact|words only on these pages (§3.3). Empty repos, unborn
   branches, and transport failures (`null`) SKIP silently — a federated
   page can never 404 off one dead repo (contrast: R10's page 404-shells,
   `repo-search.tsx:229-233`).
4. Return the union: per-repo `{repo, grep}` rows in set order, each with
   its ≤50 blocks and honesty fields, plus `{matched, scanned, overCap,
   cap, totalVisible}` rollup numbers for the notices.

No pagination across the union in v1: each repo's block list renders
capped (the R10 block-pager does not generalize — the union has no honest
global total to page against; upstream's pager pages the INDEXER's exact
global count, which federation cannot produce without a second full
fan-out per page). The rendered union is capped at the rollup
(the covered repos' blocks); a deployment where that routinely truncates
is exactly the §8 question 4 reopen signal.

### 3.2 The two pages

- **R05 — `GET /{username}/-/code`** (the upstream route group shape,
  `web.go:1166`): owner profile-scoped; the doer-visible repo set of the
  context user; renders the shared form (q + the mode select) + the
  grouped result cards (the card header names `owner/repo` — the R02/R05
  template arm, upstream's results-with-RepoMaps shape at
  `explore/code.go:102-108`) + the notices.
- **R02 — `GET /explore/code`** (web.go:558): instance-scoped; the same
  loader over the doer-visible instance set; identical render. The
  redirect-vs-page disposition is §8 question 1; the PROPOSAL is the
  capped page (the alternative — upstream's default-config redirect to
  `/explore`, `code.go:26-29` — remains a one-line flip if ratification
  prefers exact default parity).
- Empty `q` renders the bare form page (both upstream handlers' early
  return, `code.go:40-43` / `user/code.go:40-43`) — no engine calls, the
  R10 page's bare arm verbatim.
- Notices (the honesty surface, the R10 page's three-message idiom):
  the always-on scan notice (the `by_git_grep` text class — "results are
  provided by per-repository scans; a site-wide index is not
  configured"); the over-cap notice ("searched the 25 most recently
  updated of M visible repositories"); the per-repo truncation notice
  (reusing `repo-search.tsx`'s counted/partial arms per truncated repo).

### 3.3 The divergence ledger (documented reductions, all in the indexer-page direction)

1. **Modes**: these pages render exact|words (the indexer pages'
   `SearchModesExactWords` set, `modules/indexer/indexer.go:21-31`) —
   NOT regexp, even though the RPC serves it. Upstream's indexed path
   has no regexp mode; adding our grep-only mode here would make the
   three code-search pages inconsistent (R10's page carries regexp as
   the gitgrep-arm mode). Documented reduction; reversible.
2. **No language facet / `?l=` filter** — the indexer's
   `SearchResultLanguages` (bleve.go:382-405) has no federation analog
   (no enry on workers; grep carries no language). The R10 page already
   omits it on the gitgrep path; these pages omit it everywhere.
3. **No cross-union pager** (§3.1) — upstream pages at 20/page over an
   exact global count; the federation renders one capped grouped page.
4. **No relevance order** — grouped by repo in seed order, blocks in
   file order; upstream sorts by bleve `-score` then `UpdatedAt`.
5. **Not gated on a config flag and NOT redirecting** — the deliberate
   divergence from BOTH upstream handlers' `!RepoIndexerEnabled`
   redirects (§2.2): our substrate's always-on scan arm is upstream's
   own R10 precedent (the gitgrep fallback page works with the indexer
   off), extended to the multi-repo arms with the cap honesty in place
   of the index.
6. **Highlighting**: escaped line text in the chroma cell markup — the
   landed R10 reduction verbatim (no chroma on workerd).

## 4. Data model

### 4.1 v1: no schema

No D1 table, no migration, no R2 namespace, no DO change. The v1 surface
is pure composition over `repositories` rows (the existing
visibility/updated columns) and the grep RPC. This is the SPEC-0016 §4.3
("No DO") posture applied to storage: the arbiter of what a query
returns is the engine's own scan, not an index to keep consistent —
which is precisely the v1's selling point (nothing to reindex, nothing
to orphan on delete, nothing to migrate).

### 4.2 The DEFERRED indexer-class sketch (NOT BUILT — recorded so it is not silently re-decided)

If/when the reopen triggers fire (§8 question 4), the credible shape on
this substrate is:

- **D1 tables**: `code_indexer_status` (repo_id PK, commit_sha,
  indexed_unix — the `models/repo/repo_indexer.go:22-27` port) and ONE
  FTS5 virtual table `code_fts` (`repo_id UNINDEXED, filename, content`)
  in **trigram** tokenizer posture (substring semantics ≈ the exact
  mode; a second unicode61 column would serve a words mode — the
  tokenizer posture is §8 question 5). Content rows capped per file
  (≤64 KB indexed, the MAX_FILE_SIZE divergence from upstream's 1 MiB
  whole-file storage, forced by the 10 GB D1 ceiling — §2.4(a)).
- **Write path**: the engine onPush seam
  (`apps/worker/src/services/webhooks-push.ts` module doc — the seam the
  webhook family rides) enqueues `{kind: "code-index", repoId}` onto
  REPO_TASKS when the DEFAULT branch moved; the serialized consumer
  (`apps/worker/src/repos/purge.ts` `handleRepoTasks`, the
  max_batch_size=1/max_concurrency=1 posture) walks the old→new delta
  (a new engine delta RPC — the readDiff/ls-tree composition or a
  purpose-built boundary RPC, its own SPEC) and upserts FTS5 rows;
  mirror syncs ride the same seam (they land as default-branch pushes);
  repo deletion enqueues an index purge (upstream's
  `DeleteRepository` notifier arm, `notify.go:70-75`). Genesis
  population is a queue-drained backfill walking unindexed repos
  (upstream's `populateRepoIndexer` shape, `indexer.go:259-313`).
- **Adoption prerequisites** (the §2.4(a) caveats, restated as gates):
  resolve or accept the `wrangler d1 export` FTS5 crash
  (cloudflare/developer-platform#11); a D1 size budget review against
  the 10 GB ceiling; the tokenizer decision; the content-cap decision.
- **What it buys then**: R02 un-capped (a filtered index query instead
  of N scans), relevance ranking, language facets (go-enry-class
  detection at index time), pagination. None of these is a v1 need at
  impact #17.

## 5. Edge cases, limits, and failure modes

1. **The fan-out cap is a first-class honesty surface** — a repo set
   larger than the cap (§8 question 2) renders the over-cap notice
   naming the covered count and the visible total; it NEVER silently
   truncates. The seed order (§8 question 3) makes the covered subset
   deterministic and reproducible across pages/refreshes.
2. **Subrequest budget** — 25 greps = 25 DO calls + 0 extra (the seed is
   one D1 query, the render is local): inside Workers Free's 50 with
   headroom for the request's other legs. The cap is also the free-plan
   compatibility guarantee; a paid deployment may raise it via the
   cap's single constant (still no var in v1 — the constant is the
   contract, §8 question 2).
3. **Latency** — bounded-batch parallelism (§8 question 6) keeps the
   fan-out's wall to roughly ceil(25/5) × the slowest grep; the CPU cap
   is never at risk (DO scan time is the DO's, waiting is free). A
   pathological repo burns its own budgets inside its own DO and
   answers `truncated` — the federation renders the partial with the
   R10 notice arms.
4. **Visibility** — the seed queries are the ONLY authority: private
   repos are absent for callers who cannot see them (the
   `doerCanViewPrivate` / visibility-ladder idioms of §2.5; anonymous
   sees genuinely-public only). No grep call is ever issued for an
   invisible repo — absence is enforced BEFORE the fan-out, not by
   filtering results after.
5. **Deleted/renamed/empty repos mid-federation** — `null` grep answers
   (unborn branch, transport) skip silently (§3.1 step 3); a repo
   deleted between the seed query and its grep contributes nothing
   (upstream cleans deleted-repo results post-search, `code.go:110-120`
   — ours never surfaces them).
6. **Huge repos** — the grep budgets already bound the per-repo cost
   (2,000 blobs / 200,000 line-steps / 50 blocks,
   `repo.d.ts:19-38`); a monorepo yields an honest partial, not a slow
   page. The federation adds NO new budget surface of its own.
7. **Binary and non-UTF-8 files** — the engine skips binary blobs
   outright and (unlike upstream's indexer) does not transcode:
   non-UTF-8 text files match only if their bytes contain the query
   encoding — the landed R10 posture, inherited unchanged.
8. **Freshness inversion, stated** — the federation is ALWAYS current
   (tip scans) while an upstream-style index would lag its queue; v1
   gives up ranking and facets to keep that property. This is the
   recorded reason the deferred indexer (§4.2) is a supplement for
   scale, not a correctness fix.
9. **Abuse shape** — the federation multiplies a single query's engine
   cost by the cap (25 budgeted scans ≈ 25 × 200,000 line-steps worst
   case, spread across 25 DOs). Anonymous rate exposure is the same
   class as R10's page (one scan) scaled by the cap constant; the
   pages carry no additional auth beyond the visibility seed. If probe
   telemetry ever shows scrape pressure, the cap is the single knob.
10. **The R02 kill-switch absence** — upstream's `DISABLE_CODE_PAGE`
    (§1 out-of-scope) has no v1 analog; the over-cap notice is the
    degradation path. Recorded as a divergence, revisitable with the
    deferred indexer.

## 6. Testing plan

Worker vitest (real bindings; the landed suites' idioms):

- **Loader**: cap arithmetic (a 30-repo visible set seeds 25 greps and
  reports `overCap: true, cap: 25, totalVisible: 30`); seed order
  stability (`updated_unix DESC, id DESC`); visibility (a private repo
  absent for anonymous, present for its owner — the seed-query level,
  asserting NO grep client was built for it); silent skip arms (empty
  repo / unborn branch / thrown transport → the row is absent, the page
  is 200); batch execution shape (chunks of 5 — observable via call
  ordering); union rollup numbers (`matched`/`scanned` counts).
- **R05 page**: route parity with upstream's shape (`/{username}/-/code`,
  the profile-context arms); bare-`q` renders the form with ZERO engine
  calls; the card header carries `owner/repo` (the R02/R05 template arm,
  §3.2); the org-context variant renders the org header (upstream's
  `RenderUserOrgHeader` position, `user/code.go:30-33`).
- **R02 page**: instance scope (two owners, one visible each for a guest
  — the guest's union sees only the public side); the over-cap notice
  text; the redirect-alternative arm IF question 1 ratifies it (the
  `/explore` 302).
- **Notices**: the always-on scan notice renders on every result arm
  (present/empty/truncated); the per-repo truncation arms reuse the
  `repo-search.tsx` message pair (counted past cap vs partial scan).
- **Divergence pins**: the mode select lists exactly exact|words (§3.3
  item 1); no `?l=` input renders; no pager renders past one page.
- **Gates**: `pnpm typecheck`; the page matrix/golden updates ride the
  wave idiom; `pnpm test:full` per ADR-0006 — a single-file `pnpm test`
  pass is never cited as suite-green.

No engine-check `.mjs` arms exist for this SPEC — nothing in
`packages/git-engine/` changes (§1 out-of-scope); the vitest suites are
the whole plan.

## 7. Milestones (serializable)

- **M1 — the federation loader + R05** (size **S/M**): the loader module
  (§3.1) + `GET /{username}/-/code` (§3.2) + tests + the ui index mount
  (the orchestrator-designated-owner rule applies to the mount).
  Un-defers the census's R05 row the moment it lands. No schema, no
  engine change — one commit-unit, one page family.
- **M2 — R02** (size **S**): the same loader over the instance-visible
  set + the `/explore/code` route + tests. Reuses M1 wholesale; the only
  new logic is the instance seed query and the over-cap copy. IF
  question 1 ratifies the redirect alternative, M2 collapses to a
  two-line route with the census row closed as "matches upstream default
  config" (the (d) disposition).
- **M3 — the indexer-class store: NOT COMMITTED.** Deferred with reopen
  triggers (§8 question 4). The §4.2 sketch is its starting SPEC
  material; it must re-enter through its own SPEC (the census's
  SPEC-first rule), owning the delta RPC, the FTS5 migration, the
  consumer arm, and the export-backup posture decision.

Entry criteria: ratified SPEC (this document → accepted), then M1 as a
worker unit; M2 rides M1's landed loader; the census ledger updates per
landing.

## 8. Open questions (resolve at ratification)

1. **R02's v1 disposition** — the capped federated page (§3.2) vs
   upstream's default-config redirect to `/explore` (`code.go:26-29`,
   the exact class-(d) parity). Proposal: **ship the capped page** — the
   census's own R10 precedent (the page is "expected" even when upstream
   default-off) extends to the explore arm, the marginal cost over M1 is
   S, and the cap notice keeps the honesty that separates this from a
   fake-global page.
2. **The fan-out cap value** — constant, not var. Proposal: **25** — one
   grep per repo keeps a full page inside Workers Free's 50-subrequest
   budget with headroom, and 25 exceeds any single user's plausible
   R05 set on a self-host while R02's over-cap notice covers the rest.
   A paid deployment raising it is a one-constant change (with the
   subrequest math re-checked); a var would invite misconfiguration the
   subrequest limit then punishes at request time.
3. **The seed order** — which repos the cap covers. Proposal:
   **`updated_unix DESC, id DESC`** — recency bias (the repos a search
   most plausibly targets), deterministic across requests, and the same
   column pair the explore listing's four-sort backing orders by (§2.5
   — explore defaults to "newest"; "recently updated" is one of its
   landed sorts), so the discovery surfaces share one vocabulary.
4. **The indexer-class deferment + reopen triggers** — confirm options
   (a)/(b)/(d)'s verdicts (§2.4) and the deferral. Proposal: **defer**;
   reopen when ANY of: the over-cap notice fires routinely on the demo
   or a production deployment (probe/telemetry evidence, the
   bench-run discipline); a ranked-search/facet feature demand lands
   (the census's impact ranking gets a real signal); or a D1 size-budget
   review concludes the 10 GB ceiling has headroom for a capped
   content index. Each reopen enters through its own SPEC on the §4.2
   sketch.
5. **The future FTS5 tokenizer posture (M3 pre-read, like 0016's
   question 6)** — trigram-only (substring ≈ exact mode; simplest, the
   grep-faithful shape) vs trigram + a unicode61 content column (adds a
   words mode; two tokenizations of one content column, ~2× index
   size). Proposal: **trigram + unicode61 columns in ONE fts5
   table**, decided finally at the M3 SPEC-attachment — recorded now so
   the tokenizer gap (§2.4(a)) is not rediscovered.
6. **Fan-out execution shape** — full `Promise.all` (fastest, spiky —
   25 concurrent DO scans) vs sequential (gentlest, worst latency) vs
   bounded batches. Proposal: **bounded batches of 5** — near-parallel
   latency (≈5 scan-depths worst case), bounded concurrent DO pressure
   (the demo sweep's serialized-consumer courtesy generalized), and a
   trivially testable ordering seam.

### Ratification (2026-10-29, orchestrator)

All six resolved per their proposals: (1) R02 ships the capped page (the
redirect stays the upstream-default arm we render when the loader declines);
(2) the fan-out cap 25 is a constant, not a var; (3) seed order
`updated_unix DESC, id DESC`; (4) the FTS5 deferment is ratified with the
recorded reopen triggers (cap-notice telemetry, ranked-search demand, D1
headroom review); (5) the tokenizer posture is an M3-opening decision over
the trigram+unicode61 sketch; (6) bounded batches of 5.
