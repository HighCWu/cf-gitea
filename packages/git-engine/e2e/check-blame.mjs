// blame RPC gate — the census R08 boundary (`GET .../blame/{branch|tag|commit}/*`
// page data). Run with tsx (see e2e/README.md for the invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-blame.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the RPC is the REAL RepoCell method over a real
// GitStore (node:sqlite) whose objects/refs come from a REAL git fixture
// (the check-tree-commits.mjs seeding), and the ORACLE for the attribution
// is real `git blame --porcelain` run against the same fixture — the
// per-line sha array, the per-oid `previous` headers, the author names and
// the summaries must all match the expanded runs. The first-parent
// divergence (a merge-introduced file: git blame follows all parents, ours
// attributes to the merge commit, the DO's own blamePage semantic) is
// pinned EXPLICITLY instead of hidden behind the oracle.
//
// Covers, in order:
//   1.  PER-LINE oracle: the RPC's runs expand to EXACTLY `git blame
//       --porcelain`'s per-line sha array (five-commit chain, two distinct
//       authors, interleaved foreign-file commits); totalLines matches; the
//       sidebar commits carry each part oid's porcelain author + summary.
//   2.  the `previous` headers: every part oid's `previousOid` equals the
//       porcelain `previous <sha>` header for that oid (the immediate
//       first parent while its tree holds the path — including pointing at
//       a FOREIGN-file commit), and the creation part carries none.
//   3.  the line window: {lineOfs, lineLimit} slices the flat lines with
//       ABSOLUTE numbering (concatenation equals the porcelain content
//       slice), runs never straddle the window edge, totalLines stays
//       whole-file; the default answer starts at line 1.
//   4.  the first-parent semantic, pinned: a file introduced by a merge's
//       second parent attributes to the MERGE commit (git blame would name
//       the side-branch commit) and the walk is NOT truncated — the
//       merge-commit entry is the chain's natural creation answer.
//   5.  delete + re-add: every line of the re-added content attributes to
//       the re-add commit, and the real-git oracle agrees line for line.
//   6.  null arms (the readBlob posture): unresolvable ref, missing path,
//       a directory path, a binary file, and an over-MAX_BLAME_LINES file
//       all answer null — never a throw.
//   7.  the walk budget: pathHistory at cap 2 answers 2 entries with
//       truncated=true (the budget exit), the full walk answers
//       truncated=false with the previousOid chain intact, and blame()
//       itself reports truncated=false on the ordinary fixture.
//   8.  static tripwire (the check-tree-commits.mjs convention): the RPC
//       rides rpcBind + withContentLease and delegates to pathHistory with
//       the named budget constants.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-tree-commits.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, assertEq, commitOid, git, loadGitRepoIntoStore, makeStore, scratchDir } from "./helpers/lib.mjs";

let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the real cell over a real store (check-tree-commits.mjs's shape) --------

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

// ---- fixture: a real git repo whose story.txt has a blameable chain ----------

function buildBlameFixture() {
  const dir = scratchDir("blame-");
  git(dir, "init -q -b main");
  const f = (name, content) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  const commit = (msg, date, author, cmd = "commit -aqm") =>
    git(dir, `${cmd} ${JSON.stringify(msg)}`, {
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_DATE: date,
      ...(author ? { GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author } : {}),
    });

  f("story.txt", "line one\nline two\nline three\n");
  git(dir, "add -A");
  commit("c1 story born", "2026-02-01T00:00:00", "Alice");
  f("other.txt", "unrelated\n");
  git(dir, "add -A");
  commit("c2 foreign file", "2026-02-02T00:00:00", "Bob");
  f("story.txt", "line one\nline two EDITED\nline three\nline four\n");
  git(dir, "add -A");
  commit("c3 edit story", "2026-02-03T00:00:00", "Alice");
  f("story.txt", "LINE ONE REWRITTEN\nline two EDITED\nline three\nline four\n");
  git(dir, "add -A");
  commit("c4 rewrite first line", "2026-02-04T00:00:00", "Bob");
  f("other2.txt", "also unrelated\n");
  git(dir, "add -A");
  commit("c5 second foreign file", "2026-02-05T00:00:00", "Alice");
  f("story.txt", "LINE ONE REWRITTEN\nline two EDITED\nline three\nline four\nline five appended\nline six appended\n");
  git(dir, "add -A");
  commit("c6 append to story", "2026-02-06T00:00:00", "Bob");

  // a side branch merged back — touches ONLY side-file.txt, so story.txt's
  // full-parent and first-parent blame agree and the porcelain oracle holds
  git(dir, "checkout -qb side");
  f("side-file.txt", "from the side branch\n");
  git(dir, "add -A");
  commit("s1 side file", "2026-02-07T00:00:00", "Alice");
  git(dir, "checkout -q main");
  git(dir, "merge -q --no-ff -m m1 side", {
    GIT_COMMITTER_DATE: "2026-02-08T00:00:00",
    GIT_AUTHOR_DATE: "2026-02-08T00:00:00",
    GIT_AUTHOR_NAME: "Bob",
    GIT_COMMITTER_NAME: "Bob",
  });
  f("story.txt", "LINE ONE REWRITTEN\nline two EDITED\nline three\nline four\nline five appended\nline six appended\npost-merge line seven\n");
  git(dir, "add -A");
  commit("c7 post-merge append", "2026-02-09T00:00:00", "Alice");

  // a binary file + an over-MAX_BLAME_LINES file for the null arms
  writeFileSync(join(dir, "logo.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x03]));
  writeFileSync(join(dir, "huge.txt"), Array.from({ length: 5001 }, (_v, i) => `row ${i}`).join("\n") + "\n");
  git(dir, "add -A");
  commit("c8 binary and huge", "2026-02-10T00:00:00", "Bob");

  // delete + re-add: story.txt dies at c9 and returns with fresh content at
  // c10 — `main~2` addresses the pre-delete state, `main` the re-add
  git(dir, "rm -q story.txt");
  commit("c9 delete story", "2026-02-11T00:00:00", "Alice", "commit -aqm");
  f("story.txt", "reborn line A\nreborn line B\n");
  git(dir, "add -A");
  commit("c10 re-add story", "2026-02-12T00:00:00", "Bob");
  return dir;
}

const FIXTURE = buildBlameFixture();
/** The pre-delete chain tip as a FULL oid — the engine resolves branches,
 *  tags and reachable oids only, not `main~2` revision expressions. */
const PRE_DELETE = commitOid(FIXTURE, "main~2");

// ---- the real-git oracle: `git blame --porcelain` parsed ---------------------

/** Per-line blame of `ref -- path`, straight from git: an array of
 *  { sha, content } in file order, plus each distinct sha's `previous`
 *  header sha, author name and summary. */
function gitBlame(fixtureDir, ref, path) {
  const out = execSync(`git -C ${fixtureDir} blame --porcelain ${ref} -- ${path}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  const lines = [];
  const meta = new Map(); // sha -> { previous, author, summary }
  let cur = null;
  for (const raw of out.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(raw);
    if (header) {
      cur = header[1];
      if (!meta.has(cur)) meta.set(cur, { previous: undefined, author: undefined, summary: undefined });
      continue;
    }
    if (raw.startsWith("\t")) {
      lines.push({ sha: cur, content: raw.slice(1) });
      continue;
    }
    if (cur === null) continue;
    const m = meta.get(cur);
    const prev = /^previous ([0-9a-f]{40}) /.exec(raw);
    if (prev) m.previous = prev[1];
    const author = /^author (.*)$/.exec(raw);
    if (author) m.author = author[1];
    const summary = /^summary (.*)$/.exec(raw);
    if (summary) m.summary = summary[1];
  }
  return { lines, meta };
}

/** The RPC's runs flattened to the oracle's shape. */
function expand(result) {
  const flat = [];
  for (const part of result.parts) for (const line of part.lines) flat.push({ sha: part.oid, content: line });
  return flat;
}

// ---- the checks ---------------------------------------------------------------

await check("1. per-line oracle: expanded runs equal git blame --porcelain, metadata matches", async () => {
  const { cell } = await makeCell(FIXTURE);
  const result = await cell.blame(PRE_DELETE, "story.txt"); // the pre-delete chain tip
  assert(result !== null, "blame answered");
  const oracle = gitBlame(FIXTURE, PRE_DELETE, "story.txt");
  const flat = expand(result);
  assertEq(flat.length, oracle.lines.length, "line count");
  for (let i = 0; i < flat.length; i++) {
    assertEq(flat[i].sha, oracle.lines[i].sha, `line ${i + 1} sha`);
    assertEq(flat[i].content, oracle.lines[i].content, `line ${i + 1} content`);
  }
  assertEq(result.totalLines, oracle.lines.length, "totalLines is the whole file");
  assertEq(result.firstLine, 1, "a full-file answer starts at line 1");
  assertEq(result.truncated, false, "the ordinary walk reaches the creation commit");
  // sidebar metadata: author + summary per distinct part oid (the porcelain
  // block headers), and ONLY part oids are keyed
  const partOids = new Set(result.parts.map((p) => p.oid));
  assertEq(Object.keys(result.commits).sort(), [...partOids].sort(), "commits keyed by part oids");
  for (const [sha, want] of oracle.meta) {
    const got = result.commits[sha];
    if (got === undefined) continue; // a sha blame merged out of the answer
    assertEq(got.author.name, want.author, `author of ${sha.slice(0, 8)}`);
    assertEq(got.subject, want.summary, `summary of ${sha.slice(0, 8)}`);
  }
  // two distinct authors really exercised (the fixture's point)
  const authors = new Set(result.parts.map((p) => result.commits[p.oid].author.name));
  assert(authors.has("Alice") && authors.has("Bob"), `both fixture authors attributed: ${[...authors]}`);
});

await check("2. previousOid equals git's `previous` header per oid; the creation part has none", async () => {
  const { cell } = await makeCell(FIXTURE);
  const result = await cell.blame(PRE_DELETE, "story.txt");
  assert(result !== null, "blame answered");
  const oracle = gitBlame(FIXTURE, PRE_DELETE, "story.txt");
  for (const part of result.parts) {
    const want = oracle.meta.get(part.oid);
    assert(want !== undefined, `part oid ${part.oid.slice(0, 8)} present in the porcelain output`);
    assertEq(part.previousOid, want.previous, `previousOid of ${part.oid.slice(0, 8)}`);
  }
  // the chain's oldest part IS the creation commit (no previous anywhere)
  const creation = result.parts.find((p) => p.previousOid === undefined);
  assert(creation !== undefined, "a creation part exists");
  const creationMeta = oracle.meta.get(creation.oid);
  assertEq(creationMeta?.previous, undefined, "git agrees: the creation block carries no previous header");
  // the previous link points at a FOREIGN-file commit at least once (the
  // immediate-parent semantic, not the next-changed-entry shortcut)
  const foreign = result.parts.find((p) => result.commits[p.oid].subject.startsWith("c6"));
  assert(foreign !== undefined, "the c6 part exists");
  // c5 is a FOREIGN commit (not a part oid, not in the Record) — its
  // subject resolves through readCommit, the page's own resolution path
  const prevCommit = foreign.previousOid !== undefined ? await cell.readCommit(foreign.previousOid) : null;
  assertEq(prevCommit?.subject, "c5 second foreign file", "c6's previous is the foreign c5 commit (git's exact semantic)");
});

await check("3. the line window slices absolutely; runs never straddle; totalLines stays whole", async () => {
  const { cell } = await makeCell(FIXTURE);
  const full = await cell.blame(PRE_DELETE, "story.txt");
  assert(full !== null, "full blame answered");
  const oracle = gitBlame(FIXTURE, PRE_DELETE, "story.txt");
  const win = await cell.blame(PRE_DELETE, "story.txt", { lineOfs: 1, lineLimit: 2 });
  assert(win !== null, "window answered");
  assertEq(win.totalLines, full.totalLines, "totalLines is whole-file in the window");
  assertEq(win.firstLine, 2, "the window carries its absolute start (lineOfs + 1)");
  const winFlat = expand(win);
  assertEq(winFlat.length, 2, "the window carries exactly lineLimit lines");
  for (let i = 0; i < 2; i++) {
    assertEq(winFlat[i].sha, oracle.lines[1 + i].sha, `window line ${i + 1} sha`);
    assertEq(winFlat[i].content, oracle.lines[1 + i].content, `window line ${i + 1} content`);
  }
  // every window part's lines are contiguous and within the window
  let covered = 0;
  for (const part of win.parts) {
    assert(part.lines.length > 0, "no empty runs");
    covered += part.lines.length;
  }
  assertEq(covered, 2, "the window's parts tile it exactly");
  // a window past the end answers empty parts, not a throw
  const tail = await cell.blame(PRE_DELETE, "story.txt", { lineOfs: 999, lineLimit: 5 });
  assert(tail !== null, "past-the-end window answers");
  assertEq(tail.parts, [], "empty parts past the end");
});

await check("4. first-parent semantic pinned: a merge-introduced file attributes to the MERGE commit", async () => {
  const { cell } = await makeCell(FIXTURE);
  const result = await cell.blame("main", "side-file.txt");
  assert(result !== null, "side-file blame answered");
  assertEq(result.parts.length, 1, "one run");
  assertEq(result.commits[result.parts[0].oid].subject, "m1", "attributed to the merge commit");
  assertEq(result.truncated, false, "the merge entry IS the chain's creation answer — not truncation");
  // and git's all-parents answer (the side commit) differs — the divergence
  // is real, which is exactly why this check pins ours
  const gitAnswer = gitBlame(FIXTURE, "main", "side-file.txt");
  assert(gitAnswer.lines[0].sha !== result.parts[0].oid, "git blame names the side commit (documented divergence)");
});

await check("5. delete + re-add: the re-add commit owns every line, git agrees", async () => {
  const { cell } = await makeCell(FIXTURE);
  const result = await cell.blame("main", "story.txt"); // the re-added content
  assert(result !== null, "re-add blame answered");
  const oracle = gitBlame(FIXTURE, "main", "story.txt");
  const flat = expand(result);
  assertEq(flat.length, oracle.lines.length, "line count after the re-add");
  for (let i = 0; i < flat.length; i++) {
    assertEq(flat[i].sha, oracle.lines[i].sha, `line ${i + 1} sha after the re-add`);
    assertEq(flat[i].content, oracle.lines[i].content, `line ${i + 1} content after the re-add`);
  }
  const oids = new Set(result.parts.map((p) => p.oid));
  assertEq(oids.size, 1, "one owning commit");
  assertEq(result.commits[[...oids][0]].subject, "c10 re-add story", "the re-add commit owns every line");
});

await check("6. null arms: unresolvable ref, missing path, directory, binary, over-lines", async () => {
  const { cell } = await makeCell(FIXTURE);
  assertEq(await cell.blame("nosuchbranch", "story.txt"), null, "unresolvable ref");
  assertEq(await cell.blame("main", "gone.txt"), null, "missing path");
  assertEq(await cell.blame("main", ""), null, "empty path");
  assertEq(await cell.blame("main", "docs"), null, "a directory path");
  assertEq(await cell.blame("main", "logo.bin"), null, "binary file");
  assertEq(await cell.blame("main", "huge.txt"), null, "over-MAX_BLAME_LINES file");
});

await check("7. the walk budget: cap exit truncates, the full walk does not, the chain survives", async () => {
  const { cell } = await makeCell(FIXTURE);
  // pathHistory is the walk; the private marker is a compile-time concept —
  // tsx strips types, so the method is callable here like any other.
  // `main~2` = the pre-delete chain (five changed entries); `main`'s story
  // chain ends at the re-add (a one-entry natural creation).
  const capped = await cell.pathHistory(PRE_DELETE, ["story.txt"], 2, 16 * 1024 * 1024, undefined);
  assertEq(capped.entries.length, 2, "the cap bounds the entries");
  assertEq(capped.truncated, true, "a budget exit reports truncated");
  // the entries are the two NEWEST changes, previousOids chained
  assertEq(typeof capped.entries[1].previousOid, "string", "the older entry still carries its previous link");
  const full = await cell.pathHistory(PRE_DELETE, ["story.txt"], 200, 16 * 1024 * 1024, undefined);
  assertEq(full.truncated, false, "the unbounded walk reaches the creation");
  assertEq(full.entries.length >= 5, true, "the whole changed chain walked");
  const result = await cell.blame("main", "story.txt");
  assertEq(result.truncated, false, "the RPC reports the same (the re-add chain)");
});

await check("8. static tripwire: the RPC rides rpcBind + withContentLease and names its budgets", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const blameBody = src.slice(src.indexOf("async blame(ref?"), src.indexOf("private async api("));
  assert(blameBody.length > 0, "the blame method found");
  assert(blameBody.includes("this.rpcBind()"), "rpcBind first");
  assert(blameBody.includes("this.withContentLease"), "the read-RPC lease wrapper");
  assert(blameBody.includes("MAX_BLAME_BYTES") && blameBody.includes("MAX_BLAME_REVISIONS"), "the named budget constants");
  assert(blameBody.includes("MAX_BLAME_HISTORY_BYTES"), "the history-bytes budget");
  // the boundary export exists
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  assert(mod.includes("BlameResult"), "BlameResult on the boundary");
});

console.log(`\ncheck-blame: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
