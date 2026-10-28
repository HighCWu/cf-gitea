# Upstream issue draft — workerd/miniflare dev runtime: `DROP TABLE` against a sqlite-backed Durable Object database created by a previous runtime session fails `SQLITE_LOCKED` forever

Status: **DRAFT ONLY — not filed.** The orchestrator/user files it; no `gh`/network
write happens from agents. Prepared 2026-10-28. This is the "upstream-report
candidate" the landing commit `ed0efed` ("fix(engine): content-less cell DELETE =
no-op success — the SQLITE_LOCKED 'husk' closed, root cause one layer deeper")
names in its disclosure (3). Sources condensed here: that commit message, the
2026-10-28 `packages/git-engine/NOTICE.md` rows (`src/repo.ts`,
`e2e/check-delete-husk.mjs`), the known-red 3 resolution note in
`scripts/mirror-e2e.README.md`, and the husk unit's scratch repro at
`/tmp/husk-repro` (**ephemeral** — its driver scripts were read and re-verified
2026-10-28 before this draft; the run outputs were NOT preserved, see the
could-not-verify ledger at the end). The "Issue body" section below is
paste-ready verbatim: no product, repo-layout, or private references survive in
it — it is standalone-repro-first, in the shape of
`docs/research/ws1009-upstream-issue-draft.md` (filed as workers-sdk#16515).

Versions in the environment table were verified against the installed tree
(`pnpm-lock.yaml` + the pnpm store at HEAD `ed0efed`): `miniflare@5.20261019.2-beta`
is upstream's coordinated EXACT pin (declared verbatim by `wrangler@4.152.0`,
`@cloudflare/vite-plugin@1.65.0`, `@cloudflare/vitest-plugin@1.4.7` — see
`docs/research/miniflare-beta-pin.md`; no stable miniflare satisfies it), and it
ships `workerd@1.20261019.1`. The inline repro script was syntax-checked
(`node --check`) but deliberately NOT re-executed (this unit runs no new runtime
experiments); every claimed outcome in it is one the husk unit observed — the
filing checklist makes re-running it the filer's first gate.

---

## Proposed title

```
[miniflare] DROP TABLE on a sqlite-backed Durable Object database created by a previous session fails SQLITE_LOCKED forever (CREATE TABLE and all DML unaffected)
```

Shorter alternative if the template prefers concise titles:

```
[miniflare] sqlite-DO databases are permanently DDL-locked (SQLITE_LOCKED) for every session after the one that created them
```

---

## Issue body (paste-ready)

### What versions & operating system are you using?

| Component | Version |
|---|---|
| OS | Ubuntu 24.04.2 LTS (x64), kernel 6.14.0-37-generic |
| Node | v25.9.0 |
| miniflare | 5.20261019.2-beta (the exact coordinated pin declared by wrangler 4.152.0 / @cloudflare/vite-plugin / @cloudflare/vitest-plugin) |
| workerd | 1.20261019.1 (binary shipped by the miniflare pin above) |
| compatibility_date | 2026-10-19 |

### Describe the Bug

On a **sqlite-backed Durable Object** (`useSQLite: true`), once the DO's SQLite
database file has been **created by one runtime session**, every LATER runtime
session can `CREATE TABLE` and run arbitrary DML against that database — but
**every `DROP TABLE` fails with `SQLITE_LOCKED`** ("database table is locked").
The failure is:

- **deterministic** — the first `DROP TABLE` attempted in the new session fails;
  no warm-up traffic or prior statement is needed;
- **table-independent** — a table that the CURRENT session just created with a
  succeeding `CREATE TABLE` cannot be dropped either; the trigger is the
  database file's age across the session boundary, not the table's;
- **permanent** — it survives any number of further restarts; retrying in the
  same session fails identically. There is no recovery path short of deleting
  the database file out-of-band while the runtime is down;
- **specific to workerd's DO SQLite storage** — plain SQLite (node:sqlite)
  driving the same application code paths, including DROP-heavy wipes of
  reopened databases, never reproduces it.

The exception message observed through `state.storage.sql.exec` is
`database table is locked: SQLITE_LOCKED`.

Inside the session that CREATES the database, DDL works fine — including a
drop-and-recreate schema wipe. So applications escape only while a DO lives and
dies within one runtime process. The moment the dev server restarts (wrangler
dev, the Cloudflare vite/vitest plugins — any setup persisting DO state to
disk), any code path that drops tables (schema migrations with DDL steps,
destroy/wipe/teardown endpoints) turns into a deterministic, forever-failing
operation for every database created before the restart.

**Scope caveat stated up front:** every observation below is on the LOCAL dev
runtime (miniflare/workerd per the versions table). We have NOT tested deployed
Workers; production behavior is unverified.

### Reproduction

Self-contained; a single script, miniflare only, no other dependencies. Three
sessions over one persisted state directory — session A creates the database,
session B and C are fresh runtimes over the same file. `dispose()` is a full
runtime teardown; the persistence path is what lets the database survive it
(wrangler dev persists the same way under `.wrangler/state`).

`repro-ddl-cross-session-locked.mjs`:

```js
// Standalone reproduction: on workerd (via miniflare), a DROP TABLE against a
// sqlite-backed Durable Object database created by a PREVIOUS runtime session
// fails with SQLITE_LOCKED — deterministically, across any number of restarts —
// while CREATE TABLE and all DML against the same database work fine.
//
//   npm i miniflare@5.20261019.2-beta
//   node repro-ddl-cross-session-locked.mjs
//
// Expected: every statement in session A and every SELECT/INSERT/CREATE in
// sessions B/C reports {"ok":true,...}; every DROP TABLE in sessions B and C
// reports {"ok":false,"error":"... SQLITE_LOCKED"} (the failure persists across
// the session-C restart, and keeps doing so on any further restart).
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Persisted per run, thrown away so a rerun starts from a clean slate. The
// persistence path is the point: it is what lets a database file survive the
// runtime teardown between sessions (wrangler dev persists the same way under
// .wrangler/state).
const STATE = join(mkdtempSync(join(tmpdir(), "ddl-repro-")), "state");

const SCRIPT = `
export class Db {
  constructor(state, env) { this.state = state; }
  async fetch(req) {
    const q = new URL(req.url).searchParams.get("q");
    try {
      const cursor = this.state.storage.sql.exec(q);
      return Response.json({ ok: true, rows: cursor.toArray().slice(0, 5) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e) });
    }
  }
}
export default {
  fetch() { return new Response("worker up"); },
};
`;

function makeMf() {
  return new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: STATE,
    workers: [{
      name: "ddl-repro",
      script: SCRIPT,
      modules: true,
      compatibilityDate: "2026-10-19",
      durableObjects: { DB: { className: "Db", useSQLite: true } },
    }],
  }));
}

async function sql(mf, label, q) {
  const ns = mf.getDurableObjectNamespace("DB");
  const res = await ns.getByName("cell").fetch("https://do/sql?q=" + encodeURIComponent(q));
  console.log(label.padEnd(44), JSON.stringify(await res.json()));
}

async function main() {
  rmSync(STATE, { recursive: true, force: true });

  console.log("--- session A: the session that CREATES the database file");
  const mfA = makeMf();
  await sql(mfA, "A: CREATE TABLE t  (DDL)", "CREATE TABLE t (a INTEGER)");
  await sql(mfA, "A: INSERT INTO t   (DML)", "INSERT INTO t VALUES (1)");
  await mfA.dispose(); // full runtime teardown; the database file persists on disk

  console.log("--- session B: a fresh runtime over the SAME database file");
  const mfB = makeMf();
  await sql(mfB, "B: SELECT * FROM t  (DML read)", "SELECT * FROM t");
  await sql(mfB, "B: INSERT INTO t    (DML write)", "INSERT INTO t VALUES (2)");
  await sql(mfB, "B: CREATE TABLE t2  (DDL)", "CREATE TABLE t2 (a INTEGER)");
  await sql(mfB, "B: DROP TABLE t     (DDL)", "DROP TABLE t");     // <-- FAILS
  await sql(mfB, "B: DROP TABLE t2    (DDL, created this session)", "DROP TABLE t2"); // <-- FAILS
  await mfB.dispose();

  console.log("--- session C: restart again; the FIRST and only statement is the DROP");
  const mfC = makeMf();
  await sql(mfC, "C: DROP TABLE t2    (DDL, sole statement)", "DROP TABLE t2"); // <-- FAILS
  await mfC.dispose();
}

main();
```

```bash
npm i miniflare@5.20261019.2-beta
node repro-ddl-cross-session-locked.mjs
```

Expected output (abridged): every row `{"ok":true,...}` except the three marked
`FAILS`, which return `{"ok":false,"error":"database table is locked:
SQLITE_LOCKED"}`. The session-C row is the sharpest single fact: a freshly
constructed DO whose FIRST and only SQL statement of the session is a bare
`DROP TABLE` — no other statement in the session, nothing to leak — fails
identically.

### Controls that pin the boundary

All variants were run against the pinned runtime above (driver scripts over the
same shape as the repro; app-level wrapping varied, outcomes identical):

| Variant | Outcome |
|---|---|
| DDL in the session that creates the database — combined `CREATE …; DROP …` and separate two-step create/drop, plus an app-level schema wipe (drop + re-create of many tables) | works |
| Bare single-statement `DROP TABLE` as the session's FIRST and only statement, on a freshly constructed cell | fails identically — rules out leaked cursors / open statements from earlier traffic as the cause |
| Per-statement probes on a reopened database: `PRAGMA journal_mode`, `SELECT`, `INSERT`/`DELETE` (DML), `CREATE TABLE` | all succeed; the FIRST `DROP TABLE` attempted fails, no warm-up needed |
| `DROP` of a table created in the SAME reopened session (`CREATE t2` succeeds, `DROP TABLE t2` immediately after) | fails — the trigger is the database file predating the session, not the table |
| Never-wiped ("healthy") cell vs wiped/husk cell, both reopened across a restart | identical failure — any database created by a previous session |
| Second `DROP` retry within the same reopened session | fails again |
| Further restart; `DROP` as the sole statement of a third session | still fails — persists indefinitely across restarts |
| Plain SQLite (node:sqlite) driving the same application code path, including DROP-heavy wipes of reopened databases | never reproduces — the failure is specific to workerd's sqlite-DO storage, not SQLite itself |

We did not identify the internal mechanism inside workerd; the surface facts
above are the complete claim.

### Impact

- **Any `wrangler dev` restart bricks DDL for existing sqlite DOs (local dev +
  CI).** Schema-destroy/rebuild flows — migrations that drop tables, delete/wipe
  endpoints, per-test fixture teardown against persisted state — fail
  deterministically on their first run after a restart, forever, with a generic
  `SQLITE_LOCKED` that reads like transient contention but never resolves.
- **Green-to-red with no code change:** merely restarting the dev server
  converts a previously passing teardown into a permanent failure; the app then
  500s on the same statement across any number of further restarts.
- **Affects the vite/vitest plugin ecosystems transitively:** the same pinned
  miniflare/workerd pair runs under `@cloudflare/vite-plugin` and
  `@cloudflare/vitest-plugin`, so test suites that persist DO state between
  runs and exercise schema teardown hit the same wall in CI.
- **Production behavior UNVERIFIED (call-out):** the repro is local-runtime
  only. If deployed DO databases also outlive the isolate/session that created
  them, the same class may exist in production — we have not tested that, and
  this report does not claim it. Flagging for triage.

### Suggested fix directions

1. **Make DDL on a reopened sqlite-DO database behave like CREATE/DML** — at
   minimum `DROP TABLE` should succeed for a database whose file predates the
   session, as `CREATE TABLE` already does.
2. **If a lock is held by design across sessions**, release or validate it at
   open; failing that, surface a DISTINCT, documented error so consumers can
   distinguish a structural "this database is DDL-locked across sessions"
   condition from genuine transient `SQLITE_LOCKED` contention (today's message
   invites retry loops that can never succeed).
3. **Document the limitation** if neither is near-term: today the only consumer
   recovery is deleting the database file out-of-band while the runtime is down,
   which nothing in the error message points to.

---

## Evidence ledger (internal — the husk unit's controls, not pasted upstream)

Where the evidence lives:

- **Landing commit `ed0efed`** (message, root-cause paragraph, verbatim): "on
  the pinned miniflare-5-beta/workerd, EVERY DROP TABLE against a sqlite-DO
  database created by a previous runtime session fails SQLITE_LOCKED,
  deterministically, forever (a bare single-statement DROP on a fresh healthy
  cell fails identically — no other statements in session). Healthy cells escape
  by living and dying in one dev session; purged husks are simply what LATER
  sessions' cleanups hit."
- **`packages/git-engine/NOTICE.md` 2026-10-28 `src/repo.ts` row** (verbatim,
  the observed surface): "the git-http gate's D1-missing admin passthrough
  forwards every later engine-shape DELETE of that name VERBATIM — where the
  wipe's `DROP TABLE` failed with `database table is locked: SQLITE_LOCKED`,
  deterministically and across dev-server restarts. Root cause found by runtime
  experiment (NOT the open-cursor hypothesis, which controls DISPROVE — a bare
  single-statement `DROP TABLE` RPC on a freshly constructed, never-wiped cell
  fails identically): on the pinned dev runtime (miniflare 5.20261019.2-beta /
  workerd 1.20261019.1, `compatibility_date 2026-10-19`), EVERY `DROP TABLE`
  against a sqlite-DO database created by a PREVIOUS runtime session fails
  `SQLITE_LOCKED` — CREATE and all DML work; DDL worked within the session that
  created the database."
- **`scripts/mirror-e2e.README.md` known-red 3** (verbatim, the product-side
  observation that started it): "EVERY later engine DELETE of that name answered
  `HTTP 500 — database table is locked: SQLITE_LOCKED`, deterministically and
  across dev-server restarts (reproduced 2026-10-28 on a quiet fresh server for
  all four `mirrore2e` names)." Marked RESOLVED engine-side 2026-10-28 with the
  corrected root cause.
- **`packages/git-engine/e2e/check-delete-husk.mjs`** — the mutation-checked
  gate on the PINNED runtime with real restarts; its header states why it cannot
  run on the node:sqlite harness: "the failure it pins is a property of the
  runtime's SQLite storage (SQLITE_LOCKED on DROP TABLE against a database
  reopened by a newer runtime session), which the draining NodeSql helper never
  reproduces." Its mutation check supplies the exact failure string: "with the
  repo.ts husk branch reverted, the three cross-restart checks FAIL with the
  exact `500 \"error: database table is locked: SQLITE_LOCKED\\n\"`."
- **The unit's scratch repro `/tmp/husk-repro`** (EPHEMERAL — outside the repo;
  driver scripts read and folded into this draft 2026-10-28, outputs not
  preserved). What each driver pinned:

| Driver | Control it pinned |
|---|---|
| `drive.mjs` | The original product shape: create → purge (tombstone+destroy via real DO RPCs) → registry probe → engine DELETE ×2 (the first 500 pre-fix). |
| `drive2.mjs` | The purge flow across THREE separate server processes: fresh quiet server, first contact with the cell is the DELETE; again after a further restart — the "across dev-server restarts" claim. |
| `drive3.mjs` | HEALTHY (never-purged) repo: create in session A, restart, DELETE in session B — the same failure without any husk involved (healthy cells only escape by dying in-session). |
| `drive4.mjs` | EXP-1: warm reads (`info/refs`, admin config GET) before the post-restart DELETE do not help; EXP-2: DELETE of a never-existing name in-session answers 200 (in-session DDL healthy). |
| `drive5.mjs` | Per-statement instrumentation on a reopened cell: `PRAGMA journal_mode`, `DROP TABLE IF EXISTS nosuchddl`, `CREATE ddlprobe`, `DROP ddlprobe`, `DROP` of an engine-owned table, `SELECT`/`DELETE` DML — CREATE and DML fine, DROP fails. |
| `drive6.mjs` | The in-session/cross-session DDL boundary: same-session combined `CREATE;DROP`, separate create/drop, and the engine's own wipe (drop+re-create of the whole schema) all work; the same statements after one restart fail on the DROP. |
| `drive7.mjs` | The cleanest control pair: never-wiped vs wiped cells, both reopened; per-cell CREATE-then-DROP probes; a second DROP attempt in the SAME reopened session; a third session after another restart — failure identical throughout. |
| `nsprobe.mjs` / `cellmap.txt` | Harness plumbing (namespace API probe; sqlite-file ↔ DO-name map of the dev state dir for per-table instrumentation). |

---

## Our workaround (internal — the consumer side this issue can cross-reference)

The defect outlives the engine fix that uncovered it. Cf-gitea's git engine
(vendored durable-git) wipes a repo cell with a drop-and-recreate transaction on
its DELETE surface; on the pinned dev runtime that wipe is exactly a
cross-session `DROP TABLE` batch, so any cell whose database file predates the
dev-server process 500'd on DELETE — the visible victims being the empty "husk"
files a completed purge leaves behind, which are precisely what later sessions'
cleanups hit.

Landing commit **`ed0efed`** ("fix(engine): content-less cell DELETE = no-op
success — the SQLITE_LOCKED 'husk' closed, root cause one layer deeper"),
recorded in `packages/git-engine/NOTICE.md` 2026-10-28 rows `src/repo.ts` and
`e2e/check-delete-husk.mjs`: the DELETE branch treats a **content-less** cell
(schema accepted AND `hasAnyContent()` false — no refs, pack rows, or loose
objects) as **no-op success** (`200 "deleted"` with only idempotent side
effects — best-effort `deleteAlarm` + R2 prefix purge), never reaching the DROP;
content-bearing cells still wipe (in-session DDL works); sealed stores keep the
wipe as their recovery path. Pinned by the new `e2e/check-delete-husk.mjs` (5
checks on the pinned runtime with real restarts; mutation-checked — reverting
the branch fails the three cross-restart checks with the exact 500).

**Residual (verbatim from the commit's disclosure 3):** "the runtime defect
OUTLIVES this fix for content-bearing cells locally (first DELETE after a dev
restart still 500s; queue retries + DLQ backstop; upstream-report candidate,
production behavior unverified)". I.e. the workaround covers the empty-husk
class only; a cross-session DELETE of a cell that still carries content still
fails until the runtime defect is fixed — the mirror suite additionally sweeps
cell files at the FILE level before its dev server starts (harmless hygiene
that doubles as the out-of-band recovery the issue body mentions).

---

## Filing checklist (internal — not pasted upstream)

- **Target repo:** `cloudflare/workers-sdk` (miniflare lives there), per this
  task's assignment. Note for triage: the failing layer is workerd's sqlite-DO
  storage, so the root cause may move to `cloudflare/workerd`; say so in one
  line when filing. This also tracks the miniflare-5 GA revisit in
  `docs/research/miniflare-beta-pin.md` — if the coordinated beta pin moves, the
  versions table must move with it.
- **Template:** `.github/ISSUE_TEMPLATE/bug-template.yaml` ("🐛 Bug Report").
  Required fields map 1:1 to the body above: versions/OS (table), link to a
  minimal repro (the script is self-contained in the body; no external repo
  needed), description, optional logs (paste the `SQLITE_LOCKED` rows).
- **Re-verify before filing (mandatory — this draft did not re-execute the
  script):**
  1. ~~Extract the inline script to a scratch dir, `npm i
     miniflare@<the version then pinned by wrangler/vite-plugin/vitest-plugin>`,
     run it, and confirm the outcome pattern~~ **DONE 2026-10-28 (filing-prep
     unit) — outcome CONTRADICTS the predicted table: with the one required
     fix (`await` on `getDurableObjectNamespace`) applied, session B's DROPs
     SUCCEED. See "Filing verification (executed) 2026-10-28" §1.**
  2. ~~Re-run `pnpm test`-style check `packages/git-engine/e2e/check-delete-husk.mjs`
     on this repo's then-current tree~~ **COVERED VIA THE FROZEN ENGINE BUNDLE
     instead 2026-10-28: `check-delete-husk.mjs` itself was not run because the
     working tree carries a sibling wave's uncommitted hunks in
     `packages/git-engine/src/repo.ts`/`mod.ts` (result would not attribute
     cleanly); the husk unit's original drivers (drive5/6/7 against the frozen
     patched bundle in `/tmp/husk-repro`) re-verified the identical
     cross-session `SQLITE_LOCKED` signature on the pinned runtime. See §1.**
  3. ~~Search workers-sdk/workerd issues for the exact signature~~ **DONE
     2026-10-28 — NO duplicate exists; closest relatives and why-not-duplicate
     table in §2. File as a new issue (after resolving the §1 repro blocker).**
- **Labels:** the workers-sdk template assigns none automatically; mention in
  the text that this concerns miniflare's dev runtime / the pinned workerd
  binary (prerelease miniflare pin).
- **Suggested gh command** (explicit `--title`/`--body-file` bypasses the web
  form — acceptable, or paste section-wise into the 🐛 Bug Report form):

```bash
gh issue create --repo cloudflare/workers-sdk \
  --title '[miniflare] DROP TABLE on a sqlite-backed Durable Object database created by a previous session fails SQLITE_LOCKED forever (CREATE TABLE and all DML unaffected)' \
  --body-file /tmp/ddl-cross-session-issue-body.md
```

---

## Could-not-verify ledger (internal — listed, not guessed)

1. **The unit's raw run outputs were not preserved.** `/tmp/husk-repro` keeps
   the driver scripts, the last-run state dir, and a patched-source snapshot —
   no stdout logs. Every outcome claimed above is backed by the landing commit
   message, the NOTICE row, the known-red resolution, and the
   check-delete-husk gate (all quoted in the evidence ledger), but the
   per-driver literal outputs are reconstructions from those records plus the
   scripts themselves.
2. **`drive5`'s unasserted probes:** the recorded finding covers
   PRAGMA/CREATE/DML-ok and DROP-fails. Whether `DROP TABLE IF EXISTS
   <nonexistent>` on a reopened database also fails (and the `PRAGMA
   journal_mode` value observed) was not recorded anywhere quotable — the
   issue body deliberately does not claim either. The inline repro likewise
   omits them.
3. **The inline repro script was not executed** (this unit runs no new runtime
   experiments; `node --check` only). It is a faithful recomposition of the
   unit's verified drive steps using the same miniflare API shape
   (`convertV4MiniflareOptions`, `resourcePersistencePath`, `useSQLite`,
   `dispatchFetch`-free `ns.getByName().fetch()`) as the committed
   check-delete-husk gate — but the filer MUST run it per the checklist before
   filing.
4. **Production (deployed Workers) behavior: unverified** — called out in the
   issue body itself; the repro is local-runtime only.
5. **Compatibility-date dependence:** all evidence is at `compatibility_date
   2026-10-19`; whether older/newer dates change the behavior was never probed.
6. **Mitigation space:** `VACUUM`, `PRAGMA wal_checkpoint`, or any
   close/checkpoint sequence as a pre-restart escape was never probed; the only
   recovery the unit demonstrated is file-level deletion while the runtime is
   down.
7. **Duplicate upstream reports:** none searched from here (see checklist step
   3).

---

## Filing verification (executed) — 2026-10-28 (filing-prep unit)

Executed the filing checklist against the CURRENT tree/lockfile. Headline:
**the defect itself re-verified on the pinned runtime today, but the draft's
paste-ready inline repro script does NOT reproduce it** — the issue body must
not be filed as-is. Details below; the body above is left untouched.

### 1. Inline repro execution — DOES NOT REPRODUCE (filing blocker)

Setup: script extracted verbatim from the body to `/tmp/ddl-repro-verify/`;
run with node v25.9.0 against the repo's pinned miniflare from the pnpm store
(`node_modules/miniflare` symlinked to
`.pnpm/miniflare@5.20261019.2-beta_@types+node@26.6.5/.../miniflare`; miniflare
is a transitive dep, not hoisted). `node --check` passes.

- **Script bug (hard failure before any SQL):** in miniflare
  5.20261019.2-beta, `mf.getDurableObjectNamespace("DB")` returns a lazy
  thenable proxy; without `await`, `ns.getByName` is `undefined` →
  `TypeError: ns.getByName is not a function` at the first `sql()` call.
  Verified `await mf.getDurableObjectNamespace(...)` yields a namespace whose
  `getByName` is a function. One-word fix (`await`), applied in the scratch
  copy only.

- **With the `await` applied, actual output (verbatim, fresh state dir):**

  ```
  --- session A: the session that CREATES the database file
  A: CREATE TABLE t  (DDL)                     {"ok":true,"rows":[]}
  A: INSERT INTO t   (DML)                     {"ok":true,"rows":[]}
  --- session B: a fresh runtime over the SAME database file
  B: SELECT * FROM t  (DML read)               {"ok":true,"rows":[{"a":1}]}
  B: INSERT INTO t    (DML write)              {"ok":true,"rows":[]}
  B: CREATE TABLE t2  (DDL)                    {"ok":true,"rows":[]}
  B: DROP TABLE t     (DDL)                    {"ok":true,"rows":[]}
  B: DROP TABLE t2    (DDL, created this session) {"ok":true,"rows":[]}
  --- session C: restart again; the FIRST and only statement is the DROP
  C: DROP TABLE t2    (DDL, sole statement)    {"ok":false,"error":"no such table: t2: SQLITE_ERROR"}
  ```

- **Verdict against the body's predicted table:** session A ok/ok (matches);
  B's SELECT/INSERT/CREATE ok (matches); **B's two DROP cells are WRONG — they
  succeed** instead of `SQLITE_LOCKED`; session C's failure is **not** the
  predicted lock but `SQLITE_ERROR`/"no such table" — a downstream artifact of
  B's DROPs having succeeded. Cross-session persistence itself worked (B read
  A's inserted row), so the harness shape is sound; the script simply does not
  trigger the defect.

- **Discriminator hunt (why the script misses what the drivers hit).** All of
  these single-factor variants were run 3-sessions-identically and each still
  produced a SUCCESSFUL cross-session DROP: in-worker binding access via
  `env.DB.getByName().fetch()` + `dispatchFetch` (the gate's access path);
  `class Db extends DurableObject` (gate's class shape); DO-RPC method access
  (`stub.sqlq(q)` on an `extends DurableObject` class — the gate's
  `__debugSql` shape); KV-layer touch (`storage.put`); pending alarm +
  `alarm()` handler; `ctx.storage.transactionSync` wrapping SQL (the engine's
  actual transaction mechanism, `repo.ts:260`); engine-like 15-table schema +
  index; in-session `DROP` as session A's last statement; multiple wakes in
  session A; larger WAL (50 inserts). **Conclusion: the trigger is a composite
  only the full engine hits; a true standalone minimal repro was NOT distilled
  in this pass.** This is the gating work item before filing.

- **The defect re-verified via the husk unit's original drivers** (still on
  disk in the ephemeral `/tmp/husk-repro`; run today against the frozen
  patched bundle `worker-debug.mjs` [2026-10-28 12:59] on the same pinned
  runtime, fresh state dirs). Condensed but verbatim-faithful transcripts:

  `drive7.mjs` (cleanest control pair — never-wiped AND wiped cells):

  ```
  --- session B: reopen BOTH; drop-probe each
  [sql B c-plain create tmp] {"rows":[]}
  [sql B c-plain drop tmp (NEVER-WIPED, reopened)] {"error":"database table is locked: SQLITE_LOCKED"}
  [sql B c-wiped create tmp] {"rows":[]}
  [sql B c-wiped drop tmp (WIPED, reopened)] {"error":"database table is locked: SQLITE_LOCKED"}
  [sql B c-plain create t3] {"rows":[]}
  [sql B c-plain drop t3 (same reopened session, 2nd try)] {"error":"database table is locked: SQLITE_LOCKED"}
  --- session C: reopen AGAIN — does a once-failed drop clear?
  [sql C c-plain create t4] {"rows":[]}
  [sql C c-plain drop t4] {"error":"database table is locked: SQLITE_LOCKED"}
  ```

  `drive5.mjs` (per-statement probes on a reopened cell — resolves
  could-not-verify ledger item 2):

  ```
  [sql journal_mode] {"error":"not authorized: SQLITE_AUTH"}
  [sql drop nonexistent] {"rows":[]}
  [sql create tmp] {"rows":[]}
  [sql drop tmp] {"error":"database table is locked: SQLITE_LOCKED"}
  [sql drop reachable] {"error":"database table is locked: SQLITE_LOCKED"}
  [sql select objects] {"rows":[{"n":0}]}
  [sql delete objects] {"rows":[]}
  ```

  `drive6.mjs` (in-session vs cross-session DDL boundary):

  ```
  [sql A: create+drop same stmt] {"rows":[]}
  [sql A: create tmp] {"rows":[]}
  [sql A: drop tmp same session] {"rows":[]}
  [A: DELETE c1 (same session)] status=200 body="deleted\n"
  --- session B: REOPENED cells, new process
  [sql B: create tmp on reopened c1] {"rows":[]}
  [sql B: drop tmp on reopened c1] {"error":"database table is locked: SQLITE_LOCKED"}
  [B: DELETE c1 (reopened)] status=500 body="error: database table is locked: SQLITE_LOCKED\n"
  ```

  **Contradictions/nuances against the body's claims, flagged for the
  orchestrator (body NOT edited):**
  1. Controls-table row "…`PRAGMA journal_mode` … | all succeed" is wrong in
     detail: `PRAGMA journal_mode` via `state.storage.sql.exec` is REFUSED by
     workerd with `not authorized: SQLITE_AUTH` (workerd's PRAGMA allowlist) —
     an independent restriction, not a success and not the defect. The row
     should say the PRAGMA probe is refused (`SQLITE_AUTH`) and the
     SELECT/INSERT/DELETE/CREATE probes succeed.
  2. Ledger item 2 resolved by drive5: `DROP TABLE IF EXISTS <nonexistent>` on
     a reopened database **succeeds** — the lock bites only when dropping a
     table that actually exists. The body never claimed otherwise (safe), and
     now the fact is pinned.
  3. The Reproduction section's predicted-output block does not match the
     inline script's real behavior (see above) — the body's repro must be
     replaced or re-based on a working script before filing.

### 2. Duplicate search — no duplicate; file as a new issue

Method: GitHub issue search over `cloudflare/workers-sdk` and
`cloudflare/workerd` (API `search/issues`: `SQLITE_LOCKED`,
`"database table is locked"`, `"DROP TABLE"+sqlite/DO`, `useSQLite+locked`,
`SQLITE_AUTH`, DDL angles) plus web search. Closest hits:

| Issue | Status | Why not a duplicate |
|---|---|---|
| [workerd#959](https://github.com/cloudflare/workerd/issues/959) — "unused SQL cursors lead to strange errors" | open (2023-08) | Only public issue naming "database table is locked" in DO SQL. Its locks come from an OPEN CURSOR in the SAME session and clear when the cursor drains; ours needs NO prior statement in the session (session C's sole statement is the DROP) and re-forms in every new session. Adjacent mechanism family (statement/cursor lifetime vs DDL) — cross-reference it when filing. |
| [workerd#7783](https://github.com/cloudflare/workerd/issues/7783) — cached EXPLAIN re-run after drop+recreate segfaults | closed fixed (2026-10) | DDL + cached-statement interaction, but in-session, crash (segfault) not persistent lock, fixed. Evidence the statement-cache/DDL area is live upstream — useful context. |
| [workers-sdk#15162](https://github.com/cloudflare/workers-sdk/issues/15162) — `wrangler d1 migrations apply --local` SQLITE_LOCKED | closed | D1 simulator (miniflare's D1 path), not sqlite-DO storage; migration-parsing cause. Different subsystem. |
| [workers-sdk#16071](https://github.com/cloudflare/workers-sdk/issues/16071) — D1 deferred-FK reset rejects concurrent batch | closed | D1 semantics bug with a Miniflare reproducer; no DDL-lock-across-sessions claim. |
| [workers-sdk#16227](https://github.com/cloudflare/workers-sdk/issues/16227) — Miniflare D1: unknown sqlite files + SQLITE_AUTH on integrity_check | open | D1 files/SQLITE_AUTH surface only; unrelated to DO DDL. |

**Verdict: no genuine duplicate — the draft proceeds as a NEW issue (after the
§1 repro blocker is resolved), with a one-line cross-reference to workerd#959
and optionally workerd#7783 as related.**

### 3. Versions re-check — no delta; census bumps have NOT landed

Every value in the body's environment table re-verified against the current
lockfile/store/working tree:

| Component | Body claims | Found now | Delta |
|---|---|---|---|
| miniflare | 5.20261019.2-beta (exact pin declared by wrangler 4.152.0 / vite-plugin / vitest-plugin) | same — lockfile + wrangler's own `package.json` declares the exact string; `pnpm-workspace.yaml` additionally carries `overrides: miniflare: 5.20261019.2-beta` (pins ALL consumers, e.g. vitest-pool-workers' older alpha, to the same version — consistent with, and noted by, the body's phrasing) | none |
| workerd | 1.20261019.1 (shipped by the miniflare pin) | same — miniflare's dep is exactly `workerd: 1.20261019.1` | none |
| wrangler | 4.152.0 | `^4.152.0` declared, 4.152.0 resolved | none |
| @cloudflare/vite-plugin / vitest-plugin | 1.65.0 / 1.4.7 | `^1.65.0` / `^1.4.7` declared, same resolved | none |
| @cloudflare/workers-types | — | `^5.20261025.1` (with the `minimumReleaseAgeExclude` entry) | none |
| compatibility_date | 2026-10-19 | 2026-10-19 (wrangler.jsonc) | none |
| Node / OS | v25.9.0 / Ubuntu 24.04.2, kernel 6.14.0-37-generic | same machine, same values | none |

The dep-freshness census's proposed move (`miniflare → 5.20261023.0-beta`,
`workerd → 1.20261023.1`, `compatibility_date → 2026-10-23`) has **NOT**
landed — the tree is still on the 20261019 train, so the body's versions
table remains accurate as written.

### 4. Net filing recommendation (for the orchestrator)

**Do NOT file the current body.** Steps 1-3 of the checklist are now executed
(repro: contradiction; gate-equivalent signature: re-verified via frozen
bundle; duplicates: none), and the residual blocker is single: the body's
self-contained repro does not reproduce. Options, in order of preference:

1. **Distill a working minimal repro** — budget real time; nine single-factor
   bisections failed (§1), so the trigger is a composite of the engine's
   storage behavior. If it resists, fall back to 2.
2. **Re-base the Reproduction section on the committed,
   mutation-checked reproducer** (`packages/git-engine/e2e/check-delete-husk.mjs`
   + the drive-script shape: engine worker with `RepoCell`/`Registry` +
   `dispatchFetch`), stating plainly that the reproducer is product-coupled.
   Slower triage, but the claim is then backed by something that actually
   reproduces.
3. Either way, apply the three body corrections flagged in §1 (PRAGMA row,
   ledger item 2 note, predicted-output block) — and the `await` fix if the
   inline script is kept in any form.
