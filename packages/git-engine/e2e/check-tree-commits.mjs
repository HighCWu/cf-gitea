// listTreeCommits gate — the A10-L batched per-path latest-commit RPC. Run
// with tsx (see e2e/README.md for the invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-tree-commits.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the RPC is the REAL RepoCell method over a real
// GitStore (node:sqlite) whose objects/refs come from a REAL git fixture
// repository (same seeding mechanism as check-merge-graph.mjs), and the
// ORACLE for every answer is the per-path listLog call the batched RPC
// replaces — `listLog(ref, { path, ofs: 0, n: 1 })` — the exact equality the
// audit row demands (batch correctness vs per-path listLog on a seeded tree).
//
// Covers, in order:
//   1.  INDEX-ALIGNED equality: for every entry of a real git tree (root
//       files, a nested dir path, a deleted path, a never-existing path),
//       listTreeCommits' slot equals that path's own per-path listLog first
//       commit (full CommitJson deep-equality, null ↔ empty page).
//   2.  the tip commit's own touched path answers the tip (the newest commit
//       wins the walk, exactly as the per-path page does).
//   3.  the delete commit answers a deleted path (matchesFilter's mine-vs-
//       parent-tree comparison, same predicate both sides).
//   4.  an unresolvable ref answers ALL-NULL (never a throw) — the same
//       shape an unresolvable ref gives every per-path listLog (empty page).
//   5.  empty input answers an empty alignment ({ commits: [] }).
//   6.  over-budget input THROWS at TREE_COMMITS_MAX_PATHS — an index-aligned
//       answer is never silently truncated (the consumer degrades as it does
//       for any transport-class failure).
//   7.  ONE walk replaces the fan: on fresh twin stores (caches cannot skew),
//       the batched call performs strictly FEWER object reads than the sum of
//       the per-path listLog calls it replaces (the shared commit walk; the
//       per-path memos stay per-path, so tree reads are not double-counted).
//   8.  static tripwire (the check-push-origin.mjs convention): the method
//       delegates to walkTreeCommits exactly once, and the walk carries
//       PER-PATH pathOid memos (pathOidCached keys by root tree alone — a
//       shared memo across paths would cross-contaminate answers).
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-read-leases.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assert, assertEq, git, loadGitRepoIntoStore, makeStore, scratchDir } from "./helpers/lib.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// ---- the real cell over a real store (check-read-leases.mjs's shape) --------

/** RepoCell over `t`'s store: fake ctx/env, meta.repo set the way the first
 * fetch() would (rpcBind's name source); REPO_PACKS unbound — a loose-only
 * store takes no read gate (empty pack catalog). */
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

/** Fresh store + loaded fixture + real cell, built per arm. */
async function makeCell(fixtureDir) {
  const t = makeStore();
  loadGitRepoIntoStore(t, fixtureDir);
  return { t, cell: await contentCell(t) };
}

// ---- fixture: a real git repo with deep, merged, deleted, absent paths ------

function buildTreeFixture() {
  const dir = scratchDir("tree-commits-");
  git(dir, "init -q -b main");
  const f = (name, content) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  const commit = (msg, date, cmd = "commit -aqm") =>
    git(dir, `${cmd} ${JSON.stringify(msg)}`, {
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_DATE: date,
    });
  f("base.txt", "v1\n");
  git(dir, "add -A");
  commit("c1 base", "2026-01-01T00:00:00");
  f("a.txt", "a1\n");
  f("b.txt", "b1\n");
  git(dir, "add -A");
  commit("c2 a+b", "2026-01-02T00:00:00");
  f("sub/nested.txt", "n1\n");
  git(dir, "add -A");
  commit("c3 nested", "2026-01-03T00:00:00");
  f("deleted.txt", "bye soon\n");
  git(dir, "add -A");
  commit("c4 deleted", "2026-01-04T00:00:00");
  // a side branch later merged back (the walk crosses a real merge)
  git(dir, "checkout -qb side");
  f("side.txt", "s1\n");
  git(dir, "add -A");
  commit("s1 side", "2026-01-05T00:00:00");
  f("side.txt", "s2\n");
  git(dir, "add -A");
  commit("s2 side", "2026-01-06T00:00:00");
  git(dir, "checkout -q main");
  // a deep history on one path (the fan's expensive case)
  for (let i = 1; i <= 12; i++) {
    const date = `2026-01-${String(6 + i).padStart(2, "0")}T00:00:00`;
    f("deep.txt", `v${i}\n`);
    git(dir, "add -A");
    commit(`d${i} deep`, date);
  }
  git(dir, "merge -q --no-ff -m m1 side", { GIT_COMMITTER_DATE: "2026-01-19T00:00:00", GIT_AUTHOR_DATE: "2026-01-19T00:00:00" });
  git(dir, "rm -q deleted.txt");
  commit("del removed", "2026-01-20T00:00:00");
  f("deep.txt", "v-final\n");
  git(dir, "add -A");
  commit("tip final deep", "2026-01-21T00:00:00");
  return dir;
}

const FIXTURE = buildTreeFixture();

/** The exact path list the repo-home consumer builds: listTree entries with
 *  root listings passing the entry name, nested listings the dir-prefixed
 *  path — plus the pathological paths (deleted, never-existing). */
async function consumerPaths(cell) {
  const root = await cell.listTree("main", "");
  assert(root !== null, "root tree listed");
  const names = root.entries.map((e) => e.name).sort();
  return [...names, "sub/nested.txt", "deleted.txt", "gone.txt"];
}

// ---- the checks --------------------------------------------------------------

await check("1. index-aligned equality: every batch slot equals its per-path listLog oracle", async () => {
  const { cell } = await makeCell(FIXTURE);
  const paths = await consumerPaths(cell);
  // batch FIRST: cold caches — the oracle walks run warm, a conservative skew
  const batch = await cell.listTreeCommits("main", paths);
  assert(batch !== null, "batch answered");
  assertEq(batch.commits.length, paths.length, "answer aligned with the input");
  for (const [i, path] of paths.entries()) {
    const perPath = await cell.listLog("main", { path, ofs: 0, n: 1 });
    const want = perPath.commits[0] ?? null;
    assertEq(batch.commits[i], want, `slot ${i} (${path})`);
  }
  // and the alignment survives a reordered/shuffled input (index, never key)
  const shuffled = [...paths].reverse();
  const rebatch = await cell.listTreeCommits("main", shuffled);
  const perPathOf = async (path) => (await cell.listLog("main", { path, ofs: 0, n: 1 })).commits[0] ?? null;
  for (const [i, path] of shuffled.entries()) {
    assertEq(rebatch.commits[i], await perPathOf(path), `reversed slot ${i} (${path})`);
  }
});

await check("2. the tip commit's touched path answers the tip commit", async () => {
  const { cell } = await makeCell(FIXTURE);
  const batch = await cell.listTreeCommits("main", ["deep.txt"]);
  const tip = await cell.readCommit("main");
  assertEq(batch.commits[0].oid, tip.oid, "deep.txt's newest touch is the tip");
  assertEq(batch.commits[0].subject, "tip final deep", "tip subject verbatim");
});

await check("3. a deleted path answers its DELETE commit; an absent path answers null", async () => {
  const { cell } = await makeCell(FIXTURE);
  const batch = await cell.listTreeCommits("main", ["deleted.txt", "gone.txt"]);
  assertEq(batch.commits[0].subject, "del removed", "the delete commit touched the path");
  assertEq(batch.commits[1], null, "never-existing path: null (the per-path empty page)");
  const perPath = await cell.listLog("main", { path: "gone.txt", ofs: 0, n: 1 });
  assertEq(perPath.commits.length, 0, "oracle agrees: empty page");
});

await check("4. an unresolvable ref answers ALL-NULL, never a throw (per-path empty-page shape)", async () => {
  const { cell } = await makeCell(FIXTURE);
  const batch = await cell.listTreeCommits("nosuchbranch", ["a.txt", "b.txt"]);
  assertEq(batch, { commits: [null, null] }, "all-null alignment");
  const perPath = await cell.listLog("nosuchbranch", { path: "a.txt", ofs: 0, n: 1 });
  assertEq(perPath, { commits: [], more: false }, "the oracle on the same ref: empty page");
});

await check("5. empty input answers an empty alignment", async () => {
  const { cell } = await makeCell(FIXTURE);
  assertEq(await cell.listTreeCommits("main", []), { commits: [] }, "no paths, no slots");
});

await check("6. over-budget input throws at TREE_COMMITS_MAX_PATHS (never a truncated alignment)", async () => {
  const { TREE_COMMITS_MAX_PATHS } = await import("../src/repo.ts");
  assertEq(TREE_COMMITS_MAX_PATHS, 100, "the exported bound");
  const { cell } = await makeCell(FIXTURE);
  const paths = Array.from({ length: TREE_COMMITS_MAX_PATHS + 1 }, (_v, i) => `p${i}.txt`);
  let threw = null;
  try {
    await cell.listTreeCommits("main", paths);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw !== null, "over-budget request rejected");
  assert(threw.includes("too many paths"), `the bound named in the error: ${threw}`);
});

await check("7. ONE walk replaces the fan: strictly fewer object reads than the per-path calls", async () => {
  const fanPaths = ["deep.txt", "sub/nested.txt", "base.txt"];
  const spy = async (run) => {
    const { t, cell } = await makeCell(FIXTURE);
    let reads = 0;
    // the CELL's store — RepoCell constructs its own GitStore over the shared
    // sqlite, so patching t.store would count nothing (check-read-leases.mjs
    // patches cell.store the same way)
    const orig = cell.store.get.bind(cell.store);
    cell.store.get = (...args) => {
      reads++;
      return orig(...args);
    };
    await run(cell);
    return reads;
  };
  const batchReads = await spy((cell) => cell.listTreeCommits("main", fanPaths));
  const fanReads = await spy(async (cell) => {
    for (const path of fanPaths) await cell.listLog("main", { path, ofs: 0, n: 1 });
  });
  assert(
    batchReads < fanReads,
    `the shared walk must read strictly less than the N walks it replaces: batch=${batchReads} fan=${fanReads}`
  );
});

await check("8. static tripwire: single walkTreeCommits delegation + PER-PATH pathOid memos", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  // (a) listTreeCommits delegates to the shared walk exactly once
  const delegations = src.split("this.walkTreeCommits(").length - 1;
  assertEq(delegations, 1, "exactly one walkTreeCommits call site");
  // (b) the walk's pathOid memos are PER PATH: pathOidCached keys entries by
  //     root tree alone, so a memo shared across paths would cross-contaminate
  assert(
    src.includes("const memos = filters.map(() => new Map<string, string | null>());"),
    "per-path memo construction present"
  );
  assert(src.includes("memos[i]"), "each pending path consults its own memo");
  // (c) the batch rides the SAME scan budget as a path-filtered listLog walk
  assert(
    src.includes("scanned++ < PATH_LOG_SCAN") && src.includes("pending.size > 0"),
    "walkLog's PATH_LOG_SCAN budget + answer-early stop present"
  );
});

console.log(`\ncheck-tree-commits: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
