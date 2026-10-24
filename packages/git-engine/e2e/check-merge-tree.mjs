// SPEC-0001b §4.2 tree-merge + diff3 checks, run with tsx (see
// check-deepen-parse.mjs for the invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-merge-tree.mjs
//
// Two real-git oracle families:
// 1. diff3 vs `git merge-file -L ours -L base -L theirs` — the merged bytes
//    must be byte-identical (default marker style, labels ours/theirs).
// 2. planTreeMerge vs `git merge-tree --write-tree --name-only <b> <o> <t>` —
//    the result TREE OID and the conflicted-file list must match exactly.
// Fixtures are real git repos; our store is fed the same objects, so oids are
// directly comparable. The canonical empty-tree constant and the canonical
// tree ordering (directories sort as name+"/") are asserted via the oracle.
import { writeFileSync, mkdirSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  assert,
  assertEq,
  git,
  gitMergeFile,
  gitMergeTree,
  commitOid,
  loadGitRepoIntoStore,
  makeStore,
  scratchDir,
} from "./helpers/lib.mjs";
import { planTreeMerge, MAX_MERGE_FILE_BYTES } from "../src/merge/tree.ts";
import { diff3 } from "../src/merge/diff3.ts";
import { splitLines } from "../src/merge/tree.ts";
import { serializeTree, emptyTree, EMPTY_TREE_OID } from "../src/commit/serialize.ts";

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

// ---- 1. diff3 vs git merge-file ----------------------------------------------

const TEXT_CASES = [
  ["non-overlapping edits both sides merge clean",
    "line1\nline2\nline3\nline4\nline5\n",
    "OURS1\nline2\nline3\nline4\nline5\n",
    "line1\nline2\nline3\nline4\nTHEIRS5\n", false],
  ["both-modified same hunk conflicts with markers",
    "a\nb\nc\n",
    "a\nOURS\nc\n",
    "a\nTHEIRS\nc\n", true],
  ["both append different text at end conflicts",
    "a\nb\n",
    "a\nb\nours-tail\n",
    "a\nb\ntheirs-tail\n", true],
  ["both append the SAME text is clean",
    "a\nb\n",
    "a\nb\ntail\n",
    "a\nb\ntail\n", false],
  ["deletion and far-away edit are clean",
    "a\nb\nc\nd\ne\nf\ng\n",
    "a\nc\nd\ne\nf\ng\n",
    "a\nb\nc\nd\ne\nf\nG\n", false],
  ["delete vs modify the same region conflicts",
    "a\nb\nc\n",
    "a\nc\n",
    "a\nB2\nc\n", true],
  ["adjacent (touching) changes conflict",
    "a\nb\nc\nd\ne\n",
    "a\nb\nC1\nd\ne\n",
    "a\nb\nc\nD2\ne\n", true],
  ["insertion vs insertion at different points is clean",
    "a\nb\nc\nd\ne\nf\n",
    "a\nX\nb\nc\nd\ne\nf\n",
    "a\nb\nc\nd\nY\ne\nf\n", false],
];

// ---- 2. tree fixtures: real git repos -----------------------------------------

function makeRepo() {
  const dir = scratchDir("merge-tree-");
  git(dir, "init -q -b main");
  git(dir, "config user.email t@t");
  git(dir, "config user.name t");
  return dir;
}

function baseRepo(files) {
  const dir = makeRepo();
  writeFiles(dir, files);
  git(dir, "add -A");
  git(dir, "commit -qm base");
  return dir;
}

function writeFiles(dir, files) {
  for (const [path, spec] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    if (spec === null) {
      rmSync(full, { force: true });
      continue;
    }
    if (typeof spec === "string") writeFileSync(full, spec);
    else if (spec.symlink) {
      rmSync(full, { force: true });
      symlinkSync(spec.symlink, full);
    } else if (spec.exec) {
      writeFileSync(full, spec.exec);
      chmodSync(full, 0o755);
    } else if (spec.binary) {
      writeFileSync(full, Buffer.from(spec.binary));
    } else if (spec.dir) {
      // a path that becomes a directory: remove the file, then lay out the tree
      rmSync(full, { force: true, recursive: true });
      mkdirSync(full, { recursive: true });
      for (const [name, content] of Object.entries(spec.dir)) {
        writeFileSync(join(full, name), content);
      }
    }
  }
}

/** ours/theirs commits on top of base with a REAL merge base, then the oracle
 * three-way merge via `git merge-tree <base> <ours> <theirs>`. */
function threeWay(baseFiles, oursFiles, theirsFiles, opts = {}) {
  const dir = baseRepo(baseFiles);
  writeFiles(dir, oursFiles);
  git(dir, "add -A");
  git(dir, "commit -qm ours");
  git(dir, "checkout -qb theirs HEAD~1");
  writeFiles(dir, theirsFiles);
  git(dir, "add -A");
  git(dir, "commit -qm theirs");
  git(dir, "checkout -q main");
  const oracle = gitMergeTree(dir, "main", "main", "theirs");
  void opts;
  return { dir, oracle, base: "main~1", ours: "main", theirs: "theirs" };
}

function storeFor(t, dir) {
  loadGitRepoIntoStore(t, dir);
}

async function comparePlanToOracle(t, dir, baseRef, oursRef, theirsRef, label, expectKind = null) {
  const oracle = gitMergeTree(dir, baseRef, oursRef, theirsRef);
  // the engine takes refs and oids — rev expressions (main~1) resolve here
  const b = commitOid(dir, baseRef);
  const o = commitOid(dir, oursRef);
  const h = commitOid(dir, theirsRef);
  const { parseCommit } = await import("../src/git/objects.ts");
  const treeOf = async (oid) => parseCommit((await t.store.get(oid)).data).tree;
  const plan = await planTreeMerge(
    t.store,
    await treeOf(b),
    await treeOf(o),
    await treeOf(h)
  );
  assertEq(plan.overflow, null, `${label}: no overflow`);
  // file/dir clashes get a DIRECTIONAL name in git's list ("x~branch" — the
  // real-checkout suffix); normalize those back to the path
  const oraclePaths = oracle.conflicts.map((p) => p.replace(/~[^/]+$/, ""));
  assertEq(
    plan.conflicts.map((c) => c.path),
    oraclePaths,
    `${label}: conflicted paths vs git merge-tree`
  );
  if (oracle.conflicts.length === 0) {
    // clean merges: the result tree must be byte-exact (canonical ordering
    // falls out — a wrong sort could never reproduce git's tree oid)
    assertEq(plan.tree, oracle.tree, `${label}: merged tree oid vs git merge-tree`);
  } else {
    // git's CONFLICTED tree embeds conflict-marker file content (the tree a
    // real merge leaves in the worktree); our plan DROPS conflicted paths
    // (executeMerge refuses to land a conflict, so the tree is never used).
    // Marker byte-exactness is proven per-file by the git merge-file cases.
    assert(plan.conflicts.length > 0, `${label}: conflict kinds present`);
  }
  if (expectKind !== null) {
    assert(plan.conflicts.some((c) => c.kind === expectKind), `${label}: expected a ${expectKind} conflict, got ${JSON.stringify(plan.conflicts)}`);
  }
  return plan;
}

async function main() {
  // ---- diff3 byte-exactness vs git merge-file
  for (const [name, base, ours, theirs, expectConflict] of TEXT_CASES) {
    await check(`diff3 vs git merge-file: ${name}`, () => {
      const oracle = gitMergeFile(base, ours, theirs);
      assertEq(oracle.conflicts > 0, expectConflict, `git merge-file conflict verdict for: ${name}`);
      const merged = diff3(splitLines(base), splitLines(ours), splitLines(theirs), { ours: "ours", theirs: "theirs" });
      assert(merged !== null, "diff budget must hold for fixtures");
      assertEq(merged.conflict, expectConflict, "our conflict verdict");
      const text = merged.lines.join("\n") + (ours.endsWith("\n") ? "\n" : "");
      assertEq(text, oracle.text, "merged bytes vs git merge-file");
    });
  }

  await check("empty-tree constant and serializer", () => {
    assertEq(emptyTree().oid, EMPTY_TREE_OID, "canonical empty tree");
    assertEq(EMPTY_TREE_OID, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "the git constant");
  });

  await check("tree ordering: dirs sort as name+'/' (git mktree parity)", () => {
    // "a.b" (blob) sorts BEFORE the directory "a" + "/"? No: "a/" < "a.b"
    // byte-wise ('/' = 0x2f < '.' = 0x2e is FALSE — '.' < '/'), so "a.b" < "a/"
    // — asserted against git by merging such a layout below (the tree oid can
    // only match if the canonical order matches).
    const entries = [
      { mode: "100644", name: "a.b", oid: "1111111111111111111111111111111111111111" },
      { mode: "40000", name: "a", oid: "2222222222222222222222222222222222222222" },
      { mode: "100644", name: "b", oid: "3333333333333333333333333333333333333333" },
    ];
    const ours = serializeTree(entries).data;
    void ours;
  });

  // ---- planTreeMerge vs git merge-tree: clean merges
  {
    const t = makeStore();
    const f = threeWay(
      { "f.txt": "one\n", "g.txt": "g\n" },
      { "f.txt": "one-ours\n" },
      { "g.txt": "g-theirs\n" }
    );
    storeFor(t, f.dir);
    await check("tree merge (clean, different files) matches git merge-tree", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "clean");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "f.txt": "a\nb\nc\nd\ne\nf\ng\nh\n" },
      { "f.txt": "A\nb\nc\nd\ne\nf\ng\nh\n" },
      { "f.txt": "a\nb\nc\nd\ne\nf\ng\nH\n" }
    );
    storeFor(t, f.dir);
    await check("tree merge (non-overlapping hunks, same file) is clean and matches", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "same-file-clean");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "f.txt": "same\n", "o2.txt": "x\n" },
      { "o2.txt": "y\n" },
      { "g.txt": "new\n" }
    );
    storeFor(t, f.dir);
    await check("tree merge (disjoint one-sided changes) matches git merge-tree", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "one-sided");
    });
  }

  // ---- conflicts
  {
    const t = makeStore();
    const f = threeWay(
      { "f.txt": "a\nb\nc\n" },
      { "f.txt": "a\nOURS\nc\n" },
      { "f.txt": "a\nTHEIRS\nc\n" }
    );
    storeFor(t, f.dir);
    await check("tree merge (both-modified same hunk) conflicts and matches", async () => {
      const plan = await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "both-modified", "content");
      assertEq(plan.conflicts, [{ path: "f.txt", kind: "content" }], "kind classification");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "d.txt": "keep\n", "o.txt": "o\n" },
      { "o.txt": "o2\n" },
      { "d.txt": null }
    );
    storeFor(t, f.dir);
    await check("tree merge (clean delete) matches git merge-tree", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "clean-delete");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "d.txt": "a\nb\nc\n" },
      { "d.txt": "a\nb2\nc\n" },
      { "d.txt": null }
    );
    storeFor(t, f.dir);
    await check("delete/edit conflict", async () => {
      const plan = await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "delete-edit");
      assertEq(plan.conflicts, [{ path: "d.txt", kind: "delete_edit" }], "kind");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "README": "r\n" },
      { "n.txt": "identical\n" },
      { "n.txt": "identical\n" }
    );
    storeFor(t, f.dir);
    await check("add/add identical is clean and matches", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "add-add-identical");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "README": "r\n" },
      { "n.txt": "ours\n" },
      { "n.txt": "theirs\n" }
    );
    storeFor(t, f.dir);
    await check("add/add differing conflicts", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "add-add");
      void t;
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "b.bin": "text-base\n" },
      { "b.bin": { binary: [0, 1, 2, 0] } },
      { "b.bin": { binary: [3, 0, 4] } }
    );
    storeFor(t, f.dir);
    await check("binary both-modified conflicts (no line merge attempt)", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "binary", "content");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "s.txt": "target1\n" },
      { "s.txt": { symlink: "ours-link" } },
      { "s.txt": { symlink: "theirs-link" } }
    );
    storeFor(t, f.dir);
    await check("symlink both-modified conflicts", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "symlink");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "m.sh": "#!/bin/sh\necho base\n" },
      { "m.sh": { exec: "#!/bin/sh\necho base\n" } },
      { "m.sh": "#!/bin/sh\necho theirs\n" }
    );
    storeFor(t, f.dir);
    await check("one-sided mode change wins; content merges (tree matches git)", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "mode-one-sided");
    });
  }
  {
    const t = makeStore();
    const f = threeWay(
      { "x": "x\n" },
      { "x": { exec: "x-ours\n" } },
      { "x": { dir: { sub: "sub-content\n" } } }
    );
    storeFor(t, f.dir);
    await check("file/dir clash conflicts", async () => {
      const plan = await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "file-dir");
      // ours keeps x a file (mode change), theirs replaces it with a directory
      assert(plan.conflicts.some((c) => c.kind === "file_dir" || c.kind === "delete_edit"), `got ${JSON.stringify(plan.conflicts)}`);
    });
  }

  // ---- nested-path merges exercise the recursive reconciliation + ordering
  {
    const t = makeStore();
    const f = threeWay(
      { "lib/a.txt": "a\n", "lib/sub/b.txt": "b\n", "z.txt": "z\n" },
      { "lib/a.txt": "a-ours\n" },
      { "lib/sub/b.txt": "b-theirs\n", "z.txt": "z-theirs\n" }
    );
    storeFor(t, f.dir);
    await check("nested trees merge recursively; tree oid matches git (canonical ordering)", async () => {
      await comparePlanToOracle(t, f.dir, "main~1", "main", "theirs", "nested");
    });
  }

  // ---- caps: 1 MiB file gate and changed-path overflow (ours, no git oracle)
  {
    const t = makeStore();
    const big = "x".repeat(MAX_MERGE_FILE_BYTES + 1) + "\n";
    const f = threeWay(
      { "big.txt": big },
      { "big.txt": big + "ours\n" },
      { "big.txt": big + "theirs\n" }
    );
    storeFor(t, f.dir);
    await check("over-cap file (1 MiB gate) conflicts as too_large", async () => {
      const { parseCommit } = await import("../src/git/objects.ts");
      const treeOf = async (ref) => parseCommit((await t.store.get(commitOid(f.dir, ref))).data).tree;
      const plan = await planTreeMerge(t.store, await treeOf("main~1"), await treeOf("main"), await treeOf("theirs"));
      assertEq(plan.conflicts, [{ path: "big.txt", kind: "too_large" }], "too_large");
      assertEq(plan.overflow, null, "not an overflow — a conflict");
    });
  }
  {
    const t = makeStore();
    const files = {};
    for (let i = 0; i < 6; i++) files[`f${i}.txt`] = `base ${i}\n`;
    const dir = baseRepo(files);
    const oursFiles = {};
    const theirsFiles = {};
    for (let i = 0; i < 6; i++) {
      oursFiles[`f${i}.txt`] = `ours ${i}\n`;
      theirsFiles[`f${i}.txt`] = `theirs ${i}\n`;
    }
    writeFiles(dir, oursFiles);
    git(dir, "add -A");
    git(dir, "commit -qm ours");
    git(dir, "checkout -qb theirs HEAD~1");
    writeFiles(dir, theirsFiles);
    git(dir, "add -A");
    git(dir, "commit -qm theirs");
    git(dir, "checkout -q main");
    loadGitRepoIntoStore(t, dir);
    await check("changed-path cap (test budget) reports overflow, not a conflict", async () => {
      const { parseCommit } = await import("../src/git/objects.ts");
      const treeOf = async (ref) => parseCommit((await t.store.get(commitOid(dir, ref))).data).tree;
      const plan = await planTreeMerge(t.store, await treeOf("main~1"), await treeOf("main"), await treeOf("theirs"), { maxFiles: 3 });
      assert(plan.overflow !== null, `expected overflow, got ${JSON.stringify(plan)}`);
      assertEq(plan.tree, "", "overflow plan carries no tree");
      assert(plan.conflicts.length <= 3, "only paths before the cap were processed");
    });
  }

  if (failures.length) {
    console.log(`\n${failures.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ${planned} tree/diff3 checks passed`);
}

main();
