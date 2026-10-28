# Upstream issue draft — workerd/miniflare dev runtime: an un-drained `SqlStorage` cursor bricks `DROP TABLE` (`SQLITE_LOCKED`) on a sqlite-backed Durable Object for the whole session; a construction-time table-existence probe makes it recur in every session ("cross-session")

Status: **FILED 2026-10-28 as [cloudflare/workers-sdk#16548](https://github.com/cloudflare/workers-sdk/issues/16548) — was READY TO FILE — repro blocker RESOLVED and first-hand re-verified
2026-10-28** (the distillation pass converged the standalone repro; the
completion unit re-executed it FOUR times, each with all 26 asserted
predictions CONFIRMED and the transcripts preserved — including one run on a
fresh `npm i miniflare@5.20261019.2-beta` install under the issue's own
filename; the four body corrections + the `await` fix are folded into the
body below). The orchestrator/user files it; no `gh`/network write happens
from agents. Prepared 2026-10-28. This is the "upstream-report
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
ships `workerd@1.20261019.1`. The inline repro script below is the EXECUTED,
verified script (2026-10-28: run four times by the completion unit — three
scratch variants plus one on a fresh `npm i miniflare@5.20261019.2-beta`
install under the issue's own filename — each with all 26 asserted predictions
CONFIRMED and the transcripts preserved; see "Distillation (executed)" and its
"Completion verification" at the end). An earlier draft's inline script was
never executed, did NOT reproduce when finally run, and was replaced by this
distilled one.

---

## Proposed title

```
[miniflare] sqlite-backed Durable Object: one un-drained SqlStorage cursor bricks every DROP TABLE with SQLITE_LOCKED for the rest of the session (CREATE TABLE and all DML unaffected)
```

Shorter alternative if the template prefers concise titles:

```
[miniflare] an un-drained sql.exec() cursor DDL-locks a sqlite DO (SQLITE_LOCKED on every DROP TABLE) until restart — construction-time table-existence probes make it recur in every session
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

On a **sqlite-backed Durable Object** (`useSQLite: true`), a single **un-drained
`SqlStorage` cursor** — `state.storage.sql.exec(<any SELECT>)` whose returned
cursor is simply discarded (never `.toArray()`/`.one()`/`next()`/iterated) —
puts that DO's SQLite connection into a state where **every subsequent
`DROP TABLE` of a table that actually exists fails with
`database table is locked: SQLITE_LOCKED`, for the rest of the runtime
session**. The failure is:

- **deterministic** — the first `DROP TABLE` attempted after the leak fails; no
  warm-up traffic or prior statement is needed;
- **table-independent** — a table created AFTER the leak, in the same session,
  cannot be dropped either;
- **session-scoped, and re-formed every session by a construction-time
  leaker** — retries in the same session fail identically, and for an
  application that leaks at DO construction the brick recurs across any number
  of restarts: the natural pattern is a table-existence probe,
  `try { sql.exec("SELECT 1 FROM t LIMIT 1") } catch {}`, which throws
  harmlessly on a fresh database but LEAKS the cursor in every later session,
  once the table exists. From such an application's perspective, every session
  after the one that created the database is permanently DDL-locked;
- **not actually about sessions** — hand-leaking one cursor mid-session bricks
  DDL immediately, no restart involved; the session boundary only decides WHEN
  the leak happens;
- **per-connection** — within one runtime, a DO that leaked is bricked while a
  second DO (same worker, drained probe, same persistence path) keeps full DDL;
- **specific to workerd's DO SQLite storage** — plain SQLite (node:sqlite)
  driving the same code shape never reproduces it.

While the brick is in place, `SELECT`/`INSERT`/`DELETE`, `CREATE TABLE`, and
even `DROP TABLE IF EXISTS <nonexistent>` all still succeed — only drops of
tables that exist hit the lock. The exception message observed through
`state.storage.sql.exec` is `database table is locked: SQLITE_LOCKED`.

The session that CREATES the database never sees it (on a fresh database the
probe throws before any cursor exists, so nothing leaks). The moment the dev
server restarts (wrangler dev, the Cloudflare vite/vitest plugins — any setup
persisting DO state to disk), the construction probe starts succeeding — and
leaking — and any code path that drops tables (schema migrations with DDL
steps, destroy/wipe/teardown endpoints) turns into a deterministic,
forever-failing operation.

**Scope caveat stated up front:** every observation below is on the LOCAL dev
runtime (miniflare/workerd per the versions table). We have NOT tested deployed
Workers; production behavior is unverified.

### Reproduction

Self-contained; a single script, miniflare only, no other dependencies. Two DO
classes in one worker, identical except for the construction-time probe; three
sessions over one persisted state directory — session A creates the databases,
sessions B and C are fresh runtimes over the same files. `dispose()` is a full
runtime teardown; the persistence path is what lets the databases survive it
(wrangler dev persists the same way under `.wrangler/state`). Every verdict in
the script is asserted; a mismatch prints `CONTRADICTED` and exits 1. The
LEAKY/CLEAN pair is the discriminator: same files, same restarts, the ONLY
difference is whether the construction probe drains its cursor.

`repro-undrained-cursor-ddl-locked.mjs`:

```js
// Standalone reproduction: on workerd (via miniflare), one UN-DRAINED
// SqlStorage cursor — sql.exec(<any SELECT>) whose returned cursor is simply
// DISCARDED (never .toArray()/.one()/next()/iterated) — makes every subsequent
// DROP TABLE of an existing table on that DO fail "database table is locked:
// SQLITE_LOCKED" for the rest of the runtime session. CREATE TABLE and all DML
// keep working; DROP of a NON-EXISTENT table still succeeds. The session
// boundary is NOT the trigger — a hand-leaked cursor mid-session bricks DROP
// immediately — but an app that leaks at DO construction (a table-existence
// probe is the natural pattern) re-leaks in EVERY session, so every session
// after the one that created the database presents as permanently DDL-locked.
//
//   npm i miniflare@5.20261019.2-beta
//   node repro-undrained-cursor-ddl-locked.mjs
//
// Sessions:
//   A  creates two DO databases (identical schema), disposes the runtime.
//   B  fresh runtime over the SAME files:
//        LEAKY cell — construction mimics the probe: exec + DISCARD the cursor.
//        CLEAN cell — same probe but DRAINED (the fix). The discriminator.
//      plus an in-session strip on CLEAN: leak a cursor by hand mid-session,
//      no restart involved — DROP fails again.
//   C  restart again: LEAKY's first and only user statement is a DROP — still
//      locked (construction re-leaks); CLEAN still fine (the database file is
//      NOT poisoned — the lock is per-session state).
//
// Every verdict is asserted; any mismatch prints CONTRADICTED and exits 1.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Persisted per run, thrown away so a rerun starts from a clean slate. The
// persistence path is what lets the database files survive the runtime
// teardown between sessions (wrangler dev persists the same way under
// .wrangler/state).
const STATE = join(mkdtempSync(join(tmpdir(), "ddl-repro-")), "state");

const SCRIPT = `
// Two DO classes, identical except for the construction-time probe:
//   Leaky — a table-existence probe verbatim: exec + DISCARD the cursor.
//   Clean — the same probe drained (what a careful app does).
// On a database whose tables already exist (every session after creation) the
// probe succeeds and the cursor is left mid-run, un-referenced. On a fresh
// database the prepare throws before any cursor exists, so nothing leaks.
export class Leaky {
  constructor(ctx, env) {
    this.ctx = ctx;
    try {
      ctx.storage.sql.exec("SELECT 1 FROM schema_migrations LIMIT 1"); // DISCARDED
    } catch { /* fresh database */ }
  }
  async fetch(req) {
    const u = new URL(req.url);
    const q = u.searchParams.get("q");
    try {
      if (u.pathname === "/leak") {
        this.ctx.storage.sql.exec(q); // hand-leak on demand (in-session strip)
        return Response.json({ ok: true, note: "cursor deliberately left un-drained" });
      }
      const rows = this.ctx.storage.sql.exec(q).toArray(); // drained
      return Response.json({ ok: true, rows: rows.slice(0, 5) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e) });
    }
  }
}
export class Clean {
  constructor(ctx, env) {
    this.ctx = ctx;
    try {
      ctx.storage.sql.exec("SELECT 1 FROM schema_migrations LIMIT 1").toArray(); // DRAINED
    } catch { /* fresh database */ }
  }
  async fetch(req) {
    const u = new URL(req.url);
    const q = u.searchParams.get("q");
    try {
      if (u.pathname === "/leak") {
        this.ctx.storage.sql.exec(q);
        return Response.json({ ok: true, note: "cursor deliberately left un-drained" });
      }
      const rows = this.ctx.storage.sql.exec(q).toArray();
      return Response.json({ ok: true, rows: rows.slice(0, 5) });
    } catch (e) {
      return Response.json({ ok: false, error: String(e && e.message || e) });
    }
  }
}
export default { fetch() { return new Response("worker up"); } };
`;

function makeMf() {
  return new Miniflare(convertV4MiniflareOptions({
    resourcePersistencePath: STATE,
    workers: [{
      name: "ddl-repro",
      script: SCRIPT,
      modules: true,
      compatibilityDate: "2026-10-19",
      durableObjects: {
        LEAKY: { className: "Leaky", useSQLite: true },
        CLEAN: { className: "Clean", useSQLite: true },
      },
    }],
  }));
}

let fails = 0, total = 0;
async function expect(mf, ns, cell, q, want) {
  total++;
  const namespace = await mf.getDurableObjectNamespace(ns); // await: lazy thenable proxy in this miniflare
  const res = await namespace.getByName(cell).fetch("https://do/sql?q=" + encodeURIComponent(q));
  const got = await res.json();
  const ok = want === "ok" ? got.ok === true : got.ok === false && /SQLITE_LOCKED/.test(got.error ?? "");
  const verdict = ok ? "PASS" : "MISMATCH";
  if (!ok) fails++;
  console.log(
    (ok ? "  " : "! ") + `${cell} ${q}`.padEnd(58),
    JSON.stringify(got).slice(0, 90).padEnd(92),
    `${verdict} (want ${want})`
  );
}

rmSync(STATE, { recursive: true, force: true });

console.log("--- session A: create both databases (fresh; the probe throws, nothing leaks)");
{
  const mf = makeMf();
  // baseline: a journal table with a row + a data table with a row, both cells
  await expect(mf, "LEAKY", "leak", "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)", "ok");
  await expect(mf, "LEAKY", "leak", "INSERT INTO schema_migrations VALUES ('0001', 1)", "ok");
  await expect(mf, "LEAKY", "leak", "CREATE TABLE t (a INTEGER)", "ok");
  await expect(mf, "LEAKY", "leak", "INSERT INTO t VALUES (1)", "ok");
  await expect(mf, "LEAKY", "leak", "DROP TABLE IF EXISTS tmp_a", "ok"); // in-session DDL on a fresh db: fine
  await expect(mf, "CLEAN", "clean", "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)", "ok");
  await expect(mf, "CLEAN", "clean", "INSERT INTO schema_migrations VALUES ('0001', 1)", "ok");
  await expect(mf, "CLEAN", "clean", "CREATE TABLE t (a INTEGER)", "ok");
  await expect(mf, "CLEAN", "clean", "INSERT INTO t VALUES (1)", "ok");
  await mf.dispose();
}

console.log("--- session B: fresh runtime over the SAME database files");
{
  const mf = makeMf();
  console.log("  LEAKY cell — construction ran the UN-DRAINED probe (cursor leaked):");
  await expect(mf, "LEAKY", "leak", "SELECT * FROM t", "ok");           // DML reads fine
  await expect(mf, "LEAKY", "leak", "INSERT INTO t VALUES (2)", "ok");  // DML writes fine
  await expect(mf, "LEAKY", "leak", "CREATE TABLE t2 (a INTEGER)", "ok"); // CREATE fine
  await expect(mf, "LEAKY", "leak", "DROP TABLE t", "locked");            // THE FAILURE
  await expect(mf, "LEAKY", "leak", "DROP TABLE t2", "locked");           // even a table created THIS session
  await expect(mf, "LEAKY", "leak", "DROP TABLE IF EXISTS nosuch", "ok"); // non-existent: no lock needed
  await expect(mf, "LEAKY", "leak", "DROP TABLE t", "locked");            // retry: still locked
  console.log("  CLEAN cell — construction DRAINED its probe (the fix):");
  await expect(mf, "CLEAN", "clean", "SELECT * FROM t", "ok");
  await expect(mf, "CLEAN", "clean", "CREATE TABLE t3 (a INTEGER)", "ok");
  await expect(mf, "CLEAN", "clean", "DROP TABLE t3", "ok");  // the discriminator: same files, same restart,
  await expect(mf, "CLEAN", "clean", "DROP TABLE t", "ok");   // only the drained probe differs -> DDL works
  console.log("  in-session strip on CLEAN — leak a cursor BY HAND, no restart involved:");
  await expect(mf, "CLEAN", "clean", "SELECT 1 FROM schema_migrations LIMIT 1", "ok"); // sanity drained probe
  const namespace = await mf.getDurableObjectNamespace("CLEAN");
  const leaked = await namespace.getByName("clean").fetch("https://do/leak?q=" + encodeURIComponent("SELECT 1 FROM schema_migrations LIMIT 1"));
  console.log("   ", JSON.stringify(await leaked.json()));
  await expect(mf, "CLEAN", "clean", "CREATE TABLE afterleak (a INTEGER)", "ok"); // CREATE still fine
  await expect(mf, "CLEAN", "clean", "DROP TABLE afterleak", "locked"); // now DDL is bricked IN-SESSION
  await mf.dispose();
}

console.log("--- session C: restart again; LEAKY's first user statement is the DROP");
{
  const mf = makeMf();
  await expect(mf, "LEAKY", "leak", "DROP TABLE t2", "locked"); // persists across restarts (construction re-leaks)
  await expect(mf, "CLEAN", "clean", "CREATE TABLE t4 (a INTEGER)", "ok");
  await expect(mf, "CLEAN", "clean", "DROP TABLE t4", "ok");
  await mf.dispose();
}

console.log("");
if (fails === 0) {
  console.log(`VERDICT: CONFIRMED — all ${total} predictions matched. A single un-drained SqlStorage`);
  console.log("cursor bricks every DROP TABLE (existing tables) on that DO's connection until the");
  console.log("runtime restarts; CREATE/DML unaffected. An app that leaks one at every DO");
  console.log("construction (table-existence probe) is DDL-locked in every session after the");
  console.log("one that created the database — which is why the failure presents as cross-session.");
} else {
  console.log(`VERDICT: CONTRADICTED — ${fails}/${total} predictions mismatched (see ! lines).`);
  process.exit(1);
}
```

```bash
npm i miniflare@5.20261019.2-beta
node repro-undrained-cursor-ddl-locked.mjs
```

Expected output (verbatim from an executed run, abridged to the interesting
rows — all 26 asserted predictions PASS; mismatching rows are prefixed `!` and
the script exits 1 with `CONTRADICTED`):

```
--- session A: create both databases (fresh; the probe throws, nothing leaks)
  (9 rows, all PASS — in-session DDL on a fresh database works)
--- session B: fresh runtime over the SAME database files
  LEAKY cell — construction ran the UN-DRAINED probe (cursor leaked):
  leak SELECT * FROM t                                  {"ok":true,"rows":[{"a":1}]}                       PASS (want ok)
  leak INSERT INTO t VALUES (2)                         {"ok":true,"rows":[]}                              PASS (want ok)
  leak CREATE TABLE t2 (a INTEGER)                      {"ok":true,"rows":[]}                              PASS (want ok)
  leak DROP TABLE t                                     {"ok":false,"error":"database table is locked: SQLITE_LOCKED"} PASS (want locked)
  leak DROP TABLE t2                                    {"ok":false,"error":"database table is locked: SQLITE_LOCKED"} PASS (want locked)
  leak DROP TABLE IF EXISTS nosuch                      {"ok":true,"rows":[]}                              PASS (want ok)
  leak DROP TABLE t                                     {"ok":false,"error":"database table is locked: SQLITE_LOCKED"} PASS (want locked)
  CLEAN cell — construction DRAINED its probe (the fix):
  clean CREATE TABLE t3 (a INTEGER)                     {"ok":true,"rows":[]}                              PASS (want ok)
  clean DROP TABLE t3                                   {"ok":true,"rows":[]}                              PASS (want ok)
  clean DROP TABLE t                                    {"ok":true,"rows":[]}                              PASS (want ok)
  in-session strip on CLEAN — leak a cursor BY HAND, no restart involved:
    {"ok":true,"note":"cursor deliberately left un-drained"}
  clean CREATE TABLE afterleak (a INTEGER)              {"ok":true,"rows":[]}                              PASS (want ok)
  clean DROP TABLE afterleak                            {"ok":false,"error":"database table is locked: SQLITE_LOCKED"} PASS (want locked)
--- session C: restart again; LEAKY's first user statement is the DROP
  leak DROP TABLE t2                                    {"ok":false,"error":"database table is locked: SQLITE_LOCKED"} PASS (want locked)
  clean CREATE TABLE t4 (a INTEGER)                     {"ok":true,"rows":[]}                              PASS (want ok)
  clean DROP TABLE t4                                   {"ok":true,"rows":[]}                              PASS (want ok)

VERDICT: CONFIRMED — all 26 predictions matched.
```

The sharpest rows: session B's LEAKY/CLEAN pair (identical files, identical
restart, only the drained probe differs) and the in-session strip (a hand-leaked
cursor bricks DDL with no restart involved).

### Controls that pin the boundary

Most variants below are asserted IN the repro script itself (the LEAKY/CLEAN
pair); the rest were run separately against the pinned runtime:

| Variant | Outcome |
|---|---|
| Identical files, identical restarts, but the construction probe DRAINED (`.toArray()`) | every statement succeeds, including all DROPs — the discriminator: only the un-drained cursor differs |
| Hand-leak one cursor mid-session (no restart involved), then `CREATE` a table and `DROP` it | `CREATE` succeeds, `DROP` fails immediately — the session boundary is not the trigger |
| After the leak: `SELECT`, `INSERT`, `DELETE`, `CREATE TABLE`, `DROP TABLE IF EXISTS <nonexistent>` | all succeed; only `DROP` of an EXISTING table fails |
| `DROP` retry in the same leaked session | fails again |
| Two DOs in one runtime, one leaking, one drained | only the leaking DO is bricked — the lock is per-DO connection, not per-runtime |
| Restart; the leaking DO's first and only user statement is a `DROP` (construction re-leaks) | still fails — recurs in every session for a construction-time leaker |
| Restart; a NON-leaking DO over the same database file | full DDL works — the database file is not poisoned; the lock is per-session state |
| In the session that creates the database (the probe throws instead of leaking) | DDL fully works, including drop-and-recreate wipes |
| `PRAGMA journal_mode` via `state.storage.sql.exec` | refused by workerd's PRAGMA allowlist with `not authorized: SQLITE_AUTH` — an independent restriction, unrelated to this defect |
| Plain SQLite (node:sqlite) driving the same code shape | never reproduces — specific to workerd's sqlite-DO storage |

We did not identify the internal mechanism inside workerd (which structure pins
the connection against DDL while an un-drained cursor is outstanding is
upstream's to say); the surface facts above are the complete claim.

### Impact

- **Any code path that discards a cursor bricks DDL for the rest of the dev
  session (local dev + CI).** Table-existence probes written as
  exec-and-catch (the natural pattern — workerd's DO SQLite exposes no
  sqlite_master to query instead), fire-and-forget reads, "just check if a row
  exists" execs — each one silently converts every later schema-destroy/rebuild
  flow (migrations that drop tables, delete/wipe/teardown endpoints, per-test
  fixture teardown against persisted state) into a deterministic,
  forever-failing operation with a generic `SQLITE_LOCKED` that reads like
  transient contention but never resolves within the session.
- **Green-to-red with no code change:** merely restarting the dev server
  converts a previously passing teardown into a permanent failure (the
  construction probe starts succeeding — and leaking); the app then 500s on the
  same statement across any number of further restarts.
- **Affects the vite/vitest plugin ecosystems transitively:** the same pinned
  miniflare/workerd pair runs under `@cloudflare/vite-plugin` and
  `@cloudflare/vitest-plugin`, so test suites that persist DO state between
  runs and exercise schema teardown hit the same wall in CI.
- **Production behavior UNVERIFIED (call-out):** the repro is local-runtime
  only. If deployed DO databases also outlive the isolate/session that created
  them the same way, the same class may exist in production — we have not
  tested that, and this report does not claim it. Flagging for triage.

### Suggested fix directions

1. **Reclaim abandoned cursors** — a `SqlStorageCursor` that is no longer
   referenced from JS should not hold its DO's connection against DDL for the
   rest of the session. Reclaim it (finalizer, drain-on-next-statement,
   explicit dispose support) so `DROP TABLE` behaves like `CREATE TABLE`
   already does.
2. **If an outstanding cursor legitimately holds a DDL-blocking lock**, surface
   a DISTINCT, actionable error naming the un-drained cursor, so consumers can
   distinguish a self-inflicted cursor-lifetime bug from genuine transient
   `SQLITE_LOCKED` contention (today's message invites retry loops that can
   never succeed within the session).
3. **Document the drain requirement** if neither is near-term: nothing today
   points consumers at the cause. The consumer-side fix is trivial (drain every
   cursor — e.g. `.toArray()` the existence probe), but it is undiscoverable
   from the error message.

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
- **Re-verify before filing (all three steps EXECUTED and closed 2026-10-28 —
  the distilled inline script has since been run four times first-hand, see
  "Completion verification" in the Distillation section; run 4 there is the
  fresh-`npm i` case):**
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
  --title '[miniflare] sqlite-backed Durable Object: one un-drained SqlStorage cursor bricks every DROP TABLE with SQLITE_LOCKED for the rest of the session (CREATE TABLE and all DML unaffected)' \
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
   scripts themselves. **Update 2026-10-28 evening:** still true for the HUSK
   unit's drivers, but the distilled repro's runtime transcripts ARE now
   preserved — four run logs under `/tmp/ddl-repro-verify` (see "Completion
   verification").
2. **`drive5`'s unasserted probes:** the recorded finding covers
   PRAGMA/CREATE/DML-ok and DROP-fails. Whether `DROP TABLE IF EXISTS
   <nonexistent>` on a reopened database also fails (and the `PRAGMA
   journal_mode` value observed) was not recorded anywhere quotable — the
   issue body deliberately does not claim either. The inline repro likewise
   omits them.
3. ~~**The inline repro script was not executed** (this unit runs no new runtime
   experiments; `node --check` only). It is a faithful recomposition of the
   unit's verified drive steps using the same miniflare API shape
   (`convertV4MiniflareOptions`, `resourcePersistencePath`, `useSQLite`,
   `dispatchFetch`-free `ns.getByName().fetch()`) as the committed
   check-delete-husk gate — but the filer MUST run it per the checklist before
   filing.~~ **SUPERSEDED 2026-10-28:** this item referred to the ORIGINAL
   inline script, which the filing-prep unit then executed (did not reproduce,
   §1) and the distillation pass replaced with the distilled script — which the
   completion unit has now executed four times first-hand, 26/26 CONFIRMED
   each (see "Completion verification"). No re-run is required before filing;
   the transcripts are preserved.
4. **Production (deployed Workers) behavior: unverified** — called out in the
   issue body itself; the repro is local-runtime only.
5. **Compatibility-date dependence:** all evidence is at `compatibility_date
   2026-10-19`; whether older/newer dates change the behavior was never probed.
6. **Mitigation space:** `VACUUM`, `PRAGMA wal_checkpoint`, or any
   close/checkpoint sequence as a pre-restart escape was never probed; the only
   recovery the unit demonstrated is file-level deletion while the runtime is
   down.
7. ~~**Duplicate upstream reports:** none searched from here (see checklist
   step 3).~~ **RESOLVED 2026-10-28** — the search was executed (checklist
   step 3 / §2): no duplicate; closest relatives workerd#959, workerd#7783,
   workers-sdk#15162/16071/16227, none matching.

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

### 4. Net filing recommendation (for the orchestrator) — FLIPPED 2026-10-28, distillation pass

**FILE — the blocker is resolved.** The §1 finding ("the body's self-contained
repro does not reproduce") stood until the distill-down pass located the true
trigger: a single un-drained `SqlStorage` cursor (full story + execution record
in "Distillation (executed)" below). The body above now carries the verified
standalone repro — three independent executions, 26/26 asserted predictions
CONFIRMED each time — and all four body corrections plus the `await` fix are
already folded in. Recommended: file as a NEW issue per the checklist
(duplicates: none, §2), with a one-line cross-reference to workerd#959 —
UPGRADED by the distillation from "adjacent" to "likely same family (cursor
lifetime)": #959's locks come from an open, actively-handled cursor in the same
session and clear when it drains; ours is an ABANDONED cursor (unreferenced in
JS) whose lock persists for the whole session. workerd#7783 optional context.
The product-coupled fallback (this section's former option 2 — re-basing the
Reproduction section on `packages/git-engine/e2e/check-delete-husk.mjs`) is
MOOT; keep it only as contingency if upstream rejects the distilled repro.

---

## Distillation (executed) — 2026-10-28 (repro-distillation unit)

Mission: distill DOWN from the working engine repro (drive6/drive7 over the
frozen bundle in `/tmp/husk-repro`) instead of building up. The §1 nine
single-factor build-up strips stand as recorded (each still produced a
SUCCESSFUL cross-session DROP → none carried the trigger, because none carried
the component below). Before stripping blind, this pass READ the engine's open
path — which located the one component no build-up variant had.

### Strip ledger (source inspection first, runtime second)

| Strip candidate (engine session-A behavior) | Where in the engine | Verdict |
|---|---|---|
| Construction-time table-existence probe: `tableExists()` = `sql.exec("SELECT 1 FROM <table> LIMIT 1")` with the returned cursor DISCARDED — `packages/git-engine/src/git/migrations.ts:389-396` | called from `readJournal`/`classifyRepoState`, which run at EVERY `GitStore` construction (`src/git/store.ts:124-152`), itself constructed synchronously in the `RepoCell` constructor (`src/repo.ts:260`) | **TRIGGER. Strip it (drain the probe) and every cross-session DROP SUCCEEDS** — runtime-verified via the CLEAN discriminator below |
| All other engine behavior — 15-table one-batch baseline DDL, journal/meta writes, indexes, `transactionSync` wrapping, R2, registry DO, esbuild bundle, `dispatchFetch` access path, KV/alarm touches, insert volume/WAL growth | present in the working drive repro | never needed — the minimal repro fails identically without any of them |

### The converged trigger (surface contract)

A single un-drained `SqlStorage` cursor — `sql.exec(<any SELECT>)` whose
returned cursor object is discarded (never drained) — bricks EVERY subsequent
`DROP TABLE` of an existing table on that DO's connection with
`database table is locked: SQLITE_LOCKED` for the rest of the runtime session.
`CREATE TABLE`, all DML, and `DROP TABLE IF EXISTS <nonexistent>` keep working;
retries fail identically. The session boundary is NOT the trigger — a
hand-leaked cursor mid-session bricks DDL immediately — but a construction-time
leaker re-leaks in every new session, which is why the engine defect presented
as "cross-session, permanent, survives restarts". The database FILE is not
poisoned: a session that does not leak has full working DDL on the same file.

Why every previously recorded observation fits: drive5/6/7's failures all
happened in sessions whose DO construction ran the probe over an EXISTING
database (probe succeeds → cursor leaked at construction); session-A in-session
DDL worked because on a FRESH database the probe THROWS before any cursor
exists; the §1 nine variants all succeeded because their DO classes had no
construction probe; the original §1 inline repro failed to reproduce for the
same reason; and §1's control claiming a bare first-statement DROP "rules out
leaked cursors / open statements from earlier traffic" is INVERTED — the leak
comes from the construction probe, not from earlier traffic (body correction
#4, folded above).

### Execution record (this unit — output seen with its own eyes)

1. `/tmp/ddl-repro-verify/minimal.mjs` — the predecessor's converged draft,
   found on disk UNEXECUTED (mtime 14:09, no run artifacts; the unit died at
   the quota reset before verifying anything). Its mechanism claim was first
   checked against engine source (table above), then executed:
   `node minimal.mjs` → **VERDICT: CONFIRMED — all 26 predictions matched**
   (three sessions, LEAKY/CLEAN discriminator, in-session hand-leak strip,
   persistence + file-not-poisoned proofs; zero mismatches).
2. `/tmp/ddl-repro-verify/minimal-npm.mjs` — same script, paste-ready
   `import { Miniflare, convertV4MiniflareOptions } from "miniflare"`
   specifier (resolving via the scratch `node_modules/miniflare` symlink to
   the pinned store copy, `miniflare@5.20261019.2-beta` shipping
   `workerd@1.20261019.1`; behaviorally identical to
   `npm i miniflare@5.20261019.2-beta`) → run → **VERDICT: CONFIRMED — all 26
   predictions matched** again.
3. `/tmp/ddl-repro-verify/minimal-paste.mjs` — the EXACT text now pasted in the
   issue body above (de-productized comments, npm import, one unused helper
   removed; every executable statement identical to 1) → `node --check` pass →
   run → **VERDICT: CONFIRMED — all 26 predictions matched**.
4. Negative control (recorded §1, not re-run): the ORIGINAL inline repro —
   same harness shape, NO construction probe — succeeds on its cross-session
   DROPs; the discriminator is the probe, nothing else.

Commands recorded by that unit: `node --check minimal.mjs && node
minimal.mjs`; `node minimal-npm.mjs`; `node --check minimal-paste.mjs && node
minimal-paste.mjs` — each printed `VERDICT: CONFIRMED — all 26 predictions
matched`. **CAVEAT (harvest audit, 2026-10-28 evening):** the unit was
harvested dead without persisting its runtime transcripts — the only surviving
session log is a read-back of this document, so its three runs were NOT
independently checkable. The completion unit re-executed all three commands
first-hand and CONFIRMS every verdict — see "Completion verification" next.

### Completion verification (executed) — 2026-10-28 evening (distillation-completion unit)

Environment as in the body's table (re-checked live): Ubuntu 24.04.2 LTS
(x64), kernel 6.14.0-37-generic, Node v25.9.0, miniflare 5.20261019.2-beta
shipping workerd 1.20261019.1. Every run below printed `VERDICT: CONFIRMED —
all 26 predictions matched` (exit 0, zero MISMATCH rows):

| # | Script | miniflare source | Transcript (preserved) |
|---|---|---|---|
| 1 | `minimal.mjs` (`node --check` pass first) | pnpm-store copy via the scratch `node_modules/miniflare` symlink | `/tmp/ddl-repro-verify/run1-minimal.log` |
| 2 | `minimal-npm.mjs` | same symlink | `/tmp/ddl-repro-verify/run2-minimal-npm.log` |
| 3 | `minimal-paste.mjs` — verified BYTE-IDENTICAL to the body's inline script (markdown fence extracted, `diff` clean) | same symlink | `/tmp/ddl-repro-verify/run3-minimal-paste.log` |
| 4 | fresh-install gate: `npm i miniflare@5.20261019.2-beta` into a clean scratch dir, script copied under the issue's own filename `repro-undrained-cursor-ddl-locked.mjs` | genuine fresh `npm i` (resolves exactly miniflare 5.20261019.2-beta / workerd 1.20261019.1) | `/tmp/ddl-repro-verify/npm-fresh/run4-npm-fresh.log` |

Run 4 closes the body's only remaining inferential claim — that the
store-symlink copy is behaviorally identical to a user's `npm i` — with a real
fresh install. Standalone check: the script imports only `miniflare` and node
builtins; no engine/product code — it demonstrates the RUNTIME defect, which
outlives the engine-side fix (`29b966f` "fix(engine): the cursor drain"
drained the product's own probe; `d0b54ad` added the drain-discipline
tripwire). Sharpest rows from run 3, verbatim:

```
  leak DROP TABLE t                                          {"ok":false,"error":"database table is locked: SQLITE_LOCKED"}                               PASS (want locked)
  clean DROP TABLE t                                         {"ok":true,"rows":[]}                                                                        PASS (want ok)
  clean DROP TABLE afterleak                                 {"ok":false,"error":"database table is locked: SQLITE_LOCKED"}                               PASS (want locked)
```

— matching the body's expected-output block: the LEAKY/CLEAN discriminator and
the in-session hand-leak strip both reproduced exactly as pasted.

### Deliverable + body updates folded

- Deliverable: `/tmp/ddl-repro-verify/minimal.mjs` (verified store-path copy,
  kept byte-identical to what was executed) and `minimal-paste.mjs` (the
  paste-ready form, verified as-pasted). The issue body's Reproduction script
  is `minimal-paste.mjs` verbatim.
- Body corrections folded (the three §1 flags + one new): (1) PRAGMA probe row
  — `PRAGMA journal_mode` is REFUSED by workerd's PRAGMA allowlist
  (`not authorized: SQLITE_AUTH`), an independent restriction; (2)
  `DROP TABLE IF EXISTS <nonexistent>` SUCCEEDS on a leaked-cursor connection —
  the lock bites only drops of tables that exist (resolves could-not-verify
  ledger item 2); (3) the predicted-output block replaced with verified output;
  (4) NEW — the old controls row "bare single-statement DROP ... rules out
  leaked cursors" inverted: the leak is at DO construction, not from earlier
  traffic; likewise the old "permanent / only recovery is deleting the file"
  bullet corrected to session-scoped-per-connection with the file NOT poisoned.
  Plus the `await` on `mf.getDurableObjectNamespace()` (§1) — baked into the
  pasted script.
- workerd#959 cross-reference upgraded (see §4 above).
- Remaining could-not-verify items unchanged: production behavior unverified
  (ledger 4); compatibility-date dependence unprobed (ledger 5);
  VACUUM/checkpoint escape hatches unprobed (ledger 6 — now largely moot: the
  demonstrated recovery is simply draining the probe).
