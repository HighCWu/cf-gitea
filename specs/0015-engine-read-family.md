# SPEC-0015: The engine read family — in-repo grep, activity/contributor stats, LFS pointer scan, audit events

Status: **accepted** (ratified 2026-10-29, orchestrator — decisions appended at
§7; M1/M2a/M2b/M3 land as engine units, M4 as a worker unit per §6) ·
Date: 2026-10-29 · Fills the four engine-side prerequisites the UI gap census
classified (b) NEEDS-API
([docs/compat/ui-gap-census-2026-10-29.md](../docs/compat/ui-gap-census-2026-10-29.md):
rows R10, R14+R15, R11, R13 — the census's §"named prerequisites first"). The
fifth boundary RPC the census's (b)-engine class names — blame (R08) — is NOT
this SPEC's scope: it already landed at the boundary and is consumed
(`packages/git-engine/dist-types/repo.d.ts:415`, `apps/worker/src/ui/engine.ts:70`);
it is cited here only as the idiom every new RPC must follow.
Depends on: SPEC-0001/0001a (engine, the content-path read lease), SPEC-0001b
(the blame RPC precedent + merge primitives), SPEC-0006 (LFS store + the landed
pointer parser), SPEC-0003 §2.5 (ACL gate over engine RPCs), SPEC-0007 (org rows
— the audit org scope), SPEC-0005 (settings write paths the audit seam
instruments).
Owns: three/four engine boundary RPCs (`grep`, `activityStats`,
`contributorStats`, `scanLfsPointers`) with their budget constants, the
`computeStats` extension they share, and the `audit_event` D1 table + emit seam
+ retention sweep. The census's UI arms (repo-search page, activity pages,
settings-lfs pages, audit pages) are DOWNSTREAM of this SPEC and own their own
pages/route mounts; this SPEC owns the reads they render from.

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY, pin
`fc4936884584` — v1.22.0-rc1-3919-gfc493688). Every `web.go:N` cite is
`gitea/routers/web/web.go` at that pin; engine findings are against
`packages/git-engine/src/**` as of 2026-10-29.

---

## 1. Problem and scope

The census's directive is "upstream Gitea serves it → cf-gitea serves it". Of
its 22 residual rows, 7 are (b) NEEDS-API; four of those need capabilities that
do not exist anywhere in our stack yet — not as a route, not as a service read,
not inside the DO:

| # | Capability | Census row(s) | Verdict (verified 2026-10-29) |
|---|---|---|---|
| 1 | In-repo content search | R10 (`GET .../search`), unblocks R02/R05 | **new algorithm** — engine RPC over a budgeted tree walk + line scan |
| 2 | Commit-stats aggregation (pulse totals + per-week contributor graphs) | R14 (`GET .../activity[/{period}]`), R15 (`.../activity/{contributors\|code-frequency\|recent-commits}[/data]`) | **new algorithm** — extend the private `computeStats` fold + expose two boundary RPCs; no new table |
| 3 | LFS pointer scan | R11 (`GET .../settings/lfs[/...]`, the `pointers` + `find` arms) | **new algorithm** — engine RPC returning bounded candidate blobs; the parser itself is already landed worker-side |
| 4 | Audit-events model | R13 (`GET .../settings/audit_logs` + the R20 org arm) | **new table** — D1 `audit_event` + emit seam + retention; the one non-engine member of the family |

In scope: the four capabilities above, their boundary contracts (§3), the D1
model (§4), their tests (§5) and milestones (§6).

Out of scope (each named so it is not silently re-decided):

- **UI pages and route mounts** for every consumer row — `pages/repo-search.tsx`,
  `pages/repo-activity.tsx` + the three chart pages + their `/data` JSON tails,
  `pages/settings-lfs*.tsx`, `pages/settings-audit-logs.tsx` and the org twin.
  The census already briefed them; they dispatch after their prerequisite lands.
- **The indexer-class code search subsystem** (bleve/elasticsearch —
  `gitea/modules/indexer/code/{bleve,elasticsearch}/`). Our v1 is upstream's OWN
  non-indexed fallback path (`gitgrep`), not a port of the indexer. The census's
  R02/R05 rows (`/explore/code`, `/{username}/-/code`) open only with an
  indexer-class store and stay (d) rows; the grep RPC here does not close them.
- **The media/raw LFS resolution arm** (census R22): served by LANDGED code —
  `readBlob` (boundary, landed) + `parsePointer` (`apps/worker/src/services/lfs/pointer.ts`,
  landed port of upstream `modules/lfs/pointer.go`) + the `lfsObjects` lookup.
  No engine work; the census says the same ("the pointer-scan prerequisite is
  NOT needed for media serving, only for the settings page R11").
- **`LFSAutoAssociate` / `LFSDelete` writes** (web.go:1253, 1251): D1-side
  service arms over the landed `lfsObjects` table, owned with the downstream
  settings page wave, not by an engine RPC.
- **Upstream's audit JSONL export** (`eventJSON` marshal shape,
  `gitea/models/audit/audit_event.go:65-87`): v1 stores and pages; export is a
  downstream read-side nicety (Open question 4).

## 2. The four capabilities — upstream cites, our substrate, the gap

### 2.1 In-repo code search (census R10)

**Upstream at the pin.** The route is `m.Get("/search", reqUnitCodeReader,
repo.Search)` (web.go:1768) → `repo.Search`
(`gitea/routers/web/repo/search.go:22`). Query params: `q` (keyword), `l`
(language), `search_mode` (`exact|words|fuzzy|regexp` —
`gitea/modules/indexer/indexer.go:9-12`), `page`. Two execution paths:

- `setting.Indexer.RepoIndexerEnabled == true` → `code_indexer.PerformSearch`
  (the bleve/elasticsearch subsystem). **Upstream DEFAULTS THE INDEXER OFF** —
  the default is set in code, not the shipped ini:
  `modules/setting/indexer.go:43` (struct default `false`) and `:78`
  (`REPO_INDEXER_ENABLED` read through `MustBool(false)`; the shipped example
  config is `custom/conf/app.example.ini`) — at default config the results arm
  runs the second path, matching our absence today (the census's (d) note).
- `== false` → **the non-indexed live grep**:
  `gitgrep.PerformSearch` (`gitea/modules/indexer/code/gitgrep/gitgrep.go:27`)
  → `git.GrepSearch` (`gitea/modules/git/grep.go:47`): `git grep --null
  --break --heading --line-number --full-name` with `--context 1`
  (gitgrep.go:36), against the repo's default branch
  (`git.RefNameFromBranch(ctx.Repo.Repository.DefaultBranch)`, search.go:62).
  Modes at the pin (gitgrep.go:28-35 + grep.go:61-72):
  - `exact` → `--fixed-strings` (case-SENSITIVE literal, grep.go:62);
  - `words` → `--fixed-strings --ignore-case`, one expression per whitespace
    word, all `--and`ed (grep.go:67-72) — the DEFAULT when `search_mode` is
    absent (`grepMode := git.GrepModeWords`, gitgrep.go:28);
  - `regexp` → `--perl-regexp` (grep.go:64);
  - `fuzzy` is NOT offered on the gitgrep path
    (`GitGrepSupportedSearchModes` = exact + words + regexp,
    `gitea/modules/indexer/indexer.go:46-53`).
  Result cap: `GrepOptions.MaxResultLimit` defaults to **50 result blocks**;
  the pipeline is CANCELLED once the cap trips (grep.go:77 default +
  grep.go:109 `ctx.CancelPipeline`). The repo-search caller passes no override
  (the options block at gitgrep.go:35-41 sets no MaxResultLimit), so upstream's
  fallback answers at most 50 files, `total = len(res)` is that capped count,
  and paging slices inside it (gitgrep.go:50-53). A 30 s wall timeout backs the
  whole run (`grepSearchTimeout`, grep.go:43-45).
  Result shape per file: `GrepResult{Filename, LineNumbers[], LineCodes[]}`
  (grep.go:20-23) rendered as `code_indexer.Result{Filename, CommitID, Lines}`
  with the resolved tip's commit id (gitgrep.go:54-64); language/updated fields
  are explicitly "not supported yet" on the fallback path (gitgrep.go:59-61).
  Instance-level include/exclude pathspecs fold in from
  `setting.Indexer.{Include,Exclude}Patterns` as `:(glob)` pathspecs
  (gitgrep.go:17-25) — empty at default config.

**Our substrate (verified against `packages/git-engine/src`):** there is NO
content search anywhere. The engine's only "grep" is the cgit log page's
COMMIT-MESSAGE substring filter (`matchesFilter`, repo.ts:1684-1699 — `qt=grep`
tests `e.commit.message`), which is a different capability (upstream's own log
filter, not code search); the tree/blob machinery it needs is all landed:
`resolveRef`/`peelToCommit` (repo.d.ts:461-467), the recursive `flattenTree`
walker (repo.ts:1890-1898 — path→{oid,mode} map over the whole tree),
`store.typeAndSize` (index-only DO-SQLite read — no R2 GET, the idiom cited at
repo.ts:1261-1263), `store.get` blob bytes, `isBinary` sniffing (used at
repo.ts:1346).

**The gap:** a budgeted `grep` RPC (§3.1) — tree walk + line scan inside the DO,
matching upstream's fallback semantics (exact/words; regexp per Open question
1) with the engine's scan-cap discipline standing in for the 30 s git timeout.
Divergence to ledger: upstream caps results SILENTLY at 50 (the pager shows a
capped total); ours returns the same cap shape but flags `truncated` honestly
(the blame RPC's budget-exit rule — "a budget-bounded WALK is not `null`",
repo.d.ts:408-410).

### 2.2 Commit-stats aggregation for the activity graphs (census R14 + R15)

**Upstream at the pin.** Three surfaces share one computation family:

- **The pulse page** `GET .../activity[/{period}]` (web.go:1628-1631) →
  `repo.Activity` (`gitea/routers/web/repo/activity.go:22`): period windows
  daily −24 h / halfweekly −72 h / weekly −168 h / monthly −1 mo / quarterly
  −3 mo / semiyearly −6 mo / yearly −1 y (activity.go:29-45; unknown falls to
  weekly). Gated on reading ANY of the code/issues/pulls/releases units
  (web.go:1648 `RequireUnitReader`, with `reqUnitCodeReader` at :1646). The
  code unit calls
  `GetActivityStats` (`gitea/models/activities/repo_activity.go:48`) →
  `GetCodeActivityStats(ctx, timeFrom, repo.DefaultBranch)`
  (`gitea/modules/git/repo_stats.go:38`) over
  `git log --numstat --no-merges --pretty=format:---%n%h%n%aN%n%aE%n --since=<RFC3339>
  --first-parent <branch>` (repo_stats.go:55-59 — `--branches=*` when no
  branch is given), parsing WINDOW TOTALS: `AuthorCount`, `CommitCount`,
  `ChangedFiles` (distinct paths), `Additions`, `Deletions`,
  `CommitCountInAllBranches` (a separate `rev-list --count --no-merges
  --branches=*` walk, repo_stats.go:43-46) plus `Authors[]{Name, Email,
  Commits}` — **per-author commit counts only; add/del are totals, not
  per-author** (parse loop repo_stats.go:99-143: per-author keying at
  :113-118, add/del accumulated globally at :125/:130, the file set at
  :149). The
  census's "additions/deletions per author" phrasing for R14 is imprecise: the
  pulse page's per-author column is commits; per-author add/del belongs to R15.
- **The three chart pages + `/data` tails** (web.go:1633-1646) →
  `repo.Contributors`/`ContributorsData` (`routers/web/repo/contributors.go:20,28`),
  `repo.CodeFrequency`/`CodeFrequencyData` (`routers/web/repo/code_frequency.go:20,31`),
  `repo.RecentCommits` (`routers/web/repo/recent_commits.go:18`) — pages render
  client-side; BOTH `/data` arms call the same
  `GetContributorStats(ctx, cache, repo, DefaultBranch)`
  (`gitea/services/repository/contributors_graph.go:80`): ContributorsData
  returns the whole `map[string]*ContributorData` (contributors.go:36),
  CodeFrequencyData returns `contributorStats["total"].Weeks` only
  (code_frequency.go:39), and **recent-commits' `/data` mounts
  `repo.CodeFrequencyData` too** (web.go:1644 — the census's "recent-commits
  reuses the code-frequency data"). `ErrAwaitGeneration` maps to **202
  Accepted** (contributors.go:31-33, code_frequency.go:33-35).
  - The walk: `git log --shortstat --no-merges --pretty=format:---%n%aN%n%aE%n%as
    --reverse <revision>` (contributors_graph.go:119) — full history of the
    default branch, NOT first-parent.
  - The shape (`contributors_graph.go:41-58`): `ContributorData{Name, Login,
    AvatarLink, HomeLink, TotalCommits, Weeks: map[int64]*WeekData}` keyed by
    author EMAIL (normalized to the user's PRIMARY email through
    `GetUserByEmail` so one account's addresses merge, :228-232); empty-email
    commits skipped (:223-226); unmapped emails keep their commit name + a
    generated avatar (:233-249, avatar generation at :237). `WeekData{Week, Additions, Deletions,
    Commits}` where `Week` = the **Unix MILLISECOND timestamp of the last
    Sunday before the commit's author date** (`findLastSundayBeforeDate` +
    `val.UnixMilli()`, :61-73 + :258/:261). A `"total"` pseudo-entry aggregates
    every author (:217-221).
  - The posture: cache key `GetContributorStats/<fullname>/<revision>`, **10
    minute** timeout (`contributorStatsCacheTimeout = 60*10`, :32-33); first
    uncached call starts ONE async generation (`generateLock`, :84-90), awaits
    5 s (`awaitGenerationTime`, :36), then answers `ErrAwaitGeneration` while
    the walk continues in the background (:91-99).
- **The author feed** (landed already, for context):
  `GET .../activity_author_data[/{period}]` (web.go:1684-1686) — top-10
  authors by commit count over `--branches=*` — our landed port is
  `apps/worker/src/ui/pages/activity-author-data.ts` (top-10 per window over
  the engine walk, the email→user mapping idiom this SPEC reuses).

**Our substrate (verified):** the DO's private `computeStats`
(repo.ts:2590-2633) is the ONLY stats machinery. Verified shape: a
`walkLog(tipOid, 0, MAX_STATS_SCAN, …)` walk (repo.ts:2597 — MAX_STATS_SCAN =
2000, repo.ts:131) folded into `{periodKeys, authors: [{name, counts:
Record<bucket, n>}], totals, count}` — **commit counts only**, bucketed by
COMMITTER time into fixed calendar buckets w/m/q/y (`keyOf`, repo.ts:2598-2608),
cached per immutable `(tip_oid, period)` pair in the DO SQLite `stats_cache`
table with no TTL (`store.getStatsCache/setStatsCache`,
`packages/git-engine/src/git/store.ts:641-655` — the immutability argument:
history under an immutable oid never changes). Served only by the DO's own
cgit stats page (`statsPage`, repo.ts:2635). It is private — NOT on the
boundary (absent from repo.d.ts's RepoCell surface).

**The gaps (why `computeStats` does not cover the three graph families):**

1. **No additions/deletions anywhere** — the fold never reads trees/diffs.
2. **Wrong time model** — fixed calendar buckets w/m/q/y by committer time vs
   upstream's wall-clock WINDOW (`--since`) for the pulse page and Unix-ms
   Sunday-anchored week buckets for the graphs.
3. **No merge exclusion** — `walkLog` walks ALL parents (the per-pop parent
   push, repo.ts:1726);
   both upstream walks are `--no-merges` (repo_stats.go:56,
   contributors_graph.go:119).
4. **Wrong branch shape** — one tip; upstream's pulse reads the default branch
   FIRST-PARENT (repo_stats.go:58-59) while the graphs walk the default branch
   full-history (the graph walk, contributors_graph.go:119) and the author
   feed walks
   `--branches=*`.
5. **No boundary exposure** — private, cgit-only.
6. **Cache misses are safe but time-windowed answers go stale** — the
   `(tip_oid, period)` key is immutable-proof for fixed buckets, but a
   `--since=now-168h` answer changes as wall time advances even under a fixed
   tip; the cache needs a computed-at stamp + TTL for the new keys (§3.2).

**The work:** extend the fold (add/del per walked commit via the readDiff
idiom — `readDiff(id)` already defaults id2 to the first parent, repo.ts:1270-1296),
add merge exclusion + week/window bucketing + a TTL for windowed keys, and
expose `activityStats` + `contributorStats` at the boundary (§3.2). No new D1
table — the cache rides `stats_cache`.

### 2.3 LFS pointer scan (census R11)

**Upstream at the pin.** The settings group is web.go:1249-1261: `LFSFiles`
(paged meta list), `LFSFileGet` (+ `FindLFSFile` — in-tree paths referencing
an oid), `LFSDelete`, `LFSPointerFiles` (the scan), `LFSAutoAssociate`,
`LFSFileFind`, and the locks trio (locks LANDED per SPEC-0006). The scan
handler renders `lfs.PointerBlob`s produced by
`lfs.SearchPointerBlobs` (`gitea/modules/lfs/pointer_scanner.go:31`): a
4-stage pipeline — `cat-file --batch-check --all` (every object),
`BlobsLessThan1024FromCatFileBatchCheck` (size gate ≤ 1024),
`CatFileBatch` (read the survivors), `createPointerResultsFromCatFileBatch`
(parse each candidate with the pointer grammar) — i.e. **size-gate first,
parse second**, exactly the cheap-to-expensive order.

**The pointer grammar** (`gitea/modules/lfs/pointer.go`): `MetaFileMaxSize =
1024` (:22), first line exactly `version https://git-lfs.github.com/spec/v1`
(:24), then `oid sha256:<64 lowercase hex>` and `size <n>` (:25-26, parsed by
`ReadPointerFromBuffer` at :53-80);
three error classes (`ErrMissingPrefix` / `ErrInvalidStructure` /
`ErrInvalidOIDFormat`, :28-35).

**Our substrate (verified):** the parser is ALREADY LANDED worker-side —
`apps/worker/src/services/lfs/pointer.ts` is a documented port of upstream
`modules/lfs/pointer.go:20-112` (`POINTER_MAX_BYTES = 1024`, `parsePointer`
with a non-strict probe mode, `generatePointer`, and the GC reachability
sha1). The `lfsObjects` D1 table is landed (`apps/worker/src/db/schema.ts:1072-1090`:
`repo_id` + `oid` + `size` + `state` + timestamps, pk (repo_id, oid)). What
does NOT exist: any read that maps refs → pointer files. The census's
verification stands.

**The gap:** a budgeted `scanLfsPointers` engine RPC (§3.3) producing the
CANDIDATE set (blobs whose tree-entry size is ≤ 1024 bytes — `store.typeAndSize`
is an index-only read, so the size gate costs no R2 GET, the repo.ts:1261-1263
idiom), with the ENGINE staying format-agnostic: it returns the candidate
blobs' bytes and the WORKER parses (landed `parsePointer`) and joins
`lfsObjects`. Rationale: the vendored engine must not grow a second copy of a
parser SPEC-0006 already owns (the deviation-ledger discipline,
`packages/git-engine/NOTICE.md`), and LFS semantics stay in the app layer.
Upstream's `FindLFSFile` reverse map (oid → referencing paths) is the same
scan filtered by oid — the RPC's optional `oid` param (§3.3) serves it without
a second algorithm.

### 2.4 Audit events (census R13 + the R20 audit arm)

**Upstream at the pin.** `GET .../settings/audit_logs` (web.go:1279) and the
org twin (web.go:1063) → `repo_setting.ViewAuditLogs` /
`org_setting.ViewAuditLogs` (`gitea/routers/web/repo/setting/audit.go:12`,
`gitea/routers/web/org/setting/audit.go:12`) over a SHARED renderer
(`gitea/routers/web/shared/audit/audit.go`) reading ONE model:
`models/audit.Event` (`gitea/models/audit/audit_event.go:22-38`), table
`audit_event`:

| upstream column | type / index |
|---|---|
| `ID` | pk autoincr |
| `Action` | `Action` (string), INDEX, NOT NULL |
| `ActorID` | int64, INDEX, NOT NULL |
| `ActorName` | string |
| `ActorCredential` | string — "access-token:<id>", "oauth2-grant:<id>", "gitea-actions:<task id>", "deploy-key:<key id>" |
| `ImpersonatorID` / `ImpersonatorName` | int64 INDEX / string — admin-acting-as |
| `ScopeID` + `ScopeType` | int64 NOT NULL + `ScopeType` — composite INDEX(scope) |
| `ScopeName` | string |
| `Origin` | `ui` / `api` / `cli` / `system` (`origin.go:9-14`), INDEX, NOT NULL |
| `Message` | string — rendered from the action's message template |
| `Metadata` | LONGTEXT JSON — target-specific details |
| `IPAddress` | string |
| `TimestampUnix` | TimeStamp, INDEX, NOT NULL |

Scope types are exactly `system | user | organization | repository`
(`gitea/models/audit/scopes.go:11-16`) — "target-specific details live in
Metadata, not as typed objects" (scopes.go:6-8). Actions are hierarchical
colon-separated ids registered with message templates
(`gitea/models/audit/action.go:65+` — `user:*`, `organization:*` (create /
delete / name / visibility / member / team / oauth2application / secret /
webhook), `repository:*` (create / fork:create / archive / unarchive /
delete, :136-140+)), and `ActionFilters()` derives family prefixes so an
operator can filter a whole family like `user:impersonation` (action.go:38-54).
One model serves the repo tab, the org tab, AND the user-settings arm upstream.

**Our substrate (verified):** none — `apps/worker/src/db/schema.ts` has no
audit table (the only "audit" hits are comments about index audits), no emit
seam, no store. The census's verdict — "a genuine needs-model row" — stands.

**The gap:** the D1 `audit_event` table + indexes (§4), an emit seam service,
slice-one instrumentation of the write classes the settings pages actually
read, and a retention sweep. Verdict: **new table** — and the only member of
this family that touches no engine code (no git data involved; D1 access goes
through Drizzle per the architecture boundaries).

## 3. RPC shapes — the boundary contracts

Every new RPC follows the blame RPC's idiom (the census R08 precedent, landed):

1. **Engine side** — a public method on `RepoCell`
   (`packages/git-engine/src/repo.ts`): `this.rpcBind()` at entry
   (repo.ts:1332 pattern), the whole read wrapped in
   `this.withContentLease(async (gate) => …)` (the SPEC-0011 §3 content-path
   lease — every served content read rides it, repo.d.ts:338-370), `resolveRef`
   → `peelToCommit` first, and the availability ladder: **`null` on
   hard-absence** (unresolvable ref, empty repo, missing path), **`truncated`
   on a budget-bounded walk** — never `null` for a budget exit (repo.d.ts:405-410).
   New budget constants live beside the existing family
   (PATH_LOG_SCAN repo.ts:123, MAX_LOG_SCAN repo.ts:121, MAX_STATS_SCAN
   repo.ts:131, MAX_BLAME_BYTES repo.ts:133). Boundary declarations regenerate
   via `pnpm typecheck` (`dist-types/` is GENERATED, never hand-edited — the
   AGENTS.md structure rule).
2. **Worker side** — the read goes through the landed wrappers: the API
   service seam resolves `null` on a thrown RPC so transport failure and the
   engine's not-found are one shape (`apps/worker/src/api/services/engine.ts`
   module doc), and the UI seam's `safe()` wrapper does the same
   (`apps/worker/src/ui/engine.ts:70` blame pattern). New RPCs are appended to
   BOTH interface copies of the boundary (they already enumerate `blame`
   explicitly, ui/engine.ts:53-56).
3. **ACL** — the reads are repo-scoped engine JSON paths; the SPEC-0003 §2.1
   amended ACL gate already widens to "repo-scoped engine JSON/admin paths for
   D1-resolved repos", so no new gate work; the DOWNSTREAM routes apply their
   own unit/permission gates (upstream `reqUnitCodeReader` on search and the
   chart group, web.go:1768 + 1635-1646).

### 3.1 `grep(ref?: string, opts?: { q?: string; mode?: "exact" | "words" | "regexp"; path?: string }): Promise<GrepResult | null>`

- `ref` absent = HEAD (the blame convention). `q` empty/absent → `null`
  (upstream renders the bare form when `Keyword == ""`, search.go:31-33; the
  downstream page owns that render — the RPC refuses empty work).
- `mode` default `"words"` (upstream's default, gitgrep.go:28). `words` =
  per-whitespace-word case-insensitive substring, ALL words required (the
  `--and` semantics, grep.go:67-72). `exact` = whole-query case-sensitive
  substring (`--fixed-strings`). `regexp` = JS `RegExp` on the decoded line —
  compile once, apply per line, under the step budget; compile failure →
  `null` (Open question 1 backs the whole mode).
- `path` = optional path-prefix filter (our reduction of upstream's
  instance-configured `:(glob)` pathspecs, gitgrep.go:17-25 — empty by default
  upstream, so v1 loses nothing at default config).
- Walk: `peelToCommit` → `flattenTree` (repo.ts:1890) in path order; per blob:
  skip entries over `MAX_GREP_BLOB_BYTES`; `store.get` under the gate;
  binary-sniffed blobs skipped (the blame `isBinary` idiom, repo.ts:1346);
  line scan collecting `{num, code}` hits (1 context line matches upstream's
  `--context 1` posture? — NO: context lines cost bytes; v1 returns MATCH
  lines only, and the downstream page renders the match lines as upstream's
  `ResultLine{Num, FormattedContent}` list. Upstream's fallback returns
  context too but renders highlighted match lines; the divergence is
  ledger-ready and byte-cheap).
- Budgets (new constants, repo.ts constant block):
  - `MAX_GREP_FILES = 2000` blobs content-scanned per run (the
    `MAX_STATS_SCAN` family's magnitude);
  - `MAX_GREP_BLOB_BYTES = 512 * 1024` (the `MAX_DIFF_BLOB` value, repo.ts:120
    — files bigger than the diff cap don't grep);
  - `MAX_GREP_RESULT_FILES = 50` result blocks (upstream's own fallback cap —
    `MaxResultLimit` default 50, grep.go:77, silently enforced there);
  - a scan-step counter bounds total line reads per run (one magnitude:
    200k lines), standing in for upstream's 30 s timeout (grep.go:43-45).
- Answer: `{ ref: string; commit: string; results: { path: string; lines: {
  num: number; code: string }[] }[]; total: number; truncated: boolean }` —
  `commit` is the resolved tip oid (upstream's `CommitID` per result,
  gitgrep.go:56), `total` = the result count BEFORE the result-file cap
  sliced it where the step budget allowed counting, `truncated` = any budget
  exit (files cap, step cap, result cap) so the page can show the honest
  partial (the census R10 brief's "indexer-off-equivalent honest-absence if a
  repo exceeds budget").
- No cache — searches are query-shaped (unbounded key space), unlike stats.
  Repeat clicks pay the walk; the walk is the budget's job to keep cheap.

### 3.2 `activityStats(ref?: string, period?: string): Promise<ActivityStatsResult | null>` and `contributorStats(ref?: string): Promise<ContributorStatsResult | null>`

**`activityStats`** — the pulse page's code unit (R14):

- `period` ∈ `daily|halfweekly|weekly|monthly|quarterly|semiyearly|yearly`
  (upstream's exact set + durations, activity.go:29-45); unknown/absent =
  `weekly` (upstream's default, activity.go:29). `ref` absent = HEAD; the
  answer is computed over the resolved tip's FIRST-PARENT chain with merge
  commits excluded (the `--first-parent <branch> --no-merges` walk,
  repo_stats.go:55-59; first-parent = walk the parents[0] chain directly —
  a tighter, cheaper walk than walkLog's frontier).
- Fold per walked commit within the window (since = now − window): commit
  count, author {name, email} → per-email commit counts (lowercased email
  keying, repo_stats.go:113-118), numstat-shaped add/del per commit via the
  readDiff idiom against the first parent (repo.ts:1270-1296) accumulated into
  WINDOW TOTALS `additions`/`deletions` and a distinct-file set →
  `changedFiles` (repo_stats.go:119-149, distinct-file set at :149).
  Binary/- lines count as upstream's parser counts them (`"-"` fields
  skipped, repo_stats.go:123/128).
- Answer (upstream `CodeActivityStats` shape, repo_stats.go:20-28, plus our
  honesty fields): `{ period: string; authorCount: number; commitCount: number;
  changedFiles: number; additions: number; deletions: number; authors: { name:
  string; email: string; commits: number }[]; count: number; truncated:
  boolean }` — authors sorted commits-DESC (repo_stats.go:145). The email
  → user display mapping (DisplayName/login/avatar/home) is the DOWNSTREAM
  service's job over D1 (the landed activity-author-data idiom) — the engine
  returns git identities only. `commitCountInAllBranches` (repo_stats.go:26)
  is NOT in v1 — it needs a second all-refs walk (Open question 2).
- Budgets: the walk caps at `MAX_STATS_SCAN` = 2000 commits (the existing
  constant); the add/del fold runs only for commits INSIDE the window and
  skips a commit's diff when either tree pair exceeds `MAX_DIFF_BLOB` totals
  (the computeDiff per-file cap already bounds each file; the fold reuses
  `computeDiff`'s add/del tallies, repo.ts:1901-1910 + the DiffFileJson
  add/del fields). `truncated` = the walk hit its cap before the window's
  oldest edge (the answer's window is then partial — flagged, never silent).
- Cache: `stats_cache` under `period = "act:<period>"` — windowed keys carry a
  computed-at stamp and a **10-minute TTL** (upstream's contributors timeout,
  contributors_graph.go:33 — one freshness contract for the family); a stale
  hit recomputes. Fixed-bucket keys keep the no-TTL immutability rule
  (store.ts docstring).

**`contributorStats`** — the three chart pages' `/data` source (R15):

- `ref` absent = HEAD; the answer is the resolved tip's FULL-history walk
  (all parents — NOT first-parent, contributors_graph.go:119), merge commits
  excluded (`--no-merges`).
- Fold per walked non-merge commit: author email (lowercased; empty skipped,
  :223-226) → `weeks[weekMs]` where `weekMs` = UTC-ms of the last Sunday
  before the AUTHOR date (the `findLastSundayBeforeDate` + `UnixMilli`
  arithmetic, :61-73 + :258/:261) accumulating `additions`/`deletions` (the same
  readDiff fold) + `commits`, plus per-author `totalCommits`. The engine
  returns git identities only: `{ contributors: { [lowercasedEmail]:
  { name: string; email: string; totalCommits: number; weeks: Record<number,
  { week: number; additions: number; deletions: number; commits: number }> } },
  count: number; truncated: boolean }`. The `"total"` pseudo-entry, the
  email→user PRIMARY-email normalization, `login`/`avatar_link`/`home_link`
  and the JSON wire shape (`WeekData` json tags, contributors_graph.go:47-58)
  are assembled DOWNSTREAM over D1 (the landed GetUserByEmail-by-way-of-our-
  users-table idiom in activity-author-data.ts) — upstream does the mapping
  inside the generator (:232-249); ours splits git-fold (engine) from identity
  (D1) along the architecture boundary.
- Budgets: the same `MAX_STATS_SCAN` walk cap; the same add/del fold rules.
  `truncated` flags a capped walk (old weeks partial/missing — upstream walks
  to the root; we flag the honest prefix, the blame rule).
- Cache: `stats_cache` under `period = "contrib"`, keyed by the immutable tip
  oid — NO TTL needed (fixed-history fold, the immutability argument holds);
  the 10-minute upstream freshness is a cache-population concern, and an
  immutable-tip fold never goes stale. Synchronous-with-budget, no async
  generation: Workers cannot hold a 5-second-await-then-background walk
  (upstream's `ErrAwaitGeneration` + `generateLock` posture,
  contributors_graph.go:34-99 — `ctx.waitUntil` is sub-second-only per the
  Workers rules); the census's "decide in the SPEC" is decided HERE: the
  first uncached call computes under budget and answers complete-or-truncated,
  never 202 (Open question 3 records the alarm-prewarm alternative).

### 3.3 `scanLfsPointers(ref?: string, opts?: { path?: string; oid?: string }): Promise<LfsPointerScanResult | null>`

- `ref` absent = HEAD. `null` on unresolvable ref / empty repo.
- Walk: `peelToCommit` → `flattenTree` (the LFS-relevant whole-tree view);
  candidate filter = blob entries with `store.typeAndSize(oid).size <= 1024`
  (the `MetaFileMaxSize` gate — upstream's stage 2, pointer_scanner.go:44-47;
  the index-only read costs no R2 GET); `path` prefix-filters the tree walk,
  `oid` post-filters candidates to that exact LFS oid AFTER parsing (the
  `FindLFSFile` reverse map — upstream's in-tree-paths-for-an-oid arm,
  census R11).
- Candidates' bytes are read (`store.get` under the gate) and returned RAW —
  the engine stays pointer-grammar-agnostic; the worker parses with the
  landed `parsePointer` (`apps/worker/src/services/lfs/pointer.ts`) and joins
  `lfsObjects` (§2.3's rationale).
- Budgets: `MAX_LFS_SCAN_FILES = 20000` tree entries visited (trees are cheap
  DO-SQLite/index reads but unbounded repos exist), `MAX_LFS_CANDIDATES = 500`
  returned rows (each ≤ 1 KiB — worst case ~500 KiB across the RPC, the same
  order as `readBlob` answers); `truncated` on either cap.
- Answer: `{ ref: string; commit: string; candidates: { path: string; oid:
  string; size: number; data: Uint8Array }[]; truncated: boolean }` — `oid`/
  `size` are the GIT blob's; the LFS pointer's oid/size come from the worker's
  parse. No cache (cheap index-gated walk; query-shaped like grep).

## 4. Data model

### 4.1 `audit_event` (new D1 table — the family's only schema change)

Drizzle table in `apps/worker/src/db/schema.ts`, migration generated via
`pnpm db:generate` into `apps/worker/src/db/migrations` (the structure rule).
Column-for-column port of upstream's `Event` (audit_event.go:22-38) onto D1
types:

| column | D1 type | notes |
|---|---|---|
| `id` | integer pk autoincrement | |
| `action` | text NOT NULL | upstream `Action`; hierarchical colon ids (`repository:visibility`, `organization:team:permission`, …) with message templates — our registry mirrors `action.go`'s define() pattern in `src/services/audit.ts` |
| `actor_id` | integer NOT NULL | index |
| `actor_name` | text NOT NULL default '' | snapshot at emit time (upstream `ActorName`) |
| `actor_credential` | text | "access-token:<id>" etc.; nullable — session UI writes carry none |
| `impersonator_id` | integer NOT NULL default 0 | index; 0 = no impersonation |
| `impersonator_name` | text | |
| `scope_type` | text NOT NULL (`system\|user\|organization\|repository`) | enum check |
| `scope_id` | integer NOT NULL default 0 | 0 for system (upstream: "zero for system", audit_event.go:30) |
| `scope_name` | text | snapshot |
| `origin` | text NOT NULL (`ui\|api\|cli\|system`) | |
| `message` | text NOT NULL default '' | rendered from the action template |
| `metadata` | text (JSON) | nullable |
| `ip_address` | text | nullable |
| `created_unix` | integer NOT NULL | index |

Indexes: `action`, `actor_id`, `impersonator_id`, `created_unix`, and the
composite `idx_audit_event_scope` on (`scope_type`, `scope_id`) — upstream's
`INDEX(scope)` (audit_event.go:30-31) — which the paged read orders by
`created_unix DESC` (the D1 keyset-page idiom; if the composite alone can't
serve the ordered page, extend the composite with `created_unix` at migration
time — implementation detail, decided by `pnpm db:generate` + the query plan,
not here).

### 4.2 The emit seam

`src/services/audit.ts`: `emitAudit(db, event)` (fire-and-record, part of the
caller's transaction where one exists — audit rows must not outlive the write
they describe) + the action registry (`defineAction(id, messageTemplate)`) +
`renderMessage(event)`. Slice-one instrumentation = the write classes the
settings pages actually read (the census's rule), i.e. `repository:*` and
`organization:*` events emitted from the LANDED write paths: repo
create/delete/archive/visibility/rename (SPEC-0003 lifecycle + settings
service), org create/delete/rename/visibility, member add/remove, team
add/update/remove/membership (SPEC-0007). `user:*` and `system:*` classes
exist in the registry's type space but are NOT instrumented in slice one (the
user-settings arm upstream serves is downstream demand).

### 4.3 Retention

A daily cron producer enqueues a sweep; the queue consumer deletes
`audit_event` rows older than the retention window (default **90 days**, Open
question 4) — the AGENTS.md rule that crons enqueue and consumers do the work,
riding the SPEC-0014 §2 repo-tasks DLQ/producer precedent
(`apps/worker/src/services/demo-sweep.ts` idiom). The window is a config var
so the example template carries it.

### 4.4 No new tables for capabilities 1-3

grep and the scans are cacheless walks (§3.1/§3.3); the stats folds cache
into the EXISTING DO-SQLite `stats_cache` table (`store.ts:641-655`) under new
`period` keys (`act:<period>`, `contrib`) plus the TTL stamp for windowed
keys — DO-internal storage, not D1, so no migration rides them.

## 5. Testing plan

Engine checks (the `packages/git-engine/e2e/check-*.mjs` idiom — seeded real
packs, assertions against both the boundary and the invariants; the
`check-blame.mjs` / `check-tree-commits.mjs` precedents):

- `check-grep.mjs` — seeded repo: exact (case-sensitive), words
  (case-insensitive multi-word AND), binary-blob skip, over-cap blob skip,
  path-prefix arm, the 50-result cap + `truncated`, unresolvable-ref `null`,
  budget honesty (a walk-truncating fixture flags `truncated`).
- `check-activity-stats.mjs` — fold correctness against a fixture with known
  numstats: window slicing (a commit outside the window excluded), merge
  exclusion, first-parent chain (a side-branch commit excluded), add/del
  totals, distinct `changedFiles`, authors sorted DESC, TTL invalidation (a
  stamped cache entry past TTL recomputes), `truncated` at `MAX_STATS_SCAN`.
- `check-contributor-stats.mjs` — week bucketing against fixed dates (the
  last-Sunday arithmetic incl. a Sunday edge — bucket to THAT Sunday),
  per-author weeks + `totalCommits`, empty-email skip, merge exclusion,
  immutable-tip cache hit (no TTL), full-history (non-first-parent) walk
  shape, `truncated`.
- `check-lfs-pointers.mjs` — candidate set exactness (a >1024-byte pointer-
  shaped blob EXCLUDED, a valid pointer INCLUDED, non-pointer small blob
  included as candidate for the worker to reject), `oid` filter arm, `path`
  arm, both caps + `truncated`.

Worker vitest (real bindings, the `applyD1Migrations` +
`ensureSeededRepo` idiom of `apps/worker/src/api/engine-read.test.ts`):

- audit: emit + template render, paged read by scope (order + filter),
  composite-index plan sanity, retention sweep consumer, slice-one
  instrumentation hitting the landed write paths (create/delete/archive,
  org/team arms), transactional coupling (a failed write emits nothing).
- stats/grep/scan service arms: the null-on-transport wrapper behavior
  appended to the read client (`api/services/engine.ts`), the downstream JSON
  assembly for contributor weeks + identity mapping (the upstream wire shape
  fixture, contributors_graph.go:47-58).
- Gates: `pnpm typecheck` regenerates `dist-types/` (the boundary-declaration
  gate), `pnpm test:full` per ADR-0006 — a single-file `pnpm test` pass is
  never cited as suite-green.

## 6. Milestones (the census's sizing, serializable)

- **M1 — `grep` RPC** (size L; census R10 "size L"): engine algorithm +
  budgets + `check-grep.mjs` + dist-types regen + the two worker wrappers.
  Serves R10 and — at an indexer-class later — the R02/R05 revisit's engine
  substrate. One commit-unit; no D1 migration.
- **M2 — the stats family** (size L in total, two M-halves): M2a
  `activityStats` (the `computeStats` extension: merge exclusion, window
  bucketing, add/del fold, TTL stamp; census R14 "M with the counts-only
  degradation, L with the full shortstat RPC" — this IS the full RPC);
  M2b `contributorStats` (week bucketing + per-author weeks; census R15 size
  L is mostly the DOWNSTREAM charts — the engine half is M). M2b after M2a
  (the census: "Serialize after R14 — same RPC family"). One shared
  `check-activity-stats.mjs` + `check-contributor-stats.mjs` pass.
- **M3 — `scanLfsPointers` RPC** (size M; census R11 "size M" for the whole
  row, of which the engine half is this SPEC's share): candidates RPC +
  `check-lfs-pointers.mjs` + the worker parse/join read. The settings page
  family and the associate/delete write arms stay downstream.
- **M4 — audit events** (size L; census R13 "L sized for the model +
  instrumentation"): migration + `src/services/audit.ts` + slice-one
  instrumentation + retention sweep + worker tests. Independent of M1-M3 —
  dispatchable in parallel (different files, different gates).

Entry criteria: ratified SPEC (this document → accepted), then M1/M2a/M2b/M3
land as engine units (engine + engine-checks + wrappers together — a boundary
RPC without its check does not land), M4 as a worker unit (migration + service
+ tests together).

## 7. Open questions (resolve at ratification)

1. **grep `regexp` mode** — upstream offers `--perl-regexp` on the fallback
   path (grep.go:64); a JS-RegExp line matcher in workerd needs a
   backtracking step budget, and a pathological pattern can still burn the
   scan cap. Ship regexp-under-step-budget in M1, or honest-absent the mode
   (`exact|words` only) until demand shows? Proposal: ship it budgeted — the
   cap makes the worst case bounded — but ratification may prefer the cut.
2. **`commitCountInAllBranches`** — upstream's pulse header shows it
   (repo_stats.go:26) but it costs a second all-refs walk per answer. v1
   omits it (proposal); add in a follow-up if the downstream page wants it.
3. **contributorStats pre-warm** — the synchronous-with-budget posture can
   make the FIRST uncached chart load answer a truncated prefix on very large
   repos. An alarm-based pre-warm (compute on push finalize, the DO alarm
   precedent) would hide that. v1: not built; revisit only with a real
   truncation complaint (the SPEC-0012 gate discipline: demand first).
4. **Audit retention window + export** — 90 days default is proposed; the
   upstream JSONL export shape (audit_event.go:65-87) is v1-out. Both are
   downstream-configurable without schema change.
5. **`scanLfsPointers` auto-associate** — the census's `LFSAutoAssociate`
   (web.go:1253) is a D1 write arm over the scan's output. This SPEC owns the
   READ; the write rides the downstream settings wave (§1 out-of-scope) —
   confirm the split.
6. **`audit_event` composite index shape** — (`scope_type`, `scope_id`) then
   order-by `created_unix DESC` may want `created_unix` folded into the
   composite (§4.1). Decide at `pnpm db:generate` time against the real query
   plan (the d1-index-engineering research note is the reference).

### Ratification (2026-10-29, orchestrator)

1. **regexp: SHIP in M1, budgeted** — upstream has the mode; the step budget
   bounds the worst case; the no-deferral directive applies.
2. **`commitCountInAllBranches`: OMIT in M2a v1** — the second all-refs walk
   is a real per-answer cost for a header nicety; revisit at M2a dispatch
   against the landed activity page's header parity (if the page renders the
   all-branches count, add it then).
3. **contributorStats pre-warm: NOT BUILT v1** — first-load truncation only
   bites very large repos; revisit on a real truncation report.
4. **Retention 90 days, JSONL export v1-out** — as proposed; both
   downstream-configurable without schema change.
5. **LFS auto-associate split CONFIRMED** — the READ is this SPEC; the write
   arm rides the downstream settings wave (§1).
6. **Index shape: deferred to `db:generate` time with the query-plan
   criterion** — as proposed.

Milestone dispatch note (this ratification): M1 lands ENGINE-ONLY while the
UI wave holds `apps/worker/src/ui/engine.ts` — the `EngineClient.grep`
wrapper folds into that wave's combined landing, keeping the unit's file
ownership exclusive.
