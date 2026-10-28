# D1 Index Engineering — the 0036 wave's durable record

The engineering record of the D1 index wave (migration
`0036_fantastic_whirlwind`, commit `b04a465`, 2026-10-28): how the audit was
run, the two D1 platform behaviors it had to defeat, and the witness that
keeps the wave honest from here on. Written so the next index wave (the P2
sweep) does not relearn any of it. Every identifier below is quoted from the
tree at `b04a465`; nothing is invented.

Sources of record:

- `apps/worker/src/db/migrations/0036_fantastic_whirlwind.sql` — the ten
  CREATE INDEX statements (the migration's entire body).
- `apps/worker/src/db/schema.ts` — the same ten indexes declared in Drizzle,
  each with its audit comment block (caller cites + upstream cross-reference).
- `apps/worker/src/bench-d1.test.ts` — the index witness (the always-on
  describe block at the file's tail).
- Commit `b04a465` — the wave's message carries the headline rows_read pairs
  and the landing gate.

## 1. The audit method

**A schema-declared-indexes × hot-query-shape matrix.** One axis is what the
schema actually declares (`apps/worker/src/db/schema.ts`); the other is the
query shapes the hot paths actually issue, gathered from the call sites under
`src/services/**`, `src/api/**`, and `src/ui/**`. A table with no index
serving a hot shape is a finding; an index no hot shape uses is a dead drop.
Each surviving index got its matrix cell written down IN the schema: every
declaration added by the wave carries a comment block naming its callers
verbatim. Examples (line numbers at `b04a465`):

- `labels_repo_id_idx` / `labels_org_id_idx` (`schema.ts:671-680`): the
  labels table had NO index at all — repo side cites
  `api/services/labels.ts:101` (list), `:135` (name precheck),
  `api/services/issues.ts:545` + `pulls.ts:646` (attach resolution),
  `projects.ts:1053`; org side cites `api/services/labels-t2.ts:69/90/103`.
- `issues_repo_pull_closed_created_idx` (`schema.ts:522-533`): the shared
  WHERE builder binds `repo_id = ?` (or an IN-list), `is_closed = ?`,
  `is_pull = ?`, then orders `created_unix DESC, id DESC`
  (`api/services/issues.ts` `issueFilterConditions:632-637` + page ORDER BY
  `:693/:714`; pulls twin `api/services/pulls.ts:235`).
- `reactions_issue_comment_release_idx` (`schema.ts:741-752`): the page
  render and delete-by-target bind `WHERE issue_id = ? AND comment_id = ?
  AND release_id = 0` (`api/services/issue-extras.ts:59-62` and `:118-126`);
  the existing `reactions_target_uq` leads with `user_id`, so neither call
  site could use it.

**Upstream cross-reference is part of the matrix.** Each cell was checked
against upstream Gitea's xorm tags (the `gitea/` submodule, read-only) —
"Upstream-matched where an upstream index exists; divergences documented at
each" (b04a465). Two documented divergence classes from the wave:

- *Collapse*: upstream keeps scalar indexes where we compose one composite
  in the exact filter+order shape the call sites bind. The issues list page
  is the flagship — upstream has `RepoID INDEX UNIQUE(repo_index)`,
  `IsClosed INDEX`, `IsPull INDEX`, `CreatedUnix INDEX created`
  (`models/issues/issues.go`); our single
  `issues_repo_pull_closed_created_idx` serves filter AND order, so the page
  reads an ordered index range instead of a repo scan + filesort. The two
  poster heatmaps compose upstream's scalar `PosterID INDEX` with the
  `CreatedUnix` order the same way.
- *Addition*: upstream has no index for a shape we serve hot.
  `issue_subscriptions_issue_idx` is the recorded case — upstream's
  `UNIQUE(watch)` leads with `user_id` only and upstream scans the
  issue-side probes too (`models/issues/issue_watch.go:18-20`); we added the
  reverse-direction index per the follows/star precedent
  (`schema.ts:832-839`). The reactions composite folds upstream's separate
  `ReleaseID INDEX` in as the trailing column because both call sites bind
  `release_id = 0` in the same predicate — with the future
  release-reactions caveat documented in place (`schema.ts:741-752`).

**Measurement protocol.** Two instruments, one deterministic:

- `EXPLAIN QUERY PLAN` through a plain `prepare()` — D1 supports it (plain
  SQLite; verified by the witness itself, whose plan step would fail a
  rejection: `bench-d1.test.ts:862-864`). The plan assertion is THE GATE.
- `rows_read` from the D1 response `meta` is the deterministic cost anchor
  (`bench-d1.test.ts:856-858`: "D1's rows_read meta is the deterministic
  cost anchor (wall ms in local workerd is noisy)"). Wall time is color
  only: "the timings are informational" (`bench-d1.test.ts:75`).

## 2. The two platform facts (hard-won, 0036 wave)

### 2.1 D1 caches compiled plans — same-text probes see STALE plans after DDL

After a `DROP INDEX`, re-running a byte-identical `EXPLAIN QUERY PLAN` can
still report the OLD plan naming the dropped index. The D1 session serves
cached compiled plans keyed on the SQL string; the planner never re-runs.
Observed directly during the wave ("observed: post-drop EXPLAIN still named
the dropped index", `bench-d1.test.ts:1030-1034`).

**Defeat: make every probe statement textually unique.** The witness appends
a monotonic comment tag to each EXPLAIN
(`bench-d1.test.ts:1028-1042`):

```ts
explainSeq += 1;
const result = await raw
  .prepare(`EXPLAIN QUERY PLAN ${sql} /* witness-${explainSeq} */`)
  .bind(...binds)
  .all<{ detail: string }>();
```

The timed loops need the same treatment per state — `measureShape` tags its
statement `witness-with` / `witness-without` (`bench-d1.test.ts:1044-1046`,
with the comment "without it the 'without indexes' state would time the
cached indexed plan"). Rule for the next wave: **any probe that must observe
a schema change gets a fresh unique comment per observation**, never a
recycled SQL string.

### 2.2 DDL statements need `exec()`, not `.run()`

`DROP INDEX` / `CREATE INDEX` go through `D1Database.exec()` — the documented
migration/setup path — not through a prepared statement's `.run()`. The
witness drops and restores all ten indexes this way
(`bench-d1.test.ts:1255-1259`, `:1280`) and wraps the move with a
`sqlite_master` re-check so a silent no-op drop fails loudly instead of
measuring a fiction:

```ts
for (const [name] of WITNESS_INDEXES) {
  await raw.exec(`DROP INDEX IF EXISTS "${name}";`);
}
// ... SELECT name FROM sqlite_master WHERE type='index' AND name IN (...)
expect(droppedLeft.results, "witness drop must remove all ten indexes").toHaveLength(0);
```

(The metering wrapper in the same file passes `exec` through untouched,
`bench-d1.test.ts:236` — DDL is never metered as statement rows.)

## 3. The witness pattern (`bench-d1.test.ts`)

The bench block at the top of the file is `describe.skipIf(!BENCH_ENABLED)`
— benchmark-gated, never in CI's critical path. The index witness at the
tail is the deliberate OPPOSITE: it **runs in plain `pnpm test`** (no
`D1_BENCH` binding needed) and is migration 0036's test-visible witness
(`bench-d1.test.ts:68-75`). Structure, per the file:

1. **Deterministic seeded corpus** (untimed): a target repo and a distractor
   repo under distinct owners, seeded by modular assignment so every row is
   reproducible — `posterId: i % 5 === 0 ? otherId : ownerId`,
   `isPull: i % 10 === 0`, `isClosed: i % 3 === 0`
   (`bench-d1.test.ts:1146-1156`). Corpus constants
   (`bench-d1.test.ts:1013-1017` + the seed bodies): 300 target-repo issues
   + 250 distractor issues = **550 issues**; **55 labels** (30 repo + 15 org
   + 10 distractor); **30 milestones** (20 + 10); **250 reactions** (5
   watchers x the first 50 target issues); **60 comments**; **200
   subscriptions** (first 100 target issues x 2 watchers); **160 actions**
   (120 + 40); **4 repositories**.
2. **State A (migrated)**: for each of the ten audited shapes, the EXPLAIN
   plan must match `USING (COVERING )?INDEX <the new index>`; then a timed
   loop of `WITNESS_TIMED_RUNS = 30` executions with one metered call
   capturing `rows_read` (`bench-d1.test.ts:1242-1253`, `:1047-1059`).
3. **State B (pre-migration, honest)**: drop all ten via `exec()`, re-check
   `sqlite_master`, assert each shape's plan now does NOT name the index,
   re-measure (`bench-d1.test.ts:1255-1277`).
4. **Restore**: replay the ten CREATE INDEX statements VERBATIM from
   `WITNESS_INDEXES` — kept "in lockstep with
   src/db/migrations/0036_fantastic_whirlwind.sql" — and re-check
   `sqlite_master`, so the file leaves the schema exactly as migrated
   (`bench-d1.test.ts:866-868`, `:1279-1289`).
5. **Report**: one `[index-witness]` line per shape (`rows_read X -> Y`,
   mean ms both states) plus the machine-readable
   `##INDEX_WITNESS_JSON##` line (`bench-d1.test.ts:1291-1330`) — the same
   parse convention as the sibling bench's `##D1_BENCH_JSON##`.

**The ten shapes** (`witnessShapes`, `bench-d1.test.ts:934-1011`) — each is
the verbatim statement its service issues, binds filled from the fixtures,
with the caller cite in a comment:

| Shape | Index | Caller cite (in-file) |
|---|---|---|
| labels.repo list | `labels_repo_id_idx` | `api/services/labels.ts:101` |
| labels.org list | `labels_org_id_idx` | `api/services/labels-t2.ts:69` |
| reactions target scan | `reactions_issue_comment_release_idx` | `api/services/issue-extras.ts:59-62` (delete twin `:118-126`) |
| issues repo list page | `issues_repo_pull_closed_created_idx` | `api/services/issues.ts:693/:714` |
| milestones repo list | `milestones_repo_id_idx` | `api/services/milestones.ts:133` |
| repositories owner scan | `repositories_owner_id_idx` | `services/orgs/orgs.ts:619-620` |
| issues poster heatmap | `issues_poster_created_idx` | `api/routes/user-read-t2.ts:150-160` |
| comments poster heatmap | `comments_poster_created_idx` | `api/routes/user-read-t2.ts:163-171` |
| action repo feed page | `action_repo_deleted_created_idx` | `api/services/activity-feeds.ts` `feedCondition` + `:388` |
| issue_subscribers probe | `issue_subscriptions_issue_idx` | `api/services/issue-extras.ts:175` |

The action shape documents its own limit in place: the feed's
`user_id = act_user_id` column-to-column predicate is one the index cannot
serve — the composite orders the range, the predicate filters it
(`bench-d1.test.ts:995-1000`).

### Headline numbers

Quoted from the b04a465 commit message (the measured `rows_read`, without ->
with):

- **reactions target scan 250 -> 6** — the full-table scan (250 rows)
  becomes the 5-entry index range (+1 descent).
- **issues list page 480 -> 30** — the page's `LIMIT 30` reads 30 ordered
  index entries.
- **issue subscriptions 200 -> 3** — 2 matching rows + the descent.

Two more pairs from the same witness run's `##INDEX_WITNESS_JSON##` record
(orchestrator's record of the run; they are not printed in the commit
message, but they are exactly what the committed corpus arithmetic predicts
— every pair is "matching rows + 1", the same descent constant the three
quoted pairs show):

- **comments poster heatmap 60 -> 13** — 12 of the 60 comments carry the
  target poster (`watcherAt(i)` assigns `watchers[0]` at `i % 5 == 0`).
- **issues poster heatmap 550 -> 441** — 440 of the 550 issues carry the
  target poster (240 in the target repo + 200 in the distractor), read
  index-only: the query selects `created_unix` alone, which the
  (`poster_id`, `created_unix`) composite carries, so SQLite reports
  `USING COVERING INDEX` — the one covering read of the wave ("the issues'
  is COVERING — index-only reads", b04a465).

The gate discipline bears repeating: **the plan assertions are the gate; the
numbers are informational**; the wave's landing gate was
"101/101 +5 bench-skips x2; openapi PASS" (b04a465). There is deliberately
NO numeric regression gate yet ("NO BASELINE GATE",
`bench-d1.test.ts:63-66`) — a follow-up may add one once the variance band
is confirmed, using bench-run's `--compare` pattern.

## 4. Carried findings for the next wave

- **Corpus-annotation drift in the witness file (found while writing this
  record, unfixed)**: the seed loop at `bench-d1.test.ts:1202` comments "Six
  reactions on each of the first 50 target issues (300 rows)" and the
  `##INDEX_WITNESS_JSON##` corpus line prints `reactions: 300`
  (`bench-d1.test.ts:1321`) — but the `watchers` array holds FIVE ids
  (`ownerId`, `otherId`, three watch users, `bench-d1.test.ts:1119-1120`),
  so the seed inserts 5 x 50 = **250** reaction rows, and the measured
  without-index scan is 250 (the commit message's own number). The "300"
  annotation is stale, not the data. A follow-up test-only touch should fix
  the comment and the JSON constant; the audit numbers are unaffected.
- Keep `WITNESS_INDEXES` in lockstep with the migration file — the
  drop/recreate protocol depends on the replay restoring the migrated
  schema byte-for-byte (`bench-d1.test.ts:866-868`). The P2 sweep (migration
  0037) must extend BOTH files together or the restore step will fight the
  new migration.
- The P2 sweep's dead-drop half (indexes no hot shape uses) should reuse the
  same matrix: a dead drop is a schema-declared index whose cell in the
  shape matrix stayed empty — the witness's plan-assertion machinery needs
  no change to prove a removal.
- Chunk sizes in the seed are the D1 100-variable cap divided by the
  table's column count (comments insert 3 at a time) — relevant if the
  corpus grows (`bench-d1.test.ts:284-290`, `:1216-1217`).
