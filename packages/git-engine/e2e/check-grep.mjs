// grep RPC gate — SPEC-0015 §3.1 M1 (the census R10 boundary: upstream's
// `GET .../search` page data on the non-indexed gitgrep fallback path, the
// upstream-DEFAULT posture — setting.Indexer.RepoIndexerEnabled defaults
// false, modules/setting/indexer.go:43). Run with tsx (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-grep.mjs
// Exits non-zero on any failed check.
//
// What makes this honest: the RPC is the REAL RepoCell.grep over a real
// GitStore (node:sqlite) seeded from REAL git fixtures, and the ORACLE for
// every ordinary (non-budget) run is real `git grep` against the same
// fixture — same flags upstream's grep.go builds per mode (grep.go:61-72:
// exact = --fixed-strings; words = --fixed-strings --ignore-case with one
// expression per whitespace word, all --and'ed — verified PER-LINE in git,
// not per-file; regexp = --perl-regexp, where git needs PCRE support). The
// three budget fixtures (the 50-result cap, the 2000-file cap, the
// scan-step cap) are pinned against git's uncapped listings; the regexp
// budget is pinned structurally (a pattern that backtracks ~2^n under
// native JS RegExp answers linearly under ours) because git's PCRE carries
// its own internal match limits that a plain oracle diff cannot compare.
//
// Pinned divergences (ledger-ready, per SPEC §2.1/§3.1):
//   - binary blobs: upstream's parser emits an empty-lines block per binary
//     hit ("Binary file" lines carry no \x00 and are dropped, grep.go); ours
//     skips the file entirely (the blame isBinary idiom) — the text-only
//     file set is diffed against `git grep -I`.
//   - match lines only: upstream collects --context 1 lines too; ours
//     returns match lines only (byte-cheap; the page renders match lines).
//   - honest totals: upstream caps results SILENTLY at 50 (grep.go:77 +
//     CancelPipeline at :109, total = the capped count); ours caps `results`
//     at 50 but reports `total` as far as the scan counted and flags
//     `truncated` on every budget exit.
//
// Covers, in order:
//   1.  exact mode: per-file/line oracle diff vs `git grep -n -F`, all three
//       case pins (engine / Engine / ENGINE), ref + commit fields.
//   2.  words mode: the per-line --and oracle (a line must carry ALL words;
//       words on different lines never match), case-insensitive, and the
//       absent-mode default equals words.
//   3.  regexp mode: per-file/line oracle diffs vs `git grep -n -P`
//       (classes, anchors, alternation), plus compile-failure nulls
//       (unbalanced group, backreference, lookahead).
//   4.  the path-prefix filter: equals the full run sliced to the prefix and
//       the `git grep -- docs` oracle; a path pointing AT a file works.
//   5.  binary + oversize skips: a NUL-bearing blob and an over
//       MAX_GREP_BLOB_BYTES blob never appear (and truncated stays false —
//       skips are not budget exits); the text-only set equals `git grep -I`.
//   6.  the 50-result cap: 60 matching files answer results.length === 50,
//       total === 60, truncated === true, and the 50 blocks are git's FIRST
//       50 in tree order (upstream would show 50/50 silently).
//   7.  the files cap (MAX_GREP_FILES): a 2001-file fixture answers
//       total === 2000 — counting STOPS at the cap, the 2001st file is never
//       scanned — results.length === 50, truncated === true.
//   8.  the scan-step cap: two many-line blobs (250k lines total > 200k)
//       answer truncated === true with the partial blocks kept — a
//       budget-bounded scan is flagged, never presented complete.
//   9.  the regexp budget: `(a+)+$` (catastrophic backtracking under native
//       JS RegExp, ~2^n steps) answers linearly, correctly, fast; a
//       never-matching pattern over a 350 KB single line burns the regexp
//       budget (truncated, empty results) while a words grep on the same
//       fixture stays truncated === false — the regexp budget is SEPARATE
//       from the line-scan cap.
//   10. null arms: empty/absent q, whitespace-only words query, unresolvable
//       ref, empty repo, regexp compile failures; an unknown mode falls to
//       the words default.
//   11. static tripwire (the check-blame.mjs convention): the RPC rides
//       rpcBind + withContentLease and names its budget constants.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-blame.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// ---- the real cell over a real store (check-blame.mjs's shape) ----------------

async function contentCell(t) {
  const { RepoCell } = await import("../src/repo.ts");
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = {};
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  t.store.setMeta("repo", "r0");
  return cell;
}

async function makeCell(fixtureDir) {
  const t = makeStore();
  loadGitRepoIntoStore(t, fixtureDir);
  return { t, cell: await contentCell(t) };
}

// ---- the rich fixture (checks 1-5, 10): one commit, mixed tree ----------------

function buildRichFixture() {
  const dir = scratchDir("grep-rich-");
  git(dir, "init -q -b main");
  const f = (name, content) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  f("README.md", "cf-gitea re-serves the Gitea UI on Cloudflare Workers\nthe engine speaks the git smart-HTTP protocol\n");
  f("docs/arch.md", "Engine architecture notes\nthe ENGINE is the storage heart\ngrep is budgeted\n");
  f("docs/deep/impl.md", "engine internals live here\n");
  f("src/engine.ts", 'export const engine = "the engine core";\n');
  f("src/and.txt", "alpha here\nbeta there\nalpha and beta together\n");
  f("src/plain.txt", "unrelated words\nalpha on one line\nbeta on another\n");
  writeFileSync(join(dir, "logo.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x65, 0x6e, 0x67, 0x69, 0x6e, 0x65, 0x00]));
  // over MAX_GREP_BLOB_BYTES (512 KiB): 8501 lines x 65 bytes = 552,565
  f("big.txt", "needle in a big file\n" + Array.from({ length: 8500 }, () => "x".repeat(64)).join("\n") + "\n");
  git(dir, "add -A");
  git(dir, `commit -qm "rich grep fixture"`, { GIT_COMMITTER_DATE: "2026-03-01T00:00:00", GIT_AUTHOR_DATE: "2026-03-01T00:00:00" });
  return dir;
}

const RICH = buildRichFixture();
const RICH_TIP = commitOid(RICH, "main");

// ---- the 60-file fixture (check 6: the 50-result cap) --------------------------

function buildCapsFixture(n) {
  const dir = scratchDir("grep-caps-");
  git(dir, "init -q -b main");
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `cap-${String(i).padStart(3, "0")}.md`), `hit ${i}\n`);
  git(dir, "add -A");
  git(dir, `commit -qm "${n} matching files"`);
  return dir;
}

// ---- the many-line fixture (check 8: the scan-step cap) -------------------------

function buildStepFixture() {
  const dir = scratchDir("grep-steps-");
  git(dir, "init -q -b main");
  // 250k lines total across two blobs, each under MAX_GREP_BLOB_BYTES;
  // the needle sits on line 1 of each so the collected answers stay small
  const a = "needle one\n" + Array.from({ length: 99999 }, () => "x").join("\n") + "\n";
  const b = "needle two\n" + Array.from({ length: 149999 }, () => "x").join("\n") + "\n";
  writeFileSync(join(dir, "a-lines.txt"), a);
  writeFileSync(join(dir, "b-lines.txt"), b);
  git(dir, "add -A");
  git(dir, `commit -qm "250k lines"`);
  return dir;
}

// ---- the regexp fixtures (check 9) ----------------------------------------------

function buildCatastropheFixture() {
  const dir = scratchDir("grep-catastrophe-");
  git(dir, "init -q -b main");
  // `(a+)+$` under native JS RegExp costs ~2^n on the 2000-char a-run + X
  // line (a hang); the boolean truth is fixed: pure-a lines match, the X
  // line and the greeting do not.
  writeFileSync(join(dir, "aaa.txt"), `aaa\n${"a".repeat(2000)}\n${"a".repeat(2000)}X\nhello world\n`);
  git(dir, "add -A");
  git(dir, `commit -qm "a-runs"`);
  return dir;
}

function buildRegexpBudgetFixture() {
  const dir = scratchDir("grep-rebudget-");
  git(dir, "init -q -b main");
  // one 350 KB line (no trailing newline), never matching `(ab|cd)*z` — the
  // linear simulation walks every position and exhausts the run's regexp
  // budget; `needle.txt` is the words-mode control (the scan cap must stay
  // untouched by the regexp burn).
  writeFileSync(join(dir, "huge.txt"), "ab".repeat(175000));
  writeFileSync(join(dir, "needle.txt"), "needle here\n");
  git(dir, "add -A");
  git(dir, `commit -qm "huge line"`);
  return dir;
}

const CAPS60 = buildCapsFixture(60);
const STEPS = buildStepFixture();
const CATASTROPHE = buildCatastropheFixture();
const REBUDGET = buildRegexpBudgetFixture();

// ---- the real-git oracle ---------------------------------------------------------

/** `git grep` raw stdout; throws with git's stderr on a bad invocation. */
function gitGrepRaw(dir, args) {
  const quoted = args.map((a) => JSON.stringify(a)).join(" ");
  return execSync(`git -C ${dir} grep ${quoted}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
}

/** Per-file match map in git's output (tree) order: path -> [{num, code}].
 *  `flags` carries the mode flags; `patternArgs` the expression arguments
 *  (["engine"] positional, or ["-e", "alpha", "--and", "-e", "beta"]). */
function gitGrepMap(dir, flags, patternArgs, ref, pathspec) {
  const args = [...flags, "-n", ...patternArgs, ref, "--"];
  if (pathspec) args.push(pathspec);
  const out = gitGrepRaw(dir, args);
  const order = [];
  const byPath = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    // ref has no ':' in a plain fixture; path may be trusted fixture-controlled
    const m = /^([^:]+):(.+?):(\d+):(.*)$/.exec(line);
    if (!m) throw new Error(`unparsable git grep line: ${JSON.stringify(line)}`);
    if (!byPath.has(m[2])) {
      byPath.set(m[2], []);
      order.push(m[2]);
    }
    byPath.get(m[2]).push({ num: parseInt(m[3], 10), code: m[4] });
  }
  return { order, byPath };
}

/** Just the file list (ref prefix stripped), git's tree order. The `-I`
 *  skip-binary flag belongs in `flags` wherever ours runs — ours skips
 *  binary blobs, so the honest oracle skips them too (see the pinned
 *  divergence in the header). */
function gitGrepFiles(dir, flags, patternArgs, ref, pathspec) {
  const args = ["--name-only", ...flags, ...patternArgs, ref, "--"];
  if (pathspec) args.push(pathspec);
  return gitGrepRaw(dir, args)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith(ref + ":") ? l.slice(ref.length + 1) : l));
}

/** Normalize the RPC answer to the oracle's shapes and diff both. */
function diffAgainstOracle(result, oracle, what) {
  const gotPaths = result.results.map((r) => r.path);
  assertEq(gotPaths, oracle.order, `${what}: file order`);
  for (const block of result.results) {
    const want = oracle.byPath.get(block.path).map((l) => ({ num: l.num, code: l.code }));
    assertEq(
      block.lines.map((l) => ({ num: l.num, code: l.code })),
      want,
      `${what}: lines of ${block.path}`
    );
  }
}

// ---- the checks ---------------------------------------------------------------

await check(1, "exact mode: per-file/line oracle vs git grep -F, three case pins, ref/commit fields", async () => {
  const { cell } = await makeCell(RICH);
  // lowercase: README:2, impl:1, engine.ts:1 — arch.md's ENGINE/Engine lines
  // excluded; the oracle carries -I because ours skips binary blobs (the
  // pinned divergence — upstream's parser would emit an empty block for
  // logo.bin's hit, ours omits the file)
  const lower = await cell.grep("main", { q: "engine", mode: "exact" });
  assert(lower !== null, "exact lowercase answered");
  diffAgainstOracle(lower, gitGrepMap(RICH, ["-F", "-I"], ["engine"], "main"), "exact 'engine'");
  assertEq(lower.truncated, false, "a small fixture never truncates");
  assertEq(lower.total, lower.results.length, "total equals the uncapped result count");
  assertEq(lower.ref, "refs/heads/main", "the answer names the resolved ref");
  assertEq(lower.commit, RICH_TIP, "the answer carries the tip commit oid");
  // 'Engine' (arch.md:1) and 'ENGINE' (arch.md:2) are distinct exact hits
  const mid = await cell.grep("main", { q: "Engine", mode: "exact" });
  diffAgainstOracle(mid, gitGrepMap(RICH, ["-F"], ["Engine"], "main"), "exact 'Engine'");
  const upper = await cell.grep("main", { q: "ENGINE", mode: "exact" });
  diffAgainstOracle(upper, gitGrepMap(RICH, ["-F"], ["ENGINE"], "main"), "exact 'ENGINE'");
  assertEq(mid.results.length, 1, "'Engine' hits exactly one line");
  assertEq(upper.results.length, 1, "'ENGINE' hits exactly one line");
  // default ref = HEAD answers at the same tip
  const head = await cell.grep(undefined, { q: "engine", mode: "exact" });
  assertEq(head.commit, RICH_TIP, "ref absent = HEAD");
  assertEq(head.ref, "refs/heads/main", "HEAD's symbolic name is the answer's ref");
});

await check(2, "words mode: the --and is PER-LINE (git-verified), case-insensitive, and the default", async () => {
  const { cell } = await makeCell(RICH);
  // alpha+beta: only and.txt:3 carries both on ONE line; plain.txt's split
  // lines and the per-word files must not match. Oracle: the exact flags
  // upstream's words mode builds (grep.go:67-72), verified per-line in git.
  const both = await cell.grep("main", { q: "alpha beta" });
  assert(both !== null, "words query answered");
  diffAgainstOracle(both, gitGrepMap(RICH, ["-F", "-i"], ["-e", "alpha", "--and", "-e", "beta"], "main"), "words alpha beta");
  assertEq(both.results.length, 1, "one matching file");
  assertEq(both.results[0].path, "src/and.txt", "the same-line file");
  assertEq(both.results[0].lines, [{ num: 3, code: "alpha and beta together" }], "exactly line 3");
  // case-insensitive: 'STORAGE HEART' finds the ENGINE line
  const ci = await cell.grep("main", { q: "storage heart" });
  assert(ci !== null && ci.results.length === 1, "case-insensitive words hit");
  assertEq(ci.results[0].path, "docs/arch.md", "the ENGINE line file");
  assertEq(ci.results[0].lines[0].num, 2, "the ENGINE line number");
  // absent mode === words
  const explicit = await cell.grep("main", { q: "alpha beta", mode: "words" });
  assertEq(JSON.stringify(explicit), JSON.stringify(both), "mode absent === mode words");
});

await check(3, "regexp mode: oracle vs git grep -P (classes, anchors, alternation); bad patterns null", async () => {
  const { cell } = await makeCell(RICH);
  for (const pattern of ["en[gs]ine", "live here$", "^grep", "alpha|unrelated"]) {
    const result = await cell.grep("main", { q: pattern, mode: "regexp" });
    assert(result !== null, `${pattern} answered`);
    diffAgainstOracle(result, gitGrepMap(RICH, ["-P", "-I"], [pattern], "main"), `regexp ${pattern}`);
    assertEq(result.truncated, false, `${pattern} does not truncate`);
  }
  // compile failures answer null (the SPEC contract), never a throw
  assertEq(await cell.grep("main", { q: "([unclosed", mode: "regexp" }), null, "unbalanced group");
  assertEq(await cell.grep("main", { q: "(alpha)\\1", mode: "regexp" }), null, "backreference unsupported");
  assertEq(await cell.grep("main", { q: "(?=alpha)", mode: "regexp" }), null, "lookahead unsupported");
});

await check(4, "path filter: equals the full run sliced to the prefix and the git pathspec oracle", async () => {
  const { cell } = await makeCell(RICH);
  const full = await cell.grep("main", { q: "engine" });
  const docs = await cell.grep("main", { q: "engine", path: "docs" });
  assert(docs !== null && full !== null, "runs answered");
  const fullDocs = full.results.filter((r) => r.path === "docs" || r.path.startsWith("docs/"));
  assertEq(docs.results, fullDocs, "the prefix run is the full run sliced");
  diffAgainstOracle(docs, gitGrepMap(RICH, ["-F", "-i"], ["-e", "engine"], "main", "docs"), "path docs");
  // a path pointing AT a single file narrows to that file's block
  const one = await cell.grep("main", { q: "engine", path: "src/engine.ts" });
  assertEq(one.results.length, 1, "the file path yields one block");
  assertEq(one.results[0].path, "src/engine.ts", "the file path block");
  // a path matching nothing answers empty, not null (a valid empty match set)
  const none = await cell.grep("main", { q: "engine", path: "zzz" });
  assertEq(none.results, [], "no path match is an empty answer");
  assertEq(none.truncated, false, "an empty prefix is not truncation");
});

await check(5, "binary + oversize blobs skipped (not budget exits); text-only set equals git grep -I", async () => {
  const { cell } = await makeCell(RICH);
  // logo.bin CONTAINS 'engine' bytes and big.txt contains 'needle' — both
  // must never surface
  const words = await cell.grep("main", { q: "engine" });
  assert(words !== null, "words run answered");
  const paths = words.results.map((r) => r.path);
  assert(!paths.includes("logo.bin"), "the binary blob is absent");
  assert(!paths.includes("big.txt"), "the over-cap blob is absent");
  assertEq(words.truncated, false, "skips are not budget exits");
  const needle = await cell.grep("main", { q: "needle", mode: "exact" });
  assertEq(needle.results, [], "big.txt's needle never surfaces");
  // the text-only set equals git grep -I (skip binary) for the same query
  const gitFiles = gitGrepFiles(RICH, ["-F", "-i", "-I"], ["-e", "engine"], "main");
  assertEq(words.results.map((r) => r.path), gitFiles, "text-only file set matches git grep -I");
});

await check(6, "the 50-result cap: 50 blocks, honest total 60, truncated, git's first 50 in tree order", async () => {
  const { cell } = await makeCell(CAPS60);
  const result = await cell.grep("main", { q: "hit" });
  assert(result !== null, "capped run answered");
  assertEq(result.results.length, 50, "results capped at MAX_GREP_RESULT_FILES");
  assertEq(result.total, 60, "total counts BEFORE the cap sliced (all 60 files match)");
  assertEq(result.truncated, true, "the result cap exit is flagged");
  const gitOrder = gitGrepFiles(CAPS60, ["-F", "-I"], ["hit"], "main");
  assertEq(gitOrder.length, 60, "git lists all 60 (uncapped oracle)");
  assertEq(
    result.results.map((r) => r.path),
    gitOrder.slice(0, 50),
    "our 50 blocks are git's first 50 in tree order"
  );
});

await check(7, "the files cap: counting STOPS at MAX_GREP_FILES (2001st file never scanned)", async () => {
  const { cell } = await makeCell(buildCapsFixture(2001));
  const result = await cell.grep("main", { q: "hit" });
  assert(result !== null, "files-capped run answered");
  assertEq(result.total, 2000, "total froze at the cap — file 2001 never scanned");
  assertEq(result.results.length, 50, "results capped");
  assertEq(result.truncated, true, "the files cap exit is flagged");
  // the first 50 blocks are the same tree-order prefix the uncapped 60-file
  // fixture answers — the cap slices a stable prefix, not an arbitrary set
  const sixty = await (await makeCell(CAPS60)).cell.grep("main", { q: "hit" });
  assertEq(sixty.results.map((r) => r.path), result.results.map((r) => r.path), "the cap slices the same tree-order prefix");
});

await check(8, "the scan-step cap: 250k lines > 200k steps truncates mid-scan, partial blocks kept", async () => {
  const { cell } = await makeCell(STEPS);
  const result = await cell.grep("main", { q: "needle", mode: "exact" });
  assert(result !== null, "step-capped run answered");
  assertEq(result.truncated, true, "the scan-step exit is flagged");
  assertEq(result.total, 2, "both blobs matched before the cut");
  assertEq(result.results.length, 2, "both blocks present");
  assertEq(result.results[0].path, "a-lines.txt", "the first blob in tree order");
  assertEq(result.results[0].lines, [{ num: 1, code: "needle one" }], "the first blob's only hit");
  assertEq(result.results[1].path, "b-lines.txt", "the second blob was reached");
  assertEq(result.results[1].lines, [{ num: 1, code: "needle two" }], "the second blob's only hit");
});

await check(9, "the regexp budget: catastrophic pattern linear + correct; budget burn flags truncated with the scan cap intact", async () => {
  // (a+)+$ — native JS RegExp backtracks ~2^n on the a-run + X line (a hang);
  // ours is a linear NFA simulation: correct answer, fast wall, no budget trip
  const cat = await makeCell(CATASTROPHE);
  const t0 = Date.now();
  const result = await cat.cell.grep("main", { q: "(a+)+$", mode: "regexp" });
  const wall = Date.now() - t0;
  assert(result !== null, "catastrophic-pattern run answered");
  assert(wall < 5000, `the catastrophic pattern answered in ${wall}ms (linear, not 2^n)`);
  assertEq(result.truncated, false, "the small fixture does not trip the budget");
  assertEq(result.results.length, 1, "one matching file");
  assertEq(
    result.results[0].lines,
    [
      { num: 1, code: "aaa" },
      { num: 2, code: "a".repeat(2000) },
    ],
    "the pure-a lines match; the X line and the greeting do not"
  );
  // a never-matching pattern over a 350 KB single line burns the REGEXP
  // budget: truncated + empty, while the words control stays untruncated —
  // the regexp budget is separate from the line-scan cap
  const reb = await makeCell(REBUDGET);
  const t1 = Date.now();
  const burned = await reb.cell.grep("main", { q: "(ab|cd)*z", mode: "regexp" });
  const burnWall = Date.now() - t1;
  assert(burned !== null, "the budget-burn run answered");
  assert(burnWall < 5000, `the budget burn answered in ${burnWall}ms (bounded)`);
  assertEq(burned.truncated, true, "the regexp budget exit is flagged");
  assertEq(burned.results, [], "no results before the cut");
  const control = await reb.cell.grep("main", { q: "needle" });
  assertEq(control.truncated, false, "the words control is NOT truncated — the scan cap untouched");
  assertEq(control.results.length, 1, "the words control answers fully");
});

await check(10, "null arms: empty q, whitespace words, unresolvable ref, empty repo; unknown mode falls to words", async () => {
  const { cell } = await makeCell(RICH);
  assertEq(await cell.grep("main", {}), null, "absent q");
  assertEq(await cell.grep("main", { q: "" }), null, "empty q");
  assertEq(await cell.grep("main", { q: "   " }), null, "words query with zero words");
  assertEq(await cell.grep("nosuchbranch", { q: "engine" }), null, "unresolvable ref");
  // an unknown mode falls to the words default (upstream's switch default)
  const words = await cell.grep("main", { q: "alpha beta" });
  const fuzzy = await cell.grep("main", { q: "alpha beta", mode: "fuzzy" });
  assertEq(JSON.stringify(fuzzy), JSON.stringify(words), "an unknown mode answers exactly what words answers");
  // an empty repo (no refs, unborn HEAD) answers null like every read RPC
  const emptyDir = scratchDir("grep-empty-");
  git(emptyDir, "init -q -b main");
  const { cell: emptyCell } = await makeCell(emptyDir);
  assertEq(await emptyCell.grep(undefined, { q: "engine" }), null, "empty repo");
});

await check(11, "static tripwire: rpcBind + withContentLease + the named budget constants; GrepResult on the module export", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const grepBody = src.slice(src.indexOf("async grep(ref?"), src.indexOf("private async api("));
  assert(grepBody.length > 0, "the grep method found");
  assert(grepBody.includes("this.rpcBind()"), "rpcBind first");
  assert(grepBody.includes("this.withContentLease"), "the read-RPC lease wrapper");
  for (const c of ["MAX_GREP_FILES", "MAX_GREP_BLOB_BYTES", "MAX_GREP_RESULT_FILES", "MAX_GREP_SCAN_STEPS", "MAX_GREP_REGEXP_STEPS"]) {
    assert(grepBody.includes(c), `the ${c} budget constant rides the scan`);
  }
  assert(src.includes("export interface GrepResult"), "GrepResult declared on repo.ts");
  // NOTE: the mod.ts re-export (`GrepResult` on the package boundary) folds
  // into the UI wave's combined landing together with the EngineClient.grep
  // wrapper — the dist-types/repo.d.ts declaration is generated by typecheck
  // and is the boundary this unit owns (the dispatch's engine-only scope).
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  if (!mod.includes("GrepResult")) console.log("      note: mod.ts GrepResult re-export pending the UI wave's combined landing (dist-types/repo.d.ts carries it)");
});

console.log(`\ncheck-grep: ${planned - failed}/${planned} checks passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
