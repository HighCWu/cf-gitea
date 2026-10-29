// graphData RPC gate — SPEC-0017 §3 M1 (the census R09 boundary: upstream's
// commit-graph page data, routers/web/repo/commit.go Graph → gitgraph
// GetCommitGraph over `git log --graph`). Run with tsx (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-graph.mjs
// Exits non-zero on any failed check.
//
// What makes this honest: the RPC is the REAL RepoCell.graphData over a real
// GitStore (node:sqlite) seeded from REAL git fixtures, and the ORACLE is real
// `git log --graph --date-order` over the same fixture — the exact command
// upstream's graph.go builds (`--date-order`, `--tags --branches` when no
// refs are selected, the in-stream skip). The ORACLE FOR LANES is structural
// per the SPEC's §6 hedge: a checked-in hand-computed expected map for the
// fixture (our transition model need not match git's glyph choices row-for-row
// — the ratified lane algorithm, Open question 2) plus real-git PROPERTY
// checks: row order === git's date order, every commit exactly once, dot
// columns === the `*` column of git's art (star index / 2 — one char per
// column, stars on even indexes), parent-child adjacency by edge-chain
// reachability, the ≤1-column-per-row edge invariant, relation rows for wide
// transitions, pagination continuity, hidePRRefs/tip-set rules, the three
// budget caps and the ladder.
//
// Pinned divergences (ledger-ready, per SPEC §3.3 / Open question 2):
//   - relation rows instead of `_`/`.` horizontal glyph segments: a shift
//     wider than one column travels one column per commit-less row until it
//     reaches its slot; extra parents depart one row apart (the staggered
//     octopus fan-out, decomposed). Visual parity on the 5px/12px grid is
//     the bar, glyph identity is not.
//   - colors are a monotonic per-lane counter (unique per lane, never
//     pool-recycled); the CSS class is color % 16 — the Color16 wrap.
//   - date ties: our pop order is the frontier's stable committer-time DESC
//     sort (insertion-ordered on ties); git's --date-order has its own tie
//     behavior — visible only on equal timestamps, so every oracle fixture
//     carries DISTINCT committer timestamps (§5).
//   - total honesty: upstream's count is an unbounded `rev-list --count`;
//     ours is the walk itself — exact when the frontier exhausts inside
//     MAX_GRAPH_SCAN, `null` + `truncated` when a cap trips first (the
//     hybrid pager contract, ratified Open question 3).
//
// Covers, in order:
//   1.  MAIN fixture, full default walk vs git: row order === git's
//       --date-order sequence, every commit once, total === 12 === git's
//       rev-list count, truncated false, the six default tip names (the
//       `--tags --branches` set, lw dedup'd), exact top-level shape.
//   2.  the checked-in expected map: all 12 commits' column+color, OCT's
//       commit row + its four travel rows and M's two approach rows pinned
//       edge-for-edge, relation row shape (commit null, column -1), the
//       ≤1-column edge invariant across every row, first row on color 1,
//       colors {1..5} all present.
//   3.  parent-child adjacency: every commit row's every parent reachable
//       by an edge-chain that lands exactly on the parent's dot.
//   4.  dot columns === git's `*` column (star index / 2) for all 12 commits.
//   5.  decorations: heads/tags/remotes groups on the right commits, the
//       annotated tag landing on its PEELED commit, untagged commits bare.
//   6.  hidePRRefs + tip sets: the pull tip excluded from the default walk,
//       walked when explicitly named, SURVIVING hidePRRefs (upstream's
//       --exclude never touches explicit revs); default+hidePR deep-equals
//       default; an explicit remote tip is accepted.
//   7.  the ladder: empty repo null; partial-bad refs walk the good tip;
//       ALL-bad refs fall back to the default set (upstream's bad-ref
//       retry, commit.go:130-142); limit clamps 1..100, page 0 → 1.
//   8.  pagination continuity at limit 3: concatenated page commits === the
//       single walk, per-oid column+color independent of the page (the
//       §3.2.4 lane-state identity), over-the-end page answers rows [] with
//       the exact total still delivered.
//   9.  LINEAR137: total 137 exact === git rev-list --count; page 1 = 100
//       rows, page 2 = 37, page-2 first row === the walk's 101st commit;
//       single lane, all color 1.
//   10. SCAN_OK (20000 commits): page 200 exhausts EXACTLY at the scan cap —
//       total 20000 delivered, truncated false; page 201 answers the §5
//       pin {rows: [], total: null, truncated: true}.
//   11. SCAN_TRIP (20050 commits): pages 1 and 200 answer truncated with
//       total null and 100 rows; page 201 answers the §5 pin.
//   12. the refs cap: 501 heads → the first 500 tips walk (truncated,
//       refs.length 500, total 500 exact for the walked set) vs git's
//       uncapped 501 — the shortfall flagged, never silent.
//   13. the lane cap: 130 branch tips → the cap trips on page 2 (lane state
//       accumulates through the skip, §3.2.4; page 1's window stops
//       assignment at 100 lanes, §3.2.5) — 28 rows at columns 100..127,
//       the monotonic colors 101..128, truncated, total null.
//   14. static tripwire (the check-grep.mjs convention): the RPC rides
//       rpcBind + withContentLease + resolveRef/peelToCommit, names its
//       three budget constants, and GraphDataResult/GraphRow/GraphEdge are
//       declared on repo.ts.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-contributor-stats.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, assertEq, commitOid, git, loadGitRepoIntoStore, makeStore, scratchDir } from "./helpers/lib.mjs";

let planned = 0;
let failed = 0;
async function check(n, name, fn) {
  planned++;
  try {
    await fn();
    console.log(`CHECK ${n} PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`CHECK ${n} FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the real cell over a real store (check-contributor-stats.mjs's shape) ----

async function makeCell(fixtureDir) {
  const { RepoCell } = await import("../src/repo.ts");
  const t = makeStore();
  loadGitRepoIntoStore(t, fixtureDir);
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = {};
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  t.store.setMeta("repo", "r0");
  return { t, cell };
}

// ---- fixture: MAIN (checks 1-8) --------------------------------------------
// Deliberately the SPEC §6 fixture: a linear run (L1←L2←L3←L4), a side branch
// (S1 off L2) merged by a two-parent merge (M), a commit after it (N1) so the
// following octopus CANNOT fast-forward, a 4-parent octopus (OCT ← O1,O2,O3 —
// each an own-file commit off M), a tip (T), annotated (v1→L3) + lightweight
// (lw→T) tags, a remote ref (origin/main→L2), and a refs/pull/2/head whose
// commit (P1 off L3) is reachable ONLY through the pull ref. Every committer
// timestamp is distinct (§5's date-tie ledger).
function buildMainFixture() {
  const dir = scratchDir("graph-main-");
  git(dir, "init -q -b main");
  const at = (d) => ({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  const w = (name, content) => writeFileSync(join(dir, name), content);
  w("f.txt", "l1\n");
  git(dir, "add -A");
  git(dir, `commit -qm "L1"`, at("2026-03-01T10:00:00+00:00"));
  w("f.txt", "l1\nl2\n");
  git(dir, "add -A");
  git(dir, `commit -qm "L2"`, at("2026-03-02T10:00:00+00:00"));
  w("f.txt", "l1\nl2\nl3\n");
  git(dir, "add -A");
  git(dir, `commit -qm "L3"`, at("2026-03-03T10:00:00+00:00"));
  const L3 = commitOid(dir, "HEAD");
  git(dir, "checkout -q -b side HEAD~1");
  w("side.txt", "s1\n");
  git(dir, "add -A");
  git(dir, `commit -qm "S1"`, at("2026-03-04T10:00:00+00:00"));
  git(dir, "checkout -q main");
  git(dir, "checkout -q -b tmp-pr HEAD~1"); // at L3
  w("pr.txt", "p1\n");
  git(dir, "add -A");
  git(dir, `commit -qm "P1"`, at("2026-03-05T14:00:00+00:00"));
  const P1 = commitOid(dir, "HEAD");
  git(dir, "checkout -q main");
  git(dir, `update-ref refs/pull/2/head ${P1}`);
  git(dir, "branch -qD tmp-pr");
  w("f.txt", "l1\nl2\nl3\nl4\n");
  git(dir, "add -A");
  git(dir, `commit -qm "L4"`, at("2026-03-05T10:00:00+00:00"));
  git(dir, `merge -q --no-ff --no-edit -m "M merge side" side`, at("2026-03-06T10:00:00+00:00"));
  w("f.txt", "l1\nl2\nl3\nl4\nn\n");
  git(dir, "add -A");
  git(dir, `commit -qm "N1"`, at("2026-03-06T18:00:00+00:00"));
  for (const [b, f, t] of [
    ["o1", "o1.txt", "2026-03-07T10:00:00+00:00"],
    ["o2", "o2.txt", "2026-03-07T11:00:00+00:00"],
    ["o3", "o3.txt", "2026-03-07T12:00:00+00:00"],
  ]) {
    git(dir, `checkout -q -b ${b} main~1`); // off M — before N1, so the octopus cannot FF
    w(f, `${f}\n`);
    git(dir, "add -A");
    git(dir, `commit -qm "${b.toUpperCase()}"`, at(t));
  }
  git(dir, "checkout -q main");
  git(dir, `merge --no-edit -m "OCT octopus" o1 o2 o3`, at("2026-03-08T10:00:00+00:00"));
  w("f.txt", "l1\nl2\nl3\nl4\nn\nt\n");
  git(dir, "add -A");
  git(dir, `commit -qm "T"`, at("2026-03-09T10:00:00+00:00"));
  git(dir, `tag -a v1 -m v1 ${L3}`);
  git(dir, "tag lw");
  git(dir, `update-ref refs/remotes/origin/main ${L3}~1`); // L2
  return { dir, L3, P1 };
}

// ---- fixture: an n-commit linear chain (one fast-import stream) -------------
function buildLinearFixture(n, prefix) {
  const dir = scratchDir(`graph-${prefix}-`);
  git(dir, "init -q -b main");
  const base = Math.floor(Date.UTC(2026, 9, 27) / 1000);
  const lines = [];
  const blob = "worlds\n";
  lines.push("blob", "mark :1", `data ${Buffer.byteLength(blob)}`, blob);
  for (let i = 0; i < n; i++) {
    const t = base + i * 60;
    const msg = `c${i}\n`;
    lines.push(
      "commit refs/heads/main",
      `author T <t@t> ${t} +0000`,
      `committer T <t@t> ${t} +0000`,
      `data ${Buffer.byteLength(msg)}`,
      msg,
      "M 100644 :1 w.txt"
    );
  }
  execSync("git fast-import --quiet", { cwd: dir, input: lines.join("\n"), stdio: ["pipe", "ignore", "inherit"] });
  return dir;
}

// ---- fixture: the scan-cap boundary/trip (checks 10-11) ----------------------

// ---- fixture: the refs cap — 501 branch tips off one root (check 12) --------
function buildRefsCapFixture() {
  const dir = scratchDir("graph-refscap-");
  git(dir, "init -q -b main");
  const base = Math.floor(Date.UTC(2026, 9, 27) / 1000);
  const lines = [];
  const blob = "r\n";
  lines.push("blob", "mark :1", `data ${Buffer.byteLength(blob)}`, blob);
  // b0000 carries the root commit; b0001..b0500 each add one commit off it
  const rootMark = 2;
  lines.push(
    "commit refs/heads/b0000",
    `mark :${rootMark}`,
    "committer T <t@t> " + base + " +0000",
    "data 2\nr0",
    "deleteall",
    "M 100644 :1 f.txt"
  );
  for (let i = 1; i <= 500; i++) {
    const t = base + i;
    lines.push(
      `commit refs/heads/b${String(i).padStart(4, "0")}`,
      `committer T <t@t> ${t} +0000`,
      "data 1\n.",
      `from :${rootMark}`, // `from` rides after the data block (fast-import grammar)
      "M 100644 :1 f.txt"
    );
  }
  execSync("git fast-import --quiet", { cwd: dir, input: lines.join("\n"), stdio: ["pipe", "ignore", "inherit"] });
  return dir;
}

// ---- fixture: the lane cap — 130 branch tips, one commit each off a root,
// distinct DESC timestamps so all tips pop before their shared root (check 13)
function buildLaneCapFixture() {
  const dir = scratchDir("graph-lanecap-");
  git(dir, "init -q -b main");
  const base = Math.floor(Date.UTC(2026, 9, 27) / 1000);
  const lines = [];
  const blob = "r\n";
  lines.push("blob", "mark :1", `data ${Buffer.byteLength(blob)}`, blob);
  lines.push(
    "commit refs/heads/main",
    "mark :2", // the blob took :1; the tips' `from :2` anchors at the root
    "committer T <t@t> " + base + " +0000",
    "data 4\nroot",
    "deleteall",
    "M 100644 :1 f.txt"
  );
  for (let i = 1; i <= 130; i++) {
    // DESC timestamps: tip 1 is the newest, so tips pop before the root and
    // before each other in deterministic order
    const t = base + 100000 - i;
    lines.push(
      `commit refs/heads/f${String(i).padStart(3, "0")}`,
      `committer T <t@t> ${t} +0000`,
      "data 1\n.",
      "from :2", // `from` rides after the data block (fast-import grammar)
      "M 100644 :1 f.txt"
    );
  }
  execSync("git fast-import --quiet", { cwd: dir, input: lines.join("\n"), stdio: ["pipe", "ignore", "inherit"] });
  return dir;
}

const MAIN = buildMainFixture();
const LINEAR137 = buildLinearFixture(137, "linear137");
const SCAN_OK = buildLinearFixture(20000, "scanok");
const SCAN_TRIP = buildLinearFixture(20050, "scantrip");
const REFSCAP = buildRefsCapFixture();
const LANECAP = buildLaneCapFixture();

// ---- the real-git oracle --------------------------------------------------------

/** git log --graph --date-order over the DEFAULT tip set (--branches --tags —
 *  graph.go:36-38's semantics, our default's upstream definition). Returns
 *  { order: commit oids newest-first, starCol: oid → the `*` column of the
 *  art (star index / 2 — stars sit on even indexes, one char per column) }. */
function gitGraphOracle(dir) {
  const out = execSync(`git -C ${dir} log --graph --date-order --pretty=format:DATA:%H --branches --tags`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  const order = [];
  const starCol = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("DATA:");
    if (at < 0) continue;
    const prefix = line.slice(0, at);
    const star = prefix.indexOf("*");
    const oid = line.slice(at + 5).trim();
    order.push(oid);
    if (star >= 0) starCol[oid] = star / 2;
  }
  return { order, starCol };
}

function gitRevListCount(dir, args) {
  return parseInt(execSync(`git -C ${dir} rev-list --count ${args}`, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim(), 10);
}

/** Edge-chain reachability (the adjacency oracle): BFS from the commit dot at
 *  `fromRow` down the rows; a state is a column at the TOP of a row; edges
 *  carry it to the row below at `to`. A commit dot TERMINATES every chain:
 *  a state equal to the dot's column at the top of its row (an edge from the
 *  previous row landed on it), or an edge on its row whose `to` is the dot's
 *  column (a convergence diagonal), either IS the parent (found) or is
 *  consumed by a different commit's dot (a lane ends at its target; sibling
 *  fan-out branches die there, the parent's own branch continues). */
function parentReachable(rows, fromRow, parentOid) {
  let frontier = new Set([rows[fromRow].column]);
  for (let r = fromRow; r < rows.length; r++) {
    const row = rows[r];
    const dotCol = row.commit ? row.column : null;
    const next = new Set();
    for (const c of frontier) {
      if (r > fromRow && dotCol !== null && c === dotCol) {
        if (row.commit.oid === parentOid) return true;
        continue; // consumed by another commit's dot
      }
      for (const e of row.edges) {
        if (e.from !== c) continue;
        if (dotCol !== null && e.to === dotCol && e.from !== dotCol) {
          // a convergence diagonal landing on THIS row's dot
          if (row.commit.oid === parentOid) return true;
          continue; // consumed by another commit's dot
        }
        next.add(e.to);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return false;
}

/** commits of a result, newest-first */
function commitOids(result) {
  return result.rows.filter((r) => r.commit !== null).map((r) => r.commit.oid);
}

/** rows keyed by commit subject → the commit row (MAIN's subjects are unique) */
function bySubject(result) {
  const m = {};
  for (const r of result.rows) {
    if (r.commit !== null) m[r.commit.subject] = r;
  }
  return m;
}

// ---- the checked-in expected map (check 2) ---------------------------------------
// Hand-derived from SPEC-0017 §3.3 against the MAIN fixture's pop order
// T(03-09) OCT(03-08) O3 O2 O1 N1(03-06T18) M(03-06T10) L4 S1 L3 L2 L1 — the
// mechanical model: lowest incoming lane wins the column; parent 0 extends
// the vacated slot; extra parents bend-to-targeted or take the lowest free
// slot with a fresh monotonic color, departing one row apart; every edge
// crosses ≤1 column, wider shifts travel via commit-less relation rows.
const EXPECTED_COLS = {
  // subject: [column, color]
  T: [0, 1],
  "OCT octopus": [0, 1],
  O3: [3, 4],
  O2: [2, 3],
  O1: [1, 2],
  N1: [0, 1],
  "M merge side": [0, 1],
  L4: [0, 1],
  S1: [1, 5],
  L3: [0, 1],
  L2: [0, 1],
  L1: [0, 1],
};
// OCT's own pop lands lane 0 (color 1) and fans three new lanes (colors 2,3,4)
// one row apart — the commit row carries parent 0's vertical (the landing
// lane's own continuation — one `|`, never a duplicate) plus O1's departure,
// then three relation rows stagger O2/O3 and complete the travel.
const OCT_COMMIT_EDGES = [
  { from: 0, to: 0, color: 1 },
  { from: 0, to: 1, color: 2 },
];
const OCT_RELATION_EDGES = [
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 0, to: 1, color: 3 },
  ],
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 0, to: 1, color: 4 },
    { from: 1, to: 2, color: 3 },
  ],
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 2, to: 2, color: 3 },
    { from: 1, to: 2, color: 4 },
  ],
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 2, to: 2, color: 3 },
    { from: 2, to: 3, color: 4 },
  ],
];
// M's pop has FOUR lanes converging (all four open lanes target it) — the far
// ones (columns 2 and 3) approach one column per PRE-commit relation row (git's
// `|/` shift lines) so the commit row's convergence edges stay within the
// ≤1-column rule; the commit row then carries all four convergence edges (one
// per incoming lane), parent 0's vertical, and S1's departure (color 5).
const M_BEFORE_EDGES = [
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 2, to: 1, color: 3 },
    { from: 3, to: 2, color: 4 },
  ],
  [
    { from: 0, to: 0, color: 1 },
    { from: 1, to: 1, color: 2 },
    { from: 1, to: 1, color: 3 },
    { from: 2, to: 1, color: 4 },
  ],
];
const M_COMMIT_EDGES = [
  { from: 1, to: 0, color: 2 },
  { from: 1, to: 0, color: 3 },
  { from: 1, to: 0, color: 4 },
  { from: 0, to: 0, color: 1 },
  { from: 0, to: 1, color: 5 },
];

// ---- the checks -----------------------------------------------------------------

await check(1, "MAIN default walk vs git: row order === git's --date-order, every commit once, exact total, the --tags --branches tip set, exact shape", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const result = await cell.graphData();
  assert(result !== null, "graphData answered");
  assertEq(Object.keys(result).sort(), ["refs", "rows", "total", "truncated"], "the top-level field set is exactly the SPEC shape");
  assertEq(result.truncated, false, "a 12-commit walk never truncates");
  assertEq(result.total, 12, "the exact total (frontier exhausted)");
  assertEq(result.total, gitRevListCount(MAIN.dir, "--branches --tags"), "total === git's rev-list count over the same tip set");
  const oracle = gitGraphOracle(MAIN.dir);
  const ours = commitOids(result);
  assertEq(ours, oracle.order, "row order === git's --date-order sequence");
  assertEq(new Set(ours).size, ours.length, "every commit appears exactly once");
  assertEq(result.refs, ["refs/heads/main", "refs/heads/o1", "refs/heads/o2", "refs/heads/o3", "refs/heads/side", "refs/tags/v1"], "the tip set actually walked: heads+tags in name order, lw dedup'd into main's tip");
  // the pull tip's commit is NOT in the default walk
  assert(!ours.includes(MAIN.P1), "the pull tip's commit P1 is absent from the default walk (upstream: only refs/pull explicitly selected walks it)");
});

await check(2, "the checked-in expected map: columns+colors for all 12, OCT's commit row + four relation rows pinned edge-for-edge, ≤1-column invariant, colors {1..5}", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const result = await cell.graphData();
  const rows = bySubject(result);
  for (const [subject, [col, color]] of Object.entries(EXPECTED_COLS)) {
    const r = rows[subject];
    assert(r !== undefined, `row for ${subject}`);
    assertEq(r.column, col, `${subject} column`);
    assertEq(r.color, color, `${subject} color`);
    assertEq(typeof r.color, "number", "color is a number (class = %16 is the page's)");
  }
  // the ≤1-column-per-row invariant holds for every edge of every row
  for (const r of result.rows) {
    for (const e of r.edges) {
      assert(Math.abs(e.to - e.from) <= 1, `edge ${JSON.stringify(e)} crosses more than one column (subject ${r.commit ? r.commit.subject : "relation"})`);
      assert(e.color >= 1, `edge color ${e.color} — colors are 1-based monotonic`);
    }
  }
  // relation rows: commit-less, column -1
  const rels = result.rows.filter((r) => r.commit === null);
  for (const r of rels) {
    assertEq(r.column, -1, "relation row column");
    assertEq(r.commit, null, "relation row commit");
  }
  assertEq(rels.length, 6, "the octopus's four post-commit rows + M's two pre-commit approach rows (every other pop transitions within its commit row)");
  // OCT's rows pinned edge-for-edge: the commit row, then the staggered travel
  const octIdx = result.rows.findIndex((r) => r.commit !== null && r.commit.subject === "OCT octopus");
  assertEq(result.rows[octIdx].edges, OCT_COMMIT_EDGES, "OCT commit row edges (convergence, parent 0, O1's departure)");
  for (let i = 0; i < OCT_RELATION_EDGES.length; i++) {
    assertEq(result.rows[octIdx + 1 + i].edges, OCT_RELATION_EDGES[i], `OCT relation row ${i + 1} edges`);
  }
  // M's rows pinned edge-for-edge: the two approach rows, then the commit row
  const mIdx = result.rows.findIndex((r) => r.commit !== null && r.commit.subject === "M merge side");
  assert(mIdx > 1, "M's approach rows precede its commit row");
  for (let i = 0; i < M_BEFORE_EDGES.length; i++) {
    assertEq(result.rows[mIdx - M_BEFORE_EDGES.length + i].edges, M_BEFORE_EDGES[i], `M approach row ${i + 1} edges`);
  }
  assertEq(result.rows[mIdx].edges, M_COMMIT_EDGES, "M commit row edges (four convergences, parent 0, S1's departure)");
  // relation rows never consumed limit or the skip
  assertEq(result.rows.length, 18, "12 commit rows + 4 OCT travel rows + 2 M approach rows (relation rows are free — §3.3.4)");
  // colors: the monotonic counter — first row on color 1, {1..5} all present
  assertEq(result.rows[0].color, 1, "the first commit sits on color 1");
  const colors = new Set(result.rows.filter((r) => r.commit !== null).map((r) => r.color));
  assertEq([...colors].sort(), [1, 2, 3, 4, 5], "the five lanes' colors exactly {1,2,3,4,5} (T/M-chain 1, O1 2, O2 3, O3 4, S1 5)");
  // every edge's from/to stays inside the lane budget
  for (const r of result.rows) {
    for (const e of r.edges) {
      assert(e.from >= 0 && e.to >= 0 && e.from < 128 && e.to < 128, "edges stay inside MAX_GRAPH_LANES");
    }
  }
});

await check(3, "parent-child adjacency: every commit's every parent reachable by an edge chain landing on the parent's dot", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const result = await cell.graphData();
  const rows = result.rows;
  let pairs = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.commit === null) continue;
    for (const p of r.commit.parents) {
      const prow = rows.findIndex((x) => x.commit !== null && x.commit.oid === p);
      assert(prow >= 0, `parent ${p} of ${r.commit.subject} appears as a row`);
      if (prow < i) continue; // not reachable downward — fixtures carry no date inversions
      assert(parentReachable(rows, i, p), `parent ${r.commit.subject}→(row ${prow}) reachable by edges`);
      pairs++;
    }
  }
  assert(pairs >= 13, `every parent pair checked (${pairs}: 11 first-parent + M's and OCT's extras)`);
  // the root has no parents and the octopus really carries four
  const oct = rows.find((r) => r.commit !== null && r.commit.subject === "OCT octopus");
  assertEq(oct.commit.parents.length, 4, "the octopus's four parents (the fixture's wide fan-out)");
  const l1 = rows.find((r) => r.commit !== null && r.commit.subject === "L1");
  assertEq(l1.commit.parents, [], "the root carries no parents");
});

await check(4, "dot columns === git's art: our column equals the `*` column of git log --graph for all 12 commits", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const result = await cell.graphData();
  const oracle = gitGraphOracle(MAIN.dir);
  for (const r of result.rows) {
    if (r.commit === null) continue;
    const gcol = oracle.starCol[r.commit.oid];
    assert(gcol !== undefined, `git drew a star for ${r.commit.subject}`);
    assertEq(r.column, gcol, `${r.commit.subject}: our column === git's star column`);
  }
});

await check(5, "decorations: heads/tags/remotes on the right commits; the annotated tag lands on its PEELED commit; untagged commits bare", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const result = await cell.graphData();
  const rows = bySubject(result);
  assertEq(rows.T.commit.refs, [
    { name: "refs/heads/main", group: "heads" },
    { name: "refs/tags/lw", group: "tags" },
  ], "T carries the branch and the lightweight tag");
  assertEq(rows.O1.commit.refs, [{ name: "refs/heads/o1", group: "heads" }], "O1's head");
  assertEq(rows.O2.commit.refs, [{ name: "refs/heads/o2", group: "heads" }], "O2's head");
  assertEq(rows.O3.commit.refs, [{ name: "refs/heads/o3", group: "heads" }], "O3's head");
  assertEq(rows.S1.commit.refs, [{ name: "refs/heads/side", group: "heads" }], "S1's head");
  assertEq(rows.L2.commit.refs, [{ name: "refs/remotes/origin/main", group: "remotes" }], "L2 carries the remote ref (remotes group — decorations come from ALL refs regardless of tips)");
  // the annotated tag: git's ref points at the TAG OBJECT; the decoration
  // lands on the row of the PEELED commit
  const tagObjOid = commitOid(MAIN.dir, "refs/tags/v1");
  const peeledOid = commitOid(MAIN.dir, "refs/tags/v1^{commit}");
  assert(tagObjOid !== peeledOid, "v1 really is an annotated tag (its ref target is the tag object)");
  assertEq(rows.L3.commit.oid, peeledOid, "L3's row is the peeled target");
  assertEq(rows.L3.commit.refs, [{ name: "refs/tags/v1", group: "tags" }], "the v1 chip sits on the peeled row");
  for (const subject of ["N1", "M merge side", "OCT octopus", "L1", "L4"]) {
    assertEq(rows[subject].commit.refs, [], `${subject} carries no decorations`);
  }
});

await check(6, "hidePRRefs + tip sets: the pull tip excluded by default, walked when named, SURVIVING hidePRRefs; default+hidePR === default; explicit remote accepted", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const def = await cell.graphData();
  const defHide = await cell.graphData({ hidePRRefs: true });
  assertEq(defHide, def, "hidePRRefs is a no-op on the default expansion (--tags --branches has no pull refs; the --exclude analog bites wildcard expansion only)");
  const explicit = await cell.graphData({ refs: ["refs/pull/2/head"] });
  assertEq(explicit.refs, ["refs/pull/2/head"], "the explicit pull tip is walked");
  assertEq(explicit.total, 3, "named refs REPLACE the default set (graph.go: the --tags --branches expansion fires only when no refs are given) — P1 (branched at L2) brings L2 and L1 with it");
  assertEq(explicit.total, gitRevListCount(MAIN.dir, "refs/pull/2/head"), "=== git rev-list over the same single tip");
  assert(commitOids(explicit).includes(MAIN.P1), "P1's commit row appears when the pull ref is named");
  const explicitHide = await cell.graphData({ refs: ["refs/pull/2/head"], hidePRRefs: true });
  assertEq(explicitHide, explicit, "an explicitly named pull ref SURVIVES hidePRRefs (upstream: --exclude never touches explicit revs)");
  const p1row = explicit.rows.find((r) => r.commit !== null && r.commit.oid === MAIN.P1);
  assertEq(p1row.commit.refs, [{ name: "refs/pull/2/head", group: "pull" }], "P1 carries its pull decoration (group pull)");
  // an explicit remote tip is accepted too (the dropdown lists remotes)
  const remote = await cell.graphData({ refs: ["refs/remotes/origin/main"] });
  assertEq(remote.refs, ["refs/remotes/origin/main"], "the explicit remote tip is walked");
  assertEq(remote.total, gitRevListCount(MAIN.dir, "refs/remotes/origin/main"), "its walk is exactly that tip's ancestry");
});

await check(7, "the ladder: empty repo null; partial-bad refs walk the good tip; ALL-bad refs fall back to the default set; limit clamps 1..100, page 0 → 1", async () => {
  const { cell } = await makeCell(MAIN.dir);
  // partial-bad: the good tip walks, the ghost is skipped silently
  const mixed = await cell.graphData({ refs: ["refs/heads/main", "refs/heads/ghost"] });
  assertEq(mixed.refs, ["refs/heads/main"], "the unresolvable tip skipped");
  assertEq(mixed.total, 12, "main's history is the whole default set");
  // ALL-bad: upstream's bad-ref retry — answer unfiltered, never fail
  const allBad = await cell.graphData({ refs: ["refs/heads/ghost", "refs/tags/ghost"] });
  const def = await cell.graphData();
  assertEq(allBad, def, "all-bad refs fall back to the default tip set (commit.go:130-142)");
  // limit clamps: 0 → 1 row; 1000 → ≤100 commit rows
  const one = await cell.graphData({ limit: 0 });
  assertEq(commitOids(one).length, 1, "limit 0 clamps to 1");
  const big = await cell.graphData({ limit: 1000 });
  assertEq(commitOids(big).length, 12, "limit 1000 clamps to 100 — the whole 12 fit");
  // page 0 / negative → page 1
  const p0 = await cell.graphData({ page: 0, limit: 3 });
  const pneg = await cell.graphData({ page: -5, limit: 3 });
  const p1 = await cell.graphData({ page: 1, limit: 3 });
  assertEq(p0, p1, "page 0 answers page 1");
  assertEq(pneg, p1, "a negative page answers page 1");
  // empty repo
  const emptyDir = scratchDir("graph-empty-");
  git(emptyDir, "init -q -b main");
  const { cell: emptyCell } = await makeCell(emptyDir);
  assertEq(await emptyCell.graphData(), null, "empty repo (unborn HEAD) answers null");
  assertEq(await emptyCell.graphData({ refs: ["refs/heads/nope"] }), null, "an empty repo with named refs answers null");
});

await check(8, "pagination continuity at limit 3: concatenated page commits === the single walk; per-oid column+color independent of the page; over-the-end page keeps the exact total", async () => {
  const { cell } = await makeCell(MAIN.dir);
  const full = await cell.graphData();
  const fullByOid = {};
  for (const r of full.rows) {
    if (r.commit !== null) fullByOid[r.commit.oid] = { column: r.column, color: r.color };
  }
  // the whole walk needs ceil(12/3) = 4 pages
  const paged = [];
  let relRowsTotal = 0;
  for (let page = 1; page <= 4; page++) {
    const p = await cell.graphData({ page, limit: 3 });
    const commits = p.rows.filter((r) => r.commit !== null);
    for (const r of commits) {
      const f = fullByOid[r.commit.oid];
      assert(f !== undefined, "paged commit belongs to the full walk");
      assertEq(r.column, f.column, `${r.commit.subject}: column independent of the page`);
      assertEq(r.color, f.color, `${r.commit.subject}: color independent of the page`);
    }
    relRowsTotal += p.rows.length - commits.length;
    paged.push(...commits.map((r) => r.commit.oid));
  }
  assertEq(paged, commitOids(full), "the pages concatenated reproduce the single walk's commit sequence");
  assertEq(relRowsTotal, 6, "the relation rows appear exactly once across the pages: OCT's four travel rows + M's two approach rows, on their own pop's page");
  // over the end: the walk exhausts — rows empty, the exact total STILL delivered
  const over = await cell.graphData({ page: 9, limit: 3 });
  assertEq(over.rows, [], "past the last page: no rows");
  assertEq(over.total, 12, "the exact total still delivered");
  assertEq(over.truncated, false, "no budget exit — §5's {rows: [], total: null, truncated} shape is for the SCAN cap, not a plain over-end page");
});

await check(9, "LINEAR137: total 137 exact === git rev-list; page 1 = 100 rows, page 2 = 37, page-2 first row === the walk's 101st commit; single lane on color 1", async () => {
  const { cell } = await makeCell(LINEAR137);
  const p1 = await cell.graphData();
  assertEq(p1.truncated, false, "no budget exit");
  assertEq(p1.total, 137, "the exact total");
  assertEq(p1.total, gitRevListCount(LINEAR137, "main"), "=== git rev-list --count");
  assertEq(commitOids(p1).length, 100, "page 1 carries 100 commit rows (limit default 100)");
  for (const r of p1.rows) {
    assertEq(r.column, 0, "single lane at column 0");
    assertEq(r.color, 1, "one lane, one color — the first");
    assertEq(r.edges, [{ from: 0, to: 0, color: 1 }], "exactly the lane's vertical per row");
  }
  const p2 = await cell.graphData({ page: 2 });
  assertEq(commitOids(p2).length, 37, "page 2 carries the remaining 37");
  const merged = [...commitOids(p1), ...commitOids(p2)];
  assertEq(new Set(merged).size, 137, "the pages tile the walk without overlap");
  // the skip-window identity, pinned against git: the pages concatenated are
  // git's full date order, and page 2 OPENS at the walk's 101st commit
  const gitList = execSync(`git -C ${LINEAR137} rev-list main`, { encoding: "utf8" }).trim().split("\n");
  assertEq(merged, gitList, "the pages concatenated reproduce git's full date order");
  assertEq(commitOids(p2)[0], gitList[100], "page 2's first commit is the walk's 101st (git's order)");
  assertEq(p2.total, 137, "page 2 sees the same exact total");
});

await check(10, "SCAN_OK (20000 commits): page 200 exhausts EXACTLY at the scan cap — total 20000 delivered, truncated false; page 201 answers the §5 pin", async () => {
  const { cell } = await makeCell(SCAN_OK);
  const last = await cell.graphData({ page: 200 }); // skip 19900 + 100 row pops = the cap exactly
  assertEq(commitOids(last).length, 100, "the window fills");
  assertEq(last.total, 20000, "the frontier emptied AT the cap — the exact total is delivered");
  assertEq(last.total, gitRevListCount(SCAN_OK, "main"), "=== git's uncapped count");
  assertEq(last.truncated, false, "no budget exit: 20000 pops === the cap is inside it");
  const deeper = await cell.graphData({ page: 201 }); // skip 20000 >= MAX_GRAPH_SCAN
  assertEq(deeper, { refs: last.refs, rows: [], total: null, truncated: true }, "§5's deeper-page pin: {rows: [], total: null, truncated: true}");
});

await check(11, "SCAN_TRIP (20050 commits): the cap trips first — pages answer truncated with total null; the §5 deeper-page pin", async () => {
  const { cell } = await makeCell(SCAN_TRIP);
  const first = await cell.graphData();
  assertEq(commitOids(first).length, 100, "page 1 filled its window");
  assertEq(first.total, null, "total is NOT delivered when the cap trips first (an unbounded rev-list count is not faked)");
  assertEq(first.truncated, true, "the budget exit is flagged");
  const last = await cell.graphData({ page: 200 }); // skip 19900 + 100 rows, 50 commits left unpopped
  assertEq(commitOids(last).length, 100, "page 200 filled its window");
  assertEq(last.total, null, "the count-only tail hit the cap — total null");
  assertEq(last.truncated, true, "flagged");
  const deeper = await cell.graphData({ page: 201 });
  assertEq(deeper, { refs: last.refs, rows: [], total: null, truncated: true }, "§5's deeper-page pin");
});

await check(12, "the refs cap: 501 heads → the first 500 tips walk, truncated, total exact for the walked set (500) vs git's uncapped 501", async () => {
  const { cell } = await makeCell(REFSCAP);
  const result = await cell.graphData();
  assertEq(result.truncated, true, "the MAX_GRAPH_REFS cap flagged");
  assertEq(result.refs.length, 500, "the first 500 tips seeded (listRefs order)");
  assertEq(result.total, 500, "the walked set's exact count (root + 499 tips; the 501st head's tip is outside)");
  assertEq(gitRevListCount(REFSCAP, "--branches"), 501, "git's uncapped count is 501 — the shortfall is flagged via truncated, never silent");
  assertEq(commitOids(result).length, 100, "page 1 filled its window");
});

await check(13, "the lane cap: 130 branch tips — the cap trips on page 2 (lane assignment runs through the skip, §3.2.4): 28 rows at columns 100..127, colors 101..128, truncated, total null", async () => {
  const { cell } = await makeCell(LANECAP);
  // page 1 can never reach the cap: assignment stops once the 100-row window
  // fills (§3.2.5's count-only pops), so at most 100 lanes ever open in it.
  // Page 2 runs lane assignment through its 100-pop SKIP (§3.2.4 — upstream
  // feeds every skipped line through its parser, graph.go:81), so lane state
  // keeps growing past 100 and the 129th tip's landing crosses the cap.
  const result = await cell.graphData({ page: 2 });
  assertEq(result.truncated, true, "the MAX_GRAPH_LANES cap flagged");
  assertEq(result.total, null, "the walk stopped before exhausting — no count");
  assertEq(commitOids(result).length, 28, "the walk stops at the pop whose landing crossed the cap (28 of page 2's 100 rows were collected)");
  for (let i = 0; i < 28; i++) {
    const row = result.rows[i];
    assertEq(row.column, 100 + i, `tip ${101 + i} lands at column ${100 + i} — lanes continue across the page boundary`);
    assertEq(row.color, 101 + i, "the monotonic color counter — one fresh color per lane");
    assertEq(row.edges.length, 101 + i, `row ${i} carries ${101 + i} edges (every open lane's vertical + its own)`);
  }
  assertEq(result.refs.length, 131, "all 131 heads seeded (main + 130 tips) — the lane cap, not the refs cap, stopped the walk");
});

await check(14, "static tripwire: rpcBind + withContentLease + resolveRef/peelToCommit; the three budget constants; the module helpers; the result types on repo.ts", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async graphData("), src.indexOf("async activityStats("));
  assert(body.length > 0, "the graphData method found");
  assert(body.includes("this.rpcBind()"), "rpcBind first");
  assert(body.includes("this.withContentLease"), "the read-RPC lease wrapper");
  assert(body.includes("this.resolveRef"), "the ref ladder");
  assert(body.includes("this.peelToCommit"), "the tip peel");
  assert(body.includes("MAX_GRAPH_SCAN") && body.includes("MAX_GRAPH_REFS"), "the scan/refs budget constants ride the walk");
  assert(src.includes("MAX_GRAPH_LANES"), "the lanes budget rides the named lane helper (graphLaneRows)");
  assert(src.includes("function graphLaneRows"), "the lane assignment is the named module helper");
  assert(src.includes("function refGroup"), "the RefGroup rule is the named module helper");
  for (const t of ["export interface GraphDataResult", "export interface GraphRow", "export interface GraphEdge", "export interface GraphCommitJson"]) {
    assert(src.includes(t), `${t} declared on repo.ts`);
  }
  // NOTE: the mod.ts re-export (`GraphDataResult` on the package boundary)
  // folds into M2's combined landing — mod.ts is a sibling wave's file;
  // dist-types/repo.d.ts (generated by typecheck) carries the boundary
  // declaration this unit owns (the M2a precedent, verbatim).
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  if (!mod.includes("GraphDataResult")) console.log("      note: mod.ts GraphDataResult re-export pending M2's combined landing (dist-types/repo.d.ts carries it)");
});

console.log(`\ncheck-graph: ${planned - failed}/${planned} checks passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
