// contributorStats RPC gate — SPEC-0015 §3.2 M2b (the census R15 boundary:
// upstream's `GET .../{contributors|code-frequency|recent-commits}/data`, all
// three mounting GetContributorStats). Run with tsx (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-contributor-stats.mjs
// Exits non-zero on any failed check.
//
// What makes this honest: the RPC is the REAL RepoCell.contributorStats over a
// real GitStore (node:sqlite) seeded from REAL git fixtures, and the ORACLE
// for every ordinary (non-budget) run is real `git log` over the same fixture
// — the exact command upstream generateContributorStats builds
// (contributors_graph.go:119: `git log --shortstat --no-merges
// --pretty=format:---%n%aN%n%aE%n%as --reverse <revision>`) folded by a
// faithful port of upstream's own generator (contributors_graph.go:217-262:
// lowercased-email keying — upstream's GetUserByEmail PRIMARY-email merge is
// DOWNSTREAM for us — the empty-email skip at :223-226, the Sunday bucket
// through findLastSundayBeforeDate + UnixMilli at :61-73/:258-261). The
// oracle's bucket math is deliberately INDEPENDENT of the engine's: it reads
// git's already-localized `%as` date-only string and anchors it in UTC, where
// the engine reconstructs the same calendar date from the commit's epoch +
// recorded tz offset — if either side mishandles a timezone, check 1's
// load-bearing arms fail.
//
// The full-history shape is pinned against M2a's differential: the SAME
// timeline fixture check-activity-stats.mjs uses (side-branch commit c4
// reachable ONLY through the merge) folds carol's side work HERE — activityStats'
// first-parent fold never saw it — while the merge itself still never folds.
//
// Pinned divergences (ledger-ready, per SPEC §3.2 — the M2a family's):
//   - no rename detection: upstream's contributors command rides git's default
//     diff.renames and counts a rename as ONE file with the line DELTA; our
//     fold diffs trees by path (computeDiff), so a rename folds as full
//     delete+add. The oracle runs `--no-renames` to mirror; check 4 proves the
//     choice is load-bearing (the renames-enabled oracle answers differently).
//   - honest caps: upstream walks uncapped; ours caps at MAX_STATS_SCAN and
//     flags `truncated` (the blame budget-exit rule). Check 6 pins against
//     git's UNCAPPED rev-list count.
//   - per-commit diff budgets: binary and MAX_DIFF_BLOB-over files contribute
//     0/0 (what --shortstat's totals show for them); a commit past
//     MAX_DIFF_FILES folds its first 100 paths.
//   - EMPTY commits: upstream's blind 4-line scan skips a commit that has no
//     shortstat line (its stats read hits the blank, the warn-skip fires);
//     ours folds it 0/0 with commits++ — no oracle-checked fixture carries
//     one.
//   - no `"total"` pseudo-entry in the engine answer (downstream assembles it
//     over D1 with the login/avatar decorations — SPEC §3.2's split); no
//     cache TTL (immutable-tip key, the store.ts immutability rule — the 10
//     minute upstream freshness is a population concern, the TTL contract
//     stays the windowed `act:` arm's).
//   - no async generation / no 202 ErrAwaitGeneration: synchronous-with-
//     budget (ratified Open question 3 — no pre-warm).
//
// Covers, in order:
//   1.  Sunday bucket math over fixed calendar dates: a five-commit fixture
//       whose author dates pin the Sunday-edge (a commit ON a Sunday buckets
//       to ITSELF — Go's daysToSubtract is 0), a mid-week commit, and TWO
//       load-bearing timezone arms (a -0530 commit whose UTC instant is a
//       Sunday yet buckets to its own zone's Saturday-week; a +0900 Sunday-
//       morning commit whose UTC instant is the PREVIOUS Saturday) — ours
//       equals both the hard calendar expectations and the git oracle.
//   2.  the timeline fixture: the full contributors map deep-equals the
//       git-oracle aggregation, field for field (weeks records, totals).
//   3.  merge + full-history, structurally: the merge costs the walk a step
//       (count 7) but no fold (its git-verified NONZERO first-parent shortstat
//       never lands, no 4th contributor); the side-branch commit reachable
//       ONLY through the merge IS folded (carol totalCommits 2 — the
//       full-history differential vs activityStats) and her side.txt lines
//       arrive through her own commit, not the merge.
//   4.  the rename pin: ours equals the --no-renames oracle; the
//       renames-ENABLED oracle answers differently (the choice is load-
//       bearing, the M2a check-4 idiom).
//   5.  the empty-email skip: a fast-import fixture with a `<>`-ident commit —
//       ONE contributor, the empty-email commit's lines and count never land.
//   6.  the cap: a 2002-commit fixture answers count === 2000,
//       totalCommits === 2000, truncated === true, one author, one bucket,
//       against git's uncapped rev-list 2002.
//   7.  the cache: immutable-tip hit honored — a bogus row WITHOUT any stamp
//       comes back (there is no TTL to age past, the no-TTL discipline);
//       a miss recomputes and rewrites; a different tip (main~3) answers its
//       own fold (no cross-contamination); the persisted row carries NO
//       computedAt (structural).
//   8.  null arms: unresolvable ref, empty repo; a raw oid ref equals the
//       branch answer.
//   9.  shape pins: lowercased map keys; every weeks entry carries `week` ===
//       its numeric key (JSON map keys are strings — the charts read the
//       VALUE's .week, RepoContributors.vue/RepoCodeFrequency.vue); NO
//       "total" key (downstream assembles it); the top-level field set is
//       exactly {contributors, count, truncated}.
//   10. static tripwire (the check-grep.mjs convention): the RPC rides
//       rpcBind + withContentLease + resolveRef/peelToCommit, the fold names
//       walkLog + MAX_STATS_SCAN + CONTRIBUTOR_CACHE_KEY + computeDiff +
//       contributorWeekMs, the fold consults NO TTL constant and stamps NO
//       computedAt, and ContributorStatsResult is declared on repo.ts.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-activity-stats.mjs).
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

// ---- the real cell over a real store (check-activity-stats.mjs's shape) -------

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

// ---- fixture: the week-bucket arms (check 1) -----------------------------------
// 2026-03-01 is a Sunday. Five commits, one author, distinct addition counts
// so any mis-bucketing shows in the sums:
//   b1 Sun 2026-03-01 14:00 +0000  → bucket Sun 03-01 (ON the Sunday: ITSELF)
//   b2 Wed 2026-03-04 10:00 +0000  → bucket Sun 03-01
//   b3 Sat 2026-03-07 22:30 -0530  → bucket Sun 03-01 (UTC instant is Sun
//                                     03-08 04:00Z — the commit's OWN zone
//                                     decides, load-bearing)
//   b4 Sun 2026-03-08 03:00 +0900  → bucket Sun 03-08 (UTC instant is Sat
//                                     03-07 18:00Z — again the zone decides)
//   b5 Mon 2026-03-09 00:30 +0000  → bucket Sun 03-08
function buildWeekFixture() {
  const dir = scratchDir("contrib-weeks-");
  git(dir, "init -q -b main");
  const files = { b1: 3, b2: 5, b3: 7, b4: 2, b5: 4 };
  const dates = {
    b1: "2026-03-01T14:00:00+00:00",
    b2: "2026-03-04T10:00:00+00:00",
    b3: "2026-03-07T22:30:00-05:30",
    b4: "2026-03-08T03:00:00+09:00",
    b5: "2026-03-09T00:30:00+00:00",
  };
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.txt`), Array.from({ length: lines }, (_, i) => `${name} line ${i}\n`).join(""));
    git(dir, "add -A");
    git(dir, `commit -qm "${name}"`, {
      GIT_AUTHOR_DATE: dates[name],
      GIT_COMMITTER_DATE: dates[name],
      GIT_AUTHOR_NAME: "Bucketer",
      GIT_AUTHOR_EMAIL: "bucketer@example.com",
      GIT_COMMITTER_NAME: "Bucketer",
      GIT_COMMITTER_EMAIL: "bucketer@example.com",
    });
  }
  return dir;
}

// ---- fixture: the timeline (checks 2-4, 7-9) ------------------------------------
// The SAME shape as check-activity-stats.mjs's timeline so the full-history
// differential is apples-to-apples: c1 ← c2 ← c3 ← M(merge) ← c6 ← c7 on
// main, c4 on a side branch off c1 reachable ONLY through M's second parent.
function buildTimelineFixture() {
  const dir = scratchDir("contrib-timeline-");
  git(dir, "init -q -b main");
  const at = (d) => ({
    GIT_AUTHOR_DATE: d,
    GIT_COMMITTER_DATE: d,
  });
  const as = (name, email, env) => ({ ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nroot\n");
  writeFileSync(join(dir, "src/a.ts"), "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c1 root"`, as("Alice", "alice@example.com", at("2026-03-01T10:00:00+00:00")));
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nrooted\nprime one\nprime two\nprime three\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c2 readme edits"`, as("Alice Prime", "ALICE@EXAMPLE.COM", at("2026-03-02T10:00:00+00:00")));
  writeFileSync(join(dir, "src/bob.ts"), "b1\nb2\nb3\nb4\nb5\n");
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nrooted\nprime one\nprime two\nprime three\nbob one\nbob two\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c3 bob file"`, as("Bob", "bob@example.com", at("2026-03-03T10:00:00+00:00")));
  git(dir, "checkout -q -b side HEAD~2");
  writeFileSync(join(dir, "README.md"), "cf-gitea\nactivity fixture\nroot\nside change\n");
  writeFileSync(join(dir, "side.txt"), "s1\ns2\ns3\ns4\ns5\ns6\ns7\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c4 side work"`, as("Carol", "carol@example.com", at("2026-03-04T10:00:00+00:00")));
  git(dir, "checkout -q main");
  try {
    execSync(`git -C ${dir} merge --no-ff --no-commit side`, { stdio: "ignore" });
  } catch {
    // the README conflict — expected
  }
  writeFileSync(
    join(dir, "README.md"),
    "cf-gitea\nactivity fixture\nrooted\nprime one\nprime two\nprime three\nbob one\nbob two\nside change\nmerged resolution\n"
  );
  git(dir, "add -A");
  git(dir, `commit -qm "c5 merge side (conflict resolved)"`, as("Alice Prime", "alice@example.com", at("2026-03-05T10:00:00+00:00")));
  git(dir, "mv src/a.ts src/a-renamed.ts");
  writeFileSync(join(dir, "src/a-renamed.ts"), "a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\na11\n");
  writeFileSync(join(dir, "src/bob.ts"), "b1\nb2 prime\nb3\nb4\nb5\n");
  git(dir, "add -A");
  git(dir, `commit -qm "c6 rename a + edit bob"`, as("Bob B", "BOB@EXAMPLE.COM", at("2026-03-06T10:00:00+00:00")));
  writeFileSync(join(dir, "logo.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00]));
  git(dir, "rm -q src/bob.ts");
  git(dir, "add -A");
  git(dir, `commit -qm "c7 binary + delete"`, as("Carol C", "carol@example.com", at("2026-03-07T10:00:00+00:00")));
  return dir;
}

// ---- fixture: the empty-email arm (check 5, fast-import — git refuses to
// WRITE an empty ident through the normal commit path) ---------------------------
function buildEmptyEmailFixture() {
  const dir = scratchDir("contrib-emptyemail-");
  git(dir, "init -q -b main");
  const sun1 = Math.floor(Date.UTC(2026, 2, 1) / 1000); // 2026-03-01 00:00Z, a Sunday
  const lines = [];
  const blobMarks = [];
  let nextMark = 1;
  for (const body of ["f1 one\n", "f2 one\nf2 two\n", "f3 one\nf3 two\n"]) {
    lines.push("blob", `mark :${nextMark}`, `data ${Buffer.byteLength(body)}`, body);
    blobMarks.push(nextMark);
    nextMark++;
  }
  const commit = (mark, fileNo, authorIdent, t) =>
    lines.push(
      "commit refs/heads/main",
      `author ${authorIdent} ${t} +0000`,
      `committer A <a@t> ${t} +0000`,
      "data 1\n.",
      `M 100644 :${mark} f${fileNo}.txt`
    );
  commit(blobMarks[0], 1, "A <a@t>", sun1 + 3600);
  commit(blobMarks[1], 2, "NoBody <>", sun1 + 7200); // the empty-email commit (+2 lines)
  commit(blobMarks[2], 3, "A <a@t>", sun1 + 3 * 3600);
  execSync("git fast-import --quiet", {
    cwd: dir,
    input: lines.join("\n"),
    stdio: ["pipe", "ignore", "inherit"],
  });
  return dir;
}

// ---- fixture: the 2002-commit cap (check 6, one fast-import stream) -------------
// Same trick as check-activity-stats.mjs's caps fixture: all commits the same
// (empty) tree except the TIP, which adds w.txt; every author date sits on
// Tue 2026-10-27 (base + i*30s spans ~16.7h, never leaving the day), so the
// whole walked prefix buckets to ONE Sunday (2026-10-25).
function buildCapsFixture(n) {
  const dir = scratchDir("contrib-caps-");
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
      `author T <t@t> ${t} +0000`,
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

const WEEK = buildWeekFixture();
const TIMELINE = buildTimelineFixture();
const TIMELINE_TIP = commitOid(TIMELINE, "main");
const EMPTYMAIL = buildEmptyEmailFixture();
const CAPS = buildCapsFixture(2002);
const SUN1 = Date.UTC(2026, 2, 1); // 2026-03-01, a Sunday
const SUN8 = Date.UTC(2026, 2, 8); // 2026-03-08, the next Sunday

// ---- the real-git oracle --------------------------------------------------------

/** `git log` raw stdout; throws with git's stderr on a bad invocation. */
function gitLogRaw(dir, args) {
  const quoted = args.map((a) => JSON.stringify(a)).join(" ");
  return execSync(`git -C ${dir} log ${quoted}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
}

/** The Sunday bucket from git's `%as` date-only STRING — deliberately
 *  INDEPENDENT of the engine's epoch+tz arithmetic: git has already rendered
 *  the calendar date in the commit's recorded timezone, so the oracle parses
 *  it straight as UTC midnight (Go time.Parse with time.DateOnly) and anchors
 *  back with `getUTCDay()` (0 = Sunday; Go's daysToSubtract = int(weekday) −
 *  int(time.Sunday) is the weekday itself, its negative branch dead — a
 *  Sunday dates to ITSELF). */
function oracleWeekMs(asDateStr) {
  const d = new Date(`${asDateStr}T00:00:00Z`);
  return d.getTime() - d.getUTCDay() * 86400000;
}

/** The upstream aggregation: generateContributorStats' exact walk
 *  (contributors_graph.go:119) plus `--no-renames` (the pinned divergence —
 *  our fold has no rename detection), folded by a faithful port of upstream's
 *  generator (:217-262): `---`-separated commits read 4-lines-blind, the
 *  shortstat totals split on commas with the insertion/deletion prefix check,
 *  the empty-email skip, the per-email first-seen name (the `--reverse` walk
 *  makes that the OLDEST commit's name), Sunday-bucketed add/del/commits.
 *  Keying is lowercased-email — upstream's GetUserByEmail PRIMARY-email merge
 *  is DOWNSTREAM for us. */
function gitContributorOracle(dir, branch, opts = {}) {
  const flags = opts.renames ? [] : ["--no-renames"];
  const out = gitLogRaw(dir, [
    "--shortstat",
    "--no-merges",
    ...flags,
    "--reverse",
    "--pretty=format:---%n%aN%n%aE%n%as",
    branch,
  ]);
  const contributors = {};
  let p = 0;
  let name = "";
  let email = "";
  let date = "";
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    if (l === "---") {
      p = 1;
    } else if (p === 0) {
      continue;
    } else if (p === 1) {
      name = l;
      p = 2;
    } else if (p === 2) {
      email = l;
      p = 3;
    } else if (p === 3) {
      date = l;
      p = 4;
    } else if (p === 4) {
      p = 0; // stats consumed; the trailing blank is ignored on the next scan
      let additions = 0;
      let deletions = 0;
      for (const field of l.split(",").slice(1)) {
        const parts = field.trim().split(" ");
        const amount = parseInt(parts[0], 10);
        if (parts[1].startsWith("insertion")) additions = amount;
        else deletions = amount;
      }
      if (email === "") continue; // contributors_graph.go:223-226
      const key = email.toLowerCase();
      if (!contributors[key]) contributors[key] = { name, email: key, totalCommits: 0, weeks: {} };
      const a = contributors[key];
      const week = oracleWeekMs(date);
      const w = a.weeks[week] ?? (a.weeks[week] = { week, additions: 0, deletions: 0, commits: 0 });
      w.additions += additions;
      w.deletions += deletions;
      w.commits++;
      a.totalCommits++;
    }
  }
  return contributors;
}

/** Deep-compare with SORTED keys (ours builds the map in reversed-walk
 *  first-seen order, the oracle in --reverse output order — same for these
 *  fixtures, but the comparison must not depend on it). */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort((a, b) => (Number(a) - Number(b)) || (a < b ? -1 : 1))) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

// ---- the checks -----------------------------------------------------------------

await check(1, "Sunday bucket math: fixed-calendar expectations AND the git oracle agree, incl. the Sunday self-bucket edge and BOTH timezone arms", async () => {
  const { cell } = await makeCell(WEEK);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  assertEq(result.truncated, false, "a 5-commit walk never truncates");
  assertEq(result.count, 5, "five commits walked");
  const b = result.contributors["bucketer@example.com"];
  assert(b, "the single author keyed by the lowercased email");
  assertEq(b.totalCommits, 5, "all five commits counted");
  assertEq(b.name, "Bucketer", "the git author name");
  // the hard calendar pins: 3 commits land on the 03-01 Sunday bucket —
  // including b1 which IS on a Sunday (self-bucket) and b3 whose UTC instant
  // is Sunday 03-08 04:00Z but whose -0530 zone says Saturday 03-07 — and 2
  // on the 03-08 bucket, including b4 whose UTC instant is SATURDAY 03-07
  // 18:00Z but whose +0900 zone says Sunday 03-08 (a UTC-naive engine puts
  // b3 in the 03-08 bucket and b4 in the 03-01 bucket — both sums break)
  assertEq(b.weeks, {
    [SUN1]: { week: SUN1, additions: 3 + 5 + 7, deletions: 0, commits: 3 },
    [SUN8]: { week: SUN8, additions: 2 + 4, deletions: 0, commits: 2 },
  });
  // and the independent git oracle (reading git's own %as strings) agrees
  assertEq(canon(result.contributors), canon(gitContributorOracle(WEEK, "main")));
});

await check(2, "timeline: the full contributors map deep-equals the git oracle (weeks, totals, names)", async () => {
  const { cell } = await makeCell(TIMELINE);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  assertEq(result.truncated, false, "a 7-commit walk never truncates");
  assertEq(canon(result.contributors), canon(gitContributorOracle(TIMELINE, "main")));
  // the surviving names are the OLDEST commit's per email (upstream walks
  // --reverse so first-seen = oldest — the OPPOSITE of the pulse fold's
  // newest-name precedence): "Alice" not "Alice Prime", "Bob" not "Bob B",
  // "Carol" not "Carol C"
  assertEq(result.contributors["alice@example.com"].name, "Alice");
  assertEq(result.contributors["bob@example.com"].name, "Bob");
  assertEq(result.contributors["carol@example.com"].name, "Carol");
});

await check(3, "merge + full-history, structurally: the merge costs a step but never folds; the merge-only-reachable side commit IS folded", async () => {
  const { cell } = await makeCell(TIMELINE);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  // 7 reachable commits stepped (the merge included), 6 folded
  assertEq(result.count, 7, "the walk stepped all reachable commits (the merge included)");
  assertEq(Object.keys(result.contributors).length, 3, "three distinct emails (the merge is not a 4th)");
  assertEq(result.contributors["alice@example.com"].totalCommits, 2, "alice: c1+c2 (the merge never counted)");
  // FULL-HISTORY differential vs activityStats (the M2a check-3 mirror): c4
  // sits on the side branch OFF the first-parent chain — activityStats never
  // saw it (its changedFiles excluded side.txt) — but the contributors walk
  // is every-parent, so carol folds c4 AND c7
  assertEq(result.contributors["carol@example.com"].totalCommits, 2, "carol: the side-branch c4 AND the chain's c7");
  // carol's bucket: c4's diff vs c1 is README +1 and side.txt +7 (8); c7's is
  // binary +0 and bob.ts delete -5 — the +7 PROVES side.txt's lines arrived
  // through carol's OWN commit, never through the merge's tree
  assertEq(result.contributors["carol@example.com"].weeks[SUN1], { week: SUN1, additions: 8, deletions: 5, commits: 2 });
  // the merge's own first-parent net change is NONZERO (git-verified) — so
  // "the merge contributed nothing" is the --no-merges exclusion, never a
  // vacuous empty diff
  const mergeOid = execSync(`git -C ${TIMELINE} rev-parse main~2`, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
  const shortstat = execSync(`git -C ${TIMELINE} diff --shortstat ${mergeOid}^1 ${mergeOid}`, {
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();
  const m = /(\d+) insertions?\(\+\)/.exec(shortstat);
  assert(m && parseInt(m[1], 10) > 0, `the merge's first-parent diff is nonzero, got ${JSON.stringify(shortstat)}`);
  // and the whole answer still equals the oracle (which also walks full
  // history with --no-merges)
  assertEq(canon(result.contributors), canon(gitContributorOracle(TIMELINE, "main")));
});

await check(4, "the rename pin is load-bearing: ours === the --no-renames oracle; the renames-ENABLED oracle differs", async () => {
  const { cell } = await makeCell(TIMELINE);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  const oracle = gitContributorOracle(TIMELINE, "main");
  assertEq(canon(result.contributors), canon(oracle), "ours === --no-renames oracle");
  // c6 renames AND edits a.ts: with rename detection git counts ONE file with
  // the line delta; our path-keyed fold counts a full delete+add — the
  // fixture must make the two oracles genuinely differ
  const renames = gitContributorOracle(TIMELINE, "main", { renames: true });
  const sum = (cs) =>
    Object.values(cs).reduce((acc, a) => {
      for (const w of Object.values(a.weeks)) {
        acc.add += w.additions;
        acc.del += w.deletions;
      }
      return acc;
    }, { add: 0, del: 0 });
  assert(
    sum(renames).add !== sum(oracle).add || sum(renames).del !== sum(oracle).del,
    `the rename must move the totals (no-renames ${JSON.stringify(sum(oracle))} vs renames ${JSON.stringify(sum(renames))})`
  );
});

await check(5, "the empty-email skip: a `<>`-ident commit contributes nothing (no phantom key, no lines, no count)", async () => {
  const { cell } = await makeCell(EMPTYMAIL);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  assertEq(result.count, 3, "all three commits walked (the skip is in the FOLD, not the walk)");
  assertEq(Object.keys(result.contributors), ["a@t"], "exactly one contributor — no empty-string key");
  const a = result.contributors["a@t"];
  assertEq(a.totalCommits, 2, "the empty-email commit never counted");
  assertEq(a.weeks[SUN1], { week: SUN1, additions: 1 + 2, deletions: 0, commits: 2 }, "the +2 lines of the empty-email commit never landed");
  // and the oracle (upstream's own :223-226 skip) agrees
  assertEq(canon(result.contributors), canon(gitContributorOracle(EMPTYMAIL, "main")));
});

await check(6, "the cap: 2002 commits answer count 2000, totalCommits 2000, truncated true — against git's uncapped 2002", async () => {
  const { cell } = await makeCell(CAPS);
  const result = await cell.contributorStats("main");
  assert(result !== null, "capped run answered");
  assertEq(result.truncated, true, "the cap cut older history — flagged");
  assertEq(result.count, 2000, "count froze at MAX_STATS_SCAN");
  const t = result.contributors["t@t"];
  assert(t, "one author");
  assertEq(t.totalCommits, 2000, "totalCommits froze at the cap (the NEWEST 2000 — the tip's w.txt is inside)");
  const weeks = Object.values(t.weeks);
  assertEq(weeks.length, 1, "every walked commit sits in one Sunday bucket (Tue 2026-10-27 → Sun 2026-10-25)");
  assertEq(weeks[0], { week: Date.UTC(2026, 9, 25), additions: 1, deletions: 0, commits: 2000 }, "the bucket: the tip's single line, nothing else");
  // git's uncapped oracle: the cap is OURS, flagged honestly
  const uncapped = parseInt(
    execSync(`git -C ${CAPS} rev-list --count --no-merges main`, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim(),
    10
  );
  assertEq(uncapped, 2002, "git's uncapped rev-list count");
});

await check(7, "the cache: immutable-tip hit honored with NO TTL (a stampless bogus row comes back), a miss recomputes, another tip never cross-contaminates", async () => {
  const { t, cell } = await makeCell(TIMELINE);
  const real = await cell.contributorStats("main"); // populates the cache
  const row1 = t.sql.db.prepare(`SELECT data FROM stats_cache WHERE period = 'contrib'`).get();
  assert(row1, "the contrib cache row exists");
  const parsed1 = JSON.parse(row1.data);
  assert(!("computedAt" in parsed1), "the row carries NO computedAt stamp (no-TTL discipline — structural)");
  // WITHIN the same runtime, with NO freshness stamp at all: the cache is
  // honored — the immutable-tip argument, NOT an age check, is what makes the
  // hit safe
  const bogus = { contributors: { "bogus@example.com": { name: "Bogus", email: "bogus@example.com", totalCommits: 999, weeks: {} } }, count: 99, truncated: true };
  t.sql.db.prepare(`UPDATE stats_cache SET data = ? WHERE period = 'contrib'`).run(JSON.stringify(bogus));
  const honored = await cell.contributorStats("main");
  assertEq(canon(honored), canon(bogus), "the cached answer is served as-is, regardless of age");
  // a DIFFERENT tip (an older commit's oid — main~3 = c3, a 3-commit history;
  // resolveRef speaks branch/tag/oid, not rev ~N syntax, so resolve via git)
  // answers its OWN fold — keyed by oid, never by ref name
  const olderTip = execSync(`git -C ${TIMELINE} rev-parse main~3`, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
  const older = await cell.contributorStats(olderTip);
  assert(older !== null && !older.contributors["carol@example.com"], "main~3's history has no carol");
  assertEq(older.count, 3, "main~3 walked its own 3-commit history");
  assertEq(await cell.contributorStats("main"), honored, "the tip's row untouched by the other tip's compute");
  // a MISS recomputes: delete the row, the real numbers return and rewrite
  t.sql.db.prepare(`DELETE FROM stats_cache WHERE period = 'contrib'`).run();
  const recomputed = await cell.contributorStats("main");
  assertEq(canon(recomputed), canon(real), "the miss recomputed the real fold");
  const row2 = t.sql.db.prepare(`SELECT data FROM stats_cache WHERE period = 'contrib'`).get();
  assertEq(canon(JSON.parse(row2.data)), canon(real), "the rewrite carries the real fold");
});

await check(8, "null arms: unresolvable ref, empty repo; a raw oid ref equals the branch answer", async () => {
  const { cell } = await makeCell(TIMELINE);
  assertEq(await cell.contributorStats("nosuchbranch"), null, "unresolvable ref");
  const byBranch = await cell.contributorStats("main");
  const byOid = await cell.contributorStats(TIMELINE_TIP);
  assertEq(canon(byOid), canon(byBranch), "oid ref === branch ref, field for field");
  const emptyDir = scratchDir("contrib-empty-");
  git(emptyDir, "init -q -b main");
  const { cell: emptyCell } = await makeCell(emptyDir);
  assertEq(await emptyCell.contributorStats(undefined), null, "empty repo");
});

await check(9, "shape pins: lowercased keys, weeks values carry their own `week` === the key, no \"total\" entry, exact top-level field set", async () => {
  const { cell } = await makeCell(TIMELINE);
  const result = await cell.contributorStats("main");
  assert(result !== null, "contributorStats answered");
  for (const [key, author] of Object.entries(result.contributors)) {
    assertEq(key, key.toLowerCase(), `the map key is lowercased (${key})`);
    assertEq(author.email, key, "the entry's email is its key");
    for (const [k, w] of Object.entries(author.weeks)) {
      assertEq(String(w.week), k, "each weeks VALUE carries `week` === its numeric key (the charts read the value — JSON keys are strings)");
      assertEq(typeof w.additions, "number", "additions is a number");
      assertEq(typeof w.deletions, "number", "deletions is a number");
      assertEq(typeof w.commits, "number", "commits is a number");
    }
    assertEq(typeof author.totalCommits, "number", "totalCommits is a number");
  }
  assert(!("total" in result.contributors), "NO \"total\" pseudo-entry — downstream assembles it (SPEC §3.2's split)");
  assertEq(Object.keys(result).sort(), ["contributors", "count", "truncated"], "the top-level field set is exactly the SPEC shape (no ref/commit, no computedAt)");
});

await check(10, "static tripwire: rpcBind + withContentLease + resolveRef/peelToCommit; the fold names its budget, cache key, diff and bucket helpers; NO TTL, NO stamp, NO total", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async contributorStats(ref?"), src.indexOf("/** The content methods over HTTP."));
  assert(body.length > 0, "the contributorStats method found");
  assert(body.includes("this.rpcBind()"), "rpcBind first");
  assert(body.includes("this.withContentLease"), "the read-RPC lease wrapper");
  assert(body.includes("resolveRef"), "the ref ladder");
  assert(body.includes("peelToCommit"), "the tip peel");
  const fold = src.slice(src.indexOf("private async computeContributorStats"), src.indexOf("private async statsPage"));
  assert(fold.length > 0, "the fold found");
  assert(fold.includes("walkLog"), "the walk rides the shared frontier (full history, all parents)");
  assert(fold.includes("MAX_STATS_SCAN"), "the walk budget is the existing stats constant");
  assert(fold.includes("CONTRIBUTOR_CACHE_KEY"), "the contrib key namespaces the family");
  assert(fold.includes("computeDiff"), "the add/del fold rides computeDiff");
  assert(fold.includes("contributorWeekMs"), "the bucket math is the named helper");
  assert(!fold.includes("ACTIVITY_STATS_TTL_MS"), "the fold consults NO TTL constant (immutable-tip rule)");
  assert(!fold.includes("computedAt"), "the fold stamps NO computedAt (no-TTL discipline)");
  assert(!/["']total["']\s*:/.test(fold), "the fold builds NO \"total\" pseudo-entry (downstream's job)");
  assert(src.includes("export interface ContributorStatsResult"), "ContributorStatsResult declared on repo.ts");
  // NOTE: the mod.ts re-export (`ContributorStatsResult` on the package
  // boundary) folds into the combined landing — mod.ts is a sibling wave's
  // file; dist-types/repo.d.ts (generated by typecheck) carries the
  // boundary declaration this unit owns (the M2a precedent, verbatim).
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  if (!mod.includes("ContributorStatsResult")) console.log("      note: mod.ts ContributorStatsResult re-export pending the combined landing (dist-types/repo.d.ts carries it)");
});

console.log(`\ncheck-contributor-stats: ${planned - failed}/${planned} checks passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
