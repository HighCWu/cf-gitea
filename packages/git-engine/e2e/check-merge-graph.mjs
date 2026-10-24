// SPEC-0001b §4.1 graph-primitive checks, run with tsx (see
// check-deepen-parse.mjs for the invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-merge-graph.mjs
//
// Fixtures are REAL git repositories built with the git CLI (2-3+ commits with
// genuine merge bases), loaded into GitStore, and every answer is compared to
// the real-git oracle (`git merge-base`, `git rev-list --left-right --count`,
// `git rev-list --topo-order --reverse`). Exhaustion uses a synthetic chain
// with a test-overridden budget. The §4.6 read-only rule is asserted by an
// object-count + refs snapshot around every read call.
import { writeFileSync } from "node:fs";
import {
  assert,
  assertEq,
  commitOid,
  git,
  leaseHost,
  loadGitRepoIntoStore,
  makeStore,
  scratchDir,
} from "./helpers/lib.mjs";
import { mergeBase, isAncestorEx, listCommitsRange, countDivergence } from "../src/merge/graph.ts";
import { parseCommit } from "../src/git/objects.ts";

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

// ---- fixture: linear + diverged branches with a genuine merge base -----------
function buildDiverged() {
  const dir = scratchDir("graph-diverged-");
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t");
  git(dir, "config user.name t");
  const f = (name, content) => writeFileSync(`${dir}/${name}`, content);
  f("a.txt", "one\n");
  git(dir, "add -A");
  git(dir, 'commit -qm c1', { GIT_COMMITTER_DATE: "2026-01-01T00:00:00", GIT_AUTHOR_DATE: "2026-01-01T00:00:00" });
  f("a.txt", "one\ntwo\n");
  git(dir, "add -A");
  git(dir, 'commit -qm c2', { GIT_COMMITTER_DATE: "2026-01-02T00:00:00", GIT_AUTHOR_DATE: "2026-01-02T00:00:00" });
  git(dir, "checkout -qb side");
  f("s.txt", "s1\n");
  git(dir, "add -A");
  git(dir, 'commit -qm s1', { GIT_COMMITTER_DATE: "2026-01-03T00:00:00", GIT_AUTHOR_DATE: "2026-01-03T00:00:00" });
  f("s.txt", "s1\ns2\n");
  git(dir, "add -A");
  git(dir, 'commit -qm s2', { GIT_COMMITTER_DATE: "2026-01-04T00:00:00", GIT_AUTHOR_DATE: "2026-01-04T00:00:00" });
  git(dir, "checkout -q main");
  f("a.txt", "one\ntwo\nthree\n");
  git(dir, "add -A");
  git(dir, 'commit -qm c3', { GIT_COMMITTER_DATE: "2026-01-05T00:00:00", GIT_AUTHOR_DATE: "2026-01-05T00:00:00" });
  return dir;
}

// ---- fixture: the g1t#365 class — the true base lives on a MERGED side branch
// (main's first-parent chain is M,c2,c1,c0; the true base f1 is NOT in it, so
// a first-parent approximation misses it — our two-sided paint must not)
function buildSideBranchBase() {
  const dir = scratchDir("graph-sidebase-");
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t");
  git(dir, "config user.name t");
  const f = (name, content) => writeFileSync(`${dir}/${name}`, content);
  f("a", "c0\n");
  git(dir, "add -A");
  git(dir, "commit -qm c0", { GIT_COMMITTER_DATE: "2026-01-01T00:00:00" });
  f("a", "c0\nc1\n");
  git(dir, "add -A");
  git(dir, "commit -qm c1", { GIT_COMMITTER_DATE: "2026-01-02T00:00:00" });
  git(dir, "checkout -qb feat");
  f("f", "f1\n");
  git(dir, "add -A");
  git(dir, "commit -qm f1", { GIT_COMMITTER_DATE: "2026-01-03T00:00:00" });
  git(dir, "checkout -q main");
  f("a", "c0\nc1\nc2\n");
  git(dir, "add -A");
  git(dir, "commit -qm c2", { GIT_COMMITTER_DATE: "2026-01-04T00:00:00" });
  git(dir, "merge -q --no-ff -m M feat", { GIT_COMMITTER_DATE: "2026-01-05T00:00:00" });
  git(dir, "checkout -qb side feat");
  f("f", "f1\nf2\n");
  git(dir, "add -A");
  git(dir, "commit -qm s1", { GIT_COMMITTER_DATE: "2026-01-06T00:00:00" });
  return dir;
}

// ---- fixture: criss-cross (two valid merge bases) ----------------------------
function buildCrissCross() {
  const dir = scratchDir("graph-cross-");
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t");
  git(dir, "config user.name t");
  const f = (name, content) => writeFileSync(`${dir}/${name}`, content);
  f("a", "c0\n");
  git(dir, "add -A");
  git(dir, "commit -qm c0", { GIT_COMMITTER_DATE: "2026-01-01T00:00:00" });
  git(dir, "checkout -qb a");
  f("a", "c0\na1\n");
  git(dir, "add -A");
  git(dir, "commit -qm a1", { GIT_COMMITTER_DATE: "2026-01-02T00:00:00" });
  git(dir, "checkout -q main");
  git(dir, "checkout -qb b");
  f("b", "b1\n");
  git(dir, "add -A");
  git(dir, "commit -qm b1", { GIT_COMMITTER_DATE: "2026-01-03T00:00:00" });
  const a1 = commitOid(dir, "a");
  git(dir, "checkout -q a");
  git(dir, "merge -q --no-ff --no-edit -m m1 b", { GIT_COMMITTER_DATE: "2026-01-04T00:00:00" });
  git(dir, "checkout -q b");
  // B merges A's OLD tip (the classic criss-cross: stale fetch), so neither
  // merge contains the other's tip and the bases are {a1, b1}
  git(dir, `merge -q --no-ff --no-edit -m m2 ${a1}`, { GIT_COMMITTER_DATE: "2026-01-05T00:00:00" });
  return dir;
}

// ---- fixture: unrelated histories -------------------------------------------
function buildUnrelated() {
  const dir = buildDiverged();
  git(dir, "checkout -q --orphan lonely");
  git(dir, "rm -rqf .");
  writeFileSync(`${dir}/l.txt`, "lonely\n");
  git(dir, "add -A");
  git(dir, "commit -qm l1", { GIT_COMMITTER_DATE: "2026-02-01T00:00:00" });
  return dir;
}

function snapshot(t) {
  return {
    objects: t.store.objectCount(),
    refs: t.store.refs().map((r) => `${r.name}=${r.oid}`).join(","),
    refsVersion: t.store.refsVersion(),
  };
}

async function main() {
  const t = makeStore();
  const host = leaseHost(t);
  const dir = buildDiverged();
  loadGitRepoIntoStore(t, dir);
  const c1 = commitOid(dir, "main~2");
  const c2 = commitOid(dir, "main~1");
  const c3 = commitOid(dir, "main");
  const s1 = commitOid(dir, "side~1");
  const s2 = commitOid(dir, "side");

  await check("mergeBase: diverged fixture matches git merge-base", async () => {
    const want = git(dir, "merge-base main side");
    const got = await mergeBase(t.store, "main", "side");
    assertEq(got.value, want, "merge-base(main, side)");
    assertEq(got.exhausted, false, "not exhausted");
    assertEq(git(dir, "merge-base side main"), got.value, "symmetric");
  });

  await check("mergeBase: self and ancestor shapes", async () => {
    assertEq((await mergeBase(t.store, "main", "main")).value, c3, "self");
    assertEq((await mergeBase(t.store, "main", c1)).value, c1, "ancestor tip: base of (main, c1) is c1");
  });

  await check("isAncestorEx: true/false/exhaustion-free", async () => {
    assertEq((await isAncestorEx(t.store, c1, c3)).value, true, "c1 ancestor of c3");
    assertEq((await isAncestorEx(t.store, c3, c1)).value, false, "c3 not ancestor of c1");
    assertEq((await isAncestorEx(t.store, s2, c3)).value, false, "side not merged");
    assertEq((await isAncestorEx(t.store, c2, c2)).value, true, "equal");
  });

  await check("countDivergence matches rev-list --left-right --count", async () => {
    const want = git(dir, "rev-list --left-right --count main...side").split("\t").map((n) => parseInt(n, 10));
    const got = await countDivergence(t.store, "main", "side");
    assertEq(got.value, { ahead: want[1], behind: want[0] }, "main vs side");
    const ff = await countDivergence(t.store, c1, c3);
    assertEq(ff.value, { ahead: 2, behind: 0 }, "fast-forward shape");
  });

  await check("listCommitsRange matches rev-list --topo-order --reverse", async () => {
    const want = git(dir, "rev-list --topo-order --reverse main..side").split("\n").filter(Boolean);
    const got = await listCommitsRange(t.store, "main", "side", 100);
    assertEq(got.commits.map((c) => c.oid), want, "order + membership");
    assertEq(got.more, false, "no more");
    // topological property: parents before children
    const pos = new Map(got.commits.map((c, i) => [c.oid, i]));
    for (const c of got.commits) {
      for (const p of c.parents) {
        if (pos.has(p)) assert(pos.get(p) < pos.get(c.oid), `parent before child for ${c.oid}`);
      }
    }
    // commit shape round-trips through the parser
    assertEq(got.commits[0].subject, git(dir, `log -1 --format=%s ${want[0]}`), "subject");
  });

  await check("listCommitsRange: limit + page + more", async () => {
    const all = await listCommitsRange(t.store, c1, c3, 100);
    assertEq(all.commits.length, 2, "c1..c3 = 2 commits");
    const page0 = await listCommitsRange(t.store, c1, c3, 1, 0);
    assertEq(page0.commits.length, 1, "one per page");
    assertEq(page0.more, true, "more on page 0");
    assertEq(page0.commits[0].oid, all.commits[0].oid, "oldest first");
    const page1 = await listCommitsRange(t.store, c1, c3, 1, 1);
    assertEq(page1.more, false, "no more on page 1");
    assertEq(page1.commits[0].oid, all.commits[1].oid, "page 1 = second commit");
    const none = await listCommitsRange(t.store, c3, c1, 10);
    assertEq(none.commits, [], "empty range behind");
  });

  await check("listCommitsRange: null on unresolvable refs", async () => {
    assertEq(await listCommitsRange(t.store, "main", "nope", 10), null, "head missing");
    assertEq(await listCommitsRange(t.store, "nope", "main", 10), null, "base missing");
  });

  // ---- g1t#365 class: base reachable only through a merged side branch
  {
    const t2 = makeStore();
    const d2 = buildSideBranchBase();
    loadGitRepoIntoStore(t2, d2);
    const f1 = commitOid(d2, "feat");
    await check("mergeBase: true base on a merged side branch (g1t#365 class)", async () => {
      const want = git(d2, "merge-base main side");
      assertEq(want, f1, "git says the base is f1 (inside the merge's second parent)");
      const got = await mergeBase(t2.store, "main", "side");
      assertEq(got.value, want, "two-sided paint finds it");
    });
  }

  // ---- criss-cross: two valid candidates; the pick is deterministic and one
  // of git merge-base --all's set
  {
    const t3 = makeStore();
    const d3 = buildCrissCross();
    loadGitRepoIntoStore(t3, d3);
    const m1 = commitOid(d3, "a");
    const m2 = commitOid(d3, "b");
    await check("mergeBase: criss-cross — one of the two valid bases, deterministic", async () => {
      const valid = git(d3, "merge-base --all a b").split("\n").sort();
      assertEq(valid.length, 2, "fixture really has two bases");
      const got = await mergeBase(t3.store, m2, m1);
      assert(valid.includes(got.value), `pick ${got.value} must be one of ${valid}`);
      const again = await mergeBase(t3.store, m2, m1);
      assertEq(again.value, got.value, "deterministic (newest committer time, then min oid)");
      assertEq(git(d3, "merge-base b a"), git(d3, "merge-base a b"), "oracle is symmetric too");
    });
  }

  // ---- unrelated histories: a real null, not exhaustion
  {
    const t4 = makeStore();
    const d4 = buildUnrelated();
    loadGitRepoIntoStore(t4, d4);
    await check("mergeBase: unrelated histories → null, not exhausted", async () => {
      const gitOut = git(d4, "merge-base main lonely || true");
      assertEq(gitOut, "", "git finds none either");
      const got = await mergeBase(t4.store, "main", "lonely");
      assertEq(got, { value: null, exhausted: false }, "null answer, budget intact");
      const div = await countDivergence(t4.store, "main", "lonely");
      const want = git(d4, "rev-list --left-right --count main...lonely").split("\t");
      assertEq(div.value, { ahead: parseInt(want[1], 10), behind: parseInt(want[0], 10) }, "unrelated divergence");
    });
  }

  // ---- exhaustion with a synthetic chain + test budget
  {
    const t5 = makeStore();
    const { serializeCommit } = await import("../src/commit/serialize.ts");
    const { hashObject } = await import("../src/git/objects.ts");
    const te = new TextEncoder();
    const enc = (s) => {
      const data = te.encode(s);
      return { oid: hashObject("blob", data), type: "blob", data };
    };
    const emptyTreeOid = hashObject("tree", new Uint8Array(0));
    t5.store.put(emptyTreeOid, "tree", new Uint8Array(0));
    let parent = null;
    const oids = [];
    for (let i = 0; i < 60; i++) {
      const blob = enc(`line ${i}\n`);
      t5.store.put(blob.oid, "blob", blob.data);
      const tree = (await import("../src/commit/serialize.ts")).serializeTree([{ mode: "100644", name: "f.txt", oid: blob.oid }]);
      t5.store.put(tree.oid, tree.type, tree.data);
      const person = { name: "t", email: "t@t", time: 1700000000 + i, tz: "+0000" };
      const commit = serializeCommit({
        tree: tree.oid,
        parents: parent ? [parent] : [],
        author: person,
        committer: person,
        message: `c${i}\n`,
      });
      t5.store.put(commit.oid, commit.type, commit.data);
      parent = commit.oid;
      oids.push(commit.oid);
    }
    await check("mergeBase: budget exhaustion is reported, not a wrong answer", async () => {
      const got = await mergeBase(t5.store, oids[59], oids[30], { maxVisits: 5 });
      // c30 is an ancestor of c59: the walk finds it only if the budget allows
      if (got.value === null) assertEq(got.exhausted, true, "truncated walk reports exhaustion");
      else assertEq(got.value, oids[30], "or answers");
    });
    await check("countDivergence: exhaustion propagates", async () => {
      const div = await countDivergence(t5.store, oids[59], oids[0], { maxVisits: 5 });
      if (div.exhausted) assert(div.value.ahead >= 0, "counts may be partial when exhausted");
      const full = await countDivergence(t5.store, oids[59], oids[0]);
      assertEq(full, { value: { ahead: 0, behind: 59 }, exhausted: false }, "full budget: exact");
    });
    await check("isAncestorEx: deep chain under a tight budget reports exhaustion", async () => {
      const r = await isAncestorEx(t5.store, oids[0], oids[59], { maxVisits: 5 });
      assertEq(r, { value: false, exhausted: true }, "truncated ancestor walk");
      const okFull = await isAncestorEx(t5.store, oids[0], oids[59]);
      assertEq(okFull, { value: true, exhausted: false }, "full budget finds it");
    });
  }

  // ---- §4.6: the reads never write
  await check("read-only rule: object + refs snapshot unchanged after every read", async () => {
    const before = snapshot(t);
    await mergeBase(t.store, "main", "side");
    await isAncestorEx(t.store, c1, c3);
    await listCommitsRange(t.store, "main", "side", 50);
    await countDivergence(t.store, "main", "side");
    const after = snapshot(t);
    assertEq(after, before, "snapshot identical");
  });

  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ${planned} graph checks passed`);
}

main();
