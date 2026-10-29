// activityStats RPC gate — SPEC-0015 §3.2 M2a (the census R14 boundary:
// upstream's `GET .../activity[/{period}]` page data, the pulse page's code
// unit). Run with tsx (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-activity-stats.mjs
// Exits non-zero on any failed check.
//
// What makes this honest: the RPC is the REAL RepoCell.activityStats over a
// real GitStore (node:sqlite) seeded from REAL git fixtures, and the ORACLE
// for every ordinary (non-budget) run is real `git log` over the same
// fixture — the exact command upstream GetCodeActivityStats builds
// (repo_stats.go:55-59: `git log --numstat --no-merges --first-parent
// <branch> --since=<RFC3339>`) aggregated by a faithful port of upstream's
// own parser (parseCodeActivityLog, repo_stats.go:85-152: lowercased-email
// keying, the `-` skip, the distinct file set, commits-DESC authors). The
// count/commitCount budget fields pin against `git rev-list --count
// --first-parent [--no-merges] ... --since=` — the same walk, counted.
// The TTL arms are behavioral: the stats_cache row is tampered THROUGH the
// underlying sqlite (a fresh stamp with bogus numbers must come back — the
// cache is honored within TTL; a stale stamp must recompute — the real
// numbers come back and the row is rewritten).
//
// Pinned divergences (ledger-ready, per SPEC §2.2/§3.2):
//   - no rename detection: upstream's `git log --numstat` follows git's
//     default diff.renames and counts a rename as ONE path + the line DELTA;
//     our fold diffs trees by path (computeDiff), so a rename counts as
//     delete+add of the FULL file with BOTH paths in the set. The oracle
//     runs `--no-renames` to mirror; check 4 proves the choice is
//     load-bearing (the renames-enabled oracle answers differently).
//   - honest caps: upstream walks uncapped (a `--since` walk over huge
//     history is just slow); ours caps at MAX_STATS_SCAN and flags
//     `truncated` (the blame budget-exit rule — a budget-bounded walk is
//     never presented complete). The cap check pins against git's UNCAPPED
//     rev-list count.
//   - per-commit diff budgets: a binary file and a MAX_DIFF_BLOB-over file
//     contribute their PATH with add=del=0 (the same shape upstream's parser
//     gets from numstat's `-` rows); a commit past MAX_DIFF_FILES counts its
//     first 100 paths (upstream's numstat is uncapped).
//   - commitCountInAllBranches is OMITTED in v1 (ratified Open question 2) —
//     tripped statically in check 10.
//
// Covers, in order:
//   1.  the seven periods (activity.go:29-45) over an age-stratified
//       fixture: every period's full answer (counts, totals, file set,
//       authors) equals the git-oracle aggregation for the same window, and
//       count/commitCount equal the rev-list counts — commits outside a
//       window are excluded, one edge per period.
//   2.  the timeline fixture, yearly: the first-parent chain fold (merges
//       stepped but not folded, the side branch never reached) equals the
//       git-oracle aggregation; truncated stays false.
//   3.  merge + side-branch exclusion, structurally: the merge costs the
//       walk a step (count 6) but no fold (commitCount 5); the merge's own
//       first-parent net change is NONZERO (git-verified shortstat) and yet
//       never folded; the tip tree carries the side branch's file, yet the
//       file never reaches the set.
//   4.  add/del totals + distinct changedFiles: ours equals the
//       --no-renames oracle on every total; the fixture really contains a
//       rename (the renames-enabled oracle differs — the --no-renames pin is
//       load-bearing); the binary file is counted as a path with no lines.
//   5.  authors: same email under different name-cases merges into ONE row
//       keyed by the LOWERCASED email; the surviving name is the NEWEST
//       commit's (first-seen in the newest-first walk, the same precedence
//       upstream's log-order parser gives); commits-DESC order with the
//       first-seen tiebreak.
//   6.  the empty window + period normalization: a window with no commits
//       answers the all-zero result, NOT null, NOT truncated; absent period
//       === weekly === an unknown period's answer.
//   7.  the cap: a 2002-in-window-commit fixture answers commitCount ===
//       count === MAX_STATS_SCAN (2000), truncated === true, against git's
//       uncapped rev-list count of 2002.
//   8.  the TTL: a fresh cache hit is HONORED (fresh-stamped bogus numbers
//       come back); a past-TTL entry RECOMPUTES (the real numbers come back
//       and the row is rewritten with a fresh stamp); the stamp and the
//       10-minute constant are pinned structurally.
//   9.  null arms: an unresolvable ref and an empty repo answer null; a raw
//       oid ref answers exactly what the branch answer answers.
//   10. static tripwire (the check-grep.mjs convention): the RPC rides
//       rpcBind + withContentLease, the fold names MAX_STATS_SCAN and the
//       TTL/prefix constants, ActivityStatsResult is declared on repo.ts,
//       and the result shape declares NO commitCountInAllBranches field.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-grep.mjs).
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

// ---- the real cell over a real store (check-grep.mjs's shape) ----------------

async function contentCell(t) {
  const { RepoCell, ACTIVITY_STATS_TTL_MS } = await import("../src/repo.ts");
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = {};
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  t.store.setMeta("repo", "r0");
  return { cell, ACTIVITY_STATS_TTL_MS };
}

async function makeCell(fixtureDir) {
  const t = makeStore();
  loadGitRepoIntoStore(t, fixtureDir);
  const made = await contentCell(t);
  return { t, ...made };
}

// ---- the age-stratified fixture (check 1: the seven period windows) ----------
// One commit per age band, all on one linear chain, dates computed from the
// real clock with day-scale margins from every window edge:
//   age 30h  — outside daily (24h), inside halfweekly (72h)
//   age 80h  — outside halfweekly, inside weekly (168h)
//   age 5d   — inside weekly and monthly (~1 calendar month)
//   age 40d  — outside monthly (≤31d), inside quarterly (~92d)
//   age 100d — outside quarterly, inside semiyearly (~183d)
//   age 200d — outside semiyearly, inside yearly (~366d)
//   age 400d — outside yearly (and everything else)
function buildBoundsFixture() {
  const dir = scratchDir("act-bounds-");
  git(dir, "init -q -b main");
  const now = Date.now();
  const day = 86400 * 1000;
  const ages = [400, 200, 100, 40, 5, 80 / 24, 30 / 24]; // days, oldest first
  ages.forEach((ageDays, i) => {
    const iso = new Date(now - ageDays * day).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    writeFileSync(join(dir, `bound-${i}.txt`), `bound commit at age ${ageDays}d\n`.repeat(i + 1));
    git(dir, "add -A");
    git(dir, `commit -qm "bound commit ${i} (age ${ageDays}d)"`, {
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_NAME: "Timer",
      GIT_AUTHOR_EMAIL: "timer@example.com",
      GIT_COMMITTER_NAME: "Timer",
      GIT_COMMITTER_EMAIL: "timer@example.com",
    });
  });
  return dir;
}

// ---- the timeline fixture (checks 2-6, 8-9): merges, renames, binary, ties ---
// Chain (main): c1 ← c2 ← c3 ← c5(merge) ← c6 ← c7; c4 sits on the side
// branch off c1 and is reachable ONLY through the merge's second parent.
function buildTimelineFixture() {
  const dir = scratchDir("act-timeline-");
  git(dir, "init -q -b main");
  const at = (d) => ({
    GIT_AUTHOR_DATE: d,
    GIT_COMMITTER_DATE: d,
  });
  const as = (name, email, env) => ({ ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email });
  // c1 (root, Alice): README + a 10-line file
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nroot\n");
  writeFileSync(join(dir, "src/a.ts"), "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c1 root"`, as("Alice", "alice@example.com", at("2026-03-01T10:00:00+00:00")));
  // c2 (Alice again, SAME email in upper case — one author, and the newest
  // alice commit's name must win): rewrites one line, appends three
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nrooted\nprime one\nprime two\nprime three\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c2 readme edits"`, as("Alice Prime", "ALICE@EXAMPLE.COM", at("2026-03-02T10:00:00+00:00")));
  // c3 (Bob): adds a 5-line file, appends two README lines
  writeFileSync(join(dir, "src/bob.ts"), "b1\nb2\nb3\nb4\nb5\n");
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nrooted\nprime one\nprime two\nprime three\nbob one\nbob two\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c3 bob file"`, as("Bob", "bob@example.com", at("2026-03-03T10:00:00+00:00")));
  // c4 (Carol, on the SIDE branch off c1 — off the first-parent chain): adds
  // her own file ONLY — the merge must be CLEAN by construction. (The first
  // draft had both branches edit README to force a conflict; a CI runner's
  // git then failed to START the merge — caught as "expected conflict", the
  // fixture silently lost MERGE_HEAD, and c5 landed single-parent, tripping
  // checks 2/3/5 — observed run 40800106017 while the identical tree passed
  // 10/10 on the dev box. Content-dependent fixture semantics are gone: a
  // clean merge cannot fail to start, and MERGE_HEAD is asserted below.)
  git(dir, "checkout -q -b side HEAD~2");
  writeFileSync(join(dir, "side.txt"), "s1\ns2\ns3\ns4\ns5\ns6\ns7\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c4 side work"`, as("Carol", "carol@example.com", at("2026-03-04T10:00:00+00:00")));
  // c5 (the MERGE on the chain): the conflict resolution appends past c3's
  // README — the merge's first-parent net change is NONZERO (check 3
  // verifies with git), yet a merge is never folded (upstream --no-merges).
  // The merge legitimately carries side.txt INTO the tip tree — where it
  // still must never reach the fold's file set.
  git(dir, "checkout -q main");
  assert(git(dir, "rev-parse --abbrev-ref HEAD").trim() === "main", "fixture drift: not on main before the merge");
  git(dir, "merge --no-ff --no-commit side"); // CLEAN by construction — a nonzero exit here is a fixture bug, not an arm
  assert(
    git(dir, "rev-parse -q --verify MERGE_HEAD").trim() !== "",
    "fixture drift: the no-commit merge is not in progress (no MERGE_HEAD)",
  );
  git(dir, `commit -qm "c5 merge side"`, as("Alice Prime", "alice@example.com", at("2026-03-05T10:00:00+00:00")));
  // c6 (Bob again, SAME bob email in upper case): renames a.ts AND edits the
  // content (numstat --no-renames: full delete + full add), edits bob.ts
  git(dir, "mv src/a.ts src/a-renamed.ts");
  writeFileSync(join(dir, "src/a-renamed.ts"), "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\na11\n");
  writeFileSync(join(dir, "src/bob.ts"), "b1\nb2 prime\nb3\nb4\nb5\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c6 rename a + edit bob"`, as("Bob B", "BOB@EXAMPLE.COM", at("2026-03-06T10:00:00+00:00")));
  // c7 (Carol on the chain now): adds a BINARY file (numstat `- -` row) and
  // deletes bob.ts
  writeFileSync(join(dir, "logo.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00]));
  git(dir, "rm -q src/bob.ts");
  git(dir, "add -A");
  git(dir, `commit -qm "c7 binary + delete"`, as("Carol C", "carol@example.com", at("2026-03-07T10:00:00+00:00")));
  return dir;
}

const TIMELINE = buildTimelineFixture();
const TIMELINE_TIP = commitOid(TIMELINE, "main");
const BOUNDS = buildBoundsFixture();

// ---- the 2002-commit fixture (check 7: the MAX_STATS_SCAN cap) ----------------
// One fast-import stream (a 2002-execSync commit loop is minutes); every
// commit sits inside the weekly window (2026-10-27 + i*30s, so days away
// from both edges of any window the real clock computes today), all EMPTY
// (same tree) except the TIP, which adds w.txt — inside the walked prefix,
// so the fold's content is pinned too (the check pins the count cap, not
// the fold).
function buildCapsFixture(n) {
  const dir = scratchDir("act-caps-");
  git(dir, "init -q -b main");
  const base = Math.floor(Date.UTC(2026, 9, 27) / 1000);
  const lines = [];
  const blob = "worlds\n";
  lines.push("blob", "mark :1", `data ${Buffer.byteLength(blob)}`, blob);
  for (let i = 0; i < n; i++) {
    const t = base + i * 30;
    const msg = `c${i}\n`;
    lines.push(
      "commit refs/heads/main",
      `committer T <t@t> ${t} +0000`,
      `data ${Buffer.byteLength(msg)}`,
      msg
    );
    if (i === n - 1) lines.push("deleteall", "M 100644 :1 w.txt");
  }
  execSync("git fast-import --quiet", {
    cwd: dir,
    input: lines.join("\n"),
    stdio: ["pipe", "ignore", "inherit"],
  });
  return dir;
}

const CAPS = buildCapsFixture(2002);

// ---- the real-git oracle -------------------------------------------------------

/** `git log` raw stdout; throws with git's stderr on a bad invocation. */
function gitLogRaw(dir, args) {
  const quoted = args.map((a) => JSON.stringify(a)).join(" ");
  return execSync(`git -C ${dir} log ${quoted}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
}

/** The window edge — an INDEPENDENT re-implementation of upstream's
 *  activity.go:29-45 switch (fixed hours for daily/halfweekly/weekly, Go
 *  AddDate calendar arithmetic for the rest), so the date semantics are
 *  verified against a second implementation, not shared code. */
function oracleWindowStart(period, now) {
  const hours = { daily: 24, halfweekly: 72, weekly: 168 };
  if (period in hours) return now - hours[period] * 3600 * 1000;
  const d = new Date(now);
  const months = period === "monthly" ? 1 : period === "quarterly" ? 3 : period === "semiyearly" ? 6 : 0;
  if (months) d.setUTCMonth(d.getUTCMonth() - months);
  if (period === "yearly") d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.getTime();
}

/** The upstream aggregation: GetCodeActivityStats' exact command
 *  (repo_stats.go:55-59) plus `--no-renames` (the pinned divergence — our
 *  fold has no rename detection), folded by a faithful port of upstream's
 *  own parseCodeActivityLog (repo_stats.go:85-152): `---`-separated commits,
 *  p = line-in-commit state, lowercased-email author keying (first-seen
 *  name wins — the log is newest-first), the `-` skip on numstat add/del,
 *  the distinct file set, authors sorted commits-DESC. */
function gitActivityOracle(dir, branch, sinceMs, opts = {}) {
  const iso = new Date(sinceMs).toISOString();
  const flags = opts.renames ? [] : ["--no-renames"];
  const out = gitLogRaw(dir, [
    "--numstat",
    "--no-merges",
    ...flags,
    "--first-parent",
    branch,
    `--since=${iso}`,
    "--pretty=format:---%n%H%n%aN%n%aE%n",
  ]);
  const authors = new Map();
  const files = new Set();
  let commitCount = 0;
  let additions = 0;
  let deletions = 0;
  let p = 0;
  let author = "";
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    if (l === "---") {
      p = 1;
    } else if (p === 0) {
      continue;
    } else {
      p++;
    }
    if (p > 4 && l.length === 0) continue;
    if (p === 2) {
      commitCount++;
    } else if (p === 3) {
      author = l;
    } else if (p === 4) {
      const email = l.toLowerCase();
      if (!authors.has(email)) authors.set(email, { name: author, email, commits: 0 });
      authors.get(email).commits++;
    } else if (p > 4) {
      const parts = l.split(/\s+/).filter((s) => s.length > 0); // strings.Fields
      if (parts.length >= 3) {
        if (parts[0] !== "-") {
          const c = parseInt(parts[0], 10);
          if (Number.isFinite(c)) additions += c;
        }
        if (parts[1] !== "-") {
          const c = parseInt(parts[1], 10);
          if (Number.isFinite(c)) deletions += c;
        }
        files.add(parts[2]);
      }
    }
  }
  return {
    authorCount: authors.size,
    commitCount,
    changedFiles: files.size,
    additions,
    deletions,
    authors: [...authors.values()].sort((a, b) => b.commits - a.commits),
  };
}

/** `git rev-list --count` over the same window — the budget fields' oracle. */
function revListCount(dir, args, sinceMs) {
  const quoted = args.map((a) => JSON.stringify(a)).join(" ");
  const iso = new Date(sinceMs).toISOString();
  return parseInt(
    execSync(`git -C ${dir} rev-list --count ${quoted} --since=${JSON.stringify(iso)}`, {
      maxBuffer: 1 << 24,
      stdio: ["ignore", "pipe", "inherit"],
    })
      .toString()
      .trim(),
    10
  );
}

/** The full answer diff: ours must equal the oracle on every aggregated
 *  field (count and truncated are budget fields, checked separately). */
function diffAgainstOracle(got, want, what) {
  assertEq(got.authorCount, want.authorCount, `${what}: authorCount`);
  assertEq(got.commitCount, want.commitCount, `${what}: commitCount`);
  assertEq(got.changedFiles, want.changedFiles, `${what}: changedFiles`);
  assertEq(got.additions, want.additions, `${what}: additions`);
  assertEq(got.deletions, want.deletions, `${what}: deletions`);
  assertEq(got.authors, want.authors, `${what}: authors`);
}

// ---- the checks ---------------------------------------------------------------

const PERIODS = ["daily", "halfweekly", "weekly", "monthly", "quarterly", "semiyearly", "yearly"];

await check(1, "the seven periods: each window's full answer equals the git oracle; count/commitCount equal rev-list", async () => {
  const { cell } = await makeCell(BOUNDS);
  const now = Date.now();
  const expectedCommits = { daily: 0, halfweekly: 1, weekly: 3, monthly: 3, quarterly: 4, semiyearly: 5, yearly: 6 };
  for (const period of PERIODS) {
    const since = oracleWindowStart(period, now);
    const result = await cell.activityStats("main", period);
    assert(result !== null, `${period} answered`);
    assertEq(result.period, period, `${period}: the answer names the normalized period`);
    assertEq(result.truncated, false, `${period}: a 7-commit chain never truncates`);
    diffAgainstOracle(result, gitActivityOracle(BOUNDS, "main", since), `period ${period}`);
    assertEq(result.commitCount, expectedCommits[period], `${period}: the edge commits sit where the margins say`);
    // count (the raw first-parent cost, merges included — none here) and
    // commitCount pin against rev-list over the same window
    assertEq(result.count, revListCount(BOUNDS, ["--first-parent", "main"], since), `${period}: count vs rev-list --first-parent`);
    assertEq(result.commitCount, revListCount(BOUNDS, ["--no-merges", "--first-parent", "main"], since), `${period}: commitCount vs rev-list --no-merges --first-parent`);
  }
});

await check(2, "timeline yearly: the first-parent fold equals the git oracle (merges stepped, side branch never reached)", async () => {
  const { cell } = await makeCell(TIMELINE);
  const since = oracleWindowStart("yearly", Date.now());
  const result = await cell.activityStats("main", "yearly");
  assert(result !== null, "yearly answered");
  // structural pins before the diff: 6 chain steps, 5 folded (the merge
  // excluded), 3 distinct author emails
  assertEq(result.count, 6, "the walk stepped the merge (chain cost 6)");
  assertEq(result.commitCount, 5, "the merge was not folded (upstream --no-merges)");
  assertEq(result.authorCount, 3, "three distinct emails on the chain");
  diffAgainstOracle(result, gitActivityOracle(TIMELINE, "main", since), "timeline yearly");
  assertEq(result.truncated, false, "a 6-step walk never truncates");
});

await check(3, "merge + side-branch exclusion, structurally: the merge's nonzero net change is never folded; side.txt absent", async () => {
  const { cell } = await makeCell(TIMELINE);
  const since = oracleWindowStart("yearly", Date.now());
  const result = await cell.activityStats("main", "yearly");
  assert(result !== null, "yearly answered");
  // the merge's own first-parent net change is NONZERO (git-verified): the
  // resolution appended two lines past c3's README, and side.txt (+7) rides
  // the merge in — so "the merge contributed nothing" can only be the
  // --no-merges exclusion, never a vacuous empty diff
  const mergeOid = execSync(`git -C ${TIMELINE} rev-parse main~1`, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
  const shortstat = execSync(`git -C ${TIMELINE} diff --shortstat ${mergeOid}^1 ${mergeOid}`, {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();
  const m = /(\d+) insertions?\(\+\)/.exec(shortstat);
  assert(m && parseInt(m[1], 10) > 0, `the merge's first-parent diff is nonzero, got ${JSON.stringify(shortstat)}`);
  // the tip tree CARRIES side.txt (the merge brought it in — git-side proof)
  const tipList = execSync(`git -C ${TIMELINE} ls-tree -r --name-only main`, { stdio: ["ignore", "pipe", "inherit"] }).toString();
  assert(tipList.includes("side.txt"), "side.txt must be in the tip tree (the merge merged it — fixture sanity)");
  // ...yet it never reaches the fold's set: changedFiles pins at 5 — README,
  // a.ts, a-renamed.ts, bob.ts, logo.bin — were c4 or the merge's fold
  // counted, side.txt (or the resolution) would push it to 6
  assertEq(result.changedFiles, 5, "the distinct set: 5 chain paths, side.txt and the merge never in it");
  // and the whole answer still equals the oracle (which never sees c4/M)
  diffAgainstOracle(result, gitActivityOracle(TIMELINE, "main", since), "timeline yearly (merge arms)");
});

await check(4, "add/del totals + changedFiles: equals the --no-renames oracle; the rename pin is load-bearing; the binary file counts as a path", async () => {
  const { cell } = await makeCell(TIMELINE);
  const since = oracleWindowStart("yearly", Date.now());
  const result = await cell.activityStats("main", "yearly");
  assert(result !== null, "yearly answered");
  const oracle = gitActivityOracle(TIMELINE, "main", since);
  assertEq(result.additions, oracle.additions, "additions vs --no-renames numstat");
  assertEq(result.deletions, oracle.deletions, "deletions vs --no-renames numstat");
  assertEq(result.changedFiles, oracle.changedFiles, "changedFiles vs --no-renames numstat");
  // LOAD-BEARING pin: the same aggregation WITH rename detection answers
  // differently (upstream counts c6's rename as a line delta + one path;
  // our path-keyed tree diff counts a full delete+add + two paths) — the
  // --no-renames choice is what makes this oracle match our fold
  const renamesOracle = gitActivityOracle(TIMELINE, "main", since, { renames: true });
  assert(
    renamesOracle.changedFiles !== oracle.changedFiles || renamesOracle.additions !== oracle.additions,
    "the fixture's rename must make the renames-enabled oracle differ (c6 renamed AND edited a.ts)"
  );
  // the binary file's PATH reaches the set while its bytes contribute
  // nothing: 5 = README + a.ts + a-renamed.ts + bob.ts + logo.bin
  assertEq(result.changedFiles, 5, "logo.bin (binary, numstat `- -`) counts its path");
});

await check(5, "authors: lowercased-email keying, newest-commit name wins, commits-DESC with the first-seen tiebreak", async () => {
  const { cell } = await makeCell(TIMELINE);
  const result = await cell.activityStats("main", "yearly");
  assert(result !== null, "yearly answered");
  // ALICE@EXAMPLE.COM and alice@example.com are ONE author; the surviving
  // name is the NEWEST alice commit's (the walk is newest-first, so
  // "first-seen" = newest — the same precedence upstream's log-order parser
  // gives); same for bob. bob and alice tie at 2 — the first-seen order
  // holds (bob inserted before alice), carol trails.
  assertEq(result.authors, [
    { name: "Bob B", email: "bob@example.com", commits: 2 },
    { name: "Alice Prime", email: "alice@example.com", commits: 2 },
    { name: "Carol C", email: "carol@example.com", commits: 1 },
  ]);
});

await check(6, "empty window + normalization: all-zero, NOT null, NOT truncated; absent === weekly === unknown", async () => {
  const { cell } = await makeCell(TIMELINE);
  const empty = await cell.activityStats("main", "weekly"); // March commits, October window
  assert(empty !== null, "an empty window answers a result, not null");
  assertEq(empty.period, "weekly", "the normalized period");
  assertEq(empty.count, 0, "no chain steps");
  assertEq(empty.commitCount, 0, "no folded commits");
  assertEq(empty.authorCount, 0, "no authors");
  assertEq(empty.changedFiles, 0, "no files");
  assertEq(empty.additions, 0, "no additions");
  assertEq(empty.deletions, 0, "no deletions");
  assertEq(empty.authors, [], "no author rows");
  assertEq(empty.truncated, false, "an empty window is complete, not truncated");
  // absent and unknown periods normalize to exactly the weekly answer
  const byDefault = await cell.activityStats("main");
  assertEq(byDefault.period, "weekly", "absent period answers weekly");
  assertEq(JSON.stringify(byDefault), JSON.stringify(empty), "absent === explicit weekly");
  const unknown = await cell.activityStats("main", "fortnightly");
  assertEq(unknown.period, "weekly", "an unknown period answers weekly");
  assertEq(JSON.stringify(unknown), JSON.stringify(empty), "unknown === explicit weekly");
});

await check(7, "the cap: 2002 in-window commits answer 2000/2000 + truncated, against git's uncapped 2002", async () => {
  const { cell } = await makeCell(CAPS);
  const since = oracleWindowStart("weekly", Date.now());
  const result = await cell.activityStats("main", "weekly");
  assert(result !== null, "capped run answered");
  assertEq(result.truncated, true, "the cap tripped before the window's oldest edge — flagged");
  assertEq(result.count, 2000, "count froze at MAX_STATS_SCAN");
  assertEq(result.commitCount, 2000, "commitCount froze at MAX_STATS_SCAN");
  assertEq(result.authorCount, 1, "one author (T) — the fold ran on the walked prefix");
  assertEq(result.changedFiles, 1, "one file (w.txt, the chain's only change)");
  assertEq(result.additions, 1, "the one file folded its single line");
  assertEq(result.deletions, 0, "nothing deleted");
  // git's uncapped oracle: 2002 in-window non-merge first-parent commits —
  // the cap is OURS, flagged honestly
  const uncapped = revListCount(CAPS, ["--no-merges", "--first-parent", "main"], since);
  assertEq(uncapped, 2002, "git's uncapped rev-list count");
});

await check(8, "the TTL: fresh-stamped cache honored (bogus comes back), past-TTL entry recomputes (real numbers + rewritten stamp)", async () => {
  const { t, cell, ACTIVITY_STATS_TTL_MS } = await makeCell(TIMELINE);
  assertEq(ACTIVITY_STATS_TTL_MS, 10 * 60 * 1000, "the constant is the 10-minute family freshness");
  const real = await cell.activityStats("main", "yearly"); // populates the cache
  // the cached row carries a computedAt stamp within seconds of now
  const row1 = t.sql.db.prepare(`SELECT data FROM stats_cache WHERE period = 'act:yearly'`).get();
  assert(row1, "the act: cache row exists");
  const stamp1 = JSON.parse(row1.data).computedAt;
  assert(Number.isFinite(stamp1) && Math.abs(Date.now() - stamp1) < 5000, `the stamp is fresh, got ${stamp1}`);
  // WITHIN TTL: the cache is honored — fresh-stamped bogus numbers come back
  const bogusFresh = { ...real, authorCount: 999, commitCount: 888, computedAt: Date.now() };
  t.sql.db.prepare(`UPDATE stats_cache SET data = ? WHERE period = 'act:yearly'`).run(JSON.stringify(bogusFresh));
  const honored = await cell.activityStats("main", "yearly");
  assertEq(honored.authorCount, 999, "within TTL the cached answer is served as-is");
  assertEq(honored.commitCount, 888, "within TTL the cached answer is served as-is");
  // PAST TTL: the entry recomputes — the real numbers come back, and the
  // row is REWRITTEN with a fresh stamp (INSERT OR REPLACE)
  const bogusStale = { ...real, authorCount: 777, commitCount: 666, computedAt: Date.now() - ACTIVITY_STATS_TTL_MS - 60000 };
  t.sql.db.prepare(`UPDATE stats_cache SET data = ? WHERE period = 'act:yearly'`).run(JSON.stringify(bogusStale));
  const recomputed = await cell.activityStats("main", "yearly");
  assertEq(recomputed.authorCount, real.authorCount, "past TTL the real answer recomputes");
  assertEq(recomputed.commitCount, real.commitCount, "past TTL the real answer recomputes");
  const row2 = t.sql.db.prepare(`SELECT data FROM stats_cache WHERE period = 'act:yearly'`).get();
  const stamp2 = JSON.parse(row2.data).computedAt;
  assert(Number.isFinite(stamp2) && Math.abs(Date.now() - stamp2) < 5000, `the rewrite stamped fresh, got ${stamp2}`);
  assertEq(JSON.parse(row2.data).authorCount, real.authorCount, "the rewrite carries the real fold");
});

await check(9, "null arms: unresolvable ref, empty repo; a raw oid ref equals the branch answer", async () => {
  const { cell } = await makeCell(TIMELINE);
  assertEq(await cell.activityStats("nosuchbranch", "yearly"), null, "unresolvable ref");
  const byBranch = await cell.activityStats("main", "yearly");
  const byOid = await cell.activityStats(TIMELINE_TIP, "yearly");
  assertEq(JSON.stringify(byOid), JSON.stringify(byBranch), "oid ref === branch ref, field for field");
  const emptyDir = scratchDir("act-empty-");
  git(emptyDir, "init -q -b main");
  const { cell: emptyCell } = await makeCell(emptyDir);
  assertEq(await emptyCell.activityStats(undefined, "weekly"), null, "empty repo");
});

await check(10, "static tripwire: rpcBind + withContentLease + the budget constants; the shape omits commitCountInAllBranches", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async activityStats(ref?"), src.indexOf("/** The content methods over HTTP."));
  assert(body.length > 0, "the activityStats method found");
  assert(body.includes("this.rpcBind()"), "rpcBind first");
  assert(body.includes("this.withContentLease"), "the read-RPC lease wrapper");
  assert(body.includes("activityPeriodOrDefault"), "the period normalization rides the boundary");
  const fold = src.slice(src.indexOf("private async computeActivityStats"), src.indexOf("private async statsPage"));
  assert(fold.length > 0, "the fold found");
  assert(fold.includes("MAX_STATS_SCAN"), "the walk budget is the existing stats constant");
  assert(fold.includes("ACTIVITY_STATS_TTL_MS"), "the TTL constant gates cache hits");
  assert(fold.includes("ACTIVITY_CACHE_PREFIX"), "the act: key prefix namespaces the family");
  assert(fold.includes("computeDiff"), "the add/del fold rides computeDiff");
  assert(src.includes("export interface ActivityStatsResult"), "ActivityStatsResult declared on repo.ts");
  // the ratified omission: NO commitCountInAllBranches FIELD on the result
  // (docstrings may cite upstream's field; the shape must not declare one)
  const iface = src.slice(src.indexOf("export interface ActivityStatsResult"), src.indexOf("type ActivityStatsAgg"));
  assert(!/commitCountInAllBranches\s*:/.test(iface), "commitCountInAllBranches is omitted in v1 (ratified Open question 2)");
  assert(!/commitCountInAllBranches\s*:/.test(body), "the boundary method builds no commitCountInAllBranches");
  // NOTE: the mod.ts re-export (`ActivityStatsResult` on the package
  // boundary) folds into the combined landing — mod.ts is a sibling wave's
  // file; dist-types/repo.d.ts (generated by typecheck) carries the
  // boundary declaration this unit owns.
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  if (!mod.includes("ActivityStatsResult")) console.log("      note: mod.ts ActivityStatsResult re-export pending the combined landing (dist-types/repo.d.ts carries it)");
});

console.log(`\ncheck-activity-stats: ${planned - failed}/${planned} checks passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
